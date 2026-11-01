import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';

/**
 * Rolling twelve-month forecast (v1.28.0), per site and per currency for the organisation, without machine learning:
 *
 *   history      revenue (before tax) and kWh per site and month, up to 24 ended months
 *   trend        a straight line fitted to the last 12 months (least squares; with fewer than 6 months of history,
 *                flat at the average)
 *   seasonality  with 13 months or more, each calendar month's average against the overall average (1 otherwise)
 *   forecast     trend × seasonality for the next 12 months, then the scenario: growth % a year (compounded
 *                monthly), a price change %, an energy cost change %
 *   energy cost  the site's energy cost per revenue over the last 3 months (bills or its cost per kWh), applied to
 *                the forecast revenue
 *   budget       the month's revenue budget (Budgets), and the variance; an alert when the next 3 months' forecast is
 *                below budget by more than the threshold (finance.forecast_below_budget, daily)
 */

export class ForecastError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const ALERT = 'finance.forecast_below_budget';
export const MIN_TREND_MONTHS = 6;
const zone = () => config.billing.timeZone;
const r0 = (n: number) => Math.round(n);
const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
function months(from: string, n: number, dir: 1 | -1): string[] {
  let [y, m] = from.split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = 0; i < n; i++) { m += dir; if (m === 0) { m = 12; y--; } if (m === 13) { m = 1; y++; } out.push(ym(y, m)); }
  return dir === -1 ? out.reverse() : out;
}
const thisMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(new Date()).slice(0, 7);

export interface Scenario { growthPct: number; pricePct: number; energyPct: number; alertPct: number }

