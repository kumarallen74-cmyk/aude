import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { config, isRelaxedEnv } from '../config.js';
import { guardedLookup, isInternalHost } from '../services/net-guard.js';
import { authHeaderFor, type Party } from './mapping.js';
import { logMessage } from './store.js';

/**
 * Calls to a roaming partner.
 *
 * Partner URLs come from the partner (its versions and endpoint lists), so every
 * call goes through the same SSRF guard as webhooks: https only in production,
 * no private or internal addresses (checked when connecting, so DNS rebinding
 * is covered), and redirects are not followed.
 *
 * `timeoutMs` (default OCPI_REQUEST_TIMEOUT_MS; OCPI_REALTIME_AUTH_TIMEOUT_MS for
 * real-time authorisation) is a hard TOTAL deadline for the call — connect,
 * send, and the partner's whole answer. It used to be only the socket idle
 * timeout, which every byte resets: a partner trickling its answer held the
 * call (and a driver's authorisation, or the roaming outbox pass) for as long
 * as it liked.
 */

export interface OcpiCallResult {
  ok: boolean;
  httpStatus: number | null;
  ocpiStatus: number | null;
  data: any;
  headers: http.IncomingHttpHeaders;
  ms: number;
  error: string | null;
}

const MAX_DEADLINE_MS = 90_000;

export function partnerUrlProblem(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'not a valid URL'; }
  if (u.username || u.password) return 'the URL must not contain credentials';
  if (!isRelaxedEnv()) {
    if (u.protocol !== 'https:') return 'partner URLs must use https';
    if (isInternalHost(u.hostname)) return 'partner URLs must be publicly reachable';
  } else if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return 'partner URLs must be http(s)';
  }
  return null;
}

export async function ocpiCall(o: {
  orgId: string;
  partnerId: string | null;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  token: string;
  body?: unknown;
  from?: Pick<Party, 'country_code' | 'party_id'> | null;
  to?: { country_code: string | null; party_id: string | null } | null;
  timeoutMs?: number;
}): Promise<OcpiCallResult> {
  const started = Date.now();
  const done = (r: Omit<OcpiCallResult, 'ms'>): OcpiCallResult => {
    const res = { ...r, ms: Date.now() - started };
    void logMessage({
      orgId: o.orgId, partnerId: o.partnerId, direction: 'out', method: o.method, url: o.url,
      httpStatus: res.httpStatus, ocpiStatus: res.ocpiStatus, ms: res.ms, error: res.error,
    });
    return res;
  };

  const problem = partnerUrlProblem(o.url);
  if (problem) return done({ ok: false, httpStatus: null, ocpiStatus: null, data: null, headers: {}, error: problem });
  const u = new URL(o.url);
  const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
  const headers: Record<string, string> = {
    authorization: authHeaderFor(o.token),
    accept: 'application/json',
    'user-agent': 'PlugSure-OCPI/2.2.1',
    'x-request-id': randomUUID(),
    'x-correlation-id': randomUUID(),
  };
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  if (o.from) {
    headers['ocpi-from-country-code'] = o.from.country_code;
    headers['ocpi-from-party-id'] = o.from.party_id;
  }
  if (o.to?.country_code && o.to.party_id) {
    headers['ocpi-to-country-code'] = o.to.country_code;
    headers['ocpi-to-party-id'] = o.to.party_id;
  }
  // Capped below the roaming outbox lease (2 minutes): a call must end before its
  // row can be picked again by another pass.
  const timeout = Math.min(o.timeoutMs ?? config.ocpi.requestTimeoutMs, MAX_DEADLINE_MS);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: Omit<OcpiCallResult, 'ms'>) => { if (!settled) { settled = true; clearTimeout(deadline); resolve(done(r)); } };
    // Set when WE cut the call, so the result says why rather than "aborted".
    let cut: string | null = null;
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: o.method, headers, lookup: guardedLookup as any, timeout }, (res) => {
      const chunks: Buffer[] = [];
      let n = 0;
      res.on('data', (c: Buffer) => {
        n += c.length;
        if (n > 20 * 1024 * 1024) { res.destroy(new Error('response larger than 20 MB')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        const s = res.statusCode ?? 0;
        const ocpiStatus = json && typeof json.status_code === 'number' ? json.status_code : null;
        const ok = s >= 200 && s < 300 && (ocpiStatus == null || (ocpiStatus >= 1000 && ocpiStatus < 2000));
        finish({
          ok,
          httpStatus: s,
          ocpiStatus,
          data: json && 'data' in json ? json.data : json,
          headers: res.headers,
          error: ok ? null : (json?.status_message ? `${ocpiStatus ?? s}: ${json.status_message}` : `HTTP ${s}${ocpiStatus ? ` / OCPI ${ocpiStatus}` : ''}`),
        });
      });
      const aborted = (e?: Error) => finish({ ok: false, httpStatus: res.statusCode ?? null, ocpiStatus: null, data: null, headers: res.headers, error: (cut ?? e?.message ?? 'response aborted').slice(0, 300) });
      res.on('error', aborted);
      res.on('close', () => aborted());
    });
    const deadline = setTimeout(() => {
      cut = `no complete answer within ${Math.round(timeout / 100) / 10} s`;
      req.destroy(new Error(cut));
    }, timeout);
    req.on('timeout', () => req.destroy(new Error(`no answer within ${Math.round(timeout / 1000)} s`)));
    req.on('error', (e) => finish({ ok: false, httpStatus: null, ocpiStatus: null, data: null, headers: {}, error: (cut ?? e.message).slice(0, 300) }));
    req.end(payload);
  });
}
