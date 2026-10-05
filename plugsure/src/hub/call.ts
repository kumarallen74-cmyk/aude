import { randomUUID } from 'node:crypto';
import { unseal } from '../services/secrets.js';
import { authHeaderFor } from '../ocpi/mapping.js';
import { partnerUrlProblem, requestOcpi } from '../ocpi/client.js';
import { isInprocUrl } from './transport.js';
import { logHub } from './log.js';
import { aadOut } from './registry.js';
import type { HubConnection } from './types.js';

/**
 * One outbound leg from the hub to a member (forwarded requests, broadcasts, callbacks, ClientInfo, alive
 * checks): the member's token, a NEW X-Request-ID, the given X-Correlation-ID, the routing headers, and
 * nothing else from the inbound request (design §5.4). In-process for internal members (D5); over HTTPS
 * through the SSRF guard otherwise. Every leg is logged (hub_message, leg 'out').
 */

export interface HubCallResult {
  httpStatus: number | null;
  ocpiStatus: number | null;
  json: any;
  headers: Record<string, string | string[] | undefined>;
  error: string | null;
  failure: 'timeout' | 'connection' | 'policy' | null;
  ok: boolean;
  ms: number;
  inproc: boolean;
  requestId: string;
}

type PartyRef = { country_code: string; party_id: string } | null | undefined;

export function memberToken(conn: HubConnection): string | null {
  if (!conn.token_out) return null;
  try { return unseal(conn.token_out, aadOut(conn.id)); } catch { return null; }
}

export async function hubCall(o: {
  conn: HubConnection;
  method: string;
  url: string;
  body?: unknown;
  from?: PartyRef;
  to?: PartyRef;
  correlationId: string;
  requestIdIn?: string | null;
  timeoutMs: number;
  route: string;
  module?: string | null;
  /** Log the (redacted) body: capture is on for this connection. */
  capture?: boolean;
}): Promise<HubCallResult> {
  const started = Date.now();
  const requestId = randomUUID();
  const inproc = isInprocUrl(o.url);
  const lbl = (p: PartyRef) => (p ? `${p.country_code}*${p.party_id}` : null);
  const finish = (r: Omit<HubCallResult, 'ms' | 'requestId' | 'inproc'>): HubCallResult => {
    const res = { ...r, ms: Date.now() - started, requestId, inproc };
    void logHub({
      correlationId: o.correlationId, requestIdIn: o.requestIdIn ?? null, requestIdOut: requestId, leg: 'out', connectionId: o.conn.id,
      from: lbl(o.from), to: lbl(o.to), route: inproc ? `${o.route}+inproc` : o.route, module: o.module ?? null, method: o.method,
      path: safePath(o.url), httpStatus: res.httpStatus, ocpiStatus: res.ocpiStatus, ms: res.ms, error: res.error,
      ...(o.capture && o.body !== undefined ? { body: o.body } : {}),
    });
    return res;
  };
  if (!inproc) {
    const problem = partnerUrlProblem(o.url);
    if (problem) return finish({ httpStatus: null, ocpiStatus: null, json: null, headers: {}, error: `member URL refused: ${problem}`, failure: 'policy', ok: false });
  }
  const token = memberToken(o.conn);
  if (!token) return finish({ httpStatus: null, ocpiStatus: null, json: null, headers: {}, error: 'no credentials token for this member (not registered, or SECRETS_KEY changed)', failure: 'connection', ok: false });
  const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
  const headers: Record<string, string> = {
    authorization: authHeaderFor(token),
    accept: 'application/json',
    'user-agent': 'PlugSure-Hub/2.2.1',
    'x-request-id': requestId,
    'x-correlation-id': o.correlationId,
  };
  if (payload !== undefined) headers['content-type'] = 'application/json';
  if (o.from) { headers['ocpi-from-country-code'] = o.from.country_code; headers['ocpi-from-party-id'] = o.from.party_id; }
  if (o.to) { headers['ocpi-to-country-code'] = o.to.country_code; headers['ocpi-to-party-id'] = o.to.party_id; }
  const r = await requestOcpi({ method: o.method, url: o.url, headers, payload, timeoutMs: o.timeoutMs });
  if (r.httpStatus == null || r.error) {
    return finish({ httpStatus: r.httpStatus, ocpiStatus: null, json: null, headers: r.headers as HubCallResult['headers'], error: r.error ?? 'no answer', failure: r.failure ?? 'connection', ok: false });
  }
  const ocpiStatus = r.json && typeof r.json.status_code === 'number' ? r.json.status_code : null;
  const ok = r.httpStatus >= 200 && r.httpStatus < 300 && (ocpiStatus == null || (ocpiStatus >= 1000 && ocpiStatus < 2000));
  return finish({
    httpStatus: r.httpStatus, ocpiStatus, json: r.json, headers: r.headers as HubCallResult['headers'],
    error: ok ? null : (r.json?.status_message ? `${ocpiStatus ?? r.httpStatus}: ${String(r.json.status_message).slice(0, 300)}` : `HTTP ${r.httpStatus}${ocpiStatus ? ` / OCPI ${ocpiStatus}` : ''}`),
    failure: null, ok,
  });
}

function safePath(url: string): string {
  try { const u = new URL(url); return u.pathname; } catch { return url.slice(0, 200); }
}
