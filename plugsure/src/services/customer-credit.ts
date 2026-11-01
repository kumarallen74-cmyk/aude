import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { position, check } from './fleet-credit-limits.js';
import { markPaid } from './fleet-billing.js';
import { assertOpen } from './finance-periods.js';

/**
 * Customer credit and security deposits (v1.33.0), for fleet customers billed monthly.
 *
 *   score      0–100 from the last 12 months of invoices in the account's credit currency: the share paid late, the
 *              average days late, what is overdue now (and for how long), how much of the limit is used, and how long
 *              the customer has been billed; a security deposit held softens it. Graded A (85+), B (70+), C (55+),
 *              D (40+), E. The suggested limit is the average monthly billing of the last six months times the grade's
 *              multiple (A 3, B 2, C 1.5, D 1, E 0), plus the deposit, rounded to the 100 000.
 *   review     a review records the score, the factors and the suggestion; a Finance Manager approves it (with the new
 *              limit, a hold or its release, and the next review date — by default 6 months for A and B, 3 for C, 1 for D
 *              and E) or rejects it. Accounts due for review get one opened by the worker (daily), with an alert.
 *   hold       blocks the account's cards (the credit check, v1.24.0), whatever its credit mode, until released
 *   deposits   security deposits received, returned (at most what is held) or applied to an issued invoice (which is
 *              then paid); the balance held per currency. The ledger posts them against customer deposits (2200); the
 *              cash position counts those received into and returned out of a cash account.
 */

export class CustomerCreditError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REVIEW_DUE = 'finance.credit_review_due';
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const addMonthsDay = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
export const MULTIPLE = { A: 3, B: 2, C: 1.5, D: 1, E: 0 } as const;
export const REVIEW_MONTHS = { A: 6, B: 6, C: 3, D: 1, E: 1 } as const;
export type Grade = keyof typeof MULTIPLE;

export interface Factors { invoices: number; paidLatePct: number; avgDaysLate: number; overdue: number; maxDaysOverdue: number; usedPct: number | null; tenureMonths: number; deposit: number; avgMonthly: number }

/** The score and grade from the factors (pure). */
export function scoreOf(f: Factors): { score: number; grade: Grade; reasons: string[] } {
  let s = 100;
  const reasons: string[] = [];
  const hit = (n: number, why: string) => { if (n > 0) { s -= n; reasons.push(`−${Math.round(n)} ${why}`); } };
  hit(Math.round(f.paidLatePct * 0.35), `${f.paidLatePct}% of invoices paid late`);
  hit(Math.round((Math.min(30, f.avgDaysLate) / 30) * 20), `${f.avgDaysLate} days late on average`);
  hit(f.maxDaysOverdue > 30 ? 25 : f.maxDaysOverdue > 0 ? 10 : 0, f.maxDaysOverdue ? `an invoice ${f.maxDaysOverdue} days overdue now` : '');
  hit(f.usedPct != null && f.usedPct >= 90 ? 10 : 0, 'the limit nearly used up');
  hit(f.tenureMonths < 6 ? 5 : 0, 'billed for less than 6 months');
  if (f.deposit > 0 && f.avgMonthly > 0) { const plus = Math.min(10, Math.round((f.deposit / f.avgMonthly) * 5)); s += plus; reasons.push(`+${plus} a security deposit held`); }
  if (!f.invoices) reasons.push('no invoice yet: scored on tenure and deposit only');
  const score = Math.max(0, Math.min(100, Math.round(s)));
  const grade: Grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'E';
  return { score, grade, reasons };
}

export function suggestedLimit(grade: Grade, avgMonthly: number, deposit: number) {
  return Math.round((avgMonthly * MULTIPLE[grade] + deposit) / 100_000) * 100_000;
}

