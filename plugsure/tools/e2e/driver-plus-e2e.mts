// PlugSure v1.3 — driver app: map, favourites, push notifications, reservations.
//
// Drives the REAL API + gateway with a raw OCPP 1.6 charger (so the test sees
// every ReserveNow / CancelReservation frame) and a mock Web Push service that
// checks what a real one would: the VAPID JWT signed with the server's key, and
// a payload encrypted to THIS test's subscription keys (RFC 8291), which the
// test decrypts itself.
//
// Same prerequisites as driver-e2e.mts. Reminder and expiry need the clock
// moved: set E2E_DATABASE_URL (the runtime role) to age a reservation.
//
//     npx tsx tools/e2e/driver-plus-e2e.mts
//
// NEVER point this at production.
import { createServer, type IncomingMessage } from 'node:http';
import { createECDH, createHmac, createDecipheriv, createPublicKey, verify, randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const OCPP = process.env.E2E_OCPP ?? 'ws://127.0.0.1:9220/ocpp';
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
  get = (p: string) => http('GET', '/d' + p, undefined, this.token ? { authorization: 'Bearer ' + this.token } : {});
  post = (p: string, b: unknown = {}) => http('POST', '/d' + p, b, { authorization: 'Bearer ' + this.token });
  del = (p: string) => http('DELETE', '/d' + p, undefined, { authorization: 'Bearer ' + this.token });
  async signIn(phone: string) {
    // The same number within the resend window must wait for a new code.
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
  last(action: string) { return [...this.calls].reverse().find((c) => c.action === action); }
  waitNew(action: string, after: number, ms = 15_000) {
    return until(async () => this.calls.slice(after).find((c) => c.action === action), (v) => !!v, ms, 200);
  }
  status(connectorId: number, status: string) {
    return this.call('StatusNotification', { connectorId, status, errorCode: 'NoError', timestamp: new Date().toISOString() });
  }
  close() { try { this.ws.close(); } catch {} }
}

// ------------------------------------------------------------ mock Web Push service
const b64u = (b: Buffer) => b.toString('base64url');
interface Received { path: string; headers: IncomingMessage['headers']; body: Buffer; at: number }
const received: Received[] = [];
const replyWith = new Map<string, number>();          // path → status to answer with
const pushServer = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks), at: Date.now() });
    res.statusCode = replyWith.get(req.url ?? '') ?? 201;
    res.end();
  });
});
await new Promise<void>((r) => pushServer.listen(0, '127.0.0.1', () => r()));
const PUSH = `http://127.0.0.1:${(pushServer.address() as any).port}`;

/** A browser's push subscription: its own P-256 key pair and auth secret. */
function subscription(path: string) {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, json: { endpoint: PUSH + path, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } } };
}
/** RFC 8291 + RFC 8188 (aes128gcm), receiver side — written from the RFCs, not from the server code. */
function decrypt(body: Buffer, sub: ReturnType<typeof subscription>): any {
  const salt = body.subarray(0, 16), idlen = body[20]!, asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const hmac = (k: Buffer, d: Buffer) => createHmac('sha256', k).update(d).digest();
  const secret = sub.ecdh.computeSecret(asPublic);
  const prkKey = hmac(sub.auth, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), sub.ecdh.getPublicKey(), asPublic, Buffer.from([1])])).subarray(0, 32);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = plain.length - 1; while (end > 0 && plain[end] === 0) end--;          // padding
  if (plain[end] !== 2) throw new Error('bad padding delimiter');
  return JSON.parse(plain.subarray(0, end).toString('utf8'));
}
/** VAPID (RFC 8292): an ES256 JWT for the push service's origin, signed with the key in k=. */
function vapidOk(auth: string | undefined, endpointOrigin: string, publicKey: string): { ok: boolean; why?: string; claims?: any } {
  const m = /^vapid t=([^,\s]+),\s*k=([A-Za-z0-9_-]+)$/.exec(auth ?? '');
  if (!m) return { ok: false, why: 'no vapid header' };
  if (m[2] !== publicKey) return { ok: false, why: 'k is not the key published in /d/v1/meta' };
  const [h, p, s] = m[1]!.split('.');
  const pub = Buffer.from(m[2]!, 'base64url');
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
  const good = verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'));
  if (!good) return { ok: false, why: 'bad signature' };
  const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
  const now = Date.now() / 1000;
  if (header.alg !== 'ES256') return { ok: false, why: 'alg' };
  if (claims.aud !== endpointOrigin) return { ok: false, why: `aud ${claims.aud}` };
  if (!(claims.exp > now && claims.exp <= now + 24 * 3600 + 60)) return { ok: false, why: 'exp' };
  if (!/^(mailto:|https:)/.test(claims.sub ?? '')) return { ok: false, why: 'sub' };
  return { ok: true, claims };
}
const pushesTo = (path: string, after = 0) => received.filter((r) => r.path === path && r.at >= after);

