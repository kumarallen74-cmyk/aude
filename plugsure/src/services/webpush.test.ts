import test, { describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createPublicKey, createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { encryptPayload, decryptPayload, vapidAuthorization, endpointProblem } from './webpush.js';

const u = (s: string) => Buffer.from(s, 'base64url');
const originalEnv = config.env;
afterEach(() => { (config as { env: string }).env = originalEnv; });

describe('web push: RFC 8291 message encryption', () => {
  test('matches the RFC 8291 Appendix A example byte for byte', () => {
    const body = encryptPayload(
      Buffer.from('When I grow up, I want to be a watermelon'),
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      'BTBZMqHH6r4Tts7J_aSIgg',
      { asPrivate: u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), salt: u('DGv6ra1nlYgDCS1FRnbzlw') },
    );
    assert.equal(
      body.toString('base64url'),
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });
  test('a phone decrypts what the server encrypted; a different phone cannot', () => {
    const ua = createECDH('prime256v1'); ua.generateKeys();
    const auth = randomBytes(16).toString('base64url');
    const msg = JSON.stringify({ title: 'Pengisian selesai', body: '12,5 kWh di Mall' });
    const body = encryptPayload(Buffer.from(msg), ua.getPublicKey().toString('base64url'), auth);
    assert.equal(decryptPayload(body, ua.getPrivateKey(), auth).toString(), msg);
    const other = createECDH('prime256v1'); other.generateKeys();
    assert.throws(() => decryptPayload(body, other.getPrivateKey(), auth));
  });
  test('malformed subscription keys are refused', () => {
    assert.throws(() => encryptPayload(Buffer.from('x'), 'AAAA', randomBytes(16).toString('base64url')), /P-256/);
    const ua = createECDH('prime256v1'); ua.generateKeys();
    assert.throws(() => encryptPayload(Buffer.from('x'), ua.getPublicKey().toString('base64url'), 'AAAA'), /16 bytes/);
  });
});

describe('web push: VAPID', () => {
  test('the JWT is ES256-signed for the push service origin and verifies with the public key', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string; y: string };
    const publicKey = Buffer.concat([Buffer.from([4]), u(jwk.x), u(jwk.y)]).toString('base64url');
    const h = vapidAuthorization({ publicKey, privateKey }, 'https://fcm.googleapis.com/fcm/send/abc', 'mailto:ops@example.id', Date.UTC(2026, 8, 27));
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
    const claims = JSON.parse(u(m[2]!).toString());
    assert.equal(claims.aud, 'https://fcm.googleapis.com');
    assert.equal(claims.sub, 'mailto:ops@example.id');
    assert.equal(m[4], publicKey);
    const ok = createVerify('SHA256').update(`${m[1]}.${m[2]}`).verify({ key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, u(m[3]!));
    assert.equal(ok, true);
  });
  test('in production only known push services are reachable (the phone supplies the URL)', () => {
    (config as { env: string }).env = 'production';
    assert.equal(endpointProblem('https://fcm.googleapis.com/fcm/send/x'), null);
    assert.equal(endpointProblem('https://updates.push.services.mozilla.com/wpush/v2/x'), null);
    assert.equal(endpointProblem('https://web.push.apple.com/QG'), null);
    assert.match(endpointProblem('https://169.254.169.254/latest')!, /not a known push service/);
    assert.match(endpointProblem('http://fcm.googleapis.com/x')!, /https/);
  });
});
