import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { bus } from './events.js';
import { claimOutageAlert, closeOutage, outageFromResume, sweepOutages } from './uptime.js';

/**
 * Offline alerts (database-backed).
 *
 * A sweep reads the open outages at the start of its pass. It used to raise the
 * alert for a row even when the charger had come back in the meantime: the alert
 * then stayed open for good, because closeOutage had already run. The field e2e
 * saw it as a "[CRITICAL] Charger offline" e-mail for a charger that was online.
 *
 * Runs only against the disposable test database, like the audit suites:
 *   DATABASE_URL=postgresql://postgres:…@127.0.0.1:5432/plugsure_audit_fix npm test
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[uptime.test] SKIPPING database-backed offline-alert suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
// One file at a time against the audit chain (src/db/test-lock.ts).
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'uptime-race-test';
const IDENT = 'UPTIME-RACE-TEST-01';
let cpId = '';

async function cleanup(): Promise<void> {
  await query(`DELETE FROM charge_point_outage WHERE charge_point_id IN (SELECT id FROM charge_point WHERE ocpp_identity = $1)`, [IDENT]);
  await query(`DELETE FROM charge_point WHERE ocpp_identity = $1`, [IDENT]);
  const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (org) await query(`DELETE FROM site WHERE org_id = $1`, [org.id]);
}

if (DB_OK) {
  before(async () => {
    await cleanup();
    const orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug) VALUES ('Uptime Race Test', $1) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    const siteId = (await one<{ id: string }>(`INSERT INTO site (org_id, name, local_tax_rate_bps) VALUES ($1, 'Uptime Race Hub', 1000) RETURNING id`, [orgId]))!.id;
    // Seen just now: the sweep's "quiet charger" step leaves it alone; only the outages below matter.
    cpId = (await one<{ id: string }>(
      `INSERT INTO charge_point (site_id, ocpp_identity, ocpp_version, status, display_name, last_seen_at)
       VALUES ($1, $2, 'ocpp1.6', 'offline', 'Race Charger', now()) RETURNING id`, [siteId, IDENT]))!.id;
  });
  after(async () => {
    await cleanup();
    await pool.end();
  });
}

const openOutage = async (minutesAgo: number) => (await one<{ id: string }>(
  `INSERT INTO charge_point_outage (org_id, charge_point_id, went_offline_at)
   SELECT s.org_id, cp.id, now() - make_interval(mins => $2::int) FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE cp.id = $1 RETURNING id`,
  [cpId, minutesAgo]))!.id;

dbDescribe('offline alerts: one per outage, never for one that has ended', () => {
  test('the alert for an outage is claimed once, and not at all once the charger is back', async () => {
    const id = await openOutage(30);
    assert.equal(await claimOutageAlert(id), true, 'an open outage can be alerted');
    assert.equal(await claimOutageAlert(id), false, 'only once');
    await query(`UPDATE charge_point_outage SET came_online_at = now() WHERE id = $1`, [id]);

    const back = await openOutage(30);
    // The charger comes back between the sweep reading its list and reaching this row.
    await query(`UPDATE charge_point_outage SET came_online_at = now() WHERE id = $1`, [back]);
    assert.equal(await claimOutageAlert(back), false, 'an outage that has ended is never alerted');
    const row = await one<{ alerted_at: Date | null }>(`SELECT alerted_at FROM charge_point_outage WHERE id = $1`, [back]);
    assert.equal(row?.alerted_at, null);
  });

  test('a sweep raises one critical alert for an overdue outage, and none on the next pass', async () => {
    const id = await openOutage(config.gateway.offlineAlertMinutes + 5);
    const mine: unknown[] = [];
    let listening = true; // the bus has no off(): stop recording instead
    bus.on('alert.raised', (e: any) => { if (listening && e.targetId === cpId && e.kind === 'charge_point.offline') mine.push(e); });
    try {
      await sweepOutages();
      await sweepOutages();
    } finally {
      listening = false;
    }
    assert.equal(mine.length, 1);
    assert.equal((mine[0] as any).severity, 'critical');
    assert.match((mine[0] as any).message, /Race Charger \(UPTIME-RACE-TEST-01\)/);
    const row = await one<{ alerted_at: Date | null }>(`SELECT alerted_at FROM charge_point_outage WHERE id = $1`, [id]);
    assert.ok(row?.alerted_at);
    await query(`UPDATE charge_point_outage SET came_online_at = now() WHERE id = $1`, [id]);
  });
  test('a reconnect resolves the open offline alert, and a stale sweep cannot raise one after it', async () => {
    const org = (await one<{ org_id: string }>(`SELECT s.org_id FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE cp.id = $1`, [cpId]))!.org_id;
    const id = await openOutage(30);
    assert.equal(await claimOutageAlert(id), true);
    const alert = (await one<{ id: string }>(
      `INSERT INTO alert (org_id, severity, kind, message, target_type, target_id) VALUES ($1, 'critical', 'charge_point.offline', 'Race Charger offline', 'charge_point', $2) RETURNING id`,
      [org, cpId]))!.id;
    await closeOutage(IDENT);
    const a = await one<{ resolved_at: Date | null }>(`SELECT resolved_at FROM alert WHERE id = $1`, [alert]);
    const o = await one<{ came_online_at: Date | null }>(`SELECT came_online_at FROM charge_point_outage WHERE id = $1`, [id]);
    assert.ok(o?.came_online_at, 'the outage is closed');
    assert.ok(a?.resolved_at, 'the offline alert is resolved');
    assert.equal(await claimOutageAlert(id), false, 'and nothing can alert for it any more');
    await query(`DELETE FROM alert WHERE id = $1`, [alert]);
  });
});

dbDescribe('suspension is planned downtime, not an outage (v1.4.4)', () => {
  test('resumed while disconnected: the outage starts now, no alert, the suspension is not downtime', async () => {
    // Suspended three days ago with an outage already open; then resumed while still disconnected.
    await query(`UPDATE charge_point SET status = 'suspended', last_seen_at = now() - interval '3 days' WHERE id = $1`, [cpId]);
    const before = await openOutage(3 * 24 * 60);
    await closeOutage(IDENT); // what suspend does
    const ended = await one<{ came_online_at: Date | null }>(`SELECT came_online_at FROM charge_point_outage WHERE id = $1`, [before]);
    assert.ok(ended?.came_online_at, 'suspending ends the open outage');

    await query(`UPDATE charge_point SET status = 'offline' WHERE id = $1`, [cpId]); // what resume does
    await outageFromResume(IDENT);
    const mine: unknown[] = [];
    let listening = true;
    bus.on('alert.raised', (e: any) => { if (listening && e.targetId === cpId && e.kind === 'charge_point.offline') mine.push(e); });
    try {
      await sweepOutages();
    } finally {
      listening = false;
    }
    const open = await one<{ went_offline_at: Date }>(
      `SELECT went_offline_at FROM charge_point_outage WHERE charge_point_id = $1 AND came_online_at IS NULL`, [cpId]);
    assert.ok(open, 'an outage is open for the disconnected charger');
    assert.ok(Date.now() - new Date(open!.went_offline_at).getTime() < 60_000, 'dated from the resume, not from before the suspension');
    assert.equal(mine.length, 0, 'no critical alert the moment it is resumed');
    await query(`UPDATE charge_point_outage SET came_online_at = now() WHERE charge_point_id = $1 AND came_online_at IS NULL`, [cpId]);
    await query(`UPDATE charge_point SET last_seen_at = now() WHERE id = $1`, [cpId]);
  });

  test('without the fix the sweep would have dated it three days back (control)', async () => {
    await query(`UPDATE charge_point SET status = 'offline', last_seen_at = now() - interval '3 days' WHERE id = $1`, [cpId]);
    let listening = true;
    const mine: unknown[] = [];
    bus.on('alert.raised', (e: any) => { if (listening && e.targetId === cpId && e.kind === 'charge_point.offline') mine.push(e); });
    try {
      await sweepOutages();
    } finally {
      listening = false;
    }
    const open = await one<{ went_offline_at: Date }>(
      `SELECT went_offline_at FROM charge_point_outage WHERE charge_point_id = $1 AND came_online_at IS NULL`, [cpId]);
    assert.ok(open && Date.now() - new Date(open.went_offline_at).getTime() > 2 * 24 * 3600_000, 'the sweep alone backdates to last_seen_at');
    assert.equal(mine.length, 1, 'and alerts at once');
    await query(`UPDATE charge_point_outage SET came_online_at = now() WHERE charge_point_id = $1 AND came_online_at IS NULL`, [cpId]);
    await query(`UPDATE charge_point SET last_seen_at = now() WHERE id = $1`, [cpId]);
  });
});
