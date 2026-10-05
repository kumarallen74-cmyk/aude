import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { query } from '../db/pool.js';
import { bus } from '../services/events.js';
import * as registry from './registry.js';
import { workerHealthReport } from '../services/worker-health.js';

/**
 * API <-> gateway bridge for the SPLIT deployment.
 *
 * The documented production topology (docker-compose, the two systemd units)
 * runs the OCPP gateway and the API as SEPARATE processes. The charger sockets,
 * the connection registry and the in-process event bus all live in the gateway.
 * The API — which serves the operator console — therefore had:
 *
 *   · an empty registry: every remote command failed "charge point is not
 *     connected", and every charger rendered as offline;
 *   · a silent event bus: the console's live stream never received a single
 *     status change, and the driver app saw every station as offline.
 *
 * The Redis transport the comments promised was never built. This is the minimal
 * dependency-free replacement:
 *
 *   commands  API --HTTP POST /internal/call-->  gateway --> charger
 *   liveness  API --HTTP GET  /internal/connections--> gateway   (polled, mirrored)
 *   events    gateway --pg_notify('plugsure_events')--> API LISTEN --> SSE only
 *
 * Every piece is inert unless INTERNAL_API_TOKEN is set, so the all-in-one
 * process (and any v1.2.1 deployment that has not opted in) is unchanged.
 */

const CHANNEL = 'plugsure_events';
/** pg_notify payloads are capped at 8000 bytes. Stay well under. */
const MAX_NOTIFY_BYTES = 7_000;

function tokenOk(given: unknown): boolean {
  const want = config.bridge.token;
  if (!want || typeof given !== 'string' || !given) return false;
  // Compare digests so the comparison is constant-time regardless of length.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(want).digest();
  return timingSafeEqual(a, b);
}

type SandboxHandler = (identity: string, event: string, args: Record<string, unknown>) => Promise<unknown>;
let sandboxHandler: SandboxHandler | null = null;
/** The gateway registers the sandbox's virtual fleet here (identity '*' + event 'sync' re-reads the fleet). */
export function setSandboxHandler(h: SandboxHandler): void {
  sandboxHandler = h;
}

function readJson(req: IncomingMessage, send: (status: number, body: unknown) => void, then: (body: Record<string, unknown>) => Promise<void>) {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk: string) => {
    raw += chunk;
    if (raw.length > 64 * 1024) req.destroy();
  });
  req.on('end', () => {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      send(400, { ok: false, error: 'invalid JSON' });
      return;
    }
    void then(body).catch((e) => send(500, { ok: false, error: (e as Error).message }));
  });
}

/**
 * Sandbox operations from the API: in the gateway through the bridge, or here
 * in a single-process deployment. Rejects with an error carrying `status`.
 */
export async function sandboxCall<T = any>(identity: string, event: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!bridgeEnabledOnApi()) {
    const fleet = await import('../sandbox/fleet.js');
    if (identity === '*' && event === 'sync') return (await fleet.syncVirtualFleet()) as T;
    return (await fleet.simulate(identity, event as never, args)) as T;
  }
  let res: Response;
  try {
    res = await fetch(`${config.bridge.gatewayUrl}/internal/sandbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': config.bridge.token },
      body: JSON.stringify({ identity, event, args }),
      signal: AbortSignal.timeout(config.bridge.callTimeoutMs),
    });
  } catch (e) {
    throw Object.assign(new Error(`gateway unreachable: ${(e as Error).message}`), { status: 502 });
  }
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; error?: string };
  if (!res.ok || !body.ok) throw Object.assign(new Error(body.error ?? `gateway answered HTTP ${res.status}`), { status: res.status === 404 ? 503 : res.status });
  return body.result as T;
}

export function bridgeEnabledOnApi(): boolean {
  return Boolean(config.bridge.gatewayUrl && config.bridge.token);
}

// ============================================================ gateway side

/**
 * Handle `/internal/*` on the gateway's HTTP listener. Returns true when the
 * request was consumed. Answers 404 — not 401 — when the bridge is not
 * configured or the token is wrong, so the endpoint's existence is not
 * advertised to whatever can reach the gateway port.
 */
export function handleInternalRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url ?? '';
  if (!url.startsWith('/internal/')) return false;

  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (!tokenOk(req.headers['x-internal-token'])) {
    send(404, { error: 'not found' });
    return true;
  }

  if (req.method === 'GET' && url === '/internal/connections') {
    send(
      200,
      registry.all().map((r) => ({
        ocppIdentity: r.ocppIdentity,
        version: r.version,
        connectedAt: r.connectedAt.toISOString(),
      })),
    );
    return true;
  }

  // Background workers' health (they run here), for the API's platform health route.
  if (req.method === 'GET' && url === '/internal/workers') {
    send(200, workerHealthReport());
    return true;
  }

  if (req.method === 'POST' && url === '/internal/sandbox') {
    readJson(req, send, async (body) => {
      if (!sandboxHandler) return send(404, { ok: false, error: 'sandbox is not running in this process' });
      try {
        send(200, { ok: true, result: await sandboxHandler(String(body.identity ?? ''), String(body.event ?? ''), (body.args ?? {}) as Record<string, unknown>) });
      } catch (e) {
        send(Number((e as { status?: number }).status) || 502, { ok: false, error: (e as Error).message });
      }
    });
    return true;
  }

  if (req.method === 'POST' && url === '/internal/call') {
    let raw = '';
    let tooBig = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
      if (raw.length > 512 * 1024) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      void (async () => {
        let body: { identity?: string; action?: string; payload?: unknown; priority?: number };
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          send(400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const identity = String(body.identity ?? '');
        const action = String(body.action ?? '');
        if (!identity || !/^[A-Za-z][A-Za-z0-9]{1,63}$/.test(action)) {
          send(400, { ok: false, error: 'identity and action are required' });
          return;
        }
        const conn = registry.get(identity);
        if (!conn) {
          send(409, { ok: false, error: `charge point ${identity} is not connected` });
          return;
        }
        try {
          const result = await conn.rpc.call(action, body.payload ?? {}, body.priority === 1 ? 1 : 0);
          send(200, { ok: true, result, version: conn.version });
        } catch (e) {
          send(502, { ok: false, error: (e as Error).message });
        }
      })();
    });
    return true;
  }

  send(404, { error: 'not found' });
  return true;
}

