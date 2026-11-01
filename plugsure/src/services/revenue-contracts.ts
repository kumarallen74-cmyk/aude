import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { assertOpen } from './finance-periods.js';
import { xlsx } from './xlsx.js';

/**
 * Revenue recognition and customer contracts (v1.40.0), PSAK 72 / IFRS 15, for contracts beyond pay-per-charge: a fleet's
 * annual charging-as-a-service, a B2B site with hardware, installation and a service plan.
 *
 *   contract      CT-00001…: the customer (optionally a fleet account), the term, the currency, active, ended or
 *                 cancelled, the renewal notice (60 days by default)
 *   obligations   what is promised, each with its share of the price (the transaction price allocated by the
 *                 operator): recognised ratably over its months (a subscription, a service plan) or at a point in
 *                 time when delivered (hardware, an installation)
 *   billings      what was invoiced (and when paid, to which account)
 *   schedule      per month: recognised and billed; the contract liability (billed ahead: deferred revenue) or the
 *                 contract asset (recognised ahead: accrued revenue); the remaining performance obligations
 *   ledger        the new contracts source: billed Dr 1370 contract receivables / Cr 2280 contract liabilities;
 *                 recognised Dr 2280 / Cr 4500 contract revenue (2280 with a debit balance is the contract asset);
 *                 paid Dr bank / Cr 1370
 *   renewals      an active contract ending within its notice period raises finance.contract_renewal_due
 */

export class ContractError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const ERR = (s: number, m: string) => new ContractError(s, m);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const RENEWAL = 'finance.contract_renewal_due';
export const KINDS = ['subscription', 'service', 'hardware', 'installation', 'other'] as const;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const addMonths = (m: string, k: number) => { const [y, mo] = m.split('-').map(Number) as [number, number]; const t = y * 12 + mo - 1 + k; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const monthsBetween = (a: string, b: string) => { const [ya, ma] = a.split('-').map(Number) as [number, number]; const [yb, mb] = b.split('-').map(Number) as [number, number]; return (yb - ya) * 12 + (mb - ma); };
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export interface Obligation { amount: number; recognition: 'ratably' | 'point_in_time'; startMonth: string | null; endMonth: string | null; deliveredOn: string | null }

/** An obligation's revenue in a month: ratably, evenly over its months (the last takes the rounding); else all in the month delivered. Pure. */
export function recognisedIn(o: Obligation, month: string): number {
  if (o.recognition === 'point_in_time') return o.deliveredOn && o.deliveredOn.slice(0, 7) === month ? o.amount : 0;
  if (!o.startMonth || !o.endMonth) return 0;
  const n = monthsBetween(o.startMonth, o.endMonth) + 1, k = monthsBetween(o.startMonth, month);
  if (k < 0 || k >= n) return 0;
  const each = Math.floor(o.amount / n);
  return k === n - 1 ? o.amount - each * (n - 1) : each;
}

/** Recognised up to and including a month. Pure. */
export function recognisedTo(o: Obligation, month: string): number {
  if (o.recognition === 'point_in_time') return o.deliveredOn && o.deliveredOn.slice(0, 7) <= month ? o.amount : 0;
  if (!o.startMonth || !o.endMonth || month < o.startMonth) return 0;
  if (month >= o.endMonth) return o.amount;
  let t = 0; for (let m = o.startMonth; m <= month; m = addMonths(m, 1)) t += recognisedIn(o, m);
  return t;
}

const C_SELECT = `SELECT c.*, to_char(c.start_on, 'YYYY-MM-DD') AS start_s, to_char(c.end_on, 'YYYY-MM-DD') AS end_s, f.name AS fleet_name FROM customer_contract c LEFT JOIN fleet_account f ON f.id = c.fleet_account_id`;

async function cRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw ERR(404, 'No such contract.');
  const c = await outsideRequestScope(() => one<any>(`${C_SELECT} WHERE c.id = $1 AND c.org_id = $2`, [id, orgId]));
  if (!c) throw ERR(404, 'No such contract.');
  return c;
}

