import { many, one, outsideRequestScope, query } from '../db/pool.js';

/**
 * Demand forecasting and site planning (v1.45.0), Assets & energy → Demand & planning.
 *
 *   profile     per site, each hour of the week (Monday 00:00 … Sunday 23:00, the site's time) over the last 8 weeks:
 *               how busy its connectors were (occupancy: connector-hours charging ÷ connector-hours), sessions started
 *               and kWh. Recent weeks count more (each week back weighs 0.85 of the one after).
 *   forecast    the next days hour by hour: the profile × the trend (sessions in the last 4 weeks ÷ the 4 before,
 *               held between 0.7 and 1.5). A seasonal average, not a promise: it says when the site is likely busy.
 *   advice      a site busy 80 % or more for 10 hours a week or more, or turning drivers away from its queue, needs more
 *               connectors: enough to bring its busiest hour to 70 %. One used under 5 % of the time is flagged under-used.
 *   candidates  places being considered for a new site, scored 0–100 from three things (weights 50/30/20):
 *                 demand    sessions at the operator's sites nearby in the last 30 days, each weighted by distance
 *                           (halving every 2 km), against the best candidate's;
 *                 gap       how far the nearest existing site is (10 km or more counts fully): new ground;
 *                 pressure  how busy the sites within 5 km are at their busiest hour.
 *               With an estimate of sessions a day: a share of that nearby demand, by the planned connectors.
 */

const S = <T>(fn: () => T) => outsideRequestScope(fn);
const WEEKS = 8;

export class ForecastError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

/** Monday = 0 … Sunday = 6, and the hour, in a time zone. */
export function weekHour(t: Date, tz: string): number {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(t);
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.find((x) => x.type === 'weekday')!.value);
  return wd * 24 + Number(p.find((x) => x.type === 'hour')!.value);
}

export interface SessionSpan { start: Date; end: Date; kwh: number }

/**
 * The weighted hour-of-week profile from sessions: occupancy (0–1), sessions started and kWh per hour slot.
 * `now` ends the window; `connectors` is how many the site has.
 */
export function profileOf(sessions: SessionSpan[], connectors: number, tz: string, now: Date, weeks = WEEKS) {
  const occ = new Array(168).fill(0), starts = new Array(168).fill(0), kwh = new Array(168).fill(0), weight = new Array(168).fill(0);
  const from = now.getTime() - weeks * 7 * 86_400_000;
  const w = (t: number) => 0.85 ** Math.floor((now.getTime() - t) / (7 * 86_400_000));
  // The weight each slot's hours had (so a slot seen in fewer weeks is not under-counted).
  for (let t = Math.ceil(from / 3_600_000) * 3_600_000; t < now.getTime(); t += 3_600_000) weight[weekHour(new Date(t), tz)] += w(t);
  for (const s of sessions) {
    const a = Math.max(s.start.getTime(), from), b = Math.min(s.end.getTime(), now.getTime());
    if (s.start.getTime() >= from && s.start.getTime() < now.getTime()) {
      const h = weekHour(s.start, tz);
      starts[h] += w(s.start.getTime()); kwh[h] += s.kwh * w(s.start.getTime());
    }
    for (let t = a; t < b;) {
      const next = Math.min(b, (Math.floor(t / 3_600_000) + 1) * 3_600_000);
      occ[weekHour(new Date(t), tz)] += ((next - t) / 3_600_000) * w(t);
      t = next;
    }
  }
  const c = Math.max(1, connectors);
  return Array.from({ length: 168 }, (_, i) => ({
    occupancy: weight[i] ? Math.min(1, occ[i] / weight[i] / c) : 0,
    sessions: weight[i] ? starts[i] / weight[i] : 0,
    kwh: weight[i] ? kwh[i] / weight[i] : 0,
  }));
}

/** The trend: sessions in the last 4 weeks over the 4 before, held to 0.7–1.5 (1 without enough history). */
export function trendOf(sessions: SessionSpan[], now: Date): number {
  const t = now.getTime(), w4 = 28 * 86_400_000;
  const recent = sessions.filter((s) => s.start.getTime() >= t - w4).length;
  const before = sessions.filter((s) => s.start.getTime() >= t - 2 * w4 && s.start.getTime() < t - w4).length;
  if (before < 10) return 1;
  return Math.min(1.5, Math.max(0.7, recent / before));
}

