import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { config, isRelaxedEnv } from '../config.js';

/**
 * Apple Push Notification service (APNs) — the provider API over HTTP/2 with
 * token-based authentication, and no library: an ES256 JWT signed with the
 * operator's .p8 key identifies the sender; the device token and the app's
 * bundle id (the "topic") say where the notification goes.
 *
 *   production   api.push.apple.com          TestFlight and App Store builds
 *   development  api.sandbox.push.apple.com  builds run from Xcode
 *
 * A device token belongs to one environment. When production says
 * BadDeviceToken the development server is tried once; the environment that
 * accepts it is remembered on the subscription.
 *
 * APNS_URL_PRODUCTION / APNS_URL_DEVELOPMENT override the hosts (tests use a
 * local server, plain HTTP/2, which is refused in production).
 */

export type ApnsEnv = 'production' | 'development';

const HOSTS: Record<ApnsEnv, string> = {
  production: 'https://api.push.apple.com',
  development: 'https://api.sandbox.push.apple.com',
};

export function apnsOrigin(env: ApnsEnv): string {
  const override = env === 'production' ? process.env.APNS_URL_PRODUCTION : process.env.APNS_URL_DEVELOPMENT;
  if (override) {
    if (!override.startsWith('https://') && !isRelaxedEnv()) throw new Error('APNS_URL_* must be https:// in production');
    return override.replace(/\/+$/, '');
  }
  return HOSTS[env];
}

export interface ApnsCredentials {
  teamId: string;
  keyId: string;
  /** The .p8 file's text (PEM, PKCS#8, P-256). */
  p8: string;
  /** The app's bundle id. */
  topic: string;
}

