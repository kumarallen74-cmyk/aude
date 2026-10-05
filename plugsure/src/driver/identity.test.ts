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
    const set = new Set(forms.map((f) => normalisePhone(f)));
    assert.equal(set.size, 1);
  });

  test('rubbish is rejected rather than guessed', () => {
    for (const bad of ['', '123', '02112345678', 'not-a-phone', '0812']) {
      assert.equal(normalisePhone(bad), null, `${bad} should be rejected`);
    }
  });
});

describe('phone normalisation: Malaysia and Singapore', () => {
  test('Malaysian mobiles: +60, 60…, and local 01… when the app is Malaysian', () => {
    assert.equal(normalisePhone('+60 12-345 6789'), '+60123456789');
    assert.equal(normalisePhone('+601112345678'), '+601112345678', '011 numbers have 8 digits after the prefix');
    assert.equal(normalisePhone('60123456789'), '+60123456789');
    assert.equal(normalisePhone('012-345 6789', 'MY'), '+60123456789');
    assert.equal(normalisePhone('123456789', 'MY'), '+60123456789');
  });
  test('Singapore mobiles: +65 8/9xxxxxxx, and a bare 8-digit number when the app is Singaporean', () => {
    assert.equal(normalisePhone('+65 9123 4567'), '+6591234567');
    assert.equal(normalisePhone('+6581234567'), '+6581234567');
    assert.equal(normalisePhone('9123 4567', 'SG'), '+6591234567');
    assert.equal(normalisePhone('6591234567', 'SG'), '+6591234567');
  });
  test('an Indonesian number keeps its identity whatever the app\'s country', () => {
    for (const c of ['ID', 'MY', 'SG'] as const) assert.equal(normalisePhone('+6281234567890', c), '+6281234567890');
    assert.equal(normalisePhone('081234567890', 'ID'), '+6281234567890');
  });
  test('wrong shapes are refused', () => {
    for (const bad of ['+65 6123 4567', '+60 3-1234 5678', '+44 7700 900123', '91234567', '0123456789']) {
      assert.equal(normalisePhone(bad), null, `${bad} should be rejected (default ID)`);
    }
    assert.equal(normalisePhone('6123 4567', 'SG'), null, 'a Singapore landline is not a mobile');
  });
});
