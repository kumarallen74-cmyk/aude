// PlugSure v1.3 — e-wallet and card payments beside QRIS, end to end.
//
// This process plays the acquirers: a fake Midtrans (Core API charges for
// GoPay / ShopeePay, Snap for cards, refunds) and a fake Xendit (e-wallet
// charges, invoices for cards, e-wallet refunds) on a local port. Then:
//   - Sandbox (development default): every method; the driver pays a charge by
//     GoPay and a 30-day pass by DANA on the sandbox checkout page, cancels a
//     card payment there; OVO needs a phone number.
//   - Midtrans: the operator enables QRIS, GoPay and cards only; the driver sees
//     exactly those; GoPay opens the deeplink, a card the Snap page; the signed
//     notifications capture them; the GoPay payment is refunded by API.
//   - Xendit: OVO is pushed to the driver's number; DANA / cards redirect; the
//     ewallet.capture and invoice callbacks capture; the OVO payment is refunded
//     by API with its charge id, a card payment goes to bank transfer.
//   - The driver app's return page is served.
// Everything is removed at the end.
//
// Needs E2E_DATABASE_URL (the runtime role).
//     npx tsx tools/e2e/payment-methods-e2e.mts
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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 700)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000, every = 400): Promise<T> {
  const t0 = Date.now(); let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) { await sleep(every); v = await fn(); }
  return v;
}
function session() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
    const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
    return { status: r.status, data: d, text: t };
  };
}
const ops = session();
const raw = async (path: string, body: string, headers: Record<string, string> = {}) => {
  const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, redirect: 'manual' });
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d, location: r.headers.get('location') };
};

