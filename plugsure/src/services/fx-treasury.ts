import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { convert, exponentOf } from './fx.js';
import { LEGACY_CURRENCY } from '../domain/money.js';
import { assertOpen } from './finance-periods.js';
import { xlsx } from './xlsx.js';

/**
 * Treasury FX and hedging (v1.38.0). For an operator with money in more than one currency (sites in IDR, MYR, SGD; a
 * USD loan or charger supplier), what moves when rates move.
 *
 *   exposure     per currency other than the reporting one, at a day: cash and bank (Cash position), receivables
 *                (fleet invoices issued and unpaid), payables (approved supplier bills unpaid), loans (outstanding),
 *                and open hedges (the currency bought +, the currency sold −). Net, in the reporting currency at the
 *                month's rate (Finance → Settings → Currencies), and the change since the previous month's rate
 *                (the revaluation), with the effect of a 10% move.
 *   hedges       forward contracts with a bank: buy a notional of one currency against another at an agreed rate on
 *                a maturity date. Open ones are marked to market at the month's rate. Settled net (a non-deliverable
 *                forward, the usual form for rupiah): the realised result, notional × (settled rate − contract rate),
 *                in the currency sold, posts with the new ledger source fx: a gain Dr bank / Cr 7400 FX gains,
 *                a loss Dr 8400 FX losses / Cr bank. Cancelled ones post nothing.
 *
 * Rates are per major unit (one USD in IDR, as entered under Settings → Currencies); amounts are in minor units, so each
 * conversion scales by the two currencies' exponents (IDR 0; MYR, SGD, USD, EUR 2). A cross rate (neither side the
 * reporting currency) is the ratio of the two currencies' rates.
 */

export class FxTreasuryError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const CUR_RE = /^[A-Z]{3}$/;
const ERR = (s: number, m: string) => new FxTreasuryError(s, m);
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const prevMonth = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; };
/** The move used for the sensitivity shown beside the exposure. */
export const SENSITIVITY_PCT = 10;

/** 1 unit of `from` in `to`, from rates into the reporting currency (the reporting currency itself is 1). Pure. */
export function crossRate(rates: Map<string, number>, reporting: string, from: string, to: string): number | null {
  if (from === to) return 1;
  const r = (c: string) => (c === reporting ? 1 : rates.get(c) ?? null);
  const a = r(from), b = r(to);
  return a == null || b == null || b === 0 ? null : a / b;
}

export { exponentOf, convert };

/** A hedge's result in the currency sold at a rate (buy → sell): notional × (rate − contract rate), in minor units. Pure. */
export function hedgeResult(notional: number, contractRate: number, marketRate: number, buy = LEGACY_CURRENCY as string, sell = LEGACY_CURRENCY as string): number {
  return convert(notional, marketRate - contractRate, buy, sell);
}

async function monthRates(orgId: string, month: string, reporting: string) {
  const rs = await outsideRequestScope(() => many<{ currency: string; rate: string }>(`SELECT currency, rate FROM fx_rate WHERE org_id = $1 AND month = $2 AND reporting = $3`, [orgId, month, reporting]));
  return new Map(rs.map((r) => [r.currency, Number(r.rate)]));
}

const H_SELECT = `SELECT h.*, to_char(h.trade_on, 'YYYY-MM-DD') AS trade_s, to_char(h.maturity_on, 'YYYY-MM-DD') AS mat_s, to_char(h.settled_on, 'YYYY-MM-DD') AS set_s,
  a.name AS account_name, a.kind AS account_kind, a.currency AS account_currency FROM fx_hedge h LEFT JOIN cash_account a ON a.id = h.cash_account_id`;

const hedgeView = (h: any) => ({
  id: String(h.id), bank: h.bank, reference: h.reference ?? null, buyCurrency: h.buy_currency, sellCurrency: h.sell_currency, notional: Number(h.notional_minor), rate: Number(h.rate),
  sellAmount: convert(Number(h.notional_minor), Number(h.rate), h.buy_currency, h.sell_currency), tradeOn: h.trade_s, maturityOn: h.mat_s, purpose: h.purpose ?? null, status: h.status as 'open' | 'settled' | 'cancelled',
  settledOn: h.set_s ?? null, settledRate: h.settled_rate == null ? null : Number(h.settled_rate), cashAccountId: h.cash_account_id == null ? null : String(h.cash_account_id), cashAccount: h.account_name ?? null,
  realised: h.status === 'settled' && h.settled_rate != null ? hedgeResult(Number(h.notional_minor), Number(h.rate), Number(h.settled_rate), h.buy_currency, h.sell_currency) : null,
});
export type HedgeView = ReturnType<typeof hedgeView>;

