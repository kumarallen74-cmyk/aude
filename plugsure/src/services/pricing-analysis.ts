import { many, outsideRequestScope } from '../db/pool.js';
import { config } from '../config.js';
import { lastMonths } from './energy-margin.js';
import { xlsx, type Sheet } from './xlsx.js';

/**
 * Pricing profitability (v1.35.0), from the charge records of the last n whole months (test sessions left out):
 *
 *   per session   revenue (the subtotal, before tax), kWh, and the energy cost: the site's bill for the month spread over
 *                 the kWh delivered that month when a bill is recorded, else the site's cost per kWh, else unknown
 *   dimensions    tariff (the name frozen on the charge record), connector type, time band (in the billing zone: night
 *                 22:00–06:00, day 06:00–17:00, peak 17:00–22:00, the PLN WBP hours) and site; per currency: sessions,
 *                 kWh, revenue, energy cost, margin and margin %, price and cost per kWh. Rows whose cost is unknown
 *                 count their kWh as "not costed".
 *   elasticity    where a site's price per kWh moved by 5% or more from one month to the next, the change in kWh per day
 *                 over the change in price (arc elasticity); the median of the observations is the estimate, used
 *                 (within −3 to 0) once there are three or more
 *   what-if       a price change of x% on one row: volume moves by elasticity × x% (the estimate when used, else −0.3),
 *                 and the revenue, energy cost and margin after the change
 */

export class PricingError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const DIMENSIONS = ['tariff', 'connector', 'band', 'site'] as const;
type Dim = (typeof DIMENSIONS)[number];
const DEFAULT_ELASTICITY = -0.3;
const MIN_OBSERVATIONS = 3;
const zone = () => config.billing.timeZone;
const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (a: number, b: number) => (b ? r2((a / b) * 100) : null);

/** The time band of a local hour (0–23). Pure. */
export function band(hour: number): 'night' | 'day' | 'peak' {
  return hour >= 17 && hour < 22 ? 'peak' : hour >= 6 && hour < 17 ? 'day' : 'night';
}

/** Arc elasticity between two (price, quantity) points: %Δq ÷ %Δp on the midpoints. Pure; null when the price is unchanged. */
export function arcElasticity(p0: number, q0: number, p1: number, q1: number): number | null {
  const dp = (p1 - p0) / ((p1 + p0) / 2), dq = (q1 - q0) / ((q1 + q0) / 2);
  if (!Number.isFinite(dp) || Math.abs(dp) < 1e-9 || !Number.isFinite(dq)) return null;
  return Math.round((dq / dp) * 100) / 100;
}

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : r2((s[m - 1]! + s[m]!) / 2); };
const daysIn = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, mo, 0)).getUTCDate(); };

async function sessions(orgId: string, months: string[], siteId?: string) {
  return outsideRequestScope(() => many<any>(
    `SELECT to_char(d.issued_at AT TIME ZONE $3, 'YYYY-MM') AS month, EXTRACT(hour FROM cs.started_at AT TIME ZONE $3)::int AS hour, cs.site_id, s.name AS site, d.currency,
            COALESCE(NULLIF(d.tariff_snapshot->>'name', ''), 'No tariff') AS tariff, COALESCE(c.connector_type, c.current_type, 'unknown') AS connector,
            cs.energy_wh::bigint AS wh, d.subtotal_minor::bigint AS revenue
       FROM cdr d JOIN charging_session cs ON cs.id = d.session_id JOIN site s ON s.id = cs.site_id LEFT JOIN connector c ON c.id = cs.connector_uuid
      WHERE d.org_id = $1 AND NOT COALESCE(d.test_mode, false) AND to_char(d.issued_at AT TIME ZONE $3, 'YYYY-MM') = ANY($2::text[]) AND ($4::uuid IS NULL OR cs.site_id = $4::uuid)`,
    [orgId, months, zone(), siteId ?? null]));
}

/** Cost per kWh per site and month: the bill over the kWh delivered, else the site's rate. */
async function costRates(orgId: string, months: string[], rows: any[]) {
  const [rates, bills] = await Promise.all([
    outsideRequestScope(() => many<any>(`SELECT site_id, rate_per_kwh FROM site_energy_rate WHERE org_id = $1`, [orgId])),
    outsideRequestScope(() => many<any>(`SELECT site_id, month, amount_minor FROM site_energy_cost WHERE org_id = $1 AND voided_at IS NULL AND month = ANY($2::text[])`, [orgId, months])),
  ]);
  const kwh = new Map<string, number>();
  for (const r of rows) kwh.set(`${r.site_id}|${r.month}`, (kwh.get(`${r.site_id}|${r.month}`) ?? 0) + Number(r.wh) / 1000);
  const out = new Map<string, number | null>();
  for (const k of kwh.keys()) {
    const [site, m] = k.split('|') as [string, string];
    const bill = bills.find((b) => b.site_id === site && b.month === m), rate = rates.find((x) => x.site_id === site);
    out.set(k, bill && kwh.get(k) ? Number(bill.amount_minor) / kwh.get(k)! : rate ? Number(rate.rate_per_kwh) : null);
  }
  return out;
}

