// PlugSure v1.3 — post-pay with linked e-wallets: charge what the session cost after it ends, end to end.
//
// On a raw OCPP 1.6 charger with real sessions:
//   - Sandbox acquirer with linking and post-pay on: a session started with nothing
//     charged (the amount is its limit), the rated total charged to the linked GoPay
//     afterwards, no refund; the receipt says so; above the operator's limit the
//     e-wallet is charged up front instead; an unused post-pay session is released by
//     the worker with nothing charged.
//   - Midtrans (a local fake, GoPay Tokenization): the balance checked before
//     starting; a charge refused after the session → unpaid, listed in the console,
//     the driver's next e-wallet payment taken up front; the driver pays from the
//     receipt; a charge that needs the GoPay PIN waits for the driver and is settled
//     by Midtrans' signed notification; after an upgrade to GoPay Tabungan its balance is
//     the one checked (never PAY_LATER credit) and the charge uses the token Get Pay
//     Account gives at that moment; a link ended in GoPay (unlinked or expired) after the session:
//     nothing sent, the receipt and "pay now" say to link again, and after linking again "pay now"
//     charges the new link; ended before a session: refused with the same message.
//   - Xendit (a local fake): the OVO, DANA and ShopeePay balances it reports on the linked
//     payment method checked before a post-pay session; LinkAja reporting none starts
//     unchecked, or — with "post-pay only when the balance can be checked" — is charged up front;
//     GoPay linked through Xendit (a v3 payment token) with its balance from token_details, and a
//     one-time GoPay payment through Xendit; OVO unlinked in the app after a session (the receipt and
//     "pay now" say to link again, then paid once linked again) and an expired DANA link refused at the start;
//     ShopeePay unlinked after a session, then paid once linked again; an expired LinkAja link charged up
//     front, refused by Xendit, with the same message; Xendit's link callbacks (an expiry ending a link at once, an activation
//     completing a pending one, a forged callback refused); a Midtrans post-pay session whose GoPay link ended paid in the
//     app by QRIS (the GoPay retries stopped, then nothing more charged by "pay now"); a charge refused for insufficient
//     balance paid in the app by QRIS, and the race where "pay now" pays first and the later QRIS payment is refunded; a session
//     waiting for the GoPay PIN paid by QRIS instead (the GoPay charge cancelled), and the PIN confirmed anyway refunded; an expired
//     denied or cancelled PIN confirmation paid in the app, an abandoned in-app payment after which the retries resume, and a retry cancelling the old unconfirmed PIN charge before asking for a new one.
// Everything the test sets is removed at the end.
//
// Needs E2E_DATABASE_URL (the runtime role).
//     npx tsx tools/e2e/postpay-e2e.mts
// NEVER point this at production.
import http from 'node:http';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const OCPP = process.env.E2E_OCPP ?? 'ws://127.0.0.1:9220/ocpp';
const results: boolean[] = [];
const check = (label: string, ok: boolean, detail: unknown = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 900)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000, every = 400): Promise<T> {
  const t0 = Date.now(); let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) { await sleep(every); v = await fn(); }
  return v;
}
function session() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown) => {
    const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
    const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
    return { status: r.status, data: d, text: t };
  };
}
const ops = session();
const raw = async (path: string, body: string, headers: Record<string, string> = {}) => {
  const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, redirect: 'manual' });
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d };
};

// ------------------------------------------------------------ a fake Midtrans (GoPay Tokenization)
const SERVER_KEY = 'SB-Mid-server-E2E-POSTPAY-31cf';
const calls: Array<{ path: string; body: string; at: number }> = [];
const behaviour = { failNext: 0, pinNext: 0 };
// The linked GoPay account as Get Pay Account reports it; the test changes it (an upgrade to Tabungan, a disabled link).
// The Xendit payment methods' states (the test ends a link: INACTIVE when unlinked in the app, EXPIRED).
const methodStatus: Record<string, string> = { 'pm-ovo': 'ACTIVE', 'pm-dana': 'ACTIVE', 'pm-shopeepay': 'ACTIVE', 'pm-linkaja': 'ACTIVE' };
const gopayAccount: { status: string; options: unknown[] } = { status: 'ENABLED', options: [{ name: 'GOPAY_WALLET', active: true, token: 'pp-tok', balance: { value: '100000.00', currency: 'IDR' } }] };
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0]!;
    calls.push({ path, body, at: Date.now() });
    const send = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    const j = body ? JSON.parse(body) : {};
    if (path === '/v2/pay/account') return send(201, { status_code: '201', account_id: 'acc-pp', account_status: 'PENDING', actions: [{ name: 'activation-link-url', url: 'https://gopay.test/link/acc-pp' }] });
    if (path === '/v2/pay/account/acc-pp') return send(200, { account_id: 'acc-pp', account_status: gopayAccount.status, metadata: { payment_options: gopayAccount.options } });
    if (path === '/v2/charge' && j.payment_type === 'qris') return send(201, { status_code: '201', transaction_id: `tx-${j.transaction_details.order_id}`, qr_string: `00020101MIDTRANS${j.transaction_details.order_id}` });
    if (path === '/v2/charge' && j.payment_type === 'gopay') {
      const o = j.transaction_details.order_id;
      if (behaviour.failNext > 0) { behaviour.failNext--; return send(200, { status_code: '202', status_message: 'Transaction is denied: insufficient balance' }); }
      if (behaviour.pinNext > 0) { behaviour.pinNext--; return send(200, { status_code: '201', transaction_status: 'pending', transaction_id: `tx-${o}`, actions: [{ name: 'verification-link-url', url: `https://gopay.test/pin/${o}` }] }); }
      return send(200, { status_code: '200', transaction_status: 'settlement', transaction_id: `tx-${o}` });
    }
    if (/^\/v2\/.+\/cancel$/.test(path)) return send(200, { status_code: '200', transaction_status: 'cancel' });
    if (/^\/v2\/.+\/refund$/.test(path)) return send(200, { status_code: '200', refund_key: j.refund_key });
    // Xendit: reusable e-wallet payment methods, with the balance on the linked account (OVO Rp 80,000, DANA Rp 20,000).
    if (path === '/v2/payment_methods') { const id = `pm-${String(j.ewallet.channel_code).toLowerCase()}`; return send(201, { id, status: 'REQUIRES_ACTION', actions: [{ action: 'AUTH', url: `https://xendit.test/auth/${id}` }] }); }
    if (path === '/v2/payment_methods/pm-ovo') return send(200, { id: 'pm-ovo', status: methodStatus['pm-ovo'], ewallet: { channel_code: 'OVO', account: { account_details: '••••7890', balance: 80000 } } });
    if (path === '/v2/payment_methods/pm-dana') return send(200, { id: 'pm-dana', status: methodStatus['pm-dana'], ewallet: { channel_code: 'DANA', account: { balance: 20000 } } });
    if (path === '/v2/payment_methods/pm-shopeepay') return send(200, { id: 'pm-shopeepay', status: methodStatus['pm-shopeepay'], ewallet: { channel_code: 'SHOPEEPAY', account: { balance: 30000 } } });
    if (path === '/v2/payment_methods/pm-linkaja') return send(200, { id: 'pm-linkaja', status: methodStatus['pm-linkaja'], ewallet: { channel_code: 'LINKAJA', account: { account_details: '••••7890' } } });
    // Xendit v3: GoPay payment tokens (balance in token_details) and payment requests.
    if (path === '/v3/payment_tokens') return send(201, { payment_token_id: 'pt-gopay', status: 'REQUIRES_ACTION', actions: [{ type: 'REDIRECT_CUSTOMER', descriptor: 'WEB_URL', value: 'https://gopay.test/link/pt-gopay' }] });
    if (path === '/v3/payment_tokens/pt-gopay') return send(200, { payment_token_id: 'pt-gopay', status: 'ACTIVE', token_details: { account_name: 'E2E', account_balance: 40000 } });
    if (path === '/v3/payment_requests' && j.payment_token_id) return send(201, { payment_request_id: `pr-${j.reference_id.slice(3, 15)}`, status: 'SUCCEEDED' });
    if (path === '/v3/payment_requests' && j.channel_code === 'GOPAY') return send(201, { payment_request_id: `pr-${j.reference_id.slice(3, 15)}`, status: 'REQUIRES_ACTION', actions: [{ type: 'REDIRECT_CUSTOMER', descriptor: 'WEB_URL', value: `https://gopay.test/pay/${j.reference_id}` }] });
    if (path === '/payment_requests' && methodStatus[j.payment_method_id] && methodStatus[j.payment_method_id] !== 'ACTIVE') return send(400, { error_code: 'PAYMENT_METHOD_NOT_ACTIVE', message: 'The payment method is not active' });
    if (path === '/payment_requests') return send(201, { id: `pr-${j.reference_id.slice(3, 15)}`, status: 'SUCCEEDED' });
    send(404, { error: 'no such fake' });
  });
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
const FAKE = `http://127.0.0.1:${(fake.address() as any).port}`;
const callsTo = (re: RegExp, after = 0) => calls.filter((c) => re.test(c.path) && c.at >= after);

const pg = process.env.E2E_DATABASE_URL ? new ((await import('pg')).default.Client)({ connectionString: process.env.E2E_DATABASE_URL }) : null;
if (pg) await pg.connect();
const contract: string[] = [];
const cleanup: Array<() => Promise<unknown>> = [];