/** Connectors to add so the busiest hour comes to `target` (0 when it already does). */
export function connectorsToAdd(connectors: number, peakOccupancy: number, target = 0.7): number {
  if (peakOccupancy <= target || connectors <= 0) return 0;
  return Math.max(1, Math.ceil(connectors * (peakOccupancy / target) - connectors));
}

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371, rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function sitesOf(orgId: string) {
  return S(() => many<any>(
    `SELECT s.id, s.name, s.timezone, s.lat, s.lon,
            (SELECT count(*) FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id WHERE cp.site_id = s.id) AS connectors
       FROM site s WHERE s.org_id = $1 AND s.archived_at IS NULL ORDER BY s.name`, [orgId]));
}

async function spansOf(siteId: string, now: Date, weeks: number): Promise<SessionSpan[]> {
  const rows = await S(() => many<any>(
    `SELECT started_at, COALESCE(ended_at, LEAST(now(), started_at + interval '12 hours')) AS ended_at, COALESCE(energy_wh, 0) AS wh FROM charging_session
      WHERE site_id = $1 AND started_at >= $2 AND started_at < $3 AND state IN ('active', 'ended', 'rated') ORDER BY started_at`,
    [siteId, new Date(now.getTime() - Math.max(weeks, 8) * 7 * 86_400_000 - 12 * 3_600_000), now]));
  return rows.map((r) => ({ start: new Date(r.started_at), end: new Date(r.ended_at), kwh: Number(r.wh) / 1000 }));
}

async function turnedAway(siteId: string) {
  const r = await S(() => one<{ n: string }>(
    `SELECT count(*) AS n FROM driver_queue_entry WHERE site_id = $1 AND joined_at > now() - interval '30 days' AND state IN ('left', 'expired', 'missed')`, [siteId]));
  return Number(r?.n ?? 0);
}

/** Every site: utilisation, the busiest hour, the next 7 days and what to do. */
export async function overview(orgId: string, now = new Date()) {
  const out = [];
  for (const s of await sitesOf(orgId)) {
    const spans = await spansOf(s.id, now, WEEKS);
    const conn = Number(s.connectors);
    const prof = profileOf(spans, conn, s.timezone, now);
    const trend = trendOf(spans, now);
    const avg = prof.reduce((a, p) => a + p.occupancy, 0) / 168;
    const peak = prof.reduce((m, p, i) => (p.occupancy > m.v ? { v: p.occupancy, i } : m), { v: 0, i: 0 });
    const busyHours = prof.filter((p) => p.occupancy >= 0.8).length;
    const away = await turnedAway(s.id);
    const add = (peak.v >= 0.8 && busyHours >= 10) || away >= 10 ? Math.max(1, connectorsToAdd(conn, peak.v)) : 0;
    out.push({
      siteId: s.id, site: s.name, connectors: conn, timezone: s.timezone,
      utilisationPct: Math.round(avg * 1000) / 10, peakOccupancyPct: Math.round(peak.v * 1000) / 10, peakHour: { day: Math.floor(peak.i / 24), hour: peak.i % 24 },
      busyHoursPerWeek: busyHours, turnedAway30d: away, trend: Math.round(trend * 100) / 100,
      next7Days: { sessions: Math.round(prof.reduce((a, p) => a + p.sessions, 0) * trend), kwh: Math.round(prof.reduce((a, p) => a + p.kwh, 0) * trend) },
      sessions8Weeks: spans.filter((x) => x.start.getTime() >= now.getTime() - WEEKS * 7 * 86_400_000).length,
      advice: add ? { kind: 'add_connectors', connectors: add } : avg < 0.05 && spans.length >= 1 ? { kind: 'under_used' } : spans.length === 0 ? { kind: 'no_history' } : { kind: 'ok' },
    });
  }
  return { sites: out, weeks: WEEKS, generatedAt: now.toISOString() };
}