// ------------------------------------------------------------ the fake acquirers
const calls: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string; at: number }> = [];
const SERVER_KEY = 'SB-Mid-server-E2E-METHODS-71ab';
const XTOKEN = 'xendit-callback-token-methods-e2e';
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0]!;
    calls.push({ path, headers: req.headers, body, at: Date.now() });
    const send = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    const j = body ? JSON.parse(body) : {};
    if (path === '/v2/charge') {
      const o = j.transaction_details.order_id;
      if (j.payment_type === 'qris') return send(201, { status_code: '201', order_id: o, qr_string: `00020101021226MIDTRANS${o}` });
      return send(201, { status_code: '201', order_id: o, transaction_id: `mt-${o}`, actions: [{ name: 'deeplink-redirect', url: `${j.payment_type}://pay?order=${o}` }] });
    }
    if (path === '/snap/v1/transactions') return send(201, { token: 'snap-token', redirect_url: `https://app.sandbox.midtrans.test/snap/v4/redirection/${j.transaction_details.order_id}` });
    if (/^\/v2\/.+\/refund$/.test(path)) return send(200, { status_code: '200', refund_key: j.refund_key });
    if (path === '/qr_codes') return send(201, { id: 'qr_1', reference_id: j.reference_id, qr_string: `000201XENDIT${j.reference_id}` });
    if (path === '/ewallets/charges') {
      const id = `ewc_${j.reference_id.slice(3, 15)}`;
      return send(202, { id, reference_id: j.reference_id, status: 'PENDING', channel_code: j.channel_code, actions: j.channel_code === 'ID_OVO' ? null : { mobile_web_checkout_url: `https://ewallet.test/${j.channel_code}/${id}` } });
    }
    if (/^\/ewallets\/charges\/[^/]+\/refunds$/.test(path)) return send(200, { id: `ewr_${Date.now()}`, status: 'SUCCEEDED', amount: j.amount });
    if (path === '/v2/invoices') return send(200, { id: `inv_${j.external_id.slice(3, 15)}`, external_id: j.external_id, invoice_url: `https://checkout-staging.xendit.test/web/${j.external_id}` });
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

  // ================================================================ setup: a charger, a signed-in driver, an app pass
  await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  await ops('DELETE', '/v1/integrations/payments?scope=org');
  cleanup.push(() => ops('DELETE', '/v1/integrations/payments?scope=org'));
  const site = await ops('POST', '/v1/sites', { name: 'Payment Methods E2E Hub', address: 'Jl. Sudirman', kabupatenKotaCode: '3171', gridTariffGroup: 'L/TR', connectedKva: '197', powerFactor: '0.95', phases: '3', localTaxRateBps: '1000' });
  const tariff = await ops('POST', '/v1/tariffs', { name: 'Methods E2E DC', plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, pricingModel: 'flat', appliesToMaxPowerW: 60000, ppnApplies: true, components: [{ kind: 'energy', rate: 2400, touBlock: 'ANY' }] });
  await ops('PUT', `/v1/sites/${site.data.id}/tariff`, { tariffId: tariff.data.tariffId, currentType: 'DC' });
  const ID = `PMET-${Date.now().toString().slice(-6)}`;
  await ops('POST', '/v1/charge-points', { ocppIdentity: ID, siteId: site.data.id, displayName: 'Methods E2E', ocppVersion: 'ocpp1.6', evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] }] });
  await ops('POST', `/v1/charge-points/${ID}/activate`);
  const ws = new WebSocket(`${OCPP}/${ID}`, ['ocpp1.6']);
  await new Promise<void>((r) => ws.once('open', () => r()));
  ws.on('message', (m) => { const f = JSON.parse(m.toString()); if (f[0] === 2) ws.send(JSON.stringify([3, f[1], { status: 'Accepted' }])); });
  let n = 0; const call = (a: string, p: unknown) => new Promise<any>((res) => { const id = `m${++n}`; const on = (m: any) => { const f = JSON.parse(m.toString()); if (f[1] === id) { ws.off('message', on); res(f[2]); } }; ws.on('message', on); ws.send(JSON.stringify([2, id, a, p])); });
  await call('BootNotification', { chargePointVendor: 'E2E', chargePointModel: 'PMET' });
  await call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: new Date().toISOString() });
  cleanup.push(async () => ws.close());

  const dev = (await raw('/d/v1/device', '{}')).data.deviceToken as string;
  const d = async (method: string, path: string, body?: unknown) => { const r = await fetch(`${API}/d${path}`, { method, headers: { authorization: `Bearer ${dev}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let j: any = t; try { j = JSON.parse(t); } catch {} return { status: r.status, data: j }; };
  const stations = await until(() => d('GET', '/v1/stations'), (r) => !!r.data.stations?.find((s: any) => s.siteId === site.data.id)?.connectors?.[0], 20_000, 800);
  const conn = stations.data.stations.find((s: any) => s.siteId === site.data.id).connectors[0].connectorId;
  const phone = `0815${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const otp = await d('POST', '/v1/otp/send', { phone });
  await d('POST', '/v1/otp/verify', { phone, code: otp.data.devCode });
  const plan = await ops('POST', '/v1/subscription-plans', { name: `Methods E2E Pass ${Date.now().toString().slice(-5)}`, monthlyFeeMinor: 25000, energyDiscountPercent: 10, offeredInApp: true });
  cleanup.push(() => ops('PUT', `/v1/subscription-plans/${plan.data.id}`, { active: false, offeredInApp: false }));
  const intent = async (ref: string) => (await pg.query(`SELECT state, method, channel, checkout_url, provider_payment_id, amount_captured_minor FROM payment_intent WHERE provider_ref = $1`, [ref])).rows[0];
  const refOf = (r: any) => r.data?.payment?.providerRef as string;

  // ================================================================ sandbox (development default): every method
  const q0 = await d('POST', '/v1/charge/quote', { connectorId: conn, amountMinor: 50_000 });
  const chans = (q: any) => (q.data.paymentMethods ?? []).map((m: any) => m.channel).join(',');
  check('sandbox: the quote lists every method (QRIS, GoPay, ShopeePay, OVO, DANA, LinkAja, card)', chans(q0) === 'QRIS,GOPAY,SHOPEEPAY,OVO,DANA,LINKAJA,CARD', q0.data);
  const qr0 = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 20_000 });
  check('QRIS unchanged: a QR, action qr, recorded as qris', qr0.status === 200 && !!qr0.data.qr?.qrString && qr0.data.payment?.action === 'qr' && (await intent(refOf(qr0)))?.method === 'qris', qr0.data.payment);
  const gp = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 30_000, method: 'GOPAY' });
  const gpI = await intent(refOf(gp));
  check('GoPay (sandbox): no QR; the driver is sent to the sandbox checkout page; recorded as ewallet / GOPAY with the URL',
    gp.status === 200 && !gp.data.qr && gp.data.payment?.action === 'redirect' && /^\/pay\/sandbox\/mock_gopay_/.test(gp.data.payment.checkoutUrl) && gp.data.payment.label === 'GoPay'
      && gpI?.method === 'ewallet' && gpI.channel === 'GOPAY' && gpI.checkout_url === gp.data.payment.checkoutUrl, { gp: gp.data, gpI });
  const page = await fetch(API + gp.data.payment.checkoutUrl).then(async (r) => ({ status: r.status, text: await r.text(), csp: r.headers.get('content-security-policy') ?? '' }));
  const statusBefore = await d('GET', `/v1/charge/${gp.data.chargeId}/status`);
  const back = gp.data.payment.checkoutUrl.split('?')[1];
  const payIt = await raw(`/pay/sandbox/${refOf(gp)}/pay?${back}`, '');
  const gpAfter = await intent(refOf(gp));
  const statusAfter = await d('GET', `/v1/charge/${gp.data.chargeId}/status`);
  check('sandbox checkout page: shows GoPay and the amount; "Bayar" captures the payment and returns to the app\'s paid page; the app sees it paid',
    page.status === 200 && page.text.includes('GoPay') && page.text.includes('Rp 30.000') && page.text.includes('Sandbox') && statusBefore.data.state === 'awaiting_payment'
      && payIt.status === 303 && /^\/app\/paid\.html\?for=charge&status=paid$/.test(payIt.location ?? '') && gpAfter.state === 'captured' && gpAfter.amount_captured_minor === 30_000 && statusAfter.data.state !== 'awaiting_payment',
    { page: page.status, before: statusBefore.data.state, payIt, gpAfter, after: statusAfter.data.state });
  const cd = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 15_000, method: 'CARD' });
  const cancel = await raw(`/pay/sandbox/${refOf(cd)}/cancel`, '', { accept: 'application/json' });
  const cdI = await intent(refOf(cd));
  const evil = await raw(`/pay/sandbox/${refOf(gp)}/pay?return=${encodeURIComponent('https://evil.example/steal')}`, '');
  check('card (sandbox): recorded as card; "Batal" fails the payment; the return address cannot leave the app',
    cd.data.payment?.method === 'card' && cancel.data.outcome === 'failed' && cdI.state === 'failed' && evil.location?.startsWith('/app/paid.html') === true, { cd: cd.data.payment, cancel: cancel.data, cdI, evil: evil.location });
  const ovoNo = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 15_000, method: 'OVO', phone: '12' });
  const ovo = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 15_000, method: 'OVO' });
  const bogus = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 15_000, method: 'BITCOIN' });
  check('OVO: a bad number refused; the signed-in driver\'s number is used by default (push); an unknown method refused',
    ovoNo.status === 422 && /OVO/.test(ovoNo.data.error) && ovo.status === 200 && ovo.data.payment.action === 'push' && bogus.status === 422, { ovoNo: ovoNo.data, ovo: ovo.data.payment, bogus: bogus.data });
  const mem = await d('GET', '/v1/memberships');
  const mp = mem.data.plans.find((p: any) => p.id === plan.data.id);
  const pass = await d('POST', '/v1/memberships', { planId: plan.data.id, method: 'DANA' });
  const passRow = (await pg.query(`SELECT via, channel, checkout_url, state FROM subscription_charge WHERE id = $1`, [pass.data.chargeId])).rows[0];
  const passPaid = await raw(`/pay/sandbox/${refOf(pass)}/pay`, '', { accept: 'application/json' });
  const passAfter = await d('GET', `/v1/memberships/charges/${pass.data.chargeId}`);
  check('app pass by DANA: the plan lists the methods; the pass is recorded as ewallet / DANA; paid on the checkout page it becomes active',
    mp?.paymentMethods?.length === 7 && pass.status === 200 && !pass.data.qr && pass.data.payment?.channel === 'DANA' && passRow.via === 'ewallet' && passRow.channel === 'DANA'
      && passPaid.data.outcome === 'pass_paid' && passAfter.data.state === 'paid' && passAfter.data.membership === 'active', { pass: pass.data, passRow, passPaid: passPaid.data, passAfter: passAfter.data });

  // ================================================================ Midtrans: QRIS, GoPay and cards enabled
  const badM = await ops('PUT', '/v1/integrations/payments', { provider: 'midtrans', settings: { environment: 'sandbox', baseUrl: FAKE, methods: ['QRIS', 'OVO'] }, secrets: { serverKey: SERVER_KEY } });
  const noneM = await ops('PUT', '/v1/integrations/payments', { provider: 'midtrans', settings: { environment: 'sandbox', baseUrl: FAKE, methods: [] }, secrets: { serverKey: SERVER_KEY } });
  const mt = await ops('PUT', '/v1/integrations/payments', { provider: 'midtrans', settings: { environment: 'sandbox', baseUrl: FAKE, methods: ['CARD', 'QRIS', 'GOPAY'] }, secrets: { serverKey: SERVER_KEY } });
  cc('/v1/integrations/{kind}', 'put', '200', mt.data);
  check('Midtrans: a method it does not offer (OVO) and an empty choice are refused; the choice is stored in catalogue order',
    badM.status === 422 && /OVO/.test(badM.data.error) && noneM.status === 422 && mt.status === 200 && JSON.stringify(mt.data.settings.methods) === '["QRIS","GOPAY","CARD"]', { badM: badM.data, noneM: noneM.data, mt: mt.data.settings });
  const hookM = mt.data.webhookPath as string;
  const q1 = await until(() => d('POST', '/v1/charge/quote', { connectorId: conn, amountMinor: 50_000 }), (q) => chans(q) === 'QRIS,GOPAY,CARD', 20_000, 1000);
  const sp = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 25_000, method: 'SHOPEEPAY' });
  check('the driver sees only the enabled methods; ShopeePay (offered by Midtrans, not enabled) is refused', chans(q1) === 'QRIS,GOPAY,CARD' && sp.status === 422 && /ShopeePay/.test(sp.data.error), { q1: q1.data.paymentMethods, sp: sp.data });
  const t1 = Date.now();
  const gm = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 45_000, method: 'GOPAY' });
  const gmCall = callsTo(/^\/v2\/charge$/, t1)[0];
  const gmI = await intent(refOf(gm));
  check('GoPay at Midtrans: payment type gopay with the app\'s return page; the deeplink is handed to the app; the Midtrans transaction id is kept',
    gm.status === 200 && gm.data.demo === false && JSON.parse(gmCall?.body ?? '{}').payment_type === 'gopay' && /\/app\/paid\.html\?for=charge$/.test(JSON.parse(gmCall.body).gopay.callback_url)
      && gm.data.payment.checkoutUrl.startsWith('gopay://pay') && gmI.provider_payment_id === `mt-${refOf(gm)}`, { gm: gm.data, gmI });
  const sig = (o: string, s: string, g: string) => createHash('sha512').update(`${o}${s}${g}${SERVER_KEY}`).digest('hex');
  const note = (o: string, g: string, extra: Record<string, string>) => JSON.stringify({ order_id: o, status_code: '200', gross_amount: g, transaction_id: `mt-${o}`, signature_key: sig(o, '200', g), ...extra });
  const gmHook = await raw(hookM, note(refOf(gm), '45000.00', { transaction_status: 'settlement', payment_type: 'gopay' }));
  check('GoPay: the signed settlement notification captures it', gmHook.status === 200 && (await intent(refOf(gm))).state === 'captured');
  const t2 = Date.now();
  const cm = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 60_000, method: 'CARD' });
  const snap = callsTo(/^\/snap\/v1\/transactions$/, t2)[0];
  const challenge = await raw(hookM, note(refOf(cm), '60000.00', { transaction_status: 'capture', fraud_status: 'challenge', payment_type: 'credit_card' }));
  const stillPending = (await intent(refOf(cm))).state;
  const accept = await raw(hookM, note(refOf(cm), '60000.00', { transaction_status: 'capture', fraud_status: 'accept', payment_type: 'credit_card' }));
  check('card at Midtrans: Snap limited to credit_card with 3-D Secure; a fraud challenge does not capture, capture + accept does',
    cm.status === 200 && /snap\/v4\/redirection/.test(cm.data.payment.checkoutUrl) && JSON.parse(snap?.body ?? '{}').credit_card?.secure === true && JSON.stringify(JSON.parse(snap.body).enabled_payments) === '["credit_card"]'
      && challenge.status === 200 && stillPending === 'pending' && accept.status === 200 && (await intent(refOf(cm))).state === 'captured', { cm: cm.data.payment, stillPending });
  const piG = (await pg.query(`SELECT id FROM payment_intent WHERE provider_ref = $1`, [refOf(gm)])).rows[0].id;
  await pg.query(`UPDATE payment_intent SET refund_state = 'due', refund_due_minor = 11000, refund_reason = 'e2e unused balance' WHERE id = $1`, [piG]);
  const t3 = Date.now();
  const rfG = await ops('POST', `/v1/refunds/${piG}/process`);
  check('GoPay refund: back through Midtrans\' refund API for the unused amount', rfG.data.state === 'refunded' && callsTo(new RegExp(`^/v2/${refOf(gm)}/refund$`), t3).length === 1, rfG.data);

  // ================================================================ Xendit: QRIS, OVO, DANA and cards enabled
  const xe = await ops('PUT', '/v1/integrations/payments', { provider: 'xendit', settings: { baseUrl: FAKE, methods: ['QRIS', 'OVO', 'DANA', 'CARD'] }, secrets: { secretKey: 'xnd_development_METHODS', callbackToken: XTOKEN } });
  const hookX = xe.data.webhookPath as string;
  await until(() => d('POST', '/v1/charge/quote', { connectorId: conn, amountMinor: 50_000 }), (q) => chans(q) === 'QRIS,OVO,DANA,CARD', 20_000, 1000);
  const t4 = Date.now();
  const ox = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 35_000, method: 'OVO', phone: '0812 3456 7890' });
  const oxCall = callsTo(/^\/ewallets\/charges$/, t4)[0];
  const oxBody = JSON.parse(oxCall?.body ?? '{}');
  check('OVO at Xendit: an e-wallet charge ID_OVO pushed to the number given (E.164); nothing to open',
    ox.status === 200 && ox.data.payment.action === 'push' && ox.data.payment.checkoutUrl === null && oxBody.channel_code === 'ID_OVO' && oxBody.channel_properties?.mobile_number === '+6281234567890', { ox: ox.data.payment, oxBody });
  const cbX = (b: unknown, token = XTOKEN) => raw(hookX, JSON.stringify(b), { 'x-callback-token': token });
  const oxId = (await intent(refOf(ox))).provider_payment_id;
  const wrong = await cbX({ event: 'ewallet.capture', data: { id: oxId, reference_id: refOf(ox), status: 'SUCCEEDED', capture_amount: 35000 } }, 'wrong-token-wrong-token-wrong-tok');
  const capX = await cbX({ event: 'ewallet.capture', data: { id: oxId, reference_id: refOf(ox), status: 'SUCCEEDED', charge_amount: 35000, capture_amount: 35000 } });
  check('OVO: the ewallet.capture callback with the wrong token is refused; with the token it captures', wrong.status === 401 && capX.status === 200 && (await intent(refOf(ox))).state === 'captured' && /^ewc_/.test(oxId ?? ''), { oxId });
  const dx = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 22_000, method: 'DANA' });
  check('DANA at Xendit: redirected to DANA\'s checkout', dx.status === 200 && dx.data.payment.checkoutUrl?.startsWith('https://ewallet.test/ID_DANA/'), dx.data.payment);
  const t5 = Date.now();
  const kx = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 55_000, method: 'CARD' });
  const inv = JSON.parse(callsTo(/^\/v2\/invoices$/, t5)[0]?.body ?? '{}');
  const expired = await cbX({ id: 'inv_x', external_id: refOf(kx), status: 'EXPIRED', amount: 55000 });
  const expState = (await intent(refOf(kx))).state;
  await pg.query(`UPDATE payment_intent SET state = 'pending' WHERE provider_ref = $1`, [refOf(kx)]);
  const paidInv = await cbX({ id: 'inv_x', external_id: refOf(kx), status: 'PAID', amount: 55000, paid_amount: 55000, payment_method: 'CREDIT_CARD' });
  check('card at Xendit: an invoice for CREDIT_CARD only; EXPIRED expires it, PAID captures it',
    kx.status === 200 && JSON.stringify(inv.payment_methods) === '["CREDIT_CARD"]' && inv.external_id === refOf(kx) && kx.data.payment.checkoutUrl.includes('checkout-staging.xendit.test')
      && expired.status === 200 && expState === 'expired' && paidInv.status === 200 && (await intent(refOf(kx))).state === 'captured', { inv, expState });
  const refundOf = async (ref: string, due: number) => {
    const id = (await pg.query(`SELECT id FROM payment_intent WHERE provider_ref = $1`, [ref])).rows[0].id;
    await pg.query(`UPDATE payment_intent SET refund_state = 'due', refund_due_minor = $2, refund_reason = 'e2e unused balance' WHERE id = $1`, [id, due]);
    return ops('POST', `/v1/refunds/${id}/process`);
  };
  const t6 = Date.now();
  const rfO = await refundOf(refOf(ox), 9000);
  const rfCall = callsTo(/^\/ewallets\/charges\/[^/]+\/refunds$/, t6)[0];
  const rfK = await refundOf(refOf(kx), 5000);
  check('refunds at Xendit: OVO through the e-wallet refund API with its charge id; a card payment is left for bank transfer',
    rfO.data.state === 'refunded' && rfCall?.path === `/ewallets/charges/${oxId}/refunds` && JSON.parse(rfCall.body).amount === 9000
      && rfK.data.state === 'failed' && /bank transfer/.test(rfK.data.error ?? ''), { rfO: rfO.data, rfK: rfK.data, path: rfCall?.path });

  // ================================================================ the app and the console
  const paid = await fetch(`${API}/app/paid.html?for=charge&status=paid`).then(async (r) => ({ status: r.status, text: await r.text() }));
  const app = await fetch(`${API}/app/`).then((r) => r.text());
  const view = await fetch(`${API}/js/views/integrations.js`).then((r) => r.text());
  const ov = await ops('GET', '/v1/integrations');
  cc('/v1/integrations', 'get', '200', ov.data);
  const payK = ov.data.kinds.find((k: any) => k.kind === 'payments');
  check('the return page, the app\'s method picker, and the console\'s method checkboxes are served; the overview shows the enabled methods',
    paid.status === 200 && paid.text.includes('/app/#paid') && app.includes('function methodPicker') && app.includes("h==='paid'") && view.includes("'multiselect'")
      && JSON.stringify(payK.own.settings.methods) === '["QRIS","OVO","DANA","CARD"]' && payK.providers.find((p: any) => p.id === 'snap').fields.every((f: any) => f.key !== 'methods'), payK.own?.settings);
  const evs = await ops('GET', '/v1/integrations/payments/events?limit=30');
  check('activity: e-wallet and card payments are logged as checkouts with their channel', evs.data.events.some((e: any) => e.action === 'create_checkout' && e.detail?.channel === 'OVO') && evs.data.events.some((e: any) => e.action === 'create_checkout' && e.detail?.channel === 'CARD'), evs.data.events.slice(0, 5));
  check('contract: live integration responses match the published schemas', contract.length === 0, contract);
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
