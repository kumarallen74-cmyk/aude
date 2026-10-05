import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { one, query, outsideRequestScope } from '../db/pool.js';
import { config, isRelaxedEnv } from '../config.js';
import { logger } from '../logger.js';
import { guardedFetch } from './net-guard.js';
import { seal, unseal } from './secrets.js';
import { isAdministratorAccount } from './users.js';
import { microsoftMfaTrusted } from './auth.js';

/**
 * "Sign in with Microsoft" for the operator console: Microsoft Entra ID (Azure AD) over
 * OpenID Connect, authorization code flow with PKCE, validated here with node:crypto alone.
 *
 * Product rules (from the owner):
 *   · Each operator ORGANISATION connects its OWN Entra tenant (org_identity_provider). A
 *     sign-in is only ever matched inside the one organisation that tenant is connected to.
 *   · NO auto-provisioning. Only a person who already has a console user (invited by an
 *     administrator) can sign in; anyone else is refused and the refusal is audited.
 *   · Password sign-in stays available for everyone.
 *
 * One PlugSure app registration ("multi-tenant", accounts in any organisational directory)
 * serves the whole platform: MS_CLIENT_ID + MS_CLIENT_SECRET (or MS_CLIENT_SECRET_FILE),
 * authority `https://login.microsoftonline.com/organizations/v2.0`. Without MS_CLIENT_ID the
 * feature is off: no button, the routes answer 404. See deploy/MICROSOFT-SIGN-IN.md.
 *
 * The flow, and why each piece is there:
 *
 *   start      a random `state`, `nonce`, PKCE verifier and a browser-binding value. The
 *              transaction is kept SERVER-SIDE (oidc_login_tx, keyed by sha256(state), ten
 *              minutes), because the console's session cookie is SameSite=Strict and the
 *              browser does not send it on the way back from login.microsoftonline.com. Only
 *              the binding value goes into a cookie (`__Host-ps_ms_tx` on https, see msTxCookie;
 *              one value per sign-in in progress): HttpOnly, SameSite=Lax, ten minutes. Lax is
 *              the narrowest setting a top-level GET
 *              navigation from Microsoft back to us carries; it is what stops "login CSRF"
 *              (an attacker finishing THEIR sign-in in YOUR browser by sending you their
 *              callback link: your browser has no matching binding cookie, so it is refused).
 *   return     response_mode=query: Microsoft redirects the browser with ?code&state (a GET,
 *              which carries the Lax cookie). form_post would be a cross-site POST, which only
 *              a SameSite=None cookie survives — a wider cookie, and one browsers refuse
 *              without Secure (plain-http benches). The code in the URL is single-use, bound
 *              to our PKCE verifier and useless without the client secret; the callback
 *              answers with an immediate redirect and Referrer-Policy: no-referrer.
 *   exchange   the code is redeemed server-side at the token endpoint with the client secret
 *              and the PKCE verifier, through the outbound guard (net-guard.ts). The token
 *              endpoint and JWKS must be on the authority's own origin, so a tampered or
 *              misconfigured discovery document cannot send the client secret elsewhere.
 *   validate   the ID token: RS256 only, the key by `kid` from the JWKS (cached a day,
 *              re-fetched on an unknown kid at most every five minutes), `iss` exactly
 *              `<authority>/<tid>/v2.0` for the token's own `tid`, `aud` our client id,
 *              `exp`/`nbf`/`iat` with a minute of skew, `nonce` ours, `tid`/`oid` present,
 *              personal Microsoft accounts (tid 9188040d-…) refused.
 *
 * Nothing here logs a code, a token or a secret.
 */

// ------------------------------------------------------------------ configuration

/** The tenant of personal Microsoft accounts (outlook.com, live.com …): never a console user. */
export const MS_PERSONAL_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
export const MS_CALLBACK_PATH = '/v1/auth/microsoft/callback';
export const MS_START_PATH = '/v1/auth/microsoft/start';
/**
 * The browser-binding cookie of the sign-ins in flight (see above). With Secure cookies (every
 * https deployment) it is `__Host-ps_ms_tx`: the browser then refuses it unless it is Secure,
 * host-only and Path=/, so a sibling sub-domain cannot plant ("toss") one. Browsers also refuse
 * a __Host- cookie without Secure, and a plain-http bench cannot have Secure cookies, so there
 * (only) it falls back to `ps_ms_tx` on the narrow path /v1/auth/microsoft/.
 * It holds up to MS_TX_MAX_PER_BROWSER values, one per sign-in in progress (two tabs).
 */
export const msTxCookie = (secure: boolean) =>
  secure ? { name: '__Host-ps_ms_tx', path: '/' } : { name: 'ps_ms_tx', path: '/v1/auth/microsoft/' };
export const MS_TX_MAX_PER_BROWSER = 4;
/** How long a sign-in may take at Microsoft before it must start again. */
export const MS_TX_TTL_MINUTES = 10;
const SCOPES = 'openid profile email';
/** Clock skew accepted on exp / nbf / iat. */
const SKEW_S = 60;
const METADATA_TTL_MS = 24 * 3600_000;
const JWKS_TTL_MS = 24 * 3600_000;
/** An unknown `kid` triggers a JWKS re-fetch at most this often (a forged kid cannot make us hammer Microsoft). */
const JWKS_REFETCH_MIN_MS = 5 * 60_000;

/**
 * Microsoft's sign-in hosts (global, US Government, China). Outside development and test the
 * authority must be one of these: MS_AUTHORITY_BASE exists for the tests' mock provider, not
 * to point production at another identity provider.
 */
const MICROSOFT_LOGIN_HOSTS = ['login.microsoftonline.com', 'login.microsoftonline.us', 'login.partner.microsoftonline.cn', 'login.chinacloudapi.cn'];

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MicrosoftConfig {
  clientId: string;
  /** e.g. https://login.microsoftonline.com — no trailing slash, no path. */
  authorityBase: string;
  /** Treat `amr` containing "mfa" as the console's second factor (MS_TRUST_MFA_CLAIM, default true). */
  trustMfaClaim: boolean;
  /** Extra console host names that offer the button (MS_SIGNIN_HOSTS), beside PUBLIC_BASE_URL's. */
  extraHosts: string[];
}

