import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { assertOpen } from './finance-periods.js';
import { position } from './cash-position.js';
import { PdfDoc, Flow } from './pdf.js';
import { xlsx } from './xlsx.js';

/**
 * Investor and lender reporting (v1.34.0).
 *
 *   loans       a facility from a lender: currency, amount, rate, start, term, grace months (interest only), repayment
 *               (annuity, equal principal or bullet), the bank account it runs through. Drawdowns (up to the facility)
 *               and payments (principal, interest, fees); the balance; repaid when nothing is left. The schedule: from the
 *               amount drawn, month by month, interest at rate ÷ 12 on the balance. The ledger: drawdowns Dr bank / Cr 2500
 *               loans; payments Dr 2500 (principal), 7210 (interest), 7215 (fees) / Cr bank. The cash position counts them.
 *   covenants   per loan (or overall), tested on a month over the twelve months to its end, from the ledger and the loans:
 *                 dscr            EBITDA ÷ debt service (principal + interest paid)                      at least
 *                 interest_cover  EBITDA ÷ interest paid                                                  at least
 *                 leverage        loans outstanding ÷ EBITDA                                              at most
 *                 min_cash        the cash position at the month's end                                    at least
 *               EBITDA = revenue − expenses + depreciation (6400, 6410), from the posted ledger (sync the months first).
 *               Each test is kept with its headroom; a breach raises finance.covenant_breach (critical), less than 10%
 *               headroom a warning. Monthly or quarterly (March, June, September, December), tested by the worker.
 *   pack        the lender pack (PDF and Excel): loans and their schedules, the covenants' last tests, the twelve months'
 *               results
 */

