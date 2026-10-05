import { createHash } from 'node:crypto';
import { query } from '../db/pool.js';

/**
 * The hub's routing log (hub_message, design §5.10): one `in` row per inbound request and one `out` row per
 * forwarded leg, sharing the correlation id. No bodies, unless a platform admin turned capture on for the
 * connection (capture_bodies_until, at most 72 h); captured bodies are redacted. Never for credentials.
 */

const sha8 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);
export const mask = (s: string) => (s.length <= 4 ? `…(${sha8(s)})` : `${s.slice(0, 4)}…(${sha8(s)})`);

/**
 * Token uids in paths are masked: /tokens/{cc}/{pid}/{uid} and /tokens/{uid}/authorize.
 * The query string is dropped (it carries the hub cursor and filters only).
 */
export function redactPath(path: string): string {
  const p = path.split('?')[0]!;
  return p
    .replace(/(\/tokens\/[A-Za-z]{2}\/[A-Za-z0-9]{3}\/)([^/?]+)/, (_m, a: string, uid: string) => a + mask(decodeURIComponentSafe(uid)))
    .replace(/(\/tokens\/)([^/?]+)(\/authorize)/, (_m, a: string, uid: string, b: string) => a + mask(decodeURIComponentSafe(uid)) + b)
    .slice(0, 1000);
}

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

const SECRET_KEYS = new Set(['uid', 'contract_id', 'visual_number', 'auth_id', 'name', 'email', 'token', 'response_url']);

/** A body with personal and secret fields masked (any depth). */
export function redactBody(body: unknown, depth = 0): unknown {
  if (depth > 8 || body == null) return body;
  if (Array.isArray(body)) return body.slice(0, 50).map((x) => redactBody(x, depth + 1));
  if (typeof body !== 'object') return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.has(k) && (typeof v === 'string' || typeof v === 'number') ? mask(String(v)) : redactBody(v, depth + 1);
  }
  return out;
}

export interface HubLogEntry {
  correlationId: string;
  requestIdIn?: string | null;
  requestIdOut?: string | null;
  leg: 'in' | 'out';
  connectionId?: string | null;
  from?: string | null;
  to?: string | null;
  route: string;
  module?: string | null;
  method: string;
  path: string;
  httpStatus?: number | null;
  ocpiStatus?: number | null;
  ms?: number | null;
  bytes?: number | null;
  error?: string | null;
  /** Logged only while capture is on for the connection (the caller decides); redacted here. */
  body?: unknown;
}

export async function logHub(e: HubLogEntry): Promise<void> {
  await query(
    `INSERT INTO hub_message (correlation_id, request_id_in, request_id_out, leg, connection_id, from_party, to_party, route,
                              module, method, path, http_status, ocpi_status, duration_ms, bytes, error, body_redacted)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [e.correlationId.slice(0, 100), e.requestIdIn ?? null, e.requestIdOut ?? null, e.leg, e.connectionId ?? null, e.from ?? null, e.to ?? null,
      e.route.slice(0, 40), e.module ?? null, e.method, redactPath(e.path), e.httpStatus ?? null, e.ocpiStatus ?? null,
      e.ms == null ? null : Math.round(e.ms), e.bytes ?? null, e.error?.slice(0, 500) ?? null,
      e.body === undefined || e.module === 'credentials' ? null : JSON.stringify(redactBody(e.body))],
  ).catch(() => {});
}
