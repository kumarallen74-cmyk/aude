import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PLAN, commissionFor, tierFor, computeStatement, normalisePlan, type ChargerInput, type Plan } from './commission-calc.js';

const TAX = { ppnRateBps: 1200, dppNum: 11, dppDen: 12 };
const M = 1_000_000;

const charger = (o: Partial<ChargerInput> = {}): ChargerInput => ({
  chargePointId: 'cp', ocppIdentity: 'CP', displayName: null, siteId: 'S', kind: 'DC', activeFraction: 1,
  sessions: 10, energyWh: 100_000, gtvIdr: 0, pbjtIdr: 0, ppnIdr: 0, grossIdr: 0, mdrIdr: 0, inReview: 0, ...o,
});
const site = { siteId: 'S', name: 'Site', model: 'public' as const };

describe('tiers (published rates)', () => {
  test('upper bounds are inclusive, as published: Rp 500M is Volume ("Volume Rp 150–500M"), Rp 150M is Standard', () => {
    assert.equal(tierFor(DEFAULT_PLAN, 149_999_999).name, 'Standard');
    assert.equal(tierFor(DEFAULT_PLAN, 150 * M).name, 'Standard');
    assert.equal(tierFor(DEFAULT_PLAN, 150 * M + 1).name, 'Volume');
    assert.equal(tierFor(DEFAULT_PLAN, 500 * M).name, 'Volume');
    assert.equal(tierFor(DEFAULT_PLAN, 500 * M + 1).name, 'Network');
    assert.equal(commissionFor(DEFAULT_PLAN, 500 * M), 32.5 * M, 'exactly Rp 500M at 6.5%, not 5%');
  });
  test('whole-volume: the whole month at the tier reached', () => {
    assert.equal(commissionFor(DEFAULT_PLAN, 100 * M), 8 * M);
    assert.equal(commissionFor(DEFAULT_PLAN, 200 * M), 13 * M);
    assert.equal(commissionFor(DEFAULT_PLAN, 700 * M), 35 * M);
  });
  test('whole-volume has no cliff: never less than the top of the tier below', () => {
    // Rp 149,999,999 → Rp 12.0M used to drop to Rp 9.75M at the next rupiah.
    assert.equal(commissionFor(DEFAULT_PLAN, 150 * M), 12 * M);
    assert.equal(commissionFor(DEFAULT_PLAN, 150 * M + 1), 12 * M);
    assert.equal(commissionFor(DEFAULT_PLAN, 180 * M), 12 * M, '6.5% of 180M (11.7M) is below the Standard top');
    assert.equal(commissionFor(DEFAULT_PLAN, 600 * M), 32.5 * M, '5% of 600M (30M) is below the Volume top');
    assert.equal(commissionFor(DEFAULT_PLAN, 650 * M), 32.5 * M);
    let prev = 0;
    for (let g = 0; g <= 800 * M; g += 2_500_000) {
      const c = commissionFor(DEFAULT_PLAN, g);
      assert.ok(c >= prev, `commission fell at Rp ${g}`);
      prev = c;
    }
    for (const b of [150 * M, 500 * M]) {
      assert.ok(commissionFor(DEFAULT_PLAN, b + 1) >= commissionFor(DEFAULT_PLAN, b), `no drop crossing Rp ${b}`);
    }
  });
  test('marginal: each band at its own rate, no cliff at the boundary', () => {
    const p: Plan = { ...DEFAULT_PLAN, tierMode: 'marginal' };
    assert.equal(commissionFor(p, 600 * M), 12 * M + 22.75 * M + 5 * M);
    const below = commissionFor(p, 150 * M - 1), at = commissionFor(p, 150 * M);
    assert.ok(at >= below, 'never less commission for more turnover');
  });
  test('nothing sold, no commission', () => assert.equal(commissionFor(DEFAULT_PLAN, 0), 0));
});

