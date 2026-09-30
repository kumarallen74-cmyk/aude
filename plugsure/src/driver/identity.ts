import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { one, query } from '../db/pool.js';
import { config, isRelaxedEnv } from '../config.js';
import { logger } from '../logger.js';
import { hashPassword, verifyPassword } from '../services/users.js';
import { normaliseUid } from '../services/tokens.js';
import { sendCode, maskPhone } from '../integrations/otp.js';

/**
 * Driver identity for the public app — guest first.
 *
 * A driver at a public charger is not an operator: they charge across many CPO
 * tenants, most never sign in, and the ones who do own a phone number, not an
 * organisation. So this is a PLATFORM-level surface. It never enters the
 * per-request org scope, and every read filters explicitly by driver identity.
 *
 * Three tiers, in order of how much the driver has committed:
 *   guest   — a device token in the phone, nothing more
 *   account — that device linked to a phone number by OTP
 *   fleet   — that device bound to a corporate RFID token by PIN, billed to the org
 */

const DEVICE_PREFIX = 'psd';

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** `psd_<secret>` — the secret is base64url and may contain '_', so split on the first only. */
function deviceSecret(token: string): string | null {
  if (!token.startsWith(`${DEVICE_PREFIX}_`)) return null;
  const secret = token.slice(DEVICE_PREFIX.length + 1);
  return secret.length >= 20 ? secret : null;
}

export interface DriverPrincipal {
  deviceId: string;
  appDriverId: string | null;
  fleetTokenId: string | null;
  /** Resolved when signed in as a fleet driver, for postpaid billing. */
  fleet: { tokenId: string; orgId: string; uid: string } | null;
  account: { id: string; phone: string; name: string | null } | null;
}

/** Issue a fresh anonymous device token. Called on first app open. */
export async function issueDevice(userAgent?: string): Promise<{ deviceToken: string; deviceId: string }> {
  const secret = randomBytes(32).toString('base64url');
  const row = await one<{ id: string }>(
    `INSERT INTO driver_device (device_hash, user_agent) VALUES ($1, $2) RETURNING id`,
    [sha256(secret), (userAgent ?? '').slice(0, 400)],
  );
  return { deviceToken: `${DEVICE_PREFIX}_${secret}`, deviceId: row!.id };
}

/** Resolve a device token to a principal, or null. Touches last_seen. */
export async function authenticateDriver(headers: Record<string, unknown>): Promise<DriverPrincipal | null> {
  const raw = String(headers['authorization'] ?? '');
  const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : '';
  const secret = deviceSecret(token);
  if (!secret) return null;

  const dev = await one<{
    id: string;
    app_driver_id: string | null;
    fleet_token_id: string | null;
  }>(
    `UPDATE driver_device SET last_seen_at = now()
      WHERE device_hash = $1
      RETURNING id, app_driver_id, fleet_token_id`,
    [sha256(secret)],
  );
  if (!dev) return null;

  let account: DriverPrincipal['account'] = null;
  if (dev.app_driver_id) {
    const a = await one<{ id: string; phone: string; name: string | null; status: string }>(
      `SELECT id, phone, name, status FROM app_driver WHERE id = $1`,
      [dev.app_driver_id],
    );
    if (a && a.status === 'active') account = { id: a.id, phone: a.phone, name: a.name };
  }

  let fleet: DriverPrincipal['fleet'] = null;
  if (dev.fleet_token_id) {
    const t = await one<{ id: string; org_id: string; uid: string; status: string }>(
      `SELECT id, org_id, uid, status FROM token WHERE id = $1`,
      [dev.fleet_token_id],
    );
    if (t && t.status === 'Accepted') fleet = { tokenId: t.id, orgId: t.org_id, uid: t.uid };
  }

  return {
    deviceId: dev.id,
    appDriverId: dev.app_driver_id,
    fleetTokenId: dev.fleet_token_id,
    fleet,
    account,
  };
}

// ─────────────────────────────────────────────────────────────────── OTP

const OTP_TTL_MS = 5 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_WINDOW_MS = 60_000;

/** Normalise an Indonesian phone number to E.164 (+62…). */
export function normalisePhone(raw: string): string | null {
  const digits = String(raw).replace(/[^\d+]/g, '');
  let n = digits;
  if (n.startsWith('+62')) n = n.slice(1);
  else if (n.startsWith('62')) {
    /* already */
  } else if (n.startsWith('0')) n = '62' + n.slice(1);
  else if (n.startsWith('8')) n = '62' + n;
  else return null;
  n = n.replace(/[^\d]/g, '');
  // Indonesian mobile numbers: 62 + 8xxxxxxxxx, total 11–15 digits.
  if (!/^628\d{8,12}$/.test(n)) return null;
  return '+' + n;
}

