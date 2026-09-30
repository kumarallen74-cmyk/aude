/**
 * API catalogue: the core routes registered in src/api/server.ts.
 * One entry per /v1 route, in source order. See ../types.ts for the format.
 */
import { type Op, type Schema, ref, arrayOf, nullable, OK } from '../types.js';

// ------------------------------------------------------------ shorthands

const S: Schema = { type: 'string' };
const UUID: Schema = { type: 'string', format: 'uuid' };
const DT: Schema = { type: 'string', format: 'date-time' };
const I: Schema = { type: 'integer' };
const N: Schema = { type: 'number' };
const B: Schema = { type: 'boolean' };
const nS = nullable('string');
const nDT = nullable('string', { format: 'date-time' });
/** A DATE rendered by Postgres inside json_build_object: `YYYY-MM-DD`. */
const nDate = nullable('string', { format: 'date' });
const nI = nullable('integer');
const nN = nullable('number');
const ANY: Schema = {};
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});

const IDENTITY = 'OCPP identity of the charge point (the last path segment of its WebSocket URL), e.g. `AUTEL-DC60-SMB-002`.';

// ------------------------------------------------------------ schemas

export const schemas: Record<string, Schema> = {
  // ---------------------------------------------------------------- fleet
  ChargePointConnector: obj(
    {
      connectorUuid: UUID,
      evseNo: I,
      connectorId: I,
      connectorType: { ...nS, description: 'Plug code: cCCS2, sType2, cType2, cChaDeMo, cGBT, sGBT.' },
      status: { ...S, description: 'Last OCPP connector status (Available, Charging, Faulted…).' },
      errorCode: nS,
      maxPowerW: I,
      currentType: { type: 'string', enum: ['AC', 'DC'] },
      phases: I,
      teraStatus: { ...S, description: 'Derived meter-verification state: verified | due_soon | lapsed | unknown | pending | exempt.' },
      teraCertStatus: { ...S, description: 'Operator-declared certification: verified | pending | exempt.' },
      teraDueAt: nDate,
      maintenanceReason: nS,
      sessionId: nullable('string', { format: 'uuid' }),
      transactionId: nS,
      sessionStartedAt: nDT,
      sessionEnergyWh: nI,
    },
    ['connectorUuid', 'evseNo', 'connectorId', 'status', 'maxPowerW', 'currentType'],
  ),
  ChargePoint: obj(
    {
      id: UUID,
      ocpp_identity: S,
      display_name: nS,
      vendor: nS,
      model: nS,
      firmware: nS,
      serial: nS,
      ocpp_version: { ...nS, description: 'ocpp1.6 | ocpp2.0.1 | ocpp2.1, as registered or last booted.' },
      status: { ...S, description: 'pending_adoption | provisioning | online | offline | decommissioned.' },
      last_seen_at: nDT,
      last_heartbeat_at: nDT,
      offline_since: nDT,
      security_profile: I,
      has_auth_key: B,
      has_client_cert: B,
      auth_key_rotated_at: nDT,
      key_rotation_days: nI,
      site_name: S,
      site_id: UUID,
      connectors: arrayOf(ref('ChargePointConnector')),
      online: { ...B, description: 'Whether the charger holds a live WebSocket right now.' },
      negotiatedVersion: { ...nS, description: 'OCPP subprotocol negotiated on the live connection.' },
    },
    ['id', 'ocpp_identity', 'status', 'security_profile', 'has_auth_key', 'has_client_cert', 'site_name', 'site_id', 'connectors', 'online', 'negotiatedVersion'],
  ),
  Frame: obj(
    {
      ts: DT,
      direction: { type: 'string', enum: ['in', 'out'] },
      message_type: { type: 'integer', enum: [2, 3, 4], description: '2 CALL, 3 CALLRESULT, 4 CALLERROR.' },
      action: nS,
      unique_id: nS,
      payload: { ...ANY, description: 'The OCPP message payload as received or sent.' },
    },
    ['ts', 'direction', 'message_type', 'payload'],
  ),

  // ---------------------------------------------------------------- commands
  CommandResult: {
    type: 'object',
    description:
      "The charger's own answer to the OCPP call (e.g. `{ \"status\": \"Accepted\" }`). GetConfiguration answers " +
      '`configurationKey` / `unknownKey`; GetCompositeSchedule and DataTransfer add their payload fields.',
    properties: {
      status: S,
      configurationKey: arrayOf(obj({ key: S, readonly: B, value: S })),
      unknownKey: arrayOf(S),
      connectorId: I,
      scheduleStart: S,
      chargingSchedule: ANY,
      data: ANY,
      fileName: S,
    },
  },
  CommandRemoteStartResult: {
    type: 'object',
    properties: {
      status: { ...S, description: "The charger's answer: Accepted or Rejected." },
      limit: obj(
        {
          type: { type: 'string', enum: ['none', 'energy', 'duration', 'amount'] },
          energyLimitWh: nI,
          durationLimitS: nI,
        },
        ['type', 'energyLimitWh', 'durationLimitS'],
      ),
    },
    required: ['limit'],
  },

  // ---------------------------------------------------------------- onboarding
  ChargePointConnectorSpec: obj(
    {
      connectorId: { type: 'integer', minimum: 1, maximum: 8 },
      connectorType: { type: 'string', enum: ['cCCS2', 'sType2', 'cType2', 'cChaDeMo', 'cGBT', 'sGBT'] },
      currentKind: { type: 'string', enum: ['DC', 'AC3', 'AC1'] },
      maxPowerW: { type: 'number', minimum: 1000, maximum: 1000000 },
      ratedVoltageV: nI,
      ratedCurrentA: nI,
      meterSerial: nS,
      meterPublicKey: { ...nS, description: 'The meter’s public key for signed readings (OCMF): hex DER, base64 or PEM. Signatures are verified against it. Omit to keep it; null clears it.' },
      accuracyClass: { ...nS, description: '0.5, 1.0 or 2.0.' },
      typeApprovalNo: nS,
      teraCertStatus: { type: 'string', enum: ['verified', 'pending', 'exempt'] },
      teraLastAt: nullable('string', { format: 'date' }),
      teraDueAt: { ...nullable('string', { format: 'date' }), description: 'Required when teraCertStatus is verified.' },
    },
    ['connectorId', 'connectorType', 'currentKind', 'maxPowerW'],
  ),
  ChargePointEvseSpec: obj(
    {
      evseId: { type: 'integer', minimum: 1, maximum: 128 },
      connectors: arrayOf(ref('ChargePointConnectorSpec')),
    },
    ['evseId', 'connectors'],
  ),
  ChargePointAuthorizationKey: obj(
    {
      key: { ...S, description: 'The AuthorizationKey in plain text. Shown once; it cannot be retrieved again.' },
      chargePointId: UUID,
      ocppIdentity: S,
      rotatedAt: DT,
      graceEndsAt: { ...DT, description: 'Until then the previous key is also accepted.' },
      commissioning: obj(
        {
          config: {
            type: 'object',
            properties: {
              format: S,
              chargePointId: S,
              centralSystemUrl: S,
              ocppVersions: arrayOf(S),
              securityProfile: I,
              basicAuth: obj({ username: S, password: S }),
              heartbeatIntervalS: I,
              generatedAt: DT,
            },
          },
          json: { ...S, description: 'The same config, pretty-printed.' },
          qrDataUrl: { ...S, description: 'PNG data: URL of a QR code carrying the config.' },
        },
        ['config', 'json', 'qrDataUrl'],
      ),
      warning: S,
    },
    ['key', 'chargePointId', 'ocppIdentity', 'rotatedAt', 'graceEndsAt', 'commissioning', 'warning'],
  ),
  ConnectionAttempt: obj(
    {
      id: I,
      ts: DT,
      remote_ip: nS,
      forwarded_for: nS,
      request_path: nS,
      ocpp_identity: nS,
      subprotocols: { ...nS, description: 'Exactly what the charger offered.' },
      negotiated: { ...nS, description: 'What the gateway echoed back, if anything.' },
      auth_present: B,
      auth_scheme: nS,
      tls: B,
      user_agent: nS,
      outcome: { ...S, description: 'accepted | accepted_pending_adoption | rejected_unknown_cp | rejected_auth | rejected_no_subprotocol | rejected_no_identity | rejected_tls_required | rejected_malformed_path | error.' },
      http_status: nI,
      detail: nS,
    },
    ['id', 'ts', 'auth_present', 'tls', 'outcome'],
  ),
  ConnectionAttemptStats: obj(
    { accepted: I, pending_adoption: I, rejected: I, identities: I },
    ['accepted', 'pending_adoption', 'rejected', 'identities'],
  ),
  PendingCharger: obj(
    {
      ocpp_identity: S,
      attempts: I,
      first_seen_at: DT,
      last_seen_at: DT,
      last_remote_ip: nS,
      last_subprotocols: nS,
      last_tls: B,
      ever_sent_credentials: B,
      last_outcome: S,
    },
    ['ocpp_identity', 'attempts', 'first_seen_at', 'last_seen_at', 'last_outcome'],
  ),
  PendingChargerSuggestion: obj({ ocpp_identity: S, site_name: S }, ['ocpp_identity', 'site_name']),
  QuirkProfile: obj(
    {
      id: UUID,
      vendor: S,
      model: S,
      firmware_pattern: { ...S, description: 'Regular expression the firmware version is matched against.' },
      findings: { type: 'object', description: 'Behaviour learned from this hardware (e.g. chargingRateUnit, compositeScheduleTrustworthy).' },
      updated_at: DT,
      charge_points: { ...I, description: 'Charge points currently resolved to this profile.' },
    },
    ['id', 'vendor', 'model', 'firmware_pattern', 'findings', 'updated_at', 'charge_points'],
  ),

  // ---------------------------------------------------------------- sessions
  SessionBreakdown: obj(
    {
      energySubtotalIdr: nN,
      serviceFeeIdr: nN,
      idleFeeIdr: nN,
      pbjtIdr: nI,
      dppIdr: nI,
      ppnIdr: nI,
      mdrIdr: { ...N, description: 'Estimated QRIS MDR (the operator’s cost, not charged to the driver).' },
      grossTotalIdr: nN,
    },
    ['mdrIdr'],
  ),
  SessionListItem: obj(
    {
      id: UUID,
      started_at: DT,
      ended_at: nDT,
      state: { ...S, description: 'active | ended | rated | settled | disputed.' },
      energy_wh: I,
      duration_s: nI,
      stop_reason: nS,
      needs_review: B,
      review_reason: nS,
      flags: { type: 'array', description: 'Regulatory and integrity flags recorded on the session (unfiltered listing only).' },
      idle_minutes: I,
      payment_mode: nS,
      prepaid_amount_idr: nI,
      prepaid_energy_wh: { ...nI, description: 'Unfiltered listing only.' },
      ocpp_identity: S,
      evse_no: I,
      site_name: S,
      total_idr: nI,
      subtotal_idr: nI,
      pbjt_idr: nI,
      ppn_idr: nI,
      ppn_dpp_idr: nI,
      lines: { type: ['array', 'null'], description: 'Frozen CDR lines (unfiltered listing only; filtered results carry `breakdown` instead).' },
      regulatory_flags: { type: ['array', 'null'] },
      // Filtered (search) rows only:
      meter_start_wh: I,
      meter_stop_wh: nI,
      ocpp_transaction_id: nS,
      display_name: nS,
      connector_type: nS,
      current_type: S,
      site_id: UUID,
      id_tag: { ...nS, description: 'RFID idTag; masked to the last 4 characters for site-scoped callers.' },
      holder_name: { ...nS, description: 'Always null for site-scoped callers.' },
      cdr_id: nullable('string', { format: 'uuid' }),
      pbjt_rate_bps: nI,
      ppn_rate_bps: nI,
      issued_at: nDT,
      payment_method: nS,
      payment_state: nS,
      payment_status: { ...S, description: 'paid | invoiced | pending | unbilled | review | in_progress | failed | refunded | free.' },
      breakdown: ref('SessionBreakdown'),
    },
    ['id', 'started_at', 'state', 'energy_wh', 'needs_review', 'idle_minutes', 'ocpp_identity', 'evse_no', 'site_name'],
  ),
  SessionMeterValue: obj(
    { ts: DT, measurand: S, value: N, unit: nS, phase: nS },
    ['ts', 'measurand', 'value'],
  ),
  SessionDetail: obj(
    {
      id: UUID,
      org_id: UUID,
      site_id: UUID,
      connector_uuid: UUID,
      charge_point_id: UUID,
      idem_key: S,
      ocpp_transaction_id: nS,
      token_id: nullable('string', { format: 'uuid' }),
      driver_id: nullable('string', { format: 'uuid' }),
      state: S,
      started_at: DT,
      ended_at: nDT,
      stop_reason: nS,
      meter_start_wh: I,
      meter_stop_wh: nI,
      energy_wh: I,
      duration_s: nI,
      prepaid_amount_idr: nI,
      prepaid_energy_wh: nI,
      payment_mode: nS,
      created_at: DT,
      charger_tx_ref: nS,
      rated_at: nDT,
      needs_review: B,
      review_reason: nS,
      flags: { type: 'array' },
      idle_minutes: I,
      last_meter_at: nDT,
      payment_intent_id: nullable('string', { format: 'uuid' }),
      operator_limit_wh: nI,
      operator_limit_until: nDT,
      operator_stop_sent_at: nDT,
      ocpi_partner_id: nullable('string', { format: 'uuid' }),
      ocpi_token_id: nullable('string', { format: 'uuid' }),
      ocpi_auth_method: nS,
      ocpi_authorization_reference: nS,
      lines: { type: ['array', 'null'], description: 'Frozen CDR lines; null until the session is rated.' },
      subtotal_idr: nI,
      pbjt_idr: nI,
      pbjt_rate_bps: nI,
      ppn_dpp_idr: nI,
      ppn_idr: nI,
      total_idr: nI,
      tariff_snapshot: { type: ['object', 'null'] },
      regulatory_flags: { type: ['array', 'null'] },
      energy_export_wh: { ...I, description: 'Energy the car gave back (bidirectional charging), from the export register.' },
      soc_percent: { ...nullable('number'), description: 'The car’s last reported state of charge.' },
      v2x_consent: { ...B, description: 'The driver or the fleet agreed to give energy back during this session.' },
      v2x_discharging: { ...B, description: 'The car is being asked to give energy back now.' },
      operation_mode: { ...nS, description: 'OCPP 2.1 operation mode last reported by the charger (e.g. ChargingOnly, CentralSetpoint).' },
      signed_status: { type: ['string', 'null'], enum: ['verified', 'unverified_key', 'mismatch', 'invalid', 'incomplete', 'missing', null], description: 'Signed meter data (OCMF) against the bill; details under /signed-data.' },
      signed_energy_wh: { ...nI, description: 'Energy between the signed start and end readings.' },
      signed_detail: nS,
      meterValues: arrayOf(ref('SessionMeterValue')),
      v2x: {
        type: ['object', 'null'],
        description:
          'ISO 15118 charging needs and bidirectional charging for this session: what the car asked for and can do (needs), its battery level, ' +
          'energy given back and the credit, consent and its source, and whether it is discharging now (or why not).',
        properties: {
          needs: { type: ['object', 'null'], description: 'The latest NotifyEVChargingNeeds: requestedTransfer, availableTransfer, bidirectional, controlMode, departureTime, energyRequestWh, maxDischargePowerW…' },
          socPercent: { type: ['number', 'null'] },
          exportWh: I,
          consent: B,
          consentSource: { type: ['string', 'null'], enum: ['driver', 'fleet', null] },
          minSocPercent: nI,
          creditIdrPerKwh: nI,
          creditIdr: I,
          discharging: B,
          dischargeW: nI,
          notDischargingBecause: nS,
          canOffer: B,
        },
      },
    },
    ['id', 'org_id', 'site_id', 'connector_uuid', 'charge_point_id', 'state', 'started_at', 'energy_wh', 'needs_review', 'meterValues'],
  ),
  SignedMeterData: obj(
    {
      policy: { type: 'string', enum: ['off', 'record', 'require'], description: 'The site’s policy.' },
      status: { type: ['string', 'null'], enum: ['verified', 'unverified_key', 'mismatch', 'invalid', 'incomplete', 'missing', null] },
      detail: nS,
      signedEnergyWh: nI,
      billedEnergyWh: I,
      meterSerial: nS,
      meterPublicKey: { ...nS, description: 'The registered key (hex DER) the signatures are checked against.' },
      transactionId: nS,
      values: arrayOf(obj({
        id: I,
        sampledAt: nDT,
        context: { ...nS, description: 'Transaction.Begin, Transaction.End, Sample.Periodic…' },
        encoding: S,
        ocmf: { ...S, description: 'The signed data as received (OCMF|payload|signature).' },
        meterSerial: nS,
        readings: arrayOf(obj({ tm: S, tx: nS, wh: nI, register: { type: 'string', enum: ['import', 'export', 'other'] }, ri: nS, ok: B, st: S, ef: S })),
        verifyStatus: { type: 'string', enum: ['valid', 'invalid', 'no_key', 'unreadable', 'unsupported'] },
        verifyDetail: nS,
        keySource: { type: ['string', 'null'], enum: ['registered', 'charger', null] },
        chargerKey: { ...nS, description: 'A key the charger sent with the data (not a trust anchor).' },
      }, ['id', 'encoding', 'ocmf', 'readings', 'verifyStatus'])),
    },
    ['policy', 'status', 'billedEnergyWh', 'values'],
  ),
  SessionRerateResult: obj(
    {
      ok: { ...B, description: 'true when a CDR exists for the session after the call.' },
      cdr: { type: ['object', 'null'], properties: { id: UUID } },
      forced: { ...B, description: 'Present when ok is true.' },
      reason: { ...S, description: 'Present when ok is false: why the engine declined to price the session.' },
      hint: { ...S, description: 'Present when ok is false.' },
    },
    ['ok', 'cdr'],
  ),

  // ---------------------------------------------------------------- tariffs
  TariffFlag: obj(
    {
      code: S,
      severity: { type: 'string', enum: ['info', 'warning', 'violation'] },
      message: S,
    },
    ['code', 'severity', 'message'],
  ),
  TariffComponentInput: obj(
    {
      kind: { type: 'string', enum: ['energy', 'time', 'session', 'idle', 'admin'] },
      rate: { ...N, description: 'IDR per kWh (energy), per minute (time, idle) or flat (session, admin).' },
      touBlock: { type: 'string', enum: ['WBP', 'LWBP', 'ANY'], default: 'ANY' },
      dayMask: { type: 'integer', minimum: 0, maximum: 127, default: 127, description: 'Bitmask, bit 0 = Monday.' },
      timeFrom: { ...S, description: 'HH:MM local site time.' },
      timeTo: { ...S, description: 'HH:MM local site time.' },
      fromKwh: { ...N, default: 0 },
      toKwh: N,
      fromMinutes: { ...I, default: 0, description: 'Grace period before an idle/time component accrues.' },
      toMinutes: I,
      sortOrder: I,
    },
    ['kind', 'rate'],
  ),
  TariffDefinition: obj(
    {
      id: S,
      name: S,
      currency: { type: 'string', enum: ['IDR'] },
      plnScheme: { type: 'string', enum: ['curah', 'layanan_khusus', 'none'] },
      plnBaseRate: N,
      plnMultiplier: N,
      components: arrayOf(ref('TariffComponentInput')),
      ppnApplies: B,
    },
    ['components'],
  ),
  Tariff: obj(
    {
      id: UUID,
      name: S,
      pln_scheme: nS,
      pln_base_rate: { ...nS, description: 'NUMERIC, returned as a decimal string.' },
      pln_multiplier: { ...nS, description: 'NUMERIC, returned as a decimal string.' },
      active_from: DT,
      active_to: nDT,
      validated_at: nDT,
      validation: arrayOf(ref('TariffFlag')),
      status: { type: 'string', enum: ['active', 'archived'] },
      description: nS,
      pricing_model: { ...S, description: 'flat | tou | tiered.' },
      ppn_applies: B,
      mdr_mode: S,
      archived_at: nDT,
      created_by: nS,
      components: arrayOf(
        obj({
          kind: S,
          rate: N,
          touBlock: S,
          dayMask: I,
          timeFrom: nS,
          timeTo: nS,
          fromKwh: N,
          toKwh: nN,
          fromMinutes: I,
          toMinutes: nI,
        }),
      ),
      assignments: arrayOf(
        obj({
          id: UUID,
          scopeType: S,
          scopeId: nullable('string', { format: 'uuid' }),
          priority: I,
          currentType: nS,
          scopeName: nS,
        }),
      ),
    },
    ['id', 'name', 'active_from', 'status', 'components', 'assignments'],
  ),
  TariffRating: obj(
    {
      lines: arrayOf(
        obj(
          { kind: S, description: S, quantity: N, unit: S, unitRate: N, amountIdr: N, touBlock: S },
          ['kind', 'description', 'quantity', 'unit', 'unitRate', 'amountIdr'],
        ),
      ),
      chargingClass: { type: 'string', enum: ['slow', 'medium', 'fast', 'ultrafast'] },
      tax: obj(
        {
          subtotalIdr: N,
          pbjtBaseIdr: N,
          pbjtRateBps: N,
          pbjtIdr: N,
          ppnDppIdr: N,
          ppnRateBps: N,
          ppnIdr: N,
          totalIdr: N,
        },
        ['subtotalIdr', 'pbjtIdr', 'ppnDppIdr', 'ppnIdr', 'totalIdr'],
      ),
      flags: arrayOf(ref('TariffFlag')),
      tariffSnapshot: { type: 'object' },
    },
    ['lines', 'chargingClass', 'tax', 'flags', 'tariffSnapshot'],
  ),

  // ---------------------------------------------------------------- payments
  CheckoutQrisCharge: obj(
    {
      providerRef: S,
      qrString: { ...S, description: 'Payload to render as a QR code.' },
      amountIdr: N,
      expiresAt: DT,
      status: { type: 'string', enum: ['pending', 'paid', 'expired', 'failed'] },
    },
    ['providerRef', 'qrString', 'amountIdr', 'expiresAt', 'status'],
  ),
  CheckoutQrisResult: obj(
    {
      paymentIntentId: UUID,
      qr: ref('CheckoutQrisCharge'),
      allowanceWh: { ...N, description: 'Energy the payment buys, quoted against the worst-case tariff block.' },
      allowanceKwh: N,
      estimatedMdrIdr: N,
      inZeroMdrBand: B,
      startToken: { ...S, description: 'The only idTag that can claim this payment. Show it to the driver.' },
      startTokenMinted: { ...B, description: 'true when PlugSure generated the token (walk-up), false when the caller supplied idToken.' },
      expiresInMinutes: I,
    },
    ['paymentIntentId', 'qr', 'allowanceWh', 'allowanceKwh', 'estimatedMdrIdr', 'inZeroMdrBand', 'startToken', 'startTokenMinted', 'expiresInMinutes'],
  ),

  // ---------------------------------------------------------------- load management
  PowerHeadroom: obj(
    {
      subscribedKva: N,
      activeKva: N,
      installedKva: N,
      headroomKva: N,
      unmanagedOversubscriptionKva: N,
      rekeningMinimumKwhEquivalent: N,
      crossesTrTmCliff: B,
      trTmThresholdKva: N,
      powerFactor: N,
      ceilingW: N,
      curtailed: B,
    },
    ['subscribedKva', 'activeKva', 'installedKva', 'headroomKva', 'powerFactor', 'ceilingW', 'curtailed'],
  ),
  PowerSiteBudget: obj(
    {
      siteId: UUID,
      ceilingW: { ...N, description: 'Effective ceiling, clamped to the subscription (connected kVA × PF).' },
      reserveW: N,
      strategy: { type: 'string', enum: ['fair_share', 'priority', 'fifo'] },
      curtailed: B,
      connectedKva: nN,
      powerFactor: N,
      phases: I,
      nominalVoltageV: I,
      reserveBreakdown: { type: 'object', additionalProperties: { type: 'number' } },
      curtailedReason: nS,
      curtailedAt: nDT,
      configuredCeilingW: { ...N, description: 'The stored ceiling before the subscription clamp.' },
    },
    ['siteId', 'ceilingW', 'reserveW', 'strategy', 'curtailed', 'connectedKva', 'powerFactor'],
  ),
  PowerAllocation: obj(
    {
      ocppIdentity: S,
      chargePointId: UUID,
      connectorNo: I,
      maxPowerW: N,
      minPowerW: N,
      currentType: { type: 'string', enum: ['AC', 'DC'] },
      phases: I,
      priority: N,
      transactionId: { type: ['integer', 'string'], description: 'Present while a session is active: integer on OCPP 1.6, string on 2.0.1.' },
      active: B,
      connectorUuid: UUID,
      connectorType: nS,
      allocatedW: N,
      unit: { type: 'string', enum: ['A', 'W'] },
      limit: { ...N, description: 'The allocation in `unit` (amps for AC, watts for DC).' },
    },
    ['ocppIdentity', 'chargePointId', 'connectorNo', 'maxPowerW', 'currentType', 'active', 'allocatedW', 'unit', 'limit'],
  ),

  // ---------------------------------------------------------------- compliance
  ComplianceMeter: obj(
    {
      chargePoint: S,
      evseNo: I,
      meterSerial: nS,
      accuracyClass: nS,
      typeApprovalNo: nS,
      teraLastAt: nDate,
      teraDueAt: nDate,
      teraStatus: S,
      teraCertStatus: S,
    },
    ['chargePoint', 'evseNo', 'teraStatus', 'teraCertStatus'],
  ),
  ComplianceSite: obj(
    {
      id: UUID,
      name: S,
      spklu_id: nS,
      spklu_scheme: nS,
      slo_number: nS,
      slo_issued_at: nDT,
      slo_expires_at: nDT,
      kabupaten_kota_code: nS,
      pbjt_rate_bps: I,
      meters: arrayOf(ref('ComplianceMeter')),
      spkluParsed: {
        type: ['object', 'null'],
        properties: {
          raw: S,
          entityCode: S,
          scheme: S,
          schemeFamily: { type: 'string', enum: ['provider', 'retailer'] },
          ownsAsset: B,
          selfOperated: B,
          block: S,
          kabupatenKotaCode: S,
          sequence: S,
        },
      },
      spkluIdValid: nullable('boolean'),
      municipalityMatchesSpklu: nullable('boolean'),
      sloDaysRemaining: nI,
    },
    ['id', 'name', 'pbjt_rate_bps', 'meters', 'spkluParsed', 'spkluIdValid', 'municipalityMatchesSpklu', 'sloDaysRemaining'],
  ),

  // ---------------------------------------------------------------- audit
  AuditEntry: obj(
    {
      ts: DT,
      actor_type: { ...S, description: 'user | api_client | system | charge_point.' },
      actor_id: nS,
      action: S,
      target_type: nS,
      target_id: nS,
      after_state: { ...ANY, description: 'JSON snapshot recorded with the action, or null.' },
    },
    ['ts', 'actor_type', 'action'],
  ),
  AuditChain: obj(
    {
      ok: { ...B, description: 'false when the hash chain shows tampering, deletion or truncation.' },
      entries: I,
      expectedEntries: I,
      problems: arrayOf(
        obj(
          {
            kind: { type: 'string', enum: ['mutated', 'broken_link', 'forged_row', 'deleted', 'truncated', 'reordered', 'missing_head', 'head_mismatch'] },
            atId: I,
            atSeq: I,
            detail: S,
          },
          ['kind', 'detail'],
        ),
      ),
      brokenAtId: I,
    },
    ['ok', 'entries', 'expectedEntries', 'problems'],
  ),

  // ---------------------------------------------------------------- api keys
  ApiKey: obj(
    {
      id: UUID,
      name: S,
      prefix: { ...S, description: 'Public part of the key, safe to log.' },
      permissions: arrayOf(S),
      scope_type: { type: 'string', enum: ['org', 'site', 'fleet'] },
      scope_id: nullable('string', { format: 'uuid' }),
      created_at: DT,
      last_used_at: nDT,
      revoked_at: nDT,
      rate_limit_per_min: { ...nullable('integer'), description: 'The key’s own limit, requests a minute; null = the installation default.' },
      effective_rate_limit_per_min: { type: 'integer', description: 'The limit in force for this key.' },
      requests_24h: { type: 'integer', description: 'Requests made with the key in the last 24 hours.' },
      limited_24h: { type: 'integer', description: 'Of those, refused for the rate limit (429).' },
      errors_24h: { type: 'integer', description: 'Of those, answered with another error (4xx or 5xx).' },
    },
    ['id', 'name', 'prefix', 'permissions', 'scope_type', 'created_at', 'rate_limit_per_min', 'effective_rate_limit_per_min'],
  ),
  ApiKeyUsageHour: obj(
    {
      hour: { ...DT, description: 'Start of the hour (UTC).' },
      requests: { type: 'integer' },
      limited: { type: 'integer', description: 'Refused for the rate limit (429).' },
      errors: { type: 'integer', description: 'Answered with another error (4xx or 5xx).' },
    },
    ['hour', 'requests', 'limited', 'errors'],
  ),
  ApiKeyIssued: obj(
    {
      id: UUID,
      key: { ...S, description: 'The full secret (`psk_<prefix>_<secret>`). Shown once.' },
      prefix: S,
      warning: S,
    },
    ['id', 'key', 'prefix', 'warning'],
  ),

  // ---------------------------------------------------------------- alerts
  Alert: obj(
    {
      id: UUID,
      severity: { ...S, description: 'info | warning | critical.' },
      kind: S,
      message: S,
      raised_at: DT,
      resolved_at: nDT,
      acknowledged_at: nDT,
      occurrences: I,
      last_raised_at: nDT,
      site_id: nullable('string', { format: 'uuid' }),
    },
    ['id', 'severity', 'kind', 'message', 'raised_at', 'occurrences'],
  ),
};

