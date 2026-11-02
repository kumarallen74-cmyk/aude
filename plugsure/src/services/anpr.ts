import { createHash, randomBytes } from 'node:crypto';
import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { logger } from '../logger.js';
import * as commands from '../ocpp/commands.js';
import { persistAlert } from './alerts.js';
import { guardedFetch, refuseOutboundUrl } from './net-guard.js';
import { seal, unseal } from './secrets.js';

/**
 * Number-plate cameras and parking (v1.46.0), Assets & energy → Plates & parking.
 *
 *   cameras    each camera (its site, entry, exit or both) posts what it reads to …/anpr/events/<key>: {plate, direction?,
 *              confidence?, at?} or a list. Reads under 60 % confidence are kept but not acted on.
 *   matching   a plate is a known fleet vehicle (Depot charging) or a resident's or staff member's (Private charging);
 *              anything else is a visitor.
 *   visits     entry opens a visit, exit closes it: how long the car stayed, the energy its card charged at the site
 *              meanwhile, and the overstay — the time after its last session ended (or the whole stay, if it never
 *              charged) beyond the site's grace — × the site's parking fee per hour. Residents and staff of a private
 *              group at the site pay no parking fee. A visit past the site's longest stay raises parking.overstay once.
 *   autostart  at a site with plate start on, a known vehicle or member whose card is on file, arrived in the last 15
 *              minutes, starts charging when it plugs in (the connector reports Preparing): PlugSure sends a remote start
 *              with its card. Only when one such car is waiting, so the wrong card is never used.
 *   gate       a camera can open the car park's barrier: for known plates, for everyone, or never; PlugSure posts
 *              {plate, direction, camera} to the gate's https address (through the outbound guard).
 */

export class AnprError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const OVERSTAY_ALERT = 'parking.overstay';
const S = <T>(fn: () => T) => outsideRequestScope(fn);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const normPlate = (p: unknown) => String(p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15);
const MIN_CONFIDENCE = 60;

// ------------------------------------------------------------------ the fee

/**
 * The overstay (minutes) and the fee for a visit. Charging spans are [start, end]; without any, the whole stay counts
 * after the grace. Members are exempt from the fee (not from the overstay).
 */
export function visitFee(enteredAt: Date, exitedAt: Date, charging: Array<{ start: Date; end: Date }>, graceMin: number, feePerHourMinor: number, exempt = false) {
  const stayMin = Math.max(0, Math.round((exitedAt.getTime() - enteredAt.getTime()) / 60_000));
  const chargingMin = charging.reduce((a, c) => a + Math.max(0, Math.round((c.end.getTime() - c.start.getTime()) / 60_000)), 0);
  const lastEnd = charging.length ? Math.max(...charging.map((c) => c.end.getTime())) : null;
  const idle = lastEnd == null ? stayMin : Math.max(0, Math.round((exitedAt.getTime() - lastEnd) / 60_000));
  const overstay = Math.max(0, idle - Math.max(0, graceMin));
  const fee = exempt || !feePerHourMinor ? 0 : Math.ceil(overstay / 60) * feePerHourMinor;
  return { stayMinutes: stayMin, chargingMinutes: chargingMin, overstayMinutes: overstay, feeMinor: fee };
}

// ------------------------------------------------------------------ cameras and site settings

const camOf = (c: any) => ({
  id: String(c.id), siteId: c.site_id, site: c.site_name ?? null, name: c.name, direction: c.direction, keyPrefix: c.key_prefix ?? null,
  gatePolicy: c.gate_policy, gateUrl: c.gate_url ?? null, gateHasAuth: !!c.gate_auth_sealed, enabled: c.enabled, lastSeenAt: c.last_seen_at ? new Date(c.last_seen_at).toISOString() : null,
});

export async function cameras(orgId: string) {
  return (await S(() => many<any>(`SELECT c.*, s.name AS site_name FROM anpr_camera c JOIN site s ON s.id = c.site_id WHERE c.org_id = $1 AND c.archived_at IS NULL ORDER BY s.name, c.name`, [orgId]))).map(camOf);
}