/** One site's (or every site's) hour-of-week heatmap and its forecast for the next `days`. */
export async function siteForecast(orgId: string, siteId: string | null, daysRaw: unknown, now = new Date()) {
  const days = Math.min(14, Math.max(1, Math.round(Number(daysRaw) || 7)));
  const sites = (await sitesOf(orgId)).filter((s) => !siteId || s.id === siteId);
  if (siteId && !sites.length) throw new ForecastError(404, 'No such site.');
  const heat = Array.from({ length: 168 }, () => ({ occupancy: 0, sessions: 0, kwh: 0 }));
  const hours: Array<{ at: string; occupancy: number; sessions: number; kwh: number }> = [];
  const totalConn = sites.reduce((a, s) => a + Number(s.connectors), 0) || 1;
  const start = Math.ceil(now.getTime() / 3_600_000) * 3_600_000;
  for (let h = 0; h < days * 24; h++) hours.push({ at: new Date(start + h * 3_600_000).toISOString(), occupancy: 0, sessions: 0, kwh: 0 });
  for (const s of sites) {
    const spans = await spansOf(s.id, now, WEEKS);
    const prof = profileOf(spans, Number(s.connectors), s.timezone, now);
    const trend = trendOf(spans, now);
    const share = Number(s.connectors) / totalConn;
    prof.forEach((p, i) => { heat[i]!.occupancy += p.occupancy * share; heat[i]!.sessions += p.sessions; heat[i]!.kwh += p.kwh; });
    for (const x of hours) {
      const p = prof[weekHour(new Date(x.at), s.timezone)]!;
      x.occupancy += Math.min(1, p.occupancy * trend) * share; x.sessions += p.sessions * trend; x.kwh += p.kwh * trend;
    }
  }
  const r = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
  return {
    siteId, days, timezone: sites[0]?.timezone ?? null,
    heatmap: heat.map((h, i) => ({ day: Math.floor(i / 24), hour: i % 24, occupancyPct: r(h.occupancy * 100, 1), sessions: r(h.sessions), kwh: r(h.kwh, 1) })),
    forecast: hours.map((x) => ({ at: x.at, occupancyPct: r(x.occupancy * 100, 1), sessions: r(x.sessions), kwh: r(x.kwh, 1) })),
    totals: { sessions: Math.round(hours.reduce((a, x) => a + x.sessions, 0)), kwh: Math.round(hours.reduce((a, x) => a + x.kwh, 0)) },
  };
}

// ------------------------------------------------------------------ candidates

const candOf = (c: any) => ({ id: String(c.id), name: c.name, lat: Number(c.lat), lon: Number(c.lon), connectors: c.connectors, powerKw: Number(c.power_kw), status: c.status, notes: c.notes ?? null, createdAt: new Date(c.created_at).toISOString() });

