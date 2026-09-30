import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokensFromAuthHeader, authHeaderFor, ocpiDateTime, evseStatusFor, connectorStandard, ratings, evseUid, emi3EvseId,
  buildLocation, locationProblem, buildTariff, buildSession, buildCdr, parseToken, paging, effectiveVatPercent, contentHash,
  type Party, type SiteIn, type EvseIn, type ConnectorIn,
} from './mapping.js';
import type { Tariff } from '../services/tariff.js';

const party: Party = { country_code: 'ID', party_id: 'PLS', business_name: 'PlugSure Demo', website: 'https://plugsure.example' };
const t0 = new Date('2026-09-27T03:00:00.000Z');

const conn = (over: Partial<ConnectorIn> = {}): ConnectorIn => ({
  connector_id: 1, connector_type: 'cCCS2', current_type: 'DC', phases: 3, max_power_w: 60_000,
  rated_voltage_v: null, rated_current_a: null, status: 'Available', maintenance_reason: null, tariff_id: 't-1', last_updated: t0, ...over,
});
const evse = (over: Partial<EvseIn> = {}): EvseIn => ({
  ocpp_identity: 'AUTEL-DC60-SMB-002', evse_no: 1, display_name: 'Lobby DC', decommissioned: false, online: true,
  connectors: [conn()], last_updated: t0, ...over,
});
const site = (over: Partial<SiteIn> = {}): SiteIn => ({
  id: '0b6f7c1e-7a55-4d0e-9d2a-1d2b3c4d5e6f', name: 'Summarecon Mall Bekasi', address: 'Jl. Bulevar Ahmad Yani, Bekasi',
  city: null, postal_code: '17142', lat: -6.2246, lon: 106.9998, timezone: 'Asia/Jakarta', last_updated: t0, ...over,
});

describe('ocpi mapping: protocol basics', () => {
  test('the Authorization header is read base64-encoded (2.2.1) and raw (2.1.1)', () => {
    const tok = 'abc123-TOKEN_x';
    assert.equal(tokensFromAuthHeader(authHeaderFor(tok))[0], tok);
    assert.ok(tokensFromAuthHeader(`Token ${tok}`).includes(tok));
    assert.deepEqual(tokensFromAuthHeader('Bearer x'), []);
    assert.deepEqual(tokensFromAuthHeader(undefined), []);
  });
  test('DateTime is UTC to the second with a Z', () => {
    assert.equal(ocpiDateTime(new Date('2026-09-27T10:11:12.345Z')), '2026-09-27T10:11:12Z');
  });
  test('paging clamps limit and offset and reads dates', () => {
    const p = paging({ offset: '-5', limit: '5000', date_from: '2026-09-01T00:00:00Z', date_to: 'nonsense' });
    assert.equal(p.offset, 0);
    assert.equal(p.limit, 100);
    assert.equal(p.dateFrom?.toISOString(), '2026-09-01T00:00:00.000Z');
    assert.equal(p.dateTo, null);
  });
});

