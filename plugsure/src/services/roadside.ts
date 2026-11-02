import { randomUUID } from 'node:crypto';
import { many, one, outsideRequestScope, query, tx } from '../db/pool.js';
import { persistAlert } from './alerts.js';
import * as credit from './driver-credit.js';

/**
 * Mobile and roadside charging (v1.49.0), Operate → Roadside. Vans with a battery and a DC charger go to cars that
 * cannot reach a charger:
 *
 *   requests   from the app (the driver's location, car, connector and charge level) or taken by phone in the
 *              console. Each gets a quote up front: the call-out fee plus the kWh asked for at the price per kWh.
 *              Outside the service radius of every van base, or above the most a van gives, it is refused
 *   dispatch   the console suggests the nearest available van with enough energy left; assigning it gives an ETA
 *              (distance at 30 km/h in town, plus 10 minutes). The van's technician moves it on: en route,
 *              charging, done (with the kWh delivered)
 *   paying     done: the call-out fee plus the kWh delivered at the price, paid from the driver's credit as far as it
 *              goes; the rest is collected on site (cash, QRIS, a card terminal) or invoiced, as recorded
 *   alerts     roadside.unassigned when a request waits 10 minutes without a van
 */

export class RoadsideError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const WAIT_ALERT = 'roadside.unassigned';
const S = <T>(fn: () => T) => outsideRequestScope(fn);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
const str = (v: unknown, max: number) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
export const CONNECTORS = ['CCS2', 'Type 2', 'CHAdeMO', 'GB/T'] as const;
const OPEN = ['requested', 'assigned', 'en_route', 'charging'];
const FLOW: Record<string, string[]> = { requested: ['assigned', 'cancelled'], assigned: ['en_route', 'requested', 'cancelled'], en_route: ['charging', 'cancelled'], charging: ['done'] };
const COLLECT = ['cash', 'qris', 'card_terminal', 'invoice'];

export function km(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371, r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLon - aLon) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}
/** Minutes to reach the car: 30 km/h in town, plus 10 minutes to set off. */
export const etaMinutes = (distanceKm: number) => Math.round((distanceKm / 30) * 60 + 10);
/** The price: the call-out fee plus the energy at the price per kWh (minor units, rounded). */
export const priceOf = (calloutMinor: number, perKwhMinor: number, kwh: number) => calloutMinor + Math.round(perKwhMinor * kwh);

// ------------------------------------------------------------------ settings

export async function settings(orgId: string) {
  const r = await S(() => one<any>(`SELECT * FROM roadside_settings WHERE org_id = $1`, [orgId]));
  return { enabled: !!r?.enabled, currency: r?.currency ?? (await credit.settings(orgId)).currency, calloutMinor: Number(r?.callout_minor ?? 0),
    perKwhMinor: Number(r?.per_kwh_minor ?? 0), radiusKm: Number(r?.radius_km ?? 30), maxKwh: Number(r?.max_kwh ?? 20), phone: r?.phone ?? null };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>) {
  const c = await settings(orgId);
  const v = (k: keyof typeof c, lo: number, hi: number, msg: string) => {
    const n = b[k] === undefined ? (c[k] as number) : Number(b[k]);
    if (!Number.isSafeInteger(n) || n < lo || n > hi) throw new RoadsideError(422, msg);
    return n;
  };
  const callout = v('calloutMinor', 0, Number.MAX_SAFE_INTEGER, 'calloutMinor is a whole amount, 0 or more.');
  const perKwh = v('perKwhMinor', 0, Number.MAX_SAFE_INTEGER, 'perKwhMinor is a whole amount, 0 or more.');
  const radius = v('radiusKm', 1, 300, 'radiusKm is 1 to 300.');
  const maxKwh = v('maxKwh', 1, 200, 'maxKwh is 1 to 200.');
  const enabled = b.enabled === undefined ? c.enabled : b.enabled === true;
  const phone = b.phone === undefined ? c.phone : str(b.phone, 30);
  await S(() => query(`INSERT INTO roadside_settings (org_id, enabled, currency, callout_minor, per_kwh_minor, radius_km, max_kwh, phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (org_id) DO UPDATE SET enabled = $2, callout_minor = $4, per_kwh_minor = $5, radius_km = $6, max_kwh = $7, phone = $8, updated_at = now()`,
  [orgId, enabled, c.currency, callout, perKwh, radius, maxKwh, phone]));
  return settings(orgId);
}

