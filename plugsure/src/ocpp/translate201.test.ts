import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { translate201 } from './translate201.js';
import { to201Variable, from201Variable, validateConfigValue, catalogEntry } from './config-catalog.js';

/**
 * Outbound 1.6 -> 2.0.1 command translation. Before v1.3 every console command
 * reached a 2.0.1 station with its 1.6 name and payload and was refused.
 */

describe('translate201 — action names and payloads', () => {
  test('RemoteStartTransaction -> RequestStartTransaction with idToken and evseId', () => {
    const w = translate201('RemoteStartTransaction', { connectorId: 2, idTag: 'ABC123' });
    assert.equal(w.action, 'RequestStartTransaction');
    const p = w.payload as any;
    assert.deepEqual(p.idToken, { idToken: 'ABC123', type: 'Central' });
    assert.equal(p.evseId, 2);
    assert.ok(Number.isInteger(p.remoteStartId) && p.remoteStartId > 0);
  });

  test('RemoteStopTransaction -> RequestStopTransaction with a STRING transaction id', () => {
    const w = translate201('RemoteStopTransaction', { transactionId: 'b7f1-11' });
    assert.equal(w.action, 'RequestStopTransaction');
    assert.deepEqual(w.payload, { transactionId: 'b7f1-11' });
  });

  test('Reset Hard -> Immediate, Soft -> OnIdle; Scheduled maps back to Accepted', () => {
    assert.deepEqual(translate201('Reset', { type: 'Hard' }).payload, { type: 'Immediate' });
    const soft = translate201('Reset', { type: 'Soft' });
    assert.deepEqual(soft.payload, { type: 'OnIdle' });
    assert.deepEqual(soft.mapResult({ status: 'Scheduled' }), { status: 'Accepted' });
  });

  test('UnlockConnector addresses (evseId, connectorId 1)', () => {
    assert.deepEqual(translate201('UnlockConnector', { connectorId: 3 }).payload, { evseId: 3, connectorId: 1 });
  });

  test('ChangeAvailability: connector 0 = whole station (no evse)', () => {
    assert.deepEqual(translate201('ChangeAvailability', { connectorId: 0, type: 'Inoperative' }).payload, { operationalStatus: 'Inoperative' });
    assert.deepEqual(translate201('ChangeAvailability', { connectorId: 2, type: 'Operative' }).payload, {
      operationalStatus: 'Operative',
      evse: { id: 2 },
    });
  });

  test('TriggerMessage DiagnosticsStatusNotification -> LogStatusNotification', () => {
    const p = translate201('TriggerMessage', { requestedMessage: 'DiagnosticsStatusNotification' }).payload as any;
    assert.equal(p.requestedMessage, 'LogStatusNotification');
  });

  test('GetConfiguration -> GetVariables and back to the 1.6 result shape', () => {
    const w = translate201('GetConfiguration', { key: ['HeartbeatInterval', 'NoSuchKey'] });
    assert.equal(w.action, 'GetVariables');
    assert.deepEqual((w.payload as any).getVariableData, [
      { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'HeartbeatInterval' } },
    ]);
    const r = w.mapResult({
      getVariableResult: [
        { attributeStatus: 'Accepted', attributeValue: '300', component: { name: 'OCPPCommCtrlr' }, variable: { name: 'HeartbeatInterval' } },
      ],
    });
    assert.deepEqual(r.configurationKey, [{ key: 'HeartbeatInterval', value: '300', readonly: false }]);
    assert.deepEqual(r.unknownKey, ['NoSuchKey']);
  });

  test('ChangeConfiguration -> SetVariables; RebootRequired survives; unmapped key is NotSupported', () => {
    const w = translate201('ChangeConfiguration', { key: 'HeartbeatInterval', value: '120' });
    assert.equal(w.action, 'SetVariables');
    assert.deepEqual(w.mapResult({ setVariableResult: [{ attributeStatus: 'RebootRequired' }] }), { status: 'RebootRequired' });
    const none = translate201('ChangeConfiguration', { key: 'Nope', value: '1' });
    assert.deepEqual(none.mapResult({}), { status: 'NotSupported' });
  });

  test('UpdateFirmware and GetDiagnostics carry a requestId and nest the location', () => {
    const fw = translate201('UpdateFirmware', { location: 'https://x/fw.bin', retrieveDate: '2026-09-26T00:00:00Z', requestId: 7 }).payload as any;
    assert.equal(fw.requestId, 7);
    assert.deepEqual(fw.firmware, { location: 'https://x/fw.bin', retrieveDateTime: '2026-09-26T00:00:00Z' });
    const log = translate201('GetDiagnostics', { location: 'https://x/diag', requestId: 9 });
    assert.equal(log.action, 'GetLog');
    assert.equal((log.payload as any).log.remoteLocation, 'https://x/diag');
    assert.deepEqual(log.mapResult({ status: 'Accepted', filename: 'a.log' }), { fileName: 'a.log', status: 'Accepted' });
  });

  test('SendLocalList maps idTags to idTokens and version numbers', () => {
    const p = translate201('SendLocalList', {
      listVersion: 4,
      updateType: 'Full',
      localAuthorizationList: [{ idTag: 'A1', idTagInfo: { status: 'Blocked' } }],
    }).payload as any;
    assert.equal(p.versionNumber, 4);
    assert.deepEqual(p.localAuthorizationList[0], { idToken: { idToken: 'A1', type: 'ISO14443' }, idTokenInfo: { status: 'Blocked' } });
  });

  test('ChargePointMaxProfile is renamed for 2.0.1', () => {
    const p = translate201('SetChargingProfile', {
      connectorId: 0,
      csChargingProfiles: {
        chargingProfileId: 1, stackLevel: 0, chargingProfilePurpose: 'ChargePointMaxProfile',
        chargingSchedule: { chargingRateUnit: 'W', chargingSchedulePeriod: [{ startPeriod: 0, limit: 0 }] },
      },
    }).payload as any;
    assert.equal(p.chargingProfile.chargingProfilePurpose, 'ChargingStationMaxProfile');
  });

  test('unknown actions pass through unchanged', () => {
    const w = translate201('DataTransfer', { vendorId: 'x' });
    assert.equal(w.action, 'DataTransfer');
    assert.deepEqual(w.payload, { vendorId: 'x' });
  });
});

