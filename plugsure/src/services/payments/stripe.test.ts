import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { FakeStripe } from '../../../tools/testing/fake-stripe.js';
import { StripeProvider, StripeModeRefused, keyMode, parseStripeSignature, stripeForm, stripeSignatureHeader, STRIPE_API_VERSION } from './stripe.js';

/**
 * The Stripe adapter against a local fake Stripe (tools/testing/fake-stripe.ts), no database: request bodies (minor
 * units, lower-case currency, capture_method, Idempotency-Key, Stripe-Version), the card hold → partial capture / cancel,
 * saved cards and 3-D Secure, PayNow's QR, GrabPay's and FPX's redirect, refunds (sync and async, looked up by key), the
 * webhook signature (valid, wrong, stale, several v1, rolled secret, livemode) and each event's mapping, and the
 * test/live guard. Stripe's facts are cited in deploy/STRIPE.md.
 */

const SK = 'sk_test_51FakeUnitKey', WH = 'whsec_unitTestSecret01';
let sg: FakeStripe, my: FakeStripe;
before(async () => {
  sg = await new FakeStripe({ secretKey: SK, webhookSecret: WH, country: 'SG' }).start();
  my = await new FakeStripe({ secretKey: SK, webhookSecret: WH, country: 'MY' }).start();
});
after(async () => { await sg.stop(); await my.stop(); });
const p = (fake: FakeStripe, extra: Partial<ConstructorParameters<typeof StripeProvider>[0]> = {}) =>
  new StripeProvider({ secretKey: SK, webhookSecret: WH, publishableKey: 'pk_test_51FakeUnitKey', country: fake === sg ? 'SG' : 'MY', baseUrl: fake.url, publicBaseUrl: 'https://csms.example', ...extra });
const hdr = (body: string, opts: { t?: number; secret?: string } = {}) => ({ 'stripe-signature': stripeSignatureHeader(body, opts.secret ?? WH, opts.t) });
const lastPost = (fake: FakeStripe, re: RegExp) => [...fake.requests].reverse().find((r) => r.method === 'POST' && re.test(r.path))!;

