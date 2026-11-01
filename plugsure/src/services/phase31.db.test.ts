import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { rateSession, type Tariff } from './tariff.js';
import type { Conditions, Rule } from './dynamic-pricing.js';

/**
 * Phase 31 (v1.43.0):
 *   - dynamic pricing: rules (time, peak, occupancy, solar) add up inside the band; only energy (and time) move, never
 *     the PLN formula rate or fees; an increase never passes the regulated energy ceiling; a site's factor is kept and
 *     what a session starting now is fixed at;
 *   - demand response: an event's cap on the grid part, OpenADR 3 events read, the webhook with its key (repeat =
 *     update, cancel, opt-out), what the load manager measured and the incentive;
 *   - SCIM 2.0: the token; a user created, found by filter, deactivated (sessions ended) and reactivated; groups give
 *     roles by the map, never an administrator or a site-limited role; administrators left alone; another
 *     organisation's token sees nothing;
 *   - the status page: settings, an incident and its updates, the public data, subscribing (confirm, unsubscribe).
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/phase31.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const dp = await import('./dynamic-pricing.js');
const dr = await import('./demand-response.js');
const scim = await import('./scim.js');
const sp = await import('./status-page.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID();
let org = '', org2 = '', site = '', site2 = '';
let app: FastifyInstance;
const perms = ['site:read', 'site:write', 'tariff:read', 'tariff:write', 'smartcharging:read', 'smartcharging:write', 'user:read', 'user:write'];
const HOST = 'csms.test';
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { host: HOST, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe('Dynamic pricing and demand response, pure', () => {
  const rule = (x: Partial<Rule>): Rule => ({ id: '1', siteId: null, name: 'r', kind: 'time', dayMask: 127, hourFrom: null, hourTo: null, threshold: null, adjustPct: 10, enabled: true, sortOrder: 0, ...x });
  const c = (x: Partial<Conditions> = {}): Conditions => ({ dow: 0, hour: 12, peak: false, occupancyPct: null, solarKw: null, ...x });

  test('rules add up and stay inside the band; conditions not known never match', () => {
    const rs = [rule({ id: '1', name: 'Evening', hourFrom: 17, hourTo: 22, adjustPct: 20 }), rule({ id: '2', name: 'Busy', kind: 'occupancy', threshold: 75, adjustPct: 15 }),
      rule({ id: '3', name: 'Sunny', kind: 'solar', threshold: 30, adjustPct: -20 }), rule({ id: '4', name: 'Night', hourFrom: 22, hourTo: 6, adjustPct: -15 })];
    const band = { floorPct: 80, capPct: 130 };
    assert.equal(dp.factorOf(rs, c({ hour: 12 }), band).bps, 10_000);
    assert.equal(dp.factorOf(rs, c({ hour: 18 }), band).bps, 12_000);
    assert.equal(dp.factorOf(rs, c({ hour: 18, occupancyPct: 80 }), band).bps, 13_000, '135 held at the 130 cap');
    assert.match(dp.factorOf(rs, c({ hour: 18, occupancyPct: 80 }), band).reason, /held at the cap/);
    assert.equal(dp.factorOf(rs, c({ hour: 23 }), band).bps, 8_500, 'overnight window');
    assert.equal(dp.factorOf(rs, c({ hour: 3, solarKw: 50 }), band).bps, 8_000, '-35 held at the 80 floor');
    assert.equal(dp.factorOf(rs, c({ hour: 12, occupancyPct: null, solarKw: null }), band).applied.length, 0);
    assert.equal(dp.factorOf([rule({ kind: 'peak', adjustPct: 25 })], c({ peak: true }), band).bps, 12_500);
    assert.equal(dp.factorOf([rule({ hourFrom: 0, hourTo: 24, dayMask: 1 << 5 })], c({ dow: 0 }), band).bps, 10_000, 'Saturday only');
    assert.equal(dp.factorOf([rule({ hourFrom: 0, hourTo: 24, enabled: false })], c(), band).bps, 10_000, 'a rule switched off');
  });

  test('only energy and time move; never past the regulated energy ceiling; the formula rate and fees never', () => {
    const t: Tariff = { id: 't', name: 'x', currency: 'IDR', plnScheme: 'layanan_khusus', plnBaseRate: 1_645, plnMultiplier: 1.5,
      components: [{ kind: 'energy', rate: 2_000, touBlock: 'ANY' }, { kind: 'energy', rate: 0, formulaRate: true, touBlock: 'ANY', fromKwh: 50 },
        { kind: 'session', rate: 5_000, touBlock: 'ANY' }, { kind: 'time', rate: 100, touBlock: 'ANY' }, { kind: 'idle', rate: 500, touBlock: 'ANY', fromMinutes: 15, toMinutes: 60 }] };
    const up = dp.scaleTariff(t, 11_000);
    assert.equal(up.components[0]!.rate, 2_200);
    assert.equal(up.components[1]!.rate, 0, 'the formula band is not scaled');
    assert.equal(up.components[2]!.rate, 5_000, 'fees are not scaled');
    assert.equal(up.components[3]!.rate, 110);
    assert.equal(up.components[4]!.rate, 500);
    assert.equal(dp.scaleTariff(t, 11_000, false).components[3]!.rate, 100, 'the time fee only when included');
    // +30% would be 2,600/kWh, above the 2,467.50 ceiling (base 1,645 × 1.5): held at the ceiling, so no session is flagged.
    const capped = dp.scaleTariff(t, 13_000);
    assert.equal(capped.components[0]!.rate, 2_467.5);
    const r = rateSession(capped, { startedAt: new Date('2026-11-01T03:00:00Z'), endedAt: new Date('2026-11-01T03:30:00Z'), energyWh: 10_000, connectorMaxPowerW: 50_000, localTaxRateBps: 0, timezone: 'Asia/Jakarta' });
    assert.ok(!r.flags.some((f) => f.code === 'ENERGY_CEILING_EXCEEDED'), 'no ceiling violation');
    assert.equal(dp.scaleTariff(t, 8_000).components[0]!.rate, 1_600, 'a decrease is never held');
    assert.equal(dp.scaleTariff(t, 10_000), t);
    assert.equal(dp.scaleTariff(t, null), t);
  });

  test('a demand-response event caps the grid part', () => {
    assert.equal(dr.capW(100_000, null), 100_000);
    assert.equal(dr.capW(100_000, { eventIds: ['1'], limitW: 40_000, reducePct: null }), 40_000);
    assert.equal(dr.capW(100_000, { eventIds: ['1'], limitW: null, reducePct: 50 }), 50_000);
    assert.equal(dr.capW(100_000, { eventIds: ['1', '2'], limitW: 60_000, reducePct: 50 }), 50_000, 'the strictest');
    assert.equal(dr.capW(30_000, { eventIds: ['1'], limitW: 40_000, reducePct: null }), 30_000, 'never more than usual');
    assert.equal(dr.whOver(36_000, 30), 300);
    assert.equal(dr.whOver(36_000, 3600), 1200, 'a gap counts at most two minutes');
  });

  test('OpenADR 3 events: the window, a capacity limit or a SIMPLE level', () => {
    assert.equal(dr.durationMs('PT2H'), 7_200_000);
    assert.equal(dr.durationMs('PT90M'), 5_400_000);
    assert.equal(dr.durationMs('P1DT1H'), 90_000_000);
    assert.equal(dr.durationMs('nonsense'), null);
    const lim = dr.fromOpenAdr({ id: 'e1', intervalPeriod: { start: '2026-11-02T10:00:00Z', duration: 'PT2H' }, intervals: [{ id: 0, payloads: [{ type: 'IMPORT_CAPACITY_LIMIT', values: [45] }] }] })!;
    assert.equal(lim.limitKw, 45);
    assert.equal(lim.endsAt.toISOString(), '2026-11-02T12:00:00.000Z');
    assert.equal(dr.fromOpenAdr({ id: 'e2', intervalPeriod: { start: '2026-11-02T10:00:00Z', duration: 'PT1H' }, intervals: [{ payloads: [{ type: 'SIMPLE', values: [2] }] }] })!.reducePct, 60);
    assert.equal(dr.fromOpenAdr({ id: 'e3', intervalPeriod: { start: '2026-11-02T10:00:00Z', duration: 'PT1H' }, intervals: [{ payloads: [{ type: 'PRICE', values: [0.2] }] }] }), null, 'not something chargers act on');
    assert.equal(dr.fromOpenAdr({ id: 'e4', intervals: [] }), null);
  });

  test('SCIM: filters and roles from groups', () => {
    assert.deepEqual(scim.parseFilter('userName eq "a@b.co"'), { attr: 'username', value: 'a@b.co' });
    assert.equal(scim.parseFilter(undefined), null);
    assert.throws(() => scim.parseFilter('userName co "a"'), scim.ScimError);
    const map = [{ group: 'CSMS Ops', role: 'cpo_operations_manager' }, { group: 'Finance', role: 'finance_manager' }];
    assert.equal(scim.roleFor(['finance', 'csms ops'], map), 'cpo_operations_manager', 'the map\'s order, case-insensitive');
    assert.equal(scim.roleFor(['Other'], map), null);
    assert.equal(sp.siteState({ total: 4, working: 4, inUse: 2 }, false), 'operational');
    assert.equal(sp.siteState({ total: 4, working: 1, inUse: 0 }, false), 'degraded');
    assert.equal(sp.siteState({ total: 4, working: 0, inUse: 0 }, false), 'outage');
    assert.equal(sp.siteState({ total: 4, working: 4, inUse: 0 }, true), 'maintenance');
  });
});

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`P31 ${TAG}`, `p31-${TAG}`]))!.id;
    org2 = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`P31 other ${TAG}`, `p31o-${TAG}`]))!.id;
    await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, 'Admin')`, [A, org, `${TAG}-admin@p31.test`]);
    site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code, timezone) VALUES ($1, $2, 'ID', 'Asia/Jakarta') RETURNING id`, [org, `Plaza ${TAG}`]))!.id;
    site2 = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'ID') RETURNING id`, [org, `Depot ${TAG}`]))!.id;
    await query(`INSERT INTO site_power_budget (site_id, ceiling_w, reserve_w) VALUES ($1, 110000, 10000), ($2, 60000, 10000)`, [site, site2]);
    const { ensureSystemRoles } = await import('./users.js');
    await ensureSystemRoles();
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: A, orgId: org, assignments: [{ permissions: perms, scopeType: 'org', scopeId: null }] };
    });
    const { registerPhase31Routes } = await import('../api/phase31-routes.js');
    await registerPhase31Routes(app);
  });
  after(async () => {
    await app?.close();
    for (const t of ['scim_group_member', 'scim_group', 'scim_user', 'scim_config', 'site_price_now', 'dynamic_price_rule', 'dynamic_price_settings', 'dr_event_site', 'dr_event', 'dr_program',
      'status_subscriber', 'status_incident', 'status_page', 'alert'])
      await query(`DELETE FROM ${t} WHERE org_id = ANY($1::uuid[])`, [[org, org2]]);
    await query(`DELETE FROM site_power_budget WHERE site_id = ANY($1::uuid[])`, [[site, site2]]);
    await query(`DELETE FROM site WHERE id = ANY($1::uuid[])`, [[site, site2]]);
    await query(`DELETE FROM auth_session WHERE user_id IN (SELECT id FROM app_user WHERE org_id = $1)`, [org]);
    await query(`DELETE FROM user_role WHERE user_id IN (SELECT id FROM app_user WHERE org_id = $1)`, [org]);
    await query(`DELETE FROM app_user WHERE org_id = ANY($1::uuid[])`, [[org, org2]]).catch(() => { /* audit rows keep them */ });
    await query(`DELETE FROM organisation WHERE id = ANY($1::uuid[])`, [[org, org2]]).catch(() => { /* audit rows keep them */ });
    await pool.end();
  });
}

