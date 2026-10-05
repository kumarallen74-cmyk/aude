import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttp2Server, type Http2Server } from 'node:http2';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Notifications to the app's builds and Android live sessions (v1.9.1), against the database and local stand-ins for
 * APNs and FCM:
 *   - a registration naming the `.dev` / `.preview` build (`appId`) is stored, and APNs is addressed to that build's
 *     topic (it used to go to the store bundle id, answer DeviceTokenNotForTopic, and the token was deleted); an
 *     `appId` that is not one of the brand's builds is ignored;
 *   - a charge that starts outside the app sends Android a DATA-ONLY message (no notification block, high priority,
 *     its own collapse key) with what the app reads (`type` session.started, `ref`), beside the visible one.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/driver/push-builds.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerDriverApi } = await import('./server.js');
const { onSessionStarted, _internal } = await import('./notify.js');
const { seal } = await import('../services/secrets.js');
const { forgetBrands } = await import('../services/brand.js');
const { closeApns } = await import('../services/apns.js');

const TAG = randomBytes(3).toString('hex');
const SLUG = `pb${TAG}`;
const BUNDLE = `id.pb${TAG}.app`;
let org = '';
let app: FastifyInstance;
let apns: Http2Server;
let fcm: Server;
const apnsSeen: Array<{ topic: string; token: string }> = [];
const fcmSeen: Array<{ message: any }> = [];

const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });

async function device(): Promise<{ token: string; id: string }> {
  const r = await app.inject({ method: 'POST', url: '/d/v1/device' });
  const b = r.json() as { deviceToken: string; deviceId: string };
  return { token: b.deviceToken, id: b.deviceId };
}
const h = (token: string) => ({ authorization: `Bearer ${token}`, 'x-driver-brand': SLUG });

