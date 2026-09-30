import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import { REQUEST_SCHEMAS, RESPONSE_SCHEMAS } from './schemas16.js';
import { REQUEST_SCHEMAS_201, RESPONSE_SCHEMAS_201 } from './schemas201.js';
import { REQUEST_SCHEMAS_21, RESPONSE_SCHEMAS_21 } from './schemas21.js';
import type { OcppVersion } from '../domain/canonical.js';

/**
 * OCPP 1.6J payload validation.
 *
 * Every inbound CALL payload is checked against a JSON Schema *before* it reaches
 * a handler. Without this, a charger that sends `meterStart: "abc"` gets that
 * string forwarded into Postgres, and the driver's DDL error text comes back out
 * on the wire as `CALLERROR InternalError` — leaking schema internals to anyone
 * who can open a WebSocket. Here the frame is rejected with a precise,
 * spec-correct OCPP error code and a message built solely from the schema.
 *
 * ## Error-code mapping (a vendor conformance review checks these)
 *
 * OCPP 1.6 §4.2.3 defines the CALLERROR codes. Our mapping:
 *
 *  - not an object / not a possible payload  -> FormationViolation
 *      "Payload for Action is syntactically incorrect".
 *  - missing required property               -> ProtocolError
 *  - wrong JSON type                         -> TypeConstraintViolation
 *  - array cardinality (minItems/maxItems)   -> OccurrenceConstraintViolation
 *  - enum / maxLength / minimum / pattern /
 *    format / additionalProperties           -> PropertyConstraintViolation
 *  - unknown action                          -> NotImplemented
 *
 * ### Why missing-required is ProtocolError, not OccurrenceConstraintViolation
 *
 * Both readings are defensible: a mandatory field is a 1..1 occurrence
 * constraint, so its absence is arguably an occurrence violation. We choose
 * ProtocolError because 1.6 defines it as "Payload for Action is incomplete",
 * which is exactly and only this case, and it is what the OCA compliance test
 * tool expects. OccurrenceConstraintViolation is then reserved, consistently,
 * for the other kind of cardinality error 1.6 can express: an array that is
 * present but has the wrong number of elements (`meterValue: []`). Applied
 * uniformly, in both directions, for every action.
 *
 * ## Wire safety
 *
 * `ValidationFailure.message` is assembled from the JSON pointer plus Ajv's
 * schema-derived message. Ajv never interpolates instance *values* into those
 * messages, so no charger data, database text, connection string or stack frame
 * can reach the wire through this path. `sanitize()` below is a belt-and-braces
 * cap on length and control characters.
 */

export type OcppErrorCode =
  | 'NotImplemented'
  | 'NotSupported'
  | 'InternalError'
  | 'ProtocolError'
  | 'SecurityError'
  | 'FormationViolation'
  | 'PropertyConstraintViolation'
  | 'OccurrenceConstraintViolation'
  | 'TypeConstraintViolation'
  | 'GenericError';

export interface ValidationFailure {
  code: OcppErrorCode;
  /** Safe to send on the wire — schema-derived only, never DB or stack text. */
  message: string;
  details: Record<string, unknown>;
}

// ----------------------------------------------------------------- date-time

/**
 * RFC 3339 date-time, which is what OCPP 1.6 means by "dateTime".
 *
 * Implemented here rather than pulled from `ajv-formats` on purpose: that package
 * is present in node_modules only as a transitive dependency of Fastify, so
 * importing it would make the gateway's inbound validation break on the next
 * `npm prune`. It is also 40 lines of regexes we would only ever use one of.
 *
 * A trailing offset (or Z) is mandatory: a naive local timestamp from a charger
 * in WIB silently shifts every billing row by seven hours.
 */
const DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