describe('configuration catalog', () => {
  test('1.6 key <-> 2.0.1 variable round trip', () => {
    const v = to201Variable('MeterValueSampleInterval');
    assert.deepEqual(v, { component: 'SampledDataCtrlr', variable: 'TxUpdatedInterval' });
    assert.equal(from201Variable(v!.component, v!.variable), 'MeterValueSampleInterval');
    assert.deepEqual(to201Variable('Custom.Thing'), { component: 'Custom', variable: 'Thing' });
    assert.equal(from201Variable('Custom', 'Thing'), 'Custom.Thing');
  });

  test('value validation by declared type', () => {
    assert.equal(validateConfigValue('HeartbeatInterval', '300'), null);
    assert.ok(validateConfigValue('HeartbeatInterval', 'five'));
    assert.ok(validateConfigValue('LocalAuthListEnabled', 'yes'));
    assert.equal(validateConfigValue('LocalAuthListEnabled', 'TRUE'), null);
    assert.ok(validateConfigValue('AuthorizationKey', 'abc'), 'write-only key is refused');
    assert.equal(validateConfigValue('VendorThing', 'anything'), null, 'unknown vendor keys are passed to the charger');
  });

  test('every managed key is documented', () => {
    for (const k of ['HeartbeatInterval', 'MeterValuesSampledData', 'LocalAuthListEnabled', 'StopTransactionOnInvalidId']) {
      assert.ok(catalogEntry(k)?.managed, k);
    }
  });
});