if (DB_OK) {
  before(async () => {
    apns = createHttp2Server((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        apnsSeen.push({ topic: String(req.headers['apns-topic']), token: String(req.headers[':path']).split('/').pop()! });
        res.writeHead(200, { 'apns-id': 'x' });
        res.end();
      });
    });
    await new Promise<void>((r) => apns.listen(0, '127.0.0.1', () => r()));
    process.env.APNS_URL_PRODUCTION = `http://127.0.0.1:${(apns.address() as { port: number }).port}`;
    fcm = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/token') return res.end(JSON.stringify({ access_token: 'ya29.test', expires_in: 3599 }));
        fcmSeen.push(JSON.parse(Buffer.concat(chunks).toString()));
        res.end(JSON.stringify({ name: 'projects/p/messages/1' }));
      });
    });
    await new Promise<void>((r) => fcm.listen(0, '127.0.0.1', () => r()));
    const fcmBase = `http://127.0.0.1:${(fcm.address() as { port: number }).port}`;
    process.env.FCM_URL = fcmBase;

    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1,$2) RETURNING id`, [`Push Builds ${TAG}`, `push-builds-${TAG}`]))!.id;
    const sa = JSON.stringify({
      type: 'service_account', project_id: 'plugsure-test', private_key_id: 'kid', private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      client_email: 'fcm@plugsure-test.iam.gserviceaccount.com', token_uri: `${fcmBase}/token`,
    });
    await query(
      `INSERT INTO driver_app_brand (org_id, slug, status, app_name, short_name, ios_bundle_id, ios_team_id, android_package, apns_key_id, apns_key_sealed,
                                     fcm_project_id, fcm_client_email, fcm_sa_sealed)
       VALUES ($1,$2,'draft','Push Builds','Push',$3,'ABCDE12345',$3,'KEY1234567',$4,'plugsure-test','fcm@plugsure-test.iam.gserviceaccount.com',$5)`,
      [org, SLUG, BUNDLE, seal(ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string), seal(sa)]);
    forgetBrands();
    app = Fastify();
    await registerDriverApi(app);
  });
  after(async () => {
    await app?.close();
    closeApns();
    apns?.close();
    fcm?.close();
    delete process.env.APNS_URL_PRODUCTION;
    delete process.env.FCM_URL;
    if (org) {
      await query(`DELETE FROM driver_charge WHERE org_id = $1`, [org]);
      await query(`DELETE FROM charging_session WHERE org_id = $1`, [org]);
      await query(`DELETE FROM push_subscription WHERE brand_org_id = $1`, [org]);
      await query(`DELETE FROM live_activity_start_token WHERE brand_org_id = $1`, [org]);
      await query(`DELETE FROM token WHERE org_id = $1`, [org]);
      await query(`DELETE FROM connector WHERE evse_uuid IN (SELECT e.id FROM evse e JOIN charge_point cp ON cp.id = e.charge_point_id JOIN site s ON s.id = cp.site_id WHERE s.org_id = $1)`, [org]);
      await query(`DELETE FROM evse WHERE charge_point_id IN (SELECT cp.id FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE s.org_id = $1)`, [org]);
      await query(`DELETE FROM charge_point WHERE site_id IN (SELECT id FROM site WHERE org_id = $1)`, [org]);
      await query(`DELETE FROM site WHERE org_id = $1`, [org]);
      await query(`DELETE FROM driver_app_brand WHERE org_id = $1`, [org]);
      await query(`DELETE FROM organisation WHERE id = $1`, [org]);
    }
    await pool.end();
  });
}

/** The queued messages of one subscription, delivered through the APNs / FCM path. */
async function deliverFor(subscriptionIds: string[]) {
  const rows = await many<any>(
    `SELECT m.id, m.subscription_id, m.payload, m.attempts, m.kind, s.endpoint, s.kind AS sub_kind, s.brand_org_id, s.apns_env, s.device_id, s.app_id
       FROM push_message m JOIN push_subscription s ON s.id = m.subscription_id WHERE m.subscription_id = ANY($1::uuid[]) AND m.state = 'pending'`,
    [subscriptionIds]);
  for (const m of rows) {
    if (m.sub_kind === 'apns') await _internal.deliverApns(m, 600, false);
    else await _internal.deliverFcm(m, m.kind === 'session.started.live' ? 600 : 86_400, m.kind === 'session.started.live');
  }
  return rows;
}

dbDescribe('the app\'s development and preview builds', () => {
  test('appId is stored only for the brand\'s own builds, and APNs goes to that build\'s topic', async () => {
    const d = await device();
    const dev = 'd'.repeat(64), store = 'e'.repeat(64), other = 'f'.repeat(64);
    for (const [token, appId] of [[dev, `${BUNDLE}.dev`], [store, BUNDLE], [other, 'com.attacker.app']] as const) {
      const r = await app.inject({ method: 'POST', url: '/d/v1/push/apns', headers: h(d.token), payload: { token, lang: 'en', appId } });
      assert.equal(r.statusCode, 200, r.body);
    }
    const subs = await many<{ id: string; endpoint: string; app_id: string | null }>(`SELECT id, endpoint, app_id FROM push_subscription WHERE device_id = $1`, [d.id]);
    const appOf = (t: string) => subs.find((s) => s.endpoint.endsWith(t))!.app_id;
    assert.equal(appOf(dev), `${BUNDLE}.dev`);
    assert.equal(appOf(store), null, 'the store build is the brand\'s own id');
    assert.equal(appOf(other), null, 'not one of the brand\'s builds: ignored');
    await query(`INSERT INTO push_message (subscription_id, kind, dedupe_key, payload) SELECT id, 'test', $2, '{"title":"t","body":"b"}'::jsonb FROM push_subscription WHERE device_id = $1`,
      [d.id, `t:${TAG}`]);
    apnsSeen.length = 0;
    await deliverFor(subs.map((s) => s.id));
    const topicOf = (t: string) => apnsSeen.find((x) => x.token === t)?.topic;
    assert.equal(topicOf(dev), `${BUNDLE}.dev`);
    assert.equal(topicOf(store), BUNDLE);
    assert.equal(topicOf(other), BUNDLE);
    assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM push_subscription WHERE device_id = $1`, [d.id]))!.n, 3, 'none deleted as gone');

    // The push-to-start token and the Android registration carry it too.
    const st = await app.inject({ method: 'POST', url: '/d/v1/live-activities/start-token', headers: h(d.token), payload: { token: 'c'.repeat(64), appId: `${BUNDLE}.preview` } });
    assert.equal(st.statusCode, 200, st.body);
    assert.equal((await one<{ app_id: string }>(`SELECT app_id FROM live_activity_start_token WHERE device_id = $1`, [d.id]))!.app_id, `${BUNDLE}.preview`);
    const f = await app.inject({ method: 'POST', url: '/d/v1/push/fcm', headers: h(d.token), payload: { token: `fcm-${'x'.repeat(80)}`, appId: `${BUNDLE}.dev` } });
    assert.equal(f.statusCode, 200, f.body);
    assert.equal((await one<{ app_id: string }>(`SELECT app_id FROM push_subscription WHERE device_id = $1 AND kind = 'fcm'`, [d.id]))!.app_id, `${BUNDLE}.dev`);
  });
});