export async function saveCandidate(orgId: string, id: string | null, b: Record<string, unknown>, userId: string | null) {
  const cur = id ? await S(() => one<any>(`SELECT * FROM site_candidate WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [Number(id) || 0, orgId])) : null;
  if (id && !cur) throw new ForecastError(404, 'No such candidate.');
  if (cur && b.archive === true) {
    await S(() => query(`UPDATE site_candidate SET archived_at = now() WHERE id = $1`, [cur.id]));
    return { id: String(cur.id), archived: true };
  }
  const v = (k: string, col: string) => (b[k] !== undefined ? b[k] : cur?.[col]);
  const name = String(v('name', 'name') ?? '').trim().slice(0, 120);
  if (!name) throw new ForecastError(422, 'name is required.');
  const lat = Number(v('lat', 'lat')), lon = Number(v('lon', 'lon'));
  if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180) || (lat === 0 && lon === 0)) throw new ForecastError(422, 'lat and lon are the place\'s coordinates.');
  const conn = Number(v('connectors', 'connectors') ?? 2), kw = Number(v('powerKw', 'power_kw') ?? 22);
  if (!Number.isInteger(conn) || conn < 1 || conn > 100) throw new ForecastError(422, 'connectors is 1 to 100.');
  if (!(kw > 0 && kw <= 1000)) throw new ForecastError(422, 'powerKw is above 0, at most 1000.');
  const status = String(v('status', 'status') ?? 'idea');
  if (!['idea', 'surveyed', 'approved', 'rejected'].includes(status)) throw new ForecastError(422, 'status is idea, surveyed, approved or rejected.');
  const notes = v('notes', 'notes') ? String(v('notes', 'notes')).slice(0, 1000) : null;
  const r = cur
    ? await S(() => one<any>(`UPDATE site_candidate SET name = $2, lat = $3, lon = $4, connectors = $5, power_kw = $6, status = $7, notes = $8 WHERE id = $1 RETURNING *`, [cur.id, name, lat, lon, conn, kw, status, notes]))
    : await S(() => one<any>(`INSERT INTO site_candidate (org_id, name, lat, lon, connectors, power_kw, status, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [orgId, name, lat, lon, conn, kw, status, notes, userId]));
  return candOf(r);
}

export interface PlaceStats { lat: number; lon: number; sessions30d: number; peakOccupancy: number }

/** The score of a place against the operator's sites (pure; see the header). */
export function scorePlace(p: { lat: number; lon: number; connectors: number }, sites: PlaceStats[], maxDemand: number) {
  const located = sites.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
  let demand = 0, nearest = Infinity;
  const near: number[] = [];
  for (const s of located) {
    const d = haversineKm(p, s);
    nearest = Math.min(nearest, d);
    demand += s.sessions30d * 0.5 ** (d / 2);
    if (d <= 5) near.push(s.peakOccupancy);
  }
  const demandScore = maxDemand > 0 ? Math.min(1, demand / maxDemand) : 0;
  const gap = located.length ? Math.min(1, nearest / 10) : 1;
  const pressure = near.length ? near.reduce((a, b) => a + b, 0) / near.length : 0;
  const score = Math.round(100 * (0.5 * demandScore + 0.3 * gap + 0.2 * pressure));
  // A tenth of the nearby demand a day, by the connectors planned (2 = the base), at most 8 a connector.
  const perDay = Math.min(p.connectors * 8, (demand / 30) * 0.1 * Math.max(0.5, p.connectors / 2));
  return { score, demand: Math.round(demand), demandScore: Math.round(demandScore * 100), gapKm: Number.isFinite(nearest) ? Math.round(nearest * 10) / 10 : null,
    gapScore: Math.round(gap * 100), pressureScore: Math.round(pressure * 100), sitesWithin5km: near.length, estimatedSessionsPerDay: Math.round(perDay * 10) / 10 };
}

export async function candidates(orgId: string, now = new Date()) {
  const rows = await S(() => many<any>(`SELECT * FROM site_candidate WHERE org_id = $1 AND archived_at IS NULL ORDER BY created_at DESC`, [orgId]));
  const ov = await overview(orgId, now);
  const coords = new Map((await sitesOf(orgId)).map((s) => [s.id, s]));
  const stats: PlaceStats[] = [];
  for (const s of ov.sites) {
    const c = coords.get(s.siteId);
    if (c?.lat == null || c?.lon == null) continue;
    const n = await S(() => one<{ n: string }>(`SELECT count(*) AS n FROM charging_session WHERE site_id = $1 AND started_at > $2`, [s.siteId, new Date(now.getTime() - 30 * 86_400_000)]));
    stats.push({ lat: Number(c.lat), lon: Number(c.lon), sessions30d: Number(n?.n ?? 0), peakOccupancy: s.peakOccupancyPct / 100 });
  }
  const raw = rows.map((c) => ({ c, d: stats.reduce((a, s) => a + s.sessions30d * 0.5 ** (haversineKm({ lat: Number(c.lat), lon: Number(c.lon) }, s) / 2), 0) }));
  const maxDemand = Math.max(0, ...raw.map((x) => x.d));
  return {
    candidates: rows.map((c) => ({ ...candOf(c), ...scorePlace({ lat: Number(c.lat), lon: Number(c.lon), connectors: c.connectors }, stats, maxDemand) }))
      .sort((a, b) => b.score - a.score),
    sites: stats.length,
  };
}
