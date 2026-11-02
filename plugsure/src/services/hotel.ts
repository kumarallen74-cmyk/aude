import { createHash, createHmac, randomBytes } from 'node:crypto';
import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { guardedFetch, refuseOutboundUrl } from './net-guard.js';
import { seal, unseal } from './secrets.js';
import { persistAlert } from './alerts.js';
import { xlsx } from './xlsx.js';

/**
 * Hotels and hospitality (v1.48.0), Commercial → Hotels. Guests charge on their room:
 *
 *   property   a hotel at a site; its charges are posted to the guest's folio in the hotel's PMS (posting: pms, its
 *              address, signed) or billed to the hotel monthly (posting: statement)
 *   stays      a guest in a room (checked in from the console, or by the PMS posting check-ins and check-outs to its
 *              own address with the property's key); each stay has its own guest card, retired at check-out
 *   valet      the hotel's staff page (a secret link, /valet/<token>): the site's connectors with their state and the
 *              rooms in house; start charging for a room, stop it. No console account needed.
 *   charges    every session of a stay's card: when it ends, its charge record's total goes to the folio (retried with
 *              back-off; an alert after 10 failures) or onto the month's statement
 */

export class HotelError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const HOTEL_ALERT = 'hotel.post_failed';
const S = <T>(fn: () => T) => outsideRequestScope(fn);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const AAD = 'hotel-pms';
const MAX_ATTEMPTS = 10;

const propOf = (p: any) => ({
  id: String(p.id), siteId: p.site_id, site: p.site_name ?? null, name: p.name, posting: p.posting, pmsUrl: p.pms_url ?? null, hasPmsSecret: !!p.pms_secret_sealed,
  pmsKeyPrefix: p.pms_key_prefix ?? null, valetLinked: !!p.valet_token_hash, currency: p.currency, inHouse: Number(p.in_house ?? 0), archived: !!p.archived_at,
});
const PROP_SELECT = `SELECT p.*, s.name AS site_name, (SELECT count(*) FROM hotel_stay st WHERE st.property_id = p.id AND st.status = 'in_house') AS in_house
  FROM hotel_property p JOIN site s ON s.id = p.site_id`;

export async function properties(orgId: string) {
  return (await S(() => many<any>(`${PROP_SELECT} WHERE p.org_id = $1 AND p.archived_at IS NULL ORDER BY p.name`, [orgId]))).map(propOf);
}

async function propRow(orgId: string, id: string) {
  const p = await S(() => one<any>(`${PROP_SELECT} WHERE p.id = $1 AND p.org_id = $2 AND p.archived_at IS NULL`, [Number(id) || 0, orgId]));
  if (!p) throw new HotelError(404, 'No such hotel.');
  return p;
}

