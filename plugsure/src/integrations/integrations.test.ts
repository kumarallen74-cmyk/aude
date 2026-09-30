import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { MidtransProvider } from '../services/payments/midtrans.js';
import { XenditProvider } from '../services/payments/xendit.js';
import { SnapQrisProvider } from '../services/payments/snap-qris.js';
import { cardBrand, last4Of, maskAccount, WalletLinkEnded } from '../services/payments/provider.js';
import { cardEndedMessage, linkEndedMessage, postpayFailureNote } from '../services/payments/registry.js';
import { senderFor, OTP_TEXT } from './otp.js';
import { CATALOGUE, providerDef } from './catalogue.js';

/** A fake provider: records requests, answers by path. */
const seen: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders; body: string }> = [];
const answers = new Map<string, { status: number; body: unknown }>();
let base = '';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0]!;
    seen.push({ method: req.method ?? '', path, headers: req.headers, body });
    const a = [...answers.entries()].find(([p]) => path.startsWith(p))?.[1] ?? { status: 404, body: { error: 'no fake' } };
    res.writeHead(a.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(a.body));
  });
});
before(async () => { await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r())); base = `http://127.0.0.1:${(server.address() as any).port}`; });
after(() => server.close());
const last = () => seen[seen.length - 1]!;

describe('integration catalogue', () => {
  test('every kind has providers; secrets are typed secret; test doubles are marked', () => {
    for (const k of CATALOGUE) assert.ok(k.providers.length > 0, k.kind);
    assert.equal(providerDef('payments', 'midtrans')!.fields.find((f) => f.key === 'serverKey')!.type, 'secret');
    assert.equal(providerDef('otp', 'twilio')!.fields.find((f) => f.key === 'authToken')!.type, 'secret');
    assert.ok(providerDef('payments', 'mock')!.devOnly && providerDef('otp', 'dev')!.devOnly && providerDef('pnc_pki', 'mock')!.devOnly);
    assert.ok(!providerDef('otp_fallback', 'dev'), 'the fallback has no development provider');
  });
});

describe('Midtrans (QRIS)', () => {
  const m = () => new MidtransProvider({ environment: 'sandbox', serverKey: 'SB-Mid-server-TEST', acquirer: 'gopay', baseUrl: base });
  test('charge: payment type qris, the amount, Basic auth with the server key', async () => {
    answers.set('/v2/charge', { status: 200, body: { status_code: '201', transaction_status: 'pending', qr_string: '00020101021226FAKE', actions: [] } });
    const c = await m().createQrisCharge({ referenceId: 'x', amountIdr: 50_000, expiresInS: 900 });
    const r = last();
    const b = JSON.parse(r.body);
    assert.equal(b.payment_type, 'qris');
    assert.equal(b.transaction_details.gross_amount, 50_000);
    assert.equal(b.transaction_details.order_id, c.providerRef);
    assert.match(c.providerRef, /^ps-[a-f0-9]{24}$/);
    assert.equal(b.custom_expiry.expiry_duration, 15);
    assert.equal(r.headers.authorization, 'Basic ' + Buffer.from('SB-Mid-server-TEST:').toString('base64'));
    assert.equal(c.qrString, '00020101021226FAKE');
  });
  test('charge refused → a readable error', async () => {
    answers.set('/v2/charge', { status: 200, body: { status_code: '401', status_message: 'Access denied' } });
    await assert.rejects(m().createQrisCharge({ referenceId: 'x', amountIdr: 1000 }), /401 Access denied/);
  });
  test('notification: SHA-512 signature verified; settlement = paid; a forged one is refused', () => {
    const p = m();
    const body = { order_id: 'ps-abc', status_code: '200', gross_amount: '50000.00', transaction_status: 'settlement', transaction_id: 'tx1' };
    const sig = createHash('sha512').update(`ps-abc20050000.00SB-Mid-server-TEST`).digest('hex');
    const n = p.parseNotification(JSON.stringify({ ...body, signature_key: sig }));
    assert.deepEqual({ ref: n?.providerRef, paid: n?.paid, amount: n?.amountIdr }, { ref: 'ps-abc', paid: true, amount: 50_000 });
    assert.equal(p.parseNotification(JSON.stringify({ ...body, gross_amount: '5.00', signature_key: sig })), null, 'amount changed');
    assert.equal(p.parseNotification(JSON.stringify({ ...body, transaction_status: 'expire', signature_key: sig }))?.paid, false);
  });
  test('refund by API; key test: 404 means the key works, 401 not', async () => {
    answers.set('/v2/ps-abc/refund', { status: 200, body: { status_code: '200', refund_key: 'refund-1' } });
    const r = await m().refund({ providerRef: 'ps-abc', amountIdr: 10_000, reason: 'unused', idempotencyKey: 'refund-1' });
    assert.equal(r.status, 'refunded');
    assert.equal(JSON.parse(last().body).amount, 10_000);
    answers.set('/v2/plugsure-connection-test', { status: 404, body: { status_code: '404' } });
    assert.equal((await m().testConnection()).ok, true);
    answers.set('/v2/plugsure-connection-test', { status: 401, body: { status_code: '401' } });
    assert.equal((await m().testConnection()).ok, false);
  });
});

describe('Xendit (QRIS)', () => {
  const x = () => new XenditProvider({ secretKey: 'xnd_development_TEST', callbackToken: 'cb-token-123', forUserId: 'sub-1', baseUrl: base });
  test('dynamic QR with api-version and the sub-account header', async () => {
    answers.set('/qr_codes', { status: 201, body: { id: 'qr_1', qr_string: '000201XENDIT', status: 'ACTIVE' } });
    const c = await x().createQrisCharge({ referenceId: 'x', amountIdr: 25_000 });
    const r = last();
    assert.equal(JSON.parse(r.body).type, 'DYNAMIC');
    assert.equal(JSON.parse(r.body).reference_id, c.providerRef);
    assert.equal(r.headers['api-version'], '2022-07-31');
    assert.equal(r.headers['for-user-id'], 'sub-1');
    assert.equal(c.qrString, '000201XENDIT');
  });
  test('callback: only with the verification token; SUCCEEDED = paid', () => {
    const body = JSON.stringify({ event: 'qr.payment', data: { id: 'qrpy_1', reference_id: 'ps-1', amount: 25000, status: 'SUCCEEDED' } });
    assert.equal(x().parseNotification(body, { 'x-callback-token': 'cb-token-123' })?.paid, true);
    assert.equal(x().parseNotification(body, { 'x-callback-token': 'wrong-token-1' }), null);
    assert.equal(x().parseNotification(body, {}), null);
  });
});

