import { defaultTimezone, utcOffsetMinutes } from '../domain/timezone.js';
import { createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';

/**
 * OCMF — the Open Charge Metering Format (S.A.F.E. e.V.), the signed meter
 * data format of calibration-law ("Eichrecht") charging stations.
 *
 *   OCMF|{payload JSON}|{signature JSON}
 *
 * The meter signs the payload text (exactly the bytes between the pipes) with
 * its own key. The payload carries the meter's identity (MS: serial), who was
 * charging (ID) and the readings (RD): the register at the start (TX "B") and
 * at the end (TX "E") of the transaction, each with a time, a value, an OBIS
 * id (RI "1-b:1.8.0" = import) and a unit. A driver can check the bill with the
 * S.A.F.E. Transparency Software using the meter's public key.
 *
 * Pure functions: no I/O. Building is used by the sandbox's virtual meters;
 * parsing and verifying by the CSMS.
 */

export interface OcmfReading {
  TM: string;
  TX?: string;
  RV: number;
  RI?: string;
  RU: string;
  RT?: string;
  EF?: string;
  ST?: string;
  [k: string]: unknown;
}

export interface OcmfPayload {
  FV?: string;
  GI?: string;
  GS?: string;
  GV?: string;
  PG?: string;
  MV?: string;
  MM?: string;
  MS?: string;
  MF?: string;
  IS?: boolean;
  IL?: string;
  IF?: string[];
  IT?: string;
  ID?: string;
  RD: OcmfReading[];
  [k: string]: unknown;
}

export interface OcmfSignature {
  SA?: string;
  SE?: string;
  SM?: string;
  SD: string;
}

export interface ParsedOcmf {
  /** The exact signed text. */
  payloadText: string;
  payload: OcmfPayload;
  signature: OcmfSignature;
}

/** OCMF signature algorithms and the curve each names (the hash is always SHA-256). */
const CURVES: Record<string, string> = {
  'ECDSA-secp256r1-SHA256': 'prime256v1',
  'ECDSA-secp384r1-SHA256': 'secp384r1',
  'ECDSA-secp256k1-SHA256': 'secp256k1',
  'ECDSA-brainpool256r1-SHA256': 'brainpoolP256r1',
  'ECDSA-secp192k1-SHA256': 'secp192k1',
  'ECDSA-secp192r1-SHA256': 'prime192v1',
};
export const DEFAULT_SA = 'ECDSA-secp256r1-SHA256';

/**
 * Split an OCMF string. The payload is taken as the text between the first
 * and the last pipe, byte for byte: re-serialising the JSON would change what
 * was signed.
 */
export function parseOcmf(text: string): ParsedOcmf | string {
  const t = String(text ?? '').trim();
  if (!t.startsWith('OCMF|')) return 'not OCMF data (it must start with "OCMF|")';
  const last = t.lastIndexOf('|');
  if (last <= 5) return 'OCMF data without a signature section';
  const payloadText = t.slice(5, last);
  let payload: OcmfPayload;
  let signature: OcmfSignature;
  try { payload = JSON.parse(payloadText); } catch { return 'the OCMF payload is not valid JSON'; }
  try { signature = JSON.parse(t.slice(last + 1)); } catch { return 'the OCMF signature is not valid JSON'; }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.RD)) return 'the OCMF payload has no readings (RD)';
  if (!signature || typeof signature.SD !== 'string' || !signature.SD) return 'the OCMF signature has no signature data (SD)';
  return { payloadText, payload, signature };
}

// ─────────────────────────────────────────────── keys

/** The DER prefix of a P-256 SubjectPublicKeyInfo, before the 65-byte uncompressed point. */
const P256_SPKI_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';

/**
 * A meter public key in any of the forms meters and chargers print it:
 * hex DER (SubjectPublicKeyInfo, as the Transparency Software takes it),
 * base64 DER, PEM, or a raw uncompressed P-256 point (04‖x‖y, hex).
 * Returns the key and its canonical form, hex DER; or why it is not a key.
 */
export function normaliseMeterKey(input: string): { key: KeyObject; hex: string } | string {
  const raw = String(input ?? '').trim();
  if (!raw) return 'no key';
  let der: Buffer | null = null;
  if (/-----BEGIN PUBLIC KEY-----/.test(raw)) {
    try { const k = createPublicKey(raw); return { key: k, hex: (k.export({ type: 'spki', format: 'der' }) as Buffer).toString('hex') }; }
    catch { return 'the PEM text is not a public key'; }
  }
  const compact = raw.replace(/\s+/g, '');
  if (/^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0) {
    const h = compact.toLowerCase();
    // A bare point (or the point without its 04 marker).
    if (h.length === 130 && h.startsWith('04')) der = Buffer.from(P256_SPKI_PREFIX + h, 'hex');
    else if (h.length === 128) der = Buffer.from(`${P256_SPKI_PREFIX}04${h}`, 'hex');
    else der = Buffer.from(h, 'hex');
  } else if (/^[A-Za-z0-9+/=_-]+$/.test(compact)) {
    der = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }
  if (!der?.length) return 'the key is not hex, base64 or PEM';
  try {
    const k = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (k.asymmetricKeyType !== 'ec') return 'the key is not an elliptic-curve key';
    return { key: k, hex: der.toString('hex') };
  } catch {
    return 'the key is not a DER public key (SubjectPublicKeyInfo)';
  }
}

