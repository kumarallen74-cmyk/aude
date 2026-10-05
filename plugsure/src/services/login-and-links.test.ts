import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { login, hashPassword } from './users.js';
import { downloadableImage, FIRMWARE_LINK_GRACE_HOURS } from './firmware.js';

/**
 * Operator sign-in never reveals whether an address has an account, and a firmware link works
 * only while a campaign needs it (database-backed).
 *
 * Runs only against the disposable test database:
 *   DATABASE_URL=postgresql://postgres:…@127.0.0.1:5432/plugsure_audit_fix npm test
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[login-and-links.test] SKIPPING database-backed suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'login-links-test';
const IDENT = 'LOGIN-LINKS-TEST-01';
const PW = 'Correct-Horse-2026!';
let orgId = '';
let imageId = '';
let campaignId = '';
const token = randomBytes(24).toString('base64url');

async function cleanup() {
  const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (!org) return;
  await query(`DELETE FROM firmware_job WHERE campaign_id IN (SELECT id FROM firmware_campaign WHERE org_id = $1)`, [org.id]);
  await query(`DELETE FROM firmware_campaign WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM firmware_image WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM charge_point WHERE ocpp_identity = $1`, [IDENT]);
  await query(`DELETE FROM site WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM app_user WHERE org_id = $1`, [org.id]);
}

if (DB_OK) {
  before(async () => {
    await cleanup();
    orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug) VALUES ('Login Links Test', $1) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    const h = await hashPassword(PW);
    await query(`INSERT INTO app_user (org_id, email, name, status, password_hash) VALUES ($1, 'll-known@plugsure.test', 'Known', 'active', $2)`, [orgId, h]);
    await query(`INSERT INTO app_user (org_id, email, name, status, password_hash, locked_until) VALUES ($1, 'll-locked@plugsure.test', 'Locked', 'active', $2, now() + interval '15 minutes')`, [orgId, h]);
    await query(`INSERT INTO app_user (org_id, email, name) VALUES ($1, 'll-invited@plugsure.test', 'Invited')`, [orgId]);
    await query(`INSERT INTO app_user (org_id, email, name, status, password_hash) VALUES ($1, 'll-burst@plugsure.test', 'Burst', 'active', $2)`, [orgId, h]);
    const site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, local_tax_rate_bps) VALUES ($1, 'LL Hub', 1000) RETURNING id`, [orgId]))!.id;
    const cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, ocpp_version, status) VALUES ($1, $2, 'ocpp1.6', 'online') RETURNING id`, [site, IDENT]))!.id;
    imageId = (await one<{ id: string }>(
      `INSERT INTO firmware_image (org_id, name, version, source, storage_path, file_name, download_token)
       VALUES ($1, 'LL image', '1.0.0', 'upload', '/tmp/none.bin', 'fw.bin', $2) RETURNING id`, [orgId, token]))!.id;
    campaignId = (await one<{ id: string }>(
      `INSERT INTO firmware_campaign (org_id, name, image_id, target_type, status) VALUES ($1, 'LL rollout', $2, 'charge_point', 'running') RETURNING id`, [orgId, imageId]))!.id;
    await query(`INSERT INTO firmware_job (campaign_id, org_id, charge_point_id, state) VALUES ($1, $2, $3, 'Downloading')`, [campaignId, orgId, cp]);
  });
  after(async () => { await cleanup(); await pool.end(); });
}

dbDescribe('operator sign-in never reveals whether an address has an account', () => {
  test('unknown address, wrong password, locked account and invitation get the same answer', async () => {
    const answers = await Promise.all([
      login('ll-nobody@plugsure.test', 'x'), login('ll-known@plugsure.test', 'wrong'),
      login('ll-locked@plugsure.test', 'wrong'), login('ll-invited@plugsure.test', 'x'),
    ]);
    for (const a of answers) assert.equal(a.ok, false);
    assert.equal(new Set(answers.map((a) => (a as any).error)).size, 1, JSON.stringify(answers.map((a) => (a as any).error)));
    assert.match((answers[0] as any).error, /sign-in pauses for \d+ minutes/, 'a locked-out person learns to wait');
  });
  test('a locked account refuses even the right password, with that same answer', async () => {
    const r = await login('ll-locked@plugsure.test', PW);
    assert.equal(r.ok, false);
    assert.equal((r as any).error, (await login('ll-nobody@plugsure.test', 'x') as any).error);
  });
  test('the right password on an unlocked account still signs in', async () => {
    assert.equal((await login('ll-known@plugsure.test', PW)).ok, true);
  });
  test('a burst of parallel guesses cannot outrun the lockout, and the lock then refuses the right password', async () => {
    // The counter was read, bumped in JavaScript after the password check and written
    // back as a value: 30 parallel guesses all read 0 and together recorded ONE failure.
    const guesses = await Promise.all(Array.from({ length: 30 }, (_, i) => login('ll-burst@plugsure.test', `wrong-${i}`)));
    assert.ok(guesses.every((g) => !g.ok));
    const u = await one<{ locked: boolean }>(`SELECT locked_until > now() AS locked FROM app_user WHERE email = 'll-burst@plugsure.test'`);
    assert.equal(u?.locked, true, 'the burst locked the account');
    assert.equal((await login('ll-burst@plugsure.test', PW)).ok, false, 'locked: even the right password is refused');
  });
});

dbDescribe('a firmware link works only while a campaign needs it', () => {
  const setJob = (state: string, hoursAgo: number) =>
    query(`UPDATE firmware_job SET state = $2, updated_at = now() - make_interval(hours => $3) WHERE campaign_id = $1`, [campaignId, state, hoursAgo]);
  const setCampaign = (status: string) => query(`UPDATE firmware_campaign SET status = $2 WHERE id = $1`, [campaignId, status]);

  test('a running campaign whose charger is still downloading: served', async () => {
    await setCampaign('running'); await setJob('Downloading', 30);
    assert.ok(await downloadableImage(token));
  });
  test(`finished, within ${FIRMWARE_LINK_GRACE_HOURS} h of the job's last move: served (slow downloads, retries)`, async () => {
    await setCampaign('completed'); await setJob('Verified', 1);
    assert.ok(await downloadableImage(token));
  });
  test('finished longer ago than that: not served', async () => {
    await setCampaign('completed'); await setJob('Verified', FIRMWARE_LINK_GRACE_HOURS + 1);
    assert.equal(await downloadableImage(token), null);
  });
  test('an archived image, or a token of an image no campaign uses: not served', async () => {
    await setCampaign('running'); await setJob('Downloading', 0);
    await query(`UPDATE firmware_image SET archived_at = now() WHERE id = $1`, [imageId]);
    assert.equal(await downloadableImage(token), null);
    await query(`UPDATE firmware_image SET archived_at = NULL WHERE id = $1`, [imageId]);
    await query(`DELETE FROM firmware_job WHERE campaign_id = $1`, [campaignId]);
    assert.equal(await downloadableImage(token), null, 'no job for the image: never served');
  });
});
