import { many, outsideRequestScope } from '../db/pool.js';
import { config } from '../config.js';
import { xlsx } from './xlsx.js';

/**
 * Finance KPI benchmarking (v1.29.0). Sites — or site owners, their sites added up — compared over the last 1 to 12
 * ended months (default 3), each against its peers (the sites or owners in the same currency):
 *
 *   revenue            before tax (CDRs issued in the period)
 *   revenuePerKwh      revenue ÷ kWh
 *   utilisationPct     charging time ÷ (connectors × the period's hours)
 *   marginPct          (revenue − energy cost) ÷ revenue; energy cost is the month's bill, else the site's cost per kWh
 *                      × kWh (unknown when neither: left out of the comparison)
 *   revenuePerConnector  a month's revenue per connector
 *   collectionDays     revenue-weighted days from the CDR to the money: the driver's payment, or the fleet invoice paid
 *                      (an unpaid fleet invoice counts to today); lower is better
 *
 * For each metric: the peers' median, quartiles, each one's percentile rank (100 is the best) and outliers (beyond
 * 1.5 × the interquartile range from the quartiles, with four peers or more), flagged good or bad. The score is the
 * average of the ranks (none without peers). Sites with no sessions in the period are left out.
 */

export class BenchmarkError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const METRICS = ['revenue', 'revenuePerKwh', 'utilisationPct', 'marginPct', 'revenuePerConnector', 'collectionDays'] as const;
type Metric = typeof METRICS[number];
const LOWER_IS_BETTER: Partial<Record<Metric, true>> = { collectionDays: true };
const zone = () => config.billing.timeZone;
const thisMonth = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now).slice(0, 7);
const addMonths = (m: string, n: number) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const t = y * 12 + (mo - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const daysIn = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, mo, 0)).getUTCDate(); };
const r1 = (n: number) => Math.round(n * 10) / 10;

/** The q-th quantile (0..1) of sorted values, linear between ranks. */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Percentile rank where 100 is the best: the share of the other peers this value is at least as good as. */
export function rankOf(value: number, peers: number[], lowerIsBetter = false): number {
  const others = peers.length - 1;
  if (others <= 0) return 100;
  const beaten = peers.filter((p) => (lowerIsBetter ? value <= p : value >= p)).length - 1;
  return Math.round((beaten / others) * 100);
}

export interface Row { id: string; name: string; currency: string; sites: number; connectors: number; sessions: number; kwh: number; revenue: number; energyCost: number | null; chargingHours: number; collectionWeighted: number; collectionBase: number }

export function metricsOf(r: Row, hours: number, months: number): Record<Metric, number | null> {
  return {
    revenue: r.revenue,
    revenuePerKwh: r.kwh > 0 ? Math.round(r.revenue / r.kwh) : null,
    utilisationPct: r.connectors > 0 && hours > 0 ? r1((r.chargingHours / (r.connectors * hours)) * 100) : null,
    marginPct: r.energyCost != null && r.revenue > 0 ? r1(((r.revenue - r.energyCost) / r.revenue) * 100) : null,
    revenuePerConnector: r.connectors > 0 ? Math.round(r.revenue / r.connectors / months) : null,
    collectionDays: r.collectionBase > 0 ? r1(r.collectionWeighted / r.collectionBase) : null,
  };
}

/** Peer statistics and per-entity ranks and outliers, within each currency. */
export function compare(rows: Array<Row & { metrics: Record<Metric, number | null> }>) {
  const stats: Record<string, Record<string, { median: number; q1: number; q3: number; min: number; max: number; peers: number } | null>> = {};
  const out = rows.map((r) => ({ ...r, ranks: {} as Record<string, number | null>, outliers: [] as Array<{ metric: Metric; value: number; direction: 'high' | 'low'; good: boolean }>, score: null as number | null }));
  for (const cur of [...new Set(rows.map((r) => r.currency))]) {
    const peers = out.filter((r) => r.currency === cur);
    stats[cur] = {};
    for (const m of METRICS) {
      const vals = peers.map((p) => p.metrics[m]).filter((v): v is number => v != null).sort((a, b) => a - b);
      if (!vals.length) { stats[cur]![m] = null; continue; }
      const q1 = quantile(vals, 0.25), q3 = quantile(vals, 0.75), iqr = q3 - q1;
      stats[cur]![m] = { median: r1(quantile(vals, 0.5)), q1: r1(q1), q3: r1(q3), min: vals[0]!, max: vals[vals.length - 1]!, peers: vals.length };
      for (const p of peers) {
        const v = p.metrics[m];
        // Alone, there is nothing to rank against.
        p.ranks[m] = v == null || vals.length < 2 ? null : rankOf(v, vals, !!LOWER_IS_BETTER[m]);
        if (v != null && vals.length >= 4 && iqr > 0) {
          const dir = v > q3 + 1.5 * iqr ? 'high' : v < q1 - 1.5 * iqr ? 'low' : null;
          if (dir) p.outliers.push({ metric: m, value: v, direction: dir, good: LOWER_IS_BETTER[m] ? dir === 'low' : dir === 'high' });
        }
      }
    }
    for (const p of peers) {
      const rs = Object.values(p.ranks).filter((x): x is number => x != null);
      p.score = rs.length ? Math.round(rs.reduce((s, x) => s + x, 0) / rs.length) : null;
    }
  }
  out.sort((a, b) => a.currency.localeCompare(b.currency) || (b.score ?? -1) - (a.score ?? -1) || b.revenue - a.revenue);
  return { stats, rows: out };
}