export async function saveProperty(orgId: string, id: string | null, b: Record<string, unknown>) {
  const cur = id ? await propRow(orgId, id) : null;
  if (cur && b.archive === true) {
    if (Number(cur.in_house)) throw new HotelError(409, 'Check the guests in house out first.');
    await S(() => query(`UPDATE hotel_property SET archived_at = now(), pms_key_hash = NULL, valet_token_hash = NULL WHERE id = $1`, [cur.id]));
    return { id: String(cur.id), archived: true };
  }
  const v = (k: string, col: string) => (b[k] !== undefined ? b[k] : cur?.[col]);
  const name = String(v('name', 'name') ?? '').trim().slice(0, 120);
  if (!name) throw new HotelError(422, 'name is required.');
  const siteId = String(v('siteId', 'site_id') ?? '');
  const site = UUID_RE.test(siteId) ? await S(() => one<any>(`SELECT s.id, co.currency FROM site s JOIN country co ON co.code = s.country_code WHERE s.id = $1 AND s.org_id = $2 AND s.archived_at IS NULL`, [siteId, orgId])) : null;
  if (!site) throw new HotelError(422, 'No such site.');
  const posting = String(v('posting', 'posting') ?? 'statement');
  if (!['pms', 'statement'].includes(posting)) throw new HotelError(422, 'posting is pms (to the guest\'s folio) or statement (billed to the hotel monthly).');
  let url: string | null = v('pmsUrl', 'pms_url') ? String(v('pmsUrl', 'pms_url')).trim() : null;
  if (posting === 'pms') {
    if (!url) throw new HotelError(422, 'pmsUrl is the PMS address charges are posted to.');
    let u: URL;
    try { u = new URL(url); } catch { throw new HotelError(422, 'pmsUrl is not a URL.'); }
    const why = refuseOutboundUrl(u);
    if (why) throw new HotelError(422, `pmsUrl: ${why}.`);
    url = u.toString();
  }
  const secret = b.pmsSecret !== undefined ? (b.pmsSecret ? seal(String(b.pmsSecret).slice(0, 500), AAD) : null) : cur?.pms_secret_sealed ?? null;
  const vals = [orgId, siteId, name, posting, url, secret, site.currency];
  const r = cur
    ? await S(() => one<any>(`UPDATE hotel_property SET site_id = $2, name = $3, posting = $4, pms_url = $5, pms_secret_sealed = $6, currency = $7 WHERE id = $8 AND org_id = $1 RETURNING *`, [...vals, cur.id]))
    : await S(() => one<any>(`INSERT INTO hotel_property (org_id, site_id, name, posting, pms_url, pms_secret_sealed, currency) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, vals));
  let pmsKey: string | null = null;
  if (!r.pms_key_hash || b.rotatePmsKey === true) {
    pmsKey = `hpk_${randomBytes(24).toString('base64url')}`;
    await S(() => query(`UPDATE hotel_property SET pms_key_hash = $2, pms_key_prefix = $3 WHERE id = $1`, [r.id, sha(pmsKey!), pmsKey!.slice(0, 8)]));
  }
  return { ...propOf(await propRow(orgId, String(r.id))), ...(pmsKey ? { pmsKey } : {}) };
}

export async function rotateValet(orgId: string, id: string) {
  const p = await propRow(orgId, id);
  const token = `vlt_${randomBytes(24).toString('base64url')}`;
  await S(() => query(`UPDATE hotel_property SET valet_token_hash = $2, valet_token_prefix = $3 WHERE id = $1`, [p.id, sha(token), token.slice(0, 8)]));
  return { token, path: `/valet/${token}` };
}

// ------------------------------------------------------------------ stays

const stayOf = (s: any) => ({
  id: String(s.id), propertyId: String(s.property_id), room: s.room, guestName: s.guest_name, reservationRef: s.reservation_ref ?? null,
  arrivalOn: s.arrival_s ?? null, departureOn: s.departure_s ?? null, plate: s.plate ?? null, status: s.status,
  checkedOutAt: s.checked_out_at ? new Date(s.checked_out_at).toISOString() : null, charges: Number(s.charges ?? 0), amountMinor: Number(s.amount ?? 0),
});
const STAY_SELECT = `SELECT st.*, to_char(st.arrival_on, 'YYYY-MM-DD') AS arrival_s, to_char(st.departure_on, 'YYYY-MM-DD') AS departure_s,
    (SELECT count(*) FROM hotel_charge c WHERE c.stay_id = st.id AND c.status <> 'void') AS charges,
    (SELECT COALESCE(sum(amount_minor), 0) FROM hotel_charge c WHERE c.stay_id = st.id AND c.status <> 'void') AS amount
  FROM hotel_stay st`;

export async function stays(orgId: string, propertyId: string, q: Record<string, unknown> = {}) {
  const p = await propRow(orgId, propertyId);
  const all = q.status === 'all';
  return (await S(() => many<any>(`${STAY_SELECT} WHERE st.property_id = $1 AND ($2 OR st.status = 'in_house') ORDER BY st.status, st.room, st.id DESC LIMIT 500`, [p.id, all]))).map(stayOf);
}

const isoDate = (v: unknown) => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v).slice(0, 10)) ? String(v).slice(0, 10) : null);

async function checkInRow(p: any, b: Record<string, unknown>) {
  const room = String(b.room ?? '').trim().slice(0, 20);
  if (!room) throw new HotelError(422, 'room is required.');
  const guest = String(b.guestName ?? '').trim().slice(0, 120);
  if (!guest) throw new HotelError(422, 'guestName is required.');
  const uid = `HTL-${randomBytes(6).toString('hex').toUpperCase()}`;
  const tok = await S(() => one<{ id: string }>(`INSERT INTO token (org_id, kind, uid, status, offline_allowed) VALUES ($1, 'guest', $2, 'Accepted', false) RETURNING id`, [p.org_id, uid]));
  try {
    const r = await S(() => one<any>(
      `INSERT INTO hotel_stay (org_id, property_id, room, guest_name, reservation_ref, arrival_on, departure_on, plate, token_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [p.org_id, p.id, room, guest, b.reservationRef ? String(b.reservationRef).slice(0, 60) : null, isoDate(b.arrivalOn) ?? new Date().toISOString().slice(0, 10), isoDate(b.departureOn),
        b.plate ? String(b.plate).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15) : null, tok!.id]));
    return String(r.id);
  } catch (e: any) {
    await S(() => query(`UPDATE token SET status = 'Expired' WHERE id = $1`, [tok!.id]));
    if (e?.code === '23505') throw new HotelError(409, `Room ${room} already has a guest in house.`);
    throw e;
  }
}

