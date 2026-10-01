import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { createTariff, assignTariff } from './tariff-store.js';
import { createPromotion } from './benefits.js';
import { handleTransactionEvent, rateAndCreateCdr, runningCost, sessionIdemKey, clearRunningCostCache } from './sessions.js';
import type { TransactionEvent } from '../domain/canonical.js';

/**
 * The cost during the charge (database-backed).
 *
 * The promise to the driver: the running cost at the moment the charge stops IS the bill,
 * to the rupiah. Sessions go through the real OCPP event path (start, samples, stop),
 * then the charge record is rated, and the two are compared.
 *
 * Runs only against the disposable test database, like the audit suites:
 *   DATABASE_URL=postgresql://postgres:…@127.0.0.1:5432/plugsure_audit_fix npm test
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[running-cost.test] SKIPPING database-backed running-cost suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
// One file at a time against the audit chain (src/db/test-lock.ts).
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'running-cost-test';
const IDENT = 'RUNCOST-TEST-01';
let orgId = '';
let siteId = '';
let cpId = '';
let txSeq = Date.now() % 1_000_000;

async function cleanup(): Promise<void> {
  const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (!org) return;
  const cs = `SELECT id FROM charging_session WHERE org_id = $1`;
  await query(`DELETE FROM promotion_redemption WHERE promotion_id IN (SELECT id FROM promotion WHERE org_id = $1)`, [org.id]);
  await query(`DELETE FROM cdr WHERE session_id IN (${cs})`, [org.id]);
  await query(`DELETE FROM meter_value WHERE session_id IN (${cs})`, [org.id]);
  await query(`DELETE FROM charging_session WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM promotion WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM tariff_assignment WHERE tariff_id IN (SELECT id FROM tariff WHERE org_id = $1)`, [org.id]);
  await query(`DELETE FROM tariff WHERE org_id = $1`, [org.id]);
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
      `INSERT INTO organisation (name, slug) VALUES ('Running Cost Test', $1)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    siteId = (await one<{ id: string }>(
      `INSERT INTO site (org_id, name, pbjt_rate_bps) VALUES ($1, 'Running Cost Hub', 1000) RETURNING id`, [orgId]))!.id;
    cpId = (await one<{ id: string }>(
      `INSERT INTO charge_point (site_id, ocpp_identity, ocpp_version, status) VALUES ($1, $2, 'ocpp1.6', 'online') RETURNING id`, [siteId, IDENT]))!.id;
    const e = await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1, 1, 22000) RETURNING id`, [cpId]);
    await query(
      `INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w, tera_status, tera_cert_status)
       VALUES ($1, 1, 'Type2', 'AC', 22000, 'verified', 'verified')`, [e!.id]);
    for (const uid of ['RC-PLAIN', 'RC-PROMO']) {
      await query(`INSERT INTO token (org_id, kind, uid, status) VALUES ($1, 'rfid', $2, 'Accepted')`, [orgId, uid]);
    }
    // Energy, a service fee, and an idle fee after 5 minutes' grace: all three move during a charge.
    const t = await createTariff({
      orgId, name: 'Running cost', appliesToMaxPowerW: 22_000,
      components: [
        { kind: 'energy', rate: 2_400, touBlock: 'ANY', fromKwh: 0, fromMinutes: 0 },
        { kind: 'session', rate: 5_000, touBlock: 'ANY', fromKwh: 0, fromMinutes: 0 },
        { kind: 'idle', rate: 1_000, touBlock: 'ANY', fromKwh: 0, fromMinutes: 5, toMinutes: 60 },
      ] as any,
    });
    assert.equal(t.ok, true, JSON.stringify(t));
    // Effective from well before the sessions start (rating uses the tariff as of the start).
    await query(`UPDATE tariff SET active_from = now() - interval '1 day' WHERE id = $1`, [t.tariffId]);
    assert.equal((await assignTariff(t.tariffId!, 'site', siteId, 0, 'AC')).ok, true);
    // Assignments are versioned: one made now applies to sessions that START from now. The sessions here
    // are backdated, so the assignment is too.
    await query(`UPDATE tariff_assignment SET valid_from = now() - interval '1 day' WHERE tariff_id = $1`, [t.tariffId]);
  });
  after(async () => {
    await cleanup();
    await pool.end();
  });
}

const iso = (t: number) => new Date(t).toISOString();
const reg = (wh: number) => [{ measurand: 'Energy.Active.Import.Register', value: wh, unit: 'Wh' }];

/** A charge: 8 kWh over 40 minutes, then the car sits full; returns what's needed to stop it. */
async function charge(uid: string) {
  // A previous test that failed mid-way may have left its session running on the connector.
  await query(`UPDATE charging_session SET state = 'ended', ended_at = now() WHERE org_id = $1 AND state = 'active'`, [orgId]);
  const t0 = Date.now() - 70 * 60_000;
  const transactionId = String(++txSeq);
  const evse = { chargePointId: cpId, ocppIdentity: IDENT, evseId: 1, connectorId: 1 };
  const base = { transactionId, evse, idToken: { type: 'ISO14443', idToken: uid } };
  const idemKey = sessionIdemKey(IDENT, 1, uid, 100_000, iso(t0));
  const ev = (over: Partial<TransactionEvent>): TransactionEvent => ({ ...base, idemKey, seqNo: 0, meterValue: [], ...over } as TransactionEvent);
  const s = await handleTransactionEvent(ev({ eventType: 'Started', triggerReason: 'Authorized', timestamp: iso(t0), meterValue: [{ timestamp: iso(t0), sampledValue: reg(100_000) }] }), cpId);
  assert.ok(s, 'session started');
  let seq = 1;
  for (const m of [10, 20, 30, 40, 50, 60]) {
    const wh = 100_000 + Math.min(m, 40) * 200; // 2 kWh per 10 min, flat after 40 min
    await handleTransactionEvent(ev({ eventType: 'Updated', triggerReason: 'MeterValuePeriodic', seqNo: seq++, timestamp: iso(t0 + m * 60_000),
      chargingState: m > 40 ? 'SuspendedEV' : 'Charging', meterValue: [{ timestamp: iso(t0 + m * 60_000), sampledValue: reg(wh) }] }), cpId);
  }
  const stopAt = t0 + 62 * 60_000;
  const stop = () => handleTransactionEvent(ev({ eventType: 'Ended', triggerReason: 'EVDisconnected', seqNo: seq++, timestamp: iso(stopAt), stoppedReason: 'EVDisconnected',
    meterValue: [{ timestamp: iso(stopAt), sampledValue: reg(108_000) }] }), cpId);
  return { sessionId: s!.id, t0, stopAt, stop };
}