describe('statement', () => {
  test('commission base excludes PBJT and PPN; busy charger pays no minimum', () => {
    const s = computeStatement(DEFAULT_PLAN, '2026-09', 30, [site], [charger({ gtvIdr: 10 * M, pbjtIdr: 1 * M, ppnIdr: 1.2 * M, grossIdr: 12.2 * M })], TAX);
    assert.equal(s.totals.gtvIdr, 10 * M);
    assert.equal(s.totals.commissionIdr, 800_000);
    assert.equal(s.totals.minimumTopUpIdr, 0);
    assert.equal(s.sites[0]!.rateBps, 800);
  });
  test('a quiet charger is topped up to the minimum, credited against its commission', () => {
    const s = computeStatement(DEFAULT_PLAN, '2026-09', 30, [site], [charger({ gtvIdr: 1 * M })], TAX);
    const c = s.sites[0]!.chargers[0]!;
    assert.equal(c.commissionIdr, 80_000);
    assert.equal(c.topUpIdr, 270_000);
    assert.equal(c.feeIdr, 350_000);
  });
  test('minimum is per charger, tier is per site: a busy charger never covers a quiet one', () => {
    const s = computeStatement(DEFAULT_PLAN, '2026-09', 30, [site], [
      charger({ chargePointId: 'a', gtvIdr: 20 * M }),
      charger({ chargePointId: 'b', gtvIdr: 0 }),
    ], TAX);
    assert.equal(s.totals.commissionIdr, 1_600_000);
    assert.equal(s.totals.minimumTopUpIdr, 350_000);
  });
  test('the minimum is pro-rated for a charger commissioned mid-month', () => {
    const s = computeStatement(DEFAULT_PLAN, '2026-09', 30, [site], [charger({ activeFraction: 10 / 30 })], TAX);
    assert.equal(s.sites[0]!.chargers[0]!.minimumIdr, 116_667);
    assert.equal(s.sites[0]!.chargers[0]!.activeDays, 10);
  });
  test('published minimums: AC Rp 150,000, DC Rp 350,000', () => {
    const s = computeStatement(DEFAULT_PLAN, '2026-09', 30, [site], [
      charger({ chargePointId: 'ac', kind: 'AC' }), charger({ chargePointId: 'dc', kind: 'DC' }),
    ], TAX);
    const by = Object.fromEntries(s.sites[0]!.chargers.map((c) => [c.chargePointId, c.minimumIdr]));
    assert.deepEqual(by, { ac: 150_000, dc: 350_000 });
  });
  test('a quiet AC charger: commission Rp 47,200 on a Rp 590,000 month tops up to Rp 150,000', () => {
    const s = computeStatement(DEFAULT_PLAN, '2026-09', 30, [site], [charger({ kind: 'AC', gtvIdr: 590_000 })], TAX);
    const c = s.sites[0]!.chargers[0]!;
    assert.equal(c.commissionIdr, 47_200);
    assert.equal(c.topUpIdr, 102_800);
    assert.equal(c.feeIdr, 150_000);
  });
  test('private site: flat fee per charger type, no commission, warned if drivers paid', () => {
    const priv = { ...site, model: 'private' as const };
    const s = computeStatement(DEFAULT_PLAN, '2026-09', 30, [priv], [
      charger({ chargePointId: 'a', kind: 'AC' }), charger({ chargePointId: 'b', kind: 'DC', gtvIdr: 2 * M }),
    ], TAX);
    assert.equal(s.totals.commissionIdr, 0);
    assert.equal(s.totals.privateFeeIdr, 700_000);
    assert.equal(s.warnings.length, 1);
    assert.match(s.warnings[0]!, /should be public/);
  });
  test('MDR is credited back when the platform bears it (the pricing page default), never below zero', () => {
    const a = computeStatement(DEFAULT_PLAN, '2026-09', 30, [site], [charger({ gtvIdr: 10 * M, mdrIdr: 50_000 })], TAX);
    assert.equal(a.totals.mdrCreditIdr, 50_000);
    assert.equal(a.totals.netIdr, 750_000);
    const b = computeStatement({ ...DEFAULT_PLAN, mdrBorneBy: 'site_owner' }, '2026-09', 30, [site], [charger({ gtvIdr: 10 * M, mdrIdr: 50_000 })], TAX);
    assert.equal(b.totals.mdrCreditIdr, 0);
    const c = computeStatement(DEFAULT_PLAN, '2026-09', 30, [site], [charger({ gtvIdr: 10 * M, mdrIdr: 5 * M })], TAX);
    assert.equal(c.totals.netIdr, 0);
  });
  test('PPN on the platform fee: DPP 11/12, PPN 12% of DPP (11% effective); PPh 23 shown at 2%', () => {
    const s = computeStatement(DEFAULT_PLAN, '2026-09', 30, [site], [charger({ gtvIdr: 12 * M })], TAX);
    assert.equal(s.totals.netIdr, 960_000);
    assert.equal(s.totals.dppIdr, 880_000);
    assert.equal(s.totals.ppnIdr, 105_600);
    assert.equal(s.totals.totalIdr, 1_065_600);
    assert.equal(s.totals.pph23Idr, 19_200);
  });
  test('site commission is shared across chargers by turnover and adds up', () => {
    const p: Plan = { ...DEFAULT_PLAN, tierMode: 'marginal' };
    const s = computeStatement(p, '2026-09', 30, [site], [
      charger({ chargePointId: 'a', gtvIdr: 100 * M }), charger({ chargePointId: 'b', gtvIdr: 100 * M }),
    ], TAX);
    assert.equal(s.totals.commissionIdr, 12 * M + 3.25 * M);
  });
});

