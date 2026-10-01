import { one, many, query } from '../db/pool.js';
import { logger } from '../logger.js';
import * as registry from '../ocpp/registry.js';
import { bus } from '../services/events.js';
import { connectorMaySellEnergy } from '../services/compliance.js';
import { fleetTokenProblem } from './charge.js';
import { holdConnector, currentReservation, releaseReservation } from './reservations.js';
import { notifyQueue } from './notify.js';
import { CONNECTOR_LABEL } from './stations.js';
import type { DriverPrincipal } from './identity.js';

/**
 * A queue (waitlist) at a busy site.
 *
 * Policy, per site (Sites → Driver queue), off until an operator switches it on:
 * - A signed-in driver (phone or fleet card) joins when every connector they can
 *   use is taken. They may say AC or DC, and a plug type; otherwise any.
 * - First come, first served: when a connector frees up, the earliest waiting
 *   driver who can use it gets it. A later driver with different needs may be
 *   served first only with a connector the earlier one cannot use.
 * - The connector is held on the charger (ReserveNow) for `queue_offer_minutes`
 *   (2–15, default 5). The driver starts as with a reservation; declining gives
 *   the place up. An offer not taken in time is MISSED: the driver leaves the
 *   queue and the connector goes to the next one. One chance, so a no-show does
 *   not hold everyone else up twice.
 * - Walk-ups cannot take a freed connector ahead of the queue: the charger holds
 *   it, and the app refuses to start or reserve on it while drivers are waiting.
 * - Nobody waits more than `queue_max_wait_minutes` (15–720, default 120), and a
 *   queue holds at most `queue_max_length` drivers (1–200, default 20).
 * - An operator can remove a driver; switching the queue off ends the waiting.
 *
 * Offers are made in the process that owns the charger sockets (the gateway): on
 * a connector becoming Available, and every 15 s by the reservations worker.
 */

export type Current = 'AC' | 'DC';
export interface Want { current: Current | null; type: string | null }
export interface FreeConnector { id: string; current: Current; type: string }

/** Can a driver who wants `w` use this connector? */
export const fits = (w: Want, c: { current: Current; type: string }) =>
  (!w.current || w.current === c.current) && (!w.type || w.type === c.type);

/** Could these two drivers want the same connector? */
export const overlaps = (a: Want, b: Want) =>
  (!a.current || !b.current || a.current === b.current) && (!a.type || !b.type || a.type === b.type);

/**
 * Who gets which free connector: waiting drivers in queue order, each taking the
 * first free connector they can use that is not already given out.
 */
export function assign<E extends Want & { id: string }, C extends FreeConnector>(entries: E[], free: C[]): Array<{ entry: E; connector: C }> {
  const taken = new Set<string>();
  const out: Array<{ entry: E; connector: C }> = [];
  for (const e of entries) {
    const c = free.find((x) => !taken.has(x.id) && fits(e, x));
    if (!c) continue;
    taken.add(c.id);
    out.push({ entry: e, connector: c });
  }
  return out;
}

/** 1-based place in the queue, counting only drivers ahead who could take a connector this one could. */
export function positionOf(entries: Array<Want & { id: string }>, id: string): number | null {
  const i = entries.findIndex((e) => e.id === id);
  if (i < 0) return null;
  const mine = entries[i]!;
  return 1 + entries.slice(0, i).filter((e) => overlaps(e, mine)).length;
}

/** The connector type a connector really has (unset: the usual plug for its current). */
export const connectorTypeOf = (type: string | null, current: string) => type ?? (current === 'DC' ? 'cCCS2' : 'sType2');

// ─────────────────────────────────────────────────────────── database

interface SiteRow { id: string; org_id: string; name: string; queue_enabled: boolean; queue_offer_minutes: number; queue_max_length: number; queue_max_wait_minutes: number; archived_at: Date | null }
interface ConnRow { connector_uuid: string; connector_no: number; connector_type: string | null; current_type: string; status: string; tera_status: string; in_maintenance: boolean; suspended: boolean; charge_point_id: string; ocpp_identity: string; org_id: string; held: boolean }
interface EntryRow { id: string; org_id: string; site_id: string; device_id: string; app_driver_id: string | null; fleet_token_id: string | null; fleet_uid: string | null; current_type: Current | null; connector_type: string | null; state: string; joined_at: Date; offered_at: Date | null; ended_at: Date | null; end_reason: string | null }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE = `('waiting','offered')`;