describe('requests', () => {
  test('form encoding: nested objects and arrays in Stripe\'s bracket notation; null/undefined left out', () => {
    assert.equal(stripeForm({ a: 1, b: { c: 'x', d: [1, 2] }, e: null, f: undefined, g: true }).toString(), 'a=1&b%5Bc%5D=x&b%5Bd%5D%5B0%5D=1&b%5Bd%5D%5B1%5D=2&g=true');
  });

  test('a SG card hold: SGD in cents, lower-case currency, manual capture, card only, metadata reference, pinned version, idempotency key from the reference', async () => {
    const c = await p(sg).createCheckout({ referenceId: 'charge:hold-1', amountMinor: 3000, channel: 'CARD', returnUrl: '/app/paid.html', preauth: true, currency: 'SGD' });
    const r = lastPost(sg, /^\/v1\/payment_intents$/);
    assert.equal(r.body.amount, '3000');
    assert.equal(r.body.currency, 'sgd');
    assert.equal(r.body.capture_method, 'manual');
    assert.deepEqual(r.body.payment_method_types, ['card']);
    assert.equal(r.body.metadata.plugsure_ref, c.providerRef);
    assert.equal(r.body.metadata.plugsure_return, 'https://csms.example/app/paid.html', 'Stripe needs an absolute return URL');
    assert.equal(r.headers['stripe-version'], STRIPE_API_VERSION);
    assert.equal(r.headers['idempotency-key'], `pi-${c.providerRef}`);
    assert.match(c.providerRef, /^ps_[0-9a-f]{32}$/);
    assert.equal(c.providerRef, p(sg).orderRef('charge:hold-1'), 'derived before Stripe is asked');
    assert.equal(c.action, 'redirect');
    assert.equal(c.checkoutUrl, `https://csms.example/pay/stripe/${c.providerRef}/${c.providerPaymentId}`, 'the Payment Element page, not Stripe Checkout');
    assert.equal(r.body.receipt_email, undefined, 'nothing personal is sent');
  });

  test('the same reference again (a lost answer) returns the same PaymentIntent: Stripe replays the idempotent answer', async () => {
    const a = await p(sg).createCheckout({ referenceId: 'charge:replay', amountMinor: 1000, channel: 'CARD', returnUrl: 'https://x/r', currency: 'SGD' });
    const b = await p(sg).createCheckout({ referenceId: 'charge:replay', amountMinor: 1000, channel: 'CARD', returnUrl: 'https://x/r', currency: 'SGD' });
    assert.equal(a.providerPaymentId, b.providerPaymentId);
  });

  test('a currency the account does not take is refused before Stripe is asked; MYR on a MY account in sen', async () => {
    const before = sg.requests.length;
    await assert.rejects(p(sg).createCheckout({ referenceId: 'charge:cur', amountMinor: 1000, channel: 'CARD', returnUrl: 'https://x', currency: 'MYR' }), /takes SGD, not MYR/);
    assert.equal(sg.requests.length, before);
    await p(my).createCheckout({ referenceId: 'charge:my', amountMinor: 1234, channel: 'CARD', returnUrl: 'https://x', currency: 'MYR' });
    assert.equal(lastPost(my, /^\/v1\/payment_intents$/).body.amount, '1234');
    assert.deepEqual(p(sg).currencies(), ['SGD']);
    assert.deepEqual(p(my).currencies(), ['MYR']);
  });

  test('channels per country; amount limits (SGD 0.50, MYR 2.00, FPX RM 2–30,000, GrabPay none)', () => {
    assert.deepEqual(p(sg).channels(), ['CARD', 'PAYNOW', 'GRABPAY']);
    assert.deepEqual(p(my).channels(), ['CARD', 'FPX', 'GRABPAY']);
    assert.equal(p(sg).amountLimits('CARD', 'SGD').minMinor, 50);
    assert.equal(p(sg).amountLimits('PAYNOW', 'SGD').minMinor, 50);
    assert.equal(p(my).amountLimits('CARD', 'MYR').minMinor, 200);
    assert.deepEqual(p(my).amountLimits('FPX', 'MYR'), { minMinor: 200, maxMinor: 3_000_000 });
    assert.equal(p(my).amountLimits('GRABPAY', 'MYR').minMinor, 1);
  });

  test('PayNow: confirmed server-side, the SGQR payload as the QR, expiry from Stripe (1 h)', async () => {
    const c = await p(sg).createCheckout({ referenceId: 'charge:paynow', amountMinor: 2000, channel: 'PAYNOW', returnUrl: 'https://x', currency: 'SGD' });
    const r = lastPost(sg, /^\/v1\/payment_intents$/);
    assert.deepEqual([r.body.payment_method_types, r.body.payment_method_data, r.body.confirm], [['paynow'], { type: 'paynow' }, 'true']);
    assert.equal(c.action, 'qr');
    assert.match(c.qrString!, /^000201.*5802SG/);
    const left = new Date(c.expiresAt).getTime() - Date.now();
    assert.ok(left > 3500_000 && left <= 3600_000, `${left}`);
    assert.equal(r.body.capture_method, undefined, 'PayNow has no manual capture');
  });

  test('GrabPay: the redirect URL from next_action; FPX: PlugSure\'s page (the bank list); both automatic capture', async () => {
    const g = await p(my).createCheckout({ referenceId: 'charge:grab', amountMinor: 1500, channel: 'GRABPAY', returnUrl: 'https://app/r', currency: 'MYR' });
    const gr = lastPost(my, /^\/v1\/payment_intents$/);
    assert.deepEqual([gr.body.payment_method_data, gr.body.return_url], [{ type: 'grabpay' }, 'https://app/r']);
    assert.match(g.checkoutUrl!, /\/grabpay\/pi_/);
    const f = await p(my).createCheckout({ referenceId: 'charge:fpx', amountMinor: 5000, channel: 'FPX', returnUrl: 'https://app/r', currency: 'MYR' });
    const fr = lastPost(my, /^\/v1\/payment_intents$/);
    assert.deepEqual(fr.body.payment_method_types, ['fpx']);
    assert.equal(fr.body.confirm, undefined, 'FPX needs the driver\'s bank choice: confirmed on the page');
    assert.match(f.checkoutUrl!, /\/pay\/stripe\/ps_[0-9a-f]{32}\/pi_/);
    await assert.rejects(p(sg).createCheckout({ referenceId: 'x', amountMinor: 5000, channel: 'FPX', returnUrl: 'https://x', currency: 'SGD' }), /does not offer FPX/);
  });
});

