import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { subscriptionCeilingW, clampCeilingW, wattsToKva } from './smartcharging.js';

/**
 * The subscribed capacity (connected kVA x PF) is the hard ceiling the load
 * manager must never allocate past — otherwise an oversubscribed site can draw
 * over its PLN subscription. These guard the clamp that enforces it.
 *
 * Worked from the real Star Charger Hub numbers: 250 kVA subscribed, PF 0.95,
 * two 120 kW guns (240 kW = 252.63 kVA installed). A ceiling wrongly set to the
 * 240 kW nameplate must be pulled back to 237.5 kW (= 250 kVA x 0.95).
 */

describe('subscriptionCeilingW', () => {
  test('250 kVA at PF 0.95 = 237,500 W', () => {
    assert.equal(subscriptionCeilingW(250, 0.95), 237_500);
  });
  test('unknown subscribed capacity does not cap (Infinity)', () => {
    assert.equal(subscriptionCeilingW(null, 0.95), Infinity);
    assert.equal(subscriptionCeilingW(undefined, 0.95), Infinity);
  });
  test('a degenerate PF is floored at 0.1 so it never divides-by-zero or over-caps', () => {
    assert.equal(subscriptionCeilingW(100, 0), Math.round(100 * 1000 * 0.1));
  });
});

describe('clampCeilingW', () => {
  test('the Star Charger Hub bug: 240 kW ceiling is clamped to 237.5 kW', () => {
    assert.equal(clampCeilingW(240_000, 250, 0.95), 237_500);
  });
  test('a ceiling at or below the subscription is respected unchanged', () => {
    assert.equal(clampCeilingW(230_000, 250, 0.95), 230_000);
    assert.equal(clampCeilingW(237_500, 250, 0.95), 237_500);
  });
  test('no subscribed capacity known -> no clamp applied', () => {
    assert.equal(clampCeilingW(240_000, null, 0.95), 240_000);
  });
});

describe('sanity — the on-screen figures', () => {
  test('120 kW at PF 0.95 = 126.32 kVA (active draw)', () => {
    assert.equal(Math.round(wattsToKva(120_000, 0.95) * 100) / 100, 126.32);
  });
  test('240 kW nameplate at PF 0.95 = 252.63 kVA (installed) — above the 250 kVA subscription', () => {
    assert.equal(Math.round(wattsToKva(240_000, 0.95) * 100) / 100, 252.63);
    assert.ok(wattsToKva(240_000, 0.95) > 250, 'nameplate exceeds subscription — must be clamped');
  });
});
