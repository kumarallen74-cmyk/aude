import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChargingNeeds, parseWindows, inWindow, localMinutes, planDischarge, creditMinor, MIN_DISCHARGE_W, type Candidate, type SiteV2x } from './v2x.js';
import { energyWhFrom, socFrom, EXPORT_MEASURAND } from '../domain/canonical.js';
import { validateCallDetailed, isKnownAction } from '../ocpp/validate.js';
import { REQUEST_SCHEMAS_21, widen } from '../ocpp/schemas21.js';
import { REQUEST_SCHEMAS_201 } from '../ocpp/schemas201.js';

const needs21 = {
  evseId: 1,
  timestamp: '2026-09-28T10:00:00Z',
  chargingNeeds: {
    requestedEnergyTransfer: 'DC_BPT',
    availableEnergyTransfer: ['DC', 'DC_BPT'],
    controlMode: 'DynamicControl',
    departureTime: '2026-09-28T17:00:00Z',
    dcChargingParameters: { evMaxCurrent: 200, evMaxVoltage: 450, evEnergyCapacity: 77000, stateOfCharge: 80, energyAmount: 20000 },
    v2xChargingParameters: { maxChargePower: 50000, maxDischargePower: -11000, targetSoC: 90, evMinV2XEnergyRequest: -5000 },
  },
};

test('charging needs: an ISO 15118-20 car offering bidirectional DC is read into one record', () => {
  const n = parseChargingNeeds(needs21);
  assert.equal(n.requestedTransfer, 'DC_BPT');
  assert.deepEqual(n.availableTransfer, ['DC', 'DC_BPT']);
  assert.equal(n.bidirectional, true);
  assert.equal(n.controlMode, 'DynamicControl');
  assert.equal(n.departureTime?.toISOString(), '2026-09-28T17:00:00.000Z');
  assert.equal(n.socPercent, 80);
  assert.equal(n.targetSocPercent, 90);
  assert.equal(n.evCapacityWh, 77000);
  assert.equal(n.energyRequestWh, 20000);
  assert.equal(n.maxChargePowerW, 50000);
  assert.equal(n.maxDischargePowerW, 11000, 'a negative discharge figure counts by its size');
  // A 2.0.1 AC car: one mode, nothing bidirectional.
  const ac = parseChargingNeeds({ evseId: 1, chargingNeeds: { requestedEnergyTransfer: 'AC_three_phase', acChargingParameters: { energyAmount: 15000, evMinCurrent: 6, evMaxCurrent: 16, evMaxVoltage: 400 } } });
  assert.deepEqual(ac.availableTransfer, ['AC_three_phase']);
  assert.equal(ac.bidirectional, false);
  assert.equal(ac.energyRequestWh, 15000);
  assert.equal(ac.maxDischargePowerW, null);
});

test('discharge windows: validated, in the site\'s time zone, wrapping midnight, all day', () => {
  assert.deepEqual(parseWindows([{ from: '17:00', to: '22:00' }]), [{ from: '17:00', to: '22:00' }]);
  assert.match(parseWindows([{ from: '5pm', to: '22:00' }]) as string, /HH:MM/);
  assert.match(parseWindows('17-22') as string, /list/);
  assert.deepEqual(parseWindows(null), []);
  // 10:30 UTC is 17:30 WIB and 18:30 WITA.
  const t = new Date('2026-09-28T10:30:00Z');
  assert.equal(localMinutes(t, 'Asia/Jakarta'), 17 * 60 + 30);
  assert.equal(inWindow([{ from: '17:00', to: '22:00' }], t, 'Asia/Jakarta'), true);
  assert.equal(inWindow([{ from: '17:00', to: '18:00' }], t, 'Asia/Makassar'), false);
  assert.equal(inWindow([{ from: '22:00', to: '06:00' }], new Date('2026-09-28T20:00:00Z'), 'Asia/Jakarta'), true, '03:00 WIB inside a window across midnight');
  assert.equal(inWindow([{ from: '00:00', to: '00:00' }], t, 'Asia/Jakarta'), true, 'all day');
  assert.equal(inWindow([], t, 'Asia/Jakarta'), false);
});

const site = (over: Partial<SiteV2x> = {}): SiteV2x => ({ enabled: true, windows: [{ from: '00:00', to: '00:00' }], maxDischargeW: null, allowExport: false, timezone: 'Asia/Jakarta', ...over });
const car = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  sessionId: id, connectorUuid: `c-${id}`, consent: true, protocolOk: true, bidirectional: true, evMaxDischargeW: 11000, connectorMaxW: 60000,
  socPercent: 80, floorPercent: 40, departureTime: null, wasDischarging: false, ...over,
});
const now = new Date('2026-09-28T10:30:00Z');
const w = (p: ReturnType<typeof planDischarge>, id: string) => { const x = p.get(id); return x && 'dischargeW' in x ? x.dischargeW : (x as { reason: string } | undefined)?.reason; };