dbDescribe('Phase 31 through the routes', () => {
  test('dynamic pricing: settings, rules, a site\'s factor kept and fixed, the preview', async () => {
    assert.equal(await dp.factorNow(site), null, 'off: the tariff as it is');
    assert.equal((await call('PUT', '/v1/dynamic-pricing/settings', { floorPct: 120 })).statusCode, 422);
    assert.equal((await call('POST', '/v1/dynamic-pricing/rules', { name: 'Always', kind: 'time', hourFrom: 5, hourTo: 5, adjustPct: 10 })).statusCode, 422, 'an empty window');
    assert.equal((await call('POST', '/v1/dynamic-pricing/rules', { name: 'Zero', kind: 'time', hourFrom: 0, hourTo: 24, adjustPct: 0 })).statusCode, 422);
    assert.equal((await call('POST', '/v1/dynamic-pricing/rules', { name: 'Busy', kind: 'occupancy', adjustPct: 10 })).statusCode, 422, 'a threshold is needed');
    const all = await call('POST', '/v1/dynamic-pricing/rules', { name: 'All day', kind: 'time', hourFrom: 0, hourTo: 24, adjustPct: 15 });
    assert.equal(all.statusCode, 201);
    assert.equal((await call('POST', '/v1/dynamic-pricing/rules', { name: 'Depot', kind: 'time', hourFrom: 0, hourTo: 24, adjustPct: -10, siteId: site2 })).statusCode, 201);
    assert.equal((await call('PUT', '/v1/dynamic-pricing/settings', { enabled: true, capPct: 140 })).statusCode, 200);
    const now = await dp.factorNow(site);
    assert.equal(now!.bps, 11_500);
    assert.match(now!.reason, /All day \+15%/);
    assert.equal((await dp.factorNow(site2))!.bps, 10_500, 'the depot\'s own rule too');
    const kept = await one<any>(`SELECT factor_bps FROM site_price_now WHERE site_id = $1`, [site]);
    assert.equal(kept.factor_bps, 11_500);
    const map = await dp.factorsForSites([site, site2]);
    assert.equal(map.get(site), 11_500);
    const ov = (await call('GET', '/v1/dynamic-pricing')).json();
    assert.equal(ov.sites.find((s: any) => s.id === site).factorPct, 115);
    const pv = (await call('GET', `/v1/dynamic-pricing/sites/${site}/preview`)).json();
    assert.equal(pv.hours.length, 168);
    assert.ok(pv.hours.every((h: any) => h.factorPct === 115));
    assert.equal(pv.now.factorPct, 115);
    // Archive the rule: back to the standard price.
    assert.equal((await call('PUT', `/v1/dynamic-pricing/rules/${all.json().id}`, { archive: true })).statusCode, 200);
    assert.equal((await dp.factorNow(site))!.bps, 10_000);
    // Switched off: kept factors are ignored.
    await call('PUT', '/v1/dynamic-pricing/settings', { enabled: false });
    assert.equal(await dp.factorNow(site2), null);
    assert.equal((await dp.factorsForSites([site2])).size, 0);
  });

  test('demand response: a webhook event with its key, the cap, the measurement, opt-out', async () => {
    assert.equal((await call('POST', '/v1/dr/programs', { name: 'PLN DR', kind: 'webhook', siteIds: [] })).statusCode, 422);
    const p = (await call('POST', '/v1/dr/programs', { name: 'PLN DR', kind: 'webhook', siteIds: [site, site2], incentiveMinorPerKwh: 3000 })).json();
    const k = (await call('POST', `/v1/dr/programs/${p.id}/key`)).json();
    assert.match(k.key, /^pdr_/);
    const post = (body: unknown, key = k.key) => call('POST', `/v1/dr/programs/${p.id}/events`, body, { authorization: `Bearer ${key}` });
    assert.equal((await post({ id: 'x' }, 'pdr_wrong-key-000000')).statusCode, 401);
    const start = new Date(Date.now() - 60_000).toISOString(), end = new Date(Date.now() + 3_600_000).toISOString();
    assert.equal((await post({ id: 'ev1', start, end })).statusCode, 422, 'a limit or a reduction');
    assert.equal((await post({ id: 'ev1', start, durationMinutes: 60 * 25, limitKw: 50 })).statusCode, 422, 'at most 24 hours');
    const ev = await post({ id: 'ev1', start, end, limitKw: 75 });
    assert.equal(ev.statusCode, 201);
    assert.equal((await post({ id: 'ev1', start, end, limitKw: 50 })).statusCode, 200, 'a repeat updates');
    // 50 kW across the two sites, split by their usual budget (100 kW and 50 kW).
    const a1 = await dr.activeFor(site), a2 = await dr.activeFor(site2);
    assert.equal(a1!.limitW, 33_333);
    assert.equal(a2!.limitW, 16_667);
    assert.equal(dr.capW(100_000, a1), 33_333);
    // The load manager's measurement: two passes, 30 s apart.
    const t0 = new Date();
    await dr.recordPass(site, a1!, 80_000, 33_333, t0);
    await dr.recordPass(site, a1!, 80_000, 33_333, new Date(t0.getTime() + 30_000));
    const evs = (await call('GET', '/v1/dr/events')).json().events;
    const e = evs.find((x: any) => x.extId === 'ev1');
    assert.equal(e.state, 'active');
    assert.equal(e.measured.length, 1);
    assert.ok(Math.abs(e.reducedKwh - (80_000 - 33_333) * 30 / 3600 / 1000) < 0.001);
    assert.equal(e.incentiveMinor, Math.round(e.reducedKwh * 3000));
    assert.ok(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = $2`, [org, dr.DR_ALERT]), 'operators are told');
    // Opt out: charging is no longer held.
    assert.equal((await call('POST', `/v1/dr/events/${e.id}/opt-out`, { note: 'site event' })).statusCode, 200);
    assert.equal(await dr.activeFor(site), null);
    assert.equal((await post({ id: 'ev1', start, end, limitKw: 10 })).json().status, 'opted_out', 'a repeat does not undo an opt-out');
    // A cancelled event stops at once.
    await post({ id: 'ev2', start, end, reducePct: 40 });
    assert.equal((await dr.activeFor(site))!.reducePct, 40);
    assert.equal((await post({ id: 'ev2', start, end, status: 'cancelled' })).json().status, 'cancelled');
    assert.equal(await dr.activeFor(site), null);
    // A site that is not the programme's.
    assert.equal((await post({ id: 'ev3', start, end, limitKw: 10, siteIds: [randomUUID()] })).statusCode, 422);
  });

  test('SCIM: token, users, groups → roles, deactivation, administrators left alone, isolation', async () => {
    const bad = await app.inject({ method: 'GET', url: '/scim/v2/Users', headers: { host: HOST, authorization: 'Bearer nope' } });
    assert.equal(bad.statusCode, 401);
    assert.equal(bad.json().schemas[0], scim.SCHEMA_ERROR);
    const { token } = (await call('POST', '/v1/scim/token')).json();
    const S = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, t = token) =>
      app.inject({ method, url, headers: { host: HOST, authorization: `Bearer ${t}`, 'content-type': 'application/scim+json' }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
    assert.equal((await S('GET', '/scim/v2/Users')).statusCode, 403, 'switched off until enabled');
    assert.equal((await call('PUT', '/v1/scim', { enabled: true, roleMap: [{ group: 'Hosts', role: 'site_host_landlord' }] })).statusCode, 422, 'never a site-limited role');
    assert.equal((await call('PUT', '/v1/scim', { enabled: true, roleMap: [{ group: 'Admins', role: 'super_admin' }] })).statusCode, 422, 'never an administrator role');
    assert.equal((await call('PUT', '/v1/scim', { enabled: true, roleMap: [{ group: 'CSMS Ops', role: 'cpo_operations_manager' }, { group: 'Finance', role: 'finance_manager' }] })).statusCode, 200);
    assert.equal((await S('GET', '/scim/v2/ServiceProviderConfig')).json().patch.supported, true);
    const email = `rina.${TAG}@p31.test`;
    const u = await S('POST', '/scim/v2/Users', { schemas: [scim.SCHEMA_USER], userName: email, name: { givenName: 'Rina', familyName: 'W' }, emails: [{ value: email, primary: true }], active: true, externalId: 'okta-1' });
    assert.equal(u.statusCode, 201);
    const uid = u.json().id;
    assert.equal((await S('POST', '/scim/v2/Users', { userName: email })).statusCode, 409);
    assert.equal((await S('GET', `/scim/v2/Users?filter=${encodeURIComponent(`userName eq "${email.toUpperCase()}"`)}`)).json().totalResults, 1);
    assert.equal((await one<any>(`SELECT password_hash FROM app_user WHERE id = $1`, [uid])).password_hash, null, 'no password: single sign-on');
    assert.equal((await many(`SELECT 1 FROM user_role WHERE user_id = $1`, [uid])).length, 0, 'no group, no role');
    // A group gives its role; the map's order decides between two.
    const g = (await S('POST', '/scim/v2/Groups', { displayName: 'Finance', members: [{ value: uid }] })).json();
    const role = async () => (await one<any>(`SELECT r.name FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = $1`, [uid]))?.name ?? null;
    assert.equal(await role(), 'finance_manager');
    const g2 = (await S('POST', '/scim/v2/Groups', { displayName: 'CSMS Ops' })).json();
    await S('PATCH', `/scim/v2/Groups/${g2.id}`, { schemas: [scim.SCHEMA_PATCH], Operations: [{ op: 'add', path: 'members', value: [{ value: uid }] }] });
    assert.equal(await role(), 'cpo_operations_manager');
    await S('PATCH', `/scim/v2/Groups/${g2.id}`, { schemas: [scim.SCHEMA_PATCH], Operations: [{ op: 'remove', path: `members[value eq "${uid}"]` }] });
    assert.equal(await role(), 'finance_manager');
    assert.equal((await S('GET', `/scim/v2/Users/${uid}`)).json().groups.length, 1);
    // A leaver: deactivated by PATCH, every session ended; back again by PATCH.
    await query(`INSERT INTO auth_session (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [uid, randomBytes(32).toString('hex')]);
    assert.equal((await S('PATCH', `/scim/v2/Users/${uid}`, { schemas: [scim.SCHEMA_PATCH], Operations: [{ op: 'replace', value: { active: false } }] })).json().active, false);
    assert.equal((await one<any>(`SELECT status FROM app_user WHERE id = $1`, [uid])).status, 'disabled');
    assert.equal((await many(`SELECT 1 FROM auth_session WHERE user_id = $1 AND revoked_at IS NULL`, [uid])).length, 0);
    assert.equal((await S('PATCH', `/scim/v2/Users/${uid}`, { schemas: [scim.SCHEMA_PATCH], Operations: [{ op: 'replace', path: 'active', value: 'True' }] })).json().active, true);
    // An administrator taken over by e-mail is left alone: no role change, no deactivation.
    const { setUserRole } = await import('./users.js');
    await setUserRole(A, org, 'super_admin');
    const adm = (await S('POST', '/scim/v2/Users', { userName: `${TAG}-admin@p31.test` })).json();
    assert.equal(adm.id, A);
    await S('PATCH', `/scim/v2/Groups/${g.id}`, { schemas: [scim.SCHEMA_PATCH], Operations: [{ op: 'add', path: 'members', value: [{ value: A }] }] });
    assert.equal((await one<any>(`SELECT r.name FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = $1`, [A])).name, 'super_admin');
    assert.equal((await S('DELETE', `/scim/v2/Users/${A}`)).statusCode, 400);
    assert.equal((await one<any>(`SELECT status FROM app_user WHERE id = $1`, [A])).status, 'active');
    // DELETE deactivates (never removes); the group's deletion takes the role away.
    await S('DELETE', `/scim/v2/Groups/${g.id}`);
    assert.equal(await role(), null);
    assert.equal((await S('DELETE', `/scim/v2/Users/${uid}`)).statusCode, 204);
    assert.equal((await one<any>(`SELECT status FROM app_user WHERE id = $1`, [uid])).status, 'disabled');
    // Another organisation's token sees none of it.
    await query(`INSERT INTO scim_config (org_id, enabled) VALUES ($1, true)`, [org2]);
    const t2 = (await scim.rotateToken(org2, null)).token;
    assert.equal((await S('GET', '/scim/v2/Users', undefined, t2)).json().totalResults, 0);
    assert.equal((await S('GET', `/scim/v2/Users/${uid}`, undefined, t2)).statusCode, 404);
    // A new token: the old one stops working.
    await call('POST', '/v1/scim/token');
    assert.equal((await S('GET', '/scim/v2/Users')).statusCode, 401);
  });

  test('status page: settings, an incident and its updates, the public data, subscribers', async () => {
    assert.equal((await call('GET', `/v1/status/p31-${TAG}`)).statusCode, 404, 'off until switched on');
    assert.equal((await call('PUT', '/v1/status-page', { slug: 'A b' })).statusCode, 422);
    const pg = (await call('PUT', '/v1/status-page', { enabled: true, slug: `p31-${TAG}`, title: 'Plaza charging status', siteIds: [site] })).json();
    assert.equal(pg.enabled, true);
    assert.equal((await call('POST', '/v1/status-page/incidents', { title: 'Down', message: '' })).statusCode, 422, 'a public message');
    const inc = (await call('POST', '/v1/status-page/incidents', { title: 'Payment terminal down', impact: 'major', siteIds: [site], message: 'We are looking into it.', notify: false })).json();
    assert.equal(inc.status, 'investigating');
    const mt = await call('POST', '/v1/status-page/incidents', { kind: 'maintenance', title: 'Transformer service', siteIds: [site], scheduledFrom: new Date(Date.now() - 60_000).toISOString(), scheduledTo: new Date(Date.now() + 3_600_000).toISOString(), message: 'Planned work.', notify: false });
    assert.equal(mt.statusCode, 201);
    let pub = (await call('GET', `/v1/status/p31-${TAG}`)).json();
    assert.equal(pub.title, 'Plaza charging status');
    assert.equal(pub.incidents.length, 1);
    assert.equal(pub.sites.length, 0, 'a site with no connectors is not listed');
    assert.equal(pub.overall, 'partial');
    const upd = (await call('PUT', `/v1/status-page/incidents/${inc.id}`, { status: 'resolved', message: 'Fixed.', notify: false })).json();
    assert.equal(upd.updates.length, 2);
    assert.ok(upd.resolvedAt);
    assert.equal((await call('PUT', `/v1/status-page/incidents/${inc.id}`, { status: 'monitoring' })).statusCode, 422, 'a status change needs a message');
    pub = (await call('GET', `/v1/status/p31-${TAG}`)).json();
    assert.equal(pub.incidents.length, 0);
    assert.equal(pub.history.length, 1);
    // Subscribing: no e-mail channel here, so the answer says so — and nothing is confirmed.
    const sub = await call('POST', `/v1/status/p31-${TAG}/subscribe`, { email: `fan.${TAG}@p31.test` });
    assert.equal(sub.statusCode, 503);
    const row = await one<any>(`SELECT confirmed_at FROM status_subscriber WHERE org_id = $1`, [org]);
    assert.equal(row.confirmed_at, null);
    assert.equal(await sp.confirm(`p31-${TAG}`, 'x'.repeat(32)), false);
    // Confirm and unsubscribe through the links (the tokens as the e-mails would carry them).
    const tok = randomBytes(24).toString('base64url'), off = randomBytes(24).toString('base64url');
    const { createHash } = await import('node:crypto');
    const h = (s: string) => createHash('sha256').update(s).digest('hex');
    await query(`UPDATE status_subscriber SET confirm_hash = $2, unsubscribe_hash = $3 WHERE org_id = $1`, [org, h(tok), h(off)]);
    assert.match((await call('GET', `/v1/status/p31-${TAG}/confirm?t=${tok}`)).body, /Subscribed/);
    assert.ok((await one<any>(`SELECT confirmed_at FROM status_subscriber WHERE org_id = $1`, [org])).confirmed_at);
    assert.match((await call('GET', `/v1/status/p31-${TAG}/unsubscribe?t=${off}`)).body, /Unsubscribed/);
    assert.equal((await many(`SELECT 1 FROM status_subscriber WHERE org_id = $1`, [org])).length, 0);
    assert.equal((await call('GET', '/v1/status/no-such-page')).statusCode, 404);
  });
});
