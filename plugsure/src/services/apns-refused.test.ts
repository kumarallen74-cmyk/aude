import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { markApnsRefused } from './brand.js';

/**
 * Apple refusing a key the gateway had cached (database-backed).
 *
 * The gateway keeps a brand's APNs credentials for up to 30 s. Right after an operator replaces
 * the key, a send can still go out with the old one and be refused. That refusal must not mark the
 * new, working key as refused in the console.
 *
 * Runs only against the disposable test database:
 *   DATABASE_URL=postgresql://postgres:…@127.0.0.1:5432/plugsure_audit_fix npm test
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[apns-refused.test] SKIPPING database-backed APNs suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'apns-refused-test';
let orgId = '';
const status = () => one<{ ok: boolean | null }>(`SELECT apns_check_ok AS ok FROM driver_app_brand WHERE org_id = $1`, [orgId]);
const reset = () => query(`UPDATE driver_app_brand SET apns_check_ok = true, apns_key_id = 'NEWKEY0001', ios_team_id = 'TEAM000001' WHERE org_id = $1`, [orgId]);

if (DB_OK) {
  before(async () => {
    orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug) VALUES ('APNs Refused Test', $1)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    await query(`DELETE FROM driver_app_brand WHERE org_id = $1`, [orgId]);
    await query(`INSERT INTO driver_app_brand (org_id, slug, app_name, short_name) VALUES ($1, $2, 'Refused Test', 'Refused')`, [orgId, SLUG]);
  });
  after(async () => {
    await query(`DELETE FROM driver_app_brand WHERE org_id = $1`, [orgId]);
    await pool.end();
  });
}

dbDescribe('a refused APNs key', () => {
  test('refused with the old, replaced key (still cached by the gateway): the new key stays good', async () => {
    await reset();
    await markApnsRefused(orgId, 'refused', { keyId: 'OLDKEY0001', teamId: 'TEAM000001' });
    assert.equal((await status())!.ok, true);
    await markApnsRefused(orgId, 'refused', { keyId: 'NEWKEY0001', teamId: 'OLDTEAM001' });
    assert.equal((await status())!.ok, true, 'a changed Team ID counts as replaced too');
  });
  test('refused with the stored key: marked, so the operator sees it', async () => {
    await reset();
    await markApnsRefused(orgId, 'refused', { keyId: 'NEWKEY0001', teamId: 'TEAM000001' });
    assert.equal((await status())!.ok, false);
  });
  test('no credentials given (older callers): marked, as before', async () => {
    await reset();
    await markApnsRefused(orgId, 'refused');
    assert.equal((await status())!.ok, false);
  });
});
