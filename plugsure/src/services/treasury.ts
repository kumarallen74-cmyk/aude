import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { xlsx } from './xlsx.js';

/**
 * Treasury: time deposits (v1.30.0).
 *
 *   deposit    placed from one of the operator's bank accounts (Cash): bank, reference, principal, the rate a year, the
 *              placement and maturity dates, the final tax on its interest (PPh final, default 20%). Interest accrues
 *              actual/365: gross, tax, net, to today and at maturity
 *   maturity   matured with the interest received (default the expected net), back into the account; or rolled over
 *              into a new deposit (the principal, with or without the interest); or broken early with the interest
 *              received and any penalty. The cash position counts the placement out of the account and the maturity
 *              back in; the 13-week view counts maturities as money coming in
 *   idle cash  per currency, the lowest point of the 13-week view above the accounts' minimums and a buffer: what could
 *              be placed, with the net interest it would earn over 1 and 3 months at an indicative rate
 *   alert      finance.deposit_maturing for a deposit maturing within 7 days or past maturity (checked daily), resolved
 *              when it is closed
 */

export class TreasuryError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const MATURING_ALERT = 'finance.deposit_maturing';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const addMonthsDay = (d: string, n: number) => {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(day, last))).toISOString().slice(0, 10);
};
const validDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const text = (v: unknown, max: number) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));

export interface Settings { indicativeRatePct: number; buffer: number }

