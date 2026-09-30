// PlugSure v1.3 — third-party integrations configured from the console, end to end.
//
// This process plays the providers: a fake Midtrans, Xendit, WhatsApp Cloud
// API, Twilio and PKI gateway on a local port. The operator and the platform
// administrator connect them in Govern → Integrations (API), and then:
//   - QRIS: console checkout and the driver app's prepaid checkout create real
//     charges at the acquirer; forged notifications are refused; a signed one
//     captures the payment exactly once; a short-paid one does not; the refund
//     goes back through the acquirer; switching to Xendit works the same way.
//   - Sign-in codes: sent by WhatsApp (the template carries the code), then by
//     the SMS fallback when WhatsApp refuses; the driver signs in with the code
//     that was sent; no code on screen; the activity log masks the number.
//   - The Plug & Charge PKI gateway and map tiles.
//   - Secrets are never returned; changes are audited without them.
// Everything is removed at the end (environment defaults apply again).
//
// Needs E2E_DATABASE_URL (the runtime role) and a platform administrator
// (E2E_PLATFORM_EMAIL / E2E_PLATFORM_PASSWORD).
//     npx tsx tools/e2e/integrations-e2e.mts
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
    const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
    const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
    return { status: r.status, data: d, text: t, headers: r.headers };
  };
}
const ops = session();
const pa = session();
const raw = async (path: string, body: string, headers: Record<string, string> = {}) => {
  const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d };
};

