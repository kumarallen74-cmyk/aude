import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { pool, query, one } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { recentUnknownTags } from './tokens.js';

/**
 * "Scan from live charger" reads unknown cards out of the OCPP frame log. The
 * gateway stores each frame as the whole OCPP-J message ([2, id, action,
 * payload]), so the card is in element 3. Runs only against the disposable
 * database (plugsure_audit_fix).
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbTest = DB_OK ? test : test.skip;
const dbLock = databaseTestLock('shared', DB_OK);
const SLUG = 'tokens-scan-test';
const IDENT = 'TOKENS-SCAN-CP-1';
let orgId = '';
let cpId = '';

async function cleanup() {
  await query(`DELETE FROM ocpp_frame WHERE ocpp_identity = $1`, [IDENT]);
  const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (!org) return;
  await query(`DELETE FROM token WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM charge_point WHERE ocpp_identity = $1`, [IDENT]);
  await query(`DELETE FROM site WHERE org_id = $1`, [org.id]);
}

before(dbLock.acquire);
after(dbLock.release);
if (DB_OK) {
  before(async () => {
    await cleanup();
    orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug) VALUES ('Tokens Scan Test', $1)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    const siteId = (await one<{ id: string }>(
      `INSERT INTO site (org_id, name) VALUES ($1, 'Tokens Scan Hub') RETURNING id`, [orgId]))!.id;
    cpId = (await one<{ id: string }>(
      `INSERT INTO charge_point (site_id, ocpp_identity, ocpp_version, status) VALUES ($1, $2, 'ocpp1.6', 'online') RETURNING id`,
      [siteId, IDENT]))!.id;
  });
  after(async () => {
    await cleanup();
    await pool.end();
  });
}

/** One inbound CALL as the gateway's frame sink records it. */
async function frame(action: string, body: unknown, agoSeconds = 5) {
  await query(
    `INSERT INTO ocpp_frame (charge_point_id, ocpp_identity, ts, direction, message_type, action, unique_id, payload)
     VALUES ($1, $2, now() - make_interval(secs => $3), 'in', 2, $4, $5, $6)`,
    [cpId, IDENT, agoSeconds, action, `u-${Math.random()}`, JSON.stringify([2, `u-${Math.random()}`, action, body])],
  );
}

dbTest('scan from live charger: unknown cards from 1.6 and 2.0.1 frames, registered and old ones left out', async () => {
  await frame('Authorize', { idTag: 'SCAN-NEW-16' });
  await frame('StartTransaction', { connectorId: 1, idTag: 'SCAN-NEW-16', meterStart: 0, timestamp: new Date().toISOString() }, 2);
  await frame('TransactionEvent', { eventType: 'Started', idToken: { idToken: 'SCAN-NEW-201', type: 'ISO14443' } });
  await frame('Authorize', { idTag: 'SCAN-KNOWN' });
  await frame('Authorize', { idTag: 'SCAN-OLD' }, 3600);
  await frame('Heartbeat', {});
  await query(`INSERT INTO token (org_id, kind, uid, status) VALUES ($1, 'rfid', 'SCAN-KNOWN', 'Accepted')`, [orgId]);

  const rows = await recentUnknownTags(orgId, IDENT);
  const tags = rows.map((r: any) => r.id_tag).sort();
  assert.deepEqual(tags, ['SCAN-NEW-16', 'SCAN-NEW-201']);
  const sixteen = rows.find((r: any) => r.id_tag === 'SCAN-NEW-16') as any;
  assert.equal(sixteen.presentations, 2, 'Authorize and StartTransaction both count');
  assert.equal(sixteen.ocpp_identity, IDENT);

  const otherOrg = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug <> $1 LIMIT 1`, [SLUG]);
  if (otherOrg) assert.deepEqual(await recentUnknownTags(otherOrg.id, IDENT), [], 'another organisation sees none of them');
});
