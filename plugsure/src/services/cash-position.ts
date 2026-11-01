import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { LEGACY_CURRENCY } from '../domain/money.js';
import { accountsFor } from './finance.js';
import { forecast as gatewayForecast } from './finance-forecast.js';
import { dueBills } from './supplier-bills.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { cashMoves as depositMoves, maturities as depositMaturities } from './treasury.js';
import { paymentsDue as leasePayments } from './leases.js';
import { cashMoves as claimMoves } from './expense-claims.js';
import { cashMoves as payrollMoves } from './payroll.js';
import { cashMoves as customerDepositMoves } from './customer-credit.js';

/**
 * Cash position and bank balances (v1.29.0).
 *
 *   accounts   the operator's bank and cash accounts (name, bank, the last digits, currency, an opening balance on a
 *              date, a minimum to alert below); gateway balances (Xendit, Duitku) come from the gateway's own
 *              snapshots and are shown beside them
 *   balance    on a day, an account's balance is its latest anchor on or before the day — a balance taken by hand, the
 *              last balance on a bank statement of the account (linked, or with the same last digits), or the opening
 *              balance — plus the transfers and supplier payments from the account dated after the anchor. Each says
 *              where it came from and how old the anchor is
 *   transfers  money moved between two of the operator's accounts (same currency), voidable with a reason
 *   daily      the last 30 days' position per currency
 *   13 weeks   from today's position: what the gateway forecast (v1.19.0) expects in and out (settlements, fleet invoices,
 *              Hub positions, refunds, owner shares, PlugSure's statements; the next 90 days), supplier bills by due
 *              date (approved or awaiting approval), and (v1.30.0) deposits maturing and lease payments, week by week, with the closing position and the first week below the
 *              accounts' minimums
 *
 * An account below its minimum raises finance.cash_below_minimum (checked daily), resolved when it recovers.
 */

export class CashError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const BELOW_MINIMUM_ALERT = 'finance.cash_below_minimum';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const validDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const text = (v: unknown, max: number) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
const idOk = (id: string) => /^\d{1,18}$/.test(id);

// ─────────────────────────────────────────── accounts

const accountView = (r: any) => ({
  id: String(r.id), name: r.name, kind: r.kind, bankName: r.bank_name ?? null, accountHint: r.account_hint ?? null, currency: r.currency,
  openingBalance: Number(r.opening_balance_minor), openingOn: r.opening_on_s, minimum: r.minimum_minor == null ? null : Number(r.minimum_minor), archived: !!r.archived_at,
});
const ACCOUNT_SELECT = `SELECT a.*, to_char(a.opening_on, 'YYYY-MM-DD') AS opening_on_s FROM cash_account a`;

export async function listAccounts(orgId: string, includeArchived = false) {
  const rows = await outsideRequestScope(() => many<any>(`${ACCOUNT_SELECT} WHERE a.org_id = $1 AND ($2 OR a.archived_at IS NULL) ORDER BY a.archived_at NULLS FIRST, a.currency, a.name`, [orgId, includeArchived]));
  return rows.map(accountView);
}

async function accountRow(orgId: string, id: string) {
  if (!idOk(id)) throw new CashError(404, 'No such cash account.');
  const r = await outsideRequestScope(() => one<any>(`${ACCOUNT_SELECT} WHERE a.id = $1 AND a.org_id = $2`, [id, orgId]));
  if (!r) throw new CashError(404, 'No such cash account.');
  return r;
}

function minimumOf(v: unknown, cur: number | null): number | null {
  if (v === undefined) return cur;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new CashError(422, 'minimum is a whole amount, 0 or more (or empty for none).');
  return n;
}

