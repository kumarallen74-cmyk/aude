import 'dotenv/config';
import { readFileSync } from 'node:fs';

const num = (v: string | undefined, d: number) => (v === undefined ? d : Number(v));
const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : v === 'true' || v === '1');

/** The release, from package.json (one level above both src/ and dist/). */
function packageVersion(): string {
  try {
    return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  version: packageVersion(),

  databaseUrl:
    process.env.DATABASE_URL ?? 'postgresql://postgres:plugsure@127.0.0.1:5432/plugsure',

  gateway: {
    port: num(process.env.OCPP_PORT, 9220),
    /**
     * Interface the OCPP listener binds. It used to bind every interface with no
     * way to say otherwise, so on the systemd path :9220 — plain ws, and the
     * gateway's /internal bridge endpoints — was reachable from the network beside
     * Caddy. In every documented production setup chargers arrive through Caddy on
     * the same host, so outside development the default is loopback. Development
     * keeps 0.0.0.0 so a bench charger on the LAN can dial in directly; docker
     * compose sets 0.0.0.0 inside the container (the host port mapping decides
     * exposure). Set OCPP_HOST=0.0.0.0 only for a gateway that chargers or a
     * remote API host reach without a local proxy.
     */
    host: process.env.OCPP_HOST ?? ((process.env.NODE_ENV ?? 'development') === 'development' ? '0.0.0.0' : '127.0.0.1'),
    /** Path prefix. The charge point ID is ALWAYS the final path segment. */
    path: process.env.OCPP_PATH ?? '/ocpp',
    /**
     * OCPP versions we will negotiate, highest preference first.
     *
     * Only advertise a version we can actually SPEAK. Advertising 2.0.1 without
     * an adapter meant a dual-stack charger — Autel DC Compact and DH480 are both
     * documented dual-stack — negotiated 2.0.1 and then received 1.6 semantics.
     */
    supportedVersions: (process.env.OCPP_VERSIONS ?? 'ocpp1.6')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    /** Reject frames larger than this. ws defaults to 100 MB, which is a DoS surface. */
    maxPayloadBytes: num(process.env.OCPP_MAX_PAYLOAD_BYTES, 256 * 1024),
    /**
     * Per-charger inbound message budget (a token bucket). Past it the gateway stops READING that
     * charger's socket until the budget refills: TCP slows the charger down, and no message is ever
     * refused or dropped (a refused transaction message could lose a session's revenue). The burst
     * lets a charger back from an outage upload its queued transactions at once.
     */
    maxMessagesPerSecond: num(process.env.OCPP_MAX_MESSAGES_PER_S, 20),
    messageBurst: num(process.env.OCPP_MESSAGE_BURST, 200),
    /** TLS. When keyPath and certPath are set the gateway terminates WSS itself. */
    tlsKeyPath: process.env.OCPP_TLS_KEY_PATH ?? '',
    tlsCertPath: process.env.OCPP_TLS_CERT_PATH ?? '',
    tlsCaPath: process.env.OCPP_TLS_CA_PATH ?? '',
    /**
     * Trust X-Forwarded-Proto when TLS is terminated at a reverse proxy.
     * ONLY enable when the proxy is the sole ingress and strips client-supplied
     * forwarding headers, or a client can claim TLS it does not have.
     */
    trustProxyProto: bool(process.env.OCPP_TRUST_PROXY_PROTO, false),
    /**
     * Header a TLS-terminating proxy sets with the verified client-certificate
     * SHA-256 fingerprint, for OCPP Security Profile 3 (mutual TLS). Only trusted
     * when trustProxyProto is on. When the gateway terminates TLS itself the peer
     * certificate is read from the socket and this header is not used.
     */
    clientCertHeader: (process.env.OCPP_CLIENT_CERT_HEADER ?? 'x-client-cert-fingerprint').toLowerCase(),
    /**
     * Peers whose X-Forwarded-Proto and client-certificate header are believed:
     * addresses or CIDRs, comma-separated. Those headers used to be taken from
     * ANY peer once OCPP_TRUST_PROXY_PROTO was on, and the gateway listened on
     * every interface (see OCPP_HOST), so a client reaching :9220 directly could claim TLS and
     * present a Profile 3 charger's (non-secret) certificate fingerprint. Default:
     * the loopback proxy (Caddy on the same host). Docker Compose adds the
     * bridge networks, which is where a host Caddy's connections come from.
     */
    trustedProxies: (process.env.OCPP_TRUSTED_PROXIES ?? '127.0.0.1,::1')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    /** Seconds without a heartbeat or frame before a charger is marked offline. */
    offlineAfterS: num(process.env.OCPP_OFFLINE_AFTER_S, 900),
    /**
     * Minutes a charger may stay offline before a critical "charger offline"
     * alert is raised (and sent to webhooks). Brief 4G drops reconnect within a
     * minute; 15 separates those from a real outage.
     */
    offlineAlertMinutes: num(process.env.OFFLINE_ALERT_MINUTES, 15),
    /** Server-side WebSocket ping interval. Detects half-open 4G sockets. */
    pingIntervalS: num(process.env.OCPP_PING_INTERVAL_S, 120),
    /**
     * Security profile enforced for new connections.
     *   0 = plain ws, no auth  (bench only)
     *   1 = plain ws + HTTP Basic
     *   2 = wss + HTTP Basic   <- production baseline, mandated by OCPP 1.6 certification
     *   3 = mutual TLS
     */
    minSecurityProfile: num(process.env.OCPP_MIN_SECURITY_PROFILE, 0),
    /** Adopt unknown charge points automatically instead of parking them. Dev only. */
    // Defaults ON only in development. Elsewhere an unknown identity must be adopted by
    // an operator: auto-adoption enrols any stranger into the first site ever created.
    autoAdopt: bool(process.env.OCPP_AUTO_ADOPT, (process.env.NODE_ENV ?? 'development') === 'development'),
    /**
     * The site auto-adopted chargers join: a site id, or a site name. Unset, only a
     * development or test gateway falls back to the oldest site; anywhere else an
     * unknown charger is parked, because "the oldest site" can be any tenant's.
     */
    autoAdoptSite: (process.env.OCPP_AUTO_ADOPT_SITE ?? '').trim(),
    /**
     * Outside development and test the gateway refuses to start with a security
     * profile below 2 or with auto-adoption on, unless this is set: an explicit
     * acknowledgement for a supervised bench, never a default.
     */
    allowInsecure: bool(process.env.ALLOW_INSECURE_OCPP, false),
    callTimeoutMs: num(process.env.OCPP_CALL_TIMEOUT_MS, 30_000),
    heartbeatIntervalS: num(process.env.OCPP_HEARTBEAT_S, 300),
    /** Grace window during which both old and new AuthorizationKey are accepted. */
    keyRotationGraceMs: num(process.env.OCPP_KEY_ROTATION_GRACE_MS, 86_400_000),
  },

  api: {
    port: num(process.env.API_PORT, 9200),
    /**
     * Loopback by default, as deploy/README.md always said: the console and /v1
     * are published only through Caddy (TLS, IP allow-list). The default used to
     * be 0.0.0.0, which on the systemd path exposed the API on every interface.
     * docker compose sets API_HOST=0.0.0.0 inside the container, where the port
     * mapping (API_BIND, loopback by default) decides exposure.
     */
    host: process.env.API_HOST ?? '127.0.0.1',
    /**
     * Development bypass for authentication. NEVER true outside a workstation.
     * The server refuses to start with this on unless NODE_ENV is development.
     */
    devNoAuth: bool(process.env.API_DEV_NO_AUTH, false),
    /** Per client IP, for the console and anything not using an API key. */
    rateLimitPerMin: num(process.env.API_RATE_LIMIT_PER_MIN, 600),
    /** Per API key, unless the key has its own limit (Govern → API keys). */
    keyRateLimitPerMin: num(process.env.API_KEY_RATE_LIMIT_PER_MIN, 600),
    /** Requests per IP per minute with an API key that does not authenticate. */
    keyAuthFailuresPerMin: num(process.env.API_KEY_AUTH_FAILURES_PER_MIN, 30),
    /**
     * Keep each API key's token bucket in Postgres (api_key_rate_bucket), shared
     * by every API process. The in-process buckets gave each key its limit PER
     * PROCESS, so behind N API processes a key got N times its limit. Costs one
     * small UPDATE per API-key request. If the database call fails the request is
     * limited by the in-process bucket instead (fail open, logged) — availability
     * over exactness. Defaults on outside development and test.
     */
    keyRateLimitShared: bool(
      process.env.API_RATE_LIMIT_SHARED,
      !['development', 'test'].includes(process.env.NODE_ENV ?? 'development'),
    ),
    /**
     * Trusted reverse proxies, as a comma-separated list of IPs or CIDRs.
     *
     * This used to be a hardcoded `trustProxy: true`, which tells Fastify to
     * believe `X-Forwarded-For` from ANY peer. Since the rate limiter keys on
     * `req.ip`, a caller could send a different forged XFF on every request and
     * never be limited at all — brute force against the bearer token became
     * free. It also poisoned the client IP recorded in the audit log, which is
     * the field you would reach for during an incident.
     *
     * Empty (the default) means trust nothing and use the real socket address.
     * Set it to your ingress's address in deployment — never to `true`.
     */
    trustedProxies: (process.env.API_TRUSTED_PROXIES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  /** Operator console (SPEC-UI-CSMS-2026-FINAL). */
  console: {
    /**
     * Public HTTPS origin of this deployment, e.g. https://csms.example.co.id.
     * Firmware download URLs and the built-in diagnostics upload URL handed to
     * chargers are built from it, so it must be reachable FROM THE CHARGER.
     * Empty = derive from the request (fine on a bench, wrong behind most proxies).
     */
    publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, ''),
    /**
     * The OCPP URL a charger is configured with, WITHOUT the identity, e.g.
     * wss://ocpp.example.co.id/ocpp. Printed on commissioning exports and QR codes.
     */
    ocppPublicUrl: (process.env.OCPP_PUBLIC_URL ?? '').replace(/\/+$/, ''),
    /** Console session cookie is Secure (HTTPS-only). Off only for a plain-http bench. */
    cookieSecure: bool(process.env.CONSOLE_COOKIE_SECURE, (process.env.NODE_ENV ?? 'development') === 'production'),
    /** Consecutive failed logins before an account is locked. */
    loginMaxFailures: num(process.env.LOGIN_MAX_FAILURES, 5),
    loginLockMinutes: num(process.env.LOGIN_LOCK_MINUTES, 15),
    /** Minimum operator password length. */
    passwordMinLength: num(process.env.PASSWORD_MIN_LENGTH, 12),
  },

  /** Where uploaded firmware images and retrieved diagnostic logs are stored. */
  storage: {
    dir: process.env.STORAGE_DIR ?? './var/storage',
    maxFirmwareBytes: num(process.env.MAX_FIRMWARE_BYTES, 512 * 1024 * 1024),
    maxDiagnosticsBytes: num(process.env.MAX_DIAGNOSTICS_BYTES, 200 * 1024 * 1024),
  },

  /**
   * API <-> gateway bridge, for the SPLIT deployment (docker-compose, systemd):
   * the API and the gateway are separate processes, and the charger sockets live
   * only in the gateway. Without the bridge every console command answered "not
   * connected", every charger showed offline, and the live stream was silent.
   *
   *   gatewayUrl  set on the API: where to reach the gateway's internal endpoints
   *               (e.g. http://gateway:9220 in compose, http://127.0.0.1:9220 on one VM)
   *   token       shared secret, REQUIRED on both sides for the bridge to engage
   *   relayEvents set on the gateway: publish bus events to Postgres NOTIFY so the
   *               API's live stream sees them
   *
   * All empty/false = the single-process (all-in-one) behaviour, unchanged.
   */
  bridge: {
    gatewayUrl: (process.env.GATEWAY_INTERNAL_URL ?? '').replace(/\/+$/, ''),
    token: process.env.INTERNAL_API_TOKEN ?? '',
    relayEvents: bool(process.env.EVENT_RELAY, false),
    callTimeoutMs: num(process.env.BRIDGE_CALL_TIMEOUT_MS, 45_000),
  },

  /**
   * HashiCorp Vault PKI for OCPP Security Profile 3 client certificates.
   * Unset VAULT_ADDR = the "Issue from Vault" button explains how to enable it and
   * the manual fingerprint / PEM path is used instead.
   */
  vault: {
    addr: (process.env.VAULT_ADDR ?? '').replace(/\/+$/, ''),
    token: process.env.VAULT_TOKEN ?? '',
    pkiMount: process.env.VAULT_PKI_MOUNT ?? 'pki',
    role: process.env.VAULT_PKI_ROLE ?? 'ocpp-charger',
    ttl: process.env.VAULT_CERT_TTL ?? '8760h',
    namespace: process.env.VAULT_NAMESPACE ?? '',
  },

  /**
   * ISO 15118 Plug & Charge. The V2G PKI that signs chargers' certificates and
   * serves contract certificates:
   *   none  (default in production) — Plug & Charge requests are answered Failed
   *   mock  a local test PKI (refused in production; the default elsewhere)
   *   http  a PKI gateway: PNC_PKI_URL + PNC_PKI_TOKEN (see deploy/README.md)
   * PNC_V2G_SIGNER=vault signs charger certificates with the operator's own
   * sub-CA held in Vault (PNC_VAULT_MOUNT / PNC_VAULT_ROLE, Vault address and
   * token as above) instead of the PKI.
   */
  pnc: {
    pki: (process.env.PNC_PKI ?? ((process.env.NODE_ENV ?? 'development') === 'production' ? 'none' : 'mock')) as 'none' | 'mock' | 'http',
    pkiUrl: (process.env.PNC_PKI_URL ?? '').replace(/\/+$/, ''),
    pkiToken: process.env.PNC_PKI_TOKEN ?? '',
    signer: (process.env.PNC_V2G_SIGNER ?? 'pki') as 'pki' | 'vault',
    vaultMount: process.env.PNC_VAULT_MOUNT ?? 'pki_v2g',
    vaultRole: process.env.PNC_VAULT_ROLE ?? 'secc',
    certDays: num(process.env.PNC_CERT_DAYS, 365),
    renewDays: num(process.env.PNC_RENEW_DAYS, 30),
    ocspTimeoutMs: num(process.env.PNC_OCSP_TIMEOUT_MS, 5000),
    /** Where the test PKI's OCSP responder appears in the certificates it issues. */
    mockOcspUrl: process.env.PNC_MOCK_OCSP_URL ?? 'http://ocsp.pnc-mock.invalid/ocsp',
  },

  /**
   * Charger client certificates (Security Profile 3), issued by PlugSure's
   * charging-station CA at onboarding or over OCPP. The CA is created on first
   * use, or bring your own with CHARGER_CA_CERT_FILE + CHARGER_CA_KEY_FILE.
   * CSMS_ROOT_CA_FILE: the root of the OCPP host's TLS certificate, handed to
   * chargers in the onboarding bundle (leave empty for a public CA).
   */
  chargerCa: {
    certPath: process.env.CHARGER_CA_CERT_FILE ?? '',
    keyPath: process.env.CHARGER_CA_KEY_FILE ?? '',
    csmsRootPath: process.env.CSMS_ROOT_CA_FILE ?? '',
    certDays: num(process.env.CHARGER_CERT_DAYS, 730),
    renewDays: num(process.env.CHARGER_CERT_RENEW_DAYS, 30),
  },

  /** Alert notifications by e-mail and WhatsApp (channels and rules live in the database). */
  alerts: {
    /**
     * SMTP hosts on loopback or a private network that alert e-mail may use
     * outside development/test (comma-separated host names or addresses), e.g. a
     * Postfix relay on this server: `127.0.0.1,localhost`. Tenants choose their SMTP
     * host in the console, so internal hosts are refused unless the PLATFORM
     * operator lists them here; nothing else on the internal network is reachable.
     */
    smtpAllowedInternalHosts: (process.env.SMTP_ALLOWED_INTERNAL_HOSTS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase().replace(/\.$/, ''))
      .filter(Boolean),
    /** Console origin put in notification links. Falls back to PUBLIC_BASE_URL. */
    consoleUrl: (process.env.CONSOLE_PUBLIC_URL ?? process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, ''),
    /** Time zone for quiet hours and times printed in messages. */
    timeZone: process.env.ALERT_TIMEZONE ?? 'Asia/Jakarta',
    /**
     * Flood guard: at most this many messages per recipient and channel in 15
     * minutes. A site-wide power cut raises an alert per charger; past the limit
     * the recipient gets one "more alerts suppressed" notice instead of dozens.
     */
    maxPer15Min: num(process.env.ALERT_NOTIFY_MAX_PER_15MIN, 20),
  },

  /** Platform commission and fee statements (rates are per customer, set in the platform console). */
  billing: {
    /** Who issues the statements: the platform operator. */
    issuerName: process.env.BILLING_ISSUER_NAME ?? 'PT. RailSure Solutions Indonesia (PlugSure)',
    issuerNpwp: process.env.BILLING_ISSUER_NPWP ?? '',
    /** Calendar months are cut in this time zone. */
    timeZone: process.env.BILLING_TIMEZONE ?? 'Asia/Jakarta',
  },

  /** Roaming over OCPI 2.2.1, as the charge point operator (partners live in the database). */
  ocpi: {
    /**
     * Public HTTPS origin partners call, e.g. https://ocpi.example.co.id. The
     * versions URL handed to partners is `<this>/ocpi/versions`. Defaults to
     * PUBLIC_BASE_URL.
     */
    publicUrl: (process.env.OCPI_PUBLIC_URL ?? process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, ''),
    /**
     * Whether PBJT-TL is part of a CDR's excl_vat amount. It is a regional tax
     * on electricity, not VAT, so by default excl_vat = subtotal + PBJT and
     * incl_vat adds PPN. VERIFY the roaming tax treatment with a tax advisor.
     */
    pbjtInExclVat: bool(process.env.OCPI_PBJT_IN_EXCL_VAT, true),
    /** How long a charger's Authorize waits for a partner's real-time answer. */
    realtimeAuthTimeoutMs: num(process.env.OCPI_REALTIME_AUTH_TIMEOUT_MS, 5_000),
    /** Timeout for every other call to a partner. */
    requestTimeoutMs: num(process.env.OCPI_REQUEST_TIMEOUT_MS, 15_000),
    /** Seconds we tell a partner to wait for a command's asynchronous result. */
    commandTimeoutS: num(process.env.OCPI_COMMAND_TIMEOUT_S, 60),
  },

  /** Driver app: map, push notifications, reservations. */
  driverApp: {
    /**
     * Map tiles. The default is the OpenStreetMap Foundation's tile server, whose
     * usage policy suits light use only; a busy deployment should point this at
     * its own or a commercial tile service (and the CSP follows it).
     */
    mapTileUrl: process.env.MAP_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    mapAttribution: process.env.MAP_ATTRIBUTION ?? '© OpenStreetMap contributors',
    /**
     * Web Push (VAPID). Leave empty to have a key pair generated once and kept
     * in the database (sealed with SECRETS_KEY), which is what most deployments
     * want: every process then signs with the same key.
     */
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? '',
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? '',
    /** Contact the push services can reach about this sender (mailto: or https:). */
    vapidSubject: process.env.VAPID_SUBJECT ?? 'mailto:ops@plugsure.id',
    /**
     * Push service hosts notifications may be sent to, in production (the
     * browser supplies the endpoint, so this is an SSRF allow-list). Suffix match.
     */
    pushHosts: (process.env.PUSH_ALLOWED_HOSTS ?? 'fcm.googleapis.com,push.services.mozilla.com,web.push.apple.com,notify.windows.com')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    /** How long a reservation holds a connector. */
    reservationMinutes: num(process.env.DRIVER_RESERVATION_MINUTES, 15),
    reservationsEnabled: bool(process.env.DRIVER_RESERVATIONS, true),
    /** Unused reservations in 24 h after which a driver may not reserve again that day. */
    reservationNoShowLimit: num(process.env.DRIVER_RESERVATION_NO_SHOW_LIMIT, 2),
  },

  /** Background workers (control loop, compliance sweep, FOTA scheduler). */
  workers: {
    /** In the split deployment the GATEWAY runs them, because it owns the sockets. */
    enabled: bool(process.env.RUN_WORKERS, true),
  },

  /**
   * Retention of the high-volume diagnostic logs (services/retention.ts, an
   * hourly worker pass). ocpp_frame (every OCPP message, with idTags) and
   * connection_attempt grew without limit: tens of GB a year on a few hundred
   * chargers. Days; 0 keeps rows forever. Nothing billing- or audit-relevant
   * lives in these tables — sessions, CDRs and the audit log are not touched.
   */
  retention: {
    ocppFrameDays: num(process.env.OCPP_FRAME_RETENTION_DAYS, 90),
    connectionAttemptDays: num(process.env.CONNECTION_ATTEMPT_RETENTION_DAYS, 30),
  },

  security: {
    /**
     * Key for the audit log HMAC. Without it the chain is merely a checksum:
     * anyone who can write to the table can recompute it. Must be set outside
     * development.
     */
    auditHmacKey: process.env.AUDIT_HMAC_KEY ?? '',
    /** Encryption key for webhook and provider secrets at rest (32-byte hex). */
    secretsKey: process.env.SECRETS_KEY ?? '',
  },

  /** Bound on how long a single session may be, for sanity checks during rating. */
  limits: {
    maxSessionHours: num(process.env.MAX_SESSION_HOURS, 168),
    /** Reject charger timestamps further than this from server time. */
    maxClockSkewHours: num(process.env.MAX_CLOCK_SKEW_HOURS, 48),
    /**
     * Below this, a session delivered nothing and the fixed fees are not charged.
     *
     * A charger that faulted a minute after StartTransaction was invoicing a full
     * Rp 25,000 biaya layanan plus admin fee for zero kWh — a chargeback and a
     * consumer-protection complaint waiting to happen. A few watt-hours of
     * handshake is not a charging session.
     */
    minBillableWh: num(process.env.MIN_BILLABLE_WH, 100),
  },

  tax: {
    /**
     * PPN. Statutory headline rate is 12% since 1 Jan 2025, but non-luxury goods
     * and services use "DPP nilai lain" = 11/12 x selling price, giving an
     * effective 11%. Compute it EXACTLY as the regulation specifies:
     *   DPP  = 11/12 x price
     *   PPN  = 12%   x DPP
     * Applying 11% directly yields the right total but the WRONG DPP on the
     * faktur pajak, which fails an audit.
     */
    ppnRateBps: num(process.env.PPN_RATE_BPS, 1200),
    ppnDppNumerator: num(process.env.PPN_DPP_NUM, 11),
    ppnDppDenominator: num(process.env.PPN_DPP_DEN, 12),
    /**
     * Whether PBJT (regional electricity tax) sits inside the PPN base.
     * Market practice (e.g. Voltron receipts) applies PPN last, on top of the
     * PBJT-inclusive amount. VERIFY with a tax advisor before go-live.
     */
    pbjtInsidePpnBase: bool(process.env.PBJT_IN_PPN_BASE, true),
    /**
     * What PBJT is levied on: 'energy' (the energy lines only) or 'subtotal'
     * (everything, including the service and admin fees).
     *
     * PBJT is *atas tenaga listrik* — a tax on electricity consumption. A biaya
     * layanan is not tenaga listrik, and the shipped behaviour taxed it anyway:
     * Rp 1,387 per 40 kWh session, and DPP, PPN and the faktur pajak all inherit
     * the error. 'energy' is the reading we believe is correct; it defaults that
     * way, and 'subtotal' restores the old behaviour if your advisor disagrees.
     * VERIFY before go-live.
     */
    pbjtBase: (process.env.PBJT_BASE ?? 'energy') as 'energy' | 'subtotal',
    /** IDR has no practical subunit. Round the payable total to this multiple. */
    roundingUnitIdr: num(process.env.ROUNDING_UNIT_IDR, 1),
  },

  /**
   * Regulatory service-fee ceilings per session, excluding PPN.
   * Kepmen ESDM 182.K/TL.04/MEM.S/2023. Slow and medium are deliberately
   * unregulated. VERIFY whether Kepmen 24.K/TL.01/MEM.L/2025 supersedes these.
   */
  regulatory: {
    serviceFeeCeilingIdr: {
      slow: null as number | null,      // <= 7 kW
      medium: null as number | null,    // > 7 kW .. 22 kW
      fast: 25_000,                     // > 22 kW .. 50 kW
      ultrafast: 57_000,                // > 50 kW
    },
    /** Retail energy ceiling = N_max x base. N is capped at 1.5 for layanan khusus. */
    layananKhususBase: Number(process.env.PLN_LK_BASE ?? 1645),
    layananKhususNMax: 1.5,
    curahBase: Number(process.env.PLN_CURAH_BASE ?? 707),
    curahQMin: 0.8,
    curahQMax: 3.0,
    /** PBJT cap for general electricity consumption under UU 1/2022 (HKPD). */
    pbjtMaxBps: 1000,
    /**
     * Per-session cap on occupancy (idle / per-minute) charges.
     *
     * This is NOT a figure from Kepmen ESDM 182.K/2023 — that instrument caps the
     * biaya layanan for the charging service, and an overstay penalty is a
     * commercially distinct charge that Indonesian operators do levy. It is a
     * platform safety bound: without it an abandoned vehicle accrues an unbounded
     * fee, which is how a 60 kWh delivery came out at Rp 6,692,360. Operators may
     * raise it deliberately; nothing may exceed it by accident.
     */
    idleFeeCapIdr: Number(process.env.IDLE_FEE_CAP_IDR ?? 100_000),
  },

  /** WBP (peak) window used to classify time-of-use blocks. Configurable per tenant later. */
  tou: {
    wbpStart: process.env.WBP_START ?? '17:00',
    wbpEnd: process.env.WBP_END ?? '22:00',
  },
};

export type Config = typeof config;

/**
 * May this environment relax a security control?
 *
 * Only an explicit `development` or `test` may. Every relaxation used to be
 * written as `env === 'production'` (strict) or `env !== 'production'` (lenient),
 * so NODE_ENV=staging, prod or a typo silently ran with development behaviour:
 * the driver sign-in code returned to the caller, the SSRF guard off, the
 * sandbox payment pages live, a superuser database role accepted. The rule is
 * now inverted: anything that is not explicitly development or test is treated
 * as production.
 */
export function isRelaxedEnv(env: string = config.env): boolean {
  return env === 'development' || env === 'test';
}

