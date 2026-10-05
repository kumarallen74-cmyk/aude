import { type Op, type Schema, ref, arrayOf, nullable, OK } from '../types.js';

/**
 * Console routes, part A: src/api/console-routes.ts from the top of the file to
 * POST /v1/users/:id/reset-password (auth, reference data, dashboard, refunds,
 * availability, webhooks, alert routing, statements and billing, site owners,
 * platform billing, alert acknowledge/resolve, roles and users).
 *
 * Note on numbers: db/pool.ts parses INT8 (bigint, count(*)) as a JS number, so
 * counts and ::bigint sums are numbers. INTEGER columns are numbers too.
 */

// ─────────────────────────────────────────── building blocks

const str: Schema = { type: 'string' };
const strN: Schema = nullable('string');
const int: Schema = { type: 'integer' };
const intN: Schema = nullable('integer');
const num: Schema = { type: 'number' };
const bool: Schema = { type: 'boolean' };
const boolN: Schema = nullable('boolean');
const uuid: Schema = { type: 'string', format: 'uuid' };
const uuidN: Schema = nullable('string', { format: 'uuid' });
const dt: Schema = { type: 'string', format: 'date-time' };
const dtN: Schema = nullable('string', { format: 'date-time' });
const month: Schema = { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$', description: 'A calendar month, YYYY-MM.' };
const obj = (properties: Record<string, Schema>, required: string[] = [], extra: Schema = {}): Schema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  ...extra,
});

const WEBHOOK_EVENTS = [
  'session.started',
  'session.ended',
  'cdr.created',
  'charge_point.connected',
  'charge_point.disconnected',
  'charge_point.booted',
  'connector.status_changed',
  'alert.raised',
  'refund.due',
  'refund.completed',
  'firmware.status',
];
const ROLE_NAMES = ['super_admin', 'cpo_operations_manager', 'site_host_landlord', 'field_technician', 'financial_auditor', 'site_owner', 'fleet_customer'];

/** Statements are per currency (IDR, MYR, SGD): one each, never added across currencies. */
const currencyQuery = { name: 'currency', description: 'Statement currency: IDR (default), MYR or SGD.', schema: { type: 'string', enum: ['IDR', 'MYR', 'SGD'] } };
const monthQuery = {
  name: 'month',
  description: 'Statement month, YYYY-MM. Defaults to the current month in the billing time zone (Asia/Jakarta). Anything else is a 400.',
  schema: month,
};

// ─────────────────────────────────────────── component schemas

