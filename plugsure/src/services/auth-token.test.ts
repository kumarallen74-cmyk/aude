import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { splitApiKey, sessionSecret } from './auth.js';

/**
 * The credential format is `psk_<12 hex>_<base64url secret>`. base64url's
 * alphabet includes `_`, and the parser split on EVERY `_` and required exactly
 * three parts -- so any key whose 43-character secret happened to contain an
 * underscore was rejected with an ordinary 401. At 43 characters drawn from a
 * 64-symbol alphabet that is roughly half of all issued credentials, failing
 * non-deterministically and indistinguishably from a wrong password.
 */
describe('credential parsing tolerates base64url', () => {
  test('a secret containing underscores round-trips', () => {
    const prefix = 'a1b2c3d4e5f6';
    const secret = 'abc_def_ghi-jkl';
    const parsed = splitApiKey(`psk_${prefix}_${secret}`);
    assert.deepEqual(parsed, { prefix, secret });
  });

  test('every randomly generated key parses back to what was issued', () => {
    let withUnderscore = 0;
    for (let i = 0; i < 2_000; i++) {
      const prefix = randomBytes(6).toString('hex');
      const secret = randomBytes(32).toString('base64url');
      if (secret.includes('_')) withUnderscore++;
      const parsed = splitApiKey(`psk_${prefix}_${secret}`);
      assert.deepEqual(parsed, { prefix, secret }, `failed on secret ${secret}`);
    }
    // Sanity: the hazard is real at this rate, not a theoretical edge case.
    assert.ok(withUnderscore > 500, `only ${withUnderscore}/2000 secrets contained an underscore`);
  });

  test('malformed keys are still refused', () => {
    assert.equal(splitApiKey('psk_short'), null);
    assert.equal(splitApiKey('nounderscores'), null);
    assert.equal(splitApiKey('psk_NOTHEX123456_secret'), null, 'the prefix must be hex');
    assert.equal(splitApiKey('psk_a1b2c3d4e5f6_'), null, 'an empty secret is not a credential');
  });

  test('session tokens take everything after the first separator', () => {
    assert.equal(sessionSecret('pss_abc_def'), 'abc_def');
    assert.equal(sessionSecret('pss_'), null);
    assert.equal(sessionSecret('nope'), null);
  });
});
