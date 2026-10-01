import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import https from 'node:https';
import http, { type IncomingMessage, type IncomingHttpHeaders } from 'node:http';
import { config, isRelaxedEnv } from '../config.js';

/**
 * SSRF guard for server-side requests to operator-supplied URLs (webhooks,
 * firmware checksum verification, payment / OTP / alert providers, roaming
 * partners).
 *
 * In production the resolved address is checked at CONNECT time (no private,
 * loopback, link-local, CGNAT, benchmark or multicast addresses), so a DNS
 * rebind between a save-time check and the request cannot reach the internal
 * network or the cloud metadata endpoint. Development and test keep local
 * receivers working.
 */

export const enforcing = () => !isRelaxedEnv();

/** The eight 16-bit groups of an IPv6 address (a dotted IPv4 tail is folded in), or null. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct); // zone id (fe80::1%eth0)
  // A dotted IPv4 tail (::ffff:1.2.3.4, ::1.2.3.4, 64:ff9b::1.2.3.4) becomes two groups.
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (dotted) {
    const o = dotted.slice(1).map(Number) as [number, number, number, number];
    if (o.some((x) => x > 255)) return null;
    s = s.slice(0, dotted.index) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (h: string) => (h ? h.split(':') : []);
  const head = part(halves[0]!);
  const tail = halves.length === 2 ? part(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill('0'), ...tail];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

/** Two 16-bit groups as a dotted IPv4 address. */
const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b, c] = ip.split('.').map(Number) as [number, number, number];
    return a === 0 /* "this network" 0.0.0.0/8 */ || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) /* CGNAT 100.64.0.0/10 */ || (a === 169 && b === 254) /* link-local, cloud metadata */ ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) /* IETF protocol assignments 192.0.0.0/24 */ ||
      (a === 198 && (b === 18 || b === 19)) /* benchmarking 198.18.0.0/15 */ ||
      a >= 224 /* multicast 224.0.0.0/4 and reserved 240.0.0.0/4 */;
  }
  if (v === 6 || ip.includes(':')) {
    const g = ipv6Groups(ip);
    if (!g) return true; // unparseable: refuse
    const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
    const zero4 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0;
    // Forms that carry an IPv4 address the packet ends up at: judge that address.
    //   ::a.b.c.d (IPv4-compatible, deprecated; also covers :: and ::1, which map to 0.0.0.x)
    //   ::ffff:a.b.c.d (IPv4-mapped)   ::ffff:0:a.b.c.d (IPv4-translated)
    //   64:ff9b::a.b.c.d (NAT64 well-known prefix)
    if (zero4 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) return isPrivateAddress(v4Of(g6, g7));
    if (zero4 && g4 === 0xffff && g5 === 0) return isPrivateAddress(v4Of(g6, g7));
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateAddress(v4Of(g6, g7));
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true; // 64:ff9b:1::/48, local-use NAT64
    // 6to4 2002:AABB:CCDD::/48 — the relay delivers to the embedded IPv4 AA.BB.CC.DD.
    if (g0 === 0x2002) return isPrivateAddress(v4Of(g1, g2));
    // Teredo 2001:0::/32 tunnels to an (obfuscated) IPv4: refuse outright.
    if (g0 === 0x2001 && g1 === 0) return true;
    if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
    if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // 100::/64 discard-only
    return (g0 & 0xfe00) === 0xfc00 /* unique local fc00::/7 */ ||
      (g0 & 0xffc0) === 0xfe80 /* link-local fe80::/10 */ ||
      (g0 & 0xffc0) === 0xfec0 /* site-local fec0::/10 (deprecated, still routed internally) */ ||
      (g0 & 0xff00) === 0xff00 /* multicast */;
  }
  // Not an address at all: refuse.
  return true;
}

/** A host name that must never be requested from the server, before DNS is consulted. */
export function isInternalHost(hostname: string): boolean {
  // (A trailing dot is the same name, fully qualified: "localhost." must not slip through.)
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
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

/** Why a URL may not be requested by the server (http allowed only in development/test), or null. */
export function refuseOutboundUrl(u: URL): string | null {
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'only http(s) URLs are allowed';
  if (u.username || u.password) return 'the URL must not contain credentials';
  if (enforcing() && u.protocol !== 'https:') return 'only https URLs are allowed';
  // Checked before connecting too: Node does not call `lookup` for an IP literal.
  if (enforcing() && isInternalHost(u.hostname)) return 'the URL must be publicly reachable (no private, loopback or internal addresses)';
  return null;
}

export interface GuardedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  /** The body as text, at most `maxBytes`. Server-side use only: never echo it to an operator. */
  text: string;
}

/**
 * A fetch for tenant-configured URLs (payment, OTP and alert providers, test
 * calls). Unlike the global fetch:
 *
 *  - the resolved address is checked at CONNECT time through `guardedLookup`
 *    (DNS-rebinding safe), and IP literals before connecting;
 *  - redirects are NOT followed (a 3xx is returned as is), so a public URL
 *    cannot bounce the server to an internal one;
 *  - `timeoutMs` is a hard TOTAL deadline — connect, send and read the whole
 *    answer — not a socket-idle timeout a trickling server can keep resetting;
 *  - the answer is capped at `maxBytes`.
 *
 * Rejects with a short message (no response body) when the request cannot be
 * made or completed.
 */
export function guardedFetch(
  raw: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<GuardedResponse> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(raw); } catch { return reject(new Error('invalid URL')); }
    const why = refuseOutboundUrl(u);
    if (why) return reject(new Error(why));
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
      headers['content-length'] = String(Buffer.byteLength(opts.body));
    }
    const mod = u.protocol === 'https:' ? https : http;
    let settled = false;
    // Why WE cut the request (deadline, size, abort): reported in preference to the socket's own "aborted".
    let cut: Error | null = null;
    const stop = (e: Error) => { cut ??= e; req.destroy(e); };
    const fail = (e: Error) => finish(() => reject(new Error((cut ?? e).message.slice(0, 200))));
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(deadline); opts.signal?.removeEventListener('abort', onAbort); fn(); } };
    const req = mod.request(u, { method: opts.method ?? 'GET', headers, lookup: guardedLookup as any }, (res) => {
      const chunks: Buffer[] = [];
      let n = 0;
      res.on('data', (c: Buffer) => {
        n += c.length;
        if (n > maxBytes) { stop(new Error(`answer larger than ${Math.round(maxBytes / 1024)} KB`)); return; }
        chunks.push(c);
      });
      res.on('end', () => finish(() => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') })));
      res.on('error', fail);
      res.on('close', () => fail(new Error('connection closed before the answer was complete')));
    });
    const deadline = setTimeout(() => stop(new Error(`no complete answer within ${Math.round(timeoutMs / 100) / 10} s`)), timeoutMs);
    const onAbort = () => stop(new Error('aborted'));
    if (opts.signal?.aborted) onAbort(); else opts.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', fail);
    req.end(opts.body);
  });
}
