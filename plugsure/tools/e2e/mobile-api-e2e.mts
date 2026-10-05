// PlugSure v1.9 — the driver API for the PlugSure Hub mobile app (docs/MOBILE-APP-SPEC.md §14 G1–G8, §15), end to end
// against the REAL split deployment (API + gateway, runtime role), with stand-ins for Google (OAuth token endpoint +
// FCM HTTP v1) and Apple (APNs, HTTP/2) where the stack is told they are (FCM_URL, APNS_URL_PRODUCTION / _DEVELOPMENT).
//
//   G1  the network brand (X-Driver-Brand: plugsure, PlugSure Mobility): every operator's stations, APNs and Live
//       Activities for sessions at any operator, partner networks through PlugSure Mobility
//   G2  Android push: console upload of the Firebase service account (checked), token registration, delivery through
//       FCM HTTP v1 with an OAuth token from a signed JWT, the right channel and routing data, UNREGISTERED → dropped
//   G3  live sessions: Android (FCM data messages) for a hosted session at another operator and for a partner-network
//       charge; iOS content version 2 (costs with currency)
//   G4  account deletion: blocked while charging, then deleted (device revoked); the web form and its script
//   G5  partner locations of a hosted operator are not listed twice
//   G6  app-site association / assetlinks on the link domain, /c/<code> and other web fallbacks, the link resolver
//   G7  /d/v1/stations paging and viewport, /d/v1/map clusters, filters, ETag
//   G8  /d/v1/app/config: version gate, maintenance, features from the console
// Plus: the unbranded web app's /d/v1/stations answer keeps its v1.8 shape.
//
// Needs E2E_DATABASE_URL (runtime role), the seeded PlugSure Mobility organisation (mobility@plugsure.com, the seed
// password E2E_PASSWORD) and FCM_URL / APNS_URL_* pointing at local ports.
//     npx tsx tools/e2e/mobile-api-e2e.mts
// NEVER point this at production.
import { createServer as createHttp, request as httpRequest } from 'node:http';
import { createServer as createH2 } from 'node:http2';
import { generateKeyPairSync, verify, randomUUID } from 'node:crypto';
import pg from 'pg';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const results: boolean[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 900)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 20_000, every = 300): Promise<T> {
  const t0 = Date.now(); let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) { await sleep(every); v = await fn(); }
  return v;
}
const RUN = Date.now().toString().slice(-6);
const portOf = (u: string | undefined, d: number) => { try { return Number(new URL(u!).port) || d; } catch { return d; } };
const FCM_PORT = portOf(process.env.FCM_URL, 9298);
const APNS_PORTS = [portOf(process.env.APNS_URL_PRODUCTION, 9296), portOf(process.env.APNS_URL_DEVELOPMENT, 9297)];

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, data, text, headers: res.headers };
}
/** A request with another Host header (fetch does not allow setting it). */
function withHost(path: string, host: string): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  const u = new URL(API + path);
  return new Promise((res, rej) => {
    const r = httpRequest({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { host } }, (resp) => {
      const chunks: Buffer[] = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => res({ status: resp.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: resp.headers }));
    });
    r.on('error', rej); r.end();
  });
}
let cookie = '';
async function ops(method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d };
}
const NET = { 'x-driver-brand': 'plugsure' };
class Driver {
  token = '';
  id = '';
  constructor(public brand: Record<string, string> = NET) {}
  async init() { const r = await http('POST', '/d/v1/device'); this.token = r.data.deviceToken; this.id = r.data.deviceId; return this; }
  h(extra: Record<string, string> = {}) { return { ...this.brand, authorization: `Bearer ${this.token}`, ...extra }; }
  get = (p: string, extra: Record<string, string> = {}) => http('GET', '/d' + p, undefined, this.h(extra));
  post = (p: string, b: unknown = {}, extra: Record<string, string> = {}) => http('POST', '/d' + p, b, this.h(extra));
  async signIn(phone: string) {
    const s = await until(() => this.post('/v1/otp/send', { phone }), (r) => r.status === 200, 90_000, 5000);
    return this.post('/v1/otp/verify', { phone, code: s.data.devCode });
  }
}