// ─────────────────────────────────────────────── verify

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/** Check an OCMF signature with the meter's public key. */
export function verifyOcmf(parsed: ParsedOcmf, key: KeyObject): VerifyResult {
  const sa = parsed.signature.SA ?? DEFAULT_SA;
  const curve = CURVES[sa];
  if (!curve) return { ok: false, reason: `signature algorithm ${sa} is not supported` };
  const keyCurve = key.asymmetricKeyDetails?.namedCurve;
  if (keyCurve && keyCurve !== curve) return { ok: false, reason: `the key is on ${keyCurve}, the data says ${sa}` };
  if (parsed.signature.SM && parsed.signature.SM !== 'application/x-der') return { ok: false, reason: `signature format ${parsed.signature.SM} is not supported` };
  const enc = (parsed.signature.SE ?? 'hex').toLowerCase();
  const sig = enc === 'base64' ? Buffer.from(parsed.signature.SD, 'base64') : Buffer.from(parsed.signature.SD, 'hex');
  if (!sig.length) return { ok: false, reason: 'empty signature' };
  try {
    const good = cryptoVerify('sha256', Buffer.from(parsed.payloadText, 'utf8'), { key, dsaEncoding: 'der' }, sig);
    return good ? { ok: true } : { ok: false, reason: 'the signature does not match the data' };
  } catch (e) {
    return { ok: false, reason: `the signature cannot be checked (${(e as Error).message})` };
  }
}

// ─────────────────────────────────────────────── readings

export type Register = 'import' | 'export' | 'other';

/** Which register an OBIS id names: 1.8.0 imported energy, 2.8.0 exported. No id: import. */
export function registerOf(ri: string | undefined): Register {
  if (!ri) return 'import';
  if (/(^|[^0-9])0?1[.:]0?8[.:]0/.test(ri)) return 'import';
  if (/(^|[^0-9])0?2[.:]0?8[.:]0/.test(ri)) return 'export';
  return 'other';
}

/** A reading's value in Wh, or null when its unit is not energy. */
export function readingWh(r: OcmfReading): number | null {
  const v = Number(r.RV);
  if (!Number.isFinite(v)) return null;
  const u = String(r.RU ?? '').toLowerCase();
  if (u === 'kwh') return Math.round(v * 1000);
  if (u === 'wh') return Math.round(v);
  return null;
}

/** The status a reading carries: G (good) is the only one a bill can rest on. */
export const readingOk = (r: OcmfReading) => (r.ST ?? 'G') === 'G' && !String(r.EF ?? '').trim();

/** "2026-09-28T17:30:04,000+0700 S" → a Date (the trailing letter is the clock's sync state). */
export function parseOcmfTime(tm: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:[,.](\d{1,3}))?([+-]\d{2})(\d{2})/.exec(String(tm ?? ''));
  if (!m) return null;
  const d = new Date(`${m[1]}.${(m[2] ?? '0').padEnd(3, '0')}${m[3]}:${m[4]}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ─────────────────────────────────────────────── build (virtual meters)

/** OCMF's time format, in a given UTC offset (WIB by default), with the clock's sync state. */
export function formatOcmfTime(d: Date, offsetMinutes = utcOffsetMinutes(d, defaultTimezone('ID')), sync: 'S' | 'U' | 'I' | 'R' = 'S'): string {
  const local = new Date(d.getTime() + offsetMinutes * 60_000);
  const iso = local.toISOString(); // shifted: read it as local time
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const off = Math.abs(offsetMinutes);
  return `${iso.slice(0, 19)},${iso.slice(20, 23)}${sign}${String(Math.floor(off / 60)).padStart(2, '0')}${String(off % 60).padStart(2, '0')} ${sync}`;
}

/** Sign a payload the way a meter does (ECDSA over SHA-256, DER signature in hex). */
export function buildOcmf(payload: OcmfPayload, privateKey: KeyObject, sa: string = DEFAULT_SA): string {
  const payloadText = JSON.stringify(payload);
  const sd = cryptoSign('sha256', Buffer.from(payloadText, 'utf8'), { key: privateKey, dsaEncoding: 'der' }).toString('hex');
  return `OCMF|${payloadText}|${JSON.stringify({ SA: sa, SD: sd })}`;
}

/** Signed data as it arrives in OCPP: plain OCMF text, or base64 of it (OCPP 2.0.1 signedMeterData, some 1.6 firmware). */
export function ocmfText(data: string): string | null {
  const t = String(data ?? '').trim();
  if (t.startsWith('OCMF|')) return t;
  if (/^[A-Za-z0-9+/=\s]+$/.test(t)) {
    const d = Buffer.from(t.replace(/\s+/g, ''), 'base64').toString('utf8').trim();
    if (d.startsWith('OCMF|')) return d;
  }
  return null;
}

/** A public key as it arrives in OCPP 2.0.1 (base64 of the key's text or of its DER). */
export function keyFromOcpp(publicKey: string | undefined | null): string | null {
  const t = String(publicKey ?? '').trim();
  if (!t) return null;
  const usable = (k: string) => typeof normaliseMeterKey(k) !== 'string';
  // The common form is base64 of the printed key (hex or PEM): prefer that text when it decodes to one.
  const decoded = /^[A-Za-z0-9+/=]+$/.test(t) ? Buffer.from(t, 'base64').toString('utf8').trim() : '';
  if (decoded && (/^[0-9a-fA-F\s]+$/.test(decoded) || decoded.includes('-----BEGIN')) && usable(decoded)) return decoded;
  return usable(t) ? t : null;
}
