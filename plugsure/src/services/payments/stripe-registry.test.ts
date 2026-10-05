import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { one, pool, query } from '../../db/pool.js';
import { databaseTestLock } from '../../db/test-lock.js';
import { seal } from '../secrets.js';
import { bus } from '../events.js';
import { availableMethods, handleNotification, MethodUnavailable, paymentsFor, startPayment, sandboxProvider } from './registry.js';
import { attemptHold, settleHold } from './holds.js';
import { markRefundDue, processRefund } from '../refunds.js';
import { invalidate } from '../../integrations/store.js';
import { FakeStripe } from '../../../tools/testing/fake-stripe.js';

/**
 * Stripe through the registry, database-backed (WP3): webhooks verified, de-duplicated by event id (a replay is answered
 * 2xx and not applied again) and bound to the account and organisation that took the payment; an SGD hold authorised
 * for less than asked released with a critical alert in S$ (the v1.5.1 underpayment rule); money in another currency
 * never booked; unknown event types acknowledged; holds captured and released through the hold worker; refunds through
 * the refund machinery with refund.updated completing them; the minimum amounts; Indonesian methods unchanged.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/payments/stripe-registry.test.ts
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[stripe-registry.test] SKIPPING database-backed Stripe suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SK = 'sk_test_51RegistryFake', WH = 'whsec_registryTest01', WH_B = 'whsec_registryTestB';
const SLUG = { a: 'stripe-reg-a', b: 'stripe-reg-b' };
const ids: Record<string, string> = {};
const hook = { a: `stripeA${randomBytes(10).toString('hex')}`, b: `stripeB${randomBytes(10).toString('hex')}`, my: `stripeM${randomBytes(10).toString('hex')}` };
const alerts: Array<{ kind: string; message: string; targetId?: string }> = [];
bus.on('alert.raised', (e: any) => { alerts.push({ kind: e.kind, message: e.message, targetId: e.targetId }); });
let sg: FakeStripe, sgB: FakeStripe, my: FakeStripe;

async function cleanup(): Promise<void> {
  const orgs = (await query(`SELECT id FROM organisation WHERE slug = ANY($1::text[])`, [Object.values(SLUG)])).rows.map((r: any) => r.id);
  if (!orgs.length) return;
  await query(`DELETE FROM integration_event WHERE org_id = ANY($1::uuid[]) OR integration_id IN (SELECT id FROM integration WHERE org_id = ANY($1::uuid[]))`, [orgs]);
  await query(`DELETE FROM payment_webhook_event WHERE integration_id IN (SELECT id FROM integration WHERE org_id = ANY($1::uuid[]))`, [orgs]);
  await query(`DELETE FROM driver_card WHERE integration_id IN (SELECT id FROM integration WHERE org_id = ANY($1::uuid[]))`, [orgs]);
  await query(`DELETE FROM driver_charge WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM payment_intent WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM app_driver WHERE phone LIKE '+6590000%'`);
  await query(`DELETE FROM integration WHERE org_id = ANY($1::uuid[])`, [orgs]);
}

const notify = (key: string, body: string, sig?: string, fake = sg) => handleNotification(key, body, { 'stripe-signature': sig ?? fake.sign(body) }, `/pay/notify/${key}`);
const lastOutcome = async (integrationId: string) =>
  (await one<{ outcome: string }>(`SELECT outcome FROM integration_event WHERE integration_id = $1 AND action = 'notification' ORDER BY id DESC LIMIT 1`, [integrationId]))?.outcome;
const intentRow = (id: string) => one<any>(`SELECT * FROM payment_intent WHERE id = $1`, [id]);

/** A payment PlugSure recorded and Stripe created (as checkout does: record, then ask). */
async function stripePayment(o: { channel: 'CARD' | 'PAYNOW' | 'FPX' | 'GRABPAY'; amountMinor: number; preauth?: boolean; org?: 'a' | 'b'; currency?: 'SGD' | 'MYR'; saveCard?: boolean; driver?: string }) {
  const org = o.org ?? 'a';
  const currency = o.currency ?? 'SGD';
  const intentId = randomUUID();
  const acq = await paymentsFor(ids[`org_${org}`]!, currency === 'MYR' ? 'MY' : 'SG');
  await query(
    `INSERT INTO payment_intent (id, org_id, provider, method, mode, state, amount_authorised_minor, integration_id, channel, currency, expires_at)
     VALUES ($1, $2, 'stripe', 'card', 'prepurchase', 'pending', $3, $4, $5, $6, now() + interval '30 minutes')`,
    [intentId, ids[`org_${org}`], o.amountMinor, acq.resolved.integrationId, o.channel, currency]);
  const s = await startPayment(acq, {
    channel: o.channel, referenceId: `charge:${intentId}`, amountMinor: o.amountMinor, returnUrl: 'https://csms.example/app/paid.html', allowHold: o.preauth === true,
    currency, appDriverId: o.driver ?? null, saveCard: o.saveCard === true,
    prepare: (p) => query(`UPDATE payment_intent SET provider_ref = $2, mode = $3, method = $4, save_card = $5 WHERE id = $1`, [intentId, p.providerRef, p.mode, p.method, p.saveCard]).then(() => undefined),
  });
  await query(`UPDATE payment_intent SET provider_payment_id = $2 WHERE id = $1`, [intentId, s.providerPaymentId]);
  return { intentId, s };
}

