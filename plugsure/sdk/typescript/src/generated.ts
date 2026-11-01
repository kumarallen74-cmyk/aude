// Generated from the PlugSure CSMS OpenAPI document by tools/sdk/generate.mts. Do not edit:
// change the API catalogue (src/api/openapi/catalogue) and run `npm run sdk`.
/* eslint-disable */
import type { Transport, RequestOptions, BinaryBody } from './client.js';

/** The API version this SDK was generated from. */
export const API_VERSION = "1.36.0";

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
  /** The password was right and the account has two-step verification: the session is pending, and only POST /v1/auth/mfa/verify (and sign-out) answer until the code is given. */
  mfaRequired?: boolean;
}

export interface AuthMe {
  /** The signed-in operator. For an API key or the development bypass: a synthetic user with a null email. */
  user: {
    id: string;
    name: string;
    email: string | null;
    mustChangePassword?: boolean;
    /** Two-step verification of the signed-in operator. */
    mfa?: MfaStatus | null;
    /** Required and not set up: every route but enrolment answers 403 until it is. */
    mfaEnrolmentRequired?: boolean;
    /** This session signed in with Microsoft and Microsoft reported multi-factor authentication: the console’s two-step verification counts as done. */
    mfaViaMicrosoft?: boolean;
    /** How this console session signed in (null for an API key). */
    signedInWith?: "password" | "microsoft" | null;
  };
  org: {
    id: string;
    name?: string;
    pkp?: boolean;
    npwp?: string | null;
    /** The organisation's home country (default for new sites). */
    homeCountry?: "ID" | "MY" | "SG";
    /** The organisation's reporting time zone (IANA), e.g. Asia/Jakarta. */
    timezone?: string;
    defaultLocale?: "id" | "en";
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
    /** MULTI_COUNTRY: Malaysian and Singapore sites may be created. */
    multiCountry?: boolean;
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
    /** The installed PlugSure release (package.json version). */
    version: string;
    /** “Sign in with Microsoft” is configured on this installation (MS_CLIENT_ID). */
    microsoftSignIn?: boolean;
  };
  /** The organisation’s own console brand (v1.5.0); null for the PlugSure console. */
  consoleBrand?: ConsoleBrandView | null;
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
  revenueMinor: number;
  /** The site's currency (IDR, MYR or SGD). */
  currency?: string;
  /** Connector-time in sessions over connector-time in the window, percent. */
  utilisationPct: number | null;
  /** Deprecated: the v1.6 name of `revenueMinor`, present while the amount is in IDR. */
  revenueIdr?: number;
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
  platformPpnMinor?: number;
  invoiceTotalMinor?: number;
  /** Number of statement warnings. */
  warnings?: number;
  /** Deprecated: the v1.6 name of `platformPpnMinor`, present while the amount is in IDR. */
  platformPpnIdr?: number;
  /** Deprecated: the v1.6 name of `invoiceTotalMinor`, present while the amount is in IDR. */
  invoiceTotalIdr?: number;
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
  grossMinor?: number;
  localTaxMinor?: number;
  taxMinor?: number;
  baseMinor?: number;
  mdrMinor?: number;
  ownerShareMinor?: number;
  platformShareMinor?: number;
  /** Deprecated: the v1.6 name of `grossMinor`, present while the amount is in IDR. */
  grossIdr?: number;
  /** Deprecated: the v1.6 name of `localTaxMinor`, present while the amount is in IDR. */
  pbjtIdr?: number;
  /** Deprecated: the v1.6 name of `taxMinor`, present while the amount is in IDR. */
  ppnIdr?: number;
  /** Deprecated: the v1.6 name of `baseMinor`, present while the amount is in IDR. */
  baseIdr?: number;
  /** Deprecated: the v1.6 name of `mdrMinor`, present while the amount is in IDR. */
  mdrIdr?: number;
  /** Deprecated: the v1.6 name of `ownerShareMinor`, present while the amount is in IDR. */
  ownerShareIdr?: number;
  /** Deprecated: the v1.6 name of `platformShareMinor`, present while the amount is in IDR. */
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
  heldMinor: number | null;
  captureMinor?: number | null;
  capturedMinor?: number | null;
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
  /** Deprecated: the v1.6 name of `heldMinor`, present while the amount is in IDR. */
  heldIdr?: number | null;
  /** Deprecated: the v1.6 name of `captureMinor`, present while the amount is in IDR. */
  captureIdr?: number | null;
  /** Deprecated: the v1.6 name of `capturedMinor`, present while the amount is in IDR. */
  capturedIdr?: number | null;
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
  /** pending_adoption | provisioning | online | offline | suspended | decommissioned. */
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
  amountMinor: number;
  expiresAt: string;
  status: "pending" | "paid" | "expired" | "failed";
  /** Deprecated: the v1.6 name of `amountMinor`, present while the amount is in IDR. */
  amountIdr?: number;
}

export interface CheckoutQrisResult {
  paymentIntentId: string;
  qr: CheckoutQrisCharge;
  /** Energy the payment buys, quoted against the worst-case tariff block. */
  allowanceWh: number;
  allowanceKwh: number;
  estimatedMdrMinor: number;
  inZeroMdrBand: boolean;
  /** The only idTag that can claim this payment. Show it to the driver. */
  startToken: string;
  /** true when PlugSure generated the token (walk-up), false when the caller supplied idToken. */
  startTokenMinted: boolean;
  expiresInMinutes: number;
  /** Deprecated: the v1.6 name of `estimatedMdrMinor`, present while the amount is in IDR. */
  estimatedMdrIdr?: number;
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
  /** pending_adoption, provisioning, online, offline, suspended or decommissioned. */
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
  local_tax_rate_bps: number;
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
  /** Deprecated: the v1.6 name of `local_tax_rate_bps`, present while the amount is in IDR. */
  pbjt_rate_bps?: number;
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

/** The operator’s own console brand. */
export interface ConsoleBrand {
  orgId: string;
  /** Replaces “PlugSure” in the console. */
  productName: string;
  /** Under the name in the sidebar. */
  tagline: string | null;
  /** The sign-in panel, avatars and the logo tile. */
  brandColor: string;
  /** Buttons, links and highlights. */
  accentColor: string;
  hasLogo: boolean;
  /** The logo’s hash; it is served at /console-brand/<hash>.png. */
  logoSha256: string | null;
  /** The console’s own web address, e.g. console.nusantaracharge.id. */
  hostname: string | null;
  /** The platform operator approved the web address. Only then does the sign-in page on it show the brand and admit only this operator’s accounts. */
  hostnameApproved: boolean;
  hostnameApprovedAt: string | null;
  /** Show “Powered by PlugSure” in the sidebar. */
  showPoweredBy: boolean;
  updatedAt: string;
}

export interface ConsoleBrandResult {
  /** Null: the console uses the PlugSure brand. */
  brand: ConsoleBrand | null;
  view: ConsoleBrandView | null;
}

/** What the console paints with. */
export interface ConsoleBrandView {
  productName: string;
  tagline: string | null;
  /** A 256 × 256 PNG, public and cacheable (content-addressed). */
  logoUrl: string | null;
  palette: {
    light: {
      /** The accent as used: nudged darker (light theme) or lighter (dark theme) until text in it reads at 4.5:1 or more on every surface and on its own tint. */
      accent: string;
      /** Text on a solid accent fill (buttons). */
      ink: string;
      /** The accent’s tint behind tags and highlights. */
      soft: string;
      /** Lowest contrast of the accent against the theme’s surfaces and its tint. */
      contrast: number;
    };
    dark: {
      /** The accent as used: nudged darker (light theme) or lighter (dark theme) until text in it reads at 4.5:1 or more on every surface and on its own tint. */
      accent: string;
      /** Text on a solid accent fill (buttons). */
      ink: string;
      /** The accent’s tint behind tags and highlights. */
      soft: string;
      /** Lowest contrast of the accent against the theme’s surfaces and its tint. */
      contrast: number;
    };
    /** The brand colour as used: darkened if needed so white text on it reads at 4.5:1 or more. */
    brand: string;
    brandDeep: string;
    /** A colour was changed to stay readable. */
    adjusted: boolean;
  };
  showPoweredBy: boolean;
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
    revenue_minor: number;
    active: number;
    /** Deprecated: the v1.6 name of `revenue_minor`, present while the amount is in IDR. */
    revenue_idr?: number;
  } | null;
  series: {
    day: string;
    energy_wh: number;
    revenue_minor: number;
    sessions: number;
    /** Deprecated: the v1.6 name of `revenue_minor`, present while the amount is in IDR. */
    revenue_idr?: number;
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
  /** operator: a white-label app limited to this operator’s chargers. network: the PlugSure app itself (PlugSure Mobility), every operator’s chargers. */
  scope?: "operator" | "network";
  /** Android notifications: the Firebase project of the stored service account. */
  fcmProjectId?: string | null;
  fcmClientEmail?: string | null;
  /** A Firebase service account is stored: the Android app gets native notifications (FCM HTTP v1). */
  fcmConfigured?: boolean;
  fcmCheckedAt?: string | null;
  fcmCheckOk?: boolean | null;
  fcmCheckDetail?: string | null;
  appConfig?: DriverAppConfig;
}

/** The native apps’ version gate and remote configuration, served to them by GET /d/v1/app/config. Every part is optional. */
export interface DriverAppConfig {
  ios?: DriverAppRelease;
  android?: DriverAppRelease;
  maintenance?: {
    active?: boolean;
    messageId?: string;
    messageEn?: string;
  };
  /** Feature switches (absent: the default). A switch cannot turn on what the server does not offer (roaming, reservations). */
  features?: {
    roaming?: boolean;
    reservations?: boolean;
    queue?: boolean;
    memberships?: boolean;
    favourites?: boolean;
    liveActivities?: boolean;
    accountDeletion?: boolean;
    applePay?: boolean;
    googlePay?: boolean;
    routePlanner?: boolean;
  };
  links?: {
    support?: string;
    faq?: string;
    status?: string;
  };
}

export interface DriverAppRelease {
  /** Older versions must update before anything else (blocking screen). */
  minSupported?: string;
  /** Older versions see a dismissable "update available". */
  latest?: string;
  /** https:// store page (Android default: the Play page of the package). */
  storeUrl?: string;
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

export interface FinanceAccount {
  id: string;
  /** Null: the platform's own account (it takes the payments of every operator without one). */
  orgId?: string | null;
  orgName?: string | null;
  provider: "xendit" | "duitku";
  environment?: string | null;
  /** (v1.13.0) The fallback account (Duitku): its ledger is built from PlugSure's payments with the fee Duitku reports, settlement estimated from Duitku's schedule. */
  fallback?: boolean;
  /** Replaced by another account; kept while its money settles. */
  archived?: boolean;
  testMode?: boolean;
  label: string;
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
  outstanding_minor?: number;
  /** Fleet customer portal users (list). */
  portal_users?: number;
  /** Deprecated: the v1.6 name of `outstanding_minor`, present while the amount is in IDR. */
  outstanding_idr?: number;
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
  amountMinor: number;
  /** Carries PPN (split like an invoice line). */
  taxed: boolean;
  /** Price subject to PPN. */
  taxableMinor?: number;
  /** DPP nilai lain, 11/12 of the price. */
  taxBaseMinor?: number;
  /** 12% of the DPP. */
  taxMinor?: number;
  /** Deprecated: the v1.6 name of `amountMinor`, present while the amount is in IDR. */
  amountIdr?: number;
  /** Deprecated: the v1.6 name of `taxableMinor`, present while the amount is in IDR. */
  taxBaseIdr?: number;
  /** Deprecated: the v1.6 name of `taxBaseMinor`, present while the amount is in IDR. */
  ppnDppIdr?: number;
  /** Deprecated: the v1.6 name of `taxBaseMinor`, present while the amount is in IDR. */
  dppIdr?: number;
  /** Deprecated: the v1.6 name of `taxMinor`, present while the amount is in IDR. */
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
  taxBaseMinor: number;
  taxMinor: number;
  /** Total credited, PPN included. */
  totalMinor: number;
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
    totalMinor?: number;
    efakturNumber?: string | null;
    status?: string;
    /** Deprecated: the v1.6 name of `totalMinor`, present while the amount is in IDR. */
    totalIdr?: number;
  };
  accountId?: string;
  seller?: FleetSeller;
  buyer?: Record<string, unknown>;
  /** Deprecated: the v1.6 name of `taxBaseMinor`, present while the amount is in IDR. */
  ppnDppIdr?: number;
  /** Deprecated: the v1.6 name of `taxBaseMinor`, present while the amount is in IDR. */
  dppIdr?: number;
  /** Deprecated: the v1.6 name of `taxMinor`, present while the amount is in IDR. */
  ppnIdr?: number;
  /** Deprecated: the v1.6 name of `totalMinor`, present while the amount is in IDR. */
  totalIdr?: number;
}

export interface FleetCreditNoteRow {
  id: string;
  number: string;
  status: "issued" | "void";
  settlement: "invoice" | "refund" | "next_invoice";
  reason?: string;
  total_minor: number;
  tax_minor?: number;
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
  /** Deprecated: the v1.6 name of `total_minor`, present while the amount is in IDR. */
  total_idr?: number;
  /** Deprecated: the v1.6 name of `tax_minor`, present while the amount is in IDR. */
  ppn_idr?: number;
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
  tax_minor?: number;
  roaming_total_minor?: number;
  total_minor: number;
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
  credited_minor?: number;
  /** Earlier credit notes deducted from this invoice. */
  prior_credit_minor?: number;
  /** Still owed: total less both kinds of credit (0 once paid). */
  balance_minor?: number;
  /** Deprecated: the v1.6 name of `tax_minor`, present while the amount is in IDR. */
  ppn_idr?: number;
  /** Deprecated: the v1.6 name of `roaming_total_minor`, present while the amount is in IDR. */
  roaming_total_idr?: number;
  /** Deprecated: the v1.6 name of `total_minor`, present while the amount is in IDR. */
  total_idr?: number;
  /** Deprecated: the v1.6 name of `credited_minor`, present while the amount is in IDR. */
  credited_idr?: number;
  /** Deprecated: the v1.6 name of `prior_credit_minor`, present while the amount is in IDR. */
  prior_credit_idr?: number;
  /** Deprecated: the v1.6 name of `balance_minor`, present while the amount is in IDR. */
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
  subtotalMinor: number;
  localTaxMinor: number;
  /** Price subject to PPN (e-Faktur TaxBase). */
  taxableMinor: number;
  /** DPP nilai lain, 11/12 of the price. */
  taxBaseMinor: number;
  taxMinor: number;
  totalMinor: number;
  untaxedSessions?: number;
  /** Deprecated: the v1.6 name of `subtotalMinor`, present while the amount is in IDR. */
  subtotalIdr?: number;
  /** Deprecated: the v1.6 name of `localTaxMinor`, present while the amount is in IDR. */
  pbjtIdr?: number;
  /** Deprecated: the v1.6 name of `taxableMinor`, present while the amount is in IDR. */
  taxBaseIdr?: number;
  /** Deprecated: the v1.6 name of `taxBaseMinor`, present while the amount is in IDR. */
  ppnDppIdr?: number;
  /** Deprecated: the v1.6 name of `taxBaseMinor`, present while the amount is in IDR. */
  dppIdr?: number;
  /** Deprecated: the v1.6 name of `taxMinor`, present while the amount is in IDR. */
  ppnIdr?: number;
  /** Deprecated: the v1.6 name of `totalMinor`, present while the amount is in IDR. */
  totalIdr?: number;
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
    totalMinor?: number;
    roamingMinor?: number;
    /** Deprecated: the v1.6 name of `totalMinor`, present while the amount is in IDR. */
    totalIdr?: number;
    /** Deprecated: the v1.6 name of `roamingMinor`, present while the amount is in IDR. */
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
    subtotalMinor?: number;
    localTaxMinor?: number;
    taxBaseMinor?: number;
    ppnRateBps?: number;
    taxMinor?: number;
    /** The session receipt total. */
    totalMinor: number;
    taxableMinor?: number;
    /** Deprecated: the v1.6 name of `subtotalMinor`, present while the amount is in IDR. */
    subtotalIdr?: number;
    /** Deprecated: the v1.6 name of `localTaxMinor`, present while the amount is in IDR. */
    pbjtIdr?: number;
    /** Deprecated: the v1.6 name of `taxBaseMinor`, present while the amount is in IDR. */
    ppnDppIdr?: number;
    /** Deprecated: the v1.6 name of `taxBaseMinor`, present while the amount is in IDR. */
    dppIdr?: number;
    /** Deprecated: the v1.6 name of `taxMinor`, present while the amount is in IDR. */
    ppnIdr?: number;
    /** Deprecated: the v1.6 name of `totalMinor`, present while the amount is in IDR. */
    totalIdr?: number;
    /** Deprecated: the v1.6 name of `taxableMinor`, present while the amount is in IDR. */
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
    amountMinor: number;
    /** Deprecated: the v1.6 name of `amountMinor`, present while the amount is in IDR. */
    amountIdr?: number;
  }[];
  fees?: {
    subscriptionId?: string;
    planName?: string;
    subscriber?: string;
    feeMinor?: number;
    taxableMinor?: number;
    taxBaseMinor?: number;
    taxMinor?: number;
    totalMinor?: number;
    periodStart?: string;
    periodEnd?: string;
    /** Deprecated: the v1.6 name of `feeMinor`, present while the amount is in IDR. */
    feeIdr?: number;
    /** Deprecated: the v1.6 name of `taxableMinor`, present while the amount is in IDR. */
    taxBaseIdr?: number;
    /** Deprecated: the v1.6 name of `taxBaseMinor`, present while the amount is in IDR. */
    ppnDppIdr?: number;
    /** Deprecated: the v1.6 name of `taxBaseMinor`, present while the amount is in IDR. */
    dppIdr?: number;
    /** Deprecated: the v1.6 name of `taxMinor`, present while the amount is in IDR. */
    ppnIdr?: number;
    /** Deprecated: the v1.6 name of `totalMinor`, present while the amount is in IDR. */
    totalIdr?: number;
  }[];
  totals: {
    sessions: number;
    energyWh: number;
    subtotalMinor: number;
    localTaxMinor: number;
    taxableMinor: number;
    taxBaseMinor: number;
    taxMinor: number;
    ownTotalMinor: number;
    roamingSessions?: number;
    roamingMinor: number;
    /** Membership fees incl. PPN. */
    feesMinor?: number;
    /** Total due. */
    totalMinor: number;
    /** Sum of the per-session receipts. */
    receiptsTotalMinor?: number;
    /** Invoice minus receipts (PPN computed per invoice line). */
    roundingMinor?: number;
    /** Deprecated: the v1.6 name of `subtotalMinor`, present while the amount is in IDR. */
    subtotalIdr?: number;
    /** Deprecated: the v1.6 name of `localTaxMinor`, present while the amount is in IDR. */
    pbjtIdr?: number;
    /** Deprecated: the v1.6 name of `taxableMinor`, present while the amount is in IDR. */
    taxBaseIdr?: number;
    /** Deprecated: the v1.6 name of `taxBaseMinor`, present while the amount is in IDR. */
    ppnDppIdr?: number;
    /** Deprecated: the v1.6 name of `taxBaseMinor`, present while the amount is in IDR. */
    dppIdr?: number;
    /** Deprecated: the v1.6 name of `taxMinor`, present while the amount is in IDR. */
    ppnIdr?: number;
    /** Deprecated: the v1.6 name of `ownTotalMinor`, present while the amount is in IDR. */
    ownTotalIdr?: number;
    /** Deprecated: the v1.6 name of `roamingMinor`, present while the amount is in IDR. */
    roamingIdr?: number;
    /** Deprecated: the v1.6 name of `feesMinor`, present while the amount is in IDR. */
    feesIdr?: number;
    /** Deprecated: the v1.6 name of `totalMinor`, present while the amount is in IDR. */
    totalIdr?: number;
    /** Deprecated: the v1.6 name of `receiptsTotalMinor`, present while the amount is in IDR. */
    receiptsTotalIdr?: number;
    /** Deprecated: the v1.6 name of `roundingMinor`, present while the amount is in IDR. */
    roundingIdr?: number;
  };
  warnings: string[];
  /** Credit notes settled against this invoice. */
  creditedMinor?: number;
  /** Earlier credit notes deducted from this invoice. */
  priorCreditMinor?: number;
  /** Still owed on an issued invoice (0 once paid or for a draft). */
  balanceMinor?: number;
  priorCredits?: {
    id?: string;
    number?: string;
    invoiceNumber?: string;
    totalMinor?: number;
    /** Deprecated: the v1.6 name of `totalMinor`, present while the amount is in IDR. */
    totalIdr?: number;
  }[];
  creditNotes?: {
    id?: string;
    number?: string;
    status?: "issued" | "void";
    settlement?: "invoice" | "refund" | "next_invoice";
    reason?: string;
    totalMinor?: number;
    taxMinor?: number;
    issuedAt?: string;
    refundedAt?: string | null;
    applied?: boolean;
    /** Deprecated: the v1.6 name of `totalMinor`, present while the amount is in IDR. */
    totalIdr?: number;
    /** Deprecated: the v1.6 name of `taxMinor`, present while the amount is in IDR. */
    ppnIdr?: number;
  }[];
  /** Deprecated: the v1.6 name of `creditedMinor`, present while the amount is in IDR. */
  creditedIdr?: number;
  /** Deprecated: the v1.6 name of `priorCreditMinor`, present while the amount is in IDR. */
  priorCreditIdr?: number;
  /** Deprecated: the v1.6 name of `balanceMinor`, present while the amount is in IDR. */
  balanceIdr?: number;
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

/** (v1.16.0) A report Xendit generates on request (Report API), as CSV. */
export interface GatewayReport {
  id: string;
  type: "TRANSACTIONS" | "BALANCE_HISTORY" | "UPCOMING_TRANSACTIONS";
  from?: string;
  to?: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
  ready: boolean;
  error?: string | null;
  requestedAt?: string;
  updatedAt?: string;
  requestedBy?: string | null;
  /** With ?link=true on a completed report: Xendit's download link (short-lived). */
  url?: string;
}

/** One transaction in the gateway's ledger, as synced, matched to PlugSure's payment when it is one. */
export interface GatewayTransaction {
  id: string;
  /** Xendit's transaction id (txn_…). */
  gatewayId: string;
  kind: "payment" | "refund" | "payout" | "transfer" | "fee" | "other";
  /** The gateway's own type word. */
  type?: string | null;
  status: "success" | "pending" | "failed" | "voided" | "reversed";
  cashflow?: "in" | "out";
  channel?: string | null;
  channelCategory?: string | null;
  /** The reference PlugSure gave the gateway (ps-…). */
  reference?: string | null;
  productId?: string | null;
  currency?: string;
  amount: number;
  fee?: number;
  vat?: number;
  withholdingTax?: number;
  net?: number | null;
  settlement?: "pending" | "settled" | "early_settled" | null;
  expectedSettlementAt?: string | null;
  /** When the sync first saw it settled. */
  settledSeenAt?: string | null;
  at: string;
  updatedAt?: string;
  /** How it matched PlugSure: a payment, a membership pass charge, a refund; null: not matched. */
  matched?: "intent" | "pass" | "refund" | null;
  paymentId?: string | null;
  paymentState?: string | null;
  sessionId?: string | null;
  operator?: string | null;
  passChargeId?: string | null;
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
  /** Payments: the country of this acquirer account (one account per organisation and country; its currency follows). Stripe needs MY or SG; the Indonesian acquirers take ID only. MY/SG need MULTI_COUNTRY=true (409 otherwise). */
  countryCode?: "ID" | "MY" | "SG";
}

export interface IntegrationKind {
  kind: "payments" | "payments_fallback" | "otp" | "otp_fallback" | "pnc_pki" | "map_tiles" | "ai_support";
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
    /** Payments: the country this acquirer account serves (ID for every v1.6 account). */
    countryCode?: "ID" | "MY" | "SG";
    /** Non-secret settings. */
    settings?: Record<string, unknown>;
    /** Secret fields that are set, as a hint (last characters). Secret values are never returned. */
    secretHints?: Record<string, unknown>;
    enabled?: boolean;
    webhookPath?: string | null;
    webhookUrl?: string | null;
    /** Sign-in codes on the WhatsApp Cloud API: the verify token for the Meta app's status webhook (webhookUrl, /hooks/whatsapp-cloud/<key>), made by the server on the first save. Platform administrators only. */
    webhookVerifyToken?: string;
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
  earnPer1000Minor: number;
  /** What one point takes off a session, in rupiah. */
  pointValueMinor: number;
  /** The most of a session's energy and fees points may pay, in basis points (5000 = half). */
  maxRedeemBps: number;
  /** Each earning expires this many months after it was earned; points are spent oldest first. */
  expiryMonths: number;
  /** Deprecated: the v1.6 name of `earnPer1000Minor`, present while the amount is in IDR. */
  earnPer1000Idr?: number;
  /** Deprecated: the v1.6 name of `pointValueMinor`, present while the amount is in IDR. */
  pointValueIdr?: number;
}

export interface LoyaltyStats {
  program: LoyaltyProgram;
  outstandingPoints: number;
  /** What the outstanding points are worth. */
  liabilityMinor: number;
  /** Drivers holding points. */
  members: number;
  thisMonth: {
    earned?: number;
    redeemed?: number;
    discountMinor?: number;
    expired?: number;
    /** Deprecated: the v1.6 name of `discountMinor`, present while the amount is in IDR. */
    discountIdr?: number;
  };
  /** Deprecated: the v1.6 name of `liabilityMinor`, present while the amount is in IDR. */
  liabilityIdr?: number;
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

export interface MfaEnrolment {
  /** The TOTP secret, base32 — for typing into an app that cannot scan. */
  secret: string;
  /** otpauth://totp/… (SHA1, 6 digits, 30 s). */
  uri: string;
  /** The URI as a PNG QR code (data: URL). */
  qrDataUrl: string;
}

export interface MfaStatus {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
  /** Two-step verification is required for this account (an administrator, with CONSOLE_MFA_REQUIRED on). */
  required: boolean;
}

/** The Microsoft Entra tenant the organisation connected for “Sign in with Microsoft”. */
export interface MicrosoftTenant {
  /** The Entra directory (tenant) id, from the validated sign-in that connected it. */
  tenantId: string;
  /** When not empty, a first Microsoft sign-in is matched to a console user only by an address in one of these domains. */
  allowedDomains: string[];
  linkedAt: string;
  /** The administrator who connected it. */
  linkedBy: {
    id: string;
    name: string;
  } | null;
  /** The Microsoft account that proved control of the tenant. */
  linkedByAccount: string | null;
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

export interface OperatorStatementDue {
  statementId: string;
  number: string;
  period: string;
  orgId: string;
  operator: string;
  currency: string;
  due: number;
  paid: number;
  outstanding: number;
  status: "due" | "partial" | "paid";
  finalisedAt?: string | null;
  lastPaidOn?: string | null;
}

export interface OrgSettings {
  name?: string;
  /** ID, MY or SG. */
  homeCountry: string;
  /** Reporting time zone (IANA). */
  timezone: string;
  defaultLocale: "id" | "en";
  /** Whether Malaysia and Singapore are enabled on this platform. */
  multiCountry?: boolean;
  /** Indonesia: the PKP status billing applies (organisation record), shown when no registration row exists. */
  indonesiaPkp?: {
    registered: boolean;
    npwp: string | null;
  };
  /** Active sites per country code. */
  sitesByCountry?: Record<string, number>;
  countries: {
    code?: string;
    name?: string;
    currency?: string;
    timezones?: string[];
    scheme?: string;
    displayPricesInclTax?: boolean;
  }[];
  taxRegistrations: {
    id: string;
    countryCode: string;
    /** ID_PKP, MY_SST or SG_GST. */
    scheme: string;
    registrationNo?: string | null;
    registered: boolean;
    evChargingTaxable?: boolean;
    rateBps?: number | null;
    effectiveFrom: string;
    effectiveTo?: string | null;
    createdAt?: string;
    createdBy?: string | null;
  }[];
}

export interface OwnerBankAccount {
  ownerId: string;
  bankName: string;
  bankCode?: string | null;
  holderName: string;
  /** ••••7890 */
  accountMasked: string;
  updatedAt?: string;
  /** (v1.15.0) The last name check (Duitku Disbursement inquiry); cleared when the account, bank code or holder changes. */
  nameCheck?: {
    status?: "matched" | "mismatch" | "failed";
    /** The holder's name the bank returned. */
    bankName?: string | null;
    checkedAt?: string;
  } | null;
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

export interface OwnerShare {
  statementId: string;
  number: string;
  /** YYYY-MM. */
  period: string;
  ownerId: string;
  owner: string;
  currency: string;
  due: number;
  paid: number;
  outstanding: number;
  status: "due" | "partial" | "paid";
  finalisedAt?: string | null;
  lastPaidOn?: string | null;
  bank?: {
    bankName?: string;
    holderName?: string;
    accountMasked?: string;
  } | null;
}

/** (v1.16.0) An owner's share paid through Duitku Disbursement from the operator's own account, approved by a second person. */
export interface PayoutTransfer {
  id: string;
  statementId: string;
  number?: string | null;
  owner?: string | null;
  /** (v1.17.0) Duitku Disbursement or Xendit Payouts. */
  rail?: "duitku" | "xendit";
  state: "awaiting_approval" | "sending" | "sent" | "succeeded" | "failed" | "rejected";
  amount: number;
  currency: string;
  bankCode: string;
  accountMasked: string;
  holderName: string;
  checkedName?: string | null;
  namesMatch: boolean;
  note?: string | null;
  requestedBy?: string | null;
  requestedByName?: string | null;
  requestedAt: string;
  approvedBy?: string | null;
  approvedByName?: string | null;
  approvedAt?: string | null;
  reason?: string | null;
  responseCode?: string | null;
  error?: string | null;
  /** The statement payment recorded once Duitku confirmed it. */
  statementPaymentId?: string | null;
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
  budget_minor?: number | null;
  stacks_with_membership: boolean;
  active: boolean;
  created_at?: string;
  updated_at?: string;
  redemptions?: number;
  /** Discount given so far. */
  discount_minor?: number;
  customers?: number;
  /** Deprecated: the v1.6 name of `budget_minor`, present while the amount is in IDR. */
  budget_idr?: number | null;
  /** Deprecated: the v1.6 name of `discount_minor`, present while the amount is in IDR. */
  discount_idr?: number;
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
  budgetMinor?: number | null;
  stacksWithMembership?: boolean;
  active?: boolean;
  /** Set when created (default IDR); fixed after. Applies to sessions in it only. */
  currency?: "IDR" | "MYR" | "SGD";
  /** Deprecated: the v1.6 name of `budgetMinor`, present while the amount is in IDR. */
  budgetIdr?: number | null;
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

export interface ReconciliationException {
  id: string;
  kind: "missing_in_plugsure" | "missing_at_gateway" | "amount_mismatch" | "pending_too_long" | "settlement_overdue" | "refund_mismatch";
  text: string;
  state: "open" | "resolved";
  amount?: number | null;
  reference?: string | null;
  channel?: string | null;
  gatewayId?: string | null;
  paymentId?: string | null;
  detail?: Record<string, unknown>;
  /** A gateway payment matching a PlugSure payment that never became paid: POST …/apply applies it. */
  canApply?: boolean;
  resolution?: string | null;
  resolvedAt?: string | null;
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export interface RefundOutcome {
  ok: true;
  state: "processing" | "refunded";
  refundRef?: string;
}

export interface RefundRow {
  id: string;
  refund_state: "due" | "processing" | "refunded" | "failed";
  refund_due_minor?: number | null;
  refunded_minor?: number | null;
  refund_reason?: string | null;
  /** disbursement (v1.15.0): sent through Duitku Disbursement. */
  refund_method?: "provider" | "manual" | "disbursement" | null;
  refund_ref?: string | null;
  refund_error?: string | null;
  refund_requested_at?: string | null;
  refunded_at?: string | null;
  provider: string;
  provider_ref?: string | null;
  method: string;
  amount_captured_minor?: number | null;
  paid_at: string;
  session_id?: string | null;
  site_name?: string | null;
  ocpp_identity?: string | null;
  connector_no?: number | null;
  driver_phone?: string | null;
  refunded_by_name?: string | null;
  channel?: string | null;
  /** (v1.15.0) Days after the payment the gateway refunds it to the payer's method (Xendit e-wallets and QRIS); null: no gateway refund, or not known. */
  refund_window_days?: number | null;
  /** (v1.15.0) What is left of the window; negative: closed, a bank transfer only. Null once refunded. */
  refund_days_left?: number | null;
  /** (v1.15.0) Less than the payment is refunded. */
  partial?: boolean;
  /** (v1.15.0) The refund in Finance's ledger of the gateway: success, pending, failed. */
  gateway_refund_status?: string | null;
  /** (v1.15.0) The refund fee and VAT the gateway charged, from its ledger. */
  gateway_refund_fee?: number | null;
  /** (v1.15.0) The payment's own fee and VAT, which Xendit does not return on a partial refund or one made more than 24 hours after the payment. */
  fee_kept?: number | null;
  /** (v1.15.0) The account that took the payment can send money (Duitku Disbursement; v1.17.0 Xendit payouts): the refund can be sent with POST /v1/refunds/{id}/disbursement. */
  disbursement_available?: boolean;
  /** (v1.17.0) The rail it would go through. */
  disbursement_rail?: "duitku" | "xendit" | null;
  /** Deprecated: the v1.6 name of `refund_due_minor`, present while the amount is in IDR. */
  refund_due_idr?: number | null;
  /** Deprecated: the v1.6 name of `refunded_minor`, present while the amount is in IDR. */
  refunded_idr?: number | null;
  /** Deprecated: the v1.6 name of `amount_captured_minor`, present while the amount is in IDR. */
  amount_captured_idr?: number | null;
}

export interface RefundSummary {
  due_count: number;
  /** Rupiah (IDR); other currencies are in by_currency. */
  due_minor: number;
  failed_count: number;
  refunded_30d_minor: number;
  /** (v1.15.0) Outstanding refunds whose gateway refund window closes within 7 days. */
  closing_soon_count?: number;
  by_currency?: {
    currency?: string;
    due_minor?: number;
    refunded_30d_minor?: number;
    /** Deprecated: the v1.6 name of `due_minor`, present while the amount is in IDR. */
    due_idr?: number;
    /** Deprecated: the v1.6 name of `refunded_30d_minor`, present while the amount is in IDR. */
    refunded_30d_idr?: number;
  }[];
  /** Deprecated: the v1.6 name of `due_minor`, present while the amount is in IDR. */
  due_idr?: number;
  /** Deprecated: the v1.6 name of `refunded_30d_minor`, present while the amount is in IDR. */
  refunded_30d_idr?: number;
}

/** (v1.15.0) A refund paid to the driver's bank account through Duitku Disbursement, approved by a second person. */
export interface RefundTransfer {
  id: string;
  paymentId: string;
  /** (v1.17.0) Duitku Disbursement or Xendit Payouts (no name check: checkedName is null). */
  rail?: "duitku" | "xendit";
  /** sent: accepted, the result not confirmed yet (checked automatically). */
  state: "awaiting_approval" | "sending" | "sent" | "succeeded" | "failed" | "rejected";
  amount: number;
  currency: string;
  bankCode: string;
  accountMasked: string;
  /** The name entered. */
  holderName: string;
  /** The holder's name the bank returned (inquiry). */
  checkedName?: string | null;
  namesMatch: boolean;
  requestedBy?: string | null;
  requestedByName?: string | null;
  requestedAt: string;
  approvedBy?: string | null;
  approvedByName?: string | null;
  approvedAt?: string | null;
  reason?: string | null;
  /** Duitku's responseCode (00 paid). */
  responseCode?: string | null;
  error?: string | null;
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
  spend_limit_minor?: number | null;
  /** Charge records received for this card from other networks. */
  roaming_cdrs: number;
  /** Charged to this card on other networks in its spending-limit currency (minor units). */
  roaming_minor: number;
  /** The currency of the spending limit (IDR, MYR or SGD). */
  spend_limit_currency?: string;
  roaming_currency?: string;
  roaming_cdrs_held?: number;
  /** Charged on other networks per currency (minor units); never added across currencies. */
  roaming_by_currency?: Record<string, number>;
  /** Deprecated: the v1.6 name of `spend_limit_minor`, present while the amount is in IDR. */
  spend_limit_idr?: number | null;
  /** Deprecated: the v1.6 name of `roaming_minor`, present while the amount is in IDR. */
  roaming_idr?: number;
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
  /** This operator’s roaming identity (the home party), or null until set. */
  party: RoamingParty | null;
  /** Every OCPI party of the operator, one per country, the home party first. */
  parties?: RoamingPartyOfCountry[];
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

export interface RoamingPartyOfCountry {
  country_code: string;
  party_id: string;
  business_name: string;
  website?: string | null;
  /** The home party: the eMSP identity and the one connections are made with. */
  is_home: boolean;
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
  total_minor?: number | null;
  /** State of the CDR delivery to the partner: pending | delivered | failed, or null before one is queued. */
  cdr_push_state?: string | null;
  /** Deprecated: the v1.6 name of `total_minor`, present while the amount is in IDR. */
  total_idr?: number | null;
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
  name: "super_admin" | "cpo_operations_manager" | "site_host_landlord" | "field_technician" | "finance_manager" | "financial_auditor" | "site_owner" | "fleet_customer";
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
  energySubtotalMinor?: number | null;
  serviceFeeMinor?: number | null;
  idleFeeMinor?: number | null;
  localTaxMinor?: number | null;
  taxBaseMinor?: number | null;
  taxMinor?: number | null;
  /** Estimated QRIS MDR (the operator’s cost, not charged to the driver). */
  mdrMinor: number;
  grossTotalMinor?: number | null;
  /** Deprecated: the v1.6 name of `energySubtotalMinor`, present while the amount is in IDR. */
  energySubtotalIdr?: number | null;
  /** Deprecated: the v1.6 name of `serviceFeeMinor`, present while the amount is in IDR. */
  serviceFeeIdr?: number | null;
  /** Deprecated: the v1.6 name of `idleFeeMinor`, present while the amount is in IDR. */
  idleFeeIdr?: number | null;
  /** Deprecated: the v1.6 name of `localTaxMinor`, present while the amount is in IDR. */
  pbjtIdr?: number | null;
  /** Deprecated: the v1.6 name of `taxBaseMinor`, present while the amount is in IDR. */
  ppnDppIdr?: number | null;
  /** Deprecated: the v1.6 name of `taxBaseMinor`, present while the amount is in IDR. */
  dppIdr?: number | null;
  /** Deprecated: the v1.6 name of `taxMinor`, present while the amount is in IDR. */
  ppnIdr?: number | null;
  /** Deprecated: the v1.6 name of `mdrMinor`, present while the amount is in IDR. */
  mdrIdr?: number;
  /** Deprecated: the v1.6 name of `grossTotalMinor`, present while the amount is in IDR. */
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
  prepaid_amount_minor?: number | null;
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
  subtotal_minor?: number | null;
  local_tax_minor?: number | null;
  local_tax_rate_bps?: number | null;
  tax_base_minor?: number | null;
  tax_minor?: number | null;
  total_minor?: number | null;
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
    creditMinorPerKwh?: number | null;
    creditMinor?: number;
    discharging?: boolean;
    dischargeW?: number | null;
    notDischargingBecause?: string | null;
    canOffer?: boolean;
    /** Deprecated: the v1.6 name of `creditMinorPerKwh`, present while the amount is in IDR. */
    creditIdrPerKwh?: number | null;
    /** Deprecated: the v1.6 name of `creditMinor`, present while the amount is in IDR. */
    creditIdr?: number;
  } | null;
  /** Deprecated: the v1.6 name of `prepaid_amount_minor`, present while the amount is in IDR. */
  prepaid_amount_idr?: number | null;
  /** Deprecated: the v1.6 name of `subtotal_minor`, present while the amount is in IDR. */
  subtotal_idr?: number | null;
  /** Deprecated: the v1.6 name of `local_tax_minor`, present while the amount is in IDR. */
  pbjt_idr?: number | null;
  /** Deprecated: the v1.6 name of `local_tax_rate_bps`, present while the amount is in IDR. */
  pbjt_rate_bps?: number | null;
  /** Deprecated: the v1.6 name of `tax_base_minor`, present while the amount is in IDR. */
  ppn_dpp_idr?: number | null;
  /** Deprecated: the v1.6 name of `tax_base_minor`, present while the amount is in IDR. */
  dpp_idr?: number | null;
  /** Deprecated: the v1.6 name of `tax_minor`, present while the amount is in IDR. */
  ppn_idr?: number | null;
  /** Deprecated: the v1.6 name of `total_minor`, present while the amount is in IDR. */
  total_idr?: number | null;
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
  prepaid_amount_minor?: number | null;
  /** Unfiltered listing only. */
  prepaid_energy_wh?: number | null;
  ocpp_identity: string;
  evse_no: number;
  site_name: string;
  total_minor?: number | null;
  subtotal_minor?: number | null;
  local_tax_minor?: number | null;
  tax_minor?: number | null;
  tax_base_minor?: number | null;
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
  local_tax_rate_bps?: number | null;
  tax_rate_bps?: number | null;
  issued_at?: string | null;
  payment_method?: string | null;
  payment_state?: string | null;
  /** paid | invoiced | pending | unbilled | review | in_progress | failed | refunded | free. */
  payment_status?: string;
  breakdown?: SessionBreakdown;
  /** Deprecated: the v1.6 name of `prepaid_amount_minor`, present while the amount is in IDR. */
  prepaid_amount_idr?: number | null;
  /** Deprecated: the v1.6 name of `total_minor`, present while the amount is in IDR. */
  total_idr?: number | null;
  /** Deprecated: the v1.6 name of `subtotal_minor`, present while the amount is in IDR. */
  subtotal_idr?: number | null;
  /** Deprecated: the v1.6 name of `local_tax_minor`, present while the amount is in IDR. */
  pbjt_idr?: number | null;
  /** Deprecated: the v1.6 name of `tax_minor`, present while the amount is in IDR. */
  ppn_idr?: number | null;
  /** Deprecated: the v1.6 name of `tax_base_minor`, present while the amount is in IDR. */
  ppn_dpp_idr?: number | null;
  /** Deprecated: the v1.6 name of `tax_base_minor`, present while the amount is in IDR. */
  dpp_idr?: number | null;
  /** Deprecated: the v1.6 name of `local_tax_rate_bps`, present while the amount is in IDR. */
  pbjt_rate_bps?: number | null;
  /** Deprecated: the v1.6 name of `tax_rate_bps`, present while the amount is in IDR. */
  ppn_rate_bps?: number | null;
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
  energySubtotalMinor: number | null;
  serviceFeeMinor: number | null;
  idleFeeMinor: number | null;
  localTaxMinor: number | null;
  taxBaseMinor: number | null;
  taxMinor: number | null;
  /** Estimated QRIS MDR (operator cost, not charged to the driver); 0 for other methods. */
  mdrMinor: number;
  grossTotalMinor: number | null;
  /** Deprecated: the v1.6 name of `energySubtotalMinor`, present while the amount is in IDR. */
  energySubtotalIdr?: number | null;
  /** Deprecated: the v1.6 name of `serviceFeeMinor`, present while the amount is in IDR. */
  serviceFeeIdr?: number | null;
  /** Deprecated: the v1.6 name of `idleFeeMinor`, present while the amount is in IDR. */
  idleFeeIdr?: number | null;
  /** Deprecated: the v1.6 name of `localTaxMinor`, present while the amount is in IDR. */
  pbjtIdr?: number | null;
  /** Deprecated: the v1.6 name of `taxBaseMinor`, present while the amount is in IDR. */
  ppnDppIdr?: number | null;
  /** Deprecated: the v1.6 name of `taxBaseMinor`, present while the amount is in IDR. */
  dppIdr?: number | null;
  /** Deprecated: the v1.6 name of `taxMinor`, present while the amount is in IDR. */
  ppnIdr?: number | null;
  /** Deprecated: the v1.6 name of `mdrMinor`, present while the amount is in IDR. */
  mdrIdr?: number;
  /** Deprecated: the v1.6 name of `grossTotalMinor`, present while the amount is in IDR. */
  grossTotalIdr?: number | null;
}

export interface SessionSearchResult {
  rows: SessionSearchRow[];
  /** Totals over every session matching the filter, not just this page. */
  totals: {
    sessions: number;
    energy_wh: number;
    revenue_minor: number;
    local_tax_minor: number;
    tax_minor: number;
    /** Deprecated: the v1.6 name of `revenue_minor`, present while the amount is in IDR. */
    revenue_idr?: number;
    /** Deprecated: the v1.6 name of `local_tax_minor`, present while the amount is in IDR. */
    pbjt_idr?: number;
    /** Deprecated: the v1.6 name of `tax_minor`, present while the amount is in IDR. */
    ppn_idr?: number;
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
  prepaid_amount_minor?: number | null;
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
  subtotal_minor?: number | null;
  local_tax_minor?: number | null;
  local_tax_rate_bps?: number | null;
  tax_base_minor?: number | null;
  tax_rate_bps?: number | null;
  tax_minor?: number | null;
  total_minor?: number | null;
  regulatory_flags?: unknown[] | null;
  issued_at?: string | null;
  payment_method?: string | null;
  payment_state?: string | null;
  payment_status: string;
  breakdown: SessionSearchBreakdown;
  /** Deprecated: the v1.6 name of `prepaid_amount_minor`, present while the amount is in IDR. */
  prepaid_amount_idr?: number | null;
  /** Deprecated: the v1.6 name of `subtotal_minor`, present while the amount is in IDR. */
  subtotal_idr?: number | null;
  /** Deprecated: the v1.6 name of `local_tax_minor`, present while the amount is in IDR. */
  pbjt_idr?: number | null;
  /** Deprecated: the v1.6 name of `local_tax_rate_bps`, present while the amount is in IDR. */
  pbjt_rate_bps?: number | null;
  /** Deprecated: the v1.6 name of `tax_base_minor`, present while the amount is in IDR. */
  ppn_dpp_idr?: number | null;
  /** Deprecated: the v1.6 name of `tax_base_minor`, present while the amount is in IDR. */
  dpp_idr?: number | null;
  /** Deprecated: the v1.6 name of `tax_rate_bps`, present while the amount is in IDR. */
  ppn_rate_bps?: number | null;
  /** Deprecated: the v1.6 name of `tax_minor`, present while the amount is in IDR. */
  ppn_idr?: number | null;
  /** Deprecated: the v1.6 name of `total_minor`, present while the amount is in IDR. */
  total_idr?: number | null;
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
  local_tax_rate_bps?: number;
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
  reservation_fee_minor?: number;
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
  v2x_credit_minor_per_kwh?: number;
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
  /** Deprecated: the v1.6 name of `local_tax_rate_bps`, present while the amount is in IDR. */
  pbjt_rate_bps?: number;
  /** Deprecated: the v1.6 name of `reservation_fee_minor`, present while the amount is in IDR. */
  reservation_fee_idr?: number;
  /** Deprecated: the v1.6 name of `v2x_credit_minor_per_kwh`, present while the amount is in IDR. */
  v2x_credit_idr_per_kwh?: number;
}

/** Site fields. On update only the fields sent are changed; an empty string clears a text field. Validation runs at save time. */
export interface SiteInput {
  /** The site's country: its currency, time zones, tax and regulation follow. Default: the organisation's home country. MY and SG need MULTI_COUNTRY=true; it cannot change once the site has a session (409). */
  countryCode?: "ID" | "MY" | "SG";
  /** Per-site tax override honoured by every tax engine, e.g. { "exempt": true, "reason": "private depot" }. */
  taxOverrides?: {
    exempt?: boolean;
    reason?: string;
  };
  name?: string;
  address?: string | null;
  city?: string | null;
  /** Postal code of the site's country: 5 digits (ID, MY), 6 digits (SG). */
  postalCode?: string | null;
  /** 4-digit BPS kabupaten/kota code, e.g. 3171. Indonesian sites only. */
  kabupatenKotaCode?: string | null;
  /** Latitude within the site's country (Indonesia -11.5 to 6.5). */
  lat?: number | null;
  /** Longitude within the site's country (Indonesia 94 to 141.5). */
  lon?: number | null;
  /** One of the country's zones (ID: WIB, WITA, WIT; MY: MYT; SG: SGT). Default: the country's first. */
  timezone?: "Asia/Jakarta" | "Asia/Pontianak" | "Asia/Makassar" | "Asia/Jayapura" | "Asia/Kuala_Lumpur" | "Asia/Kuching" | "Asia/Singapore";
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
  localTaxRateBps?: number;
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
  reservationFeeMinor?: number;
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
  v2xCreditMinorPerKwh?: number;
  /** Deprecated: the v1.6 name of `localTaxRateBps`, present while the amount is in IDR. */
  pbjtRateBps?: number;
  /** Deprecated: the v1.6 name of `reservationFeeMinor`, present while the amount is in IDR. */
  reservationFeeIdr?: number;
  /** Deprecated: the v1.6 name of `v2xCreditMinorPerKwh`, present while the amount is in IDR. */
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
  local_tax_rate_bps?: number;
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
  reservation_fee_minor?: number;
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
  v2x_credit_minor_per_kwh?: number;
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
  /** Deprecated: the v1.6 name of `local_tax_rate_bps`, present while the amount is in IDR. */
  pbjt_rate_bps?: number;
  /** Deprecated: the v1.6 name of `reservation_fee_minor`, present while the amount is in IDR. */
  reservation_fee_idr?: number;
  /** Deprecated: the v1.6 name of `v2x_credit_minor_per_kwh`, present while the amount is in IDR. */
  v2x_credit_idr_per_kwh?: number;
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
  /** (v1.15.0) How the QRIS MDR was arrived at, public sites: the gateway's actual fee and VAT on it where Finance has the payment in its ledger, else PlugSure's estimate. Absent on statements finalised before v1.15.0 (estimated). */
  mdrBasis?: {
    actualMinor?: number;
    estimatedMinor?: number;
    actualPayments?: number;
    estimatedPayments?: number;
    /** Deprecated: the v1.6 name of `actualMinor`, present while the amount is in IDR. */
    actualIdr?: number;
    /** Deprecated: the v1.6 name of `estimatedMinor`, present while the amount is in IDR. */
    estimatedIdr?: number;
  };
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
  gtvMinor?: number;
  localTaxMinor?: number;
  taxMinor?: number;
  grossMinor?: number;
  mdrMinor?: number;
  inReview?: number;
  commissionMinor?: number;
  minimumMinor?: number;
  topUpMinor?: number;
  privateFeeMinor?: number;
  feeMinor?: number;
  /** Deprecated: the v1.6 name of `gtvMinor`, present while the amount is in IDR. */
  gtvIdr?: number;
  /** Deprecated: the v1.6 name of `localTaxMinor`, present while the amount is in IDR. */
  pbjtIdr?: number;
  /** Deprecated: the v1.6 name of `taxMinor`, present while the amount is in IDR. */
  ppnIdr?: number;
  /** Deprecated: the v1.6 name of `grossMinor`, present while the amount is in IDR. */
  grossIdr?: number;
  /** Deprecated: the v1.6 name of `mdrMinor`, present while the amount is in IDR. */
  mdrIdr?: number;
  /** Deprecated: the v1.6 name of `commissionMinor`, present while the amount is in IDR. */
  commissionIdr?: number;
  /** Deprecated: the v1.6 name of `minimumMinor`, present while the amount is in IDR. */
  minimumIdr?: number;
  /** Deprecated: the v1.6 name of `topUpMinor`, present while the amount is in IDR. */
  topUpIdr?: number;
  /** Deprecated: the v1.6 name of `privateFeeMinor`, present while the amount is in IDR. */
  privateFeeIdr?: number;
  /** Deprecated: the v1.6 name of `feeMinor`, present while the amount is in IDR. */
  feeIdr?: number;
}

export interface StatementDue {
  id: string;
  number: string;
  kind: "owner_payout" | "platform_fee";
  currency: string;
  due: number;
  paid: number;
  outstanding: number;
  status: "due" | "partial" | "paid";
}

export interface StatementFinalisedRow {
  /** A calendar month, YYYY-MM. */
  period: string;
  number: string;
  gtv_minor: number;
  commission_minor: number;
  minimum_topup_minor?: number;
  private_fee_minor?: number;
  mdr_credit_minor?: number;
  net_minor: number;
  tax_minor: number;
  total_minor: number;
  owner_share_minor?: number | null;
  finalised_at: string;
  /** Deprecated: the v1.6 name of `gtv_minor`, present while the amount is in IDR. */
  gtv_idr?: number;
  /** Deprecated: the v1.6 name of `commission_minor`, present while the amount is in IDR. */
  commission_idr?: number;
  /** Deprecated: the v1.6 name of `minimum_topup_minor`, present while the amount is in IDR. */
  minimum_topup_idr?: number;
  /** Deprecated: the v1.6 name of `private_fee_minor`, present while the amount is in IDR. */
  private_fee_idr?: number;
  /** Deprecated: the v1.6 name of `mdr_credit_minor`, present while the amount is in IDR. */
  mdr_credit_idr?: number;
  /** Deprecated: the v1.6 name of `net_minor`, present while the amount is in IDR. */
  net_idr?: number;
  /** Deprecated: the v1.6 name of `tax_minor`, present while the amount is in IDR. */
  ppn_idr?: number;
  /** Deprecated: the v1.6 name of `total_minor`, present while the amount is in IDR. */
  total_idr?: number;
  /** Deprecated: the v1.6 name of `owner_share_minor`, present while the amount is in IDR. */
  owner_share_idr?: number | null;
}

export interface StatementParty {
  name: string;
  npwp?: string | null;
  address?: string | null;
}

export interface StatementPayment {
  id: string;
  amount: number;
  currency: string;
  paidOn: string;
  reference: string;
  note?: string | null;
  recordedBy?: string | null;
  recordedAt?: string | null;
  voided: boolean;
  voidedAt?: string | null;
  voidedBy?: string | null;
  voidReason?: string | null;
}

export interface StatementPlan {
  tiers: StatementTier[];
  tierMode: "whole" | "marginal";
  minPerChargerAcMinor: number;
  minPerChargerDcMinor: number;
  privateFeeAcMinor: number;
  privateFeeDcMinor: number;
  mdrBorneBy: "platform" | "site_owner";
  prorate: boolean;
  /** Deprecated: the v1.6 name of `minPerChargerAcMinor`, present while the amount is in IDR. */
  minPerChargerAcIdr?: number;
  /** Deprecated: the v1.6 name of `minPerChargerDcMinor`, present while the amount is in IDR. */
  minPerChargerDcIdr?: number;
  /** Deprecated: the v1.6 name of `privateFeeAcMinor`, present while the amount is in IDR. */
  privateFeeAcIdr?: number;
  /** Deprecated: the v1.6 name of `privateFeeDcMinor`, present while the amount is in IDR. */
  privateFeeDcIdr?: number;
}

/** Fields left out take the published rates. */
export interface StatementPlanInput {
  /** Ascending upper bounds (exclusive); the last tier has upToMinor null. */
  tiers?: {
    name?: string;
    upToMinor?: number | null;
    rateBps: number;
    /** Deprecated: the v1.6 name of `upToMinor`, present while the amount is in IDR. */
    upToIdr?: number | null;
  }[];
  tierMode?: "whole" | "marginal";
  minPerChargerAcMinor?: number;
  minPerChargerDcMinor?: number;
  privateFeeAcMinor?: number;
  privateFeeDcMinor?: number;
  mdrBorneBy?: "platform" | "site_owner";
  prorate?: boolean;
  /** Deprecated: the v1.6 name of `minPerChargerAcMinor`, present while the amount is in IDR. */
  minPerChargerAcIdr?: number;
  /** Deprecated: the v1.6 name of `minPerChargerDcMinor`, present while the amount is in IDR. */
  minPerChargerDcIdr?: number;
  /** Deprecated: the v1.6 name of `privateFeeAcMinor`, present while the amount is in IDR. */
  privateFeeAcIdr?: number;
  /** Deprecated: the v1.6 name of `privateFeeDcMinor`, present while the amount is in IDR. */
  privateFeeDcIdr?: number;
}

export interface StatementSiteLine {
  siteId: string;
  name: string;
  model: "public" | "private";
  tier?: string | null;
  rateBps?: number | null;
  sessions?: number;
  energyKwh?: number;
  gtvMinor?: number;
  localTaxMinor?: number;
  taxMinor?: number;
  grossMinor?: number;
  commissionMinor?: number;
  minimumTopUpMinor?: number;
  privateFeeMinor?: number;
  feeMinor?: number;
  mdrMinor?: number;
  mdrCreditMinor?: number;
  platformShareMinor?: number;
  ownerShareMinor?: number;
  warnings?: string[];
  chargers: StatementChargerLine[];
  /** Deprecated: the v1.6 name of `gtvMinor`, present while the amount is in IDR. */
  gtvIdr?: number;
  /** Deprecated: the v1.6 name of `localTaxMinor`, present while the amount is in IDR. */
  pbjtIdr?: number;
  /** Deprecated: the v1.6 name of `taxMinor`, present while the amount is in IDR. */
  ppnIdr?: number;
  /** Deprecated: the v1.6 name of `grossMinor`, present while the amount is in IDR. */
  grossIdr?: number;
  /** Deprecated: the v1.6 name of `commissionMinor`, present while the amount is in IDR. */
  commissionIdr?: number;
  /** Deprecated: the v1.6 name of `minimumTopUpMinor`, present while the amount is in IDR. */
  minimumTopUpIdr?: number;
  /** Deprecated: the v1.6 name of `privateFeeMinor`, present while the amount is in IDR. */
  privateFeeIdr?: number;
  /** Deprecated: the v1.6 name of `feeMinor`, present while the amount is in IDR. */
  feeIdr?: number;
  /** Deprecated: the v1.6 name of `mdrMinor`, present while the amount is in IDR. */
  mdrIdr?: number;
  /** Deprecated: the v1.6 name of `mdrCreditMinor`, present while the amount is in IDR. */
  mdrCreditIdr?: number;
  /** Deprecated: the v1.6 name of `platformShareMinor`, present while the amount is in IDR. */
  platformShareIdr?: number;
  /** Deprecated: the v1.6 name of `ownerShareMinor`, present while the amount is in IDR. */
  ownerShareIdr?: number;
}

export interface StatementTier {
  name: string;
  upToMinor: number | null;
  rateBps: number;
  /** Deprecated: the v1.6 name of `upToMinor`, present while the amount is in IDR. */
  upToIdr?: number | null;
}

export interface StatementTotals {
  sessions: number;
  energyKwh?: number;
  gtvMinor: number;
  localTaxMinor?: number;
  ppnCollectedMinor?: number;
  grossCollectedMinor?: number;
  commissionMinor?: number;
  minimumTopUpMinor?: number;
  privateFeeMinor?: number;
  feesMinor?: number;
  mdrEstimateMinor?: number;
  mdrCreditMinor?: number;
  netMinor: number;
  taxBaseMinor?: number;
  taxMinor: number;
  totalMinor: number;
  pph23Minor?: number;
  platformShareMinor?: number;
  ownerShareMinor?: number;
  /** Deprecated: the v1.6 name of `gtvMinor`, present while the amount is in IDR. */
  gtvIdr?: number;
  /** Deprecated: the v1.6 name of `localTaxMinor`, present while the amount is in IDR. */
  pbjtIdr?: number;
  /** Deprecated: the v1.6 name of `ppnCollectedMinor`, present while the amount is in IDR. */
  ppnCollectedIdr?: number;
  /** Deprecated: the v1.6 name of `grossCollectedMinor`, present while the amount is in IDR. */
  grossCollectedIdr?: number;
  /** Deprecated: the v1.6 name of `commissionMinor`, present while the amount is in IDR. */
  commissionIdr?: number;
  /** Deprecated: the v1.6 name of `minimumTopUpMinor`, present while the amount is in IDR. */
  minimumTopUpIdr?: number;
  /** Deprecated: the v1.6 name of `privateFeeMinor`, present while the amount is in IDR. */
  privateFeeIdr?: number;
  /** Deprecated: the v1.6 name of `feesMinor`, present while the amount is in IDR. */
  feesIdr?: number;
  /** Deprecated: the v1.6 name of `mdrEstimateMinor`, present while the amount is in IDR. */
  mdrEstimateIdr?: number;
  /** Deprecated: the v1.6 name of `mdrCreditMinor`, present while the amount is in IDR. */
  mdrCreditIdr?: number;
  /** Deprecated: the v1.6 name of `netMinor`, present while the amount is in IDR. */
  netIdr?: number;
  /** Deprecated: the v1.6 name of `taxBaseMinor`, present while the amount is in IDR. */
  ppnDppIdr?: number;
  /** Deprecated: the v1.6 name of `taxBaseMinor`, present while the amount is in IDR. */
  dppIdr?: number;
  /** Deprecated: the v1.6 name of `taxMinor`, present while the amount is in IDR. */
  ppnIdr?: number;
  /** Deprecated: the v1.6 name of `totalMinor`, present while the amount is in IDR. */
  totalIdr?: number;
  /** Deprecated: the v1.6 name of `pph23Minor`, present while the amount is in IDR. */
  pph23Idr?: number;
  /** Deprecated: the v1.6 name of `platformShareMinor`, present while the amount is in IDR. */
  platformShareIdr?: number;
  /** Deprecated: the v1.6 name of `ownerShareMinor`, present while the amount is in IDR. */
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
  monthly_fee_minor: number;
  /** Discount on energy in basis points (1000 = 10%). */
  energy_discount_bps: number;
  /** Member price per kWh, used where it is lower than the tariff. */
  member_rate?: number | null;
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
  /** Deprecated: the v1.6 name of `monthly_fee_minor`, present while the amount is in IDR. */
  monthly_fee_idr?: number;
  /** Deprecated: the v1.6 name of `member_rate`, present while the amount is in IDR. */
  member_rate_idr?: number | null;
}

export interface SubscriptionPlanInput {
  name?: string;
  description?: string;
  /** Set when created (default IDR); fixed after. */
  currency?: "IDR" | "MYR" | "SGD";
  monthlyFeeMinor?: number;
  memberRate?: number | null;
  energyDiscountPercent?: number;
  includedKwh?: number;
  waiveSessionFees?: boolean;
  currentType?: "AC" | "DC" | null;
  siteIds?: string[];
  offeredInApp?: boolean;
  active?: boolean;
  /** Deprecated: the v1.6 name of `monthlyFeeMinor`, present while the amount is in IDR. */
  monthlyFeeIdr?: number;
  /** Deprecated: the v1.6 name of `memberRate`, present while the amount is in IDR. */
  memberRateIdr?: number | null;
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
    amountMinor: number;
    touBlock?: string;
    /** Deprecated: the v1.6 name of `amountMinor`, present while the amount is in IDR. */
    amountIdr?: number;
  }[];
  chargingClass: "slow" | "medium" | "fast" | "ultrafast";
  tax: {
    subtotalMinor: number;
    localTaxBaseMinor?: number;
    localTaxRateBps?: number;
    localTaxMinor: number;
    taxBaseMinor: number;
    ppnRateBps?: number;
    taxMinor: number;
    totalMinor: number;
    /** Deprecated: the v1.6 name of `subtotalMinor`, present while the amount is in IDR. */
    subtotalIdr?: number;
    /** Deprecated: the v1.6 name of `localTaxBaseMinor`, present while the amount is in IDR. */
    pbjtBaseIdr?: number;
    /** Deprecated: the v1.6 name of `localTaxRateBps`, present while the amount is in IDR. */
    pbjtRateBps?: number;
    /** Deprecated: the v1.6 name of `localTaxMinor`, present while the amount is in IDR. */
    pbjtIdr?: number;
    /** Deprecated: the v1.6 name of `taxBaseMinor`, present while the amount is in IDR. */
    ppnDppIdr?: number;
    /** Deprecated: the v1.6 name of `taxBaseMinor`, present while the amount is in IDR. */
    dppIdr?: number;
    /** Deprecated: the v1.6 name of `taxMinor`, present while the amount is in IDR. */
    ppnIdr?: number;
    /** Deprecated: the v1.6 name of `totalMinor`, present while the amount is in IDR. */
    totalIdr?: number;
  };
  flags: TariffFlag[];
  tariffSnapshot: Record<string, unknown>;
}

/** (v1.18.0) A PPh 23 withholding the operator recorded (with its bukti potong), or voided. */
export interface TaxWithholding {
  id: string;
  kind: "gateway_fee" | "platform_fee";
  period: string;
  counterparty: string;
  counterpartyNpwp?: string | null;
  integrationId?: string | null;
  statementId?: string | null;
  base: number;
  rateBps: number;
  amount: number;
  buktiNumber?: string | null;
  buktiDate?: string | null;
  note?: string | null;
  recordedBy?: string | null;
  recordedAt?: string | null;
  voided: boolean;
  voidReason?: string | null;
  /** For platform administrators: the operator that withheld it. */
  operator?: string;
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
  spend_limit_minor?: number | null;
  /** The spending limit's currency; charges in another currency are refused. */
  spend_limit_currency?: string;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
  has_pin: boolean;
  lifetime_energy_wh: number;
  total_sessions: number;
  lifetime_spend_minor: number;
  last_used_at?: string | null;
  /** Deprecated: the v1.6 name of `spend_limit_minor`, present while the amount is in IDR. */
  spend_limit_idr?: number | null;
  /** Deprecated: the v1.6 name of `lifetime_spend_minor`, present while the amount is in IDR. */
  lifetime_spend_idr?: number;
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
  /** Lifetime spend cap, in minor units of spendLimitCurrency. */
  spendLimitMinor?: number | null;
  /** Default IDR. */
  spendLimitCurrency?: "IDR" | "MYR" | "SGD";
  offlineAllowed?: boolean;
  notes?: string | null;
  /** 4-8 digit PIN for the driver app; stored hashed. null removes it. */
  pin?: string | null;
  /** Deprecated: the v1.6 name of `spendLimitMinor`, present while the amount is in IDR. */
  spendLimitIdr?: number | null;
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
  role: "super_admin" | "cpo_operations_manager" | "site_host_landlord" | "field_technician" | "finance_manager" | "financial_auditor" | "site_owner" | "fleet_customer";
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
  /** Two-step verification (authenticator app) is on. */
  mfa_enabled?: boolean;
  /** Bound to a Microsoft account (“Sign in with Microsoft” finds the user by it). */
  microsoft_bound?: boolean;
  microsoft_bound_at?: string | null;
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
  role?: "super_admin" | "cpo_operations_manager" | "site_host_landlord" | "field_technician" | "finance_manager" | "financial_auditor" | "site_owner" | "fleet_customer";
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

export interface WhatsAppChatMessage {
  id: string;
  direction: "in" | "out";
  author: "customer" | "ai" | "staff" | "system";
  /** Text; media is named ("[image: caption]"), not kept. system: a note (handover, an assistant failure). */
  body: string;
  at: string;
  /** A reply's delivery status: accepted, sent, delivered, read or failed. */
  status?: string | null;
  error?: string | null;
  /** The Claude model that wrote an AI reply. */
  model?: string | null;
  tokens?: {
    input?: number;
    output?: number;
  } | null;
}

/** A customer writing to the platform's WhatsApp number (one conversation per number). The number is masked. */
export interface WhatsAppConversation {
  id: string;
  /** Masked, e.g. +6281****890. */
  phone: string;
  /** The WhatsApp profile name the customer chose. */
  name?: string | null;
  /** A PlugSure driver account is registered on the number (the assistant can look up its sessions). */
  hasAccount?: boolean;
  /** Who answers: the AI assistant, staff, or nobody (closed; a new customer message reopens it with the assistant). */
  handler: "ai" | "human" | "closed";
  /** Why it went to staff. */
  handoffReason?: string | null;
  /** The assistant's suggested reply (mode draft, or a suggestion asked for). */
  draft?: string | null;
  lastMessage?: string | null;
  /** customer, ai or staff. */
  lastAuthor?: string | null;
  lastMessageAt: string;
  lastInboundAt?: string | null;
  /** Within 24 hours of the customer's last message: free-form replies are allowed (Meta's customer service window). */
  windowOpen: boolean;
  unread: number;
}

/** One message sent from the platform's number: a sign-in code or a test send, or an operator alert from an alert channel on the same number. The number is masked; codes are never stored. */
export interface WhatsAppMessage {
  /** `m<n>` for the ledger, `a<n>` for an alert notification. */
  id: string;
  at: string;
  purpose: "otp" | "alert" | "test" | "other" | "support";
  /** Masked, e.g. +6281****890. */
  to: string;
  template?: string | null;
  language?: string | null;
  /** accepted: WhatsApp took it, no status report yet. */
  status: "accepted" | "sent" | "delivered" | "read" | "failed";
  errorCode?: string | null;
  /** Why it failed (Meta's title, code and details). */
  error?: string | null;
  sentAt?: string | null;
  deliveredAt?: string | null;
  readAt?: string | null;
  /** From Meta's status: authentication, utility, marketing, service… */
  pricingCategory?: string | null;
  billable?: boolean | null;
}

export interface WhatsAppRequiredTemplate {
  name: string;
  language: string;
  purpose: "otp" | "alert";
  /** False for the default alert template when no alert channel sends from this number yet. */
  inUse: boolean;
  /** Its status at Meta; MISSING when the WABA has no such template; null when the templates could not be read. */
  status?: string | null;
  category?: string | null;
}

export interface WhatsAppTemplate {
  name: string;
  /** APPROVED, PENDING, REJECTED, PAUSED, DISABLED… */
  status: string;
  category?: string | null;
  language: string;
  /** GREEN, YELLOW, RED or UNKNOWN. */
  qualityScore?: string | null;
  rejectedReason?: string | null;
  /** PlugSure sends it (the sign-in code template, an alert channel's template). */
  required?: boolean;
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
    /** In minor units of `currency` (IDR: whole rupiah). */
    totalMinor: number;
    currency: "IDR" | "MYR" | "SGD";
    /** Deprecated: the v1.6 name of `totalMinor`, present while the amount is in IDR. */
    totalIdr?: number;
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
    amountMinor: number;
    currency: "IDR" | "MYR" | "SGD";
    method: "provider" | "manual" | "disbursement";
    reference: string;
    /** Deprecated: the v1.6 name of `amountMinor`, present while the amount is in IDR. */
    amountIdr?: number;
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
    amountMinor: number;
    currency: "IDR" | "MYR" | "SGD";
    reason: string;
    /** Deprecated: the v1.6 name of `amountMinor`, present while the amount is in IDR. */
    amountIdr?: number;
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

export type AccountingExportsResponse = {
  package?: string | null;
  packages?: {
    id?: string;
    label?: string;
  }[];
  months?: {
    month?: string;
    exported?: boolean;
    lastAt?: string | null;
    lastPackage?: string | null;
  }[];
  exports?: {
    id?: string;
    month?: string;
    package?: string;
    packageLabel?: string;
    filename?: string;
    entries?: number;
    totalDebit?: number;
    by?: string | null;
    at?: string;
  }[];
};

export type AccountingJournalResponse = {
  lines?: {
    date?: string;
    entry?: string;
    kind?: string;
    code?: string;
    account?: string;
    debit?: number;
    credit?: number;
    description?: string;
  }[];
  totals?: {
    code?: string;
    account?: string;
    debit?: number;
    credit?: number;
  }[];
};

export type AccountLinesResponse = {
  code?: string;
  month?: string;
  lines?: Record<string, unknown>[];
};

export type AcknowledgeAlertResponse = {
  ok: true;
};

export type AcknowledgeControlFindingBody = {
  key: string;
  note: string;
};

export type AcknowledgeControlFindingResponse = {
  ok?: boolean;
  key?: string;
};

export type ActivateChargePointResponse = {
  ok: true;
  activated: boolean;
};

export type AddAuditorRequestBody = {
  audit: string;
  ref?: string;
  item: string;
  requestedOn?: string;
  dueOn?: string;
  ownerId?: string;
  note?: string;
};

export type AddBankFeedBody = {
  name?: string;
  cashAccountId?: string;
  url?: string;
  token?: string | null;
  enabled?: boolean;
  since?: string;
};

export type AddBankMatchRuleBody = {
  name?: string;
  priority?: number;
  direction?: "any" | "credit" | "debit";
  contains?: string;
  amountMin?: number;
  amountMax?: number;
  action?: "ignore" | "suggest";
  accountCode?: string;
  note?: string;
  enabled?: boolean;
};

export type AddBuktiPotongToWithholdingBody = {
  buktiNumber: string;
  buktiDate: string;
};

export type AddBuktiPotongToWithholdingResponse = {
  ok: boolean;
};

export type AddCapexProjectBody = {
  name?: string;
  siteId?: string;
  currency?: string;
  status?: "planned" | "active";
  budget?: Record<string, unknown>;
  startOn?: string;
  targetOn?: string;
  assetCategory?: string;
  lifeMonths?: number;
  note?: string;
};

export type AddCashAccountBody = {
  name: string;
  kind?: "bank" | "cash";
  bankName?: string;
  accountHint?: string;
  currency: string;
  openingBalance?: number;
  openingOn?: string;
  minimum?: number | null;
};

export type AddCashAccountResponse = {
  id?: string;
  name?: string;
  kind?: "bank" | "cash";
  currency?: string;
  minimum?: number | null;
};

export type AddComplianceTaskBody = {
  title?: string;
  category?: "financial_statements" | "regulator" | "licence" | "corporate" | "tax_other" | "audit" | "other";
  authority?: string;
  dueOn?: string;
  recurrence?: "none" | "monthly" | "quarterly" | "yearly";
  ownerId?: string;
  remindDays?: number;
  note?: string;
};

export type AddCovenantBody = {
  kind: "dscr" | "interest_cover" | "leverage" | "min_cash";
  threshold: number;
  currency: string;
  loanId?: string;
  frequency?: "monthly" | "quarterly";
  enabled?: boolean;
  note?: string;
};

export type AddEmployeeBody = {
  name?: string;
  email?: string;
  nik?: string;
  npwp?: string;
  ptkp?: "TK/0" | "TK/1" | "TK/2" | "TK/3" | "K/0" | "K/1" | "K/2" | "K/3";
  position?: string;
  siteId?: string;
  currency?: string;
  baseSalary?: number;
  allowance?: number;
  bpjsKesehatan?: boolean;
  bpjsKetenagakerjaan?: boolean;
  jkkRatePct?: number;
  bank?: {
    name?: string;
    accountNumber?: string;
    accountName?: string;
  };
  startOn?: string;
  endOn?: string;
};

export type AddEvidenceOrCommentToDisputeBody = {
  note: string;
};

export type AddEvidenceOrCommentToDisputeResponse = {
  notes: Record<string, unknown>[];
};

export type AddGrantBody = {
  grantor?: string;
  programme?: string;
  reference?: string;
  kind?: "capital" | "revenue" | "per_kwh";
  currency?: string;
  awarded?: number;
  ratePerKwh?: number;
  releaseMonths?: number;
  periodFrom?: string;
  periodTo?: string;
  awardedOn?: string;
  siteId?: string;
  capexProjectId?: string;
  status?: "applied" | "awarded" | "active" | "completed" | "rejected" | "clawed_back";
  note?: string;
};

export type AddGrantConditionBody = {
  description: string;
  dueOn?: string;
};

export type AddLandlordDealBody = {
  siteId?: string;
  supplierId?: string;
  reference?: string;
  currency?: string;
  basis?: "fixed" | "share" | "higher_of" | "fixed_plus_share";
  fixed?: number;
  sharePct?: number;
  shareOf?: "revenue" | "margin";
  minimum?: number;
  escalationPct?: number;
  rentFreeMonths?: number;
  rechargePerKwh?: number;
  billing?: "monthly" | "quarterly";
  startOn?: string;
  endOn?: string;
  leaseId?: string;
  status?: "active" | "ended";
  note?: string;
};

export type AddLineToClaimBody = {
  spentOn: string;
  category: "fuel" | "travel" | "meals" | "parking" | "tools" | "supplies" | "phone" | "other";
  siteId?: string;
  description: string;
  amount: number;
  vat?: number;
};

export type AddLineToClaimResponse = {
  id?: string;
  number?: string;
  claimant?: string;
  title?: string;
  currency?: string;
  status?: "draft" | "submitted" | "approved" | "rejected" | "reimbursed" | "void";
  total?: number;
  lines?: Record<string, unknown>[];
};

export type AddLoanBody = {
  lender?: string;
  reference?: string;
  currency?: string;
  facility?: number;
  ratePct?: number;
  startOn?: string;
  termMonths?: number;
  graceMonths?: number;
  repayment?: "annuity" | "equal_principal" | "bullet";
  cashAccountId?: string;
  note?: string;
};

export type AddNoteOrPromiseToPayBody = {
  note: string;
  promiseDate?: string;
};

export type AddNoteOrPromiseToPayResponse = {
  id?: string;
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

export type AddOrChangeAccountBody = {
  name?: string;
  type?: "asset" | "liability" | "equity" | "revenue" | "expense" | "other";
  active?: boolean;
};

export type AddPolicyBody = {
  insurer?: string;
  policyNo?: string;
  kind?: "property" | "equipment" | "liability" | "business_interruption" | "vehicle" | "other";
  siteId?: string;
  chargePointId?: string;
  currency?: string;
  cover?: number;
  premium?: number;
  excess?: number;
  startOn?: string;
  endOn?: string;
  paidOn?: string;
  cashAccountId?: string;
  status?: "active" | "cancelled";
  note?: string;
};

export type AddStandardDeadlinesBody = {
  year?: number;
};

export type AddStockItemBody = {
  sku?: string;
  name?: string;
  unit?: string;
  category?: "part" | "consumable" | "tool";
  currency?: string;
  reorderPoint?: number;
  reorderQty?: number;
  supplierId?: string;
  archived?: boolean;
};

export type AddStockLocationBody = {
  name: string;
  siteId?: string;
  archived?: boolean;
};

export type AddSupplierBody = {
  name: string;
  taxId?: string;
  email?: string;
  phone?: string;
  bank?: {
    name?: string;
    accountNumber?: string;
    accountName?: string;
  };
  termsDays?: number;
  whtPct?: number;
  note?: string;
  archived?: boolean;
};

export type AddSupplierResponse = {
  id?: string;
  name?: string;
  termsDays?: number;
  whtPct?: number;
  archived?: boolean;
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

export type AgreePaymentPlanBody = {
  count: number;
  firstDue: string;
  everyDays?: number;
  graceDays?: number;
  note?: string;
};

export type AllocateCostAcrossGroupBody = {
  month: string;
  description: string;
  total: number;
  currency: string;
  basis?: "kwh" | "sessions" | "revenue" | "equal";
};

export type AllocateCostAcrossGroupResponse = {
  basis?: string;
  total?: number;
  shares?: Record<string, unknown>[];
  recharges?: {
    id?: string;
    number?: string;
    direction?: "out" | "in";
    from?: string;
    to?: string;
    month?: string;
    amount?: number;
    currency?: string;
    status?: "draft" | "issued" | "settled" | "void";
  }[];
};

export type AnswerDisputeCpoSideAcceptOrRejectBody = {
  action: "accept" | "reject";
  note?: string;
};

export type AnswerDisputeCpoSideAcceptOrRejectResponse = {
  dispute: {
    id?: string;
    hub_cdr_id?: string;
    cdr_id?: string;
    raised_by?: "emsp" | "platform";
    reason?: "unknown_token" | "not_authorized" | "duplicate" | "amount" | "energy" | "tariff_mismatch" | "session_not_found" | "other";
    currency?: string;
    claimed_minor?: number | null;
    message?: string;
    status?: "open" | "accepted" | "rejected" | "escalated" | "credited" | "expired" | "resolved" | "withdrawn";
    resolution?: "credited" | "upheld" | "written_off" | null;
    respond_by?: string;
    credit_due_by?: string | null;
    escalate_by?: string | null;
    credit_cdr_id?: string | null;
    /** Deprecated: the v1.6 name of `claimed_minor`, present while the amount is in IDR. */
    claimed_idr?: number | null;
  };
};

export type AnswerSiteOwnerQueryBody = {
  decision: "reject" | "resolve" | "adjust";
  answer: string;
  amount?: number;
};

export type AnswerSiteOwnerQueryResponse = {
  id?: string;
  state?: string;
  amount?: number | null;
  currency?: string;
};

export type ApplyLoadPlanNowResponse = {
  applied: PowerAllocation[];
};

export type ApplyPaymentPlugSureMissedResponse = {
  ok: boolean;
  outcome: string;
};

export type ApprovalsMatrixResponse = {
  rules?: Record<string, {
    above?: number;
    rule?: "finance_approver" | "two_approvers";
  }>;
  canApprove?: boolean;
};

export type ApproveAndSendOwnerPayoutResponse = {
  transfer: PayoutTransfer;
};

export type ApproveAndSendRefundTransferResponse = {
  transfer: RefundTransfer;
};

export type ApproveExpenseClaimResponse = {
  id?: string;
  number?: string;
  claimant?: string;
  title?: string;
  currency?: string;
  status?: "draft" | "submitted" | "approved" | "rejected" | "reimbursed" | "void";
  total?: number;
  lines?: Record<string, unknown>[];
};

export type ApproveJournalEntryResponse = {
  id?: string;
  number?: string;
  date?: string;
  currency?: string;
  source?: string;
  status?: "draft" | "awaiting_approval" | "posted" | "rejected" | "superseded";
  total?: number;
  lines?: Record<string, unknown>[];
};

export type ApproveOrRejectDriverRefundRequestBody = {
  amount?: number;
  note?: string;
};

export type ApproveOrRejectDriverRefundRequestResponse = {
  id?: string;
  state?: string;
  amount?: number;
  paymentId?: string;
};

export type ApproveOrRejectSiteOwnerBankDetailChangeBody = {
  note?: string;
};

export type ApproveOrRejectSiteOwnerBankDetailChangeResponse = {
  ok?: boolean;
  state?: "approved" | "rejected";
  ownerId?: string;
};

export type ApproveOrRejectWriteOffBody = {
  note?: string;
};

export type ApproveOrRejectWriteOffResponse = {
  ok?: boolean;
  state?: string;
};

export type ApprovePurchaseOrderResponse = {
  id?: string;
  number?: string;
  supplier?: string;
  currency?: string;
  status?: "draft" | "awaiting_approval" | "approved" | "closed" | "cancelled" | "rejected";
  ordered?: number;
  received?: number;
  billed?: number;
  toBill?: number;
};

export type ApproveSupplierBillResponse = {
  id?: string;
  supplier?: string;
  number?: string;
  currency?: string;
  payable?: number;
  paid?: number;
  balance?: number;
  status?: "draft" | "awaiting_approval" | "approved" | "paid" | "rejected" | "void";
  dueDate?: string;
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

export type AskToWriteOffWhatIsOutstandingBody = {
  amount?: number;
  reason: string;
};

export type AskToWriteOffWhatIsOutstandingResponse = {
  id?: string;
  amount?: number;
};

export type AskXenditToGenerateReportBody = {
  type: "TRANSACTIONS" | "BALANCE_HISTORY" | "UPCOMING_TRANSACTIONS";
};

export type AskXenditToGenerateReportResponse = {
  report: GatewayReport;
};

export type AssetResponse = {
  id?: string;
  tag?: string;
  schedule?: {
    month?: string;
    depreciation?: number;
    accumulated?: number;
    netBookValue?: number;
  }[];
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

export type AttachEvidenceToRequestBody = {
  filename?: string;
  mime: "application/pdf" | "image/png" | "image/jpeg" | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "text/csv";
  data: string;
};

export type AttachEvidenceToTaskBody = {
  filename?: string;
  mime: "application/pdf" | "image/png" | "image/jpeg" | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "text/csv";
  data: string;
};

export type AttachReceiptBody = {
  filename?: string;
  mime: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
  data: string;
};

export type AttachReceiptResponse = {
  id?: string;
  number?: string;
  claimant?: string;
  title?: string;
  currency?: string;
  status?: "draft" | "submitted" | "approved" | "rejected" | "reimbursed" | "void";
  total?: number;
  lines?: Record<string, unknown>[];
};

export type AutomaticOwnerPayoutsResponse = {
  settings?: Record<string, unknown>;
  rails?: string[];
  candidates?: Record<string, unknown>[];
  rules?: Record<string, unknown>[];
};

export type BadDebtProvisionResponse = {
  rates?: Record<string, unknown>;
  currencies?: Record<string, unknown>[];
  history?: Record<string, unknown>[];
};

export type BankStatementLinesAndTheirMatchesResponse = {
  lines: {
    id?: string;
    statementId?: string;
    date?: string;
    description?: string;
    reference?: string | null;
    amount?: number;
    balance?: number | null;
    match?: {
      kind?: "gateway_withdrawal" | "statement_payment" | "refund" | "roaming_payment" | "supplier_payment" | "ignored";
      ref?: string | null;
      auto?: boolean;
      by?: string | null;
      note?: string | null;
      label?: string | null;
    } | null;
  }[];
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

export type BlockTokenBody = {
  reason?: string;
};

export type BudgetsVsActualsForMonthResponse = {
  month?: string;
  alertPct?: number;
  organisation?: Record<string, unknown>[];
  sites?: Record<string, unknown>[];
};

export type CancelCapexProjectBody = {
  reason: string;
  cancelledOn?: string;
};

export type CancelFirmwareCampaignResponse = {
  ok: true;
};

export type CancelPaymentPlanBody = {
  reason: string;
};

export type CancelPurchaseOrderBody = {
  reason: string;
};

export type CancelPurchaseOrderResponse = {
  id?: string;
  number?: string;
  supplier?: string;
  currency?: string;
  status?: "draft" | "awaiting_approval" | "approved" | "closed" | "cancelled" | "rejected";
  ordered?: number;
  received?: number;
  billed?: number;
  toBill?: number;
};

export type CardHoldsAndPostPayEWalletChargesResponse = {
  holds: CardHold[];
  summary: {
    held: number;
    inProgress: number;
    failed: number;
    /** Rupiah (IDR). */
    heldMinor: number;
    expired?: number;
    /** Rupiah (IDR). */
    expiredMinor?: number;
    expiredByCurrency?: Record<string, number>;
    /** Deprecated: the v1.6 name of `heldMinor`, present while the amount is in IDR. */
    heldIdr?: number;
    /** Deprecated: the v1.6 name of `expiredMinor`, present while the amount is in IDR. */
    expiredIdr?: number;
  };
};

export type CashAccountsResponse = {
  accounts?: {
    id?: string;
    name?: string;
    kind?: "bank" | "cash";
    currency?: string;
    minimum?: number | null;
  }[];
};

export type CashFlowForecastResponse = {
  days?: number;
  termsDays?: number;
  runRate?: boolean;
  from?: string;
  to?: string;
  opening?: {
    total?: number;
    gateway?: number | null;
    gatewayAt?: string | null;
    bank?: number | null;
    bankAsOf?: string | null;
  };
  totals?: {
    in?: number;
    out?: number;
    estimate?: number;
  };
  closing?: number;
  lowest?: {
    day?: string;
    position?: number;
  };
  shortfall?: {
    day?: string;
    position?: number;
  } | null;
  dailyRunRate?: number;
  series?: {
    day?: string;
    in?: number;
    out?: number;
    estimate?: number;
    position?: number;
  }[];
  flows?: {
    day?: string;
    kind?: "settlement" | "fleet_invoice" | "hub_in" | "postpay" | "refund" | "owner_payout" | "platform_statement" | "hub_out";
    label?: string;
    amount?: number;
  }[];
};

export type CashPositionResponse = {
  date?: string;
  accounts?: Record<string, unknown>[];
  gateways?: Record<string, unknown>[];
  totals?: Record<string, unknown>;
  daily?: Record<string, unknown>;
  stale?: string[];
  transfers?: Record<string, unknown>[];
};

export type ChangeApiKeyNameOrRateLimitBody = {
  name?: string;
  rateLimitPerMin?: number | null;
};

export type ChangeBankFeedBody = {
  name?: string;
  cashAccountId?: string;
  url?: string;
  token?: string | null;
  enabled?: boolean;
  since?: string;
};

export type ChangeBankMatchRuleBody = {
  name?: string;
  priority?: number;
  direction?: "any" | "credit" | "debit";
  contains?: string;
  amountMin?: number;
  amountMax?: number;
  action?: "ignore" | "suggest";
  accountCode?: string;
  note?: string;
  enabled?: boolean;
};

export type ChangeCapexProjectBody = {
  name?: string;
  siteId?: string;
  currency?: string;
  status?: "planned" | "active";
  budget?: Record<string, unknown>;
  startOn?: string;
  targetOn?: string;
  assetCategory?: string;
  lifeMonths?: number;
  note?: string;
};

export type ChangeCashAccountBody = {
  name?: string;
  bankName?: string;
  accountHint?: string;
  minimum?: number | null;
  archived?: boolean;
};

export type ChangeCashAccountResponse = {
  id?: string;
  name?: string;
  kind?: "bank" | "cash";
  currency?: string;
  minimum?: number | null;
};

export type ChangeComplianceTaskBody = {
  title?: string;
  category?: "financial_statements" | "regulator" | "licence" | "corporate" | "tax_other" | "audit" | "other";
  authority?: string;
  dueOn?: string;
  recurrence?: "none" | "monthly" | "quarterly" | "yearly";
  ownerId?: string;
  remindDays?: number;
  note?: string;
};

export type ChangeConnectorAvailabilityBody = {
  /** 0 = the whole station. */
  connectorId?: number;
  type?: "Operative" | "Inoperative";
  /** Required (at least 3 characters) for Inoperative. */
  reason?: string;
};

export type ChangeCovenantBody = {
  kind: "dscr" | "interest_cover" | "leverage" | "min_cash";
  threshold: number;
  currency: string;
  loanId?: string;
  frequency?: "monthly" | "quarterly";
  enabled?: boolean;
  note?: string;
};

export type ChangeDriverAppRoamingSettingsBody = {
  appDrivers?: boolean;
  /** Hold per currency code, minor units. */
  holdMinor?: Record<string, number | null>;
  /** Deprecated: the v1.6 name of `holdMinor`, present while the amount is in IDR. */
  holdIdr?: Record<string, number | null>;
};

export type ChangeDriverAppRoamingSettingsResponse = {
  ok: boolean;
  appDrivers?: boolean;
  holdMinor?: Record<string, unknown>;
  /** Deprecated: the v1.6 name of `holdMinor`, present while the amount is in IDR. */
  holdIdr?: Record<string, unknown>;
};

export type ChangeEmployeeBody = {
  name?: string;
  email?: string;
  nik?: string;
  npwp?: string;
  ptkp?: "TK/0" | "TK/1" | "TK/2" | "TK/3" | "K/0" | "K/1" | "K/2" | "K/3";
  position?: string;
  siteId?: string;
  currency?: string;
  baseSalary?: number;
  allowance?: number;
  bpjsKesehatan?: boolean;
  bpjsKetenagakerjaan?: boolean;
  jkkRatePct?: number;
  bank?: {
    name?: string;
    accountNumber?: string;
    accountName?: string;
  };
  startOn?: string;
  endOn?: string;
};

export type ChangeFleetAccountCardsBody = {
  add?: string[];
  remove?: string[];
};

export type ChangeFleetAccountCardsResponse = {
  account: FleetAccountDetail;
  unknown: string[];
};

export type ChangeGrantBody = {
  grantor?: string;
  programme?: string;
  reference?: string;
  kind?: "capital" | "revenue" | "per_kwh";
  currency?: string;
  awarded?: number;
  ratePerKwh?: number;
  releaseMonths?: number;
  periodFrom?: string;
  periodTo?: string;
  awardedOn?: string;
  siteId?: string;
  capexProjectId?: string;
  status?: "applied" | "awarded" | "active" | "completed" | "rejected" | "clawed_back";
  note?: string;
};

export type ChangeHomeCountryReportingTimeZoneOrDefaultLanguageBody = {
  homeCountry?: "ID" | "MY" | "SG";
  /** IANA zone, e.g. Asia/Singapore. */
  timezone?: string;
  defaultLocale?: "id" | "en";
};

export type ChangeLandlordDealBody = {
  siteId?: string;
  supplierId?: string;
  reference?: string;
  currency?: string;
  basis?: "fixed" | "share" | "higher_of" | "fixed_plus_share";
  fixed?: number;
  sharePct?: number;
  shareOf?: "revenue" | "margin";
  minimum?: number;
  escalationPct?: number;
  rentFreeMonths?: number;
  rechargePerKwh?: number;
  billing?: "monthly" | "quarterly";
  startOn?: string;
  endOn?: string;
  leaseId?: string;
  status?: "active" | "ended";
  note?: string;
};

export type ChangeLoanBody = {
  lender?: string;
  reference?: string;
  currency?: string;
  facility?: number;
  ratePct?: number;
  startOn?: string;
  termMonths?: number;
  graceMonths?: number;
  repayment?: "annuity" | "equal_principal" | "bullet";
  cashAccountId?: string;
  note?: string;
};

export type ChangeNativeAppsVersionGateAndRemoteConfigurationResponse = {
  appConfig: DriverAppConfig;
};

export type ChangePayrollLineBody = {
  overtime?: number;
  bonus?: number;
  deduction?: number;
};

export type ChangePolicyBody = {
  insurer?: string;
  policyNo?: string;
  kind?: "property" | "equipment" | "liability" | "business_interruption" | "vehicle" | "other";
  siteId?: string;
  chargePointId?: string;
  currency?: string;
  cover?: number;
  premium?: number;
  excess?: number;
  startOn?: string;
  endOn?: string;
  paidOn?: string;
  cashAccountId?: string;
  status?: "active" | "cancelled";
  note?: string;
};

export type ChangeStockItemBody = {
  sku?: string;
  name?: string;
  unit?: string;
  category?: "part" | "consumable" | "tool";
  currency?: string;
  reorderPoint?: number;
  reorderQty?: number;
  supplierId?: string;
  archived?: boolean;
};

export type ChangeStockLocationBody = {
  name: string;
  siteId?: string;
  archived?: boolean;
};

export type ChangeSupplierBody = {
  name?: string;
  taxId?: string;
  email?: string;
  phone?: string;
  bank?: {
    name?: string;
    accountNumber?: string;
    accountName?: string;
  };
  termsDays?: number;
  whtPct?: number;
  note?: string;
  archived?: boolean;
};

export type ChangeSupplierResponse = {
  id?: string;
  name?: string;
  termsDays?: number;
  whtPct?: number;
  archived?: boolean;
};

export type ChangeWorkOrderBody = {
  title?: string;
  kind?: "corrective" | "preventive" | "warranty";
  status?: "open" | "in_progress" | "done" | "cancelled";
  chargePointId?: string;
  siteId?: string;
  currency?: string;
  description?: string;
  openedOn?: string;
  doneOn?: string;
  labourHours?: number;
  labourRate?: number;
  contractorEstimate?: number;
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

export type ChartOfAccountsResponse = {
  accounts?: {
    code?: string;
    name?: string;
    type?: string;
    active?: boolean;
  }[];
};

export type CheckAndroidNotificationsServiceAccountWithGoogleAgainResponse = DriverAppView & {
  androidPushDevices?: number;
};

export type CheckChargingProfileDriftResponse = {
  checked: number;
  drift: number;
};

export type CheckDayForRevenueDropsBody = {
  day: string;
};

export type CheckDayForRevenueDropsResponse = {
  day?: string;
  found?: Record<string, unknown>[];
};

export type CheckSiteOwnerBankAccountByNameResponse = {
  check: {
    status?: "matched" | "mismatch" | "failed";
    bankName?: string | null;
    error?: string | null;
  };
  account: OwnerBankAccount;
};

export type ClaimGrantBody = {
  periodFrom?: string;
  periodTo?: string;
  kwh?: number;
  amount?: number;
  submit?: boolean;
  reference?: string;
  note?: string;
};

export type ClaimWarrantyBody = {
  supplierId: string;
  amount?: number;
  reference?: string;
  note?: string;
  submittedOn?: string;
};

export type ClearReviewAndBillSessionBody = {
  /** Bill despite a rating violation. */
  force?: boolean;
};

export type CloseDepositBody = {
  closedOn?: string;
  interestReceived?: number;
  penalty?: number;
  note?: string;
  rollover?: {
    termMonths?: number;
    termDays?: number;
    maturityOn?: string;
    ratePct?: number;
    withInterest?: boolean;
    reference?: string;
  };
};

export type CloseDepositResponse = {
  id?: string;
  bankName?: string;
  currency?: string;
  principal?: number;
  ratePct?: number;
  placedOn?: string;
  maturityOn?: string;
  status?: "active" | "matured" | "broken";
  accrued?: Record<string, unknown>;
  atMaturity?: Record<string, unknown>;
};

export type ClosePurchaseOrderBody = {
  reason: string;
};

export type ClosePurchaseOrderResponse = {
  id?: string;
  number?: string;
  supplier?: string;
  currency?: string;
  status?: "draft" | "awaiting_approval" | "approved" | "closed" | "cancelled" | "rejected";
  ordered?: number;
  received?: number;
  billed?: number;
  toBill?: number;
};

export type CloseYearResponse = {
  year?: number;
  locked?: string[];
  alreadyLocked?: string[];
};

export type CompleteCapexProjectBody = {
  completedOn?: string;
  inService?: string;
  category?: string;
  lifeMonths?: number;
};

export type CompleteComplianceTaskBody = {
  status: "done" | "waived" | "open";
  doneOn?: string;
  note?: string;
};

export type ConfirmPaymentWasReceivedPayeeResponse = {
  payment: {
    id?: string;
    position_id?: string;
    payer_member_id?: string;
    payee_member_id?: string;
    currency?: string;
    amount_minor?: number;
    method?: string;
    reference?: string | null;
    paid_at?: string;
    recorded_side?: string;
    confirmed_by_payee_at?: string | null;
    /** Deprecated: the v1.6 name of `amount_minor`, present while the amount is in IDR. */
    amount_idr?: number;
  };
  position: {
    id?: string;
    run_id?: string;
    currency?: string;
    member_a_id?: string;
    member_b_id?: string;
    a_owes_b_minor?: number;
    b_owes_a_minor?: number;
    net_minor?: number;
    payer_member_id?: string | null;
    payee_member_id?: string | null;
    cdr_count?: number;
    paid_minor?: number;
    outstanding_minor?: number;
    status?: "open" | "partially_paid" | "paid" | "confirmed" | "overdue" | "written_off" | "nothing_due";
    due_date?: string;
    overdue_since?: string | null;
    period?: string | null;
    /** Deprecated: the v1.6 name of `a_owes_b_minor`, present while the amount is in IDR. */
    a_owes_b_idr?: number;
    /** Deprecated: the v1.6 name of `b_owes_a_minor`, present while the amount is in IDR. */
    b_owes_a_idr?: number;
    /** Deprecated: the v1.6 name of `net_minor`, present while the amount is in IDR. */
    net_idr?: number;
    /** Deprecated: the v1.6 name of `paid_minor`, present while the amount is in IDR. */
    paid_idr?: number;
    /** Deprecated: the v1.6 name of `outstanding_minor`, present while the amount is in IDR. */
    outstanding_idr?: number;
  };
};

export type ConnectOrChangeIntegrationResponse = {
  id?: string;
  scope?: "org" | "platform";
  provider?: string;
  /** Payments: the country this acquirer account serves (ID for every v1.6 account). */
  countryCode?: "ID" | "MY" | "SG";
  /** Non-secret settings. */
  settings?: Record<string, unknown>;
  /** Secret fields that are set, as a hint (last characters). Secret values are never returned. */
  secretHints?: Record<string, unknown>;
  enabled?: boolean;
  webhookPath?: string | null;
  webhookUrl?: string | null;
  /** Sign-in codes on the WhatsApp Cloud API: the verify token for the Meta app's status webhook (webhookUrl, /hooks/whatsapp-cloud/<key>), made by the server on the first save. Platform administrators only. */
  webhookVerifyToken?: string;
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

export type CopyMonthBudgetForwardBody = {
  from: string;
  months: number;
};

export type CopyMonthBudgetForwardResponse = {
  copied?: number;
};

export type CountPettyCashBody = {
  countedOn?: string;
  denominations?: Record<string, unknown>;
  total?: number;
  note?: string;
};

export type CountPettyCashResponse = {
  accountId?: string;
  countedOn?: string;
  total?: number;
  expected?: number | null;
  difference?: number | null;
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

export type CreateOrChangeConsoleBrandBody = {
  productName?: string;
  tagline?: string | null;
  brandColor?: string;
  accentColor?: string;
  hostname?: string | null;
  showPoweredBy?: boolean;
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
  amountMinor?: number;
  /** The charge point. */
  ocppIdentity: string;
  connectorId?: number;
  /** A token this organisation issued to the driver; omit for a walk-up. */
  idToken?: string;
  /** Deprecated: the v1.6 name of `amountMinor`, present while the amount is in IDR. */
  amountIdr?: number;
};

export type CreateReportEMailScheduleBody = {
  name: string;
  reports: ("summary" | "margin" | "collections" | "budgets" | "forecast")[];
  frequency: "weekly" | "monthly";
  weekday?: number;
  recipients: string[];
  accountId?: string;
  enabled?: boolean;
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
  /** The tariff's country: its regulation, tax and currency (IDR, MYR, SGD). Rates are decimals in that currency's major unit. MY and SG need MULTI_COUNTRY=true. */
  countryCode?: "ID" | "MY" | "SG";
  /** The rates include the tax (default: SG and MY yes, ID no; Indonesian tariffs cannot). */
  pricesIncludeTax?: boolean;
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

export type DecideCreditReviewBody = {
  decision: "approve" | "reject";
  newLimit?: number;
  hold?: boolean;
  note?: string;
  nextReviewOn?: string;
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

export type DepositResponse = {
  id?: string;
  bankName?: string;
  currency?: string;
  principal?: number;
  ratePct?: number;
  placedOn?: string;
  maturityOn?: string;
  status?: "active" | "matured" | "broken";
  accrued?: Record<string, unknown>;
  atMaturity?: Record<string, unknown>;
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

export type DisconnectMicrosoftTenantResponse = {
  ok: true;
  tenantId: string;
  usersUnbound: number;
  sessionsEnded: number;
};

export type DisconnectRoamingPartnerResponse = {
  ok: true;
};

export type DisposeOfAssetBody = {
  disposedOn: string;
  proceeds?: number;
  note: string;
};

export type DisposeOfAssetResponse = {
  id?: string;
  tag?: string;
  category?: string;
  currency?: string;
  cost?: number;
  accumulated?: number;
  netBookValue?: number;
  status?: string;
};

export type DisputeCdrEMSPSideWithinItsDisputeWindowBody = {
  reason: "unknown_token" | "not_authorized" | "duplicate" | "amount" | "energy" | "tariff_mismatch" | "session_not_found" | "other";
  message: string;
  claimed_minor?: number;
  /** Deprecated: the v1.6 name of `claimed_minor`, present while the amount is in IDR. */
  claimed_idr?: number;
};

export type DisputeCdrEMSPSideWithinItsDisputeWindowResponse = {
  dispute: {
    id?: string;
    hub_cdr_id?: string;
    cdr_id?: string;
    raised_by?: "emsp" | "platform";
    reason?: "unknown_token" | "not_authorized" | "duplicate" | "amount" | "energy" | "tariff_mismatch" | "session_not_found" | "other";
    currency?: string;
    claimed_minor?: number | null;
    message?: string;
    status?: "open" | "accepted" | "rejected" | "escalated" | "credited" | "expired" | "resolved" | "withdrawn";
    resolution?: "credited" | "upheld" | "written_off" | null;
    respond_by?: string;
    credit_due_by?: string | null;
    escalate_by?: string | null;
    credit_cdr_id?: string | null;
    /** Deprecated: the v1.6 name of `claimed_minor`, present while the amount is in IDR. */
    claimed_idr?: number | null;
  };
};

export type DisputeWithItsNotesResponse = {
  dispute: {
    id?: string;
    hub_cdr_id?: string;
    cdr_id?: string;
    raised_by?: "emsp" | "platform";
    reason?: "unknown_token" | "not_authorized" | "duplicate" | "amount" | "energy" | "tariff_mismatch" | "session_not_found" | "other";
    currency?: string;
    claimed_minor?: number | null;
    message?: string;
    status?: "open" | "accepted" | "rejected" | "escalated" | "credited" | "expired" | "resolved" | "withdrawn";
    resolution?: "credited" | "upheld" | "written_off" | null;
    respond_by?: string;
    credit_due_by?: string | null;
    escalate_by?: string | null;
    credit_cdr_id?: string | null;
    /** Deprecated: the v1.6 name of `claimed_minor`, present while the amount is in IDR. */
    claimed_idr?: number | null;
  };
  notes: Record<string, unknown>[];
};

export type DraftLandlordStatementBody = {
  month: string;
};

export type DraftPayrollRunBody = {
  month: string;
  currency?: string;
};

export type DraftReportPackBody = {
  month: string;
  currency?: string;
};

export type DriverFundsResponse = {
  position?: Record<string, unknown>;
  movement?: Record<string, unknown>;
  recognised?: Record<string, unknown>[];
};

export type DriversRefundRequestsResponse = {
  requests?: Record<string, unknown>[];
  pending?: number;
  policy?: Record<string, unknown>;
};

export type ElectricityTariffsResponse = {
  sites?: Record<string, unknown>[];
  catalogue?: Record<string, unknown>[];
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

export type EMailStatementOfAccountBody = {
  month: string;
  to?: string;
};

export type EMailStatementOfAccountResponse = {
  ok?: boolean;
  to?: string;
  month?: string;
  reference?: string | null;
};

export type EndLeaseEarlyBody = {
  month: string;
  note: string;
};

export type EndLeaseEarlyResponse = {
  id?: string;
  description?: string;
  currency?: string;
  startMonth?: string;
  termMonths?: number;
  initialLiability?: number;
  position?: Record<string, unknown>;
  status?: string;
};

export type EndSharedCostBody = {
  monthTo: string;
};

export type EndSharedCostResponse = {
  id?: string;
  monthTo?: string;
};

export type EnergyCostAndMarginByMonthResponse = {
  months?: {
    month?: string;
    currency?: string;
    kwh?: number;
    revenue?: number;
    energyCost?: number;
    estimated?: boolean;
    margin?: number;
  }[];
};

export type EnergyCostAndMarginForMonthResponse = {
  month?: string;
  sites?: {
    siteId?: string;
    site?: string;
    currency?: string;
    sessions?: number;
    kwh?: number;
    revenue?: number;
    energyCost?: number | null;
    source?: "bill" | "estimate" | "unknown";
    ratePerKwh?: number | null;
    costPerKwh?: number | null;
    bill?: Record<string, unknown> | null;
    lossPct?: number | null;
    margin?: number | null;
    marginPct?: number | null;
    chargers?: Record<string, unknown>[];
  }[];
  totals?: Record<string, Record<string, unknown>>;
};

export type EnrolMemberBody = {
  planId: string;
  subscriberKind: "fleet_account" | "card";
  fleetAccountId?: string;
  cardUid?: string;
  billing?: "invoice" | "complimentary";
  notes?: string;
};

export type EscalateRejectedDisputeToPlatformEMSPSideBody = {
  note?: string;
};

export type EscalateRejectedDisputeToPlatformEMSPSideResponse = {
  dispute: {
    id?: string;
    hub_cdr_id?: string;
    cdr_id?: string;
    raised_by?: "emsp" | "platform";
    reason?: "unknown_token" | "not_authorized" | "duplicate" | "amount" | "energy" | "tariff_mismatch" | "session_not_found" | "other";
    currency?: string;
    claimed_minor?: number | null;
    message?: string;
    status?: "open" | "accepted" | "rejected" | "escalated" | "credited" | "expired" | "resolved" | "withdrawn";
    resolution?: "credited" | "upheld" | "written_off" | null;
    respond_by?: string;
    credit_due_by?: string | null;
    escalate_by?: string | null;
    credit_cdr_id?: string | null;
    /** Deprecated: the v1.6 name of `claimed_minor`, present while the amount is in IDR. */
    claimed_idr?: number | null;
  };
};

export type EstimateCarbonCreditsBody = {
  from: string;
  to: string;
};

export type ExpenseClaimResponse = {
  id?: string;
  number?: string;
  claimant?: string;
  title?: string;
  currency?: string;
  status?: "draft" | "submitted" | "approved" | "rejected" | "reimbursed" | "void";
  total?: number;
  lines?: Record<string, unknown>[];
};

export type ExpenseClaimsResponse = {
  claims?: {
    id?: string;
    number?: string;
    claimant?: string;
    title?: string;
    currency?: string;
    status?: "draft" | "submitted" | "approved" | "rejected" | "reimbursed" | "void";
    total?: number;
    lines?: Record<string, unknown>[];
  }[];
  toReimburse?: Record<string, unknown>;
  policy?: Record<string, unknown>;
};

export type ExportClosedMonthToAccountingPackageBody = {
  month: string;
  package?: "jurnal" | "accurate" | "generic";
};

export type ExportDayNowBody = {
  day: string;
};

export type ExportDayNowResponse = {
  id?: string;
  day?: string;
  target?: string;
  files?: Record<string, unknown>[];
};

export type FetchMonthEcbReferenceRatesBody = {
  month: string;
};

export type FetchMonthEcbReferenceRatesResponse = {
  month?: string;
  reporting?: string;
  date?: string;
  rates?: Record<string, unknown>[];
  failed?: Record<string, unknown>[];
};

export type FetchPkiRootCertificatesResponse = {
  anchors: PncTrustAnchor[];
  received: number;
};

export type FinaliseRoamingSettlementBody = {
  month: string;
  currency: string;
};

export type FinaliseRoamingSettlementResponse = {
  id?: string;
  number?: string;
  net?: number;
  direction?: string;
  outstanding?: number;
};

export type FinanceAnomalyReviewResponse = {
  status?: string;
  findings?: {
    id?: string;
    kind?: string;
    severity?: string;
    message?: string;
    status?: "open" | "dismissed" | "confirmed" | "cleared";
  }[];
  summary?: Record<string, unknown>[];
  settings?: Record<string, unknown>;
};

export type FinanceChangeLogResponse = {
  from?: string;
  to?: string;
  entries?: Record<string, unknown>[];
  truncated?: boolean;
};

export type FinanceControlsResponse = {
  month?: string;
  settings?: Record<string, unknown>;
  summary?: Record<string, unknown>[];
  findings?: Record<string, unknown>[];
  approvers?: Record<string, unknown>[];
};

export type FinanceDataExportResponse = {
  settings?: Record<string, unknown>;
  runs?: Record<string, unknown>[];
  datasets?: Record<string, unknown>;
};

export type FinanceOverviewResponse = {
  account: FinanceAccount;
  period?: {
    from?: string;
    to?: string;
    timeZone?: string;
  };
  currency?: string;
  collected: number;
  payments?: number;
  fees?: number;
  vat?: number;
  withholdingTax?: number;
  feeRate?: number | null;
  refunds?: number;
  refundCount?: number;
  payouts?: number;
  settled?: number;
  net: number;
  receivable: {
    amount?: number;
    count?: number;
    overdue?: number;
    byDay?: {
      day?: string;
      amount?: number;
      count?: number;
    }[];
  };
  balance?: {
    amount?: number;
    at?: string;
  } | null;
  payable?: {
    refundsDue?: number;
    refundsDueCount?: number;
  };
  byChannel?: {
    channel?: string;
    count?: number;
    amount?: number;
    fees?: number;
  }[];
  daily?: {
    day?: string;
    collected?: number;
    fees?: number;
    refunds?: number;
  }[];
  exceptionsOpen?: number;
  sync?: {
    lastRunAt?: string | null;
    ok?: boolean | null;
    error?: string | null;
    rows?: number | null;
    complete?: boolean;
    lastReconciledAt?: string | null;
  } | null;
};

export type FinanceScorecardResponse = {
  month?: string;
  currency?: string | null;
  kpis?: {
    kpi?: string;
    actual?: number | null;
    target?: number | null;
    rag?: string | null;
  }[];
  counts?: Record<string, unknown>;
  trend?: Record<string, unknown>[];
  settings?: Record<string, unknown>;
};

export type FinanceSettingsResponse = {
  settings: {
    journalAccounts?: Record<string, {
      code?: string;
      name?: string;
    }>;
    closeEmail?: {
      enabled?: boolean;
      recipients?: string[];
      sentPeriod?: string | null;
      lastError?: string | null;
      lastAt?: string | null;
    };
  };
  defaults?: Record<string, {
    code?: string;
    name?: string;
  }>;
  labels?: Record<string, string>;
};

export type FinanceSummaryKeyFiguresResponse = {
  asOf?: string;
  month?: string;
  months?: string[];
  perCurrency?: Record<string, unknown>[];
  consolidated?: Record<string, unknown> | null;
};

export type FinanceTodayResponse = {
  day?: string;
  today?: Record<string, unknown>[];
  month?: Record<string, unknown>[];
  approvals?: Record<string, unknown>[];
  waiting?: number;
};

export type FixedAssetRegisterResponse = {
  asOf?: string;
  assets?: {
    id?: string;
    tag?: string;
    category?: string;
    currency?: string;
    cost?: number;
    accumulated?: number;
    netBookValue?: number;
    status?: string;
  }[];
  totals?: Record<string, unknown>;
  byCategory?: Record<string, unknown>;
  investmentsNotImported?: number;
  runs?: Record<string, unknown>[];
  accounts?: Record<string, unknown>;
};

export type FleetAccountCreditPositionResponse = {
  mode?: "none" | "credit" | "prepaid";
  currency?: string;
  limit?: number;
  deposit?: number;
  owed?: number;
  available?: number | null;
  usedPct?: number | null;
  over?: boolean;
  entries?: Record<string, unknown>[];
};

export type FleetAccountStatementOfAccountResponse = {
  month?: string;
  from?: string;
  to?: string;
  account?: Record<string, unknown>;
  seller?: Record<string, unknown>;
  currencies?: {
    currency?: string;
    opening?: number;
    closing?: number;
    entries?: Record<string, unknown>[];
    open?: Record<string, unknown>[];
    aging?: Record<string, unknown>;
  }[];
};

export type FleetAccountsWithCreditLimitOrDepositResponse = {
  accounts?: Record<string, unknown>[];
};

export type FleetInvoicingAutomationResponse = {
  settings?: Record<string, unknown>;
  month?: string;
  toSend?: Record<string, unknown>[];
  links?: Record<string, unknown>[];
};

export type GatewayFeeAuditResponse = {
  rates?: Record<string, {
    pct?: number;
    fixed?: number;
    min?: number;
    freeUpTo?: number;
  }>;
  tolerance?: number;
  rated?: boolean;
  unrated?: string[];
  totals?: {
    payments?: number;
    overcharge?: number;
    overcharged?: number;
  };
  byMonth?: {
    month?: string;
    method?: string;
    payments?: number;
    amount?: number;
    charged?: number;
    expected?: number | null;
    over?: number;
    overCount?: number;
    effectiveRate?: number | null;
  }[];
  overcharged?: {
    id?: string;
    externalId?: string;
    reference?: string | null;
    at?: string;
    method?: string;
    amount?: number;
    charged?: number;
    expected?: number;
    over?: number;
  }[];
};

export type GatewayFeesResponse = {
  rows: {
    month?: string;
    channel?: string;
    count?: number;
    amount?: number;
    fee?: number;
    vat?: number;
    withholdingTax?: number;
    total?: number;
    rate?: number | null;
  }[];
  qris: {
    payments?: number;
    actual?: number;
    estimated?: number;
    difference?: number;
  };
};

export type GatewayTransactionsResponse = {
  transactions: GatewayTransaction[];
  nextBefore: string | null;
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

export type GetConnectedMicrosoftTenantResponse = {
  tenant: MicrosoftTenant | null;
  boundUsers: number;
  /** Null when this console address does not offer Microsoft sign-in. */
  redirectUri: string | null;
};

export type GetDriverAppRoamingSettingsResponse = {
  appDrivers: boolean;
  holds: {
    currency: string;
    /** Minor units of the currency. */
    holdMinor: number;
    defaultMinor: number;
    custom: boolean;
    /** Deprecated: the v1.6 name of `holdMinor`, present while the amount is in IDR. */
    holdIdr?: number;
    /** Deprecated: the v1.6 name of `defaultMinor`, present while the amount is in IDR. */
    defaultIdr?: number;
  }[];
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
    taxMinor?: number;
    roamingMinor?: number;
    totalMinor: number;
    dueDate?: string | null;
    overdue?: boolean;
    efakturExported?: boolean;
    efakturNumber?: string | null;
    sent?: boolean;
    voided?: number;
    warnings?: number;
    /** Deprecated: the v1.6 name of `taxMinor`, present while the amount is in IDR. */
    ppnIdr?: number;
    /** Deprecated: the v1.6 name of `roamingMinor`, present while the amount is in IDR. */
    roamingIdr?: number;
    /** Deprecated: the v1.6 name of `totalMinor`, present while the amount is in IDR. */
    totalIdr?: number;
  }[];
  unassigned: {
    sessions?: number;
    totalMinor?: number;
    /** Deprecated: the v1.6 name of `totalMinor`, present while the amount is in IDR. */
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

export type GroupConsolidationResponse = {
  grouped?: boolean;
  month?: string;
  entities?: Record<string, unknown>[];
  group?: Record<string, unknown>;
  eliminations?: Record<string, unknown>;
  net?: Record<string, unknown>;
  reporting?: Record<string, unknown> | null;
};

export type GroupTrendResponse = {
  grouped?: boolean;
  months?: string[];
  rows?: Record<string, unknown>[];
};

export type HandWhatsAppConversationOverBody = {
  /** Who answers: the AI assistant, staff, or nobody (closed; a new customer message reopens it with the assistant). */
  handler: "ai" | "human" | "closed";
};

export type HandWhatsAppConversationOverResponse = {
  conversation: WhatsAppConversation;
};

export type HoldOrReleaseAccountBody = {
  hold: boolean;
  reason?: string;
};

export type ImportPartnerNetworkResponse = {
  locations: number;
  tariffs: number;
};

export type ImportSiteInvestmentsResponse = {
  imported?: number;
  assetIds?: string[];
  skipped?: Record<string, unknown>[];
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
  paymentsByCountry?: {
    countryCode?: "MY" | "SG";
    own?: {
      id?: string;
      scope?: "org" | "platform";
      provider?: string;
      /** Payments: the country this acquirer account serves (ID for every v1.6 account). */
      countryCode?: "ID" | "MY" | "SG";
      /** Non-secret settings. */
      settings?: Record<string, unknown>;
      /** Secret fields that are set, as a hint (last characters). Secret values are never returned. */
      secretHints?: Record<string, unknown>;
      enabled?: boolean;
      webhookPath?: string | null;
      webhookUrl?: string | null;
      /** Sign-in codes on the WhatsApp Cloud API: the verify token for the Meta app's status webhook (webhookUrl, /hooks/whatsapp-cloud/<key>), made by the server on the first save. Platform administrators only. */
      webhookVerifyToken?: string;
      lastTest?: {
        at?: string;
        ok?: boolean | null;
        message?: string | null;
      } | null;
      updatedAt?: string;
    } | null;
    platform?: Record<string, unknown> | null;
    effective?: Record<string, unknown> | null;
  }[];
};

export type IntercompanyResponse = {
  group?: Record<string, unknown>[];
  grouped?: boolean;
  recharges?: {
    id?: string;
    number?: string;
    direction?: "out" | "in";
    from?: string;
    to?: string;
    month?: string;
    amount?: number;
    currency?: string;
    status?: "draft" | "issued" | "settled" | "void";
  }[];
  balances?: Record<string, unknown>[];
  settlements?: Record<string, unknown>[];
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
    amountMinor?: number;
    /** Default: whether the invoice carries PPN. */
    taxed?: boolean;
    /** Deprecated: the v1.6 name of `amountMinor`, present while the amount is in IDR. */
    amountIdr?: number;
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
  /** Default IDR: one invoice per account, month and currency. */
  currency?: "IDR" | "MYR" | "SGD";
};

export type IssueRechargeResponse = {
  id?: string;
  number?: string;
  direction?: "out" | "in";
  from?: string;
  to?: string;
  month?: string;
  amount?: number;
  currency?: string;
  status?: "draft" | "issued" | "settled" | "void";
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

export type IssueWithholdingSlipBody = {
  number?: string;
  issuedOn?: string;
};

export type JournalEntriesResponse = {
  month?: string;
  locked?: boolean;
  entries?: {
    id?: string;
    number?: string;
    date?: string;
    currency?: string;
    source?: string;
    status?: "draft" | "awaiting_approval" | "posted" | "rejected" | "superseded";
    total?: number;
    lines?: Record<string, unknown>[];
  }[];
  awaitingApproval?: number;
};

export type JournalEntryResponse = {
  id?: string;
  number?: string;
  date?: string;
  currency?: string;
  source?: string;
  status?: "draft" | "awaiting_approval" | "posted" | "rejected" | "superseded";
  total?: number;
  lines?: Record<string, unknown>[];
};

export type KpiBenchmarkingResponse = {
  by?: "site" | "owner" | "org";
  from?: string;
  to?: string;
  months?: number;
  hours?: number;
  metrics?: string[];
  lowerIsBetter?: string[];
  stats?: Record<string, unknown>;
  rows?: Record<string, unknown>[];
};

export type LeaseResponse = {
  id?: string;
  schedule?: Record<string, unknown>[];
};

export type LeasesResponse = {
  asOf?: string;
  leases?: {
    id?: string;
    description?: string;
    currency?: string;
    startMonth?: string;
    termMonths?: number;
    initialLiability?: number;
    position?: Record<string, unknown>;
    status?: string;
  }[];
  totals?: Record<string, unknown>;
  accounts?: Record<string, unknown>;
};

export type LedgerReportsResponse = {
  month?: string;
  currency?: string;
  currencies?: string[];
  locked?: boolean;
  trialBalance?: Record<string, unknown>;
  profitAndLoss?: Record<string, unknown>;
  balanceSheet?: Record<string, unknown>;
};

export type LedgerRowWholeTrailResponse = {
  transaction: GatewayTransaction;
  related: GatewayTransaction[];
  payment?: Record<string, unknown> | null;
  session?: Record<string, unknown> | null;
  transfers: Record<string, unknown>[];
  pass?: Record<string, unknown> | null;
  exceptions: Record<string, unknown>[];
};

export type LinkBankStatementToAccountBody = {
  statementId: string;
};

export type LinkBankStatementToAccountResponse = {
  accountId?: string;
  statementId?: string;
};

export type LinkToCapexProjectBody = {
  billId?: string;
  orderId?: string;
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

export type ListCountriesPlugSureOperatesInResponse = {
  countries: {
    /** ISO 3166-1 alpha-2: ID, MY or SG. */
    code: string;
    name: string;
    /** ISO 4217: IDR, MYR or SGD. */
    currency: string;
    timezones: string[];
    displayPricesInclTax: boolean;
    defaultLocale: "id" | "en";
  }[];
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

export type ListOcpiPartiesOnePerCountryResponse = {
  parties: RoamingPartyOfCountry[];
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

export type LockMonthBody = {
  note?: string;
};

export type LockMonthResponse = {
  id?: string;
  month?: string;
  locked?: boolean;
};

export type MakeExpenseClaimBody = {
  title: string;
  currency?: string;
  lines?: {
    spentOn: string;
    category: "fuel" | "travel" | "meals" | "parking" | "tools" | "supplies" | "phone" | "other";
    siteId?: string;
    description: string;
    amount: number;
    vat?: number;
  }[];
};

export type MakeExpenseClaimResponse = {
  id?: string;
  number?: string;
  claimant?: string;
  title?: string;
  currency?: string;
  status?: "draft" | "submitted" | "approved" | "rejected" | "reimbursed" | "void";
  total?: number;
  lines?: Record<string, unknown>[];
};

export type MakeManualJournalEntryBody = {
  date: string;
  currency: string;
  memo: string;
  draft?: boolean;
  lines: {
    account: string;
    debit?: number;
    credit?: number;
    description?: string;
  }[];
};

export type MakeManualJournalEntryResponse = {
  id?: string;
  number?: string;
  date?: string;
  currency?: string;
  source?: string;
  status?: "draft" | "awaiting_approval" | "posted" | "rejected" | "superseded";
  total?: number;
  lines?: Record<string, unknown>[];
};

export type MakePaymentLinkForFleetInvoiceResponse = {
  id?: string;
  url?: string;
  amount?: number;
  status?: string;
};

export type MarkTaxObligationFiledBody = {
  obligation: "pph23_pay" | "pph23_report" | "ppn_pay" | "ppn_report" | "efaktur";
  period: string;
  filedOn: string;
  reference: string;
  amount?: number;
  note?: string;
};

export type MatchIgnoreOrUnmatchBankLineBody = {
  kind: "gateway_withdrawal" | "statement_payment" | "refund" | "roaming_payment" | "supplier_payment" | "ignored" | "none";
  ref?: string;
  note?: string;
};

export type MatchIgnoreOrUnmatchBankLineResponse = {
  ok: boolean;
  amountDiffers?: boolean;
};

export type MonthCloseChecklistResponse = {
  month?: string;
  ready?: boolean;
  items?: {
    key?: "energy_bills" | "fx_rates" | "bank_lines";
    ok?: boolean;
    label?: string;
  }[];
};

export type MonthDepreciationJournalResponse = {
  month?: string;
  accounts?: Record<string, unknown>;
  currencies?: Record<string, unknown>[];
};

export type MonthLeaseJournalResponse = {
  month?: string;
  currencies?: Record<string, unknown>[];
};

export type MonthLocksResponse = {
  months?: {
    month?: string;
    locked?: boolean;
    lockable?: boolean;
    lockedBy?: string | null;
    lockedAt?: string | null;
    note?: string | null;
    history?: Record<string, unknown>[];
  }[];
};

export type MyCommissionTermsPerCurrencyResponse = {
  feePlans: Record<string, unknown>;
};

export type MyDisputesBothSidesResponse = {
  disputes: {
    id?: string;
    hub_cdr_id?: string;
    cdr_id?: string;
    raised_by?: "emsp" | "platform";
    reason?: "unknown_token" | "not_authorized" | "duplicate" | "amount" | "energy" | "tariff_mismatch" | "session_not_found" | "other";
    currency?: string;
    claimed_minor?: number | null;
    message?: string;
    status?: "open" | "accepted" | "rejected" | "escalated" | "credited" | "expired" | "resolved" | "withdrawn";
    resolution?: "credited" | "upheld" | "written_off" | null;
    respond_by?: string;
    credit_due_by?: string | null;
    escalate_by?: string | null;
    credit_cdr_id?: string | null;
    /** Deprecated: the v1.6 name of `claimed_minor`, present while the amount is in IDR. */
    claimed_idr?: number | null;
  }[];
};

export type MyFinanceDigestResponse = {
  subscription?: Record<string, unknown>;
  sends?: Record<string, unknown>[];
  organisation?: Record<string, unknown>;
  sections?: string[];
  consoleUsersOnly?: boolean;
};

export type MyHubCDRsBothSidesResponse = {
  cdrs: {
    id?: string;
    cdr_id?: string;
    session_id?: string | null;
    credit?: boolean;
    credit_reference_id?: string | null;
    credits_cdr_id?: string | null;
    credited_by_cdr_id?: string | null;
    currency?: string;
    total_excl_minor?: number;
    total_incl_minor?: number | null;
    energy_kwh?: number;
    start_at?: string;
    end_at?: string;
    cpo?: string;
    emsp?: string;
    status?: "held" | "pending" | "disputed" | "accepted" | "credited" | "written_off" | "void";
    flags?: string[];
    dispute_deadline?: string;
    accepted_at?: string | null;
    forward_state?: "pending" | "delivered" | "failed" | "not_needed";
    fee_cpo_minor?: number | null;
    fee_emsp_minor?: number | null;
    settlement_run_id?: string | null;
    hold_note?: string | null;
    source?: "push" | "pull";
    received_at?: string;
    agreement_id?: string | null;
    cpo_member_id?: string;
    emsp_member_id?: string;
    cpo_member_name?: string | null;
    emsp_member_name?: string | null;
    dispute_id?: string | null;
    /** Deprecated: the v1.6 name of `total_excl_minor`, present while the amount is in IDR. */
    total_excl_idr?: number;
    /** Deprecated: the v1.6 name of `total_incl_minor`, present while the amount is in IDR. */
    total_incl_idr?: number | null;
    /** Deprecated: the v1.6 name of `fee_cpo_minor`, present while the amount is in IDR. */
    fee_cpo_idr?: number | null;
    /** Deprecated: the v1.6 name of `fee_emsp_minor`, present while the amount is in IDR. */
    fee_emsp_idr?: number | null;
  }[];
  next_cursor?: string | null;
};

export type MyHubFeeInvoicesResponse = {
  feeInvoices: {
    id?: string;
    member_id?: string;
    entity_country?: string;
    run_id?: string | null;
    currency?: string;
    number?: string;
    net_minor?: number;
    tax_scheme?: "ID_PPN" | "SG_GST" | "MY_SST" | "NONE" | "REVERSE_CHARGE";
    tax_rate_bps?: number;
    tax_base_minor?: number;
    tax_minor?: number;
    total_minor?: number;
    wht_expected_minor?: number;
    status?: "issued" | "paid" | "void";
    due_date?: string;
    paid_at?: string | null;
    data?: Record<string, unknown>;
    /** Deprecated: the v1.6 name of `net_minor`, present while the amount is in IDR. */
    net_idr?: number;
    /** Deprecated: the v1.6 name of `tax_rate_bps`, present while the amount is in IDR. */
    ppn_rate_bps?: number;
    /** Deprecated: the v1.6 name of `tax_base_minor`, present while the amount is in IDR. */
    ppn_dpp_idr?: number;
    /** Deprecated: the v1.6 name of `tax_base_minor`, present while the amount is in IDR. */
    dpp_idr?: number;
    /** Deprecated: the v1.6 name of `tax_minor`, present while the amount is in IDR. */
    ppn_idr?: number;
    /** Deprecated: the v1.6 name of `total_minor`, present while the amount is in IDR. */
    total_idr?: number;
    /** Deprecated: the v1.6 name of `wht_expected_minor`, present while the amount is in IDR. */
    wht_expected_idr?: number;
  }[];
};

export type MyHubStatementsResponse = {
  statements: {
    id?: string;
    run_id?: string;
    member_id?: string;
    currency?: string;
    period?: string;
    number?: string;
    receivable_minor?: number;
    payable_minor?: number;
    net_minor?: number;
    fee_net_minor?: number;
    fee_invoice_id?: string | null;
    cdr_count?: number;
    issued_at?: string;
    data?: Record<string, unknown>;
    /** Deprecated: the v1.6 name of `receivable_minor`, present while the amount is in IDR. */
    receivable_idr?: number;
    /** Deprecated: the v1.6 name of `payable_minor`, present while the amount is in IDR. */
    payable_idr?: number;
    /** Deprecated: the v1.6 name of `net_minor`, present while the amount is in IDR. */
    net_idr?: number;
    /** Deprecated: the v1.6 name of `fee_net_minor`, present while the amount is in IDR. */
    fee_net_idr?: number;
  }[];
};

export type MySettlementPositionsResponse = {
  positions: {
    id?: string;
    run_id?: string;
    currency?: string;
    member_a_id?: string;
    member_b_id?: string;
    a_owes_b_minor?: number;
    b_owes_a_minor?: number;
    net_minor?: number;
    payer_member_id?: string | null;
    payee_member_id?: string | null;
    cdr_count?: number;
    paid_minor?: number;
    outstanding_minor?: number;
    status?: "open" | "partially_paid" | "paid" | "confirmed" | "overdue" | "written_off" | "nothing_due";
    due_date?: string;
    overdue_since?: string | null;
    period?: string | null;
    /** Deprecated: the v1.6 name of `a_owes_b_minor`, present while the amount is in IDR. */
    a_owes_b_idr?: number;
    /** Deprecated: the v1.6 name of `b_owes_a_minor`, present while the amount is in IDR. */
    b_owes_a_idr?: number;
    /** Deprecated: the v1.6 name of `net_minor`, present while the amount is in IDR. */
    net_idr?: number;
    /** Deprecated: the v1.6 name of `paid_minor`, present while the amount is in IDR. */
    paid_idr?: number;
    /** Deprecated: the v1.6 name of `outstanding_minor`, present while the amount is in IDR. */
    outstanding_idr?: number;
  }[];
};

export type NativeAppsVersionGateAndRemoteConfigurationResponse = {
  appConfig: DriverAppConfig;
};

export type OneOfMyHubCDRsResponse = {
  /** A ledger row: one per (CPO party, CDR id), pushed or pulled through the hub. */
  cdr: {
    id?: string;
    cdr_id?: string;
    session_id?: string | null;
    credit?: boolean;
    credit_reference_id?: string | null;
    credits_cdr_id?: string | null;
    credited_by_cdr_id?: string | null;
    currency?: string;
    total_excl_minor?: number;
    total_incl_minor?: number | null;
    energy_kwh?: number;
    start_at?: string;
    end_at?: string;
    cpo?: string;
    emsp?: string;
    status?: "held" | "pending" | "disputed" | "accepted" | "credited" | "written_off" | "void";
    flags?: string[];
    dispute_deadline?: string;
    accepted_at?: string | null;
    forward_state?: "pending" | "delivered" | "failed" | "not_needed";
    fee_cpo_minor?: number | null;
    fee_emsp_minor?: number | null;
    settlement_run_id?: string | null;
    hold_note?: string | null;
    source?: "push" | "pull";
    received_at?: string;
    agreement_id?: string | null;
    cpo_member_id?: string;
    emsp_member_id?: string;
    cpo_member_name?: string | null;
    emsp_member_name?: string | null;
    dispute_id?: string | null;
    /** Deprecated: the v1.6 name of `total_excl_minor`, present while the amount is in IDR. */
    total_excl_idr?: number;
    /** Deprecated: the v1.6 name of `total_incl_minor`, present while the amount is in IDR. */
    total_incl_idr?: number | null;
    /** Deprecated: the v1.6 name of `fee_cpo_minor`, present while the amount is in IDR. */
    fee_cpo_idr?: number | null;
    /** Deprecated: the v1.6 name of `fee_emsp_minor`, present while the amount is in IDR. */
    fee_emsp_idr?: number | null;
  };
  disputes?: {
    id?: string;
    hub_cdr_id?: string;
    cdr_id?: string;
    raised_by?: "emsp" | "platform";
    reason?: "unknown_token" | "not_authorized" | "duplicate" | "amount" | "energy" | "tariff_mismatch" | "session_not_found" | "other";
    currency?: string;
    claimed_minor?: number | null;
    message?: string;
    status?: "open" | "accepted" | "rejected" | "escalated" | "credited" | "expired" | "resolved" | "withdrawn";
    resolution?: "credited" | "upheld" | "written_off" | null;
    respond_by?: string;
    credit_due_by?: string | null;
    escalate_by?: string | null;
    credit_cdr_id?: string | null;
    /** Deprecated: the v1.6 name of `claimed_minor`, present while the amount is in IDR. */
    claimed_idr?: number | null;
  }[];
  related?: Record<string, unknown>[];
};

export type OneOfMyHubFeeInvoicesResponse = {
  feeInvoice: {
    id?: string;
    member_id?: string;
    entity_country?: string;
    run_id?: string | null;
    currency?: string;
    number?: string;
    net_minor?: number;
    tax_scheme?: "ID_PPN" | "SG_GST" | "MY_SST" | "NONE" | "REVERSE_CHARGE";
    tax_rate_bps?: number;
    tax_base_minor?: number;
    tax_minor?: number;
    total_minor?: number;
    wht_expected_minor?: number;
    status?: "issued" | "paid" | "void";
    due_date?: string;
    paid_at?: string | null;
    data?: Record<string, unknown>;
    /** Deprecated: the v1.6 name of `net_minor`, present while the amount is in IDR. */
    net_idr?: number;
    /** Deprecated: the v1.6 name of `tax_rate_bps`, present while the amount is in IDR. */
    ppn_rate_bps?: number;
    /** Deprecated: the v1.6 name of `tax_base_minor`, present while the amount is in IDR. */
    ppn_dpp_idr?: number;
    /** Deprecated: the v1.6 name of `tax_base_minor`, present while the amount is in IDR. */
    dpp_idr?: number;
    /** Deprecated: the v1.6 name of `tax_minor`, present while the amount is in IDR. */
    ppn_idr?: number;
    /** Deprecated: the v1.6 name of `total_minor`, present while the amount is in IDR. */
    total_idr?: number;
    /** Deprecated: the v1.6 name of `wht_expected_minor`, present while the amount is in IDR. */
    wht_expected_idr?: number;
  };
};

export type OneOfMyHubStatementsResponse = {
  statement: {
    id?: string;
    run_id?: string;
    member_id?: string;
    currency?: string;
    period?: string;
    number?: string;
    receivable_minor?: number;
    payable_minor?: number;
    net_minor?: number;
    fee_net_minor?: number;
    fee_invoice_id?: string | null;
    cdr_count?: number;
    issued_at?: string;
    data?: Record<string, unknown>;
    /** Deprecated: the v1.6 name of `receivable_minor`, present while the amount is in IDR. */
    receivable_idr?: number;
    /** Deprecated: the v1.6 name of `payable_minor`, present while the amount is in IDR. */
    payable_idr?: number;
    /** Deprecated: the v1.6 name of `net_minor`, present while the amount is in IDR. */
    net_idr?: number;
    /** Deprecated: the v1.6 name of `fee_net_minor`, present while the amount is in IDR. */
    fee_net_idr?: number;
  };
};

export type OneReceivableHistoryResponse = {
  receivable?: Record<string, unknown>;
  notes?: Record<string, unknown>[];
  reminders?: Record<string, unknown>[];
  writeOffs?: Record<string, unknown>[];
};

export type OneWhatsAppSupportConversationResponse = {
  conversation: WhatsAppConversation;
  messages: WhatsAppChatMessage[];
};

export type OpenWorkOrderBody = {
  title?: string;
  kind?: "corrective" | "preventive" | "warranty";
  status?: "open" | "in_progress" | "done" | "cancelled";
  chargePointId?: string;
  siteId?: string;
  currency?: string;
  description?: string;
  openedOn?: string;
  doneOn?: string;
  labourHours?: number;
  labourRate?: number;
  contractorEstimate?: number;
};

export type OperatorsStatementsToPlugSureResponse = {
  statements: OperatorStatementDue[];
};

export type OwnerPayoutsThroughDuitkuDisbursementResponse = {
  transfers: PayoutTransfer[];
};

export type PayablesResponse = {
  refunds: {
    paymentId?: string;
    state?: string;
    amount?: number;
    currency?: string;
    reason?: string | null;
    requestedAt?: string | null;
    channel?: string | null;
    paidAt?: string | null;
    reference?: string | null;
    operator?: string | null;
    refundWindowDays?: number | null;
    daysLeft?: number | null;
  }[];
  ownerShares: {
    statementId?: string;
    period?: string;
    owner?: string;
    operator?: string;
    amount?: number;
    paid?: number;
    currency?: string;
    finalisedAt?: string;
    status?: "due" | "partial" | "paid";
  }[];
  hubPositions?: {
    id?: string;
    counterparty?: string | null;
    outstanding?: number;
    currency?: string;
    dueDate?: string;
    status?: string;
  }[];
};

export type PayablesApAgeingResponse = {
  asOf?: string;
  buckets?: string[];
  currencies?: Record<string, unknown>[];
  dueSoon?: Record<string, unknown>[];
  overdue?: Record<string, unknown>[];
  awaitingApproval?: Record<string, unknown>;
};

export type PayInvoiceFromDepositResponse = {
  invoiceId?: string;
  number?: string;
  paid?: number;
  depositLeft?: number;
};

export type PaymentPlansResponse = {
  plans?: Record<string, unknown>[];
};

export type PaymentsAccountsWithFinanceDataResponse = {
  accounts: FinanceAccount[];
};

export type PaymentsOnMyPositionsResponse = {
  payments: {
    id?: string;
    position_id?: string;
    payer_member_id?: string;
    payee_member_id?: string;
    currency?: string;
    amount_minor?: number;
    method?: string;
    reference?: string | null;
    paid_at?: string;
    recorded_side?: string;
    confirmed_by_payee_at?: string | null;
    /** Deprecated: the v1.6 name of `amount_minor`, present while the amount is in IDR. */
    amount_idr?: number;
  }[];
};

export type PaymentsRecordedAgainstStatementResponse = {
  statement: StatementDue;
  payments: StatementPayment[];
};

export type PeriodByOperatorAndSiteResponse = {
  bySite: {
    operator?: string | null;
    site?: string | null;
    payments?: number;
    collected?: number;
    fees?: number;
    vat?: number;
    refunds?: number;
    net?: number;
  }[];
  byOperator: {
    orgId?: string | null;
    operator?: string | null;
    payments?: number;
    collected?: number;
    fees?: number;
    vat?: number;
    refunds?: number;
    net?: number;
    ownerShares?: number;
    ownerSharesPaid?: number;
  }[];
};

export type PettyCashResponse = {
  accounts?: {
    id?: string;
    name?: string;
    currency?: string;
    balance?: number | null;
    float?: number | null;
    topUp?: number;
    lastCount?: Record<string, unknown> | null;
  }[];
};

export type PlaceTimeDepositBody = {
  cashAccountId: string;
  bankName?: string;
  reference?: string;
  principal: number;
  ratePct: number;
  taxPct?: number;
  placedOn?: string;
  maturityOn?: string;
  termMonths?: number;
  termDays?: number;
  note?: string;
};

export type PlaceTimeDepositResponse = {
  id?: string;
  bankName?: string;
  currency?: string;
  principal?: number;
  ratePct?: number;
  placedOn?: string;
  maturityOn?: string;
  status?: "active" | "matured" | "broken";
  accrued?: Record<string, unknown>;
  atMaturity?: Record<string, unknown>;
};

export type PlugChargeExchangeLogResponse = {
  events: PncEvent[];
};

export type Pph23WithholdingForYearResponse = {
  year?: number;
  suggestions?: {
    kind?: "gateway_fee" | "platform_fee";
    period?: string;
    counterparty?: string;
    integrationId?: string | null;
    statementId?: string | null;
    number?: string | null;
    base?: number;
    rateBps?: number;
    suggested?: number;
    withheld?: number;
    recorded?: number;
    buktiMissing?: boolean;
  }[];
  recorded?: TaxWithholding[];
  received?: TaxWithholding[];
};

export type PpnReturnSptMasaPpnResponse = {
  month?: string;
  pkp?: boolean;
  output?: Record<string, unknown>;
  input?: Record<string, unknown>;
  broughtForward?: number;
  payable?: number;
  carriedForward?: number;
  filed?: Record<string, unknown> | null;
  periods?: Record<string, unknown>[];
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
  localTaxRateBps?: number;
  idleMinutes?: number;
  /** Deprecated: the v1.6 name of `localTaxRateBps`, present while the amount is in IDR. */
  pbjtRateBps?: number;
};

export type PriceWhatIfBody = {
  dimension?: "totals" | "tariff" | "connector" | "band" | "site";
  key?: string;
  currency?: string;
  changePct: number;
  elasticity?: number;
  months?: number;
  siteId?: string;
};

export type ProvisionDefaultChargingProfilesResponse = {
  applied: number;
};

export type PullHubClientListResponse = {
  clients: number;
};

export type PurchaseOrderResponse = {
  id?: string;
  lines?: Record<string, unknown>[];
  receipts?: Record<string, unknown>[];
  billsOnOrder?: Record<string, unknown>[];
  match?: Record<string, unknown>;
};

export type PurchaseOrdersResponse = {
  orders?: {
    id?: string;
    number?: string;
    supplier?: string;
    currency?: string;
    status?: "draft" | "awaiting_approval" | "approved" | "closed" | "cancelled" | "rejected";
    ordered?: number;
    received?: number;
    billed?: number;
    toBill?: number;
  }[];
  commitments?: Record<string, unknown>[];
  settings?: Record<string, unknown>;
};

export type RaisePurchaseOrderBody = {
  supplierId: string;
  description: string;
  siteId?: string;
  currency?: string;
  expectedOn?: string;
  draft?: boolean;
  lines: {
    description: string;
    quantity: number;
    unitPrice: number;
  }[];
};

export type RaisePurchaseOrderResponse = {
  id?: string;
  number?: string;
  supplier?: string;
  currency?: string;
  status?: "draft" | "awaiting_approval" | "approved" | "closed" | "cancelled" | "rejected";
  ordered?: number;
  received?: number;
  billed?: number;
  toBill?: number;
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

export type ReceivablesResponse = {
  byDay: {
    day?: string | null;
    net?: number;
    gross?: number;
    count?: number;
    overdue?: boolean;
  }[];
  total: number;
  rows: GatewayTransaction[];
  fleetInvoices: {
    id?: string;
    number?: string;
    period?: string;
    total?: number;
    currency?: string;
    dueDate?: string;
    account?: string | null;
    overdue?: boolean;
  }[];
  /** (v1.15.0) Post-pay sessions on this account not charged yet (and how many failed). */
  postpay?: {
    count?: number;
    amount?: number;
    failed?: number;
  };
  hubFeeInvoices?: {
    number?: string;
    member?: string | null;
    total?: number;
    currency?: string;
    dueDate?: string;
    overdue?: boolean;
  }[];
  hubPositions?: {
    id?: string;
    counterparty?: string | null;
    outstanding?: number;
    currency?: string;
    dueDate?: string;
    status?: string;
  }[];
};

export type RechargeGroupEntityBody = {
  toOrgId: string;
  month: string;
  description: string;
  amount: number;
  currency: string;
  draft?: boolean;
};

export type RechargeGroupEntityResponse = {
  id?: string;
  number?: string;
  direction?: "out" | "in";
  from?: string;
  to?: string;
  month?: string;
  amount?: number;
  currency?: string;
  status?: "draft" | "issued" | "settled" | "void";
};

export type RecogniseMonthBreakageBody = {
  month: string;
  currency: string;
};

export type RecogniseMonthBreakageResponse = {
  month?: string;
  currency?: string;
  amount?: number;
  payments?: number;
};

export type ReconcileStuckSessionsResponse = {
  /** Sessions closed for review. */
  stuck: number;
  /** Unrated sessions retried. */
  rerated: number;
};

export type ReconciliationExceptionsResponse = {
  exceptions: ReconciliationException[];
};

export type RecordAssetBody = {
  category: string;
  description: string;
  siteId?: string;
  chargePointId?: string;
  currency?: string;
  cost: number;
  residual?: number;
  acquiredOn: string;
  inService?: string;
  lifeMonths?: number;
  method?: "straight_line" | "declining_balance";
  ratePct?: number;
  tag?: string;
};

export type RecordAssetResponse = {
  id?: string;
  tag?: string;
  category?: string;
  currency?: string;
  cost?: number;
  accumulated?: number;
  netBookValue?: number;
  status?: string;
};

export type RecordBalanceBody = {
  balance: number;
  onDate?: string;
  note?: string;
};

export type RecordBalanceResponse = {
  accountId?: string;
  onDate?: string;
  balance?: number;
};

export type RecordChargebackBody = {
  paymentId?: string;
  paymentRef?: string;
  provider: string;
  caseRef: string;
  reason: "fraud" | "not_received" | "not_as_described" | "duplicate" | "amount" | "cancelled" | "other";
  reasonCode?: string;
  currency?: string;
  amount?: number;
  fee?: number;
  receivedOn?: string;
  respondBy?: string;
  note?: string;
};

export type RecordClawbackBody = {
  amount: number;
  onDate?: string;
  note: string;
  conditionId?: string;
};

export type RecordCreditNoteAsRefundedBody = {
  refundedAt?: string;
  reference?: string;
};

export type RecordCustomerDepositBody = {
  kind: "received" | "returned" | "applied";
  amount: number;
  currency?: string;
  onDate?: string;
  invoiceId?: string;
  cashAccountId?: string;
  reference?: string;
  note?: string;
};

export type RecordDepositTopUpOrAdjustmentBody = {
  kind?: "topup" | "adjustment";
  amount: number;
  reference?: string;
  note?: string;
};

export type RecordDrawdownBody = {
  amount: number;
  onDate?: string;
  reference?: string;
};

export type RecordFakturMasukanBody = {
  month: string;
  supplier: string;
  supplierNpwp?: string;
  faktur: string;
  date: string;
  dpp: number;
  ppn: number;
  description?: string;
  creditable?: boolean;
  amend?: boolean;
};

export type RecordFakturMasukanResponse = {
  id?: string;
};

export type RecordFakturPajakNumberBody = {
  number?: string | null;
};

export type RecordGoodsReceivedBody = {
  receivedOn?: string;
  note?: string;
  lines: {
    lineId: string;
    quantity: number;
  }[];
};

export type RecordGoodsReceivedResponse = {
  id?: string;
  number?: string;
  supplier?: string;
  currency?: string;
  status?: "draft" | "awaiting_approval" | "approved" | "closed" | "cancelled" | "rejected";
  ordered?: number;
  received?: number;
  billed?: number;
  toBill?: number;
};

export type RecordIntercompanyEliminationBody = {
  month: string;
  kind: "revenue" | "cost";
  description: string;
  amount: number;
  currency: string;
};

export type RecordLeaseBody = {
  description: string;
  siteId?: string;
  supplierId?: string;
  currency?: string;
  startMonth: string;
  termMonths: number;
  payment: number;
  frequency?: "monthly" | "quarterly" | "yearly";
  timing?: "advance" | "arrears";
  ratePct: number;
  directCosts?: number;
  exempt?: string | boolean;
};

export type RecordLeaseResponse = {
  id?: string;
  description?: string;
  currency?: string;
  startMonth?: string;
  termMonths?: number;
  initialLiability?: number;
  position?: Record<string, unknown>;
  status?: string;
};

export type RecordLoanPaymentBody = {
  principal?: number;
  interest?: number;
  fees?: number;
  onDate?: string;
  reference?: string;
};

export type RecordMonthDepreciationResponse = {
  month?: string;
  recorded?: Record<string, unknown>[];
};

export type RecordMonthLeaseJournalResponse = {
  month?: string;
  recorded?: Record<string, unknown>[];
};

export type RecordMonthProvisionResponse = {
  month?: string;
  currencies?: Record<string, unknown>[];
};

export type RecordPaymentAsPayerOrAsPayeeCountsAsConfirmedBody = {
  position_id: string;
  amount_minor?: number;
  paid_at: string;
  reference: string;
  method?: "bank_transfer" | "stripe_connect" | "xendit" | "other";
  note?: string;
  /** Deprecated: the v1.6 name of `amount_minor`, present while the amount is in IDR. */
  amount_idr?: number;
};

export type RecordPaymentAsPayerOrAsPayeeCountsAsConfirmedResponse = {
  payment: {
    id?: string;
    position_id?: string;
    payer_member_id?: string;
    payee_member_id?: string;
    currency?: string;
    amount_minor?: number;
    method?: string;
    reference?: string | null;
    paid_at?: string;
    recorded_side?: string;
    confirmed_by_payee_at?: string | null;
    /** Deprecated: the v1.6 name of `amount_minor`, present while the amount is in IDR. */
    amount_idr?: number;
  };
  position: {
    id?: string;
    run_id?: string;
    currency?: string;
    member_a_id?: string;
    member_b_id?: string;
    a_owes_b_minor?: number;
    b_owes_a_minor?: number;
    net_minor?: number;
    payer_member_id?: string | null;
    payee_member_id?: string | null;
    cdr_count?: number;
    paid_minor?: number;
    outstanding_minor?: number;
    status?: "open" | "partially_paid" | "paid" | "confirmed" | "overdue" | "written_off" | "nothing_due";
    due_date?: string;
    overdue_since?: string | null;
    period?: string | null;
    /** Deprecated: the v1.6 name of `a_owes_b_minor`, present while the amount is in IDR. */
    a_owes_b_idr?: number;
    /** Deprecated: the v1.6 name of `b_owes_a_minor`, present while the amount is in IDR. */
    b_owes_a_idr?: number;
    /** Deprecated: the v1.6 name of `net_minor`, present while the amount is in IDR. */
    net_idr?: number;
    /** Deprecated: the v1.6 name of `paid_minor`, present while the amount is in IDR. */
    paid_idr?: number;
    /** Deprecated: the v1.6 name of `outstanding_minor`, present while the amount is in IDR. */
    outstanding_idr?: number;
  };
};

export type RecordPaymentOfFleetInvoiceBody = {
  paidAt?: string;
  reference?: string;
};

export type RecordPaymentOnPlanBody = {
  amount: number;
  paidOn?: string;
  reference: string;
};

export type RecordPaymentToSupplierBody = {
  amount?: number;
  paidOn?: string;
  method?: "bank_transfer" | "cash" | "card" | "other";
  reference?: string;
  cashAccountId?: string;
};

export type RecordPaymentToSupplierResponse = {
  id?: string;
  supplier?: string;
  number?: string;
  currency?: string;
  payable?: number;
  paid?: number;
  balance?: number;
  status?: "draft" | "awaiting_approval" | "approved" | "paid" | "rejected" | "void";
  dueDate?: string;
};

export type RecordPayoutOrStatementPaymentBody = {
  amount: number;
  paidOn: string;
  reference: string;
  note?: string;
};

export type RecordPayoutOrStatementPaymentResponse = {
  paymentId: string;
  statement: StatementDue;
};

export type RecordPayrollPaidBody = {
  paidOn: string;
  cashAccountId: string;
};

export type RecordPPh23WithholdingBody = {
  kind: "gateway_fee" | "platform_fee";
  period: string;
  counterparty: string;
  counterpartyNpwp?: string;
  integrationId?: string;
  statementId?: string;
  base: number;
  rateBps?: number;
  amount?: number;
  buktiNumber?: string;
  buktiDate?: string;
  note?: string;
};

export type RecordPPh23WithholdingResponse = {
  id: string;
  amount: number;
};

export type RecordPpnReturnAsFiledBody = {
  ntpn?: string;
  reference?: string;
  unpaid?: boolean;
  amend?: boolean;
};

export type RecordPpnReturnAsFiledResponse = {
  month?: string;
  output?: number;
  input?: number;
  payable?: number;
  carriedForward?: number;
};

export type RecordRECsBoughtBody = {
  registry: string;
  reference?: string;
  vintage: number;
  mwh: number;
  price?: number;
  currency: string;
  boughtOn?: string;
  siteId?: string;
  cashAccountId?: string;
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

export type RecordRoamingSettlementPaymentBody = {
  amount: number;
  paidOn: string;
  reference: string;
  note?: string;
};

export type RecordRoamingSettlementPaymentResponse = {
  paymentId?: string;
  recorded?: string;
  status?: string;
  outstanding?: number;
};

export type RecordSharedCostBody = {
  category: "rent" | "maintenance" | "connectivity" | "insurance" | "staff" | "other";
  description: string;
  amount: number;
  currency?: string;
  basis?: "kwh" | "sessions" | "revenue" | "equal";
  siteIds?: string[];
  monthFrom: string;
  monthTo?: string;
};

export type RecordSiteElectricityBillBody = {
  month: string;
  amount: number;
  kwhBilled?: number;
  reference?: string;
  note?: string;
};

export type RecordSiteElectricityBillResponse = {
  id?: string;
};

export type RecordSiteInvestmentBody = {
  siteId: string;
  category: "chargers" | "installation" | "grid" | "other";
  description: string;
  amount: number;
  investedOn: string;
  lifeMonths?: number;
  reference?: string;
};

export type RecordStockMoveBody = {
  kind: "receipt" | "issue" | "transfer" | "adjust";
  itemId: string;
  locationId: string;
  toLocationId?: string;
  qty?: number;
  unitCost?: number;
  countedQty?: number;
  purchaseOrderId?: string;
  workOrderId?: string;
  onDate?: string;
  note?: string;
};

export type RecordSupplierBillBody = {
  supplierId: string;
  number: string;
  category: string;
  siteId?: string;
  description: string;
  currency?: string;
  subtotal: number;
  vat?: number;
  wht?: number;
  billDate: string;
  dueDate?: string;
  capitalise?: boolean;
  lifeMonths?: number;
  draft?: boolean;
  purchaseOrderId?: string;
};

export type RecordSupplierBillResponse = {
  id?: string;
  supplier?: string;
  number?: string;
  currency?: string;
  payable?: number;
  paid?: number;
  balance?: number;
  status?: "draft" | "awaiting_approval" | "approved" | "paid" | "rejected" | "void";
  dueDate?: string;
};

export type RecordTaxRegistrationInCountryBody = {
  countryCode: "ID" | "MY" | "SG";
  /** Default true. */
  registered?: boolean;
  /** NPWP (15–16 digits), SST or GST registration number. Required when registered. */
  registrationNo?: string | null;
  effectiveFrom: string;
  /** Malaysia only. */
  evChargingTaxable?: boolean;
  /** Basis points; empty for the statutory rate (SST 8 %, GST 9 %). */
  rateBps?: number | null;
};

export type RecordTaxWithheldFromOwnerShareBody = {
  statementId: string;
  ratePct: number;
  base?: number;
  amount?: number;
  bukti?: string;
  buktiDate?: string;
  note?: string;
};

export type RecordTransferBetweenAccountsBody = {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  onDate?: string;
  reference?: string;
  note?: string;
};

export type RecordTransferBetweenAccountsResponse = {
  id?: string;
  amount?: number;
  currency?: string;
};

export type RefundTransfersThroughDuitkuDisbursementResponse = {
  transfers: RefundTransfer[];
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

export type ReimburseExpenseClaimBody = {
  cashAccountId: string;
  reimbursedOn?: string;
  reference?: string;
};

export type ReimburseExpenseClaimResponse = {
  id?: string;
  number?: string;
  claimant?: string;
  title?: string;
  currency?: string;
  status?: "draft" | "submitted" | "approved" | "rejected" | "reimbursed" | "void";
  total?: number;
  lines?: Record<string, unknown>[];
};

export type ReinstateDecommissionedChargePointResponse = {
  ok: true;
};

export type RejectExpenseClaimBody = {
  reason: string;
};

export type RejectExpenseClaimResponse = {
  id?: string;
  number?: string;
  claimant?: string;
  title?: string;
  currency?: string;
  status?: "draft" | "submitted" | "approved" | "rejected" | "reimbursed" | "void";
  total?: number;
  lines?: Record<string, unknown>[];
};

export type RejectHeldPartnerChargeRecordBody = {
  /** Why, for the audit log. */
  note?: string;
};

export type RejectHeldPartnerChargeRecordResponse = {
  id: string;
  status: "rejected";
};

export type RejectJournalEntryBody = {
  reason: string;
};

export type RejectJournalEntryResponse = {
  id?: string;
  number?: string;
  date?: string;
  currency?: string;
  source?: string;
  status?: "draft" | "awaiting_approval" | "posted" | "rejected" | "superseded";
  total?: number;
  lines?: Record<string, unknown>[];
};

export type RejectOwnerPayoutBeforeItIsSentBody = {
  reason: string;
};

export type RejectOwnerPayoutBeforeItIsSentResponse = {
  transfer: PayoutTransfer;
};

export type RejectPurchaseOrderBody = {
  reason: string;
};

export type RejectPurchaseOrderResponse = {
  id?: string;
  number?: string;
  supplier?: string;
  currency?: string;
  status?: "draft" | "awaiting_approval" | "approved" | "closed" | "cancelled" | "rejected";
  ordered?: number;
  received?: number;
  billed?: number;
  toBill?: number;
};

export type RejectRefundTransferBeforeItIsSentBody = {
  reason: string;
};

export type RejectRefundTransferBeforeItIsSentResponse = {
  transfer: RefundTransfer;
};

export type RejectSupplierBillBody = {
  reason: string;
};

export type RejectSupplierBillResponse = {
  id?: string;
  supplier?: string;
  number?: string;
  currency?: string;
  payable?: number;
  paid?: number;
  balance?: number;
  status?: "draft" | "awaiting_approval" | "approved" | "paid" | "rejected" | "void";
  dueDate?: string;
};

export type RemoveAndroidNotificationsServiceAccountResponse = {
  ok: true;
};

export type RemoveConsoleBrandResponse = {
  ok: true;
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

export type RemoveLineFromClaimResponse = {
  id?: string;
  number?: string;
  claimant?: string;
  title?: string;
  currency?: string;
  status?: "draft" | "submitted" | "approved" | "rejected" | "reimbursed" | "void";
  total?: number;
  lines?: Record<string, unknown>[];
};

export type RemoveOcpiPartyOfCountryResponse = {
  ok: boolean;
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

export type RenewPolicyBody = {
  policyNo?: string;
  endOn?: string;
  premium?: number;
  cover?: number;
  excess?: number;
  paidOn?: string;
  cashAccountId?: string;
};

export type ReopenLockedMonthBody = {
  reason: string;
};

export type ReopenLockedMonthResponse = {
  id?: string;
  month?: string;
  locked?: boolean;
};

export type RepayClawbackBody = {
  repaidOn?: string;
  cashAccountId?: string;
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

export type ReplyToWhatsAppCustomerBody = {
  text: string;
};

export type ReplyToWhatsAppCustomerResponse = {
  ok: boolean;
};

export type ReportClaimBody = {
  kind: "damage" | "theft" | "liability" | "interruption" | "other";
  incidentOn: string;
  description: string;
  loss: number;
  workOrderId?: string;
};

export type ReportEMailSchedulesResponse = {
  schedules?: Record<string, unknown>[];
  reports?: string[];
};

export type ReportingCurrencyAndExchangeRatesResponse = {
  reportingCurrency?: string | null;
  currencies?: string[];
  rates?: {
    month?: string;
    currency?: string;
    rate?: number;
    source?: "manual" | "ecb";
    by?: string | null;
    at?: string;
  }[];
};

export type RequestOwnerPayoutThroughDuitkuDisbursementBody = {
  amount?: number;
  note?: string;
  /** (v1.17.0) Default: the first available (Xendit first). */
  rail?: "duitku" | "xendit";
};

export type RequestOwnerPayoutThroughDuitkuDisbursementResponse = {
  transfer: PayoutTransfer;
};

export type RequestReadyPayoutsNowResponse = {
  requested?: Record<string, unknown>[];
  failed?: Record<string, unknown>[];
};

export type RequestRefundTransferThroughDuitkuDisbursementBody = {
  /** Duitku's bank code (e.g. 014 BCA). */
  bankCode: string;
  accountNumber: string;
  holderName: string;
};

export type RequestRefundTransferThroughDuitkuDisbursementResponse = {
  transfer: RefundTransfer;
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

export type ResetUserTwoStepVerificationResponse = {
  ok: true;
};

export type ResolveAlertResponse = {
  ok: true;
};

export type ResolveReconciliationExceptionBody = {
  note: string;
};

export type ResolveReconciliationExceptionResponse = {
  ok: boolean;
};

export type ResumeSuspendedChargePointResponse = {
  ok: true;
};

export type RetireRECsBody = {
  month: string;
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

export type RevenueDropAlertsResponse = {
  settings?: {
    enabled?: boolean;
    dropPct?: number;
    minBaseline?: number;
  };
  anomalies?: Record<string, unknown>[];
};

export type ReverseJournalEntryBody = {
  date?: string;
};

export type ReverseJournalEntryResponse = {
  id?: string;
  number?: string;
  date?: string;
  currency?: string;
  source?: string;
  status?: "draft" | "awaiting_approval" | "posted" | "rejected" | "superseded";
  total?: number;
  lines?: Record<string, unknown>[];
};

export type ReviewFindingBody = {
  decision: "dismiss" | "confirm";
  note: string;
};

export type ReviewFindingResponse = {
  id?: string;
  kind?: string;
  severity?: string;
  message?: string;
  status?: "open" | "dismissed" | "confirmed" | "cleared";
};

export type ReviewRevenueFindingBody = {
  status: "recovered" | "written_off" | "dismissed" | "open";
  recovered?: number;
  note?: string;
};

export type RevokeApiKeyResponse = {
  ok: true;
};

export type RevokeTestContractCertificateResponse = {
  revoked: boolean;
};

export type RoamingSettlementResponse = {
  month?: string;
  ended?: boolean;
  rows?: Record<string, unknown>[];
  totals?: Record<string, unknown>;
};

export type RollingTwelveMonthForecastResponse = {
  scenario?: Record<string, unknown>;
  months?: string[];
  sites?: Record<string, unknown>[];
  totals?: Record<string, unknown>;
};

export type RotateSandboxApiKeyResponse = {
  apiKey: string;
};

export type RotateWebhookSigningSecretResponse = {
  /** Signing secret, shown only once. */
  secret: string;
};

export type RunAnomalyChecksResponse = {
  found?: number;
  added?: number;
  cleared?: number;
};

export type RunBankFeedNowResponse = {
  fetched?: number;
  added?: number;
  duplicates?: number;
  matched?: number;
  ignored?: number;
  suggested?: number;
};

export type RunFleetInvoicingAutomationNowResponse = {
  issued?: string[];
  sent?: string[];
  held?: Record<string, unknown>[];
  failed?: Record<string, unknown>[];
};

export type RunRevenueAssuranceBody = {
  month?: string;
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

export type SaveFinanceSettingsBody = {
  journalAccounts?: Record<string, {
    code?: string;
    name?: string;
  }>;
  closeEmail?: {
    enabled?: boolean;
    recipients?: string[];
  };
};

export type SaveFinanceSettingsResponse = {
  settings: Record<string, unknown>;
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

export type SaveForecastScenarioBody = {
  growthPct?: number;
  pricePct?: number;
  energyPct?: number;
  alertPct?: number;
};

export type SaveLoyaltyProgramBody = {
  enabled: boolean;
  /** Points earned per Rp 1,000 of a session's receipt total (rounded down). */
  earnPer1000Minor?: number;
  /** What one point takes off a session, in rupiah. */
  pointValueMinor?: number;
  /** The most of a session's energy and fees points may pay, in basis points (5000 = half). */
  maxRedeemBps: number;
  /** Each earning expires this many months after it was earned; points are spent oldest first. */
  expiryMonths: number;
  /** Deprecated: the v1.6 name of `earnPer1000Minor`, present while the amount is in IDR. */
  earnPer1000Idr?: number;
  /** Deprecated: the v1.6 name of `pointValueMinor`, present while the amount is in IDR. */
  pointValueIdr?: number;
};

export type SellCarbonCreditsBody = {
  buyer: string;
  tonnes: number;
  amount: number;
  currency: string;
  soldOn?: string;
  cashAccountId?: string;
  reference?: string;
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

export type SendMonthCloseEMailNowBody = {
  month?: string;
};

export type SendMonthCloseEMailNowResponse = {
  ok: boolean;
  month: string;
  to: string[];
  reference?: string | null;
};

export type SendMyDigestNowResponse = {
  results?: Record<string, unknown>[];
  text?: string;
};

export type SendPaymentReminderNowBody = {
  channel?: "email" | "whatsapp";
  to?: string;
};

export type SendPaymentReminderNowResponse = {
  ok?: boolean;
  destination?: string | null;
};

export type SendReportEMailNowResponse = {
  ok?: boolean;
  to?: string[];
  reference?: string | null;
};

export type SendReportPackBackBody = {
  reason: string;
};

export type SendScorecardNowBody = {
  month?: string;
};

export type SendScorecardNowResponse = {
  month?: string;
  sent?: number;
  error?: string | null;
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

export type SendWhatsAppTestMessageBody = {
  /** A mobile number in Indonesia, Malaysia or Singapore. */
  phone: string;
  template: string;
  language: string;
  params?: string[];
  copyCodeButton?: boolean;
};

export type SendWhatsAppTestMessageResponse = {
  ok: boolean;
  messageId?: string;
  error?: string;
  to: string;
};

export type SetAccountCounterpartiesPayIntoBody = {
  bank_details: string;
};

export type SetAccountCounterpartiesPayIntoResponse = {
  ok?: boolean;
};

export type SetAllowedEMailDomainsBody = {
  allowedDomains: string[];
};

export type SetAllowedEMailDomainsResponse = {
  tenant: MicrosoftTenant;
};

export type SetAnomalyChecksBody = {
  roundAmount?: number;
  newSupplierAmount?: number;
  newSupplierDays?: number;
  disabled?: string[];
};

export type SetApprovalsMatrixBody = {
  rules: Record<string, unknown>;
};

export type SetApprovalsMatrixResponse = {
  rules?: Record<string, unknown>;
  canApprove?: boolean;
};

export type SetAssetJournalAccountsBody = {
  accounts: Record<string, unknown>;
};

export type SetAutomaticOwnerPayoutsBody = {
  enabled?: boolean;
  delayDays?: number;
  minAmount?: number;
};

export type SetAutomaticStatementsOfAccountBody = {
  enabled?: boolean;
  day?: number;
};

export type SetBillStockAndWorkOrderBody = {
  stock?: boolean;
  workOrderId?: string;
};

export type SetBreakageDaysBody = {
  breakageDays: number;
};

export type SetBudgetAlertThresholdBody = {
  budgetAlertPct: number;
};

export type SetBudgetAlertThresholdResponse = {
  budgetAlertPct?: number;
};

export type SetCashForecastBody = {
  horizonDays?: number;
  collectionsPct?: number;
  alert?: boolean;
};

export type SetClosePolicyBody = {
  enforce?: boolean;
};

export type SetConnectorLoadManagementPrioritiesResponse = {
  ok: true;
};

export type SetControlsThresholdsBody = {
  minApprovers?: number;
  workingHours?: {
    from?: number;
    to?: number;
  } | null;
};

export type SetDigestWhatsAppTemplateBody = {
  whatsappTemplate?: {
    name?: string;
    lang?: string;
  } | null;
};

export type SetDriverRefundPolicyBody = {
  enabled?: boolean;
  autoApproveUpTo?: number;
  windowDays?: number;
};

export type SetEmissionFactorsBody = {
  gridKgPerKwh?: number;
  iceKgPerKwh?: number;
};

export type SetEvseAndConnectorTopologyResponse = {
  ok: true;
};

export type SetExpensePolicyBody = {
  receiptAbove?: number;
  limits?: Record<string, unknown>;
};

export type SetFinanceDataExportBody = {
  enabled?: boolean;
  target?: "local" | "s3";
  format?: "csv" | "ndjson";
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
};

export type SetFleetAccountCreditLimitOrPrepayBody = {
  mode?: "none" | "credit" | "prepaid";
  limit?: number;
  currency?: string;
  block?: boolean;
  autoApply?: boolean;
};

export type SetFleetInvoicingAutomationBody = {
  autoIssue?: boolean;
  issueDay?: number;
  autoSend?: boolean;
  requireEfaktur?: boolean;
  paymentLinks?: boolean;
  linkDays?: number;
};

export type SetGrantConditionBody = {
  status: "pending" | "met" | "breached" | "waived";
  metOn?: string;
  note?: string;
};

export type SetKpiTargetsBody = {
  targets?: Record<string, unknown>;
  copyFrom?: string;
};

export type SetKpiTargetsResponse = {
  month?: string;
  targets?: Record<string, unknown>;
};

export type SetMatchToleranceBody = {
  tolerancePct: number;
};

export type SetMonthBudgetBody = {
  month: string;
  siteId?: string;
  currency?: string;
  revenue?: number;
  energyCost?: number;
  fees?: number;
  ownerShare?: number;
};

export type SetMonthExchangeRateBody = {
  month: string;
  currency: string;
  rate: number;
};

export type SetOcpiPartyOfCountryBody = {
  /** Three letters or digits. Upper-cased. */
  partyId: string;
  businessName: string;
  website?: string;
};

export type SetOcpiPartyOfCountryResponse = {
  party: RoamingParty;
};

export type SetOwnerPayoutRuleBody = {
  automatic?: boolean | null;
  minAmount?: number | null;
  hold?: boolean;
  holdReason?: string;
};

export type SetPayrollRulesBody = {
  kesCap?: number;
  jpCap?: number;
  ter?: Record<string, unknown>;
};

export type SetPettyCashFloatBody = {
  float?: number | null;
};

export type SetProvisionRatesBody = {
  current?: number;
  "1-30"?: number;
  "31-60"?: number;
  "61-90"?: number;
  "90+"?: number;
};

export type SetReminderScheduleBody = {
  enabled?: boolean;
  steps?: number[];
  channels?: ("email" | "whatsapp")[];
  whatsappTemplate?: {
    name?: string;
    lang?: string;
  } | null;
};

export type SetReportingCurrencyBody = {
  currency?: string | null;
};

export type SetReportingCurrencyResponse = {
  reportingCurrency?: string | null;
};

export type SetReportPackRecipientsBody = {
  recipients?: string[];
};

export type SetRevenueDropAlertsBody = {
  enabled?: boolean;
  dropPct?: number;
  minBaseline?: number;
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

export type SetScorecardEMailBody = {
  enabled?: boolean;
  day?: number;
  recipients?: string[];
  amberPct?: number;
};

export type SetSecurityProfileBody = {
  profile: 0 | 1 | 2 | 3;
};

export type SetSecurityProfileResponse = {
  ok: true;
  profile: 0 | 1 | 2 | 3;
};

export type SetSettlementTrackingBody = {
  graceDays?: number;
  withdrawalDays?: number;
};

export type SetSiteElectricityCostPerKWhBody = {
  ratePerKwh: number;
};

export type SetSiteElectricityCostPerKWhResponse = {
  siteId?: string;
  ratePerKwh?: number;
  currency?: string;
};

export type SetSiteElectricityTariffBody = {
  tariffClass: string;
  powerKva: number;
  ratePeak?: number;
  rateOffpeak?: number;
  peakFrom?: number;
  peakTo?: number;
  fixedMonthly?: number;
};

export type SetSiteOwnerBankDetailsBody = {
  bankName: string;
  bankCode?: string;
  holderName: string;
  accountNumber?: string;
};

export type SetSiteOwnerBankDetailsResponse = {
  account: OwnerBankAccount;
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

export type SetSubscriptionRevenueAccountsBody = {
  deferred?: Record<string, unknown>;
  revenue?: Record<string, unknown>;
  receivable?: Record<string, unknown>;
};

export type SetTaxFilingCalendarBody = {
  obligations?: Record<string, unknown>;
  reminderDays?: number;
  reminders?: boolean;
};

export type SettlementsAndWithdrawalsOfPaymentsAccountResponse = {
  today?: string;
  settings?: Record<string, unknown>;
  bankStatementsTo?: string | null;
  settlements?: Record<string, unknown>[];
  withdrawals?: Record<string, unknown>[];
  summary?: Record<string, unknown>;
};

export type SettleOwnerPayoutDuitkuNeverConfirmedBody = {
  outcome: "succeeded" | "failed";
  note: string;
};

export type SettleOwnerPayoutDuitkuNeverConfirmedResponse = {
  transfer: PayoutTransfer;
};

export type SettleRefundTransferWhoseResultDuitkuNeverConfirmedBody = {
  outcome: "succeeded" | "failed";
  note: string;
};

export type SettleRefundTransferWhoseResultDuitkuNeverConfirmedResponse = {
  transfer: RefundTransfer;
};

export type SettleWithGroupEntityBody = {
  otherOrgId: string;
  currency: string;
  settledOn?: string;
  reference?: string;
};

export type SettleWithGroupEntityResponse = {
  settlementId?: string;
  other?: string;
  currency?: string;
  receivable?: number;
  payable?: number;
  net?: number;
  direction?: string;
};

export type SetTreasurySettingsBody = {
  indicativeRatePct?: number;
  buffer?: number;
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

export type SharedCostsResponse = {
  costs?: Record<string, unknown>[];
  categories?: string[];
  bases?: string[];
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

export type SignOffCloseStepBody = {
  note?: string;
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

export type SimulateTariffsForSiteResponse = {
  load?: Record<string, unknown>;
  revenuePerKwh?: number;
  options?: Record<string, unknown>[];
  cheapest?: string | null;
  shift?: Record<string, unknown> | null;
  recommendation?: string | null;
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

export type SiteInvestmentsAndPaybackResponse = {
  asOf?: string;
  sites?: Record<string, unknown>[];
  totals?: Record<string, unknown>;
  voided?: Record<string, unknown>[];
};

export type SiteOwnerBankDetailsResponse = {
  account: OwnerBankAccount;
};

export type SiteOwnerDocumentsResponse = {
  advices?: Record<string, unknown>[];
  withholdings?: Record<string, unknown>[];
  years?: string[];
  scheduled?: Record<string, unknown>[];
};

export type SiteOwnersBankDetailChangeRequestsResponse = {
  requests: {
    id?: string;
    ownerId?: string;
    owner?: string;
    bankName?: string;
    bankCode?: string | null;
    holderName?: string;
    accountMasked?: string;
    note?: string | null;
    state?: string;
    requestedAt?: string;
    requestedBy?: string | null;
    current?: {
      bankName?: string;
      holderName?: string;
      accountMasked?: string;
    } | null;
  }[];
};

export type SiteOwnersQueriesOnTheirStatementsResponse = {
  disputes?: Record<string, unknown>[];
  open?: number;
  pendingAdjustments?: Record<string, unknown>[];
};

export type SiteOwnersSharesAndTheirPayoutsResponse = {
  shares: OwnerShare[];
  payoutsAvailable?: boolean;
  payoutRails?: ("duitku" | "xendit")[];
};

export type SitePLForMonthResponse = {
  month?: string;
  sites?: Record<string, unknown>[];
  totals?: Record<string, unknown>;
  unallocated?: Record<string, unknown>[];
};

export type StartSessionRemotelyBody = {
  connectorId?: number;
  /** The RFID uid or driver token to start for. */
  idTag: string;
  limitType?: "none" | "energy" | "duration" | "amount";
  /** energy: 0.1–1000 kWh; duration: 1–1440 minutes; amount: Rp 1,000–10,000,000 (converted to energy through the tariff). */
  limitValue?: number;
};

export type StatementsOfAccountSentResponse = {
  settings?: {
    enabled?: boolean;
    day?: number;
  };
  sent?: Record<string, unknown>[];
};

export type StopSessionRemotelyBody = {
  /** The OCPP transaction id of the running session. */
  transactionId: number | string;
};

export type SubmitBillForApprovalResponse = {
  id?: string;
  supplier?: string;
  number?: string;
  currency?: string;
  payable?: number;
  paid?: number;
  balance?: number;
  status?: "draft" | "awaiting_approval" | "approved" | "paid" | "rejected" | "void";
  dueDate?: string;
};

export type SubmitExpenseClaimResponse = {
  id?: string;
  number?: string;
  claimant?: string;
  title?: string;
  currency?: string;
  status?: "draft" | "submitted" | "approved" | "rejected" | "reimbursed" | "void";
  total?: number;
  lines?: Record<string, unknown>[];
};

export type SubmitJournalEntryResponse = {
  id?: string;
  number?: string;
  date?: string;
  currency?: string;
  source?: string;
  status?: "draft" | "awaiting_approval" | "posted" | "rejected" | "superseded";
  total?: number;
  lines?: Record<string, unknown>[];
};

export type SubmitPurchaseOrderResponse = {
  id?: string;
  number?: string;
  supplier?: string;
  currency?: string;
  status?: "draft" | "awaiting_approval" | "approved" | "closed" | "cancelled" | "rejected";
  ordered?: number;
  received?: number;
  billed?: number;
  toBill?: number;
};

export type SubscribeToFinanceDigestBody = {
  frequency?: "off" | "daily" | "weekly";
  channels?: ("email" | "whatsapp")[];
  sections?: string[];
  hour?: number;
  weekday?: number;
  phone?: string;
};

export type SubscriptionAndMembershipRevenueResponse = {
  month?: string;
  accounts?: Record<string, unknown>;
  currencies?: Record<string, unknown>[];
  journal?: Record<string, unknown>[];
};

export type SubscriptionRevenueTwelveMonthsResponse = {
  months?: string[];
  rows?: Record<string, unknown>[];
};

export type SuggestWhatsAppReplyResponse = {
  draft: string | null;
  handoff: string | null;
};

export type SupplierBillResponse = {
  id?: string;
  status?: string;
  payments?: Record<string, unknown>[];
};

export type SupplierBillsResponse = {
  bills?: {
    id?: string;
    supplier?: string;
    number?: string;
    currency?: string;
    payable?: number;
    paid?: number;
    balance?: number;
    status?: "draft" | "awaiting_approval" | "approved" | "paid" | "rejected" | "void";
    dueDate?: string;
  }[];
};

export type SuppliersResponse = {
  suppliers?: {
    id?: string;
    name?: string;
    termsDays?: number;
    whtPct?: number;
    archived?: boolean;
  }[];
};

export type SuspendChargePointBody = {
  reason?: string;
};

export type SuspendChargePointResponse = {
  ok: true;
  /** Driver reservations and queue offers on it that were released (fee waived or refunded, queue place kept). */
  reservationsReleased: number;
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

export type SyncAndReconcileNowResponse = {
  sync?: {
    ok?: boolean;
    rows?: number;
    complete?: boolean;
    error?: string;
  };
  balance?: number | null;
  reconciliation?: {
    open?: number;
    found?: number;
    cleared?: number;
  };
};

export type SyncMonthIntoLedgerResponse = {
  month?: string;
  posted?: number;
  unchanged?: number;
  superseded?: number;
};

export type TaxFilingCalendarResponse = {
  today?: string;
  settings?: Record<string, unknown>;
  labels?: Record<string, unknown>;
  items?: {
    obligation?: string;
    period?: string;
    dueDate?: string;
    status?: "filed" | "overdue" | "due_soon" | "upcoming";
    amount?: number | null;
    filing?: Record<string, unknown> | null;
  }[];
};

export type TestCovenantsBody = {
  month?: string;
};

export type TestIntegrationBody = {
  scope?: "org" | "platform";
  /** Sign-in codes: send a real test code to this number. */
  phone?: string;
  /** Payments: which country's account (Stripe: also checks the Stripe account is registered in that country). */
  countryCode?: "ID" | "MY" | "SG";
};

export type TestIntegrationResponse = {
  ok: boolean;
  message: string;
};

export type TransfersWaitingForSecondPersonResponse = {
  refunds: number;
  payouts: number;
  total: number;
  forMe: number;
};

export type TreasuryResponse = {
  asOf?: string;
  deposits?: {
    id?: string;
    bankName?: string;
    currency?: string;
    principal?: number;
    ratePct?: number;
    placedOn?: string;
    maturityOn?: string;
    status?: "active" | "matured" | "broken";
    accrued?: Record<string, unknown>;
    atMaturity?: Record<string, unknown>;
  }[];
  totals?: Record<string, unknown>;
  incomeThisYear?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  idleCash?: Record<string, unknown>[];
};

export type TriggerMessageFromChargePointBody = {
  /** BootNotification, Heartbeat, MeterValues, StatusNotification, DiagnosticsStatusNotification, FirmwareStatusNotification. */
  requestedMessage?: string;
  connectorId?: number;
};

export type UnbindUserFromTheirMicrosoftAccountResponse = {
  ok: true;
};

export type UnlinkFromCapexProjectBody = {
  billId?: string;
  orderId?: string;
};

export type UnlockConnectorBody = {
  connectorId?: number;
};

export type UpdateAuditorRequestBody = {
  status?: "requested" | "in_progress" | "provided" | "accepted";
  ownerId?: string;
  dueOn?: string;
  note?: string;
};

export type UpdateCarbonCreditsBody = {
  status?: "estimated" | "verified" | "issued" | "void";
  tonnes?: number;
  standard?: string;
  serial?: string;
  note?: string;
};

export type UpdateChargebackBody = {
  status: "evidence_submitted" | "won" | "lost" | "accepted";
  on?: string;
  note?: string;
};

export type UpdateChargePointProfileResponse = {
  ok: true;
};

export type UpdateClaimBody = {
  status: "submitted" | "accepted" | "rejected" | "paid" | "closed";
  settled?: number;
  paidOn?: string;
  insurerRef?: string;
  note?: string;
};

export type UpdateConsoleUserResponse = {
  ok: true;
};

export type UpdateGrantClaimBody = {
  status: "submitted" | "approved" | "rejected" | "paid";
  on?: string;
  paid?: number;
  cashAccountId?: string;
  reference?: string;
  note?: string;
};

export type UpdateSiteOwnerBody = OwnerInput & {
  archived?: boolean;
};

export type UpdateSiteOwnerResponse = {
  ok: true;
};

export type UpdateWarrantyClaimBody = {
  status: "accepted" | "rejected" | "paid";
  paid?: number;
  on?: string;
  note?: string;
};

export type UpdateWebhookEndpointBody = WebhookEndpointInput & {
  state?: "active" | "paused";
};

export type UpdateWebhookEndpointResponse = {
  endpoint: WebhookEndpoint;
};

export type UploadAndroidNotificationsServiceAccountFcmBody = {
  /** The service account JSON. */
  serviceAccount: Record<string, unknown> | string;
};

export type UploadAndroidNotificationsServiceAccountFcmResponse = DriverAppView & {
  androidPushDevices?: number;
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

export type UploadBankStatementCsvBody = {
  filename?: string;
  csv: string;
};

export type UploadBankStatementCsvResponse = {
  statementId?: string;
  bank?: string;
  from?: string;
  to?: string;
  lines?: number;
  duplicates?: number;
  skipped?: number;
  matched?: number;
};

export type UploadConsoleLogoBody = {
  /** Base64 PNG (a data: URL is accepted). */
  png: string;
};

export type UploadConsoleLogoResponse = ConsoleBrandResult & {
  logo: {
    width: number;
    height: number;
    bytes: number;
    sha256: string;
  };
};

export type UploadedBankStatementsResponse = {
  statements: {
    id?: string;
    bank?: string;
    filename?: string;
    from?: string | null;
    to?: string | null;
    lines?: number;
    open?: number;
    uploadedAt?: string;
    uploadedBy?: string | null;
  }[];
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

export type VoidAssetBody = {
  reason: string;
};

export type VoidAssetResponse = {
  id?: string;
  voided?: boolean;
};

export type VoidCreditNoteBody = {
  reason: string;
};

export type VoidCustomerDepositEntryBody = {
  reason: string;
};

export type VoidElectricityBillBody = {
  reason: string;
};

export type VoidElectricityBillResponse = {
  ok?: boolean;
};

export type VoidEliminationBody = {
  reason: string;
};

export type VoidExpenseClaimResponse = {
  id?: string;
  number?: string;
  claimant?: string;
  title?: string;
  currency?: string;
  status?: "draft" | "submitted" | "approved" | "rejected" | "reimbursed" | "void";
  total?: number;
  lines?: Record<string, unknown>[];
};

export type VoidFakturMasukanBody = {
  reason: string;
};

export type VoidFleetInvoiceBody = {
  reason: string;
};

export type VoidFleetInvoiceResponse = {
  invoice: FleetStatement;
  fakturWarning?: string | null;
};

export type VoidLeaseBody = {
  reason: string;
};

export type VoidLeaseResponse = {
  id?: string;
  voided?: boolean;
};

export type VoidPaymentToSupplierBody = {
  reason: string;
};

export type VoidPaymentToSupplierResponse = {
  id?: string;
  supplier?: string;
  number?: string;
  currency?: string;
  payable?: number;
  paid?: number;
  balance?: number;
  status?: "draft" | "awaiting_approval" | "approved" | "paid" | "rejected" | "void";
  dueDate?: string;
};

export type VoidPayrollRunBody = {
  reason: string;
};

export type VoidRechargeBody = {
  reason: string;
};

export type VoidRechargeResponse = {
  id?: string;
  number?: string;
  direction?: "out" | "in";
  from?: string;
  to?: string;
  month?: string;
  amount?: number;
  currency?: string;
  status?: "draft" | "issued" | "settled" | "void";
};

export type VoidRecordedPaymentBody = {
  reason: string;
};

export type VoidRecordedPaymentResponse = {
  ok: boolean;
  statement: StatementDue;
};

export type VoidRoamingSettlementPaymentBody = {
  reason: string;
};

export type VoidSharedCostBody = {
  reason: string;
};

export type VoidSharedCostResponse = {
  ok?: boolean;
};

export type VoidSiteInvestmentBody = {
  reason: string;
};

export type VoidSiteInvestmentResponse = {
  ok?: boolean;
};

export type VoidSupplierBillBody = {
  reason: string;
};

export type VoidSupplierBillResponse = {
  id?: string;
  supplier?: string;
  number?: string;
  currency?: string;
  payable?: number;
  paid?: number;
  balance?: number;
  status?: "draft" | "awaiting_approval" | "approved" | "paid" | "rejected" | "void";
  dueDate?: string;
};

export type VoidTaxFilingMarkBody = {
  reason: string;
};

export type VoidTaxFilingMarkResponse = {
  ok?: boolean;
};

export type VoidTransferBody = {
  reason: string;
};

export type VoidTransferResponse = {
  id?: string;
  voided?: boolean;
};

export type VoidWithholdingRecordBody = {
  reason: string;
};

export type VoidWithholdingRecordResponse = {
  ok: boolean;
};

export type VoidWithholdingSlipBody = {
  reason: string;
};

export type WeeklyCashView13WeeksResponse = {
  from?: string;
  to?: string;
  position?: Record<string, unknown>;
  currencies?: Record<string, unknown>[];
  notes?: string[];
};

export type WhatBankLineCouldBeResponse = {
  candidates: {
    kind?: "gateway_withdrawal" | "statement_payment" | "refund" | "roaming_payment" | "supplier_payment";
    ref?: string;
    date?: string;
    amount?: number;
    label?: string;
    reference?: string | null;
  }[];
};

export type WhatCustomersOweByAgeResponse = {
  receivables?: Record<string, unknown>[];
  writtenOff?: Record<string, unknown>[];
  aging?: Record<string, unknown>;
  buckets?: string[];
  dunning?: Record<string, unknown>;
  writeOffsPending?: Record<string, unknown>[];
};

export type WhatEachPaymentMethodCostsResponse = {
  per: number;
  accounts: {
    id?: string;
    label?: string;
    provider?: string;
    fallback?: boolean;
    methods?: {
      channel?: string;
      payments?: number;
      amount?: number;
      fees?: number;
      averageFee?: number | null;
      rate?: number | null;
      per100k?: number | null;
    }[];
    quoted?: {
      channel?: string;
      fee?: number;
    }[] | null;
  }[];
};

export type WhatsappAccountEventsResponse = {
  events: {
    id: string;
    field: string;
    event?: string | null;
    payload?: Record<string, unknown>;
    createdAt: string;
  }[];
};

export type WhatsappBusinessDashboardResponse = {
  configured: boolean;
  connection: {
    /** The sign-in codes integration the credentials come from: the main channel, else the fallback. */
    source?: "otp" | "otp_fallback";
    /** Null when not saved on the integration: no templates then. */
    wabaId?: string | null;
    phoneNumberId?: string;
    displayPhoneNumber?: string | null;
    verifiedName?: string | null;
    /** GREEN, YELLOW, RED or UNKNOWN. */
    qualityRating?: string | null;
    messagingLimitTier?: string | null;
    nameStatus?: string | null;
    status?: string | null;
    checkedAt?: string;
    error?: string | null;
  } | null;
  webhook: {
    /** Null until the sign-in codes integration is saved once on 1.10.0 (that issues the key). */
    url?: string | null;
    /** False: Meta's calls are refused (403) until the app secret is saved. */
    hasAppSecret?: boolean;
    verifyToken?: string | null;
    fields?: string[];
    lastEventAt?: string | null;
    lastStatusAt?: string | null;
  } | null;
  requiredTemplates: WhatsAppRequiredTemplate[];
  stats: {
    days: number;
    total: number;
    byStatus: {
      accepted?: number;
      sent?: number;
      delivered?: number;
      read?: number;
      failed?: number;
    };
    byPurpose: {
      otp?: number;
      alert?: number;
      test?: number;
      other?: number;
      support?: number;
    };
    deliveryRate?: number | null;
    readRate?: number | null;
    daily: {
      day: string;
      sent: number;
      delivered: number;
      read: number;
      failed: number;
    }[];
  };
  recentFailures: WhatsAppMessage[];
  /** (v1.11.0) The support inbox over the same days. */
  support?: {
    /** The WhatsApp AI support integration has an API key. */
    configured?: boolean;
    mode?: "auto" | "draft" | "off" | null;
    model?: string | null;
    conversations?: number;
    waitingForStaff?: number;
    aiReplies?: number;
    staffReplies?: number;
    handoffs?: number;
    aiTokens?: number;
  };
};

export type WhatsappMessagesResponse = {
  messages: WhatsAppMessage[];
  nextBefore: string | null;
};

export type WhatsappMessageTemplatesResponse = {
  templates: WhatsAppTemplate[];
  required: WhatsAppRequiredTemplate[];
  managerUrl: string;
};

export type WhatsappSupportInboxResponse = {
  conversations: WhatsAppConversation[];
  nextBefore: string | null;
  assistant: {
    configured?: boolean;
    mode?: "auto" | "draft" | "off" | null;
  };
};

export type WithdrawMyDisputeEMSPSideBody = {
  note?: string;
};

export type WithdrawMyDisputeEMSPSideResponse = {
  dispute: {
    id?: string;
    hub_cdr_id?: string;
    cdr_id?: string;
    raised_by?: "emsp" | "platform";
    reason?: "unknown_token" | "not_authorized" | "duplicate" | "amount" | "energy" | "tariff_mismatch" | "session_not_found" | "other";
    currency?: string;
    claimed_minor?: number | null;
    message?: string;
    status?: "open" | "accepted" | "rejected" | "escalated" | "credited" | "expired" | "resolved" | "withdrawn";
    resolution?: "credited" | "upheld" | "written_off" | null;
    respond_by?: string;
    credit_due_by?: string | null;
    escalate_by?: string | null;
    credit_cdr_id?: string | null;
    /** Deprecated: the v1.6 name of `claimed_minor`, present while the amount is in IDR. */
    claimed_idr?: number | null;
  };
};

export type WriteReportPackCommentaryBody = {
  commentary?: Record<string, unknown>;
};

export type XenditReportResponse = {
  report: GatewayReport;
};

export type XenditReportsResponse = {
  reports: GatewayReport[];
};

export type YearEndSummaryResponse = {
  year?: number;
  ended?: boolean;
  monthsLocked?: number;
  months?: Record<string, unknown>[];
  totals?: Record<string, unknown>;
  sites?: Record<string, unknown>[];
  owners?: Record<string, unknown>[];
  pph23?: Record<string, unknown>;
  filings?: Record<string, unknown>[];
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
   * Accounting exports
   *
   * (v1.19.0) The accounting package set in the settings, the packages offered, the last 12 months (exported or not) and every export (month, package, entries, total debit, who, when).
   *
   * `GET /v1/finance/accounts/{id}/accounting-exports` · needs `payment:read`
   */
  accountingExports(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
  }, options?: RequestOptions): Promise<AccountingExportsResponse> {
    return this.transport.request<AccountingExportsResponse>({ method: "GET", path: "/v1/finance/accounts/{id}/accounting-exports", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Accounting journal
   *
   * (v1.17.0) The period as double-entry journal entries, one per day and kind (collections, gateway fees and VAT on fees, withholding tax, refunds, withdrawals to the bank, owner payouts), every entry balanced, with the account codes from the settings. format: xlsx (default; Journal, By account, About), csv, or json. Audited as finance.journal_exported.
   *
   * `GET /v1/finance/accounts/{id}/journal` · needs `payment:read`
   */
  accountingJournal(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
    query?: {
      /** First day (platform time zone). Default: the first of the current month. */
      from?: string;
      /** Last day, inclusive. Default: today. At most 400 days. */
      to?: string;
      format?: "xlsx" | "csv" | "json";
    };
  }, options?: RequestOptions): Promise<AccountingJournalResponse> {
    return this.transport.request<AccountingJournalResponse>({ method: "GET", path: "/v1/finance/accounts/{id}/journal", pathParams: { id: params.id }, query: params.query, accept: "json" }, options);
  }

  /**
   * An account's lines
   *
   * (v1.31.0) The posted lines on an account in a month (default this month): entry, date, source, memo, debit, credit.
   *
   * `GET /v1/finance/ledger/accounts/{code}/lines`
   */
  accountLines(params: {
    /** The account code. */
    code: string;
    query?: {
      month?: string;
    };
  }, options?: RequestOptions): Promise<AccountLinesResponse> {
    return this.transport.request<AccountLinesResponse>({ method: "GET", path: "/v1/finance/ledger/accounts/{code}/lines", pathParams: { code: params.code }, query: params.query, accept: "json" }, options);
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
   * Acknowledge a control finding
   *
   * (v1.25.0) A finding's key with a note on what was checked; recorded in the audit log (controls.finding_acknowledged). Needs finance:approve.
   *
   * `POST /v1/finance/controls/acknowledge` · needs `finance:approve`
   */
  acknowledgeControlFinding(params: {
    body: AcknowledgeControlFindingBody;
  }, options?: RequestOptions): Promise<AcknowledgeControlFindingResponse> {
    return this.transport.request<AcknowledgeControlFindingResponse>({ method: "POST", path: "/v1/finance/controls/acknowledge", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Add an auditor request
   *
   * (v1.35.0) audit, ref, item, requestedOn, dueOn, ownerId, note. Audited.
   *
   * `POST /v1/finance/compliance/pbc`
   */
  addAuditorRequest(params: {
    body: AddAuditorRequestBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/compliance/pbc", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add a bank feed
   *
   * (v1.32.0) name, cashAccountId (a bank account), url (https; GET url?from=YYYY-MM-DD answering JSON transactions), token (sent as a bearer, sealed), enabled, since. Audited.
   *
   * `POST /v1/finance/bank-feeds`
   */
  addBankFeed(params: {
    body: AddBankFeedBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/bank-feeds", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add a bank match rule
   *
   * (v1.32.0) For lines nothing matched: direction, a text the line contains and an amount range; action ignore (with a note) or suggest (a journal entry to accountCode, awaiting approval). Lower priority runs first. Audited.
   *
   * `POST /v1/finance/bank-rules`
   */
  addBankMatchRule(params: {
    body: AddBankMatchRuleBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/bank-rules", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add the bukti potong to a withholding
   *
   * (v1.18.0) Its number and date. payment:write; audited as finance.tax_withholding_bukti.
   *
   * `POST /v1/finance/tax/withholdings/{wid}/bukti` · needs `payment:write`
   */
  addBuktiPotongToWithholding(params: {
    /** The withholding record id. */
    wid: string;
    body: AddBuktiPotongToWithholdingBody;
  }, options?: RequestOptions): Promise<AddBuktiPotongToWithholdingResponse> {
    return this.transport.request<AddBuktiPotongToWithholdingResponse>({ method: "POST", path: "/v1/finance/tax/withholdings/{wid}/bukti", pathParams: { wid: params.wid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add a capex project
   *
   * (v1.33.0) Numbered CP-0001…; budget by bill category. Audited.
   *
   * `POST /v1/finance/projects`
   */
  addCapexProject(params: {
    body: AddCapexProjectBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/projects", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add a cash account
   *
   * (v1.29.0) name, kind (bank or cash), bankName, accountHint (the number's last digits: statements with them count for the account), currency, openingBalance and openingOn, minimum (alert below it, finance.cash_below_minimum). Audited.
   *
   * `POST /v1/finance/cash/accounts` · needs `payment:write`
   */
  addCashAccount(params: {
    body: AddCashAccountBody;
  }, options?: RequestOptions): Promise<AddCashAccountResponse> {
    return this.transport.request<AddCashAccountResponse>({ method: "POST", path: "/v1/finance/cash/accounts", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add a compliance task
   *
   * (v1.35.0) Title, category, authority, due date, recurrence, owner, reminder days. Audited.
   *
   * `POST /v1/finance/compliance/tasks`
   */
  addComplianceTask(params: {
    body: AddComplianceTaskBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/compliance/tasks", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add a covenant
   *
   * (v1.34.0) kind dscr, interest_cover, leverage or min_cash; threshold; currency; loanId; monthly or quarterly. Audited.
   *
   * `POST /v1/finance/lenders/covenants`
   */
  addCovenant(params: {
    body: AddCovenantBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/lenders/covenants", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add an employee
   *
   * (v1.33.0) Numbered EMP-0001…; the bank account is sealed. Audited.
   *
   * `POST /v1/finance/payroll/employees`
   */
  addEmployee(params: {
    body: AddEmployeeBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/payroll/employees", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add evidence or a comment to a dispute
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `POST /v1/roaming/hub/clearing/disputes/{id}/notes` · needs `roaming:write`
   */
  addEvidenceOrCommentToDispute(params: {
    id: string;
    body: AddEvidenceOrCommentToDisputeBody;
  }, options?: RequestOptions): Promise<AddEvidenceOrCommentToDisputeResponse> {
    return this.transport.request<AddEvidenceOrCommentToDisputeResponse>({ method: "POST", path: "/v1/roaming/hub/clearing/disputes/{id}/notes", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Add a grant
   *
   * (v1.36.0) grantor, programme, kind (capital: releaseMonths; per_kwh: ratePerKwh), currency, awarded, period, site or capex project. Audited.
   *
   * `POST /v1/finance/grants`
   */
  addGrant(params: {
    body: AddGrantBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/grants", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add a grant condition
   *
   * (v1.36.0) description, dueOn. Pending conditions raise finance.grant_condition_due from 14 days ahead. Audited.
   *
   * `POST /v1/finance/grants/{id}/conditions`
   */
  addGrantCondition(params: {
    /** The id. */
    id: string;
    body: AddGrantConditionBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/grants/{id}/conditions", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add a landlord deal
   *
   * (v1.36.0) The site, the landlord (a supplier), the basis (fixed, share of revenue or margin, higher of a share and a minimum, fixed plus share), escalation, rent-free months, energy recharge, billing, term, the lease holding the fixed rent. Audited.
   *
   * `POST /v1/finance/landlords`
   */
  addLandlordDeal(params: {
    body: AddLandlordDealBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/landlords", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add a line to a claim
   *
   * (v1.31.0) While a draft or rejected; by the claimant.
   *
   * `POST /v1/finance/expenses/{id}/lines`
   */
  addLineToClaim(params: {
    /** The claim id. */
    id: string;
    body: AddLineToClaimBody;
  }, options?: RequestOptions): Promise<AddLineToClaimResponse> {
    return this.transport.request<AddLineToClaimResponse>({ method: "POST", path: "/v1/finance/expenses/{id}/lines", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add a loan
   *
   * (v1.34.0) Lender, facility, rate, start, term, grace, repayment, the cash account it runs through. Audited.
   *
   * `POST /v1/finance/lenders/loans`
   */
  addLoan(params: {
    body: AddLoanBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/lenders/loans", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add a note or a promise to pay
   *
   * (v1.20.0) A promise to pay in the future pauses the reminders until that date. Audited as finance.collection_note_added.
   *
   * `POST /v1/finance/collections/{kind}/{ref}/notes` · needs `payment:write`
   */
  addNoteOrPromiseToPay(params: {
    /** fleet_invoice or platform_statement. */
    kind: string;
    /** The invoice or statement id. */
    ref: string;
    body: AddNoteOrPromiseToPayBody;
  }, options?: RequestOptions): Promise<AddNoteOrPromiseToPayResponse> {
    return this.transport.request<AddNoteOrPromiseToPayResponse>({ method: "POST", path: "/v1/finance/collections/{kind}/{ref}/notes", pathParams: { kind: params.kind, ref: params.ref }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Add or change an account
   *
   * (v1.31.0) name, type (not once the account has posted lines), active. Audited.
   *
   * `PUT /v1/finance/ledger/accounts/{code}`
   */
  addOrChangeAccount(params: {
    /** The account code. */
    code: string;
    body: AddOrChangeAccountBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/ledger/accounts/{code}", pathParams: { code: params.code }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add a policy
   *
   * (v1.35.0) Insurer, number, kind, site or charger, cover, premium, excess, term, when paid and from which account. Audited.
   *
   * `POST /v1/finance/insurance/policies`
   */
  addPolicy(params: {
    body: AddPolicyBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/insurance/policies", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add the standard deadlines
   *
   * (v1.35.0) The usual Indonesian deadlines for a year (year, default this one), each once. Audited.
   *
   * `POST /v1/finance/compliance/templates`
   */
  addStandardDeadlines(params: {
    body: AddStandardDeadlinesBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/compliance/templates", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add a stock item
   *
   * (v1.34.0) SKU, name, unit, category, currency, reorder point and quantity, the usual supplier. Audited.
   *
   * `POST /v1/finance/inventory/items`
   */
  addStockItem(params: {
    body: AddStockItemBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/inventory/items", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add a stock location
   *
   * (v1.34.0) A depot or a site store. Audited.
   *
   * `POST /v1/finance/inventory/locations`
   */
  addStockLocation(params: {
    body: AddStockLocationBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/inventory/locations", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Add a supplier
   *
   * (v1.29.0) name, taxId (NPWP), email, phone, bank (name, accountNumber, accountName), termsDays (default 30), whtPct (the PPh 23 rate withheld, default 0), note. Audited.
   *
   * `POST /v1/finance/suppliers` · needs `payment:write`
   */
  addSupplier(params: {
    body: AddSupplierBody;
  }, options?: RequestOptions): Promise<AddSupplierResponse> {
    return this.transport.request<AddSupplierResponse>({ method: "POST", path: "/v1/finance/suppliers", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Agree a payment plan
   *
   * (v1.28.0) The invoice's balance in count (2–24) instalments from firstDue, monthly or every everyDays (7–92), with graceDays (0–60) before an instalment defaults the plan. One active plan per invoice. Audited.
   *
   * `POST /v1/fleet-invoices/{id}/payment-plan` · needs `invoice:write`
   */
  agreePaymentPlan(params: {
    /** The fleet invoice id. */
    id: string;
    body: AgreePaymentPlanBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/fleet-invoices/{id}/payment-plan", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Allocate a cost across the group
   *
   * (v1.31.0) month, description, total, currency, basis (kwh, sessions, revenue or equal; the entities' charge records that month): each other entity's share becomes a draft recharge. Audited.
   *
   * `POST /v1/finance/intercompany/allocate`
   */
  allocateCostAcrossGroup(params: {
    body: AllocateCostAcrossGroupBody;
  }, options?: RequestOptions): Promise<AllocateCostAcrossGroupResponse> {
    return this.transport.request<AllocateCostAcrossGroupResponse>({ method: "POST", path: "/v1/finance/intercompany/allocate", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Answer a dispute (CPO side): accept or reject
   *
   * accept: you will send a credit CDR (and a corrected CDR) through the hub; reject: a note is required.
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `POST /v1/roaming/hub/clearing/disputes/{id}/respond` · needs `roaming:write`
   */
  answerDisputeCpoSideAcceptOrReject(params: {
    id: string;
    body: AnswerDisputeCpoSideAcceptOrRejectBody;
  }, options?: RequestOptions): Promise<AnswerDisputeCpoSideAcceptOrRejectResponse> {
    return this.transport.request<AnswerDisputeCpoSideAcceptOrRejectResponse>({ method: "POST", path: "/v1/roaming/hub/clearing/disputes/{id}/respond", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Answer a site owner's query
   *
   * (v1.23.0) decision reject (the statement stands), resolve (explained) or adjust (amount, negative when the owner owes it back: added to the owner's share on its next statement finalised in that currency); the answer the owner sees. Audited.
   *
   * `POST /v1/finance/owner-queries/{qid}/answer` · needs `payment:write`
   */
  answerSiteOwnerQuery(params: {
    /** The query id. */
    qid: string;
    body: AnswerSiteOwnerQueryBody;
  }, options?: RequestOptions): Promise<AnswerSiteOwnerQueryResponse> {
    return this.transport.request<AnswerSiteOwnerQueryResponse>({ method: "POST", path: "/v1/finance/owner-queries/{qid}/answer", pathParams: { qid: params.qid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Apply the bank match rules
   *
   * (v1.32.0) Apply the enabled rules to the open lines now. Audited.
   *
   * `POST /v1/finance/bank-rules/apply`
   */
  applyBankMatchRules(options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/bank-rules/apply", accept: "json" }, options);
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
   * Apply a payment PlugSure missed
   *
   * For a missing_in_plugsure exception whose gateway payment matches a PlugSure payment that never became paid: the payment is applied exactly as its lost notification would have been (state, amount and currency checks; a refund when it came too late), and the exception resolved with the outcome. Audited as finance.exception_applied.
   *
   * `POST /v1/finance/accounts/{id}/exceptions/{eid}/apply` · needs `payment:write`
   */
  applyPaymentPlugSureMissed(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
    /** The exception id. */
    eid: string;
  }, options?: RequestOptions): Promise<ApplyPaymentPlugSureMissedResponse> {
    return this.transport.request<ApplyPaymentPlugSureMissedResponse>({ method: "POST", path: "/v1/finance/accounts/{id}/exceptions/{eid}/apply", pathParams: { id: params.id, eid: params.eid }, accept: "json" }, options);
  }

  /**
   * The approvals matrix
   *
   * (v1.21.0) Per kind (refund, payout, write_off, bank_change): above an amount, finance_approver (the approver holds finance:approve) or two_approvers (two different people, neither the requester). canApprove: whether the caller holds finance:approve.
   *
   * `GET /v1/finance/approval-rules` · needs `payment:read`
   */
  approvalsMatrix(options?: RequestOptions): Promise<ApprovalsMatrixResponse> {
    return this.transport.request<ApprovalsMatrixResponse>({ method: "GET", path: "/v1/finance/approval-rules", accept: "json" }, options);
  }

  /**
   * Approve and send an owner payout
   *
   * (v1.16.0) By a second person (never the requester: 403). Within the payout limits, with what is outstanding checked again and a fresh inquiry, the transfer is sent once; when Duitku confirms it the statement payment is recorded. Audited as finance.owner_payout_approved.
   *
   * `POST /v1/finance/payout-transfers/{tid}/approve` · needs `payment:write`, `finance:approve`
   */
  approveAndSendOwnerPayout(params: {
    /** The payout id. */
    tid: string;
  }, options?: RequestOptions): Promise<ApproveAndSendOwnerPayoutResponse> {
    return this.transport.request<ApproveAndSendOwnerPayoutResponse>({ method: "POST", path: "/v1/finance/payout-transfers/{tid}/approve", pathParams: { tid: params.tid }, accept: "json" }, options);
  }

  /**
   * Approve and send a refund transfer
   *
   * (v1.15.0) By a second person with payment:write (never the requester: 403). Within the limits (one transfer; all approved that day), a fresh inquiry is made (the bank's name must not have changed) and the transfer sent, once. succeeded: the refund is recorded refunded (method disbursement); failed: due again; sent: not confirmed yet, checked automatically. Audited as refund.transfer_approved.
   *
   * `POST /v1/refund-transfers/{tid}/approve` · needs `payment:write`, `finance:approve`
   */
  approveAndSendRefundTransfer(params: {
    /** The transfer id. */
    tid: string;
  }, options?: RequestOptions): Promise<ApproveAndSendRefundTransferResponse> {
    return this.transport.request<ApproveAndSendRefundTransferResponse>({ method: "POST", path: "/v1/refund-transfers/{tid}/approve", pathParams: { tid: params.tid }, accept: "json" }, options);
  }

  /**
   * Approve an expense claim
   *
   * (v1.31.0) By someone other than the claimant, under the approvals matrix (kind expense_claim); a line over its limit needs finance:approve. With two approvers the first approval is recorded. Audited.
   *
   * `POST /v1/finance/expenses/{id}/approve`
   */
  approveExpenseClaim(params: {
    /** The claim id. */
    id: string;
  }, options?: RequestOptions): Promise<ApproveExpenseClaimResponse> {
    return this.transport.request<ApproveExpenseClaimResponse>({ method: "POST", path: "/v1/finance/expenses/{id}/approve", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Approve a journal entry
   *
   * (v1.31.0) By someone other than the submitter, under the approvals matrix (kind journal_entry); it posts. With two approvers the first approval is recorded and waitingForSecondApprover is true. Audited.
   *
   * `POST /v1/finance/ledger/entries/{id}/approve`
   */
  approveJournalEntry(params: {
    /** The entry id. */
    id: string;
  }, options?: RequestOptions): Promise<ApproveJournalEntryResponse> {
    return this.transport.request<ApproveJournalEntryResponse>({ method: "POST", path: "/v1/finance/ledger/entries/{id}/approve", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Approve or reject a driver's refund request
   *
   * (v1.24.0) decision approve (optionally a smaller amount: the payment's refund becomes due, paid from Refunds) or reject (a note the driver sees). Audited.
   *
   * `POST /v1/finance/driver-refunds/{qid}/{decision}` · needs `payment:write`
   */
  approveOrRejectDriverRefundRequest(params: {
    /** The request id. */
    qid: string;
    /** approve or reject. */
    decision: string;
    body: ApproveOrRejectDriverRefundRequestBody;
  }, options?: RequestOptions): Promise<ApproveOrRejectDriverRefundRequestResponse> {
    return this.transport.request<ApproveOrRejectDriverRefundRequestResponse>({ method: "POST", path: "/v1/finance/driver-refunds/{qid}/{decision}", pathParams: { qid: params.qid, decision: params.decision }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Approve or reject a site owner's bank detail change
   *
   * (v1.19.0) decision: approve (the requested account replaces the one on file) or reject (note required; the owner sees it). Not by the person who asked. Audited as finance.owner_bank_change_approved / _rejected.
   *
   * `POST /v1/finance/owner-bank-requests/{rid}/{decision}` · needs `payment:write`, `finance:approve`
   */
  approveOrRejectSiteOwnerBankDetailChange(params: {
    /** The request id. */
    rid: string;
    /** approve or reject. */
    decision: string;
    body?: ApproveOrRejectSiteOwnerBankDetailChangeBody;
  }, options?: RequestOptions): Promise<ApproveOrRejectSiteOwnerBankDetailChangeResponse> {
    return this.transport.request<ApproveOrRejectSiteOwnerBankDetailChangeResponse>({ method: "POST", path: "/v1/finance/owner-bank-requests/{rid}/{decision}", pathParams: { rid: params.rid, decision: params.decision }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Approve or reject a write-off
   *
   * (v1.20.0) decision: approve or reject (note required); not by the requester. Audited as finance.write_off_approved / _rejected.
   *
   * `POST /v1/finance/write-offs/{wid}/{decision}` · needs `payment:write`, `finance:approve`
   */
  approveOrRejectWriteOff(params: {
    /** The write-off id. */
    wid: string;
    /** approve or reject. */
    decision: string;
    body?: ApproveOrRejectWriteOffBody;
  }, options?: RequestOptions): Promise<ApproveOrRejectWriteOffResponse> {
    return this.transport.request<ApproveOrRejectWriteOffResponse>({ method: "POST", path: "/v1/finance/write-offs/{wid}/{decision}", pathParams: { wid: params.wid, decision: params.decision }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Approve a payroll run
   *
   * (v1.33.0) By someone other than the submitter, under the approvals matrix (kind payroll_run). Audited.
   *
   * `POST /v1/finance/payroll/runs/{id}/approve`
   */
  approvePayrollRun(params: {
    /** The id. */
    id: string;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/payroll/runs/{id}/approve", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Approve a purchase order
   *
   * (v1.30.0) By someone other than the submitter, under the approvals matrix (kind purchase_order). With two approvers the first approval is recorded and waitingForSecondApprover is true. Audited.
   *
   * `POST /v1/finance/purchase-orders/{id}/approve`
   */
  approvePurchaseOrder(params: {
    /** The purchase order id. */
    id: string;
  }, options?: RequestOptions): Promise<ApprovePurchaseOrderResponse> {
    return this.transport.request<ApprovePurchaseOrderResponse>({ method: "POST", path: "/v1/finance/purchase-orders/{id}/approve", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Approve a report pack
   *
   * (v1.32.0) By a Finance Manager (finance:approve) other than the person who submitted it. Audited.
   *
   * `POST /v1/finance/report-packs/{id}/approve`
   */
  approveReportPack(params: {
    /** The id. */
    id: string;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/report-packs/{id}/approve", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Approve a supplier bill
   *
   * (v1.29.0) By someone other than the person who submitted it, under the approvals matrix (kind supplier_bill: a Finance Manager, or two approvers, above an amount). With two approvers the first approval is recorded and waitingForSecondApprover is true. A bill to capitalise becomes an asset (assetError says why if it could not). (v1.30.0) A bill on a purchase order whose three-way match fails is approved only by a Finance Manager (matchOverridden says so). Audited.
   *
   * `POST /v1/finance/bills/{id}/approve` · needs `payment:write`
   */
  approveSupplierBill(params: {
    /** The bill id. */
    id: string;
  }, options?: RequestOptions): Promise<ApproveSupplierBillResponse> {
    return this.transport.request<ApproveSupplierBillResponse>({ method: "POST", path: "/v1/finance/bills/{id}/approve", pathParams: { id: params.id }, accept: "json" }, options);
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
   * Ask to write off what is outstanding
   *
   * (v1.20.0) Up to the outstanding amount (default all of it), with a reason; a second person approves. The invoice or statement is not changed: the accountant books the bad debt. Audited as finance.write_off_requested.
   *
   * `POST /v1/finance/collections/{kind}/{ref}/write-off` · needs `payment:write`
   */
  askToWriteOffWhatIsOutstanding(params: {
    /** fleet_invoice or platform_statement. */
    kind: string;
    /** The invoice or statement id. */
    ref: string;
    body: AskToWriteOffWhatIsOutstandingBody;
  }, options?: RequestOptions): Promise<AskToWriteOffWhatIsOutstandingResponse> {
    return this.transport.request<AskToWriteOffWhatIsOutstandingResponse>({ method: "POST", path: "/v1/finance/collections/{kind}/{ref}/write-off", pathParams: { kind: params.kind, ref: params.ref }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Ask Xendit to generate a report
   *
   * (v1.16.0) Xendit's Report API for the period (from, to): TRANSACTIONS, BALANCE_HISTORY or UPCOMING_TRANSACTIONS (the next 30 days whatever the period), as CSV. 409 for a Duitku account; 502 when Xendit refuses (the key needs the Report permission). Audited as finance.report_requested.
   *
   * `POST /v1/finance/accounts/{id}/reports` · needs `payment:read`
   */
  askXenditToGenerateReport(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
    query?: {
      /** First day (platform time zone). Default: the first of the current month. */
      from?: string;
      /** Last day, inclusive. Default: today. At most 400 days. */
      to?: string;
    };
    body: AskXenditToGenerateReportBody;
  }, options?: RequestOptions): Promise<AskXenditToGenerateReportResponse> {
    return this.transport.request<AskXenditToGenerateReportResponse>({ method: "POST", path: "/v1/finance/accounts/{id}/reports", pathParams: { id: params.id }, query: params.query, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * An asset
   *
   * (v1.29.0) The asset with its whole schedule: each month of its life, its depreciation, accumulated and net book value.
   *
   * `GET /v1/finance/assets/{id}` · needs `payment:read`
   */
  asset(params: {
    /** The asset id. */
    id: string;
  }, options?: RequestOptions): Promise<AssetResponse> {
    return this.transport.request<AssetResponse>({ method: "GET", path: "/v1/finance/assets/{id}", pathParams: { id: params.id }, accept: "json" }, options);
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
   * Attach evidence to a request
   *
   * (v1.35.0) As for a task. Audited.
   *
   * `POST /v1/finance/compliance/pbc/{id}/evidence`
   */
  attachEvidenceToRequest(params: {
    /** The id. */
    id: string;
    body: AttachEvidenceToRequestBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/compliance/pbc/{id}/evidence", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Attach evidence to a task
   *
   * (v1.35.0) A file up to 5 MB (base64): PDF, PNG, JPEG, XLSX, DOCX or CSV, checked against its first bytes. Audited.
   *
   * `POST /v1/finance/compliance/tasks/{id}/evidence`
   */
  attachEvidenceToTask(params: {
    /** The id. */
    id: string;
    body: AttachEvidenceToTaskBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/compliance/tasks/{id}/evidence", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Attach a receipt
   *
   * (v1.31.0) filename, mime (image/jpeg, image/png, image/webp, application/pdf), data (base64; at most 3 MB; the file must be the type it says). Audited.
   *
   * `POST /v1/finance/expenses/{id}/lines/{lid}/receipts`
   */
  attachReceipt(params: {
    /** The claim id. */
    id: string;
    /** The line id. */
    lid: string;
    body: AttachReceiptBody;
  }, options?: RequestOptions): Promise<AttachReceiptResponse> {
    return this.transport.request<AttachReceiptResponse>({ method: "POST", path: "/v1/finance/expenses/{id}/lines/{lid}/receipts", pathParams: { id: params.id, lid: params.lid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Auditor request
   *
   * (v1.35.0) With its files.
   *
   * `GET /v1/finance/compliance/pbc/{id}`
   */
  auditorRequest(params: {
    /** The id. */
    id: string;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/compliance/pbc/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * The audit pack (ZIP)
   *
   * (v1.20.0) For the period: journal, gateway ledger, statements, statement payments, transfers, bank lines, tax withholdings, write-offs and the audit log as CSV, a manifest.json with each file's rows, bytes and SHA-256 and the audit chain's verification, and a README. X-Manifest-Sha256: the manifest's hash. Account numbers by their last four digits only. Audited as finance.audit_pack_exported.
   *
   * `GET /v1/finance/accounts/{id}/audit-pack` · needs `payment:read`
   */
  auditPackZip(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
    query?: {
      /** First day (platform time zone). Default: the first of the current month. */
      from?: string;
      /** Last day, inclusive. Default: today. At most 400 days. */
      to?: string;
    };
  }, options?: RequestOptions): Promise<ArrayBuffer> {
    return this.transport.request<ArrayBuffer>({ method: "GET", path: "/v1/finance/accounts/{id}/audit-pack", pathParams: { id: params.id }, query: params.query, accept: "binary" }, options);
  }

  /**
   * Automatic owner payouts
   *
   * (v1.26.0) The settings, the payout rails, the per-owner rules, and every finalised owner statement with something left to pay: ready, or why not (held, off, below the minimum, a query open, a bank change waiting, no bank details, the name check failed, a payout open, still waiting after finalising).
   *
   * `GET /v1/finance/owner-payouts/automation` · needs `payment:read`
   */
  automaticOwnerPayouts(options?: RequestOptions): Promise<AutomaticOwnerPayoutsResponse> {
    return this.transport.request<AutomaticOwnerPayoutsResponse>({ method: "GET", path: "/v1/finance/owner-payouts/automation", accept: "json" }, options);
  }

  /**
   * Bad-debt provision
   *
   * (v1.28.0) Receivables by age bucket × the rates (an invoice on an active plan counts as current), the provision per currency against the last recorded, the movement; the history. format=xlsx with the journal.
   *
   * `GET /v1/finance/provision` · needs `payment:read`
   */
  badDebtProvision(params?: {
    query?: {
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<BadDebtProvisionResponse> {
    return this.transport.request<BadDebtProvisionResponse>({ method: "GET", path: "/v1/finance/provision", query: params?.query, accept: "json" }, options);
  }

  /**
   * Bank feeds and match rules
   *
   * (v1.32.0) The bank feeds (account, endpoint, whether a token is set, last run and status, lines imported) and the match rules in priority order. The token is never returned.
   *
   * `GET /v1/finance/bank-feeds`
   */
  bankFeedsAndMatchRules(options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/bank-feeds", accept: "json" }, options);
  }

  /**
   * Bank statement lines and their matches
   *
   * (v1.18.0) Up to 1000 lines, open first. statement: one upload; open=true: unmatched only. Amounts are signed (credits positive).
   *
   * `GET /v1/finance/bank-lines` · needs `payment:read`
   */
  bankStatementLinesAndTheirMatches(params?: {
    query?: {
      statement?: string;
      open?: "true" | "false";
    };
  }, options?: RequestOptions): Promise<BankStatementLinesAndTheirMatchesResponse> {
    return this.transport.request<BankStatementLinesAndTheirMatchesResponse>({ method: "GET", path: "/v1/finance/bank-lines", query: params?.query, accept: "json" }, options);
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
   * Block a token
   *
   * (v1.36.0) Block a token behind chargebacks (reason). Audited.
   *
   * `POST /v1/finance/chargebacks/tokens/{tid}/block`
   */
  blockToken(params: {
    /** The token. */
    tid: string;
    body: BlockTokenBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/chargebacks/tokens/{tid}/block", pathParams: { tid: params.tid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Budgets vs actuals for a month
   *
   * (v1.20.0) The organisation's lines per currency (revenue, energy cost, gateway fees, owner share) and each site's (revenue, energy cost), budget beside actual with the variance (amount and %). alertPct: the off-track threshold.
   *
   * `GET /v1/finance/budgets` · needs `payment:read`
   */
  budgetsVsActualsForMonth(params?: {
    query?: {
      month?: string;
    };
  }, options?: RequestOptions): Promise<BudgetsVsActualsForMonthResponse> {
    return this.transport.request<BudgetsVsActualsForMonthResponse>({ method: "GET", path: "/v1/finance/budgets", query: params?.query, accept: "json" }, options);
  }

  /**
   * Cancel a capex project
   *
   * (v1.33.0) reason, cancelledOn; what was spent is written off in the ledger. Audited.
   *
   * `POST /v1/finance/projects/{id}/cancel`
   */
  cancelCapexProject(params: {
    /** The id. */
    id: string;
    body: CancelCapexProjectBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/projects/{id}/cancel", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Cancel a payment plan
   *
   * (v1.28.0) With a reason; the invoice returns to Collections. Audited.
   *
   * `POST /v1/finance/payment-plans/{id}/cancel` · needs `invoice:write`
   */
  cancelPaymentPlan(params: {
    /** The plan id. */
    id: string;
    body: CancelPaymentPlanBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/payment-plans/{id}/cancel", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Cancel a purchase order
   *
   * (v1.30.0) With a reason, while nothing is received or billed. Audited.
   *
   * `POST /v1/finance/purchase-orders/{id}/cancel`
   */
  cancelPurchaseOrder(params: {
    /** The purchase order id. */
    id: string;
    body: CancelPurchaseOrderBody;
  }, options?: RequestOptions): Promise<CancelPurchaseOrderResponse> {
    return this.transport.request<CancelPurchaseOrderResponse>({ method: "POST", path: "/v1/finance/purchase-orders/{id}/cancel", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Capex project
   *
   * (v1.33.0) The project with its budget by category, linked bills and orders.
   *
   * `GET /v1/finance/projects/{id}`
   */
  capexProject(params: {
    /** The id. */
    id: string;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/projects/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Capex projects
   *
   * (v1.33.0) Projects with budget, actual (bills), committed (orders not billed), forecast and variance; totals of open projects per currency. format=xlsx for the workbook.
   *
   * `GET /v1/finance/projects`
   */
  capexProjects(params?: {
    query?: {
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/projects", query: params?.query, accept: "json" }, options);
  }

  /**
   * Carbon and green energy
   *
   * (v1.35.0) Six months of MWh charged, the green share from RECs retired and the emissions avoided; the RECs, those held, the carbon credits with what is sold and available, the sales. format=xlsx with from and to (YYYY-MM) for the report.
   *
   * `GET /v1/finance/carbon`
   */
  carbonAndGreenEnergy(params?: {
    query?: {
      from?: string;
      to?: string;
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/carbon", query: params?.query, accept: "json" }, options);
  }

  /**
   * Carbon for a month
   *
   * (v1.35.0) Per site: MWh charged, REC MWh retired, the green share and the tonnes avoided.
   *
   * `GET /v1/finance/carbon/months/{month}`
   */
  carbonForMonth(params: {
    /** YYYY-MM. */
    month: string;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/carbon/months/{month}", pathParams: { month: params.month }, accept: "json" }, options);
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
   * Cash accounts
   *
   * (v1.29.0) The organisation's bank and cash accounts (archived=true to include archived ones).
   *
   * `GET /v1/finance/cash/accounts` · needs `payment:read`
   */
  cashAccounts(params?: {
    query?: {
      archived?: "true" | "false";
    };
  }, options?: RequestOptions): Promise<CashAccountsResponse> {
    return this.transport.request<CashAccountsResponse>({ method: "GET", path: "/v1/finance/cash/accounts", query: params?.query, accept: "json" }, options);
  }

  /**
   * Cash-flow forecast
   *
   * (v1.19.0) The next 30, 60 or 90 days: the opening position (the gateway's last balance plus the bank balance on the last uploaded statement), settlements, fleet invoices, Hub positions and post-pay sessions in; refunds due, owner shares and PlugSure's statements (finalisation + termsDays, default 14) and Hub positions out; per day the flows and the running position; the first shortfall. runRate=true adds the last 28 days' average daily collections as an estimate. format=csv: the flows.
   *
   * `GET /v1/finance/accounts/{id}/forecast` · needs `payment:read`
   */
  cashFlowForecast(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
    query?: {
      days?: 30 | 60 | 90;
      termsDays?: number;
      runRate?: boolean;
      format?: "json" | "csv";
    };
  }, options?: RequestOptions): Promise<CashFlowForecastResponse> {
    return this.transport.request<CashFlowForecastResponse>({ method: "GET", path: "/v1/finance/accounts/{id}/forecast", pathParams: { id: params.id }, query: params.query, accept: "json" }, options);
  }

  /**
   * Cash forecast
   *
   * (v1.33.0) Daily, per currency: the committed flows, the collections learnt from 180 days of charging (weekday pattern, level and trend) with a pessimistic and an optimistic line, payroll and capex; the lowest point and the first day below the minimum; the model and its accuracy. Scenario: horizonDays (7–180), collectionsPct, delayBillsDays, capex.
   *
   * `GET /v1/finance/cash-forecast`
   */
  cashForecast(params?: {
    query?: {
      horizonDays?: number;
      collectionsPct?: number;
      delayBillsDays?: number;
      capex?: boolean;
    };
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/cash-forecast", query: params?.query, accept: "json" }, options);
  }

  /**
   * Cash position
   *
   * (v1.29.0) On a day (default today): each bank and cash account's balance (its latest anchor — a balance taken, a bank statement's balance, or the opening — plus transfers and supplier payments since), the anchor and its age, below its minimum; gateway balances from the gateway's snapshots; totals per currency (bank, cash, gateway); the last 30 days per currency; the latest transfers.
   *
   * `GET /v1/finance/cash` · needs `payment:read`
   */
  cashPosition(params?: {
    query?: {
      date?: string;
    };
  }, options?: RequestOptions): Promise<CashPositionResponse> {
    return this.transport.request<CashPositionResponse>({ method: "GET", path: "/v1/finance/cash", query: params?.query, accept: "json" }, options);
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
   * Change a bank feed
   *
   * (v1.32.0) As adding; the token is replaced only when given (null clears it). Audited.
   *
   * `PUT /v1/finance/bank-feeds/{id}`
   */
  changeBankFeed(params: {
    /** The id. */
    id: string;
    body: ChangeBankFeedBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/bank-feeds/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Change a bank match rule
   *
   * (v1.32.0) As adding. Audited.
   *
   * `PUT /v1/finance/bank-rules/{id}`
   */
  changeBankMatchRule(params: {
    /** The id. */
    id: string;
    body: ChangeBankMatchRuleBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/bank-rules/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Change a capex project
   *
   * (v1.33.0) As adding (not once completed or cancelled). Audited.
   *
   * `PUT /v1/finance/projects/{id}`
   */
  changeCapexProject(params: {
    /** The id. */
    id: string;
    body: ChangeCapexProjectBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/projects/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Change a cash account
   *
   * (v1.29.0) name, bankName, accountHint, minimum, archived. Audited.
   *
   * `PUT /v1/finance/cash/accounts/{id}` · needs `payment:write`
   */
  changeCashAccount(params: {
    /** The cash account id. */
    id: string;
    body: ChangeCashAccountBody;
  }, options?: RequestOptions): Promise<ChangeCashAccountResponse> {
    return this.transport.request<ChangeCashAccountResponse>({ method: "PUT", path: "/v1/finance/cash/accounts/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Change a compliance task
   *
   * (v1.35.0) As adding; open tasks only. Audited.
   *
   * `PUT /v1/finance/compliance/tasks/{id}`
   */
  changeComplianceTask(params: {
    /** The id. */
    id: string;
    body: ChangeComplianceTaskBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/compliance/tasks/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Change a covenant
   *
   * (v1.34.0) As adding. Audited.
   *
   * `PUT /v1/finance/lenders/covenants/{id}`
   */
  changeCovenant(params: {
    /** The id. */
    id: string;
    body: ChangeCovenantBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/lenders/covenants/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Change the driver-app roaming settings
   *
   * Turns partner networks on or off for app drivers and sets the hold per currency (minor units; up to 50 times the country default; leave a currency out for the default). Audited.
   *
   * `PUT /v1/roaming/settings` · needs `roaming:write`
   */
  changeDriverAppRoamingSettings(params: {
    body: ChangeDriverAppRoamingSettingsBody;
  }, options?: RequestOptions): Promise<ChangeDriverAppRoamingSettingsResponse> {
    return this.transport.request<ChangeDriverAppRoamingSettingsResponse>({ method: "PUT", path: "/v1/roaming/settings", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Change an employee
   *
   * (v1.33.0) As adding; endOn for a leaver (the last month is computed on the year). Audited.
   *
   * `PUT /v1/finance/payroll/employees/{id}`
   */
  changeEmployee(params: {
    /** The id. */
    id: string;
    body: ChangeEmployeeBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/payroll/employees/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Change a grant
   *
   * (v1.36.0) As adding (the kind is fixed once a claim is paid). Audited.
   *
   * `PUT /v1/finance/grants/{id}`
   */
  changeGrant(params: {
    /** The id. */
    id: string;
    body: ChangeGrantBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/grants/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Change the home country, reporting time zone or default language
   *
   * Fields left out keep their value. The time zone is one of a country the organisation is in (home or a site's). Malaysia and Singapore as home country need MULTI_COUNTRY. 422 with `errors` per field. Audited.
   *
   * `PUT /v1/org/settings` · needs `org:write`
   */
  changeHomeCountryReportingTimeZoneOrDefaultLanguage(params: {
    body: ChangeHomeCountryReportingTimeZoneOrDefaultLanguageBody;
  }, options?: RequestOptions): Promise<OrgSettings> {
    return this.transport.request<OrgSettings>({ method: "PUT", path: "/v1/org/settings", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Change a landlord deal
   *
   * (v1.36.0) As adding; the terms are fixed once a statement is issued. Audited.
   *
   * `PUT /v1/finance/landlords/{id}`
   */
  changeLandlordDeal(params: {
    /** The id. */
    id: string;
    body: ChangeLandlordDealBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/landlords/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Change a loan
   *
   * (v1.34.0) As adding (not below what is drawn). Audited.
   *
   * `PUT /v1/finance/lenders/loans/{id}`
   */
  changeLoan(params: {
    /** The id. */
    id: string;
    body: ChangeLoanBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/lenders/loans/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Change the native apps’ version gate and remote configuration
   *
   * Replaces the whole configuration. Apps below `minSupported` must update (blocking screen); below `latest` they offer an update. `maintenance.active` shows the message (Indonesian / English) instead of the app. 422 with `fields` for a bad version, address or unknown feature.
   *
   * `PUT /v1/driver-app/app-config` · needs `org:write`
   */
  changeNativeAppsVersionGateAndRemoteConfiguration(params: {
    body: DriverAppConfig;
  }, options?: RequestOptions): Promise<ChangeNativeAppsVersionGateAndRemoteConfigurationResponse> {
    return this.transport.request<ChangeNativeAppsVersionGateAndRemoteConfigurationResponse>({ method: "PUT", path: "/v1/driver-app/app-config", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Change or archive a report e-mail schedule
   *
   * (v1.21.0) The same fields; archived: true removes it. Audited.
   *
   * `PUT /v1/finance/report-schedules/{rid}` · needs `payment:write`
   */
  changeOrArchiveReportEMailSchedule(params: {
    /** The schedule id. */
    rid: string;
    body: Record<string, unknown>;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/report-schedules/{rid}", pathParams: { rid: params.rid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Change a payroll line
   *
   * (v1.33.0) overtime, bonus, deduction (draft only); the line and totals are recomputed.
   *
   * `PUT /v1/finance/payroll/runs/{id}/lines/{lid}`
   */
  changePayrollLine(params: {
    /** The run. */
    id: string;
    /** The line. */
    lid: string;
    body: ChangePayrollLineBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/payroll/runs/{id}/lines/{lid}", pathParams: { id: params.id, lid: params.lid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Change a policy
   *
   * (v1.35.0) As adding; status cancelled. Audited.
   *
   * `PUT /v1/finance/insurance/policies/{id}`
   */
  changePolicy(params: {
    /** The id. */
    id: string;
    body: ChangePolicyBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/insurance/policies/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Change a stock item
   *
   * (v1.34.0) As adding; archived. Audited.
   *
   * `PUT /v1/finance/inventory/items/{id}`
   */
  changeStockItem(params: {
    /** The id. */
    id: string;
    body: ChangeStockItemBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/inventory/items/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Change a stock location
   *
   * (v1.34.0) Name, site, archived. Audited.
   *
   * `PUT /v1/finance/inventory/locations/{id}`
   */
  changeStockLocation(params: {
    /** The id. */
    id: string;
    body: ChangeStockLocationBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/inventory/locations/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Change a supplier
   *
   * (v1.29.0) Any of the fields; archived true or false. Bank details are audited in full.
   *
   * `PUT /v1/finance/suppliers/{id}` · needs `payment:write`
   */
  changeSupplier(params: {
    /** The supplier id. */
    id: string;
    body: ChangeSupplierBody;
  }, options?: RequestOptions): Promise<ChangeSupplierResponse> {
    return this.transport.request<ChangeSupplierResponse>({ method: "PUT", path: "/v1/finance/suppliers/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Change a work order
   *
   * (v1.34.0) As opening; status done (doneOn) or cancelled. Audited.
   *
   * `PUT /v1/finance/maintenance/{id}`
   */
  changeWorkOrder(params: {
    /** The id. */
    id: string;
    body: ChangeWorkOrderBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/maintenance/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Chargeback
   *
   * (v1.36.0) The case.
   *
   * `GET /v1/finance/chargebacks/{id}`
   */
  chargeback(params: {
    /** The id. */
    id: string;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/chargebacks/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Chargeback evidence
   *
   * (v1.36.0) A PDF for the provider from the payment and its charging session (personal details masked). Audited.
   *
   * `GET /v1/finance/chargebacks/{id}/evidence`
   */
  chargebackEvidence(params: {
    /** The id. */
    id: string;
  }, options?: RequestOptions): Promise<ArrayBuffer> {
    return this.transport.request<ArrayBuffer>({ method: "GET", path: "/v1/finance/chargebacks/{id}/evidence", pathParams: { id: params.id }, accept: "binary" }, options);
  }

  /**
   * Chargebacks
   *
   * (v1.36.0) Cases with the payment, session and token (masked), status and deadline; per currency open, won, lost and fees; the win rate. format=xlsx.
   *
   * `GET /v1/finance/chargebacks`
   */
  chargebacks(params?: {
    query?: {
      status?: string;
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/chargebacks", query: params?.query, accept: "json" }, options);
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
   * Chart of accounts
   *
   * (v1.31.0) The organisation's accounts: code, name, type (asset, liability, equity, revenue, expense, other), active. Seeded with the codes the finance modules post to.
   *
   * `GET /v1/finance/ledger/accounts`
   */
  chartOfAccounts(options?: RequestOptions): Promise<ChartOfAccountsResponse> {
    return this.transport.request<ChartOfAccountsResponse>({ method: "GET", path: "/v1/finance/ledger/accounts", accept: "json" }, options);
  }

  /**
   * Check the Android notifications service account with Google again
   *
   * A validate-only send to a token that cannot exist: Google checks the service account first, so nobody is notified.
   *
   * `POST /v1/driver-app/fcm/check` · needs `org:write`
   */
  checkAndroidNotificationsServiceAccountWithGoogleAgain(options?: RequestOptions): Promise<CheckAndroidNotificationsServiceAccountWithGoogleAgainResponse> {
    return this.transport.request<CheckAndroidNotificationsServiceAccountWithGoogleAgainResponse>({ method: "POST", path: "/v1/driver-app/fcm/check", accept: "json" }, options);
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
   * Check a day for revenue drops
   *
   * (v1.22.0) Compare every site's revenue on a day with its baseline now (the worker checks yesterday every morning); drops are recorded and alerted.
   *
   * `POST /v1/finance/revenue-alerts/check` · needs `payment:write`
   */
  checkDayForRevenueDrops(params: {
    body: CheckDayForRevenueDropsBody;
  }, options?: RequestOptions): Promise<CheckDayForRevenueDropsResponse> {
    return this.transport.request<CheckDayForRevenueDropsResponse>({ method: "POST", path: "/v1/finance/revenue-alerts/check", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Check a site owner's bank account by name
   *
   * (v1.15.0) Duitku Disbursement's inquiry (the operator's Duitku account, else the platform's): the holder's name the bank has, compared with the name saved. Nothing is transferred. Needs the bank code. payment:write; audited as finance.owner_bank_account_checked.
   *
   * `POST /v1/finance/owners/{oid}/bank-account/check` · needs `payment:write`
   */
  checkSiteOwnerBankAccountByName(params: {
    /** The site owner id. */
    oid: string;
  }, options?: RequestOptions): Promise<CheckSiteOwnerBankAccountByNameResponse> {
    return this.transport.request<CheckSiteOwnerBankAccountByNameResponse>({ method: "POST", path: "/v1/finance/owners/{oid}/bank-account/check", pathParams: { oid: params.oid }, accept: "json" }, options);
  }

  /**
   * Claim a grant
   *
   * (v1.36.0) amount (at most what is left of the award), or for a per-kWh grant periodFrom and periodTo (the kWh charged and the amount follow); submit. Audited.
   *
   * `POST /v1/finance/grants/{id}/claims`
   */
  claimGrant(params: {
    /** The id. */
    id: string;
    body: ClaimGrantBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/grants/{id}/claims", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Claim a warranty
   *
   * (v1.34.0) supplierId, amount (default the order's cost), reference, note, submittedOn. Audited.
   *
   * `POST /v1/finance/maintenance/{id}/claims`
   */
  claimWarranty(params: {
    /** The id. */
    id: string;
    body: ClaimWarrantyBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/maintenance/{id}/claims", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Close a deposit
   *
   * (v1.30.0) Matured (on or after maturity) or broken (before): closedOn (default today or the maturity), interestReceived (net; default the expected net at maturity, 0 when broken), penalty (broken only), rollover (termMonths, termDays or maturityOn, ratePct, withInterest) to place a new deposit. Audited.
   *
   * `POST /v1/finance/treasury/deposits/{id}/close`
   */
  closeDeposit(params: {
    /** The deposit id. */
    id: string;
    body: CloseDepositBody;
  }, options?: RequestOptions): Promise<CloseDepositResponse> {
    return this.transport.request<CloseDepositResponse>({ method: "POST", path: "/v1/finance/treasury/deposits/{id}/close", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Close a purchase order
   *
   * (v1.30.0) An approved order is done, or nothing more is coming; with a reason. Audited.
   *
   * `POST /v1/finance/purchase-orders/{id}/close`
   */
  closePurchaseOrder(params: {
    /** The purchase order id. */
    id: string;
    body: ClosePurchaseOrderBody;
  }, options?: RequestOptions): Promise<ClosePurchaseOrderResponse> {
    return this.transport.request<ClosePurchaseOrderResponse>({ method: "POST", path: "/v1/finance/purchase-orders/{id}/close", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Close a year
   *
   * (v1.24.0) Lock every month of an ended year (Finance → Close; reopening a month needs finance:approve). Audited as finance.year_closed.
   *
   * `POST /v1/finance/year-end/{year}/close` · needs `payment:write`
   */
  closeYear(params: {
    /** YYYY. */
    year: string;
  }, options?: RequestOptions): Promise<CloseYearResponse> {
    return this.transport.request<CloseYearResponse>({ method: "POST", path: "/v1/finance/year-end/{year}/close", pathParams: { year: params.year }, accept: "json" }, options);
  }

  /**
   * Complete a capex project
   *
   * (v1.33.0) completedOn, inService, category, lifeMonths: the actual cost (less bills capitalised on their own) becomes one asset. Every bill must be approved. Audited.
   *
   * `POST /v1/finance/projects/{id}/complete`
   */
  completeCapexProject(params: {
    /** The id. */
    id: string;
    body: CompleteCapexProjectBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/projects/{id}/complete", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Complete a compliance task
   *
   * (v1.35.0) status done (doneOn; a recurring task gets its next one), waived (a note) or open again. Audited.
   *
   * `POST /v1/finance/compliance/tasks/{id}/status`
   */
  completeComplianceTask(params: {
    /** The id. */
    id: string;
    body: CompleteComplianceTaskBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/compliance/tasks/{id}/status", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Compliance calendar
   *
   * (v1.35.0) Tasks due from–to (default this year) and those overdue, with owner, status and files; the counts open, overdue, due within 30 days, done on time; the auditor's requests. format=xlsx.
   *
   * `GET /v1/finance/compliance`
   */
  complianceCalendar(params?: {
    query?: {
      from?: string;
      to?: string;
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/compliance", query: params?.query, accept: "json" }, options);
  }

  /**
   * Compliance task
   *
   * (v1.35.0) With its files.
   *
   * `GET /v1/finance/compliance/tasks/{id}`
   */
  complianceTask(params: {
    /** The id. */
    id: string;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/compliance/tasks/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Confirm a payment was received (payee)
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `POST /v1/roaming/hub/clearing/payments/{id}/confirm` · needs `roaming:write`
   */
  confirmPaymentWasReceivedPayee(params: {
    id: string;
  }, options?: RequestOptions): Promise<ConfirmPaymentWasReceivedPayeeResponse> {
    return this.transport.request<ConfirmPaymentWasReceivedPayeeResponse>({ method: "POST", path: "/v1/roaming/hub/clearing/payments/{id}/confirm", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Connect or change an integration
   *
   * Saves the provider, its settings and (sealed with SECRETS_KEY) its secrets. Payments: the operator's own merchant account (org:write), or the platform default (platform:admin); settings.methods chooses the payment methods drivers may use among those the acquirer offers (QRIS, GOPAY, SHOPEEPAY, OVO, DANA, LINKAJA, CARD; Stripe: CARD, PAYNOW (SG), FPX (MY), GRABPAY; at least one; default QRIS, Stripe CARD). countryCode picks the country's account (Stripe for MY and SG: publishable key, secret key, webhook signing secret; test keys refused in production unless settings.allowTestMode — deploy/STRIPE.md). The other kinds are platform-wide (platform:admin). Test doubles are refused in production. Audited as integration.updated, without secret values.
   *
   * `PUT /v1/integrations/{kind}`
   */
  connectOrChangeIntegration(params: {
    /** Integration: payments (the acquirer: QRIS, e-wallets, cards), payments_fallback (Duitku, when the acquirer does not answer), otp (driver sign-in codes), otp_fallback, pnc_pki (Plug & Charge PKI), map_tiles or ai_support (WhatsApp AI support, Claude). */
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
   * Copy a month's budget forward
   *
   * (v1.20.0) Every line of `from` to the next `months` months (1–12), replacing them. Audited as finance.budget_copied.
   *
   * `POST /v1/finance/budgets/copy` · needs `payment:write`
   */
  copyMonthBudgetForward(params: {
    body: CopyMonthBudgetForwardBody;
  }, options?: RequestOptions): Promise<CopyMonthBudgetForwardResponse> {
    return this.transport.request<CopyMonthBudgetForwardResponse>({ method: "POST", path: "/v1/finance/budgets/copy", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Count the petty cash
   *
   * (v1.31.0) countedOn (default today), denominations (face value → how many; or total), note. The count is the account's balance for the day; the difference against what the books expected is kept. Audited.
   *
   * `POST /v1/finance/petty-cash/{id}/counts`
   */
  countPettyCash(params: {
    /** The cash account id. */
    id: string;
    body: CountPettyCashBody;
  }, options?: RequestOptions): Promise<CountPettyCashResponse> {
    return this.transport.request<CountPettyCashResponse>({ method: "POST", path: "/v1/finance/petty-cash/{id}/counts", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Create or change the console brand
   *
   * Fields left out keep their value; the product name is required when creating. Everyone who signs in to the organisation sees the brand. A web address takes effect once the platform operator approves it (and adds it to the web server, deploy/Caddyfile): then the sign-in page on it shows the brand and only this operator’s accounts may sign in there. Changing the address withdraws the approval. 409 when another operator’s console has the address approved, a driver app uses it, or in a sandbox; 422 for PlugSure’s own addresses.
   *
   * `PUT /v1/console-brand` · needs `org:write`
   */
  createOrChangeConsoleBrand(params: {
    body: CreateOrChangeConsoleBrandBody;
  }, options?: RequestOptions): Promise<ConsoleBrandResult> {
    return this.transport.request<ConsoleBrandResult>({ method: "PUT", path: "/v1/console-brand", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Creates a QRIS payment for a fixed amount of charging on one connector and quotes the energy it buys against the most expensive block the session could reach. The payment can only be claimed by `startToken` (the driver’s own token, or one minted here for a walk-up). Refused with 409 when the connector’s meter verification has lapsed or is pending, the charge point is suspended, awaiting adoption or decommissioned, or the connector is on maintenance hold; 422 when the amount does not cover the fixed fees. Maximum Rp 10,000,000.
   *
   * `POST /v1/checkout/qris` · needs `payment:write`
   */
  createQrisPrePurchase(params: {
    body: CreateQrisPrePurchaseBody;
  }, options?: RequestOptions): Promise<CheckoutQrisResult> {
    return this.transport.request<CheckoutQrisResult>({ method: "POST", path: "/v1/checkout/qris", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Create a report e-mail schedule
   *
   * (v1.21.0) name; reports (summary, margin, collections, budgets, forecast); frequency weekly (weekday 1–7) or monthly (the 1st); 1–10 recipients; accountId for the forecast. Audited.
   *
   * `POST /v1/finance/report-schedules` · needs `payment:write`
   */
  createReportEMailSchedule(params: {
    body: CreateReportEMailScheduleBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/report-schedules", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Customer credit
   *
   * (v1.33.0) Fleet accounts with their limit, hold, deposit held, last review (score, grade) and next review date; the open reviews.
   *
   * `GET /v1/finance/credit`
   */
  customerCredit(options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/credit", accept: "json" }, options);
  }

  /**
   * Customer credit account
   *
   * (v1.33.0) An account's credit factors now (paid late, days late, overdue, limit used, tenure, deposit, average monthly billing), its score, reviews and deposits.
   *
   * `GET /v1/finance/credit/accounts/{id}`
   */
  customerCreditAccount(params: {
    /** The id. */
    id: string;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/credit/accounts/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Customer security deposits
   *
   * (v1.33.0) Every deposit entry (received, returned, applied) and the total held per currency.
   *
   * `GET /v1/finance/customer-deposits`
   */
  customerSecurityDeposits(options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/customer-deposits", accept: "json" }, options);
  }

  /**
   * Decide a credit review
   *
   * (v1.33.0) decision approve (newLimit, default the suggestion; hold true or false; nextReviewOn) or reject (note). finance:approve. Audited.
   *
   * `POST /v1/finance/credit/reviews/{id}/decide`
   */
  decideCreditReview(params: {
    /** The id. */
    id: string;
    body: DecideCreditReviewBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/credit/reviews/{id}/decide", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * A deposit
   *
   * (v1.30.0) The deposit with its interest to date and at maturity.
   *
   * `GET /v1/finance/treasury/deposits/{id}`
   */
  deposit(params: {
    /** The deposit id. */
    id: string;
  }, options?: RequestOptions): Promise<DepositResponse> {
    return this.transport.request<DepositResponse>({ method: "GET", path: "/v1/finance/treasury/deposits/{id}", pathParams: { id: params.id }, accept: "json" }, options);
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
   * Disconnect the Microsoft tenant
   *
   * Microsoft sign-in stops for the organisation: every user’s binding to a Microsoft account is removed and every session signed in with Microsoft ends. Password sign-in is not affected. A signed-in administrator only: API keys are refused (403). Audited.
   *
   * `DELETE /v1/auth/microsoft/tenant` · needs `user:write`
   */
  disconnectMicrosoftTenant(options?: RequestOptions): Promise<DisconnectMicrosoftTenantResponse> {
    return this.transport.request<DisconnectMicrosoftTenantResponse>({ method: "DELETE", path: "/v1/auth/microsoft/tenant", accept: "json" }, options);
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
   * Dispose of an asset
   *
   * (v1.29.0) disposedOn (not in a future or locked month), proceeds (default 0), note (how). No depreciation from that month; the gain or loss (proceeds − net book value) goes in the month's journal. Audited.
   *
   * `POST /v1/finance/assets/{id}/dispose` · needs `payment:write`
   */
  disposeOfAsset(params: {
    /** The asset id. */
    id: string;
    body: DisposeOfAssetBody;
  }, options?: RequestOptions): Promise<DisposeOfAssetResponse> {
    return this.transport.request<DisposeOfAssetResponse>({ method: "POST", path: "/v1/finance/assets/{id}/dispose", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Dispute a CDR (eMSP side, within its dispute window)
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `POST /v1/roaming/hub/clearing/cdrs/{id}/dispute` · needs `roaming:write`
   */
  disputeCdrEMSPSideWithinItsDisputeWindow(params: {
    id: string;
    body: DisputeCdrEMSPSideWithinItsDisputeWindowBody;
  }, options?: RequestOptions): Promise<DisputeCdrEMSPSideWithinItsDisputeWindowResponse> {
    return this.transport.request<DisputeCdrEMSPSideWithinItsDisputeWindowResponse>({ method: "POST", path: "/v1/roaming/hub/clearing/cdrs/{id}/dispute", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * A dispute with its notes
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `GET /v1/roaming/hub/clearing/disputes/{id}` · needs `roaming:read`
   */
  disputeWithItsNotes(params: {
    id: string;
  }, options?: RequestOptions): Promise<DisputeWithItsNotesResponse> {
    return this.transport.request<DisputeWithItsNotesResponse>({ method: "GET", path: "/v1/roaming/hub/clearing/disputes/{id}", pathParams: { id: params.id }, accept: "json" }, options);
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
   * Download a day's finance data
   *
   * (v1.24.0) The day's datasets as one ZIP (gzipped files and a manifest with SHA-256s), whatever the target.
   *
   * `GET /v1/finance/warehouse/days/{day}` · needs `payment:read`
   */
  downloadDayFinanceData(params: {
    /** YYYY-MM-DD. */
    day: string;
  }, options?: RequestOptions): Promise<ArrayBuffer> {
    return this.transport.request<ArrayBuffer>({ method: "GET", path: "/v1/finance/warehouse/days/{day}", pathParams: { day: params.day }, accept: "binary" }, options);
  }

  /**
   * Download evidence
   *
   * (v1.35.0) The file as uploaded.
   *
   * `GET /v1/finance/compliance/evidence/{id}` · needs `payment:write`
   */
  downloadEvidence(params: {
    /** The id. */
    id: string;
  }, options?: RequestOptions): Promise<ArrayBuffer> {
    return this.transport.request<ArrayBuffer>({ method: "GET", path: "/v1/finance/compliance/evidence/{id}", pathParams: { id: params.id }, accept: "binary" }, options);
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
      /** The statement's currency: IDR (default), MYR or SGD. An account charging in several currencies has one statement and invoice per currency. */
      currency?: "IDR" | "MYR" | "SGD";
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
      /** Statement currency: IDR (default), MYR or SGD. */
      currency?: "IDR" | "MYR" | "SGD";
      /** Statement month, YYYY-MM. Defaults to the current month in the billing time zone (Asia/Jakarta). Anything else is a 400. */
      month?: string;
      /** A site owner of the organisation (UUID). */
      ownerId?: string;
    };
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/billing/statement.csv", query: params?.query, accept: "text" }, options);
  }

  /**
   * Download a statement of account as Excel
   *
   * (v1.22.0) The movements and the open invoices, one sheet each.
   *
   * `GET /v1/fleet-accounts/{id}/account-statement.xlsx` · needs `invoice:read`
   */
  downloadStatementOfAccountAsExcel(params: {
    /** Fleet account id. */
    id: string;
    query: {
      /** Month, YYYY-MM. */
      month: string;
    };
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/fleet-accounts/{id}/account-statement.xlsx", pathParams: { id: params.id }, query: params.query, accept: "text" }, options);
  }

  /**
   * Download a statement of account as PDF
   *
   * (v1.22.0) The statement of account for the month as a PDF.
   *
   * `GET /v1/fleet-accounts/{id}/account-statement.pdf` · needs `invoice:read`
   */
  downloadStatementOfAccountAsPdf(params: {
    /** Fleet account id. */
    id: string;
    query: {
      /** Month, YYYY-MM. */
      month: string;
    };
  }, options?: RequestOptions): Promise<ArrayBuffer> {
    return this.transport.request<ArrayBuffer>({ method: "GET", path: "/v1/fleet-accounts/{id}/account-statement.pdf", pathParams: { id: params.id }, query: params.query, accept: "binary" }, options);
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
   * Download the year-end pack
   *
   * (v1.24.0) One ZIP for the accountant: the workbook (months, sites, owners, PPh 23, tax filings), each as CSV, a README and a manifest with SHA-256s (x-manifest-sha256).
   *
   * `GET /v1/finance/year-end/{year}/pack` · needs `payment:read`
   */
  downloadYearEndPack(params: {
    /** YYYY. */
    year: string;
  }, options?: RequestOptions): Promise<ArrayBuffer> {
    return this.transport.request<ArrayBuffer>({ method: "GET", path: "/v1/finance/year-end/{year}/pack", pathParams: { year: params.year }, accept: "binary" }, options);
  }

  /**
   * Draft a landlord statement
   *
   * (v1.36.0) For a month (a quarterly deal: the quarter from it) that has ended; refreshed while draft. Audited.
   *
   * `POST /v1/finance/landlords/{id}/statements`
   */
  draftLandlordStatement(params: {
    /** The id. */
    id: string;
    body: DraftLandlordStatementBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/landlords/{id}/statements", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Draft the month's withholding slips
   *
   * (v1.32.0) One slip per payee and kind from the month's approved bills; drafts follow the bills, issued slips stay as issued (the answer counts those whose bills changed). Audited.
   *
   * `POST /v1/finance/tax/slips/{month}/draft`
   */
  draftMonthWithholdingSlips(params: {
    /** YYYY-MM. */
    month: string;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/tax/slips/{month}/draft", pathParams: { month: params.month }, accept: "json" }, options);
  }

  /**
   * Draft a payroll run
   *
   * (v1.33.0) month and currency: one line per employee in service; BPJS and PPh 21 (TER, or the annual calculation in December and a leaver's last month) computed. Again on a draft refreshes it. Audited.
   *
   * `POST /v1/finance/payroll/runs`
   */
  draftPayrollRun(params: {
    body: DraftPayrollRunBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/payroll/runs", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Draft a report pack
   *
   * (v1.32.0) month (ended), currency (default the main one): the figures (results against budget, cash and the 13-week low, scorecard, sites, payables) taken now. Again on a draft refreshes them. Audited.
   *
   * `POST /v1/finance/report-packs`
   */
  draftReportPack(params: {
    body: DraftReportPackBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/report-packs", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Driver funds
   *
   * (v1.28.0) The money drivers paid ahead, as a liability per currency: in use (charging now), unused (owed), refund due, loyalty points at their value; breakage candidates (unused past the breakage days) by month of payment; the month's movement (collected, used, refunded, breakage) against the gateway's ledger. format=xlsx for a workbook.
   *
   * `GET /v1/finance/driver-funds` · needs `payment:read`
   */
  driverFunds(params?: {
    query?: {
      month?: string;
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<DriverFundsResponse> {
    return this.transport.request<DriverFundsResponse>({ method: "GET", path: "/v1/finance/driver-funds", query: params?.query, accept: "json" }, options);
  }

  /**
   * Drivers' refund requests
   *
   * (v1.24.0) Requests drivers made from a charge's receipt in the app (unused balance, charging failed, overcharged, other): pending first, then the last decided; the policy.
   *
   * `GET /v1/finance/driver-refunds` · needs `payment:read`
   */
  driversRefundRequests(options?: RequestOptions): Promise<DriversRefundRequestsResponse> {
    return this.transport.request<DriversRefundRequestsResponse>({ method: "GET", path: "/v1/finance/driver-refunds", accept: "json" }, options);
  }

  /**
   * Electricity tariffs
   *
   * (v1.27.0) Each site's electricity tariff (class, kVA, peak and off-peak rates per kWh, peak hours, fixed monthly charge) and the catalogue of indicative PLN classes.
   *
   * `GET /v1/finance/tariffs` · needs `payment:read`
   */
  electricityTariffs(options?: RequestOptions): Promise<ElectricityTariffsResponse> {
    return this.transport.request<ElectricityTariffsResponse>({ method: "GET", path: "/v1/finance/tariffs", accept: "json" }, options);
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
   * E-mail a statement of account
   *
   * (v1.22.0) To the account's billing address (or `to`), with the PDF attached, through the e-mail channel; logged. 409 without an e-mail channel; 502 when the server refuses. Audited as fleet_account.statement_sent.
   *
   * `POST /v1/fleet-accounts/{id}/account-statement/send` · needs `invoice:write`
   */
  eMailStatementOfAccount(params: {
    /** Fleet account id. */
    id: string;
    body: EMailStatementOfAccountBody;
  }, options?: RequestOptions): Promise<EMailStatementOfAccountResponse> {
    return this.transport.request<EMailStatementOfAccountResponse>({ method: "POST", path: "/v1/fleet-accounts/{id}/account-statement/send", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * End a lease early
   *
   * (v1.30.0) month (the first month it no longer runs, within its term), note. The liability left and the asset's net book value are derecognised with the gain or loss. Audited.
   *
   * `POST /v1/finance/leases/{id}/end`
   */
  endLeaseEarly(params: {
    /** The lease id. */
    id: string;
    body: EndLeaseEarlyBody;
  }, options?: RequestOptions): Promise<EndLeaseEarlyResponse> {
    return this.transport.request<EndLeaseEarlyResponse>({ method: "POST", path: "/v1/finance/leases/{id}/end", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * End a shared cost
   *
   * (v1.23.0) The last month it counts in; the months it leaves must not be locked. Audited.
   *
   * `POST /v1/finance/shared-costs/{cid}/end` · needs `payment:write`
   */
  endSharedCost(params: {
    /** The cost id. */
    cid: string;
    body: EndSharedCostBody;
  }, options?: RequestOptions): Promise<EndSharedCostResponse> {
    return this.transport.request<EndSharedCostResponse>({ method: "POST", path: "/v1/finance/shared-costs/{cid}/end", pathParams: { cid: params.cid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Energy cost and margin by month
   *
   * (v1.20.0) The last months (default 12, up to 24) for the organisation or one site: kWh, revenue, energy cost (estimated: true when part is estimated), margin, per currency.
   *
   * `GET /v1/finance/energy/trend` · needs `payment:read`
   */
  energyCostAndMarginByMonth(params?: {
    query?: {
      months?: number;
      site?: string;
    };
  }, options?: RequestOptions): Promise<EnergyCostAndMarginByMonthResponse> {
    return this.transport.request<EnergyCostAndMarginByMonthResponse>({ method: "GET", path: "/v1/finance/energy/trend", query: params?.query, accept: "json" }, options);
  }

  /**
   * Energy cost and margin for a month
   *
   * (v1.20.0) Per site: sessions, kWh delivered, revenue before tax (the charge records' subtotal), the energy cost (the month's bill when recorded, else the cost per kWh × kWh as an estimate, else unknown), the cost per kWh, losses against the kWh billed, the margin; per charger the bill allocated by kWh. Totals per currency. site: one site.
   *
   * `GET /v1/finance/energy` · needs `payment:read`
   */
  energyCostAndMarginForMonth(params?: {
    query?: {
      month?: string;
      site?: string;
    };
  }, options?: RequestOptions): Promise<EnergyCostAndMarginForMonthResponse> {
    return this.transport.request<EnergyCostAndMarginForMonthResponse>({ method: "GET", path: "/v1/finance/energy", query: params?.query, accept: "json" }, options);
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
   * Escalate a rejected dispute to the platform (eMSP side)
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `POST /v1/roaming/hub/clearing/disputes/{id}/escalate` · needs `roaming:write`
   */
  escalateRejectedDisputeToPlatformEMSPSide(params: {
    id: string;
    body: EscalateRejectedDisputeToPlatformEMSPSideBody;
  }, options?: RequestOptions): Promise<EscalateRejectedDisputeToPlatformEMSPSideResponse> {
    return this.transport.request<EscalateRejectedDisputeToPlatformEMSPSideResponse>({ method: "POST", path: "/v1/roaming/hub/clearing/disputes/{id}/escalate", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Estimate carbon credits
   *
   * (v1.35.0) From the emissions avoided over from–to (YYYY-MM). Audited.
   *
   * `POST /v1/finance/carbon/credits`
   */
  estimateCarbonCredits(params: {
    body: EstimateCarbonCreditsBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/carbon/credits", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * An expense claim
   *
   * (v1.31.0) The claim with its lines and receipts.
   *
   * `GET /v1/finance/expenses/{id}`
   */
  expenseClaim(params: {
    /** The claim id. */
    id: string;
  }, options?: RequestOptions): Promise<ExpenseClaimResponse> {
    return this.transport.request<ExpenseClaimResponse>({ method: "GET", path: "/v1/finance/expenses/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Expense claims
   *
   * (v1.31.0) Claims (submitted first), filtered by status, mine=true for the caller's own: claimant, lines with receipts, receipts missing, over the limit, total; what is approved and not yet reimbursed per currency; the policy. format=xlsx for the lines.
   *
   * `GET /v1/finance/expenses`
   */
  expenseClaims(params?: {
    query?: {
      status?: string;
      mine?: "true" | "false";
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<ExpenseClaimsResponse> {
    return this.transport.request<ExpenseClaimsResponse>({ method: "GET", path: "/v1/finance/expenses", query: params?.query, accept: "json" }, options);
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
   * Export a closed month to the accounting package
   *
   * (v1.19.0) The month's journal as the import CSV of jurnal (Jurnal.id), accurate (Accurate Online) or generic; package defaults to the one in the settings. Only closed months (409 for the current one, or an empty journal). Logged and audited as finance.accounting_exported.
   *
   * `POST /v1/finance/accounts/{id}/accounting-exports` · needs `payment:read`
   */
  exportClosedMonthToAccountingPackage(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
    body: ExportClosedMonthToAccountingPackageBody;
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "POST", path: "/v1/finance/accounts/{id}/accounting-exports", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "text" }, options);
  }

  /**
   * Export a day now
   *
   * (v1.24.0) A day that has ended, to the target; logged with each file's rows, size and SHA-256. 502 when the store refuses. Audited.
   *
   * `POST /v1/finance/warehouse/run` · needs `payment:write`
   */
  exportDayNow(params: {
    body: ExportDayNowBody;
  }, options?: RequestOptions): Promise<ExportDayNowResponse> {
    return this.transport.request<ExportDayNowResponse>({ method: "POST", path: "/v1/finance/warehouse/run", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Export my hub CDRs (CSV)
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `GET /v1/roaming/hub/clearing/cdrs.csv` · needs `roaming:read`
   */
  exportMyHubCDRsCsv(params?: {
    query?: {
      side?: "cpo" | "emsp";
      status?: string;
      currency?: string;
    };
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/roaming/hub/clearing/cdrs.csv", query: params?.query, accept: "text" }, options);
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
   * Export the period (CSV, Excel, PDF)
   *
   * The period for the accountant: csv — every transaction; xlsx — Summary, By channel, Fees and Transactions sheets; pdf — the summary, by channel, fees by month, then the transactions. Audited as finance.exported.
   *
   * `GET /v1/finance/accounts/{id}/export` · needs `payment:read`
   */
  exportPeriodCsvExcelPdf(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
    query?: {
      /** First day (platform time zone). Default: the first of the current month. */
      from?: string;
      /** Last day, inclusive. Default: today. At most 400 days. */
      to?: string;
      format?: "csv" | "xlsx" | "pdf";
    };
  }, options?: RequestOptions): Promise<ArrayBuffer> {
    return this.transport.request<ArrayBuffer>({ method: "GET", path: "/v1/finance/accounts/{id}/export", pathParams: { id: params.id }, query: params.query, accept: "binary" }, options);
  }

  /**
   * Export sessions as CSV
   *
   * Downloads up to 50,000 matching sessions as UTF-8 CSV with a byte-order mark (for Excel), including the tax breakdown. Cells that start with a formula character are prefixed to prevent formula injection; site-scoped users get masked cards. Each export is audited as session.exported. Columns: an organisation whose sites are all in Indonesia gets the v1.5 columns unchanged (legacy names `energy_subtotal_idr` … `gross_total_idr`, rupiah); an organisation with a site outside Indonesia gets `energy_subtotal_minor` … `gross_total_minor` in minor units of the row's currency, with a `currency` column last.
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
   * Fetch a month's ECB reference rates
   *
   * (v1.21.0) For each other currency of the organisation's sites, the ECB reference rate on the month's last day (or the latest) into the reporting currency (FX_RATES_URL, default the frankfurter API). 502 when none could be fetched. Audited as finance.fx_rates_fetched.
   *
   * `POST /v1/finance/fx-rates/fetch` · needs `payment:write`
   */
  fetchMonthEcbReferenceRates(params: {
    body: FetchMonthEcbReferenceRatesBody;
  }, options?: RequestOptions): Promise<FetchMonthEcbReferenceRatesResponse> {
    return this.transport.request<FetchMonthEcbReferenceRatesResponse>({ method: "POST", path: "/v1/finance/fx-rates/fetch", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Finalise a roaming settlement
   *
   * (v1.25.0) Freezes an ended month's figures with the partner in a currency, numbered RS-…; once. Audited.
   *
   * `POST /v1/finance/roaming/partners/{pid}/settle` · needs `payment:write`
   */
  finaliseRoamingSettlement(params: {
    /** The OCPI partner id. */
    pid: string;
    body: FinaliseRoamingSettlementBody;
  }, options?: RequestOptions): Promise<FinaliseRoamingSettlementResponse> {
    return this.transport.request<FinaliseRoamingSettlementResponse>({ method: "POST", path: "/v1/finance/roaming/partners/{pid}/settle", pathParams: { pid: params.pid }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Finance anomaly review
   *
   * (v1.30.0) Findings of the anomaly checks (duplicate_bill, duplicate_payment, round_amount, new_supplier_large, split_bills, out_of_hours) by status (default open; all for every one), most severe first; per check the open and confirmed counts and whether it is on; the settings.
   *
   * `GET /v1/finance/checks`
   */
  financeAnomalyReview(params?: {
    query?: {
      status?: "open" | "dismissed" | "confirmed" | "cleared" | "all";
    };
  }, options?: RequestOptions): Promise<FinanceAnomalyReviewResponse> {
    return this.transport.request<FinanceAnomalyReviewResponse>({ method: "GET", path: "/v1/finance/checks", query: params?.query, accept: "json" }, options);
  }

  /**
   * Finance change log
   *
   * (v1.25.0) The finance actions in the audit log (finance, billing, refunds, fleet invoices, credit notes and credit, site owners, controls) between two days (default the last 30), by person, action prefix or target, with what was recorded before and after. format=csv for a CSV (audited).
   *
   * `GET /v1/finance/change-log` · needs `audit:read`
   */
  financeChangeLog(params?: {
    query?: {
      from?: string;
      to?: string;
      actor?: string;
      action?: string;
      target?: string;
      format?: "json" | "csv";
    };
  }, options?: RequestOptions): Promise<FinanceChangeLogResponse> {
    return this.transport.request<FinanceChangeLogResponse>({ method: "GET", path: "/v1/finance/change-log", query: params?.query, accept: "json" }, options);
  }

  /**
   * Finance controls
   *
   * (v1.25.0) Segregation-of-duties checks for a month (default this month): bank details approved then paid by the same person; a payment recorded and matched by one person; a refund approved and paid by one person; a month reopened by who locked it; too few people with finance:approve; payments outside working hours; write-offs with no collection history. Each finding with its acknowledgement.
   *
   * `GET /v1/finance/controls` · needs `audit:read`
   */
  financeControls(params?: {
    query?: {
      month?: string;
    };
  }, options?: RequestOptions): Promise<FinanceControlsResponse> {
    return this.transport.request<FinanceControlsResponse>({ method: "GET", path: "/v1/finance/controls", query: params?.query, accept: "json" }, options);
  }

  /**
   * Finance data export
   *
   * (v1.24.0) The export settings (target local or S3-compatible, format csv or ndjson, bucket and prefix; the secret is never shown), the last 60 runs, and the datasets.
   *
   * `GET /v1/finance/warehouse` · needs `payment:read`
   */
  financeDataExport(options?: RequestOptions): Promise<FinanceDataExportResponse> {
    return this.transport.request<FinanceDataExportResponse>({ method: "GET", path: "/v1/finance/warehouse", accept: "json" }, options);
  }

  /**
   * Finance overview
   *
   * Over the period: collected, payments, fees, VAT on fees, withholding tax, refunds, payouts, settled, net (collected − fees − VAT − refunds), by channel and by day. Now: receivable (collected, not yet settled, by expected day; overdue), the last balance at the gateway, refunds due, open reconciliation exceptions, and the sync state.
   *
   * `GET /v1/finance/accounts/{id}/overview` · needs `payment:read`
   */
  financeOverview(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
    query?: {
      /** First day (platform time zone). Default: the first of the current month. */
      from?: string;
      /** Last day, inclusive. Default: today. At most 400 days. */
      to?: string;
    };
  }, options?: RequestOptions): Promise<FinanceOverviewResponse> {
    return this.transport.request<FinanceOverviewResponse>({ method: "GET", path: "/v1/finance/accounts/{id}/overview", pathParams: { id: params.id }, query: params.query, accept: "json" }, options);
  }

  /**
   * Finance scorecard
   *
   * (v1.31.0) For a month (default last month) in the organisation's main currency: each KPI (revenue, sessions, kwh, marginPct, utilisationPct, collectionDays, cash, opex) with its actual, target, variance and colour (green, amber within the band, red); the counts; six months' trend; the settings.
   *
   * `GET /v1/finance/scorecard`
   */
  financeScorecard(params?: {
    query?: {
      month?: string;
      currency?: string;
    };
  }, options?: RequestOptions): Promise<FinanceScorecardResponse> {
    return this.transport.request<FinanceScorecardResponse>({ method: "GET", path: "/v1/finance/scorecard", query: params?.query, accept: "json" }, options);
  }

  /**
   * Finance settings
   *
   * (v1.17.0) The accounting journal's chart of accounts (code and name per line: gateway, bank, revenue, refunds, fees, vatInput, whtPayable, ownerPayable) and the monthly close e-mail, with PlugSure's defaults and the labels.
   *
   * `GET /v1/finance/accounts/{id}/settings` · needs `payment:read`
   */
  financeSettings(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
  }, options?: RequestOptions): Promise<FinanceSettingsResponse> {
    return this.transport.request<FinanceSettingsResponse>({ method: "GET", path: "/v1/finance/accounts/{id}/settings", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Finance summary (key figures)
   *
   * (v1.21.0) Per currency: revenue month to date (against last month to the same day and the same month last year), kWh, margin, receivables and DSO, cash (gateway balances and the last bank statement), the last 30 days' fee and refund rates, and 12 months of revenue and margin; consolidated revenue, margin and receivables in the reporting currency when set.
   *
   * `GET /v1/finance/summary` · needs `payment:read`
   */
  financeSummaryKeyFigures(options?: RequestOptions): Promise<FinanceSummaryKeyFiguresResponse> {
    return this.transport.request<FinanceSummaryKeyFiguresResponse>({ method: "GET", path: "/v1/finance/summary", accept: "json" }, options);
  }

  /**
   * Finance today
   *
   * (v1.26.0) For the phone: today's revenue per currency, the month (revenue, margin, receivables, DSO, cash), and every approval waiting (owner payouts, refund transfers, write-offs, owner bank changes, driver refund requests), each with whether the caller may decide it and the route that decides it.
   *
   * `GET /v1/finance/today` · needs `payment:read`
   */
  financeToday(options?: RequestOptions): Promise<FinanceTodayResponse> {
    return this.transport.request<FinanceTodayResponse>({ method: "GET", path: "/v1/finance/today", accept: "json" }, options);
  }

  /**
   * The fixed asset register
   *
   * (v1.29.0) Every asset (tag, category, site, charge point, cost, residual, acquired, in service, life, method, depreciation this month, accumulated, net book value, status in_service / not_in_service / fully_depreciated / disposed / voided) as of a month (default this month), totals and categories per currency, how many site investments are not in the register yet, the recorded depreciation runs and the journal's accounts. Filters category, siteId, status. format=xlsx for the register and the month's journal.
   *
   * `GET /v1/finance/assets` · needs `payment:read`
   */
  fixedAssetRegister(params?: {
    query?: {
      month?: string;
      category?: string;
      siteId?: string;
      status?: string;
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<FixedAssetRegisterResponse> {
    return this.transport.request<FixedAssetRegisterResponse>({ method: "GET", path: "/v1/finance/assets", query: params?.query, accept: "json" }, options);
  }

  /**
   * A fleet account's credit position
   *
   * (v1.24.0) Mode, limit, deposit, owed, available, % used, cards blocked for credit, and the deposit's last 50 entries.
   *
   * `GET /v1/fleet-accounts/{id}/credit` · needs `invoice:read`
   */
  fleetAccountCreditPosition(params: {
    /** Fleet account id. */
    id: string;
  }, options?: RequestOptions): Promise<FleetAccountCreditPositionResponse> {
    return this.transport.request<FleetAccountCreditPositionResponse>({ method: "GET", path: "/v1/fleet-accounts/{id}/credit", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * A fleet account's statement of account
   *
   * (v1.22.0) For the month, per currency: the opening balance, the invoices, credit notes, payments and refunds (with the running balance), the closing balance, and the invoices still open at month end by age.
   *
   * `GET /v1/fleet-accounts/{id}/account-statement` · needs `invoice:read`
   */
  fleetAccountStatementOfAccount(params: {
    /** Fleet account id. */
    id: string;
    query: {
      /** Month, YYYY-MM. */
      month: string;
    };
  }, options?: RequestOptions): Promise<FleetAccountStatementOfAccountResponse> {
    return this.transport.request<FleetAccountStatementOfAccountResponse>({ method: "GET", path: "/v1/fleet-accounts/{id}/account-statement", pathParams: { id: params.id }, query: params.query, accept: "json" }, options);
  }

  /**
   * Fleet accounts with a credit limit or deposit
   *
   * (v1.24.0) Each account in credit or prepaid mode: owed (invoices open and charging not invoiced), deposit, available, % used, cards blocked for credit.
   *
   * `GET /v1/fleet-credit` · needs `invoice:read`
   */
  fleetAccountsWithCreditLimitOrDeposit(options?: RequestOptions): Promise<FleetAccountsWithCreditLimitOrDepositResponse> {
    return this.transport.request<FleetAccountsWithCreditLimitOrDepositResponse>({ method: "GET", path: "/v1/fleet-credit", accept: "json" }, options);
  }

  /**
   * Fleet invoicing automation
   *
   * (v1.27.0) The settings (issue on a day, send, require the e-Faktur number, payment links), the month to invoice, issued invoices to send or held (and why), and the payment links.
   *
   * `GET /v1/finance/fleet-automation` · needs `invoice:read`
   */
  fleetInvoicingAutomation(options?: RequestOptions): Promise<FleetInvoicingAutomationResponse> {
    return this.transport.request<FleetInvoicingAutomationResponse>({ method: "GET", path: "/v1/finance/fleet-automation", accept: "json" }, options);
  }

  /**
   * Fraud signals
   *
   * (v1.36.0) Over 90 days: tokens and drivers with two or more chargebacks, payments refunded and charged back, bursts of failed payments at a connector, the chargeback rate per method.
   *
   * `GET /v1/finance/chargebacks/fraud`
   */
  fraudSignals(options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/chargebacks/fraud", accept: "json" }, options);
  }

  /**
   * Gateway fee audit
   *
   * (v1.19.0) Every payment's fee (excluding VAT) against the rate agreed for its method (Finance settings, contractRates): expected = 0 up to freeUpTo, else max(min, amount × pct / 100 + fixed); an overcharge counts above 1 rupiah. By month and method; methods without a rate are listed, not judged. format=csv: the overcharged payments with the gateway's ids, for the claim (audited as finance.fee_audit_exported).
   *
   * `GET /v1/finance/accounts/{id}/fee-audit` · needs `payment:read`
   */
  gatewayFeeAudit(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
    query?: {
      /** First day (platform time zone). Default: the first of the current month. */
      from?: string;
      /** Last day, inclusive. Default: today. At most 400 days. */
      to?: string;
      format?: "json" | "csv";
    };
  }, options?: RequestOptions): Promise<GatewayFeeAuditResponse> {
    return this.transport.request<GatewayFeeAuditResponse>({ method: "GET", path: "/v1/finance/accounts/{id}/fee-audit", pathParams: { id: params.id }, query: params.query, accept: "json" }, options);
  }

  /**
   * Gateway fees
   *
   * Fees, VAT and withholding tax on payments by month and channel with the effective rate; and the QRIS fees Xendit charged against PlugSure's estimate (the one on owner statements).
   *
   * `GET /v1/finance/accounts/{id}/fees` · needs `payment:read`
   */
  gatewayFees(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
    query?: {
      /** First day (platform time zone). Default: the first of the current month. */
      from?: string;
      /** Last day, inclusive. Default: today. At most 400 days. */
      to?: string;
    };
  }, options?: RequestOptions): Promise<GatewayFeesResponse> {
    return this.transport.request<GatewayFeesResponse>({ method: "GET", path: "/v1/finance/accounts/{id}/fees", pathParams: { id: params.id }, query: params.query, accept: "json" }, options);
  }

  /**
   * Gateway transactions
   *
   * The synced ledger, newest first. Filters: kind, status, settlement (pending, settled, early_settled, none), channel, matched (true / false), q (part of a reference or id). Page with before = nextBefore.
   *
   * `GET /v1/finance/accounts/{id}/transactions` · needs `payment:read`
   */
  gatewayTransactions(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
    query?: {
      /** First day (platform time zone). Default: the first of the current month. */
      from?: string;
      /** Last day, inclusive. Default: today. At most 400 days. */
      to?: string;
      kind?: "payment" | "refund" | "payout" | "transfer" | "fee" | "other";
      status?: "success" | "pending" | "failed" | "voided" | "reversed";
      settlement?: "pending" | "settled" | "early_settled" | "none";
      channel?: string;
      matched?: boolean;
      q?: string;
      before?: string;
      limit?: number;
    };
  }, options?: RequestOptions): Promise<GatewayTransactionsResponse> {
    return this.transport.request<GatewayTransactionsResponse>({ method: "GET", path: "/v1/finance/accounts/{id}/transactions", pathParams: { id: params.id }, query: params.query, accept: "json" }, options);
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
      /** Statement currency: IDR (default), MYR or SGD. */
      currency?: "IDR" | "MYR" | "SGD";
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
      /** Statement currency: IDR (default), MYR or SGD. */
      currency?: "IDR" | "MYR" | "SGD";
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
   * Get the connected Microsoft tenant
   *
   * The organisation’s connected Entra tenant (or null), how many users are bound to a Microsoft account, and the redirect URI for this console address. 404 when Microsoft sign-in is not configured.
   *
   * `GET /v1/auth/microsoft/tenant` · needs `user:read`
   */
  getConnectedMicrosoftTenant(options?: RequestOptions): Promise<GetConnectedMicrosoftTenantResponse> {
    return this.transport.request<GetConnectedMicrosoftTenantResponse>({ method: "GET", path: "/v1/auth/microsoft/tenant", accept: "json" }, options);
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
   * Get the driver-app roaming settings
   *
   * Whether signed-in app drivers may charge on partner networks, and the card hold placed before such a charge, per currency (the operator's amount, else the country default).
   *
   * `GET /v1/roaming/settings` · needs `roaming:read`
   */
  getDriverAppRoamingSettings(options?: RequestOptions): Promise<GetDriverAppRoamingSettingsResponse> {
    return this.transport.request<GetDriverAppRoamingSettingsResponse>({ method: "GET", path: "/v1/roaming/settings", accept: "json" }, options);
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
      /** The statement's currency: IDR (default), MYR or SGD. An account charging in several currencies has one statement and invoice per currency. */
      currency?: "IDR" | "MYR" | "SGD";
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
   * Get the organisation's country settings
   *
   * Home country (default for new sites, the roaming identity), reporting time zone (statements, alerts, console times), default language, the sites per country, and the tax registrations per country (effective-dated: PKP in Indonesia, service tax in Malaysia, GST in Singapore).
   *
   * `GET /v1/org/settings` · needs `org:read`
   */
  getOrganisationCountrySettings(options?: RequestOptions): Promise<OrgSettings> {
    return this.transport.request<OrgSettings>({ method: "GET", path: "/v1/org/settings", accept: "json" }, options);
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
      /** Statement currency: IDR (default), MYR or SGD. */
      currency?: "IDR" | "MYR" | "SGD";
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
   * Grant
   *
   * (v1.36.0) With its conditions, claims and clawbacks.
   *
   * `GET /v1/finance/grants/{id}`
   */
  grant(params: {
    /** The id. */
    id: string;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/grants/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Grants and incentives
   *
   * (v1.36.0) Grants with what was awarded, claimed, received, released and deferred, clawed back; conditions and claims; per currency the totals; conditions due within 30 days. format=xlsx for the register.
   *
   * `GET /v1/finance/grants`
   */
  grantsAndIncentives(params?: {
    query?: {
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/grants", query: params?.query, accept: "json" }, options);
  }

  /**
   * Group consolidation
   *
   * (v1.28.0) For the caller's organisation and its subsidiaries (parent_org_id), a month (default last month): per entity revenue, energy, shared costs, depreciation, contribution, owners' shares, PlugSure fees, operating result and KPIs; the group per currency less eliminations, and in the reporting currency; eliminations recorded and suggested. grouped is false when the organisation has no subsidiaries.
   *
   * `GET /v1/finance/group` · needs `payment:read`
   */
  groupConsolidation(params?: {
    query?: {
      month?: string;
    };
  }, options?: RequestOptions): Promise<GroupConsolidationResponse> {
    return this.transport.request<GroupConsolidationResponse>({ method: "GET", path: "/v1/finance/group", query: params?.query, accept: "json" }, options);
  }

  /**
   * Group trend
   *
   * (v1.28.0) Twelve months of the group's net revenue and operating result per currency.
   *
   * `GET /v1/finance/group/trend` · needs `payment:read`
   */
  groupTrend(params?: {
    query?: {
      month?: string;
    };
  }, options?: RequestOptions): Promise<GroupTrendResponse> {
    return this.transport.request<GroupTrendResponse>({ method: "GET", path: "/v1/finance/group/trend", query: params?.query, accept: "json" }, options);
  }

  /**
   * Hand a WhatsApp conversation over
   *
   * `ai`: back to the assistant (it answers a customer message still unanswered); `human`: staff take over; `closed`: nothing pending. Audited as whatsapp.support_handler.
   *
   * `POST /v1/whatsapp/conversations/{id}/handler` · needs `platform:admin`
   */
  handWhatsAppConversationOver(params: {
    /** The conversation id. */
    id: string;
    body: HandWhatsAppConversationOverBody;
  }, options?: RequestOptions): Promise<HandWhatsAppConversationOverResponse> {
    return this.transport.request<HandWhatsAppConversationOverResponse>({ method: "POST", path: "/v1/whatsapp/conversations/{id}/handler", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Hold or release an account
   *
   * (v1.33.0) hold true (with a reason) blocks the account's cards; false releases them. finance:approve. Audited.
   *
   * `POST /v1/finance/credit/accounts/{id}/hold`
   */
  holdOrReleaseAccount(params: {
    /** The id. */
    id: string;
    body: HoldOrReleaseAccountBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/credit/accounts/{id}/hold", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Import site investments
   *
   * (v1.29.0) Makes an asset of every site investment (v1.22.0) not yet in the register: straight line over its months, from the month after it was paid. Those in a locked month are skipped and said so. Audited.
   *
   * `POST /v1/finance/assets/import-investments` · needs `payment:write`
   */
  importSiteInvestments(options?: RequestOptions): Promise<ImportSiteInvestmentsResponse> {
    return this.transport.request<ImportSiteInvestmentsResponse>({ method: "POST", path: "/v1/finance/assets/import-investments", accept: "json" }, options);
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
   * Insurance
   *
   * (v1.35.0) Policies with their term, cover, premium, prepaid left, claims and recoveries; claims; per currency the premium and cover in force, losses, settled and the recovery rate; policies to renew. format=xlsx for the register.
   *
   * `GET /v1/finance/insurance`
   */
  insurance(params?: {
    query?: {
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/insurance", query: params?.query, accept: "json" }, options);
  }

  /**
   * Integration activity
   *
   * Payments created (create_qris; create_checkout for e-wallets and cards, with the channel) and notified, codes sent (numbers masked, codes never), tests.
   *
   * `GET /v1/integrations/{kind}/events` · needs `org:read`
   */
  integrationActivity(params: {
    /** Integration: payments (the acquirer: QRIS, e-wallets, cards), payments_fallback (Duitku, when the acquirer does not answer), otp (driver sign-in codes), otp_fallback, pnc_pki (Plug & Charge PKI), map_tiles or ai_support (WhatsApp AI support, Claude). */
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
   * Intercompany
   *
   * (v1.31.0) The group (a parent and its subsidiaries), the recharges the caller issued and received (drafts only its own), the balances per counterparty and currency (receivable, payable, net), the settlements.
   *
   * `GET /v1/finance/intercompany`
   */
  intercompany(params?: {
    query?: {
      status?: string;
    };
  }, options?: RequestOptions): Promise<IntercompanyResponse> {
    return this.transport.request<IntercompanyResponse>({ method: "GET", path: "/v1/finance/intercompany", query: params?.query, accept: "json" }, options);
  }

  /**
   * Inventory
   *
   * (v1.34.0) Items with what is on hand, the moving average cost and the value; the stock value per currency; items at or below their reorder point; locations; quantities by location. format=xlsx for the workbook.
   *
   * `GET /v1/finance/inventory`
   */
  inventory(params?: {
    query?: {
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/inventory", query: params?.query, accept: "json" }, options);
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
   * Issue a landlord statement
   *
   * (v1.36.0) The total becomes the landlord's supplier bill (rent, awaiting approval). Audited.
   *
   * `POST /v1/finance/landlords/statements/{sid}/issue`
   */
  issueLandlordStatement(params: {
    /** The statement. */
    sid: string;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/landlords/statements/{sid}/issue", pathParams: { sid: params.sid }, accept: "json" }, options);
  }

  /**
   * Issue a recharge
   *
   * (v1.31.0) A draft recharge, by the entity that charges. Audited.
   *
   * `POST /v1/finance/intercompany/recharges/{id}/issue`
   */
  issueRecharge(params: {
    /** The recharge id. */
    id: string;
  }, options?: RequestOptions): Promise<IssueRechargeResponse> {
    return this.transport.request<IssueRechargeResponse>({ method: "POST", path: "/v1/finance/intercompany/recharges/{id}/issue", pathParams: { id: params.id }, accept: "json" }, options);
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
   * Issue a withholding slip
   *
   * (v1.32.0) number (default BP-<kind>-YYYYMM-NNNN; the Coretax number when known), issuedOn (default today). Audited.
   *
   * `POST /v1/finance/tax/slips/{id}/issue`
   */
  issueWithholdingSlip(params: {
    /** The id. */
    id: string;
    body: IssueWithholdingSlipBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/tax/slips/{id}/issue", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Join PlugSure Hub (when HUB_SELF_JOIN)
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `POST /v1/roaming/hub/join` · needs `roaming:write`
   */
  joinPlugSureHubWhenHubSelfJoin(options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/roaming/hub/join", accept: "json" }, options);
  }

  /**
   * Journal entries
   *
   * (v1.31.0) A month's entries (default this month; superseded ones only when asked for by status), filtered by status and source; with status awaiting_approval, every entry waiting whatever its month; and how many wait for approval.
   *
   * `GET /v1/finance/ledger/entries`
   */
  journalEntries(params?: {
    query?: {
      month?: string;
      status?: string;
      source?: string;
    };
  }, options?: RequestOptions): Promise<JournalEntriesResponse> {
    return this.transport.request<JournalEntriesResponse>({ method: "GET", path: "/v1/finance/ledger/entries", query: params?.query, accept: "json" }, options);
  }

  /**
   * A journal entry
   *
   * (v1.31.0) The entry with its lines, who submitted and approved it, and its reversal.
   *
   * `GET /v1/finance/ledger/entries/{id}`
   */
  journalEntry(params: {
    /** The entry id. */
    id: string;
  }, options?: RequestOptions): Promise<JournalEntryResponse> {
    return this.transport.request<JournalEntryResponse>({ method: "GET", path: "/v1/finance/ledger/entries/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * KPI benchmarking
   *
   * (v1.29.0) Sites (by=site) or site owners (by=owner) over the last months (1–12, default 3) ending at to (an ended month, default last month), against their peers in the same currency: revenue, revenue per kWh, utilisation %, margin %, revenue per connector a month, collection days (lower is better). Per metric the peers' quartiles and median, each one's percentile rank (100 best), outliers beyond 1.5 × IQR flagged good or bad, and a score (the average rank). format=xlsx for a workbook.
   *
   * `GET /v1/finance/benchmark` · needs `payment:read`
   */
  kpiBenchmarking(params?: {
    query?: {
      by?: "site" | "owner" | "org";
      months?: number;
      to?: string;
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<KpiBenchmarkingResponse> {
    return this.transport.request<KpiBenchmarkingResponse>({ method: "GET", path: "/v1/finance/benchmark", query: params?.query, accept: "json" }, options);
  }

  /**
   * Landlord deal
   *
   * (v1.36.0) With the last six months' amounts, its statements and the periods due.
   *
   * `GET /v1/finance/landlords/{id}`
   */
  landlordDeal(params: {
    /** The id. */
    id: string;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/landlords/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Landlord deals
   *
   * (v1.36.0) Deals per site with last month's amount and statements not yet drafted; the statements. format=xlsx.
   *
   * `GET /v1/finance/landlords`
   */
  landlordDeals(params?: {
    query?: {
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/landlords", query: params?.query, accept: "json" }, options);
  }

  /**
   * Landlord statement
   *
   * (v1.36.0) Its months and total. format=pdf for the landlord.
   *
   * `GET /v1/finance/landlords/statements/{sid}`
   */
  landlordStatement(params: {
    /** The statement. */
    sid: string;
    query?: {
      format?: "json" | "pdf";
    };
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/landlords/statements/{sid}", pathParams: { sid: params.sid }, query: params.query, accept: "json" }, options);
  }

  /**
   * A lease
   *
   * (v1.30.0) The lease with its schedule: each month's opening liability, payment, interest, closing liability, ROU depreciation and net book value (or the straight-line expense of an exempt lease).
   *
   * `GET /v1/finance/leases/{id}`
   */
  lease(params: {
    /** The lease id. */
    id: string;
  }, options?: RequestOptions): Promise<LeaseResponse> {
    return this.transport.request<LeaseResponse>({ method: "GET", path: "/v1/finance/leases/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Leases
   *
   * (v1.30.0) Leases (PSAK 73) as of a month (default this month): terms, the liability and right-of-use asset at commencement, the liability now (current: the next 12 months' reduction, and non-current), the asset's net book value, the month's interest, depreciation and payment, status; totals per currency; the journal's accounts. format=xlsx for the leases and the month's journal.
   *
   * `GET /v1/finance/leases`
   */
  leases(params?: {
    query?: {
      month?: string;
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<LeasesResponse> {
    return this.transport.request<LeasesResponse>({ method: "GET", path: "/v1/finance/leases", query: params?.query, accept: "json" }, options);
  }

  /**
   * Ledger reports
   *
   * (v1.31.0) For a month (default last month) and a currency (default the first the ledger has): the trial balance to the month's end (balanced or not), profit and loss for the month and the year to date (revenue, expenses, other income and expense, result), and the balance sheet at the month's end (assets, liabilities, equity with the result of earlier years and of this year; balanced or not). format=xlsx for a workbook.
   *
   * `GET /v1/finance/ledger`
   */
  ledgerReports(params?: {
    query?: {
      month?: string;
      currency?: string;
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<LedgerReportsResponse> {
    return this.transport.request<LedgerReportsResponse>({ method: "GET", path: "/v1/finance/ledger", query: params?.query, accept: "json" }, options);
  }

  /**
   * A ledger row's whole trail
   *
   * (v1.16.0) The gateway transaction with its raw record (payer details masked), the other ledger rows of the same payment, PlugSure's payment with its state history and refund, the charging session (site, charger, energy, driver masked) and its charge record, Disbursement refund transfers, the membership pass it paid, and reconciliation exceptions.
   *
   * `GET /v1/finance/accounts/{id}/transactions/{tid}/trail` · needs `payment:read`
   */
  ledgerRowWholeTrail(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
    /** The ledger row id. */
    tid: string;
  }, options?: RequestOptions): Promise<LedgerRowWholeTrailResponse> {
    return this.transport.request<LedgerRowWholeTrailResponse>({ method: "GET", path: "/v1/finance/accounts/{id}/transactions/{tid}/trail", pathParams: { id: params.id, tid: params.tid }, accept: "json" }, options);
  }

  /**
   * Lender pack
   *
   * (v1.34.0) The month's (default last month) twelve-month results, covenant tests and loan schedules; format=pdf or xlsx (audited).
   *
   * `GET /v1/finance/lenders/pack`
   */
  lenderPack(params?: {
    query?: {
      month?: string;
      format?: "json" | "pdf" | "xlsx";
    };
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/lenders/pack", query: params?.query, accept: "json" }, options);
  }

  /**
   * Link a bank statement to an account
   *
   * (v1.29.0) statementId: an uploaded bank statement (Bank reconciliation) whose balances are the account's. Audited.
   *
   * `POST /v1/finance/cash/accounts/{id}/statements` · needs `payment:write`
   */
  linkBankStatementToAccount(params: {
    /** The cash account id. */
    id: string;
    body: LinkBankStatementToAccountBody;
  }, options?: RequestOptions): Promise<LinkBankStatementToAccountResponse> {
    return this.transport.request<LinkBankStatementToAccountResponse>({ method: "POST", path: "/v1/finance/cash/accounts/{id}/statements", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Link to a capex project
   *
   * (v1.33.0) billId or orderId, in the project's currency. Audited.
   *
   * `POST /v1/finance/projects/{id}/link`
   */
  linkToCapexProject(params: {
    /** The id. */
    id: string;
    body: LinkToCapexProjectBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/projects/{id}/link", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * List the countries PlugSure operates in
   *
   * Indonesia, Malaysia and Singapore: currency, the time zones a site there may use (first = default), whether consumer prices are shown including tax, and the default language.
   *
   * `GET /v1/countries`
   */
  listCountriesPlugSureOperatesIn(options?: RequestOptions): Promise<ListCountriesPlugSureOperatesInResponse> {
    return this.transport.request<ListCountriesPlugSureOperatesInResponse>({ method: "GET", path: "/v1/countries", accept: "json" }, options);
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
   * List the OCPI parties (one per country)
   *
   * Every OCPI party of the operator, the home party first. A site is published under the party of its country, else under the home party.
   *
   * `GET /v1/roaming/parties` · needs `roaming:read`
   */
  listOcpiPartiesOnePerCountry(options?: RequestOptions): Promise<ListOcpiPartiesOnePerCountryResponse> {
    return this.transport.request<ListOcpiPartiesOnePerCountryResponse>({ method: "GET", path: "/v1/roaming/parties", accept: "json" }, options);
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
   * Prepaid payments in the refund flow (due, processing, refunded, failed) with a summary: amount and count outstanding, failed count and amount refunded in the last 30 days. Outstanding refunds come first, those whose gateway refund window closes soonest leading (v1.15.0); at most 500 rows.
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
   * Loan
   *
   * (v1.34.0) With its drawdowns, payments and schedule.
   *
   * `GET /v1/finance/lenders/loans/{id}`
   */
  loan(params: {
    /** The id. */
    id: string;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/lenders/loans/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Loans and covenants
   *
   * (v1.34.0) The loans (facility, drawn, repaid, balance) and the covenants with their last twelve tests.
   *
   * `GET /v1/finance/lenders`
   */
  loansAndCovenants(options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/lenders", accept: "json" }, options);
  }

  /**
   * Lock a month
   *
   * (v1.22.0) A month that has ended. Energy bills, exchange rates, budgets and site investments dated in it can then not be added, changed or voided (409). Audited as finance.period_locked.
   *
   * `POST /v1/finance/periods/{month}/lock` · needs `payment:write`
   */
  lockMonth(params: {
    /** YYYY-MM. */
    month: string;
    body: LockMonthBody;
  }, options?: RequestOptions): Promise<LockMonthResponse> {
    return this.transport.request<LockMonthResponse>({ method: "POST", path: "/v1/finance/periods/{month}/lock", pathParams: { month: params.month }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Maintenance costs
   *
   * (v1.34.0) Per charger (and site) over from–to (default the year to date): orders, labour, parts, contractors, accrued, recovered, net, kWh and the cost per kWh; by kind. format=xlsx.
   *
   * `GET /v1/finance/maintenance/costs`
   */
  maintenanceCosts(params?: {
    query?: {
      from?: string;
      to?: string;
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/maintenance/costs", query: params?.query, accept: "json" }, options);
  }

  /**
   * Make an expense claim
   *
   * (v1.31.0) By a console user, for themselves: title, currency (default the organisation's), lines (date, category, site, description, amount, PPN). Numbered EX-00001…. Audited.
   *
   * `POST /v1/finance/expenses`
   */
  makeExpenseClaim(params: {
    body: MakeExpenseClaimBody;
  }, options?: RequestOptions): Promise<MakeExpenseClaimResponse> {
    return this.transport.request<MakeExpenseClaimResponse>({ method: "POST", path: "/v1/finance/expenses", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Make a manual journal entry
   *
   * (v1.31.0) date, currency, memo, lines (2–100: account, debit or credit, description) that balance, on active accounts; draft (true to keep it as a draft; otherwise it is submitted). It posts once approved by a second person. Not in a locked month. Audited.
   *
   * `POST /v1/finance/ledger/entries`
   */
  makeManualJournalEntry(params: {
    body: MakeManualJournalEntryBody;
  }, options?: RequestOptions): Promise<MakeManualJournalEntryResponse> {
    return this.transport.request<MakeManualJournalEntryResponse>({ method: "POST", path: "/v1/finance/ledger/entries", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Make a payment link for a fleet invoice
   *
   * (v1.27.0) A Xendit invoice on the operator's own Xendit account for the balance (the open one if any); paid → the invoice marked paid. Audited.
   *
   * `POST /v1/fleet-invoices/{id}/payment-link` · needs `invoice:write`
   */
  makePaymentLinkForFleetInvoice(params: {
    /** The fleet invoice id. */
    id: string;
  }, options?: RequestOptions): Promise<MakePaymentLinkForFleetInvoiceResponse> {
    return this.transport.request<MakePaymentLinkForFleetInvoiceResponse>({ method: "POST", path: "/v1/fleet-invoices/{id}/payment-link", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Management report packs
   *
   * (v1.32.0) The packs of the last 36 months (status, who drafted, submitted and approved them, the month's result) and the settings.
   *
   * `GET /v1/finance/report-packs`
   */
  managementReportPacks(options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/report-packs", accept: "json" }, options);
  }

  /**
   * Mark a tax obligation filed
   *
   * (v1.23.0) The obligation and period, the date filed or paid, the reference (NTPN, BPE, receipt) and optionally the amount. 409 when already marked (void it first). Audited as finance.tax_filed.
   *
   * `POST /v1/finance/tax/filings` · needs `payment:write`
   */
  markTaxObligationFiled(params: {
    body: MarkTaxObligationFiledBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/tax/filings", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Match, ignore or unmatch a bank line
   *
   * (v1.18.0) kind: a candidate's kind with its ref; ignored with a note (bank fee, another business); none to undo. A record matches one line only (409). payment:write; audited as finance.bank_line_matched.
   *
   * `POST /v1/finance/bank-lines/{lid}/match` · needs `payment:write`
   */
  matchIgnoreOrUnmatchBankLine(params: {
    /** The line id. */
    lid: string;
    body: MatchIgnoreOrUnmatchBankLineBody;
  }, options?: RequestOptions): Promise<MatchIgnoreOrUnmatchBankLineResponse> {
    return this.transport.request<MatchIgnoreOrUnmatchBankLineResponse>({ method: "POST", path: "/v1/finance/bank-lines/{lid}/match", pathParams: { lid: params.lid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Month close
   *
   * (v1.32.0) A month's (default last month) close steps (ledger synced, journals approved, bank reconciled, anomalies reviewed, depreciation and leases recorded, withholding slips issued, energy bills, exchange rates), each with its check and sign-off; whether the month can be locked under the policy.
   *
   * `GET /v1/finance/close`
   */
  monthClose(params?: {
    query?: {
      month?: string;
    };
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/close", query: params?.query, accept: "json" }, options);
  }

  /**
   * A month's close checklist
   *
   * (v1.22.0) What is still open before locking: sites with sessions and no energy bill, currencies without a rate into the reporting currency, bank statement lines not matched.
   *
   * `GET /v1/finance/periods/{month}/checklist` · needs `payment:read`
   */
  monthCloseChecklist(params: {
    /** YYYY-MM. */
    month: string;
  }, options?: RequestOptions): Promise<MonthCloseChecklistResponse> {
    return this.transport.request<MonthCloseChecklistResponse>({ method: "GET", path: "/v1/finance/periods/{month}/checklist", pathParams: { month: params.month }, accept: "json" }, options);
  }

  /**
   * Month close evidence pack
   *
   * (v1.32.0) For the auditor: the steps with checks and sign-offs, the sign-off and lock history, each currency's trial balance and the month's finance actions from the audit log. Audited.
   *
   * `GET /v1/finance/close/{month}/evidence`
   */
  monthCloseEvidencePack(params: {
    /** YYYY-MM. */
    month: string;
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/finance/close/{month}/evidence", pathParams: { month: params.month }, accept: "text" }, options);
  }

  /**
   * A month's depreciation journal
   *
   * (v1.29.0) Per currency (default last month): depreciation by category, disposals (cost, accumulated, proceeds, gain or loss), the journal lines (Dr depreciation expense / Cr accumulated depreciation; disposals: Dr accumulated, Dr bank, Cr cost, gain or loss) with debit = credit, and whether the month is recorded (and changed since).
   *
   * `GET /v1/finance/assets/journal` · needs `payment:read`
   */
  monthDepreciationJournal(params?: {
    query?: {
      month?: string;
    };
  }, options?: RequestOptions): Promise<MonthDepreciationJournalResponse> {
    return this.transport.request<MonthDepreciationJournalResponse>({ method: "GET", path: "/v1/finance/assets/journal", query: params?.query, accept: "json" }, options);
  }

  /**
   * A month's lease journal
   *
   * (v1.30.0) Per currency (default last month): recognition at commencement, ROU depreciation, interest, payments, exempt leases' expense, early ends with the gain or loss; the lines (debit = credit) and whether the month is recorded.
   *
   * `GET /v1/finance/leases/journal`
   */
  monthLeaseJournal(params?: {
    query?: {
      month?: string;
    };
  }, options?: RequestOptions): Promise<MonthLeaseJournalResponse> {
    return this.transport.request<MonthLeaseJournalResponse>({ method: "GET", path: "/v1/finance/leases/journal", query: params?.query, accept: "json" }, options);
  }

  /**
   * Month locks
   *
   * (v1.22.0) The last 24 months: locked or open, whether they can be locked (ended), who locked them, and each lock's history (reopened by whom and why).
   *
   * `GET /v1/finance/periods` · needs `payment:read`
   */
  monthLocks(options?: RequestOptions): Promise<MonthLocksResponse> {
    return this.transport.request<MonthLocksResponse>({ method: "GET", path: "/v1/finance/periods", accept: "json" }, options);
  }

  /**
   * Monthly controls report
   *
   * (v1.25.0) A workbook for the month: the controls, the findings, the change log and the actions per person. Audited.
   *
   * `GET /v1/finance/controls/report` · needs `audit:read`
   */
  monthlyControlsReport(params?: {
    query?: {
      month?: string;
    };
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/finance/controls/report", query: params?.query, accept: "text" }, options);
  }

  /**
   * My commission terms per currency
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `GET /v1/roaming/hub/clearing/fee-plans` · needs `roaming:read`
   */
  myCommissionTermsPerCurrency(options?: RequestOptions): Promise<MyCommissionTermsPerCurrencyResponse> {
    return this.transport.request<MyCommissionTermsPerCurrencyResponse>({ method: "GET", path: "/v1/roaming/hub/clearing/fee-plans", accept: "json" }, options);
  }

  /**
   * My disputes (both sides)
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `GET /v1/roaming/hub/clearing/disputes` · needs `roaming:read`
   */
  myDisputesBothSides(params?: {
    query?: {
      status?: string;
      side?: "cpo" | "emsp";
    };
  }, options?: RequestOptions): Promise<MyDisputesBothSidesResponse> {
    return this.transport.request<MyDisputesBothSidesResponse>({ method: "GET", path: "/v1/roaming/hub/clearing/disputes", query: params?.query, accept: "json" }, options);
  }

  /**
   * My fee invoice as PDF
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `GET /v1/roaming/hub/clearing/fee-invoices/{id}/pdf` · needs `roaming:read`
   */
  myFeeInvoiceAsPdf(params: {
    id: string;
  }, options?: RequestOptions): Promise<ArrayBuffer> {
    return this.transport.request<ArrayBuffer>({ method: "GET", path: "/v1/roaming/hub/clearing/fee-invoices/{id}/pdf", pathParams: { id: params.id }, accept: "binary" }, options);
  }

  /**
   * My fee invoice as printable HTML
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `GET /v1/roaming/hub/clearing/fee-invoices/{id}/html` · needs `roaming:read`
   */
  myFeeInvoiceAsPrintableHtml(params: {
    id: string;
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/roaming/hub/clearing/fee-invoices/{id}/html", pathParams: { id: params.id }, accept: "text" }, options);
  }

  /**
   * My finance digest
   *
   * (v1.27.0) The caller's digest subscription (frequency off, daily or weekly; channels e-mail and/or WhatsApp; sections; hour; weekday), the last sends, and the organisation's WhatsApp template for digests. Digests are for console users: called with an API key, the subscription is off, there are no sends, and consoleUsersOnly is true.
   *
   * `GET /v1/finance/digest` · needs `payment:read`
   */
  myFinanceDigest(options?: RequestOptions): Promise<MyFinanceDigestResponse> {
    return this.transport.request<MyFinanceDigestResponse>({ method: "GET", path: "/v1/finance/digest", accept: "json" }, options);
  }

  /**
   * My hub CDRs (both sides)
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `GET /v1/roaming/hub/clearing/cdrs` · needs `roaming:read`
   */
  myHubCDRsBothSides(params?: {
    query?: {
      /** one or more, comma-separated */
      status?: string;
      flag?: string;
      currency?: string;
      agreement?: string;
      run?: string;
      unsettled?: boolean;
      from?: string;
      to?: string;
      /** CDR or session id contains */
      q?: string;
      /** next_cursor of the previous page */
      cursor?: string;
      limit?: number;
      side?: "cpo" | "emsp";
    };
  }, options?: RequestOptions): Promise<MyHubCDRsBothSidesResponse> {
    return this.transport.request<MyHubCDRsBothSidesResponse>({ method: "GET", path: "/v1/roaming/hub/clearing/cdrs", query: params?.query, accept: "json" }, options);
  }

  /**
   * My hub clearing summary
   *
   * Membership, ledger counts per side/currency/status, open disputes, outstanding positions, own bank details.
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `GET /v1/roaming/hub/clearing/summary` · needs `roaming:read`
   */
  myHubClearingSummary(options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/roaming/hub/clearing/summary", accept: "json" }, options);
  }

  /**
   * My hub fee invoices
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `GET /v1/roaming/hub/clearing/fee-invoices` · needs `roaming:read`
   */
  myHubFeeInvoices(params?: {
    query?: {
      status?: string;
    };
  }, options?: RequestOptions): Promise<MyHubFeeInvoicesResponse> {
    return this.transport.request<MyHubFeeInvoicesResponse>({ method: "GET", path: "/v1/roaming/hub/clearing/fee-invoices", query: params?.query, accept: "json" }, options);
  }

  /**
   * My hub statements
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `GET /v1/roaming/hub/clearing/statements` · needs `roaming:read`
   */
  myHubStatements(params?: {
    query?: {
      currency?: string;
      period?: string;
    };
  }, options?: RequestOptions): Promise<MyHubStatementsResponse> {
    return this.transport.request<MyHubStatementsResponse>({ method: "GET", path: "/v1/roaming/hub/clearing/statements", query: params?.query, accept: "json" }, options);
  }

  /**
   * My settlement positions
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `GET /v1/roaming/hub/clearing/positions` · needs `roaming:read`
   */
  mySettlementPositions(params?: {
    query?: {
      status?: string;
      currency?: string;
      run?: string;
    };
  }, options?: RequestOptions): Promise<MySettlementPositionsResponse> {
    return this.transport.request<MySettlementPositionsResponse>({ method: "GET", path: "/v1/roaming/hub/clearing/positions", query: params?.query, accept: "json" }, options);
  }

  /**
   * My statement as PDF
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `GET /v1/roaming/hub/clearing/statements/{id}/pdf` · needs `roaming:read`
   */
  myStatementAsPdf(params: {
    id: string;
  }, options?: RequestOptions): Promise<ArrayBuffer> {
    return this.transport.request<ArrayBuffer>({ method: "GET", path: "/v1/roaming/hub/clearing/statements/{id}/pdf", pathParams: { id: params.id }, accept: "binary" }, options);
  }

  /**
   * My statement as printable HTML
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `GET /v1/roaming/hub/clearing/statements/{id}/html` · needs `roaming:read`
   */
  myStatementAsPrintableHtml(params: {
    id: string;
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/roaming/hub/clearing/statements/{id}/html", pathParams: { id: params.id }, accept: "text" }, options);
  }

  /**
   * My statement's CDRs as CSV
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `GET /v1/roaming/hub/clearing/statements/{id}/csv` · needs `roaming:read`
   */
  myStatementCDRsAsCsv(params: {
    id: string;
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/roaming/hub/clearing/statements/{id}/csv", pathParams: { id: params.id }, accept: "text" }, options);
  }

  /**
   * The native apps’ version gate and remote configuration
   *
   * **Permissions checked:** `org:read`.
   *
   * `GET /v1/driver-app/app-config` · needs `org:read`
   */
  nativeAppsVersionGateAndRemoteConfiguration(options?: RequestOptions): Promise<NativeAppsVersionGateAndRemoteConfigurationResponse> {
    return this.transport.request<NativeAppsVersionGateAndRemoteConfigurationResponse>({ method: "GET", path: "/v1/driver-app/app-config", accept: "json" }, options);
  }

  /**
   * One of my hub CDRs
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `GET /v1/roaming/hub/clearing/cdrs/{id}` · needs `roaming:read`
   */
  oneOfMyHubCDRs(params: {
    id: string;
  }, options?: RequestOptions): Promise<OneOfMyHubCDRsResponse> {
    return this.transport.request<OneOfMyHubCDRsResponse>({ method: "GET", path: "/v1/roaming/hub/clearing/cdrs/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * One of my hub fee invoices
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `GET /v1/roaming/hub/clearing/fee-invoices/{id}` · needs `roaming:read`
   */
  oneOfMyHubFeeInvoices(params: {
    id: string;
  }, options?: RequestOptions): Promise<OneOfMyHubFeeInvoicesResponse> {
    return this.transport.request<OneOfMyHubFeeInvoicesResponse>({ method: "GET", path: "/v1/roaming/hub/clearing/fee-invoices/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * One of my hub statements
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `GET /v1/roaming/hub/clearing/statements/{id}` · needs `roaming:read`
   */
  oneOfMyHubStatements(params: {
    id: string;
  }, options?: RequestOptions): Promise<OneOfMyHubStatementsResponse> {
    return this.transport.request<OneOfMyHubStatementsResponse>({ method: "GET", path: "/v1/roaming/hub/clearing/statements/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * One receivable's history
   *
   * (v1.20.0) kind: fleet_invoice or platform_statement. Notes and promises, reminders sent (or failed), write-offs.
   *
   * `GET /v1/finance/collections/{kind}/{ref}` · needs `payment:read`
   */
  oneReceivableHistory(params: {
    /** fleet_invoice or platform_statement. */
    kind: string;
    /** The invoice or statement id. */
    ref: string;
  }, options?: RequestOptions): Promise<OneReceivableHistoryResponse> {
    return this.transport.request<OneReceivableHistoryResponse>({ method: "GET", path: "/v1/finance/collections/{kind}/{ref}", pathParams: { kind: params.kind, ref: params.ref }, accept: "json" }, options);
  }

  /**
   * One WhatsApp support conversation
   *
   * The conversation and its last 200 messages, oldest first, with each reply's delivery status. Opening it marks it read.
   *
   * `GET /v1/whatsapp/conversations/{id}` · needs `platform:admin`
   */
  oneWhatsAppSupportConversation(params: {
    /** The conversation id. */
    id: string;
  }, options?: RequestOptions): Promise<OneWhatsAppSupportConversationResponse> {
    return this.transport.request<OneWhatsAppSupportConversationResponse>({ method: "GET", path: "/v1/whatsapp/conversations/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Open a credit review
   *
   * (v1.33.0) Scores the account now and suggests a limit. One open review per account. Audited.
   *
   * `POST /v1/finance/credit/accounts/{id}/reviews`
   */
  openCreditReview(params: {
    /** The id. */
    id: string;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/credit/accounts/{id}/reviews", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Open a work order
   *
   * (v1.34.0) Numbered WO-00001…. Audited.
   *
   * `POST /v1/finance/maintenance`
   */
  openWorkOrder(params: {
    body: OpenWorkOrderBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/maintenance", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * The operator’s console brand
   *
   * The name, tagline, colours, logo and web address the operator’s console uses instead of PlugSure’s, and the colours as the console applies them in both themes.
   *
   * `GET /v1/console-brand` · needs `org:read`
   */
  operatorConsoleBrand(options?: RequestOptions): Promise<ConsoleBrandResult> {
    return this.transport.request<ConsoleBrandResult>({ method: "GET", path: "/v1/console-brand", accept: "json" }, options);
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
   * Operators' statements to PlugSure
   *
   * Platform administrators: every operator's finalised statement to PlugSure (total due), what the operator paid (recorded), outstanding and status.
   *
   * `GET /v1/finance/operator-statements` · needs `platform:admin`
   */
  operatorsStatementsToPlugSure(params?: {
    query?: {
      status?: "due" | "partial" | "paid";
    };
  }, options?: RequestOptions): Promise<OperatorsStatementsToPlugSureResponse> {
    return this.transport.request<OperatorsStatementsToPlugSureResponse>({ method: "GET", path: "/v1/finance/operator-statements", query: params?.query, accept: "json" }, options);
  }

  /**
   * Owner payouts through Duitku Disbursement
   *
   * (v1.16.0) The organisation's owner payouts, newest first (at most 300); open=true: only those not settled.
   *
   * `GET /v1/finance/payout-transfers` · needs `payment:read`
   */
  ownerPayoutsThroughDuitkuDisbursement(params?: {
    query?: {
      open?: "true";
    };
  }, options?: RequestOptions): Promise<OwnerPayoutsThroughDuitkuDisbursementResponse> {
    return this.transport.request<OwnerPayoutsThroughDuitkuDisbursementResponse>({ method: "GET", path: "/v1/finance/payout-transfers", query: params?.query, accept: "json" }, options);
  }

  /**
   * Payables
   *
   * Refunds due on payments this account took (with the gateway's refund window and days left), (v1.15.0) for an operator's own account the PlugSure Hub settlement positions it owes, and site owners' shares on statements finalised in the last 120 days of the operators whose payments it took, with what was paid against each (recorded with POST /v1/finance/statements/:sid/payments).
   *
   * `GET /v1/finance/accounts/{id}/payables` · needs `payment:read`
   */
  payables(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
  }, options?: RequestOptions): Promise<PayablesResponse> {
    return this.transport.request<PayablesResponse>({ method: "GET", path: "/v1/finance/accounts/{id}/payables", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Payables (AP ageing)
   *
   * (v1.29.0) Approved bills not paid in full, per currency: total, overdue, by age from the due date (current, 1-30, 31-60, 61-90, 90+) and by supplier; what falls due in the next 14 days; what is overdue; bills awaiting approval. format=xlsx for a workbook.
   *
   * `GET /v1/finance/payables` · needs `payment:read`
   */
  payablesApAgeing(params?: {
    query?: {
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<PayablesApAgeingResponse> {
    return this.transport.request<PayablesApAgeingResponse>({ method: "GET", path: "/v1/finance/payables", query: params?.query, accept: "json" }, options);
  }

  /**
   * Pay an invoice from the deposit
   *
   * (v1.24.0) A prepaid account's issued invoice, when the deposit covers what is owed on it: debited from the deposit and marked paid. Audited.
   *
   * `POST /v1/fleet-invoices/{id}/pay-from-deposit` · needs `invoice:write`
   */
  payInvoiceFromDeposit(params: {
    /** The invoice id. */
    id: string;
  }, options?: RequestOptions): Promise<PayInvoiceFromDepositResponse> {
    return this.transport.request<PayInvoiceFromDepositResponse>({ method: "POST", path: "/v1/fleet-invoices/{id}/pay-from-deposit", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Payment plans
   *
   * (v1.28.0) Instalment plans agreed with fleet customers, active first: each instalment due, paid, late.
   *
   * `GET /v1/finance/payment-plans` · needs `invoice:read`
   */
  paymentPlans(params?: {
    query?: {
      status?: "active" | "completed" | "defaulted" | "cancelled";
    };
  }, options?: RequestOptions): Promise<PaymentPlansResponse> {
    return this.transport.request<PaymentPlansResponse>({ method: "GET", path: "/v1/finance/payment-plans", query: params?.query, accept: "json" }, options);
  }

  /**
   * Payments accounts with finance data
   *
   * The gateway accounts the caller may see: its organisation's own Xendit account(s), and for platform administrators the platform's.
   *
   * `GET /v1/finance/accounts` · needs `payment:read`
   */
  paymentsAccountsWithFinanceData(options?: RequestOptions): Promise<PaymentsAccountsWithFinanceDataResponse> {
    return this.transport.request<PaymentsAccountsWithFinanceDataResponse>({ method: "GET", path: "/v1/finance/accounts", accept: "json" }, options);
  }

  /**
   * Payments on my positions
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `GET /v1/roaming/hub/clearing/payments` · needs `roaming:read`
   */
  paymentsOnMyPositions(params?: {
    query?: {
      position?: string;
    };
  }, options?: RequestOptions): Promise<PaymentsOnMyPositionsResponse> {
    return this.transport.request<PaymentsOnMyPositionsResponse>({ method: "GET", path: "/v1/roaming/hub/clearing/payments", query: params?.query, accept: "json" }, options);
  }

  /**
   * Payments recorded against a statement
   *
   * An owner statement of the caller's organisation, or (platform administrators) an operator's statement to PlugSure: what is due and paid, and every payment recorded, voided ones included.
   *
   * `GET /v1/finance/statements/{sid}/payments` · needs `payment:read`
   */
  paymentsRecordedAgainstStatement(params: {
    /** The statement id. */
    sid: string;
  }, options?: RequestOptions): Promise<PaymentsRecordedAgainstStatementResponse> {
    return this.transport.request<PaymentsRecordedAgainstStatementResponse>({ method: "GET", path: "/v1/finance/statements/{sid}/payments", pathParams: { sid: params.sid }, accept: "json" }, options);
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
   * Payroll
   *
   * (v1.33.0) The employees (salary, allowances, PTKP and TER category, BPJS, the last four digits of the bank account), the payroll runs and the BPJS caps.
   *
   * `GET /v1/finance/payroll`
   */
  payroll(options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/payroll", accept: "json" }, options);
  }

  /**
   * Payroll run
   *
   * (v1.33.0) The run with its lines and totals; format=xlsx for the workbook, transfers for the bank transfer list (CSV, payment:write, audited).
   *
   * `GET /v1/finance/payroll/runs/{id}`
   */
  payrollRun(params: {
    /** The id. */
    id: string;
    query?: {
      format?: "json" | "xlsx" | "transfers";
    };
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/payroll/runs/{id}", pathParams: { id: params.id }, query: params.query, accept: "json" }, options);
  }

  /**
   * Payslip
   *
   * (v1.33.0) One employee's payslip (PDF).
   *
   * `GET /v1/finance/payroll/runs/{id}/payslips/{lid}`
   */
  payslip(params: {
    /** The run. */
    id: string;
    /** The line. */
    lid: string;
  }, options?: RequestOptions): Promise<ArrayBuffer> {
    return this.transport.request<ArrayBuffer>({ method: "GET", path: "/v1/finance/payroll/runs/{id}/payslips/{lid}", pathParams: { id: params.id, lid: params.lid }, accept: "binary" }, options);
  }

  /**
   * Period by operator and site
   *
   * (v1.15.0) The accountant's month close: collected, payments, fees, VAT on fees, refunds and net from the gateway's ledger, attributed through PlugSure's payment to its session's site and operator (rows without one under site null); per operator also the site owners' shares on statements finalised for months starting in the period, and what was paid against them.
   *
   * `GET /v1/finance/accounts/{id}/breakdown` · needs `payment:read`
   */
  periodByOperatorAndSite(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
    query?: {
      /** First day (platform time zone). Default: the first of the current month. */
      from?: string;
      /** Last day, inclusive. Default: today. At most 400 days. */
      to?: string;
    };
  }, options?: RequestOptions): Promise<PeriodByOperatorAndSiteResponse> {
    return this.transport.request<PeriodByOperatorAndSiteResponse>({ method: "GET", path: "/v1/finance/accounts/{id}/breakdown", pathParams: { id: params.id }, query: params.query, accept: "json" }, options);
  }

  /**
   * Petty cash
   *
   * (v1.31.0) Cash accounts of kind cash: balance, float, the top-up to the float, the last count (total, difference, note).
   *
   * `GET /v1/finance/petty-cash`
   */
  pettyCash(options?: RequestOptions): Promise<PettyCashResponse> {
    return this.transport.request<PettyCashResponse>({ method: "GET", path: "/v1/finance/petty-cash", accept: "json" }, options);
  }

  /**
   * Place a time deposit
   *
   * (v1.30.0) cashAccountId (a bank account: the money leaves it), bankName, reference, principal, ratePct (a year), taxPct (final tax on the interest, default 20), placedOn (default today), and maturityOn, termMonths or termDays. Audited.
   *
   * `POST /v1/finance/treasury/deposits`
   */
  placeTimeDeposit(params: {
    body: PlaceTimeDepositBody;
  }, options?: RequestOptions): Promise<PlaceTimeDepositResponse> {
    return this.transport.request<PlaceTimeDepositResponse>({ method: "POST", path: "/v1/finance/treasury/deposits", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * PlugSure's platform-fee statements as e-Faktur XML
   *
   * (v1.18.0, platform administrators) A month's finalised platform-fee statements with PPN as Coretax's import XML: PlugSure (BILLING_ISSUER_NPWP) the seller, each operator (its NPWP) the buyer, PPN on DPP nilai lain. Operators without a valid NPWP are skipped (X-Efaktur-Skipped counts them). 409 without PlugSure's NPWP or with nothing to export. Audited as finance.platform_efaktur_exported.
   *
   * `GET /v1/finance/tax/platform-efaktur` · needs `platform:admin`
   */
  plugsurePlatformFeeStatementsAsEFakturXml(params: {
    query: {
      period: string;
      itemOpt: "A" | "B";
      itemCode: string;
      unitCode: string;
    };
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/finance/tax/platform-efaktur", query: params.query, accept: "text" }, options);
  }

  /**
   * PPh 23 withholding for a year
   *
   * (v1.18.0) Per month, the suggested base and 2% for the gateway's fees (the operator's own accounts) and for PlugSure's platform fee (its statements to the operator), with what was recorded and whether a bukti potong is missing; the records; for platform administrators, the withholdings operators recorded on PlugSure's fee. format=csv: the records, for the tax adviser. Finance prepares the figures; it files nothing.
   *
   * `GET /v1/finance/tax/pph23` · needs `payment:read`
   */
  pph23WithholdingForYear(params?: {
    query?: {
      year?: number;
      format?: "json" | "csv";
    };
  }, options?: RequestOptions): Promise<Pph23WithholdingForYearResponse> {
    return this.transport.request<Pph23WithholdingForYearResponse>({ method: "GET", path: "/v1/finance/tax/pph23", query: params?.query, accept: "json" }, options);
  }

  /**
   * PPN return (SPT Masa PPN)
   *
   * (v1.26.0) A tax period (default last month), rupiah: output (retail charge records not on a fleet invoice, fleet invoices less credit notes, paid memberships and passes), input (recorded faktur masukan, with suggestions for the gateway's and PlugSure's VAT), the overpayment brought forward, payable or carried forward, the due date, and the filing. format=xlsx (working papers), input-csv or output-csv.
   *
   * `GET /v1/finance/ppn` · needs `payment:read`
   */
  ppnReturnSptMasaPpn(params?: {
    query?: {
      month?: string;
      format?: "json" | "xlsx" | "input-csv" | "output-csv";
    };
  }, options?: RequestOptions): Promise<PpnReturnSptMasaPpnResponse> {
    return this.transport.request<PpnReturnSptMasaPpnResponse>({ method: "GET", path: "/v1/finance/ppn", query: params?.query, accept: "json" }, options);
  }

  /**
   * Preview the bank match rules
   *
   * (v1.32.0) The open lines each enabled rule would take; nothing is changed.
   *
   * `GET /v1/finance/bank-rules/preview`
   */
  previewBankMatchRules(options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/bank-rules/preview", accept: "json" }, options);
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
   * Price what-if
   *
   * (v1.35.0) A price change (changePct) on one row (dimension totals, tariff, connector, band or site; key; currency) with an elasticity (default the observed one): the volume, revenue, cost and margin after.
   *
   * `POST /v1/finance/pricing/what-if`
   */
  priceWhatIf(params: {
    body: PriceWhatIfBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/pricing/what-if", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Pricing profitability
   *
   * (v1.35.0) Over the last n months (months, default 3; siteId): sessions, kWh, revenue, energy cost, margin, price and cost per kWh by tariff, connector type, time band and site; the price elasticity observed. format=xlsx.
   *
   * `GET /v1/finance/pricing`
   */
  pricingProfitability(params?: {
    query?: {
      months?: number;
      siteId?: string;
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/pricing", query: params?.query, accept: "json" }, options);
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
      /** The statement's currency: IDR (default), MYR or SGD. An account charging in several currencies has one statement and invoice per currency. */
      currency?: "IDR" | "MYR" | "SGD";
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
   * A purchase order
   *
   * (v1.30.0) The order with its lines (ordered, received, outstanding), receipts, the bills on it and the three-way match (ordered, received, billed, status matched, not_received, over_billed or over_ordered).
   *
   * `GET /v1/finance/purchase-orders/{id}`
   */
  purchaseOrder(params: {
    /** The purchase order id. */
    id: string;
  }, options?: RequestOptions): Promise<PurchaseOrderResponse> {
    return this.transport.request<PurchaseOrderResponse>({ method: "GET", path: "/v1/finance/purchase-orders/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Purchase orders
   *
   * (v1.30.0) Orders (awaiting approval first), filtered by status: supplier, site, currency, ordered, received (quantity received × unit price), billed, still to bill; the commitments (approved orders not billed in full) per currency and supplier; the match tolerance. format=xlsx for a workbook.
   *
   * `GET /v1/finance/purchase-orders`
   */
  purchaseOrders(params?: {
    query?: {
      status?: string;
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<PurchaseOrdersResponse> {
    return this.transport.request<PurchaseOrdersResponse>({ method: "GET", path: "/v1/finance/purchase-orders", query: params?.query, accept: "json" }, options);
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
   * Raise a purchase order
   *
   * (v1.30.0) supplierId, description, siteId (or currency), expectedOn, lines (1–50: description, quantity, unitPrice in the minor unit), draft (true to keep it as a draft; otherwise it is submitted for approval). Numbered PO-00001…. Audited.
   *
   * `POST /v1/finance/purchase-orders`
   */
  raisePurchaseOrder(params: {
    body: RaisePurchaseOrderBody;
  }, options?: RequestOptions): Promise<RaisePurchaseOrderResponse> {
    return this.transport.request<RaisePurchaseOrderResponse>({ method: "POST", path: "/v1/finance/purchase-orders", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * A receipt
   *
   * (v1.31.0) The receipt file (an image or a PDF).
   *
   * `GET /v1/finance/expenses/receipts/{rid}` · needs `payment:write`
   */
  receipt(params: {
    /** The receipt id. */
    rid: string;
  }, options?: RequestOptions): Promise<Blob> {
    return this.transport.request<Blob>({ method: "GET", path: "/v1/finance/expenses/receipts/{rid}", pathParams: { rid: params.rid }, accept: "json" }, options);
  }

  /**
   * Receivables
   *
   * Collected and not yet settled to the bank: totals by expected settlement day (overdue flagged) and the rows; for an operator's own account, its fleet invoices issued and not paid. (v1.15.0) Also post-pay sessions not charged yet; for the platform's account PlugSure Hub's unpaid fee invoices, for an operator's the Hub settlement positions it is owed (hubPositions).
   *
   * `GET /v1/finance/accounts/{id}/receivables` · needs `payment:read`
   */
  receivables(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
  }, options?: RequestOptions): Promise<ReceivablesResponse> {
    return this.transport.request<ReceivablesResponse>({ method: "GET", path: "/v1/finance/accounts/{id}/receivables", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Recharge a group entity
   *
   * (v1.31.0) toOrgId (another entity of the group), month, description, amount, currency, draft (true to issue later). Numbered IC-00001…. Audited.
   *
   * `POST /v1/finance/intercompany/recharges`
   */
  rechargeGroupEntity(params: {
    body: RechargeGroupEntityBody;
  }, options?: RequestOptions): Promise<RechargeGroupEntityResponse> {
    return this.transport.request<RechargeGroupEntityResponse>({ method: "POST", path: "/v1/finance/intercompany/recharges", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Recognise a month's breakage
   *
   * (v1.28.0) The unused balances of payments made in a month, past the breakage days, recognised as revenue; once per month and currency. Needs finance:approve. Audited.
   *
   * `POST /v1/finance/driver-funds/breakage` · needs `finance:approve`
   */
  recogniseMonthBreakage(params: {
    body: RecogniseMonthBreakageBody;
  }, options?: RequestOptions): Promise<RecogniseMonthBreakageResponse> {
    return this.transport.request<RecogniseMonthBreakageResponse>({ method: "POST", path: "/v1/finance/driver-funds/breakage", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Reconciliation exceptions
   *
   * Differences between the gateway's ledger and PlugSure over the last 35 days, open first. Found by the reconciliation every 6 hours (and on POST …/sync); one that is no longer found closes itself.
   *
   * `GET /v1/finance/accounts/{id}/exceptions` · needs `payment:read`
   */
  reconciliationExceptions(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
    query?: {
      state?: "open" | "resolved";
      limit?: number;
    };
  }, options?: RequestOptions): Promise<ReconciliationExceptionsResponse> {
    return this.transport.request<ReconciliationExceptionsResponse>({ method: "GET", path: "/v1/finance/accounts/{id}/exceptions", pathParams: { id: params.id }, query: params.query, accept: "json" }, options);
  }

  /**
   * Record an asset
   *
   * (v1.29.0) category (chargers, installation, grid, equipment, vehicles, it, other), description, siteId and chargePointId (optional), currency (taken from the site when there is one), cost and residual (minor unit, before PPN), acquiredOn, inService (YYYY-MM, default the month after), lifeMonths (1–360, default 96), method straight_line (default) or declining_balance with ratePct (a year; default double the straight-line rate), tag (default FA-00001…). Not in a locked month. Audited.
   *
   * `POST /v1/finance/assets` · needs `payment:write`
   */
  recordAsset(params: {
    body: RecordAssetBody;
  }, options?: RequestOptions): Promise<RecordAssetResponse> {
    return this.transport.request<RecordAssetResponse>({ method: "POST", path: "/v1/finance/assets", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a balance
   *
   * (v1.29.0) balance on onDate (default today; one per day, recording again replaces it), note. Audited.
   *
   * `POST /v1/finance/cash/accounts/{id}/balances` · needs `payment:write`
   */
  recordBalance(params: {
    /** The cash account id. */
    id: string;
    body: RecordBalanceBody;
  }, options?: RequestOptions): Promise<RecordBalanceResponse> {
    return this.transport.request<RecordBalanceResponse>({ method: "POST", path: "/v1/finance/cash/accounts/{id}/balances", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a chargeback
   *
   * (v1.36.0) paymentId or paymentRef, provider, caseRef, reason, reasonCode, amount (default what was captured), fee, receivedOn, respondBy (default 7 days). Audited.
   *
   * `POST /v1/finance/chargebacks`
   */
  recordChargeback(params: {
    body: RecordChargebackBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/chargebacks", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a clawback
   *
   * (v1.36.0) amount (at most what was received), onDate, note, conditionId. From the deferred balance first; the rest an expense; owed until repaid. Audited.
   *
   * `POST /v1/finance/grants/{id}/clawbacks`
   */
  recordClawback(params: {
    /** The id. */
    id: string;
    body: RecordClawbackBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/grants/{id}/clawbacks", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Record a customer deposit
   *
   * (v1.33.0) kind received, returned (at most what is held) or applied (to an issued invoice, for its whole amount; the invoice is paid); amount, currency, onDate, cashAccountId, reference, note. Audited.
   *
   * `POST /v1/finance/credit/accounts/{id}/deposits`
   */
  recordCustomerDeposit(params: {
    /** The id. */
    id: string;
    body: RecordCustomerDepositBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/credit/accounts/{id}/deposits", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a deposit top-up or adjustment
   *
   * (v1.24.0) Prepaid accounts: kind topup (amount above 0, the bank reference) or adjustment (a non-zero amount and a note). Audited.
   *
   * `POST /v1/fleet-accounts/{id}/credit/entries` · needs `invoice:write`
   */
  recordDepositTopUpOrAdjustment(params: {
    /** Fleet account id. */
    id: string;
    body: RecordDepositTopUpOrAdjustmentBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/fleet-accounts/{id}/credit/entries", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a drawdown
   *
   * (v1.34.0) amount (up to the undrawn facility), onDate, reference. Audited.
   *
   * `POST /v1/finance/lenders/loans/{id}/drawdowns`
   */
  recordDrawdown(params: {
    /** The id. */
    id: string;
    body: RecordDrawdownBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/lenders/loans/{id}/drawdowns", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a faktur masukan
   *
   * (v1.26.0) An input VAT invoice for a tax period: supplier (and NPWP), faktur number (once), date (not after the period), DPP and PPN (at most 12% of the DPP), creditable. A filed period needs amend. Audited.
   *
   * `POST /v1/finance/ppn/input-invoices` · needs `payment:write`
   */
  recordFakturMasukan(params: {
    body: RecordFakturMasukanBody;
  }, options?: RequestOptions): Promise<RecordFakturMasukanResponse> {
    return this.transport.request<RecordFakturMasukanResponse>({ method: "POST", path: "/v1/finance/ppn/input-invoices", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Record goods received
   *
   * (v1.30.0) Against an approved order: lines (lineId, quantity; never more than is outstanding), receivedOn (default today), note. Audited.
   *
   * `POST /v1/finance/purchase-orders/{id}/receipts`
   */
  recordGoodsReceived(params: {
    /** The purchase order id. */
    id: string;
    body: RecordGoodsReceivedBody;
  }, options?: RequestOptions): Promise<RecordGoodsReceivedResponse> {
    return this.transport.request<RecordGoodsReceivedResponse>({ method: "POST", path: "/v1/finance/purchase-orders/{id}/receipts", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record an intercompany elimination
   *
   * (v1.28.0) month, kind (revenue or cost), description, amount, currency: taken out of the group's figures. Audited.
   *
   * `POST /v1/finance/group/eliminations` · needs `payment:write`
   */
  recordIntercompanyElimination(params: {
    body: RecordIntercompanyEliminationBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/group/eliminations", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a lease
   *
   * (v1.30.0) description, siteId (or currency), supplierId, startMonth, termMonths, payment (each period), frequency (monthly, quarterly, yearly), timing (advance or arrears), ratePct (the discount rate a year), directCosts, exempt (short_term or low_value; a term of 12 months or less is short-term unless exempt is false). Not in a locked month. Audited.
   *
   * `POST /v1/finance/leases`
   */
  recordLease(params: {
    body: RecordLeaseBody;
  }, options?: RequestOptions): Promise<RecordLeaseResponse> {
    return this.transport.request<RecordLeaseResponse>({ method: "POST", path: "/v1/finance/leases", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a loan payment
   *
   * (v1.34.0) principal (up to the balance), interest, fees, onDate, reference. Audited.
   *
   * `POST /v1/finance/lenders/loans/{id}/payments`
   */
  recordLoanPayment(params: {
    /** The id. */
    id: string;
    body: RecordLoanPaymentBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/lenders/loans/{id}/payments", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a month's depreciation
   *
   * (v1.29.0) Keeps the month's depreciation, disposals and gain or loss per currency (recording again replaces it). The month has ended and is not locked. Audited.
   *
   * `POST /v1/finance/assets/journal/{month}/record` · needs `payment:write`
   */
  recordMonthDepreciation(params: {
    /** YYYY-MM. */
    month: string;
  }, options?: RequestOptions): Promise<RecordMonthDepreciationResponse> {
    return this.transport.request<RecordMonthDepreciationResponse>({ method: "POST", path: "/v1/finance/assets/journal/{month}/record", pathParams: { month: params.month }, accept: "json" }, options);
  }

  /**
   * Record a month's lease journal
   *
   * (v1.30.0) Keeps the month's lease entries per currency (again replaces them). The month has ended and is not locked. Audited.
   *
   * `POST /v1/finance/leases/journal/{month}/record`
   */
  recordMonthLeaseJournal(params: {
    /** YYYY-MM. */
    month: string;
  }, options?: RequestOptions): Promise<RecordMonthLeaseJournalResponse> {
    return this.transport.request<RecordMonthLeaseJournalResponse>({ method: "POST", path: "/v1/finance/leases/journal/{month}/record", pathParams: { month: params.month }, accept: "json" }, options);
  }

  /**
   * Record a month's provision
   *
   * (v1.28.0) The provision now, per currency, with the previous month's and the movement (Dr bad-debt expense / Cr allowance, or a release). Recording the month again replaces it. Audited.
   *
   * `POST /v1/finance/provision/{month}/record` · needs `payment:write`
   */
  recordMonthProvision(params: {
    /** YYYY-MM. */
    month: string;
  }, options?: RequestOptions): Promise<RecordMonthProvisionResponse> {
    return this.transport.request<RecordMonthProvisionResponse>({ method: "POST", path: "/v1/finance/provision/{month}/record", pathParams: { month: params.month }, accept: "json" }, options);
  }

  /**
   * Record a payment (as payer, or as payee: counts as confirmed)
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `POST /v1/roaming/hub/clearing/payments` · needs `roaming:write`
   */
  recordPaymentAsPayerOrAsPayeeCountsAsConfirmed(params: {
    body: RecordPaymentAsPayerOrAsPayeeCountsAsConfirmedBody;
  }, options?: RequestOptions): Promise<RecordPaymentAsPayerOrAsPayeeCountsAsConfirmedResponse> {
    return this.transport.request<RecordPaymentAsPayerOrAsPayeeCountsAsConfirmedResponse>({ method: "POST", path: "/v1/roaming/hub/clearing/payments", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Record a payment on a plan
   *
   * (v1.28.0) Pays the earliest unpaid instalments first; when all are paid, the invoice is marked paid and the plan completed. Audited.
   *
   * `POST /v1/finance/payment-plans/{id}/payments` · needs `invoice:write`
   */
  recordPaymentOnPlan(params: {
    /** The plan id. */
    id: string;
    body: RecordPaymentOnPlanBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/payment-plans/{id}/payments", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a payment to a supplier
   *
   * (v1.29.0) On an approved bill: amount (default the balance), paidOn (default today), method (bank_transfer, cash, card, other), reference, cashAccountId (same currency). When the payments reach the payable, the bill is paid. Bank transfers are candidates in bank reconciliation. Audited.
   *
   * `POST /v1/finance/bills/{id}/payments` · needs `payment:write`
   */
  recordPaymentToSupplier(params: {
    /** The bill id. */
    id: string;
    body: RecordPaymentToSupplierBody;
  }, options?: RequestOptions): Promise<RecordPaymentToSupplierResponse> {
    return this.transport.request<RecordPaymentToSupplierResponse>({ method: "POST", path: "/v1/finance/bills/{id}/payments", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a payout or statement payment
   *
   * Records a transfer the operator's bank made: to a site owner against an owner statement (finance.owner_payout_recorded), or from the operator to PlugSure against its statement (platform administrators; finance.platform_fee_recorded). amount is in the statement currency's minor units (rupiah: whole rupiah); more than is outstanding is refused; the statement must be finalised.
   *
   * `POST /v1/finance/statements/{sid}/payments` · needs `payment:write`
   */
  recordPayoutOrStatementPayment(params: {
    /** The statement id. */
    sid: string;
    body: RecordPayoutOrStatementPaymentBody;
  }, options?: RequestOptions): Promise<RecordPayoutOrStatementPaymentResponse> {
    return this.transport.request<RecordPayoutOrStatementPaymentResponse>({ method: "POST", path: "/v1/finance/statements/{sid}/payments", pathParams: { sid: params.sid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a payroll paid
   *
   * (v1.33.0) paidOn and cashAccountId (same currency). Audited.
   *
   * `POST /v1/finance/payroll/runs/{id}/pay`
   */
  recordPayrollPaid(params: {
    /** The id. */
    id: string;
    body: RecordPayrollPaidBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/payroll/runs/{id}/pay", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a PPh 23 withholding
   *
   * (v1.18.0) What the operator withheld from a payee: kind, period (YYYY-MM), counterparty (and NPWP), the base in rupiah, the rate in basis points (default 200 = 2%), the amount (default base × rate), the bukti potong once issued. payment:write; audited as finance.tax_withholding_recorded.
   *
   * `POST /v1/finance/tax/withholdings` · needs `payment:write`
   */
  recordPPh23Withholding(params: {
    body: RecordPPh23WithholdingBody;
  }, options?: RequestOptions): Promise<RecordPPh23WithholdingResponse> {
    return this.transport.request<RecordPPh23WithholdingResponse>({ method: "POST", path: "/v1/finance/tax/withholdings", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a PPN return as filed
   *
   * (v1.26.0) An ended period of a PKP: the figures as filed, with the NTPN when something is payable (or unpaid: true), and a reference. amend: true replaces a filed period while no later one is filed. The carried-forward overpayment feeds the next period. Audited.
   *
   * `POST /v1/finance/ppn/{month}/file` · needs `payment:write`
   */
  recordPpnReturnAsFiled(params: {
    /** YYYY-MM. */
    month: string;
    body: RecordPpnReturnAsFiledBody;
  }, options?: RequestOptions): Promise<RecordPpnReturnAsFiledResponse> {
    return this.transport.request<RecordPpnReturnAsFiledResponse>({ method: "POST", path: "/v1/finance/ppn/{month}/file", pathParams: { month: params.month }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record RECs bought
   *
   * (v1.35.0) registry, reference, vintage, mwh, price, currency, boughtOn, siteId (none: the portfolio), cashAccountId. Audited.
   *
   * `POST /v1/finance/carbon/recs`
   */
  recordRECsBought(params: {
    body: RecordRECsBoughtBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/carbon/recs", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Record a roaming settlement payment
   *
   * (v1.25.0) Money received from the partner (net positive) or paid to it (net negative), with the bank reference; more than is outstanding is refused. Matched on bank statements as roaming_payment. Audited.
   *
   * `POST /v1/finance/roaming/settlements/{id}/payments` · needs `payment:write`
   */
  recordRoamingSettlementPayment(params: {
    /** The settlement id. */
    id: string;
    body: RecordRoamingSettlementPaymentBody;
  }, options?: RequestOptions): Promise<RecordRoamingSettlementPaymentResponse> {
    return this.transport.request<RecordRoamingSettlementPaymentResponse>({ method: "POST", path: "/v1/finance/roaming/settlements/{id}/payments", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a shared cost
   *
   * (v1.23.0) The amount per month, in the minor unit of the sites' currency; siteIds (optional: all the currency's sites). 409 when monthFrom is locked. Audited.
   *
   * `POST /v1/finance/shared-costs` · needs `payment:write`
   */
  recordSharedCost(params: {
    body: RecordSharedCostBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/shared-costs", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a site's electricity bill
   *
   * (v1.20.0) One live bill per site and month (void it to replace it): the amount (taxes included), the kWh billed, the bill's reference. Audited as finance.energy_bill_recorded.
   *
   * `POST /v1/finance/sites/{sid}/energy-bills` · needs `payment:write`
   */
  recordSiteElectricityBill(params: {
    /** The site id. */
    sid: string;
    body: RecordSiteElectricityBillBody;
  }, options?: RequestOptions): Promise<RecordSiteElectricityBillResponse> {
    return this.transport.request<RecordSiteElectricityBillResponse>({ method: "POST", path: "/v1/finance/sites/{sid}/energy-bills", pathParams: { sid: params.sid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a site investment
   *
   * (v1.22.0) In the site's currency (minor unit). lifeMonths: the depreciation period (default 96). 409 when its month is locked. Audited as finance.investment_recorded.
   *
   * `POST /v1/finance/investments` · needs `payment:write`
   */
  recordSiteInvestment(params: {
    body: RecordSiteInvestmentBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/investments", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a stock move
   *
   * (v1.34.0) kind receipt (qty, unitCost, purchaseOrderId), issue (qty, workOrderId), transfer (qty, toLocationId) or adjust (countedQty, note); itemId, locationId, onDate. Never below zero at a location. Audited.
   *
   * `POST /v1/finance/inventory/moves`
   */
  recordStockMove(params: {
    body: RecordStockMoveBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/inventory/moves", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a supplier bill
   *
   * (v1.29.0) supplierId, number (the supplier's), category (energy, maintenance, rent, installation, equipment, connectivity, services, other), siteId, description, currency (default the site's, else the reporting currency), subtotal, vat (PPN), wht (PPh 23; default the supplier's rate × the subtotal), billDate, dueDate (default the date + the supplier's terms), capitalise with lifeMonths (installation, equipment or other: an asset on approval), draft (true to keep it as a draft; otherwise it is submitted for approval), purchaseOrderId ((v1.30.0) the approved order it is for: same supplier and currency). Not in a locked month. Audited.
   *
   * `POST /v1/finance/bills` · needs `payment:write`
   */
  recordSupplierBill(params: {
    body: RecordSupplierBillBody;
  }, options?: RequestOptions): Promise<RecordSupplierBillResponse> {
    return this.transport.request<RecordSupplierBillResponse>({ method: "POST", path: "/v1/finance/bills", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a tax registration in a country
   *
   * From the date given, sessions in that country are taxed by it; the registration in force there before ends that day (409 when the new date is not after its start). `registered: false` records that the organisation is not registered from that date. Malaysia: service tax is charged on EV charging only with `evChargingTaxable: true`. An Indonesian registration in force today also sets the organisation's PKP / NPWP. Audited.
   *
   * `POST /v1/org/tax-registrations` · needs `org:write`
   */
  recordTaxRegistrationInCountry(params: {
    body: RecordTaxRegistrationInCountryBody;
  }, options?: RequestOptions): Promise<OrgSettings> {
    return this.transport.request<OrgSettings>({ method: "POST", path: "/v1/org/tax-registrations", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record tax withheld from an owner's share
   *
   * (v1.27.0) On one of the owner's finalised statements: ratePct (up to 30), base (default the share), amount (default base × rate), the bukti potong number and date. Shown to the owner in the portal. Audited.
   *
   * `POST /v1/finance/owners/{oid}/withholdings` · needs `payment:write`
   */
  recordTaxWithheldFromOwnerShare(params: {
    /** The site owner id. */
    oid: string;
    body: RecordTaxWithheldFromOwnerShareBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/owners/{oid}/withholdings", pathParams: { oid: params.oid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Record a transfer between accounts
   *
   * (v1.29.0) fromAccountId, toAccountId (same currency), amount, onDate (default today), reference, note. Audited.
   *
   * `POST /v1/finance/cash/transfers` · needs `payment:write`
   */
  recordTransferBetweenAccounts(params: {
    body: RecordTransferBetweenAccountsBody;
  }, options?: RequestOptions): Promise<RecordTransferBetweenAccountsResponse> {
    return this.transport.request<RecordTransferBetweenAccountsResponse>({ method: "POST", path: "/v1/finance/cash/transfers", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Refund transfers through Duitku Disbursement
   *
   * (v1.15.0) The organisation's refund transfers, newest first (at most 300); open=true: only those not settled (awaiting approval, sending, sent).
   *
   * `GET /v1/refund-transfers` · needs `payment:read`
   */
  refundTransfersThroughDuitkuDisbursement(params?: {
    query?: {
      /** Only open transfers. */
      open?: "true";
    };
  }, options?: RequestOptions): Promise<RefundTransfersThroughDuitkuDisbursementResponse> {
    return this.transport.request<RefundTransfersThroughDuitkuDisbursementResponse>({ method: "GET", path: "/v1/refund-transfers", query: params?.query, accept: "json" }, options);
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
   * Reimburse an expense claim
   *
   * (v1.31.0) An approved claim from a cash account (petty cash or a bank, same currency): cashAccountId, reimbursedOn (default today), reference. The cash position counts it out of the account. Audited.
   *
   * `POST /v1/finance/expenses/{id}/reimburse`
   */
  reimburseExpenseClaim(params: {
    /** The claim id. */
    id: string;
    body: ReimburseExpenseClaimBody;
  }, options?: RequestOptions): Promise<ReimburseExpenseClaimResponse> {
    return this.transport.request<ReimburseExpenseClaimResponse>({ method: "POST", path: "/v1/finance/expenses/{id}/reimburse", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Reject an expense claim
   *
   * (v1.31.0) With a reason, by someone other than the claimant; it can be corrected and submitted again. Audited.
   *
   * `POST /v1/finance/expenses/{id}/reject`
   */
  rejectExpenseClaim(params: {
    /** The claim id. */
    id: string;
    body: RejectExpenseClaimBody;
  }, options?: RequestOptions): Promise<RejectExpenseClaimResponse> {
    return this.transport.request<RejectExpenseClaimResponse>({ method: "POST", path: "/v1/finance/expenses/{id}/reject", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Reject a journal entry
   *
   * (v1.31.0) With a reason, by someone other than the submitter. Audited.
   *
   * `POST /v1/finance/ledger/entries/{id}/reject`
   */
  rejectJournalEntry(params: {
    /** The entry id. */
    id: string;
    body: RejectJournalEntryBody;
  }, options?: RequestOptions): Promise<RejectJournalEntryResponse> {
    return this.transport.request<RejectJournalEntryResponse>({ method: "POST", path: "/v1/finance/ledger/entries/{id}/reject", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Reject an owner payout before it is sent
   *
   * (v1.16.0) Awaiting approval only, with a reason. Audited as finance.owner_payout_rejected.
   *
   * `POST /v1/finance/payout-transfers/{tid}/reject` · needs `payment:write`
   */
  rejectOwnerPayoutBeforeItIsSent(params: {
    /** The payout id. */
    tid: string;
    body: RejectOwnerPayoutBeforeItIsSentBody;
  }, options?: RequestOptions): Promise<RejectOwnerPayoutBeforeItIsSentResponse> {
    return this.transport.request<RejectOwnerPayoutBeforeItIsSentResponse>({ method: "POST", path: "/v1/finance/payout-transfers/{tid}/reject", pathParams: { tid: params.tid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Reject a purchase order
   *
   * (v1.30.0) With a reason, by someone other than the submitter. Audited.
   *
   * `POST /v1/finance/purchase-orders/{id}/reject`
   */
  rejectPurchaseOrder(params: {
    /** The purchase order id. */
    id: string;
    body: RejectPurchaseOrderBody;
  }, options?: RequestOptions): Promise<RejectPurchaseOrderResponse> {
    return this.transport.request<RejectPurchaseOrderResponse>({ method: "POST", path: "/v1/finance/purchase-orders/{id}/reject", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Reject a refund transfer before it is sent
   *
   * (v1.15.0) Awaiting approval only, with a reason (the requester withdrawing it, or another person refusing it). The refund is due again. Audited as refund.transfer_rejected.
   *
   * `POST /v1/refund-transfers/{tid}/reject` · needs `payment:write`
   */
  rejectRefundTransferBeforeItIsSent(params: {
    /** The transfer id. */
    tid: string;
    body: RejectRefundTransferBeforeItIsSentBody;
  }, options?: RequestOptions): Promise<RejectRefundTransferBeforeItIsSentResponse> {
    return this.transport.request<RejectRefundTransferBeforeItIsSentResponse>({ method: "POST", path: "/v1/refund-transfers/{tid}/reject", pathParams: { tid: params.tid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Reject a supplier bill
   *
   * (v1.29.0) With a reason, by someone other than the submitter; it can be corrected and submitted again. Audited.
   *
   * `POST /v1/finance/bills/{id}/reject` · needs `payment:write`
   */
  rejectSupplierBill(params: {
    /** The bill id. */
    id: string;
    body: RejectSupplierBillBody;
  }, options?: RequestOptions): Promise<RejectSupplierBillResponse> {
    return this.transport.request<RejectSupplierBillResponse>({ method: "POST", path: "/v1/finance/bills/{id}/reject", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Remove the Android notifications service account
   *
   * The Android app stops getting notifications; queued ones fail.
   *
   * `DELETE /v1/driver-app/fcm` · needs `org:write`
   */
  removeAndroidNotificationsServiceAccount(options?: RequestOptions): Promise<RemoveAndroidNotificationsServiceAccountResponse> {
    return this.transport.request<RemoveAndroidNotificationsServiceAccountResponse>({ method: "DELETE", path: "/v1/driver-app/fcm", accept: "json" }, options);
  }

  /**
   * Remove the console brand
   *
   * The console goes back to the PlugSure brand. Its web address, if any, then shows the PlugSure sign-in page and accepts any account again.
   *
   * `DELETE /v1/console-brand` · needs `org:write`
   */
  removeConsoleBrand(options?: RequestOptions): Promise<RemoveConsoleBrandResponse> {
    return this.transport.request<RemoveConsoleBrandResponse>({ method: "DELETE", path: "/v1/console-brand", accept: "json" }, options);
  }

  /**
   * Remove the console logo
   *
   * The console shows the product name’s initials on the brand colour instead.
   *
   * `DELETE /v1/console-brand/logo` · needs `org:write`
   */
  removeConsoleLogo(options?: RequestOptions): Promise<ConsoleBrandResult> {
    return this.transport.request<ConsoleBrandResult>({ method: "DELETE", path: "/v1/console-brand/logo", accept: "json" }, options);
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
   * The environment variables (or the default) apply again. A payments account is archived (its payments keep their webhook and refunds).
   *
   * `DELETE /v1/integrations/{kind}`
   */
  removeIntegrationConsoleSettings(params: {
    /** Integration: payments (the acquirer: QRIS, e-wallets, cards), payments_fallback (Duitku, when the acquirer does not answer), otp (driver sign-in codes), otp_fallback, pnc_pki (Plug & Charge PKI), map_tiles or ai_support (WhatsApp AI support, Claude). */
    kind: string;
    query?: {
      scope?: "org" | "platform";
      /** Payments: which country's account. */
      countryCode?: "ID" | "MY" | "SG";
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
   * Remove a line from a claim
   *
   * (v1.31.0) While a draft or rejected; by the claimant.
   *
   * `POST /v1/finance/expenses/{id}/lines/{lid}/remove`
   */
  removeLineFromClaim(params: {
    /** The claim id. */
    id: string;
    /** The line id. */
    lid: string;
  }, options?: RequestOptions): Promise<RemoveLineFromClaimResponse> {
    return this.transport.request<RemoveLineFromClaimResponse>({ method: "POST", path: "/v1/finance/expenses/{id}/lines/{lid}/remove", pathParams: { id: params.id, lid: params.lid }, accept: "json" }, options);
  }

  /**
   * Remove the OCPI party of a country
   *
   * Removes a non-home party; that country's sites are then published under the home party. Audited as roaming.party_removed.
   *
   * `DELETE /v1/roaming/parties/{country}` · needs `roaming:write`
   */
  removeOcpiPartyOfCountry(params: {
    /** ISO 3166-1 alpha-2. */
    country: string;
  }, options?: RequestOptions): Promise<RemoveOcpiPartyOfCountryResponse> {
    return this.transport.request<RemoveOcpiPartyOfCountryResponse>({ method: "DELETE", path: "/v1/roaming/parties/{country}", pathParams: { country: params.country }, accept: "json" }, options);
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
   * Renew a policy
   *
   * (v1.35.0) The next term from the old end (endOn, policyNo, premium, cover, excess, paidOn, cashAccountId to change). Audited.
   *
   * `POST /v1/finance/insurance/policies/{id}/renew`
   */
  renewPolicy(params: {
    /** The id. */
    id: string;
    body: RenewPolicyBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/insurance/policies/{id}/renew", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Reopen a locked month
   *
   * (v1.22.0) Needs finance:approve (403 otherwise) and a reason. Audited as finance.period_reopened.
   *
   * `POST /v1/finance/periods/{month}/reopen` · needs `payment:write`, `finance:approve`
   */
  reopenLockedMonth(params: {
    /** YYYY-MM. */
    month: string;
    body: ReopenLockedMonthBody;
  }, options?: RequestOptions): Promise<ReopenLockedMonthResponse> {
    return this.transport.request<ReopenLockedMonthResponse>({ method: "POST", path: "/v1/finance/periods/{month}/reopen", pathParams: { month: params.month }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Repay a clawback
   *
   * (v1.36.0) repaidOn, cashAccountId. Audited.
   *
   * `POST /v1/finance/grants/clawbacks/{cid}/repay`
   */
  repayClawback(params: {
    /** The id. */
    cid: string;
    body: RepayClawbackBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/grants/clawbacks/{cid}/repay", pathParams: { cid: params.cid }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Reply to a WhatsApp customer
   *
   * Sends a free-form text from the platform's number. Allowed within 24 hours of the customer's last message only (409 otherwise: WhatsApp then takes approved templates only). Staff take the conversation over (handler human; the assistant stops), except in draft mode when the assistant has it: sending its drafts keeps it drafting. 502 with Meta's reason when the send fails. Audited as whatsapp.support_reply.
   *
   * `POST /v1/whatsapp/conversations/{id}/reply` · needs `platform:admin`
   */
  replyToWhatsAppCustomer(params: {
    /** The conversation id. */
    id: string;
    body: ReplyToWhatsAppCustomerBody;
  }, options?: RequestOptions): Promise<ReplyToWhatsAppCustomerResponse> {
    return this.transport.request<ReplyToWhatsAppCustomerResponse>({ method: "POST", path: "/v1/whatsapp/conversations/{id}/reply", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Report a claim
   *
   * (v1.35.0) kind, incidentOn (inside the term), description, loss, workOrderId. Numbered CL-00001…. Audited.
   *
   * `POST /v1/finance/insurance/policies/{id}/claims`
   */
  reportClaim(params: {
    /** The id. */
    id: string;
    body: ReportClaimBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/insurance/policies/{id}/claims", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Report e-mail schedules
   *
   * (v1.21.0) The organisation's schedules (reports, weekly or monthly, recipients, the last send or error) and the reports offered.
   *
   * `GET /v1/finance/report-schedules` · needs `payment:read`
   */
  reportEMailSchedules(options?: RequestOptions): Promise<ReportEMailSchedulesResponse> {
    return this.transport.request<ReportEMailSchedulesResponse>({ method: "GET", path: "/v1/finance/report-schedules", accept: "json" }, options);
  }

  /**
   * Reporting currency and exchange rates
   *
   * (v1.21.0) The reporting currency, the currencies of the organisation's sites, and the monthly rates into the reporting currency (manual or ECB). month: one month.
   *
   * `GET /v1/finance/fx-rates` · needs `payment:read`
   */
  reportingCurrencyAndExchangeRates(params?: {
    query?: {
      month?: string;
    };
  }, options?: RequestOptions): Promise<ReportingCurrencyAndExchangeRatesResponse> {
    return this.transport.request<ReportingCurrencyAndExchangeRatesResponse>({ method: "GET", path: "/v1/finance/fx-rates", query: params?.query, accept: "json" }, options);
  }

  /**
   * Report pack
   *
   * (v1.32.0) The pack with its figures and commentary; format=pdf or xlsx for the files; (v1.36.0) format=slides for the board deck (16:9 PDF).
   *
   * `GET /v1/finance/report-packs/{id}`
   */
  reportPack(params: {
    /** The id. */
    id: string;
    query?: {
      format?: "json" | "pdf" | "xlsx" | "slides";
    };
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/report-packs/{id}", pathParams: { id: params.id }, query: params.query, accept: "json" }, options);
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
   * Request an owner payout through Duitku Disbursement
   *
   * (v1.16.0) For an owner statement due or part-paid, to the owner's saved bank account (it needs the bank code): Duitku's inquiry returns the holder's name, and the payout waits for a SECOND person's approval. amount (minor units) defaults to what is outstanding; never more. Paid only from the operator's OWN Duitku account. payment:write; audited as finance.owner_payout_requested.
   *
   * `POST /v1/finance/statements/{sid}/payout` · needs `payment:write`
   */
  requestOwnerPayoutThroughDuitkuDisbursement(params: {
    /** The owner statement id. */
    sid: string;
    body?: RequestOwnerPayoutThroughDuitkuDisbursementBody;
  }, options?: RequestOptions): Promise<RequestOwnerPayoutThroughDuitkuDisbursementResponse> {
    return this.transport.request<RequestOwnerPayoutThroughDuitkuDisbursementResponse>({ method: "POST", path: "/v1/finance/statements/{sid}/payout", pathParams: { sid: params.sid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Request the ready payouts now
   *
   * (v1.26.0) What the worker does hourly: a payout request for every ready statement, waiting for approval. Audited.
   *
   * `POST /v1/finance/owner-payouts/automation/run` · needs `payment:write`
   */
  requestReadyPayoutsNow(options?: RequestOptions): Promise<RequestReadyPayoutsNowResponse> {
    return this.transport.request<RequestReadyPayoutsNowResponse>({ method: "POST", path: "/v1/finance/owner-payouts/automation/run", accept: "json" }, options);
  }

  /**
   * Request a refund transfer through Duitku Disbursement
   *
   * (v1.15.0) For a due (or failed) refund of a Duitku payment whose account has Disbursement: the driver's bank account is checked by Duitku's inquiry (the holder's name the bank has) and the transfer waits for a SECOND person's approval. The refund is held (processing) meanwhile. Refused above the largest transfer allowed. payment:write; audited as refund.transfer_requested.
   *
   * `POST /v1/refunds/{id}/disbursement` · needs `payment:write`
   */
  requestRefundTransferThroughDuitkuDisbursement(params: {
    /** The payment id. */
    id: string;
    body: RequestRefundTransferThroughDuitkuDisbursementBody;
  }, options?: RequestOptions): Promise<RequestRefundTransferThroughDuitkuDisbursementResponse> {
    return this.transport.request<RequestRefundTransferThroughDuitkuDisbursementResponse>({ method: "POST", path: "/v1/refunds/{id}/disbursement", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Reset a user's two-step verification
   *
   * For a lost phone and recovery codes: removes the authenticator secret and every recovery code and ends every session of the user. Where two-step verification is required (administrators) the user sets it up again at next sign-in. Not on yourself; within your own authority only; a signed-in administrator only (403 `console_user_required` for an API key, v1.9.0). Audited.
   *
   * `POST /v1/users/{id}/reset-mfa` · needs `user:write`
   */
  resetUserTwoStepVerification(params: {
    /** User id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<ResetUserTwoStepVerificationResponse> {
    return this.transport.request<ResetUserTwoStepVerificationResponse>({ method: "POST", path: "/v1/users/{id}/reset-mfa", pathParams: { id: params.id }, accept: "json" }, options);
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
   * Resolve a reconciliation exception
   *
   * Closes an open exception with a note saying what was done. Audited as finance.exception_resolved.
   *
   * `POST /v1/finance/accounts/{id}/exceptions/{eid}/resolve` · needs `payment:write`
   */
  resolveReconciliationException(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
    /** The exception id. */
    eid: string;
    body: ResolveReconciliationExceptionBody;
  }, options?: RequestOptions): Promise<ResolveReconciliationExceptionResponse> {
    return this.transport.request<ResolveReconciliationExceptionResponse>({ method: "POST", path: "/v1/finance/accounts/{id}/exceptions/{eid}/resolve", pathParams: { id: params.id, eid: params.eid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Resume a suspended charge point
   *
   * Returns a suspended charge point to service: online if it is connected (and asked to boot again), otherwise offline, with any outage counted from now. 409 when it is not suspended. Audited as charge_point.resumed.
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
   * Retire RECs
   *
   * (v1.35.0) Against the month (YYYY-MM) of charging they cover; once. Audited.
   *
   * `POST /v1/finance/carbon/recs/{id}/retire`
   */
  retireRECs(params: {
    /** The id. */
    id: string;
    body: RetireRECsBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/carbon/recs/{id}/retire", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Revenue assurance
   *
   * (v1.34.0) A month's (default last month) findings: sessions not billed, billed at zero, with energy, meter or price out of line, signed values not verified, roaming without a charge record; billed, expected, gap and status; the leakage, recovered and written off per currency. format=xlsx.
   *
   * `GET /v1/finance/assurance`
   */
  revenueAssurance(params?: {
    query?: {
      month?: string;
      status?: string;
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/assurance", query: params?.query, accept: "json" }, options);
  }

  /**
   * Revenue drop alerts
   *
   * (v1.22.0) The settings (enabled, dropPct, minBaseline) and the site days found below their baseline (the same weekday's average over the 4 weeks before) in the last 90 days.
   *
   * `GET /v1/finance/revenue-alerts` · needs `payment:read`
   */
  revenueDropAlerts(options?: RequestOptions): Promise<RevenueDropAlertsResponse> {
    return this.transport.request<RevenueDropAlertsResponse>({ method: "GET", path: "/v1/finance/revenue-alerts", accept: "json" }, options);
  }

  /**
   * Reverse a journal entry
   *
   * (v1.31.0) A posted manual entry, on a date (default its own; an open month): the same lines with debits and credits swapped, posted. A module's entry is corrected in the module and synced again. Audited.
   *
   * `POST /v1/finance/ledger/entries/{id}/reverse`
   */
  reverseJournalEntry(params: {
    /** The entry id. */
    id: string;
    body: ReverseJournalEntryBody;
  }, options?: RequestOptions): Promise<ReverseJournalEntryResponse> {
    return this.transport.request<ReverseJournalEntryResponse>({ method: "POST", path: "/v1/finance/ledger/entries/{id}/reverse", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Review a finding
   *
   * (v1.30.0) decision dismiss (it is fine) or confirm (it needs action: raises finance.anomaly_confirmed), with a note of what was checked. Audited.
   *
   * `POST /v1/finance/checks/{id}/review`
   */
  reviewFinding(params: {
    /** The finding id. */
    id: string;
    body: ReviewFindingBody;
  }, options?: RequestOptions): Promise<ReviewFindingResponse> {
    return this.transport.request<ReviewFindingResponse>({ method: "POST", path: "/v1/finance/checks/{id}/review", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Review a revenue finding
   *
   * (v1.34.0) status recovered (recovered amount), written_off or dismissed (note), or open. Audited.
   *
   * `POST /v1/finance/assurance/findings/{id}`
   */
  reviewRevenueFinding(params: {
    /** The id. */
    id: string;
    body: ReviewRevenueFindingBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/assurance/findings/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * A roaming partner's month
   *
   * (v1.25.0) The figures with the charge records behind them, both sides; the settlement and its payments. format=csv for the records as CSV (to send to the partner).
   *
   * `GET /v1/finance/roaming/partners/{pid}` · needs `payment:read`
   */
  roamingPartnerMonth(params: {
    /** The OCPI partner id. */
    pid: string;
    query?: {
      month?: string;
      currency?: string;
      format?: "json" | "csv";
    };
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/roaming/partners/{pid}", pathParams: { pid: params.pid }, query: params.query, accept: "json" }, options);
  }

  /**
   * Roaming settlement
   *
   * (v1.25.0) For a month (default last month), per roaming partner (eMSP or CPO; not hubs) and currency: what it owes us (our charge records of its drivers), what we owe it (its accepted charge records of ours), net; the settlement if finalised, with what is received or paid and outstanding, and the drift (records that arrived later). format=csv for a CSV.
   *
   * `GET /v1/finance/roaming` · needs `payment:read`
   */
  roamingSettlement(params?: {
    query?: {
      month?: string;
      format?: "json" | "csv";
    };
  }, options?: RequestOptions): Promise<RoamingSettlementResponse> {
    return this.transport.request<RoamingSettlementResponse>({ method: "GET", path: "/v1/finance/roaming", query: params?.query, accept: "json" }, options);
  }

  /**
   * Rolling twelve-month forecast
   *
   * (v1.28.0) Per site: up to 24 months of history, a trend line over the last 12, seasonality from 13 months or more, the next 12 months of revenue, energy cost and margin under the scenario (growthPct a year, pricePct, energyPct), against the revenue budget; totals per currency. The scenario defaults to the saved one.
   *
   * `GET /v1/finance/rolling-forecast` · needs `payment:read`
   */
  rollingTwelveMonthForecast(params?: {
    query?: {
      growthPct?: number;
      pricePct?: number;
      energyPct?: number;
      alertPct?: number;
    };
  }, options?: RequestOptions): Promise<RollingTwelveMonthForecastResponse> {
    return this.transport.request<RollingTwelveMonthForecastResponse>({ method: "GET", path: "/v1/finance/rolling-forecast", query: params?.query, accept: "json" }, options);
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
   * Run the anomaly checks
   *
   * (v1.30.0) Runs every check now over the last 90 days (they also run daily): new findings are added, a reviewed finding keeps its review, an open finding whose condition is gone is cleared.
   *
   * `POST /v1/finance/checks/run`
   */
  runAnomalyChecks(options?: RequestOptions): Promise<RunAnomalyChecksResponse> {
    return this.transport.request<RunAnomalyChecksResponse>({ method: "POST", path: "/v1/finance/checks/run", accept: "json" }, options);
  }

  /**
   * Run a bank feed now
   *
   * (v1.32.0) Fetch from a few days before the last line: new lines land on a statement of the account (an upload of the same days does not double them), are matched, then the rules run. Audited.
   *
   * `POST /v1/finance/bank-feeds/{id}/run`
   */
  runBankFeedNow(params: {
    /** The id. */
    id: string;
  }, options?: RequestOptions): Promise<RunBankFeedNowResponse> {
    return this.transport.request<RunBankFeedNowResponse>({ method: "POST", path: "/v1/finance/bank-feeds/{id}/run", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Run fleet invoicing automation now
   *
   * (v1.27.0) What the worker does hourly: issue the month on the day, then send what is ready (with a payment link). Audited.
   *
   * `POST /v1/finance/fleet-automation/run` · needs `invoice:write`
   */
  runFleetInvoicingAutomationNow(options?: RequestOptions): Promise<RunFleetInvoicingAutomationNowResponse> {
    return this.transport.request<RunFleetInvoicingAutomationNowResponse>({ method: "POST", path: "/v1/finance/fleet-automation/run", accept: "json" }, options);
  }

  /**
   * Run revenue assurance
   *
   * (v1.34.0) Check a month's sessions now (month, default last month); findings found again keep their review. Audited.
   *
   * `POST /v1/finance/assurance/run`
   */
  runRevenueAssurance(params: {
    body: RunRevenueAssuranceBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/assurance/run", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Save the finance settings
   *
   * (v1.17.0) journalAccounts: codes (1–20 letters, digits, . - /) and names by key; closeEmail: enabled and up to 10 recipients (sent through the e-mail channel of the caller's organisation). payment:write; audited as finance.settings_saved.
   *
   * `PUT /v1/finance/accounts/{id}/settings` · needs `payment:write`
   */
  saveFinanceSettings(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
    body: SaveFinanceSettingsBody;
  }, options?: RequestOptions): Promise<SaveFinanceSettingsResponse> {
    return this.transport.request<SaveFinanceSettingsResponse>({ method: "PUT", path: "/v1/finance/accounts/{id}/settings", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Save the forecast scenario
   *
   * (v1.28.0) growthPct, pricePct, energyPct, and alertPct (the variance below budget that raises finance.forecast_below_budget, daily). Audited.
   *
   * `PUT /v1/finance/rolling-forecast/settings` · needs `payment:write`
   */
  saveForecastScenario(params: {
    body: SaveForecastScenarioBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/rolling-forecast/settings", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Save the loyalty program
   *
   * Switch loyalty on or off and set the earn rate, the value of a point, the most points may pay of a session and when points expire. Changes apply to sessions rated from now on; points already earned keep their expiry. Audited.
   *
   * `PUT /v1/loyalty` · needs `tariff:write`
   */
  saveLoyaltyProgram(params: {
    body: SaveLoyaltyProgramBody;
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
   * Sell carbon credits
   *
   * (v1.35.0) Issued credits only, up to what is available: buyer, tonnes, amount, currency, soldOn, cashAccountId, reference. Audited.
   *
   * `POST /v1/finance/carbon/credits/{id}/sales`
   */
  sellCarbonCredits(params: {
    /** The id. */
    id: string;
    body: SellCarbonCreditsBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/carbon/credits/{id}/sales", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Send a command to a charge point
   *
   * Generic command dispatcher; the named routes (remote-start, unlock, …) run the same code. Every command is written to the audit log with the caller. The configuration commands (get-configuration, change-configuration, get-diagnostics) also accept `charge_point:config`. A charger that is not connected makes the call fail with 500. Remote start answers 409 when the charge point is suspended, awaiting adoption or decommissioned, or when the connector’s meter verification (tera) has lapsed or is pending.
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
   * Send a month's close e-mail now
   *
   * (v1.17.0) The finance export (Excel and PDF) and the journal (Excel) for month (YYYY-MM, default last month) to the saved recipients, through the e-mail channel. 409 without an e-mail channel; 422 without recipients; 502 when the e-mail server refuses. Audited as finance.close_email_sent.
   *
   * `POST /v1/finance/accounts/{id}/close-email/send` · needs `payment:write`
   */
  sendMonthCloseEMailNow(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
    body?: SendMonthCloseEMailNowBody;
  }, options?: RequestOptions): Promise<SendMonthCloseEMailNowResponse> {
    return this.transport.request<SendMonthCloseEMailNowResponse>({ method: "POST", path: "/v1/finance/accounts/{id}/close-email/send", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Send my digest now
   *
   * (v1.27.0) The caller's digest, now, on their channels; the result per channel and the text.
   *
   * `POST /v1/finance/digest/send` · needs `payment:read`
   */
  sendMyDigestNow(options?: RequestOptions): Promise<SendMyDigestNowResponse> {
    return this.transport.request<SendMyDigestNowResponse>({ method: "POST", path: "/v1/finance/digest/send", accept: "json" }, options);
  }

  /**
   * Send a payment reminder now
   *
   * (v1.20.0) By e-mail (the fleet account's billing address, or `to`) or WhatsApp (its phone; needs the reminder template), through the organisation's channels. 502 when the channel refuses. Audited as finance.collection_reminder_sent.
   *
   * `POST /v1/finance/collections/{kind}/{ref}/remind` · needs `payment:write`
   */
  sendPaymentReminderNow(params: {
    /** fleet_invoice or platform_statement. */
    kind: string;
    /** The invoice or statement id. */
    ref: string;
    body?: SendPaymentReminderNowBody;
  }, options?: RequestOptions): Promise<SendPaymentReminderNowResponse> {
    return this.transport.request<SendPaymentReminderNowResponse>({ method: "POST", path: "/v1/finance/collections/{kind}/{ref}/remind", pathParams: { kind: params.kind, ref: params.ref }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Send a report e-mail now
   *
   * (v1.21.0) Through the e-mail channel, with the workbook attached. 409 without an e-mail channel; 502 when the server refuses. Audited as finance.report_sent.
   *
   * `POST /v1/finance/report-schedules/{rid}/send` · needs `payment:write`
   */
  sendReportEMailNow(params: {
    /** The schedule id. */
    rid: string;
  }, options?: RequestOptions): Promise<SendReportEMailNowResponse> {
    return this.transport.request<SendReportEMailNowResponse>({ method: "POST", path: "/v1/finance/report-schedules/{rid}/send", pathParams: { rid: params.rid }, accept: "json" }, options);
  }

  /**
   * Send a report pack
   *
   * (v1.32.0) E-mail the approved pack (PDF and Excel attached) to the recipients by the organisation's e-mail channel. Audited.
   *
   * `POST /v1/finance/report-packs/{id}/send`
   */
  sendReportPack(params: {
    /** The id. */
    id: string;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/report-packs/{id}/send", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Send a report pack back
   *
   * (v1.32.0) reason: back to draft (an approved pack takes finance:approve). Audited.
   *
   * `POST /v1/finance/report-packs/{id}/send-back`
   */
  sendReportPackBack(params: {
    /** The id. */
    id: string;
    body: SendReportPackBackBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/report-packs/{id}/send-back", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Send the scorecard now
   *
   * (v1.31.0) month (default last month) to the recipients by the organisation's e-mail channel. Audited.
   *
   * `POST /v1/finance/scorecard/send`
   */
  sendScorecardNow(params: {
    body: SendScorecardNowBody;
  }, options?: RequestOptions): Promise<SendScorecardNowResponse> {
    return this.transport.request<SendScorecardNowResponse>({ method: "POST", path: "/v1/finance/scorecard/send", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Send a WhatsApp test message
   *
   * Sends one approved template with the sign-in codes integration's credentials (recorded with purpose test). `params` fill the body variables in order; `copyCodeButton` repeats the first one for an Authentication template's copy-code button. At most 5 a minute per administrator. Audited as whatsapp.test_sent (number masked).
   *
   * `POST /v1/whatsapp/test` · needs `platform:admin`
   */
  sendWhatsAppTestMessage(params: {
    body: SendWhatsAppTestMessageBody;
  }, options?: RequestOptions): Promise<SendWhatsAppTestMessageResponse> {
    return this.transport.request<SendWhatsAppTestMessageResponse>({ method: "POST", path: "/v1/whatsapp/test", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the account counterparties pay into
   *
   * Sealed at rest; printed as the payment instruction on payers' statements.
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `PUT /v1/roaming/hub/clearing/bank-details` · needs `roaming:write`
   */
  setAccountCounterpartiesPayInto(params: {
    body: SetAccountCounterpartiesPayIntoBody;
  }, options?: RequestOptions): Promise<SetAccountCounterpartiesPayIntoResponse> {
    return this.transport.request<SetAccountCounterpartiesPayIntoResponse>({ method: "PUT", path: "/v1/roaming/hub/clearing/bank-details", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the allowed e-mail domains
   *
   * Up to 20 domain names; empty = any address of the tenant may be matched to a console user (not recommended). A signed-in administrator only: API keys are refused (403). Audited.
   *
   * `PUT /v1/auth/microsoft/tenant` · needs `user:write`
   */
  setAllowedEMailDomains(params: {
    body: SetAllowedEMailDomainsBody;
  }, options?: RequestOptions): Promise<SetAllowedEMailDomainsResponse> {
    return this.transport.request<SetAllowedEMailDomainsResponse>({ method: "PUT", path: "/v1/auth/microsoft/tenant", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the anomaly checks
   *
   * (v1.30.0) roundAmount (default 10 000 000), newSupplierAmount (default 50 000 000), newSupplierDays (default 30), disabled (the checks turned off). Needs finance:approve. Audited.
   *
   * `PUT /v1/finance/checks/settings` · needs `finance:approve`
   */
  setAnomalyChecks(params: {
    body: SetAnomalyChecksBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/checks/settings", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the approvals matrix
   *
   * (v1.21.0) Needs finance:approve (403 otherwise). Replaces the rules; a kind left out keeps only the second-person rule. Audited as finance.approval_rules_saved.
   *
   * `PUT /v1/finance/approval-rules` · needs `payment:write`, `finance:approve`
   */
  setApprovalsMatrix(params: {
    body: SetApprovalsMatrixBody;
  }, options?: RequestOptions): Promise<SetApprovalsMatrixResponse> {
    return this.transport.request<SetApprovalsMatrixResponse>({ method: "PUT", path: "/v1/finance/approval-rules", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the asset journal's accounts
   *
   * (v1.29.0) accounts: by key (cost, accumulated, expense, gain, loss, bank) a code and a name. Audited.
   *
   * `PUT /v1/finance/assets/accounts` · needs `payment:write`
   */
  setAssetJournalAccounts(params: {
    body: SetAssetJournalAccountsBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/assets/accounts", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set automatic owner payouts
   *
   * (v1.26.0) enabled, delayDays (0–60 after finalising), minAmount. The worker requests the payout hourly; it still waits for the approvals. Audited.
   *
   * `PUT /v1/finance/owner-payouts/automation` · needs `payment:write`
   */
  setAutomaticOwnerPayouts(params: {
    body: SetAutomaticOwnerPayoutsBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/owner-payouts/automation", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set automatic statements of account
   *
   * (v1.22.0) enabled; day 1–28: on that day of each month, every account with a billing address that had movements or owes something is e-mailed its statement for the month just ended. Audited.
   *
   * `PUT /v1/fleet-account-statements/settings` · needs `invoice:write`
   */
  setAutomaticStatementsOfAccount(params: {
    body: SetAutomaticStatementsOfAccountBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/fleet-account-statements/settings", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set a bill's stock and work order
   *
   * (v1.34.0) stock (the bill is for stock received: posted against goods received not invoiced), workOrderId (a contractor's bill for a work order; null to unlink). Audited.
   *
   * `POST /v1/finance/bills/{id}/links`
   */
  setBillStockAndWorkOrder(params: {
    /** The id. */
    id: string;
    body: SetBillStockAndWorkOrderBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/bills/{id}/links", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the breakage days
   *
   * (v1.28.0) breakageDays (30–1825, default 180): after how many days an unused balance is breakage. Audited.
   *
   * `PUT /v1/finance/driver-funds/settings` · needs `payment:write`
   */
  setBreakageDays(params: {
    body: SetBreakageDaysBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/driver-funds/settings", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the budget alert threshold
   *
   * (v1.20.0) From the 7th of the month, revenue below or energy cost above the pro-rated budget by more than this % raises finance.budget_off_track. Audited.
   *
   * `PUT /v1/finance/budgets/settings` · needs `payment:write`
   */
  setBudgetAlertThreshold(params: {
    body: SetBudgetAlertThresholdBody;
  }, options?: RequestOptions): Promise<SetBudgetAlertThresholdResponse> {
    return this.transport.request<SetBudgetAlertThresholdResponse>({ method: "PUT", path: "/v1/finance/budgets/settings", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the cash forecast
   *
   * (v1.33.0) horizonDays (30–180), collectionsPct (the default scenario), alert (the shortfall alert). Audited.
   *
   * `PUT /v1/finance/cash-forecast/settings`
   */
  setCashForecast(params: {
    body: SetCashForecastBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/cash-forecast/settings", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the close policy
   *
   * (v1.32.0) enforce: a month is locked only when every close step is signed off. finance:approve. Audited.
   *
   * `PUT /v1/finance/close/policy`
   */
  setClosePolicy(params: {
    body: SetClosePolicyBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/close/policy", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Set the controls' thresholds
   *
   * (v1.25.0) minApprovers (1–10, default 2) and workingHours ({ from, to } whole hours in the billing time zone, or null to not check). Needs finance:approve. Audited.
   *
   * `PUT /v1/finance/controls/settings` · needs `finance:approve`
   */
  setControlsThresholds(params: {
    body: SetControlsThresholdsBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/controls/settings", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the digest WhatsApp template
   *
   * (v1.27.0) whatsappTemplate { name, lang } (an approved template with one parameter, the digest text), or null. Audited.
   *
   * `PUT /v1/finance/digest/settings` · needs `payment:write`
   */
  setDigestWhatsAppTemplate(params: {
    body: SetDigestWhatsAppTemplateBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/digest/settings", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the driver refund policy
   *
   * (v1.24.0) enabled (drivers can ask in the app); autoApproveUpTo (minor unit; unused balance and failed charges up to it are approved at once; 0: review all); windowDays (1–365). Audited.
   *
   * `PUT /v1/finance/driver-refunds/policy` · needs `payment:write`
   */
  setDriverRefundPolicy(params: {
    body: SetDriverRefundPolicyBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/driver-refunds/policy", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the emission factors
   *
   * (v1.35.0) gridKgPerKwh (the grid's kg CO2e per kWh) and iceKgPerKwh (a petrol car's kg CO2e for the distance of one kWh). Audited.
   *
   * `PUT /v1/finance/carbon/settings`
   */
  setEmissionFactors(params: {
    body: SetEmissionFactorsBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/carbon/settings", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Set the expense policy
   *
   * (v1.31.0) receiptAbove (a line at or above it needs its receipt; default 100 000), limits by category (a line above its limit needs a Finance Manager). Needs finance:approve. Audited.
   *
   * `PUT /v1/finance/expenses/policy` · needs `finance:approve`
   */
  setExpensePolicy(params: {
    body: SetExpensePolicyBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/expenses/policy", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the finance data export
   *
   * (v1.24.0) enabled (nightly, for the day before); target local or s3 (endpoint, region, bucket, accessKeyId, secretAccessKey: kept sealed, leave empty to keep); format csv or ndjson (gzipped); prefix. Audited.
   *
   * `PUT /v1/finance/warehouse/settings` · needs `payment:write`
   */
  setFinanceDataExport(params: {
    body: SetFinanceDataExportBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/warehouse/settings", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set a fleet account's credit limit or prepay
   *
   * (v1.24.0) mode none, credit (limit) or prepaid (deposit); currency; block (the cards while over); autoApply (pay issued invoices from the deposit). Checked at once. Audited.
   *
   * `PUT /v1/fleet-accounts/{id}/credit` · needs `invoice:write`
   */
  setFleetAccountCreditLimitOrPrepay(params: {
    /** Fleet account id. */
    id: string;
    body: SetFleetAccountCreditLimitOrPrepayBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/fleet-accounts/{id}/credit", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set fleet invoicing automation
   *
   * (v1.27.0) autoIssue with issueDay (1–28), autoSend, requireEfaktur, paymentLinks (needs the operator's own Xendit account), linkDays. Audited.
   *
   * `PUT /v1/finance/fleet-automation` · needs `invoice:write`
   */
  setFleetInvoicingAutomation(params: {
    body: SetFleetInvoicingAutomationBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/fleet-automation", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set a grant condition
   *
   * (v1.36.0) status pending, met (metOn), breached or waived (a note). Audited.
   *
   * `POST /v1/finance/grants/conditions/{cid}`
   */
  setGrantCondition(params: {
    /** The id. */
    cid: string;
    body: SetGrantConditionBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/grants/conditions/{cid}", pathParams: { cid: params.cid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the KPI targets
   *
   * (v1.31.0) targets by KPI (empty leaves it), copyFrom (a month whose targets to start from). Audited.
   *
   * `PUT /v1/finance/scorecard/targets/{month}`
   */
  setKpiTargets(params: {
    /** YYYY-MM. */
    month: string;
    body: SetKpiTargetsBody;
  }, options?: RequestOptions): Promise<SetKpiTargetsResponse> {
    return this.transport.request<SetKpiTargetsResponse>({ method: "PUT", path: "/v1/finance/scorecard/targets/{month}", pathParams: { month: params.month }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the match tolerance
   *
   * (v1.30.0) tolerancePct (0–25, default 2): how far bills may exceed what was received before the three-way match fails. Needs finance:approve. Audited.
   *
   * `PUT /v1/finance/purchase-orders/settings` · needs `finance:approve`
   */
  setMatchTolerance(params: {
    body: SetMatchToleranceBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/purchase-orders/settings", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set a month's budget
   *
   * (v1.20.0) For the organisation (currency) or a site (siteId; revenue and energy cost only), in the currency's minor unit. Replaces what was there. Audited as finance.budget_saved.
   *
   * `PUT /v1/finance/budgets` · needs `payment:write`
   */
  setMonthBudget(params: {
    body: SetMonthBudgetBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/budgets", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set a month's exchange rate
   *
   * (v1.21.0) How many units of the reporting currency one unit of `currency` is worth for the month. Audited as finance.fx_rate_saved.
   *
   * `PUT /v1/finance/fx-rates` · needs `payment:write`
   */
  setMonthExchangeRate(params: {
    body: SetMonthExchangeRateBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/fx-rates", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the OCPI party of a country
   *
   * Adds or updates the party under which the operator publishes its sites in another country (MY, SG). The home party is set with PUT /v1/roaming/party. All parties are listed in our OCPI credentials (one CPO role each). Audited as roaming.party_set.
   *
   * `PUT /v1/roaming/parties/{country}` · needs `roaming:write`
   */
  setOcpiPartyOfCountry(params: {
    /** ISO 3166-1 alpha-2: ID, MY or SG. */
    country: string;
    body: SetOcpiPartyOfCountryBody;
  }, options?: RequestOptions): Promise<SetOcpiPartyOfCountryResponse> {
    return this.transport.request<SetOcpiPartyOfCountryResponse>({ method: "PUT", path: "/v1/roaming/parties/{country}", pathParams: { country: params.country }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set an owner's payout rule
   *
   * (v1.26.0) automatic (true, false, or null for the default), minAmount (null for the default), hold with holdReason. Audited.
   *
   * `PUT /v1/finance/owner-payouts/automation/owners/{oid}` · needs `payment:write`
   */
  setOwnerPayoutRule(params: {
    /** The site owner id. */
    oid: string;
    body: SetOwnerPayoutRuleBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/owner-payouts/automation/owners/{oid}", pathParams: { oid: params.oid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the payroll rules
   *
   * (v1.33.0) kesCap (BPJS Kesehatan wage cap), jpCap (JP wage cap), ter (replacement TER tables { A|B|C: [[upTo or null, ratePct], …] }, null for the built-in ones). finance:approve. Audited.
   *
   * `PUT /v1/finance/payroll/settings`
   */
  setPayrollRules(params: {
    body: SetPayrollRulesBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/payroll/settings", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the petty cash float
   *
   * (v1.31.0) float (the imprest a top-up brings it back to; empty for none). Audited.
   *
   * `PUT /v1/finance/petty-cash/{id}/float`
   */
  setPettyCashFloat(params: {
    /** The cash account id. */
    id: string;
    body: SetPettyCashFloatBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/petty-cash/{id}/float", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the provision rates
   *
   * (v1.28.0) A rate (0–100 %) per bucket: current, 1-30, 31-60, 61-90, 90+; older buckets at least as high. Needs finance:approve. Audited.
   *
   * `PUT /v1/finance/provision/rates` · needs `finance:approve`
   */
  setProvisionRates(params: {
    body: SetProvisionRatesBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/provision/rates", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the reminder schedule
   *
   * (v1.20.0) enabled; steps (days from the due date, -30 to 365; the latest reached is sent once); channels (email, whatsapp); whatsappTemplate { name, lang } with three parameters (customer, document and amount, due date). Audited as finance.dunning_settings_saved.
   *
   * `PUT /v1/finance/collections/settings` · needs `payment:write`
   */
  setReminderSchedule(params: {
    body: SetReminderScheduleBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/collections/settings", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the reporting currency
   *
   * (v1.21.0) ISO code, or null to stop consolidating. Audited as finance.reporting_currency_saved.
   *
   * `PUT /v1/finance/fx-rates/reporting-currency` · needs `payment:write`
   */
  setReportingCurrency(params: {
    body: SetReportingCurrencyBody;
  }, options?: RequestOptions): Promise<SetReportingCurrencyResponse> {
    return this.transport.request<SetReportingCurrencyResponse>({ method: "PUT", path: "/v1/finance/fx-rates/reporting-currency", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the report pack recipients
   *
   * (v1.32.0) recipients: up to 20 e-mail addresses the approved pack is sent to. Audited.
   *
   * `PUT /v1/finance/report-packs/settings`
   */
  setReportPackRecipients(params: {
    body: SetReportPackRecipientsBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/report-packs/settings", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set revenue drop alerts
   *
   * (v1.22.0) enabled; dropPct 10–100 (default 50); minBaseline: the smallest baseline compared (minor unit). Audited.
   *
   * `PUT /v1/finance/revenue-alerts/settings` · needs `payment:write`
   */
  setRevenueDropAlerts(params: {
    body: SetRevenueDropAlertsBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/revenue-alerts/settings", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Set the scorecard e-mail
   *
   * (v1.31.0) enabled, day of the month (1–28), recipients (up to 20 e-mail addresses), amberPct (the band, default 10). Audited.
   *
   * `PUT /v1/finance/scorecard/settings`
   */
  setScorecardEMail(params: {
    body: SetScorecardEMailBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/scorecard/settings", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Set settlement tracking
   *
   * (v1.23.0) graceDays (0–14, default 2): a settlement is late after them; withdrawalDays (1–14, default 3): a withdrawal is missing when bank statements cover that many days after it. Audited.
   *
   * `PUT /v1/finance/settlement-tracking/settings` · needs `payment:write`
   */
  setSettlementTracking(params: {
    body: SetSettlementTrackingBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/settlement-tracking/settings", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set a site's electricity cost per kWh
   *
   * (v1.20.0) What the site pays per kWh, taxes included (its PLN tariff): the energy cost of months without a recorded bill. Audited as finance.energy_rate_saved.
   *
   * `PUT /v1/finance/sites/{sid}/energy-rate` · needs `payment:write`
   */
  setSiteElectricityCostPerKWh(params: {
    /** The site id. */
    sid: string;
    body: SetSiteElectricityCostPerKWhBody;
  }, options?: RequestOptions): Promise<SetSiteElectricityCostPerKWhResponse> {
    return this.transport.request<SetSiteElectricityCostPerKWhResponse>({ method: "PUT", path: "/v1/finance/sites/{sid}/energy-rate", pathParams: { sid: params.sid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set a site's electricity tariff
   *
   * (v1.27.0) tariffClass, powerKva, ratePeak and rateOffpeak (default: the catalogue's), peakFrom/peakTo (default 17–22), fixedMonthly. Audited.
   *
   * `PUT /v1/finance/tariffs/sites/{sid}` · needs `payment:write`
   */
  setSiteElectricityTariff(params: {
    /** The site id. */
    sid: string;
    body: SetSiteElectricityTariffBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/tariffs/sites/{sid}", pathParams: { sid: params.sid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set a site owner's bank details
   *
   * bankName and holderName are required; accountNumber (5–20 digits) is required the first time and kept when omitted later. payment:write; audited as finance.owner_bank_account_saved (masked).
   *
   * `PUT /v1/finance/owners/{oid}/bank-account` · needs `payment:write`
   */
  setSiteOwnerBankDetails(params: {
    /** The site owner id. */
    oid: string;
    body: SetSiteOwnerBankDetailsBody;
  }, options?: RequestOptions): Promise<SetSiteOwnerBankDetailsResponse> {
    return this.transport.request<SetSiteOwnerBankDetailsResponse>({ method: "PUT", path: "/v1/finance/owners/{oid}/bank-account", pathParams: { oid: params.oid }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Set the subscription revenue accounts
   *
   * (v1.26.0) The journal's accounts: deferred (deferred revenue), revenue, receivable (cash or receivable), each { code, name }. Audited.
   *
   * `PUT /v1/finance/subscription-revenue/accounts` · needs `payment:write`
   */
  setSubscriptionRevenueAccounts(params: {
    body: SetSubscriptionRevenueAccountsBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/subscription-revenue/accounts", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the tax filing calendar
   *
   * (v1.23.0) Per obligation: enabled and the due day of the following month (31 = its last day); reminderDays (0–30); reminders (finance.tax_due alerts). Audited.
   *
   * `PUT /v1/finance/tax/calendar/settings` · needs `payment:write`
   */
  setTaxFilingCalendar(params: {
    body: SetTaxFilingCalendarBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/tax/calendar/settings", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Settlements and withdrawals of a payments account
   *
   * (v1.23.0) Settlements per expected day (45 days back, 14 ahead): expected net, settled, pending, state (settled, due, upcoming, late after the grace days). Withdrawals to the bank (45 days) against the bank statement lines matched to them: in_bank, short, missing, awaiting_statement.
   *
   * `GET /v1/finance/accounts/{id}/settlements` · needs `payment:read`
   */
  settlementsAndWithdrawalsOfPaymentsAccount(params: {
    /** The payments account (integration) id. */
    id: string;
  }, options?: RequestOptions): Promise<SettlementsAndWithdrawalsOfPaymentsAccountResponse> {
    return this.transport.request<SettlementsAndWithdrawalsOfPaymentsAccountResponse>({ method: "GET", path: "/v1/finance/accounts/{id}/settlements", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Settle an owner payout Duitku never confirmed
   *
   * (v1.16.0) After checking Duitku's dashboard: succeeded records the statement payment; failed records nothing. Audited as finance.owner_payout_resolved.
   *
   * `POST /v1/finance/payout-transfers/{tid}/resolve` · needs `payment:write`
   */
  settleOwnerPayoutDuitkuNeverConfirmed(params: {
    /** The payout id. */
    tid: string;
    body: SettleOwnerPayoutDuitkuNeverConfirmedBody;
  }, options?: RequestOptions): Promise<SettleOwnerPayoutDuitkuNeverConfirmedResponse> {
    return this.transport.request<SettleOwnerPayoutDuitkuNeverConfirmedResponse>({ method: "POST", path: "/v1/finance/payout-transfers/{tid}/resolve", pathParams: { tid: params.tid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Settle a refund transfer whose result Duitku never confirmed
   *
   * (v1.15.0) For a transfer sent (or stuck sending) without a confirmed result, after checking Duitku's dashboard: succeeded records the refund refunded; failed makes it due again. Audited as refund.transfer_resolved.
   *
   * `POST /v1/refund-transfers/{tid}/resolve` · needs `payment:write`
   */
  settleRefundTransferWhoseResultDuitkuNeverConfirmed(params: {
    /** The transfer id. */
    tid: string;
    body: SettleRefundTransferWhoseResultDuitkuNeverConfirmedBody;
  }, options?: RequestOptions): Promise<SettleRefundTransferWhoseResultDuitkuNeverConfirmedResponse> {
    return this.transport.request<SettleRefundTransferWhoseResultDuitkuNeverConfirmedResponse>({ method: "POST", path: "/v1/refund-transfers/{tid}/resolve", pathParams: { tid: params.tid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Settle with a group entity
   *
   * (v1.31.0) otherOrgId, currency, settledOn (default today), reference: the issued recharges both ways are netted and settled; says who pays whom. Audited.
   *
   * `POST /v1/finance/intercompany/settle`
   */
  settleWithGroupEntity(params: {
    body: SettleWithGroupEntityBody;
  }, options?: RequestOptions): Promise<SettleWithGroupEntityResponse> {
    return this.transport.request<SettleWithGroupEntityResponse>({ method: "POST", path: "/v1/finance/intercompany/settle", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Set the treasury settings
   *
   * (v1.30.0) indicativeRatePct (0–30, default 4: for the idle-cash estimate), buffer (kept above the minimums before suggesting a deposit). Audited.
   *
   * `PUT /v1/finance/treasury/settings`
   */
  setTreasurySettings(params: {
    body: SetTreasurySettingsBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/treasury/settings", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Shared costs
   *
   * (v1.23.0) Costs shared by sites (rent, maintenance, connectivity, insurance, staff, other), per month from monthFrom to monthTo (or ongoing), and how each is allocated (kWh, sessions, revenue, equal).
   *
   * `GET /v1/finance/shared-costs` · needs `payment:read`
   */
  sharedCosts(options?: RequestOptions): Promise<SharedCostsResponse> {
    return this.transport.request<SharedCostsResponse>({ method: "GET", path: "/v1/finance/shared-costs", accept: "json" }, options);
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
   * Sign off a close step
   *
   * (v1.32.0) note; a step whose check fails is accepted as it is only with finance:approve and a note. Audited.
   *
   * `POST /v1/finance/close/{month}/steps/{step}/sign-off`
   */
  signOffCloseStep(params: {
    /** YYYY-MM. */
    month: string;
    /** The step. */
    step: string;
    body: SignOffCloseStepBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/close/{month}/steps/{step}/sign-off", pathParams: { month: params.month, step: params.step }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Simulate tariffs for a site
   *
   * (v1.27.0) The site's load by hour of day over the last months (peak share), the energy cost per month and per kWh under its tariff and each catalogue class (losses from recorded bills), the margin against the revenue per kWh, the price per kWh for a target margin, and the saving from moving part of the peak load off-peak.
   *
   * `GET /v1/finance/tariffs/sites/{sid}/simulate` · needs `payment:read`
   */
  simulateTariffsForSite(params: {
    /** The site id. */
    sid: string;
    query?: {
      months?: number;
      targetMarginPct?: number;
      shiftPct?: number;
    };
  }, options?: RequestOptions): Promise<SimulateTariffsForSiteResponse> {
    return this.transport.request<SimulateTariffsForSiteResponse>({ method: "GET", path: "/v1/finance/tariffs/sites/{sid}/simulate", pathParams: { sid: params.sid }, query: params.query, accept: "json" }, options);
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
   * Site investments and payback
   *
   * (v1.22.0) Per site with investments: invested (by category), depreciation (per month, accumulated, net book value; straight line from the month after), the margin recovered since the first investment, the payback month (reached, or projected at the last 6 months' average margin) and a year's ROI. site: one site.
   *
   * `GET /v1/finance/investments` · needs `payment:read`
   */
  siteInvestmentsAndPayback(params?: {
    query?: {
      site?: string;
    };
  }, options?: RequestOptions): Promise<SiteInvestmentsAndPaybackResponse> {
    return this.transport.request<SiteInvestmentsAndPaybackResponse>({ method: "GET", path: "/v1/finance/investments", query: params?.query, accept: "json" }, options);
  }

  /**
   * A site owner's annual statement
   *
   * (v1.27.0) The year's statements with share, tax withheld, paid and due, and the bukti potong numbers (PDF).
   *
   * `GET /v1/finance/owners/{oid}/documents/year/{year}` · needs `payment:read`
   */
  siteOwnerAnnualStatement(params: {
    /** The site owner id. */
    oid: string;
    /** YYYY. */
    year: string;
  }, options?: RequestOptions): Promise<ArrayBuffer> {
    return this.transport.request<ArrayBuffer>({ method: "GET", path: "/v1/finance/owners/{oid}/documents/year/{year}", pathParams: { oid: params.oid, year: params.year }, accept: "binary" }, options);
  }

  /**
   * A site owner's bank details
   *
   * Where the owner is paid: bank, code, account holder; the account number masked (it is stored sealed). 404 when none are saved.
   *
   * `GET /v1/finance/owners/{oid}/bank-account` · needs `payment:read`
   */
  siteOwnerBankDetails(params: {
    /** The site owner id. */
    oid: string;
  }, options?: RequestOptions): Promise<SiteOwnerBankDetailsResponse> {
    return this.transport.request<SiteOwnerBankDetailsResponse>({ method: "GET", path: "/v1/finance/owners/{oid}/bank-account", pathParams: { oid: params.oid }, accept: "json" }, options);
  }

  /**
   * A site owner's documents
   *
   * (v1.27.0) The owner's payout advices, tax withheld from its share (with bukti potong numbers), the years with statements, and its statements in automatic payouts.
   *
   * `GET /v1/finance/owners/{oid}/documents` · needs `payment:read`
   */
  siteOwnerDocuments(params: {
    /** The site owner id. */
    oid: string;
  }, options?: RequestOptions): Promise<SiteOwnerDocumentsResponse> {
    return this.transport.request<SiteOwnerDocumentsResponse>({ method: "GET", path: "/v1/finance/owners/{oid}/documents", pathParams: { oid: params.oid }, accept: "json" }, options);
  }

  /**
   * Site owners' bank detail change requests
   *
   * (v1.19.0) Pending requests from the Site Owner portal, with the account on file (masked) beside the requested one (masked). The number stays sealed until approved.
   *
   * `GET /v1/finance/owner-bank-requests` · needs `payment:read`
   */
  siteOwnersBankDetailChangeRequests(options?: RequestOptions): Promise<SiteOwnersBankDetailChangeRequestsResponse> {
    return this.transport.request<SiteOwnersBankDetailChangeRequestsResponse>({ method: "GET", path: "/v1/finance/owner-bank-requests", accept: "json" }, options);
  }

  /**
   * Site owners' queries on their statements
   *
   * (v1.23.0) Open queries first, then the last answered; the adjustments agreed and not yet on a statement, per owner and currency.
   *
   * `GET /v1/finance/owner-queries` · needs `payment:read`
   */
  siteOwnersQueriesOnTheirStatements(options?: RequestOptions): Promise<SiteOwnersQueriesOnTheirStatementsResponse> {
    return this.transport.request<SiteOwnersQueriesOnTheirStatementsResponse>({ method: "GET", path: "/v1/finance/owner-queries", accept: "json" }, options);
  }

  /**
   * Site owners' shares and their payouts
   *
   * The organisation's owner statements (finalised, with a share), newest first: the share due, what was paid against it (recorded transfers), outstanding, and status (due, partial, paid), with the owner's bank (masked). The operator's bank makes the transfers and they are recorded here; (v1.16.0) or, with Disbursement on the operator's own Duitku account (payoutsAvailable), they can be sent with POST /v1/finance/statements/{sid}/payout.
   *
   * `GET /v1/finance/owner-shares` · needs `payment:read`
   */
  siteOwnersSharesAndTheirPayouts(params?: {
    query?: {
      status?: "due" | "partial" | "paid";
    };
  }, options?: RequestOptions): Promise<SiteOwnersSharesAndTheirPayoutsResponse> {
    return this.transport.request<SiteOwnersSharesAndTheirPayoutsResponse>({ method: "GET", path: "/v1/finance/owner-shares", query: params?.query, accept: "json" }, options);
  }

  /**
   * Site P&L for a month
   *
   * (v1.23.0) Per site: revenue, energy cost, shared costs allocated (by category), depreciation of its investments, and its contribution; totals per currency; costs with no site to go to. month: YYYY-MM, default last month.
   *
   * `GET /v1/finance/site-pnl` · needs `payment:read`
   */
  sitePLForMonth(params?: {
    query?: {
      month?: string;
    };
  }, options?: RequestOptions): Promise<SitePLForMonthResponse> {
    return this.transport.request<SitePLForMonthResponse>({ method: "GET", path: "/v1/finance/site-pnl", query: params?.query, accept: "json" }, options);
  }

  /**
   * Start a session remotely
   *
   * Sends RemoteStartTransaction for an RFID tag or driver account, optionally capped by energy, duration or amount. Refused with 409 when the charge point is suspended, awaiting adoption or decommissioned, or when the connector’s meter verification (tera) has lapsed or awaits calibration. A caller without `session:write` (e.g. a field technician) may only start with a technician or VIP card (403 otherwise). Audited.
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
   * Statements of account sent
   *
   * (v1.22.0) The automatic statements setting (enabled, day of the month) and the last 200 statements e-mailed (automatic or by hand). account: one account.
   *
   * `GET /v1/fleet-account-statements` · needs `invoice:read`
   */
  statementsOfAccountSent(params?: {
    query?: {
      account?: string;
    };
  }, options?: RequestOptions): Promise<StatementsOfAccountSentResponse> {
    return this.transport.request<StatementsOfAccountSentResponse>({ method: "GET", path: "/v1/fleet-account-statements", query: params?.query, accept: "json" }, options);
  }

  /**
   * Stock moves
   *
   * (v1.34.0) The last 500 moves (itemId to filter): receipts, issues, transfers and adjustments with their value.
   *
   * `GET /v1/finance/inventory/moves`
   */
  stockMoves(params?: {
    query?: {
      itemId?: string;
    };
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/inventory/moves", query: params?.query, accept: "json" }, options);
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
   * Store today's cash forecast
   *
   * (v1.33.0) Stores it (for the accuracy) and raises or resolves the shortfall alert; the worker does this daily.
   *
   * `POST /v1/finance/cash-forecast/snapshot`
   */
  storeTodayCashForecast(options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/cash-forecast/snapshot", accept: "json" }, options);
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
   * Submit a bill for approval
   *
   * (v1.29.0) A draft or a rejected bill goes to approval. Audited.
   *
   * `POST /v1/finance/bills/{id}/submit` · needs `payment:write`
   */
  submitBillForApproval(params: {
    /** The bill id. */
    id: string;
  }, options?: RequestOptions): Promise<SubmitBillForApprovalResponse> {
    return this.transport.request<SubmitBillForApprovalResponse>({ method: "POST", path: "/v1/finance/bills/{id}/submit", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Submit an expense claim
   *
   * (v1.31.0) By the claimant; every line at or above the receipt amount has its receipt. Audited.
   *
   * `POST /v1/finance/expenses/{id}/submit`
   */
  submitExpenseClaim(params: {
    /** The claim id. */
    id: string;
  }, options?: RequestOptions): Promise<SubmitExpenseClaimResponse> {
    return this.transport.request<SubmitExpenseClaimResponse>({ method: "POST", path: "/v1/finance/expenses/{id}/submit", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Submit a journal entry
   *
   * (v1.31.0) A draft or rejected manual entry goes to approval. Audited.
   *
   * `POST /v1/finance/ledger/entries/{id}/submit`
   */
  submitJournalEntry(params: {
    /** The entry id. */
    id: string;
  }, options?: RequestOptions): Promise<SubmitJournalEntryResponse> {
    return this.transport.request<SubmitJournalEntryResponse>({ method: "POST", path: "/v1/finance/ledger/entries/{id}/submit", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Submit a payroll run
   *
   * (v1.33.0) For approval. Audited.
   *
   * `POST /v1/finance/payroll/runs/{id}/submit`
   */
  submitPayrollRun(params: {
    /** The id. */
    id: string;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/payroll/runs/{id}/submit", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Submit a purchase order
   *
   * (v1.30.0) A draft or rejected order goes to approval. Audited.
   *
   * `POST /v1/finance/purchase-orders/{id}/submit`
   */
  submitPurchaseOrder(params: {
    /** The purchase order id. */
    id: string;
  }, options?: RequestOptions): Promise<SubmitPurchaseOrderResponse> {
    return this.transport.request<SubmitPurchaseOrderResponse>({ method: "POST", path: "/v1/finance/purchase-orders/{id}/submit", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Submit a report pack
   *
   * (v1.32.0) For review (the summary is needed). Audited.
   *
   * `POST /v1/finance/report-packs/{id}/submit`
   */
  submitReportPack(params: {
    /** The id. */
    id: string;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/report-packs/{id}/submit", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Subscribe to the finance digest
   *
   * (v1.27.0) frequency (off, daily, weekly), channels (email, whatsapp), sections (figures, approvals, overdue, cash, anomalies), hour (0–23, billing time zone), weekday (1 Monday – 7 Sunday), phone (for WhatsApp).
   *
   * `PUT /v1/finance/digest` · needs `payment:read`
   */
  subscribeToFinanceDigest(params: {
    body: SubscribeToFinanceDigestBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/digest", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Subscription and membership revenue
   *
   * (v1.26.0) For a month (default this month), per currency: billed (paid, or invoiced to a fleet), recognised pro rata over each charge's period, deferred at the start and end, MRR and ARR, subscribers (new, cancelled, expired, churn), per plan, and the month's journal (billed into deferred revenue, recognised out of it). format=xlsx for a workbook.
   *
   * `GET /v1/finance/subscription-revenue` · needs `payment:read`
   */
  subscriptionAndMembershipRevenue(params?: {
    query?: {
      month?: string;
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<SubscriptionAndMembershipRevenueResponse> {
    return this.transport.request<SubscriptionAndMembershipRevenueResponse>({ method: "GET", path: "/v1/finance/subscription-revenue", query: params?.query, accept: "json" }, options);
  }

  /**
   * Subscription revenue, twelve months
   *
   * (v1.26.0) Recognised, deferred at the end, MRR and subscribers for the twelve months to the month given (default this month).
   *
   * `GET /v1/finance/subscription-revenue/trend` · needs `payment:read`
   */
  subscriptionRevenueTwelveMonths(params?: {
    query?: {
      month?: string;
    };
  }, options?: RequestOptions): Promise<SubscriptionRevenueTwelveMonthsResponse> {
    return this.transport.request<SubscriptionRevenueTwelveMonthsResponse>({ method: "GET", path: "/v1/finance/subscription-revenue/trend", query: params?.query, accept: "json" }, options);
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
   * Suggest a WhatsApp reply
   *
   * Asks the assistant (Claude) for a reply to the conversation as it stands, whoever handles it, and keeps it as the draft; nothing is sent. `handoff` is set when the assistant would rather a person answered. 409 when the AI support integration is not set up; 502 when the Anthropic API fails. At most 10 a minute per administrator.
   *
   * `POST /v1/whatsapp/conversations/{id}/suggest` · needs `platform:admin`
   */
  suggestWhatsAppReply(params: {
    /** The conversation id. */
    id: string;
  }, options?: RequestOptions): Promise<SuggestWhatsAppReplyResponse> {
    return this.transport.request<SuggestWhatsAppReplyResponse>({ method: "POST", path: "/v1/whatsapp/conversations/{id}/suggest", pathParams: { id: params.id }, accept: "json" }, options);
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
   * A supplier bill
   *
   * (v1.29.0) The bill with its payments (date, amount, method, reference, cash account, voided).
   *
   * `GET /v1/finance/bills/{id}` · needs `payment:read`
   */
  supplierBill(params: {
    /** The bill id. */
    id: string;
  }, options?: RequestOptions): Promise<SupplierBillResponse> {
    return this.transport.request<SupplierBillResponse>({ method: "GET", path: "/v1/finance/bills/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Supplier bills
   *
   * (v1.29.0) Bills (awaiting approval first, then approved by due date), filtered by status and supplierId: supplier, number, category, site, subtotal, PPN, PPh 23, payable, paid, balance, dates, overdue and days late, who submitted and approved.
   *
   * `GET /v1/finance/bills` · needs `payment:read`
   */
  supplierBills(params?: {
    query?: {
      status?: "draft" | "awaiting_approval" | "approved" | "paid" | "rejected" | "void";
      supplierId?: string;
    };
  }, options?: RequestOptions): Promise<SupplierBillsResponse> {
    return this.transport.request<SupplierBillsResponse>({ method: "GET", path: "/v1/finance/bills", query: params?.query, accept: "json" }, options);
  }

  /**
   * Suppliers
   *
   * (v1.29.0) The organisation's suppliers (archived=true to include archived ones), with what is open on their approved bills.
   *
   * `GET /v1/finance/suppliers` · needs `payment:read`
   */
  suppliers(params?: {
    query?: {
      archived?: "true" | "false";
    };
  }, options?: RequestOptions): Promise<SuppliersResponse> {
    return this.transport.request<SuppliersResponse>({ method: "GET", path: "/v1/finance/suppliers", query: params?.query, accept: "json" }, options);
  }

  /**
   * Suspend a charge point
   *
   * Takes a charge point out of service without revoking its credentials: it stays connected, its BootNotification is answered Pending, and new authorisations, starts and remote starts are refused; the driver app keeps it on the map but sells, reserves and queues nothing. Live driver reservations and queue offers on it are released, their fee waived or refunded and the queue place kept. A session already running finishes normally and is billed. Any open outage is closed (planned downtime). 409 when it is already suspended, awaiting adoption or decommissioned. The optional reason is recorded in the audit entry charge_point.suspended.
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
   * Sync and reconcile now
   *
   * Syncs the account's transactions changed since the last run, reads the balance and reconciles (the workers do this every 15 minutes, hourly and every 6 hours). At most 4 a minute. Audited as finance.synced.
   *
   * `POST /v1/finance/accounts/{id}/sync` · needs `payment:write`
   */
  syncAndReconcileNow(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
  }, options?: RequestOptions): Promise<SyncAndReconcileNowResponse> {
    return this.transport.request<SyncAndReconcileNowResponse>({ method: "POST", path: "/v1/finance/accounts/{id}/sync", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Sync a month into the ledger
   *
   * (v1.31.0) Posts the modules' entries for the month, one per source and currency: gateway journals, the recorded depreciation, lease and provision journals, supplier bills and payments, deposits, expense claims, intercompany recharges and settlements. Unchanged entries stay; changed ones are superseded by new ones. Not a locked or future month. Audited.
   *
   * `POST /v1/finance/ledger/sync/{month}`
   */
  syncMonthIntoLedger(params: {
    /** YYYY-MM. */
    month: string;
  }, options?: RequestOptions): Promise<SyncMonthIntoLedgerResponse> {
    return this.transport.request<SyncMonthIntoLedgerResponse>({ method: "POST", path: "/v1/finance/ledger/sync/{month}", pathParams: { month: params.month }, accept: "json" }, options);
  }

  /**
   * Tax filing calendar
   *
   * (v1.23.0) The obligations (PPh 23 payment and SPT Masa Unifikasi, PPN payment and SPT Masa PPN, e-Faktur upload) of the last 6 periods and the current one: the due date (a day of the following month, a weekend moved to Monday), the status (filed, overdue, due_soon, upcoming), what PlugSure knows of the amount, and the filing.
   *
   * `GET /v1/finance/tax/calendar` · needs `payment:read`
   */
  taxFilingCalendar(options?: RequestOptions): Promise<TaxFilingCalendarResponse> {
    return this.transport.request<TaxFilingCalendarResponse>({ method: "GET", path: "/v1/finance/tax/calendar", accept: "json" }, options);
  }

  /**
   * Test the covenants
   *
   * (v1.34.0) For a month (default last month) over the twelve months to its end; breaches and thin headroom raise alerts. Audited.
   *
   * `POST /v1/finance/lenders/covenants/test`
   */
  testCovenants(params: {
    body: TestCovenantsBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/lenders/covenants/test", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Test an integration
   *
   * Checks the credentials without moving money: the acquirer's authentication, the messaging account (and, with a phone number, a real test code), the PKI gateway's roots, a map tile.
   *
   * `POST /v1/integrations/{kind}/test`
   */
  testIntegration(params: {
    /** Integration: payments (the acquirer: QRIS, e-wallets, cards), payments_fallback (Duitku, when the acquirer does not answer), otp (driver sign-in codes), otp_fallback, pnc_pki (Plug & Charge PKI), map_tiles or ai_support (WhatsApp AI support, Claude). */
    kind: string;
    body: TestIntegrationBody;
  }, options?: RequestOptions): Promise<TestIntegrationResponse> {
    return this.transport.request<TestIntegrationResponse>({ method: "POST", path: "/v1/integrations/{kind}/test", pathParams: { kind: params.kind }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * This operator's hub membership
   *
   * Membership, its parties and the roaming agreements they are in (counterparty name, status, module flags). Never tokens or endpoints.
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `GET /v1/roaming/hub` · needs `roaming:read`
   */
  thisOperatorHubMembership(options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/roaming/hub", accept: "json" }, options);
  }

  /**
   * Transfer list for the bank
   *
   * What is still owed to site owners, one line per statement, with each owner's bank, code, holder and FULL account number, for the bank's bulk transfer. payment:write; audited as finance.transfer_list_exported.
   *
   * `GET /v1/finance/owner-shares/transfer-list.csv` · needs `payment:write`
   */
  transferListForBank(options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/finance/owner-shares/transfer-list.csv", accept: "text" }, options);
  }

  /**
   * Transfers waiting for a second person
   *
   * (v1.18.0) How many refund and owner-payout transfers wait for approval, and how many of those the caller may approve (not their own). The console's badge on Refunds and Finance.
   *
   * `GET /v1/finance/approvals` · needs `payment:read`
   */
  transfersWaitingForSecondPerson(options?: RequestOptions): Promise<TransfersWaitingForSecondPersonResponse> {
    return this.transport.request<TransfersWaitingForSecondPersonResponse>({ method: "GET", path: "/v1/finance/approvals", accept: "json" }, options);
  }

  /**
   * Treasury
   *
   * (v1.30.0) Time deposits: principal, rate, dates, interest accrued to today and at maturity (gross, final tax, net), status; totals per currency; interest received this year; the settings; idle cash per currency (the 13-week view's lowest point above the minimums and the buffer, with the net interest it would earn). format=xlsx for the deposits.
   *
   * `GET /v1/finance/treasury`
   */
  treasury(params?: {
    query?: {
      format?: "json" | "xlsx";
    };
  }, options?: RequestOptions): Promise<TreasuryResponse> {
    return this.transport.request<TreasuryResponse>({ method: "GET", path: "/v1/finance/treasury", query: params?.query, accept: "json" }, options);
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
   * Unbind a user from their Microsoft account
   *
   * The user’s next Microsoft sign-in is matched by e-mail address again and binds afresh; their sessions signed in with Microsoft end (password sessions do not). Within your own authority only. Audited.
   *
   * `DELETE /v1/users/{id}/microsoft` · needs `user:write`
   */
  unbindUserFromTheirMicrosoftAccount(params: {
    /** User id (UUID). */
    id: string;
  }, options?: RequestOptions): Promise<UnbindUserFromTheirMicrosoftAccountResponse> {
    return this.transport.request<UnbindUserFromTheirMicrosoftAccountResponse>({ method: "DELETE", path: "/v1/users/{id}/microsoft", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Unlink from a capex project
   *
   * (v1.33.0) billId or orderId (not from a completed or cancelled project). Audited.
   *
   * `POST /v1/finance/projects/unlink`
   */
  unlinkFromCapexProject(params: {
    body: UnlinkFromCapexProjectBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/projects/unlink", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Update an auditor request
   *
   * (v1.35.0) status requested → in_progress → provided (a file needed) → accepted; ownerId, dueOn, note. Audited.
   *
   * `PUT /v1/finance/compliance/pbc/{id}`
   */
  updateAuditorRequest(params: {
    /** The id. */
    id: string;
    body: UpdateAuditorRequestBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/compliance/pbc/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Update carbon credits
   *
   * (v1.35.0) status estimated → verified → issued (serial needed) or void (if none sold); tonnes, standard, note. Audited.
   *
   * `PUT /v1/finance/carbon/credits/{id}`
   */
  updateCarbonCredits(params: {
    /** The id. */
    id: string;
    body: UpdateCarbonCreditsBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/carbon/credits/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Update a chargeback
   *
   * (v1.36.0) status evidence_submitted, won, lost or accepted; on; note. Audited.
   *
   * `POST /v1/finance/chargebacks/{id}`
   */
  updateChargeback(params: {
    /** The id. */
    id: string;
    body: UpdateChargebackBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/chargebacks/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Update a claim
   *
   * (v1.35.0) status submitted, accepted, rejected, paid (settled up to the loss less the excess, paidOn) or closed; insurerRef, note. Audited.
   *
   * `POST /v1/finance/insurance/claims/{id}`
   */
  updateClaim(params: {
    /** The id. */
    id: string;
    body: UpdateClaimBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/insurance/claims/{id}", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Update a grant claim
   *
   * (v1.36.0) status submitted, approved, rejected or paid (paid: what was received, cashAccountId), on. Audited.
   *
   * `POST /v1/finance/grants/claims/{cid}`
   */
  updateGrantClaim(params: {
    /** The id. */
    cid: string;
    body: UpdateGrantClaimBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/grants/claims/{cid}", pathParams: { cid: params.cid }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Update a warranty claim
   *
   * (v1.34.0) status accepted, rejected or paid (paid, on). Audited.
   *
   * `POST /v1/finance/maintenance/claims/{cid}`
   */
  updateWarrantyClaim(params: {
    /** The claim. */
    cid: string;
    body: UpdateWarrantyClaimBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/maintenance/claims/{cid}", pathParams: { cid: params.cid }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Upload the Android notifications service account (FCM)
   *
   * The Firebase project’s service account key (Firebase console → Project settings → Service accounts → Generate new private key), as the JSON object or its text. It must be the project of the Android app’s google-services.json and hold the “Firebase Cloud Messaging API Admin” role. Stored encrypted, never returned, and checked with Google at once (a validate-only send: nobody is notified; the result is in fcmCheckOk / fcmCheckDetail).
   *
   * `PUT /v1/driver-app/fcm` · needs `org:write`
   */
  uploadAndroidNotificationsServiceAccountFcm(params: {
    body: UploadAndroidNotificationsServiceAccountFcmBody;
  }, options?: RequestOptions): Promise<UploadAndroidNotificationsServiceAccountFcmResponse> {
    return this.transport.request<UploadAndroidNotificationsServiceAccountFcmResponse>({ method: "PUT", path: "/v1/driver-app/fcm", body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Upload a bank statement (CSV)
   *
   * (v1.18.0) The bank's CSV export (BCA, Mandiri, BRI or any with date, description and amount or debit/credit columns), up to 4 MB. Lines already uploaded are skipped; the new ones are matched automatically to gateway withdrawals, owner payouts (and, for platform administrators, platform-fee payments) and manual refunds: the same amount within 4 days, the reference in the description first. payment:write; audited as finance.bank_statement_uploaded.
   *
   * `POST /v1/finance/bank-statements` · needs `payment:write`
   */
  uploadBankStatementCsv(params: {
    body: UploadBankStatementCsvBody;
  }, options?: RequestOptions): Promise<UploadBankStatementCsvResponse> {
    return this.transport.request<UploadBankStatementCsvResponse>({ method: "POST", path: "/v1/finance/bank-statements", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Upload the console logo
   *
   * A square PNG, 64 to 2048 pixels (256 or more is best), up to 1 MB, as base64. It is stored as 256 × 256. Needs the brand first (404).
   *
   * `PUT /v1/console-brand/logo` · needs `org:write`
   */
  uploadConsoleLogo(params: {
    body: UploadConsoleLogoBody;
  }, options?: RequestOptions): Promise<UploadConsoleLogoResponse> {
    return this.transport.request<UploadConsoleLogoResponse>({ method: "PUT", path: "/v1/console-brand/logo", body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Uploaded bank statements
   *
   * (v1.18.0) The last 100 uploads, with how many of each one's lines are still open (unmatched).
   *
   * `GET /v1/finance/bank-statements` · needs `payment:read`
   */
  uploadedBankStatements(options?: RequestOptions): Promise<UploadedBankStatementsResponse> {
    return this.transport.request<UploadedBankStatementsResponse>({ method: "GET", path: "/v1/finance/bank-statements", accept: "json" }, options);
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
   * Void an asset
   *
   * (v1.29.0) For an asset recorded in error, with a reason. Refused once its depreciation is in a recorded month (dispose of it instead). Audited.
   *
   * `POST /v1/finance/assets/{id}/void` · needs `payment:write`
   */
  voidAsset(params: {
    /** The asset id. */
    id: string;
    body: VoidAssetBody;
  }, options?: RequestOptions): Promise<VoidAssetResponse> {
    return this.transport.request<VoidAssetResponse>({ method: "POST", path: "/v1/finance/assets/{id}/void", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
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
   * Void a customer deposit entry
   *
   * (v1.33.0) reason; not an applied one. Audited.
   *
   * `POST /v1/finance/customer-deposits/{id}/void`
   */
  voidCustomerDepositEntry(params: {
    /** The id. */
    id: string;
    body: VoidCustomerDepositEntryBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/customer-deposits/{id}/void", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Void an electricity bill
   *
   * (v1.20.0) With a reason; never deleted. Audited as finance.energy_bill_voided.
   *
   * `POST /v1/finance/energy-bills/{bid}/void` · needs `payment:write`
   */
  voidElectricityBill(params: {
    /** The bill id. */
    bid: string;
    body: VoidElectricityBillBody;
  }, options?: RequestOptions): Promise<VoidElectricityBillResponse> {
    return this.transport.request<VoidElectricityBillResponse>({ method: "POST", path: "/v1/finance/energy-bills/{bid}/void", pathParams: { bid: params.bid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Void an elimination
   *
   * (v1.28.0) With a reason. Audited.
   *
   * `POST /v1/finance/group/eliminations/{id}/void` · needs `payment:write`
   */
  voidElimination(params: {
    /** The elimination id. */
    id: string;
    body: VoidEliminationBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/group/eliminations/{id}/void", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Void an expense claim
   *
   * (v1.31.0) A draft, rejected or submitted claim, by the claimant or a Finance Manager. Audited.
   *
   * `POST /v1/finance/expenses/{id}/void`
   */
  voidExpenseClaim(params: {
    /** The claim id. */
    id: string;
  }, options?: RequestOptions): Promise<VoidExpenseClaimResponse> {
    return this.transport.request<VoidExpenseClaimResponse>({ method: "POST", path: "/v1/finance/expenses/{id}/void", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Void a faktur masukan
   *
   * (v1.26.0) With a reason. Audited.
   *
   * `POST /v1/finance/ppn/input-invoices/{id}/void` · needs `payment:write`
   */
  voidFakturMasukan(params: {
    /** The input invoice id. */
    id: string;
    body: VoidFakturMasukanBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/ppn/input-invoices/{id}/void", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
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

  /**
   * Void a landlord statement
   *
   * (v1.36.0) Only while its bill is draft, rejected or void. Audited.
   *
   * `POST /v1/finance/landlords/statements/{sid}/void`
   */
  voidLandlordStatement(params: {
    /** The statement. */
    sid: string;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/landlords/statements/{sid}/void", pathParams: { sid: params.sid }, accept: "json" }, options);
  }

  /**
   * Void a lease
   *
   * (v1.30.0) For a lease recorded in error, with a reason; not once it is in a recorded month (end it instead). Audited.
   *
   * `POST /v1/finance/leases/{id}/void`
   */
  voidLease(params: {
    /** The lease id. */
    id: string;
    body: VoidLeaseBody;
  }, options?: RequestOptions): Promise<VoidLeaseResponse> {
    return this.transport.request<VoidLeaseResponse>({ method: "POST", path: "/v1/finance/leases/{id}/void", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Void a payment to a supplier
   *
   * (v1.29.0) With a reason; not when it is matched to a bank statement line. A paid bill returns to approved. Audited.
   *
   * `POST /v1/finance/bills/{id}/payments/{pid}/void` · needs `payment:write`
   */
  voidPaymentToSupplier(params: {
    /** The bill id. */
    id: string;
    /** The payment id. */
    pid: string;
    body: VoidPaymentToSupplierBody;
  }, options?: RequestOptions): Promise<VoidPaymentToSupplierResponse> {
    return this.transport.request<VoidPaymentToSupplierResponse>({ method: "POST", path: "/v1/finance/bills/{id}/payments/{pid}/void", pathParams: { id: params.id, pid: params.pid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Void a payroll run
   *
   * (v1.33.0) reason; not once paid. Audited.
   *
   * `POST /v1/finance/payroll/runs/{id}/void`
   */
  voidPayrollRun(params: {
    /** The id. */
    id: string;
    body: VoidPayrollRunBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/payroll/runs/{id}/void", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Void a recharge
   *
   * (v1.31.0) A draft or issued (not settled) recharge, by the entity that charges, with a reason. Audited.
   *
   * `POST /v1/finance/intercompany/recharges/{id}/void`
   */
  voidRecharge(params: {
    /** The recharge id. */
    id: string;
    body: VoidRechargeBody;
  }, options?: RequestOptions): Promise<VoidRechargeResponse> {
    return this.transport.request<VoidRechargeResponse>({ method: "POST", path: "/v1/finance/intercompany/recharges/{id}/void", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Void a recorded payment
   *
   * A payment recorded by mistake is voided (never deleted), with a reason; the statement is due again by its amount. Audited as finance.statement_payment_voided.
   *
   * `POST /v1/finance/statement-payments/{pid}/void` · needs `payment:write`
   */
  voidRecordedPayment(params: {
    /** The payment id. */
    pid: string;
    body: VoidRecordedPaymentBody;
  }, options?: RequestOptions): Promise<VoidRecordedPaymentResponse> {
    return this.transport.request<VoidRecordedPaymentResponse>({ method: "POST", path: "/v1/finance/statement-payments/{pid}/void", pathParams: { pid: params.pid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Void a roaming settlement payment
   *
   * (v1.25.0) With a reason; refused while it is matched to a bank line. Audited.
   *
   * `POST /v1/finance/roaming/payments/{id}/void` · needs `payment:write`
   */
  voidRoamingSettlementPayment(params: {
    /** The payment id. */
    id: string;
    body: VoidRoamingSettlementPaymentBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/roaming/payments/{id}/void", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Void a shared cost
   *
   * (v1.23.0) With a reason; 409 when it counts in a locked month (end it instead). Audited.
   *
   * `POST /v1/finance/shared-costs/{cid}/void` · needs `payment:write`
   */
  voidSharedCost(params: {
    /** The cost id. */
    cid: string;
    body: VoidSharedCostBody;
  }, options?: RequestOptions): Promise<VoidSharedCostResponse> {
    return this.transport.request<VoidSharedCostResponse>({ method: "POST", path: "/v1/finance/shared-costs/{cid}/void", pathParams: { cid: params.cid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Void a site investment
   *
   * (v1.22.0) With a reason. 409 when its month is locked. Audited as finance.investment_voided.
   *
   * `POST /v1/finance/investments/{iid}/void` · needs `payment:write`
   */
  voidSiteInvestment(params: {
    /** The investment id. */
    iid: string;
    body: VoidSiteInvestmentBody;
  }, options?: RequestOptions): Promise<VoidSiteInvestmentResponse> {
    return this.transport.request<VoidSiteInvestmentResponse>({ method: "POST", path: "/v1/finance/investments/{iid}/void", pathParams: { iid: params.iid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Void a supplier bill
   *
   * (v1.29.0) With a reason; not once payments are recorded (void them first) or it was capitalised. Audited.
   *
   * `POST /v1/finance/bills/{id}/void` · needs `payment:write`
   */
  voidSupplierBill(params: {
    /** The bill id. */
    id: string;
    body: VoidSupplierBillBody;
  }, options?: RequestOptions): Promise<VoidSupplierBillResponse> {
    return this.transport.request<VoidSupplierBillResponse>({ method: "POST", path: "/v1/finance/bills/{id}/void", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Void a tax filing mark
   *
   * (v1.23.0) With a reason. Audited.
   *
   * `POST /v1/finance/tax/filings/{fid}/void` · needs `payment:write`
   */
  voidTaxFilingMark(params: {
    /** The filing id. */
    fid: string;
    body: VoidTaxFilingMarkBody;
  }, options?: RequestOptions): Promise<VoidTaxFilingMarkResponse> {
    return this.transport.request<VoidTaxFilingMarkResponse>({ method: "POST", path: "/v1/finance/tax/filings/{fid}/void", pathParams: { fid: params.fid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Void a transfer
   *
   * (v1.29.0) With a reason. Audited.
   *
   * `POST /v1/finance/cash/transfers/{id}/void` · needs `payment:write`
   */
  voidTransfer(params: {
    /** The transfer id. */
    id: string;
    body: VoidTransferBody;
  }, options?: RequestOptions): Promise<VoidTransferResponse> {
    return this.transport.request<VoidTransferResponse>({ method: "POST", path: "/v1/finance/cash/transfers/{id}/void", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Void a withholding record
   *
   * (v1.18.0) A mistaken record is voided with a reason, never deleted. payment:write; audited as finance.tax_withholding_voided.
   *
   * `POST /v1/finance/tax/withholdings/{wid}/void` · needs `payment:write`
   */
  voidWithholdingRecord(params: {
    /** The withholding record id. */
    wid: string;
    body: VoidWithholdingRecordBody;
  }, options?: RequestOptions): Promise<VoidWithholdingRecordResponse> {
    return this.transport.request<VoidWithholdingRecordResponse>({ method: "POST", path: "/v1/finance/tax/withholdings/{wid}/void", pathParams: { wid: params.wid }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Void a withholding slip
   *
   * (v1.32.0) reason (at least 3 characters). Audited.
   *
   * `POST /v1/finance/tax/slips/{id}/void`
   */
  voidWithholdingSlip(params: {
    /** The id. */
    id: string;
    body: VoidWithholdingSlipBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/tax/slips/{id}/void", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Weekly cash view (13 weeks)
   *
   * (v1.29.0) From today's position per currency: week by week what the gateway forecast expects in and out (settlements, fleet invoices, Hub positions, refunds, owner shares, PlugSure statements) and supplier bills by due date; the closing position, the lowest, the first week below the accounts' minimums, the largest flows.
   *
   * `GET /v1/finance/cash/weeks` · needs `payment:read`
   */
  weeklyCashView13Weeks(options?: RequestOptions): Promise<WeeklyCashView13WeeksResponse> {
    return this.transport.request<WeeklyCashView13WeeksResponse>({ method: "GET", path: "/v1/finance/cash/weeks", accept: "json" }, options);
  }

  /**
   * What a bank line could be
   *
   * (v1.18.0) Unmatched records of the same direction around the line's date, the nearest amount first (up to 20).
   *
   * `GET /v1/finance/bank-lines/{lid}/candidates` · needs `payment:read`
   */
  whatBankLineCouldBe(params: {
    /** The line id. */
    lid: string;
  }, options?: RequestOptions): Promise<WhatBankLineCouldBeResponse> {
    return this.transport.request<WhatBankLineCouldBeResponse>({ method: "GET", path: "/v1/finance/bank-lines/{lid}/candidates", pathParams: { lid: params.lid }, accept: "json" }, options);
  }

  /**
   * What customers owe, by age
   *
   * (v1.20.0) Fleet invoices not paid (and, for platform administrators, operators' statements to PlugSure, due 14 days after finalisation) with what is outstanding, days past due and the bucket (current, 1-30, 31-60, 61-90, 90+), the last note or promise, the last reminder, a write-off; aging totals per currency; the dunning settings; write-offs waiting for approval.
   *
   * `GET /v1/finance/collections` · needs `payment:read`
   */
  whatCustomersOweByAge(options?: RequestOptions): Promise<WhatCustomersOweByAgeResponse> {
    return this.transport.request<WhatCustomersOweByAgeResponse>({ method: "GET", path: "/v1/finance/collections", accept: "json" }, options);
  }

  /**
   * What each payment method costs
   *
   * (v1.16.0) Per gateway account the caller may see, over the period: per method the payments, amount, fees and VAT on fees, the average fee, the effective rate and the cost per 100,000 rupiah collected; for a Duitku account also what Duitku quotes today for 100,000 rupiah by method (getpaymentmethod; null when it does not answer).
   *
   * `GET /v1/finance/method-costs` · needs `payment:read`
   */
  whatEachPaymentMethodCosts(params?: {
    query?: {
      /** First day (platform time zone). Default: the first of the current month. */
      from?: string;
      /** Last day, inclusive. Default: today. At most 400 days. */
      to?: string;
    };
  }, options?: RequestOptions): Promise<WhatEachPaymentMethodCostsResponse> {
    return this.transport.request<WhatEachPaymentMethodCostsResponse>({ method: "GET", path: "/v1/finance/method-costs", query: params?.query, accept: "json" }, options);
  }

  /**
   * WhatsApp account events
   *
   * From the webhook: template status and quality changes, number quality, account updates (payloads trimmed). The last 500, at most 90 days.
   *
   * `GET /v1/whatsapp/events` · needs `platform:admin`
   */
  whatsappAccountEvents(params?: {
    query?: {
      limit?: number;
    };
  }, options?: RequestOptions): Promise<WhatsappAccountEventsResponse> {
    return this.transport.request<WhatsappAccountEventsResponse>({ method: "GET", path: "/v1/whatsapp/events", query: params?.query, accept: "json" }, options);
  }

  /**
   * WhatsApp Business dashboard
   *
   * The connection: the platform's sign-in codes integration on the WhatsApp Cloud API (main channel, else fallback), read from the Graph API (display number, verified name, quality rating, messaging limit tier, name status; a Graph API failure is `connection.error`, never an error status), the webhook (URL and verify token for the Meta app, the fields to subscribe, when it last delivered an event and a status), the templates PlugSure needs with their status, and statistics for the last 7 or 30 days in the platform time zone (ALERT_TIMEZONE): the ledger plus the operator alerts sent from the same number. Each message counts once at its latest status; `sent` in `daily` includes accepted. deliveryRate = (delivered + read) / total; readRate = read / (delivered + read).
   *
   * `GET /v1/whatsapp/overview` · needs `platform:admin`
   */
  whatsappBusinessDashboard(params?: {
    query?: {
      days?: 7 | 30;
    };
  }, options?: RequestOptions): Promise<WhatsappBusinessDashboardResponse> {
    return this.transport.request<WhatsappBusinessDashboardResponse>({ method: "GET", path: "/v1/whatsapp/overview", query: params?.query, accept: "json" }, options);
  }

  /**
   * WhatsApp messages
   *
   * Newest first: the ledger and the WhatsApp alerts sent from the same number, numbers masked. Kept 180 days. Page with `before` = the `nextBefore` of the previous page.
   *
   * `GET /v1/whatsapp/messages` · needs `platform:admin`
   */
  whatsappMessages(params?: {
    query?: {
      purpose?: "otp" | "alert" | "test" | "other" | "support";
      status?: "accepted" | "sent" | "delivered" | "read" | "failed";
      /** Only messages before this time. */
      before?: string;
      limit?: number;
    };
  }, options?: RequestOptions): Promise<WhatsappMessagesResponse> {
    return this.transport.request<WhatsappMessagesResponse>({ method: "GET", path: "/v1/whatsapp/messages", query: params?.query, accept: "json" }, options);
  }

  /**
   * WhatsApp message templates
   *
   * The WhatsApp Business Account's templates (up to 500), the ones PlugSure sends marked, and a link to WhatsApp Manager. 409 when WhatsApp is not configured, or no WhatsApp Business Account ID is saved (`code: no_waba`); 502 with Meta's message when the Graph API refuses.
   *
   * `GET /v1/whatsapp/templates` · needs `platform:admin`
   */
  whatsappMessageTemplates(options?: RequestOptions): Promise<WhatsappMessageTemplatesResponse> {
    return this.transport.request<WhatsappMessageTemplatesResponse>({ method: "GET", path: "/v1/whatsapp/templates", accept: "json" }, options);
  }

  /**
   * WhatsApp support inbox
   *
   * Customers who wrote to the platform's WhatsApp number, newest first, with the last message. Filter by `handler`; page with `before` = the `nextBefore` of the previous page. `assistant` says whether the AI support integration is set up and its mode. Messages are kept 90 days.
   *
   * `GET /v1/whatsapp/conversations` · needs `platform:admin`
   */
  whatsappSupportInbox(params?: {
    query?: {
      handler?: "ai" | "human" | "closed";
      /** Only conversations last active before this time. */
      before?: string;
      limit?: number;
    };
  }, options?: RequestOptions): Promise<WhatsappSupportInboxResponse> {
    return this.transport.request<WhatsappSupportInboxResponse>({ method: "GET", path: "/v1/whatsapp/conversations", query: params?.query, accept: "json" }, options);
  }

  /**
   * Withdraw a close sign-off
   *
   * (v1.32.0) While the month is open. Audited.
   *
   * `POST /v1/finance/close/{month}/steps/{step}/revoke`
   */
  withdrawCloseSignOff(params: {
    /** YYYY-MM. */
    month: string;
    /** The step. */
    step: string;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "POST", path: "/v1/finance/close/{month}/steps/{step}/revoke", pathParams: { month: params.month, step: params.step }, accept: "json" }, options);
  }

  /**
   * Withdraw my dispute (eMSP side)
   *
   * Only on a platform with PlugSure Hub enabled (`HUB_ENABLED=true`); otherwise 404.
   *
   * `POST /v1/roaming/hub/clearing/disputes/{id}/withdraw` · needs `roaming:write`
   */
  withdrawMyDisputeEMSPSide(params: {
    id: string;
    body: WithdrawMyDisputeEMSPSideBody;
  }, options?: RequestOptions): Promise<WithdrawMyDisputeEMSPSideResponse> {
    return this.transport.request<WithdrawMyDisputeEMSPSideResponse>({ method: "POST", path: "/v1/roaming/hub/clearing/disputes/{id}/withdraw", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * Withholding slips
   *
   * (v1.32.0) A month's (default last month) withholding slips (bukti potong) for PPh 21, 23 and 26: payee, gross, DPP, rate, tax, status and number; totals by kind; how many withholding bills are on no slip.
   *
   * `GET /v1/finance/tax/slips`
   */
  withholdingSlips(params?: {
    query?: {
      month?: string;
    };
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/tax/slips", query: params?.query, accept: "json" }, options);
  }

  /**
   * Withholding slips for e-Bupot
   *
   * (v1.32.0) The month's live slips as a workbook laid out for the e-Bupot import: PPh 21 and 26 on one sheet, PPh 23 on the other.
   *
   * `GET /v1/finance/tax/slips/{month}/ebupot`
   */
  withholdingSlipsForEBupot(params: {
    /** YYYY-MM. */
    month: string;
  }, options?: RequestOptions): Promise<string> {
    return this.transport.request<string>({ method: "GET", path: "/v1/finance/tax/slips/{month}/ebupot", pathParams: { month: params.month }, accept: "text" }, options);
  }

  /**
   * Work order
   *
   * (v1.34.0) With the parts issued, the contractor bills and the warranty claims.
   *
   * `GET /v1/finance/maintenance/{id}`
   */
  workOrder(params: {
    /** The id. */
    id: string;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/maintenance/{id}", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Work orders
   *
   * (v1.34.0) Work orders (status to filter) with their cost: labour, parts, contractors, accrued, warranty recovered, net.
   *
   * `GET /v1/finance/maintenance`
   */
  workOrders(params?: {
    query?: {
      status?: string;
    };
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "GET", path: "/v1/finance/maintenance", query: params?.query, accept: "json" }, options);
  }

  /**
   * Write a report pack commentary
   *
   * (v1.32.0) commentary by section (summary, results, cash, scorecard, sites, payables), up to 4000 characters each; empty removes it. Draft or in review only.
   *
   * `PUT /v1/finance/report-packs/{id}/commentary`
   */
  writeReportPackCommentary(params: {
    /** The id. */
    id: string;
    body: WriteReportPackCommentaryBody;
  }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.transport.request<Record<string, unknown>>({ method: "PUT", path: "/v1/finance/report-packs/{id}/commentary", pathParams: { id: params.id }, body: params.body, bodyType: "json", accept: "json" }, options);
  }

  /**
   * A Xendit report
   *
   * (v1.16.0) Its state, asked of Xendit while pending. link=true on a completed one: Xendit's download link (asked again, as links expire); audited as finance.report_downloaded.
   *
   * `GET /v1/finance/accounts/{id}/reports/{rid}` · needs `payment:read`
   */
  xenditReport(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
    /** The report id. */
    rid: string;
    query?: {
      link?: "true";
    };
  }, options?: RequestOptions): Promise<XenditReportResponse> {
    return this.transport.request<XenditReportResponse>({ method: "GET", path: "/v1/finance/accounts/{id}/reports/{rid}", pathParams: { id: params.id, rid: params.rid }, query: params.query, accept: "json" }, options);
  }

  /**
   * Xendit reports
   *
   * (v1.16.0) Reports requested from Xendit for this account (newest 50).
   *
   * `GET /v1/finance/accounts/{id}/reports` · needs `payment:read`
   */
  xenditReports(params: {
    /** The payments account (integration) id, from GET /v1/finance/accounts. */
    id: string;
  }, options?: RequestOptions): Promise<XenditReportsResponse> {
    return this.transport.request<XenditReportsResponse>({ method: "GET", path: "/v1/finance/accounts/{id}/reports", pathParams: { id: params.id }, accept: "json" }, options);
  }

  /**
   * Year-end summary
   *
   * (v1.24.0) For a year (default last year): per month and per site revenue, energy, shared costs, depreciation and contribution, months locked; each owner's share, paid and outstanding; PPh 23 withheld with the records without a bukti potong; tax filings marked.
   *
   * `GET /v1/finance/year-end` · needs `payment:read`
   */
  yearEndSummary(params?: {
    query?: {
      year?: number;
    };
  }, options?: RequestOptions): Promise<YearEndSummaryResponse> {
    return this.transport.request<YearEndSummaryResponse>({ method: "GET", path: "/v1/finance/year-end", query: params?.query, accept: "json" }, options);
  }
}