export async function settings(orgId: string): Promise<Settings> {
  const r = await outsideRequestScope(() => one<{ treasury: any }>(`SELECT treasury FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  return { indicativeRatePct: Number(r?.treasury?.indicativeRatePct ?? 4), buffer: Number(r?.treasury?.buffer ?? 0) };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const cur = await settings(orgId);
  const rate = b.indicativeRatePct === undefined ? cur.indicativeRatePct : Number(b.indicativeRatePct);
  if (!Number.isFinite(rate) || rate < 0 || rate > 30) throw new TreasuryError(422, 'indicativeRatePct is 0 to 30.');
  const buffer = b.buffer === undefined ? cur.buffer : Number(b.buffer);
  if (!Number.isInteger(buffer) || buffer < 0) throw new TreasuryError(422, 'buffer is a whole amount, 0 or more.');
  const v = { indicativeRatePct: rate, buffer };
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, treasury, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET treasury = EXCLUDED.treasury, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify(v), userId]));
  return v;
}

/** Interest on a principal between two days, actual/365: gross, the final tax, net. */
export function interest(principal: number, ratePct: number, taxPct: number, from: string, to: string) {
  const days = Math.max(0, daysBetween(from, to));
  const gross = Math.round((principal * ratePct * days) / 36_500);
  const tax = Math.round((gross * taxPct) / 100);
  return { days, gross, tax, net: gross - tax };
}

const SELECT = `SELECT d.*, to_char(d.placed_on, 'YYYY-MM-DD') AS placed_s, to_char(d.maturity_on, 'YYYY-MM-DD') AS maturity_s, to_char(d.closed_on, 'YYYY-MM-DD') AS closed_s,
                       a.name AS account_name, u.name AS by_name
                  FROM deposit d JOIN cash_account a ON a.id = d.cash_account_id LEFT JOIN app_user u ON u.id = d.recorded_by`;

function view(r: any, now = new Date()) {
  const t = today(now);
  const principal = Number(r.principal_minor), rate = Number(r.rate_pct), tax = Number(r.tax_pct);
  const atMaturity = interest(principal, rate, tax, r.placed_s, r.maturity_s);
  const accrued = interest(principal, rate, tax, r.placed_s, r.status === 'active' ? (t < r.maturity_s ? t : r.maturity_s) : r.closed_s);
  return {
    id: String(r.id), cashAccountId: String(r.cash_account_id), account: r.account_name, bankName: r.bank_name, reference: r.reference ?? null, currency: r.currency,
    principal, ratePct: rate, taxPct: tax, placedOn: r.placed_s, maturityOn: r.maturity_s, termDays: atMaturity.days, status: r.status,
    daysToMaturity: r.status === 'active' ? daysBetween(t, r.maturity_s) : null,
    accrued, atMaturity,
    closedOn: r.closed_s ?? null, interestReceived: r.interest_received_minor == null ? null : Number(r.interest_received_minor), penalty: Number(r.penalty_minor),
    rolledFrom: r.rolled_from == null ? null : String(r.rolled_from), note: r.note ?? null, recordedBy: r.by_name ?? null,
  };
}
export type DepositView = ReturnType<typeof view>;

export async function list(orgId: string, now = new Date()) {
  const rows = await outsideRequestScope(() => many<any>(`${SELECT} WHERE d.org_id = $1 ORDER BY (d.status = 'active') DESC, d.maturity_on, d.id`, [orgId]));
  const deposits = rows.map((r) => view(r, now));
  const totals: Record<string, { principal: number; accruedNet: number; count: number; nextMaturity: string | null }> = {};
  for (const d of deposits.filter((x) => x.status === 'active')) {
    const t = (totals[d.currency] ??= { principal: 0, accruedNet: 0, count: 0, nextMaturity: null });
    t.principal += d.principal; t.accruedNet += d.accrued.net; t.count++;
    if (!t.nextMaturity || d.maturityOn < t.nextMaturity) t.nextMaturity = d.maturityOn;
  }
  const year = today(now).slice(0, 4);
  const income: Record<string, { gross: number; tax: number; net: number }> = {};
  for (const d of deposits.filter((x) => x.status !== 'active' && x.closedOn?.startsWith(year))) {
    const i = (income[d.currency] ??= { gross: 0, tax: 0, net: 0 });
    const net = d.interestReceived ?? 0;
    const gross = d.taxPct < 100 ? Math.round(net / (1 - d.taxPct / 100)) : net;
    i.net += net; i.gross += gross; i.tax += gross - net;
  }
  return { asOf: today(now), deposits, totals, incomeThisYear: income };
}

async function row(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new TreasuryError(404, 'No such deposit.');
  const r = await outsideRequestScope(() => one<any>(`${SELECT} WHERE d.id = $1 AND d.org_id = $2`, [id, orgId]));
  if (!r) throw new TreasuryError(404, 'No such deposit.');
  return r;
}

export async function get(orgId: string, id: string, now = new Date()) { return view(await row(orgId, id), now); }

function termEnd(placedOn: string, b: Record<string, unknown>): string {
  if (b.maturityOn != null && b.maturityOn !== '') return String(b.maturityOn);
  if (b.termMonths != null && b.termMonths !== '') {
    const n = Number(b.termMonths);
    if (!Number.isInteger(n) || n < 1 || n > 60) throw new TreasuryError(422, 'termMonths is 1 to 60.');
    return addMonthsDay(placedOn, n);
  }
  if (b.termDays != null && b.termDays !== '') {
    const n = Number(b.termDays);
    if (!Number.isInteger(n) || n < 1 || n > 1830) throw new TreasuryError(422, 'termDays is 1 to 1830.');
    return addDays(placedOn, n);
  }
  throw new TreasuryError(422, 'Give maturityOn, termMonths or termDays.');
}

export async function place(orgId: string, b: Record<string, unknown>, userId: string | null, now = new Date(), rolledFrom: string | null = null) {
  const aid = String(b.cashAccountId ?? '');
  if (!/^\d{1,18}$/.test(aid)) throw new TreasuryError(404, 'No such cash account.');
  const a = await outsideRequestScope(() => one<any>(`SELECT * FROM cash_account WHERE id = $1 AND org_id = $2`, [aid, orgId]));
  if (!a) throw new TreasuryError(404, 'No such cash account.');
  if (a.kind !== 'bank' || a.archived_at) throw new TreasuryError(422, 'A deposit is placed from a bank account in use.');
  const bank = String(b.bankName ?? a.bank_name ?? '').trim();
  if (bank.length < 2 || bank.length > 80) throw new TreasuryError(422, 'bankName is 2 to 80 characters.');
  const principal = Number(b.principal);
  if (!Number.isInteger(principal) || principal <= 0) throw new TreasuryError(422, 'principal is a whole amount of the minor unit, above 0.');
  const rate = Number(b.ratePct);
  if (!Number.isFinite(rate) || rate < 0 || rate > 30) throw new TreasuryError(422, 'ratePct (a year) is 0 to 30.');
  const taxPct = b.taxPct == null || b.taxPct === '' ? 20 : Number(b.taxPct);
  if (!Number.isFinite(taxPct) || taxPct < 0 || taxPct > 50) throw new TreasuryError(422, 'taxPct is 0 to 50.');
  const placedOn = b.placedOn == null || b.placedOn === '' ? today(now) : String(b.placedOn);
  if (!validDate(placedOn) || placedOn > today(now)) throw new TreasuryError(422, 'placedOn is a date (YYYY-MM-DD), not in the future.');
  const maturityOn = termEnd(placedOn, b);
  if (!validDate(maturityOn) || maturityOn <= placedOn) throw new TreasuryError(422, 'maturityOn is a date after placedOn.');
  const r = await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO deposit (org_id, cash_account_id, bank_name, reference, currency, principal_minor, rate_pct, tax_pct, placed_on, maturity_on, rolled_from, note, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    [orgId, aid, bank, text(b.reference, 80), a.currency, principal, rate, taxPct, placedOn, maturityOn, rolledFrom, text(b.note, 300), userId]));
  return get(orgId, String(r!.id), now);
}

/** Matured (on or after maturity) or broken early: the interest received (default the expected net), any penalty. */
export async function close(orgId: string, id: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const r = await row(orgId, id);
  if (r.status !== 'active') throw new TreasuryError(409, `The deposit is ${r.status}.`);
  const on = b.closedOn == null || b.closedOn === '' ? (today(now) < r.maturity_s ? today(now) : r.maturity_s) : String(b.closedOn);
  if (!validDate(on) || on <= r.placed_s || on > today(now)) throw new TreasuryError(422, 'closedOn is a date after it was placed, not in the future.');
  const broken = on < r.maturity_s;
  const expected = interest(Number(r.principal_minor), Number(r.rate_pct), Number(r.tax_pct), r.placed_s, on).net;
  const received = b.interestReceived == null || b.interestReceived === '' ? (broken ? 0 : expected) : Number(b.interestReceived);
  if (!Number.isInteger(received) || received < 0) throw new TreasuryError(422, 'interestReceived is a whole amount, 0 or more (net of the tax).');
  const penalty = b.penalty == null || b.penalty === '' ? 0 : Number(b.penalty);
  if (!Number.isInteger(penalty) || penalty < 0 || penalty > Number(r.principal_minor)) throw new TreasuryError(422, 'penalty is 0 to the principal.');
  if (!broken && penalty) throw new TreasuryError(422, 'A penalty is for a deposit broken before maturity.');
  await outsideRequestScope(() => query(
    `UPDATE deposit SET status = $3, closed_on = $4, interest_received_minor = $5, penalty_minor = $6, note = COALESCE($7, note) WHERE id = $1 AND org_id = $2 AND status = 'active'`,
    [id, orgId, broken ? 'broken' : 'matured', on, received, penalty, text(b.note, 300)]));
  await resolveAlertsFor(orgId, MATURING_ALERT, 'deposit', id).catch(() => 0);
  let rolled = null;
  const ro = b.rollover as Record<string, unknown> | undefined;
  if (ro && !broken) {
    const principal = Number(r.principal_minor) + (ro.withInterest === true || ro.withInterest === 'true' ? received : 0);
    rolled = await place(orgId, { cashAccountId: String(r.cash_account_id), bankName: r.bank_name, reference: ro.reference ?? r.reference, principal,
      ratePct: ro.ratePct ?? r.rate_pct, taxPct: r.tax_pct, placedOn: on, termMonths: ro.termMonths, termDays: ro.termDays, maturityOn: ro.maturityOn }, userId, now, id);
  }
  return { ...(await get(orgId, id, now)), ...(rolled ? { rolledInto: rolled } : {}) };
}

/** What could be placed per currency: the lowest point of the 13 weeks above the minimums and the buffer. */
export function idleCash(weeksView: { currencies: Array<{ currency: string; minimum: number; lowest: number; weeks: Array<{ week: number; closing: number }> }> }, s: Settings) {
  return weeksView.currencies.map((c) => {
    const room = c.lowest - c.minimum - s.buffer;
    if (room <= 0) return { currency: c.currency, amount: 0, lowestWeek: null, termMonths: null, netInterest1m: 0, netInterest3m: 0 };
    const mag = Math.pow(10, Math.max(0, Math.floor(Math.log10(room)) - 1));
    const amount = Math.floor(room / mag) * mag;
    const lowestWeek = c.weeks.reduce((a, w) => (w.closing < a.closing ? w : a), c.weeks[0]!).week;
    const est = (months: number) => Math.round((amount * s.indicativeRatePct * months * 30.4) / 36_500 * 0.8);
    return { currency: c.currency, amount, lowestWeek, termMonths: lowestWeek <= 5 ? 1 : 3, netInterest1m: est(1), netInterest3m: est(3) };
  });
}

/** Cash effects of deposits for the cash position: placement out of the account, maturity back in. */
export async function cashMoves(orgId: string, upTo: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT cash_account_id::text AS a, to_char(placed_on, 'YYYY-MM-DD') AS p, to_char(closed_on, 'YYYY-MM-DD') AS c, principal_minor, interest_received_minor, penalty_minor, status
       FROM deposit WHERE org_id = $1 AND placed_on <= $2::date`, [orgId, upTo]));
  const out: Array<{ account_id: string; d: string; amount: number }> = [];
  for (const r of rows) {
    out.push({ account_id: r.a, d: r.p, amount: -Number(r.principal_minor) });
    if (r.status !== 'active' && r.c && r.c <= upTo) out.push({ account_id: r.a, d: r.c, amount: Number(r.principal_minor) + Number(r.interest_received_minor ?? 0) - Number(r.penalty_minor ?? 0) });
  }
  return out;
}

