import QRCode from 'qrcode';
import { one, query } from '../db/pool.js';
import { logger } from '../logger.js';
import { seal, unseal } from './secrets.js';
import { type AuthMethod, consumePendingSession, createSession, pendingSession, revokeOtherSessions, revokeSession } from './auth.js';
import { config } from '../config.js';
import { claimSignInAttempt, clearSignInFailures } from './users.js';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  looksLikeTotp,
  matchTotp,
  otpauthUri,
} from './totp.js';

/**
 * Two-step verification for console accounts: an authenticator app (TOTP, RFC 6238) as
 * the second factor, recovery codes for a lost phone.
 *
 *   enrol      beginEnrolment → a fresh secret, sealed into totp_pending_secret, shown once
 *              as a QR code; confirmEnrolment(code) proves the app has it, promotes it to
 *              totp_secret and returns ten recovery codes (only their hashes are kept).
 *   sign in    users.login() answers a right password on such an account with a five-minute
 *              PENDING session (auth_session.mfa_pending); completeSignIn(code) replaces it
 *              with a full session. Wrong codes count against the account's ordinary
 *              sign-in lockout (LOGIN_MAX_FAILURES / LOGIN_LOCK_MINUTES).
 *   replay     a code is accepted only for a time step LATER than the last accepted one,
 *              recorded in the same statement that accepts it.
 *   recovery   a recovery code is removed from the account in the statement that accepts it.
 *   reset      an administrator clears it (resetMfa); the user enrols again at next sign-in
 *              when it is required for them.
 *
 * Secrets are sealed with SECRETS_KEY, with the user id as associated data, so a sealed
 * secret copied onto another account does not open (services/secrets.ts).
 */

export const MFA_ISSUER = 'PlugSure';

const aad = (userId: string, which: 'totp' | 'totp_pending') => `app_user:${userId}:${which}`;

export interface MfaStatus {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
}

export async function mfaStatus(userId: string): Promise<MfaStatus> {
  const r = await one<{ enabled_at: Date | null; has_secret: boolean; left: number }>(
    `SELECT totp_enabled_at AS enabled_at, (totp_secret IS NOT NULL) AS has_secret,
            cardinality(totp_recovery_hashes) AS left
       FROM app_user WHERE id = $1`,
    [userId],
  );
  const enabled = !!r?.has_secret && !!r?.enabled_at;
  return {
    enabled,
    enabledAt: enabled ? new Date(r!.enabled_at!).toISOString() : null,
    recoveryCodesLeft: enabled ? Number(r!.left ?? 0) : 0,
  };
}

export class MfaError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'MfaError';
  }
}

/**
 * Start (or restart) enrolment: a new secret, kept sealed as PENDING until a code proves
 * the authenticator app has it. Refused while two-step verification is on: replacing a
 * working secret is an administrator's reset, not something a session can do on its own.
 */
export async function beginEnrolment(userId: string, account: string): Promise<{ secret: string; uri: string; qrDataUrl: string }> {
  const st = await mfaStatus(userId);
  if (st.enabled) throw new MfaError('two-step verification is already on for this account');
  const secret = generateTotpSecret();
  await query(`UPDATE app_user SET totp_pending_secret = $2 WHERE id = $1`, [userId, seal(base32Encode(secret), aad(userId, 'totp_pending'))]);
  const uri = otpauthUri({ issuer: MFA_ISSUER, account, secret });
  const qrDataUrl = await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
  return { secret: base32Encode(secret), uri, qrDataUrl };
}

/**
 * Finish enrolment with a code from the app. Returns the recovery codes, in clear, ONCE.
 * Every other session of the account is ended: they were opened with a password alone.
 */
export async function confirmEnrolment(
  userId: string,
  code: unknown,
  keepToken: string | null,
  nowMs = Date.now(),
): Promise<{ recoveryCodes: string[] }> {
  const r = await one<{ pending: string | null; enabled: boolean }>(
    `SELECT totp_pending_secret AS pending, (totp_secret IS NOT NULL AND totp_enabled_at IS NOT NULL) AS enabled
       FROM app_user WHERE id = $1`,
    [userId],
  );
  if (!r) throw new MfaError('user not found');
  if (r.enabled) throw new MfaError('two-step verification is already on for this account');
  if (!r.pending) throw new MfaError('start the set-up first');
  const secretB32 = unseal(r.pending, aad(userId, 'totp_pending'));
  const step = matchTotp(base32Decode(secretB32), String(code ?? ''), nowMs);
  if (step === null) throw new MfaError('that code is not right — check the time on your phone and try the current code');

  const codes = generateRecoveryCodes();
  // Conditional on the pending secret still being the one checked: two confirmations racing
  // (two tabs) cannot leave the account with recovery codes from the losing one.
  const done = await one<{ id: string }>(
    `UPDATE app_user
        SET totp_secret = $3, totp_enabled_at = now(), totp_last_step = $4,
            totp_pending_secret = NULL, totp_recovery_hashes = $5
      WHERE id = $1 AND totp_pending_secret = $2 AND totp_secret IS NULL
      RETURNING id`,
    [userId, r.pending, seal(secretB32, aad(userId, 'totp')), step, codes.map(hashRecoveryCode)],
  );
  if (!done) throw new MfaError('the set-up changed meanwhile — start again');
  await revokeOtherSessions(userId, keepToken);
  return { recoveryCodes: codes };
}

