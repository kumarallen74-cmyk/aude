import { many, one, outsideRequestScope, query, tx } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { guardedFetch, refuseOutboundUrl } from './net-guard.js';
import { seal, unseal } from './secrets.js';

/**
 * Energy market prices (v1.47.0), Assets & energy → Energy prices. Day-ahead or time-of-use prices per price zone,
 * and charging that moves to the cheap hours:
 *
 *   zone       a market area or supply contract with its price per kWh (minor units) for each period (15, 30 or 60
 *              minutes): imported (JSON or CSV), or fetched hourly from an address (JSON: a list of {start, price}, or
 *              {prices: […]}; through the outbound guard)
 *   site       on a zone, with "shift to cheap hours": in an expensive period the load manager gives the site only
 *              part of its grid budget (price_cap_pct, default 50 %); sessions with a departure (depot charging) still
 *              get what their departure needs. Expensive: at or above the site's threshold, or, without one, among the
 *              most expensive quarter of that local day's periods
 *   savings    per site and month: the energy each hour (sessions spread over the hours they ran) × that hour's price,
 *              against the same energy at the month's average price (what charging evenly would have cost)
 */

export class PriceError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const S = <T>(fn: () => T) => outsideRequestScope(fn);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const AAD = 'energy-price-source';
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

const zoneOf = (z: any) => ({
  id: String(z.id), name: z.name, currency: z.currency, source: z.source, url: z.url ?? null, hasAuth: !!z.auth_sealed,
  lastFetchAt: z.last_fetch_at ? new Date(z.last_fetch_at).toISOString() : null, lastError: z.last_error ?? null,
  periods: Number(z.periods ?? 0), lastPeriod: z.last_period ? new Date(z.last_period).toISOString() : null, sites: Number(z.sites ?? 0),
});
const ZONE_SELECT = `SELECT z.*, (SELECT count(*) FROM energy_price p WHERE p.zone_id = z.id) AS periods, (SELECT max(starts_at) FROM energy_price p WHERE p.zone_id = z.id) AS last_period,
  (SELECT count(*) FROM site s WHERE s.price_zone_id = z.id AND s.archived_at IS NULL) AS sites FROM energy_price_zone z`;

export async function zones(orgId: string) {
  return (await S(() => many<any>(`${ZONE_SELECT} WHERE z.org_id = $1 AND z.archived_at IS NULL ORDER BY z.name`, [orgId]))).map(zoneOf);
}

async function zoneRow(orgId: string, id: string) {
  const z = await S(() => one<any>(`SELECT * FROM energy_price_zone WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [Number(id) || 0, orgId]));
  if (!z) throw new PriceError(404, 'No such price zone.');
  return z;
}

export async function saveZone(orgId: string, id: string | null, b: Record<string, unknown>) {
  const cur = id ? await zoneRow(orgId, id) : null;
  if (cur && b.archive === true) {
    await S(() => query(`UPDATE site SET price_zone_id = NULL, price_shift = false WHERE price_zone_id = $1`, [cur.id]));
    await S(() => query(`UPDATE energy_price_zone SET archived_at = now() WHERE id = $1`, [cur.id]));
    return { id: String(cur.id), archived: true };
  }
  const v = (k: string, col: string) => (b[k] !== undefined ? b[k] : cur?.[col]);
  const name = String(v('name', 'name') ?? '').trim().slice(0, 80);
  if (!name) throw new PriceError(422, 'name is required.');
  const currency = String(v('currency', 'currency') ?? '').toUpperCase();
  if (!(await S(() => one(`SELECT 1 FROM currency_unit WHERE code = $1`, [currency])))) throw new PriceError(422, 'currency is a supported currency code.');
  const source = String(v('source', 'source') ?? 'manual');
  if (!['manual', 'url'].includes(source)) throw new PriceError(422, 'source is manual (imported) or url (fetched every hour).');
  let url: string | null = null;
  if (source === 'url') {
    url = String(v('url', 'url') ?? '').trim();
    let u: URL;
    try { u = new URL(url); } catch { throw new PriceError(422, 'url is the address the prices are fetched from.'); }
    const why = refuseOutboundUrl(u);
    if (why) throw new PriceError(422, `url: ${why}.`);
    url = u.toString();
  }
  const auth = b.authorization !== undefined ? (b.authorization ? seal(String(b.authorization).slice(0, 2000), AAD) : null) : cur?.auth_sealed ?? null;
  const vals = [orgId, name, currency, source, url, auth];
  const r = cur
    ? await S(() => one<any>(`UPDATE energy_price_zone SET name = $2, currency = $3, source = $4, url = $5, auth_sealed = $6 WHERE id = $7 AND org_id = $1 RETURNING id`, [...vals, cur.id]))
    : await S(() => one<any>(`INSERT INTO energy_price_zone (org_id, name, currency, source, url, auth_sealed) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, vals));
  return zoneOf(await S(() => one<any>(`${ZONE_SELECT} WHERE z.id = $1`, [r.id])));
}

