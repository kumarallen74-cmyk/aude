import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { profileFor, ID_PROFILE, MY_PROFILE, SG_PROFILE } from './index.js';
import { rateSession, validateTariff, energyAllowanceWh, driverAllowanceWh, type Tariff } from '../tariff.js';
import { taxContextFrom, type TaxRegistrationRow } from '../tax/index.js';

/**
 * Regulatory profiles per country (docs/MULTI-COUNTRY-DESIGN.md §D4) and rating in
 * ringgit / Singapore dollars (minor units: sen, cents).
 */

const AT = new Date('2026-10-01T02:00:00Z');
const SG_REG: TaxRegistrationRow[] = [{ country_code: 'SG', scheme: 'SG_GST', registration_no: 'X', registered: true, ev_charging_taxable: true, rate_bps: null, effective_from: '2020-01-01', effective_to: null }];
const MY_TAX: TaxRegistrationRow[] = [{ country_code: 'MY', scheme: 'MY_SST', registration_no: 'W10-1', registered: true, ev_charging_taxable: true, rate_bps: null, effective_from: '2020-01-01', effective_to: null }];

const myTariff = (over: Partial<Tariff> = {}): Tariff => ({
  id: 'my', name: 'MY public DC', currency: 'MYR', countryCode: 'MY', pricesIncludeTax: true,
  components: [
    { kind: 'energy', rate: 1.2, touBlock: 'ANY' },
    { kind: 'idle', rate: 0.5, touBlock: 'ANY', fromMinutes: 15, toMinutes: 75 },
  ],
  ...over,
});
const sgTariff = (over: Partial<Tariff> = {}): Tariff => ({
  id: 'sg', name: 'SG public AC', currency: 'SGD', countryCode: 'SG', pricesIncludeTax: true,
  components: [{ kind: 'energy', rate: 0.65, touBlock: 'ANY' }],
  ...over,
});
const ctx = (country: 'MY' | 'SG' | 'ID', regs: TaxRegistrationRow[], over: Record<string, unknown> = {}) => ({
  startedAt: AT, endedAt: new Date(AT.getTime() + 60 * 60_000), energyWh: 20_000, connectorMaxPowerW: 60_000, localTaxRateBps: 0,
  timezone: country === 'SG' ? 'Asia/Singapore' : country === 'MY' ? 'Asia/Kuala_Lumpur' : 'Asia/Jakarta',
  tax: taxContextFrom(country, regs, null, AT),
  ...over,
});

describe('profile selection by country', () => {
  test('each country has its profile; absent = Indonesia', () => {
    assert.equal(profileFor('ID'), ID_PROFILE);
    assert.equal(profileFor(null), ID_PROFILE);
    assert.equal(profileFor('MY'), MY_PROFILE);
    assert.equal(profileFor('SG'), SG_PROFILE);
    assert.throws(() => profileFor('TH'), /unsupported country/);
  });

  test('PLN formula and WBP/LWBP are Indonesian; tera blocks only Indonesian connectors', () => {
    assert.equal(ID_PROFILE.formulaEnergyRate({ plnScheme: 'layanan_khusus', plnMultiplier: 1.5 }), 1645 * 1.5);
    assert.equal(MY_PROFILE.formulaEnergyRate({ plnScheme: 'layanan_khusus', plnMultiplier: 1.5 }), null);
    assert.equal(ID_PROFILE.hasTou && !MY_PROFILE.hasTou && !SG_PROFILE.hasTou, true);
    assert.equal(ID_PROFILE.connectorMaySell('lapsed').allowed, false);
    assert.equal(MY_PROFILE.connectorMaySell('lapsed').allowed, true);
    assert.equal(SG_PROFILE.connectorMaySell('pending').allowed, true);
    assert.equal(ID_PROFILE.serviceFeeCeilingMinor('fast'), 25_000);
    assert.equal(SG_PROFILE.serviceFeeCeilingMinor('fast'), null);
  });

  test('the platform idle cap per currency (minor units)', () => {
    assert.equal(ID_PROFILE.idleFeeCapMinor('IDR'), 100_000);
    assert.equal(MY_PROFILE.idleFeeCapMinor('MYR'), 3_000);
    assert.equal(SG_PROFILE.idleFeeCapMinor('SGD'), 3_000);
  });
});

