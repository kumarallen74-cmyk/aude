// PlugSure v1.3 — reservation fees in the driver app.
//
// Drives the REAL API + gateway with a raw OCPP 1.6 charger (two connectors), an
// app driver who pays the fee (the mock acquirer) and a fleet driver whose fee goes
// on the fleet invoice. Needs E2E_DATABASE_URL (the runtime role) to move the
// clock (a cancel after the 2-minute grace, a reservation in last month).
//
//     npx tsx tools/e2e/reservation-fees-e2e.mts
//
// NEVER point this at production.
import WebSocket from 'ws';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const OCPP = process.env.E2E_OCPP ?? 'ws://127.0.0.1:9220/ocpp';
const results: boolean[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 500)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000, every = 500): Promise<T> {
  const t0 = Date.now(); let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) { await sleep(every); v = await fn(); }
  return v;
}
async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, data };
}
let cookie = '';
const ops = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(API + path, {
    method,
    headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d };
};
class Driver {
  token = '';
  async init() { const r = await http('POST', '/d/v1/device'); this.token = r.data.deviceToken; return this; }
  get = (p: string) => http('GET', '/d' + p, undefined, { authorization: 'Bearer ' + this.token });
  post = (p: string, b: unknown = {}) => http('POST', '/d' + p, b, { authorization: 'Bearer ' + this.token });
  async signIn() {
    const phone = `0814${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const s = await until(() => this.post('/v1/otp/send', { phone }), (r) => r.status === 200, 90_000, 5000);
    return this.post('/v1/otp/verify', { phone, code: s.data.devCode });
  }
}
class RawCharger {
  ws!: WebSocket;
  calls: Array<{ action: string; payload: any }> = [];
  handlers: Record<string, (p: any) => any> = {};
  pending = new Map<string, (v: any) => void>();
  n = 0;
  constructor(public id: string) {}
  async connect() {
    this.ws = new WebSocket(`${OCPP}/${this.id}`, ['ocpp1.6']);
    await new Promise<void>((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); this.ws.once('unexpected-response', (_q: any, r: any) => rej(new Error(`HTTP ${r.statusCode}`))); });
    this.ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f[0] === 2) {
        const [, uid, action, payload] = f;
        this.calls.push({ action, payload });
        const h = this.handlers[action];
        this.ws.send(JSON.stringify([3, uid, (h ? h(payload) : { status: 'Accepted' }) ?? {}]));
      } else if (f[0] === 3 || f[0] === 4) {
        this.pending.get(f[1])?.(f[0] === 3 ? f[2] : { __error: f[2], desc: f[3] });
        this.pending.delete(f[1]);
      }
    });
  }
  call(action: string, payload: unknown): Promise<any> {
    const uid = `${this.id}-${++this.n}`;
    return new Promise((res) => { this.pending.set(uid, res); this.ws.send(JSON.stringify([2, uid, action, payload])); });
  }
  waitNew(action: string, after: number, ms = 15_000) {
    return until(async () => this.calls.slice(after).find((c) => c.action === action), (v) => !!v, ms, 200);
  }
  status(connectorId: number, status: string) {
    return this.call('StatusNotification', { connectorId, status, errorCode: 'NoError', timestamp: new Date().toISOString() });
  }
  close() { try { this.ws.close(); } catch {} }
}

if (!process.env.E2E_DATABASE_URL) {
  console.log('SKIP  set E2E_DATABASE_URL (the runtime role): the test moves the clock.');
  process.exit(1);
}
const pg = new ((await import('pg')).default.Client)({ connectionString: process.env.E2E_DATABASE_URL });
await pg.connect();
const row = async (sql: string, args: unknown[]) => (await pg.query(sql, args)).rows[0];
let cp: RawCharger | null = null;

try {
  // ------------------------------------------------------------ setup
  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  const base = { address: 'Jl. Sudirman', kabupatenKotaCode: '3171', lat: '-6.2088', lon: '106.8219', gridTariffGroup: 'L/TR', connectedKva: '197', powerFactor: '0.95', phases: '3', pbjtRateBps: '1000' };
  const bad = await ops('POST', '/v1/sites', { ...base, name: 'Fee E2E bad', reservationFeeIdr: 200_000 });
  const site = await ops('POST', '/v1/sites', { ...base, name: `Fee E2E Hub ${Date.now().toString().slice(-5)}`, reservationFeeIdr: 5000 });
  const siteId = site.data.id as string;
  const ID = `RFEE-E2E-${Date.now().toString().slice(-6)}`;
  await ops('POST', '/v1/charge-points', {
    ocppIdentity: ID, siteId, displayName: 'Sudirman DC', vendor: 'Autel', model: 'MaxiCharger DC Compact', serial: ID, ocppVersion: 'ocpp1.6',
    evses: [1, 2].map((e) => ({ evseId: e, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] })),
  });
  await ops('POST', `/v1/charge-points/${ID}/activate`);
  const tariff = await ops('POST', '/v1/tariffs', {
    name: `Fee E2E DC ${ID}`, plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, pricingModel: 'flat', appliesToMaxPowerW: 60000, ppnApplies: true,
    components: [{ kind: 'energy', rate: 2400, touBlock: 'ANY' }],
  });
  await ops('PUT', `/v1/sites/${siteId}/tariff`, { tariffId: tariff.data.tariffId, currentType: 'DC' });
  cp = new RawCharger(ID);
  await cp.connect();
  await cp.call('BootNotification', { chargePointVendor: 'Autel', chargePointModel: 'MaxiCharger DC Compact' });
  await cp.status(1, 'Available'); await cp.status(2, 'Available');
  check('settings: a fee above Rp 100,000 refused (422); the site stores Rp 5,000', login.status === 200 && bad.status === 422 && !!bad.data.errors?.reservationFeeIdr && (await ops('GET', `/v1/sites/${siteId}`)).data.reservation_fee_idr === 5000, bad.data);

  const A = await new Driver().init(); await A.signIn();
  const st = await until(() => A.get('/v1/stations'), (r) => r.data.stations?.find((s: any) => s.siteId === siteId)?.connectors?.every((c: any) => c.status === 'Available'), 20_000, 800);
  const station = st.data.stations.find((s: any) => s.siteId === siteId);
  const c1 = station.connectors.find((c: any) => c.connectorNo === 1).connectorId as string;
  const c2 = station.connectors.find((c: any) => c.connectorNo === 2).connectorId as string;
  const det = await A.get(`/v1/connectors/${c1}`);
  const fee = det.data.reservationFee;
  const TOTAL = fee?.totalIdr as number;
  check('connector: the fee is shown with its PPN (Rp 5,000 + 550 at a PKP operator), with the ways to pay it',
    det.data.canReserve === true && fee?.feeIdr === 5000 && (fee.ppnIdr === 550 ? TOTAL === 5550 : TOTAL === 5000) && fee.fleetInvoice === false
      && (det.data.reservationPay?.paymentMethods ?? []).some((m: any) => m.channel === 'QRIS'), det.data.reservationFee);

  // ------------------------------------------------------------ pay, then the connector is held
  let mark = cp.calls.length;
  const r1 = await A.post('/v1/reservations', { connectorId: c1, method: 'QRIS' });
  await sleep(800);
  check('pay: reserving starts a QRIS payment of the fee; nothing is held before it is paid',
    r1.status === 200 && r1.data.checkout?.state === 'pending' && r1.data.checkout.totalIdr === TOTAL && !!r1.data.qr?.qrString && !r1.data.reservation
      && !cp.calls.slice(mark).some((c) => c.action === 'ReserveNow'), r1.data);
  const paid1 = await A.post(`/v1/reservations/checkout/${r1.data.checkout.id}/confirm-payment`);
  const rn1 = await cp.waitNew('ReserveNow', mark);
  const s1 = await A.get(`/v1/reservations/checkout/${r1.data.checkout.id}`);
  const res1 = await row(`SELECT r.fee_state, r.fee_total_idr, pi.state AS pay_state, pi.amount_captured_idr, pi.mode FROM driver_reservation r JOIN payment_intent pi ON pi.id = r.fee_intent_id WHERE r.id = $1`, [s1.data.reservation?.id]);
  check('pay: once paid, the charger holds connector 1 (ReserveNow); the reservation records the paid fee',
    paid1.status === 200 && rn1?.payload?.connectorId === 1 && s1.data.state === 'held' && s1.data.reservation?.state === 'active'
      && res1?.fee_state === 'paid' && res1.fee_total_idr === TOTAL && res1.pay_state === 'captured' && res1.amount_captured_idr === TOTAL && res1.mode === 'reservation',
    { paid1: paid1.data, s1: s1.data, res1 });

  // ------------------------------------------------------------ cancelled at once: refunded
  const cx1 = await A.post(`/v1/reservations/${s1.data.reservation.id}/cancel`);
  const ref1 = await row(`SELECT r.fee_state, pi.refund_state, pi.refund_due_idr FROM driver_reservation r JOIN payment_intent pi ON pi.id = r.fee_intent_id WHERE r.id = $1`, [s1.data.reservation.id]);
  check('cancel within 2 minutes: the fee is owed back (Refunds: due, the full amount)', cx1.status === 200 && ref1?.fee_state === 'refund_due' && ref1.refund_state === 'due' && ref1.refund_due_idr === TOTAL, ref1);

  // ------------------------------------------------------------ cancelled later: the fee is kept
  const r2 = await A.post('/v1/reservations', { connectorId: c1, method: 'QRIS' });
  await A.post(`/v1/reservations/checkout/${r2.data.checkout.id}/confirm-payment`);
  const s2 = await A.get(`/v1/reservations/checkout/${r2.data.checkout.id}`);
  await pg.query(`UPDATE driver_reservation SET held_at = now() - interval '3 minutes' WHERE id = $1`, [s2.data.reservation?.id]);
  await A.post(`/v1/reservations/${s2.data.reservation?.id}/cancel`);
  const kept = await row(`SELECT r.fee_state, pi.refund_state FROM driver_reservation r JOIN payment_intent pi ON pi.id = r.fee_intent_id WHERE r.id = $1`, [s2.data.reservation?.id]);
  check('cancel after the grace: the fee is kept (it paid for holding the connector)', kept?.fee_state === 'paid' && kept.refund_state === null, kept);

  // ------------------------------------------------------------ abandoned, then paid late: refunded
  const r3 = await A.post('/v1/reservations', { connectorId: c2, method: 'QRIS' });
  const gave = await A.post(`/v1/reservations/checkout/${r3.data.checkout.id}/cancel`);
  mark = cp.calls.length;
  await A.post(`/v1/reservations/checkout/${r3.data.checkout.id}/confirm-payment`);
  await sleep(800);
  const late = await row(`SELECT co.state, pi.refund_state, pi.refund_due_idr FROM reservation_checkout co JOIN payment_intent pi ON pi.id = co.payment_intent_id WHERE co.id = $1`, [r3.data.checkout.id]);
  check('abandoned: a payment that arrives after the driver gave up holds nothing and is owed back',
    gave.status === 200 && late?.state === 'cancelled' && late.refund_state === 'due' && late.refund_due_idr === TOTAL && !cp.calls.slice(mark).some((c) => c.action === 'ReserveNow'), late);

  // ------------------------------------------------------------ the charger refuses the hold: refunded
  cp.handlers.ReserveNow = () => ({ status: 'Rejected' });
  const r4 = await A.post('/v1/reservations', { connectorId: c2, method: 'QRIS' });
  const paid4 = await A.post(`/v1/reservations/checkout/${r4.data.checkout.id}/confirm-payment`);
  const s4 = await A.get(`/v1/reservations/checkout/${r4.data.checkout.id}`);
  const ref4 = await row(`SELECT pi.refund_state, pi.refund_due_idr FROM reservation_checkout co JOIN payment_intent pi ON pi.id = co.payment_intent_id WHERE co.id = $1`, [r4.data.checkout.id]);
  check('refused: paid, but the charger will not hold the connector → the driver is told and the fee is owed back',
    paid4.status === 422 && /dikembalikan/.test(paid4.data.error) && s4.data.state === 'failed' && ref4?.refund_state === 'due' && ref4.refund_due_idr === TOTAL, { paid4: paid4.data, s4: s4.data, ref4 });
  delete cp.handlers.ReserveNow;

  // ------------------------------------------------------------ a fleet card: on the fleet invoice
  const UID = `RFEE-FLT-${Date.now().toString().slice(-6)}`;
  const fleetName = `PT Reservasi E2E ${Date.now().toString().slice(-5)}`;
  await ops('POST', '/v1/tokens', { uid: UID, holderName: 'Fee E2E Fleet', accountType: 'fleet', fleetName, pin: '482913' });
  const F = await new Driver().init();
  const fl = await F.post('/v1/fleet/login', { orgSlug: 'nusantara-charge', rfidUid: UID, pin: '482913' });
  const account = ((await ops('GET', '/v1/fleet-accounts')).data.accounts ?? []).find((a: any) => a.name === fleetName);
  const detF = await F.get(`/v1/connectors/${c2}`);
  const period = (await ops('GET', '/v1/fleet-billing/periods/2000-01')).data.current as string;
  const draftFees = async () => ((await ops('GET', `/v1/fleet-accounts/${account?.id}/statement?period=${period}`)).data.fees ?? []).filter((f: any) => f.kind === 'reservation');
  mark = cp.calls.length;
  const rf1 = await F.post('/v1/reservations', { connectorId: c2 });
  const rnF = await cp.waitNew('ReserveNow', mark);
  const inDraft = await draftFees();
  check('fleet: the card reserves with no payment; the fee goes on the fleet account\'s statement for the month',
    fl.status === 200 && !!account && detF.data.reservationFee?.fleetInvoice === true && rf1.status === 200 && rf1.data.reservation?.state === 'active' && !rf1.data.checkout
      && rnF?.payload?.idTag === UID && inDraft.length === 1 && inDraft[0].totalIdr === TOTAL && inDraft[0].subscriber === UID, { rf1: rf1.data, inDraft });
  await F.post(`/v1/reservations/${rf1.data.reservation.id}/cancel`);
  const afterWaive = await draftFees();
  const waived = await row(`SELECT fee_state FROM driver_reservation WHERE id = $1`, [rf1.data.reservation.id]);
  check('fleet: cancelled within 2 minutes → waived, off the statement', waived?.fee_state === 'waived' && afterWaive.length === 0, { waived, afterWaive });

  // last month's reservation → issued on that month's invoice
  const rf2 = await F.post('/v1/reservations', { connectorId: c2 });
  await pg.query(`UPDATE driver_reservation SET held_at = (date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta') - interval '3 days') AT TIME ZONE 'Asia/Jakarta' WHERE id = $1`, [rf2.data.reservation?.id]);
  await F.post(`/v1/reservations/${rf2.data.reservation?.id}/cancel`);
  const [y, m] = period.split('-').map(Number);
  const prev = m === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, '0')}`;
  const inv = await ops('POST', '/v1/fleet-invoices', { fleetAccountId: account?.id, period: prev });
  const invDoc = await ops('GET', `/v1/fleet-invoices/${inv.data.id}`);
  const invFees = (invDoc.data.fees ?? []).filter((f: any) => f.kind === 'reservation');
  const item = await row(`SELECT invoice_id FROM fleet_invoice_item WHERE kind = 'reservation' AND ref_id = $1`, [rf2.data.reservation?.id]);
  const again = await ops('GET', `/v1/fleet-accounts/${account?.id}/statement?period=${prev}`);
  check('fleet: a reservation held last month and cancelled after the grace keeps its fee, and is invoiced once, with its PPN in the totals',
    inv.status === 201 && invFees.length === 1 && invFees[0].totalIdr === TOTAL && invDoc.data.totals?.feesIdr === TOTAL && item?.invoice_id === inv.data.id && again.data.status !== 'draft',
    { inv: inv.data, fees: invDoc.data.fees, totals: invDoc.data.totals, item });

  // ------------------------------------------------------------ free again
  await ops('PUT', `/v1/sites/${siteId}`, { reservationFeeIdr: '' });
  const detFree = await A.get(`/v1/connectors/${c1}`);
  mark = cp.calls.length;
  const free = await A.post('/v1/reservations', { connectorId: c1 });
  check('free: with the fee cleared, reserving holds at once with nothing to pay',
    detFree.data.reservationFee === null && free.status === 200 && free.data.reservation?.state === 'active' && !free.data.checkout && !!(await cp.waitNew('ReserveNow', mark)), { det: detFree.data.reservationFee, free: free.data });
  await A.post(`/v1/reservations/${free.data.reservation?.id}/cancel`);
} catch (e) {
  check('unexpected error', false, (e as Error).stack ?? String(e));
} finally {
  cp?.close();
  await pg.end().catch(() => {});
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}
