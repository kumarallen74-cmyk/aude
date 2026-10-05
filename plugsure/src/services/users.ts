import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { one, many, query, tx } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { SYSTEM_ROLES, CONSOLE_ROLES } from './authz.js';
import { createSession, revokeOtherSessions } from './auth.js';

/**
 * Operator accounts for the console (SPEC Module 10).
 *
 * v1.2.1 had users, roles and a session table, and no way to sign in: nothing
 * called createSession(), the console sent no credentials at all and only worked
 * with the development auth bypass switched on. This is the missing front door.
 *
 * Passwords are scrypt (N=2^15, r=8, p=1), salted per user, compared in constant
 * time. Repeated failures lock the account for a while; the lock is per account,
 * and the global per-IP limiter in the API still applies on top.
 */

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

const N = 1 << 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
/** scrypt needs 128*N*r bytes; give it headroom above the 32 MiB default cap. */
const MAXMEM = 128 * N * R * 2;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64url');
  // A corrupt stored hash (bad N/r/p) must fail the login, not 500 it.
  const got = await scrypt(password, Buffer.from(saltB64, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * Number(n) * Number(r) * 2,
  }).catch(() => null);
  if (!got) return false;
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Returns an error message, or null when the password is acceptable. */
export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== 'string') return 'password is required';
  const min = config.console.passwordMinLength;
  if (pw.length < min) return `password must be at least ${min} characters`;
  if (pw.length > 256) return 'password is too long';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes < 3) return 'password must mix at least three of: lower case, upper case, digits, symbols';
  return null;
}

/**
 * How long an administrator-issued one-time password (invitation, reset, create-admin without
 * --password) works: TEMP_PASSWORD_TTL_HOURS, default 72. It used to work until first use, so
 * one pasted into a chat and never used stayed a live credential indefinitely. Read on every
 * call so a test or an operator can change it without a rebuild.
 */
export function tempPasswordTtlHours(): number {
  const n = Number(process.env.TEMP_PASSWORD_TTL_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 72;
}

/** A readable one-time password for invitations and resets. */
export function generateTemporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(14);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10)}!7`;
}

export interface LoginResult {
  ok: boolean;
  token?: string;
  error?: string;
  mustChangePassword?: boolean;
  /**
   * The password was right and the account has two-step verification: `token` is a
   * five-minute session that opens only POST /v1/auth/mfa/verify (services/mfa.ts).
   */
  mfaRequired?: boolean;
  user?: { id: string; name: string; email: string; orgId: string };
}

// A dummy hash so an unknown email costs the same scrypt work as a known one —
// otherwise response time reveals which addresses have accounts.
let dummyHash: string | null = null;

/**
 * verifyPassword with the same scrypt work every time: an account with no password yet (an
 * invitation not accepted) is checked against the dummy hash, and still never matches.
 */
async function checkPassword(pw: string, stored: string | null): Promise<boolean> {
  dummyHash ??= await hashPassword(randomBytes(12).toString('hex'));
  if (!stored) { await verifyPassword(pw, dummyHash); return false; }
  return verifyPassword(pw, stored);
}

/**
 * ONE answer for every failed sign-in: unknown address, wrong password, locked account, and
 * (v1.5.0) another operator's account on an operator's own console address. A distinct answer
 * would confirm the address had an account, or that the password was right. It names the
 * pause, so a person who really is locked out knows to wait.
 */
export const loginFailureMessage = () =>
  `invalid email or password (after ${config.console.loginMaxFailures} failed attempts, sign-in pauses for ${config.console.loginLockMinutes} minutes)`;

/**
 * Take one sign-in attempt slot for an account, or null when it is locked.
 *
 * The attempt is COUNTED before the password (or code) is checked, in one statement.
 * The counter used to be read, incremented in JavaScript after the (slow, deliberately)
 * password check, and written back as an absolute value: a burst of parallel guesses all
 * read the same count and together recorded one failure, so the lockout never engaged.
 * Now each attempt atomically takes a slot; the attempt that reaches the limit sets the
 * lock, and every later one finds the account locked and is refused whatever it sent.
 * Shared by the password step and the two-step verification code (services/mfa.ts), so
 * a stolen password buys LOGIN_MAX_FAILURES code guesses per lock window, not more.
 */
export async function claimSignInAttempt(userId: string): Promise<{ locked_now: boolean } | null> {
  return one<{ locked_now: boolean }>(
    `UPDATE app_user
        SET failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
            locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
      WHERE id = $1 AND (locked_until IS NULL OR locked_until <= now())
      RETURNING (locked_until IS NOT NULL AND locked_until > now()) AS locked_now`,
    [userId, config.console.loginMaxFailures, config.console.loginLockMinutes],
  );
}

/** A completed sign-in: the counter and any lock are cleared. */
export async function clearSignInFailures(userId: string): Promise<void> {
  await query(`UPDATE app_user SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [userId]);
}

