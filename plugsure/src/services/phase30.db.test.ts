import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignedXml } from 'xml-crypto';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { IDP_KEY, IDP_CERT } from '../../tools/testing/saml-idp-fixture.js';

/**
 * Phase 30 (v1.42.0), through the routes:
 *   - solar and battery: assets, the site key, readings in, the set-point out; what the load manager may count (only
 *     fresh, measured, at the trust share; the grid part at the peak-shaving target); energy, peak and savings;
 *   - charger health: faults, reboots, outages and failed starts make a charger at risk, with its reasons; the daily
 *     run keeps the day and raises (then resolves) the alert; a work order opened from it;
 *   - the report builder: specs validated against the catalogue, values as parameters (an injection attempt is just
 *     text), a dataset's permission, grouping, saved and scheduled reports, Excel, another organisation never seen;
 *   - SAML: the administrator's set-up (no administrator role by group, one domain per organisation), then a whole
 *     sign-in — start, the identity provider's signed answer, finish with the browser cookie — creating the user with
 *     the mapped role; a replay, another browser and an unsolicited answer refused.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/phase30.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerPhase30Routes } = await import('../api/phase30-routes.js');
const es = await import('./energy-storage.js');
const ch = await import('./charger-health.js');
const rb = await import('./report-builder.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID();
let org = '', org2 = '', site = '', site2 = '', cp = '', cp2 = '', ident = '';
let app: FastifyInstance;
let perms = ['site:read', 'site:write', 'charge_point:read', 'charge_point:write', 'session:read', 'payment:read', 'payment:write', 'user:read', 'user:write'];
let asOrg = () => org;
const HOST = 'csms.test';
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { host: HOST, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`P30 ${TAG}`, `p30-${TAG}`]))!.id;
    org2 = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`P30 other ${TAG}`, `p30o-${TAG}`]))!.id;
    await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, 'Admin')`, [A, org, `${TAG}-admin@p30.test`]);
    site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'ID') RETURNING id`, [org, `Solar ${TAG}`]))!.id;
    site2 = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'ID') RETURNING id`, [org2, `Other ${TAG}`]))!.id;
    ident = `P30-${TAG}`;
    cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, adopted_at, vendor, model) VALUES ($1, $2, now(), 'Acme', 'DC60') RETURNING id`, [site, ident]))!.id;
    cp2 = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, adopted_at) VALUES ($1, $2, now()) RETURNING id`, [site2, `P30O-${TAG}`]))!.id;
    await query(`INSERT INTO site_power_budget (site_id, ceiling_w, reserve_w) VALUES ($1, 150000, 10000)`, [site]);
    await query(`INSERT INTO site_tariff (site_id, org_id, tariff_class, power_kva, rate_peak, rate_offpeak, peak_from, peak_to, currency) VALUES ($1, $2, 'B-3', 200, 1500, 1000, 17, 22, 'IDR')`, [site, org]);
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: A, orgId: asOrg(), assignments: [{ permissions: perms, scopeType: 'org', scopeId: null }] };
    });
    await registerPhase30Routes(app);
  });
  after(async () => {
    await app?.close();
    for (const t of ['saml_user_link', 'saml_login_tx', 'org_saml_provider', 'report_definition', 'charger_health', 'site_energy_reading', 'site_energy_settings', 'site_energy_asset', 'work_order', 'alert'])
      await query(`DELETE FROM ${t} WHERE org_id = ANY($1::uuid[])`, [[org, org2]]);
    await query(`DELETE FROM ocpp_frame WHERE ocpp_identity = $1`, [ident]);
    await query(`DELETE FROM charge_point_outage WHERE charge_point_id = ANY($1::uuid[])`, [[cp, cp2]]);
    await query(`DELETE FROM charge_point WHERE id = ANY($1::uuid[])`, [[cp, cp2]]);
    await query(`DELETE FROM site_tariff WHERE site_id = $1`, [site]);
    await query(`DELETE FROM site_power_budget WHERE site_id = $1`, [site]);
    await query(`DELETE FROM site WHERE id = ANY($1::uuid[])`, [[site, site2]]);
    await query(`DELETE FROM auth_session WHERE user_id IN (SELECT id FROM app_user WHERE org_id = $1)`, [org]);
    await query(`DELETE FROM user_role WHERE user_id IN (SELECT id FROM app_user WHERE org_id = $1)`, [org]);
    await query(`DELETE FROM app_user WHERE org_id = ANY($1::uuid[])`, [[org, org2]]).catch(() => { /* audit rows keep them */ });
    await query(`DELETE FROM organisation WHERE id = ANY($1::uuid[])`, [[org, org2]]).catch(() => { /* audit rows keep them */ });
    await pool.end();
  });
}

