import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { assertOpen } from './finance-periods.js';
import { xlsx } from './xlsx.js';

/**
 * Lease accounting, PSAK 73 (IFRS 16) (v1.30.0). Leases the operator holds — a site's land or parking bays, a
 * transformer, a vehicle:
 *
 *   terms       the payment (minor unit), monthly, quarterly or yearly, in advance or in arrears; the term in months
 *               from a start month; the discount rate (the incremental borrowing rate, a year); initial direct costs
 *   recognition the lease liability is the payments discounted at the monthly rate ((1 + rate)^(1/12) − 1); the
 *               right-of-use asset is the liability plus the initial direct costs
 *   each month  interest on the liability (in advance: after the month's payment); the payment reduces it; the
 *               right-of-use asset is depreciated straight-line over the term; the last month takes the rounding so the
 *               liability ends at 0
 *   exempt      short-term (12 months or less) or low-value leases are not recognised: the payments are expensed
 *               straight-line over the term
 *   ended early from a month: the liability left and the asset's net book value are derecognised, with the gain or loss
 *
 * The month's journal per currency: Dr ROU depreciation / Cr accumulated ROU depreciation; Dr lease interest / Cr lease
 * liability; Dr lease liability / Cr bank for the payments; exempt leases Dr lease expense / Cr accrued lease, and the
 * payments Dr accrued lease / Cr bank; an early end Dr liability, Dr accumulated, Cr ROU asset, and the gain or loss.
 * Recorded per month (again replaces it); locked months are respected. The liability is split into current (the next
 * 12 months' reduction) and non-current.
 */

