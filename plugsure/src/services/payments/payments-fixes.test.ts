import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { one, pool, query } from '../../db/pool.js';
import { databaseTestLock } from '../../db/test-lock.js';
import { seal } from '../secrets.js';
import { bus } from '../events.js';
import { handleNotification, startPayment, type PreparedPayment } from './registry.js';
import { attemptHold } from './holds.js';
import { MockPaymentProvider } from './mock.js';
import { MidtransProvider } from './midtrans.js';
import { markRefundedManually, processRefund, sweepProcessingRefunds } from '../refunds.js';
import { checkoutPrepaid } from '../../driver/charge.js';
import type { Resolved } from '../../integrations/store.js';

/**
 * Payments, database-backed: passes settled only by their own account and for their full price, and a pass paid after
 * its checkout was voided refunded (A); post-pay charges recorded before the acquirer is asked and looked up rather than
 * charged again after a lost answer, and checkout recording the payment first (B); a Midtrans capture confirmation
 * settling a hold PlugSure thought was not captured (C); refunds paid once (D); post-pay limits over all the driver's
 * sessions at once (E); whole-rupiah amounts (F).
 *
 * Runs only against the disposable test database:
 *   DATABASE_URL=postgresql://postgres:…@127.0.0.1:5433/plugsure_audit_fix npx tsx --test src/services/payments/payments-fixes.test.ts
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[payments-fixes.test] SKIPPING database-backed payment suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

// ------------------------------------------------------------ a fake acquirer (Midtrans and Xendit paths)
const seen: Array<{ method: string; path: string; body: string }> = [];
const answers = new Map<string, { status: number; body: unknown } | 'drop'>();
let base = '';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0]!;
    seen.push({ method: req.method ?? '', path, body });
    const a = answers.get(`${req.method} ${path}`) ?? answers.get(path) ?? { status: 404, body: { status_code: '404', status_message: 'no fake' } };
    if (a === 'drop') { req.socket.destroy(); return; }
    res.writeHead(a.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(a.body));
  });
});

const SLUG = { a: 'payfix-test-a', b: 'payfix-test-b', c: 'payfix-test-c' };
const KEY_A = 'SB-Mid-server-PAYFIX-A', KEY_B = 'SB-Mid-server-PAYFIX-B', XCB = 'xendit-cb-payfix-0001';
const ids: Record<string, string> = {};
const hook = { a: `payfixA${randomBytes(10).toString('hex')}`, b: `payfixB${randomBytes(10).toString('hex')}`, c: `payfixC${randomBytes(10).toString('hex')}` };
const alerts: Array<{ kind: string; targetId?: string }> = [];
bus.on('alert.raised', (e: any) => { alerts.push({ kind: e.kind, targetId: e.targetId }); });
const completed: string[] = [];
bus.on('refund.completed', (e: any) => { completed.push(e.paymentIntentId); });
const completedFor = (id: string) => completed.filter((x) => x === id).length;

async function cleanup(): Promise<void> {
  const orgs = (await query(`SELECT id FROM organisation WHERE slug = ANY($1::text[])`, [Object.values(SLUG)])).rows.map((r: any) => r.id);
  if (!orgs.length) return;
  await query(`DELETE FROM integration_event WHERE org_id = ANY($1::uuid[]) OR integration_id IN (SELECT id FROM integration WHERE org_id = ANY($1::uuid[]))`, [orgs]);
  await query(`DELETE FROM driver_charge WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM payment_intent WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM subscription_charge WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM subscription WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM subscription_plan WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM app_driver WHERE phone LIKE '+62899000%'`);
  await query(`DELETE FROM integration WHERE org_id = ANY($1::uuid[])`, [orgs]);
}

const midtransSig = (key: string, orderId: string, code: string, gross: string) => createHash('sha512').update(`${orderId}${code}${gross}${key}`).digest('hex');
const midtransNotify = (hookKey: string, serverKey: string, orderId: string, status: string, gross: number, extra: Record<string, unknown> = {}) => {
  const g = `${gross}.00`;
  const body = JSON.stringify({ order_id: orderId, status_code: '200', gross_amount: g, transaction_status: status, fraud_status: 'accept', transaction_id: `tx-${orderId}`, signature_key: midtransSig(serverKey, orderId, '200', g), ...extra });
  return handleNotification(hookKey, body, {}, `/pay/notify/${hookKey}`);
};
const lastOutcome = async (integrationId: string) =>
  (await one<{ outcome: string }>(`SELECT outcome FROM integration_event WHERE integration_id = $1 AND action = 'notification' ORDER BY id DESC LIMIT 1`, [integrationId]))?.outcome;

if (DB_OK) {
  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    await cleanup();
    for (const k of ['a', 'b', 'c'] as const) {
      ids[`org_${k}`] = (await one<{ id: string }>(
        `INSERT INTO organisation (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [`Payfix ${k}`, SLUG[k]]))!.id;
    }
    const integ = (org: string, provider: string, settings: unknown, secrets: unknown, key: string) => one<{ id: string }>(
      `INSERT INTO integration (org_id, kind, provider, settings, secrets_sealed, webhook_key) VALUES ($1, 'payments', $2, $3, $4, $5) RETURNING id`,
      [org, provider, JSON.stringify(settings), seal(JSON.stringify(secrets)), key]);
    ids.int_a = (await integ(ids.org_a!, 'midtrans', { environment: 'sandbox', baseUrl: base }, { serverKey: KEY_A }, hook.a))!.id;
    ids.int_b = (await integ(ids.org_b!, 'midtrans', { environment: 'sandbox', baseUrl: base }, { serverKey: KEY_B }, hook.b))!.id;
    ids.int_c = (await integ(ids.org_c!, 'xendit', { baseUrl: base }, { secretKey: 'xnd_development_payfix', callbackToken: XCB }, hook.c))!.id;
    ids.driver = (await one<{ id: string }>(`INSERT INTO app_driver (phone) VALUES ('+628990001001') RETURNING id`))!.id;
    ids.driver2 = (await one<{ id: string }>(`INSERT INTO app_driver (phone) VALUES ('+628990001002') RETURNING id`))!.id;
    ids.plan = (await one<{ id: string }>(`INSERT INTO subscription_plan (org_id, name, monthly_fee_idr, offered_in_app) VALUES ($1, 'Payfix Pass', 100000, true) RETURNING id`, [ids.org_a]))!.id;
    ids.sub = (await one<{ id: string }>(
      `INSERT INTO subscription (org_id, plan_id, subscriber_kind, app_driver_id, billing, status) VALUES ($1, $2, 'app_driver', $3, 'qris', 'pending_payment') RETURNING id`,
      [ids.org_a, ids.plan, ids.driver]))!.id;
    // A linked GoPay at org A's Midtrans account (post-pay), and a sandbox one (the post-pay limit).
    ids.gopay = (await one<{ id: string }>(
      `INSERT INTO driver_card (app_driver_id, integration_id, provider, token_sealed, token_hash, kind, channel, status, link_ref)
       VALUES ($1, $2, 'midtrans', $3, $4, 'ewallet', 'GOPAY', 'active', 'acc-1') RETURNING id`,
      [ids.driver, ids.int_a, seal(JSON.stringify({ accountId: 'acc-1', token: 'tok-1' })), randomBytes(16).toString('hex')]))!.id;
    ids.mockWallet = (await one<{ id: string }>(
      `INSERT INTO driver_card (app_driver_id, integration_id, provider, token_sealed, token_hash, kind, channel, status)
       VALUES ($1, NULL, 'mock', $2, $3, 'ewallet', 'GOPAY', 'active') RETURNING id`,
      [ids.driver2, seal('mock_wallet_payfix'), randomBytes(16).toString('hex')]))!.id;
  });
  after(async () => {
    await cleanup();
    server.close();
    await pool.end();
  });
}

const passCharge = async (ref: string, state = 'pending', integrationId = ids.int_a) => (await one<{ id: string }>(
  `INSERT INTO subscription_charge (subscription_id, org_id, period_start, period_end, fee_idr, dpp_idr, ppn_idr, total_idr, via, state, provider_ref, provider, integration_id, channel)
   VALUES ($1, $2, now() + make_interval(days => $5::int), now() + make_interval(days => $5::int + 30), 100000, 91667, 11000, 111000, 'qris', $4, $3, 'midtrans', $6, 'QRIS') RETURNING id`,
  [ids.sub, ids.org_a, ref, state, Math.floor(Math.random() * 100000), integrationId]))!.id;

dbDescribe('A — app passes: the account that took the payment, the full price, and a payment after the checkout was voided', () => {
  test('a settlement signed by ANOTHER operator\'s Midtrans account for this pass\'s order id is refused (wrong_account); the pass stays unpaid', async () => {
    const id = await passCharge('ps-pass-cross');
    await midtransNotify(hook.b, KEY_B, 'ps-pass-cross', 'settlement', 111000);
    assert.equal(await lastOutcome(ids.int_b!), 'wrong_account');
    assert.equal((await one<{ state: string }>(`SELECT state FROM subscription_charge WHERE id = $1`, [id]))?.state, 'pending');
    // Its own account settles it.
    await midtransNotify(hook.a, KEY_A, 'ps-pass-cross', 'settlement', 111000);
    assert.equal(await lastOutcome(ids.int_a!), 'pass_paid');
    assert.equal((await one<{ state: string }>(`SELECT state FROM subscription_charge WHERE id = $1`, [id]))?.state, 'paid');
  });

  test('a settlement for less than the pass costs is not booked (amount_mismatch)', async () => {
    const id = await passCharge('ps-pass-under');
    await midtransNotify(hook.a, KEY_A, 'ps-pass-under', 'settlement', 1000);
    assert.equal(await lastOutcome(ids.int_a!), 'amount_mismatch');
    assert.equal((await one<{ state: string }>(`SELECT state FROM subscription_charge WHERE id = $1`, [id]))?.state, 'pending');
  });

  test('a pass paid after its charge was voided is kept as a payment owed back in full (refund due, alert), once', async () => {
    const id = await passCharge('ps-pass-void', 'void');
    alerts.length = 0;
    await midtransNotify(hook.a, KEY_A, 'ps-pass-void', 'settlement', 111000);
    assert.equal(await lastOutcome(ids.int_a!), 'pass_paid_after_void_refund_due');
    const pi = await one<any>(`SELECT * FROM payment_intent WHERE idem_key = $1`, [`pass-after-void:${id}`]);
    assert.deepEqual({ mode: pi?.mode, state: pi?.state, captured: pi?.amount_captured_idr, refund: pi?.refund_state, due: pi?.refund_due_idr, ref: pi?.provider_ref, integ: pi?.integration_id },
      { mode: 'pass', state: 'captured', captured: 111000, refund: 'due', due: 111000, ref: 'ps-pass-void', integ: ids.int_a });
    assert.ok(alerts.some((a) => a.kind === 'payment.refund_due' && a.targetId === pi.id));
    await midtransNotify(hook.a, KEY_A, 'ps-pass-void', 'settlement', 111000);
    assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM payment_intent WHERE provider_ref = 'ps-pass-void' AND org_id = $1`, [ids.org_a]))?.n, 1, 'a repeated notification adds nothing');
  });
});

const postpayIntent = async (extra: Record<string, unknown> = {}) => (await one<{ id: string }>(
  `INSERT INTO payment_intent (org_id, provider, method, mode, state, amount_authorised_idr, hold_state, hold_capture_idr, integration_id, driver_card_id, channel, hold_next_attempt_at, provider_ref)
   VALUES ($1, 'midtrans', 'ewallet', 'postpay', 'authorised', 50000, 'capturing', 21340, $2, $3, 'GOPAY', now(), $4) RETURNING id`,
  [ids.org_a, ids.int_a, ids.gopay, extra.providerRef ?? `postpay-${randomUUID()}`]))!.id;

dbDescribe('B — post-pay e-wallet charges are recorded before the acquirer is asked, and never charged blind again', () => {
  test('no answer from Midtrans: the order id was recorded first; the settlement notification then finds the session', async () => {
    seen.length = 0; answers.clear();
    answers.set('/v2/pay/account/acc-1', { status: 200, body: { account_status: 'ENABLED', metadata: { payment_options: [{ name: 'GOPAY_WALLET', active: true, token: 'tok-1' }] } } });
    answers.set('POST /v2/charge', 'drop');
    const id = await postpayIntent();
    const r = await attemptHold(id);
    assert.equal(r.ok, false);
    const row = await one<any>(`SELECT provider_ref, hold_state, hold_error FROM payment_intent WHERE id = $1`, [id]);
    const expect = new MidtransProvider({ environment: 'sandbox', serverKey: '' }).orderRef(`postpay:${id}:1`);
    assert.equal(row.provider_ref, expect, 'the charge\'s order id is on the session before Midtrans answered');
    assert.equal(JSON.parse(seen.find((s) => s.path === '/v2/charge')!.body).transaction_details.order_id, expect);
    assert.equal(row.hold_state, 'capture_failed');
    assert.match(row.hold_error, /^outcome unknown: the e-wallet charge postpay:/);
    // GoPay settled after all: its notification is recorded against this session (it was 'unknown_payment' before).
    await midtransNotify(hook.a, KEY_A, expect, 'settlement', 21340);
    assert.equal(await lastOutcome(ids.int_a!), 'postpay_paid');
    assert.deepEqual(await one(`SELECT hold_state, amount_captured_idr AS captured FROM payment_intent WHERE id = $1`, [id]), { hold_state: 'captured', captured: 21340 });
  });

  test('the next attempt after a lost answer asks Midtrans first: settled there → recorded as paid, not charged a second time', async () => {
    seen.length = 0; answers.clear();
    answers.set('/v2/pay/account/acc-1', { status: 200, body: { account_status: 'ENABLED', metadata: { payment_options: [{ name: 'GOPAY_WALLET', active: true, token: 'tok-1' }] } } });
    answers.set('POST /v2/charge', 'drop');
    const id = await postpayIntent();
    await attemptHold(id);
    const ref = (await one<{ provider_ref: string }>(`SELECT provider_ref FROM payment_intent WHERE id = $1`, [id]))!.provider_ref;
    answers.set(`/v2/${ref}/status`, { status: 200, body: { status_code: '200', transaction_status: 'settlement', gross_amount: '21340.00', transaction_id: 'tx-late' } });
    answers.set('POST /v2/charge', { status: 200, body: { status_code: '200', transaction_status: 'settlement', transaction_id: 'tx-second' } });
    await query(`UPDATE payment_intent SET hold_next_attempt_at = now() WHERE id = $1`, [id]);
    const r = await attemptHold(id);
    assert.deepEqual({ ok: r.ok, state: r.state }, { ok: true, state: 'captured' });
    assert.equal(seen.filter((s) => s.path === '/v2/charge').length, 1, 'one charge only');
    assert.deepEqual(await one(`SELECT hold_state, provider_payment_id FROM payment_intent WHERE id = $1`, [id]), { hold_state: 'captured', provider_payment_id: 'tx-late' });
  });

  test('…and never received there (404): a new charge, under a new attempt\'s reference', async () => {
    seen.length = 0; answers.clear();
    answers.set('/v2/pay/account/acc-1', { status: 200, body: { account_status: 'ENABLED', metadata: { payment_options: [{ name: 'GOPAY_WALLET', active: true, token: 'tok-1' }] } } });
    answers.set('POST /v2/charge', 'drop');
    const id = await postpayIntent();
    await attemptHold(id);
    answers.set('POST /v2/charge', { status: 200, body: { status_code: '200', transaction_status: 'settlement', transaction_id: 'tx-2' } });
    await query(`UPDATE payment_intent SET hold_next_attempt_at = now() WHERE id = $1`, [id]);
    const r = await attemptHold(id);
    assert.equal(r.ok, true);
    const orders = seen.filter((s) => s.path === '/v2/charge').map((s) => JSON.parse(s.body).transaction_details.order_id);
    const mp = new MidtransProvider({ environment: 'sandbox', serverKey: '' });
    assert.deepEqual(orders, [mp.orderRef(`postpay:${id}:1`), mp.orderRef(`postpay:${id}:2`)]);
  });

  test('startPayment hands the derived reference to prepare BEFORE the acquirer is asked (a lost answer still leaves the record)', async () => {
    seen.length = 0; answers.clear();
    answers.set('POST /v2/charge', 'drop');
    const prov = new MidtransProvider({ environment: 'sandbox', serverKey: KEY_A, baseUrl: base });
    const resolved: Resolved = { kind: 'payments', provider: 'midtrans', settings: { methods: ['QRIS'] }, secrets: {}, integrationId: ids.int_a!, orgId: ids.org_a!, source: 'console', webhookKey: null };
    const prepared: PreparedPayment[] = [];
    await assert.rejects(startPayment({ provider: prov, resolved }, { referenceId: 'charge:prep-1', amountIdr: 25000, returnUrl: 'x', prepare: async (p) => { prepared.push(p); } }), /cannot reach/);
    assert.deepEqual(prepared.map((p) => [p.providerRef, p.mode, p.method]), [[prov.orderRef('charge:prep-1'), 'prepurchase', 'qris']]);
  });

  test('checkout: a non-integer or unsafe amount is refused before anything else (F)', async () => {
    const principal = { deviceId: randomUUID(), appDriverId: null } as any;
    for (const amt of [1000.5, Number.NaN, -1, 0, 2 ** 53]) {
      assert.deepEqual(await checkoutPrepaid(principal, randomUUID(), amt), { ok: false, error: 'Jumlah tidak valid.' }, String(amt));
    }
  });
});

dbDescribe('C — a Midtrans capture confirmation settles a hold PlugSure recorded as not captured', () => {
  const hold = async (ref: string) => (await one<{ id: string }>(
    `INSERT INTO payment_intent (org_id, provider, provider_ref, method, mode, state, amount_authorised_idr, hold_state, hold_capture_idr, hold_attempts, hold_error, integration_id, provider_payment_id)
     VALUES ($1, 'midtrans', $2, 'card', 'preauth', 'authorised', 100000, 'capture_failed', 42300, 6, '412 Transaction status cannot be updated', $3, 'tx-h') RETURNING id`,
    [ids.org_a, ref, ids.int_a]))!.id;
  test('capture notification for a capture_failed hold → captured for what was asked (it only appended raw_events before)', async () => {
    const id = await hold('ps-hold-c1');
    await midtransNotify(hook.a, KEY_A, 'ps-hold-c1', 'capture', 42300);
    assert.equal(await lastOutcome(ids.int_a!), 'capture_reconciled');
    assert.deepEqual(await one(`SELECT state, hold_state, amount_captured_idr AS captured, hold_error FROM payment_intent WHERE id = $1`, [id]),
      { state: 'captured', hold_state: 'captured', captured: 42300, hold_error: null });
  });
  test('a confirmation above the hold is not reconciled', async () => {
    const id = await hold('ps-hold-c2');
    await midtransNotify(hook.a, KEY_A, 'ps-hold-c2', 'capture', 150000);
    assert.equal(await lastOutcome(ids.int_a!), 'amount_mismatch');
    assert.equal((await one<{ hold_state: string }>(`SELECT hold_state FROM payment_intent WHERE id = $1`, [id]))?.hold_state, 'capture_failed');
  });
});

const refundIntent = async (state: string, extra: { ref?: string | null; pid?: string; org?: string; provider?: string; integ?: string } = {}) => (await one<{ id: string }>(
  `INSERT INTO payment_intent (org_id, provider, provider_ref, method, mode, state, amount_authorised_idr, amount_captured_idr, channel, provider_payment_id, integration_id,
                               refund_state, refund_due_idr, refund_ref, refund_method, refund_requested_at, updated_at)
   VALUES ($1, $2, $3, 'ewallet', 'prepurchase', 'captured', 50000, 50000, 'OVO', $4, $5, $6, 20000, $7, CASE WHEN $7::text IS NOT NULL THEN 'provider' END, now(), now() - interval '1 hour') RETURNING id`,
  [extra.org ?? ids.org_c, extra.provider ?? 'xendit', `ps-${randomUUID()}`, extra.pid ?? 'pr-1', extra.integ ?? ids.int_c, state, extra.ref ?? null]))!.id;

dbDescribe('D — a refund is paid once', () => {
  test('no bank transfer on top of a provider refund in flight or pending; allowed once the provider refused it', async () => {
    const id = await refundIntent('processing', { ref: 'rfd-pending' });
    const r = await markRefundedManually(id, 'BCA-TRF-001', null);
    assert.deepEqual({ ok: r.ok, state: r.state }, { ok: false, state: 'processing' });
    assert.equal((await one<{ refund_state: string }>(`SELECT refund_state FROM payment_intent WHERE id = $1`, [id]))?.refund_state, 'processing');
    await query(`UPDATE payment_intent SET refund_state = 'failed' WHERE id = $1`, [id]);
    assert.equal((await markRefundedManually(id, 'BCA-TRF-001', null)).ok, true);
  });

  test('two completions at once: exactly one records the refund', async () => {
    const id = await refundIntent('due');
    const rs = await Promise.all([markRefundedManually(id, 'BCA-TRF-A', null), markRefundedManually(id, 'BCA-TRF-B', null)]);
    assert.deepEqual([rs.filter((r) => r.ok).length, completedFor(id)], [1, 1]);
  });

  test('the database refuses a refund larger than what was captured (migration 044)', async () => {
    const id = await refundIntent('due');
    await assert.rejects(query(`UPDATE payment_intent SET refund_due_idr = 50001 WHERE id = $1`, [id]), /payment_intent_refund_within_captured/);
  });

  test('a provider refund with no answer stays processing (not failed), so it cannot be paid again by bank transfer', async () => {
    seen.length = 0; answers.clear();
    answers.set('POST /refunds', 'drop');
    const id = await refundIntent('due', { pid: 'pr-drop' });
    const r = await processRefund(id, null);
    assert.deepEqual({ ok: r.ok, state: r.state }, { ok: false, state: 'processing' });
    assert.equal((await markRefundedManually(id, 'BCA-TRF-X', null)).ok, false);
  });

  test('the worker settles refunds left processing: Xendit says SUCCEEDED → refunded, FAILED → failed (retry / bank transfer)', async () => {
    answers.clear();
    answers.set('/refunds/rfd-ok', { status: 200, body: { id: 'rfd-ok', status: 'SUCCEEDED' } });
    answers.set('/refunds/rfd-no', { status: 200, body: { id: 'rfd-no', status: 'FAILED' } });
    const ok = await refundIntent('processing', { ref: 'rfd-ok' });
    const no = await refundIntent('processing', { ref: 'rfd-no' });
    await sweepProcessingRefunds();
    assert.deepEqual(await one(`SELECT refund_state, refunded_idr FROM payment_intent WHERE id = $1`, [ok]), { refund_state: 'refunded', refunded_idr: 20000 });
    assert.equal((await one<{ refund_state: string }>(`SELECT refund_state FROM payment_intent WHERE id = $1`, [no]))?.refund_state, 'failed');
  });

  test('Xendit\'s refund callback completes a pending refund (and is not read as a payment)', async () => {
    const id = await refundIntent('processing', { ref: 'rfd-cb' });
    const body = JSON.stringify({ event: 'refund.succeeded', data: { id: 'rfd-cb', payment_request_id: 'pr-1', reference_id: 'whatever', status: 'SUCCEEDED', amount: 20000 } });
    const res = await handleNotification(hook.c, body, { 'x-callback-token': XCB }, `/pay/notify/${hook.c}`);
    assert.equal(res.status, 200);
    assert.equal(await lastOutcome(ids.int_c!), 'refund_completed');
    assert.equal((await one<{ refund_state: string }>(`SELECT refund_state FROM payment_intent WHERE id = $1`, [id]))?.refund_state, 'refunded');
  });
});

dbDescribe('E — the post-pay limit and balance cover all the driver\'s sessions at once', () => {
  const resolved = (): Resolved => ({ kind: 'payments', provider: 'mock', settings: { linkWallets: true, walletPostpay: true, postpayLimitIdr: 200_000 }, secrets: {}, integrationId: null, orgId: ids.org_a!, source: 'console', webhookKey: null });
  // As checkout does: the payment is recorded (pending) as startPayment prepares it.
  const record = (amountIdr: number) => async (p: PreparedPayment) => {
    await query(`INSERT INTO payment_intent (org_id, provider, provider_ref, method, mode, state, amount_authorised_idr, driver_card_id, channel) VALUES ($1, 'mock', $2, $3, $4, 'pending', $5, $6, $7)`,
      [ids.org_a, p.providerRef, p.method, p.mode, amountIdr, p.savedCardId, p.channel]);
  };
  const start = (provider: MockPaymentProvider, amountIdr: number, r = resolved()) => startPayment({ provider, resolved: r }, {
    referenceId: `charge:${randomUUID()}`, amountIdr, returnUrl: 'x', appDriverId: ids.driver2!, walletId: ids.mockWallet!, allowHold: true, prepare: record(amountIdr),
  });

  test('two post-pay checkouts at once under a Rp 200,000 limit, Rp 120,000 each: one post-pay, the other charged up front', async () => {
    await query(`DELETE FROM payment_intent WHERE driver_card_id = $1`, [ids.mockWallet]);
    const prov = new MockPaymentProvider();
    const modes = (await Promise.all([start(prov, 120_000), start(prov, 120_000)])).map((s) => s.mode).sort();
    assert.deepEqual(modes, ['postpay', 'prepurchase']);
  });

  test('a held post-pay session counts against the limit and the balance', async () => {
    await query(`DELETE FROM payment_intent WHERE driver_card_id = $1`, [ids.mockWallet]);
    const heldId = (await one<{ id: string }>(`INSERT INTO payment_intent (org_id, provider, method, mode, state, amount_authorised_idr, hold_state, driver_card_id, channel)
      VALUES ($1, 'mock', 'ewallet', 'postpay', 'authorised', 150000, 'held', $2, 'GOPAY') RETURNING id`, [ids.org_a, ids.mockWallet]))!.id;
    const prov = new MockPaymentProvider();
    assert.equal((await start(prov, 100_000)).mode, 'prepurchase', '150,000 held + 100,000 is over the limit');
    assert.equal((await start(prov, 50_000)).mode, 'postpay', '150,000 + 50,000 fits');
    // With a balance of Rp 220,000: 150,000 + 50,000 held now, so another 30,000 does not fit the balance.
    (prov as any).walletBalance = async () => 220_000;
    const r = resolved(); (r.settings as any).postpayLimitIdr = 1_000_000;
    await assert.rejects(start(prov, 30_000, r), /kurang dari batas yang dipilih ditambah/);
    // A session held on ANOTHER e-wallet counts against the limit, not against this e-wallet's balance.
    await query(`UPDATE payment_intent SET channel = 'OVO' WHERE id = $1`, [heldId]);
    assert.equal((await start(prov, 30_000, r)).mode, 'postpay');
  });
});