describe('Midtrans (e-wallets, cards)', () => {
  const m = () => new MidtransProvider({ environment: 'sandbox', serverKey: 'SB-Mid-server-TEST', baseUrl: base });
  test('offers QRIS, GoPay, ShopeePay and cards', () => assert.deepEqual(m().channels(), ['QRIS', 'GOPAY', 'SHOPEEPAY', 'CARD']));
  test('GoPay: payment type gopay with the return URL; the deeplink opens the app', async () => {
    answers.set('/v2/charge', { status: 200, body: { status_code: '201', transaction_id: 'tx-go', actions: [{ name: 'generate-qr-code', url: 'x' }, { name: 'deeplink-redirect', url: 'gojek://gopay/merchanttransfer?tref=1' }] } });
    const c = await m().createCheckout({ referenceId: 'r', amountIdr: 40_000, channel: 'GOPAY', returnUrl: 'https://p.example/app/paid.html?for=charge' });
    const b = JSON.parse(last().body);
    assert.equal(b.payment_type, 'gopay');
    assert.equal(b.gopay.callback_url, 'https://p.example/app/paid.html?for=charge');
    assert.equal(b.transaction_details.order_id, c.providerRef);
    assert.deepEqual({ action: c.action, url: c.checkoutUrl, id: c.providerPaymentId }, { action: 'redirect', url: 'gojek://gopay/merchanttransfer?tref=1', id: 'tx-go' });
  });
  test('ShopeePay: payment type shopeepay', async () => {
    answers.set('/v2/charge', { status: 200, body: { status_code: '201', actions: [{ name: 'deeplink-redirect', url: 'shopeeid://pay' }] } });
    const c = await m().createCheckout({ referenceId: 'r', amountIdr: 40_000, channel: 'SHOPEEPAY', returnUrl: 'https://p.example/app/paid.html' });
    assert.equal(JSON.parse(last().body).payment_type, 'shopeepay');
    assert.equal(c.checkoutUrl, 'shopeeid://pay');
  });
  test('card: Snap with credit_card only and 3-D Secure; the hosted page URL', async () => {
    answers.set('/snap/v1/transactions', { status: 201, body: { token: 't', redirect_url: 'https://app.sandbox.midtrans.com/snap/v4/redirection/t' } });
    const c = await m().createCheckout({ referenceId: 'r', amountIdr: 75_000, channel: 'CARD', returnUrl: 'https://p.example/app/paid.html' });
    const b = JSON.parse(last().body);
    assert.deepEqual(b.enabled_payments, ['credit_card']);
    assert.equal(b.credit_card.secure, true);
    assert.equal(b.callbacks.finish, 'https://p.example/app/paid.html');
    assert.equal(c.checkoutUrl, 'https://app.sandbox.midtrans.com/snap/v4/redirection/t');
  });
  test('card notification: capture + accept = paid; capture + challenge is not', () => {
    const sig = createHash('sha512').update('ps-card20075000.00SB-Mid-server-TEST').digest('hex');
    const body = { order_id: 'ps-card', status_code: '200', gross_amount: '75000.00', transaction_status: 'capture', payment_type: 'credit_card', signature_key: sig };
    assert.equal(m().parseNotification(JSON.stringify({ ...body, fraud_status: 'accept' }))?.paid, true);
    assert.equal(m().parseNotification(JSON.stringify({ ...body, fraud_status: 'challenge' }))?.paid, false);
  });
  test('a channel it does not offer is refused', async () => {
    await assert.rejects(m().createCheckout({ referenceId: 'r', amountIdr: 1000, channel: 'OVO', returnUrl: 'https://p.example/' }), /does not offer OVO/);
  });
});

describe('Xendit (e-wallets, cards)', () => {
  const x = () => new XenditProvider({ secretKey: 'xnd_development_TEST', callbackToken: 'cb-token-123', baseUrl: base });
  const H = { 'x-callback-token': 'cb-token-123' };
  test('OVO: pushed to the phone number; no URL to open', async () => {
    answers.set('/ewallets/charges', { status: 202, body: { id: 'ewc_ovo', status: 'PENDING', actions: null } });
    const c = await x().createCheckout({ referenceId: 'r', amountIdr: 30_000, channel: 'OVO', returnUrl: 'https://p.example/app/paid.html', customerPhone: '+6281234567890' });
    const b = JSON.parse(last().body);
    assert.equal(b.channel_code, 'ID_OVO');
    assert.equal(b.checkout_method, 'ONE_TIME_PAYMENT');
    assert.equal(b.channel_properties.mobile_number, '+6281234567890');
    assert.deepEqual({ action: c.action, url: c.checkoutUrl, id: c.providerPaymentId }, { action: 'push', url: null, id: 'ewc_ovo' });
    await assert.rejects(x().createCheckout({ referenceId: 'r', amountIdr: 1000, channel: 'OVO', returnUrl: 'https://p.example/' }), /phone/);
  });
  test('DANA: the redirect URL comes back as the checkout URL', async () => {
    answers.set('/ewallets/charges', { status: 202, body: { id: 'ewc_dana', actions: { desktop_web_checkout_url: 'https://dana.example/web', mobile_web_checkout_url: 'https://dana.example/m' } } });
    const c = await x().createCheckout({ referenceId: 'r', amountIdr: 30_000, channel: 'DANA', returnUrl: 'https://p.example/app/paid.html' });
    const b = JSON.parse(last().body);
    assert.equal(b.channel_code, 'ID_DANA');
    assert.equal(b.channel_properties.success_redirect_url, 'https://p.example/app/paid.html');
    assert.equal(c.checkoutUrl, 'https://dana.example/m');
  });
  test('card: an invoice limited to CREDIT_CARD; its URL', async () => {
    answers.set('/v2/invoices', { status: 200, body: { id: 'inv_1', invoice_url: 'https://checkout-staging.xendit.co/web/inv_1' } });
    const c = await x().createCheckout({ referenceId: 'r', amountIdr: 80_000, channel: 'CARD', returnUrl: 'https://p.example/app/paid.html', expiresInS: 900 });
    const b = JSON.parse(last().body);
    assert.deepEqual(b.payment_methods, ['CREDIT_CARD']);
    assert.equal(b.external_id, c.providerRef);
    assert.equal(b.invoice_duration, 900);
    assert.equal(c.checkoutUrl, 'https://checkout-staging.xendit.co/web/inv_1');
  });
  test('callbacks: e-wallet capture and paid invoice are paid; an expired invoice is not; a wrong token is refused', () => {
    const ew = JSON.stringify({ event: 'ewallet.capture', data: { id: 'ewc_1', reference_id: 'ps-e', status: 'SUCCEEDED', charge_amount: 30000, capture_amount: 30000 } });
    assert.deepEqual((({ providerRef, paid, amountIdr, paymentId }) => ({ providerRef, paid, amountIdr, paymentId }))(x().parseNotification(ew, H)!), { providerRef: 'ps-e', paid: true, amountIdr: 30_000, paymentId: 'ewc_1' });
    const inv = (status: string) => JSON.stringify({ id: 'inv_1', external_id: 'ps-i', status, amount: 80000, paid_amount: 80000, payment_method: 'CREDIT_CARD' });
    assert.equal(x().parseNotification(inv('PAID'), H)?.paid, true);
    assert.equal(x().parseNotification(inv('PAID'), H)?.providerRef, 'ps-i');
    assert.equal(x().parseNotification(inv('EXPIRED'), H)?.paid, false);
    assert.equal(x().parseNotification(inv('PAID'), { 'x-callback-token': 'nope-nope-12' }), null);
  });
  test('refunds: e-wallets by API with the charge id; QRIS and cards by bank transfer', async () => {
    answers.delete('/ewallets/charges'); // the fake answers by path prefix
    answers.set('/ewallets/charges/ewc_1/refunds', { status: 200, body: { id: 'ewr_1', status: 'SUCCEEDED' } });
    const r = await x().refund({ providerRef: 'ps-e', providerPaymentId: 'ewc_1', channel: 'DANA', amountIdr: 12_000, reason: 'unused', idempotencyKey: 'refund-9' });
    assert.deepEqual({ s: r.status, ref: r.refundRef }, { s: 'refunded', ref: 'ewr_1' });
    assert.equal(last().headers['idempotency-key'], 'refund-9');
    assert.equal(JSON.parse(last().body).amount, 12_000);
    assert.equal(x().canRefund('OVO'), true);
    assert.equal(x().canRefund('QRIS'), false);
    assert.equal(x().canRefund('CARD'), false);
  });
});

