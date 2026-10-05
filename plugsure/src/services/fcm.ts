import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { isRelaxedEnv } from '../config.js';

/**
 * Firebase Cloud Messaging, HTTP v1 API — Android notifications for the native driver apps, with no library.
 *
 *   1. An OAuth 2.0 access token from a Google service account: an RS256 JWT (iss = the service account's e-mail,
 *      scope firebase.messaging, aud = its token_uri) signed with the account's private key, exchanged at token_uri
 *      (grant_type jwt-bearer). Tokens last an hour; one is kept for 55 minutes per service account key.
 *   2. POST https://fcm.googleapis.com/v1/projects/<project_id>/messages:send {message:{token, …}}.
 *
 * Each brand's Android app has its own Firebase project, so its own service account (stored sealed on the brand,
 * services/brand.ts), exactly as each brand's iOS app has its own APNs key.
 *
 * FCM_URL overrides https://fcm.googleapis.com, and a service account's token_uri may point anywhere, on a
 * development/test bench only (tests use local fakes over plain HTTP); in production both must be https://.
 */

export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const DEFAULT_TOKEN_URI = GOOGLE_TOKEN_URI;

/**
 * Where the signed assertion (with the service account's identity) is sent. In production ALWAYS Google's token
 * endpoint, whatever the uploaded file says (a doctored token_uri would send it elsewhere); a development / test
 * bench may point it at a local fake.
 */
export function tokenUriFor(fileUri: string, env?: string): string {
  return isRelaxedEnv(env) ? fileUri : GOOGLE_TOKEN_URI;
}

export interface FcmCredentials {
  projectId: string;
  clientEmail: string;
  /** PEM (PKCS#8) RSA private key from the service account JSON. */
  privateKey: string;
  privateKeyId: string | null;
  tokenUri: string;
}

/** Read a service account JSON file's text (or object) into credentials, or say what is wrong with it. */
export function parseServiceAccount(raw: unknown): { ok: true; creds: FcmCredentials } | { ok: false; error: string } {
  let o: Record<string, unknown>;
  try {
    o = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'Paste the whole service account JSON file (Firebase console → Project settings → Service accounts → Generate new private key).' };
  }
  if (!o || typeof o !== 'object') return { ok: false, error: 'The service account must be a JSON object.' };
  if (o.type !== 'service_account') return { ok: false, error: 'This is not a service account key file ("type" must be "service_account").' };
  const projectId = String(o.project_id ?? '').trim();
  const clientEmail = String(o.client_email ?? '').trim();
  const privateKey = String(o.private_key ?? '').replace(/\\n/g, '\n').trim();
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)) return { ok: false, error: 'The file has no valid project_id.' };
  if (!/^[^@\s]+@[^@\s]+\.[a-z.]+$/i.test(clientEmail)) return { ok: false, error: 'The file has no valid client_email.' };
  try {
    const k = createPrivateKey(privateKey);
    if (k.asymmetricKeyType !== 'rsa') return { ok: false, error: 'The private_key is not an RSA key.' };
  } catch {
    return { ok: false, error: 'The private_key could not be read.' };
  }
  const tokenUri = String(o.token_uri ?? DEFAULT_TOKEN_URI).trim();
  const p = urlProblem(tokenUri);
  if (p) return { ok: false, error: `token_uri: ${p}` };
  if (tokenUriFor(tokenUri) !== tokenUri) return { ok: false, error: `token_uri must be ${GOOGLE_TOKEN_URI} (a Google service account key file).` };
  return { ok: true, creds: { projectId, clientEmail, privateKey, privateKeyId: o.private_key_id ? String(o.private_key_id) : null, tokenUri } };
}

function urlProblem(u: string): string | null {
  try {
    const url = new URL(u);
    if (url.protocol === 'https:') return null;
    if (url.protocol === 'http:' && isRelaxedEnv()) return null;
    return 'must be https://';
  } catch {
    return 'not a URL';
  }
}

export function fcmOrigin(): string {
  const o = process.env.FCM_URL;
  if (!o) return 'https://fcm.googleapis.com';
  if (!o.startsWith('https://') && !isRelaxedEnv()) throw new Error('FCM_URL must be https:// in production');
  return o.replace(/\/+$/, '');
}

