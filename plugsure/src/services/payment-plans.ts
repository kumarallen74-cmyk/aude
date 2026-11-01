import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { moneyText, currencyOr } from '../domain/money.js';
import { unseal } from './secrets.js';
import { sendEmail } from './notify-transports.js';
import { markPaid, FleetBillingError } from './fleet-billing.js';
import { persistAlert } from './alerts.js';
import { list as collectionsList, bucketOf } from './collections.js';
import { xlsx } from './xlsx.js';

/**
 * Payment plans and the bad-debt provision (v1.28.0).
 *
 *   payment plan  for an issued fleet invoice that is due or overdue: what is left split into 2–24 instalments
 *                 (monthly, or every N days, from a first date), agreed with the customer. Each instalment is recorded
 *                 as paid (amount, date, reference); when all are paid, the invoice is marked paid. A reminder is
 *                 e-mailed 3 days before each instalment (once). An instalment unpaid past the grace days defaults the
 *                 plan (finance.payment_plan_defaulted); the invoice returns to Collections. One active plan per invoice.
 *   provision     at month end, receivables (Collections: fleet invoices, and PlugSure's statements for platform
 *                 administrators) by age bucket × a rate per bucket (default current 1%, 1–30 days 5%, 31–60 15%,
 *                 61–90 30%, over 90 60%); an invoice on a plan in good standing counts as current. Recording the
 *                 month keeps the provision, the previous one and the movement (the journal: Dr bad-debt expense,
 *                 Cr allowance for doubtful accounts; a release the other way).
 */

export class PlanError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const DEFAULT_RATES: Record<string, number> = { current: 1, '1-30': 5, '31-60': 15, '61-90': 30, '90+': 60 };
export const DEFAULTED_ALERT = 'finance.payment_plan_defaulted';
const BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zone = () => config.billing.timeZone;
const localDay = (t: Date | number = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(new Date(t));
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const addMonths = (d: string, n: number) => {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
};
const ymd = (d: Date | string | null) => (d ? (typeof d === 'string' ? d.slice(0, 10) : new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)) : null);

// ─────────────────────────────────────────── plans

async function invoiceOf(orgId: string, invoiceId: string) {
  if (!UUID_RE.test(invoiceId)) throw new PlanError(404, 'No such invoice.');
  const i = await outsideRequestScope(() => one<any>(
    `SELECT i.*, a.name AS account, a.billing_email FROM fleet_invoice i JOIN fleet_account a ON a.id = i.fleet_account_id WHERE i.id = $1 AND i.org_id = $2`, [invoiceId, orgId]));
  if (!i) throw new PlanError(404, 'No such invoice.');
  return { ...i, balance: Math.max(0, Number(i.total_minor) - Number(i.credited_minor ?? 0) - Number(i.prior_credit_minor ?? 0)) };
}

const planView = (p: any, inst: any[]) => {
  const paid = inst.reduce((a, x) => a + Number(x.paid_minor), 0);
  const today = localDay();
  return {
    id: String(p.id), invoiceId: p.invoice_id, number: p.number ?? null, account: p.account ?? null, currency: p.currency, total: Number(p.total_minor), paid, outstanding: Math.max(0, Number(p.total_minor) - paid),
    status: p.status, graceDays: p.grace_days, note: p.note ?? null, createdAt: new Date(p.created_at).toISOString(), endedAt: p.ended_at ? new Date(p.ended_at).toISOString() : null, endReason: p.end_reason ?? null,
    instalments: inst.map((x) => ({
      id: String(x.id), seq: x.seq, due: ymd(x.due_date), amount: Number(x.amount_minor), paid: Number(x.paid_minor), paidOn: ymd(x.paid_on), reference: x.reference ?? null,
      status: Number(x.paid_minor) >= Number(x.amount_minor) ? 'paid' : ymd(x.due_date)! < today ? 'late' : 'due',
    })),
  };
};