const siteRow = (siteId: string) => one<SiteRow>(
  `SELECT id, org_id, name, queue_enabled, queue_offer_minutes, queue_max_length, queue_max_wait_minutes, archived_at FROM site WHERE id = $1`, [siteId]);

async function siteConnectors(siteId: string): Promise<ConnRow[]> {
  return many<ConnRow>(
    `SELECT c.id AS connector_uuid, e.evse_id AS connector_no, c.connector_type, c.current_type, c.status, c.tera_status,
            (c.maintenance_reason IS NOT NULL) AS in_maintenance, (cp.status = 'suspended') AS suspended, cp.id AS charge_point_id, cp.ocpp_identity, s.org_id,
            EXISTS (SELECT 1 FROM driver_reservation r WHERE r.connector_uuid = c.id AND r.state IN ('requested','active') AND r.expires_at > now()) AS held
       FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id JOIN site s ON s.id = cp.site_id
      WHERE s.id = $1 AND cp.status NOT IN ('pending_adoption','decommissioned') AND s.archived_at IS NULL
      ORDER BY cp.ocpp_identity, e.evse_id`,
    [siteId],
  );
}

const usable = (c: ConnRow) => registry.isOnline(c.ocpp_identity) && connectorMaySellEnergy(c.tera_status as any).allowed && !c.in_maintenance && !c.suspended;
const isFree = (c: ConnRow) => usable(c) && c.status === 'Available' && !c.held;
const asFree = (c: ConnRow): FreeConnector => ({ id: c.connector_uuid, current: c.current_type === 'DC' ? 'DC' : 'AC', type: connectorTypeOf(c.connector_type, c.current_type) });
const wantOf = (e: { current_type: Current | null; connector_type: string | null; id: string }) => ({ id: e.id, current: e.current_type, type: e.connector_type });

const liveEntries = (siteId: string) => many<EntryRow>(
  `SELECT q.*, t.uid AS fleet_uid FROM driver_queue_entry q LEFT JOIN token t ON t.id = q.fleet_token_id
    WHERE q.site_id = $1 AND q.state IN ${LIVE} ORDER BY q.joined_at, q.id`, [siteId]);

// ─────────────────────────────────────────────────────────── the driver

export interface EntryView {
  id: string; siteId: string; siteName: string; state: string; joinedAt: string;
  position: number | null; waiting: number;
  want: { current: Current | null; type: string | null; typeLabel: string | null };
  offerMinutes: number; leaveBy: string;
  offer: { reservationId: string; connectorId: string; chargerName: string; connectorNo: number; expiresAt: string; minutesLeft: number } | null;
  endReason: string | null;
}

async function entryView(e: EntryRow, site?: SiteRow | null): Promise<EntryView> {
  const s = site ?? (await siteRow(e.site_id))!;
  const live = e.state === 'waiting' || e.state === 'offered' ? await liveEntries(e.site_id) : [];
  const waitingOnly = live.filter((x) => x.state === 'waiting');
  const offer = e.state === 'offered'
    ? await one<any>(
        `SELECT r.id, r.connector_uuid, r.connector_no, r.expires_at, COALESCE(cp.display_name, cp.ocpp_identity) AS charger_name
           FROM driver_reservation r JOIN charge_point cp ON cp.id = r.charge_point_id
          WHERE r.queue_entry_id = $1 AND r.state = 'active' ORDER BY r.created_at DESC LIMIT 1`, [e.id])
    : null;
  return {
    id: e.id, siteId: e.site_id, siteName: s.name, state: e.state, joinedAt: new Date(e.joined_at).toISOString(),
    position: e.state === 'waiting' ? positionOf(waitingOnly.map(wantOf), e.id) : null,
    waiting: waitingOnly.length,
    want: { current: e.current_type, type: e.connector_type, typeLabel: e.connector_type ? CONNECTOR_LABEL[e.connector_type] ?? e.connector_type : null },
    offerMinutes: s.queue_offer_minutes,
    leaveBy: new Date(new Date(e.joined_at).getTime() + s.queue_max_wait_minutes * 60_000).toISOString(),
    offer: offer ? {
      reservationId: offer.id, connectorId: offer.connector_uuid, chargerName: offer.charger_name, connectorNo: offer.connector_no,
      expiresAt: new Date(offer.expires_at).toISOString(), minutesLeft: Math.max(0, Math.ceil((new Date(offer.expires_at).getTime() - Date.now()) / 60_000)),
    } : null,
    endReason: e.end_reason,
  };
}

