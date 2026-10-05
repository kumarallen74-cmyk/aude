import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { hashPassword } from '../services/users.js';
import { fleetLogin, issueDevice, FLEET_LOGIN_FAILED } from './identity.js';
import { listStations, connectorDetail as connectorDetailAny, resolveCode } from './stations.js';

/** Without a white-label brand there is no "other operator" result. */
const connectorDetail = async (id: string) => (await connectorDetailAny(id)) as Exclude<Awaited<ReturnType<typeof connectorDetailAny>>, 'other_operator'>;
import { fleetTokenProblem, quotePrepaid } from './charge.js';

/**
 * The driver app against the v1.3 data model (database-backed).
 *
 * Runs only against the disposable test database, like the audit suites:
 *   DATABASE_URL=postgresql://postgres:…@127.0.0.1:5432/plugsure_audit_fix npm test
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[driver.test] SKIPPING database-backed driver suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
// One file at a time against the audit chain (src/db/test-lock.ts).
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'driver-align-test';
const IDENT = 'DRV-ALIGN-TEST-01';
let orgId = '';
let siteId = '';
let connectorId = '';
let deviceId = '';

async function cleanup(): Promise<void> {
  // Fleet sign-in budgets are keyed by the typed organisation and card, so they outlive the rows.
  await query(`DELETE FROM driver_auth_limit WHERE key LIKE $1`, [`pin-card:${SLUG}:%`]);
  const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (!org) return;
  await query(`DELETE FROM driver_device WHERE fleet_token_id IN (SELECT id FROM token WHERE org_id = $1)`, [org.id]);
  await query(`DELETE FROM token WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM connector WHERE evse_uuid IN (SELECT e.id FROM evse e JOIN charge_point cp ON cp.id = e.charge_point_id WHERE cp.ocpp_identity = $1)`, [IDENT]);
  await query(`DELETE FROM evse WHERE charge_point_id IN (SELECT id FROM charge_point WHERE ocpp_identity = $1)`, [IDENT]);
  await query(`DELETE FROM charge_point WHERE ocpp_identity = $1`, [IDENT]);
  await query(`DELETE FROM site WHERE org_id = $1`, [org.id]);
}

if (DB_OK) {
  before(async () => {
    await cleanup();
    orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug) VALUES ('Driver Align Test', $1)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [SLUG],
    ))!.id;
    siteId = (await one<{ id: string }>(
      `INSERT INTO site (org_id, name, local_tax_rate_bps) VALUES ($1, 'Driver Align Hub', 1000) RETURNING id`,
      [orgId],
    ))!.id;
    const cp = await one<{ id: string }>(
      `INSERT INTO charge_point (site_id, ocpp_identity, ocpp_version, status, display_name)
       VALUES ($1, $2, 'ocpp1.6', 'offline', 'Lobby Charger') RETURNING id`,
      [siteId, IDENT],
    );
    const e = await one<{ id: string }>(
      `INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1, 1, 22000) RETURNING id`,
      [cp!.id],
    );
    connectorId = (await one<{ id: string }>(
      `INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w, tera_status, tera_cert_status)
       VALUES ($1, 1, 'sGBT', 'AC', 22000, 'verified', 'verified') RETURNING id`,
      [e!.id],
    ))!.id;
    deviceId = (await issueDevice('driver.test')).deviceId;
  });
  after(async () => {
    await cleanup();
    await query(`DELETE FROM driver_device WHERE id = $1`, [deviceId]);
    await pool.end();
  });
}

dbDescribe('stations: v1.3 visibility and states', () => {
  test('a listed connector shows the charger display name and the sGBT label', async () => {
    const d = await connectorDetail(connectorId);
    assert.ok(d);
    assert.equal(d.chargerName, 'Lobby Charger');
    assert.equal(d.typeLabel, 'GB/T');
  });

  test('a connector on maintenance hold is out of service, without leaking the internal reason', async () => {
    await query(`UPDATE connector SET maintenance_reason = 'gun cable damaged', maintenance_since = now() WHERE id = $1`, [connectorId]);
    try {
      const d = await connectorDetail(connectorId);
      assert.equal(d?.status, 'Maintenance');
      assert.equal(d?.available, false);
      assert.doesNotMatch(String(d?.blockedReason), /cable/);
      const q = await quotePrepaid(connectorId, 50_000);
      assert.equal(q.ok, false);
      assert.match(String(q.error), /perawatan/);
    } finally {
      await query(`UPDATE connector SET maintenance_reason = NULL, maintenance_since = NULL WHERE id = $1`, [connectorId]);
    }
  });

  test('a meter awaiting calibration (tera pending) cannot be sold from', async () => {
    await query(`UPDATE connector SET tera_status = 'pending', tera_cert_status = 'pending' WHERE id = $1`, [connectorId]);
    try {
      assert.equal((await connectorDetail(connectorId))?.status, 'Blocked');
      assert.equal((await quotePrepaid(connectorId, 50_000)).ok, false);
    } finally {
      await query(`UPDATE connector SET tera_status = 'verified', tera_cert_status = 'verified' WHERE id = $1`, [connectorId]);
    }
  });

  test('an archived site disappears from the list, the detail and QR resolution', async () => {
    assert.ok((await listStations()).some((s) => s.siteId === siteId));
    await query(`UPDATE site SET archived_at = now() WHERE id = $1`, [siteId]);
    try {
      assert.ok(!(await listStations()).some((s) => s.siteId === siteId));
      assert.equal(await connectorDetail(connectorId), null);
      assert.equal(await resolveCode(`${IDENT}:1`), null);
      assert.equal((await quotePrepaid(connectorId, 50_000)).ok, false);
    } finally {
      await query(`UPDATE site SET archived_at = NULL WHERE id = $1`, [siteId]);
    }
  });

  test('a decommissioned charger cannot be reached by an old QR sticker', async () => {
    await query(`UPDATE charge_point SET status = 'decommissioned' WHERE ocpp_identity = $1`, [IDENT]);
    try {
      assert.equal(await resolveCode(IDENT), null);
    } finally {
      await query(`UPDATE charge_point SET status = 'offline' WHERE ocpp_identity = $1`, [IDENT]);
    }
  });
});

dbDescribe('fleet sign-in with a PIN set in the v1.3 RFID centre', () => {
  test('a scrypt PIN from the console works, and a lower-case serial is the same card', async () => {
    await query(
      `INSERT INTO token (org_id, kind, uid, status, pin_hash) VALUES ($1, 'rfid', 'AB12CD34', 'Accepted', $2)`,
      [orgId, await hashPassword('482913')],
    );
    const r = await fleetLogin(deviceId, SLUG, 'ab12cd34', '482913');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.fleet.uid, 'AB12CD34');
  });

  test('a legacy v1.2 SHA-256 PIN still works and is upgraded to scrypt', async () => {
    const legacy = createHash('sha256').update('1111').digest('hex');
    await query(`INSERT INTO token (org_id, kind, uid, status, pin_hash) VALUES ($1, 'rfid', 'LEGACY-01', 'Accepted', $2)`, [orgId, legacy]);
    assert.equal((await fleetLogin(deviceId, SLUG, 'LEGACY-01', '1111')).ok, true);
    const t = await one<{ pin_hash: string }>(`SELECT pin_hash FROM token WHERE org_id = $1 AND uid = 'LEGACY-01'`, [orgId]);
    assert.match(t!.pin_hash, /^scrypt\$/);
    assert.equal((await fleetLogin(deviceId, SLUG, 'LEGACY-01', '1111')).ok, true);
  });

  test('five wrong PINs lock the card, even against the right PIN', async () => {
    await query(
      `INSERT INTO token (org_id, kind, uid, status, pin_hash) VALUES ($1, 'rfid', 'LOCK-01', 'Accepted', $2)`,
      [orgId, await hashPassword('246810')],
    );
    for (let i = 0; i < 5; i++) assert.equal((await fleetLogin(deviceId, SLUG, 'LOCK-01', '000000')).ok, false);
    const r = await fleetLogin(deviceId, SLUG, 'LOCK-01', '246810');
    assert.equal(r.ok, false);
    // The same answer as a wrong PIN (a distinct one would mark the card as real).
    if (!r.ok) assert.equal(r.error, FLEET_LOGIN_FAILED);
    const t = await one<{ locked: boolean }>(`SELECT (pin_locked_until > now()) AS locked FROM token WHERE org_id = $1 AND uid = 'LOCK-01'`, [orgId]);
    assert.equal(t!.locked, true);
  });

  test('an expired card is refused at sign-in', async () => {
    await query(
      `INSERT INTO token (org_id, kind, uid, status, pin_hash, valid_to) VALUES ($1, 'rfid', 'EXP-01', 'Accepted', $2, now() - interval '1 day')`,
      [orgId, await hashPassword('135790')],
    );
    const r = await fleetLogin(deviceId, SLUG, 'EXP-01', '135790');
    assert.equal(r.ok, false);
    // Refused with the one fleet sign-in answer; the reason ("card expired") is in the log.
    if (!r.ok) assert.equal(r.error, FLEET_LOGIN_FAILED);
  });

  test('a card over its RFID-centre energy limit is refused before the charger is asked', async () => {
    const t = await one<{ id: string }>(
      `INSERT INTO token (org_id, kind, uid, status, energy_limit_wh) VALUES ($1, 'rfid', 'LIMIT-01', 'Accepted', 0) RETURNING id`,
      [orgId],
    );
    assert.match(String(await fleetTokenProblem(t!.id)), /Batas energi/);
    await query(`UPDATE token SET energy_limit_wh = NULL WHERE id = $1`, [t!.id]);
    assert.equal(await fleetTokenProblem(t!.id), null);
  });
});
