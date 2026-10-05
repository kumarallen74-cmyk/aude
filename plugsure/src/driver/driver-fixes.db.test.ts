import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * The driver API after the v1.9.0 review (v1.9.1), against the database:
 *   - Idempotency-Key on the money-creating POSTs: a replay creates no second payment_intent and returns the same
 *     body (Idempotent-Replayed), 409 while the first runs, 422 for a key reused on another request, 400 for a bad
 *     key, a deliberate 5xx leaves nothing stored, a thrown error keeps the key claimed until stale;
 *   - sign-out revokes the device token (401 no_device) and drops its push and live-activity rows, while the account's
 *     history is still there on a new device;
 *   - device B cannot see or act on device A's charge, receipt, stop, reservation, favourite, card or queue place.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/driver/driver-fixes.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerDriverApi } = await import('./server.js');
const { idempotent, registerIdempotency, canonicalJson, requestHash } = await import('./idempotency.js');

const TAG = randomBytes(3).toString('hex');
let org = '';
let site = '';
let conn = '';
let app: FastifyInstance;
const phones: string[] = [];

async function device(): Promise<{ token: string; id: string }> {
  const r = await app.inject({ method: 'POST', url: '/d/v1/device' });
  const b = r.json() as { deviceToken: string; deviceId: string };
  return { token: b.deviceToken, id: b.deviceId };
}
const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });

/** Sign a device in with a planted code (the sender is not under test here). */
async function signIn(token: string, deviceId: string): Promise<string> {
  const phone = `+62857${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  phones.push(phone);
  const { createHash } = await import('node:crypto');
  await query(`INSERT INTO driver_otp (phone, code_hash, expires_at, device_id) VALUES ($1, $2, now() + interval '5 minutes', $3)`,
    [phone, createHash('sha256').update('482916').digest('hex'), deviceId]);
  const r = await app.inject({ method: 'POST', url: '/d/v1/otp/verify', headers: auth(token), payload: { phone, code: '482916' } });
  assert.equal(r.statusCode, 200, r.body);
  return (r.json() as { account: { id: string } }).account.id;
}

const intents = async () => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM payment_intent WHERE connector_uuid = $1`, [conn]))!.n;

