import { one, many, query } from '../db/pool.js';
import { seal, unseal } from '../services/secrets.js';
import { logger } from '../logger.js';
import { BACKOFF_S, MAX_ATTEMPTS } from '../ocpi/push.js';
import { endpointUrl } from '../ocpi/store.js';
import { config } from '../config.js';
import { raiseHubAlert } from './alerts.js';
import { hubCall, type HubCallResult } from './call.js';
import { getConnection, getParty, selfPartyFor } from './registry.js';
import type { HubConnection, HubParty } from './types.js';

/**
 * The hub's outbox (design §5.5): broadcast fan-out (one row per recipient party), command / charging-profile
 * results posted back through the hub (callbacks), and ClientInfo pushes. Rows hold the body (unlike the
 * tenant outbox, the hub cannot re-render an object it does not own).
 *
 * - Ordered per (recipient connection, object_key); a recipient's pending ClientInfo goes before its other
 *   rows (a tenant accepts a party's data only once it knows the party: HubClientInfo).
 * - Coalescing: a broadcast PUT drops older UNSENT PUT/PATCH rows of the same object for that recipient;
 *   a ClientInfo push drops older unsent ones about the same party.
 * - Offline rule (OCPI HubClientInfo): broadcasts to an OFFLINE or SUSPENDED party are dropped ("do not queue
 *   push messages"; the party resyncs with GET All). Callbacks and ClientInfo are retried for up to 24 h.
 * - A 2xxx answer is final (failed, no retry); 3xxx, 4xxx and network errors retry with push.ts's backoff.
 */

export type OutboxKind = 'broadcast' | 'callback' | 'clientinfo' | 'forward_retry';

export interface OutboxIn {
  kind: OutboxKind;
  originPartyId?: string | null;
  recipientConnectionId: string;
  recipientPartyId?: string | null;
  module: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url?: string | null;
  pathSuffix?: string | null;
  body?: unknown;
  objectKey: string;
  correlationId: string;
}

/** Pending rows above which new broadcasts to a recipient are dropped (and an alert raised). */
export const BACKLOG_CAP = 10_000;
/** Callbacks and ClientInfo are retried this long through a recipient's outage. */
export const RETRY_WINDOW_MS = 24 * 60 * 60_000;

/**
 * A callback row's target URL (the member's response_url) is sealed like hub_callback.original_url: it is a
 * member-supplied secret-ish address that the database need not hold in clear. Bound to the row's object_key
 * (unique per callback use). Rows written before 074 hold it in clear and are read as they are.
 */
