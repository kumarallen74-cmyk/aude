// PlugSure v1.3 — linked e-wallets (GoPay, OVO, DANA, ShopeePay, LinkAja): link once, pay in one tap, end to end.
//
// On a raw OCPP 1.6 charger with real sessions:
//   - Sandbox acquirer with linking on: GoPay linked on the sandbox approval page;
//     a charge paid in one tap (no redirect); the session's unused balance refunded
//     automatically; a 30-day pass paid in one tap; a refused OVO link; another
//     driver refused the wallet; an unlinked wallet unable to pay; guests cannot link.
//   - Midtrans (a local fake): GoPay Tokenization — pay account, activation link,
//     ENABLED with the wallet token, one-tap gopay charge on account id + token,
//     unused balance refunded through Midtrans automatically, insufficient balance
//     refused with a clear message, unbind on unlink.
//   - Xendit (a local fake): OVO as a reusable payment method, activated, charged by
//     payment request, the refund through the Refunds API with the payment request id;
//     ShopeePay and LinkAja linked and charged the same way.
// Everything the test sets is removed at the end.
//
// Needs E2E_DATABASE_URL (the runtime role).
//     npx tsx tools/e2e/linked-wallets-e2e.mts
// NEVER point this at production.
import http from 'node:http';
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
  return { status: r.status, data: d, location: r.headers.get('location') };
};
async function device(signIn: boolean) {
  const dev = (await raw('/d/v1/device', '{}')).data.deviceToken as string;
  const d = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${API}/d${path}`, { method, headers: { authorization: `Bearer ${dev}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let j: any = t; try { j = JSON.parse(t); } catch {} return { status: r.status, data: j };
  };
  const phone = `0818${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  if (signIn) {
    const otp = await d('POST', '/v1/otp/send', { phone });
    await d('POST', '/v1/otp/verify', { phone, code: otp.data.devCode });
  }
  return Object.assign(d, { phone });
}

// ------------------------------------------------------------ fake Midtrans and Xendit
const calls: Array<{ path: string; body: string; at: number }> = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0]!;
    calls.push({ path, body, at: Date.now() });
    const send = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    const j = body ? JSON.parse(body) : {};
    // Midtrans GoPay Tokenization
    if (path === '/v2/pay/account') return send(201, { status_code: '201', account_id: 'acc-e2e', account_status: 'PENDING', actions: [{ name: 'activation-link-url', url: 'https://gopay.test/link/acc-e2e' }] });
    if (path === '/v2/pay/account/acc-e2e') return send(200, { account_id: 'acc-e2e', account_status: 'ENABLED', metadata: { payment_options: [{ name: 'GOPAY_WALLET', active: true, token: 'gpw-tok', balance: { value: '100000.00' } }] } });
    if (path === '/v2/pay/account/acc-e2e/unbind') return send(200, { status_code: '204', account_status: 'DISABLED' });
    if (path === '/v2/charge' && j.payment_type === 'gopay') {
      if (j.transaction_details.gross_amount > 100_000) return send(200, { status_code: '202', status_message: 'Transaction is denied: insufficient balance' });
      return send(200, { status_code: '200', transaction_status: 'settlement', transaction_id: `tx-${j.transaction_details.order_id}` });
    }
    if (/^\/v2\/.+\/refund$/.test(path)) return send(200, { status_code: '200', refund_key: j.refund_key });
    // Xendit Payment Methods v2, payment requests, refunds
    if (path === '/v2/payment_methods') { const id = `pm-${String(j.ewallet.channel_code).toLowerCase()}`; return send(201, { id, status: 'REQUIRES_ACTION', actions: [{ action: 'AUTH', url: `https://${String(j.ewallet.channel_code).toLowerCase()}.test/auth/${id}`, url_type: 'WEB' }] }); }
    if (/^\/v2\/payment_methods\/pm-[a-z]+$/.test(path)) return send(200, { id: path.split('/').pop(), status: 'ACTIVE' });
    if (path === '/payment_requests') return send(201, { id: `pr-${j.reference_id.slice(3, 15)}`, reference_id: j.reference_id, status: 'SUCCEEDED', amount: j.amount });
    if (path === '/refunds') return send(200, { id: `rfd-${Date.now()}`, status: 'SUCCEEDED', amount: j.amount });
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
  const site = await ops('POST', '/v1/sites', { name: 'Linked Wallets E2E Hub', address: 'Jl. Gatot Subroto', kabupatenKotaCode: '3171', gridTariffGroup: 'L/TR', connectedKva: '197', powerFactor: '0.95', phases: '3', pbjtRateBps: '1000' });
  const tariff = await ops('POST', '/v1/tariffs', { name: 'Wallets E2E DC', plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, pricingModel: 'flat', appliesToMaxPowerW: 60000, ppnApplies: true, components: [{ kind: 'energy', rate: 2400, touBlock: 'ANY' }] });
  await ops('PUT', `/v1/sites/${site.data.id}/tariff`, { tariffId: tariff.data.tariffId, currentType: 'DC' });
  const ID = `WLT-${Date.now().toString().slice(-6)}`;
  await ops('POST', '/v1/charge-points', { ocppIdentity: ID, siteId: site.data.id, displayName: 'Wallets E2E', ocppVersion: 'ocpp1.6', evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] }] });
  await ops('POST', `/v1/charge-points/${ID}/activate`);
  const ws = new WebSocket(`${OCPP}/${ID}`, ['ocpp1.6']);
  await new Promise<void>((r) => ws.once('open', () => r()));
  ws.on('message', (m) => { const f = JSON.parse(m.toString()); if (f[0] === 2) ws.send(JSON.stringify([3, f[1], { status: 'Accepted' }])); });
  let n = 0; const call = (a: string, p: unknown) => new Promise<any>((res) => { const id = `w${++n}`; const on = (m: any) => { const f = JSON.parse(m.toString()); if (f[1] === id) { ws.off('message', on); res(f[2]); } }; ws.on('message', on); ws.send(JSON.stringify([2, id, a, p])); });
  await call('BootNotification', { chargePointVendor: 'E2E', chargePointModel: 'WLT' });
  await call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: new Date().toISOString() });
  cleanup.push(async () => ws.close());
  let meter = 200_000;
  const runSession = async (idTag: string, wh: number) => {
    const st = await call('StartTransaction', { connectorId: 1, idTag, meterStart: meter, timestamp: new Date().toISOString() });
    meter += wh;
    await call('StopTransaction', { transactionId: st.transactionId, idTag, meterStop: meter, timestamp: new Date(Date.now() + 60_000).toISOString(), reason: 'EVDisconnected' });
    await call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: new Date().toISOString() });
  };
  const d = await device(true);
  const stations = await until(() => d('GET', '/v1/stations'), (r) => !!r.data.stations?.find((s: any) => s.siteId === site.data.id)?.connectors?.[0], 20_000, 800);
  const conn = stations.data.stations.find((s: any) => s.siteId === site.data.id).connectors[0].connectorId;
  const intentOf = async (ref: string) => (await pg.query(
    `SELECT id, state, method, channel, driver_card_id, amount_captured_idr, refund_state, refund_due_idr, refunded_idr, refund_method, session_id, provider_payment_id FROM payment_intent WHERE provider_ref = $1`, [ref])).rows[0];
  const refOf = (r: any) => r.data?.payment?.providerRef as string;
  const cdrTotal = async (sessionId: string) => Number((await pg.query(`SELECT total_idr FROM cdr WHERE session_id = $1`, [sessionId])).rows[0]?.total_idr ?? -1);

  // ================================================================ sandbox
  const off = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 50_000 });
  const sb = await ops('PUT', '/v1/integrations/payments', { provider: 'mock', settings: { methods: ['QRIS', 'GOPAY', 'OVO', 'DANA', 'SHOPEEPAY', 'LINKAJA'], linkWallets: true } });
  cc('/v1/integrations/{kind}', 'put', '200', sb.data);
  const q = await until(() => d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 50_000 }), (r) => (r.data.linkableWallets ?? []).length === 5, 20_000, 1000);
  check('linking is off by default; switched on, a signed-in driver may link GoPay, OVO, DANA, ShopeePay and LinkAja (none linked yet)',
    (off.data.linkableWallets ?? []).length === 0 && sb.status === 200 && JSON.stringify(q.data.linkableWallets) === '["GOPAY","OVO","DANA","SHOPEEPAY","LINKAJA"]' && q.data.linkedWallets.length === 0, { off: off.data.linkableWallets, q: q.data });

  const guest = await device(false);
  const gLink = await guest('POST', '/v1/wallets', { connectorId: conn, channel: 'GOPAY', phone: '081234567890' });
  const l1 = await d('POST', '/v1/wallets', { connectorId: conn, channel: 'GOPAY' });
  const s1 = await d('GET', `/v1/wallets/${l1.data.id}`);
  const page = await fetch(API + l1.data.activationUrl).then((r) => r.text());
  const approve = await raw(`/pay/sandbox/link/${l1.data.activationUrl.split('/').pop().split('?')[0]}/approve?${l1.data.activationUrl.split('?')[1]}`, '');
  const s1b = await d('GET', `/v1/wallets/${l1.data.id}`);
  const cards = await d('GET', '/v1/cards');
  check('GoPay linked: guests refused; pending until approved on the sandbox page (the account\'s own number, masked); then active and listed',
    gLink.status === 401 && l1.status === 200 && l1.data.status === 'pending' && /\/pay\/sandbox\/link\//.test(l1.data.activationUrl) && s1.data.status === 'pending'
      && page.includes('Hubungkan GoPay') && approve.status === 303 && /\/app\/paid\.html\?for=link&status=linked$/.test(approve.location ?? '')
      && s1b.data.status === 'active' && l1.data.accountLabel === `••••${d.phone.slice(-4)}`
      && cards.data.cards.some((k: any) => k.kind === 'ewallet' && k.channel === 'GOPAY' && k.status === 'active') && !JSON.stringify(cards.data).includes('mock_wallet_'),
    { gLink: gLink.data, l1: l1.data, s1: s1.data, approve, s1b: s1b.data, cards: cards.data });
  const q2 = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 50_000 });
  const w = q2.data.linkedWallets?.[0];
  check('the quote offers the linked GoPay, and no longer offers to link it', w?.channel === 'GOPAY' && JSON.stringify(q2.data.linkableWallets) === '["OVO","DANA","SHOPEEPAY","LINKAJA"]', q2.data);

  const p1 = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 50_000, walletId: w.id });
  const i1 = await intentOf(refOf(p1));
  check('one tap: paid at once with no redirect, recorded as GoPay (e-wallet) on the linked wallet',
    p1.status === 200 && p1.data.payment.action === 'done' && p1.data.payment.checkoutUrl === null && i1.state === 'captured' && i1.amount_captured_idr === 50_000 && i1.method === 'ewallet' && i1.channel === 'GOPAY' && i1.driver_card_id === w.id, { p1: p1.data.payment, i1 });
  const go1 = await d('POST', `/v1/charge/${p1.data.chargeId}/start`);
  await runSession(p1.data.startToken, 5_000);
  const i1b = await until(() => intentOf(refOf(p1)), (i) => i.refund_state === 'refunded', 20_000, 500);
  const total1 = await cdrTotal(i1b.session_id);
  check('the unused balance goes back to the e-wallet automatically, through the acquirer, with no operator action',
    go1.status === 200 && i1b.refund_state === 'refunded' && i1b.refund_method === 'provider' && i1b.refunded_idr === 50_000 - total1 && total1 > 0, { i1b, total1 });

  const plan = await ops('POST', '/v1/subscription-plans', { name: `Wallets E2E Pass ${Date.now().toString().slice(-5)}`, monthlyFeeIdr: 15000, offeredInApp: true });
  cleanup.push(() => ops('PUT', `/v1/subscription-plans/${plan.data.id}`, { active: false, offeredInApp: false }));
  const mem = await d('GET', '/v1/memberships');
  const pass = await d('POST', '/v1/memberships', { planId: plan.data.id, walletId: w.id });
  const passSt = await d('GET', `/v1/memberships/charges/${pass.data.chargeId}`);
  check('a 30-day pass in one tap with the linked GoPay: paid and active at once',
    mem.data.plans.find((p: any) => p.id === plan.data.id)?.linkedWallets?.length === 1 && pass.data.payment?.action === 'done' && passSt.data.state === 'paid' && passSt.data.membership === 'active', { pass: pass.data, passSt: passSt.data });

  const l2 = await d('POST', '/v1/wallets', { connectorId: conn, channel: 'OVO', phone: '0812 3456 7890' });
  await raw(`/pay/sandbox/link/${l2.data.activationUrl.split('/').pop().split('?')[0]}/deny`, '', { accept: 'application/json' });
  const s2 = await d('GET', `/v1/wallets/${l2.data.id}`);
  const bad = await d('POST', '/v1/wallets', { connectorId: conn, channel: 'OVO', phone: '12' });
  const notOffered = await d('POST', '/v1/wallets', { connectorId: conn, channel: 'QRIS' });
  const cards2 = await d('GET', '/v1/cards');
  check('an OVO link refused in the app ends failed and is not listed; a bad number or an e-wallet that cannot be linked is refused',
    l2.data.accountLabel === '••••7890' && s2.data.status === 'failed' && !cards2.data.cards.some((k: any) => k.id === l2.data.id) && bad.status === 422 && notOffered.status === 422, { s2: s2.data, bad: bad.data, notOffered: notOffered.data });

  const other = await device(true);
  const steal = await other('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 20_000, walletId: w.id });
  const peek = await other('GET', `/v1/wallets/${w.id}`);
  const rm = await d('DELETE', `/v1/cards/${w.id}`);
  const after = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 20_000, walletId: w.id });
  check('another driver cannot pay with or even see the wallet; unlinked, it cannot pay', steal.status === 422 && peek.status === 404 && rm.status === 200 && after.status === 422, { steal: steal.data, peek: peek.status, after: after.data });

  // ================================================================ Midtrans: GoPay Tokenization
  await ops('PUT', '/v1/integrations/payments', { provider: 'midtrans', settings: { environment: 'sandbox', baseUrl: FAKE, methods: ['QRIS', 'GOPAY'], linkWallets: true }, secrets: { serverKey: 'SB-Mid-server-E2E-WALLET-77aa' } });
  await until(() => d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 50_000 }), (r) => JSON.stringify(r.data.linkableWallets) === '["GOPAY"]', 20_000, 1000);
  const t1 = Date.now();
  const ml = await d('POST', '/v1/wallets', { connectorId: conn, channel: 'GOPAY' });
  const acct = JSON.parse(callsTo(/^\/v2\/pay\/account$/, t1)[0]?.body ?? '{}');
  const ms = await d('GET', `/v1/wallets/${ml.data.id}`);
  check('Midtrans: a GoPay pay account for the driver\'s number (local format) returning to the app; the activation link; ENABLED → linked',
    ml.status === 200 && ml.data.activationUrl === 'https://gopay.test/link/acc-e2e' && acct.gopay_partner?.phone_number === d.phone.slice(1) && acct.gopay_partner?.country_code === '62'
      && /\/app\/paid\.html\?for=link$/.test(acct.gopay_partner?.redirect_url ?? '') && ms.data.status === 'active', { ml: ml.data, acct, ms: ms.data });
  const q3 = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 60_000 });
  const mw = q3.data.linkedWallets?.[0];
  const t2 = Date.now();
  const mp = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 60_000, walletId: mw?.id });
  const charge = JSON.parse(callsTo(/^\/v2\/charge$/, t2)[0]?.body ?? '{}');
  const im = await intentOf(refOf(mp));
  check('Midtrans: charged in one tap on the account id and payment option token, settled at once',
    q3.data.linkedWallets.length === 1 && mp.data.payment?.action === 'done' && charge.payment_type === 'gopay' && charge.gopay?.account_id === 'acc-e2e' && charge.gopay?.payment_option_token === 'gpw-tok'
      && im.state === 'captured' && im.provider_payment_id === `tx-${refOf(mp)}`, { mp: mp.data, charge, im });
  await d('POST', `/v1/charge/${mp.data.chargeId}/start`);
  const t3 = Date.now();
  await runSession(mp.data.startToken, 6_000);
  const imb = await until(() => intentOf(refOf(mp)), (i) => i.refund_state === 'refunded', 20_000, 500);
  const total2 = await cdrTotal(imb.session_id);
  const rf = callsTo(/\/refund$/, t3)[0];
  check('Midtrans: the unused balance refunded automatically through Midtrans\' refund API for the right amount',
    imb.refunded_idr === 60_000 - total2 && rf?.path === `/v2/${refOf(mp)}/refund` && JSON.parse(rf.body).amount === 60_000 - total2, { imb, total2, rf });
  const broke = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 150_000, walletId: mw?.id });
  check('insufficient GoPay balance: refused with a clear message, nothing recorded as paid', broke.status === 422 && /GoPay ditolak/.test(broke.data.error) && /saldo/.test(broke.data.error), broke.data);
  const t4 = Date.now();
  await d('DELETE', `/v1/cards/${mw?.id}`);
  check('unlinking tells Midtrans (unbind)', (await until(async () => callsTo(/\/unbind$/, t4).length, (k) => k === 1, 5000, 200)) === 1);

  // ================================================================ Xendit: OVO as a reusable payment method
  await ops('PUT', '/v1/integrations/payments', { provider: 'xendit', settings: { baseUrl: FAKE, methods: ['QRIS', 'OVO', 'DANA', 'SHOPEEPAY', 'LINKAJA'], linkWallets: true }, secrets: { secretKey: 'xnd_development_WALLETS', callbackToken: 'xendit-callback-token-wallets-e2e' } });
  await until(() => d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 50_000 }), (r) => JSON.stringify(r.data.linkableWallets) === '["OVO","DANA","SHOPEEPAY","LINKAJA"]', 20_000, 1000);
  const t5 = Date.now();
  const xl = await d('POST', '/v1/wallets', { connectorId: conn, channel: 'OVO' });
  const pmBody = JSON.parse(callsTo(/^\/v2\/payment_methods$/, t5)[0]?.body ?? '{}');
  const xs = await d('GET', `/v1/wallets/${xl.data.id}`);
  const q4 = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 45_000 });
  const xw = q4.data.linkedWallets?.[0];
  const t6 = Date.now();
  const xp = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 45_000, walletId: xw?.id });
  const prBody = JSON.parse(callsTo(/^\/payment_requests$/, t6)[0]?.body ?? '{}');
  const ix = await intentOf(refOf(xp));
  check('Xendit: OVO linked as a reusable e-wallet payment method (the number, the return page), activated; charged in one tap by payment request',
    xl.data.activationUrl === 'https://ovo.test/auth/pm-ovo' && pmBody.reusability === 'MULTIPLE_USE' && pmBody.ewallet?.channel_code === 'OVO' && pmBody.ewallet?.channel_properties?.mobile_number === `+62${d.phone.slice(1)}`
      && xs.data.status === 'active' && xp.data.payment?.action === 'done' && prBody.payment_method_id === 'pm-ovo' && prBody.amount === 45_000 && ix.state === 'captured' && /^pr-/.test(ix.provider_payment_id ?? ''),
    { xl: xl.data, pmBody, xs: xs.data, xp: xp.data, prBody, ix });
  await d('POST', `/v1/charge/${xp.data.chargeId}/start`);
  const t7 = Date.now();
  await runSession(xp.data.startToken, 4_000);
  const ixb = await until(() => intentOf(refOf(xp)), (i) => i.refund_state === 'refunded', 20_000, 500);
  const total3 = await cdrTotal(ixb.session_id);
  const xr = JSON.parse(callsTo(/^\/refunds$/, t7)[0]?.body ?? '{}');
  check('Xendit: the unused balance refunded automatically through the Refunds API on the payment request',
    ixb.refunded_idr === 45_000 - total3 && xr.payment_request_id === ix.provider_payment_id && xr.amount === 45_000 - total3, { ixb, total3, xr });

  // ShopeePay and LinkAja: linked and charged the same way at Xendit.
  for (const ch of ['SHOPEEPAY', 'LINKAJA']) {
    const tA = Date.now();
    const lk = await d('POST', '/v1/wallets', { connectorId: conn, channel: ch });
    const body = JSON.parse(callsTo(/^\/v2\/payment_methods$/, tA)[0]?.body ?? '{}');
    const st = await d('GET', `/v1/wallets/${lk.data.id}`);
    const qq = await d('POST', '/v1/charge/quote', { connectorId: conn, amountIdr: 25_000 });
    const lw = (qq.data.linkedWallets ?? []).find((x: any) => x.channel === ch);
    const tB = Date.now();
    const pay = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountIdr: 25_000, walletId: lw?.id });
    const pr = JSON.parse(callsTo(/^\/payment_requests$/, tB)[0]?.body ?? '{}');
    const ip = await intentOf(refOf(pay));
    check(`Xendit ${ch}: linked as a reusable e-wallet payment method (no number in its channel properties), activated, and paid in one tap`,
      lk.status === 200 && lk.data.activationUrl === `https://${ch.toLowerCase()}.test/auth/pm-${ch.toLowerCase()}` && body.ewallet?.channel_code === ch && body.reusability === 'MULTIPLE_USE'
        && body.ewallet?.channel_properties?.mobile_number === undefined && st.data.status === 'active' && lw && pay.data.payment?.action === 'done'
        && pr.payment_method_id === `pm-${ch.toLowerCase()}` && ip.state === 'captured' && ip.channel === ch && ip.method === 'ewallet',
      { lk: lk.data, body, st: st.data, pay: pay.data, pr, ip });
  }

  // ================================================================ app
  const app = await fetch(`${API}/app/`).then((r) => r.text());
  const paid = await fetch(`${API}/app/paid.html`).then((r) => r.text());
  check('the app links e-wallets from the payment picker and lists them with the cards; the return page hands links back to the app',
    app.includes('function startWalletLink') && app.includes('Terhubung · 1 ketuk') && app.includes('Putuskan') && paid.includes("q.get('for')!=='link'"));
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