type Acc = { key: string; label: string; currency: string; sessions: number; kwh: number; revenue: number; energyCost: number; costedKwh: number; costedRevenue: number };

const view = (a: Acc) => {
  const margin = a.costedKwh ? a.costedRevenue - a.energyCost : null;
  return {
    key: a.key, label: a.label, currency: a.currency, sessions: a.sessions, kwh: r2(a.kwh), revenue: a.revenue,
    energyCost: a.costedKwh ? Math.round(a.energyCost) : null, notCostedKwh: r2(a.kwh - a.costedKwh),
    margin: margin == null ? null : Math.round(margin), marginPct: margin == null ? null : pct(margin, a.costedRevenue),
    pricePerKwh: a.kwh ? r2(a.revenue / a.kwh) : null, costPerKwh: a.costedKwh ? r2(a.energyCost / a.costedKwh) : null,
  };
};

export async function analysis(orgId: string, q: { months?: unknown; siteId?: unknown } = {}) {
  const n = q.months == null || q.months === '' ? 3 : Number(q.months);
  if (!Number.isInteger(n) || n < 1 || n > 24) throw new PricingError(400, 'months is 1 to 24.');
  const siteId = q.siteId ? String(q.siteId) : undefined;
  if (siteId && !/^[0-9a-f-]{36}$/i.test(siteId)) throw new PricingError(400, 'siteId is a site id.');
  const months = lastMonths(n + 1).slice(1); // whole months
  const rows = await sessions(orgId, months, siteId);
  const rates = await costRates(orgId, months, rows);
  const groups: Record<Dim, Map<string, Acc>> = { tariff: new Map(), connector: new Map(), band: new Map(), site: new Map() };
  const total = new Map<string, Acc>();
  const add = (m: Map<string, Acc>, key: string, label: string, r: any, cost: number | null) => {
    const k = `${key}|${r.currency}`;
    const a = m.get(k) ?? { key, label, currency: r.currency, sessions: 0, kwh: 0, revenue: 0, energyCost: 0, costedKwh: 0, costedRevenue: 0 };
    const kwh = Number(r.wh) / 1000;
    a.sessions++; a.kwh += kwh; a.revenue += Number(r.revenue);
    if (cost != null) { a.energyCost += cost; a.costedKwh += kwh; a.costedRevenue += Number(r.revenue); }
    m.set(k, a);
  };
  for (const r of rows) {
    const rate = rates.get(`${r.site_id}|${r.month}`) ?? null;
    const cost = rate == null ? null : rate * (Number(r.wh) / 1000);
    const b = band(r.hour);
    add(groups.tariff, r.tariff, r.tariff, r, cost);
    add(groups.connector, r.connector, r.connector, r, cost);
    add(groups.band, b, b, r, cost);
    add(groups.site, r.site_id, r.site, r, cost);
    add(total, 'all', 'All', r, cost);
  }
  const sorted = (m: Map<string, Acc>) => [...m.values()].map(view).sort((a, b) => a.currency.localeCompare(b.currency) || b.revenue - a.revenue);
  const el = await elasticity(orgId, siteId);
  return {
    months: [...months].reverse(), siteId: siteId ?? null,
    totals: sorted(total),
    tariff: sorted(groups.tariff), connector: sorted(groups.connector), band: sorted(groups.band), site: sorted(groups.site),
    elasticity: el,
  };
}