/**
 * Publish every bus event to Postgres so an API process can relay it to the
 * console. Oversized payloads (a large OCPP frame) are trimmed, never dropped
 * silently — the console still learns that something happened.
 */
export function startEventRelay(): () => void {
  if (!config.bridge.relayEvents) return () => {};
  logger.info('event relay on: bus events are published to Postgres NOTIFY for the API process');
  return bus.onAny((e) => {
    let text = JSON.stringify(e);
    if (Buffer.byteLength(text) > MAX_NOTIFY_BYTES) {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      text = JSON.stringify({
        kind: e.kind,
        payload: { ...p, payload: '[payload too large to relay — see the frame log]', truncated: true },
      });
      if (Buffer.byteLength(text) > MAX_NOTIFY_BYTES) return;
    }
    void query(`SELECT pg_notify($1, $2)`, [CHANNEL, text]).catch((err) =>
      logger.debug({ err: (err as Error).message }, 'event relay notify failed'),
    );
  });
}

// ============================================================ API side

/** Issue an OCPP CALL through the gateway. Rejects exactly like a local call would. */
export async function bridgeCall<T = any>(
  identity: string,
  action: string,
  payload: unknown,
  priority: 0 | 1,
): Promise<T> {
  if (!bridgeEnabledOnApi()) throw new Error(`charge point ${identity} is not connected`);
  let res: Response;
  try {
    res = await fetch(`${config.bridge.gatewayUrl}/internal/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': config.bridge.token },
      body: JSON.stringify({ identity, action, payload, priority }),
      signal: AbortSignal.timeout(config.bridge.callTimeoutMs),
    });
  } catch (e) {
    throw new Error(`gateway unreachable: ${(e as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; error?: string };
  if (!res.ok || !body.ok) throw new Error(body.error ?? `gateway answered HTTP ${res.status}`);
  return body.result as T;
}

let listenClient: pg.Client | null = null;
let pollTimer: NodeJS.Timeout | null = null;

/** Start mirroring the gateway's connections and relaying its events. API process only. */
export async function startBridgeClient(): Promise<() => Promise<void>> {
  if (!bridgeEnabledOnApi()) {
    if (config.bridge.gatewayUrl && !config.bridge.token) {
      logger.warn('GATEWAY_INTERNAL_URL is set but INTERNAL_API_TOKEN is not — the API bridge is disabled');
    }
    return async () => {};
  }

  const poll = async () => {
    try {
      const res = await fetch(`${config.bridge.gatewayUrl}/internal/connections`, {
        headers: { 'x-internal-token': config.bridge.token },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      registry.setRemoteSnapshot((await res.json()) as registry.RemoteConnection[]);
    } catch (e) {
      logger.debug({ err: (e as Error).message }, 'gateway connection poll failed');
    }
  };
  await poll();
  pollTimer = setInterval(() => void poll(), 3_000);

  const connectListener = async () => {
    try {
      const c = new pg.Client({ connectionString: config.databaseUrl });
      c.on('error', (err) => {
        logger.warn({ err: err.message }, 'event relay listener lost its connection — reconnecting');
        listenClient = null;
        setTimeout(() => void connectListener(), 5_000);
      });
      c.on('notification', (n) => {
        if (n.channel !== CHANNEL || !n.payload) return;
        try {
          const e = JSON.parse(n.payload) as { kind: string; payload: unknown };
          if (typeof e?.kind === 'string') bus.emitRelayed(e.kind, e.payload);
        } catch {
          /* malformed payload; ignore */
        }
      });
      await c.connect();
      await c.query(`LISTEN ${CHANNEL}`);
      listenClient = c;
      logger.info({ gateway: config.bridge.gatewayUrl }, 'API bridge engaged: commands, liveness and events route through the gateway');
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'could not LISTEN for relayed events — retrying');
      setTimeout(() => void connectListener(), 5_000);
    }
  };
  await connectListener();

  return async () => {
    if (pollTimer) clearInterval(pollTimer);
    await listenClient?.end().catch(() => {});
  };
}
