import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 34 (v1.46.0):
 *   - the field app: a template's checklist on a job, take and arrive, photos (kept once, the type checked), the
 *     signature, a part issued from stock, finishing refused until the required items, photo and signature are there,
 *     an offline change applied once;
 *   - residential and workplace charging: a group's chargers leave the public map and only members' cards start them,
 *     a member with a new card, a duplicate card refused, the month's statements (rate × kWh + the fee), issue and pay,
 *     the manager's page by its link (cards masked; adding a member is audited);
 *   - plate cameras: the fee (grace, started hours, members exempt), an entry and an exit, the barrier opened for a
 *     known car, a low-confidence read only recorded, settling a visit, the overstay alert;
 *   - the trip planner: stops along the line, the reserve, a trip that cannot be done.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/phase34.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const field = await import('./field.js');
const priv = await import('./private-charging.js');
const anpr = await import('./anpr.js');
const trips = await import('../driver/trips.js');

const TAG = randomBytes(3).toString('hex');
let org = '', site = '', cpA = '', cpB = '', connA = '', user = '', wo = '';
const JPEG = (n: number) => `data:image/jpeg;base64,${Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(200, n)]).toString('base64')}`;
const PNG = `data:image/png;base64,${Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(200, 7)]).toString('base64')}`;

const station = (name: string, lat: number, lon: number, kw = 60, free = 1) => ({
  siteId: randomUUID(), name, address: null, lat, lon, spkluId: null, operator: 'Op', distanceKm: null,
  connectors: [{ type: 'CCS2', typeLabel: 'CCS2', maxPowerKw: kw, current: 'DC' }], availableCount: free, totalCount: 2, maxPowerKw: kw, fastest: `${kw} kW`,
  priceFromMajor: 2500, currency: 'IDR',
}) as any;

