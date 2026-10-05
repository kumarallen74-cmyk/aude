import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { MidtransProvider } from './midtrans.js';
import { XenditProvider } from './xendit.js';
import { SnapQrisProvider, minifyJson } from './snap-qris.js';
import { StripeProvider } from './stripe.js';
import { FakeStripe } from '../../../tools/testing/fake-stripe.js';

/**
 * The acquirer adapters (no database): payment references derived from PlugSure's reference (so a request repeated
 * after a lost answer names the same payment, and the reference can be recorded first), Midtrans' status lookup and a
 * capture whose answer was lost, Xendit's callback events (payments only; link and refund events elsewhere), and BI-SNAP
 * notifications (the signature over the body as received, a fresh timestamp, rupiah only).
 */

const seen: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders; body: string }> = [];
const answers = new Map<string, { status: number; body: unknown } | 'drop'>();
let base = '';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0]!;
    seen.push({ method: req.method ?? '', path, headers: req.headers, body });
    const a = answers.get(`${req.method} ${path}`) ?? answers.get(path) ?? { status: 404, body: { status_code: '404', status_message: 'no fake' } };
    if (a === 'drop') { req.socket.destroy(); return; }
    res.writeHead(a.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(a.body));
  });
});
before(async () => { await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r())); base = `http://127.0.0.1:${(server.address() as any).port}`; });
after(() => server.close());
const reset = () => { seen.length = 0; answers.clear(); };

const m = () => new MidtransProvider({ environment: 'sandbox', serverKey: 'SB-Mid-server-IDEM', baseUrl: base });
const x = () => new XenditProvider({ secretKey: 'xnd_development_idem', callbackToken: 'cb-token-idem', baseUrl: base });
const gopayToken = JSON.stringify({ accountId: 'acc-1', token: 'tok-1' });
const enabledAccount = { status: 200, body: { account_status: 'ENABLED', metadata: { payment_options: [{ name: 'GOPAY_WALLET', active: true, token: 'tok-1' }] } } };