export async function createAccount(orgId: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const name = String(b.name ?? '').trim();
  if (name.length < 2 || name.length > 80) throw new CashError(422, 'The account\'s name is 2 to 80 characters.');
  const kind = String(b.kind ?? 'bank');
  if (kind !== 'bank' && kind !== 'cash') throw new CashError(422, 'kind is bank or cash (gateway balances are read from the gateway).');
  const currency = String(b.currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new CashError(422, 'currency is an ISO code (IDR, MYR, SGD…).');
  const hint = text(b.accountHint, 20);
  if (hint && !/^[0-9]{2,20}$/.test(hint)) throw new CashError(422, 'accountHint is the account number\'s last digits.');
  const opening = b.openingBalance == null || b.openingBalance === '' ? 0 : Number(b.openingBalance);
  if (!Number.isInteger(opening)) throw new CashError(422, 'openingBalance is a whole amount of the minor unit.');
  const on = b.openingOn == null || b.openingOn === '' ? today(now) : String(b.openingOn);
  if (!validDate(on) || on > today(now)) throw new CashError(422, 'openingOn is a date (YYYY-MM-DD), not in the future.');
  const r = await outsideRequestScope(() => one<any>(
    `INSERT INTO cash_account (org_id, name, kind, bank_name, account_hint, currency, opening_balance_minor, opening_on, minimum_minor, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *, to_char(opening_on, 'YYYY-MM-DD') AS opening_on_s`,
    [orgId, name, kind, text(b.bankName, 60), hint, currency, opening, on, minimumOf(b.minimum, null), userId]));
  return accountView(r);
}

export async function updateAccount(orgId: string, id: string, b: Record<string, unknown>) {
  const cur = await accountRow(orgId, id);
  const name = b.name === undefined ? cur.name : String(b.name ?? '').trim();
  if (name.length < 2 || name.length > 80) throw new CashError(422, 'The account\'s name is 2 to 80 characters.');
  const hint = b.accountHint === undefined ? cur.account_hint : text(b.accountHint, 20);
  if (hint && !/^[0-9]{2,20}$/.test(hint)) throw new CashError(422, 'accountHint is the account number\'s last digits.');
  const archive = b.archived === undefined ? null : b.archived === true || b.archived === 'true';
  const r = await outsideRequestScope(() => one<any>(
    `UPDATE cash_account SET name = $3, bank_name = $4, account_hint = $5, minimum_minor = $6,
            archived_at = CASE WHEN $7::boolean IS NULL THEN archived_at WHEN $7 THEN COALESCE(archived_at, now()) ELSE NULL END
      WHERE id = $1 AND org_id = $2 RETURNING *, to_char(opening_on, 'YYYY-MM-DD') AS opening_on_s`,
    [id, orgId, name, b.bankName === undefined ? cur.bank_name : text(b.bankName, 60), hint, minimumOf(b.minimum, cur.minimum_minor == null ? null : Number(cur.minimum_minor)), archive]));
  return accountView(r);
}

export async function recordBalance(orgId: string, id: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const a = await accountRow(orgId, id);
  if (a.archived_at) throw new CashError(409, 'The account is archived.');
  const on = b.onDate == null || b.onDate === '' ? today(now) : String(b.onDate);
  if (!validDate(on) || on > today(now) || on < a.opening_on_s) throw new CashError(422, 'onDate is a date (YYYY-MM-DD) from the opening date, not in the future.');
  const balance = Number(b.balance);
  if (!Number.isInteger(balance)) throw new CashError(422, 'balance is a whole amount of the minor unit.');
  await outsideRequestScope(() => query(
    `INSERT INTO cash_balance (org_id, account_id, on_date, balance_minor, note, recorded_by) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (account_id, on_date) DO UPDATE SET balance_minor = EXCLUDED.balance_minor, note = EXCLUDED.note, recorded_by = EXCLUDED.recorded_by, recorded_at = now()`,
    [orgId, id, on, balance, text(b.note, 200), userId]));
  return { accountId: id, onDate: on, balance };
}

export async function linkStatement(orgId: string, id: string, statementIdRaw: unknown) {
  await accountRow(orgId, id);
  const sid = String(statementIdRaw ?? '');
  if (!idOk(sid)) throw new CashError(404, 'No such bank statement.');
  const r = await outsideRequestScope(() => one(`UPDATE bank_statement SET cash_account_id = $3 WHERE id = $1 AND org_id = $2 RETURNING id`, [sid, orgId, id]));
  if (!r) throw new CashError(404, 'No such bank statement.');
  return { accountId: id, statementId: sid };
}

// ─────────────────────────────────────────── transfers

export async function transfers(orgId: string, limit = 100) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT t.*, to_char(t.on_date, 'YYYY-MM-DD') AS on_s, f.name AS from_name, x.name AS to_name, f.currency, u.name AS by_name
       FROM cash_transfer t JOIN cash_account f ON f.id = t.from_account_id JOIN cash_account x ON x.id = t.to_account_id LEFT JOIN app_user u ON u.id = t.recorded_by
      WHERE t.org_id = $1 ORDER BY t.on_date DESC, t.id DESC LIMIT $2`, [orgId, limit]));
  return rows.map((t) => ({ id: String(t.id), fromAccountId: String(t.from_account_id), from: t.from_name, toAccountId: String(t.to_account_id), to: t.to_name, currency: t.currency,
    amount: Number(t.amount_minor), onDate: t.on_s, reference: t.reference ?? null, note: t.note ?? null, recordedBy: t.by_name ?? null, voided: !!t.voided_at, voidReason: t.void_reason ?? null }));
}

export async function transfer(orgId: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const from = await accountRow(orgId, String(b.fromAccountId ?? ''));
  const to = await accountRow(orgId, String(b.toAccountId ?? ''));
  if (from.id === to.id) throw new CashError(422, 'The two accounts are the same.');
  if (from.archived_at || to.archived_at) throw new CashError(409, 'An archived account takes no transfers.');
  if (from.currency !== to.currency) throw new CashError(422, `The accounts are in ${from.currency} and ${to.currency}: a transfer is in one currency.`);
  const amount = Number(b.amount);
  if (!Number.isInteger(amount) || amount <= 0) throw new CashError(422, 'amount is a whole amount of the minor unit, above 0.');
  const on = b.onDate == null || b.onDate === '' ? today(now) : String(b.onDate);
  if (!validDate(on) || on > today(now)) throw new CashError(422, 'onDate is a date (YYYY-MM-DD), not in the future.');
  const r = await outsideRequestScope(() => one<any>(
    `INSERT INTO cash_transfer (org_id, from_account_id, to_account_id, amount_minor, on_date, reference, note, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [orgId, from.id, to.id, amount, on, text(b.reference, 80), text(b.note, 200), userId]));
  return (await transfers(orgId, 500)).find((t) => t.id === String(r.id))!;
}