describe('card holds and saved cards', () => {
  const m = (savedCard3ds = true) => new MidtransProvider({ environment: 'sandbox', serverKey: 'SB-Mid-server-TEST', baseUrl: base, savedCard3ds });
  const x = () => new XenditProvider({ secretKey: 'xnd_development_TEST', callbackToken: 'cb-token-123', baseUrl: base });
  test('card brand and last four from a masked number', () => {
    assert.deepEqual([cardBrand('481111-1114'), last4Of('481111-1114')], ['VISA', '1114']);
    assert.equal(cardBrand('521111******1117'), 'MASTERCARD');
    assert.equal(cardBrand(null), null);
  });
  test('Midtrans: a held card on Snap (type authorize) that is saved for the driver (save_card + user_id)', async () => {
    answers.set('/snap/v1/transactions', { status: 201, body: { redirect_url: 'https://snap.test/r/1' } });
    await m().createCheckout({ referenceId: 'r', amountIdr: 100_000, channel: 'CARD', returnUrl: 'https://p.example/app/paid.html', preauth: true, saveCard: true, customerId: 'drv-1' });
    const b = JSON.parse(last().body);
    assert.deepEqual(b.credit_card, { secure: true, type: 'authorize', save_card: true });
    assert.equal(b.user_id, 'drv-1');
  });
  test('Midtrans: "authorize" is a hold (not paid); the saved card comes back as a token with brand and last four', () => {
    const sig = createHash('sha512').update('ps-hold200100000.00SB-Mid-server-TEST').digest('hex');
    const n = m().parseNotification(JSON.stringify({ order_id: 'ps-hold', status_code: '200', gross_amount: '100000.00', transaction_status: 'authorize', fraud_status: 'accept', transaction_id: 'tx-h', signature_key: sig,
      saved_token_id: '481111ZZtoken1114', saved_token_id_expired_at: '2030-12-31 07:00:00', masked_card: '481111-1114' }))!;
    assert.deepEqual({ paid: n.paid, authorised: n.authorised, id: n.paymentId }, { paid: false, authorised: true, id: 'tx-h' });
    assert.deepEqual(n.savedCard, { token: '481111ZZtoken1114', brand: 'VISA', last4: '1114', tokenExpiresAt: '2030-12-31T00:00:00.000Z' });
  });
  test('Midtrans: capture up to the hold by transaction id; release by cancel (412 = nothing held any more)', async () => {
    answers.set('/v2/capture', { status: 200, body: { status_code: '200', transaction_status: 'capture' } });
    assert.equal((await m().captureHold({ providerRef: 'ps-hold', providerPaymentId: 'tx-h', amountIdr: 42_300, idempotencyKey: 'k' })).ok, true);
    assert.deepEqual(JSON.parse(last().body), { transaction_id: 'tx-h', gross_amount: 42_300 });
    assert.equal((await m().captureHold({ providerRef: 'ps-hold', providerPaymentId: null, amountIdr: 1, idempotencyKey: 'k' })).ok, false, 'no transaction id');
    answers.set('/v2/ps-hold/cancel', { status: 200, body: { status_code: '412', status_message: 'Transaction status cannot be updated' } });
    assert.equal((await m().releaseHold({ providerRef: 'ps-hold', idempotencyKey: 'k' })).ok, true);
    answers.set('/v2/ps-hold/cancel', { status: 200, body: { status_code: '500', status_message: 'down' } });
    assert.equal((await m().releaseHold({ providerRef: 'ps-hold', idempotencyKey: 'k' })).ok, false);
  });
  test('Midtrans: a saved card with 3-D Secure (redirect), and One Click without (authorised at once)', async () => {
    answers.set('/v2/charge', { status: 200, body: { status_code: '201', transaction_id: 'tx-s', redirect_url: 'https://3ds.test/1' } });
    const a = await m().chargeSavedCard({ referenceId: 'r', amountIdr: 50_000, token: 'tok', preauth: true, returnUrl: 'https://p.example/app/paid.html', customerId: 'drv-1' });
    const b = JSON.parse(last().body);
    assert.deepEqual({ type: b.payment_type, tok: b.credit_card.token_id, auth: b.credit_card.authentication, kind: b.credit_card.type }, { type: 'credit_card', tok: 'tok', auth: true, kind: 'authorize' });
    assert.deepEqual({ s: a.status, url: a.checkoutUrl }, { s: 'pending', url: 'https://3ds.test/1' });
    answers.set('/v2/charge', { status: 200, body: { status_code: '200', transaction_id: 'tx-o', transaction_status: 'authorize', fraud_status: 'accept' } });
    const o = await m(false).chargeSavedCard({ referenceId: 'r', amountIdr: 50_000, token: 'tok', preauth: true, returnUrl: 'https://p.example/', customerId: 'drv-1' });
    assert.equal(JSON.parse(last().body).credit_card.authentication, false);
    assert.deepEqual({ s: o.status, id: o.providerPaymentId }, { s: 'authorised', id: 'tx-o' });
    answers.set('/v2/charge', { status: 200, body: { status_code: '202', status_message: 'Deny by Bank' } });
    assert.equal((await m(false).chargeSavedCard({ referenceId: 'r', amountIdr: 1000, token: 'tok', preauth: false, returnUrl: 'https://p.example/', customerId: 'd' })).status, 'failed');
  });
  test('Xendit: a held and saved card through a payment session (MANUAL capture)', async () => {
    answers.set('/sessions', { status: 201, body: { payment_session_id: 'ps_1', payment_link_url: 'https://xendit.test/link/1' } });
    const c = await x().createCheckout({ referenceId: 'r', amountIdr: 100_000, channel: 'CARD', returnUrl: 'https://p.example/app/paid.html', preauth: true, saveCard: true, customerId: 'drv-1' });
    const b = JSON.parse(last().body);
    assert.deepEqual({ cap: b.capture_method, ch: b.allowed_payment_channels, save: b.allow_save_payment_method, cust: b.customer.reference_id, ref: b.reference_id }, { cap: 'MANUAL', ch: ['CARDS'], save: 'FORCED', cust: 'drv-1', ref: c.providerRef });
    assert.equal(c.checkoutUrl, 'https://xendit.test/link/1');
  });
  test('Xendit: payment.authorization is a hold, with the payment token of the saved card', () => {
    const n = x().parseNotification(JSON.stringify({ event: 'payment.authorization', data: { reference_id: 'ps-x', payment_request_id: 'pr_1', status: 'AUTHORIZED', request_amount: 100000, payment_token_id: 'pt_1',
      card_details: { masked_card_number: '521111XXXXXX1117', expiry_month: '12', expiry_year: '2030' } } }), { 'x-callback-token': 'cb-token-123' })!;
    assert.deepEqual({ paid: n.paid, authorised: n.authorised, id: n.paymentId }, { paid: false, authorised: true, id: 'pr_1' });
    assert.deepEqual(n.savedCard, { token: 'pt_1', brand: 'MASTERCARD', last4: '1117', expMonth: 12, expYear: 2030 });
  });
  test('Xendit: capture and cancel on the payment request; a saved card needing 3-D Secure', async () => {
    answers.set('/v3/payment_requests/pr_1/captures', { status: 200, body: { status: 'SUCCEEDED' } });
    assert.equal((await x().captureHold({ providerRef: 'ps-x', providerPaymentId: 'pr_1', amountIdr: 42_300, idempotencyKey: 'cap-1' })).ok, true);
    assert.deepEqual({ amt: JSON.parse(last().body).capture_amount, key: last().headers['idempotency-key'] }, { amt: 42_300, key: 'cap-1' });
    answers.set('/v3/payment_requests/pr_1/cancel', { status: 200, body: { status: 'CANCELED' } });
    assert.equal((await x().releaseHold({ providerRef: 'ps-x', providerPaymentId: 'pr_1', idempotencyKey: 'rel-1' })).ok, true);
    answers.set('/v3/payment_requests', { status: 201, body: { payment_request_id: 'pr_2', status: 'REQUIRES_ACTION', actions: [{ type: 'REDIRECT_CUSTOMER', url: 'https://3ds.xendit.test/2' }] } });
    const s = await x().chargeSavedCard({ referenceId: 'r', amountIdr: 50_000, token: 'pt_1', preauth: true, returnUrl: 'https://p.example/', customerId: 'drv-1' });
    assert.deepEqual({ tok: JSON.parse(last().body).payment_token_id, cap: JSON.parse(last().body).capture_method }, { tok: 'pt_1', cap: 'MANUAL' });
    assert.deepEqual({ s: s.status, url: s.checkoutUrl, id: s.providerPaymentId }, { s: 'pending', url: 'https://3ds.xendit.test/2', id: 'pr_2' });
  });
  test('settings: holds and saved cards are off until the operator turns them on', () => {
    for (const id of ['midtrans', 'xendit', 'mock']) {
      const f = providerDef('payments', id)!.fields;
      assert.equal(f.find((k) => k.key === 'cardHolds')?.default, false, id);
      assert.equal(f.find((k) => k.key === 'saveCards')?.default, false, id);
    }
    assert.ok(!providerDef('payments', 'snap')!.fields.some((k) => k.key === 'cardHolds'));
  });
});