export class LenderError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const BREACH = 'finance.covenant_breach';
export const COVENANTS = { dscr: 'min', interest_cover: 'min', leverage: 'max', min_cash: 'min' } as const;
export type CovenantKind = keyof typeof COVENANTS;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const thisMonth = (now = new Date()) => today(now).slice(0, 7);
const addMonths = (m: string, n: number) => { const [y, mo] = m.split('-').map(Number) as [number, number]; const t = y * 12 + (mo - 1) + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const addMonthsDay = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
const lastDay = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`; };
const ERR = (s: number, m: string) => new LenderError(s, m);
const r2 = (n: number) => Math.round(n * 100) / 100;

/** The repayment schedule of `principal` (pure). */
export function schedule(principal: number, ratePct: number, start: string, term: number, grace: number, kind: 'annuity' | 'equal_principal' | 'bullet') {
  const r = ratePct / 100 / 12;
  const n = Math.max(1, term - grace);
  const pmt = kind === 'annuity' ? (r ? (principal * r) / (1 - (1 + r) ** -n) : principal / n) : 0;
  let bal = principal;
  const rows: Array<{ k: number; due: string; opening: number; interest: number; principal: number; payment: number; closing: number }> = [];
  for (let k = 1; k <= term; k++) {
    const interest = Math.round(bal * r);
    let p = 0;
    if (k > grace) {
      if (kind === 'annuity') p = Math.round(pmt - interest);
      else if (kind === 'equal_principal') p = Math.round(principal / n);
      else p = k === term ? bal : 0;
      if (k === term) p = bal;
      p = Math.min(p, bal);
    }
    rows.push({ k, due: addMonthsDay(start, k), opening: bal, interest, principal: p, payment: interest + p, closing: bal - p });
    bal -= p;
  }
  return rows;
}

const LOAN_SELECT = `SELECT l.*, to_char(l.start_on, 'YYYY-MM-DD') AS start_s, a.name AS account_name,
    (SELECT COALESCE(sum(amount_minor), 0) FROM loan_drawdown d WHERE d.loan_id = l.id AND d.voided_at IS NULL)::bigint AS drawn,
    (SELECT COALESCE(sum(principal_minor), 0) FROM loan_payment p WHERE p.loan_id = l.id AND p.voided_at IS NULL)::bigint AS repaid,
    (SELECT COALESCE(sum(interest_minor), 0) FROM loan_payment p WHERE p.loan_id = l.id AND p.voided_at IS NULL)::bigint AS interest_paid
  FROM loan l LEFT JOIN cash_account a ON a.id = l.cash_account_id`;
const loanView = (l: any) => ({
  id: String(l.id), lender: l.lender, reference: l.reference ?? null, currency: l.currency, facility: Number(l.facility_minor), ratePct: Number(l.rate_pct), startOn: l.start_s,
  termMonths: l.term_months, graceMonths: l.grace_months, repayment: l.repayment, cashAccountId: l.cash_account_id == null ? null : String(l.cash_account_id), cashAccount: l.account_name ?? null,
  status: l.status, note: l.note ?? null, drawn: Number(l.drawn), repaid: Number(l.repaid), interestPaid: Number(l.interest_paid), balance: Number(l.drawn) - Number(l.repaid), undrawn: Number(l.facility_minor) - Number(l.drawn),
});

export async function loans(orgId: string) {
  return (await outsideRequestScope(() => many<any>(`${LOAN_SELECT} WHERE l.org_id = $1 ORDER BY (l.status = 'active') DESC, l.start_on DESC`, [orgId]))).map(loanView);
}

async function loanRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new LenderError(404, 'No such loan.');
  const r = await outsideRequestScope(() => one<any>(`${LOAN_SELECT} WHERE l.id = $1 AND l.org_id = $2`, [id, orgId]));
  if (!r) throw new LenderError(404, 'No such loan.');
  return r;
}

export async function get(orgId: string, id: string) {
  const l = loanView(await loanRow(orgId, id));
  const [dd, pp] = await Promise.all([
    outsideRequestScope(() => many<any>(`SELECT id, to_char(on_date, 'YYYY-MM-DD') AS d, amount_minor, reference, voided_at FROM loan_drawdown WHERE loan_id = $1 ORDER BY on_date, id`, [id])),
    outsideRequestScope(() => many<any>(`SELECT id, to_char(on_date, 'YYYY-MM-DD') AS d, principal_minor, interest_minor, fees_minor, reference, voided_at FROM loan_payment WHERE loan_id = $1 ORDER BY on_date, id`, [id])),
  ]);
  return {
    ...l,
    drawdowns: dd.map((d) => ({ id: String(d.id), date: d.d, amount: Number(d.amount_minor), reference: d.reference ?? null, voided: !!d.voided_at })),
    payments: pp.map((p) => ({ id: String(p.id), date: p.d, principal: Number(p.principal_minor), interest: Number(p.interest_minor), fees: Number(p.fees_minor), reference: p.reference ?? null, voided: !!p.voided_at })),
    schedule: schedule(l.drawn || l.facility, l.ratePct, l.startOn, l.termMonths, l.graceMonths, l.repayment),
  };
}

export async function saveLoan(orgId: string, id: string | null, b: Record<string, unknown>, userId: string | null) {
  const cur = id ? await loanRow(orgId, id) : null;
  const v = (k: string, col: string) => (b[k] === undefined && cur ? cur[col] : b[k]);
  const lender = String(v('lender', 'lender') ?? '').trim();
  if (lender.length < 2 || lender.length > 120) throw new LenderError(422, 'lender is 2 to 120 characters.');
  const currency = String(v('currency', 'currency') ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new LenderError(422, 'currency is an ISO code.');
  const facility = Number(v('facility', 'facility_minor'));
  if (!Number.isInteger(facility) || facility <= 0) throw new LenderError(422, 'facility is a whole amount above 0.');
  if (cur && facility < Number(cur.drawn)) throw new LenderError(422, 'The facility cannot be below what is drawn.');
  const rate = Number(v('ratePct', 'rate_pct'));
  if (!Number.isFinite(rate) || rate < 0 || rate > 50) throw new LenderError(422, 'ratePct is 0 to 50.');
  const start = String(v('startOn', 'start_s') ?? '');
  if (!DATE_RE.test(start)) throw new LenderError(422, 'startOn is YYYY-MM-DD.');
  const term = Number(v('termMonths', 'term_months')), grace = Number(v('graceMonths', 'grace_months') ?? 0);
  if (!Number.isInteger(term) || term < 1 || term > 360) throw new LenderError(422, 'termMonths is 1 to 360.');
  if (!Number.isInteger(grace) || grace < 0 || grace >= term) throw new LenderError(422, 'graceMonths is 0 or more, below the term.');
  const repayment = String(v('repayment', 'repayment') ?? 'annuity');
  if (!['annuity', 'equal_principal', 'bullet'].includes(repayment)) throw new LenderError(422, 'repayment is annuity, equal_principal or bullet.');
  const acct = v('cashAccountId', 'cash_account_id') == null || v('cashAccountId', 'cash_account_id') === '' ? null : String(v('cashAccountId', 'cash_account_id'));
  if (acct) {
    const a = await outsideRequestScope(() => one<any>(`SELECT currency FROM cash_account WHERE id = $1 AND org_id = $2`, [acct, orgId]));
    if (!a || a.currency !== currency) throw new LenderError(422, 'cashAccountId is a cash account in the loan\'s currency.');
  }
  const p = [orgId, lender, v('reference', 'reference') ? String(v('reference', 'reference')).slice(0, 80) : null, currency, facility, rate, start, term, grace, repayment, acct, v('note', 'note') ? String(v('note', 'note')).slice(0, 500) : null];
  const r = cur
    ? await outsideRequestScope(() => one<any>(`UPDATE loan SET lender = $2, reference = $3, currency = $4, facility_minor = $5, rate_pct = $6, start_on = $7, term_months = $8, grace_months = $9, repayment = $10, cash_account_id = $11, note = $12
        WHERE org_id = $1 AND id = $13 RETURNING id`, [...p, cur.id]))
    : await outsideRequestScope(() => one<any>(`INSERT INTO loan (org_id, lender, reference, currency, facility_minor, rate_pct, start_on, term_months, grace_months, repayment, cash_account_id, note, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`, [...p, userId]));
  return get(orgId, String(r.id));
}

export async function drawdown(orgId: string, id: string, b: Record<string, unknown>, userId: string | null) {
  const l = loanView(await loanRow(orgId, id));
  if (l.status !== 'active') throw new LenderError(409, `The loan is ${l.status}.`);
  const amount = Number(b.amount);
  if (!Number.isInteger(amount) || amount <= 0) throw new LenderError(422, 'amount is a whole amount above 0.');
  if (amount > l.undrawn) throw new LenderError(422, `Only ${l.undrawn} of the facility is undrawn.`);
  const on = String(b.onDate ?? today());
  if (!DATE_RE.test(on)) throw new LenderError(422, 'onDate is YYYY-MM-DD.');
  await assertOpen(orgId, on.slice(0, 7), 'A drawdown', ERR);
  await outsideRequestScope(() => query(`INSERT INTO loan_drawdown (org_id, loan_id, on_date, amount_minor, reference, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
    [orgId, l.id, on, amount, b.reference ? String(b.reference).slice(0, 80) : null, userId]));
  return get(orgId, id);
}

