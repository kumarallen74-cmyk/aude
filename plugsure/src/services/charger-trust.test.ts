import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { buildCsr, name } from '../pnc/der.js';
import { connectionProfile, onStationCsr, stationCsrRefusal, STATION_CSR_MAX_PER_DAY } from './charger-ca.js';
import { issueAuthorizationKey, verifyAuthorizationKey, retirePreviousKey } from './chargepoint-keys.js';

/**
 * Station-certificate signing rules and AuthorizationKey rotation
 * (database-backed; run against plugsure_audit_fix only).
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[charger-trust.test] SKIPPING database suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'charger-trust-test';
const ID = 'TRUST-TEST-01';
let orgId = '', siteId = '', cpId = '';
const actor = { type: 'system' as const };

if (DB_OK) {
  before(async () => {
    orgId = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ('PT Charger Trust Test', $1) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    siteId = (await one<{ id: string }>(`INSERT INTO site (org_id, name, pbjt_rate_bps) VALUES ($1, 'Trust Test Hub', 1000) RETURNING id`, [orgId]))!.id;
    await query(`DELETE FROM pnc_event WHERE charge_point_id IN (SELECT id FROM charge_point WHERE ocpp_identity = $1)`, [ID]);
    await query(`DELETE FROM pnc_certificate WHERE charge_point_id IN (SELECT id FROM charge_point WHERE ocpp_identity = $1)`, [ID]);
    await query(`DELETE FROM charge_point WHERE ocpp_identity = $1`, [ID]);
    cpId = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, status) VALUES ($1, $2, 'online') RETURNING id`, [siteId, ID]))!.id;
  });
  after(async () => {
    // Let a scheduled signAndInstall (250 ms after an Accepted CSR) finish first.
    await new Promise((r) => setTimeout(r, 1200));
    await query(`DELETE FROM pnc_event WHERE charge_point_id = $1`, [cpId]);
    await query(`DELETE FROM pnc_certificate WHERE charge_point_id = $1`, [cpId]);
    await query(`DELETE FROM charge_point WHERE id = $1`, [cpId]);
    await query(`DELETE FROM site WHERE id = $1`, [siteId]);
    await pool.end();
  });
}

describe('station CSR policy (pure)', () => {
  const ok = { profile: 2, requestOpen: true, renewalDue: false, signedLastDay: 0 };
  test('Profile 2 or 3, a platform request (or a due renewal), under the daily limit', () => {
    assert.equal(stationCsrRefusal(ok), null);
    assert.equal(stationCsrRefusal({ ...ok, profile: 3, requestOpen: false, renewalDue: true }), null);
    assert.match(stationCsrRefusal({ ...ok, profile: 1 })!, /Profile 1/);
    assert.match(stationCsrRefusal({ ...ok, profile: 0 })!, /Profile 0/);
    assert.match(stationCsrRefusal({ ...ok, requestOpen: false })!, /did not ask/);
    assert.match(stationCsrRefusal({ ...ok, signedLastDay: STATION_CSR_MAX_PER_DAY })!, /rate limit/);
  });
  test('an unknown connection profile counts as 0', () => {
    assert.equal(connectionProfile({}), 0);
    assert.equal(connectionProfile({ securityProfile: null }), 0);
    assert.equal(connectionProfile({ securityProfile: '3' }), 3);
    assert.equal(connectionProfile({ securityProfile: 7 }), 0);
  });
});

dbDescribe('station CSR over OCPP', () => {
  const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const csr = buildCsr(name([['C', 'ID'], ['O', 'Vendor'], ['CN', ID]]), k);
  const ctx = (securityProfile?: number) => ({ ocppIdentity: ID, chargePointId: cpId, orgId, ...(securityProfile !== undefined ? { securityProfile } : {}) });
  const openRequest = () => query(`UPDATE charge_point SET station_csr_requested_until = now() + interval '10 minutes' WHERE id = $1`, [cpId]);

  test('unsolicited, or on Profile 0/1, or with the profile unknown: Rejected', async () => {
    assert.equal((await onStationCsr(ctx(2), csr)).status, 'Rejected', 'Profile 2 but nobody asked');
    await openRequest();
    assert.equal((await onStationCsr(ctx(), csr)).code, 'NotAllowed', 'profile unknown');
    assert.equal((await onStationCsr(ctx(1), csr)).status, 'Rejected', 'Profile 1');
    const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM pnc_certificate WHERE charge_point_id = $1`, [cpId]);
    assert.equal(n!.n, 0, 'nothing signed');
  });

  test('requested by PlugSure and on Profile 2: Accepted once; the request is used up', async () => {
    await openRequest();
    const r = await onStationCsr(ctx(2), csr);
    assert.equal(r.status, 'Accepted', r.reason);
    const cp = await one<{ until: Date | null }>(`SELECT station_csr_requested_until AS until FROM charge_point WHERE id = $1`, [cpId]);
    assert.equal(cp!.until, null);
    assert.equal((await onStationCsr(ctx(2), csr)).status, 'Rejected', 'a second CSR on the same request');
  });

  test(`at most ${STATION_CSR_MAX_PER_DAY} a day, even when asked`, async () => {
    await query(`INSERT INTO pnc_certificate (org_id, charge_point_id, certificate_type, source) SELECT $1, $2, 'ChargingStationCertificate', 'ocpp_csr' FROM generate_series(1, $3)`, [orgId, cpId, STATION_CSR_MAX_PER_DAY]);
    await openRequest();
    const r = await onStationCsr(ctx(3), csr);
    assert.equal(r.status, 'Rejected');
    assert.match(r.reason!, /rate limit/);
  });

  test('a CSR for another identity is still InvalidCSR', async () => {
    const other = buildCsr(name([['CN', 'SOMEONE-ELSE']]), k);
    assert.equal((await onStationCsr(ctx(3), other)).code, 'InvalidCSR');
  });
});

dbDescribe('AuthorizationKey rotation', () => {
  test('issuing twice before the charger applied the first keeps the key it is still using', async () => {
    const k0 = (await issueAuthorizationKey(cpId, actor))!.key;
    assert.equal((await verifyAuthorizationKey(ID, k0)).matched, 'current');
    await retirePreviousKey(ID);
    const k1 = (await issueAuthorizationKey(cpId, actor))!.key;
    // Lost response / double click: issued again; the charger never used k1.
    const k2 = (await issueAuthorizationKey(cpId, actor))!.key;
    assert.deepEqual(await verifyAuthorizationKey(ID, k0), { ok: true, matched: 'previous' }, 'the charger, still on k0, can connect');
    assert.equal((await verifyAuthorizationKey(ID, k1)).ok, false, 'k1 was never used and is replaced');
    assert.equal((await verifyAuthorizationKey(ID, k2)).matched, 'current');
    // Once the charger is seen on k2 (the gateway retires the previous key), the next rotation moves on.
    await retirePreviousKey(ID);
    const k3 = (await issueAuthorizationKey(cpId, actor))!.key;
    assert.equal((await verifyAuthorizationKey(ID, k0)).ok, false);
    assert.equal((await verifyAuthorizationKey(ID, k2)).matched, 'previous');
    assert.equal((await verifyAuthorizationKey(ID, k3)).matched, 'current');
  });

  test('used the current key since the rotation: it becomes the previous one, even before retirement', async () => {
    const a = (await issueAuthorizationKey(cpId, actor))!.key;
    assert.equal((await verifyAuthorizationKey(ID, a)).matched, 'current'); // recorded, not retired
    const b = (await issueAuthorizationKey(cpId, actor))!.key;
    assert.equal((await verifyAuthorizationKey(ID, a)).matched, 'previous');
    assert.equal((await verifyAuthorizationKey(ID, b)).matched, 'current');
  });

  test('a compromised key stops working at once: no grace for it or any earlier key', async () => {
    const leaked = (await issueAuthorizationKey(cpId, actor))!.key;
    const fresh = await issueAuthorizationKey(cpId, actor, undefined, { reason: 'compromised' });
    assert.equal((await verifyAuthorizationKey(ID, leaked)).ok, false);
    assert.equal((await verifyAuthorizationKey(ID, fresh!.key)).matched, 'current');
    assert.equal(fresh!.graceEndsAt.getTime(), fresh!.rotatedAt.getTime(), 'no grace window');
    const row = await one<{ prev: string | null }>(`SELECT auth_key_prev_hash AS prev FROM charge_point WHERE id = $1`, [cpId]);
    assert.equal(row!.prev, null);
  });
});
