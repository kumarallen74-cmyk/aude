import { createHash, randomBytes } from 'node:crypto';
import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { guardedFetch, refuseOutboundUrl } from './net-guard.js';
import { seal, unseal } from './secrets.js';

/**
 * Vehicle telematics (v1.45.0), Assets & energy → Depot charging → Telematics. A fleet's own vehicle data — state of
 * charge, range, position, odometer — from the car maker's or the fleet's telematics platform, for vehicles whose
 * chargers do not report the battery (most AC chargers, OCPP 1.6).
 *
 *   webhook   the platform posts readings to …/telematics/<key> (one reading, or a list);
 *   poll      PlugSure reads the platform's endpoint every n minutes (https, with an Authorization header kept
 *             sealed), through the outbound guard (no private addresses, no redirects, 15 s, 1 MB).
 *
 * Either way a field map says where each value is in the JSON, as dot paths: list (where the vehicles are, for an
 * answer with many), vehicleId, socPct, rangeKm, lat, lon, odometerKm, charging, at. Each vehicle is matched by its
 * telematics id (set on the fleet vehicle). A reading is kept once per vehicle and time.
 *
 * Use: depot scheduling (depot.ts) takes a fresh reading (30 minutes or newer) for a session whose car does not send
 * its state of charge, and works out the energy still needed from the vehicle's target and battery.
 */

export class TelematicsError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const S = <T>(fn: () => T) => outsideRequestScope(fn);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const FIELDS = ['list', 'vehicleId', 'socPct', 'rangeKm', 'lat', 'lon', 'odometerKm', 'charging', 'at'] as const;
export const FRESH_MINUTES = 30;

/** A value at a dot path ("data.battery.soc", "items.0.id"). */
export function at(obj: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let v: any = obj;
  for (const k of path.split('.')) {
    if (v == null || typeof v !== 'object') return undefined;
    v = v[k];
  }
  return v;
}

export interface Reading { vehicleId: string; socPct: number | null; rangeKm: number | null; lat: number | null; lon: number | null; odometerKm: number | null; charging: boolean | null; at: Date }