/** Read on every call, so tests (and an operator's restart-free env changes in tests) take effect. */
export function microsoftConfig(env: NodeJS.ProcessEnv = process.env): MicrosoftConfig {
  return {
    clientId: (env.MS_CLIENT_ID ?? '').trim(),
    authorityBase: (env.MS_AUTHORITY_BASE ?? 'https://login.microsoftonline.com').trim().replace(/\/+$/, ''),
    trustMfaClaim: microsoftMfaTrusted(env),
    extraHosts: (env.MS_SIGNIN_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean),
  };
}

/** Is "Sign in with Microsoft" switched on (MS_CLIENT_ID set)? */
export function microsoftEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return microsoftConfig(env).clientId !== '';
}

/**
 * The client secret: MS_CLIENT_SECRET, or the contents of MS_CLIENT_SECRET_FILE (trimmed).
 * The file is read at each code exchange, so a rotated secret is picked up without a restart.
 */
export function microsoftClientSecret(env: NodeJS.ProcessEnv = process.env): string {
  const file = (env.MS_CLIENT_SECRET_FILE ?? '').trim();
  if (file) return readFileSync(file, 'utf8').trim();
  return (env.MS_CLIENT_SECRET ?? '').trim();
}

/**
 * Why the Microsoft settings cannot work, or null. Checked at start-up (assertAuthConfigured):
 * a half-configured feature fails loudly at deploy time rather than at a user's first sign-in.
 */
export function microsoftConfigProblem(env: NodeJS.ProcessEnv = process.env, relaxed = isRelaxedEnv()): string | null {
  const c = microsoftConfig(env);
  if (!c.clientId) {
    if ((env.MS_CLIENT_SECRET ?? '').trim() || (env.MS_CLIENT_SECRET_FILE ?? '').trim()) {
      return 'MS_CLIENT_SECRET is set but MS_CLIENT_ID is not: set both to enable "Sign in with Microsoft", or neither.';
    }
    return null;
  }
  if (!GUID_RE.test(c.clientId)) return 'MS_CLIENT_ID must be the Application (client) ID of the app registration (a GUID).';
  if ((env.MS_CLIENT_SECRET ?? '').trim() && (env.MS_CLIENT_SECRET_FILE ?? '').trim()) {
    return 'set MS_CLIENT_SECRET or MS_CLIENT_SECRET_FILE, not both.';
  }
  let secret = '';
  try {
    secret = microsoftClientSecret(env);
  } catch (e) {
    return `MS_CLIENT_SECRET_FILE cannot be read: ${(e as Error).message}`;
  }
  if (!secret) return 'MS_CLIENT_ID is set but there is no client secret: set MS_CLIENT_SECRET or MS_CLIENT_SECRET_FILE.';
  let u: URL;
  try {
    u = new URL(c.authorityBase);
  } catch {
    return 'MS_AUTHORITY_BASE is not a URL.';
  }
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) return 'MS_AUTHORITY_BASE must be an origin only, e.g. https://login.microsoftonline.com';
  if (!relaxed) {
    if (u.protocol !== 'https:' || !MICROSOFT_LOGIN_HOSTS.includes(u.hostname) || u.port) {
      return `MS_AUTHORITY_BASE must be https://${MICROSOFT_LOGIN_HOSTS[0]} (or another Microsoft cloud's sign-in host) outside development and test.`;
    }
    const base = config.console.publicBaseUrl || (env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
    if (!/^https:\/\//.test(base)) {
      return 'PUBLIC_BASE_URL must be set to the console\'s https:// address for "Sign in with Microsoft" (the redirect URI is built from it).';
    }
  } else if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return 'MS_AUTHORITY_BASE must be an http(s) origin.';
  }
  return null;
}

const normHost = (h: unknown) => String(h ?? '').trim().toLowerCase().replace(/\.$/, '');

/**
 * The redirect URI for a sign-in that starts on `hostHeader`, or null when this host does not
 * offer "Sign in with Microsoft". The redirect URI must be registered in the Entra admin center exactly, and the
 * browser-binding and session cookies are per host, so the whole flow stays on one host:
 *   · the host of PUBLIC_BASE_URL (always, when PUBLIC_BASE_URL is set);
 *   · each host in MS_SIGNIN_HOSTS (an operator's own console address, an office-only name),
 *     as https://<host>/v1/auth/microsoft/callback — register each in the Entra admin center too;
 *   · in development and test without PUBLIC_BASE_URL, the request's own host.
 */
export function redirectUriFor(hostHeader: unknown, protocol: string, c: MicrosoftConfig = microsoftConfig()): string | null {
  const host = normHost(hostHeader);
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(host)) return null;
  const base = config.console.publicBaseUrl;
  if (base) {
    try {
      const u = new URL(base);
      if (u.host.toLowerCase() === host) return `${u.origin}${MS_CALLBACK_PATH}`;
    } catch {
      /* fall through */
    }
  } else if (isRelaxedEnv()) {
    return `${protocol === 'https' ? 'https' : 'http'}://${host}${MS_CALLBACK_PATH}`;
  }
  const bare = host.replace(/:\d+$/, '');
  if (c.extraHosts.includes(bare) || c.extraHosts.includes(host)) {
    return `${isRelaxedEnv() && protocol !== 'https' ? 'http' : 'https'}://${host}${MS_CALLBACK_PATH}`;
  }
  return null;
}

// ------------------------------------------------------------------ errors

/**
 * Why a Microsoft sign-in (or tenant connection) did not succeed. `code` is what the browser is
 * told (/?ms=<code>, explained by the console); `detail` goes to the audit log only.
 */
export type MicrosoftRefusal =
  | 'disabled_feature' | 'wrong_host' | 'unavailable' | 'expired' | 'cancelled' | 'consent' | 'failed'
  | 'personal_account' | 'not_linked' | 'no_user' | 'ambiguous' | 'disabled' | 'locked' | 'oid_conflict' | 'admin_host'
  | 'tenant_taken' | 'already_linked' | 'link_forbidden'
  | 'guest_account' | 'not_tenant_admin' | 'roles_missing';

export class MicrosoftSignInError extends Error {
  constructor(public code: MicrosoftRefusal, public detail: string = code) {
    super(detail);
    this.name = 'MicrosoftSignInError';
  }
}

// ------------------------------------------------------------------ discovery and keys

interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