export const schemas: Record<string, Schema> = {
  OrgSettings: obj(
    {
      name: str,
      homeCountry: { ...str, description: 'ID, MY or SG.' },
      timezone: { ...str, description: 'Reporting time zone (IANA).' },
      defaultLocale: { ...str, enum: ['id', 'en'] },
      multiCountry: { ...bool, description: 'Whether Malaysia and Singapore are enabled on this platform.' },
      indonesiaPkp: obj({ registered: bool, npwp: strN }, ['registered', 'npwp'], { description: 'Indonesia: the PKP status billing applies (organisation record), shown when no registration row exists.' }),
      sitesByCountry: { type: 'object', additionalProperties: int, description: 'Active sites per country code.' },
      countries: arrayOf(obj({ code: str, name: str, currency: str, timezones: arrayOf(str), scheme: str, displayPricesInclTax: bool })),
      taxRegistrations: arrayOf(obj({
        id: uuid, countryCode: str, scheme: { ...str, description: 'ID_PKP, MY_SST or SG_GST.' }, registrationNo: strN, registered: bool, evChargingTaxable: bool,
        rateBps: intN, effectiveFrom: { ...str, format: 'date' }, effectiveTo: nullable('string', { format: 'date' }), createdAt: dt, createdBy: strN,
      }, ['id', 'countryCode', 'scheme', 'registered', 'effectiveFrom'])),
    },
    ['homeCountry', 'timezone', 'defaultLocale', 'countries', 'taxRegistrations'],
  ),
  // ---- auth
  AuthLoginResult: obj(
    {
      ok: { type: 'boolean', const: true },
      user: obj({ id: uuid, name: str, email: str }, ['id', 'name', 'email']),
      mustChangePassword: { type: 'boolean', description: 'True after an administrator issued a one-time password; every other route answers 403 until it is changed.' },
      mfaRequired: {
        type: 'boolean',
        description: 'The password was right and the account has two-step verification: the session is pending, and only POST /v1/auth/mfa/verify (and sign-out) answer until the code is given.',
      },
    },
    ['ok', 'user', 'mustChangePassword'],
  ),
  MfaStatus: obj(
    {
      enabled: bool,
      enabledAt: strN,
      recoveryCodesLeft: int,
      required: { type: 'boolean', description: 'Two-step verification is required for this account (an administrator, with CONSOLE_MFA_REQUIRED on).' },
    },
    ['enabled', 'enabledAt', 'recoveryCodesLeft', 'required'],
  ),
  MfaEnrolment: obj(
    {
      secret: { type: 'string', description: 'The TOTP secret, base32 — for typing into an app that cannot scan.' },
      uri: { type: 'string', description: 'otpauth://totp/… (SHA1, 6 digits, 30 s).' },
      qrDataUrl: { type: 'string', description: 'The URI as a PNG QR code (data: URL).' },
    },
    ['secret', 'uri', 'qrDataUrl'],
  ),
  AuthMe: obj(
    {
      user: obj(
        {
          id: str,
          name: str,
          email: strN,
          mustChangePassword: bool,
          mfa: { anyOf: [ref('MfaStatus'), { type: 'null' }], description: 'Two-step verification of the signed-in operator.' },
          mfaEnrolmentRequired: { type: 'boolean', description: 'Required and not set up: every route but enrolment answers 403 until it is.' },
          mfaViaMicrosoft: { type: 'boolean', description: 'This session signed in with Microsoft and Microsoft reported multi-factor authentication: the console’s two-step verification counts as done.' },
          signedInWith: { ...nullable('string'), enum: ['password', 'microsoft', null], description: 'How this console session signed in (null for an API key).' },
        },
        ['id', 'name', 'email'],
        { description: 'The signed-in operator. For an API key or the development bypass: a synthetic user with a null email.' },
      ),
      org: obj({
        id: uuid, name: str, pkp: bool, npwp: strN,
        homeCountry: { type: 'string', enum: ['ID', 'MY', 'SG'], description: 'The organisation\'s home country (default for new sites).' },
        timezone: { type: 'string', description: 'The organisation\'s reporting time zone (IANA), e.g. Asia/Jakarta.' },
        defaultLocale: { type: 'string', enum: ['id', 'en'] },
      }, ['id']),
      roles: arrayOf(
        obj(
          {
            name: str,
            scope_type: { type: 'string', description: 'org, site, owner or fleet' },
            scope_id: uuidN,
            label: str,
          },
          ['name', 'scope_type', 'scope_id', 'label'],
        ),
      ),
      permissions: arrayOf(str),
      visibleSites: { ...nullable('array'), items: uuid, description: 'Site ids the caller may read; null = every site of the organisation.' },
      owners: arrayOf(obj({ id: uuid, name: str, legal_name: strN }, ['id', 'name'])),
      fleets: { ...arrayOf(obj({ id: uuid, name: str, legal_name: strN }, ['id', 'name'])), description: 'Fleet customer portal: the fleet accounts this user belongs to (the console then shows only the portal).' },
      features: obj(
        {
          multiCountry: { ...bool, description: 'MULTI_COUNTRY: Malaysian and Singapore sites may be created.' },
          vault: bool,
          bridge: bool,
          publicBaseUrl: strN,
          ocppPublicUrl: strN,
          supportedVersions: arrayOf(str),
          minSecurityProfile: num,
          effectivePpnPct: num,
          wbp: obj({ start: str, end: str }, ['start', 'end']),
          env: str,
          version: { type: 'string', description: 'The installed PlugSure release (package.json version).' },
          microsoftSignIn: { type: 'boolean', description: '“Sign in with Microsoft” is configured on this installation (MS_CLIENT_ID).' },
        },
        ['vault', 'bridge', 'supportedVersions', 'minSecurityProfile', 'effectivePpnPct', 'wbp', 'env', 'version'],
      ),
      consoleBrand: { anyOf: [ref('ConsoleBrandView'), { type: 'null' }], description: 'The organisation’s own console brand (v1.5.0); null for the PlugSure console.' },
    },
    ['user', 'org', 'roles', 'permissions', 'visibleSites', 'owners', 'features'],
  ),

  // ---- reference data
  MetaCodeLabel: obj({ code: str, label: str }, ['code', 'label']),
  MetaConsoleRole: obj(
    { name: str, label: str, siteScoped: bool, ownerScoped: bool, description: str },
    ['name', 'label', 'siteScoped', 'description'],
  ),
  Meta: obj(
    {
      plnTariffGroups: arrayOf(ref('MetaCodeLabel')),
      spkluSchemes: arrayOf(str),
      connectorTypes: arrayOf(obj({ code: str, label: str, current: { type: 'string', enum: ['AC', 'DC'] } }, ['code', 'label', 'current'])),
      vendors: arrayOf(str),
      accountTypes: arrayOf(ref('MetaCodeLabel')),
      configCategories: arrayOf(str),
      firmwareStages: arrayOf(str),
      consoleRoles: arrayOf(ref('MetaConsoleRole')),
      paymentStatuses: arrayOf(str),
      trTmCliffKva: num,
      regulatory: obj(
        {
          serviceFeeCeilingIdr: obj(
            { slow: nullable('number'), medium: nullable('number'), fast: nullable('number'), ultrafast: nullable('number') },
            [],
            { description: 'Per-session service-fee ceiling by charger class; null = unregulated.' },
          ),
          energyCeilingIdrPerKwh: num,
          layananKhususBase: num,
          layananKhususNMax: num,
          idleFeeCapIdr: num,
          pbjtMaxBps: num,
        },
        ['serviceFeeCeilingIdr', 'energyCeilingIdrPerKwh', 'layananKhususBase', 'layananKhususNMax', 'idleFeeCapIdr', 'pbjtMaxBps'],
      ),
    },
    [
      'plnTariffGroups', 'spkluSchemes', 'connectorTypes', 'vendors', 'accountTypes', 'configCategories',
      'firmwareStages', 'consoleRoles', 'paymentStatuses', 'trTmCliffKva', 'regulatory',
    ],
  ),

  // ---- dashboard
  Dashboard: obj(
    {
      chargers: obj({ total: int, online: int, pending: int, faulted: int }, ['total', 'online', 'pending', 'faulted']),
      connectors: {
        type: 'object',
        additionalProperties: int,
        description: 'Connector count by OCPP status (Available, Charging, Faulted, …).',
      },
      today: {
        ...nullable('object'),
        description: 'Today (Asia/Jakarta) so far. Null when the caller lacks session:read.',
        properties: { sessions: int, energy_wh: int, revenue_minor: int, active: int },
        required: ['sessions', 'energy_wh', 'revenue_minor', 'active'],
      },
      series: arrayOf(
        obj(
          { day: { type: 'string', format: 'date' }, energy_wh: int, revenue_minor: int, sessions: int },
          ['day', 'energy_wh', 'revenue_minor', 'sessions'],
        ),
      ),
      alerts: obj({ critical: int, warning: int }, ['critical', 'warning']),
    },
    ['chargers', 'connectors', 'today', 'series', 'alerts'],
  ),

  // ---- card holds
  CardHold: obj(
    {
      id: uuid,
      kind: { type: 'string', enum: ['card_hold', 'postpay'], description: 'card_hold: a card pre-authorisation; postpay: a linked e-wallet charged after the session (nothing held at the acquirer).' },
      channel: strN,
      state: { type: 'string', enum: ['held', 'capturing', 'captured', 'capture_failed', 'releasing', 'released', 'release_failed'] },
      heldMinor: intN, captureMinor: intN, capturedMinor: intN, attempts: int, error: strN, nextAttemptAt: dtN, authorisedAt: dtN, settledAt: dtN,
      expired: { type: 'boolean', description: 'The card authorisation expired at the acquirer before it was captured: nothing was taken from the card and it cannot be retried. The driver can pay it in the app (paidInApp), or the operator collects it another way or writes it off.' },
      paidInApp: { type: 'boolean', description: 'An expired card hold, or a post-pay session whose e-wallet link ended, that the driver has since paid in the app.' },
      provider: str, providerRef: strN, createdAt: dt, sessionId: { type: ['string', 'null'], format: 'uuid' }, site: strN, charger: strN,
    },
    ['id', 'kind', 'state', 'heldMinor', 'attempts', 'provider', 'createdAt'],
  ),

  // ---- refunds
  RefundSummary: obj(
    { due_count: int, due_minor: { ...int, description: 'Rupiah (IDR); other currencies are in by_currency.' }, failed_count: int, refunded_30d_minor: int,
      by_currency: arrayOf(obj({ currency: str, due_minor: int, refunded_30d_minor: int })) },
    ['due_count', 'due_minor', 'failed_count', 'refunded_30d_minor'],
  ),
  RefundRow: obj(
    {
      id: uuid,
      refund_state: { type: 'string', enum: ['due', 'processing', 'refunded', 'failed'] },
      refund_due_minor: intN,
      refunded_minor: intN,
      refund_reason: strN,
      refund_method: { type: ['string', 'null'], enum: ['provider', 'manual', null] },
      refund_ref: strN,
      refund_error: strN,
      refund_requested_at: dtN,
      refunded_at: dtN,
      provider: str,
      provider_ref: strN,
      method: str,
      amount_captured_minor: intN,
      paid_at: dt,
      session_id: uuidN,
      site_name: strN,
      ocpp_identity: strN,
      connector_no: intN,
      driver_phone: strN,
      refunded_by_name: strN,
    },
    ['id', 'refund_state', 'provider', 'method', 'paid_at'],
  ),
  RefundOutcome: obj(
    {
      ok: { type: 'boolean', const: true },
      state: { type: 'string', enum: ['processing', 'refunded'] },
      refundRef: str,
    },
    ['ok', 'state'],
  ),

  // ---- availability
  AvailabilityRow: obj(
    {
      chargePointId: uuid,
      ocppIdentity: str,
      displayName: strN,
      siteId: uuid,
      siteName: str,
      connectors: int,
      online: bool,
      uptimePct: { ...nullable('number'), description: 'Percent, one decimal. Null when the charger has no time in the window.' },
      outages: int,
      offlineMinutes: int,
      longestOutageMin: int,
      sessions: int,
      energyKwh: num,
      revenueMinor: num,
      currency: { ...str, description: 'The site\'s currency (IDR, MYR or SGD).' },
      utilisationPct: { ...nullable('number'), description: 'Connector-time in sessions over connector-time in the window, percent.' },
    },
    [
      'chargePointId', 'ocppIdentity', 'displayName', 'siteId', 'siteName', 'connectors', 'online', 'uptimePct',
      'outages', 'offlineMinutes', 'longestOutageMin', 'sessions', 'energyKwh', 'revenueMinor', 'utilisationPct',
    ],
  ),
  AvailabilityReport: obj(
    { from: dt, to: dt, rows: arrayOf(ref('AvailabilityRow')) },
    ['from', 'to', 'rows'],
  ),

  // ---- webhooks
  WebhookEndpoint: obj(
    {
      id: uuid,
      url: str,
      description: strN,
      events: { type: 'array', items: str, description: "Subscribed event types; ['*'] = every event." },
      state: { type: 'string', enum: ['active', 'paused', 'disabled'] },
      created_at: dt,
      updated_at: dt,
      consecutive_failures: int,
      last_success_at: dtN,
      last_failure_at: dtN,
      last_error: strN,
    },
    ['id', 'url', 'events', 'state', 'created_at', 'updated_at', 'consecutive_failures'],
  ),
  WebhookEndpointRow: {
    allOf: [
      ref('WebhookEndpoint'),
      obj({ pending: int, failed: int, delivered_24h: int }, ['pending', 'failed', 'delivered_24h']),
    ],
  },
  WebhookEndpointInput: obj(
    {
      url: { type: 'string', description: 'https in production; must be publicly reachable; no credentials in the URL.' },
      description: { type: 'string', maxLength: 200 },
      events: {
        type: 'array',
        items: { type: 'string', enum: [...WEBHOOK_EVENTS, '*'] },
        description: "Event types to receive. Empty or containing '*' = every event.",
      },
    },
  ),
  WebhookSendResult: obj(
    { ok: bool, status: intN, error: strN, ms: int },
    ['ok', 'status', 'error', 'ms'],
  ),
  WebhookDelivery: obj(
    {
      id: int,
      event_id: uuid,
      event_type: str,
      state: { type: 'string', enum: ['pending', 'delivered', 'failed'] },
      attempts: int,
      next_attempt_at: dt,
      last_status: intN,
      last_error: strN,
      created_at: dt,
      delivered_at: dtN,
      payload: { type: 'object', description: 'The event data as sent in the envelope `data` field.' },
    },
    ['id', 'event_id', 'event_type', 'state', 'attempts', 'next_attempt_at', 'created_at', 'payload'],
  ),

  // ---- alert routing
  AlertRoutingChannel: obj(
    {
      kind: { type: 'string', enum: ['email', 'whatsapp', 'sms'] },
      enabled: bool,
      config: {
        type: 'object',
        description: 'Non-secret settings. E-mail: host, port, security, username, fromAddress, fromName. WhatsApp: apiBase, phoneNumberId, templateName, templateLang. SMS: provider (twilio | zenziva | http), accountSid, from, messagingServiceSid, baseUrl (Twilio), userkey, endpoint (Zenziva), url (your gateway).',
      },
      has_secret: { type: 'boolean', description: 'Whether an SMTP password / WhatsApp token / SMS credential is stored. The secret itself is never returned.' },
      webhook: {
        type: ['object', 'null'],
        description: 'WhatsApp only: where Meta sends delivery statuses (delivered, read, failed). Set this URL (PUBLIC_BASE_URL + path) and the verify token in the Meta app webhook settings (field: messages), and save the app secret so signatures can be checked. Null until the channel is saved.',
        properties: { path: str, url: { type: 'string', description: 'The full callback URL on the public address (PUBLIC_BASE_URL).' }, verifyToken: str, hasAppSecret: bool },
      },
      last_test_at: dtN,
      last_test_ok: boolN,
      last_error: strN,
      updated_at: dt,
    },
    ['kind', 'enabled', 'config', 'has_secret'],
  ),
  AlertRoutingContact: obj(
    {
      id: uuid,
      name: str,
      email: strN,
      whatsapp: { ...strN, description: 'E.164 digits without +, e.g. 6281234567890.' },
      sms: { ...strN, description: 'SMS number (E.164 digits without +); null = SMS goes to the WhatsApp number.' },
      active: bool,
      created_at: dt,
    },
    ['id', 'name', 'email', 'whatsapp', 'active'],
  ),
  AlertRoutingRule: obj(
    {
      id: uuid,
      org_id: uuid,
      name: str,
      enabled: bool,
      min_severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
      kinds: { type: 'array', items: str, description: 'Alert kinds (or `prefix.*`); empty = every kind.' },
      site_ids: { type: 'array', items: uuid, description: 'Empty = every site, and alerts with no site.' },
      channels: arrayOf({ type: 'string', enum: ['email', 'whatsapp', 'sms'] }),
      contact_ids: arrayOf(uuid),
      rota_ids: { type: 'array', items: uuid, description: 'On-call rotas: whoever is on duty when the alert is routed is notified too.' },
      sms_fallback: { type: 'boolean', description: 'When a WhatsApp message fails (refused, or reported failed by Meta), send the same by SMS.' },
      notify_resolved: bool,
      quiet_start: { ...strN, description: 'Local time (HH:MM:SS) in the alert time zone.' },
      quiet_end: strN,
      escalate_after_min: intN,
      escalate_contact_ids: arrayOf(uuid),
      escalate_rota_ids: arrayOf(uuid),
      created_at: dt,
      updated_at: dt,
    },
    [
      'id', 'name', 'enabled', 'min_severity', 'kinds', 'site_ids', 'channels', 'contact_ids', 'notify_resolved',
      'quiet_start', 'quiet_end', 'escalate_after_min', 'escalate_contact_ids',
    ],
  ),
  AlertRoutingRuleInput: obj(
    {
      name: { type: 'string', maxLength: 120 },
      enabled: { type: 'boolean', default: true },
      minSeverity: { type: 'string', enum: ['info', 'warning', 'critical'], default: 'critical' },
      kinds: { type: 'array', items: str, description: 'Alert kinds from GET /v1/alert-routing `kinds`, or a `prefix.*` wildcard. Empty = every kind.' },
      siteIds: { type: 'array', items: uuid, description: 'Sites of this organisation. Empty = every site.' },
      channels: { type: 'array', items: { type: 'string', enum: ['email', 'whatsapp', 'sms'] }, minItems: 1 },
      contactIds: { type: 'array', items: uuid, description: 'People to notify. Required unless rotaIds is given.' },
      rotaIds: { type: 'array', items: uuid, description: 'On-call rotas whose on-duty person is notified.' },
      smsFallback: { type: 'boolean', default: false, description: 'When a WhatsApp message fails, send it by SMS (needs whatsapp in channels and the SMS channel set up).' },
      notifyResolved: { type: 'boolean', default: true },
      quietStart: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: 'HH:MM; give both quietStart and quietEnd, or neither.' },
      quietEnd: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
      escalateAfterMin: { type: ['integer', 'null'], minimum: 1, maximum: 1440 },
      escalateContactIds: { type: 'array', items: uuid, description: 'People to escalate to; with escalateAfterMin, this or escalateRotaIds is required.' },
      escalateRotaIds: { type: 'array', items: uuid, description: 'Rotas whose on-duty person is escalated to.' },
    },
    ['name', 'channels'],
  ),
  AlertRoutingContactInput: obj(
    {
      name: { type: 'string', maxLength: 120 },
      email: { type: 'string', description: 'E-mail address. At least one of email and whatsapp is required.' },
      whatsapp: { type: 'string', description: 'WhatsApp number, e.g. 0812 3456 7890 or +62 812 3456 7890; stored as 6281234567890.' },
      sms: { type: 'string', description: 'SMS number when it differs from the WhatsApp number. At least one of email, whatsapp and sms is required.' },
      active: { type: 'boolean', default: true },
    },
    ['name'],
  ),
  AlertRoutingNotification: obj(
    {
      id: int,
      alert_id: uuidN,
      channel: { type: 'string', enum: ['email', 'whatsapp', 'sms'] },
      destination: str,
      stage: { type: 'string', enum: ['raised', 'escalation', 'resolved', 'storm', 'test'] },
      state: { type: 'string', enum: ['pending', 'sent', 'failed', 'suppressed'] },
      attempts: int,
      next_attempt_at: dt,
      last_error: strN,
      provider_ref: strN,
      created_at: dt,
      sent_at: dtN,
      delivery: { type: ['string', 'null'], enum: ['delivered', 'read', 'failed', null], description: 'WhatsApp: what Meta reported after accepting the message (sent = accepted only).' },
      delivered_at: dtN,
      read_at: dtN,
      delivery_error: strN,
      fallback_of: { ...intN, description: 'An SMS sent because this WhatsApp notification (id) failed.' },
      kind: strN,
      severity: strN,
      message: strN,
      contact_name: strN,
      rule_name: strN,
    },
    ['id', 'alert_id', 'channel', 'destination', 'stage', 'state', 'attempts', 'next_attempt_at', 'created_at'],
  ),

  AlertRota: obj(
    {
      id: uuid,
      name: str,
      member_ids: { type: 'array', items: uuid, description: 'Alert contacts in rotation order.' },
      shift: { type: 'string', enum: ['daily', 'weekly'] },
      handover_time: { type: 'string', description: 'HH:MM, local time (the alert time zone).' },
      starts_on: { type: 'string', format: 'date', description: 'The first shift starts at handover_time on this day, with the first member.' },
      duty: obj({ contactId: uuidN, override: bool, shiftEnds: dtN, nextContactId: uuidN }, ['contactId', 'override', 'shiftEnds', 'nextContactId']),
      overrides: arrayOf(obj({ id: uuid, rota_id: uuid, contact_id: uuid, starts_at: dt, ends_at: dt, note: strN, created_at: dt }, ['id', 'contact_id', 'starts_at', 'ends_at'])),
      created_at: dt,
    },
    ['id', 'name', 'member_ids', 'shift', 'handover_time', 'starts_on', 'duty', 'overrides'],
  ),
  AlertRotaInput: obj(
    {
      name: { type: 'string', maxLength: 120 },
      memberIds: { type: 'array', items: uuid, minItems: 1, description: 'Alert contacts, in the order they take shifts.' },
      shift: { type: 'string', enum: ['daily', 'weekly'], default: 'weekly' },
      handoverTime: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', default: '08:00' },
      startsOn: { type: 'string', format: 'date' },
    },
    ['name', 'memberIds', 'startsOn'],
  ),

  // ---- statements
  StatementTier: obj({ name: str, upToMinor: nullable('number'), rateBps: int }, ['name', 'upToMinor', 'rateBps']),
  StatementPlan: obj(
    {
      tiers: arrayOf(ref('StatementTier')),
      tierMode: { type: 'string', enum: ['whole', 'marginal'] },
      minPerChargerAcMinor: num,
      minPerChargerDcMinor: num,
      privateFeeAcMinor: num,
      privateFeeDcMinor: num,
      mdrBorneBy: { type: 'string', enum: ['platform', 'site_owner'] },
      prorate: bool,
    },
    ['tiers', 'tierMode', 'minPerChargerAcMinor', 'minPerChargerDcMinor', 'privateFeeAcMinor', 'privateFeeDcMinor', 'mdrBorneBy', 'prorate'],
  ),
  StatementPlanInput: obj(
    {
      tiers: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: obj({ name: str, upToMinor: nullable('number'), rateBps: { type: 'integer', minimum: 0, maximum: 5000 } }, ['rateBps']),
        description: 'Ascending upper bounds (exclusive); the last tier has upToMinor null.',
      },
      tierMode: { type: 'string', enum: ['whole', 'marginal'] },
      minPerChargerAcMinor: { type: 'number', minimum: 0 },
      minPerChargerDcMinor: { type: 'number', minimum: 0 },
      privateFeeAcMinor: { type: 'number', minimum: 0 },
      privateFeeDcMinor: { type: 'number', minimum: 0 },
      mdrBorneBy: { type: 'string', enum: ['platform', 'site_owner'] },
      prorate: bool,
    },
    [],
    { description: 'Fields left out take the published rates.' },
  ),
  StatementChargerLine: obj(
    {
      chargePointId: uuid,
      ocppIdentity: str,
      displayName: strN,
      siteId: uuid,
      kind: { type: 'string', enum: ['AC', 'DC'] },
      activeFraction: num,
      activeDays: num,
      sessions: int,
      energyWh: num,
      gtvMinor: num,
      localTaxMinor: num,
      taxMinor: num,
      grossMinor: num,
      mdrMinor: num,
      inReview: int,
      commissionMinor: num,
      minimumMinor: num,
      topUpMinor: num,
      privateFeeMinor: num,
      feeMinor: num,
    },
    ['chargePointId', 'ocppIdentity', 'siteId', 'kind', 'sessions'],
  ),
  StatementSiteLine: obj(
    {
      siteId: uuid,
      name: str,
      model: { type: 'string', enum: ['public', 'private'] },
      tier: strN,
      rateBps: nullable('number'),
      sessions: int,
      energyKwh: num,
      gtvMinor: num,
      localTaxMinor: num,
      taxMinor: num,
      grossMinor: num,
      commissionMinor: num,
      minimumTopUpMinor: num,
      privateFeeMinor: num,
      feeMinor: num,
      mdrMinor: num,
      mdrCreditMinor: num,
      platformShareMinor: num,
      ownerShareMinor: num,
      warnings: arrayOf(str),
      chargers: arrayOf(ref('StatementChargerLine')),
    },
    ['siteId', 'name', 'model', 'chargers'],
  ),
  StatementTotals: obj(
    {
      sessions: int,
      energyKwh: num,
      gtvMinor: num,
      localTaxMinor: num,
      ppnCollectedMinor: num,
      grossCollectedMinor: num,
      commissionMinor: num,
      minimumTopUpMinor: num,
      privateFeeMinor: num,
      feesMinor: num,
      mdrEstimateMinor: num,
      mdrCreditMinor: num,
      netMinor: num,
      taxBaseMinor: num,
      taxMinor: num,
      totalMinor: num,
      pph23Minor: num,
      platformShareMinor: num,
      ownerShareMinor: num,
    },
    ['sessions', 'gtvMinor', 'netMinor', 'taxMinor', 'totalMinor'],
  ),
  StatementParty: obj({ name: str, npwp: strN, address: strN }, ['name']),
  Statement: obj(
    {
      period: month,
      daysInMonth: int,
      status: { type: 'string', enum: ['draft', 'final'] },
      projected: { type: 'boolean', description: 'Draft of the current month: minimums and platform fees are projected to month end.' },
      number: { ...strN, description: 'Statement number once finalised (e.g. PSC-202608-ACME); null for a draft.' },
      finalisedAt: { ...dt, description: 'Present on a final statement.' },
      plan: ref('StatementPlan'),
      sites: arrayOf(ref('StatementSiteLine')),
      totals: ref('StatementTotals'),
      warnings: arrayOf(str),
      org: {
        ...nullable('object'),
        properties: { id: uuid, name: str, slug: str, npwp: strN, pkp: bool },
      },
      owner: {
        ...nullable('object'),
        description: "The site owner the statement is addressed to; null for the organisation's own statement.",
        properties: { id: uuid, name: str, legal_name: strN, npwp: strN, pkp: bool, address: strN },
      },
      issuer: obj({ name: str, npwp: strN }, ['name']),
      billTo: ref('StatementParty'),
    },
    ['period', 'status', 'number', 'plan', 'sites', 'totals', 'warnings', 'owner', 'issuer', 'billTo'],
  ),
  StatementFinalisedRow: obj(
    {
      period: month,
      number: str,
      gtv_minor: int,
      commission_minor: int,
      minimum_topup_minor: int,
      private_fee_minor: int,
      mdr_credit_minor: int,
      net_minor: int,
      tax_minor: int,
      total_minor: int,
      owner_share_minor: intN,
      finalised_at: dt,
    },
    ['period', 'number', 'gtv_minor', 'commission_minor', 'net_minor', 'tax_minor', 'total_minor', 'finalised_at'],
  ),
  StatementWithHistory: {
    allOf: [ref('Statement'), obj({ history: arrayOf(ref('StatementFinalisedRow')) }, ['history'])],
  },

  // ---- billing (plans, owners overview, finalise)
  BillingPlanInForce: obj(
    {
      plan: ref('StatementPlan'),
      custom: { type: 'boolean', description: 'Rates differ from the published ones.' },
      effectiveFrom: { ...nullable('string'), description: 'YYYY-MM the version took effect; null = published rates, never set.' },
      updatedAt: dtN,
      ownPlan: bool,
    },
    ['plan', 'custom', 'effectiveFrom', 'updatedAt', 'ownPlan'],
  ),
  BillingPlanVersion: obj(
    { effectiveFrom: month, plan: ref('StatementPlan'), custom: bool, updatedAt: dt },
    ['effectiveFrom', 'plan', 'custom', 'updatedAt'],
  ),
  BillingPlanSaved: obj({ plan: ref('StatementPlan'), effectiveFrom: month }, ['plan', 'effectiveFrom']),
  BillingPlanInput: obj(
    {
      plan: {
        anyOf: [ref('StatementPlanInput'), { type: 'null' }],
        description: 'The new rates, or null to return to the published rates from effectiveFrom.',
      },
      effectiveFrom: { ...month, description: 'First month the plan applies to (default: the current month). Must be after the last finalised month.' },
    },
  ),
  BillingFinaliseInput: obj({ month: { ...month, description: 'A month that has ended.' } }, ['month']),
  BillingFinalised: obj({ number: { type: 'string', description: 'The statement number, e.g. PSC-202608-ACME.' } }, ['number']),
  BillingShareFigures: obj({
    sites: int,
    chargers: int,
    sessions: num,
    energyKwh: num,
    grossMinor: num,
    localTaxMinor: num,
    taxMinor: num,
    baseMinor: num,
    mdrMinor: num,
    ownerShareMinor: num,
    platformShareMinor: num,
  }),
  BillingOwnerRow: {
    allOf: [
      ref('BillingShareFigures'),
      obj(
        {
          ownerId: uuid,
          name: str,
          legalName: strN,
          archived: bool,
          customPlan: bool,
          status: { type: 'string', enum: ['draft', 'final'] },
          number: strN,
          platformPpnMinor: num,
          invoiceTotalMinor: num,
          warnings: { type: 'integer', description: 'Number of statement warnings.' },
        },
        ['ownerId', 'name', 'legalName', 'archived', 'customPlan', 'status', 'number', 'sites', 'chargers'],
      ),
    ],
  },
  BillingOwnersOverview: obj(
    {
      period: month,
      owners: arrayOf(ref('BillingOwnerRow')),
      operatorOwn: { allOf: [ref('BillingShareFigures')], description: "The operator's own sites (no owner)." },
      totals: ref('BillingShareFigures'),
      current: { ...month, description: 'The current month.' },
    },
    ['period', 'owners', 'operatorOwn', 'totals', 'current'],
  ),

  // ---- site owners
  OwnerRow: obj(
    {
      id: uuid,
      name: str,
      legal_name: strN,
      npwp: strN,
      pkp: bool,
      address: strN,
      contact_name: strN,
      contact_email: strN,
      contact_phone: strN,
      seller_of_record: { type: 'string', enum: ['operator', 'owner'] },
      archived_at: dtN,
      created_at: dt,
      sites: arrayOf(obj({ id: uuid, name: str }, ['id', 'name'])),
      chargers: int,
      users: int,
    },
    ['id', 'name', 'pkp', 'seller_of_record', 'archived_at', 'created_at', 'sites', 'chargers', 'users'],
  ),
  OwnerInput: obj({
    name: { type: 'string', maxLength: 120, description: 'Required when creating.' },
    legalName: nullable('string', { maxLength: 200 }),
    npwp: { ...nullable('string'), description: '15 or 16 digits; dots, dashes and spaces are allowed.' },
    pkp: bool,
    address: nullable('string', { maxLength: 400 }),
    contactName: nullable('string', { maxLength: 120 }),
    contactEmail: nullable('string', { maxLength: 254 }),
    contactPhone: nullable('string', { maxLength: 40 }),
    sellerOfRecord: { type: 'string', enum: ['operator', 'owner'], description: "Whose name is on the driver's tax receipt." },
  }),

  // ---- platform administration
  PlatformOrgRow: obj(
    {
      orgId: uuid,
      name: str,
      slug: str,
      status: { type: 'string', enum: ['draft', 'final'] },
      number: strN,
      customPlan: bool,
      sites: int,
      chargers: int,
      warnings: int,
      totals: ref('StatementTotals'),
    },
    ['orgId', 'name', 'slug', 'status', 'number', 'customPlan', 'sites', 'chargers', 'warnings', 'totals'],
  ),
  PlatformOrgBilling: obj(
    {
      statement: ref('Statement'),
      plan: ref('BillingPlanInForce'),
      planHistory: arrayOf(ref('BillingPlanVersion')),
      sites: arrayOf(obj({ id: uuid, name: str, billing_model: { type: 'string', enum: ['public', 'private'] } }, ['id', 'name', 'billing_model'])),
    },
    ['statement', 'plan', 'planHistory', 'sites'],
  ),

  // ---- users and roles
  RoleDefinition: obj(
    { name: { type: 'string', enum: ROLE_NAMES }, label: str, siteScoped: bool, ownerScoped: bool, description: str },
    ['name', 'label', 'siteScoped', 'description'],
  ),
  UserRow: obj(
    {
      id: uuid,
      name: str,
      email: strN,
      phone: strN,
      status: str,
      created_at: dt,
      last_login_at: dtN,
      locked: bool,
      has_password: bool,
      must_change_password: bool,
      mfa_enabled: { type: 'boolean', description: 'Two-step verification (authenticator app) is on.' },
      microsoft_bound: { type: 'boolean', description: 'Bound to a Microsoft account (“Sign in with Microsoft” finds the user by it).' },
      microsoft_bound_at: dtN,
      roles: arrayOf(
        obj(
          { role: str, scopeType: { type: 'string', description: 'org, site or owner' }, scopeId: uuidN, siteName: strN, ownerName: strN },
          ['role', 'scopeType'],
        ),
      ),
    },
    ['id', 'name', 'email', 'status', 'created_at', 'locked', 'has_password', 'must_change_password', 'roles'],
  ),
  UserCreateInput: obj(
    {
      name: str,
      email: { type: 'string', description: 'Unique across PlugSure; stored lower-case.' },
      phone: strN,
      role: { type: 'string', enum: ROLE_NAMES },
      siteIds: { type: 'array', items: uuid, description: 'Sites for site_host_landlord (at least one).' },
      ownerId: { ...uuidN, description: 'The site owner, for the site_owner role (required there).' },
      fleetAccountId: { ...uuidN, description: 'The fleet account, for the fleet_customer role (required there).' },
    },
    ['name', 'email', 'role'],
  ),
  UserCreated: obj(
    {
      ok: { type: 'boolean', const: true },
      id: uuid,
      temporaryPassword: { type: 'string', description: 'One-time password, shown only in this response.' },
      warning: str,
    },
    ['ok', 'id', 'temporaryPassword', 'warning'],
  ),
  UserUpdateInput: obj({
    name: str,
    phone: strN,
    role: { type: 'string', enum: ROLE_NAMES, description: 'Replaces every role grant. Not allowed on your own account.' },
    siteIds: { type: 'array', items: uuid },
    ownerId: uuidN,
    status: { type: 'string', enum: ['active', 'disabled'], description: 'Not allowed on your own account. Disabling ends the user\'s sessions.' },
  }),
  UserPasswordReset: obj(
    { ok: { type: 'boolean', const: true }, temporaryPassword: { type: 'string', description: 'One-time password, shown only in this response.' } },
    ['ok', 'temporaryPassword'],
  ),
};