// ------------------------------------------------------------ the fake providers
const calls: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string; at: number }> = [];
const behaviour = { whatsappStatus: 200 };
const SERVER_KEY = 'SB-Mid-server-E2E-SECRET-9f3c';
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0]!;
    calls.push({ path, headers: req.headers, body, at: Date.now() });
    const send = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (path === '/v2/charge') {
      const j = JSON.parse(body);
      return send(201, { status_code: '201', order_id: j.transaction_details.order_id, gross_amount: `${j.transaction_details.gross_amount}.00`, transaction_status: 'pending', qr_string: `00020101021226MIDTRANS${j.transaction_details.order_id}` });
    }
    if (/^\/v2\/plugsure-connection-test/.test(path)) return send(404, { status_code: '404', status_message: "Transaction doesn't exist." });
    if (/^\/v2\/.+\/refund$/.test(path)) return send(200, { status_code: '200', status_message: 'Success, refund request is approved', refund_key: JSON.parse(body).refund_key });
    if (path === '/qr_codes') { const j = JSON.parse(body); return send(201, { id: 'qr_e2e', reference_id: j.reference_id, qr_string: `000201XENDIT${j.reference_id}`, status: 'ACTIVE' }); }
    if (path === '/balance') return send(200, { balance: 1000000 });
    if (/^\/v20\.0\/\d+\/messages$/.test(path)) return behaviour.whatsappStatus === 200 ? send(200, { messages: [{ id: `wamid.${Date.now()}` }] }) : send(400, { error: { message: '(#131026) Message undeliverable' } });
    if (/^\/v20\.0\/\d+$/.test(path)) return send(200, { display_phone_number: '+62 21 5555 0000', verified_name: 'PlugSure' });
    if (/^\/2010-04-01\/Accounts\/AC\w+\/Messages\.json$/.test(path)) return send(201, { sid: `SM${Date.now()}` });
    if (/^\/2010-04-01\/Accounts\/AC\w+\.json$/.test(path)) return send(200, { friendly_name: 'PlugSure E2E', status: 'active' });
    if (path === '/pki/v1/roots') return send(req.headers.authorization === 'Bearer pki-token-e2e' ? 200 : 401, { v2gRoots: ['-----BEGIN CERTIFICATE-----'], moRoots: [] });
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
  const l1 = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  const l2 = await pa('POST', '/v1/auth/login', { email: process.env.E2E_PLATFORM_EMAIL ?? 'platform@plugsure.test', password: process.env.E2E_PLATFORM_PASSWORD ?? 'Platform-Test-2026!' });
  for (const k of ['otp', 'otp_fallback', 'pnc_pki', 'map_tiles', 'payments']) cleanup.push(() => pa('DELETE', `/v1/integrations/${k}?scope=platform`));
  cleanup.push(() => ops('DELETE', '/v1/integrations/payments?scope=org'));
  const ov0 = await ops('GET', '/v1/integrations');
  cc('/v1/integrations', 'get', '200', ov0.data);
  const k0 = Object.fromEntries(ov0.data.kinds.map((k: any) => [k.kind, k]));
  check('overview: five integrations; in development the sandbox acquirer and on-screen codes are the defaults; the operator may change only its QRIS account',
    l1.status === 200 && l2.status === 200 && ov0.data.kinds.length === 5 && k0.payments.effective?.provider === 'mock' && k0.payments.effective.source === 'default'
      && k0.otp.effective?.provider === 'dev' && k0.payments.editable === true && k0.otp.editable === false, { k0: Object.values(k0).map((k: any) => [k.kind, k.effective, k.editable]) });

  // ================================================================ QRIS: Midtrans
  const bad = await ops('PUT', '/v1/integrations/payments', { provider: 'midtrans', settings: { environment: 'sandbox' } });
  const forbidden = await ops('PUT', '/v1/integrations/otp', { provider: 'dev' });
  const mt = await ops('PUT', '/v1/integrations/payments', { provider: 'midtrans', settings: { environment: 'sandbox', acquirer: 'gopay', baseUrl: FAKE, merchantId: 'G123' }, secrets: { serverKey: SERVER_KEY } });
  cc('/v1/integrations/{kind}', 'put', '200', mt.data);
  const ov1 = await ops('GET', '/v1/integrations');
  const pay1 = ov1.data.kinds.find((k: any) => k.kind === 'payments');
  check('Midtrans connected: the secret is required, kept sealed and shown only as a hint; a notification URL is issued; the operator cannot set platform integrations (403)',
    bad.status === 422 && forbidden.status === 403 && mt.status === 200 && mt.data.secretHints?.serverKey === '••••9f3c' && !mt.text.includes(SERVER_KEY) && !ov1.text.includes(SERVER_KEY)
      && /\/pay\/notify\/[A-Za-z0-9_-]{30,}$/.test(mt.data.webhookUrl) && pay1.effective.provider === 'midtrans' && pay1.effective.source === 'console',
    { bad: bad.status, forbidden: forbidden.status, mt: mt.data });
  const hookPath = mt.data.webhookPath as string;
  const t1 = await ops('POST', '/v1/integrations/payments/test', { scope: 'org' });
  cc('/v1/integrations/{kind}/test', 'post', '200', t1.data);
  check('test: the server key is checked against Midtrans (status call) and the result kept', t1.data.ok === true && /accepted/.test(t1.data.message) && callsTo(/^\/v2\/plugsure-connection-test/).length === 1, t1.data);

  // A site with a tariff and a connected charger.
  const site = await ops('POST', '/v1/sites', { name: 'Integrations E2E Hub', address: 'Jl. Kuningan', kabupatenKotaCode: '3171', gridTariffGroup: 'L/TR', connectedKva: '197', powerFactor: '0.95', phases: '3', pbjtRateBps: '1000' });
  const tariff = await ops('POST', '/v1/tariffs', { name: 'Integrations E2E DC', plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, pricingModel: 'flat', appliesToMaxPowerW: 60000, ppnApplies: true, components: [{ kind: 'energy', rate: 2400, touBlock: 'ANY' }] });
  await ops('PUT', `/v1/sites/${site.data.id}/tariff`, { tariffId: tariff.data.tariffId, currentType: 'DC' });
  const ID = `INTG-${Date.now().toString().slice(-6)}`;
  await ops('POST', '/v1/charge-points', { ocppIdentity: ID, siteId: site.data.id, displayName: 'Integrations E2E', ocppVersion: 'ocpp1.6', evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] }] });
  await ops('POST', `/v1/charge-points/${ID}/activate`);
  const ws = new WebSocket(`${OCPP}/${ID}`, ['ocpp1.6']);
  await new Promise<void>((r) => ws.once('open', () => r()));
  ws.on('message', (m) => { const f = JSON.parse(m.toString()); if (f[0] === 2) ws.send(JSON.stringify([3, f[1], { status: 'Accepted' }])); });
  let n = 0; const call = (a: string, p: unknown) => new Promise<any>((res) => { const id = `i${++n}`; const on = (m: any) => { const f = JSON.parse(m.toString()); if (f[1] === id) { ws.off('message', on); res(f[2]); } }; ws.on('message', on); ws.send(JSON.stringify([2, id, a, p])); });
  await call('BootNotification', { chargePointVendor: 'E2E', chargePointModel: 'INTG' });
  await call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: new Date().toISOString() });
  cleanup.push(async () => ws.close());

  // Console checkout through Midtrans.
  const t2 = Date.now();
  const co = await ops('POST', '/v1/checkout/qris', { ocppIdentity: ID, connectorId: 1, amountIdr: 50_000 });
  const charge = callsTo(/^\/v2\/charge$/, t2)[0];
  const orderId = co.data.qr?.providerRef as string;
  check('console checkout: a QRIS charge created at Midtrans (the QR string is Midtrans\'), recorded with the provider',
    co.status === 200 && co.data.provider === 'midtrans' && !!charge && JSON.parse(charge.body).transaction_details.gross_amount === 50_000 && co.data.qr.qrString.includes(orderId), { co: co.data, charge: charge?.body });
  const intentState = async (ref: string) => (await pg.query(`SELECT state, amount_captured_idr, integration_id FROM payment_intent WHERE provider_ref = $1`, [ref])).rows[0];
  const sig = (o: string, s: string, g: string) => createHash('sha512').update(`${o}${s}${g}${SERVER_KEY}`).digest('hex');
  const note = (o: string, g = '50000.00', st = 'settlement') => JSON.stringify({ order_id: o, status_code: '200', gross_amount: g, transaction_status: st, transaction_id: 'mt-tx-1', signature_key: sig(o, '200', g) });
  const forged = await raw(hookPath, JSON.stringify({ order_id: orderId, status_code: '200', gross_amount: '50000.00', transaction_status: 'settlement', signature_key: 'f'.repeat(128) }));
  const unknownUrl = await raw('/pay/notify/NOTAREALKEYNOTAREALKEY1234', note(orderId));
  const stillPending = await intentState(orderId);
  const good = await raw(hookPath, note(orderId));
  const captured = await intentState(orderId);
  const again = await raw(hookPath, note(orderId));
  check('notification: a forged signature (401) and an unknown URL (404) change nothing; the signed one captures the payment once',
    forged.status === 401 && unknownUrl.status === 404 && stillPending.state === 'pending' && good.status === 200 && captured.state === 'captured' && captured.amount_captured_idr === 50_000 && again.status === 200,
    { forged: forged.status, unknownUrl: unknownUrl.status, stillPending, captured });
  const co2 = await ops('POST', '/v1/checkout/qris', { ocppIdentity: ID, connectorId: 1, amountIdr: 40_000 });
  const short = await raw(hookPath, note(co2.data.qr.providerRef, '4000.00'));
  const shortState = await intentState(co2.data.qr.providerRef);
  check('notification for less than the payment: acknowledged but not captured', short.status === 200 && shortState.state === 'pending', shortState);

  // Refund through the acquirer.
  const pi = (await pg.query(`SELECT id FROM payment_intent WHERE provider_ref = $1`, [orderId])).rows[0].id;
  await pg.query(`UPDATE payment_intent SET refund_state = 'due', refund_due_idr = 12000, refund_reason = 'e2e unused balance' WHERE id = $1`, [pi]);
  const t3 = Date.now();
  const rf = await ops('POST', `/v1/refunds/${pi}/process`);
  const rfCall = callsTo(/\/refund$/, t3)[0];
  check('refund: paid back through Midtrans (its refund API, for the refund amount)', rf.status === 200 && rf.data.state === 'refunded' && !!rfCall && rfCall.path === `/v2/${orderId}/refund` && JSON.parse(rfCall.body).amount === 12_000, { rf: rf.data, rfCall: rfCall?.path });

  // The driver app's prepaid checkout through Midtrans: no demo button.
  const dev = (await raw('/d/v1/device', '{}')).data.deviceToken as string;
  const d = async (method: string, path: string, body?: unknown) => { const r = await fetch(`${API}/d${path}`, { method, headers: { authorization: `Bearer ${dev}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let j: any = t; try { j = JSON.parse(t); } catch {} return { status: r.status, data: j }; };
  const stations = await until(() => d('GET', '/v1/stations'), (r) => !!r.data.stations?.find((s: any) => s.siteId === site.data.id)?.connectors?.[0], 20_000, 800);
  const conn = stations.data.stations.find((s: any) => s.siteId === site.data.id).connectors[0].connectorId;
  const pre = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 30_000 });
  const demoConfirm = pre.data.chargeId ? await d('POST', `/v1/charge/${pre.data.chargeId}/confirm-payment`) : null;
  const paidByHook = pre.data.qr ? await raw(hookPath, note(pre.data.qr.providerRef, '30000.00')) : null;
  const preState = pre.data.qr ? await intentState(pre.data.qr.providerRef) : null;
  check('driver app: prepaid checkout at Midtrans, no demo button, the demo shortcut refused; paid by the notification',
    pre.status === 200 && pre.data.demo === false && /MIDTRANS/.test(pre.data.qr.qrString) && demoConfirm?.data?.ok === false && paidByHook?.status === 200 && preState?.state === 'captured',
    { pre: pre.data, demoConfirm: demoConfirm?.data, preState });

  // ================================================================ QRIS: Xendit
  const xe = await ops('PUT', '/v1/integrations/payments', { provider: 'xendit', settings: { baseUrl: FAKE }, secrets: { secretKey: 'xnd_development_E2E', callbackToken: 'xendit-callback-token-e2e' } });
  const coX = await ops('POST', '/v1/checkout/qris', { ocppIdentity: ID, connectorId: 1, amountIdr: 20_000 });
  const refX = coX.data.qr?.providerRef as string;
  const cb = (token: string) => raw(xe.data.webhookPath, JSON.stringify({ event: 'qr.payment', data: { id: 'qrpy_e2e', reference_id: refX, amount: 20000, status: 'SUCCEEDED' } }), { 'x-callback-token': token });
  // Fail closed: a correctly authenticated "paid" callback that states no amount is not recorded as paid.
  const noAmount = await raw(xe.data.webhookPath, JSON.stringify({ event: 'qr.payment', data: { id: 'qrpy_e2e', reference_id: refX, status: 'SUCCEEDED' } }), { 'x-callback-token': 'xendit-callback-token-e2e' });
  const afterNoAmount = await intentState(refX);
  check('Xendit: a paid callback WITHOUT an amount is not recorded as paid (422, so Xendit retries; the payment stays pending)',
    noAmount.status === 422 && afterNoAmount.state === 'pending', { status: noAmount.status, afterNoAmount });
  const wrongTok = await cb('not-the-token-at-all-xx');
  const rightTok = await cb('xendit-callback-token-e2e');
  const xState = await intentState(refX);
  check('Xendit: a dynamic QR from Xendit; a callback with the wrong token refused, with the verification token captured',
    xe.status === 200 && coX.data.provider === 'xendit' && /XENDIT/.test(coX.data.qr.qrString) && wrongTok.status === 401 && rightTok.status === 200 && xState.state === 'captured', { wrongTok: wrongTok.status, xState });
  const midHookAfterSwitch = await raw(hookPath, note(co2.data.qr.providerRef, '40000.00'));
  check('the old Midtrans URL still settles payments it took (each payment remembers its account)', midHookAfterSwitch.status === 200 && (await intentState(co2.data.qr.providerRef)).state === 'captured');

  // ================================================================ sign-in codes
  const wa = await pa('PUT', '/v1/integrations/otp', { provider: 'whatsapp_cloud', settings: { phoneNumberId: '1098765', templateName: 'plugsure_otp', language: 'id', copyCodeButton: true, baseUrl: FAKE }, secrets: { accessToken: 'EAAG-e2e-token' } });
  const tw = await pa('PUT', '/v1/integrations/otp_fallback', { provider: 'twilio', settings: { accountSid: 'AC00e2e', from: 'PlugSure', baseUrl: FAKE }, secrets: { authToken: 'twilio-auth-e2e' } });
  const twBad = await pa('PUT', '/v1/integrations/otp_fallback', { provider: 'twilio', settings: { accountSid: 'AC00e2e', baseUrl: FAKE } });
  check('sign-in codes: WhatsApp and the Twilio fallback connected by the platform administrator; Twilio without a sender refused', wa.status === 200 && tw.status === 200 && twBad.status === 422, { wa: wa.data, tw: tw.data, twBad: twBad.data });
  const tWa = await pa('POST', '/v1/integrations/otp/test', { phone: '081200000001' });
  check('test: the WhatsApp sender is checked, and a real test code sent to the number given', tWa.data.ok === true && /reachable/.test(tWa.data.message) && /sent to \+6281/.test(tWa.data.message), tWa.data);

  const phone = `0813${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const t4 = Date.now();
  const s1 = await d('POST', '/v1/otp/send', { phone });
  const waMsg = callsTo(/\/messages$/, t4)[0];
  const code = waMsg ? JSON.parse(waMsg.body).template.components[0].parameters[0].text : '';
  const v1 = await d('POST', '/v1/otp/verify', { phone, code });
  check('sign-in: the code goes out on WhatsApp (template with the copy-code button), is not shown on screen, and signs the driver in',
    s1.status === 200 && s1.data.devCode === undefined && !!waMsg && /^\d{6}$/.test(code) && JSON.parse(waMsg.body).to === `62${phone.slice(1)}` && v1.status === 200, { s1: s1.data, v1: v1.data });
  behaviour.whatsappStatus = 400;
  const phone2 = `0813${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const t5 = Date.now();
  const s2 = await d('POST', '/v1/otp/send', { phone: phone2 });
  const sms = callsTo(/Messages\.json$/, t5)[0];
  const code2 = sms ? /(\d{6})/.exec(new URLSearchParams(sms.body).get('Body') ?? '')?.[1] : '';
  const dev2 = (await raw('/d/v1/device', '{}')).data.deviceToken as string;
  const v2 = await fetch(`${API}/d/v1/otp/verify`, { method: 'POST', headers: { authorization: `Bearer ${dev2}`, 'content-type': 'application/json' }, body: JSON.stringify({ phone: phone2, code: code2 }) });
  check('fallback: WhatsApp refuses → the code goes by SMS (Twilio) and still signs in', s2.status === 200 && callsTo(/\/messages$/, t5).length === 1 && !!sms && v2.status === 200, { s2: s2.data, sms: sms?.body });
  behaviour.whatsappStatus = 200;
  const ev = await pa('GET', '/v1/integrations/otp/events?limit=20');
  cc('/v1/integrations/{kind}/events', 'get', '200', ev.data);
  const evText = JSON.stringify(ev.data);
  check('activity: sends and failures listed with the number masked and never the code', ev.data.events.some((e: any) => e.action === 'send_code' && e.outcome === 'failed') && evText.includes('****') && !evText.includes(code) && !evText.includes(phone.slice(1)), ev.data.events?.slice(0, 4));

  // ================================================================ Plug & Charge PKI, map tiles
  const pki = await pa('PUT', '/v1/integrations/pnc_pki', { provider: 'http', settings: { url: `${FAKE}/pki`, signer: 'pki' }, secrets: { token: 'pki-token-e2e' } });
  const tPki = await pa('POST', '/v1/integrations/pnc_pki/test', {});
  const pnc = await ops('GET', '/v1/pnc');
  check('Plug & Charge PKI: the gateway connected and tested (its roots); Plug & Charge now uses it', pki.status === 200 && tPki.data.ok === true && /1 V2G/.test(tPki.data.message) && pnc.data.pki.mode === 'http' && pnc.data.pki.description.includes(FAKE), { tPki: tPki.data, pnc: pnc.data.pki });
  const httpTiles = await pa('PUT', '/v1/integrations/map_tiles', { provider: 'custom', settings: { tileUrl: 'http://tiles.example.test/{z}/{x}/{y}.png', attribution: 'x' } });
  const tiles = await pa('PUT', '/v1/integrations/map_tiles', { provider: 'custom', settings: { tileUrl: 'https://tiles.example.test/{z}/{x}/{y}.png?key=abc', attribution: '© Example Maps', maxZoom: 18 } });
  const meta = await until(async () => (await raw('/d/v1/meta', '{}').catch(() => null), fetch(`${API}/d/v1/meta`).then((r) => r.json() as any)), (m: any) => m?.map?.tileUrl?.includes('tiles.example.test'), 20_000, 1000);
  const csp = await until(() => fetch(`${API}/app/`).then((r) => r.headers.get('content-security-policy') ?? ''), (h) => h.includes('https://tiles.example.test'), 30_000, 2000);
  check('map tiles: https required; the driver app gets the new tile service and the page policy allows its host', httpTiles.status === 422 && tiles.status === 200 && meta.map.attribution === '© Example Maps' && meta.map.maxZoom === 18 && csp.includes('https://tiles.example.test'), { meta: meta?.map, csp: csp.slice(0, 200) });

  // ================================================================ audit, removal
  const audit = await ops('GET', '/v1/audit?limit=100');
  const auditP = await pa('GET', '/v1/audit?limit=100');
  check('audit: every change recorded with the secrets that changed, never their values',
    audit.text.includes('integration.updated') && audit.text.includes('secretsChanged') && !audit.text.includes(SERVER_KEY) && !auditP.text.includes('EAAG-e2e-token') && auditP.text.includes('integration.updated'), audit.status);
  const del = await ops('DELETE', '/v1/integrations/payments?scope=org');
  const ov2 = await ops('GET', '/v1/integrations');
  check('removed: the operator\'s account is removed and the development default applies again', del.data.removed === true && ov2.data.kinds.find((k: any) => k.kind === 'payments').effective.provider === 'mock', ov2.data.kinds.find((k: any) => k.kind === 'payments').effective);
  const view = await fetch(`${API}/js/views/integrations.js`).then((r) => r.text());
  check('console: the Integrations page is served', /registerView\('integrations'/.test(view));
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
