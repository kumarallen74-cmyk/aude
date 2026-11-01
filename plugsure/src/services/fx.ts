import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { assertOpen } from './finance-periods.js';
import { CURRENCIES } from '../domain/money.js';

/**
 * Multi-currency consolidation (v1.21.0). An operator with sites in several currencies (IDR, MYR, SGD) sets a
 * reporting currency (Finance → Settings → Currencies) and a rate per month from each other currency to it:
 *
 *   manual  entered by Finance (e.g. the bank's or Bank Indonesia's month-end rate, as the accountant books it)
 *   ecb     fetched from the European Central Bank's reference rates (frankfurter API; FX_RATES_URL to change it),
 *           for the month's last day (or the latest, for the current month)
 *
 * Totals per currency stay as they are; consolidated totals are added beside them in Summary, Margin and Budgets, with
 * the currencies that had no rate for the month listed (never silently left out or counted at 1).
 */

export class FxError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const CUR_RE = /^[A-Z]{3}$/;
const FX_URL = () => (process.env.FX_RATES_URL ?? 'https://api.frankfurter.app').replace(/\/+$/, '');

export async function reportingCurrency(orgId: string): Promise<string | null> {
  const r = await outsideRequestScope(() => one<{ reporting_currency: string | null }>(`SELECT reporting_currency FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  return r?.reporting_currency ?? null;
}

/** The currencies an organisation's sites use (from their countries). */
export async function currencies(orgId: string): Promise<string[]> {
  const rows = await outsideRequestScope(() => many<{ currency: string }>(
    `SELECT DISTINCT co.currency FROM site s JOIN country co ON co.code = s.country_code WHERE s.org_id = $1 AND s.archived_at IS NULL ORDER BY 1`, [orgId]));
  return rows.map((r) => r.currency);
}

export async function setReporting(orgId: string, curRaw: unknown, userId: string | null) {
  const cur = curRaw == null || curRaw === '' ? null : String(curRaw).toUpperCase();
  if (cur && !CUR_RE.test(cur)) throw new FxError(422, 'The reporting currency is an ISO code (IDR, MYR, SGD…).');
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, reporting_currency, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET reporting_currency = EXCLUDED.reporting_currency, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, cur, userId]));
  return { reportingCurrency: cur };
}

/** The rates of a month (or the last 12 months) into the reporting currency. */
export async function rates(orgId: string, monthRaw?: unknown) {
  const reporting = await reportingCurrency(orgId);
  const month = monthRaw == null || monthRaw === '' ? null : String(monthRaw);
  if (month && !MONTH_RE.test(month)) throw new FxError(400, 'month is YYYY-MM.');
  const rows = reporting ? await outsideRequestScope(() => many<any>(
    `SELECT r.*, u.name AS by_name FROM fx_rate r LEFT JOIN app_user u ON u.id = r.updated_by
      WHERE r.org_id = $1 AND r.reporting = $2 AND ($3::text IS NULL OR r.month = $3) ORDER BY r.month DESC, r.currency LIMIT 500`, [orgId, reporting, month])) : [];
  return {
    reportingCurrency: reporting, currencies: await currencies(orgId),
    rates: rows.map((r) => ({ month: r.month, currency: r.currency, rate: Number(r.rate), source: r.source, by: r.by_name ?? null, at: new Date(r.updated_at).toISOString() })),
  };
}

export async function setRate(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const reporting = await reportingCurrency(orgId);
  if (!reporting) throw new FxError(409, 'Choose the reporting currency first.');
  const month = String(b.month ?? ''), cur = String(b.currency ?? '').toUpperCase(), rate = Number(b.rate);
  if (!MONTH_RE.test(month)) throw new FxError(422, 'month is YYYY-MM.');
  if (!CUR_RE.test(cur) || cur === reporting) throw new FxError(422, `currency is another ISO code than ${reporting}.`);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1e9) throw new FxError(422, `rate is how many ${reporting} one ${cur} is worth (more than 0).`);
  await assertOpen(orgId, month, 'An exchange rate', (st, msg) => new FxError(st, msg));
  await upsert(orgId, month, cur, reporting, rate, 'manual', userId);
  return { month, currency: cur, reporting, rate };
}

async function upsert(orgId: string, month: string, cur: string, reporting: string, rate: number, source: 'manual' | 'ecb', userId: string | null) {
  await outsideRequestScope(() => query(
    `INSERT INTO fx_rate (org_id, month, currency, reporting, rate, source, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (org_id, month, currency, reporting) DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, month, cur, reporting, rate, source, userId]));
}