export async function checkIn(orgId: string, propertyId: string, b: Record<string, unknown>) {
  const p = await propRow(orgId, propertyId);
  const id = await checkInRow(p, b);
  return stayOf(await S(() => one<any>(`${STAY_SELECT} WHERE st.id = $1`, [id])));
}

async function checkOutRow(stay: any) {
  await S(() => query(`UPDATE hotel_stay SET status = 'checked_out', checked_out_at = now() WHERE id = $1 AND status = 'in_house'`, [stay.id]));
  // The guest card stops; a session still running ends as usual and is still charged to the stay.
  await S(() => query(`UPDATE token SET status = 'Expired' WHERE id = $1`, [stay.token_id]));
}

export async function updateStay(orgId: string, stayId: string, b: Record<string, unknown>) {
  const st = await S(() => one<any>(`SELECT * FROM hotel_stay WHERE id = $1 AND org_id = $2`, [Number(stayId) || 0, orgId]));
  if (!st) throw new HotelError(404, 'No such stay.');
  if (b.action === 'check_out') await checkOutRow(st);
  else if (st.status !== 'in_house') throw new HotelError(409, 'The guest has checked out.');
  else {
    try {
      await S(() => query(`UPDATE hotel_stay SET room = COALESCE($2, room), departure_on = COALESCE($3::date, departure_on), plate = COALESCE($4, plate) WHERE id = $1`,
        [st.id, b.room ? String(b.room).trim().slice(0, 20) : null, isoDate(b.departureOn), b.plate ? String(b.plate).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15) : null]));
    } catch (e: any) { if (e?.code === '23505') throw new HotelError(409, 'That room already has a guest in house.'); throw e; }
  }
  return stayOf(await S(() => one<any>(`${STAY_SELECT} WHERE st.id = $1`, [st.id])));
}

/** The PMS posts check-ins, check-outs and room moves with the property's key. */
export async function pmsEvent(key: string, b: Record<string, unknown>) {
  if (!/^hpk_[A-Za-z0-9_-]{20,64}$/.test(key)) throw new HotelError(404, 'Unknown key.');
  const p = await S(() => one<any>(`SELECT * FROM hotel_property WHERE pms_key_hash = $1 AND archived_at IS NULL`, [sha(key)]));
  if (!p) throw new HotelError(404, 'Unknown key.');
  const ev = String(b.event ?? '');
  const ref = b.reservationRef ? String(b.reservationRef) : null;
  const find = async () => S(() => one<any>(
    `SELECT * FROM hotel_stay WHERE property_id = $1 AND status = 'in_house' AND (($2::text IS NOT NULL AND reservation_ref = $2) OR ($2::text IS NULL AND room = $3)) ORDER BY id DESC LIMIT 1`,
    [p.id, ref, String(b.room ?? '')]));
  if (ev === 'check_in') {
    const again = ref ? await find() : null;
    if (again) return { stayId: String(again.id), duplicate: true };
    return { stayId: await checkInRow(p, b) };
  }
  const st = await find();
  if (!st) throw new HotelError(404, 'No guest in house for that reservation or room.');
  if (ev === 'check_out') { await checkOutRow(st); return { stayId: String(st.id), status: 'checked_out' }; }
  if (ev === 'room_move') {
    const room = String(b.newRoom ?? '').trim().slice(0, 20);
    if (!room) throw new HotelError(422, 'newRoom is required.');
    try { await S(() => query(`UPDATE hotel_stay SET room = $2 WHERE id = $1`, [st.id, room])); } catch (e: any) { if (e?.code === '23505') throw new HotelError(409, `Room ${room} already has a guest in house.`); throw e; }
    return { stayId: String(st.id), room };
  }
  throw new HotelError(422, 'event is check_in, check_out or room_move.');
}

// ------------------------------------------------------------------ the valet page