/** The readings in a payload, by the field map. Bad values are dropped, not guessed. */
export function readingsFrom(payload: unknown, map: Record<string, string>, now = new Date()): Reading[] {
  const list = map.list ? at(payload, map.list) : payload;
  const items = Array.isArray(list) ? list : [list];
  const num = (v: unknown, lo: number, hi: number) => { const n = typeof v === 'string' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
  const out: Reading[] = [];
  for (const it of items.slice(0, 1000)) {
    const id = at(it, map.vehicleId ?? 'vehicleId');
    if (id == null || id === '') continue;
    // A share (0–1) rather than a percentage.
    const frac = map.socIsFraction === 'true';
    let soc = num(at(it, map.socPct ?? 'socPct'), 0, frac ? 1 : 100);
    if (soc != null && frac) soc = Math.round(soc * 10000) / 100;
    const t = at(it, map.at ?? 'at');
    const when = typeof t === 'number' ? new Date(t < 1e12 ? t * 1000 : t) : typeof t === 'string' ? new Date(t) : now;
    const ch = at(it, map.charging ?? 'charging');
    out.push({
      vehicleId: String(id).slice(0, 80), socPct: soc, rangeKm: num(at(it, map.rangeKm ?? 'rangeKm'), 0, 5000),
      lat: num(at(it, map.lat ?? 'lat'), -90, 90), lon: num(at(it, map.lon ?? 'lon'), -180, 180), odometerKm: num(at(it, map.odometerKm ?? 'odometerKm'), 0, 10_000_000),
      charging: typeof ch === 'boolean' ? ch : ch === 'true' || ch === 1 ? true : ch === 'false' || ch === 0 ? false : null,
      // A time in the future (a clock ahead) or unreadable is taken as now.
      at: Number.isFinite(when.getTime()) && when.getTime() <= now.getTime() + 5 * 60_000 ? when : now,
    });
  }
  return out;
}

const connOf = (c: any) => ({
  id: String(c.id), name: c.name, kind: c.kind, url: c.url ?? null, hasAuth: !!c.auth_sealed, keyPrefix: c.key_prefix ?? null, fieldMap: c.field_map ?? {},
  pollMinutes: c.poll_minutes, enabled: c.enabled, lastSeenAt: c.last_seen_at ? new Date(c.last_seen_at).toISOString() : null,
  lastPolledAt: c.last_polled_at ? new Date(c.last_polled_at).toISOString() : null, lastError: c.last_error ?? null, vehicles: Number(c.vehicles ?? 0),
});

export async function connections(orgId: string) {
  return (await S(() => many<any>(
    `SELECT c.*, (SELECT count(*) FROM fleet_vehicle v WHERE v.telematics_connection_id = c.id AND v.archived_at IS NULL) AS vehicles
       FROM telematics_connection c WHERE c.org_id = $1 AND c.archived_at IS NULL ORDER BY c.name`, [orgId]))).map(connOf);
}

export async function saveConnection(orgId: string, id: string | null, b: Record<string, unknown>) {
  const cur = id ? await S(() => one<any>(`SELECT * FROM telematics_connection WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [Number(id) || 0, orgId])) : null;
  if (id && !cur) throw new TelematicsError(404, 'No such connection.');
  if (cur && b.archive === true) {
    await S(() => query(`UPDATE telematics_connection SET archived_at = now(), enabled = false WHERE id = $1`, [cur.id]));
    await S(() => query(`UPDATE fleet_vehicle SET telematics_connection_id = NULL WHERE telematics_connection_id = $1`, [cur.id]));
    return { id: String(cur.id), archived: true };
  }
  const name = String(b.name ?? cur?.name ?? '').trim().slice(0, 80);
  if (!name) throw new TelematicsError(422, 'name is required.');
  const kind = String(b.kind ?? cur?.kind ?? '');
  if (!['webhook', 'poll'].includes(kind)) throw new TelematicsError(422, 'kind is webhook (the platform posts to PlugSure) or poll (PlugSure reads the platform).');
  let url: string | null = b.url !== undefined ? (b.url ? String(b.url).trim() : null) : cur?.url ?? null;
  if (kind === 'poll') {
    if (!url) throw new TelematicsError(422, 'url is required to poll.');
    let u: URL;
    try { u = new URL(url); } catch { throw new TelematicsError(422, 'url is not a URL.'); }
    const why = refuseOutboundUrl(u);
    if (why) throw new TelematicsError(422, `url: ${why}.`);
    url = u.toString();
  } else url = null;
  const map: Record<string, string> = { ...(cur?.field_map ?? {}) };
  if (b.fieldMap && typeof b.fieldMap === 'object') {
    for (const [k, v] of Object.entries(b.fieldMap as Record<string, unknown>)) {
      if (!(FIELDS as readonly string[]).includes(k) && k !== 'socIsFraction') continue;
      const s = String(v ?? '').trim();
      if (s && !/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/.test(s) && k !== 'socIsFraction') throw new TelematicsError(422, `fieldMap.${k} is a dot path like data.battery.soc.`);
      if (s) map[k] = s.slice(0, 120); else delete map[k];
    }
  }
  const minutes = Number(b.pollMinutes ?? cur?.poll_minutes ?? 15);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) throw new TelematicsError(422, 'pollMinutes is 5 to 1440.');
  const auth = b.authorization !== undefined ? (b.authorization ? seal(String(b.authorization).slice(0, 2000), 'telematics') : null) : cur?.auth_sealed ?? null;
  const enabled = b.enabled === undefined ? cur?.enabled ?? true : b.enabled === true;
  const r = cur
    ? await S(() => one<any>(`UPDATE telematics_connection SET name = $2, kind = $3, url = $4, auth_sealed = $5, field_map = $6, poll_minutes = $7, enabled = $8, last_error = NULL WHERE id = $1 RETURNING *`,
      [cur.id, name, kind, url, auth, JSON.stringify(map), minutes, enabled]))
    : await S(() => one<any>(`INSERT INTO telematics_connection (org_id, name, kind, url, auth_sealed, field_map, poll_minutes, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [orgId, name, kind, url, auth, JSON.stringify(map), minutes, enabled]));
  let key: string | null = null;
  if (kind === 'webhook' && (!r.key_hash || b.rotateKey === true)) {
    key = `tlm_${randomBytes(24).toString('base64url')}`;
    await S(() => query(`UPDATE telematics_connection SET key_hash = $2, key_prefix = $3 WHERE id = $1`, [r.id, sha(key!), key!.slice(0, 8)]));
    r.key_prefix = key.slice(0, 8);
  }
  return { ...connOf(r), ...(key ? { key } : {}) };
}

/** Link a fleet vehicle to its telematics id (null to unlink). */
export async function linkVehicle(orgId: string, vehicleId: string, b: Record<string, unknown>) {
  const v = await S(() => one<any>(`SELECT id FROM fleet_vehicle WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [Number(vehicleId) || 0, orgId]));
  if (!v) throw new TelematicsError(404, 'No such vehicle.');
  const conn = b.connectionId ? String(b.connectionId) : null;
  const tid = b.telematicsId ? String(b.telematicsId).trim().slice(0, 80) : null;
  if (conn && !(await S(() => one(`SELECT 1 FROM telematics_connection WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [Number(conn) || 0, orgId])))) throw new TelematicsError(422, 'No such connection.');
  if (conn && !tid) throw new TelematicsError(422, 'telematicsId is the vehicle\'s id on the platform (often its VIN).');
  try {
    await S(() => query(`UPDATE fleet_vehicle SET telematics_connection_id = $2, telematics_vehicle_id = $3 WHERE id = $1`, [v.id, conn ? Number(conn) : null, conn ? tid : null]));
  } catch (e: any) {
    if (e?.code === '23505') throw new TelematicsError(409, 'Another vehicle has that telematics id on this connection.');
    throw e;
  }
  return { vehicleId: String(v.id), connectionId: conn, telematicsId: conn ? tid : null };
}

