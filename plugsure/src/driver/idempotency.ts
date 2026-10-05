import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { one, query } from '../db/pool.js';
import { logger } from '../logger.js';

/**
 * Idempotency-Key on the driver API's money-creating POSTs (v1.9.1; migration 077).
 *
 * The header used to be allowed by CORS and then ignored: a payment POST retried after a client timeout created a
 * second payment_intent, and the driver paid twice. Now, with `Idempotency-Key` (8–128 of [A-Za-z0-9_-]; optional —
 * without it nothing changes), per (device, key):
 *
 *   - the key is CLAIMED before the work runs (one statement: a parallel duplicate finds the claim);
 *   - the answer is stored when it is not a 5xx (state 'done'); a 5xx the handler sent on purpose (nothing was
 *     done, e.g. payments unavailable) deletes the claim, so the client may retry with the same key;
 *   - a THROWN error keeps the claim 'running' until it is stale (RUNNING_STALE_MIN): the outcome is unknown — an
 *     acquirer that timed out may still have charged a saved card — so a retry answers 409 (the app shows "still
 *     processing") instead of charging a second time, and the payment notification settles the first attempt;
 *   - the same key again, same route and request → the stored status and body, `Idempotent-Replayed: true`, not run;
 *   - while the first is still running → 409 `idempotency_in_progress`;
 *   - the same key for another route or another body → 422 `idempotency_key_reused`.
 *
 * Rows older than 24 h are ignored (a claim over one starts afresh) and pruned now and then. A claim still 'running'
 * after RUNNING_STALE_MIN belongs to a request that never finished (the process stopped): it may be claimed again,
 * rather than the key answering 409 for a day.
 */

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;
const RUNNING_STALE_MIN = 10;

/** JSON with object keys sorted, so the same request always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export function requestHash(body: unknown, params: unknown): string {
  return createHash('sha256').update(canonicalJson({ body: body ?? null, params: params ?? null })).digest('hex');
}

export type Claim =
  | { kind: 'claimed' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'running' }
  | { kind: 'reused' };

/** Claim (device, key) for this request, or say what an earlier request with the key left. */
export async function claimKey(deviceId: string, key: string, route: string, hash: string): Promise<Claim> {
  if (Math.random() < 0.02) {
    query(`DELETE FROM driver_idempotency WHERE created_at < now() - interval '24 hours'`).catch(() => {});
  }
  // New, or over a row that no longer counts (older than a day, or a claim abandoned while running).
  const claimed = await one(
    `INSERT INTO driver_idempotency AS i (device_id, key, route, request_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (device_id, key) DO UPDATE SET route = EXCLUDED.route, request_hash = EXCLUDED.request_hash, state = 'running',
            status_code = NULL, response_body = NULL, created_at = now()
      WHERE i.created_at < now() - interval '24 hours'
         OR (i.state = 'running' AND i.created_at < now() - make_interval(mins => $5::int))
     RETURNING 1`,
    [deviceId, key, route, hash, RUNNING_STALE_MIN]);
  if (claimed) return { kind: 'claimed' };
  const row = await one<{ route: string; request_hash: string; state: string; status_code: number | null; response_body: unknown }>(
    `SELECT route, request_hash, state, status_code, response_body FROM driver_idempotency WHERE device_id = $1 AND key = $2`, [deviceId, key]);
  // Gone between the two statements (the first request failed and gave the key back): try once more.
  if (!row) return claimKey(deviceId, key, route, hash);
  if (row.route !== route || row.request_hash !== hash) return { kind: 'reused' };
  if (row.state !== 'done') return { kind: 'running' };
  return { kind: 'replay', status: row.status_code ?? 200, body: row.response_body };
}

export async function storeAnswer(deviceId: string, key: string, status: number, body: unknown): Promise<void> {
  await query(
    `UPDATE driver_idempotency SET state = 'done', status_code = $3, response_body = $4::jsonb WHERE device_id = $1 AND key = $2`,
    [deviceId, key, status, JSON.stringify(body ?? null)]);
}

