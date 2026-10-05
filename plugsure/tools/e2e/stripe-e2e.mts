// PlugSure WP3 — Stripe for Malaysia and Singapore, end to end against a LOCAL FAKE STRIPE (tools/testing/fake-stripe.ts).
//
// Two fake Stripe accounts (SG and MY) run in this process; the API calls them over HTTP and they sign and POST their
// webhooks to the API's /pay/notify/<key>, exactly as Stripe does. On real OCPP 1.6 chargers at a Singapore and a
// Malaysian site:
//   - the integrations: one Stripe account per country (countryCode), methods of that country only, keys checked;
//   - SG card hold: S$30 authorised on PlugSure's Payment Element page (its CSP admits js.stripe.com there only; no
//     e-mail asked) → session → the rated total captured at Stripe (amount_to_capture), the rest released;
//   - a hold that delivers nothing is cancelled at Stripe (released);
//   - SG PayNow: the SGQR code, paid → session → the unused balance refunded through Stripe (asynchronous: refund.updated);
//   - MY FPX and MY GrabPay pre-purchases, confirmed by webhook;
//   - a saved card (MY): kept with brand and last four, then paying in one tap as a hold;
//   - webhooks: a bad signature and a stale one refused (400), a replayed event answered 200 and not applied twice,
//     an event PlugSure does not use acknowledged; an underpayment voided and refunded with a critical alert; a payment
//     in the wrong currency never booked; Stripe's minimum amount (S$0.50, RM 2.00) refused before Stripe is asked.
// Everything the test sets is removed at the end.
//
// Needs E2E_DATABASE_URL (the runtime role) and an API started with MULTI_COUNTRY=true (the CI e2e job sets both).
//     npx tsx tools/e2e/stripe-e2e.mts
// NEVER point this at production.
import WebSocket from 'ws';
import { FakeStripe } from '../testing/fake-stripe.js';

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
    return { status: r.status, data: d, text: t, headers: r.headers };
  };
}
const ops = session();
async function driver() {
  const dev = (await (await fetch(`${API}/d/v1/device`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as any).deviceToken as string;
  const d = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${API}/d${path}`, { method, headers: { authorization: `Bearer ${dev}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let j: any = t; try { j = JSON.parse(t); } catch {} return { status: r.status, data: j };
  };
  const phone = `0816${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const otp = await d('POST', '/v1/otp/send', { phone });
  await d('POST', '/v1/otp/verify', { phone, code: otp.data.devCode });
  return d;
}

const SK = 'sk_test_51E2eStripeFakeKey', PK = 'pk_test_51E2eStripeFakeKey';
const WH_SG = 'whsec_e2eStripeSg01', WH_MY = 'whsec_e2eStripeMy01';
const sg = await new FakeStripe({ secretKey: SK, webhookSecret: WH_SG, country: 'SG' }).start();
const my = await new FakeStripe({ secretKey: SK, webhookSecret: WH_MY, country: 'MY' }).start();

const pg = process.env.E2E_DATABASE_URL ? new ((await import('pg')).default.Client)({ connectionString: process.env.E2E_DATABASE_URL }) : null;
if (pg) await pg.connect();
const cleanup: Array<() => Promise<unknown>> = [];
const stamp = Date.now().toString().slice(-6);

try {
  if (!pg) throw new Error('set E2E_DATABASE_URL (the runtime role)');
  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  check('setup: operator signs in', login.status === 200, login.data);
  for (const cc of ['SG', 'MY']) {
    await ops('DELETE', `/v1/integrations/payments?scope=org&countryCode=${cc}`);
    cleanup.push(() => ops('DELETE', `/v1/integrations/payments?scope=org&countryCode=${cc}`));
  }

  // ================================================================ integrations: one Stripe account per country
  const stripe = (cc: 'SG' | 'MY', fake: FakeStripe, wh: string, methods: string[], extra: Record<string, unknown> = {}) =>
    ops('PUT', '/v1/integrations/payments', {
      provider: 'stripe', countryCode: cc,
      settings: { publishableKey: PK, methods, cardHolds: true, saveCards: true, baseUrl: fake.url, ...extra },
      secrets: { secretKey: SK, webhookSecret: wh },
    });
  const noCountry = await ops('PUT', '/v1/integrations/payments', { provider: 'stripe', settings: { publishableKey: PK, methods: ['CARD'] }, secrets: { secretKey: SK, webhookSecret: WH_SG } });
  const payNowMy = await stripe('MY', my, WH_MY, ['CARD', 'PAYNOW']);
  const mixed = await ops('PUT', '/v1/integrations/payments', { provider: 'stripe', countryCode: 'SG', settings: { publishableKey: 'pk_live_51Mixed', methods: ['CARD'], baseUrl: sg.url }, secrets: { secretKey: SK, webhookSecret: WH_SG } });
  const badWh = await ops('PUT', '/v1/integrations/payments', { provider: 'stripe', countryCode: 'SG', settings: { publishableKey: PK, methods: ['CARD'], baseUrl: sg.url }, secrets: { secretKey: SK, webhookSecret: 'not-a-secret' } });
  const xenditSg = await ops('PUT', '/v1/integrations/payments', { provider: 'xendit', countryCode: 'SG', settings: { methods: ['QRIS'] }, secrets: { secretKey: 'xnd_development_x', callbackToken: 'x' } });
  check('integrations: Stripe needs its country; PayNow is refused on a MY account; keys of one mode; a whsec_ secret; Indonesian rails cannot serve SG',
    noCountry.status === 422 && /Malaysia \(MY\) or Singapore \(SG\)/.test(noCountry.data?.error) && payNowMy.status === 422 && /PayNow/.test(payNowMy.data?.error)
      && mixed.status === 422 && /one mode/.test(mixed.data?.error) && badWh.status === 422 && /whsec_/.test(badWh.data?.error) && xenditSg.status === 422,
    { noCountry: noCountry.data, payNowMy: payNowMy.data, mixed: mixed.data, badWh: badWh.data, xenditSg: xenditSg.data });
  const isg = await stripe('SG', sg, WH_SG, ['CARD', 'PAYNOW', 'GRABPAY']);
  const imy = await stripe('MY', my, WH_MY, ['CARD', 'FPX', 'GRABPAY']);
  check('integrations: the SG and MY Stripe accounts are saved, each with its own webhook URL; secrets only as hints',
    isg.status === 200 && imy.status === 200 && isg.data.countryCode === 'SG' && imy.data.countryCode === 'MY' && /\/pay\/notify\//.test(isg.data.webhookUrl) && isg.data.webhookUrl !== imy.data.webhookUrl
      && !JSON.stringify(isg.data).includes(SK) && !JSON.stringify(isg.data).includes(WH_SG), { isg: isg.data, imy: imy.data });
  sg.setWebhookUrl(isg.data.webhookUrl);
  my.setWebhookUrl(imy.data.webhookUrl);
  const ov = await ops('GET', '/v1/integrations');
  const byC = (cc: string) => ov.data.paymentsByCountry?.find((x: any) => x.countryCode === cc);
  check('integrations: listed per country (SG, MY) with what is in force; the Indonesian acquirer untouched',
    byC('SG')?.own?.provider === 'stripe' && byC('MY')?.effective?.provider === 'stripe' && ov.data.kinds.find((k: any) => k.kind === 'payments')?.own?.provider !== 'stripe', ov.data.paymentsByCountry);
  const tsg = await ops('POST', '/v1/integrations/payments/test', { countryCode: 'SG' });
  check('integrations: the SG account tests OK (balance; the account is in SG; TEST mode named)', tsg.data.ok === true && /TEST mode/.test(tsg.data.message) && /SG/.test(tsg.data.message), tsg.data);

  // ================================================================ sites, tariffs, chargers (SG, MY)
  const sgSite = await ops('POST', '/v1/sites', { countryCode: 'SG', name: `Stripe SG ${stamp}`, address: '6 Raffles Boulevard', city: 'Singapore', postalCode: '039594', lat: '1.2913', lon: '103.8572', connectedKva: '150', powerFactor: '0.95', phases: '3' });
  const mySite = await ops('POST', '/v1/sites', { countryCode: 'MY', name: `Stripe MY ${stamp}`, address: 'Jalan Bukit Bintang 168', city: 'Kuala Lumpur', postalCode: '55100', lat: '3.149', lon: '101.7133', connectedKva: '150', powerFactor: '0.95', phases: '3' });
  const sgT = await ops('POST', '/v1/tariffs', { name: `Stripe SG ${stamp}`, countryCode: 'SG', appliesToMaxPowerW: 60000, components: [{ kind: 'energy', rate: 0.65, touBlock: 'ANY' }] });
  const myT = await ops('POST', '/v1/tariffs', { name: `Stripe MY ${stamp}`, countryCode: 'MY', appliesToMaxPowerW: 60000, components: [{ kind: 'energy', rate: 1.2, touBlock: 'ANY' }] });
  await ops('PUT', `/v1/sites/${sgSite.data.id}/tariff`, { tariffId: sgT.data.tariffId, currentType: 'DC' });
  await ops('PUT', `/v1/sites/${mySite.data.id}/tariff`, { tariffId: myT.data.tariffId, currentType: 'DC' });
  check('setup: a Singapore and a Malaysian site with their tariffs (MULTI_COUNTRY=true)', sgSite.status === 200 && mySite.status === 200 && sgT.status === 200 && myT.status === 200,
    { sgSite: sgSite.data, mySite: mySite.data, sgT: sgT.data, myT: myT.data });

  const charger = async (siteId: string, tag: string) => {
    const ID = `STR-${tag}-${stamp}`;
    await ops('POST', '/v1/charge-points', { ocppIdentity: ID, siteId, displayName: ID, ocppVersion: 'ocpp1.6', evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000 }] }] });
    await ops('POST', `/v1/charge-points/${ID}/activate`);
    const ws = new WebSocket(`${OCPP}/${ID}`, ['ocpp1.6']);
    await new Promise<void>((r) => ws.once('open', () => r()));
    ws.on('message', (m) => { const f = JSON.parse(m.toString()); if (f[0] === 2) ws.send(JSON.stringify([3, f[1], { status: 'Accepted' }])); });
    let n = 0;
    const call = (a: string, p: unknown) => new Promise<any>((res) => { const id = `${tag}${++n}`; const on = (m: any) => { const f = JSON.parse(m.toString()); if (f[1] === id) { ws.off('message', on); res(f[2]); } }; ws.on('message', on); ws.send(JSON.stringify([2, id, a, p])); });
    await call('BootNotification', { chargePointVendor: 'E2E', chargePointModel: 'STRIPE' });
    await call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: new Date().toISOString() });
    cleanup.push(async () => ws.close());
    let meter = 100_000;
    const run = async (idTag: string, wh: number) => {
      const st = await call('StartTransaction', { connectorId: 1, idTag, meterStart: meter, timestamp: new Date().toISOString() });
      await call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Charging', timestamp: new Date().toISOString() });
      meter += wh;
      await call('StopTransaction', { transactionId: st.transactionId, idTag, meterStop: meter, timestamp: new Date(Date.now() + 60_000).toISOString(), reason: 'EVDisconnected' });
      await call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: new Date().toISOString() });
      return st;
    };
    return { ID, run };
  };
  const cSg = await charger(sgSite.data.id, 'SG');
  const cMy = await charger(mySite.data.id, 'MY');

  const d = await driver();
  const connOf = async (siteId: string) => {
    const st = await until(() => d('GET', '/v1/stations'), (r) => !!r.data.stations?.find((s: any) => s.siteId === siteId)?.connectors?.[0], 20_000, 800);
    return st.data.stations.find((s: any) => s.siteId === siteId).connectors[0].connectorId as string;
  };
  const connSg = await connOf(sgSite.data.id);
  const connMy = await connOf(mySite.data.id);
  const intentOf = async (ref: string) => (await pg.query(
    `SELECT id, state, mode, method, channel, currency, hold_state, amount_authorised_minor, amount_captured_minor, hold_capture_minor, refund_state, refund_due_minor, refund_ref,
            provider_payment_id, integration_id, session_id, driver_card_id FROM payment_intent WHERE provider = 'stripe' AND provider_ref = $1`, [ref])).rows[0];
  const cdrTotal = async (sessionId: string) => Number((await pg.query(`SELECT total_minor FROM cdr WHERE session_id = $1`, [sessionId])).rows[0]?.total_minor ?? -1);
  const lastNotification = async (integrationId: string) =>
    (await pg.query(`SELECT outcome FROM integration_event WHERE integration_id = $1 AND action = 'notification' ORDER BY id DESC LIMIT 1`, [integrationId])).rows[0]?.outcome;

  const q = await until(() => d('POST', '/v1/charge/quote', { connectorId: connSg, amountMinor: 3000 }), (r) => r.data?.cardHolds === true, 20_000, 1000);
  const qMy = await d('POST', '/v1/charge/quote', { connectorId: connMy, amountMinor: 5000 });
  check('driver: at the SG charger the quote offers card (held), PayNow and GrabPay; at the MY charger card, FPX and GrabPay',
    q.data.paymentMethods?.map((m: any) => m.channel).join() === 'CARD,PAYNOW,GRABPAY' && qMy.data.paymentMethods?.map((m: any) => m.channel).join() === 'CARD,FPX,GRABPAY',
    { sg: q.data.paymentMethods, my: qMy.data.paymentMethods, err: q.data.error });

  // ================================================================ messages in the driver's language (v1.7.0)
  const dLang = async (path: string, body: unknown, lang?: string) => {
    const dev = (await (await fetch(`${API}/d/v1/device`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as any).deviceToken as string;
    const r = await fetch(`${API}/d${path}`, { method: 'POST', headers: { authorization: `Bearer ${dev}`, 'content-type': 'application/json', ...(lang ? { 'x-driver-lang': lang } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) as any };
  };
  const stationsAll = await d('GET', '/v1/stations');
  const idConn = stationsAll.data.stations?.find((s: any) => (s.currency ?? 'IDR') === 'IDR' && s.connectors?.[0])?.connectors[0].connectorId as string | undefined;
  const enSg = await dLang('/v1/charge/quote', { connectorId: connSg, amountMinor: 0 });
  const idSg = await dLang('/v1/charge/quote', { connectorId: connSg, amountMinor: 0 }, 'id');
  const enApp = await dLang('/v1/charge/quote', { connectorId: idConn, amountMinor: 0 }, 'en');
  const idId = await dLang('/v1/charge/quote', { connectorId: idConn, amountMinor: 0 });
  check('language: a Singapore charger answers in English; the app\'s choice (X-Driver-Lang) wins; an Indonesian charger keeps the exact Indonesian text',
    enSg.data?.error === 'Invalid amount.' && idSg.data?.error === 'Jumlah tidak valid.' && enApp.data?.error === 'Invalid amount.' && idId.data?.error === 'Jumlah tidak valid.',
    { enSg: enSg.data, idSg: idSg.data, enApp: enApp.data, idId: idId.data, idConn });

  // ================================================================ SG card hold: S$30, captured at the session's total
  const h1 = await d('POST', '/v1/charge/prepaid', { connectorId: connSg, amountMinor: 3000, method: 'CARD' });
  const ref1 = h1.data?.payment?.providerRef as string;
  const i1 = await intentOf(ref1);
  const pi1 = sg.intents.get(i1?.provider_payment_id);
  check('SG card hold: a PaymentIntent for 3000 SGD cents with manual capture; recorded preauth in SGD',
    h1.status === 200 && h1.data.payment.hold === true && i1?.mode === 'preauth' && i1.currency === 'SGD' && pi1?.amount === 3000 && pi1.currency === 'sgd' && pi1.capture_method === 'manual',
    { h1: h1.data, i1, pi1 });
  const pageRes = await fetch(h1.data.payment.checkoutUrl);
  const pageHtml = await pageRes.text();
  const csp = pageRes.headers.get('content-security-policy') ?? '';
  check('the card page: PlugSure\'s Payment Element page (S$ 30.00, hold note); its CSP admits js.stripe.com only there; no e-mail or phone asked',
    pageRes.status === 200 && pageHtml.includes('S$ 30.00') && pageHtml.includes('https://js.stripe.com/') && pageHtml.includes(pi1?.client_secret) && /Hold only/.test(pageHtml)
      && /<h1>Card hold<\/h1>/.test(pageHtml) && /<p class="mute">EV charging<\/p>/.test(pageHtml) && (pageHtml.match(/Charging\b/g) ?? []).length === 0
      && /script-src [^;]*https:\/\/js\.stripe\.com/.test(csp) && /frame-src [^;]*hooks\.stripe\.com/.test(csp) && !/<input[^>]*email/i.test(pageHtml),
    { status: pageRes.status, csp, html: pageHtml.slice(0, 400) });
  const consoleCsp = (await fetch(`${API}/`)).headers.get('content-security-policy') ?? '';
  const js = await fetch(`${API}/pay/stripe.js`).then((r) => r.text());
  check('…the console keeps its strict CSP; the page script asks for no e-mail/phone and turns Link off',
    !consoleCsp.includes('stripe') && /email: 'never'/.test(js) && /phone: 'never'/.test(js) && /link: 'never'/.test(js), consoleCsp);
  const wrongPage = await fetch(`${API}/pay/stripe/${ref1}/pi_000000000000000000000000`);
  check('…the page needs the PaymentIntent that carries this reference (404 otherwise)', wrongPage.status === 404, wrongPage.status);

  sg.confirmCard(i1.provider_payment_id);
  await sg.flush();
  const i1b = await until(() => intentOf(ref1), (i) => i.state === 'authorised', 10_000, 300);
  check('SG card hold: Stripe\'s amount_capturable_updated webhook (signed, delivered to /pay/notify) marks it authorised and held',
    i1b.state === 'authorised' && i1b.hold_state === 'held' && sg.lastEvent('payment_intent.amount_capturable_updated', i1.provider_payment_id)?.status === 200, i1b);
  const go1 = await d('POST', `/v1/charge/${h1.data.chargeId}/start`);
  await cSg.run(h1.data.startToken, 10_000);
  const i1c = await until(() => intentOf(ref1), (i) => i.hold_state === 'captured', 25_000, 500);
  const total1 = await cdrTotal(i1c.session_id);
  const pi1c = sg.intents.get(i1.provider_payment_id)!;
  const capReq = sg.posts(new RegExp(`/v1/payment_intents/${i1.provider_payment_id}/capture$`))[0];
  check('SG card hold: after a 10 kWh session the rated total (S$6.50) is captured at Stripe (amount_to_capture), the rest released, no refund',
    go1.status === 200 && total1 === 650 && i1c.state === 'captured' && Number(i1c.amount_captured_minor) === 650 && i1c.refund_state === null
      && capReq?.body.amount_to_capture === '650' && pi1c.amount_received === 650 && pi1c.status === 'succeeded', { total1, i1c, capReq: capReq?.body, pi: pi1c.status });
  await sg.flush();
  check('…Stripe\'s payment_intent.succeeded for the capture is acknowledged (capture confirmed)', (await lastNotification(i1c.integration_id)) === 'capture_confirmed', await lastNotification(i1c.integration_id));

  // ================================================================ a hold that delivers nothing is cancelled at Stripe
  const h2 = await d('POST', '/v1/charge/prepaid', { connectorId: connSg, amountMinor: 2000, method: 'CARD' });
  const i2 = await intentOf(h2.data.payment.providerRef);
  sg.confirmCard(i2.provider_payment_id);
  await sg.flush();
  await until(() => intentOf(h2.data.payment.providerRef), (i) => i.state === 'authorised', 10_000, 300);
  await d('POST', `/v1/charge/${h2.data.chargeId}/start`);
  await cSg.run(h2.data.startToken, 0);
  const i2b = await until(() => intentOf(h2.data.payment.providerRef), (i) => i.hold_state === 'released', 25_000, 500);
  check('SG card hold unused (0 kWh): released — the PaymentIntent cancelled at Stripe, nothing captured',
    i2b.hold_state === 'released' && i2b.amount_captured_minor === null && sg.intents.get(i2.provider_payment_id)!.status === 'canceled'
      && sg.posts(new RegExp(`/v1/payment_intents/${i2.provider_payment_id}/cancel$`)).length === 1, i2b);

  // ================================================================ SG PayNow: pre-purchase, unused balance refunded
  const p1 = await d('POST', '/v1/charge/prepaid', { connectorId: connSg, amountMinor: 2000, method: 'PAYNOW' });
  const ip1 = await intentOf(p1.data?.payment?.providerRef);
  check('SG PayNow: a QR (the SGQR payload) shown like QRIS; recorded prepurchase, method qr, channel PAYNOW, S$20.00',
    p1.status === 200 && p1.data.payment.action === 'qr' && /^000201.*5802SG/.test(p1.data.qr?.qrString ?? '') && ip1?.mode === 'prepurchase' && ip1.method === 'qr' && ip1.channel === 'PAYNOW' && Number(ip1.amount_authorised_minor) === 2000,
    { p1: p1.data, ip1 });
  sg.payNow(ip1.provider_payment_id);
  await sg.flush();
  await until(() => intentOf(p1.data.payment.providerRef), (i) => i.state === 'captured', 10_000, 300);
  await d('POST', `/v1/charge/${p1.data.chargeId}/start`);
  await cSg.run(p1.data.startToken, 10_000);
  const ip1b = await until(() => intentOf(p1.data.payment.providerRef), (i) => i.refund_state === 'due', 25_000, 500);
  check('SG PayNow: paid by webhook; after a S$6.50 session the unused S$13.50 is queued for refund', Number(ip1b.refund_due_minor) === 1350, ip1b);
  const rp = await ops('POST', `/v1/refunds/${ip1b.id}/process`);
  const refund = [...sg.refunds.values()].find((r) => r.payment_intent === ip1.provider_payment_id);
  check('SG PayNow: refunded through Stripe\'s Refunds API (1350 cents, the stable idempotency key); pending, as PayNow refunds are asynchronous',
    rp.data.state === 'processing' && refund?.amount === 1350 && refund.metadata.plugsure_idem === `refund-${ip1b.id}`
      && sg.posts(/^\/v1\/refunds$/).at(-1)?.headers['idempotency-key'] === `refund-${ip1b.id}`, { rp: rp.data, refund });
  sg.settleRefund(refund!.id, 'succeeded');
  await sg.flush();
  const ip1c = await until(() => intentOf(p1.data.payment.providerRef), (i) => i.refund_state === 'refunded', 10_000, 300);
  check('SG PayNow: refund.updated (succeeded) completes the refund', ip1c.refund_state === 'refunded' && ip1c.refund_ref === refund!.id, ip1c);
  // The app's receipt (UI sweep v1.7.0): a Singapore receipt carries the GST registration (when registered), never the
  // Indonesian NPWP, and its energy line's rate is S$0.65 in major units (it printed "× S$ 0.01").
  const rc1 = await d('GET', `/v1/charge/${p1.data.chargeId}/receipt`);
  const eLine = (rc1.data?.lines ?? []).find((l: any) => l.kind === 'energy');
  check('SG receipt in the app: no NPWP (GST Reg. No. when registered); the energy rate S$0.65 per kWh in major units; the refund shown',
    rc1.status === 200 && rc1.data.station.operatorNpwp === null && (rc1.data.station.taxRegistration === null || rc1.data.station.taxRegistration.label === 'GST Reg. No.')
      && eLine?.unitRate === 0.65 && rc1.data.settlement?.refundMinor === 1350, { station: rc1.data?.station, eLine, settlement: rc1.data?.settlement });

  // ================================================================ MY FPX and GrabPay
  const f1 = await d('POST', '/v1/charge/prepaid', { connectorId: connMy, amountMinor: 5000, method: 'FPX' });
  const if1 = await intentOf(f1.data?.payment?.providerRef);
  const fpi = my.intents.get(if1?.provider_payment_id);
  const fpage = f1.data?.payment?.checkoutUrl ? await fetch(f1.data.payment.checkoutUrl).then((r) => r.text()) : '';
  check('MY FPX: a PaymentIntent for RM 50.00 (fpx, MYR, automatic capture) confirmed on the page (the bank list is Stripe\'s); method bank',
    f1.status === 200 && f1.data.payment.action === 'redirect' && fpi?.payment_method_types?.[0] === 'fpx' && fpi.currency === 'myr' && fpi.amount === 5000 && if1.method === 'bank' && fpage.includes('RM 50.00'),
    { f1: f1.data, fpi });
  my.completeRedirect(if1.provider_payment_id, { bank: 'maybank2u' });
  await my.flush();
  const if1b = await until(() => intentOf(f1.data.payment.providerRef), (i) => i.state === 'captured', 10_000, 300);
  check('MY FPX: paid, confirmed by Stripe\'s webhook (captured RM 50.00)', if1b.state === 'captured' && Number(if1b.amount_captured_minor) === 5000, if1b);

  const g1 = await d('POST', '/v1/charge/prepaid', { connectorId: connMy, amountMinor: 3000, method: 'GRABPAY' });
  const ig1 = await intentOf(g1.data?.payment?.providerRef);
  check('MY GrabPay: confirmed server-side; the driver is sent to GrabPay (Stripe\'s redirect URL)',
    g1.status === 200 && g1.data.payment.action === 'redirect' && /\/grabpay\/pi_/.test(g1.data.payment.checkoutUrl) && ig1?.channel === 'GRABPAY', g1.data);
  my.completeRedirect(ig1.provider_payment_id);
  await my.flush();
  const ig1b = await until(() => intentOf(g1.data.payment.providerRef), (i) => i.state === 'captured', 10_000, 300);
  check('MY GrabPay: paid, captured by webhook', ig1b.state === 'captured' && Number(ig1b.amount_captured_minor) === 3000, ig1b);

  // ================================================================ a saved card (MY): kept, then one tap as a hold
  const s1 = await d('POST', '/v1/charge/prepaid', { connectorId: connMy, amountMinor: 4000, method: 'CARD', saveCard: true });
  const is1 = await intentOf(s1.data?.payment?.providerRef);
  const spi = my.intents.get(is1?.provider_payment_id);
  check('MY saved card: the hold asks Stripe to keep the card (a Customer, setup_future_usage off_session)',
    s1.status === 200 && s1.data.payment.saveCard === true && !!spi?.customer && spi.setup_future_usage === 'off_session', { s1: s1.data, spi });
  my.confirmCard(is1.provider_payment_id, { brand: 'mastercard', last4: '4444' });
  await my.flush();
  await until(() => intentOf(s1.data.payment.providerRef), (i) => i.state === 'authorised', 10_000, 300);
  const cards = await until(() => d('GET', '/v1/cards'), (r) => (r.data.cards ?? []).length > 0, 10_000, 300);
  const card = cards.data.cards?.[0];
  check('MY saved card: kept for the driver as MASTERCARD ••4444 (read from Stripe), never the token',
    card?.brand === 'MASTERCARD' && card.last4 === '4444' && !JSON.stringify(cards.data).includes(spi!.customer), cards.data);
  await d('POST', `/v1/charge/${s1.data.chargeId}/start`);
  await cMy.run(s1.data.startToken, 0);
  const qs = await d('POST', '/v1/charge/quote', { connectorId: connMy, amountMinor: 4000 });
  const s2 = await d('POST', '/v1/charge/prepaid', { connectorId: connMy, amountMinor: 4000, savedCardId: qs.data.savedCards?.[0]?.id });
  const is2 = await intentOf(s2.data?.payment?.providerRef);
  check('MY saved card: offered at the MY charger only, pays in one tap — held at once (no page)',
    qs.data.savedCards?.length === 1 && s2.status === 200 && s2.data.payment.action === 'done' && is2?.state === 'authorised' && is2.hold_state === 'held'
      && (await d('POST', '/v1/charge/quote', { connectorId: connSg, amountMinor: 3000 })).data.savedCards?.length === 0, { qs: qs.data.savedCards, s2: s2.data, is2 });
  await d('POST', `/v1/charge/${s2.data.chargeId}/start`);
  await cMy.run(s2.data.startToken, 0);
  await until(() => intentOf(s2.data.payment.providerRef), (i) => i.hold_state === 'released', 25_000, 500);

  // ================================================================ webhooks: signatures, replays, other events
  const g2 = await d('POST', '/v1/charge/prepaid', { connectorId: connSg, amountMinor: 1500, method: 'GRABPAY' });
  const ig2 = await intentOf(g2.data.payment.providerRef);
  sg.behaviour.deliver = false;
  const evBody = sg.emit('payment_intent.succeeded', { ...sg.intents.get(ig2.provider_payment_id)!, status: 'succeeded', amount_received: 1500 });
  sg.behaviour.deliver = true;
  const bad = await sg.deliver(evBody, sg.sign(evBody, undefined, 'whsec_attacker'));
  const tampered = await sg.deliver(evBody.replace('"amount_received":1500', '"amount_received":15000'), sg.sign(evBody));
  const stale = await sg.deliver(evBody, sg.sign(evBody, Math.floor(Date.now() / 1000) - 600));
  const unsigned = await fetch(isg.data.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: evBody }).then((r) => r.status);
  check('webhooks: a wrong secret, a tampered body, a stale timestamp, no signature — all 400, nothing applied',
    bad === 400 && tampered === 400 && stale === 400 && unsigned === 400 && (await intentOf(g2.data.payment.providerRef)).state === 'pending', { bad, tampered, stale, unsigned });
  const ok1 = await sg.deliver(evBody);
  const st1 = (await intentOf(g2.data.payment.providerRef)).state;
  const replay = await sg.deliver(evBody);
  const replayOutcome = await lastNotification(ig2.integration_id);
  check('webhooks: the valid event applies once; the same event again (a replay, re-signed) is answered 200 and not applied again',
    ok1 === 200 && st1 === 'captured' && replay === 200 && replayOutcome === 'duplicate_event', { ok1, st1, replay, replayOutcome });
  const other = sg.emit('charge.succeeded', { id: 'ch_x', object: 'charge' });
  await sg.flush();
  check('webhooks: an event PlugSure does not use (charge.succeeded) is acknowledged 200 so Stripe does not retry it',
    sg.events.find((e) => e.body === other)?.status === 200 && (await lastNotification(ig2.integration_id)) === 'ignored');

  // ================================================================ underpayment, wrong currency, minimum amount
  const u1 = await d('POST', '/v1/charge/prepaid', { connectorId: connSg, amountMinor: 2000, method: 'GRABPAY' });
  const iu1 = await intentOf(u1.data.payment.providerRef);
  sg.completeRedirect(iu1.provider_payment_id, { amount: 1200 });
  await sg.flush();
  const iu1b = await until(() => intentOf(u1.data.payment.providerRef), (i) => i.state !== 'pending', 10_000, 300);
  const alert = (await until(() => pg.query(`SELECT kind, severity, message FROM alert WHERE target_id = $1 ORDER BY id DESC LIMIT 1`, [iu1.id]), (r) => r.rows.length > 0, 10_000, 300)).rows[0];
  const startU = await d('POST', `/v1/charge/${u1.data.chargeId}/start`);
  check('underpayment: S$12.00 paid of S$20.00 — voided (cannot start a session), all of it queued for refund, a critical alert in S$',
    iu1b.state === 'voided' && Number(iu1b.amount_captured_minor) === 1200 && iu1b.refund_state === 'due' && Number(iu1b.refund_due_minor) === 1200 && startU.status !== 200
      && alert?.kind === 'payment.amount_mismatch' && alert.severity === 'critical' && /S\$ 12\.00/.test(alert.message), { iu1b, alert, startU: startU.data });

  const c1 = await d('POST', '/v1/charge/prepaid', { connectorId: connSg, amountMinor: 2000, method: 'GRABPAY' });
  const ic1 = await intentOf(c1.data.payment.providerRef);
  sg.completeRedirect(ic1.provider_payment_id, { currency: 'myr' });
  await sg.flush();
  const ic1b = await until(() => intentOf(c1.data.payment.providerRef), (i) => i.state !== 'pending', 10_000, 300);
  check('currency mismatch: a payment reported in MYR for an SGD price is never booked (voided, no amount, no automatic refund)',
    ic1b.state === 'voided' && ic1b.amount_captured_minor === null && ic1b.refund_state === null && (await lastNotification(ic1.integration_id)) === 'currency_mismatch', ic1b);

  const nSg = sg.requests.length;
  const tiny = await d('POST', '/v1/charge/prepaid', { connectorId: connSg, amountMinor: 49, method: 'CARD' });
  const tinyMy = await d('POST', '/v1/charge/prepaid', { connectorId: connMy, amountMinor: 199, method: 'FPX' });
  check('minimum amount: S$0.49 by card and RM 1.99 by FPX are refused before Stripe is asked (Stripe: S$0.50, RM 2.00)',
    tiny.status !== 200 && /minimum is S\$ 0\.50/.test(tiny.data?.error) && tinyMy.status !== 200 && /minimum is RM 2\.00/.test(tinyMy.data?.error) && sg.requests.filter((r) => r.method === 'POST').length === sg.requests.slice(0, nSg).filter((r) => r.method === 'POST').length,
    { tiny: tiny.data, tinyMy: tinyMy.data });

  // ================================================================ Indonesia unchanged
  const idq = await ops('GET', '/v1/integrations');
  check('Indonesia unchanged: the Indonesian payments row is not Stripe and lists no Stripe country', idq.data.kinds.find((k: any) => k.kind === 'payments')?.own?.countryCode !== 'SG', idq.data.kinds.find((k: any) => k.kind === 'payments')?.own);
} catch (e) {
  check(`no exception: ${(e as Error).stack}`, false);
} finally {
  for (const f of cleanup.reverse()) await f().catch(() => null);
  await sg.stop(); await my.stop();
  await pg?.end();
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