describe('save-time validation per country', () => {
  test('the PLN / Kepmen ceilings fire only for Indonesian tariffs: RM 2/kWh and a RM 60 service fee pass in Malaysia', () => {
    const my = myTariff({ components: [{ kind: 'energy', rate: 2, touBlock: 'ANY' }, { kind: 'session', rate: 60, touBlock: 'ANY' }] });
    assert.deepEqual(validateTariff(my, 30_000), []);
    const id: Tariff = { id: 'id', name: 'ID', currency: 'IDR', plnScheme: 'layanan_khusus', components: [{ kind: 'energy', rate: 5000, touBlock: 'ANY' }, { kind: 'session', rate: 60_000, touBlock: 'ANY' }] };
    const codes = validateTariff(id, 30_000).map((f) => f.code);
    assert.ok(codes.includes('ENERGY_CEILING_EXCEEDED') && codes.includes('SERVICE_FEE_CEILING_EXCEEDED'));
  });

  test('S$5/kWh in Singapore passes; the idle fee still needs a bound and fits the S$30 cap', () => {
    assert.deepEqual(validateTariff(sgTariff({ components: [{ kind: 'energy', rate: 5, touBlock: 'ANY' }] }), 22_000), []);
    const unbounded = validateTariff(sgTariff({ components: [{ kind: 'energy', rate: 0.6, touBlock: 'ANY' }, { kind: 'idle', rate: 0.5, touBlock: 'ANY', fromMinutes: 10 }] }), 22_000);
    assert.deepEqual(unbounded.map((f) => [f.code, f.severity]), [['UNBOUNDED_TIME_FEE', 'violation']]);
    assert.match(unbounded[0]!.message, /S\$ 0\.50\/min/);
    const over = validateTariff(sgTariff({ components: [{ kind: 'energy', rate: 0.6, touBlock: 'ANY' }, { kind: 'idle', rate: 0.5, touBlock: 'ANY', fromMinutes: 0, toMinutes: 90 }] }), 22_000);
    assert.deepEqual(over.map((f) => f.code), ['TIME_FEE_CAP_EXCEEDED']);
    assert.match(over[0]!.message, /S\$ 45\.00 per session, above the S\$ 30\.00 platform cap.*IDLE_FEE_CAP_SGD/);
  });

  test('Indonesian-only constructs are refused elsewhere; currency must match the country', () => {
    const f = validateTariff(myTariff({ plnScheme: 'layanan_khusus', components: [{ kind: 'energy', rate: 0, formulaRate: true, touBlock: 'WBP' }] }), 22_000).map((x) => x.code);
    assert.deepEqual(f, ['PLN_SCHEME_NOT_APPLICABLE', 'FORMULA_RATE_NOT_APPLICABLE', 'TOU_BLOCK_NOT_APPLICABLE']);
    assert.deepEqual(validateTariff(myTariff({ currency: 'SGD' }), 22_000).map((x) => x.code), ['TARIFF_CURRENCY_MISMATCH']);
    const idIncl: Tariff = { id: 'x', name: 'x', currency: 'IDR', pricesIncludeTax: true, components: [{ kind: 'energy', rate: 2000, touBlock: 'ANY' }] };
    assert.ok(validateTariff(idIncl, 22_000).some((x) => x.code === 'INCLUSIVE_PRICES_NOT_SUPPORTED'));
  });
});

