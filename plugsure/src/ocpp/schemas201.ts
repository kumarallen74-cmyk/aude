import type { SchemaObject } from 'ajv';

/**
 * OCPP 2.0.1 JSON Schemas — CORE SESSION SUBSET.
 *
 * Transcribed from the OCPP 2.0.1 specification (Part 2 — Appendices, JSON
 * schemas) for the messages a charger sends during boot, authorisation and a
 * billable charging transaction. This is the subset the PlugSure gateway needs
 * to bring a 2.0.1 unit online and run a session end to end:
 *
 *   BootNotification · Heartbeat · StatusNotification · Authorize ·
 *   TransactionEvent · DataTransfer · SecurityEventNotification ·
 *   FirmwareStatusNotification · LogStatusNotification · ReservationStatusUpdate ·
 *   NotifyEvent · NotifyReport · MeterValues
 *
 * Also: the ISO 15118 certificate messages (Plug & Charge) and the smart-charging
 * messages a station sends (NotifyEVChargingNeeds / -Schedule, NotifyChargingLimit,
 * ClearedChargingLimit, ReportChargingProfiles). New families are additive: add the
 * schema here, add a case in adapter201.ts, done. OCPP 2.1 uses this set with its
 * wider enums (schemas21.ts).
 *
 * Same two deliberate divergences from the published bundle as schemas16.ts:
 *   1. REQUEST schemas do NOT set `additionalProperties: false` — real hardware
 *      ships vendor extensions and coarser/richer fields; we enforce types,
 *      enums, lengths and required fields (the things that corrupt the DB) and
 *      ignore the rest so a cosmetic field never strands a charger.
 *   2. RESPONSE schemas DO set `additionalProperties: false` — those payloads are
 *      ours, and strictness catches our own typos before they hit the wire.
 */

// --------------------------------------------------------------- primitives

/** OCPP 2.0.1 identifierString / string<n>: bounded string. */
const str = (maxLength: number): SchemaObject => ({ type: 'string', maxLength });
/** ISO 8601 / RFC 3339 instant. Format is checked in validate.ts. */
const dateTime: SchemaObject = { type: 'string', format: 'date-time' };
const integer: SchemaObject = { type: 'integer' };
const nonNegInt: SchemaObject = { type: 'integer', minimum: 0 };
/** enum with an explicit type so Ajv strict mode stays happy. */
const strEnum = (values: readonly string[]): SchemaObject => ({ type: 'string', enum: [...values] });

// --------------------------------------------------------------- enums (2.0.1)

export const BOOT_REASON = [
  'ApplicationReset', 'FirmwareUpdate', 'LocalReset', 'PowerUp', 'RemoteReset',
  'ScheduledReset', 'Triggered', 'Unknown', 'Watchdog',
] as const;

/** ConnectorStatusEnumType — note this is COARSER than 1.6's status set. */
export const CONNECTOR_STATUS_201 = ['Available', 'Occupied', 'Reserved', 'Unavailable', 'Faulted'] as const;

/** IdTokenEnumType. */
export const ID_TOKEN_TYPE = [
  'Central', 'eMAID', 'ISO14443', 'ISO15693', 'KeyCode', 'Local', 'MacAddress', 'NoAuthorization',
] as const;

/** AuthorizationStatusEnumType (superset of 1.6's). */
export const AUTHORIZATION_STATUS_201 = [
  'Accepted', 'Blocked', 'ConcurrentTx', 'Expired', 'Invalid', 'NoCredit',
  'NotAllowedTypeEVSE', 'NotAtThisLocation', 'NotAtThisTime', 'Unknown',
] as const;

export const TRANSACTION_EVENT = ['Started', 'Updated', 'Ended'] as const;

export const TRIGGER_REASON_201 = [
  'Authorized', 'CablePluggedIn', 'ChargingRateChanged', 'ChargingStateChanged',
  'Deauthorized', 'EnergyLimitReached', 'EVCommunicationLost', 'EVConnectTimeout',
  'MeterValueClock', 'MeterValuePeriodic', 'TimeLimitReached', 'Trigger',
  'UnlockCommand', 'StopAuthorized', 'EVDeparted', 'EVDetected', 'RemoteStop',
  'RemoteStart', 'AbnormalCondition', 'SignedDataReceived', 'ResetCommand',
] as const;