/** Month-on-month price moves of 5% or more per site over the last 12 months, and the volume response. */
export async function elasticity(orgId: string, siteId?: string) {
  const months = lastMonths(13).slice(1).reverse(); // whole months only
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT cs.site_id, s.name AS site, d.currency, to_char(d.issued_at AT TIME ZONE $3, 'YYYY-MM') AS month, sum(cs.energy_wh)::bigint AS wh, sum(d.subtotal_minor)::bigint AS revenue
       FROM cdr d JOIN charging_session cs ON cs.id = d.session_id JOIN site s ON s.id = cs.site_id
      WHERE d.org_id = $1 AND NOT COALESCE(d.test_mode, false) AND to_char(d.issued_at AT TIME ZONE $3, 'YYYY-MM') = ANY($2::text[]) AND ($4::uuid IS NULL OR cs.site_id = $4::uuid)
      GROUP BY 1, 2, 3, 4`, [orgId, months, zone(), siteId ?? null]));
  const obs: { siteId: string; site: string; currency: string; from: string; to: string; priceBefore: number; priceAfter: number; kwhPerDayBefore: number; kwhPerDayAfter: number; elasticity: number }[] = [];
  const bySite = new Map<string, any[]>();
  for (const r of rows) { const k = `${r.site_id}|${r.currency}`; bySite.set(k, [...(bySite.get(k) ?? []), r]); }
  for (const list of bySite.values()) {
    list.sort((a, b) => a.month.localeCompare(b.month));
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      if (months.indexOf(b.month) - months.indexOf(a.month) !== 1 || !Number(a.wh) || !Number(b.wh)) continue;
      const p0 = Number(a.revenue) / (Number(a.wh) / 1000), p1 = Number(b.revenue) / (Number(b.wh) / 1000);
      if (!p0 || Math.abs(p1 - p0) / p0 < 0.05) continue;
      const q0 = Number(a.wh) / 1000 / daysIn(a.month), q1 = Number(b.wh) / 1000 / daysIn(b.month);
      const e = arcElasticity(p0, q0, p1, q1);
      if (e == null) continue;
      obs.push({ siteId: b.site_id, site: b.site, currency: b.currency, from: a.month, to: b.month, priceBefore: r2(p0), priceAfter: r2(p1), kwhPerDayBefore: r2(q0), kwhPerDayAfter: r2(q1), elasticity: e });
    }
  }
  const est = median(obs.map((o) => o.elasticity));
  // One or two price moves are too noisy to price on: the median is used from three, kept within −3 to 0.
  const use = est != null && obs.length >= MIN_OBSERVATIONS;
  return { observations: obs, estimate: est, used: use ? Math.min(0, Math.max(-3, est)) : DEFAULT_ELASTICITY, source: use ? 'observed' : 'default', minObservations: MIN_OBSERVATIONS };
}

/** What if one row's price moved by changePct: the volume, revenue, energy cost and margin after. */
export async function whatIf(orgId: string, b: Record<string, unknown>) {
  const dim = String(b.dimension ?? 'totals');
  if (dim !== 'totals' && !(DIMENSIONS as readonly string[]).includes(dim)) throw new PricingError(422, `dimension is totals or one of ${DIMENSIONS.join(', ')}.`);
  const change = Number(b.changePct);
  if (!Number.isFinite(change) || change < -50 || change > 100) throw new PricingError(422, 'changePct is −50 to 100.');
  const a = await analysis(orgId, { months: b.months, siteId: b.siteId });
  const list = (a as any)[dim] as ReturnType<typeof view>[];
  const row = list.find((r) => r.key === String(b.key ?? 'all') && (!b.currency || r.currency === String(b.currency)));
  if (!row) throw new PricingError(404, 'No such row in the analysis.');
  const e = b.elasticity == null || b.elasticity === '' ? a.elasticity.used : Number(b.elasticity);
  if (!Number.isFinite(e) || e < -5 || e > 1) throw new PricingError(422, 'elasticity is −5 to 1.');
  const c = change / 100;
  const vol = Math.max(0, 1 + e * c);
  const revenue = Math.round(row.revenue * (1 + c) * vol), kwh = r2(row.kwh * vol);
  const cost = row.costPerKwh == null ? null : Math.round(row.costPerKwh * kwh);
  const margin = cost == null ? null : revenue - cost;
  return {
    dimension: dim, key: row.key, label: row.label, currency: row.currency, changePct: change, elasticity: e, elasticitySource: b.elasticity == null || b.elasticity === '' ? a.elasticity.source : 'given',
    before: { kwh: row.kwh, revenue: row.revenue, energyCost: row.energyCost, margin: row.margin, marginPct: row.marginPct, pricePerKwh: row.pricePerKwh },
    after: { kwh, revenue, energyCost: cost, margin, marginPct: margin == null ? null : pct(margin, revenue), pricePerKwh: row.pricePerKwh == null ? null : r2(row.pricePerKwh * (1 + c)) },
    deltaMargin: margin == null || row.margin == null ? null : margin - row.margin,
  };
}

export async function analysisXlsx(orgId: string, q: { months?: unknown; siteId?: unknown }): Promise<Buffer> {
  const a = await analysis(orgId, q);
  const head = ['Row', 'Currency', 'Sessions', 'kWh', 'Revenue', 'Energy cost', 'Margin', 'Margin %', 'Price/kWh', 'Cost/kWh', 'kWh not costed'];
  const sheet = (name: string, rows: ReturnType<typeof view>[]): Sheet => ({ name, rows: [head, ...rows.map((r) => [r.label, r.currency, r.sessions, r.kwh, r.revenue, r.energyCost, r.margin, r.marginPct, r.pricePerKwh, r.costPerKwh, r.notCostedKwh])],
    widths: [28, 8, 10, 12, 16, 16, 16, 10, 12, 12, 12], formats: [null, null, null, null, 'money', 'money', 'money', null, null, null, null] });
  return xlsx([
    sheet('Tariffs', a.tariff), sheet('Connectors', a.connector), sheet('Time bands', a.band), sheet('Sites', a.site),
    { name: 'Elasticity', rows: [['Site', 'Currency', 'From', 'To', 'Price before', 'Price after', 'kWh/day before', 'kWh/day after', 'Elasticity'], ...a.elasticity.observations.map((o) => [o.site, o.currency, o.from, o.to, o.priceBefore, o.priceAfter, o.kwhPerDayBefore, o.kwhPerDayAfter, o.elasticity])],
      widths: [24, 8, 9, 9, 12, 12, 14, 14, 10] },
  ]);
}
