import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 37 (v1.49.0):
 *   - battery swap: the cabinet's key, slot status registering packs, a rider's plan paid from credit, swaps included,
 *     then paid per swap from credit, then refused without credit; idempotent by reference; packs move between cabinet
 *     and rider; a faulty pack raises the alert; renewal and lapse;
 *   - roadside: the quote, refused outside every van's radius, the nearest van suggested, assigning (a van on one request
 *     only), done paid from credit with the rest collected, cancel, the waiting alert;
 *   - warranty and RMA: coverage states, a case in warranty from the charger's warranty, the steps needing their fields,
 *     the stale and expiring alerts;
 *   - amenities: the accessibility score, saving and the app's filter, drivers' reports and resolving them.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/phase37.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const swap = await import('./battery-swap.js');
const roadside = await import('./roadside.js');
const warranty = await import('./warranty.js');
const amen = await import('./amenities.js');
const credit = await import('./driver-credit.js');

const TAG = randomBytes(3).toString('hex');
let org = '', site = '', cp = '', user = '', dr = '';

describe('Phase 37, pure', () => {
  test('roadside: distance, ETA and price', () => {
    const d = roadside.km(-6.2, 106.8, -6.3, 106.8);
    assert.ok(d > 11 && d < 11.3, `about 11.1 km (${d})`);
    assert.equal(roadside.etaMinutes(15), 40);
    assert.equal(roadside.priceOf(150_000, 4_000, 12.5), 200_000);
  });
  test('warranty: coverage states', () => {
    const at = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    assert.equal(warranty.coverageState(null), 'none');
    assert.equal(warranty.coverageState(at(-1)), 'expired');
    assert.equal(warranty.coverageState(at(30)), 'expiring');
    assert.equal(warranty.coverageState(at(200)), 'covered');
  });
  test('amenities: the accessibility score and the app filter', () => {
    const a = amen.accessScore({ accessibleBays: 1, stepFree: true, bayWidthM: 3.8, cableReachM: 2.5, maxScreenHeightCm: 110 });
    assert.equal(a.score, 4);
    assert.equal(a.accessible, true);
    assert.equal(amen.accessScore({ accessibleBays: 2, stepFree: null, bayWidthM: null, cableReachM: null, maxScreenHeightCm: null }).accessible, false, 'step-free not checked');
    assert.equal(amen.matches({ amenities: ['toilet', 'prayer_room'], accessible: true }, ['toilet', 'accessible']), true);
    assert.equal(amen.matches({ amenities: ['toilet'], accessible: false }, ['accessible']), false);
    assert.equal(amen.matches(undefined, ['toilet']), false);
    assert.equal(amen.matches(undefined, []), true);
  });
});

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`P37 ${TAG}`, `p37-${TAG}`]))!.id;
    site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code, timezone, lat, lon) VALUES ($1, $2, 'ID', 'Asia/Jakarta', -6.2, 106.8) RETURNING id`, [org, `Hub ${TAG}`]))!.id;
    cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name, adopted_at, status, vendor, model, serial) VALUES ($1, $2, $2, now(), 'active', 'Acme', 'DC60', 'SN-1') RETURNING id`, [site, `P37-${TAG}`]))!.id;
    user = randomUUID();
    await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, 'Rina')`, [user, org, `${user.slice(0, 8)}@p37.test`]);
    dr = (await one<{ id: string }>(`INSERT INTO app_driver (phone, name) VALUES ($1, 'Budi') RETURNING id`, [`+62813${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`]))!.id;
  });
}

const credits = async () => (await credit.balance(org, dr, (await credit.settings(org)).currency)).totalMinor;

dbDescribe('Phase 37: battery swap', () => {
  let key = '', planId = '', riderCode = '';
  test('a cabinet with its key; its slot status registers the packs', async () => {
    await swap.saveSettings(org, { enabled: true, pricePerSwapMinor: 8_000, minSocOut: 90 });
    const c = await swap.saveCabinet(org, null, { siteId: site, code: `C-${TAG}`, name: 'Pasar', slots: 4 }) as any;
    key = c.key;
    assert.match(key, /^swk_/);
    await assert.rejects(swap.cabinetEvent('swk_nope', { type: 'status' }), /Unknown cabinet key/);
    const r = await swap.cabinetEvent(key, { type: 'status', slots: [{ slot: 1, serial: `P1-${TAG}`, soc: 95, soh: 92 }, { slot: 2, serial: `P2-${TAG}`, soc: 40, soh: 90 }, { slot: 3, serial: `P3-${TAG}`, soc: 99, soh: 60 }] }) as any;
    assert.equal(r.packs, 3);
    await query(`UPDATE swap_battery SET capacity_wh = 1500 WHERE org_id = $1`, [org]);
    const ov = await swap.overview(org);
    assert.equal(ov.cabinets[0]!.ready, 2, 'packs at 90 % or more without a fault');
    assert.equal(ov.cabinets[0]!.online, true);
    const al = await one<any>(`SELECT * FROM alert WHERE org_id = $1 AND kind = 'swap.battery_attention' AND resolved_at IS NULL`, [org]);
    assert.match(al.message, /60 % health/);
  });

  test('a rider subscribes from credit; swaps are included, then paid, then refused', async () => {
    const p = await swap.savePlan(org, null, { name: 'Ojol 2', monthlyMinor: 50_000, swapsIncluded: 1 }) as any;
    planId = p.id;
    await assert.rejects(swap.subscribe(dr, org, { planId }), /Saldo kredit tidak cukup/);
    await credit.adjust(org, dr, { amountMinor: 60_000, note: 'test' }, null);
    const d = await swap.subscribe(dr, org, { planId }) as any;
    riderCode = d.subscription.riderCode;
    assert.match(riderCode, /^SWP-/);
    assert.equal(await credits(), 10_000);
    await assert.rejects(swap.subscribe(dr, org, { planId }), /sudah berlangganan/);

    const auth = await swap.cabinetEvent(key, { type: 'authorize', riderCode }) as any;
    assert.equal(auth.allowed, true);
    assert.equal(auth.outcome, 'included');
    const s1 = await swap.cabinetEvent(key, { type: 'swap', reference: `R1-${TAG}`, riderCode, batteryIn: { serial: `X-${TAG}`, soc: 12, slot: 4 }, batteryOut: { serial: `P1-${TAG}`, soc: 95 } }) as any;
    assert.equal(s1.outcome, 'included');
    assert.equal(s1.kwh, 1.245, '(95 − 12) % of 1.5 kWh');
    const again = await swap.cabinetEvent(key, { type: 'swap', reference: `R1-${TAG}`, riderCode }) as any;
    assert.equal(again.repeated, true);
    const out = await one<any>(`SELECT * FROM swap_battery WHERE org_id = $1 AND serial = $2`, [org, `P1-${TAG}`]);
    assert.equal(out.status, 'with_rider');
    assert.equal(out.rider_id, dr);

    const s2 = await swap.cabinetEvent(key, { type: 'swap', reference: `R2-${TAG}`, riderCode, batteryIn: { serial: `P1-${TAG}`, soc: 20 }, batteryOut: { serial: `P3-${TAG}`, soc: 99 } }) as any;
    assert.equal(s2.outcome, 'paid');
    assert.equal(s2.amountMinor, 8_000);
    assert.equal(await credits(), 2_000);
    const back = await one<any>(`SELECT * FROM swap_battery WHERE org_id = $1 AND serial = $2`, [org, `P1-${TAG}`]);
    assert.equal(back.status, 'in_cabinet');
    assert.equal(back.cycles, 1);

    const s3 = await swap.cabinetEvent(key, { type: 'swap', reference: `R3-${TAG}`, riderCode, batteryIn: { serial: `P3-${TAG}`, soc: 30 }, batteryOut: { serial: `P1-${TAG}`, soc: 20 } }) as any;
    assert.equal(s3.outcome, 'refused');
    assert.match(s3.reason, /Not enough credit/);
    assert.equal(await credits(), 2_000, 'nothing taken');
    const unknown = await swap.cabinetEvent(key, { type: 'authorize', riderCode: 'SWP-NOPE00' }) as any;
    assert.equal(unknown.allowed, false);
    const ov = await swap.overview(org);
    assert.equal(ov.kpis.swaps24h, 2);
    assert.equal(ov.kpis.refused30d, 1);
  });

  test('renewal from credit, or the plan lapses', async () => {
    await query(`UPDATE swap_subscription SET period_end = current_date WHERE org_id = $1`, [org]);
    await swap.sweep();
    const s = await one<any>(`SELECT status FROM swap_subscription WHERE org_id = $1`, [org]);
    assert.equal(s.status, 'lapsed', 'not enough credit for the month');
    const auth = await swap.cabinetEvent(key, { type: 'authorize', riderCode }) as any;
    assert.equal(auth.allowed, false);
  });
});

dbDescribe('Phase 37: roadside', () => {
  let vanA = '', vanB = '', reqId = '';
  test('a quote; refused outside every van\'s radius; the nearest van first', async () => {
    await roadside.saveSettings(org, { enabled: true, calloutMinor: 150_000, perKwhMinor: 4_000, radiusKm: 20, maxKwh: 20 });
    vanA = ((await roadside.saveVan(org, null, { name: 'Van A', kwhCapacity: 60, kwOutput: 30, baseLat: -6.2, baseLon: 106.8 })) as any).id;
    vanB = ((await roadside.saveVan(org, null, { name: 'Van B', kwhCapacity: 60, kwOutput: 30, baseLat: -6.25, baseLon: 106.85 })) as any).id;
    await assert.rejects(roadside.createRequest(org, { lat: -7.5, lon: 110.4, kwh: 10 }), /di luar area layanan/);
    await assert.rejects(roadside.createRequest(org, { lat: -6.24, lon: 106.84, kwh: 50 }), /di luar batas/);
    await credit.adjust(org, dr, { amountMinor: 100_000, note: 'roadside' }, null);
    const r = await roadside.driverRequest(dr, org, { lat: -6.24, lon: 106.84, kwh: 10, connector: 'CCS2' }) as any;
    reqId = r.id;
    assert.equal(r.quoteMinor, 190_000);
    await assert.rejects(roadside.driverRequest(dr, org, { lat: -6.24, lon: 106.84, kwh: 10 }), /sudah punya permintaan/);
    const g = await roadside.getRequest(org, reqId);
    assert.equal(g.candidates[0]!.id, vanB, 'Van B is nearer');
  });

  test('waiting raises the alert; assigning resolves it; one request per van', async () => {
    await query(`UPDATE roadside_request SET created_at = now() - interval '12 minutes' WHERE id = $1`, [reqId]);
    assert.equal(await roadside.sweep() >= 1, true);
    assert.ok(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'roadside.unassigned' AND resolved_at IS NULL`, [org]));
    const a = await roadside.advance(org, reqId, { status: 'assigned', vanId: vanB });
    assert.equal(a.status, 'assigned');
    assert.ok(a.etaAt);
    assert.ok(!(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'roadside.unassigned' AND resolved_at IS NULL`, [org])));
    const other = await roadside.createRequest(org, { lat: -6.21, lon: 106.81, kwh: 5 });
    await assert.rejects(roadside.advance(org, other.id, { status: 'assigned', vanId: vanB }), /not available/);
    await roadside.advance(org, other.id, { status: 'cancelled', reason: 'Driver found a charger' });
    await assert.rejects(roadside.advance(org, reqId, { status: 'done', kwhDelivered: 10 }), /cannot go to done/);
  });

  test('done: paid from credit, the rest collected; the van is free again', async () => {
    await roadside.advance(org, reqId, { status: 'en_route' });
    await roadside.advance(org, reqId, { status: 'charging' });
    await assert.rejects(roadside.advance(org, reqId, { status: 'done', kwhDelivered: 12.5 }), /left after credit/);
    assert.equal(await credits(), 102_000, 'nothing taken by the refused attempt');
    const d = await roadside.advance(org, reqId, { status: 'done', kwhDelivered: 12.5, collectedBy: 'qris' });
    assert.equal(d.amountMinor, 200_000);
    assert.equal(d.creditMinor, 102_000);
    assert.equal(d.collectMinor, 98_000);
    assert.equal(d.collectedBy, 'qris');
    assert.equal(await credits(), 0);
    const v = (await roadside.vans(org)).find((x) => x.id === vanB)!;
    assert.equal(v.status, 'available');
    assert.ok(v.kwhLeft < 60);
    const info = await roadside.driverInfo(dr, org) as any;
    assert.equal(info.request.status, 'done');
    void vanA;
  });
});

dbDescribe('Phase 37: warranty and RMA', () => {
  let sup = '', rma = '';
  test('a charger\'s warranty; an RMA in warranty; each step needs its field', async () => {
    sup = String((await one<any>(`INSERT INTO supplier (org_id, name) VALUES ($1, 'Acme Charging') RETURNING id`, [org])).id);
    let list = await warranty.chargers(org);
    assert.equal(list.chargers.find((c) => c.id === cp)!.state, 'none');
    const in20 = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    await assert.rejects(warranty.saveWarranty(org, null, { chargePointId: cp, startsOn: '2026-01-01', endsOn: '2025-01-01' }), /ends before/);
    await warranty.saveWarranty(org, null, { chargePointId: cp, supplierId: sup, startsOn: '2024-11-01', endsOn: in20, covers: ['parts', 'labour'] });
    list = await warranty.chargers(org);
    assert.equal(list.chargers.find((c) => c.id === cp)!.state, 'expiring');
    const r = await warranty.openRma(org, { chargePointId: cp, part: 'Power module', fault: 'No output on gun 2' }, user);
    rma = r.id;
    assert.equal(r.inWarranty, true);
    assert.equal(r.supplierId, sup, 'the warranty\'s supplier');
    await assert.rejects(warranty.updateRma(org, rma, { status: 'shipped' }, user), /cannot move to shipped/);
    await warranty.updateRma(org, rma, { status: 'requested' }, user);
    await assert.rejects(warranty.updateRma(org, rma, { status: 'approved' }, user), /vendorRef/);
    const ap = await warranty.updateRma(org, rma, { status: 'approved', vendorRef: 'ACME-RMA-77', note: 'Approved by e-mail' }, user);
    assert.equal(ap.history.length, 3);
  });

  test('stale and expiring alerts; closing resolves the stale one', async () => {
    await query(`UPDATE rma_case SET status_since = now() - interval '20 days' WHERE id = $1`, [rma]);
    const s = await warranty.sweep();
    assert.ok(s.stale >= 1 && s.expiring >= 1);
    assert.ok(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'rma.stale' AND resolved_at IS NULL`, [org]));
    assert.ok(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'warranty.expiring'`, [org]));
    const again = await warranty.sweep();
    assert.equal(again.expiring, 0, 'once per warranty');
    await warranty.updateRma(org, rma, { status: 'shipped', trackingOut: 'JNE123' }, user);
    assert.ok(!(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'rma.stale' AND resolved_at IS NULL`, [org])), 'still waiting, but a new step');
    await assert.rejects(warranty.updateRma(org, rma, { status: 'replaced' }, user), /replacement/);
    await warranty.updateRma(org, rma, { status: 'replaced', replacementSerial: 'PM-NEW-1' }, user);
    const c = await warranty.updateRma(org, rma, { status: 'closed' }, user);
    assert.equal(c.status, 'closed');
    const k = (await warranty.rmas(org)).kpis;
    assert.equal(k.open, 0);
  });
});

