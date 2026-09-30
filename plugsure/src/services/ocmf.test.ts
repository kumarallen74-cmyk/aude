import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  buildOcmf, parseOcmf, verifyOcmf, normaliseMeterKey, registerOf, readingWh, formatOcmfTime, parseOcmfTime, ocmfText, keyFromOcpp,
  type OcmfPayload,
} from './ocmf.js';
import { checkSigned } from './signed-metering.js';
import { energyWhFrom } from '../domain/canonical.js';
import { toCanonicalMeterValues } from '../ocpp/adapter16.js';
import { toCanonicalMeterValues201 } from '../ocpp/adapter201.js';
import { Ocpp2Shim } from '../sandbox/ocpp2-shim.js';

const meter = () => {
  const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey: k.privateKey, hex: (k.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('hex'), publicKey: k.publicKey };
};
const payload = (tx: 'B' | 'E', kwh: number): OcmfPayload => ({
  FV: '1.0', GI: 'TEST', GS: 'CP1', GV: '1.0', PG: 'T1', MV: 'Meter Co', MM: 'M1', MS: 'MTR-001', MF: '1.0', IS: true, IT: 'ISO14443', ID: 'CARD1',
  RD: [{ TM: '2026-09-28T17:30:04,000+0700 S', TX: tx, RV: kwh, RI: '1-b:1.8.0', RU: 'kWh', RT: 'DC', EF: '', ST: 'G' }],
});

test('OCMF: a meter-signed payload verifies with the meter key; any change, or another key, fails', () => {
  const m = meter();
  const text = buildOcmf(payload('B', 12.345), m.privateKey);
  const p = parseOcmf(text);
  assert.ok(typeof p !== 'string');
  assert.deepEqual(verifyOcmf(p, m.publicKey), { ok: true });
  assert.equal(p.payload.RD[0]!.RV, 12.345);
  // One digit changed in the reading: the signature no longer holds.
  const tampered = parseOcmf(text.replace('12.345', '12.346'));
  assert.ok(typeof tampered !== 'string');
  assert.equal(verifyOcmf(tampered, m.publicKey).ok, false);
  assert.equal(verifyOcmf(p, meter().publicKey).ok, false, 'another meter\'s key');
  assert.match(parseOcmf('OCMF|{bad json|{"SD":"00"}') as string, /payload/);
  assert.match(parseOcmf('XYZ|{}|{}') as string, /OCMF/);
});

test('meter keys: hex DER, a raw P-256 point, base64 DER and PEM are all the same key', () => {
  const m = meter();
  const der = Buffer.from(m.hex, 'hex');
  const point = der.subarray(der.length - 65).toString('hex');
  const forms = [m.hex, m.hex.toUpperCase(), point, point.slice(2), der.toString('base64'), m.publicKey.export({ type: 'spki', format: 'pem' }) as string];
  for (const f of forms) {
    const k = normaliseMeterKey(f);
    assert.ok(typeof k !== 'string', `form ${f.slice(0, 20)}…`);
    assert.equal(k.hex, m.hex);
  }
  assert.equal(typeof normaliseMeterKey('not a key!'), 'string');
  // OCPP 2.0.1 sends base64 of the printed key.
  assert.equal(keyFromOcpp(Buffer.from(m.hex).toString('base64')), m.hex);
  assert.equal(keyFromOcpp(m.hex), m.hex);
  assert.equal(keyFromOcpp(''), null);
});

test('readings: OBIS registers, units, OCMF time, base64-wrapped data', () => {
  assert.equal(registerOf('1-b:1.8.0'), 'import');
  assert.equal(registerOf('01-00:01.08.00*FF'), 'import');
  assert.equal(registerOf('1-b:2.8.0'), 'export');
  assert.equal(registerOf(undefined), 'import');
  assert.equal(registerOf('1-b:32.7.0'), 'other');
  assert.equal(readingWh({ TM: 'x', RV: 12.345, RU: 'kWh' }), 12345);
  assert.equal(readingWh({ TM: 'x', RV: 500, RU: 'Wh' }), 500);
  assert.equal(readingWh({ TM: 'x', RV: 1, RU: 'mOhm' }), null);
  const t = new Date('2026-09-28T10:30:04.250Z');
  const s = formatOcmfTime(t);
  assert.equal(s, '2026-09-28T17:30:04,250+0700 S');
  assert.equal(parseOcmfTime(s)?.toISOString(), t.toISOString());
  const text = buildOcmf(payload('E', 1), meter().privateKey);
  assert.equal(ocmfText(Buffer.from(text).toString('base64')), text);
  assert.equal(ocmfText('hello'), null);
});

test('checking: the registered key wins; a charger-sent key that differs is invalid; no key at all is no_key', () => {
  const m = meter();
  const other = meter();
  const data = buildOcmf(payload('B', 10), m.privateKey);
  assert.equal(checkSigned(data, { registeredKey: m.hex }).status, 'valid');
  assert.equal(checkSigned(data, { registeredKey: m.hex }).keySource, 'registered');
  assert.equal(checkSigned(data, { registeredKey: other.hex }).status, 'invalid');
  assert.match(String(checkSigned(data, { registeredKey: m.hex, chargerKey: other.hex }).detail), /different meter key/);
  const byCharger = checkSigned(data, { chargerKey: Buffer.from(m.hex).toString('base64') });
  assert.equal(byCharger.status, 'valid');
  assert.equal(byCharger.keySource, 'charger');
  assert.equal(checkSigned(data, {}).status, 'no_key');
  assert.equal(checkSigned('garbage', {}).status, 'unreadable');
  assert.equal(checkSigned(data, { encoding: 'EDL', registeredKey: m.hex }).status, 'unsupported');
});