// ─────────────────────────────────────────────── access tokens

const keys = new Map<string, KeyObject>();
const tokens = new Map<string, { until: number; token: string }>();
const TOKEN_KEEP_MS = 55 * 60_000;

/** The signed JWT exchanged for an access token (RFC 7523). */
export function assertionFor(c: FcmCredentials, now = Date.now()): string {
  let key = keys.get(c.privateKey);
  if (!key) { key = createPrivateKey(c.privateKey); keys.set(c.privateKey, key); }
  const iat = Math.floor(now / 1000);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${b64({ alg: 'RS256', typ: 'JWT', ...(c.privateKeyId ? { kid: c.privateKeyId } : {}) })}.${b64({
    iss: c.clientEmail, sub: c.clientEmail, scope: FCM_SCOPE, aud: tokenUriFor(c.tokenUri), iat, exp: iat + 3600,
  })}`;
  return `${input}.${sign('sha256', Buffer.from(input), key).toString('base64url')}`;
}

export class FcmAuthError extends Error {
  constructor(message: string, public status: number | null) { super(message); }
}

export function forgetFcmToken(c: Pick<FcmCredentials, 'clientEmail' | 'privateKeyId'>): void {
  tokens.delete(`${c.clientEmail}:${c.privateKeyId ?? ''}`);
}

export async function accessToken(c: FcmCredentials, timeoutMs = 10_000): Promise<string> {
  const k = `${c.clientEmail}:${c.privateKeyId ?? ''}`;
  const hit = tokens.get(k);
  if (hit && hit.until > Date.now()) return hit.token;
  let res: Response;
  try {
    res = await fetch(tokenUriFor(c.tokenUri), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: assertionFor(c) }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new FcmAuthError(`token endpoint unreachable: ${(e as Error).message}`, null);
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) throw new FcmAuthError(`Google refused the service account (${res.status} ${body.error ?? ''} ${body.error_description ?? ''})`.replace(/\s+\)/, ')'), res.status);
  const keepMs = Math.min(TOKEN_KEEP_MS, Math.max(60, Number(body.expires_in ?? 3600) - 120) * 1000);
  tokens.set(k, { until: Date.now() + keepMs, token: body.access_token });
  return body.access_token;
}

// ─────────────────────────────────────────────── messages

/** Android notification channels the app creates (docs/MOBILE-APP-SPEC.md §12.1). */
export type FcmChannel = 'charging' | 'payments' | 'reservations' | 'account' | 'promotions';

export interface FcmMessage {
  token: string;
  /** Shown by the system when the app is in the background. Absent: a data-only message (the app decides). */
  notification?: { title: string; body: string; image?: string };
  /** Strings only (FCM's rule); the app reads `type`, `url`, `ref`, … */
  data?: Record<string, string>;
  priority: 'high' | 'normal';
  ttlS: number;
  /** One undelivered message per key replaces the previous (a live session's progress). */
  collapseKey?: string;
  channelId?: FcmChannel;
  /** Replaces a shown notification with the same tag (a charge's started → finished). */
  tag?: string;
}

/** The HTTP v1 request body. */
export function fcmPayload(m: FcmMessage, validateOnly = false): Record<string, unknown> {
  const data = m.data ? Object.fromEntries(Object.entries(m.data).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])) : undefined;
  return {
    ...(validateOnly ? { validate_only: true } : {}),
    message: {
      token: m.token,
      ...(m.notification ? { notification: { title: m.notification.title, body: m.notification.body, ...(m.notification.image ? { image: m.notification.image } : {}) } } : {}),
      ...(data && Object.keys(data).length ? { data } : {}),
      android: {
        priority: m.priority === 'high' ? 'HIGH' : 'NORMAL',
        ttl: `${Math.max(0, Math.floor(m.ttlS))}s`,
        ...(m.collapseKey ? { collapse_key: m.collapseKey } : {}),
        ...(m.notification ? {
          notification: {
            ...(m.channelId ? { channel_id: m.channelId } : {}),
            ...(m.tag ? { tag: m.tag } : {}),
            ...(m.notification.image ? { image: m.notification.image } : {}),
          },
        } : {}),
      },
    },
  };
}

export interface FcmResult {
  status: number | null;
  /** FCM's errorCode (UNREGISTERED, INVALID_ARGUMENT, SENDER_ID_MISMATCH, QUOTA_EXCEEDED, UNAVAILABLE, INTERNAL, THIRD_PARTY_AUTH_ERROR) or the HTTP status text. */
  errorCode: string | null;
  detail: string | null;
  name?: string;
}

export async function sendFcm(c: FcmCredentials, m: FcmMessage, opts: { validateOnly?: boolean; timeoutMs?: number } = {}): Promise<FcmResult> {
  let token: string;
  try {
    token = await accessToken(c, opts.timeoutMs);
  } catch (e) {
    const s = (e as FcmAuthError).status;
    return { status: s ?? null, errorCode: s != null && s >= 400 && s < 500 ? 'THIRD_PARTY_AUTH_ERROR' : 'UNAVAILABLE', detail: (e as Error).message };
  }
  let res: Response;
  try {
    res = await fetch(`${fcmOrigin()}/v1/projects/${encodeURIComponent(c.projectId)}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(fcmPayload(m, opts.validateOnly)),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (e) {
    return { status: null, errorCode: 'UNAVAILABLE', detail: (e as Error).message };
  }
  const body = (await res.json().catch(() => ({}))) as { name?: string; error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> } };
  if (res.ok) return { status: res.status, errorCode: null, detail: null, name: body.name };
  if (res.status === 401) forgetFcmToken(c);
  const code = body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status ?? String(res.status);
  return { status: res.status, errorCode: code, detail: body.error?.message ?? null };
}