/** The hedges, each open one marked to market at the month's rate (the current month by default). */
export async function hedges(orgId: string, q: Record<string, unknown> = {}, now = new Date()) {
  const month = q.month == null || q.month === '' ? today(now).slice(0, 7) : String(q.month);
  if (!MONTH_RE.test(month)) throw ERR(400, 'month is YYYY-MM.');
  const reporting = (await outsideRequestScope(() => one<{ reporting_currency: string | null }>(`SELECT reporting_currency FROM finance_org_settings WHERE org_id = $1`, [orgId])))?.reporting_currency ?? null;
  const rates = reporting ? await monthRates(orgId, month, reporting) : new Map<string, number>();
  const rows = await outsideRequestScope(() => many<any>(`${H_SELECT} WHERE h.org_id = $1 ORDER BY (h.status = 'open') DESC, h.maturity_on, h.id`, [orgId]));
  const t = today(now);
  const list = rows.map(hedgeView).map((h) => {
    const market = reporting ? crossRate(rates, reporting, h.buyCurrency, h.sellCurrency) : null;
    const mtm = h.status === 'open' && market != null ? hedgeResult(h.notional, h.rate, market, h.buyCurrency, h.sellCurrency) : null;
    return { ...h, marketRate: h.status === 'open' ? market : null, markToMarket: mtm, daysToMaturity: h.status === 'open' ? Math.round((Date.parse(`${h.maturityOn}T00:00:00Z`) - Date.parse(`${t}T00:00:00Z`)) / 86_400_000) : null };
  });
  const totals: Record<string, { open: number; markToMarket: number; realised: number; unmarked: number }> = {};
  for (const h of list) {
    const c = (totals[h.sellCurrency] ??= { open: 0, markToMarket: 0, realised: 0, unmarked: 0 });
    if (h.status === 'open') { c.open++; if (h.markToMarket == null) c.unmarked++; else c.markToMarket += h.markToMarket; }
    if (h.realised != null) c.realised += h.realised;
  }
  return { month, reportingCurrency: reporting, hedges: list, totals };
}

async function hRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw ERR(404, 'No such hedge.');
  const r = await outsideRequestScope(() => one<any>(`${H_SELECT} WHERE h.id = $1 AND h.org_id = $2`, [id, orgId]));
  if (!r) throw ERR(404, 'No such hedge.');
  return r;
}

async function account(orgId: string, raw: unknown, currency: string): Promise<string | null> {
  if (raw == null || raw === '') return null;
  const id = String(raw);
  if (!/^\d{1,18}$/.test(id)) throw ERR(422, 'cashAccountId is not one of your cash accounts.');
  const a = await outsideRequestScope(() => one<{ currency: string }>(`SELECT currency FROM cash_account WHERE id = $1 AND org_id = $2`, [id, orgId]));
  if (!a) throw ERR(422, 'cashAccountId is not one of your cash accounts.');
  if (a.currency !== currency) throw ERR(422, `The settlement account is in ${a.currency}; a hedge settles in the currency sold (${currency}).`);
  return id;
}

export async function createHedge(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const bank = String(b.bank ?? '').trim();
  const buy = String(b.buyCurrency ?? '').toUpperCase(), sell = String(b.sellCurrency ?? '').toUpperCase();
  const notional = Number(b.notional), rate = Number(b.rate);
  const tradeOn = String(b.tradeOn ?? ''), maturityOn = String(b.maturityOn ?? '');
  if (!bank || bank.length > 120) throw ERR(422, 'bank is required (up to 120 characters).');
  if (!CUR_RE.test(buy) || !CUR_RE.test(sell)) throw ERR(422, 'buyCurrency and sellCurrency are ISO codes.');
  if (buy === sell) throw ERR(422, 'A hedge buys one currency against another.');
  if (!Number.isSafeInteger(notional) || notional <= 0) throw ERR(422, 'notional is a positive amount in minor units of the currency bought.');
  if (!Number.isFinite(rate) || rate <= 0) throw ERR(422, 'rate is the contract rate: one unit bought, in the currency sold.');
  if (!DATE_RE.test(tradeOn) || !DATE_RE.test(maturityOn)) throw ERR(422, 'tradeOn and maturityOn are days (YYYY-MM-DD).');
  if (maturityOn < tradeOn) throw ERR(422, 'The maturity is on or after the trade date.');
  const ref = b.reference == null || b.reference === '' ? null : String(b.reference).slice(0, 80);
  const purpose = b.purpose == null || b.purpose === '' ? null : String(b.purpose).slice(0, 300);
  const acct = await account(orgId, b.cashAccountId, sell);
  const r = await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO fx_hedge (org_id, bank, reference, buy_currency, sell_currency, notional_minor, rate, trade_on, maturity_on, purpose, cash_account_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [orgId, bank, ref, buy, sell, notional, rate, tradeOn, maturityOn, purpose, acct, userId]));
  return hedgeView(await hRow(orgId, String(r!.id)));
}

