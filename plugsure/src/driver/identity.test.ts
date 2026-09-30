import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalisePhone } from './identity.js';

/**
 * Indonesian drivers type their number every way imaginable. Guest-first means
 * the OTP step is the ONE place an account holder is asked for input, so it has
 * to accept 08…, +62…, 62… and 8… and land on the same E.164 identity — or the
 * same person becomes two accounts.
 */
describe('phone normalisation', () => {
  const cases: Array<[string, string]> = [
    ['081234567890', '+6281234567890'],
    ['0812-3456-7890', '+6281234567890'],
    ['+6281234567890', '+6281234567890'],
    ['6281234567890', '+6281234567890'],
    ['81234567890', '+6281234567890'],
    ['+62 812 3456 7890', '+6281234567890'],
  ];
  for (const [input, expected] of cases) {
    test(`${input} → ${expected}`, () => assert.equal(normalisePhone(input), expected));
  }

  test('all four forms of one number collapse to a single identity', () => {
    const forms = ['081234567890', '+6281234567890', '6281234567890', '81234567890'];
    const set = new Set(forms.map(normalisePhone));
    assert.equal(set.size, 1);
  });

  test('rubbish is rejected rather than guessed', () => {
    for (const bad of ['', '123', '02112345678', 'not-a-phone', '0812']) {
      assert.equal(normalisePhone(bad), null, `${bad} should be rejected`);
    }
  });
});