export const CHARGING_STATE = ['Charging', 'EVConnected', 'SuspendedEV', 'SuspendedEVSE', 'Idle'] as const;

export const REASON_STOPPED = [
  'DeAuthorized', 'EmergencyStop', 'EnergyLimitReached', 'EVDisconnected', 'GroundFault',
  'ImmediateReset', 'Local', 'LocalOutOfCredit', 'MasterPass', 'Other', 'OvercurrentFault',
  'PowerLoss', 'PowerQuality', 'Reboot', 'Remote', 'SOCLimitReached', 'StoppedByEV',
  'TimeLimitReached', 'Timeout',
] as const;

export const READING_CONTEXT_201 = [
  'Interruption.Begin', 'Interruption.End', 'Other', 'Sample.Clock', 'Sample.Periodic',
  'Transaction.Begin', 'Transaction.End', 'Trigger',
] as const;

export const MEASURAND_201 = [
  'Current.Export', 'Current.Import', 'Current.Offered', 'Energy.Active.Export.Register',
  'Energy.Active.Import.Register', 'Energy.Reactive.Export.Register', 'Energy.Reactive.Import.Register',
  'Energy.Active.Export.Interval', 'Energy.Active.Import.Interval', 'Energy.Active.Net',
  'Energy.Reactive.Export.Interval', 'Energy.Reactive.Import.Interval', 'Energy.Reactive.Net',
  'Energy.Apparent.Net', 'Energy.Apparent.Import', 'Energy.Apparent.Export', 'Frequency',
  'Power.Active.Export', 'Power.Active.Import', 'Power.Factor', 'Power.Offered',
  'Power.Reactive.Export', 'Power.Reactive.Import', 'SoC', 'Voltage',
] as const;

export const PHASE_201 = ['L1', 'L2', 'L3', 'N', 'L1-N', 'L2-N', 'L3-N', 'L1-L2', 'L2-L3', 'L3-L1'] as const;
export const LOCATION_201 = ['Body', 'Cable', 'EV', 'Inlet', 'Outlet'] as const;

export const FIRMWARE_STATUS_201 = [
  'Downloaded', 'DownloadFailed', 'Downloading', 'DownloadScheduled', 'DownloadPaused',
  'Idle', 'InstallationFailed', 'Installing', 'Installed', 'InstallRebooting',
  'InstallScheduled', 'InstallVerificationFailed', 'InvalidSignature', 'SignatureVerified',
] as const;

export const DATA_TRANSFER_STATUS_201 = ['Accepted', 'Rejected', 'UnknownMessageId', 'UnknownVendorId'] as const;
export const BOOT_STATUS_201 = ['Accepted', 'Pending', 'Rejected'] as const;

// --------------------------------------------------------------- shared shapes

const idToken201: SchemaObject = {
  type: 'object',
  properties: { idToken: str(36), type: strEnum(ID_TOKEN_TYPE) },
  required: ['idToken', 'type'],
};

const evse201: SchemaObject = {
  type: 'object',
  properties: { id: nonNegInt, connectorId: nonNegInt },
  required: ['id'],
};

/**
 * SampledValueType (2.0.1). The unit moved INTO `unitOfMeasure.unit`, and `value`
 * is a JSON number (1.6 typed it as string). The adapter maps this back to the
 * flat canonical SampledValue.
 */
const sampledValue201: SchemaObject = {
  type: 'object',
  properties: {
    value: { type: 'number' },
    context: strEnum(READING_CONTEXT_201),
    measurand: strEnum(MEASURAND_201),
    phase: strEnum(PHASE_201),
    location: strEnum(LOCATION_201),
    unitOfMeasure: {
      type: 'object',
      properties: { unit: str(20), multiplier: integer },
    },
  },
  required: ['value'],
};

const meterValue201: SchemaObject = {
  type: 'object',
  properties: {
    timestamp: dateTime,
    sampledValue: { type: 'array', items: sampledValue201, minItems: 1 },
  },
  required: ['timestamp', 'sampledValue'],
};

const transactionInfo: SchemaObject = {
  type: 'object',
  properties: {
    transactionId: str(36),
    chargingState: strEnum(CHARGING_STATE),
    timeSpentCharging: integer,
    stoppedReason: strEnum(REASON_STOPPED),
    remoteStartId: integer,
  },
  required: ['transactionId'],
};