describe('linked e-wallets', () => {
  const m = () => new MidtransProvider({ environment: 'sandbox', serverKey: 'SB-Mid-server-TEST', baseUrl: base });
  const x = () => new XenditProvider({ secretKey: 'xnd_development_TEST', callbackToken: 'cb-token-123', baseUrl: base });
  test('Midtrans links GoPay: pay account with the local number and the return page; the activation deeplink', async () => {
    answers.set('/v2/pay/account', { status: 201, body: { status_code: '201', account_id: 'acc-1', account_status: 'PENDING', actions: [{ name: 'activation-deeplink', url: 'gojek://gopay/tokenization?x=1' }, { name: 'activation-link-url', url: 'https://gopay.test/link' }] } });
    const l = await m().linkWallet({ channel: 'GOPAY', customerId: 'drv-1', phone: '+6281234567890', returnUrl: 'https://p.example/app/paid.html?for=link' });
    const b = JSON.parse(last().body);
    assert.deepEqual(b, { payment_type: 'gopay', gopay_partner: { phone_number: '81234567890', country_code: '62', redirect_url: 'https://p.example/app/paid.html?for=link' } });
    assert.deepEqual(l, { linkRef: 'acc-1', status: 'pending', activationUrl: 'gojek://gopay/tokenization?x=1' });
    await assert.rejects(m().linkWallet({ channel: 'OVO', customerId: 'd', phone: '+628', returnUrl: 'x' }), /GoPay only/);
  });
  test('Midtrans: ENABLED account → the GoPay wallet token; charge settles at once, or asks for the PIN; unbind', async () => {
    answers.delete('/v2/pay/account'); // the fake answers by path prefix
    answers.set('/v2/pay/account/acc-1', { status: 200, body: { account_id: 'acc-1', account_status: 'ENABLED', metadata: { payment_options: [{ name: 'PAY_LATER', token: 'pl' }, { name: 'GOPAY_WALLET', active: true, token: 'tok-w', balance: { value: '150000.00' } }] } } });
    const s = await m().walletStatus('acc-1');
    assert.equal(s.status, 'active');
    assert.deepEqual(JSON.parse(s.token!), { accountId: 'acc-1', token: 'tok-w' });
    answers.set('/v2/charge', { status: 200, body: { status_code: '200', transaction_status: 'settlement', transaction_id: 'tx-g' } });
    const c = await m().chargeWallet({ referenceId: 'r', amountIdr: 40_000, channel: 'GOPAY', token: s.token!, returnUrl: 'https://p.example/', customerId: 'drv-1' });
    assert.deepEqual(JSON.parse(last().body).gopay, { account_id: 'acc-1', payment_option_token: 'tok-w', callback_url: 'https://p.example/' });
    assert.deepEqual({ s: c.status, id: c.providerPaymentId }, { s: 'captured', id: 'tx-g' });
    answers.set('/v2/charge', { status: 200, body: { status_code: '201', transaction_status: 'pending', actions: [{ name: 'verification-link-url', url: 'https://gopay.test/pin' }] } });
    const p = await m().chargeWallet({ referenceId: 'r', amountIdr: 400_000, channel: 'GOPAY', token: s.token!, returnUrl: 'https://p.example/', customerId: 'drv-1' });
    assert.deepEqual({ s: p.status, url: p.checkoutUrl }, { s: 'pending', url: 'https://gopay.test/pin' });
    answers.set('/v2/charge', { status: 200, body: { status_code: '202', status_message: 'insufficient balance' } });
    assert.equal((await m().chargeWallet({ referenceId: 'r', amountIdr: 1, channel: 'GOPAY', token: s.token!, returnUrl: 'x', customerId: 'd' })).status, 'failed');
    answers.set('/v2/pay/account/acc-1/unbind', { status: 200, body: { status_code: '204', account_status: 'DISABLED' } });
    await m().unlinkWallet('acc-1');
    assert.equal(last().path, '/v2/pay/account/acc-1/unbind');
  });
  test('Xendit links OVO: a reusable e-wallet payment method with the number; ACTIVE later; DANA too', async () => {
    answers.set('/v2/payment_methods', { status: 201, body: { id: 'pm-1', status: 'PENDING', actions: [{ action: 'AUTH', url: 'https://ovo.test/auth', url_type: 'WEB' }] } });
    const l = await x().linkWallet({ channel: 'OVO', customerId: 'drv-1', phone: '+6281234567890', returnUrl: 'https://p.example/app/paid.html?for=link' });
    const b = JSON.parse(last().body);
    assert.deepEqual({ t: b.type, r: b.reusability, ch: b.ewallet.channel_code, m: b.ewallet.channel_properties.mobile_number, s: b.ewallet.channel_properties.success_return_url, c: b.customer.reference_id },
      { t: 'EWALLET', r: 'MULTIPLE_USE', ch: 'OVO', m: '+6281234567890', s: 'https://p.example/app/paid.html?for=link', c: 'drv-1' });
    assert.deepEqual(l, { linkRef: 'pm-1', status: 'pending', activationUrl: 'https://ovo.test/auth' });
    answers.delete('/v2/payment_methods'); // the fake answers by path prefix
    answers.set('/v2/payment_methods/pm-1', { status: 200, body: { id: 'pm-1', status: 'ACTIVE' } });
    assert.deepEqual(await x().walletStatus('pm-1'), { status: 'active', token: 'pm-1' });
    answers.set('/v2/payment_methods/pm-1', { status: 200, body: { id: 'pm-1', status: 'FAILED' } });
    assert.equal((await x().walletStatus('pm-1')).status, 'failed');
    answers.delete('/v2/payment_methods/pm-1');
    answers.set('/v2/payment_methods', { status: 201, body: { id: 'pm-2', status: 'PENDING', actions: [] } });
    await x().linkWallet({ channel: 'DANA', customerId: 'drv-1', phone: '+6281234567890', returnUrl: 'x' });
    assert.equal(JSON.parse(last().body).ewallet.channel_properties.mobile_number, undefined, 'DANA takes no number');
  });
  test('Xendit: a payment request on the payment method; its refund goes to the Refunds API', async () => {
    answers.set('/payment_requests', { status: 201, body: { id: 'pr-9', status: 'SUCCEEDED' } });
    const c = await x().chargeWallet({ referenceId: 'r', amountIdr: 35_000, channel: 'OVO', token: 'pm-1', returnUrl: 'x', customerId: 'drv-1' });
    assert.deepEqual({ pm: JSON.parse(last().body).payment_method_id, amt: JSON.parse(last().body).amount, s: c.status, id: c.providerPaymentId }, { pm: 'pm-1', amt: 35_000, s: 'captured', id: 'pr-9' });
    answers.set('/refunds', { status: 200, body: { id: 'rfd-1', status: 'SUCCEEDED' } });
    const r = await x().refund({ providerRef: 'r', providerPaymentId: 'pr-9', channel: 'OVO', amountIdr: 9_000, reason: 'unused', idempotencyKey: 'refund-x' });
    assert.deepEqual({ path: last().path, pr: JSON.parse(last().body).payment_request_id, amt: JSON.parse(last().body).amount, s: r.status }, { path: '/refunds', pr: 'pr-9', amt: 9_000, s: 'refunded' });
  });
  test('Xendit links ShopeePay and LinkAja the same way (no number in the channel properties); a non-e-wallet is refused', async () => {
    answers.delete('/v2/payment_methods/pm-1');
    for (const ch of ['SHOPEEPAY', 'LINKAJA'] as const) {
      answers.set('/v2/payment_methods', { status: 201, body: { id: `pm-${ch.toLowerCase()}`, status: 'REQUIRES_ACTION', actions: [{ action: 'AUTH', url: `https://${ch.toLowerCase()}.test/auth`, url_type: 'DEEPLINK' }] } });
      const l = await x().linkWallet({ channel: ch, customerId: 'drv-1', phone: '+6281234567890', returnUrl: 'https://p.example/app/paid.html?for=link' });
      const b = JSON.parse(last().body);
      assert.deepEqual({ ch: b.ewallet.channel_code, r: b.reusability, num: b.ewallet.channel_properties.mobile_number, ok: b.ewallet.channel_properties.success_return_url },
        { ch, r: 'MULTIPLE_USE', num: undefined, ok: 'https://p.example/app/paid.html?for=link' });
      assert.deepEqual(l, { linkRef: `pm-${ch.toLowerCase()}`, status: 'pending', activationUrl: `https://${ch.toLowerCase()}.test/auth` });
    }
    await assert.rejects(x().linkWallet({ channel: 'QRIS', customerId: 'd', phone: '+628', returnUrl: 'x' }), /not QRIS/);
  });
  test('post-pay: the GoPay balance is read from the linked account (null when unknown); off by default with a limit', async () => {
    answers.set('/v2/pay/account/acc-bal', { status: 200, body: { account_status: 'ENABLED', metadata: { payment_options: [{ name: 'GOPAY_WALLET', token: 't', balance: { value: '87500.00', currency: 'IDR' } }] } } });
    assert.equal(await m().walletBalance(JSON.stringify({ accountId: 'acc-bal', token: 't' })), 87_500);
    assert.equal(await m().walletBalance('not json'), null);
    for (const id of ['midtrans', 'xendit', 'mock']) {
      const f = providerDef('payments', id)!.fields;
      assert.equal(f.find((k) => k.key === 'walletPostpay')?.default, false, id);
      assert.equal(f.find((k) => k.key === 'postpayLimitIdr')?.default, 200000, id);
      assert.equal(f.find((k) => k.key === 'postpayNeedsBalance')?.default, false, id);
    }
  });
  test('Midtrans GoPay post-pay: Tabungan balance and token when there is no wallet option; PAY_LATER never; a fresh token for each charge; a disabled link', async () => {
    const tok = JSON.stringify({ accountId: 'acc-sav', token: 'old-tok' });
    answers.set('/v2/pay/account/acc-sav', { status: 200, body: { account_status: 'ENABLED', metadata: { payment_options: [
      { name: 'PAY_LATER', active: true, token: 'pl-tok', balance: { value: '5000000.00' } },
      { name: 'GOPAY_SAVINGS', active: true, token: 'sav-tok', balance: { value: '42000.00', currency: 'IDR' } },
      { name: 'GOPAY_WALLET', active: false, token: 'w-tok', balance: { value: '999000.00' } }] } } });
    assert.equal(await m().walletBalance(tok), 42_000, 'the Tabungan balance, not the PAY_LATER limit or an inactive wallet');
    const s = await m().walletStatus('acc-sav');
    assert.deepEqual(JSON.parse(s.token!), { accountId: 'acc-sav', token: 'sav-tok' });
    answers.set('/v2/charge', { status: 200, body: { status_code: '200', transaction_status: 'settlement', transaction_id: 'tx-sav' } });
    await m().chargeWallet({ referenceId: 'r', amountIdr: 30_000, channel: 'GOPAY', token: tok, returnUrl: 'x', customerId: 'd' });
    assert.equal(JSON.parse(last().body).gopay.payment_option_token, 'sav-tok', 'the token looked up now, not the one stored at link time');
    answers.set('/v2/pay/account/acc-sav', { status: 200, body: { account_status: 'ENABLED', metadata: { payment_options: [{ name: 'PAY_LATER', active: true, token: 'pl-tok' }] } } });
    assert.equal(await m().walletBalance(tok), null, 'PAY_LATER only: no balance to check');
    assert.equal((await m().walletStatus('acc-sav')).status, 'pending');
    const pl = await m().chargeWallet({ referenceId: 'r', amountIdr: 30_000, channel: 'GOPAY', token: tok, returnUrl: 'x', customerId: 'd' });
    assert.equal(pl.status, 'failed');
    assert.equal(last().path, '/v2/pay/account/acc-sav', 'nothing is charged to PAY_LATER');
    for (const st of ['DISABLED', 'EXPIRED']) {
      answers.set('/v2/pay/account/acc-sav', { status: 200, body: { account_status: st } });
      await assert.rejects(m().walletBalance(tok), (e: unknown) => e instanceof WalletLinkEnded && e.acquirerStatus === st, 'an ended link is reported, not read as a balance');
      const off = await m().chargeWallet({ referenceId: 'r', amountIdr: 30_000, channel: 'GOPAY', token: tok, returnUrl: 'x', customerId: 'd' });
      assert.deepEqual({ s: off.status, ended: off.linkEnded, path: last().path }, { s: 'failed', ended: true, path: '/v2/pay/account/acc-sav' }, 'nothing sent to /v2/charge');
    }
    answers.set('/v2/pay/account/acc-sav', { status: 200, body: { account_status: 'PENDING' } });
    assert.equal((await m().chargeWallet({ referenceId: 'r', amountIdr: 30_000, channel: 'GOPAY', token: tok, returnUrl: 'x', customerId: 'd' })).linkEnded, undefined, 'pending is not an ended link');
    answers.set('/v2/pay/account/acc-sav', { status: 500, body: {} });
    await m().chargeWallet({ referenceId: 'r', amountIdr: 30_000, channel: 'GOPAY', token: tok, returnUrl: 'x', customerId: 'd' });
    assert.equal(JSON.parse(last().body).gopay.payment_option_token, 'old-tok', 'lookup failed: the stored token is used');
    answers.delete('/v2/pay/account/acc-sav');
  });
  test('post-pay: the balance Xendit reports on the linked payment method is read for OVO, DANA, ShopeePay and LinkAja; not reported or an error is unknown (null)', async () => {
    answers.delete('/v2/payment_methods'); // the fake answers by path prefix
    answers.set('/v2/payment_methods/pm-bal-ovo', { status: 200, body: { id: 'pm-bal-ovo', status: 'ACTIVE', ewallet: { channel_code: 'OVO', account: { name: 'D', account_details: '••••7890', balance: 64000, point_balance: 120 } } } });
    answers.set('/v2/payment_methods/pm-bal-dana', { status: 200, body: { id: 'pm-bal-dana', status: 'ACTIVE', ewallet: { channel_code: 'DANA', account: { balance: '15500.00' } } } });
    answers.set('/v2/payment_methods/pm-bal-none', { status: 200, body: { id: 'pm-bal-none', status: 'ACTIVE', ewallet: { channel_code: 'DANA', account: {} } } });
    answers.set('/v2/payment_methods/pm-bal-gone', { status: 404, body: { error_code: 'DATA_NOT_FOUND' } });
    assert.equal(await x().walletBalance('pm-bal-ovo', 'OVO'), 64_000);
    assert.equal(await x().walletBalance('pm-bal-dana', 'DANA'), 15_500);
    assert.equal(await x().walletBalance('pm-bal-none', 'DANA'), null, 'no balance reported');
    assert.equal(await x().walletBalance('pm-bal-gone', 'OVO'), null, 'an error is unknown, not zero');
    answers.set('/v2/payment_methods/pm-bal-spay', { status: 200, body: { id: 'pm-bal-spay', status: 'ACTIVE', ewallet: { channel_code: 'SHOPEEPAY', account: { balance: 42000 } } } });
    answers.set('/v2/payment_methods/pm-bal-lja', { status: 200, body: { id: 'pm-bal-lja', status: 'ACTIVE', ewallet: { channel_code: 'LINKAJA', account: { account_details: '••••7890' } } } });
    assert.equal(await x().walletBalance('pm-bal-spay', 'SHOPEEPAY'), 42_000);
    assert.equal(await x().walletBalance('pm-bal-lja', 'LINKAJA'), null, 'LinkAja without a reported balance');
    const before = seen.length;
    assert.equal(await x().walletBalance('pm-bal-ovo', 'QRIS'), null);
    assert.equal(seen.length, before, 'not an e-wallet: not asked');
  });
  test('Xendit GoPay (v3): a one-time payment opens GoPay; the redirect is actions[].value (WEB_URL)', async () => {
    answers.set('/v3/payment_requests', { status: 201, body: { payment_request_id: 'pr-gp1', status: 'REQUIRES_ACTION', actions: [{ type: 'REDIRECT_CUSTOMER', descriptor: 'WEB_URL', value: 'https://gopay.test/pay/pr-gp1' }] } });
    const c = await x().createCheckout({ referenceId: 'r', amountIdr: 45_000, channel: 'GOPAY', returnUrl: 'https://p.example/app/paid.html' });
    const b = JSON.parse(last().body);
    assert.deepEqual({ ch: b.channel_code, t: b.type, amt: b.request_amount, cap: b.capture_method, ok: b.channel_properties.success_return_url, v: last().headers['api-version'] },
      { ch: 'GOPAY', t: 'PAY', amt: 45_000, cap: 'AUTOMATIC', ok: 'https://p.example/app/paid.html', v: '2024-11-11' });
    assert.deepEqual({ url: c.checkoutUrl, id: c.providerPaymentId, action: c.action }, { url: 'https://gopay.test/pay/pr-gp1', id: 'pr-gp1', action: 'redirect' });
    assert.equal(x().canRefund('GOPAY'), true);
    assert.ok(x().channels().includes('GOPAY'));
  });
  test('Xendit GoPay linking: a GOPAY_RECURRING payment token; ACTIVE; charged by payment_token_id; the balance from token_details; unlink cancels', async () => {
    answers.delete('/v3/payment_requests');
    answers.set('/v3/payment_tokens', { status: 201, body: { payment_token_id: 'pt-gp1', status: 'REQUIRES_ACTION', actions: [{ type: 'REDIRECT_CUSTOMER', descriptor: 'WEB_URL', value: 'https://gopay.test/link/pt-gp1' }] } });
    const l = await x().linkWallet({ channel: 'GOPAY', customerId: 'drv-1', phone: '+6281234567890', returnUrl: 'https://p.example/app/paid.html?for=link' });
    const b = JSON.parse(last().body);
    assert.deepEqual({ ch: b.channel_code, c: b.country, cur: b.currency, ok: b.channel_properties.success_return_url, cust: b.customer.reference_id, m: b.customer.mobile_number },
      { ch: 'GOPAY_RECURRING', c: 'ID', cur: 'IDR', ok: 'https://p.example/app/paid.html?for=link', cust: 'drv-1', m: '+6281234567890' });
    assert.deepEqual(l, { linkRef: 'pt-gp1', status: 'pending', activationUrl: 'https://gopay.test/link/pt-gp1' });
    answers.delete('/v3/payment_tokens'); // the fake answers by path prefix
    answers.set('/v3/payment_tokens/pt-gp1', { status: 200, body: { payment_token_id: 'pt-gp1', status: 'ACTIVE', token_details: { account_name: 'D', account_balance: 73500 } } });
    assert.deepEqual(await x().walletStatus('pt-gp1', 'GOPAY'), { status: 'active', token: 'pt-gp1' });
    assert.equal(await x().walletBalance('pt-gp1', 'GOPAY'), 73_500);
    answers.set('/v3/payment_tokens/pt-gp1', { status: 200, body: { payment_token_id: 'pt-gp1', status: 'ACTIVE', token_details: { account_name: 'D' } } });
    assert.equal(await x().walletBalance('pt-gp1', 'GOPAY'), null, 'not reported: unknown');
    answers.set('/v3/payment_requests', { status: 201, body: { payment_request_id: 'pr-gp2', status: 'SUCCEEDED' } });
    const ch = await x().chargeWallet({ referenceId: 'r', amountIdr: 30_000, channel: 'GOPAY', token: 'pt-gp1', returnUrl: 'x', customerId: 'drv-1' });
    const cb = JSON.parse(last().body);
    assert.deepEqual({ tok: cb.payment_token_id, cap: cb.capture_method, amt: cb.request_amount, noChannel: cb.channel_code === undefined }, { tok: 'pt-gp1', cap: 'AUTOMATIC', amt: 30_000, noChannel: true });
    assert.deepEqual({ s: ch.status, id: ch.providerPaymentId }, { s: 'captured', id: 'pr-gp2' });
    answers.set('/v3/payment_tokens/pt-gp1/cancel', { status: 200, body: { status: 'CANCELED' } });
    await x().unlinkWallet('pt-gp1', 'GOPAY');
    assert.equal(last().path, '/v3/payment_tokens/pt-gp1/cancel');
  });
  test('a link ended in the e-wallet app or expired (Xendit GoPay token EXPIRED / CANCELED, OVO / DANA / ShopeePay / LinkAja payment method INACTIVE / EXPIRED) is reported as ended, with a message that says to link again', async () => {
    answers.delete('/v3/payment_tokens/pt-gp1/cancel');
    for (const st of ['EXPIRED', 'CANCELED']) {
      answers.set('/v3/payment_tokens/pt-gp1', { status: 200, body: { payment_token_id: 'pt-gp1', status: st, token_details: { account_balance: 90000 } } });
      await assert.rejects(x().walletBalance('pt-gp1', 'GOPAY'), (e: unknown) => e instanceof WalletLinkEnded, st);
      answers.set('/v3/payment_requests', { status: 400, body: { error_code: 'INVALID_PAYMENT_TOKEN', message: 'token is not active' } });
      const c = await x().chargeWallet({ referenceId: 'r', amountIdr: 30_000, channel: 'GOPAY', token: 'pt-gp1', returnUrl: 'x', customerId: 'drv-1' });
      assert.deepEqual({ s: c.status, ended: c.linkEnded }, { s: 'failed', ended: true }, st);
    }
    answers.set('/v3/payment_tokens/pt-gp1', { status: 200, body: { payment_token_id: 'pt-gp1', status: 'ACTIVE' } });
    const refused = await x().chargeWallet({ referenceId: 'r', amountIdr: 30_000, channel: 'GOPAY', token: 'pt-gp1', returnUrl: 'x', customerId: 'drv-1' });
    assert.deepEqual({ s: refused.status, ended: refused.linkEnded }, { s: 'failed', ended: undefined }, 'refused for another reason: not an ended link');
    answers.delete('/v3/payment_requests');
    // OVO, DANA, ShopeePay and LinkAja (v2 payment methods): INACTIVE (unlinked in the app) or EXPIRED.
    // LinkAja reports no balance: the ended link is still found (the status is read first).
    answers.delete('/v2/payment_methods'); // the fake answers by path prefix
    for (const [ch, st] of [['OVO', 'INACTIVE'], ['DANA', 'EXPIRED'], ['SHOPEEPAY', 'INACTIVE'], ['LINKAJA', 'EXPIRED']] as const) {
      answers.set('/v2/payment_methods/pm-end', { status: 200, body: { id: 'pm-end', status: st, ewallet: { channel_code: ch, account: ch === 'LINKAJA' ? {} : { balance: 50000 } } } });
      await assert.rejects(x().walletBalance('pm-end', ch), (e: unknown) => e instanceof WalletLinkEnded && e.acquirerStatus === st, `${ch} ${st}`);
      answers.set('/payment_requests', { status: 400, body: { error_code: 'PAYMENT_METHOD_NOT_ACTIVE', message: 'payment method is not active' } });
      const c = await x().chargeWallet({ referenceId: 'r', amountIdr: 20_000, channel: ch, token: 'pm-end', returnUrl: 'x', customerId: 'drv-1' });
      assert.deepEqual({ s: c.status, ended: c.linkEnded, m: /link it again/.test(c.message ?? '') }, { s: 'failed', ended: true, m: true }, `${ch} ${st}`);
    }
    answers.set('/v2/payment_methods/pm-end', { status: 200, body: { id: 'pm-end', status: 'ACTIVE', ewallet: { channel_code: 'OVO', account: { balance: 5000 } } } });
    assert.equal(await x().walletBalance('pm-end', 'OVO'), 5_000);
    const low = await x().chargeWallet({ referenceId: 'r', amountIdr: 20_000, channel: 'OVO', token: 'pm-end', returnUrl: 'x', customerId: 'drv-1' });
    assert.deepEqual({ s: low.status, ended: low.linkEnded }, { s: 'failed', ended: undefined }, 'active but refused (e.g. balance): not an ended link');
    answers.delete('/v2/payment_methods/pm-end'); answers.delete('/payment_requests');
    assert.equal(linkEndedMessage('OVO'), 'Tautan OVO Anda sudah tidak aktif: diputus di aplikasi OVO atau kedaluwarsa. Tidak ada yang ditagih. Hubungkan OVO lagi, atau pilih metode lain.');
    assert.equal(linkEndedMessage('SHOPEEPAY'), 'Tautan ShopeePay Anda sudah tidak aktif: diputus di aplikasi ShopeePay atau kedaluwarsa. Tidak ada yang ditagih. Hubungkan ShopeePay lagi, atau pilih metode lain.');
    assert.equal(linkEndedMessage('LINKAJA'), 'Tautan LinkAja Anda sudah tidak aktif: diputus di aplikasi LinkAja atau kedaluwarsa. Tidak ada yang ditagih. Hubungkan LinkAja lagi, atau pilih metode lain.');
    assert.equal(linkEndedMessage('GOPAY'), 'Tautan GoPay Anda sudah tidak aktif: diputus di aplikasi GoPay atau kedaluwarsa. Tidak ada yang ditagih. Hubungkan GoPay lagi, atau pilih metode lain.');
  });
  test('a saved card whose token has ended: Midtrans 411 ("Token id is missing, invalid, or timed out"), Xendit card token EXPIRED / CANCELED; a decline is not an ended token', async () => {
    answers.set('/v2/charge', { status: 200, body: { status_code: '411', status_message: 'Token id is missing, invalid, or timed out' } });
    const mEnded = await m().chargeSavedCard({ referenceId: 'r', amountIdr: 50_000, token: 'saved-tok', preauth: false, returnUrl: 'x', customerId: 'drv-1' });
    assert.deepEqual({ s: mEnded.status, ended: mEnded.linkEnded }, { s: 'failed', ended: true });
    answers.set('/v2/charge', { status: 200, body: { status_code: '202', transaction_status: 'deny', status_message: 'Card declined by bank' } });
    const mDeclined = await m().chargeSavedCard({ referenceId: 'r', amountIdr: 50_000, token: 'saved-tok', preauth: false, returnUrl: 'x', customerId: 'drv-1' });
    assert.deepEqual({ s: mDeclined.status, ended: mDeclined.linkEnded }, { s: 'failed', ended: undefined });
    answers.delete('/v2/charge');
    answers.delete('/v3/payment_tokens'); answers.delete('/v3/payment_requests');
    for (const st of ['EXPIRED', 'CANCELED']) {
      answers.set('/v3/payment_tokens/pt_card_end', { status: 200, body: { payment_token_id: 'pt_card_end', status: st } });
      answers.set('/v3/payment_requests', { status: 400, body: { error_code: 'INVALID_PAYMENT_TOKEN', message: 'payment token is not active' } });
      const xEnded = await x().chargeSavedCard({ referenceId: 'r', amountIdr: 50_000, token: 'pt_card_end', preauth: true, returnUrl: 'x', customerId: 'drv-1' });
      assert.deepEqual({ s: xEnded.status, ended: xEnded.linkEnded }, { s: 'failed', ended: true }, st);
    }
    answers.set('/v3/payment_tokens/pt_card_end', { status: 200, body: { payment_token_id: 'pt_card_end', status: 'ACTIVE' } });
    answers.set('/v3/payment_requests', { status: 201, body: { payment_request_id: 'pr-d', status: 'FAILED', failure_code: 'CARD_DECLINED' } });
    const xDeclined = await x().chargeSavedCard({ referenceId: 'r', amountIdr: 50_000, token: 'pt_card_end', preauth: false, returnUrl: 'x', customerId: 'drv-1' });
    assert.deepEqual({ s: xDeclined.status, ended: xDeclined.linkEnded }, { s: 'failed', ended: undefined });
    answers.delete('/v3/payment_tokens/pt_card_end'); answers.delete('/v3/payment_requests');
    assert.equal(cardEndedMessage({ brand: 'VISA', last4: '4242' }, false), 'Visa •••• 4242 yang tersimpan sudah tidak bisa dipakai: dihapus atau kedaluwarsa di penyedia pembayaran. Tidak ada yang ditagih. Bayar dengan kartu (bisa disimpan lagi), atau pilih metode lain.');
    assert.equal(cardEndedMessage({ brand: 'MASTERCARD', last4: '5100' }, true), 'Mastercard •••• 5100 yang tersimpan sudah kedaluwarsa. Tidak ada yang ditagih. Bayar dengan kartu lain (bisa disimpan lagi), atau pilih metode lain.');
  });
  test('an expired card hold: Midtrans 407 ("Expired transaction") or transaction_status expire, Xendit payment request EXPIRED; releasing one that expired is done', async () => {
    answers.set('/v2/capture', { status: 200, body: { status_code: '407', status_message: 'Expired transaction' } });
    const mc = await m().captureHold({ providerRef: 'ps-1', providerPaymentId: 'tx-1', amountIdr: 30_000, idempotencyKey: 'k' });
    assert.deepEqual({ ok: mc.ok, expired: mc.expired }, { ok: false, expired: true });
    answers.set('/v2/capture', { status: 200, body: { status_code: '412', status_message: 'Merchant cannot modify status of the transaction' } });
    assert.equal((await m().captureHold({ providerRef: 'ps-1', providerPaymentId: 'tx-1', amountIdr: 30_000, idempotencyKey: 'k' })).expired, undefined, '412 alone is not an expiry');
    answers.delete('/v2/capture');
    answers.set('/v2/ps-2/cancel', { status: 200, body: { status_code: '407', status_message: 'Expired transaction' } });
    const mr = await m().releaseHold({ providerRef: 'ps-2', providerPaymentId: 'tx-2', idempotencyKey: 'k' });
    assert.deepEqual({ ok: mr.ok, expired: mr.expired }, { ok: true, expired: true });
    answers.delete('/v2/ps-2/cancel');
    answers.delete('/v3/payment_requests');
    answers.set('/v3/payment_requests/pr-exp/captures', { status: 400, body: { error_code: 'INVALID_PAYMENT_REQUEST_STATUS', message: 'cannot capture' } });
    answers.set('/v3/payment_requests/pr-exp/cancel', { status: 400, body: { error_code: 'INVALID_PAYMENT_REQUEST_STATUS', message: 'cannot cancel' } });
    answers.set('/v3/payment_requests/pr-exp', { status: 200, body: { payment_request_id: 'pr-exp', status: 'EXPIRED' } });
    const xc = await x().captureHold({ providerRef: 'r', providerPaymentId: 'pr-exp', amountIdr: 30_000, idempotencyKey: 'k' });
    assert.deepEqual({ ok: xc.ok, expired: xc.expired }, { ok: false, expired: true });
    const xr = await x().releaseHold({ providerRef: 'r', providerPaymentId: 'pr-exp', idempotencyKey: 'k' });
    assert.deepEqual({ ok: xr.ok, expired: xr.expired }, { ok: true, expired: true });
    answers.set('/v3/payment_requests/pr-exp', { status: 200, body: { payment_request_id: 'pr-exp', status: 'AUTHORIZED' } });
    const xf = await x().captureHold({ providerRef: 'r', providerPaymentId: 'pr-exp', amountIdr: 30_000, idempotencyKey: 'k' });
    assert.deepEqual({ ok: xf.ok, expired: xf.expired }, { ok: false, expired: undefined }, 'refused while still authorised: not an expiry, retried as before');
    for (const p of ['/v3/payment_requests/pr-exp/captures', '/v3/payment_requests/pr-exp/cancel', '/v3/payment_requests/pr-exp']) answers.delete(p);
  });
  test('a Xendit e-wallet payment the driver declined carries its reason (FAILED USER_DECLINED_PAYMENT); other statuses are unchanged', () => {
    const cb = (data: unknown) => JSON.stringify({ event: 'payment.failed', data });
    const H = { 'x-callback-token': 'cb-token-123' };
    const declined = x().parseNotification(cb({ reference_id: 'ps-d', status: 'FAILED', failure_code: 'USER_DECLINED_PAYMENT', request_amount: 20000 }), H);
    assert.deepEqual({ paid: declined?.paid, status: declined?.status }, { paid: false, status: 'FAILED USER_DECLINED_PAYMENT' });
    assert.equal(x().parseNotification(cb({ reference_id: 'ps-e', status: 'EXPIRED' }), H)?.status, 'EXPIRED');
    assert.equal(x().parseNotification(cb({ reference_id: 'ps-s', status: 'SUCCEEDED', failure_code: 'IGNORED' }), H)?.status, 'SUCCEEDED');
  });
  test('Xendit link events: a payment method (v2) or payment token (v3) activated, ended or failed; a wrong token or a payment is not one', () => {
    const H = { 'x-callback-token': 'cb-token-123' };
    const ev = (body: unknown, h: Record<string, string> = H) => x().parseLinkEvent(JSON.stringify(body), h);
    assert.deepEqual(ev({ event: 'payment_method.activated', data: { id: 'pm-1', status: 'ACTIVE', type: 'EWALLET' } }), { linkRef: 'pm-1', status: 'active', event: 'payment_method.activated' });
    assert.deepEqual(ev({ event: 'payment_method.expired', data: { id: 'pm-1', status: 'EXPIRED' } }), { linkRef: 'pm-1', status: 'ended', event: 'payment_method.expired' });
    assert.equal(ev({ event: 'payment_method.expired', data: { id: 'pm-2', status: 'INACTIVE' } })?.status, 'ended');
    assert.deepEqual(ev({ event: 'payment_token.activation', data: { payment_token_id: 'pt-1', status: 'ACTIVE' } }), { linkRef: 'pt-1', status: 'active', event: 'payment_token.activation' });
    assert.equal(ev({ event: 'payment_token.expiry', data: { payment_token_id: 'pt-1', status: 'EXPIRED' } })?.status, 'ended');
    assert.equal(ev({ event: 'payment_token.failure', data: { payment_token_id: 'pt-2', status: 'FAILED', failure_code: 'AUTHENTICATION_FAILED' } })?.status, 'failed');
    assert.equal(ev({ event: 'payment_method.expired', data: { id: 'pm-1', status: 'EXPIRED' } }, { 'x-callback-token': 'wrong-token-1' }), null, 'wrong callback token');
    assert.equal(ev({ event: 'payment.capture', data: { reference_id: 'ps-1', status: 'SUCCEEDED' } }), null, 'a payment is not a link event');
  });
  test('a post-pay charge that waited for the driver: the reason from Midtrans and from the failure codes Xendit documents', () => {
    const kind = (s: string) => postpayFailureNote(s).split(':')[0];
    assert.deepEqual(
      ['expire', 'EXPIRED', 'FAILED PAYMENT_REQUEST_EXPIRED', 'FAILED USER_DID_NOT_AUTHORIZE', 'deny', 'FAILED USER_DECLINED_PAYMENT', 'FAILED USER_DECLINED_THE_TRANSACTION', 'cancel', 'CANCELED', 'FAILED INSUFFICIENT_BALANCE', 'failure', 'FAILED CHANNEL_UNAVAILABLE'].map(kind),
      ['pin expired', 'pin expired', 'pin expired', 'pin expired', 'pin denied', 'pin denied', 'pin denied', 'pin cancelled', 'pin cancelled', 'the e-wallet charge was not completed (FAILED INSUFFICIENT_BALANCE)', 'the e-wallet charge was not completed (failure)', 'the e-wallet charge was not completed (FAILED CHANNEL_UNAVAILABLE)'],
    );
  });
  test('v3 saved-card charges needing 3-D Secure read the redirect from actions[].value (the documented shape)', async () => {
    answers.set('/v3/payment_requests', { status: 201, body: { payment_request_id: 'pr-3ds', status: 'REQUIRES_ACTION', actions: [{ type: 'REDIRECT_CUSTOMER', descriptor: 'WEB_URL', value: 'https://3ds.xendit.test/v' }] } });
    const s = await x().chargeSavedCard({ referenceId: 'r', amountIdr: 50_000, token: 'pt_card', preauth: true, returnUrl: 'https://p.example/', customerId: 'drv-1' });
    assert.deepEqual({ s: s.status, url: s.checkoutUrl }, { s: 'pending', url: 'https://3ds.xendit.test/v' });
  });
  test('masked account; linking is off until the operator turns it on, and only where the e-wallets exist', () => {
    assert.equal(maskAccount('+6281234567890'), '••••7890');
    for (const id of ['midtrans', 'xendit', 'mock']) assert.equal(providerDef('payments', id)!.fields.find((f) => f.key === 'linkWallets')?.default, false, id);
    assert.ok(!providerDef('payments', 'snap')!.fields.some((f) => f.key === 'linkWallets'));
    assert.deepEqual([new MidtransProvider({ environment: 'sandbox', serverKey: 'k' }).linkableWallets(), x().linkableWallets()], [['GOPAY'], ['OVO', 'DANA', 'SHOPEEPAY', 'LINKAJA', 'GOPAY']]);
  });
});

