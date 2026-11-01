import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import type { Demand } from './smartcharging.js';

/**
 * Phase 32 (v1.44.0):
 *   - depot scheduling: the plan (on track, deferred in peak hours, at risk, ready, missed), a vehicle's usual departure
 *     becoming the session's, a departure set by hand, the "not ready" alert;
 *   - the queue: estimated waits, the priority lane's order, analytics (no-shows, abandonment, waits, hours);
 *   - carbon: the grid factor (site, province, default), the measured solar share, per session and per site, the ESG
 *     workbook;
 *   - the diagnostics bot: the analysis (healthy, unreachable, needs a visit, needs attention, fixed), a run on a
 *     charger that is not connected, and the work order it opens.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/phase32.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const depot = await import('./depot.js');
const queue = await import('../driver/queue.js');
const carbon = await import('./carbon.js');
const bot = await import('./diagnostics-bot.js');

const TAG = randomBytes(3).toString('hex');
let org = '', site = '', cp = '', conn = '', tok = '', ident = '';

describe('Phase 32, pure', () => {
  const d = (x: Partial<Demand>): Demand => ({ ocppIdentity: 'X', chargePointId: 'c', connectorNo: 1, maxPowerW: 22_000, minPowerW: 4_140, currentType: 'AC', phases: 3, priority: 0, active: true, connectorUuid: 'k1', ...x });
  const noon = new Date('2026-11-02T05:00:00Z'); // 12:00 in Jakarta
  const peakNoon = () => true, offPeak = () => false;

  test('depot: on track raises the minimum to what the departure needs; peak hours defer; too late is at risk', () => {
    const need = (neededWh: number, deliveredWh: number, hours: number) => new Map([['k1', { sessionId: 's1', connectorUuid: 'k1', neededWh, deliveredWh, departureAt: new Date(noon.getTime() + hours * 3_600_000) }]]);
    let r = depot.planDepot([d({})], need(40_000, 0, 8), noon, offPeak);
    assert.equal(r.plans[0]!.state, 'on_track');
    assert.equal(r.plans[0]!.requiredW, 5000);
    assert.equal(r.demands[0]!.minPowerW, 5750, '+15 %');
    assert.ok(r.demands[0]!.priority > 10);
    r = depot.planDepot([d({})], need(40_000, 0, 8), noon, peakNoon);
    assert.equal(r.plans[0]!.state, 'on_track', 'all hours peak: no off-peak hours to wait for');
    const evening = (t: Date) => t.getTime() < noon.getTime() + 5 * 3_600_000; // peak for the next 5 hours
    r = depot.planDepot([d({})], need(40_000, 0, 12), noon, evening);
    assert.equal(r.plans[0]!.state, 'deferred');
    assert.equal(r.demands[0]!.maxPowerW, 4140, 'held at its minimum');
    r = depot.planDepot([d({})], need(200_000, 0, 4), noon, offPeak);
    assert.equal(r.plans[0]!.state, 'at_risk');
    assert.equal(r.demands[0]!.minPowerW, 22_000);
    assert.equal(r.demands[0]!.priority, 100);
    r = depot.planDepot([d({})], need(10_000, 12_000, 4), noon, offPeak);
    assert.equal(r.plans[0]!.state, 'ready');
    assert.equal(r.demands[0]!.maxPowerW, 4140);
    r = depot.planDepot([d({})], need(10_000, 1_000, -1), noon, offPeak);
    assert.equal(r.plans[0]!.state, 'missed');
    r = depot.planDepot([d({ connectorUuid: 'other' })], need(40_000, 0, 8), noon, offPeak);
    assert.equal(r.plans.length, 0, 'a session without a departure is untouched');
    assert.equal(depot.offPeakHours(noon, new Date(noon.getTime() + 10 * 3_600_000), evening), 5);
  });

  test('depot: the next departure in the site\'s zone, at least 30 minutes on', () => {
    assert.equal(depot.nextDeparture('06:00', new Date('2026-11-01T15:00:00Z'), 'Asia/Jakarta').toISOString(), '2026-11-01T23:00:00.000Z', '22:00 → 06:00 next morning');
    assert.equal(depot.nextDeparture('23:00', new Date('2026-11-01T15:00:00Z'), 'Asia/Jakarta').toISOString(), '2026-11-01T16:00:00.000Z', '22:00 → 23:00 the same evening');
    assert.equal(depot.nextDeparture('22:15', new Date('2026-11-01T15:00:00Z'), 'Asia/Jakarta').toISOString(), '2026-11-02T15:15:00.000Z', 'only 15 minutes on: the next day');
  });

  test('queue: estimated waits, in order, by connector fit', () => {
    const conns = [{ current: 'DC' as const, type: 'cCCS2', freeInMin: 20 }, { current: 'AC' as const, type: 'sType2', freeInMin: 5 }];
    const w = queue.estimateWaits([{ id: 'a', current: 'DC', type: null }, { id: 'b', current: null, type: null }, { id: 'c', current: 'DC', type: null }, { id: 'd', current: 'DC', type: 'gChaoji' }], conns, 40);
    assert.equal(w.get('a'), 20);
    assert.equal(w.get('b'), 5, 'any connector: the AC one');
    assert.equal(w.get('c'), 60, 'after a’s session');
    assert.equal(w.get('d'), null, 'no connector fits');
    assert.equal(queue.roundWait(0), 0);
    assert.equal(queue.roundWait(3), 5);
    assert.equal(queue.roundWait(22), 20);
  });

  test('carbon: solar share, emissions, the grid factor', () => {
    const t0 = 1_800_000_000_000;
    const rs = [{ ts: t0, solarW: 30_000, gridW: 10_000, batteryW: 0 }, { ts: t0 + 600_000, solarW: 0, gridW: 40_000, batteryW: 0 }, { ts: t0 + 1_200_000, solarW: 50_000, gridW: -10_000, batteryW: 0 }];
    // 30 used of 40 for 600 s; 0 of 40 for 600 s; 40 used (50 − 10 exported) of 40 for 60 s.
    assert.equal(Math.round(carbon.solarShareOf(rs)! * 1000), Math.round(((30 * 600 + 40 * 60) / (40 * 600 + 40 * 600 + 40 * 60)) * 1000));
    assert.equal(carbon.solarShareOf([]), null);
    assert.equal(carbon.emittedKg(10, 0.5, 0, 0.8), 4);
    assert.equal(carbon.emittedKg(10, 0.5, 0.5, 0.8), 2);
    const s = { gridKgPerKwh: 0.8, iceKgPerKwh: 0.7, provinceKgPerKwh: { 31: 0.87 } as Record<string, number> };
    assert.deepEqual(carbon.gridFactorFor({ grid_kg_per_kwh: '0.5', kabupaten_kota_code: '3171', country_code: 'ID' }, s), { kgPerKwh: 0.5, source: 'site' });
    assert.deepEqual(carbon.gridFactorFor({ grid_kg_per_kwh: null, kabupaten_kota_code: '3171', country_code: 'ID' }, s), { kgPerKwh: 0.87, source: 'province', province: '31' });
    assert.deepEqual(carbon.gridFactorFor({ grid_kg_per_kwh: null, kabupaten_kota_code: '5171', country_code: 'ID' }, s), { kgPerKwh: 0.8, source: 'default' });
  });

  test('diagnostics: the verdicts', () => {
    const base: Parameters<typeof bot.analyse>[0] = { online: true, lastHeartbeatAt: null, reboots24h: 0, callErrors24h: 0, codes7d: {}, vendorCodes: [], faultedNow: [], config: { HeartbeatInterval: '300' }, resetTried: false, faultedAfterReset: null };
    assert.equal(bot.analyse(base).verdict, 'healthy');
    assert.equal(bot.analyse({ ...base, online: false }).verdict, 'unreachable');
    const g = bot.analyse({ ...base, codes7d: { GroundFailure: 3 } });
    assert.equal(g.verdict, 'needs_visit');
    assert.match(g.summary, /RCD/);
    assert.equal(bot.analyse({ ...base, codes7d: { GroundFailure: 1 } }).verdict, 'needs_attention', 'one occurrence: watch it');
    const c = bot.analyse({ ...base, config: { HeartbeatInterval: '3600', MeterValueSampleInterval: '60' } });
    assert.equal(c.verdict, 'needs_attention');
    assert.match(c.summary, /HeartbeatInterval is 3600/);
    assert.equal(bot.analyse({ ...base, faultedNow: [{ connectorNo: 1, errorCode: 'InternalError' }], resetTried: true, faultedAfterReset: false }).verdict, 'fixed');
    assert.equal(bot.analyse({ ...base, faultedNow: [{ connectorNo: 1, errorCode: 'InternalError' }], resetTried: true, faultedAfterReset: true }).verdict, 'needs_visit');
    assert.equal(bot.analyse({ ...base, reboots24h: 7 }).verdict, 'needs_visit');
  });
});

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`P32 ${TAG}`, `p32-${TAG}`]))!.id;
    site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code, timezone, kabupaten_kota_code) VALUES ($1, $2, 'ID', 'Asia/Jakarta', '3171') RETURNING id`, [org, `Depot ${TAG}`]))!.id;
    ident = `P32-${TAG}`;
    cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, adopted_at) VALUES ($1, $2, now()) RETURNING id`, [site, ident]))!.id;
    const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [cp]))!.id;
    conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, max_power_w) VALUES ($1, 22000) RETURNING id`, [e]))!.id;
    tok = (await one<{ id: string }>(`INSERT INTO token (org_id, kind, uid) VALUES ($1, 'rfid', $2) RETURNING id`, [org, `P32${TAG}`]))!.id;
  });
  after(async () => {
    for (const t of ['diagnostic_run', 'work_order', 'session_departure', 'fleet_vehicle', 'driver_queue_entry', 'site_energy_reading', 'alert'])
      await query(`DELETE FROM ${t} WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM finance_org_settings WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM driver_device WHERE device_hash LIKE $1`, [`p32-${TAG}-%`]).catch(() => {});
    await query(`DELETE FROM ocpp_frame WHERE ocpp_identity = $1`, [ident]);
    await query(`DELETE FROM charging_session WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM token WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM connector WHERE id = $1`, [conn]).catch(() => {});
    await query(`DELETE FROM evse WHERE charge_point_id = $1`, [cp]).catch(() => {});
    await query(`DELETE FROM charge_point WHERE id = $1`, [cp]).catch(() => {});
    await query(`DELETE FROM site WHERE id = $1`, [site]).catch(() => {});
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => {});
    await pool.end();
  });
}

dbDescribe('Phase 32 with the database', () => {
  test('depot: a vehicle\'s usual departure becomes the session\'s; the plan is kept; a vehicle not ready raises an alert', async () => {
    const v = await depot.saveVehicle(org, null, { name: 'Bus 12', plate: 'b 1234 xyz', batteryKwh: 300, tokenId: tok, departureTime: '05:30', targetKwh: 120 }) as any;
    assert.equal(v.plate, 'B 1234 XYZ');
    await assert.rejects(depot.saveVehicle(org, null, { name: 'Bus 13', departureTime: '05:30' }), /needs a target/);
    await assert.rejects(depot.saveVehicle(org, null, { name: 'Bus 14', tokenId: tok }), /already another vehicle/);
    const s = (await one<{ id: string }>(
      `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, token_id, started_at, energy_wh, state)
       VALUES ($1, $2, $3, $4, $5, $6, now() - interval '1 hour', 20000, 'active') RETURNING id`, [org, site, conn, cp, `p32-${TAG}-1`, tok]))!.id;
    assert.equal(await depot.needsFor(site), null, 'off: as before');
    await depot.setSite(org, site, true);
    const n = (await depot.needsFor(site))!;
    const need = n.needs.get(conn)!;
    assert.equal(need.neededWh, 120_000);
    assert.equal(need.deliveredWh, 20_000);
    assert.equal((await one<any>(`SELECT source, vehicle_id FROM session_departure WHERE session_id = $1`, [s])).source, 'vehicle');
    // A plan the charger cannot meet in time: at risk, alerted once.
    await query(`UPDATE session_departure SET departure_at = now() + interval '1 hour' WHERE session_id = $1`, [s]);
    const n2 = (await depot.needsFor(site))!;
    const plan = depot.planDepot([{ ocppIdentity: ident, chargePointId: cp, connectorNo: 1, maxPowerW: 22_000, minPowerW: 4_140, currentType: 'AC', phases: 3, priority: 0, active: true, connectorUuid: conn }], n2.needs, new Date(), () => false);
    assert.equal(plan.plans[0]!.state, 'at_risk');
    await depot.recordPlans(site, plan.plans, [{ ...plan.demands[0]!, allocatedW: 22_000, unit: 'A', limit: 32 } as any], n2.needs);
    await depot.recordPlans(site, plan.plans, [{ ...plan.demands[0]!, allocatedW: 22_000, unit: 'A', limit: 32 } as any], n2.needs);
    assert.equal((await many(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = $2`, [org, depot.NOT_READY_ALERT])).length, 1);
    const ov = await depot.overview(org);
    assert.equal(ov.sessions[0]!.state, 'at_risk');
    assert.equal(ov.sessions[0]!.late, true);
    // Set by hand.
    await assert.rejects(depot.setDeparture(org, s, { departureAt: new Date(Date.now() + 60_000).toISOString(), neededKwh: 50 }), /between 5 minutes/);
    await depot.setDeparture(org, s, { departureAt: new Date(Date.now() + 10 * 3_600_000).toISOString(), neededKwh: 50 });
    assert.equal((await one<any>(`SELECT source, needed_wh, alerted_at FROM session_departure WHERE session_id = $1`, [s])).source, 'console');
    await query(`UPDATE charging_session SET state = 'ended', ended_at = now() WHERE id = $1`, [s]);
  });

  test('queue: analytics over the places that ended', async () => {
    const devs: string[] = [];
    const dev = () => { const id = randomUUID(); devs.push(id); return id; };
    const rows: Array<[string, number, number | null, boolean]> = [['served', 30, 10, false], ['served', 20, 4, true], ['missed', 40, 12, false], ['left', 50, null, false], ['expired', 200, null, false]];
    for (const [state, agoMin, waitMin, prio] of rows) {
      const d = dev();
      await query(`INSERT INTO driver_device (id, device_hash) VALUES ($1, $2)`, [d, `p32-${TAG}-${d}`]);
      await query(`INSERT INTO driver_queue_entry (org_id, site_id, device_id, state, joined_at, offered_at, ended_at, priority)
                   VALUES ($1, $2, $3, $4, now() - make_interval(mins => $5), CASE WHEN $6::int IS NULL THEN NULL ELSE now() - make_interval(mins => $5 - $6) END, now(), $7)`,
        [org, site, d, state, agoMin, waitMin, prio]);
    }
    const a = await queue.queueAnalytics(org, site, 30);
    assert.equal(a.totals.joined, 5);
    assert.equal(a.totals.noShowPct, 33.3, '1 missed of 3 offers taken or missed');
    assert.equal(a.totals.abandonmentPct, 40, 'left + expired of 5');
    assert.equal(a.totals.priorityPct, 20);
    assert.equal(a.totals.waitMedianMinutes, 10);
    assert.equal(a.byHour.reduce((s, h) => s + h.joined, 0), 5);
  });

  test('carbon: a session\'s solar share and emissions; the site report and the ESG workbook', async () => {
    await carbon.saveSettings(org, { provinceKgPerKwh: { 31: 0.9 } }, null);
    await assert.rejects(carbon.saveSettings(org, { provinceKgPerKwh: { Jakarta: 0.9 } }, null), /two-digit/);
    const t0 = new Date(Date.now() - 2 * 3_600_000);
    const s = (await one<{ id: string }>(
      `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, ended_at, energy_wh, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 10000, 'ended') RETURNING id`, [org, site, conn, cp, `p32-${TAG}-2`, t0, new Date(t0.getTime() + 3_600_000)]))!.id;
    // Half the site's supply from solar during the session.
    for (let i = 0; i < 6; i++) await query(`INSERT INTO site_energy_reading (org_id, site_id, ts, solar_w, grid_w, battery_w) VALUES ($1, $2, $3, 20000, 20000, 0)`, [org, site, new Date(t0.getTime() + i * 600_000)]);
    const c = (await carbon.sessionCarbon(org, s))!;
    assert.equal(c.gridKgPerKwh, 0.9);
    assert.equal(c.gridFactorSource, 'province');
    assert.equal(c.solarSharePct, 50);
    assert.equal(c.emittedKg, 4.5, '10 kWh × 0.5 × 0.9');
    assert.equal(c.avoidedKg, 2.5, '10 × 0.7 − 4.5');
    const day = (t: Date) => t.toISOString().slice(0, 10);
    const r = await carbon.siteReport(org, day(new Date(Date.now() - 86_400_000)), day(new Date()));
    const row = r.sites.find((x) => x.siteId === site)!;
    assert.equal(row.sessions, 2, 'with the depot test\'s session');
    assert.equal(row.solarSharePct, 50);
    await assert.rejects(carbon.siteReport(org, '2026-01-01', '2026-06-30'), /92 days/);
    const wb = await carbon.esgWorkbook(org, day(new Date(Date.now() - 86_400_000)), day(new Date()));
    assert.equal(wb.subarray(0, 2).toString(), 'PK');
  });

  test('diagnostics bot: a charger not connected, its error history, and the work order', async () => {
    await query(`UPDATE charge_point SET last_heartbeat_at = now() - interval '2 hours', offline_since = now() - interval '2 hours' WHERE id = $1`, [cp]);
    for (let i = 0; i < 3; i++) await query(`INSERT INTO ocpp_frame (charge_point_id, ocpp_identity, ts, direction, message_type, action, payload) VALUES ($1, $2, now() - make_interval(hours => $3), 'in', 2, 'StatusNotification', $4)`,
      [cp, ident, i + 3, JSON.stringify({ connectorId: 1, status: 'Faulted', errorCode: 'GroundFailure', vendorErrorCode: 'E-17' })]);
    const run = await one<{ id: string }>(`INSERT INTO diagnostic_run (org_id, charge_point_id) VALUES ($1, $2) RETURNING id`, [org, cp]);
    const charger = await one<any>(`SELECT cp.id, cp.ocpp_identity, COALESCE(cp.display_name, cp.ocpp_identity) AS name, cp.last_heartbeat_at, cp.offline_since FROM charge_point cp WHERE cp.id = $1`, [cp]);
    const r = await bot.execute(String(run!.id), org, charger, { userId: null, openWorkOrder: true }, 0);
    assert.equal(r.verdict, 'unreachable');
    assert.ok(r.findings.some((f) => f.kind === 'error_code' && /GroundFailure reported 3×/.test(f.text)));
    assert.ok(r.findings.some((f) => /E-17/.test(f.text)));
    assert.deepEqual(r.steps.map((s) => s.step), ['connection', 'errors'], 'nothing is sent to a charger that is not connected');
    assert.ok(r.workOrderId);
    const wo = await one<any>(`SELECT kind, title, description FROM work_order WHERE id = $1`, [r.workOrderId]);
    assert.equal(wo.kind, 'corrective');
    assert.match(wo.title, /not connected/);
    const got = await bot.get(org, String(run!.id));
    assert.equal(got.status, 'done');
    await assert.rejects(bot.openWorkOrder(org, String(run!.id), null), /already/);
    const list = await bot.list(org, cp);
    assert.equal(list.runs.length, 1);
    // A second run at once is refused while one is going.
    await query(`INSERT INTO diagnostic_run (org_id, charge_point_id) VALUES ($1, $2)`, [org, cp]);
    await assert.rejects(bot.start(org, cp, { userId: null }), /already going/);
  });
});