/** Settle (at the rate of the day) or cancel an open hedge. */
export async function updateHedge(orgId: string, id: string, b: Record<string, unknown>) {
  const h = await hRow(orgId, id);
  const status = String(b.status ?? '');
  if (h.status !== 'open') throw ERR(409, `This hedge is already ${h.status}.`);
  if (status === 'cancelled') {
    await outsideRequestScope(() => query(`UPDATE fx_hedge SET status = 'cancelled' WHERE id = $1 AND org_id = $2`, [id, orgId]));
  } else if (status === 'settled') {
    const on = String(b.settledOn ?? ''), rate = Number(b.settledRate);
    if (!DATE_RE.test(on)) throw ERR(422, 'settledOn is a day (YYYY-MM-DD).');
    if (on < h.trade_s) throw ERR(422, 'A hedge settles on or after its trade date.');
    if (!Number.isFinite(rate) || rate <= 0) throw ERR(422, 'settledRate is the rate of the day: one unit bought, in the currency sold.');
    await assertOpen(orgId, on.slice(0, 7), 'A hedge settlement', ERR);
    const acct = b.cashAccountId === undefined ? (h.cash_account_id == null ? null : String(h.cash_account_id)) : await account(orgId, b.cashAccountId, h.sell_currency);
    await outsideRequestScope(() => query(`UPDATE fx_hedge SET status = 'settled', settled_on = $3, settled_rate = $4, cash_account_id = $5 WHERE id = $1 AND org_id = $2`, [id, orgId, on, rate, acct]));
  } else throw ERR(422, 'status is settled (with settledOn and settledRate) or cancelled.');
  return hedgeView(await hRow(orgId, id));
}

/** The ledger's fx journal for a month: each hedge settled in it, net. */
export async function journal(orgId: string, month: string) {
  const rows = await outsideRequestScope(() => many<any>(`${H_SELECT} WHERE h.org_id = $1 AND h.status = 'settled' AND to_char(h.settled_on, 'YYYY-MM') = $2`, [orgId, month]));
  const out: Record<string, Array<{ account: string; debit: number; credit: number; description: string }>> = {};
  for (const h of rows) {
    const v = hedgeView(h), r = v.realised ?? 0;
    if (!r) continue;
    const L = (out[v.sellCurrency] ??= []), bank = h.account_kind === 'cash' ? '1050' : '1100';
    const d = `FX hedge ${v.reference ?? v.id} (${v.bank}) ${v.buyCurrency}/${v.sellCurrency} settled`.slice(0, 120);
    if (r > 0) L.push({ account: bank, debit: r, credit: 0, description: d }, { account: '7400', debit: 0, credit: r, description: d });
    else L.push({ account: '8400', debit: -r, credit: 0, description: d }, { account: bank, debit: 0, credit: -r, description: d });
  }
  return out;
}

/** Settled hedges' cash, for the cash position's moves. */
export async function cashMoves(orgId: string, upTo: string) {
  const rows = await outsideRequestScope(() => many<any>(`${H_SELECT} WHERE h.org_id = $1 AND h.status = 'settled' AND h.cash_account_id IS NOT NULL AND h.settled_on <= $2::date`, [orgId, upTo]));
  return rows.map((h) => { const v = hedgeView(h); return { account_id: v.cashAccountId!, d: v.settledOn!, amount: v.realised ?? 0 }; }).filter((m) => m.amount);
}

// ─────────────────────────────────────────── exposure

type Line = { cash: number; receivables: number; payables: number; loans: number; hedges: number };