// ------------------------------------------------------------------ prices

export interface PricePoint { startsAt: Date; minutes: number; priceMinor: number }

/**
 * Prices from what a source sends: a JSON list (or {prices | data | items: […]}) of objects with a start
 * (start | startsAt | starts_at | time | timestamp | from: ISO time or seconds) and a price (price | value |
 * priceMinor | price_minor, per kWh in minor units; with `per: "MWh"` on the object or `unit` "MWh" the price is per
 * MWh and divided by 1000), or CSV lines "start,price[,minutes]". Bad lines are skipped and counted. Pure.
 */
export function parsePrices(input: unknown): { points: PricePoint[]; skipped: number } {
  let list: unknown[] = [];
  if (typeof input === 'string') {
    const t = input.trim();
    if (t.startsWith('[') || t.startsWith('{')) { try { return parsePrices(JSON.parse(t)); } catch { return { points: [], skipped: 1 }; } }
    list = t.split(/\r?\n/).filter(Boolean).map((l) => { const c = l.split(/[,;\t]/).map((x) => x.trim().replace(/^"|"$/g, '')); return { start: c[0], price: c[1], minutes: c[2] }; });
  } else if (Array.isArray(input)) list = input;
  else if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    list = (Array.isArray(o.prices) ? o.prices : Array.isArray(o.data) ? o.data : Array.isArray(o.items) ? o.items : []) as unknown[];
  }
  const points: PricePoint[] = [];
  let skipped = 0;
  for (const it of list.slice(0, 20_000)) {
    const o = (it ?? {}) as Record<string, unknown>;
    const s = o.start ?? o.startsAt ?? o.starts_at ?? o.time ?? o.timestamp ?? o.from;
    const d = typeof s === 'number' || (typeof s === 'string' && /^\d{9,11}$/.test(s)) ? new Date(Number(s) * 1000) : new Date(String(s ?? ''));
    let p = Number(o.price ?? o.value ?? o.priceMinor ?? o.price_minor);
    const perMwh = String(o.per ?? o.unit ?? '').toLowerCase().includes('mwh');
    if (perMwh) p /= 1000;
    const mins = o.minutes == null || o.minutes === '' ? 60 : Number(o.minutes);
    if (!Number.isFinite(d.getTime()) || !Number.isFinite(p) || ![15, 30, 60].includes(mins)) { skipped++; continue; }
    points.push({ startsAt: d, minutes: mins, priceMinor: r4(p) });
  }
  return { points, skipped };
}

async function store(z: any, points: PricePoint[]) {
  if (!points.length) return 0;
  return S(() => tx(async (c) => {
    let n = 0;
    for (const p of points) {
      await c.query(
        `INSERT INTO energy_price (zone_id, org_id, starts_at, minutes, price_minor_per_kwh) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (zone_id, starts_at) DO UPDATE SET minutes = EXCLUDED.minutes, price_minor_per_kwh = EXCLUDED.price_minor_per_kwh`,
        [z.id, z.org_id, p.startsAt, p.minutes, p.priceMinor]);
      n++;
    }
    // Two years are kept.
    await c.query(`DELETE FROM energy_price WHERE zone_id = $1 AND starts_at < now() - interval '2 years'`, [z.id]);
    return n;
  }));
}

