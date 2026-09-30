import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { one, many, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { config, isRelaxedEnv } from '../config.js';
import { bus, type PlugSureEvents } from './events.js';
import { seal, unseal, newSigningSecret } from './secrets.js';
import { guardedLookup, isInternalHost } from './net-guard.js';

/**
 * Outbound webhooks — the integration surface fleet managers, site hosts, ERPs
 * and ticketing tools use (the benchmark every commercial CSMS sets).
 *
 *  - Endpoints subscribe to event types ('*' or an empty list = all).
 *  - Every event is written to webhook_delivery first (an outbox), then sent by
 *    a worker in the gateway: at-least-once, exponential backoff, dead-lettered
 *    as 'failed' after MAX_ATTEMPTS and replayable from the console.
 *  - Signed: `PlugSure-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
 *    Receivers must verify it and reject a timestamp older than 5 minutes.
 *  - The signing secret is sealed at rest (secrets.ts) and shown once.
 *  - SSRF: in production only https, and the resolved address is checked at
 *    CONNECT time (no private, loopback, link-local or metadata addresses), so a
 *    DNS rebind between check and connect cannot reach the internal network.
 */

export const WEBHOOK_EVENTS = [
  'session.started',
  'session.ended',
  'cdr.created',
  'charge_point.connected',
  'charge_point.disconnected',
  'charge_point.booted',
  'connector.status_changed',
  'alert.raised',
  'refund.due',
  'refund.completed',
  'firmware.status',
] as const satisfies readonly (keyof PlugSureEvents)[];
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const MAX_ATTEMPTS = 8;
/** Seconds before retry N (1-based): 30s, 2m, 10m, 30m, 1h, 3h, 6h. */
const BACKOFF_S = [30, 120, 600, 1800, 3600, 10800, 21600];
/** An endpoint that fails this many deliveries in a row AND has had no success for 24 h is disabled, with an alert. */
const DISABLE_AFTER = 50;
const TIMEOUT_MS = 10_000;

const production = () => !isRelaxedEnv();

// ─────────────────────────────────────────── URL / address safety

/** Validation at save time. Returns an error message, or null when acceptable. */
export function checkUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'Enter a full URL, e.g. https://example.com/plugsure/webhook'; }
  if (u.username || u.password) return 'Do not put credentials in the URL; verify the signature instead.';
  if (production() && u.protocol !== 'https:') return 'Webhook URLs must use https.';
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Webhook URLs must be http(s).';
  if (production() && isInternalHost(u.hostname)) {
    return 'Webhook URLs must be publicly reachable (no private, loopback or internal addresses).';
  }
  return null;
}

// ─────────────────────────────────────────── transport

export interface SendResult { ok: boolean; status: number | null; error: string | null; ms: number }

