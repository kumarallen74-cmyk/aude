import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { config } from '../config.js';
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

export function partnerUrlProblem(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'not a valid URL'; }
  if (u.username || u.password) return 'the URL must not contain credentials';
  if (config.env === 'production') {
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
  const timeout = o.timeoutMs ?? config.ocpi.requestTimeoutMs;

  return new Promise((resolve) => {
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
        resolve(done({
          ok,
          httpStatus: s,
          ocpiStatus,
          data: json && 'data' in json ? json.data : json,
          headers: res.headers,
          error: ok ? null : (json?.status_message ? `${ocpiStatus ?? s}: ${json.status_message}` : `HTTP ${s}${ocpiStatus ? ` / OCPI ${ocpiStatus}` : ''}`),
        }));
      });
      res.on('error', (e) => resolve(done({ ok: false, httpStatus: res.statusCode ?? null, ocpiStatus: null, data: null, headers: res.headers, error: e.message })));
    });
    req.on('timeout', () => req.destroy(new Error(`no answer within ${Math.round(timeout / 1000)} s`)));
    req.on('error', (e) => resolve(done({ ok: false, httpStatus: null, ocpiStatus: null, data: null, headers: {}, error: e.message.slice(0, 300) })));
    req.end(payload);
  });
}
