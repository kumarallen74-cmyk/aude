import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertGrantable,
  heldPermissions,
  PrivilegeEscalationError,
  SYSTEM_ROLES,
  can,
  type Principal,
} from './authz.js';

const ORG = '11111111-1111-1111-1111-111111111111';
const OTHER_ORG = '22222222-2222-2222-2222-222222222222';

function principal(perms: string[], scopeType: 'org' | 'site' = 'org', scopeId: string | null = null): Principal {
  return {
    userId: 'u1',
    orgId: ORG,
    assignments: [{ permissions: perms as any, scopeType, scopeId }],
  };
}

/**
 * The finding that made the whole build unsafe to hand to a vendor: an
 * org_owner API key -- exactly the credential you issue for an integration test
 * -- could POST /v1/api-keys with `permissions: ['platform:admin']` and be
 * handed a key with authority over every tenant on the platform. The endpoint
 * required only `org:write` and copied the requested list verbatim.
 */
describe('privilege escalation via key issuance', () => {
  test('an org_owner cannot mint a platform:admin key', () => {
    const owner = principal(SYSTEM_ROLES.org_owner!);
    assert.throws(
      () => assertGrantable(owner, ['platform:admin']),
      (e: unknown) => e instanceof PrivilegeEscalationError && e.denied.includes('platform:admin'),
    );
  });

  test('an org_owner cannot mint a key with a permission it lacks', () => {
    const finance = principal(SYSTEM_ROLES.finance!);
    assert.throws(() => assertGrantable(finance, ['charge_point:command']), PrivilegeEscalationError);
  });

  test('delegating a subset of your own authority is allowed', () => {
    const owner = principal(SYSTEM_ROLES.org_owner!);
    assert.deepEqual(assertGrantable(owner, ['session:read', 'site:read']), ['session:read', 'site:read']);
  });

  test('duplicates collapse and an empty grant is legal', () => {
    const owner = principal(SYSTEM_ROLES.org_owner!);
    assert.deepEqual(assertGrantable(owner, ['session:read', 'session:read']), ['session:read']);
    assert.deepEqual(assertGrantable(owner, []), []);
  });

  test('an unrecognised permission string is refused rather than stored', () => {
    const owner = principal(SYSTEM_ROLES.org_owner!);
    assert.throws(() => assertGrantable(owner, ['platform:*']), PrivilegeEscalationError);
    assert.throws(() => assertGrantable(owner, [{ toString: () => 'org:read' }]), PrivilegeEscalationError);
  });

  test('a platform admin may still delegate anything', () => {
    const admin = principal(['platform:admin']);
    assert.deepEqual(assertGrantable(admin, ['platform:admin']), ['platform:admin']);
  });

  test('heldPermissions unions across assignments', () => {
    const p: Principal = {
      userId: 'u', orgId: ORG,
      assignments: [
        { permissions: ['session:read'] as any, scopeType: 'site', scopeId: 's1' },
        { permissions: ['tariff:read'] as any, scopeType: 'org', scopeId: null },
      ],
    };
    const held = heldPermissions(p);
    assert.ok(held.has('session:read') && held.has('tariff:read'));
    assert.ok(!held.has('platform:admin'));
  });
});

describe('cross-tenant access still fails closed', () => {
  test('an org-scoped grant does not reach another organisation', () => {
    const owner = principal(SYSTEM_ROLES.org_owner!);
    assert.equal(can(owner, { permission: 'site:read', orgId: OTHER_ORG }), false);
  });

  test('a site id with no resolved owning org is refused', () => {
    const owner = principal(SYSTEM_ROLES.org_owner!);
    assert.equal(can(owner, { permission: 'site:read', siteId: 'some-site' }), false);
    assert.equal(can(owner, { permission: 'site:read', siteId: 'some-site', orgId: ORG }), true);
  });
});