/**
 * Is this account an administrator (services/auth.ts isAdministrator), from its stored
 * grants? For decisions taken before a session exists: CONSOLE_ADMIN_HOSTS at sign-in.
 */
export async function isAdministratorAccount(userId: string): Promise<boolean> {
  const r = await one<{ admin: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM user_role ur JOIN role r ON r.id = ur.role_id, unnest(r.permissions) AS p
        WHERE ur.user_id = $1 AND (p LIKE 'platform:%' OR p = 'user:write')) AS admin`,
    [userId],
  );
  return r?.admin === true;
}

/**
 * `onlyOrgId` (v1.5.0): the sign-in came to an operator's own console web address, where
 * only that operator's accounts may sign in. Any other account is refused exactly like a
 * wrong password: counted as a failed attempt, no session, nothing reset, the same answer.
 *
 * `refuseAdministrators`: the sign-in came to a host not in CONSOLE_ADMIN_HOSTS, so an
 * administrator account is refused the same way (an ordinary account signs in).
 *
 * An account with two-step verification gets `mfaRequired` and a pending session instead
 * of a session; the failure counter is NOT cleared until the code is right, or a caller
 * holding the password could reset it between code guesses.
 */
export async function login(
  emailRaw: unknown,
  password: unknown,
  ip?: string,
  onlyOrgId?: string | null,
  opts: { refuseAdministrators?: boolean } = {},
): Promise<LoginResult> {
  const email = String(emailRaw ?? '').trim().toLowerCase();
  const pw = String(password ?? '');
  const generic = { ok: false, error: loginFailureMessage() };
  if (!email || !pw) return generic;

  const u = await one<{
    id: string;
    org_id: string;
    name: string;
    email: string;
    status: string;
    password_hash: string | null;
    failed_logins: number;
    locked_until: Date | null;
    must_change_password: boolean;
    temp_expired: boolean;
    mfa_enabled: boolean;
  }>(
    `SELECT id, org_id, name, email, status, password_hash, failed_logins, locked_until, must_change_password,
            (must_change_password AND temp_password_expires_at IS NOT NULL AND temp_password_expires_at <= now()) AS temp_expired,
            (totp_secret IS NOT NULL AND totp_enabled_at IS NOT NULL) AS mfa_enabled
       FROM app_user WHERE lower(email) = $1`,
    [email],
  );

  if (!u) {
    await checkPassword(pw, null);
    return generic;
  }
  // Counted before the password is checked (claimSignInAttempt).
  const claimed = await claimSignInAttempt(u.id);
  if (!claimed) {
    // The same password work as any other attempt: an instant answer would reveal the lock
    // (and so the account) by timing alone. The password is not accepted, even if right.
    await checkPassword(pw, u.password_hash);
    return generic;
  }
  const good = await checkPassword(pw, u.password_hash);
  // An expired one-time password is refused with the same answer, after the same work: a
  // distinct message would confirm the address and that the password was right.
  if (!good || u.status !== 'active' || u.temp_expired || (onlyOrgId && u.org_id !== onlyOrgId)) {
    if (claimed.locked_now) logger.warn({ userId: u.id, ip }, 'operator account locked after repeated failed sign-ins');
    return generic;
  }

  // CONSOLE_ADMIN_HOSTS: an administrator on another host is refused like a wrong password.
  if (opts.refuseAdministrators && (await isAdministratorAccount(u.id))) {
    logger.warn({ userId: u.id, ip }, 'administrator sign-in refused: host is not in CONSOLE_ADMIN_HOSTS');
    return generic;
  }

  if (u.mfa_enabled) {
    // The attempt stays counted until the second factor is right (see above).
    return {
      ok: true,
      token: await createSession(u.id, { mfaPending: true }),
      mfaRequired: true,
      mustChangePassword: u.must_change_password,
      user: { id: u.id, name: u.name, email: u.email, orgId: u.org_id },
    };
  }

  await clearSignInFailures(u.id);
  const token = await createSession(u.id);
  return {
    ok: true,
    token,
    mustChangePassword: u.must_change_password,
    user: { id: u.id, name: u.name, email: u.email, orgId: u.org_id },
  };
}

/**
 * Change the signed-in user's own password.
 *
 * Every OTHER session of the account is revoked: a password change is what a user does when
 * they suspect someone else has it, and it used to leave that someone signed in for up to
 * 12 hours. `currentToken` is the session making the request (cookie or Bearer), which stays
 * signed in; without one (an unusual caller) every session ends.
 */
export async function changePassword(userId: string, current: unknown, next: unknown, currentToken?: string | null): Promise<string | null> {
  const u = await one<{ password_hash: string | null }>(`SELECT password_hash FROM app_user WHERE id = $1`, [userId]);
  if (!u) return 'user not found';
  if (!(await verifyPassword(String(current ?? ''), u.password_hash))) return 'current password is incorrect';
  const problem = passwordProblem(next);
  if (problem) return problem;
  await query(`UPDATE app_user SET password_hash = $2, must_change_password = false, temp_password_expires_at = NULL WHERE id = $1`, [
    userId,
    await hashPassword(String(next)),
  ]);
  await revokeOtherSessions(userId, currentToken ?? null);
  return null;
}

/** Make sure every system role exists with the permissions this build defines. */
export async function ensureSystemRoles(): Promise<void> {
  for (const [name, perms] of Object.entries(SYSTEM_ROLES)) {
    const existing = await one<{ id: string }>(`SELECT id FROM role WHERE org_id IS NULL AND name = $1`, [name]);
    if (existing) {
      await query(`UPDATE role SET permissions = $2 WHERE id = $1`, [existing.id, perms]);
    } else {
      await query(`INSERT INTO role (org_id, name, permissions) VALUES (NULL, $1, $2)`, [name, perms]);
    }
  }
}

export async function listUsers(orgId: string) {
  return many(
    `SELECT u.id, u.name, u.email, u.phone_display AS phone, u.status, u.created_at, u.last_login_at,
            (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked,
            (u.password_hash IS NOT NULL) AS has_password, u.must_change_password, u.temp_password_expires_at,
            -- An unused one-time password past TEMP_PASSWORD_TTL_HOURS no longer signs in: reset it.
            (u.must_change_password AND u.temp_password_expires_at IS NOT NULL AND u.temp_password_expires_at <= now()) AS temp_password_expired,
            (u.totp_secret IS NOT NULL AND u.totp_enabled_at IS NOT NULL) AS mfa_enabled,
            -- Bound to a Microsoft account (058): signs in with "Sign in with Microsoft" by its oid.
            (u.ms_object_id IS NOT NULL) AS microsoft_bound, u.ms_bound_at AS microsoft_bound_at,
            COALESCE(json_agg(json_build_object(
              'role', r.name, 'scopeType', ur.scope_type, 'scopeId', ur.scope_id, 'siteName', s.name, 'ownerName', so.name, 'fleetName', fa.name
            )) FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
       FROM app_user u
       LEFT JOIN user_role ur ON ur.user_id = u.id
       LEFT JOIN role r ON r.id = ur.role_id
       LEFT JOIN site s ON ur.scope_type = 'site' AND s.id = ur.scope_id
       LEFT JOIN site_owner so ON ur.scope_type = 'owner' AND so.id = ur.scope_id
       LEFT JOIN fleet_account fa ON ur.scope_type = 'fleet' AND fa.id = ur.scope_id
      WHERE u.org_id = $1
      GROUP BY u.id
      ORDER BY u.name`,
    [orgId],
  );
}

export interface UserInput {
  name: string;
  email: string;
  phone?: string | null;
  role: string;
  siteIds?: string[];
  /** For owner-scoped roles (Site Owner portal). */
  ownerId?: string | null;
  /** For fleet-scoped roles (fleet customer portal). */
  fleetAccountId?: string | null;
}

export function validRole(role: string): boolean {
  return CONSOLE_ROLES.some((r) => r.name === role);
}

/** Replace a user's role grants with exactly one console role (optionally site- or owner-scoped). */
export async function setUserRole(userId: string, orgId: string, role: string, siteIds: string[] = [], ownerId: string | null = null, fleetAccountId: string | null = null) {
  const r = await one<{ id: string }>(`SELECT id FROM role WHERE org_id IS NULL AND name = $1`, [role]);
  if (!r) throw new Error(`role ${role} is not provisioned`);
  await query(`DELETE FROM user_role WHERE user_id = $1`, [userId]);
  const def = CONSOLE_ROLES.find((x) => x.name === role);
  const siteScoped = def?.siteScoped;
  if (def?.fleetScoped) {
    if (!fleetAccountId) throw new Error('a fleet-scoped role needs a fleet account');
    await query(`INSERT INTO user_role (user_id, role_id, scope_type, scope_id) VALUES ($1,$2,'fleet',$3)`, [userId, r.id, fleetAccountId]);
  } else if (def?.ownerScoped) {
    if (!ownerId) throw new Error('an owner-scoped role needs an owner');
    await query(`INSERT INTO user_role (user_id, role_id, scope_type, scope_id) VALUES ($1,$2,'owner',$3)`, [userId, r.id, ownerId]);
  } else if (siteScoped) {
    for (const siteId of siteIds) {
      await query(`INSERT INTO user_role (user_id, role_id, scope_type, scope_id) VALUES ($1,$2,'site',$3)`, [
        userId,
        r.id,
        siteId,
      ]);
    }
  } else {
    await query(`INSERT INTO user_role (user_id, role_id, scope_type, scope_id) VALUES ($1,$2,'org',$3)`, [
      userId,
      r.id,
      orgId,
    ]);
  }
}

/**
 * The e-mail address is taken — in this organisation or, invisibly under row-level security,
 * in another one. The route answers both the same way (see POST /v1/users).
 */
export class EmailUnavailableError extends Error {
  constructor() {
    super('that email cannot be used');
    this.name = 'EmailUnavailableError';
  }
}

/** A unique violation on app_user's e-mail (the original UNIQUE(email) or 053's lower(email) index). */
function isEmailUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; table?: string; constraint?: string };
  return err?.code === '23505' && err.table === 'app_user' && /email/.test(err.constraint ?? '');
}

export async function createUser(orgId: string, input: UserInput): Promise<{ id: string; temporaryPassword: string }> {
  const temporaryPassword = generateTemporaryPassword();
  const hash = await hashPassword(temporaryPassword);
  /*
   * The route's duplicate check runs under row-level security and cannot see another
   * tenant's users, so an address taken elsewhere surfaces here as a unique violation —
   * which used to be a 500, telling an administrator that the address has an account in
   * some other organisation. It becomes EmailUnavailableError. The INSERT runs under a
   * savepoint so the failure does not abort the request's own transaction (tx() joins it).
   */
  const row = await tx(async (c) => {
    await c.query('SAVEPOINT create_user');
    try {
      const r = await c.query<{ id: string }>(
        `INSERT INTO app_user (org_id, email, name, phone_display, status, password_hash, must_change_password, temp_password_expires_at)
         VALUES ($1, lower($2), $3, $4, 'active', $5, true, now() + ($6 || ' hours')::interval)
         RETURNING id`,
        [orgId, input.email.trim(), input.name.trim(), input.phone ?? null, hash, tempPasswordTtlHours()],
      );
      await c.query('RELEASE SAVEPOINT create_user');
      return r.rows[0]!;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT create_user');
      if (isEmailUniqueViolation(e)) throw new EmailUnavailableError();
      throw e;
    }
  });
  await setUserRole(row.id, orgId, input.role, input.siteIds ?? [], input.ownerId ?? null, input.fleetAccountId ?? null);
  return { id: row.id, temporaryPassword };
}

export async function resetPassword(userId: string): Promise<string> {
  const temporaryPassword = generateTemporaryPassword();
  await query(
    `UPDATE app_user SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL,
            temp_password_expires_at = now() + ($3 || ' hours')::interval
      WHERE id = $1`,
    [userId, await hashPassword(temporaryPassword), tempPasswordTtlHours()],
  );
  // Every existing session for the account ends with the old password.
  await query(`UPDATE auth_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  return temporaryPassword;
}

export async function setUserStatus(userId: string, status: 'active' | 'disabled') {
  await query(`UPDATE app_user SET status = $2 WHERE id = $1`, [userId, status]);
  if (status === 'disabled') {
    await query(`UPDATE auth_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  }
}
