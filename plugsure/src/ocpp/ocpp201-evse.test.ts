import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import type { AdapterContext } from './adapter16.js';
import { handle201Call, connectorRowStatuses, evseStatusOf, seqNoCheck } from './adapter201.js';
import { evseStatusOfConnectors } from '../ocpi/mapping.js';
import { bus } from '../services/events.js';
import type { ConnectorStatus } from '../domain/canonical.js';

/**
 * OCPP 2.0.1 EVSE fixes:
 *   A  a multi-connector EVSE (CCS2 + CHAdeMO dual gun) keeps each connector's
 *      status; the rows the console / driver app / OCPI read show the EVSE's
 *      availability instead of "the last gun to speak"
 *   B  TransactionEvent(Ended) for a transaction never seen to start is recorded,
 *      parked for review, never billed
 *   C  seqNo gaps are detected and flagged (never reordered)
 *
 * The database-backed suites run only against the disposable test database
 * (DATABASE_URL …/plugsure_audit_fix).
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[ocpp201-evse.test] SKIPPING database-backed suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

// ------------------------------------------------------------------ pure

describe('A: EVSE status from its connectors (pure)', () => {
  const rows = (ids: number[], rep: Record<number, ConnectorStatus>) => Object.fromEntries(connectorRowStatuses(ids, rep));

  test('a single-connector EVSE shows exactly what it reported', () => {
    for (const s of ['Available', 'Charging', 'Reserved', 'Unavailable', 'Faulted'] as ConnectorStatus[]) {
      assert.deepEqual(rows([1], { 1: s }), { 1: s });
    }
  });

  test('one row (unconfigured EVSE): any gun in use makes it busy; the idle gun reporting Unavailable does not hide it', () => {
    assert.deepEqual(rows([1], { 1: 'Charging', 2: 'Unavailable' }), { 1: 'Charging' });
    assert.deepEqual(rows([1], { 1: 'Unavailable', 2: 'Charging' }), { 1: 'Charging' });
    assert.deepEqual(rows([1], { 1: 'Faulted', 2: 'Available' }), { 1: 'Available' }, 'usable through the other gun');
    assert.deepEqual(rows([1], { 1: 'Faulted', 2: 'Unavailable' }), { 1: 'Faulted' });
    assert.deepEqual(rows([1], { 1: 'Available', 2: 'Reserved' }), { 1: 'Reserved' });
  });

  test('one row per gun: each shows its own status unless the EVSE is taken', () => {
    assert.deepEqual(rows([1, 2], { 1: 'Faulted', 2: 'Available' }), { 1: 'Faulted', 2: 'Available' });
    assert.deepEqual(rows([1, 2], { 1: 'Charging', 2: 'Available' }), { 1: 'Charging', 2: 'Charging' }, 'the other gun cannot be used meanwhile');
    assert.deepEqual(rows([1, 2], { 2: 'Reserved' }), { 1: 'Reserved', 2: 'Reserved' });
    assert.deepEqual(rows([1, 2], { 1: 'Available' }), { 1: 'Available', 2: 'Available' }, 'a gun with no report of its own shows the EVSE');
  });

  test('nothing reported changes nothing', () => {
    assert.equal(connectorRowStatuses([1, 2], {}).size, 0);
    assert.equal(evseStatusOf([]), null);
  });

  test('OCPI: an EVSE is as usable as its most usable connector; one connector is unchanged', () => {
    const e = { decommissioned: false, online: true, reserved: false };
    const c = (status: string, maintenance_reason: string | null = null) => ({ status, maintenance_reason });
    assert.equal(evseStatusOfConnectors(e, [c('Faulted'), c('Available')]), 'AVAILABLE');
    assert.equal(evseStatusOfConnectors(e, [c('Charging'), c('Charging')]), 'CHARGING');
    assert.equal(evseStatusOfConnectors(e, [c('Faulted'), c('Unavailable')]), 'OUTOFORDER');
    assert.equal(evseStatusOfConnectors(e, [c('Faulted')]), 'OUTOFORDER');
    assert.equal(evseStatusOfConnectors(e, []), 'UNKNOWN');
    assert.equal(evseStatusOfConnectors({ ...e, online: false }, [c('Available'), c('Available')]), 'UNKNOWN');
  });
});

describe('C: seqNo (pure)', () => {
  test('next, duplicate, late, gap', () => {
    assert.deepEqual(seqNoCheck(null, 5), { kind: 'first' });
    assert.deepEqual(seqNoCheck(0, 1), { kind: 'next' });
    assert.deepEqual(seqNoCheck(3, 3), { kind: 'duplicate' });
    assert.deepEqual(seqNoCheck(5, 2), { kind: 'late' });
    assert.deepEqual(seqNoCheck(1, 4), { kind: 'gap', missingFrom: 2, missingTo: 3 });
  });
});

// ------------------------------------------------------------------ database

const SLUG = 'ocpp201-evse-test';
const IDENT = 'O201EVSE-TEST-01';
const CARD = 'O201EVSE-CARD';
let orgId = '';
let cpId = '';

async function cleanup(): Promise<void> {
  const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (!org) return;
  const cs = `SELECT id FROM charging_session WHERE org_id = $1`;
  await query(`DELETE FROM cdr WHERE session_id IN (${cs})`, [org.id]);
  await query(`DELETE FROM meter_value WHERE session_id IN (${cs})`, [org.id]);
  await query(`DELETE FROM charging_session WHERE org_id = $1`, [org.id]);
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
      `INSERT INTO organisation (name, slug) VALUES ('OCPP 2.0.1 EVSE Test', $1)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    const siteId = (await one<{ id: string }>(
      `INSERT INTO site (org_id, name, local_tax_rate_bps) VALUES ($1, 'EVSE Test Hub', 1000) RETURNING id`, [orgId]))!.id;
    cpId = (await one<{ id: string }>(
      `INSERT INTO charge_point (site_id, ocpp_identity, ocpp_version, status) VALUES ($1, $2, 'ocpp2.0.1', 'online') RETURNING id`,
      [siteId, IDENT]))!.id;
    // EVSE 1: dual gun, both connectors configured. EVSE 2: one row (as auto-created).
    const e1 = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1, 1, 60000) RETURNING id`, [cpId]))!.id;
    await query(
      `INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w) VALUES ($1, 1, 'cCCS2', 'DC', 60000), ($1, 2, 'cChaDeMo', 'DC', 50000)`,
      [e1]);
    const e2 = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1, 2, 60000) RETURNING id`, [cpId]))!.id;
    await query(`INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w) VALUES ($1, 1, 'cCCS2', 'DC', 60000)`, [e2]);
    await query(`INSERT INTO token (org_id, kind, uid, status) VALUES ($1, 'rfid', $2, 'Accepted')`, [orgId, CARD]);
  });
  after(async () => {
    await cleanup();
    await pool.end();
  });
}

const ctx = (): AdapterContext => ({ ocppIdentity: IDENT, chargePointId: cpId, orgId, version: 'ocpp2.0.1' });
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const status = (evseId: number, connectorId: number, connectorStatus: string) =>
  handle201Call(ctx(), 'StatusNotification', { timestamp: iso(), connectorStatus, evseId, connectorId });
const rowStatus = async (evseId: number) =>
  Object.fromEntries((await query<{ connector_id: number; status: string }>(
    `SELECT c.connector_id, c.status FROM connector c JOIN evse e ON e.id = c.evse_uuid
      WHERE e.charge_point_id = $1 AND e.evse_id = $2 ORDER BY c.connector_id`, [cpId, evseId])).rows.map((r) => [r.connector_id, r.status]));
const session = (tx: string) => one<any>(`SELECT * FROM charging_session WHERE charge_point_id = $1 AND ocpp_transaction_id = $2`, [cpId, tx]);
const reg = (wh: number, context: string, at = iso(-60_000)) =>
  ({ timestamp: at, sampledValue: [{ value: wh, measurand: 'Energy.Active.Import.Register', context, unitOfMeasure: { unit: 'Wh' } }] });

dbDescribe('A: dual-gun EVSE status (StatusNotification)', () => {
  test('the idle gun reporting after the busy one does not make the EVSE look free or broken', async () => {
    await status(1, 1, 'Available');
    await status(1, 2, 'Available');
    assert.deepEqual(await rowStatus(1), { 1: 'Available', 2: 'Available' });

    await status(1, 2, 'Occupied'); // CHAdeMO plugged in
    await status(1, 1, 'Unavailable'); // CCS locked out while the other gun is used
    assert.deepEqual(await rowStatus(1), { 1: 'Charging', 2: 'Charging' }, 'last report used to win: CCS Unavailable');

    await status(1, 2, 'Available');
    await status(1, 1, 'Faulted');
    assert.deepEqual(await rowStatus(1), { 1: 'Faulted', 2: 'Available' }, 'each gun its own status once the EVSE is free');

    const e = await one<{ connector_status: any }>(`SELECT connector_status FROM evse WHERE charge_point_id = $1 AND evse_id = 1`, [cpId]);
    assert.equal(e!.connector_status['1'].status, 'Faulted');
    assert.equal(e!.connector_status['1'].raw, 'Faulted');
    assert.equal(e!.connector_status['2'].status, 'Available');
  });

  test('an EVSE with one row folds the second gun into it', async () => {
    await status(2, 1, 'Occupied');
    await status(2, 2, 'Unavailable');
    assert.deepEqual(await rowStatus(2), { 1: 'Charging' });
    await status(2, 1, 'Available');
    assert.deepEqual(await rowStatus(2), { 1: 'Available' });
    await status(2, 1, 'Faulted');
    assert.deepEqual(await rowStatus(2), { 1: 'Faulted' }, 'Faulted beats Unavailable');
  });
});

dbDescribe('B: Ended for a transaction never seen to start', () => {
  const ended = (tx: string, extra: Record<string, unknown> = {}) => handle201Call(ctx(), 'TransactionEvent', {
    eventType: 'Ended', timestamp: iso(-10_000), triggerReason: 'EVDeparted', seqNo: 4,
    transactionInfo: { transactionId: tx, stoppedReason: 'EVDisconnected' }, evse: { id: 1, connectorId: 1 },
    idToken: { idToken: CARD, type: 'ISO14443' },
    meterValue: [reg(120_000, 'Transaction.Begin', iso(-3_600_000)), reg(135_500, 'Transaction.End', iso(-10_000))],
    ...extra,
  });

  test('recorded from the end event, parked for review, not billed, and a replay changes nothing', async () => {
    assert.deepEqual(await ended('o201-lost-start'), {});
    const s = await session('o201-lost-start');
    assert.ok(s, 'the transaction is recorded');
    assert.equal(s.state, 'ended');
    assert.equal(Number(s.energy_wh), 15_500);
    assert.equal(Number(s.meter_start_wh), 120_000);
    assert.equal(Number(s.meter_stop_wh), 135_500);
    assert.equal(s.needs_review, true);
    assert.equal(s.review_reason, 'TRANSACTION_RECONSTRUCTED');
    assert.equal(s.token_id, null, 'no payer is bound');
    assert.equal(s.stop_reason, 'EVDisconnected');
    assert.equal(s.ocpp_seq_no, 4);
    const flag = (s.flags as any[]).find((f) => f.code === 'TRANSACTION_RECONSTRUCTED');
    assert.equal(flag.severity, 'violation');
    assert.equal(flag.idToken, CARD);
    assert.match(flag.message, /seqNo 0-3/);
    assert.ok(Math.abs(new Date(s.started_at).getTime() - (Date.now() - 3_600_000)) < 60_000, 'start time from the Begin register');
    assert.equal((await one<any>(`SELECT count(*)::int AS n FROM meter_value WHERE session_id = $1`, [s.id])).n, 2);
    assert.equal(await one(`SELECT id FROM cdr WHERE session_id = $1`, [s.id]), null, 'nothing billed');

    await ended('o201-lost-start');
    assert.equal((await one<any>(`SELECT count(*)::int AS n FROM charging_session WHERE charge_point_id = $1 AND ocpp_transaction_id = 'o201-lost-start'`, [cpId])).n, 1);
  });

  test('it does not touch a session running on the same EVSE now', async () => {
    await handle201Call(ctx(), 'TransactionEvent', {
      eventType: 'Started', timestamp: iso(-5_000), triggerReason: 'Authorized', seqNo: 0,
      transactionInfo: { transactionId: 'o201-running' }, evse: { id: 1, connectorId: 1 }, idToken: { idToken: CARD, type: 'ISO14443' },
      meterValue: [reg(200_000, 'Transaction.Begin', iso(-5_000))],
    });
    await ended('o201-lost-2');
    assert.equal((await session('o201-running')).state, 'active');
    assert.ok(await session('o201-lost-2'));
    await query(`UPDATE charging_session SET state = 'ended', ended_at = now() WHERE org_id = $1 AND state = 'active'`, [orgId]);
  });

  test('only an end register: 0 Wh recorded, start unknown, end register kept', async () => {
    await ended('o201-lost-3', { meterValue: [reg(90_000, 'Transaction.End', iso(-10_000))] });
    const s = await session('o201-lost-3');
    assert.equal(Number(s.energy_wh), 0);
    assert.equal(s.meter_start_unknown, true);
    assert.equal(Number(s.meter_stop_wh), 90_000);
    assert.equal(s.needs_review, true);
  });

  /**
   * A replayed Ended for a session that is already ended — reconstructed, or a
   * normal one parked for review — used to announce session.ended again and
   * re-raise the needs-review alert on every replay (a station resends its
   * offline queue until it sees a response). It must change nothing.
   */
  test('a replayed Ended for an ended session emits nothing, alerts nothing, bills nothing', async () => {
    const seen: string[] = [];
    const stop = bus.onAny((e) => {
      const p = e.payload as any;
      if ((e.kind === 'session.ended' || e.kind === 'alert.raised') && p?.orgId === orgId) seen.push(e.kind);
    });
    try {
      // Reconstructed: the first Ended records it and raises one alert; replays are silent.
      await ended('o201-replay-unknown');
      assert.deepEqual(seen, ['alert.raised'], 'one needs-review alert, no session.ended for a reconstructed transaction');
      seen.length = 0;
      await ended('o201-replay-unknown');
      await ended('o201-replay-unknown');
      assert.deepEqual(seen, [], 'replays of a reconstructed Ended');

      // A normal session parked for review: one end, one alert; then replays change nothing.
      await handle201Call(ctx(), 'TransactionEvent', {
        eventType: 'Started', timestamp: iso(-600_000), triggerReason: 'Authorized', seqNo: 0,
        transactionInfo: { transactionId: 'o201-replay-parked' }, evse: { id: 1, connectorId: 1 }, idToken: { idToken: CARD, type: 'ISO14443' },
        meterValue: [reg(300_000, 'Transaction.Begin', iso(-600_000))],
      });
      await query(`UPDATE charging_session SET needs_review = true, review_reason = 'TEST_PARKED'
                    WHERE charge_point_id = $1 AND ocpp_transaction_id = 'o201-replay-parked'`, [cpId]);
      seen.length = 0;
      const end = () => handle201Call(ctx(), 'TransactionEvent', {
        eventType: 'Ended', timestamp: iso(-10_000), triggerReason: 'EVDeparted', seqNo: 1,
        transactionInfo: { transactionId: 'o201-replay-parked', stoppedReason: 'EVDisconnected' }, evse: { id: 1, connectorId: 1 },
        meterValue: [reg(310_000, 'Transaction.End', iso(-10_000))],
      });
      await end();
      assert.deepEqual(seen.sort(), ['alert.raised', 'session.ended'], 'the first Ended: one session.ended, one needs-review alert');
      const before = await session('o201-replay-parked');
      assert.equal(before.state, 'ended');
      assert.equal(Number(before.energy_wh), 10_000);
      seen.length = 0;
      await end();
      await end();
      assert.deepEqual(seen, [], 'replays: no session.ended, no alert');
      const after = await session('o201-replay-parked');
      assert.equal(Number(after.energy_wh), 10_000);
      assert.equal(after.state, 'ended');
      assert.deepEqual(after.flags, before.flags, 'no flags added by a replay');
      assert.equal(await one(`SELECT id FROM cdr WHERE session_id = $1`, [after.id]), null, 'still not billed');
    } finally {
      stop();
    }
  });

  test('the end of a start we refused (DeAuthorized, no energy) is not recorded', async () => {
    await ended('o201-refused', {
      transactionInfo: { transactionId: 'o201-refused', stoppedReason: 'DeAuthorized' }, triggerReason: 'Deauthorized', seqNo: 1,
      meterValue: [reg(50_000, 'Transaction.Begin'), reg(50_000, 'Transaction.End')],
    });
    assert.equal(await session('o201-refused'), null);
  });
});