async function accountRow(orgId: string, id: string) {
  if (!UUID_RE.test(id)) throw new CustomerCreditError(404, 'No such fleet account.');
  const a = await outsideRequestScope(() => one<any>(`SELECT *, to_char(next_review_on, 'YYYY-MM-DD') AS next_s FROM fleet_account WHERE id = $1 AND org_id = $2`, [id, orgId]));
  if (!a) throw new CustomerCreditError(404, 'No such fleet account.');
  return a;
}

export async function depositBalance(orgId: string, accountId: string, currency: string) {
  const r = await outsideRequestScope(() => one<{ b: string }>(
    `SELECT COALESCE(sum(CASE WHEN kind = 'received' THEN amount_minor ELSE -amount_minor END), 0)::bigint AS b FROM customer_deposit
      WHERE org_id = $1 AND fleet_account_id = $2 AND currency = $3 AND voided_at IS NULL`, [orgId, accountId, currency]));
  return Number(r?.b ?? 0);
}

/** The factors of an account now. */
export async function factors(orgId: string, accountId: string, now = new Date()): Promise<Factors & { currency: string; limit: number }> {
  const a = await accountRow(orgId, accountId);
  const cur = a.credit_currency as string;
  const t = today(now);
  const inv = await outsideRequestScope(() => many<any>(
    `SELECT total_minor, to_char(due_date, 'YYYY-MM-DD') AS due, to_char(paid_at, 'YYYY-MM-DD') AS paid, status, to_char(issued_at AT TIME ZONE $4, 'YYYY-MM') AS m
       FROM fleet_invoice WHERE org_id = $1 AND fleet_account_id = $2 AND currency = $3 AND status IN ('issued', 'paid') AND issued_at > now() - interval '12 months'`, [orgId, accountId, cur, zone()]));
  const paid = inv.filter((i) => i.status === 'paid' && i.paid);
  const late = paid.filter((i) => i.paid > i.due);
  const open = inv.filter((i) => i.status === 'issued' && i.due < t);
  const m6 = new Set<string>();
  for (let k = 0; k < 6; k++) { const d = new Date(now); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - k - 1); m6.add(d.toISOString().slice(0, 7)); }
  const p = await position(orgId, accountId).catch(() => null);
  const deposit = await depositBalance(orgId, accountId, cur);
  return {
    currency: cur, limit: Number(a.credit_limit_minor),
    invoices: inv.length,
    paidLatePct: paid.length ? Math.round((late.length / paid.length) * 100) : 0,
    avgDaysLate: late.length ? Math.round(late.reduce((s, i) => s + daysBetween(i.due, i.paid), 0) / late.length) : 0,
    overdue: open.reduce((s, i) => s + Number(i.total_minor), 0),
    maxDaysOverdue: open.reduce((m, i) => Math.max(m, daysBetween(i.due, t)), 0),
    usedPct: p?.usedPct ?? null,
    tenureMonths: Math.floor(daysBetween(new Date(a.created_at).toISOString().slice(0, 10), t) / 30),
    deposit,
    avgMonthly: Math.round(inv.filter((i) => m6.has(i.m)).reduce((s, i) => s + Number(i.total_minor), 0) / 6),
  };
}

const reviewView = (r: any) => ({
  id: String(r.id), accountId: r.fleet_account_id, account: r.account_name ?? null, currency: r.currency, score: r.score, grade: r.grade as Grade, factors: r.factors,
  currentLimit: Number(r.current_limit_minor), suggestedLimit: Number(r.suggested_limit_minor), status: r.status,
  newLimit: r.new_limit_minor == null ? null : Number(r.new_limit_minor), hold: r.hold, note: r.note ?? null, nextReviewOn: r.next_s ?? null,
  createdBy: r.created_by_name ?? null, decidedBy: r.decided_by_name ?? null, decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null, createdAt: new Date(r.created_at).toISOString(),
});
const REVIEW_SELECT = `SELECT r.*, to_char(r.next_review_on, 'YYYY-MM-DD') AS next_s, a.name AS account_name, c.name AS created_by_name, d.name AS decided_by_name
  FROM credit_review r JOIN fleet_account a ON a.id = r.fleet_account_id LEFT JOIN app_user c ON c.id = r.created_by LEFT JOIN app_user d ON d.id = r.decided_by`;