/** The driver's live place in a queue, and a queue place that ended in the last 30 minutes (to say why). */
export async function myQueue(p: DriverPrincipal): Promise<{ entry: EntryView | null; ended: EntryView | null }> {
  const live = await one<EntryRow>(`SELECT q.*, NULL AS fleet_uid FROM driver_queue_entry q WHERE q.device_id = $1 AND q.state IN ${LIVE}`, [p.deviceId]);
  if (live) return { entry: await entryView(live), ended: null };
  const ended = await one<EntryRow>(
    `SELECT q.*, NULL AS fleet_uid FROM driver_queue_entry q
      WHERE q.device_id = $1 AND q.state IN ('missed','expired','removed') AND q.ended_at > now() - interval '30 minutes'
      ORDER BY q.ended_at DESC LIMIT 1`, [p.deviceId]);
  return { entry: null, ended: ended ? await entryView(ended) : null };
}

export interface SiteQueueView {
  enabled: boolean; offerMinutes: number; maxLength: number; maxWaitMinutes: number;
  waiting: number; full: boolean; freeNow: number;
  types: Array<{ current: Current; type: string; typeLabel: string }>;
  mine: EntryView | null; canJoin: boolean; reason: string | null;
}

/** A site's queue as a driver sees it on the station page. */
export async function siteQueue(siteId: string, p: DriverPrincipal | null): Promise<SiteQueueView | null> {
  if (!UUID_RE.test(siteId)) return null;
  const s = await siteRow(siteId);
  if (!s || s.archived_at) return null;
  const [conns, live] = await Promise.all([siteConnectors(siteId), liveEntries(siteId)]);
  const types = new Map<string, { current: Current; type: string; typeLabel: string }>();
  for (const c of conns.filter(usable)) {
    const f = asFree(c);
    types.set(`${f.current}|${f.type}`, { current: f.current, type: f.type, typeLabel: CONNECTOR_LABEL[f.type] ?? f.type });
  }
  const mineRow = p ? await one<EntryRow>(`SELECT q.*, NULL AS fleet_uid FROM driver_queue_entry q WHERE q.device_id = $1 AND q.state IN ${LIVE}`, [p.deviceId]) : null;
  const mine = mineRow?.site_id === siteId ? await entryView(mineRow, s) : null;
  const waiting = live.filter((e) => e.state === 'waiting').length;
  const freeNow = conns.filter(isFree).length;
  const full = live.length >= s.queue_max_length;
  const reason = !s.queue_enabled ? 'Lokasi ini tidak memakai antrean.'
    : !p || !(p.account || p.fleet) ? 'Masuk dengan nomor HP atau kartu armada untuk ikut antrean.'
    : mineRow && mineRow.site_id !== siteId ? 'Anda sudah dalam antrean di lokasi lain.'
    : mine ? null
    : full ? 'Antrean sedang penuh.'
    : freeNow > 0 && waiting === 0 ? 'Ada konektor kosong. Langsung isi saja.'
    : !types.size ? 'Tidak ada konektor yang sedang beroperasi.'
    : null;
  return {
    enabled: s.queue_enabled, offerMinutes: s.queue_offer_minutes, maxLength: s.queue_max_length, maxWaitMinutes: s.queue_max_wait_minutes,
    waiting, full, freeNow, types: [...types.values()], mine, canJoin: s.queue_enabled && !mine && !reason, reason,
  };
}