export function sign(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

function post(url: string, body: string, headers: Record<string, string>): Promise<SendResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let u: URL;
    try { u = new URL(url); } catch { return resolve({ ok: false, status: null, error: 'invalid URL', ms: 0 }); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': 'PlugSure-Webhooks/1.3', ...headers },
        lookup: guardedLookup as any,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        // Drain (bounded) and ignore the body — only the status matters. Redirects are NOT followed.
        let n = 0;
        res.on('data', (c: Buffer) => { n += c.length; if (n > 64 * 1024) res.destroy(); });
        res.on('end', () => {
          const s = res.statusCode ?? 0;
          resolve({ ok: s >= 200 && s < 300, status: s, error: s >= 200 && s < 300 ? null : `HTTP ${s}`, ms: Date.now() - started });
        });
        res.on('error', () => resolve({ ok: false, status: res.statusCode ?? null, error: 'response aborted', ms: Date.now() - started }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timed out after ${TIMEOUT_MS / 1000}s`)));
    req.on('error', (e) => resolve({ ok: false, status: null, error: e.message.slice(0, 300), ms: Date.now() - started }));
    req.end(body);
  });
}

function envelope(eventId: string, type: string, createdAt: Date, data: unknown) {
  return JSON.stringify({ id: eventId, type, created_at: createdAt.toISOString(), api_version: '2026-09', data });
}

// ─────────────────────────────────────────── outbox

/** Write one delivery per subscribed endpoint. Called where the event is raised. */
export async function enqueue(orgId: string, type: string, data: Record<string, unknown>): Promise<number> {
  const { orgId: _drop, ...rest } = data;
  const r = await query(
    `INSERT INTO webhook_delivery (org_id, endpoint_id, event_type, payload)
     SELECT $1, w.id, $2, $3::jsonb
       FROM webhook_endpoint w
      WHERE w.org_id = $1 AND w.state = 'active'
        AND (cardinality(w.events) = 0 OR '*' = ANY(w.events) OR $2 = ANY(w.events))`,
    [orgId, type, JSON.stringify(rest)],
  );
  return r.rowCount ?? 0;
}

/**
 * Register on the bus. Named listeners run only in the process that raised the
 * event, so registering in both the gateway and the API never enqueues twice.
 */
export function registerWebhookListeners(): void {
  for (const type of WEBHOOK_EVENTS) {
    bus.on(type, (p: any) => {
      if (!p?.orgId) return;
      void enqueue(p.orgId, type, p).catch((e) => logger.warn({ err: (e as Error).message, type }, 'webhook enqueue failed'));
    });
  }
}

interface DueRow { id: string; endpoint_id: string; org_id: string; event_id: string; event_type: string; payload: unknown; attempts: number; created_at: Date; url: string; secret: string }

/** Worker pass: send what is due. Rows are leased (next_attempt_at pushed out) before sending. */
export async function deliverDue(limit = 50): Promise<number> {
  const due = await many<DueRow>(
    `WITH picked AS (
       SELECT d.id FROM webhook_delivery d
         JOIN webhook_endpoint w ON w.id = d.endpoint_id
        WHERE d.state = 'pending' AND d.next_attempt_at <= now() AND w.state = 'active'
        ORDER BY d.next_attempt_at
        LIMIT $1
        FOR UPDATE OF d SKIP LOCKED)
     UPDATE webhook_delivery d
        SET attempts = d.attempts + 1, next_attempt_at = now() + interval '2 minutes'
       FROM picked, webhook_endpoint w
      WHERE d.id = picked.id AND w.id = d.endpoint_id
      RETURNING d.id, d.endpoint_id, d.org_id, d.event_id, d.event_type, d.payload, d.attempts, d.created_at, w.url, w.secret`,
    [limit],
  );
  await Promise.all(due.map((d) => attempt(d)));
  return due.length;
}

async function attempt(d: DueRow): Promise<SendResult> {
  const body = envelope(d.event_id, d.event_type, new Date(d.created_at), d.payload);
  let secret: string;
  try { secret = unseal(d.secret); } catch { secret = ''; }
  const res = secret
    ? await post(d.url, body, { 'plugsure-signature': sign(secret, body), 'plugsure-event': d.event_type, 'plugsure-delivery': d.event_id })
    : { ok: false, status: null, error: 'signing secret cannot be decrypted (SECRETS_KEY changed?) — rotate the secret', ms: 0 };
  if (res.ok) {
    await query(`UPDATE webhook_delivery SET state = 'delivered', delivered_at = now(), last_status = $2, last_error = NULL WHERE id = $1`, [d.id, res.status]);
    await query(`UPDATE webhook_endpoint SET consecutive_failures = 0, last_success_at = now(), last_error = NULL WHERE id = $1`, [d.endpoint_id]);
    return res;
  }
  const dead = d.attempts >= MAX_ATTEMPTS;
  const wait = BACKOFF_S[Math.min(d.attempts - 1, BACKOFF_S.length - 1)]!;
  await query(
    `UPDATE webhook_delivery SET state = $2, last_status = $3, last_error = $4, next_attempt_at = now() + make_interval(secs => $5::int) WHERE id = $1`,
    [d.id, dead ? 'failed' : 'pending', res.status, res.error, wait],
  );
  const ep = await one<{ consecutive_failures: number; state: string; quiet_24h: boolean }>(
    `UPDATE webhook_endpoint SET consecutive_failures = consecutive_failures + 1, last_failure_at = now(), last_error = $2
      WHERE id = $1
      RETURNING consecutive_failures, state,
                COALESCE(last_success_at, created_at) < now() - interval '24 hours' AS quiet_24h`,
    [d.endpoint_id, res.error],
  );
  // Disable only on SUSTAINED failure: a busy network can fail 50 deliveries during a
  // five-minute receiver restart, and that must not silently cut the integration.
  if (ep && ep.state === 'active' && ep.consecutive_failures >= DISABLE_AFTER && ep.quiet_24h) {
    await query(`UPDATE webhook_endpoint SET state = 'disabled', updated_at = now() WHERE id = $1`, [d.endpoint_id]);
    // Not an event of its own: the alert raised here must not itself be queued to the dead endpoint.
    bus.emit('alert.raised', {
      orgId: d.org_id,
      kind: 'webhook.disabled',
      severity: 'warning',
      message: `Webhook ${d.url} failed ${ep.consecutive_failures} deliveries in a row with no success for 24 hours and was disabled (last error: ${res.error}). Fix the receiver, then re-enable it and replay the failed deliveries.`,
      targetType: 'webhook_endpoint',
      targetId: d.endpoint_id,
    });
  }
  return res;
}

// ─────────────────────────────────────────── management (API)

const PUBLIC_COLS = `id, url, description, events, state, created_at, updated_at, consecutive_failures, last_success_at, last_failure_at, last_error`;

export async function listEndpoints(orgId: string) {
  return many(
    `SELECT ${PUBLIC_COLS},
            (SELECT count(*) FROM webhook_delivery d WHERE d.endpoint_id = w.id AND d.state = 'pending')::int AS pending,
            (SELECT count(*) FROM webhook_delivery d WHERE d.endpoint_id = w.id AND d.state = 'failed')::int AS failed,
            (SELECT count(*) FROM webhook_delivery d WHERE d.endpoint_id = w.id AND d.state = 'delivered' AND d.created_at > now() - interval '24 hours')::int AS delivered_24h
       FROM webhook_endpoint w WHERE org_id = $1 ORDER BY created_at`,
    [orgId],
  );
}

function cleanEvents(events: unknown): string[] | string {
  const list = Array.isArray(events) ? events.map(String) : [];
  if (list.includes('*') || list.length === 0) return ['*'];
  const bad = list.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (bad.length) return `Unknown event type: ${bad.join(', ')}`;
  return [...new Set(list)];
}

export async function createEndpoint(orgId: string, input: { url?: string; description?: string; events?: unknown }) {
  const url = String(input.url ?? '').trim();
  const urlErr = checkUrl(url);
  if (urlErr) return { error: urlErr };
  const events = cleanEvents(input.events);
  if (typeof events === 'string') return { error: events };
  const secret = newSigningSecret();
  const row = await one(
    `INSERT INTO webhook_endpoint (org_id, url, secret, events, description) VALUES ($1,$2,$3,$4,$5) RETURNING ${PUBLIC_COLS}`,
    [orgId, url, seal(secret), events, String(input.description ?? '').trim().slice(0, 200) || null],
  );
  return { endpoint: row, secret };
}

export async function updateEndpoint(orgId: string, id: string, input: { url?: string; description?: string; events?: unknown; state?: string }) {
  const sets: string[] = [];
  const vals: unknown[] = [id, orgId];
  if (input.url !== undefined) {
    const err = checkUrl(String(input.url).trim());
    if (err) return { error: err };
    vals.push(String(input.url).trim()); sets.push(`url = $${vals.length}`);
  }
  if (input.description !== undefined) { vals.push(String(input.description).trim().slice(0, 200) || null); sets.push(`description = $${vals.length}`); }
  if (input.events !== undefined) {
    const ev = cleanEvents(input.events);
    if (typeof ev === 'string') return { error: ev };
    vals.push(ev); sets.push(`events = $${vals.length}`);
  }
  if (input.state !== undefined) {
    if (!['active', 'paused'].includes(input.state)) return { error: 'state must be active or paused' };
    vals.push(input.state); sets.push(`state = $${vals.length}`);
    // Re-enabling clears the failure streak so it is not disabled again on the next miss.
    if (input.state === 'active') sets.push('consecutive_failures = 0');
  }
  if (!sets.length) return { error: 'nothing to change' };
  const row = await one(`UPDATE webhook_endpoint SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING ${PUBLIC_COLS}`, vals);
  return row ? { endpoint: row } : { error: 'not found' };
}

export async function rotateSecret(orgId: string, id: string) {
  const secret = newSigningSecret();
  const r = await query(`UPDATE webhook_endpoint SET secret = $3, updated_at = now() WHERE id = $1 AND org_id = $2`, [id, orgId, seal(secret)]);
  return r.rowCount ? { secret } : { error: 'not found' };
}

export async function deleteEndpoint(orgId: string, id: string) {
  const r = await query(`DELETE FROM webhook_endpoint WHERE id = $1 AND org_id = $2`, [id, orgId]);
  return (r.rowCount ?? 0) > 0;
}

/** Send a signed `ping` now and report the receiver's answer (recorded as a delivery). */
export async function testEndpoint(orgId: string, id: string) {
  const ep = await one<{ id: string; url: string; secret: string; state: string }>(`SELECT id, url, secret, state FROM webhook_endpoint WHERE id = $1 AND org_id = $2`, [id, orgId]);
  if (!ep) return { error: 'not found' };
  const eventId = randomUUID();
  const data = { message: 'PlugSure webhook test', endpointId: ep.id };
  const body = envelope(eventId, 'ping', new Date(), data);
  let secret = '';
  try { secret = unseal(ep.secret); } catch { /* reported below */ }
  const res = secret
    ? await post(ep.url, body, { 'plugsure-signature': sign(secret, body), 'plugsure-event': 'ping', 'plugsure-delivery': eventId })
    : { ok: false, status: null, error: 'signing secret cannot be decrypted — rotate the secret', ms: 0 };
  await query(
    `INSERT INTO webhook_delivery (org_id, endpoint_id, event_id, event_type, payload, state, attempts, last_status, last_error, delivered_at)
     VALUES ($1,$2,$3,'ping',$4::jsonb,$5,1,$6,$7,$8)`,
    [orgId, ep.id, eventId, JSON.stringify(data), res.ok ? 'delivered' : 'failed', res.status, res.error, res.ok ? new Date() : null],
  );
  return { result: res };
}

export async function listDeliveries(orgId: string, endpointId: string, state?: string) {
  return many(
    `SELECT id, event_id, event_type, state, attempts, next_attempt_at, last_status, last_error, created_at, delivered_at, payload
       FROM webhook_delivery
      WHERE org_id = $1 AND endpoint_id = $2 AND ($3::text IS NULL OR state = $3)
      ORDER BY created_at DESC LIMIT 200`,
    [orgId, endpointId, state && ['pending', 'delivered', 'failed'].includes(state) ? state : null],
  );
}

/** Put failed deliveries (one, or all for the endpoint) back in the queue. */
export async function replay(orgId: string, endpointId: string, deliveryId?: string) {
  const r = await query(
    `UPDATE webhook_delivery SET state = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
      WHERE org_id = $1 AND endpoint_id = $2 AND state = 'failed' AND event_type <> 'ping' AND ($3::bigint IS NULL OR id = $3::bigint)`,
    [orgId, endpointId, deliveryId ?? null],
  );
  return r.rowCount ?? 0;
}

/** Keep the outbox bounded: delivered rows 14 days, failed rows 30 days. */
export async function pruneDeliveries(): Promise<void> {
  await query(
    `DELETE FROM webhook_delivery
      WHERE (state = 'delivered' AND created_at < now() - interval '14 days')
         OR (state = 'failed' AND created_at < now() - interval '30 days')`,
  );
}
