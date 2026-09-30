import { createECDH, createHmac, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { one, query } from '../db/pool.js';
import { config } from '../config.js';
import { seal, unseal } from './secrets.js';
import { guardedLookup } from './net-guard.js';

/**
 * Web Push, without a third-party library.
 *
 *   RFC 8291  message encryption (aes128gcm, ECDH P-256 + HKDF)
 *   RFC 8292  VAPID: the push service learns who sends, via an ES256 JWT
 *
 * The browser hands the app a subscription (an endpoint URL at its push service,
 * plus the phone's public key and an auth secret). Only the phone can read the
 * payload; the push service just relays it.
 */

const b64u = (b: Buffer) => b.toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');
const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

// ─────────────────────────────────────────────── VAPID key pair

export interface Vapid { publicKey: string; privateKey: KeyObject }
let cached: Vapid | null = null;

function fromJwk(d: string, x: string, y: string): KeyObject {
  return createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d, x, y }, format: 'jwk' });
}

/** Uncompressed P-256 public point (65 bytes) of a key, base64url. */
function publicRaw(k: KeyObject): string {
  const jwk = createPublicKey(k).export({ format: 'jwk' }) as { x: string; y: string };
  return b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));
}

/**
 * The platform's VAPID key pair: from the environment when set, otherwise
 * generated once and kept in platform_setting (private half sealed), so the
 * API (which hands the public key to phones) and the gateway (which signs) agree.
 */
export async function vapid(): Promise<Vapid> {
  if (cached) return cached;
  if (config.driverApp.vapidPublicKey && config.driverApp.vapidPrivateKey) {
    const pub = unb64u(config.driverApp.vapidPublicKey);
    const key = fromJwk(config.driverApp.vapidPrivateKey, b64u(pub.subarray(1, 33)), b64u(pub.subarray(33, 65)));
    cached = { publicKey: config.driverApp.vapidPublicKey, privateKey: key };
    return cached;
  }
  let row = await one<{ value: { publicKey: string; privateJwk: string } }>(`SELECT value FROM platform_setting WHERE key = 'vapid'`);
  if (!row) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
    const value = { publicKey: publicRaw(privateKey), privateJwk: seal(JSON.stringify({ d: jwk.d, x: jwk.x, y: jwk.y })) };
    await query(`INSERT INTO platform_setting (key, value) VALUES ('vapid', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(value)]);
    row = await one(`SELECT value FROM platform_setting WHERE key = 'vapid'`);
  }
  const j = JSON.parse(unseal(row!.value.privateJwk)) as { d: string; x: string; y: string };
  cached = { publicKey: row!.value.publicKey, privateKey: fromJwk(j.d, j.x, j.y) };
  return cached;
}

/** RFC 8292 Authorization header for one push service origin. */
export function vapidAuthorization(v: Vapid, endpoint: string, subject = config.driverApp.vapidSubject, now = Date.now()): string {
  const aud = new URL(endpoint).origin;
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const sig = createSign('SHA256').update(`${head}.${body}`).sign({ key: v.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${v.publicKey}`;
}

// ─────────────────────────────────────────────── RFC 8291 encryption

const RECORD_SIZE = 4096;

function derive(authSecret: Buffer, ecdhSecret: Buffer, uaPublic: Buffer, asPublic: Buffer, salt: Buffer) {
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  return { cek, nonce };
}

/**
 * Encrypt a payload for one subscription. `asPrivate` and `salt` exist only so
 * tests can reproduce a known result; in use both are fresh for every message.
 */
export function encryptPayload(payload: Buffer, p256dh: string, auth: string, opts: { asPrivate?: Buffer; salt?: Buffer } = {}): Buffer {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh must be an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('auth must be 16 bytes');
  if (payload.length > RECORD_SIZE - 17 - 86) throw new Error('payload too large for one push message');
  const ecdh = createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = opts.salt ?? randomBytes(16);
  const { cek, nonce } = derive(authSecret, ecdh.computeSecret(uaPublic), uaPublic, asPublic, salt);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // One record: the payload followed by the last-record delimiter (0x02), no padding.
  const ct = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ct]);
}

/** The phone's side (for tests): decrypt with the subscription's private key. */
export function decryptPayload(body: Buffer, uaPrivate: Buffer, auth: string): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const { cek, nonce } = derive(unb64u(auth), ecdh.computeSecret(asPublic), ecdh.getPublicKey(), asPublic, salt);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  if (plain[plain.length - 1] !== 2) throw new Error('missing last-record delimiter');
  return plain.subarray(0, plain.length - 1);
}

// ─────────────────────────────────────────────── delivery

/**
 * Why the server may not send to this endpoint, or null. Endpoints come from
 * the phone, so in production only known push services are allowed (and the
 * connect-time address guard applies as for webhooks).
 */
export function endpointProblem(endpoint: string): string | null {
  let u: URL;
  try { u = new URL(endpoint); } catch { return 'not a URL'; }
  if (config.env !== 'production') return u.protocol === 'https:' || u.protocol === 'http:' ? null : 'must be http(s)';
  if (u.protocol !== 'https:') return 'push endpoints must be https';
  const host = u.hostname.toLowerCase();
  if (!config.driverApp.pushHosts.some((h) => host === h || host.endsWith(`.${h}`))) return `${host} is not a known push service`;
  return null;
}

export interface PushResult { status: number | null; error: string | null }

export async function sendPush(sub: { endpoint: string; p256dh: string; auth: string }, payload: unknown, opts: { ttlS?: number; urgency?: 'normal' | 'high' | 'low'; topic?: string } = {}): Promise<PushResult> {
  const problem = endpointProblem(sub.endpoint);
  if (problem) return { status: null, error: problem };
  const v = await vapid();
  const body = encryptPayload(Buffer.from(JSON.stringify(payload)), sub.p256dh, sub.auth);
  const u = new URL(sub.endpoint);
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'content-encoding': 'aes128gcm',
    'content-length': String(body.length),
    ttl: String(opts.ttlS ?? 3600),
    urgency: opts.urgency ?? 'normal',
    authorization: vapidAuthorization(v, sub.endpoint),
    ...(opts.topic ? { topic: opts.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
  };
  return new Promise((resolve) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'POST', headers, lookup: guardedLookup as any, timeout: 10_000 }, (res) => {
      res.resume();
      res.on('end', () => {
        const s = res.statusCode ?? 0;
        resolve({ status: s, error: s >= 200 && s < 300 ? null : `HTTP ${s}` });
      });
    });
    req.on('timeout', () => req.destroy(new Error('push service did not answer in 10 s')));
    req.on('error', (e) => resolve({ status: null, error: e.message.slice(0, 200) }));
    req.end(body);
  });
}
