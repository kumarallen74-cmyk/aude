import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { one, pool, query } from '../../db/pool.js';
import { databaseTestLock } from '../../db/test-lock.js';
import { seal } from '../secrets.js';
import { bus } from '../events.js';
import { recoverUnsettledPayments } from '../sessions.js';
import { handleNotification, notificationAccountMismatch } from './registry.js';

/**
 * Money that must not be stranded (database-backed):
 *  1. a session rated (CDR committed) whose payment was never settled — a crash between the CDR and the capture /
 *     refund — is settled by the recovery sweep: the card hold captured once, the unused pre-purchase queued for refund;
 *  2. a notification for LESS than the payment (a hold authorised short, a QRIS paid short) raises a critical alert and
 *     releases the hold / queues the refund, instead of only logging and answering 200;
 *  3. a notification on one organisation's account cannot settle another organisation's payment.
 *
 * Runs only against the disposable test database:
 *   DATABASE_URL=postgresql://postgres:…@127.0.0.1:5433/plugsure_audit_fix npx tsx --test src/services/payments/settlement-recovery.test.ts
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[settlement-recovery.test] SKIPPING database-backed suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = { a: 'settle-recovery-a', b: 'settle-recovery-b' };
const IDENT = 'SETTLE-RECOVERY-01';
const KEY_A = 'SB-Mid-server-SETTLE-A', KEY_B = 'SB-Mid-server-SETTLE-B';
const hook = { a: `settleA${randomBytes(10).toString('hex')}`, b: `settleB${randomBytes(10).toString('hex')}` };
const ids: Record<string, string> = {};

const alerts: Array<{ kind: string; severity: string; targetId?: string }> = [];
bus.on('alert.raised', (e: any) => { alerts.push({ kind: e.kind, severity: e.severity, targetId: e.targetId }); });
const captures: string[] = [];
bus.on('payment.hold_captured', (e: any) => { captures.push(e.paymentIntentId); });

async function cleanup(): Promise<void> {
  const orgs = (await query(`SELECT id FROM organisation WHERE slug = ANY($1::text[])`, [Object.values(SLUG)])).rows.map((r: any) => r.id);
  if (!orgs.length) return;
  await query(`DELETE FROM integration_event WHERE org_id = ANY($1::uuid[]) OR integration_id IN (SELECT id FROM integration WHERE org_id = ANY($1::uuid[]))`, [orgs]);
  await query(`UPDATE payment_intent SET session_id = NULL WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM cdr WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM charging_session WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM payment_intent WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM token WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM connector WHERE evse_uuid IN (SELECT e.id FROM evse e JOIN charge_point cp ON cp.id = e.charge_point_id WHERE cp.ocpp_identity = $1)`, [IDENT]);
  await query(`DELETE FROM evse WHERE charge_point_id IN (SELECT id FROM charge_point WHERE ocpp_identity = $1)`, [IDENT]);
  await query(`DELETE FROM charge_point WHERE ocpp_identity = $1`, [IDENT]);
  await query(`DELETE FROM site WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM integration WHERE org_id = ANY($1::uuid[])`, [orgs]);
}

if (DB_OK) {
  before(async () => {
    await cleanup();
    for (const k of ['a', 'b'] as const) {
      ids[`org_${k}`] = (await one<{ id: string }>(
        `INSERT INTO organisation (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [`Settle ${k}`, SLUG[k]]))!.id;
    }
    ids.site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, local_tax_rate_bps) VALUES ($1, 'Settle Hub', 1000) RETURNING id`, [ids.org_a]))!.id;
    ids.cp = (await one<{ id: string }>(
      `INSERT INTO charge_point (site_id, ocpp_identity, ocpp_version, status) VALUES ($1, $2, 'ocpp1.6', 'online') RETURNING id`, [ids.site, IDENT]))!.id;
    const e = await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1, 1, 22000) RETURNING id`, [ids.cp]);
    ids.conn = (await one<{ id: string }>(
      `INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w, tera_status, tera_cert_status)
       VALUES ($1, 1, 'Type2', 'AC', 22000, 'verified', 'verified') RETURNING id`, [e!.id]))!.id;
    const integ = (org: string, serverKey: string, key: string) => one<{ id: string }>(
      `INSERT INTO integration (org_id, kind, provider, settings, secrets_sealed, webhook_key) VALUES ($1, 'payments', 'midtrans', $2, $3, $4) RETURNING id`,
      [org, JSON.stringify({ environment: 'sandbox', baseUrl: 'http://127.0.0.1:9' }), seal(JSON.stringify({ serverKey })), key]);
    ids.int_a = (await integ(ids.org_a!, KEY_A, hook.a))!.id;
    ids.int_b = (await integ(ids.org_b!, KEY_B, hook.b))!.id;
  });
  after(async () => {
    await cleanup();
    await pool.end();
  });
}

/** A session rated `minutesAgo` minutes ago (its CDR committed then) for `totalMinor`, its payment not settled. */
async function ratedSession(intentId: string, totalMinor: number, minutesAgo = 10): Promise<string> {
  const sid = (await one<{ id: string }>(
    `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, ocpp_transaction_id, state,
                                   started_at, ended_at, meter_start_wh, meter_stop_wh, energy_wh, payment_intent_id, rated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'rated', now() - interval '90 minutes', now() - make_interval(mins => $7::int), 0, 10000, 10000, $8,
             now() - make_interval(mins => $7::int))
     RETURNING id`,
    [ids.org_a, ids.site, ids.conn, ids.cp, randomUUID(), String(Math.floor(Math.random() * 1e9)), minutesAgo, intentId]))!.id;
  await query(`UPDATE payment_intent SET session_id = $2 WHERE id = $1`, [intentId, sid]);
  await query(
    `INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot)
     VALUES ($1, $2, now() - make_interval(mins => $3::int), '[]', $4, 0, 0, 0, 0, 0, $4, '{}')`,
    [sid, ids.org_a, minutesAgo, totalMinor]);
  return sid;
}