async function cleanup() {
  if (!org) return;
  await query(`DELETE FROM driver_queue_entry WHERE org_id = $1`, [org]);
  await query(`DELETE FROM driver_reservation WHERE org_id = $1`, [org]);
  await query(`DELETE FROM driver_favourite WHERE site_id = $1`, [site]);
  await query(`DELETE FROM driver_charge WHERE org_id = $1`, [org]);
  await query(`DELETE FROM payment_intent WHERE org_id = $1`, [org]);
  await query(`DELETE FROM token WHERE org_id = $1`, [org]);
  await query(`DELETE FROM tariff_assignment WHERE tariff_id IN (SELECT id FROM tariff WHERE org_id = $1)`, [org]);
  await query(`DELETE FROM tariff_component WHERE tariff_id IN (SELECT id FROM tariff WHERE org_id = $1)`, [org]);
  await query(`DELETE FROM tariff WHERE org_id = $1`, [org]);
  await query(`DELETE FROM connector WHERE evse_uuid IN (SELECT e.id FROM evse e JOIN charge_point cp ON cp.id = e.charge_point_id JOIN site s ON s.id = cp.site_id WHERE s.org_id = $1)`, [org]);
  await query(`DELETE FROM evse WHERE charge_point_id IN (SELECT cp.id FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE s.org_id = $1)`, [org]);
  await query(`DELETE FROM charge_point WHERE site_id IN (SELECT id FROM site WHERE org_id = $1)`, [org]);
  await query(`DELETE FROM site WHERE org_id = $1`, [org]);
  if (phones.length) {
    await query(`DELETE FROM driver_card WHERE app_driver_id IN (SELECT id FROM app_driver WHERE phone = ANY($1))`, [phones]);
    await query(`DELETE FROM driver_otp WHERE phone = ANY($1)`, [phones]);
    await query(`UPDATE driver_device SET app_driver_id = NULL WHERE app_driver_id IN (SELECT id FROM app_driver WHERE phone = ANY($1))`, [phones]);
    await query(`DELETE FROM driver_auth_limit WHERE split_part(key, ':', 2) = ANY($1)`, [phones]);
    await query(`DELETE FROM app_driver WHERE phone = ANY($1)`, [phones]);
  }
  await query(`DELETE FROM integration_event WHERE org_id = $1`, [org]);
  await query(`DELETE FROM organisation WHERE id = $1`, [org]);
}

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1,$2) RETURNING id`, [`Fixes Test ${TAG}`, `fixes-test-${TAG}`]))!.id;
    site = (await one<{ id: string }>(
      `INSERT INTO site (org_id, name, country_code, lat, lon, timezone) VALUES ($1,$2,'ID',-6.2,106.8,'Asia/Jakarta') RETURNING id`, [org, `Fixes ${TAG}`]))!.id;
    const cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, status) VALUES ($1,$2,'offline') RETURNING id`, [site, `FX-${TAG}`]))!.id;
    const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1,1,22000) RETURNING id`, [cp]))!.id;
    conn = (await one<{ id: string }>(
      `INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w, tera_status) VALUES ($1,1,'sType2','AC',22000,'verified') RETURNING id`, [e]))!.id;
    const t = (await one<{ id: string }>(`INSERT INTO tariff (org_id, name, country_code, currency) VALUES ($1,$2,'ID','IDR') RETURNING id`, [org, `T ${TAG}`]))!.id;
    await query(`INSERT INTO tariff_component (tariff_id, kind, rate) VALUES ($1,'energy',2500)`, [t]);
    await query(`INSERT INTO tariff_assignment (tariff_id, scope_type, scope_id, valid_from) VALUES ($1,'site',$2, now() - interval '1 day')`, [t, site]);
    app = Fastify();
    await registerDriverApi(app);
  });
  after(async () => {
    await app?.close();
    await cleanup();
    await pool.end();
  });
}

const prepaid = (token: string, key: string | null, amountMinor = 50_000) => app.inject({
  method: 'POST', url: '/d/v1/charge/prepaid', payload: { connectorId: conn, amountMinor, method: 'QRIS' },
  headers: auth(token, key ? { 'idempotency-key': key } : {}),
});

dbDescribe('Idempotency-Key on money-creating POSTs', () => {
  test('canonical JSON: key order does not matter, values do', () => {
    assert.equal(canonicalJson({ b: 1, a: [1, { y: 2, x: 1 }] }), canonicalJson({ a: [1, { x: 1, y: 2 }], b: 1 }));
    assert.notEqual(requestHash({ amountMinor: 1 }, { id: 'x' }), requestHash({ amountMinor: 2 }, { id: 'x' }));
    assert.notEqual(requestHash({}, { id: 'x' }), requestHash({}, { id: 'y' }));
  });

  test('a replay returns the stored answer and creates no second payment_intent', async () => {
    const d = await device();
    const key = `k-${randomUUID()}`;
    const before0 = await intents();
    const first = await prepaid(d.token, key);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.headers['idempotent-replayed'], undefined);
    assert.equal(await intents(), before0 + 1);
    const again = await prepaid(d.token, key);
    assert.equal(again.statusCode, 200);
    assert.equal(again.headers['idempotent-replayed'], 'true');
    assert.deepEqual(again.json(), first.json());
    assert.equal(await intents(), before0 + 1, 'no second payment');
    // Without the header nothing changes: each request is a new payment.
    await prepaid(d.token, null);
    await prepaid(d.token, null);
    assert.equal(await intents(), before0 + 3);
  });

  test('a business refusal (4xx) is stored and replayed too', async () => {
    const d = await device();
    const key = `k-${randomUUID()}`;
    const r1 = await prepaid(d.token, key, -5);
    assert.equal(r1.statusCode, 422);
    const r2 = await prepaid(d.token, key, -5);
    assert.equal(r2.statusCode, 422);
    assert.equal(r2.headers['idempotent-replayed'], 'true');
    assert.deepEqual(r2.json(), r1.json());
  });

  test('same key, other body or other route: 422 idempotency_key_reused; a bad key: 400', async () => {
    const d = await device();
    const key = `k-${randomUUID()}`;
    assert.equal((await prepaid(d.token, key, 50_000)).statusCode, 200);
    const n = await intents();
    const other = await prepaid(d.token, key, 60_000);
    assert.equal(other.statusCode, 422);
    assert.equal(other.json().code, 'idempotency_key_reused');
    const route = await app.inject({ method: 'POST', url: '/d/v1/memberships', payload: { planId: randomUUID() }, headers: auth(d.token, { 'idempotency-key': key }) });
    assert.equal(route.statusCode, 422);
    assert.equal(route.json().code, 'idempotency_key_reused');
    assert.equal(await intents(), n);
    for (const bad of ['short', 'has space in it', 'x'.repeat(129), 'ünïcode-key']) {
      const r = await prepaid(d.token, bad);
      assert.equal(r.statusCode, 400, bad);
      assert.equal(r.json().code, 'bad_idempotency_key');
    }
    // Another device may use the same key: the scope is (device, key).
    const d2 = await device();
    assert.equal((await prepaid(d2.token, key, 60_000)).statusCode, 200);
  });

  test('while the first request runs: 409 idempotency_in_progress; a claim abandoned long ago, or a day-old answer, no longer counts', async () => {
    const d = await device();
    const key = `k-${randomUUID()}`;
    const hash = requestHash({ connectorId: conn, amountMinor: 50_000, method: 'QRIS' }, {});
    await query(`INSERT INTO driver_idempotency (device_id, key, route, request_hash) VALUES ($1,$2,'POST /d/v1/charge/prepaid',$3)`, [d.id, key, hash]);
    const n = await intents();
    const r = await prepaid(d.token, key);
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().code, 'idempotency_in_progress');
    assert.equal(await intents(), n);
    await query(`UPDATE driver_idempotency SET created_at = now() - interval '11 minutes' WHERE device_id = $1 AND key = $2`, [d.id, key]);
    assert.equal((await prepaid(d.token, key)).statusCode, 200);
    assert.equal(await intents(), n + 1);
    await query(`UPDATE driver_idempotency SET created_at = now() - interval '25 hours' WHERE device_id = $1 AND key = $2`, [d.id, key]);
    const fresh = await prepaid(d.token, key);
    assert.equal(fresh.headers['idempotent-replayed'], undefined);
    assert.equal(await intents(), n + 2);
  });

  test('a 5xx sent on purpose is not stored (the same key runs again); a thrown error keeps the key claimed', async () => {
    const d = await device();
    const t = Fastify();
    let runs = 0;
    t.addHook('preHandler', async (req) => { req.driver = { deviceId: d.id, appDriverId: null, fleetTokenId: null, fleet: null, account: null }; });
    registerIdempotency(t);
    t.post('/x/:mode', idempotent(async (req, reply) => {
      runs++;
      const { mode } = req.params as { mode: string };
      if (mode === 'throw') throw new Error('acquirer down');
      if (mode === 'fail') return reply.status(503).send({ error: 'down' });
      return { ok: true, runs };
    }));
    const call = (mode: string, key: string) => t.inject({ method: 'POST', url: `/x/${mode}`, payload: {}, headers: { 'idempotency-key': key } });
    const k1 = `k-${randomUUID()}`;
    assert.equal((await call('fail', k1)).statusCode, 503);
    assert.equal((await call('fail', k1)).statusCode, 503);
    assert.equal(runs, 2, 'a 5xx answer was run again, not replayed');
    assert.equal((await one(`SELECT 1 FROM driver_idempotency WHERE device_id = $1`, [d.id])), null, 'nothing stored');
    // Thrown: the outcome is unknown (an acquirer timeout may have charged a card), so the key stays claimed and a
    // retry is told the first is still in progress rather than run again; once stale it may run again.
    const k2 = `k-${randomUUID()}`;
    assert.equal((await call('throw', k2)).statusCode, 500);
    const again = await call('throw', k2);
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().code, 'idempotency_in_progress');
    assert.equal(runs, 3, 'not run a second time while the first outcome is unknown');
    await query(`UPDATE driver_idempotency SET created_at = now() - interval '11 minutes' WHERE device_id = $1 AND key = $2`, [d.id, k2]);
    assert.equal((await call('throw', k2)).statusCode, 500);
    assert.equal(runs, 4);
    const k3 = `k-${randomUUID()}`;
    const ok1 = await call('ok', k3);
    const ok2 = await call('ok', k3);
    assert.deepEqual(ok2.json(), ok1.json());
    assert.equal(runs, 5);
    await t.close();
  });
});

dbDescribe('sign-out revokes the device', () => {
  test('the token stops working (401 no_device), its push and live rows go, and the account\'s charges show on a new device', async () => {
    const a = await device();
    const acc = await signIn(a.token, a.id);
    const charge = await prepaid(a.token, null);
    assert.equal(charge.statusCode, 200, charge.body);
    const chargeId = (charge.json() as { chargeId: string }).chargeId;
    await query(`INSERT INTO push_subscription (device_id, endpoint, kind, brand_org_id, lang) VALUES ($1, $2, 'fcm', $3, 'id')`, [a.id, `fcm:${org}:tok-${TAG}-${randomUUID()}`, org]);
    const out = await app.inject({ method: 'POST', url: '/d/v1/signout', headers: auth(a.token) });
    assert.equal(out.statusCode, 200);
    const me = await app.inject({ method: 'GET', url: '/d/v1/me', headers: auth(a.token) });
    assert.equal(me.statusCode, 401);
    assert.equal(me.json().code, 'no_device');
    assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM push_subscription WHERE device_id = $1`, [a.id]))!.n, 0);
    const row = await one<{ app_driver_id: string | null; device_hash: string }>(`SELECT app_driver_id, device_hash FROM driver_device WHERE id = $1`, [a.id]);
    assert.equal(row!.app_driver_id, null);
    assert.match(row!.device_hash, /^revoked:/);
    // Signing back in on a new device: the charge is there.
    const b = await device();
    await query(`UPDATE app_driver SET last_seen_at = now() WHERE id = $1`, [acc]);
    const phone = (await one<{ phone: string }>(`SELECT phone FROM app_driver WHERE id = $1`, [acc]))!.phone;
    const { createHash } = await import('node:crypto');
    await query(`INSERT INTO driver_otp (phone, code_hash, expires_at, device_id) VALUES ($1, $2, now() + interval '5 minutes', $3)`,
      [phone, createHash('sha256').update('193746').digest('hex'), b.id]);
    assert.equal((await app.inject({ method: 'POST', url: '/d/v1/otp/verify', headers: auth(b.token), payload: { phone, code: '193746' } })).statusCode, 200);
    const status = await app.inject({ method: 'GET', url: `/d/v1/charge/${chargeId}/status`, headers: auth(b.token) });
    assert.equal(status.statusCode, 200, status.body);
  });
});

