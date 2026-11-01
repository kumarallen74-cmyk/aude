import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { knownFlows } from './cash-position.js';
import { lastNet } from './payroll.js';
import { remainingSpend } from './capex-projects.js';

/**
 * The cash forecast (v1.33.0): a daily forecast of the cash position over 30 to 180 days, per currency.
 *
 *   known       the committed flows of the 13-week view: gateway settlements and the money the gateway forecast
 *               expects in and out, fleet invoices, owner shares, supplier bills by due date, leases, deposits maturing
 *   learned     the money charging brings in, learnt from the last 180 days of charge records: a weekday pattern
 *               (each weekday's share of a week, from the last 12 weeks) and a level and trend (Holt's double
 *               exponential smoothing of the series without the weekday pattern); a band of ±1.28 standard deviations of
 *               the one-day-ahead errors (about 80%) gives the pessimistic and optimistic lines
 *   recurring   payroll: the last run's net pay on the 25th of each month not yet paid
 *   capex       open projects' commitments and remaining budget, spread weekly to their target dates
 *
 * Scenarios: collections at a percentage (default 100), supplier bills paid N days later, capex in or out. The first
 * day the position (or its pessimistic line) goes below the accounts' minimums is shown; the worker raises
 * finance.cash_forecast_shortfall when the expected position does within the horizon. Each day's forecast is stored, and
 * the forecast's accuracy (weighted absolute percentage error of the collections, last 30 days) is shown beside it.
 */

export class CashForecastError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const SHORTFALL = 'finance.cash_forecast_shortfall';
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

export interface Model { level: number; trend: number; season: number[]; sigma: number; days: number; wape: number | null }

/**
 * Learn a daily series (oldest first, one value per day ending yesterday) and forecast `horizon` days from `start`.
 * Pure, so it is tested directly.
 */
export function learn(series: Array<{ day: string; amount: number }>, start: string, horizon: number, alpha = 0.3, beta = 0.05) {
  const n = series.length;
  const season = Array.from({ length: 7 }, () => 1);
  const recent = series.slice(-84);
  const mean = recent.length ? recent.reduce((s, x) => s + x.amount, 0) / recent.length : 0;
  if (mean > 0) {
    for (let w = 0; w < 7; w++) {
      const xs = recent.filter((x) => weekday(x.day) === w);
      season[w] = xs.length ? Math.max(0.05, xs.reduce((s, x) => s + x.amount, 0) / xs.length / mean) : 1;
    }
  }
  let level = 0, trend = 0;
  const errs: Array<{ a: number; e: number }> = [];
  series.forEach((x, i) => {
    const s = season[weekday(x.day)]!;
    const y = x.amount / s;
    if (i === 0) { level = y; return; }
    const pred = (level + trend) * s;
    if (i >= n - 56) errs.push({ a: x.amount, e: pred });
    const prevLevel = level;
    level = alpha * y + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  });
  const sigma = errs.length > 1 ? Math.sqrt(errs.reduce((s, x) => s + (x.a - x.e) ** 2, 0) / (errs.length - 1)) : 0;
  const totalA = errs.reduce((s, x) => s + Math.abs(x.a), 0);
  const wape = totalA ? Math.round((errs.reduce((s, x) => s + Math.abs(x.a - x.e), 0) / totalA) * 1000) / 10 : null;
  const out = Array.from({ length: horizon }, (_, h) => {
    const day = addDays(start, h);
    const s = season[weekday(day)]!;
    const expected = Math.max(0, Math.round((level + trend * (h + 1)) * s));
    const band = Math.round(1.28 * sigma * Math.sqrt(1 + h / 30));
    return { day, expected, low: Math.max(0, expected - band), high: expected + band };
  });
  const model: Model = { level: Math.round(level), trend: Math.round(trend * 100) / 100, season: season.map((x) => Math.round(x * 1000) / 1000), sigma: Math.round(sigma), days: n, wape };
  return { daily: out, model };
}

/** Daily collections (charge records issued, total with tax) per currency over the last `days` days, ending yesterday. */
async function history(orgId: string, days: number, now = new Date()) {
  const t = today(now);
  const rows = await outsideRequestScope(() => many<{ d: string; currency: string; amount: string }>(
    `SELECT to_char((issued_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS d, currency, sum(total_minor)::bigint AS amount FROM cdr
      WHERE org_id = $1 AND NOT COALESCE(test_mode, false) AND (issued_at AT TIME ZONE $3)::date >= ($2::date - $4::int) AND (issued_at AT TIME ZONE $3)::date < $2::date GROUP BY 1, 2`, [orgId, t, zone(), days]));
  const by: Record<string, Map<string, number>> = {};
  for (const r of rows) (by[r.currency] ??= new Map()).set(r.d, Number(r.amount));
  const out: Record<string, Array<{ day: string; amount: number }>> = {};
  for (const [c, m] of Object.entries(by)) {
    const first = [...m.keys()].sort()[0]!;
    const series: Array<{ day: string; amount: number }> = [];
    for (let d = first; d < t; d = addDays(d, 1)) series.push({ day: d, amount: m.get(d) ?? 0 });
    out[c] = series;
  }
  return out;
}

