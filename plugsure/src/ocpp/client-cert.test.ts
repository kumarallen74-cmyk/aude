import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  normaliseFingerprint,
  fingerprintsMatch,
  presentedFingerprint,
  checkClientCert,
  type ClientCertContext,
} from './client-cert.js';

/**
 * OCPP Security Profile 3 — client-certificate verification (pure; no DB).
 *
 * The security guarantee under test: a Profile-3 connection is accepted only when
 * the presented certificate's SHA-256 matches the fingerprint bound to THIS charge
 * point, and the proxy-set header is trusted only when trustProxyProto is on.
 */

const FP = 'a'.repeat(64);
const FP_COLONS = 'AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA';
const OTHER = 'b'.repeat(64);
const HEADER = 'x-client-cert-fingerprint';

const ctx = (over = {}) => ({ headers: {}, trustProxyProto: true, headerName: HEADER, ...over } as ClientCertContext);

describe('normaliseFingerprint', () => {
  test('lowercases and strips colons to 64 hex chars', () => {
    assert.equal(normaliseFingerprint(FP_COLONS), FP);
    assert.equal(normaliseFingerprint('  ' + FP.toUpperCase() + '  '), FP);
  });
  test('strips an OpenSSL "SHA256 Fingerprint=" prefix', () => {
    assert.equal(normaliseFingerprint('SHA256 Fingerprint=' + FP_COLONS), FP);
    assert.equal(normaliseFingerprint('sha256:' + FP), FP);
  });
  test('rejects wrong length or non-hex', () => {
    assert.equal(normaliseFingerprint('abc'), null);
    assert.equal(normaliseFingerprint('z'.repeat(64)), null);
    assert.equal(normaliseFingerprint(''), null);
    assert.equal(normaliseFingerprint(undefined), null);
  });
});

describe('fingerprintsMatch', () => {
  test('equal matches, different does not', () => {
    assert.equal(fingerprintsMatch(FP, FP), true);
    assert.equal(fingerprintsMatch(FP, OTHER), false);
  });
  test('different lengths never match', () => {
    assert.equal(fingerprintsMatch(FP, FP.slice(0, 40)), false);
  });
});

describe('presentedFingerprint', () => {
  test('reads the proxy header when trustProxyProto is on', () => {
    const p = presentedFingerprint(ctx({ headers: { [HEADER]: FP_COLONS } }));
    assert.deepEqual(p, { value: FP, source: 'header' });
  });
  test('IGNORES the header when trustProxyProto is off (spoofable)', () => {
    const p = presentedFingerprint(ctx({ headers: { [HEADER]: FP_COLONS }, trustProxyProto: false }));
    assert.equal(p.value, null);
    assert.equal(p.source, 'none');
  });
  test('prefers the real socket peer cert over any header', () => {
    const socket = { encrypted: true, getPeerCertificate: () => ({ fingerprint256: FP_COLONS }) };
    const p = presentedFingerprint(ctx({ socket, headers: { [HEADER]: OTHER } }));
    assert.deepEqual(p, { value: FP, source: 'socket' });
  });
});

describe('checkClientCert', () => {
  test('accepts when the presented cert matches the binding', () => {
    const r = checkClientCert(ctx({ headers: { [HEADER]: FP_COLONS } }), FP);
    assert.equal(r.ok, true);
    assert.equal(r.source, 'header');
  });
  test('rejects when no certificate is presented', () => {
    const r = checkClientCert(ctx(), FP);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /no client certificate/i);
  });
  test('rejects when the charge point has no binding provisioned', () => {
    const r = checkClientCert(ctx({ headers: { [HEADER]: FP } }), null);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /no client-certificate binding/i);
  });
  test('rejects when the presented cert does not match the binding', () => {
    const r = checkClientCert(ctx({ headers: { [HEADER]: FP } }), OTHER);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /does not match/i);
  });
  test('a spoofed header on an untrusted-proxy connection is rejected (fails closed)', () => {
    const r = checkClientCert(ctx({ headers: { [HEADER]: FP }, trustProxyProto: false }), FP);
    assert.equal(r.ok, false);
  });
});
