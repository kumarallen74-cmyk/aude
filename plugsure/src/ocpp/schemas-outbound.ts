import type { SchemaObject } from 'ajv';

/**
 * Schemas for the CHARGER'S answers to OUR calls (the .conf of every command
 * the CSMS sends), per OCPP version.
 *
 * schemas16.ts / schemas201.ts describe the other direction: requests the
 * charger sends us and the replies we send back. A CALLRESULT to one of our
 * commands was handed to the caller unchecked, so `{ "status": "Acepted" }`,
 * `{ "status": 1 }` or a GetLocalListVersion without listVersion flowed into
 * command results, the console and provisioning as if the charger had answered
 * properly. rpc.ts now checks every CALLRESULT against the schema of the action
 * it answers (validate.ts validateOutboundResult) and rejects the pending call
 * with a clear error when it does not fit.
 *
 * Deliberately LENIENT where the request schemas are lenient: no
 * `additionalProperties: false` (vendors add fields to answers as freely as to
 * requests), and only the fields callers actually read are constrained — the
 * required `status` and its enumeration, the shapes provisioning and the config
 * studio interpret. An action with no schema here is not checked at all.
 */

const statusOf = (values: readonly string[]): SchemaObject => ({
  type: 'object',
  required: ['status'],
  properties: { status: { type: 'string', enum: [...values] } },
});

const ACCEPTED_REJECTED = ['Accepted', 'Rejected'] as const;
const DATA_TRANSFER = ['Accepted', 'Rejected', 'UnknownMessageId', 'UnknownVendorId'] as const;
const RESERVATION = ['Accepted', 'Faulted', 'Occupied', 'Rejected', 'Unavailable'] as const;

// ------------------------------------------------------------------ OCPP 1.6

export const OUTBOUND_RESPONSE_SCHEMAS_16: Readonly<Record<string, SchemaObject>> = Object.freeze({
  RemoteStartTransaction: statusOf(ACCEPTED_REJECTED),
  RemoteStopTransaction: statusOf(ACCEPTED_REJECTED),
  Reset: statusOf(ACCEPTED_REJECTED),
  UnlockConnector: statusOf(['Unlocked', 'UnlockFailed', 'NotSupported']),
  ChangeAvailability: statusOf(['Accepted', 'Rejected', 'Scheduled']),
  TriggerMessage: statusOf(['Accepted', 'Rejected', 'NotImplemented']),
  ClearCache: statusOf(ACCEPTED_REJECTED),
  ChangeConfiguration: statusOf(['Accepted', 'Rejected', 'RebootRequired', 'NotSupported']),
  GetConfiguration: {
    type: 'object',
    properties: {
      configurationKey: {
        type: 'array',
        items: {
          type: 'object',
          required: ['key'],
          properties: { key: { type: 'string' }, readonly: { type: 'boolean' }, value: { type: 'string' } },
        },
      },
      unknownKey: { type: 'array', items: { type: 'string' } },
    },
  },
  GetLocalListVersion: {
    type: 'object',
    required: ['listVersion'],
    properties: { listVersion: { type: 'integer' } },
  },
  SendLocalList: statusOf(['Accepted', 'Failed', 'NotSupported', 'VersionMismatch']),
  ReserveNow: statusOf(RESERVATION),
  CancelReservation: statusOf(ACCEPTED_REJECTED),
  SetChargingProfile: statusOf(['Accepted', 'Rejected', 'NotSupported']),
  ClearChargingProfile: statusOf(['Accepted', 'Unknown']),
  GetCompositeSchedule: statusOf(ACCEPTED_REJECTED),
  DataTransfer: statusOf(DATA_TRANSFER),
  GetDiagnostics: { type: 'object', properties: { fileName: { type: 'string' } } },
  UpdateFirmware: { type: 'object' },
});

// ------------------------------------------------------------------ OCPP 2.0.1

const variableResult = (statuses: readonly string[]): SchemaObject => ({
  type: 'object',
  required: ['attributeStatus', 'component', 'variable'],
  properties: {
    attributeStatus: { type: 'string', enum: [...statuses] },
    attributeValue: { type: 'string' },
    component: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    variable: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  },
});

const GET_VARIABLE_STATUS = ['Accepted', 'Rejected', 'UnknownComponent', 'UnknownVariable', 'NotSupportedAttributeType'] as const;
const SET_VARIABLE_STATUS = [...GET_VARIABLE_STATUS, 'RebootRequired'] as const;

export const OUTBOUND_RESPONSE_SCHEMAS_201: Readonly<Record<string, SchemaObject>> = Object.freeze({
  RequestStartTransaction: {
    type: 'object',
    required: ['status'],
    properties: { status: { type: 'string', enum: [...ACCEPTED_REJECTED] }, transactionId: { type: 'string' } },
  },
  RequestStopTransaction: statusOf(ACCEPTED_REJECTED),
  Reset: statusOf(['Accepted', 'Rejected', 'Scheduled']),
  UnlockConnector: statusOf(['Unlocked', 'UnlockFailed', 'OngoingAuthorizedTransaction', 'UnknownConnector']),
  ChangeAvailability: statusOf(['Accepted', 'Rejected', 'Scheduled']),
  TriggerMessage: statusOf(['Accepted', 'Rejected', 'NotImplemented']),
  ClearCache: statusOf(ACCEPTED_REJECTED),
  GetVariables: {
    type: 'object',
    required: ['getVariableResult'],
    properties: { getVariableResult: { type: 'array', minItems: 1, items: variableResult(GET_VARIABLE_STATUS) } },
  },
  SetVariables: {
    type: 'object',
    required: ['setVariableResult'],
    properties: { setVariableResult: { type: 'array', minItems: 1, items: variableResult(SET_VARIABLE_STATUS) } },
  },
  GetLocalListVersion: {
    type: 'object',
    required: ['versionNumber'],
    properties: { versionNumber: { type: 'integer' } },
  },
  SendLocalList: statusOf(['Accepted', 'Failed', 'VersionMismatch']),
  ReserveNow: statusOf(RESERVATION),
  CancelReservation: statusOf(ACCEPTED_REJECTED),
  SetChargingProfile: statusOf(ACCEPTED_REJECTED),
  ClearChargingProfile: statusOf(['Accepted', 'Unknown']),
  GetCompositeSchedule: statusOf(ACCEPTED_REJECTED),
  DataTransfer: statusOf(DATA_TRANSFER),
  UpdateFirmware: statusOf(['Accepted', 'Rejected', 'AcceptedCanceled', 'InvalidCertificate', 'RevokedCertificate']),
  GetLog: {
    type: 'object',
    required: ['status'],
    properties: { status: { type: 'string', enum: ['Accepted', 'Rejected', 'AcceptedCanceled'] }, filename: { type: 'string' } },
  },
});

/**
 * OCPP 2.1 answers keep the 2.0.1 shapes, but 2.1 may add enumeration values
 * (and this CSMS does not yet track them per message): the 2.1 set checks the
 * shapes and types, not the status vocabularies, so a valid 2.1 answer is
 * never refused as malformed.
 */
function withoutEnums<T>(schema: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (k !== 'enum') out[k] = walk(x);
    return out;
  };
  return walk(schema) as T;
}

export const OUTBOUND_RESPONSE_SCHEMAS_21: Readonly<Record<string, SchemaObject>> = Object.freeze(
  withoutEnums(OUTBOUND_RESPONSE_SCHEMAS_201) as Record<string, SchemaObject>,
);