/** Store readings for a connection's vehicles; unknown vehicle ids are counted, not stored. */
export async function ingest(conn: { id: string | number; org_id: string; field_map: Record<string, string> }, payload: unknown, now = new Date()) {
  const rs = readingsFrom(payload, conn.field_map ?? {}, now);
  const vs = await S(() => many<{ id: string; telematics_vehicle_id: string }>(
    `SELECT id, telematics_vehicle_id FROM fleet_vehicle WHERE telematics_connection_id = $1 AND archived_at IS NULL`, [conn.id]));
  const byTid = new Map(vs.map((v) => [v.telematics_vehicle_id, v.id]));
  let stored = 0, unknown = 0;
  for (const r of rs) {
    const vid = byTid.get(r.vehicleId);
    if (!vid) { unknown++; continue; }
    const ins = await S(() => query(
      `INSERT INTO vehicle_telemetry (org_id, vehicle_id, soc_pct, range_km, lat, lon, odometer_km, charging, recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (vehicle_id, recorded_at) DO NOTHING`, [conn.org_id, vid, r.socPct, r.rangeKm, r.lat, r.lon, r.odometerKm, r.charging, r.at]));
    stored += ins.rowCount ?? 0;
  }
  await S(() => query(`UPDATE telematics_connection SET last_seen_at = now(), last_error = NULL WHERE id = $1`, [conn.id]));
  return { readings: rs.length, stored, unknownVehicles: unknown };
}

