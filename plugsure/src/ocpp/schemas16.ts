import type { SchemaObject } from 'ajv';

/**
 * OCPP 1.6J JSON Schemas.
 *
 * Transcribed from the OCPP 1.6 specification (Edition 2, §7 "Messages" and §7.4
 * "Datatypes") and cross-checked against the official `schemas/json` bundle
 * published by the Open Charge Alliance.
 *
 * Two deliberate divergences from the published bundle, both documented inline:
 *
 *  1. REQUEST schemas do NOT set `additionalProperties: false`.
 *     Real hardware ships vendor extensions inside standard messages (Autel puts
 *     `chargePointFeature` in BootNotification, several Chinese OEMs add
 *     `connectorType` to StatusNotification). Rejecting those frames would take a
 *     charger permanently offline over a field we do not even read. We therefore
 *     enforce *types, enums, lengths and required fields* — the things that
 *     actually corrupt the database — and ignore anything we do not know about.
 *
 *  2. RESPONSE schemas DO set `additionalProperties: false`.
 *     Those payloads are ours. Strictness there costs nothing at runtime and
 *     catches our own typos (`currentTime` vs `curentTime`) before they reach a
 *     charger that will silently mis-set its clock.
 */

// --------------------------------------------------------------- primitives

/**
 * OCPP CiString<n>: a case-insensitive ASCII string with a maximum length.
 * The spec puts no lower bound on any CiString, so neither do we — an empty
 * string is a semantic problem for the handler, not a schema violation.
 */
const ciString = (maxLength: number): SchemaObject => ({ type: 'string', maxLength });

/** OCPP `dateTime`: an ISO 8601 / RFC 3339 instant. Format checked in validate.ts. */
const dateTime: SchemaObject = { type: 'string', format: 'date-time' };

/** connectorId 0 addresses the charge point itself, so 0 is legal, negatives are not. */
const connectorId: SchemaObject = { type: 'integer', minimum: 0 };

const integer: SchemaObject = { type: 'integer' };

// ----------------------------------------------------------------- enums

export const AUTHORIZATION_STATUS = [
  'Accepted',
  'Blocked',
  'Expired',
  'Invalid',
  'ConcurrentTx',
] as const;

export const CHARGE_POINT_STATUS = [
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEVSE',
  'SuspendedEV',
  'Finishing',
  'Reserved',
  'Unavailable',
  'Faulted',
] as const;

export const CHARGE_POINT_ERROR_CODE = [
  'ConnectorLockFailure',
  'EVCommunicationError',
  'GroundFailure',
  'HighTemperature',
  'InternalError',
  'LocalListConflict',
  'NoError',
  'OtherError',
  'OverCurrentFailure',
  'OverVoltage',
  'PowerMeterFailure',
  'PowerSwitchFailure',
  'ReaderFailure',
  'ResetFailure',
  'UnderVoltage',
  'WeakSignal',
] as const;

export const STOP_REASON = [
  'EmergencyStop',
  'EVDisconnected',
  'HardReset',
  'Local',
  'Other',
  'PowerLoss',
  'Reboot',
  'Remote',
  'SoftReset',
  'UnlockCommand',
  'DeAuthorized',
] as const;

export const READING_CONTEXT = [
  'Interruption.Begin',
  'Interruption.End',
  'Other',
  'Sample.Clock',
  'Sample.Periodic',
  'Transaction.Begin',
  'Transaction.End',
  'Trigger',
] as const;

export const VALUE_FORMAT = ['Raw', 'SignedData'] as const;

export const MEASURAND = [
  'Current.Export',
  'Current.Import',
  'Current.Offered',
  'Energy.Active.Export.Register',
  'Energy.Active.Import.Register',
  'Energy.Reactive.Export.Register',
  'Energy.Reactive.Import.Register',
  'Energy.Active.Export.Interval',
  'Energy.Active.Import.Interval',
  'Energy.Reactive.Export.Interval',
  'Energy.Reactive.Import.Interval',
  'Frequency',
  'Power.Active.Export',
  'Power.Active.Import',
  'Power.Factor',
  'Power.Offered',
  'Power.Reactive.Export',
  'Power.Reactive.Import',
  'RPM',
  'SoC',
  'Temperature',
  'Voltage',
] as const;

export const PHASE = [
  'L1',
  'L2',
  'L3',
  'N',
  'L1-N',
  'L2-N',
  'L3-N',
  'L1-L2',
  'L2-L3',
  'L3-L1',
] as const;

export const LOCATION = ['Cable', 'EV', 'Inlet', 'Outlet', 'Body'] as const;

/**
 * UnitOfMeasure. The 1.6 spec — and the official JSON bundle — spell the Celsius
 * member "Celcius". The typo is normative for 1.6, so it stays; the corrected
 * "Celsius" is accepted alongside it because post-errata firmware sends that and
 * both mean the same thing to the rating engine.
 */