export async function voidTransfer(orgId: string, id: string, reasonRaw: unknown, userId: string | null) {
  if (!idOk(id)) throw new CashError(404, 'No such transfer.');
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 3) throw new CashError(422, 'Give a reason (at least 3 characters).');
  const r = await outsideRequestScope(() => one(`UPDATE cash_transfer SET voided_at = now(), voided_by = $3, void_reason = $4 WHERE id = $1 AND org_id = $2 AND voided_at IS NULL RETURNING id`, [id, orgId, userId, reason.slice(0, 300)]));
  if (!r) throw new CashError(404, 'No such transfer (or it is already void).');
  return { id, voided: true };
}

// ─────────────────────────────────────────── the position

interface Book {
  accounts: any[];
  manual: Array<{ account_id: string; d: string; balance: number }>;
  statement: Array<{ account_id: string; d: string; balance: number }>;
  moves: Array<{ account_id: string; d: string; amount: number }>;
}

async function book(orgId: string, upTo: string): Promise<Book> {
  const [accounts, manual, statement, xfers, pays, deps, claims] = await Promise.all([
    outsideRequestScope(() => many<any>(`${ACCOUNT_SELECT} WHERE a.org_id = $1 AND a.archived_at IS NULL ORDER BY a.currency, a.name`, [orgId])),
    outsideRequestScope(() => many<any>(`SELECT account_id::text, to_char(on_date, 'YYYY-MM-DD') AS d, balance_minor FROM cash_balance WHERE org_id = $1 AND on_date <= $2::date`, [orgId, upTo])),
    // The last balance of each day on a statement of the account (linked, or the same last digits when not linked).
    outsideRequestScope(() => many<any>(
      `SELECT DISTINCT ON (a.id, l.line_date) a.id::text AS account_id, to_char(l.line_date, 'YYYY-MM-DD') AS d, l.balance_minor
         FROM bank_statement_line l JOIN bank_statement s ON s.id = l.statement_id
         JOIN cash_account a ON a.org_id = s.org_id AND (s.cash_account_id = a.id OR (s.cash_account_id IS NULL AND a.account_hint IS NOT NULL AND s.account_hint IS NOT NULL AND right(s.account_hint, length(a.account_hint)) = a.account_hint))
        WHERE s.org_id = $1 AND l.balance_minor IS NOT NULL AND l.line_date <= $2::date
        ORDER BY a.id, l.line_date, l.line_no DESC, l.id DESC`, [orgId, upTo])),
    outsideRequestScope(() => many<any>(`SELECT from_account_id::text AS f, to_account_id::text AS t, to_char(on_date, 'YYYY-MM-DD') AS d, amount_minor FROM cash_transfer WHERE org_id = $1 AND voided_at IS NULL AND on_date <= $2::date`, [orgId, upTo])),
    outsideRequestScope(() => many<any>(`SELECT cash_account_id::text AS a, to_char(paid_on, 'YYYY-MM-DD') AS d, amount_minor FROM supplier_payment WHERE org_id = $1 AND voided_at IS NULL AND cash_account_id IS NOT NULL AND paid_on <= $2::date`, [orgId, upTo])),
    // (v1.30.0) deposits: placed out of the account, matured back into it.
    depositMoves(orgId, upTo),
    // (v1.31.0) expense claims reimbursed out of the account.
    claimMoves(orgId, upTo),
  ]);
  // (v1.33.0) payrolls paid, and customer security deposits received and returned.
  const [payMoves, custMoves] = await Promise.all([payrollMoves(orgId, upTo), customerDepositMoves(orgId, upTo)]);
  // (v1.34.0) loans: drawdowns into and payments out of the loan's account (imported here: lenders reads the position).
  const loanMoves = await (await import('./lenders.js')).cashMoves(orgId, upTo);
  // (v1.35.0) RECs bought and carbon credits sold; insurance premiums paid and claims settled.
  const [carbonMoves, insuranceMoves] = await Promise.all([(await import('./carbon.js')).cashMoves(orgId, upTo), (await import('./insurance.js')).cashMoves(orgId, upTo)]);
  // (v1.36.0) grant claims received and clawbacks repaid.
  const grantMoves = await (await import('./grants.js')).cashMoves(orgId, upTo);
  // (v1.38.0) FX hedges settled net into the account.
  const hedgeMoves = await (await import('./fx-treasury.js')).cashMoves(orgId, upTo);
  // (v1.39.0) Corporate income tax paid, and card statements paid.
  const [taxMoves, cardMoves] = await Promise.all([(await import('./corporate-tax.js')).cashMoves(orgId, upTo), (await import('./corporate-cards.js')).cashMoves(orgId, upTo)]);
  return {
    accounts,
    manual: manual.map((m) => ({ account_id: m.account_id, d: m.d, balance: Number(m.balance_minor) })),
    statement: statement.map((m) => ({ account_id: m.account_id, d: m.d, balance: Number(m.balance_minor) })),
    moves: [
      ...xfers.flatMap((x) => [{ account_id: x.f, d: x.d, amount: -Number(x.amount_minor) }, { account_id: x.t, d: x.d, amount: Number(x.amount_minor) }]),
      ...pays.map((p) => ({ account_id: p.a, d: p.d, amount: -Number(p.amount_minor) })),
      ...deps,
      ...claims,
      ...payMoves,
      ...custMoves,
      ...loanMoves,
      ...carbonMoves,
      ...insuranceMoves,
      ...grantMoves,
      ...hedgeMoves,
      ...taxMoves,
      ...cardMoves,
    ],
  };
}

