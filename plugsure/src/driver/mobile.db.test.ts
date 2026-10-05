import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * The mobile app's backend against the database (docs/MOBILE-APP-SPEC.md G1, G4, G5, G7):
 *   - batched headline prices equal the one-connector-at-a-time resolution (connector > site > org, AC/DC-only,
 *     closed assignments, PLN formula, per-country tariffs, the regulated default) and listStations' viewport;
 *   - the PlugSure Mobility organisation: set up idempotently, not counted as the unbranded eMSP;
 *   - partner locations of a hosted operator that joined the hub are left out (dedupe), external ones kept;
 *   - account deletion: blockers, then anonymisation (devices revoked, cards erased, receipts kept).
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/driver/mobile.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { headlinePrices } = await import('../services/tariff-store.js');
const { pricesOneByOne, listStations } = await import('./stations.js');
const { setupMobility } = await import('../services/mobility.js');
const { emspOrgForApp } = await import('./roaming-pay.js');
const { roamingStationsOf } = await import('./roaming.js');
const { issueDevice, authenticateDriver } = await import('./identity.js');
const { startDeletion, confirmDeletion, deletionBlockers, wasDeleted, withDriverLock, anonymise } = await import('./account-deletion.js');
const { networkBrand, forgetBrands } = await import('../services/brand.js');

const TAG = randomBytes(3).toString('hex');
const PID = `Q${randomBytes(1).toString('hex').toUpperCase()}`.slice(0, 3).padEnd(3, '9');
let org = '';
const sites: Record<string, string> = {};
const conns: Record<string, string> = {};
let mobilityOrg = '';
let partnerId = '';