export async function list(orgId: string, f: { status?: unknown } = {}) {
  const st = typeof f.status === 'string' && ['active', 'completed', 'defaulted', 'cancelled'].includes(f.status) ? f.status : null;
  const plans = await outsideRequestScope(() => many<any>(
    `SELECT p.*, i.number, a.name AS account FROM payment_plan p JOIN fleet_invoice i ON i.id = p.invoice_id JOIN fleet_account a ON a.id = i.fleet_account_id
      WHERE p.org_id = $1 AND ($2::text IS NULL OR p.status = $2) ORDER BY (p.status = 'active') DESC, p.created_at DESC LIMIT 200`, [orgId, st]));
  const inst = plans.length ? await outsideRequestScope(() => many<any>(`SELECT * FROM payment_plan_instalment WHERE plan_id = ANY($1::bigint[]) ORDER BY plan_id, seq`, [plans.map((p) => p.id)])) : [];
  return plans.map((p) => planView(p, inst.filter((x) => String(x.plan_id) === String(p.id))));
}

export async function get(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new PlanError(404, 'No such plan.');
  const p = await outsideRequestScope(() => one<any>(
    `SELECT p.*, i.number, a.name AS account, a.billing_email FROM payment_plan p JOIN fleet_invoice i ON i.id = p.invoice_id JOIN fleet_account a ON a.id = i.fleet_account_id WHERE p.id = $1 AND p.org_id = $2`, [id, orgId]));
  if (!p) throw new PlanError(404, 'No such plan.');
  const inst = await outsideRequestScope(() => many<any>(`SELECT * FROM payment_plan_instalment WHERE plan_id = $1 ORDER BY seq`, [id]));
  return planView(p, inst);
}