describe('ocpi mapping: locations', () => {
  test('connector statuses map to OCPI EVSE statuses; offline is UNKNOWN whatever was last reported', () => {
    const e = { decommissioned: false, online: true, reserved: false };
    assert.equal(evseStatusFor(e, { status: 'Available', maintenance_reason: null }), 'AVAILABLE');
    for (const s of ['Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing']) assert.equal(evseStatusFor(e, { status: s, maintenance_reason: null }), 'CHARGING', s);
    assert.equal(evseStatusFor(e, { status: 'Faulted', maintenance_reason: null }), 'OUTOFORDER');
    assert.equal(evseStatusFor(e, { status: 'Unavailable', maintenance_reason: null }), 'INOPERATIVE');
    assert.equal(evseStatusFor(e, { status: 'Available', maintenance_reason: 'cable replacement' }), 'INOPERATIVE');
    assert.equal(evseStatusFor({ ...e, reserved: true }, { status: 'Available', maintenance_reason: null }), 'RESERVED');
    assert.equal(evseStatusFor({ ...e, online: false }, { status: 'Available', maintenance_reason: null }), 'UNKNOWN');
    assert.equal(evseStatusFor({ ...e, decommissioned: true, online: false }, { status: 'Available', maintenance_reason: null }), 'REMOVED');
  });
  test('every PlugSure plug type has an OCPI standard and format', () => {
    assert.deepEqual(connectorStandard('cCCS2', 'DC'), { standard: 'IEC_62196_T2_COMBO', format: 'CABLE' });
    assert.deepEqual(connectorStandard('sType2', 'AC'), { standard: 'IEC_62196_T2', format: 'SOCKET' });
    assert.deepEqual(connectorStandard('cType2', 'AC'), { standard: 'IEC_62196_T2', format: 'CABLE' });
    assert.deepEqual(connectorStandard('cChaDeMo', 'DC'), { standard: 'CHADEMO', format: 'CABLE' });
    assert.deepEqual(connectorStandard('cGBT', 'DC'), { standard: 'GBT_DC', format: 'CABLE' });
    assert.deepEqual(connectorStandard('sGBT', 'AC'), { standard: 'GBT_AC', format: 'SOCKET' });
  });
  test('voltage and current are derived from power when not rated (AC per phase at 230 V)', () => {
    assert.deepEqual(ratings(conn({ current_type: 'AC', phases: 3, max_power_w: 22_000 })), { max_voltage: 230, max_amperage: 32, max_electric_power: 22_000 });
    assert.deepEqual(ratings(conn({ current_type: 'AC', phases: 1, max_power_w: 7_400 })), { max_voltage: 230, max_amperage: 32, max_electric_power: 7_400 });
    assert.deepEqual(ratings(conn()), { max_voltage: 500, max_amperage: 120, max_electric_power: 60_000 });
    assert.equal(ratings(conn({ rated_voltage_v: 920, rated_current_a: 200 })).max_voltage, 920);
  });
  test('EVSE uid fits 36 characters and is stable; the eMI3 id follows the ID*PLS*E… form', () => {
    const long = 'A'.repeat(64);
    assert.equal(evseUid(long, 2), evseUid(long, 2));
    assert.ok(evseUid(long, 2).length <= 36);
    assert.equal(evseUid('AUTEL-DC60-SMB-002', 1), 'AUTEL-DC60-SMB-002-1');
    assert.match(emi3EvseId(party, 'autel-dc60-smb-002', 1), /^ID\*PLS\*E[A-Z0-9*]+$/);
  });
  test('a location carries coordinates as strings, a 45-character address and a city', () => {
    const l = buildLocation(party, site({ address: 'Jl. Bulevar Ahmad Yani Kav. 1-10, Kelurahan Marga Mulya, Bekasi Utara, Bekasi' }), [evse()]);
    assert.equal(l.coordinates.latitude, '-6.224600');
    assert.equal(l.coordinates.longitude, '106.999800');
    assert.ok(l.address.length <= 45);
    assert.equal(l.city, 'Bekasi');
    assert.equal(l.country, 'IDN');
    assert.equal(l.evses[0]!.status, 'AVAILABLE');
    assert.deepEqual(l.evses[0]!.connectors[0]!.tariff_ids, ['t-1']);
    assert.equal(l.operator.name, 'PlugSure Demo');
  });
  test('a site without coordinates or city cannot be published', () => {
    assert.match(locationProblem(site({ lat: null }))!, /map location/);
    assert.match(locationProblem(site({ address: 'Jl. Sudirman', city: null }))!, /city/);
    assert.equal(locationProblem(site({ city: 'Bekasi' })), null);
  });
  test('the content hash ignores status and timestamps, so a status change is a PATCH, not a full PUT', () => {
    const a = buildLocation(party, site(), [evse()]);
    const b = buildLocation(party, site({ last_updated: new Date() }), [evse({ connectors: [conn({ status: 'Charging' })] })]);
    assert.equal(contentHash(a), contentHash(b));
    const c = buildLocation(party, site({ name: 'Renamed' }), [evse()]);
    assert.notEqual(contentHash(a), contentHash(c));
  });
});

