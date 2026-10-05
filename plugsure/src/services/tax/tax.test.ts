import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { engineFor, taxContextFrom, computeTax, rateRowAt, type TaxRegistrationRow } from './index.js';

/**
 * Tax engines per country (docs/MULTI-COUNTRY-DESIGN.md §D3). Amounts in PlugSure
 * minor units: IDR whole rupiah, MYR sen, SGD cents.
 */

const reg = (r: Partial<TaxRegistrationRow> & Pick<TaxRegistrationRow, 'country_code' | 'scheme'>): TaxRegistrationRow => ({
  registration_no: 'X-1', registered: true, ev_charging_taxable: true, rate_bps: null, effective_from: '2020-01-01', effective_to: null, ...r,
});
const AT = new Date('2026-10-03T04:00:00Z');
const SG_REG = [reg({ country_code: 'SG', scheme: 'SG_GST', registration_no: '201912345M' })];

describe('Singapore GST (SG_GST)', () => {
  test('a registered operator: 9 %, prices GST-inclusive — gross 1090 → tax 90, net 1000', () => {
    const ctx = taxContextFrom('SG', SG_REG, null, AT);
    assert.equal(ctx.scheme, 'SG_GST');
    assert.equal(ctx.rateBps, 900);
    assert.equal(ctx.currency, 'SGD');
    const r = engineFor(ctx).computeSession({ subtotalMinor: 1090, pricesIncludeTax: true });
    assert.deepEqual(
      { sub: r.subtotalMinor, base: r.taxBaseMinor, tax: r.taxMinor, total: r.totalMinor, local: r.localTaxMinor, rate: r.taxRateBps, incl: r.pricesIncludeTax },
      { sub: 1000, base: 1000, tax: 90, total: 1090, local: 0, rate: 900, incl: true },
    );
    assert.equal(r.scheme, 'SG_GST');
    assert.deepEqual(r.detail, { inclusive: true, grossMinor: 1090 });
  });

  test('the design acceptance case: 20 kWh at S$0.65 incl. GST → total 1300, tax 107, subtotal 1193', () => {
    const r = engineFor(taxContextFrom('SG', SG_REG, null, AT)).computeSession({ subtotalMinor: 1300, pricesIncludeTax: true });
    assert.equal(r.totalMinor, 1300);
    assert.equal(r.taxMinor, 107); // round(1300 × 900 / 10900) = round(107.34)
    assert.equal(r.subtotalMinor, 1193);
  });

  test('exclusive prices: tax on top, rounded to the cent', () => {
    const r = engineFor(taxContextFrom('SG', SG_REG, null, AT)).computeSession({ subtotalMinor: 1234, pricesIncludeTax: false });
    assert.equal(r.taxMinor, 111); // 1234 × 9 % = 111.06
    assert.equal(r.totalMinor, 1345);
    assert.equal(r.subtotalMinor, 1234);
    assert.equal(r.roundingMinor, 0, 'no cash rounding outside Indonesia');
  });

  test('not GST-registered: no tax, the receipt says so', () => {
    const ctx = taxContextFrom('SG', [], null, AT);
    assert.equal(ctx.scheme, 'NONE');
    assert.equal(ctx.noneReason, 'not_registered');
    const e = engineFor(ctx);
    const r = e.computeSession({ subtotalMinor: 1300, pricesIncludeTax: true });
    assert.deepEqual([r.subtotalMinor, r.taxMinor, r.totalMinor, r.scheme], [1300, 0, 1300, 'NONE']);
    assert.equal(e.labels('en').noTax, 'Not GST-registered');
    assert.equal(e.ocpiVatPercent(), null);
  });

  test('effective-dated rates: 8 % in 2023, 9 % from 1 Jan 2024 (Singapore date)', () => {
    assert.equal(taxContextFrom('SG', SG_REG, null, new Date('2023-12-31T15:00:00Z'), 'Asia/Singapore').rateBps, 800); // 23:00 SGT 31 Dec
    assert.equal(taxContextFrom('SG', SG_REG, null, new Date('2023-12-31T16:30:00Z'), 'Asia/Singapore').rateBps, 900); // 00:30 SGT 1 Jan
    assert.equal(rateRowAt('SG_GST', new Date('2024-06-01T00:00:00Z'))?.rateBps, 900);
  });

  test('a registration that ended, or starts later, does not apply', () => {
    assert.equal(taxContextFrom('SG', [reg({ country_code: 'SG', scheme: 'SG_GST', effective_to: '2026-01-01' })], null, AT).scheme, 'NONE');
    assert.equal(taxContextFrom('SG', [reg({ country_code: 'SG', scheme: 'SG_GST', effective_from: '2027-01-01' })], null, AT).scheme, 'NONE');
    assert.equal(taxContextFrom('SG', [reg({ country_code: 'MY', scheme: 'MY_SST' })], null, AT).scheme, 'NONE', 'another country\'s registration');
  });

  test('fees, invoice totals and the OCPI VAT', () => {
    const e = engineFor(taxContextFrom('SG', SG_REG, null, AT));
    assert.deepEqual(e.computeFee({ amountMinor: 500, registered: true }), { netMinor: 500, taxBaseMinor: 500, taxMinor: 45, totalMinor: 545, taxRateBps: 900 });
    assert.deepEqual(e.computeFee({ amountMinor: 545, inclusive: true, registered: true }), { netMinor: 500, taxBaseMinor: 500, taxMinor: 45, totalMinor: 545, taxRateBps: 900 });
    assert.deepEqual(e.invoiceTotals({ taxableMinor: 10_000, untaxedMinor: 50 }), { taxBaseMinor: 10_000, taxMinor: 900, totalMinor: 10_950 });
    assert.equal(e.ocpiVatPercent(), 9);
    assert.equal(e.labels('en').tax, 'GST 9%');
  });
});