// ─────────────────────────────────────────── operations

const AUTH_INTERNAL = 'console sign-in; API keys do not use it';
const PLATFORM_INTERNAL = 'platform administration';

const ownerIdPath = { id: 'Site owner id (UUID) of the caller\'s organisation.' };
const orgIdPath = { orgId: 'Customer organisation id (UUID).' };

const planExample = {
  plan: {
    tiers: [
      { name: 'Standard', upToMinor: 150000000, rateBps: 750 },
      { name: 'Volume', upToMinor: 500000000, rateBps: 600 },
      { name: 'Network', upToMinor: null, rateBps: 450 },
    ],
    tierMode: 'whole',
    minPerChargerAcMinor: 150000,
    minPerChargerDcMinor: 350000,
    mdrBorneBy: 'platform',
  },
  effectiveFrom: '2026-10',
};

export const ops: Op[] = [
  // ============================================================ auth
  {
    method: 'POST',
    path: '/v1/auth/login',
    tag: 'Console session',
    summary: 'Sign in to the console',
    description:
      'Checks an operator e-mail and password and, on success, sets the HttpOnly `ps_session` cookie (12 hours).' +
      'Every attempt is audited. A wrong email or password answers 401 with a generic message; repeated failures lock the account for a while. ' +
      'On an operator’s own console web address (Console branding, once approved by the platform operator) only that operator’s accounts sign in; any other is refused exactly as a wrong password.',
    body: {
      required: true,
      schema: obj({ email: { type: 'string' }, password: { type: 'string' } }, ['email', 'password']),
      example: { email: 'ops@voltindo.co.id', password: 'Kopi-Tubruk-2026!' },
    },
    responses: { 200: { description: 'Signed in; the session cookie is set.', schema: ref('AuthLoginResult') } },
    internal: AUTH_INTERNAL,
  },
  {
    method: 'POST',
    path: '/v1/auth/mfa/verify',
    tag: 'Console session',
    summary: 'Complete sign-in with a two-step verification code',
    description:
      'The second step for an account with two-step verification, on the pending session the password step set: a six-digit code from the authenticator app ' +
      '(accepted once per 30-second step: a code cannot be replayed) or one of the recovery codes (each works once). On success the pending session is replaced by a full one (new cookie). ' +
      'A wrong code answers 400 and counts towards the same lockout as wrong passwords; once the lock engages the pending session ends and the answer is 401. Audited.',
    body: { required: true, schema: obj({ code: { type: 'string' } }, ['code']), example: { code: '492039' } },
    responses: {
      200: {
        description: 'Signed in.',
        schema: obj({ ok: { type: 'boolean', const: true }, mustChangePassword: bool, recoveryCodesLeft: int }, ['ok', 'mustChangePassword']),
      },
    },
    errors: [400, 401],
    internal: AUTH_INTERNAL,
  },
  {
    method: 'GET',
    path: '/v1/auth/mfa',
    tag: 'Console session',
    summary: 'Get your two-step verification status',
    description: 'Whether two-step verification is on, how many recovery codes are left, and whether it is required for this account.',
    responses: { 200: { description: 'Status.', schema: ref('MfaStatus') } },
    errors: [400],
    internal: AUTH_INTERNAL,
  },
  {
    method: 'POST',
    path: '/v1/auth/mfa/enrol',
    tag: 'Console session',
    summary: 'Start setting up two-step verification',
    description:
      'Generates a new authenticator secret (kept sealed until confirmed) and answers it as an otpauth:// URI and a QR code. Refused while two-step verification is already on ' +
      '(an administrator resets it). Required for administrator accounts: until it is set up they can reach nothing but this, the confirmation, who-am-I and sign-out.',
    responses: { 200: { description: 'The secret to scan.', schema: ref('MfaEnrolment') } },
    errors: [400],
    internal: AUTH_INTERNAL,
  },
  {
    method: 'POST',
    path: '/v1/auth/mfa/enrol/confirm',
    tag: 'Console session',
    summary: 'Confirm two-step verification with a code',
    description:
      'Proves the app holds the secret and turns two-step verification on. Answers ten recovery codes, shown only in this response (only their hashes are kept). ' +
      'Every other session of the account ends. Audited.',
    body: { required: true, schema: obj({ code: { type: 'string' } }, ['code']), example: { code: '492039' } },
    responses: { 200: { description: 'On; the recovery codes.', schema: obj({ ok: { type: 'boolean', const: true }, recoveryCodes: arrayOf(str) }, ['ok', 'recoveryCodes']) } },
    errors: [400],
    internal: AUTH_INTERNAL,
  },
  {
    method: 'POST',
    path: '/v1/auth/logout',
    tag: 'Console session',
    summary: 'Sign out of the console',
    description: 'Revokes the session the request was made with — the cookie or a `Bearer pss_…` token — and clears the cookie.',
    responses: { 200: { description: 'Signed out.', schema: OK } },
    internal: AUTH_INTERNAL,
  },
  {
    method: 'GET',
    path: '/v1/countries',
    tag: 'Reference data',
    summary: 'List the countries PlugSure operates in',
    description: 'Indonesia, Malaysia and Singapore: currency, the time zones a site there may use (first = default), whether consumer prices are shown including tax, and the default language.',
    responses: {
      200: {
        description: 'Countries.',
        schema: obj({
          countries: arrayOf(obj({
            code: { ...str, description: 'ISO 3166-1 alpha-2: ID, MY or SG.' }, name: str, currency: { ...str, description: 'ISO 4217: IDR, MYR or SGD.' },
            timezones: arrayOf(str), displayPricesInclTax: bool, defaultLocale: { ...str, enum: ['id', 'en'] },
          }, ['code', 'name', 'currency', 'timezones', 'displayPricesInclTax', 'defaultLocale'])),
        }, ['countries']),
      },
    },
  },
  {
    method: 'GET',
    path: '/v1/org/settings',
    tag: 'Compliance',
    summary: 'Get the organisation\'s country settings',
    description: 'Home country (default for new sites, the roaming identity), reporting time zone (statements, alerts, console times), default language, the sites per country, and the tax registrations per country (effective-dated: PKP in Indonesia, service tax in Malaysia, GST in Singapore).',
    responses: { 200: { description: 'Settings.', schema: ref('OrgSettings') } },
  },
  {
    method: 'PUT',
    path: '/v1/org/settings',
    tag: 'Compliance',
    summary: 'Change the home country, reporting time zone or default language',
    description: 'Fields left out keep their value. The time zone is one of a country the organisation is in (home or a site\'s). Malaysia and Singapore as home country need MULTI_COUNTRY. 422 with `errors` per field. Audited.',
    body: {
      required: true,
      schema: obj({ homeCountry: { ...str, enum: ['ID', 'MY', 'SG'] }, timezone: { ...str, description: 'IANA zone, e.g. Asia/Singapore.' }, defaultLocale: { ...str, enum: ['id', 'en'] } }),
      example: { homeCountry: 'SG', timezone: 'Asia/Singapore', defaultLocale: 'en' },
    },
    responses: { 200: { description: 'The settings now.', schema: ref('OrgSettings') } },
    errors: [422],
  },
  {
    method: 'POST',
    path: '/v1/org/tax-registrations',
    tag: 'Compliance',
    summary: 'Record a tax registration in a country',
    description:
      'From the date given, sessions in that country are taxed by it; the registration in force there before ends that day (409 when the new date is not after its start). ' +
      '`registered: false` records that the organisation is not registered from that date. Malaysia: service tax is charged on EV charging only with `evChargingTaxable: true`. ' +
      'An Indonesian registration in force today also sets the organisation\'s PKP / NPWP. Audited.',
    body: {
      required: true,
      schema: obj({
        countryCode: { ...str, enum: ['ID', 'MY', 'SG'] },
        registered: { ...bool, description: 'Default true.' },
        registrationNo: { ...strN, description: 'NPWP (15–16 digits), SST or GST registration number. Required when registered.' },
        effectiveFrom: { ...str, format: 'date' },
        evChargingTaxable: { ...bool, description: 'Malaysia only.' },
        rateBps: { ...intN, description: 'Basis points; empty for the statutory rate (SST 8 %, GST 9 %).' },
      }, ['countryCode', 'effectiveFrom']),
      example: { countryCode: 'SG', registered: true, registrationNo: 'M90000000X', effectiveFrom: '2026-10-01' },
    },
    responses: { 201: { description: 'The settings now.', schema: ref('OrgSettings') } },
    errors: [409, 422],
  },
  {
    method: 'GET',
    path: '/v1/auth/me',
    tag: 'Console session',
    summary: 'Get the signed-in principal',
    description:
      'Who the caller is: user, organisation, role grants, effective permissions, visible sites, the site owners it acts for (Site Owner portal) and deployment features the console needs. ' +
      'Needs no particular permission.',
    responses: { 200: { description: 'The current principal.', schema: ref('AuthMe') } },
    permissions: [],
    internal: AUTH_INTERNAL,
  },
  {
    method: 'POST',
    path: '/v1/auth/change-password',
    tag: 'Console session',
    summary: 'Change your own password',
    description:
      'Needs the current password. The new one must meet the length rule and mix at least three of lower case, upper case, digits and symbols. ' +
      'Clears the must-change-password flag set by a one-time password. Audited. Only a signed-in operator can call it (not an API key).',
    body: {
      required: true,
      schema: obj({ current: { type: 'string' }, next: { type: 'string', maxLength: 256 } }, ['current', 'next']),
      example: { current: 'Xk7Pq-Mn4Rt-abcd!7', next: 'Sate-Padang-Jakarta-88' },
    },
    responses: { 200: { description: 'Password changed.', schema: OK } },
    errors: [400],
    internal: AUTH_INTERNAL,
  },

  // ============================================================ reference data
  {
    method: 'GET',
    path: '/v1/meta',
    tag: 'Reference data',
    summary: 'Get reference data',
    description:
      'Static lists the console and integrations use: PLN tariff groups, SPKLU schemes, connector types, vendors, token account types, configuration categories, firmware stages, console roles, payment statuses and the regulatory ceilings in force. ' +
      'Needs no particular permission.',
    responses: { 200: { description: 'Reference data.', schema: ref('Meta') } },
  },

  // ============================================================ dashboard
  {
    method: 'GET',
    path: '/v1/dashboard',
    tag: 'Chargers',
    summary: 'Get the fleet dashboard',
    description:
      'Charger counts (total, online, pending adoption, faulted), connectors by status, open alerts raised in the last 7 days, and — when the caller also holds session:read — today\'s sessions, energy and revenue plus a 14-day series (Asia/Jakarta days). ' +
      'Site-scoped users see only their sites. Decommissioned chargers are excluded.',
    responses: { 200: { description: 'Dashboard figures.', schema: ref('Dashboard') } },
    permissions: ['charge_point:read'],
  },

  // ============================================================ refunds
  {
    method: 'GET',
    path: '/v1/refunds',
    tag: 'Payments and refunds',
    summary: 'List refunds owed to drivers',
    description:
      'Prepaid payments in the refund flow (due, processing, refunded, failed) with a summary: amount and count outstanding, failed count and amount refunded in the last 30 days. ' +
      'Outstanding refunds come first; at most 500 rows.',
    query: [
      {
        name: 'state',
        description: 'Only this refund state. Any other value is ignored (all states).',
        schema: { type: 'string', enum: ['due', 'processing', 'refunded', 'failed'] },
      },
    ],
    responses: {
      200: {
        description: 'Summary and rows.',
        schema: obj({ summary: ref('RefundSummary'), rows: arrayOf(ref('RefundRow')) }, ['summary', 'rows']),
      },
    },
  },
  {
    method: 'POST',
    path: '/v1/refunds/:id/process',
    tag: 'Payments and refunds',
    summary: 'Pay a refund through the payment provider',
    description:
      "Calls the payment provider's refund API for a refund that is due or failed. The result is `refunded`, or `processing` when the provider settles asynchronously. " +
      'When the provider has no refund API or refuses, the refund becomes failed and the call answers 409 with `error` and `state` — refund by bank transfer and record it with mark-refunded. Audited either way.',
    pathParams: { id: 'Payment intent id (UUID).' },
    responses: { 200: { description: 'Refund paid or accepted by the provider.', schema: ref('RefundOutcome') } },
    errors: [404, 409],
  },
  {
    method: 'GET',
    path: '/v1/card-holds',
    tag: 'Payments and refunds',
    summary: 'Card holds and post-pay e-wallet charges',
    description:
      'Card payments taken as holds (Integrations → Payments → "hold, then charge only what is used"): held while charging, captured for the rated total when the session ends (the rest released at once), or released when unused. ' +
      'Post-pay sessions with linked e-wallets are listed too (kind postpay): nothing held at the start, the rated total charged to the e-wallet at the end, the same retries. ' +
      'Failed captures and releases come first, with the acquirer\'s error and the next automatic retry; captured and released holds of the last 14 days follow. At most 200 rows.',
    responses: {
      200: {
        description: 'Holds and a summary.',
        schema: obj(
          { holds: arrayOf(ref('CardHold')), summary: obj({ held: int, inProgress: int, failed: int, heldMinor: { ...int, description: 'Rupiah (IDR).' }, expired: int, expiredMinor: { ...int, description: 'Rupiah (IDR).' }, expiredByCurrency: { type: 'object', additionalProperties: int } }, ['held', 'inProgress', 'failed', 'heldMinor']) },
          ['holds', 'summary'],
        ),
      },
    },
    permissions: ['payment:read'],
  },
  {
    method: 'POST',
    path: '/v1/card-holds/:id/retry',
    tag: 'Payments and refunds',
    summary: 'Retry a card hold capture or release now',
    description:
      'Runs a failed (or pending) capture or release again at the acquirer, without waiting for the automatic retry. 409 with `error` and `state` when the acquirer refuses again. Audited.',
    pathParams: { id: 'Payment intent id (UUID).' },
    responses: {
      200: { description: 'Captured or released.', schema: obj({ ok: { type: 'boolean' }, state: { type: ['string', 'null'] } }, ['ok', 'state']) },
    },
    errors: [404, 409],
    permissions: ['payment:write'],
  },
  {
    method: 'POST',
    path: '/v1/refunds/:id/mark-refunded',
    tag: 'Payments and refunds',
    summary: 'Record a refund paid by bank transfer',
    description:
      'Marks an outstanding refund (due, failed or processing) as refunded manually with the bank transfer reference, and resolves the related "refund due" alert. Audited.',
    pathParams: { id: 'Payment intent id (UUID).' },
    body: {
      required: true,
      schema: obj({ reference: { type: 'string', minLength: 3, maxLength: 120, description: 'Bank transfer reference.' } }, ['reference']),
      example: { reference: 'BCA-TRF-20260927-004512' },
    },
    responses: {
      200: {
        description: 'Refund recorded.',
        schema: obj(
          { ok: { type: 'boolean', const: true }, state: { type: 'string', const: 'refunded' }, refundRef: str },
          ['ok', 'state', 'refundRef'],
        ),
      },
    },
    errors: [400, 404],
  },

  // ============================================================ availability report
  {
    method: 'GET',
    path: '/v1/reports/availability',
    tag: 'Availability',
    summary: 'Get the uptime and utilisation report',
    description:
      'Per charger over the last `days`: uptime %, outages, offline minutes, longest outage, sessions, energy, revenue and utilisation %. ' +
      'The window starts at commissioning for chargers commissioned inside it. Site-scoped users see only their sites.',
    query: [
      { name: 'days', description: 'Window length in days; default 30, clamped to 1–365.', schema: { type: 'integer', minimum: 1, maximum: 365, default: 30 } },
      { name: 'siteId', description: 'Only this site (UUID).', schema: uuid },
    ],
    responses: { 200: { description: 'The report.', schema: ref('AvailabilityReport') } },
  },

  // ============================================================ webhooks
  {
    method: 'GET',
    path: '/v1/webhooks',
    tag: 'Webhooks',
    summary: 'List webhook endpoints',
    description: 'The organisation\'s endpoints with delivery counts (pending, failed, delivered in the last 24 h), and the event types that can be subscribed to. Signing secrets are never returned here.',
    responses: {
      200: {
        description: 'Event types and endpoints.',
        schema: obj({ events: arrayOf({ type: 'string', enum: WEBHOOK_EVENTS }), rows: arrayOf(ref('WebhookEndpointRow')) }, ['events', 'rows']),
      },
    },
  },
  {
    method: 'POST',
    path: '/v1/webhooks',
    tag: 'Webhooks',
    summary: 'Create a webhook endpoint',
    description:
      'Registers a URL to receive signed event deliveries (`PlugSure-Signature: t=<unix>,v1=<HMAC-SHA256>`). ' +
      'The signing secret is returned once, in this response, and can never be read again — only rotated. Audited.',
    body: {
      required: true,
      schema: { allOf: [ref('WebhookEndpointInput')], required: ['url'] },
      example: {
        url: 'https://erp.voltindo.co.id/plugsure/webhook',
        description: 'ERP billing sync',
        events: ['session.ended', 'cdr.created', 'refund.completed'],
      },
    },
    responses: {
      201: {
        description: 'Created. Store `secret` now.',
        schema: obj({ endpoint: ref('WebhookEndpoint'), secret: { type: 'string', description: 'Signing secret, shown only once.' } }, ['endpoint', 'secret']),
      },
    },
    errors: [400],
  },
  {
    method: 'PATCH',
    path: '/v1/webhooks/:id',
    tag: 'Webhooks',
    summary: 'Update a webhook endpoint',
    description:
      'Changes the URL, description, subscribed events or state. Setting state `active` (e.g. re-enabling a disabled endpoint) resets the failure streak. At least one field is required. Audited.',
    pathParams: { id: 'Webhook endpoint id (UUID).' },
    body: {
      required: true,
      schema: {
        allOf: [
          ref('WebhookEndpointInput'),
          obj({ state: { type: 'string', enum: ['active', 'paused'] } }),
        ],
      },
      example: { events: ['*'], state: 'active' },
    },
    responses: { 200: { description: 'Updated.', schema: obj({ endpoint: ref('WebhookEndpoint') }, ['endpoint']) } },
    errors: [400, 404],
  },
  {
    method: 'DELETE',
    path: '/v1/webhooks/:id',
    tag: 'Webhooks',
    summary: 'Delete a webhook endpoint',
    description: 'Deletes the endpoint and its delivery history. Audited.',
    pathParams: { id: 'Webhook endpoint id (UUID).' },
    responses: { 200: { description: 'Deleted.', schema: OK } },
    errors: [404],
  },
  {
    method: 'POST',
    path: '/v1/webhooks/:id/rotate-secret',
    tag: 'Webhooks',
    summary: 'Rotate a webhook signing secret',
    description: 'Replaces the signing secret at once; deliveries from now on are signed with the new one. The new secret is returned only in this response. Audited.',
    pathParams: { id: 'Webhook endpoint id (UUID).' },
    responses: {
      200: { description: 'The new secret.', schema: obj({ secret: { type: 'string', description: 'Signing secret, shown only once.' } }, ['secret']) },
    },
    errors: [404],
  },
  {
    method: 'POST',
    path: '/v1/webhooks/:id/test',
    tag: 'Webhooks',
    summary: 'Send a test ping to a webhook',
    description:
      'Sends a signed `ping` event now and reports the receiver\'s answer; the attempt is recorded as a delivery. ' +
      'Answers 200 even when the receiver fails — check `ok`, `status` and `error`.',
    pathParams: { id: 'Webhook endpoint id (UUID).' },
    responses: { 200: { description: 'What the receiver answered.', schema: ref('WebhookSendResult') } },
    errors: [404],
  },
  {
    method: 'GET',
    path: '/v1/webhooks/:id/deliveries',
    tag: 'Webhooks',
    summary: 'List webhook deliveries',
    description: 'The latest 200 deliveries to the endpoint, newest first, with payloads and the last attempt\'s result. An unknown endpoint id gives an empty list.',
    pathParams: { id: 'Webhook endpoint id (UUID).' },
    query: [
      {
        name: 'state',
        description: 'Only deliveries in this state. Any other value is ignored.',
        schema: { type: 'string', enum: ['pending', 'delivered', 'failed'] },
      },
    ],
    responses: { 200: { description: 'Deliveries.', schema: obj({ rows: arrayOf(ref('WebhookDelivery')) }, ['rows']) } },
    errors: [404],
  },

  // ============================================================ alert routing
  {
    method: 'GET',
    path: '/v1/alert-routing',
    tag: 'Alert routing',
    summary: 'Get alert routing settings',
    description:
      'E-mail, WhatsApp and SMS channel settings, contacts, rules and on-call rotas (with who is on duty now), the alert kinds rules can match, and the time zone used for quiet hours and rota handovers. ' +
      'Channel secrets (SMTP password, WhatsApp token and app secret, SMS credential) are never returned; `has_secret` says whether one is stored.',
    responses: {
      200: {
        description: 'Routing settings.',
        schema: obj(
          {
            channels: obj({ email: ref('AlertRoutingChannel'), whatsapp: ref('AlertRoutingChannel'), sms: ref('AlertRoutingChannel') }, ['email', 'whatsapp', 'sms']),
            contacts: arrayOf(ref('AlertRoutingContact')),
            rules: arrayOf(ref('AlertRoutingRule')),
            rotas: arrayOf(ref('AlertRota')),
            kinds: { type: 'object', additionalProperties: str, description: 'Alert kind → human title.' },
            timeZone: str,
            consoleUrl: strN,
          },
          ['channels', 'contacts', 'rules', 'rotas', 'kinds', 'timeZone', 'consoleUrl'],
        ),
      },
    },
  },
  {
    method: 'PUT',
    path: '/v1/alert-routing/channels/:kind',
    tag: 'Alert routing',
    summary: 'Save an alert channel',
    description:
      'Sets the e-mail (SMTP), WhatsApp (Cloud API) or SMS (Twilio, Zenziva or your own gateway) sender. `secret` is write-only: sealed at rest, never returned and never written to the audit log; omit it to keep the stored one. ' +
      'WhatsApp and SMS always need one; SMTP needs a password when a username is set. For WhatsApp, `webhookSecret` is the Meta app secret used to check delivery-status webhooks (write-only too); the first save creates the webhook path and verify token. Audited.',
    pathParams: { kind: 'Channel: `email`, `whatsapp` or `sms`.' },
    body: {
      required: true,
      schema: obj({
        enabled: { type: 'boolean', default: true },
        config: obj({
          host: { type: 'string', description: 'E-mail: SMTP host.' },
          port: { type: 'integer', minimum: 1, maximum: 65535, description: 'E-mail: SMTP port.' },
          security: { type: 'string', enum: ['tls', 'starttls', 'none'], description: 'E-mail: connection security.' },
          username: { type: 'string', description: 'E-mail: SMTP user name.' },
          fromAddress: { type: 'string', description: 'E-mail: sender address.' },
          fromName: { type: 'string', description: 'E-mail: sender name.' },
          apiBase: { type: 'string', description: 'WhatsApp: Graph API base URL.' },
          phoneNumberId: { type: 'string', pattern: '^\\d{5,30}$', description: 'WhatsApp: phone number id.' },
          templateName: { type: 'string', description: 'WhatsApp: approved template name.' },
          templateLang: { type: 'string', description: 'WhatsApp: template language, e.g. id or en_US.' },
          provider: { type: 'string', enum: ['twilio', 'zenziva', 'http'], description: 'SMS: the provider.' },
          accountSid: { type: 'string', description: 'SMS (Twilio): Account SID (AC…).' },
          from: { type: 'string', description: 'SMS (Twilio): sender number, unless messagingServiceSid.' },
          messagingServiceSid: { type: 'string', description: 'SMS (Twilio): Messaging Service SID (MG…).' },
          baseUrl: { type: 'string', description: 'SMS (Twilio): API base, default https://api.twilio.com.' },
          userkey: { type: 'string', description: 'SMS (Zenziva): user key.' },
          endpoint: { type: 'string', description: 'SMS (Zenziva): API URL, default the regular SMS endpoint.' },
          url: { type: 'string', description: 'SMS (your gateway): POST { to, message, channel, purpose: alert } with the secret as a bearer token.' },
        }),
        secret: { type: 'string', description: 'SMTP password, WhatsApp access token, Twilio auth token, Zenziva pass key or gateway token. Write-only.', writeOnly: true },
        webhookSecret: { type: 'string', description: 'WhatsApp: the Meta app secret, to check delivery-status webhook signatures. Write-only.', writeOnly: true },
      }),
      example: {
        enabled: true,
        config: { apiBase: 'https://graph.facebook.com/v21.0', phoneNumberId: '109876543210987', templateName: 'plugsure_alert', templateLang: 'id' },
        secret: 'EAAG-example-system-user-token',
      },
    },
    responses: { 200: { description: 'Saved.', schema: OK } },
    errors: [400, 404],
  },
  {
    method: 'POST',
    path: '/v1/alert-routing/channels/:kind/test',
    tag: 'Alert routing',
    summary: 'Send a test alert message',
    description:
      'Sends a test message on the saved channel now (not queued), records it in the notification log and on the channel. ' +
      'Answers 200 when the send was attempted — check `ok` and `error`. Audited.',
    pathParams: { kind: 'Channel: `email`, `whatsapp` or `sms`.' },
    body: {
      required: true,
      schema: obj({ destination: { type: 'string', description: 'E-mail address, or WhatsApp / mobile number (e.g. +62 812 3456 7890).' } }, ['destination']),
      example: { destination: '+62 812 3456 7890' },
    },
    responses: {
      200: {
        description: 'The send result.',
        schema: obj({ ok: bool, destination: str, reference: strN, error: strN }, ['ok', 'destination', 'reference', 'error']),
      },
    },
    errors: [400, 404],
  },
  {
    method: 'POST',
    path: '/v1/alert-routing/contacts',
    tag: 'Alert routing',
    summary: 'Create an alert contact',
    description: 'A person who can be notified, by e-mail, WhatsApp or both. Audited.',
    body: {
      required: true,
      schema: ref('AlertRoutingContactInput'),
      example: { name: 'Budi Santoso (on-call teknisi)', email: 'budi.santoso@voltindo.co.id', whatsapp: '+62 812 3456 7890', active: true },
    },
    responses: {
      201: {
        description: 'Created.',
        schema: obj({ contact: obj({ id: uuid, name: str, email: strN, whatsapp: strN, active: bool }, ['id', 'name', 'email', 'whatsapp', 'active']) }, ['contact']),
      },
    },
    errors: [400],
  },
  {
    method: 'PUT',
    path: '/v1/alert-routing/contacts/:id',
    tag: 'Alert routing',
    summary: 'Replace an alert contact',
    description: 'Replaces the contact\'s name, e-mail, WhatsApp number and active flag (fields left out are cleared or defaulted). Audited.',
    pathParams: { id: 'Contact id (UUID).' },
    body: {
      required: true,
      schema: ref('AlertRoutingContactInput'),
      example: { name: 'Budi Santoso (on-call teknisi)', whatsapp: '+62 812 3456 7890', active: false },
    },
    responses: {
      200: {
        description: 'Updated.',
        schema: obj({ contact: obj({ id: uuid, name: str, email: strN, whatsapp: strN, active: bool }, ['id', 'name', 'email', 'whatsapp', 'active']) }, ['contact']),
      },
    },
    errors: [400, 404],
  },
  {
    method: 'DELETE',
    path: '/v1/alert-routing/contacts/:id',
    tag: 'Alert routing',
    summary: 'Delete an alert contact',
    description: 'Deletes the contact and removes it from every rule (as recipient and as escalation contact). Audited.',
    pathParams: { id: 'Contact id (UUID).' },
    responses: { 200: { description: 'Deleted.', schema: OK } },
    errors: [404],
  },
  {
    method: 'POST',
    path: '/v1/alert-routing/rules',
    tag: 'Alert routing',
    summary: 'Create an alert rule',
    description:
      'Which alerts go to whom: minimum severity, kinds, sites, channels and contacts, quiet hours (non-critical messages wait until they end), resolved notices and escalation when an alert stays unacknowledged. Audited.',
    body: {
      required: true,
      schema: ref('AlertRoutingRuleInput'),
      example: {
        name: 'Jakarta Selatan — charger down',
        minSeverity: 'critical',
        kinds: ['charge_point.offline', 'connector.faulted'],
        siteIds: ['3f2b1c9e-7a4d-4e21-9c55-0b8a6d2e1f10'],
        channels: ['whatsapp', 'email'],
        contactIds: ['a1c3e5f7-2b4d-4f60-8a9b-1c2d3e4f5a6b'],
        notifyResolved: true,
        quietStart: '22:00',
        quietEnd: '06:00',
        escalateAfterMin: 30,
        escalateContactIds: ['b2d4f6a8-3c5e-4a71-9bac-2d3e4f5a6b7c'],
      },
    },
    responses: { 201: { description: 'Created.', schema: obj({ rule: ref('AlertRoutingRule') }, ['rule']) } },
    errors: [400],
  },
  {
    method: 'PUT',
    path: '/v1/alert-routing/rules/:id',
    tag: 'Alert routing',
    summary: 'Replace an alert rule',
    description: 'Replaces every setting of the rule (fields left out take their defaults). Audited.',
    pathParams: { id: 'Rule id (UUID).' },
    body: {
      required: true,
      schema: ref('AlertRoutingRuleInput'),
      example: {
        name: 'All sites — warnings by e-mail',
        enabled: true,
        minSeverity: 'warning',
        kinds: [],
        siteIds: [],
        channels: ['email'],
        contactIds: ['a1c3e5f7-2b4d-4f60-8a9b-1c2d3e4f5a6b'],
        notifyResolved: false,
        escalateAfterMin: null,
      },
    },
    responses: { 200: { description: 'Updated.', schema: obj({ rule: ref('AlertRoutingRule') }, ['rule']) } },
    errors: [400, 404],
  },
  {
    method: 'DELETE',
    path: '/v1/alert-routing/rules/:id',
    tag: 'Alert routing',
    summary: 'Delete an alert rule',
    description: 'Deletes the rule. Messages already in the log keep their history. Audited.',
    pathParams: { id: 'Rule id (UUID).' },
    responses: { 200: { description: 'Deleted.', schema: OK } },
    errors: [404],
  },
  {
    method: 'GET',
    path: '/v1/alert-routing/log',
    tag: 'Alert routing',
    summary: 'List alert notifications',
    description: 'The notification outbox and delivery log, newest first, at most 300 rows, with the alert, contact and rule each message came from.',
    query: [
      { name: 'state', description: 'Only this state. Any other value is ignored.', schema: { type: 'string', enum: ['pending', 'sent', 'failed', 'suppressed'] } },
      { name: 'alertId', description: 'Only messages about this alert (UUID). A malformed id is ignored.', schema: uuid },
    ],
    responses: { 200: { description: 'Notifications.', schema: obj({ rows: arrayOf(ref('AlertRoutingNotification')) }, ['rows']) } },
  },
  {
    method: 'POST',
    path: '/v1/alert-routing/log/:id/retry',
    tag: 'Alert routing',
    summary: 'Retry a failed alert notification',
    description: 'Puts a failed notification (not a test message) back in the queue with its attempts reset, e.g. after fixing the channel settings. Audited.',
    pathParams: { id: 'Notification id (a positive integer).' },
    responses: { 200: { description: 'Re-queued.', schema: OK } },
    errors: [404],
  },
  {
    method: 'POST',
    path: '/v1/alert-routing/rotas',
    tag: 'Alert routing',
    summary: 'Create an on-call rota',
    description:
      'Who is on duty: alert contacts taking daily or weekly shifts in turn, handing over at a local time; the first shift starts on `startsOn` with the first member. ' +
      'Rules (`rotaIds`) and escalations (`escalateRotaIds`) notify whoever is on duty when the alert is routed. Audited.',
    body: { required: true, schema: ref('AlertRotaInput'), example: { name: 'Teknisi Jakarta', memberIds: ['a1c3e5f7-2b4d-4f60-8a9b-1c2d3e4f5a6b', 'b2d4f6a8-3c5e-4a71-9bac-2d3e4f5a6b7c'], shift: 'weekly', handoverTime: '08:00', startsOn: '2026-10-05' } },
    responses: { 201: { description: 'Created.', schema: obj({ rota: obj({ id: uuid }, ['id']) }, ['rota']) } },
    errors: [400],
  },
  {
    method: 'PUT',
    path: '/v1/alert-routing/rotas/:id',
    tag: 'Alert routing',
    summary: 'Replace an on-call rota',
    description: 'Replaces the rota: name, members in order, shift length, handover time and start date. Audited.',
    pathParams: { id: 'Rota id (UUID).' },
    body: { required: true, schema: ref('AlertRotaInput'), example: { name: 'Teknisi Jakarta', memberIds: ['b2d4f6a8-3c5e-4a71-9bac-2d3e4f5a6b7c', 'a1c3e5f7-2b4d-4f60-8a9b-1c2d3e4f5a6b'], shift: 'daily', handoverTime: '07:00', startsOn: '2026-10-05' } },
    responses: { 200: { description: 'Updated.', schema: obj({ rota: obj({ id: uuid }, ['id']) }, ['rota']) } },
    errors: [400, 404],
  },
  {
    method: 'DELETE',
    path: '/v1/alert-routing/rotas/:id',
    tag: 'Alert routing',
    summary: 'Delete an on-call rota',
    description: 'Deletes the rota and its overrides, and takes it out of every rule. Audited.',
    pathParams: { id: 'Rota id (UUID).' },
    responses: { 200: { description: 'Deleted.', schema: OK } },
    errors: [404],
  },
  {
    method: 'POST',
    path: '/v1/alert-routing/rotas/:id/overrides',
    tag: 'Alert routing',
    summary: 'Add an on-call override',
    description: 'Puts someone else on duty for a period (leave, a swap), over the rotation. The most recently added override wins where they overlap. At most 92 days. Audited.',
    pathParams: { id: 'Rota id (UUID).' },
    body: {
      required: true,
      schema: obj({ contactId: uuid, startsAt: { type: 'string', format: 'date-time' }, endsAt: { type: 'string', format: 'date-time' }, note: { type: 'string', maxLength: 200 } }, ['contactId', 'startsAt', 'endsAt']),
      example: { contactId: 'b2d4f6a8-3c5e-4a71-9bac-2d3e4f5a6b7c', startsAt: '2026-10-10T08:00:00+07:00', endsAt: '2026-10-12T08:00:00+07:00', note: 'Budi on leave' },
    },
    responses: { 201: { description: 'Created.', schema: obj({ override: obj({ id: uuid }, ['id']) }, ['override']) } },
    errors: [400, 404],
  },
  {
    method: 'DELETE',
    path: '/v1/alert-routing/rotas/:id/overrides/:overrideId',
    tag: 'Alert routing',
    summary: 'Remove an on-call override',
    description: 'Removes the override; the rotation applies again for that period. Audited.',
    pathParams: { id: 'Rota id (UUID).', overrideId: 'Override id (UUID).' },
    responses: { 200: { description: 'Removed.', schema: OK } },
    errors: [404],
  },

  // ============================================================ statements and billing
  {
    method: 'GET',
    path: '/v1/billing/statement',
    tag: 'Statements and billing',
    summary: 'Get a commission and fee statement',
    description:
      "The month's statement: frozen if finalised, otherwise a live draft (the current month projects minimums and fees to month end), plus the list of finalised statements. " +
      "Org-wide finance staff get the organisation's statement from the platform, or one site owner's with `ownerId`; a Site Owner portal user always gets its own owner's.",
    query: [
      currencyQuery,
      monthQuery,
      { name: 'ownerId', description: 'A site owner of the organisation (UUID). Site Owner users may only name their own.', schema: uuid },
    ],
    responses: { 200: { description: 'Statement and finalised history.', schema: ref('StatementWithHistory') } },
    errors: [400, 404],
    permissions: ['invoice:read'],
  },
  {
    method: 'GET',
    path: '/v1/billing/statement.csv',
    tag: 'Statements and billing',
    summary: 'Download a statement as CSV',
    description:
      'The same statement as GET /v1/billing/statement, one row per charger, as a UTF-8 CSV (with BOM) sent as an attachment named plugsure-statement-<org>-<YYYY-MM>.csv.',
    query: [
      currencyQuery,
      monthQuery,
      { name: 'ownerId', description: 'A site owner of the organisation (UUID).', schema: uuid },
    ],
    responses: { 200: { description: 'CSV file.', contentType: 'text/csv', schema: { type: 'string' } } },
    errors: [400, 404],
    permissions: ['invoice:read'],
  },
  {
    method: 'GET',
    path: '/v1/billing/statement.html',
    tag: 'Statements and billing',
    summary: 'Get a printable statement',
    description: 'The same statement as GET /v1/billing/statement, as a self-contained printable HTML page.',
    query: [
      currencyQuery,
      monthQuery,
      { name: 'ownerId', description: 'A site owner of the organisation (UUID).', schema: uuid },
    ],
    responses: { 200: { description: 'HTML page.', contentType: 'text/html', schema: { type: 'string' } } },
    errors: [400, 404],
    permissions: ['invoice:read'],
  },
  {
    method: 'GET',
    path: '/v1/billing/owners',
    tag: 'Statements and billing',
    summary: 'Get billing across site owners',
    description:
      "Every site owner's month — charging units, gross, taxes, commission base, the owner's and the operator's shares, statement status — plus the operator's own sites and totals. " +
      'Computes a statement per owner, so it can be slow for many owners.',
    query: [monthQuery, currencyQuery],
    responses: { 200: { description: 'Owners overview.', schema: ref('BillingOwnersOverview') } },
    errors: [400],
  },
  {
    method: 'GET',
    path: '/v1/billing/owners/:id/plan',
    tag: 'Statements and billing',
    summary: "Get a site owner's commercial plan",
    description: "The plan in force for the month (an owner without its own plan is on the published rates) and every plan version agreed with the owner.",
    pathParams: ownerIdPath,
    query: [monthQuery],
    responses: {
      200: {
        description: 'Plan in force and history.',
        schema: obj({ plan: ref('BillingPlanInForce'), history: arrayOf(ref('BillingPlanVersion')) }, ['plan', 'history']),
      },
    },
    errors: [400, 404],
  },
  {
    method: 'PUT',
    path: '/v1/billing/owners/:id/plan',
    tag: 'Statements and billing',
    summary: "Set a site owner's commercial plan",
    description:
      'Sets the rates agreed with the owner from a month on (a new version, or a correction of that month\'s version); `plan: null` returns to the published rates. ' +
      'A month already finalised cannot be re-priced. Audited.',
    pathParams: ownerIdPath,
    body: { required: true, schema: ref('BillingPlanInput'), example: planExample },
    responses: { 200: { description: 'Saved.', schema: ref('BillingPlanSaved') } },
    errors: [400, 404],
  },
  {
    method: 'POST',
    path: '/v1/billing/owners/:id/finalise',
    tag: 'Statements and billing',
    summary: "Finalise a site owner's statement",
    description:
      "Freezes the owner's statement for a month that has ended and gives it a number. A finalised statement never changes. Audited.",
    pathParams: ownerIdPath,
    body: { required: true, schema: ref('BillingFinaliseInput'), example: { month: '2026-08' } },
    responses: { 200: { description: 'Finalised.', schema: ref('BillingFinalised') } },
    errors: [400, 404, 409],
  },

  // ============================================================ site owners
  {
    method: 'GET',
    path: '/v1/owners',
    tag: 'Site owners',
    summary: 'List site owners',
    description: 'The businesses whose sites the organisation operates, with their sites, charger count and portal user count. Archived owners come last.',
    responses: { 200: { description: 'Owners.', schema: arrayOf(ref('OwnerRow')) } },
  },
  {
    method: 'POST',
    path: '/v1/owners',
    tag: 'Site owners',
    summary: 'Create a site owner',
    description: 'Adds a business that owns sites (hotel, mall, office). Assign sites with PUT /v1/owners/:id/sites. Audited.',
    body: {
      required: true,
      schema: { allOf: [ref('OwnerInput')], required: ['name'] },
      example: {
        name: 'Hotel Menteng Raya',
        legalName: 'PT Menteng Raya Hospitality',
        npwp: '01.234.567.8-071.000',
        pkp: true,
        address: 'Jl. H.O.S. Cokroaminoto No. 12, Menteng, Jakarta Pusat 10310',
        contactName: 'Siti Rahmawati',
        contactEmail: 'finance@mentengraya.co.id',
        contactPhone: '+62 811 9876 5432',
        sellerOfRecord: 'operator',
      },
    },
    responses: { 201: { description: 'Created.', schema: obj({ id: uuid }, ['id']) } },
    errors: [400],
  },
  {
    method: 'PUT',
    path: '/v1/owners/:id',
    tag: 'Site owners',
    summary: 'Update a site owner',
    description: 'Changes the fields given; `archived: true` archives the owner, `false` restores it. At least one field is required. Audited.',
    pathParams: ownerIdPath,
    body: {
      required: true,
      schema: { allOf: [ref('OwnerInput'), obj({ archived: bool })] },
      example: { contactEmail: 'ap@mentengraya.co.id', contactPhone: '+62 812 1122 3344' },
    },
    responses: { 200: { description: 'Updated.', schema: OK } },
    errors: [400, 404],
  },
  {
    method: 'PUT',
    path: '/v1/owners/:id/sites',
    tag: 'Site owners',
    summary: "Set a site owner's sites",
    description:
      'Makes exactly these sites the owner\'s; sites no longer listed lose the owner. A site that belongs (or last belonged) to another owner and has charging history is refused with 409, ' +
      'as is an unknown site — create a new site for the new owner instead. The owner must not be archived. Audited.',
    pathParams: ownerIdPath,
    body: {
      required: true,
      schema: obj({ siteIds: { type: 'array', items: uuid } }, ['siteIds']),
      example: { siteIds: ['3f2b1c9e-7a4d-4e21-9c55-0b8a6d2e1f10', '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f'] },
    },
    responses: { 200: { description: 'Sites assigned.', schema: OK } },
    errors: [400, 404, 409],
  },

  // ============================================================ platform administration
  {
    method: 'GET',
    path: '/v1/platform/billing',
    tag: 'Platform administration',
    summary: 'Get billing across customer organisations',
    description: 'Every customer organisation with sites: its statement status, number, totals and whether it has a custom plan, for one month.',
    query: [monthQuery, currencyQuery],
    responses: {
      200: {
        description: 'Platform overview.',
        schema: obj({ month, current: month, orgs: arrayOf(ref('PlatformOrgRow')) }, ['month', 'current', 'orgs']),
      },
    },
    errors: [400],
    internal: PLATFORM_INTERNAL,
  },
  {
    method: 'GET',
    path: '/v1/platform/billing/orgs/:orgId',
    tag: 'Platform administration',
    summary: "Get a customer organisation's billing",
    description: "The organisation's statement for the month, the plan in force and its history, and its active sites with their billing model.",
    pathParams: orgIdPath,
    query: [monthQuery, currencyQuery],
    responses: { 200: { description: 'Organisation billing.', schema: ref('PlatformOrgBilling') } },
    errors: [400, 404],
    internal: PLATFORM_INTERNAL,
  },
  {
    method: 'GET',
    path: '/v1/platform/billing/orgs/:orgId/statement.html',
    tag: 'Platform administration',
    summary: "Get a customer organisation's printable statement",
    description: "The organisation's statement for the month as printable HTML.",
    pathParams: orgIdPath,
    query: [monthQuery, currencyQuery],
    responses: { 200: { description: 'HTML page.', contentType: 'text/html', schema: { type: 'string' } } },
    errors: [400, 404],
    internal: PLATFORM_INTERNAL,
  },
  {
    method: 'GET',
    path: '/v1/platform/billing/orgs/:orgId/statement.csv',
    tag: 'Platform administration',
    summary: "Download a customer organisation's statement as CSV",
    description: "The organisation's statement for the month, one row per charger, as a UTF-8 CSV attachment.",
    pathParams: orgIdPath,
    query: [monthQuery, currencyQuery],
    responses: { 200: { description: 'CSV file.', contentType: 'text/csv', schema: { type: 'string' } } },
    errors: [400, 404],
    internal: PLATFORM_INTERNAL,
  },
  {
    method: 'PUT',
    path: '/v1/platform/billing/orgs/:orgId/plan',
    tag: 'Platform administration',
    summary: "Set a customer organisation's commercial plan",
    description:
      "Sets the rates agreed with the organisation from a month on; `plan: null` returns it to the published rates. A finalised month cannot be re-priced. Audited.",
    pathParams: orgIdPath,
    body: { required: true, schema: ref('BillingPlanInput'), example: planExample },
    responses: { 200: { description: 'Saved.', schema: ref('BillingPlanSaved') } },
    errors: [400, 404],
    internal: PLATFORM_INTERNAL,
  },
  {
    method: 'PUT',
    path: '/v1/platform/billing/sites/:siteId/model',
    tag: 'Platform administration',
    summary: "Set a site's billing model",
    description: '`public`: drivers pay and the platform takes commission on the session subtotal; `private`: a flat platform fee per charger. Audited.',
    pathParams: { siteId: 'Site id (UUID), in any organisation.' },
    body: {
      required: true,
      schema: obj({ model: { type: 'string', enum: ['public', 'private'] } }, ['model']),
      example: { model: 'private' },
    },
    responses: { 200: { description: 'Saved.', schema: OK } },
    errors: [400, 404],
    internal: PLATFORM_INTERNAL,
  },
  {
    method: 'POST',
    path: '/v1/platform/billing/orgs/:orgId/finalise',
    tag: 'Platform administration',
    summary: "Finalise a customer organisation's statement",
    description: "Freezes the organisation's statement for a month that has ended and gives it a number. Audited.",
    pathParams: orgIdPath,
    body: { required: true, schema: ref('BillingFinaliseInput'), example: { month: '2026-08' } },
    responses: { 200: { description: 'Finalised.', schema: ref('BillingFinalised') } },
    errors: [400, 404, 409],
    internal: PLATFORM_INTERNAL,
  },

  // ============================================================ alerts, webhook replay
  {
    method: 'POST',
    path: '/v1/alerts/:id/acknowledge',
    tag: 'Alerts',
    summary: 'Acknowledge an alert',
    description: '"I\'m on it": records who acknowledged the alert and stops escalation notices. Only an open, not yet acknowledged alert can be acknowledged. Audited.',
    pathParams: { id: 'Alert id (UUID).' },
    responses: { 200: { description: 'Acknowledged.', schema: OK } },
    errors: [404],
  },
  {
    method: 'POST',
    path: '/v1/webhooks/:id/replay',
    tag: 'Webhooks',
    summary: 'Replay failed webhook deliveries',
    description:
      'Puts failed deliveries of the endpoint back in the queue with attempts reset — all of them, or one with `deliveryId`. Test pings are never replayed. Audited.',
    pathParams: { id: 'Webhook endpoint id (UUID).' },
    body: {
      schema: obj({ deliveryId: { type: ['integer', 'string'], description: 'Replay only this delivery (its numeric id).' } }),
      example: { deliveryId: 18342 },
    },
    responses: { 200: { description: 'Number of deliveries re-queued.', schema: obj({ requeued: int }, ['requeued']) } },
    errors: [404],
  },
  {
    method: 'POST',
    path: '/v1/alerts/:id/resolve',
    tag: 'Alerts',
    summary: 'Resolve an alert',
    description: 'Closes an open alert. Contacts who were notified get a "resolved" notice if their rule asks for one. Audited.',
    pathParams: { id: 'Alert id (UUID).' },
    responses: { 200: { description: 'Resolved.', schema: OK } },
    errors: [404],
  },

  // ============================================================ users and roles
  {
    method: 'GET',
    path: '/v1/roles',
    tag: 'Users and roles',
    summary: 'List console roles',
    description: 'The roles a user can be given, and whether each is site-scoped (Site Host) or owner-scoped (Site Owner portal).',
    responses: { 200: { description: 'Roles.', schema: arrayOf(ref('RoleDefinition')) } },
  },
  {
    method: 'GET',
    path: '/v1/users',
    tag: 'Users and roles',
    summary: 'List console users',
    description: "The organisation's operator accounts with their role grants, lock state and last sign-in. Password hashes are never returned.",
    responses: { 200: { description: 'Users.', schema: arrayOf(ref('UserRow')) } },
  },
  {
    method: 'POST',
    path: '/v1/users',
    tag: 'Users and roles',
    summary: 'Invite a console user',
    description:
      'Creates the account with one role and returns a one-time password — shown only in this response. The user must choose a new password at first sign-in. ' +
      'A Site Host needs at least one site; a Site Owner user needs an owner. Audited.',
    body: {
      required: true,
      schema: ref('UserCreateInput'),
      example: {
        name: 'Dewi Lestari',
        email: 'dewi.lestari@voltindo.co.id',
        phone: '+62 813 5555 1234',
        role: 'site_host_landlord',
        siteIds: ['3f2b1c9e-7a4d-4e21-9c55-0b8a6d2e1f10'],
      },
    },
    responses: { 200: { description: 'Created. Share the one-time password securely.', schema: ref('UserCreated') } },
    errors: [400, 409],
  },
  {
    method: 'PUT',
    path: '/v1/users/:id',
    tag: 'Users and roles',
    summary: 'Update a console user',
    description:
      'Changes name and phone, replaces the role (with its sites or owner), or sets the status. Disabling a user ends all their sessions. ' +
      'You cannot change your own role or status. Audited.',
    pathParams: { id: 'User id (UUID).' },
    body: {
      required: true,
      schema: ref('UserUpdateInput'),
      example: { role: 'field_technician', phone: '+62 813 5555 1234' },
    },
    responses: { 200: { description: 'Updated.', schema: OK } },
    errors: [400, 404],
  },
  {
    method: 'POST',
    path: '/v1/users/:id/reset-password',
    tag: 'Users and roles',
    summary: "Reset a user's password",
    description:
      'Issues a new one-time password (shown only in this response), clears any lock and ends every existing session of the user. ' +
      'The user must choose a new password at next sign-in. Audited.',
    pathParams: { id: 'User id (UUID).' },
    responses: { 200: { description: 'New one-time password.', schema: ref('UserPasswordReset') } },
    errors: [404],
  },
  {
    method: 'POST',
    path: '/v1/users/:id/reset-mfa',
    tag: 'Users and roles',
    summary: "Reset a user's two-step verification",
    description:
      'For a lost phone and recovery codes: removes the authenticator secret and every recovery code and ends every session of the user. ' +
      'Where two-step verification is required (administrators) the user sets it up again at next sign-in. Not on yourself; within your own authority only. Audited.',
    pathParams: { id: 'User id (UUID).' },
    responses: { 200: { description: 'Reset.', schema: OK } },
    errors: [400, 404],
  },
];