dbDescribe('Android live session for a charge started outside the app', () => {
  test('session.started: the visible notification as before, plus a data-only message the app\'s background handler reads', async () => {
    const d = await device();
    const fcmToken = `fcm-${randomBytes(40).toString('hex')}`;
    assert.equal((await app.inject({ method: 'POST', url: '/d/v1/push/fcm', headers: h(d.token), payload: { token: fcmToken } })).statusCode, 200);
    // A fleet card bound to this phone starts a session at the charger.
    const site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code, timezone) VALUES ($1,$2,'ID','Asia/Jakarta') RETURNING id`, [org, `PB ${TAG}`]))!.id;
    const cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, status) VALUES ($1,$2,'online') RETURNING id`, [site, `PB-${TAG}`]))!.id;
    const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1,1,22000) RETURNING id`, [cp]))!.id;
    const conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w) VALUES ($1,1,'sType2','AC',22000) RETURNING id`, [e]))!.id;
    const tok = (await one<{ id: string }>(`INSERT INTO token (org_id, uid, kind, status) VALUES ($1,$2,'rfid','Accepted') RETURNING id`, [org, `PB${TAG}`.toUpperCase()]))!.id;
    await query(`UPDATE driver_device SET fleet_token_id = $2 WHERE id = $1`, [d.id, tok]);
    const session = (await one<{ id: string }>(
      `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, token_id, state, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active', now()) RETURNING id`, [org, site, conn, cp, `pb-${randomUUID()}`, tok]))!.id;
    await onSessionStarted(session);
    await onSessionStarted(session); // a repeated event queues nothing more
    const msgs = await many<{ kind: string; payload: any }>(
      `SELECT m.kind, m.payload FROM push_message m JOIN push_subscription s ON s.id = m.subscription_id WHERE s.device_id = $1 ORDER BY m.kind`, [d.id]);
    assert.deepEqual(msgs.map((m) => m.kind), ['session.started', 'session.started.live']);
    fcmSeen.length = 0;
    const subs = await many<{ id: string }>(`SELECT id FROM push_subscription WHERE device_id = $1`, [d.id]);
    await deliverFor(subs.map((s) => s.id));
    assert.equal(fcmSeen.length, 2);
    const visible = fcmSeen.find((x: any) => x.message.notification)!.message;
    const live = fcmSeen.find((x: any) => !x.message.notification)!.message;
    assert.equal(visible.data.type, 'session.started');
    assert.equal(live.token, fcmToken);
    assert.equal(live.notification, undefined, 'data-only: the app\'s handler runs in the background');
    assert.equal(live.android.notification, undefined);
    assert.deepEqual({ type: live.data.type, ref: live.data.ref }, { type: 'session.started', ref: session }, 'what liveSession.ts reads; a fleet session is its own ref');
    assert.equal(live.data.site, `PB ${TAG}`);
    assert.equal(live.data.connector, 'AC 22 kW');
    assert.equal(live.data.path, '/app/#history', 'the visible notification\'s link (a fleet session has no charge screen)');
    assert.equal(live.android.priority, 'HIGH');
    assert.equal(live.android.collapse_key, `ls-start-${session}`);
    assert.notEqual(live.android.collapse_key, visible.android.collapse_key);
    // The ref is one /d/v1/live-sessions accepts for this phone.
    const reg = await app.inject({ method: 'POST', url: '/d/v1/live-sessions', headers: h(d.token), payload: { platform: 'android', ref: live.data.ref, token: fcmToken } });
    assert.equal(reg.statusCode, 200, reg.body);
    await query(`DELETE FROM live_activity WHERE device_id = $1`, [d.id]);
    await query(`DELETE FROM push_message WHERE subscription_id = ANY($1::uuid[])`, [subs.map((s) => s.id)]);
    await query(`UPDATE driver_device SET fleet_token_id = NULL WHERE id = $1`, [d.id]);
  });
});