export function isIsoDateTime(value: string): boolean {
  const m = DATE_TIME_RE.exec(value);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  if (hour > 23 || minute > 59) return false;
  // 60 is a legal leap second under RFC 3339.
  if (second > 60) return false;
  // Day 0 of the next month is the last day of this one; catches 2025-02-31.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

// --------------------------------------------------------------------- ajv

// `Ajv` ships as a CJS default export; ESM interop hands it back under .default
// in some resolutions and directly in others.
const AjvCtor = ((Ajv as unknown as { default?: typeof Ajv }).default ??
  Ajv) as typeof Ajv;

const ajv = new AjvCtor({
  // ALL errors, not just the first.
  //
  // We report only one on the wire, but a payload can carry one deviation we
  // tolerate (a 21-character Autel model name) alongside a fault we must not
  // (a serial number sent as a number). Stopping at the first error would let
  // the tolerable one mask the fatal one. The cost is paid only on the failure
  // path — a valid payload short-circuits before any error object is built.
  allErrors: true,
  // Never rewrite the charger's payload — handlers must see exactly what arrived.
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  // Our schemas are hand-written; keep Ajv's authoring checks on so a typo in
  // schemas16.ts fails at module load rather than silently validating nothing.
  strict: true,
  allowUnionTypes: false,
});

ajv.addFormat('date-time', { type: 'string', validate: isIsoDateTime });

/**
 * Compiled once at module load and cached by action name. `validateCall` on the
 * hot path is then a single Map lookup plus the compiled function — no schema
 * traversal, no object allocation until something actually fails.
 */
function compileAll(schemas: Readonly<Record<string, object>>): Map<string, ValidateFunction> {
  const out = new Map<string, ValidateFunction>();
  for (const [action, schema] of Object.entries(schemas)) {
    out.set(action, ajv.compile(schema));
  }
  return out;
}

const requestValidators = compileAll(REQUEST_SCHEMAS);
const responseValidators = compileAll(RESPONSE_SCHEMAS);
const requestValidators201 = compileAll(REQUEST_SCHEMAS_201);
const responseValidators201 = compileAll(RESPONSE_SCHEMAS_201);
const requestValidators21 = compileAll(REQUEST_SCHEMAS_21);
const responseValidators21 = compileAll(RESPONSE_SCHEMAS_21);

/**
 * Pick the schema set for a negotiated OCPP version. Version-scoping matters
 * because 1.6 and 2.0.1 SHARE action names (BootNotification, StatusNotification,
 * Authorize, Heartbeat) but define DIFFERENT payloads — validating a 2.0.1
 * StatusNotification against the 1.6 schema would reject every real frame. The
 * `version` argument defaults to 1.6 everywhere so every existing 1.6 call site
 * is byte-for-byte unchanged.
 */
function reqValidators(version: OcppVersion): Map<string, ValidateFunction> {
  // 2.1 has its own set: the 2.0.1 schemas with 2.1's wider enumerations (schemas21.ts).
  return version === 'ocpp2.1' ? requestValidators21 : version === 'ocpp2.0.1' ? requestValidators201 : requestValidators;
}
function resValidators(version: OcppVersion): Map<string, ValidateFunction> {
  return version === 'ocpp2.1' ? responseValidators21 : version === 'ocpp2.0.1' ? responseValidators201 : responseValidators;
}

/** Actions the CSMS accepts inbound over OCPP 1.6. */
export const INBOUND_ACTIONS: readonly string[] = Object.freeze(Object.keys(REQUEST_SCHEMAS));
/** Actions the CSMS accepts inbound over OCPP 2.0.1. */
export const INBOUND_ACTIONS_201: readonly string[] = Object.freeze(Object.keys(REQUEST_SCHEMAS_201));

// --------------------------------------------------------------- reporting

const MAX_MESSAGE_LEN = 240;

/** ASCII control characters and DEL. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Strip control characters and cap length. Defence in depth — see module comment. */
function sanitize(text: string): string {
  const flat = text.replace(CONTROL_CHARS, ' ').trim();
  return flat.length > MAX_MESSAGE_LEN ? `${flat.slice(0, MAX_MESSAGE_LEN - 1)}…` : flat;
}

function codeForKeyword(err: ErrorObject): OcppErrorCode {
  switch (err.keyword) {
    case 'required':
      return 'ProtocolError';
    case 'type':
      // A type failure at the document root means the frame's payload slot did
      // not hold a payload at all.
      return err.instancePath === '' ? 'FormationViolation' : 'TypeConstraintViolation';
    case 'minItems':
    case 'maxItems':
      return 'OccurrenceConstraintViolation';
    case 'enum':
    case 'const':
    case 'maxLength':
    case 'minLength':
    case 'pattern':
    case 'format':
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'exclusiveMaximum':
    case 'multipleOf':
    case 'additionalProperties':
      return 'PropertyConstraintViolation';
    default:
      // Any keyword we have not classified is still a constraint on a property.
      return 'PropertyConstraintViolation';
  }
}

/** JSON pointer to the offending member. For `required`, point at the absentee. */
function pointerFor(err: ErrorObject): string {
  if (err.keyword === 'required') {
    const missing = (err.params as { missingProperty?: string }).missingProperty;
    return missing ? `${err.instancePath}/${missing}` : err.instancePath || '/';
  }
  if (err.keyword === 'additionalProperties') {
    const extra = (err.params as { additionalProperty?: string }).additionalProperty;
    return extra ? `${err.instancePath}/${extra}` : err.instancePath || '/';
  }
  return err.instancePath === '' ? '/' : err.instancePath;
}

function detailsFor(action: string, err: ErrorObject, field: string): Record<string, unknown> {
  const p = err.params as Record<string, unknown>;
  const details: Record<string, unknown> = { action, field, rule: err.keyword };
  switch (err.keyword) {
    case 'required':
      details['missingProperty'] = p['missingProperty'];
      break;
    case 'type':
      details['expected'] = p['type'];
      break;
    case 'enum':
      details['allowed'] = p['allowedValues'];
      break;
    case 'maxLength':
    case 'minLength':
    case 'minItems':
    case 'maxItems':
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'exclusiveMaximum':
      details['limit'] = p['limit'];
      break;
    case 'pattern':
      details['pattern'] = p['pattern'];
      break;
    case 'format':
      details['format'] = p['format'];
      break;
    case 'multipleOf':
      details['multipleOf'] = p['multipleOf'];
      break;
    case 'additionalProperties':
      details['unexpectedProperty'] = p['additionalProperty'];
      break;
    default:
      break;
  }
  return details;
}

function failureFrom(action: string, errors: ErrorObject[] | null | undefined): ValidationFailure {
  const err = errors?.[0];
  if (!err) {
    // Ajv said "invalid" without an error object. Should not happen; do not
    // pretend the payload was fine.
    return {
      code: 'GenericError',
      message: 'payload failed validation',
      details: { action },
    };
  }
  const field = pointerFor(err);
  return {
    code: codeForKeyword(err),
    message: sanitize(`${field}: ${err.message ?? 'is invalid'}`),
    details: detailsFor(action, err, field),
  };
}

function notAnObject(action: string, payload: unknown): ValidationFailure {
  const actual =
    payload === null ? 'null' : Array.isArray(payload) ? 'array' : typeof payload;
  return {
    code: 'FormationViolation',
    message: sanitize(`/: payload must be a JSON object, got ${actual}`),
    details: { action, field: '/', rule: 'type', expected: 'object', received: actual },
  };
}

/** Cheap, allocation-free guard for the "this is not a payload at all" case. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ----------------------------------------------------------------- public API

/** True when we have a schema for this inbound action on the negotiated version. */
export function isKnownAction(action: string, version: OcppVersion = 'ocpp1.6'): boolean {
  return reqValidators(version).has(action);
}

/**
 * Validate a CP->CS request payload. Returns null when valid.
 *
 * An unknown action yields a `NotImplemented` failure rather than a throw, so the
 * RPC layer can forward it straight into a CALLERROR without a second branch.
 */
/**
 * Constraint violations we RECORD but do not reject.
 *
 * The spec is the spec, but a CSMS that hangs up on a charger over a cosmetic
 * field is useless in the field, and losing a MeterValues frame loses billable
 * energy. Two cases are real and both were hit on the first integration run:
 *
 *  · Autel's `chargePointModel` "MaxiCharger AC Wallbox" is 21 characters
 *    against OCPP 1.6's CiString20. The field is informational; refusing the
 *    BootNotification would strand the unit.
 *  · Chargers send `sampledValue.value` as a JSON number although 1.6 types it
 *    as String. Rejecting the frame throws away metering data.
 *
 * Both are surfaced to the quirk registry instead, so the deviation is visible
 * and can be raised with the vendor, rather than silently normalised away.
 * Anything structural — a missing required field, a wrong type on something we
 * must interpret, an enum whose value changes meaning — is still fatal.
 */
const INFORMATIONAL_STRING_FIELDS = new Set([
  '/chargePointVendor',
  '/chargePointModel',
  '/chargePointSerialNumber',
  '/chargeBoxSerialNumber',
  '/firmwareVersion',
  '/iccid',
  '/imsi',
  '/meterType',
  '/meterSerialNumber',
  '/info',
  '/vendorErrorCode',
  '/vendorId',
  '/messageId',
  // The same informational fields in OCPP 2.0.1, nested under chargingStation.
  // Without these, the Autel model string that 1.6 tolerates stranded the unit
  // at BootNotification as soon as it negotiated 2.0.1.
  '/chargingStation/model',
  '/chargingStation/vendorName',
  '/chargingStation/serialNumber',
  '/chargingStation/firmwareVersion',
  '/chargingStation/modem/iccid',
  '/chargingStation/modem/imsi',
]);

export interface ValidationOutcome {
  /** Fatal: the caller must answer with a CALLERROR. */
  failure: ValidationFailure | null;
  /** Deviations from the spec that were accepted, for the quirk registry. */
  tolerated: ValidationFailure[];
}

function isTolerable(f: ValidationFailure): boolean {
  const field = String(f.details?.field ?? '');
  const rule = String(f.details?.rule ?? '');
  if (rule === 'maxLength' && INFORMATIONAL_STRING_FIELDS.has(field)) return true;
  // A numeric sampled value: the adapter already coerces with Number().
  if (rule === 'type' && /\/sampledValue\/\d+\/value$/.test(field) && f.details?.expected === 'string') {
    return true;
  }
  /**
   * StopTransaction without meterStop.
   *
   * The spec does require it, and rejecting the frame is defensible in the
   * abstract. In practice the charger retries, gets the identical deterministic
   * error, gives up, and the session stays `active` forever — holding the
   * one-active-session-per-connector index and never being billed. The
   * running-total fallback for exactly this case was already written in
   * sessions.ts and was unreachable dead code because validation rejected the
   * frame first. The simulator even ships `--omit-meterstop` as a documented
   * real-hardware fault mode.
   *
   * Tolerate it, record the deviation, and bill from the running total.
   */
  if (rule === 'required' && field === '/meterStop') return true;
  return false;
}

/**
 * Full result, including deviations that were accepted rather than rejected.
 *
 * Partitions ALL of Ajv's errors in one pass. The previous version took only
 * `errors[0]`, so `tolerated` could hold at most one entry — a BootNotification
 * with an over-length vendor AND an over-length model recorded the vendor and
 * silently dropped the model, which is the deviation the quirk registry exists
 * to capture.
 */
export function validateCallDetailed(
  action: string,
  payload: unknown,
  version: OcppVersion = 'ocpp1.6',
): ValidationOutcome {
  const all = allFailures(action, payload, version);
  if (all.length === 0) return { failure: null, tolerated: [] };

  const tolerated: ValidationFailure[] = [];
  let failure: ValidationFailure | null = null;
  for (const f of all) {
    if (isTolerable(f)) tolerated.push(f);
    else if (!failure) failure = f; // the first genuine fault is what we answer with
  }
  return { failure, tolerated };
}

export function validateCall(
  action: string,
  payload: unknown,
  version: OcppVersion = 'ocpp1.6',
): ValidationFailure | null {
  return validateCallDetailed(action, payload, version).failure;
}

/** Every distinct validation failure in a payload, tolerable or not. */
function allFailures(action: string, payload: unknown, version: OcppVersion = 'ocpp1.6'): ValidationFailure[] {
  const validate = reqValidators(version).get(action);
  if (validate === undefined) {
    return [
      {
        code: 'NotImplemented',
        message: sanitize(`unsupported action: ${asActionLabel(action)}`),
        details: { action: asActionLabel(action), rule: 'unknownAction' },
      },
    ];
  }
  const notObject = isPlainObject(payload) ? null : notAnObject(action, payload);
  if (notObject) return [notObject];
  if (validate(payload)) return [];

  const out: ValidationFailure[] = [];
  const seen = new Set<string>();
  for (const e of validate.errors ?? []) {
    const f = failureFrom(action, [e]);
    if (!f) continue;
    const key = `${f.details?.field ?? ''}|${f.details?.rule ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function validateCallStrict(
  action: string,
  payload: unknown,
  keep?: (f: ValidationFailure) => boolean,
): ValidationFailure | null {
  const validate = requestValidators.get(action);
  if (validate === undefined) {
    return {
      code: 'NotImplemented',
      message: sanitize(`unsupported action: ${asActionLabel(action)}`),
      details: { action: asActionLabel(action), rule: 'unknownAction' },
    };
  }
  if (!isPlainObject(payload)) return notAnObject(action, payload);
  if (validate(payload)) return null;

  const errors = validate.errors ?? [];
  if (!keep) return failureFrom(action, errors);

  // Report the first error the caller still cares about, so a payload with one
  // tolerable deviation AND one genuine fault is still rejected for the fault.
  for (const e of errors) {
    const f = failureFrom(action, [e]);
    if (f && keep(f)) return f;
  }
  return null;
}

/**
 * Validate a CS->CP response payload we are about to send (defence against our
 * own bugs). Unlike requests, these are checked with `additionalProperties: false`
 * — a stray field in our own reply is a bug worth catching.
 *
 * Returns null for an action we have no response schema for: this is a safety net
 * over outbound frames, not a gate, and a newly handled action must not start
 * failing merely because its .conf schema has not been written yet.
 */
export function validateCallResult(
  action: string,
  payload: unknown,
  version: OcppVersion = 'ocpp1.6',
): ValidationFailure | null {
  const validate = resValidators(version).get(action);
  if (validate === undefined) return null;
  if (!isPlainObject(payload)) return notAnObject(action, payload);
  if (validate(payload)) return null;
  return failureFrom(action, validate.errors);
}

/**
 * Action names arrive from the wire, so they are attacker-controlled and end up
 * in an error message. Clamp to something that cannot be used to smuggle text.
 */
function asActionLabel(action: string): string {
  const clean = action.replace(/[^A-Za-z0-9._-]/g, '');
  return clean.length > 64 ? clean.slice(0, 64) : clean || '(empty)';
}