// --------------------------------------------------------------- requests

const BootNotificationReq: SchemaObject = {
  type: 'object',
  properties: {
    reason: strEnum(BOOT_REASON),
    chargingStation: {
      type: 'object',
      properties: {
        model: str(20),
        vendorName: str(50),
        serialNumber: str(25),
        firmwareVersion: str(50),
        modem: {
          type: 'object',
          properties: { iccid: str(20), imsi: str(20) },
        },
      },
      required: ['model', 'vendorName'],
    },
  },
  required: ['reason', 'chargingStation'],
};

const HeartbeatReq: SchemaObject = { type: 'object', properties: {} };

const StatusNotificationReq: SchemaObject = {
  type: 'object',
  properties: {
    timestamp: dateTime,
    connectorStatus: strEnum(CONNECTOR_STATUS_201),
    evseId: nonNegInt,
    connectorId: nonNegInt,
  },
  required: ['timestamp', 'connectorStatus', 'evseId', 'connectorId'],
};

/** OCSPRequestDataType: a certificate's hash data plus where to ask about it. */
const ocspRequestData: SchemaObject = {
  type: 'object',
  properties: {
    hashAlgorithm: strEnum(['SHA256', 'SHA384', 'SHA512']),
    issuerNameHash: str(128),
    issuerKeyHash: str(128),
    serialNumber: str(40),
    responderURL: str(512),
  },
  required: ['hashAlgorithm', 'issuerNameHash', 'issuerKeyHash', 'serialNumber', 'responderURL'],
};

const AuthorizeReq: SchemaObject = {
  type: 'object',
  properties: {
    idToken: idToken201,
    // ISO 15118 Plug & Charge: the contract certificate chain (when the charger
    // could not validate it), or the hash data of the chain it validated.
    certificate: str(5500),
    iso15118CertificateHashData: { type: 'array', items: ocspRequestData, minItems: 1, maxItems: 4 },
  },
  required: ['idToken'],
};

/** Plug & Charge: install or update a contract certificate in the car (EXI, base64). */
const Get15118EVCertificateReq: SchemaObject = {
  type: 'object',
  properties: {
    iso15118SchemaVersion: str(50),
    action: strEnum(['Install', 'Update']),
    exiRequest: str(5600),
  },
  required: ['iso15118SchemaVersion', 'action', 'exiRequest'],
};

/** Plug & Charge: the charger asks the CSMS for an OCSP answer to hand to the car. */
const GetCertificateStatusReq: SchemaObject = {
  type: 'object',
  properties: { ocspRequestData },
  required: ['ocspRequestData'],
};

/** A certificate signing request: the V2G (SECC) certificate, or the station's own. */
const SignCertificateReq: SchemaObject = {
  type: 'object',
  properties: {
    csr: str(5500),
    certificateType: strEnum(['ChargingStationCertificate', 'V2GCertificate']),
  },
  required: ['csr'],
};

const TransactionEventReq: SchemaObject = {
  type: 'object',
  properties: {
    eventType: strEnum(TRANSACTION_EVENT),
    timestamp: dateTime,
    triggerReason: strEnum(TRIGGER_REASON_201),
    seqNo: nonNegInt,
    offline: { type: 'boolean' },
    numberOfPhasesUsed: nonNegInt,
    cableMaxCurrent: integer,
    reservationId: integer,
    transactionInfo,
    evse: evse201,
    idToken: idToken201,
    meterValue: { type: 'array', items: meterValue201 },
  },
  required: ['eventType', 'timestamp', 'triggerReason', 'seqNo', 'transactionInfo'],
};

const DataTransferReq: SchemaObject = {
  type: 'object',
  properties: {
    messageId: str(50),
    // `data` is free-form in OCPP; accept anything (empty schema matches all).
    data: {},
    vendorId: str(255),
  },
  required: ['vendorId'],
};

const SecurityEventNotificationReq: SchemaObject = {
  type: 'object',
  properties: {
    type: str(50),
    timestamp: dateTime,
    techInfo: str(255),
  },
  required: ['type', 'timestamp'],
};