// ------------------------------------------------------------------ vans

const vanOf = (v: any) => ({
  id: String(v.id), name: v.name, plate: v.plate ?? null, kwhCapacity: Number(v.kwh_capacity), kwOutput: Number(v.kw_output),
  kwhLeft: v.kwh_left == null ? Number(v.kwh_capacity) : Number(v.kwh_left), baseLat: v.base_lat, baseLon: v.base_lon, lat: v.lat ?? v.base_lat, lon: v.lon ?? v.base_lon,
  locatedAt: v.located_at ? new Date(v.located_at).toISOString() : null, technicianId: v.technician_id ?? null, technician: v.tech_name ?? null, status: v.status,
});

export async function vans(orgId: string) {
  return (await S(() => many<any>(`SELECT v.*, u.name AS tech_name FROM roadside_van v LEFT JOIN app_user u ON u.id = v.technician_id
    WHERE v.org_id = $1 AND v.status <> 'archived' ORDER BY v.name`, [orgId]))).map(vanOf);
}

const coord = (lat: unknown, lon: unknown) => {
  const a = num(lat), o = num(lon);
  if (a == null && o == null) return null;
  if (a == null || o == null || !(a >= -90 && a <= 90) || !(o >= -180 && o <= 180)) throw new RoadsideError(422, 'Choose a valid location.');
  return { lat: a, lon: o };
};

export async function saveVan(orgId: string, id: string | null, b: Record<string, unknown>) {
  const cur = id ? await S(() => one<any>(`SELECT * FROM roadside_van WHERE id = $1 AND org_id = $2`, [Number(id) || 0, orgId])) : null;
  if (id && !cur) throw new RoadsideError(404, 'No such van.');
  if (cur && b.archive === true) {
    if (cur.status === 'busy') throw new RoadsideError(409, 'The van is on a request.');
    await S(() => query(`UPDATE roadside_van SET status = 'archived' WHERE id = $1`, [cur.id]));
    return { id: String(cur.id), archived: true };
  }
  // A position report (the technician's phone, or the van's tracker).
  if (cur && b.lat !== undefined && Object.keys(b).every((k) => ['lat', 'lon', 'kwhLeft'].includes(k))) {
    const p = coord(b.lat, b.lon)!;
    const left = b.kwhLeft === undefined ? cur.kwh_left : Math.max(0, Math.min(Number(cur.kwh_capacity), Number(b.kwhLeft)));
    await S(() => query(`UPDATE roadside_van SET lat = $2, lon = $3, located_at = now(), kwh_left = $4 WHERE id = $1`, [cur.id, p.lat, p.lon, left]));
    return vanOf({ ...cur, lat: p.lat, lon: p.lon, located_at: new Date(), kwh_left: left });
  }
  const name = str(b.name ?? cur?.name, 80);
  if (!name) throw new RoadsideError(422, 'A name is required.');
  const cap = Number(b.kwhCapacity ?? cur?.kwh_capacity), kw = Number(b.kwOutput ?? cur?.kw_output);
  if (!(cap > 0 && cap <= 1000)) throw new RoadsideError(422, 'kwhCapacity is the van battery\'s usable kWh.');
  if (!(kw > 0 && kw <= 400)) throw new RoadsideError(422, 'kwOutput is the charger\'s power in kW.');
  const base = coord(b.baseLat ?? cur?.base_lat, b.baseLon ?? cur?.base_lon);
  if (!base) throw new RoadsideError(422, 'The van\'s base location is required (its service radius is measured from it).');
  const tech = b.technicianId === undefined ? cur?.technician_id ?? null : b.technicianId ? String(b.technicianId) : null;
  if (tech && !(UUID_RE.test(tech) && await S(() => one(`SELECT 1 FROM app_user WHERE id = $1`, [tech])))) throw new RoadsideError(422, 'No such user.');
  const status = b.status === undefined ? cur?.status ?? 'available' : String(b.status);
  if (!['available', 'off_duty', ...(cur?.status === 'busy' ? ['busy'] : [])].includes(status)) throw new RoadsideError(422, 'status is available or off_duty.');
  const vals = [str(b.plate ?? cur?.plate, 15), cap, kw, base.lat, base.lon, tech, status];
  const r = cur
    ? await S(() => one<any>(`UPDATE roadside_van SET name = $2, plate = $3, kwh_capacity = $4, kw_output = $5, base_lat = $6, base_lon = $7, technician_id = $8, status = $9 WHERE id = $1 RETURNING *`, [cur.id, name, ...vals]))
    : await S(() => one<any>(`INSERT INTO roadside_van (org_id, name, plate, kwh_capacity, kw_output, base_lat, base_lon, technician_id, status, kwh_left) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$4) RETURNING *`, [orgId, name, ...vals]));
  return vanOf(r);
}

