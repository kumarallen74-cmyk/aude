import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { can, heldPermissions, type Principal } from './authz.js';
import { seal, unseal, plaintextAllowed } from './secrets.js';
import { connectionWithBypass } from '../db/pool.js';

/** Pure tests for the 048 hardening: platform:admin scope, sealed-secret AAD. */

const OWN = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SITE = '33333333-3333-4333-8333-333333333333';

const platformAdmin: Principal = {
  userId: 'u-platform',
  orgId: OWN,
  assignments: [{ permissions: ['platform:admin'], scopeType: 'org', scopeId: null }],
};

describe('authz: platform:admin is cross-organisation only for platform routes', () => {
  test('another organisation\'s resources are refused for ordinary permissions', () => {
    for (const permission of ['site:read', 'session:write', 'user:write', 'charge_point:command', 'audit:read'] as const) {
      assert.equal(can(platformAdmin, { permission, orgId: OTHER }), false, permission);
      assert.equal(can(platformAdmin, { permission, orgId: OTHER, siteId: SITE }), false, `${permission} + site`);
    }
  });

  test('platform routes (permission platform:admin, with or without a foreign org) still pass', () => {
    assert.equal(can(platformAdmin, { permission: 'platform:admin' }), true);
    assert.equal(can(platformAdmin, { permission: 'platform:admin', orgId: OTHER }), true);
  });

  test('inside its own organisation a platform admin keeps every permission', () => {
    for (const permission of ['site:read', 'session:write', 'user:write', 'audit:read'] as const) {
      assert.equal(can(platformAdmin, { permission }), true, permission);
      assert.equal(can(platformAdmin, { permission, orgId: OWN, siteId: SITE }), true, `${permission} own site`);
    }
    assert.ok(heldPermissions(platformAdmin).has('tariff:write'));
  });

  test('an ordinary tenant is unchanged: own org yes, foreign org no, platform:admin no', () => {
    const owner: Principal = { userId: 'u', orgId: OWN, assignments: [{ permissions: ['site:read'], scopeType: 'org', scopeId: null }] };
    assert.equal(can(owner, { permission: 'site:read', orgId: OWN, siteId: SITE }), true);
    assert.equal(can(owner, { permission: 'site:read', orgId: OTHER, siteId: SITE }), false);
    assert.equal(can(owner, { permission: 'platform:admin' }), false);
    assert.equal(can(owner, { permission: 'platform:admin', orgId: OTHER }), false);
  });
});

describe('secrets: associated data (enc:v2) and the plaintext fallback', () => {
  test('v2 round-trips only with the same associated data', () => {
    const s = seal('whsec_abc', 'webhook_endpoint:1:secret');
    assert.match(s, /^enc:v2:/);
    assert.equal(unseal(s, 'webhook_endpoint:1:secret'), 'whsec_abc');
    assert.throws(() => unseal(s, 'webhook_endpoint:2:secret'), 'moved to another row');
    assert.throws(() => unseal(s), /associated data/, 'aad omitted');
  });

  test('v1 values (no aad) keep opening, with or without an aad argument', () => {
    const s = seal('token-123');
    assert.match(s, /^enc:v1:/);
    assert.equal(unseal(s), 'token-123');
    assert.equal(unseal(s, 'ignored-for-v1'), 'token-123');
  });

  test('a tampered or truncated tag is refused (authTagLength pinned to 16)', () => {
    const s = seal('secret', 'x');
    const [iv, tag, ct] = s.slice('enc:v2:'.length).split(':') as [string, string, string];
    const short = Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url');
    assert.throws(() => unseal(`enc:v2:${iv}:${short}:${ct}`, 'x'), /malformed/);
    const flipped = Buffer.from(tag, 'base64url');
    flipped[0] = flipped[0]! ^ 1;
    assert.throws(() => unseal(`enc:v2:${iv}:${flipped.toString('base64url')}:${ct}`, 'x'));
    assert.throws(() => unseal('enc:v1:not-enough-parts'), /malformed/);
  });

  test('unsealed text: returned in development/test, refused elsewhere unless explicitly allowed', () => {
    assert.equal(unseal(''), '', 'empty means no secret');
    assert.equal(unseal('legacy-plain'), 'legacy-plain', 'NODE_ENV=test is relaxed');
    assert.equal(plaintextAllowed('test', undefined), true);
    assert.equal(plaintextAllowed('development', undefined), true);
    for (const env of ['production', 'staging', '']) {
      assert.equal(plaintextAllowed(env, undefined), false, env);
      assert.equal(plaintextAllowed(env, '0'), false, env);
      assert.equal(plaintextAllowed(env, '1'), true, `${env} escape hatch`);
    }
  });
});

describe('pool: every connection starts with the RLS bypass on', () => {
  test('the bypass is a startup option, merged with any options the URL carries', () => {
    assert.deepEqual(connectionWithBypass('postgresql://u:p@h:5432/db'), {
      connectionString: 'postgresql://u:p@h:5432/db',
      options: '-c app.rls_bypass=on',
    });
    const merged = connectionWithBypass('postgresql://u:p@h:5432/db?sslmode=require&options=-c%20search_path%3Dpublic');
    assert.equal(merged.options, '-c search_path=public -c app.rls_bypass=on');
    assert.ok(!merged.connectionString.includes('options='), 'the URL no longer overrides it');
    assert.ok(merged.connectionString.includes('sslmode=require'));
  });
});