export async function releaseKey(deviceId: string, key: string): Promise<void> {
  await query(`DELETE FROM driver_idempotency WHERE device_id = $1 AND key = $2 AND state = 'running'`, [deviceId, key]);
}

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

declare module 'fastify' {
  interface FastifyRequest {
    /** This request holds an Idempotency-Key claim: its answer is recorded (or the claim given back) in onSend. */
    idempotencyClaim?: { deviceId: string; key: string; route: string };
    /** The handler of a claimed request threw: its outcome is unknown, the claim is kept (see above). */
    idempotencyThrew?: boolean;
  }
}

/**
 * Wrap a route handler. The answer is recorded in the onSend hook (registerIdempotency), BEFORE it is written: a
 * retry can never find "running" for a request whose answer has already left. (Holding reply.send back inside the
 * wrapper does not work: a Fastify reply is a thenable that settles once sent, so awaiting a handler that returns it
 * would wait for itself.) A thrown error reaches onSend as Fastify's 500, and gives the key back like any 5xx.
 */
export function idempotent(h: Handler): Handler {
  return async (req, reply) => {
    const raw = req.headers['idempotency-key'];
    if (raw === undefined) return h(req, reply);
    const key = Array.isArray(raw) ? raw.join(',') : String(raw);
    if (!IDEMPOTENCY_KEY_RE.test(key)) {
      return reply.status(400).send({ error: 'Idempotency-Key harus 8–128 karakter A–Z, a–z, 0–9, _ atau -.', code: 'bad_idempotency_key' });
    }
    const deviceId = req.driver?.deviceId;
    if (!deviceId) return h(req, reply);
    const route = `${req.method} ${req.routeOptions.url ?? req.url.split('?')[0]}`;
    const c = await claimKey(deviceId, key, route, requestHash(req.body, req.params));
    if (c.kind === 'replay') {
      // The body exactly as first sent (already in the driver's language, legacy money names included): not
      // serialised again.
      return reply.header('Idempotent-Replayed', 'true').status(c.status).type('application/json; charset=utf-8').send(JSON.stringify(c.body));
    }
    if (c.kind === 'running') {
      return reply.status(409).send({ error: 'Permintaan yang sama masih diproses. Coba lagi sebentar lagi.', code: 'idempotency_in_progress' });
    }
    if (c.kind === 'reused') {
      return reply.status(422).send({ error: 'Idempotency-Key ini sudah dipakai untuk permintaan lain.', code: 'idempotency_key_reused' });
    }
    req.idempotencyClaim = { deviceId, key, route };
    return h(req, reply);
  };
}

/** The onSend hook that records a claimed request's answer (call once, where the routes are registered). */
export function registerIdempotency(app: FastifyInstance): void {
  app.addHook('onError', async (req) => {
    if (req.idempotencyClaim) req.idempotencyThrew = true;
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const c = req.idempotencyClaim;
    if (!c) return payload;
    req.idempotencyClaim = undefined;
    const status = reply.statusCode;
    if (req.idempotencyThrew) {
      logger.warn({ route: c.route }, 'idempotency: the request failed with its outcome unknown; the key stays claimed until it is stale');
      return payload;
    }
    let body: unknown = null;
    if (status < 500) {
      try {
        body = JSON.parse(typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : 'null');
      } catch {
        body = null;
      }
    }
    // The work is done: a failure to record it must not turn the answer into an error (the claim then stays
    // 'running', and a retry gets 409 until it is stale).
    await (status >= 500 ? releaseKey(c.deviceId, c.key) : storeAnswer(c.deviceId, c.key, status, body))
      .catch((err) => logger.error({ err: (err as Error).message, route: c.route }, 'idempotency: answer not recorded'));
    return payload;
  });
}