/**
 * Send an OTP. Returns the code ONLY in development, so the flow is testable
 * without an SMS provider wired up. In production the code is sent by SMS and
 * never returned to the caller.
 */
export async function sendOtp(phoneRaw: string, appName?: string): Promise<{ ok: true; devCode?: string } | { ok: false; error: string }> {
  const phone = normalisePhone(phoneRaw);
  if (!phone) return { ok: false, error: 'Nomor telepon tidak valid.' };

  // Throttle resends per phone.
  const recent = await one<{ created_at: Date }>(
    `SELECT created_at FROM driver_otp WHERE phone = $1 ORDER BY created_at DESC LIMIT 1`,
    [phone],
  );
  if (recent && Date.now() - new Date(recent.created_at).getTime() < OTP_RESEND_WINDOW_MS) {
    return { ok: false, error: 'Tunggu sebentar sebelum meminta kode baru.' };
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  // Sent by the provider configured in Govern → Integrations (WhatsApp / SMS, with
  // a fallback). The development provider shows the code in the app instead, and
  // is never used in production.
  const sent = await sendCode(phone, code, appName);
  if (!sent.ok) {
    logger.error({ phone: maskPhone(phone), err: sent.error }, 'driver sign-in code not sent');
    return { ok: false, error: sent.notConfigured ? 'Masuk dengan nomor HP belum tersedia. Hubungi operator.' : 'Kode tidak dapat dikirim. Coba lagi sebentar lagi.' };
  }
  await query(
    `INSERT INTO driver_otp (phone, code_hash, expires_at)
     VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)`,
    [phone, sha256(code), OTP_TTL_MS],
  );
  logger.info({ phone: maskPhone(phone), channel: sent.channel }, 'driver OTP issued');
  if (sent.devCode && isRelaxedEnv()) return { ok: true, devCode: sent.devCode };
  return { ok: true };
}

/**
 * Verify an OTP and link the device to the (created or existing) account.
 * Consumes the code, counts wrong guesses, and fails closed.
 */
export async function verifyOtp(
  deviceId: string,
  phoneRaw: string,
  code: string,
): Promise<{ ok: true; account: { id: string; phone: string; name: string | null } } | { ok: false; error: string }> {
  const phone = normalisePhone(phoneRaw);
  if (!phone) return { ok: false, error: 'Nomor telepon tidak valid.' };

  const otp = await one<{ id: string; code_hash: string; attempts: number }>(
    `SELECT id, code_hash, attempts FROM driver_otp
      WHERE phone = $1 AND consumed_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [phone],
  );
  if (!otp) return { ok: false, error: 'Kode sudah tidak berlaku. Minta kode baru.' };
  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    return { ok: false, error: 'Terlalu banyak percobaan. Minta kode baru.' };
  }

  if (!safeEqualHex(otp.code_hash, sha256(String(code).trim()))) {
    await query(`UPDATE driver_otp SET attempts = attempts + 1 WHERE id = $1`, [otp.id]);
    return { ok: false, error: 'Kode salah. Coba lagi.' };
  }

  await query(`UPDATE driver_otp SET consumed_at = now() WHERE id = $1`, [otp.id]);

  const account = await one<{ id: string; phone: string; name: string | null }>(
    `INSERT INTO app_driver (phone) VALUES ($1)
     ON CONFLICT (phone) DO UPDATE SET last_seen_at = now()
     RETURNING id, phone, name`,
    [phone],
  );
  await query(`UPDATE driver_device SET app_driver_id = $2 WHERE id = $1`, [deviceId, account!.id]);

  return { ok: true, account: account! };
}

/** Set the driver's display name on their account. */
export async function setDriverName(appDriverId: string, name: string): Promise<void> {
  const clean = String(name).trim().slice(0, 80);
  await query(`UPDATE app_driver SET name = $2 WHERE id = $1`, [appDriverId, clean || null]);
}

// ─────────────────────────────────────────────────────────────── fleet

/**
 * Log a device in as a fleet driver: prove possession of an RFID token by PIN.
 *
 * Knowing an RFID uid must not be enough to bill someone's fleet, so a PIN gates
 * it. The org is named by slug so a fleet driver does not need to know a UUID.
 */
export async function fleetLogin(
  deviceId: string,
  orgSlug: string,
  rfidUid: string,
  pin: string,
): Promise<{ ok: true; fleet: { tokenId: string; orgId: string; uid: string; orgName: string } } | { ok: false; error: string }> {
  const org = await one<{ id: string; name: string }>(
    `SELECT id, name FROM organisation WHERE slug = $1`,
    [String(orgSlug).trim().toLowerCase()],
  );
  if (!org) return { ok: false, error: 'Organisasi tidak ditemukan.' };

  // Cards are stored the way the RFID centre normalises them (hex serials upper
  // case); a driver typing the serial in lower case is the same card.
  const typed = String(rfidUid).trim();
  const tok = await one<{
    id: string;
    uid: string;
    pin_hash: string | null;
    status: string;
    valid_to: Date | null;
    pin_failures: number;
    pin_locked_until: Date | null;
  }>(
    `SELECT id, uid, pin_hash, status, valid_to, pin_failures, pin_locked_until FROM token
      WHERE org_id = $1 AND uid IN ($2, $3) AND kind = 'rfid'
      ORDER BY (uid = $2) DESC LIMIT 1`,
    [org.id, normaliseUid(typed), typed],
  );
  if (!tok) return { ok: false, error: 'Kartu RFID tidak dikenal.' };
  if (tok.status !== 'Accepted') return { ok: false, error: 'Kartu ini diblokir. Hubungi admin armada Anda.' };
  if (tok.valid_to && new Date(tok.valid_to) < new Date()) {
    return { ok: false, error: 'Kartu ini sudah kedaluwarsa. Hubungi admin armada Anda.' };
  }
  if (!tok.pin_hash) return { ok: false, error: 'Kartu ini belum diaktifkan untuk aplikasi. Hubungi admin armada Anda.' };
  if (tok.pin_locked_until && new Date(tok.pin_locked_until) > new Date()) {
    return { ok: false, error: 'Terlalu banyak PIN salah. Coba lagi nanti atau hubungi admin armada Anda.' };
  }

  if (!(await pinMatches(String(pin).trim(), tok.pin_hash))) {
    const failures = Number(tok.pin_failures ?? 0) + 1;
    await query(
      `UPDATE token SET pin_failures = $2::int,
              pin_locked_until = CASE WHEN $2::int >= $3::int THEN now() + make_interval(mins => $4::int) ELSE pin_locked_until END
        WHERE id = $1`,
      [tok.id, failures, FLEET_PIN_MAX_FAILURES, FLEET_PIN_LOCK_MINUTES],
    );
    if (failures >= FLEET_PIN_MAX_FAILURES) {
      logger.warn({ tokenId: tok.id }, 'fleet PIN locked after repeated failures');
      return { ok: false, error: 'Terlalu banyak PIN salah. Coba lagi nanti atau hubungi admin armada Anda.' };
    }
    return { ok: false, error: 'PIN salah.' };
  }

  // Success: clear the counter, and upgrade a legacy (v1.2) SHA-256 PIN to scrypt.
  const upgraded = tok.pin_hash.startsWith('scrypt$') ? null : await hashPassword(String(pin).trim());
  await query(
    `UPDATE token SET pin_failures = 0, pin_locked_until = NULL, pin_hash = COALESCE($2, pin_hash) WHERE id = $1`,
    [tok.id, upgraded],
  );
  await query(`UPDATE driver_device SET fleet_token_id = $2 WHERE id = $1`, [deviceId, tok.id]);
  return { ok: true, fleet: { tokenId: tok.id, orgId: org.id, uid: tok.uid, orgName: org.name } };
}

const FLEET_PIN_MAX_FAILURES = 5;
const FLEET_PIN_LOCK_MINUTES = 15;

/**
 * The RFID centre (v1.3) stores the app PIN as scrypt, the same KDF as operator
 * passwords. v1.2 stored an unsalted SHA-256; those still verify, and are
 * re-hashed on the next successful sign-in.
 */
async function pinMatches(pin: string, stored: string): Promise<boolean> {
  if (stored.startsWith('scrypt$')) return verifyPassword(pin, stored);
  return safeEqualHex(stored, sha256(pin));
}

/** Clear account and fleet bindings from a device (sign out). */
export async function signOutDevice(deviceId: string): Promise<void> {
  await query(
    `UPDATE driver_device SET app_driver_id = NULL, fleet_token_id = NULL WHERE id = $1`,
    [deviceId],
  );
}

export const _internal = { sha256 };