async function site(name: string, country: string, lat: number, lon: number) {
  return (await one<{ id: string }>(
    `INSERT INTO site (org_id, name, country_code, lat, lon, timezone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [org, `${name} ${TAG}`, country, lat, lon, country === 'MY' ? 'Asia/Kuala_Lumpur' : country === 'SG' ? 'Asia/Singapore' : 'Asia/Jakarta']))!.id;
}
async function connector(siteId: string, ident: string, current: 'AC' | 'DC') {
  const cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, status) VALUES ($1,$2,'offline') RETURNING id`, [siteId, `${ident}-${TAG}`]))!.id;
  const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1,1,60000) RETURNING id`, [cp]))!.id;
  return (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w) VALUES ($1,1,$2,$3,60000) RETURNING id`,
    [e, current === 'DC' ? 'cCCS2' : 'sType2', current]))!.id;
}
async function tariff(name: string, opts: { country?: string; currency?: string; energy?: number | null; pln?: [string, number]; inclusive?: boolean }) {
  const t = (await one<{ id: string }>(
    `INSERT INTO tariff (org_id, name, pln_scheme, pln_multiplier, country_code, currency, prices_include_tax) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [org, `${name} ${TAG}`, opts.pln?.[0] ?? 'none', opts.pln?.[1] ?? null, opts.country ?? 'ID', opts.currency ?? 'IDR', opts.inclusive ?? false]))!.id;
  if (opts.energy !== undefined) await query(`INSERT INTO tariff_component (tariff_id, kind, rate) VALUES ($1,'energy',$2)`, [t, opts.energy]);
  return t;
}
const assign = (t: string, scope: string, id: string | null, extra: { current?: string; closed?: boolean } = {}) =>
  query(`INSERT INTO tariff_assignment (tariff_id, scope_type, scope_id, current_type, valid_from, valid_to) VALUES ($1,$2,$3,$4, now() - interval '2 days', $5)`,
    [t, scope, id, extra.current ?? null, extra.closed ? new Date(Date.now() - 86_400_000) : null]);

async function cleanup() {
  if (!org) return;
  await query(`DELETE FROM driver_queue_entry WHERE org_id = $1`, [org]);
  await query(`DELETE FROM ocpi_remote_location WHERE partner_id = $1`, [partnerId || null]);
  await query(`DELETE FROM ocpi_partner WHERE id = $1`, [partnerId || null]);
  await query(`DELETE FROM tariff_assignment WHERE tariff_id IN (SELECT id FROM tariff WHERE org_id = $1)`, [org]);
  await query(`DELETE FROM tariff_component WHERE tariff_id IN (SELECT id FROM tariff WHERE org_id = $1)`, [org]);
  await query(`DELETE FROM tariff WHERE org_id = $1`, [org]);
  await query(`DELETE FROM connector WHERE evse_uuid IN (SELECT e.id FROM evse e JOIN charge_point cp ON cp.id = e.charge_point_id JOIN site s ON s.id = cp.site_id WHERE s.org_id = $1)`, [org]);
  await query(`DELETE FROM evse WHERE charge_point_id IN (SELECT cp.id FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE s.org_id = $1)`, [org]);
  await query(`DELETE FROM charge_point WHERE site_id IN (SELECT id FROM site WHERE org_id = $1)`, [org]);
  await query(`DELETE FROM site WHERE org_id = $1`, [org]);
  await query(`DELETE FROM ocpi_party WHERE org_id = $1`, [org]);
  await query(`DELETE FROM organisation WHERE id = $1`, [org]);
}

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1,$2) RETURNING id`, [`Mobile Test ${TAG}`, `mobile-test-${TAG}`]))!.id;
    sites.a = await site('A', 'ID', -6.20, 106.80);
    sites.b = await site('B', 'ID', -6.25, 106.85);
    sites.my = await site('KL', 'MY', 3.15, 101.71);
    sites.sg = await site('SG', 'SG', 1.29, 103.85);
    conns.a1 = await connector(sites.a, 'MT-A1', 'DC');
    conns.a2 = await connector(sites.a, 'MT-A2', 'AC');
    conns.a3 = await connector(sites.a, 'MT-A3', 'DC');
    conns.b1 = await connector(sites.b, 'MT-B1', 'DC');
    conns.my1 = await connector(sites.my, 'MT-MY1', 'DC');
    conns.sg1 = await connector(sites.sg, 'MT-SG1', 'AC');
    const t1 = await tariff('T1 connector', { energy: 3000 });
    const t2 = await tariff('T2 site', { energy: 2500 });
    const t3 = await tariff('T3 site AC', { energy: 2000 });
    const t4 = await tariff('T4 closed', { energy: 100 });
    const t5 = await tariff('T5 formula', { energy: null, pln: ['curah', 1.2] });
    const tOrg = await tariff('T org IDR', { energy: 2700 });
    const tMy = await tariff('T MY', { country: 'MY', currency: 'MYR', energy: 1.1, inclusive: true });
    await assign(t1, 'connector', conns.a1!);
    await assign(t2, 'site', sites.a!);
    await assign(t3, 'site', sites.a!, { current: 'AC' });
    await assign(t4, 'connector', conns.b1!, { closed: true });
    await assign(t5, 'site', sites.b!);
    await assign(tOrg, 'org', org);
    await assign(tMy, 'site', sites.my!);
    await query(`INSERT INTO ocpi_party (org_id, country_code, party_id, business_name, is_home) VALUES ($1,'ID',$2,'Mobile Test',true)`, [org, PID]);
  });
  after(async () => {
    await cleanup();
    await pool.end();
  });
}

dbDescribe('batched headline prices (G7)', () => {
  test('equal to the one-at-a-time resolution for every connector, and as specified', async () => {
    const all = await many<{ id: string; org_id: string }>(
      `SELECT c.id, s.org_id FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id JOIN site s ON s.id = cp.site_id`);
    const at = new Date();
    const batch = await headlinePrices(all.map((r) => r.id), at);
    const single = await pricesOneByOne(all.map((r) => ({ connectorId: r.id, orgId: r.org_id })));
    for (const r of all) assert.deepEqual(batch.get(r.id), single.get(r.id) ?? undefined, `connector ${r.id}`);
    assert.equal(batch.get(conns.a1!)!.rate, 3000, 'connector beats site');
    assert.equal(batch.get(conns.a2!)!.rate, 2000, 'an AC-only site assignment beats the any-current one');
    assert.equal(batch.get(conns.a3!)!.rate, 2500);
    assert.equal(Math.round(batch.get(conns.b1!)!.rate!), Math.round(config.regulatory.id.curahBase * 1.2), 'closed assignment ignored; PLN formula');
    assert.deepEqual(batch.get(conns.my1!), { rate: 1.1, inclusive: true }, 'the MY site: its own tariff, not the org-wide IDR one');
    assert.deepEqual(batch.get(conns.sg1!), { rate: null, inclusive: false }, 'SG with nothing assigned: no price (fail closed)');
  });

  test('listStations: the viewport only, same prices', async () => {
    const box = [106.7, -6.3, 106.9, -6.1] as const;
    const inBox = await listStations(undefined, org, { bbox: box });
    assert.deepEqual(inBox.map((s) => s.siteId).sort(), [sites.a, sites.b].sort());
    const a = inBox.find((s) => s.siteId === sites.a)!;
    assert.equal(a.priceFromMinor, 2000);
    const every = await listStations(undefined, org);
    assert.equal(every.length, 4);
  });
});

