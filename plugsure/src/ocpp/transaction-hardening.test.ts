import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import type { WebSocket } from 'ws';
import { config } from '../config.js';
import { one, many, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { handle16Call, stopRegister, reportedAfterTheFact, type AdapterContext } from './adapter16.js';
import { handle201Call } from './adapter201.js';
import { OcppRpcConnection, OcppReplyValidationError } from './rpc.js';
import { validateOutboundResult } from './validate.js';
import * as registry from './registry.js';
import { transactionPair, parsePagination, type PairReading } from '../services/signed-metering.js';
import { buildOcmf, formatOcmfTime } from '../services/ocmf.js';

/**
 * OCPP transaction hardening:
 *   A  suspended / decommissioned / unadopted stations authorise and start nothing
 *   B  refused transactions: a unique 1.6 transactionId; after-the-fact ones recorded, parked
 *   C  2.0.1: a token presented after the start is authorised and bound
 *   D  1.6 StopTransaction bills max(sampled register, meterStop) unless Transaction.End
 *   E  OCMF begin/end readings must be one transaction
 *   F  registry pong keyed by registration; CALLRESULT validated against the action's schema
 *   G  the prepaid claim window runs from payment (payment_intent.paid_at)
 *
 * The database-backed suites run only against the disposable test database:
 *   DATABASE_URL=postgresql://postgres:…@127.0.0.1:5433/plugsure_audit_fix npx tsx --test …
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[transaction-hardening.test] SKIPPING database-backed suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

// ------------------------------------------------------------------ pure

describe('D: the register a 1.6 StopTransaction bills', () => {
  test('a periodic sample behind meterStop: meterStop is billed and it is not a divergence', () => {
    assert.deepEqual(stopRegister(104_500, null, 105_000), { authoritative: 105_000, divergenceWh: 0 });
  });
  test('a sample above meterStop: the sample is billed and the disagreement is reported', () => {
    assert.deepEqual(stopRegister(105_400, null, 105_000), { authoritative: 105_400, divergenceWh: 400 });
  });
  test('a Transaction.End register is the authority; a meterStop that differs is a divergence', () => {
    assert.deepEqual(stopRegister(110_000, 110_000, 110_000), { authoritative: 110_000, divergenceWh: 0 });
    assert.deepEqual(stopRegister(110_000, 110_000, 109_000), { authoritative: 110_000, divergenceWh: 1_000 });
  });
  test('one source only: that one, nothing to compare', () => {
    assert.deepEqual(stopRegister(null, null, 5_000), { authoritative: 5_000, divergenceWh: 0 });
    assert.deepEqual(stopRegister(5_000, null, null), { authoritative: 5_000, divergenceWh: 0 });
    assert.deepEqual(stopRegister(null, null, null), { authoritative: null, divergenceWh: 0 });
  });
});

describe('B: a start reported after the fact', () => {
  test('more than two minutes old is after the fact; a live or future one is not', () => {
    const now = Date.parse('2026-10-01T10:00:00Z');
    assert.equal(reportedAfterTheFact('2026-10-01T09:59:00Z', now), false);
    assert.equal(reportedAfterTheFact('2026-10-01T09:57:00Z', now), true);
    assert.equal(reportedAfterTheFact('2026-10-01T10:05:00Z', now), false);
    assert.equal(reportedAfterTheFact('not a date', now), false);
  });
});

describe('E: OCMF begin and end readings of one transaction', () => {
  const r = (tx: string, row: number, pg: string | null, tm = '2026-09-28T17:30:04,000+0700 S', idx = 0): PairReading =>
    ({ tx, row, idx, pg: parsePagination(pg), tm, wh: 1000 * row, id: null, it: null });

  test('pagination parses T / F counters', () => {
    assert.deepEqual(parsePagination('T12'), { kind: 'T', n: 12 });
    assert.equal(parsePagination(undefined), null);
  });
  test('the end and the start immediately before it', () => {
    const p = transactionPair([r('B', 0, 'T1'), r('E', 1, 'T2'), r('B', 2, 'T3'), r('E', 3, 'T4')]);
    assert.ok('begin' in p);
    assert.equal(p.begin.row, 2);
    assert.equal(p.end.row, 3);
  });
  test('pagination orders data sets even when the clock says otherwise', () => {
    const p = transactionPair([r('E', 0, 'T8', '2026-09-28T10:00:00,000+0700 S'), r('B', 1, 'T7', '2026-09-28T11:00:00,000+0700 S')]);
    assert.ok('begin' in p && p.begin.row === 1 && p.end.row === 0);
  });
  test('a start only after the end, or another end in between, is not a pair', () => {
    assert.ok('missing' in transactionPair([r('E', 0, 'T2'), r('B', 1, 'T3')]));
    assert.ok('missing' in transactionPair([r('B', 0, 'T1'), r('E', 1, 'T2'), r('E', 2, 'T5')]));
    const none = transactionPair([r('E', 0, 'T2')]);
    assert.ok('missing' in none && /the start/.test(none.missing));
  });
  test('B and E in one data set pair by their order in it', () => {
    const p = transactionPair([r('B', 0, 'T4', undefined, 0), r('E', 0, 'T4', undefined, 1)]);
    assert.ok('begin' in p && p.begin.idx === 0 && p.end.idx === 1);
  });
});

describe('F: registry pong and CALLRESULT validation', () => {
  class FakeSocket extends EventEmitter {
    readyState = 1;
    sent: unknown[][] = [];
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
    terminate() { this.readyState = 3; }
    ping() {}
  }

  test('a late pong from a superseded socket does not mark the new registration alive', () => {
    const ws1 = new FakeSocket(); const ws2 = new FakeSocket();
    const base = { ocppIdentity: 'PONG-TEST', chargePointId: 'x', version: 'ocpp1.6' as const, rpc: {} as any, connectedAt: new Date() };
    const t1 = registry.register({ ...base, ws: ws1 as unknown as WebSocket });
    const t2 = registry.register({ ...base, ws: ws2 as unknown as WebSocket });
    registry.markPingSent('PONG-TEST', t2);
    assert.equal(registry.markPong('PONG-TEST', t1), false, 'the old socket\'s pong is ignored');
    assert.equal(registry.get('PONG-TEST')?.awaitingPong, true);
    assert.equal(registry.markPong('PONG-TEST', t2), true);
    assert.equal(registry.get('PONG-TEST')?.awaitingPong, false);
    registry.unregister('PONG-TEST', t2);
  });

  test('schemas: a known answer is checked, an unknown action is not', () => {
    assert.equal(validateOutboundResult('RemoteStopTransaction', { status: 'Accepted' }), null);
    assert.equal(validateOutboundResult('RemoteStopTransaction', { status: 'Acepted' })?.code, 'PropertyConstraintViolation');
    assert.equal(validateOutboundResult('GetLocalListVersion', {})?.code, 'ProtocolError');
    assert.equal(validateOutboundResult('GetConfiguration', { status: 'Accepted' }), null, 'vendor extras are tolerated');
    assert.equal(validateOutboundResult('UnlockConnector', { status: 'Unlocked' }, 'ocpp2.0.1'), null);
    assert.ok(validateOutboundResult('GetVariables', { status: 'Accepted' }, 'ocpp2.0.1'));
    assert.equal(validateOutboundResult('SomeVendorCommand', { anything: 1 }), null);
    // 2.1 checks shapes, not status vocabularies it may extend.
    assert.equal(validateOutboundResult('Reset', { status: 'SomethingNew' }, 'ocpp2.1'), null);
  });

  test('an invalid CALLRESULT rejects the call with a clear error, records a deviation, and the queue moves on', async () => {
    const ws = new FakeSocket();
    const deviations: string[] = [];
    const conn = new OcppRpcConnection('RPC-TEST', ws as unknown as WebSocket, async () => ({}), {
      callTimeoutMs: 1_000,
      deviationSink: (action, d) => deviations.push(`${action}${d[0]!.message}`),
    });
    const first = conn.call('RemoteStopTransaction', { transactionId: 1 });
    const second = conn.call('RemoteStopTransaction', { transactionId: 2 });
    await new Promise((r) => setTimeout(r, 5));
    ws.emit('message', Buffer.from(JSON.stringify([3, ws.sent[0]![1], { status: 'Acepted' }])));
    await assert.rejects(first, (e: unknown) => e instanceof OcppReplyValidationError && /RemoteStopTransaction/.test(e.message) && /status/.test(e.message));
    assert.match(deviations[0]!, /^RemoteStopTransaction\.conf\/status/);
    await new Promise((r) => setTimeout(r, 5));
    ws.emit('message', Buffer.from(JSON.stringify([3, ws.sent[1]![1], { status: 'Accepted' }])));
    assert.deepEqual(await second, { status: 'Accepted' });
    conn.destroy(new Error('done'));
  });
});

// ------------------------------------------------------------------ database

const SLUG = 'tx-hardening-test';
const IDENT = 'TXHARD-TEST-01';
const IDENT201 = 'TXHARD-TEST-02';
const CARD = 'TXH-CARD';
const BLOCKED = 'TXH-BLOCKED';
const PP = 'PS-TXHPREPAID';
let orgId = '';
let cpId = '';
let cp201Id = '';
const conn: Record<number, string> = {};

async function cleanup(): Promise<void> {
  const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (!org) return;
  const cs = `SELECT id FROM charging_session WHERE org_id = $1`;
  await query(`DELETE FROM payment_intent WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM signed_meter_value WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM cdr WHERE session_id IN (${cs})`, [org.id]);
  await query(`DELETE FROM meter_value WHERE session_id IN (${cs})`, [org.id]);
  await query(`DELETE FROM charging_session WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM token WHERE org_id = $1`, [org.id]);
  for (const ident of [IDENT, IDENT201]) {
    await query(`DELETE FROM connector WHERE evse_uuid IN (SELECT e.id FROM evse e JOIN charge_point cp ON cp.id = e.charge_point_id WHERE cp.ocpp_identity = $1)`, [ident]);
    await query(`DELETE FROM evse WHERE charge_point_id IN (SELECT id FROM charge_point WHERE ocpp_identity = $1)`, [ident]);
    await query(`DELETE FROM charge_point WHERE ocpp_identity = $1`, [ident]);
  }
  await query(`DELETE FROM site WHERE org_id = $1`, [org.id]);
}

async function addCp(siteId: string, ident: string, version: string, evses: number[]): Promise<string> {
  const id = (await one<{ id: string }>(
    `INSERT INTO charge_point (site_id, ocpp_identity, ocpp_version, status) VALUES ($1, $2, $3, 'online') RETURNING id`, [siteId, ident, version]))!.id;
  for (const n of evses) {
    const e = await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1, $2, 60000) RETURNING id`, [id, n]);
    const c = await one<{ id: string }>(
      `INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w, tera_status, tera_cert_status)
       VALUES ($1, 1, 'CCS2', 'DC', 60000, 'verified', 'verified') RETURNING id`, [e!.id]);
    if (ident === IDENT) conn[n] = c!.id;
  }
  return id;
}

if (DB_OK) {
  before(async () => {
    await cleanup();
    orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug) VALUES ('Tx Hardening Test', $1)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    const siteId = (await one<{ id: string }>(
      `INSERT INTO site (org_id, name, pbjt_rate_bps) VALUES ($1, 'Tx Hardening Hub', 1000) RETURNING id`, [orgId]))!.id;
    cpId = await addCp(siteId, IDENT, 'ocpp1.6', [1, 2, 3]);
    cp201Id = await addCp(siteId, IDENT201, 'ocpp2.0.1', [1, 2]);
    await query(`INSERT INTO token (org_id, kind, uid, status) VALUES ($1, 'rfid', $2, 'Accepted'), ($1, 'rfid', $3, 'Blocked')`, [orgId, CARD, BLOCKED]);
  });
  after(async () => {
    await cleanup();
    await pool.end();
  });
}

const ctx = (): AdapterContext => ({ ocppIdentity: IDENT, chargePointId: cpId, orgId });
const ctx201 = (): AdapterContext => ({ ocppIdentity: IDENT201, chargePointId: cp201Id, orgId, version: 'ocpp2.0.1' });
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const session = (cp: string, tx: string | number) =>
  one<any>(`SELECT * FROM charging_session WHERE charge_point_id = $1 AND ocpp_transaction_id = $2`, [cp, String(tx)]);
const setStatus = (id: string, status: string) => query(`UPDATE charge_point SET status = $2 WHERE id = $1`, [id, status]);
const freeAll = () => query(`UPDATE charging_session SET state = 'ended', ended_at = now() WHERE org_id = $1 AND state = 'active'`, [orgId]);
const reg = (wh: number, context = 'Sample.Periodic') => ({ value: String(wh), measurand: 'Energy.Active.Import.Register', unit: 'Wh', context });

dbDescribe('A: a station out of service authorises and starts nothing, but still delivers what it owes', () => {
  test('suspended: BootNotification Pending (1.6 and 2.0.1); decommissioned: Rejected', async () => {
    await setStatus(cpId, 'suspended');
    await setStatus(cp201Id, 'suspended');
    try {
      assert.equal((await handle16Call(ctx(), 'BootNotification', { chargePointVendor: 'V', chargePointModel: 'M' })).status, 'Pending');
      assert.equal((await handle201Call(ctx201(), 'BootNotification', { reason: 'PowerUp', chargingStation: { vendorName: 'V', model: 'M' } })).status, 'Pending');
      await setStatus(cpId, 'decommissioned');
      assert.equal((await handle16Call(ctx(), 'BootNotification', { chargePointVendor: 'V', chargePointModel: 'M' })).status, 'Rejected');
    } finally {
      await setStatus(cpId, 'online');
      await setStatus(cp201Id, 'online');
    }
  });

  test('suspended: Authorize and a live start are refused; a running transaction still meters and stops', async () => {
    await freeAll();
    const running = await handle16Call(ctx(), 'StartTransaction', { connectorId: 1, idTag: CARD, meterStart: 10_000, timestamp: iso(-60_000) });
    assert.equal(running.idTagInfo.status, 'Accepted');
    await setStatus(cpId, 'suspended');
    await setStatus(cp201Id, 'suspended');
    try {
      assert.equal((await handle16Call(ctx(), 'Authorize', { idTag: CARD })).idTagInfo.status, 'Invalid');
      assert.equal((await handle201Call(ctx201(), 'Authorize', { idToken: { idToken: CARD, type: 'ISO14443' } })).idTokenInfo.status, 'NotAtThisLocation');
      const st = await handle16Call(ctx(), 'StartTransaction', { connectorId: 2, idTag: CARD, meterStart: 1, timestamp: iso() });
      assert.equal(st.idTagInfo.status, 'Invalid');
      assert.ok(st.transactionId > 0);
      assert.equal(await session(cpId, st.transactionId), null, 'no session opened');
      const te = await handle201Call(ctx201(), 'TransactionEvent', {
        eventType: 'Started', timestamp: iso(), triggerReason: 'Authorized', seqNo: 0, transactionInfo: { transactionId: 'txh-susp' },
        evse: { id: 1, connectorId: 1 }, idToken: { idToken: CARD, type: 'ISO14443' },
      });
      assert.equal(te.idTokenInfo.status, 'NotAtThisLocation');
      assert.equal(await session(cp201Id, 'txh-susp'), null);

      assert.deepEqual(await handle16Call(ctx(), 'MeterValues', { connectorId: 1, transactionId: running.transactionId, meterValue: [{ timestamp: iso(-30_000), sampledValue: [reg(12_000)] }] }), {});
      const stop = await handle16Call(ctx(), 'StopTransaction', { transactionId: running.transactionId, meterStop: 13_000, timestamp: iso(), reason: 'Local' });
      assert.equal(stop.idTagInfo.status, 'Accepted');
      const s = await session(cpId, running.transactionId);
      assert.equal(s.state === 'ended' || s.state === 'rated', true);
      assert.equal(Number(s.energy_wh), 3_000);
    } finally {
      await setStatus(cpId, 'online');
      await setStatus(cp201Id, 'online');
    }
  });
});

dbDescribe('B: refused transactions', () => {
  test('a live start with a blocked card: refused, no session, and every refusal its own transactionId', async () => {
    await freeAll();
    const a = await handle16Call(ctx(), 'StartTransaction', { connectorId: 2, idTag: BLOCKED, meterStart: 1_000, timestamp: iso(-5_000) });
    const b = await handle16Call(ctx(), 'StartTransaction', { connectorId: 3, idTag: BLOCKED, meterStart: 2_000, timestamp: iso(-4_000) });
    assert.equal(a.idTagInfo.status, 'Blocked');
    assert.ok(a.transactionId > 0 && b.transactionId > 0 && a.transactionId !== b.transactionId);
    assert.equal(await session(cpId, a.transactionId), null);
    // The charger stops: its StopTransaction is answered normally.
    assert.equal((await handle16Call(ctx(), 'StopTransaction', { transactionId: a.transactionId, meterStop: 1_050, timestamp: iso(), reason: 'DeAuthorized' })).idTagInfo.status, 'Accepted');
  });

  test('an offline start with a since-blocked card is recorded, metered and stopped — parked, unbilled, no payer', async () => {
    await freeAll();
    const st = await handle16Call(ctx(), 'StartTransaction', { connectorId: 2, idTag: BLOCKED, meterStart: 50_000, timestamp: iso(-3_600_000) });
    assert.equal(st.idTagInfo.status, 'Blocked', 'the charger is still told the truth');
    assert.ok(st.transactionId > 0);
    let s = await session(cpId, st.transactionId);
    assert.ok(s, 'a session exists for it');
    assert.equal(s.needs_review, true);
    assert.equal(s.review_reason, 'UNAUTHORISED_TOKEN');
    assert.equal(s.token_id, null, 'billed to nobody');
    await handle16Call(ctx(), 'MeterValues', { connectorId: 2, transactionId: st.transactionId, meterValue: [{ timestamp: iso(-3_000_000), sampledValue: [reg(55_000)] }] });
    await handle16Call(ctx(), 'StopTransaction', { transactionId: st.transactionId, meterStop: 58_000, timestamp: iso(-2_400_000), reason: 'Local' });
    s = await session(cpId, st.transactionId);
    assert.equal(s.state, 'ended');
    assert.equal(Number(s.energy_wh), 8_000, 'nothing is lost');
    assert.equal(await one(`SELECT id FROM cdr WHERE session_id = $1`, [s.id]), null, 'and nothing is billed');
    // A retry of the same offline start finds the same transaction.
    const again = await handle16Call(ctx(), 'StartTransaction', { connectorId: 2, idTag: BLOCKED, meterStart: 50_000, timestamp: s.started_at.toISOString() });
    assert.equal(again.transactionId, st.transactionId);
  });

  test('2.0.1: an offline (offline: true) Started with a blocked token is recorded and parked', async () => {
    await freeAll();
    const r = await handle201Call(ctx201(), 'TransactionEvent', {
      eventType: 'Started', timestamp: iso(-20_000), triggerReason: 'Authorized', seqNo: 0, offline: true,
      transactionInfo: { transactionId: 'txh-offline' }, evse: { id: 1, connectorId: 1 }, idToken: { idToken: BLOCKED, type: 'ISO14443' },
      meterValue: [{ timestamp: iso(-20_000), sampledValue: [{ value: 1_000, measurand: 'Energy.Active.Import.Register' }] }],
    });
    assert.equal(r.idTokenInfo.status, 'Blocked');
    const s = await session(cp201Id, 'txh-offline');
    assert.ok(s);
    assert.equal(s.review_reason, 'UNAUTHORISED_TOKEN');
    // Live (no offline flag, timestamp now): refused and not recorded, as before.
    const live = await handle201Call(ctx201(), 'TransactionEvent', {
      eventType: 'Started', timestamp: iso(), triggerReason: 'Authorized', seqNo: 0,
      transactionInfo: { transactionId: 'txh-live' }, evse: { id: 2, connectorId: 1 }, idToken: { idToken: BLOCKED, type: 'ISO14443' },
    });
    assert.equal(live.idTokenInfo.status, 'Blocked');
    assert.equal(await session(cp201Id, 'txh-live'), null);
  });

  test('a prepaid token on the wrong connector, reported after the fact: recorded unauthorised, the payment untouched', async () => {
    await freeAll();
    await query(`INSERT INTO token (org_id, kind, uid, status) VALUES ($1, 'prepaid', $2, 'Accepted') ON CONFLICT DO NOTHING`, [orgId, PP]);
    const pi = (await one<{ id: string }>(
      `INSERT INTO payment_intent (org_id, provider, method, mode, state, amount_authorised_idr, amount_captured_idr, allowance_wh,
                                   connector_uuid, claim_id_tag, claim_token_minted, captured_at)
       VALUES ($1, 'test', 'qris', 'prepurchase', 'captured', 50000, 50000, 20000, $2, $3, true, now()) RETURNING id`,
      [orgId, conn[1], PP]))!.id;
    const st = await handle16Call(ctx(), 'StartTransaction', { connectorId: 3, idTag: PP, meterStart: 7_000, timestamp: iso(-600_000) });
    assert.notEqual(st.idTagInfo.status, 'Accepted');
    const s = await session(cpId, st.transactionId);
    assert.ok(s);
    assert.equal(s.payment_mode, 'postpaid');
    assert.equal(s.payment_intent_id, null);
    assert.equal(s.needs_review, true);
    assert.equal((await one<any>(`SELECT session_id FROM payment_intent WHERE id = $1`, [pi])).session_id, null);
    await query(`DELETE FROM payment_intent WHERE id = $1`, [pi]);
  });
});

dbDescribe('C: 2.0.1 token presented after the start', () => {
  const started = (tx: string, evse: number) => handle201Call(ctx201(), 'TransactionEvent', {
    eventType: 'Started', timestamp: iso(-5_000), triggerReason: 'CablePluggedIn', seqNo: 0,
    transactionInfo: { transactionId: tx, chargingState: 'EVConnected' }, evse: { id: evse, connectorId: 1 },
    meterValue: [{ timestamp: iso(-5_000), sampledValue: [{ value: 100_000, measurand: 'Energy.Active.Import.Register' }] }],
  });
  const updated = (tx: string, evse: number, idToken: string, seqNo = 1) => handle201Call(ctx201(), 'TransactionEvent', {
    eventType: 'Updated', timestamp: iso(-2_000), triggerReason: 'Authorized', seqNo,
    transactionInfo: { transactionId: tx, chargingState: 'Charging' }, evse: { id: evse, connectorId: 1 },
    idToken: { idToken, type: 'ISO14443' },
  });

  test('an accepted token on Updated is authorised, bound, and answered', async () => {
    await freeAll();
    assert.deepEqual(await started('txh-late-ok', 1), {});
    const r = await updated('txh-late-ok', 1, CARD);
    assert.equal(r.idTokenInfo?.status, 'Accepted');
    const s = await session(cp201Id, 'txh-late-ok');
    const tok = await one<{ id: string }>(`SELECT id FROM token WHERE org_id = $1 AND uid = $2`, [orgId, CARD]);
    assert.equal(s.token_id, tok!.id);
    assert.equal(s.needs_review, false);
    // The token repeated on a later event is not authorised again.
    assert.deepEqual(await updated('txh-late-ok', 1, CARD, 2), {});
  });

  test('a refused token on Updated: answered with its status, nothing bound, the session parked', async () => {
    await freeAll();
    await started('txh-late-bad', 2);
    const r = await updated('txh-late-bad', 2, BLOCKED);
    assert.equal(r.idTokenInfo?.status, 'Blocked');
    const s = await session(cp201Id, 'txh-late-bad');
    assert.equal(s.token_id, null);
    assert.equal(s.needs_review, true);
    assert.equal(s.review_reason, 'UNAUTHORISED_TOKEN');
    assert.deepEqual(await updated('txh-late-bad', 2, BLOCKED, 2), {}, 'not re-authorised on every frame');
    const flags = (s.flags as any[]).filter((f) => f.code === 'UNAUTHORISED_TOKEN');
    assert.equal(flags.length, 1);
  });

  test('a prepaid claim token arriving late claims its payment on its connector', async () => {
    await freeAll();
    const tag = `${PP}-201`;
    await query(`INSERT INTO token (org_id, kind, uid, status) VALUES ($1, 'prepaid', $2, 'Accepted') ON CONFLICT DO NOTHING`, [orgId, tag]);
    const c201 = (await one<{ id: string }>(
      `SELECT c.id FROM connector c JOIN evse e ON e.id = c.evse_uuid WHERE e.charge_point_id = $1 AND e.evse_id = 1`, [cp201Id]))!.id;
    const pi = (await one<{ id: string }>(
      `INSERT INTO payment_intent (org_id, provider, method, mode, state, amount_authorised_idr, amount_captured_idr, allowance_wh,
                                   connector_uuid, claim_id_tag, claim_token_minted, captured_at)
       VALUES ($1, 'test', 'qris', 'prepurchase', 'captured', 40000, 40000, 15000, $2, $3, true, now()) RETURNING id`,
      [orgId, c201, tag]))!.id;
    await started('txh-late-pp', 1);
    const r = await updated('txh-late-pp', 1, tag);
    assert.equal(r.idTokenInfo?.status, 'Accepted');
    const s = await session(cp201Id, 'txh-late-pp');
    assert.equal(s.payment_mode, 'prepurchase');
    assert.equal(s.payment_intent_id, pi);
    assert.equal(Number(s.prepaid_energy_wh), 15_000);
    assert.equal((await one<any>(`SELECT session_id FROM payment_intent WHERE id = $1`, [pi])).session_id, s.id);
  });
});

dbDescribe('D: 1.6 StopTransaction with a lagging sample bills meterStop', () => {
  test('the last sample is 400 Wh behind meterStop: meterStop billed, not parked', async () => {
    await freeAll();
    const st = await handle16Call(ctx(), 'StartTransaction', { connectorId: 1, idTag: CARD, meterStart: 200_000, timestamp: iso(-1_800_000) });
    await handle16Call(ctx(), 'StopTransaction', {
      transactionId: st.transactionId, meterStop: 220_000, timestamp: iso(-60_000), reason: 'EVDisconnected',
      transactionData: [{ timestamp: iso(-120_000), sampledValue: [reg(219_600)] }],
    });
    const s = await session(cpId, st.transactionId);
    assert.equal(Number(s.energy_wh), 20_000);
    assert.ok(!(s.flags as any[]).some((f) => f.code === 'METER_SOURCES_DIVERGE'));
    assert.equal(s.needs_review, false);
  });
});

dbDescribe('E: signed readings of another transaction or token', () => {
  test('a B/E pair whose OCMF ID is not the session token is a mismatch', async () => {
    await freeAll();
    const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const sign = (tx: 'B' | 'E', wh: number, pg: string, id: string) => buildOcmf({
      FV: '1.0', GI: 'T', GS: 'CP', GV: '1', PG: pg, MV: 'M', MM: 'M', MS: 'MTR-TXH', MF: '1', IS: true, IT: 'ISO14443', ID: id,
      RD: [{ TM: formatOcmfTime(new Date()), TX: tx, RV: wh / 1000, RI: '1-b:1.8.0', RU: 'kWh', EF: '', ST: 'G' }],
    }, k.privateKey);
    const st = await handle16Call(ctx(), 'StartTransaction', { connectorId: 1, idTag: CARD, meterStart: 300_000, timestamp: iso(-1_200_000) });
    await handle16Call(ctx(), 'StopTransaction', {
      transactionId: st.transactionId, meterStop: 305_000, timestamp: iso(-60_000), reason: 'Local',
      transactionData: [{ timestamp: iso(-60_000), sampledValue: [
        { value: sign('B', 300_000, 'T1', 'SOMEONE-ELSE'), format: 'SignedData', context: 'Transaction.Begin' },
        { value: sign('E', 305_000, 'T2', 'SOMEONE-ELSE'), format: 'SignedData', context: 'Transaction.End' },
      ] }],
    });
    const s = await session(cpId, st.transactionId);
    assert.equal(s.signed_status, 'mismatch');
    assert.match(s.signed_detail, /SOMEONE-ELSE/);
  });
});

dbDescribe('G: the prepaid claim window runs from payment', () => {
  test('paid 5 minutes ago after a 40-minute checkout: still claimable; paid_at is stamped by the trigger', async () => {
    await freeAll();
    const tag = `${PP}-LATE`;
    await query(`INSERT INTO token (org_id, kind, uid, status, valid_to) VALUES ($1, 'prepaid', $2, 'Accepted', now() - interval '10 minutes') ON CONFLICT DO NOTHING`, [orgId, tag]);
    const pi = (await one<{ id: string; paid_at: Date | null }>(
      `INSERT INTO payment_intent (org_id, provider, method, mode, state, amount_authorised_idr, allowance_wh, connector_uuid, claim_id_tag, claim_token_minted, created_at)
       VALUES ($1, 'test', 'qris', 'prepurchase', 'pending', 30000, 10000, $2, $3, true, now() - interval '40 minutes') RETURNING id, paid_at`,
      [orgId, conn[3], tag]))!;
    assert.equal(pi.paid_at, null);
    await query(`UPDATE payment_intent SET state = 'captured', amount_captured_idr = 30000, captured_at = now() - interval '5 minutes' WHERE id = $1`, [pi.id]);
    const paid = await one<{ paid_at: Date }>(`SELECT paid_at FROM payment_intent WHERE id = $1`, [pi.id]);
    assert.ok(Math.abs(new Date(paid!.paid_at).getTime() - (Date.now() - 300_000)) < 60_000, 'paid_at = the capture time');

    const auth = await handle16Call(ctx(), 'Authorize', { idTag: tag });
    assert.equal(auth.idTagInfo.status, 'Accepted', 'a checkout-time valid_to no longer expires a payment made later');
    const st = await handle16Call(ctx(), 'StartTransaction', { connectorId: 3, idTag: tag, meterStart: 1_000, timestamp: iso(-10_000) });
    assert.equal(st.idTagInfo.status, 'Accepted');
    const s = await session(cpId, st.transactionId);
    assert.equal(s.payment_intent_id, pi.id);
    // A later state change does not move paid_at.
    await query(`UPDATE payment_intent SET state = 'captured', captured_at = now() WHERE id = $1`, [pi.id]);
    const still = await one<{ paid_at: Date }>(`SELECT paid_at FROM payment_intent WHERE id = $1`, [pi.id]);
    assert.equal(new Date(still!.paid_at).getTime(), new Date(paid!.paid_at).getTime());
  });

  test('paid 40 minutes ago: no longer claimable', async () => {
    await freeAll();
    const tag = `${PP}-OLD`;
    await query(`INSERT INTO token (org_id, kind, uid, status) VALUES ($1, 'prepaid', $2, 'Accepted') ON CONFLICT DO NOTHING`, [orgId, tag]);
    await query(
      `INSERT INTO payment_intent (org_id, provider, method, mode, state, amount_authorised_idr, amount_captured_idr, allowance_wh, connector_uuid, claim_id_tag, claim_token_minted, created_at, captured_at)
       VALUES ($1, 'test', 'qris', 'prepurchase', 'captured', 30000, 30000, 10000, $2, $3, true, now() - interval '45 minutes', now() - interval '40 minutes')`,
      [orgId, conn[3], tag]);
    assert.equal((await handle16Call(ctx(), 'Authorize', { idTag: tag })).idTagInfo.status, 'Expired');
    const rows = await many(`SELECT 1 FROM charging_session WHERE org_id = $1 AND state = 'active'`, [orgId]);
    assert.equal(rows.length, 0);
  });
});
