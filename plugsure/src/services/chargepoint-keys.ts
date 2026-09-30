import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { one, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { writeAudit } from './audit.js';
import { normaliseFingerprint } from '../ocpp/client-cert.js';

/**
 * OCPP 1.6 `AuthorizationKey` provisioning.
 *
 * The audit found this field was read in exactly one place and written nowhere,
 * so raising a charge point's security profile permanently rejected it. This is
 * the missing half.
 *
 * Spec constraints (OCA Security Whitepaper / 1.6 Edition 3):
 *  - randomly generated binary, 16–20 bytes, hex-encoded
 *  - WriteOnly: the charger must never return it in a GetConfiguration response,
 *    and we never store it in plaintext either
 *  - username on the wire is the chargePointId
 *
 * ROTATION ORDER MATTERS AND GETTING IT WRONG BRICKS THE CHARGER:
 * set AuthorizationKey FIRST, then raise SecurityProfile. During the grace window
 * both the previous and current key are accepted, because the charger may
 * reconnect with either depending on whether it applied the change.
 */

const KEY_BYTES = 20;

export interface IssuedKey {
  /** Plaintext. Returned exactly once, at issue. Never retrievable afterwards. */
  key: string;
  chargePointId: string;
  ocppIdentity: string;
  rotatedAt: Date;
  graceEndsAt: Date;
}

export function generateAuthorizationKey(): string {
  return randomBytes(KEY_BYTES).toString('hex');
}

function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Issue a new key. The current hash moves to `auth_key_prev_hash` so a charger
 * that has not yet applied the change can still connect during the grace window.
 */
/**
 * An operator-supplied key: 16–40 alphanumeric characters. Some chargers' local
 * commissioning apps only accept a key typed on a keypad, so the console lets an
 * installer set one — but never a short or low-entropy one.
 */
export function providedKeyProblem(key: string): string | null {
  if (!/^[A-Za-z0-9]{16,40}$/.test(key)) return 'the key must be 16–40 letters and digits';
  if (new Set(key.toLowerCase()).size < 8) return 'the key is too repetitive — use at least 8 distinct characters';
  return null;
}

export async function issueAuthorizationKey(
  chargePointId: string,
  actor: { type: 'user' | 'api_client' | 'system'; id?: string; orgId?: string; ip?: string },
  providedKey?: string,
): Promise<IssuedKey | null> {
  const cp = await one<{ id: string; ocpp_identity: string; auth_key_hash: string | null }>(
    `SELECT id, ocpp_identity, auth_key_hash FROM charge_point WHERE id = $1`,
    [chargePointId],
  );
  if (!cp) return null;

  const key = providedKey ?? generateAuthorizationKey();
  const row = await one<{ auth_key_rotated_at: Date }>(
    `UPDATE charge_point
        SET auth_key_prev_hash = auth_key_hash,
            auth_key_hash = $2,
            auth_key_rotated_at = now()
      WHERE id = $1
      RETURNING auth_key_rotated_at`,
    [chargePointId, hashKey(key)],
  );

  await writeAudit({
    orgId: actor.orgId ?? null,
    actorType: actor.type,
    actorId: actor.id ?? null,
    action: 'charge_point.authorization_key.issued',
    targetType: 'charge_point',
    targetId: cp.ocpp_identity,
    // Never log the key itself, not even hashed — the audit log is exportable.
    after: { rotated: true, previousKeyRetainedForGraceWindow: cp.auth_key_hash !== null },
    ip: actor.ip ?? null,
  });

  const rotatedAt = row?.auth_key_rotated_at ?? new Date();
  logger.info({ chargePointId, identity: cp.ocpp_identity }, 'AuthorizationKey issued');

  return {
    key,
    chargePointId: cp.id,
    ocppIdentity: cp.ocpp_identity,
    rotatedAt,
    graceEndsAt: new Date(rotatedAt.getTime() + config.gateway.keyRotationGraceMs),
  };
}

export interface KeyCheckResult {
  ok: boolean;
  /** Which key matched, for diagnostics and for closing the rotation window. */
  matched?: 'current' | 'previous';
  reason?: 'no_key_provisioned' | 'mismatch';
}

/** Constant-time check against the current key, and the previous one while in grace. */
export async function verifyAuthorizationKey(ocppIdentity: string, given: string): Promise<KeyCheckResult> {
  const row = await one<{
    auth_key_hash: string | null;
    auth_key_prev_hash: string | null;
    auth_key_rotated_at: Date | null;
  }>(
    `SELECT auth_key_hash, auth_key_prev_hash, auth_key_rotated_at
       FROM charge_point WHERE ocpp_identity = $1`,
    [ocppIdentity],
  );
  if (!row?.auth_key_hash) return { ok: false, reason: 'no_key_provisioned' };

  const givenHash = Buffer.from(hashKey(given), 'hex');

  if (constantTimeEquals(row.auth_key_hash, givenHash)) return { ok: true, matched: 'current' };

  const inGrace =
    row.auth_key_prev_hash &&
    row.auth_key_rotated_at &&
    Date.now() - new Date(row.auth_key_rotated_at).getTime() < config.gateway.keyRotationGraceMs;

  if (inGrace && constantTimeEquals(row.auth_key_prev_hash!, givenHash)) {
    return { ok: true, matched: 'previous' };
  }
  return { ok: false, reason: 'mismatch' };
}

function constantTimeEquals(storedHex: string, givenHash: Buffer): boolean {
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHex, 'hex');
  } catch {
    return false;
  }
  if (stored.length !== givenHash.length || stored.length === 0) return false;
  return timingSafeEqual(stored, givenHash);
}

