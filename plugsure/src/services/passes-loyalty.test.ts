import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { unusedValue, switchTerms } from '../driver/membership.js';
import { proratedFee } from './benefits.js';
import { pointsEarned, pointsToRedeem, discountable, pointsAdjustment } from './loyalty.js';
import { applyAdjustments, type CdrLine } from './tariff.js';

const DAY = 86_400_000;
const d = (iso: string) => new Date(iso);

describe('switching passes: the unused value of the current pass', () => {
  const c = { feeMinor: 150_000, periodStart: d('2026-09-01T00:00:00Z'), periodEnd: d('2026-10-01T00:00:00Z') };
  test('the fee over the part of the window still to come', () => {
    assert.equal(unusedValue([c], d('2026-09-21T00:00:00Z')), 50_000);
    assert.equal(unusedValue([c], d('2026-08-01T00:00:00Z')), 150_000); // not started: all of it
    assert.equal(unusedValue([c], d('2026-10-01T00:00:00Z')), 0);
  });
  test('stacked renewals each count', () => {
    const next = { feeMinor: 150_000, periodStart: d('2026-10-01T00:00:00Z'), periodEnd: d('2026-10-31T00:00:00Z') };
    assert.equal(unusedValue([c, next], d('2026-09-21T00:00:00Z')), 200_000);
  });
});

describe('switching passes: what the new plan costs', () => {
  test('a dearer plan: the difference now, for 30 days', () => {
    assert.deepEqual(switchTerms(50_000, 200_000), { payFeeMinor: 150_000, creditUsedMinor: 50_000, periodMs: 30 * DAY });
  });
  test('a cheaper plan: nothing to pay, a longer window at the new plan\'s daily price', () => {
    const t = switchTerms(150_000, 100_000);
    assert.equal(t.payFeeMinor, 0);
    assert.equal(t.creditUsedMinor, 150_000);
    assert.equal(Math.round(t.periodMs / DAY), 45);
  });
  test('an equal plan: free for 30 days; no credit: the full fee', () => {
    assert.deepEqual(switchTerms(100_000, 100_000), { payFeeMinor: 0, creditUsedMinor: 100_000, periodMs: 30 * DAY });
    assert.deepEqual(switchTerms(0, 100_000), { payFeeMinor: 100_000, creditUsedMinor: 0, periodMs: 30 * DAY });
  });
});

describe('fleet memberships: the fee for the days in force', () => {
  const from = d('2026-09-01T00:00:00+07:00');
  const to = d('2026-10-01T00:00:00+07:00');
  test('a whole month: the whole fee', () => {
    assert.deepEqual(proratedFee(150_000, from, to, d('2026-08-10T00:00:00Z'), null), { feeMinor: 150_000, days: 30, daysInPeriod: 30 });
  });
  test('started mid-month (the start day counts), cancelled mid-month, both', () => {
    assert.deepEqual(proratedFee(150_000, from, to, d('2026-09-21T05:00:00+07:00'), null), { feeMinor: 50_000, days: 10, daysInPeriod: 30 });
    assert.deepEqual(proratedFee(150_000, from, to, d('2026-08-01T00:00:00Z'), d('2026-09-11T00:00:00+07:00')), { feeMinor: 50_000, days: 10, daysInPeriod: 30 });
    assert.deepEqual(proratedFee(90_000, from, to, d('2026-09-11T00:00:00+07:00'), d('2026-09-21T00:00:00+07:00')), { feeMinor: 30_000, days: 10, daysInPeriod: 30 });
  });
});

describe('loyalty points', () => {
  const p = { earnPer1000Minor: 1, pointValueMinor: 10, maxRedeemBps: 5000 };
  test('earned per Rp 1,000 of the total, rounded down; nothing on nothing', () => {
    assert.equal(pointsEarned(45_900, p), 45);
    assert.equal(pointsEarned(999, p), 0);
    assert.equal(pointsEarned(45_900, { earnPer1000Minor: 0 }), 0);
  });
  test('spent in whole points, at most the set share of the energy and fees', () => {
    assert.deepEqual(pointsToRedeem(10_000, 40_000, p), { points: 2_000, amountMinor: 20_000 }); // capped at 50%
    assert.deepEqual(pointsToRedeem(1_234, 40_000, p), { points: 1_234, amountMinor: 12_340 }); // the balance
    assert.deepEqual(pointsToRedeem(0, 40_000, p), { points: 0, amountMinor: 0 });
    assert.deepEqual(pointsToRedeem(500, 15, p), { points: 0, amountMinor: 0 }); // less than a point's worth
  });
  test('the discount comes off the energy, then the fees, before tax — as a "loyalty" line', () => {
    const lines: CdrLine[] = [
      { kind: 'energy', description: 'Energy', quantity: 10, unit: 'kWh', unitRate: 2_500, amountMinor: 25_000 },
      { kind: 'session', description: 'Service', quantity: 1, unit: 'session', unitRate: 5_000, amountMinor: 5_000 },
      { kind: 'idle', description: 'Idle', quantity: 5, unit: 'min', unitRate: 1_000, amountMinor: 5_000 },
    ] as CdrLine[];
    assert.equal(discountable(lines), 30_000); // idle fees are not discounted
    const r = pointsToRedeem(5_000, discountable(lines), p);
    applyAdjustments(lines, [pointsAdjustment(r.points, r.amountMinor)], 10);
    const off = lines.filter((l) => l.adjustment?.source === 'loyalty');
    assert.equal(off.reduce((a, l) => a - l.amountMinor, 0), 15_000);
    assert.equal(discountable(lines), 15_000);
  });
});
