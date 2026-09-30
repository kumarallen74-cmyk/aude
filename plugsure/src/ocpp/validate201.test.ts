import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  INBOUND_ACTIONS_201,
  isKnownAction,
  validateCall,
  validateCallDetailed,
  validateCallResult,
} from './validate.js';

/**
 * OCPP 2.0.1 validation + VERSION SCOPING.
 *
 * The isolation guarantee this suite defends: 1.6 and 2.0.1 share action names
 * but not payloads, so the validator MUST select the schema set by the negotiated
 * version — and every function defaults to 1.6, so a caller that omits the version
 * gets exactly the pre-2.0.1 behaviour. If any of that regresses, the live 1.6
 * fleet is at risk, so these are the tests that protect it.
 */

const TS = '2026-09-07T10:00:00+07:00';

const startedEvent = {
  eventType: 'Started',
  timestamp: TS,
  triggerReason: 'Authorized',
  seqNo: 0,
  transactionInfo: { transactionId: 'tx-abc-123', chargingState: 'Charging' },
  evse: { id: 1, connectorId: 1 },
  idToken: { idToken: '04A1B2C3', type: 'ISO14443' },
  meterValue: [
    { timestamp: TS, sampledValue: [{ value: 0, measurand: 'Energy.Active.Import.Register', unitOfMeasure: { unit: 'Wh' } }] },
  ],
};

describe('2.0.1 version scoping', () => {
  test('the 2.0.1 inbound action set is exactly the implemented core subset', () => {
    assert.deepEqual(
      [...INBOUND_ACTIONS_201].sort(),
      [
        'Authorize', 'BootNotification',
        // smart charging and ISO 15118 charging needs (services/v2x.ts): ClearedChargingLimit,
        // NotifyChargingLimit, NotifyEVChargingNeeds, NotifyEVChargingSchedule, ReportChargingProfiles
        'ClearedChargingLimit',
        'DataTransfer', 'FirmwareStatusNotification',
        // ISO 15118 Plug & Charge (pnc/service.ts)
        'Get15118EVCertificate', 'GetCertificateStatus',
        'Heartbeat', 'LogStatusNotification', 'MeterValues',
        'NotifyChargingLimit', 'NotifyEVChargingNeeds', 'NotifyEVChargingSchedule',
        'NotifyEvent',
        // device model (services/device-model.ts)
        'NotifyMonitoringReport', 'NotifyReport',
        'ReportChargingProfiles',
        'ReservationStatusUpdate', 'SecurityEventNotification', 'SignCertificate', 'StatusNotification',
        'TransactionEvent',
      ],
    );
  });

  test('TransactionEvent is known ONLY on 2.0.1', () => {
    assert.equal(isKnownAction('TransactionEvent', 'ocpp2.0.1'), true);
    assert.equal(isKnownAction('TransactionEvent', 'ocpp1.6'), false);
    assert.equal(isKnownAction('TransactionEvent'), false, 'default (1.6) must not know it');
  });

  test('1.6-only actions are NOT known on 2.0.1', () => {
    for (const a of ['StartTransaction', 'StopTransaction', 'DiagnosticsStatusNotification']) {
      assert.equal(isKnownAction(a, 'ocpp1.6'), true, `${a} on 1.6`);
      assert.equal(isKnownAction(a, 'ocpp2.0.1'), false, `${a} on 2.0.1`);
    }
  });

  test('MeterValues exists in both versions, each with its OWN shape', () => {
    const mv201 = { evseId: 1, meterValue: [{ timestamp: TS, sampledValue: [{ value: 1200 }] }] };
    const mv16 = { connectorId: 1, meterValue: [{ timestamp: TS, sampledValue: [{ value: '1200' }] }] };
    assert.equal(validateCall('MeterValues', mv201, 'ocpp2.0.1'), null);
    assert.notEqual(validateCall('MeterValues', mv16, 'ocpp2.0.1'), null, '1.6 shape (no evseId) rejected on 2.0.1');
    assert.equal(validateCall('MeterValues', mv16, 'ocpp1.6'), null);
  });

  test('ReservationStatusUpdate and NotifyEvent are accepted on 2.0.1 only', () => {
    assert.equal(validateCall('ReservationStatusUpdate', { reservationId: 7, reservationUpdateStatus: 'Expired' }, 'ocpp2.0.1'), null);
    assert.notEqual(validateCall('ReservationStatusUpdate', { reservationId: 7, reservationUpdateStatus: 'Gone' }, 'ocpp2.0.1'), null);
    assert.equal(isKnownAction('NotifyEvent', 'ocpp1.6'), false);
    const ev = {
      generatedAt: TS, seqNo: 0,
      eventData: [{ eventId: 1, timestamp: TS, trigger: 'Alerting', actualValue: '85', eventNotificationType: 'HardWiredMonitor', component: { name: 'EVSE' }, variable: { name: 'Temperature' } }],
    };
    assert.equal(validateCall('NotifyEvent', ev, 'ocpp2.0.1'), null);
  });

  test('ocpp2.1 resolves to the 2.0.1 schema set', () => {
    assert.equal(isKnownAction('TransactionEvent', 'ocpp2.1'), true);
  });
});