const FirmwareStatusNotificationReq: SchemaObject = {
  type: 'object',
  properties: {
    status: strEnum(FIRMWARE_STATUS_201),
    requestId: integer,
  },
  required: ['status'],
};

/** Answer to GetLog (the 2.0.1 form of GetDiagnostics), reported as the upload progresses. */
const LogStatusNotificationReq: SchemaObject = {
  type: 'object',
  properties: {
    status: strEnum([
      'BadMessage', 'Idle', 'NotSupportedOperation', 'PermissionDenied',
      'Uploaded', 'UploadFailure', 'Uploading', 'AcceptedCanceled',
    ]),
    requestId: integer,
  },
  required: ['status'],
};

/** A reservation made with ReserveNow ended without being used. */
const ReservationStatusUpdateReq: SchemaObject = {
  type: 'object',
  properties: {
    reservationId: integer,
    reservationUpdateStatus: strEnum(['Expired', 'Removed']),
  },
  required: ['reservationId', 'reservationUpdateStatus'],
};

/**
 * Device-model monitoring events. Every production 2.0.1 station sends these
 * (often right after boot); refusing them made compliant firmware log errors or
 * retry. The component/variable detail is vendor-specific, so it is accepted
 * loosely and only the fields we act on are typed.
 */
const NotifyEventReq: SchemaObject = {
  type: 'object',
  properties: {
    generatedAt: dateTime,
    seqNo: nonNegInt,
    tbc: { type: 'boolean' },
    eventData: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          eventId: integer,
          timestamp: dateTime,
          trigger: strEnum(['Alerting', 'Delta', 'Periodic']),
          actualValue: str(2500),
          techCode: str(50),
          techInfo: str(500),
          cleared: { type: 'boolean' },
          eventNotificationType: strEnum(['HardWiredNotification', 'HardWiredMonitor', 'PreconfiguredMonitor', 'CustomMonitor']),
          component: { type: 'object', properties: { name: str(50) }, required: ['name'] },
          variable: { type: 'object', properties: { name: str(50) }, required: ['name'] },
        },
        required: ['eventId', 'timestamp', 'trigger', 'actualValue', 'eventNotificationType', 'component', 'variable'],
      },
    },
  },
  required: ['generatedAt', 'seqNo', 'eventData'],
};

/** Answer to GetBaseReport / GetReport, possibly in several parts. */
const NotifyReportReq: SchemaObject = {
  type: 'object',
  properties: {
    requestId: integer,
    generatedAt: dateTime,
    seqNo: nonNegInt,
    tbc: { type: 'boolean' },
    reportData: { type: 'array' },
  },
  required: ['requestId', 'generatedAt', 'seqNo'],
};

/** Answer to GetMonitoringReport, possibly in several parts. */
const NotifyMonitoringReportReq: SchemaObject = {
  type: 'object',
  properties: {
    requestId: integer,
    generatedAt: dateTime,
    seqNo: nonNegInt,
    tbc: { type: 'boolean' },
    monitor: { type: 'array' },
  },
  required: ['requestId', 'generatedAt', 'seqNo'],
};

/** Meter readings OUTSIDE a transaction (e.g. the station's main meter). */const MeterValuesReq: SchemaObject = {
  type: 'object',
  properties: {
    evseId: nonNegInt,
    meterValue: { type: 'array', minItems: 1, items: meterValue201 },
  },
  required: ['evseId', 'meterValue'],
};

// --------------------------------------------------------------- smart charging (ISO 15118)

/**
 * EnergyTransferModeEnumType. 2.0.1 defines the first three; OCPP 2.1 adds the
 * ISO 15118-20 modes, including bidirectional power transfer (*_BPT) and DER
 * control. One list serves both: a 2.0.1 station never sends the newer values.
 */
export const ENERGY_TRANSFER = [
  'AC_single_phase', 'AC_three_phase', 'DC',
  'AC_BPT', 'AC_BPT_DER', 'AC_DER', 'DC_BPT', 'DC_ACDP', 'DC_ACDP_BPT', 'WPT',
] as const;