describe('Solar, battery and health helpers', () => {
  const fleet = es.fleetOf([
    { id: '1', siteId: 's', kind: 'solar', name: 'Roof', capacityKw: 50, peakKwp: 60, energyKwh: null, minSocPct: null, maxSocPct: null, commissionedOn: null, costMinor: null, note: null },
    { id: '2', siteId: 's', kind: 'battery', name: 'BESS', capacityKw: 100, peakKwp: null, energyKwh: 200, minSocPct: 10, maxSocPct: 95, commissionedOn: null, costMinor: null, note: null },
  ]);
  const s = { siteId: 's', solarFirst: true, peakShaving: true, peakTargetKw: 80, trustPct: 80, maxAgeS: 120, ingestKeyHint: null };
  const now = Date.parse('2026-11-01T05:00:00Z');
  test('only fresh, measured output counts, at the trust share and within the installed power', () => {
    const r = { ts: now - 30_000, solarW: 70_000, batteryW: 40_000, batterySocPct: 60, gridW: 50_000 };
    assert.deepEqual(es.liveExtra(r, fleet, s, now), { extraW: 40_000 + 32_000, solarW: 40_000, batteryW: 32_000, fresh: true, ageS: 30, reason: 'measured solar and battery discharge' });
    assert.equal(es.liveExtra({ ...r, ts: now - 200_000 }, fleet, s, now).extraW, 0, 'a stale reading counts for nothing');
    assert.equal(es.liveExtra(r, fleet, { ...s, solarFirst: false }, now).solarW, 0);
    assert.equal(es.liveExtra({ ...r, batteryW: -20_000 }, fleet, s, now).batteryW, 0, 'a charging battery adds nothing');
    assert.equal(es.gridPartW(140_000, s), 80_000);
    assert.equal(es.gridPartW(60_000, s), 60_000);
    assert.equal(es.gridPartW(140_000, { ...s, peakShaving: false }), 140_000);
  });
  test('the battery: discharge to shave, charge from spare solar or off-peak, inside its SoC band', () => {
    const base = { gridPartW: 80_000, fleet, s, offPeak: false, fresh: true };
    const r = (soc: number, solar = 0) => ({ ts: now, solarW: solar, batteryW: 0, batterySocPct: soc, gridW: 0 });
    assert.deepEqual(es.setpoint({ ...base, demandW: 150_000, latest: r(60, 20_000) }).batteryW, 50_000);
    assert.equal(es.setpoint({ ...base, demandW: 300_000, latest: r(60) }).batteryW, 100_000, 'never above the battery power');
    assert.equal(es.setpoint({ ...base, demandW: 150_000, latest: r(10) }).mode, 'idle', 'not below the lower SoC limit');
    assert.deepEqual(es.setpoint({ ...base, demandW: 10_000, latest: r(50, 45_000) }), { batteryW: -35_000, mode: 'charge_solar', reason: 'solar the chargers do not use' });
    assert.equal(es.setpoint({ ...base, demandW: 10_000, latest: r(50), offPeak: true }).batteryW, -70_000);
    assert.equal(es.setpoint({ ...base, demandW: 10_000, latest: r(95, 45_000) }).mode, 'idle', 'full');
    assert.equal(es.setpoint({ ...base, demandW: 150_000, latest: r(60), fresh: false }).mode, 'idle', 'no recent state of charge: do nothing');
  });
  test('energy, self-consumption, the peak shaved and the savings at the tariff', () => {
    // 10:00–11:00 local (off-peak, 1,000/kWh): 40 kW solar, 10 kW exported, battery charging 20 kW, grid 0.
    // 18:00–19:00 local (peak, 1,500/kWh): battery discharging 30 kW, grid 60 kW.
    const tf = { ratePeak: 1500, rateOffpeak: 1000, peakFrom: 17, peakTo: 22, currency: 'IDR' };
    const t0 = Date.parse('2026-11-01T03:00:00Z'), t1 = Date.parse('2026-11-01T11:00:00Z');
    const rows = [
      { ts: t0, solarW: 40_000, batteryW: -20_000, batterySocPct: 50, gridW: -10_000 }, { ts: t0 + 900_000, solarW: 40_000, batteryW: -20_000, batterySocPct: 55, gridW: -10_000 },
      { ts: t0 + 1_800_000, solarW: 40_000, batteryW: -20_000, batterySocPct: 60, gridW: -10_000 }, { ts: t0 + 2_700_000, solarW: 40_000, batteryW: -20_000, batterySocPct: 65, gridW: -10_000 },
      { ts: t1, solarW: 0, batteryW: 30_000, batterySocPct: 65, gridW: 60_000 }, { ts: t1 + 900_000, solarW: 0, batteryW: 30_000, batterySocPct: 60, gridW: 60_000 },
      { ts: t1 + 1_800_000, solarW: 0, batteryW: 30_000, batterySocPct: 55, gridW: 60_000 }, { ts: t1 + 2_700_000, solarW: 0, batteryW: 30_000, batterySocPct: 50, gridW: 60_000 },
      { ts: t1 + 3_600_000, solarW: 0, batteryW: 0, batterySocPct: 50, gridW: 60_000 },
    ];
    const t = es.totals(rows, tf);
    // The 03:45 reading counts 15 minutes only (the next is hours away): 40 kWh solar over 4 × 15 min.
    assert.equal(t.solarKwh, 40);
    assert.equal(t.exportKwh, 10);
    assert.equal(t.solarUsedKwh, 30);
    assert.equal(t.selfConsumptionPct, 75);
    assert.equal(t.batteryInKwh, 20);
    assert.equal(t.batteryFromGridKwh, 0, 'all charging came from solar');
    assert.equal(t.batteryOutKwh, 30);
    assert.equal(t.peakGridKw, 60);
    assert.equal(t.peakWithoutBatteryKw, 90);
    assert.equal(t.peakShavedKw, 30);
    // Solar used directly: 30 − 20 into the battery = 10 kWh × 1,000; the battery's 30 kWh at peak × 1,500.
    assert.equal(t.savingsMajor, 10 * 1000 + 30 * 1500);
  });
  test('the health score and its risk', () => {
    const ok = { outages: 0, offlineHours: 0, faults: 0, recentFaults: 0, codes: {}, recentCodes: {}, reboots: 0, sessions: 20, failedStarts: 0, faultedNow: false, errorNow: null };
    assert.deepEqual([ch.scoreOf(ok).score, ch.scoreOf(ok).risk], [100, 'ok']);
    const recurring = ch.scoreOf({ ...ok, faults: 3, recentFaults: 3, codes: { GroundFailure: 3 }, recentCodes: { GroundFailure: 3 } });
    assert.equal(recurring.risk, 'at_risk');
    assert.match(recurring.reasons.join(' '), /GroundFailure 3 times in the last 7 days/);
    assert.equal(ch.scoreOf({ ...ok, faultedNow: true, errorNow: 'PowerMeterFailure' }).risk, 'at_risk');
    assert.equal(ch.scoreOf({ ...ok, outages: 1, offlineHours: 2 }).risk, 'watch');
    const worn = ch.scoreOf({ ...ok, outages: 4, offlineHours: 12, reboots: 6, faults: 4, recentFaults: 1, codes: { Other: 4 }, recentCodes: { Other: 1 }, failedStarts: 6 });
    assert.ok(worn.score < 60 && worn.risk === 'at_risk', JSON.stringify(worn));
  });
});