// ------------------------------------------------------------------ requests

const reqOf = (r: any) => ({
  id: String(r.id), number: r.number, status: r.status, name: r.name ?? null, phone: r.phone ?? null, lat: r.lat, lon: r.lon, address: r.address ?? null,
  vehicle: r.vehicle ?? null, plate: r.plate ?? null, connector: r.connector ?? null, soc: r.soc ?? null, kwhRequested: Number(r.kwh_requested),
  vanId: r.van_id == null ? null : String(r.van_id), van: r.van_name ?? null, vanPlate: r.van_plate ?? null, vanLat: r.van_lat ?? null, vanLon: r.van_lon ?? null,
  etaAt: r.eta_at ? new Date(r.eta_at).toISOString() : null, kwhDelivered: num(r.kwh_delivered), quoteMinor: Number(r.quote_minor),
  amountMinor: num(r.amount_minor), creditMinor: Number(r.credit_minor), collectMinor: Number(r.collect_minor), collectedBy: r.collected_by ?? null, currency: r.currency,
  cancelReason: r.cancel_reason ?? null, note: r.note ?? null, fromApp: !!r.app_driver_id,
  createdAt: new Date(r.created_at).toISOString(), waitingMin: Math.floor((Date.now() - new Date(r.created_at).getTime()) / 60_000),
  doneAt: r.done_at ? new Date(r.done_at).toISOString() : null,
});
const REQ_SELECT = `SELECT r.*, v.name AS van_name, v.plate AS van_plate, COALESCE(v.lat, v.base_lat) AS van_lat, COALESCE(v.lon, v.base_lon) AS van_lon
  FROM roadside_request r LEFT JOIN roadside_van v ON v.id = r.van_id`;

export async function requests(orgId: string, q: Record<string, unknown> = {}) {
  const open = q.status !== 'all';
  const rows = (await S(() => many<any>(`${REQ_SELECT} WHERE r.org_id = $1 AND ($2 = false OR r.status = ANY($3) OR r.created_at > now() - interval '1 day')
    ORDER BY (r.status = ANY($3)) DESC, r.created_at DESC LIMIT 500`, [orgId, open, OPEN]))).map(reqOf);
  const k = await S(() => one<any>(`SELECT count(*) FILTER (WHERE status = 'done') AS done, COALESCE(sum(amount_minor) FILTER (WHERE status = 'done'), 0) AS revenue,
      COALESCE(sum(kwh_delivered) FILTER (WHERE status = 'done'), 0) AS kwh, count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM arrived_at - created_at) / 60) FILTER (WHERE arrived_at IS NOT NULL) AS arrive_min
    FROM roadside_request WHERE org_id = $1 AND created_at > now() - interval '30 days'`, [orgId]));
  return { requests: rows, kpis: { open: rows.filter((r) => OPEN.includes(r.status)).length, done30d: Number(k?.done ?? 0), revenue30dMinor: Number(k?.revenue ?? 0),
    kwh30d: Number(k?.kwh ?? 0), cancelled30d: Number(k?.cancelled ?? 0), medianArrivalMin: k?.arrive_min == null ? null : Math.round(Number(k.arrive_min)) } };
}