type Jwk = JsonWebKey & { kid?: string; use?: string; issuer?: string; alg?: string };

let metadataCache: { base: string; at: number; value: OidcMetadata } | null = null;
let jwksCache: { uri: string; at: number; keys: Map<string, Jwk> } | null = null;
let jwksInflight: Promise<void> | null = null;

/** Tests: forget discovery and keys (e.g. after rotating the mock provider's key). */
export function resetMicrosoftCaches(): void {
  metadataCache = null;
  jwksCache = null;
  jwksInflight = null;
}

async function fetchJson(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; json: any }> {
  const r = await guardedFetch(url, { ...init, timeoutMs: 10_000, maxBytes: 512 * 1024 });
  let json: any = null;
  try {
    json = JSON.parse(r.text);
  } catch {
    json = null;
  }
  return { status: r.status, json };
}

/** Same origin as the authority: discovery must not send us (or the client secret) elsewhere. */
function onAuthority(url: unknown, base: string): url is string {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

async function metadata(c: MicrosoftConfig = microsoftConfig()): Promise<OidcMetadata> {
  if (metadataCache && metadataCache.base === c.authorityBase && Date.now() - metadataCache.at < METADATA_TTL_MS) return metadataCache.value;
  const url = `${c.authorityBase}/organizations/v2.0/.well-known/openid-configuration`;
  let r: { status: number; json: any };
  try {
    r = await fetchJson(url);
  } catch (e) {
    throw new MicrosoftSignInError('unavailable', `discovery failed: ${(e as Error).message}`);
  }
  const m = r.json as Partial<OidcMetadata> | null;
  if (r.status !== 200 || !m) throw new MicrosoftSignInError('unavailable', `discovery answered HTTP ${r.status}`);
  if (
    typeof m.issuer !== 'string' ||
    !onAuthority(m.authorization_endpoint, c.authorityBase) ||
    !onAuthority(m.token_endpoint, c.authorityBase) ||
    !onAuthority(m.jwks_uri, c.authorityBase)
  ) {
    throw new MicrosoftSignInError('unavailable', 'discovery document names endpoints outside the authority');
  }
  const value = { issuer: m.issuer, authorization_endpoint: m.authorization_endpoint!, token_endpoint: m.token_endpoint!, jwks_uri: m.jwks_uri! };
  metadataCache = { base: c.authorityBase, at: Date.now(), value };
  return value;
}

async function refreshJwks(uri: string): Promise<void> {
  // One fetch at a time: a burst of sign-ins after a key rollover shares it.
  jwksInflight ??= (async () => {
    try {
      const r = await fetchJson(uri);
      const list = Array.isArray(r.json?.keys) ? (r.json.keys as Jwk[]) : null;
      if (r.status !== 200 || !list) throw new Error(`JWKS answered HTTP ${r.status}`);
      const keys = new Map<string, Jwk>();
      for (const k of list) if (typeof k?.kid === 'string' && k.kty === 'RSA') keys.set(k.kid, k);
      jwksCache = { uri, at: Date.now(), keys };
    } finally {
      jwksInflight = null;
    }
  })();
  return jwksInflight;
}

/** The signing key `kid`, or null. A re-fetch for an unknown kid is rate limited (JWKS_REFETCH_MIN_MS). */
async function signingKey(kid: string, uri: string): Promise<Jwk | null> {
  const fresh = jwksCache && jwksCache.uri === uri && Date.now() - jwksCache.at < JWKS_TTL_MS;
  if (fresh && jwksCache!.keys.has(kid)) return jwksCache!.keys.get(kid)!;
  const mayFetch = !jwksCache || jwksCache.uri !== uri || !fresh || Date.now() - jwksCache.at >= JWKS_REFETCH_MIN_MS;
  if (mayFetch) {
    try {
      await refreshJwks(uri);
    } catch (e) {
      throw new MicrosoftSignInError('unavailable', `JWKS fetch failed: ${(e as Error).message}`);
    }
  }
  return jwksCache?.keys.get(kid) ?? null;
}

// ------------------------------------------------------------------ the ID token

export interface MicrosoftClaims {
  tid: string;
  oid: string;
  iss: string;
  /** UPN for work accounts (v2.0 tokens), lower case. */
  preferredUsername: string | null;
  /** The `email` claim (optional, not always present), lower case. */
  email: string | null;
  name: string | null;
  amr: string[];
  /**
   * `xms_edov` (optional claim): the `email` claim's domain is verified by the user's tenant.
   * Only then may `email` match a console user (see resolveMicrosoftUser).
   */
  emailVerified: boolean;
  /** `wids`: the tenant-wide Entra directory roles (role template ids, lower case); null when absent. */
  wids: string[] | null;
  /**
   * A guest of the tenant rather than a member: `acct` = 1 (optional claim), an `idp` naming
   * another identity provider than the tenant itself, or a UPN with "#EXT#".
   */
  guest: boolean;
}

const b64urlJson = (part: string): any => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/**
 * Validate a Microsoft ID token completely and return its claims, or throw
 * MicrosoftSignInError('failed' | 'personal_account', <reason>). `nowS` for tests.
 */
export async function validateIdToken(
  idToken: string,
  // `nonceHash`: sha256 (hex) of the nonce this sign-in sent; only the hash is stored.
  expect: { clientId: string; nonceHash: string; authorityBase: string; nowS?: number },
): Promise<MicrosoftClaims> {
  const fail = (why: string): never => {
    throw new MicrosoftSignInError('failed', `id_token: ${why}`);
  };
  if (typeof idToken !== 'string' || idToken.length > 16_384) fail('missing or oversized');
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) fail('not a compact JWS');
  let header: any;
  let payload: any;
  try {
    header = b64urlJson(parts[0]!);
    payload = b64urlJson(parts[1]!);
  } catch {
    return fail('undecodable');
  }
  if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') fail('undecodable');
  // RS256 and nothing else: no "none", no HMAC with the public key as the secret.
  if (header.alg !== 'RS256') fail(`alg ${String(header.alg)} refused`);
  if (typeof header.kid !== 'string' || !header.kid) fail('no kid');
  if (header.crit !== undefined) fail('crit header refused');

  const tid = typeof payload.tid === 'string' ? payload.tid.toLowerCase() : '';
  if (!GUID_RE.test(tid)) fail('no tid');

  const meta = await metadata({ ...microsoftConfig(), authorityBase: expect.authorityBase });
  const key = await signingKey(header.kid, meta.jwks_uri);
  if (!key) fail('unknown kid');
  if (key!.use !== undefined && key!.use !== 'sig') fail('key is not a signing key');
  let ok = false;
  try {
    const pub = createPublicKey({ key: key as JsonWebKey, format: 'jwk' });
    ok = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), pub, Buffer.from(parts[2]!, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) fail('bad signature');

  // A genuine token of a personal Microsoft account: its own answer, a clearer message for the
  // person ("use your work account"). Checked after the signature, so a forged token is "failed".
  if (tid === MS_PERSONAL_TENANT) throw new MicrosoftSignInError('personal_account', 'id_token: personal Microsoft account');

  // The issuer for THIS token's tenant, exactly — the "organizations" metadata's issuer is a
  // template ("…/{tenantid}/v2.0"); a token from tenant A claiming tenant B's issuer fails here.
  const expectedIss = `${expect.authorityBase}/${tid}/v2.0`;
  if (payload.iss !== expectedIss) fail('wrong issuer');
  if (meta.issuer.replace('{tenantid}', tid) !== expectedIss) fail('issuer does not match the discovery document');
  // A key published for one tenant only (Microsoft's per-key "issuer") must be that tenant's.
  if (typeof key!.issuer === 'string' && key!.issuer.replace('{tenantid}', tid) !== expectedIss) fail('key issuer mismatch');

  const aud = payload.aud;
  if (Array.isArray(aud) ? !aud.includes(expect.clientId) || (aud.length > 1 && payload.azp !== expect.clientId) : aud !== expect.clientId) {
    fail('wrong audience');
  }

  const now = expect.nowS ?? Math.floor(Date.now() / 1000);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  const exp = num(payload.exp);
  const iat = num(payload.iat);
  const nbf = payload.nbf === undefined ? iat : num(payload.nbf);
  if (!Number.isFinite(exp) || exp + SKEW_S < now) fail('expired');
  if (!Number.isFinite(nbf) || nbf - SKEW_S > now) fail('not yet valid');
  // Issued for THIS sign-in: not in the future, not older than the sign-in's own lifetime.
  if (!Number.isFinite(iat) || iat - SKEW_S > now || iat < now - MS_TX_TTL_MINUTES * 60 - SKEW_S) fail('iat out of range');

  if (typeof payload.nonce !== 'string' || !safeEqualStr(sha256(payload.nonce), expect.nonceHash)) fail('nonce mismatch');

  const oid = typeof payload.oid === 'string' ? payload.oid.toLowerCase() : '';
  if (!GUID_RE.test(oid)) fail('no oid');

  const lower = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase().slice(0, 320) : null);
  const upn = lower(payload.preferred_username);
  // Microsoft documents `idp` as equal to the issuer unless the account comes from elsewhere;
  // it may be the v1 form (https://sts.windows.net/<tid>/), so "elsewhere" = not naming this tenant.
  const idp = typeof payload.idp === 'string' ? payload.idp.toLowerCase() : null;
  const foreignIdp = idp !== null && !idp.includes(tid);
  const acct = payload.acct === undefined ? null : Number(payload.acct);
  const truthy = (v: unknown) => v === true || v === 1 || v === 'true' || v === '1';
  return {
    tid,
    oid,
    iss: payload.iss,
    preferredUsername: upn,
    email: lower(payload.email),
    name: typeof payload.name === 'string' ? payload.name.slice(0, 200) : null,
    amr: Array.isArray(payload.amr) ? payload.amr.filter((x: unknown): x is string => typeof x === 'string') : [],
    emailVerified: truthy(payload.xms_edov),
    wids: Array.isArray(payload.wids) ? payload.wids.filter((x: unknown): x is string => typeof x === 'string').map((x: string) => x.toLowerCase()) : null,
    guest: acct === 1 || foreignIdp || (upn !== null && upn.includes('#ext#')),
  };
}