/** Every fleet account billed on terms: its grade (last review), limit, hold, deposit, next review. */
export async function overview(orgId: string, now = new Date()) {
  const accts = await outsideRequestScope(() => many<any>(
    `SELECT a.id, a.name, a.credit_mode, a.credit_limit_minor, a.credit_currency, a.credit_hold_at, a.credit_hold_reason, to_char(a.next_review_on, 'YYYY-MM-DD') AS next_s,
            (SELECT row_to_json(x) FROM (SELECT r.id, r.score, r.grade, r.status, r.created_at FROM credit_review r WHERE r.fleet_account_id = a.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) x) AS last
       FROM fleet_account a WHERE a.org_id = $1 AND a.archived_at IS NULL ORDER BY lower(a.name)`, [orgId]));
  const t = today(now);
  const out = [];
  for (const a of accts) {
    out.push({
      id: a.id, name: a.name, mode: a.credit_mode, currency: a.credit_currency, limit: Number(a.credit_limit_minor),
      hold: a.credit_hold_at ? { at: new Date(a.credit_hold_at).toISOString(), reason: a.credit_hold_reason ?? null } : null,
      deposit: await depositBalance(orgId, a.id, a.credit_currency),
      lastReview: a.last ? { id: String(a.last.id), score: a.last.score, grade: a.last.grade, status: a.last.status, at: new Date(a.last.created_at).toISOString() } : null,
      nextReviewOn: a.next_s ?? null, reviewDue: !!a.next_s && a.next_s <= t,
    });
  }
  const open = await outsideRequestScope(() => many<any>(`${REVIEW_SELECT} WHERE r.org_id = $1 AND r.status = 'open' ORDER BY r.created_at`, [orgId]));
  return { accounts: out, openReviews: open.map(reviewView) };
}

export async function reviews(orgId: string, accountId: string) {
  await accountRow(orgId, accountId);
  return (await outsideRequestScope(() => many<any>(`${REVIEW_SELECT} WHERE r.org_id = $1 AND r.fleet_account_id = $2 ORDER BY r.created_at DESC LIMIT 50`, [orgId, accountId]))).map(reviewView);
}

/** Open a review: the score now, the factors and the suggested limit. One open review per account. */
export async function openReview(orgId: string, accountId: string, userId: string | null, now = new Date()) {
  const a = await accountRow(orgId, accountId);
  const ex = await outsideRequestScope(() => one<{ id: string }>(`SELECT id FROM credit_review WHERE fleet_account_id = $1 AND status = 'open'`, [accountId]));
  if (ex) throw new CustomerCreditError(409, 'The account already has an open review: decide it first.');
  const f = await factors(orgId, accountId, now);
  const s = scoreOf(f);
  const r = await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO credit_review (org_id, fleet_account_id, currency, score, grade, factors, current_limit_minor, suggested_limit_minor, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [orgId, a.id, f.currency, s.score, s.grade, JSON.stringify({ ...f, reasons: s.reasons }), f.limit, suggestedLimit(s.grade, f.avgMonthly, f.deposit), userId]));
  return reviewView(await outsideRequestScope(() => one<any>(`${REVIEW_SELECT} WHERE r.id = $1`, [r!.id])));
}