/** Vans that can take a request, nearest first: available, with enough energy left, within the radius of their base. */
export async function candidates(orgId: string, lat: number, lon: number, kwh: number) {
  const s = await settings(orgId);
  return (await vans(orgId)).filter((v) => v.status === 'available' && v.baseLat != null)
    .map((v) => ({ ...v, distanceKm: km(v.lat, v.lon, lat, lon), fromBaseKm: km(v.baseLat, v.baseLon, lat, lon) }))
    .filter((v) => v.fromBaseKm <= s.radiusKm && v.kwhLeft >= kwh).sort((a, b) => a.distanceKm - b.distanceKm)
    .map((v) => ({ id: v.id, name: v.name, plate: v.plate, distanceKm: v.distanceKm, etaMin: etaMinutes(v.distanceKm), kwhLeft: v.kwhLeft }));
}

async function inArea(orgId: string, lat: number, lon: number) {
  const s = await settings(orgId);
  return (await vans(orgId)).some((v) => v.baseLat != null && km(v.baseLat, v.baseLon, lat, lon) <= s.radiusKm);
}

async function nextNumber(c: any, orgId: string) {
  const n = (await c.query(`SELECT count(*) + 1 AS n FROM roadside_request WHERE org_id = $1`, [orgId])).rows[0].n;
  return `RSA-${String(n).padStart(4, '0')}`;
}