describe('owner and platform shares', () => {
  test('base = owner share + platform share + MDR, whoever bears the MDR', () => {
    for (const mdrBorneBy of ['platform', 'site_owner'] as const) {
      const s = computeStatement({ ...DEFAULT_PLAN, mdrBorneBy }, '2026-09', 30, [site], [charger({ gtvIdr: 10 * M, mdrIdr: 70_000 })], TAX);
      const t = s.totals;
      assert.equal(t.ownerShareIdr + t.platformShareIdr + t.mdrEstimateIdr, t.gtvIdr, mdrBorneBy);
    }
  });
  test('platform bears MDR: the owner keeps base less the fee (MDR credited back)', () => {
    const s = computeStatement(DEFAULT_PLAN, '2026-09', 30, [site], [charger({ gtvIdr: 10 * M, mdrIdr: 70_000 })], TAX);
    assert.equal(s.totals.platformShareIdr, 800_000 - 70_000);
    assert.equal(s.totals.ownerShareIdr, 10 * M - 800_000);
  });
  test('a private site that sold nothing has a negative owner share: it pays the platform fee', () => {
    const s = computeStatement(DEFAULT_PLAN, '2026-09', 30, [{ ...site, model: 'private' }], [charger({ kind: 'AC' })], TAX);
    assert.equal(s.totals.ownerShareIdr, -250_000);
    assert.equal(s.totals.platformShareIdr, 250_000);
  });
  test('site shares add up to the totals', () => {
    const s = computeStatement(DEFAULT_PLAN, '2026-09', 30, [site, { siteId: 'T', name: 'Two', model: 'public' }], [
      charger({ chargePointId: 'a', gtvIdr: 5 * M, mdrIdr: 10_000 }), charger({ chargePointId: 'b', siteId: 'T', gtvIdr: 1 * M }),
    ], TAX);
    assert.equal(s.sites.reduce((a, x) => a + x.ownerShareIdr, 0), s.totals.ownerShareIdr);
    assert.equal(s.sites.reduce((a, x) => a + x.platformShareIdr, 0), s.totals.platformShareIdr);
  });
});

describe('plan validation', () => {
  test('defaults are the published rates', () => {
    const r = normalisePlan({});
    assert.ok('plan' in r && r.plan.tiers.map((t) => t.rateBps).join() === '800,650,500');
    assert.ok('plan' in r && r.plan.minPerChargerAcIdr === 150_000 && r.plan.minPerChargerDcIdr === 350_000);
  });
  test('the "follow published rates" marker resolves to today\'s published plan', () => {
    const r = normalisePlan({ published: true });
    assert.ok('plan' in r && JSON.stringify(r.plan) === JSON.stringify((normalisePlan(DEFAULT_PLAN) as any).plan));
  });
  test('refuses unordered tiers, open middle tiers and absurd rates', () => {
    assert.ok('error' in normalisePlan({ tiers: [{ upToIdr: 500 * M, rateBps: 800 }, { upToIdr: 150 * M, rateBps: 650 }, { upToIdr: null, rateBps: 500 }] }));
    assert.ok('error' in normalisePlan({ tiers: [{ upToIdr: null, rateBps: 800 }, { upToIdr: null, rateBps: 650 }] }));
    assert.ok('error' in normalisePlan({ tiers: [{ upToIdr: null, rateBps: 9000 }] }));
    assert.ok('error' in normalisePlan({ tierMode: 'banded' }));
  });
});