/** One account's balance on a day, from the book. */
export function balanceOn(bk: Book, a: any, day: string) {
  const id = String(a.id);
  type Anchor = { d: string; balance: number; source: 'opening' | 'statement' | 'manual' };
  let anchor: Anchor | null = a.opening_on_s <= day ? { d: a.opening_on_s, balance: Number(a.opening_balance_minor), source: 'opening' } : null;
  const rank = { opening: 0, statement: 1, manual: 2 } as const;
  const consider = (x: Anchor) => { if (x.d <= day && (!anchor || x.d > anchor.d || (x.d === anchor.d && rank[x.source] >= rank[anchor.source]))) anchor = x; };
  for (const s of bk.statement) if (s.account_id === id) consider({ d: s.d, balance: s.balance, source: 'statement' });
  for (const m of bk.manual) if (m.account_id === id) consider({ d: m.d, balance: m.balance, source: 'manual' });
  if (!anchor) return null;
  const an: Anchor = anchor;
  const moved = bk.moves.filter((m) => m.account_id === id && m.d > an.d && m.d <= day).reduce((s, m) => s + m.amount, 0);
  return { balance: an.balance + moved, anchor: { source: an.source, date: an.d, balance: an.balance }, movedSince: moved, ageDays: daysBetween(an.d, day) };
}