export async function importPrices(orgId: string, id: string, b: Record<string, unknown>) {
  const z = await zoneRow(orgId, id);
  const { points, skipped } = parsePrices(b.csv ?? b.prices ?? b);
  if (!points.length) throw new PriceError(422, 'No prices found: send prices [{start, price}] or csv "start,price" lines.');
  return { stored: await store(z, points), skipped };
}

/** Worker (hourly): zones with an address are fetched. */
export async function fetchAll(): Promise<number> {
  const zs = await S(() => many<any>(`SELECT * FROM energy_price_zone WHERE source = 'url' AND archived_at IS NULL AND url IS NOT NULL`));
  let n = 0;
  for (const z of zs) {
    try { n += (await fetchZone(z)).stored; } catch (e) { logger.warn({ zone: z.id, err: (e as Error).message }, 'energy price fetch failed'); }
  }
  return n;
}

export async function fetchNow(orgId: string, id: string) {
  const z = await zoneRow(orgId, id);
  if (z.source !== 'url') throw new PriceError(409, 'This zone\'s prices are imported, not fetched.');
  return fetchZone(z);
}

async function fetchZone(z: any) {
  const headers: Record<string, string> = { accept: 'application/json, text/csv' };
  if (z.auth_sealed) { try { headers.authorization = unseal(z.auth_sealed, AAD); } catch { /* without */ } }
  try {
    const r = await guardedFetch(z.url, { method: 'GET', headers, timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024 });
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
    const { points, skipped } = parsePrices(r.text);
    if (!points.length) throw new Error('no prices in the answer');
    const stored = await store(z, points);
    await S(() => query(`UPDATE energy_price_zone SET last_fetch_at = now(), last_error = NULL WHERE id = $1`, [z.id]));
    return { stored, skipped };
  } catch (e) {
    await S(() => query(`UPDATE energy_price_zone SET last_fetch_at = now(), last_error = $2 WHERE id = $1`, [z.id, (e as Error).message.slice(0, 300)]));
    throw new PriceError(502, `Fetching the prices failed: ${(e as Error).message}`);
  }
}

/** A zone's prices for a local day (the zone's first site's time zone, else the operator's). */
export async function day(orgId: string, id: string, dateRaw?: unknown, tz = config.billing.timeZone) {
  const z = await zoneRow(orgId, id);
  const site = await S(() => one<any>(`SELECT timezone FROM site WHERE price_zone_id = $1 LIMIT 1`, [z.id]));
  const zone = site?.timezone ?? tz;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dateRaw ?? '')) ? String(dateRaw) : new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
  const rows = await S(() => many<any>(
    `SELECT starts_at, minutes, price_minor_per_kwh FROM energy_price WHERE zone_id = $1 AND (starts_at AT TIME ZONE $2)::date = $3::date ORDER BY starts_at`, [z.id, zone, date]));
  const prices = rows.map((r) => Number(r.price_minor_per_kwh));
  const cut = expensiveCut(prices);
  return {
    zoneId: String(z.id), date, timeZone: zone, currency: z.currency,
    periods: rows.map((r, i) => ({ startsAt: new Date(r.starts_at).toISOString(), minutes: r.minutes, priceMinor: prices[i]!, expensive: cut != null && prices[i]! >= cut })),
    min: prices.length ? Math.min(...prices) : null, max: prices.length ? Math.max(...prices) : null, avg: prices.length ? r4(prices.reduce((a, b) => a + b, 0) / prices.length) : null,
  };
}

// ------------------------------------------------------------------ expensive periods (the load manager)

/** The lowest price among the day's most expensive quarter of periods. Null without prices. Pure. */
export function expensiveCut(dayPrices: number[]): number | null {
  if (!dayPrices.length) return null;
  const sorted = [...dayPrices].sort((a, b) => b - a);
  return sorted[Math.max(0, Math.ceil(sorted.length / 4) - 1)]!;
}

