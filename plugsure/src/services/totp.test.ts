import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  hashRecoveryCode,
  hotp,
  looksLikeTotp,
  matchTotp,
  otpauthUri,
  timeStep,
  totp,
} from './totp.js';

/**
 * TOTP for the console's two-step verification, against the published test vectors:
 * RFC 4226 Appendix D (HOTP) and RFC 6238 Appendix B (TOTP, SHA-1/256/512, 8 digits).
 */

const SEED_SHA1 = Buffer.from('12345678901234567890', 'ascii');
const SEED_SHA256 = Buffer.from('12345678901234567890123456789012', 'ascii');
const SEED_SHA512 = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'ascii');

describe('RFC test vectors', () => {
  test('RFC 4226 Appendix D: HOTP, counters 0..9', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => assert.equal(hotp(SEED_SHA1, counter), code, `counter ${counter}`));
  });

  test('RFC 6238 Appendix B: TOTP, SHA-1 / SHA-256 / SHA-512, 8 digits', () => {
    const vectors: Array<[number, string, string, string]> = [
      [59, '94287082', '46119246', '90693936'],
      [1111111109, '07081804', '68084774', '25091201'],
      [1111111111, '14050471', '67062674', '99943326'],
      [1234567890, '89005924', '91819424', '93441116'],
      [2000000000, '69279037', '90698825', '38618901'],
      [20000000000, '65353130', '77737706', '47863826'],
    ];
    for (const [t, sha1, sha256, sha512] of vectors) {
      const ms = t * 1000;
      assert.equal(totp(SEED_SHA1, ms, { digits: 8, algorithm: 'sha1' }), sha1, `SHA-1 at ${t}`);
      assert.equal(totp(SEED_SHA256, ms, { digits: 8, algorithm: 'sha256' }), sha256, `SHA-256 at ${t}`);
      assert.equal(totp(SEED_SHA512, ms, { digits: 8, algorithm: 'sha512' }), sha512, `SHA-512 at ${t}`);
    }
  });

  test('the six-digit code an authenticator app shows is the last six digits of the SHA-1 vector', () => {
    assert.equal(totp(SEED_SHA1, 59_000), '287082');
    assert.equal(totp(SEED_SHA1, 1111111109_000), '081804');
  });
});

describe('matching a code', () => {
  const now = 1_790_000_000_000;
  const step = timeStep(now);

  test('accepts the current step and one either side (clock drift), nothing further', () => {
    assert.equal(matchTotp(SEED_SHA1, hotp(SEED_SHA1, step), now), step);
    assert.equal(matchTotp(SEED_SHA1, hotp(SEED_SHA1, step - 1), now), step - 1);
    assert.equal(matchTotp(SEED_SHA1, hotp(SEED_SHA1, step + 1), now), step + 1);
    assert.equal(matchTotp(SEED_SHA1, hotp(SEED_SHA1, step - 2), now), null);
    assert.equal(matchTotp(SEED_SHA1, hotp(SEED_SHA1, step + 2), now), null);
  });

  test('a code for a step already used (or an earlier one) is refused: no replay', () => {
    const code = hotp(SEED_SHA1, step);
    assert.equal(matchTotp(SEED_SHA1, code, now, step), null, 'the same step again');
    assert.equal(matchTotp(SEED_SHA1, hotp(SEED_SHA1, step - 1), now, step), null, 'an older step');
    assert.equal(matchTotp(SEED_SHA1, hotp(SEED_SHA1, step + 1), now, step), step + 1, 'the next step is fine');
  });

  test('anything but six digits is not a code', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5', null, undefined]) {
      assert.equal(matchTotp(SEED_SHA1, bad as string, now), null, String(bad));
    }
    assert.equal(matchTotp(SEED_SHA1, ` ${hotp(SEED_SHA1, step).slice(0, 3)} ${hotp(SEED_SHA1, step).slice(3)} `, now), step, 'spaces are ignored');
  });
});

describe('secrets, URIs and recovery codes', () => {
  test('base32 round-trips, and decodes what people paste (lower case, spaces, padding)', () => {
    const buf = Buffer.from('12345678901234567890', 'ascii');
    const b32 = base32Encode(buf);
    assert.equal(b32, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.deepEqual(base32Decode(b32), buf);
    assert.deepEqual(base32Decode(b32.toLowerCase().match(/.{4}/g)!.join(' ') + '===='), buf);
    assert.throws(() => base32Decode('NOT1BASE32'), /invalid base32/);
  });

  test('otpauth URI in the Key Uri Format authenticator apps read', () => {
    const u = new URL(otpauthUri({ issuer: 'PlugSure', account: 'ops@example.co.id', secret: SEED_SHA1 }));
    assert.equal(u.protocol, 'otpauth:');
    assert.equal(u.host, 'totp');
    assert.equal(decodeURIComponent(u.pathname), '/PlugSure:ops@example.co.id');
    assert.equal(u.searchParams.get('secret'), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.equal(u.searchParams.get('issuer'), 'PlugSure');
    assert.equal(u.searchParams.get('algorithm'), 'SHA1');
    assert.equal(u.searchParams.get('digits'), '6');
    assert.equal(u.searchParams.get('period'), '30');
  });

  test('recovery codes: ten, distinct, 80 bits, and matched however they are typed back', () => {
    const codes = generateRecoveryCodes();
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
    for (const c of codes) assert.match(c, /^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
    const c = codes[0]!;
    assert.equal(hashRecoveryCode(c.toUpperCase().replace(/-/g, ' ')), hashRecoveryCode(c));
    assert.notEqual(hashRecoveryCode(codes[1]!), hashRecoveryCode(c));
    assert.equal(looksLikeTotp(c), false);
    assert.equal(looksLikeTotp('123456'), true);
  });
});