/** The car's needs, after it and the charger have negotiated (ISO 15118-2 / -20). */
const NotifyEVChargingNeedsReq: SchemaObject = {
  type: 'object',
  properties: {
    evseId: nonNegInt,
    maxScheduleTuples: integer,
    timestamp: dateTime,
    chargingNeeds: {
      type: 'object',
      properties: {
        requestedEnergyTransfer: strEnum(ENERGY_TRANSFER),
        availableEnergyTransfer: { type: 'array', items: strEnum(ENERGY_TRANSFER) },
        controlMode: strEnum(['ScheduledControl', 'DynamicControl']),
        mobilityNeedsMode: strEnum(['EVCC', 'EVCC_SECC']),
        departureTime: dateTime,
        acChargingParameters: { type: 'object' },
        dcChargingParameters: { type: 'object' },
        v2xChargingParameters: { type: 'object' },
      },
      required: ['requestedEnergyTransfer'],
    },
  },
  required: ['evseId', 'chargingNeeds'],
};

/** The schedule the car chose or proposed (ISO 15118). */
const NotifyEVChargingScheduleReq: SchemaObject = {
  type: 'object',
  properties: {
    timeBase: dateTime,
    evseId: nonNegInt,
    chargingSchedule: { type: 'object' },
    selectedChargingScheduleId: integer,
    powerToleranceAcceptance: { type: 'boolean' },
  },
  required: ['timeBase', 'evseId', 'chargingSchedule'],
};

/** A limit set on the station by something other than the CSMS (an EMS, the grid operator). */
const NotifyChargingLimitReq: SchemaObject = {
  type: 'object',
  properties: {
    evseId: nonNegInt,
    chargingLimit: {
      type: 'object',
      properties: { chargingLimitSource: str(20), isGridCritical: { type: 'boolean' }, isLocalGeneration: { type: 'boolean' } },
      required: ['chargingLimitSource'],
    },
    chargingSchedule: { type: 'array' },
  },
  required: ['chargingLimit'],
};

const ClearedChargingLimitReq: SchemaObject = {
  type: 'object',
  properties: { chargingLimitSource: str(20), evseId: nonNegInt },
  required: ['chargingLimitSource'],
};

/** Answer to GetChargingProfiles, possibly in several parts. */
const ReportChargingProfilesReq: SchemaObject = {
  type: 'object',
  properties: {
    requestId: integer,
    chargingLimitSource: str(20),
    tbc: { type: 'boolean' },
    evseId: nonNegInt,
    chargingProfile: { type: 'array', minItems: 1 },
  },
  required: ['requestId', 'chargingLimitSource', 'evseId', 'chargingProfile'],
};

// --------------------------------------------------------------- responses (ours)

const idTokenInfo201: SchemaObject = {
  type: 'object',
  properties: { status: strEnum(AUTHORIZATION_STATUS_201) },
  required: ['status'],
  additionalProperties: false,
};

const BootNotificationConf: SchemaObject = {
  type: 'object',
  properties: {
    currentTime: dateTime,
    interval: integer,
    status: strEnum(BOOT_STATUS_201),
  },
  required: ['currentTime', 'interval', 'status'],
  additionalProperties: false,
};

const HeartbeatConf: SchemaObject = {
  type: 'object',
  properties: { currentTime: dateTime },
  required: ['currentTime'],
  additionalProperties: false,
};

const EmptyConf: SchemaObject = { type: 'object', properties: {}, additionalProperties: false };

const statusInfo201: SchemaObject = {
  type: 'object',
  properties: { reasonCode: str(20), additionalInfo: str(512) },
  required: ['reasonCode'],
  additionalProperties: false,
};

export const AUTHORIZE_CERTIFICATE_STATUS = [
  'Accepted', 'SignatureError', 'CertificateExpired', 'CertificateRevoked', 'NoCertificateAvailable', 'CertChainError', 'ContractCancelled',
] as const;

const AuthorizeConf: SchemaObject = {
  type: 'object',
  properties: { idTokenInfo: idTokenInfo201, certificateStatus: strEnum(AUTHORIZE_CERTIFICATE_STATUS) },
  required: ['idTokenInfo'],
  additionalProperties: false,
};

const Get15118EVCertificateConf: SchemaObject = {
  type: 'object',
  properties: { status: strEnum(['Accepted', 'Failed']), exiResponse: str(5600), statusInfo: statusInfo201 },
  required: ['status', 'exiResponse'],
  additionalProperties: false,
};