describe('payment methods setting', () => {
  test('each acquirer offers what it supports; bank-direct SNAP is QRIS only', () => {
    const opts = (id: string) => providerDef('payments', id)!.fields.find((f) => f.key === 'methods')?.options?.map((o) => o.value);
    assert.deepEqual(opts('midtrans'), ['QRIS', 'GOPAY', 'SHOPEEPAY', 'CARD']);
    assert.deepEqual(opts('xendit'), ['QRIS', 'GOPAY', 'OVO', 'DANA', 'SHOPEEPAY', 'LINKAJA', 'CARD']);
    assert.equal(opts('snap'), undefined);
    assert.deepEqual(providerDef('payments', 'midtrans')!.fields.find((f) => f.key === 'methods')!.default, ['QRIS']);
  });
});

describe('Bank direct (SNAP)', () => {
  test('notification signed by the bank\'s key over POST:path:sha256(body):timestamp; tampering is caught', () => {
    const bank = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const mine = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const p = new SnapQrisProvider({
      baseUrl: base, partnerId: 'P', clientId: 'C', clientSecret: 'S', merchantId: 'M',
      privateKeyPem: mine.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      bankPublicKeyPem: bank.publicKey.export({ type: 'spki', format: 'pem' }) as string,
    });
    const body = JSON.stringify({ originalPartnerReferenceNo: 'PSABC', latestTransactionStatus: '00', amount: { value: '10000.00', currency: 'IDR' } });
    const ts = '2026-09-27T10:00:00+07:00';
    const path = '/pay/notify/key123';
    const sig = createSign('RSA-SHA256').update(`POST:${path}:${createHash('sha256').update(body).digest('hex')}:${ts}`).sign(bank.privateKey, 'base64');
    const n = p.parseNotification(body, { 'x-signature': sig, 'x-timestamp': ts }, path);
    assert.deepEqual({ ref: n?.providerRef, paid: n?.paid, amount: n?.amountIdr }, { ref: 'PSABC', paid: true, amount: 10_000 });
    assert.equal(p.parseNotification(body.replace('10000.00', '1.00'), { 'x-signature': sig, 'x-timestamp': ts }, path), null);
    assert.equal(p.parseNotification(body, { 'x-signature': sig, 'x-timestamp': ts }, '/other'), null, 'the path is signed');
    assert.equal(p.notificationAck(true).body.responseCode, '2005200');
  });
});

