import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectRollover } from './sessions.js';

/**
 * A register that goes backwards is either a wrap or a fault, and the two must
 * not be confused: one is real energy that must be billed, the other is energy
 * that was never delivered and must never be.
 *
 * The previous detector accepted any candidate whose implied delivery was under
 * 500 kWh, which is not a test at all for a 16-bit width: for ANY start below
 * 65,536 Wh the implied energy is always under 500 kWh, so every backwards
 * reading from a charger whose lifetime meter had not yet passed 65.5 kWh was
 * billed as a wrap. That is every newly commissioned unit.
 */
describe('meter register rollover', () => {
  test('a young meter reporting zero is a FAULT, not a wrap', () => {
    // 45 kWh lifetime, firmware reports 0 at StopTransaction. Previously billed
    // 20,536 Wh of energy that never existed.
    assert.equal(detectRollover(45_000, 0), null);
  });

  test('a meter swap that lands lower is a FAULT, not a wrap', () => {
    assert.equal(detectRollover(60_000, 55_000), null);
  });

  test('no start value below 65.5 kWh is ever treated as a 16-bit wrap', () => {
    for (let start = 0; start < 65_536; start += 137) {
      for (const stop of [0, 1, 500, 5_000, 30_000]) {
        if (stop >= start) continue;
        const r = detectRollover(start, stop);
        assert.equal(r, null, `start=${start} stop=${stop} was accepted as ${r?.width}`);
      }
    }
  });

  test('a genuine 6-digit Wh wrap is detected and billed', () => {
    const r = detectRollover(999_000, 700);
    assert.deepEqual(r, { width: '6-digit Wh', energyWh: 1_700 });
  });

  test('a genuine 7-digit Wh wrap is detected', () => {
    const r = detectRollover(9_995_000, 2_000);
    assert.equal(r?.energyWh, 7_000);
  });

  test('near the top but not restarted from zero is still a fault', () => {
    // The register fell from 999,000 to 800,000: nothing about that is a wrap.
    assert.equal(detectRollover(999_000, 800_000), null);
  });

  test('a declared register width from the quirk registry removes the guesswork', () => {
    assert.deepEqual(detectRollover(65_500, 36, 65_536), { width: 'declared 65536', energyWh: 72 });
    // ...and still refuses a value that is not shaped like a wrap.
    assert.equal(detectRollover(45_000, 0, 65_536), null);
  });
});