/** Decide a review (finance:approve): approve with the new limit, a hold or its release and the next date; or reject. */
export async function decide(orgId: string, reviewId: string, b: Record<string, unknown>, who: { userId: string | null; canApprove: boolean }, now = new Date()) {
  if (!who.canApprove) throw new CustomerCreditError(403, 'A credit review is decided by a Finance Manager (finance:approve).');
  if (!/^\d{1,18}$/.test(reviewId)) throw new CustomerCreditError(404, 'No such review.');
  const r = await outsideRequestScope(() => one<any>(`${REVIEW_SELECT} WHERE r.id = $1 AND r.org_id = $2`, [reviewId, orgId]));
  if (!r) throw new CustomerCreditError(404, 'No such review.');
  if (r.status !== 'open') throw new CustomerCreditError(409, `The review is ${r.status}.`);
  const decision = String(b.decision ?? '');
  if (!['approve', 'reject'].includes(decision)) throw new CustomerCreditError(422, 'decision is approve or reject.');
  const note = b.note == null ? null : String(b.note).trim().slice(0, 500) || null;
  if (decision === 'reject') {
    if (!note) throw new CustomerCreditError(422, 'Say why the review is rejected.');
    await outsideRequestScope(() => query(`UPDATE credit_review SET status = 'rejected', note = $2, decided_by = $3, decided_at = now() WHERE id = $1`, [r.id, note, who.userId]));
  } else {
    const limit = b.newLimit == null || b.newLimit === '' ? Number(r.suggested_limit_minor) : Number(b.newLimit);
    if (!Number.isInteger(limit) || limit < 0) throw new CustomerCreditError(422, 'newLimit is a whole amount, 0 or more.');
    const hold = b.hold === undefined ? null : b.hold === true || b.hold === 'true';
    if (hold && !note) throw new CustomerCreditError(422, 'Say why the account is put on hold.');
    const next = b.nextReviewOn == null || b.nextReviewOn === '' ? addMonthsDay(today(now), REVIEW_MONTHS[r.grade as Grade]) : String(b.nextReviewOn);
    if (!DATE_RE.test(next) || next <= today(now)) throw new CustomerCreditError(422, 'nextReviewOn is a day after today (YYYY-MM-DD).');
    await outsideRequestScope(() => query(`UPDATE credit_review SET status = 'approved', new_limit_minor = $2, hold = $3, note = $4, next_review_on = $5, decided_by = $6, decided_at = now() WHERE id = $1`,
      [r.id, limit, hold, note, next, who.userId]));
    await outsideRequestScope(() => query(
      `UPDATE fleet_account SET credit_limit_minor = $3, next_review_on = $4,
              credit_hold_at = CASE WHEN $5::boolean IS NULL THEN credit_hold_at WHEN $5 THEN COALESCE(credit_hold_at, now()) ELSE NULL END,
              credit_hold_reason = CASE WHEN $5::boolean IS NULL THEN credit_hold_reason WHEN $5 THEN $6 ELSE NULL END
        WHERE id = $1 AND org_id = $2`, [r.fleet_account_id, orgId, limit, next, hold, note]));
    await check(orgId, r.fleet_account_id).catch((e) => logger.warn({ err: (e as Error).message }, 'credit check after a review failed'));
  }
  await outsideRequestScope(() => resolveAlertsFor(orgId, REVIEW_DUE, 'fleet_account', r.fleet_account_id)).catch(() => 0);
  return reviewView(await outsideRequestScope(() => one<any>(`${REVIEW_SELECT} WHERE r.id = $1`, [r.id])));
}

/** Put an account on hold now, or release it (finance:approve). */
export async function setHold(orgId: string, accountId: string, b: Record<string, unknown>, canApprove: boolean) {
  if (!canApprove) throw new CustomerCreditError(403, 'A hold is set or released by a Finance Manager (finance:approve).');
  const a = await accountRow(orgId, accountId);
  const on = b.hold === true || b.hold === 'true';
  const reason = String(b.reason ?? '').trim();
  if (on && reason.length < 3) throw new CustomerCreditError(422, 'Say why (at least 3 characters).');
  await outsideRequestScope(() => query(`UPDATE fleet_account SET credit_hold_at = CASE WHEN $3 THEN COALESCE(credit_hold_at, now()) ELSE NULL END, credit_hold_reason = CASE WHEN $3 THEN $4 ELSE NULL END WHERE id = $1 AND org_id = $2`,
    [a.id, orgId, on, reason.slice(0, 300) || null]));
  const c = await check(orgId, a.id);
  return { accountId: a.id, hold: on, cardsBlocked: c.blocked, cardsUnblocked: c.unblocked };
}

