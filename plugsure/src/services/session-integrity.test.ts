import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { one, many, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { handleTransactionEvent, implausibleEnergyFlag, sessionIdemKey } from './sessions.js';
import { handle16Call, type AdapterContext } from '../ocpp/adapter16.js';
import type { TransactionEvent, SampledValue } from '../domain/canonical.js';

/**
 * Session start, metering and idle time against the real schema (database-backed).
 *
 *  - a 2.0.1 Started with no energy register must not bill the lifetime register;
 *  - more energy than the connector could deliver parks the session;
 *  - duplicate StartTransactions arriving together open ONE session and never
 *    close it as "superseded";
 *  - idle minutes are counted on the register in Wh, whatever unit or phase the
 *    charger reports it in.
 *
 * Runs only against the disposable test database:
 *   DATABASE_URL=postgresql://postgres:…@127.0.0.1:5433/plugsure_audit_fix npm test
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[session-integrity.test] SKIPPING database-backed session suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'session-integrity-test';
const IDENT = 'SESSINT-TEST-01';
const UID = 'SI-CARD';
let orgId = '';
let siteId = '';
let cpId = '';
let txSeq = Date.now() % 1_000_000;

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
      `INSERT INTO organisation (name, slug) VALUES ('Session Integrity Test', $1)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    siteId = (await one<{ id: string }>(
      `INSERT INTO site (org_id, name, pbjt_rate_bps) VALUES ($1, 'Session Integrity Hub', 1000) RETURNING id`, [orgId]))!.id;
    cpId = (await one<{ id: string }>(
      `INSERT INTO charge_point (site_id, ocpp_identity, ocpp_version, status) VALUES ($1, $2, 'ocpp1.6', 'online') RETURNING id`, [siteId, IDENT]))!.id;
    const e = await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1, 1, 22000) RETURNING id`, [cpId]);
    await query(
      `INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w, tera_status, tera_cert_status)
       VALUES ($1, 1, 'Type2', 'AC', 22000, 'verified', 'verified')`, [e!.id]);
    await query(`INSERT INTO token (org_id, kind, uid, status) VALUES ($1, 'rfid', $2, 'Accepted')`, [orgId, UID]);
  });
  after(async () => {
    await cleanup();
    await pool.end();
  });
}

const iso = (t: number) => new Date(t).toISOString();
const reg = (wh: number): SampledValue[] => [{ measurand: 'Energy.Active.Import.Register', value: wh, unit: 'Wh' }];

async function freeConnector() {
  // A previous test that failed mid-way may have left its session running on the connector.
  await query(`UPDATE charging_session SET state = 'ended', ended_at = now() WHERE org_id = $1 AND state = 'active'`, [orgId]);
}

/** A 2.0.1-shaped transaction on connector 1. `startWh` null: Started carries no meterValue. */
function transaction(t0: number, startWh: number | null) {
  const transactionId = `si-${++txSeq}`;
  const evse = { chargePointId: cpId, ocppIdentity: IDENT, evseId: 1, connectorId: 1 };
  const idemKey = sessionIdemKey(IDENT, 1, UID, startWh ?? 0, iso(t0));
  let seq = 0;
  const ev = (over: Partial<TransactionEvent>): TransactionEvent =>
    ({ transactionId, evse, idToken: { type: 'ISO14443', idToken: UID }, idemKey, seqNo: seq++, meterValue: [], ...over } as TransactionEvent);
  return {
    start: () => handleTransactionEvent(ev({
      eventType: 'Started', triggerReason: 'Authorized', timestamp: iso(t0),
      meterValue: startWh == null ? [] : [{ timestamp: iso(t0), sampledValue: reg(startWh) }],
    }), cpId),
    sample: (atMin: number, sampledValue: SampledValue[]) => handleTransactionEvent(ev({
      eventType: 'Updated', triggerReason: 'MeterValuePeriodic', timestamp: iso(t0 + atMin * 60_000),
      meterValue: [{ timestamp: iso(t0 + atMin * 60_000), sampledValue }],
    }), cpId),
    end: (atMin: number, sampledValue: SampledValue[] | null) => handleTransactionEvent(ev({
      eventType: 'Ended', triggerReason: 'EVDisconnected', timestamp: iso(t0 + atMin * 60_000), stoppedReason: 'EVDisconnected',
      meterValue: sampledValue ? [{ timestamp: iso(t0 + atMin * 60_000), sampledValue }] : [],
      meterStopAbsent: sampledValue == null,
    }), cpId),
  };
}

async function sessionRow(id: string) {
  return one<any>(`SELECT * FROM charging_session WHERE id = $1`, [id]);
}

describe('energy plausibility (pure)', () => {
  test('flags energy beyond nameplate x duration x 1.25 + 1 kWh, only when both are known', () => {
    // 22 kW for 1 h: 27,500 + 1,000 = 28,500 Wh is the most that is believable.
    assert.equal(implausibleEnergyFlag(28_500, 3600, 22_000), null);
    const f = implausibleEnergyFlag(28_501, 3600, 22_000);
    assert.equal(f?.code, 'IMPLAUSIBLE_ENERGY');
    assert.equal(f?.severity, 'warning', 'a small excess (a clock step, a nameplate that understates) is shown, not parked');
    assert.equal(implausibleEnergyFlag(48_500, 3600, 22_000)?.severity, 'warning', '20 kWh over: still a warning');
    assert.equal(implausibleEnergyFlag(48_501, 3600, 22_000)?.severity, 'violation', 'beyond 20 kWh over: parked');
    assert.equal(implausibleEnergyFlag(8_450_000, 2400, 22_000)?.severity, 'violation', 'a lifetime register: parked');
    assert.equal(implausibleEnergyFlag(8_450_000, 3600, 0), null, 'unknown nameplate: never guessed');
    assert.equal(implausibleEnergyFlag(8_450_000, 0, 22_000), null, 'no duration: never guessed');
  });
});

dbDescribe('start register absent on TransactionEvent(Started)', () => {
  test('the first observed register is the start, not the lifetime total', async () => {
    await freeConnector();
    const t0 = Date.now() - 60 * 60_000;
    const tx = transaction(t0, null);
    const s = await tx.start();
    assert.ok(s);
    assert.equal(s.meter_start_unknown, true);

    await tx.sample(10, reg(8_450_000)); // lifetime register: the start, energy 0
    let row = await sessionRow(s.id);
    assert.equal(Number(row.energy_wh), 0, 'the lifetime register must not become session energy');
    assert.equal(Number(row.meter_start_wh), 8_450_000);
    assert.equal(row.meter_start_unknown, false);
    assert.ok(row.flags.some((f: any) => f.code === 'METER_START_INFERRED'));

    await tx.sample(20, reg(8_452_000));
    row = await sessionRow(s.id);
    assert.equal(Number(row.energy_wh), 2_000);

    const ended = await tx.end(30, reg(8_455_000));
    assert.equal(ended!.state === 'ended' || ended!.state === 'rated', true);
    row = await sessionRow(s.id);
    assert.equal(Number(row.energy_wh), 5_000);
    assert.equal(Number(row.meter_start_wh), 8_450_000);
    assert.equal(Number(row.meter_stop_wh), 8_455_000);
    assert.equal(row.needs_review, false);
  });

  test('a stop that is the first register observed bills from it (0 Wh), not from zero', async () => {
    await freeConnector();
    const tx = transaction(Date.now() - 30 * 60_000, null);
    const s = await tx.start();
    await tx.end(20, reg(8_450_000));
    const row = await sessionRow(s!.id);
    assert.equal(Number(row.energy_wh), 0);
    assert.equal(Number(row.meter_start_wh), 8_450_000);
    assert.ok(!row.flags.some((f: any) => f.code === 'IMPLAUSIBLE_ENERGY'));
  });

  test('no register ever observed: energy 0, flagged', async () => {
    await freeConnector();
    const tx = transaction(Date.now() - 30 * 60_000, null);
    const s = await tx.start();
    await tx.sample(10, [{ measurand: 'Power.Active.Import', value: 7_000, unit: 'W' }]);
    await tx.end(20, null);
    const row = await sessionRow(s!.id);
    assert.equal(Number(row.energy_wh), 0);
    assert.equal(row.meter_stop_wh, null);
    assert.equal(row.meter_start_unknown, true);
    assert.ok(row.flags.some((f: any) => f.code === 'METER_REGISTER_ABSENT'));
  });

  test('energy the connector could not have delivered parks the session, no CDR', async () => {
    await freeConnector();
    // A start register of 0 (as the old `?? 0` produced) against a lifetime register:
    // 8,450 kWh in 30 minutes on a 22 kW connector.
    const tx = transaction(Date.now() - 40 * 60_000, 0);
    const s = await tx.start();
    await tx.end(30, reg(8_450_000));
    const row = await sessionRow(s!.id);
    assert.equal(row.needs_review, true);
    assert.equal(row.review_reason, 'IMPLAUSIBLE_ENERGY');
    assert.equal(await one(`SELECT id FROM cdr WHERE session_id = $1`, [s!.id]), null);
  });
});

dbDescribe('session start is atomic per connector', () => {
  const ctx = (): AdapterContext => ({ ocppIdentity: IDENT, chargePointId: cpId, orgId });

  test('duplicate StartTransactions arriving together open one session and never close it', async () => {
    await freeConnector();
    const req = { connectorId: 1, idTag: UID, meterStart: 120_000, timestamp: iso(Date.now() - 5 * 60_000) };
    const replies = await Promise.all(Array.from({ length: 6 }, () => handle16Call(ctx(), 'StartTransaction', { ...req })));
    const ids = new Set(replies.map((r) => r.transactionId));
    assert.equal(ids.size, 1, `every duplicate gets the original transactionId (${[...ids].join(', ')})`);

    const rows = await many<any>(`SELECT * FROM charging_session WHERE org_id = $1 AND started_at = $2`, [orgId, req.timestamp]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'active', 'the charger is charging on an OPEN session');
    assert.equal(rows[0].needs_review, false);
    assert.ok(!rows[0].flags.some((f: any) => f.code === 'ORPHANED_SESSION'));
    assert.equal(String(rows[0].ocpp_transaction_id), String(replies[0].transactionId));
  });

  test('a genuinely new transaction still closes the stale one for review', async () => {
    await freeConnector();
    const first = await handle16Call(ctx(), 'StartTransaction', { connectorId: 1, idTag: UID, meterStart: 200_000, timestamp: iso(Date.now() - 20 * 60_000) });
    const second = await handle16Call(ctx(), 'StartTransaction', { connectorId: 1, idTag: UID, meterStart: 210_000, timestamp: iso(Date.now() - 1 * 60_000) });
    assert.notEqual(first.transactionId, second.transactionId);
    const old = await one<any>(`SELECT * FROM charging_session WHERE charge_point_id = $1 AND ocpp_transaction_id = $2`, [cpId, String(first.transactionId)]);
    const cur = await one<any>(`SELECT * FROM charging_session WHERE charge_point_id = $1 AND ocpp_transaction_id = $2`, [cpId, String(second.transactionId)]);
    assert.equal(old.state, 'ended');
    assert.equal(old.review_reason, 'ORPHANED_SESSION');
    assert.equal(cur.state, 'active');
  });
});

dbDescribe('idle minutes are counted on the register in Wh', () => {
  /** 8 kWh over 40 minutes, then flat for 22 minutes: idle 22 whichever way it is reported. */
  async function idleFor(shape: (wh: number) => SampledValue[]) {
    await freeConnector();
    const t0 = Date.now() - 70 * 60_000;
    const tx = transaction(t0, 100_000);
    const s = await tx.start();
    for (const m of [10, 20, 30, 40, 50, 60]) {
      await tx.sample(m, shape(100_000 + Math.min(m, 40) * 200));
    }
    await tx.end(62, shape(108_000));
    const row = await sessionRow(s!.id);
    assert.equal(Number(row.energy_wh), 8_000);
    return Number(row.idle_minutes);
  }

  test('a register in Wh (baseline)', async () => {
    assert.equal(await idleFor(reg), 22);
  });

  test('a register in kWh', async () => {
    // Raw values move by 2 "units" per sample: below 50, so idle used to be the whole session.
    assert.equal(await idleFor((wh) => [{ measurand: 'Energy.Active.Import.Register', value: wh / 1000, unit: 'kWh' }]), 22);
  });

  test('per-phase registers only, in kWh', async () => {
    const phases = (wh: number): SampledValue[] => (['L1', 'L2', 'L3'] as const).map((phase) => ({
      measurand: 'Energy.Active.Import.Register', value: wh / 3000, unit: 'kWh', phase,
    }));
    assert.equal(await idleFor(phases), 22);
  });

  test('per-phase rows alongside the total do not read as deliveries', async () => {
    const both = (wh: number): SampledValue[] => [
      { measurand: 'Energy.Active.Import.Register', value: wh, unit: 'Wh' },
      ...(['L1', 'L2', 'L3'] as const).map((phase) => ({ measurand: 'Energy.Active.Import.Register', value: wh / 3, unit: 'Wh', phase })),
    ];
    assert.equal(await idleFor(both), 22);
  });
});
