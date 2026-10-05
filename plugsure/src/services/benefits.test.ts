import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rateSession, applyAdjustments, adjustmentTotals, type Tariff, type PriceAdjustment, type CdrLine } from './tariff.js';
import { adjustmentOptions, pickCheapest, type Benefits } from './benefits.js';

/** A legal DC tariff: Rp 2,400/kWh energy and a Rp 5,000 service fee, PPN on. */
const tariff = {
  id: 't', name: 'DC', currency: 'IDR', plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, ppnApplies: true,
  components: [
    { kind: 'energy', rate: 2400, touBlock: 'ANY' },
    { kind: 'session', rate: 5000, touBlock: 'ANY' },
  ],
} as unknown as Tariff;
const ctx = {
  startedAt: new Date('2026-09-10T03:00:00Z'), endedAt: new Date('2026-09-10T03:40:00Z'),
  energyWh: 20_000, connectorMaxPowerW: 60_000, localTaxRateBps: 1000, timezone: 'Asia/Jakarta',
};
const sum = (lines: CdrLine[], kinds: string[]) => lines.filter((l) => kinds.includes(l.kind)).reduce((a, l) => a + l.amountMinor, 0);

describe('memberships and promotions in rating', () => {
  const base = rateSession(tariff, ctx);

  test('a discount is a negative line of the kind it reduces, before PBJT-TL and PPN', () => {
    const r = rateSession(tariff, { ...ctx, adjustments: [{ source: 'promotion', id: 'p', name: 'Happy hour', energyPercentOffBps: 2000 }] });
    const disc = r.lines.filter((l) => l.adjustment);
    assert.equal(disc.length, 1);
    assert.equal(disc[0]!.kind, 'energy');
    assert.equal(disc[0]!.amountMinor, -Math.round(48_000 * 0.2));
    // PBJT is on electricity: it falls with the energy discount; PPN follows the lower price.
    assert.equal(r.tax.subtotalMinor, base.tax.subtotalMinor - 9_600);
    assert.equal(r.tax.localTaxMinor, Math.round(((48_000 - 9_600) * 1000) / 10_000));
    assert.ok(r.tax.taxMinor < base.tax.taxMinor && r.tax.totalMinor < base.tax.totalMinor);
  });

  test('member price per kWh applies only where it is lower', () => {
    const cheaper = applyAdjustments(structuredClone(base.lines), [{ source: 'subscription', id: 's', name: 'Member', energyRate: 2000 }], 20);
    assert.equal(sum(cheaper, ['energy']), 40_000);
    const dearer = applyAdjustments(structuredClone(base.lines), [{ source: 'subscription', id: 's', name: 'Member', energyRate: 3000 }], 20);
    assert.equal(sum(dearer, ['energy']), 48_000);
  });

  test('included kWh at the average price, fees waived, and rupiah off never go below zero', () => {
    const a: PriceAdjustment = { source: 'subscription', id: 's', name: 'Member', freeKwh: 5, waiveSessionFees: true };
    const lines = applyAdjustments(structuredClone(base.lines), [a], 20);
    assert.equal(sum(lines, ['energy']), 48_000 - 12_000);
    assert.equal(sum(lines, ['session', 'admin']), 0);
    const big = applyAdjustments(structuredClone(base.lines), [{ source: 'promotion', id: 'p', name: 'Gratis', amountOffMinor: 1_000_000 }], 20);
    assert.equal(sum(big, ['energy']), 0);
    assert.equal(sum(big, ['session']), 0);
    assert.equal(adjustmentTotals(big).get('p')!.discountMinor, 53_000);
  });

  test('a membership then a promotion: each works on what the one before left', () => {
    const lines = applyAdjustments(structuredClone(base.lines), [
      { source: 'subscription', id: 's', name: 'Member', energyPercentOffBps: 1000 },
      { source: 'promotion', id: 'p', name: 'Promo', energyPercentOffBps: 1000 },
    ], 20);
    assert.equal(sum(lines, ['energy']), Math.round(48_000 * 0.9) - Math.round(48_000 * 0.9 * 0.1));
    const t = adjustmentTotals(lines);
    assert.equal(t.get('s')!.discountMinor, 4_800);
    assert.equal(t.get('p')!.discountMinor, 4_320);
  });

  test('the cheapest allowed combination wins; a non-stacking promotion replaces the membership', () => {
    const b: Benefits = {
      customerKey: 'card:x', codeProblem: null,
      membership: { subscriptionId: 's', planId: 'pl', planName: 'Member', periodStart: new Date(), remainingKwh: 0, adjustment: { source: 'subscription', id: 's', name: 'Member', energyPercentOffBps: 1000 } },
      promotions: [
        { id: 'p1', name: 'Stacks 5%', stacks: true, adjustment: { source: 'promotion', id: 'p1', name: 'Stacks 5%', energyPercentOffBps: 500 } },
        { id: 'p2', name: 'Alone 30%', stacks: false, adjustment: { source: 'promotion', id: 'p2', name: 'Alone 30%', energyPercentOffBps: 3000 } },
        { id: 'p3', name: 'Big session only', stacks: true, adjustment: Object.assign({ source: 'promotion' as const, id: 'p3', name: 'Min 50 kWh', energyPercentOffBps: 5000 }, { minKwh: 50 }) },
      ],
    };
    const opts = adjustmentOptions(b, 20);
    assert.equal(opts.length, 3, 'the 50 kWh-minimum promotion is not offered for 20 kWh');
    const best = pickCheapest(opts, (a) => { const r = rateSession(tariff, { ...ctx, adjustments: a }); return { ...r, total: r.tax.totalMinor }; });
    assert.deepEqual(best.option.map((a) => a.id), ['p2'], '30% alone beats 10% + 5%');
    const plain = pickCheapest(adjustmentOptions({ ...b, promotions: [] }, 20), (a) => { const r = rateSession(tariff, { ...ctx, adjustments: a }); return { ...r, total: r.tax.totalMinor }; });
    assert.deepEqual(plain.option.map((a) => a.id), ['s']);
  });

  test('no adjustments: rating is unchanged', () => {
    assert.deepEqual(rateSession(tariff, { ...ctx, adjustments: [] }).tax, base.tax);
  });
});