async function gatewayBalances(orgId: string, day: string) {
  const accts = (await accountsFor(orgId, false)).filter((a) => !a.archived && !a.testMode);
  const out: Array<{ integrationId: string; name: string; currency: string; balance: number; takenAt: string }> = [];
  for (const a of accts) {
    const s = await outsideRequestScope(() => one<{ balance: string; currency: string; taken_at: Date }>(
      `SELECT balance, currency, taken_at FROM gateway_balance_snapshot WHERE integration_id = $1 AND (taken_at AT TIME ZONE $3)::date <= $2::date ORDER BY taken_at DESC LIMIT 1`, [a.id, day, zone()]));
    if (s) out.push({ integrationId: a.id, name: a.label, currency: s.currency || LEGACY_CURRENCY, balance: Math.round(Number(s.balance)), takenAt: new Date(s.taken_at).toISOString() });
  }
  return out;
}

export async function position(orgId: string, q: Record<string, unknown> = {}, now = new Date()) {
  const day = q.date == null || q.date === '' ? today(now) : String(q.date);
  if (!validDate(day) || day > today(now)) throw new CashError(422, 'date is a day (YYYY-MM-DD), not in the future.');
  const bk = await book(orgId, day);
  const accounts = bk.accounts.map((a) => {
    const b = balanceOn(bk, a, day);
    const minimum = a.minimum_minor == null ? null : Number(a.minimum_minor);
    return { ...accountView(a), balance: b?.balance ?? null, anchor: b?.anchor ?? null, movedSince: b?.movedSince ?? 0, ageDays: b?.ageDays ?? null,
      belowMinimum: b != null && minimum != null && b.balance < minimum };
  });
  const gateways = await gatewayBalances(orgId, day);
  const totals: Record<string, { bank: number; cash: number; gateway: number; total: number; minimum: number; deposits: number }> = {};
  const T = (c: string) => (totals[c] ??= { bank: 0, cash: 0, gateway: 0, total: 0, minimum: 0, deposits: 0 });
  for (const a of accounts) {
    if (a.balance == null) continue;
    const t = T(a.currency);
    if (a.kind === 'cash') t.cash += a.balance; else t.bank += a.balance;
    t.total += a.balance; t.minimum += a.minimum ?? 0;
  }
  for (const g of gateways) { const t = T(g.currency); t.gateway += g.balance; t.total += g.balance; }
  // (v1.30.0) Time deposits placed and not yet back, beside the total (not available until they mature).
  for (const d of await outsideRequestScope(() => many<any>(`SELECT currency, sum(principal_minor)::bigint AS p FROM deposit WHERE org_id = $1 AND placed_on <= $2::date AND (status = 'active' OR closed_on > $2::date) GROUP BY 1`, [orgId, day]))) T(d.currency).deposits += Number(d.p);
  // The last 30 days, per currency (bank and cash accounts; gateway snapshots at each day's end).
  const days = Array.from({ length: 30 }, (_, k) => addDays(day, k - 29));
  const daily: Record<string, Array<{ day: string; balance: number }>> = {};
  for (const d of days) {
    const per: Record<string, number> = {};
    for (const a of bk.accounts) { const b = balanceOn(bk, a, d); if (b) per[a.currency] = (per[a.currency] ?? 0) + b.balance; }
    for (const [c, v] of Object.entries(per)) (daily[c] ??= []).push({ day: d, balance: v });
  }
  return { date: day, accounts, gateways, totals, daily, stale: accounts.filter((a) => a.ageDays != null && a.ageDays > 7).map((a) => a.id) };
}

// ─────────────────────────────────────────── 13 weeks