describe('references derived from PlugSure\'s reference (B)', () => {
  test('Midtrans: the same reference gives the same order_id, recorded before the charge (orderRef), across QRIS, e-wallets and saved cards', async () => {
    reset();
    answers.set('/v2/pay/account/acc-1', enabledAccount);
    answers.set('POST /v2/charge', { status: 200, body: { status_code: '200', transaction_status: 'settlement', transaction_id: 'tx-1' } });
    const ref = 'postpay:11111111-2222-3333-4444-555555555555:1';
    const a = await m().chargeWallet({ referenceId: ref, amountMinor: 30_000, channel: 'GOPAY', token: gopayToken, returnUrl: 'x', customerId: 'd' });
    const b = await m().chargeWallet({ referenceId: ref, amountMinor: 30_000, channel: 'GOPAY', token: gopayToken, returnUrl: 'x', customerId: 'd' });
    const orders = seen.filter((s) => s.path === '/v2/charge').map((s) => JSON.parse(s.body).transaction_details.order_id);
    assert.equal(a.providerRef, m().orderRef(ref), 'the order id is known before the request');
    assert.deepEqual([b.providerRef, ...orders], [a.providerRef, a.providerRef, a.providerRef], 'a repeated request names the same order (Midtrans refuses it rather than charging twice)');
    assert.match(a.providerRef, /^ps-[a-f0-9]{24}$/);
    assert.notEqual(m().orderRef(`${ref}x`), a.providerRef);
    const c = await m().chargeSavedCard({ referenceId: 'charge:abc', amountMinor: 10_000, token: 't', preauth: false, returnUrl: 'x', customerId: 'd' });
    assert.equal(c.providerRef, m().orderRef('charge:abc'));
  });

  test('Xendit: reference_id and the idempotency key are derived from the reference (e-wallet payment requests and GoPay v3)', async () => {
    reset();
    answers.set('POST /payment_requests', { status: 200, body: { id: 'pr-1', status: 'SUCCEEDED' } });
    answers.set('POST /v3/payment_requests', { status: 200, body: { payment_request_id: 'pr-2', status: 'SUCCEEDED' } });
    const ref = 'postpay:aaaaaaaa-2222-3333-4444-555555555555:2';
    const ovo = await x().chargeWallet({ referenceId: ref, amountMinor: 20_000, channel: 'OVO', token: 'pm-1', returnUrl: 'x', customerId: 'd' });
    const again = await x().chargeWallet({ referenceId: ref, amountMinor: 20_000, channel: 'OVO', token: 'pm-1', returnUrl: 'x', customerId: 'd' });
    const reqs = seen.filter((s) => s.path === '/payment_requests');
    assert.equal(ovo.providerRef, x().orderRef(ref));
    assert.equal(again.providerRef, ovo.providerRef);
    assert.deepEqual(reqs.map((r) => [JSON.parse(r.body).reference_id, r.headers['idempotency-key']]), [[ovo.providerRef, ovo.providerRef], [ovo.providerRef, ovo.providerRef]],
      'the same idempotency key: Xendit answers a repeat with the first payment');
    const gp = await x().chargeWallet({ referenceId: ref, amountMinor: 20_000, channel: 'GOPAY', token: 'pt-1', returnUrl: 'x', customerId: 'd' });
    const v3 = seen.find((s) => s.path === '/v3/payment_requests')!;
    assert.deepEqual([gp.providerRef, JSON.parse(v3.body).reference_id, v3.headers['idempotency-key']], [ovo.providerRef, ovo.providerRef, ovo.providerRef]);
  });

  test('Stripe: metadata.plugsure_ref and the Idempotency-Key derived from the reference, for checkouts and saved cards alike (WP3)', async () => {
    const fake = await new FakeStripe({ secretKey: 'sk_test_idem1', webhookSecret: 'whsec_idem', country: 'SG' }).start();
    try {
      const s = new StripeProvider({ secretKey: 'sk_test_idem1', webhookSecret: 'whsec_idem', country: 'SG', baseUrl: fake.url, publicBaseUrl: 'https://x' });
      const ref = 'charge:99999999-2222-3333-4444-555555555555';
      const a = await s.createCheckout({ referenceId: ref, amountMinor: 1000, channel: 'CARD', returnUrl: 'https://x/r', currency: 'SGD' });
      const b = await s.createCheckout({ referenceId: ref, amountMinor: 1000, channel: 'CARD', returnUrl: 'https://x/r', currency: 'SGD' });
      const posts = fake.posts(/^\/v1\/payment_intents$/);
      assert.equal(a.providerRef, s.orderRef(ref));
      assert.deepEqual([b.providerRef, b.providerPaymentId], [a.providerRef, a.providerPaymentId], 'Stripe answers a repeat with the first PaymentIntent');
      assert.deepEqual(posts.map((p) => [p.body.metadata.plugsure_ref, p.headers['idempotency-key']]), [[a.providerRef, `pi-${a.providerRef}`], [a.providerRef, `pi-${a.providerRef}`]]);
      assert.equal(fake.intents.size, 1);
      assert.match(a.providerRef, /^ps_[0-9a-f]{32}$/);
    } finally { await fake.stop(); }
  });

  test('BI-SNAP: partnerReferenceNo derived from the reference (alphanumeric)', () => {
    const p = new SnapQrisProvider({ baseUrl: base, partnerId: 'P', clientId: 'C', clientSecret: 'S', privateKeyPem: '', bankPublicKeyPem: '', merchantId: 'M' });
    assert.match(p.orderRef('charge:1'), /^PS[A-F0-9]{24}$/);
    assert.equal(p.orderRef('charge:1'), p.orderRef('charge:1'));
  });
});