// ------------------------------------------------------------ shared op pieces

const identityParam = { identity: IDENTITY };
const sinceUntil = [
  { name: 'since', description: 'Only entries at or after this instant.', schema: DT },
  { name: 'until', description: 'Only entries at or before this instant.', schema: DT },
];

const COMMAND_PERMISSIONS = ['charge_point:command'];
const commandResponse = { 200: { description: "The charger's answer.", schema: ref('CommandResult') } };

// ------------------------------------------------------------ operations

export const ops: Op[] = [
  // ---------------------------------------------------------------- fleet
  {
    method: 'GET',
    path: '/v1/charge-points',
    tag: 'Chargers',
    summary: 'List charge points',
    description:
      'Every charge point in the caller’s organisation (limited to the caller’s sites for site-scoped users), ordered by site and identity, ' +
      'with its connectors, the active session on each connector, security and commissioning fields, and live connection state.',
    responses: { 200: { description: 'The fleet.', schema: arrayOf(ref('ChargePoint')) } },
  },
  {
    method: 'GET',
    path: '/v1/charge-points/:identity/frames',
    tag: 'Chargers',
    summary: 'List OCPP frames',
    description:
      'The raw OCPP message log for one charge point, newest first. Frames carry drivers’ RFID idTags, so site-scoped callers also need ' +
      '`charge_point:config` or `charge_point:command` on the charger, and see history only from when it joined its current site.',
    pathParams: identityParam,
    query: [
      ...sinceUntil,
      { name: 'action', description: 'OCPP action, e.g. `StatusNotification`.', schema: S },
      { name: 'direction', description: '`in` (from the charger) or `out` (to the charger).', schema: { type: 'string', enum: ['in', 'out'] } },
      { name: 'limit', description: 'Maximum rows.', schema: { type: 'integer', default: 200, maximum: 2000 } },
    ],
    responses: { 200: { description: 'Frames, newest first.', schema: arrayOf(ref('Frame')) } },
    errors: [404],
  },
  {
    method: 'GET',
    path: '/v1/charge-points/:identity/frames.ndjson',
    tag: 'Chargers',
    summary: 'Export OCPP frames as NDJSON',
    description:
      'Downloads up to 50,000 frames for one charge point, oldest first, one JSON object per line (same fields as the frame list). ' +
      'Same access rule as the frame list.',
    pathParams: identityParam,
    responses: {
      200: { description: 'Newline-delimited JSON, sent as an attachment.', contentType: 'application/x-ndjson', schema: S },
    },
    errors: [404],
  },

  // ---------------------------------------------------------------- commands
  {
    method: 'POST',
    path: '/v1/charge-points/:identity/commands/:command',
    tag: 'Commands',
    summary: 'Send a command to a charge point',
    description:
      'Generic command dispatcher; the named routes (remote-start, unlock, …) run the same code. Every command is written to the audit log with the caller. ' +
      'The configuration commands (get-configuration, change-configuration, get-diagnostics) also accept `charge_point:config`. ' +
      'A charger that is not connected makes the call fail with 500. Remote start answers 409 when the connector’s meter verification (tera) has lapsed or is pending.',
    pathParams: {
      ...identityParam,
      command:
        'remote-start | remote-stop | reset | unlock | change-availability | trigger | get-configuration | change-configuration | clear-cache | ' +
        'set-charging-profile | clear-charging-profile | get-composite-schedule | data-transfer | get-diagnostics | update-firmware | reserve-now | cancel-reservation',
    },
    body: {
      description: 'Fields depend on the command; see the named routes for the common ones.',
      schema: {
        type: 'object',
        properties: {
          connectorId: I,
          idTag: { ...S, description: 'remote-start.' },
          limitType: { type: 'string', enum: ['none', 'energy', 'duration', 'amount'], description: 'remote-start.' },
          limitValue: { ...N, description: 'remote-start: kWh, minutes or IDR.' },
          transactionId: { type: ['integer', 'string'], description: 'remote-stop.' },
          type: { ...S, description: 'reset: Soft | Hard. change-availability: Operative | Inoperative.' },
          reason: { ...S, description: 'change-availability: required (3+ characters) when taking a connector out of service.' },
          requestedMessage: { ...S, description: 'trigger. Default StatusNotification.' },
          keys: { ...arrayOf(S), description: 'get-configuration.' },
          key: { ...S, description: 'change-configuration.' },
          value: { ...S, description: 'change-configuration.' },
          durationS: { ...I, description: 'get-composite-schedule. Default 600.' },
          chargingRateUnit: { type: 'string', enum: ['A', 'W'] },
          vendorId: { ...S, description: 'data-transfer.' },
          messageId: S,
          data: ANY,
          location: { ...S, description: 'get-diagnostics / update-firmware: upload or download URL.' },
          retrieveDate: { ...DT, description: 'update-firmware. Default now.' },
          reservationId: { ...I, description: 'reserve-now / cancel-reservation.' },
          expiryDate: { ...DT, description: 'reserve-now.' },
        },
      },
      example: { connectorId: 1 },
    },
    responses: commandResponse,
    errors: [400, 404, 409],
    permissions: COMMAND_PERMISSIONS,
  },
  {
    method: 'POST',
    path: '/v1/charge-points/:identity/remote-start',
    tag: 'Commands',
    summary: 'Start a session remotely',
    description:
      'Sends RemoteStartTransaction for an RFID tag or driver account, optionally capped by energy, duration or amount. ' +
      'Refused with 409 when the connector’s meter verification (tera) has lapsed or awaits calibration. A caller without `session:write` ' +
      '(e.g. a field technician) may only start with a technician or VIP card (403 otherwise). Audited.',
    pathParams: identityParam,
    body: {
      schema: {
        type: 'object',
        properties: {
          connectorId: { type: 'integer', default: 1 },
          idTag: { ...S, minLength: 1, description: 'The RFID uid or driver token to start for.' },
          limitType: { type: 'string', enum: ['none', 'energy', 'duration', 'amount'], default: 'none' },
          limitValue: {
            ...N,
            description: 'energy: 0.1–1000 kWh; duration: 1–1440 minutes; amount: Rp 1,000–10,000,000 (converted to energy through the tariff).',
          },
        },
        required: ['idTag'],
      },
      example: { connectorId: 1, idTag: '04A2B3C4D5E6F7', limitType: 'amount', limitValue: 150000 },
    },
    responses: { 200: { description: "The charger's answer and the limit recorded for the session.", schema: ref('CommandRemoteStartResult') } },
    errors: [400, 404, 409],
    permissions: COMMAND_PERMISSIONS,
  },
  {
    method: 'POST',
    path: '/v1/charge-points/:identity/remote-stop',
    tag: 'Commands',
    summary: 'Stop a session remotely',
    description: 'Sends RemoteStopTransaction. The transaction id is an integer on OCPP 1.6 and the station’s own string on 2.0.1. Audited.',
    pathParams: identityParam,
    body: {
      schema: {
        type: 'object',
        properties: { transactionId: { type: ['integer', 'string'], description: 'The OCPP transaction id of the running session.' } },
        required: ['transactionId'],
      },
      example: { transactionId: 18342 },
    },
    responses: commandResponse,
    errors: [400, 404],
    permissions: COMMAND_PERMISSIONS,
  },
  {
    method: 'POST',
    path: '/v1/charge-points/:identity/unlock',
    tag: 'Commands',
    summary: 'Unlock a connector',
    description: 'Sends UnlockConnector, e.g. to release a cable stuck in the socket. Audited.',
    pathParams: identityParam,
    body: {
      schema: { type: 'object', properties: { connectorId: { type: 'integer', default: 1 } } },
      example: { connectorId: 2 },
    },
    responses: commandResponse,
    errors: [404],
    permissions: COMMAND_PERMISSIONS,
  },
  {
    method: 'POST',
    path: '/v1/charge-points/:identity/reset',
    tag: 'Commands',
    summary: 'Reset a charge point',
    description: 'Sends Reset. Anything other than `Hard` is sent as a Soft reset. Audited.',
    pathParams: identityParam,
    body: {
      schema: { type: 'object', properties: { type: { type: 'string', enum: ['Soft', 'Hard'], default: 'Soft' } } },
      example: { type: 'Soft' },
    },
    responses: commandResponse,
    errors: [404],
    permissions: COMMAND_PERMISSIONS,
  },
  {
    method: 'POST',
    path: '/v1/charge-points/:identity/availability',
    tag: 'Commands',
    summary: 'Change connector availability',
    description:
      'Sends ChangeAvailability for one connector (or the whole station with connectorId 0) and records the maintenance reason on the connector. ' +
      'Taking a connector out of service (`Inoperative`) requires a reason. Audited as charge_point.availability_changed.',
    pathParams: identityParam,
    body: {
      schema: {
        type: 'object',
        properties: {
          connectorId: { type: 'integer', default: 0, description: '0 = the whole station.' },
          type: { type: 'string', enum: ['Operative', 'Inoperative'], default: 'Operative' },
          reason: { ...S, description: 'Required (at least 3 characters) for Inoperative.' },
        },
      },
      example: { connectorId: 2, type: 'Inoperative', reason: 'gun 2 cable damaged' },
    },
    responses: commandResponse,
    errors: [400, 404],
    permissions: COMMAND_PERMISSIONS,
  },
  {
    method: 'POST',
    path: '/v1/charge-points/:identity/trigger',
    tag: 'Commands',
    summary: 'Trigger a message from a charge point',
    description: 'Sends TriggerMessage, asking the charger to send a message now (StatusNotification by default). Audited.',
    pathParams: identityParam,
    body: {
      schema: {
        type: 'object',
        properties: {
          requestedMessage: {
            type: 'string',
            default: 'StatusNotification',
            description: 'BootNotification, Heartbeat, MeterValues, StatusNotification, DiagnosticsStatusNotification, FirmwareStatusNotification.',
          },
          connectorId: I,
        },
      },
      example: { requestedMessage: 'MeterValues', connectorId: 1 },
    },
    responses: commandResponse,
    errors: [404],
    permissions: COMMAND_PERMISSIONS,
  },
  {
    method: 'POST',
    path: '/v1/charge-points/:identity/clear-cache',
    tag: 'Commands',
    summary: 'Clear the authorisation cache',
    description: 'Sends ClearCache so the charger forgets locally cached idTag authorisations. Audited.',
    pathParams: identityParam,
    responses: commandResponse,
    errors: [404],
    permissions: COMMAND_PERMISSIONS,
  },

  // ---------------------------------------------------------------- charge point security
  {
    method: 'POST',
    path: '/v1/charge-points/:identity/authorization-key',
    tag: 'Onboarding',
    summary: 'Issue an authorization key',
    description:
      'Issues (or rotates) the OCPP Basic-auth AuthorizationKey and returns it once, with a commissioning bundle (JSON and QR). ' +
      'A 160-bit random key is generated unless `key` is supplied. The previous key stays valid for a grace window. ' +
      'Configure the key on the charger before raising its security profile. Audited.',
    pathParams: identityParam,
    body: {
      schema: {
        type: 'object',
        properties: {
          key: { type: 'string', pattern: '^[A-Za-z0-9]{16,40}$', description: 'Optional installer-chosen key: 16–40 letters and digits, at least 8 distinct characters.' },
          rotationDays: { type: 'integer', minimum: 7, maximum: 730, description: 'Raise a rotation reminder when the key is older than this.' },
        },
      },
      example: { rotationDays: 180 },
    },
    responses: { 200: { description: 'The new key (shown once) and commissioning bundle.', schema: ref('ChargePointAuthorizationKey') } },
    errors: [400, 404],
  },
  {
    method: 'PUT',
    path: '/v1/charge-points/:identity/security-profile',
    tag: 'Onboarding',
    summary: 'Set the security profile',
    description:
      'Sets the OCPP security profile the gateway enforces. Refused with 409 when the charger could no longer connect: profile 1–2 without an ' +
      'AuthorizationKey, profile 3 without a client-certificate binding, or profile 2+ when the gateway has no TLS. Audited.',
    pathParams: identityParam,
    body: {
      schema: { type: 'object', properties: { profile: { type: 'integer', enum: [0, 1, 2, 3] } }, required: ['profile'] },
      example: { profile: 2 },
    },
    responses: {
      200: {
        description: 'Profile applied.',
        schema: obj({ ok: { type: 'boolean', const: true }, profile: { type: 'integer', enum: [0, 1, 2, 3] } }, ['ok', 'profile']),
      },
    },
    errors: [400, 404, 409],
  },
  {
    method: 'PUT',
    path: '/v1/charge-points/:identity/client-certificate',
    tag: 'Onboarding',
    summary: 'Bind the client certificate',
    description:
      'Binds the charger’s client-certificate SHA-256 fingerprint for Security Profile 3 (mutual TLS). Send the certificate PEM or a fingerprint; ' +
      'an empty fingerprint clears the binding. Only the fingerprint is stored. Audited.',
    pathParams: identityParam,
    body: {
      schema: {
        type: 'object',
        properties: {
          certificatePem: { ...S, description: 'The charger’s certificate (PEM). Takes precedence over fingerprint.' },
          fingerprint: { ...S, description: 'SHA-256 fingerprint, 64 hex characters (colons allowed). Empty string clears.' },
        },
      },
      example: { fingerprint: '3F:A1:9C:0B:7E:22:5D:84:61:C0:9A:17:EE:40:B3:2F:58:D6:0C:71:9B:E2:44:A8:13:6F:C5:90:2D:7A:BE:01' },
    },
    responses: {
      200: {
        description: 'Binding stored.',
        schema: obj({ ok: { type: 'boolean', const: true }, fingerprint: { ...nS, description: '64 lowercase hex characters, or null when cleared.' } }, ['ok', 'fingerprint']),
      },
    },
    errors: [400, 404],
  },

  // ---------------------------------------------------------------- connections & adoption
  {
    method: 'GET',
    path: '/v1/connection-attempts',
    tag: 'Chargers',
    summary: 'List connection attempts',
    description: 'WebSocket connection attempts by the organisation’s own charge points, accepted and refused, newest first — the evidence for commissioning failures.',
    query: [
      { name: 'identity', description: 'Only this OCPP identity.', schema: S },
      {
        name: 'outcome',
        description: 'Only this outcome.',
        schema: {
          type: 'string',
          enum: ['accepted', 'accepted_pending_adoption', 'rejected_unknown_cp', 'rejected_auth', 'rejected_no_subprotocol', 'rejected_no_identity', 'rejected_tls_required', 'rejected_malformed_path', 'error'],
        },
      },
      ...sinceUntil,
      { name: 'limit', description: 'Maximum rows.', schema: { type: 'integer', default: 200, maximum: 1000 } },
    ],
    responses: { 200: { description: 'Attempts, newest first.', schema: arrayOf(ref('ConnectionAttempt')) } },
  },
  {
    method: 'GET',
    path: '/v1/connection-attempts/stats',
    tag: 'Chargers',
    summary: 'Summarise connection attempts',
    description: 'Counts of accepted, pending-adoption and refused attempts, and distinct identities, by the organisation’s charge points over a recent window.',
    query: [{ name: 'minutes', description: 'Window length in minutes.', schema: { type: 'integer', default: 60 } }],
    responses: { 200: { description: 'Counts for the window.', schema: ref('ConnectionAttemptStats') } },
  },
  {
    method: 'GET',
    path: '/v1/pending-chargers',
    tag: 'Onboarding',
    summary: 'List unknown chargers knocking',
    description:
      'Identities that connected and were refused because no organisation has registered them (up to 200, most recent first). ' +
      'They belong to no tenant, so this is a platform-operator view; tenants pre-register identities with POST /v1/charge-points instead.',
    responses: { 200: { description: 'Unregistered identities.', schema: arrayOf(ref('PendingCharger')) } },
    internal: 'Platform administration (platform:admin): lists every tenant’s unregistered hardware.',
  },
  {
    method: 'GET',
    path: '/v1/pending-chargers/:identity/suggestions',
    tag: 'Onboarding',
    summary: 'Suggest registered identities',
    description: 'Up to 5 charge points in the caller’s own fleet whose identity resembles the given one (case-insensitive or substring match) — the usual cause of a refused connection.',
    pathParams: { identity: 'The identity the charger presented.' },
    responses: { 200: { description: 'Near matches.', schema: arrayOf(ref('PendingChargerSuggestion')) } },
  },
  {
    method: 'POST',
    path: '/v1/charge-points',
    tag: 'Onboarding',
    summary: 'Register a charge point',
    description:
      'Pre-registers a charge point before it dials in, optionally with its hardware profile and EVSE/connector topology. It is created in ' +
      '`pending_adoption`: it may connect but is answered Pending until activated. Returns 409 when the identity is already registered and 422 ' +
      'when the topology is invalid. Audited as charge_point.registered.',
    body: {
      schema: {
        type: 'object',
        properties: {
          ocppIdentity: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,128}$' },
          siteId: { ...UUID, description: 'The site the charger is installed at.' },
          displayName: { type: 'string', maxLength: 200 },
          vendor: { type: 'string', maxLength: 100 },
          model: { type: 'string', maxLength: 100 },
          serial: { type: 'string', maxLength: 100 },
          firmware: { type: 'string', maxLength: 100 },
          ocppVersion: { type: 'string', enum: ['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1'] },
          evses: {
            ...arrayOf(ref('ChargePointEvseSpec')),
            description: 'Topology. On OCPP 1.6 each gun is its own EVSE with one connector.',
          },
        },
        required: ['ocppIdentity', 'siteId'],
      },
      example: {
        ocppIdentity: 'AUTEL-DC60-SMB-002',
        siteId: '6f1c2a8e-4b7d-4e0a-9c3f-2d5e8b1a7c40',
        displayName: 'Summarecon Mall Bekasi — DC 60 kW #2',
        vendor: 'Autel Energy',
        model: 'MaxiCharger DC Compact',
        serial: 'AE60D2403117',
        ocppVersion: 'ocpp1.6',
        evses: [
          {
            evseId: 1,
            connectors: [
              { connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-05-25' },
            ],
          },
        ],
      },
    },
    responses: {
      200: {
        description: 'Registered, awaiting activation.',
        schema: obj(
          {
            ok: { type: 'boolean', const: true },
            chargePointId: UUID,
            identity: S,
            status: { type: 'string', const: 'pending_adoption' },
            next: { ...arrayOf(S), description: 'The remaining commissioning steps.' },
          },
          ['ok', 'identity', 'status', 'next'],
        ),
      },
    },
    errors: [400, 404, 409, 422],
  },
  {
    method: 'POST',
    path: '/v1/pending-chargers/:identity/adopt',
    tag: 'Onboarding',
    summary: 'Adopt a pending charger',
    description:
      'Registers an identity that already tried to connect, at one of the caller’s sites, in `pending_adoption`. Returns 400 when the identity is ' +
      'already registered. Audited as charge_point.adopted.',
    pathParams: { identity: 'The identity the charger presented.' },
    body: {
      schema: { type: 'object', properties: { siteId: { ...UUID, description: 'The site to adopt it into.' } }, required: ['siteId'] },
      example: { siteId: '6f1c2a8e-4b7d-4e0a-9c3f-2d5e8b1a7c40' },
    },
    responses: {
      200: {
        description: 'Adopted.',
        schema: obj({ ok: { type: 'boolean', const: true }, chargePointId: UUID, identity: S }, ['ok', 'identity']),
      },
    },
    errors: [400, 404],
  },
  {
    method: 'POST',
    path: '/v1/charge-points/:identity/activate',
    tag: 'Onboarding',
    summary: 'Activate a charge point',
    description:
      'Moves a `pending_adoption` charge point into service so it can transact; a connected unit is asked to boot again at once. ' +
      '`activated` is false when it was not pending. Audited when it changes.',
    pathParams: identityParam,
    responses: {
      200: {
        description: 'Result.',
        schema: obj({ ok: { type: 'boolean', const: true }, activated: B }, ['ok', 'activated']),
      },
    },
    errors: [404],
  },

  // ---------------------------------------------------------------- quirks
  {
    method: 'GET',
    path: '/v1/quirks',
    tag: 'Chargers',
    summary: 'List hardware quirk profiles',
    description: 'Per vendor/model/firmware behaviour the platform has learned and adapts to, with how many charge points use each profile.',
    responses: { 200: { description: 'Quirk profiles.', schema: arrayOf(ref('QuirkProfile')) } },
  },

  // ---------------------------------------------------------------- sessions
  {
    method: 'GET',
    path: '/v1/sessions',
    tag: 'Sessions',
    summary: 'List charging sessions',
    description:
      'Charging sessions, newest first, with the billed amounts. Without filters it returns the most recent sessions including the frozen CDR lines; ' +
      'with any filter it searches and adds card, payment status and a financial `breakdown` per row. Site-scoped callers see only their sites, ' +
      'with card numbers masked and no holder names.',
    query: [
      { name: 'limit', description: 'Maximum rows.', schema: { type: 'integer', default: 50, minimum: 1, maximum: 500 } },
      { name: 'offset', description: 'Rows to skip (filtered searches only).', schema: { type: 'integer', default: 0, minimum: 0 } },
      { name: 'from', description: 'Sessions started at or after this instant.', schema: DT },
      { name: 'to', description: 'Sessions started before this instant.', schema: DT },
      { name: 'siteId', description: 'Only this site.', schema: UUID },
      { name: 'identity', description: 'Only this charge point.', schema: S },
      { name: 'connectorType', description: 'A plug code (cCCS2, sType2…) or AC / DC.', schema: S },
      {
        name: 'paymentStatus',
        description: 'Only this payment status.',
        schema: { type: 'string', enum: ['paid', 'invoiced', 'pending', 'unbilled', 'review', 'in_progress', 'failed', 'refunded', 'free', 'held', 'released'] },
      },
      { name: 'state', description: 'Session state: active, ended, rated, settled, disputed.', schema: S },
      { name: 'q', description: 'Session id, OCPP transaction id or card uid (whole-value match for site-scoped callers).', schema: S },
    ],
    responses: { 200: { description: 'Sessions, newest first.', schema: arrayOf(ref('SessionListItem')) } },
  },
  {
    method: 'GET',
    path: '/v1/sessions/:id',
    tag: 'Sessions',
    summary: 'Get a charging session',
    description: 'The full session record, its CDR (lines, tax amounts, tariff snapshot, regulatory flags — null until rated) and every meter value recorded.',
    pathParams: { id: 'Session id (UUID).' },
    responses: { 200: { description: 'The session.', schema: ref('SessionDetail') } },
    errors: [404],
  },
  {
    method: 'GET',
    path: '/v1/sessions/:id/signed-data',
    tag: 'Sessions',
    summary: 'Get a session’s signed meter data',
    description:
      'The signed readings (OCMF) the charger sent for the session, each with what was read from it and whether its signature held; and the outcome for the session: ' +
      '`verified` (signed start and end readings, checked against the connector’s registered meter key, match the bill), `unverified_key` (they match, but no key or only the ' +
      'charger’s own key could check them), `mismatch`, `invalid`, `incomplete` or `missing`. null status: not assessed (the site’s policy is off, or the charger does not sign).',
    pathParams: { id: 'Session id (UUID).' },
    responses: { 200: { description: 'Signed data.', schema: ref('SignedMeterData') } },
    errors: [404],
  },
  {
    method: 'GET',
    path: '/v1/sessions/:id/signed-data.xml',
    tag: 'Sessions',
    summary: 'Download signed meter data for the Transparency Software',
    description: 'The session’s signed values with the meter’s public key, as an XML file to open in the S.A.F.E. Transparency Software (404 when there are none).',
    pathParams: { id: 'Session id (UUID).' },
    responses: { 200: { description: 'The file.', schema: S, contentType: 'application/xml' } },
    errors: [404],
  },
  {
    method: 'POST',
    path: '/v1/charge-points/:identity/signed-metering',
    tag: 'Chargers',
    summary: 'Switch signed meter readings on or off',
    description:
      'Asks an OCPP 2.0.1 / 2.1 station to sign its readings (SetVariables SampledDataCtrlr.SignReadings and AlignedDataCtrlr.SignReadings) and to send its meter key once per ' +
      'transaction (OCPPCommCtrlr.PublicKeyWithSignedMeterValue). 409 for OCPP 1.6, which has no standard setting: use the vendor’s configuration.',
    pathParams: { identity: 'OCPP identity of the charge point.' },
    body: { schema: { type: 'object', properties: { enabled: { type: 'boolean', default: true } } }, required: false },
    responses: { 200: { description: 'What the station answered.', schema: obj({ enabled: B, accepted: B, results: arrayOf(obj({ component: S, variable: S, status: S })) }, ['enabled', 'accepted', 'results']) } },
    errors: [404, 409, 502],
  },
  {
    method: 'POST',
    path: '/v1/sessions/:id/rerate',
    tag: 'Sessions',
    summary: 'Clear review and bill a session',
    description:
      'Clears a session’s review flag and rates it, issuing the CDR. When the tariff still cannot price it the answer is `ok: false` with the reason; ' +
      '`force: true` bills it as rated anyway. Audited as session.review_cleared, or session.rated_under_override when forced.',
    pathParams: { id: 'Session id (UUID).' },
    body: {
      schema: { type: 'object', properties: { force: { type: 'boolean', default: false, description: 'Bill despite a rating violation.' } } },
      example: { force: false },
    },
    responses: { 200: { description: 'The outcome.', schema: ref('SessionRerateResult') } },
    errors: [404],
  },
  {
    method: 'POST',
    path: '/v1/sessions/reconcile',
    tag: 'Sessions',
    summary: 'Reconcile stuck sessions',
    description:
      'Closes the organisation’s sessions still active past the maximum session length (flagged STUCK_SESSION for review) and rates ended sessions ' +
      'that never produced a CDR.',
    responses: {
      200: {
        description: 'Counts.',
        schema: obj({ stuck: { ...I, description: 'Sessions closed for review.' }, rerated: { ...I, description: 'Unrated sessions retried.' } }, ['stuck', 'rerated']),
      },
    },
  },

  // ---------------------------------------------------------------- tariffs
  {
    method: 'GET',
    path: '/v1/tariffs',
    tag: 'Tariffs',
    summary: 'List tariffs',
    description: 'All of the organisation’s tariffs (active first), with their price components, validation flags and where each is assigned.',
    responses: { 200: { description: 'Tariffs.', schema: arrayOf(ref('Tariff')) } },
  },
  {
    method: 'POST',
    path: '/v1/tariffs',
    tag: 'Tariffs',
    summary: 'Create a tariff',
    description:
      'Creates a tariff after checking it against the regulatory ceilings for connectors of `appliesToMaxPowerW`. A tariff with a violation is not saved (422, with flags). ' +
      'Surcharging the QRIS MDR to the driver is prohibited, so any `mdrMode` other than `absorb` is refused (422). Audited as tariff.created.',
    body: {
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string', default: 'Untitled' },
          plnScheme: { type: 'string', enum: ['curah', 'layanan_khusus', 'none'] },
          plnBaseRate: { ...N, description: 'PLN base rate (IDR/kWh) the multiplier applies to.' },
          plnMultiplier: N,
          activeFrom: { ...DT, description: 'Default now.' },
          activeTo: DT,
          components: arrayOf(ref('TariffComponentInput')),
          appliesToMaxPowerW: { type: 'integer', default: 60000, description: 'Nameplate power the ceiling check uses.' },
          description: { type: 'string', maxLength: 1000 },
          pricingModel: { type: 'string', enum: ['flat', 'tou', 'tiered'], default: 'flat' },
          ppnApplies: { type: 'boolean', default: true },
          mdrMode: { type: 'string', enum: ['absorb'] },
        },
      },
      example: {
        name: 'DC Fast Jakarta 2026',
        plnScheme: 'layanan_khusus',
        plnMultiplier: 1.5,
        appliesToMaxPowerW: 60000,
        pricingModel: 'tou',
        components: [
          { kind: 'energy', rate: 2466.78, touBlock: 'LWBP' },
          { kind: 'energy', rate: 2466.78, touBlock: 'WBP' },
          { kind: 'session', rate: 20000, touBlock: 'ANY' },
          { kind: 'idle', rate: 1000, touBlock: 'ANY', fromMinutes: 15 },
        ],
      },
    },
    responses: {
      200: {
        description: 'Created.',
        schema: obj({ ok: { type: 'boolean', const: true }, tariffId: UUID, flags: arrayOf(ref('TariffFlag')) }, ['ok', 'tariffId', 'flags']),
      },
    },
    errors: [422],
  },
  {
    method: 'POST',
    path: '/v1/tariffs/:id/assign',
    tag: 'Tariffs',
    summary: 'Assign a tariff',
    description:
      'Attaches a tariff to the whole organisation, a site or a single connector, optionally only for AC or DC connectors. The tariff is re-validated against ' +
      'the connectors it will actually price and refused with 409 when illegal for them. Re-assigning to the same scope replaces the earlier assignment. Audited.',
    pathParams: { id: 'Tariff id (UUID).' },
    body: {
      schema: {
        type: 'object',
        properties: {
          scopeType: { type: 'string', enum: ['org', 'site', 'connector'] },
          scopeId: { ...UUID, description: 'Site or connector id; ignored for org.' },
          priority: { type: 'integer', default: 0 },
          currentType: { type: 'string', enum: ['AC', 'DC'], description: 'Limit to AC or DC connectors.' },
        },
        required: ['scopeType'],
      },
      example: { scopeType: 'site', scopeId: '6f1c2a8e-4b7d-4e0a-9c3f-2d5e8b1a7c40', priority: 10, currentType: 'DC' },
    },
    responses: {
      200: {
        description: 'Assigned; flags are non-blocking observations.',
        schema: obj({ ok: { type: 'boolean', const: true }, flags: arrayOf(ref('TariffFlag')) }, ['ok', 'flags']),
      },
    },
    errors: [400, 404, 409],
  },
  {
    method: 'POST',
    path: '/v1/tariffs/preview',
    tag: 'Tariffs',
    summary: 'Preview a tariff',
    description: 'Rates a hypothetical session under a tariff definition without saving anything: CDR lines, charging class, tax stack and regulatory flags.',
    body: {
      schema: {
        type: 'object',
        properties: {
          tariff: ref('TariffDefinition'),
          startedAt: { ...DT, description: 'Default one hour ago.' },
          endedAt: { ...DT, description: 'Default now.' },
          energyWh: { type: 'integer', default: 20000 },
          connectorMaxPowerW: { type: 'integer', default: 60000 },
          pbjtRateBps: { type: 'integer', default: 500, description: 'PBJT rate in basis points.' },
          idleMinutes: { type: 'integer', default: 0 },
        },
        required: ['tariff'],
      },
      example: {
        tariff: { name: 'DC Fast Jakarta 2026', plnScheme: 'layanan_khusus', plnMultiplier: 1.5, components: [{ kind: 'session', rate: 20000, touBlock: 'ANY' }] },
        startedAt: '2026-09-26T18:30:00+07:00',
        endedAt: '2026-09-26T19:15:00+07:00',
        energyWh: 32000,
        connectorMaxPowerW: 60000,
        pbjtRateBps: 1000,
      },
    },
    responses: { 200: { description: 'The rating.', schema: ref('TariffRating') } },
  },
  {
    method: 'POST',
    path: '/v1/tariffs/validate',
    tag: 'Tariffs',
    summary: 'Validate a tariff',
    description: 'Checks a tariff definition against the regulatory ceilings for a connector power, without saving it.',
    body: {
      schema: {
        type: 'object',
        properties: {
          tariff: ref('TariffDefinition'),
          connectorMaxPowerW: { type: 'integer', default: 60000 },
        },
        required: ['tariff'],
      },
      example: { tariff: { plnScheme: 'layanan_khusus', plnMultiplier: 1.5, components: [{ kind: 'session', rate: 30000, touBlock: 'ANY' }] }, connectorMaxPowerW: 30000 },
    },
    responses: { 200: { description: 'Findings; a `violation` means the tariff would be refused.', schema: obj({ flags: arrayOf(ref('TariffFlag')) }, ['flags']) } },
  },

  // ---------------------------------------------------------------- payments
  {
    method: 'POST',
    path: '/v1/checkout/qris',
    tag: 'Payments and refunds',
    summary: 'Create a QRIS pre-purchase',
    description:
      'Creates a QRIS payment for a fixed amount of charging on one connector and quotes the energy it buys against the most expensive block the session could reach. ' +
      'The payment can only be claimed by `startToken` (the driver’s own token, or one minted here for a walk-up). Refused with 409 when the connector’s meter ' +
      'verification has lapsed or is pending, and 422 when the amount does not cover the fixed fees. Maximum Rp 10,000,000.',
    body: {
      schema: {
        type: 'object',
        properties: {
          amountIdr: { type: 'number', exclusiveMinimum: 0, maximum: 10000000 },
          ocppIdentity: { ...S, description: 'The charge point.' },
          connectorId: { type: 'integer', default: 1 },
          idToken: { type: 'string', pattern: '^[\\x20-\\x7e]{1,20}$', description: 'A token this organisation issued to the driver; omit for a walk-up.' },
        },
        required: ['amountIdr', 'ocppIdentity'],
      },
      example: { amountIdr: 100000, ocppIdentity: 'AUTEL-DC60-SMB-002', connectorId: 1 },
    },
    responses: { 200: { description: 'The QR to show and the claim token.', schema: ref('CheckoutQrisResult') } },
    errors: [400, 404, 409, 422],
  },
  {
    method: 'POST',
    path: '/v1/checkout/qris/:providerRef/simulate-payment',
    tag: 'Payments and refunds',
    summary: 'Simulate a QRIS payment',
    description: 'Development only (403 elsewhere): marks a sandbox QRIS charge paid and its payment intent captured.',
    pathParams: { providerRef: 'The `qr.providerRef` returned by checkout.' },
    responses: {
      200: { description: 'The paid charge.', schema: obj({ ok: { type: 'boolean', const: true }, charge: ref('CheckoutQrisCharge') }, ['ok', 'charge']) },
    },
    errors: [404],
  },

  // ---------------------------------------------------------------- load management
  {
    method: 'GET',
    path: '/v1/sites/:siteId/power',
    tag: 'Load management',
    summary: 'Get site power and allocation',
    description:
      'The site’s kVA headroom against its PLN subscription, its power budget, and the allocation the load manager would make now across the site’s connectors.',
    pathParams: { siteId: 'Site id (UUID).' },
    responses: {
      200: {
        description: 'Headroom, budget and plan.',
        schema: obj(
          {
            headroom: ref('PowerHeadroom'),
            budget: ref('PowerSiteBudget'),
            plan: arrayOf(ref('PowerAllocation')),
            subscriptionCeilingW: { ...nN, description: 'Connected kVA × PF; null when the subscribed capacity is unknown.' },
            usableW: { ...N, description: 'Ceiling minus reserve; 0 while curtailed.' },
          },
          ['headroom', 'budget', 'plan', 'subscriptionCeilingW', 'usableW'],
        ),
      },
    },
    errors: [404],
  },
  {
    method: 'POST',
    path: '/v1/sites/:siteId/power/apply',
    tag: 'Load management',
    summary: 'Apply the load plan now',
    description: 'Runs one load-management pass immediately, sending station ceilings and per-transaction charging profiles to the site’s online chargers.',
    pathParams: { siteId: 'Site id (UUID).' },
    responses: { 200: { description: 'The allocations applied.', schema: obj({ applied: arrayOf(ref('PowerAllocation')) }, ['applied']) } },
    errors: [404],
  },
  {
    method: 'POST',
    path: '/v1/sites/:siteId/power/provision-defaults',
    tag: 'Load management',
    summary: 'Provision default charging profiles',
    description: 'Installs a conservative TxDefaultProfile on every online connector at the site — the limit a charger falls back to when the load manager cannot reach it.',
    pathParams: { siteId: 'Site id (UUID).' },
    responses: { 200: { description: 'Connectors that received a profile.', schema: obj({ applied: I }, ['applied']) } },
    errors: [404],
  },
  {
    method: 'GET',
    path: '/v1/charge-points/:identity/profiles/reconcile',
    tag: 'Load management',
    summary: 'Check charging-profile drift',
    description:
      'Asks an online charger (GetCompositeSchedule) what limits it is enforcing and compares them with the accepted profiles on record. ' +
      'Returns zeros when the charger is offline or its model’s composite schedule is not trusted.',
    pathParams: identityParam,
    responses: {
      200: {
        description: 'Profiles checked and how many drifted.',
        schema: obj({ checked: I, drift: I }, ['checked', 'drift']),
      },
    },
    errors: [404],
  },
  {
    method: 'PUT',
    path: '/v1/sites/:siteId/power/budget',
    tag: 'Load management',
    summary: 'Set the site power budget',
    description:
      'Sets the site’s power ceiling, auxiliary reserve, allocation strategy and curtailment (e.g. running on genset). Omitted fields keep their value. ' +
      'A ceiling above the PLN subscription (connected kVA × PF), or a reserve not below the ceiling, is refused with 422. A change in curtailment, or ' +
      '`applyNow`, runs the load manager right after the response. Audited as site.power_budget.changed.',
    pathParams: { siteId: 'Site id (UUID).' },
    body: {
      schema: {
        type: 'object',
        properties: {
          ceilingW: { type: 'integer', minimum: 0 },
          reserveW: { type: 'integer', minimum: 0, description: 'Ignored when reserveBreakdown is given.' },
          reserveBreakdown: {
            type: 'object',
            description: 'Watts held back per auxiliary load; the reserve becomes their sum.',
            properties: {
              lighting: { type: 'number', minimum: 0 },
              pos: { type: 'number', minimum: 0 },
              cctv: { type: 'number', minimum: 0 },
              hvac: { type: 'number', minimum: 0 },
              other: { type: 'number', minimum: 0 },
            },
          },
          strategy: { type: 'string', enum: ['fair_share', 'priority', 'fifo'] },
          curtailed: B,
          curtailedReason: S,
          applyNow: { type: 'boolean', default: false },
        },
      },
      example: { ceilingW: 150000, reserveBreakdown: { lighting: 4000, pos: 500, cctv: 300, hvac: 6000 }, strategy: 'priority', curtailed: false },
    },
    responses: { 200: { description: 'The budget now in force.', schema: ref('PowerSiteBudget') } },
    errors: [400, 404, 422],
  },

  // ---------------------------------------------------------------- compliance
  {
    method: 'GET',
    path: '/v1/compliance',
    tag: 'Compliance',
    summary: 'Get the compliance report',
    description:
      'Per site: SPKLU identity (parsed and checked against the site’s municipality), SLO validity and days remaining, and the metrology (tera) state of every connector’s meter. ' +
      'Site-scoped callers see only their sites.',
    responses: { 200: { description: 'Sites, by name.', schema: arrayOf(ref('ComplianceSite')) } },
  },

  // ---------------------------------------------------------------- audit
  {
    method: 'GET',
    path: '/v1/audit',
    tag: 'Audit',
    summary: 'Get the audit log',
    description: 'The organisation’s 200 most recent audit entries, newest first, and a verification of the whole hash chain (detects edits, deletions and truncation).',
    responses: {
      200: {
        description: 'Entries and chain verification.',
        schema: obj({ entries: arrayOf(ref('AuditEntry')), chain: ref('AuditChain') }, ['entries', 'chain']),
      },
    },
  },

  // ---------------------------------------------------------------- api keys
  {
    method: 'GET',
    path: '/v1/api-keys',
    tag: 'API keys',
    summary: 'List API keys',
    description: 'The organisation’s API keys, newest first, including revoked ones. Secrets are never returned.',
    responses: { 200: { description: 'Keys.', schema: arrayOf(ref('ApiKey')) } },
  },
  {
    method: 'POST',
    path: '/v1/api-keys',
    tag: 'API keys',
    summary: 'Issue an API key',
    description:
      'Issues a key with the given permissions, scoped to the organisation, a site or a fleet. A key may not carry a permission the caller does not hold (403). ' +
      'The secret is shown once. Audited as api_key.issued.',
    body: {
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string', default: 'unnamed' },
          permissions: { ...arrayOf(S), description: 'Permission strings such as `charge_point:read`.' },
          scopeType: { type: 'string', enum: ['org', 'site', 'fleet'], default: 'org' },
          scopeId: { ...UUID, description: 'Required for site and fleet scope; ignored for org.' },
          rateLimitPerMin: { ...nullable('integer'), minimum: 1, maximum: 100000, description: 'The key’s own limit, requests a minute. Omit or null for the installation default.' },
        },
      },
      example: { name: 'Fleet dashboard — Jakarta', permissions: ['charge_point:read', 'session:read'], scopeType: 'org' },
    },
    responses: { 200: { description: 'The new key.', schema: ref('ApiKeyIssued') } },
    errors: [400, 404],
  },
  {
    method: 'DELETE',
    path: '/v1/api-keys/:id',
    tag: 'API keys',
    summary: 'Revoke an API key',
    description: 'Revokes a key immediately. The row stays in the list with `revoked_at` set.',
    pathParams: { id: 'API key id (UUID).' },
    responses: { 200: { description: 'Revoked.', schema: OK } },
    errors: [404],
  },
  {
    method: 'PATCH',
    path: '/v1/api-keys/:id',
    tag: 'API keys',
    summary: 'Change an API key’s name or rate limit',
    description:
      'Sets the key’s own rate limit (requests a minute; null returns it to the installation default) or renames it. ' +
      'A new limit applies from the key’s next request. Revoked keys cannot be changed (404). Audited as api_key.updated.',
    pathParams: { id: 'API key id (UUID).' },
    body: {
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 120 },
          rateLimitPerMin: { ...nullable('integer'), minimum: 1, maximum: 100000 },
        },
      },
      example: { rateLimitPerMin: 120 },
    },
    responses: { 200: { description: 'The key.', schema: ref('ApiKey') } },
    errors: [400, 404],
  },
  {
    method: 'GET',
    path: '/v1/api-keys/:id/usage',
    tag: 'API keys',
    summary: 'Get an API key’s usage by hour',
    description: 'Requests made with the key per hour, oldest first, with how many were refused for the rate limit or answered with another error. Hours without requests are left out.',
    pathParams: { id: 'API key id (UUID).' },
    query: [{ name: 'hours', description: 'How far back, in hours (1 to 744; default 48).', schema: { type: 'integer', minimum: 1, maximum: 744, default: 48 } }],
    responses: { 200: { description: 'Usage.', schema: arrayOf(ref('ApiKeyUsageHour')) } },
    errors: [404],
  },

  // ---------------------------------------------------------------- alerts
  {
    method: 'GET',
    path: '/v1/alerts',
    tag: 'Alerts',
    summary: 'List alerts',
    description: 'The 100 most recently raised alerts. Site-scoped callers see only alerts recorded against their sites.',
    responses: { 200: { description: 'Alerts, newest first.', schema: arrayOf(ref('Alert')) } },
  },

  // ---------------------------------------------------------------- stream
  {
    method: 'GET',
    path: '/v1/stream',
    tag: 'Live events',
    summary: 'Stream live events',
    description:
      'Server-sent events for the caller’s organisation: each message is `data: {"kind": …, "payload": …}` (connector status, session energy, alerts, …). ' +
      'A comment ping is sent every 25 seconds. Events that cannot be attributed to the organisation are not delivered.',
    responses: { 200: { description: 'An open event stream.', contentType: 'text/event-stream', schema: S } },
  },
];