/** A card hold of Rp 100,000 on the built-in sandbox acquirer, authorised and held. */
const heldIntent = async (extra: { holdState?: string; holdCapture?: number } = {}) => (await one<{ id: string }>(
  `INSERT INTO payment_intent (org_id, provider, provider_ref, method, mode, state, amount_authorised_minor, hold_state, hold_capture_minor, authorised_at)
   VALUES ($1, 'mock', $2, 'card', 'preauth', 'authorised', 100000, $3, $4, now() - interval '2 hours') RETURNING id`,
  [ids.org_a, `mock_card_${randomUUID()}`, extra.holdState ?? 'held', extra.holdCapture ?? null]))!.id;

/** The hold worker's capture runs on setImmediate: wait until the hold has left 'capturing'. */
async function settled(intentId: string): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const r = await one<any>(`SELECT * FROM payment_intent WHERE id = $1`, [intentId]);
    if (r.hold_state !== 'capturing' && r.hold_state !== 'releasing') return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  return one<any>(`SELECT * FROM payment_intent WHERE id = $1`, [intentId]);
}

dbDescribe('1 — payments of rated sessions left unsettled are settled by the recovery sweep', () => {
  test('a session with a CDR and a hold still held (crash after rating): captured for the CDR total', async () => {
    const pi = await heldIntent();
    await ratedSession(pi, 42_300);
    assert.ok((await recoverUnsettledPayments(ids.org_a)) >= 1);
    const r = await settled(pi);
    assert.deepEqual({ state: r.state, hold: r.hold_state, captured: r.amount_captured_minor, delta: r.settlement_delta_minor, settledAt: r.settled_at != null },
      { state: 'captured', hold: 'captured', captured: 42_300, delta: 0, settledAt: true });
  });

  test('running the sweep twice (and two at once) captures once', async () => {
    const pi = await heldIntent();
    await ratedSession(pi, 30_000);
    captures.length = 0;
    await Promise.all([recoverUnsettledPayments(ids.org_a), recoverUnsettledPayments(ids.org_a)]);
    await settled(pi);
    await recoverUnsettledPayments(ids.org_a);
    await settled(pi);
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(captures.filter((x) => x === pi).length, 1, 'one capture');
    assert.equal((await one<any>(`SELECT amount_captured_minor AS c FROM payment_intent WHERE id = $1`, [pi]))?.c, 30_000);
  });

  test('a CDR younger than the grace period is left to the inline settlement', async () => {
    const pi = await heldIntent();
    await ratedSession(pi, 20_000, 1);
    await recoverUnsettledPayments(ids.org_a);
    const r = await one<any>(`SELECT hold_state, settled_at FROM payment_intent WHERE id = $1`, [pi]);
    assert.deepEqual({ hold: r.hold_state, settled: r.settled_at }, { hold: 'held', settled: null });
  });

  test('a run that stopped after asking for the capture: marked settled, the failed capture is NOT reset (the hold worker owns it)', async () => {
    const pi = await heldIntent({ holdState: 'capture_failed', holdCapture: 25_000 });
    await query(`UPDATE payment_intent SET hold_attempts = 6, hold_error = 'hold expired: gone', hold_next_attempt_at = NULL WHERE id = $1`, [pi]);
    await ratedSession(pi, 25_000);
    await recoverUnsettledPayments(ids.org_a);
    const r = await one<any>(`SELECT hold_state, hold_attempts, hold_error, settlement_delta_minor AS delta, settled_at FROM payment_intent WHERE id = $1`, [pi]);
    assert.deepEqual({ hold: r.hold_state, attempts: r.hold_attempts, err: r.hold_error, delta: r.delta, settled: r.settled_at != null },
      { hold: 'capture_failed', attempts: 6, err: 'hold expired: gone', delta: 0, settled: true });
  });

  test('a pre-purchase that paid more than the session cost: the balance is queued for refund, once, with one alert', async () => {
    const pi = (await one<{ id: string }>(
      `INSERT INTO payment_intent (org_id, provider, provider_ref, method, mode, state, amount_authorised_minor, amount_captured_minor, captured_at)
       VALUES ($1, 'mock', $2, 'qris', 'prepurchase', 'captured', 100000, 100000, now() - interval '2 hours') RETURNING id`,
      [ids.org_a, `mock_qris_${randomUUID()}`]))!.id;
    const sid = await ratedSession(pi, 40_000);
    alerts.length = 0;
    await recoverUnsettledPayments(ids.org_a);
    await recoverUnsettledPayments(ids.org_a);
    const r = await one<any>(`SELECT refund_state, refund_due_minor AS due, settlement_delta_minor AS delta, settled_at FROM payment_intent WHERE id = $1`, [pi]);
    assert.deepEqual({ refund: r.refund_state, due: r.due, delta: r.delta, settled: r.settled_at != null }, { refund: 'due', due: 60_000, delta: -60_000, settled: true });
    assert.equal(alerts.filter((a) => a.kind === 'prepaid.refund_due' && a.targetId === pi).length, 1);
    const flags = (await one<{ flags: any[] }>(`SELECT flags FROM charging_session WHERE id = $1`, [sid]))!.flags;
    assert.equal(flags.filter((f) => f.code === 'PREPAID_REFUND_DUE').length, 1);
  });
});