function sha256(v: string): string {
  return createHash('sha256').update(v, 'utf8').digest('hex');
}

function safeEqualStr(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ------------------------------------------------------------------ the flow

export type FlowMode = 'signin' | 'link';

export interface StartedFlow {
  /** Where to send the browser (Microsoft's authorize endpoint). */
  url: string;
  /** The browser-binding value, for the binding cookie (msTxCookie). */
  binding: string;
}

const aadVerifier = (stateHash: string) => `oidc_login_tx:${stateHash}:code_verifier`;

/**
 * Start a sign-in (`signin`) or a tenant connection (`link`, by `userId` of `orgId`).
 * Throws MicrosoftSignInError('disabled_feature' | 'wrong_host' | 'unavailable').
 */
export async function startMicrosoftFlow(args: {
  mode: FlowMode;
  host: unknown;
  protocol: string;
  ip?: string | null;
  orgId?: string | null;
  userId?: string | null;
}): Promise<StartedFlow> {
  const c = microsoftConfig();
  if (!c.clientId) throw new MicrosoftSignInError('disabled_feature');
  const redirectUri = redirectUriFor(args.host, args.protocol, c);
  if (!redirectUri) throw new MicrosoftSignInError('wrong_host', `host ${normHost(args.host).slice(0, 100)} does not offer Microsoft sign-in`);
  if (args.mode === 'link' && (!args.orgId || !args.userId)) throw new Error('link mode needs the organisation and the administrator');
  const meta = await metadata(c);

  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const binding = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const stateHash = sha256(state);

  // On the plain pool (bypass on): the transaction must exist once the browser is sent off,
  // whatever happens to the request's own transaction, and it is platform data.
  await outsideRequestScope(async () => {
    // Opportunistic clean-up; the expiry index keeps it cheap.
    await query(`DELETE FROM oidc_login_tx WHERE expires_at < now() - interval '1 hour'`);
    await query(
      `INSERT INTO oidc_login_tx (state_hash, mode, org_id, user_id, nonce_hash, code_verifier, browser_hash, redirect_uri, host, ip, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + ($11 || ' minutes')::interval)`,
      [
        stateHash, args.mode, args.mode === 'link' ? args.orgId : null, args.mode === 'link' ? args.userId : null,
        sha256(nonce), seal(verifier, aadVerifier(stateHash)), sha256(binding), redirectUri, normHost(args.host), args.ip ?? null,
        MS_TX_TTL_MINUTES,
      ],
    );
  });

  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set('client_id', c.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_mode', 'query');
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  // Shared depot PCs and people with several work accounts: always let them pick.
  u.searchParams.set('prompt', 'select_account');
  return { url: u.toString(), binding };
}

export interface FinishedFlow {
  mode: FlowMode;
  orgId: string | null;
  userId: string | null;
  host: string;
  claims: MicrosoftClaims;
}

/** What the start recorded, once the callback has consumed it (for the audit of a refusal). */
export interface ConsumedTx {
  mode: FlowMode;
  orgId: string | null;
  userId: string | null;
  host: string;
  /** sha256 of this sign-in's binding value: which value the cookie no longer needs. */
  browserHash: string;
}

/**
 * The callback: consume the transaction (single use, even when what follows fails), check the
 * browser binding and host, redeem the code and validate the ID token. Throws
 * MicrosoftSignInError; `onConsumed` hears about the transaction as soon as it is known, so a
 * refusal can be audited against the right organisation and returned to the right page.
 */
export async function finishMicrosoftFlow(
  // `bindings`: the values of the browser-binding cookie (one per sign-in in progress).
  args: { state: unknown; code: unknown; error: unknown; errorDescription: unknown; bindings: string[]; host: unknown },
  onConsumed: (tx: ConsumedTx) => void = () => {},
): Promise<FinishedFlow> {
  const c = microsoftConfig();
  if (!c.clientId) throw new MicrosoftSignInError('disabled_feature');
  const state = typeof args.state === 'string' ? args.state : '';
  if (!state || state.length > 200) throw new MicrosoftSignInError('expired', 'no state');
  const stateHash = sha256(state);

  // DELETE … RETURNING: of two callbacks with one state (a replay, a double click), one wins.
  const tx = await outsideRequestScope(() =>
    one<{
      mode: FlowMode; org_id: string | null; user_id: string | null; nonce_hash: string; code_verifier: string;
      browser_hash: string; redirect_uri: string; host: string; live: boolean;
    }>(
      `DELETE FROM oidc_login_tx WHERE state_hash = $1
       RETURNING mode, org_id, user_id, nonce_hash, code_verifier, browser_hash, redirect_uri, host, (expires_at > now()) AS live`,
      [stateHash],
    ),
  );
  if (!tx) throw new MicrosoftSignInError('expired', 'unknown or already used state');
  onConsumed({ mode: tx.mode, orgId: tx.org_id, userId: tx.user_id, host: tx.host, browserHash: tx.browser_hash });
  if (!tx.live) throw new MicrosoftSignInError('expired', 'sign-in took longer than the allowed time');
  if (!args.bindings.some((b) => safeEqualStr(sha256(b), tx.browser_hash))) {
    throw new MicrosoftSignInError('expired', 'browser binding cookie missing or different (not the browser that started)');
  }
  if (normHost(args.host) !== tx.host) throw new MicrosoftSignInError('expired', 'came back on another host');

  if (args.error !== undefined && args.error !== null && args.error !== '') {
    const err = String(args.error).slice(0, 100);
    const aadsts = /AADSTS\d+/.exec(String(args.errorDescription ?? ''))?.[0] ?? '';
    if (err === 'access_denied' && !aadsts) throw new MicrosoftSignInError('cancelled', `authorize: ${err}`);
    if (err === 'consent_required' || /AADSTS(65001|90094|90095|900941)/.test(aadsts)) {
      throw new MicrosoftSignInError('consent', `authorize: ${err} ${aadsts}`.trim());
    }
    throw new MicrosoftSignInError(err === 'access_denied' ? 'cancelled' : 'failed', `authorize: ${err} ${aadsts}`.trim());
  }
  const code = typeof args.code === 'string' ? args.code : '';
  if (!code || code.length > 4096) throw new MicrosoftSignInError('failed', 'no code');

  const meta = await metadata(c);
  let secret: string;
  try {
    secret = microsoftClientSecret();
  } catch (e) {
    throw new MicrosoftSignInError('unavailable', `client secret unreadable: ${(e as Error).message}`);
  }
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: secret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: tx.redirect_uri,
    code_verifier: unseal(tx.code_verifier, aadVerifier(stateHash)),
    scope: SCOPES,
  }).toString();
  let r: { status: number; json: any };
  try {
    r = await fetchJson(meta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
  } catch (e) {
    throw new MicrosoftSignInError('unavailable', `token endpoint: ${(e as Error).message}`);
  }
  if (r.status !== 200 || typeof r.json?.id_token !== 'string') {
    // Microsoft's error and its AADSTS number only: never the response body as a whole.
    const err = typeof r.json?.error === 'string' ? r.json.error.slice(0, 60) : 'no id_token';
    const codes = Array.isArray(r.json?.error_codes) ? r.json.error_codes.slice(0, 3).map((n: unknown) => `AADSTS${Number(n)}`).join(',') : '';
    const consent = err === 'consent_required' || /AADSTS(65001|90094)/.test(codes);
    throw new MicrosoftSignInError(consent ? 'consent' : 'failed', `token: HTTP ${r.status} ${err} ${codes}`.trim());
  }
  const claims = await validateIdToken(r.json.id_token, { clientId: c.clientId, nonceHash: tx.nonce_hash, authorityBase: c.authorityBase });
  return { mode: tx.mode, orgId: tx.org_id, userId: tx.user_id, host: tx.host, claims };
}

// ------------------------------------------------------------------ tenants and users

export interface LinkedTenant {
  tenantId: string;
  allowedDomains: string[];
  linkedAt: string;
  linkedBy: { id: string; name: string } | null;
  linkedByAccount: string | null;
}

/** The organisation's connected tenant, or null. Runs in the caller's (RLS) scope. */
export async function linkedTenant(orgId: string): Promise<LinkedTenant | null> {
  const r = await one<{ tenant_id: string; allowed_domains: string[]; linked_at: Date; linked_by: string | null; by_name: string | null; linked_by_account: string | null }>(
    `SELECT p.tenant_id, p.allowed_domains, p.linked_at, p.linked_by, u.name AS by_name, p.linked_by_account
       FROM org_identity_provider p LEFT JOIN app_user u ON u.id = p.linked_by
      WHERE p.org_id = $1 AND p.provider = 'microsoft'`,
    [orgId],
  );
  if (!r) return null;
  return {
    tenantId: r.tenant_id,
    allowedDomains: r.allowed_domains ?? [],
    linkedAt: new Date(r.linked_at).toISOString(),
    linkedBy: r.linked_by ? { id: r.linked_by, name: r.by_name ?? '' } : null,
    linkedByAccount: r.linked_by_account,
  };
}

/** May this user (still) connect or disconnect the organisation's tenant? user:write or platform:admin. */
async function mayManageSignIn(userId: string, orgId: string): Promise<boolean> {
  const r = await one<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM app_user u JOIN user_role ur ON ur.user_id = u.id JOIN role r ON r.id = ur.role_id
        WHERE u.id = $1 AND u.org_id = $2 AND u.status = 'active'
          AND ((ur.scope_type = 'org' AND 'user:write' = ANY(r.permissions)) OR 'platform:admin' = ANY(r.permissions))) AS ok`,
    [userId, orgId],
  );
  return r?.ok === true;
}

/**
 * Entra directory roles (role TEMPLATE ids, the same in every tenant) whose holders may connect
 * their tenant to a PlugSure organisation: they could grant the app tenant-wide consent anyway.
 */
export const TENANT_ADMIN_ROLES: Record<string, string> = {
  '62e90394-69f5-4237-9190-012177145e10': 'Global Administrator',
  'e8611ab8-c189-46e8-94e1-60213ab1f814': 'Privileged Role Administrator',
  '158c047a-c907-4556-b7ef-446551a6b5f7': 'Cloud Application Administrator',
  '9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3': 'Application Administrator',
};

/**
 * Proof that the account connecting a tenant may speak for it (v1.6.0 review, "tenant
 * squatting"): any account of a tenant — a temp worker, a trial tenant someone made — used to be
 * enough to claim the tenant for an organisation, which then blocked its real owner (one
 * organisation per tenant). Now the account must be a MEMBER of the tenant (not a guest) holding
 * one of TENANT_ADMIN_ROLES, read from the ID token's `wids` claim. The app registration must
 * emit `wids` ("Directory roles" groups claim, deploy/MICROSOFT-SIGN-IN.md); without the claim
 * the refusal says so ('roles_missing') rather than blaming the person.
 */
export function assertTenantAdmin(c: MicrosoftClaims): string {
  if (c.guest) throw new MicrosoftSignInError('guest_account', 'the connecting account is a guest of the tenant, not a member');
  if (c.wids === null) throw new MicrosoftSignInError('roles_missing', 'the ID token carries no wids claim (directory roles are not emitted by the app registration)');
  const role = c.wids.map((w) => TENANT_ADMIN_ROLES[w]).find(Boolean);
  if (!role) throw new MicrosoftSignInError('not_tenant_admin', `the connecting account holds none of the tenant administrator roles (wids: ${c.wids.slice(0, 10).join(',') || 'none'})`);
  return role;
}

/**
 * Record the tenant of a validated sign-in as the organisation's (link mode). Runs unscoped
 * (the callback), so it re-checks that the administrator who started it still may, and that
 * the Microsoft account is an administrator of the tenant (assertTenantAdmin).
 * A tenant belongs to one organisation: another's tenant is refused ('tenant_taken', without
 * naming the other organisation). Connecting a DIFFERENT tenant while one is connected is
 * refused ('already_linked'): disconnect first, which unbinds the users of the old one.
 */
export async function linkTenant(f: FinishedFlow): Promise<LinkedTenant & { provenRole: string }> {
  if (f.mode !== 'link' || !f.orgId || !f.userId) throw new MicrosoftSignInError('link_forbidden', 'not a link transaction');
  if (!(await mayManageSignIn(f.userId, f.orgId))) throw new MicrosoftSignInError('link_forbidden', 'the administrator no longer holds user:write');
  const provenRole = assertTenantAdmin(f.claims);
  const current = await linkedTenant(f.orgId);
  if (current && current.tenantId !== f.claims.tid) throw new MicrosoftSignInError('already_linked', `organisation already connected to tenant ${current.tenantId}`);
  const account = (f.claims.preferredUsername ?? f.claims.email ?? f.claims.oid).slice(0, 320);
  try {
    await query(
      `INSERT INTO org_identity_provider (org_id, provider, tenant_id, linked_by, linked_by_account)
       VALUES ($1, 'microsoft', $2, $3, $4)
       ON CONFLICT (org_id, provider) DO UPDATE SET linked_by = EXCLUDED.linked_by, linked_by_account = EXCLUDED.linked_by_account, linked_at = now()
         WHERE org_identity_provider.tenant_id = EXCLUDED.tenant_id`,
      [f.orgId, f.claims.tid, f.userId, account],
    );
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    if (err.code === '23505' && err.constraint === 'org_identity_provider_tenant_key') {
      throw new MicrosoftSignInError('tenant_taken', `tenant ${f.claims.tid} is connected to another organisation`);
    }
    throw e;
  }
  return { ...(await linkedTenant(f.orgId))!, provenRole };
}

/** Every connected tenant on the platform, for the platform operator (unscoped). */
export async function listAllTenants(): Promise<Array<{ orgId: string; orgName: string; tenantId: string; linkedAt: string; linkedByAccount: string | null; boundUsers: number }>> {
  return outsideRequestScope(async () => {
    const r = await query<{ org_id: string; org_name: string; tenant_id: string; linked_at: Date; linked_by_account: string | null; bound: number }>(
      `SELECT p.org_id, o.name AS org_name, p.tenant_id, p.linked_at, p.linked_by_account,
              (SELECT count(*)::int FROM app_user u WHERE u.org_id = p.org_id AND u.ms_object_id IS NOT NULL) AS bound
         FROM org_identity_provider p JOIN organisation o ON o.id = p.org_id
        WHERE p.provider = 'microsoft' ORDER BY p.linked_at DESC`,
    );
    return r.rows.map((x) => ({
      orgId: x.org_id, orgName: x.org_name, tenantId: x.tenant_id, linkedAt: new Date(x.linked_at).toISOString(),
      linkedByAccount: x.linked_by_account, boundUsers: x.bound,
    }));
  });
}

/**
 * The platform operator releases a tenant from whichever organisation holds it (a squatted
 * tenant, an operator gone away): exactly what that organisation's own "Disconnect" does, run
 * unscoped because it is another organisation's row. Returns the organisation, or null.
 */
export async function releaseTenant(tenantId: string): Promise<{ orgId: string; usersUnbound: number; sessionsEnded: number } | null> {
  return outsideRequestScope(async () => {
    const holder = await one<{ org_id: string }>(`SELECT org_id FROM org_identity_provider WHERE provider = 'microsoft' AND tenant_id = $1`, [tenantId]);
    if (!holder) return null;
    const r = await unlinkTenant(holder.org_id);
    return r ? { orgId: holder.org_id, usersUnbound: r.usersUnbound, sessionsEnded: r.sessionsEnded } : null;
  });
}

/**
 * Disconnect the organisation's tenant: the row goes, every user's binding to an account of it
 * goes (a later reconnection binds again by e-mail address; and another organisation could not
 * bind the same accounts while stale bindings held the unique index), and every session signed
 * in with Microsoft ends. Runs in the caller's (RLS) scope. Returns the tenant, or null.
 */
export async function unlinkTenant(orgId: string): Promise<{ tenantId: string; usersUnbound: number; sessionsEnded: number } | null> {
  const gone = await one<{ tenant_id: string }>(
    `DELETE FROM org_identity_provider WHERE org_id = $1 AND provider = 'microsoft' RETURNING tenant_id`,
    [orgId],
  );
  if (!gone) return null;
  const unbound = await query(
    `UPDATE app_user SET ms_tenant_id = NULL, ms_object_id = NULL, ms_bound_at = NULL WHERE org_id = $1 AND ms_object_id IS NOT NULL`,
    [orgId],
  );
  const ended = await query(
    `UPDATE auth_session SET revoked_at = now()
      WHERE auth_method = 'microsoft' AND revoked_at IS NULL AND user_id IN (SELECT id FROM app_user WHERE org_id = $1)`,
    [orgId],
  );
  return { tenantId: gone.tenant_id, usersUnbound: unbound.rowCount ?? 0, sessionsEnded: ended.rowCount ?? 0 };
}

/** The domains of `allowed_domains`, normalised; refuses anything that is not a plain domain name. */
export function normaliseDomains(v: unknown): string[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new MicrosoftSignInError('failed', 'allowedDomains must be a list of domain names');
  const out = new Set<string>();
  for (const raw of v) {
    const d = String(raw ?? '').trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
    if (!d) continue;
    if (d.length > 253 || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) {
      throw new MicrosoftSignInError('failed', `"${d.slice(0, 60)}" is not a domain name`);
    }
    out.add(d);
  }
  if (out.size > 20) throw new MicrosoftSignInError('failed', 'at most 20 domains');
  return [...out];
}

/** Change the allowed domains of the connected tenant. False when no tenant is connected. */
export async function setAllowedDomains(orgId: string, domains: string[]): Promise<boolean> {
  const r = await query(`UPDATE org_identity_provider SET allowed_domains = $2 WHERE org_id = $1 AND provider = 'microsoft'`, [orgId, domains]);
  return (r.rowCount ?? 0) > 0;
}

/** Unbind a user from their Microsoft account; their Microsoft sessions end. Caller's scope. */
export async function unbindUser(userId: string, orgId: string): Promise<{ tenantId: string; objectId: string } | null> {
  const before = await one<{ ms_tenant_id: string; ms_object_id: string }>(
    `SELECT ms_tenant_id, ms_object_id FROM app_user WHERE id = $1 AND org_id = $2 AND ms_object_id IS NOT NULL`,
    [userId, orgId],
  );
  if (!before) return null;
  await query(`UPDATE app_user SET ms_tenant_id = NULL, ms_object_id = NULL, ms_bound_at = NULL WHERE id = $1 AND org_id = $2`, [userId, orgId]);
  await query(`UPDATE auth_session SET revoked_at = now() WHERE user_id = $1 AND auth_method = 'microsoft' AND revoked_at IS NULL`, [userId]);
  return { tenantId: before.ms_tenant_id, objectId: before.ms_object_id };
}

export interface ResolvedUser {
  id: string;
  orgId: string;
  name: string;
  email: string;
  mfaEnabled: boolean;
  /** This sign-in bound the user to the Microsoft account (first match by e-mail address). */
  boundNow: boolean;
  /** Microsoft reported MFA and MS_TRUST_MFA_CLAIM allows counting it. */
  mfaSatisfied: boolean;
}

/** A refusal that knows which organisation / user it concerns, for the audit log. */
export class SignInRefused extends MicrosoftSignInError {
  constructor(code: MicrosoftRefusal, detail: string, public orgId: string | null = null, public userId: string | null = null) {
    super(code, detail);
  }
}

/**
 * Find the console user a validated Microsoft sign-in belongs to — never creating one.
 *
 *   1. the organisation whose connected tenant is the token's `tid` (none → not_linked);
 *   2. inside THAT organisation only: the user bound to (tid, oid); else the user whose
 *      e-mail address is the token's preferred_username (UPN) or email, case-insensitively
 *      (and in an allowed domain, when the organisation set any) — then bound to (tid, oid),
 *      so a later address change in Entra cannot move the sign-in to another console user;
 *   3. refused: no such user (no_user), a user bound to ANOTHER Microsoft account
 *      (oid_conflict), two users matching (ambiguous), disabled, locked, an administrator on a
 *      host outside CONSOLE_ADMIN_HOSTS, or on an operator's own console address an account of
 *      another operator (wrong_host).
 *
 * Runs unscoped (the callback): every query names the organisation.
 */
export async function resolveMicrosoftUser(
  claims: MicrosoftClaims,
  opts: { onlyOrgId?: string | null; refuseAdministrators?: boolean } = {},
): Promise<ResolvedUser> {
  const idp = await one<{ org_id: string; allowed_domains: string[] }>(
    `SELECT p.org_id, p.allowed_domains FROM org_identity_provider p JOIN organisation o ON o.id = p.org_id
      WHERE p.provider = 'microsoft' AND p.tenant_id = $1 AND o.archived_at IS NULL`,
    [claims.tid],
  );
  if (!idp) throw new SignInRefused('not_linked', `tenant ${claims.tid} is not connected to any organisation`);
  const orgId = idp.org_id;
  if (opts.onlyOrgId && opts.onlyOrgId !== orgId) {
    throw new SignInRefused('wrong_host', 'another operator\'s console address', orgId);
  }
  // A guest's sign-in speaks for its home directory, not for this tenant's staff list.
  if (claims.guest) throw new SignInRefused('guest_account', 'a guest account of the tenant (acct=1, a foreign idp or an #EXT# UPN)', orgId);

  type Row = {
    id: string; name: string; email: string; status: string; locked: boolean; mfa_enabled: boolean;
    ms_tenant_id: string | null; ms_object_id: string | null;
  };
  const cols = `id, name, email, status, (locked_until IS NOT NULL AND locked_until > now()) AS locked,
                (totp_secret IS NOT NULL AND totp_enabled_at IS NOT NULL) AS mfa_enabled, ms_tenant_id, ms_object_id`;

  let u = await one<Row>(`SELECT ${cols} FROM app_user WHERE org_id = $1 AND ms_tenant_id = $2 AND ms_object_id = $3`, [orgId, claims.tid, claims.oid]);
  let bind = false;
  if (!u) {
    /*
     * ONE address decides the first match (v1.6.0 review):
     *   · the UPN (`preferred_username`): in a work tenant it is on a domain the tenant has
     *     verified, and only the tenant's administrators change it;
     *   · `email` only when there is no usable UPN AND Microsoft says its domain is verified by
     *     the tenant (`xms_edov`): `email` is otherwise a free-text attribute ("never use it for
     *     authorization", Microsoft) — it must never outvote a UPN that names someone else.
     * A UPN with "#EXT#" (a guest's) is never used; guests were refused above anyway.
     */
    const allowed = idp.allowed_domains ?? [];
    const looksLikeAddress = (a: string | null): a is string => !!a && /^[^\s@]+@[^\s@]+$/.test(a) && !a.includes('#ext#');
    const address = looksLikeAddress(claims.preferredUsername)
      ? claims.preferredUsername
      : claims.emailVerified && looksLikeAddress(claims.email) ? claims.email : null;
    const candidates = address && (!allowed.length || allowed.includes(address.slice(address.lastIndexOf('@') + 1))) ? [address] : [];
    if (!candidates.length) {
      throw new SignInRefused('no_user', address
        ? `the address ${address} is not in the organisation's allowed domains`
        : 'the token carries no usable UPN, and no e-mail address verified by the tenant (xms_edov)', orgId);
    }
    const rows = await query<Row>(`SELECT ${cols} FROM app_user WHERE org_id = $1 AND lower(email) = ANY($2::text[])`, [orgId, candidates]);
    if (rows.rows.length > 1) throw new SignInRefused('ambiguous', 'preferred_username and email match two different users', orgId);
    u = rows.rows[0] ?? null;
    if (!u) throw new SignInRefused('no_user', 'no console user with this address in the organisation', orgId);
    if (u.ms_object_id) {
      throw new SignInRefused('oid_conflict', `the user is bound to another Microsoft account (${u.ms_tenant_id}/${u.ms_object_id}); this sign-in was ${claims.tid}/${claims.oid}`, orgId, u.id);
    }
    bind = true;
  }
  if (u.status !== 'active') throw new SignInRefused('disabled', `user status ${u.status}`, orgId, u.id);
  if (u.locked) throw new SignInRefused('locked', 'the account is locked after failed sign-ins', orgId, u.id);
  if (opts.refuseAdministrators && (await isAdministratorAccount(u.id))) {
    throw new SignInRefused('admin_host', 'administrator on a host outside CONSOLE_ADMIN_HOSTS', orgId, u.id);
  }
  if (bind) {
    try {
      const done = await one<{ id: string }>(
        `UPDATE app_user SET ms_tenant_id = $3, ms_object_id = $4, ms_bound_at = now()
          WHERE id = $1 AND org_id = $2 AND ms_object_id IS NULL RETURNING id`,
        [u.id, orgId, claims.tid, claims.oid],
      );
      if (!done) throw new SignInRefused('oid_conflict', 'the user was bound to another Microsoft account meanwhile', orgId, u.id);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new SignInRefused('oid_conflict', 'this Microsoft account is already bound to another console user', orgId, u.id);
      }
      throw e;
    }
  }
  return {
    id: u.id,
    orgId,
    name: u.name,
    email: u.email,
    mfaEnabled: u.mfa_enabled,
    boundNow: bind,
    /*
     * Microsoft's MFA stands in for the console's second factor — but NOT on the sign-in that
     * creates the binding (v1.6.0 review): that sign-in is matched by an address alone, so the
     * console's own factor (the code, or enrolment for an administrator) must vouch for the
     * person once before the Microsoft account is trusted on its own.
     */
    mfaSatisfied: !bind && microsoftMfaTrusted() && claims.amr.includes('mfa'),
  };
}

