import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { one, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { SYSTEM_ROLES, type Assignment, type Permission, type Principal } from './authz.js';

/**
 * Authentication.
 *
 * There was none. `principalFor()` took the tenant from an unvalidated
 * `x-org-id` request header and granted org_owner on whatever organisation the
 * caller named, so any network peer was a full administrator of any tenant.
 * A red-team pass read another organisation's fleet, sessions, compliance vault
 * and a driver's RFID token, and curtailed that organisation's chargers to 1 W.
 *
 * Two credential types:
 *   · API key   — `Authorization: Bearer psk_<prefix>_<secret>`, for machines.
 *   · Session   — `Authorization: Bearer pss_<secret>`, for the console.
 *
 * In both cases the ORGANISATION COMES FROM THE STORED CREDENTIAL, never from
 * the request. A header can no longer choose a tenant.
 */

const API_KEY_PREFIX = 'psk';
const SESSION_PREFIX = 'pss';
const SESSION_TTL_HOURS = 12;

/**
 * A console session idle longer than this is refused, even inside its 12-hour lifetime:
 * SESSION_IDLE_MINUTES, default 60. A browser left signed in on a shared depot PC used to stay
 * a working credential all day. Read on every call so tests and operators can change it.
 */
export function sessionIdleMinutes(): number {
  const n = Number(process.env.SESSION_IDLE_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

export interface AuthResult {
  principal: Principal;
  kind: 'api_key' | 'session' | 'dev';
  credentialId: string;
  /** True when the credential came from the console's session cookie. */
  viaCookie?: boolean;
  /**
   * The user still has an administrator-issued one-time password. The API then
   * serves only what is needed to choose a new one (see server.ts).
   */
  mustChangePassword?: boolean;
  /** An API key's own limit per minute; null = the installation default. */
  rateLimitPerMin?: number | null;
}

function sha256(v: string): string {
  return createHash('sha256').update(v, 'utf8').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// ------------------------------------------------------------------ API keys

export interface IssuedApiKey {
  id: string;
  /** Full secret. Shown exactly once, at creation. */
  key: string;
  prefix: string;
}

export async function issueApiKey(args: {
  orgId: string;
  name: string;
  permissions: Permission[];
  scopeType?: 'org' | 'site' | 'fleet';
  scopeId?: string | null;
  rateLimitPerMin?: number | null;
}): Promise<IssuedApiKey> {
  const prefix = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const key = `${API_KEY_PREFIX}_${prefix}_${secret}`;

  const row = await one<{ id: string }>(
    `INSERT INTO api_key (org_id, name, prefix, key_hash, permissions, scope_type, scope_id, rate_limit_per_min)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      args.orgId,
      args.name,
      prefix,
      sha256(secret),
      args.permissions,
      args.scopeType ?? 'org',
      args.scopeId ?? null,
      args.rateLimitPerMin ?? null,
    ],
  );
  logger.info({ orgId: args.orgId, prefix, name: args.name }, 'API key issued');
  return { id: row!.id, key, prefix };
}

export async function revokeApiKey(id: string, orgId: string): Promise<boolean> {
  const r = await query(`UPDATE api_key SET revoked_at = now() WHERE id = $1 AND org_id = $2`, [id, orgId]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Split `psk_<prefix>_<secret>`.
 *
 * The secret is base64url, whose alphabet INCLUDES `_`. Splitting on every `_`
 * and demanding exactly three parts therefore rejected any key whose 43-character
 * secret happened to contain one — roughly half of all issued credentials, which
 * simply stopped working at random with an indistinguishable 401. The prefix is
 * hex and cannot contain `_`, so only the first two separators are structural;
 * everything after them is the secret.
 */
export function splitApiKey(token: string): { prefix: string; secret: string } | null {
  const first = token.indexOf('_');
  if (first < 0) return null;
  const second = token.indexOf('_', first + 1);
  if (second < 0) return null;
  const prefix = token.slice(first + 1, second);
  const secret = token.slice(second + 1);
  if (!/^[0-9a-f]{12}$/.test(prefix) || !secret) return null;
  return { prefix, secret };
}

async function authenticateApiKey(token: string): Promise<AuthResult | null> {
  const parsed = splitApiKey(token);
  if (!parsed) return null;
  const { prefix, secret } = parsed;

  const row = await one<{
    id: string;
    org_id: string;
    key_hash: string;
    permissions: string[];
    scope_type: string;
    scope_id: string | null;
    rate_limit_per_min: number | null;
  }>(
    `SELECT id, org_id, key_hash, permissions, scope_type, scope_id, rate_limit_per_min
       FROM api_key WHERE prefix = $1 AND revoked_at IS NULL`,
    [prefix],
  );
  if (!row) return null;
  if (!safeEqualHex(row.key_hash, sha256(secret))) return null;

  void query(`UPDATE api_key SET last_used_at = now() WHERE id = $1`, [row.id]).catch(() => {});

  return {
    kind: 'api_key',
    credentialId: row.id,
    rateLimitPerMin: row.rate_limit_per_min,
    principal: {
      userId: `apikey:${row.id}`,
      orgId: row.org_id,
      assignments: [
        {
          permissions: row.permissions as Permission[],
          scopeType: row.scope_type as Assignment['scopeType'],
          scopeId: row.scope_id,
        },
      ],
    },
  };
}

// ------------------------------------------------------------------ sessions

export async function createSession(userId: string): Promise<string> {
  const secret = randomBytes(32).toString('base64url');
  const token = `${SESSION_PREFIX}_${secret}`;
  await query(
    `INSERT INTO auth_session (user_id, token_hash, expires_at)
     VALUES ($1,$2, now() + ($3 || ' hours')::interval)`,
    [userId, sha256(secret), SESSION_TTL_HOURS],
  );
  return token;
}

/** `pss_<secret>` — again, the secret is base64url and may contain `_`. */
export function sessionSecret(token: string): string | null {
  const i = token.indexOf('_');
  if (i < 0) return null;
  const secret = token.slice(i + 1);
  return secret || null;
}

export async function revokeSession(token: string): Promise<void> {
  const secret = sessionSecret(token);
  if (!secret) return;
  await query(`UPDATE auth_session SET revoked_at = now() WHERE token_hash = $1`, [sha256(secret)]);
}

/**
 * End every session of a user except `keepToken` (the one making the request), e.g. after
 * the user changes their own password. With no token to keep, every session ends.
 */
export async function revokeOtherSessions(userId: string, keepToken: string | null): Promise<void> {
  const secret = keepToken ? sessionSecret(keepToken) : null;
  await query(
    `UPDATE auth_session SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR token_hash <> $2::text)`,
    [userId, secret ? sha256(secret) : null],
  );
}

/** The console session token a request carries (Bearer pss_… or the session cookie), if any. */
export function sessionTokenOf(headers: Record<string, unknown>): string | null {
  const raw = headers['authorization'];
  if (typeof raw === 'string' && raw.startsWith('Bearer ')) {
    const t = raw.slice(7).trim();
    return t.startsWith(`${SESSION_PREFIX}_`) ? t : null;
  }
  return sessionFromCookie(headers['cookie']);
}

async function authenticateSession(token: string): Promise<AuthResult | null> {
  const secret = sessionSecret(token);
  if (!secret) return null;

  // Idle sessions are refused like expired ones (last_seen_at, migration 053).
  const row = await one<{ id: string; user_id: string; org_id: string; must_change_password: boolean; touch: boolean }>(
    `SELECT s.id, s.user_id, u.org_id, u.must_change_password,
            s.last_seen_at < now() - interval '1 minute' AS touch
       FROM auth_session s JOIN app_user u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND s.last_seen_at > now() - ($2 || ' minutes')::interval
        AND u.status = 'active'`,
    [sha256(secret), sessionIdleMinutes()],
  );
  if (!row) return null;
  // Activity keeps the session alive. Written at most once a minute, not on every request:
  // the console polls, and a write per poll per tab is pointless load on a hot row.
  if (row.touch) await query(`UPDATE auth_session SET last_seen_at = now() WHERE id = $1`, [row.id]);

  const grants = await loadAssignments(row.user_id, row.org_id);
  return {
    kind: 'session',
    credentialId: row.id,
    mustChangePassword: row.must_change_password === true,
    principal: {
      userId: row.user_id,
      orgId: row.org_id,
      assignments: grants.assignments,
      ...(grants.ownerIds.length ? { ownerIds: grants.ownerIds } : {}),
      ...(grants.fleetAccountIds.length ? { fleetAccountIds: grants.fleetAccountIds } : {}),
    },
  };
}

async function loadAssignments(userId: string, orgId: string): Promise<{ assignments: Assignment[]; ownerIds: string[]; fleetAccountIds: string[] }> {
  const rows = await query<{ permissions: string[]; scope_type: string; scope_id: string | null }>(
    `SELECT r.permissions, ur.scope_type, ur.scope_id
       FROM user_role ur JOIN role r ON r.id = ur.role_id
      WHERE ur.user_id = $1`,
    [userId],
  );
  if (rows.rows.length === 0) {
    // A user with no explicit grants gets read-only visibility of their own org,
    // never more. Failing open here would recreate the original defect.
    return { assignments: [{ permissions: SYSTEM_ROLES.support_readonly!, scopeType: 'org', scopeId: orgId }], ownerIds: [], fleetAccountIds: [] };
  }
  const assignments: Assignment[] = [];
  const ownerIds: string[] = [];
  const fleetAccountIds: string[] = [];
  for (const r of rows.rows) {
    if (r.scope_type === 'owner') {
      // An owner grant covers exactly that owner's CURRENT sites (in this org),
      // expanded on every request so a newly assigned site shows at once. An
      // owner with no sites yields NO access — never the org-wide fallback above.
      if (!r.scope_id) continue;
      ownerIds.push(r.scope_id);
      const sites = await query<{ id: string }>(
        `SELECT s.id FROM site s JOIN site_owner o ON o.id = s.owner_id
          WHERE s.owner_id = $1 AND s.org_id = $2 AND o.org_id = $2 AND o.archived_at IS NULL`,
        [r.scope_id, orgId],
      );
      for (const s of sites.rows) {
        assignments.push({ permissions: r.permissions as Permission[], scopeType: 'site', scopeId: s.id });
      }
      continue;
    }
    if (r.scope_type === 'fleet') {
      // A fleet-portal grant counts only for a live fleet account of this organisation.
      if (!r.scope_id) continue;
      const a = await query(`SELECT 1 FROM fleet_account WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [r.scope_id, orgId]);
      if (!a.rowCount) continue;
      fleetAccountIds.push(r.scope_id);
      assignments.push({ permissions: r.permissions as Permission[], scopeType: 'fleet', scopeId: r.scope_id });
      continue;
    }
    assignments.push({ permissions: r.permissions as Permission[], scopeType: r.scope_type as Assignment['scopeType'], scopeId: r.scope_id });
  }
  return { assignments, ownerIds, fleetAccountIds };
}

// ------------------------------------------------------------------ entry point

export class UnauthenticatedError extends Error {
  statusCode = 401;
  constructor(message = 'authentication required') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

/** The console's session cookie. HttpOnly, SameSite=Strict; see api/server.ts. */
export const SESSION_COOKIE = 'ps_session';

/** Pull the session token out of a Cookie header, if present and well-formed. */
export function sessionFromCookie(cookieHeader: unknown): string | null {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    let v: string;
    try {
      v = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null; // malformed %-escape: not a credential (was an uncaught URIError -> 500)
    }
    return v.startsWith(`${SESSION_PREFIX}_`) ? v : null;
  }
  return null;
}

export async function authenticate(headers: Record<string, unknown>): Promise<AuthResult> {
  const raw = headers['authorization'];
  const header = typeof raw === 'string' ? raw : undefined;

  if (!header?.startsWith('Bearer ')) {
    /**
     * The operator console authenticates with an HttpOnly session cookie, because
     * EventSource (the live stream) cannot send an Authorization header and a
     * token in localStorage is readable by any script that lands on the page.
     * Cross-site use of the cookie is blocked by SameSite=Strict, and the API
     * additionally requires a custom header on every state-changing request made
     * with it (see the CSRF check in api/server.ts).
     */
    const cookieToken = sessionFromCookie(headers['cookie']);
    if (cookieToken) {
      const viaCookie = await authenticateSession(cookieToken);
      if (viaCookie) return { ...viaCookie, viaCookie: true };
    }
    if (allowDevBypass()) return devPrincipal();
    throw new UnauthenticatedError('missing Bearer credentials');
  }

  const token = header.slice(7).trim();
  const result = token.startsWith(`${API_KEY_PREFIX}_`)
    ? await authenticateApiKey(token)
    : token.startsWith(`${SESSION_PREFIX}_`)
      ? await authenticateSession(token)
      : null;

  if (!result) throw new UnauthenticatedError('invalid or expired credentials');
  return result;
}

/**
 * Development bypass. Refuses to engage outside development, so an operator who
 * copies a `.env` to production cannot accidentally ship an open API.
 */
function allowDevBypass(): boolean {
  return config.api.devNoAuth && config.env === 'development';
}

let warnedDevBypass = false;

async function devPrincipal(): Promise<AuthResult> {
  if (!warnedDevBypass) {
    warnedDevBypass = true;
    logger.warn('API_DEV_NO_AUTH is on — every request is a full org_owner. Development only.');
  }
  const org = await one<{ id: string }>(`SELECT id FROM organisation ORDER BY created_at LIMIT 1`);
  if (!org) throw new UnauthenticatedError('no organisation — run `npm run seed`');
  return {
    kind: 'dev',
    credentialId: 'dev',
    principal: {
      userId: 'dev-user',
      orgId: org.id,
      assignments: [{ permissions: SYSTEM_ROLES.org_owner!, scopeType: 'org', scopeId: null }],
    },
  };
}

export function assertAuthConfigured(): void {
  if (config.api.devNoAuth && config.env !== 'development') {
    throw new Error(
      `API_DEV_NO_AUTH is set but NODE_ENV is "${config.env}". That combination would expose every ` +
        'tenant to any caller. Refusing to start.',
    );
  }
}

// ------------------------------------------------------------ resource → owner

/**
 * Resolve which organisation owns a resource.
 *
 * Every route that accepts a raw identifier from the caller MUST resolve the
 * owning organisation and compare it to the principal's. The frames, command and
 * site-power routes previously did not, so any tenant could read another
 * tenant's OCPP frames — including driver RFID tokens — and reset their chargers.
 */
export async function orgOfChargePoint(ocppIdentity: string): Promise<{ orgId: string; siteId: string; chargePointId: string } | null> {
  return one(
    `SELECT s.org_id AS "orgId", s.id AS "siteId", cp.id AS "chargePointId"
       FROM charge_point cp JOIN site s ON s.id = cp.site_id
      WHERE cp.ocpp_identity = $1`,
    [ocppIdentity],
  );
}

export async function orgOfSite(siteId: string): Promise<{ orgId: string } | null> {
  return one(`SELECT org_id AS "orgId" FROM site WHERE id = $1`, [siteId]);
}

export async function orgOfSession(sessionId: string): Promise<{ orgId: string; siteId: string } | null> {
  return one(`SELECT org_id AS "orgId", site_id AS "siteId" FROM charging_session WHERE id = $1`, [sessionId]);
}