describe('sign-in code senders', () => {
  test('WhatsApp: the authentication template with the code in the body and the copy-code button', async () => {
    answers.set('/v20.0/123/messages', { status: 200, body: { messages: [{ id: 'wamid.1' }] } });
    const r = await senderFor({ provider: 'whatsapp_cloud', settings: { phoneNumberId: '123', templateName: 'plugsure_otp', language: 'id', copyCodeButton: true, baseUrl: base }, secrets: { accessToken: 'EAAG' } }).send('+6281234567890', '482913');
    assert.equal(r.messageId, 'wamid.1');
    const b = JSON.parse(last().body);
    assert.equal(b.to, '6281234567890');
    assert.equal(b.template.name, 'plugsure_otp');
    assert.equal(b.template.components[0].parameters[0].text, '482913');
    assert.equal(b.template.components[1].sub_type, 'url');
    assert.equal(last().headers.authorization, 'Bearer EAAG');
  });
  test('Twilio: form-encoded, To in E.164, the Indonesian text, Basic auth', async () => {
    answers.set('/2010-04-01/Accounts/AC1/Messages.json', { status: 201, body: { sid: 'SM1' } });
    const r = await senderFor({ provider: 'twilio', settings: { accountSid: 'AC1', from: 'PlugSure', baseUrl: base }, secrets: { authToken: 'tok' } }).send('+6281234567890', '111222');
    assert.equal(r.messageId, 'SM1');
    const f = new URLSearchParams(last().body);
    assert.equal(f.get('To'), '+6281234567890');
    assert.equal(f.get('From'), 'PlugSure');
    assert.equal(f.get('Body'), OTP_TEXT('111222'));
    assert.equal(last().headers.authorization, 'Basic ' + Buffer.from('AC1:tok').toString('base64'));
  });
  test('Zenziva and your own gateway; a refusal is reported, not thrown', async () => {
    answers.set('/zenziva', { status: 200, body: { status: '1', text: 'Success', messageId: 77 } });
    assert.equal((await senderFor({ provider: 'zenziva', settings: { userkey: 'u', endpoint: `${base}/zenziva` }, secrets: { passkey: 'p' } }).send('+6281234567890', '123456')).ok, true);
    assert.equal(new URLSearchParams(last().body).get('to'), '6281234567890');
    answers.set('/gw', { status: 500, body: { message: 'down' } });
    const g = await senderFor({ provider: 'http', settings: { url: `${base}/gw`, channel: 'whatsapp' }, secrets: { token: 't' } }).send('+6281234567890', '123456');
    assert.equal(g.ok, false);
    assert.match(g.error!, /500 down/);
    assert.equal(JSON.parse(last().body).code, '123456');
  });
});