const midtransNotify = (hookKey: string, serverKey: string, orderId: string, status: string, gross: number) => {
  const g = `${gross}.00`;
  const sig = createHash('sha512').update(`${orderId}200${g}${serverKey}`).digest('hex');
  const body = JSON.stringify({ order_id: orderId, status_code: '200', gross_amount: g, transaction_status: status, fraud_status: 'accept', transaction_id: `tx-${orderId}`, signature_key: sig });
  return handleNotification(hookKey, body, {}, `/pay/notify/${hookKey}`);
};
const lastOutcome = async (integrationId: string) =>
  (await one<{ outcome: string }>(`SELECT outcome FROM integration_event WHERE integration_id = $1 AND action = 'notification' ORDER BY id DESC LIMIT 1`, [integrationId]))?.outcome;
const pendingIntent = async (mode: 'preauth' | 'prepurchase', ref: string, org = ids.org_a, integ: string | null = ids.int_a!) => (await one<{ id: string }>(
  `INSERT INTO payment_intent (org_id, provider, provider_ref, method, mode, state, amount_authorised_minor, integration_id, claim_id_tag, claim_token_minted, connector_uuid)
   VALUES ($1, 'midtrans', $2, $3, $4, 'pending', 100000, $5, $6, true, $7) RETURNING id`,
  [org, ref, mode === 'preauth' ? 'card' : 'qris', mode, integ, `PS-${ref}`, ids.conn]))!.id;

