// PlugSure v1.3 — driver app end-to-end test.
//
// Drives the REAL API + gateway: the operator sets a charger up in the v1.3
// console, then a driver finds it, pays by QRIS (mock), charges, stops, and gets
// the tax receipt; a fleet driver signs in with a PIN issued in the RFID centre;
// maintenance holds and card limits set in the console reach the app.
//
// Same prerequisites as console-e2e.mts (migrated + seeded DB, stack running
// with OCPP_MIN_SECURITY_PROFILE=0, OCPP_AUTO_ADOPT=false, NODE_ENV=development
// so the mock QRIS confirm is available). Then:
//
//     npx tsx tools/e2e/driver-e2e.mts        (E2E_API / E2E_PASSWORD override)
//
// NEVER point this at production.
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import WebSocket from 'ws';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const OCPP = process.env.E2E_OCPP ?? 'ws://127.0.0.1:9220/ocpp';
const ROOT = join(import.meta.dirname, '..', '..');
const results: boolean[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 400)}`}`);
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
  return { status: res.status, data, text, headers: res.headers };
}

/** Operator console session (cookie + CSRF header). */
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

/** A driver device. */
class Driver {
  token = '';
  async init() { const r = await http('POST', '/d/v1/device'); this.token = r.data.deviceToken; return r; }
  get = (p: string) => http('GET', '/d' + p, undefined, this.token ? { authorization: 'Bearer ' + this.token } : {});
  post = (p: string, b: unknown = {}) => http('POST', '/d' + p, b, { authorization: 'Bearer ' + this.token });
}

