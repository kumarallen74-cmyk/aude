import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { remindUnpaidSessions } from './notify.js';

/**
 * Reminders for unpaid sessions the driver can pay in the app (database-backed): one per stage
 * (15 minutes, 1 day, 3 days after the session), never repeated, none once paid or after 7 days.
 *
 * Runs only against the disposable test database, like the audit suites:
 *   DATABASE_URL=postgresql://postgres:…@127.0.0.1:5432/plugsure_audit_fix npm test
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[unpaid-reminders.test] SKIPPING database-backed reminder suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
// One file at a time against the audit chain (src/db/test-lock.ts).
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'unpaid-reminder-test';
const IDENT = 'UNPAID-REMINDER-01';
const ids: Record<string, string> = {};

async function cleanup(): Promise<void> {
  const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (!org) return;
  await query(`DELETE FROM push_message WHERE subscription_id IN (SELECT s.id FROM push_subscription s JOIN driver_charge dc ON dc.device_id = s.device_id WHERE dc.org_id = $1)`, [org.id]);
  await query(`DELETE FROM push_subscription WHERE device_id IN (SELECT device_id FROM driver_charge WHERE org_id = $1)`, [org.id]);
  const devices = (await query(`SELECT DISTINCT device_id FROM driver_charge WHERE org_id = $1`, [org.id])).rows.map((r: any) => r.device_id);
  await query(`DELETE FROM driver_charge WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM payment_intent WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM charging_session WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM token WHERE org_id = $1`, [org.id]);
  if (devices.length) await query(`DELETE FROM driver_device WHERE id = ANY($1::uuid[])`, [devices]);
  await query(`DELETE FROM connector WHERE evse_uuid IN (SELECT e.id FROM evse e JOIN charge_point cp ON cp.id = e.charge_point_id WHERE cp.ocpp_identity = $1)`, [IDENT]);
  await query(`DELETE FROM evse WHERE charge_point_id IN (SELECT id FROM charge_point WHERE ocpp_identity = $1)`, [IDENT]);
  await query(`DELETE FROM charge_point WHERE ocpp_identity = $1`, [IDENT]);
  await query(`DELETE FROM site WHERE org_id = $1`, [org.id]);
}

if (DB_OK) {
  before(async () => {
    await cleanup();
    ids.org = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug) VALUES ('Unpaid Reminder Test', $1) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    ids.site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, pbjt_rate_bps) VALUES ($1, 'Reminder Hub', 1000) RETURNING id`, [ids.org]))!.id;
    ids.cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity) VALUES ($1, $2) RETURNING id`, [ids.site, IDENT]))!.id;
    ids.evse = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [ids.cp]))!.id;
    ids.conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, max_power_w) VALUES ($1, 60000) RETURNING id`, [ids.evse]))!.id;
    ids.token = (await one<{ id: string }>(`INSERT INTO token (org_id, kind, uid) VALUES ($1, 'prepaid', $2) RETURNING id`, [ids.org, `PS-${randomBytes(6).toString('hex')}`]))!.id;
    ids.device = (await one<{ id: string }>(`INSERT INTO driver_device (device_hash) VALUES ($1) RETURNING id`, [randomBytes(16).toString('hex')]))!.id;
    ids.session = (await one<{ id: string }>(
      `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, now() - interval '30 minutes', now() - interval '20 minutes') RETURNING id`,
      [ids.org, ids.site, ids.conn, ids.cp, `unpaid-reminder-${randomBytes(4).toString('hex')}`]))!.id;
    ids.intent = (await one<{ id: string }>(
      `INSERT INTO payment_intent (org_id, provider, method, mode, state, amount_authorised_idr, hold_state, hold_capture_idr, hold_error, session_id)
       VALUES ($1, 'mock', 'ewallet', 'postpay', 'authorised', 50000, 'capture_failed', 21340, '202 Transaction is denied: insufficient balance', $2) RETURNING id`,
      [ids.org, ids.session]))!.id;
    ids.charge = (await one<{ id: string }>(
      `INSERT INTO driver_charge (device_id, org_id, connector_uuid, token_id, payment_intent_id, mode, amount_idr) VALUES ($1, $2, $3, $4, $5, 'prepaid', 50000) RETURNING id`,
      [ids.device, ids.org, ids.conn, ids.token, ids.intent]))!.id;
    ids.sub = (await one<{ id: string }>(
      `INSERT INTO push_subscription (device_id, endpoint, p256dh, auth, lang) VALUES ($1, $2, 'p256dh-test', 'auth-test', 'id') RETURNING id`,
      [ids.device, `https://push.example.test/${randomBytes(8).toString('hex')}`]))!.id;
  });
  after(async () => {
    await cleanup();
    await pool.end();
  });
}

const mine = async () => (await query(
  `SELECT dedupe_key, kind, payload FROM push_message WHERE subscription_id = $1 ORDER BY created_at, dedupe_key`, [ids.sub])).rows as Array<{ dedupe_key: string; kind: string; payload: any }>;
const endedAgo = (interval: string) => query(`UPDATE charging_session SET ended_at = now() - $2::interval WHERE id = $1`, [ids.session, interval]);

dbDescribe('reminders for unpaid sessions payable in the app', () => {
  test('15 minutes after the session: one reminder linking straight to the receipt, never repeated', async () => {
    await remindUnpaidSessions();
    await remindUnpaidSessions();
    const m = await mine();
    assert.equal(m.length, 1);
    assert.deepEqual({ key: m[0]!.dedupe_key, kind: m[0]!.kind, url: m[0]!.payload.url, title: m[0]!.payload.title },
      { key: `unpaid:${ids.intent}:1`, kind: 'session.unpaid', url: `/app/#r/${ids.charge}`, title: 'Sesi pengisian belum dibayar' });
    assert.match(m[0]!.payload.body, /Reminder Hub · Rp\s?21\.340 · ketuk untuk membayar/);
  });

  test('a day later the second reminder, three days later the third; after seven days no more', async () => {
    await endedAgo('25 hours');
    await remindUnpaidSessions();
    await endedAgo('73 hours');
    await remindUnpaidSessions();
    await endedAgo('8 days');
    await remindUnpaidSessions();
    assert.deepEqual((await mine()).map((m) => m.dedupe_key), [1, 2, 3].map((s) => `unpaid:${ids.intent}:${s}`));
  });

  test('too early, or paid: no reminder', async () => {
    await query(`DELETE FROM push_message WHERE subscription_id = $1`, [ids.sub]);
    await endedAgo('5 minutes');
    await remindUnpaidSessions();
    assert.equal((await mine()).length, 0, 'not before 15 minutes');
    await endedAgo('2 days');
    await query(`UPDATE payment_intent SET hold_state = 'captured', state = 'captured', amount_captured_idr = 21340 WHERE id = $1`, [ids.intent]);
    await remindUnpaidSessions();
    assert.equal((await mine()).length, 0, 'paid: nothing to remind');
  });
});