test('adapters: a 1.6 SignedData sample is kept as signed data and never read as a register (it used to become NaN)', () => {
  const data = buildOcmf(payload('E', 12.5), meter().privateKey);
  const mv = toCanonicalMeterValues([{ timestamp: '2026-09-28T10:00:00Z', sampledValue: [
    { value: data, format: 'SignedData', context: 'Transaction.End' },
    { value: '12500', measurand: 'Energy.Active.Import.Register', unit: 'Wh', context: 'Transaction.End' },
  ] }]);
  assert.equal(mv[0]!.sampledValue[0]!.signed?.data, data);
  assert.equal(energyWhFrom(mv), 12500, 'the plain register, not NaN');
  const onlySigned = toCanonicalMeterValues([{ timestamp: '2026-09-28T10:00:00Z', sampledValue: [{ value: data, format: 'SignedData' }] }]);
  assert.equal(energyWhFrom(onlySigned), null, 'no register at all, so meterStop is used');
  const v201 = toCanonicalMeterValues201([{ timestamp: '2026-09-28T10:00:00Z', sampledValue: [{ value: 12500, measurand: 'Energy.Active.Import.Register', unitOfMeasure: { unit: 'Wh' },
    signedMeterValue: { signedMeterData: Buffer.from(data).toString('base64'), signingMethod: '', encodingMethod: 'OCMF', publicKey: 'abc' } }] }]);
  assert.equal(v201[0]!.sampledValue[0]!.value, 12500);
  assert.equal(v201[0]!.sampledValue[0]!.signed?.encoding, 'OCMF');
});

test('sandbox OCPP 2.x: 1.6 messages become TransactionEvents with the station\'s own id and a sequence; commands map back', () => {
  const sent: unknown[] = [];
  const shim = new Ocpp2Shim('ocpp2.1', {
    identity: 'SBX-1', vendor: 'V', model: 'M', firmware: '1', discharging: () => true,
    send: async (a, p) => { sent.push([a, p]); return {}; }, setBidirectionalAllowed: () => {},
  }, true);
  const start = shim.out('StartTransaction', { connectorId: 2, idTag: 'CARD1', meterStart: 1000, timestamp: '2026-09-28T10:00:00Z' });
  const ev = start.payload as any;
  assert.equal(start.action, 'TransactionEvent');
  assert.equal(ev.eventType, 'Started');
  assert.equal(ev.seqNo, 0);
  assert.equal(ev.evse.id, 2);
  assert.match(ev.transactionInfo.transactionId, /^SBX-1-1-/);
  const handle = start.map({ idTokenInfo: { status: 'Accepted' } }).transactionId;
  const upd = shim.out('MeterValues', { connectorId: 2, transactionId: handle, meterValue: [{ timestamp: 't', sampledValue: [{ value: 1500, measurand: 'Energy.Active.Import.Register', unit: 'Wh' }] }] }).payload as any;
  assert.equal(upd.eventType, 'Updated');
  assert.equal(upd.seqNo, 1);
  assert.equal(upd.transactionInfo.transactionId, ev.transactionInfo.transactionId);
  assert.equal(upd.transactionInfo.operationMode, 'CentralSetpoint', '2.1 reports the operation mode');
  assert.deepEqual(upd.meterValue[0].sampledValue[0], { value: 1500, measurand: 'Energy.Active.Import.Register', unitOfMeasure: { unit: 'Wh' } });
  const stop = shim.in('RequestStopTransaction', { transactionId: ev.transactionInfo.transactionId });
  assert.deepEqual(stop.payload, { transactionId: handle });
  const sp = shim.in('SetChargingProfile', { evseId: 2, chargingProfile: { id: 5002, stackLevel: 5, chargingProfilePurpose: 'TxProfile', chargingProfileKind: 'Absolute', chargingSchedule: [{ id: 1, chargingRateUnit: 'W', chargingSchedulePeriod: [{ startPeriod: 0, setpoint: -7000 }] }] } });
  assert.equal((sp.payload as any).csChargingProfiles.chargingSchedule.chargingSchedulePeriod[0].setpoint, -7000);
  const set = shim.in('SetVariables', { setVariableData: [{ component: { name: 'SampledDataCtrlr' }, variable: { name: 'SignReadings' }, attributeValue: 'false' }, { component: { name: 'Nope' }, variable: { name: 'X' }, attributeValue: '1' }] });
  const r = set.direct!() as any;
  assert.deepEqual(r.setVariableResult.map((x: any) => x.attributeStatus), ['Accepted', 'UnknownComponent']);
  assert.equal(shim.variable('SampledDataCtrlr.SignReadings'), 'false');
  // A signed 1.6 sample becomes a 2.x signedMeterValue (base64 OCMF) beside its reading.
  const signed = shim.out('StopTransaction', { transactionId: handle, meterStop: 2000, timestamp: 't2', reason: 'EVDisconnected',
    transactionData: [{ timestamp: 't2', sampledValue: [{ value: 'OCMF|{}|{"SD":"00"}', format: 'SignedData', context: 'Transaction.End', _wh: 2000, _publicKeyHex: 'ab' }] }] }).payload as any;
  assert.equal(signed.eventType, 'Ended');
  assert.equal(signed.triggerReason, 'EVDeparted');
  const sv = signed.meterValue[0].sampledValue[0];
  assert.equal(sv.value, 2000);
  assert.equal(Buffer.from(sv.signedMeterValue.signedMeterData, 'base64').toString(), 'OCMF|{}|{"SD":"00"}');
  assert.equal(sv.signedMeterValue.encodingMethod, 'OCMF');
});