dbDescribe('another device cannot reach a driver\'s things', () => {
  test('charge status, start, stop, receipt, pay-unpaid, reservation, favourite, card and queue place: not found', async () => {
    const a = await device();
    const accA = await signIn(a.token, a.id);
    const b = await device();
    await signIn(b.token, b.id);
    const c = await prepaid(a.token, null);
    assert.equal(c.statusCode, 200, c.body);
    const chargeId = (c.json() as { chargeId: string }).chargeId;
    const get = (url: string) => app.inject({ method: 'GET', url, headers: auth(b.token) });
    const post = (url: string, payload: unknown = {}) => app.inject({ method: 'POST', url, headers: auth(b.token), payload: payload as object });
    // A's own device sees its charge (the control).
    assert.equal((await app.inject({ method: 'GET', url: `/d/v1/charge/${chargeId}/status`, headers: auth(a.token) })).statusCode, 200);
    assert.equal((await get(`/d/v1/charge/${chargeId}/status`)).statusCode, 404);
    assert.equal((await get(`/d/v1/charge/${chargeId}/receipt`)).statusCode, 404);
    assert.equal((await get(`/d/v1/charge/${chargeId}/receipt.html`)).statusCode, 404);
    const stop = await post(`/d/v1/charge/${chargeId}/stop`);
    assert.equal(stop.statusCode, 400);
    assert.match(stop.json().error, /tidak ditemukan/);
    const start = await post(`/d/v1/charge/${chargeId}/start`);
    assert.equal(start.statusCode, 400);
    assert.match(start.json().error, /tidak ditemukan/);
    assert.equal((await get(`/d/v1/charge/${chargeId}/pay-unpaid`)).statusCode, 404);
    assert.ok([404, 409].includes((await post(`/d/v1/charge/${chargeId}/pay-unpaid`)).statusCode));
    const hist = (await get('/d/v1/history')).json() as { charges: Array<{ chargeId?: string; id?: string }> };
    assert.ok(!JSON.stringify(hist).includes(chargeId), 'not in B\'s history');

    // A reservation, a favourite, a saved card and a queue place of A's.
    const cp = (await one<{ id: string }>(`SELECT cp.id FROM charge_point cp WHERE cp.site_id = $1`, [site]))!.id;
    const tok = (await one<{ id: string }>(`INSERT INTO token (org_id, uid, kind, status) VALUES ($1, $2, 'prepaid', 'Accepted') RETURNING id`, [org, `RS-${TAG}-${randomBytes(3).toString('hex')}`]))!.id;
    const res = (await one<{ id: string }>(
      `INSERT INTO driver_reservation (org_id, device_id, app_driver_id, token_id, connector_uuid, charge_point_id, connector_no, state, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,1,'active', now() + interval '10 minutes') RETURNING id`, [org, a.id, accA, tok, conn, cp]))!.id;
    const r1 = await post(`/d/v1/reservations/${res}/cancel`);
    assert.equal(r1.statusCode, 404);
    assert.equal((await one<{ state: string }>(`SELECT state FROM driver_reservation WHERE id = $1`, [res]))!.state, 'active');
    const fav = (await one<{ id: string }>(`INSERT INTO driver_favourite (device_id, app_driver_id, site_id) VALUES ($1,$2,$3) RETURNING id`, [a.id, accA, site]))!.id;
    assert.equal((await app.inject({ method: 'DELETE', url: `/d/v1/favourites/${fav}`, headers: auth(b.token) })).statusCode, 404);
    assert.ok(await one(`SELECT 1 FROM driver_favourite WHERE id = $1`, [fav]));
    const card = (await one<{ id: string }>(
      `INSERT INTO driver_card (app_driver_id, provider, token_sealed, token_hash, last4) VALUES ($1,'mock','sealed',$2,'4242') RETURNING id`, [accA, `h-${randomUUID()}`]))!.id;
    assert.equal((await app.inject({ method: 'DELETE', url: `/d/v1/cards/${card}`, headers: auth(b.token) })).statusCode, 404);
    assert.equal((await one<{ removed_at: Date | null }>(`SELECT removed_at FROM driver_card WHERE id = $1`, [card]))!.removed_at, null);
    const cards = (await get('/d/v1/cards')).json() as { cards: Array<{ id: string }> };
    assert.ok(!cards.cards.some((x) => x.id === card));
    const q = (await one<{ id: string }>(`INSERT INTO driver_queue_entry (org_id, site_id, device_id, app_driver_id, state) VALUES ($1,$2,$3,$4,'waiting') RETURNING id`, [org, site, a.id, accA]))!.id;
    assert.equal((await post(`/d/v1/queue/${q}/leave`)).statusCode, 404);
    assert.equal((await one<{ state: string }>(`SELECT state FROM driver_queue_entry WHERE id = $1`, [q]))!.state, 'waiting');
    await query(`UPDATE driver_reservation SET state = 'cancelled' WHERE id = $1`, [res]);
  });
});