describe('Midtrans status lookups (B, C, D)', () => {
  test('paymentStatus: settlement / capture → captured; pending; deny / expire → failed; authorize; 404 → null; an error throws', async () => {
    reset();
    const st = async (body: unknown, status = 200) => { answers.set('/v2/ps-s/status', { status, body }); return m().paymentStatus('ps-s'); };
    assert.equal((await st({ status_code: '200', transaction_status: 'settlement', gross_amount: '30000.00', transaction_id: 't' }))?.status, 'captured');
    assert.equal((await st({ status_code: '200', transaction_status: 'settlement', gross_amount: '30000.00' }))?.amountMinor, 30_000);
    assert.equal((await st({ status_code: '200', transaction_status: 'capture', fraud_status: 'accept' }))?.status, 'captured');
    assert.equal((await st({ status_code: '201', transaction_status: 'pending' }))?.status, 'pending');
    assert.equal((await st({ status_code: '202', transaction_status: 'deny' }))?.status, 'failed');
    assert.equal((await st({ status_code: '407', transaction_status: 'expire' }))?.status, 'failed');
    assert.equal((await st({ status_code: '200', transaction_status: 'authorize' }))?.status, 'authorised');
    assert.equal(await st({ status_code: '404', status_message: "Transaction doesn't exist." }, 404), null);
    await assert.rejects(st({ status_code: '500', status_message: 'down' }, 500), /status lookup failed/);
  });

  test('a capture refused because an earlier attempt (answer lost) already captured it is a success; refused while still authorised is not', async () => {
    reset();
    answers.set('POST /v2/capture', { status: 200, body: { status_code: '412', status_message: 'Transaction status cannot be updated.' } });
    answers.set('/v2/ps-hold/status', { status: 200, body: { status_code: '200', transaction_status: 'capture', fraud_status: 'accept', gross_amount: '42300.00' } });
    const ok = await m().captureHold({ providerRef: 'ps-hold', providerPaymentId: 'tx-h', amountMinor: 42_300, idempotencyKey: 'hold-capture-1' });
    assert.equal(ok.ok, true);
    answers.set('/v2/ps-hold/status', { status: 200, body: { status_code: '200', transaction_status: 'authorize', fraud_status: 'accept' } });
    const no = await m().captureHold({ providerRef: 'ps-hold', providerPaymentId: 'tx-h', amountMinor: 42_300, idempotencyKey: 'hold-capture-1' });
    assert.deepEqual({ ok: no.ok, expired: no.expired }, { ok: false, expired: undefined });
    answers.set('POST /v2/capture', { status: 200, body: { status_code: '407', status_message: 'Expired transaction' } });
    answers.set('/v2/ps-hold/status', { status: 200, body: { status_code: '407', transaction_status: 'expire' } });
    assert.equal((await m().captureHold({ providerRef: 'ps-hold', providerPaymentId: 'tx-h', amountMinor: 1, idempotencyKey: 'k' })).expired, true, 'an expiry stays an expiry');
  });

  test('refundStatus: the order lists the refund by our refund_key → refunded; not listed → null', async () => {
    reset();
    answers.set('/v2/ps-r/status', { status: 200, body: { status_code: '200', transaction_status: 'refund', refunds: [{ refund_key: 'refund-abc', refund_amount: '5000.00' }] } });
    assert.equal(await m().refundStatus({ providerRef: 'ps-r', providerPaymentId: null, channel: 'GOPAY', refundRef: null, idempotencyKey: 'refund-abc' }), 'refunded');
    assert.equal(await m().refundStatus({ providerRef: 'ps-r', providerPaymentId: null, channel: 'GOPAY', refundRef: null, idempotencyKey: 'refund-other' }), null);
  });
});

describe('Xendit callbacks: an allowlist of payment events (F)', () => {
  const H = { 'x-callback-token': 'cb-token-idem' };
  test('payment events are payments; a GoPay link event (payment_token.*, which carries a reference_id) reaches parseLinkEvent; refunds are not payments', () => {
    const cb = (event: string, data: unknown) => JSON.stringify({ event, data });
    assert.equal(x().parseNotification(cb('qr.payment', { reference_id: 'ps-1', status: 'SUCCEEDED', amount: 1000 }), H)?.paid, true);
    assert.equal(x().parseNotification(cb('ewallet.capture', { reference_id: 'ps-1', status: 'SUCCEEDED', charge_amount: 1000 }), H)?.paid, true);
    assert.equal(x().parseNotification(cb('payment.capture', { reference_id: 'ps-1', status: 'SUCCEEDED', request_amount: 1000 }), H)?.paid, true);
    assert.equal(x().parseNotification(cb('payment.authorization', { reference_id: 'ps-1', status: 'AUTHORIZED', request_amount: 1000 }), H)?.authorised, true);
    // GoPay linking (v3 payment token): it has a reference_id (link-…), and was read as a payment before.
    const link = cb('payment_token.activation', { payment_token_id: 'pt-9', reference_id: 'link-1', status: 'ACTIVE' });
    assert.equal(x().parseNotification(link, H), null);
    assert.deepEqual(x().parseLinkEvent(link, H), { linkRef: 'pt-9', status: 'active', event: 'payment_token.activation' });
    // A refund: SUCCEEDED with an amount and the payment's reference — not money received.
    const refund = cb('refund.succeeded', { id: 'rfd-1', payment_request_id: 'pr-1', reference_id: 'ps-1', status: 'SUCCEEDED', amount: 1000 });
    assert.equal(x().parseNotification(refund, H), null);
    assert.deepEqual(x().parseRefundEvent(refund, H), { refundRef: 'rfd-1', status: 'refunded', event: 'refund.succeeded' });
    assert.equal(x().parseRefundEvent(cb('refund.failed', { id: 'rfd-2', status: 'FAILED' }), H)?.status, 'failed');
    assert.equal(x().parseRefundEvent(refund, { 'x-callback-token': 'wrong-token-1' }), null, 'verified like a payment');
    assert.equal(x().parseNotification(cb('something.else', { reference_id: 'ps-1', status: 'SUCCEEDED', amount: 1 }), H), null, 'an unknown event is not a payment');
    // The invoice (cards) has no event: unchanged.
    assert.equal(x().parseNotification(JSON.stringify({ id: 'inv', external_id: 'ps-i', status: 'PAID', paid_amount: 1000 }), H)?.paid, true);
  });

  test('refundStatus: a payment request\'s refund (GET /refunds/{id}) and an e-wallet charge\'s', async () => {
    reset();
    answers.set('/refunds/rfd-1', { status: 200, body: { id: 'rfd-1', status: 'SUCCEEDED' } });
    answers.set('/ewallets/charges/ewc_1/refunds/rfd-2', { status: 200, body: { id: 'rfd-2', status: 'PENDING' } });
    assert.equal(await x().refundStatus({ providerRef: 'ps-1', providerPaymentId: 'pr-1', channel: 'OVO', refundRef: 'rfd-1', idempotencyKey: 'refund-1' }), 'refunded');
    assert.equal(await x().refundStatus({ providerRef: 'ps-1', providerPaymentId: 'ewc_1', channel: 'DANA', refundRef: 'rfd-2', idempotencyKey: 'refund-2' }), 'pending');
    assert.equal(await x().refundStatus({ providerRef: 'ps-1', providerPaymentId: 'pr-1', channel: 'OVO', refundRef: 'rfd-404', idempotencyKey: 'refund-3' }), null);
  });
});