/** Active deposits maturing between two days (principal + expected net interest), for the 13-week view. */
export async function maturities(orgId: string, from: string, to: string) {
  const rows = await outsideRequestScope(() => many<any>(`${SELECT} WHERE d.org_id = $1 AND d.status = 'active' AND d.maturity_on <= $2::date`, [orgId, to]));
  return rows.map((r) => view(r)).map((d) => ({ day: d.maturityOn < from ? from : d.maturityOn, currency: d.currency, amount: d.principal + d.atMaturity.net, label: `Deposit ${d.bankName}${d.reference ? ` ${d.reference}` : ''} matures` }));
}

export function depositsXlsx(l: Awaited<ReturnType<typeof list>>): Buffer {
  return xlsx([{ name: 'Deposits', rows: [['Bank', 'Reference', 'Account', 'Currency', 'Principal', 'Rate %', 'Tax %', 'Placed', 'Maturity', 'Status', 'Accrued (net)', 'At maturity (net)', 'Interest received'],
    ...l.deposits.map((d) => [d.bankName, d.reference ?? '', d.account, d.currency, d.principal, d.ratePct, d.taxPct, d.placedOn, d.maturityOn, d.status, d.accrued.net, d.atMaturity.net, d.interestReceived])],
    widths: [16, 14, 18, 8, 16, 7, 7, 11, 11, 9, 14, 16, 16], formats: [null, null, null, null, 'int', null, null, null, null, null, 'int', 'int', 'int'] }]);
}

/** Daily: an alert per deposit maturing within 7 days or past maturity, still active. */
export async function sweep(now = new Date()): Promise<number> {
  const t = today(now);
  const rows = await outsideRequestScope(() => many<any>(`${SELECT} WHERE d.status = 'active' AND d.maturity_on <= $1::date`, [addDays(t, 7)]));
  let n = 0;
  for (const r of rows) {
    const d = view(r, now);
    try {
      await outsideRequestScope(() => persistAlert({ orgId: r.org_id, kind: MATURING_ALERT, severity: (d.daysToMaturity ?? 0) < 0 ? 'warning' : 'info', targetType: 'deposit', targetId: d.id,
        message: (d.daysToMaturity ?? 0) < 0 ? `Deposit at ${d.bankName}${d.reference ? ` (${d.reference})` : ''} matured ${d.maturityOn} and is not closed: record it, or roll it over.`
          : `Deposit at ${d.bankName}${d.reference ? ` (${d.reference})` : ''} of ${d.principal} ${d.currency} matures ${d.maturityOn}: roll it over or let it return to ${d.account}.` }));
      n++;
    } catch (e) { logger.warn({ deposit: d.id, err: (e as Error).message }, 'deposit alert failed'); }
  }
  return n;
}