async function parts(orgId: string, ids: string[]) {
  if (!ids.length) return { obs: [] as any[], bills: [] as any[] };
  const [obs, bills] = await outsideRequestScope(() => Promise.all([
    many<any>(`SELECT o.*, to_char(o.delivered_on, 'YYYY-MM-DD') AS del_s FROM contract_obligation o WHERE o.org_id = $1 AND o.contract_id = ANY($2::bigint[]) AND o.removed_at IS NULL ORDER BY o.id`, [orgId, ids]),
    many<any>(`SELECT b.*, to_char(b.billed_on, 'YYYY-MM-DD') AS billed_s, to_char(b.paid_on, 'YYYY-MM-DD') AS paid_s FROM contract_billing b WHERE b.org_id = $1 AND b.contract_id = ANY($2::bigint[]) AND b.voided_at IS NULL ORDER BY b.billed_on, b.id`, [orgId, ids]),
  ]));
  return { obs, bills };
}

const obView = (o: any) => ({ id: String(o.id), description: o.description, kind: o.kind, amount: Number(o.amount_minor), recognition: o.recognition, startMonth: o.start_month ?? null, endMonth: o.end_month ?? null, deliveredOn: o.del_s ?? null });
const obTerms = (o: ReturnType<typeof obView>): Obligation => ({ amount: o.amount, recognition: o.recognition, startMonth: o.startMonth, endMonth: o.endMonth, deliveredOn: o.deliveredOn });

function view(c: any, obs: any[], bills: any[], asOf: string) {
  const o = obs.filter((x) => String(x.contract_id) === String(c.id)).map(obView);
  const b = bills.filter((x) => String(x.contract_id) === String(c.id)).map((x) => ({ id: String(x.id), billedOn: x.billed_s, amount: Number(x.amount_minor), reference: x.reference ?? null, paidOn: x.paid_s ?? null }));
  const month = asOf.slice(0, 7);
  const value = o.reduce((a, x) => a + x.amount, 0);
  const recognised = o.reduce((a, x) => a + recognisedTo(obTerms(x), month), 0);
  const billed = b.filter((x) => x.billedOn <= asOf).reduce((a, x) => a + x.amount, 0);
  const paid = b.filter((x) => x.paidOn && x.paidOn <= asOf).reduce((a, x) => a + x.amount, 0);
  const position = billed - recognised;
  return {
    id: String(c.id), number: c.number, customer: c.customer, fleetAccountId: c.fleet_account_id ?? null, fleetAccount: c.fleet_name ?? null, currency: c.currency,
    startOn: c.start_s, endOn: c.end_s, status: c.status as string, renewalNoticeDays: c.renewal_notice_days, note: c.note ?? null,
    obligations: o, billings: b, value, recognised, billed, paid, receivable: billed - paid,
    contractLiability: Math.max(0, position), contractAsset: Math.max(0, -position), remaining: value - recognised,
    daysToEnd: days(asOf, c.end_s), renewalDue: c.status === 'active' && days(asOf, c.end_s) >= 0 && days(asOf, c.end_s) <= c.renewal_notice_days,
    allocated: value > 0,
  };
}

export async function list(orgId: string, now = new Date()) {
  const cs = await outsideRequestScope(() => many<any>(`${C_SELECT} WHERE c.org_id = $1 ORDER BY (c.status = 'active') DESC, c.end_on, c.id`, [orgId]));
  const p = await parts(orgId, cs.map((c) => String(c.id)));
  const t = today(now);
  const contracts = cs.map((c) => view(c, p.obs, p.bills, t));
  const totals: Record<string, { value: number; recognised: number; remaining: number; contractLiability: number; contractAsset: number; receivable: number; active: number }> = {};
  for (const c of contracts.filter((x) => x.status !== 'cancelled')) {
    const x = (totals[c.currency] ??= { value: 0, recognised: 0, remaining: 0, contractLiability: 0, contractAsset: 0, receivable: 0, active: 0 });
    x.value += c.value; x.recognised += c.recognised; x.remaining += c.remaining; x.contractLiability += c.contractLiability; x.contractAsset += c.contractAsset; x.receivable += c.receivable;
    if (c.status === 'active') x.active++;
  }
  return { asOf: t, contracts, totals, renewalsDue: contracts.filter((c) => c.renewalDue).length };
}