describe('holds and saved cards', () => {
  test('hold → partial capture of the actual amount (the rest released by Stripe); a repeated capture is answered from the PaymentIntent', async () => {
    const s = p(sg);
    const c = await s.createCheckout({ referenceId: 'charge:cap', amountMinor: 3000, channel: 'CARD', returnUrl: 'https://x', preauth: true, currency: 'SGD' });
    sg.confirmCard(c.providerPaymentId!);
    const r = await s.captureHold({ providerRef: c.providerRef, providerPaymentId: c.providerPaymentId, amountMinor: 1234, idempotencyKey: 'hold-capture-1' });
    assert.ok(r.ok, JSON.stringify(r));
    const cap = lastPost(sg, /\/capture$/);
    assert.equal(cap.body.amount_to_capture, '1234');
    assert.match(String(cap.headers['idempotency-key']), /^hold-capture-1:/);
    assert.equal(sg.intents.get(c.providerPaymentId!)!.amount_received, 1234);
    const again = await s.captureHold({ providerRef: c.providerRef, providerPaymentId: c.providerPaymentId, amountMinor: 1234, idempotencyKey: 'hold-capture-1' });
    assert.ok(again.ok, 'already captured: ok, nothing captured twice');
    assert.equal(sg.posts(/\/capture$/).filter((x) => x.path.includes(c.providerPaymentId!)).length, 1);
  });

  test('a capture failing (500) is retried with a fresh key and succeeds; an expired authorisation is reported expired', async () => {
    const s = p(sg);
    const c = await s.createCheckout({ referenceId: 'charge:cap500', amountMinor: 3000, channel: 'CARD', returnUrl: 'https://x', preauth: true, currency: 'SGD' });
    sg.confirmCard(c.providerPaymentId!);
    sg.behaviour.captureFailures = 1;
    const a1 = await s.captureHold({ providerRef: c.providerRef, providerPaymentId: c.providerPaymentId, amountMinor: 900, idempotencyKey: 'hold-capture-500' });
    assert.equal(a1.ok, false);
    const a2 = await s.captureHold({ providerRef: c.providerRef, providerPaymentId: c.providerPaymentId, amountMinor: 900, idempotencyKey: 'hold-capture-500' });
    assert.ok(a2.ok, 'Stripe would replay a 500 for the same key; each attempt has its own');
    const e = await s.createCheckout({ referenceId: 'charge:exp', amountMinor: 3000, channel: 'CARD', returnUrl: 'https://x', preauth: true, currency: 'SGD' });
    sg.confirmCard(e.providerPaymentId!);
    sg.expireAuthorisation(e.providerPaymentId!);
    const x = await s.captureHold({ providerRef: e.providerRef, providerPaymentId: e.providerPaymentId, amountMinor: 900, idempotencyKey: 'k' });
    assert.deepEqual([x.ok, x.expired], [false, true]);
  });

  test('release: cancel; already cancelled (or expired) is ok; a captured payment is not "released"', async () => {
    const s = p(sg);
    const c = await s.createCheckout({ referenceId: 'charge:rel', amountMinor: 3000, channel: 'CARD', returnUrl: 'https://x', preauth: true, currency: 'SGD' });
    sg.confirmCard(c.providerPaymentId!);
    assert.ok((await s.releaseHold({ providerRef: c.providerRef, providerPaymentId: c.providerPaymentId, idempotencyKey: 'hold-release-1' })).ok);
    assert.equal(sg.intents.get(c.providerPaymentId!)!.status, 'canceled');
    assert.ok((await s.releaseHold({ providerRef: c.providerRef, providerPaymentId: c.providerPaymentId, idempotencyKey: 'hold-release-1' })).ok);
    assert.ok((await s.releaseHold({ providerRef: 'x', providerPaymentId: null, idempotencyKey: 'k' })).ok, 'never created: nothing held');
    const d = await s.createCheckout({ referenceId: 'charge:rel2', amountMinor: 3000, channel: 'CARD', returnUrl: 'https://x', preauth: false, currency: 'SGD' });
    sg.confirmCard(d.providerPaymentId!);
    assert.equal((await s.releaseHold({ providerRef: d.providerRef, providerPaymentId: d.providerPaymentId, idempotencyKey: 'k2' })).ok, false);
  });

  test('saving a card: a Customer (driver id in metadata only) and setup_future_usage; paying with it later as a hold; 3-D Secure; a detached card has ended', async () => {
    const s = p(my);
    const c = await s.createCheckout({ referenceId: 'charge:save', amountMinor: 5000, channel: 'CARD', returnUrl: 'https://x', preauth: true, saveCard: true, customerId: 'drv-1', currency: 'MYR' });
    const cus = lastPost(my, /^\/v1\/customers$/);
    assert.deepEqual(cus.body.metadata, { plugsure_driver: 'drv-1' });
    assert.equal(cus.body.email, undefined);
    const pi = my.intents.get(c.providerPaymentId!)!;
    assert.equal(pi.setup_future_usage, 'off_session');
    my.confirmCard(pi.id, { brand: 'mastercard', last4: '4444' });
    const ev = JSON.parse(my.lastEvent('payment_intent.amount_capturable_updated', pi.id)!.body);
    const n = s.parseNotification(JSON.stringify(ev), hdr(JSON.stringify(ev)))!;
    assert.equal(n.authorised, true);
    assert.equal(n.savedCard!.token, `${pi.customer}/${pi.payment_method}`);
    const details = await s.savedCardDetails(n.savedCard!.token);
    assert.deepEqual([details?.brand, details?.last4], ['MASTERCARD', '4444']);

    const held = await s.chargeSavedCard({ referenceId: 'charge:saved-1', amountMinor: 4000, token: n.savedCard!.token, preauth: true, returnUrl: '/app/paid.html', customerId: 'drv-1', currency: 'MYR' });
    assert.equal(held.status, 'authorised');
    const sr = lastPost(my, /^\/v1\/payment_intents$/);
    assert.deepEqual([sr.body.customer, sr.body.payment_method, sr.body.confirm, sr.body.capture_method, sr.body.return_url], [pi.customer, pi.payment_method, 'true', 'manual', 'https://csms.example/app/paid.html']);

    my.behaviour.requires3ds = true;
    const tds = await s.chargeSavedCard({ referenceId: 'charge:saved-3ds', amountMinor: 4000, token: n.savedCard!.token, preauth: false, returnUrl: 'https://x', customerId: 'drv-1', currency: 'MYR' });
    my.behaviour.requires3ds = false;
    assert.equal(tds.status, 'pending');
    assert.match(tds.checkoutUrl!, /\/3ds\/pi_/);

    await s.deleteSavedCard(n.savedCard!.token);
    const gone = await s.chargeSavedCard({ referenceId: 'charge:saved-gone', amountMinor: 4000, token: n.savedCard!.token, preauth: true, returnUrl: 'https://x', customerId: 'drv-1', currency: 'MYR' });
    assert.deepEqual([gone.status, gone.linkEnded], ['failed', true]);
    const bad = await s.chargeSavedCard({ referenceId: 'charge:saved-bad', amountMinor: 4000, token: 'not-a-token', preauth: true, returnUrl: 'https://x', customerId: 'drv-1', currency: 'MYR' });
    assert.equal(bad.linkEnded, true);
  });

  test('a declined saved card: failed with the decline, not ended', async () => {
    const s = p(sg);
    const c = await s.createCheckout({ referenceId: 'charge:dec', amountMinor: 3000, channel: 'CARD', returnUrl: 'https://x', saveCard: true, customerId: 'drv-2', currency: 'SGD' });
    const pi = sg.confirmCard(c.providerPaymentId!);
    sg.declineCard(pi.payment_method);
    const r = await s.chargeSavedCard({ referenceId: 'charge:dec2', amountMinor: 3000, token: `${pi.customer}/${pi.payment_method}`, preauth: false, returnUrl: 'https://x', customerId: 'drv-2', currency: 'SGD' });
    assert.equal(r.status, 'failed');
    assert.match(r.message!, /card_declined\/insufficient_funds/);
    assert.ok(!r.linkEnded);
  });
});