export async function settings(orgId: string) {
  const r = await outsideRequestScope(() => one<{ cash_forecast: any }>(`SELECT cash_forecast FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const s = r?.cash_forecast ?? {};
  return { horizonDays: Number(s.horizonDays ?? 90), collectionsPct: Number(s.collectionsPct ?? 100), alert: s.alert !== false };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const cur = await settings(orgId);
  const h = b.horizonDays === undefined ? cur.horizonDays : Number(b.horizonDays);
  if (!Number.isInteger(h) || h < 30 || h > 180) throw new CashForecastError(422, 'horizonDays is 30 to 180.');
  const pct = b.collectionsPct === undefined ? cur.collectionsPct : Number(b.collectionsPct);
  if (!Number.isFinite(pct) || pct < 0 || pct > 200) throw new CashForecastError(422, 'collectionsPct is 0 to 200.');
  const v = { horizonDays: h, collectionsPct: pct, alert: b.alert === undefined ? cur.alert : b.alert === true || b.alert === 'true' };
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, cash_forecast, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET cash_forecast = EXCLUDED.cash_forecast, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify(v), userId]));
  return v;
}

/** The forecast, with the scenario's levers. */
export async function forecast(orgId: string, q: Record<string, unknown> = {}, now = new Date()) {
  const st = await settings(orgId);
  const horizon = q.horizonDays == null || q.horizonDays === '' ? st.horizonDays : Number(q.horizonDays);
  if (!Number.isInteger(horizon) || horizon < 7 || horizon > 180) throw new CashForecastError(422, 'horizonDays is 7 to 180.');
  const pct = q.collectionsPct == null || q.collectionsPct === '' ? st.collectionsPct : Number(q.collectionsPct);
  if (!Number.isFinite(pct) || pct < 0 || pct > 200) throw new CashForecastError(422, 'collectionsPct is 0 to 200.');
  const delay = q.delayBillsDays == null || q.delayBillsDays === '' ? 0 : Number(q.delayBillsDays);
  if (!Number.isInteger(delay) || delay < 0 || delay > 90) throw new CashForecastError(422, 'delayBillsDays is 0 to 90.');
  const capex = q.capex == null || q.capex === '' ? true : q.capex === true || q.capex === 'true';
  const t = today(now);
  const end = addDays(t, horizon - 1);
  const [known, hist, nets, cap] = await Promise.all([knownFlows(orgId, horizon, now), history(orgId, 180, now), lastNet(orgId), capex ? remainingSpend(orgId, t, end) : Promise.resolve([])]);
  const flows = known.flows.map((f) => (f.kind === 'supplier_bill' && delay ? { ...f, day: addDays(f.day, delay) } : f)).filter((f) => f.day <= end);
  // Payroll: the last net pay on the 25th of each month in the horizon not already paid (or this month's, if approved and not paid).
  const paidMonths = new Set((await outsideRequestScope(() => many<{ k: string }>(`SELECT currency || '|' || month AS k FROM payroll_run WHERE org_id = $1 AND status = 'paid'`, [orgId]))).map((r) => r.k));
  for (const n of nets) {
    for (let d = `${t.slice(0, 7)}-25`; d <= end; d = (() => { const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); return x.toISOString().slice(0, 10); })()) {
      if (paidMonths.has(`${n.currency}|${d.slice(0, 7)}`)) continue;
      flows.push({ day: d < t ? t : d, currency: n.currency, kind: 'payroll', label: `Payroll ${d.slice(0, 7)} (estimate from ${n.month})`, amount: -Number(n.net) });
    }
  }
  for (const c of cap) flows.push({ day: c.day, currency: c.currency, kind: 'capex', label: c.label, amount: c.amount });
  const currencies = [...new Set([...Object.keys(known.pos.totals), ...Object.keys(hist), ...flows.map((f) => f.currency)])].sort();
  const out = currencies.map((currency) => {
    const series = hist[currency] ?? [];
    const l = series.length >= 14 ? learn(series, t, horizon) : null;
    const opening = known.pos.totals[currency]?.total ?? 0;
    const minimum = known.pos.totals[currency]?.minimum ?? 0;
    let closing = opening, low = opening, high = opening;
    let firstBelow = null as string | null, firstBelowLow = null as string | null;
    let lowest = { day: t, closing: opening };
    const days = Array.from({ length: horizon }, (_, k) => {
      const day = addDays(t, k);
      const fs = flows.filter((f) => f.currency === currency && f.day === day);
      const inflow = fs.filter((f) => f.amount > 0).reduce((s, f) => s + f.amount, 0);
      const outflow = fs.filter((f) => f.amount < 0).reduce((s, f) => s + f.amount, 0);
      const c = l?.daily[k];
      const learned = c ? Math.round((c.expected * pct) / 100) : 0;
      closing += inflow + outflow + learned;
      low += inflow + outflow + (c ? Math.round((c.low * pct) / 100) : 0);
      high += inflow + outflow + (c ? Math.round((c.high * pct) / 100) : 0);
      if (!firstBelow && closing < minimum) firstBelow = day;
      if (!firstBelowLow && low < minimum) firstBelowLow = day;
      if (closing < lowest.closing) lowest = { day, closing };
      return { day, in: inflow, out: outflow, learned, closing, low, high };
    });
    return {
      currency, opening, minimum, closing, lowest, firstBelowMinimum: firstBelow, firstBelowMinimumPessimistic: firstBelowLow,
      model: l?.model ?? null, learnedTotal: days.reduce((s, d) => s + d.learned, 0),
      message: l ? null : series.length ? `Only ${series.length} day(s) of charging history: at least 14 are needed to learn the collections.` : 'No charging history in this currency: only the committed flows are forecast.',
      days, largest: flows.filter((f) => f.currency === currency).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 15),
    };
  });
  return { from: t, to: end, horizonDays: horizon, scenario: { collectionsPct: pct, delayBillsDays: delay, capex }, settings: st, currencies: out, notes: known.notes, accuracy: await accuracy(orgId, now) };
}

/** How good the stored forecasts' collections were, per currency, over the last 30 days (WAPE %). */
export async function accuracy(orgId: string, now = new Date()) {
  const t = today(now);
  const runs = await outsideRequestScope(() => many<any>(`SELECT to_char(run_on, 'YYYY-MM-DD') AS d, currency, data FROM cash_forecast_run WHERE org_id = $1 AND run_on >= ($2::date - 30) AND run_on < $2::date ORDER BY run_on`, [orgId, t]));
  if (!runs.length) return {};
  const hist = await history(orgId, 40, now);
  const out: Record<string, { days: number; wape: number | null }> = {};
  for (const c of new Set(runs.map((r) => r.currency))) {
    const actual = new Map((hist[c] ?? []).map((x) => [x.day, x.amount]));
    let err = 0, tot = 0, days = 0;
    for (const r of runs.filter((x) => x.currency === c)) {
      // The forecast made on a day, for that day (one day ahead).
      const e = (r.data?.collections ?? []).find((x: any) => x.day === r.d);
      const a = actual.get(r.d);
      if (e == null || a == null) continue;
      err += Math.abs(a - Number(e.expected)); tot += Math.abs(a); days++;
    }
    out[c] = { days, wape: tot ? Math.round((err / tot) * 1000) / 10 : null };
  }
  return out;
}

/** Store today's forecast (collections and closing per day) and raise or resolve the shortfall alert. */
export async function snapshot(orgId: string, now = new Date()) {
  const f = await forecast(orgId, {}, now);
  for (const c of f.currencies) {
    await outsideRequestScope(() => query(
      `INSERT INTO cash_forecast_run (org_id, run_on, currency, data) VALUES ($1, $2, $3, $4) ON CONFLICT (org_id, run_on, currency) DO UPDATE SET data = EXCLUDED.data, created_at = now()`,
      [orgId, f.from, c.currency, JSON.stringify({ collections: c.days.map((d) => ({ day: d.day, expected: d.learned })), closing: c.days.map((d) => ({ day: d.day, closing: d.closing })), model: c.model })]));
    const key = `${orgId}:${c.currency}`;
    const below = c.firstBelowMinimum as string | null;
    if (f.settings.alert && below) {
      await outsideRequestScope(() => persistAlert({ orgId, kind: SHORTFALL, severity: below <= addDays(f.from, 14) ? 'critical' : 'warning', targetType: 'organisation', targetId: key,
        message: `Cash (${c.currency}) is forecast below the accounts' minimum from ${below}; lowest ${c.lowest.closing} on ${c.lowest.day}. Finance → Cash forecast.` })).catch(() => null);
    } else await outsideRequestScope(() => resolveAlertsFor(orgId, SHORTFALL, 'organisation', key)).catch(() => 0);
  }
  return { date: f.from, currencies: f.currencies.length };
}

/** Every 6 hours: each organisation with cash accounts or charging, once a day. */
export async function sweep(now = new Date()): Promise<number> {
  const orgs = await outsideRequestScope(() => many<{ org_id: string }>(
    `SELECT DISTINCT a.org_id FROM cash_account a WHERE a.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM cash_forecast_run r WHERE r.org_id = a.org_id AND r.run_on = $1::date)`, [today(now)]));
  let n = 0;
  for (const o of orgs) {
    try { await snapshot(o.org_id, now); n++; } catch (e) { logger.warn({ org: o.org_id, err: (e as Error).message }, 'cash forecast snapshot failed'); }
  }
  return n;
}
