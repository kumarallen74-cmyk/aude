import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractIdentity, negotiate } from './server.js';

/**
 * `OCPP_PATH` was configured, documented, and never enforced — the last path
 * segment became the identity whatever preceded it. With auto-adopt on, a
 * charger dialling `/ocpp/` enrolled a charge point literally named "ocpp" into
 * the first tenant's fleet.
 */
describe('charge point identity from the request path', () => {
  const ID = 'AUTEL-DC60-SMB-002';

  test('the configured prefix is required', () => {
    assert.equal(extractIdentity(`/ocpp/${ID}`, '/ocpp'), ID);
    assert.equal(extractIdentity(`/foo/${ID}`, '/ocpp'), null);
    assert.equal(extractIdentity(`/${ID}`, '/ocpp'), null);
  });

  test('the prefix alone is not an identity', () => {
    assert.equal(extractIdentity('/ocpp/', '/ocpp'), null);
    assert.equal(extractIdentity('/ocpp', '/ocpp'), null);
  });

  test('a nested path under the prefix still resolves its last segment', () => {
    // Some firmware appends a version or a site code. The last segment is the id.
    assert.equal(extractIdentity(`/ocpp/1.6/${ID}`, '/ocpp'), ID);
  });

  test('the version-in-path fallback form is not mistaken for an identity', () => {
    assert.equal(extractIdentity('/ocpp/1.6', '/ocpp'), null);
    assert.equal(extractIdentity('/ocpp/ocpp1.6', '/ocpp'), null);
  });

  test('query strings and fragments are stripped', () => {
    assert.equal(extractIdentity(`/ocpp/${ID}?foo=bar`, '/ocpp'), ID);
    assert.equal(extractIdentity(`/ocpp/${ID}#frag`, '/ocpp'), ID);
  });

  test('percent-encoding is decoded, and malformed encoding throws for the caller', () => {
    assert.equal(extractIdentity('/ocpp/AUTEL%2D01', '/ocpp'), 'AUTEL-01');
    assert.throws(() => extractIdentity('/ocpp/%zz', '/ocpp'), URIError);
  });

  test('the prefix match is case-insensitive but the identity is not', () => {
    assert.equal(extractIdentity(`/OCPP/${ID}`, '/ocpp'), ID);
    assert.equal(extractIdentity('/ocpp/autel-dc60-smb-002', '/ocpp'), 'autel-dc60-smb-002');
  });

  test('a multi-segment prefix works', () => {
    assert.equal(extractIdentity(`/csms/ocpp/${ID}`, '/csms/ocpp'), ID);
    assert.equal(extractIdentity(`/ocpp/${ID}`, '/csms/ocpp'), null);
  });
});

describe('subprotocol negotiation', () => {
  test('exactly one supported version is echoed', () => {
    assert.equal(negotiate('ocpp1.6', ['ocpp1.6'] as any), 'ocpp1.6');
    assert.equal(negotiate('ocpp2.0.1,ocpp1.6', ['ocpp1.6'] as any), 'ocpp1.6');
  });

  test('a client offering only what we cannot speak is refused', () => {
    assert.equal(negotiate('ocpp2.0.1', ['ocpp1.6'] as any), null);
  });

  test('a missing header falls back to 1.6 — some units omit it entirely', () => {
    assert.equal(negotiate(undefined, ['ocpp1.6'] as any), 'ocpp1.6');
  });
});