dbDescribe('C: seqNo gaps', () => {
  const ev = (eventType: string, seqNo: number, wh: number) => handle201Call(ctx(), 'TransactionEvent', {
    eventType, timestamp: iso(-1_000), triggerReason: eventType === 'Started' ? 'Authorized' : 'MeterValuePeriodic', seqNo,
    transactionInfo: { transactionId: 'o201-seq', chargingState: 'Charging' }, evse: { id: 2, connectorId: 1 },
    ...(eventType === 'Started' ? { idToken: { idToken: CARD, type: 'ISO14443' } } : {}),
    meterValue: [reg(wh, 'Sample.Periodic', iso(-1_000))],
  });

  test('a jump is flagged once; events are processed as they arrive', async () => {
    await ev('Started', 0, 10_000);
    await ev('Updated', 1, 11_000);
    let s = await session('o201-seq');
    assert.equal(s.ocpp_seq_no, 1);
    assert.equal((s.flags as any[]).some((f) => f.code === 'TRANSACTION_EVENTS_MISSING'), false);

    await ev('Updated', 4, 14_000); // 2 and 3 lost
    s = await session('o201-seq');
    assert.equal(s.ocpp_seq_no, 4);
    const flags = (s.flags as any[]).filter((f) => f.code === 'TRANSACTION_EVENTS_MISSING');
    assert.equal(flags.length, 1);
    assert.match(flags[0].message, /seqNo 2-3/);
    assert.equal(flags[0].severity, 'warning');
    assert.equal(s.needs_review, false, 'a gap alone does not park the session');
    assert.equal(Number(s.energy_wh), 4_000);

    await ev('Updated', 2, 12_000); // late arrival: recorded, highest seqNo unchanged, energy never goes back
    await ev('Updated', 7, 17_000); // another gap: logged, not flagged twice
    s = await session('o201-seq');
    assert.equal(s.ocpp_seq_no, 7);
    assert.equal((s.flags as any[]).filter((f) => f.code === 'TRANSACTION_EVENTS_MISSING').length, 1);
    assert.equal(Number(s.energy_wh), 7_000);
    await ev('Ended', 8, 18_000);
    assert.notEqual((await session('o201-seq')).state, 'active', 'the Ended closed it');
  });
});