async function create(orgId: string, b: Record<string, unknown>, appDriverId: string | null, phone: string | null) {
  const s = await settings(orgId);
  if (!s.enabled) throw new RoadsideError(404, 'Layanan isi daya darurat tidak tersedia.');
  const p = coord(b.lat, b.lon);
  if (!p) throw new RoadsideError(422, 'Lokasi diperlukan.');
  const kwh = Number(b.kwh ?? 10);
  if (!(kwh >= 1 && kwh <= s.maxKwh)) throw new RoadsideError(422, 'Jumlah kWh di luar batas.');
  const conn = b.connector == null || b.connector === '' ? null : String(b.connector);
  if (conn && !(CONNECTORS as readonly string[]).includes(conn)) throw new RoadsideError(422, 'Jenis konektor tidak dikenal.');
  if (!(await inArea(orgId, p.lat, p.lon))) throw new RoadsideError(422, 'Lokasi Anda di luar area layanan.');
  const soc = b.soc == null || b.soc === '' ? null : Math.round(Number(b.soc));
  if (soc != null && !(soc >= 0 && soc <= 100)) throw new RoadsideError(422, 'Isi baterai 0 sampai 100 persen.');
  const quote = priceOf(s.calloutMinor, s.perKwhMinor, kwh);
  return S(() => tx(async (c) => {
    const number = await nextNumber(c, orgId);
    const r = (await c.query(`INSERT INTO roadside_request (org_id, number, app_driver_id, name, phone, lat, lon, address, vehicle, plate, connector, soc, kwh_requested, quote_minor, currency, note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [orgId, number, appDriverId, str(b.name, 80), phone ?? str(b.phone, 30), p.lat, p.lon, str(b.address, 200), str(b.vehicle, 80), str(b.plate, 15)?.toUpperCase() ?? null,
      conn, soc, kwh, quote, s.currency, str(b.note, 500)])).rows[0];
    return reqOf(r);
  }));
}

export const createRequest = (orgId: string, b: Record<string, unknown>) => create(orgId, b, null, null);

async function reqRow(orgId: string, id: string) {
  const r = await S(() => one<any>(`${REQ_SELECT} WHERE r.id = $1 AND r.org_id = $2`, [Number(id) || 0, orgId]));
  if (!r) throw new RoadsideError(404, 'No such request.');
  return r;
}

export async function getRequest(orgId: string, id: string) {
  const r = await reqRow(orgId, id);
  return { ...reqOf(r), candidates: OPEN.includes(r.status) ? await candidates(orgId, r.lat, r.lon, Number(r.kwh_requested)) : [] };
}

/** Move a request on: assign (vanId), en_route, charging, done (kwhDelivered, collectedBy), cancel (reason). */
export async function advance(orgId: string, id: string, b: Record<string, unknown>) {
  const r = await reqRow(orgId, id);
  const to = String(b.status ?? '');
  if (!(FLOW[r.status] ?? []).includes(to)) throw new RoadsideError(409, `A ${r.status.replace('_', ' ')} request cannot go to ${to.replace('_', ' ') || 'nothing'}.`);
  const s = await settings(orgId);
  if (to === 'assigned') {
    const van = await S(() => one<any>(`SELECT * FROM roadside_van WHERE id = $1 AND org_id = $2`, [Number(b.vanId) || 0, orgId]));
    if (!van || van.status !== 'available') throw new RoadsideError(409, 'That van is not available.');
    const d = km(van.lat ?? van.base_lat, van.lon ?? van.base_lon, r.lat, r.lon);
    await S(() => tx(async (c) => {
      const got = (await c.query(`UPDATE roadside_van SET status = 'busy' WHERE id = $1 AND status = 'available' RETURNING id`, [van.id])).rows[0];
      if (!got) throw new RoadsideError(409, 'That van was just taken.');
      await c.query(`UPDATE roadside_request SET status = 'assigned', van_id = $2, assigned_at = now(), eta_at = now() + make_interval(mins => $3) WHERE id = $1`, [r.id, van.id, etaMinutes(d)]);
    }));
    await S(() => query(`UPDATE alert SET resolved_at = now() WHERE org_id = $1 AND kind = $2 AND target_type = 'roadside_request' AND target_id = $3 AND resolved_at IS NULL`, [orgId, WAIT_ALERT, String(r.id)]));
  } else if (to === 'requested') {
    await S(() => tx(async (c) => {
      await c.query(`UPDATE roadside_van SET status = 'available' WHERE id = $1 AND status = 'busy'`, [r.van_id]);
      await c.query(`UPDATE roadside_request SET status = 'requested', van_id = NULL, eta_at = NULL, assigned_at = NULL WHERE id = $1`, [r.id]);
    }));
  } else if (to === 'en_route') {
    await S(() => query(`UPDATE roadside_request SET status = 'en_route' WHERE id = $1`, [r.id]));
  } else if (to === 'charging') {
    await S(() => query(`UPDATE roadside_request SET status = 'charging', arrived_at = now() WHERE id = $1`, [r.id]));
  } else if (to === 'cancelled') {
    const reason = str(b.reason, 300);
    if (!reason) throw new RoadsideError(422, 'Say why it is cancelled.');
    await S(() => tx(async (c) => {
      if (r.van_id) await c.query(`UPDATE roadside_van SET status = 'available' WHERE id = $1 AND status = 'busy'`, [r.van_id]);
      await c.query(`UPDATE roadside_request SET status = 'cancelled', cancel_reason = $2, done_at = now() WHERE id = $1`, [r.id, reason]);
    }));
  } else if (to === 'done') {
    const kwh = Number(b.kwhDelivered);
    if (!(kwh >= 0 && kwh <= 500)) throw new RoadsideError(422, 'kwhDelivered is the energy the car received.');
    const by = b.collectedBy == null || b.collectedBy === '' ? null : String(b.collectedBy);
    if (by && !COLLECT.includes(by)) throw new RoadsideError(422, `collectedBy is ${COLLECT.join(', ')}.`);
    const amount = priceOf(s.calloutMinor, s.perKwhMinor, Math.round(kwh * 100) / 100);
    const have = r.app_driver_id && amount > 0 ? Math.min(amount, (await credit.balance(orgId, r.app_driver_id, r.currency)).totalMinor) : 0;
    if (amount - have > 0 && !by) throw new RoadsideError(422, `${amount - have} is left after credit: say how it is collected (${COLLECT.join(', ')}).`);
    let fromCredit = 0;
    if (have > 0) {
      const ref = randomUUID();
      const h = await credit.hold(orgId, r.app_driver_id, r.currency, have, ref);
      fromCredit = (await credit.settle(ref, h.heldMinor)).usedMinor;
    }
    const left = amount - fromCredit;
    await S(() => tx(async (c) => {
      await c.query(`UPDATE roadside_request SET status = 'done', kwh_delivered = $2, amount_minor = $3, credit_minor = $4, collect_minor = $5, collected_by = $6, done_at = now() WHERE id = $1`,
        [r.id, kwh, amount, fromCredit, left, left > 0 ? by : null]);
      await c.query(`UPDATE roadside_van SET status = 'available', kwh_left = GREATEST(0, COALESCE(kwh_left, kwh_capacity) - $2), lat = $3, lon = $4, located_at = now() WHERE id = $1 AND status = 'busy'`,
        [r.van_id, kwh / 0.9, r.lat, r.lon]);
    }));
  }
  return getRequest(orgId, id);
}

// ------------------------------------------------------------------ the driver (app)

export async function orgForApp(brandOrg: string | null): Promise<string | null> {
  if (brandOrg) return brandOrg;
  const r = await S(() => many<any>(`SELECT org_id FROM roadside_settings WHERE enabled LIMIT 2`));
  return r.length === 1 ? r[0].org_id : null;
}

export async function driverInfo(appDriverId: string, brandOrg: string | null) {
  const orgId = await orgForApp(brandOrg);
  const s = orgId ? await settings(orgId) : null;
  if (!orgId || !s?.enabled) return { enabled: false };
  const cur = await S(() => one<any>(`${REQ_SELECT} WHERE r.org_id = $1 AND r.app_driver_id = $2 AND (r.status = ANY($3) OR r.done_at > now() - interval '2 hours') ORDER BY r.created_at DESC LIMIT 1`, [orgId, appDriverId, OPEN]));
  return {
    enabled: true, currency: s.currency, calloutMinor: s.calloutMinor, perKwhMinor: s.perKwhMinor, maxKwh: s.maxKwh, phone: s.phone, connectors: CONNECTORS,
    balanceMinor: (await credit.balance(orgId, appDriverId, s.currency)).totalMinor,
    request: cur ? (({ lat, lon, vanLat, vanLon, ...x }) => ({ ...x, vanDistanceKm: vanLat != null && OPEN.includes(cur.status) ? km(vanLat, vanLon, lat, lon) : null }))(reqOf(cur)) : null,
  };
}

export async function driverRequest(appDriverId: string, brandOrg: string | null, b: Record<string, unknown>) {
  const orgId = await orgForApp(brandOrg);
  if (!orgId) throw new RoadsideError(404, 'Layanan isi daya darurat tidak tersedia.');
  if (await S(() => one(`SELECT 1 FROM roadside_request WHERE org_id = $1 AND app_driver_id = $2 AND status = ANY($3)`, [orgId, appDriverId, OPEN]))) throw new RoadsideError(409, 'Anda sudah punya permintaan yang sedang berjalan.');
  const d = await S(() => one<any>(`SELECT phone, name FROM app_driver WHERE id = $1`, [appDriverId]));
  const r = await create(orgId, { ...b, name: b.name ?? d?.name }, appDriverId, d?.phone ?? null);
  return { ...r, ...(await driverInfo(appDriverId, brandOrg)) };
}

export async function driverCancel(appDriverId: string, brandOrg: string | null) {
  const orgId = await orgForApp(brandOrg);
  const r = orgId ? await S(() => one<any>(`SELECT * FROM roadside_request WHERE org_id = $1 AND app_driver_id = $2 AND status = ANY($3) ORDER BY created_at DESC LIMIT 1`, [orgId, appDriverId, OPEN])) : null;
  if (!r) throw new RoadsideError(404, 'Tidak ada permintaan yang bisa dibatalkan.');
  if (r.status === 'charging') throw new RoadsideError(409, 'Pengisian sudah dimulai; tidak bisa dibatalkan.');
  await advance(orgId!, String(r.id), { status: 'cancelled', reason: 'Cancelled by the driver in the app.' });
  return driverInfo(appDriverId, brandOrg);
}

// ------------------------------------------------------------------ the worker

export async function sweep(): Promise<number> {
  const rows = await S(() => many<any>(`SELECT * FROM roadside_request WHERE status = 'requested' AND created_at < now() - interval '10 minutes' LIMIT 200`));
  for (const r of rows) {
    await S(() => persistAlert({ orgId: r.org_id, kind: WAIT_ALERT, severity: 'critical', targetType: 'roadside_request', targetId: String(r.id),
      message: `Roadside request ${r.number}${r.address ? ` at ${r.address}` : ''} has waited ${Math.floor((Date.now() - new Date(r.created_at).getTime()) / 60_000)} minutes without a van.` } as any)).catch(() => null);
  }
  return rows.length;
}