try {
  if (!pg) throw new Error('set E2E_DATABASE_URL (the runtime role)');
  const spec = (await ops('GET', '/openapi.json')).data;
  const ajv = new (Ajv2020 as any)({ strict: false, allErrors: true });
  (addFormats as any)(ajv);
  ajv.addSchema({ $id: 'spec', components: spec.components });
  const cc = (path: string, method: string, status: string, body: unknown) => {
    const s = spec.paths[path]?.[method]?.responses?.[status]?.content?.['application/json']?.schema;
    if (!s) { contract.push(`no documented ${status} schema for ${method} ${path}`); return; }
    const v = ajv.compile(JSON.parse(JSON.stringify(s).replace(/"#\/components\//g, '"spec#/components/')));
    if (!v(body)) contract.push(`${method} ${path}: ${v.errors.slice(0, 3).map((e: any) => `${e.instancePath} ${e.message}`).join('; ')}`);
  };

  // ================================================================ setup
  await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  await ops('DELETE', '/v1/integrations/payments?scope=org');
  cleanup.push(() => ops('DELETE', '/v1/integrations/payments?scope=org'));
  const site = await ops('POST', '/v1/sites', { name: 'Post-pay E2E Hub', address: 'Jl. Rasuna Said', kabupatenKotaCode: '3171', gridTariffGroup: 'L/TR', connectedKva: '197', powerFactor: '0.95', phases: '3', pbjtRateBps: '1000' });
  const tariff = await ops('POST', '/v1/tariffs', { name: 'Post-pay E2E DC', plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, pricingModel: 'flat', appliesToMaxPowerW: 60000, ppnApplies: true, components: [{ kind: 'energy', rate: 2400, touBlock: 'ANY' }] });
  await ops('PUT', `/v1/sites/${site.data.id}/tariff`, { tariffId: tariff.data.tariffId, currentType: 'DC' });
  const ID = `PPAY-${Date.now().toString().slice(-6)}`;
  await ops('POST', '/v1/charge-points', { ocppIdentity: ID, siteId: site.data.id, displayName: 'Post-pay E2E', ocppVersion: 'ocpp1.6', evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] }] });
  await ops('POST', `/v1/charge-points/${ID}/activate`);
  const ws = new WebSocket(`${OCPP}/${ID}`, ['ocpp1.6']);
  await new Promise<void>((r) => ws.once('open', () => r()));
  ws.on('message', (m) => { const f = JSON.parse(m.toString()); if (f[0] === 2) ws.send(JSON.stringify([3, f[1], { status: 'Accepted' }])); });
  let n = 0; const call = (a: string, p: unknown) => new Promise<any>((res) => { const id = `p${++n}`; const on = (m: any) => { const f = JSON.parse(m.toString()); if (f[1] === id) { ws.off('message', on); res(f[2]); } }; ws.on('message', on); ws.send(JSON.stringify([2, id, a, p])); });
  await call('BootNotification', { chargePointVendor: 'E2E', chargePointModel: 'PPAY' });
  await call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: new Date().toISOString() });
  cleanup.push(async () => ws.close());
  let meter = 300_000;
  const runSession = async (idTag: string, wh: number) => {
    const st = await call('StartTransaction', { connectorId: 1, idTag, meterStart: meter, timestamp: new Date().toISOString() });
    meter += wh;
    await call('StopTransaction', { transactionId: st.transactionId, idTag, meterStop: meter, timestamp: new Date(Date.now() + 60_000).toISOString(), reason: 'EVDisconnected' });
    await call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: new Date().toISOString() });
  };
  const dev = (await raw('/d/v1/device', '{}')).data.deviceToken as string;
  const d = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${API}/d${path}`, { method, headers: { authorization: `Bearer ${dev}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let j: any = t; try { j = JSON.parse(t); } catch {} return { status: r.status, data: j };
  };
  const phone = `0821${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const otp = await d('POST', '/v1/otp/send', { phone });
  await d('POST', '/v1/otp/verify', { phone, code: otp.data.devCode });
  const stations = await until(() => d('GET', '/v1/stations'), (r) => !!r.data.stations?.find((s: any) => s.siteId === site.data.id)?.connectors?.[0], 20_000, 800);
  const conn = stations.data.stations.find((s: any) => s.siteId === site.data.id).connectors[0].connectorId;
  const intentOfCharge = async (chargeId: string) => (await pg.query(
    `SELECT pi.id, pi.mode, pi.state, pi.hold_state, pi.provider_ref, pi.amount_authorised_idr, pi.amount_captured_idr, pi.hold_capture_idr, pi.hold_error, pi.refund_state, pi.session_id, pi.checkout_url
       FROM driver_charge dc JOIN payment_intent pi ON pi.id = dc.payment_intent_id WHERE dc.id = $1`, [chargeId])).rows[0];
  // While the driver pays in the app, the automatic e-wallet retries pause until that payment could no longer complete (~35 min).
  const paused = (t: any) => !!t && new Date(t).getTime() - Date.now() > 30 * 60_000;
  const cdrTotal = async (sessionId: string) => Number((await pg.query(`SELECT total_idr FROM cdr WHERE session_id = $1`, [sessionId])).rows[0]?.total_idr ?? -1);

  // ================================================================ sandbox
  const sb = await ops('PUT', '/v1/integrations/payments', { provider: 'mock', settings: { methods: ['QRIS', 'GOPAY', 'OVO'], linkWallets: true, walletPostpay: true, postpayLimitIdr: 100000 } });
  cc('/v1/integrations/{kind}', 'put', '200', sb.data);
  const q0 = await until(() => d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 50_000 }), (r) => (r.data.linkableWallets ?? []).length > 0, 20_000, 1000);
  const link = await d('POST', '/v1/wallets', { connectorId: conn, channel: 'GOPAY' });
  await raw(`/pay/sandbox/link/${link.data.activationUrl.split('/').pop().split('?')[0]}/approve`, '', { accept: 'application/json' });
  await d('GET', `/v1/wallets/${link.data.id}`);
  const q1 = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 50_000 });
  const wid = q1.data.linkedWallets?.[0]?.id;
  check('post-pay is offered only once an e-wallet is linked: with the operator\'s limit and nothing blocking',
    q0.data.walletPostpay === false && q1.data.walletPostpay === true && q1.data.postpayLimitIdr === 100_000 && q1.data.postpayBlocked === null && !!wid, { q0: q0.data.walletPostpay, q1: q1.data });

  const p1 = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 50_000, walletId: wid });
  const i1 = await intentOfCharge(p1.data.chargeId);
  const go1 = await d('POST', `/v1/charge/${p1.data.chargeId}/start`);
  check('started with nothing charged: post-pay, the amount is the limit, the session may start at once',
    p1.status === 200 && p1.data.payment.postpay === true && p1.data.payment.action === 'done' && i1.mode === 'postpay' && i1.state === 'authorised' && i1.hold_state === 'held'
      && i1.amount_authorised_idr === 50_000 && i1.amount_captured_idr === null && /^postpay-/.test(i1.provider_ref) && go1.status === 200, { p1: p1.data.payment, i1, go1: go1.data });
  await runSession(p1.data.startToken, 5_000);
  const i1b = await until(() => intentOfCharge(p1.data.chargeId), (i) => i.hold_state === 'captured', 20_000, 500);
  const total1 = await cdrTotal(i1b.session_id);
  const rc1 = await d('GET', `/v1/charge/${p1.data.chargeId}/receipt`);
  check('after the session the rated total is charged to the linked GoPay — no more, no refund; the receipt says "paid after charging"',
    total1 > 0 && total1 < 50_000 && i1b.state === 'captured' && i1b.amount_captured_idr === total1 && i1b.refund_state === null
      && rc1.data.settlement?.postpay?.chargedIdr === total1 && rc1.data.settlement.postpay.unpaid === false && rc1.data.settlement.refundIdr === 0, { i1b, total1, rc: rc1.data.settlement });

  const big = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 150_000, walletId: wid });
  const ib = await intentOfCharge(big.data.chargeId);
  check('above the operator\'s post-pay limit the linked e-wallet is charged up front instead', big.status === 200 && big.data.payment.postpay === false && ib.mode === 'prepurchase' && ib.state === 'captured' && ib.amount_captured_idr === 150_000, { big: big.data.payment, ib });

  const p3 = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 30_000, walletId: wid });
  const i3a = await intentOfCharge(p3.data.chargeId);
  await pg.query(`UPDATE payment_intent SET created_at = now() - interval '40 minutes' WHERE id = $1`, [i3a.id]);
  const i3 = await until(() => intentOfCharge(p3.data.chargeId), (i) => i.hold_state === 'released', 100_000, 2000);
  const st3 = await d('GET', `/v1/charge/${p3.data.chargeId}/status`);
  check('an unused post-pay session is released by the worker with nothing charged', i3.hold_state === 'released' && i3.state === 'voided' && i3.amount_captured_idr === null && st3.data.state === 'released', { i3, st3: st3.data.state });

  // ================================================================ Midtrans: balance, a refused charge, the PIN
  await ops('PUT', '/v1/integrations/payments', { provider: 'midtrans', settings: { environment: 'sandbox', baseUrl: FAKE, methods: ['QRIS', 'GOPAY'], linkWallets: true, walletPostpay: true, postpayLimitIdr: 200000 }, secrets: { serverKey: SERVER_KEY } });
  await until(() => d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 50_000 }), (r) => JSON.stringify(r.data.linkableWallets) === '["GOPAY"]', 20_000, 1000);
  const ml = await d('POST', '/v1/wallets', { connectorId: conn, channel: 'GOPAY' });
  await d('GET', `/v1/wallets/${ml.data.id}`);
  const mq = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 60_000 });
  const mw = mq.data.linkedWallets?.[0]?.id;
  const tooMuch = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 150_000, walletId: mw });
  check('Midtrans: the GoPay balance (Rp 100,000) is checked before a post-pay session: a larger limit is refused, naming the balance',
    mq.data.walletPostpay === true && tooMuch.status === 422 && /Saldo GoPay/.test(tooMuch.data.error) && /100\.000/.test(tooMuch.data.error), { mq: mq.data, tooMuch: tooMuch.data });

  const m1 = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 60_000, walletId: mw });
  await d('POST', `/v1/charge/${m1.data.chargeId}/start`);
  behaviour.failNext = 1;
  const t1 = Date.now();
  await runSession(m1.data.startToken, 6_000);
  const mf = await until(() => intentOfCharge(m1.data.chargeId), (i) => i.hold_state === 'capture_failed', 20_000, 500);
  const total2 = await cdrTotal(mf.session_id);
  const firstCharge = JSON.parse(callsTo(/^\/v2\/charge$/, t1)[0]?.body ?? '{}');
  const blockedQ = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 20_000 });
  const upFront = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 20_000, walletId: mw });
  const holds = await ops('GET', '/v1/card-holds');
  cc('/v1/card-holds', 'get', '200', holds.data);
  const listed = holds.data.holds?.find((h: any) => h.id === mf.id);
  const rcF = await d('GET', `/v1/charge/${m1.data.chargeId}/receipt`);
  check('a charge refused after the session (insufficient balance): unpaid on the receipt, listed as post-pay in the console; the next payment is taken up front',
    firstCharge.gopay?.account_id === 'acc-pp' && firstCharge.transaction_details?.gross_amount === total2 && /insufficient/.test(mf.hold_error ?? '') && blockedQ.data.postpayBlocked === 'unpaid'
      && upFront.status === 200 && upFront.data.payment.postpay === false && listed?.kind === 'postpay' && listed.state === 'capture_failed' && rcF.data.settlement?.postpay?.unpaid === true,
    { firstCharge, mf, blocked: blockedQ.data.postpayBlocked, upFront: upFront.data.payment, listed, rc: rcF.data.settlement });
  const payNow = await d('POST', `/v1/charge/${m1.data.chargeId}/pay-now`);
  const mp = await intentOfCharge(m1.data.chargeId);
  const afterQ = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 20_000 });
  check('the driver pays from the receipt: charged again for the total, paid, and post-pay is open again',
    payNow.status === 200 && payNow.data.paid === true && mp.hold_state === 'captured' && mp.amount_captured_idr === total2 && afterQ.data.postpayBlocked === null, { payNow: payNow.data, mp, blocked: afterQ.data.postpayBlocked });

  const m2 = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 40_000, walletId: mw });
  await d('POST', `/v1/charge/${m2.data.chargeId}/start`);
  behaviour.pinNext = 1;
  await runSession(m2.data.startToken, 4_000);
  const pin = await until(() => intentOfCharge(m2.data.chargeId), (i) => i.hold_state === 'capturing' && !!i.checkout_url, 20_000, 500);
  const total3 = await cdrTotal(pin.session_id);
  const rcP = await d('GET', `/v1/charge/${m2.data.chargeId}/receipt`);
  const payNowPin = await d('POST', `/v1/charge/${m2.data.chargeId}/pay-now`);
  const o = pin.provider_ref;
  const sig = createHash('sha512').update(`${o}200${total3}.00${SERVER_KEY}`).digest('hex');
  const note = await raw(`/pay/notify/${(await pg.query(`SELECT webhook_key FROM integration WHERE provider = 'midtrans' AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1`)).rows[0].webhook_key}`,
    JSON.stringify({ order_id: o, status_code: '200', gross_amount: `${total3}.00`, transaction_status: 'settlement', transaction_id: `tx-${o}`, payment_type: 'gopay', signature_key: sig }));
  const pinDone = await intentOfCharge(m2.data.chargeId);
  check('a charge that needs the GoPay PIN waits for the driver (the receipt and "pay now" give the confirmation link); Midtrans\' signed notification settles it',
    rcP.data.settlement?.postpay?.checkoutUrl === `https://gopay.test/pin/${o}` && payNowPin.data.checkoutUrl === `https://gopay.test/pin/${o}` && note.status === 200
      && pinDone.hold_state === 'captured' && pinDone.state === 'captured' && pinDone.amount_captured_idr === total3, { pin, rc: rcP.data.settlement, payNowPin: payNowPin.data, note, pinDone });

  // The driver upgrades to GoPay Tabungan after linking: the wallet option goes inactive, the savings
  // option has a new token and Rp 45,000; PAY_LATER (credit) must never count as balance or be charged.
  gopayAccount.options = [
    { name: 'PAY_LATER', active: true, token: 'pp-paylater', balance: { value: '3000000.00', currency: 'IDR' } },
    { name: 'GOPAY_WALLET', active: false, token: 'pp-tok', balance: { value: '100000.00', currency: 'IDR' } },
    { name: 'GOPAY_SAVINGS', active: true, token: 'pp-sav-tok', balance: { value: '45000.00', currency: 'IDR' } }];
  const savOver = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 60_000, walletId: mw });
  const m3 = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 40_000, walletId: mw });
  await d('POST', `/v1/charge/${m3.data.chargeId}/start`);
  const t3 = Date.now();
  await runSession(m3.data.startToken, 3_000);
  const sav = await until(() => intentOfCharge(m3.data.chargeId), (i) => i.hold_state === 'captured', 20_000, 500);
  const savCharge = JSON.parse(callsTo(/^\/v2\/charge$/, t3)[0]?.body ?? '{}');
  const lookedUp = callsTo(/^\/v2\/pay\/account\/acc-pp$/, t3).length > 0;
  check('Midtrans GoPay upgraded to Tabungan: its balance (Rp 45,000) is the one checked — not PAY_LATER credit; after the session the charge uses the token Get Pay Account gives now, not the one stored at linking',
    savOver.status === 422 && savOver.data.error.includes('45.000') && m3.status === 200 && m3.data.payment.postpay === true && sav.state === 'captured'
      && lookedUp && savCharge.gopay?.payment_option_token === 'pp-sav-tok', { savOver: savOver.data, m3: m3.data.payment, sav, savCharge, lookedUp });

  // The driver unlinks PlugSure in the GoPay app between starting a post-pay session and its charge.
  gopayAccount.options = [{ name: 'GOPAY_WALLET', active: true, token: 'pp-tok', balance: { value: '100000.00', currency: 'IDR' } }];
  const m4 = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 30_000, walletId: mw });
  await d('POST', `/v1/charge/${m4.data.chargeId}/start`);
  gopayAccount.status = 'DISABLED';
  const t4 = Date.now();
  await runSession(m4.data.startToken, 3_000);
  const ended = await until(() => intentOfCharge(m4.data.chargeId), (i) => i.hold_state === 'capture_failed', 20_000, 500);
  const rc4 = await d('GET', `/v1/charge/${m4.data.chargeId}/receipt`);
  const payEnded = await d('POST', `/v1/charge/${m4.data.chargeId}/pay-now`);
  const qEnded = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 20_000 });
  check('a GoPay link ended in GoPay before the after-session charge: nothing sent to Midtrans; the receipt and "pay now" say the link is no longer active and to link again; GoPay is offered for linking again',
    m4.data.payment?.postpay === true && ended.hold_error?.startsWith('link ended:') && callsTo(/^\/v2\/charge$/, t4).length === 0
      && rc4.data.settlement?.postpay?.unpaid === true && rc4.data.settlement.postpay.linkEnded === true
      && payEnded.status === 409 && payEnded.data.code === 'wallet_link_ended' && /Tautan GoPay Anda sudah tidak aktif/.test(payEnded.data.error) && /Hubungkan GoPay lagi/.test(payEnded.data.error)
      && !(qEnded.data.linkedWallets ?? []).some((w: any) => w.id === mw) && (qEnded.data.linkableWallets ?? []).includes('GOPAY'),
    { m4: m4.data.payment, ended, rc: rc4.data.settlement, payEnded, linked: qEnded.data.linkedWallets, linkable: qEnded.data.linkableWallets });

  // Linked again (GoPay gives the account a new token): "pay now" charges the new link.
  gopayAccount.status = 'ENABLED';
  gopayAccount.options = [{ name: 'GOPAY_WALLET', active: true, token: 'pp-new-tok', balance: { value: '100000.00', currency: 'IDR' } }];
  const relink = await d('POST', '/v1/wallets', { connectorId: conn, channel: 'GOPAY' });
  await d('GET', `/v1/wallets/${relink.data.id}`);
  const t5 = Date.now();
  const paidAgain = await d('POST', `/v1/charge/${m4.data.chargeId}/pay-now`);
  const paidI = await intentOfCharge(m4.data.chargeId);
  const payer = (await pg.query(`SELECT driver_card_id FROM payment_intent WHERE id = $1`, [paidI.id])).rows[0]?.driver_card_id;
  const againCharge = JSON.parse(callsTo(/^\/v2\/charge$/, t5)[0]?.body ?? '{}');
  const qAgain = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 20_000 });
  const mw2 = (qAgain.data.linkedWallets ?? []).find((w: any) => w.channel === 'GOPAY')?.id;
  check('after linking GoPay again, "pay now" charges the new link: paid, and post-pay is open again',
    relink.status === 200 && paidAgain.status === 200 && paidAgain.data.paid === true && paidI.hold_state === 'captured' && paidI.amount_captured_idr === await cdrTotal(paidI.session_id)
      && payer === mw2 && againCharge.gopay?.payment_option_token === 'pp-new-tok' && qAgain.data.postpayBlocked === null,
    { relink: relink.data, paidAgain: paidAgain.data, paidI, payer, mw2, againCharge });

  // Ended again before a session starts: refused with the same message, nothing charged.
  gopayAccount.status = 'DISABLED';
  const tOff = Date.now();
  const offQ = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 20_000, walletId: mw2 });
  const qDis = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 20_000 });
  check('a GoPay link disabled in GoPay is refused at the start with "link again" (not a balance message) and nothing charged; GoPay is offered for linking again',
    offQ.status === 422 && offQ.data.code === 'wallet_link_ended' && /Tautan GoPay Anda sudah tidak aktif/.test(offQ.data.error) && !/Saldo/.test(offQ.data.error)
      && callsTo(/^\/v2\/charge$/, tOff).length === 0 && (qDis.data.linkableWallets ?? []).includes('GOPAY'), { offQ: offQ.data, linkable: qDis.data.linkableWallets });
  gopayAccount.status = 'ENABLED';

  // A post-pay session whose GoPay link ended, paid in the app with another method (QRIS).
  const relink3 = await d('POST', '/v1/wallets', { connectorId: conn, channel: 'GOPAY' });
  await d('GET', `/v1/wallets/${relink3.data.id}`);
  const q3 = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 25_000 });
  const mw3 = (q3.data.linkedWallets ?? []).find((w: any) => w.channel === 'GOPAY')?.id;
  const m5 = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 25_000, walletId: mw3 });
  await d('POST', `/v1/charge/${m5.data.chargeId}/start`);
  gopayAccount.status = 'DISABLED';
  await runSession(m5.data.startToken, 2_000);
  const e5 = await until(() => intentOfCharge(m5.data.chargeId), (i) => i.hold_state === 'capture_failed', 20_000, 500);
  const total5 = await cdrTotal(e5.session_id);
  const rc5 = await d('GET', `/v1/charge/${m5.data.chargeId}/receipt`);
  const t6 = Date.now();
  const pay5 = await d('POST', `/v1/charge/${m5.data.chargeId}/pay-unpaid`, { method: 'QRIS' });
  const st5 = await d('GET', `/v1/charge/${m5.data.chargeId}/pay-unpaid`);
  const retries5 = (await pg.query(`SELECT hold_next_attempt_at FROM payment_intent WHERE id = $1`, [e5.id])).rows[0]?.hold_next_attempt_at;
  const s5 = (await pg.query(`SELECT id, provider_ref, mode, state, channel, amount_authorised_idr, session_id FROM payment_intent WHERE settles_intent_id = $1`, [e5.id])).rows;
  const qr5 = JSON.parse(callsTo(/^\/v2\/charge$/, t6).find((c) => JSON.parse(c.body).payment_type === 'qris')?.body ?? '{}');
  check('post-pay whose GoPay link ended: the receipt offers paying in the app with the operator\'s other methods; QRIS gives a QR for exactly the rated total, as a settlement payment, and the automatic GoPay retries pause while it can be paid',
    rc5.data.settlement?.postpay?.linkEnded === true && (rc5.data.settlement.postpay.payOptions?.paymentMethods ?? []).map((m: any) => m.channel).join() === 'QRIS,GOPAY'
      && !(rc5.data.settlement.postpay.payOptions?.linkedWallets ?? []).some((w: any) => w.id === mw3)
      && pay5.status === 200 && pay5.data.paid === false && !!pay5.data.qr?.qrString && pay5.data.amountIdr === total5 && qr5.transaction_details?.gross_amount === total5
      && st5.data.kind === 'postpay' && st5.data.paid === false && st5.data.owedIdr === total5 && paused(retries5)
      && s5.length === 1 && s5[0].mode === 'settlement' && s5[0].state === 'pending' && s5[0].session_id === null,
    { pay: rc5.data.settlement?.postpay, pay5: { ...pay5.data, qr: !!pay5.data.qr }, st5: st5.data, retries5, s5, qr5 });

  const ref5 = s5[0]?.provider_ref;
  const sig5 = createHash('sha512').update(`${ref5}200${total5}.00${SERVER_KEY}`).digest('hex');
  const hook5 = `/pay/notify/${(await pg.query(`SELECT webhook_key FROM integration WHERE provider = 'midtrans' AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1`)).rows[0].webhook_key}`;
  const note5 = await raw(hook5, JSON.stringify({ order_id: ref5, status_code: '200', gross_amount: `${total5}.00`, transaction_status: 'settlement', transaction_id: `tx-${ref5}`, payment_type: 'qris', signature_key: sig5 }));
  const paid5 = await intentOfCharge(m5.data.chargeId);
  const rcPaid5 = await d('GET', `/v1/charge/${m5.data.chargeId}/receipt`);
  const qOpen = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 20_000 });
  const holds5 = await ops('GET', '/v1/card-holds');
  cc('/v1/card-holds', 'get', '200', holds5.data);
  const listed5 = holds5.data.holds?.find((h: any) => h.id === e5.id);
  // GoPay linked again, and the driver taps the old "pay now" too: nothing more is charged.
  gopayAccount.status = 'ENABLED';
  const relink4 = await d('POST', '/v1/wallets', { connectorId: conn, channel: 'GOPAY' });
  await d('GET', `/v1/wallets/${relink4.data.id}`);
  const t7 = Date.now();
  const payNow5 = await d('POST', `/v1/charge/${m5.data.chargeId}/pay-now`);
  const payAgain5 = await d('POST', `/v1/charge/${m5.data.chargeId}/pay-unpaid`, { method: 'QRIS' });
  check('Midtrans\' signed notification pays it: the session is paid in the app (receipt "paid in the app", console "link ended, paid in app"), post-pay is open again, and neither "pay now" after linking GoPay again nor paying again charges anything more',
    note5.status === 200 && paid5.hold_state === 'captured' && paid5.state === 'captured' && paid5.amount_captured_idr === total5
      && rcPaid5.data.settlement?.postpay?.paidInApp?.amountIdr === total5 && rcPaid5.data.settlement.postpay.paidInApp.channel === 'QRIS' && rcPaid5.data.settlement.postpay.unpaid === false
      && qOpen.data.postpayBlocked === null && listed5?.kind === 'postpay' && listed5.paidInApp === true
      && payNow5.status === 200 && payNow5.data.paid === true && payAgain5.status === 200 && payAgain5.data.paid === true && callsTo(/^\/v2\/charge$/, t7).length === 0,
    { note5: note5.data, paid5, rc: rcPaid5.data.settlement?.postpay, blocked: qOpen.data.postpayBlocked, listed5, payNow5: payNow5.data, payAgain5: payAgain5.data, calls: callsTo(/^\/v2\/charge$/, t7).map((c) => c.body) });

  // A post-pay charge refused for insufficient balance, paid in the app with QRIS instead.
  const q6 = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 25_000 });
  const mw6 = (q6.data.linkedWallets ?? []).find((w: any) => w.channel === 'GOPAY')?.id;
  const runRefused = async () => {
    const m = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 25_000, walletId: mw6 });
    await d('POST', `/v1/charge/${m.data.chargeId}/start`);
    behaviour.failNext = 1;
    await runSession(m.data.startToken, 2_000);
    const i = await until(() => intentOfCharge(m.data.chargeId), (x) => x.hold_state === 'capture_failed', 20_000, 500);
    return { m, i, total: await cdrTotal(i.session_id) };
  };
  const payQris = async (ref: string, total: number) => raw(hook5, JSON.stringify({ order_id: ref, status_code: '200', gross_amount: `${total}.00`, transaction_status: 'settlement', transaction_id: `tx-${ref}`, payment_type: 'qris',
    signature_key: createHash('sha512').update(`${ref}200${total}.00${SERVER_KEY}`).digest('hex') }));
  const r6 = await runRefused();
  const unpaidList6 = await d('GET', '/v1/unpaid');
  const tax6 = String((await d('GET', `/v1/charge/${r6.m.data.chargeId}/receipt.html`)).data);
  const rc6 = await d('GET', `/v1/charge/${r6.m.data.chargeId}/receipt`);
  const pay6 = await d('POST', `/v1/charge/${r6.m.data.chargeId}/pay-unpaid`, { method: 'QRIS' });
  const retries6 = (await pg.query(`SELECT hold_next_attempt_at FROM payment_intent WHERE id = $1`, [r6.i.id])).rows[0]?.hold_next_attempt_at;
  const ref6 = (await pg.query(`SELECT provider_ref FROM payment_intent WHERE settles_intent_id = $1`, [r6.i.id])).rows[0]?.provider_ref;
  const note6 = await payQris(ref6, r6.total);
  const paid6 = await intentOfCharge(r6.m.data.chargeId);
  const rcPaid6 = await d('GET', `/v1/charge/${r6.m.data.chargeId}/receipt`);
  const q6b = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 20_000 });
  const t8 = Date.now();
  const payNow6 = await d('POST', `/v1/charge/${r6.m.data.chargeId}/pay-now`);
  const unpaidAfter6 = await d('GET', '/v1/unpaid');
  const taxPaid6 = String((await d('GET', `/v1/charge/${r6.m.data.chargeId}/receipt.html`)).data);
  const rp6 = `Rp ${new Intl.NumberFormat('id-ID').format(r6.total)}`;
  check('a post-pay charge refused for insufficient balance: listed as unpaid for the home screen until paid, its tax receipt a nil transaction (Rp 0) until paid in the app, then the real one naming QRIS; the receipt says the GoPay balance is not enough and offers "pay now" or another method (GoPay itself included); paid in the app by QRIS, post-pay is open again and "pay now" charges nothing more',
    /insufficient/.test(r6.i.hold_error ?? '') && rc6.data.settlement?.postpay?.insufficient === true && rc6.data.settlement.postpay.linkEnded === false
      && (rc6.data.settlement.postpay.payOptions?.paymentMethods ?? []).map((m: any) => m.channel).join() === 'QRIS,GOPAY' && (rc6.data.settlement.postpay.payOptions?.linkedWallets ?? []).some((w: any) => w.id === mw6)
      && pay6.status === 200 && pay6.data.amountIdr === r6.total && !!pay6.data.qr?.qrString && paused(retries6)
      && note6.status === 200 && paid6.hold_state === 'captured' && paid6.amount_captured_idr === r6.total && /^charge failed: paid by the driver in the app \(QRIS/.test(paid6.hold_error ?? '')
      && rcPaid6.data.settlement?.postpay?.paidInApp?.reason === 'charge_failed' && rcPaid6.data.settlement.postpay.paidInApp.amountIdr === r6.total
      && (unpaidList6.data.unpaid ?? []).some((u: any) => u.chargeId === r6.m.data.chargeId && u.kind === 'postpay' && u.owedIdr === r6.total)
      && !(unpaidAfter6.data.unpaid ?? []).some((u: any) => u.chargeId === r6.m.data.chargeId)
      // The tax receipt: a nil transaction while unpaid (every amount Rp 0), the real one once paid, naming how.
      && tax6.includes('NIHIL / NIL') && tax6.includes('-NIL') && tax6.includes('Transaksi nihil') && !tax6.includes(rp6) && /Total dibayar \/ Total<\/td><td class="n">Rp 0</.test(tax6) && tax6.includes('Belum dibayar / Unpaid')
      && !taxPaid6.includes('NIHIL') && taxPaid6.includes(rp6) && taxPaid6.includes('Dibayar di aplikasi via QRIS')
      && q6b.data.postpayBlocked === null && payNow6.status === 200 && payNow6.data.paid === true && callsTo(/^\/v2\/charge$/, t8).length === 0,
    { i: r6.i, pay: rc6.data.settlement?.postpay, pay6: { ...pay6.data, qr: !!pay6.data.qr }, retries6, paid6, rcPaid6: rcPaid6.data.settlement?.postpay, blocked: q6b.data.postpayBlocked, payNow6: payNow6.data });

  // The race: the driver starts a QRIS payment, then tops up and taps "pay now" (GoPay pays first); the QRIS paid afterwards is refunded in full.
  const r7 = await runRefused();
  const pay7 = await d('POST', `/v1/charge/${r7.m.data.chargeId}/pay-unpaid`, { method: 'QRIS' });
  const payNow7 = await d('POST', `/v1/charge/${r7.m.data.chargeId}/pay-now`);
  const ref7 = (await pg.query(`SELECT provider_ref FROM payment_intent WHERE settles_intent_id = $1`, [r7.i.id])).rows[0]?.provider_ref;
  const note7 = await payQris(ref7, r7.total);
  const hold7 = await intentOfCharge(r7.m.data.chargeId);
  const qris7 = (await pg.query(`SELECT state, refund_state, refund_due_idr, refund_reason FROM payment_intent WHERE settles_intent_id = $1`, [r7.i.id])).rows[0];
  const rc7 = await d('GET', `/v1/charge/${r7.m.data.chargeId}/receipt`);
  check('the race: QRIS started, then "pay now" charges the topped-up GoPay first; the QRIS payment that arrives afterwards is refunded in full, and the session is paid once (by GoPay, not "paid in the app")',
    pay7.status === 200 && pay7.data.paid === false && payNow7.status === 200 && payNow7.data.paid === true && note7.status === 200
      && hold7.hold_state === 'captured' && hold7.amount_captured_idr === r7.total && hold7.hold_error === null
      && qris7?.state === 'captured' && qris7.refund_state === 'due' && qris7.refund_due_idr === r7.total && /paid twice/i.test(qris7.refund_reason ?? '')
      && rc7.data.settlement?.postpay?.paidInApp === null && rc7.data.settlement.postpay.unpaid === false,
    { pay7: pay7.data.paid, payNow7: payNow7.data, hold7, qris7, rc: rc7.data.settlement?.postpay });

  // Waiting for the GoPay PIN: the driver pays with QRIS instead. The pending GoPay charge is cancelled; confirmed anyway, it is refunded.
  const m8 = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 25_000, walletId: mw6 });
  await d('POST', `/v1/charge/${m8.data.chargeId}/start`);
  behaviour.pinNext = 1;
  await runSession(m8.data.startToken, 2_000);
  const pin8 = await until(() => intentOfCharge(m8.data.chargeId), (i) => i.hold_state === 'capturing' && !!i.checkout_url, 20_000, 500);
  const total8 = await cdrTotal(pin8.session_id);
  const pinOrder = pin8.provider_ref;
  const rc8 = await d('GET', `/v1/charge/${m8.data.chargeId}/receipt`);
  const t9 = Date.now();
  const pay8 = await d('POST', `/v1/charge/${m8.data.chargeId}/pay-unpaid`, { method: 'QRIS' });
  const after8 = await intentOfCharge(m8.data.chargeId);
  const cancelled = callsTo(new RegExp(`^/v2/${pinOrder}/cancel$`), t9).length;
  const ref8 = (await pg.query(`SELECT provider_ref FROM payment_intent WHERE settles_intent_id = $1`, [pin8.id])).rows[0]?.provider_ref;
  const note8 = await payQris(ref8, total8);
  const paid8 = await intentOfCharge(m8.data.chargeId);
  const rcPaid8 = await d('GET', `/v1/charge/${m8.data.chargeId}/receipt`);
  check('waiting for the GoPay PIN: the receipt offers confirming in GoPay or another method; paying by QRIS cancels the pending GoPay charge at Midtrans, and once paid the receipt says the session was paid in the app instead of the PIN',
    rc8.data.settlement?.postpay?.checkoutUrl === `https://gopay.test/pin/${pinOrder}` && (rc8.data.settlement.postpay.payOptions?.paymentMethods ?? []).map((m: any) => m.channel).join() === 'QRIS,GOPAY'
      && pay8.status === 200 && pay8.data.amountIdr === total8 && !!pay8.data.qr?.qrString && cancelled === 1
      && after8.hold_state === 'capture_failed' && /^pin not confirmed:/.test(after8.hold_error ?? '') && after8.checkout_url === null
      && note8.status === 200 && paid8.hold_state === 'captured' && paid8.amount_captured_idr === total8 && /^pin not confirmed: paid by the driver in the app \(QRIS/.test(paid8.hold_error ?? '')
      && rcPaid8.data.settlement?.postpay?.paidInApp?.reason === 'pin_not_confirmed',
    { pay: rc8.data.settlement?.postpay, pay8: { ...pay8.data, qr: !!pay8.data.qr }, cancelled, after8, paid8, rcPaid8: rcPaid8.data.settlement?.postpay });

  // The driver confirms the PIN anyway (the cancel did not reach GoPay in time): that GoPay charge is refunded to the e-wallet.
  const t10 = Date.now();
  const sigPin = createHash('sha512').update(`${pinOrder}200${total8}.00${SERVER_KEY}`).digest('hex');
  const pinLate = await raw(hook5, JSON.stringify({ order_id: pinOrder, status_code: '200', gross_amount: `${total8}.00`, transaction_status: 'settlement', transaction_id: `tx-${pinOrder}`, payment_type: 'gopay', signature_key: sigPin }));
  const ref8b = await until(async () => (await pg.query(`SELECT refund_state, refund_due_idr, refund_reason, hold_state, amount_captured_idr FROM payment_intent WHERE id = $1`, [pin8.id])).rows[0], // 'processing' is set just before the refund request goes out: wait for the request itself too.
    (r: any) => (r?.refund_state === 'refunded' || r?.refund_state === 'processing') && callsTo(new RegExp(`^/v2/${pinOrder}/refund$`), t10).length > 0, 10_000, 300);
  const refundCall = callsTo(new RegExp(`^/v2/${pinOrder}/refund$`), t10);
  check('the PIN confirmed after the session was paid in the app: that GoPay charge is refunded to the e-wallet automatically; the session stays paid once',
    pinLate.status === 200 && ref8b?.refund_due_idr === total8 && /paid twice/i.test(ref8b.refund_reason ?? '') && refundCall.length === 1
      && ref8b.hold_state === 'captured' && ref8b.amount_captured_idr === total8,
    { pinLate: pinLate.data, ref8b, refunds: refundCall.map((c) => c.body) });

  const midtransNote = (order: string, status: string, code: string, total: number) => raw(hook5, JSON.stringify({ order_id: order, status_code: code, gross_amount: `${total}.00`, transaction_status: status,
    transaction_id: `tx-${order}`, payment_type: 'gopay', signature_key: createHash('sha512').update(`${order}${code}${total}.00${SERVER_KEY}`).digest('hex') }));
  const pinSession = async () => {
    const m = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 25_000, walletId: mw6 });
    await d('POST', `/v1/charge/${m.data.chargeId}/start`);
    behaviour.pinNext = 1;
    await runSession(m.data.startToken, 2_000);
    const i = await until(() => intentOfCharge(m.data.chargeId), (x) => x.hold_state === 'capturing' && !!x.checkout_url, 20_000, 500);
    return { m, i, total: await cdrTotal(i.session_id) };
  };

  // The PIN confirmation expires unconfirmed (Midtrans notifies "expire"): the receipt says so, and the driver pays in the app.
  const p9 = await pinSession();
  const exp9 = await midtransNote(p9.i.provider_ref, 'expire', '407', p9.total);
  const i9 = await intentOfCharge(p9.m.data.chargeId);
  const rc9 = await d('GET', `/v1/charge/${p9.m.data.chargeId}/receipt`);
  const pay9 = await d('POST', `/v1/charge/${p9.m.data.chargeId}/pay-unpaid`, { method: 'QRIS' });
  const next9 = (await pg.query(`SELECT hold_next_attempt_at FROM payment_intent WHERE id = $1`, [p9.i.id])).rows[0]?.hold_next_attempt_at;
  const ref9 = (await pg.query(`SELECT provider_ref FROM payment_intent WHERE settles_intent_id = $1`, [p9.i.id])).rows[0]?.provider_ref;
  const note9 = await payQris(ref9, p9.total);
  const paid9 = await intentOfCharge(p9.m.data.chargeId);
  const rcPaid9 = await d('GET', `/v1/charge/${p9.m.data.chargeId}/receipt`);
  check('the GoPay PIN confirmation expires unconfirmed: the receipt says so and offers confirming again or another method; paid in the app by QRIS (the automatic new PIN request pauses meanwhile), the receipt says the PIN had expired',
    exp9.status === 200 && i9.hold_state === 'capture_failed' && /^pin expired:/.test(i9.hold_error ?? '') && i9.checkout_url === null
      && rc9.data.settlement?.postpay?.pinExpired === true && (rc9.data.settlement.postpay.payOptions?.paymentMethods ?? []).length === 2
      && pay9.status === 200 && pay9.data.amountIdr === p9.total && paused(next9)
      && note9.status === 200 && paid9.hold_state === 'captured' && /^pin expired: paid by the driver in the app \(QRIS/.test(paid9.hold_error ?? '') && rcPaid9.data.settlement?.postpay?.paidInApp?.reason === 'pin_expired',
    { i9, pay: rc9.data.settlement?.postpay, pay9: pay9.data.amountIdr, next9, paid9, rcPaid9: rcPaid9.data.settlement?.postpay });

  // A PIN never confirmed (no notification): the retry asks for a new PIN, cancelling the old pending GoPay charge first.
  const p10 = await pinSession();
  const oldOrder = p10.i.provider_ref;
  const t11 = Date.now();
  behaviour.pinNext = 1;
  await ops('POST', `/v1/card-holds/${p10.i.id}/retry`);
  const i10 = await until(() => intentOfCharge(p10.m.data.chargeId), (x) => x.provider_ref !== oldOrder && !!x.checkout_url, 10_000, 300);
  const oldCancelled = callsTo(new RegExp(`^/v2/${oldOrder}/cancel$`), t11).length;
  const done10 = await midtransNote(i10.provider_ref, 'settlement', '200', p10.total);
  const paid10 = await intentOfCharge(p10.m.data.chargeId);
  check('a PIN that was never confirmed: the retry cancels the old pending GoPay charge at Midtrans before asking for a new PIN, so only the new one can be confirmed',
    oldCancelled === 1 && i10.provider_ref !== oldOrder && i10.checkout_url === `https://gopay.test/pin/${i10.provider_ref}` && i10.hold_state === 'capturing'
      && done10.status === 200 && paid10.hold_state === 'captured' && paid10.amount_captured_idr === p10.total,
    { oldOrder, i10, oldCancelled, paid10 });

  // The driver refuses the PIN confirmation (Midtrans notifies "deny"): the receipt says so, and the driver pays in the app.
  const p12 = await pinSession();
  const deny12 = await midtransNote(p12.i.provider_ref, 'deny', '202', p12.total);
  const i12 = await intentOfCharge(p12.m.data.chargeId);
  const retry12 = (await pg.query(`SELECT hold_next_attempt_at FROM payment_intent WHERE id = $1`, [p12.i.id])).rows[0]?.hold_next_attempt_at;
  const rc12 = await d('GET', `/v1/charge/${p12.m.data.chargeId}/receipt`);
  const pay12 = await d('POST', `/v1/charge/${p12.m.data.chargeId}/pay-unpaid`, { method: 'QRIS' });
  const next12 = (await pg.query(`SELECT hold_next_attempt_at FROM payment_intent WHERE id = $1`, [p12.i.id])).rows[0]?.hold_next_attempt_at;
  const ref12 = (await pg.query(`SELECT provider_ref FROM payment_intent WHERE settles_intent_id = $1`, [p12.i.id])).rows[0]?.provider_ref;
  const note12 = await payQris(ref12, p12.total);
  const paid12 = await intentOfCharge(p12.m.data.chargeId);
  const rcPaid12 = await d('GET', `/v1/charge/${p12.m.data.chargeId}/receipt`);
  check('the driver refuses the GoPay PIN confirmation ("deny"): the receipt says so and offers confirming again or another method; paid in the app by QRIS (the scheduled new PIN request pauses meanwhile), the receipt says the PIN was refused',
    deny12.status === 200 && i12.hold_state === 'capture_failed' && /^pin denied:/.test(i12.hold_error ?? '') && retry12 !== null
      && rc12.data.settlement?.postpay?.pinDenied === true && rc12.data.settlement.postpay.pinExpired === false && (rc12.data.settlement.postpay.payOptions?.paymentMethods ?? []).length === 2
      && pay12.status === 200 && pay12.data.amountIdr === p12.total && paused(next12)
      && note12.status === 200 && paid12.hold_state === 'captured' && /^pin denied: paid by the driver in the app \(QRIS/.test(paid12.hold_error ?? '') && rcPaid12.data.settlement?.postpay?.paidInApp?.reason === 'pin_denied',
    { i12, retry12, pay: rc12.data.settlement?.postpay, next12, paid12, rcPaid12: rcPaid12.data.settlement?.postpay });

  // The driver cancels the PIN confirmation in GoPay (Midtrans notifies "cancel"): the receipt says so, and the driver pays in the app.
  const p13 = await pinSession();
  const cancel13 = await midtransNote(p13.i.provider_ref, 'cancel', '202', p13.total);
  const i13 = await intentOfCharge(p13.m.data.chargeId);
  const rc13 = await d('GET', `/v1/charge/${p13.m.data.chargeId}/receipt`);
  const pay13 = await d('POST', `/v1/charge/${p13.m.data.chargeId}/pay-unpaid`, { method: 'QRIS' });
  const ref13 = (await pg.query(`SELECT provider_ref FROM payment_intent WHERE settles_intent_id = $1`, [p13.i.id])).rows[0]?.provider_ref;
  const note13 = await payQris(ref13, p13.total);
  const paid13 = await intentOfCharge(p13.m.data.chargeId);
  const rcPaid13 = await d('GET', `/v1/charge/${p13.m.data.chargeId}/receipt`);
  // A cancel for a charge the session no longer waits for (PlugSure's own cancel of a replaced PIN, see above) changes nothing.
  const stale = await midtransNote(oldOrder, 'cancel', '202', p10.total);
  const after10 = await intentOfCharge(p10.m.data.chargeId);
  check('the driver cancels the GoPay PIN confirmation ("cancel"): the receipt says so and offers confirming again or another method; paid in the app by QRIS, the receipt says the PIN was cancelled; PlugSure\'s own cancel of a replaced PIN changes nothing',
    cancel13.status === 200 && i13.hold_state === 'capture_failed' && /^pin cancelled:/.test(i13.hold_error ?? '')
      && rc13.data.settlement?.postpay?.pinCancelled === true && rc13.data.settlement.postpay.pinDenied === false && (rc13.data.settlement.postpay.payOptions?.paymentMethods ?? []).length === 2
      && pay13.status === 200 && pay13.data.amountIdr === p13.total
      && note13.status === 200 && paid13.hold_state === 'captured' && /^pin cancelled: paid by the driver in the app \(QRIS/.test(paid13.hold_error ?? '') && rcPaid13.data.settlement?.postpay?.paidInApp?.reason === 'pin_cancelled'
      && stale.status < 500 && after10.hold_state === 'captured' && after10.hold_error === null,
    { i13, pay: rc13.data.settlement?.postpay, paid13, rcPaid13: rcPaid13.data.settlement?.postpay, stale: stale.status, after10 });

  // An in-app payment the driver abandons: the automatic GoPay retries wait while it can be paid, then resume.
  const r14 = await runRefused();
  const pay14 = await d('POST', `/v1/charge/${r14.m.data.chargeId}/pay-unpaid`, { method: 'QRIS' });
  const s14 = (await pg.query(`SELECT id FROM payment_intent WHERE settles_intent_id = $1`, [r14.i.id])).rows[0];
  // Due now while the QRIS can still be paid: the worker does not charge GoPay, it moves the retry past the QRIS's expiry.
  await pg.query(`UPDATE payment_intent SET hold_next_attempt_at = now() WHERE id = $1`, [r14.i.id]);
  const t14 = Date.now();
  const waited14 = await until(async () => (await pg.query(`SELECT hold_next_attempt_at AS at FROM payment_intent WHERE id = $1`, [r14.i.id])).rows[0]?.at,
    (at: any) => !!at && new Date(at).getTime() > Date.now() + 25 * 60_000, 90_000, 2000);
  const charged14 = callsTo(/^\/v2\/charge$/, t14).filter((c) => JSON.parse(c.body).payment_type === 'gopay').length;
  // The driver walks away: the QRIS expires, and the next automatic retry charges GoPay.
  await pg.query(`UPDATE payment_intent SET expires_at = now() - interval '10 minutes' WHERE id = $1`, [s14.id]);
  await pg.query(`UPDATE payment_intent SET hold_next_attempt_at = now() WHERE id = $1`, [r14.i.id]);
  const resumed14 = await until(() => intentOfCharge(r14.m.data.chargeId), (i) => i.hold_state === 'captured', 90_000, 2000);
  check('an in-app payment the driver abandons: while its QRIS can still be paid the automatic retry waits (no GoPay charge, retry moved past its expiry); once it has expired, the retry resumes and charges GoPay',
    pay14.status === 200 && paused(waited14) && charged14 === 0 && resumed14.hold_state === 'captured' && resumed14.amount_captured_idr === r14.total && resumed14.hold_error === null,
    { waited14, charged14, resumed14 });

  // ================================================================ Xendit: OVO and DANA balances
  await ops('PUT', '/v1/integrations/payments', { provider: 'xendit', settings: { baseUrl: FAKE, methods: ['QRIS', 'GOPAY', 'OVO', 'DANA', 'SHOPEEPAY', 'LINKAJA'], linkWallets: true, walletPostpay: true, postpayLimitIdr: 200000 }, secrets: { secretKey: 'xnd_development_POSTPAY', callbackToken: 'xendit-callback-token-postpay-e2e' } });
  await until(() => d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 20_000 }), (r) => JSON.stringify(r.data.linkableWallets) === '["OVO","DANA","SHOPEEPAY","LINKAJA","GOPAY"]', 20_000, 1000);
  for (const [ch, balance, over, under] of [['OVO', '80.000', 100_000, 50_000], ['DANA', '20.000', 30_000, 15_000], ['SHOPEEPAY', '30.000', 50_000, 20_000]] as const) {
    const lk = await d('POST', '/v1/wallets', { connectorId: conn, channel: ch });
    await d('GET', `/v1/wallets/${lk.data.id}`);
    const qx = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: under });
    const wx = (qx.data.linkedWallets ?? []).find((w: any) => w.channel === ch)?.id;
    const tX = Date.now();
    const refused = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: over, walletId: wx });
    const charged = callsTo(/^\/payment_requests$/, tX).length;
    const ok = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: under, walletId: wx });
    const io = await intentOfCharge(ok.data.chargeId);
    check(`Xendit ${ch}: the balance on the linked account (Rp ${balance}) is checked before post-pay: a larger limit refused naming it and nothing charged; a smaller one starts with nothing charged`,
      refused.status === 422 && new RegExp(`Saldo ${ch === 'SHOPEEPAY' ? 'ShopeePay' : ch}`).test(refused.data.error) && refused.data.error.includes(balance) && charged === 0
        && ok.status === 200 && ok.data.payment.postpay === true && io.mode === 'postpay' && io.state === 'authorised', { refused: refused.data, charged, ok: ok.data.payment, io });
    // Post-pay exposure counts every session still held on the same e-wallet against its balance, so the
    // ShopeePay checks below need this unused session released first (as the worker does after the claim window).
    if (ch === 'SHOPEEPAY') {
      await pg.query(`UPDATE payment_intent SET created_at = now() - interval '40 minutes' WHERE id = $1`, [io.id]);
      await until(() => intentOfCharge(ok.data.chargeId), (i) => i.hold_state === 'released', 100_000, 2000);
    }
  }

  // LinkAja reports no balance: post-pay starts unchecked, or — when the operator requires a checked balance — it is charged up front.
  const lj = await d('POST', '/v1/wallets', { connectorId: conn, channel: 'LINKAJA' });
  await d('GET', `/v1/wallets/${lj.data.id}`);
  const qOff = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 20_000 });
  const ljw = (qOff.data.linkedWallets ?? []).find((w: any) => w.channel === 'LINKAJA');
  const ljOff = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 20_000, walletId: ljw?.id });
  const ljOffI = await intentOfCharge(ljOff.data.chargeId);
  check('LinkAja without a reported balance, switch off: post-pay starts without the check',
    ljw?.postpay === true && ljOff.status === 200 && ljOff.data.payment.postpay === true && ljOffI.mode === 'postpay', { ljw, ljOff: ljOff.data.payment });
  const need = await ops('PUT', '/v1/integrations/payments', { provider: 'xendit', settings: { baseUrl: FAKE, methods: ['QRIS', 'GOPAY', 'OVO', 'DANA', 'SHOPEEPAY', 'LINKAJA'], linkWallets: true, walletPostpay: true, postpayLimitIdr: 200000, postpayNeedsBalance: true } });
  const qOn = await until(() => d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 20_000 }), (r) => (r.data.linkedWallets ?? []).some((w: any) => w.channel === 'LINKAJA' && w.postpay === false), 20_000, 1000);
  const flags = Object.fromEntries((qOn.data.linkedWallets ?? []).map((w: any) => [w.channel, w.postpay]));
  const tL = Date.now();
  const ljOn = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 20_000, walletId: ljw?.id });
  const ljOnI = await intentOfCharge(ljOn.data.chargeId);
  const ljCharge = JSON.parse(callsTo(/^\/payment_requests$/, tL)[0]?.body ?? '{}');
  const spOn = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 20_000, walletId: (qOn.data.linkedWallets ?? []).find((w: any) => w.channel === 'SHOPEEPAY')?.id });
  check('"post-pay only when the balance can be checked": the quote marks LinkAja as up front and the checked e-wallets as post-pay; LinkAja is charged up front, ShopeePay still post-pay',
    need.status === 200 && need.data.secretHints?.secretKey && flags.LINKAJA === false && flags.OVO === true && flags.DANA === true && flags.SHOPEEPAY === true
      && ljOn.status === 200 && ljOn.data.payment.postpay === false && ljOnI.mode === 'prepurchase' && ljOnI.state === 'captured' && ljCharge.payment_method_id === 'pm-linkaja' && ljCharge.amount === 20_000
      && spOn.data.payment?.postpay === true, { flags, ljOn: ljOn.data.payment, ljOnI, ljCharge, spOn: spOn.data.payment });
  // Released like any unused post-pay session, so the ShopeePay balance (Rp 30,000) is free for the checks further down:
  // post-pay exposure counts every session still held on the same e-wallet.
  if (spOn.data.chargeId) {
    const spOnI = await intentOfCharge(spOn.data.chargeId);
    await pg.query(`UPDATE payment_intent SET created_at = now() - interval '40 minutes' WHERE id = $1`, [spOnI.id]);
    await until(() => intentOfCharge(spOn.data.chargeId), (i) => i.hold_state === 'released', 100_000, 2000);
  }

  // GoPay through Xendit: a v3 payment token, its balance from token_details (Rp 40,000 in the fake).
  const tG = Date.now();
  const gl = await d('POST', '/v1/wallets', { connectorId: conn, channel: 'GOPAY' });
  const tokBody = JSON.parse(callsTo(/^\/v3\/payment_tokens$/, tG)[0]?.body ?? '{}');
  const gs = await d('GET', `/v1/wallets/${gl.data.id}`);
  const qg = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 30_000 });
  const gw = (qg.data.linkedWallets ?? []).find((w: any) => w.channel === 'GOPAY');
  const gRefused = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 60_000, walletId: gw?.id });
  const gPost = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 30_000, walletId: gw?.id });
  const gPostI = await intentOfCharge(gPost.data.chargeId);
  check('GoPay linked through Xendit (GOPAY_RECURRING payment token, approved in GoPay): its balance (Rp 40,000, from token_details) is checked — a larger limit refused naming it, a smaller one post-pay',
    gl.status === 200 && gl.data.activationUrl === 'https://gopay.test/link/pt-gopay' && tokBody.channel_code === 'GOPAY_RECURRING' && gs.data.status === 'active'
      && gw?.postpay === true && gRefused.status === 422 && /Saldo GoPay/.test(gRefused.data.error) && gRefused.data.error.includes('40.000')
      && gPost.status === 200 && gPost.data.payment.postpay === true && gPostI.mode === 'postpay', { gl: gl.data, tokBody, gs: gs.data, gw, gRefused: gRefused.data, gPost: gPost.data.payment });
  const tH = Date.now();
  const gOnce = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 25_000, method: 'GOPAY' });
  const onceBody = JSON.parse(callsTo(/^\/v3\/payment_requests$/, tH)[0]?.body ?? '{}');
  check('a one-time GoPay payment through Xendit: a v3 payment request (channel GOPAY) that opens GoPay',
    gOnce.status === 200 && gOnce.data.payment.action === 'redirect' && gOnce.data.payment.checkoutUrl?.startsWith('https://gopay.test/pay/') && onceBody.channel_code === 'GOPAY' && onceBody.request_amount === 25_000,
    { gOnce: gOnce.data.payment, onceBody });

  // OVO and DANA links ended in the e-wallet app or expired (Xendit: the payment method INACTIVE / EXPIRED).
  const qx2 = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 20_000 });
  const ovoW = (qx2.data.linkedWallets ?? []).find((w: any) => w.channel === 'OVO')?.id;
  const danaW = (qx2.data.linkedWallets ?? []).find((w: any) => w.channel === 'DANA')?.id;
  const o1 = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 20_000, walletId: ovoW });
  await d('POST', `/v1/charge/${o1.data.chargeId}/start`);
  methodStatus['pm-ovo'] = 'INACTIVE';
  await runSession(o1.data.startToken, 2_000);
  const oEnd = await until(() => intentOfCharge(o1.data.chargeId), (i) => i.hold_state === 'capture_failed', 20_000, 500);
  const rcO = await d('GET', `/v1/charge/${o1.data.chargeId}/receipt`);
  const payO = await d('POST', `/v1/charge/${o1.data.chargeId}/pay-now`);
  const qO = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 20_000 });
  check('OVO unlinked in the OVO app before the after-session charge: the receipt and "pay now" say the OVO link is no longer active and to link again; OVO is offered for linking again',
    o1.data.payment?.postpay === true && oEnd.hold_error?.startsWith('link ended:') && rcO.data.settlement?.postpay?.linkEnded === true
      && payO.status === 409 && payO.data.code === 'wallet_link_ended' && /Tautan OVO Anda sudah tidak aktif/.test(payO.data.error) && /Hubungkan OVO lagi/.test(payO.data.error)
      && !(qO.data.linkedWallets ?? []).some((w: any) => w.id === ovoW) && (qO.data.linkableWallets ?? []).includes('OVO'),
    { o1: o1.data.payment, oEnd, rc: rcO.data.settlement, payO, linkable: qO.data.linkableWallets });
  methodStatus['pm-ovo'] = 'ACTIVE';
  const ovoAgain = await d('POST', '/v1/wallets', { connectorId: conn, channel: 'OVO' });
  await d('GET', `/v1/wallets/${ovoAgain.data.id}`);
  const tO = Date.now();
  const payO2 = await d('POST', `/v1/charge/${o1.data.chargeId}/pay-now`);
  const oPaid = await intentOfCharge(o1.data.chargeId);
  const oCharge = JSON.parse(callsTo(/^\/payment_requests$/, tO)[0]?.body ?? '{}');
  check('after linking OVO again, "pay now" charges it: paid, and post-pay is open again',
    ovoAgain.status === 200 && payO2.status === 200 && payO2.data.paid === true && oPaid.hold_state === 'captured' && oCharge.payment_method_id === 'pm-ovo',
    { ovoAgain: ovoAgain.data, payO2: payO2.data, oPaid, oCharge });

  methodStatus['pm-dana'] = 'EXPIRED';
  const tD = Date.now();
  const dEnd = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 15_000, walletId: danaW });
  const dAgain = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 15_000, walletId: danaW });
  const qD = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 15_000 });
  check('a DANA link that expired is refused at the start with "link DANA again" (not a balance message), nothing charged; tried again it gets the same code; DANA is offered for linking again',
    dEnd.status === 422 && dEnd.data.code === 'wallet_link_ended' && /Tautan DANA Anda sudah tidak aktif/.test(dEnd.data.error) && !/Saldo/.test(dEnd.data.error)
      && callsTo(/^\/payment_requests$/, tD).length === 0 && dAgain.status === 422 && dAgain.data.code === 'wallet_link_ended'
      && !(qD.data.linkedWallets ?? []).some((w: any) => w.id === danaW) && (qD.data.linkableWallets ?? []).includes('DANA'),
    { dEnd: dEnd.data, dAgain: dAgain.data, linkable: qD.data.linkableWallets });
  methodStatus['pm-dana'] = 'ACTIVE';

  // ShopeePay unlinked in the ShopeePay app between the session and its charge; then linked again.
  const spW = (qD.data.linkedWallets ?? []).find((w: any) => w.channel === 'SHOPEEPAY')?.id;
  const s1 = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 20_000, walletId: spW });
  await d('POST', `/v1/charge/${s1.data.chargeId}/start`);
  methodStatus['pm-shopeepay'] = 'INACTIVE';
  await runSession(s1.data.startToken, 2_000);
  const sEnd = await until(() => intentOfCharge(s1.data.chargeId), (i) => i.hold_state === 'capture_failed', 20_000, 500);
  const rcS = await d('GET', `/v1/charge/${s1.data.chargeId}/receipt`);
  const payS = await d('POST', `/v1/charge/${s1.data.chargeId}/pay-now`);
  const qS = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 20_000 });
  check('ShopeePay unlinked in the ShopeePay app before the after-session charge: the receipt and "pay now" say the ShopeePay link is no longer active and to link again; ShopeePay is offered for linking again',
    s1.data.payment?.postpay === true && sEnd.hold_error?.startsWith('link ended:') && rcS.data.settlement?.postpay?.linkEnded === true && rcS.data.settlement.postpay.channel === 'SHOPEEPAY'
      && payS.status === 409 && payS.data.code === 'wallet_link_ended' && /Tautan ShopeePay Anda sudah tidak aktif/.test(payS.data.error) && /Hubungkan ShopeePay lagi/.test(payS.data.error)
      && !(qS.data.linkedWallets ?? []).some((w: any) => w.id === spW) && (qS.data.linkableWallets ?? []).includes('SHOPEEPAY'),
    { s1: s1.data.payment, sEnd, rc: rcS.data.settlement, payS, linkable: qS.data.linkableWallets });
  methodStatus['pm-shopeepay'] = 'ACTIVE';
  const spAgain = await d('POST', '/v1/wallets', { connectorId: conn, channel: 'SHOPEEPAY' });
  await d('GET', `/v1/wallets/${spAgain.data.id}`);
  const tS = Date.now();
  const payS2 = await d('POST', `/v1/charge/${s1.data.chargeId}/pay-now`);
  const sPaid = await intentOfCharge(s1.data.chargeId);
  const sCharge = JSON.parse(callsTo(/^\/payment_requests$/, tS)[0]?.body ?? '{}');
  check('after linking ShopeePay again, "pay now" charges it: paid',
    spAgain.status === 200 && payS2.status === 200 && payS2.data.paid === true && sPaid.hold_state === 'captured' && sCharge.payment_method_id === 'pm-shopeepay',
    { spAgain: spAgain.data, payS2: payS2.data, sPaid, sCharge });

  // LinkAja (no balance reported) charged up front: with post-pay off, the ended link is found when Xendit refuses the payment.
  await ops('PUT', '/v1/integrations/payments', { provider: 'xendit', settings: { baseUrl: FAKE, methods: ['QRIS', 'GOPAY', 'OVO', 'DANA', 'SHOPEEPAY', 'LINKAJA'], linkWallets: true, walletPostpay: false } });
  await until(() => d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 20_000 }), (r) => r.data.walletPostpay === false, 20_000, 1000);
  methodStatus['pm-linkaja'] = 'EXPIRED';
  const tLk = Date.now();
  const lkEnd = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 20_000, walletId: ljw?.id });
  const lkTried = callsTo(/^\/payment_requests$/, tLk).length;
  const lkAgain = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 20_000, walletId: ljw?.id });
  const qLk = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 20_000 });
  check('a LinkAja link that expired, charged up front: Xendit refuses, and the driver is told the LinkAja link is no longer active and to link again (not "payment refused"); again, the same; LinkAja is offered for linking again',
    lkEnd.status === 422 && lkEnd.data.code === 'wallet_link_ended' && /Tautan LinkAja Anda sudah tidak aktif/.test(lkEnd.data.error) && !/ditolak/.test(lkEnd.data.error) && lkTried === 1
      && lkAgain.status === 422 && lkAgain.data.code === 'wallet_link_ended' && /Tautan LinkAja/.test(lkAgain.data.error) && callsTo(/^\/payment_requests$/, tLk).length === 1
      && !(qLk.data.linkedWallets ?? []).some((w: any) => w.channel === 'LINKAJA') && (qLk.data.linkableWallets ?? []).includes('LINKAJA'),
    { lkEnd: lkEnd.data, lkTried, lkAgain: lkAgain.data, linkable: qLk.data.linkableWallets });
  methodStatus['pm-linkaja'] = 'ACTIVE';

  // Xendit's link callbacks, on the same notification URL: an expiry ends a live link at once; an activation completes a
  // pending one without the app polling; a wrong callback token is refused and changes nothing.
  const xHook = `/pay/notify/${(await pg.query(`SELECT webhook_key FROM integration WHERE provider = 'xendit' AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1`)).rows[0].webhook_key}`;
  const xCb = (body: unknown, token = 'xendit-callback-token-postpay-e2e') => raw(xHook, JSON.stringify(body), { 'x-callback-token': token });
  const spLive = (await pg.query(`SELECT id, status FROM driver_card WHERE link_ref = 'pm-shopeepay' AND removed_at IS NULL ORDER BY created_at DESC LIMIT 1`)).rows[0];
  const forged = await xCb({ event: 'payment_method.expired', data: { id: 'pm-shopeepay', status: 'EXPIRED' } }, 'not-the-callback-token-000000000');
  const stillLive = (await pg.query(`SELECT status FROM driver_card WHERE id = $1`, [spLive?.id])).rows[0]?.status;
  const expCb = await xCb({ event: 'payment_method.expired', data: { id: 'pm-shopeepay', status: 'EXPIRED', type: 'EWALLET' } });
  const spEnded = (await pg.query(`SELECT status FROM driver_card WHERE id = $1`, [spLive?.id])).rows[0]?.status;
  const lkLink = await d('POST', '/v1/wallets', { connectorId: conn, channel: 'LINKAJA' });
  const lkPending = (await pg.query(`SELECT status FROM driver_card WHERE id = $1`, [lkLink.data.id])).rows[0]?.status;
  const actCb = await xCb({ event: 'payment_method.activated', data: { id: 'pm-linkaja', status: 'ACTIVE', type: 'EWALLET' } });
  const lkActive = (await pg.query(`SELECT status FROM driver_card WHERE id = $1`, [lkLink.data.id])).rows[0]?.status;
  const qCb = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 20_000 });
  check('Xendit link callbacks: a ShopeePay link expired at Xendit ends at once (no longer offered, offered for linking again); a pending LinkAja link becomes active on its activation callback; a wrong callback token is refused and changes nothing',
    spLive?.status === 'active' && forged.status === 401 && stillLive === 'active' && expCb.status === 200 && spEnded === 'failed'
      && lkLink.status === 200 && lkPending === 'pending' && actCb.status === 200 && lkActive === 'active'
      && !(qCb.data.linkedWallets ?? []).some((w: any) => w.channel === 'SHOPEEPAY') && (qCb.data.linkableWallets ?? []).includes('SHOPEEPAY')
      && (qCb.data.linkedWallets ?? []).some((w: any) => w.channel === 'LINKAJA'),
    { spLive, forged: forged.status, stillLive, expCb: expCb.status, spEnded, lkLink: lkLink.data, lkPending, lkActive, linked: qCb.data.linkedWallets, linkable: qCb.data.linkableWallets });
  const app = await fetch(`${API}/app/`).then((r) => r.text());
  const view = await fetch(`${API}/js/views/refunds.js`).then((r) => r.text());
  check('the app offers post-pay and "pay now", and handles an ended e-wallet link (paying in the app); the console lists holds and post-pay together', app.includes('Mulai isi · bayar setelah selesai') && app.includes('/pay-now') && app.includes('wallet_link_ended') && app.includes('set.postpay.linkEnded') && app.includes('/pay-unpaid') && app.includes('set.postpay.paidInApp') && app.includes('/v1/unpaid') && app.includes("h.startsWith('r/')") && view.includes('link ended, paid in app') && view.includes('Holds and post-pay'));
  check('contract: live responses match the published schemas', contract.length === 0, contract);
} catch (e) {
  check('unexpected error', false, (e as Error).stack ?? String(e));
} finally {
  for (const c of cleanup) await c().catch(() => {});
  fake.close();
  if (pg) await pg.end().catch(() => {});
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}