export async function get(orgId: string, id: string, now = new Date()) {
  const c = await cRow(orgId, id);
  const p = await parts(orgId, [id]);
  const v = view(c, p.obs, p.bills, today(now));
  // The schedule: every month from the start to the later of the end and the last delivery or billing.
  const lastMonth = [v.endOn.slice(0, 7), ...v.obligations.map((o) => o.endMonth ?? o.deliveredOn?.slice(0, 7) ?? ''), ...v.billings.map((b) => b.billedOn.slice(0, 7))].filter(Boolean).sort().at(-1)!;
  const first = [v.startOn.slice(0, 7), ...v.billings.map((b) => b.billedOn.slice(0, 7))].sort()[0]!;
  const schedule: Array<{ month: string; recognised: number; billed: number; contractLiability: number; contractAsset: number }> = [];
  let cr = 0, cb = 0;
  for (let m = first; m <= lastMonth && schedule.length < 240; m = addMonths(m, 1)) {
    const r = v.obligations.reduce((a, o) => a + recognisedIn(obTerms(o), m), 0), b = v.billings.filter((x) => x.billedOn.slice(0, 7) === m).reduce((a, x) => a + x.amount, 0);
    cr += r; cb += b;
    schedule.push({ month: m, recognised: r, billed: b, contractLiability: Math.max(0, cb - cr), contractAsset: Math.max(0, cr - cb) });
  }
  return { ...v, schedule };
}

export async function create(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const customer = String(b.customer ?? '').trim(), currency = String(b.currency ?? '').toUpperCase(), start = String(b.startOn ?? ''), end = String(b.endOn ?? '');
  if (!customer || customer.length > 160) throw ERR(422, 'customer is required (up to 160 characters).');
  if (!/^[A-Z]{3}$/.test(currency)) throw ERR(422, 'currency is an ISO code.');
  if (!DATE_RE.test(start) || !DATE_RE.test(end) || end < start) throw ERR(422, 'startOn and endOn are days, the end on or after the start.');
  const notice = b.renewalNoticeDays == null || b.renewalNoticeDays === '' ? 60 : Number(b.renewalNoticeDays);
  if (!Number.isInteger(notice) || notice < 0 || notice > 365) throw ERR(422, 'renewalNoticeDays is 0 to 365.');
  let fleet: string | null = null;
  if (b.fleetAccountId != null && b.fleetAccountId !== '') {
    fleet = String(b.fleetAccountId);
    if (!/^[0-9a-f-]{36}$/i.test(fleet) || !(await outsideRequestScope(() => one(`SELECT 1 FROM fleet_account WHERE id = $1 AND org_id = $2`, [fleet, orgId])))) throw ERR(422, 'fleetAccountId is not one of your fleet accounts.');
  }
  const n = await outsideRequestScope(() => one<{ n: number }>(`SELECT count(*)::int AS n FROM customer_contract WHERE org_id = $1`, [orgId]));
  const number = `CT-${String((n?.n ?? 0) + 1).padStart(5, '0')}`;
  const r = await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO customer_contract (org_id, number, customer, fleet_account_id, currency, start_on, end_on, renewal_notice_days, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [orgId, number, customer, fleet, currency, start, end, notice, b.note == null || b.note === '' ? null : String(b.note).slice(0, 500), userId]));
  if (Array.isArray(b.obligations)) for (const o of b.obligations) await addObligation(orgId, String(r!.id), o as Record<string, unknown>);
  return get(orgId, String(r!.id));
}

