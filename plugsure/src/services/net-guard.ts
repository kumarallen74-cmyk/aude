import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { config, isRelaxedEnv } from '../config.js';

/**
 * SSRF guard for server-side requests to operator-supplied URLs (webhooks,
 * firmware checksum verification).
 *
 * In production the resolved address is checked at CONNECT time (no private,
 * loopback, link-local, CGNAT, benchmark or multicast addresses), so a DNS
 * rebind between a save-time check and the request cannot reach the internal
 * network or the cloud metadata endpoint. Development and test keep local
 * receivers working.
 */

export const enforcing = () => !isRelaxedEnv();

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s.startsWith('::ffff:')) return isPrivateAddress(s.slice(7));
    return s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') || s.startsWith('ff');
  }
  // Not an address at all (e.g. the hex tail of an IPv4-mapped literal): refuse.
  return true;
}

/** A host name that must never be requested from the server, before DNS is consulted. */
export function isInternalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || (isIP(host) !== 0 && isPrivateAddress(host));
}

/** DNS lookup that refuses private addresses while enforcing — pass as the request's `lookup`. */
export function guardedLookup(hostname: string, options: any, cb: (...a: any[]) => void) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return cb(err);
    const list = Array.isArray(addresses) ? addresses : [addresses];
    if (enforcing() && list.some((a) => isPrivateAddress(a.address))) {
      return cb(Object.assign(new Error(`refused: ${hostname} resolves to a private address`), { code: 'EPRIVATE' }));
    }
    if (options?.all) return cb(null, list);
    const first = list[0]!;
    cb(null, first.address, first.family);
  });
}

/**
 * Why an https URL may not be fetched by the server, or null when it may.
 * Checked again on every redirect hop.
 */
export function refuseHttpsUrl(u: URL): string | null {
  if (u.protocol !== 'https:') return 'only https URLs are allowed';
  if (u.username || u.password) return 'the URL must not contain credentials';
  if (enforcing() && isInternalHost(u.hostname)) return 'the URL must be publicly reachable (no private, loopback or internal addresses)';
  return null;
}

/**
 * GET an https URL through the guard. Redirects are followed (firmware is
 * commonly served from a CDN or object-store link) up to `maxRedirects`, and
 * each hop is re-checked, so a public URL cannot bounce the server to an
 * internal one. Resolves with the final 2xx/other response; the caller reads
 * or discards its body.
 */
export function guardedHttpsGet(
  raw: string,
  opts: { maxRedirects?: number; idleTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<IncomingMessage> {
  const maxRedirects = opts.maxRedirects ?? 3;
  const idle = opts.idleTimeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const hop = (url: string, left: number) => {
      let u: URL;
      try { u = new URL(url); } catch { return reject(new Error('invalid URL')); }
      const why = refuseHttpsUrl(u);
      if (why) return reject(new Error(why));
      const req = https.get(u, { lookup: guardedLookup as any, signal: opts.signal, headers: { 'user-agent': 'PlugSure-Firmware/1.3' } }, (res) => {
        const s = res.statusCode ?? 0;
        if (s >= 300 && s < 400 && res.headers.location) {
          res.resume();
          if (left <= 0) return reject(new Error('too many redirects'));
          let next: string;
          try { next = new URL(res.headers.location, u).toString(); } catch { return reject(new Error('invalid redirect')); }
          return hop(next, left - 1);
        }
        resolve(res);
      });
      req.setTimeout(idle, () => req.destroy(new Error(`no response for ${Math.round(idle / 1000)}s`)));
      req.on('error', reject);
    };
    hop(raw, maxRedirects);
  });
}