describe('refunds', () => {
  test('a card refund succeeds at once; PayNow is pending until refund.updated; the stable key is sent and the refund found by it', async () => {
    const s = p(sg);
    const c = await s.createCheckout({ referenceId: 'charge:ref', amountMinor: 3000, channel: 'CARD', returnUrl: 'https://x', currency: 'SGD' });
    sg.confirmCard(c.providerPaymentId!);
    const r = await s.refund({ providerRef: c.providerRef, providerPaymentId: c.providerPaymentId, amountMinor: 1766, reason: 'unused', idempotencyKey: 'refund-abc' });
    assert.equal(r.status, 'refunded');
    const rr = lastPost(sg, /^\/v1\/refunds$/);
    assert.deepEqual([rr.body.amount, rr.body.payment_intent, rr.headers['idempotency-key'], rr.body.metadata.plugsure_idem], ['1766', c.providerPaymentId, 'refund-abc', 'refund-abc']);
    const again = await s.refund({ providerRef: c.providerRef, providerPaymentId: c.providerPaymentId, amountMinor: 1766, reason: 'unused', idempotencyKey: 'refund-abc' });
    assert.equal(again.refundRef, r.refundRef, 'a retried refund is the same refund');
    assert.equal([...sg.refunds.values()].filter((x) => x.payment_intent === c.providerPaymentId).length, 1);

    const q = await s.createCheckout({ referenceId: 'charge:pn-ref', amountMinor: 2000, channel: 'PAYNOW', returnUrl: 'https://x', currency: 'SGD' });
    sg.payNow(q.providerPaymentId!);
    const pr = await s.refund({ providerRef: q.providerRef, providerPaymentId: q.providerPaymentId, amountMinor: 800, reason: 'unused', idempotencyKey: 'refund-pn' });
    assert.equal(pr.status, 'pending');
    assert.equal(await s.refundStatus({ providerRef: q.providerRef, providerPaymentId: q.providerPaymentId!, channel: 'PAYNOW', refundRef: null, idempotencyKey: 'refund-pn' }), 'pending', 'found by the key when the answer was lost');
    sg.settleRefund(pr.refundRef, 'succeeded');
    const ev = sg.lastEvent('refund.updated', q.providerPaymentId!)!;
    assert.deepEqual(s.parseRefundEvent(ev.body, hdr(ev.body)), { refundRef: pr.refundRef, status: 'refunded', event: 'refund.updated' });
    assert.equal(await s.refundStatus({ providerRef: q.providerRef, providerPaymentId: q.providerPaymentId!, channel: 'PAYNOW', refundRef: pr.refundRef, idempotencyKey: 'refund-pn' }), 'refunded');
    assert.equal(await s.refundStatus({ providerRef: q.providerRef, providerPaymentId: q.providerPaymentId!, channel: 'PAYNOW', refundRef: null, idempotencyKey: 'refund-none' }), null);
  });

  test('a refund above what was taken is refused by Stripe and reported failed', async () => {
    const s = p(sg);
    const c = await s.createCheckout({ referenceId: 'charge:ref-big', amountMinor: 1000, channel: 'CARD', returnUrl: 'https://x', currency: 'SGD' });
    sg.confirmCard(c.providerPaymentId!);
    const r = await s.refund({ providerRef: c.providerRef, providerPaymentId: c.providerPaymentId, amountMinor: 1001, reason: 'x', idempotencyKey: 'refund-big' });
    assert.equal(r.status, 'failed');
  });
});

