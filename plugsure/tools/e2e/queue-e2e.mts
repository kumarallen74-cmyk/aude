// PlugSure v1.3 — the driver queue (waitlist) at a busy site.
//
// Drives the REAL API + gateway with a raw OCPP 1.6 charger (two DC connectors:
// CCS2 and CHAdeMO) so the test sees every ReserveNow / CancelReservation, and
// three drivers signed in with phone numbers. Push notifications go to a local
// sink; the test reads what was queued for each phone from push_message.
//
// Needs E2E_DATABASE_URL (the runtime role) to age an offer and a wait.
//
//     npx tsx tools/e2e/queue-e2e.mts
//
// NEVER point this at production.
import { createServer } from 'node:http';
import { createECDH, randomBytes } from 'node:crypto';
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

// A local push service that accepts everything; what matters is what PlugSure queued.
const sink = createServer((req, res) => { req.resume(); req.on('end', () => { res.statusCode = 201; res.end(); }); });
await new Promise<void>((r) => sink.listen(0, '127.0.0.1', () => r()));
const PUSH = `http://127.0.0.1:${(sink.address() as any).port}`;

class Driver {
  token = '';
  endpoint = '';
  constructor(public name: string) {}
  async init() { const r = await http('POST', '/d/v1/device'); this.token = r.data.deviceToken; return this; }
  get = (p: string) => http('GET', '/d' + p, undefined, this.token ? { authorization: 'Bearer ' + this.token } : {});
  post = (p: string, b: unknown = {}) => http('POST', '/d' + p, b, { authorization: 'Bearer ' + this.token });
  async signIn() {
    const phone = `0813${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const s = await until(() => this.post('/v1/otp/send', { phone }), (r) => r.status === 200, 90_000, 5000);
    const v = await this.post('/v1/otp/verify', { phone, code: s.data.devCode });
    const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
    this.endpoint = `${PUSH}/push/${this.name}-${randomBytes(4).toString('hex')}`;
    await this.post('/v1/push/subscribe', { subscription: { endpoint: this.endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }, lang: 'id' });
    return v;
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
  console.log('SKIP  set E2E_DATABASE_URL (the runtime role): the queue test ages an offer and a wait.');
  process.exit(1);
}
const pg = new ((await import('pg')).default.Client)({ connectionString: process.env.E2E_DATABASE_URL });
await pg.connect();
/** Push notifications queued for a driver's phone, oldest first. */
const pushed = async (d: Driver) => (await pg.query(
  `SELECT m.kind, m.payload->>'title' AS title FROM push_message m JOIN push_subscription s ON s.id = m.subscription_id WHERE s.endpoint = $1 ORDER BY m.id`, [d.endpoint])).rows as Array<{ kind: string; title: string }>;
const entryOf = async (d: Driver) => (await d.get('/v1/queue')).data;
let cp: RawCharger | null = null;

try {
  // ------------------------------------------------------------ setup
  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  const base = { address: 'Jl. Gatot Subroto', kabupatenKotaCode: '3171', lat: '-6.2297', lon: '106.8195', gridTariffGroup: 'L/TR', connectedKva: '197', powerFactor: '0.95', phases: '3', localTaxRateBps: '1000' };
  const badSite = await ops('POST', '/v1/sites', { ...base, name: 'Queue E2E bad', queueEnabled: true, queueOfferMinutes: 1, queueMaxLength: 500 });
  const site = await ops('POST', '/v1/sites', { ...base, name: `Queue E2E Hub ${Date.now().toString().slice(-5)}`, queueEnabled: true, queueOfferMinutes: 2, queueMaxLength: 3, queueMaxWaitMinutes: 15 });
  const siteId = site.data.id as string;
  const sd = await ops('GET', `/v1/sites/${siteId}`);
  check('settings: out-of-range queue settings refused (422); a queue site stores its policy',
    login.status === 200 && badSite.status === 422 && !!badSite.data.errors?.queueOfferMinutes && !!badSite.data.errors?.queueMaxLength
      && sd.data.queue_enabled === true && sd.data.queue_offer_minutes === 2 && sd.data.queue_max_length === 3 && sd.data.queue_max_wait_minutes === 15,
    { bad: badSite.data, site: { e: sd.data.queue_enabled, o: sd.data.queue_offer_minutes, l: sd.data.queue_max_length, w: sd.data.queue_max_wait_minutes } });

  const ID = `QUEUE-E2E-${Date.now().toString().slice(-6)}`;
  await ops('POST', '/v1/charge-points', {
    ocppIdentity: ID, siteId, displayName: 'Gatsu DC', vendor: 'Autel', model: 'MaxiCharger DC Compact', serial: ID, ocppVersion: 'ocpp1.6',
    evses: [
      { evseId: 1, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] },
      { evseId: 2, connectors: [{ connectorId: 1, connectorType: 'cChaDeMo', currentKind: 'DC', maxPowerW: 50000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] },
    ],
  });
  await ops('POST', `/v1/charge-points/${ID}/activate`);
  const tariff = await ops('POST', '/v1/tariffs', {
    name: `Queue E2E DC ${ID}`, plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, pricingModel: 'flat', appliesToMaxPowerW: 60000, ppnApplies: true,
    components: [{ kind: 'energy', rate: 2400, touBlock: 'ANY' }, { kind: 'session', rate: 5000, touBlock: 'ANY' }],
  });
  await ops('PUT', `/v1/sites/${siteId}/tariff`, { tariffId: tariff.data.tariffId, currentType: 'DC' });
  cp = new RawCharger(ID);
  await cp.connect();
  await cp.call('BootNotification', { chargePointVendor: 'Autel', chargePointModel: 'MaxiCharger DC Compact' });
  // Both connectors busy: the site is full.
  await cp.status(1, 'Charging'); await cp.status(2, 'Charging');

  const guest = await new Driver('guest').init();
  const st = await until(() => guest.get('/v1/stations'), (r) => r.data.stations?.find((s: any) => s.siteId === siteId)?.connectors?.every((c: any) => c.status === 'Charging'), 20_000, 800);
  const station = st.data.stations.find((s: any) => s.siteId === siteId);
  const ccs = station.connectors.find((c: any) => c.connectorNo === 1).connectorId as string;
  const chademo = station.connectors.find((c: any) => c.connectorNo === 2).connectorId as string;

  const gq = await guest.get(`/v1/sites/${siteId}/queue`);
  const gj = await guest.post('/v1/queue', { siteId });
  check('site queue: public; both connectors busy, both types offered, a guest must sign in first',
    gq.status === 200 && gq.data.enabled === true && gq.data.waiting === 0 && gq.data.freeNow === 0 && gq.data.types.length === 2
      && gq.data.canJoin === false && /Masuk/.test(gq.data.reason) && gj.status === 422 && /Masuk/.test(gj.data.error), { gq: gq.data, gj: gj.data });

  const A = await new Driver('a').init(); const B = await new Driver('b').init(); const C = await new Driver('c').init(); const D = await new Driver('d').init();
  await A.signIn(); await B.signIn(); await C.signIn(); await D.signIn();

  // ------------------------------------------------------------ joining, in order
  const ja = await A.post('/v1/queue', { siteId });
  const jb = await B.post('/v1/queue', { siteId, current: 'DC', type: 'cChaDeMo' });
  const jc = await C.post('/v1/queue', { siteId, current: 'DC', type: 'cCCS2' });
  const again = await A.post('/v1/queue', { siteId });
  const full = await D.post('/v1/queue', { siteId });
  const badWant = await D.post('/v1/queue', { siteId, current: 'XX' });
  check('join: A (any), B (CHAdeMO), C (CCS2) in order; A cannot join twice; a fourth driver finds the queue full (max 3)',
    ja.status === 200 && jb.status === 200 && jc.status === 200 && again.status === 422 && /sudah dalam antrean/.test(again.data.error)
      && full.status === 422 && /penuh/.test(full.data.error) && badWant.status === 422, { ja: ja.data, jb: jb.data?.error, jc: jc.data?.error, again: again.data, full: full.data });
  const pos = [(await entryOf(A)).entry?.position, (await entryOf(B)).entry?.position, (await entryOf(C)).entry?.position];
  check('position: counts only drivers ahead who compete for the same connectors (A 1, B 2, C 2)', JSON.stringify(pos) === '[1,2,2]', pos);

  // ------------------------------------------------------------ a connector frees up → first in line
  let mark = cp.calls.length;
  await cp.status(2, 'Available');
  const rnA = await cp.waitNew('ReserveNow', mark);
  const qa = await until(() => entryOf(A), (r) => r.entry?.state === 'offered', 10_000);
  const resA = await A.get('/v1/reservation');
  check('offer: CHAdeMO frees → held on the charger (ReserveNow, connector 2) for A, first in line; A sees it as a queue offer',
    rnA?.payload?.connectorId === 2 && qa.entry?.offer?.connectorId === chademo && resA.data.reservation?.queue === true && resA.data.reservation.minutesLeft <= 2, { rn: rnA?.payload, qa: qa.entry, res: resA.data.reservation });
  const pa = await until(() => pushed(A), (r) => r.some((m) => m.kind === 'queue.offer'), 10_000);
  check('offer: A is told "Giliran Anda!"', pa.some((m) => m.kind === 'queue.offer' && m.title === 'Giliran Anda!'), pa);
  const stealB = await B.post('/v1/charge/prepaid', { connectorId: chademo, amountMinor: 50000 });
  const detB = await B.get(`/v1/connectors/${chademo}`);
  check('offer: nobody else can take the held connector (B refused; shown Reserved)', stealB.status === 422 && detB.data.status === 'Reserved' && detB.data.available === false, { s: stealB.data, d: detB.data.status });
  check('position: B is now first of those waiting', (await entryOf(B)).entry?.position === 1, (await entryOf(B)).entry);

  // ------------------------------------------------------------ A lets it lapse → missed; the next driver who fits gets it
  mark = cp.calls.length;
  await pg.query(`UPDATE driver_reservation SET expires_at = now() - interval '1 second' WHERE id = $1`, [resA.data.reservation.id]);
  const missed = await until(async () => (await pg.query(`SELECT state, end_reason FROM driver_queue_entry WHERE device_id = (SELECT device_id FROM driver_reservation WHERE id = $1)
      ORDER BY joined_at DESC LIMIT 1`, [resA.data.reservation.id])).rows[0], (r) => r?.state === 'missed', 40_000, 1000);
  const rnB = await cp.waitNew('ReserveNow', mark, 30_000);
  const qb = await until(() => entryOf(B), (r) => r.entry?.state === 'offered', 20_000);
  const endedA = await entryOf(A);
  const noShow = (await pg.query(`SELECT count(*)::int AS n FROM driver_reservation WHERE id = $1 AND state = 'expired' AND queue_entry_id IS NOT NULL`, [resA.data.reservation.id])).rows[0];
  check('missed: A\'s offer lapsed → A misses the turn (out of the queue, told why); the connector goes to B (CHAdeMO)',
    missed?.state === 'missed' && endedA.entry === null && endedA.ended?.state === 'missed' && rnB?.payload?.connectorId === 2 && rnB.payload.idTag !== rnA?.payload?.idTag
      && qb.entry?.offer?.connectorId === chademo && noShow?.n === 1, { missed, endedA, rnB: rnB?.payload, qb: qb.entry });
  const pa2 = await until(() => pushed(A), (r) => r.some((m) => m.kind === 'queue.missed'), 10_000);
  check('missed: A is told, and a missed queue turn is not a reservation no-show', pa2.some((m) => m.kind === 'queue.missed'), pa2);

  // ------------------------------------------------------------ B skips → gives up the place; C cannot use CHAdeMO
  const resB = await B.get('/v1/reservation');
  mark = cp.calls.length;
  const skip = await B.post(`/v1/reservations/${resB.data.reservation.id}/cancel`);
  const crB = await cp.waitNew('CancelReservation', mark);
  await sleep(2500);
  const qb2 = await entryOf(B); const qc = await entryOf(C);
  check('skip: B declines → CancelReservation to the charger, B leaves the queue; C (CCS2) is not offered CHAdeMO',
    skip.status === 200 && crB?.payload?.reservationId != null && qb2.entry === null && qc.entry?.state === 'waiting' && qc.entry.position === 1
      && !cp.calls.slice(mark).some((c) => c.action === 'ReserveNow'), { skip: skip.data, qb2, qc: qc.entry });

  // ------------------------------------------------------------ the charger refuses the hold: walk-ups still cannot jump the queue
  cp.handlers.ReserveNow = () => ({ status: 'Rejected' });
  mark = cp.calls.length;
  await cp.status(1, 'Available');
  const rej = await cp.waitNew('ReserveNow', mark);
  await sleep(1000);
  const qc2 = await entryOf(C);
  const walkUp = await B.post('/v1/charge/prepaid', { connectorId: ccs, amountMinor: 50000 });
  const walkRes = await B.post('/v1/reservations', { connectorId: ccs });
  const walkDet = await guest.get(`/v1/connectors/${ccs}`);
  check('walk-up: the charger refused the hold, C keeps waiting; the free CCS2 is shown "Queued" and B can neither pay nor reserve it',
    rej?.payload?.connectorId === 1 && qc2.entry?.state === 'waiting' && walkUp.status === 422 && /antre/.test(walkUp.data.error)
      && walkRes.status === 422 && /antre/.test(walkRes.data.error) && walkDet.data.status === 'Queued' && walkDet.data.available === false,
    { qc2: qc2.entry, walkUp: walkUp.data, walkRes: walkRes.data, det: walkDet.data.status });

  // ------------------------------------------------------------ the charger accepts again → C's turn (worker retry) → C charges
  delete cp.handlers.ReserveNow;
  mark = cp.calls.length;
  const rnC = await cp.waitNew('ReserveNow', mark, 40_000);
  const qc3 = await until(() => entryOf(C), (r) => r.entry?.state === 'offered', 20_000);
  check('retry: the worker offers the CCS2 to C once the charger accepts the hold', rnC?.payload?.connectorId === 1 && qc3.entry?.offer?.connectorId === ccs, { rn: rnC?.payload, qc3: qc3.entry });
  await cp.status(1, 'Reserved');
  const co = await C.post('/v1/charge/prepaid', { connectorId: ccs, amountMinor: 50000 });
  await C.post(`/v1/charge/${co.data.chargeId}/confirm-payment`);
  cp.handlers.RemoteStartTransaction = () => ({ status: 'Accepted' });
  mark = cp.calls.length;
  await C.post(`/v1/charge/${co.data.chargeId}/start`);
  const rst = await cp.waitNew('RemoteStartTransaction', mark);
  const stx = await cp.call('StartTransaction', { connectorId: 1, idTag: rst!.payload.idTag, meterStart: 0, timestamp: new Date().toISOString(), reservationId: rnC!.payload.reservationId });
  await cp.status(1, 'Charging');
  const served = await until(async () => (await pg.query(`SELECT q.state FROM driver_queue_entry q JOIN driver_reservation r ON r.queue_entry_id = q.id WHERE r.ocpp_reservation_id = $1`, [rnC!.payload.reservationId])).rows[0], (r) => r?.state === 'served', 10_000);
  check('charge: C pays with the held idTag as the claim token, starts, and leaves the queue as served',
    co.status === 200 && co.data.startToken === rnC?.payload?.idTag && rst?.payload?.idTag === rnC?.payload?.idTag && stx?.idTagInfo?.status === 'Accepted' && served?.state === 'served',
    { co: co.data?.startToken, held: rnC?.payload?.idTag, stx, served });

  // ------------------------------------------------------------ a free connector and nobody waiting: just charge
  const freeJoin = await A.post('/v1/queue', { siteId });
  check('join: refused while a suitable connector is free and nobody is waiting (the app offers that connector)',
    freeJoin.status === 422 && /kosong/.test(freeJoin.data.error) && freeJoin.data.connectorId === chademo, freeJoin.data);

  // ------------------------------------------------------------ the console: the queue, removing a driver
  await cp.status(2, 'Charging');
  const jd = await D.post('/v1/queue', { siteId });
  const jaa = await A.post('/v1/queue', { siteId });
  const cq = await ops('GET', `/v1/sites/${siteId}/queue`);
  const dRow = cq.data.entries?.find((e: any) => e.state === 'waiting' && e.position === 1);
  check('console: the queue in order with masked phones, and the last day (1 charged, 1 missed, 1 left)',
    jd.status === 200 && jaa.status === 200 && cq.status === 200 && cq.data.stats.waiting === 2 && cq.data.stats.served24h === 1 && cq.data.stats.missed24h === 1 && cq.data.stats.left24h === 1
      && /••••/.test(dRow?.driver ?? '') && cq.data.settings.offerMinutes === 2, cq.data);
  const rm = await ops('DELETE', `/v1/sites/${siteId}/queue/${dRow?.id}`);
  const rm2 = await ops('DELETE', `/v1/sites/${siteId}/queue/${dRow?.id}`);
  const qd = await entryOf(D);
  const pd = await until(() => pushed(D), (r) => r.some((m) => m.kind === 'queue.removed'), 10_000);
  const aud = (await pg.query(`SELECT action FROM audit_log WHERE action = 'driver_queue.removed' AND target_id = $1`, [siteId])).rows;
  check('console: an operator removes D (told, audited); removing again is 404; A moves up',
    rm.status === 200 && rm2.status === 404 && qd.entry === null && qd.ended?.state === 'removed' && pd.some((m) => m.kind === 'queue.removed')
      && aud.length === 1 && (await entryOf(A)).entry?.position === 1, { rm: rm.data, rm2: rm2.status, qd, aud });

  // ------------------------------------------------------------ waiting too long; switching the queue off
  await pg.query(`UPDATE driver_queue_entry SET joined_at = now() - interval '16 minutes' WHERE device_id = (SELECT d.id FROM driver_device d JOIN push_subscription s ON s.device_id = d.id WHERE s.endpoint = $1) AND state = 'waiting'`, [A.endpoint]);
  const expA = await until(() => entryOf(A), (r) => r.ended?.state === 'expired', 40_000, 1000);
  const pa3 = await pushed(A);
  check('max wait: A\'s place ends after 15 minutes (told)', expA.entry === null && expA.ended?.state === 'expired' && pa3.some((m) => m.kind === 'queue.expired'), { expA, pa3 });
  await B.post('/v1/queue', { siteId });
  const off = await ops('PUT', `/v1/sites/${siteId}`, { queueEnabled: false });
  const closed = await until(() => entryOf(B), (r) => r.ended?.state === 'removed', 40_000, 1000);
  const gq2 = await guest.get(`/v1/sites/${siteId}/queue`);
  const joinOff = await A.post('/v1/queue', { siteId });
  check('queue off: waiting drivers are let go (told), and nobody can join',
    off.status === 200 && closed.ended?.endReason === 'queue closed' && (await pushed(B)).some((m) => m.kind === 'queue.closed')
      && gq2.data.enabled === false && joinOff.status === 422 && /tidak memakai antrean/.test(joinOff.data.error), { off: off.data, closed, gq2: gq2.data, joinOff: joinOff.data });
} catch (e) {
  check('unexpected error', false, (e as Error).stack ?? String(e));
} finally {
  cp?.close();
  sink.close();
  await pg.end().catch(() => {});
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}