/** Whether a price is expensive: at or above the threshold, or (none) in the day's most expensive quarter. Pure. */
export function isExpensive(price: number, dayPrices: number[], thresholdMinor: number | null): boolean {
  if (thresholdMinor != null) return price >= thresholdMinor;
  const cut = expensiveCut(dayPrices);
  // A flat day (every period the same price) has nothing to move away from.
  return cut != null && price >= cut && Math.max(...dayPrices) > Math.min(...dayPrices);
}

/**
 * For the load manager: at a site that shifts to cheap hours, the share (%) of its grid budget it gets now, and the
 * price. Null when the site does not shift or there is no price for now (then the usual budget).
 */
export async function capNow(siteId: string, now = new Date()): Promise<{ capPct: number; priceMinor: number; expensive: boolean } | null> {
  const s = await one<any>(`SELECT price_zone_id, price_shift, price_cap_pct, price_threshold_minor, timezone FROM site WHERE id = $1`, [siteId]);
  if (!s?.price_shift || !s.price_zone_id) return null;
  const p = await one<any>(
    `SELECT price_minor_per_kwh FROM energy_price WHERE zone_id = $1 AND starts_at <= $2 AND starts_at + make_interval(mins => minutes) > $2 ORDER BY starts_at DESC LIMIT 1`, [s.price_zone_id, now]);
  if (!p) return null;
  const dayRows = await many<any>(
    `SELECT price_minor_per_kwh FROM energy_price WHERE zone_id = $1 AND (starts_at AT TIME ZONE $2)::date = ($3::timestamptz AT TIME ZONE $2)::date`, [s.price_zone_id, s.timezone, now]);
  const price = Number(p.price_minor_per_kwh);
  const expensive = isExpensive(price, dayRows.map((r) => Number(r.price_minor_per_kwh)), s.price_threshold_minor == null ? null : Number(s.price_threshold_minor));
  return { capPct: expensive ? Number(s.price_cap_pct) : 100, priceMinor: price, expensive };
}

/** The grid part of a budget under the price cap (on-site solar and battery are not capped). Pure. */
export function applyPriceCap(usableW: number, extraW: number, cap: { capPct: number } | null): number {
  if (!cap || cap.capPct >= 100) return usableW;
  const grid = Math.max(0, usableW - extraW);
  return Math.floor((grid * Math.max(0, cap.capPct)) / 100) + extraW;
}

export async function siteSettings(orgId: string, siteId: string, b: Record<string, unknown>) {
  if (!UUID_RE.test(siteId)) throw new PriceError(404, 'No such site.');
  const zoneId = b.zoneId == null || b.zoneId === '' ? null : Number(b.zoneId);
  if (zoneId != null) await zoneRow(orgId, String(zoneId));
  const pct = b.capPct == null || b.capPct === '' ? 50 : Number(b.capPct);
  if (!(Number.isInteger(pct) && pct >= 0 && pct <= 100)) throw new PriceError(422, 'capPct is 0 to 100 (the share of the grid budget in expensive periods).');
  const th = b.thresholdMinor == null || b.thresholdMinor === '' ? null : Number(b.thresholdMinor);
  if (th != null && !(Number.isFinite(th) && th >= 0)) throw new PriceError(422, 'thresholdMinor is a price per kWh (minor units), or empty for the day\'s most expensive quarter.');
  const shift = b.shift === true && zoneId != null;
  const r = await S(() => one<any>(
    `UPDATE site SET price_zone_id = $3, price_shift = $4, price_cap_pct = $5, price_threshold_minor = $6 WHERE id = $1 AND org_id = $2
     RETURNING id, name, price_zone_id, price_shift, price_cap_pct, price_threshold_minor`, [siteId, orgId, zoneId, shift, pct, th]));
  if (!r) throw new PriceError(404, 'No such site.');
  return siteOf(r);
}