dbDescribe('App Review sign-in (DRIVER_REVIEW_PHONE / DRIVER_REVIEW_CODE)', () => {
  test('the review number gets the fixed code without any provider, verify works, every limit still applies, deletion codes too', async () => {
    const phone = `+62857${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    phones.push(phone);
    const saved = config.driverApp.review;
    config.driverApp.review = { phone, code: '583920' };
    try {
      const a = await device();
      const send = (token: string, p = phone) => app.inject({ method: 'POST', url: '/d/v1/otp/send', headers: auth(token), payload: { phone: p } });
      const r = await send(a.token);
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().devCode, undefined, 'no provider was asked (the development provider hands its code back)');
      const row = await one<{ device_id: string; ttl: number }>(
        `SELECT device_id, extract(epoch FROM expires_at - created_at)::int AS ttl FROM driver_otp WHERE phone = $1 ORDER BY created_at DESC LIMIT 1`, [phone]);
      assert.equal(row!.device_id, a.id, 'bound to the requesting device');
      assert.ok(row!.ttl > 250 && row!.ttl <= 300, 'the same expiry as a real code');
      // The one-a-minute limit applies as to any number.
      assert.equal((await send(a.token)).statusCode, 429);
      // Another device cannot use the code this device asked for.
      const b = await device();
      assert.equal((await app.inject({ method: 'POST', url: '/d/v1/otp/verify', headers: auth(b.token), payload: { phone, code: '583920' } })).statusCode, 400);
      const ok = await app.inject({ method: 'POST', url: '/d/v1/otp/verify', headers: auth(a.token), payload: { phone, code: '583920' } });
      assert.equal(ok.statusCode, 200, ok.body);
      // Another number still goes to the provider.
      const other = `+62857${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
      phones.push(other);
      const o = await send(b.token, other);
      assert.equal(o.statusCode, 200);
      assert.match(String(o.json().devCode), /^\d{6}$/);
      // Account deletion (signed in): the code is the fixed one as well.
      await query(`UPDATE driver_auth_limit SET last_at = now() - interval '2 minutes' WHERE key = $1`, [`otp-phone:${phone}`]);
      const start = await app.inject({ method: 'POST', url: '/d/v1/account/delete/start', headers: auth(a.token), payload: {} });
      assert.equal(start.statusCode, 200, start.body);
      assert.equal(start.json().devCode, undefined);
      const del = await app.inject({ method: 'POST', url: '/d/v1/account/delete', headers: auth(a.token), payload: { code: '583920' } });
      assert.equal(del.statusCode, 200, del.body);
    } finally {
      config.driverApp.review = saved;
    }
  });
});