export const UNIT_OF_MEASURE = [
  'Wh',
  'kWh',
  'varh',
  'kvarh',
  'W',
  'kW',
  'VA',
  'kVA',
  'var',
  'kvar',
  'A',
  'V',
  'K',
  'Celcius',
  'Celsius',
  'Fahrenheit',
  'Percent',
] as const;

export const DIAGNOSTICS_STATUS = ['Idle', 'Uploaded', 'UploadFailed', 'Uploading'] as const;

export const FIRMWARE_STATUS = [
  'Downloaded',
  'DownloadFailed',
  'Downloading',
  'Idle',
  'InstallationFailed',
  'Installing',
  'Installed',
] as const;

export const BOOT_STATUS = ['Accepted', 'Pending', 'Rejected'] as const;

export const DATA_TRANSFER_STATUS = [
  'Accepted',
  'Rejected',
  'UnknownMessageId',
  'UnknownVendorId',
] as const;

// ------------------------------------------------------------ shared types

/**
 * SampledValue (§7.4). `value` is a **String** in 1.6 — not a number. The spec
 * carries the raw meter reading as text so that SignedData blobs and
 * fixed-precision decimals survive the wire without float rounding. We enforce
 * that, because a numeric `value` from a charger is a firmware bug we want to
 * see named in a CALLERROR rather than silently coerced into a billing row.
 */
const sampledValue: SchemaObject = {
  type: 'object',
  required: ['value'],
  properties: {
    value: { type: 'string' },
    context: { type: 'string', enum: [...READING_CONTEXT] },
    format: { type: 'string', enum: [...VALUE_FORMAT] },
    measurand: { type: 'string', enum: [...MEASURAND] },
    phase: { type: 'string', enum: [...PHASE] },
    location: { type: 'string', enum: [...LOCATION] },
    unit: { type: 'string', enum: [...UNIT_OF_MEASURE] },
  },
};

/** MeterValue (§7.4): a timestamped collection of at least one SampledValue. */
const meterValue: SchemaObject = {
  type: 'object',
  required: ['timestamp', 'sampledValue'],
  properties: {
    timestamp: dateTime,
    sampledValue: { type: 'array', minItems: 1, items: sampledValue },
  },
};

/** IdTagInfo (§7.4). parentIdTag is an IdToken, so it inherits the 20-char cap. */
const idTagInfo: SchemaObject = {
  type: 'object',
  required: ['status'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: [...AUTHORIZATION_STATUS] },
    expiryDate: dateTime,
    parentIdTag: ciString(20),
  },
};

/** IdToken (§7.4): CiString20. */
const idTag: SchemaObject = ciString(20);

// ------------------------------------------------------- CP -> CS requests

const BootNotificationReq: SchemaObject = {
  type: 'object',
  required: ['chargePointVendor', 'chargePointModel'],
  properties: {
    chargePointVendor: ciString(20),
    chargePointModel: ciString(20),
    chargePointSerialNumber: ciString(25),
    chargeBoxSerialNumber: ciString(25),
    firmwareVersion: ciString(50),
    iccid: ciString(20),
    imsi: ciString(20),
    meterType: ciString(25),
    meterSerialNumber: ciString(25),
  },
};

/** Heartbeat.req carries no fields at all. */
const HeartbeatReq: SchemaObject = {
  type: 'object',
  properties: {},
};

const StatusNotificationReq: SchemaObject = {
  type: 'object',
  required: ['connectorId', 'errorCode', 'status'],
  properties: {
    connectorId,
    errorCode: { type: 'string', enum: [...CHARGE_POINT_ERROR_CODE] },
    info: ciString(50),
    status: { type: 'string', enum: [...CHARGE_POINT_STATUS] },
    timestamp: dateTime,
    vendorId: ciString(255),
    vendorErrorCode: ciString(50),
  },
};

const AuthorizeReq: SchemaObject = {
  type: 'object',
  required: ['idTag'],
  properties: { idTag },
};

const StartTransactionReq: SchemaObject = {
  type: 'object',
  required: ['connectorId', 'idTag', 'meterStart', 'timestamp'],
  properties: {
    connectorId,
    idTag,
    meterStart: integer,
    reservationId: integer,
    timestamp: dateTime,
  },
};

const StopTransactionReq: SchemaObject = {
  type: 'object',
  required: ['transactionId', 'meterStop', 'timestamp'],
  properties: {
    idTag,
    meterStop: integer,
    timestamp: dateTime,
    transactionId: integer,
    reason: { type: 'string', enum: [...STOP_REASON] },
    transactionData: { type: 'array', items: meterValue },
  },
};

const MeterValuesReq: SchemaObject = {
  type: 'object',
  required: ['connectorId', 'meterValue'],
  properties: {
    connectorId,
    transactionId: integer,
    meterValue: { type: 'array', minItems: 1, items: meterValue },
  },
};