/** The webhook: a platform posts readings with its connection's key. */
export async function webhook(key: string, payload: unknown) {
  if (!/^tlm_[A-Za-z0-9_-]{20,64}$/.test(key)) throw new TelematicsError(404, 'Unknown key.');
  const c = await S(() => one<any>(`SELECT * FROM telematics_connection WHERE key_hash = $1 AND archived_at IS NULL`, [sha(key)]));
  if (!c || c.kind !== 'webhook') throw new TelematicsError(404, 'Unknown key.');
  if (!c.enabled) throw new TelematicsError(409, 'The connection is switched off.');
  return ingest(c, payload);
}

/** Read one polling connection now. */
export async function pollOne(c: any, now = new Date()) {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (c.auth_sealed) {
    try { headers.authorization = unseal(c.auth_sealed, 'telematics'); } catch { /* left out: the error below says so */ }
  }
  try {
    const r = await guardedFetch(c.url, { headers, timeoutMs: 15_000, maxBytes: 1024 * 1024 });
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
    let body: unknown;
    try { body = JSON.parse(r.text); } catch { throw new Error('the answer is not JSON'); }
    const out = await ingest(c, body, now);
    await S(() => query(`UPDATE telematics_connection SET last_polled_at = now() WHERE id = $1`, [c.id]));
    return out;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await S(() => query(`UPDATE telematics_connection SET last_polled_at = now(), last_error = $2 WHERE id = $1`, [c.id, msg]));
    throw new TelematicsError(502, `The platform did not answer usefully: ${msg}`);
  }
}

export async function pollNow(orgId: string, id: string) {
  const c = await S(() => one<any>(`SELECT * FROM telematics_connection WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [Number(id) || 0, orgId]));
  if (!c) throw new TelematicsError(404, 'No such connection.');
  if (c.kind !== 'poll') throw new TelematicsError(409, 'A webhook connection is not polled: the platform posts to it.');
  return pollOne(c);
}

/** Worker: poll the connections that are due. */
export async function pollDue(): Promise<number> {
  const due = await S(() => many<any>(
    `SELECT * FROM telematics_connection WHERE kind = 'poll' AND enabled AND archived_at IS NULL
        AND (last_polled_at IS NULL OR last_polled_at < now() - make_interval(mins => poll_minutes)) LIMIT 50`));
  let n = 0;
  for (const c of due) {
    try { await pollOne(c); n++; } catch (e) { logger.warn({ connection: c.id, err: (e as Error).message }, 'telematics poll failed'); }
  }
  return n;
}

/** Each vehicle's latest reading. */
export async function latest(orgId: string) {
  const rows = await S(() => many<any>(
    `SELECT DISTINCT ON (t.vehicle_id) t.*, v.name FROM vehicle_telemetry t JOIN fleet_vehicle v ON v.id = t.vehicle_id
      WHERE t.org_id = $1 AND v.archived_at IS NULL ORDER BY t.vehicle_id, t.recorded_at DESC`, [orgId]));
  return rows.map((r) => ({
    vehicleId: String(r.vehicle_id), vehicle: r.name, socPct: r.soc_pct == null ? null : Number(r.soc_pct), rangeKm: r.range_km == null ? null : Number(r.range_km),
    lat: r.lat, lon: r.lon, odometerKm: r.odometer_km == null ? null : Number(r.odometer_km), charging: r.charging, recordedAt: new Date(r.recorded_at).toISOString(),
    fresh: Date.now() - new Date(r.recorded_at).getTime() <= FRESH_MINUTES * 60_000,
  }));
}

/** A vehicle's state of charge from a fresh reading (≤ 30 minutes), or null. */
export async function freshSoc(vehicleId: string | number, now = new Date()): Promise<number | null> {
  const r = await S(() => one<{ soc_pct: string | null }>(
    `SELECT soc_pct FROM vehicle_telemetry WHERE vehicle_id = $1 AND soc_pct IS NOT NULL AND recorded_at > $2 ORDER BY recorded_at DESC LIMIT 1`,
    [vehicleId, new Date(now.getTime() - FRESH_MINUTES * 60_000)]));
  return r?.soc_pct == null ? null : Number(r.soc_pct);
}