async function billOf(sessionId: string) {
  return one<{ total_idr: number; subtotal_idr: number; pbjt_idr: number; ppn_idr: number }>(
    `SELECT total_idr, subtotal_idr, pbjt_idr, ppn_idr FROM cdr WHERE session_id = $1`, [sessionId]);
}

dbDescribe('the cost during the charge is the bill', () => {
  test('energy, service fee and a rising idle fee: the running cost at the stop equals the charge record to the rupiah', async () => {
    clearRunningCostCache();
    const c = await charge('RC-PLAIN');
    // While charging, 12 minutes after the car stopped drawing, and again 22 minutes after.
    const early = await runningCost(c.sessionId, new Date(c.t0 + 52 * 60_000));
    const atStop = await runningCost(c.sessionId, new Date(c.stopAt));
    assert.ok(early && atStop);
    assert.equal(atStop.final, false);
    assert.equal(atStop.energyWh, 8_000);
    assert.equal(atStop.idleMinutes, 22, 'idle counted from the last sample that still drew energy');
    assert.ok(atStop.idleFeeIdr > early.idleFeeIdr && early.idleFeeIdr > 0, `idle fee rises while the car sits full (${early.idleFeeIdr} → ${atStop.idleFeeIdr})`);
    assert.ok(atStop.totalIdr > early.totalIdr, 'so does the total, with no energy delivered');
    assert.equal(atStop.taxIdr > 0, true);
    // 8 kWh × 2,400 + 5,000 service + (22 − 5) min × 1,000 idle = 41,200 before tax: the operator tariff, not the fallback.
    assert.equal(atStop.subtotalIdr, 41_200);

    await c.stop();
    await rateAndCreateCdr(c.sessionId);
    const bill = await billOf(c.sessionId);
    assert.ok(bill, 'charge record issued');
    assert.equal(Number(bill.total_idr), atStop.totalIdr, 'the running cost at the stop is the bill');
    assert.equal(Number(bill.subtotal_idr), atStop.subtotalIdr);
    assert.equal(Number(bill.pbjt_idr) + Number(bill.ppn_idr), atStop.taxIdr);

    const after = await runningCost(c.sessionId);
    assert.deepEqual([after!.final, after!.totalIdr], [true, Number(bill.total_idr)], 'once rated: the bill itself');
  });

  test('with a promotion: the discount is in the running cost, exactly as billed', async () => {
    clearRunningCostCache();
    const promo = await createPromotion(orgId, { name: 'Twenty off', kind: 'energy_percent', value: 20, audience: 'everyone', siteIds: [siteId] });
    // In force before the session starts (benefits are judged as of the start).
    await query(`UPDATE promotion SET starts_at = now() - interval '1 day' WHERE id = $1`, [(promo as any).id]);
    const c = await charge('RC-PROMO');
    const atStop = await runningCost(c.sessionId, new Date(c.stopAt));
    assert.ok(atStop);
    assert.equal(atStop.discountIdr, 3_840, '20% of 8 kWh × Rp 2,400');
    await c.stop();
    await rateAndCreateCdr(c.sessionId);
    const bill = await billOf(c.sessionId);
    assert.equal(Number(bill!.total_idr), atStop.totalIdr, 'promotion priced identically during and after');
  });

  test('reads only: pricing the charge writes no charge record and leaves the session untouched', async () => {
    clearRunningCostCache();
    const c = await charge('RC-PLAIN');
    const before = await one(`SELECT state, energy_wh, idle_minutes, flags FROM charging_session WHERE id = $1`, [c.sessionId]);
    await runningCost(c.sessionId, new Date(c.stopAt));
    await runningCost(c.sessionId, new Date(c.stopAt)); // cached
    assert.equal(await billOf(c.sessionId), null);
    assert.deepEqual(await one(`SELECT state, energy_wh, idle_minutes, flags FROM charging_session WHERE id = $1`, [c.sessionId]), before);
    await c.stop();
  });
});