let warned = false;
/** Called at start-up: refuse a broken configuration, note an enabled one. */
export function assertMicrosoftConfigured(): void {
  const problem = microsoftConfigProblem();
  if (problem) throw new Error(`Sign in with Microsoft: ${problem} Refusing to start.`);
  if (microsoftEnabled() && !warned) {
    warned = true;
    logger.info({ authority: microsoftConfig().authorityBase }, '"Sign in with Microsoft" is enabled for the console');
  }
}

/**
 * A successful Microsoft sign-in ends an administrator-issued one-time password that is still
 * waiting to be used (v1.6.0 review): after a reset because the account was compromised, that
 * password (sent over chat or e-mail) must not stay a live way in while its owner signs in with
 * Microsoft. It is marked expired — not removed — so it stops working exactly as an unused
 * one-time password does after TEMP_PASSWORD_TTL_HOURS, and Users & Roles shows "one-time
 * password expired" (an administrator issues a new one if the person needs a password).
 * Returns whether one was ended.
 */
export async function endPendingOneTimePassword(userId: string): Promise<boolean> {
  const r = await query(
    `UPDATE app_user SET temp_password_expires_at = now()
      WHERE id = $1 AND must_change_password AND temp_password_expires_at IS NOT NULL AND temp_password_expires_at > now()`,
    [userId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** sha256 hex, as stored for state, nonce and the browser binding (tests). */
export const sha256Hex = sha256;