/**
 * Close the rotation window once the charger has demonstrably applied the new key.
 * Called when a connection authenticates with the CURRENT key after a rotation.
 */
export async function retirePreviousKey(ocppIdentity: string): Promise<void> {
  await query(
    `UPDATE charge_point SET auth_key_prev_hash = NULL
      WHERE ocpp_identity = $1 AND auth_key_prev_hash IS NOT NULL`,
    [ocppIdentity],
  );
}

/**
 * Raise the enforced security profile. Refuses to do so before a key exists,
 * which is the specific mistake that bricks a field unit.
 */
export async function setSecurityProfile(
  chargePointId: string,
  profile: 0 | 1 | 2 | 3,
  actor: { type: 'user' | 'api_client' | 'system'; id?: string; orgId?: string; ip?: string },
): Promise<{ ok: boolean; error?: string }> {
  const cp = await one<{ ocpp_identity: string; auth_key_hash: string | null; client_cert_fingerprint: string | null }>(
    `SELECT ocpp_identity, auth_key_hash, client_cert_fingerprint FROM charge_point WHERE id = $1`,
    [chargePointId],
  );
  if (!cp) return { ok: false, error: 'charge point not found' };

  // Profile 3 authenticates with a client certificate, not the AuthorizationKey —
  // so it needs a cert binding, not a key. Profiles 1 and 2 need the key.
  if (profile >= 3) {
    if (!cp.client_cert_fingerprint) {
      return {
        ok: false,
        error:
          'Refusing to raise to Security Profile 3 before a client-certificate binding exists — ' +
          'the charge point would be permanently unable to connect. Bind the certificate fingerprint first.',
      };
    }
  } else if (profile >= 1 && !cp.auth_key_hash) {
    return {
      ok: false,
      error:
        'Refusing to raise the security profile before an AuthorizationKey exists — ' +
        'the charge point would be permanently unable to connect. Issue a key first.',
    };
  }
  if (profile >= 2 && !tlsAvailable()) {
    return {
      ok: false,
      error:
        'Security profile 2 requires TLS. Configure OCPP_TLS_KEY_PATH and OCPP_TLS_CERT_PATH, ' +
        'or terminate TLS at a proxy and set OCPP_TRUST_PROXY_PROTO=true.',
    };
  }

  await query(`UPDATE charge_point SET security_profile = $2 WHERE id = $1`, [chargePointId, profile]);
  await writeAudit({
    orgId: actor.orgId ?? null,
    actorType: actor.type,
    actorId: actor.id ?? null,
    action: 'charge_point.security_profile.changed',
    targetType: 'charge_point',
    targetId: cp.ocpp_identity,
    after: { securityProfile: profile },
    ip: actor.ip ?? null,
  });
  return { ok: true };
}

export function tlsAvailable(): boolean {
  return (
    (Boolean(config.gateway.tlsKeyPath) && Boolean(config.gateway.tlsCertPath)) ||
    config.gateway.trustProxyProto
  );
}

/**
 * Bind (or rotate) the client-certificate fingerprint for OCPP Security Profile 3.
 *
 * Stores only the SHA-256 fingerprint (never the certificate or a private key).
 * Accepts the OpenSSL colon form or plain hex; both are normalised to 64 lowercase
 * hex chars. Set this BEFORE raising the unit to Profile 3 — setSecurityProfile
 * refuses Profile 3 without it, mirroring the AuthorizationKey rule for Profile 2.
 * Pass an empty string to clear the binding.
 */
export async function setClientCertFingerprint(
  chargePointId: string,
  fingerprintRaw: string,
  actor: { type: 'user' | 'api_client' | 'system'; id?: string; orgId?: string; ip?: string },
): Promise<{ ok: boolean; error?: string; fingerprint?: string | null }> {
  const cp = await one<{ ocpp_identity: string }>(
    `SELECT ocpp_identity FROM charge_point WHERE id = $1`,
    [chargePointId],
  );
  if (!cp) return { ok: false, error: 'charge point not found' };

  const clearing = fingerprintRaw.trim() === '';
  const fingerprint = clearing ? null : normaliseFingerprint(fingerprintRaw);
  if (!clearing && !fingerprint) {
    return { ok: false, error: 'fingerprint must be a SHA-256 value (64 hex characters; colons allowed)' };
  }

  await query(`UPDATE charge_point SET client_cert_fingerprint = $2 WHERE id = $1`, [chargePointId, fingerprint]);
  await writeAudit({
    orgId: actor.orgId ?? null,
    actorType: actor.type,
    actorId: actor.id ?? null,
    action: 'charge_point.client_cert.bound',
    targetType: 'charge_point',
    targetId: cp.ocpp_identity,
    after: { clientCertFingerprint: fingerprint },
    ip: actor.ip ?? null,
  });
  logger.info({ chargePointId, identity: cp.ocpp_identity, cleared: clearing }, 'client certificate binding updated');
  return { ok: true, fingerprint };
}