const siteOf = (r: any) => ({ siteId: r.id, name: r.name, zoneId: r.price_zone_id == null ? null : String(r.price_zone_id), shift: r.price_shift, capPct: r.price_cap_pct,
  thresholdMinor: r.price_threshold_minor == null ? null : Number(r.price_threshold_minor) });

export async function sites(orgId: string) {
  return (await S(() => many<any>(`SELECT id, name, price_zone_id, price_shift, price_cap_pct, price_threshold_minor FROM site WHERE org_id = $1 AND archived_at IS NULL ORDER BY name`, [orgId]))).map(siteOf);
}

// ------------------------------------------------------------------ savings

/** Each session's energy spread evenly over the hours it ran: kWh per hour start (ms). Pure. */
export function spreadHourly(sessions: Array<{ start: Date; end: Date; kwh: number }>): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of sessions) {
    const a = s.start.getTime(), b = Math.max(a + 60_000, s.end.getTime());
    const per = s.kwh / (b - a);
    for (let h = Math.floor(a / 3_600_000) * 3_600_000; h < b; h += 3_600_000) {
      const part = Math.min(b, h + 3_600_000) - Math.max(a, h);
      if (part > 0) out.set(h, (out.get(h) ?? 0) + part * per);
    }
  }
  return out;
}

/** What a month's charging cost at the hourly prices, against the same energy at the month's average price. Pure. */
export function savingsOf(kwhByHour: Map<number, number>, priceByHour: Map<number, number>) {
  let kwh = 0, cost = 0;
  for (const [h, e] of kwhByHour) { const p = priceByHour.get(h); if (p == null) continue; kwh += e; cost += e * p; }
  const prices = [...priceByHour.values()];
  const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
  return { pricedKwh: Math.round(kwh * 1000) / 1000, costMinor: Math.round(cost), atAverageMinor: avg == null ? null : Math.round(kwh * avg), avgPriceMinor: avg == null ? null : r4(avg),
    paidAvgMinor: kwh > 0 ? r4(cost / kwh) : null, savingsMinor: avg == null ? null : Math.round(kwh * avg - cost) };
}

export async function savings(orgId: string, monthRaw: unknown) {
  const month = MONTH_RE.test(String(monthRaw ?? '')) ? String(monthRaw) : new Date().toISOString().slice(0, 7);
  const ss = await S(() => many<any>(`SELECT s.id, s.name, s.price_zone_id, s.price_shift, z.currency FROM site s JOIN energy_price_zone z ON z.id = s.price_zone_id WHERE s.org_id = $1 AND s.archived_at IS NULL ORDER BY s.name`, [orgId]));
  const out = [];
  for (const s of ss) {
    const sessions = await S(() => many<any>(
      `SELECT started_at, COALESCE(ended_at, now()) AS ended_at, COALESCE(energy_wh, 0) AS wh FROM charging_session
        WHERE site_id = $1 AND started_at >= ($2 || '-01')::date AND started_at < ($2 || '-01')::date + interval '1 month' AND COALESCE(energy_wh, 0) > 0`, [s.id, month]));
    const prices = await S(() => many<any>(
      `SELECT date_trunc('hour', starts_at) AS h, avg(price_minor_per_kwh) AS p FROM energy_price
        WHERE zone_id = $1 AND starts_at >= ($2 || '-01')::date - interval '1 day' AND starts_at < ($2 || '-01')::date + interval '1 month 1 day' GROUP BY 1`, [s.price_zone_id, month]));
    const byHour = spreadHourly(sessions.map((x) => ({ start: new Date(x.started_at), end: new Date(x.ended_at), kwh: Number(x.wh) / 1000 })));
    const pm = new Map<number, number>(prices.map((p) => [new Date(p.h).getTime(), Number(p.p)]));
    out.push({ siteId: s.id, site: s.name, shift: s.price_shift, currency: s.currency, sessions: sessions.length, ...savingsOf(byHour, pm) });
  }
  return { month, sites: out };
}
