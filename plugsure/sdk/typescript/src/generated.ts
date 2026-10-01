// Generated from the PlugSure CSMS OpenAPI document by tools/sdk/generate.mts. Do not edit:
// change the API catalogue (src/api/openapi/catalogue) and run `npm run sdk`.
/* eslint-disable */
import type { Transport, RequestOptions, BinaryBody } from './client.js';

/** The API version this SDK was generated from. */
export const API_VERSION = "1.4.0";

// ─────────────────────────────────────────────── schemas

export interface Alert {
  id: string;
  /** info | warning | critical. */
  severity: string;
  kind: string;
  message: string;
  raised_at: string;
  resolved_at?: string | null;
  acknowledged_at?: string | null;
  occurrences: number;
  last_raised_at?: string | null;
  site_id?: string | null;
}

export interface AlertRota {
  id: string;
  name: string;
  /** Alert contacts in rotation order. */
  member_ids: string[];
  shift: "daily" | "weekly";
  /** HH:MM, local time (the alert time zone). */
  handover_time: string;
  /** The first shift starts at handover_time on this day, with the first member. */
  starts_on: string;
  duty: {
    contactId: string | null;
    override: boolean;
    shiftEnds: string | null;
    nextContactId: string | null;
  };
  overrides: {
    id: string;
    rota_id?: string;
    contact_id: string;
    starts_at: string;
    ends_at: string;
    note?: string | null;
    created_at?: string;
  }[];
  created_at?: string;
}

export interface AlertRotaInput {
  name: string;
  /** Alert contacts, in the order they take shifts. */
  memberIds: string[];
  shift?: "daily" | "weekly";
  handoverTime?: string;
  startsOn: string;
}

export interface AlertRoutingChannel {
  kind: "email" | "whatsapp" | "sms";
  enabled: boolean;
  /** Non-secret settings. E-mail: host, port, security, username, fromAddress, fromName. WhatsApp: apiBase, phoneNumberId, templateName, templateLang. SMS: provider (twilio | zenziva | http), accountSid, from, messagingServiceSid, baseUrl (Twilio), userkey, endpoint (Zenziva), url (your gateway). */
  config: Record<string, unknown>;
  /** Whether an SMTP password / WhatsApp token / SMS credential is stored. The secret itself is never returned. */
  has_secret: boolean;
  /** WhatsApp only: where Meta sends delivery statuses (delivered, read, failed). Set this URL (PUBLIC_BASE_URL + path) and the verify token in the Meta app webhook settings (field: messages), and save the app secret so signatures can be checked. Null until the channel is saved. */
  webhook?: {
    path?: string;
    /** The full callback URL on the public address (PUBLIC_BASE_URL). */
    url?: string;
    verifyToken?: string;
    hasAppSecret?: boolean;
  } | null;
  last_test_at?: string | null;
  last_test_ok?: boolean | null;
  last_error?: string | null;
  updated_at?: string;
}

export interface AlertRoutingContact {
  id: string;
  name: string;
  email: string | null;
  /** E.164 digits without +, e.g. 6281234567890. */
  whatsapp: string | null;
  /** SMS number (E.164 digits without +); null = SMS goes to the WhatsApp number. */
  sms?: string | null;
  active: boolean;
  created_at?: string;
}

export interface AlertRoutingContactInput {
  name: string;
  /** E-mail address. At least one of email and whatsapp is required. */
  email?: string;
  /** WhatsApp number, e.g. 0812 3456 7890 or +62 812 3456 7890; stored as 6281234567890. */
  whatsapp?: string;
  /** SMS number when it differs from the WhatsApp number. At least one of email, whatsapp and sms is required. */
  sms?: string;
  active?: boolean;
}

export interface AlertRoutingNotification {
  id: number;
  alert_id: string | null;
  channel: "email" | "whatsapp" | "sms";
  destination: string;
  stage: "raised" | "escalation" | "resolved" | "storm" | "test";
  state: "pending" | "sent" | "failed" | "suppressed";
  attempts: number;
  next_attempt_at: string;
  last_error?: string | null;
  provider_ref?: string | null;
  created_at: string;
  sent_at?: string | null;
  /** WhatsApp: what Meta reported after accepting the message (sent = accepted only). */
  delivery?: "delivered" | "read" | "failed" | null;
  delivered_at?: string | null;
  read_at?: string | null;
  delivery_error?: string | null;
  /** An SMS sent because this WhatsApp notification (id) failed. */
  fallback_of?: number | null;
  kind?: string | null;
  severity?: string | null;
  message?: string | null;
  contact_name?: string | null;
  rule_name?: string | null;
}

export interface AlertRoutingRule {
  id: string;
  org_id?: string;
  name: string;
  enabled: boolean;
  min_severity: "info" | "warning" | "critical";
  /** Alert kinds (or `prefix.*`); empty = every kind. */
  kinds: string[];
  /** Empty = every site, and alerts with no site. */
  site_ids: string[];
  channels: ("email" | "whatsapp" | "sms")[];
  contact_ids: string[];
  /** On-call rotas: whoever is on duty when the alert is routed is notified too. */
  rota_ids?: string[];
  /** When a WhatsApp message fails (refused, or reported failed by Meta), send the same by SMS. */
  sms_fallback?: boolean;
  notify_resolved: boolean;
  /** Local time (HH:MM:SS) in the alert time zone. */
  quiet_start: string | null;
  quiet_end: string | null;
  escalate_after_min: number | null;
  escalate_contact_ids: string[];
  escalate_rota_ids?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface AlertRoutingRuleInput {
  name: string;
  enabled?: boolean;
  minSeverity?: "info" | "warning" | "critical";
  /** Alert kinds from GET /v1/alert-routing `kinds`, or a `prefix.*` wildcard. Empty = every kind. */
  kinds?: string[];
  /** Sites of this organisation. Empty = every site. */
  siteIds?: string[];
  channels: ("email" | "whatsapp" | "sms")[];
  /** People to notify. Required unless rotaIds is given. */
  contactIds?: string[];
  /** On-call rotas whose on-duty person is notified. */
  rotaIds?: string[];
  /** When a WhatsApp message fails, send it by SMS (needs whatsapp in channels and the SMS channel set up). */
  smsFallback?: boolean;
  notifyResolved?: boolean;
  /** HH:MM; give both quietStart and quietEnd, or neither. */
  quietStart?: string;
  quietEnd?: string;
  escalateAfterMin?: number | null;
  /** People to escalate to; with escalateAfterMin, this or escalateRotaIds is required. */
  escalateContactIds?: string[];
  /** Rotas whose on-duty person is escalated to. */
  escalateRotaIds?: string[];
}

export interface ApiKey {
  id: string;
  name: string;
  /** Public part of the key, safe to log. */
  prefix: string;
  permissions: string[];
  scope_type: "org" | "site" | "fleet";
  scope_id?: string | null;
  created_at: string;
  last_used_at?: string | null;
  revoked_at?: string | null;
  /** The key’s own limit, requests a minute; null = the installation default. */
  rate_limit_per_min: number | null;
  /** The limit in force for this key. */
  effective_rate_limit_per_min: number;
  /** Requests made with the key in the last 24 hours. */
  requests_24h?: number;
  /** Of those, refused for the rate limit (429). */
  limited_24h?: number;
  /** Of those, answered with another error (4xx or 5xx). */
  errors_24h?: number;
}

export interface ApiKeyIssued {
  id: string;
  /** The full secret (`psk_<prefix>_<secret>`). Shown once. */
  key: string;
  prefix: string;
  warning: string;
}

export interface ApiKeyUsageHour {
  /** Start of the hour (UTC). */
  hour: string;
  requests: number;
  /** Refused for the rate limit (429). */
  limited: number;
  /** Answered with another error (4xx or 5xx). */
  errors: number;
}

export interface AuditChain {
  /** false when the hash chain shows tampering, deletion or truncation. */
  ok: boolean;
  entries: number;
  expectedEntries: number;
  problems: {
    kind: "mutated" | "broken_link" | "forged_row" | "deleted" | "truncated" | "reordered" | "missing_head" | "head_mismatch";
    atId?: number;
    atSeq?: number;
    detail: string;
  }[];
  brokenAtId?: number;
}

export interface AuditEntry {
  ts: string;
  /** user | api_client | system | charge_point. */
  actor_type: string;
  actor_id?: string | null;
  action: string;
  target_type?: string | null;
  target_id?: string | null;
  /** JSON snapshot recorded with the action, or null. */
  after_state?: unknown;
}

export interface AuthLoginResult {
  ok: true;
  user: {
    id: string;
    name: string;
    email: string;
  };
  /** True after an administrator issued a one-time password; every other route answers 403 until it is changed. */
  mustChangePassword: boolean;
}

export interface AuthMe {
  /** The signed-in operator. For an API key or the development bypass: a synthetic user with a null email. */
  user: {
    id: string;
    name: string;
    email: string | null;
    mustChangePassword?: boolean;
  };
  org: {
    id: string;
    name?: string;
    pkp?: boolean;
    npwp?: string | null;
  };
  roles: {
    name: string;
    /** org, site, owner or fleet */
    scope_type: string;
    scope_id: string | null;
    label: string;
  }[];
  permissions: string[];
  /** Site ids the caller may read; null = every site of the organisation. */
  visibleSites: string[] | null;
  owners: {
    id: string;
    name: string;
    legal_name?: string | null;
  }[];
  /** Fleet customer portal: the fleet accounts this user belongs to (the console then shows only the portal). */
  fleets?: {
    id: string;
    name: string;
    legal_name?: string | null;
  }[];
  features: {
    vault: boolean;
    bridge: boolean;
    publicBaseUrl?: string | null;
    ocppPublicUrl?: string | null;
    supportedVersions: string[];
    minSecurityProfile: number;
    effectivePpnPct: number;
    wbp: {
      start: string;
      end: string;
    };
    env: string;
  };
}

export interface AvailabilityReport {
  from: string;
  to: string;
  rows: AvailabilityRow[];
}

export interface AvailabilityRow {
  chargePointId: string;
  ocppIdentity: string;
  displayName: string | null;
  siteId: string;
  siteName: string;
  connectors: number;
  online: boolean;
  /** Percent, one decimal. Null when the charger has no time in the window. */
  uptimePct: number | null;
  outages: number;
  offlineMinutes: number;
  longestOutageMin: number;
  sessions: number;
  energyKwh: number;
  revenueIdr: number;
  /** Connector-time in sessions over connector-time in the window, percent. */
  utilisationPct: number | null;
}

export interface BillingFinaliseInput {
  /** A month that has ended. */
  month: string;
}

export interface BillingFinalised {
  /** The statement number, e.g. PSC-202608-ACME. */
  number: string;
}

export type BillingOwnerRow = BillingShareFigures & {
  ownerId: string;
  name: string;
  legalName: string | null;
  archived: boolean;
  customPlan: boolean;
  status: "draft" | "final";
  number: string | null;
  platformPpnIdr?: number;
  invoiceTotalIdr?: number;
  /** Number of statement warnings. */
  warnings?: number;
};

export interface BillingOwnersOverview {
  /** A calendar month, YYYY-MM. */
  period: string;
  owners: BillingOwnerRow[];
  /** The operator's own sites (no owner). */
  operatorOwn: BillingShareFigures;
  totals: BillingShareFigures;
  /** The current month. */
  current: string;
}

export interface BillingPlanInForce {
  plan: StatementPlan;
  /** Rates differ from the published ones. */
  custom: boolean;
  /** YYYY-MM the version took effect; null = published rates, never set. */
  effectiveFrom: string | null;
  updatedAt: string | null;
  ownPlan: boolean;
}

export interface BillingPlanInput {
  /** The new rates, or null to return to the published rates from effectiveFrom. */
  plan?: StatementPlanInput | null;
  /** First month the plan applies to (default: the current month). Must be after the last finalised month. */
  effectiveFrom?: string;
}

export interface BillingPlanSaved {
  plan: StatementPlan;
  /** A calendar month, YYYY-MM. */
  effectiveFrom: string;
}

export interface BillingPlanVersion {
  /** A calendar month, YYYY-MM. */
  effectiveFrom: string;
  plan: StatementPlan;
  custom: boolean;
  updatedAt: string;
}

export interface BillingShareFigures {
  sites?: number;
  chargers?: number;
  sessions?: number;
  energyKwh?: number;
  grossIdr?: number;
  pbjtIdr?: number;
  ppnIdr?: number;
  baseIdr?: number;
  mdrIdr?: number;
  ownerShareIdr?: number;
  platformShareIdr?: number;
}

export interface CampaignCreated {
  ok: true;
  id: string;
  /** Charge points a job was created for. */
  targets: number;
}

export interface CampaignDetail {
  campaign: {
    id: string;
    org_id?: string;
    image_id?: string;
    name: string;
    target_type?: string;
    target_ids?: string[];
    window_start?: string | null;
    window_end?: string | null;
    max_retries?: number;
    retry_interval_s?: number;
    status: string;
    created_by?: string | null;
    created_at?: string;
    completed_at?: string | null;
    image_name: string;
    image_version: string;
  };
  jobs: CampaignJob[];
  stages: string[];
}

export interface CampaignJob {
  id: string;
  state: string;
  attempts: number;
  last_error?: string | null;
  next_attempt_at?: string | null;
  dispatched_at?: string | null;
  updated_at?: string;
  firmware_before?: string | null;
  ocpp_identity: string;
  firmware_now?: string | null;
  model?: string | null;
  site_name?: string;
  online: boolean;
  /** Index into stages; -1 before dispatch or after failure. */
  stage: number;
}

export interface CampaignRequest {
  imageId: string;
  name: string;
  targetType: "charge_point" | "site" | "fleet";
  /** Charge point ids or site ids (UUIDs); not used for fleet. Non-UUID entries are dropped. */
  targetIds?: string[];
  /** HH:MM local site time; set both ends or neither. */
  windowStart?: string | null;
  /** HH:MM local site time. */
  windowEnd?: string | null;
  maxRetries?: number;
  retryIntervalS?: number;
}

export interface CampaignSummary {
  id: string;
  name: string;
  status: "scheduled" | "running" | "completed" | "cancelled";
  target_type: "charge_point" | "site" | "fleet";
  window_start?: string | null;
  window_end?: string | null;
  max_retries?: number;
  retry_interval_s?: number;
  created_by?: string | null;
  created_at?: string;
  completed_at?: string | null;
  image_name: string;
  image_version: string;
  jobs: number;
  verified: number;
  failed: number;
  pending: number;
}

export interface CardHold {
  id: string;
  /** card_hold: a card pre-authorisation; postpay: a linked e-wallet charged after the session (nothing held at the acquirer). */
  kind: "card_hold" | "postpay";
  channel?: string | null;
  state: "held" | "capturing" | "captured" | "capture_failed" | "releasing" | "released" | "release_failed";
  heldIdr: number | null;
  captureIdr?: number | null;
  capturedIdr?: number | null;
  attempts: number;
  error?: string | null;
  nextAttemptAt?: string | null;
  authorisedAt?: string | null;
  settledAt?: string | null;
  /** The card authorisation expired at the acquirer before it was captured: nothing was taken from the card and it cannot be retried. The driver can pay it in the app (paidInApp), or the operator collects it another way or writes it off. */
  expired?: boolean;
  /** An expired card hold, or a post-pay session whose e-wallet link ended, that the driver has since paid in the app. */
  paidInApp?: boolean;
  provider: string;
  providerRef?: string | null;
  createdAt: string;
  sessionId?: string | null;
  site?: string | null;
  charger?: string | null;
}

export interface ChargePoint {
  id: string;
  ocpp_identity: string;
  display_name?: string | null;
  vendor?: string | null;
  model?: string | null;
  firmware?: string | null;
  serial?: string | null;
  /** ocpp1.6 | ocpp2.0.1 | ocpp2.1, as registered or last booted. */
  ocpp_version?: string | null;
  /** pending_adoption | provisioning | online | offline | decommissioned. */
  status: string;
  last_seen_at?: string | null;
  last_heartbeat_at?: string | null;
  offline_since?: string | null;
  security_profile: number;
  has_auth_key: boolean;
  has_client_cert: boolean;
  auth_key_rotated_at?: string | null;
  key_rotation_days?: number | null;
  site_name: string;
  site_id: string;
  connectors: ChargePointConnector[];
  /** Whether the charger holds a live WebSocket right now. */
  online: boolean;
  /** OCPP subprotocol negotiated on the live connection. */
  negotiatedVersion: string | null;
}

export interface ChargePointAuthorizationKey {
  /** The AuthorizationKey in plain text. Shown once; it cannot be retrieved again. */
  key: string;
  chargePointId: string;
  ocppIdentity: string;
  rotatedAt: string;
  /** Until then the previous key is also accepted. */
  graceEndsAt: string;
  commissioning: {
    config: {
      format?: string;
      chargePointId?: string;
      centralSystemUrl?: string;
      ocppVersions?: string[];
      securityProfile?: number;
      basicAuth?: {
        username?: string;
        password?: string;
      };
      heartbeatIntervalS?: number;
      generatedAt?: string;
    };
    /** The same config, pretty-printed. */
    json: string;
    /** PNG data: URL of a QR code carrying the config. */
    qrDataUrl: string;
  };
  warning: string;
}

export interface ChargePointConnector {
  connectorUuid: string;
  evseNo: number;
  connectorId: number;
  /** Plug code: cCCS2, sType2, cType2, cChaDeMo, cGBT, sGBT. */
  connectorType?: string | null;
  /** Last OCPP connector status (Available, Charging, Faulted…). */
  status: string;
  errorCode?: string | null;
  maxPowerW: number;
  currentType: "AC" | "DC";
  phases?: number;
  /** Derived meter-verification state: verified | due_soon | lapsed | unknown | pending | exempt. */
  teraStatus?: string;
  /** Operator-declared certification: verified | pending | exempt. */
  teraCertStatus?: string;
  teraDueAt?: string | null;
  maintenanceReason?: string | null;
  sessionId?: string | null;
  transactionId?: string | null;
  sessionStartedAt?: string | null;
  sessionEnergyWh?: number | null;
}

export interface ChargePointConnectorSpec {
  connectorId: number;
  connectorType: "cCCS2" | "sType2" | "cType2" | "cChaDeMo" | "cGBT" | "sGBT";
  currentKind: "DC" | "AC3" | "AC1";
  maxPowerW: number;
  ratedVoltageV?: number | null;
  ratedCurrentA?: number | null;
  meterSerial?: string | null;
  /** The meter’s public key for signed readings (OCMF): hex DER, base64 or PEM. Signatures are verified against it. Omit to keep it; null clears it. */
  meterPublicKey?: string | null;
  /** 0.5, 1.0 or 2.0. */
  accuracyClass?: string | null;
  typeApprovalNo?: string | null;
  teraCertStatus?: "verified" | "pending" | "exempt";
  teraLastAt?: string | null;
  /** Required when teraCertStatus is verified. */
  teraDueAt?: string | null;
}

export interface ChargePointEvseSpec {
  evseId: number;
  connectors: ChargePointConnectorSpec[];
}

export interface ChargerCa {
  /** PlugSure's own CA, or yours (CHARGER_CA_CERT_FILE / CHARGER_CA_KEY_FILE). */
  source: "builtin" | "file";
  subject: string;
  fingerprint: string;
  notAfter: string;
  certificatePem: string;
  /** Default validity of charger certificates. */
  certificateDays: number;
  /** The OCPP host's TLS root handed to chargers (CSMS_ROOT_CA_FILE), or null for a public CA. */
  csmsRootPem?: string | null;
  proxy: {
    caddy?: string;
    gateway?: string;
  };
}

export interface CheckoutQrisCharge {
  providerRef: string;
  /** Payload to render as a QR code. */
  qrString: string;
  amountIdr: number;
  expiresAt: string;
  status: "pending" | "paid" | "expired" | "failed";
}

export interface CheckoutQrisResult {
  paymentIntentId: string;
  qr: CheckoutQrisCharge;
  /** Energy the payment buys, quoted against the worst-case tariff block. */
  allowanceWh: number;
  allowanceKwh: number;
  estimatedMdrIdr: number;
  inZeroMdrBand: boolean;
  /** The only idTag that can claim this payment. Show it to the driver. */
  startToken: string;
  /** true when PlugSure generated the token (walk-up), false when the caller supplied idToken. */
  startTokenMinted: boolean;
  expiresInMinutes: number;
}

export interface CommandRemoteStartResult {
  /** The charger's answer: Accepted or Rejected. */
  status?: string;
  limit: {
    type: "none" | "energy" | "duration" | "amount";
    energyLimitWh: number | null;
    durationLimitS: number | null;
  };
}

/** The charger's own answer to the OCPP call (e.g. `{ "status": "Accepted" }`). GetConfiguration answers `configurationKey` / `unknownKey`; GetCompositeSchedule and DataTransfer add their payload fields. */
export interface CommandResult {
  status?: string;
  configurationKey?: {
    key?: string;
    readonly?: boolean;
    value?: string;
  }[];
  unknownKey?: string[];
  connectorId?: number;
  scheduleStart?: string;
  chargingSchedule?: unknown;
  data?: unknown;
  fileName?: string;
}

export interface CommissioningBundle {
  config: CommissioningConfig;
  /** The config pretty-printed as JSON text. */
  json: string;
  /** PNG data: URL of a QR code carrying the config. */
  qrDataUrl: string;
}

/** Profile 3 from PlugSure's charging-station CA. */
export interface CommissioningCaBundle {
  ok: true;
  source: "plugsure_ca" | "plugsure_ca_csr";
  fingerprint: string;
  serialNumber: string;
  expiresAt: string;
  subject?: string;
  keyType?: string;
  files: {
    "client.crt": string;
    /** Method auto only: the private key, shown only in this response and not stored. */
    "client.key"?: string;
    /** The charging-station CA. */
    "ca.pem": string;
    /** client.crt followed by the CA. */
    "chain.pem": string;
    /** The root of the OCPP host's TLS certificate, when configured (CSMS_ROOT_CA_FILE). */
    "csms-root.pem"?: string;
  };
  commissioning: CommissioningBundle;
  warning: string;
}

/** Profile 3 with your own certificate: the fingerprint now bound (null when the binding was cleared). */
export interface CommissioningCertBound {
  ok: true;
  fingerprint: string | null;
  certificate: {
    subject?: string;
    issuer?: string;
    validFrom?: string;
    validTo?: string;
    serialNumber?: string;
    fingerprint?: string;
  } | null;
}

export interface CommissioningConfig {
  format: "plugsure-commissioning/1";
  chargePointId: string;
  centralSystemUrl: string;
  ocppVersions: string[];
  securityProfile: number;
  /** Present only in the response that issued the key. */
  basicAuth?: {
    username?: string;
    password?: string;
  };
  heartbeatIntervalS: number;
  generatedAt: string;
}

/** Profiles 1 and 2: a new AuthorizationKey. */
export interface CommissioningKeyIssued {
  /** Plaintext key, shown only in this response. */
  key: string;
  chargePointId: string;
  ocppIdentity: string;
  rotatedAt: string;
  /** Until then the previous key is still accepted. */
  graceEndsAt: string;
  commissioning: CommissioningBundle;
  warning: string;
}

export interface CommissioningKeysRequest {
  profile?: 1 | 2 | 3;
  /** Profiles 1-2: your own key, 16-40 letters and digits with at least 8 distinct characters. Omit to generate one. */
  key?: string;
  /** Profiles 1-2: rotation reminder to store with the key. */
  rotationDays?: number;
  /** Profile 3: `auto` issues a key and certificate from PlugSure's charging-station CA (the key is shown once); `csr` signs the charger's own request (`csr`); `vault` issues from Vault PKI. */
  method?: "auto" | "csr" | "vault";
  /** Method auto: ECDSA P-256 (recommended) or RSA 2048, whichever the charger supports. */
  keyType?: "ec" | "rsa";
  /** Method csr: the charger's PKCS#10 request (PEM). Its CN must be the charge point identity. */
  csr?: string;
  /** Methods auto and csr: validity in days (default CHARGER_CERT_DAYS, 730). */
  days?: number;
  /** Profile 2: after its first boot the charger is asked for a CSR over OCPP, gets its certificate with CertificateSigned and is moved to Profile 3 (OCPP 1.6 Security Whitepaper chargers). */
  autoCertificate?: boolean;
  /** Profile 3: bind this PEM certificate (its SHA-256 fingerprint is stored). */
  certificatePem?: string;
  /** Profile 3: bind this SHA-256 fingerprint (64 hex, colons allowed). */
  fingerprint?: string;
}

export interface CommissioningStatus {
  identity: string;
  online: boolean;
  /** pending_adoption, provisioning, online, offline or decommissioned. */
  status: string;
  bootCount: number;
  lastSeenAt: string | null;
  lastBootAt: string | null;
  hardware: {
    vendor?: string | null;
    model?: string | null;
    firmware?: string | null;
    ocppVersion?: string | null;
  };
  /** The most recent WebSocket connection attempt. remote_ip is omitted for site-scoped users. */
  lastAttempt: {
    ts?: string;
    outcome?: string;
    detail?: string | null;
    tls?: boolean;
    auth_present?: boolean;
    subprotocols?: string | null;
    negotiated?: string | null;
    remote_ip?: string | null;
  } | null;
  adopted: boolean;
  headline: string;
}

/** Profile 3 via Vault: a new client certificate and private key. */
export interface CommissioningVaultBundle {
  ok: true;
  fingerprint: string;
  serialNumber: string;
  expiresAt: string | null;
  files: {
    "client.crt": string;
    /** Private key, shown only in this response and not stored. */
    "client.key": string;
    "ca.pem": string;
  };
  commissioning: CommissioningBundle;
  warning: string;
}

export interface ComplianceMeter {
  chargePoint: string;
  evseNo: number;
  meterSerial?: string | null;
  accuracyClass?: string | null;
  typeApprovalNo?: string | null;
  teraLastAt?: string | null;
  teraDueAt?: string | null;
  teraStatus: string;
  teraCertStatus: string;
}

export interface ComplianceSite {
  id: string;
  name: string;
  spklu_id?: string | null;
  spklu_scheme?: string | null;
  slo_number?: string | null;
  slo_issued_at?: string | null;
  slo_expires_at?: string | null;
  kabupaten_kota_code?: string | null;
  pbjt_rate_bps: number;
  meters: ComplianceMeter[];
  spkluParsed: {
    raw?: string;
    entityCode?: string;
    scheme?: string;
    schemeFamily?: "provider" | "retailer";
    ownsAsset?: boolean;
    selfOperated?: boolean;
    block?: string;
    kabupatenKotaCode?: string;
    sequence?: string;
  } | null;
  spkluIdValid: boolean | null;
  municipalityMatchesSpklu: boolean | null;
  sloDaysRemaining: number | null;
}

export interface ConfigChangeRequest {
  key: string;
  value?: string;
}

export interface ConfigChangeResult {
  /** true when the charger answered Accepted or RebootRequired. */
  ok: boolean;
  /** Accepted, Rejected, RebootRequired, NotSupported, or NoResponse. */
  status: string;
  rebootRequired: boolean;
}

export interface ConfigKey {
  key: string;
  /** Last value read or written; always null for write-only keys. */
  value: string | null;
  readonly: boolean;
  rebootRequired: boolean;
  /** Result of the last change: Accepted, Rejected, RebootRequired, NotSupported or NoResponse. */
  lastStatus: string | null;
  readAt: string | null;
  category: "Core" | "Smart Charging" | "Security" | "Metrology" | "Networking" | "Local Auth" | "Vendor";
  type: "integer" | "boolean" | "csl" | "string";
  unit: string | null;
  description: string;
  /** PlugSure provisions this key itself. */
  managed: boolean;
  writeOnly: boolean;
  /** false for catalogue keys the charger has not reported. */
  reported: boolean;
}

export interface ConfigView {
  /** true when the charger answered GetConfiguration during this request. */
  live: boolean;
  /** Why the stored snapshot is shown instead of a live read. */
  error: string | null;
  keys: ConfigKey[];
  categories: string[];
}

export interface ConnectionAttempt {
  id: number;
  ts: string;
  remote_ip?: string | null;
  forwarded_for?: string | null;
  request_path?: string | null;
  ocpp_identity?: string | null;
  /** Exactly what the charger offered. */
  subprotocols?: string | null;
  /** What the gateway echoed back, if anything. */
  negotiated?: string | null;
  auth_present: boolean;
  auth_scheme?: string | null;
  tls: boolean;
  user_agent?: string | null;
  /** accepted | accepted_pending_adoption | rejected_unknown_cp | rejected_auth | rejected_no_subprotocol | rejected_no_identity | rejected_tls_required | rejected_malformed_path | error. */
  outcome: string;
  http_status?: number | null;
  detail?: string | null;
}

export interface ConnectionAttemptStats {
  accepted: number;
  pending_adoption: number;
  rejected: number;
  identities: number;
}

export interface CpDetail {
  id: string;
  ocpp_identity: string;
  display_name?: string | null;
  vendor?: string | null;
  model?: string | null;
  serial?: string | null;
  firmware?: string | null;
  ocpp_version?: string | null;
  security_profile?: number;
  has_auth_key?: boolean;
  auth_key_rotated_at?: string | null;
  key_rotation_days?: number | null;
  client_cert_fingerprint?: string | null;
  status: string;
  last_seen_at?: string | null;
  last_heartbeat_at?: string | null;
  offline_since?: string | null;
  boot_count?: number;
  adopted_at?: string | null;
  first_seen_at?: string | null;
  commissioned_at?: string | null;
  decommissioned_at?: string | null;
  created_at?: string;
  site_id?: string;
  site_name?: string;
  org_id?: string;
  timezone?: string;
  connectors: CpDetailConnector[];
  online: boolean;
  negotiatedVersion: string | null;
  /** The WebSocket URL the charger should be configured with. */
  ocppUrl: string;
}

export interface CpDetailConnector {
  id: string;
  evse_id: number;
  connector_id: number;
  connector_type?: string | null;
  current_type?: string;
  phases?: number;
  max_power_w?: number;
  rated_voltage_v?: number | null;
  rated_current_a?: number | null;
  status: string;
  status_updated_at?: string | null;
  error_code?: string | null;
  vendor_error_code?: string | null;
  status_info?: string | null;
  meter_serial?: string | null;
  /** The meter’s public key (hex DER) signed readings are checked against. */
  meter_public_key?: string | null;
  meter_accuracy_class?: string | null;
  tera_type_approval_no?: string | null;
  tera_last_at?: string | null;
  tera_due_at?: string | null;
  tera_status?: string;
  tera_cert_status?: "verified" | "pending" | "exempt";
  priority?: number;
  maintenance_reason?: string | null;
  maintenance_since?: string | null;
  session_id?: string | null;
  ocpp_transaction_id?: string | null;
  session_started_at?: string | null;
  session_energy_wh?: number | null;
  /** Card of the active session; masked to the last 4 characters for site-scoped users. */
  session_id_tag?: string | null;
}

export interface CpDetailProfileInput {
  displayName?: string | null;
  vendor?: string | null;
  model?: string | null;
  serial?: string | null;
  firmware?: string | null;
  /** Any value other than ocpp2.0.1 or ocpp2.1 is stored as ocpp1.6. */
  ocppVersion?: "ocpp1.6" | "ocpp2.0.1" | "ocpp2.1";
  /** AuthorizationKey rotation reminder, 7-730 days; null removes it. */
  keyRotationDays?: number | null;
  /** Move the charge point to another site of the same organisation. */
  siteId?: string;
}

export interface CurtailPriorityList {
  priorities?: {
    connectorUuid: string;
    /** Higher wins under the priority strategy; clamped to -100..100. */
    priority?: number;
  }[];
}

export interface CurtailRequest {
  /** true to curtail the site to 0 W; false (or omitted) lifts the curtailment. */
  curtailed?: boolean;
  /** Defaults to "Genset / grid outage" when curtailing. */
  reason?: string;
}

export interface CurtailResult {
  ok: true;
  curtailed: boolean;
  dispatch: "started";
}

export interface Dashboard {
  chargers: {
    total: number;
    online: number;
    pending: number;
    faulted: number;
  };
  /** Connector count by OCPP status (Available, Charging, Faulted, …). */
  connectors: Record<string, number>;
  /** Today (Asia/Jakarta) so far. Null when the caller lacks session:read. */
  today: {
    sessions: number;
    energy_wh: number;
    revenue_idr: number;
    active: number;
  } | null;
  series: {
    day: string;
    energy_wh: number;
    revenue_idr: number;
    sessions: number;
  }[];
  alerts: {
    critical: number;
    warning: number;
  };
}

export interface DiagnosticsContent {
  available: boolean;
  fileName?: string | null;
  binary?: boolean;
  /** Log text (gzip is unpacked), first 2 MiB; null for binary files. */
  text?: string | null;
  truncated?: boolean;
  note?: string | null;
}

export interface DiagnosticsRequestBody {
  /** Oldest log entry wanted. */
  startTime?: string;
  /** Newest log entry wanted. */
  stopTime?: string;
  /** Your own ftp://, ftps://, sftp:// or http(s):// upload location. Omit to use the built-in receiver (needs PUBLIC_BASE_URL or a reachable request origin). */
  location?: string;
}

export interface DiagnosticsRequestRow {
  id: string;
  /** Requested, Uploading, Uploaded, UploadFailed, Rejected or Idle. */
  status: string;
  start_time?: string | null;
  stop_time?: string | null;
  location: string;
  file_name?: string | null;
  size_bytes?: number | null;
  requested_by?: string | null;
  requested_at: string;
  updated_at?: string;
  has_file: boolean;
  /** The built-in one-time upload receiver was used. */
  builtin: boolean;
  ocpp_identity: string;
}

export interface DiagnosticsRequested {
  ok: true;
  id: string;
  fileName: string | null;
  location: string;
}

/** The operator’s own driver app. */
export interface DriverAppBrand {
  orgId: string;
  /** Short name used in the preview address and icon paths. */
  slug: string;
  /** Live: served on its web address. Draft: preview only. */
  status: "draft" | "live";
  appName: string;
  /** Under the icon on a phone. */
  shortName: string;
  taglineId?: string | null;
  taglineEn?: string | null;
  descriptionId?: string | null;
  descriptionEn?: string | null;
  accentColor: string;
  /** Behind the icon in maskable and App Store icons. */
  badgeColor: string;
  hasIcon: boolean;
  iconSha256?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  privacyUrl?: string | null;
  termsUrl?: string | null;
  /** The app’s own web address, e.g. app.nusantaracharge.id. */
  hostname?: string | null;
  androidPackage?: string | null;
  androidCertSha256: string[];
  iosBundleId?: string | null;
  iosTeamId?: string | null;
  versionName: string;
  versionCode: number;
  updatedAt: string;
  publishedAt?: string | null;
  /** The APNs key’s id (the key itself is never returned). */
  apnsKeyId?: string | null;
  /** An APNs key is stored: the iOS app gets native notifications. */
  apnsConfigured?: boolean;
  apnsCheckedAt?: string | null;
  /** Apple accepted the key, Team ID and bundle identifier at the last check (or refused them while sending). */
  apnsCheckOk?: boolean | null;
  apnsCheckDetail?: string | null;
}

export interface DriverAppView {
  /** Null: the operator uses the PlugSure app. */
  brand: DriverAppBrand | null;
  palette: {
    dark: {
      /** The accent as used: nudged lighter (dark theme) or darker (light theme) until it reads at 4.5:1 or more. */
      accent: string;
      deep: string;
      /** Text on a solid accent fill. */
      on: string;
      glow: string;
      /** Lowest contrast of the accent against the theme’s surfaces. */
      contrast: number;
    };
    light: {
      /** The accent as used: nudged lighter (dark theme) or darker (light theme) until it reads at 4.5:1 or more. */
      accent: string;
      deep: string;
      /** Text on a solid accent fill. */
      on: string;
      glow: string;
      /** Lowest contrast of the accent against the theme’s surfaces. */
      contrast: number;
    };
    badge: string;
    adjusted: boolean;
  } | null;
  checks: {
    key: string;
    ok: boolean;
    label: string;
    for: "live" | "play" | "appstore" | "recommended";
  }[];
  previewUrl: string | null;
  appUrl: string | null;
  iconUrls: Record<string, string> | null;
  maskableUrl: string | null;
  /** Point the web address here (CNAME). */
  dnsTarget?: string | null;
  /** iPhones registered for native notifications. */
  iosPushDevices?: number;
  /** iOS Live Activities: charges shown on lock screens now, and iPhones that let PlugSure start one (iOS 17.2+). */
  liveActivities?: {
    active?: number;
    pushToStart?: number;
  };
}

export interface Error {
  /** What went wrong, in plain words. */
  error: string;
  /** A stable code, where there is one (e.g. password_change_required). */
  code?: string;
}

export interface EvseConnectorSpec {
  connectorId: number;
  connectorType: "cCCS2" | "sType2" | "cType2" | "cChaDeMo" | "cGBT" | "sGBT";
  currentKind: "DC" | "AC3" | "AC1";
  /** Nameplate power; AC1 at most 7400 W, AC3 at most 44000 W. */
  maxPowerW: number;
  /** 100-1500 V. */
  ratedVoltageV?: number | null;
  /** 1-1000 A. */
  ratedCurrentA?: number | null;
  meterSerial?: string | null;
  /** The meter’s public key for signed readings (OCMF): hex DER, base64 or PEM. Omit to keep it; null clears it. */
  meterPublicKey?: string | null;
  /** 0.5, 1.0 or 2.0. */
  accuracyClass?: string | null;
  typeApprovalNo?: string | null;
  teraCertStatus?: "verified" | "pending" | "exempt";
  /** YYYY-MM-DD. */
  teraLastAt?: string | null;
  /** YYYY-MM-DD; required when teraCertStatus is verified. */
  teraDueAt?: string | null;
}

export interface EvseSpec {
  evseId: number;
  connectors: EvseConnectorSpec[];
}

export interface EvseTopology {
  evses: EvseSpec[];
}

export interface FirmwareImage {
  id: string;
  name: string;
  version: string;
  vendor?: string | null;
  compatible_models: string[];
  source: "upload" | "url";
  url?: string | null;
  file_name?: string | null;
  size_bytes?: number | null;
  sha256?: string | null;
  sha256_verified: boolean;
  notes?: string | null;
  created_by?: string | null;
  created_at: string;
  archived_at?: string | null;
  /** Campaigns that use this image. */
  campaigns: number;
}

export interface FirmwareImageCreated {
  ok: true;
  id: string;
  /** Upload only: SHA-256 of the stored file. */
  sha256?: string;
  /** Upload only: bytes stored. */
  size?: number;
}

export interface FirmwareImageUrlRequest {
  name: string;
  /** The version string the charger will report after the update. */
  version: string;
  /** Public HTTPS download URL; private and internal addresses are refused. */
  url: string;
  vendor?: string;
  /** Model names (substring match, case-insensitive) a campaign may target; array or comma-separated string, at most 50. */
  compatibleModels?: string[] | string;
  /** Declared SHA-256 (64 hex characters). */
  sha256?: string;
  notes?: string;
}

export interface FirmwareVerifyResult {
  ok: true;
  sha256: string;
  size: number;
}

export interface FleetAccount {
  id: string;
  /** The fleet name, as on its cards in the RFID centre. */
  name: string;
  legal_name?: string | null;
  /** 16-digit NPWP, or a NIK. */
  tax_id?: string | null;
  tax_id_kind: "TIN" | "NIK" | "Passport" | "Other";
  /** 22-digit NITKU; empty = head office. */
  nitku?: string | null;
  address?: string | null;
  billing_email?: string | null;
  contact_name?: string | null;
  phone?: string | null;
  payment_terms_days: number;
  /** Re-bill partner-network charging on the invoice. */
  include_roaming: boolean;
  /** Standing consent: the fleet’s cars give energy back at sites with a bidirectional programme. */
  v2x_allowed?: boolean;
  /** Battery floor for the fleet’s cars when giving energy back (the site’s floor applies if higher). */
  v2x_min_soc_percent?: number;
  notes?: string | null;
  archived_at?: string | null;
  created_at?: string;
  updated_at?: string;
  /** Card count (list) or the cards (detail). */
  cards?: unknown;
  open_invoices?: number;
  /** Still owed on issued invoices, after credit notes. */
  outstanding_idr?: number;
  /** Fleet customer portal users (list). */
  portal_users?: number;
}

export type FleetAccountDetail = FleetAccount;

export interface FleetAccountInput {
  name?: string;
  legalName?: string;
  taxIdKind?: "TIN" | "NIK" | "Passport" | "Other";
  /** NPWP (15 or 16 digits) or NIK (16 digits). */
  taxId?: string;
  /** 22 digits; leave empty for the head office. */
  nitku?: string;
  address?: string;
  /** One or more addresses, comma-separated. */
  billingEmail?: string;
  contactName?: string;
  phone?: string;
  paymentTermsDays?: number;
  includeRoaming?: boolean;
  /** The fleet agrees that its cars give energy back at sites with a bidirectional programme (V2G / V2B). The credit per kWh reduces each session on the invoice. */
  v2xAllowed?: boolean;
  /** Battery floor for the fleet’s cars. */
  v2xMinSocPercent?: number;
  notes?: string;
}

export interface FleetBillingSettings {
  seller: FleetSeller;
  settings: {
    /** Invoice numbers are PREFIX/YYYY/MM/NNNN. */
    prefix: string;
    paymentInstructions: string;
    efaktur: {
      /** A = goods, B = services. */
      itemOpt?: "A" | "B";
      /** 6-digit e-Faktur goods/service code. */
      itemCode?: string;
      /** Coretax unit code, UM.nnnn. */
      unitCode?: string;
      /** Confirmed with a tax adviser; required before export. */
      confirmed?: boolean;
      confirmedBy?: string | null;
      confirmedAt?: string | null;
    };
  };
  /** Why e-Faktur export is not possible yet; null when it is. */
  efakturReady?: string | null;
}

export interface FleetCreditLine {
  description: string;
  /** Credited, PPN included. */
  amountIdr: number;
  /** Carries PPN (split like an invoice line). */
  taxed: boolean;
  /** Price subject to PPN. */
  taxBaseIdr?: number;
  /** DPP nilai lain, 11/12 of the price. */
  dppIdr?: number;
  /** 12% of the DPP. */
  ppnIdr?: number;
}

/** A numbered credit note against a fleet invoice. The invoice itself never changes. */
export interface FleetCreditNote {
  id: string;
  number: string;
  status: "issued" | "void";
  /** invoice: reduces what is owed on the (unpaid) invoice. refund: paid back (refundedAt once done). next_invoice: deducted from the account's next invoice (appliedInvoice once done). */
  settlement: "invoice" | "refund" | "next_invoice";
  reason: string;
  lines: FleetCreditLine[];
  dppIdr: number;
  ppnIdr: number;
  /** Total credited, PPN included. */
  totalIdr: number;
  issuedAt?: string;
  issuedDate?: string;
  issuedBy?: string | null;
  refundedAt?: string | null;
  refundReference?: string | null;
  /** The invoice it was deducted from. */
  appliedInvoice?: string | null;
  voidedAt?: string | null;
  voidReason?: string | null;
  sentAt?: string | null;
  sentTo?: string | null;
  invoice: {
    id?: string;
    number?: string;
    issuedDate?: string;
    periodLabel?: string;
    totalIdr?: number;
    efakturNumber?: string | null;
    status?: string;
  };
  accountId?: string;
  seller?: FleetSeller;
  buyer?: Record<string, unknown>;
}

export interface FleetCreditNoteRow {
  id: string;
  number: string;
  status: "issued" | "void";
  settlement: "invoice" | "refund" | "next_invoice";
  reason?: string;
  total_idr: number;
  ppn_idr?: number;
  issued_at?: string;
  refunded_at?: string | null;
  refund_reference?: string | null;
  voided_at?: string | null;
  sent_at?: string | null;
  invoice_id?: string;
  invoice_number: string;
  account_id?: string;
  account_name: string;
  applied_invoice?: string | null;
  /** Still to refund, or waiting for the next invoice. */
  pending: boolean;
}

export interface FleetInvoiceRow {
  id: string;
  number: string;
  period: string;
  status: "issued" | "paid" | "void";
  issued_at?: string;
  due_date?: string;
  sessions?: number;
  energy_wh?: number;
  ppn_idr?: number;
  roaming_total_idr?: number;
  total_idr: number;
  paid_at?: string | null;
  paid_reference?: string | null;
  voided_at?: string | null;
  efaktur_exported_at?: string | null;
  efaktur_number?: string | null;
  sent_at?: string | null;
  account_id: string;
  account_name: string;
  /** Issued, something still owed, and past its due date. */
  overdue: boolean;
  /** Credit notes settled against this invoice. */
  credited_idr?: number;
  /** Earlier credit notes deducted from this invoice. */
  prior_credit_idr?: number;
  /** Still owed: total less both kinds of credit (0 once paid). */
  balance_idr?: number;
}

export interface FleetSeller {
  name: string;
  npwp?: string | null;
  nitku?: string | null;
  address?: string | null;
  pkp: boolean;
}

export interface FleetSiteLine {
  siteId: string;
  siteName: string;
  sessions: number;
  energyWh: number;
  /** Energy, service and admin fees. */
  subtotalIdr: number;
  pbjtIdr: number;
  /** Price subject to PPN (e-Faktur TaxBase). */
  taxBaseIdr: number;
  /** DPP nilai lain, 11/12 of the price. */
  dppIdr: number;
  ppnIdr: number;
  totalIdr: number;
  untaxedSessions?: number;
}

/** A fleet account's month: a live draft of what is not yet invoiced, or the frozen invoice. */
export interface FleetStatement {
  status: "draft" | "issued" | "paid" | "void";
  /** Invoice id (null for a draft). */
  id?: string | null;
  number?: string | null;
  period: string;
  periodLabel?: string;
  ended?: boolean;
  issuedDate?: string;
  issuedAt?: string;
  dueDate?: string;
  paidAt?: string | null;
  paidReference?: string | null;
  voidedAt?: string | null;
  voidReason?: string | null;
  efakturExportedAt?: string | null;
  efakturNumber?: string | null;
  sentAt?: string | null;
  sentTo?: string | null;
  account?: {
    id?: string;
    name?: string;
  };
  buyer: {
    name: string;
    fleetName: string;
    taxId?: string | null;
    taxIdKind?: string;
    nitku?: string | null;
    address?: string | null;
    email?: string | null;
    contact?: string | null;
    termsDays?: number;
  };
  seller: FleetSeller;
  paymentInstructions?: string;
  sites: FleetSiteLine[];
  cards: {
    uid?: string;
    holder?: string | null;
    sessions?: number;
    energyWh?: number;
    totalIdr?: number;
    roamingIdr?: number;
  }[];
  sessions: {
    id: string;
    startedAt: string;
    endedAt?: string | null;
    siteId?: string;
    siteName: string;
    ocppIdentity?: string;
    cardUid: string;
    holder?: string | null;
    energyWh: number;
    subtotalIdr?: number;
    pbjtIdr?: number;
    ppnDppIdr?: number;
    ppnRateBps?: number;
    ppnIdr?: number;
    /** The session receipt total. */
    totalIdr: number;
    taxBaseIdr?: number;
  }[];
  roaming: {
    id: string;
    operator: string;
    location?: string | null;
    cardUid: string;
    startedAt?: string;
    endedAt?: string;
    energyKwh?: number;
    exclVat?: number;
    inclVat?: number | null;
    currency?: string;
    /** Re-billed amount. */
    amountIdr: number;
  }[];
  fees?: {
    subscriptionId?: string;
    planName?: string;
    subscriber?: string;
    feeIdr?: number;
    taxBaseIdr?: number;
    dppIdr?: number;
    ppnIdr?: number;
    totalIdr?: number;
    periodStart?: string;
    periodEnd?: string;
  }[];
  totals: {
    sessions: number;
    energyWh: number;
    subtotalIdr: number;
    pbjtIdr: number;
    taxBaseIdr: number;
    dppIdr: number;
    ppnIdr: number;
    ownTotalIdr: number;
    roamingSessions?: number;
    roamingIdr: number;
    /** Membership fees incl. PPN. */
    feesIdr?: number;
    /** Total due. */
    totalIdr: number;
    /** Sum of the per-session receipts. */
    receiptsTotalIdr?: number;
    /** Invoice minus receipts (PPN computed per invoice line). */
    roundingIdr?: number;
  };
  warnings: string[];
  /** Credit notes settled against this invoice. */
  creditedIdr?: number;
  /** Earlier credit notes deducted from this invoice. */
  priorCreditIdr?: number;
  /** Still owed on an issued invoice (0 once paid or for a draft). */
  balanceIdr?: number;
  priorCredits?: {
    id?: string;
    number?: string;
    invoiceNumber?: string;
    totalIdr?: number;
  }[];
  creditNotes?: {
    id?: string;
    number?: string;
    status?: "issued" | "void";
    settlement?: "invoice" | "refund" | "next_invoice";
    reason?: string;
    totalIdr?: number;
    ppnIdr?: number;
    issuedAt?: string;
    refundedAt?: string | null;
    applied?: boolean;
  }[];
}

export interface Frame {
  ts: string;
  direction: "in" | "out";
  /** 2 CALL, 3 CALLRESULT, 4 CALLERROR. */
  message_type: 2 | 3 | 4;
  action?: string | null;
  unique_id?: string | null;
  /** The OCPP message payload as received or sent. */
  payload: unknown;
}

export interface IntegrationField {
  key: string;
  label: string;
  /** multiselect: an array of option values (payments: methods, the payment methods offered to drivers). */
  type: "text" | "secret" | "select" | "multiselect" | "textarea" | "url" | "number" | "boolean";
  required?: boolean;
  options?: {
    value?: string;
    label?: string;
  }[];
  default?: unknown;
  help?: string;
  placeholder?: string;
  advanced?: boolean;
}

export interface IntegrationInput {
  provider: string;
  /** For payments: platform = the default account for operators without their own (platform administrators). */
  scope?: "org" | "platform";
  settings?: Record<string, unknown>;
  /** Only the secrets to set or change; an empty or missing field keeps the stored one. */
  secrets?: Record<string, unknown>;
  enabled?: boolean;
}

export interface IntegrationKind {
  kind: "payments" | "otp" | "otp_fallback" | "pnc_pki" | "map_tiles";
  label: string;
  description?: string;
  /** org: each operator may connect its own account (falls back to the platform's); platform: one for the deployment. */
  scope: "org" | "platform";
  providers: {
    id: string;
    label: string;
    description?: string;
    fields: IntegrationField[];
    devOnly?: boolean;
    webhook?: boolean;
    docs?: string;
  }[];
  own?: {
    id?: string;
    scope?: "org" | "platform";
    provider?: string;
    /** Non-secret settings. */
    settings?: Record<string, unknown>;
    /** Secret fields that are set, as a hint (last characters). Secret values are never returned. */
    secretHints?: Record<string, unknown>;
    enabled?: boolean;
    webhookPath?: string | null;
    webhookUrl?: string | null;
    lastTest?: {
      at?: string;
      ok?: boolean | null;
      message?: string | null;
    } | null;
    updatedAt?: string;
  } | null;
  /** The platform's account; its settings only for platform administrators. */
  platform?: Record<string, unknown> | null;
  /** What is in force: provider and source (console, environment or default). Null = not configured. */
  effective?: {
    provider?: string;
    source?: string;
    scope?: string;
  } | null;
  editable: boolean;
}

export interface LocalListSiteSyncResult {
  results: LocalListSyncResult[];
}

export interface LocalListSyncResult {
  ok: boolean;
  identity: string;
  /** SendLocalList answer from the charger. */
  status?: string;
  /** List version sent (charger version + 1). */
  version?: number;
  /** Cards sent. */
  count?: number;
  /** Present when ok is false because the charger could not be reached or does not support a local list. */
  error?: string;
}

export interface LoyaltyProgram {
  enabled: boolean;
  /** Points earned per Rp 1,000 of a session's receipt total (rounded down). */
  earnPer1000Idr: number;
  /** What one point takes off a session, in rupiah. */
  pointValueIdr: number;
  /** The most of a session's energy and fees points may pay, in basis points (5000 = half). */
  maxRedeemBps: number;
  /** Each earning expires this many months after it was earned; points are spent oldest first. */
  expiryMonths: number;
}

export interface LoyaltyStats {
  program: LoyaltyProgram;
  outstandingPoints: number;
  /** What the outstanding points are worth. */
  liabilityIdr: number;
  /** Drivers holding points. */
  members: number;
  thisMonth: {
    earned?: number;
    redeemed?: number;
    discountIdr?: number;
    expired?: number;
  };
}

export interface Meta {
  plnTariffGroups: MetaCodeLabel[];
  spkluSchemes: string[];
  connectorTypes: {
    code: string;
    label: string;
    current: "AC" | "DC";
  }[];
  vendors: string[];
  accountTypes: MetaCodeLabel[];
  configCategories: string[];
  firmwareStages: string[];
  consoleRoles: MetaConsoleRole[];
  paymentStatuses: string[];
  trTmCliffKva: number;
  regulatory: {
    /** Per-session service-fee ceiling by charger class; null = unregulated. */
    serviceFeeCeilingIdr: {
      slow?: number | null;
      medium?: number | null;
      fast?: number | null;
      ultrafast?: number | null;
    };
    energyCeilingIdrPerKwh: number;
    layananKhususBase: number;
    layananKhususNMax: number;
    idleFeeCapIdr: number;
    pbjtMaxBps: number;
  };
}

export interface MetaCodeLabel {
  code: string;
  label: string;
}

export interface MetaConsoleRole {
  name: string;
  label: string;
  siteScoped: boolean;
  ownerScoped?: boolean;
  description: string;
}

export interface OcpiMessage {
  id: number;
  direction: "in" | "out";
  method: string;
  url: string;
  http_status?: number | null;
  ocpi_status?: number | null;
  duration_ms?: number | null;
  error?: string | null;
  created_at: string;
}

export interface OcpiPush {
  id: number;
  /** OCPI module: locations, tariffs, sessions, cdrs, tokens, commands, chargingprofiles. */
  module: string;
  action: string;
  object_key: string;
  state: "pending" | "delivered" | "failed";
  attempts: number;
  next_attempt_at: string;
  last_status?: number | null;
  last_error?: string | null;
  created_at: string;
  delivered_at?: string | null;
}

export interface OcpiToken {
  id: string;
  country_code: string;
  party_id: string;
  uid: string;
  type: "AD_HOC_USER" | "APP_USER" | "OTHER" | "RFID";
  contract_id: string;
  visual_number?: string | null;
  issuer: string;
  valid: boolean;
  whitelist: "ALWAYS" | "ALLOWED" | "ALLOWED_OFFLINE" | "NEVER";
  last_updated: string;
  received_at: string;
}

export interface OnboardingCharger {
  ocpp_identity: string;
  display_name?: string | null;
  vendor?: string | null;
  model?: string | null;
  serial?: string | null;
  ocpp_version?: string | null;
  status: string;
  security_profile?: number;
  boot_count?: number;
  last_seen_at?: string | null;
  created_at?: string;
  site_name?: string;
  /** Zero-touch certificate pending: the charger will be asked for its CSR and moved to Profile 3. */
  cert_auto_upgrade?: boolean;
  has_certificate?: boolean;
  has_key?: boolean;
  client_cert_not_after?: string | null;
  client_cert_source?: string | null;
  /** The last connection attempt: ts, outcome, detail. */
  last_attempt?: Record<string, unknown> | null;
  online: boolean;
  /** Where the charger is: waiting for its first connection, refused at the handshake, connected but not activated, getting its certificate, or connected. */
  stage: "waiting" | "registered" | "refused" | "awaiting_activation" | "certificate_in_progress" | "needs_certificate" | "connected";
}

export interface OwnerInput {
  /** Required when creating. */
  name?: string;
  legalName?: string | null;
  /** 15 or 16 digits; dots, dashes and spaces are allowed. */
  npwp?: string | null;
  pkp?: boolean;
  address?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  /** Whose name is on the driver's tax receipt. */
  sellerOfRecord?: "operator" | "owner";
}

export interface OwnerRow {
  id: string;
  name: string;
  legal_name?: string | null;
  npwp?: string | null;
  pkp: boolean;
  address?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  seller_of_record: "operator" | "owner";
  archived_at: string | null;
  created_at: string;
  sites: {
    id: string;
    name: string;
  }[];
  chargers: number;
  users: number;
}

export interface PendingCharger {
  ocpp_identity: string;
  attempts: number;
  first_seen_at: string;
  last_seen_at: string;
  last_remote_ip?: string | null;
  last_subprotocols?: string | null;
  last_tls?: boolean;
  ever_sent_credentials?: boolean;
  last_outcome: string;
}

export interface PendingChargerSuggestion {
  ocpp_identity: string;
  site_name: string;
}

export interface PlatformOrgBilling {
  statement: Statement;
  plan: BillingPlanInForce;
  planHistory: BillingPlanVersion[];
  sites: {
    id: string;
    name: string;
    billing_model: "public" | "private";
  }[];
}

export interface PlatformOrgRow {
  orgId: string;
  name: string;
  slug: string;
  status: "draft" | "final";
  number: string | null;
  customPlan: boolean;
  sites: number;
  chargers: number;
  warnings: number;
  totals: StatementTotals;
}

export interface PncCharger {
  id: string;
  ocpp_identity: string;
  display_name?: string | null;
  ocpp_version?: string | null;
  site_name?: string;
  pnc_enabled: boolean;
  /** Last GetInstalledCertificateIds answer. */
  pnc_installed?: unknown[] | null;
  pnc_installed_at?: string | null;
  cert_state?: "requested" | "signed" | "delivered" | "rejected" | "failed" | null;
  cert_subject?: string | null;
  cert_serial?: string | null;
  cert_not_after?: string | null;
  cert_requested_at?: string | null;
  cert_delivered_at?: string | null;
  cert_error?: string | null;
}

export interface PncCommandResult {
  /** The charger's answer (Accepted, Rejected, Failed…); null when it gave none. */
  status?: string | null;
}

export interface PncContract {
  /** The contract's token id (RFID centre, fleet accounts and memberships use it as for a card). */
  id: string;
  /** eMAID without separators. */
  emaid: string;
  /** eMAID as CC-PPP-IIIIIIIII[-C]. */
  emaid_display: string;
  /** Accepted, or Blocked when cancelled. */
  status: string;
  holder_name?: string | null;
  account_type: "retail" | "fleet" | "vip" | "technician";
  fleet_name?: string | null;
  valid_to?: string | null;
  notes?: string | null;
  created_at?: string;
  sessions?: number;
  last_used?: string | null;
}

export interface PncEvent {
  id: number;
  /** The OCPP message or operator action. */
  action: string;
  outcome: string;
  emaid?: string | null;
  detail?: Record<string, unknown>;
  created_at: string;
  ocpp_identity?: string | null;
}

export interface PncOverview {
  settings: PncSettings;
  pki: {
    mode: "none" | "mock" | "http";
    description: string;
    problem: string | null;
  };
  counts: {
    contracts?: number;
    active_contracts?: number;
    chargers?: number;
    trust_anchors?: number;
    authorizations_30d?: number;
    accepted_30d?: number;
  };
}

export interface PncSettings {
  /** Plug & Charge is on for the organisation. Off: contracts are refused and certificate requests answered Failed. */
  enabled: boolean;
  /** Accept a contract when its OCSP responder cannot be reached (the charger validated the chain). */
  acceptWhenOcspUnavailable: boolean;
}

export interface PncTrustAnchor {
  id: string;
  kind: "V2GRootCertificate" | "MORootCertificate";
  subject: string;
  /** SHA-256, hex. */
  fingerprint: string;
  not_after: string;
  source: "pki" | "upload";
  created_at?: string;
  pem?: string;
}

export interface PowerAllocation {
  ocppIdentity: string;
  chargePointId: string;
  connectorNo: number;
  maxPowerW: number;
  minPowerW?: number;
  currentType: "AC" | "DC";
  phases?: number;
  priority?: number;
  /** Present while a session is active: integer on OCPP 1.6, string on 2.0.1. */
  transactionId?: number | string;
  active: boolean;
  connectorUuid?: string;
  connectorType?: string | null;
  allocatedW: number;
  unit: "A" | "W";
  /** The allocation in `unit` (amps for AC, watts for DC). */
  limit: number;
}

export interface PowerHeadroom {
  subscribedKva: number;
  activeKva: number;
  installedKva: number;
  headroomKva: number;
  unmanagedOversubscriptionKva?: number;
  rekeningMinimumKwhEquivalent?: number;
  crossesTrTmCliff?: boolean;
  trTmThresholdKva?: number;
  powerFactor: number;
  ceilingW: number;
  curtailed: boolean;
}

export interface PowerSiteBudget {
  siteId: string;
  /** Effective ceiling, clamped to the subscription (connected kVA × PF). */
  ceilingW: number;
  reserveW: number;
  strategy: "fair_share" | "priority" | "fifo";
  curtailed: boolean;
  connectedKva: number | null;
  powerFactor: number;
  phases?: number;
  nominalVoltageV?: number;
  reserveBreakdown?: Record<string, number>;
  curtailedReason?: string | null;
  curtailedAt?: string | null;
  /** The stored ceiling before the subscription clamp. */
  configuredCeilingW?: number;
}

export interface Promotion {
  id: string;
  name: string;
  description?: string | null;
  kind: "energy_percent" | "energy_rate" | "amount_off" | "free_kwh" | "waive_fees";
  /** % / Rp per kWh / Rp / kWh, by kind. */
  value: number;
  audience: "everyone" | "new_drivers" | "fleet_accounts" | "plan_members" | "code";
  code?: string | null;
  /** For audience fleet_accounts. */
  fleet_account_ids?: string[] | null;
  /** For audience plan_members. */
  plan_ids?: string[] | null;
  /** null = every site. */
  site_ids?: string[] | null;
  current_type?: "AC" | "DC" | null;
  starts_at?: string;
  ends_at?: string | null;
  /** Bit 0 = Monday … bit 6 = Sunday. */
  days_mask: number;
  /** HH:MM local time at the site. */
  time_from?: string | null;
  time_to?: string | null;
  min_kwh?: number;
  max_redemptions?: number | null;
  max_per_customer?: number | null;
  budget_idr?: number | null;
  stacks_with_membership: boolean;
  active: boolean;
  created_at?: string;
  updated_at?: string;
  redemptions?: number;
  /** Discount given so far. */
  discount_idr?: number;
  customers?: number;
}

export interface PromotionInput {
  name?: string;
  description?: string;
  kind?: "energy_percent" | "energy_rate" | "amount_off" | "free_kwh" | "waive_fees";
  value?: number;
  audience?: "everyone" | "new_drivers" | "fleet_accounts" | "plan_members" | "code";
  code?: string | null;
  fleetAccountIds?: string[];
  planIds?: string[];
  siteIds?: string[];
  currentType?: "AC" | "DC" | null;
  startsAt?: string;
  endsAt?: string | null;
  daysMask?: number;
  timeFrom?: string | null;
  timeTo?: string | null;
  minKwh?: number;
  maxRedemptions?: number | null;
  maxPerCustomer?: number | null;
  budgetIdr?: number | null;
  stacksWithMembership?: boolean;
  active?: boolean;
}

export interface QuirkProfile {
  id: string;
  vendor: string;
  model: string;
  /** Regular expression the firmware version is matched against. */
  firmware_pattern: string;
  /** Behaviour learned from this hardware (e.g. chargingRateUnit, compositeScheduleTrustworthy). */
  findings: Record<string, unknown>;
  updated_at: string;
  /** Charge points currently resolved to this profile. */
  charge_points: number;
}

export interface RefundOutcome {
  ok: true;
  state: "processing" | "refunded";
  refundRef?: string;
}

export interface RefundRow {
  id: string;
  refund_state: "due" | "processing" | "refunded" | "failed";
  refund_due_idr?: number | null;
  refunded_idr?: number | null;
  refund_reason?: string | null;
  refund_method?: "provider" | "manual" | null;
  refund_ref?: string | null;
  refund_error?: string | null;
  refund_requested_at?: string | null;
  refunded_at?: string | null;
  provider: string;
  provider_ref?: string | null;
  method: string;
  amount_captured_idr?: number | null;
  paid_at: string;
  session_id?: string | null;
  site_name?: string | null;
  ocpp_identity?: string | null;
  connector_no?: number | null;
  driver_phone?: string | null;
  refunded_by_name?: string | null;
}

export interface RefundSummary {
  due_count: number;
  due_idr: number;
  failed_count: number;
  refunded_30d_idr: number;
}

export interface RoamingAbroadCdr {
  id: string;
  cdr_id: string;
  session_id?: string | null;
  start_date_time: string;
  end_date_time: string;
  /** kWh, as a decimal string. */
  total_energy: string;
  currency: string;
  /** Decimal number as a string (Postgres NUMERIC). */
  total_excl_vat: string;
  /** Decimal number as a string (Postgres NUMERIC), or null. */
  total_incl_vat?: string | null;
  received_at: string;
  country_code: string;
  party_id: string;
  partner_name: string;
  uid?: string | null;
  contract_id?: string | null;
  holder_name?: string | null;
  fleet_name?: string | null;
  location_name?: string | null;
  city?: string | null;
}

export interface RoamingAbroadSession {
  session_id: string;
  partner_id: string;
  /** ACTIVE | PENDING | RESERVATION. */
  status?: string | null;
  /** Decimal number as a string (Postgres NUMERIC), or null. */
  kwh?: string | null;
  last_updated: string;
  started_at?: string | null;
  location_id?: string | null;
  partner_name: string;
  uid?: string | null;
  holder_name?: string | null;
  fleet_name?: string | null;
  location_name?: string | null;
  city?: string | null;
}

export interface RoamingCard {
  id: string;
  uid: string;
  /** Accepted | Blocked | Expired | Invalid | ConcurrentTx. */
  status: string;
  valid_to?: string | null;
  holder_name?: string | null;
  fleet_name?: string | null;
  /** retail | fleet | vip | technician. */
  account_type: string;
  roaming_shared: boolean;
  /** eMAID-style contract id, given when the card is first shared. */
  contract_id?: string | null;
  energy_limit_wh?: number | null;
  spend_limit_idr?: number | null;
  /** Charge records received for this card from other networks. */
  roaming_cdrs: number;
  /** Total IDR charged to this card on other networks. */
  roaming_idr: number;
}

export interface RoamingChargingLimit {
  session_id: string;
  partner_name: string;
  site_name: string;
  ocpp_identity: string;
  started_at: string;
  contract_id?: string | null;
  received_at: string;
  /** ACCEPTED (the charger took it) | REJECTED (offline or refused; applied on a later pass) | null (being applied). */
  last_result?: string | null;
  applied_at?: string | null;
  unit: "W" | "A";
  /** Steps in the partner’s schedule. */
  periods: number;
  /** The partner’s limit right now, in its unit; null when none is in force. */
  limitNow: number | null;
  /** The same in watts. */
  limitNowW: number | null;
}

export interface RoamingCommand {
  id: string;
  /** RESERVE_NOW and CANCEL_RESERVATION are sent by the driver app (a fleet driver reserving a partner charger). */
  command: "START_SESSION" | "STOP_SESSION" | "UNLOCK_CONNECTOR" | "RESERVE_NOW" | "CANCEL_RESERVATION";
  /** The CPO’s synchronous answer (ACCEPTED, REJECTED, … or FAILED when unreachable). */
  response?: string | null;
  /** The charger’s outcome, posted back later by the CPO. */
  result?: string | null;
  message?: string | null;
  created_at: string;
  responded_at?: string | null;
  result_at?: string | null;
  location_id?: string | null;
  session_id?: string | null;
  partner_name: string;
  uid?: string | null;
  holder_name?: string | null;
}

export interface RoamingCommandSent {
  id: string;
  /** The CPO’s answer, or FAILED when it could not be reached. */
  response: string;
  message: string | null;
}

export interface RoamingHubClient {
  country_code: string;
  party_id: string;
  role: "CPO" | "EMSP" | "HUB" | "NAP" | "NSP" | "OTHER" | "SCSP";
  status: "CONNECTED" | "OFFLINE" | "PLANNED" | "SUSPENDED";
  last_updated: string;
  received_at: string;
}

export interface RoamingNetworkLocation {
  partnerId: string;
  partnerName: string;
  /** `country_code*party_id` of the operator. */
  party: string;
  countryCode: string;
  partyId: string;
  /** The CPO’s location id. */
  id: string;
  name?: string;
  address?: string;
  city?: string;
  operator: string | null;
  lastUpdated: string;
  /** EVSEs currently AVAILABLE. */
  available: number;
  evses: {
    uid?: string;
    evseId?: string;
    status?: string;
    connectors: {
      id?: string;
      standard?: string;
      powerType?: string;
      maxPowerW?: number | null;
    }[];
  }[];
}

export interface RoamingOverview {
  /** This operator’s roaming identity, or null until set. */
  party: RoamingParty | null;
  /** Our OCPI versions URL, to give to partners. */
  versionsUrl: string;
  partners: RoamingPartnerSummary[];
  /** Empty until the roaming identity is set. */
  sites: RoamingSite[];
}

export interface RoamingPartner {
  id: string;
  name: string;
  kind: "emsp" | "cpo" | "hub";
  state: "pending" | "connected" | "suspended" | "closed";
  /** The partner’s OCPI versions URL, once connected. */
  versions_url?: string | null;
  /** Negotiated OCPI version (2.2.1). */
  version?: string | null;
  endpoints: {
    identifier?: string;
    role?: "SENDER" | "RECEIVER";
    url?: string;
  }[];
  roles: {
    role?: string;
    party_id?: string;
    country_code?: string;
    business_details?: Record<string, unknown>;
  }[];
  country_code?: string | null;
  party_id?: string | null;
  last_error?: string | null;
  last_success_at?: string | null;
  registered_at?: string | null;
  created_at: string;
}

export interface RoamingPartnerSummary {
  id: string;
  name: string;
  kind: "emsp" | "cpo" | "hub";
  state: "pending" | "connected" | "suspended" | "closed";
  /** The partner’s OCPI versions URL, once connected. */
  versions_url?: string | null;
  /** Negotiated OCPI version (2.2.1). */
  version?: string | null;
  endpoints: {
    identifier?: string;
    role?: "SENDER" | "RECEIVER";
    url?: string;
  }[];
  roles: {
    role?: string;
    party_id?: string;
    country_code?: string;
    business_details?: Record<string, unknown>;
  }[];
  country_code?: string | null;
  party_id?: string | null;
  last_error?: string | null;
  last_success_at?: string | null;
  registered_at?: string | null;
  created_at: string;
  /** Calls waiting to be delivered to the partner. */
  queued: number;
  /** Calls that gave up; replay them with POST …/replay. */
  failed: number;
  /** Driver tokens the partner has pushed to us. */
  tokens: number;
  /** Sessions on our chargers by the partner’s drivers. */
  sessions: number;
  /** Locations imported from the partner (CPO role). */
  network_locations: number;
  /** Charge records the partner sent us for our cards. */
  cdrs_received: number;
  /** Parties behind the partner, when it is a hub (HubClientInfo). */
  hub_clients: number;
}

export interface RoamingParty {
  country_code: string;
  party_id: string;
  business_name: string;
  website?: string | null;
}

export interface RoamingSession {
  id: string;
  started_at: string;
  ended_at?: string | null;
  state: string;
  energy_wh: number;
  ocpi_auth_method?: string | null;
  partner_name: string;
  contract_id: string;
  country_code: string;
  party_id: string;
  visual_number?: string | null;
  site_name: string;
  ocpp_identity: string;
  total_idr?: number | null;
  /** State of the CDR delivery to the partner: pending | delivered | failed, or null before one is queued. */
  cdr_push_state?: string | null;
}

export interface RoamingSite {
  id: string;
  name: string;
  city: string;
  /** Actually shared: opted in and nothing missing. */
  publish: boolean;
  /** Why the site cannot be shared yet, if anything. */
  problem: string | null;
  /** EVSEs the location would carry. */
  evses: number;
  /** Tariffs in use on its connectors. */
  tariffs: number;
  /** The operator has opted the site in. */
  optedIn: boolean;
}

export interface RoleDefinition {
  name: "super_admin" | "cpo_operations_manager" | "site_host_landlord" | "field_technician" | "financial_auditor" | "site_owner" | "fleet_customer";
  label: string;
  siteScoped: boolean;
  ownerScoped?: boolean;
  description: string;
}

/** What the virtual charger itself reports. */
export interface SandboxCharger {
  online: boolean;
  /** Connection state: connecting, booted, disconnected… */
  state?: string;
  charging: boolean;
  connectorId?: number | null;
  transactionId?: number | null;
  /** Lifetime energy register. */
  meterWh: number;
  powerW?: number;
  /** Current power limit (smart charging). */
  limitW?: number;
  firmware?: string;
  /** Transaction messages stored while offline, sent on reconnect. */
  queuedOffline?: number;
  faults: {
    connectorId?: number;
    errorCode?: string;
    vendorErrorCode?: string;
    info?: string;
  }[];
  reservations: {
    connectorId?: number;
    reservationId?: number;
    idTag?: string;
  }[];
  /** ISO 15118 Plug & Charge at this charger (OCPP 1.6 with the OCA DataTransfer wrapping). */
  pnc?: {
    /** ISO15118PnCEnabled. */
    enabled?: boolean;
    /** Its V2G certificate. */
    certificate?: {
      subject?: string;
      serial?: string;
      notAfter?: string;
    } | null;
    roots?: {
      type?: string;
      subject?: string;
    }[];
  };
}

export interface SandboxCreated {
  id: string;
  name: string;
  slug: string;
  /** The sandbox API key (`psk_…`). Shown once. */
  apiKey: string;
  siteId: string;
  chargePoints: {
    identity: string;
    connectors: number;
    current: "AC" | "DC";
    maxPowerKw: number;
  }[];
  tokens: {
    uid: string;
    status: string;
    holder: string;
  }[];
}

export interface SandboxSummary {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  createdBy?: string | null;
  /** Virtual chargers in the sandbox. */
  chargePoints: number;
  keys: {
    id: string;
    prefix: string;
    name: string;
    createdAt: string;
    lastUsedAt?: string | null;
  }[];
}

export interface SessionBreakdown {
  energySubtotalIdr?: number | null;
  serviceFeeIdr?: number | null;
  idleFeeIdr?: number | null;
  pbjtIdr?: number | null;
  dppIdr?: number | null;
  ppnIdr?: number | null;
  /** Estimated QRIS MDR (the operator’s cost, not charged to the driver). */
  mdrIdr: number;
  grossTotalIdr?: number | null;
}

export interface SessionDetail {
  id: string;
  org_id: string;
  site_id: string;
  connector_uuid: string;
  charge_point_id: string;
  idem_key?: string;
  ocpp_transaction_id?: string | null;
  token_id?: string | null;
  driver_id?: string | null;
  state: string;
  started_at: string;
  ended_at?: string | null;
  stop_reason?: string | null;
  meter_start_wh?: number;
  meter_stop_wh?: number | null;
  energy_wh: number;
  duration_s?: number | null;
  prepaid_amount_idr?: number | null;
  prepaid_energy_wh?: number | null;
  payment_mode?: string | null;
  created_at?: string;
  charger_tx_ref?: string | null;
  rated_at?: string | null;
  needs_review: boolean;
  review_reason?: string | null;
  flags?: unknown[];
  idle_minutes?: number;
  last_meter_at?: string | null;
  payment_intent_id?: string | null;
  operator_limit_wh?: number | null;
  operator_limit_until?: string | null;
  operator_stop_sent_at?: string | null;
  ocpi_partner_id?: string | null;
  ocpi_token_id?: string | null;
  ocpi_auth_method?: string | null;
  ocpi_authorization_reference?: string | null;
  /** Frozen CDR lines; null until the session is rated. */
  lines?: unknown[] | null;
  subtotal_idr?: number | null;
  pbjt_idr?: number | null;
  pbjt_rate_bps?: number | null;
  ppn_dpp_idr?: number | null;
  ppn_idr?: number | null;
  total_idr?: number | null;
  tariff_snapshot?: Record<string, unknown> | null;
  regulatory_flags?: unknown[] | null;
  /** Energy the car gave back (bidirectional charging), from the export register. */
  energy_export_wh?: number;
  /** The car’s last reported state of charge. */
  soc_percent?: number | null;
  /** The driver or the fleet agreed to give energy back during this session. */
  v2x_consent?: boolean;
  /** The car is being asked to give energy back now. */
  v2x_discharging?: boolean;
  /** OCPP 2.1 operation mode last reported by the charger (e.g. ChargingOnly, CentralSetpoint). */
  operation_mode?: string | null;
  /** Signed meter data (OCMF) against the bill; details under /signed-data. */
  signed_status?: "verified" | "unverified_key" | "mismatch" | "invalid" | "incomplete" | "missing" | null;
  /** Energy between the signed start and end readings. */
  signed_energy_wh?: number | null;
  signed_detail?: string | null;
  meterValues: SessionMeterValue[];
  /** ISO 15118 charging needs and bidirectional charging for this session: what the car asked for and can do (needs), its battery level, energy given back and the credit, consent and its source, and whether it is discharging now (or why not). */
  v2x?: {
    /** The latest NotifyEVChargingNeeds: requestedTransfer, availableTransfer, bidirectional, controlMode, departureTime, energyRequestWh, maxDischargePowerW… */
    needs?: Record<string, unknown> | null;
    socPercent?: number | null;
    exportWh?: number;
    consent?: boolean;
    consentSource?: "driver" | "fleet" | null;
    minSocPercent?: number | null;
    creditIdrPerKwh?: number | null;
    creditIdr?: number;
    discharging?: boolean;
    dischargeW?: number | null;
    notDischargingBecause?: string | null;
    canOffer?: boolean;
  } | null;
}

export interface SessionListItem {
  id: string;
  started_at: string;
  ended_at?: string | null;
  /** active | ended | rated | settled | disputed. */
  state: string;
  energy_wh: number;
  duration_s?: number | null;
  stop_reason?: string | null;
  needs_review: boolean;
  review_reason?: string | null;
  /** Regulatory and integrity flags recorded on the session (unfiltered listing only). */
  flags?: unknown[];
  idle_minutes: number;
  payment_mode?: string | null;
  prepaid_amount_idr?: number | null;
  /** Unfiltered listing only. */
  prepaid_energy_wh?: number | null;
  ocpp_identity: string;
  evse_no: number;
  site_name: string;
  total_idr?: number | null;
  subtotal_idr?: number | null;
  pbjt_idr?: number | null;
  ppn_idr?: number | null;
  ppn_dpp_idr?: number | null;
  /** Frozen CDR lines (unfiltered listing only; filtered results carry `breakdown` instead). */
  lines?: unknown[] | null;
  regulatory_flags?: unknown[] | null;
  meter_start_wh?: number;
  meter_stop_wh?: number | null;
  ocpp_transaction_id?: string | null;
  display_name?: string | null;
  connector_type?: string | null;
  current_type?: string;
  site_id?: string;
  /** RFID idTag; masked to the last 4 characters for site-scoped callers. */
  id_tag?: string | null;
  /** Always null for site-scoped callers. */
  holder_name?: string | null;
  cdr_id?: string | null;
  pbjt_rate_bps?: number | null;
  ppn_rate_bps?: number | null;
  issued_at?: string | null;
  payment_method?: string | null;
  payment_state?: string | null;
  /** paid | invoiced | pending | unbilled | review | in_progress | failed | refunded | free. */
  payment_status?: string;
  breakdown?: SessionBreakdown;
}

export interface SessionMeterValue {
  ts: string;
  measurand: string;
  value: number;
  unit?: string | null;
  phase?: string | null;
}

export interface SessionRerateResult {
  /** true when a CDR exists for the session after the call. */
  ok: boolean;
  cdr: {
    id?: string;
  } | null;
  /** Present when ok is true. */
  forced?: boolean;
  /** Present when ok is false: why the engine declined to price the session. */
  reason?: string;
  /** Present when ok is false. */
  hint?: string;
}

export interface SessionSearchBreakdown {
  energySubtotalIdr: number | null;
  serviceFeeIdr: number | null;
  idleFeeIdr: number | null;
  pbjtIdr: number | null;
  dppIdr: number | null;
  ppnIdr: number | null;
  /** Estimated QRIS MDR (operator cost, not charged to the driver); 0 for other methods. */
  mdrIdr: number;
  grossTotalIdr: number | null;
}

export interface SessionSearchResult {
  rows: SessionSearchRow[];
  /** Totals over every session matching the filter, not just this page. */
  totals: {
    sessions: number;
    energy_wh: number;
    revenue_idr: number;
    pbjt_idr: number;
    ppn_idr: number;
  };
  limit: number;
  offset: number;
}

export interface SessionSearchRow {
  id: string;
  started_at: string;
  ended_at?: string | null;
  state: string;
  energy_wh: number;
  duration_s?: number | null;
  stop_reason?: string | null;
  meter_start_wh?: number;
  meter_stop_wh?: number | null;
  ocpp_transaction_id?: string | null;
  needs_review?: boolean;
  review_reason?: string | null;
  idle_minutes?: number;
  payment_mode?: string | null;
  prepaid_amount_idr?: number | null;
  ocpp_identity: string;
  display_name?: string | null;
  evse_no?: number;
  connector_type?: string | null;
  current_type?: string;
  site_id: string;
  site_name?: string;
  /** Masked to the last 4 characters for site-scoped users. */
  id_tag?: string | null;
  /** Always null for site-scoped users. */
  holder_name?: string | null;
  cdr_id?: string | null;
  subtotal_idr?: number | null;
  pbjt_idr?: number | null;
  pbjt_rate_bps?: number | null;
  ppn_dpp_idr?: number | null;
  ppn_rate_bps?: number | null;
  ppn_idr?: number | null;
  total_idr?: number | null;
  regulatory_flags?: unknown[] | null;
  issued_at?: string | null;
  payment_method?: string | null;
  payment_state?: string | null;
  payment_status: string;
  breakdown: SessionSearchBreakdown;
}

export interface SignedMeterData {
  /** The site’s policy. */
  policy: "off" | "record" | "require";
  status: "verified" | "unverified_key" | "mismatch" | "invalid" | "incomplete" | "missing" | null;
  detail?: string | null;
  signedEnergyWh?: number | null;
  billedEnergyWh: number;
  meterSerial?: string | null;
  /** The registered key (hex DER) the signatures are checked against. */
  meterPublicKey?: string | null;
  transactionId?: string | null;
  values: {
    id: number;
    sampledAt?: string | null;
    /** Transaction.Begin, Transaction.End, Sample.Periodic… */
    context?: string | null;
    encoding: string;
    /** The signed data as received (OCMF|payload|signature). */
    ocmf: string;
    meterSerial?: string | null;
    readings: {
      tm?: string;
      tx?: string | null;
      wh?: number | null;
      register?: "import" | "export" | "other";
      ri?: string | null;
      ok?: boolean;
      st?: string;
      ef?: string;
    }[];
    verifyStatus: "valid" | "invalid" | "no_key" | "unreadable" | "unsupported";
    verifyDetail?: string | null;
    keySource?: "registered" | "charger" | null;
    /** A key the charger sent with the data (not a trust anchor). */
    chargerKey?: string | null;
  }[];
}

/** Engineering figures derived from the subscribed capacity and power factor. */
export interface SiteComputed {
  activePowerCeilingKw: number | null;
  crossesTrTmCliff: boolean;
  trTmThresholdKva: number;
  /** 40 hours x kVA per month. */
  rekeningMinimumKwhPerMonth: number;
}

/** The full site row plus its organisation name and power budget. connected_kva and power_factor are Postgres NUMERIC and come back as strings here. */
export interface SiteDetail {
  id?: string;
  org_id?: string;
  name?: string;
  address?: string | null;
  city?: string | null;
  postal_code?: string | null;
  kabupaten_kota_code?: string | null;
  lat?: number | null;
  lon?: number | null;
  timezone?: string;
  grid_tariff_group?: string | null;
  /** NUMERIC(10,2) as a string, e.g. "197.00". */
  connected_kva?: string | null;
  /** NUMERIC(4,3) as a string, e.g. "0.950". */
  power_factor?: string;
  phases?: number;
  nominal_voltage_v?: number;
  spklu_id?: string | null;
  spklu_scheme?: string | null;
  slo_number?: string | null;
  slo_issuer?: string | null;
  slo_issued_at?: string | null;
  slo_expires_at?: string | null;
  pbjt_rate_bps?: number;
  /** Minutes a charger here may be offline before the critical alert; null = the fleet default (OFFLINE_ALERT_MINUTES). */
  offline_alert_minutes?: number | null;
  /** The driver queue is on at this site. */
  queue_enabled?: boolean;
  /** Minutes the next driver has to start once a connector is held for them. */
  queue_offer_minutes?: number;
  /** Most drivers waiting at once. */
  queue_max_length?: number;
  /** Longest wait before a place in the queue ends. */
  queue_max_wait_minutes?: number;
  /** Fee for reserving a connector here in the driver app, before PPN; 0 = free. */
  reservation_fee_idr?: number;
  /** Bidirectional charging programme: cars whose drivers agree may give energy back (OCPP 2.1). */
  v2x_enabled?: boolean;
  /** Local hours when cars may give energy back (HH:MM; to < from wraps midnight). */
  v2x_windows?: {
    from?: string;
    to?: string;
  }[];
  /** Most the site takes back from cars at once, in W; null = no limit of its own. */
  v2x_max_discharge_w?: number | null;
  /** Energy may flow back to the grid. Off: discharge is capped at the site’s own auxiliary load. */
  v2x_allow_export?: boolean;
  /** Battery floor: no car is discharged below it (a driver may choose a higher one). */
  v2x_min_soc_percent?: number;
  /** Driver credit per kWh given back, taken off the session before tax. */
  v2x_credit_idr_per_kwh?: number;
  /** Signed meter data (OCMF): ignored, kept and checked (default), or required to bill a session. */
  signed_meter_policy?: "off" | "record" | "require";
  archived_at?: string | null;
  created_at?: string;
  billing_model?: "public" | "private";
  owner_id?: string | null;
  previous_owner_id?: string | null;
  roaming_publish?: boolean;
  org_name?: string;
  ceiling_w?: number | null;
  reserve_w?: number | null;
  strategy?: string | null;
  curtailed?: boolean | null;
  computed: SiteComputed;
}

/** Site fields. On update only the fields sent are changed; an empty string clears a text field. Validation runs at save time. */
export interface SiteInput {
  name?: string;
  address?: string | null;
  city?: string | null;
  /** 5-digit Indonesian postal code. */
  postalCode?: string | null;
  /** 4-digit BPS kabupaten/kota code, e.g. 3171. */
  kabupatenKotaCode?: string | null;
  /** Latitude within Indonesia (-11.5 to 6.5). */
  lat?: number | null;
  /** Longitude within Indonesia (94 to 141.5). */
  lon?: number | null;
  timezone?: "Asia/Jakarta" | "Asia/Makassar" | "Asia/Jayapura";
  /** PLN tariff group, e.g. L/TR, L/TM, B-2/TR, B-3/TM, I-3/TM. */
  gridTariffGroup?: string | null;
  /** Subscribed capacity in kVA (0 < kVA <= 100000). Above 200 kVA a TR/TM warning is returned. */
  connectedKva?: number | null;
  powerFactor?: number;
  phases?: 1 | 3;
  /** Defaults to 230 (1-phase) or 400 (3-phase) when phases is set. */
  nominalVoltageV?: number;
  /** XX.SCHEME.YY.ZZZZ.NNN, e.g. 01.POSO.20.3171.011 (upper-cased). */
  spkluId?: string | null;
  /** POSO, POPO, PLPO, PLSO, ROSO, ROPO, RLPO, RLSO or RPOO; must match the scheme in spkluId. */
  spkluScheme?: string | null;
  sloNumber?: string | null;
  sloIssuer?: string | null;
  /** YYYY-MM-DD. */
  sloIssuedAt?: string | null;
  /** YYYY-MM-DD, after sloIssuedAt. */
  sloExpiresAt?: string | null;
  /** PBJT-TL rate in basis points (1000 = 10%). */
  pbjtRateBps?: number;
  /** Minutes a charger here may be offline before the critical "charger offline" alert. Null or empty = the fleet default (OFFLINE_ALERT_MINUTES). */
  offlineAlertMinutes?: number | null;
  /** Driver queue on or off. Switching it off ends the places of drivers still waiting (they are told). */
  queueEnabled?: boolean;
  /** Minutes the next driver has to start once a connector is held for them; not taken in time, they miss their turn. */
  queueOfferMinutes?: number;
  /** Most drivers waiting (or holding an offer) at once. */
  queueMaxLength?: number;
  /** Longest wait; a place ends after it. */
  queueMaxWaitMinutes?: number;
  /** Fee for reserving a connector here in the driver app, before PPN (added when the operator is PKP). App drivers pay it before the connector is held; a fleet card’s goes on the fleet invoice. Kept once held; not charged when the charger refuses or the driver cancels within 2 minutes. 0 or empty = free. */
  reservationFeeIdr?: number;
  /** Bidirectional charging programme (V2G / V2B). Needs OCPP 2.1 chargers and ISO 15118-20 cars; nothing discharges without the driver’s or the fleet’s consent. */
  v2xEnabled?: boolean;
  /** When cars may give energy back, in local time: [{from, to}] or text such as "17:00-22:00, 05:00-07:00". 00:00-00:00 is all day. */
  v2xWindows?: {
    from: string;
    to: string;
  }[] | string;
  /** Most the site takes back at once, in W; null for no limit of its own. */
  v2xMaxDischargeW?: number | null;
  /** Let energy flow back to the PLN grid (needs a PLN export agreement). Off: discharge is capped at the auxiliary load set in load management, so it only covers the site’s own use. */
  v2xAllowExport?: boolean;
  /** Battery floor for every car here. */
  v2xMinSocPercent?: number;
  /** Signed meter data (OCMF, from calibration-law meters). record: kept, checked against the connector’s meter key and the bill, problems flagged. require: a session is billed only when its signed start and end readings verify against the registered key and match the bill; otherwise it is parked for review. off: ignored. */
  signedMeterPolicy?: "off" | "record" | "require";
  /** Driver credit per kWh given back, taken off the session before PBJT-TL and PPN (never below zero). Fixed for a session when the driver agrees. */
  v2xCreditIdrPerKwh?: number;
}

export interface SiteListItem {
  id: string;
  name: string;
  address?: string | null;
  city?: string | null;
  postal_code?: string | null;
  kabupaten_kota_code?: string | null;
  lat?: number | null;
  lon?: number | null;
  timezone?: string;
  grid_tariff_group?: string | null;
  /** Subscribed capacity in kVA (converted to a number). */
  connected_kva?: number | null;
  power_factor?: number;
  phases?: number;
  nominal_voltage_v?: number;
  spklu_id?: string | null;
  spklu_scheme?: string | null;
  slo_number?: string | null;
  slo_issuer?: string | null;
  slo_issued_at?: string | null;
  slo_expires_at?: string | null;
  pbjt_rate_bps?: number;
  /** Minutes a charger here may be offline before the critical alert; null = the fleet default (OFFLINE_ALERT_MINUTES). */
  offline_alert_minutes?: number | null;
  /** The driver queue is on at this site. */
  queue_enabled?: boolean;
  /** Minutes the next driver has to start once a connector is held for them. */
  queue_offer_minutes?: number;
  /** Most drivers waiting at once. */
  queue_max_length?: number;
  /** Longest wait before a place in the queue ends. */
  queue_max_wait_minutes?: number;
  /** Fee for reserving a connector here in the driver app, before PPN; 0 = free. */
  reservation_fee_idr?: number;
  /** Bidirectional charging programme: cars whose drivers agree may give energy back (OCPP 2.1). */
  v2x_enabled?: boolean;
  /** Local hours when cars may give energy back (HH:MM; to < from wraps midnight). */
  v2x_windows?: {
    from?: string;
    to?: string;
  }[];
  /** Most the site takes back from cars at once, in W; null = no limit of its own. */
  v2x_max_discharge_w?: number | null;
  /** Energy may flow back to the grid. Off: discharge is capped at the site’s own auxiliary load. */
  v2x_allow_export?: boolean;
  /** Battery floor: no car is discharged below it (a driver may choose a higher one). */
  v2x_min_soc_percent?: number;
  /** Driver credit per kWh given back, taken off the session before tax. */
  v2x_credit_idr_per_kwh?: number;
  /** Signed meter data (OCMF): ignored, kept and checked (default), or required to bill a session. */
  signed_meter_policy?: "off" | "record" | "require";
  archived_at?: string | null;
  created_at?: string;
  org_name?: string;
  ceiling_w?: number | null;
  reserve_w?: number | null;
  strategy?: string | null;
  curtailed?: boolean | null;
  connector_count: number;
  charging_count?: number;
  faulted_count?: number;
  /** Charge points at the site that are not decommissioned. */
  charger_count: number;
  online_count: number;
  /** Configured DLM ceiling, capped at the subscription ceiling. */
  managed_ceiling_w?: number | null;
  live_status: "empty" | "online" | "offline" | "partial";
  computed: SiteComputed;
  spklu_valid?: boolean | null;
}

export interface SiteSaved {
  ok: true;
  id?: string;
  warnings: string[];
}

export interface Statement {
  /** A calendar month, YYYY-MM. */
  period: string;
  daysInMonth?: number;
  status: "draft" | "final";
  /** Draft of the current month: minimums and platform fees are projected to month end. */
  projected?: boolean;
  /** Statement number once finalised (e.g. PSC-202608-ACME); null for a draft. */
  number: string | null;
  /** Present on a final statement. */
  finalisedAt?: string;
  plan: StatementPlan;
  sites: StatementSiteLine[];
  totals: StatementTotals;
  warnings: string[];
  org?: {
    id?: string;
    name?: string;
    slug?: string;
    npwp?: string | null;
    pkp?: boolean;
  } | null;
  /** The site owner the statement is addressed to; null for the organisation's own statement. */
  owner: {
    id?: string;
    name?: string;
    legal_name?: string | null;
    npwp?: string | null;
    pkp?: boolean;
    address?: string | null;
  } | null;
  issuer: {
    name: string;
    npwp?: string | null;
  };
  billTo: StatementParty;
}

export interface StatementChargerLine {
  chargePointId: string;
  ocppIdentity: string;
  displayName?: string | null;
  siteId: string;
  kind: "AC" | "DC";
  activeFraction?: number;
  activeDays?: number;
  sessions: number;
  energyWh?: number;
  gtvIdr?: number;
  pbjtIdr?: number;
  ppnIdr?: number;
  grossIdr?: number;
  mdrIdr?: number;
  inReview?: number;
  commissionIdr?: number;
  minimumIdr?: number;
  topUpIdr?: number;
  privateFeeIdr?: number;
  feeIdr?: number;
}

export interface StatementFinalisedRow {
  /** A calendar month, YYYY-MM. */
  period: string;
  number: string;
  gtv_idr: number;
  commission_idr: number;
  minimum_topup_idr?: number;
  private_fee_idr?: number;
  mdr_credit_idr?: number;
  net_idr: number;
  ppn_idr: number;
  total_idr: number;
  owner_share_idr?: number | null;
  finalised_at: string;
}

export interface StatementParty {
  name: string;
  npwp?: string | null;
  address?: string | null;
}

export interface StatementPlan {
  tiers: StatementTier[];
  tierMode: "whole" | "marginal";
  minPerChargerAcIdr: number;
  minPerChargerDcIdr: number;
  privateFeeAcIdr: number;
  privateFeeDcIdr: number;
  mdrBorneBy: "platform" | "site_owner";
  prorate: boolean;
}

/** Fields left out take the published rates. */
export interface StatementPlanInput {
  /** Ascending upper bounds (exclusive); the last tier has upToIdr null. */
  tiers?: {
    name?: string;
    upToIdr?: number | null;
    rateBps: number;
  }[];
  tierMode?: "whole" | "marginal";
  minPerChargerAcIdr?: number;
  minPerChargerDcIdr?: number;
  privateFeeAcIdr?: number;
  privateFeeDcIdr?: number;
  mdrBorneBy?: "platform" | "site_owner";
  prorate?: boolean;
}

export interface StatementSiteLine {
  siteId: string;
  name: string;
  model: "public" | "private";
  tier?: string | null;
  rateBps?: number | null;
  sessions?: number;
  energyKwh?: number;
  gtvIdr?: number;
  pbjtIdr?: number;
  ppnIdr?: number;
  grossIdr?: number;
  commissionIdr?: number;
  minimumTopUpIdr?: number;
  privateFeeIdr?: number;
  feeIdr?: number;
  mdrIdr?: number;
  mdrCreditIdr?: number;
  platformShareIdr?: number;
  ownerShareIdr?: number;
  warnings?: string[];
  chargers: StatementChargerLine[];
}

export interface StatementTier {
  name: string;
  upToIdr: number | null;
  rateBps: number;
}

export interface StatementTotals {
  sessions: number;
  energyKwh?: number;
  gtvIdr: number;
  pbjtIdr?: number;
  ppnCollectedIdr?: number;
  grossCollectedIdr?: number;
  commissionIdr?: number;
  minimumTopUpIdr?: number;
  privateFeeIdr?: number;
  feesIdr?: number;
  mdrEstimateIdr?: number;
  mdrCreditIdr?: number;
  netIdr: number;
  dppIdr?: number;
  ppnIdr: number;
  totalIdr: number;
  pph23Idr?: number;
  platformShareIdr?: number;
  ownerShareIdr?: number;
}

export type StatementWithHistory = Statement & {
  history: StatementFinalisedRow[];
};

export interface StationCertificate {
  ocpp_identity: string;
  display_name?: string | null;
  site_name?: string;
  site_id?: string;
  security_profile: number;
  status?: string;
  ocpp_version?: string | null;
  cert_auto_upgrade?: boolean;
  /** A certificate is bound to the charger. */
  bound: boolean;
  serial?: string | null;
  not_after?: string | null;
  source?: "plugsure_ca" | "plugsure_ca_csr" | "ocpp_csr" | "vault" | "external" | null;
  /** A new certificate was installed; the previous one is accepted until the charger uses the new one. */
  rotating?: boolean;
  /** The latest certificate request: state, requested_at, delivered_at, error. */
  last_request?: Record<string, unknown> | null;
  online: boolean;
}

export interface Subscription {
  id: string;
  plan_id: string;
  plan_name: string;
  subscriber_kind: "fleet_account" | "card" | "app_driver";
  fleet_account_id?: string | null;
  fleet_account_name?: string | null;
  token_id?: string | null;
  card_uid?: string | null;
  app_driver_id?: string | null;
  driver_phone?: string | null;
  billing: "invoice" | "qris" | "complimentary";
  status: "pending_payment" | "active" | "cancelled" | "expired";
  started_at?: string;
  current_period_start?: string | null;
  current_period_end?: string | null;
  cancelled_at?: string | null;
  notes?: string | null;
  created_at?: string;
  /** App pass: renews itself with the driver's saved card or linked e-wallet. */
  auto_renew?: boolean;
  /** Why the last automatic renewal did not go through (declined, waiting for the driver, method removed). */
  renew_error?: string | null;
  renew_next_at?: string | null;
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  description?: string | null;
  /** Before tax. */
  monthly_fee_idr: number;
  /** Discount on energy in basis points (1000 = 10%). */
  energy_discount_bps: number;
  /** Member price per kWh, used where it is lower than the tariff. */
  member_rate_idr?: number | null;
  /** kWh per month (or per 30-day pass) at no charge. */
  included_kwh: number;
  waive_session_fees: boolean;
  current_type?: "AC" | "DC" | null;
  /** Sites the plan applies at; null = all. */
  site_ids?: string[] | null;
  offered_in_app: boolean;
  active: boolean;
  created_at?: string;
  updated_at?: string;
  members?: number;
}

export interface SubscriptionPlanInput {
  name?: string;
  description?: string;
  monthlyFeeIdr?: number;
  memberRateIdr?: number | null;
  energyDiscountPercent?: number;
  includedKwh?: number;
  waiveSessionFees?: boolean;
  currentType?: "AC" | "DC" | null;
  siteIds?: string[];
  offeredInApp?: boolean;
  active?: boolean;
}

export interface Tariff {
  id: string;
  name: string;
  pln_scheme?: string | null;
  /** NUMERIC, returned as a decimal string. */
  pln_base_rate?: string | null;
  /** NUMERIC, returned as a decimal string. */
  pln_multiplier?: string | null;
  active_from: string;
  active_to?: string | null;
  validated_at?: string | null;
  validation?: TariffFlag[];
  status: "active" | "archived";
  description?: string | null;
  /** flat | tou | tiered. */
  pricing_model?: string;
  ppn_applies?: boolean;
  mdr_mode?: string;
  archived_at?: string | null;
  created_by?: string | null;
  components: {
    kind?: string;
    rate?: number;
    touBlock?: string;
    dayMask?: number;
    timeFrom?: string | null;
    timeTo?: string | null;
    fromKwh?: number;
    toKwh?: number | null;
    fromMinutes?: number;
    toMinutes?: number | null;
  }[];
  assignments: {
    id?: string;
    scopeType?: string;
    scopeId?: string | null;
    priority?: number;
    currentType?: string | null;
    scopeName?: string | null;
  }[];
}

export interface TariffAssignmentFlag {
  code: string;
  severity: "info" | "warning" | "violation";
  message: string;
}

export interface TariffAssignmentRequest {
  tariffId: string;
  priority?: number;
  /** Apply only to AC or DC connectors; omit for all. */
  currentType?: "AC" | "DC";
}

export interface TariffAssignmentResult {
  ok: true;
  flags: TariffAssignmentFlag[];
}

export interface TariffComponentInput {
  kind: "energy" | "time" | "session" | "idle" | "admin";
  /** IDR per kWh (energy), per minute (time, idle) or flat (session, admin). */
  rate: number;
  touBlock?: "WBP" | "LWBP" | "ANY";
  /** Bitmask, bit 0 = Monday. */
  dayMask?: number;
  /** HH:MM local site time. */
  timeFrom?: string;
  /** HH:MM local site time. */
  timeTo?: string;
  fromKwh?: number;
  toKwh?: number;
  /** Grace period before an idle/time component accrues. */
  fromMinutes?: number;
  toMinutes?: number;
  sortOrder?: number;
}

export interface TariffDefinition {
  id?: string;
  name?: string;
  currency?: "IDR";
  plnScheme?: "curah" | "layanan_khusus" | "none";
  plnBaseRate?: number;
  plnMultiplier?: number;
  components: TariffComponentInput[];
  ppnApplies?: boolean;
}

export interface TariffFlag {
  code: string;
  severity: "info" | "warning" | "violation";
  message: string;
}

export interface TariffRating {
  lines: {
    kind: string;
    description: string;
    quantity: number;
    unit: string;
    unitRate: number;
    amountIdr: number;
    touBlock?: string;
  }[];
  chargingClass: "slow" | "medium" | "fast" | "ultrafast";
  tax: {
    subtotalIdr: number;
    pbjtBaseIdr?: number;
    pbjtRateBps?: number;
    pbjtIdr: number;
    ppnDppIdr: number;
    ppnRateBps?: number;
    ppnIdr: number;
    totalIdr: number;
  };
  flags: TariffFlag[];
  tariffSnapshot: Record<string, unknown>;
}

export interface Token {
  id: string;
  uid: string;
  kind?: string;
  status: string;
  valid_to?: string | null;
  offline_allowed?: boolean;
  holder_name?: string | null;
  holder_phone?: string | null;
  account_type: "retail" | "fleet" | "vip" | "technician";
  fleet_name?: string | null;
  energy_limit_wh?: number | null;
  spend_limit_idr?: number | null;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
  has_pin: boolean;
  lifetime_energy_wh: number;
  total_sessions: number;
  lifetime_spend_idr: number;
  last_used_at?: string | null;
}

export interface TokenCreated {
  ok: true;
  id: string;
  uid: string;
}

export interface TokenInput {
  /** Card UID (OCPP idTag). Required on create, ignored on update. Pure hex is upper-cased. */
  uid?: string;
  holderName?: string | null;
  holderPhone?: string | null;
  /** Defaults to retail on create. */
  accountType?: "retail" | "fleet" | "vip" | "technician";
  fleetName?: string | null;
  /** Defaults to Accepted on create. */
  status?: "Accepted" | "Blocked" | "Expired";
  /** Expiry date or date-time. */
  validTo?: string | null;
  /** Lifetime energy cap in kWh (stored in Wh). */
  energyLimitKwh?: number | null;
  /** Lifetime spend cap in IDR. */
  spendLimitIdr?: number | null;
  offlineAllowed?: boolean;
  notes?: string | null;
  /** 4-8 digit PIN for the driver app; stored hashed. null removes it. */
  pin?: string | null;
}

export interface TokenUnknownTag {
  id_tag: string;
  last_seen_at: string;
  /** Charger where the card was presented most recently. */
  ocpp_identity: string;
  presentations: number;
}

export interface TokenUpdated {
  ok: true;
  /** Present when the status changed: push the local list so offline chargers learn it. */
  hint?: string;
}

export interface UserCreateInput {
  name: string;
  /** Unique across PlugSure; stored lower-case. */
  email: string;
  phone?: string | null;
  role: "super_admin" | "cpo_operations_manager" | "site_host_landlord" | "field_technician" | "financial_auditor" | "site_owner" | "fleet_customer";
  /** Sites for site_host_landlord (at least one). */
  siteIds?: string[];
  /** The site owner, for the site_owner role (required there). */
  ownerId?: string | null;
  /** The fleet account, for the fleet_customer role (required there). */
  fleetAccountId?: string | null;
}

export interface UserCreated {
  ok: true;
  id: string;
  /** One-time password, shown only in this response. */
  temporaryPassword: string;
  warning: string;
}

export interface UserPasswordReset {
  ok: true;
  /** One-time password, shown only in this response. */
  temporaryPassword: string;
}

export interface UserRow {
  id: string;
  name: string;
  email: string | null;
  phone?: string | null;
  status: string;
  created_at: string;
  last_login_at?: string | null;
  locked: boolean;
  has_password: boolean;
  must_change_password: boolean;
  roles: {
    role: string;
    /** org, site or owner */
    scopeType: string;
    scopeId?: string | null;
    siteName?: string | null;
    ownerName?: string | null;
  }[];
}

export interface UserUpdateInput {
  name?: string;
  phone?: string | null;
  /** Replaces every role grant. Not allowed on your own account. */
  role?: "super_admin" | "cpo_operations_manager" | "site_host_landlord" | "field_technician" | "financial_auditor" | "site_owner" | "fleet_customer";
  siteIds?: string[];
  ownerId?: string | null;
  /** Not allowed on your own account. Disabling ends the user's sessions. */
  status?: "active" | "disabled";
}

export interface WebhookDelivery {
  id: number;
  event_id: string;
  event_type: string;
  state: "pending" | "delivered" | "failed";
  attempts: number;
  next_attempt_at: string;
  last_status?: number | null;
  last_error?: string | null;
  created_at: string;
  delivered_at?: string | null;
  /** The event data as sent in the envelope `data` field. */
  payload: Record<string, unknown>;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  description?: string | null;
  /** Subscribed event types; ['*'] = every event. */
  events: string[];
  state: "active" | "paused" | "disabled";
  created_at: string;
  updated_at: string;
  consecutive_failures: number;
  last_success_at?: string | null;
  last_failure_at?: string | null;
  last_error?: string | null;
}

export interface WebhookEndpointInput {
  /** https in production; must be publicly reachable; no credentials in the URL. */
  url?: string;
  description?: string;
  /** Event types to receive. Empty or containing '*' = every event. */
  events?: ("session.started" | "session.ended" | "cdr.created" | "charge_point.connected" | "charge_point.disconnected" | "charge_point.booted" | "connector.status_changed" | "alert.raised" | "refund.due" | "refund.completed" | "firmware.status" | "*")[];
}

export type WebhookEndpointRow = WebhookEndpoint & {
  pending: number;
  failed: number;
  delivered_24h: number;
};

export interface WebhookSendResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  ms: number;
}

// ─────────────────────────────────────────────── webhook events

/** An operational alert was raised */
export type Event_alert_raised = {
  id: string;
  type: "alert.raised";
  created_at: string;
  api_version: string;
  data: {
    orgId: string;
    kind: string;
    severity: string;
    message: string;
    targetType?: string;
    targetId?: string;
  };
};

/** A session was rated into a charge record (receipt) */
export type Event_cdr_created = {
  id: string;
  type: "cdr.created";
  created_at: string;
  api_version: string;
  data: {
    orgId: string;
    cdrId: string;
    sessionId: string;
    totalIdr: number;
  };
};

/** A charger sent BootNotification */
export type Event_charge_point_booted = {
  id: string;
  type: "charge_point.booted";
  created_at: string;
  api_version: string;
  data: {
    orgId: string;
    ocppIdentity: string;
    vendor: string;
    model: string;
    firmware?: string;
  };
};

/** A charger connected */
export type Event_charge_point_connected = {
  id: string;
  type: "charge_point.connected";
  created_at: string;
  api_version: string;
  data: {
    orgId: string;
    ocppIdentity: string;
    version: string;
  };
};

/** A charger disconnected */
export type Event_charge_point_disconnected = {
  id: string;
  type: "charge_point.disconnected";
  created_at: string;
  api_version: string;
  data: {
    orgId: string;
    ocppIdentity: string;
  };
};

/** A connector's status changed */
export type Event_connector_status_changed = {
  id: string;
  type: "connector.status_changed";
  created_at: string;
  api_version: string;
  data: {
    orgId: string;
    ocppIdentity: string;
    evseId: number;
    connectorId: number;
    status: string;
    errorCode?: string;
  };
};

/** A charger reported firmware update progress */
export type Event_firmware_status = {
  id: string;
  type: "firmware.status";
  created_at: string;
  api_version: string;
  data: {
    orgId: string;
    ocppIdentity: string;
    status: string;
    jobId?: string | null;
  };
};

/** A refund was paid */
export type Event_refund_completed = {
  id: string;
  type: "refund.completed";
  created_at: string;
  api_version: string;
  data: {
    orgId: string;
    paymentIntentId: string;
    amountIdr: number;
    method: "provider" | "manual";
    reference: string;
  };
};

/** Money is owed back to a driver */
export type Event_refund_due = {
  id: string;
  type: "refund.due";
  created_at: string;
  api_version: string;
  data: {
    orgId: string;
    paymentIntentId: string;
    amountIdr: number;
    reason: string;
  };
};

/** A charging session ended */
export type Event_session_ended = {
  id: string;
  type: "session.ended";
  created_at: string;
  api_version: string;
  data: {
    orgId: string;
    sessionId: string;
    energyWh: number;
    durationS: number;
    stopReason?: string;
  };
};

/** A charging session started */
export type Event_session_started = {
  id: string;
  type: "session.started";
  created_at: string;
  api_version: string;
  data: {
    orgId: string;
    sessionId: string;
    ocppIdentity: string;
    connectorId: number;
  };
};

/** Any webhook delivery, discriminated by `type`. */
export type WebhookEvent = Event_alert_raised | Event_cdr_created | Event_charge_point_booted | Event_charge_point_connected | Event_charge_point_disconnected | Event_connector_status_changed | Event_firmware_status | Event_refund_completed | Event_refund_due | Event_session_ended | Event_session_started;
export const WEBHOOK_EVENT_TYPES = ["alert.raised","cdr.created","charge_point.booted","charge_point.connected","charge_point.disconnected","connector.status_changed","firmware.status","refund.completed","refund.due","session.ended","session.started"] as const;

// ─────────────────────────────────────────────── operations

// ─────────────────────────────────────────────── request and response types

export type AcceptHeldPartnerChargeRecordBody = {
  /** Why, for the audit log. */
  note?: string;
};

export type AcceptHeldPartnerChargeRecordResponse = {
  id: string;
  status: "accepted";
};

export type AcknowledgeAlertResponse = {
  ok: true;
};

export type ActivateChargePointResponse = {
  ok: true;
  activated: boolean;
};

export type AddOnCallOverrideBody = {
  contactId: string;
  startsAt: string;
  endsAt: string;
  note?: string;
};

export type AddOnCallOverrideResponse = {
  override: {
    id: string;
  };
};

export type AddTrustAnchorBody = {
  kind: "V2GRootCertificate" | "MORootCertificate";
  pem: string;
};

export type AddVariableMonitorSetVariableMonitoringBody = {
  component: string;
  componentInstance?: string;
  evseId?: number;
  connectorId?: number;
  variable: string;
  variableInstance?: string;
  type: "UpperThreshold" | "LowerThreshold" | "Delta" | "Periodic" | "PeriodicClockAligned";
  value: number;
  severity: number;
  transaction?: boolean;
};

export type AddVariableMonitorSetVariableMonitoringResponse = {
  ok?: boolean;
  status?: string;
  id?: number;
  reason?: string;
};

export type AdjustDriverPointsBody = {
  appDriverId: string;
  points: number;
  note: string;
};

export type AdjustDriverPointsResponse = {
  balance: number;
};

export type AdoptPendingChargerBody = {
  /** The site to adopt it into. */
  siteId: string;
};

export type AdoptPendingChargerResponse = {
  ok: true;
  chargePointId?: string;
  identity: string;
};

export type ApplyLoadPlanNowResponse = {
  applied: PowerAllocation[];
};

export type ArchiveFirmwareImageResponse = {
  ok: true;
};

export type ArchiveOrRestoreFleetAccountBody = {
  archived?: boolean;
};

export type ArchiveSiteResponse = {
  ok: true;
};

export type ArchiveTariffResponse = {
  ok: true;
};

export type AskChargerForNewClientCertificateResponse = {
  status?: string | null;
};

export type AskStationForItsDeviceModelGetBaseReportBody = {
  reportBase?: "FullInventory" | "ConfigurationInventory" | "SummaryInventory";
};

export type AskStationForItsDeviceModelGetBaseReportResponse = {
  requestId?: number;
  status?: string;
  /** Where the report stands: a quick station may already be sending it. */
  state?: "requested" | "receiving" | "complete" | "rejected" | "empty";
};

export type AskStationForItsVariableMonitorsGetMonitoringReportResponse = {
  requestId?: number;
  status?: string;
  state?: string;
};

export type AssignTariffBody = {
  scopeType: "org" | "site" | "connector";
  /** Site or connector id; ignored for org. */
  scopeId?: string;
  priority?: number;
  /** Limit to AC or DC connectors. */
  currentType?: "AC" | "DC";
};

export type AssignTariffResponse = {
  ok: true;
  flags: TariffFlag[];
};

export type BindClientCertificateBody = {
  /** The charger’s certificate (PEM). Takes precedence over fingerprint. */
  certificatePem?: string;
  /** SHA-256 fingerprint, 64 hex characters (colons allowed). Empty string clears. */
  fingerprint?: string;
};

export type BindClientCertificateResponse = {
  ok: true;
  /** 64 lowercase hex characters, or null when cleared. */
  fingerprint: string | null;
};

export type CancelFirmwareCampaignResponse = {
  ok: true;
};

export type CardHoldsAndPostPayEWalletChargesResponse = {
  holds: CardHold[];
  summary: {
    held: number;
    inProgress: number;
    failed: number;
    heldIdr: number;
    expired?: number;
    expiredIdr?: number;
  };
};

export type ChangeApiKeyNameOrRateLimitBody = {
  name?: string;
  rateLimitPerMin?: number | null;
};

export type ChangeConnectorAvailabilityBody = {
  /** 0 = the whole station. */
  connectorId?: number;
  type?: "Operative" | "Inoperative";
  /** Required (at least 3 characters) for Inoperative. */
  reason?: string;
};

export type ChangeFleetAccountCardsBody = {
  add?: string[];
  remove?: string[];
};

export type ChangeFleetAccountCardsResponse = {
  account: FleetAccountDetail;
  unknown: string[];
};

export type ChargersAndTheirV2gCertificatesResponse = {
  chargers: PncCharger[];
};

export type ChargersBeingOnboardedResponse = {
  chargers: OnboardingCharger[];
  counts: {
    total?: number;
    connected?: number;
    waiting?: number;
    refused?: number;
    certificateInProgress?: number;
    needsCertificate?: number;
  };
};

export type ChargersClientCertificatesResponse = {
  certificates: StationCertificate[];
};

export type CheckChargingProfileDriftResponse = {
  checked: number;
  drift: number;
};

export type ClearReviewAndBillSessionBody = {
  /** Bill despite a rating violation. */
  force?: boolean;
};

export type ConnectOrChangeIntegrationResponse = {
  id?: string;
  scope?: "org" | "platform";
  provider?: string;
  /** Non-secret settings. */
  settings?: Record<string, unknown>;
  /** Secret fields that are set, as a hint (last characters). Secret values are never returned. */
  secretHints?: Record<string, unknown>;
  enabled?: boolean;
  webhookPath?: string | null;
  webhookUrl?: string | null;
  lastTest?: {
    at?: string;
    ok?: boolean | null;
    message?: string | null;
  } | null;
  updatedAt?: string;
} | null;

export type ConnectToRoamingPartnerBody = {
  /** The partner’s OCPI versions URL. */
  versionsUrl: string;
  /** The credentials token the partner issued to us. */
  token: string;
};

export type CreateAlertContactResponse = {
  contact: {
    id: string;
    name: string;
    email: string | null;
    whatsapp: string | null;
    active: boolean;
  };
};

export type CreateAlertRuleResponse = {
  rule: AlertRoutingRule;
};

export type CreateDeveloperSandboxBody = {
  /** A label, e.g. the integrator. */
  name?: string;
};

export type CreateOnCallRotaResponse = {
  rota: {
    id: string;
  };
};

export type CreateOrChangeDriverAppBody = {
  appName?: string;
  shortName?: string;
  slug?: string;
  taglineId?: string;
  taglineEn?: string;
  descriptionId?: string;
  descriptionEn?: string;
  accentColor?: string;
  badgeColor?: string;
  supportEmail?: string;
  supportPhone?: string;
  privacyUrl?: string;
  termsUrl?: string;
  hostname?: string;
  androidPackage?: string;
  androidCertSha256?: string[] | string;
  iosBundleId?: string;
  iosTeamId?: string;
  versionName?: string;
  versionCode?: number;
  status?: "draft" | "live";
};

export type CreateQrisPrePurchaseBody = {
  amountIdr: number;
  /** The charge point. */
  ocppIdentity: string;
  connectorId?: number;
  /** A token this organisation issued to the driver; omit for a walk-up. */
  idToken?: string;
};

export type CreateRoamingPartnerBody = {
  name: string;
  /** Any other value is stored as emsp. */
  kind?: "emsp" | "cpo" | "hub";
};

export type CreateRoamingPartnerResponse = {
  partner: RoamingPartner;
  /** Token A for the partner. Shown once. */
  token: string;
  versionsUrl: string;
};

export type CreateSiteOwnerResponse = {
  id: string;
};

export type CreateTariffBody = {
  name?: string;
  plnScheme?: "curah" | "layanan_khusus" | "none";
  /** PLN base rate (IDR/kWh) the multiplier applies to. */
  plnBaseRate?: number;
  plnMultiplier?: number;
  /** Default now. */
  activeFrom?: string;
  activeTo?: string;
  components?: TariffComponentInput[];
  /** Nameplate power the ceiling check uses. */
  appliesToMaxPowerW?: number;
  description?: string;
  pricingModel?: "flat" | "tou" | "tiered";
  ppnApplies?: boolean;
  mdrMode?: "absorb";
};

export type CreateTariffResponse = {
  ok: true;
  tariffId: string;
  flags: TariffFlag[];
};

export type CreateWebhookEndpointResponse = {
  endpoint: WebhookEndpoint;
  /** Signing secret, shown only once. */
  secret: string;
};

export type DecommissionChargePointBody = {
  reason?: string;
};

export type DecommissionChargePointResponse = {
  ok: true;
};

export type DeleteAlertContactResponse = {
  ok: true;
};

export type DeleteAlertRuleResponse = {
  ok: true;
};

export type DeleteCertificateFromChargerBody = {
  certificateHashData: {
    hashAlgorithm: "SHA256" | "SHA384" | "SHA512";
    /** Hex hash of the issuer's distinguished name. */
    issuerNameHash: string;
    /** Hex hash of the issuer's public key. */
    issuerKeyHash: string;
    /** Serial number, hex, no leading zeros. */
    serialNumber: string;
  };
};

export type DeleteOnCallRotaResponse = {
  ok: true;
};

export type DeleteSandboxResponse = {
  ok: true;
};

export type DeleteWebhookEndpointResponse = {
  ok: true;
};

export type DescribeThisSandboxResponse = {
  sandbox: {
    id: string;
    name: string;
    parent: string;
  };
  chargePoints: {
    identity: string;
    displayName?: string | null;
    status: string;
    connectors: number;
    simulator?: SandboxCharger | null;
  }[];
  tokens: {
    uid?: string;
    status?: string;
    holder?: string | null;
  }[];
  events: string[];
  timeScale: number;
};

export type DisconnectRoamingPartnerResponse = {
  ok: true;
};

export type EMailCreditNoteBody = {
  to?: string;
};

export type EMailCreditNoteResponse = {
  ok: boolean;
  to: string;
  reference?: string | null;
};

export type EMailFleetInvoiceBody = {
  to?: string;
};

export type EMailFleetInvoiceResponse = {
  ok: boolean;
  to: string;
  reference?: string | null;
};

export type EnrolMemberBody = {
  planId: string;
  subscriberKind: "fleet_account" | "card";
  fleetAccountId?: string;
  cardUid?: string;
  billing?: "invoice" | "complimentary";
  notes?: string;
};

export type FetchPkiRootCertificatesResponse = {
  anchors: PncTrustAnchor[];
  received: number;
};

export type GetAlertRoutingSettingsResponse = {
  channels: {
    email: AlertRoutingChannel;
    whatsapp: AlertRoutingChannel;
    sms: AlertRoutingChannel;
  };
  contacts: AlertRoutingContact[];
  rules: AlertRoutingRule[];
  rotas: AlertRota[];
  /** Alert kind → human title. */
  kinds: Record<string, string>;
  timeZone: string;
  consoleUrl: string | null;
};

export type GetAuditLogResponse = {
  entries: AuditEntry[];
  chain: AuditChain;
};

export type GetFleetBillingMonthResponse = {
  period: string;
  periodLabel?: string;
  /** The current month. */
  current?: string;
  /** Only an ended month can be invoiced. */
  ended: boolean;
  rows: {
    accountId: string;
    name: string;
    legalName?: string | null;
    status: "draft" | "issued" | "paid";
    invoiceId?: string | null;
    number?: string | null;
    sessions: number;
    energyWh?: number;
    ppnIdr?: number;
    roamingIdr?: number;
    totalIdr: number;
    dueDate?: string | null;
    overdue?: boolean;
    efakturExported?: boolean;
    efakturNumber?: string | null;
    sent?: boolean;
    voided?: number;
    warnings?: number;
  }[];
  unassigned: {
    sessions?: number;
    totalIdr?: number;
  };
};

export type GetSiteOwnerCommercialPlanResponse = {
  plan: BillingPlanInForce;
  history: BillingPlanVersion[];
};

export type GetSitePowerAndAllocationResponse = {
  headroom: PowerHeadroom;
  budget: PowerSiteBudget;
  plan: PowerAllocation[];
  /** Connected kVA × PF; null when the subscribed capacity is unknown. */
  subscriptionCeilingW: number | null;
  /** Ceiling minus reserve; 0 while curtailed. */
  usableW: number;
};

export type GetStoredDeviceModelOcpp201Response = {
  supported?: boolean;
  online?: boolean;
  variables?: number;
  components?: Record<string, unknown>[];
  monitors?: Record<string, unknown>[];
  reports?: Record<string, unknown>[];
};

export type ImportPartnerNetworkResponse = {
  locations: number;
  tariffs: number;
};

export type InstallTrustAnchorsOnChargerBody = {
  kinds?: ("V2GRootCertificate" | "MORootCertificate")[];
};

export type InstallTrustAnchorsOnChargerResponse = {
  results: {
    kind?: string;
    subject?: string;
    /** Accepted, Rejected or Failed. */
    status?: string | null;
  }[];
};

export type IntegrationActivityResponse = {
  events: {
    id?: number;
    kind?: string;
    provider?: string;
    action?: string;
    outcome?: string;
    detail?: Record<string, unknown>;
    created_at?: string;
  }[];
};

export type IntegrationsAndTheirStatusResponse = {
  kinds: IntegrationKind[];
  production: boolean;
  publicBaseUrl?: string;
};

export type IssueApiKeyBody = {
  name?: string;
  /** Permission strings such as `charge_point:read`. */
  permissions?: string[];
  scopeType?: "org" | "site" | "fleet";
  /** Required for site and fleet scope; ignored for org. */
  scopeId?: string;
  /** The key’s own limit, requests a minute. Omit or null for the installation default. */
  rateLimitPerMin?: number | null;
};

export type IssueAuthorizationKeyBody = {
  /** Optional installer-chosen key: 16–40 letters and digits, at least 8 distinct characters. */
  key?: string;
  /** Raise a rotation reminder when the key is older than this. */
  rotationDays?: number;
};

export type IssueCreditNoteBody = {
  /** Printed on the credit note. */
  reason: string;
  /** Credit everything still creditable on the invoice. */
  full?: boolean;
  lines?: {
    description: string;
    /** PPN included. */
    amountIdr: number;
    /** Default: whether the invoice carries PPN. */
    taxed?: boolean;
  }[];
  /** For a paid invoice only. */
  settlement?: "refund" | "next_invoice";
};

export type IssueCreditNoteResponse = {
  creditNote: FleetCreditNote;
  /** The credit left nothing owed, so the invoice is now paid. */
  settledInvoice: boolean;
  fakturWarning?: string | null;
};

export type IssueEveryFleetAccountInvoiceForMonthResponse = {
  issued: {
    accountId?: string;
    number?: string;
  }[];
  skipped: {
    accountId?: string;
    reason?: string;
  }[];
};

export type IssueFleetAccountInvoiceForMonthBody = {
  fleetAccountId: string;
  period: string;
};

export type IssueTestContractCertificateBody = {
  emaid: string;
};

export type IssueTestContractCertificateResponse = {
  emaid: string;
  serial: string;
  certificatePem: string;
  chainPem: string;
  hashData: {
    hashAlgorithm: "SHA256" | "SHA384" | "SHA512";
    /** Hex hash of the issuer's distinguished name. */
    issuerNameHash: string;
    /** Hex hash of the issuer's public key. */
    issuerKeyHash: string;
    /** Serial number, hex, no leading zeros. */
    serialNumber: string;
    responderURL?: string;
  }[];
};

export type ListAlertNotificationsResponse = {
  rows: AlertRoutingNotification[];
};

export type ListChargingByOurCardsOnOtherNetworksResponse = {
  active: RoamingAbroadSession[];
  cdrs: RoamingAbroadCdr[];
};

export type ListContractsEMAIDsResponse = {
  contracts: PncContract[];
};

export type ListCreditNotesResponse = {
  creditNotes: FleetCreditNoteRow[];
};

export type ListDeveloperSandboxesResponse = {
  sandboxes: SandboxSummary[];
  max: number;
};

export type ListDriversWithMostPointsResponse = {
  members: {
    appDriverId?: string;
    phone?: string;
    name?: string | null;
    balance?: number;
    autoRedeem?: boolean;
    lastActivity?: string;
  }[];
};

export type ListFleetAccountsResponse = {
  accounts: FleetAccount[];
};

export type ListFleetInvoicesResponse = {
  invoices: FleetInvoiceRow[];
};

export type ListMembersResponse = {
  subscriptions: Subscription[];
};

export type ListMembershipPlansResponse = {
  plans: SubscriptionPlan[];
};

export type ListPartnerChargeRecordsHeldForReviewResponse = {
  id: string;
  cdr_id: string;
  session_id?: string | null;
  start_date_time?: string;
  end_date_time?: string;
  /** Decimal number as a string (Postgres NUMERIC). */
  total_energy?: string;
  currency: string;
  /** Decimal number as a string (Postgres NUMERIC). */
  total_excl_vat: string;
  /** Decimal number as a string (Postgres NUMERIC), or null. */
  total_incl_vat?: string | null;
  received_at: string;
  country_code?: string;
  party_id?: string;
  hold_reason?: string | null;
  partner_name: string;
  uid?: string | null;
  contract_id?: string | null;
  holder_name?: string | null;
  fleet_name?: string | null;
  location_name?: string | null;
  authorization_reference?: string | null;
}[];

export type ListPromotionsResponse = {
  promotions: Promotion[];
};

export type ListRefundsOwedToDriversResponse = {
  summary: RefundSummary;
  rows: RefundRow[];
};

export type ListTrustAnchorsResponse = {
  anchors: PncTrustAnchor[];
};

export type ListWebhookDeliveriesResponse = {
  rows: WebhookDelivery[];
};

export type ListWebhookEndpointsResponse = {
  events: ("session.started" | "session.ended" | "cdr.created" | "charge_point.connected" | "charge_point.disconnected" | "charge_point.booted" | "connector.status_changed" | "alert.raised" | "refund.due" | "refund.completed" | "firmware.status")[];
  rows: WebhookEndpointRow[];
};

export type PlugChargeExchangeLogResponse = {
  events: PncEvent[];
};

export type PreviewTariffBody = {
  tariff: TariffDefinition;
  /** Default one hour ago. */
  startedAt?: string;
  /** Default now. */
  endedAt?: string;
  energyWh?: number;
  connectorMaxPowerW?: number;
  /** PBJT rate in basis points. */
  pbjtRateBps?: number;
  idleMinutes?: number;
};

export type ProvisionDefaultChargingProfilesResponse = {
  applied: number;
};

export type PullHubClientListResponse = {
  clients: number;
};

export type ReadCertificatesInstalledOnChargerResponse = {
  /** Accepted or NotFound. */
  status?: string | null;
  certificates: {
    certificateType?: string;
    certificateHashData?: {
      hashAlgorithm: "SHA256" | "SHA384" | "SHA512";
      /** Hex hash of the issuer's distinguished name. */
      issuerNameHash: string;
      /** Hex hash of the issuer's public key. */
      issuerKeyHash: string;
      /** Serial number, hex, no leading zeros. */
      serialNumber: string;
    };
  }[];
};

export type ReadVariablesNowGetVariablesBody = {
  items: {
    component: string;
    componentInstance?: string;
    evseId?: number;
    connectorId?: number;
    variable: string;
    variableInstance?: string;
    attributeType?: "Actual" | "Target" | "MinSet" | "MaxSet";
  }[];
};

export type ReadVariablesNowGetVariablesResponse = {
  results?: Record<string, unknown>[];
};

export type ReconcileStuckSessionsResponse = {
  /** Sessions closed for review. */
  stuck: number;
  /** Unrated sessions retried. */
  rerated: number;
};

export type RecordCreditNoteAsRefundedBody = {
  refundedAt?: string;
  reference?: string;
};

export type RecordFakturPajakNumberBody = {
  number?: string | null;
};

export type RecordPaymentOfFleetInvoiceBody = {
  paidAt?: string;
  reference?: string;
};

export type RecordRefundPaidByBankTransferBody = {
  /** Bank transfer reference. */
  reference: string;
};

export type RecordRefundPaidByBankTransferResponse = {
  ok: true;
  state: "refunded";
  refundRef: string;
};

export type RegisterChargePointBody = {
  ocppIdentity: string;
  /** The site the charger is installed at. */
  siteId: string;
  displayName?: string;
  vendor?: string;
  model?: string;
  serial?: string;
  firmware?: string;
  ocppVersion?: "ocpp1.6" | "ocpp2.0.1" | "ocpp2.1";
  /** Topology. On OCPP 1.6 each gun is its own EVSE with one connector. */
  evses?: ChargePointEvseSpec[];
};

export type RegisterChargePointResponse = {
  ok: true;
  chargePointId?: string;
  identity: string;
  status: "pending_adoption";
  /** The remaining commissioning steps. */
  next: string[];
};

export type RegisterContractBody = {
  /** CC-PPP-IIIIIIIII[-C], separators optional. */
  emaid: string;
  holderName?: string;
  accountType?: "retail" | "fleet";
  fleetName?: string;
  validTo?: string;
  notes?: string;
};

export type ReinstateDecommissionedChargePointResponse = {
  ok: true;
};

export type RejectHeldPartnerChargeRecordBody = {
  /** Why, for the audit log. */
  note?: string;
};

export type RejectHeldPartnerChargeRecordResponse = {
  id: string;
  status: "rejected";
};

export type RemoveDriverAppResponse = {
  ok: true;
};

export type RemoveDriverFromQueueResponse = {
  ok: true;
};

export type RemoveIntegrationConsoleSettingsResponse = {
  removed: boolean;
};

export type RemoveIOSNotificationsKeyResponse = {
  ok: true;
};

export type RemoveOnCallOverrideResponse = {
  ok: true;
};

export type RemoveTariffAssignmentResponse = {
  ok: true;
};

export type RemoveVariableMonitorClearVariableMonitoringResponse = {
  ok?: boolean;
  status?: string;
};

export type RenameSuspendOrResumePartnerBody = {
  name?: string;
  state?: "suspended" | "connected";
};

export type ReplaceAlertContactResponse = {
  contact: {
    id: string;
    name: string;
    email: string | null;
    whatsapp: string | null;
    active: boolean;
  };
};

export type ReplaceAlertRuleResponse = {
  rule: AlertRoutingRule;
};

export type ReplaceOnCallRotaResponse = {
  rota: {
    id: string;
  };
};

export type ReplayFailedPushesResponse = {
  requeued: number;
};

export type ReplayFailedWebhookDeliveriesBody = {
  /** Replay only this delivery (its numeric id). */
  deliveryId?: number | string;
};

export type ReplayFailedWebhookDeliveriesResponse = {
  requeued: number;
};

export type ReSendEverythingToPartnerResponse = {
  locations: number;
  tariffs: number;
  tokens: number;
};

export type ResetChargePointBody = {
  type?: "Soft" | "Hard";
};

export type ResetThisSandboxChargersResponse = {
  ok: boolean;
  reset: string[];
};

export type ResolveAlertResponse = {
  ok: true;
};

export type ResumeSuspendedChargePointResponse = {
  ok: true;
};

export type RetryCardHoldCaptureOrReleaseNowResponse = {
  ok: boolean;
  state: string | null;
};

export type RetryFailedAlertNotificationResponse = {
  ok: true;
};

export type RetryFailedFirmwareJobsResponse = {
  ok: true;
  /** Jobs reset. */
  retried: number;
};

export type RevokeApiKeyResponse = {
  ok: true;
};

export type RevokeTestContractCertificateResponse = {
  revoked: boolean;
};

export type RotateSandboxApiKeyResponse = {
  apiKey: string;
};

export type RotateWebhookSigningSecretResponse = {
  /** Signing secret, shown only once. */
  secret: string;
};

export type SaveAlertChannelBody = {
  enabled?: boolean;
  config?: {
    /** E-mail: SMTP host. */
    host?: string;
    /** E-mail: SMTP port. */
    port?: number;
    /** E-mail: connection security. */
    security?: "tls" | "starttls" | "none";
    /** E-mail: SMTP user name. */
    username?: string;
    /** E-mail: sender address. */
    fromAddress?: string;
    /** E-mail: sender name. */
    fromName?: string;
    /** WhatsApp: Graph API base URL. */
    apiBase?: string;
    /** WhatsApp: phone number id. */
    phoneNumberId?: string;
    /** WhatsApp: approved template name. */
    templateName?: string;
    /** WhatsApp: template language, e.g. id or en_US. */
    templateLang?: string;
    /** SMS: the provider. */
    provider?: "twilio" | "zenziva" | "http";
    /** SMS (Twilio): Account SID (AC…). */
    accountSid?: string;
    /** SMS (Twilio): sender number, unless messagingServiceSid. */
    from?: string;
    /** SMS (Twilio): Messaging Service SID (MG…). */
    messagingServiceSid?: string;
    /** SMS (Twilio): API base, default https://api.twilio.com. */
    baseUrl?: string;
    /** SMS (Zenziva): user key. */
    userkey?: string;
    /** SMS (Zenziva): API URL, default the regular SMS endpoint. */
    endpoint?: string;
    /** SMS (your gateway): POST { to, message, channel, purpose: alert } with the secret as a bearer token. */
    url?: string;
  };
  /** SMTP password, WhatsApp access token, Twilio auth token, Zenziva pass key or gateway token. Write-only. */
  secret?: string;
  /** WhatsApp: the Meta app secret, to check delivery-status webhook signatures. Write-only. */
  webhookSecret?: string;
};

export type SaveAlertChannelResponse = {
  ok: true;
};

export type SaveFleetBillingSettingsBody = {
  npwp?: string;
  nitku?: string;
  address?: string;
  prefix?: string;
  paymentInstructions?: string;
  efaktur?: {
    itemOpt?: "A" | "B";
    itemCode?: string;
    unitCode?: string;
    confirmed?: boolean;
  };
};

export type SendCommandToChargePointBody = {
  connectorId?: number;
  /** remote-start. */
  idTag?: string;
  /** remote-start. */
  limitType?: "none" | "energy" | "duration" | "amount";
  /** remote-start: kWh, minutes or IDR. */
  limitValue?: number;
  /** remote-stop. */
  transactionId?: number | string;
  /** reset: Soft | Hard. change-availability: Operative | Inoperative. */
  type?: string;
  /** change-availability: required (3+ characters) when taking a connector out of service. */
  reason?: string;
  /** trigger. Default StatusNotification. */
  requestedMessage?: string;
  /** get-configuration. */
  keys?: string[];
  /** change-configuration. */
  key?: string;
  /** change-configuration. */
  value?: string;
  /** get-composite-schedule. Default 600. */
  durationS?: number;
  chargingRateUnit?: "A" | "W";
  /** data-transfer. */
  vendorId?: string;
  messageId?: string;
  data?: unknown;
  /** get-diagnostics / update-firmware: upload or download URL. */
  location?: string;
  /** update-firmware. Default now. */
  retrieveDate?: string;
  /** reserve-now / cancel-reservation. */
  reservationId?: number;
  /** reserve-now. */
  expiryDate?: string;
};

export type SendCommandToPartnerBody = {
  command: "START_SESSION" | "STOP_SESSION" | "UNLOCK_CONNECTOR";
  partnerId: string;
  /** START_SESSION: our card (token) id; it must be shared for roaming. */
  tokenId?: string;
  /** START_SESSION, UNLOCK_CONNECTOR. */
  locationId?: string;
  /** Optional for START_SESSION; required for UNLOCK_CONNECTOR. */
  evseUid?: string;
  /** Optional for START_SESSION; required for UNLOCK_CONNECTOR. */
  connectorId?: string;
  /** STOP_SESSION. */
  sessionId?: string;
  /** The location owner’s country code, when the partner is a hub. */
  countryCode?: string;
  /** The location owner’s party id, when the partner is a hub. */
  partyId?: string;
};

export type SendTestAlertMessageBody = {
  /** E-mail address, or WhatsApp / mobile number (e.g. +62 812 3456 7890). */
  destination: string;
};

export type SendTestAlertMessageResponse = {
  ok: boolean;
  destination: string;
  reference: string | null;
  error: string | null;
};

export type SetConnectorLoadManagementPrioritiesResponse = {
  ok: true;
};

export type SetEvseAndConnectorTopologyResponse = {
  ok: true;
};

export type SetRoamingIdentityBody = {
  /** ISO 3166 alpha-2, e.g. ID. Upper-cased. */
  countryCode: string;
  /** Three letters or digits. Upper-cased. */
  partyId: string;
  businessName: string;
  website?: string;
};

export type SetRoamingIdentityResponse = {
  party: RoamingParty;
};

export type SetSecurityProfileBody = {
  profile: 0 | 1 | 2 | 3;
};

export type SetSecurityProfileResponse = {
  ok: true;
  profile: 0 | 1 | 2 | 3;
};

export type SetSiteOwnerSitesBody = {
  siteIds: string[];
};

export type SetSiteOwnerSitesResponse = {
  ok: true;
};

export type SetSitePowerBudgetBody = {
  ceilingW?: number;
  /** Ignored when reserveBreakdown is given. */
  reserveW?: number;
  /** Watts held back per auxiliary load; the reserve becomes their sum. */
  reserveBreakdown?: {
    lighting?: number;
    pos?: number;
    cctv?: number;
    hvac?: number;
    other?: number;
  };
  strategy?: "fair_share" | "priority" | "fifo";
  curtailed?: boolean;
  curtailedReason?: string;
  applyNow?: boolean;
};

export type SetVariableSetVariablesBody = {
  component: string;
  componentInstance?: string;
  evseId?: number;
  connectorId?: number;
  variable: string;
  variableInstance?: string;
  attributeType?: "Actual" | "Target" | "MinSet" | "MaxSet";
  value: string;
};

export type SetVariableSetVariablesResponse = {
  ok?: boolean;
  status?: string;
  rebootRequired?: boolean;
  reason?: string;
  label?: string;
};

export type ShareOrUnshareCardsBody = {
  /** true to share; anything else unshares. */
  shared?: boolean;
  /** Every active card whose sharing differs. */
  all?: boolean;
  /** Card (token) ids. Required unless `all` is true. */
  ids?: string[];
};

export type ShareOrUnshareCardsResponse = {
  changed: number;
};

export type ShareOrWithdrawSiteBody = {
  city?: string;
  /** true to share, false to withdraw. */
  publish?: boolean;
};

export type ShareOrWithdrawSiteResponse = {
  ok: true;
};

export type SimulateEventAtVirtualChargerBody = {
  event: "plug-in" | "unplug" | "tap-card" | "plug-and-charge" | "stop" | "fault" | "clear-fault" | "go-offline" | "come-online" | "reboot" | "status";
  connectorId?: number;
  /** For `tap-card`: the card tapped, e.g. SANDBOX-RFID-0001. */
  idTag?: string;
  /** For `plug-and-charge`: the car's contract, e.g. ID-PLS-C12345678. */
  emaid?: string;
  /** For `tap-card` and `plug-and-charge`: energy after which the car is full and the session ends. */
  kwh?: number;
  /** For `fault`: an OCPP 1.6 ChargePointErrorCode. */
  errorCode?: string;
  vendorErrorCode?: string;
  info?: string;
};

export type SimulateEventAtVirtualChargerResponse = {
  identity: string;
  event: string;
  charger: SandboxCharger;
  /** For `plug-and-charge`: the CSMS's answer to the charger (idTokenInfo, certificateStatus). */
  authorize?: Record<string, unknown> | null;
  /** For `plug-and-charge`: the test contract certificate used. */
  contract?: {
    emaid?: string;
    serial?: string;
  };
};

export type SimulateQrisPaymentResponse = {
  ok: true;
  charge: CheckoutQrisCharge;
};

export type SiteDriverQueueResponse = {
  settings: {
    enabled?: boolean;
    offerMinutes?: number;
    maxLength?: number;
    maxWaitMinutes?: number;
  };
  entries: {
    id?: string;
    state?: "waiting" | "offered" | "served" | "left" | "missed" | "expired" | "removed";
    joinedAt?: string;
    offeredAt?: string | null;
    endedAt?: string | null;
    endReason?: string | null;
    position?: number | null;
    driver?: string;
    /** AC or DC and a plug type, or "Any connector". */
    want?: string;
    offer?: {
      connector?: string;
      expiresAt?: string;
    } | null;
  }[];
  stats: {
    waiting?: number;
    offered?: number;
    served24h?: number;
    missed24h?: number;
    left24h?: number;
    medianWaitMinutes?: number | null;
  };
};

export type StartSessionRemotelyBody = {
  connectorId?: number;
  /** The RFID uid or driver token to start for. */
  idTag: string;
  limitType?: "none" | "energy" | "duration" | "amount";
  /** energy: 0.1–1000 kWh; duration: 1–1440 minutes; amount: Rp 1,000–10,000,000 (converted to energy through the tariff). */
  limitValue?: number;
};

export type StopSessionRemotelyBody = {
  /** The OCPP transaction id of the running session. */
  transactionId: number | string;
};

export type SuspendChargePointBody = {
  reason?: string;
};

export type SuspendChargePointResponse = {
  ok: true;
};

export type SwitchPlugChargeOnOrOffAtChargerBody = {
  enabled?: boolean;
};

export type SwitchPlugChargeOnOrOffAtChargerResponse = {
  pncEnabled: boolean;
  /** The charger's answer, or why it was not sent. */
  charger?: string | null;
};

export type SwitchSignedMeterReadingsOnOrOffBody = {
  enabled?: boolean;
};

export type SwitchSignedMeterReadingsOnOrOffResponse = {
  enabled: boolean;
  accepted: boolean;
  results: {
    component?: string;
    variable?: string;
    status?: string;
  }[];
};

export type TestIntegrationBody = {
  scope?: "org" | "platform";
  /** Sign-in codes: send a real test code to this number. */
  phone?: string;
};

export type TestIntegrationResponse = {
  ok: boolean;
  message: string;
};

export type TriggerMessageFromChargePointBody = {
  /** BootNotification, Heartbeat, MeterValues, StatusNotification, DiagnosticsStatusNotification, FirmwareStatusNotification. */
  requestedMessage?: string;
  connectorId?: number;
};

export type UnlockConnectorBody = {
  connectorId?: number;
};

export type UpdateChargePointProfileResponse = {
  ok: true;
};

export type UpdateConsoleUserResponse = {
  ok: true;
};

export type UpdateSiteOwnerBody = OwnerInput & {
  archived?: boolean;
};

export type UpdateSiteOwnerResponse = {
  ok: true;
};

export type UpdateWebhookEndpointBody = WebhookEndpointInput & {
  state?: "active" | "paused";
};

export type UpdateWebhookEndpointResponse = {
  endpoint: WebhookEndpoint;
};

export type UploadAppIconBody = {
  /** Base64 PNG (a data: URL is accepted). */
  png: string;
};

export type UploadAppIconResponse = DriverAppView & {
  icon: {
    width: number;
    height: number;
    bytes: number;
    sha256: string;
    warnings: string[];
  };
};

export type UploadIOSNotificationsKeyAPNsBody = {
  keyId: string;
  /** The whole .p8 file (PEM). */
  p8: string;
};

export type ValidateTariffBody = {
  tariff: TariffDefinition;
  connectorMaxPowerW?: number;
};

export type ValidateTariffResponse = {
  flags: TariffFlag[];
};

export type VoidCreditNoteBody = {
  reason: string;
};

export type VoidFleetInvoiceBody = {
  reason: string;
};

export type VoidFleetInvoiceResponse = {
  invoice: FleetStatement;
  fakturWarning?: string | null;
};

/** Every operation of the API, one method each. `PlugSure` (index.ts) adds the transport. */
export class Operations {
  constructor(protected readonly transport: Transport) {}

  /**
   * Accept a held partner charge record
   *
   * Accepts a held (or rejected) record: it is invoiced in the month it was reviewed and counts against the card limits, and the driver gets the receipt. Audited as roaming.cdr_accepted.
   *
   * `POST /v1/roaming/cdrs/{id}/accept` · needs `roaming:write`
   */
  acceptHeldPartnerChargeRecord(params: {
    /** Charge record id (UUID). */
    id: string;
    body?: AcceptHeldPartnerChargeRecordBody;
  }, options?: RequestOptions): Promise<AcceptHeldPartnerChargeRecordResponse> {
    return this.transport.request<AcceptHeldPartnerChargeRecordResponse>({ method: "POST", path: "/v1/roaming/cdrs/{id}/accept", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Acknowledge an alert
   *
   * "I'm on it": records who acknowledged the alert and stops escalation notices. Only an open, not yet acknowledged alert can be acknowledged. Audited.
   *
   * `POST /v1/alerts/{id}/acknowledge` · needs `charge_point:command`
   */
  acknowledgeAlert(params: {
    /** Alert id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<AcknowledgeAlertResponse> {
    return this.transport.request<AcknowledgeAlertResponse>({ method: "POST", path: "/v1/alerts/{id}/acknowledge", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Activate a charge point
   *
   * Moves a `pending_adoption` charge point into service so it can transact; a connected unit is asked to boot again at once. `activated` is false when it was not pending. Audited when it changes.
   *
   * `POST /v1/charge-points/{identity}/activate` · needs `charge_point:write`
   */
  activateChargePoint(params: {
    /** OCPP identity of the charge point (the last path segment of its WebSocket URL), e.g. `AUTEL-DC60-SMB-002`. */
    identity: string;
  }, options?: RequestOptions): Promise<ActivateChargePointResponse> {
    return this.transport.request<ActivateChargePointResponse>({ method: "POST", path: "/v1/charge-points/{identity}/activate", pathParams: { identity: params.identity }, accept: "json" }, options);
  }

  /**
   * Add a firmware image by URL
   *
   * Registers firmware hosted at a public HTTPS URL; chargers download it from there. URLs that resolve to private or internal addresses are refused. The declared SHA-256 is stored unverified until you call verify. Audited as firmware.image_added.
   *
   * `POST /v1/firmware/images` · needs `firmware:write`
   */
  addFirmwareImageByUrl(params: {
    body: FirmwareImageUrlRequest;
  }, options?: RequestOptions): Promise<FirmwareImageCreated> {
    return this.transport.request<FirmwareImageCreated>({ method: "POST", path: "/v1/firmware/images", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add an on-call override
   *
   * Puts someone else on duty for a period (leave, a swap), over the rotation. The most recently added override wins where they overlap. At most 92 days. Audited.
   *
   * `POST /v1/alert-routing/rotas/{id}/overrides` · needs `alert:write`
   */
  addOnCallOverride(params: {
    /** Rota id (UUID). */
    id: string;
    body: AddOnCallOverrideBody;
  }, options?: RequestOptions): Promise<AddOnCallOverrideResponse> {
    return this.transport.request<AddOnCallOverrideResponse>({ method: "POST", path: "/v1/alert-routing/rotas/{id}/overrides", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add a trust anchor
   *
   * **Permissions checked:** `org:write`.
   *
   * `POST /v1/pnc/trust-anchors` · needs `org:write`
   */
  addTrustAnchor(params: {
    body: AddTrustAnchorBody;
  }, options?: RequestOptions): Promise<PncTrustAnchor> {
    return this.transport.request<PncTrustAnchor>({ method: "POST", path: "/v1/pnc/trust-anchors", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add a variable monitor (SetVariableMonitoring)
   *
   * Asks the station to watch a variable: UpperThreshold / LowerThreshold (value is the limit), Delta (the change), Periodic / PeriodicClockAligned (seconds). Severity 0 (danger) to 9 (debug). A monitor that triggers sends NotifyEvent, which raises a charge_point.device_event alert; the alert resolves when the station reports the event cleared.
   *
   * `POST /v1/charge-points/{identity}/device-model/monitors`
   */
  addVariableMonitorSetVariableMonitoring(params: {
    /** OCPP identity of the charge point (last path segment of its WebSocket URL), e.g. AUTEL-DC60-SMB-002. */
    identity: string;
    body: AddVariableMonitorSetVariableMonitoringBody;
  }, options?: RequestOptions): Promise<AddVariableMonitorSetVariableMonitoringResponse> {
    return this.transport.request<AddVariableMonitorSetVariableMonitoringResponse>({ method: "POST", path: "/v1/charge-points/{identity}/device-model/monitors", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Adjust a driver's points
   *
   * Goodwill points (positive) or a correction (negative, never below zero), with the reason, which the driver sees in their history. Audited.
   *
   * `POST /v1/loyalty/adjust` · needs `tariff:write`
   */
  adjustDriverPoints(params: {
    body: AdjustDriverPointsBody;
  }, options?: RequestOptions): Promise<AdjustDriverPointsResponse> {
    return this.transport.request<AdjustDriverPointsResponse>({ method: "POST", path: "/v1/loyalty/adjust", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Adopt a pending charger
   *
   * Registers an identity that already tried to connect, at one of the caller’s sites, in `pending_adoption`. Returns 400 when the identity is already registered. Audited as charge_point.adopted.
   *
   * `POST /v1/pending-chargers/{identity}/adopt` · needs `charge_point:write`
   */
  adoptPendingCharger(params: {
    /** The identity the charger presented. */
    identity: string;
    body: AdoptPendingChargerBody;
  }, options?: RequestOptions): Promise<AdoptPendingChargerResponse> {
    return this.transport.request<AdoptPendingChargerResponse>({ method: "POST", path: "/v1/pending-chargers/{identity}/adopt", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Apply the load plan now
   *
   * Runs one load-management pass immediately, sending station ceilings and per-transaction charging profiles to the site’s online chargers.
   *
   * `POST /v1/sites/{siteId}/power/apply` · needs `smartcharging:write`
   */
  applyLoadPlanNow(params: {
    /** Site id (UUID). */
    siteId: string;
  }, options?: RequestOptions): Promise<ApplyLoadPlanNowResponse> {
    return this.transport.request<ApplyLoadPlanNowResponse>({ method: "POST", path: "/v1/sites/{siteId}/power/apply", pathParams: { siteId: params.siteId }, accept: "json" }, options);
  }

  /**
   * Archive a firmware image
   *
   * Archives the image: new campaigns cannot use it and an uploaded file stops being served to chargers. Audited as firmware.image_archived.
   *
   * `POST /v1/firmware/images/{id}/archive` · needs `firmware:write`
   */
  archiveFirmwareImage(params: {
    /** Firmware image id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<ArchiveFirmwareImageResponse> {
    return this.transport.request<ArchiveFirmwareImageResponse>({ method: "POST", path: "/v1/firmware/images/{id}/archive", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Archive or restore a fleet account
   *
   * An archived account gets no new invoices; its cards keep working.
   *
   * `POST /v1/fleet-accounts/{id}/archive` · needs `invoice:write`
   */
  archiveOrRestoreFleetAccount(params: {
    /** Fleet account id. */
    id: string;
    body?: ArchiveOrRestoreFleetAccountBody;
  }, options?: RequestOptions): Promise<FleetAccountDetail> {
    return this.transport.request<FleetAccountDetail>({ method: "POST", path: "/v1/fleet-accounts/{id}/archive", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Archive a site
   *
   * Marks the site archived. Refused with 400 while the site still has charge points that are not decommissioned. Audited as site.archived.
   *
   * `POST /v1/sites/{siteId}/archive` · needs `site:write`
   */
  archiveSite(params: {
    /** Site id (UUID). */
    siteId: string;
  }, options?: RequestOptions): Promise<ArchiveSiteResponse> {
    return this.transport.request<ArchiveSiteResponse>({ method: "POST", path: "/v1/sites/{siteId}/archive", pathParams: { siteId: params.siteId }, accept: "json" }, options);
  }

  /**
   * Archive a tariff
   *
   * Stops the tariff applying to new sessions from now; sessions it already priced keep it, so their invoices still reproduce. There is no delete. Returns 404 for an unknown or already archived tariff. Audited as tariff.archived.
   *
   * `POST /v1/tariffs/{id}/archive` · needs `tariff:write`
   */
  archiveTariff(params: {
    /** Tariff id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<ArchiveTariffResponse> {
    return this.transport.request<ArchiveTariffResponse>({ method: "POST", path: "/v1/tariffs/{id}/archive", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Ask a charger for a new client certificate
   *
   * ExtendedTriggerMessage(SignChargePointCertificate) on OCPP 1.6, TriggerMessage(SignChargingStationCertificate) on 2.0.1. The charger sends a CSR; PlugSure signs it and installs the certificate with CertificateSigned. The previous certificate stays accepted until the charger uses the new one.
   *
   * `POST /v1/charge-points/{identity}/certificate/request` · needs `charge_point:command`
   */
  askChargerForNewClientCertificate(params: {
    /** OCPP identity. */
    identity: string;
  }, options?: RequestOptions): Promise<AskChargerForNewClientCertificateResponse> {
    return this.transport.request<AskChargerForNewClientCertificateResponse>({ method: "POST", path: "/v1/charge-points/{identity}/certificate/request", pathParams: { identity: params.identity }, accept: "json" }, options);
  }

  /**
   * Ask a charger for a new V2G certificate
   *
   * TriggerMessage(SignV2GCertificate). The charger sends a signing request; the PKI signs it and CertificateSigned is sent back.
   *
   * `POST /v1/pnc/chargers/{identity}/request-certificate` · needs `charge_point:command`
   */
  askChargerForNewV2gCertificate(params: {
    /** OCPP identity. */
    identity: string;
  }, options?: RequestOptions): Promise<PncCommandResult> {
    return this.transport.request<PncCommandResult>({ method: "POST", path: "/v1/pnc/chargers/{identity}/request-certificate", pathParams: { identity: params.identity }, accept: "json" }, options);
  }

  /**
   * Ask the station for its device model (GetBaseReport)
   *
   * Sends GetBaseReport; the station answers with NotifyReport messages, which are stored as they arrive (the report's status moves from requested to receiving to complete). Needs charge_point:config or charge_point:command. 409 for a 1.6 or offline charger; 502 when the station does not answer.
   *
   * `POST /v1/charge-points/{identity}/device-model/report`
   */
  askStationForItsDeviceModelGetBaseReport(params: {
    /** OCPP identity of the charge point (last path segment of its WebSocket URL), e.g. AUTEL-DC60-SMB-002. */
    identity: string;
    body?: AskStationForItsDeviceModelGetBaseReportBody;
  }, options?: RequestOptions): Promise<AskStationForItsDeviceModelGetBaseReportResponse> {
    return this.transport.request<AskStationForItsDeviceModelGetBaseReportResponse>({ method: "POST", path: "/v1/charge-points/{identity}/device-model/report", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Ask the station for its variable monitors (GetMonitoringReport)
   *
   * Sends GetMonitoringReport; the NotifyMonitoringReport answer replaces the stored monitors. Same permissions and errors as the base report.
   *
   * `POST /v1/charge-points/{identity}/device-model/monitoring-report`
   */
  askStationForItsVariableMonitorsGetMonitoringReport(params: {
    /** OCPP identity of the charge point (last path segment of its WebSocket URL), e.g. AUTEL-DC60-SMB-002. */
    identity: string;
  }, options?: RequestOptions): Promise<AskStationForItsVariableMonitorsGetMonitoringReportResponse> {
    return this.transport.request<AskStationForItsVariableMonitorsGetMonitoringReportResponse>({ method: "POST", path: "/v1/charge-points/{identity}/device-model/monitoring-report", pathParams: { identity: params.identity }, accept: "json" }, options);
  }

  /**
   * Assign a tariff
   *
   * Attaches a tariff to the whole organisation, a site or a single connector, optionally only for AC or DC connectors. The tariff is re-validated against the connectors it will actually price and refused with 409 when illegal for them. Re-assigning to the same scope replaces the earlier assignment. Audited.
   *
   * `POST /v1/tariffs/{id}/assign` · needs `tariff:write`
   */
  assignTariff(params: {
    /** Tariff id (UUID). */
    id: string;
    body: AssignTariffBody;
  }, options?: RequestOptions): Promise<AssignTariffResponse> {
    return this.transport.request<AssignTariffResponse>({ method: "POST", path: "/v1/tariffs/{id}/assign", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Assign a tariff to a site
   *
   * Assigns one of your tariffs to the site, optionally for AC or DC connectors only, after checking it against the regulatory ceilings for the site's connectors. A tariff with a violation is refused with 409 and the flags; warnings are returned with a 200. Re-assigning the same tariff to the site replaces the earlier assignment. Audited as tariff.assigned.
   *
   * `PUT /v1/sites/{siteId}/tariff` · needs `tariff:write`
   */
  assignTariffToSite(params: {
    /** Site id (UUID). */
    siteId: string;
    body: TariffAssignmentRequest;
  }, options?: RequestOptions): Promise<TariffAssignmentResult> {
    return this.transport.request<TariffAssignmentResult>({ method: "PUT", path: "/v1/sites/{siteId}/tariff", pathParams: { siteId: params.siteId }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Bind the client certificate
   *
   * Binds the charger’s client-certificate SHA-256 fingerprint for Security Profile 3 (mutual TLS). Send the certificate PEM or a fingerprint; an empty fingerprint clears the binding. Only the fingerprint is stored. Audited.
   *
   * `PUT /v1/charge-points/{identity}/client-certificate` · needs `charge_point:write`
   */
  bindClientCertificate(params: {
    /** OCPP identity of the charge point (the last path segment of its WebSocket URL), e.g. `AUTEL-DC60-SMB-002`. */
    identity: string;
    body: BindClientCertificateBody;
  }, options?: RequestOptions): Promise<BindClientCertificateResponse> {
    return this.transport.request<BindClientCertificateResponse>({ method: "PUT", path: "/v1/charge-points/{identity}/client-certificate", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Cancel a contract
   *
   * The car is refused from now on (certificate status ContractCancelled).
   *
   * `POST /v1/pnc/contracts/{id}/cancel` · needs `token:write`
   */
  cancelContract(params: {
    /** Contract (token) id. */
    id: string;
  }, options?: RequestOptions): Promise<PncContract> {
    return this.transport.request<PncContract>({ method: "POST", path: "/v1/pnc/contracts/{id}/cancel", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Cancel a firmware campaign
   *
   * Cancels a scheduled or running campaign and its pending jobs; updates already sent to chargers are not recalled. Audited as firmware.campaign_cancelled.
   *
   * `POST /v1/firmware/campaigns/{id}/cancel` · needs `firmware:write`
   */
  cancelFirmwareCampaign(params: {
    /** Campaign id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<CancelFirmwareCampaignResponse> {
    return this.transport.request<CancelFirmwareCampaignResponse>({ method: "POST", path: "/v1/firmware/campaigns/{id}/cancel", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Cancel a membership
   *
   * Benefits stop now. A membership billed on the fleet invoice is billed for the days of that month it was in force (as it is for a membership started mid-month).
   *
   * `POST /v1/subscriptions/{id}/cancel` · needs `tariff:write`
   */
  cancelMembership(params: {
    /** Subscription id. */
    id: string;
  }, options?: RequestOptions): Promise<Subscription> {
    return this.transport.request<Subscription>({ method: "POST", path: "/v1/subscriptions/{id}/cancel", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Card holds and post-pay e-wallet charges
   *
   * Card payments taken as holds (Integrations → Payments → "hold, then charge only what is used"): held while charging, captured for the rated total when the session ends (the rest released at once), or released when unused. Post-pay sessions with linked e-wallets are listed too (kind postpay): nothing held at the start, the rated total charged to the e-wallet at the end, the same retries. Failed captures and releases come first, with the acquirer's error and the next automatic retry; captured and released holds of the last 14 days follow. At most 200 rows.
   *
   * `GET /v1/card-holds` · needs `payment:read`
   */
  cardHoldsAndPostPayEWalletCharges(options?: RequestOptions): Promise<CardHoldsAndPostPayEWalletChargesResponse> {
    return this.transport.request<CardHoldsAndPostPayEWalletChargesResponse>({ method: "GET", path: "/v1/card-holds", accept: "json" }, options);
  }

  /**
   * Change an API key’s name or rate limit
   *
   * Sets the key’s own rate limit (requests a minute; null returns it to the installation default) or renames it. A new limit applies from the key’s next request. Revoked keys cannot be changed (404). Audited as api_key.updated.
   *
   * `PATCH /v1/api-keys/{id}` · needs `org:write`
   */
  changeApiKeyNameOrRateLimit(params: {
    /** API key id (UUID). */
    id: string;
    body: ChangeApiKeyNameOrRateLimitBody;
  }, options?: RequestOptions): Promise<ApiKey> {
    return this.transport.request<ApiKey>({ method: "PATCH", path: "/v1/api-keys/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Change a configuration key
   *
   * Sends ChangeConfiguration to the charger and records the answer; the stored value changes only when the charger accepts. Needs charge_point:config or charge_point:command. SecurityProfile and AuthorizationKey are refused (use the keys endpoint), as are invalid values for catalogue keys and keys the charger reports as read-only (400). Returns 409 when the charger is offline.
   *
   * `PUT /v1/charge-points/{identity}/config` · needs `charge_point:read`, `charge_point:config`, `charge_point:command`
   */
  changeConfigurationKey(params: {
    /** OCPP identity of the charge point (last path segment of its WebSocket URL), e.g. AUTEL-DC60-SMB-002. */
    identity: string;
    body: ConfigChangeRequest;
  }, options?: RequestOptions): Promise<ConfigChangeResult> {
    return this.transport.request<ConfigChangeResult>({ method: "PUT", path: "/v1/charge-points/{identity}/config", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Change connector availability
   *
   * Sends ChangeAvailability for one connector (or the whole station with connectorId 0) and records the maintenance reason on the connector. Taking a connector out of service (`Inoperative`) requires a reason. Audited as charge_point.availability_changed.
   *
   * `POST /v1/charge-points/{identity}/availability` · needs `charge_point:command`
   */
  changeConnectorAvailability(params: {
    /** OCPP identity of the charge point (the last path segment of its WebSocket URL), e.g. `AUTEL-DC60-SMB-002`. */
    identity: string;
    body: ChangeConnectorAvailabilityBody;
  }, options?: RequestOptions): Promise<CommandResult> {
    return this.transport.request<CommandResult>({ method: "POST", path: "/v1/charge-points/{identity}/availability", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Change a fleet account's cards
   *
   * Adds cards (by UID) to the account — they become fleet cards with its fleet name — and removes others. UIDs that are not registered cards are returned in `unknown`.
   *
   * `PUT /v1/fleet-accounts/{id}/cards` · needs `invoice:write`, `token:write`
   */
  changeFleetAccountCards(params: {
    /** Fleet account id. */
    id: string;
    body: ChangeFleetAccountCardsBody;
  }, options?: RequestOptions): Promise<ChangeFleetAccountCardsResponse> {
    return this.transport.request<ChangeFleetAccountCardsResponse>({ method: "PUT", path: "/v1/fleet-accounts/{id}/cards", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Chargers and their V2G certificates
   *
   * **Permissions checked:** `charge_point:read`.
   *
   * `GET /v1/pnc/chargers` · needs `charge_point:read`
   */
  chargersAndTheirV2gCertificates(options?: RequestOptions): Promise<ChargersAndTheirV2gCertificatesResponse> {
    return this.transport.request<ChargersAndTheirV2gCertificatesResponse>({ method: "GET", path: "/v1/pnc/chargers", accept: "json" }, options);
  }

  /**
   * Chargers being onboarded
   *
   * Chargers registered in the last 90 days, with where each one is: waiting for its first connection, refused at the handshake (with the reason), connected but not yet activated, getting its certificate, or connected.
   *
   * `GET /v1/onboarding` · needs `charge_point:read`
   */
  chargersBeingOnboarded(options?: RequestOptions): Promise<ChargersBeingOnboardedResponse> {
    return this.transport.request<ChargersBeingOnboardedResponse>({ method: "GET", path: "/v1/onboarding", accept: "json" }, options);
  }

  /**
   * Chargers' client certificates
   *
   * Every charger with a client certificate, on Profile 3, or getting one: where the certificate came from, its serial and expiry, and the latest request. Certificates from PlugSure's CA are renewed over OCPP before they expire, with an alert two weeks before.
   *
   * `GET /v1/station-certificates` · needs `charge_point:read`
   */
  chargersClientCertificates(options?: RequestOptions): Promise<ChargersClientCertificatesResponse> {
    return this.transport.request<ChargersClientCertificatesResponse>({ method: "GET", path: "/v1/station-certificates", accept: "json" }, options);
  }

  /**
   * The charging-station CA
   *
   * The CA that issues chargers' client certificates (Security Profile 3), created on first use. The TLS terminator must trust it; the answer includes a Caddy snippet.
   *
   * `GET /v1/charger-ca` · needs `charge_point:read`
   */
  chargingStationCa(options?: RequestOptions): Promise<ChargerCa> {
    return this.transport.request<ChargerCa>({ method: "GET", path: "/v1/charger-ca", accept: "json" }, options);
  }

  /**
   * Check charging-profile drift
   *
   * Asks an online charger (GetCompositeSchedule) what limits it is enforcing and compares them with the accepted profiles on record. Returns zeros when the charger is offline or its model’s composite schedule is not trusted.
   *
   * `GET /v1/charge-points/{identity}/profiles/reconcile` · needs `smartcharging:read`
   */
  checkChargingProfileDrift(params: {
    /** OCPP identity of the charge point (the last path segment of its WebSocket URL), e.g. `AUTEL-DC60-SMB-002`. */
    identity: string;
  }, options?: RequestOptions): Promise<CheckChargingProfileDriftResponse> {
    return this.transport.request<CheckChargingProfileDriftResponse>({ method: "GET", path: "/v1/charge-points/{identity}/profiles/reconcile", pathParams: { identity: params.identity }, accept: "json" }, options);
  }

  /**
   * Check the iOS notifications key with Apple again
   *
   * Asks APNs about a device token that cannot exist: Apple checks the key first, so nobody is notified.
   *
   * `POST /v1/driver-app/apns/check` · needs `org:write`
   */
  checkIOSNotificationsKeyWithAppleAgain(options?: RequestOptions): Promise<DriverAppView> {
    return this.transport.request<DriverAppView>({ method: "POST", path: "/v1/driver-app/apns/check", accept: "json" }, options);
  }

  /**
   * Clear the authorisation cache
   *
   * Sends ClearCache so the charger forgets locally cached idTag authorisations. Audited.
   *
   * `POST /v1/charge-points/{identity}/clear-cache` · needs `charge_point:command`
   */
  clearAuthorisationCache(params: {
    /** OCPP identity of the charge point (the last path segment of its WebSocket URL), e.g. `AUTEL-DC60-SMB-002`. */
    identity: string;
  }, options?: RequestOptions): Promise<CommandResult> {
    return this.transport.request<CommandResult>({ method: "POST", path: "/v1/charge-points/{identity}/clear-cache", pathParams: { identity: params.identity }, accept: "json" }, options);
  }

  /**
   * Clear review and bill a session
   *
   * Clears a session’s review flag and rates it, issuing the CDR. When the tariff still cannot price it the answer is `ok: false` with the reason; `force: true` bills it as rated anyway. Audited as session.review_cleared, or session.rated_under_override when forced.
   *
   * `POST /v1/sessions/{id}/rerate` · needs `session:write`
   */
  clearReviewAndBillSession(params: {
    /** Session id (UUID). */
    id: string;
    body: ClearReviewAndBillSessionBody;
  }, options?: RequestOptions): Promise<SessionRerateResult> {
    return this.transport.request<SessionRerateResult>({ method: "POST", path: "/v1/sessions/{id}/rerate", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Connect or change an integration
   *
   * Saves the provider, its settings and (sealed with SECRETS_KEY) its secrets. Payments: the operator's own merchant account (org:write), or the platform default (platform:admin); settings.methods chooses the payment methods drivers may use among those the acquirer offers (QRIS, GOPAY, SHOPEEPAY, OVO, DANA, LINKAJA, CARD; at least one; default QRIS). The other kinds are platform-wide (platform:admin). Test doubles are refused in production. Audited as integration.updated, without secret values.
   *
   * `PUT /v1/integrations/{kind}`
   */
  connectOrChangeIntegration(params: {
    /** Integration: payments (the acquirer: QRIS, e-wallets, cards), otp (driver sign-in codes), otp_fallback, pnc_pki (Plug & Charge PKI) or map_tiles. */
    kind: string;
    body: IntegrationInput;
  }, options?: RequestOptions): Promise<ConnectOrChangeIntegrationResponse> {
    return this.transport.request<ConnectOrChangeIntegrationResponse>({ method: "PUT", path: "/v1/integrations/{kind}", pathParams: { kind: params.kind }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Connect to a roaming partner
   *
   * Runs the OCPI 2.2.1 credentials handshake with a partner using the versions URL and token it gave us, then publishes our locations, tariffs and shared cards to it (and imports its network, for a CPO) after the response. Any failure of the handshake answers 502 with the reason. Audited as roaming.partner_connected.
   *
   * `POST /v1/roaming/partners/{id}/connect` · needs `roaming:write`
   */
  connectToRoamingPartner(params: {
    /** Roaming partner id (UUID). */
    id: string;
    body: ConnectToRoamingPartnerBody;
  }, options?: RequestOptions): Promise<RoamingPartner> {
    return this.transport.request<RoamingPartner>({ method: "POST", path: "/v1/roaming/partners/{id}/connect", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Create an alert contact
   *
   * A person who can be notified, by e-mail, WhatsApp or both. Audited.
   *
   * `POST /v1/alert-routing/contacts` · needs `alert:write`
   */
  createAlertContact(params: {
    body: AlertRoutingContactInput;
  }, options?: RequestOptions): Promise<CreateAlertContactResponse> {
    return this.transport.request<CreateAlertContactResponse>({ method: "POST", path: "/v1/alert-routing/contacts", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Create an alert rule
   *
   * Which alerts go to whom: minimum severity, kinds, sites, channels and contacts, quiet hours (non-critical messages wait until they end), resolved notices and escalation when an alert stays unacknowledged. Audited.
   *
   * `POST /v1/alert-routing/rules` · needs `alert:write`
   */
  createAlertRule(params: {
    body: AlertRoutingRuleInput;
  }, options?: RequestOptions): Promise<CreateAlertRuleResponse> {
    return this.transport.request<CreateAlertRuleResponse>({ method: "POST", path: "/v1/alert-routing/rules", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Create a developer sandbox
   *
   * Creates a separate sandbox tenant: a Jakarta site, a 60 kW DC charger with two connectors and a 22 kW AC charger (both virtual, simulated by the gateway), a legal tariff, three RFID cards (one blocked), and an API key with full operator rights inside the sandbox only. The key is returned once. At most 3 sandboxes per operator. A sandbox cannot itself create sandboxes.
   *
   * `POST /v1/sandboxes` · needs `org:write`
   */
  createDeveloperSandbox(params: {
    body: CreateDeveloperSandboxBody;
  }, options?: RequestOptions): Promise<SandboxCreated> {
    return this.transport.request<SandboxCreated>({ method: "POST", path: "/v1/sandboxes", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Create a firmware campaign
   *
   * Creates a job for each targeted charge point (fleet and site targets skip decommissioned and pending units). Refused with 422 when the input is invalid, the image is missing or archived, nothing matches, or any target is not a compatible model for the image. The scheduler dispatches jobs within about 30 seconds, only inside the maintenance window and only to online chargers. Audited as firmware.campaign_created.
   *
   * `POST /v1/firmware/campaigns` · needs `firmware:write`
   */
  createFirmwareCampaign(params: {
    body: CampaignRequest;
  }, options?: RequestOptions): Promise<CampaignCreated> {
    return this.transport.request<CampaignCreated>({ method: "POST", path: "/v1/firmware/campaigns", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Create a fleet account
   *
   * **Permissions checked:** `invoice:write`.
   *
   * `POST /v1/fleet-accounts` · needs `invoice:write`
   */
  createFleetAccount(params: {
    body: FleetAccountInput;
  }, options?: RequestOptions): Promise<FleetAccountDetail> {
    return this.transport.request<FleetAccountDetail>({ method: "POST", path: "/v1/fleet-accounts", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Create a membership plan
   *
   * With `offeredInApp`, drivers can buy it in the app as a 30-day pass (QRIS, e-wallet or card), renewed by hand or automatically with a saved card or linked e-wallet. A driver switching to another plan has the unused days of the current pass credited.
   *
   * `POST /v1/subscription-plans` · needs `tariff:write`
   */
  createMembershipPlan(params: {
    body: SubscriptionPlanInput;
  }, options?: RequestOptions): Promise<SubscriptionPlan> {
    return this.transport.request<SubscriptionPlan>({ method: "POST", path: "/v1/subscription-plans", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Create an on-call rota
   *
   * Who is on duty: alert contacts taking daily or weekly shifts in turn, handing over at a local time; the first shift starts on `startsOn` with the first member. Rules (`rotaIds`) and escalations (`escalateRotaIds`) notify whoever is on duty when the alert is routed. Audited.
   *
   * `POST /v1/alert-routing/rotas` · needs `alert:write`
   */
  createOnCallRota(params: {
    body: AlertRotaInput;
  }, options?: RequestOptions): Promise<CreateOnCallRotaResponse> {
    return this.transport.request<CreateOnCallRotaResponse>({ method: "POST", path: "/v1/alert-routing/rotas", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Create or change the driver app
   *
   * Fields left out keep their value. The app shows only this operator’s stations. `status: live` needs an icon and a web address, which must point at PlugSure. The version code can only go up (the stores refuse an older one). 409 when another operator uses the web address, package name or bundle identifier, or in a sandbox.
   *
   * `PUT /v1/driver-app` · needs `org:write`
   */
  createOrChangeDriverApp(params: {
    body: CreateOrChangeDriverAppBody;
  }, options?: RequestOptions): Promise<DriverAppView> {
    return this.transport.request<DriverAppView>({ method: "PUT", path: "/v1/driver-app", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Create a promotion
   *
   * An offer (% off energy, a promo price per kWh, rupiah off, free kWh or service fee waived) for everyone, new drivers, chosen fleet accounts, members of chosen plans, or whoever enters its code in the app — limited by dates, days of the week, a time window (happy hour), sites, AC/DC, a minimum kWh, total and per-customer uses, and a budget.
   *
   * `POST /v1/promotions` · needs `tariff:write`
   */
  createPromotion(params: {
    body: PromotionInput;
  }, options?: RequestOptions): Promise<Promotion> {
    return this.transport.request<Promotion>({ method: "POST", path: "/v1/promotions", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Create a QRIS pre-purchase
   *
   * Creates a QRIS payment for a fixed amount of charging on one connector and quotes the energy it buys against the most expensive block the session could reach. The payment can only be claimed by `startToken` (the driver’s own token, or one minted here for a walk-up). Refused with 409 when the connector’s meter verification has lapsed or is pending, and 422 when the amount does not cover the fixed fees. Maximum Rp 10,000,000.
   *
   * `POST /v1/checkout/qris` · needs `payment:write`
   */
  createQrisPrePurchase(params: {
    body: CreateQrisPrePurchaseBody;
  }, options?: RequestOptions): Promise<CheckoutQrisResult> {
    return this.transport.request<CheckoutQrisResult>({ method: "POST", path: "/v1/checkout/qris", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Create a roaming partner
   *
   * Creates a partner connection in `pending` and returns the credentials token (token A) to hand to the partner with our versions URL. Requires the roaming identity to be set (409 otherwise). Audited as roaming.partner_created.
   *
   * `POST /v1/roaming/partners` · needs `roaming:write`
   */
  createRoamingPartner(params: {
    body: CreateRoamingPartnerBody;
  }, options?: RequestOptions): Promise<CreateRoamingPartnerResponse> {
    return this.transport.request<CreateRoamingPartnerResponse>({ method: "POST", path: "/v1/roaming/partners", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Create a site
   *
   * Creates a site after validating it against PLN and regulatory rules; invalid input is refused with 422 (the body lists every field error and the warnings). When connectedKva is given, a load-management budget at the subscription ceiling is created too. Audited as site.created.
   *
   * `POST /v1/sites` · needs `site:write`
   */
  createSite(params: {
    body: SiteInput;
  }, options?: RequestOptions): Promise<SiteSaved> {
    return this.transport.request<SiteSaved>({ method: "POST", path: "/v1/sites", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Create a site owner
   *
   * Adds a business that owns sites (hotel, mall, office). Assign sites with PUT /v1/owners/:id/sites. Audited.
   *
   * `POST /v1/owners` · needs `site:write`
   */
  createSiteOwner(params: {
    body: OwnerInput;
  }, options?: RequestOptions): Promise<CreateSiteOwnerResponse> {
    return this.transport.request<CreateSiteOwnerResponse>({ method: "POST", path: "/v1/owners", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Create a tariff
   *
   * Creates a tariff after checking it against the regulatory ceilings for connectors of `appliesToMaxPowerW`. A tariff with a violation is not saved (422, with flags). Surcharging the QRIS MDR to the driver is prohibited, so any `mdrMode` other than `absorb` is refused (422). Audited as tariff.created.
   *
   * `POST /v1/tariffs` · needs `tariff:write`
   */
  createTariff(params: {
    body: CreateTariffBody;
  }, options?: RequestOptions): Promise<CreateTariffResponse> {
    return this.transport.request<CreateTariffResponse>({ method: "POST", path: "/v1/tariffs", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Create a webhook endpoint
   *
   * Registers a URL to receive signed event deliveries (`PlugSure-Signature: t=<unix>,v1=<HMAC-SHA256>`). The signing secret is returned once, in this response, and can never be read again — only rotated. Audited.
   *
   * `POST /v1/webhooks` · needs `webhook:write`
   */
  createWebhookEndpoint(params: {
    body: WebhookEndpointInput;
  }, options?: RequestOptions): Promise<CreateWebhookEndpointResponse> {
    return this.transport.request<CreateWebhookEndpointResponse>({ method: "POST", path: "/v1/webhooks", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Curtail or release a site
   *
   * Curtailing (for a genset or grid outage) sends 0 W station limits to every charger at the site; releasing restores the normal allocation. The change is saved first and dispatched right after the response, so a dispatch failure never undoes it. Audited as site.curtailed or site.curtailment_lifted.
   *
   * `POST /v1/sites/{siteId}/power/curtail` · needs `smartcharging:write`
   */
  curtailOrReleaseSite(params: {
    /** Site id (UUID). */
    siteId: string;
    body: CurtailRequest;
  }, options?: RequestOptions): Promise<CurtailResult> {
    return this.transport.request<CurtailResult>({ method: "POST", path: "/v1/sites/{siteId}/power/curtail", pathParams: { siteId: params.siteId }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Decommission a charge point
   *
   * Sets the status to decommissioned and clears its AuthorizationKey (current and previous) and client-certificate binding, so it can no longer connect. Refused with 400 while a session is in progress. The optional reason is recorded in the audit entry charge_point.decommissioned.
   *
   * `POST /v1/charge-points/{identity}/decommission` · needs `charge_point:write`
   */
  decommissionChargePoint(params: {
    /** OCPP identity of the charge point (last path segment of its WebSocket URL), e.g. AUTEL-DC60-SMB-002. */
    identity: string;
    body?: DecommissionChargePointBody;
  }, options?: RequestOptions): Promise<DecommissionChargePointResponse> {
    return this.transport.request<DecommissionChargePointResponse>({ method: "POST", path: "/v1/charge-points/{identity}/decommission", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Delete an alert contact
   *
   * Deletes the contact and removes it from every rule (as recipient and as escalation contact). Audited.
   *
   * `DELETE /v1/alert-routing/contacts/{id}` · needs `alert:write`
   */
  deleteAlertContact(params: {
    /** Contact id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<DeleteAlertContactResponse> {
    return this.transport.request<DeleteAlertContactResponse>({ method: "DELETE", path: "/v1/alert-routing/contacts/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Delete an alert rule
   *
   * Deletes the rule. Messages already in the log keep their history. Audited.
   *
   * `DELETE /v1/alert-routing/rules/{id}` · needs `alert:write`
   */
  deleteAlertRule(params: {
    /** Rule id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<DeleteAlertRuleResponse> {
    return this.transport.request<DeleteAlertRuleResponse>({ method: "DELETE", path: "/v1/alert-routing/rules/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Delete a certificate from a charger
   *
   * **Permissions checked:** `charge_point:command`.
   *
   * `POST /v1/pnc/chargers/{identity}/delete-certificate` · needs `charge_point:command`
   */
  deleteCertificateFromCharger(params: {
    /** OCPP identity. */
    identity: string;
    body: DeleteCertificateFromChargerBody;
  }, options?: RequestOptions): Promise<PncCommandResult> {
    return this.transport.request<PncCommandResult>({ method: "POST", path: "/v1/pnc/chargers/{identity}/delete-certificate", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Delete an on-call rota
   *
   * Deletes the rota and its overrides, and takes it out of every rule. Audited.
   *
   * `DELETE /v1/alert-routing/rotas/{id}` · needs `alert:write`
   */
  deleteOnCallRota(params: {
    /** Rota id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<DeleteOnCallRotaResponse> {
    return this.transport.request<DeleteOnCallRotaResponse>({ method: "DELETE", path: "/v1/alert-routing/rotas/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Delete a sandbox
   *
   * Revokes its keys, stops its virtual chargers and archives the tenant. Its data stays for the audit trail.
   *
   * `DELETE /v1/sandboxes/{id}` · needs `org:write`
   */
  deleteSandbox(params: {
    /** Sandbox id. */
    id: string;
  }, options?: RequestOptions): Promise<DeleteSandboxResponse> {
    return this.transport.request<DeleteSandboxResponse>({ method: "DELETE", path: "/v1/sandboxes/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Delete a webhook endpoint
   *
   * Deletes the endpoint and its delivery history. Audited.
   *
   * `DELETE /v1/webhooks/{id}` · needs `webhook:write`
   */
  deleteWebhookEndpoint(params: {
    /** Webhook endpoint id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<DeleteWebhookEndpointResponse> {
    return this.transport.request<DeleteWebhookEndpointResponse>({ method: "DELETE", path: "/v1/webhooks/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Describe this sandbox
   *
   * Called with a sandbox key: the sandbox, its virtual chargers with what each simulator reports right now, its RFID cards, the events that can be simulated, and the time scale (energy accrues 30× faster than the wall clock). 404 with a production key.
   *
   * `GET /v1/sandbox` · needs `charge_point:read`
   */
  describeThisSandbox(options?: RequestOptions): Promise<DescribeThisSandboxResponse> {
    return this.transport.request<DescribeThisSandboxResponse>({ method: "GET", path: "/v1/sandbox", accept: "json" }, options);
  }

  /**
   * Disconnect a roaming partner
   *
   * Closes the connection: tells a connected partner (DELETE on its credentials endpoint), revokes both tokens and fails every pending call to it. Audited as roaming.partner_disconnected.
   *
   * `DELETE /v1/roaming/partners/{id}` · needs `roaming:write`
   */
  disconnectRoamingPartner(params: {
    /** Roaming partner id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<DisconnectRoamingPartnerResponse> {
    return this.transport.request<DisconnectRoamingPartnerResponse>({ method: "DELETE", path: "/v1/roaming/partners/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Download the charging-station CA certificate
   *
   * **Permissions checked:** `charge_point:read`.
   *
   * `GET /v1/charger-ca/ca.pem` · needs `charge_point:read`
   */
  downloadChargingStationCaCertificate(options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/charger-ca/ca.pem", accept: "text" }, options);
  }

  /**
   * Download a credit note as PDF
   *
   * The credit note as an A4 PDF: the invoice it credits, the reason, the lines with DPP and PPN, and how it is settled.
   *
   * `GET /v1/fleet-credit-notes/{id}/credit-note.pdf` · needs `invoice:read`
   */
  downloadCreditNoteAsPdf(params: {
    /** Credit note id. */
    id: string;
  }, options?: RequestOptions): Promise<ArrayBuffer> {
    return this.transport.request<ArrayBuffer>({ method: "GET", path: "/v1/fleet-credit-notes/{id}/credit-note.pdf", pathParams: { id: params.id }, accept: "binary" }, options);
  }

  /**
   * Download a fleet invoice as PDF
   *
   * The invoice as an A4 PDF: seller and buyer, the lines per site with DPP and PPN, partner networks and memberships, credits and the amount due, how to pay, and an appendix with every card and session.
   *
   * `GET /v1/fleet-invoices/{id}/invoice.pdf` · needs `invoice:read`
   */
  downloadFleetInvoiceAsPdf(params: {
    /** Invoice id. */
    id: string;
  }, options?: RequestOptions): Promise<ArrayBuffer> {
    return this.transport.request<ArrayBuffer>({ method: "GET", path: "/v1/fleet-invoices/{id}/invoice.pdf", pathParams: { id: params.id }, accept: "binary" }, options);
  }

  /**
   * Download a fleet invoice's session list
   *
   * **Permissions checked:** `invoice:read`.
   *
   * `GET /v1/fleet-invoices/{id}/invoice.csv` · needs `invoice:read`
   */
  downloadFleetInvoiceSessionList(params: {
    /** Invoice id. */
    id: string;
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/fleet-invoices/{id}/invoice.csv", pathParams: { id: params.id }, accept: "text" }, options);
  }

  /**
   * Download a monthly statement as PDF
   *
   * The month as a PDF: the invoice once issued, otherwise the draft (marked as a draft).
   *
   * `GET /v1/fleet-accounts/{id}/statement.pdf` · needs `invoice:read`
   */
  downloadMonthlyStatementAsPdf(params: {
    /** Fleet account id. */
    id: string;
    query: {
      /** Month, YYYY-MM. */
      period: string;
    };
  }, options?: RequestOptions): Promise<ArrayBuffer> {
    return this.transport.request<ArrayBuffer>({ method: "GET", path: "/v1/fleet-accounts/{id}/statement.pdf", pathParams: { id: params.id }, query: params.query, accept: "binary" }, options);
  }

  /**
   * Download signed meter data for the Transparency Software
   *
   * The session’s signed values with the meter’s public key, as an XML file to open in the S.A.F.E. Transparency Software (404 when there are none).
   *
   * `GET /v1/sessions/{id}/signed-data.xml` · needs `session:read`
   */
  downloadSignedMeterDataForTransparencySoftware(params: {
    /** Session id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/sessions/{id}/signed-data.xml", pathParams: { id: params.id }, accept: "text" }, options);
  }

  /**
   * Download a statement as CSV
   *
   * The same statement as GET /v1/billing/statement, one row per charger, as a UTF-8 CSV (with BOM) sent as an attachment named plugsure-statement-<org>-<YYYY-MM>.csv.
   *
   * `GET /v1/billing/statement.csv` · needs `invoice:read`
   */
  downloadStatementAsCsv(params?: {
    query?: {
      /** Statement month, YYYY-MM. Defaults to the current month in the billing time zone (Asia/Jakarta). Anything else is a 400. */
      month?: string;
      /** A site owner of the organisation (UUID). */
      ownerId?: string;
    };
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/billing/statement.csv", query: params?.query, accept: "text" }, options);
  }

  /**
   * Download the store build kit
   *
   * A zip with everything to build and list the app: an Android Trusted Web Activity project for Bubblewrap with launcher icons, Digital Asset Links and a CI workflow; an iOS Capacitor shell with the App Store icon, Info.plist and entitlement additions and the app-site association; and store listing texts (Indonesian, English) with data-safety answers. The `x-kit-warnings` header counts what is still missing (listed in the kit’s README).
   *
   * `GET /v1/driver-app/kit` · needs `org:read`
   */
  downloadStoreBuildKit(options?: RequestOptions): Promise<ArrayBuffer> {
    return this.transport.request<ArrayBuffer>({ method: "GET", path: "/v1/driver-app/kit", accept: "binary" }, options);
  }

  /**
   * Download an uploaded diagnostics file
   *
   * Returns the file exactly as the charger uploaded it, as an attachment. Returns 404 while no file has been received.
   *
   * `GET /v1/diagnostics/{id}/download` · needs `charge_point:read`
   */
  downloadUploadedDiagnosticsFile(params: {
    /** Diagnostics request id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<ArrayBuffer> {
    return this.transport.request<ArrayBuffer>({ method: "GET", path: "/v1/diagnostics/{id}/download", pathParams: { id: params.id }, accept: "binary" }, options);
  }

  /**
   * E-mail a credit note
   *
   * Sends the credit note (PDF) to the account's billing e-mail (or `to`) through the organisation's e-mail channel.
   *
   * `POST /v1/fleet-credit-notes/{id}/send` · needs `invoice:write`
   */
  eMailCreditNote(params: {
    /** Credit note id. */
    id: string;
    body?: EMailCreditNoteBody;
  }, options?: RequestOptions): Promise<EMailCreditNoteResponse> {
    return this.transport.request<EMailCreditNoteResponse>({ method: "POST", path: "/v1/fleet-credit-notes/{id}/send", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * E-mail a fleet invoice
   *
   * Sends the invoice to the account's billing e-mail (or `to`) through the organisation's e-mail channel (Govern → Alert routing), with the invoice (PDF) and the session list (CSV) attached.
   *
   * `POST /v1/fleet-invoices/{id}/send` · needs `invoice:write`
   */
  eMailFleetInvoice(params: {
    /** Invoice id. */
    id: string;
    body?: EMailFleetInvoiceBody;
  }, options?: RequestOptions): Promise<EMailFleetInvoiceResponse> {
    return this.transport.request<EMailFleetInvoiceResponse>({ method: "POST", path: "/v1/fleet-invoices/{id}/send", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Enrol a member
   *
   * A fleet account (every card on it) or one card, billed on the monthly fleet invoice or complimentary. A card on no fleet account can only be complimentary. One live membership per subscriber. App drivers subscribe themselves in the app.
   *
   * `POST /v1/subscriptions` · needs `tariff:write`
   */
  enrolMember(params: {
    body: EnrolMemberBody;
  }, options?: RequestOptions): Promise<Subscription> {
    return this.transport.request<Subscription>({ method: "POST", path: "/v1/subscriptions", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Export charges on other networks as CSV
   *
   * Every charge record partners sent for our cards in the range, as a CSV attachment (columns start, end, partner, operator, location, city, card, contract_id, holder, fleet, kwh, currency, total_excl_vat, total_incl_vat, cdr_id, session_id).
   *
   * `GET /v1/roaming/abroad.csv` · needs `roaming:read`
   */
  exportChargesOnOtherNetworksAsCsv(params?: {
    query?: {
      /** Charge records that ended at or after this instant (ignored when not a date). */
      from?: string;
      /** Charge records that ended before this instant (ignored when not a date). */
      to?: string;
    };
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/roaming/abroad.csv", query: params?.query, accept: "text" }, options);
  }

  /**
   * Export e-Faktur (Coretax XML) for a month
   *
   * The bulk-import XML for DJP Coretax (Faktur Pajak → Impor Data): one faktur per live invoice with PPN, transaction code 04 (PPN 12% on DPP nilai lain), one line per site. Refused (409) until the seller NPWP/NITKU and the e-Faktur item settings are saved and confirmed. Invoices whose buyer has no NPWP/NIK are skipped; the included and skipped invoices are in the X-PlugSure-Included and X-PlugSure-Skipped headers. Import, check the drafts in Coretax, then approve there.
   *
   * `GET /v1/fleet-billing/periods/{period}/efaktur.xml` · needs `invoice:write`
   */
  exportEFakturCoretaxXmlForMonth(params: {
    /** Month, YYYY-MM. */
    period: string;
    query?: {
      /** Comma-separated invoice ids (default: all of the month). */
      ids?: string;
    };
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/fleet-billing/periods/{period}/efaktur.xml", pathParams: { period: params.period }, query: params.query, accept: "text" }, options);
  }

  /**
   * Export OCPP frames as NDJSON
   *
   * Downloads up to 50,000 frames for one charge point, oldest first, one JSON object per line (same fields as the frame list). Same access rule as the frame list.
   *
   * `GET /v1/charge-points/{identity}/frames.ndjson` · needs `charge_point:read`
   */
  exportOcppFramesAsNdjson(params: {
    /** OCPP identity of the charge point (the last path segment of its WebSocket URL), e.g. `AUTEL-DC60-SMB-002`. */
    identity: string;
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/charge-points/{identity}/frames.ndjson", pathParams: { identity: params.identity }, accept: "text" }, options);
  }

  /**
   * Export sessions as CSV
   *
   * Downloads up to 50,000 matching sessions as UTF-8 CSV with a byte-order mark (for Excel), including the tax breakdown. Cells that start with a formula character are prefixed to prevent formula injection; site-scoped users get masked cards. Each export is audited as session.exported.
   *
   * `GET /v1/sessions.csv` · needs `session:export`, `session:read`
   */
  exportSessionsAsCsv(params?: {
    query?: {
      /** Sessions that started at or after this instant (any date or date-time Date() can parse). */
      from?: string;
      /** Sessions that started before this instant. */
      to?: string;
      /** Only sessions at this site (UUID). */
      siteId?: string;
      /** Only sessions on this charge point (OCPP identity). */
      identity?: string;
      /** AC or DC (current type), or a plug code such as cCCS2 or sType2. */
      connectorType?: string;
      /** Derived payment status. */
      paymentStatus?: "paid" | "invoiced" | "pending" | "unbilled" | "review" | "in_progress" | "failed" | "refunded" | "free" | "held" | "released";
      /** Session state (active, ended, rated, settled, disputed). */
      state?: string;
      /** Session id, OCPP transaction id or card UID. Org-wide users get a substring match on the card UID; site-scoped users only whole-value matches. */
      q?: string;
    };
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/sessions.csv", query: params?.query, accept: "text" }, options);
  }

  /**
   * Fetch the PKI's root certificates
   *
   * **Permissions checked:** `org:write`.
   *
   * `POST /v1/pnc/trust-anchors/sync` · needs `org:write`
   */
  fetchPkiRootCertificates(options?: RequestOptions): Promise<FetchPkiRootCertificatesResponse> {
    return this.transport.request<FetchPkiRootCertificatesResponse>({ method: "POST", path: "/v1/pnc/trust-anchors/sync", accept: "json" }, options);
  }

  /**
   * Finalise a site owner's statement
   *
   * Freezes the owner's statement for a month that has ended and gives it a number. A finalised statement never changes. Audited.
   *
   * `POST /v1/billing/owners/{id}/finalise` · needs `invoice:write`
   */
  finaliseSiteOwnerStatement(params: {
    /** Site owner id (UUID) of the caller's organisation. */
    id: string;
    body: BillingFinaliseInput;
  }, options?: RequestOptions): Promise<BillingFinalised> {
    return this.transport.request<BillingFinalised>({ method: "POST", path: "/v1/billing/owners/{id}/finalise", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Get alert routing settings
   *
   * E-mail, WhatsApp and SMS channel settings, contacts, rules and on-call rotas (with who is on duty now), the alert kinds rules can match, and the time zone used for quiet hours and rota handovers. Channel secrets (SMTP password, WhatsApp token and app secret, SMS credential) are never returned; `has_secret` says whether one is stored.
   *
   * `GET /v1/alert-routing` · needs `alert:read`
   */
  getAlertRoutingSettings(options?: RequestOptions): Promise<GetAlertRoutingSettingsResponse> {
    return this.transport.request<GetAlertRoutingSettingsResponse>({ method: "GET", path: "/v1/alert-routing", accept: "json" }, options);
  }

  /**
   * Get an API key’s usage by hour
   *
   * Requests made with the key per hour, oldest first, with how many were refused for the rate limit or answered with another error. Hours without requests are left out.
   *
   * `GET /v1/api-keys/{id}/usage` · needs `org:read`
   */
  getApiKeyUsageByHour(params: {
    /** API key id (UUID). */
    id: string;
    query?: {
      /** How far back, in hours (1 to 744; default 48). */
      hours?: number;
    };
  }, options?: RequestOptions): Promise<ApiKeyUsageHour[]> {
    return this.transport.request<ApiKeyUsageHour[]>({ method: "GET", path: "/v1/api-keys/{id}/usage", pathParams: { id: params.id }, query: params.query, accept: "json" }, options);
  }

  /**
   * Get the audit log
   *
   * The organisation’s 200 most recent audit entries, newest first, and a verification of the whole hash chain (detects edits, deletions and truncation).
   *
   * `GET /v1/audit` · needs `audit:read`
   */
  getAuditLog(options?: RequestOptions): Promise<GetAuditLogResponse> {
    return this.transport.request<GetAuditLogResponse>({ method: "GET", path: "/v1/audit", accept: "json" }, options);
  }

  /**
   * Get billing across site owners
   *
   * Every site owner's month — charging units, gross, taxes, commission base, the owner's and the operator's shares, statement status — plus the operator's own sites and totals. Computes a statement per owner, so it can be slow for many owners.
   *
   * `GET /v1/billing/owners` · needs `invoice:read`
   */
  getBillingAcrossSiteOwners(params?: {
    query?: {
      /** Statement month, YYYY-MM. Defaults to the current month in the billing time zone (Asia/Jakarta). Anything else is a 400. */
      month?: string;
    };
  }, options?: RequestOptions): Promise<BillingOwnersOverview> {
    return this.transport.request<BillingOwnersOverview>({ method: "GET", path: "/v1/billing/owners", query: params?.query, accept: "json" }, options);
  }

  /**
   * Get a charge point
   *
   * Returns the charge point, its site, security state, every connector with any active session, live connection state and the OCPP URL to configure on the unit. Site-scoped users see the active session card masked to the last 4 characters.
   *
   * `GET /v1/charge-points/{identity}` · needs `charge_point:read`
   */
  getChargePoint(params: {
    /** OCPP identity of the charge point (last path segment of its WebSocket URL), e.g. AUTEL-DC60-SMB-002. */
    identity: string;
  }, options?: RequestOptions): Promise<CpDetail> {
    return this.transport.request<CpDetail>({ method: "GET", path: "/v1/charge-points/{identity}", pathParams: { identity: params.identity }, accept: "json" }, options);
  }

  /**
   * Get a charging session
   *
   * The full session record, its CDR (lines, tax amounts, tariff snapshot, regulatory flags — null until rated) and every meter value recorded.
   *
   * `GET /v1/sessions/{id}` · needs `session:read`
   */
  getChargingSession(params: {
    /** Session id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<SessionDetail> {
    return this.transport.request<SessionDetail>({ method: "GET", path: "/v1/sessions/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Get a commission and fee statement
   *
   * The month's statement: frozen if finalised, otherwise a live draft (the current month projects minimums and fees to month end), plus the list of finalised statements. Org-wide finance staff get the organisation's statement from the platform, or one site owner's with `ownerId`; a Site Owner portal user always gets its own owner's.
   *
   * `GET /v1/billing/statement` · needs `invoice:read`
   */
  getCommissionAndFeeStatement(params?: {
    query?: {
      /** Statement month, YYYY-MM. Defaults to the current month in the billing time zone (Asia/Jakarta). Anything else is a 400. */
      month?: string;
      /** A site owner of the organisation (UUID). Site Owner users may only name their own. */
      ownerId?: string;
    };
  }, options?: RequestOptions): Promise<StatementWithHistory> {
    return this.transport.request<StatementWithHistory>({ method: "GET", path: "/v1/billing/statement", query: params?.query, accept: "json" }, options);
  }

  /**
   * Get the commissioning export
   *
   * Returns the configuration a technician sets on the charger (OCPP URL, versions, security profile, heartbeat) as JSON and as a QR code. It never contains the AuthorizationKey, which is shown only when issued.
   *
   * `GET /v1/charge-points/{identity}/commissioning-export` · needs `charge_point:write`
   */
  getCommissioningExport(params: {
    /** OCPP identity of the charge point (last path segment of its WebSocket URL), e.g. AUTEL-DC60-SMB-002. */
    identity: string;
  }, options?: RequestOptions): Promise<CommissioningBundle> {
    return this.transport.request<CommissioningBundle>({ method: "GET", path: "/v1/charge-points/{identity}/commissioning-export", pathParams: { identity: params.identity }, accept: "json" }, options);
  }

  /**
   * Get commissioning status
   *
   * What the onboarding wizard polls while it waits for a unit: whether it is connected, has booted and been adopted, and the outcome of its last connection attempt (a refused handshake explains most commissioning failures). Site-scoped users get no source IP and no attempt from before the charger joined their site.
   *
   * `GET /v1/charge-points/{identity}/commissioning` · needs `charge_point:read`
   */
  getCommissioningStatus(params: {
    /** OCPP identity of the charge point (last path segment of its WebSocket URL), e.g. AUTEL-DC60-SMB-002. */
    identity: string;
  }, options?: RequestOptions): Promise<CommissioningStatus> {
    return this.transport.request<CommissioningStatus>({ method: "GET", path: "/v1/charge-points/{identity}/commissioning", pathParams: { identity: params.identity }, accept: "json" }, options);
  }

  /**
   * Get the compliance report
   *
   * Per site: SPKLU identity (parsed and checked against the site’s municipality), SLO validity and days remaining, and the metrology (tera) state of every connector’s meter. Site-scoped callers see only their sites.
   *
   * `GET /v1/compliance` · needs `compliance:read`
   */
  getComplianceReport(options?: RequestOptions): Promise<ComplianceSite[]> {
    return this.transport.request<ComplianceSite[]>({ method: "GET", path: "/v1/compliance", accept: "json" }, options);
  }

  /**
   * Get configuration keys
   *
   * Reads the configuration live from the charger (GetConfiguration) and stores it, then returns every reported key plus catalogue keys the charger did not report. Live reads need charge_point:config or charge_point:command; otherwise, when the charger is offline or does not answer, the stored snapshot is returned with error set. Write-only keys never have a value.
   *
   * `GET /v1/charge-points/{identity}/config` · needs `charge_point:read`, `charge_point:config`, `charge_point:command`
   */
  getConfigurationKeys(params: {
    /** OCPP identity of the charge point (last path segment of its WebSocket URL), e.g. AUTEL-DC60-SMB-002. */
    identity: string;
    query?: {
      /** Send 0 to skip the live read and return the stored snapshot. */
      refresh?: "0" | "1";
    };
  }, options?: RequestOptions): Promise<ConfigView> {
    return this.transport.request<ConfigView>({ method: "GET", path: "/v1/charge-points/{identity}/config", pathParams: { identity: params.identity }, query: params.query, accept: "json" }, options);
  }

  /**
   * Get a credit note
   *
   * **Permissions checked:** `invoice:read`.
   *
   * `GET /v1/fleet-credit-notes/{id}` · needs `invoice:read`
   */
  getCreditNote(params: {
    /** Credit note id. */
    id: string;
  }, options?: RequestOptions): Promise<FleetCreditNote> {
    return this.transport.request<FleetCreditNote>({ method: "GET", path: "/v1/fleet-credit-notes/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Get a firmware campaign
   *
   * Returns the campaign, each charger job with its stage and connection state, and the stage names for a progress display.
   *
   * `GET /v1/firmware/campaigns/{id}` · needs `firmware:read`
   */
  getFirmwareCampaign(params: {
    /** Campaign id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<CampaignDetail> {
    return this.transport.request<CampaignDetail>({ method: "GET", path: "/v1/firmware/campaigns/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Get a fleet account
   *
   * **Permissions checked:** `invoice:read`.
   *
   * `GET /v1/fleet-accounts/{id}` · needs `invoice:read`
   */
  getFleetAccount(params: {
    /** Fleet account id. */
    id: string;
  }, options?: RequestOptions): Promise<FleetAccountDetail> {
    return this.transport.request<FleetAccountDetail>({ method: "GET", path: "/v1/fleet-accounts/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Get a fleet account's monthly statement
   *
   * The month's live invoice, or else a draft of the sessions (by the month their charge record was issued) and partner-network charge records not yet invoiced. PPN is computed per site line: DPP nilai lain = 11/12 of the summed price, PPN = 12% of the DPP — the figures the e-Faktur line carries.
   *
   * `GET /v1/fleet-accounts/{id}/statement` · needs `invoice:read`
   */
  getFleetAccountMonthlyStatement(params: {
    /** Fleet account id. */
    id: string;
    query: {
      /** Month, YYYY-MM. */
      period: string;
    };
  }, options?: RequestOptions): Promise<FleetStatement> {
    return this.transport.request<FleetStatement>({ method: "GET", path: "/v1/fleet-accounts/{id}/statement", pathParams: { id: params.id }, query: params.query, accept: "json" }, options);
  }

  /**
   * Get the fleet billing month
   *
   * Every fleet account with charges or an invoice in the month: draft totals or the invoice, overdue and e-Faktur state, plus fleet-card sessions whose card is on no account.
   *
   * `GET /v1/fleet-billing/periods/{period}` · needs `invoice:read`
   */
  getFleetBillingMonth(params: {
    /** Month, YYYY-MM. */
    period: string;
  }, options?: RequestOptions): Promise<GetFleetBillingMonthResponse> {
    return this.transport.request<GetFleetBillingMonthResponse>({ method: "GET", path: "/v1/fleet-billing/periods/{period}", pathParams: { period: params.period }, accept: "json" }, options);
  }

  /**
   * Get fleet billing settings
   *
   * The seller details printed on invoices (from the organisation), the invoice number prefix, payment instructions, and the e-Faktur item settings with whether an export is possible.
   *
   * `GET /v1/fleet-billing/settings` · needs `invoice:read`
   */
  getFleetBillingSettings(options?: RequestOptions): Promise<FleetBillingSettings> {
    return this.transport.request<FleetBillingSettings>({ method: "GET", path: "/v1/fleet-billing/settings", accept: "json" }, options);
  }

  /**
   * Get the fleet dashboard
   *
   * Charger counts (total, online, pending adoption, faulted), connectors by status, open alerts raised in the last 7 days, and — when the caller also holds session:read — today's sessions, energy and revenue plus a 14-day series (Asia/Jakarta days). Site-scoped users see only their sites. Decommissioned chargers are excluded.
   *
   * `GET /v1/dashboard` · needs `charge_point:read`
   */
  getFleetDashboard(options?: RequestOptions): Promise<Dashboard> {
    return this.transport.request<Dashboard>({ method: "GET", path: "/v1/dashboard", accept: "json" }, options);
  }

  /**
   * Get a fleet invoice
   *
   * **Permissions checked:** `invoice:read`.
   *
   * `GET /v1/fleet-invoices/{id}` · needs `invoice:read`
   */
  getFleetInvoice(params: {
    /** Invoice id. */
    id: string;
  }, options?: RequestOptions): Promise<FleetStatement> {
    return this.transport.request<FleetStatement>({ method: "GET", path: "/v1/fleet-invoices/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Get the loyalty program
   *
   * The loyalty settings, the points drivers hold and what they are worth (a liability), and this month's points earned, spent and expired. Drivers signed in to the app earn points on what each session costs them; those who choose to use them have points taken off their sessions automatically, before PBJT-TL and PPN, like a discount.
   *
   * `GET /v1/loyalty` · needs `tariff:read`
   */
  getLoyaltyProgram(options?: RequestOptions): Promise<LoyaltyStats> {
    return this.transport.request<LoyaltyStats>({ method: "GET", path: "/v1/loyalty", accept: "json" }, options);
  }

  /**
   * Get a printable statement
   *
   * The same statement as GET /v1/billing/statement, as a self-contained printable HTML page.
   *
   * `GET /v1/billing/statement.html` · needs `invoice:read`
   */
  getPrintableStatement(params?: {
    query?: {
      /** Statement month, YYYY-MM. Defaults to the current month in the billing time zone (Asia/Jakarta). Anything else is a 400. */
      month?: string;
      /** A site owner of the organisation (UUID). */
      ownerId?: string;
    };
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/billing/statement.html", query: params?.query, accept: "text" }, options);
  }

  /**
   * Get a promotion
   *
   * **Permissions checked:** `tariff:read`.
   *
   * `GET /v1/promotions/{id}` · needs `tariff:read`
   */
  getPromotion(params: {
    /** Promotion id. */
    id: string;
  }, options?: RequestOptions): Promise<Promotion> {
    return this.transport.request<Promotion>({ method: "GET", path: "/v1/promotions/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Get reference data
   *
   * Static lists the console and integrations use: PLN tariff groups, SPKLU schemes, connector types, vendors, token account types, configuration categories, firmware stages, console roles, payment statuses and the regulatory ceilings in force. Needs no particular permission.
   *
   * `GET /v1/meta`
   */
  getReferenceData(options?: RequestOptions): Promise<Meta> {
    return this.transport.request<Meta>({ method: "GET", path: "/v1/meta", accept: "json" }, options);
  }

  /**
   * Get the roaming overview
   *
   * This operator’s OCPI roaming identity, the versions URL to give partners, every partner that is not closed (with queue, token, session and CDR counts), and each site with whether it can be and is shared.
   *
   * `GET /v1/roaming` · needs `roaming:read`
   */
  getRoamingOverview(options?: RequestOptions): Promise<RoamingOverview> {
    return this.transport.request<RoamingOverview>({ method: "GET", path: "/v1/roaming", accept: "json" }, options);
  }

  /**
   * Get a session receipt
   *
   * Returns a printable HTML tax receipt showing DPP, PPN and PBJT-TL separately, issued by the site owner when it is the seller of record and by the operator otherwise. An unrated session gets a receipt with a notice that no tax invoice can be issued yet. Site-scoped users see the card masked.
   *
   * `GET /v1/sessions/{id}/receipt` · needs `session:read`
   */
  getSessionReceipt(params: {
    /** Session id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/sessions/{id}/receipt", pathParams: { id: params.id }, accept: "text" }, options);
  }

  /**
   * Get a session’s signed meter data
   *
   * The signed readings (OCMF) the charger sent for the session, each with what was read from it and whether its signature held; and the outcome for the session: `verified` (signed start and end readings, checked against the connector’s registered meter key, match the bill), `unverified_key` (they match, but no key or only the charger’s own key could check them), `mismatch`, `invalid`, `incomplete` or `missing`. null status: not assessed (the site’s policy is off, or the charger does not sign).
   *
   * `GET /v1/sessions/{id}/signed-data` · needs `session:read`
   */
  getSessionSignedMeterData(params: {
    /** Session id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<SignedMeterData> {
    return this.transport.request<SignedMeterData>({ method: "GET", path: "/v1/sessions/{id}/signed-data", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Get a site
   *
   * Returns the full site record, its power budget and the derived engineering figures.
   *
   * `GET /v1/sites/{siteId}` · needs `site:read`
   */
  getSite(params: {
    /** Site id (UUID). */
    siteId: string;
  }, options?: RequestOptions): Promise<SiteDetail> {
    return this.transport.request<SiteDetail>({ method: "GET", path: "/v1/sites/{siteId}", pathParams: { siteId: params.siteId }, accept: "json" }, options);
  }

  /**
   * Get a site owner's commercial plan
   *
   * The plan in force for the month (an owner without its own plan is on the published rates) and every plan version agreed with the owner.
   *
   * `GET /v1/billing/owners/{id}/plan` · needs `invoice:read`
   */
  getSiteOwnerCommercialPlan(params: {
    /** Site owner id (UUID) of the caller's organisation. */
    id: string;
    query?: {
      /** Statement month, YYYY-MM. Defaults to the current month in the billing time zone (Asia/Jakarta). Anything else is a 400. */
      month?: string;
    };
  }, options?: RequestOptions): Promise<GetSiteOwnerCommercialPlanResponse> {
    return this.transport.request<GetSiteOwnerCommercialPlanResponse>({ method: "GET", path: "/v1/billing/owners/{id}/plan", pathParams: { id: params.id }, query: params.query, accept: "json" }, options);
  }

  /**
   * Get site power and allocation
   *
   * The site’s kVA headroom against its PLN subscription, its power budget, and the allocation the load manager would make now across the site’s connectors.
   *
   * `GET /v1/sites/{siteId}/power` · needs `smartcharging:read`
   */
  getSitePowerAndAllocation(params: {
    /** Site id (UUID). */
    siteId: string;
  }, options?: RequestOptions): Promise<GetSitePowerAndAllocationResponse> {
    return this.transport.request<GetSitePowerAndAllocationResponse>({ method: "GET", path: "/v1/sites/{siteId}/power", pathParams: { siteId: params.siteId }, accept: "json" }, options);
  }

  /**
   * Get the stored device model (OCPP 2.0.1)
   *
   * Returns what the station last reported about itself: components (with EVSE and connector) and their variables, each with attributes (Actual, Target, MinSet, MaxSet: value and mutability) and characteristics (data type, unit, limits, allowed values, whether it supports monitoring); the variable monitors; and the last ten report requests. Protected variables (SecurityCtrlr, network configuration) are flagged. supported is false for 1.6 chargers, whose settings are on the config endpoint. Does not contact the station.
   *
   * `GET /v1/charge-points/{identity}/device-model` · needs `charge_point:read`
   */
  getStoredDeviceModelOcpp201(params: {
    /** OCPP identity of the charge point (last path segment of its WebSocket URL), e.g. AUTEL-DC60-SMB-002. */
    identity: string;
  }, options?: RequestOptions): Promise<GetStoredDeviceModelOcpp201Response> {
    return this.transport.request<GetStoredDeviceModelOcpp201Response>({ method: "GET", path: "/v1/charge-points/{identity}/device-model", pathParams: { identity: params.identity }, accept: "json" }, options);
  }

  /**
   * Get the uptime and utilisation report
   *
   * Per charger over the last `days`: uptime %, outages, offline minutes, longest outage, sessions, energy, revenue and utilisation %. The window starts at commissioning for chargers commissioned inside it. Site-scoped users see only their sites.
   *
   * `GET /v1/reports/availability` · needs `charge_point:read`
   */
  getUptimeAndUtilisationReport(params?: {
    query?: {
      /** Window length in days; default 30, clamped to 1–365. */
      days?: number;
      /** Only this site (UUID). */
      siteId?: string;
    };
  }, options?: RequestOptions): Promise<AvailabilityReport> {
    return this.transport.request<AvailabilityReport>({ method: "GET", path: "/v1/reports/availability", query: params?.query, accept: "json" }, options);
  }

  /**
   * Import a partner’s network
   *
   * Pulls a connected CPO partner’s locations and tariffs now (409 when it is not connected).
   *
   * `POST /v1/roaming/partners/{id}/import` · needs `roaming:write`
   */
  importPartnerNetwork(params: {
    /** Roaming partner id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<ImportPartnerNetworkResponse> {
    return this.transport.request<ImportPartnerNetworkResponse>({ method: "POST", path: "/v1/roaming/partners/{id}/import", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Install the trust anchors on a charger
   *
   * **Permissions checked:** `charge_point:command`.
   *
   * `POST /v1/pnc/chargers/{identity}/install-roots` · needs `charge_point:command`
   */
  installTrustAnchorsOnCharger(params: {
    /** OCPP identity. */
    identity: string;
    body: InstallTrustAnchorsOnChargerBody;
  }, options?: RequestOptions): Promise<InstallTrustAnchorsOnChargerResponse> {
    return this.transport.request<InstallTrustAnchorsOnChargerResponse>({ method: "POST", path: "/v1/pnc/chargers/{identity}/install-roots", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Integration activity
   *
   * Payments created (create_qris; create_checkout for e-wallets and cards, with the channel) and notified, codes sent (numbers masked, codes never), tests.
   *
   * `GET /v1/integrations/{kind}/events` · needs `org:read`
   */
  integrationActivity(params: {
    /** Integration: payments (the acquirer: QRIS, e-wallets, cards), otp (driver sign-in codes), otp_fallback, pnc_pki (Plug & Charge PKI) or map_tiles. */
    kind: string;
    query?: {
      limit?: number;
    };
  }, options?: RequestOptions): Promise<IntegrationActivityResponse> {
    return this.transport.request<IntegrationActivityResponse>({ method: "GET", path: "/v1/integrations/{kind}/events", pathParams: { kind: params.kind }, query: params.query, accept: "json" }, options);
  }

  /**
   * Integrations and their status
   *
   * Every integration with its providers and fields, what this operator and the platform have configured, and what is in force (console settings over environment variables over the built-in default). Secret values are never returned.
   *
   * `GET /v1/integrations` · needs `org:read`
   */
  integrationsAndTheirStatus(options?: RequestOptions): Promise<IntegrationsAndTheirStatusResponse> {
    return this.transport.request<IntegrationsAndTheirStatusResponse>({ method: "GET", path: "/v1/integrations", accept: "json" }, options);
  }

  /**
   * Invite a console user
   *
   * Creates the account with one role and returns a one-time password — shown only in this response. The user must choose a new password at first sign-in. A Site Host needs at least one site; a Site Owner user needs an owner. Audited.
   *
   * `POST /v1/users` · needs `user:write`
   */
  inviteConsoleUser(params: {
    body: UserCreateInput;
  }, options?: RequestOptions): Promise<UserCreated> {
    return this.transport.request<UserCreated>({ method: "POST", path: "/v1/users", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Issue an API key
   *
   * Issues a key with the given permissions, scoped to the organisation, a site or a fleet. A key may not carry a permission the caller does not hold (403). The secret is shown once. Audited as api_key.issued.
   *
   * `POST /v1/api-keys` · needs `org:write`
   */
  issueApiKey(params: {
    body: IssueApiKeyBody;
  }, options?: RequestOptions): Promise<ApiKeyIssued> {
    return this.transport.request<ApiKeyIssued>({ method: "POST", path: "/v1/api-keys", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Issue an authorization key
   *
   * Issues (or rotates) the OCPP Basic-auth AuthorizationKey and returns it once, with a commissioning bundle (JSON and QR). A 160-bit random key is generated unless `key` is supplied. The previous key stays valid for a grace window. Configure the key on the charger before raising its security profile. Audited.
   *
   * `POST /v1/charge-points/{identity}/authorization-key` · needs `charge_point:write`
   */
  issueAuthorizationKey(params: {
    /** OCPP identity of the charge point (the last path segment of its WebSocket URL), e.g. `AUTEL-DC60-SMB-002`. */
    identity: string;
    body: IssueAuthorizationKeyBody;
  }, options?: RequestOptions): Promise<ChargePointAuthorizationKey> {
    return this.transport.request<ChargePointAuthorizationKey>({ method: "POST", path: "/v1/charge-points/{identity}/authorization-key", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Issue a client certificate from Vault
   *
   * Issues a Security Profile 3 client certificate for the charger from Vault PKI, binds its fingerprint and returns the certificate, private key and CA chain with a commissioning export. The private key is shown once and is not stored. Returns 501 when Vault is not configured and 502 when Vault fails. Audited as charge_point.client_cert.issued.
   *
   * `POST /v1/charge-points/{identity}/client-certificate/vault` · needs `charge_point:write`
   */
  issueClientCertificateFromVault(params: {
    /** OCPP identity of the charge point (last path segment of its WebSocket URL), e.g. AUTEL-DC60-SMB-002. */
    identity: string;
  }, options?: RequestOptions): Promise<CommissioningVaultBundle> {
    return this.transport.request<CommissioningVaultBundle>({ method: "POST", path: "/v1/charge-points/{identity}/client-certificate/vault", pathParams: { identity: params.identity }, accept: "json" }, options);
  }

  /**
   * Issue a credit note
   *
   * Credits all (`full: true`) or part (`lines`) of an issued or paid invoice with a numbered credit note (PREFIX-CN/YYYY/MM/NNNN). The invoice never changes. Amounts are what the customer gets back, PPN included; a line with PPN is split into price, DPP (11/12) and PPN (12% of DPP) like an invoice line. A credit cannot take back more than the invoice charged (in total, DPP or PPN), or more of its untaxed part than there was. On an unpaid invoice it reduces what is owed (settling the invoice when nothing is left); on a paid one it is refunded (default) or deducted from the next invoice (`settlement: next_invoice`). `fakturWarning` says when the invoice's faktur pajak was already reported, so a nota pembatalan is needed in Coretax. Audited.
   *
   * `POST /v1/fleet-invoices/{id}/credit-notes` · needs `invoice:write`
   */
  issueCreditNote(params: {
    /** Invoice id. */
    id: string;
    body: IssueCreditNoteBody;
  }, options?: RequestOptions): Promise<IssueCreditNoteResponse> {
    return this.transport.request<IssueCreditNoteResponse>({ method: "POST", path: "/v1/fleet-invoices/{id}/credit-notes", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Issue every fleet account's invoice for a month
   *
   * Issues an invoice for each active account with charges and no invoice yet. Accounts that cannot be invoiced are listed with the reason.
   *
   * `POST /v1/fleet-billing/periods/{period}/issue` · needs `invoice:write`
   */
  issueEveryFleetAccountInvoiceForMonth(params: {
    /** Month, YYYY-MM (must have ended). */
    period: string;
  }, options?: RequestOptions): Promise<IssueEveryFleetAccountInvoiceForMonthResponse> {
    return this.transport.request<IssueEveryFleetAccountInvoiceForMonthResponse>({ method: "POST", path: "/v1/fleet-billing/periods/{period}/issue", pathParams: { period: params.period }, accept: "json" }, options);
  }

  /**
   * Issue a fleet account's invoice for a month
   *
   * Freezes the month's statement as an invoice numbered PREFIX/YYYY/MM/NNNN (per organisation and year), due after the account's payment terms. Only a month that has ended; one live invoice per account and month; each session is on at most one live invoice.
   *
   * `POST /v1/fleet-invoices` · needs `invoice:write`
   */
  issueFleetAccountInvoiceForMonth(params: {
    body: IssueFleetAccountInvoiceForMonthBody;
  }, options?: RequestOptions): Promise<FleetStatement> {
    return this.transport.request<FleetStatement>({ method: "POST", path: "/v1/fleet-invoices", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Issue a test contract certificate
   *
   * Test PKI only (PNC_PKI=mock; never in production): a contract certificate for the eMAID, with the chain and the hash data a charger would send, to try Plug & Charge in a sandbox. Answers 409 with any other PKI.
   *
   * `POST /v1/pnc/test-contracts` · needs `token:write`
   */
  issueTestContractCertificate(params: {
    body: IssueTestContractCertificateBody;
  }, options?: RequestOptions): Promise<IssueTestContractCertificateResponse> {
    return this.transport.request<IssueTestContractCertificateResponse>({ method: "POST", path: "/v1/pnc/test-contracts", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * List alert notifications
   *
   * The notification outbox and delivery log, newest first, at most 300 rows, with the alert, contact and rule each message came from.
   *
   * `GET /v1/alert-routing/log` · needs `alert:read`
   */
  listAlertNotifications(params?: {
    query?: {
      /** Only this state. Any other value is ignored. */
      state?: "pending" | "sent" | "failed" | "suppressed";
      /** Only messages about this alert (UUID). A malformed id is ignored. */
      alertId?: string;
    };
  }, options?: RequestOptions): Promise<ListAlertNotificationsResponse> {
    return this.transport.request<ListAlertNotificationsResponse>({ method: "GET", path: "/v1/alert-routing/log", query: params?.query, accept: "json" }, options);
  }

  /**
   * List alerts
   *
   * The 100 most recently raised alerts. Site-scoped callers see only alerts recorded against their sites.
   *
   * `GET /v1/alerts` · needs `site:read`
   */
  listAlerts(options?: RequestOptions): Promise<Alert[]> {
    return this.transport.request<Alert[]>({ method: "GET", path: "/v1/alerts", accept: "json" }, options);
  }

  /**
   * List API keys
   *
   * The organisation’s API keys, newest first, including revoked ones. Secrets are never returned.
   *
   * `GET /v1/api-keys` · needs `org:read`
   */
  listApiKeys(options?: RequestOptions): Promise<ApiKey[]> {
    return this.transport.request<ApiKey[]>({ method: "GET", path: "/v1/api-keys", accept: "json" }, options);
  }

  /**
   * List cards for roaming
   *
   * The organisation’s RFID cards (up to 2,000), shared ones first, with their contract id and usage on other networks.
   *
   * `GET /v1/roaming/cards` · needs `roaming:read`
   */
  listCardsForRoaming(options?: RequestOptions): Promise<RoamingCard[]> {
    return this.transport.request<RoamingCard[]>({ method: "GET", path: "/v1/roaming/cards", accept: "json" }, options);
  }

  /**
   * List charge points
   *
   * Every charge point in the caller’s organisation (limited to the caller’s sites for site-scoped users), ordered by site and identity, with its connectors, the active session on each connector, security and commissioning fields, and live connection state.
   *
   * `GET /v1/charge-points` · needs `charge_point:read`
   */
  listChargePoints(options?: RequestOptions): Promise<ChargePoint[]> {
    return this.transport.request<ChargePoint[]>({ method: "GET", path: "/v1/charge-points", accept: "json" }, options);
  }

  /**
   * List charging by our cards on other networks
   *
   * Our drivers’ sessions currently active on partner networks (up to 100) and the charge records partners sent for our cards (up to 500, most recent end first), optionally limited by end time. Monetary and energy totals are decimal strings.
   *
   * `GET /v1/roaming/abroad` · needs `roaming:read`
   */
  listChargingByOurCardsOnOtherNetworks(params?: {
    query?: {
      /** Charge records that ended at or after this instant (ignored when not a date). */
      from?: string;
      /** Charge records that ended before this instant (ignored when not a date). */
      to?: string;
    };
  }, options?: RequestOptions): Promise<ListChargingByOurCardsOnOtherNetworksResponse> {
    return this.transport.request<ListChargingByOurCardsOnOtherNetworksResponse>({ method: "GET", path: "/v1/roaming/abroad", query: params?.query, accept: "json" }, options);
  }

  /**
   * List charging sessions
   *
   * Charging sessions, newest first, with the billed amounts. Without filters it returns the most recent sessions including the frozen CDR lines; with any filter it searches and adds card, payment status and a financial `breakdown` per row. Site-scoped callers see only their sites, with card numbers masked and no holder names.
   *
   * `GET /v1/sessions` · needs `session:read`
   */
  listChargingSessions(params?: {
    query?: {
      /** Maximum rows. */
      limit?: number;
      /** Rows to skip (filtered searches only). */
      offset?: number;
      /** Sessions started at or after this instant. */
      from?: string;
      /** Sessions started before this instant. */
      to?: string;
      /** Only this site. */
      siteId?: string;
      /** Only this charge point. */
      identity?: string;
      /** A plug code (cCCS2, sType2…) or AC / DC. */
      connectorType?: string;
      /** Only this payment status. */
      paymentStatus?: "paid" | "invoiced" | "pending" | "unbilled" | "review" | "in_progress" | "failed" | "refunded" | "free" | "held" | "released";
      /** Session state: active, ended, rated, settled, disputed. */
      state?: string;
      /** Session id, OCPP transaction id or card uid (whole-value match for site-scoped callers). */
      q?: string;
    };
  }, options?: RequestOptions): Promise<SessionListItem[]> {
    return this.transport.request<SessionListItem[]>({ method: "GET", path: "/v1/sessions", query: params?.query, accept: "json" }, options);
  }

  /**
   * List commands sent to partners
   *
   * The 200 most recent OCPI commands this operator sent, with the CPO’s answer and the charger’s result.
   *
   * `GET /v1/roaming/commands` · needs `roaming:read`
   */
  listCommandsSentToPartners(options?: RequestOptions): Promise<RoamingCommand[]> {
    return this.transport.request<RoamingCommand[]>({ method: "GET", path: "/v1/roaming/commands", accept: "json" }, options);
  }

  /**
   * List connection attempts
   *
   * WebSocket connection attempts by the organisation’s own charge points, accepted and refused, newest first — the evidence for commissioning failures.
   *
   * `GET /v1/connection-attempts` · needs `charge_point:read`
   */
  listConnectionAttempts(params?: {
    query?: {
      /** Only this OCPP identity. */
      identity?: string;
      /** Only this outcome. */
      outcome?: "accepted" | "accepted_pending_adoption" | "rejected_unknown_cp" | "rejected_auth" | "rejected_no_subprotocol" | "rejected_no_identity" | "rejected_tls_required" | "rejected_malformed_path" | "error";
      /** Only entries at or after this instant. */
      since?: string;
      /** Only entries at or before this instant. */
      until?: string;
      /** Maximum rows. */
      limit?: number;
    };
  }, options?: RequestOptions): Promise<ConnectionAttempt[]> {
    return this.transport.request<ConnectionAttempt[]>({ method: "GET", path: "/v1/connection-attempts", query: params?.query, accept: "json" }, options);
  }

  /**
   * List console roles
   *
   * The roles a user can be given, and whether each is site-scoped (Site Host) or owner-scoped (Site Owner portal).
   *
   * `GET /v1/roles` · needs `user:read`
   */
  listConsoleRoles(options?: RequestOptions): Promise<RoleDefinition[]> {
    return this.transport.request<RoleDefinition[]>({ method: "GET", path: "/v1/roles", accept: "json" }, options);
  }

  /**
   * List console users
   *
   * The organisation's operator accounts with their role grants, lock state and last sign-in. Password hashes are never returned.
   *
   * `GET /v1/users` · needs `user:read`
   */
  listConsoleUsers(options?: RequestOptions): Promise<UserRow[]> {
    return this.transport.request<UserRow[]>({ method: "GET", path: "/v1/users", accept: "json" }, options);
  }

  /**
   * List contracts (eMAIDs)
   *
   * **Permissions checked:** `token:read`.
   *
   * `GET /v1/pnc/contracts` · needs `token:read`
   */
  listContractsEMAIDs(options?: RequestOptions): Promise<ListContractsEMAIDsResponse> {
    return this.transport.request<ListContractsEMAIDsResponse>({ method: "GET", path: "/v1/pnc/contracts", accept: "json" }, options);
  }

  /**
   * List credit notes
   *
   * Credit notes, newest first. `open=true` lists only those still to refund or waiting for the next invoice.
   *
   * `GET /v1/fleet-credit-notes` · needs `invoice:read`
   */
  listCreditNotes(params?: {
    query?: {
      /** Only this fleet account. */
      accountId?: string;
      /** Only those against this invoice. */
      invoiceId?: string;
      /** Only credit notes with something still to do. */
      open?: boolean;
    };
  }, options?: RequestOptions): Promise<ListCreditNotesResponse> {
    return this.transport.request<ListCreditNotesResponse>({ method: "GET", path: "/v1/fleet-credit-notes", query: params?.query, accept: "json" }, options);
  }

  /**
   * List developer sandboxes
   *
   * The sandboxes this operator has created, with their active API keys (prefix only).
   *
   * `GET /v1/sandboxes` · needs `org:read`
   */
  listDeveloperSandboxes(options?: RequestOptions): Promise<ListDeveloperSandboxesResponse> {
    return this.transport.request<ListDeveloperSandboxesResponse>({ method: "GET", path: "/v1/sandboxes", accept: "json" }, options);
  }

  /**
   * List diagnostics requests
   *
   * Returns the last 100 log-upload requests for the charger, newest first. Site-scoped users do not see requests from before the charger joined their site.
   *
   * `GET /v1/charge-points/{identity}/diagnostics` · needs `charge_point:read`
   */
  listDiagnosticsRequests(params: {
    /** OCPP identity of the charge point (last path segment of its WebSocket URL), e.g. AUTEL-DC60-SMB-002. */
    identity: string;
  }, options?: RequestOptions): Promise<DiagnosticsRequestRow[]> {
    return this.transport.request<DiagnosticsRequestRow[]>({ method: "GET", path: "/v1/charge-points/{identity}/diagnostics", pathParams: { identity: params.identity }, accept: "json" }, options);
  }

  /**
   * List drivers with the most points
   *
   * **Permissions checked:** `tariff:read`.
   *
   * `GET /v1/loyalty/members` · needs `tariff:read`
   */
  listDriversWithMostPoints(params?: {
    query?: {
      limit?: number;
    };
  }, options?: RequestOptions): Promise<ListDriversWithMostPointsResponse> {
    return this.transport.request<ListDriversWithMostPointsResponse>({ method: "GET", path: "/v1/loyalty/members", query: params?.query, accept: "json" }, options);
  }

  /**
   * List firmware campaigns
   *
   * Returns the organisation's campaigns, newest first, with job counts by outcome.
   *
   * `GET /v1/firmware/campaigns` · needs `firmware:read`
   */
  listFirmwareCampaigns(options?: RequestOptions): Promise<CampaignSummary[]> {
    return this.transport.request<CampaignSummary[]>({ method: "GET", path: "/v1/firmware/campaigns", accept: "json" }, options);
  }

  /**
   * List firmware images
   *
   * Returns the organisation's firmware images, newest first, including archived ones.
   *
   * `GET /v1/firmware/images` · needs `firmware:read`
   */
  listFirmwareImages(options?: RequestOptions): Promise<FirmwareImage[]> {
    return this.transport.request<FirmwareImage[]>({ method: "GET", path: "/v1/firmware/images", accept: "json" }, options);
  }

  /**
   * List fleet accounts
   *
   * The companies fleet cards are billed to, with card count and what is outstanding. A card belongs to the account whose name is its fleet name in the RFID centre.
   *
   * `GET /v1/fleet-accounts` · needs `invoice:read`
   */
  listFleetAccounts(params?: {
    query?: {
      /** 1 to include archived accounts. */
      archived?: "0" | "1";
    };
  }, options?: RequestOptions): Promise<ListFleetAccountsResponse> {
    return this.transport.request<ListFleetAccountsResponse>({ method: "GET", path: "/v1/fleet-accounts", query: params?.query, accept: "json" }, options);
  }

  /**
   * List fleet invoices
   *
   * **Permissions checked:** `invoice:read`.
   *
   * `GET /v1/fleet-invoices` · needs `invoice:read`
   */
  listFleetInvoices(params?: {
    query?: {
      /** One fleet account. */
      accountId?: string;
      status?: "issued" | "paid" | "void";
      limit?: number;
    };
  }, options?: RequestOptions): Promise<ListFleetInvoicesResponse> {
    return this.transport.request<ListFleetInvoicesResponse>({ method: "GET", path: "/v1/fleet-invoices", query: params?.query, accept: "json" }, options);
  }

  /**
   * List hardware quirk profiles
   *
   * Per vendor/model/firmware behaviour the platform has learned and adapts to, with how many charge points use each profile.
   *
   * `GET /v1/quirks` · needs `charge_point:read`
   */
  listHardwareQuirkProfiles(options?: RequestOptions): Promise<QuirkProfile[]> {
    return this.transport.request<QuirkProfile[]>({ method: "GET", path: "/v1/quirks", accept: "json" }, options);
  }

  /**
   * List members
   *
   * **Permissions checked:** `tariff:read`.
   *
   * `GET /v1/subscriptions` · needs `tariff:read`
   */
  listMembers(params?: {
    query?: {
      planId?: string;
      status?: "pending_payment" | "active" | "cancelled" | "expired";
    };
  }, options?: RequestOptions): Promise<ListMembersResponse> {
    return this.transport.request<ListMembersResponse>({ method: "GET", path: "/v1/subscriptions", query: params?.query, accept: "json" }, options);
  }

  /**
   * List membership plans
   *
   * Monthly plans: member price per kWh, % off energy, included kWh, service fee waived. Applied at rating, after the regulatory caps and before PBJT-TL and PPN, as discount lines on the receipt. Each session gets the customer's membership plus at most one promotion — whichever combination is cheapest for the customer — judged at the time the session started.
   *
   * `GET /v1/subscription-plans` · needs `tariff:read`
   */
  listMembershipPlans(options?: RequestOptions): Promise<ListMembershipPlansResponse> {
    return this.transport.request<ListMembershipPlansResponse>({ method: "GET", path: "/v1/subscription-plans", accept: "json" }, options);
  }

  /**
   * List OCPI messages with a partner
   *
   * The request/response log of OCPI calls to and from one partner, newest first (up to 300).
   *
   * `GET /v1/roaming/partners/{id}/messages` · needs `roaming:read`
   */
  listOcpiMessagesWithPartner(params: {
    /** Roaming partner id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<OcpiMessage[]> {
    return this.transport.request<OcpiMessage[]>({ method: "GET", path: "/v1/roaming/partners/{id}/messages", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * List OCPP frames
   *
   * The raw OCPP message log for one charge point, newest first. Frames carry drivers’ RFID idTags, so site-scoped callers also need `charge_point:config` or `charge_point:command` on the charger, and see history only from when it joined its current site.
   *
   * `GET /v1/charge-points/{identity}/frames` · needs `charge_point:read`
   */
  listOcppFrames(params: {
    /** OCPP identity of the charge point (the last path segment of its WebSocket URL), e.g. `AUTEL-DC60-SMB-002`. */
    identity: string;
    query?: {
      /** Only entries at or after this instant. */
      since?: string;
      /** Only entries at or before this instant. */
      until?: string;
      /** OCPP action, e.g. `StatusNotification`. */
      action?: string;
      /** `in` (from the charger) or `out` (to the charger). */
      direction?: "in" | "out";
      /** Maximum rows. */
      limit?: number;
    };
  }, options?: RequestOptions): Promise<Frame[]> {
    return this.transport.request<Frame[]>({ method: "GET", path: "/v1/charge-points/{identity}/frames", pathParams: { identity: params.identity }, query: params.query, accept: "json" }, options);
  }

  /**
   * List the parties behind a hub
   *
   * What a roaming hub reported about the operators and service providers behind it (OCPI HubClientInfo). Once a hub has sent this list, it may only act for parties on it that are CONNECTED or OFFLINE. Empty for a partner that is not a hub.
   *
   * `GET /v1/roaming/partners/{id}/hub-clients` · needs `roaming:read`
   */
  listPartiesBehindHub(params: {
    /** Roaming partner id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<RoamingHubClient[]> {
    return this.transport.request<RoamingHubClient[]>({ method: "GET", path: "/v1/roaming/partners/{id}/hub-clients", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * List partner charge records held for review
   *
   * Charge records (CDRs) a partner CPO sent for our fleet cards that could not be linked to a session that partner reported or an authorisation we issued, or that failed the plausibility checks (energy, price per kWh, VAT, duration). Held records are not invoiced and do not count against card limits until accepted. Newest first (up to 500).
   *
   * `GET /v1/roaming/cdrs/held` · needs `roaming:read`
   */
  listPartnerChargeRecordsHeldForReview(options?: RequestOptions): Promise<ListPartnerChargeRecordsHeldForReviewResponse> {
    return this.transport.request<ListPartnerChargeRecordsHeldForReviewResponse>({ method: "GET", path: "/v1/roaming/cdrs/held", accept: "json" }, options);
  }

  /**
   * List partner charging locations
   *
   * Charging locations published by connected CPO partners (up to 1,000, by city and name), with EVSE status, where our shared cards can charge.
   *
   * `GET /v1/roaming/network` · needs `roaming:read`
   */
  listPartnerChargingLocations(options?: RequestOptions): Promise<RoamingNetworkLocation[]> {
    return this.transport.request<RoamingNetworkLocation[]>({ method: "GET", path: "/v1/roaming/network", accept: "json" }, options);
  }

  /**
   * List partner drivers’ sessions
   *
   * The 200 most recent sessions on our chargers by roaming partners’ drivers, with the billed total and the state of the CDR delivery to the partner.
   *
   * `GET /v1/roaming/sessions` · needs `roaming:read`
   */
  listPartnerDriversSessions(options?: RequestOptions): Promise<RoamingSession[]> {
    return this.transport.request<RoamingSession[]>({ method: "GET", path: "/v1/roaming/sessions", accept: "json" }, options);
  }

  /**
   * List partners’ charging limits
   *
   * Charging limits partners have set on their drivers’ sessions still running here (OCPI ChargingProfiles), with the limit in force now. Load management applies them on top of the site power budget; a partner can lower a session’s rate, never raise it.
   *
   * `GET /v1/roaming/charging-profiles` · needs `roaming:read`
   */
  listPartnersChargingLimits(options?: RequestOptions): Promise<RoamingChargingLimit[]> {
    return this.transport.request<RoamingChargingLimit[]>({ method: "GET", path: "/v1/roaming/charging-profiles", accept: "json" }, options);
  }

  /**
   * List promotions
   *
   * With how often each was used, by how many customers, and the discount given. Applied at rating, after the regulatory caps and before PBJT-TL and PPN, as discount lines on the receipt. Each session gets the customer's membership plus at most one promotion — whichever combination is cheapest for the customer — judged at the time the session started.
   *
   * `GET /v1/promotions` · needs `tariff:read`
   */
  listPromotions(options?: RequestOptions): Promise<ListPromotionsResponse> {
    return this.transport.request<ListPromotionsResponse>({ method: "GET", path: "/v1/promotions", accept: "json" }, options);
  }

  /**
   * List queued pushes to a partner
   *
   * The outbox of calls to one partner (location, tariff, session, CDR and token updates) with their delivery state, newest first (up to 300).
   *
   * `GET /v1/roaming/partners/{id}/pushes` · needs `roaming:read`
   */
  listQueuedPushesToPartner(params: {
    /** Roaming partner id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<OcpiPush[]> {
    return this.transport.request<OcpiPush[]>({ method: "GET", path: "/v1/roaming/partners/{id}/pushes", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * List recently presented unregistered cards
   *
   * Returns up to 20 idTags presented at your chargers in the last 30 minutes that are not registered, newest first, so an installer can tap a new card and pick it instead of typing its serial.
   *
   * `GET /v1/tokens/unknown` · needs `token:write`
   */
  listRecentlyPresentedUnregisteredCards(params?: {
    query?: {
      /** Only cards presented at this charge point. */
      identity?: string;
    };
  }, options?: RequestOptions): Promise<TokenUnknownTag[]> {
    return this.transport.request<TokenUnknownTag[]>({ method: "GET", path: "/v1/tokens/unknown", query: params?.query, accept: "json" }, options);
  }

  /**
   * List refunds owed to drivers
   *
   * Prepaid payments in the refund flow (due, processing, refunded, failed) with a summary: amount and count outstanding, failed count and amount refunded in the last 30 days. Outstanding refunds come first; at most 500 rows.
   *
   * `GET /v1/refunds` · needs `payment:read`
   */
  listRefundsOwedToDrivers(params?: {
    query?: {
      /** Only this refund state. Any other value is ignored (all states). */
      state?: "due" | "processing" | "refunded" | "failed";
    };
  }, options?: RequestOptions): Promise<ListRefundsOwedToDriversResponse> {
    return this.transport.request<ListRefundsOwedToDriversResponse>({ method: "GET", path: "/v1/refunds", query: params?.query, accept: "json" }, options);
  }

  /**
   * List RFID cards
   *
   * Returns the organisation's cards (prepaid tokens excluded), most recently updated first, with lifetime usage totals.
   *
   * `GET /v1/tokens` · needs `token:read`
   */
  listRfidCards(params?: {
    query?: {
      /** Substring match on UID, holder name, fleet name or holder phone. */
      q?: string;
      /** Exact status, e.g. Accepted or Blocked. */
      status?: string;
      /** Account type. */
      accountType?: "retail" | "fleet" | "vip" | "technician";
      /** Maximum rows; default 500, at most 2000. */
      limit?: number;
    };
  }, options?: RequestOptions): Promise<Token[]> {
    return this.transport.request<Token[]>({ method: "GET", path: "/v1/tokens", query: params?.query, accept: "json" }, options);
  }

  /**
   * List site owners
   *
   * The businesses whose sites the organisation operates, with their sites, charger count and portal user count. Archived owners come last.
   *
   * `GET /v1/owners` · needs `site:read`
   */
  listSiteOwners(options?: RequestOptions): Promise<OwnerRow[]> {
    return this.transport.request<OwnerRow[]>({ method: "GET", path: "/v1/owners", accept: "json" }, options);
  }

  /**
   * List sites
   *
   * Returns every site of your organisation that you can read, active sites first, with live charger counts and the managed DLM ceiling. Site-scoped users see only their sites. Archived sites are included, with archived_at set.
   *
   * `GET /v1/sites` · needs `site:read`
   */
  listSites(options?: RequestOptions): Promise<SiteListItem[]> {
    return this.transport.request<SiteListItem[]>({ method: "GET", path: "/v1/sites", accept: "json" }, options);
  }

  /**
   * List tariffs
   *
   * All of the organisation’s tariffs (active first), with their price components, validation flags and where each is assigned.
   *
   * `GET /v1/tariffs` · needs `tariff:read`
   */
  listTariffs(options?: RequestOptions): Promise<Tariff[]> {
    return this.transport.request<Tariff[]>({ method: "GET", path: "/v1/tariffs", accept: "json" }, options);
  }

  /**
   * List tokens from a partner
   *
   * Driver tokens a partner has pushed to us, most recently received first (up to 500).
   *
   * `GET /v1/roaming/partners/{id}/tokens` · needs `roaming:read`
   */
  listTokensFromPartner(params: {
    /** Roaming partner id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<OcpiToken[]> {
    return this.transport.request<OcpiToken[]>({ method: "GET", path: "/v1/roaming/partners/{id}/tokens", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * List trust anchors
   *
   * Root certificates for the chargers' trust stores: the V2G root (the charger's own chain) and mobility operators' roots (contract certificates). MO roots are also what the CSMS checks contract chains against.
   *
   * `GET /v1/pnc/trust-anchors` · needs `charge_point:read`
   */
  listTrustAnchors(options?: RequestOptions): Promise<ListTrustAnchorsResponse> {
    return this.transport.request<ListTrustAnchorsResponse>({ method: "GET", path: "/v1/pnc/trust-anchors", accept: "json" }, options);
  }

  /**
   * List webhook deliveries
   *
   * The latest 200 deliveries to the endpoint, newest first, with payloads and the last attempt's result. An unknown endpoint id gives an empty list.
   *
   * `GET /v1/webhooks/{id}/deliveries` · needs `webhook:read`
   */
  listWebhookDeliveries(params: {
    /** Webhook endpoint id (UUID). */
    id: string;
    query?: {
      /** Only deliveries in this state. Any other value is ignored. */
      state?: "pending" | "delivered" | "failed";
    };
  }, options?: RequestOptions): Promise<ListWebhookDeliveriesResponse> {
    return this.transport.request<ListWebhookDeliveriesResponse>({ method: "GET", path: "/v1/webhooks/{id}/deliveries", pathParams: { id: params.id }, query: params.query, accept: "json" }, options);
  }

  /**
   * List webhook endpoints
   *
   * The organisation's endpoints with delivery counts (pending, failed, delivered in the last 24 h), and the event types that can be subscribed to. Signing secrets are never returned here.
   *
   * `GET /v1/webhooks` · needs `webhook:read`
   */
  listWebhookEndpoints(options?: RequestOptions): Promise<ListWebhookEndpointsResponse> {
    return this.transport.request<ListWebhookEndpointsResponse>({ method: "GET", path: "/v1/webhooks", accept: "json" }, options);
  }

  /**
   * The operator’s own driver app
   *
   * The white-label driver app: its brand, the colours as they are used in both themes, what is still missing to go live and to publish in the stores, and its preview and live addresses.
   *
   * `GET /v1/driver-app` · needs `org:read`
   */
  operatorOwnDriverApp(options?: RequestOptions): Promise<DriverAppView> {
    return this.transport.request<DriverAppView>({ method: "GET", path: "/v1/driver-app", accept: "json" }, options);
  }

  /**
   * Pay a refund through the payment provider
   *
   * Calls the payment provider's refund API for a refund that is due or failed. The result is `refunded`, or `processing` when the provider settles asynchronously. When the provider has no refund API or refuses, the refund becomes failed and the call answers 409 with `error` and `state` — refund by bank transfer and record it with mark-refunded. Audited either way.
   *
   * `POST /v1/refunds/{id}/process` · needs `payment:write`
   */
  payRefundThroughPaymentProvider(params: {
    /** Payment intent id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<RefundOutcome> {
    return this.transport.request<RefundOutcome>({ method: "POST", path: "/v1/refunds/{id}/process", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Plug & Charge exchange log
   *
   * Every Authorize with a contract, certificate request, OCSP check and certificate command, newest first.
   *
   * `GET /v1/pnc/events` · needs `charge_point:read`
   */
  plugChargeExchangeLog(params?: {
    query?: {
      /** Only this charger. */
      identity?: string;
      limit?: number;
    };
  }, options?: RequestOptions): Promise<PlugChargeExchangeLogResponse> {
    return this.transport.request<PlugChargeExchangeLogResponse>({ method: "GET", path: "/v1/pnc/events", query: params?.query, accept: "json" }, options);
  }

  /**
   * Plug & Charge overview
   *
   * Settings, the V2G PKI in use and counts. Chargers speak Plug & Charge over OCPP 2.0.1, or over OCPP 1.6 wrapped in DataTransfer (vendorId `org.openchargealliance.iso15118pnc`); both are handled. A contract is authorised in two steps: its certificate (chain to an installed MO root, expiry, OCSP) proves the car holds it; the contract then decides, like a card (status, expiry, limits, fleet account, membership).
   *
   * `GET /v1/pnc` · needs `charge_point:read`
   */
  plugChargeOverview(options?: RequestOptions): Promise<PncOverview> {
    return this.transport.request<PncOverview>({ method: "GET", path: "/v1/pnc", accept: "json" }, options);
  }

  /**
   * Preview a tariff
   *
   * Rates a hypothetical session under a tariff definition without saving anything: CDR lines, charging class, tax stack and regulatory flags.
   *
   * `POST /v1/tariffs/preview` · needs `tariff:read`
   */
  previewTariff(params: {
    body: PreviewTariffBody;
  }, options?: RequestOptions): Promise<TariffRating> {
    return this.transport.request<TariffRating>({ method: "POST", path: "/v1/tariffs/preview", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Print a fleet invoice
   *
   * A4 printable invoice with an appendix of sessions by card (print to PDF from the browser).
   *
   * `GET /v1/fleet-invoices/{id}/invoice.html` · needs `invoice:read`
   */
  printFleetInvoice(params: {
    /** Invoice id. */
    id: string;
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/fleet-invoices/{id}/invoice.html", pathParams: { id: params.id }, accept: "text" }, options);
  }

  /**
   * Print a monthly statement
   *
   * The statement or invoice as an A4 printable page (print to PDF from the browser).
   *
   * `GET /v1/fleet-accounts/{id}/statement.html` · needs `invoice:read`
   */
  printMonthlyStatement(params: {
    /** Fleet account id. */
    id: string;
    query: {
      /** Month, YYYY-MM. */
      period: string;
    };
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/fleet-accounts/{id}/statement.html", pathParams: { id: params.id }, query: params.query, accept: "text" }, options);
  }

  /**
   * Provision charger security credentials
   *
   * Profiles 1-2 issue a new AuthorizationKey (generated, or your own) and return it with a commissioning export; the key is shown once and the previous key stays valid for a grace window. Profile 3 issues a client certificate automatically from PlugSure's charging-station CA (method "auto": key and certificate, the key shown once and not stored; method "csr": the charger's own request signed), issues one from Vault PKI (method "vault"), or binds your certificate PEM or fingerprint; with neither, the binding is cleared. This does not raise the security profile: configure the credential on the charger first, then raise the profile. Vault errors return 501 (not configured) or 502.
   *
   * `POST /v1/charge-points/{identity}/keys` · needs `charge_point:write`
   */
  provisionChargerSecurityCredentials(params: {
    /** OCPP identity of the charge point (last path segment of its WebSocket URL), e.g. AUTEL-DC60-SMB-002. */
    identity: string;
    body?: CommissioningKeysRequest;
  }, options?: RequestOptions): Promise<CommissioningKeyIssued | CommissioningCaBundle | CommissioningVaultBundle | CommissioningCertBound> {
    return this.transport.request<CommissioningKeyIssued | CommissioningCaBundle | CommissioningVaultBundle | CommissioningCertBound>({ method: "POST", path: "/v1/charge-points/{identity}/keys", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Provision default charging profiles
   *
   * Installs a conservative TxDefaultProfile on every online connector at the site — the limit a charger falls back to when the load manager cannot reach it.
   *
   * `POST /v1/sites/{siteId}/power/provision-defaults` · needs `smartcharging:write`
   */
  provisionDefaultChargingProfiles(params: {
    /** Site id (UUID). */
    siteId: string;
  }, options?: RequestOptions): Promise<ProvisionDefaultChargingProfilesResponse> {
    return this.transport.request<ProvisionDefaultChargingProfilesResponse>({ method: "POST", path: "/v1/sites/{siteId}/power/provision-defaults", pathParams: { siteId: params.siteId }, accept: "json" }, options);
  }

  /**
   * Pull the hub’s client list
   *
   * Reads the full client list from the hub’s HubClientInfo endpoint (paged) and replaces what we hold. 409 when the partner is not a connected hub; 502 when the hub offers no list or did not answer.
   *
   * `POST /v1/roaming/partners/{id}/hub-clients/refresh` · needs `roaming:write`
   */
  pullHubClientList(params: {
    /** Roaming partner id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<PullHubClientListResponse> {
    return this.transport.request<PullHubClientListResponse>({ method: "POST", path: "/v1/roaming/partners/{id}/hub-clients/refresh", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Push the local authorisation list to a charger
   *
   * Sends the organisation's offline-allowed cards (up to 1000) to the charger as a full SendLocalList update, so they keep working through a network outage. Refused with 400 when the charger is offline. A charger rejection is reported as ok false with a 200. Audited as token.local_list_synced.
   *
   * `POST /v1/charge-points/{identity}/local-list/sync` · needs `token:write`
   */
  pushLocalAuthorisationListToCharger(params: {
    /** OCPP identity of the charge point (last path segment of its WebSocket URL), e.g. AUTEL-DC60-SMB-002. */
    identity: string;
  }, options?: RequestOptions): Promise<LocalListSyncResult> {
    return this.transport.request<LocalListSyncResult>({ method: "POST", path: "/v1/charge-points/{identity}/local-list/sync", pathParams: { identity: params.identity }, accept: "json" }, options);
  }

  /**
   * Push the local authorisation list to every charger at a site
   *
   * Pushes the card list to each charge point at the site that is not decommissioned or pending adoption; offline units are skipped with error "offline". Returns one result per charger. Audited as token.local_list_synced.
   *
   * `POST /v1/sites/{siteId}/local-list/sync` · needs `token:write`
   */
  pushLocalAuthorisationListToEveryChargerAtSite(params: {
    /** Site id (UUID). */
    siteId: string;
  }, options?: RequestOptions): Promise<LocalListSiteSyncResult> {
    return this.transport.request<LocalListSiteSyncResult>({ method: "POST", path: "/v1/sites/{siteId}/local-list/sync", pathParams: { siteId: params.siteId }, accept: "json" }, options);
  }

  /**
   * Reactivate a contract
   *
   * **Permissions checked:** `token:write`.
   *
   * `POST /v1/pnc/contracts/{id}/reactivate` · needs `token:write`
   */
  reactivateContract(params: {
    /** Contract (token) id. */
    id: string;
  }, options?: RequestOptions): Promise<PncContract> {
    return this.transport.request<PncContract>({ method: "POST", path: "/v1/pnc/contracts/{id}/reactivate", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Read the certificates installed on a charger
   *
   * GetInstalledCertificateIds for the V2G root, MO roots and the V2G certificate chain. The answer is also kept with the charger.
   *
   * `POST /v1/pnc/chargers/{identity}/read-installed` · needs `charge_point:command`
   */
  readCertificatesInstalledOnCharger(params: {
    /** OCPP identity. */
    identity: string;
  }, options?: RequestOptions): Promise<ReadCertificatesInstalledOnChargerResponse> {
    return this.transport.request<ReadCertificatesInstalledOnChargerResponse>({ method: "POST", path: "/v1/pnc/chargers/{identity}/read-installed", pathParams: { identity: params.identity }, accept: "json" }, options);
  }

  /**
   * Read an uploaded diagnostics log
   *
   * Returns the received log as text for the viewer: gzip is unpacked and text is capped at 2 MiB (truncated is then true); ZIP and other binary files are reported as binary with no text. available is false while no file has been received.
   *
   * `GET /v1/diagnostics/{id}/content` · needs `charge_point:read`
   */
  readUploadedDiagnosticsLog(params: {
    /** Diagnostics request id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<DiagnosticsContent> {
    return this.transport.request<DiagnosticsContent>({ method: "GET", path: "/v1/diagnostics/{id}/content", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Read variables now (GetVariables)
   *
   * Reads 1 to 20 component/variable attributes from the station and stores the accepted values. Each result carries the station's attributeStatus (Accepted, Rejected, UnknownComponent, UnknownVariable, NotSupportedAttributeType).
   *
   * `POST /v1/charge-points/{identity}/device-model/get`
   */
  readVariablesNowGetVariables(params: {
    /** OCPP identity of the charge point (last path segment of its WebSocket URL), e.g. AUTEL-DC60-SMB-002. */
    identity: string;
    body: ReadVariablesNowGetVariablesBody;
  }, options?: RequestOptions): Promise<ReadVariablesNowGetVariablesResponse> {
    return this.transport.request<ReadVariablesNowGetVariablesResponse>({ method: "POST", path: "/v1/charge-points/{identity}/device-model/get", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Reconcile stuck sessions
   *
   * Closes the organisation’s sessions still active past the maximum session length (flagged STUCK_SESSION for review) and rates ended sessions that never produced a CDR.
   *
   * `POST /v1/sessions/reconcile` · needs `session:write`
   */
  reconcileStuckSessions(options?: RequestOptions): Promise<ReconcileStuckSessionsResponse> {
    return this.transport.request<ReconcileStuckSessionsResponse>({ method: "POST", path: "/v1/sessions/reconcile", accept: "json" }, options);
  }

  /**
   * Record a credit note as refunded
   *
   * For a credit note settled by refund: the date the money was paid back (default today) and a reference. Audited.
   *
   * `POST /v1/fleet-credit-notes/{id}/refunded` · needs `invoice:write`
   */
  recordCreditNoteAsRefunded(params: {
    /** Credit note id. */
    id: string;
    body?: RecordCreditNoteAsRefundedBody;
  }, options?: RequestOptions): Promise<FleetCreditNote> {
    return this.transport.request<FleetCreditNote>({ method: "POST", path: "/v1/fleet-credit-notes/{id}/refunded", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record the faktur pajak number
   *
   * The faktur number Coretax assigned when the imported faktur was approved; printed on the invoice.
   *
   * `PUT /v1/fleet-invoices/{id}/faktur-number` · needs `invoice:write`
   */
  recordFakturPajakNumber(params: {
    /** Invoice id. */
    id: string;
    body: RecordFakturPajakNumberBody;
  }, options?: RequestOptions): Promise<FleetStatement> {
    return this.transport.request<FleetStatement>({ method: "PUT", path: "/v1/fleet-invoices/{id}/faktur-number", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record payment of a fleet invoice
   *
   * **Permissions checked:** `invoice:write`.
   *
   * `POST /v1/fleet-invoices/{id}/pay` · needs `invoice:write`
   */
  recordPaymentOfFleetInvoice(params: {
    /** Invoice id. */
    id: string;
    body?: RecordPaymentOfFleetInvoiceBody;
  }, options?: RequestOptions): Promise<FleetStatement> {
    return this.transport.request<FleetStatement>({ method: "POST", path: "/v1/fleet-invoices/{id}/pay", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a refund paid by bank transfer
   *
   * Marks an outstanding refund (due, failed or processing) as refunded manually with the bank transfer reference, and resolves the related "refund due" alert. Audited.
   *
   * `POST /v1/refunds/{id}/mark-refunded` · needs `payment:write`
   */
  recordRefundPaidByBankTransfer(params: {
    /** Payment intent id (UUID). */
    id: string;
    body: RecordRefundPaidByBankTransferBody;
  }, options?: RequestOptions): Promise<RecordRefundPaidByBankTransferResponse> {
    return this.transport.request<RecordRefundPaidByBankTransferResponse>({ method: "POST", path: "/v1/refunds/{id}/mark-refunded", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Register a charge point
   *
   * Pre-registers a charge point before it dials in, optionally with its hardware profile and EVSE/connector topology. It is created in `pending_adoption`: it may connect but is answered Pending until activated. Returns 409 when the identity is already registered and 422 when the topology is invalid. Audited as charge_point.registered.
   *
   * `POST /v1/charge-points` · needs `charge_point:write`
   */
  registerChargePoint(params: {
    body: RegisterChargePointBody;
  }, options?: RequestOptions): Promise<RegisterChargePointResponse> {
    return this.transport.request<RegisterChargePointResponse>({ method: "POST", path: "/v1/charge-points", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Register a contract
   *
   * A contract of your own mobility service. The eMAID is stored without separators; a fleet contract is billed to its fleet account like a fleet card.
   *
   * `POST /v1/pnc/contracts` · needs `token:write`
   */
  registerContract(params: {
    body: RegisterContractBody;
  }, options?: RequestOptions): Promise<PncContract> {
    return this.transport.request<PncContract>({ method: "POST", path: "/v1/pnc/contracts", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Register an RFID card
   *
   * Registers a card with holder, account type and limits; account type defaults to retail and status to Accepted. Invalid input is refused with 422, a UID already registered with 409. A PIN is stored hashed. Audited as token.issued.
   *
   * `POST /v1/tokens` · needs `token:write`
   */
  registerRfidCard(params: {
    body: TokenInput;
  }, options?: RequestOptions): Promise<TokenCreated> {
    return this.transport.request<TokenCreated>({ method: "POST", path: "/v1/tokens", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Reinstate a decommissioned charge point
   *
   * Returns a decommissioned unit to pending_adoption with security profile 0, so it goes through adoption again and needs new credentials. Has no effect on a unit that is not decommissioned, but still answers ok. Audited as charge_point.reinstated.
   *
   * `POST /v1/charge-points/{identity}/reinstate` · needs `charge_point:write`
   */
  reinstateDecommissionedChargePoint(params: {
    /** OCPP identity of the charge point (last path segment of its WebSocket URL), e.g. AUTEL-DC60-SMB-002. */
    identity: string;
  }, options?: RequestOptions): Promise<ReinstateDecommissionedChargePointResponse> {
    return this.transport.request<ReinstateDecommissionedChargePointResponse>({ method: "POST", path: "/v1/charge-points/{identity}/reinstate", pathParams: { identity: params.identity }, accept: "json" }, options);
  }

  /**
   * Reject a held partner charge record
   *
   * Rejects a held record: it is never invoiced. A record already accepted cannot be rejected (409). Audited as roaming.cdr_rejected.
   *
   * `POST /v1/roaming/cdrs/{id}/reject` · needs `roaming:write`
   */
  rejectHeldPartnerChargeRecord(params: {
    /** Charge record id (UUID). */
    id: string;
    body?: RejectHeldPartnerChargeRecordBody;
  }, options?: RequestOptions): Promise<RejectHeldPartnerChargeRecordResponse> {
    return this.transport.request<RejectHeldPartnerChargeRecordResponse>({ method: "POST", path: "/v1/roaming/cdrs/{id}/reject", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Remove the driver app
   *
   * The operator goes back to the PlugSure app. A live app needs `?confirm=<slug>`: its web address stops serving it and its store apps stop working.
   *
   * `DELETE /v1/driver-app` · needs `org:write`
   */
  removeDriverApp(params?: {
    query?: {
      /** The slug, to remove a live app. */
      confirm?: string;
    };
  }, options?: RequestOptions): Promise<RemoveDriverAppResponse> {
    return this.transport.request<RemoveDriverAppResponse>({ method: "DELETE", path: "/v1/driver-app", query: params?.query, accept: "json" }, options);
  }

  /**
   * Remove a driver from the queue
   *
   * Ends a waiting place, or an offer (the connector held for the driver is released with CancelReservation and goes to the next driver). The driver gets a push notification. Audited as driver_queue.removed.
   *
   * `DELETE /v1/sites/{siteId}/queue/{entryId}` · needs `site:write`
   */
  removeDriverFromQueue(params: {
    /** Site id (UUID). */
    siteId: string;
    /** The queue place (UUID). */
    entryId: string;
  }, options?: RequestOptions): Promise<RemoveDriverFromQueueResponse> {
    return this.transport.request<RemoveDriverFromQueueResponse>({ method: "DELETE", path: "/v1/sites/{siteId}/queue/{entryId}", pathParams: { siteId: params.siteId, entryId: params.entryId }, accept: "json" }, options);
  }

  /**
   * Remove an integration's console settings
   *
   * The environment variables (or the default) apply again.
   *
   * `DELETE /v1/integrations/{kind}`
   */
  removeIntegrationConsoleSettings(params: {
    /** Integration: payments (the acquirer: QRIS, e-wallets, cards), otp (driver sign-in codes), otp_fallback, pnc_pki (Plug & Charge PKI) or map_tiles. */
    kind: string;
    query?: {
      scope?: "org" | "platform";
    };
  }, options?: RequestOptions): Promise<RemoveIntegrationConsoleSettingsResponse> {
    return this.transport.request<RemoveIntegrationConsoleSettingsResponse>({ method: "DELETE", path: "/v1/integrations/{kind}", pathParams: { kind: params.kind }, query: params.query, accept: "json" }, options);
  }

  /**
   * Remove the iOS notifications key
   *
   * The iOS app stops getting notifications; queued ones fail.
   *
   * `DELETE /v1/driver-app/apns` · needs `org:write`
   */
  removeIOSNotificationsKey(options?: RequestOptions): Promise<RemoveIOSNotificationsKeyResponse> {
    return this.transport.request<RemoveIOSNotificationsKeyResponse>({ method: "DELETE", path: "/v1/driver-app/apns", accept: "json" }, options);
  }

  /**
   * Remove an on-call override
   *
   * Removes the override; the rotation applies again for that period. Audited.
   *
   * `DELETE /v1/alert-routing/rotas/{id}/overrides/{overrideId}` · needs `alert:write`
   */
  removeOnCallOverride(params: {
    /** Rota id (UUID). */
    id: string;
    /** Override id (UUID). */
    overrideId: string;
  }, options?: RequestOptions): Promise<RemoveOnCallOverrideResponse> {
    return this.transport.request<RemoveOnCallOverrideResponse>({ method: "DELETE", path: "/v1/alert-routing/rotas/{id}/overrides/{overrideId}", pathParams: { id: params.id, overrideId: params.overrideId }, accept: "json" }, options);
  }

  /**
   * Remove a tariff assignment
   *
   * Deletes one assignment of one of your tariffs. Audited as tariff.unassigned.
   *
   * `DELETE /v1/tariff-assignments/{id}` · needs `tariff:write`
   */
  removeTariffAssignment(params: {
    /** Tariff assignment id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<RemoveTariffAssignmentResponse> {
    return this.transport.request<RemoveTariffAssignmentResponse>({ method: "DELETE", path: "/v1/tariff-assignments/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Remove a trust anchor
   *
   * Removes it from the list only; delete it from each charger with delete-certificate.
   *
   * `DELETE /v1/pnc/trust-anchors/{id}` · needs `org:write`
   */
  removeTrustAnchor(params: {
    /** Trust anchor id. */
    id: string;
  }, options?: RequestOptions): Promise<void> {
    return this.transport.request<void>({ method: "DELETE", path: "/v1/pnc/trust-anchors/{id}", pathParams: { id: params.id }, accept: "none" }, options);
  }

  /**
   * Remove a variable monitor (ClearVariableMonitoring)
   *
   * Clears the monitor on the station; the stored copy goes when the station answers Accepted or NotFound. Hard-wired monitors are refused by the station (Rejected).
   *
   * `DELETE /v1/charge-points/{identity}/device-model/monitors/{monitorId}`
   */
  removeVariableMonitorClearVariableMonitoring(params: {
    /** OCPP identity of the charge point (last path segment of its WebSocket URL), e.g. AUTEL-DC60-SMB-002. */
    identity: string;
    /** The station's monitor id (an integer). */
    monitorId: string;
  }, options?: RequestOptions): Promise<RemoveVariableMonitorClearVariableMonitoringResponse> {
    return this.transport.request<RemoveVariableMonitorClearVariableMonitoringResponse>({ method: "DELETE", path: "/v1/charge-points/{identity}/device-model/monitors/{monitorId}", pathParams: { identity: params.identity, monitorId: params.monitorId }, accept: "json" }, options);
  }

  /**
   * Rename, suspend or resume a partner
   *
   * Renames a partner and/or suspends a connected one or resumes a suspended one (409 for any other transition). A resumed partner is re-sent everything after the response. Suspension and resumption are audited.
   *
   * `PATCH /v1/roaming/partners/{id}` · needs `roaming:write`
   */
  renameSuspendOrResumePartner(params: {
    /** Roaming partner id (UUID). */
    id: string;
    body: RenameSuspendOrResumePartnerBody;
  }, options?: RequestOptions): Promise<RoamingPartner> {
    return this.transport.request<RoamingPartner>({ method: "PATCH", path: "/v1/roaming/partners/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Replace an alert contact
   *
   * Replaces the contact's name, e-mail, WhatsApp number and active flag (fields left out are cleared or defaulted). Audited.
   *
   * `PUT /v1/alert-routing/contacts/{id}` · needs `alert:write`
   */
  replaceAlertContact(params: {
    /** Contact id (UUID). */
    id: string;
    body: AlertRoutingContactInput;
  }, options?: RequestOptions): Promise<ReplaceAlertContactResponse> {
    return this.transport.request<ReplaceAlertContactResponse>({ method: "PUT", path: "/v1/alert-routing/contacts/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Replace an alert rule
   *
   * Replaces every setting of the rule (fields left out take their defaults). Audited.
   *
   * `PUT /v1/alert-routing/rules/{id}` · needs `alert:write`
   */
  replaceAlertRule(params: {
    /** Rule id (UUID). */
    id: string;
    body: AlertRoutingRuleInput;
  }, options?: RequestOptions): Promise<ReplaceAlertRuleResponse> {
    return this.transport.request<ReplaceAlertRuleResponse>({ method: "PUT", path: "/v1/alert-routing/rules/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Replace an on-call rota
   *
   * Replaces the rota: name, members in order, shift length, handover time and start date. Audited.
   *
   * `PUT /v1/alert-routing/rotas/{id}` · needs `alert:write`
   */
  replaceOnCallRota(params: {
    /** Rota id (UUID). */
    id: string;
    body: AlertRotaInput;
  }, options?: RequestOptions): Promise<ReplaceOnCallRotaResponse> {
    return this.transport.request<ReplaceOnCallRotaResponse>({ method: "PUT", path: "/v1/alert-routing/rotas/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Replay failed pushes
   *
   * Queues every failed call to a partner for delivery again. Audited as roaming.replayed.
   *
   * `POST /v1/roaming/partners/{id}/replay` · needs `roaming:write`
   */
  replayFailedPushes(params: {
    /** Roaming partner id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<ReplayFailedPushesResponse> {
    return this.transport.request<ReplayFailedPushesResponse>({ method: "POST", path: "/v1/roaming/partners/{id}/replay", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Replay failed webhook deliveries
   *
   * Puts failed deliveries of the endpoint back in the queue with attempts reset — all of them, or one with `deliveryId`. Test pings are never replayed. Audited.
   *
   * `POST /v1/webhooks/{id}/replay` · needs `webhook:write`
   */
  replayFailedWebhookDeliveries(params: {
    /** Webhook endpoint id (UUID). */
    id: string;
    body: ReplayFailedWebhookDeliveriesBody;
  }, options?: RequestOptions): Promise<ReplayFailedWebhookDeliveriesResponse> {
    return this.transport.request<ReplayFailedWebhookDeliveriesResponse>({ method: "POST", path: "/v1/webhooks/{id}/replay", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Request diagnostic logs
   *
   * Sends GetDiagnostics so the charger uploads its logs, either to your location or to a one-time URL on this deployment for the built-in log viewer. Needs charge_point:config or charge_point:command. Returns 409 when the charger is offline, and 422 (with the request id) when the location is invalid or the charger refuses or does not answer.
   *
   * `POST /v1/charge-points/{identity}/diagnostics` · needs `charge_point:read`, `charge_point:config`, `charge_point:command`
   */
  requestDiagnosticLogs(params: {
    /** OCPP identity of the charge point (last path segment of its WebSocket URL), e.g. AUTEL-DC60-SMB-002. */
    identity: string;
    body?: DiagnosticsRequestBody;
  }, options?: RequestOptions): Promise<DiagnosticsRequested> {
    return this.transport.request<DiagnosticsRequested>({ method: "POST", path: "/v1/charge-points/{identity}/diagnostics", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Re-send everything to a partner
   *
   * Queues a full publication of our shared locations, tariffs and cards to one connected partner (409 when it is not connected).
   *
   * `POST /v1/roaming/partners/{id}/sync` · needs `roaming:write`
   */
  reSendEverythingToPartner(params: {
    /** Roaming partner id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<ReSendEverythingToPartnerResponse> {
    return this.transport.request<ReSendEverythingToPartnerResponse>({ method: "POST", path: "/v1/roaming/partners/{id}/sync", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Reset a charge point
   *
   * Sends Reset. Anything other than `Hard` is sent as a Soft reset. Audited.
   *
   * `POST /v1/charge-points/{identity}/reset` · needs `charge_point:command`
   */
  resetChargePoint(params: {
    /** OCPP identity of the charge point (the last path segment of its WebSocket URL), e.g. `AUTEL-DC60-SMB-002`. */
    identity: string;
    body: ResetChargePointBody;
  }, options?: RequestOptions): Promise<CommandResult> {
    return this.transport.request<CommandResult>({ method: "POST", path: "/v1/charge-points/{identity}/reset", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Reset this sandbox's chargers
   *
   * Brings every virtual charger back online, stops running sessions and clears faults. Sessions, sites and settings are kept.
   *
   * `POST /v1/sandbox/reset` · needs `charge_point:command`
   */
  resetThisSandboxChargers(options?: RequestOptions): Promise<ResetThisSandboxChargersResponse> {
    return this.transport.request<ResetThisSandboxChargersResponse>({ method: "POST", path: "/v1/sandbox/reset", accept: "json" }, options);
  }

  /**
   * Reset a user's password
   *
   * Issues a new one-time password (shown only in this response), clears any lock and ends every existing session of the user. The user must choose a new password at next sign-in. Audited.
   *
   * `POST /v1/users/{id}/reset-password` · needs `user:write`
   */
  resetUserPassword(params: {
    /** User id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<UserPasswordReset> {
    return this.transport.request<UserPasswordReset>({ method: "POST", path: "/v1/users/{id}/reset-password", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Resolve an alert
   *
   * Closes an open alert. Contacts who were notified get a "resolved" notice if their rule asks for one. Audited.
   *
   * `POST /v1/alerts/{id}/resolve` · needs `charge_point:write`
   */
  resolveAlert(params: {
    /** Alert id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<ResolveAlertResponse> {
    return this.transport.request<ResolveAlertResponse>({ method: "POST", path: "/v1/alerts/{id}/resolve", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Resume a suspended charge point
   *
   * Returns a suspended charge point to service; a connected unit is asked to boot again at once so it is Accepted without waiting. 409 when it is not suspended. Audited as charge_point.resumed.
   *
   * `POST /v1/charge-points/{identity}/resume` · needs `charge_point:write`
   */
  resumeSuspendedChargePoint(params: {
    /** OCPP identity of the charge point (the last path segment of its WebSocket URL), e.g. `AUTEL-DC60-SMB-002`. */
    identity: string;
  }, options?: RequestOptions): Promise<ResumeSuspendedChargePointResponse> {
    return this.transport.request<ResumeSuspendedChargePointResponse>({ method: "POST", path: "/v1/charge-points/{identity}/resume", pathParams: { identity: params.identity }, accept: "json" }, options);
  }

  /**
   * Retry a card hold capture or release now
   *
   * Runs a failed (or pending) capture or release again at the acquirer, without waiting for the automatic retry. 409 with `error` and `state` when the acquirer refuses again. Audited.
   *
   * `POST /v1/card-holds/{id}/retry` · needs `payment:write`
   */
  retryCardHoldCaptureOrReleaseNow(params: {
    /** Payment intent id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<RetryCardHoldCaptureOrReleaseNowResponse> {
    return this.transport.request<RetryCardHoldCaptureOrReleaseNowResponse>({ method: "POST", path: "/v1/card-holds/{id}/retry", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Retry a failed alert notification
   *
   * Puts a failed notification (not a test message) back in the queue with its attempts reset, e.g. after fixing the channel settings. Audited.
   *
   * `POST /v1/alert-routing/log/{id}/retry` · needs `alert:write`
   */
  retryFailedAlertNotification(params: {
    /** Notification id (a positive integer). */
    id: string;
  }, options?: RequestOptions): Promise<RetryFailedAlertNotificationResponse> {
    return this.transport.request<RetryFailedAlertNotificationResponse>({ method: "POST", path: "/v1/alert-routing/log/{id}/retry", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Retry failed firmware jobs
   *
   * Resets every failed job to pending with zero attempts and sets the campaign back to running (unless it was cancelled). Audited as firmware.campaign_retried.
   *
   * `POST /v1/firmware/campaigns/{id}/retry-failed` · needs `firmware:write`
   */
  retryFailedFirmwareJobs(params: {
    /** Campaign id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<RetryFailedFirmwareJobsResponse> {
    return this.transport.request<RetryFailedFirmwareJobsResponse>({ method: "POST", path: "/v1/firmware/campaigns/{id}/retry-failed", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Revoke an API key
   *
   * Revokes a key immediately. The row stays in the list with `revoked_at` set.
   *
   * `DELETE /v1/api-keys/{id}` · needs `org:write`
   */
  revokeApiKey(params: {
    /** API key id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<RevokeApiKeyResponse> {
    return this.transport.request<RevokeApiKeyResponse>({ method: "DELETE", path: "/v1/api-keys/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Revoke a test contract certificate
   *
   * Test PKI only. Its OCSP responder answers revoked from now on.
   *
   * `POST /v1/pnc/test-contracts/{serial}/revoke` · needs `token:write`
   */
  revokeTestContractCertificate(params: {
    /** Certificate serial number (hex). */
    serial: string;
  }, options?: RequestOptions): Promise<RevokeTestContractCertificateResponse> {
    return this.transport.request<RevokeTestContractCertificateResponse>({ method: "POST", path: "/v1/pnc/test-contracts/{serial}/revoke", pathParams: { serial: params.serial }, accept: "json" }, options);
  }

  /**
   * Rotate a sandbox's API key
   *
   * Revokes every key of the sandbox and returns a new one (shown once).
   *
   * `POST /v1/sandboxes/{id}/rotate-key` · needs `org:write`
   */
  rotateSandboxApiKey(params: {
    /** Sandbox id. */
    id: string;
  }, options?: RequestOptions): Promise<RotateSandboxApiKeyResponse> {
    return this.transport.request<RotateSandboxApiKeyResponse>({ method: "POST", path: "/v1/sandboxes/{id}/rotate-key", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Rotate a webhook signing secret
   *
   * Replaces the signing secret at once; deliveries from now on are signed with the new one. The new secret is returned only in this response. Audited.
   *
   * `POST /v1/webhooks/{id}/rotate-secret` · needs `webhook:write`
   */
  rotateWebhookSigningSecret(params: {
    /** Webhook endpoint id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<RotateWebhookSigningSecretResponse> {
    return this.transport.request<RotateWebhookSigningSecretResponse>({ method: "POST", path: "/v1/webhooks/{id}/rotate-secret", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Save an alert channel
   *
   * Sets the e-mail (SMTP), WhatsApp (Cloud API) or SMS (Twilio, Zenziva or your own gateway) sender. `secret` is write-only: sealed at rest, never returned and never written to the audit log; omit it to keep the stored one. WhatsApp and SMS always need one; SMTP needs a password when a username is set. For WhatsApp, `webhookSecret` is the Meta app secret used to check delivery-status webhooks (write-only too); the first save creates the webhook path and verify token. Audited.
   *
   * `PUT /v1/alert-routing/channels/{kind}` · needs `alert:write`
   */
  saveAlertChannel(params: {
    /** Channel: `email`, `whatsapp` or `sms`. */
    kind: string;
    body: SaveAlertChannelBody;
  }, options?: RequestOptions): Promise<SaveAlertChannelResponse> {
    return this.transport.request<SaveAlertChannelResponse>({ method: "PUT", path: "/v1/alert-routing/channels/{kind}", pathParams: { kind: params.kind }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Save fleet billing settings
   *
   * Seller NPWP / NITKU / address, invoice prefix, payment instructions and the e-Faktur item settings. Changing the item type, code or unit clears the tax-adviser confirmation, which must be given again before the next export.
   *
   * `PUT /v1/fleet-billing/settings` · needs `invoice:write`
   */
  saveFleetBillingSettings(params: {
    body: SaveFleetBillingSettingsBody;
  }, options?: RequestOptions): Promise<FleetBillingSettings> {
    return this.transport.request<FleetBillingSettings>({ method: "PUT", path: "/v1/fleet-billing/settings", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Save the loyalty program
   *
   * Switch loyalty on or off and set the earn rate, the value of a point, the most points may pay of a session and when points expire. Changes apply to sessions rated from now on; points already earned keep their expiry. Audited.
   *
   * `PUT /v1/loyalty` · needs `tariff:write`
   */
  saveLoyaltyProgram(params: {
    body: LoyaltyProgram;
  }, options?: RequestOptions): Promise<LoyaltyStats> {
    return this.transport.request<LoyaltyStats>({ method: "PUT", path: "/v1/loyalty", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Search charging sessions
   *
   * Returns sessions newest first with the frozen CDR tax breakdown and the derived payment status, plus totals over all matching sessions. Site-scoped users see only their sites, masked cards and no holder names. Each filter may be given once; a bad siteId, from or to is refused with 400.
   *
   * `GET /v1/sessions/search` · needs `session:read`
   */
  searchChargingSessions(params?: {
    query?: {
      /** Sessions that started at or after this instant (any date or date-time Date() can parse). */
      from?: string;
      /** Sessions that started before this instant. */
      to?: string;
      /** Only sessions at this site (UUID). */
      siteId?: string;
      /** Only sessions on this charge point (OCPP identity). */
      identity?: string;
      /** AC or DC (current type), or a plug code such as cCCS2 or sType2. */
      connectorType?: string;
      /** Derived payment status. */
      paymentStatus?: "paid" | "invoiced" | "pending" | "unbilled" | "review" | "in_progress" | "failed" | "refunded" | "free" | "held" | "released";
      /** Session state (active, ended, rated, settled, disputed). */
      state?: string;
      /** Session id, OCPP transaction id or card UID. Org-wide users get a substring match on the card UID; site-scoped users only whole-value matches. */
      q?: string;
      /** Page size; default 100, 1-500. */
      limit?: number;
      /** Rows to skip; default 0. */
      offset?: number;
    };
  }, options?: RequestOptions): Promise<SessionSearchResult> {
    return this.transport.request<SessionSearchResult>({ method: "GET", path: "/v1/sessions/search", query: params?.query, accept: "json" }, options);
  }

  /**
   * Send a command to a charge point
   *
   * Generic command dispatcher; the named routes (remote-start, unlock, …) run the same code. Every command is written to the audit log with the caller. The configuration commands (get-configuration, change-configuration, get-diagnostics) also accept `charge_point:config`. A charger that is not connected makes the call fail with 500. Remote start answers 409 when the connector’s meter verification (tera) has lapsed or is pending.
   *
   * `POST /v1/charge-points/{identity}/commands/{command}` · needs `charge_point:command`
   */
  sendCommandToChargePoint(params: {
    /** OCPP identity of the charge point (the last path segment of its WebSocket URL), e.g. `AUTEL-DC60-SMB-002`. */
    identity: string;
    /** remote-start | remote-stop | reset | unlock | change-availability | trigger | get-configuration | change-configuration | clear-cache | set-charging-profile | clear-charging-profile | get-composite-schedule | data-transfer | get-diagnostics | update-firmware | reserve-now | cancel-reservation */
    command: string;
    /** Fields depend on the command; see the named routes for the common ones. */
    body: SendCommandToChargePointBody;
  }, options?: RequestOptions): Promise<CommandResult> {
    return this.transport.request<CommandResult>({ method: "POST", path: "/v1/charge-points/{identity}/commands/{command}", pathParams: { identity: params.identity, command: params.command }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Send a command to a partner
   *
   * Sends an OCPI command to a CPO partner for one of our cards: START_SESSION (card and location), STOP_SESSION (session) or UNLOCK_CONNECTOR (location, EVSE and connector). The CPO answers at once; the charger’s result arrives later (see GET /v1/roaming/commands). 409 when the partner is not connected or takes no commands, 422 when a required field is missing or the card is not shared. Audited.
   *
   * `POST /v1/roaming/commands` · needs `roaming:write`
   */
  sendCommandToPartner(params: {
    body: SendCommandToPartnerBody;
  }, options?: RequestOptions): Promise<RoamingCommandSent> {
    return this.transport.request<RoamingCommandSent>({ method: "POST", path: "/v1/roaming/commands", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Send a test alert message
   *
   * Sends a test message on the saved channel now (not queued), records it in the notification log and on the channel. Answers 200 when the send was attempted — check `ok` and `error`. Audited.
   *
   * `POST /v1/alert-routing/channels/{kind}/test` · needs `alert:write`
   */
  sendTestAlertMessage(params: {
    /** Channel: `email`, `whatsapp` or `sms`. */
    kind: string;
    body: SendTestAlertMessageBody;
  }, options?: RequestOptions): Promise<SendTestAlertMessageResponse> {
    return this.transport.request<SendTestAlertMessageResponse>({ method: "POST", path: "/v1/alert-routing/channels/{kind}/test", pathParams: { kind: params.kind }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Send a test ping to a webhook
   *
   * Sends a signed `ping` event now and reports the receiver's answer; the attempt is recorded as a delivery. Answers 200 even when the receiver fails — check `ok`, `status` and `error`.
   *
   * `POST /v1/webhooks/{id}/test` · needs `webhook:write`
   */
  sendTestPingToWebhook(params: {
    /** Webhook endpoint id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<WebhookSendResult> {
    return this.transport.request<WebhookSendResult>({ method: "POST", path: "/v1/webhooks/{id}/test", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Set connector load-management priorities
   *
   * Sets the priority of each listed connector (clamped to -100..100; higher wins under the priority strategy). Every connector must be at this site, or the request is refused with 400; entries before the bad one are applied. Audited as site.power_priorities.changed.
   *
   * `PUT /v1/sites/{siteId}/power/priorities` · needs `smartcharging:write`
   */
  setConnectorLoadManagementPriorities(params: {
    /** Site id (UUID). */
    siteId: string;
    body: CurtailPriorityList;
  }, options?: RequestOptions): Promise<SetConnectorLoadManagementPrioritiesResponse> {
    return this.transport.request<SetConnectorLoadManagementPrioritiesResponse>({ method: "PUT", path: "/v1/sites/{siteId}/power/priorities", pathParams: { siteId: params.siteId }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the EVSE and connector topology
   *
   * Creates or updates EVSEs and connectors with nameplate and metrology data; nothing is deleted, because sessions reference connectors. On OCPP 1.6 each EVSE may have only one connector (a second gun is a second EVSE). Invalid topologies are refused with 422 listing every problem. Audited as charge_point.topology_changed.
   *
   * `PUT /v1/charge-points/{identity}/evses` · needs `charge_point:write`
   */
  setEvseAndConnectorTopology(params: {
    /** OCPP identity of the charge point (last path segment of its WebSocket URL), e.g. AUTEL-DC60-SMB-002. */
    identity: string;
    body: EvseTopology;
  }, options?: RequestOptions): Promise<SetEvseAndConnectorTopologyResponse> {
    return this.transport.request<SetEvseAndConnectorTopologyResponse>({ method: "PUT", path: "/v1/charge-points/{identity}/evses", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the roaming identity
   *
   * Sets the country code and party id partners know this operator by, and the business name they see. Changing the party id while any partner is connected, or choosing one another organisation uses, is refused with 409. Audited as roaming.identity_set.
   *
   * `PUT /v1/roaming/party` · needs `roaming:write`
   */
  setRoamingIdentity(params: {
    body: SetRoamingIdentityBody;
  }, options?: RequestOptions): Promise<SetRoamingIdentityResponse> {
    return this.transport.request<SetRoamingIdentityResponse>({ method: "PUT", path: "/v1/roaming/party", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the security profile
   *
   * Sets the OCPP security profile the gateway enforces. Refused with 409 when the charger could no longer connect: profile 1–2 without an AuthorizationKey, profile 3 without a client-certificate binding, or profile 2+ when the gateway has no TLS. Audited.
   *
   * `PUT /v1/charge-points/{identity}/security-profile` · needs `charge_point:write`
   */
  setSecurityProfile(params: {
    /** OCPP identity of the charge point (the last path segment of its WebSocket URL), e.g. `AUTEL-DC60-SMB-002`. */
    identity: string;
    body: SetSecurityProfileBody;
  }, options?: RequestOptions): Promise<SetSecurityProfileResponse> {
    return this.transport.request<SetSecurityProfileResponse>({ method: "PUT", path: "/v1/charge-points/{identity}/security-profile", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set a site owner's commercial plan
   *
   * Sets the rates agreed with the owner from a month on (a new version, or a correction of that month's version); `plan: null` returns to the published rates. A month already finalised cannot be re-priced. Audited.
   *
   * `PUT /v1/billing/owners/{id}/plan` · needs `invoice:write`
   */
  setSiteOwnerCommercialPlan(params: {
    /** Site owner id (UUID) of the caller's organisation. */
    id: string;
    body: BillingPlanInput;
  }, options?: RequestOptions): Promise<BillingPlanSaved> {
    return this.transport.request<BillingPlanSaved>({ method: "PUT", path: "/v1/billing/owners/{id}/plan", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set a site owner's sites
   *
   * Makes exactly these sites the owner's; sites no longer listed lose the owner. A site that belongs (or last belonged) to another owner and has charging history is refused with 409, as is an unknown site — create a new site for the new owner instead. The owner must not be archived. Audited.
   *
   * `PUT /v1/owners/{id}/sites` · needs `site:write`
   */
  setSiteOwnerSites(params: {
    /** Site owner id (UUID) of the caller's organisation. */
    id: string;
    body: SetSiteOwnerSitesBody;
  }, options?: RequestOptions): Promise<SetSiteOwnerSitesResponse> {
    return this.transport.request<SetSiteOwnerSitesResponse>({ method: "PUT", path: "/v1/owners/{id}/sites", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the site power budget
   *
   * Sets the site’s power ceiling, auxiliary reserve, allocation strategy and curtailment (e.g. running on genset). Omitted fields keep their value. A ceiling above the PLN subscription (connected kVA × PF), or a reserve not below the ceiling, is refused with 422. A change in curtailment, or `applyNow`, runs the load manager right after the response. Audited as site.power_budget.changed.
   *
   * `PUT /v1/sites/{siteId}/power/budget` · needs `smartcharging:write`
   */
  setSitePowerBudget(params: {
    /** Site id (UUID). */
    siteId: string;
    body: SetSitePowerBudgetBody;
  }, options?: RequestOptions): Promise<PowerSiteBudget> {
    return this.transport.request<PowerSiteBudget>({ method: "PUT", path: "/v1/sites/{siteId}/power/budget", pathParams: { siteId: params.siteId }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set a variable (SetVariables)
   *
   * Checks the value against what the station reported (data type, limits, allowed values, mutability) and sends SetVariables; the stored value changes when the station accepts (Accepted or RebootRequired). SecurityCtrlr variables, the network-connection priority and credentials are refused (400) — they have their own safe flows.
   *
   * `PUT /v1/charge-points/{identity}/device-model/variable`
   */
  setVariableSetVariables(params: {
    /** OCPP identity of the charge point (last path segment of its WebSocket URL), e.g. AUTEL-DC60-SMB-002. */
    identity: string;
    body: SetVariableSetVariablesBody;
  }, options?: RequestOptions): Promise<SetVariableSetVariablesResponse> {
    return this.transport.request<SetVariableSetVariablesResponse>({ method: "PUT", path: "/v1/charge-points/{identity}/device-model/variable", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Share or unshare cards
   *
   * Lets the chosen RFID cards (or, with `all: true`, every active card) charge on partner networks, or stops that. A card gets a contract id when first shared. Requires the roaming identity (409 otherwise). Published to partners after the response. Audited.
   *
   * `PUT /v1/roaming/cards` · needs `roaming:write`
   */
  shareOrUnshareCards(params: {
    body: ShareOrUnshareCardsBody;
  }, options?: RequestOptions): Promise<ShareOrUnshareCardsResponse> {
    return this.transport.request<ShareOrUnshareCardsResponse>({ method: "PUT", path: "/v1/roaming/cards", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Share or withdraw a site
   *
   * Sets a site’s city and/or whether it is shared with roaming partners. Sharing a site that is incomplete (no coordinates, address or city; archived; private-billed) is refused with 422. Changes are published to partners after the response. Sharing and withdrawal are audited.
   *
   * `PUT /v1/roaming/sites/{id}` · needs `roaming:write`
   */
  shareOrWithdrawSite(params: {
    /** Site id (UUID). */
    id: string;
    body: ShareOrWithdrawSiteBody;
  }, options?: RequestOptions): Promise<ShareOrWithdrawSiteResponse> {
    return this.transport.request<ShareOrWithdrawSiteResponse>({ method: "PUT", path: "/v1/roaming/sites/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Simulate an event at a virtual charger
   *
   * Acts out what happens at a real charger, so your integration sees the same OCPP traffic, sessions, alerts and webhooks as in production:
   *
   * - `plug-in` — a cable is connected (connector goes Preparing)
   * - `tap-card` — an RFID card is tapped: Authorize, then a session starts (give `idTag`, optionally `kwh` to stop by itself)
   * - `plug-and-charge` — an ISO 15118 car plugs in with its contract (give `emaid`): the test PKI issues its contract certificate, the charger sends Authorize with the certificate hash data, the CSMS checks it (OCSP) and the contract, and the session starts. Set up first under Plug & Charge: switch it on, register the contract, fetch and install the trust anchors, request the charger's certificate
   * - `stop` — the driver stops at the charger; `unplug` — the car is unplugged (ends a session with EVDisconnected)
   * - `fault` / `clear-fault` — a connector fault (default `GroundFailure`, optional `vendorErrorCode`, `info`); a fault stops a running session
   * - `go-offline` / `come-online` — the 4G link drops and returns; a running session carries on and its messages are sent on reconnect
   * - `reboot` — power cycle; `status` — just report.
   *
   * Commands you send through the normal API (remote start/stop, reset, unlock, configuration, reservations, firmware updates, diagnostics) are answered by the virtual charger too.
   *
   * `POST /v1/sandbox/chargers/{identity}/simulate` · needs `charge_point:command`
   */
  simulateEventAtVirtualCharger(params: {
    /** OCPP identity of a virtual charger in this sandbox, e.g. `SBX-3F9A1C-DC60`. */
    identity: string;
    body: SimulateEventAtVirtualChargerBody;
  }, options?: RequestOptions): Promise<SimulateEventAtVirtualChargerResponse> {
    return this.transport.request<SimulateEventAtVirtualChargerResponse>({ method: "POST", path: "/v1/sandbox/chargers/{identity}/simulate", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Simulate a QRIS payment
   *
   * Development only (403 elsewhere): marks a sandbox QRIS charge paid and its payment intent captured.
   *
   * `POST /v1/checkout/qris/{providerRef}/simulate-payment` · needs `payment:write`
   */
  simulateQrisPayment(params: {
    /** The `qr.providerRef` returned by checkout. */
    providerRef: string;
  }, options?: RequestOptions): Promise<SimulateQrisPaymentResponse> {
    return this.transport.request<SimulateQrisPaymentResponse>({ method: "POST", path: "/v1/checkout/qris/{providerRef}/simulate-payment", pathParams: { providerRef: params.providerRef }, accept: "json" }, options);
  }

  /**
   * The site's driver queue
   *
   * The queue policy (queueEnabled and friends on the site), then every driver waiting or holding an offer, in order, and the places that ended in the last 24 hours (served, missed, left, expired, removed). Drivers are shown as a masked phone number or their fleet card. waiting drivers have a position: 1 + the drivers ahead of them who could take a connector they could. stats.medianWaitMinutes is the median time from joining to the offer for drivers served in the last 24 hours.
   *
   * `GET /v1/sites/{siteId}/queue` · needs `site:read`
   */
  siteDriverQueue(params: {
    /** Site id (UUID). */
    siteId: string;
  }, options?: RequestOptions): Promise<SiteDriverQueueResponse> {
    return this.transport.request<SiteDriverQueueResponse>({ method: "GET", path: "/v1/sites/{siteId}/queue", pathParams: { siteId: params.siteId }, accept: "json" }, options);
  }

  /**
   * Start a session remotely
   *
   * Sends RemoteStartTransaction for an RFID tag or driver account, optionally capped by energy, duration or amount. Refused with 409 when the connector’s meter verification (tera) has lapsed or awaits calibration. A caller without `session:write` (e.g. a field technician) may only start with a technician or VIP card (403 otherwise). Audited.
   *
   * `POST /v1/charge-points/{identity}/remote-start` · needs `charge_point:command`
   */
  startSessionRemotely(params: {
    /** OCPP identity of the charge point (the last path segment of its WebSocket URL), e.g. `AUTEL-DC60-SMB-002`. */
    identity: string;
    body: StartSessionRemotelyBody;
  }, options?: RequestOptions): Promise<CommandRemoteStartResult> {
    return this.transport.request<CommandRemoteStartResult>({ method: "POST", path: "/v1/charge-points/{identity}/remote-start", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Stop a session remotely
   *
   * Sends RemoteStopTransaction. The transaction id is an integer on OCPP 1.6 and the station’s own string on 2.0.1. Audited.
   *
   * `POST /v1/charge-points/{identity}/remote-stop` · needs `charge_point:command`
   */
  stopSessionRemotely(params: {
    /** OCPP identity of the charge point (the last path segment of its WebSocket URL), e.g. `AUTEL-DC60-SMB-002`. */
    identity: string;
    body: StopSessionRemotelyBody;
  }, options?: RequestOptions): Promise<CommandResult> {
    return this.transport.request<CommandResult>({ method: "POST", path: "/v1/charge-points/{identity}/remote-stop", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Stream live events
   *
   * Server-sent events for the caller’s organisation: each message is `data: {"kind": …, "payload": …}` (connector status, session energy, alerts, …). A comment ping is sent every 25 seconds. Events that cannot be attributed to the organisation are not delivered.
   *
   * `GET /v1/stream` · needs `site:read`
   */
  streamLiveEvents(options?: RequestOptions): Promise<Response> {
    return this.transport.request<Response>({ method: "GET", path: "/v1/stream", accept: "stream" }, options);
  }

  /**
   * Stream raw OCPP frames
   *
   * Server-sent events: each new OCPP frame of your organisation (or of one charger) arrives as a data line holding a JSON object with id, ts, ocpp_identity, direction (in or out), message_type (2, 3 or 4), action, unique_id and payload. Frames are polled every 1.5 s, only frames after the connection opened are sent, and a comment ping keeps the stream alive every 25 s. Site-scoped users need charge_point:config or charge_point:command, because the log carries card idTags; read-only viewers get 403.
   *
   * `GET /v1/events/frames` · needs `charge_point:read`, `charge_point:config`, `charge_point:command`
   */
  streamRawOcppFrames(params?: {
    query?: {
      /** Only frames of this charge point. */
      identity?: string;
    };
  }, options?: RequestOptions): Promise<Response> {
    return this.transport.request<Response>({ method: "GET", path: "/v1/events/frames", query: params?.query, accept: "stream" }, options);
  }

  /**
   * Suggest registered identities
   *
   * Up to 5 charge points in the caller’s own fleet whose identity resembles the given one (case-insensitive or substring match) — the usual cause of a refused connection.
   *
   * `GET /v1/pending-chargers/{identity}/suggestions` · needs `charge_point:read`
   */
  suggestRegisteredIdentities(params: {
    /** The identity the charger presented. */
    identity: string;
  }, options?: RequestOptions): Promise<PendingChargerSuggestion[]> {
    return this.transport.request<PendingChargerSuggestion[]>({ method: "GET", path: "/v1/pending-chargers/{identity}/suggestions", pathParams: { identity: params.identity }, accept: "json" }, options);
  }

  /**
   * Summarise connection attempts
   *
   * Counts of accepted, pending-adoption and refused attempts, and distinct identities, by the organisation’s charge points over a recent window.
   *
   * `GET /v1/connection-attempts/stats` · needs `charge_point:read`
   */
  summariseConnectionAttempts(params?: {
    query?: {
      /** Window length in minutes. */
      minutes?: number;
    };
  }, options?: RequestOptions): Promise<ConnectionAttemptStats> {
    return this.transport.request<ConnectionAttemptStats>({ method: "GET", path: "/v1/connection-attempts/stats", query: params?.query, accept: "json" }, options);
  }

  /**
   * Suspend a charge point
   *
   * Takes a charge point out of service without revoking its credentials: it stays connected, its BootNotification is answered Pending, and new authorisations, starts and remote starts are refused. A session already running finishes normally and is billed. 409 when it is already suspended, awaiting adoption or decommissioned. The optional reason is recorded in the audit entry charge_point.suspended.
   *
   * `POST /v1/charge-points/{identity}/suspend` · needs `charge_point:write`
   */
  suspendChargePoint(params: {
    /** OCPP identity of the charge point (the last path segment of its WebSocket URL), e.g. `AUTEL-DC60-SMB-002`. */
    identity: string;
    body?: SuspendChargePointBody;
  }, options?: RequestOptions): Promise<SuspendChargePointResponse> {
    return this.transport.request<SuspendChargePointResponse>({ method: "POST", path: "/v1/charge-points/{identity}/suspend", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Switch Plug & Charge on or off at a charger
   *
   * Marks the charger as Plug & Charge capable (its V2G certificate is then renewed before it expires) and sets `ISO15118PnCEnabled` (1.6) / `ISO15118Ctrlr.PnCEnabled` (2.0.1).
   *
   * `POST /v1/pnc/chargers/{identity}/enable` · needs `charge_point:config`
   */
  switchPlugChargeOnOrOffAtCharger(params: {
    /** OCPP identity. */
    identity: string;
    body: SwitchPlugChargeOnOrOffAtChargerBody;
  }, options?: RequestOptions): Promise<SwitchPlugChargeOnOrOffAtChargerResponse> {
    return this.transport.request<SwitchPlugChargeOnOrOffAtChargerResponse>({ method: "POST", path: "/v1/pnc/chargers/{identity}/enable", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Switch signed meter readings on or off
   *
   * Asks an OCPP 2.0.1 / 2.1 station to sign its readings (SetVariables SampledDataCtrlr.SignReadings and AlignedDataCtrlr.SignReadings) and to send its meter key once per transaction (OCPPCommCtrlr.PublicKeyWithSignedMeterValue). 409 for OCPP 1.6, which has no standard setting: use the vendor’s configuration.
   *
   * `POST /v1/charge-points/{identity}/signed-metering` · needs `charge_point:config`
   */
  switchSignedMeterReadingsOnOrOff(params: {
    /** OCPP identity of the charge point. */
    identity: string;
    body?: SwitchSignedMeterReadingsOnOrOffBody;
  }, options?: RequestOptions): Promise<SwitchSignedMeterReadingsOnOrOffResponse> {
    return this.transport.request<SwitchSignedMeterReadingsOnOrOffResponse>({ method: "POST", path: "/v1/charge-points/{identity}/signed-metering", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Test an integration
   *
   * Checks the credentials without moving money: the acquirer's authentication, the messaging account (and, with a phone number, a real test code), the PKI gateway's roots, a map tile.
   *
   * `POST /v1/integrations/{kind}/test`
   */
  testIntegration(params: {
    /** Integration: payments (the acquirer: QRIS, e-wallets, cards), otp (driver sign-in codes), otp_fallback, pnc_pki (Plug & Charge PKI) or map_tiles. */
    kind: string;
    body: TestIntegrationBody;
  }, options?: RequestOptions): Promise<TestIntegrationResponse> {
    return this.transport.request<TestIntegrationResponse>({ method: "POST", path: "/v1/integrations/{kind}/test", pathParams: { kind: params.kind }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Trigger a message from a charge point
   *
   * Sends TriggerMessage, asking the charger to send a message now (StatusNotification by default). Audited.
   *
   * `POST /v1/charge-points/{identity}/trigger` · needs `charge_point:command`
   */
  triggerMessageFromChargePoint(params: {
    /** OCPP identity of the charge point (the last path segment of its WebSocket URL), e.g. `AUTEL-DC60-SMB-002`. */
    identity: string;
    body: TriggerMessageFromChargePointBody;
  }, options?: RequestOptions): Promise<CommandResult> {
    return this.transport.request<CommandResult>({ method: "POST", path: "/v1/charge-points/{identity}/trigger", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Unlock a connector
   *
   * Sends UnlockConnector, e.g. to release a cable stuck in the socket. Audited.
   *
   * `POST /v1/charge-points/{identity}/unlock` · needs `charge_point:command`
   */
  unlockConnector(params: {
    /** OCPP identity of the charge point (the last path segment of its WebSocket URL), e.g. `AUTEL-DC60-SMB-002`. */
    identity: string;
    body: UnlockConnectorBody;
  }, options?: RequestOptions): Promise<CommandResult> {
    return this.transport.request<CommandResult>({ method: "POST", path: "/v1/charge-points/{identity}/unlock", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Update a charge point profile
   *
   * Changes only the fields sent (text fields are cut to 200 characters). Moving to another site needs charge_point:write at the target site and is limited to sites of the same organisation. Audited as charge_point.updated.
   *
   * `PUT /v1/charge-points/{identity}` · needs `charge_point:write`
   */
  updateChargePointProfile(params: {
    /** OCPP identity of the charge point (last path segment of its WebSocket URL), e.g. AUTEL-DC60-SMB-002. */
    identity: string;
    body: CpDetailProfileInput;
  }, options?: RequestOptions): Promise<UpdateChargePointProfileResponse> {
    return this.transport.request<UpdateChargePointProfileResponse>({ method: "PUT", path: "/v1/charge-points/{identity}", pathParams: { identity: params.identity }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Update a console user
   *
   * Changes name and phone, replaces the role (with its sites or owner), or sets the status. Disabling a user ends all their sessions. You cannot change your own role or status. Audited.
   *
   * `PUT /v1/users/{id}` · needs `user:write`
   */
  updateConsoleUser(params: {
    /** User id (UUID). */
    id: string;
    body: UserUpdateInput;
  }, options?: RequestOptions): Promise<UpdateConsoleUserResponse> {
    return this.transport.request<UpdateConsoleUserResponse>({ method: "PUT", path: "/v1/users/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Update a fleet account
   *
   * Renaming the account renames the fleet on its cards too. Issued invoices keep the details they were issued with.
   *
   * `PUT /v1/fleet-accounts/{id}` · needs `invoice:write`
   */
  updateFleetAccount(params: {
    /** Fleet account id. */
    id: string;
    body: FleetAccountInput;
  }, options?: RequestOptions): Promise<FleetAccountDetail> {
    return this.transport.request<FleetAccountDetail>({ method: "PUT", path: "/v1/fleet-accounts/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Update a membership plan
   *
   * Changes apply to sessions rated from now on.
   *
   * `PUT /v1/subscription-plans/{id}` · needs `tariff:write`
   */
  updateMembershipPlan(params: {
    /** Plan id. */
    id: string;
    body: SubscriptionPlanInput;
  }, options?: RequestOptions): Promise<SubscriptionPlan> {
    return this.transport.request<SubscriptionPlan>({ method: "PUT", path: "/v1/subscription-plans/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Update Plug & Charge settings
   *
   * **Permissions checked:** `org:write`.
   *
   * `PUT /v1/pnc/settings` · needs `org:write`
   */
  updatePlugChargeSettings(params: {
    body: PncSettings;
  }, options?: RequestOptions): Promise<PncSettings> {
    return this.transport.request<PncSettings>({ method: "PUT", path: "/v1/pnc/settings", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Update a promotion
   *
   * Set `active: false` to stop it. Sessions already rated keep their discount.
   *
   * `PUT /v1/promotions/{id}` · needs `tariff:write`
   */
  updatePromotion(params: {
    /** Promotion id. */
    id: string;
    body: PromotionInput;
  }, options?: RequestOptions): Promise<Promotion> {
    return this.transport.request<Promotion>({ method: "PUT", path: "/v1/promotions/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Update an RFID card
   *
   * Changes only the fields sent; the UID cannot be changed. Setting a PIN resets the driver-app PIN lockout. After the response, roaming partners are told about the change. When the status changes, push the local list so offline chargers learn it. Audited as token.updated, or token.blocked when blocking.
   *
   * `PUT /v1/tokens/{id}` · needs `token:write`
   */
  updateRfidCard(params: {
    /** Card id (UUID). */
    id: string;
    body: TokenInput;
  }, options?: RequestOptions): Promise<TokenUpdated> {
    return this.transport.request<TokenUpdated>({ method: "PUT", path: "/v1/tokens/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Update a site
   *
   * Changes only the fields sent; validation runs against the merged record and refuses invalid input with 422. When the subscribed capacity or power factor drops, a stored DLM ceiling above the new subscription ceiling is lowered to it. Audited as site.updated.
   *
   * `PUT /v1/sites/{siteId}` · needs `site:write`
   */
  updateSite(params: {
    /** Site id (UUID). */
    siteId: string;
    body: SiteInput;
  }, options?: RequestOptions): Promise<SiteSaved> {
    return this.transport.request<SiteSaved>({ method: "PUT", path: "/v1/sites/{siteId}", pathParams: { siteId: params.siteId }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Update a site owner
   *
   * Changes the fields given; `archived: true` archives the owner, `false` restores it. At least one field is required. Audited.
   *
   * `PUT /v1/owners/{id}` · needs `site:write`
   */
  updateSiteOwner(params: {
    /** Site owner id (UUID) of the caller's organisation. */
    id: string;
    body: UpdateSiteOwnerBody;
  }, options?: RequestOptions): Promise<UpdateSiteOwnerResponse> {
    return this.transport.request<UpdateSiteOwnerResponse>({ method: "PUT", path: "/v1/owners/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Update a webhook endpoint
   *
   * Changes the URL, description, subscribed events or state. Setting state `active` (e.g. re-enabling a disabled endpoint) resets the failure streak. At least one field is required. Audited.
   *
   * `PATCH /v1/webhooks/{id}` · needs `webhook:write`
   */
  updateWebhookEndpoint(params: {
    /** Webhook endpoint id (UUID). */
    id: string;
    body: UpdateWebhookEndpointBody;
  }, options?: RequestOptions): Promise<UpdateWebhookEndpointResponse> {
    return this.transport.request<UpdateWebhookEndpointResponse>({ method: "PATCH", path: "/v1/webhooks/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Upload the app icon
   *
   * A square PNG, 512 to 2048 pixels (1024 is best), up to 2 MB, as base64. The launcher, store, maskable and App Store icons are made from it.
   *
   * `PUT /v1/driver-app/icon` · needs `org:write`
   */
  uploadAppIcon(params: {
    body: UploadAppIconBody;
  }, options?: RequestOptions): Promise<UploadAppIconResponse> {
    return this.transport.request<UploadAppIconResponse>({ method: "PUT", path: "/v1/driver-app/icon", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Upload a firmware image
   *
   * Send the raw file as the request body with Content-Type application/octet-stream; the metadata (name, version, vendor, compatibleModels, sha256, notes, fileName) goes in the query string. The file is streamed to storage and hashed; files over the size cap (MAX_FIRMWARE_BYTES, 512 MiB by default) are refused with 413, and a declared sha256 that does not match is refused with 400 and the file discarded. Chargers download uploaded images from an unguessable URL on this deployment. Audited as firmware.image_uploaded.
   *
   * `POST /v1/firmware/images/upload` · needs `firmware:write`
   */
  uploadFirmwareImage(params: {
    query: {
      /** Image name. */
      name: string;
      /** The version string the charger will report after the update. */
      version: string;
      /** Vendor. */
      vendor?: string;
      /** Comma-separated model names a campaign may target. */
      compatibleModels?: string;
      /** Declared SHA-256 (64 hex); the upload is refused if the file does not match. */
      sha256?: string;
      /** Notes. */
      notes?: string;
      /** Stored file name (sanitised); defaults to {name}-{version}.bin. */
      fileName?: string;
    };
    /** The firmware file. */
    body: BinaryBody;
  }, options?: RequestOptions): Promise<FirmwareImageCreated> {
    return this.transport.request<FirmwareImageCreated>({ method: "POST", path: "/v1/firmware/images/upload", query: params.query, body: params.body, bodyType: "binary", contentType: "application/octet-stream", accept: "json" }, options);
  }

  /**
   * Upload the iOS notifications key (APNs)
   *
   * The .p8 authentication key from the Apple Developer account (Certificates, Identifiers & Profiles → Keys, with Apple Push Notifications service), and its Key ID. It is stored encrypted, never returned, and checked with Apple at once against the brand’s Team ID and bundle identifier (the result is in pnsCheckOk / pnsCheckDetail). 409 until the Team ID and bundle identifier are set.
   *
   * `PUT /v1/driver-app/apns` · needs `org:write`
   */
  uploadIOSNotificationsKeyAPNs(params: {
    body: UploadIOSNotificationsKeyAPNsBody;
  }, options?: RequestOptions): Promise<DriverAppView> {
    return this.transport.request<DriverAppView>({ method: "PUT", path: "/v1/driver-app/apns", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Validate a tariff
   *
   * Checks a tariff definition against the regulatory ceilings for a connector power, without saving it.
   *
   * `POST /v1/tariffs/validate` · needs `tariff:write`
   */
  validateTariff(params: {
    body: ValidateTariffBody;
  }, options?: RequestOptions): Promise<ValidateTariffResponse> {
    return this.transport.request<ValidateTariffResponse>({ method: "POST", path: "/v1/tariffs/validate", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Verify a URL image checksum
   *
   * Downloads a URL-sourced image once on the server (through the same internal-address guard, up to the firmware size cap), hashes it and records the size and whether it matches the declared SHA-256. Nothing is stored. A failed download, uploaded image or mismatch returns 422. Audited as firmware.image_verified.
   *
   * `POST /v1/firmware/images/{id}/verify` · needs `firmware:write`
   */
  verifyUrlImageChecksum(params: {
    /** Firmware image id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<FirmwareVerifyResult> {
    return this.transport.request<FirmwareVerifyResult>({ method: "POST", path: "/v1/firmware/images/{id}/verify", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Void a credit note
   *
   * Voids a credit note issued in error, while nothing has been done with it: not refunded, not deducted from a later invoice, and (when it reduced an unpaid invoice) that invoice not paid since. What it reduced is owed again. Audited.
   *
   * `POST /v1/fleet-credit-notes/{id}/void` · needs `invoice:write`
   */
  voidCreditNote(params: {
    /** Credit note id. */
    id: string;
    body: VoidCreditNoteBody;
  }, options?: RequestOptions): Promise<FleetCreditNote> {
    return this.transport.request<FleetCreditNote>({ method: "POST", path: "/v1/fleet-credit-notes/{id}/void", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Void a fleet invoice
   *
   * The invoice keeps its number and is marked void; its sessions become billable again, so a corrected invoice can be issued. A paid invoice cannot be voided. If it was exported to e-Faktur, cancel or replace the faktur pajak in Coretax too (`fakturWarning`).
   *
   * `POST /v1/fleet-invoices/{id}/void` · needs `invoice:write`
   */
  voidFleetInvoice(params: {
    /** Invoice id. */
    id: string;
    body: VoidFleetInvoiceBody;
  }, options?: RequestOptions): Promise<VoidFleetInvoiceResponse> {
    return this.transport.request<VoidFleetInvoiceResponse>({ method: "POST", path: "/v1/fleet-invoices/{id}/void", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }
}