export type FcmOutcome = 'sent' | 'gone' | 'retry' | 'credentials' | 'failed';

/** What to do after a send (the token is gone, try again, the brand's credentials are refused, or give up). */
export function outcomeOfFcm(r: FcmResult): FcmOutcome {
  if (r.status != null && r.status >= 200 && r.status < 300) return 'sent';
  const c = r.errorCode ?? '';
  // The app was uninstalled or the token expired; a token of another Firebase project.
  if (c === 'UNREGISTERED' || r.status === 404 || c === 'SENDER_ID_MISMATCH') return 'gone';
  if (c === 'INVALID_ARGUMENT' && /registration token|token is not a valid/i.test(r.detail ?? '')) return 'gone';
  if (c === 'THIRD_PARTY_AUTH_ERROR' || c === 'UNAUTHENTICATED' || c === 'PERMISSION_DENIED' || r.status === 401 || r.status === 403) return 'credentials';
  if (r.status == null || r.status === 429 || r.status >= 500 || c === 'QUOTA_EXCEEDED' || c === 'UNAVAILABLE' || c === 'INTERNAL') return 'retry';
  return 'failed';
}

/**
 * Check a service account with Google without notifying anyone: a validate-only send to a token that cannot exist.
 * Google authenticates first, so INVALID_ARGUMENT / UNREGISTERED (the token) means the account may send for the project.
 */
export async function checkFcmCredentials(c: FcmCredentials): Promise<{ ok: boolean; detail: string }> {
  const r = await sendFcm(c, { token: 'plugsure-credentials-check', priority: 'normal', ttlS: 0, data: { check: '1' } }, { validateOnly: true });
  if (r.status != null && r.status >= 200 && r.status < 300) return { ok: true, detail: 'Google accepted the service account.' };
  const o = outcomeOfFcm(r);
  if (r.errorCode === 'INVALID_ARGUMENT' || o === 'gone') return { ok: true, detail: 'Google accepted the service account for this Firebase project.' };
  if (o === 'credentials') return { ok: false, detail: `Google refused the service account for project ${c.projectId}: ${r.detail ?? r.errorCode ?? r.status}. Give it the "Firebase Cloud Messaging API Admin" role and enable the FCM API.` };
  return { ok: false, detail: `Could not check with Google now (${r.errorCode ?? r.status ?? 'network'}${r.detail ? `: ${r.detail}` : ''}). Try again.` };
}
