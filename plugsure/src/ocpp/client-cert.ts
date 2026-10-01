import { timingSafeEqual } from 'node:crypto';

/**
 * OCPP Security Profile 3 — mutual-TLS client-certificate binding.
 * ================================================================
 * Profile 2 authenticates a charger with a per-unit secret (the AuthorizationKey)
 * over TLS. Profile 3 replaces that secret with a CLIENT CERTIFICATE: the charger
 * presents a cert, it is verified against the deployment CA at the TLS terminator,
 * and here we bind that cert to THIS charge point so one trusted charger cannot
 * use another's certificate.
 *
 * WHERE THE CERTIFICATE IS VERIFIED (two deployments, both supported):
 *   - Reverse proxy terminates TLS (the shipped Caddy setup): the proxy does
 *     `require_and_verify` against the CA and forwards the verified fingerprint in
 *     a header (default `X-Client-Cert-Fingerprint`). We trust that header ONLY
 *     when `trustProxyProto` is on — the same trust model the gateway already uses
 *     for `X-Forwarded-Proto`. The gateway must be reachable ONLY via the proxy
 *     (it binds to 127.0.0.1 in the shipped config), or a client could spoof it.
 *   - Gateway terminates TLS itself: we read the peer certificate straight off the
 *     socket, so no header trust is involved.
 *
 * This module is PURE (no DB, no I/O) so it is unit-testable in isolation. The
 * gateway supplies the request context; storage of the expected fingerprint lives
 * on the charge_point row (see services/chargepoint-keys.ts + migration 008).
 *
 * The fingerprint is the certificate's SHA-256, 64 lowercase hex chars, colons and
 * whitespace stripped. `openssl x509 -noout -fingerprint -sha256 -in cert.pem`
 * produces the colon form; we normalise both sides before comparing.
 */

/** A minimal view of the peer certificate Node exposes on a TLS socket. */
export interface PeerCertLike {
  fingerprint256?: string;
}
export interface ClientCertSocketLike {
  encrypted?: boolean;
  /** Node's verdict on the peer certificate's chain (TLSSocket.authorized). */
  authorized?: boolean;
  getPeerCertificate?: (detailed?: boolean) => PeerCertLike | undefined;
}
export interface ClientCertContext {
  headers: Record<string, string | string[] | undefined>;
  socket?: ClientCertSocketLike;
  /** Trust the proxy-set fingerprint header. Mirrors gateway.trustProxyProto. */
  trustProxyProto: boolean;
  /** The connection comes from a configured trusted proxy (OCPP_TRUSTED_PROXIES). */
  fromTrustedProxy?: boolean;
  /** Header the proxy sets, lower-cased (e.g. 'x-client-cert-fingerprint'). */
  headerName: string;
}

/**
 * Normalise a SHA-256 fingerprint to 64 lowercase hex chars, or null if it is not
 * a well-formed SHA-256 fingerprint. Accepts the colon-separated OpenSSL form and
 * an optional `sha256:`/`SHA256 Fingerprint=` prefix.
 */
export function normaliseFingerprint(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const eq = s.lastIndexOf('=');
  if (eq >= 0) s = s.slice(eq + 1); // drop "SHA256 Fingerprint=" style prefixes
  s = s.replace(/^sha-?256:/i, '');
  s = s.replace(/[\s:]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}

/** Constant-time compare of two already-normalised fingerprints. */
export function fingerprintsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/** Read the fingerprint the charger presented, and say where it came from. */
export function presentedFingerprint(ctx: ClientCertContext): { value: string | null; source: 'socket' | 'header' | 'none' } {
  // 1) Gateway terminated TLS itself — read the peer cert directly (most trustworthy).
  //    Only a certificate that chains to our CA counts (the server asks for one with
  //    rejectUnauthorized:false so Profile 1/2 chargers can connect without): an
  //    expired or self-signed certificate with a matching fingerprint is refused.
  //    And a TLS connection to the gateway never falls back to a header its own
  //    client wrote.
  if (ctx.socket?.encrypted) {
    if (typeof ctx.socket.getPeerCertificate === 'function' && ctx.socket.authorized === true) {
      const cert = ctx.socket.getPeerCertificate();
      const fp = normaliseFingerprint(cert?.fingerprint256);
      if (fp) return { value: fp, source: 'socket' };
    }
    return { value: null, source: 'none' };
  }
  // 2) TLS terminated at a trusted proxy that forwards the verified fingerprint.
  //    Believed only from a configured proxy address: from anyone else it is text
  //    the client chose, and the fingerprint is not a secret.
  if (ctx.trustProxyProto && ctx.fromTrustedProxy === true) {
    const raw = ctx.headers[ctx.headerName.toLowerCase()];
    const fp = normaliseFingerprint(Array.isArray(raw) ? raw[0] : raw);
    if (fp) return { value: fp, source: 'header' };
  }
  return { value: null, source: 'none' };
}

export interface ClientCertResult {
  ok: boolean;
  reason?: string;
  source?: 'socket' | 'header';
}

/**
 * Verify the charger's client certificate for Security Profile 3.
 *
 * Fails CLOSED: no presented cert, no stored binding, or a mismatch all reject.
 * The stored fingerprint is the expected SHA-256 recorded on the charge point.
 */
export function checkClientCert(ctx: ClientCertContext, storedFingerprint: string | null | undefined): ClientCertResult {
  const presented = presentedFingerprint(ctx);
  if (!presented.value) {
    return { ok: false, reason: 'no client certificate presented (Security Profile 3 requires mutual TLS)' };
  }
  const stored = normaliseFingerprint(storedFingerprint);
  if (!stored) {
    return { ok: false, reason: 'no client-certificate binding provisioned for this charge point' };
  }
  if (!fingerprintsMatch(presented.value, stored)) {
    return { ok: false, reason: 'client certificate does not match the binding for this charge point' };
  }
  // presented.value is set, so source is 'socket' | 'header' here (never 'none').
  return { ok: true, source: presented.source as 'socket' | 'header' };
}