/** Join a site's queue. */
export async function join(p: DriverPrincipal, siteId: string, w: { current?: unknown; type?: unknown }):
  Promise<{ ok: true; entry: EntryView } | { ok: false; error: string; connectorId?: string }> {
  if (!p.account && !p.fleet) return { ok: false, error: 'Masuk dengan nomor HP atau kartu armada untuk ikut antrean.' };
  if (!UUID_RE.test(siteId)) return { ok: false, error: 'Lokasi tidak ditemukan.' };
  const s = await siteRow(siteId);
  if (!s || s.archived_at) return { ok: false, error: 'Lokasi tidak ditemukan.' };
  if (!s.queue_enabled) return { ok: false, error: 'Lokasi ini tidak memakai antrean.' };
  if (p.fleet && p.fleet.orgId !== s.org_id) return { ok: false, error: 'Charger ini bukan milik armada Anda.' };
  if (p.fleet) {
    const problem = await fleetTokenProblem(p.fleet.tokenId);
    if (problem) return { ok: false, error: problem };
  }
  const current = w.current == null || w.current === '' ? null : String(w.current).toUpperCase();
  if (current !== null && current !== 'AC' && current !== 'DC') return { ok: false, error: 'Pilih AC atau DC.' };
  const type = w.type == null || w.type === '' ? null : String(w.type).slice(0, 20);
  const want: Want = { current: current as Current | null, type };

  // Already queueing says so, whatever else is true (a full queue, a free connector).
  const mine = await one<{ site_id: string }>(`SELECT site_id FROM driver_queue_entry WHERE device_id = $1 AND state IN ${LIVE}`, [p.deviceId]);
  if (mine) return { ok: false, error: mine.site_id === siteId ? 'Anda sudah dalam antrean.' : 'Anda sudah dalam antrean di lokasi lain.' };
  if ((await currentReservation(p)) || (await (await import('./roaming.js')).hasRoamingReservation(p.deviceId))) {
    return { ok: false, error: 'Anda sudah punya reservasi aktif. Pakai atau batalkan dulu.' };
  }
  const conns = await siteConnectors(siteId);
  const suitable = conns.filter((c) => usable(c) && fits(want, asFree(c)));
  if (!suitable.length) return { ok: false, error: 'Tidak ada konektor yang cocok yang sedang beroperasi di lokasi ini.' };
  const live = await liveEntries(siteId);
  const freeForMe = suitable.find(isFree);
  if (freeForMe && !live.some((e) => e.state === 'waiting' && overlaps(wantOf(e), want))) {
    return { ok: false, error: 'Ada konektor kosong yang cocok. Langsung isi saja.', connectorId: freeForMe.connector_uuid };
  }
  if (live.length >= s.queue_max_length) return { ok: false, error: 'Antrean sedang penuh. Coba lagi nanti.' };

  let row: EntryRow | null;
  try {
    row = await one<EntryRow>(
      `INSERT INTO driver_queue_entry (org_id, site_id, device_id, app_driver_id, fleet_token_id, current_type, connector_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *, NULL AS fleet_uid`,
      [s.org_id, siteId, p.deviceId, p.appDriverId, p.fleet?.tokenId ?? null, want.current, want.type],
    );
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return { ok: false, error: 'Anda sudah dalam antrean.' };
    throw e;
  }
  logger.info({ entry: row!.id, site: siteId }, 'driver joined queue');
  return { ok: true, entry: await entryView(row!, s) };
}

/** Leave the queue — while waiting, or by declining an offer (the connector goes to the next driver). */
export async function leave(p: DriverPrincipal, id: string): Promise<{ ok: boolean; error?: string }> {
  if (!UUID_RE.test(id)) return { ok: false, error: 'Antrean tidak ditemukan.' };
  const e = await one<EntryRow>(`SELECT q.*, NULL AS fleet_uid FROM driver_queue_entry q WHERE q.id = $1 AND q.device_id = $2 AND q.state IN ${LIVE}`, [id, p.deviceId]);
  if (!e) return { ok: false, error: 'Antrean tidak ditemukan.' };
  await endEntry(e.id, 'left', 'left');
  await releaseOffer(e.id);
  return { ok: true };
}

