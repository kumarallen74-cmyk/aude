import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { getOrgSettings } from './org-settings.js';

/**
 * The operator console and its exports for an Indonesian operator on a default installation (MULTI_COUNTRY,
 * HUB_ENABLED and MS_CLIENT_ID unset) read as in v1.5.0 (the live pilot): the regression comparison
 * v1.5.0 ↔ 1.9.0-dev of every console route.
 */

// The sessions CSV's v1.5 compatibility (per organisation: rupiah-only and every site in Indonesia) is covered by compat-v15.test.ts.

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[console-compat.test] SKIPPING database-backed suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

dbDescribe('Organisation page: Indonesian PKP status before any tax registration row', () => {
  const SLUG = 'console-compat-test';
  let orgId = '';
  before(async () => {
    orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug, pkp, npwp) VALUES ('Console Compat Test', $1, true, '01.234.567.8-091.000')
       ON CONFLICT (slug) DO UPDATE SET pkp = true, npwp = EXCLUDED.npwp RETURNING id`, [SLUG]))!.id;
    await query(`DELETE FROM org_tax_registration WHERE org_id = $1`, [orgId]);
  });
  after(async () => {
    await query(`DELETE FROM org_tax_registration WHERE org_id = $1`, [orgId]);
    await query(`DELETE FROM organisation WHERE id = $1`, [orgId]);
  });

  test('a PKP set on the organisation record (seed, installer, v1.6) is reported, not shown as "not registered"', async () => {
    const s = await getOrgSettings(orgId);
    assert.equal(s.taxRegistrations.length, 0);
    assert.deepEqual(s.indonesiaPkp, { registered: true, npwp: '01.234.567.8-091.000' });
  });

  test('a non-PKP operator: registered false', async () => {
    await query(`UPDATE organisation SET pkp = false, npwp = NULL WHERE id = $1`, [orgId]);
    const s = await getOrgSettings(orgId);
    assert.deepEqual(s.indonesiaPkp, { registered: false, npwp: null });
  });
});