async function byValet(token: string) {
  if (!/^vlt_[A-Za-z0-9_-]{20,64}$/.test(token)) throw new HotelError(404, 'This link is not valid (any more).');
  const p = await S(() => one<any>(`SELECT * FROM hotel_property WHERE valet_token_hash = $1 AND archived_at IS NULL`, [sha(token)]));
  if (!p) throw new HotelError(404, 'This link is not valid (any more).');
  return p;
}

export async function valetView(token: string) {
  const p = await byValet(token);
  const conns = await S(() => many<any>(
    `SELECT c.id, c.status, e.evse_id, COALESCE(cp.display_name, cp.ocpp_identity) AS charger, c.max_power_w,
            (SELECT cs.id FROM charging_session cs WHERE cs.connector_uuid = c.id AND cs.state = 'active' LIMIT 1) AS session_id
       FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id
      WHERE cp.site_id = $1 AND cp.status NOT IN ('pending_adoption', 'decommissioned') ORDER BY 3, e.evse_id`, [p.site_id]));
  const inHouse = await S(() => many<any>(`SELECT id, room, guest_name, plate, token_id FROM hotel_stay WHERE property_id = $1 AND status = 'in_house' ORDER BY room`, [p.id]));
  const charging = await S(() => many<any>(
    `SELECT cs.id AS session_id, cs.connector_uuid, cs.started_at, COALESCE(cs.energy_wh, 0) AS wh, st.room FROM charging_session cs JOIN hotel_stay st ON st.token_id = cs.token_id
      WHERE st.property_id = $1 AND cs.state = 'active'`, [p.id]));
  const byConn = new Map(charging.map((c) => [c.connector_uuid, c]));
  return {
    hotel: p.name,
    connectors: conns.map((c) => {
      const ch = byConn.get(c.id);
      return { id: c.id, charger: c.charger, connector: c.evse_id, status: c.status, kw: Math.round(Number(c.max_power_w ?? 0) / 100) / 10,
        charging: ch ? { sessionId: ch.session_id, room: ch.room, since: new Date(ch.started_at).toISOString(), kwh: Number(ch.wh) / 1000 } : c.session_id ? { sessionId: null, room: null, since: null, kwh: null } : null };
    }),
    // Guests are shown by room and initial only.
    rooms: inHouse.map((s) => ({ stayId: String(s.id), room: s.room, guest: `${String(s.guest_name).trim().charAt(0)}.`, plate: s.plate ?? null })),
  };
}

export async function valetAction(token: string, b: Record<string, unknown>) {
  const p = await byValet(token);
  const commands = await import('../ocpp/commands.js');
  const actor = { type: 'system' as const, orgId: p.org_id };
  const { writeAudit } = await import('./audit.js');
  if (b.action === 'start') {
    const st = await S(() => one<any>(`SELECT st.*, t.uid FROM hotel_stay st JOIN token t ON t.id = st.token_id WHERE st.id = $1 AND st.property_id = $2 AND st.status = 'in_house'`, [Number(b.stayId) || 0, p.id]));
    if (!st) throw new HotelError(422, 'Choose a room with a guest in house.');
    const c = await S(() => one<any>(
      `SELECT c.id, c.status, e.evse_id, cp.ocpp_identity FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id WHERE c.id = $1 AND cp.site_id = $2`,
      [UUID_RE.test(String(b.connectorId ?? '')) ? b.connectorId : null, p.site_id]));
    if (!c) throw new HotelError(422, 'Choose a connector at the hotel.');
    if (!['Available', 'Preparing'].includes(String(c.status))) throw new HotelError(409, `The connector is ${String(c.status ?? 'not available').toLowerCase()}: plug the car in first.`);
    if (!commands.reachable(c.ocpp_identity)) throw new HotelError(409, 'The charger is not connected.');
    const r = await commands.remoteStartTransaction(c.ocpp_identity, c.evse_id, st.uid, actor);
    await writeAudit({ orgId: p.org_id, actorType: 'system', actorId: `valet:${p.valet_token_prefix ?? ''}`, action: 'hotel.valet_start', targetType: 'hotel_stay', targetId: String(st.id), after: { room: st.room, connector: c.id, status: r?.status ?? null } });
    if (r?.status !== 'Accepted') throw new HotelError(409, 'The charger did not start. Check that the car is plugged in.');
    return { started: true, room: st.room };
  }
  if (b.action === 'stop') {
    const s = await S(() => one<any>(
      `SELECT cs.id, cs.ocpp_transaction_id, cp.ocpp_identity, st.room FROM charging_session cs JOIN hotel_stay st ON st.token_id = cs.token_id JOIN charge_point cp ON cp.id = cs.charge_point_id
        WHERE cs.id = $1 AND st.property_id = $2 AND cs.state = 'active'`, [UUID_RE.test(String(b.sessionId ?? '')) ? b.sessionId : null, p.id]));
    if (!s) throw new HotelError(404, 'No such charging session.');
    const r = await commands.remoteStopTransaction(s.ocpp_identity, s.ocpp_transaction_id, actor);
    await writeAudit({ orgId: p.org_id, actorType: 'system', actorId: `valet:${p.valet_token_prefix ?? ''}`, action: 'hotel.valet_stop', targetType: 'charging_session', targetId: s.id, after: { room: s.room, status: r?.status ?? null } });
    return { stopped: r?.status === 'Accepted', room: s.room };
  }
  throw new HotelError(422, 'action is start or stop.');
}