describe('ocpi mapping: tariffs', () => {
  const tariff = (components: Tariff['components'], extra: Partial<Tariff> = {}): Tariff =>
    ({ id: 'tar-1', name: 'Public DC', currency: 'IDR', plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, components, ...extra });
  const build = (t: Tariff) => buildTariff(party, { tariff: t, active_from: t0, active_to: null, last_updated: t0 });

  test('PPN is 11 % effective (12 % of DPP 11/12), 0 when the tariff is PPN-exempt', () => {
    assert.equal(effectiveVatPercent(true), 11);
    assert.equal(effectiveVatPercent(false), 0);
  });
  test('a peak price comes before the catch-all, and off-peak wraps midnight', () => {
    const t = build(tariff([
      { kind: 'energy', rate: 2000, touBlock: 'ANY' },
      { kind: 'energy', rate: 2467.5, touBlock: 'WBP' },
      { kind: 'energy', rate: 1800, touBlock: 'LWBP' },
    ]));
    const energy = t.elements.filter((e: any) => e.price_components[0].type === 'ENERGY');
    assert.deepEqual(energy.map((e: any) => e.price_components[0].price), [2467.5, 1800, 2000]);
    assert.deepEqual(energy[0]!.restrictions, { start_time: '17:00', end_time: '22:00' });
    assert.deepEqual(energy[1]!.restrictions, { start_time: '22:00', end_time: '17:00' });
    assert.equal(energy[2]!.restrictions, undefined);
    assert.equal((energy[0]!.price_components[0] as any).vat, 11);
  });
  test('service and admin fees are one FLAT price, not charged below the minimum billable energy', () => {
    const t = build(tariff([{ kind: 'energy', rate: 2400, touBlock: 'ANY' }, { kind: 'session', rate: 21_000, touBlock: 'ANY' }, { kind: 'admin', rate: 4_000, touBlock: 'ANY' }]));
    const flat = t.elements.find((e: any) => e.price_components[0].type === 'FLAT')!;
    assert.equal((flat.price_components[0] as any).price, 25_000);
    assert.deepEqual(flat.restrictions, { min_kwh: 0.1 });
  });
  test('idle and time fees are priced per hour; the idle grace is explained in the alt text', () => {
    const t = build(tariff([{ kind: 'energy', rate: 2400, touBlock: 'ANY' }, { kind: 'idle', rate: 1000, touBlock: 'ANY', fromMinutes: 15, toMinutes: 105 },
      { kind: 'time', rate: 100, touBlock: 'ANY', fromMinutes: 0, toMinutes: 240 }]));
    const parking = t.elements.find((e: any) => e.price_components[0].type === 'PARKING_TIME')!;
    assert.equal((parking.price_components[0] as any).price, 60_000);
    const time = t.elements.find((e: any) => e.price_components[0].type === 'TIME')!;
    assert.equal((time.price_components[0] as any).price, 6_000);
    assert.deepEqual(time.restrictions, { max_duration: 14_400 });
    assert.match(t.tariff_alt_text[0]!.text, /after 15 min, charged for at most 90 min/);
    assert.match(t.tariff_alt_text[1]!.text, /PBJT-TL/);
  });
  test('with no energy component the regulated PLN rate is published', () => {
    const t = build(tariff([]));
    assert.equal((t.elements[0]!.price_components[0] as any).price, 2467.5);
  });
  test('tiers become min/max kWh and a day mask becomes day_of_week', () => {
    const t = build(tariff([
      { kind: 'energy', rate: 2400, touBlock: 'ANY', fromKwh: 0, toKwh: 20 },
      { kind: 'energy', rate: 2200, touBlock: 'ANY', fromKwh: 20, dayMask: 0b0011111 },
    ]));
    assert.deepEqual(t.elements[0]!.restrictions, { max_kwh: 20 });
    assert.deepEqual(t.elements[1]!.restrictions, { min_kwh: 20, day_of_week: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] });
  });
});

