// PlugSure v1.3 — native iOS notifications (APNs) for white-label apps, end to end.
//
// A stand-in for Apple's push service (HTTP/2, checking every provider token
// with the operator's public key, as Apple does) listens where the API and the
// gateway are told APNs is (APNS_URL_PRODUCTION / _DEVELOPMENT, set by the test
// harness). The test then:
//   - uploads the operator's .p8 key in the console: validation, a wrong key
//     refused by "Apple", the right one accepted; the key is never returned;
//   - registers iPhones of the brand's iOS app (device tokens);
//   - raises notifications through the real notifyDevices path and lets the
//     gateway's push worker deliver them: headers and body as Apple wants them,
//     in the phone's language, priority by kind; a development (Xcode) token
//     found on the development server and remembered; an uninstalled app's
//     token dropped; a key Apple stops accepting flagged in the console and
//     retried, not blamed on the phones;
//   - removes the key.
//
// Needs E2E_DATABASE_URL (the runtime role). Same prerequisites as console-e2e.mts.
//     npx tsx tools/e2e/apns-e2e.mts
// NEVER point this at production.
import { createServer } from 'node:http2';
import { generateKeyPairSync, verify } from 'node:crypto';
import pg from 'pg';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const results: boolean[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 700)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 20_000, every = 300): Promise<T> {
  const t0 = Date.now(); let v = await fn();
  while (!ok(v) && Date.now() - t0 < ms) { await sleep(every); v = await fn(); }
  return v;
}
const RUN = Date.now().toString().slice(-6);
let cookie = '';
async function ops(method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d, text: t };
}

// ─────────────────────────────────────────── the stand-in for APNs
const operatorKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const P8 = operatorKey.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const TEAM = 'T' + RUN.padStart(9, '0');
const KEY_ID = 'K' + RUN.padStart(9, '0');
const BUNDLE = `id.nusacharge.e${RUN}`;
// Fresh device tokens per run (hex, as iOS gives them).
const tok = (p: string) => (p + RUN + '0'.repeat(64)).slice(0, 64);
const GOOD = tok('a1'), DEV = tok('b2'), GONE = tok('c3');
let refuseAll = false;
type Hit = { env: string; token: string; headers: Record<string, unknown>; body: any; status: number };
const hits: Hit[] = [];
function fakeApns(env: 'production' | 'development', port: number, known: Record<string, number | [number, string]>) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const token = String(req.headers[':path']).split('/').pop()!;
      const jwt = String(req.headers.authorization ?? '').replace(/^bearer /, '');
      const [h, p, s] = jwt.split('.');
      let head: any = {}, claims: any = {};
      try { head = JSON.parse(Buffer.from(h!, 'base64url').toString()); claims = JSON.parse(Buffer.from(p!, 'base64url').toString()); } catch {}
      const signed = !!s && verify('sha256', Buffer.from(`${h}.${p}`), { key: operatorKey.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
      const answer = (status: number, reason?: string) => {
        hits.push({ env, token, headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null, status });
        res.writeHead(status, { 'apns-id': `id-${hits.length}` }); res.end(reason ? JSON.stringify({ reason }) : '');
      };
      if (refuseAll || !signed || head.kid !== KEY_ID || claims.iss !== TEAM) return answer(403, 'InvalidProviderToken');
      if (req.headers['apns-topic'] !== BUNDLE) return answer(400, 'DeviceTokenNotForTopic');
      const a = known[token];
      if (a === undefined) return answer(400, 'BadDeviceToken');
      if (Array.isArray(a)) return answer(a[0], a[1]);
      answer(a);
    });
  });
  return new Promise<typeof server>((res, rej) => { server.once('error', rej); server.listen(port, '127.0.0.1', () => res(server)); });
}

