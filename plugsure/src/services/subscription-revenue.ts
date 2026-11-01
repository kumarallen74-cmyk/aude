import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { xlsx } from './xlsx.js';

/**
 * Subscription and membership revenue (v1.26.0). A membership or 30-day pass is paid for a period ahead; its revenue
 * is earned day by day over that period (PSAK 72 / IFRS 15, over time). For a month, per currency:
 *
 *   billed        charges (before tax) paid in the month, or invoiced to a fleet on an issued invoice
 *   recognised    the part of every charge's period that falls in the month, pro rata by the second
 *   deferred      at the month's end, what was billed for days still to come (a liability: deferred revenue)
 *   MRR           the monthly fee of every subscription active at the month's end (complimentary ones excluded)
 *   movement      new subscribers, cancellations and expiries in the month; churn = those lost ÷ active at the start
 *
 * Per plan as well, and a journal entry for the month: billed into deferred revenue, recognised out of it.
 * Test-mode charges and void charges are left out.
 */

export class SubscriptionRevenueError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const zone = () => config.billing.timeZone;
const localDay = (t: Date | number = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(new Date(t));

export interface RevenueAccounts { deferred: { code: string; name: string }; revenue: { code: string; name: string }; receivable: { code: string; name: string } }
export const DEFAULT_ACCOUNTS: RevenueAccounts = {
  deferred: { code: '2-1400', name: 'Pendapatan diterima di muka (langganan)' },
  revenue: { code: '4-1200', name: 'Pendapatan langganan' },
  receivable: { code: '1-1300', name: 'Kas / piutang langganan' },
};

export async function accounts(orgId: string): Promise<RevenueAccounts> {
  const r = await outsideRequestScope(() => one<{ subscription_revenue: any }>(`SELECT subscription_revenue FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const v = r?.subscription_revenue?.accounts ?? {};
  const pick = (k: keyof RevenueAccounts) => ({ code: String(v[k]?.code ?? DEFAULT_ACCOUNTS[k].code), name: String(v[k]?.name ?? DEFAULT_ACCOUNTS[k].name) });
  return { deferred: pick('deferred'), revenue: pick('revenue'), receivable: pick('receivable') };
}

export async function saveAccounts(orgId: string, b: Record<string, unknown>, userId: string | null): Promise<RevenueAccounts> {
  const cur = await accounts(orgId);
  const out = { ...cur };
  for (const k of ['deferred', 'revenue', 'receivable'] as const) {
    const x = (b as any)[k];
    if (x == null) continue;
    const code = String(x.code ?? '').trim(), name = String(x.name ?? '').trim();
    if (!/^[\w.-]{1,20}$/.test(code) || !name || name.length > 80) throw new SubscriptionRevenueError(422, `${k}: an account code (up to 20 letters, digits, . or -) and a name.`);
    out[k] = { code, name };
  }
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, subscription_revenue, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET subscription_revenue = EXCLUDED.subscription_revenue, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, JSON.stringify({ accounts: out }), userId]));
  return out;
}

function bounds(month: string) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { from: `${month}-01`, toExcl: `${next}-01` };
}

export function monthOf(raw: unknown): string {
  if (raw == null || raw === '') return localDay().slice(0, 7);
  const m = String(raw);
  if (!MONTH_RE.test(m)) throw new SubscriptionRevenueError(422, 'month is YYYY-MM.');
  return m;
}

/** The part of [ps, pe) inside [a, b), as a fraction of [ps, pe). */
export function share(ps: number, pe: number, a: number, b: number): number {
  if (pe <= ps) return 0;
  const lo = Math.max(ps, a), hi = Math.min(pe, b);
  return hi > lo ? (hi - lo) / (pe - ps) : 0;
}

export async function report(orgId: string, monthRaw?: unknown) {
  const month = monthOf(monthRaw);
  const { from, toExcl } = bounds(month);
  const z = zone();
  // Month bounds as instants in the billing zone.
  const bb = (await outsideRequestScope(() => one<{ a: Date; b: Date }>(`SELECT ($1::timestamp AT TIME ZONE $3) AS a, ($2::timestamp AT TIME ZONE $3) AS b`, [from, toExcl, z])))!;
  const [a, b] = [new Date(bb.a).getTime(), new Date(bb.b).getTime()];
  const charges = await outsideRequestScope(() => many<any>(
    `SELECT c.id, c.currency, c.tax_base_minor, c.period_start, c.period_end, COALESCE(c.paid_at, i.issued_at) AS billed_at, p.id AS plan_id, p.name AS plan
       FROM subscription_charge c JOIN subscription s ON s.id = c.subscription_id JOIN subscription_plan p ON p.id = s.plan_id
       LEFT JOIN fleet_invoice i ON i.id = c.fleet_invoice_id AND i.status IN ('issued', 'paid')
      WHERE c.org_id = $1 AND c.state <> 'void' AND NOT COALESCE(c.test_mode, false) AND c.tax_base_minor > 0
        AND (c.state = 'paid' OR i.id IS NOT NULL)
        AND COALESCE(c.paid_at, i.issued_at) < $2::timestamptz AND c.period_end > $3::timestamptz - interval '1 day'`,
    [orgId, new Date(b).toISOString(), new Date(a).toISOString()]));
  type Agg = { billed: number; recognised: number; deferredEnd: number; deferredStart: number };
  const per: Record<string, Agg & { plans: Record<string, Agg & { plan: string }> }> = {};
  for (const c of charges) {
    const base = Number(c.tax_base_minor);
    const ps = new Date(c.period_start).getTime(), pe = new Date(c.period_end).getTime(), billed = new Date(c.billed_at).getTime();
    const cur = (per[c.currency] ??= { billed: 0, recognised: 0, deferredEnd: 0, deferredStart: 0, plans: {} });
    const pl = (cur.plans[c.plan_id] ??= { plan: c.plan, billed: 0, recognised: 0, deferredEnd: 0, deferredStart: 0 });
    const add = (k: keyof Agg, v: number) => { cur[k] += v; pl[k] += v; };
    if (billed >= a && billed < b) add('billed', base);
    add('recognised', Math.round(base * share(ps, pe, a, b)));
    // Deferred at a moment t: billed by then, for the part of the period after t.
    if (billed < b) add('deferredEnd', Math.round(base * share(ps, pe, b, Infinity)));
    if (billed < a) add('deferredStart', Math.round(base * share(ps, pe, a, Infinity)));
  }
  const subs = await outsideRequestScope(() => many<any>(
    `SELECT p.currency, count(*) FILTER (WHERE s.started_at < $2 AND (s.cancelled_at IS NULL OR s.cancelled_at >= $2) AND (s.status IN ('active', 'cancelled', 'expired')) AND (s.current_period_end IS NULL OR s.current_period_end >= $2))::int AS active_start,
            count(*) FILTER (WHERE s.started_at < $3 AND s.status = 'active' AND (s.cancelled_at IS NULL OR s.cancelled_at >= $3))::int AS active_end,
            count(*) FILTER (WHERE s.started_at >= $2 AND s.started_at < $3 AND s.status <> 'pending_payment')::int AS new_subs,
            count(*) FILTER (WHERE s.cancelled_at >= $2 AND s.cancelled_at < $3)::int AS cancelled,
            count(*) FILTER (WHERE s.status = 'expired' AND s.current_period_end >= $2 AND s.current_period_end < $3)::int AS expired,
            COALESCE(sum(p.monthly_fee_minor) FILTER (WHERE s.started_at < $3 AND s.status = 'active' AND s.billing <> 'complimentary' AND (s.cancelled_at IS NULL OR s.cancelled_at >= $3)), 0)::bigint AS mrr
       FROM subscription s JOIN subscription_plan p ON p.id = s.plan_id WHERE s.org_id = $1 GROUP BY 1`,
    [orgId, new Date(a).toISOString(), new Date(b).toISOString()]));
  const currencies = [...new Set([...Object.keys(per), ...subs.map((s) => s.currency)])].sort().map((c) => {
    const g = per[c] ?? { billed: 0, recognised: 0, deferredEnd: 0, deferredStart: 0, plans: {} };
    const s = subs.find((x) => x.currency === c) ?? { active_start: 0, active_end: 0, new_subs: 0, cancelled: 0, expired: 0, mrr: 0 };
    const lost = Number(s.cancelled) + Number(s.expired);
    return {
      currency: c, billed: g.billed, recognised: g.recognised, deferredStart: g.deferredStart, deferredEnd: g.deferredEnd,
      mrr: Number(s.mrr), arr: Number(s.mrr) * 12,
      subscribers: { atStart: s.active_start, atEnd: s.active_end, new: s.new_subs, cancelled: s.cancelled, expired: s.expired },
      churnPct: s.active_start ? Math.round((lost / s.active_start) * 1000) / 10 : null,
      plans: Object.entries(g.plans).map(([id, p]) => ({ planId: id, plan: p.plan, billed: p.billed, recognised: p.recognised, deferredEnd: p.deferredEnd })).sort((x, y) => y.recognised - x.recognised),
    };
  });
  const acc = await accounts(orgId);
  const lastDay = localDay(b - 1);
  // Billed: Dr cash/receivable, Cr deferred. Recognised: Dr deferred, Cr revenue.
  const journal = currencies.flatMap((c) => [
    ...(c.billed ? [
      { date: lastDay, currency: c.currency, code: acc.receivable.code, account: acc.receivable.name, debit: c.billed, credit: 0, description: `Subscriptions billed ${month}` },
      { date: lastDay, currency: c.currency, code: acc.deferred.code, account: acc.deferred.name, debit: 0, credit: c.billed, description: `Subscriptions billed ${month}` },
    ] : []),
    ...(c.recognised ? [
      { date: lastDay, currency: c.currency, code: acc.deferred.code, account: acc.deferred.name, debit: c.recognised, credit: 0, description: `Subscription revenue earned ${month}` },
      { date: lastDay, currency: c.currency, code: acc.revenue.code, account: acc.revenue.name, debit: 0, credit: c.recognised, description: `Subscription revenue earned ${month}` },
    ] : []),
  ]);
  return { month, accounts: acc, currencies, journal };
}

/** Twelve months to the given one: recognised, deferred at the end and MRR, per currency. */
export async function trend(orgId: string, monthRaw?: unknown) {
  const month = monthOf(monthRaw);
  const months: string[] = [];
  let [y, m] = month.split('-').map(Number) as [number, number];
  for (let i = 0; i < 12; i++) { months.unshift(`${y}-${String(m).padStart(2, '0')}`); m--; if (m === 0) { m = 12; y--; } }
  const out = [];
  for (const mo of months) {
    const r = await report(orgId, mo);
    for (const c of r.currencies) out.push({ month: mo, currency: c.currency, recognised: c.recognised, deferredEnd: c.deferredEnd, mrr: c.mrr, subscribers: c.subscribers.atEnd });
  }
  return { months, rows: out };
}

export function reportXlsx(r: Awaited<ReturnType<typeof report>>): Buffer {
  return xlsx([
    { name: 'Summary', rows: [['Currency', 'Billed', 'Recognised', 'Deferred at start', 'Deferred at end', 'MRR', 'ARR', 'Subscribers at start', 'New', 'Cancelled', 'Expired', 'At end', 'Churn %'],
      ...r.currencies.map((c) => [c.currency, c.billed, c.recognised, c.deferredStart, c.deferredEnd, c.mrr, c.arr, c.subscribers.atStart, c.subscribers.new, c.subscribers.cancelled, c.subscribers.expired, c.subscribers.atEnd, c.churnPct ?? ''])],
      widths: [10, 14, 14, 16, 16, 14, 14, 12, 8, 10, 9, 9, 9], formats: [null, 'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int', 'int', null] },
    { name: 'By plan', rows: [['Currency', 'Plan', 'Billed', 'Recognised', 'Deferred at end'], ...r.currencies.flatMap((c) => c.plans.map((p) => [c.currency, p.plan, p.billed, p.recognised, p.deferredEnd]))],
      widths: [10, 36, 14, 14, 16], formats: [null, null, 'int', 'int', 'int'] },
    { name: 'Journal', rows: [['Date', 'Currency', 'Account', 'Name', 'Debit', 'Credit', 'Description'], ...r.journal.map((j) => [j.date, j.currency, j.code, j.account, j.debit, j.credit, j.description])],
      widths: [12, 10, 12, 36, 14, 14, 40], formats: [null, null, null, null, 'int', 'int', null] },
  ]);
}