/** Minimal raw OCPP-J station, so the test controls every 2.0.1 frame. */
class RawCharger {
  ws!: WebSocket;
  calls: Array<{ action: string; payload: any }> = [];
  handlers: Record<string, (p: any) => any> = {};
  pending = new Map<string, (v: any) => void>();
  n = 0;
  constructor(public id: string, public version: 'ocpp1.6' | 'ocpp2.0.1') {}
  async connect() {
    this.ws = new WebSocket(`${OCPP}/${this.id}`, [this.version]);
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
  waitFor(action: string, ms = 15_000) {
    return until(async () => this.calls.find((c) => c.action === action), (v) => !!v, ms, 200);
  }
  close() { try { this.ws.close(); } catch {} }
}

const children: ChildProcess[] = [];
const raws: RawCharger[] = [];
function sim(args: string[]) {
  const cli = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const p = spawn(process.execPath, [cli, 'tools/simulator/autel-sim.ts', '--url', OCPP, '--api', API, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout!.on('data', () => {}); p.stderr!.on('data', () => {});
  children.push(p);
}

try {
  // ------------------------------------------------------------ operator setup (v1.3 console)
  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  check('setup: operator signs in to the console', login.status === 200, login.data);
  const site = await ops('POST', '/v1/sites', {
    name: 'Driver E2E Hub — Kuningan', address: 'Jl. H.R. Rasuna Said', kabupatenKotaCode: '3171', lat: '-6.2215', lon: '106.8320',
    gridTariffGroup: 'L/TR', connectedKva: '197', powerFactor: '0.95', phases: '3', pbjtRateBps: '1000',
  });
  const siteId = site.data.id as string;
  const ID = `DRV-E2E-${Date.now().toString().slice(-6)}`;
  const reg = await ops('POST', '/v1/charge-points', {
    ocppIdentity: ID, siteId, displayName: 'Kuningan Lobby DC', vendor: 'Autel', model: 'MaxiCharger DC Compact', serial: ID, ocppVersion: 'ocpp1.6',
    evses: [1, 2].map((e) => ({ evseId: e, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] })),
  });
  check('setup: charger registered with a display name', reg.status === 200, reg.data);
  const key = await ops('POST', `/v1/charge-points/${ID}/keys`, { profile: 1, rotationDays: 90 });
  await ops('PUT', `/v1/charge-points/${ID}/security-profile`, { profile: 1 });
  await ops('POST', `/v1/charge-points/${ID}/activate`);
  const tariff = await ops('POST', '/v1/tariffs', {
    name: 'Driver E2E DC', plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, pricingModel: 'flat', appliesToMaxPowerW: 60000, ppnApplies: true,
    components: [{ kind: 'energy', rate: 2400, touBlock: 'ANY' }, { kind: 'session', rate: 5000, touBlock: 'ANY' }],
  });
  const asg = await ops('PUT', `/v1/sites/${siteId}/tariff`, { tariffId: tariff.data.tariffId, currentType: 'DC' });
  check('setup: legal tariff assigned to the site', tariff.status === 200 && asg.status === 200, { t: tariff.data, a: asg.data });
  sim(['--id', ID, '--auth-key', key.data.key, '--connectors', '2', '--dc', '--vendor', 'Autel', '--model', 'MaxiCharger DC Compact', '--kwh', '30', '--speed', '60', '--meter-interval', '5']);
  const comm = await until(() => ops('GET', `/v1/charge-points/${ID}/commissioning`), (r) => r.data?.adopted === true, 40_000, 1000);
  check('setup: simulator connected and adopted', comm.data?.adopted === true, comm.data);

  // ------------------------------------------------------------ public browse
  const d = new Driver();
  const dev = await d.init();
  check('driver: device token issued', dev.status === 200 && /^psd_/.test(d.token), dev.data);
  const st = await until(() => d.get('/v1/stations'), (r) => !!r.data.stations?.find((s: any) => s.siteId === siteId)?.connectors?.every((c: any) => c.status === 'Available'), 20_000, 1000);
  const station = st.data.stations.find((s: any) => s.siteId === siteId);
  check('stations: new site listed, both connectors Available via the bridge', station?.availableCount === 2, station?.connectors?.map((c: any) => c.status));
  check('stations: charger display name and headline price shown', station?.connectors?.[0]?.chargerName === 'Kuningan Lobby DC' && station.priceFromIdr === 2400, { name: station?.connectors?.[0]?.chargerName, price: station?.priceFromIdr });
  const res = await d.get(`/v1/resolve?code=${encodeURIComponent(ID + ':1')}`);
  check('resolve: QR code IDENTITY:1 → connector', res.status === 200 && res.data.connectorNo === 1, res.data);
  const conn1 = res.data.connectorId as string;
  const conn2 = station.connectors.find((c: any) => c.connectorNo === 2).connectorId as string;
  const det = await d.get(`/v1/connectors/${conn1}`);
  check('connector: detail with energy price and service fee', det.data.energyPriceIdr === 2400 && det.data.fees?.some((f: any) => f.kind === 'session' && f.rate === 5000), det.data);

  // ------------------------------------------------------------ maintenance hold from the console reaches the app
  const inop = await ops('POST', `/v1/charge-points/${ID}/availability`, { connectorId: 2, type: 'Inoperative', reason: 'E2E: gun 2 cable jacket damaged' });
  const m = await until(() => d.get(`/v1/connectors/${conn2}`), (r) => r.data.status === 'Maintenance', 10_000);
  check('maintenance: console Inoperative + reason → app shows Maintenance, internal reason hidden', inop.status === 200 && m.data.status === 'Maintenance' && !/cable/.test(m.data.blockedReason), m.data);
  const mq = await d.post('/v1/charge/quote', { connectorId: conn2, amountIdr: 50000 });
  check('maintenance: cannot pay for a connector on maintenance hold (422)', mq.status === 422 && /perawatan/.test(mq.data.error), mq.data);
  await ops('POST', `/v1/charge-points/${ID}/availability`, { connectorId: 2, type: 'Operative' });
  const back = await until(() => d.get(`/v1/connectors/${conn2}`), (r) => r.data.status === 'Available', 10_000);
  check('maintenance: back to Available after Operative', back.data.status === 'Available', back.data.status);

  // ------------------------------------------------------------ prepaid QRIS journey
  const q = await d.post('/v1/charge/quote', { connectorId: conn1, amountIdr: 50000 });
  check('prepaid: quote Rp 50,000 buys energy', q.status === 200 && q.data.allowanceKwh > 0, q.data);
  const co = await d.post('/v1/charge/prepaid', { connectorId: conn1, amountIdr: 50000 });
  check('prepaid: checkout returns a QRIS QR and a single-use start token', co.status === 200 && co.data.qr?.qrImage?.startsWith('data:image/svg+xml') && /^PS-/.test(co.data.startToken), co.data);
  const png = Buffer.from(String(co.data.qr?.qrPng ?? '').split(',')[1] ?? '', 'base64');
  check('prepaid: "Simpan QR" PNG of the same code is returned (valid PNG header)',
    String(co.data.qr?.qrPng).startsWith('data:image/png;base64,') && png.subarray(1, 4).toString() === 'PNG' && png.length > 500, { len: png.length });
  const chargeId = co.data.chargeId as string;
  const early = await d.post(`/v1/charge/${chargeId}/start`);
  check('prepaid: start refused before payment', early.status === 400, early.data);
  const other = new Driver(); await other.init();
  const steal = await other.get(`/v1/charge/${chargeId}/status`);
  check('prepaid: another device cannot see this charge (404)', steal.status === 404, steal.status);
  await d.post(`/v1/charge/${chargeId}/confirm-payment`);
  const t0 = Date.now();
  const start = await d.post(`/v1/charge/${chargeId}/start`);
  check(`prepaid: remote start accepted through the bridge (${Date.now() - t0} ms)`, start.status === 200 && start.data.status === 'Accepted', start.data);
  const live = await until(() => d.get(`/v1/charge/${chargeId}/status`), (r) => r.data.state === 'charging' && r.data.energyKwh > 0, 45_000, 1000);
  check('prepaid: live status charging with energy and progress', live.data.state === 'charging' && live.data.progressPct != null, live.data);
  check('prepaid: the cost so far while charging (tax included, not final yet)',
    live.data.cost?.final === false && live.data.cost.totalIdr > 0 && live.data.cost.taxIdr > 0 && live.data.estimatedIdr === live.data.cost.totalIdr, live.data.cost);
  const replay = await d.post(`/v1/charge/${chargeId}/start`);
  check('prepaid: replayed start refused once the session is bound', replay.status === 400, replay.data);
  const stop = await d.post(`/v1/charge/${chargeId}/stop`);
  check('prepaid: driver stop accepted by the charger', stop.status === 200 && stop.data.status === 'Accepted', stop.data);
  const rated = await until(() => d.get(`/v1/charge/${chargeId}/status`), (r) => r.data.state === 'rated' && r.data.hasReceipt, 60_000, 1500);
  check('prepaid: session rated into a receipt', rated.data.state === 'rated', rated.data);
  const rc = await d.get(`/v1/charge/${chargeId}/receipt`);
  const t = rc.data.tax;
  check('receipt: PBJT-TL 10%, PPN 12% × DPP (11% effective), receipt no.', rc.status === 200 && t?.pbjtRateBps === 1000 && t.ppnRateBps === 1200 && t.ppnEffectiveRateBps === 1100 && t.dppFraction === '11/12' && t.ppnIdr > 0 && /^PS-/.test(rc.data.receiptNo), { t, no: rc.data.receiptNo });
  const afterRating = await d.get(`/v1/charge/${chargeId}/status`);
  check('prepaid: once rated, the cost shown is the receipt total, marked final',
    afterRating.data.cost?.final === true && afterRating.data.cost.totalIdr === t.totalIdr, { cost: afterRating.data.cost, receipt: t?.totalIdr });
  check('receipt: prepaid settlement shows the refund of unused balance', rc.data.settlement?.paidIdr === 50000 && rc.data.settlement.refundIdr === 50000 - t.totalIdr, rc.data.settlement);
  const doc = await d.get(`/v1/charge/${chargeId}/receipt.html`);
  check('receipt: printable tax receipt with DPP, PPN and PBJT-TL', doc.status === 200 && /DPP nilai lain/.test(doc.text) && /PPN 12% × DPP \(efektif 11%/.test(doc.text) && /PBJT-TL/.test(doc.text), doc.status);
  const docOther = await other.get(`/v1/charge/${chargeId}/receipt.html`);
  check('receipt: another device cannot fetch it (404)', docOther.status === 404, docOther.status);
  const hist = await d.get('/v1/history');
  check('history: the charge is listed with its total', hist.data.charges?.[0]?.chargeId === chargeId && hist.data.charges[0].totalIdr === t.totalIdr, hist.data.charges?.[0]);

  // ------------------------------------------------------------ fleet driver with an RFID-centre PIN
  const UID = Date.now().toString(16).slice(-10).toUpperCase();
  const card = await ops('POST', '/v1/tokens', { uid: UID, holderName: 'E2E Fleet Driver', accountType: 'fleet', fleetName: 'E2E Logistics', pin: '482913' });
  check('fleet: card with app PIN issued in the RFID centre', card.status === 200, card.data);
  const f = new Driver(); await f.init();
  const wrongPin = await f.post('/v1/fleet/login', { orgSlug: 'nusantara-charge', rfidUid: UID.toLowerCase(), pin: '000000' });
  check('fleet: wrong PIN refused', wrongPin.status === 400, wrongPin.data);
  const fl = await f.post('/v1/fleet/login', { orgSlug: 'nusantara-charge', rfidUid: UID.toLowerCase(), pin: '482913' });
  check('fleet: sign-in with the console-issued (scrypt) PIN, lower-case serial accepted', fl.status === 200 && fl.data.fleet?.uid === UID, fl.data);
  const fco = await f.post('/v1/charge/fleet', { connectorId: conn2 });
  check('fleet: checkout on a fleet connector (no payment)', fco.status === 200 && fco.data.startToken === UID, fco.data);
  const fst = await f.post(`/v1/charge/${fco.data.chargeId}/start`);
  check('fleet: remote start with the fleet card accepted', fst.status === 200 && fst.data.status === 'Accepted', fst.data);
  const flive = await until(() => f.get(`/v1/charge/${fco.data.chargeId}/status`), (r) => r.data.state === 'charging' && r.data.energyKwh > 0, 45_000, 1000);
  check('fleet: charging, with a running cost estimate', flive.data.state === 'charging' && flive.data.estimatedIdr > 0, flive.data);
  const fstop = await f.post(`/v1/charge/${fco.data.chargeId}/stop`);
  const fdone = await until(() => f.get(`/v1/charge/${fco.data.chargeId}/status`), (r) => r.data.state === 'rated', 60_000, 1500);
  check('fleet: stopped and rated, billed to the fleet', fstop.status === 200 && fdone.data.state === 'rated', { stop: fstop.data, s: fdone.data.state });
  const pending = await f.post('/v1/charge/fleet', { connectorId: conn2 });
  // Limit below what the card has already drawn (1 Wh).
  const lim = await ops('PUT', `/v1/tokens/${card.data.id}`, { energyLimitKwh: 0.001 });
  const over = await f.post('/v1/charge/fleet', { connectorId: conn2 });
  check('fleet: energy limit set in the console refuses the next checkout with a reason', lim.status === 200 && over.status === 422 && /Batas energi/.test(over.data.error), { lim: lim.data, over: over.data });
  const overStart = await f.post(`/v1/charge/${pending.data.chargeId}/start`);
  check('fleet: an already-created charge cannot start once the limit is reached', overStart.status === 400 && /Batas energi/.test(overStart.data.error), overStart.data);
  for (let i = 0; i < 5; i++) await f.post('/v1/fleet/login', { orgSlug: 'nusantara-charge', rfidUid: UID, pin: '111111' });
  const locked = await f.post('/v1/fleet/login', { orgSlug: 'nusantara-charge', rfidUid: UID, pin: '482913' });
  check('fleet: 5 wrong PINs lock the card, even for the right PIN', locked.status === 400 && /Terlalu banyak/.test(locked.data.error), locked.data);
  const reset = await ops('PUT', `/v1/tokens/${card.data.id}`, { pin: '482913', energyLimitKwh: null });
  const relog = await f.post('/v1/fleet/login', { orgSlug: 'nusantara-charge', rfidUid: UID, pin: '482913' });
  check('fleet: re-issuing the PIN in the console clears the lock', reset.status === 200 && relog.status === 200, relog.data);

  // ------------------------------------------------------------ OCPP 2.0.1 station: driver start + stop
  // The 2.0.1 transaction id is the station's own string. A non-numeric id
  // proves the app sends it verbatim (the pre-fix code sent Number(id) = NaN).
  const ID3 = `DRV-201-${Date.now().toString().slice(-6)}`;
  const reg3 = await ops('POST', '/v1/charge-points', {
    ocppIdentity: ID3, siteId, displayName: 'Kuningan 2.0.1 DC', ocppVersion: 'ocpp2.0.1',
    evses: [{ evseId: 1, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] }],
  });
  await ops('POST', `/v1/charge-points/${ID3}/activate`);
  const c201 = new RawCharger(ID3, 'ocpp2.0.1');
  raws.push(c201);
  await c201.connect();
  const boot = await c201.call('BootNotification', { reason: 'PowerUp', chargingStation: { model: 'MaxiCharger DC', vendorName: 'Autel', firmwareVersion: '1.0.5' } });
  await c201.call('StatusNotification', { timestamp: new Date().toISOString(), connectorStatus: 'Available', evseId: 1, connectorId: 1 });
  check('2.0.1: station registered, booted and reported Available', reg3.status === 200 && boot.status === 'Accepted', { reg: reg3.data, boot });

  const d2 = new Driver(); await d2.init();
  const r3 = await until(() => d2.get(`/v1/resolve?code=${encodeURIComponent(ID3 + ':1')}`), (r) => r.data?.status === 'Available', 15_000, 500);
  check('2.0.1: driver sees the connector Available through the bridge', r3.data?.status === 'Available', r3.data);
  const co3 = await d2.post('/v1/charge/prepaid', { connectorId: r3.data.connectorId, amountIdr: 50000 });
  await d2.post(`/v1/charge/${co3.data.chargeId}/confirm-payment`);
  const tag = co3.data.startToken as string;
  c201.handlers.RequestStartTransaction = () => ({ status: 'Accepted' });
  const st3 = await d2.post(`/v1/charge/${co3.data.chargeId}/start`);
  const rst = await c201.waitFor('RequestStartTransaction');
  check('2.0.1: app start arrives as RequestStartTransaction with the claim token',
    st3.status === 200 && st3.data.status === 'Accepted' && rst?.payload?.idToken?.idToken === tag && rst.payload.evseId === 1, { st: st3.data, p: rst?.payload });

  const TX = `TX-${Date.now().toString(36)}-a7f3`;
  const mv = (wh: number) => [{ timestamp: new Date().toISOString(), sampledValue: [{ value: wh, measurand: 'Energy.Active.Import.Register', unitOfMeasure: { unit: 'Wh' } }] }];
  const started = await c201.call('TransactionEvent', {
    eventType: 'Started', timestamp: new Date().toISOString(), triggerReason: 'RemoteStart', seqNo: 0,
    transactionInfo: { transactionId: TX, chargingState: 'Charging', remoteStartId: rst?.payload?.remoteStartId },
    evse: { id: 1, connectorId: 1 }, idToken: { idToken: tag, type: 'Central' }, meterValue: mv(0),
  });
  check('2.0.1: TransactionEvent Started accepted for the paid token', started?.idTokenInfo?.status === 'Accepted', started);
  await sleep(1500);
  await c201.call('TransactionEvent', {
    eventType: 'Updated', timestamp: new Date().toISOString(), triggerReason: 'MeterValuePeriodic', seqNo: 1,
    transactionInfo: { transactionId: TX, chargingState: 'Charging' }, evse: { id: 1, connectorId: 1 }, meterValue: mv(1500),
  });
  const live3 = await until(() => d2.get(`/v1/charge/${co3.data.chargeId}/status`), (r) => r.data.state === 'charging' && r.data.energyKwh >= 1.5, 15_000, 500);
  check('2.0.1: live status shows 1.5 kWh charging', live3.data.state === 'charging' && live3.data.energyKwh === 1.5, live3.data);

  c201.handlers.RequestStopTransaction = () => ({ status: 'Accepted' });
  const stop3 = await d2.post(`/v1/charge/${co3.data.chargeId}/stop`);
  const rstop = await c201.waitFor('RequestStopTransaction');
  check('2.0.1: driver stop is accepted by the station', stop3.status === 200 && stop3.data.status === 'Accepted', stop3.data);
  check('2.0.1: RequestStopTransaction carries the station\'s STRING transaction id verbatim',
    typeof rstop?.payload?.transactionId === 'string' && rstop.payload.transactionId === TX, rstop?.payload);
  await c201.call('TransactionEvent', {
    eventType: 'Ended', timestamp: new Date().toISOString(), triggerReason: 'RemoteStop', seqNo: 2,
    transactionInfo: { transactionId: TX, chargingState: 'Idle', stoppedReason: 'Remote' }, evse: { id: 1, connectorId: 1 }, meterValue: mv(1500),
  });
  const rated3 = await until(() => d2.get(`/v1/charge/${co3.data.chargeId}/status`), (r) => r.data.state === 'rated' && r.data.hasReceipt, 30_000, 1000);
  const rc3 = await d2.get(`/v1/charge/${co3.data.chargeId}/receipt`);
  check('2.0.1: session ended and rated; receipt for 1.5 kWh with PPN and PBJT-TL',
    rated3.data.state === 'rated' && rc3.data.energyKwh === 1.5 && rc3.data.tax?.ppnIdr > 0 && rc3.data.tax?.pbjtIdr > 0, { s: rated3.data.state, e: rc3.data.energyKwh, t: rc3.data.tax });
  const again = await d2.post(`/v1/charge/${co3.data.chargeId}/stop`);
  check('2.0.1: stopping an already-ended session is refused cleanly (400, not 500)', again.status === 400, again);

  // ------------------------------------------------------------ the web app is served
  const appHtml = await http('GET', '/app/');
  check('app: driver web app served at /app/', appHtml.status === 200 && /Perawatan/.test(appHtml.text) && /receipt\.html/.test(appHtml.text), appHtml.status);
} catch (e) {
  check('unexpected error', false, (e as Error).stack ?? String(e));
} finally {
  for (const c of children) c.kill();
  for (const r of raws) r.close();
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}