describe('Malaysian service tax (MY_SST)', () => {
  test('default: no service tax on charging (not registered) [VERIFY V1]', () => {
    const ctx = taxContextFrom('MY', [], null, AT);
    assert.equal(ctx.scheme, 'NONE');
    assert.equal(ctx.currency, 'MYR');
    const r = engineFor(ctx).computeSession({ subtotalMinor: 1440, pricesIncludeTax: true });
    assert.deepEqual([r.subtotalMinor, r.taxMinor, r.totalMinor], [1440, 0, 1440]);
    assert.equal(engineFor(ctx).labels('en').noTax, 'No tax charged');
  });

  test('registered, but EV charging not confirmed taxable: still none', () => {
    const ctx = taxContextFrom('MY', [reg({ country_code: 'MY', scheme: 'MY_SST', ev_charging_taxable: false })], null, AT);
    assert.equal(ctx.scheme, 'NONE');
    assert.equal(ctx.noneReason, 'not_taxable');
  });

  test('switched on (registered and taxable): 8 %, exclusive and inclusive', () => {
    const ctx = taxContextFrom('MY', [reg({ country_code: 'MY', scheme: 'MY_SST' })], null, AT);
    assert.equal(ctx.scheme, 'MY_SST');
    assert.equal(ctx.rateBps, 800);
    const e = engineFor(ctx);
    const ex = e.computeSession({ subtotalMinor: 1200, pricesIncludeTax: false });
    assert.deepEqual([ex.subtotalMinor, ex.taxMinor, ex.totalMinor], [1200, 96, 1296]);
    const inc = e.computeSession({ subtotalMinor: 1296, pricesIncludeTax: true });
    assert.deepEqual([inc.subtotalMinor, inc.taxMinor, inc.totalMinor], [1200, 96, 1296]);
    assert.equal(e.labels('en').tax, 'Service tax 8%');
    assert.equal(e.ocpiVatPercent(), 8);
  });

  test('a registration\'s own rate wins (6 % groups)', () => {
    const ctx = taxContextFrom('MY', [reg({ country_code: 'MY', scheme: 'MY_SST', rate_bps: 600 })], null, AT);
    assert.equal(engineFor(ctx).computeSession({ subtotalMinor: 1000 }).taxMinor, 60);
  });

  test('before 1 Mar 2024 the default rate was 6 %', () => {
    assert.equal(taxContextFrom('MY', [reg({ country_code: 'MY', scheme: 'MY_SST' })], null, new Date('2024-02-15T00:00:00Z')).rateBps, 600);
  });
});