const GetCertificateStatusConf: SchemaObject = {
  type: 'object',
  properties: { status: strEnum(['Accepted', 'Failed']), ocspResult: str(5500), statusInfo: statusInfo201 },
  required: ['status'],
  additionalProperties: false,
};

const SignCertificateConf: SchemaObject = {
  type: 'object',
  properties: { status: strEnum(['Accepted', 'Rejected']), statusInfo: statusInfo201 },
  required: ['status'],
  additionalProperties: false,
};

const TransactionEventConf: SchemaObject = {
  type: 'object',
  properties: {
    totalCost: { type: 'number' },
    chargingPriority: integer,
    idTokenInfo: idTokenInfo201,
  },
  additionalProperties: false,
};

const NotifyEVChargingNeedsConf: SchemaObject = {
  type: 'object',
  properties: { status: strEnum(['Accepted', 'Rejected', 'Processing', 'NoChargingProfile']), statusInfo: statusInfo201 },
  required: ['status'],
  additionalProperties: false,
};

const NotifyEVChargingScheduleConf: SchemaObject = {
  type: 'object',
  properties: { status: strEnum(['Accepted', 'Rejected']), statusInfo: statusInfo201 },
  required: ['status'],
  additionalProperties: false,
};

const DataTransferConf: SchemaObject = {
  type: 'object',
  properties: {
    status: strEnum(DATA_TRANSFER_STATUS_201),
    data: {},
  },
  required: ['status'],
  additionalProperties: false,
};

// --------------------------------------------------------------- registries

/** Inbound (CP -> CS) request schemas, keyed by OCPP action. */
export const REQUEST_SCHEMAS_201: Readonly<Record<string, object>> = Object.freeze({
  BootNotification: BootNotificationReq,
  Heartbeat: HeartbeatReq,
  StatusNotification: StatusNotificationReq,
  Authorize: AuthorizeReq,
  TransactionEvent: TransactionEventReq,
  DataTransfer: DataTransferReq,
  SecurityEventNotification: SecurityEventNotificationReq,
  FirmwareStatusNotification: FirmwareStatusNotificationReq,
  LogStatusNotification: LogStatusNotificationReq,
  ReservationStatusUpdate: ReservationStatusUpdateReq,
  NotifyEvent: NotifyEventReq,
  NotifyReport: NotifyReportReq,
  NotifyMonitoringReport: NotifyMonitoringReportReq,
  MeterValues: MeterValuesReq,
  Get15118EVCertificate: Get15118EVCertificateReq,
  GetCertificateStatus: GetCertificateStatusReq,
  SignCertificate: SignCertificateReq,
  NotifyEVChargingNeeds: NotifyEVChargingNeedsReq,
  NotifyEVChargingSchedule: NotifyEVChargingScheduleReq,
  NotifyChargingLimit: NotifyChargingLimitReq,
  ClearedChargingLimit: ClearedChargingLimitReq,
  ReportChargingProfiles: ReportChargingProfilesReq,
});

/** Outbound (CS -> CP) response schemas we emit, checked before they hit the wire. */
export const RESPONSE_SCHEMAS_201: Readonly<Record<string, object>> = Object.freeze({
  BootNotification: BootNotificationConf,
  Heartbeat: HeartbeatConf,
  StatusNotification: EmptyConf,
  Authorize: AuthorizeConf,
  TransactionEvent: TransactionEventConf,
  DataTransfer: DataTransferConf,
  SecurityEventNotification: EmptyConf,
  FirmwareStatusNotification: EmptyConf,
  LogStatusNotification: EmptyConf,
  ReservationStatusUpdate: EmptyConf,
  NotifyEvent: EmptyConf,
  NotifyReport: EmptyConf,
  NotifyMonitoringReport: EmptyConf,
  MeterValues: EmptyConf,
  Get15118EVCertificate: Get15118EVCertificateConf,
  GetCertificateStatus: GetCertificateStatusConf,
  SignCertificate: SignCertificateConf,
  NotifyEVChargingNeeds: NotifyEVChargingNeedsConf,
  NotifyEVChargingSchedule: NotifyEVChargingScheduleConf,
  NotifyChargingLimit: EmptyConf,
  ClearedChargingLimit: EmptyConf,
  ReportChargingProfiles: EmptyConf,
});