/** Fetch a month's ECB reference rates for the organisation's other currencies. */
export async function fetchEcb(orgId: string, monthRaw: unknown, userId: string | null, now = new Date()) {
  const reporting = await reportingCurrency(orgId);
  if (!reporting) throw new FxError(409, 'Choose the reporting currency first.');
  const month = String(monthRaw ?? '');
  if (!MONTH_RE.test(month)) throw new FxError(422, 'month is YYYY-MM.');
  await assertOpen(orgId, month, 'An exchange rate', (st, msg) => new FxError(st, msg));
  const others = (await currencies(orgId)).filter((c) => c !== reporting);
  if (!others.length) throw new FxError(409, `All your sites use ${reporting}: there is nothing to convert.`);
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
  const date = last > now ? 'latest' : last.toISOString().slice(0, 10);
  const got: Array<{ currency: string; rate: number }> = [];
  const failed: Array<{ currency: string; error: string }> = [];
  for (const cur of others) {
    try {
      const r = await fetch(`${FX_URL()}/${date}?from=${cur}&to=${reporting}`, { signal: AbortSignal.timeout(10_000) });
      const j: any = await r.json().catch(() => null);
      const rate = Number(j?.rates?.[reporting]);
      if (!r.ok || !Number.isFinite(rate) || rate <= 0) throw new Error(`no ${cur}→${reporting} rate (HTTP ${r.status})`);
      await upsert(orgId, month, cur, reporting, rate, 'ecb', userId);
      got.push({ currency: cur, rate });
    } catch (e) {
      logger.warn({ cur, err: (e as Error).message }, 'ECB rate fetch failed');
      failed.push({ currency: cur, error: (e as Error).message.slice(0, 200) });
    }
  }
  if (!got.length) throw new FxError(502, `No rate could be fetched: ${failed.map((f) => `${f.currency} (${f.error})`).join('; ')}. Enter them by hand.`);
  return { month, reporting, date, rates: got, failed };
}

const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK']);
/** A currency's minor-unit exponent (the platform's own, else ISO: 0 for a few, 2 otherwise). */
export const exponentOf = (c: string): number => (CURRENCIES as Record<string, { exponent: number }>)[c]?.exponent ?? (ZERO_DECIMAL.has(c) ? 0 : 2);
/**
 * (v1.38.0) An amount in minor units of `from` at a rate per major unit (one MYR in IDR, as entered or fetched), in minor
 * units of `to`: the rate applies to major units, so the two currencies' exponents scale it (sen into rupiah). Unrounded
 * so totals round once. Pure.
 */
export function convertExact(amountMinor: number, rate: number, from: string, to: string): number {
  return (amountMinor / 10 ** exponentOf(from)) * rate * 10 ** exponentOf(to);
}
export const convert = (amountMinor: number, rate: number, from: string, to: string): number => Math.round(convertExact(amountMinor, rate, from, to));

/** Consolidate amounts per currency into the reporting currency for a month; the currencies without a rate are listed. */
export async function consolidate(orgId: string, month: string, byCurrency: Record<string, number>) {
  const reporting = await reportingCurrency(orgId);
  if (!reporting) return null;
  const rs = await outsideRequestScope(() => many<{ currency: string; rate: string }>(`SELECT currency, rate FROM fx_rate WHERE org_id = $1 AND month = $2 AND reporting = $3`, [orgId, month, reporting]));
  const rate = new Map(rs.map((r) => [r.currency, Number(r.rate)]));
  let amount = 0;
  const missing: string[] = [];
  for (const [cur, v] of Object.entries(byCurrency)) {
    if (!v) continue;
    if (cur === reporting) amount += v;
    else if (rate.has(cur)) amount += convertExact(v, rate.get(cur)!, cur, reporting);
    else missing.push(cur);
  }
  return { currency: reporting, amount: Math.round(amount), missing };
}