const db = process.env.E2E_DATABASE_URL ? new pg.Client({ connectionString: process.env.E2E_DATABASE_URL }) : null;
const servers: Array<{ close: () => void }> = [];
try {
  if (!db) throw new Error('set E2E_DATABASE_URL (the runtime role)');
  await db.connect();
  servers.push(await fakeApns('production', 9296, { [GOOD]: 200, [GONE]: [410, 'Unregistered'] }));
  servers.push(await fakeApns('development', 9297, { [DEV]: 200 }));
  // The real enqueue path (notify.ts), against the same database as the running stack.
  process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
  const { notifyDevices, refreshUnpaidBadge } = await import('../../src/driver/notify.js');
  const { chargeCardPath } = await import('../../src/services/charge-card.js');

  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  check('setup: operator signs in', login.status === 200, login.data);
  const existing = await ops('GET', '/v1/driver-app');
  if (existing.data.brand) await ops('DELETE', `/v1/driver-app?confirm=${existing.data.brand.slug}`);
  const SLUG = `apns-${RUN}`;
  await ops('PUT', '/v1/driver-app', { appName: `NusaCharge ${RUN}`, slug: SLUG, accentColor: '#ff8a00' });

  // ─────────────────────────────────────────── the key, in the console
  const early = await ops('PUT', '/v1/driver-app/apns', { keyId: KEY_ID, p8: P8 });
  check('console: a key cannot be checked before the Team ID and bundle identifier are set', early.status === 409 && /Team ID/.test(early.data.error), early.data);
  await ops('PUT', '/v1/driver-app', { iosTeamId: TEAM, iosBundleId: BUNDLE });
  const badId = await ops('PUT', '/v1/driver-app/apns', { keyId: 'short', p8: P8 });
  const badKey = await ops('PUT', '/v1/driver-app/apns', { keyId: KEY_ID, p8: 'not a key' });
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const rsaKey = await ops('PUT', '/v1/driver-app/apns', { keyId: KEY_ID, p8: rsa });
  check('console: a malformed Key ID, something that is not a key, and an RSA key are refused with a reason',
    badId.status === 422 && badKey.status === 422 && /whole \.p8/.test(badKey.data.error) && rsaKey.status === 422 && /not an APNs key/.test(rsaKey.data.error),
    { a: badId.data, b: badKey.data, c: rsaKey.data });
  const otherKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const wrong = await ops('PUT', '/v1/driver-app/apns', { keyId: KEY_ID, p8: otherKey });
  check('console: a key Apple does not accept is stored but shown as refused, with what to check',
    wrong.status === 200 && wrong.data.brand.apnsConfigured === true && wrong.data.brand.apnsCheckOk === false && /refused the key/.test(wrong.data.brand.apnsCheckDetail),
    wrong.data.brand);
  const right = await ops('PUT', '/v1/driver-app/apns', { keyId: KEY_ID.toLowerCase(), p8: P8.replace(/\n/g, '\r\n') });
  const probe = hits.filter((h) => h.token === '0'.repeat(64));
  const view = await ops('GET', '/v1/driver-app');
  check('console: the right key is accepted by “Apple” — checked with a token that cannot exist, so nobody was notified — and the key is never sent back',
    right.status === 200 && right.data.brand.apnsCheckOk === true && right.data.brand.apnsKeyId === KEY_ID && probe.length >= 2 && probe.every((h) => h.env === 'production')
      && !view.text.includes('PRIVATE KEY') && view.data.checks.some((c: any) => c.key === 'apns' && c.ok),
    { r: right.data.brand, probes: probe.length });

  // ─────────────────────────────────────────── iPhones register
  const device = async () => (await (await fetch(`${API}/d/v1/device`, { method: 'POST' })).json()).deviceToken as string;
  const reg = (dev: string, token: string, brand: string | null, lang = 'id') => fetch(`${API}/d/v1/push/apns`, {
    method: 'POST', headers: { authorization: `Bearer ${dev}`, 'content-type': 'application/json', ...(brand ? { 'x-driver-brand': brand } : {}) },
    body: JSON.stringify({ token, lang }),
  }).then(async (r) => ({ status: r.status, data: await r.json() }));
  const phoneA = await device(), phoneB = await device(), phoneC = await device();
  const noBrand = await reg(phoneA, GOOD, null);
  const badToken = await reg(phoneA, 'xyz', SLUG);
  const a = await reg(phoneA, GOOD.toUpperCase(), SLUG, 'id');
  const bRes = await reg(phoneB, DEV, SLUG, 'en');
  const cRes = await reg(phoneC, GONE, SLUG);
  const status = await (await fetch(`${API}/d/v1/push`, { headers: { authorization: `Bearer ${phoneA}`, 'x-driver-brand': SLUG } })).json();
  check('app: the iOS app registers its device token for its brand (the PlugSure app cannot; a malformed token is refused), and shows notifications as on',
    noBrand.status === 409 && badToken.status === 422 && a.status === 200 && bRes.status === 200 && cRes.status === 200 && status.subscribed === true,
    { noBrand, badToken, a, status });
  const devIds = async (...tokens: string[]) => {
    const out: string[] = [];
    for (const t of tokens) {
      const r = await fetch(`${API}/d/v1/me`, { headers: { authorization: `Bearer ${t}` } }).then((x) => x.json());
      out.push(r.deviceId);
    }
    return out;
  };
  const [devA, devB, devC] = await devIds(phoneA, phoneB, phoneC);
  const subs = (await db.query(`SELECT device_id, endpoint, lang, apns_env FROM push_subscription WHERE kind = 'apns' AND device_id = ANY($1::uuid[])`, [[devA, devB, devC]])).rows;
  check('database: one APNs subscription per iPhone, for the brand, token in lowercase, in the phone’s language', subs.length === 3 && subs.some((s: any) => s.endpoint.endsWith(GOOD) && s.lang === 'id') && subs.some((s: any) => s.endpoint.endsWith(DEV) && s.lang === 'en'), subs);

  // ─────────────────────────────────────────── delivery by the gateway's worker
  hits.length = 0;
  const n = await notifyDevices([devA, devB, devC], 'session.ended', `session.ended:apns-${RUN}`, {
    id: { title: 'Pengisian selesai', body: '12,5 kWh di Hub Tol' }, en: { title: 'Charging finished', body: '12.5 kWh at Hub Tol' },
    url: `/app/#s/x-${RUN}`, tag: `s-apns-${RUN}`,
  });
  const got = await until(() => [...hits], (h) => h.some((x) => x.token === GOOD && x.status === 200) && h.some((x) => x.token === DEV && x.status === 200) && h.some((x) => x.token === GONE), 20_000);
  const hitA = got.find((x) => x.token === GOOD && x.status === 200);
  check('delivery: the worker sends to Apple with the brand’s topic, an alert push, the notification in Indonesian, the screen to open, grouped by session, at normal priority',
    n === 3 && !!hitA && hitA.env === 'production' && hitA.headers['apns-topic'] === BUNDLE && hitA.headers['apns-push-type'] === 'alert' && hitA.headers['apns-priority'] === '5'
      && hitA.headers['apns-collapse-id'] === `s-apns-${RUN}` && hitA.body.aps.alert.title === 'Pengisian selesai' && hitA.body.url === `/app/#s/x-${RUN}` && hitA.body.aps.sound === 'default',
    { n, hitA });
  const devHits = got.filter((x) => x.token === DEV);
  check('delivery: an Xcode build’s token — unknown to production — is found on the development server, in English',
    devHits.length === 2 && devHits[0]!.env === 'production' && devHits[0]!.status === 400 && devHits[1]!.env === 'development' && devHits[1]!.status === 200 && devHits[1]!.body.aps.alert.title === 'Charging finished',
    devHits.map((h) => [h.env, h.status]));
  const after1 = await until(() => db.query(`SELECT s.device_id, s.apns_env, m.state FROM push_message m JOIN push_subscription s ON s.id = m.subscription_id WHERE m.dedupe_key = $1`, [`session.ended:apns-${RUN}`]).then((r) => r.rows),
    (rows) => rows.length === 2 && rows.every((r: any) => r.state === 'sent'), 10_000);
  const goneLeft = (await db.query(`SELECT count(*)::int AS n FROM push_subscription WHERE device_id = $1`, [devC])).rows[0].n;
  check('delivery: both are marked sent, the development environment is remembered, and the uninstalled app’s token (410 Unregistered) is dropped',
    after1.length === 2 && after1.find((r: any) => r.device_id === devB)?.apns_env === 'development' && after1.find((r: any) => r.device_id === devA)?.apns_env === 'production' && goneLeft === 0,
    { after1, goneLeft });
  hits.length = 0;
  await notifyDevices([devB], 'queue.offer', `queue.offer:apns-${RUN}`, {
    id: { title: 'Giliran Anda!', body: 'Hub Tol' }, en: { title: 'Your turn!', body: 'Hub Tol' }, url: '/app/#home', tag: `q-${RUN}`,
  });
  const qHits = await until(() => [...hits], (h) => h.length >= 1, 15_000);
  check('delivery: a time-critical notification (your turn in the queue) goes at once (priority 10), straight to the remembered development server',
    qHits.length === 1 && qHits[0]!.env === 'development' && qHits[0]!.headers['apns-priority'] === '10' && qHits[0]!.body.aps.alert.title === 'Your turn!', qHits.map((h) => [h.env, h.headers['apns-priority']]));

  // ─────────────────────────────────────────── rich notifications and the badge
  // A session at one of the operator's chargers, left unpaid (a failed post-pay charge), started from phone A.
  const brandOrg = (await ops('GET', '/v1/driver-app')).data.brand.orgId as string;
  const place = (await db.query(
    `SELECT c.id AS connector, cp.id AS cp, s.id AS site FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id
       JOIN site s ON s.id = cp.site_id WHERE s.org_id = $1 AND s.archived_at IS NULL LIMIT 1`, [brandOrg])).rows[0];
  const tokenId = (await db.query(`SELECT id FROM token WHERE org_id = $1 LIMIT 1`, [brandOrg])).rows[0].id;
  const started = new Date(Date.now() - 50 * 60_000), ended = new Date(Date.now() - 5 * 60_000);
  const sessionId = (await db.query(
    `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, ended_at, energy_wh, token_id, state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,12500,$8,'rated') RETURNING id`,
    [brandOrg, place.site, place.connector, place.cp, `apns-e2e-${RUN}`, started, ended, tokenId])).rows[0].id as string;
  for (let i = 0; i <= 9; i++) {
    await db.query(`INSERT INTO meter_value (session_id, ts, measurand, value, unit) VALUES ($1, $2, 'Energy.Active.Import.Register', $3, 'Wh')`,
      [sessionId, new Date(started.getTime() + i * 5 * 60_000), 100_000 + Math.round(12_500 * Math.sin((i / 9) * Math.PI / 2))]);
  }
  const intentId = (await db.query(
    `INSERT INTO payment_intent (org_id, provider, method, mode, session_id, hold_state, hold_capture_minor, hold_error, state)
     VALUES ($1, 'mock', 'ewallet', 'postpay', $2, 'capture_failed', 30000, 'charge failed: insufficient balance', 'pending') RETURNING id`,
    [brandOrg, sessionId])).rows[0].id as string;
  const chargeId = (await db.query(
    `INSERT INTO driver_charge (device_id, org_id, connector_uuid, token_id, mode, payment_intent_id, session_id) VALUES ($1,$2,$3,$4,'postpay',$5,$6) RETURNING id`,
    [devA, brandOrg, place.connector, tokenId, intentId, sessionId])).rows[0].id as string;

  hits.length = 0;
  await notifyDevices([devA], 'session.ended', `session.ended:rich-${RUN}`, {
    id: { title: 'Pengisian selesai', body: '12,5 kWh di Hub Tol', detail: '12,5 kWh terisi' }, en: { title: 'Charging finished', body: '12.5 kWh at Hub Tol', detail: '12.5 kWh charged' },
    url: `/app/#s/${chargeId}`, tag: `s-${sessionId}`, site: 'Hub Tol KM 57',
    category: 'PS_RECEIPT', actions: { receipt: `/app/#r/${chargeId}` },
    image: { id: chargeCardPath(sessionId, 'id'), en: chargeCardPath(sessionId, 'en') },
  });
  const rich = (await until(() => [...hits], (h) => h.some((x) => x.token === GOOD), 15_000)).find((x) => x.token === GOOD);
  const aps = rich?.body?.aps ?? {};
  check('rich: the site as a subtitle over the detail, the receipt button’s category and target, and a picture for the service extension (mutable-content)',
    aps.alert?.subtitle === 'Hub Tol KM 57' && aps.alert?.body === '12,5 kWh terisi' && aps.category === 'PS_RECEIPT' && aps['mutable-content'] === 1
      && rich!.body.actions?.receipt === `/app/#r/${chargeId}` && /^http:\/\/127\.0\.0\.1:9200\/d\/n\/charge\/[0-9a-f-]{36}\.png\?l=id&e=\d+&s=/.test(rich!.body.image) && aps['interruption-level'] === 'active',
    rich?.body);
  check('badge: the notification carries the number of sessions waiting to be paid in this operator’s app (1)', aps.badge === 1, aps);
  const pic = await fetch(rich!.body.image);
  const picBody = Buffer.from(await pic.arrayBuffer());
  const { decodePng } = await import('../../src/services/png.js');
  const forged = await fetch(rich!.body.image.replace(/s=[^&]+/, 's=' + 'A'.repeat(32)));
  const other = await fetch(rich!.body.image.replace(sessionId, '00000000-0000-4000-8000-000000000000'));
  check('picture: the signed address gives the 720 × 360 card of the charge; a forged signature or another session is refused',
    pic.status === 200 && pic.headers.get('content-type') === 'image/png' && decodePng(picBody).width === 720 && forged.status === 404 && other.status === 404,
    { s: pic.status, f: forged.status, o: other.status });

  hits.length = 0;
  await db.query(`UPDATE payment_intent SET hold_state = 'captured', state = 'captured' WHERE id = $1`, [intentId]);
  const queued = await refreshUnpaidBadge(intentId);
  const badgeHit = (await until(() => [...hits], (h) => h.some((x) => x.token === GOOD), 15_000)).find((x) => x.token === GOOD);
  check('badge: once the session is paid, the iPhone gets a badge-only update (0) that shows nothing and replaces nothing',
    queued === 1 && JSON.stringify(badgeHit?.body) === '{"aps":{"badge":0}}' && badgeHit!.headers['apns-collapse-id'] === undefined && badgeHit!.headers['apns-priority'] === '5',
    { queued, body: badgeHit?.body, h: badgeHit?.headers['apns-collapse-id'] });

  hits.length = 0;
  await notifyDevices([devB], 'queue.offer', `queue.offer:rich-${RUN}`, {
    id: { title: 'Giliran Anda!', body: 'Hub Tol · konektor ditahan', detail: 'Konektor ditahan untuk Anda' }, en: { title: 'Your turn!', body: 'Hub Tol · a connector is held', detail: 'A connector is held for you' },
    url: '/app/#home', tag: `q-rich-${RUN}`, site: 'Hub Tol', urgent: true, category: 'PS_QUEUE', actions: { leave: `queue-leave:${RUN}` },
  });
  const q = (await until(() => [...hits], (h) => h.some((x) => x.token === DEV), 15_000)).find((x) => x.token === DEV);
  check('rich: “your turn” is time-sensitive (through Focus), leads its group, and offers to give up the turn',
    q?.body?.aps?.['interruption-level'] === 'time-sensitive' && q.body.aps['relevance-score'] === 1 && q.body.aps.category === 'PS_QUEUE' && q.body.actions?.leave === `queue-leave:${RUN}`
      && q.body.aps.alert?.body === 'A connector is held for you',
    q?.body);
  await db.query(`DELETE FROM driver_charge WHERE id = $1`, [chargeId]);
  await db.query(`DELETE FROM payment_intent WHERE id = $1`, [intentId]);
  await db.query(`DELETE FROM meter_value WHERE session_id = $1`, [sessionId]);
  await db.query(`DELETE FROM charging_session WHERE id = $1`, [sessionId]);

  // ─────────────────────────────────────────── Apple stops accepting the key
  refuseAll = true;
  hits.length = 0;
  await notifyDevices([devA], 'cdr.created', `cdr:apns-${RUN}`, { id: { title: 'Struk siap', body: 'Rp 30.000' }, en: { title: 'Receipt ready', body: 'Rp 30.000' }, url: '/app/#history', tag: `r-${RUN}` });
  await until(() => [...hits], (h) => h.length >= 1, 15_000);
  const refused = await until(() => ops('GET', '/v1/driver-app'), (r) => r.data.brand?.apnsCheckOk === false, 10_000);
  const msg = (await db.query(`SELECT state, last_status, last_error FROM push_message WHERE dedupe_key = $1`, [`cdr:apns-${RUN}`])).rows[0];
  const subA = (await db.query(`SELECT failures FROM push_subscription WHERE device_id = $1`, [devA])).rows[0];
  check('refused key: the console shows Apple refused it while sending; the notification waits for a retry, and the iPhone is not blamed',
    /refused the key while sending/.test(refused.data.brand.apnsCheckDetail) && msg.state === 'pending' && msg.last_status === 403 && /InvalidProviderToken/.test(msg.last_error) && subA.failures === 0,
    { b: refused.data.brand, msg, subA });
  refuseAll = false;
  const recheck = await ops('POST', '/v1/driver-app/apns/check');
  check('refused key: once Apple accepts it again, “Check with Apple” clears the warning', recheck.status === 200 && recheck.data.brand.apnsCheckOk === true, recheck.data.brand);

  // ─────────────────────────────────────────── removing the key
  const del = await ops('DELETE', '/v1/driver-app/apns');
  const afterDel = await reg(await device(), GOOD, SLUG);
  const audit = JSON.stringify((await ops('GET', '/v1/audit?limit=40')).data);
  check('removal: without a key new iPhones cannot register (“not available in this app”); the key changes are audited',
    del.status === 200 && afterDel.status === 422 && /belum tersedia/.test(afterDel.data.error) && audit.includes('driver_app.apns_key_set') && audit.includes('driver_app.apns_key_removed'),
    { del: del.data, afterDel });
  const keptAfterKey = (await db.query(`SELECT count(*)::int AS n FROM push_subscription WHERE kind = 'apns' AND device_id = ANY($1::uuid[])`, [[devA, devB]])).rows[0].n;
  await ops('DELETE', `/v1/driver-app?confirm=${SLUG}`);
  const leftAfterBrand = (await db.query(`SELECT count(*)::int AS n FROM push_subscription WHERE kind = 'apns' AND device_id = ANY($1::uuid[])`, [[devA, devB]])).rows[0].n;
  check('removal: removing only the key keeps the iPhones (tokens belong to the app, so a new key reaches them); deleting the app drops them',
    keptAfterKey === 2 && leftAfterBrand === 0, { keptAfterKey, leftAfterBrand });
} catch (e) {
  check('no unexpected exception', false, (e as Error).stack);
} finally {
  for (const s of servers) s.close();
  await db?.end().catch(() => {});
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