export async function benchmark(orgId: string, q: Record<string, unknown> = {}, now = new Date()) {
  const months = q.months == null || q.months === '' ? 3 : Number(q.months);
  if (!Number.isInteger(months) || months < 1 || months > 12) throw new BenchmarkError(422, 'months is 1 to 12.');
  const by = q.by == null || q.by === '' ? 'site' : String(q.by);
  if (by !== 'site' && by !== 'owner') throw new BenchmarkError(422, 'by is site or owner.');
  const to = q.to == null || q.to === '' ? addMonths(thisMonth(now), -1) : String(q.to);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(to) || to >= thisMonth(now)) throw new BenchmarkError(422, 'to is an ended month (YYYY-MM).');
  const from = addMonths(to, -(months - 1));
  const list = Array.from({ length: months }, (_, k) => addMonths(from, k));
  const hours = list.reduce((s, m) => s + daysIn(m) * 24, 0);
  const [sites, usage, money, bills, cash] = await Promise.all([
    outsideRequestScope(() => many<any>(
      `SELECT s.id, s.name, s.owner_id, COALESCE(o.legal_name, o.name) AS owner_name, co.currency, r.rate_per_kwh,
              (SELECT count(*) FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id WHERE cp.site_id = s.id) AS connectors
         FROM site s JOIN country co ON co.code = s.country_code LEFT JOIN site_owner o ON o.id = s.owner_id LEFT JOIN site_energy_rate r ON r.site_id = s.id
        WHERE s.org_id = $1 AND s.archived_at IS NULL`, [orgId])),
    // Charging time: sessions started in the period (their duration, else start to end, at most the period's end).
    outsideRequestScope(() => many<any>(
      `SELECT cs.site_id, sum(GREATEST(0, COALESCE(cs.duration_s, EXTRACT(EPOCH FROM (LEAST(COALESCE(cs.ended_at, now()), ($3::date + interval '1 month')::timestamp AT TIME ZONE $4) - cs.started_at))))) / 3600.0 AS hours
         FROM charging_session cs WHERE cs.org_id = $1 AND cs.started_at >= ($2::date)::timestamp AT TIME ZONE $4 AND cs.started_at < ($3::date + interval '1 month')::timestamp AT TIME ZONE $4
        GROUP BY 1`, [orgId, `${from}-01`, `${to}-01`, zone()])),
    outsideRequestScope(() => many<any>(
      `SELECT cs.site_id, to_char(d.issued_at AT TIME ZONE $4, 'YYYY-MM') AS month, count(*) AS sessions, COALESCE(sum(d.subtotal_minor), 0)::bigint AS revenue, COALESCE(sum(cs.energy_wh), 0)::bigint AS wh
         FROM cdr d JOIN charging_session cs ON cs.id = d.session_id
        WHERE d.org_id = $1 AND NOT COALESCE(d.test_mode, false) AND d.issued_at >= ($2::date)::timestamp AT TIME ZONE $4 AND d.issued_at < ($3::date + interval '1 month')::timestamp AT TIME ZONE $4
        GROUP BY 1, 2`, [orgId, `${from}-01`, `${to}-01`, zone()])),
    outsideRequestScope(() => many<any>(`SELECT site_id, month, sum(amount_minor)::bigint AS amount FROM site_energy_cost WHERE org_id = $1 AND voided_at IS NULL AND month = ANY($2::text[]) GROUP BY 1, 2`, [orgId, list])),
    // Days from the CDR to the money, weighted by revenue.
    outsideRequestScope(() => many<any>(
      `SELECT x.site_id, sum(x.subtotal * x.days) AS weighted, sum(x.subtotal) AS base FROM (
         SELECT cs.site_id, d.subtotal_minor::numeric AS subtotal,
                GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(
                  (SELECT COALESCE(pi.paid_at, pi.updated_at) FROM payment_intent pi WHERE pi.session_id = cs.id AND pi.state IN ('captured', 'refunded') ORDER BY 1 LIMIT 1),
                  (SELECT CASE WHEN fi.status = 'paid' THEN COALESCE(fi.paid_at::timestamp AT TIME ZONE $4, now()) ELSE now() END
                     FROM token t JOIN fleet_invoice fi ON fi.fleet_account_id = t.fleet_account_id
                    WHERE t.id = cs.token_id AND fi.status <> 'void' AND fi.period = date_trunc('month', d.issued_at AT TIME ZONE $4)::date LIMIT 1)
                ) - d.issued_at)) / 86400.0) AS days
           FROM cdr d JOIN charging_session cs ON cs.id = d.session_id
          WHERE d.org_id = $1 AND NOT COALESCE(d.test_mode, false) AND d.subtotal_minor > 0
            AND d.issued_at >= ($2::date)::timestamp AT TIME ZONE $4 AND d.issued_at < ($3::date + interval '1 month')::timestamp AT TIME ZONE $4) x
        WHERE x.days IS NOT NULL GROUP BY 1`, [orgId, `${from}-01`, `${to}-01`, zone()])),
  ]);
  const siteRows: Row[] = sites.map((s) => {
    const ms = money.filter((m) => m.site_id === s.id);
    const revenue = ms.reduce((a, m) => a + Number(m.revenue), 0);
    const kwh = ms.reduce((a, m) => a + Number(m.wh), 0) / 1000;
    let energyCost: number | null = 0;
    for (const m of list) {
      const mm = ms.find((x) => x.month === m);
      if (!mm || Number(mm.revenue) === 0) continue;
      const bill = bills.find((b) => b.site_id === s.id && b.month === m);
      const c = bill ? Number(bill.amount) : s.rate_per_kwh != null ? Math.round(Number(s.rate_per_kwh) * Number(mm.wh) / 1000) : null;
      if (c == null) { energyCost = null; break; }
      energyCost += c;
    }
    const c = cash.find((x) => x.site_id === s.id);
    return { id: s.id, name: s.name, currency: s.currency, sites: 1, connectors: Number(s.connectors), sessions: ms.reduce((a, m) => a + Number(m.sessions), 0), kwh,
      revenue, energyCost, chargingHours: Number(usage.find((u) => u.site_id === s.id)?.hours ?? 0),
      collectionWeighted: Number(c?.weighted ?? 0), collectionBase: Number(c?.base ?? 0),
      ...{ ownerId: s.owner_id ?? null, owner: s.owner_name ?? null } } as Row & { ownerId: string | null; owner: string | null };
  }).filter((r) => r.sessions > 0);
  let rows: Row[] = siteRows;
  if (by === 'owner') {
    const g = new Map<string, Row>();
    for (const r of siteRows as Array<Row & { ownerId: string | null; owner: string | null }>) {
      const key = `${r.ownerId ?? 'operator'}|${r.currency}`;
      const x = g.get(key) ?? { id: r.ownerId ?? 'operator', name: r.owner ?? 'Operator-owned sites', currency: r.currency, sites: 0, connectors: 0, sessions: 0, kwh: 0, revenue: 0, energyCost: 0, chargingHours: 0, collectionWeighted: 0, collectionBase: 0 };
      x.sites++; x.connectors += r.connectors; x.sessions += r.sessions; x.kwh += r.kwh; x.revenue += r.revenue; x.chargingHours += r.chargingHours;
      x.energyCost = x.energyCost == null || r.energyCost == null ? null : x.energyCost + r.energyCost;
      x.collectionWeighted += r.collectionWeighted; x.collectionBase += r.collectionBase;
      g.set(key, x);
    }
    rows = [...g.values()];
  }
  const c = compare(rows.map((r) => ({ ...r, metrics: metricsOf(r, hours, months) })));
  return {
    by, from, to, months, hours, metrics: [...METRICS], lowerIsBetter: Object.keys(LOWER_IS_BETTER),
    stats: c.stats,
    rows: c.rows.map((r) => ({ id: r.id, name: r.name, currency: r.currency, sites: r.sites, connectors: r.connectors, sessions: r.sessions, kwh: Math.round(r.kwh), revenue: r.revenue,
      energyCost: r.energyCost, metrics: r.metrics, ranks: r.ranks, outliers: r.outliers, score: r.score })),
  };
}