export async function saveCamera(orgId: string, id: string | null, b: Record<string, unknown>) {
  const cur = id ? await S(() => one<any>(`SELECT * FROM anpr_camera WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [Number(id) || 0, orgId])) : null;
  if (id && !cur) throw new AnprError(404, 'No such camera.');
  if (cur && b.archive === true) {
    await S(() => query(`UPDATE anpr_camera SET archived_at = now(), enabled = false, key_hash = NULL WHERE id = $1`, [cur.id]));
    return { id: String(cur.id), archived: true };
  }
  const v = (k: string, col: string) => (b[k] !== undefined ? b[k] : cur?.[col]);
  const name = String(v('name', 'name') ?? '').trim().slice(0, 80);
  if (!name) throw new AnprError(422, 'name is required.');
  const siteId = String(v('siteId', 'site_id') ?? '');
  if (!UUID_RE.test(siteId) || !(await S(() => one(`SELECT 1 FROM site WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [siteId, orgId])))) throw new AnprError(422, 'No such site.');
  const direction = String(v('direction', 'direction') ?? 'both');
  if (!['entry', 'exit', 'both'].includes(direction)) throw new AnprError(422, 'direction is entry, exit or both.');
  const policy = String(v('gatePolicy', 'gate_policy') ?? 'none');
  if (!['none', 'known', 'everyone'].includes(policy)) throw new AnprError(422, 'gatePolicy is none, known or everyone.');
  let gateUrl: string | null = v('gateUrl', 'gate_url') ? String(v('gateUrl', 'gate_url')).trim() : null;
  if (policy !== 'none') {
    if (!gateUrl) throw new AnprError(422, 'gateUrl is the barrier controller\'s address.');
    let u: URL;
    try { u = new URL(gateUrl); } catch { throw new AnprError(422, 'gateUrl is not a URL.'); }
    const why = refuseOutboundUrl(u);
    if (why) throw new AnprError(422, `gateUrl: ${why}.`);
    gateUrl = u.toString();
  }
  const auth = b.gateAuthorization !== undefined ? (b.gateAuthorization ? seal(String(b.gateAuthorization).slice(0, 2000), 'anpr-gate') : null) : cur?.gate_auth_sealed ?? null;
  const enabled = b.enabled === undefined ? cur?.enabled ?? true : b.enabled === true;
  const vals = [orgId, siteId, name, direction, policy, gateUrl, auth, enabled];
  const r = cur
    ? await S(() => one<any>(`UPDATE anpr_camera SET site_id = $2, name = $3, direction = $4, gate_policy = $5, gate_url = $6, gate_auth_sealed = $7, enabled = $8 WHERE id = $9 AND org_id = $1 RETURNING *`, [...vals, cur.id]))
    : await S(() => one<any>(`INSERT INTO anpr_camera (org_id, site_id, name, direction, gate_policy, gate_url, gate_auth_sealed, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, vals));
  let key: string | null = null;
  if (!r.key_hash || b.rotateKey === true) {
    key = `cam_${randomBytes(24).toString('base64url')}`;
    await S(() => query(`UPDATE anpr_camera SET key_hash = $2, key_prefix = $3 WHERE id = $1`, [r.id, sha(key!), key!.slice(0, 8)]));
    r.key_prefix = key.slice(0, 8);
  }
  return { ...camOf(r), ...(key ? { key } : {}) };
}

export async function siteParking(orgId: string, siteId: string, b: Record<string, unknown>) {
  if (!UUID_RE.test(siteId)) throw new AnprError(404, 'No such site.');
  const n = (k: string, lo: number, hi: number) => {
    if (b[k] == null || b[k] === '') return null;
    const x = Number(b[k]);
    if (!Number.isInteger(x) || x < lo || x > hi) throw new AnprError(422, `${k} is a whole number from ${lo} to ${hi}.`);
    return x;
  };
  const grace = n('graceMinutes', 0, 1440), maxMin = n('maxMinutes', 10, 10080);
  const fee = b.feePerHourMinor == null || b.feePerHourMinor === '' ? null : Number(b.feePerHourMinor);
  if (fee != null && !(Number.isSafeInteger(fee) && fee >= 0)) throw new AnprError(422, 'feePerHourMinor is a whole amount.');
  const r = await S(() => one<any>(
    `UPDATE site SET parking_grace_minutes = $3, parking_fee_per_hour_minor = $4, parking_max_minutes = $5, plate_autostart = $6 WHERE id = $1 AND org_id = $2
     RETURNING id, parking_grace_minutes, parking_fee_per_hour_minor, parking_max_minutes, plate_autostart`, [siteId, orgId, grace, fee, maxMin, b.plateAutostart === true]));
  if (!r) throw new AnprError(404, 'No such site.');
  return { siteId: r.id, graceMinutes: r.parking_grace_minutes, feePerHourMinor: r.parking_fee_per_hour_minor == null ? null : Number(r.parking_fee_per_hour_minor), maxMinutes: r.parking_max_minutes, plateAutostart: r.plate_autostart };
}

// ------------------------------------------------------------------ matching and the gate

/** A known plate: a fleet vehicle of the operator, or a member of a private group at this site (members first). */
export async function matchPlate(orgId: string, siteId: string, plate: string) {
  const m = await S(() => one<any>(
    `SELECT m.id, m.token_id FROM private_member m JOIN private_unit u ON u.id = m.unit_id JOIN private_group g ON g.id = u.group_id
      WHERE g.org_id = $1 AND g.site_id = $2 AND m.plate = $3 AND m.archived_at IS NULL AND u.archived_at IS NULL AND g.archived_at IS NULL LIMIT 1`, [orgId, siteId, plate]));
  if (m) return { kind: 'member' as const, memberId: String(m.id), vehicleId: null, tokenId: m.token_id ?? null };
  const v = await S(() => one<any>(
    `SELECT id, token_id FROM fleet_vehicle WHERE org_id = $1 AND archived_at IS NULL AND regexp_replace(upper(coalesce(plate, '')), '[^A-Z0-9]', '', 'g') = $2 LIMIT 1`, [orgId, plate]));
  if (v) return { kind: 'vehicle' as const, memberId: null, vehicleId: String(v.id), tokenId: v.token_id ?? null };
  return { kind: 'none' as const, memberId: null, vehicleId: null, tokenId: null };
}

async function openGate(cam: any, plate: string, direction: string): Promise<{ opened: boolean; error: string | null }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cam.gate_auth_sealed) { try { headers.authorization = unseal(cam.gate_auth_sealed, 'anpr-gate'); } catch { /* sent without */ } }
  try {
    const r = await guardedFetch(cam.gate_url, { method: 'POST', headers, body: JSON.stringify({ action: 'open', plate, direction, camera: cam.name }), timeoutMs: 5000, maxBytes: 16 * 1024 });
    return r.status >= 200 && r.status < 300 ? { opened: true, error: null } : { opened: false, error: `HTTP ${r.status}` };
  } catch (e) {
    return { opened: false, error: (e as Error).message.slice(0, 200) };
  }
}

// ------------------------------------------------------------------ events

export async function ingest(key: string, payload: unknown, now = new Date()) {
  if (!/^cam_[A-Za-z0-9_-]{20,64}$/.test(key)) throw new AnprError(404, 'Unknown key.');
  const cam = await S(() => one<any>(`SELECT * FROM anpr_camera WHERE key_hash = $1 AND archived_at IS NULL`, [sha(key)]));
  if (!cam) throw new AnprError(404, 'Unknown key.');
  if (!cam.enabled) throw new AnprError(409, 'The camera is switched off.');
  await S(() => query(`UPDATE anpr_camera SET last_seen_at = now() WHERE id = $1`, [cam.id]));
  const items = (Array.isArray(payload) ? payload : [payload]).slice(0, 50);
  const out = [];
  for (const it of items) out.push(await one1(cam, it as any, now));
  return { events: out };
}

async function one1(cam: any, it: Record<string, unknown>, now: Date) {
  const plate = normPlate(it?.plate);
  if (plate.length < 3) return { plate: null, ignored: 'no plate' };
  const conf = it.confidence == null ? null : Number(it.confidence);
  const t = it.at ? new Date(String(it.at)) : now;
  const at = Number.isFinite(t.getTime()) && t.getTime() <= now.getTime() + 5 * 60_000 ? t : now;
  const open = await S(() => one<any>(`SELECT * FROM parking_visit WHERE site_id = $1 AND plate = $2 AND status = 'open' ORDER BY entered_at DESC LIMIT 1`, [cam.site_id, plate]));
  let direction = String(it.direction ?? '');
  if (!['entry', 'exit'].includes(direction)) direction = cam.direction !== 'both' ? cam.direction : open ? 'exit' : 'entry';
  const match = await matchPlate(cam.org_id, cam.site_id, plate);
  const low = conf != null && conf < MIN_CONFIDENCE;
  let visitId: string | null = open ? String(open.id) : null;
  let fee = null;
  if (!low) {
    if (direction === 'entry' && !open) {
      const site = await S(() => one<any>(`SELECT co.currency FROM site s JOIN country co ON co.code = s.country_code WHERE s.id = $1`, [cam.site_id]));
      const v = await S(() => one<{ id: string }>(
        `INSERT INTO parking_visit (org_id, site_id, plate, entered_at, vehicle_id, member_id, token_id, currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [cam.org_id, cam.site_id, plate, at, match.vehicleId, match.memberId, match.tokenId, site?.currency ?? null]));
      visitId = v!.id;
    } else if (direction === 'exit' && open) {
      fee = await closeVisit(open, at);
    }
  }
  let gate: { opened: boolean; error: string | null } | null = null;
  if (!low && cam.gate_policy !== 'none' && cam.gate_url && (cam.gate_policy === 'everyone' || match.kind !== 'none')) gate = await openGate(cam, plate, direction);
  await S(() => query(
    `INSERT INTO plate_event (org_id, site_id, camera_id, plate, direction, confidence, seen_at, matched, visit_id, gate_opened, gate_error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [cam.org_id, cam.site_id, cam.id, plate, direction, conf, at, match.kind, visitId, gate?.opened ?? null, gate?.error ?? null]));
  return { plate, direction, matched: match.kind, visitId, ignored: low ? 'low confidence' : null, ...(fee ? { feeMinor: fee.feeMinor, overstayMinutes: fee.overstayMinutes } : {}), gate };
}

/** Close a visit: the charging during it, the overstay and the fee. */
async function closeVisit(v: any, exitedAt: Date) {
  const site = await S(() => one<any>(`SELECT parking_grace_minutes, parking_fee_per_hour_minor FROM site WHERE id = $1`, [v.site_id]));
  const sessions = v.token_id || v.autostart_session_id
    ? await S(() => many<any>(
      `SELECT started_at, COALESCE(ended_at, $4) AS ended_at, COALESCE(energy_wh, 0) AS wh FROM charging_session
        WHERE site_id = $1 AND (token_id = $2 OR id = $3) AND started_at < $4 AND COALESCE(ended_at, $4) > $5`,
      [v.site_id, v.token_id, v.autostart_session_id, exitedAt, v.entered_at]))
    : [];
  const f = visitFee(new Date(v.entered_at), exitedAt, sessions.map((s) => ({ start: new Date(s.started_at), end: new Date(s.ended_at) })),
    Number(site?.parking_grace_minutes ?? 0), Number(site?.parking_fee_per_hour_minor ?? 0), !!v.member_id);
  await S(() => query(
    `UPDATE parking_visit SET exited_at = $2, charged_wh = $3, charging_minutes = $4, overstay_minutes = $5, fee_minor = $6, status = 'closed' WHERE id = $1 AND status = 'open'`,
    [v.id, exitedAt, sessions.reduce((a, s) => a + Number(s.wh), 0), f.chargingMinutes, f.overstayMinutes, f.feeMinor]));
  return f;
}

/** paid | waived (a closed visit with a fee). */
export async function settleVisit(orgId: string, id: string, action: unknown) {
  const a = String(action ?? '');
  if (!['paid', 'waived'].includes(a)) throw new AnprError(422, 'action is paid or waived.');
  const r = await S(() => one<any>(`UPDATE parking_visit SET status = $3 WHERE id = $1 AND org_id = $2 AND status = 'closed' AND fee_minor > 0 RETURNING id, status`, [Number(id) || 0, orgId, a]));
  if (!r) throw new AnprError(409, 'Only a closed visit with a fee can be settled.');
  return { id: String(r.id), status: r.status };
}

export async function visits(orgId: string, q: Record<string, unknown> = {}) {
  const st = String(q.status ?? '');
  const rows = await S(() => many<any>(
    `SELECT v.*, s.name AS site_name, fv.name AS vehicle, m.name AS member FROM parking_visit v JOIN site s ON s.id = v.site_id
       LEFT JOIN fleet_vehicle fv ON fv.id = v.vehicle_id LEFT JOIN private_member m ON m.id = v.member_id
      WHERE v.org_id = $1 AND ($2 = '' OR v.status = $2) AND ($3::uuid IS NULL OR v.site_id = $3) AND ($4 = '' OR v.plate LIKE $4 || '%') ORDER BY v.entered_at DESC LIMIT 300`,
    [orgId, ['open', 'closed', 'paid', 'waived'].includes(st) ? st : '', UUID_RE.test(String(q.siteId ?? '')) ? q.siteId : null, normPlate(String(q.plate ?? ''))]));
  return rows.map((v) => ({
    id: String(v.id), site: v.site_name, plate: v.plate, who: v.vehicle ? `Fleet: ${v.vehicle}` : v.member ? `Resident/staff: ${v.member}` : null,
    enteredAt: new Date(v.entered_at).toISOString(), exitedAt: v.exited_at ? new Date(v.exited_at).toISOString() : null,
    chargedKwh: Number(v.charged_wh) / 1000, chargingMinutes: v.charging_minutes, overstayMinutes: v.overstay_minutes, feeMinor: Number(v.fee_minor), currency: v.currency, status: v.status,
    autostarted: !!v.autostart_session_id,
  }));
}

export async function events(orgId: string, limit = 100) {
  const rows = await S(() => many<any>(
    `SELECT e.*, c.name AS camera, s.name AS site_name FROM plate_event e JOIN anpr_camera c ON c.id = e.camera_id JOIN site s ON s.id = e.site_id WHERE e.org_id = $1 ORDER BY e.seen_at DESC LIMIT $2`,
    [orgId, Math.min(500, limit)]));
  return rows.map((e) => ({ id: String(e.id), site: e.site_name, camera: e.camera, plate: e.plate, direction: e.direction, confidence: e.confidence == null ? null : Number(e.confidence),
    seenAt: new Date(e.seen_at).toISOString(), matched: e.matched, gateOpened: e.gate_opened, gateError: e.gate_error ?? null }));
}

// ------------------------------------------------------------------ autostart and overstay

const tried = new Map<string, number>();

/**
 * A connector reports Preparing (plugged in). At a site with plate start on, exactly one known car that arrived in the
 * last 15 minutes with a card, not charging and not started yet: remote start with its card.
 */
export async function onConnectorStatus(e: { orgId: string; ocppIdentity: string; connectorId: number; status: string }) {
  if (e.status !== 'Preparing') return null;
  const cp = await S(() => one<any>(`SELECT cp.id, cp.site_id, s.plate_autostart FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE cp.ocpp_identity = $1`, [e.ocppIdentity]));
  if (!cp?.plate_autostart) return null;
  const cands = await S(() => many<any>(
    `SELECT v.id, v.token_id, t.uid FROM parking_visit v JOIN token t ON t.id = v.token_id
      WHERE v.site_id = $1 AND v.status = 'open' AND v.autostart_session_id IS NULL AND v.entered_at > now() - interval '15 minutes' AND t.status = 'Accepted'
        AND NOT EXISTS (SELECT 1 FROM charging_session cs WHERE cs.token_id = v.token_id AND cs.state = 'active')`, [cp.site_id]));
  const fresh = cands.filter((c) => (tried.get(String(c.id)) ?? 0) < Date.now() - 10 * 60_000);
  if (fresh.length !== 1) return { started: false, reason: fresh.length ? 'more than one car waiting' : 'no car waiting' };
  const c = fresh[0]!;
  tried.set(String(c.id), Date.now());
  try {
    const r = await commands.remoteStartTransaction(e.ocppIdentity, e.connectorId, c.uid, { type: 'system', orgId: e.orgId });
    logger.info({ visit: c.id, cp: e.ocppIdentity, status: r?.status }, 'plate autostart');
    if (r?.status === 'Accepted') {
      // The session that starts is linked to the visit when it appears (sweep below).
      await S(() => query(`UPDATE parking_visit SET autostart_session_id = (SELECT id FROM charging_session WHERE token_id = $2 AND state = 'active' ORDER BY started_at DESC LIMIT 1) WHERE id = $1`, [c.id, c.token_id])).catch(() => null);
    }
    return { started: r?.status === 'Accepted', visitId: String(c.id) };
  } catch (err) {
    logger.warn({ visit: c.id, err: (err as Error).message }, 'plate autostart failed');
    return { started: false, reason: (err as Error).message };
  }
}

/** Worker: visits past their site's longest stay raise parking.overstay once; autostarted visits get their session. */
export async function sweep(): Promise<number> {
  await S(() => query(
    `UPDATE parking_visit v SET autostart_session_id = cs.id FROM charging_session cs
      WHERE v.status = 'open' AND v.autostart_session_id IS NULL AND v.token_id IS NOT NULL AND cs.token_id = v.token_id AND cs.site_id = v.site_id AND cs.started_at >= v.entered_at
        AND (SELECT plate_autostart FROM site WHERE id = v.site_id)`));
  const rows = await S(() => many<any>(
    `UPDATE parking_visit v SET alerted_at = now() FROM site s
      WHERE s.id = v.site_id AND v.status = 'open' AND v.alerted_at IS NULL AND s.parking_max_minutes IS NOT NULL AND v.entered_at < now() - make_interval(mins => s.parking_max_minutes)
      RETURNING v.id, v.org_id, v.plate, s.name AS site, s.parking_max_minutes`));
  for (const r of rows) {
    await S(() => persistAlert({ orgId: r.org_id, kind: OVERSTAY_ALERT, severity: 'warning', targetType: 'parking_visit', targetId: String(r.id),
      message: `${r.plate} has been parked at ${r.site} for more than ${r.parking_max_minutes} minutes.` } as any)).catch(() => null);
  }
  return rows.length;
}