const raws: RawCharger[] = [];
const pg = process.env.E2E_DATABASE_URL ? new ((await import('pg')).default.Client)({ connectionString: process.env.E2E_DATABASE_URL }) : null;
if (pg) await pg.connect();

try {
  // ------------------------------------------------------------ operator setup
  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  check('setup: operator signs in to the console', login.status === 200, login.data);
  const site = await ops('POST', '/v1/sites', {
    name: 'Driver+ E2E Hub — Senayan', address: 'Jl. Asia Afrika', kabupatenKotaCode: '3171', lat: '-6.2183', lon: '106.8023',
    gridTariffGroup: 'L/TR', connectedKva: '197', powerFactor: '0.95', phases: '3', pbjtRateBps: '1000',
  });
  const siteId = site.data.id as string;
  const ID = `DRVP-E2E-${Date.now().toString().slice(-6)}`;
  const reg = await ops('POST', '/v1/charge-points', {
    ocppIdentity: ID, siteId, displayName: 'Senayan Parkir DC', vendor: 'Autel', model: 'MaxiCharger DC Compact', serial: ID, ocppVersion: 'ocpp1.6',
    evses: [1, 2].map((e) => ({ evseId: e, connectors: [{ connectorId: 1, connectorType: 'cCCS2', currentKind: 'DC', maxPowerW: 60000, teraCertStatus: 'verified', teraDueAt: '2027-12-31' }] })),
  });
  await ops('POST', `/v1/charge-points/${ID}/activate`);
  const tariff = await ops('POST', '/v1/tariffs', {
    name: `Driver+ E2E DC ${ID}`, plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, pricingModel: 'flat', appliesToMaxPowerW: 60000, ppnApplies: true,
    components: [{ kind: 'energy', rate: 2400, touBlock: 'ANY' }, { kind: 'session', rate: 5000, touBlock: 'ANY' }],
  });
  await ops('PUT', `/v1/sites/${siteId}/tariff`, { tariffId: tariff.data.tariffId, currentType: 'DC' });
  const cp = new RawCharger(ID); raws.push(cp);
  await cp.connect();
  const boot = await cp.call('BootNotification', { chargePointVendor: 'Autel', chargePointModel: 'MaxiCharger DC Compact' });
  await cp.status(1, 'Available'); await cp.status(2, 'Available');
  check('setup: raw 1.6 charger registered, booted, both connectors Available', reg.status === 200 && boot.status === 'Accepted', { reg: reg.data, boot });

  // ------------------------------------------------------------ app settings (public)
  const meta = await http('GET', '/d/v1/meta');
  const pk = meta.data?.push?.publicKey as string;
  check('meta: public, with map tiles, attribution, VAPID key, reservation minutes',
    meta.status === 200 && /\{z\}.*\{x\}.*\{y\}/.test(meta.data.map?.tileUrl) && /OpenStreetMap/.test(meta.data.map?.attribution)
      && Buffer.from(pk ?? '', 'base64url').length === 65 && meta.data.reservations?.enabled === true && meta.data.reservations.minutes === 15, meta.data);
  const meta2 = await http('GET', '/d/v1/meta');
  check('meta: the VAPID key is stable (stored once, not regenerated)', meta2.data?.push?.publicKey === pk, meta2.data?.push);
  const app = await http('GET', '/app/');
  const csp = app.headers.get('content-security-policy') ?? '';
  check('app: map, favourites, reservations and notifications in the web app; CSP allows the tile host',
    app.status === 200 && /Peta stasiun/.test(app.text) && /favourites/.test(app.text) && /\/v1\/reservations/.test(app.text) && /pushManager/.test(app.text)
      && /img-src[^;]*https:\/\/tile\.openstreetmap\.org/.test(csp), { s: app.status, csp });
  const sw = await http('GET', '/app/sw.js');
  check('app: service worker served as JavaScript, handles push and notificationclick',
    sw.status === 200 && /javascript/.test(sw.headers.get('content-type') ?? '') && /'push'/.test(sw.text) && /notificationclick/.test(sw.text), { s: sw.status, ct: sw.headers.get('content-type') });

  // map data: the station carries coordinates
  const guest = await new Driver().init();
  const st = await until(() => guest.get('/v1/stations'), (r) => !!r.data.stations?.find((s: any) => s.siteId === siteId)?.connectors?.every((c: any) => c.status === 'Available'), 20_000, 800);
  const station = st.data.stations.find((s: any) => s.siteId === siteId);
  check('map: the station is listed with its coordinates for a marker', station?.lat === -6.2183 && station?.lon === 106.8023, { lat: station?.lat, lon: station?.lon });
  const conn1 = station.connectors.find((c: any) => c.connectorNo === 1).connectorId as string;
  const conn2 = station.connectors.find((c: any) => c.connectorNo === 2).connectorId as string;

  // ------------------------------------------------------------ favourites
  const a = await new Driver().init();
  const phoneA = `0812${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const signA = await a.signIn(phoneA);
  check('setup: driver A signs in with a phone number', signA.status === 200, signA.data);
  const f1 = await a.post('/v1/favourites', { siteId });
  const f1b = await a.post('/v1/favourites', { siteId });
  const fl = await a.get('/v1/favourites');
  check('favourites: add a station; adding it again returns the same favourite',
    f1.status === 200 && f1b.data.favourite?.id === f1.data.favourite?.id && fl.data.favourites?.length === 1 && fl.data.favourites[0].siteId === siteId, { f1: f1.data, list: fl.data });
  const bad = await a.post('/v1/favourites', { siteId: '00000000-0000-0000-0000-000000000000' });
  const badPartner = await a.post('/v1/favourites', { partnerId: '00000000-0000-0000-0000-000000000000', countryCode: 'ID', partyId: 'XXX', locationId: 'L1' });
  check('favourites: unknown station refused; a partner location needs a roaming fleet card', bad.status === 422 && badPartner.status === 422, { bad: bad.data, p: badPartner.data });
  const other = await new Driver().init();
  const flo = await other.get('/v1/favourites');
  const stealDel = await other.del(`/v1/favourites/${f1.data.favourite.id}`);
  check('favourites: private to the phone / account (another device sees none, cannot delete)', flo.data.favourites?.length === 0 && stealDel.status === 404, { list: flo.data, del: stealDel.status });
  const noTok = await http('GET', '/d/v1/favourites');
  check('favourites: need a device token (401)', noTok.status === 401, noTok.status);

  // ------------------------------------------------------------ push subscriptions
  const subA = subscription('/push/a');
  const badSub = await a.post('/v1/push/subscribe', { subscription: { endpoint: PUSH + '/push/x', keys: { p256dh: 'AAAA', auth: 'BBBB' } }, lang: 'id' });
  check('push: malformed subscription keys refused (422)', badSub.status === 422, badSub.data);
  const ftp = await a.post('/v1/push/subscribe', { subscription: { ...subA.json, endpoint: 'ftp://127.0.0.1/push' }, lang: 'id' });
  check('push: non-http(s) endpoint refused (422)', ftp.status === 422, ftp.data);
  const sa = await a.post('/v1/push/subscribe', { subscription: subA.json, lang: 'id' });
  const ps = await a.get('/v1/push');
  check('push: driver A subscribes; status reports subscribed', sa.status === 200 && ps.data.subscribed === true, { sa: sa.data, ps: ps.data });

  // ------------------------------------------------------------ reservations
  const g = await guest.post('/v1/reservations', { connectorId: conn1 });
  check('reserve: a guest (not signed in) is asked to sign in', g.status === 422 && /Masuk/.test(g.data.error), g.data);
  const detGuest0 = await guest.get(`/v1/connectors/${conn1}`);
  const detA0 = await a.get(`/v1/connectors/${conn1}`);
  check('reserve: offered to a signed-in driver, not to a guest', detA0.data.canReserve === true && detGuest0.data.canReserve === false, { a: detA0.data.canReserve, g: detGuest0.data.canReserve });

  // A suspended charger (v1.4.4) offers no reservation, and refuses one (no fee, no ReserveNow).
  const suspMark = cp.calls.length;
  await ops('POST', `/v1/charge-points/${ID}/suspend`, { reason: 'E2E: suspended' });
  try {
    const sDet = await a.get(`/v1/connectors/${conn1}`);
    const sRes = await a.post('/v1/reservations', { connectorId: conn1 });
    check('reserve: not offered on a suspended charger, and refused (no ReserveNow sent)',
      sDet.data.canReserve === false && sRes.status === 422 && !cp.calls.slice(suspMark).some((c: any) => c.action === 'ReserveNow'), { can: sDet.data.canReserve, res: sRes.data });
  } finally {
    await ops('POST', `/v1/charge-points/${ID}/resume`);
  }
  await until(() => a.get(`/v1/connectors/${conn1}`), (r) => r.data.canReserve === true, 15_000);

  let mark = cp.calls.length;
  const r1 = await a.post('/v1/reservations', { connectorId: conn1 });
  const rn1 = await cp.waitNew('ReserveNow', mark);
  check('reserve: accepted; the charger received ReserveNow for connector 1 with a reservation id and expiry',
    r1.status === 200 && r1.data.reservation?.state === 'active' && rn1?.payload?.connectorId === 1 && Number.isInteger(rn1.payload.reservationId)
      && Math.abs(new Date(rn1.payload.expiryDate).getTime() - Date.now() - 15 * 60_000) < 60_000 && /^PS-/.test(rn1.payload.idTag), { r: r1.data, p: rn1?.payload });
  const heldTag = rn1!.payload.idTag as string;
  const heldId = rn1!.payload.reservationId as number;
  await cp.status(1, 'Reserved');   // what a real charger reports
  const cur = await a.get('/v1/reservation');
  check('reserve: current reservation with a ~15 minute countdown', cur.data.reservation?.id === r1.data.reservation.id && cur.data.reservation.minutesLeft >= 14, cur.data);
  const detA = await until(() => a.get(`/v1/connectors/${conn1}`), (r) => !!r.data.reservedForYou, 5_000);
  const detO = await until(() => other.get(`/v1/connectors/${conn1}`), (r) => r.data.status === 'Reserved', 5_000);
  check('reserve: holder sees "reserved for you" and can charge; others see Reserved, blocked',
    detA.data.reservedForYou?.id === r1.data.reservation.id && detA.data.available === true && detO.data.status === 'Reserved' && detO.data.available === false, { a: detA.data, o: { s: detO.data.status, av: detO.data.available, why: detO.data.blockedReason } });
  const steal = await other.post('/v1/charge/prepaid', { connectorId: conn1, amountIdr: 50000 });
  check('reserve: another driver cannot pay for the reserved connector (422)', steal.status === 422 && /dipesan/.test(steal.data.error), steal.data);
  const two = await a.post('/v1/reservations', { connectorId: conn2 });
  check('reserve: one live reservation per driver', two.status === 422 && /sudah punya reservasi/.test(two.data.error), two.data);
  const b = await new Driver().init();
  await b.signIn(`0813${Math.floor(10_000_000 + Math.random() * 89_999_999)}`);
  const clash = await b.post('/v1/reservations', { connectorId: conn1 });
  check('reserve: a connector already reserved cannot be reserved again', clash.status === 422, clash.data);

  mark = cp.calls.length;
  const cx = await a.post(`/v1/reservations/${r1.data.reservation.id}/cancel`);
  const cr = await cp.waitNew('CancelReservation', mark);
  check('cancel: the charger receives CancelReservation with the same reservation id', cx.status === 200 && cr?.payload?.reservationId === heldId, { cx: cx.data, p: cr?.payload });
  await cp.status(1, 'Available');
  const after = await a.get('/v1/reservation');
  const detO2 = await until(() => other.get(`/v1/connectors/${conn1}`), (r) => r.data.status === 'Available', 5_000);
  check('cancel: no live reservation; the connector is free for everyone again', after.data.reservation === null && detO2.data.available === true, { after: after.data, o: detO2.data.status });
  const cx2 = await other.post(`/v1/reservations/${r1.data.reservation.id}/cancel`);
  check('cancel: another device cannot cancel someone\'s reservation (404)', cx2.status === 404, cx2.data);

  // A charger that refuses
  cp.handlers.ReserveNow = (p) => (p.connectorId === 2 ? { status: 'Occupied' } : { status: 'Accepted' });
  const occ = await a.post('/v1/reservations', { connectorId: conn2 });
  check('reserve: charger answers Occupied → refused with the reason, nothing held', occ.status === 422 && /dipakai/.test(occ.data.error) && (await a.get('/v1/reservation')).data.reservation === null, occ.data);
  delete cp.handlers.ReserveNow;

  // ------------------------------------------------------------ reserve → pay → charge with the held idTag; push on the way
  mark = cp.calls.length;
  const r2 = await a.post('/v1/reservations', { connectorId: conn1 });
  const rn2 = await cp.waitNew('ReserveNow', mark);
  await cp.status(1, 'Reserved');
  const co = await a.post('/v1/charge/prepaid', { connectorId: conn1, amountIdr: 50000 });
  check('reserved charge: the holder pays; the claim token IS the idTag the charger holds',
    r2.status === 200 && co.status === 200 && co.data.startToken === rn2?.payload?.idTag, { r2: r2.data, co: co.data?.startToken, held: rn2?.payload?.idTag });
  await a.post(`/v1/charge/${co.data.chargeId}/confirm-payment`);
  cp.handlers.RemoteStartTransaction = () => ({ status: 'Accepted' });
  mark = cp.calls.length;
  const t0 = Date.now();
  const start = await a.post(`/v1/charge/${co.data.chargeId}/start`);
  const rst = await cp.waitNew('RemoteStartTransaction', mark);
  check('reserved charge: remote start on a Reserved connector, with the held idTag', start.status === 200 && rst?.payload?.idTag === rn2?.payload?.idTag && rst.payload.connectorId === 1, { s: start.data, p: rst?.payload });
  const stx = await cp.call('StartTransaction', { connectorId: 1, idTag: rst!.payload.idTag, meterStart: 0, timestamp: new Date().toISOString(), reservationId: rn2!.payload.reservationId });
  await cp.status(1, 'Charging');
  check('reserved charge: the charger\'s StartTransaction (with reservationId) is accepted', stx?.idTagInfo?.status === 'Accepted' && stx.transactionId > 0, stx);
  const used = await until(() => a.get('/v1/reservation'), (r) => r.data.reservation === null, 10_000);
  check('reserved charge: the reservation is used up by the session', used.data.reservation === null, used.data);
  if (pg) {
    const row = (await pg.query(`SELECT state FROM driver_reservation WHERE id = $1`, [r2.data.reservation.id])).rows[0];
    check('reserved charge: stored as used (not cancelled / expired)', row?.state === 'used', row);
  }

  const pStart = await until(async () => pushesTo('/push/a', t0), (l) => l.length >= 1, 20_000);
  const m1 = pStart[0];
  let msg1: any = null; try { msg1 = m1 && decrypt(m1.body, subA); } catch (e) { msg1 = { error: (e as Error).message }; }
  check('push: "charging started" delivered to A\'s push service, decrypted with A\'s keys (RFC 8291)',
    msg1?.title === 'Pengisian dimulai' && msg1.url === `/app/#s/${co.data.chargeId}` && /Senayan/.test(msg1.body), msg1);
  const v1 = m1 ? vapidOk(m1.headers.authorization as string, PUSH, pk) : { ok: false, why: 'no push' };
  check('push: VAPID JWT for the push service origin, signed with the published key (RFC 8292)', v1.ok, v1);
  check('push: aes128gcm body, TTL and urgency headers', m1?.headers['content-encoding'] === 'aes128gcm' && Number(m1.headers.ttl) > 0 && m1.headers.urgency === 'normal', m1?.headers);

  // language: the same phone switches to English
  await a.post('/v1/push/subscribe', { subscription: subA.json, lang: 'en' });
  const t1 = Date.now();
  await cp.call('MeterValues', { connectorId: 1, transactionId: stx.transactionId, meterValue: [{ timestamp: new Date().toISOString(), sampledValue: [{ value: '2500', measurand: 'Energy.Active.Import.Register', unit: 'Wh' }] }] });
  await cp.call('StopTransaction', { transactionId: stx.transactionId, meterStop: 2500, timestamp: new Date().toISOString(), idTag: rst!.payload.idTag, reason: 'Local' });
  await cp.status(1, 'Available');
  const pEnd = await until(async () => pushesTo('/push/a', t1), (l) => l.length >= 2, 30_000);
  const msgs = pEnd.map((r) => { try { return decrypt(r.body, subA); } catch { return null; } });
  const ended = msgs.find((m) => m?.title === 'Charging finished');
  const receipt = msgs.find((m) => m?.title === 'Receipt ready');
  check('push: "charging finished" (2.5 kWh) and "receipt ready" in English after the language switch',
    !!ended && /2\.5 kWh/.test(ended.body) && !!receipt && /Rp/.test(receipt.body) && receipt.url === `/app/#s/${co.data.chargeId}`, msgs);
  await sleep(4000);
  const dupes = pushesTo('/push/a', t0).map((r) => { try { return decrypt(r.body, subA).title; } catch { return '?'; } });
  check('push: each event sent once (no duplicates)', new Set(dupes).size === dupes.length, dupes);

  // ------------------------------------------------------------ reminder, expiry, a dead subscription
  const subB = subscription('/push/b');
  await b.post('/v1/push/subscribe', { subscription: subB.json, lang: 'id' });
  mark = cp.calls.length;
  const rb = await b.post('/v1/reservations', { connectorId: conn2 });
  check('expiry: driver B reserves connector 2', rb.status === 200 && !!(await cp.waitNew('ReserveNow', mark)), rb.data);
  if (pg) {
    const t2 = Date.now();
    await pg.query(`UPDATE driver_reservation SET expires_at = now() + interval '4 minutes' WHERE id = $1`, [rb.data.reservation.id]);
    const rem = await until(async () => pushesTo('/push/b', t2), (l) => l.length >= 1, 40_000, 1000);
    let rm1: any = null; try { rm1 = rem[0] && decrypt(rem[0].body, subB); } catch (e) { rm1 = { error: (e as Error).message }; }
    check('expiry: 5-minute reminder pushed (urgency high)', rm1?.title === 'Reservasi berakhir dalam 5 menit' && rem[0]?.headers.urgency === 'high', { rm1, h: rem[0]?.headers.urgency });
    // The phone's browser dropped the subscription: the push service answers 410 Gone.
    replyWith.set('/push/b', 410);
    const t3 = Date.now();
    await pg.query(`UPDATE driver_reservation SET expires_at = now() - interval '1 second' WHERE id = $1`, [rb.data.reservation.id]);
    const exp = await until(async () => (await pg.query(`SELECT state FROM driver_reservation WHERE id = $1`, [rb.data.reservation.id])).rows[0], (r) => r?.state === 'expired', 40_000, 1000);
    const gone = await until(async () => pushesTo('/push/b', t3), (l) => l.length >= 1, 20_000);
    let ex1: any = null; try { ex1 = gone[0] && decrypt(gone[0].body, subB); } catch {}
    check('expiry: lapsed reservation closed as expired, "reservation ended" pushed', exp?.state === 'expired' && ex1?.title === 'Reservasi berakhir', { exp, ex1 });
    const psB = await until(() => b.get('/v1/push'), (r) => r.data.subscribed === false, 10_000);
    check('push: a 410 Gone from the push service removes the dead subscription', psB.data.subscribed === false, psB.data);
    const tok = (await pg.query(`SELECT t.status FROM driver_reservation r JOIN token t ON t.id = r.token_id WHERE r.id = $1`, [rb.data.reservation.id])).rows[0];
    check('expiry: the unpaid claim token minted for the reservation is retired', tok?.status === 'Expired', tok);
    const detB = await b.get(`/v1/connectors/${conn2}`);
    check('expiry: connector free again for others', detB.data.reservedForYou === null && detB.data.status === 'Available', detB.data);
  } else {
    console.log('SKIP  reminder / expiry / 410 (set E2E_DATABASE_URL to age a reservation)');
    await b.post(`/v1/reservations/${rb.data.reservation.id}/cancel`);
  }

  // ------------------------------------------------------------ favourites follow the account
  // (Late in the run so the same number is past the OTP resend window.)
  const a2 = await new Driver().init();
  await a2.signIn(phoneA);
  const fl2 = await a2.get('/v1/favourites');
  check('favourites: follow the account to a new phone', fl2.data.favourites?.some((f: any) => f.siteId === siteId), fl2.data);
  const rm = await a2.del(`/v1/favourites/${fl2.data.favourites?.[0]?.id}`);
  const flA = await a.get('/v1/favourites');
  check('favourites: removed on one phone → gone on the other', rm.status === 200 && flA.data.favourites?.length === 0, flA.data);

  // ------------------------------------------------------------ unsubscribe
  const un = await a.post('/v1/push/unsubscribe', { endpoint: subA.json.endpoint });
  const psA = await a.get('/v1/push');
  check('push: unsubscribe', un.status === 200 && psA.data.subscribed === false, psA.data);
} catch (e) {
  check('unexpected error', false, (e as Error).stack ?? String(e));
} finally {
  for (const r of raws) r.close();
  pushServer.close();
  if (pg) await pg.end().catch(() => {});
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}
