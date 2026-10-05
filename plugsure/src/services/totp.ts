import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) on HOTP (RFC 4226), with node:crypto only.
 *
 * The console's two-step verification. Pure functions: no database, no clock of its own
 * (every function takes the time), so the RFC test vectors run as plain unit tests.
 *
 * Authenticator apps (Google Authenticator, Microsoft Authenticator, Authy, 1Password…)
 * all default to SHA-1, 6 digits, 30-second steps, and several IGNORE the algorithm and
 * digits parameters of an otpauth:// URI. So that is what is issued; SHA-256/512 and
 * 8 digits exist here for the RFC vectors and are never offered to a user.
 */

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export const TOTP_STEP_S = 30;
export const TOTP_DIGITS = 6;
/** Steps either side of now that are accepted: phone clocks drift, and typing takes time. */
export const TOTP_WINDOW = 1;

// ------------------------------------------------------------------ base32 (RFC 4648, no padding)

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Lenient on input (case, spaces, '=' padding, as people copy it), strict on the alphabet. */
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ------------------------------------------------------------------ HOTP / TOTP

/** RFC 4226 §5.3: HMAC over the 8-byte big-endian counter, dynamic truncation, mod 10^digits. */
export function hotp(secret: Buffer, counter: number | bigint, digits = TOTP_DIGITS, algorithm: TotpAlgorithm = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** The time step (T in RFC 6238) for a moment. */
export function timeStep(nowMs: number, stepS = TOTP_STEP_S): number {
  return Math.floor(nowMs / 1000 / stepS);
}

export function totp(secret: Buffer, nowMs: number, opts: { digits?: number; algorithm?: TotpAlgorithm; stepS?: number } = {}): string {
  return hotp(secret, timeStep(nowMs, opts.stepS), opts.digits ?? TOTP_DIGITS, opts.algorithm ?? 'sha1');
}

/**
 * The time step `code` is valid for, within ±TOTP_WINDOW steps of now, or null.
 *
 * Every candidate is compared (constant time each), not "return on first match", so the
 * answer time does not say which step matched. Only steps AFTER `notAfterStep` (the last
 * step a code was accepted for) count — the caller then records the returned step
 * atomically, which is what makes a code single-use (see services/mfa.ts).
 */
export function matchTotp(secret: Buffer, code: string, nowMs: number, notAfterStep: number | null = null): number | null {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = timeStep(nowMs);
  let matched: number | null = null;
  for (let s = now - TOTP_WINDOW; s <= now + TOTP_WINDOW; s++) {
    const expected = Buffer.from(hotp(secret, s));
    const ok = timingSafeEqual(expected, Buffer.from(c));
    if (ok && (notAfterStep === null || s > notAfterStep)) matched = s;
  }
  return matched;
}

/** 160 random bits: the RFC 4226 recommended length, and what authenticator apps expect. */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

/**
 * The otpauth:// URI an authenticator app scans (Key Uri Format). The label is
 * "Issuer:account", both URI-encoded; the issuer parameter repeats it (apps use either).
 */
export function otpauthUri(args: { issuer: string; account: string; secret: Buffer }): string {
  const issuer = args.issuer.replace(/:/g, '');
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(args.account)}`;
  const q = new URLSearchParams({
    secret: base32Encode(args.secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_S),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}

// ------------------------------------------------------------------ recovery codes

/**
 * Recovery codes: 16 base32 characters (80 random bits) as xxxx-xxxx-xxxx-xxxx. At 80 bits a
 * plain sha256 is safe to store: there is nothing to brute-force offline, unlike a password.
 */
export function generateRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    const s = base32Encode(randomBytes(10)).toLowerCase();
    return s.match(/.{4}/g)!.join('-');
  });
}

/** How a recovery code is typed back varies (case, dashes, spaces): compare the canonical form. */
export function normaliseRecoveryCode(code: string): string {
  return String(code ?? '').toLowerCase().replace(/[^a-z2-7]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normaliseRecoveryCode(code), 'utf8').digest('hex');
}

/** A six-digit authenticator code (as opposed to a recovery code). */
export function looksLikeTotp(code: string): boolean {
  return /^\d{6}$/.test(String(code ?? '').replace(/\s/g, ''));
}