// ─────────────────────────────────────────── stand-in for Google: OAuth token endpoint + FCM HTTP v1
const saKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = {
  type: 'service_account', project_id: `plugsure-e2e-${RUN}`, private_key_id: `k${RUN}`,
  private_key: saKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  client_email: `fcm-${RUN}@plugsure-e2e.iam.gserviceaccount.com`, token_uri: `http://127.0.0.1:${FCM_PORT}/token`,
};
type FcmHit = { auth: string | undefined; message: any; validateOnly: boolean; at: number };
const fcmHits: FcmHit[] = [];
const tokenExchanges: Array<{ ok: boolean; claims: any }> = [];
const fcmGone = new Set<string>();
const fcmServer = createHttp((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    res.setHeader('content-type', 'application/json');
    if (req.url === '/token') {
      const assertion = new URLSearchParams(body).get('assertion') ?? '';
      const [h, p, s] = assertion.split('.');
      const ok = !!s && verify('sha256', Buffer.from(`${h}.${p}`), saKey.publicKey, Buffer.from(s, 'base64url'));
      const claims = p ? JSON.parse(Buffer.from(p, 'base64url').toString()) : null;
      tokenExchanges.push({ ok, claims });
      res.statusCode = ok ? 200 : 400;
      res.end(JSON.stringify(ok ? { access_token: `ya29.e2e-${RUN}`, expires_in: 3599, token_type: 'Bearer' } : { error: 'invalid_grant' }));
      return;
    }
    if (req.url !== `/v1/projects/${SA.project_id}/messages:send`) { res.statusCode = 404; res.end(JSON.stringify({ error: { status: 'NOT_FOUND', message: 'no such project' } })); return; }
    if (req.headers.authorization !== `Bearer ya29.e2e-${RUN}`) { res.statusCode = 401; res.end(JSON.stringify({ error: { status: 'UNAUTHENTICATED', details: [{ errorCode: 'THIRD_PARTY_AUTH_ERROR' }] } })); return; }
    const b = JSON.parse(body);
    fcmHits.push({ auth: req.headers.authorization, message: b.message, validateOnly: b.validate_only === true, at: Date.now() });
    const t = b.message?.token as string;
    if (b.validate_only || t === 'plugsure-credentials-check') { res.statusCode = 400; res.end(JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: 'The registration token is not a valid FCM registration token' } })); return; }
    if (fcmGone.has(t)) { res.statusCode = 404; res.end(JSON.stringify({ error: { status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ errorCode: 'UNREGISTERED' }] } })); return; }
    res.statusCode = 200; res.end(JSON.stringify({ name: `projects/${SA.project_id}/messages/0:${fcmHits.length}` }));
  });
});
const fcmFor = (token: string) => fcmHits.filter((h) => h.message?.token === token && !h.validateOnly);

// ─────────────────────────────────────────── stand-in for APNs (HTTP/2, provider token checked)
const apnsKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const P8 = apnsKey.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const KEY_ID = 'M' + RUN.padStart(9, '0');
type ApnsHit = { token: string; headers: Record<string, unknown>; body: any; status: number };
const apnsHits: ApnsHit[] = [];
const apnsKnown = new Set<string>();
const apnsFake = (port: number) => new Promise<ReturnType<typeof createH2>>((res, rej) => {
  const server = createH2((req, reply) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const token = String(req.headers[':path']).split('/').pop()!;
      const [h, p, s] = String(req.headers.authorization ?? '').replace(/^bearer /, '').split('.');
      const ok = !!s && verify('sha256', Buffer.from(`${h}.${p}`), { key: apnsKey.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
      const answer = (status: number, reason?: string) => {
        if (port === APNS_PORTS[0]) apnsHits.push({ token, headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null, status });
        reply.writeHead(status, { 'apns-id': `m-${apnsHits.length}` }); reply.end(reason ? JSON.stringify({ reason }) : '');
      };
      if (!ok) return answer(403, 'InvalidProviderToken');
      if (!apnsKnown.has(token)) return answer(400, 'BadDeviceToken');
      answer(200);
    });
  });
  server.once('error', rej);
  server.listen(port, '127.0.0.1', () => res(server));
});