describe('BI-SNAP notifications (F)', () => {
  const bank = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const mine = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const p = new SnapQrisProvider({
    baseUrl: 'http://127.0.0.1:1', partnerId: 'P', clientId: 'C', clientSecret: 'S', merchantId: 'M',
    privateKeyPem: mine.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    bankPublicKeyPem: bank.publicKey.export({ type: 'spki', format: 'pem' }) as string,
  });
  const path = '/pay/notify/key123';
  const jakarta = (ms: number) => new Date(ms + 7 * 3600_000).toISOString().replace(/\.\d{3}Z$/, '+07:00');
  const sign = (signedBody: string, ts: string) =>
    createSign('RSA-SHA256').update(`POST:${path}:${createHash('sha256').update(signedBody).digest('hex')}:${ts}`).sign(bank.privateKey, 'base64');

  test('minify: whitespace outside strings removed, everything else exactly as sent', () => {
    assert.equal(minifyJson('{ "a" : "x  y\\" z" ,\n "b": [1, 2.50] }'), '{"a":"x  y\\" z","b":[1,2.50]}');
  });

  test('the signature is over the body as received (minified), not a re-serialisation of it', () => {
    const ts = jakarta(Date.now());
    // As a bank sends it: pretty-printed, an amount written 10000.00 inside a string, and a \\u escape the bank signed as is.
    const raw = '{\n  "originalPartnerReferenceNo": "PSABC",\n  "latestTransactionStatus": "00",\n  "amount": { "value": "10000.00", "currency": "IDR" },\n  "additionalInfo": { "note": "Caf\\u00e9" }\n}';
    const sig = sign(minifyJson(raw), ts);
    const n = p.parseNotification(raw, { 'x-signature': sig, 'x-timestamp': ts }, path);
    assert.deepEqual({ ref: n?.providerRef, paid: n?.paid, amount: n?.amountMinor }, { ref: 'PSABC', paid: true, amount: 10_000 },
      'JSON.stringify(JSON.parse(raw)) rewrites \\u00e9, so the bank\'s signature did not verify before');
    // A signature over the re-serialised form (what the old code checked) is not the bank's.
    assert.equal(p.parseNotification(raw, { 'x-signature': sign(JSON.stringify(JSON.parse(raw)), ts), 'x-timestamp': ts }, path), null);
  });

  test('rupiah only: another currency (or none) is not a payment', () => {
    const ts = jakarta(Date.now());
    for (const amount of [{ value: '10.00', currency: 'USD' }, { value: '10000.00' }]) {
      const body = JSON.stringify({ originalPartnerReferenceNo: 'PSABC', latestTransactionStatus: '00', amount });
      assert.equal(p.parseNotification(body, { 'x-signature': sign(body, ts), 'x-timestamp': ts }, path), null, JSON.stringify(amount));
    }
  });

  test('X-TIMESTAMP within ±5 minutes; older or newer is a replay (checked first by the notification endpoint)', () => {
    const now = Date.parse('2026-10-01T10:00:00+07:00');
    const fresh = (ts: string) => p.notificationFresh({ 'x-timestamp': ts }, now);
    assert.equal(fresh('2026-10-01T10:04:59+07:00'), true);
    assert.equal(fresh('2026-10-01T09:55:01+07:00'), true);
    assert.equal(fresh('2026-10-01T09:54:00+07:00'), false);
    assert.equal(fresh('2026-10-01T10:06:00+07:00'), false);
    assert.equal(fresh('2026-09-27T10:00:00+07:00'), false);
    assert.equal(fresh('not a time'), false);
    assert.equal(p.notificationFresh({}, now), false);
  });
});