dbDescribe('starting a charge that already started', () => {
  test('400 with the same text as before, and code already_started', async () => {
    const d = await device();
    const c = await prepaid(d.token, null);
    assert.equal(c.statusCode, 200, c.body);
    const chargeId = (c.json() as { chargeId: string }).chargeId;
    const cp = (await one<{ id: string }>(`SELECT cp.id FROM charge_point cp WHERE cp.site_id = $1`, [site]))!.id;
    const tok = (await one<{ token_id: string }>(`SELECT token_id FROM driver_charge WHERE id = $1`, [chargeId]))!.token_id;
    const s = (await one<{ id: string }>(
      `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, token_id, state, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active', now()) RETURNING id`, [org, site, conn, cp, `fx-${randomUUID()}`, tok]))!.id;
    await query(`UPDATE driver_charge SET session_id = $2 WHERE id = $1`, [chargeId, s]);
    const r = await app.inject({ method: 'POST', url: `/d/v1/charge/${chargeId}/start`, headers: auth(d.token) });
    assert.equal(r.statusCode, 400);
    assert.deepEqual(r.json(), { ok: false, error: 'Sesi ini sudah dimulai.', code: 'already_started' });
    await query(`UPDATE driver_charge SET session_id = NULL WHERE id = $1`, [chargeId]);
    await query(`DELETE FROM charging_session WHERE id = $1`, [s]);
  });
});
