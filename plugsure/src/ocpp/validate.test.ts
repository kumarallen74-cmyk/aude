import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INBOUND_ACTIONS,
  isKnownAction,
  isIsoDateTime,
  validateCall,
  validateCallDetailed,
  validateCallResult,
  type ValidationFailure,
} from './validate.js';
import { REQUEST_SCHEMAS, RESPONSE_SCHEMAS } from './schemas16.js';

const TS = '2026-08-23T04:15:00Z';

/** Fail loudly with the actual failure attached, and narrow the type. */
function mustFail(f: ValidationFailure | null, what: string): ValidationFailure {
  assert.ok(f !== null, `expected ${what} to fail validation, but it passed`);
  return f;
}

function mustPass(f: ValidationFailure | null, what: string): void {
  assert.equal(f, null, `expected ${what} to pass, got ${JSON.stringify(f)}`);
}

// One spec-valid payload per inbound action.
const VALID: Record<string, Record<string, unknown>> = {
  BootNotification: {
    chargePointVendor: 'Autel',
    chargePointModel: 'MaxiCharger AC',
    chargePointSerialNumber: 'AC1234567890',
    firmwareVersion: 'V1.2.3',
    iccid: '8962000000000000001',
    imsi: '510110000000001',
    meterType: 'DTSU666',
    meterSerialNumber: 'MSN-0001',
  },
  Heartbeat: {},
  StatusNotification: {
    connectorId: 1,
    errorCode: 'NoError',
    status: 'Charging',
    timestamp: TS,
    info: 'ok',
    vendorId: 'com.autel',
    vendorErrorCode: 'E0001',
  },
  Authorize: { idTag: '04A1B2C3D4E5F6' },
  StartTransaction: {
    connectorId: 1,
    idTag: '04A1B2C3D4E5F6',
    meterStart: 1000,
    timestamp: TS,
    reservationId: 7,
  },
  StopTransaction: {
    transactionId: 1042,
    meterStop: 25000,
    timestamp: TS,
    idTag: '04A1B2C3D4E5F6',
    reason: 'EVDisconnected',
    transactionData: [
      {
        timestamp: TS,
        sampledValue: [
          {
            value: '25000',
            measurand: 'Energy.Active.Import.Register',
            unit: 'Wh',
            context: 'Transaction.End',
          },
        ],
      },
    ],
  },
  MeterValues: {
    connectorId: 1,
    transactionId: 1042,
    meterValue: [
      {
        timestamp: TS,
        sampledValue: [
          {
            value: '12345.6',
            context: 'Sample.Periodic',
            format: 'Raw',
            measurand: 'Energy.Active.Import.Register',
            location: 'Outlet',
            unit: 'Wh',
          },
          { value: '230.1', measurand: 'Voltage', phase: 'L1-N', unit: 'V' },
        ],
      },
    ],
  },
  DataTransfer: {
    vendorId: 'org.openchargealliance.iso15118pnc',
    messageId: 'Authorize',
    data: '{"certificate":"..."}',
  },
  DiagnosticsStatusNotification: { status: 'Uploaded' },
  FirmwareStatusNotification: { status: 'Installed' },
  SecurityEventNotification: {
    type: 'SettingSystemTime',
    timestamp: TS,
    techInfo: 'ntp resync',
  },
  // 1.6 Security Whitepaper: the charge point's own client certificate.
  SignCertificate: { csr: '-----BEGIN CERTIFICATE REQUEST-----\nMIIB\n-----END CERTIFICATE REQUEST-----' },
};