export async function settings(orgId: string): Promise<Scenario> {
  const r = await outsideRequestScope(() => one<{ forecast: any }>(`SELECT forecast FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const v = r?.forecast ?? {};
  return { growthPct: Number(v.growthPct ?? 0), pricePct: Number(v.pricePct ?? 0), energyPct: Number(v.energyPct ?? 0), alertPct: Number(v.alertPct ?? 10) };
}

function scenarioOf(base: Scenario, q: Record<string, unknown>): Scenario {
  const num = (k: keyof Scenario, lo: number, hi: number) => {
    const raw = q[k];
    if (raw === undefined || raw === '') return base[k];
    const n = Number(raw);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new ForecastError(422, `${k} is ${lo} to ${hi}.`);
    return n;
  };
  return { growthPct: num('growthPct', -90, 500), pricePct: num('pricePct', -90, 200), energyPct: num('energyPct', -90, 300), alertPct: num('alertPct', 1, 90) };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const v = scenarioOf(await settings(orgId), b);
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, forecast, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET forecast = EXCLUDED.forecast, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify(v), userId]));
  return v;
}

/** Least-squares line through (0, y0) … (n−1, yn−1). */
export function fit(ys: number[]): { a: number; b: number } {
  const n = ys.length;
  if (n === 0) return { a: 0, b: 0 };
  if (n === 1) return { a: ys[0]!, b: 0 };
  const mx = (n - 1) / 2, my = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0, den = 0;
  ys.forEach((y, x) => { num += (x - mx) * (y - my); den += (x - mx) ** 2; });
  const b = den ? num / den : 0;
  return { a: my - b * mx, b };
}

/** Seasonal index per calendar month (1–12) from a history keyed by YYYY-MM; 1 where unknown or too short. */
export function seasonality(history: Array<{ month: string; revenue: number }>): number[] {
  const idx = new Array<number>(13).fill(1);
  if (history.length < 13) return idx;
  const avg = history.reduce((s, h) => s + h.revenue, 0) / history.length;
  if (!avg) return idx;
  for (let m = 1; m <= 12; m++) {
    const xs = history.filter((h) => Number(h.month.slice(5, 7)) === m).map((h) => h.revenue);
    if (xs.length) idx[m] = Math.max(0.2, Math.min(5, xs.reduce((s, x) => s + x, 0) / xs.length / avg));
  }
  return idx;
}

export async function forecast(orgId: string, q: Record<string, unknown> = {}) {
  const sc = scenarioOf(await settings(orgId), q);
  const now = thisMonth();
  const past = months(now, 24, -1);
  const ahead = months(now, 12, 1).slice(0, 12);
  const next = [now, ...ahead.slice(0, 11)];
  const [hist, sites, costs, budgets] = await Promise.all([
    outsideRequestScope(() => many<any>(
      `SELECT cs.site_id, d.currency, to_char(d.issued_at AT TIME ZONE $3, 'YYYY-MM') AS month, COALESCE(sum(d.subtotal_minor), 0)::bigint AS revenue, COALESCE(sum(cs.energy_wh), 0)::bigint AS wh
         FROM cdr d JOIN charging_session cs ON cs.id = d.session_id
        WHERE d.org_id = $1 AND NOT COALESCE(d.test_mode, false) AND cs.site_id IS NOT NULL AND to_char(d.issued_at AT TIME ZONE $3, 'YYYY-MM') = ANY($2::text[])
        GROUP BY 1, 2, 3`, [orgId, past, zone()])),
    outsideRequestScope(() => many<any>(`SELECT s.id, s.name, co.currency, r.rate_per_kwh FROM site s JOIN country co ON co.code = s.country_code LEFT JOIN site_energy_rate r ON r.site_id = s.id WHERE s.org_id = $1 AND s.archived_at IS NULL ORDER BY s.name`, [orgId])),
    outsideRequestScope(() => many<any>(`SELECT site_id, month, sum(amount_minor)::bigint AS amount FROM site_energy_cost WHERE org_id = $1 AND voided_at IS NULL AND month = ANY($2::text[]) GROUP BY 1, 2`, [orgId, past.slice(-3)])),
    outsideRequestScope(() => many<any>(`SELECT site_id, month, currency, revenue_minor FROM finance_budget WHERE org_id = $1 AND month = ANY($2::text[])`, [orgId, next])),
  ]);
  const growth = (k: number) => (1 + sc.growthPct / 100) ** (k / 12);
  const out = sites.map((s) => {
    const h = past.map((m) => {
      const r = hist.find((x) => x.site_id === s.id && x.month === m);
      return { month: m, revenue: Number(r?.revenue ?? 0), kwh: Number(r?.wh ?? 0) / 1000 };
    });
    const first = h.findIndex((x) => x.revenue > 0);
    const used = first < 0 ? [] : h.slice(first);
    const last12 = used.slice(-12);
    // With fewer than 6 months a line is noise: flat at the average.
    const flat = last12.length < MIN_TREND_MONTHS;
    const line = flat ? { a: last12.length ? last12.reduce((t, x) => t + x.revenue, 0) / last12.length : 0, b: 0 } : fit(last12.map((x) => x.revenue));
    const season = seasonality(used);
    // Deseasonalised level: the line is fitted on raw values; scale by the month's index over the index of the fitted window's average.
    const rev3 = h.slice(-3).reduce((a, x) => a + x.revenue, 0), kwh3 = h.slice(-3).reduce((a, x) => a + x.kwh, 0);
    const bill3 = costs.filter((c) => c.site_id === s.id).reduce((a, c) => a + Number(c.amount), 0);
    const est3 = s.rate_per_kwh != null ? kwh3 * Number(s.rate_per_kwh) : null;
    const energy3 = bill3 || est3 || 0;
    const costRatio = rev3 ? energy3 / rev3 : 0;
    const rows = next.map((m, k) => {
      const x = last12.length + k;
      const base = Math.max(0, line.a + line.b * x) * (season[Number(m.slice(5, 7))] ?? 1);
      const revenue = r0(base * growth(k) * (1 + sc.pricePct / 100));
      const energyCost = r0(revenue * costRatio * (1 + sc.energyPct / 100) / (1 + sc.pricePct / 100));
      const b = budgets.find((x2) => x2.site_id === s.id && x2.month === m);
      const budget = b ? Number(b.revenue_minor) : null;
      return { month: m, revenue, energyCost, margin: revenue - energyCost, budget, variance: budget != null ? revenue - budget : null, variancePct: budget ? Math.round(((revenue - budget) / budget) * 1000) / 10 : null };
    });
    return {
      siteId: s.id, site: s.name, currency: s.currency, monthsOfHistory: used.length, trendPerMonth: r0(line.b), flat, seasonal: used.length >= 13, costRatioPct: Math.round(costRatio * 1000) / 10,
      history: h.slice(-12), forecast: rows, next12: rows.reduce((a, r) => a + r.revenue, 0),
      belowBudget: rows.slice(0, 3).some((r) => r.variancePct != null && r.variancePct < -sc.alertPct),
    };
  });
  const totals: Record<string, Array<{ month: string; revenue: number; energyCost: number; margin: number; budget: number | null }>> = {};
  for (const s of out) {
    const t = (totals[s.currency] ??= next.map((m) => ({ month: m, revenue: 0, energyCost: 0, margin: 0, budget: null as number | null })));
    s.forecast.forEach((r, i) => { const x = t[i]!; x.revenue += r.revenue; x.energyCost += r.energyCost; x.margin += r.margin; if (r.budget != null) x.budget = (x.budget ?? 0) + r.budget; });
  }
  // Organisation-level budgets (no site) are compared with the totals.
  for (const b of budgets.filter((x) => !x.site_id)) {
    const t = totals[b.currency]?.find((x) => x.month === b.month);
    if (t) t.budget = Number(b.revenue_minor);
  }
  return { scenario: sc, months: next, sites: out, totals };
}

/** The daily check: an alert per site whose next 3 months are below budget beyond the threshold; resolved when not. */
export async function check(orgId: string) {
  const f = await forecast(orgId);
  let n = 0;
  for (const s of f.sites) {
    if (s.belowBudget) {
      const worst = s.forecast.slice(0, 3).filter((r) => r.variancePct != null).sort((a, b) => a.variancePct! - b.variancePct!)[0]!;
      await persistAlert({ orgId, kind: ALERT, severity: 'warning', targetType: 'site', targetId: s.siteId,
        message: `${s.site}: the forecast for ${worst.month} is ${Math.abs(worst.variancePct!)}% below budget (threshold ${f.scenario.alertPct}%).` });
      n++;
    } else {
      await resolveAlertsFor(orgId, ALERT, 'site', s.siteId);
    }
  }
  return n;
}

export async function sweep(): Promise<number> {
  const orgs = await outsideRequestScope(() => many<{ org_id: string }>(`SELECT DISTINCT org_id FROM finance_budget WHERE month >= to_char(now(), 'YYYY-MM')`));
  let n = 0;
  for (const o of orgs) { try { n += await check(o.org_id); } catch (e) { logger.warn({ org: o.org_id, err: (e as Error).message }, 'forecast check failed'); } }
  return n;
}
