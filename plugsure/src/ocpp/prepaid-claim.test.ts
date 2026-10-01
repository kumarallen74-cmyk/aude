import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { one, many, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { handle16Call, type AdapterContext } from './adapter16.js';
import { handle201Call } from './adapter201.js';
import { handleTransactionEvent, sessionIdemKey, SessionStartRefused } from '../services/sessions.js';

/**
 * A prepaid claim token starts only the session it paid for (database-backed).
 *
 * The token used to be accepted at any connector of the operator while its
 * payment was claimable, or while its own session ran. On the wrong connector
 * the claim found nothing and the session started as postpaid with no allowance
 * and no payer — free, unlimited charging — and the unused-payment sweep then
 * refunded the payment in full. It also worked alongside the paid session.
 *
 * Runs only against the disposable test database:
 *   DATABASE_URL=postgresql://postgres:…@127.0.0.1:5433/plugsure_audit_fix npm test
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[prepaid-claim.test] SKIPPING database-backed suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'prepaid-claim-test';
const IDENT = 'PPCLAIM-TEST-01';
const IDENT2 = 'PPCLAIM-TEST-02';
const TAG = 'PS-PPCLAIMTEST';
let orgId = '';
let cpId = '';
let cp2Id = '';
const conn: Record<number, string> = {};
let intentId = '';

async function cleanup(): Promise<void> {
  const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (!org) return;
  const cs = `SELECT id FROM charging_session WHERE org_id = $1`;
  await query(`DELETE FROM payment_intent WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM cdr WHERE session_id IN (${cs})`, [org.id]);
  await query(`DELETE FROM meter_value WHERE session_id IN (${cs})`, [org.id]);
  await query(`DELETE FROM charging_session WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM token WHERE org_id = $1`, [org.id]);
  for (const ident of [IDENT, IDENT2]) {
    await query(`DELETE FROM connector WHERE evse_uuid IN (SELECT e.id FROM evse e JOIN charge_point cp ON cp.id = e.charge_point_id WHERE cp.ocpp_identity = $1)`, [ident]);
    await query(`DELETE FROM evse WHERE charge_point_id IN (SELECT id FROM charge_point WHERE ocpp_identity = $1)`, [ident]);
    await query(`DELETE FROM charge_point WHERE ocpp_identity = $1`, [ident]);
  }
  await query(`DELETE FROM site WHERE org_id = $1`, [org.id]);
}

async function addCp(siteId: string, ident: string, evses: number[]): Promise<string> {
  const id = (await one<{ id: string }>(
    `INSERT INTO charge_point (site_id, ocpp_identity, ocpp_version, status) VALUES ($1, $2, 'ocpp1.6', 'online') RETURNING id`, [siteId, ident]))!.id;
  for (const n of evses) {
    const e = await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1, $2, 22000) RETURNING id`, [id, n]);
    const c = await one<{ id: string }>(
      `INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w, tera_status, tera_cert_status)
       VALUES ($1, 1, 'Type2', 'AC', 22000, 'verified', 'verified') RETURNING id`, [e!.id]);
    if (ident === IDENT) conn[n] = c!.id;
  }
  return id;
}

if (DB_OK) {
  before(async () => {
    await cleanup();
    orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug) VALUES ('Prepaid Claim Test', $1)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    const siteId = (await one<{ id: string }>(
      `INSERT INTO site (org_id, name, pbjt_rate_bps) VALUES ($1, 'Prepaid Claim Hub', 1000) RETURNING id`, [orgId]))!.id;
    cpId = await addCp(siteId, IDENT, [1, 2]);
    cp2Id = await addCp(siteId, IDENT2, [1]);
    await query(`INSERT INTO token (org_id, kind, uid, status, valid_to) VALUES ($1, 'prepaid', $2, 'Accepted', now() + interval '30 minutes')`, [orgId, TAG]);
    // Paid by QRIS for connector 1 only.
    intentId = (await one<{ id: string }>(
      `INSERT INTO payment_intent (org_id, provider, method, mode, state, amount_authorised_idr, amount_captured_idr, allowance_wh,
                                   connector_uuid, claim_id_tag, claim_token_minted, captured_at)
       VALUES ($1, 'test', 'qris', 'prepurchase', 'captured', 50000, 50000, 20000, $2, $3, true, now()) RETURNING id`,
      [orgId, conn[1], TAG]))!.id;
  });
  after(async () => {
    await cleanup();
    await pool.end();
  });
}

const ctx = (): AdapterContext => ({ ocppIdentity: IDENT, chargePointId: cpId, orgId });
const ctx2 = (): AdapterContext => ({ ocppIdentity: IDENT2, chargePointId: cp2Id, orgId });
const iso = (t: number) => new Date(t).toISOString();
const sessionsOn = (connectorUuid: string) =>
  many<any>(`SELECT * FROM charging_session WHERE connector_uuid = $1`, [connectorUuid]);

dbDescribe('a prepaid claim token starts only the session it paid for', () => {
  test('OCPP 1.6: StartTransaction on another connector is refused, and opens nothing', async () => {
    const r = await handle16Call(ctx(), 'StartTransaction', { connectorId: 2, idTag: TAG, meterStart: 1_000, timestamp: iso(Date.now() - 60_000) });
    assert.equal(r.transactionId, 0, 'the refused-start convention: transactionId 0');
    assert.equal(r.idTagInfo.status, 'Invalid');
    assert.equal((await sessionsOn(conn[2]!)).length, 0, 'no postpaid session for a prepaid token');
    const pi = await one<any>(`SELECT session_id FROM payment_intent WHERE id = $1`, [intentId]);
    assert.equal(pi.session_id, null, 'the payment is still there for its own connector');
  });

  test('OCPP 2.0.1: TransactionEvent Started on another EVSE is refused, and opens nothing', async () => {
    const r = await handle201Call(ctx(), 'TransactionEvent', {
      eventType: 'Started', timestamp: iso(Date.now() - 50_000), triggerReason: 'Authorized', seqNo: 0,
      transactionInfo: { transactionId: 'pp201-wrong-evse' }, evse: { id: 2, connectorId: 1 },
      idToken: { idToken: TAG, type: 'Local' },
      meterValue: [{ timestamp: iso(Date.now() - 50_000), sampledValue: [{ value: 1_000, measurand: 'Energy.Active.Import.Register' }] }],
    });
    assert.notEqual(r.idTokenInfo.status, 'Accepted');
    assert.equal((await sessionsOn(conn[2]!)).length, 0);
  });

  test('session start refuses it itself, whatever the authoriser said', async () => {
    const t = iso(Date.now() - 40_000);
    await assert.rejects(
      handleTransactionEvent({
        eventType: 'Started', triggerReason: 'Authorized', timestamp: t, seqNo: 0, transactionId: 'pp-direct',
        evse: { chargePointId: cpId, ocppIdentity: IDENT, evseId: 2, connectorId: 1 },
        idToken: { type: 'ISO14443', idToken: TAG }, meterValue: [], idemKey: sessionIdemKey(IDENT, 2, TAG, 0, t),
      }, cpId),
      (e: unknown) => e instanceof SessionStartRefused && e.status === 'Invalid',
    );
    assert.equal((await sessionsOn(conn[2]!)).length, 0);
  });

  test('Authorize (no connector) accepts it while the payment is claimable', async () => {
    const r = await handle16Call(ctx(), 'Authorize', { idTag: TAG });
    assert.equal(r.idTagInfo.status, 'Accepted');
  });

  let paidTx = 0;
  test('on its own connector it starts the prepaid session; a retry gets the same transaction', async () => {
    const req = { connectorId: 1, idTag: TAG, meterStart: 5_000, timestamp: iso(Date.now() - 30_000) };
    const r = await handle16Call(ctx(), 'StartTransaction', req);
    assert.equal(r.idTagInfo.status, 'Accepted');
    assert.ok(r.transactionId > 0);
    paidTx = r.transactionId;
    const [s] = await sessionsOn(conn[1]!);
    assert.equal(s.payment_mode, 'prepurchase');
    assert.equal(Number(s.prepaid_energy_wh), 20_000);
    assert.equal((await one<any>(`SELECT session_id FROM payment_intent WHERE id = $1`, [intentId])).session_id, s.id);

    const again = await handle16Call(ctx(), 'StartTransaction', req);
    assert.equal(again.transactionId, paidTx, 'a retried StartTransaction still works');
    assert.equal(again.idTagInfo.status, 'Accepted');
  });

  test('while that session runs, a second session with the token is ConcurrentTx (1.6 and 2.0.1)', async () => {
    const r = await handle16Call(ctx(), 'StartTransaction', { connectorId: 2, idTag: TAG, meterStart: 1_000, timestamp: iso(Date.now() - 20_000) });
    assert.equal(r.transactionId, 0);
    assert.equal(r.idTagInfo.status, 'ConcurrentTx');
    const r201 = await handle201Call(ctx(), 'TransactionEvent', {
      eventType: 'Started', timestamp: iso(Date.now() - 15_000), triggerReason: 'Authorized', seqNo: 0,
      transactionInfo: { transactionId: 'pp201-concurrent' }, evse: { id: 2, connectorId: 1 },
      idToken: { idToken: TAG, type: 'Local' },
    });
    assert.equal(r201.idTokenInfo.status, 'ConcurrentTx');
    assert.equal((await sessionsOn(conn[2]!)).length, 0);

    // A new transaction on the paid connector itself (a missed stop) cannot reuse the payment either.
    const same = await handle16Call(ctx(), 'StartTransaction', { connectorId: 1, idTag: TAG, meterStart: 9_000, timestamp: iso(Date.now() - 10_000) });
    assert.equal(same.transactionId, 0);
    assert.equal(same.idTagInfo.status, 'ConcurrentTx');
    const rows = await sessionsOn(conn[1]!);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'active', 'the paid session was not closed as superseded by a refused start');
  });

  test('Authorize: accepted on its own charger (reconnect / stop), ConcurrentTx on another', async () => {
    assert.equal((await handle16Call(ctx(), 'Authorize', { idTag: TAG })).idTagInfo.status, 'Accepted');
    assert.equal((await handle16Call(ctx2(), 'Authorize', { idTag: TAG })).idTagInfo.status, 'ConcurrentTx');
    const r = await handle16Call(ctx2(), 'StartTransaction', { connectorId: 1, idTag: TAG, meterStart: 1, timestamp: iso(Date.now() - 5_000) });
    assert.equal(r.transactionId, 0);
    assert.equal(r.idTagInfo.status, 'ConcurrentTx');
  });
});