describe('2.0.1 request validation', () => {
  test('a valid TransactionEvent(Started) passes', () => {
    assert.equal(validateCallDetailed('TransactionEvent', startedEvent, 'ocpp2.0.1').failure, null);
  });

  test('missing transactionInfo is rejected', () => {
    const bad: any = { ...startedEvent };
    delete bad.transactionInfo;
    assert.notEqual(validateCallDetailed('TransactionEvent', bad, 'ocpp2.0.1').failure, null);
  });

  test('an out-of-enum eventType is rejected', () => {
    const bad = { ...startedEvent, eventType: 'Begun' };
    assert.notEqual(validateCall('TransactionEvent', bad, 'ocpp2.0.1'), null);
  });

  test('valid 2.0.1 BootNotification (nested chargingStation) passes', () => {
    const boot = { reason: 'PowerUp', chargingStation: { model: 'DC Compact', vendorName: 'Autel' } };
    assert.equal(validateCall('BootNotification', boot, 'ocpp2.0.1'), null);
  });

  test('a 1.6-shaped BootNotification is rejected under 2.0.1', () => {
    const boot16 = { chargePointVendor: 'Autel', chargePointModel: 'DC Compact' };
    assert.notEqual(validateCall('BootNotification', boot16, 'ocpp2.0.1'), null);
  });

  test('valid 2.0.1 StatusNotification passes; a 1.6-shaped one is rejected', () => {
    const sn201 = { timestamp: TS, connectorStatus: 'Occupied', evseId: 1, connectorId: 1 };
    assert.equal(validateCall('StatusNotification', sn201, 'ocpp2.0.1'), null);
    const sn16 = { connectorId: 1, errorCode: 'NoError', status: 'Charging' };
    assert.notEqual(validateCall('StatusNotification', sn16, 'ocpp2.0.1'), null);
  });

  test('Authorize requires the nested idToken object', () => {
    assert.equal(validateCall('Authorize', { idToken: { idToken: 'X', type: 'ISO14443' } }, 'ocpp2.0.1'), null);
    assert.notEqual(validateCall('Authorize', { idTag: 'X' }, 'ocpp2.0.1'), null);
  });
});

describe('2.0.1 response validation (our .conf shapes)', () => {
  test('a well-formed BootNotification response passes', () => {
    assert.equal(
      validateCallResult('BootNotification', { currentTime: TS, interval: 300, status: 'Accepted' }, 'ocpp2.0.1'),
      null,
    );
  });

  test('a stray field in our own response is caught (additionalProperties:false)', () => {
    assert.notEqual(
      validateCallResult('BootNotification', { currentTime: TS, interval: 300, status: 'Accepted', typo: 1 }, 'ocpp2.0.1'),
      null,
    );
  });

  test('empty {} is a valid TransactionEvent response', () => {
    assert.equal(validateCallResult('TransactionEvent', {}, 'ocpp2.0.1'), null);
  });
});

describe('1.6 path is unaffected by the 2.0.1 additions', () => {
  test('a valid 1.6 BootNotification still passes on the default (1.6) path', () => {
    const boot16 = { chargePointVendor: 'Autel', chargePointModel: 'MaxiCharger', firmwareVersion: '1.2.3' };
    assert.equal(validateCall('BootNotification', boot16), null);
    assert.equal(validateCall('BootNotification', boot16, 'ocpp1.6'), null);
  });

  test('a 2.0.1-shaped BootNotification is rejected on the 1.6 path', () => {
    const boot201 = { reason: 'PowerUp', chargingStation: { model: 'X', vendorName: 'Y' } };
    assert.notEqual(validateCall('BootNotification', boot201), null);
  });
});

describe('2.0.1 informational fields are tolerated like their 1.6 counterparts', () => {
  test('a 21+ character chargingStation.model is recorded, not refused', () => {
    const boot = { reason: 'PowerUp', chargingStation: { model: 'MaxiCharger AC Wallbox', vendorName: 'Autel' } };
    const r = validateCallDetailed('BootNotification', boot, 'ocpp2.0.1');
    assert.equal(r.failure, null, 'the unit must be allowed to boot');
    assert.equal(r.tolerated.length, 1);
  });
});