/** Agree a plan: count (2–24) instalments of the invoice's balance, from a first date, monthly or every N days. */
export async function create(orgId: string, invoiceId: string, b: Record<string, unknown>, userId: string | null) {
  const inv = await invoiceOf(orgId, invoiceId);
  if (inv.status !== 'issued') throw new PlanError(409, `The invoice is ${inv.status}.`);
  if (inv.balance <= 0) throw new PlanError(409, 'Nothing is left to pay on this invoice.');
  const count = Number(b.count);
  if (!Number.isInteger(count) || count < 2 || count > 24) throw new PlanError(422, 'A plan has 2 to 24 instalments.');
  const first = String(b.firstDue ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(first) || Number.isNaN(Date.parse(`${first}T00:00:00Z`))) throw new PlanError(422, 'firstDue is YYYY-MM-DD.');
  if (first < localDay()) throw new PlanError(422, 'The first instalment is due today or later.');
  const every = b.everyDays == null || b.everyDays === '' ? null : Number(b.everyDays);
  if (every !== null && (!Number.isInteger(every) || every < 7 || every > 92)) throw new PlanError(422, 'Instalments come every 7 to 92 days, or monthly.');
  const grace = b.graceDays == null || b.graceDays === '' ? 7 : Number(b.graceDays);
  if (!Number.isInteger(grace) || grace < 0 || grace > 60) throw new PlanError(422, 'Grace is 0 to 60 days.');
  const each = Math.floor(inv.balance / count), rest = inv.balance - each * count;
  if (each <= 0) throw new PlanError(422, 'The balance is too small for that many instalments.');
  const note = b.note == null ? null : String(b.note).trim().slice(0, 500) || null;
  try {
    const p = await outsideRequestScope(() => one<{ id: string }>(
      `INSERT INTO payment_plan (org_id, invoice_id, currency, total_minor, grace_days, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [orgId, invoiceId, inv.currency, inv.balance, grace, note, userId]));
    for (let k = 0; k < count; k++) {
      const due = every ? addDays(first, every * k) : addMonths(first, k);
      // The last instalment takes the rounding.
      await outsideRequestScope(() => query(`INSERT INTO payment_plan_instalment (org_id, plan_id, seq, due_date, amount_minor) VALUES ($1, $2, $3, $4, $5)`,
        [orgId, p!.id, k + 1, due, each + (k === count - 1 ? rest : 0)]));
    }
    return get(orgId, String(p!.id));
  } catch (e) {
    if ((e as any).code === '23505') throw new PlanError(409, 'This invoice already has an active plan.');
    throw e;
  }
}

/** Record a payment on the plan: it pays the earliest unpaid instalments first; all paid → the invoice is paid. */
export async function pay(orgId: string, planId: string, b: Record<string, unknown>) {
  const p = await get(orgId, planId);
  if (p.status !== 'active') throw new PlanError(409, `The plan is ${p.status}.`);
  let amount = Number(b.amount);
  if (!Number.isInteger(amount) || amount <= 0) throw new PlanError(422, 'The amount is a whole number above zero (minor units).');
  if (amount > p.outstanding) throw new PlanError(422, `That is more than is left on the plan (${p.outstanding}).`);
  const paidOn = String(b.paidOn ?? localDay());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) throw new PlanError(422, 'paidOn is YYYY-MM-DD.');
  const reference = String(b.reference ?? '').trim();
  if (!reference || reference.length > 120) throw new PlanError(422, 'The bank reference of the transfer is required.');
  for (const x of p.instalments) {
    if (amount <= 0) break;
    const left = x.amount - x.paid;
    if (left <= 0) continue;
    const take = Math.min(left, amount);
    amount -= take;
    await outsideRequestScope(() => query(`UPDATE payment_plan_instalment SET paid_minor = paid_minor + $2, paid_on = $3, reference = $4 WHERE id = $1`, [x.id, take, paidOn, reference.slice(0, 120)]));
  }
  const after = await get(orgId, planId);
  if (after.outstanding === 0) {
    try {
      await outsideRequestScope(() => markPaid(orgId, after.invoiceId, { paidAt: paidOn, reference: `Payment plan ${after.id}: ${reference}`.slice(0, 200) }));
    } catch (e) {
      if (!(e instanceof FleetBillingError)) throw e;
      logger.warn({ plan: after.id, err: e.message }, 'plan completed; invoice not marked paid');
    }
    await outsideRequestScope(() => query(`UPDATE payment_plan SET status = 'completed', ended_at = now(), end_reason = 'paid' WHERE id = $1 AND status = 'active'`, [planId]));
    return get(orgId, planId);
  }
  return after;
}

export async function cancel(orgId: string, planId: string, reasonRaw: unknown) {
  const reason = String(reasonRaw ?? '').trim();
  if (!reason) throw new PlanError(422, 'Say why the plan is cancelled.');
  const p = await get(orgId, planId);
  if (p.status !== 'active') throw new PlanError(409, `The plan is ${p.status}.`);
  await outsideRequestScope(() => query(`UPDATE payment_plan SET status = 'cancelled', ended_at = now(), end_reason = $2 WHERE id = $1`, [planId, reason.slice(0, 300)]));
  return get(orgId, planId);
}

/** The daily worker: reminders 3 days ahead (once per instalment), and defaults past the grace days. */
export async function sweep(now = new Date()): Promise<{ reminded: number; defaulted: number }> {
  const today = localDay(now);
  let reminded = 0, defaulted = 0;
  const late = await outsideRequestScope(() => many<any>(
    `SELECT DISTINCT p.id, p.org_id, i.number, a.name FROM payment_plan p JOIN payment_plan_instalment x ON x.plan_id = p.id JOIN fleet_invoice i ON i.id = p.invoice_id JOIN fleet_account a ON a.id = i.fleet_account_id
      WHERE p.status = 'active' AND x.paid_minor < x.amount_minor AND x.due_date + p.grace_days < $1::date`, [today]));
  for (const p of late) {
    const r = await outsideRequestScope(() => one(`UPDATE payment_plan SET status = 'defaulted', ended_at = now(), end_reason = 'an instalment unpaid past the grace days' WHERE id = $1 AND status = 'active' RETURNING id`, [p.id]));
    if (!r) continue;
    defaulted++;
    await persistAlert({ orgId: p.org_id, kind: DEFAULTED_ALERT, severity: 'warning', targetType: 'payment_plan', targetId: String(p.id),
      message: `${p.name}'s payment plan for ${p.number} defaulted: an instalment is unpaid past the grace days. The invoice is back in Collections.` }).catch(() => undefined);
  }
  const soon = await outsideRequestScope(() => many<any>(
    `SELECT x.id, x.due_date, x.amount_minor, x.paid_minor, p.org_id, p.currency, i.number, a.name, a.billing_email FROM payment_plan_instalment x JOIN payment_plan p ON p.id = x.plan_id
       JOIN fleet_invoice i ON i.id = p.invoice_id JOIN fleet_account a ON a.id = i.fleet_account_id
      WHERE p.status = 'active' AND x.paid_minor < x.amount_minor AND x.reminded_at IS NULL AND x.due_date BETWEEN $1::date AND ($1::date + 3) AND a.billing_email IS NOT NULL`, [today]));
  for (const x of soon) {
    try {
      const ch = await outsideRequestScope(() => one<{ enabled: boolean; config: any; secret: string | null }>(`SELECT enabled, config, secret FROM notification_channel WHERE org_id = $1 AND kind = 'email'`, [x.org_id]));
      if (!ch?.enabled || !ch.config?.host) continue;
      let secret: string | null = null;
      try { secret = ch.secret ? unseal(ch.secret) : null; } catch { secret = null; }
      const left = moneyText(Number(x.amount_minor) - Number(x.paid_minor), currencyOr(x.currency));
      const org = await outsideRequestScope(() => one<{ name: string }>(`SELECT name FROM organisation WHERE id = $1`, [x.org_id]));
      const text = `Dear ${x.name},\n\nA reminder that the next instalment of your payment plan for invoice ${x.number} is due on ${ymd(x.due_date)}: ${left}.\n\nIf you have already paid, thank you, and please reply with the transfer's reference.\n\n${org?.name ?? ''}`;
      const res = await sendEmail(ch.config, secret, String(x.billing_email).split(/[,;]\s*/)[0]!, { subject: `Instalment due ${ymd(x.due_date)}: invoice ${x.number} — ${left}`, text, html: text.split('\n\n').map((p: string) => `<p>${p.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</p>`).join(''), kind: 'payment-plan' });
      if (res.ok) { await outsideRequestScope(() => query(`UPDATE payment_plan_instalment SET reminded_at = now() WHERE id = $1`, [x.id])); reminded++; }
    } catch (e) {
      logger.warn({ instalment: x.id, err: (e as Error).message }, 'instalment reminder failed');
    }
  }
  return { reminded, defaulted };
}

// ─────────────────────────────────────────── the provision

export async function rates(orgId: string): Promise<Record<string, number>> {
  const r = await outsideRequestScope(() => one<{ provision_rates: any }>(`SELECT provision_rates FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  return { ...DEFAULT_RATES, ...(r?.provision_rates ?? {}) };
}

export async function saveRates(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const cur = await rates(orgId);
  for (const k of BUCKETS) {
    if (b[k] === undefined) continue;
    const v = Number(b[k]);
    if (!Number.isFinite(v) || v < 0 || v > 100) throw new PlanError(422, `${k}: a rate is 0 to 100 (%).`);
    cur[k] = v;
  }
  for (let i = 1; i < BUCKETS.length; i++) if (cur[BUCKETS[i]!]! < cur[BUCKETS[i - 1]!]!) throw new PlanError(422, 'Older receivables take a rate at least as high as younger ones.');
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, provision_rates, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET provision_rates = EXCLUDED.provision_rates, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify(cur), userId]));
  return cur;
}

/** The provision now, per currency and bucket; with the last recorded one. */
export async function provision(orgId: string, platformAdmin: boolean, now = new Date()) {
  const rt = await rates(orgId);
  const l = await collectionsList(orgId, platformAdmin, now);
  const onPlan = new Set((await outsideRequestScope(() => many<{ invoice_id: string }>(`SELECT invoice_id FROM payment_plan WHERE org_id = $1 AND status = 'active'`, [orgId]))).map((r) => r.invoice_id));
  const per: Record<string, Record<string, { amount: number; count: number }>> = {};
  for (const r of l.receivables as any[]) {
    if (r.writeOff?.state === 'approved') continue;
    const bucket = r.kind === 'fleet_invoice' && onPlan.has(r.ref) ? 'current' : bucketOf(r.daysPastDue);
    const c = (per[r.currency] ??= Object.fromEntries(BUCKETS.map((b) => [b, { amount: 0, count: 0 }])));
    c[bucket]!.amount += r.outstanding; c[bucket]!.count++;
  }
  const last = await outsideRequestScope(() => many<any>(
    `SELECT DISTINCT ON (currency) currency, month, provision_minor FROM bad_debt_provision WHERE org_id = $1 ORDER BY currency, month DESC`, [orgId]));
  const currencies = Object.entries(per).sort(([a], [b]) => a.localeCompare(b)).map(([cur, bs]) => {
    const buckets = BUCKETS.map((b) => ({ bucket: b, amount: bs[b]!.amount, count: bs[b]!.count, ratePct: rt[b]!, provision: Math.round(bs[b]!.amount * rt[b]! / 100) }));
    const total = buckets.reduce((a, x) => a + x.provision, 0);
    const prev = last.find((x) => x.currency === cur);
    return { currency: cur, receivables: buckets.reduce((a, x) => a + x.amount, 0), buckets, provision: total, last: prev ? { month: prev.month, provision: Number(prev.provision_minor) } : null, movement: total - Number(prev?.provision_minor ?? 0) };
  });
  return { asOf: localDay(now), rates: rt, currencies, onPlan: onPlan.size };
}

/** Record a month's provision (each currency), keeping the previous and the movement. Once per month (re-record replaces). */
export async function record(orgId: string, platformAdmin: boolean, monthRaw: unknown, userId: string | null) {
  const month = String(monthRaw ?? '');
  if (!MONTH_RE.test(month)) throw new PlanError(422, 'month is YYYY-MM.');
  const p = await provision(orgId, platformAdmin);
  const out = [];
  for (const c of p.currencies) {
    const prev = await outsideRequestScope(() => one<{ provision_minor: string }>(`SELECT provision_minor FROM bad_debt_provision WHERE org_id = $1 AND currency = $2 AND month < $3 ORDER BY month DESC LIMIT 1`, [orgId, c.currency, month]));
    const previous = Number(prev?.provision_minor ?? 0);
    await outsideRequestScope(() => query(
      `INSERT INTO bad_debt_provision (org_id, month, currency, provision_minor, previous_minor, movement_minor, data, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (org_id, month, currency) DO UPDATE SET provision_minor = EXCLUDED.provision_minor, previous_minor = EXCLUDED.previous_minor, movement_minor = EXCLUDED.movement_minor,
         data = EXCLUDED.data, recorded_by = EXCLUDED.recorded_by, recorded_at = now()`,
      [orgId, month, c.currency, c.provision, previous, c.provision - previous, JSON.stringify({ buckets: c.buckets, rates: p.rates, asOf: p.asOf }), userId]));
    out.push({ currency: c.currency, provision: c.provision, previous, movement: c.provision - previous });
  }
  return { month, currencies: out };
}

export async function history(orgId: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT b.*, u.name AS by_name FROM bad_debt_provision b LEFT JOIN app_user u ON u.id = b.recorded_by WHERE b.org_id = $1 ORDER BY b.month DESC, b.currency LIMIT 72`, [orgId]));
  return rows.map((r) => ({ month: r.month, currency: r.currency, provision: Number(r.provision_minor), previous: Number(r.previous_minor), movement: Number(r.movement_minor), by: r.by_name ?? null, at: new Date(r.recorded_at).toISOString() }));
}

export function provisionXlsx(p: Awaited<ReturnType<typeof provision>>, h: Awaited<ReturnType<typeof history>>): Buffer {
  return xlsx([
    { name: 'Provision', rows: [['Currency', 'Bucket', 'Receivables', 'Count', 'Rate %', 'Provision'], ...p.currencies.flatMap((c) => c.buckets.map((b) => [c.currency, b.bucket, b.amount, b.count, b.ratePct, b.provision]))],
      widths: [10, 10, 16, 8, 8, 16], formats: [null, null, 'int', 'int', null, 'int'] },
    { name: 'Journal', rows: [['Month', 'Currency', 'Provision', 'Previous', 'Movement', 'Entry'], ...h.map((x) => [x.month, x.currency, x.provision, x.previous, x.movement,
      x.movement >= 0 ? 'Dr bad-debt expense / Cr allowance for doubtful accounts' : 'Dr allowance for doubtful accounts / Cr bad-debt expense (release)'])],
      widths: [10, 10, 16, 16, 16, 60], formats: [null, null, 'int', 'int', 'int', null] },
  ]);
}