/** A driver who is not the one a freed connector is being held for may not take it while the site's queue waits. */
export async function queueBlocks(connectorUuid: string, p: DriverPrincipal | null): Promise<string | null> {
  const c = await one<{ site_id: string; current_type: string; connector_type: string | null }>(
    `SELECT s.id AS site_id, c.current_type, c.connector_type
       FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id JOIN site s ON s.id = cp.site_id
      WHERE c.id = $1 AND s.queue_enabled`, [connectorUuid]);
  if (!c) return null;
  const waiting = await many<EntryRow>(`SELECT q.*, NULL AS fleet_uid FROM driver_queue_entry q WHERE q.site_id = $1 AND q.state = 'waiting'`, [c.site_id]);
  const conn = { current: (c.current_type === 'DC' ? 'DC' : 'AC') as Current, type: connectorTypeOf(c.connector_type, c.current_type) };
  const ahead = waiting.filter((e) => e.device_id !== p?.deviceId && fits(wantOf(e), conn));
  return ahead.length ? 'Ada pengemudi yang sedang antre untuk konektor ini. Gabung antrean di halaman stasiun.' : null;
}

// ─────────────────────────────────────────────────────────── offers (gateway)

async function endEntry(id: string, state: 'served' | 'left' | 'missed' | 'expired' | 'removed', reason: string, from: string[] = ['waiting', 'offered']) {
  return one<EntryRow>(
    `UPDATE driver_queue_entry SET state = $2, end_reason = $3, ended_at = now() WHERE id = $1 AND state = ANY($4::text[]) RETURNING *, NULL AS fleet_uid`,
    [id, state, reason, from]);
}

/** Give up the connector held for an entry, if any (the driver left, or was removed). */
async function releaseOffer(entryId: string) {
  const r = await one<{ id: string }>(`SELECT id FROM driver_reservation WHERE queue_entry_id = $1 AND state IN ('requested','active')`, [entryId]);
  if (r) await releaseReservation(r.id);
}

/**
 * An offer ended: the driver started (used), let it lapse (expired) or declined it
 * (cancelled). Called by reservations.ts.
 */
export async function offerEnded(r: { queue_entry_id: string; site_name?: string }, how: 'used' | 'expired' | 'cancelled') {
  if (how === 'used') {
    await endEntry(r.queue_entry_id, 'served', 'charging', ['offered']);
    return;
  }
  if (how === 'cancelled') {
    await endEntry(r.queue_entry_id, 'left', 'declined', ['offered']);
    return;
  }
  const e = await endEntry(r.queue_entry_id, 'missed', 'offer not taken in time', ['offered']);
  if (!e) return;
  const s = await siteRow(e.site_id);
  await notifyQueue(e.device_id, e.id, 'missed', s?.name ?? '', null);
  void allocate(e.site_id);
}

/**
 * The offered connector was withdrawn by the operator (charger suspended, v1.4.4): the
 * driver did nothing wrong, so they keep their place and wait for the next free connector.
 */
export async function requeueOffer(entryId: string): Promise<void> {
  const e = await one<{ site_id: string }>(
    `UPDATE driver_queue_entry SET state = 'waiting', offered_at = NULL WHERE id = $1 AND state = 'offered' RETURNING site_id`, [entryId]);
  if (e) void allocate(e.site_id);
}

const running = new Map<string, Promise<void>>();
const again = new Set<string>();

/** Offer the site's free connectors to the drivers waiting for them. One pass at a time per site. */
export function allocate(siteId: string): Promise<void> {
  const busy = running.get(siteId);
  if (busy) { again.add(siteId); return busy; }
  const p = (async () => {
    try {
      do { again.delete(siteId); await allocateOnce(siteId); } while (again.has(siteId));
    } catch (e) {
      logger.warn({ site: siteId, err: (e as Error).message }, 'queue allocation failed');
    } finally {
      running.delete(siteId);
    }
  })();
  running.set(siteId, p);
  return p;
}