describe('Report builder: the spec', () => {
  test('only catalogue fields, operators and aggregations; values never in the SQL', () => {
    assert.throws(() => rb.validate('sessions', { columns: [{ field: 'password_hash' }] }), /not a field/);
    assert.throws(() => rb.validate('nope', {}), /dataset is one of/);
    assert.throws(() => rb.validate('chargers', { columns: [{ field: 'vendor', agg: 'sum' }] }), /needs a number field/);
    assert.throws(() => rb.validate('chargers', { groupBy: [{ field: 'site' }], columns: [{ field: 'vendor' }] }), /every column needs an aggregation/);
    assert.throws(() => rb.validate('chargers', { filters: [{ field: 'vendor', op: 'drop' }] }), /op is one of/);
    const evil = `x'); DROP TABLE site; --`;
    const { dataset, spec } = rb.validate('chargers', { columns: [{ field: 'charger' }], filters: [{ field: 'vendor', op: 'contains', value: evil }] });
    const c = rb.compile(dataset, spec, '00000000-0000-4000-8000-000000000000');
    assert.ok(!c.sql.includes('DROP') && c.params.some((p) => String(p).includes('DROP TABLE')), 'the value is a parameter');
    assert.match(c.sql, /s\.org_id = \$1/);
  });
});

dbDescribe('Phase 30 through the routes', () => {
  test('solar and battery: assets, the key, readings, the set-point, the load manager and the results', async () => {
    const solar = await call('POST', '/v1/energy/assets', { siteId: site, kind: 'solar', name: 'Carport PV', capacityKw: 50, peakKwp: 60 });
    assert.equal(solar.statusCode, 201, solar.body);
    const bat = await call('POST', '/v1/energy/assets', { siteId: site, kind: 'battery', name: 'BESS', capacityKw: 100, energyKwh: 200, minSocPct: 10, maxSocPct: 95 });
    assert.equal(bat.statusCode, 201, bat.body);
    assert.equal((await call('POST', '/v1/energy/assets', { siteId: site, kind: 'battery', name: 'Bad', capacityKw: 10, energyKwh: 10, minSocPct: 90, maxSocPct: 20 })).statusCode, 422);
    assert.equal((await call('POST', '/v1/energy/assets', { siteId: site2, kind: 'solar', name: 'Not mine', capacityKw: 5 })).statusCode, 404, 'another organisation\'s site');
    assert.equal((await call('PUT', `/v1/energy/sites/${site}/settings`, { peakShaving: true })).statusCode, 422, 'peak shaving needs a target');
    const st = await call('PUT', `/v1/energy/sites/${site}/settings`, { peakShaving: true, peakTargetKw: 80 });
    assert.equal(st.statusCode, 200, st.body);
    const key = (await call('POST', `/v1/energy/sites/${site}/key`)).json().key as string;
    assert.match(key, /^pse_/);

    // Before any reading the load manager counts nothing extra; the grid part is held at the target.
    let lm = await es.forLoadManager(site, 140_000);
    assert.deepEqual([lm.gridW, lm.extra.extraW, lm.active], [80_000, 0, true]);

    assert.equal((await call('POST', `/v1/energy/sites/${site}/readings`, { ts: new Date().toISOString(), solarW: 1 }, { authorization: 'Bearer pse_wrong' })).statusCode, 401);
    const now = Date.now();
    const posted = await call('POST', `/v1/energy/sites/${site}/readings`, {
      readings: [{ ts: new Date(now - 60_000).toISOString(), solarW: 30_000, batteryW: 0, batterySocPct: 70, gridW: 20_000 }, { ts: new Date(now - 10_000).toISOString(), solarW: 35_000, batteryW: 25_000, batterySocPct: 69, gridW: 40_000 }],
    }, { authorization: `Bearer ${key}` });
    assert.equal(posted.statusCode, 200, posted.body);
    assert.equal(posted.json().accepted, 2);
    assert.ok(['idle', 'discharge', 'charge_solar', 'charge_offpeak'].includes(posted.json().setpoint.mode));
    const again = await call('POST', `/v1/energy/sites/${site}/readings`, { ts: new Date(now - 10_000).toISOString(), solarW: 1 }, { 'x-site-key': key });
    assert.deepEqual([again.json().accepted, again.json().duplicates], [0, 1], 'a reading is kept once');

    lm = await es.forLoadManager(site, 140_000);
    assert.deepEqual([lm.gridW, lm.extra.solarW, lm.extra.batteryW, lm.gridW + lm.extra.extraW], [80_000, 28_000, 20_000, 128_000]);
    lm = await es.forLoadManager(site, 140_000, now + 10 * 60_000);
    assert.equal(lm.extra.extraW, 0, 'ten minutes later the readings are stale');

    const ov = (await call('GET', '/v1/energy')).json();
    const mine = ov.sites.find((x: any) => x.siteId === site);
    assert.equal(mine.assets.length, 2);
    assert.equal(mine.loadManager.gridPartW, 80_000);
    const res = await call('GET', `/v1/energy/sites/${site}/results`);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().totals.readings, 2);
    assert.equal(res.json().currency, 'IDR');
  });

  test('charger health: at risk with its reasons, the daily run, the alert and a work order', async () => {
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    for (const n of [1, 2, 3]) {
      await query(`INSERT INTO ocpp_frame (charge_point_id, ocpp_identity, ts, direction, message_type, action, payload) VALUES ($1, $2, $3, 'in', 2, 'StatusNotification', $4)`,
        [cp, ident, day(n), JSON.stringify({ connectorId: 1, status: 'Faulted', errorCode: 'GroundFailure' })]);
    }
    await query(`INSERT INTO ocpp_frame (charge_point_id, ocpp_identity, ts, direction, message_type, action, payload) VALUES ($1, $2, $3, 'in', 2, 'StatusNotification', $4)`,
      [cp, ident, day(1), JSON.stringify({ connectorId: 1, status: 'Available', errorCode: 'NoError' })]);
    for (const n of [4, 10, 20]) await query(`INSERT INTO ocpp_frame (charge_point_id, ocpp_identity, ts, direction, message_type, action, payload) VALUES ($1, $2, $3, 'in', 2, 'BootNotification', '{}')`, [cp, ident, day(n)]);
    await query(`INSERT INTO charge_point_outage (org_id, charge_point_id, went_offline_at, came_online_at) VALUES ($1, $2, $3, $4)`, [org, cp, day(5), new Date(Date.now() - 5 * 86_400_000 + 3 * 3_600_000).toISOString()]);
    await query(`INSERT INTO charge_point_outage (org_id, charge_point_id, went_offline_at, came_online_at) VALUES ($1, $2, $3, $4)`, [org2, cp2, day(2), day(1)]);

    const l = await call('GET', '/v1/charger-health');
    assert.equal(l.statusCode, 200, l.body);
    const mine = l.json().chargers.find((c: any) => c.id === cp);
    assert.equal(mine.risk, 'at_risk');
    assert.deepEqual([mine.parts.faults, mine.parts.recentFaults, mine.parts.reboots, mine.parts.outages], [3, 3, 3, 1]);
    assert.ok(mine.parts.offlineHours >= 2.9 && mine.parts.offlineHours <= 3.1, String(mine.parts.offlineHours));
    assert.match(mine.reasons.join(' '), /GroundFailure 3 times/);
    assert.ok(!l.json().chargers.some((c: any) => c.id === cp2), 'never another organisation\'s charger');

    const run = await call('POST', '/v1/charger-health/run');
    assert.equal(run.statusCode, 200, run.body);
    const stored = await one<any>(`SELECT score, risk FROM charger_health WHERE charge_point_id = $1`, [cp]);
    assert.equal(stored.risk, 'at_risk');
    const alert = await one<any>(`SELECT severity, resolved_at FROM alert WHERE org_id = $1 AND kind = 'charger.health_at_risk' AND target_id = $2`, [org, cp]);
    assert.ok(alert && !alert.resolved_at);

    const wo = await call('POST', `/v1/charger-health/${cp}/work-order`);
    assert.equal(wo.statusCode, 201, wo.body);
    const again = (await call('GET', `/v1/charger-health/${cp}`)).json();
    assert.equal(again.history.length, 1);
    const listed = (await call('GET', '/v1/charger-health')).json().chargers.find((c: any) => c.id === cp);
    assert.equal(listed.workOrders.length, 1);
    assert.match(listed.workOrders[0].title, /^Health \d+\/100/);

    // The faults age out of the window: the charger recovers and the alert is resolved.
    await query(`UPDATE ocpp_frame SET ts = ts - interval '40 days' WHERE ocpp_identity = $1`, [ident]);
    await query(`UPDATE charge_point_outage SET went_offline_at = went_offline_at - interval '40 days', came_online_at = came_online_at - interval '40 days' WHERE charge_point_id = $1`, [cp]);
    await call('POST', '/v1/charger-health/run');
    assert.ok((await one<any>(`SELECT resolved_at FROM alert WHERE org_id = $1 AND kind = 'charger.health_at_risk' AND target_id = $2`, [org, cp]))!.resolved_at);
  });

  test('the report builder: run, group, permissions, saved and scheduled, Excel, isolation', async () => {
    const cat = (await call('GET', '/v1/reports/builder')).json();
    assert.ok(cat.datasets.some((d: any) => d.key === 'chargers') && cat.datasets.some((d: any) => d.key === 'ledger'));
    const run = await call('POST', '/v1/reports/builder/run', { dataset: 'chargers', spec: { columns: [{ field: 'charger' }, { field: 'vendor' }, { field: 'health' }] } });
    assert.equal(run.statusCode, 200, run.body);
    assert.deepEqual(run.json().rows.map((r: any[]) => r[0]), [ident], 'only this organisation\'s chargers');
    const grouped = await call('POST', '/v1/reports/builder/run', { dataset: 'outages', spec: { groupBy: [{ field: 'site' }], columns: [{ field: 'hours', agg: 'sum' }, { field: 'charger', agg: 'count' }] } });
    assert.equal(grouped.statusCode, 200, grouped.body);
    assert.equal(grouped.json().rows.length, 1);
    assert.equal(grouped.json().headers[1].label, 'sum of Hours offline');
    const evil = await call('POST', '/v1/reports/builder/run', { dataset: 'chargers', spec: { filters: [{ field: 'vendor', op: 'contains', value: `'; DROP TABLE site; --` }] } });
    assert.deepEqual([evil.statusCode, evil.json().rows.length], [200, 0]);
    const badDate = await call('POST', '/v1/reports/builder/run', { dataset: 'outages', spec: { filters: [{ field: 'went_offline_at', op: 'gt', value: 'yesterday-ish' }] } });
    assert.equal(badDate.statusCode, 422);
    const xl = await call('POST', '/v1/reports/builder/run?format=xlsx', { dataset: 'chargers', spec: {} });
    assert.equal(xl.rawPayload.subarray(0, 2).toString(), 'PK');

    const saved = await call('POST', '/v1/reports/saved', { name: 'Fault watch', dataset: 'chargers', spec: { columns: [{ field: 'charger' }, { field: 'risk' }] }, frequency: 'weekly', weekday: 1, recipients: 'ops@p30.test' });
    assert.equal(saved.statusCode, 201, saved.body);
    assert.equal((await call('POST', '/v1/reports/saved', { name: 'No one', dataset: 'chargers', spec: {}, frequency: 'daily' })).statusCode, 422, 'a schedule needs recipients');
    const id = saved.json().id;
    assert.equal((await call('GET', `/v1/reports/saved/${id}/run`)).json().rows.length, 1);

    // Without payment:read the ledger is closed, and so is a saved report on it.
    perms = perms.filter((p) => p !== 'payment:read' && p !== 'payment:write');
    assert.equal((await call('POST', '/v1/reports/builder/run', { dataset: 'ledger', spec: {} })).statusCode, 403);
    perms = [...perms, 'payment:read', 'payment:write'];
    // Another organisation does not see the report.
    asOrg = () => org2;
    assert.equal((await call('GET', `/v1/reports/saved/${id}`)).statusCode, 404);
    asOrg = () => org;
    assert.equal(rb.duePeriodOf({ frequency: 'daily', weekday: null, last_period: null }, new Date('2026-11-01T03:00:00Z')), '2026-11-01');
    assert.equal(rb.duePeriodOf({ frequency: 'daily', weekday: null, last_period: '2026-11-01' }, new Date('2026-11-01T03:00:00Z')), null);
  });

  test('SAML: set-up rules, then a whole sign-in with the user created by group, and every replay refused', async () => {
    const cert = IDP_CERT;
    const setup = { enabled: true, idpEntityId: `https://idp-${TAG}.example.test`, ssoUrl: `https://idp-${TAG}.example.test/sso`, certificates: [cert], allowedDomains: [`${TAG}.example.co.id`], jitEnabled: true };
    assert.equal((await call('PUT', '/v1/auth/saml', { ...setup, roleMap: [{ group: 'Owners', role: 'org_owner' }] })).statusCode, 422, 'never an administrator role by group');
    assert.equal((await call('PUT', '/v1/auth/saml', { ...setup, jitEnabled: true, roleMap: [] })).statusCode, 422, 'automatic set-up needs a mapping');
    const put = await call('PUT', '/v1/auth/saml', { ...setup, roleMap: [{ group: 'CSMS Ops', role: 'cpo_operations_manager' }] });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal(put.json().serviceProvider.acsUrl, `http://${HOST}/v1/auth/saml/${org}/acs`);
    asOrg = () => org2;
    assert.equal((await call('PUT', '/v1/auth/saml', { ...setup, idpEntityId: 'https://another.example.test', roleMap: [{ group: 'X', role: 'technician' }] })).statusCode, 409, 'a domain belongs to one organisation');
    asOrg = () => org;
    const meta = await call('GET', `/v1/auth/saml/${org}/metadata`);
    assert.match(meta.body, /AssertionConsumerService/);

    const email = `rina@${TAG}.example.co.id`;
    const startSignIn = async () => {
      const s = await call('GET', `/v1/auth/saml/start?email=${encodeURIComponent(email)}`);
      assert.equal(s.statusCode, 303, s.body);
      const to = new URL(s.headers.location as string);
      assert.equal(to.origin + to.pathname, setup.ssoUrl);
      const reqXml = inflateRawSync(Buffer.from(to.searchParams.get('SAMLRequest')!, 'base64')).toString();
      const requestId = /ID="([^"]+)"/.exec(reqXml)![1]!;
      const cookie = String(s.headers['set-cookie']).split(';')[0]!;
      return { requestId, relay: to.searchParams.get('RelayState')!, cookie };
    };
    const answer = (requestId: string) => {
      const acs = `http://${HOST}/v1/auth/saml/${org}/acs`, sp = `http://${HOST}/v1/auth/saml/${org}/metadata`;
      const t = (ms: number) => new Date(Date.now() + ms).toISOString();
      const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r" Version="2.0" IssueInstant="${t(0)}" Destination="${acs}" InResponseTo="${requestId}">`
        + `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>`
        + `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a" Version="2.0" IssueInstant="${t(0)}"><saml:Issuer>${setup.idpEntityId}</saml:Issuer>`
        + `<saml:Subject><saml:NameID>${email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${requestId}" Recipient="${acs}" NotOnOrAfter="${t(300_000)}"/></saml:SubjectConfirmation></saml:Subject>`
        + `<saml:Conditions NotBefore="${t(-60_000)}" NotOnOrAfter="${t(300_000)}"><saml:AudienceRestriction><saml:Audience>${sp}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
        + `<saml:AttributeStatement><saml:Attribute Name="displayName"><saml:AttributeValue>Rina W</saml:AttributeValue></saml:Attribute><saml:Attribute Name="groups"><saml:AttributeValue>CSMS Ops</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion></samlp:Response>`;
      const sig = new SignedXml({ privateKey: IDP_KEY, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
      sig.addReference({ xpath: "//*[local-name(.)='Assertion']", digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256', transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'] });
      sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
      return Buffer.from(sig.getSignedXml()).toString('base64');
    };
    const post = (relay: string, body: string) => app.inject({ method: 'POST', url: `/v1/auth/saml/${org}/acs`, headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ SAMLResponse: body, RelayState: relay }).toString() });

    const s1 = await startSignIn();
    const r1 = await post(s1.relay, answer(s1.requestId));
    assert.equal(r1.statusCode, 200, r1.body);
    const finish = /url=([^"]+)"/.exec(r1.body)![1]!;
    assert.equal((await post(s1.relay, answer(s1.requestId))).headers.location, '/?sso=no_transaction', 'the same answer again is refused');
    const done = await call('GET', finish, undefined, { cookie: s1.cookie });
    assert.equal(done.statusCode, 303, done.body);
    assert.equal(done.headers.location, '/');
    assert.match(String(done.headers['set-cookie']), /ps_session|session/);
    const u = await one<any>(`SELECT u.id, u.name, r.name AS role FROM app_user u JOIN user_role ur ON ur.user_id = u.id JOIN role r ON r.id = ur.role_id WHERE u.org_id = $1 AND u.email = $2`, [org, email]);
    assert.deepEqual([u.name, u.role], ['Rina W', 'cpo_operations_manager']);
    assert.equal((await one<any>(`SELECT auth_method FROM auth_session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [u.id]))!.auth_method, 'saml');
    assert.equal((await call('GET', finish, undefined, { cookie: s1.cookie })).headers.location, '/?sso=no_transaction', 'finish is single use');

    // Another browser (no matching cookie) cannot finish someone's sign-in.
    const s2 = await startSignIn();
    const r2 = await post(s2.relay, answer(s2.requestId));
    const finish2 = /url=([^"]+)"/.exec(r2.body)![1]!;
    assert.equal((await call('GET', finish2, undefined, { cookie: `${s2.cookie.split('=')[0]}=${randomBytes(32).toString('base64url')}` })).headers.location, '/?sso=wrong_browser');
    // An answer for another request id, or without our RelayState, is refused.
    const s3 = await startSignIn();
    assert.equal((await post(s3.relay, answer('_not-our-request'))).headers.location, '/?sso=not_confirmed');
    assert.equal((await post('x'.repeat(43), answer(s3.requestId))).headers.location, '/?sso=no_transaction');
    // The second sign-in finds the linked user (no second account).
    const s4 = await startSignIn();
    const r4 = await post(s4.relay, answer(s4.requestId));
    await call('GET', /url=([^"]+)"/.exec(r4.body)![1]!, undefined, { cookie: s4.cookie });
    assert.equal((await many(`SELECT 1 FROM app_user WHERE org_id = $1 AND email = $2`, [org, email])).length, 1);
    assert.equal((await many(`SELECT 1 FROM saml_user_link WHERE org_id = $1`, [org])).length, 1);
  });
});