/** Why a .p8 cannot be used, or null. */
export function p8Problem(pem: string): string | null {
  const text = String(pem ?? '').trim();
  if (!/^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----$/.test(text)) return 'Paste the whole .p8 file, from -----BEGIN PRIVATE KEY----- to -----END PRIVATE KEY-----.';
  try {
    const k = createPrivateKey(text);
    if (k.asymmetricKeyType !== 'ec' || k.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return 'This is not an APNs key: an APNs key is an EC P-256 key (.p8 from Certificates, Identifiers & Profiles → Keys).';
    return null;
  } catch {
    return 'The key could not be read.';
  }
}

// ─────────────────────────────────────────────── provider tokens

/**
 * Apple wants the same token reused for up to an hour and refuses one refreshed
 * more often than every 20 minutes (TooManyProviderTokenUpdates): keep each for 50.
 */
const TOKEN_MS = 50 * 60_000;
const tokens = new Map<string, { at: number; jwt: string }>();
const keys = new Map<string, KeyObject>();

export function providerToken(c: Pick<ApnsCredentials, 'teamId' | 'keyId' | 'p8'>, now = Date.now()): string {
  const cacheKey = `${c.teamId}.${c.keyId}`;
  const hit = tokens.get(cacheKey);
  if (hit && now - hit.at < TOKEN_MS) return hit.jwt;
  let key = keys.get(c.p8);
  if (!key) { key = createPrivateKey(c.p8); keys.set(c.p8, key); }
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${b64({ alg: 'ES256', kid: c.keyId })}.${b64({ iss: c.teamId, iat: Math.floor(now / 1000) })}`;
  const sig = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const jwt = `${input}.${sig}`;
  tokens.set(cacheKey, { at: now, jwt });
  return jwt;
}

/** Forget a key's token (after InvalidProviderToken, or when the key is replaced). */
export function forgetProviderToken(teamId: string, keyId: string): void {
  tokens.delete(`${teamId}.${keyId}`);
}

// ─────────────────────────────────────────────── HTTP/2 sessions

const sessions = new Map<string, ClientHttp2Session>();

function session(origin: string): ClientHttp2Session {
  const s = sessions.get(origin);
  if (s && !s.closed && !s.destroyed) return s;
  const fresh = connect(origin);
  fresh.on('error', () => sessions.delete(origin));
  fresh.on('close', () => sessions.delete(origin));
  fresh.on('goaway', () => { sessions.delete(origin); fresh.close(); });
  // An idle connection is closed after a while; APNs is happy to keep it, but a worker does not need to.
  fresh.setTimeout(5 * 60_000, () => fresh.close());
  fresh.unref();
  sessions.set(origin, fresh);
  return fresh;
}

export function closeApns(): void {
  for (const s of sessions.values()) s.close();
  sessions.clear();
}

export interface ApnsResult {
  status: number | null;
  /** Apple's reason, e.g. BadDeviceToken, Unregistered, InvalidProviderToken. */
  reason: string | null;
  apnsId: string | null;
  env: ApnsEnv;
}

export interface ApnsMessage {
  title: string;
  body: string;
  /** A second line under the title (the site). */
  subtitle?: string;
  /** The app icon's badge: the number of things waiting for the driver. */
  badge?: number;
  /** Only update the badge: nothing is shown (an "alert" push with no alert, as Apple allows). */
  badgeOnly?: boolean;
  /** The notification's actions, registered by the app (e.g. PS_SESSION → "Stop charging"). */
  category?: string;
  /** time-sensitive breaks through Focus (needs the entitlement); passive stays quiet. */
  interruptionLevel?: 'passive' | 'active' | 'time-sensitive';
  /** 0–1: which notification leads a group in the summary. */
  relevance?: number;
  /** An https image the app's Notification Service Extension downloads and attaches (mutable-content). */
  imageUrl?: string;
  /** More data for the app (the actions' targets). */
  data?: Record<string, unknown>;
  /** A Live Activity push: this payload as is, push type liveactivity, topic <bundle>.push-type.liveactivity. */
  liveActivity?: Record<string, unknown>;
  /** Opened in the app when the notification is tapped. */
  url?: string;
  /** Replaces an earlier notification with the same id (≤ 64 bytes). */
  collapseId?: string;
  /** Seconds APNs keeps trying if the phone is offline. */
  ttlS?: number;
  /** 10 = now; 5 = when convenient. */
  priority?: 10 | 5;
}

export function apnsPayload(m: ApnsMessage): Record<string, unknown> {
  const badge = m.badge != null ? { badge: Math.max(0, Math.min(99, Math.floor(m.badge))) } : {};
  if (m.badgeOnly) return { aps: { badge: badge.badge ?? 0 } };
  return {
    aps: {
      alert: { title: m.title.slice(0, 120), ...(m.subtitle ? { subtitle: m.subtitle.slice(0, 120) } : {}), body: m.body.slice(0, 400) },
      sound: 'default',
      ...badge,
      ...(m.collapseId ? { 'thread-id': m.collapseId.slice(0, 64) } : {}),
      ...(m.category ? { category: m.category } : {}),
      ...(m.interruptionLevel ? { 'interruption-level': m.interruptionLevel } : {}),
      ...(m.relevance != null ? { 'relevance-score': Math.max(0, Math.min(1, m.relevance)) } : {}),
      ...(m.imageUrl ? { 'mutable-content': 1 } : {}),
    },
    ...(m.url ? { url: m.url } : {}),
    ...(m.imageUrl ? { image: m.imageUrl } : {}),
    ...(m.data ?? {}),
  };
}

/** One request to one environment. */
export function sendOnce(env: ApnsEnv, deviceToken: string, c: ApnsCredentials, m: ApnsMessage, timeoutMs = 10_000): Promise<ApnsResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: Omit<ApnsResult, 'env'>) => { if (!done) { done = true; resolve({ ...r, env }); } };
    let s: ClientHttp2Session;
    try { s = session(apnsOrigin(env)); } catch (e) { finish({ status: null, reason: (e as Error).message, apnsId: null }); return; }
    const body = Buffer.from(JSON.stringify(m.liveActivity ?? apnsPayload(m)));
    const headers: Record<string, string | number> = {
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
      authorization: `bearer ${providerToken(c)}`,
      'apns-topic': m.liveActivity ? `${c.topic}.push-type.liveactivity` : c.topic,
      'apns-push-type': m.liveActivity ? 'liveactivity' : 'alert',
      'apns-priority': String(m.priority ?? 10),
      'apns-expiration': String(Math.floor(Date.now() / 1000) + (m.ttlS ?? 86_400)),
      'content-type': 'application/json',
      'content-length': body.length,
    };
    // A badge-only update must not replace a notification the driver has not read yet.
    if (m.collapseId && !m.badgeOnly) headers['apns-collapse-id'] = m.collapseId.slice(0, 64);
    let req;
    try { req = s.request(headers); } catch (e) { finish({ status: null, reason: (e as Error).message, apnsId: null }); return; }
    const timer = setTimeout(() => { req.close(constants.NGHTTP2_CANCEL); finish({ status: null, reason: 'timeout', apnsId: null }); }, timeoutMs);
    let status: number | null = null;
    let apnsId: string | null = null;
    const chunks: Buffer[] = [];
    req.on('response', (h) => { status = Number(h[constants.HTTP2_HEADER_STATUS]); apnsId = (h['apns-id'] as string) ?? null; });
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      clearTimeout(timer);
      let reason: string | null = null;
      try { reason = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')).reason ?? null) : null; } catch { reason = null; }
      finish({ status, reason, apnsId });
    });
    req.on('error', (e) => { clearTimeout(timer); sessions.delete(apnsOrigin(env)); finish({ status: null, reason: e.message, apnsId: null }); });
    req.end(body);
  });
}

/** What a result means for the subscription and the message. */
export type Outcome = 'sent' | 'gone' | 'retry' | 'credentials' | 'failed';

export function outcomeOf(r: ApnsResult, opts: { buildTopic?: boolean } = {}): Outcome {
  if (r.status === 200) return 'sent';
  if (r.status === 410 || r.reason === 'Unregistered' || r.reason === 'BadDeviceToken' || r.reason === 'DeviceTokenNotForTopic') return 'gone';
  if (r.status === 403 && /ProviderToken|MissingProviderToken|InvalidProviderToken|ExpiredProviderToken/.test(r.reason ?? '')) return 'credentials';
  // A preview / development build's topic refused (not registered with the key's team): that build's problem, not the
  // brand's key — never marked as refused credentials in the console.
  if (r.reason === 'TopicDisallowed' || r.reason === 'BadTopic') return opts.buildTopic ? 'failed' : 'credentials';
  if (r.status === null || r.status === 429 || r.status >= 500 || r.reason === 'TooManyProviderTokenUpdates') return 'retry';
  return 'failed';
}

/**
 * The brand's credentials addressed to one build of its app (v1.9.1): `appId` is the `.preview` / `.dev` bundle id the
 * app registered with (brand.ts brandAppId), null for the store build. A development build's token sent to the store
 * bundle id got DeviceTokenNotForTopic, and was deleted as gone.
 */
export function forBuild(c: ApnsCredentials, appId: string | null | undefined): ApnsCredentials {
  return appId && appId !== c.topic ? { ...c, topic: appId } : c;
}

/**
 * Send to a device, in its known environment, or — not known yet — production
 * first and development if production does not know the token.
 */
export async function sendToDevice(deviceToken: string, env: ApnsEnv | null, c: ApnsCredentials, m: ApnsMessage): Promise<ApnsResult> {
  const first = await sendOnce(env ?? 'production', deviceToken, c, m);
  if (!env && first.reason === 'BadDeviceToken') return sendOnce('development', deviceToken, c, m);
  if (outcomeOf(first) === 'credentials') forgetProviderToken(c.teamId, c.keyId);
  return first;
}

/**
 * Check a key with Apple without notifying anyone: a request for a device
 * token that cannot exist. APNs checks the provider token first, so
 * BadDeviceToken means the key, Team ID and topic are accepted; a 403 names
 * what is wrong.
 */
export async function checkCredentials(c: ApnsCredentials): Promise<{ ok: boolean; detail: string }> {
  forgetProviderToken(c.teamId, c.keyId);
  const probe = '0'.repeat(64);
  const r = await sendOnce('production', probe, c, { title: 'check', body: 'check' });
  if (r.reason === 'BadDeviceToken' || r.status === 200) return { ok: true, detail: 'Apple accepted the key, Team ID and bundle identifier.' };
  const why: Record<string, string> = {
    InvalidProviderToken: 'Apple refused the key: check the Key ID and the Team ID, and that the key is enabled for Apple Push Notifications.',
    ExpiredProviderToken: 'Apple says the token is expired: check the server’s clock.',
    TopicDisallowed: 'Apple refused the bundle identifier for this key’s team.',
    BadTopic: 'The bundle identifier is not valid.',
    TooManyProviderTokenUpdates: 'Apple asks to slow down; try again in 20 minutes.',
  };
  return { ok: false, detail: r.reason ? (why[r.reason] ?? `Apple answered ${r.status ?? 'nothing'}: ${r.reason}.`) : `Apple could not be reached (${r.status ?? 'no answer'}).` };
}