// ------------------------------------------------------------------ charges

const chargeOf = (c: any) => ({
  id: String(c.id), stayId: String(c.stay_id), room: c.room ?? null, guestName: c.guest_name ?? null, sessionId: c.session_id, kwh: c.kwh == null ? null : Number(c.kwh),
  amountMinor: c.amount_minor == null ? null : Number(c.amount_minor), currency: c.currency, status: c.status, lastError: c.last_error ?? null,
  postedAt: c.posted_at ? new Date(c.posted_at).toISOString() : null, createdAt: new Date(c.created_at).toISOString(),
});

export async function charges(orgId: string, propertyId: string, q: Record<string, unknown> = {}) {
  const p = await propRow(orgId, propertyId);
  const month = MONTH_RE.test(String(q.month ?? '')) ? String(q.month) : null;
  return (await S(() => many<any>(
    `SELECT c.*, st.room, st.guest_name FROM hotel_charge c JOIN hotel_stay st ON st.id = c.stay_id
      WHERE c.property_id = $1 AND ($2::text IS NULL OR to_char(c.created_at, 'YYYY-MM') = $2) ORDER BY c.created_at DESC LIMIT 500`, [p.id, month]))).map(chargeOf);
}

/** A month's statement: the charges billed to the hotel (not posted to folios). */
export async function statement(orgId: string, propertyId: string, monthRaw: unknown) {
  const p = await propRow(orgId, propertyId);
  const month = MONTH_RE.test(String(monthRaw ?? '')) ? String(monthRaw) : new Date().toISOString().slice(0, 7);
  const rows = (await charges(orgId, propertyId, { month })).filter((c) => c.status === 'on_statement');
  return { hotel: p.name, month, currency: p.currency, charges: rows, kwh: Math.round(rows.reduce((a, c) => a + (c.kwh ?? 0), 0) * 1000) / 1000, amountMinor: rows.reduce((a, c) => a + (c.amountMinor ?? 0), 0) };
}

export async function statementXlsx(orgId: string, propertyId: string, month: string) {
  const s = await statement(orgId, propertyId, month);
  return xlsx([{ name: 'Statement', rows: [
    [`${s.hotel} · charging · ${s.month}`], [],
    ['Date', 'Room', 'Guest', 'kWh', `Amount (${s.currency}, minor units)`],
    ...s.charges.map((c) => [c.createdAt.slice(0, 10), c.room ?? '', c.guestName ?? '', c.kwh ?? 0, c.amountMinor ?? 0]),
    [], ['Total', '', '', s.kwh, s.amountMinor],
  ] }]);
}

export async function retryCharge(orgId: string, id: string) {
  const c = await S(() => one<any>(`UPDATE hotel_charge SET status = 'charging', attempts = 0, updated_at = now() WHERE id = $1 AND org_id = $2 AND status = 'post_failed' RETURNING id`, [Number(id) || 0, orgId]));
  if (!c) throw new HotelError(409, 'Only a charge that could not be posted can be sent again.');
  return { id: String(c.id), status: 'charging' };
}