dbDescribe('2 — a notification for less than the payment is escalated, and the money is not stranded', () => {
  test('a hold authorised for less: not held (cannot start a session), released through the hold machinery, critical alert, once', async () => {
    const ref = `ps-under-hold-${randomUUID().slice(0, 8)}`;
    const pi = await pendingIntent('preauth', ref);
    await query(`INSERT INTO token (org_id, kind, uid, status) VALUES ($1, 'prepaid', $2, 'Accepted')`, [ids.org_a, `PS-${ref}`]);
    alerts.length = 0;
    const res = await midtransNotify(hook.a, KEY_A, ref, 'authorize', 60_000);
    assert.equal(res.status, 200);
    assert.equal(await lastOutcome(ids.int_a!), 'amount_mismatch');
    const r = await one<any>(`SELECT state, hold_state, hold_next_attempt_at IS NOT NULL AS due, hold_error FROM payment_intent WHERE id = $1`, [pi]);
    assert.equal(r.state, 'pending', 'never authorised: no session can claim it');
    assert.equal(r.hold_state, 'releasing');
    assert.equal(r.due, true);
    assert.match(r.hold_error, /^amount mismatch:/);
    assert.equal((await one<any>(`SELECT status FROM token WHERE org_id = $1 AND uid = $2`, [ids.org_a, `PS-${ref}`]))?.status, 'Expired');
    assert.deepEqual(alerts.filter((a) => a.targetId === pi).map((a) => [a.kind, a.severity]), [['payment.amount_mismatch', 'critical']]);
    // The acquirer repeats the notification: nothing moves again, no second alert.
    await midtransNotify(hook.a, KEY_A, ref, 'authorize', 60_000);
    assert.equal(alerts.filter((a) => a.targetId === pi).length, 1);
    assert.equal((await one<any>(`SELECT hold_state FROM payment_intent WHERE id = $1`, [pi]))?.hold_state, 'releasing');
  });

  test('a QRIS paid for less: recorded as taken, not captured (voided), refunded in full via the refund queue, critical alert, once', async () => {
    const ref = `ps-under-qris-${randomUUID().slice(0, 8)}`;
    const pi = await pendingIntent('prepurchase', ref);
    alerts.length = 0;
    const res = await midtransNotify(hook.a, KEY_A, ref, 'settlement', 10_000);
    assert.equal(res.status, 200);
    assert.equal(await lastOutcome(ids.int_a!), 'amount_mismatch');
    const r = await one<any>(`SELECT state, amount_captured_minor AS captured, refund_state, refund_due_minor AS due FROM payment_intent WHERE id = $1`, [pi]);
    assert.deepEqual({ state: r.state, captured: r.captured, refund: r.refund_state, due: r.due }, { state: 'voided', captured: 10_000, refund: 'due', due: 10_000 });
    assert.deepEqual(alerts.filter((a) => a.targetId === pi).map((a) => [a.kind, a.severity]), [['payment.amount_mismatch', 'critical']]);
    await midtransNotify(hook.a, KEY_A, ref, 'settlement', 10_000);
    assert.equal(alerts.filter((a) => a.targetId === pi).length, 1, 'a repeated notification raises nothing again');
    assert.equal((await one<any>(`SELECT refund_due_minor AS due FROM payment_intent WHERE id = $1`, [pi]))?.due, 10_000);
  });

  test('the full amount is still captured as before', async () => {
    const ref = `ps-full-qris-${randomUUID().slice(0, 8)}`;
    const pi = await pendingIntent('prepurchase', ref);
    await midtransNotify(hook.a, KEY_A, ref, 'settlement', 100_000);
    assert.equal(await lastOutcome(ids.int_a!), 'captured');
    assert.deepEqual(await one(`SELECT state, refund_state FROM payment_intent WHERE id = $1`, [pi]), { state: 'captured', refund_state: null });
  });
});

dbDescribe('3 — a notification on one organisation\'s account cannot settle another organisation\'s payment', () => {
  test('org B\'s account, an org A payment that names no account: refused (wrong_account), not captured', async () => {
    const ref = `ps-cross-org-${randomUUID().slice(0, 8)}`;
    const pi = await pendingIntent('prepurchase', ref, ids.org_a, null);
    await midtransNotify(hook.b, KEY_B, ref, 'settlement', 100_000);
    assert.equal(await lastOutcome(ids.int_b!), 'wrong_account');
    assert.equal((await one<any>(`SELECT state FROM payment_intent WHERE id = $1`, [pi]))?.state, 'pending');
  });
});

describe('3 — notificationAccountMismatch (pure)', () => {
  const A = { org_id: 'org-a', integration_id: 'int-a' };
  test('the same account, or a platform account for any organisation: accepted', () => {
    assert.equal(notificationAccountMismatch(A, { orgId: 'org-a', integrationId: 'int-a' }, { env: 'production' }), null);
    assert.equal(notificationAccountMismatch(A, { orgId: null, integrationId: 'int-a' }, { env: 'production' }), null);
  });
  test('another account, or another organisation\'s account: refused everywhere', () => {
    assert.ok(notificationAccountMismatch(A, { orgId: 'org-a', integrationId: 'int-x' }, { env: 'test' }));
    assert.ok(notificationAccountMismatch({ org_id: 'org-a', integration_id: null }, { orgId: 'org-b', integrationId: 'int-b' }, { env: 'test' }));
  });
  test('one side naming an account and the other none: refused in production (and any non-dev env), allowed in development/test', () => {
    for (const env of ['production', 'staging']) {
      assert.ok(notificationAccountMismatch(A, { orgId: null, integrationId: null }, { env }), `${env}: intent names one, notification none`);
      assert.ok(notificationAccountMismatch({ org_id: 'org-a', integration_id: null }, { orgId: null, integrationId: 'int-p' }, { env }), `${env}: vice versa`);
    }
    assert.equal(notificationAccountMismatch(A, { orgId: null, integrationId: null }, { env: 'development' }), null);
    assert.equal(notificationAccountMismatch({ org_id: 'org-a', integration_id: null }, { orgId: null, integrationId: 'int-p' }, { env: 'production', requireAccount: false }), null);
  });
});