export class LeaseError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const ACCOUNTS = {
  rou: { code: '1650', name: 'Right-of-use assets' },
  rouAccumulated: { code: '1659', name: 'Accumulated depreciation, right-of-use assets' },
  liability: { code: '2400', name: 'Lease liabilities' },
  accrued: { code: '2410', name: 'Accrued lease payments' },
  depreciation: { code: '6410', name: 'Depreciation, right-of-use assets' },
  expense: { code: '6420', name: 'Lease expense (short-term and low-value)' },
  interest: { code: '7200', name: 'Interest on lease liabilities' },
  gain: { code: '7100', name: 'Gain on lease termination' },
  loss: { code: '8100', name: 'Loss on lease termination' },
  bank: { code: '1100', name: 'Bank' },
} as const;
type AccountKey = keyof typeof ACCOUNTS;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD: Record<string, number> = { monthly: 1, quarterly: 3, yearly: 12 };
const zone = () => config.billing.timeZone;
const thisMonth = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now).slice(0, 7);
export const addMonths = (m: string, n: number) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const t = y * 12 + (mo - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const monthsBetween = (a: string, b: string) => {
  const [ya, ma] = a.split('-').map(Number) as [number, number];
  const [yb, mb] = b.split('-').map(Number) as [number, number];
  return (yb - ya) * 12 + (mb - ma);
};
const lastDay = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`; };

export interface LeaseTerms { payment: number; frequency: 'monthly' | 'quarterly' | 'yearly'; timing: 'advance' | 'arrears'; termMonths: number; ratePct: number; directCosts: number; startMonth: string; exempt: 'short_term' | 'low_value' | null; endedMonth: string | null }
export interface LeaseRow { month: string; opening: number; payment: number; interest: number; closing: number; depreciation: number; rouNbv: number; expense: number }

/** Whether a payment falls in month k (0-based) of the term. */
const paysIn = (t: LeaseTerms, k: number) => { const p = PERIOD[t.frequency]!; return t.timing === 'advance' ? k % p === 0 : (k + 1) % p === 0; };

/** The lease liability at commencement: the payments discounted at the monthly rate. */
export function presentValue(t: LeaseTerms): number {
  const rm = Math.pow(1 + t.ratePct / 100, 1 / 12) - 1;
  let pv = 0;
  for (let k = 0; k < t.termMonths; k++) {
    if (!paysIn(t, k)) continue;
    const at = t.timing === 'advance' ? k : k + 1;
    pv += t.payment / Math.pow(1 + rm, at);
  }
  return Math.round(pv);
}

/** Month by month over the term (stopping before an early end). */
export function schedule(t: LeaseTerms): { liability: number; rou: number; rows: LeaseRow[] } {
  const rows: LeaseRow[] = [];
  const total = Array.from({ length: t.termMonths }, (_, k) => (paysIn(t, k) ? t.payment : 0)).reduce((a, b) => a + b, 0);
  if (t.exempt) {
    const per = Math.floor(total / t.termMonths);
    for (let k = 0; k < t.termMonths; k++) {
      const month = addMonths(t.startMonth, k);
      if (t.endedMonth && month >= t.endedMonth) break;
      rows.push({ month, opening: 0, payment: paysIn(t, k) ? t.payment : 0, interest: 0, closing: 0, depreciation: 0, rouNbv: 0, expense: k === t.termMonths - 1 ? total - per * (t.termMonths - 1) : per });
    }
    return { liability: 0, rou: 0, rows };
  }
  const rm = Math.pow(1 + t.ratePct / 100, 1 / 12) - 1;
  const liability = presentValue(t);
  const rou = liability + t.directCosts;
  const dep = Math.floor(rou / t.termMonths);
  let L = liability, acc = 0;
  for (let k = 0; k < t.termMonths; k++) {
    const month = addMonths(t.startMonth, k);
    if (t.endedMonth && month >= t.endedMonth) break;
    const pay = paysIn(t, k) ? t.payment : 0;
    const opening = L;
    let interest: number;
    if (t.timing === 'advance') { L -= pay; interest = Math.round(L * rm); L += interest; } else { interest = Math.round(L * rm); L += interest - pay; }
    if (k === t.termMonths - 1 && L !== 0) { interest -= L; L = 0; }
    const d = k === t.termMonths - 1 ? rou - dep * (t.termMonths - 1) : dep;
    acc += d;
    rows.push({ month, opening, payment: pay, interest, closing: L, depreciation: d, rouNbv: rou - acc, expense: 0 });
  }
  return { liability, rou, rows };
}

const termsOf = (r: any): LeaseTerms => ({
  payment: Number(r.payment_minor), frequency: r.frequency, timing: r.timing, termMonths: Number(r.term_months), ratePct: Number(r.rate_pct),
  directCosts: Number(r.direct_costs_minor), startMonth: r.start_month, exempt: r.exempt ?? null, endedMonth: r.ended_month ?? null,
});

/** Position at the end of a month: liability (current and non-current), ROU net book value. */
export function positionAt(t: LeaseTerms, month: string) {
  const s = schedule(t);
  if (t.exempt) return { liability: 0, current: 0, nonCurrent: 0, rouNbv: 0, started: month >= t.startMonth };
  if (month < t.startMonth) return { liability: 0, current: 0, nonCurrent: 0, rouNbv: 0, started: false };
  const at = [...s.rows].reverse().find((r) => r.month <= month);
  if (!at || (t.endedMonth && month >= t.endedMonth)) return { liability: 0, current: 0, nonCurrent: 0, rouNbv: 0, started: true };
  const in12 = [...s.rows].reverse().find((r) => r.month <= addMonths(month, 12));
  const current = at.closing - (in12 && in12.month > month ? in12.closing : at.closing);
  return { liability: at.closing, current, nonCurrent: at.closing - current, rouNbv: at.rouNbv, started: true };
}

const SELECT = `SELECT l.*, s.name AS site_name, su.name AS supplier_name, u.name AS by_name FROM lease l LEFT JOIN site s ON s.id = l.site_id LEFT JOIN supplier su ON su.id = l.supplier_id LEFT JOIN app_user u ON u.id = l.recorded_by`;

function view(r: any, asOf: string) {
  const t = termsOf(r);
  const s = schedule(t);
  const p = positionAt(t, asOf);
  const row = s.rows.find((x) => x.month === asOf);
  return {
    id: String(r.id), description: r.description, siteId: r.site_id ?? null, site: r.site_name ?? null, supplierId: r.supplier_id == null ? null : String(r.supplier_id), supplier: r.supplier_name ?? null,
    currency: r.currency, startMonth: t.startMonth, endMonth: addMonths(t.startMonth, t.termMonths - 1), termMonths: t.termMonths, payment: t.payment, frequency: t.frequency, timing: t.timing,
    ratePct: t.ratePct, directCosts: t.directCosts, exempt: t.exempt, initialLiability: s.liability, initialRou: s.rou,
    position: p, thisMonth: row ? { payment: row.payment, interest: row.interest, depreciation: row.depreciation, expense: row.expense } : null,
    status: r.voided_at ? 'voided' : t.endedMonth && t.endedMonth <= asOf ? 'ended' : asOf < t.startMonth ? 'not_started' : asOf > addMonths(t.startMonth, t.termMonths - 1) ? 'expired' : 'active',
    endedMonth: t.endedMonth, endNote: r.end_note ?? null, recordedBy: r.by_name ?? null, voidReason: r.void_reason ?? null,
  };
}
export type LeaseView = ReturnType<typeof view>;

export async function list(orgId: string, q: Record<string, unknown> = {}, now = new Date()) {
  const asOf = q.month == null || q.month === '' ? thisMonth(now) : String(q.month);
  if (!MONTH_RE.test(asOf)) throw new LeaseError(422, 'month is YYYY-MM.');
  const rows = await outsideRequestScope(() => many<any>(`${SELECT} WHERE l.org_id = $1 ORDER BY l.voided_at NULLS FIRST, l.start_month, l.id`, [orgId]));
  const leases = rows.map((r) => view(r, asOf));
  const totals: Record<string, { liability: number; current: number; nonCurrent: number; rouNbv: number; count: number }> = {};
  for (const l of leases.filter((x) => x.status !== 'voided')) {
    const t = (totals[l.currency] ??= { liability: 0, current: 0, nonCurrent: 0, rouNbv: 0, count: 0 });
    t.liability += l.position.liability; t.current += l.position.current; t.nonCurrent += l.position.nonCurrent; t.rouNbv += l.position.rouNbv;
    if (l.status === 'active') t.count++;
  }
  return { asOf, leases, totals, accounts: ACCOUNTS };
}

async function row(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new LeaseError(404, 'No such lease.');
  const r = await outsideRequestScope(() => one<any>(`${SELECT} WHERE l.id = $1 AND l.org_id = $2`, [id, orgId]));
  if (!r) throw new LeaseError(404, 'No such lease.');
  return r;
}

export async function get(orgId: string, id: string, now = new Date()) {
  const r = await row(orgId, id);
  return { ...view(r, thisMonth(now)), schedule: schedule(termsOf(r)).rows };
}

const ERR = (st: number, msg: string) => new LeaseError(st, msg);

export async function create(orgId: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const description = String(b.description ?? '').trim();
  if (description.length < 2 || description.length > 200) throw new LeaseError(422, 'Describe the lease (2 to 200 characters).');
  const siteId = b.siteId == null || b.siteId === '' ? null : String(b.siteId);
  let currency = b.currency == null || b.currency === '' ? null : String(b.currency).toUpperCase();
  if (siteId) {
    if (!UUID_RE.test(siteId)) throw new LeaseError(404, 'No such site.');
    const s = await outsideRequestScope(() => one<{ currency: string }>(`SELECT co.currency FROM site s JOIN country co ON co.code = s.country_code WHERE s.id = $1 AND s.org_id = $2`, [siteId, orgId]));
    if (!s) throw new LeaseError(404, 'No such site.');
    currency = s.currency;
  }
  if (!currency || !/^[A-Z]{3}$/.test(currency)) throw new LeaseError(422, 'currency (ISO 4217) is needed for a lease without a site.');
  const supplierId = b.supplierId == null || b.supplierId === '' ? null : String(b.supplierId);
  if (supplierId) {
    if (!/^\d{1,18}$/.test(supplierId)) throw new LeaseError(404, 'No such supplier.');
    if (!(await outsideRequestScope(() => one(`SELECT 1 FROM supplier WHERE id = $1 AND org_id = $2`, [supplierId, orgId])))) throw new LeaseError(404, 'No such supplier.');
  }
  const startMonth = String(b.startMonth ?? '');
  if (!MONTH_RE.test(startMonth)) throw new LeaseError(422, 'startMonth is YYYY-MM.');
  const term = Number(b.termMonths);
  if (!Number.isInteger(term) || term < 1 || term > 600) throw new LeaseError(422, 'termMonths is 1 to 600.');
  const frequency = String(b.frequency ?? 'monthly');
  if (!(frequency in PERIOD)) throw new LeaseError(422, 'frequency is monthly, quarterly or yearly.');
  if (term % PERIOD[frequency]! !== 0) throw new LeaseError(422, `A ${frequency} lease runs a whole number of periods (termMonths a multiple of ${PERIOD[frequency]}).`);
  const timing = String(b.timing ?? 'advance');
  if (timing !== 'advance' && timing !== 'arrears') throw new LeaseError(422, 'timing is advance or arrears.');
  const payment = Number(b.payment);
  if (!Number.isInteger(payment) || payment <= 0) throw new LeaseError(422, 'payment is a whole amount of the minor unit, above 0 (each period).');
  const rate = Number(b.ratePct);
  if (!Number.isFinite(rate) || rate < 0 || rate > 50) throw new LeaseError(422, 'ratePct (the discount rate, a year) is 0 to 50.');
  const idc = b.directCosts == null || b.directCosts === '' ? 0 : Number(b.directCosts);
  if (!Number.isInteger(idc) || idc < 0) throw new LeaseError(422, 'directCosts is a whole amount, 0 or more.');
  let exempt = b.exempt == null || b.exempt === '' ? null : String(b.exempt);
  if (exempt && exempt !== 'short_term' && exempt !== 'low_value') throw new LeaseError(422, 'exempt is short_term or low_value.');
  if (exempt === 'short_term' && term > 12) throw new LeaseError(422, 'A short-term lease runs 12 months or less.');
  if (!exempt && term <= 12 && b.exempt !== false) exempt = 'short_term';
  await assertOpen(orgId, startMonth, 'A lease', ERR);
  const r = await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO lease (org_id, description, site_id, supplier_id, currency, start_month, term_months, payment_minor, frequency, timing, rate_pct, direct_costs_minor, exempt, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [orgId, description, siteId, supplierId, currency, startMonth, term, payment, frequency, timing, rate, idc, exempt, userId]));
  return get(orgId, String(r!.id), now);
}

export async function endEarly(orgId: string, id: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const r = await row(orgId, id);
  if (r.voided_at) throw new LeaseError(409, 'The lease is voided.');
  if (r.ended_month) throw new LeaseError(409, 'The lease has already ended.');
  const month = String(b.month ?? '');
  const t = termsOf(r);
  if (!MONTH_RE.test(month) || month <= t.startMonth || month > addMonths(t.startMonth, t.termMonths - 1)) throw new LeaseError(422, 'month is the first month the lease no longer runs (YYYY-MM), within its term.');
  if (month > addMonths(thisMonth(now), 1)) throw new LeaseError(422, 'month is not more than next month.');
  const note = String(b.note ?? '').trim();
  if (note.length < 3) throw new LeaseError(422, 'Say why it ended (at least 3 characters).');
  await assertOpen(orgId, month, 'An early end', ERR);
  await outsideRequestScope(() => query(`UPDATE lease SET ended_month = $3, end_note = $4 WHERE id = $1 AND org_id = $2`, [id, orgId, month, note.slice(0, 300)]));
  void userId;
  return get(orgId, id, now);
}

export async function voidLease(orgId: string, id: string, reasonRaw: unknown, userId: string | null) {
  const r = await row(orgId, id);
  if (r.voided_at) throw new LeaseError(409, 'The lease is already voided.');
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 3) throw new LeaseError(422, 'Give a reason (at least 3 characters).');
  const run = await outsideRequestScope(() => one<{ month: string }>(`SELECT month FROM lease_run WHERE org_id = $1 AND currency = $2 AND month >= $3 ORDER BY month LIMIT 1`, [orgId, r.currency, r.start_month]));
  if (run) throw new LeaseError(409, `It is in the recorded lease journal for ${run.month}: end it instead.`);
  await outsideRequestScope(() => query(`UPDATE lease SET voided_at = now(), voided_by = $3, void_reason = $4 WHERE id = $1 AND org_id = $2`, [id, orgId, userId, reason.slice(0, 300)]));
  return { id, voided: true };
}

export interface JournalLine { currency: string; code: string; account: string; debit: number; credit: number; description: string }

export async function journal(orgId: string, monthRaw: unknown, now = new Date()) {
  const month = monthRaw == null || monthRaw === '' ? addMonths(thisMonth(now), -1) : String(monthRaw);
  if (!MONTH_RE.test(month)) throw new LeaseError(422, 'month is YYYY-MM.');
  const [rows, runs] = await Promise.all([
    outsideRequestScope(() => many<any>(`${SELECT} WHERE l.org_id = $1 AND l.voided_at IS NULL`, [orgId])),
    outsideRequestScope(() => many<any>(`SELECT r.*, u.name AS by_name FROM lease_run r LEFT JOIN app_user u ON u.id = r.recorded_by WHERE r.org_id = $1 AND r.month = $2`, [orgId, month])),
  ]);
  const cur: Record<string, { lines: JournalLine[]; recognised: number; interest: number; depreciation: number; payments: number; expense: number; gainLoss: number }> = {};
  for (const r of rows) {
    const t = termsOf(r);
    const s = schedule(t);
    const c = (cur[r.currency] ??= { lines: [], recognised: 0, interest: 0, depreciation: 0, payments: 0, expense: 0, gainLoss: 0 });
    const L = (k: AccountKey, debit: number, credit: number, d: string) => { if (debit || credit) c.lines.push({ currency: r.currency, code: ACCOUNTS[k].code, account: ACCOUNTS[k].name, debit, credit, description: `${r.description}: ${d}` }); };
    if (!t.exempt && month === t.startMonth) { L('rou', s.rou, 0, 'right-of-use asset'); L('liability', 0, s.liability, 'lease liability'); if (t.directCosts) L('bank', 0, t.directCosts, 'initial direct costs'); c.recognised += s.liability; }
    const x = s.rows.find((y) => y.month === month);
    if (x) {
      if (t.exempt) {
        L('expense', x.expense, 0, 'lease expense'); L('accrued', 0, x.expense, 'lease expense');
        if (x.payment) { L('accrued', x.payment, 0, 'payment'); L('bank', 0, x.payment, 'payment'); }
        c.expense += x.expense; c.payments += x.payment;
      } else {
        L('depreciation', x.depreciation, 0, 'ROU depreciation'); L('rouAccumulated', 0, x.depreciation, 'ROU depreciation');
        L('interest', x.interest, 0, 'interest'); L('liability', 0, x.interest, 'interest');
        if (x.payment) { L('liability', x.payment, 0, 'payment'); L('bank', 0, x.payment, 'payment'); }
        c.depreciation += x.depreciation; c.interest += x.interest; c.payments += x.payment;
      }
    }
    if (!t.exempt && t.endedMonth === month && s.rows.length) {
      const last = s.rows[s.rows.length - 1]!;
      const accumulated = s.rou - last.rouNbv;
      const gl = last.closing - last.rouNbv;
      L('liability', last.closing, 0, 'ended early'); L('rouAccumulated', accumulated, 0, 'ended early'); L('rou', 0, s.rou, 'ended early');
      if (gl > 0) L('gain', 0, gl, 'gain on ending'); if (gl < 0) L('loss', -gl, 0, 'loss on ending');
      c.gainLoss += gl;
    }
  }
  const currencies = Object.entries(cur).filter(([, c]) => c.lines.length).map(([currency, c]) => {
    const run = runs.find((x) => x.currency === currency);
    const debit = c.lines.reduce((a, l) => a + l.debit, 0), credit = c.lines.reduce((a, l) => a + l.credit, 0);
    return { currency, recognised: c.recognised, interest: c.interest, depreciation: c.depreciation, payments: c.payments, expense: c.expense, gainLoss: c.gainLoss, lines: c.lines, debit, credit,
      recorded: run ? { at: new Date(run.recorded_at).toISOString(), by: run.by_name ?? null, changedSince: Number(run.data?.debit ?? -1) !== debit } : null };
  });
  return { month, currencies };
}

export async function record(orgId: string, monthRaw: unknown, userId: string | null, now = new Date()) {
  const month = String(monthRaw ?? '');
  if (!MONTH_RE.test(month)) throw new LeaseError(422, 'month is YYYY-MM.');
  if (month >= thisMonth(now)) throw new LeaseError(422, 'Record a month once it has ended.');
  await assertOpen(orgId, month, 'The lease journal', ERR);
  const j = await journal(orgId, month, now);
  if (!j.currencies.length) throw new LeaseError(422, `No lease entries in ${month}.`);
  for (const c of j.currencies) {
    await outsideRequestScope(() => query(
      `INSERT INTO lease_run (org_id, month, currency, data, recorded_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, month, currency) DO UPDATE SET data = EXCLUDED.data, recorded_by = EXCLUDED.recorded_by, recorded_at = now()`,
      [orgId, month, c.currency, JSON.stringify({ debit: c.debit, interest: c.interest, depreciation: c.depreciation, payments: c.payments, expense: c.expense, gainLoss: c.gainLoss, lines: c.lines }), userId]));
  }
  return { month, recorded: j.currencies.map((c) => ({ currency: c.currency, interest: c.interest, depreciation: c.depreciation, payments: c.payments, expense: c.expense })) };
}

/** Lease payments falling due between two days (the first of the month in advance, the last in arrears). */
export async function paymentsDue(orgId: string, from: string, to: string) {
  const rows = await outsideRequestScope(() => many<any>(`SELECT * FROM lease WHERE org_id = $1 AND voided_at IS NULL`, [orgId]));
  const out: Array<{ day: string; currency: string; amount: number; label: string }> = [];
  for (const r of rows) {
    const t = termsOf(r);
    for (let k = 0; k < t.termMonths; k++) {
      if (!paysIn(t, k)) continue;
      const m = addMonths(t.startMonth, k);
      if (t.endedMonth && m >= t.endedMonth) break;
      const day = t.timing === 'advance' ? `${m}-01` : lastDay(m);
      if (day >= from && day <= to) out.push({ day, currency: r.currency, amount: t.payment, label: `Lease · ${r.description}` });
    }
  }
  return out;
}

export function leasesXlsx(l: Awaited<ReturnType<typeof list>>, j: Awaited<ReturnType<typeof journal>>): Buffer {
  return xlsx([
    { name: 'Leases', rows: [['Lease', 'Site', 'Currency', 'Start', 'End', 'Payment', 'Frequency', 'Timing', 'Rate %', 'Exempt', 'Initial liability', 'Liability', 'Current', 'Non-current', 'ROU net book value', 'Status'],
      ...l.leases.filter((x) => x.status !== 'voided').map((x) => [x.description, x.site ?? '', x.currency, x.startMonth, x.endMonth, x.payment, x.frequency, x.timing, x.ratePct, x.exempt ?? '', x.initialLiability, x.position.liability, x.position.current, x.position.nonCurrent, x.position.rouNbv, x.status])],
      widths: [30, 20, 8, 9, 9, 14, 10, 9, 7, 10, 16, 16, 14, 14, 16, 10], formats: [null, null, null, null, null, 'int', null, null, null, null, 'int', 'int', 'int', 'int', 'int', null] },
    { name: `Journal ${j.month}`, rows: [['Currency', 'Code', 'Account', 'Debit', 'Credit', 'Description'], ...j.currencies.flatMap((c) => c.lines.map((x) => [x.currency, x.code, x.account, x.debit, x.credit, x.description]))],
      widths: [8, 10, 40, 14, 14, 50], formats: [null, null, null, 'int', 'int', null] },
  ]);
}

export { monthsBetween };