/** A payload built from VALID with one field overridden or removed. */
function tweak(action: string, patch: Record<string, unknown>): Record<string, unknown> {
  const base = VALID[action];
  assert.ok(base, `no VALID fixture for ${action}`);
  const out: Record<string, unknown> = { ...base, ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete out[k];
  return out;
}

// ------------------------------------------------------------ coverage

test('INBOUND_ACTIONS covers every CP->CS action the CSMS accepts', () => {
  const expected = [
    'BootNotification',
    'Heartbeat',
    'StatusNotification',
    'Authorize',
    'StartTransaction',
    'StopTransaction',
    'MeterValues',
    'DataTransfer',
    'DiagnosticsStatusNotification',
    'FirmwareStatusNotification',
    'SecurityEventNotification',
    'SignCertificate',
  ];
  assert.deepEqual([...INBOUND_ACTIONS].sort(), [...expected].sort());
});

test('every action in INBOUND_ACTIONS has a schema and isKnownAction agrees', () => {
  for (const action of INBOUND_ACTIONS) {
    assert.ok(REQUEST_SCHEMAS[action], `missing request schema for ${action}`);
    assert.equal(isKnownAction(action), true, `isKnownAction false for ${action}`);
  }
  for (const action of Object.keys(REQUEST_SCHEMAS)) {
    assert.ok(INBOUND_ACTIONS.includes(action), `${action} has a schema but is not inbound`);
  }
  assert.equal(isKnownAction('RemoteStartTransaction'), false);
  assert.equal(isKnownAction(''), false);
});

test('the CSMS-generated responses all have .conf schemas', () => {
  for (const action of [
    'BootNotification',
    'Heartbeat',
    'StatusNotification',
    'Authorize',
    'StartTransaction',
    'StopTransaction',
    'MeterValues',
    'DataTransfer',
  ]) {
    assert.ok(RESPONSE_SCHEMAS[action], `missing response schema for ${action}`);
  }
});

test('a valid payload for each of the 12 inbound actions passes', () => {
  for (const action of INBOUND_ACTIONS) {
    const payload = VALID[action];
    assert.ok(payload, `test fixture missing for ${action}`);
    mustPass(validateCall(action, payload), `valid ${action}`);
  }
});

test('every inbound action accepts a minimal payload with only its required fields', () => {
  // Optional fields really are optional.
  mustPass(
    validateCall('BootNotification', { chargePointVendor: 'X', chargePointModel: 'Y' }),
    'minimal BootNotification',
  );
  mustPass(validateCall('Heartbeat', {}), 'minimal Heartbeat');
  mustPass(
    validateCall('StatusNotification', { connectorId: 0, errorCode: 'NoError', status: 'Available' }),
    'minimal StatusNotification',
  );
  mustPass(
    validateCall('StopTransaction', { transactionId: 1, meterStop: 0, timestamp: TS }),
    'minimal StopTransaction',
  );
  mustPass(validateCall('DataTransfer', { vendorId: 'com.example' }), 'minimal DataTransfer');
});

// ------------------------------------------------- required / type / limits

test('StartTransaction missing connectorId is rejected without leaking internals', () => {
  const f = mustFail(
    validateCall('StartTransaction', tweak('StartTransaction', { connectorId: undefined })),
    'StartTransaction without connectorId',
  );
  // Documented choice: a missing mandatory field is ProtocolError
  // ("payload is incomplete"), not OccurrenceConstraintViolation.
  assert.equal(f.code, 'ProtocolError');
  assert.match(f.message, /connectorId/);
  assert.equal(f.details['field'], '/connectorId');
  assert.equal(f.details['rule'], 'required');

  // The message goes on the wire: it must carry no database or stack text.
  const forbidden =
    /select |insert |update |delete |relation |column |pg_|postgres|ECONNREFUSED|at Object\.|\.ts:\d+|\/home\/|node_modules/i;
  assert.doesNotMatch(f.message, forbidden, `unsafe message: ${f.message}`);
  assert.doesNotMatch(JSON.stringify(f.details), forbidden);
});

test('meterStart: "abc" is a TypeConstraintViolation', () => {
  const f = mustFail(
    validateCall('StartTransaction', tweak('StartTransaction', { meterStart: 'abc' })),
    'string meterStart',
  );
  assert.equal(f.code, 'TypeConstraintViolation');
  assert.equal(f.details['field'], '/meterStart');
  assert.equal(f.details['expected'], 'integer');
});

test('a non-integer meterStop is a TypeConstraintViolation', () => {
  const f = mustFail(
    validateCall('StopTransaction', tweak('StopTransaction', { meterStop: 12.5 })),
    'fractional meterStop',
  );
  assert.equal(f.code, 'TypeConstraintViolation');
  assert.equal(f.details['field'], '/meterStop');
});

test('a 21-character idTag is a PropertyConstraintViolation carrying the limit', () => {
  const tooLong = 'A'.repeat(21);
  const f = mustFail(validateCall('Authorize', { idTag: tooLong }), '21-char idTag');
  assert.equal(f.code, 'PropertyConstraintViolation');
  assert.equal(f.details['field'], '/idTag');
  assert.equal(f.details['rule'], 'maxLength');
  assert.equal(f.details['limit'], 20);
  assert.match(f.message, /^\/idTag: /);
  // A 20-character idTag is exactly at the cap and must pass.
  mustPass(validateCall('Authorize', { idTag: 'A'.repeat(20) }), '20-char idTag');
  // The value itself must never be echoed back onto the wire.
  assert.ok(!f.message.includes(tooLong), 'failure message echoed the offending value');
});

test('CiString caps are enforced as TOLERATED deviations on informational fields', () => {
  const caps: Array<[string, number]> = [
    ['chargePointVendor', 20],
    ['chargePointModel', 20],
    ['chargePointSerialNumber', 25],
    ['chargeBoxSerialNumber', 25],
    ['firmwareVersion', 50],
    ['iccid', 20],
    ['imsi', 20],
    ['meterType', 25],
    ['meterSerialNumber', 25],
  ];
  for (const [field, cap] of caps) {
    mustPass(
      validateCall('BootNotification', {
        chargePointVendor: 'V',
        chargePointModel: 'M',
        [field]: 'x'.repeat(cap),
      }),
      `${field} at ${cap}`,
    );

    // Over the cap: NOT fatal. Autel's real chargePointModel — "MaxiCharger AC
    // Wallbox" — is 21 characters against a CiString20 field, and refusing the
    // BootNotification over an informational string would strand the unit.
    const payload = {
      chargePointVendor: 'V',
      chargePointModel: 'M',
      [field]: 'x'.repeat(cap + 1),
    };
    assert.equal(validateCall('BootNotification', payload), null, `${field} at ${cap + 1} must not be fatal`);

    // ...but it IS reported, so the deviation reaches the quirk registry.
    const outcome = validateCallDetailed('BootNotification', payload);
    assert.equal(outcome.tolerated.length, 1, `${field} over cap should be reported as tolerated`);
    assert.equal(outcome.tolerated[0]!.details['limit'], cap, `${field} cap should be ${cap}`);
    assert.equal(outcome.tolerated[0]!.code, 'PropertyConstraintViolation');
  }
});

test('a tolerable deviation never masks a fatal one in the same payload', () => {
  // Over-long model (tolerated) AND a serial sent as a number (fatal).
  const f = mustFail(
    validateCall('BootNotification', {
      chargePointVendor: 'V',
      chargePointModel: 'MaxiCharger AC Wallbox',
      chargePointSerialNumber: 12345,
    }),
    'tolerable + fatal',
  );
  assert.equal(f.code, 'TypeConstraintViolation');
  assert.equal(f.details['field'], '/chargePointSerialNumber');
});

test('DataTransfer vendorId and messageId caps are tolerated deviations', () => {
  mustPass(validateCall('DataTransfer', { vendorId: 'v'.repeat(255) }), 'vendorId at 255');
  const over = validateCallDetailed('DataTransfer', { vendorId: 'v'.repeat(256) });
  assert.equal(over.failure, null, 'an over-long vendorId must not drop the frame');
  assert.equal(over.tolerated[0]!.details['limit'], 255);

  const msg = validateCallDetailed('DataTransfer', { vendorId: 'v', messageId: 'm'.repeat(51) });
  assert.equal(msg.failure, null);
  assert.equal(msg.tolerated[0]!.details['limit'], 50);
});

test('StatusNotification.info over its cap is tolerated, not fatal', () => {
  const payload = tweak('StatusNotification', { info: 'i'.repeat(51) });
  assert.equal(validateCall('StatusNotification', payload), null);
  const outcome = validateCallDetailed('StatusNotification', payload);
  assert.equal(outcome.tolerated[0]!.code, 'PropertyConstraintViolation');
  assert.equal(outcome.tolerated[0]!.details['limit'], 50);
});

// ------------------------------------------------------------------ enums

test('StatusNotification.status "Bogus" is a PropertyConstraintViolation', () => {
  const f = mustFail(
    validateCall('StatusNotification', tweak('StatusNotification', { status: 'Bogus' })),
    'bogus status',
  );
  assert.equal(f.code, 'PropertyConstraintViolation');
  assert.equal(f.details['field'], '/status');
  assert.equal(f.details['rule'], 'enum');
  assert.ok(Array.isArray(f.details['allowed']));
});

test('every ChargePointStatus and ChargePointErrorCode member is accepted', () => {
  const statuses = [
    'Available',
    'Preparing',
    'Charging',
    'SuspendedEVSE',
    'SuspendedEV',
    'Finishing',
    'Reserved',
    'Unavailable',
    'Faulted',
  ];
  for (const status of statuses) {
    mustPass(
      validateCall('StatusNotification', { connectorId: 1, errorCode: 'NoError', status }),
      `status ${status}`,
    );
  }
  const errorCodes = [
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
  ];
  for (const errorCode of errorCodes) {
    mustPass(
      validateCall('StatusNotification', { connectorId: 1, errorCode, status: 'Available' }),
      `errorCode ${errorCode}`,
    );
  }
  // Case matters — OCPP enums are exact.
  assert.equal(
    mustFail(
      validateCall('StatusNotification', { connectorId: 1, errorCode: 'noerror', status: 'Available' }),
      'lowercase errorCode',
    ).code,
    'PropertyConstraintViolation',
  );
});

test('every StopTransaction reason is accepted and a made-up one is not', () => {
  for (const reason of [
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
  ]) {
    mustPass(
      validateCall('StopTransaction', { transactionId: 1, meterStop: 0, timestamp: TS, reason }),
      `reason ${reason}`,
    );
  }
  assert.equal(
    mustFail(
      validateCall('StopTransaction', {
        transactionId: 1,
        meterStop: 0,
        timestamp: TS,
        reason: 'Unplugged',
      }),
      'bogus reason',
    ).code,
    'PropertyConstraintViolation',
  );
});

// ---------------------------------------------------------------- structure

test('meterValue: "nope" where an array is required is a TypeConstraintViolation', () => {
  const f = mustFail(
    validateCall('MeterValues', { connectorId: 1, meterValue: 'nope' }),
    'string meterValue',
  );
  assert.equal(f.code, 'TypeConstraintViolation');
  assert.equal(f.details['field'], '/meterValue');
  assert.equal(f.details['expected'], 'array');
});

test('an empty meterValue array is an OccurrenceConstraintViolation', () => {
  // Cardinality on a present array is the one thing 1.6 frames purely as an
  // occurrence constraint, so that is the code it gets.
  const f = mustFail(
    validateCall('MeterValues', { connectorId: 1, meterValue: [] }),
    'empty meterValue',
  );
  assert.equal(f.code, 'OccurrenceConstraintViolation');
  assert.equal(f.details['rule'], 'minItems');
});

test('nested sampledValue errors report the full JSON pointer', () => {
  const f = mustFail(
    validateCall('MeterValues', {
      connectorId: 1,
      meterValue: [{ timestamp: TS, sampledValue: [{ value: '1', unit: 'Furlongs' }] }],
    }),
    'bad unit',
  );
  assert.equal(f.code, 'PropertyConstraintViolation');
  assert.equal(f.details['field'], '/meterValue/0/sampledValue/0/unit');
});

test('a negative connectorId is rejected but connectorId 0 is not', () => {
  // 0 addresses the charge point itself and is legal in 1.6.
  mustPass(
    validateCall('StatusNotification', { connectorId: 0, errorCode: 'NoError', status: 'Faulted' }),
    'connectorId 0',
  );
  const f = mustFail(
    validateCall('StatusNotification', { connectorId: -1, errorCode: 'NoError', status: 'Faulted' }),
    'negative connectorId',
  );
  assert.equal(f.code, 'PropertyConstraintViolation');
  assert.equal(f.details['rule'], 'minimum');
});

/**
 * OCPP 1.6 §7.4 types SampledValue.value as a *String* — the raw meter reading is
 * carried as text so SignedData blobs and fixed-precision decimals survive the
 * wire without float rounding. A numeric `value` is therefore a firmware bug, and
 * we name it rather than coerce it: adapter16 does `Number(s.value)`, which turns
 * a JSON number into a plausible-looking reading and hides the deviation forever.
 * (If a specific vendor needs an exemption, it belongs in the per-vendor quirks
 * layer, not in a schema that claims to be the spec.)
 */
test('MeterValues with a numeric sampledValue.value is tolerated and reported', () => {
  /**
   * OCPP 1.6 types sampledValue.value as String. Real chargers send a JSON
   * number, and rejecting the frame throws away billable energy — a worse
   * outcome than accepting a deviation we can see. adapter16 coerces with
   * Number(); the deviation is surfaced to the quirk registry so it can be
   * raised with the vendor instead of silently normalised away.
   */
  const payload = {
    connectorId: 1,
    meterValue: [{ timestamp: TS, sampledValue: [{ value: 12345.6 }] }],
  };
  assert.equal(validateCall('MeterValues', payload), null, 'a numeric value must not drop the frame');

  const outcome = validateCallDetailed('MeterValues', payload);
  assert.equal(outcome.tolerated.length, 1);
  assert.equal(outcome.tolerated[0]!.code, 'TypeConstraintViolation');
  assert.equal(outcome.tolerated[0]!.details['field'], '/meterValue/0/sampledValue/0/value');
  assert.equal(outcome.tolerated[0]!.details['expected'], 'string');

  // The string form of the same reading passes cleanly, with nothing reported.
  const clean = validateCallDetailed('MeterValues', {
    connectorId: 1,
    meterValue: [{ timestamp: TS, sampledValue: [{ value: '12345.6' }] }],
  });
  assert.equal(clean.failure, null);
  assert.equal(clean.tolerated.length, 0);
});


// ------------------------------------------------------------- timestamps

test('timestamp must be a real ISO 8601 instant with an offset', () => {
  for (const good of [
    '2026-08-23T04:15:00Z',
    '2026-08-23T11:15:00+07:00',
    '2026-08-23T04:15:00.123Z',
    '2024-02-29T00:00:00Z',
  ]) {
    assert.equal(isIsoDateTime(good), true, `${good} should be valid`);
    mustPass(
      validateCall('StartTransaction', tweak('StartTransaction', { timestamp: good })),
      `timestamp ${good}`,
    );
  }
  for (const bad of [
    '2026-08-23 04:15:00',
    '2026-08-23T04:15:00', // no offset: would silently shift WIB billing by 7h
    '23/08/2026 04:15',
    '2025-02-31T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-08-23T25:00:00Z',
    'now',
    '',
  ]) {
    assert.equal(isIsoDateTime(bad), false, `${bad} should be invalid`);
    const f = mustFail(
      validateCall('StartTransaction', tweak('StartTransaction', { timestamp: bad })),
      `timestamp ${bad}`,
    );
    assert.equal(f.code, 'PropertyConstraintViolation');
    assert.equal(f.details['rule'], 'format');
  }
});

// ------------------------------------------------------------- strictness

test('an unknown extra vendor property still passes', () => {
  // Real hardware ships vendor extensions inside standard messages. Rejecting
  // them would take a charger offline over a field we never read.
  mustPass(
    validateCall('BootNotification', {
      ...VALID['BootNotification'],
      chargePointFeature: 'ISO15118',
      autelExtras: { plugAndCharge: true, revision: 3 },
    }),
    'BootNotification with vendor extras',
  );
  mustPass(
    validateCall('StatusNotification', tweak('StatusNotification', { connectorType: 'Type2' })),
    'StatusNotification with vendor extras',
  );
  mustPass(
    validateCall('MeterValues', {
      connectorId: 1,
      meterValue: [
        { timestamp: TS, sampledValue: [{ value: '1', vendorScale: 10 }], vendorSeq: 4 },
      ],
    }),
    'MeterValues with vendor extras',
  );
});

// ------------------------------------------------------------- malformed

test('null, a string and an array as the whole payload are FormationViolation', () => {
  for (const bad of [null, 'StartTransaction', [1, 2, 3], 42, true] as const) {
    const f = mustFail(validateCall('StartTransaction', bad), `payload ${JSON.stringify(bad)}`);
    assert.equal(f.code, 'FormationViolation', `wrong code for ${JSON.stringify(bad)}`);
    assert.equal(f.details['field'], '/');
  }
  // undefined too — an absent payload slot in the CALL frame.
  assert.equal(validateCall('Heartbeat', undefined)?.code, 'FormationViolation');
});

test('an unknown action returns NotImplemented', () => {
  const f = mustFail(validateCall('Wibble', {}), 'unknown action');
  assert.equal(f.code, 'NotImplemented');
  assert.match(f.message, /Wibble/);
  // Outbound-only actions are not inbound actions.
  assert.equal(validateCall('RemoteStartTransaction', { idTag: 'A' })?.code, 'NotImplemented');
});

test('an action name from the wire cannot smuggle text into the error message', () => {
  const f = mustFail(validateCall('drop table charge_point;\n\n', {}), 'hostile action');
  assert.equal(f.code, 'NotImplemented');
  const label = String(f.details['action']);
  assert.doesNotMatch(label, /\s/, 'whitespace survived in the action label');
  assert.doesNotMatch(label, /;/);
  assert.doesNotMatch(f.message, /;|\n/);
  // A 300-character action name cannot be used to pad the wire message either.
  const long = mustFail(validateCall('X'.repeat(300), {}), 'long action');
  assert.ok(String(long.details['action']).length <= 64);
});

// ------------------------------------------------------ outbound responses

test('the responses adapter16 actually returns all validate', () => {
  mustPass(
    validateCallResult('BootNotification', {
      status: 'Accepted',
      currentTime: TS,
      interval: 300,
    }),
    'BootNotification.conf',
  );
  mustPass(validateCallResult('Heartbeat', { currentTime: TS }), 'Heartbeat.conf');
  mustPass(validateCallResult('StatusNotification', {}), 'StatusNotification.conf');
  mustPass(validateCallResult('MeterValues', {}), 'MeterValues.conf');
  mustPass(validateCallResult('Authorize', { idTagInfo: { status: 'Accepted' } }), 'Authorize.conf');
  mustPass(
    validateCallResult('StartTransaction', {
      transactionId: 1042,
      idTagInfo: { status: 'Accepted', expiryDate: TS, parentIdTag: 'FLEET-01' },
    }),
    'StartTransaction.conf',
  );
  mustPass(
    validateCallResult('StopTransaction', { idTagInfo: { status: 'Accepted' } }),
    'StopTransaction.conf',
  );
  mustPass(validateCallResult('StopTransaction', {}), 'StopTransaction.conf without idTagInfo');
  mustPass(validateCallResult('DataTransfer', { status: 'UnknownVendorId' }), 'DataTransfer.conf');
});

test('our own response bugs are caught before they reach the charger', () => {
  // A Heartbeat.conf without currentTime silently corrupts every downstream
  // billing timestamp — exactly the bug this net exists for.
  assert.equal(validateCallResult('Heartbeat', {})?.code, 'ProtocolError');
  // Typo'd field name: caught because responses are additionalProperties: false.
  const typo = mustFail(validateCallResult('Heartbeat', { curentTime: TS }), 'typo Heartbeat.conf');
  assert.equal(typo.code, 'ProtocolError'); // required fires before the extra key
  const extra = mustFail(
    validateCallResult('Heartbeat', { currentTime: TS, curentTime: TS }),
    'extra key',
  );
  assert.equal(extra.code, 'PropertyConstraintViolation');
  assert.equal(extra.details['rule'], 'additionalProperties');

  assert.equal(
    validateCallResult('BootNotification', { status: 'Maybe', currentTime: TS, interval: 300 })?.code,
    'PropertyConstraintViolation',
  );
  assert.equal(
    validateCallResult('StartTransaction', {
      transactionId: '1042',
      idTagInfo: { status: 'Accepted' },
    })?.code,
    'TypeConstraintViolation',
  );
  assert.equal(
    validateCallResult('Authorize', { idTagInfo: { status: 'Yes' } })?.code,
    'PropertyConstraintViolation',
  );
  assert.equal(
    validateCallResult('DataTransfer', { status: 'Nope' })?.code,
    'PropertyConstraintViolation',
  );
  assert.equal(validateCallResult('Heartbeat', null)?.code, 'FormationViolation');
});

test('validateCallResult stays quiet for actions with no response schema', () => {
  // A safety net over our outbound frames, not a gate: an action whose .conf
  // schema has not been written yet must not start failing.
  assert.equal(validateCallResult('SomeFutureAction', { anything: true }), null);
});