dbDescribe('Phase 37: amenities and accessibility', () => {
  test('saving, the app\'s view of it, a driver\'s report and resolving it', async () => {
    await assert.rejects(amen.save(org, site, { amenities: ['spa'] }), /amenities are some of/);
    const a = await amen.save(org, site, { amenities: ['toilet', 'prayer_room'], accessibleBays: 1, stepFree: true, bayWidthM: 3.6, verified: true });
    assert.equal(a.accessible, true);
    assert.equal(a.score, 3);
    assert.ok(a.verifiedOn);
    const m = await amen.forSites([site]);
    assert.deepEqual(m.get(site)!.amenities, ['toilet', 'prayer_room']);
    assert.equal(amen.matches(m.get(site), ['prayer_room', 'accessible']), true);
    await assert.rejects(amen.driverReport(dr, site, null, { kind: 'nope' }), /Pilih jenis masalah/);
    const r = await amen.driverReport(dr, site, null, { kind: 'blocked_bay', details: 'A petrol car in the accessible bay' });
    await assert.rejects(amen.driverReport(dr, site, null, { kind: 'other' }), /sudah kami terima/);
    assert.ok(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'access.report' AND resolved_at IS NULL`, [org]));
    const l = await amen.list(org);
    assert.equal(l.summary.openReports, 1);
    await assert.rejects(amen.resolveReport(org, r.id, { status: 'resolved' }), /resolution/);
    await amen.resolveReport(org, r.id, { status: 'resolved', resolution: 'Signs and a bollard added' });
    assert.equal((await amen.reports(org)).length, 0);
    assert.ok(!(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'access.report' AND resolved_at IS NULL`, [org])));
  });
});