export async function pay(orgId: string, id: string, b: Record<string, unknown>, userId: string | null) {
  const l = loanView(await loanRow(orgId, id));
  if (l.status !== 'active') throw new LenderError(409, `The loan is ${l.status}.`);
  const n = (k: string) => { const x = b[k] == null || b[k] === '' ? 0 : Number(b[k]); if (!Number.isInteger(x) || x < 0) throw new LenderError(422, `${k} is a whole amount, 0 or more.`); return x; };
  const principal = n('principal'), interest = n('interest'), fees = n('fees');
  if (!principal && !interest && !fees) throw new LenderError(422, 'A payment has principal, interest or fees.');
  if (principal > l.balance) throw new LenderError(422, `The balance is ${l.balance}.`);
  const on = String(b.onDate ?? today());
  if (!DATE_RE.test(on)) throw new LenderError(422, 'onDate is YYYY-MM-DD.');
  await assertOpen(orgId, on.slice(0, 7), 'A loan payment', ERR);
  await outsideRequestScope(() => query(`INSERT INTO loan_payment (org_id, loan_id, on_date, principal_minor, interest_minor, fees_minor, reference, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [orgId, l.id, on, principal, interest, fees, b.reference ? String(b.reference).slice(0, 80) : null, userId]));
  if (principal === l.balance && l.drawn >= l.facility) await outsideRequestScope(() => query(`UPDATE loan SET status = 'repaid' WHERE id = $1`, [l.id]));
  return get(orgId, id);
}

/** For the cash position: drawdowns into and payments out of the loan's account. */
export async function cashMoves(orgId: string, upTo: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT l.cash_account_id::text AS a, to_char(d.on_date, 'YYYY-MM-DD') AS d, d.amount_minor AS amt FROM loan_drawdown d JOIN loan l ON l.id = d.loan_id WHERE d.org_id = $1 AND d.voided_at IS NULL AND l.cash_account_id IS NOT NULL AND d.on_date <= $2::date
     UNION ALL
     SELECT l.cash_account_id::text, to_char(p.on_date, 'YYYY-MM-DD'), -(p.principal_minor + p.interest_minor + p.fees_minor) FROM loan_payment p JOIN loan l ON l.id = p.loan_id WHERE p.org_id = $1 AND p.voided_at IS NULL AND l.cash_account_id IS NOT NULL AND p.on_date <= $2::date`, [orgId, upTo]));
  return rows.map((r) => ({ account_id: r.a as string, d: r.d as string, amount: Number(r.amt) }));
}