/** Worker (every minute): stays' sessions found; ended ones posted to the folio or put on the statement. */
export async function settle(now = new Date()): Promise<{ linked: number; posted: number; statement: number }> {
  const linked = (await S(() => query(
    `INSERT INTO hotel_charge (org_id, property_id, stay_id, session_id, currency)
     SELECT st.org_id, st.property_id, st.id, cs.id, p.currency FROM charging_session cs JOIN hotel_stay st ON st.token_id = cs.token_id JOIN hotel_property p ON p.id = st.property_id
      WHERE cs.started_at > now() - interval '30 days' AND NOT EXISTS (SELECT 1 FROM hotel_charge c WHERE c.session_id = cs.id)
     ON CONFLICT (session_id) DO NOTHING`))).rowCount ?? 0;
  let posted = 0, onStatement = 0;
  const due = await S(() => many<any>(
    `SELECT c.*, cs.state, cs.ended_at, COALESCE(cs.energy_wh, 0) AS wh, d.total_minor, p.posting, p.pms_url, p.pms_secret_sealed, p.name AS hotel,
            st.room, st.guest_name, st.reservation_ref
       FROM hotel_charge c JOIN charging_session cs ON cs.id = c.session_id LEFT JOIN cdr d ON d.session_id = cs.id
       JOIN hotel_property p ON p.id = c.property_id JOIN hotel_stay st ON st.id = c.stay_id
      WHERE c.status = 'charging' AND cs.state <> 'active'
        AND (c.attempts = 0 OR c.updated_at < now() - make_interval(secs => LEAST(3600, 30 * power(2, c.attempts))))`));
  for (const c of due) {
    // Wait (up to 15 minutes after the end) for the charge record.
    if (c.total_minor == null && Number(c.wh) > 0 && c.ended_at && now.getTime() - new Date(c.ended_at).getTime() < 15 * 60_000) continue;
    const amount = Number(c.total_minor ?? 0);
    const kwh = Number(c.wh) / 1000;
    if (amount <= 0) { await S(() => query(`UPDATE hotel_charge SET status = 'void', kwh = $2, amount_minor = 0, updated_at = now() WHERE id = $1`, [c.id, kwh])); continue; }
    if (c.posting === 'statement') {
      await S(() => query(`UPDATE hotel_charge SET status = 'on_statement', kwh = $2, amount_minor = $3, updated_at = now() WHERE id = $1`, [c.id, kwh, amount]));
      onStatement++;
      continue;
    }
    const body = JSON.stringify({ type: 'folio_charge', reference: `EV-${c.id}`, reservationRef: c.reservation_ref ?? null, room: c.room, guestName: c.guest_name,
      description: `EV charging, ${kwh.toFixed(2)} kWh`, amountMinor: amount, currency: c.currency, kwh, sessionId: c.session_id, endedAt: c.ended_at ? new Date(c.ended_at).toISOString() : null });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (c.pms_secret_sealed) {
      try {
        const ts = Math.floor(Date.now() / 1000);
        headers['x-plugsure-signature'] = `t=${ts},v1=${createHmac('sha256', unseal(c.pms_secret_sealed, AAD)).update(`${ts}.${body}`).digest('hex')}`;
      } catch { /* unsigned */ }
    }
    let err: string | null = null;
    try {
      const r = await guardedFetch(c.pms_url, { method: 'POST', headers, body, timeoutMs: 10_000, maxBytes: 16 * 1024 });
      if (r.status >= 200 && r.status < 300) {
        await S(() => query(`UPDATE hotel_charge SET status = 'posted', kwh = $2, amount_minor = $3, posted_at = now(), attempts = attempts + 1, last_error = NULL, updated_at = now() WHERE id = $1`, [c.id, kwh, amount]));
        posted++;
        continue;
      }
      err = `HTTP ${r.status}`;
    } catch (e) { err = (e as Error).message.slice(0, 200); }
    const n = Number(c.attempts) + 1;
    const failed = n >= MAX_ATTEMPTS;
    await S(() => query(`UPDATE hotel_charge SET status = $2, attempts = $3, last_error = $4, kwh = $5, amount_minor = $6, updated_at = now() WHERE id = $1`,
      [c.id, failed ? 'post_failed' : 'charging', n, err, kwh, amount]));
    if (failed) {
      await S(() => persistAlert({ orgId: c.org_id, kind: HOTEL_ALERT, severity: 'warning', targetType: 'hotel_charge', targetId: String(c.id),
        message: `${c.hotel}: room ${c.room}'s charging (${amount}) could not be posted to the folio (${err}).` } as any)).catch(() => null);
      logger.warn({ charge: c.id, err }, 'hotel folio post failed for good');
    }
  }
  return { linked, posted, statement: onStatement };
}