export async function update(orgId: string, id: string, b: Record<string, unknown>) {
  const c = await cRow(orgId, id);
  const status = b.status == null || b.status === '' ? c.status : String(b.status);
  if (!['draft', 'active', 'ended', 'cancelled'].includes(status)) throw ERR(422, 'status is draft, active, ended or cancelled.');
  const end = b.endOn == null || b.endOn === '' ? c.end_s : String(b.endOn);
  if (!DATE_RE.test(end) || end < c.start_s) throw ERR(422, 'endOn is a day on or after the start (a renewal extends it).');
  const notice = b.renewalNoticeDays == null || b.renewalNoticeDays === '' ? c.renewal_notice_days : Number(b.renewalNoticeDays);
  if (!Number.isInteger(notice) || notice < 0 || notice > 365) throw ERR(422, 'renewalNoticeDays is 0 to 365.');
  await outsideRequestScope(() => query(`UPDATE customer_contract SET status = $3, end_on = $4, renewal_notice_days = $5, note = COALESCE($6, note) WHERE id = $1 AND org_id = $2`,
    [id, orgId, status, end, notice, b.note == null || b.note === '' ? null : String(b.note).slice(0, 500)]));
  if (status !== 'active' || end > c.end_s) await outsideRequestScope(() => resolveAlertsFor(orgId, RENEWAL, 'customer_contract', id)).catch(() => 0);
  return get(orgId, id);
}