describe('Phase 34, pure', () => {
  test('parking: the grace, started hours, members exempt', () => {
    const t = (m: number) => new Date(Date.UTC(2026, 10, 1, 0, m));
    // In at 0, charging 10–70, out at 145: idle 75 min after charging, grace 15 → 60 min over → 1 hour.
    let f = anpr.visitFee(t(0), t(145), [{ start: t(10), end: t(70) }], 15, 10000);
    assert.deepEqual(f, { stayMinutes: 145, chargingMinutes: 60, overstayMinutes: 60, feeMinor: 10000 });
    f = anpr.visitFee(t(0), t(146), [{ start: t(10), end: t(70) }], 15, 10000);
    assert.equal(f.feeMinor, 20000, '61 minutes over: two started hours');
    assert.equal(anpr.visitFee(t(0), t(30), [], 60, 10000).feeMinor, 0, 'inside the grace');
    assert.equal(anpr.visitFee(t(0), t(200), [], 0, 10000, true).feeMinor, 0, 'members do not pay');
    assert.equal(anpr.visitFee(t(0), t(200), [], 0, 10000, true).overstayMinutes, 200);
    assert.equal(anpr.normPlate(' b 1234-xyz '), 'B1234XYZ');
  });

  test('trips: stops along the way, charging to 80 %, the reserve', () => {
    // Jakarta → Semarang, about 405 km straight (×1.3 ≈ 525 km road). Range 300 km, from 90 %.
    const from = { lat: -6.2, lon: 106.82 }, to = { lat: -6.99, lon: 110.42 };
    // Stations a little off the straight line at 20, 40, 60 and 80 % of the way, and one far from it.
    const at = (f: number, dLat = 0.03) => [from.lat + (to.lat - from.lat) * f + dLat, from.lon + (to.lon - from.lon) * f] as const;
    const st = [station('S20', ...at(0.2)), station('S40', ...at(0.4, -0.05)), station('S60', ...at(0.6)), station('S80', ...at(0.8, -0.02)),
      station('Far away', -8.5, 108.5)];
    const p = trips.planTrip({ from, to, socPct: 90, rangeKm: 300 }, st) as any;
    assert.equal(p.feasible, true);
    assert.ok(p.distanceKm > 500 && p.distanceKm < 560, `${p.distanceKm} km`);
    // 225 km to the first stop (90 % − the 15 % reserve), then 195 km each (80 % − 15 %): S40, S60, S80.
    assert.deepEqual(p.stops.map((x: any) => x.name), ['S40', 'S60', 'S80']);
    assert.ok(!p.stops.some((s: any) => s.name === 'Far away'), 'off the line');
    for (const s of p.stops) { assert.ok(s.arriveSocPct >= 15, `arrive with the reserve (${s.arriveSocPct})`); assert.equal(s.leaveSocPct, 80); assert.ok(s.chargeMinutes > 0); }
    assert.ok(p.arriveSocPct >= 15);
    // Already in range: no stop.
    assert.equal((trips.planTrip({ from, to: { lat: -6.4, lon: 107.4 }, socPct: 80, rangeKm: 400 }, st) as any).stops.length, 0);
    // No station on the way.
    const none = trips.planTrip({ from, to, socPct: 50, rangeKm: 200 }, [station('Far away', -8.5, 108.5)]) as any;
    assert.equal(none.feasible, false);
    assert.equal(none.reason, 'no_station_in_reach');
    assert.throws(() => trips.planTrip({ from, to, socPct: 50, rangeKm: 10 }, st), /50 sampai 1500/);
    assert.equal(trips.chargeMinutes(20, 80, 60, 60), 36);
    assert.equal(trips.chargeMinutes(80, 90, 60, 60), 12, 'above 80 % at half speed');
  });
});

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`P34 ${TAG}`, `p34-${TAG}`]))!.id;
    site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code, timezone, lat, lon) VALUES ($1, $2, 'ID', 'Asia/Jakarta', -6.2, 106.8) RETURNING id`, [org, `Tower ${TAG}`]))!.id;
    cpA = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name, adopted_at) VALUES ($1, $2, $2, now()) RETURNING id`, [site, `P34A-${TAG}`]))!.id;
    cpB = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name, adopted_at) VALUES ($1, $2, $2, now()) RETURNING id`, [site, `P34B-${TAG}`]))!.id;
    const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [cpA]))!.id;
    connA = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, max_power_w) VALUES ($1, 11000) RETURNING id`, [e]))!.id;
    user = randomUUID();
    await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, 'Teknisi')`, [user, org, `${user.slice(0, 8)}@p34.test`]);
    wo = (await one<{ id: string }>(
      `INSERT INTO work_order (org_id, kind, status, site_id, charge_point_id, title, currency, opened_on, number) VALUES ($1, 'preventive', 'open', $2, $3, 'Quarterly check', 'IDR', current_date, $4) RETURNING id`,
      [org, site, cpA, `WO-${TAG}`]))!.id.toString();
  });
  after(async () => {
    for (const t of ['plate_event', 'parking_visit', 'anpr_camera', 'private_statement', 'private_member', 'private_unit', 'private_group_charger', 'private_group',
      'work_order_photo', 'field_op', 'stock_move', 'alert'])
      await query(`DELETE FROM ${t} WHERE org_id = $1`, [org]).catch((e) => console.error(t, e.message));
    await query(`DELETE FROM work_order WHERE org_id = $1`, [org]).catch((e) => console.error('wo', e.message));
    await query(`DELETE FROM field_template WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM stock_item WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM stock_location WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM cdr WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM charging_session WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM fleet_vehicle WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM token WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM app_user WHERE id = $1`, [user]).catch(() => {});
    await query(`DELETE FROM connector WHERE id = $1`, [connA]).catch(() => {});
    await query(`DELETE FROM evse WHERE charge_point_id = ANY($1::uuid[])`, [[cpA, cpB]]).catch(() => {});
    await query(`DELETE FROM charge_point WHERE id = ANY($1::uuid[])`, [[cpA, cpB]]).catch(() => {});
    await query(`DELETE FROM site WHERE id = $1`, [site]).catch(() => {});
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => {});
    await pool.end();
  });
}

dbDescribe('Phase 34 with the database', () => {
  test('field: checklist, photos, signature, a part, finishing, an offline change once', async () => {
    const tpl = await field.saveTemplate(org, null, { name: 'Preventive', kind: 'preventive', requirePhoto: true, requireSignature: true,
      items: [{ id: 'cab', label: 'Cable and plug inspected' }, { id: 'rcd', label: 'RCD tested' }, { id: 'cln', label: 'Cleaned', required: false }] });
    await assert.rejects(field.saveTemplate(org, null, { name: 'Empty', items: [] }), /1 to 60/);
    const mine = await field.jobs(org, user, {});
    assert.ok(mine.some((j) => j.id === wo), `an unassigned job is offered: ${wo} in ${JSON.stringify(mine.map((j) => j.id))}`);
    let j = await field.job(org, wo);
    assert.equal(j.template?.id, tpl.id);
    assert.deepEqual(j.checklist.map((x) => x.id), ['cab', 'rcd', 'cln']);
    assert.equal(j.charger?.identity, `P34A-${TAG}`);
    j = await field.update(org, wo, { action: 'take' }, user);
    assert.equal(j.assigneeId, user);
    await assert.rejects(field.update(org, wo, { action: 'take' }, randomUUID()), /has this job/);
    j = await field.update(org, wo, { action: 'arrive', opId: `op-${TAG}-1` }, user);
    assert.equal(j.status, 'in_progress');
    assert.ok(j.arrivedAt);
    j = await field.update(org, wo, { action: 'checklist', items: [{ id: 'cab', done: true, note: 'OK' }], opId: `op-${TAG}-2` }, user);
    // The same offline change again: applied once (the second, with different content, is ignored).
    j = await field.update(org, wo, { action: 'checklist', items: [{ id: 'cab', done: false }], opId: `op-${TAG}-2` }, user);
    assert.equal(j.checklist.find((x) => x.id === 'cab')!.done, true, 'the repeated change is not applied again');
    await assert.rejects(field.update(org, wo, { action: 'finish' }, user), /RCD tested/);
    j = await field.update(org, wo, { action: 'checklist', items: [{ id: 'rcd', done: true }] }, user);
    await assert.rejects(field.update(org, wo, { action: 'finish' }, user), /photo/);
    const p1 = await field.addPhoto(org, wo, { dataUrl: JPEG(1), caption: 'Before' }, user);
    assert.equal(p1.duplicate, false);
    assert.equal((await field.addPhoto(org, wo, { dataUrl: JPEG(1) }, user)).duplicate, true, 'kept once');
    await assert.rejects(field.addPhoto(org, wo, { dataUrl: `data:image/jpeg;base64,${Buffer.alloc(200, 1).toString('base64')}` }, user), /not the image/);
    const ph = await field.photo(org, p1.id);
    assert.equal(ph.mime, 'image/jpeg');
    assert.equal(ph.data.subarray(0, 3).toString('hex'), 'ffd8ff');
    await assert.rejects(field.update(org, wo, { action: 'finish' }, user), /signature/);
    await assert.rejects(field.sign(org, wo, { name: 'Pak Andi', dataUrl: JPEG(2) }), /PNG/);
    j = await field.sign(org, wo, { name: 'Pak Andi', dataUrl: PNG });
    assert.equal(j.signatureName, 'Pak Andi');
    assert.equal((await field.signature(org, wo)).subarray(0, 4).toString('hex'), '89504e47');
    // A part from the van.
    const item = String((await one<{ id: string }>(`INSERT INTO stock_item (org_id, sku, name, currency) VALUES ($1, $2, 'Fuse 16A', 'IDR') RETURNING id`, [org, `FUS-${TAG}`]))!.id);
    const loc = String((await one<{ id: string }>(`INSERT INTO stock_location (org_id, name) VALUES ($1, 'Van 1') RETURNING id`, [org]))!.id);
    const inv = await import('./inventory.js');
    await inv.move(org, { kind: 'receipt', itemId: item, locationId: loc, qty: 5, unitCost: 15000 }, null);
    j = await field.issuePart(org, wo, { itemId: item, locationId: loc, qty: 2 }, user);
    assert.equal(j.parts.length, 1);
    assert.equal(j.parts[0]!.qty, 2);
    await assert.rejects(field.issuePart(org, wo, { itemId: item, locationId: loc, qty: 50 }, user));
    j = await field.update(org, wo, { action: 'finish', labourHours: 1.5, notes: 'All good.' }, user);
    assert.equal(j.status, 'done');
    assert.equal(j.labourHours, 1.5);
    await assert.rejects(field.update(org, wo, { action: 'arrive' }, user), /done/);
  });

  test('private: members only, the public map, statements, the manager\'s page', async () => {
    const g = await priv.saveGroup(org, null, { siteId: site, name: 'Tower residents', kind: 'residential', rateMinor: 2500, monthlyFeeMinor: 50000, managerEmail: 'pm@tower.test' }) as any;
    assert.equal(g.billing, 'per_unit');
    assert.equal(g.currency, 'IDR');
    await priv.setChargers(org, g.id, { chargePointIds: [cpA] });
    const g2 = await priv.saveGroup(org, null, { siteId: site, name: 'Office', kind: 'workplace' });
    await assert.rejects(priv.setChargers(org, g2.id, { chargePointIds: [cpA] }), /another group/);
    // Off the public map.
    const { listStations } = await import('../driver/stations.js');
    const st = await listStations(undefined, org);
    const ids = st.flatMap((s) => s.connectors.map((c: any) => c.id ?? c.connectorUuid));
    assert.ok(!ids.includes(connA), 'a private connector is not listed');
    const u = await priv.saveUnit(org, g.id, null, { code: 'A-12', name: 'Keluarga Sari' }) as any;
    await assert.rejects(priv.saveUnit(org, g.id, null, { code: 'A-12' }), /already a unit/);
    const m = await priv.saveMember(org, g.id, null, { unitId: u.id, name: 'Sari', cardUid: `c-${TAG}-01`, plate: 'B 1234 SRI' });
    const tok = (await one<{ id: string }>(`SELECT token_id AS id FROM private_member WHERE id = $1`, [m.id]))!.id;
    await assert.rejects(priv.saveMember(org, g.id, null, { unitId: u.id, name: 'Copy', tokenId: tok }), /another member/);
    assert.equal(await priv.privateCheck(cpA, tok), 'allowed');
    const stranger = (await one<{ id: string }>(`INSERT INTO token (org_id, kind, uid) VALUES ($1, 'rfid', $2) RETURNING id`, [org, `X${TAG}`]))!.id;
    assert.equal(await priv.privateCheck(cpA, stranger), 'refused');
    assert.equal(await priv.privateCheck(cpA, null), 'refused');
    assert.equal(await priv.privateCheck(cpB, stranger), null, 'not a private charger');
    // Last month: 12 kWh by Sari's card.
    const sid = (await one<{ id: string }>(
      `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, token_id, idem_key, started_at, ended_at, energy_wh, state)
       VALUES ($1,$2,$3,$4,$5,$6, date_trunc('month', now()) - interval '10 days', date_trunc('month', now()) - interval '10 days' + interval '2 hours', 12000, 'rated') RETURNING id, to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM') AS m`,
      [org, site, connA, cpA, tok, `p34-${randomUUID()}`]))!;
    const month = (await one<{ m: string }>(`SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM') AS m FROM charging_session WHERE id = $1`, [sid.id]))!.m;
    const d = await priv.draftStatements(org, g.id, month);
    assert.equal(d.drafted, 1);
    const s = d.statements[0]!;
    assert.deepEqual([s.unit, s.sessions, s.kwh, s.energyMinor, s.feeMinor, s.amountMinor, s.status], ['A-12', 1, 12, 30000, 50000, 80000, 'draft']);
    await assert.rejects(priv.setStatement(org, s.id, 'paid'), /draft statement cannot be marked paid/);
    assert.equal((await priv.setStatement(org, s.id, 'issue')).status, 'issued');
    assert.equal((await priv.draftStatements(org, g.id, month)).drafted, 0, 'an issued statement is kept');
    assert.equal((await priv.setStatement(org, s.id, 'paid')).status, 'paid');
    assert.ok((await priv.statementsXlsx(org, g.id, month)).length > 1000);
    assert.equal((await priv.draftStatements(org, g2.id, month)).drafted, 0, 'no units, nothing to bill');
    await priv.saveGroup(org, g2.id, { billing: 'none' });
    await assert.rejects(priv.draftStatements(org, g2.id, month), /does not bill/);
    // The manager's page.
    const link = await priv.rotatePortal(org, g.id);
    assert.match(link.path, /^\/building\/bld_/);
    const view = await priv.portalView(link.token) as any;
    assert.equal(view.name, 'Tower residents');
    assert.equal(view.chargers.length, 1);
    assert.match(view.members[0].card, /^…/);
    assert.equal(view.members[0].tokenId, undefined);
    await priv.portalChange(link.token, { action: 'add_member', unitId: u.id, name: 'Budi', cardUid: `c-${TAG}-02` });
    assert.equal((await priv.detail(org, g.id)).members.length, 2);
    const audited = await one<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE org_id = $1 AND action = 'private_group.portal_add_member'`, [org]);
    assert.equal(Number(audited!.n), 1);
    await assert.rejects(priv.portalView('bld_wrongwrongwrongwrongwrong'), /not valid/);
    await priv.rotatePortal(org, g.id);
    await assert.rejects(priv.portalView(link.token), /not valid/, 'the old link stops working');
  });

  test('plates: entry, the barrier, exit with the fee, low confidence, settling, overstay', async () => {
    const hits: any[] = [];
    const srv = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { hits.push(JSON.parse(b)); res.end('{}'); }); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const port = (srv.address() as any).port;
      await assert.rejects(anpr.saveCamera(org, null, { siteId: site, name: 'Gate', gatePolicy: 'known', gateUrl: 'ftp://example.com/open' }), /gateUrl/);
      const cam = await anpr.saveCamera(org, null, { siteId: site, name: 'Gate', direction: 'both', gatePolicy: 'known', gateUrl: `http://127.0.0.1:${port}/open`, gateAuthorization: 'Bearer x' }) as any;
      assert.match(cam.key, /^cam_/);
      assert.equal(cam.gateHasAuth, true);
      assert.equal(((await anpr.cameras(org))[0] as any).key, undefined, 'the key is shown once');
      await anpr.siteParking(org, site, { graceMinutes: 15, feePerHourMinor: 10000, maxMinutes: 60, plateAutostart: true });
      // A fleet van (known), and a stranger.
      await query(`INSERT INTO fleet_vehicle (org_id, name, plate) VALUES ($1, 'Van', 'B 9 VAN')`, [org]);
      const t0 = new Date(Date.now() - 3 * 3_600_000);
      let r: any = await anpr.ingest(cam.key, { plate: 'b9van', confidence: 92, at: t0.toISOString() });
      assert.equal(r.events[0]!.direction, 'entry');
      assert.equal(r.events[0]!.matched, 'vehicle');
      assert.equal(r.events[0]!.gate?.opened, true);
      assert.equal(hits[0].plate, 'B9VAN');
      r = await anpr.ingest(cam.key, { plate: 'D 1 XX', confidence: 90, at: t0.toISOString() });
      assert.equal(r.events[0]!.matched, 'none');
      assert.equal(r.events[0]!.gate, null, 'a stranger: the barrier stays shut under "known"');
      r = await anpr.ingest(cam.key, { plate: 'Z 77 ZZ', confidence: 40 });
      assert.equal(r.events[0]!.ignored, 'low confidence');
      assert.equal(r.events[0]!.visitId, null);
      // The overstay alert (entered 3 hours ago, at most 60 minutes).
      assert.ok(await anpr.sweep() >= 2);
      const al = await many<any>(`SELECT * FROM alert WHERE org_id = $1 AND kind = 'parking.overstay' AND resolved_at IS NULL`, [org]);
      assert.ok(al.length >= 2);
      // The van leaves after 3 hours, no charging: 180 − 15 = 165 min → 3 started hours.
      r = await anpr.ingest(cam.key, { plate: 'B9VAN', confidence: 95 });
      assert.equal(r.events[0]!.direction, 'exit', 'the open visit makes it an exit');
      assert.equal(r.events[0]!.feeMinor, 30000);
      const v = (await anpr.visits(org, { plate: 'B9V' }))[0]!;
      assert.equal(v.status, 'closed');
      assert.equal(v.who, 'Fleet: Van');
      await assert.rejects(anpr.settleVisit(org, v.id, 'refund'), /paid or waived/);
      assert.equal((await anpr.settleVisit(org, v.id, 'waived')).status, 'waived');
      await assert.rejects(anpr.settleVisit(org, v.id, 'paid'), /closed visit/);
      assert.ok((await anpr.events(org)).length >= 4);
      await assert.rejects(anpr.ingest('cam_wrongwrongwrongwrongwrong', { plate: 'B1' }), /Unknown key/);
      await anpr.saveCamera(org, cam.id, { enabled: false });
      await assert.rejects(anpr.ingest(cam.key, { plate: 'B9VAN' }), /switched off/);
      // Plate start with nobody waiting does nothing.
      const none = await anpr.onConnectorStatus({ orgId: org, ocppIdentity: `P34B-${TAG}`, connectorId: 1, status: 'Preparing' });
      assert.equal(none?.started, false);
    } finally { srv.close(); }
  });
});