describe('webhooks', () => {
  const event = (type: string, object: Record<string, unknown>, livemode = false) => JSON.stringify({ id: `evt_${type.replace(/\W/g, '')}${Math.random().toString(16).slice(2, 8)}`, object: 'event', type, livemode, data: { object } });
  const pi = (o: Record<string, unknown>) => ({ id: 'pi_123', object: 'payment_intent', currency: 'sgd', amount: 3000, amount_received: 0, amount_capturable: 0, metadata: { plugsure_ref: 'ps_abc' }, ...o });

  test('signature: valid, wrong secret, tampered body, stale or future timestamp, several v1 (one valid), v0 ignored, rolled secret', () => {
    const s = p(sg);
    const body = event('payment_intent.succeeded', pi({ status: 'succeeded', amount_received: 3000 }));
    const now = Math.floor(Date.now() / 1000);
    assert.ok(s.verifyWebhook(body, hdr(body)));
    assert.ok(!s.verifyWebhook(body, hdr(body, { secret: 'whsec_other' })));
    assert.ok(!s.verifyWebhook(body.replace('3000', '3001'), hdr(body)));
    assert.ok(!s.verifyWebhook(body, hdr(body, { t: now - 301 })), 'older than 5 minutes');
    assert.ok(!s.verifyWebhook(body, hdr(body, { t: now + 301 })), 'from the future');
    assert.ok(!s.notificationFresh(hdr(body, { t: now - 301 })));
    assert.ok(s.notificationFresh(hdr(body)));
    const good = stripeSignatureHeader(body, WH, now).split(',v1=')[1]!;
    assert.ok(s.verifyWebhook(body, { 'stripe-signature': `t=${now},v1=${'0'.repeat(64)},v1=${good}` }), 'any v1 may match (a rolled secret signs twice)');
    assert.ok(!s.verifyWebhook(body, { 'stripe-signature': `t=${now},v0=${good}` }), 'only v1 counts (no downgrade)');
    assert.ok(!s.verifyWebhook(body, { 'stripe-signature': `t=${now},v1=${good.slice(0, 63)}` }), 'a short signature is not compared');
    assert.ok(!s.verifyWebhook(body, {}));
    const rolled = p(sg, { webhookSecret: `whsec_newSecret ${WH}` });
    assert.ok(rolled.verifyWebhook(body, hdr(body)), 'the old secret still verifies while both are configured');
    assert.ok(rolled.verifyWebhook(body, hdr(body, { secret: 'whsec_newSecret' })));
    assert.deepEqual(parseStripeSignature(`t=12,v1=${'a'.repeat(64)},v1=junk,x=1`), { t: 12, v1: ['a'.repeat(64)] });
  });

  test('livemode must match the key: a test key refuses live events', () => {
    const s = p(sg);
    const body = event('payment_intent.succeeded', pi({ status: 'succeeded', amount_received: 3000 }), true);
    assert.equal(s.parseNotification(body, hdr(body)), null);
    assert.equal(s.eventId(body, hdr(body)), null);
  });

  test('events → notifications: succeeded (amount_received), amount_capturable_updated (authorised), payment_failed (open, or expired PayNow), canceled (automatic = expired)', () => {
    const s = p(sg);
    const parse = (b: string) => s.parseNotification(b, hdr(b));
    const ok = parse(event('payment_intent.succeeded', pi({ status: 'succeeded', amount_received: 1234 })))!;
    assert.deepEqual([ok.providerRef, ok.paid, ok.amountMinor, ok.paymentId, ok.currency], ['ps_abc', true, 1234, 'pi_123', 'SGD']);
    const auth = parse(event('payment_intent.amount_capturable_updated', pi({ status: 'requires_capture', amount_capturable: 3000 })))!;
    assert.deepEqual([auth.authorised, auth.paid, auth.amountMinor], [true, false, 3000]);
    const cleared = parse(event('payment_intent.amount_capturable_updated', pi({ status: 'canceled', amount_capturable: 0 })))!;
    assert.ok(!cleared.authorised && !cleared.paid);
    const declined = parse(event('payment_intent.payment_failed', pi({ status: 'requires_payment_method', last_payment_error: { code: 'card_declined' } })))!;
    assert.equal(declined.status, 'requires_payment_method', 'not a terminal failure: the driver may try another card');
    assert.ok(!/expire|deny|cancel|fail|declin/i.test(declined.status), 'no word the registry reads as an outcome');
    assert.equal(parse(event('payment_intent.payment_failed', pi({ last_payment_error: { code: 'payment_intent_payment_attempt_expired' } })))!.status, 'expired');
    assert.equal(parse(event('payment_intent.canceled', pi({ status: 'canceled', cancellation_reason: 'automatic' })))!.status, 'expired');
    assert.equal(parse(event('payment_intent.canceled', pi({ status: 'canceled', cancellation_reason: 'requested_by_customer' })))!.status, 'canceled');
    assert.equal(parse(event('payment_intent.succeeded', pi({ metadata: {} }))), null, 'a PaymentIntent PlugSure did not create');
    assert.equal(parse(event('charge.refunded', { id: 'ch_1', object: 'charge' })), null);
    const other = event('charge.refunded', { id: 'ch_1', object: 'charge' });
    assert.deepEqual(s.parseOtherEvent(other, hdr(other)), { event: 'charge.refunded' });
    assert.equal(s.parseOtherEvent(other, hdr(other, { secret: 'whsec_x' })), null);
    const rf = event('refund.failed', { id: 're_1', object: 'refund', status: 'failed' });
    assert.deepEqual(s.parseRefundEvent(rf, hdr(rf)), { refundRef: 're_1', status: 'failed', event: 'refund.failed' });
    const myr = parse(event('payment_intent.succeeded', pi({ currency: 'myr', amount_received: 500 })))!;
    assert.equal(myr.currency, 'MYR', 'the currency is reported, for the registry to refuse');
  });

  test('ack: 2xx when verified; 400 otherwise', () => {
    assert.deepEqual(p(sg).notificationAck(true).status, 200);
    assert.deepEqual(p(sg).notificationAck(false).status, 400);
  });
});

