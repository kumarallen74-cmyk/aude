import { randomUUID } from 'node:crypto';
import { many, one, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { ocpiDateTime } from '../ocpi/mapping.js';
import { endpointUrl } from '../ocpi/store.js';
import { agreedCounterparties } from './agreements.js';
import { raiseHubAlert } from './alerts.js';
import { hubCall } from './call.js';
import { enqueueHub, kickHubOutbox, noteAlive } from './outbox.js';
import { getConnection, getParty, partiesOfConnection, setPartyStatus } from './registry.js';
import type { HubConnection, HubParty, PartyStatus } from './types.js';

/**
 * HubClientInfo, the hub as SENDER (OCPI 2.2.1 § 16; design §5.8).
 *
 * Visibility: a connection sees, for each of its parties, every counterparty of the opposite role it has an
 * active agreement with (or mutual open roaming) — never its own member's other parties (a tenant would treat
 * itself as a hub client), never a party without an agreement, never a PLANNED one.
 *
 * Push: PUT {viewer's hubclientinfo RECEIVER}/{cc}/{pid} on every change the viewer can see, through the
 * outbox (retried for 24 h, not dropped while the viewer is OFFLINE). Objects are never deleted: a party a
 * viewer may no longer see (agreement ended) is pushed one last time as SUSPENDED.
 */

export interface ClientInfoOut { party_id: string; country_code: string; role: string; status: PartyStatus; last_updated: string }

export const clientInfoOf = (p: HubParty, status?: PartyStatus, at?: Date): ClientInfoOut => ({
  party_id: p.party_id, country_code: p.country_code, role: p.role, status: status ?? p.status,
  last_updated: ocpiDateTime(at ?? p.status_changed_at),
});

/** Everything a connection may see (GET hubclientinfo; the full push). */
export async function visibleTo(connectionId: string): Promise<HubParty[]> {
  const own = await partiesOfConnection(connectionId);
  const seen = new Map<string, HubParty>();
  for (const p of own) {
    for (const q of await agreedCounterparties(p, { statuses: ['CONNECTED', 'OFFLINE', 'SUSPENDED'] })) seen.set(q.id, q);
  }
  return [...seen.values()].sort((a, b) => `${a.country_code}${a.party_id}${a.role}`.localeCompare(`${b.country_code}${b.party_id}${b.role}`));
}

/** The connections that may see party Q (the connections of its agreed counterparties). */
export async function viewersOf(q: HubParty): Promise<string[]> {
  if (q.status === 'PLANNED') return [];
  const peers = await agreedCounterparties(q, { statuses: ['CONNECTED', 'OFFLINE', 'SUSPENDED', 'PLANNED'] });
  return [...new Set(peers.map((p) => p.connection_id).filter((c): c is string => !!c))];
}

async function pushTo(conn: HubConnection | null, q: HubParty, status?: PartyStatus, at?: Date): Promise<boolean> {
  if (!conn || conn.state !== 'connected' || !endpointUrl(conn, 'hubclientinfo', 'RECEIVER')) return false;
  await enqueueHub({
    kind: 'clientinfo', recipientConnectionId: conn.id, module: 'hubclientinfo', method: 'PUT',
    pathSuffix: `/${q.country_code}/${q.party_id}`, body: clientInfoOf(q, status, at),
    objectKey: `clientinfo:${q.country_code}:${q.party_id}:${q.role}`, correlationId: randomUUID(),
  });
  return true;
}

/** Push the current status of these parties to every connection that can see them. */
export async function pushClientInfoAbout(partyIds: string[]): Promise<number> {
  let n = 0;
  for (const id of new Set(partyIds)) {
    const q = await getParty(id);
    if (!q) continue;
    for (const c of await viewersOf(q)) if (await pushTo(await getConnection(c), q)) n++;
  }
  if (n) kickHubOutbox();
  return n;
}

/** The full list to one connection (after registration, and the 6-hourly resync). */
export async function pushClientInfoTo(connectionId: string): Promise<number> {
  const conn = await getConnection(connectionId);
  let n = 0;
  for (const q of await visibleTo(connectionId)) if (await pushTo(conn, q)) n++;
  if (n) kickHubOutbox();
  return n;
}

/**
 * An agreement changed: both sides learn about each other (activation: current status; ended or suspended:
 * SUSPENDED, the spec's "invalidate", stamped now so it supersedes what they hold).
 */
export async function pushAgreementChange(cpoPartyId: string, emspPartyId: string, live: boolean): Promise<void> {
  const a = await getParty(cpoPartyId);
  const b = await getParty(emspPartyId);
  if (!a || !b) return;
  const now = new Date();
  for (const [subject, viewer] of [[a, b], [b, a]] as const) {
    if (!viewer.connection_id) continue;
    const conn = await getConnection(viewer.connection_id);
    if (live) { if (subject.status !== 'PLANNED') await pushTo(conn, subject); } else await pushTo(conn, subject, 'SUSPENDED', now);
  }
  kickHubOutbox();
}

export async function resyncAllClientInfo(): Promise<void> {
  const conns = await many<{ id: string }>(`SELECT id FROM hub_connection WHERE state = 'connected'`);
  for (const c of conns) await pushClientInfoTo(c.id).catch((e) => logger.warn({ conn: c.id, err: (e as Error).message }, 'hub ClientInfo resync failed'));
}

// ─────────────────────────────────────────────── liveness

/**
 * Still-alive checks (OCPI HubClientInfo: "after X minutes … start with 5 minutes"): a connected member
 * that sent nothing and answered nothing for HUB_ALIVE_AFTER_MIN gets a GET on its versions URL. Two failures
 * in a row → its parties OFFLINE (ClientInfo pushed); an answer, or any inbound message → CONNECTED again.
 * `force` checks the given connection now, whatever its idle time (platform support / tests).
 */
export async function aliveChecks(opts: { connectionId?: string; force?: boolean } = {}): Promise<Array<{ connection: string; ok: boolean; offline: boolean }>> {
  const conns = await many<HubConnection>(
    `SELECT * FROM hub_connection
      WHERE state = 'connected' AND ($1::uuid IS NULL OR id = $1)
        AND ($2 OR GREATEST(last_inbound_at, last_alive_ok_at, registered_at, created_at) < now() - make_interval(secs => $3::int))`,
    [opts.connectionId ?? null, !!opts.force, Math.round(config.hub.aliveAfterMin * 60)],
  );
  const out: Array<{ connection: string; ok: boolean; offline: boolean }> = [];
  for (const c of conns) {
    if (!c.versions_url) continue;
    const r = await hubCall({ conn: c, method: 'GET', url: c.versions_url, correlationId: randomUUID(), timeoutMs: config.hub.realtimeTimeoutMs, route: 'alive', module: 'versions' });
    if (r.ok && Array.isArray(r.json?.data)) {
      await noteAlive(c.id);
      out.push({ connection: c.id, ok: true, offline: false });
      continue;
    }
    const row = await one<{ alive_failures: number }>(
      `UPDATE hub_connection SET alive_failures = alive_failures + 1, last_error = $2, updated_at = now() WHERE id = $1 RETURNING alive_failures`,
      [c.id, `alive check: ${r.error ?? 'unexpected answer'}`.slice(0, 500)]);
    let offline = false;
    if ((row?.alive_failures ?? 0) >= 2) {
      const ids = (await partiesOfConnection(c.id)).map((p) => p.id);
      const changed = await setPartyStatus(ids, 'OFFLINE', { liveness: true });
      if (changed.length) {
        offline = true;
        await pushClientInfoAbout(changed);
        await raiseHubAlert(c.id, 'hub.connection_offline', 'warning',
          (name) => `PlugSure Hub: ${name} (connection ${c.id.slice(0, 8)}) did not answer two alive checks: its parties are OFFLINE (${r.error ?? 'no answer'}).`);
      }
    }
    out.push({ connection: c.id, ok: false, offline });
  }
  return out;
}

/** An inbound request from a connection: it is alive; OFFLINE parties come back (and ClientInfo says so). */
const lastInbound = new Map<string, number>();
export async function noteInbound(connectionId: string): Promise<void> {
  // The connection's timestamp at most every 15 s from this process (a busy member sends many requests).
  const now = Date.now();
  if (now - (lastInbound.get(connectionId) ?? 0) >= 15_000) {
    lastInbound.set(connectionId, now);
    if (lastInbound.size > 10_000) lastInbound.clear();
    await query(`UPDATE hub_connection SET last_inbound_at = now(), alive_failures = 0 WHERE id = $1`, [connectionId]);
  }
  const back = await many<{ id: string }>(
    `UPDATE hub_party SET status = 'CONNECTED', status_changed_at = now()
      WHERE connection_id = $1 AND status = 'OFFLINE' AND NOT admin_suspended RETURNING id`, [connectionId]);
  if (back.length) {
    await query(`UPDATE hub_connection SET last_inbound_at = now(), alive_failures = 0 WHERE id = $1`, [connectionId]);
    await pushClientInfoAbout(back.map((b) => b.id));
  }
}