export const sealOutboxUrl = (url: string, objectKey: string) => seal(url, `hub_outbox_url:${objectKey}`);
export function openOutboxUrl(stored: string, objectKey: string): string {
  if (/^https?:\/\//i.test(stored)) return stored;
  return unseal(stored, `hub_outbox_url:${objectKey}`);
}

export async function enqueueHub(e: OutboxIn): Promise<number | null> {
  if (e.kind === 'broadcast') {
    const backlog = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM hub_outbox WHERE recipient_connection_id = $1 AND state = 'pending'`, [e.recipientConnectionId]);
    if ((backlog?.n ?? 0) >= BACKLOG_CAP) {
      await raiseHubAlert(e.recipientConnectionId, 'hub.outbox_backlog', 'warning',
        (name) => `PlugSure Hub: the outbox backlog to ${name} (connection ${e.recipientConnectionId.slice(0, 8)}) is over ${BACKLOG_CAP}: new broadcasts to it are dropped until it catches up.`);
      return null;
    }
  }
  if ((e.kind === 'broadcast' && e.method === 'PUT') || e.kind === 'clientinfo') {
    await query(
      `UPDATE hub_outbox SET state = 'dropped', last_error = 'superseded by a newer ' || $3
        WHERE recipient_connection_id = $1 AND object_key = $2 AND state = 'pending' AND attempts = 0
          AND kind = $3 AND method IN ('PUT','PATCH')`,
      [e.recipientConnectionId, e.objectKey, e.kind],
    );
  }
  const r = await one<{ id: string }>(
    `INSERT INTO hub_outbox (kind, origin_party_id, recipient_connection_id, recipient_party_id, module, method, url, path_suffix, body,
                             object_key, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [e.kind, e.originPartyId ?? null, e.recipientConnectionId, e.recipientPartyId ?? null, e.module, e.method, e.url ? sealOutboxUrl(e.url, e.objectKey) : null,
      e.pathSuffix ?? null, e.body === undefined ? null : JSON.stringify(e.body), e.objectKey, e.correlationId],
  );
  return r ? Number(r.id) : null;
}

interface DueRow {
  id: string; kind: OutboxKind; origin_party_id: string | null; recipient_connection_id: string; recipient_party_id: string | null;
  module: string; method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string | null; path_suffix: string | null; body: unknown;
  object_key: string; correlation_id: string; attempts: number; created_at: Date;
}

/** What to do with a row before sending it (pure; unit-tested). */
export function preflight(kind: OutboxKind, conn: Pick<HubConnection, 'state'> | null, recipient: Pick<HubParty, 'status'> | null, ageMs: number):
  { action: 'send' } | { action: 'drop' | 'fail' | 'wait'; reason: string } {
  if (!conn || conn.state === 'closed') return { action: 'drop', reason: 'recipient connection closed' };
  if (kind === 'broadcast') {
    if (conn.state !== 'connected') return { action: 'drop', reason: `recipient connection ${conn.state}` };
    if (!recipient) return { action: 'drop', reason: 'recipient party unknown' };
    if (recipient.status !== 'CONNECTED') return { action: 'drop', reason: `recipient ${recipient.status}: not queued (it resyncs with GET All)` };
    return { action: 'send' };
  }
  // Callbacks and ClientInfo: kept through an outage for up to 24 h.
  const down = conn.state !== 'connected' || (recipient && recipient.status !== 'CONNECTED' && kind === 'callback');
  if (down) return ageMs > RETRY_WINDOW_MS ? { action: 'fail', reason: 'recipient unreachable for 24 h' } : { action: 'wait', reason: 'recipient offline' };
  return { action: 'send' };
}

/** The outcome of an attempt (pure; unit-tested). */
export function outcomeOf(kind: OutboxKind, r: Pick<HubCallResult, 'ok' | 'ocpiStatus' | 'failure'>, attempts: number, ageMs: number):
  'delivered' | 'retry' | 'failed' {
  if (r.ok) return 'delivered';
  if (r.failure === 'policy') return 'failed';
  // A 2xxx answer: the recipient refused this message; sending it again changes nothing.
  if (r.ocpiStatus != null && r.ocpiStatus >= 2000 && r.ocpiStatus < 3000) return 'failed';
  if (kind !== 'broadcast' && ageMs > RETRY_WINDOW_MS) return 'failed';
  return attempts >= MAX_ATTEMPTS ? 'failed' : 'retry';
}

const backoff = (attempts: number) => BACKOFF_S[Math.min(Math.max(attempts - 1, 0), BACKOFF_S.length - 1)]!;

/** Worker pass: send what is due, in order per (recipient, object). */
export async function deliverHubDue(limit = 100): Promise<number> {
  const due = await many<DueRow>(
    `WITH picked AS (
       SELECT o.id FROM hub_outbox o
        WHERE o.state = 'pending' AND o.next_attempt_at <= now()
          AND NOT EXISTS (SELECT 1 FROM hub_outbox e
                           WHERE e.recipient_connection_id = o.recipient_connection_id AND e.object_key = o.object_key
                             AND e.state = 'pending' AND e.id < o.id)
          AND (o.kind = 'clientinfo' OR NOT EXISTS (
                SELECT 1 FROM hub_outbox c
                 WHERE c.recipient_connection_id = o.recipient_connection_id AND c.kind = 'clientinfo'
                   AND c.state = 'pending' AND c.attempts < 2 AND c.id < o.id))
        ORDER BY (o.kind = 'clientinfo') DESC, o.id
        LIMIT $1
        FOR UPDATE OF o SKIP LOCKED)
     UPDATE hub_outbox o SET attempts = o.attempts + 1, next_attempt_at = now() + interval '2 minutes'
       FROM picked WHERE o.id = picked.id
     RETURNING o.id, o.kind, o.origin_party_id, o.recipient_connection_id, o.recipient_party_id, o.module, o.method, o.url,
               o.path_suffix, o.body, o.object_key, o.correlation_id, o.attempts, o.created_at`,
    [limit],
  );
  await Promise.all(due.map((d) => attempt(d).catch(async (e) => {
    logger.warn({ id: d.id, err: (e as Error).message }, 'hub outbox delivery crashed');
    await query(`UPDATE hub_outbox SET state = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END, last_error = $2,
                        next_attempt_at = now() + make_interval(secs => $4::int) WHERE id = $1 AND state = 'pending'`,
      [d.id, `internal error: ${(e as Error).message}`.slice(0, 500), MAX_ATTEMPTS, backoff(d.attempts)]).catch(() => {});
  })));
  return due.length;
}

let kicking: Promise<void> | null = null;
let kickAgain = false;
/** Deliver what is due now, in this process (after a broadcast or callback was enqueued); single-flight. */
export function kickHubOutbox(): void {
  if (kicking) { kickAgain = true; return; }
  kicking = (async () => {
    try {
      do {
        kickAgain = false;
        let rounds = 0;
        while ((await deliverHubDue(100)) > 0 && rounds++ < 20) { /* keep going while rows were due */ }
      } while (kickAgain);
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'hub outbox kick failed');
    } finally {
      kicking = null;
    }
  })();
}

async function settle(id: string, state: 'delivered' | 'failed' | 'dropped' | 'pending', r: Partial<HubCallResult> | null, note: string | null, waitS = 0) {
  await query(
    `UPDATE hub_outbox SET state = $2, last_status = $3, last_ocpi_status = $4, last_error = $5,
            delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END,
            next_attempt_at = CASE WHEN $2 = 'pending' THEN now() + make_interval(secs => $6::int) ELSE next_attempt_at END
      WHERE id = $1`,
    [id, state, r?.httpStatus ?? null, r?.ocpiStatus ?? null, (note ?? r?.error ?? null)?.slice(0, 500) ?? null, waitS],
  );
}

async function attempt(d: DueRow): Promise<void> {
  const conn = await getConnection(d.recipient_connection_id);
  const recipient = d.recipient_party_id ? await getParty(d.recipient_party_id) : null;
  const age = Date.now() - new Date(d.created_at).getTime();
  const pre = preflight(d.kind, conn, recipient, age);
  if (pre.action === 'drop') return settle(d.id, 'dropped', null, pre.reason);
  if (pre.action === 'fail') return settle(d.id, 'failed', null, pre.reason);
  if (pre.action === 'wait') return settle(d.id, 'pending', null, pre.reason, Math.min(backoff(d.attempts), 600));
  const c = conn!;
  let url = d.url ? openOutboxUrl(d.url, d.object_key) : null;
  if (!url) {
    const ep = endpointUrl(c, d.module, 'RECEIVER');
    if (!ep) return settle(d.id, 'failed', null, `recipient has no ${d.module} RECEIVER endpoint`);
    url = ep + (d.path_suffix ?? '');
  }
  const origin = d.origin_party_id ? await getParty(d.origin_party_id) : null;
  // Broadcast legs come FROM the hub (the hub party of the recipient's country); callbacks from the CPO that
  // answered; ClientInfo is a configuration module (no routing headers, OCPI 2.2.1 § 4.1.4).
  const from = d.kind === 'broadcast' ? selfPartyFor(recipient?.country_code) : d.kind === 'callback' ? origin : null;
  const to = d.kind === 'clientinfo' ? null : recipient;
  const r = await hubCall({
    conn: c, method: d.method, url, body: d.body ?? undefined, from, to, correlationId: d.correlation_id,
    timeoutMs: config.hub.forwardTimeoutMs, route: d.kind, module: d.module,
    capture: !!c.capture_bodies_until && new Date(c.capture_bodies_until) > new Date(),
  });
  if (r.ok) await noteAlive(c.id);
  // An EVSE/connector PATCH the recipient cannot place (it does not have the location): fetch the whole
  // location from its CPO and broadcast it to this recipient as a PUT instead (design §5.5 step 6).
  if (!r.ok && d.kind === 'broadcast' && d.module === 'locations' && d.method === 'PATCH' && r.ocpiStatus === 2003 && origin) {
    const replaced = await refetchLocation(d, origin, c, recipient!);
    return settle(d.id, replaced ? 'delivered' : 'failed', r, replaced ? 'recipient lacked the location: superseded by a full PUT' : `recipient lacked the location and it could not be fetched from ${origin.country_code}*${origin.party_id}`);
  }
  const outcome = outcomeOf(d.kind, r, d.attempts, age);
  if (outcome === 'retry') return settle(d.id, 'pending', r, null, backoff(d.attempts));
  return settle(d.id, outcome, r, null);
}

/** GET the full location from its CPO (as the hub), then queue it as a PUT to this recipient. */
async function refetchLocation(d: DueRow, origin: HubParty, recipientConn: HubConnection, recipient: HubParty): Promise<boolean> {
  const seg = (d.path_suffix ?? '').split('/').filter(Boolean); // cc, pid, loc, [evse, [conn]]
  const locId = seg[2];
  if (!locId || !origin.connection_id) return false;
  const oc = await getConnection(origin.connection_id);
  const sender = oc ? endpointUrl(oc, 'locations', 'SENDER') : null;
  if (!oc || !sender || oc.state !== 'connected') return false;
  const g = await hubCall({
    conn: oc, method: 'GET', url: `${sender}/${encodeURIComponent(decodeURIComponent(locId))}`, from: selfPartyFor(origin.country_code), to: origin,
    correlationId: d.correlation_id, timeoutMs: config.hub.forwardTimeoutMs, route: 'broadcast_refetch', module: 'locations',
  });
  const loc = g.ok ? g.json?.data : null;
  if (!loc || typeof loc !== 'object' || loc.country_code !== origin.country_code || loc.party_id !== origin.party_id) return false;
  await enqueueHub({
    kind: 'broadcast', originPartyId: origin.id, recipientConnectionId: recipientConn.id, recipientPartyId: recipient.id,
    module: 'locations', method: 'PUT', pathSuffix: `/${seg[0]}/${seg[1]}/${seg[2]}`, body: loc, objectKey: d.object_key,
    correlationId: d.correlation_id,
  });
  return true;
}

/** A successful exchange with a member's connection: it is alive (design §5.4 step 7, §5.8). */
export async function noteAlive(connectionId: string): Promise<void> {
  await query(`UPDATE hub_connection SET last_alive_ok_at = now(), alive_failures = 0 WHERE id = $1`, [connectionId]);
  const back = await many<{ id: string }>(
    `UPDATE hub_party SET status = 'CONNECTED', status_changed_at = now()
      WHERE connection_id = $1 AND status = 'OFFLINE' AND NOT admin_suspended RETURNING id`, [connectionId]);
  if (back.length) {
    const { pushClientInfoAbout } = await import('./clientinfo.js');
    await pushClientInfoAbout(back.map((b) => b.id));
  }
}

export async function replayHub(connectionId: string): Promise<number> {
  // A failed row superseded by a LATER row of the same object for the same recipient (delivered, or still to be
  // delivered) is not replayed: its body is older, and sending it after the newer one would roll the recipient's
  // copy back (a stale location, tariff or token). It is marked dropped, so a later replay skips it too.
  await query(
    `UPDATE hub_outbox o SET state = 'dropped', last_error = 'not replayed: superseded by a later message for the same object'
      WHERE o.recipient_connection_id = $1 AND o.state = 'failed'
        AND EXISTS (SELECT 1 FROM hub_outbox n WHERE n.recipient_connection_id = o.recipient_connection_id AND n.object_key = o.object_key
                       AND n.id > o.id AND n.state IN ('delivered','pending'))`, [connectionId]);
  const r = await query(
    `UPDATE hub_outbox SET state = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
      WHERE recipient_connection_id = $1 AND state = 'failed'`, [connectionId]);
  return r.rowCount ?? 0;
}

/** Retention (design §3.3): delivered/dropped 14 days, failed 60, messages 30, expired callbacks and index entries. */
export async function pruneHub(): Promise<void> {
  await query(`DELETE FROM hub_outbox WHERE (state IN ('delivered','dropped') AND created_at < now() - interval '14 days')
                                         OR (state = 'failed' AND created_at < now() - interval '60 days')`);
  await query(`DELETE FROM hub_message WHERE created_at < now() - interval '30 days'`);
  await query(`UPDATE hub_message SET body_redacted = NULL WHERE body_redacted IS NOT NULL AND created_at < now() - interval '72 hours'`);
  await query(`DELETE FROM hub_callback WHERE expires_at < now() - interval '1 day'`);
  await query(`DELETE FROM hub_route_index WHERE expires_at IS NOT NULL AND expires_at < now()`);
}