export async function addObligation(orgId: string, id: string, b: Record<string, unknown>) {
  const c = await cRow(orgId, id);
  const description = String(b.description ?? '').trim(), kind = String(b.kind ?? 'other'), amount = Number(b.amount), recognition = String(b.recognition ?? '');
  if (!description) throw ERR(422, 'description is required.');
  if (!(KINDS as readonly string[]).includes(kind)) throw ERR(422, `kind is one of ${KINDS.join(', ')}.`);
  if (!Number.isSafeInteger(amount) || amount < 0) throw ERR(422, 'amount is its share of the price, in minor units.');
  if (!['ratably', 'point_in_time'].includes(recognition)) throw ERR(422, 'recognition is ratably (over its months) or point_in_time (when delivered).');
  let start: string | null = null, end: string | null = null, delivered: string | null = null;
  if (recognition === 'ratably') {
    const s0: string = b.startMonth == null || b.startMonth === '' ? c.start_s.slice(0, 7) : String(b.startMonth);
    const e0: string = b.endMonth == null || b.endMonth === '' ? c.end_s.slice(0, 7) : String(b.endMonth);
    start = s0; end = e0;
    if (!MONTH_RE.test(s0) || !MONTH_RE.test(e0) || e0 < s0) throw ERR(422, 'startMonth and endMonth are YYYY-MM, the end on or after the start.');
    await assertOpen(orgId, s0, 'Revenue recognised', ERR);
  } else if (b.deliveredOn != null && b.deliveredOn !== '') {
    delivered = String(b.deliveredOn);
    if (!DATE_RE.test(delivered)) throw ERR(422, 'deliveredOn is a day.');
    await assertOpen(orgId, delivered.slice(0, 7), 'Revenue recognised', ERR);
  }
  const r = await outsideRequestScope(() => one<{ id: string }>(`INSERT INTO contract_obligation (org_id, contract_id, description, kind, amount_minor, recognition, start_month, end_month, delivered_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [orgId, id, description.slice(0, 300), kind, amount, recognition, start, end, delivered]));
  return { id: String(r!.id) };
}

/** Mark a point-in-time obligation delivered (or remove an obligation not yet recognised in a locked month). */
export async function updateObligation(orgId: string, id: string, oid: string, b: Record<string, unknown>) {
  await cRow(orgId, id);
  if (!/^\d{1,18}$/.test(oid)) throw ERR(404, 'No such obligation.');
  const o = await outsideRequestScope(() => one<any>(`SELECT * FROM contract_obligation WHERE id = $1 AND contract_id = $2 AND org_id = $3 AND removed_at IS NULL`, [oid, id, orgId]));
  if (!o) throw ERR(404, 'No such obligation.');
  if (b.remove === true) {
    if (o.start_month) await assertOpen(orgId, o.start_month, 'Revenue recognised', ERR);
    await outsideRequestScope(() => query(`UPDATE contract_obligation SET removed_at = now() WHERE id = $1`, [oid]));
  } else {
    if (o.recognition !== 'point_in_time') throw ERR(422, 'Only a point-in-time obligation is delivered.');
    const d = String(b.deliveredOn ?? '');
    if (!DATE_RE.test(d)) throw ERR(422, 'deliveredOn is a day.');
    await assertOpen(orgId, d.slice(0, 7), 'Revenue recognised', ERR);
    await outsideRequestScope(() => query(`UPDATE contract_obligation SET delivered_on = $2 WHERE id = $1`, [oid, d]));
  }
  return get(orgId, id);
}

export async function addBilling(orgId: string, id: string, b: Record<string, unknown>, userId: string | null) {
  await cRow(orgId, id);
  const on = String(b.billedOn ?? ''), amount = Number(b.amount);
  if (!DATE_RE.test(on)) throw ERR(422, 'billedOn is a day.');
  if (!Number.isSafeInteger(amount) || amount <= 0) throw ERR(422, 'amount is a positive amount in minor units.');
  await assertOpen(orgId, on.slice(0, 7), 'A contract billing', ERR);
  const r = await outsideRequestScope(() => one<{ id: string }>(`INSERT INTO contract_billing (org_id, contract_id, billed_on, amount_minor, reference, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [orgId, id, on, amount, b.reference == null || b.reference === '' ? null : String(b.reference).slice(0, 80), userId]));
  return { id: String(r!.id) };
}

export async function payBilling(orgId: string, id: string, bid: string, b: Record<string, unknown>, now = new Date()) {
  const c = await cRow(orgId, id);
  if (!/^\d{1,18}$/.test(bid)) throw ERR(404, 'No such billing.');
  const row = await outsideRequestScope(() => one<any>(`SELECT * FROM contract_billing WHERE id = $1 AND contract_id = $2 AND org_id = $3 AND voided_at IS NULL`, [bid, id, orgId]));
  if (!row) throw ERR(404, 'No such billing.');
  if (row.paid_on) throw ERR(409, 'Already paid.');
  const on = String(b.paidOn ?? ''), acct = String(b.cashAccountId ?? '');
  if (!DATE_RE.test(on) || on > today(now)) throw ERR(422, 'paidOn is a day, not in the future.');
  const a = /^\d{1,18}$/.test(acct) ? await outsideRequestScope(() => one<{ currency: string }>(`SELECT currency FROM cash_account WHERE id = $1 AND org_id = $2`, [acct, orgId])) : null;
  if (!a || a.currency !== c.currency) throw ERR(422, 'cashAccountId is one of your accounts in the contract\'s currency.');
  await assertOpen(orgId, on.slice(0, 7), 'A payment', ERR);
  await outsideRequestScope(() => query(`UPDATE contract_billing SET paid_on = $2, cash_account_id = $3 WHERE id = $1`, [bid, on, acct]));
  return get(orgId, id, now);
}

export async function voidBilling(orgId: string, id: string, bid: string) {
  await cRow(orgId, id);
  const row = /^\d{1,18}$/.test(bid) ? await outsideRequestScope(() => one<any>(`SELECT to_char(billed_on, 'YYYY-MM') AS m, paid_on FROM contract_billing WHERE id = $1 AND contract_id = $2 AND org_id = $3 AND voided_at IS NULL`, [bid, id, orgId])) : null;
  if (!row) throw ERR(404, 'No such billing.');
  if (row.paid_on) throw ERR(409, 'A paid billing is not voided.');
  await assertOpen(orgId, row.m, 'A contract billing', ERR);
  await outsideRequestScope(() => query(`UPDATE contract_billing SET voided_at = now() WHERE id = $1`, [bid]));
  return get(orgId, id);
}

/** The ledger's contracts journal for a month. */
export async function journal(orgId: string, month: string) {
  const cs = await outsideRequestScope(() => many<any>(`${C_SELECT} WHERE c.org_id = $1 AND c.status <> 'draft'`, [orgId]));
  const p = await parts(orgId, cs.map((c) => String(c.id)));
  const accts = await outsideRequestScope(() => many<any>(`SELECT id::text AS id, kind FROM cash_account WHERE org_id = $1`, [orgId]));
  const out: Record<string, Array<{ account: string; debit: number; credit: number; description: string }>> = {};
  for (const c of cs) {
    const L = (out[c.currency] ??= []), d = `${c.number} ${c.customer}`.slice(0, 100);
    const rec = p.obs.filter((o) => String(o.contract_id) === String(c.id)).map(obView).reduce((a, o) => a + recognisedIn(obTerms(o), month), 0);
    const billed = p.bills.filter((b) => String(b.contract_id) === String(c.id) && b.billed_s.slice(0, 7) === month).reduce((a, b) => a + Number(b.amount_minor), 0);
    if (billed) L.push({ account: '1370', debit: billed, credit: 0, description: `${d} billed` }, { account: '2280', debit: 0, credit: billed, description: `${d} billed` });
    if (rec) L.push({ account: '2280', debit: rec, credit: 0, description: `${d} recognised` }, { account: '4500', debit: 0, credit: rec, description: `${d} recognised` });
    for (const b of p.bills.filter((x) => String(x.contract_id) === String(c.id) && x.paid_s?.slice(0, 7) === month)) {
      const bank = accts.find((a) => a.id === String(b.cash_account_id))?.kind === 'cash' ? '1050' : '1100';
      L.push({ account: bank, debit: Number(b.amount_minor), credit: 0, description: `${d} paid` }, { account: '1370', debit: 0, credit: Number(b.amount_minor), description: `${d} paid` });
    }
  }
  for (const k of Object.keys(out)) if (!out[k]!.length) delete out[k];
  return out;
}

export async function cashMoves(orgId: string, upTo: string) {
  const rows = await outsideRequestScope(() => many<any>(`SELECT cash_account_id::text AS a, to_char(paid_on, 'YYYY-MM-DD') AS d, amount_minor FROM contract_billing WHERE org_id = $1 AND voided_at IS NULL AND paid_on IS NOT NULL AND cash_account_id IS NOT NULL AND paid_on <= $2::date`, [orgId, upTo]));
  return rows.map((x) => ({ account_id: x.a as string, d: x.d as string, amount: Number(x.amount_minor) }));
}

/** Daily: renewals coming up within each contract's notice period. */
export async function sweep(now = new Date()): Promise<number> {
  const t = today(now);
  const rows = await outsideRequestScope(() => many<any>(`SELECT id, org_id, number, customer, to_char(end_on, 'YYYY-MM-DD') AS end_s, renewal_notice_days FROM customer_contract WHERE status = 'active' AND end_on >= $1::date`, [t]));
  let n = 0;
  for (const r of rows) {
    try {
      const left = days(t, r.end_s);
      if (left > r.renewal_notice_days) continue;
      await outsideRequestScope(() => persistAlert({ orgId: r.org_id, kind: RENEWAL, severity: left <= 14 ? 'critical' : 'warning', targetType: 'customer_contract', targetId: String(r.id),
        message: `Contract ${r.number} with ${r.customer} ends ${r.end_s} (${left} days): renew, extend or let it end. Finance → Contracts.` }));
      n++;
    } catch (e) { logger.warn({ contract: r.id, err: (e as Error).message }, 'contract renewal sweep failed'); }
  }
  return n;
}

export async function reportXlsx(orgId: string, now = new Date()): Promise<Buffer> {
  const l = await list(orgId, now);
  const scheds = await Promise.all(l.contracts.map((c) => get(orgId, c.id, now)));
  return xlsx([
    { name: 'Contracts', rows: [['Contract', 'Customer', 'Currency', 'Start', 'End', 'Status', 'Value', 'Recognised', 'Remaining', 'Billed', 'Paid', 'Contract liability', 'Contract asset'],
      ...l.contracts.map((c) => [c.number, c.customer, c.currency, c.startOn, c.endOn, c.status, c.value, c.recognised, c.remaining, c.billed, c.paid, c.contractLiability, c.contractAsset])],
      widths: [10, 28, 8, 11, 11, 10, 14, 14, 14, 14, 14, 14, 14], formats: [null, null, null, null, null, null, 'money', 'money', 'money', 'money', 'money', 'money', 'money'] },
    { name: 'Schedules', rows: [['Contract', 'Month', 'Recognised', 'Billed', 'Contract liability', 'Contract asset'], ...scheds.flatMap((s) => s.schedule.map((x) => [s.number, x.month, x.recognised, x.billed, x.contractLiability, x.contractAsset]))],
      widths: [10, 9, 14, 14, 16, 14], formats: [null, null, 'money', 'money', 'money', 'money'] },
  ]);
}