describe('Indonesia (ID_PPN_PBJT) behind the interface', () => {
  test('the engine is the v1.6 computeTax', () => {
    const ctx = taxContextFrom('ID', [], null, AT);
    assert.equal(ctx.scheme, 'ID_PPN_PBJT');
    assert.equal(ctx.currency, 'IDR');
    for (const sub of [0, 1, 12_345, 1_000_000]) {
      for (const bps of [0, 500, 1000]) {
        assert.deepEqual(engineFor(ctx).computeSession({ subtotalMinor: sub, energyMinor: sub, localTaxRateBps: bps }), computeTax({ subtotalMinor: sub, energyMinor: sub, localTaxRateBps: bps }));
      }
    }
    const r = computeTax({ subtotalMinor: 12_000_000, localTaxRateBps: 0 });
    assert.deepEqual([r.taxBaseMinor, r.taxMinor, r.totalMinor, r.taxRateBps, r.scheme], [11_000_000, 1_320_000, 13_320_000, 1200, 'ID_PPN_PBJT']);
    assert.deepEqual(r.detail, { dppFraction: '11/12', localTaxBase: 'energy', localTaxInTaxBase: true });
  });

  test('PKP fee tax is the v1.6 PKP_TAX', () => {
    const e = engineFor(taxContextFrom('ID', [], null, AT));
    assert.deepEqual(e.computeFee({ amountMinor: 5000, registered: true }), { netMinor: 5000, taxBaseMinor: 4583, taxMinor: 550, totalMinor: 5550, taxRateBps: 1200 });
    assert.deepEqual(e.computeFee({ amountMinor: 5000, registered: false }), { netMinor: 5000, taxBaseMinor: 0, taxMinor: 0, totalMinor: 5000, taxRateBps: 0 });
    assert.equal(e.ocpiVatPercent(true), 11);
    assert.equal(e.ocpiVatPercent(false), 0);
  });
});

describe('site exemption (site.tax_overrides) — honoured by every engine', () => {
  for (const [country, regs] of [['ID', []], ['SG', SG_REG], ['MY', [reg({ country_code: 'MY', scheme: 'MY_SST' })]]] as const) {
    test(`${country}: an exempt site is taxed NONE, with the reason`, () => {
      const ctx = taxContextFrom(country, [...regs], { exempt: true, reason: 'private depot' }, AT);
      assert.equal(ctx.scheme, 'NONE');
      assert.equal(ctx.noneReason, 'exempt');
      const r = engineFor(ctx).computeSession({ subtotalMinor: 5000, localTaxRateBps: 1000 });
      assert.deepEqual([r.taxMinor, r.localTaxMinor, r.totalMinor], [0, 0, 5000]);
      assert.deepEqual(r.detail, { reason: 'exempt' });
    });
  }
});

describe('console tariff preview reads the Indonesian breakdown as the engine returns it', () => {
  test('every tx.<field> of the Indonesian preview (web/js/views/tariffs.js) exists in computeTax()', async () => {
    // 1.9.0-dev read tx.ppnRateBps (renamed taxRateBps in v1.7), so the preview printed "PPN 0% of DPP" over a
    // 12 % PPN amount. The Indonesian branch is the last `const tx = p.tax` block of the preview.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../web/js/views/tariffs.js', import.meta.url), 'utf8');
    const start = src.lastIndexOf('const tx = p.tax ?? {};');
    assert.ok(start > 0);
    const block = src.slice(start, src.indexOf('</tfoot>', start));
    const read = [...new Set([...block.matchAll(/\btx\.([A-Za-z]+)/g)].map((m) => m[1]!))];
    const r = computeTax({ subtotalMinor: 79_350, localTaxRateBps: 500, energyMinor: 49_350 }) as unknown as Record<string, unknown>;
    assert.deepEqual(read.filter((k) => !(k in r)), []);
    assert.equal(r.taxRateBps, 1200);
  });
});