const db = process.env.E2E_DATABASE_URL ? new pg.Client({ connectionString: process.env.E2E_DATABASE_URL }) : null;
const servers: Array<{ close: () => void }> = [];
const cleanup: Array<() => Promise<unknown>> = [];
/** Undo steps, run in the order given (groups run last-registered first). */
const later = (...fns: Array<() => Promise<unknown>>) => cleanup.push(async () => { for (const f of fns) await f().catch((e) => console.log('cleanup:', (e as Error).message)); });
let mobilityOrg = '';
try {
  if (!db) throw new Error('set E2E_DATABASE_URL (the runtime role)');
  await db.connect();
  await new Promise<void>((r) => fcmServer.listen(FCM_PORT, '127.0.0.1', () => r()));
  servers.push(fcmServer, await apnsFake(APNS_PORTS[0]!), await apnsFake(APNS_PORTS[1]!));

  // ─────────────────────────────────────────── setup: the PlugSure Mobility console
  const login = await ops('POST', '/v1/auth/login', { email: 'mobility@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  check('setup: the PlugSure Mobility administrator signs in', login.status === 200, login.data);
  const app0 = await ops('GET', '/v1/driver-app');
  mobilityOrg = app0.data.brand?.orgId;
  check('G1: PlugSure Mobility owns the network brand (slug plugsure, scope network)',
    app0.status === 200 && app0.data.brand?.slug === 'plugsure' && app0.data.brand.scope === 'network', app0.data.brand);
  const before = { status: app0.data.brand.status, appConfig: app0.data.brand.appConfig };
  const nus = (await db.query(`SELECT id FROM organisation WHERE slug = 'nusantara-charge'`)).rows[0].id as string;

  // ─────────────────────────────────────────── G8 + console: app configuration
  const badCfg = await ops('PUT', '/v1/driver-app/app-config', { android: { minSupported: 'one' }, features: { teleport: true } });
  const cfg = await ops('PUT', '/v1/driver-app/app-config', {
    android: { minSupported: '1.0.0', latest: '1.2.0' }, ios: { minSupported: '1.0.0', latest: '1.2.0', storeUrl: 'https://apps.apple.com/app/id0000000001' },
    maintenance: { active: false }, features: { routePlanner: true },
  });
  check('console: the app configuration is validated (422 with fields) and saved',
    badCfg.status === 422 && !!badCfg.data.fields?.['android.minSupported'] && !!badCfg.data.fields?.['features.teleport'] && cfg.status === 200 && cfg.data.appConfig.android.latest === '1.2.0',
    { badCfg: badCfg.data, cfg: cfg.data });
  const old = await http('GET', '/d/v1/app/config?platform=android&version=0.9.0&build=7', undefined, NET);
  const mid = await http('GET', '/d/v1/app/config?platform=android&version=1.1.0', undefined, NET);
  const cur = await http('GET', '/d/v1/app/config?platform=ios&version=1.2.0', undefined, NET);
  const badP = await http('GET', '/d/v1/app/config?platform=windows', undefined, NET);
  const none = await http('GET', '/d/v1/app/config?platform=ios&version=0.0.1');
  check('G8: version gate — forced below the minimum, soft update below the latest, current is clean; features and links from the console',
    old.status === 200 && old.data.force === true && old.data.softUpdate === true && old.data.storeUrl === 'https://play.google.com/store/apps/details?id=asia.plugsure.app'
      && mid.data.force === false && mid.data.softUpdate === true && cur.data.force === false && cur.data.softUpdate === false
      && old.data.features.routePlanner === true && old.data.brand?.scope === 'network' && /\/account\/delete$/.test(old.data.links.accountDeletion)
      && old.data.links.privacy === 'https://plugsure.test/privacy' && badP.status === 400 && none.data.brand === null && none.data.force === false,
    { old: old.data, mid: mid.data, cur: cur.data, badP: badP.status, none: none.data });
  await ops('PUT', '/v1/driver-app/app-config', { ...cfg.data.appConfig, maintenance: { active: true, messageId: 'Sedang perawatan', messageEn: 'Down for maintenance' } });
  const maint = await http('GET', '/d/v1/app/config?platform=ios&version=1.2.0', undefined, { ...NET, 'x-driver-lang': 'en' });
  check('G8: maintenance switched on in the console reaches the app, in its language', maint.data.maintenance?.active === true && maint.data.maintenance.message === 'Down for maintenance', maint.data);
  await ops('PUT', '/v1/driver-app/app-config', cfg.data.appConfig);

  // ─────────────────────────────────────────── G7: stations and the map
  const legacy = await http('GET', '/d/v1/stations?lat=-6.2246&lon=106.9998');
  const netSt = await http('GET', '/d/v1/stations?lat=-6.2246&lon=106.9998', undefined, NET);
  const ids = (r: any) => (r.data.stations ?? []).map((s: any) => s.siteId).sort();
  const located = (legacy.data.stations ?? []).filter((s: any) => s.distanceKm != null);
  check('unchanged: the web app\'s /d/v1/stations answer keeps its shape (stations only, every station, distances when a location is given)',
    legacy.status === 200 && Object.keys(legacy.data).join() === 'stations' && legacy.data.stations.length >= 1 && located.length >= 1
      && legacy.data.stations.every((s: any) => 'siteId' in s && 'connectors' in s && 'priceFromMinor' in s && 'pricesIncludeTax' in s),
    legacy.data);
  check('G1: the network brand sees every operator\'s stations (not limited like an operator\'s own app)', JSON.stringify(ids(netSt)) === JSON.stringify(ids(legacy)), { net: ids(netSt), legacy: ids(legacy) });
  const p1 = await http('GET', '/d/v1/stations?near=-6.2246,106.9998&limit=1', undefined, NET);
  const p2 = p1.data.nextCursor ? await http('GET', `/d/v1/stations?near=-6.2246,106.9998&limit=1&cursor=${p1.data.nextCursor}`, undefined, NET) : null;
  const badCur = await http('GET', `/d/v1/stations?limit=1&cursor=${p1.data.nextCursor ?? 'x'}`, undefined, NET);
  const badBox = await http('GET', '/d/v1/stations?bbox=1,2,3', undefined, NET);
  const box = await http('GET', '/d/v1/stations?bbox=106.9,-6.3,107.1,-6.1', undefined, NET);
  check('G7: /d/v1/stations pages (limit, cursor tied to its query), and takes a viewport',
    p1.status === 200 && p1.data.stations.length === 1 && p1.data.total === legacy.data.stations.length && (p1.data.total === 1 || (!!p2 && p2.status === 200 && p2.data.stations[0]?.siteId !== p1.data.stations[0].siteId))
      && badCur.status === 400 && badBox.status === 400 && box.status === 200 && box.data.stations.some((s: any) => /Summarecon/.test(s.name)) && box.data.stations.every((s: any) => s.lat >= -6.3 && s.lat <= -6.1),
    { p1: p1.data, p2: p2?.data, badCur: badCur.status, badBox: badBox.status, box: box.data?.stations?.map((s: any) => s.name) });

  // ─────────────────────────────────────────── G5: a hosted operator's locations through the hub are listed once
  const nusParty = (await db.query(`SELECT country_code, party_id FROM ocpi_party WHERE org_id = $1 ORDER BY is_home DESC LIMIT 1`, [nus])).rows[0]
    ?? (await db.query(`INSERT INTO ocpi_party (org_id, country_code, party_id, business_name, is_home) VALUES ($1,'ID','N${RUN.slice(-2)}','Nusantara', true) RETURNING country_code, party_id`, [nus])
      .then((r) => { later(() => db.query(`DELETE FROM ocpi_party WHERE org_id = $1 AND party_id = $2`, [nus, r.rows[0].party_id])); return r.rows[0]; }));
  const partnerId = (await db.query(`INSERT INTO ocpi_partner (org_id, name, kind, state) VALUES ($1, $2, 'hub', 'connected') RETURNING id`, [mobilityOrg, `Hub e2e ${RUN}`])).rows[0].id as string;
  later(() => db.query(`DELETE FROM ocpi_remote_session WHERE partner_id = $1`, [partnerId]), () => db.query(`DELETE FROM ocpi_remote_location WHERE partner_id = $1`, [partnerId]),
    () => db.query(`DELETE FROM ocpi_partner WHERE id = $1`, [partnerId]));
  const EXT = 'X' + RUN.slice(-2);
  const loc = (id: string, cc: string, pid: string, name: string, lat: string, lon: string) => ({
    id, name, country_code: cc, party_id: pid, publish: true, address: 'Jl. Contoh 1', city: 'Jakarta', coordinates: { latitude: lat, longitude: lon }, operator: { name },
    evses: [{ uid: `${id}-E1`, evse_id: `${cc}*${pid}*E${id}`, status: 'AVAILABLE', connectors: [{ id: '1', standard: 'IEC_62196_T2_COMBO', power_type: 'DC', max_electric_power: 120000, tariff_ids: [] }] }],
  });
  await db.query(`INSERT INTO ocpi_remote_location (org_id, partner_id, country_code, party_id, location_id, data, last_updated) VALUES
      ($1,$2,$3,$4,'HOSTED${RUN}',$5, now()), ($1,$2,'ID',$6,'EXT${RUN}',$7, now()), ($1,$2,'MY',$6,'KL${RUN}',$8, now())`,
    [mobilityOrg, partnerId, nusParty.country_code, nusParty.party_id, JSON.stringify(loc(`HOSTED${RUN}`, nusParty.country_code, nusParty.party_id, 'Nusantara via hub', '-6.2246', '106.9998')),
      EXT, JSON.stringify(loc(`EXT${RUN}`, 'ID', EXT, `External CPO ${RUN}`, '-6.2000', '106.9500')), JSON.stringify(loc(`KL${RUN}`, 'MY', EXT, `KL partner ${RUN}`, '3.1300', '101.6800'))]);

  const map1 = await http('GET', '/d/v1/map?bbox=106.8,-6.4,107.1,-6.1&zoom=13&cluster=0', undefined, NET);
  const partnerIds = (r: any) => (r.data.stations ?? []).filter((s: any) => s.kind === 'partner').map((s: any) => s.partner.locationId);
  check('G5 + G7: the map merges hosted and partner stations; the hosted operator\'s own location through the hub is shown once (as hosted); guests see partners, not startable (sign_in)',
    map1.status === 200 && map1.data.clusters.length === 0 && map1.data.stations.some((s: any) => s.kind === 'hosted' && s.path === 'direct')
      && JSON.stringify(partnerIds(map1)) === JSON.stringify([`EXT${RUN}`])
      && map1.data.stations.find((s: any) => s.kind === 'partner')?.reasonCode === 'sign_in' && map1.data.stations.find((s: any) => s.kind === 'partner')?.path === 'roaming',
    map1.data);
  const etag = map1.headers.get('etag') ?? '';
  const again = await http('GET', '/d/v1/map?bbox=106.8,-6.4,107.1,-6.1&zoom=13&cluster=0', undefined, { ...NET, 'if-none-match': etag });
  const onlyPartner = await http('GET', '/d/v1/map?bbox=106.8,-6.4,107.1,-6.1&zoom=13&cluster=0&network=partner', undefined, NET);
  const dcOnly = await http('GET', '/d/v1/map?bbox=95,-11,141,6&zoom=5&cluster=0&dc=1', undefined, NET);
  const wide = await http('GET', '/d/v1/map?bbox=95,-11,141,7&zoom=3', undefined, NET);
  const inClusters = (wide.data.clusters ?? []).reduce((n: number, c: any) => n + c.count, 0);
  const badMap = await http('GET', '/d/v1/map?zoom=3', undefined, NET);
  const tooBig = await http('GET', '/d/v1/map?bbox=95,-11,141,7&zoom=16', undefined, NET);
  check('G7: ETag → 304; filters (network, DC); at a low zoom stations are clustered (counts add up to the total), each cluster with its bounds and expansion zoom',
    !!etag && again.status === 304 && onlyPartner.data.stations.every((s: any) => s.kind === 'partner') && dcOnly.data.stations.every((s: any) => s.dc === true)
      && wide.status === 200 && wide.data.clusters.length >= 1 && inClusters + wide.data.unclustered === wide.data.total
      && wide.data.clusters.every((c: any) => c.count >= 2 && c.expansionZoom > 3 && c.bbox.length === 4) && badMap.status === 400
      && tooBig.status === 400 && tooBig.data.code === 'bbox_too_large' && tooBig.data.maxSpanDeg < 0.1,
    { again: again.status, wide: wide.data, badMap: badMap.status, tooBig: tooBig.data });
  const pageA = await http('GET', '/d/v1/map?bbox=95,-11,141,7&zoom=5&cluster=0&limit=1&near=-6.2246,106.9998', undefined, NET);
  const pageB = pageA.data.nextCursor ? await http('GET', `/d/v1/map?bbox=95,-11,141,7&zoom=5&cluster=0&limit=1&near=-6.2246,106.9998&cursor=${pageA.data.nextCursor}`, undefined, NET) : null;
  check('G7: the map pages its stations nearest first', pageA.data.stations.length === 1 && !!pageB && pageB.data.stations[0]?.id !== pageA.data.stations[0]?.id
    && pageB.data.stations[0].distanceKm >= pageA.data.stations[0].distanceKm, { a: pageA.data.stations, b: pageB?.data?.stations });

  // ─────────────────────────────────────────── G6: links
  const r1 = await http('GET', `/d/v1/links/resolve?url=${encodeURIComponent('https://go.plugsure.test/c/AUTEL-DC60-SMB-002:1')}`, undefined, NET);
  const r2 = await http('GET', `/d/v1/links/resolve?url=${encodeURIComponent(`ID*${EXT}*EEXT${RUN}`)}`, undefined, NET);
  const r3 = await http('GET', `/d/v1/links/resolve?url=${encodeURIComponent('https://go.plugsure.test/r/partner/11111111-2222-4333-8444-555555555555')}`, undefined, NET);
  const r4 = await http('GET', '/d/v1/links/resolve?url=NO-SUCH-CHARGER-XYZ', undefined, NET);
  check('G6: the resolver — a hosted charger\'s QR (direct), a partner EVSE id (roaming), a receipt link; unknown is 404',
    r1.status === 200 && r1.data.kind === 'connector' && r1.data.path === 'direct' && r1.data.connector?.ocppIdentity === 'AUTEL-DC60-SMB-002'
      && r2.status === 200 && r2.data.kind === 'partner_evse' && r2.data.partner?.locationId === `EXT${RUN}` && r2.data.partner.evseUid === `EXT${RUN}-E1`
      && r3.data.kind === 'partner_receipt' && r4.status === 404,
    { r1: r1.data, r2: r2.data, r3: r3.data, r4: r4.status });
  const c1 = await http('GET', '/c/AUTEL-DC60-SMB-002:1');
  const c2 = await http('GET', '/r/charge/11111111-2222-4333-8444-555555555555');
  const c3 = await http('GET', '/paid?for=charge');
  check('G6: web fallbacks when the app is not installed: /c/<code>, /r/…, /paid go to the web app',
    c1.status === 302 && c1.headers.get('location') === '/app/#c/AUTEL-DC60-SMB-002%3A1' && c2.headers.get('location') === '/app/#r/11111111-2222-4333-8444-555555555555'
      && c3.headers.get('location') === '/app/paid.html?for=charge',
    { c1: [c1.status, c1.headers.get('location')], c2: c2.headers.get('location'), c3: c3.headers.get('location') });
  // ─────────────────────────────────────────── G11: the payment return to the app (its own scheme only, via an https bounce)
  const stAll = await http('GET', '/d/v1/stations', undefined, NET);
  const ac = stAll.data.stations?.flatMap((x: any) => x.connectors).find((c: any) => c.ocppIdentity === 'AUTEL-AC22-SMB-001')?.connectorId;
  const P = await new Driver().init();
  const payApp = await P.post('/v1/charge/prepaid', { connectorId: ac, amountMinor: 50_000, method: 'CARD', returnUrl: 'plugsure://paid' });
  const back = new URL(payApp.data?.payment?.checkoutUrl ?? '/', API).searchParams.get('return') ?? '';
  const bounce = await http('GET', '/paid?for=charge&app=plugsure&status=settlement');
  const unknownApp = await http('GET', '/paid?for=charge&app=no-such-brand&status=x');
  check('G11: the app\'s own return (plugsure://paid) reaches the acquirer as this server\'s https bounce, which redirects to plugsure://paid with the result; an unknown app gets the web page',
    payApp.status === 200 && /^https?:\/\/[^/]+\/paid\?for=charge&app=plugsure$/.test(back)
      && bounce.status === 302 && bounce.headers.get('location') === 'plugsure://paid?for=charge&status=settlement'
      && unknownApp.headers.get('location') === '/app/paid.html?for=charge&app=no-such-brand&status=x',
    { pay: payApp.data, back, bounce: bounce.headers.get('location'), unknownApp: unknownApp.headers.get('location') });

  // The link domain serves the association files once the network brand is live (an icon and the domain are required).
  await db.query(`UPDATE driver_app_brand SET icon_png = COALESCE(icon_png, '\\x89504e47'::bytea), status = 'live' WHERE org_id = $1`, [mobilityOrg]);
  later(() => db.query(`UPDATE driver_app_brand SET status = $2 WHERE org_id = $1`, [mobilityOrg, before.status]));
  const aasa = await withHost('/.well-known/apple-app-site-association', 'go.plugsure.test');
  const al = await withHost('/.well-known/assetlinks.json', 'go.plugsure.test');
  const aasaJ = JSON.parse(aasa.body || '{}');
  const comps = (aasaJ.applinks?.details?.[0]?.components ?? []).map((c: any) => c['/']);
  check('G6: the link domain\'s apple-app-site-association names the PlugSure app and hands it /c, /s, /r, /paid and /app; assetlinks names the Android app',
    aasa.status === 200 && aasaJ.applinks?.details?.[0]?.appIDs?.[0] === 'PSTEAM0001.asia.plugsure.app' && ['/c/*', '/s/*', '/r/*', '/paid*', '/app/*'].every((p) => comps.includes(p))
      && JSON.parse(al.body || '[]')[0]?.target?.package_name === 'asia.plugsure.app',
    { aasa: aasa.body, al: al.body });

  // ─────────────────────────────────────────── G2: Android push through FCM
  const badSa = await ops('PUT', '/v1/driver-app/fcm', { serviceAccount: { type: 'authorized_user' } });
  const sa = await ops('PUT', '/v1/driver-app/fcm', { serviceAccount: SA });
  check('G2 console: a wrong file is refused; the service account is stored and checked with Google (validate-only send, a signed JWT exchanged for a token)',
    badSa.status === 422 && sa.status === 200 && sa.data.brand?.fcmConfigured === true && sa.data.brand.fcmCheckOk === true && sa.data.brand.fcmProjectId === SA.project_id
      && !JSON.stringify(sa.data).includes('PRIVATE KEY') && tokenExchanges.some((t) => t.ok && t.claims?.scope === 'https://www.googleapis.com/auth/firebase.messaging' && t.claims.iss === SA.client_email)
      && fcmHits.some((h) => h.validateOnly),
    { badSa: badSa.data, sa: sa.data?.brand, tokenExchanges });
  const apns = await ops('PUT', '/v1/driver-app/apns', { keyId: KEY_ID, p8: P8 });
  check('G1 console: the network brand\'s APNs key is accepted (team PSTEAM0001, topic asia.plugsure.app)', apns.status === 200 && apns.data.brand?.apnsCheckOk === true, apns.data.brand);

  const phoneA = `+62813${RUN}${String(Math.floor(Math.random() * 90) + 10)}`;
  const A = await new Driver().init();
  const signedA = await A.signIn(phoneA);
  const FCM_A = `e2e${RUN}:APA91b${'A'.repeat(140)}`;
  const FCM_GONE = `e2e${RUN}:APA91b${'G'.repeat(140)}`;
  fcmGone.add(FCM_GONE);
  const noBrand = await new Driver({}).init().then((d) => { d.token = A.token; return d.post('/v1/push/fcm', { token: FCM_A }); });
  const badTok = await A.post('/v1/push/fcm', { token: 'short' });
  const subA = await A.post('/v1/push/fcm', { token: FCM_A, lang: 'en' });
  const subG = await A.post('/v1/push/fcm', { token: FCM_GONE, lang: 'en' });
  const pushState = await A.get('/v1/push');
  check('G2: the Android app registers its FCM token (a brand is required; a malformed token is refused)',
    signedA.status === 200 && noBrand.status === 409 && badTok.status === 422 && subA.status === 200 && subG.status === 200 && pushState.data.fcm === 2 && pushState.data.subscribed === true,
    { noBrand: noBrand.data, badTok: badTok.data, subA: subA.data, pushState: pushState.data });
  const subs = (await db.query(`SELECT id, endpoint FROM push_subscription WHERE device_id = $1 AND kind = 'fcm'`, [A.id])).rows as Array<{ id: string; endpoint: string }>;
  const chargeRef = randomUUID();
  for (const s of subs) {
    await db.query(`INSERT INTO push_message (subscription_id, kind, dedupe_key, payload) VALUES ($1, 'session.ended', $2, $3)`,
      [s.id, `e2e:${RUN}:${s.id}`, JSON.stringify({ title: 'Charging finished', body: '12.5 kWh at Mall', site: 'Mall', detail: '12.5 kWh charged', url: `/app/#s/${chargeRef}`, tag: `s-${RUN}`, category: 'PS_RECEIPT', actions: { receipt: `/app/#r/${chargeRef}` } })]);
  }
  const got = (await until(() => fcmFor(FCM_A), (h) => h.length >= 1, 20_000))[0]?.message;
  check('G2: a notification goes out through FCM HTTP v1 — title and body, the "charging" channel, high priority, the app\'s routing in data (type, ref, url, actions)',
    !!got && got.notification?.title === 'Charging finished' && got.notification.body === 'Mall · 12.5 kWh charged' && got.android?.notification?.channel_id === 'charging'
      && got.android.priority === 'HIGH' && got.data?.type === 'session.ended' && got.data.ref === chargeRef && JSON.parse(got.data.actions).receipt === `/app/#r/${chargeRef}`,
    got ?? 'nothing received');
  const goneLeft = await until(async () => (await db.query(`SELECT count(*)::int AS n FROM push_subscription WHERE endpoint LIKE $1`, [`%${FCM_GONE}`])).rows[0].n, (n) => n === 0, 20_000);
  check('G2: a token FCM calls UNREGISTERED is dropped', goneLeft === 0, goneLeft);

  // ─────────────────────────────────────────── G3: Android live session for a session at ANOTHER operator (cross-tenant)
  const places = (await db.query(
    `SELECT c.id AS connector, cp.id AS cp, s.id AS site FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id JOIN site s ON s.id = cp.site_id
      WHERE s.org_id = $1 AND s.archived_at IS NULL AND s.country_code = 'ID' AND NOT EXISTS (SELECT 1 FROM charging_session x WHERE x.connector_uuid = c.id AND x.state = 'active') LIMIT 2`, [nus])).rows;
  const tokenRow = async (uid: string) => (await db.query(`INSERT INTO token (org_id, kind, uid, status) VALUES ($1, 'rfid', $2, 'Accepted') RETURNING id`, [nus, uid])).rows[0].id as string;
  const hostedSession = async (i: number, device: string, appDriver: string | null) => {
    const tok = await tokenRow(`MOB${RUN}${i}`);
    const s = (await db.query(
      `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, energy_wh, token_id, state, soc_percent)
       VALUES ($1,$2,$3,$4,$5, now() - interval '90 seconds', 4000, $6, 'active', 35) RETURNING id`,
      [nus, places[i].site, places[i].connector, places[i].cp, `mob-e2e-${RUN}-${i}`, tok])).rows[0].id as string;
    const c = (await db.query(
      `INSERT INTO driver_charge (device_id, app_driver_id, org_id, connector_uuid, token_id, mode, created_at, session_id) VALUES ($1,$2,$3,$4,$5,'prepaid', now() - interval '2 minutes', $6) RETURNING id`,
      [device, appDriver, nus, places[i].connector, tok, s])).rows[0].id as string;
    later(() => db.query(`DELETE FROM live_activity_push_start WHERE session_id = $1`, [s]), () => db.query(`DELETE FROM live_activity WHERE session_id = $1 OR charge_id = $2`, [s, c]),
      () => db.query(`DELETE FROM driver_charge WHERE id = $1`, [c]), () => db.query(`DELETE FROM meter_value WHERE session_id = $1`, [s]),
      () => db.query(`DELETE FROM cdr WHERE session_id = $1`, [s]),
      () => db.query(`DELETE FROM charging_session WHERE id = $1`, [s]), () => db.query(`DELETE FROM token WHERE id = $1`, [tok]));
    return { s, c };
  };
  const H = await hostedSession(0, A.id, signedA.data.account.id);
  const LS_A = `e2e${RUN}:APA91b${'L'.repeat(140)}`;
  const opBrand = await A.post('/v1/live-sessions', { platform: 'android', ref: H.c, token: LS_A }, { 'x-driver-brand': 'no-such-brand' });
  const lsReg = await A.post('/v1/live-sessions', { platform: 'android', ref: H.c, token: LS_A });
  const ls1 = (await until(() => fcmFor(LS_A), (h) => h.length >= 1, 20_000))[0]?.message;
  check('G3: Android live session for a charge at another operator — a data-only FCM message: live_session, charging, energy, SoC as ProgressStyle progress, collapse key per charge, high priority',
    opBrand.status === 409 && lsReg.status === 200 && lsReg.data.kind === 'charge' && !!ls1 && !ls1.notification && ls1.data?.type === 'live_session' && ls1.data.event === 'update'
      && ls1.data.status === 'charging' && ls1.data.energyWh === '4000' && ls1.data.progress === '35' && ls1.data.currency === 'IDR' && ls1.data.ref === H.c
      && ls1.android?.collapse_key === `ls-${H.c}` && ls1.android.priority === 'HIGH' && JSON.parse(ls1.data.contentState).status === 'charging',
    { opBrand: opBrand.status, lsReg: lsReg.data, ls1 });

  // ─────────────────────────────────────────── G4: deletion is refused while charging
  const startDel = await until(() => A.post('/v1/account/delete/start'), (r) => r.status === 200, 90_000, 5000);
  const blocked = await A.post('/v1/account/delete', { code: startDel.data.devCode });
  check('G4: account deletion is refused (409) while a charge is in progress, with the blockers listed; nothing deleted',
    startDel.status === 200 && Array.isArray(startDel.data.deleted) && Array.isArray(startDel.data.retained) && startDel.data.blockers?.some((b: any) => b.code === 'active_session')
      && blocked.status === 409 && blocked.data.code === 'active_session' && (await A.get('/v1/me')).status === 200,
    { startDel: startDel.data, blocked: blocked.data });

  await db.query(`UPDATE charging_session SET state = 'ended', ended_at = now(), energy_wh = 9000 WHERE id = $1`, [H.s]);
  const ls2 = (await until(() => fcmFor(LS_A), (h) => h.some((x) => x.message.data?.status === 'finished'), 20_000)).find((x) => x.message.data?.status === 'finished')?.message;
  check('G3: the end of the session reaches the Android app at once (finished, high priority)', !!ls2 && ls2.data.energyWh === '9000' && ls2.android.priority === 'HIGH', ls2 ?? 'nothing');

  // ─────────────────────────────────────────── G3: a partner-network charge on Android
  const appTok = (await db.query(`INSERT INTO token (org_id, kind, uid, status, roaming_shared) VALUES ($1, 'app', $2, 'Accepted', true) RETURNING id`, [mobilityOrg, `APPE2E${RUN}`])).rows[0].id as string;
  const rc = (await db.query(
    `INSERT INTO driver_roaming_charge (org_id, device_id, token_id, partner_id, country_code, party_id, location_id, evse_uid, app_driver_id, currency)
     VALUES ($1,$2,$3,$4,'MY',$5,$6,$7,$8,'MYR') RETURNING id`,
    [mobilityOrg, A.id, appTok, partnerId, EXT, `KL${RUN}`, `KL${RUN}-E1`, signedA.data.account.id])).rows[0].id as string;
  const rs = (await db.query(
    `INSERT INTO ocpi_remote_session (org_id, partner_id, country_code, party_id, session_id, token_id, data, status, kwh, last_updated)
     VALUES ($1,$2,'MY',$3,$4,$5,$6,'ACTIVE',3.2, now()) RETURNING id`,
    [mobilityOrg, partnerId, EXT, `S${RUN}`, appTok, JSON.stringify({ id: `S${RUN}`, start_date_time: new Date(Date.now() - 300_000).toISOString(), kwh: 3.2, currency: 'MYR', location_id: `KL${RUN}`, total_cost: { excl_vat: 1.5 }, status: 'ACTIVE' })])).rows[0].id as string;
  await db.query(`UPDATE driver_roaming_charge SET remote_session_id = $2 WHERE id = $1`, [rc, rs]);
  later(() => db.query(`DELETE FROM live_activity WHERE roaming_charge_id = $1`, [rc]), () => db.query(`UPDATE driver_roaming_charge SET remote_session_id = NULL WHERE id = $1`, [rc]),
    () => db.query(`DELETE FROM ocpi_remote_session WHERE id = $1`, [rs]), () => db.query(`DELETE FROM driver_roaming_charge WHERE id = $1`, [rc]), () => db.query(`DELETE FROM token WHERE id = $1`, [appTok]));
  const LS_R = `e2e${RUN}:APA91b${'R'.repeat(140)}`;
  const rReg = await A.post('/v1/live-sessions', { platform: 'android', ref: rc, token: LS_R });
  const lr = (await until(() => fcmFor(LS_R), (h) => h.length >= 1, 20_000))[0]?.message;
  check('G3: a partner-network charge has a live session too — path roaming, the partner\'s energy and cost so far, in its currency (MYR)',
    rReg.status === 200 && rReg.data.kind === 'roaming' && !!lr && lr.data.path === 'roaming' && lr.data.energyWh === '3200' && lr.data.currency === 'MYR' && lr.data.estimateMinor === '150'
      && lr.data.site === `KL partner ${RUN}`,
    { rReg: rReg.data, lr });

  // ─────────────────────────────────────────── G1 + G3: iOS for the network brand, at another operator, content version 2
  const B = await new Driver().init();
  const LA_B = (`b${RUN}` + 'e'.repeat(64)).slice(0, 64);
  apnsKnown.add(LA_B);
  const HB = await hostedSession(1, B.id, null);
  const apnsSub = await B.post('/v1/push/apns', { token: (`c${RUN}` + 'd'.repeat(64)).slice(0, 64) });
  const laReg = await B.post('/v1/live-activities', { ref: HB.c, token: LA_B, contentVersion: 2 });
  const la = (await until(() => apnsHits.filter((h) => h.token === LA_B && h.status === 200), (h) => h.length >= 1, 20_000))[0];
  const cs = la?.body?.aps?.['content-state'];
  check('G1 + G3: the PlugSure iOS app (network brand) registers APNs and a Live Activity for a charge at another operator; content version 2 names the currency and carries the cost so far',
    apnsSub.status === 200 && laReg.status === 200 && !!la && la.headers['apns-topic'] === 'asia.plugsure.app.push-type.liveactivity' && cs?.status === 'charging' && cs.currency === 'IDR'
      && Number.isInteger(cs.estimateIdr),
    { apnsSub: apnsSub.data, laReg: laReg.data, la: la?.body });

  // ─────────────────────────────────────────── G5 for a signed-in driver; partner networks through PlugSure Mobility
  const rl = await A.get('/v1/roaming/stations');
  const rlIds = (rl.data.stations ?? []).filter((s: any) => s.partnerId === partnerId).map((s: any) => s.locationId).sort();
  check('G1 + G5: a signed-in driver of the PlugSure app roams through PlugSure Mobility; the hosted operator\'s location is not listed twice',
    rl.status === 200 && rl.data.enabled === true && rl.data.mode === 'app' && JSON.stringify(rlIds) === JSON.stringify([`EXT${RUN}`, `KL${RUN}`].sort()),
    { rl: rl.data });

  // ─────────────────────────────────────────── G4: deletion
  await db.query(`UPDATE charging_session SET state = 'ended', ended_at = now() WHERE id = $1`, [HB.s]);
  const s2 = await until(() => A.post('/v1/account/delete/start'), (r) => r.status === 200, 90_000, 5000);
  const del = await A.post('/v1/account/delete', { code: s2.data.devCode });
  const me = await A.get('/v1/me');
  const row = (await db.query(`SELECT phone, name, status FROM app_driver WHERE id = $1`, [signedA.data.account.id])).rows[0];
  const subsLeft = (await db.query(`SELECT count(*)::int AS n FROM push_subscription WHERE device_id = $1`, [A.id])).rows[0].n;
  const kept = (await db.query(`SELECT count(*)::int AS n FROM driver_charge WHERE id = $1`, [H.c])).rows[0].n;
  check('G4: deleted in the app with the code — the device token stops working, the number is replaced by a hash, push tokens gone, the charge record kept',
    del.status === 200 && me.status === 401 && /^deleted:/.test(row.phone) && row.status === 'deleted' && subsLeft === 0 && kept === 1,
    { del: del.data, me: me.status, row, subsLeft, kept });
  const page = await http('GET', '/account/delete');
  const js = await http('GET', '/d/account-delete.js');
  const W = await new Driver({}).init();
  const phoneW = `+62814${RUN}${String(Math.floor(Math.random() * 90) + 10)}`;
  const Wacc = await new Driver({}).init();
  await Wacc.signIn(phoneW);
  const ws = await until(() => W.post('/v1/account/delete/start', { phone: phoneW }), (r) => r.status === 200, 90_000, 5000);
  const wd = await W.post('/v1/account/delete', { phone: phoneW, code: ws.data.devCode });
  check('G4: the web form (Google Play\'s deletion link) — a page with no inline script, its script, and deletion by phone number and code',
    page.status === 200 && /Delete your .* account/.test(page.text) && /script-src 'self'/.test(page.headers.get('content-security-policy') ?? '') && !/<script>/.test(page.text)
      && js.status === 200 && /account\/delete\/start/.test(js.text) && wd.status === 200 && (await Wacc.get('/v1/me')).status === 401,
    { page: page.status, csp: page.headers.get('content-security-policy'), ws: ws.data, wd: wd.data });

  // Restore what the suite changed in the console.
  await ops('DELETE', '/v1/driver-app/fcm');
  await ops('DELETE', '/v1/driver-app/apns');
  await ops('PUT', '/v1/driver-app/app-config', before.appConfig ?? {});
} catch (e) {
  check('suite ran to the end', false, (e as Error).stack ?? String(e));
} finally {
  for (const f of cleanup.reverse()) await f().catch((e) => console.log('cleanup:', (e as Error).message));
  await db?.end().catch(() => {});
  for (const s of servers) s.close();
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