async function allocateOnce(siteId: string) {
  const s = await siteRow(siteId);
  if (!s?.queue_enabled || s.archived_at) return;
  const waiting = (await liveEntries(siteId)).filter((e) => e.state === 'waiting');
  if (!waiting.length) return;
  const conns = await siteConnectors(siteId);
  const byId = new Map(conns.map((c) => [c.connector_uuid, c]));
  const pairs = assign(waiting.map((e) => ({ ...wantOf(e), row: e })), conns.filter(isFree).map(asFree));
  for (const { entry, connector } of pairs) {
    const e = entry.row;
    const c = byId.get(connector.id)!;
    // Claim the entry first: a concurrent pass (another gateway) skips it.
    const claimed = await one<{ id: string }>(
      `UPDATE driver_queue_entry SET state = 'offered', offered_at = now() WHERE id = $1 AND state = 'waiting' RETURNING id`, [e.id]);
    if (!claimed) continue;
    if (e.fleet_token_id) {
      const problem = await fleetTokenProblem(e.fleet_token_id);
      if (problem || !e.fleet_uid) {
        await endEntry(e.id, 'removed', `fleet card: ${problem ?? 'not found'}`);
        await notifyQueue(e.device_id, e.id, 'removed', s.name, null);
        again.add(siteId); // the connector is still free for the next driver
        continue;
      }
    }
    const held = await holdConnector(
      { orgId: s.org_id, deviceId: e.device_id, appDriverId: e.app_driver_id, fleet: e.fleet_token_id ? { tokenId: e.fleet_token_id, uid: e.fleet_uid! } : null },
      c, s.queue_offer_minutes, e.id,
    );
    if (!held.ok) {
      // Back in line where they were; the connector was taken, or the charger said no.
      await query(`UPDATE driver_queue_entry SET state = 'waiting', offered_at = NULL WHERE id = $1 AND state = 'offered'`, [e.id]);
      logger.info({ entry: e.id, connector: c.connector_uuid, status: held.status }, 'queue offer not held');
      continue;
    }
    await notifyQueue(e.device_id, e.id, 'offer', s.name, new Date(held.row.expires_at));
    logger.info({ entry: e.id, site: siteId, connector: c.connector_uuid }, 'queue offer made');
  }
}

/** Worker (every 15 s, gateway): end waits that are too long or at queues switched off, and offer free connectors. */
export async function sweepQueues(): Promise<void> {
  const closed = await many<EntryRow & { site_name: string }>(
    `UPDATE driver_queue_entry q SET state = 'removed', end_reason = 'queue closed', ended_at = now()
       FROM site s WHERE s.id = q.site_id AND q.state = 'waiting' AND (NOT s.queue_enabled OR s.archived_at IS NOT NULL)
     RETURNING q.*, s.name AS site_name`);
  for (const e of closed) await notifyQueue(e.device_id, e.id, 'closed', e.site_name, null);
  const tooLong = await many<EntryRow & { site_name: string }>(
    `UPDATE driver_queue_entry q SET state = 'expired', end_reason = 'waited too long', ended_at = now()
       FROM site s WHERE s.id = q.site_id AND q.state = 'waiting' AND q.joined_at < now() - make_interval(mins => s.queue_max_wait_minutes)
     RETURNING q.*, s.name AS site_name`);
  for (const e of tooLong) await notifyQueue(e.device_id, e.id, 'expired', e.site_name, null);
  const sites = await many<{ site_id: string }>(`SELECT DISTINCT site_id FROM driver_queue_entry WHERE state = 'waiting'`);
  for (const x of sites) await allocate(x.site_id);
}

/** A connector became free, or a charger came back: offer it to the queue. */
export function registerQueueListeners(): void {
  const forCharger = (identity: string) => void (async () => {
    const s = await one<{ id: string }>(
      `SELECT s.id FROM charge_point cp JOIN site s ON s.id = cp.site_id
        WHERE cp.ocpp_identity = $1 AND s.queue_enabled
          AND EXISTS (SELECT 1 FROM driver_queue_entry q WHERE q.site_id = s.id AND q.state = 'waiting')`, [identity]);
    if (s) await allocate(s.id);
  })().catch((err) => logger.warn({ err: (err as Error).message }, 'queue allocation on event failed'));
  bus.on('connector.status_changed', (e) => { if (e.status === 'Available') forCharger(e.ocppIdentity); });
  bus.on('charge_point.connected', (e) => forCharger(e.ocppIdentity));
}

