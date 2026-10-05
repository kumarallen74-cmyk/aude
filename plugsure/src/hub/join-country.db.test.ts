import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * A PlugSure tenant joining the hub becomes a member of the country of its home roaming identity (its OCPI party),
 * not of its organisation's home country: the member's country picks the PlugSure entity that invoices its hub fees.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/hub/join-country.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const saved = { hub: { ...config.hub }, ocpiUrl: config.ocpi.publicUrl };
Object.assign(config.hub, { enabled: true, publicUrl: 'http://hub.test' });
(config.ocpi as { publicUrl: string }).publicUrl = 'http://ocpi.test';
const { joinInternal } = await import('./registry.js');
const { leaveTenant } = await import('./lifecycle.js');

const TAG = randomBytes(3).toString('hex');
const PID = `J${randomBytes(1).toString('hex').toUpperCase()}`.slice(0, 3).padEnd(3, '7');
let org = '';

async function cleanup() {
  const m = await many<{ id: string }>(`SELECT id FROM hub_member WHERE org_id = $1`, [org]);
  const ids = m.map((x) => x.id);
  const cs = (await many<{ id: string }>(`SELECT id FROM hub_connection WHERE member_id = ANY($1::uuid[])`, [ids])).map((c) => c.id);
  await query(`DELETE FROM hub_outbox WHERE recipient_connection_id = ANY($1::uuid[])`, [cs]);
  await query(`DELETE FROM hub_message WHERE connection_id = ANY($1::uuid[])`, [cs]);
  await query(`DELETE FROM hub_party WHERE member_id = ANY($1::uuid[])`, [ids]);
  await query(`DELETE FROM hub_party_key WHERE member_id = ANY($1::uuid[])`, [ids]);
  await query(`DELETE FROM hub_connection WHERE member_id = ANY($1::uuid[])`, [ids]);
  await query(`DELETE FROM hub_member WHERE id = ANY($1::uuid[])`, [ids]);
  const partners = (await many<{ id: string }>(`SELECT id FROM ocpi_partner WHERE org_id = $1`, [org])).map((p) => p.id);
  await query(`DELETE FROM ocpi_hub_client WHERE partner_id = ANY($1::uuid[])`, [partners]);
  await query(`DELETE FROM ocpi_push WHERE org_id = $1`, [org]);
  await query(`DELETE FROM ocpi_message WHERE org_id = $1`, [org]);
  await query(`DELETE FROM ocpi_partner WHERE org_id = $1`, [org]);
  await query(`DELETE FROM ocpi_party WHERE org_id = $1`, [org]);
  await query(`DELETE FROM organisation WHERE id = $1`, [org]);
}

if (DB_OK) {
  before(async () => {
    // An organisation whose home country is Indonesia, roaming as a Malaysian party.
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug, home_country_code) VALUES ($1, $2, 'ID') RETURNING id`, [`Hub Join Country ${TAG}`, `hub-join-country-${TAG}`]))!.id;
    await query(`INSERT INTO ocpi_party (org_id, country_code, party_id, business_name, is_home) VALUES ($1,'MY',$2,'Join Country MY', true)`, [org, PID]);
  });
  after(async () => {
    await cleanup();
    Object.assign(config.hub, saved.hub);
    (config.ocpi as { publicUrl: string }).publicUrl = saved.ocpiUrl;
    await pool.end();
  });
}

dbDescribe('joining the hub: the member\'s country', () => {
  test('is the country of the tenant\'s home OCPI party, not the organisation\'s home country', async () => {
    const r = await joinInternal(org, null);
    assert.equal(r.created, true);
    assert.equal(r.member.country_code, 'MY');
  });

  test('a re-join after leaving follows a home identity that moved country', async () => {
    assert.equal(await leaveTenant(org), true);
    await query(`UPDATE ocpi_party SET country_code = 'SG' WHERE org_id = $1 AND is_home`, [org]);
    await query(`DELETE FROM hub_party WHERE org_id = $1`, [org]);
    await query(`DELETE FROM hub_party_key WHERE member_id IN (SELECT id FROM hub_member WHERE org_id = $1)`, [org]);
    const r = await joinInternal(org, null);
    assert.equal(r.member.country_code, 'SG');
  });
});