/** (v1.33.0) The committed flows from today over `days` (the 13-week view's, and the cash forecast's). */
export async function knownFlows(orgId: string, days: number, now = new Date()) {
  const t = today(now);
  const pos = await position(orgId, {}, now);
  const end = addDays(t, days - 1);
  const flows: Array<{ day: string; currency: string; kind: string; label: string; amount: number }> = [];
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const a of (await accountsFor(orgId, false)).filter((x) => !x.archived && !x.testMode)) {
    let f;
    try { f = await gatewayForecast(a, { days: 90 }, now); } catch (e) { logger.warn({ account: a.id, err: (e as Error).message }, 'cash weeks: gateway forecast failed'); notes.push(`${a.label}: its forecast could not be read.`); continue; }
    const cur = pos.gateways.find((g) => g.integrationId === a.id)?.currency ?? LEGACY_CURRENCY;
    for (const x of f.flows) {
      // Organisation-wide flows (fleet invoices, owner shares, statements) appear once whichever account forecasts them.
      const k = `${x.kind}|${x.day}|${x.label}|${x.amount}`;
      if (seen.has(k)) continue;
      seen.add(k);
      flows.push({ day: x.day, currency: cur, kind: x.kind, label: x.label, amount: x.amount });
    }
  }
  for (const m of await depositMaturities(orgId, t, end)) flows.push({ day: m.day, currency: m.currency, kind: 'deposit_maturity', label: m.label, amount: m.amount });
  for (const l of await leasePayments(orgId, t, end)) flows.push({ day: l.day, currency: l.currency, kind: 'lease', label: l.label, amount: -l.amount });
  for (const b of await dueBills(orgId, t, end)) flows.push({ day: b.due, currency: b.currency, kind: 'supplier_bill', label: `Bill ${b.number} · ${b.supplier}${b.overdue ? ' (overdue)' : ''}`, amount: -b.amount });
  return { t, end, pos, flows, notes };
}

export async function weeks(orgId: string, now = new Date()) {
  const { t, end, pos, flows, notes } = await knownFlows(orgId, 13 * 7, now);
  const currencies = [...new Set([...Object.keys(pos.totals), ...flows.map((f) => f.currency)])].sort();
  const out = currencies.map((currency) => {
    const opening = pos.totals[currency]?.total ?? 0;
    const minimum = pos.totals[currency]?.minimum ?? 0;
    let closing = opening;
    let belowMinimum: string | null = null;
    const rows = Array.from({ length: 13 }, (_, k) => {
      const from = addDays(t, k * 7), to = addDays(t, k * 7 + 6);
      const fs = flows.filter((f) => f.currency === currency && f.day >= from && f.day <= to);
      const inflow = fs.filter((f) => f.amount > 0).reduce((s, f) => s + f.amount, 0);
      const outflow = fs.filter((f) => f.amount < 0).reduce((s, f) => s + f.amount, 0);
      closing += inflow + outflow;
      if (!belowMinimum && closing < minimum) belowMinimum = from;
      const byKind: Record<string, number> = {};
      for (const f of fs) byKind[f.kind] = (byKind[f.kind] ?? 0) + f.amount;
      return { week: k + 1, from, to, in: inflow, out: outflow, net: inflow + outflow, closing, byKind };
    });
    return { currency, opening, minimum, weeks: rows, closing, lowest: rows.reduce((m, r) => Math.min(m, r.closing), opening), firstWeekBelowMinimum: belowMinimum,
      largest: flows.filter((f) => f.currency === currency).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 15) };
  });
  return { from: t, to: end, position: { date: pos.date, totals: pos.totals, stale: pos.stale.length }, currencies: out, notes };
}

/** Daily: an alert per account below its minimum; resolved when it recovers. */
export async function check(orgId: string, now = new Date()) {
  const pos = await position(orgId, {}, now);
  let n = 0;
  for (const a of pos.accounts) {
    if (a.minimum == null) continue;
    if (a.belowMinimum) {
      await persistAlert({ orgId, kind: BELOW_MINIMUM_ALERT, severity: 'warning', targetType: 'cash_account', targetId: a.id,
        message: `${a.name}: ${a.balance} ${a.currency} is below its minimum of ${a.minimum} ${a.currency}.` });
      n++;
    } else {
      await resolveAlertsFor(orgId, BELOW_MINIMUM_ALERT, 'cash_account', a.id);
    }
  }
  return n;
}

export async function sweep(now = new Date()): Promise<number> {
  const orgs = await outsideRequestScope(() => many<{ org_id: string }>(`SELECT DISTINCT org_id FROM cash_account WHERE archived_at IS NULL AND minimum_minor IS NOT NULL`));
  let n = 0;
  for (const o of orgs) { try { n += await outsideRequestScope(() => check(o.org_id, now)); } catch (e) { logger.warn({ org: o.org_id, err: (e as Error).message }, 'cash check failed'); } }
  return n;
}