// ─────────────────────────────────────────────────────────── the operator

const maskPhone = (ph: string | null) => (ph ? `${ph.slice(0, 6)}••••${ph.slice(-3)}` : null);

/** A site's queue in the console: who is waiting or has an offer, in order, and today's ended places. */
export async function operatorQueue(siteId: string) {
  const rows = await many<EntryRow & { phone: string | null; fleet_uid: string | null; offer_expires_at: Date | null; offer_connector: string | null }>(
    `SELECT q.*, d.phone, t.uid AS fleet_uid,
            r.expires_at AS offer_expires_at, CASE WHEN r.id IS NULL THEN NULL ELSE COALESCE(cp.display_name, cp.ocpp_identity) || ' #' || r.connector_no END AS offer_connector
       FROM driver_queue_entry q
       LEFT JOIN app_driver d ON d.id = q.app_driver_id
       LEFT JOIN token t ON t.id = q.fleet_token_id
       LEFT JOIN driver_reservation r ON r.queue_entry_id = q.id AND r.state = 'active'
       LEFT JOIN charge_point cp ON cp.id = r.charge_point_id
      WHERE q.site_id = $1 AND (q.state IN ${LIVE} OR q.ended_at > now() - interval '24 hours')
      ORDER BY (q.state IN ${LIVE}) DESC, q.joined_at`, [siteId]);
  const waiting = rows.filter((r) => r.state === 'waiting');
  const today = rows.filter((r) => r.state !== 'waiting' && r.state !== 'offered');
  const waits = today.filter((r) => r.state === 'served' && r.offered_at).map((r) => (new Date(r.offered_at!).getTime() - new Date(r.joined_at).getTime()) / 60_000);
  return {
    entries: rows.map((r) => ({
      id: r.id, state: r.state, joinedAt: r.joined_at, offeredAt: r.offered_at, endedAt: r.ended_at, endReason: r.end_reason,
      position: r.state === 'waiting' ? positionOf(waiting.map(wantOf), r.id) : null,
      driver: r.fleet_uid ? `Fleet card ${r.fleet_uid}` : maskPhone(r.phone) ?? 'App driver',
      want: [r.current_type, r.connector_type ? CONNECTOR_LABEL[r.connector_type] ?? r.connector_type : null].filter(Boolean).join(' · ') || 'Any connector',
      offer: r.offer_expires_at ? { connector: r.offer_connector, expiresAt: r.offer_expires_at } : null,
    })),
    stats: {
      waiting: waiting.length,
      offered: rows.filter((r) => r.state === 'offered').length,
      served24h: today.filter((r) => r.state === 'served').length,
      missed24h: today.filter((r) => r.state === 'missed').length,
      left24h: today.filter((r) => r.state === 'left').length,
      medianWaitMinutes: waits.length ? Math.round(waits.sort((a, b) => a - b)[Math.floor(waits.length / 2)]!) : null,
    },
  };
}

/** Remove a driver from the queue; a held connector is released for the next one. Returns what to audit. */
export async function removeEntry(siteId: string, entryId: string): Promise<{ entryId: string; state: string } | null> {
  if (!UUID_RE.test(entryId)) return null;
  const e = await one<EntryRow>(`SELECT q.*, NULL AS fleet_uid FROM driver_queue_entry q WHERE q.id = $1 AND q.site_id = $2 AND q.state IN ${LIVE}`, [entryId, siteId]);
  if (!e) return null;
  const ended = await endEntry(e.id, 'removed', 'removed by the operator');
  if (!ended) return null;
  await releaseOffer(e.id);
  const s = await siteRow(siteId);
  await notifyQueue(e.device_id, e.id, 'removed', s?.name ?? '', null);
  return { entryId: e.id, state: e.state };
}