dbDescribe('PlugSure Mobility (G1) and duplicate stations (G5)', () => {
  test('set up idempotently; its organisation is the network brand\'s, and not the unbranded eMSP', async () => {
    const first = await setupMobility({});
    const again = await setupMobility({});
    assert.equal(first.orgId, again.orgId);
    mobilityOrg = first.orgId;
    forgetBrands();
    const nb = await networkBrand();
    assert.equal(nb?.orgId, mobilityOrg);
    assert.equal(nb?.scope, 'network');
    assert.equal(nb?.slug, 'plugsure');
    assert.equal(await emspOrgForApp(mobilityOrg), mobilityOrg);
    assert.notEqual(await emspOrgForApp(null), mobilityOrg);
    const parties = await many<{ p: string }>(`SELECT country_code || '*' || party_id AS p FROM ocpi_party WHERE org_id = $1 ORDER BY is_home DESC, country_code`, [mobilityOrg]);
    assert.ok(parties.length >= 1);
  });

  test('an organisation with its own operator app is refused (nothing written) unless converting is explicit (v1.9.0)', async () => {
    const o = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ('Own App Op', $1) RETURNING id`, [`own-app-${TAG}`]))!.id;
    await query(`INSERT INTO driver_app_brand (org_id, slug, app_name, short_name) VALUES ($1, $2, 'Own App', 'Own')`, [o, `own-${TAG}`]);
    await assert.rejects(setupMobility({ orgId: o }), /already has its own driver app/);
    const after = await one<{ scope: string; slug: string; roaming: unknown }>(
      `SELECT b.scope, b.slug, o.roaming_settings->'appDrivers' AS roaming FROM driver_app_brand b JOIN organisation o ON o.id = b.org_id WHERE b.org_id = $1`, [o]);
    assert.deepEqual([after?.scope, after?.slug, after?.roaming ?? null], ['operator', `own-${TAG}`, null], 'unchanged: still the operator\'s app');
    assert.equal(await one(`SELECT 1 FROM ocpi_party WHERE org_id = $1`, [o]), null, 'no parties written');
    await query(`DELETE FROM driver_app_brand WHERE org_id = $1`, [o]);
    await query(`DELETE FROM organisation WHERE id = $1`, [o]);
  });

  test('a hosted operator\'s locations that came back through the hub are left out; an external CPO\'s stay', async () => {
    partnerId = (await one<{ id: string }>(`INSERT INTO ocpi_partner (org_id, name, kind, state) VALUES ($1, $2, 'hub', 'connected') RETURNING id`, [mobilityOrg, `Hub ${TAG}`]))!.id;
    const loc = (id: string, name: string) => ({
      id, name, country_code: 'ID', publish: true, coordinates: { latitude: '-6.2', longitude: '106.8' },
      evses: [{ uid: `${id}-E1`, evse_id: `ID*X*E${id}`, status: 'AVAILABLE', connectors: [{ id: '1', standard: 'IEC_62196_T2_COMBO', power_type: 'DC', max_electric_power: 60000, tariff_ids: [] }] }],
    });
    await query(`INSERT INTO ocpi_remote_location (org_id, partner_id, country_code, party_id, location_id, data, last_updated) VALUES ($1,$2,'ID',$3,'HOSTED1',$4, now()), ($1,$2,'ID','ZZ9','EXT1',$5, now())`,
      [mobilityOrg, partnerId, PID, JSON.stringify(loc('HOSTED1', `Hosted ${TAG}`)), JSON.stringify(loc('EXT1', `External ${TAG}`))]);
    const deduped = (await roamingStationsOf(mobilityOrg, { mode: 'guest' }, undefined, { dedupe: true })).filter((s) => s.partnerId === partnerId);
    const all = (await roamingStationsOf(mobilityOrg, { mode: 'guest' }, undefined, {})).filter((s) => s.partnerId === partnerId);
    assert.deepEqual(deduped.map((s) => s.locationId), ['EXT1']);
    assert.deepEqual(all.map((s) => s.locationId).sort(), ['EXT1', 'HOSTED1']);
    // Guests see them, not startable: sign in first.
    assert.equal(deduped[0]!.startable, false);
    assert.equal(deduped[0]!.reasonCode, 'sign_in');
  });

  test('partner locations are cached in memory and reloaded when a location changes (any writer); the viewport filters before building', async () => {
    const { partnerCacheStats, forgetPartnerLocations } = await import('./roaming.js');
    forgetPartnerLocations();
    const mine = async (o: Record<string, unknown> = {}) => (await roamingStationsOf(mobilityOrg, { mode: 'guest' }, undefined, o)).filter((s) => s.partnerId === partnerId);
    const loads0 = partnerCacheStats.loads;
    await mine();
    const hits0 = partnerCacheStats.hits;
    await mine();
    assert.equal(partnerCacheStats.loads, loads0 + 1, 'the second call is served from memory');
    assert.equal(partnerCacheStats.hits, hits0 + 1);
    // Another process (or a test) changes a location directly: seen at once (row version), no TTL wait.
    await query(`UPDATE ocpi_remote_location SET data = jsonb_set(data, '{name}', '"Renamed ${TAG}"') WHERE partner_id = $1 AND location_id = 'EXT1'`, [partnerId]);
    assert.equal((await mine()).find((s) => s.locationId === 'EXT1')?.name, `Renamed ${TAG}`);
    assert.equal(partnerCacheStats.loads, loads0 + 2);
    // A viewport elsewhere builds nothing of these.
    assert.deepEqual(await mine({ bbox: [100, 1, 101, 2] }), []);
    assert.equal((await mine({ bbox: [106.7, -6.3, 106.9, -6.1] })).length, 2);
  });
});

dbDescribe('account deletion (G4)', () => {
  test('a queue place created while the deletion waits for the driver\'s lock is seen: the deletion is refused, not racing it', async () => {
    const phone = `+62813${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    const dev = await issueDevice('mobile-race');
    const acc = (await one<{ id: string }>(`INSERT INTO app_driver (phone) VALUES ($1) RETURNING id`, [phone]))!.id;
    await query(`UPDATE driver_device SET app_driver_id = $2 WHERE id = $1`, [dev.deviceId, acc]);
    const p = (await authenticateDriver({ authorization: `Bearer ${dev.deviceToken}` }))!;
    const s1 = await startDeletion(p, null, {});
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    // A "join the queue" request holds the lock (as the route does) and creates its place while the deletion waits.
    const creating = withDriverLock(acc, async () => {
      entered();
      await held;
      await query(`INSERT INTO driver_queue_entry (org_id, site_id, device_id, app_driver_id) VALUES ($1,$2,$3,$4)`, [org, sites.a, dev.deviceId, acc]);
    });
    await inside;
    const deleting = confirmDeletion(p, null, (s1 as { devCode?: string }).devCode ?? '', 'app');
    await new Promise((r) => setTimeout(r, 150));
    release();
    await creating;
    const r = await deleting;
    assert.equal(r.ok, false, 'refused: the queue place was created before the deletion checked');
    assert.equal((r as { body: { code: string } }).body.code, 'in_queue');
    assert.equal(await wasDeleted(phone), false);
  });

  test('refused while a queue place is open; then deleted: anonymised, devices revoked, cards erased, history kept', async () => {
    const phone = `+62812${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    const dev = await issueDevice('mobile-test');
    const other = await issueDevice('mobile-test-2');
    const acc = (await one<{ id: string }>(`INSERT INTO app_driver (phone, name, email) VALUES ($1, 'Rina', 'rina@example.com') RETURNING id`, [phone]))!.id;
    await query(`UPDATE driver_device SET app_driver_id = $2 WHERE id = ANY($1::uuid[])`, [[dev.deviceId, other.deviceId], acc]);
    await query(`INSERT INTO driver_card (app_driver_id, provider, token_sealed, token_hash, brand, last4) VALUES ($1,'mock','enc:v1:x','h-${TAG}','VISA','4242')`, [acc]);
    await query(`INSERT INTO driver_favourite (device_id, app_driver_id, site_id) VALUES ($1,$2,$3)`, [dev.deviceId, acc, sites.a]);
    const q = (await one<{ id: string }>(`INSERT INTO driver_queue_entry (org_id, site_id, device_id, app_driver_id) VALUES ($1,$2,$3,$4) RETURNING id`, [org, sites.a, dev.deviceId, acc]))!.id;

    const p = (await authenticateDriver({ authorization: `Bearer ${dev.deviceToken}` }))!;
    assert.equal(p.account?.id, acc);
    assert.deepEqual((await deletionBlockers(acc, dev.deviceId)).map((b) => b.code), ['in_queue']);
    const s1 = await startDeletion(p, null, {});
    assert.ok(s1.ok);
    const blocked = await confirmDeletion(p, null, (s1 as { devCode?: string }).devCode ?? '', 'app');
    assert.equal(blocked.ok, false);
    assert.equal((blocked as { status: number }).status, 409);
    assert.equal((blocked as { body: { code: string } }).body.code, 'in_queue');
    assert.equal((await one<{ status: string }>(`SELECT status FROM app_driver WHERE id = $1`, [acc]))!.status, 'active', 'nothing changed');

    await query(`UPDATE driver_queue_entry SET state = 'left', ended_at = now() WHERE id = $1`, [q]);
    // A new code (the first was used): one a minute per number, so the counter for the number is cleared for the test.
    await query(`DELETE FROM driver_auth_limit WHERE position($1 in key) > 0`, [phone]);
    const s2 = await startDeletion(p, null, {});
    assert.ok(s2.ok, JSON.stringify(s2));
    const wrong = await confirmDeletion(p, null, '000000' === (s2 as { devCode?: string }).devCode ? '111111' : '000000', 'app');
    assert.equal((wrong as { status: number }).status, 400);
    const done = await confirmDeletion(p, null, (s2 as { devCode?: string }).devCode ?? '', 'app');
    assert.ok(done.ok, JSON.stringify(done));

    const row = (await one<{ phone: string; name: string | null; email: string | null; status: string; deleted_at: Date | null }>(`SELECT phone, name, email, status, deleted_at FROM app_driver WHERE id = $1`, [acc]))!;
    assert.match(row.phone, /^deleted:[0-9a-f]{64}$/);
    assert.equal(row.name, null);
    assert.equal(row.email, null);
    assert.equal(row.status, 'deleted');
    assert.ok(row.deleted_at);
    assert.equal(await authenticateDriver({ authorization: `Bearer ${dev.deviceToken}` }), null, 'device token revoked');
    assert.equal(await authenticateDriver({ authorization: `Bearer ${other.deviceToken}` }), null, 'every device of the account');
    const card = (await one<{ token_sealed: string; removed_at: Date | null; last4: string }>(`SELECT token_sealed, removed_at, last4 FROM driver_card WHERE app_driver_id = $1`, [acc]))!;
    assert.equal(card.token_sealed, 'erased');
    assert.ok(card.removed_at);
    assert.equal(Number((await one<{ n: number }>(`SELECT count(*)::int AS n FROM driver_favourite WHERE app_driver_id = $1`, [acc]))!.n), 0);
    assert.equal(Number((await one<{ n: number }>(`SELECT count(*)::int AS n FROM app_driver_deletion WHERE app_driver_id = $1 AND via = 'app'`, [acc]))!.n), 1);
    assert.ok(await wasDeleted(phone));
    // The number can sign up again: a new, empty account.
    assert.equal(await one(`SELECT 1 FROM app_driver WHERE phone = $1`, [phone]), null);
  });

  test('the web form (v1.9.0): a stranger who types a number learns nothing before the code — no blockers, the same answer and the same limits whether or not it has an account', async () => {
    const phone = `+62814${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    const owner = await issueDevice('mobile-web-owner');
    const acc = (await one<{ id: string }>(`INSERT INTO app_driver (phone) VALUES ($1) RETURNING id`, [phone]))!.id;
    await query(`UPDATE driver_device SET app_driver_id = $2 WHERE id = $1`, [owner.deviceId, acc]);
    await query(`INSERT INTO driver_queue_entry (org_id, site_id, device_id, app_driver_id) VALUES ($1,$2,$3,$4)`, [org, sites.a, owner.deviceId, acc]);
    assert.deepEqual((await deletionBlockers(acc, owner.deviceId)).map((b) => b.code), ['in_queue'], 'the account does have a blocker');

    const stranger = await issueDevice('mobile-web-stranger');
    const sp = (await authenticateDriver({ authorization: `Bearer ${stranger.deviceToken}` }))!;
    const withAcc = await startDeletion(sp, phone, {});
    assert.ok(withAcc.ok, JSON.stringify(withAcc));
    assert.deepEqual((withAcc as { blockers: unknown[] }).blockers, [], 'no unpaid charges, sessions or queue places before the code');
    const none = `+62815${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    const noAcc = await startDeletion(sp, none, {});
    assert.ok(noAcc.ok);
    const shape = (r: object) => Object.keys(r).filter((k) => k !== 'devCode' && k !== 'phoneMasked').sort();
    assert.deepEqual(shape(withAcc), shape(noAcc), 'the same answer either way');
    // The per-number limit applies to both (a second request inside the minute is refused, account or not).
    const again1 = await startDeletion(sp, phone, {});
    const again2 = await startDeletion(sp, none, {});
    assert.deepEqual([again1.ok, (again1 as { status?: number }).status, again2.ok, (again2 as { status?: number }).status], [false, 429, false, 429]);
    // The owner's blockers come only after the code proves the number (confirm answers 409 with them).
    const code = (withAcc as { devCode?: string }).devCode;
    if (code) {
      const blocked = await confirmDeletion(sp, phone, code, 'web');
      assert.equal((blocked as { status: number }).status, 409);
    }
  });

  test('deleting an account clears exactly its number\'s sign-in counters, not a longer number that starts with it (v1.9.0)', async () => {
    const phone = `+62816${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    const longer = `${phone}7`;
    const acc = (await one<{ id: string }>(`INSERT INTO app_driver (phone) VALUES ($1) RETURNING id`, [phone]))!.id;
    const keys = [`otp-phone:${phone}`, `otp-verify:${phone}:dev-1`, `otp-phone:${longer}`, `otp-verify:${longer}:dev-2`];
    for (const k of keys) await query(`INSERT INTO driver_auth_limit (key, hits) VALUES ($1, 3) ON CONFLICT (key) DO UPDATE SET hits = 3`, [k]);
    await anonymise(acc, phone, 'app');
    const left = (await many<{ key: string }>(`SELECT key FROM driver_auth_limit WHERE key = ANY($1::text[])`, [keys])).map((r) => r.key).sort();
    assert.deepEqual(left, [`otp-phone:${longer}`, `otp-verify:${longer}:dev-2`].sort());
    await query(`DELETE FROM driver_auth_limit WHERE key = ANY($1::text[])`, [keys]);
  });

  test('the web form: a number without an account gets the same answer and nothing is sent', async () => {
    const dev = await issueDevice('mobile-test-web');
    const p = (await authenticateDriver({ authorization: `Bearer ${dev.deviceToken}` }))!;
    // A fresh number each run: since v1.9.0 the per-number limit applies whether or not the number has an account.
    const r = await startDeletion(p, `+62899${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, {});
    assert.ok(r.ok);
    assert.equal((r as { devCode?: string }).devCode, undefined);
    assert.ok((r as { phoneMasked: string }).phoneMasked);
  });
});