/** The exposure per currency other than the reporting one, at a day (today by default). */
export async function exposure(orgId: string, q: Record<string, unknown> = {}, now = new Date()) {
  const day = q.date == null || q.date === '' ? today(now) : String(q.date);
  if (!DATE_RE.test(day) || day > today(now)) throw ERR(422, 'date is a day (YYYY-MM-DD), not in the future.');
  const month = day.slice(0, 7), prev = prevMonth(month);
  const reporting = (await outsideRequestScope(() => one<{ reporting_currency: string | null }>(`SELECT reporting_currency FROM finance_org_settings WHERE org_id = $1`, [orgId])))?.reporting_currency ?? null;
  const per: Record<string, Line> = {};
  const L = (c: string) => (per[c] ??= { cash: 0, receivables: 0, payables: 0, loans: 0, hedges: 0 });
  const [{ position }, bills, lenders] = await Promise.all([import('./cash-position.js'), import('./supplier-bills.js'), import('./lenders.js')]);
  const pos = await position(orgId, { date: day }, now);
  for (const [c, t] of Object.entries(pos.totals)) L(c).cash += t.total;
  for (const r of await outsideRequestScope(() => many<{ currency: string; t: string }>(
    `SELECT currency, sum(total_minor)::bigint AS t FROM fleet_invoice WHERE org_id = $1 AND status = 'issued' GROUP BY 1`, [orgId]))) L(r.currency).receivables += Number(r.t);
  for (const c of (await bills.payables(orgId, now)).currencies) L(c.currency).payables += c.total;
  for (const l of await lenders.loans(orgId)) if (l.status === 'active' && l.balance > 0) L(l.currency).loans += l.balance;
  const hs = (await hedges(orgId, { month }, now)).hedges.filter((h) => h.status === 'open');
  for (const h of hs) { L(h.buyCurrency).hedges += h.notional; L(h.sellCurrency).hedges -= h.sellAmount; }
  const [now_, before] = reporting ? await Promise.all([monthRates(orgId, month, reporting), monthRates(orgId, prev, reporting)]) : [new Map<string, number>(), new Map<string, number>()];
  const currencies = Object.entries(per).filter(([c]) => c !== reporting).map(([currency, l]) => {
    const gross = l.cash + l.receivables - l.payables - l.loans, net = gross + l.hedges;
    const rate = reporting ? crossRate(now_, reporting, currency, reporting) : null;
    const prevRate = reporting ? crossRate(before, reporting, currency, reporting) : null;
    return {
      currency, ...l, gross, net, hedgedPct: gross === 0 ? 0 : Math.max(0, Math.min(100, Math.round((-l.hedges / gross) * 1000) / 10)),
      rate, previousRate: prevRate,
      netReporting: rate == null ? null : convert(net, rate, currency, reporting!),
      revaluation: rate == null || prevRate == null ? null : convert(net, rate - prevRate, currency, reporting!),
      sensitivity: rate == null ? null : convert(net, rate * SENSITIVITY_PCT / 100, currency, reporting!),
    };
  }).sort((a, b) => Math.abs(b.netReporting ?? 0) - Math.abs(a.netReporting ?? 0));
  const known = currencies.filter((c) => c.netReporting != null);
  return {
    date: day, month, previousMonth: prev, reportingCurrency: reporting, sensitivityPct: SENSITIVITY_PCT, currencies,
    total: reporting ? { currency: reporting, net: known.reduce((a, c) => a + c.netReporting!, 0), revaluation: known.reduce((a, c) => a + (c.revaluation ?? 0), 0), sensitivity: known.reduce((a, c) => a + Math.abs(c.sensitivity ?? 0), 0) } : null,
    missingRates: currencies.filter((c) => c.rate == null).map((c) => c.currency),
  };
}

export async function exposureXlsx(orgId: string, q: Record<string, unknown> = {}, now = new Date()): Promise<Buffer> {
  const [e, h] = await Promise.all([exposure(orgId, q, now), hedges(orgId, { month: q.date ? String(q.date).slice(0, 7) : undefined }, now)]);
  return xlsx([
    { name: 'Exposure', rows: [['Currency', 'Cash', 'Receivables', 'Payables', 'Loans', 'Gross', 'Hedges', 'Net', 'Hedged %', 'Rate', 'Previous rate', `Net (${e.reportingCurrency ?? '-'})`, 'Revaluation', `${e.sensitivityPct}% move`],
      ...e.currencies.map((c) => [c.currency, c.cash, c.receivables, c.payables, c.loans, c.gross, c.hedges, c.net, c.hedgedPct, c.rate, c.previousRate, c.netReporting, c.revaluation, c.sensitivity])],
      widths: [9, 14, 14, 14, 14, 14, 14, 14, 9, 12, 12, 16, 14, 14], formats: [null, 'money', 'money', 'money', 'money', 'money', 'money', 'money', null, null, null, 'money', 'money', 'money'] },
    { name: 'Hedges', rows: [['Bank', 'Reference', 'Buy', 'Sell', 'Notional', 'Rate', 'Sold', 'Trade', 'Maturity', 'Status', 'Market rate', 'Mark to market', 'Settled', 'Settled rate', 'Realised'],
      ...h.hedges.map((x) => [x.bank, x.reference ?? '', x.buyCurrency, x.sellCurrency, x.notional, x.rate, x.sellAmount, x.tradeOn, x.maturityOn, x.status, x.marketRate, x.markToMarket, x.settledOn ?? '', x.settledRate, x.realised])],
      widths: [18, 14, 6, 6, 14, 12, 16, 11, 11, 10, 12, 14, 11, 12, 14], formats: [null, null, null, null, 'money', null, 'money', null, null, null, null, 'money', null, null, 'money'] },
  ]);
}
