import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bpsOf, computeFees, creditFees, feePlanProblem, sideFee, sideOf, type FeePlan, type SideFee } from './fees.js';

/** Hub commission arithmetic (§8.4): minor units, half-up, clamp, credit reversal. */
describe('hub commission', () => {
  const side = (o: Partial<SideFee> = {}): SideFee => ({ bps: 0, fixedMinor: 0, minMinor: 0, maxMinor: null, ...o });

  test('basis points are rounded half-up in exact integer arithmetic', () => {
    assert.equal(bpsOf(10_000, 300), 300);
    assert.equal(bpsOf(1_617, 300), 49); // 48.51 → 49
    assert.equal(bpsOf(1_650, 300), 50); // 49.5 → 50 (half up)
    assert.equal(bpsOf(1_649, 300), 49); // 49.47
    assert.equal(bpsOf(5, 1_000), 1);    // 0.5 → 1
    assert.equal(bpsOf(4, 1_000), 0);    // 0.4 → 0
    assert.equal(bpsOf(-1_650, 300), -50, 'symmetric for negatives');
    // A large IDR total: no floating point drift.
    assert.equal(bpsOf(987_654_321_987, 333), 32_888_888_922);
    assert.throws(() => bpsOf(1.5, 300));
  });

  test('IDR (whole rupiah) and MYR/SGD (sen/cents) use the same minor-unit arithmetic', () => {
    // Rp 45.000 at 3 % = Rp 1.350; RM 16.20 (1620 sen) at 3 % = 48.6 → 49 sen; S$ 0.05 (5 cents) at 2.5 % → 0.125 → 0
    assert.equal(sideFee(45_000, side({ bps: 300 })), 1_350);
    assert.equal(sideFee(1_620, side({ bps: 300 })), 49);
    assert.equal(sideFee(5, side({ bps: 250 })), 0);
  });

  test('fixed per-CDR fee, minimum and maximum', () => {
    assert.equal(sideFee(10_000, side({ bps: 300, fixedMinor: 100 })), 400);
    assert.equal(sideFee(1_000, side({ bps: 300, minMinor: 50 })), 50, 'minimum applies');
    assert.equal(sideFee(1_000_000, side({ bps: 300, maxMinor: 10_000 })), 10_000, 'maximum caps');
    assert.equal(sideFee(0, side({ fixedMinor: 100 })), 100, 'a free session still pays the per-session fee');
    assert.equal(sideFee(0, side()), 0, 'the placeholder plans charge nothing');
    assert.throws(() => sideFee(-1, side({ bps: 300 })), /credit/);
  });

  test('both sides at once, from a plan row', () => {
    const plan = { cpo_bps: 300, cpo_fixed_minor: '0', cpo_min_minor: '25', cpo_max_minor: null, emsp_bps: 0, emsp_fixed_minor: '100', emsp_min_minor: '0', emsp_max_minor: '150' } as unknown as FeePlan;
    assert.deepEqual(computeFees(1_500, sideOf(plan, 'cpo'), sideOf(plan, 'emsp')), { cpo: 45, emsp: 100 });
    assert.deepEqual(computeFees(500, sideOf(plan, 'cpo'), sideOf(plan, 'emsp')), { cpo: 25, emsp: 100 });
  });

  test('a credit CDR reverses its original\'s frozen fees exactly (the minimum is not applied twice)', () => {
    assert.deepEqual(creditFees({ exclMinor: 1_500, feeCpo: 45, feeEmsp: 100 }, -1_500), { cpo: -45, emsp: -100 });
    assert.deepEqual(creditFees({ exclMinor: 500, feeCpo: 25, feeEmsp: 100 }, -500), { cpo: -25, emsp: -100 }, 'a fee at its minimum is reversed as frozen');
    assert.deepEqual(creditFees({ exclMinor: 0, feeCpo: 0, feeEmsp: 100 }, 0), { cpo: 0, emsp: -100 });
  });

  test('a partial credit reverses pro rata, never more than the original', () => {
    assert.deepEqual(creditFees({ exclMinor: 1_500, feeCpo: 45, feeEmsp: 100 }, -500), { cpo: -15, emsp: -33 });
    assert.deepEqual(creditFees({ exclMinor: 1_000, feeCpo: 30, feeEmsp: 100 }, -250), { cpo: -8, emsp: -25 }); // 7.5 → 8
    assert.deepEqual(creditFees({ exclMinor: 1_000, feeCpo: 30, feeEmsp: 100 }, -9_999), { cpo: -30, emsp: -100 });
  });

  test('fee plan validation', () => {
    assert.equal(feePlanProblem({ cpo_bps: 300, emsp_fixed_minor: 100 }), null);
    assert.match(feePlanProblem({ cpo_bps: 5001 })!, /cpo_bps/);
    assert.match(feePlanProblem({ cpo_bps: 2.5 })!, /cpo_bps/);
    assert.match(feePlanProblem({ emsp_fixed_minor: -1 })!, /emsp_fixed_minor/);
    assert.match(feePlanProblem({ cpo_min_minor: 100, cpo_max_minor: 50 })!, /below/);
  });
});
