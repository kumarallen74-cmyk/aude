import { normaliseMobile } from '../domain/phone.js';
import type { CountryCode } from '../domain/country.js';
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
const OTP_RESEND_WINDOW_S = 60;
const HOUR_S = 3600;
const DAY_S = 24 * HOUR_S;

const envInt = (name: string, def: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : def;
};

/**
 * Limits on the unauthenticated sign-in steps. Read on every call (not at import)
 * so an operator can change them with a restart and tests can set them.
 *
 * Sending a code costs money (SMS / WhatsApp) and anyone can ask for one: a
 * device token is free, so per-device alone stops nothing, and before v1.3.1
 * the only brake was one code per minute per number — recorded AFTER the send,
 * so a parallel burst for one number all passed, and a failed send was never
 * throttled. "SMS pumping" (premium-rate numbers, or simply someone else's
 * bill) needs a per-address, per-number and an installation-wide cap.
 *
 *   DRIVER_OTP_PER_PHONE_PER_DAY        codes to one number per 24 h        (10)
 *   DRIVER_OTP_PER_IP_PER_HOUR          codes requested from one IP per hour (10; 1000 in development/test)
 *   DRIVER_OTP_PER_DEVICE_PER_HOUR      codes requested by one app install   (5;  1000 in development/test)
 *   DRIVER_OTP_GLOBAL_PER_DAY           codes sent by the installation       (5000; 100000 in development/test)
 *   DRIVER_OTP_VERIFY_FAILURES_PER_DAY  wrong codes for one number FROM ONE DEVICE per 24 h, across codes (10)
 *   DRIVER_PIN_FAILURES_PER_IP_PER_HOUR wrong fleet sign-ins from one IP per hour (20; 1000 in development/test)
 *
 * Plus one code per number per minute (fixed). The development/test defaults are
 * higher because every e2e suite signs drivers in from 127.0.0.1. An IP is
 * `req.ip`, which honours X-Forwarded-For only from API_TRUSTED_PROXIES. Mobile
 * carriers put many phones behind one address (CGNAT): raise the per-IP limits
 * if real drivers hit them.
 */
export function authLimits() {
  const relaxed = isRelaxedEnv();
  return {
    otpPerPhonePerDay: envInt('DRIVER_OTP_PER_PHONE_PER_DAY', 10),
    otpPerIpPerHour: envInt('DRIVER_OTP_PER_IP_PER_HOUR', relaxed ? 1000 : 10),
    otpPerDevicePerHour: envInt('DRIVER_OTP_PER_DEVICE_PER_HOUR', relaxed ? 1000 : 5),
    otpGlobalPerDay: envInt('DRIVER_OTP_GLOBAL_PER_DAY', relaxed ? 100_000 : 5000),
    otpVerifyFailuresPerDay: envInt('DRIVER_OTP_VERIFY_FAILURES_PER_DAY', 10),
    pinFailuresPerIpPerHour: envInt('DRIVER_PIN_FAILURES_PER_IP_PER_HOUR', relaxed ? 1000 : 20),
    // A fleet PIN can be 4 digits. The card lock alone (5 tries, 15 min) still allows
    // ~480 guesses a day — the whole space in three weeks. A daily budget per CARD,
    // across addresses, makes that 15 a day: about 18 months for 10,000 PINs.
    pinAttemptsPerCardPerDay: envInt('DRIVER_PIN_ATTEMPTS_PER_CARD_PER_DAY', 15),
  };
}

/**
 * Take one slot of a fixed-window counter (driver_auth_limit, migration 046), or
 * report that there is none left. ONE statement: the row lock taken by the upsert
 * serialises a parallel burst, and each request re-checks the limit against the
 * committed count, so N concurrent requests cannot all see "under the limit".
 * `minGapS`: also refuse while the previous slot is younger than this. (0 skips the
 * test outright: now() is each statement's transaction start, so a concurrent
 * claim's last_at can be a hair "in the future".)
 */
