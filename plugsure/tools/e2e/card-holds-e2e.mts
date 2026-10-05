// PlugSure v1.3 — card pre-authorisation (holds) and saved cards, end to end.
//
// On a real OCPP 1.6 charger driven frame by frame:
//   - Sandbox acquirer with holds and saved cards on: a card held for Rp 50,000 (and
//     saved) on the sandbox checkout page; the session charged; the rated total
//     captured and the rest released; no refund; the receipt shows held / charged /
//     released.
//   - The saved card pays in one tap (no checkout page); a session that delivers
//     nothing releases the whole hold; an unused hold is released by the worker and
//     its claim token stops working; a 30-day pass paid with the saved card.
//   - Another driver cannot use the card; a removed card cannot pay.
//   - Midtrans (a local fake): the Snap page asked for a hold and to save the card;
//     the authorize notification holds it and saves the token for that account
//     only; the capture fails once at Midtrans, is listed under Refunds → Card
//     holds, and succeeds when retried from the console; a Midtrans saved card goes
//     through 3-D Secure again; a saved token Midtrans no longer accepts (411) refused with a message naming
//     the card, which is then no longer offered, and offered again once saved again; an unused hold that
//     expired (Midtrans notification) released; a capture refused as expired (407) ending the hold with an
//     alert, the console's explanation and the driver's receipt; the driver paying it in the app (saved card
//     sent to 3-D Secure, then QRIS paid by Midtrans' notification), and a second payment for it refunded.
// Everything the test sets is removed at the end.
//
// Needs E2E_DATABASE_URL (the runtime role).
//     npx tsx tools/e2e/card-holds-e2e.mts
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
async function driver() {
  const dev = (await raw('/d/v1/device', '{}')).data.deviceToken as string;
  const d = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${API}/d${path}`, { method, headers: { authorization: `Bearer ${dev}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let j: any = t; try { j = JSON.parse(t); } catch {} return { status: r.status, data: j };
  };
  const phone = `0816${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const otp = await d('POST', '/v1/otp/send', { phone });
  await d('POST', '/v1/otp/verify', { phone, code: otp.data.devCode });
  return d;
}

// ------------------------------------------------------------ a fake Midtrans
const calls: Array<{ path: string; body: string; at: number }> = [];
const SERVER_KEY = 'SB-Mid-server-E2E-HOLDS-5c1d';
const behaviour = { captureFailures: 0, tokenEnded: false, captureExpired: false };
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0]!;
    calls.push({ path, body, at: Date.now() });
    const send = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    const j = body ? JSON.parse(body) : {};
    if (path === '/snap/v1/transactions') return send(201, { token: 't', redirect_url: `https://snap.midtrans.test/r/${j.transaction_details.order_id}` });
    if (path === '/v2/capture') {
      // The authorisation lapsed before the capture: Midtrans answers 407 "Expired transaction".
      if (behaviour.captureExpired) return send(200, { status_code: '407', status_message: 'Expired transaction' });
      if (behaviour.captureFailures > 0) { behaviour.captureFailures--; return send(200, { status_code: '500', status_message: 'Sorry, we encountered internal server error' }); }
      return send(200, { status_code: '200', transaction_status: 'capture', transaction_id: j.transaction_id, gross_amount: `${j.gross_amount}.00` });
    }
    if (/^\/v2\/.+\/cancel$/.test(path)) return send(200, { status_code: '200', transaction_status: 'cancel' });
    // The saved token no longer works (the card deleted at the bank, or the token expired): Midtrans answers 411.
    if (path === '/v2/charge' && j.payment_type === 'credit_card' && behaviour.tokenEnded) return send(200, { status_code: '411', status_message: 'Token id is missing, invalid, or timed out' });
    if (path === '/v2/charge' && j.payment_type === 'credit_card') return send(200, { status_code: '201', transaction_id: `tx-${j.transaction_details.order_id}`, redirect_url: `https://3ds.midtrans.test/${j.transaction_details.order_id}` });
    if (path === '/v2/charge') return send(201, { status_code: '201', qr_string: `00020101MIDTRANS${j.transaction_details.order_id}` });
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

  // ================================================================ setup: a raw OCPP 1.6 charger
  await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  await ops('DELETE', '/v1/integrations/payments?scope=org');
  cleanup.push(() => ops('DELETE', '/v1/integrations/payments?scope=org'));
  const site = await ops('POST', '/v1/sites', { name: 'Card Holds E2E Hub', address: 'Jl. Thamrin', kabupatenKotaCode: '3171', gridTariffGroup: 'L/TR', connectedKva: '197', powerFactor: '0.95', phases: '3', localTaxRateBps: '1000' });
  const tariff = await ops('POST', '/v1/tariffs', { name: 'Holds E2E DC', plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, pricingModel: 'flat', appliesToMaxPowerW: 60000, ppnApplies: true, components: [{ kind: 'energy', rate: 2400, touBlock: 'ANY' }] });
  await ops('PUT', `/v1/sites/${site.data.id}/tariff`, { tariffId: tariff.data.tariffId, currentType: 'DC' });
  const ID = `HOLD-${Date.now().toString().slice(-6)}`;
  await ops('POST', '/v1/charge-points', { ocppIdentity: ID, siteId: site.data.id, displayName: 'Holds E2E', ocppVersion: 'ocpp1.6', evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] }] });
  await ops('POST', `/v1/charge-points/${ID}/activate`);
  const ws = new WebSocket(`${OCPP}/${ID}`, ['ocpp1.6']);
  await new Promise<void>((r) => ws.once('open', () => r()));
  ws.on('message', (m) => { const f = JSON.parse(m.toString()); if (f[0] === 2) ws.send(JSON.stringify([3, f[1], { status: 'Accepted' }])); });
  let n = 0; const call = (a: string, p: unknown) => new Promise<any>((res) => { const id = `h${++n}`; const on = (m: any) => { const f = JSON.parse(m.toString()); if (f[1] === id) { ws.off('message', on); res(f[2]); } }; ws.on('message', on); ws.send(JSON.stringify([2, id, a, p])); });
  await call('BootNotification', { chargePointVendor: 'E2E', chargePointModel: 'HOLD' });
  await call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: new Date().toISOString() });
  cleanup.push(async () => ws.close());
  let meter = 100_000;
  /** Plug in, draw `wh`, unplug: returns the transaction's StartTransaction answer. */
  const runSession = async (idTag: string, wh: number) => {
    const st = await call('StartTransaction', { connectorId: 1, idTag, meterStart: meter, timestamp: new Date().toISOString() });
    await call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Charging', timestamp: new Date().toISOString() });
    meter += wh;
    await call('StopTransaction', { transactionId: st.transactionId, idTag, meterStop: meter, timestamp: new Date(Date.now() + 60_000).toISOString(), reason: 'EVDisconnected' });
    await call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: new Date().toISOString() });
    return st;
  };

  const d = await driver();
  const stations = await until(() => d('GET', '/v1/stations'), (r) => !!r.data.stations?.find((s: any) => s.siteId === site.data.id)?.connectors?.[0], 20_000, 800);
  const conn = stations.data.stations.find((s: any) => s.siteId === site.data.id).connectors[0].connectorId;
  const intentOf = async (ref: string) => (await pg.query(
    `SELECT id, state, mode, hold_state, amount_authorised_minor, amount_captured_minor, hold_capture_minor, hold_error, refund_state, save_card, driver_card_id, session_id FROM payment_intent WHERE provider_ref = $1`, [ref])).rows[0];
  const refOf = (r: any) => r.data?.payment?.providerRef as string;
  const cdrTotal = async (sessionId: string) => Number((await pg.query(`SELECT total_minor FROM cdr WHERE session_id = $1`, [sessionId])).rows[0]?.total_minor ?? -1);

  // ================================================================ sandbox: holds and saved cards on
  const off = await d('POST', '/v1/charge/quote', { connectorId: conn, amountMinor: 50_000 });
  const sb = await ops('PUT', '/v1/integrations/payments', { provider: 'mock', settings: { methods: ['QRIS', 'GOPAY', 'CARD'], cardHolds: true, saveCards: true } });
  cc('/v1/integrations/{kind}', 'put', '200', sb.data);
  const q = await until(() => d('POST', '/v1/charge/quote', { connectorId: conn, amountMinor: 50_000 }), (r) => r.data.cardHolds === true, 20_000, 1000);
  check('holds and saved cards are off by default; switched on for the operator, the quote offers both (no saved card yet)',
    off.data.cardHolds === false && off.data.canSaveCard === false && sb.status === 200 && q.data.cardHolds === true && q.data.canSaveCard === true && q.data.savedCards.length === 0, { off: off.data, q: q.data });

  const h1 = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 50_000, method: 'CARD', saveCard: true });
  const i1 = await intentOf(refOf(h1));
  const page = await fetch(API + h1.data.payment.checkoutUrl).then((r) => r.text());
  check('card payment is a hold: mode preauth, save requested; the checkout page says hold only and that the card will be saved',
    h1.status === 200 && h1.data.payment.hold === true && h1.data.payment.saveCard === true && i1.mode === 'preauth' && i1.state === 'pending' && i1.save_card === true
      && page.includes('Hold only') && page.includes('saved for next time'), { h1: h1.data.payment, i1 });
  const before = await d('POST', `/v1/charge/${h1.data.chargeId}/start`);
  const paid = await raw(`/pay/sandbox/${refOf(h1)}/pay`, '', { accept: 'application/json' });
  const i1b = await intentOf(refOf(h1));
  const cards = await d('GET', '/v1/cards');
  check('approved: authorised and held (nothing taken); the card saved for this driver as VISA ••1111, usable at this operator',
    before.status === 400 && paid.data.outcome === 'authorised' && i1b.state === 'authorised' && i1b.hold_state === 'held' && i1b.amount_captured_minor === null
      && cards.data.cards.length === 1 && cards.data.cards[0].brand === 'VISA' && cards.data.cards[0].last4 === '1111' && !JSON.stringify(cards.data).includes('mock_tok_') && i1b.driver_card_id === cards.data.cards[0].id,
    { before: before.data, paid: paid.data, i1b, cards: cards.data });
  const st1 = await d('GET', `/v1/charge/${h1.data.chargeId}/status`);
  const go1 = await d('POST', `/v1/charge/${h1.data.chargeId}/start`);
  await runSession(h1.data.startToken, 5_000);
  const i1c = await until(() => intentOf(refOf(h1)), (i) => i.hold_state === 'captured', 20_000, 500);
  const total1 = await cdrTotal(i1c.session_id);
  const rc1 = await until(() => d('GET', `/v1/charge/${h1.data.chargeId}/receipt`), (r) => r.data?.settlement?.hold?.state === 'captured', 10_000, 500);
  check('the held card starts the charge; after the session the rated total is captured and the rest released, with no refund',
    st1.data.state === 'awaiting_start' && go1.status === 200 && total1 > 0 && total1 < 50_000 && i1c.state === 'captured' && i1c.amount_captured_minor === total1 && i1c.refund_state === null, { st1: st1.data, go1: go1.data, i1c, total1 });
  const hs = rc1.data.settlement?.hold;
  check('receipt: held Rp 50,000, charged the total, released the rest',
    hs?.heldMinor === 50_000 && hs.chargedMinor === total1 && hs.releasedMinor === 50_000 - total1 && rc1.data.settlement.refundMinor === 0, rc1.data.settlement);

  // The saved card: one tap, no checkout page.
  const q2 = await d('POST', '/v1/charge/quote', { connectorId: conn, amountMinor: 30_000 });
  const cardId = q2.data.savedCards?.[0]?.id;
  const h2 = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 30_000, savedCardId: cardId });
  const i2 = await intentOf(refOf(h2));
  check('the saved card is offered and pays in one tap: held at once, no checkout page',
    q2.data.savedCards.length === 1 && h2.status === 200 && h2.data.payment.action === 'done' && h2.data.payment.checkoutUrl === null && i2.state === 'authorised' && i2.hold_state === 'held' && i2.driver_card_id === cardId, { q2: q2.data.savedCards, h2: h2.data.payment, i2 });
  await d('POST', `/v1/charge/${h2.data.chargeId}/start`);
  await runSession(h2.data.startToken, 0);
  const i2b = await until(() => intentOf(refOf(h2)), (i) => i.hold_state === 'released', 20_000, 500);
  check('a session that delivers nothing releases the whole hold (state voided, nothing captured, no refund)',
    i2b.hold_state === 'released' && i2b.state === 'voided' && i2b.amount_captured_minor === null && i2b.refund_state === null, i2b);

  // An unused hold is released by the worker, and its token stops working.
  const h3 = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 20_000, savedCardId: cardId });
  await pg.query(`UPDATE payment_intent SET created_at = now() - interval '40 minutes' WHERE provider_ref = $1`, [refOf(h3)]);
  const i3 = await until(() => intentOf(refOf(h3)), (i) => i.hold_state === 'released', 100_000, 2000);
  const st3 = await d('GET', `/v1/charge/${h3.data.chargeId}/status`);
  const auth3 = await call('Authorize', { idTag: h3.data.startToken });
  check('an unused hold is released by the worker; the app says so and the claim token is refused at the charger',
    i3.hold_state === 'released' && i3.state === 'voided' && st3.data.state === 'released' && auth3.idTagInfo?.status !== 'Accepted', { i3, st3: st3.data.state, auth3 });

  // A 30-day pass with the saved card.
  const plan = await ops('POST', '/v1/subscription-plans', { name: `Holds E2E Pass ${Date.now().toString().slice(-5)}`, monthlyFeeMinor: 20000, offeredInApp: true });
  cleanup.push(() => ops('PUT', `/v1/subscription-plans/${plan.data.id}`, { active: false, offeredInApp: false }));
  const mem = await d('GET', '/v1/memberships');
  const mp = mem.data.plans.find((p: any) => p.id === plan.data.id);
  const pass = await d('POST', '/v1/memberships', { planId: plan.data.id, savedCardId: cardId });
  const passSt = await d('GET', `/v1/memberships/charges/${pass.data.chargeId}`);
  check('a 30-day pass with the saved card: a sale (never a hold), paid at once and active',
    mp?.savedCards?.length === 1 && pass.status === 200 && pass.data.payment.action === 'done' && pass.data.payment.hold === false && passSt.data.state === 'paid' && passSt.data.membership === 'active', { mp: mp?.savedCards, pass: pass.data.payment, passSt: passSt.data });

  // Automatic renewal with the saved card, run by the renewal worker (here in-process, against the same database).
  const subId = pass.data.subscriptionId as string;
  const intruder = await driver();
  const arBad = await d('PUT', `/v1/memberships/${subId}/auto-renew`, { enabled: true, methodId: '00000000-0000-4000-8000-000000000000' });
  const arOther = await intruder('PUT', `/v1/memberships/${subId}/auto-renew`, { enabled: true, methodId: cardId });
  const arOn = await d('PUT', `/v1/memberships/${subId}/auto-renew`, { enabled: true, methodId: cardId });
  const mem2 = (await d('GET', '/v1/memberships')).data.memberships.find((m: any) => m.id === subId);
  check('automatic renewal: on with the saved card (shown as the card); an unknown method (422) and another driver (404) are refused',
    arOn.status === 200 && arBad.status === 422 && arOther.status === 404 && mem2?.autoRenew === true && /1111/.test(mem2.renewMethod?.label ?? ''), { arOn: arOn.data, arBad: arBad.data, arOther: arOther.status, mem2 });
  await pg.query(`UPDATE subscription SET current_period_end = now() + interval '12 hours' WHERE id = $1`, [subId]);
  const endBefore = (await pg.query(`SELECT current_period_end FROM subscription WHERE id = $1`, [subId])).rows[0].current_period_end as Date;
  process.env.DATABASE_URL ??= process.env.E2E_DATABASE_URL;
  const { renewPasses } = await import('../../src/driver/membership.js');
  const ren = await renewPasses();
  const subAfter = (await pg.query(`SELECT current_period_end, auto_renew, renew_error, renew_attempts FROM subscription WHERE id = $1`, [subId])).rows[0];
  const renCharge = (await pg.query(`SELECT state, via, auto_renewal, driver_card_id, total_minor, period_start FROM subscription_charge WHERE subscription_id = $1 AND auto_renewal ORDER BY created_at DESC LIMIT 1`, [subId])).rows[0];
  check('a day before the end, the worker charges the saved card: paid at once, the pass runs 30 more days from the old end',
    ren.renewed >= 1 && renCharge?.state === 'paid' && renCharge.via === 'card' && renCharge.driver_card_id === cardId && new Date(renCharge.period_start).getTime() === new Date(endBefore).getTime()
      && Math.round((new Date(subAfter.current_period_end).getTime() - new Date(endBefore).getTime()) / 86_400_000) === 30 && subAfter.renew_error === null,
    { ren, renCharge, subAfter });
  const again2 = await renewPasses();
  const renCount = (await pg.query(`SELECT count(*)::int AS n FROM subscription_charge WHERE subscription_id = $1 AND auto_renewal`, [subId])).rows[0].n;
  check('run again: nothing more is charged (already renewed)', renCount === 1, { again2, renCount });

  // Switching plans: the unused value of the current pass is credited.
  const dear = await ops('POST', '/v1/subscription-plans', { name: `Holds E2E Plus ${Date.now().toString().slice(-5)}`, monthlyFeeMinor: 60000, offeredInApp: true });
  const cheap = await ops('POST', '/v1/subscription-plans', { name: `Holds E2E Lite ${Date.now().toString().slice(-5)}`, monthlyFeeMinor: 5000, offeredInApp: true });
  cleanup.push(() => ops('PUT', `/v1/subscription-plans/${dear.data.id}`, { active: false, offeredInApp: false }));
  cleanup.push(() => ops('PUT', `/v1/subscription-plans/${cheap.data.id}`, { active: false, offeredInApp: false }));
  const ov = (await d('GET', '/v1/memberships')).data;
  const swUp = ov.plans.find((p: any) => p.id === dear.data.id)?.switch;
  const swDown = ov.plans.find((p: any) => p.id === cheap.data.id)?.switch;
  // The driver holds two paid 30-day windows of Rp 20,000 (the first nearly unused, the renewal untouched).
  check('switching: the app quotes the credit for the unused days — a dearer plan costs the difference, a cheaper one is free and runs longer',
    swUp && swUp.creditMinor > 20_000 && swUp.creditMinor <= 40_000 && swUp.payFeeMinor === 60_000 - swUp.creditMinor && swUp.days === 30
      && swDown && swDown.payTotalMinor === 0 && swDown.days > 30, { swUp, swDown });
  const up = await d('POST', '/v1/memberships', { planId: dear.data.id, savedCardId: cardId });
  const upSub = (await pg.query(`SELECT plan_id, current_period_start, current_period_end, status FROM subscription WHERE id = $1`, [subId])).rows[0];
  const upCharge = (await pg.query(`SELECT fee_minor, credit_minor, total_minor, switch_to_plan_id, state FROM subscription_charge WHERE subscription_id = $1 AND switch_to_plan_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [subId])).rows[0];
  check('switching up: the same membership moves to the new plan when paid, from now for 30 days; the charge is the fee less the credit (plus PPN)',
    up.status === 200 && up.data.paid === true && up.data.creditMinor === swUp.creditMinor && upSub.plan_id === dear.data.id && upSub.status === 'active'
      && Math.round((new Date(upSub.current_period_end).getTime() - new Date(upSub.current_period_start).getTime()) / 86_400_000) === 30
      && upCharge?.fee_minor === 60_000 && upCharge.credit_minor === swUp.creditMinor && upCharge.state === 'paid' && upCharge.switch_to_plan_id === dear.data.id,
    { up: up.data, upSub, upCharge });
  const down = await d('POST', '/v1/memberships', { planId: cheap.data.id });
  const downSub = (await pg.query(`SELECT plan_id, current_period_start, current_period_end FROM subscription WHERE id = $1`, [subId])).rows[0];
  const downCharge = (await pg.query(`SELECT via, total_minor, credit_minor, state FROM subscription_charge WHERE subscription_id = $1 AND switch_to_plan_id = $2`, [subId, cheap.data.id])).rows[0];
  // Only the Rp 60,000 pass is left to credit: the charges the first switch replaced ended at that switch (never credited twice).
  const downDays = (new Date(downSub.current_period_end).getTime() - new Date(downSub.current_period_start).getTime()) / 86_400_000;
  check('switching down: nothing to pay (no payment method needed) — only the current pass is credited, and it makes the cheaper pass run longer (about 360 days)',
    down.status === 200 && down.data.paid === true && down.data.totalMinor === 0 && downSub.plan_id === cheap.data.id && downCharge?.via === 'credit' && downCharge.total_minor === 0 && downCharge.state === 'paid'
      && downCharge.credit_minor > 59_000 && downCharge.credit_minor <= 60_000 && downDays > 358 && downDays < 361, { down: down.data, downSub, downCharge, downDays });

  // Loyalty points: earned on what a session costs, spent automatically on the next one (before tax), expiring.
  const prevLoyalty = (await ops('GET', '/v1/loyalty')).data.program;
  cleanup.push(() => ops('PUT', '/v1/loyalty', prevLoyalty));
  const badProgram = await ops('PUT', '/v1/loyalty', { enabled: true, pointValueMinor: 0 });
  const lp = await ops('PUT', '/v1/loyalty', { enabled: true, earnPer1000Minor: 10, pointValueMinor: 1, maxRedeemBps: 5000, expiryMonths: 12 });
  cc('/v1/loyalty', 'put', '200', lp.data);
  check('loyalty: switched on (10 points per Rp 1,000, a point worth Rp 1, at most half a session); an invalid value is refused',
    lp.status === 200 && lp.data.program.enabled === true && badProgram.status === 422, { lp: lp.data, bad: badProgram.data });
  const hA = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 30_000, savedCardId: cardId });
  await d('POST', `/v1/charge/${hA.data.chargeId}/start`);
  await runSession(hA.data.startToken, 5_000);
  const iA = await until(() => intentOf(refOf(hA)), (i) => i.hold_state === 'captured', 20_000, 500);
  const totalA = await cdrTotal(iA.session_id);
  const earnedA = Math.floor((totalA * 10) / 1000);
  const rcA = await until(() => d('GET', `/v1/charge/${hA.data.chargeId}/receipt`), (r) => !!r.data?.loyalty, 10_000, 500);
  const myPts = await d('GET', '/v1/loyalty');
  const op = myPts.data.operators?.find((o: any) => o.enabled);
  check(`loyalty: a session (Rp ${totalA}) earns ${earnedA} points, shown on the receipt and in the app`,
    earnedA > 0 && rcA.data.loyalty?.earnedPoints === earnedA && rcA.data.loyalty.usedPoints === 0 && op?.balance === earnedA && op.autoRedeem === false, { loyalty: rcA.data.loyalty, op });
  const useOn = await d('PUT', `/v1/loyalty/${op.orgId}`, { autoRedeem: true });
  const hB = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 30_000, savedCardId: cardId });
  await d('POST', `/v1/charge/${hB.data.chargeId}/start`);
  await runSession(hB.data.startToken, 5_000);
  const iB = await until(() => intentOf(refOf(hB)), (i) => i.hold_state === 'captured', 20_000, 500);
  const cdrB = (await pg.query(`SELECT lines, total_minor, subtotal_minor FROM cdr WHERE session_id = $1`, [iB.session_id])).rows[0];
  const ptsLine = (cdrB.lines as any[]).filter((l) => l.adjustment?.source === 'loyalty');
  const usedMinor = -ptsLine.reduce((a, l) => a + l.amountMinor, 0);
  const rcB = await until(() => d('GET', `/v1/charge/${hB.data.chargeId}/receipt`), (r) => !!r.data?.loyalty, 10_000, 500);
  const earnedB = Math.floor((Number(cdrB.total_minor) * 10) / 1000);
  const afterB = (await d('GET', '/v1/loyalty')).data.operators.find((o: any) => o.orgId === op.orgId);
  check('loyalty: with "use my points" on, the next session spends them — a discount line before tax, taken on the captured amount — and earns on what it cost',
    useOn.status === 200 && ptsLine.length >= 1 && usedMinor === earnedA && Number(cdrB.total_minor) < totalA && iB.amount_captured_minor === Number(cdrB.total_minor)
      && rcB.data.loyalty?.usedPoints === earnedA && rcB.data.loyalty.earnedPoints === earnedB && afterB.balance === earnedB
      && afterB.history.some((h: any) => h.kind === 'redeem' && h.points === -earnedA), { usedMinor, earnedA, totalA, totalB: cdrB.total_minor, rcB: rcB.data.loyalty, afterB });
  const stats = await ops('GET', '/v1/loyalty');
  cc('/v1/loyalty', 'get', '200', stats.data);
  const topM = await ops('GET', '/v1/loyalty/members');
  const meRow = topM.data.members.find((x: any) => x.balance === earnedB);
  const adj = await ops('POST', '/v1/loyalty/adjust', { appDriverId: meRow?.appDriverId, points: 100, note: 'Sorry for the wait at the charger' });
  const tooMuch = await ops('POST', '/v1/loyalty/adjust', { appDriverId: meRow?.appDriverId, points: -1_000_000, note: 'Too much' });
  check('loyalty (console): points outstanding and their value; the driver listed (phone masked); goodwill points added; never below zero',
    stats.data.outstandingPoints >= earnedB && stats.data.liabilityMinor === stats.data.outstandingPoints && stats.data.thisMonth.redeemed >= earnedA
      && !!meRow && /••••/.test(meRow.phone) && adj.status === 200 && adj.data.balance === earnedB + 100 && tooMuch.status === 409, { stats: stats.data, meRow, adj: adj.data, tooMuch: tooMuch.data });
  await pg.query(`UPDATE loyalty_entry SET expires_at = now() - interval '1 minute' WHERE app_driver_id = $1 AND remaining > 0`, [meRow.appDriverId]);
  const { expirePoints } = await import('../../src/services/loyalty.js');
  const expired = await expirePoints();
  const afterExp = (await d('GET', '/v1/loyalty')).data.operators.find((o: any) => o.orgId === op.orgId);
  check('loyalty: points past their date expire (recorded in the history), and the balance is 0',
    expired >= earnedB + 100 && afterExp.balance === 0 && afterExp.history.some((h: any) => h.kind === 'expire' && h.points === -(earnedB + 100)), { expired, afterExp });

  // Someone else's card; a removed card.
  const other = await driver();
  const steal = await other('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 20_000, savedCardId: cardId });
  const guestDev = (await raw('/d/v1/device', '{}')).data.deviceToken as string;
  const gq = await fetch(`${API}/d/v1/charge/quote`, { method: 'POST', headers: { authorization: `Bearer ${guestDev}`, 'content-type': 'application/json' }, body: JSON.stringify({ connectorId: conn, amountMinor: 20_000 }) }).then((r) => r.json() as any);
  const rm = await d('DELETE', `/v1/cards/${cardId}`);
  const after = await d('GET', '/v1/cards');
  const useRemoved = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 20_000, savedCardId: cardId });
  check('another driver cannot use the card; a guest cannot save one (but still gets holds); a removed card is gone and cannot pay',
    steal.status === 422 && gq.canSaveCard === false && gq.cardHolds === true && rm.status === 200 && after.data.cards.length === 0 && useRemoved.status === 422, { steal: steal.data, gq, rm: rm.data, useRemoved: useRemoved.data });
  // The card chosen for renewal is gone: renewal stops, and says why.
  await pg.query(`UPDATE subscription SET current_period_end = now() + interval '6 hours', renew_next_at = NULL WHERE id = $1`, [subId]);
  await renewPasses();
  const stopped = (await pg.query(`SELECT auto_renew, renew_error FROM subscription WHERE id = $1`, [subId])).rows[0];
  const memStopped = (await d('GET', '/v1/memberships')).data.memberships.find((m: any) => m.id === subId);
  check('the renewal card was removed: automatic renewal stops (with the reason) and nothing is charged',
    stopped.auto_renew === false && /removed/.test(stopped.renew_error ?? '') && memStopped?.autoRenew === false, { stopped, memStopped });
  const { pool: appPool } = await import('../../src/db/pool.js');
  cleanup.push(() => appPool.end().catch(() => {}));

  // ================================================================ Midtrans: holds, a failed capture, saved cards per account
  const mt = await ops('PUT', '/v1/integrations/payments', { provider: 'midtrans', settings: { environment: 'sandbox', baseUrl: FAKE, methods: ['QRIS', 'CARD'], cardHolds: true, saveCards: true }, secrets: { serverKey: SERVER_KEY } });
  const hook = mt.data.webhookPath as string;
  await until(() => d('POST', '/v1/charge/quote', { connectorId: conn, amountMinor: 60_000 }), (r) => JSON.stringify(r.data.paymentMethods?.map((m: any) => m.channel)) === '["QRIS","CARD"]', 20_000, 1000);
  const t1 = Date.now();
  const m1 = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 60_000, method: 'CARD', saveCard: true });
  const snap = JSON.parse(callsTo(/^\/snap\/v1\/transactions$/, t1)[0]?.body ?? '{}');
  check('Midtrans: Snap is asked for a hold (credit_card.type authorize) and to save the card for this driver (save_card, user_id)',
    m1.status === 200 && snap.credit_card?.type === 'authorize' && snap.credit_card?.save_card === true && typeof snap.user_id === 'string' && snap.user_id.length > 10, snap);
  const oid = refOf(m1);
  const sig = (o: string, s: string, g: string) => createHash('sha512').update(`${o}${s}${g}${SERVER_KEY}`).digest('hex');
  const auth = await raw(hook, JSON.stringify({ order_id: oid, status_code: '200', gross_amount: '60000.00', transaction_status: 'authorize', fraud_status: 'accept', transaction_id: `tx-${oid}`, payment_type: 'credit_card',
    masked_card: '521111-1117', saved_token_id: `521111TOK${oid}`, saved_token_id_expired_at: '2030-12-31 07:00:00', signature_key: sig(oid, '200', '60000.00') }));
  const im = await intentOf(oid);
  const quoteMt = await d('POST', '/v1/charge/quote', { connectorId: conn, amountMinor: 60_000 });
  check('the signed authorize notification holds the payment and saves the Midtrans card; only Midtrans cards are offered here',
    auth.status === 200 && im.state === 'authorised' && im.hold_state === 'held' && quoteMt.data.savedCards.length === 1 && quoteMt.data.savedCards[0].brand === 'MASTERCARD' && quoteMt.data.savedCards[0].last4 === '1117', { im, saved: quoteMt.data.savedCards });
  behaviour.captureFailures = 1;
  await d('POST', `/v1/charge/${m1.data.chargeId}/start`);
  const t2 = Date.now();
  await runSession(m1.data.startToken, 8_000);
  const failed = await until(() => intentOf(oid), (i) => i.hold_state === 'capture_failed', 20_000, 500);
  const total2 = await cdrTotal(failed.session_id);
  const holds = await ops('GET', '/v1/card-holds');
  cc('/v1/card-holds', 'get', '200', holds.data);
  const listed = holds.data.holds?.find((h: any) => h.id === failed.id);
  check('Midtrans refuses the first capture: the hold is marked capture failed with its error and listed first under Card holds',
    failed.hold_capture_minor === total2 && /500/.test(failed.hold_error ?? '') && listed?.state === 'capture_failed' && holds.data.holds[0].id === failed.id && holds.data.summary.failed >= 1, { failed, listed, summary: holds.data.summary });
  const retry = await ops('POST', `/v1/card-holds/${failed.id}/retry`);
  cc('/v1/card-holds/{id}/retry', 'post', '200', retry.data);
  const cap = callsTo(/^\/v2\/capture$/, t2);
  const done = await intentOf(oid);
  const again = await ops('POST', `/v1/card-holds/${failed.id}/retry`);
  check('retried from the console: captured at Midtrans for the rated total with the transaction id; a second retry has nothing to do (404)',
    retry.status === 200 && retry.data.state === 'captured' && cap.length === 2 && JSON.parse(cap[1]!.body).gross_amount === total2 && JSON.parse(cap[1]!.body).transaction_id === `tx-${oid}`
      && done.state === 'captured' && done.amount_captured_minor === total2 && again.status === 404, { retry: retry.data, cap: cap.map((c) => c.body), done });
  const confirm = await raw(hook, JSON.stringify({ order_id: oid, status_code: '200', gross_amount: `${total2}.00`, transaction_status: 'capture', fraud_status: 'accept', transaction_id: `tx-${oid}`, signature_key: sig(oid, '200', `${total2}.00`) }));
  check('Midtrans\' capture notification is recorded without changing the settled amount', confirm.status === 200 && (await intentOf(oid)).amount_captured_minor === total2);
  const t3 = Date.now();
  const m2 = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 40_000, savedCardId: quoteMt.data.savedCards[0].id });
  const oneClick = JSON.parse(callsTo(/^\/v2\/charge$/, t3)[0]?.body ?? '{}');
  check('a Midtrans saved card: charged on its token as a hold, with 3-D Secure again (the driver is sent to the bank page)',
    m2.status === 200 && m2.data.payment.action === 'redirect' && /3ds\.midtrans\.test/.test(m2.data.payment.checkoutUrl) && oneClick.credit_card?.token_id === `521111TOK${oid}` && oneClick.credit_card?.type === 'authorize' && oneClick.credit_card?.authentication === true, { m2: m2.data.payment, oneClick });

  // The saved token no longer works at Midtrans (411): the driver is told, and the card is no longer offered.
  const savedId = quoteMt.data.savedCards[0].id;
  behaviour.tokenEnded = true;
  const t4 = Date.now();
  const ended = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 40_000, savedCardId: savedId });
  const qEnded = await d('POST', '/v1/charge/quote', { connectorId: conn, amountMinor: 40_000 });
  const endedAgain = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 40_000, savedCardId: savedId });
  const cardsEnded = await d('GET', '/v1/cards');
  check('a saved card whose token Midtrans no longer accepts (411): "Mastercard •••• 1117 … tidak bisa dipakai", nothing charged, code saved_card_ended; the card is no longer offered or listed, and a second try is answered without asking Midtrans',
    ended.status === 422 && ended.data.code === 'saved_card_ended' && ended.data.error.startsWith('Mastercard •••• 1117 yang tersimpan sudah tidak bisa dipakai') && /Tidak ada yang ditagih/.test(ended.data.error)
      && !(qEnded.data.savedCards ?? []).some((k: any) => k.id === savedId) && !(cardsEnded.data.cards ?? []).some((k: any) => k.id === savedId)
      && endedAgain.status === 422 && endedAgain.data.code === 'saved_card_ended' && callsTo(/^\/v2\/charge$/, t4).length === 1,
    { ended: ended.data, endedAgain: endedAgain.data, saved: qEnded.data.savedCards, calls: callsTo(/^\/v2\/charge$/, t4).length });
  behaviour.tokenEnded = false;
  // Saved again on the next card payment, and Midtrans gives the same token back: the card is offered again.
  const m3 = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 30_000, method: 'CARD', saveCard: true });
  const oid3 = refOf(m3);
  const authAgain = await raw(hook, JSON.stringify({ order_id: oid3, status_code: '200', gross_amount: '30000.00', transaction_status: 'authorize', fraud_status: 'accept', transaction_id: `tx-${oid3}`, payment_type: 'credit_card',
    masked_card: '521111-1117', saved_token_id: `521111TOK${oid}`, saved_token_id_expired_at: '2030-12-31 07:00:00', signature_key: sig(oid3, '200', '30000.00') }));
  const qBack = await d('POST', '/v1/charge/quote', { connectorId: conn, amountMinor: 40_000 });
  check('saved again with the same token: the card is offered again',
    authAgain.status === 200 && (qBack.data.savedCards ?? []).some((k: any) => k.id === savedId), { authAgain: authAgain.status, saved: qBack.data.savedCards });

  // Midtrans notifies that an unused hold's authorisation expired: it is released, and its claim token can no longer start a session.
  const exp3 = await raw(hook, JSON.stringify({ order_id: oid3, status_code: '407', gross_amount: '30000.00', transaction_status: 'expire', transaction_id: `tx-${oid3}`, payment_type: 'credit_card', signature_key: sig(oid3, '407', '30000.00') }));
  const iExp3 = await intentOf(oid3);
  const tok3 = (await pg.query(`SELECT t.status FROM token t JOIN payment_intent pi ON pi.claim_id_tag = t.uid AND t.kind = 'prepaid' WHERE pi.id = $1`, [iExp3.id])).rows[0]?.status;
  check('Midtrans notifies that an unused hold expired: it is released (nothing held, nothing to collect) and its claim token cannot start a session',
    exp3.status === 200 && iExp3.hold_state === 'released' && iExp3.state === 'voided' && iExp3.hold_error === null && tok3 === 'Expired', { exp3: exp3.data, iExp3, tok3 });

  // A hold whose authorisation expired before the capture (Midtrans 407): no retries, a critical alert, and clear words for the operator and the driver.
  const m4 = await d('POST', '/v1/charge/prepaid', { connectorId: conn, amountMinor: 50_000, method: 'CARD' });
  const oid4 = refOf(m4);
  await raw(hook, JSON.stringify({ order_id: oid4, status_code: '200', gross_amount: '50000.00', transaction_status: 'authorize', fraud_status: 'accept', transaction_id: `tx-${oid4}`, payment_type: 'credit_card', signature_key: sig(oid4, '200', '50000.00') }));
  await d('POST', `/v1/charge/${m4.data.chargeId}/start`);
  behaviour.captureExpired = true;
  const t5 = Date.now();
  await runSession(m4.data.startToken, 4_000);
  const ex = await until(() => intentOf(oid4), (i) => i.hold_state === 'capture_failed', 20_000, 500);
  const total4 = await cdrTotal(ex.session_id);
  const nextTry = (await pg.query(`SELECT hold_next_attempt_at FROM payment_intent WHERE id = $1`, [ex.id])).rows[0]?.hold_next_attempt_at;
  const holdsEx = await ops('GET', '/v1/card-holds');
  cc('/v1/card-holds', 'get', '200', holdsEx.data);
  const listedEx = holdsEx.data.holds?.find((h: any) => h.id === ex.id);
  const retryEx = await ops('POST', `/v1/card-holds/${ex.id}/retry`);
  const captures = callsTo(/^\/v2\/capture$/, t5).length;
  const rcEx = await d('GET', `/v1/charge/${m4.data.chargeId}/receipt`);
  const alerts = await ops('GET', '/v1/alerts');
  const alertEx = (alerts.data ?? []).find((a: any) => a.kind === 'payment.hold_expired' && new Date(a.last_raised_at ?? a.raised_at).getTime() >= t5 - 1000);
  check('a hold whose authorisation expired before the capture (Midtrans 407): no retries; listed as expired with the amount to collect, and the console retry explains instead of asking Midtrans again',
    ex.hold_error?.startsWith('hold expired:') && ex.hold_capture_minor === total4 && nextTry === null && listedEx?.expired === true && holdsEx.data.summary.expired >= 1 && holdsEx.data.summary.expiredMinor >= total4
      && retryEx.status === 409 && /expired at the acquirer before it was captured/.test(retryEx.data.error ?? retryEx.data.message ?? '') && captures === 1,
    { ex, nextTry, listedEx, summary: holdsEx.data.summary, retry: retryEx.data, captures });
  check('the operator gets one critical alert with the amount; the driver\'s receipt says nothing was taken, the hold is back on the card, and the operator may ask them to pay',
    alertEx?.severity === 'critical' && alertEx.message.includes(`Rp ${total4.toLocaleString('id-ID')}`) && /can no longer be taken from the card/.test(alertEx.message)
      && rcEx.data.settlement?.hold?.expired === true && rcEx.data.settlement.hold.chargedMinor === 0 && rcEx.data.settlement.hold.unpaidMinor === total4 && rcEx.data.settlement.paidMinor === 0,
    { alertEx, hold: rcEx.data.settlement?.hold });
  behaviour.captureExpired = false;

  // The driver pays the expired hold from the receipt, in the app.
  const rcPay = await d('GET', `/v1/charge/${m4.data.chargeId}/receipt`);
  const po = rcPay.data.settlement?.hold?.payOptions ?? {};
  const tP = Date.now();
  const viaCard = await d('POST', `/v1/charge/${m4.data.chargeId}/pay-expired`, { method: 'CARD', savedCardId: savedId });
  const viaQr = await d('POST', `/v1/charge/${m4.data.chargeId}/pay-expired`, { method: 'QRIS' });
  const stP = await d('GET', `/v1/charge/${m4.data.chargeId}/pay-expired`);
  const settleRows = (await pg.query(`SELECT id, provider_ref, channel, mode, state, amount_authorised_minor, session_id, connector_uuid FROM payment_intent WHERE settles_intent_id = $1 ORDER BY created_at`, [ex.id])).rows;
  const qrRow = settleRows.find((r: any) => r.channel === 'QRIS');
  const cardRow = settleRows.find((r: any) => r.channel === 'CARD');
  const qrCharge = JSON.parse(callsTo(/^\/v2\/charge$/, tP).find((c) => JSON.parse(c.body).payment_type === 'qris')?.body ?? '{}');
  check('the receipt offers the operator\'s methods and the saved card; the saved card goes to 3-D Secure (nothing paid yet), then QRIS instead: a QR for exactly the amount owed, as separate settlement payments that buy no energy',
    (po.paymentMethods ?? []).map((m: any) => m.channel).join() === 'QRIS,CARD' && (po.savedCards ?? []).some((k: any) => k.id === savedId)
      && viaCard.status === 200 && viaCard.data.paid === false && viaCard.data.payment.action === 'redirect' && /3ds\.midtrans\.test/.test(viaCard.data.payment.checkoutUrl)
      && viaQr.status === 200 && viaQr.data.paid === false && !!viaQr.data.qr?.qrString && viaQr.data.amountMinor === total4 && qrCharge.transaction_details?.gross_amount === total4
      && stP.data.paid === false && stP.data.owedMinor === total4 && settleRows.length === 2 && settleRows.every((r: any) => r.mode === 'settlement' && r.state === 'pending' && r.amount_authorised_minor === total4 && r.session_id === null && r.connector_uuid === null),
    { po, viaCard: viaCard.data, viaQr: { ...viaQr.data, qr: !!viaQr.data.qr }, stP: stP.data, settleRows, qrCharge });

  const paidNote = await raw(hook, JSON.stringify({ order_id: qrRow?.provider_ref, status_code: '200', gross_amount: `${total4}.00`, transaction_status: 'settlement', transaction_id: `tx-${qrRow?.provider_ref}`, payment_type: 'qris', signature_key: sig(qrRow?.provider_ref, '200', `${total4}.00`) }));
  const stPaid = await d('GET', `/v1/charge/${m4.data.chargeId}/pay-expired`);
  const rcPaid = await d('GET', `/v1/charge/${m4.data.chargeId}/receipt`);
  const hold4 = await intentOf(oid4);
  const holdsPaid = await ops('GET', '/v1/card-holds');
  cc('/v1/card-holds', 'get', '200', holdsPaid.data);
  const listedPaid = holdsPaid.data.holds?.find((h: any) => h.id === ex.id);
  const alertsPaid = await ops('GET', '/v1/alerts');
  const alertPaid = (alertsPaid.data ?? []).find((a: any) => a.id === alertEx?.id);
  const payAgain = await d('POST', `/v1/charge/${m4.data.chargeId}/pay-expired`, { method: 'QRIS' });
  const settleCount = Number((await pg.query(`SELECT count(*) AS n FROM payment_intent WHERE settles_intent_id = $1`, [ex.id])).rows[0].n);
  check('Midtrans\' signed notification pays it: the hold is paid in the app (receipt "paid in the app", the console "expired, paid in app" and no longer counted as owed), the alert resolves, and paying again does nothing',
    paidNote.status === 200 && stPaid.data.paid === true && hold4.hold_state === 'captured' && hold4.state === 'captured' && hold4.amount_captured_minor === total4
      && rcPaid.data.settlement?.hold?.paidInApp?.amountMinor === total4 && rcPaid.data.settlement.hold.paidInApp.channel === 'QRIS' && rcPaid.data.settlement.paidMinor === total4 && rcPaid.data.settlement.hold.payOptions === null
      && listedPaid?.paidInApp === true && holdsPaid.data.summary.expired === holdsEx.data.summary.expired - 1 && !!alertPaid?.resolved_at
      && payAgain.status === 200 && payAgain.data.paid === true && settleCount === 2,
    { paidNote: paidNote.data, stPaid: stPaid.data, hold4, rc: rcPaid.data.settlement, listedPaid, summary: holdsPaid.data.summary, alertPaid, payAgain: payAgain.data, settleCount });

  // The abandoned card page is completed afterwards: paid twice, so that second payment is refunded in full.
  const lateNote = await raw(hook, JSON.stringify({ order_id: cardRow?.provider_ref, status_code: '200', gross_amount: `${total4}.00`, transaction_status: 'capture', fraud_status: 'accept', transaction_id: `tx-${cardRow?.provider_ref}`, payment_type: 'credit_card', signature_key: sig(cardRow?.provider_ref, '200', `${total4}.00`) }));
  const late = (await pg.query(`SELECT state, refund_state, refund_due_minor, refund_reason FROM payment_intent WHERE id = $1`, [cardRow?.id])).rows[0];
  const holdAfter = await intentOf(oid4);
  check('a second payment for the same expired hold (the abandoned card page completed later) is refunded in full; the hold stays paid once',
    lateNote.status === 200 && late?.state === 'captured' && late.refund_state === 'due' && late.refund_due_minor === total4 && /paid twice/i.test(late.refund_reason ?? '')
      && holdAfter.amount_captured_minor === total4 && /QRIS/.test(holdAfter.hold_error ?? ''),
    { lateNote: lateNote.data, late, holdAfter });

  // ================================================================ console and app
  const view = await fetch(`${API}/js/views/refunds.js`).then((r) => r.text());
  const app = await fetch(`${API}/app/`).then((r) => r.text());
  const audit = await ops('GET', '/v1/audit?limit=50');
  check('the console lists card holds with a retry; the app has saved cards in the account and the hold wording, and rebuilds the choices when a saved card has ended; the retry is audited',
    view.includes('/v1/card-holds') && view.includes('expired, not charged') && view.includes('expired, paid in app') && app.includes('function paintCards') && app.includes('/pay-unpaid') && app.includes('VIEWS.spay') && app.includes('saved_card_ended') && app.includes('set.hold.expired') && app.includes('Ditahan, bukan ditagih') && audit.text.includes('card_hold.retried'), audit.status);
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