/**
 * Check a second factor for `userId`: a six-digit code (not replayable) or a recovery code
 * (single use). Does NOT touch the lockout counter; see completeSignIn.
 */
export async function checkSecondFactor(
  userId: string,
  code: unknown,
  nowMs = Date.now(),
): Promise<{ ok: true; method: 'totp' | 'recovery_code'; recoveryCodesLeft?: number } | { ok: false; replay?: boolean }> {
  const c = String(code ?? '').trim();
  if (!c || c.length > 64) return { ok: false };
  const r = await one<{ secret: string | null; last_step: string | null }>(
    `SELECT totp_secret AS secret, totp_last_step AS last_step FROM app_user WHERE id = $1 AND totp_enabled_at IS NOT NULL`,
    [userId],
  );
  if (!r?.secret) return { ok: false };

  if (looksLikeTotp(c)) {
    const secret = base32Decode(unseal(r.secret, aad(userId, 'totp')));
    const lastStep = r.last_step === null ? null : Number(r.last_step);
    const step = matchTotp(secret, c, nowMs, lastStep);
    if (step === null) {
      // Diagnostics only: the same answer either way.
      const replay = lastStep !== null && matchTotp(secret, c, nowMs) !== null;
      return { ok: false, replay };
    }
    // The step is recorded only if no other request recorded it (or a later one) first:
    // of two concurrent uses of one code, exactly one is accepted.
    const took = await one<{ id: string }>(
      `UPDATE app_user SET totp_last_step = $2
        WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id`,
      [userId, step],
    );
    return took ? { ok: true, method: 'totp' } : { ok: false, replay: true };
  }

  const used = await one<{ left: number }>(
    `UPDATE app_user SET totp_recovery_hashes = array_remove(totp_recovery_hashes, $2)
      WHERE id = $1 AND $2 = ANY(totp_recovery_hashes)
      RETURNING cardinality(totp_recovery_hashes) AS left`,
    [userId, hashRecoveryCode(c)],
  );
  return used ? { ok: true, method: 'recovery_code', recoveryCodesLeft: Number(used.left) } : { ok: false };
}

export type CompleteSignInResult =
  | { ok: true; token: string; method: 'totp' | 'recovery_code'; recoveryCodesLeft?: number; authMethod: AuthMethod }
  | { ok: false; error: string; locked?: boolean; replay?: boolean };

/**
 * The second step of a sign-in, on a PENDING session (`pendingToken`). Each attempt takes
 * a slot of the account's sign-in lockout BEFORE the code is checked (the same counter as
 * passwords, so a burst cannot outrun it). When the lock engages the pending session is
 * ended too: the next try starts again from the password. A right code clears the counter,
 * ends the pending session and returns a fresh full one.
 *
 * Runs outside the request's transaction (see the route): a wrong code is a 4xx, which
 * rolls the request transaction back, and the failure must still be counted.
 */
export async function completeSignIn(userId: string, pendingToken: string, code: unknown, nowMs = Date.now()): Promise<CompleteSignInResult> {
  // One answer for a wrong, replayed or locked-out code; it names the pause, like the password step.
  const failure = {
    ok: false as const,
    error: `invalid code (after ${config.console.loginMaxFailures} failed attempts, sign-in pauses for ${config.console.loginLockMinutes} minutes)`,
  };
  // Only a pending session takes a code: a full session has nothing to complete.
  if (!(await pendingSession(pendingToken, userId))) return { ok: false, error: 'sign in with your password first', locked: true };
  const claimed = await claimSignInAttempt(userId);
  if (!claimed) {
    await revokeSession(pendingToken);
    return { ...failure, locked: true };
  }
  const r = await checkSecondFactor(userId, code, nowMs);
  if (!r.ok) {
    if (claimed.locked_now) {
      logger.warn({ userId }, 'operator account locked after repeated wrong two-step verification codes');
      await revokeSession(pendingToken);
      return { ...failure, locked: true, replay: r.replay };
    }
    return { ...failure, replay: r.replay };
  }
  // Consumed atomically: two right codes racing on one pending session yield one session.
  const consumed = await consumePendingSession(pendingToken, userId);
  if (!consumed) return { ok: false, error: 'sign in with your password first', locked: true };
  await clearSignInFailures(userId);
  // The full session keeps how the first step was done (password or Microsoft).
  const token = await createSession(userId, { authMethod: consumed.authMethod });
  return { ok: true, token, method: r.method, recoveryCodesLeft: r.recoveryCodesLeft, authMethod: consumed.authMethod };
}

/**
 * An administrator's reset (lost phone and recovery codes, or a suspected compromise):
 * the secret, any pending enrolment and every recovery code go, and every session of the
 * account ends. Where two-step verification is required the user enrols again at next sign-in.
 */
export async function resetMfa(userId: string): Promise<void> {
  await query(
    `UPDATE app_user
        SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL,
            totp_last_step = NULL, totp_recovery_hashes = '{}'
      WHERE id = $1`,
    [userId],
  );
  await query(`UPDATE auth_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
}