test('discharge plan: without export, cars cover only the site\'s own load, shared fairly and capped per car', () => {
  const p = planDischarge(site(), [car('a'), car('b', { evMaxDischargeW: 3000 })], 20_000, now);
  assert.equal(w(p, 'b'), 3000, 'a small car gives what it can');
  assert.equal(w(p, 'a'), 11000, 'the rest goes to the other car, up to its own limit');
  const tight = planDischarge(site(), [car('a'), car('b')], 8_000, now);
  assert.equal(w(tight, 'a'), 4000);
  assert.equal(w(tight, 'b'), 4000);
  assert.match(String(w(planDischarge(site(), [car('a')], 0, now), 'a')), /no building load/);
  // With export allowed, the site limit (or the cars) decide.
  assert.equal(w(planDischarge(site({ allowExport: true }), [car('a')], 0, now), 'a'), 11000);
  assert.equal(w(planDischarge(site({ allowExport: true, maxDischargeW: 5000 }), [car('a'), car('b')], 0, now), 'a'), 2500);
  assert.match(String(w(planDischarge(site({ allowExport: true, maxDischargeW: 1500 }), [car('a'), car('b')], 0, now), 'a')), /below 1 kW/);
});

test('discharge plan: never without consent, a bidirectional car, OCPP 2.1, the programme hours, above the floor, or near departure', () => {
  const cases: Array<[Partial<Candidate>, RegExp]> = [
    [{ consent: false }, /no consent/],
    [{ bidirectional: false }, /did not offer/],
    [{ evMaxDischargeW: MIN_DISCHARGE_W - 1 }, /did not offer/],
    [{ protocolOk: false }, /OCPP 2\.1/],
    [{ socPercent: null }, /unknown/],
    [{ socPercent: 40 }, /at or below 40%/],
    [{ socPercent: 41.5 }, /at or below 40%/],
    [{ departureTime: new Date(now.getTime() + 30 * 60_000) }, /leaves within the hour/],
  ];
  for (const [over, why] of cases) assert.match(String(w(planDischarge(site(), [car('a', over)], 50_000, now), 'a')), why, JSON.stringify(over));
  // Resume margin: stopped at 40%, it resumes above 42%; a car already discharging goes on down to the floor.
  assert.equal(w(planDischarge(site(), [car('a', { socPercent: 41.5, wasDischarging: true })], 50_000, now), 'a'), 11000);
  assert.equal(w(planDischarge(site(), [car('a', { socPercent: 43 })], 50_000, now), 'a'), 11000);
  assert.match(String(w(planDischarge(site({ enabled: false }), [car('a')], 50_000, now), 'a')), /off at this site/);
  assert.match(String(w(planDischarge(site({ windows: [{ from: '06:00', to: '09:00' }] }), [car('a')], 50_000, now), 'a')), /outside/);
  assert.equal(w(planDischarge(site(), [car('a', { departureTime: new Date(now.getTime() + 3 * 3_600_000) })], 50_000, now), 'a'), 11000);
});

test('credit and meter readings: export register, SoC, whole-rupiah credit', () => {
  assert.equal(creditMinor(2000, 2000), 4000);
  assert.equal(creditMinor(1234, 1500), 1851);
  assert.equal(creditMinor(-5, 2000), 0);
  assert.equal(creditMinor(5000, null), 0);
  const mv = [
    { timestamp: '2026-09-28T10:00:00Z', sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: 5000, unit: 'Wh' }, { measurand: EXPORT_MEASURAND, value: 1.2, unit: 'kWh' }, { measurand: 'SoC', value: 78, unit: 'Percent' }] },
    { timestamp: '2026-09-28T10:01:00Z', sampledValue: [{ measurand: EXPORT_MEASURAND, value: 1500, unit: 'Wh' }, { measurand: 'Display.PresentSOC', value: 77 }] },
  ];
  assert.equal(energyWhFrom(mv, EXPORT_MEASURAND), 1500);
  assert.equal(energyWhFrom(mv), 5000, 'the import register is untouched');
  assert.equal(socFrom(mv), 77);
  assert.equal(socFrom([{ timestamp: 'x', sampledValue: [{ measurand: 'SoC', value: 140 }] }]), null, 'an impossible SoC is ignored');
});

test('OCPP 2.1: its own schema set, with the 2.0.1 messages and 2.1\'s wider enums', () => {
  assert.equal(isKnownAction('NotifyEVChargingNeeds', 'ocpp2.1'), true);
  assert.equal(isKnownAction('NotifyEVChargingNeeds', 'ocpp2.0.1'), true);
  assert.equal(validateCallDetailed('NotifyEVChargingNeeds', needs21, 'ocpp2.1').failure, null);
  const started = {
    eventType: 'Updated', timestamp: '2026-09-28T10:00:00Z', triggerReason: 'OperationModeChanged', seqNo: 3,
    transactionInfo: { transactionId: 'T1', operationMode: 'CentralSetpoint' },
    meterValue: [{ timestamp: '2026-09-28T10:00:00Z', sampledValue: [{ value: 77, measurand: 'Display.PresentSOC', location: 'EV' }] }],
  };
  assert.equal(validateCallDetailed('TransactionEvent', started, 'ocpp2.1').failure, null, 'a 2.1 trigger reason and measurand pass on 2.1');
  assert.notEqual(validateCallDetailed('TransactionEvent', started, 'ocpp2.0.1').failure, null, '…but are not 2.0.1');
  assert.equal(Object.keys(REQUEST_SCHEMAS_21).length, Object.keys(REQUEST_SCHEMAS_201).length);
  const w2 = widen({ a: { type: 'string', enum: ['x'] } });
  assert.deepEqual(w2, { a: { type: 'string', enum: ['x'] } }, 'unrelated enums are left alone');
});