const DataTransferReq: SchemaObject = {
  type: 'object',
  required: ['vendorId'],
  properties: {
    vendorId: ciString(255),
    messageId: ciString(50),
    // `data` is free-form in the spec ("Data without specified length or format").
    // Chargers send JSON objects here as often as strings, so no type constraint.
    data: {},
  },
};

const DiagnosticsStatusNotificationReq: SchemaObject = {
  type: 'object',
  required: ['status'],
  properties: { status: { type: 'string', enum: [...DIAGNOSTICS_STATUS] } },
};

const FirmwareStatusNotificationReq: SchemaObject = {
  type: 'object',
  required: ['status'],
  properties: { status: { type: 'string', enum: [...FIRMWARE_STATUS] } },
};

/**
 * SecurityEventNotification.req comes from the OCPP 1.6 Security Whitepaper
 * (Ed.3), folded into 1.6 Edition 2. `type` is a CiString50 naming an event from
 * the whitepaper's table — the list is explicitly extensible by vendors, so it is
 * length-checked but not enum-checked.
 */
const SecurityEventNotificationReq: SchemaObject = {
  type: 'object',
  required: ['type', 'timestamp'],
  properties: {
    type: ciString(50),
    timestamp: dateTime,
    techInfo: ciString(255),
  },
};

/**
 * SignCertificate.req (1.6 Security Whitepaper): the charge point sends a PKCS#10
 * request for its own client certificate (Security Profile 3), usually after the
 * CSMS asked with ExtendedTriggerMessage(SignChargePointCertificate).
 */
const SignCertificateReq: SchemaObject = {
  type: 'object',
  required: ['csr'],
  properties: { csr: ciString(5500) },
};

const SignCertificateConf: SchemaObject = {
  type: 'object',
  required: ['status'],
  additionalProperties: false,
  properties: { status: { type: 'string', enum: ['Accepted', 'Rejected'] } },
};

// ------------------------------------------------------ CS -> CP responses

const BootNotificationConf: SchemaObject = {
  type: 'object',
  required: ['status', 'currentTime', 'interval'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: [...BOOT_STATUS] },
    currentTime: dateTime,
    interval: { type: 'integer', minimum: 0 },
  },
};

const HeartbeatConf: SchemaObject = {
  type: 'object',
  required: ['currentTime'],
  additionalProperties: false,
  properties: { currentTime: dateTime },
};

const StatusNotificationConf: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

const AuthorizeConf: SchemaObject = {
  type: 'object',
  required: ['idTagInfo'],
  additionalProperties: false,
  properties: { idTagInfo },
};

const StartTransactionConf: SchemaObject = {
  type: 'object',
  required: ['transactionId', 'idTagInfo'],
  additionalProperties: false,
  properties: { transactionId: integer, idTagInfo },
};

/** StopTransaction.conf: idTagInfo is optional (0..1) — omit it when there was no idTag. */
const StopTransactionConf: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: { idTagInfo },
};

const MeterValuesConf: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

const DataTransferConf: SchemaObject = {
  type: 'object',
  required: ['status'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: [...DATA_TRANSFER_STATUS] },
    data: {},
  },
};

/** The three notification .conf payloads are empty objects in the spec. */
const EmptyConf: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

// -------------------------------------------------------------- registries

/** CP -> CS requests the CSMS accepts. Keys are OCPP action names. */
export const REQUEST_SCHEMAS: Readonly<Record<string, SchemaObject>> = Object.freeze({
  BootNotification: BootNotificationReq,
  Heartbeat: HeartbeatReq,
  StatusNotification: StatusNotificationReq,
  Authorize: AuthorizeReq,
  StartTransaction: StartTransactionReq,
  StopTransaction: StopTransactionReq,
  MeterValues: MeterValuesReq,
  DataTransfer: DataTransferReq,
  DiagnosticsStatusNotification: DiagnosticsStatusNotificationReq,
  FirmwareStatusNotification: FirmwareStatusNotificationReq,
  SecurityEventNotification: SecurityEventNotificationReq,
  SignCertificate: SignCertificateReq,
});

/**
 * CS -> CP responses the CSMS generates, keyed by the *action* (not `<action>.conf`)
 * so a caller that already has the action string can validate the reply it is about
 * to write to the socket without any string building.
 */
export const RESPONSE_SCHEMAS: Readonly<Record<string, SchemaObject>> = Object.freeze({
  BootNotification: BootNotificationConf,
  Heartbeat: HeartbeatConf,
  StatusNotification: StatusNotificationConf,
  Authorize: AuthorizeConf,
  StartTransaction: StartTransactionConf,
  StopTransaction: StopTransactionConf,
  MeterValues: MeterValuesConf,
  DataTransfer: DataTransferConf,
  DiagnosticsStatusNotification: EmptyConf,
  FirmwareStatusNotification: EmptyConf,
  SecurityEventNotification: EmptyConf,
  SignCertificate: SignCertificateConf,
});
