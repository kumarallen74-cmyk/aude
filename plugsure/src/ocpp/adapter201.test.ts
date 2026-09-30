import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  toCanonicalTransactionEvent201,
  toCanonicalMeterValues201,
  TRIGGER_MAP_201,
  STATUS_MAP_201,
} from './adapter201.js';
import { energyWhFrom } from '../domain/canonical.js';
import type { AdapterContext } from './adapter16.js';

/**
 * OCPP 2.0.1 -> canonical MAPPING (pure; no DB).
 *
 * These cover the crux of the adapter — turning a 2.0.1 TransactionEventRequest
 * into the canonical event the rating/console/webhook layers consume — without
 * touching the database, so they run anywhere the rest of the pure suite runs.
 */

const ctx: AdapterContext = {
  ocppIdentity: 'AUTEL-DC60-SMB-002',
  chargePointId: '11111111-1111-1111-1111-111111111111',
  orgId: '22222222-2222-2222-2222-222222222222',
};
const TS = '2026-09-07T10:00:00+07:00';

function ev(overrides: Record<string, unknown> = {}) {
  return {
    eventType: 'Started',
    timestamp: TS,
    triggerReason: 'Authorized',
    seqNo: 0,
    transactionInfo: { transactionId: 'tx-abc-123', chargingState: 'Charging' },
    evse: { id: 2, connectorId: 1 },
    idToken: { idToken: '04A1B2C3', type: 'ISO14443' },
    meterValue: [
      { timestamp: TS, sampledValue: [{ value: 1500, measurand: 'Energy.Active.Import.Register', unitOfMeasure: { unit: 'Wh' } }] },
    ],
    ...overrides,
  };
}

describe('meter value reshaping (unitOfMeasure.unit -> flat unit)', () => {
  test('unit is lifted out of unitOfMeasure and value coerced to number', () => {
    const mv = toCanonicalMeterValues201([
      { timestamp: TS, sampledValue: [{ value: 2, measurand: 'Energy.Active.Import.Register', unitOfMeasure: { unit: 'kWh' } }] },
    ]);
    assert.equal(mv[0]!.sampledValue[0]!.unit, 'kWh');
    assert.equal(mv[0]!.sampledValue[0]!.value, 2);
    // canonical energy extraction understands kWh -> Wh, proving the shape is right
    assert.equal(energyWhFrom(mv), 2000);
  });

  test('missing measurand defaults to the energy register; empty input is empty', () => {
    const mv = toCanonicalMeterValues201([{ timestamp: TS, sampledValue: [{ value: 42 }] }]);
    assert.equal(mv[0]!.sampledValue[0]!.measurand, 'Energy.Active.Import.Register');
    assert.deepEqual(toCanonicalMeterValues201([]), []);
  });
});

describe('TransactionEvent mapping', () => {
  test('Started maps field-for-field into the canonical shape', () => {
    const c = toCanonicalTransactionEvent201(ctx, ev());
    assert.equal(c.eventType, 'Started');
    assert.equal(c.transactionId, 'tx-abc-123');
    assert.equal(c.triggerReason, 'Authorized');
    assert.equal(c.chargingState, 'Charging');
    assert.equal(c.evse.evseId, 2);
    assert.equal(c.evse.connectorId, 1);
    assert.equal(c.evse.chargePointId, ctx.chargePointId);
    assert.equal(c.idToken?.idToken, '04A1B2C3');
    assert.equal(energyWhFrom(c.meterValue), 1500);
  });

  test('Started produces a deterministic idemKey from charger facts (retry-safe)', () => {
    const a = toCanonicalTransactionEvent201(ctx, ev());
    const b = toCanonicalTransactionEvent201(ctx, ev()); // identical retry
    assert.ok(a.idemKey.length > 0);
    assert.equal(a.idemKey, b.idemKey, 'a retried Started must yield the SAME key');
  });

  test('Updated/Ended carry no idemKey (matches the 1.6 adapter)', () => {
    assert.equal(toCanonicalTransactionEvent201(ctx, ev({ eventType: 'Updated', triggerReason: 'MeterValuePeriodic' })).idemKey, '');
    assert.equal(toCanonicalTransactionEvent201(ctx, ev({ eventType: 'Ended', triggerReason: 'RemoteStop' })).idemKey, '');
  });

  test('Ended flags meterStopAbsent only when no energy register is present', () => {
    const withEnergy = toCanonicalTransactionEvent201(ctx, ev({ eventType: 'Ended', triggerReason: 'RemoteStop' }));
    assert.equal(withEnergy.meterStopAbsent, false);
    const noMeter = toCanonicalTransactionEvent201(ctx, ev({ eventType: 'Ended', triggerReason: 'RemoteStop', meterValue: [] }));
    assert.equal(noMeter.meterStopAbsent, true);
  });

  test('an unknown triggerReason degrades to Other rather than throwing', () => {
    const c = toCanonicalTransactionEvent201(ctx, ev({ triggerReason: 'SomeVendorReason' }));
    assert.equal(c.triggerReason, 'Other');
  });

  test('a frame with no idToken omits it', () => {
    const c = toCanonicalTransactionEvent201(ctx, ev({ eventType: 'Updated', triggerReason: 'MeterValuePeriodic', idToken: undefined }));
    assert.equal(c.idToken, undefined);
  });
});

describe('enum maps', () => {
  test('2.0.1 EVDeparted maps to canonical EVDisconnected', () => {
    assert.equal(TRIGGER_MAP_201.EVDeparted, 'EVDisconnected');
  });

  test('2.0.1 connector status maps onto the canonical vocabulary', () => {
    assert.equal(STATUS_MAP_201.Available, 'Available');
    assert.equal(STATUS_MAP_201.Occupied, 'Charging');
    assert.equal(STATUS_MAP_201.Faulted, 'Faulted');
  });
});