async function claimLimit(key: string, max: number, windowS: number, minGapS = 0): Promise<boolean> {
  const row = await one<{ hits: number }>(
    `INSERT INTO driver_auth_limit AS l (key, window_start, hits, last_at) VALUES ($1, now(), 1, now())
     ON CONFLICT (key) DO UPDATE SET
       hits = CASE WHEN l.window_start <= now() - make_interval(secs => $3::int) THEN 1 ELSE l.hits + 1 END,
       window_start = CASE WHEN l.window_start <= now() - make_interval(secs => $3::int) THEN now() ELSE l.window_start END,
       last_at = now()
     WHERE (l.window_start <= now() - make_interval(secs => $3::int) OR l.hits < $2::int)
       AND ($4::int = 0 OR l.last_at <= now() - make_interval(secs => $4::int))
     RETURNING hits`,
    [key, max, windowS, minGapS],
  );
  return !!row;
}

/** Give back a slot taken by claimLimit (the attempt turned out not to be a failure). */
async function refundLimit(key: string): Promise<void> {
  await query(`UPDATE driver_auth_limit SET hits = GREATEST(hits - 1, 0) WHERE key = $1`, [key]);
}

/** Is the counter full right now? A read, for refusing early without taking a slot. */
async function limitState(key: string, max: number, windowS: number, minGapS = 0): Promise<'ok' | 'gap' | 'full'> {
  const r = await one<{ full: boolean; gap: boolean }>(
    `SELECT (window_start > now() - make_interval(secs => $3::int) AND hits >= $2::int) AS full,
            ($4::int > 0 AND last_at > now() - make_interval(secs => $4::int)) AS gap
       FROM driver_auth_limit WHERE key = $1`,
    [key, max, windowS, minGapS],
  );
  return !r ? 'ok' : r.full ? 'full' : r.gap ? 'gap' : 'ok';
}

const MSG_WAIT = 'Tunggu sebentar sebelum meminta kode baru.';
const MSG_PHONE_DAY = 'Batas pengiriman kode untuk nomor ini hari ini sudah tercapai. Coba lagi besok.';
const MSG_BUSY = 'Terlalu banyak permintaan kode. Coba lagi nanti.';
const MSG_VERIFY_DAY = 'Terlalu banyak kode salah untuk nomor ini. Coba lagi besok.';

/**
 * The wrong-code budget is per number AND app install (v1.5.x).
 *
 * It used to be per number alone, and verifying never asked which device had requested the
 * code: anyone who knew a driver's number could request a code (it went to the driver's
 * phone) and send ten wrong guesses from their own device, and the number could then
 * neither verify nor receive a code for 24 hours. A sign-in lock-out for any driver, on
 * demand.
 *
 * Now a code can be verified only by the device that asked for it (driver_otp.device_id,
 * migration 055), and the failure budget is counted per (number, device). A stranger's
 * guesses use up only their own budget against codes only they asked for; the driver's
 * own device is untouched. The guessing bound is unchanged in substance: every code
 * still allows OTP_MAX_ATTEMPTS comparisons, and the number still gets at most
 * DRIVER_OTP_PER_PHONE_PER_DAY codes a day — so at most (codes × attempts) guesses a day
 * across ALL devices, which with the defaults is 50 tries at a 1-in-a-million code.
 * Rotating device tokens therefore buys nothing, and the per-address, per-device and
 * installation-wide SEND caps stay exactly as they were.
 */
const verifyKeyOf = (phone: string, deviceId: string | undefined) => `otp-verify:${phone}:${deviceId ?? '-'}`;

/**
 * Normalise a mobile number to E.164: Indonesian (+62), Malaysian (+60) or Singapore (+65).
 * Local forms (08…, 8…; 01… in Malaysia; 8/9xxxxxxx in Singapore) are read as `defaultCountry`'s,
 * so every Indonesian spelling lands on the same identity as before (domain/phone.ts).
 */