describe('rating in minor units', () => {
  test('MYR: energy + idle in sen, no service tax by default (RM 1.20/kWh, 20 kWh, 35 idle min)', () => {
    const r = rateSession(myTariff(), ctx('MY', [], { idleMinutes: 35 }));
    assert.deepEqual(r.lines.map((l) => [l.kind, l.description, l.amountMinor]), [
      ['energy', 'Energy', 2400],                       // 20 kWh × RM 1.20
      ['idle', 'Idle fee (after 15 min grace)', 1000],  // 20 min × RM 0.50
    ]);
    assert.deepEqual([r.tax.scheme, r.tax.subtotalMinor, r.tax.taxMinor, r.tax.totalMinor], ['NONE', 3400, 0, 3400]);
    assert.deepEqual(r.flags, []);
  });

  test('the design acceptance case: a MY session at RM 1.20/kWh with no registration → tax 0', () => {
    const r = rateSession(myTariff(), ctx('MY', [], { energyWh: 12_345 }));
    assert.equal(r.tax.taxMinor, 0);
    assert.equal(r.tax.totalMinor, 1481); // round(12.345 × 1.20 × 100)
  });

  test('MYR rounding: half a sen rounds up, per line', () => {
    const r = rateSession(myTariff({ components: [{ kind: 'energy', rate: 0.955, touBlock: 'ANY' }] }), ctx('MY', [], { energyWh: 12_345 }));
    assert.equal(r.lines[0]!.amountMinor, 1179); // 12.345 × 0.955 × 100 = 1178.9475
  });

  test('MY with service tax switched on: 8 % of the inclusive price', () => {
    const r = rateSession(myTariff(), ctx('MY', MY_TAX));
    assert.deepEqual([r.tax.scheme, r.tax.totalMinor, r.tax.taxMinor, r.tax.subtotalMinor], ['MY_SST', 2400, 178, 2222]);
  });

  test('the design acceptance case: SG 20 kWh at S$0.65/kWh incl. GST → 1300 / 107 / 1193, SG_GST', () => {
    const r = rateSession(sgTariff(), ctx('SG', SG_REG));
    assert.deepEqual(
      [r.tax.totalMinor, r.tax.taxMinor, r.tax.subtotalMinor, r.tax.scheme, r.tax.pricesIncludeTax],
      [1300, 107, 1193, 'SG_GST', true],
    );
  });

  test('the occupancy cap in SGD: a capped line in cents', () => {
    const t = sgTariff({ components: [{ kind: 'energy', rate: 0.65, touBlock: 'ANY' }, { kind: 'idle', rate: 1, touBlock: 'ANY', fromMinutes: 0, toMinutes: 60 }] });
    const r = rateSession(t, ctx('SG', SG_REG, { idleMinutes: 45 }));
    const cap = r.lines.find((l) => l.description === 'Occupancy-fee cap adjustment')!;
    assert.equal(cap.amountMinor, -1500); // S$45 of idle, capped at S$30
    assert.equal(cap.unitRate, -15);      // major units, like every other unitRate
    assert.match(r.flags.find((f) => f.code === 'TIME_FEE_CAP_EXCEEDED')!.message, /S\$ 45\.00 .* S\$ 30\.00 .* S\$ 15\.00 was not billed/);
  });

  test('no WBP/LWBP outside Indonesia: one energy line across 17:00', () => {
    const start = new Date('2026-10-01T08:30:00Z'); // 16:30 SGT
    const r = rateSession(sgTariff(), ctx('SG', SG_REG, { startedAt: start, endedAt: new Date(start.getTime() + 60 * 60_000) }));
    assert.deepEqual(r.lines.map((l) => [l.description, l.touBlock]), [['Energy', 'ANY']]);
  });

  test('a tariff in another currency than the session is a violation (no CDR is issued)', () => {
    const r = rateSession(myTariff(), ctx('MY', [], { currency: 'SGD' }));
    assert.ok(r.flags.some((f) => f.code === 'TARIFF_CURRENCY_MISMATCH' && f.severity === 'violation'));
  });

  test('a MY / SG tariff is never taxed as Indonesian: rating without its tax context throws', () => {
    const c = ctx('MY', []) as Record<string, unknown>;
    delete c.tax;
    assert.throws(() => rateSession(myTariff(), c as any), /needs the session's tax context/);
  });

  test('member price and amount off in MYR: amounts in sen, the member rate in ringgit', () => {
    const r = rateSession(myTariff(), ctx('MY', [], {
      adjustments: [{ source: 'subscription', id: 's', name: 'Member', energyRate: 1.0 }, { source: 'promotion', id: 'p', name: 'Promo', amountOffMinor: 150 }],
    }));
    const adj = r.lines.filter((l) => l.adjustment).map((l) => [l.description, l.amountMinor, l.unitRate]);
    assert.deepEqual(adj, [['Member: energy at RM 1.00/kWh', -400, -4], ['Promo: RM 1.50 off', -150, -1.5]]);
    assert.equal(r.tax.totalMinor, 2400 - 400 - 150);
  });

  test('pre-purchase inverts inclusive SGD prices: S$10.00 buys what costs at most S$10.00', () => {
    const base = { startedAt: AT, endedAt: new Date(AT.getTime() + 45 * 60_000), connectorMaxPowerW: 22_000, localTaxRateBps: 0, timezone: 'Asia/Singapore', tax: taxContextFrom('SG', SG_REG, null, AT) };
    const wh = energyAllowanceWh(sgTariff(), 1000, { ...base, idleMinutes: 0 });
    assert.ok(wh > 15_300 && wh < 15_400, `${wh} Wh`); // 10.00 / 0.65 = 15.38 kWh (cent rounding allows 15.392)
    assert.ok(rateSession(sgTariff(), { ...base, energyWh: wh }).tax.totalMinor <= 1000);
    assert.ok(rateSession(sgTariff(), { ...base, energyWh: wh + 10 }).tax.totalMinor > 1000);
    assert.equal(driverAllowanceWh(sgTariff(), 1000, base), wh, 'no peak block to reserve against in Singapore');
  });
});