describe('test and live mode', () => {
  test('key modes; a test key is refused in production unless allowTestMode; a non-Stripe key always', async () => {
    assert.deepEqual([keyMode('sk_live_x1'), keyMode('rk_test_x1'), keyMode('pk_live_x1'), keyMode('xnd_development_x')], ['live', 'test', 'live', null]);
    const prod = p(sg, { production: true });
    await assert.rejects(prod.createCheckout({ referenceId: 'x', amountMinor: 1000, channel: 'CARD', returnUrl: 'https://x', currency: 'SGD' }), StripeModeRefused);
    assert.equal((await prod.testConnection()).ok, false);
    const staging = p(sg, { production: true, allowTestMode: true });
    assert.ok((await staging.testConnection()).ok);
    await assert.rejects(p(sg, { secretKey: 'nope' }).refund({ providerRef: 'x', providerPaymentId: 'pi_1', amountMinor: 1, reason: 'x', idempotencyKey: 'k' }), StripeModeRefused);
  });

  test('test connection: the account\'s country must be the integration\'s; publishable and secret key of one mode', async () => {
    const ok = await p(sg).testConnection();
    assert.ok(ok.ok && /TEST mode/.test(ok.message) && /account in SG/.test(ok.message), ok.message);
    const wrong = await new StripeProvider({ secretKey: SK, webhookSecret: WH, publishableKey: 'pk_test_1x', country: 'MY', baseUrl: sg.url }).testConnection();
    assert.ok(!wrong.ok && /registered in SG/.test(wrong.message));
    const mixed = await p(sg, { publishableKey: 'pk_live_1x' }).testConnection();
    assert.ok(!mixed.ok && /publishable key/.test(mixed.message));
    const bad = await p(sg, { secretKey: 'sk_test_wrongKey' }).testConnection();
    assert.ok(!bad.ok && /refused/.test(bad.message));
  });

  test('the fake signs like Stripe (HMAC-SHA256 over "t.body")', () => {
    const t = 1700000000;
    assert.equal(sg.sign('{}', t), `t=${t},v1=${createHmac('sha256', WH).update(`${t}.{}`).digest('hex')}`);
  });
});