export function normalisePhone(raw: string, defaultCountry: CountryCode = 'ID'): string | null {
  return normaliseMobile(raw, defaultCountry);
}

/**
 * Send an OTP. Returns the code ONLY in development, so the flow is testable
 * without an SMS provider wired up. In production the code is sent by SMS and
 * never returned to the caller.
 *
 * Every limit is claimed BEFORE the provider is called (see authLimits), so a
 * burst cannot slip past, and a send that fails still counts (a failing
 * provider is retried by the driver a minute later, not hammered).
 * `limited` marks a refusal for a limit (HTTP 429).
 */
export async function sendOtp(
  phoneRaw: string,
  appName?: string,
  from: { ip?: string; deviceId?: string } = {},
): Promise<{ ok: true; devCode?: string } | { ok: false; error: string; limited?: true }> {
  const phone = normalisePhone(phoneRaw);
  if (!phone) return { ok: false, error: 'Nomor telepon tidak valid.' };
  const lim = authLimits();
  const phoneKey = `otp-phone:${phone}`;

  // Old counters go eventually; no window is longer than a day.
  if (Math.random() < 0.02) {
    query(`DELETE FROM driver_auth_limit WHERE last_at < now() - interval '2 days'`).catch(() => {});
  }

  // Refuse early, WITHOUT taking a slot, when this number cannot get a code anyway:
  // a driver tapping "send" again inside the minute must not use up the address's
  // budget, and someone hammering a victim's number must not keep its minute busy.
  // This device has used up its wrong guesses for this number: no new code for it either.
  if ((await limitState(verifyKeyOf(phone, from.deviceId), lim.otpVerifyFailuresPerDay, DAY_S)) === 'full') {
    return { ok: false, error: MSG_VERIFY_DAY, limited: true };
  }
  const pre = await limitState(phoneKey, lim.otpPerPhonePerDay, DAY_S, OTP_RESEND_WINDOW_S);
  if (pre === 'gap') return { ok: false, error: MSG_WAIT, limited: true };
  if (pre === 'full') return { ok: false, error: MSG_PHONE_DAY, limited: true };

  // The requester's budgets, then the installation's, then the number's (authoritative:
  // its claim is what serialises two concurrent sends to one number).
  if (from.ip && !(await claimLimit(`otp-ip:${from.ip}`, lim.otpPerIpPerHour, HOUR_S))) {
    logger.warn({ ip: from.ip }, 'driver OTP refused: per-address limit');
    return { ok: false, error: MSG_BUSY, limited: true };
  }
  if (from.deviceId && !(await claimLimit(`otp-device:${from.deviceId}`, lim.otpPerDevicePerHour, HOUR_S))) {
    return { ok: false, error: MSG_BUSY, limited: true };
  }
  if (!(await claimLimit('otp-global', lim.otpGlobalPerDay, DAY_S))) {
    logger.error({ limit: lim.otpGlobalPerDay }, 'driver OTP refused: installation-wide daily limit reached (DRIVER_OTP_GLOBAL_PER_DAY)');
    return { ok: false, error: MSG_BUSY, limited: true };
  }
  if (!(await claimLimit(phoneKey, lim.otpPerPhonePerDay, DAY_S, OTP_RESEND_WINDOW_S))) {
    return { ok: false, error: MSG_WAIT, limited: true };
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
  // Bound to the requesting device: only it can verify this code (see verifyKeyOf).
  await query(
    `INSERT INTO driver_otp (phone, code_hash, expires_at, device_id)
     VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval, $4)`,
    [phone, sha256(code), OTP_TTL_MS, from.deviceId ?? null],
  );
  logger.info({ phone: maskPhone(phone), channel: sent.channel }, 'driver OTP issued');
  if (sent.devCode && isRelaxedEnv()) return { ok: true, devCode: sent.devCode };
  return { ok: true };
}

/**
 * Verify an OTP and link the device to the (created or existing) account.
 * Consumes the code, counts wrong guesses, and fails closed.
 *
 * The guess is COUNTED before it is compared, in one statement. It used to be
 * read (attempts < 5), compared, and only then incremented: a parallel burst all
 * read the same count, so hundreds of guesses were compared against one code.
 * And each new code started at zero, so ~7,200 guesses a day per number were
 * possible even without the race. Now a code allows exactly five comparisons, the
 * number allows DRIVER_OTP_VERIFY_FAILURES_PER_DAY wrong codes across all codes from
 * one device (after which that device can neither verify nor ask for a code for that
 * number until the window passes), and a code signs in once: the consume is
 * conditional too. Only the device that asked for a code can try it (verifyKeyOf); codes
 * from before migration 055 carry no device and any device may try them.
 */
export async function verifyOtp(
  deviceId: string,
  phoneRaw: string,
  code: string,
): Promise<{ ok: true; account: { id: string; phone: string; name: string | null } } | { ok: false; error: string; limited?: true }> {
  const checked = await checkOtp(deviceId, phoneRaw, code);
  if (!checked.ok) return checked;
  const phone = checked.phone;

  const account = await one<{ id: string; phone: string; name: string | null }>(
    `INSERT INTO app_driver (phone) VALUES ($1)
     ON CONFLICT (phone) DO UPDATE SET last_seen_at = now()
     RETURNING id, phone, name`,
    [phone],
  );
  await query(`UPDATE driver_device SET app_driver_id = $2 WHERE id = $1`, [deviceId, account!.id]);

  return { ok: true, account: account! };
}

/**
 * Check (and consume) a code this device asked for, with every limit of verifyOtp, WITHOUT signing in: the
 * confirmation step of account deletion (driver/account-deletion.ts) and verifyOtp itself.
 */
export async function checkOtp(
  deviceId: string,
  phoneRaw: string,
  code: string,
): Promise<{ ok: true; phone: string } | { ok: false; error: string; limited?: true }> {
  const phone = normalisePhone(phoneRaw);
  if (!phone) return { ok: false, error: 'Nomor telepon tidak valid.' };
  const lim = authLimits();
  const verifyKey = verifyKeyOf(phone, deviceId);

  if ((await limitState(verifyKey, lim.otpVerifyFailuresPerDay, DAY_S)) === 'full') {
    return { ok: false, error: MSG_VERIFY_DAY, limited: true };
  }

  // Claim one of the newest live code's attempts.
  const otp = await one<{ id: string; code_hash: string }>(
    `UPDATE driver_otp SET attempts = attempts + 1
      WHERE id = (SELECT id FROM driver_otp
                   WHERE phone = $1 AND consumed_at IS NULL AND expires_at > now()
                     AND (device_id = $3 OR device_id IS NULL)
                   ORDER BY created_at DESC LIMIT 1)
        AND attempts < $2 AND consumed_at IS NULL AND expires_at > now()
      RETURNING id, code_hash`,
    [phone, OTP_MAX_ATTEMPTS, deviceId],
  );
  if (!otp) {
    const live = await one<{ attempts: number }>(
      `SELECT attempts FROM driver_otp WHERE phone = $1 AND consumed_at IS NULL AND expires_at > now()
          AND (device_id = $2 OR device_id IS NULL)
        ORDER BY created_at DESC LIMIT 1`,
      [phone, deviceId],
    );
    return live
      ? { ok: false, error: 'Terlalu banyak percobaan. Minta kode baru.' }
      : { ok: false, error: 'Kode sudah tidak berlaku. Minta kode baru.' };
  }
  // And one of the number's daily failures; given back if the code is right.
  if (!(await claimLimit(verifyKey, lim.otpVerifyFailuresPerDay, DAY_S))) {
    return { ok: false, error: MSG_VERIFY_DAY, limited: true };
  }

  if (!safeEqualHex(otp.code_hash, sha256(String(code).trim()))) {
    return { ok: false, error: 'Kode salah. Coba lagi.' };
  }
  await refundLimit(verifyKey);

  // One code, one sign-in: of two concurrent right answers only one consumes it.
  const consumed = await one<{ id: string }>(
    `UPDATE driver_otp SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id`,
    [otp.id],
  );
  if (!consumed) return { ok: false, error: 'Kode sudah tidak berlaku. Minta kode baru.' };
  return { ok: true, phone };
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
 *
 * `ip`: the client address, for the per-address limit on failed sign-ins
 * (DRIVER_PIN_FAILURES_PER_IP_PER_HOUR) — the per-card lock alone lets one
 * client try five PINs on every card it can name.
 */
export async function fleetLogin(
  deviceId: string,
  orgSlug: string,
  rfidUid: string,
  pin: string,
  ip?: string,
): Promise<{ ok: true; fleet: { tokenId: string; orgId: string; uid: string; orgName: string } } | { ok: false; error: string; limited?: true }> {
  // Every attempt takes a slot of the address's budget first; a successful one gives it back.
  const ipKey = ip ? `pin-ip:${ip}` : null;
  if (ipKey && !(await claimLimit(ipKey, authLimits().pinFailuresPerIpPerHour, HOUR_S))) {
    logger.warn({ ip }, 'fleet sign-in refused: per-address limit');
    return { ok: false, error: 'Terlalu banyak percobaan masuk. Coba lagi nanti.', limited: true };
  }

  // Cards are stored the way the RFID centre normalises them (hex serials upper
  // case); a driver typing the serial in lower case is the same card.
  const typed = String(rfidUid).trim();
  const slug = String(orgSlug).trim().toLowerCase();

  /**
   * The card's daily attempt budget is claimed BEFORE anything is looked up, keyed by what
   * was TYPED (organisation + normalised serial), not by the card row. Keyed by the row it
   * only ever engaged for real cards, so "too many attempts for this card today" told a
   * prober that the card existed. Now a made-up card runs out exactly like a real one.
   */
  const cardKey = `pin-card:${slug}:${normaliseUid(typed)}`;
  if (!(await claimLimit(cardKey, authLimits().pinAttemptsPerCardPerDay, DAY_S))) {
    logger.warn({ orgSlug: slug, uid: typed }, 'fleet sign-in refused: daily attempt budget for this card used up');
    return { ok: false, error: MSG_FLEET_CARD_DAY, limited: true };
  }

  const org = await one<{ id: string; name: string }>(`SELECT id, name FROM organisation WHERE slug = $1`, [slug]);
  if (!org) return fleetRefused('unknown organisation', { orgSlug: slug, uid: typed });

  const tok = await one<{
    id: string;
    uid: string;
    pin_hash: string | null;
    status: string;
    valid_to: Date | null;
  }>(
    `SELECT id, uid, pin_hash, status, valid_to FROM token
      WHERE org_id = $1 AND uid IN ($2, $3) AND kind = 'rfid'
      ORDER BY (uid = $2) DESC LIMIT 1`,
    [org.id, normaliseUid(typed), typed],
  );
  if (!tok) return fleetRefused('unknown card', { orgId: org.id, uid: typed });
  if (tok.status !== 'Accepted') return fleetRefused(`card ${tok.status}`, { tokenId: tok.id });
  if (tok.valid_to && new Date(tok.valid_to) < new Date()) return fleetRefused('card expired', { tokenId: tok.id });
  if (!tok.pin_hash) return fleetRefused('card has no app PIN', { tokenId: tok.id });

  /**
   * The attempt is COUNTED before the PIN is checked, in one statement — the
   * pattern of the operator login (services/users.ts login()).
   *
   * The counter used to be read with the card, the lock checked, the (slow,
   * deliberately) scrypt run, and `read + 1` written back as an absolute value:
   * a parallel burst all passed the lock check and together recorded one
   * failure, so any number of PINs could be tried at once. Now each attempt
   * atomically takes a slot; the one that reaches the limit sets the lock (and
   * restarts the count for after it), and every later one finds the card locked
   * and is refused whatever the PIN. A right PIN clears the counter below.
   */
  const claimed = await one<{ locked_now: boolean }>(
    `UPDATE token
        SET pin_failures = CASE WHEN pin_failures + 1 >= $2::int THEN 0 ELSE pin_failures + 1 END,
            pin_locked_until = CASE WHEN pin_failures + 1 >= $2::int THEN now() + make_interval(mins => $3::int) ELSE pin_locked_until END
      WHERE id = $1 AND (pin_locked_until IS NULL OR pin_locked_until <= now())
      RETURNING (pin_locked_until IS NOT NULL AND pin_locked_until > now()) AS locked_now`,
    [tok.id, FLEET_PIN_MAX_FAILURES, FLEET_PIN_LOCK_MINUTES],
  );
  if (!claimed) {
    // Refused by the lock without a guess being tried; the same scrypt work and answer as a
    // wrong PIN, so the lock does not mark the card as real either.
    await refundLimit(cardKey);
    return fleetRefused('card locked', { tokenId: tok.id });
  }

  if (!(await pinMatches(String(pin).trim(), tok.pin_hash))) {
    if (claimed.locked_now) logger.warn({ tokenId: tok.id }, 'fleet PIN locked after repeated failures');
    return fleetRefused('wrong PIN', { tokenId: tok.id }, false);
  }

  // Success: clear the counter, and upgrade a legacy (v1.2) SHA-256 PIN to scrypt.
  const upgraded = tok.pin_hash.startsWith('scrypt$') ? null : await hashPassword(String(pin).trim());
  await query(
    `UPDATE token SET pin_failures = 0, pin_locked_until = NULL, pin_hash = COALESCE($2, pin_hash) WHERE id = $1`,
    [tok.id, upgraded],
  );
  if (ipKey) await refundLimit(ipKey);
  await refundLimit(cardKey);
  await query(`UPDATE driver_device SET fleet_token_id = $2 WHERE id = $1`, [deviceId, tok.id]);
  return { ok: true, fleet: { tokenId: tok.id, orgId: org.id, uid: tok.uid, orgName: org.name } };
}

const FLEET_PIN_MAX_FAILURES = 5;
const FLEET_PIN_LOCK_MINUTES = 15;

const MSG_FLEET_CARD_DAY = 'Terlalu banyak percobaan untuk kartu ini hari ini. Coba lagi besok atau hubungi admin armada Anda.';

/**
 * ONE answer for every failed fleet sign-in: unknown organisation, unknown card, blocked,
 * expired or not-yet-activated card, locked card and wrong PIN. They used to be told
 * apart ("Organisasi tidak ditemukan", "Kartu RFID tidak dikenal", "Kartu ini diblokir"…),
 * which let anyone enumerate a CPO's tenants and its fleet cards, and see which were live,
 * without knowing a single PIN. The reason goes to the log (with the serial masked) for
 * the operator; the driver is told what to check and when the card pauses.
 */
export const FLEET_LOGIN_FAILED =
  `Organisasi, nomor kartu, atau PIN salah. Setelah ${FLEET_PIN_MAX_FAILURES} kali salah, kartu dikunci ${FLEET_PIN_LOCK_MINUTES} menit. ` +
  'Jika masih gagal, hubungi admin armada Anda.';

let dummyPinHash: string | null = null;

/**
 * Refuse with the uniform answer. `burnPinWork`: paths that never reached the PIN check
 * spend the same scrypt work, so the answer TIME does not tell the reasons apart either.
 */
async function fleetRefused(
  reason: string,
  ctx: Record<string, unknown>,
  burnPinWork = true,
): Promise<{ ok: false; error: string }> {
  if (burnPinWork) {
    dummyPinHash ??= await hashPassword(randomBytes(12).toString('hex'));
    await verifyPassword('0000', dummyPinHash);
  }
  logger.info({ ...ctx, reason }, 'fleet sign-in refused');
  return { ok: false, error: FLEET_LOGIN_FAILED };
}

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