describe('ocpi mapping: sessions and CDRs', () => {
  const token = { country_code: 'ID', party_id: 'EMS', uid: 'RFID-7788', type: 'RFID', contract_id: 'ID-EMS-C12345' };
  const s = {
    id: 'sess-1', state: 'ended', started_at: new Date('2026-09-27T02:00:00Z'), ended_at: new Date('2026-09-27T03:00:00Z'),
    energy_wh: 30_000, auth_method: 'COMMAND', authorization_reference: 'REF-1', location_id: site().id, evse_uid: 'X-1', connector_id: '1',
    meter_id: 'MID-DC-1', cost: { subtotal_idr: 100_000, pbjt_idr: 7_500, total_idr: 118_825 }, last_updated: t0, idle_minutes: 15,
  };
  test('a session is ACTIVE while charging and COMPLETED with its total afterwards (PBJT inside excl_vat)', () => {
    const active = buildSession(party, { ...s, state: 'active', ended_at: null, cost: null }, token);
    assert.equal(active.status, 'ACTIVE');
    assert.equal(active.end_date_time, undefined);
    assert.equal(active.kwh, 30);
    const done = buildSession(party, s, token);
    assert.equal(done.status, 'COMPLETED');
    assert.deepEqual(done.total_cost, { excl_vat: 107_500, incl_vat: 118_825 });
    assert.equal(done.auth_method, 'COMMAND');
    assert.equal(done.authorization_reference, 'REF-1');
  });
  test('a CDR splits energy, fixed and parking costs and adds a parking period', () => {
    const cdr = buildCdr(party, {
      id: 'cdr-1', issued_at: t0,
      lines: [
        { kind: 'energy', description: 'Energy', quantity: 30, unit: 'kWh', unitRate: 2400, amountIdr: 72_000 },
        { kind: 'session', description: 'Service', quantity: 1, unit: 'session', unitRate: 25_000, amountIdr: 25_000 },
        { kind: 'idle', description: 'Idle', quantity: 3, unit: 'min', unitRate: 1000, amountIdr: 3_000 },
      ],
      subtotal_idr: 100_000, pbjt_idr: 7_500, total_idr: 118_825, tariff: null,
      session: s, site: site({ city: 'Bekasi' }), evse: evse(), connector: conn(),
    }, token);
    assert.equal(cdr.total_energy, 30);
    assert.equal(cdr.total_time, 1);
    assert.equal(cdr.total_parking_time, 0.25);
    assert.deepEqual(cdr.total_energy_cost, { excl_vat: 72_000 });
    assert.deepEqual(cdr.total_fixed_cost, { excl_vat: 25_000 });
    assert.deepEqual(cdr.total_parking_cost, { excl_vat: 3_000 });
    assert.equal(cdr.charging_periods.length, 2);
    assert.equal((cdr.charging_periods[1] as any).start_date_time, '2026-09-27T02:45:00Z');
    assert.equal(cdr.cdr_location.connector_standard, 'IEC_62196_T2_COMBO');
    assert.equal(cdr.cdr_token.contract_id, 'ID-EMS-C12345');
  });
});

describe('ocpi mapping: tokens from partners', () => {
  const good = { country_code: 'ID', party_id: 'EMS', uid: 'RFID-1', type: 'RFID', contract_id: 'ID-EMS-C1', issuer: 'eMobility Co', valid: true, whitelist: 'ALLOWED', last_updated: '2026-09-27T00:00:00Z' };
  test('a well-formed token is accepted and matches its URL', () => {
    const t = parseToken(good, { country_code: 'ID', party_id: 'EMS', uid: 'RFID-1' });
    assert.equal(typeof t, 'object');
  });
  test('missing or inconsistent fields are refused with a reason', () => {
    assert.match(parseToken({ ...good, whitelist: 'SOMETIMES' }) as string, /whitelist/);
    assert.match(parseToken({ ...good, contract_id: '' }) as string, /contract_id/);
    assert.match(parseToken({ ...good, valid: 'yes' }) as string, /valid/);
    assert.match(parseToken(good, { country_code: 'ID', party_id: 'EMS', uid: 'OTHER' }) as string, /match the URL/);
  });
});