// ─────────────────────────────────────────── deposits

const depView = (r: any) => ({
  id: String(r.id), accountId: r.fleet_account_id, account: r.account_name ?? null, currency: r.currency, kind: r.kind, amount: Number(r.amount_minor), onDate: r.on_s,
  invoice: r.invoice_number ?? null, reference: r.reference ?? null, note: r.note ?? null, cashAccount: r.cash_account_name ?? null, by: r.by_name ?? null, voided: !!r.voided_at, voidReason: r.void_reason ?? null,
});

export async function deposits(orgId: string, accountId?: string) {
  if (accountId) await accountRow(orgId, accountId);
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT d.*, to_char(d.on_date, 'YYYY-MM-DD') AS on_s, a.name AS account_name, i.number AS invoice_number, c.name AS cash_account_name, u.name AS by_name
       FROM customer_deposit d JOIN fleet_account a ON a.id = d.fleet_account_id LEFT JOIN fleet_invoice i ON i.id = d.invoice_id LEFT JOIN cash_account c ON c.id = d.cash_account_id LEFT JOIN app_user u ON u.id = d.created_by
      WHERE d.org_id = $1 AND ($2::uuid IS NULL OR d.fleet_account_id = $2::uuid) ORDER BY d.on_date DESC, d.id DESC LIMIT 500`, [orgId, accountId ?? null]));
  const held: Record<string, number> = {};
  for (const r of rows) if (!r.voided_at) held[r.currency] = (held[r.currency] ?? 0) + (r.kind === 'received' ? 1 : -1) * Number(r.amount_minor);
  return { entries: rows.map(depView), held };
}

export async function record(orgId: string, accountId: string, b: Record<string, unknown>, userId: string | null) {
  const a = await accountRow(orgId, accountId);
  const kind = String(b.kind ?? '');
  if (!['received', 'returned', 'applied'].includes(kind)) throw new CustomerCreditError(422, 'kind is received, returned or applied.');
  const currency = String(b.currency ?? a.credit_currency).toUpperCase();
  const amount = Number(b.amount);
  if (!Number.isInteger(amount) || amount <= 0) throw new CustomerCreditError(422, 'amount is a whole amount above 0.');
  const onDate = String(b.onDate ?? today());
  if (!DATE_RE.test(onDate)) throw new CustomerCreditError(422, 'onDate is YYYY-MM-DD.');
  await assertOpen(orgId, onDate.slice(0, 7), 'A customer deposit', (s, m) => new CustomerCreditError(s, m));
  if (kind !== 'received' && amount > await depositBalance(orgId, a.id, currency)) throw new CustomerCreditError(422, `The account holds less than that in ${currency}.`);
  let invoiceId: string | null = null;
  if (kind === 'applied') {
    invoiceId = String(b.invoiceId ?? '');
    const inv = UUID_RE.test(invoiceId) ? await outsideRequestScope(() => one<any>(`SELECT id, status, currency, total_minor FROM fleet_invoice WHERE id = $1 AND org_id = $2 AND fleet_account_id = $3`, [invoiceId, orgId, a.id])) : null;
    if (!inv) throw new CustomerCreditError(422, 'invoiceId is one of the account\'s invoices.');
    if (inv.status !== 'issued') throw new CustomerCreditError(409, `The invoice is ${inv.status}.`);
    if (inv.currency !== currency || Number(inv.total_minor) !== amount) throw new CustomerCreditError(422, 'A deposit is applied to an invoice for its whole amount, in its currency.');
  }
  let cashId: string | null = null;
  if (kind !== 'applied' && b.cashAccountId != null && b.cashAccountId !== '') {
    const c = await outsideRequestScope(() => one<any>(`SELECT id, currency FROM cash_account WHERE id = $1 AND org_id = $2`, [String(b.cashAccountId), orgId]));
    if (!c || c.currency !== currency) throw new CustomerCreditError(422, 'cashAccountId is a cash account in the deposit\'s currency.');
    cashId = String(c.id);
  }
  const r = await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO customer_deposit (org_id, fleet_account_id, currency, kind, amount_minor, on_date, invoice_id, reference, note, cash_account_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [orgId, a.id, currency, kind, amount, onDate, invoiceId, b.reference ? String(b.reference).slice(0, 120) : null, b.note ? String(b.note).slice(0, 300) : null, cashId, userId]));
  if (invoiceId) await markPaid(orgId, invoiceId, { paidAt: onDate, reference: `Security deposit ${r!.id}` });
  return (await deposits(orgId, a.id)).entries.find((x) => x.id === String(r!.id))!;
}

export async function voidDeposit(orgId: string, id: string, reasonRaw: unknown) {
  if (!/^\d{1,18}$/.test(id)) throw new CustomerCreditError(404, 'No such entry.');
  const r = await outsideRequestScope(() => one<any>(`SELECT * FROM customer_deposit WHERE id = $1 AND org_id = $2`, [id, orgId]));
  if (!r) throw new CustomerCreditError(404, 'No such entry.');
  if (r.voided_at) throw new CustomerCreditError(409, 'The entry is already void.');
  if (r.kind === 'applied') throw new CustomerCreditError(409, 'A deposit applied to an invoice is not voided (the invoice is paid).');
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 3) throw new CustomerCreditError(422, 'Give a reason (at least 3 characters).');
  if (r.kind === 'received' && Number(r.amount_minor) > await depositBalance(orgId, r.fleet_account_id, r.currency)) throw new CustomerCreditError(409, 'Part of the deposit was returned or applied: void those first.');
  await outsideRequestScope(() => query(`UPDATE customer_deposit SET voided_at = now(), void_reason = $2 WHERE id = $1`, [r.id, reason.slice(0, 300)]));
  return { id: String(r.id), voided: true };
}

/** For the cash position: deposits received into and returned out of a cash account. */
export async function cashMoves(orgId: string, upTo: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT cash_account_id::text AS a, to_char(on_date, 'YYYY-MM-DD') AS d, kind, amount_minor FROM customer_deposit WHERE org_id = $1 AND voided_at IS NULL AND cash_account_id IS NOT NULL AND on_date <= $2::date`, [orgId, upTo]));
  return rows.map((r) => ({ account_id: r.a as string, d: r.d as string, amount: (r.kind === 'received' ? 1 : -1) * Number(r.amount_minor) }));
}

/** Daily: accounts due for review get a review opened, and an alert. */
export async function sweep(now = new Date()): Promise<number> {
  const due = await outsideRequestScope(() => many<{ id: string; org_id: string; name: string }>(
    `SELECT a.id, a.org_id, a.name FROM fleet_account a WHERE a.archived_at IS NULL AND a.next_review_on <= $1::date
        AND NOT EXISTS (SELECT 1 FROM credit_review r WHERE r.fleet_account_id = a.id AND r.status = 'open') LIMIT 500`, [today(now)]));
  let n = 0;
  for (const a of due) {
    try {
      const r = await openReview(a.org_id, a.id, null, now);
      await outsideRequestScope(() => persistAlert({ orgId: a.org_id, kind: REVIEW_DUE, severity: r.grade === 'D' || r.grade === 'E' ? 'warning' : 'info', targetType: 'fleet_account', targetId: a.id,
        message: `${a.name}: credit review due (score ${r.score}, grade ${r.grade}; suggested limit ${r.suggestedLimit}). Finance → Credit.` })).catch(() => null);
      n++;
    } catch (e) { logger.warn({ account: a.id, err: (e as Error).message }, 'credit review sweep failed'); }
  }
  return n;
}