// ─────────────────────────────────────────── covenants

const covView = (c: any) => ({ id: String(c.id), loanId: c.loan_id == null ? null : String(c.loan_id), lender: c.lender ?? null, kind: c.kind as CovenantKind, threshold: Number(c.threshold), currency: c.currency,
  frequency: c.frequency, enabled: c.enabled, note: c.note ?? null, direction: COVENANTS[c.kind as CovenantKind] });

export async function covenants(orgId: string) {
  const cs = await outsideRequestScope(() => many<any>(`SELECT c.*, l.lender FROM covenant c LEFT JOIN loan l ON l.id = c.loan_id WHERE c.org_id = $1 ORDER BY c.id`, [orgId]));
  const tests = await outsideRequestScope(() => many<any>(`SELECT * FROM covenant_test WHERE org_id = $1 ORDER BY month DESC LIMIT 500`, [orgId]));
  return cs.map((c) => ({ ...covView(c), tests: tests.filter((t) => String(t.covenant_id) === String(c.id)).slice(0, 12).map((t) => ({ month: t.month, value: t.value == null ? null : Number(t.value), passed: t.passed, headroomPct: t.headroom_pct == null ? null : Number(t.headroom_pct), detail: t.detail })) }));
}

export async function saveCovenant(orgId: string, id: string | null, b: Record<string, unknown>) {
  const kind = String(b.kind ?? '');
  if (!(kind in COVENANTS)) throw new LenderError(422, `kind is ${Object.keys(COVENANTS).join(', ')}.`);
  const threshold = Number(b.threshold);
  if (!Number.isFinite(threshold) || threshold < 0) throw new LenderError(422, 'threshold is a number, 0 or more.');
  const currency = String(b.currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new LenderError(422, 'currency is an ISO code.');
  const loanId = b.loanId == null || b.loanId === '' ? null : String(b.loanId);
  if (loanId) await loanRow(orgId, loanId);
  const freq = String(b.frequency ?? 'quarterly');
  if (!['monthly', 'quarterly'].includes(freq)) throw new LenderError(422, 'frequency is monthly or quarterly.');
  const enabled = b.enabled === undefined ? true : b.enabled === true || b.enabled === 'true';
  const p = [orgId, loanId, kind, threshold, currency, freq, enabled, b.note ? String(b.note).slice(0, 300) : null];
  const r = id
    ? await outsideRequestScope(() => one<any>(`UPDATE covenant SET loan_id = $2, kind = $3, threshold = $4, currency = $5, frequency = $6, enabled = $7, note = $8 WHERE org_id = $1 AND id = $9 RETURNING id`, [...p, id]))
    : await outsideRequestScope(() => one<any>(`INSERT INTO covenant (org_id, loan_id, kind, threshold, currency, frequency, enabled, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, p));
  if (!r) throw new LenderError(404, 'No such covenant.');
  return (await covenants(orgId)).find((c) => c.id === String(r.id))!;
}

/** The twelve months to a month's end, in a currency: EBITDA, interest and debt service paid, loans outstanding, cash. */
export async function measures(orgId: string, month: string, currency: string, now = new Date()) {
  const from = addMonths(month, -11);
  const led = await outsideRequestScope(() => one<any>(
    `SELECT COALESCE(sum(CASE WHEN a.type = 'revenue' THEN l.credit - l.debit ELSE 0 END), 0) AS revenue,
            COALESCE(sum(CASE WHEN a.type = 'expense' THEN l.debit - l.credit ELSE 0 END), 0) AS expenses,
            COALESCE(sum(CASE WHEN l.account_code IN ('6400', '6410') THEN l.debit - l.credit ELSE 0 END), 0) AS depreciation
       FROM gl_line l JOIN gl_entry e ON e.id = l.entry_id LEFT JOIN gl_account a ON a.org_id = l.org_id AND a.code = l.account_code
      WHERE e.org_id = $1 AND e.status = 'posted' AND e.currency = $2 AND e.month BETWEEN $3 AND $4`, [orgId, currency, from, month]));
  const pays = await outsideRequestScope(() => one<any>(
    `SELECT COALESCE(sum(p.principal_minor), 0)::bigint AS principal, COALESCE(sum(p.interest_minor), 0)::bigint AS interest FROM loan_payment p JOIN loan l ON l.id = p.loan_id
      WHERE p.org_id = $1 AND l.currency = $2 AND p.voided_at IS NULL AND to_char(p.on_date, 'YYYY-MM') BETWEEN $3 AND $4`, [orgId, currency, from, month]));
  const debt = await outsideRequestScope(() => one<any>(
    `SELECT (SELECT COALESCE(sum(d.amount_minor), 0) FROM loan_drawdown d JOIN loan l ON l.id = d.loan_id WHERE d.org_id = $1 AND l.currency = $2 AND d.voided_at IS NULL AND d.on_date <= $3::date)
          - (SELECT COALESCE(sum(p.principal_minor), 0) FROM loan_payment p JOIN loan l ON l.id = p.loan_id WHERE p.org_id = $1 AND l.currency = $2 AND p.voided_at IS NULL AND p.on_date <= $3::date) AS debt`, [orgId, currency, lastDay(month)]));
  const end = lastDay(month) < today(now) ? lastDay(month) : today(now);
  const pos = await position(orgId, { date: end }, now).catch(() => null);
  const revenue = r2(Number(led?.revenue ?? 0)), expenses = r2(Number(led?.expenses ?? 0)), depreciation = r2(Number(led?.depreciation ?? 0));
  const ebitda = r2(revenue - expenses + depreciation);
  const interest = Number(pays?.interest ?? 0), principal = Number(pays?.principal ?? 0);
  return { from, to: month, currency, revenue, expenses, depreciation, ebitda, interest, debtService: interest + principal, debt: Number(debt?.debt ?? 0), cash: pos?.totals[currency]?.total ?? 0 };
}

/** The covenant's value from the measures, whether it passes, and the headroom (% of the threshold). */
export function evaluate(kind: CovenantKind, threshold: number, m: { ebitda: number; interest: number; debtService: number; debt: number; cash: number }) {
  const v = kind === 'dscr' ? (m.debtService ? m.ebitda / m.debtService : null)
    : kind === 'interest_cover' ? (m.interest ? m.ebitda / m.interest : null)
      : kind === 'leverage' ? (m.ebitda > 0 ? m.debt / m.ebitda : m.debt > 0 ? Infinity : 0)
        : m.cash;
  if (v == null) return { value: null, passed: null, headroomPct: null };
  const passed = COVENANTS[kind] === 'min' ? v >= threshold : v <= threshold;
  const headroom = threshold ? (COVENANTS[kind] === 'min' ? (v - threshold) / threshold : (threshold - v) / threshold) * 100 : null;
  return { value: Number.isFinite(v) ? Math.round(v * 10_000) / 10_000 : null, passed, headroomPct: headroom == null || !Number.isFinite(headroom) ? null : Math.round(headroom * 100) / 100 };
}

export async function test(orgId: string, monthRaw: unknown, now = new Date()) {
  const month = String(monthRaw ?? '');
  if (!MONTH_RE.test(month) || month > thisMonth(now)) throw new LenderError(422, 'month is YYYY-MM, not in the future.');
  const cs = await outsideRequestScope(() => many<any>(`SELECT c.*, l.lender FROM covenant c LEFT JOIN loan l ON l.id = c.loan_id WHERE c.org_id = $1 AND c.enabled`, [orgId]));
  const out = [];
  const cache = new Map<string, Awaited<ReturnType<typeof measures>>>();
  for (const c of cs) {
    const m = cache.get(c.currency) ?? (await measures(orgId, month, c.currency, now));
    cache.set(c.currency, m);
    const e = evaluate(c.kind, Number(c.threshold), m);
    await outsideRequestScope(() => query(
      `INSERT INTO covenant_test (org_id, covenant_id, month, value, passed, headroom_pct, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (covenant_id, month) DO UPDATE SET value = EXCLUDED.value, passed = EXCLUDED.passed, headroom_pct = EXCLUDED.headroom_pct, detail = EXCLUDED.detail, tested_at = now()`,
      [orgId, c.id, month, e.value, e.passed, e.headroomPct, JSON.stringify(m)]));
    const target = `covenant:${c.id}`;
    if (e.passed === false || (e.passed && e.headroomPct != null && e.headroomPct < 10)) {
      await outsideRequestScope(() => persistAlert({ orgId, kind: BREACH, severity: e.passed === false ? 'critical' : 'warning', targetType: 'covenant', targetId: target,
        message: `${c.lender ?? 'Overall'} ${c.kind} for ${month}: ${e.value ?? '—'} against ${COVENANTS[c.kind as CovenantKind] === 'min' ? 'at least' : 'at most'} ${Number(c.threshold)}${e.passed === false ? ' — BREACHED' : ` (headroom ${e.headroomPct}%)`}. Finance → Lenders.` })).catch(() => null);
    } else await outsideRequestScope(() => resolveAlertsFor(orgId, BREACH, 'covenant', target)).catch(() => 0);
    out.push({ ...covView(c), month, ...e, measures: m });
  }
  return { month, results: out };
}

/** Monthly: last month's tests (quarterly covenants on March, June, September and December), once. */
export async function sweep(now = new Date()): Promise<number> {
  const m = addMonths(thisMonth(now), -1);
  const quarter = ['03', '06', '09', '12'].includes(m.slice(5));
  const due = await outsideRequestScope(() => many<{ org_id: string }>(
    `SELECT DISTINCT c.org_id FROM covenant c WHERE c.enabled AND (c.frequency = 'monthly' OR $2::boolean) AND NOT EXISTS (SELECT 1 FROM covenant_test t WHERE t.covenant_id = c.id AND t.month = $1)`, [m, quarter]));
  let n = 0;
  for (const { org_id } of due) {
    try { n += (await test(org_id, m, now)).results.length; } catch (e) { logger.warn({ org: org_id, err: (e as Error).message }, 'covenant sweep failed'); }
  }
  return n;
}

// ─────────────────────────────────────────── the lender pack

export async function pack(orgId: string, monthRaw: unknown, now = new Date()) {
  const month = monthRaw ? String(monthRaw) : addMonths(thisMonth(now), -1);
  if (!MONTH_RE.test(month)) throw new LenderError(422, 'month is YYYY-MM.');
  const ls = await loans(orgId);
  const full = [];
  for (const l of ls.filter((x) => x.status !== 'void')) full.push(await get(orgId, l.id));
  const cs = await covenants(orgId);
  const curs = [...new Set([...ls.map((l) => l.currency), ...cs.map((c) => c.currency)])];
  const ms = [];
  for (const c of curs) ms.push(await measures(orgId, month, c, now));
  return { month, loans: full, covenants: cs, measures: ms };
}

const fmt = (n: number | null | undefined, cur?: string) => (n == null ? '—' : `${cur ? `${cur} ` : ''}${Math.round(n).toLocaleString('en-US')}`);

export async function packPdf(orgId: string, monthRaw: unknown): Promise<Buffer> {
  const p = await pack(orgId, monthRaw);
  const org = await outsideRequestScope(() => one<{ name: string }>(`SELECT name FROM organisation WHERE id = $1`, [orgId]));
  const doc = new PdfDoc({ title: `Lender pack ${p.month}`, author: org?.name ?? 'PlugSure CSMS', subject: 'Lender report', created: new Date() });
  const f = new Flow(doc);
  f.para(`${org?.name ?? ''}: lender report, ${p.month}`, { size: 16, bold: true });
  f.para('Twelve months to the month\'s end, from the posted ledger and the loans.', { size: 9, color: [0.36, 0.39, 0.44] });
  for (const m of p.measures) {
    f.heading(`Results · ${m.currency} (${m.from} to ${m.to})`);
    f.row('Revenue', fmt(m.revenue, m.currency)); f.row('Expenses', fmt(m.expenses, m.currency)); f.row('Depreciation added back', fmt(m.depreciation, m.currency));
    f.row('EBITDA', fmt(m.ebitda, m.currency), { bold: true }); f.row('Interest paid', fmt(m.interest, m.currency)); f.row('Debt service', fmt(m.debtService, m.currency));
    f.row('Loans outstanding', fmt(m.debt, m.currency)); f.row('Cash at the month\'s end', fmt(m.cash, m.currency));
  }
  if (p.covenants.length) {
    f.heading('Covenants');
    f.table([{ label: 'Covenant', width: 3 }, { label: 'Threshold', width: 1.6, align: 'right' }, { label: p.month, width: 1.6, align: 'right' }, { label: 'Headroom', width: 1.4, align: 'right' }, { label: '', width: 1.2 }],
      p.covenants.map((c) => { const t = c.tests.find((x) => x.month === p.month); return { cells: [`${c.lender ?? 'Overall'} · ${c.kind}`, `${c.direction === 'min' ? '≥' : '≤'} ${c.threshold}`, t?.value == null ? '—' : String(t.value), t?.headroomPct == null ? '—' : `${t.headroomPct}%`, t ? (t.passed === false ? 'BREACH' : t.passed ? 'met' : '—') : 'not tested'] }; }));
  }
  for (const l of p.loans) {
    f.heading(`${l.lender}${l.reference ? ` · ${l.reference}` : ''}`);
    f.row('Facility / drawn / balance', `${fmt(l.facility, l.currency)} / ${fmt(l.drawn)} / ${fmt(l.balance)}`);
    f.row('Rate, term, repayment', `${l.ratePct}% · ${l.termMonths} months (${l.graceMonths} grace) · ${l.repayment.replace('_', ' ')}`);
    f.table([{ label: 'Due', width: 1.6 }, { label: 'Interest', width: 1.6, align: 'right' }, { label: 'Principal', width: 1.6, align: 'right' }, { label: 'Balance', width: 1.8, align: 'right' }],
      l.schedule.filter((s) => s.due >= `${p.month}-01`).slice(0, 12).map((s) => ({ cells: [s.due, fmt(s.interest), fmt(s.principal), fmt(s.closing)] })), { size: 8 });
  }
  return doc.toBuffer();
}

export async function packXlsx(orgId: string, monthRaw: unknown): Promise<Buffer> {
  const p = await pack(orgId, monthRaw);
  return xlsx([
    { name: 'Results', rows: [['Currency', 'From', 'To', 'Revenue', 'Expenses', 'Depreciation', 'EBITDA', 'Interest', 'Debt service', 'Loans', 'Cash'], ...p.measures.map((m) => [m.currency, m.from, m.to, m.revenue, m.expenses, m.depreciation, m.ebitda, m.interest, m.debtService, m.debt, m.cash])],
      widths: [8, 9, 9, 16, 16, 14, 16, 14, 14, 16, 16], formats: [null, null, null, 'money', 'money', 'money', 'money', 'money', 'money', 'money', 'money'] },
    { name: 'Covenants', rows: [['Lender', 'Kind', 'Threshold', 'Month', 'Value', 'Passed', 'Headroom %'], ...p.covenants.flatMap((c) => c.tests.map((t) => [c.lender ?? 'Overall', c.kind, c.threshold, t.month, t.value, t.passed == null ? '' : t.passed ? 'yes' : 'NO', t.headroomPct]))], widths: [24, 14, 10, 9, 12, 8, 10] },
    { name: 'Loans', rows: [['Lender', 'Reference', 'Currency', 'Facility', 'Drawn', 'Repaid', 'Balance', 'Rate %', 'Start', 'Term', 'Repayment'], ...p.loans.map((l) => [l.lender, l.reference ?? '', l.currency, l.facility, l.drawn, l.repaid, l.balance, l.ratePct, l.startOn, l.termMonths, l.repayment])],
      widths: [24, 14, 8, 16, 16, 16, 16, 8, 11, 6, 14], formats: [null, null, null, 'money', 'money', 'money', 'money', null, null, null, null] },
    ...p.loans.slice(0, 10).map((l) => ({ name: `Schedule ${l.id}`, rows: [['Due', 'Opening', 'Interest', 'Principal', 'Payment', 'Closing'], ...l.schedule.map((s) => [s.due, s.opening, s.interest, s.principal, s.payment, s.closing])],
      widths: [11, 16, 14, 14, 14, 16], formats: [null, 'money', 'money', 'money', 'money', 'money'] as Array<'money' | null> })),
  ]);
}