if (DB_OK) {
  before(async () => {
    sg = await new FakeStripe({ secretKey: SK, webhookSecret: WH, country: 'SG' }).start();
    sgB = await new FakeStripe({ secretKey: SK, webhookSecret: WH_B, country: 'SG' }).start();
    my = await new FakeStripe({ secretKey: SK, webhookSecret: WH, country: 'MY' }).start();
    for (const f of [sg, sgB, my]) f.behaviour.deliver = false;
    await cleanup();
    for (const k of ['a', 'b'] as const) {
      ids[`org_${k}`] = (await one<{ id: string }>(
        `INSERT INTO organisation (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [`Stripe reg ${k}`, SLUG[k]]))!.id;
    }
    const integ = (org: string, cc: string, url: string, wh: string, key: string) => one<{ id: string }>(
      `INSERT INTO integration (org_id, kind, provider, settings, secrets_sealed, webhook_key, country_code)
       VALUES ($1, 'payments', 'stripe', $2, $3, $4, $5) RETURNING id`,
      [org, JSON.stringify({ baseUrl: url, publishableKey: 'pk_test_51RegistryFake', methods: cc === 'SG' ? ['CARD', 'PAYNOW', 'GRABPAY'] : ['CARD', 'FPX', 'GRABPAY'], cardHolds: true, saveCards: true }),
        seal(JSON.stringify({ secretKey: SK, webhookSecret: wh })), key, cc]);
    ids.int_a = (await integ(ids.org_a!, 'SG', sg.url, WH, hook.a))!.id;
    ids.int_b = (await integ(ids.org_b!, 'SG', sgB.url, WH_B, hook.b))!.id;
    ids.int_my = (await integ(ids.org_a!, 'MY', my.url, WH, hook.my))!.id;
    ids.driver = (await one<{ id: string }>(`INSERT INTO app_driver (phone) VALUES ('+6590000101') RETURNING id`))!.id;
    invalidate();
  });
  after(async () => {
    await cleanup();
    await sg?.stop(); await sgB?.stop(); await my?.stop();
    await pool.end();
  });
}

dbDescribe('Stripe webhooks through the registry', () => {
  test('a card hold: authorised by its webhook; the same event again (a replay) is answered 200 and not applied twice', async () => {
    const { intentId, s } = await stripePayment({ channel: 'CARD', amountMinor: 3000, preauth: true });
    assert.equal(s.mode, 'preauth');
    sg.confirmCard(s.providerPaymentId!);
    const ev = sg.lastEvent('payment_intent.amount_capturable_updated', s.providerPaymentId!)!;
    const r1 = await notify(hook.a, ev.body);
    assert.equal(r1.status, 200);
    assert.equal(await lastOutcome(ids.int_a!), 'authorised');
    const i = await intentRow(intentId);
    assert.deepEqual([i.state, i.hold_state, i.provider_payment_id], ['authorised', 'held', s.providerPaymentId]);
    const r2 = await notify(hook.a, ev.body);
    assert.equal(r2.status, 200);
    assert.equal(await lastOutcome(ids.int_a!), 'duplicate_event');
    assert.ok(await one(`SELECT 1 FROM payment_webhook_event WHERE integration_id = $1 AND event_id = $2`, [ids.int_a, JSON.parse(ev.body).id]));
  });

  test('bad signatures: another secret, a tampered body, a stale timestamp — 400, nothing applied, nothing recorded', async () => {
    const { intentId, s } = await stripePayment({ channel: 'CARD', amountMinor: 3000, preauth: true });
    sg.confirmCard(s.providerPaymentId!);
    const ev = sg.lastEvent('payment_intent.amount_capturable_updated', s.providerPaymentId!)!;
    assert.equal((await notify(hook.a, ev.body, sg.sign(ev.body, undefined, 'whsec_attacker'))).status, 400);
    assert.equal((await notify(hook.a, ev.body.replace('"amount_capturable":3000', '"amount_capturable":2999'), sg.sign(ev.body))).status, 400);
    assert.equal((await notify(hook.a, ev.body, sg.sign(ev.body, Math.floor(Date.now() / 1000) - 600))).status, 400);
    assert.equal((await intentRow(intentId)).state, 'pending');
    assert.equal(await one(`SELECT 1 FROM payment_webhook_event WHERE event_id = $1`, [JSON.parse(ev.body).id]), null);
    assert.equal(await lastOutcome(ids.int_a!), 'rejected');
  });

  test('another operator\'s Stripe account (its own signing secret) cannot settle this payment (wrong_account)', async () => {
    const { intentId, s } = await stripePayment({ channel: 'CARD', amountMinor: 3000, preauth: true });
    sg.confirmCard(s.providerPaymentId!);
    const body = sg.lastEvent('payment_intent.amount_capturable_updated', s.providerPaymentId!)!.body;
    const r = await notify(hook.b, body, sgB.sign(body));
    assert.equal(r.status, 200);
    assert.equal(await lastOutcome(ids.int_b!), 'wrong_account');
    assert.equal((await intentRow(intentId)).state, 'pending');
  });

  test('an SGD hold authorised for LESS than asked: not accepted, released through the hold machinery, one critical alert in S$', async () => {
    const { intentId, s } = await stripePayment({ channel: 'CARD', amountMinor: 3000, preauth: true });
    sg.confirmCard(s.providerPaymentId!, { amount: 2500 });
    const n0 = alerts.length;
    await notify(hook.a, sg.lastEvent('payment_intent.amount_capturable_updated', s.providerPaymentId!)!.body);
    assert.equal(await lastOutcome(ids.int_a!), 'amount_mismatch');
    const i = await intentRow(intentId);
    assert.deepEqual([i.state, i.hold_state], ['pending', 'releasing']);
    const a = alerts.slice(n0).filter((x) => x.kind === 'payment.amount_mismatch');
    assert.equal(a.length, 1);
    assert.match(a[0]!.message, /S\$ 25\.00.*S\$ 30\.00/);
    // The hold worker releases it at Stripe.
    const out = await attemptHold(intentId);
    assert.equal(out.state, 'released', JSON.stringify(out));
    assert.equal(sg.intents.get(s.providerPaymentId!)!.status, 'canceled');
  });

  test('a PayNow payment for less than its price: voided, a full refund of what was taken queued (refunded through Stripe)', async () => {
    const { intentId, s } = await stripePayment({ channel: 'PAYNOW', amountMinor: 2000 });
    assert.equal(s.action, 'qr');
    assert.equal(s.method, 'qr');
    sg.payNow(s.providerPaymentId!, { amount: 1500 });
    await notify(hook.a, sg.lastEvent('payment_intent.succeeded', s.providerPaymentId!)!.body);
    const i = await intentRow(intentId);
    assert.deepEqual([i.state, Number(i.amount_captured_minor), i.refund_state, Number(i.refund_due_minor)], ['voided', 1500, 'due', 1500]);
    const rf = await processRefund(intentId, null);
    assert.equal(rf.state, 'processing', 'PayNow refunds are asynchronous');
    const refund = [...sg.refunds.values()].find((x) => x.payment_intent === s.providerPaymentId)!;
    assert.equal(refund.amount, 1500);
    sg.settleRefund(refund.id, 'succeeded');
    const r = await notify(hook.a, sg.lastEvent('refund.updated', s.providerPaymentId!)!.body);
    assert.equal(r.status, 200);
    assert.equal(await lastOutcome(ids.int_a!), 'refund_completed');
    assert.equal((await intentRow(intentId)).refund_state, 'refunded');
  });

  test('paid in ANOTHER currency than asked: never booked (voided, no automatic refund), critical alert', async () => {
    const { intentId, s } = await stripePayment({ channel: 'GRABPAY', amountMinor: 2000 });
    sg.completeRedirect(s.providerPaymentId!, { currency: 'myr' });
    const n0 = alerts.length;
    await notify(hook.a, sg.lastEvent('payment_intent.succeeded', s.providerPaymentId!)!.body);
    assert.equal(await lastOutcome(ids.int_a!), 'currency_mismatch');
    const i = await intentRow(intentId);
    assert.deepEqual([i.state, i.amount_captured_minor, i.refund_state], ['voided', null, null]);
    assert.ok(alerts.slice(n0).some((x) => x.kind === 'payment.amount_mismatch' && /MYR/.test(x.message) && /SGD/.test(x.message)));
  });

  test('events PlugSure has no use for (charge.succeeded, charge.refunded, a PaymentIntent it did not create) are answered 200 and logged as ignored', async () => {
    const body = sg.emit('charge.refunded', { id: 'ch_1', object: 'charge' });
    assert.equal((await notify(hook.a, body)).status, 200);
    assert.equal(await lastOutcome(ids.int_a!), 'ignored');
    const foreign = sg.emit('payment_intent.succeeded', { id: 'pi_dash', object: 'payment_intent', currency: 'sgd', amount_received: 100, metadata: {} });
    assert.equal((await notify(hook.a, foreign)).status, 200);
    assert.equal(await lastOutcome(ids.int_a!), 'ignored');
  });

  test('hold → settle → the worker captures the actual amount at Stripe; Stripe\'s succeeded event confirms it', async () => {
    const { intentId, s } = await stripePayment({ channel: 'CARD', amountMinor: 3000, preauth: true });
    sg.confirmCard(s.providerPaymentId!);
    await notify(hook.a, sg.lastEvent('payment_intent.amount_capturable_updated', s.providerPaymentId!)!.body);
    await settleHold(intentId, 1234);
    let i = await intentRow(intentId);
    for (let k = 0; k < 40 && i.hold_state !== 'captured'; k++) { await new Promise((r) => setTimeout(r, 100)); i = await intentRow(intentId); }
    assert.deepEqual([i.state, i.hold_state, Number(i.amount_captured_minor)], ['captured', 'captured', 1234]);
    assert.equal(sg.intents.get(s.providerPaymentId!)!.amount_received, 1234);
    await notify(hook.a, sg.lastEvent('payment_intent.succeeded', s.providerPaymentId!)!.body);
    assert.equal(await lastOutcome(ids.int_a!), 'capture_confirmed');
  });

  test('an authorisation Stripe cancels automatically (expired) ends the hold', async () => {
    const { intentId, s } = await stripePayment({ channel: 'CARD', amountMinor: 3000, preauth: true });
    sg.confirmCard(s.providerPaymentId!);
    await notify(hook.a, sg.lastEvent('payment_intent.amount_capturable_updated', s.providerPaymentId!)!.body);
    sg.expireAuthorisation(s.providerPaymentId!);
    await notify(hook.a, sg.lastEvent('payment_intent.canceled', s.providerPaymentId!)!.body);
    const i = await intentRow(intentId);
    assert.equal(await lastOutcome(ids.int_a!), 'hold_released', 'nothing was owed yet: released, nothing to collect');
    assert.deepEqual([i.state, i.hold_state], ['voided', 'released']);
  });

  test('a declined attempt leaves the payment open; the next card authorises it', async () => {
    const { intentId, s } = await stripePayment({ channel: 'CARD', amountMinor: 3000, preauth: true });
    sg.failAttempt(s.providerPaymentId!);
    await notify(hook.a, sg.lastEvent('payment_intent.payment_failed', s.providerPaymentId!)!.body);
    assert.equal((await intentRow(intentId)).state, 'pending');
    sg.confirmCard(s.providerPaymentId!);
    await notify(hook.a, sg.lastEvent('payment_intent.amount_capturable_updated', s.providerPaymentId!)!.body);
    assert.equal((await intentRow(intentId)).state, 'authorised');
  });

});

dbDescribe('Stripe through startPayment: amounts, methods, currencies', () => {
  test('below Stripe\'s minimum (S$0.50) or FPX\'s band: refused before anything is sent', async () => {
    const acq = await paymentsFor(ids.org_a!, 'SG');
    const n = sg.requests.length;
    await assert.rejects(startPayment(acq, { channel: 'CARD', referenceId: 'charge:min', amountMinor: 49, returnUrl: 'https://x', currency: 'SGD' }),
      (e: unknown) => e instanceof MethodUnavailable && e.code === 'amount_below_minimum' && /S\$ 0\.50/.test(e.message));
    assert.equal(sg.requests.length, n);
    const macq = await paymentsFor(ids.org_a!, 'MY');
    await assert.rejects(startPayment(macq, { channel: 'FPX', referenceId: 'charge:fpx-max', amountMinor: 3_000_001, returnUrl: 'https://x', currency: 'MYR' }),
      (e: unknown) => e instanceof MethodUnavailable && e.code === 'amount_above_maximum');
    await assert.rejects(startPayment(macq, { channel: 'CARD', referenceId: 'charge:my-min', amountMinor: 199, returnUrl: 'https://x', currency: 'MYR' }), /RM 2\.00/);
  });

  test('the wrong currency for the account is refused (PaymentsUnavailable), a method of another country is not offered', async () => {
    const acq = await paymentsFor(ids.org_a!, 'SG');
    await assert.rejects(startPayment(acq, { channel: 'CARD', referenceId: 'charge:cur', amountMinor: 1000, returnUrl: 'https://x', currency: 'MYR' }), /cannot take MYR/);
    await assert.rejects(startPayment(acq, { channel: 'FPX', referenceId: 'charge:fpx-sg', amountMinor: 1000, returnUrl: 'https://x', currency: 'SGD' }), MethodUnavailable);
    assert.deepEqual(availableMethods(acq.resolved, acq.provider, 'SGD'), ['CARD', 'PAYNOW', 'GRABPAY']);
  });

  test('the sandbox in Indonesia offers exactly the v1.6 methods (the new channels only in their currencies)', () => {
    const r = { kind: 'payments' as const, provider: 'mock', settings: {}, secrets: {}, integrationId: null, orgId: null, source: 'default' as const, webhookKey: null };
    assert.deepEqual(availableMethods(r, sandboxProvider()), ['QRIS', 'GOPAY', 'SHOPEEPAY', 'OVO', 'DANA', 'LINKAJA', 'CARD']);
    assert.deepEqual(availableMethods(r, sandboxProvider(), 'SGD'), ['CARD', 'PAYNOW', 'GRABPAY']);
    assert.deepEqual(availableMethods(r, sandboxProvider(), 'MYR'), ['CARD', 'FPX', 'GRABPAY']);
  });

  test('a refund of unused balance goes through the Stripe Refunds API in the currency of the payment (cents)', async () => {
    const { intentId, s } = await stripePayment({ channel: 'CARD', amountMinor: 3000 });
    sg.confirmCard(s.providerPaymentId!);
    await notify(hook.a, sg.lastEvent('payment_intent.succeeded', s.providerPaymentId!)!.body);
    assert.ok(await markRefundDue(intentId, 1766, 'unused'));
    const rf = await processRefund(intentId, null);
    assert.equal(rf.state, 'refunded');
    const sent = [...sg.refunds.values()].find((x) => x.payment_intent === s.providerPaymentId)!;
    assert.deepEqual([sent.amount, sent.currency], [1766, 'sgd']);
  });
});