export function benchmarkXlsx(b: Awaited<ReturnType<typeof benchmark>>): Buffer {
  return xlsx([
    { name: 'Benchmark', rows: [[b.by === 'owner' ? 'Owner' : 'Site', 'Currency', 'Sites', 'Connectors', 'Sessions', 'kWh', ...METRICS, 'Score', 'Outliers'],
      ...b.rows.map((r) => [r.name, r.currency, r.sites, r.connectors, r.sessions, r.kwh, ...METRICS.map((m) => r.metrics[m]), r.score,
        r.outliers.map((o) => `${o.metric} ${o.direction} (${o.good ? 'good' : 'bad'})`).join('; ')])],
      widths: [28, 8, 6, 10, 10, 10, 14, 12, 12, 10, 14, 12, 8, 40], formats: [null, null, 'int', 'int', 'int', 'int', 'int', 'int', null, null, 'int', null, 'int', null] },
    { name: 'Peers', rows: [['Currency', 'Metric', 'Peers', 'Min', 'Q1', 'Median', 'Q3', 'Max'],
      ...Object.entries(b.stats).flatMap(([cur, ms]) => Object.entries(ms).filter(([, s]) => s).map(([m, s]) => [cur, m, s!.peers, s!.min, s!.q1, s!.median, s!.q3, s!.max]))],
      widths: [8, 20, 8, 14, 14, 14, 14, 14] },
  ]);
}
