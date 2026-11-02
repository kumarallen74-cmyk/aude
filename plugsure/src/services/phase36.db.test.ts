import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 36 (v1.48.0):
 *   - hotels: check-in with a guest card (one guest per room), the PMS's check-in, room move and check-out, a stay's
 *     session posted to the folio (signed) or put on the statement, the valet page;
 *   - installations: the stage tasks, moving on only when the required ones are done, documents (type checked), going
 *     live needs the site, cancelling needs a reason, the overdue alert;
 *   - privacy: a request found by phone, verified, completed (access copy, correction, objection, erasure); the app's
 *     request and consents; the inventory; retention clearing plates and comments; the due alert;
 *   - battery health: capacity from the state of charge gained, the trend, the flags; estimates from sessions with
 *     SoC meter values, a capacity drop raising the alert, the fleet's state of health.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/phase36.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const hotel = await import('./hotel.js');
const inst = await import('./installations.js');
const privacy = await import('./privacy.js');
const battery = await import('./battery-health.js');

const TAG = randomBytes(3).toString('hex');
let org = '', site = '', cp = '', conn = '', user = '', dr = '', dev = '', tok = '';

describe('Phase 36, pure', () => {
  test('battery: capacity from the charge gained, the median, the trend, the flags', () => {
    assert.equal(battery.capacityOf(39.13, 20, 80), 60);
    assert.equal(battery.capacityOf(10, 70, 85), null, 'under 20 points gained: too little to say');
    assert.equal(battery.capacityOf(10, null, 80), null);
    assert.equal(battery.median([3, 1, 2]), 2);
    assert.equal(battery.median([4, 1, 2, 3]), 2.5);
    const y0 = Date.UTC(2025, 0, 1);
    const pts = [0, 120, 240, 365].map((d, i) => ({ at: new Date(y0 + d * 86_400_000), capacityKwh: 60 - i * 0.8 }));
    const s = battery.slopePerYear(pts)!;
    assert.ok(s < -2 && s > -3, `about −2.4 kWh a year (${s})`);
    assert.equal(battery.slopePerYear(pts.slice(0, 2)), null);
    const recent = { capacities: [60, 59.5, 60.2, 59.8], peaks: [95, 100, 98] };
    assert.deepEqual(battery.flagsFor({ capacityKwh: 52, peakKw: 97 }, 64, recent), ['capacity_drop']);
    assert.deepEqual(battery.flagsFor({ capacityKwh: 59.9, peakKw: 40 }, 64, recent), ['slow_charging']);
    assert.deepEqual(battery.flagsFor({ capacityKwh: 45, peakKw: 97 }, 64, recent), ['capacity_drop', 'low_health']);
    assert.deepEqual(battery.flagsFor({ capacityKwh: 90, peakKw: 97 }, 64, recent), ['implausible']);
    assert.deepEqual(battery.flagsFor({ capacityKwh: 52, peakKw: 30 }, 64, { capacities: [60], peaks: [] }), [], 'too little history to compare');
  });

  test('installations: the stages and their tasks', () => {
    assert.deepEqual([...inst.STAGES], ['survey', 'design', 'permit', 'grid', 'install', 'commission', 'live']);
    assert.ok(inst.DEFAULT_TASKS.grid.some((t) => /PLN/.test(t.title)));
  });
});

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`P36 ${TAG}`, `p36-${TAG}`]))!.id;
    site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code, timezone, lat, lon) VALUES ($1, $2, 'ID', 'Asia/Jakarta', -8.7, 115.2) RETURNING id`, [org, `Resort ${TAG}`]))!.id;
    cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name, adopted_at, status) VALUES ($1, $2, $2, now(), 'active') RETURNING id`, [site, `P36-${TAG}`]))!.id;
    const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [cp]))!.id;
    conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, max_power_w, status) VALUES ($1, 22000, 'Available') RETURNING id`, [e]))!.id;
    user = randomUUID();
    await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, 'Putu')`, [user, org, `${user.slice(0, 8)}@p36.test`]);
    dr = (await one<{ id: string }>(`INSERT INTO app_driver (phone, name, email) VALUES ($1, 'Made', 'made@example.com') RETURNING id`, [`+62812${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`]))!.id;
    dev = (await one<{ id: string }>(`INSERT INTO driver_device (device_hash, app_driver_id) VALUES ($1, $2) RETURNING id`, [`p36-${TAG}`, dr]))!.id;
    tok = (await one<{ id: string }>(`INSERT INTO token (org_id, kind, uid) VALUES ($1, 'rfid', $2) RETURNING id`, [org, `P36${TAG}`]))!.id;
  });
  after(async () => {
    for (const t of ['vehicle_battery_estimate', 'privacy_consent', 'privacy_request', 'privacy_settings', 'install_stage_event', 'install_document', 'install_task', 'install_project',
      'hotel_charge', 'hotel_stay', 'hotel_property', 'survey_response', 'plate_event', 'anpr_camera', 'remote_start_request', 'audit_log', 'alert'])
      await query(`DELETE FROM ${t} WHERE org_id = $1`, [org]).catch((e) => console.error(t, e.message));
    await query(`DELETE FROM meter_value WHERE session_id IN (SELECT id FROM charging_session WHERE org_id = $1)`, [org]).catch(() => {});
    await query(`DELETE FROM driver_charge WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM cdr WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM charging_session WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM fleet_vehicle WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM app_driver_deletion WHERE app_driver_id = $1`, [dr]).catch(() => {});
    await query(`DELETE FROM driver_device WHERE app_driver_id = $1 OR id = $2`, [dr, dev]).catch(() => {});
    await query(`DELETE FROM token WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM app_driver WHERE id = $1`, [dr]).catch(() => {});
    await query(`DELETE FROM app_user WHERE id = $1`, [user]).catch(() => {});
    await query(`DELETE FROM connector WHERE id = $1`, [conn]).catch(() => {});
    await query(`DELETE FROM evse WHERE charge_point_id = $1`, [cp]).catch(() => {});
    await query(`DELETE FROM charge_point WHERE id = $1`, [cp]).catch(() => {});
    await query(`DELETE FROM site WHERE id = $1`, [site]).catch(() => {});
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => {});
    await pool.end();
  });
}

const session = async (startSql: string, wh: number, tokenId: string | null, totalMinor: number | null = null, state = 'rated') => {
  const s = (await one<{ id: string }>(
    `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, token_id, idem_key, started_at, ended_at, energy_wh, state)
     VALUES ($1,$2,$3,$4,$5,$6, ${startSql}, ${startSql} + interval '1 hour', $7, $8) RETURNING id`, [org, site, conn, cp, tokenId, `p36-${randomUUID()}`, wh, state]))!.id;
  if (totalMinor != null) await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency) VALUES ($1,$2,now(),'[]'::jsonb,$3,0,0,0,0,0,$3,'{}'::jsonb,'IDR')`, [s, org, totalMinor]);
  return s;
};

dbDescribe('Phase 36 with the database', () => {
  test('hotels: stays, the PMS, charges to the folio and the statement, the valet', async () => {
    const hits: Array<{ sig: string | undefined; body: any }> = [];
    const srv = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { hits.push({ sig: req.headers['x-plugsure-signature'] as string, body: JSON.parse(b) }); res.end('{}'); }); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const port = (srv.address() as any).port;
      const h = await hotel.saveProperty(org, null, { siteId: site, name: 'Ubud Resort', posting: 'pms', pmsUrl: `http://127.0.0.1:${port}/folio`, pmsSecret: 'pms-secret' }) as any;
      assert.match(h.pmsKey, /^hpk_/);
      const st = await hotel.checkIn(org, h.id, { room: '214', guestName: 'Anna Schmidt', reservationRef: 'R-88' });
      await assert.rejects(hotel.checkIn(org, h.id, { room: '214', guestName: 'Someone' }), /already has a guest/);
      // The PMS: a check-in for another room, a repeat, a room move, then the first guest checks out later.
      const pms = await hotel.pmsEvent(h.pmsKey, { event: 'check_in', room: '305', guestName: 'Budi Santoso', reservationRef: 'R-90' }) as any;
      assert.equal((await hotel.pmsEvent(h.pmsKey, { event: 'check_in', room: '305', guestName: 'Budi Santoso', reservationRef: 'R-90' }) as any).duplicate, true);
      assert.equal((await hotel.pmsEvent(h.pmsKey, { event: 'room_move', reservationRef: 'R-90', newRoom: '306' }) as any).room, '306');
      await assert.rejects(hotel.pmsEvent('hpk_wrongwrongwrongwrongwrong', { event: 'check_in' }), /Unknown key/);
      assert.equal((await hotel.stays(org, h.id)).length, 2);
      // A session with the first guest's card: posted to the folio, signed.
      const gtok = (await one<{ token_id: string }>(`SELECT token_id FROM hotel_stay WHERE id = $1`, [Number(st.id)]))!.token_id;
      await session(`now() - interval '2 hours'`, 22000, gtok, 66000);
      const r = await hotel.settle();
      assert.equal(r.linked, 1);
      assert.equal(r.posted, 1);
      assert.equal(hits[0]!.body.room, '214');
      assert.equal(hits[0]!.body.amountMinor, 66000);
      assert.match(hits[0]!.sig ?? '', /^t=\d+,v1=[0-9a-f]{64}$/);
      const ch = await hotel.charges(org, h.id);
      assert.deepEqual([ch[0]!.status, ch[0]!.kwh], ['posted', 22]);
      // Check-out retires the guest card.
      await hotel.updateStay(org, st.id, { action: 'check_out' });
      assert.equal((await one<any>(`SELECT status FROM token WHERE id = $1`, [gtok])).status, 'Expired');
      assert.equal((await hotel.pmsEvent(h.pmsKey, { event: 'check_out', reservationRef: 'R-90' }) as any).status, 'checked_out');
      // A statement hotel: the charge goes on the month's statement.
      const h2 = await hotel.saveProperty(org, null, { siteId: site, name: 'Garden Inn', posting: 'statement' }) as any;
      const s2 = await hotel.checkIn(org, h2.id, { room: '1', guestName: 'Citra' });
      const t2 = (await one<{ token_id: string }>(`SELECT token_id FROM hotel_stay WHERE id = $1`, [Number(s2.id)]))!.token_id;
      await session(`now() - interval '3 hours'`, 10000, t2, 30000);
      assert.equal((await hotel.settle()).statement, 1);
      const stmt = await hotel.statement(org, h2.id, new Date().toISOString().slice(0, 7));
      assert.deepEqual([stmt.charges.length, stmt.amountMinor, stmt.kwh], [1, 30000, 10]);
      assert.ok((await hotel.statementXlsx(org, h2.id, new Date().toISOString().slice(0, 7))).length > 1000);
      // The valet page: rooms by initial; a start needs the charger connected.
      const v = await hotel.rotateValet(org, h2.id);
      const view = await hotel.valetView(v.token);
      assert.deepEqual(view.rooms.map((x) => [x.room, x.guest]), [['1', 'C.']]);
      assert.equal(view.connectors.length, 1);
      await assert.rejects(hotel.valetAction(v.token, { action: 'start', stayId: s2.id, connectorId: conn }), /not connected/);
      await assert.rejects(hotel.valetView('vlt_wrongwrongwrongwrongwrong'), /not valid/);
      await assert.rejects(hotel.saveProperty(org, h2.id, { archive: true }), /in house/);
    } finally { srv.close(); }
  });

  test('installations: tasks gate the stages, documents, live needs the site, overdue', async () => {
    const p = await inst.save(org, null, { name: 'Mall Bali Galeria', chargersPlanned: 4, kwPlanned: 240, targetLiveOn: '2026-01-15', ownerId: user }, user);
    assert.match(p.number, /^INS-\d{4}$/);
    assert.equal(p.stage, 'survey');
    assert.equal(p.tasks.filter((t) => t.stage === 'survey').length, 4);
    await assert.rejects(inst.advance(org, p.id, { action: 'advance' }, user), /Not done yet: Site visit/);
    let g = p;
    for (const t of g.tasks.filter((x) => x.stage === 'survey' && x.required)) g = await inst.saveTask(org, p.id, t.id, { done: true }, user);
    g = await inst.advance(org, p.id, { action: 'advance', note: 'Survey accepted' }, user);
    assert.equal(g.stage, 'design');
    assert.ok(g.tasks.some((t) => t.stage === 'design'), 'the design tasks are added');
    assert.deepEqual(g.history.map((h) => h.to), ['survey', 'design']);
    // Documents: a PDF, and a file that is not what it says.
    const pdf = `data:application/pdf;base64,${Buffer.from('%PDF-1.4\n%test\n').toString('base64')}`;
    const d = await inst.addDocument(org, p.id, { kind: 'survey', name: 'Survey report.pdf', dataUrl: pdf }, user);
    await assert.rejects(inst.addDocument(org, p.id, { kind: 'drawing', name: 'x.pdf', dataUrl: `data:application/pdf;base64,${Buffer.from('not a pdf').toString('base64')}` }, user), /not the type/);
    assert.equal((await inst.document(org, d.id)).data.subarray(0, 5).toString(), '%PDF-');
    // Through to commission (every required task ticked), then live needs the site.
    for (let i = 0; i < 4; i++) {
      for (const t of (await inst.get(org, p.id)).tasks.filter((x) => x.stage === g.stage && x.required && !x.done)) await inst.saveTask(org, p.id, t.id, { done: true }, user);
      g = await inst.advance(org, p.id, { action: 'advance' }, user);
    }
    assert.equal(g.stage, 'commission');
    for (const t of g.tasks.filter((x) => x.stage === 'commission' && x.required)) await inst.saveTask(org, p.id, t.id, { done: true }, user);
    await assert.rejects(inst.advance(org, p.id, { action: 'advance' }, user), /Link the site/);
    // Overdue (the target was in January): one alert.
    assert.ok(await inst.overdueSweep() >= 1);
    assert.equal((await many<any>(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'install.overdue' AND resolved_at IS NULL`, [org])).length, 1);
    assert.equal(await inst.overdueSweep().then(async () => (await many<any>(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'install.overdue'`, [org])).length), 1, 'once a week');
    await inst.save(org, p.id, { siteId: site }, user);
    g = await inst.advance(org, p.id, { action: 'advance' }, user);
    assert.equal(g.stage, 'live');
    assert.ok(g.liveOn);
    assert.equal((await many<any>(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'install.overdue' AND resolved_at IS NULL`, [org])).length, 0, 'resolved at go-live');
    const q = await inst.save(org, null, { name: 'Toll rest area' }, user);
    await assert.rejects(inst.advance(org, q.id, { action: 'cancel' }, user), /why/);
    assert.equal((await inst.advance(org, q.id, { action: 'cancel', note: 'Landlord withdrew' }, user)).stage, 'cancelled');
    const l = await inst.list(org);
    assert.equal(l.byStage.live, 1);
  });

  test('privacy: requests verified and completed, the app\'s side, inventory, retention, due alert', async () => {
    await privacy.saveSettings(org, { dpoName: 'Ketut', dpoEmail: 'dpo@resort.test', responseHours: 72, plateRetentionDays: 30, surveyCommentDays: 90 });
    const phone = (await one<{ phone: string }>(`SELECT phone FROM app_driver WHERE id = $1`, [dr]))!.phone;
    const r = await privacy.create(org, { kind: 'access', subjectPhone: `0${phone.slice(3)}`, channel: 'email' });
    assert.equal(r.appDriverId, dr, 'found by the phone number');
    assert.ok(new Date(r.dueAt).getTime() - Date.now() > 71 * 3_600_000);
    await assert.rejects(privacy.close(org, r.id, { action: 'complete' }, user), /Verify/);
    await assert.rejects(privacy.verify(org, r.id, {}, user), /verification/);
    await privacy.verify(org, r.id, { verification: 'Called back on the number and matched the last charge' }, user);
    const sid = await session(`now() - interval '5 hours'`, 9000, tok);
    await query(`INSERT INTO driver_charge (device_id, token_id, app_driver_id, org_id, connector_uuid, mode, session_id) VALUES ($1,$2,$3,$4,$5,'fleet',$6)`, [dev, tok, dr, org, conn, sid]);
    const done = await privacy.close(org, r.id, { action: 'complete', outcome: 'Copy sent by e-mail' }, user);
    assert.equal(done.status, 'done');
    assert.equal((done.result as any).sections.charges, 1);
    const data = await privacy.driverData(org, dr);
    assert.equal(data.account.name, 'Made');
    // Correction, objection.
    const c = await privacy.create(org, { kind: 'correction', appDriverId: dr });
    await privacy.verify(org, c.id, { verification: 'In the app' }, user);
    await privacy.close(org, c.id, { action: 'complete', name: 'Made Wirawan' }, user);
    assert.equal((await one<any>(`SELECT name FROM app_driver WHERE id = $1`, [dr])).name, 'Made Wirawan');
    // The app: consents and a request (verified at once).
    await privacy.setDriverConsent(dr, null, { purpose: 'marketing', granted: true });
    assert.equal((await privacy.driverConsents(dr, null)).consents.find((x) => x.purpose === 'marketing')!.granted, true);
    const appReq = await privacy.driverRequest(dr, null, { kind: 'objection', details: 'No more promotions' });
    const ob = (await privacy.requests(org)).find((x) => x.number === appReq.number)!;
    assert.equal(ob.status, 'verified');
    await privacy.close(org, ob.id, { action: 'complete', purposes: ['marketing'] }, user);
    assert.equal((await privacy.driverConsents(dr, null)).consents.find((x) => x.purpose === 'marketing')!.granted, false);
    const log = await privacy.consentLog(org);
    assert.equal(log.log.length, 2);
    // Inventory.
    const inv = await privacy.inventory(org);
    assert.equal(inv.find((x) => x.category === 'Vehicle plates')!.retention, '30 days');
    // Retention: an old plate read and an old survey comment are cleared.
    const cam = (await one<{ id: string }>(`INSERT INTO anpr_camera (org_id, site_id, name) VALUES ($1,$2,'Gate') RETURNING id`, [org, site]))!.id;
    await query(`INSERT INTO plate_event (org_id, site_id, camera_id, plate, direction, seen_at, matched) VALUES ($1,$2,$3,'DK1234AB','entry', now() - interval '40 days','none'), ($1,$2,$3,'DK9999ZZ','entry', now(),'none')`, [org, site, cam]);
    await query(`INSERT INTO survey_response (org_id, driver_charge_id, score, comment, created_at) VALUES ($1, gen_random_uuid(), 4, 'Old comment', now() - interval '100 days')`, [org]);
    const sw = await privacy.sweep();
    assert.ok(sw.plates >= 1 && sw.comments >= 1);
    assert.deepEqual((await many<any>(`SELECT plate FROM plate_event WHERE org_id = $1 ORDER BY seen_at`, [org])).map((x) => x.plate), ['*', 'DK9999ZZ']);
    // A request due within a day raises the alert once.
    const soon = await privacy.create(org, { kind: 'export', appDriverId: dr });
    await query(`UPDATE privacy_request SET due_at = now() + interval '2 hours' WHERE id = $1`, [Number(soon.id)]);
    assert.ok((await privacy.sweep()).due >= 1);
    assert.equal((await privacy.sweep()).due, 0);
    // Erasure: the account is anonymised as the app's own deletion does.
    const er = await privacy.create(org, { kind: 'erasure', appDriverId: dr });
    await privacy.verify(org, er.id, { verification: 'Signed letter' }, user);
    await privacy.close(org, er.id, { action: 'complete' }, user);
    const gone = await one<any>(`SELECT status, name, phone FROM app_driver WHERE id = $1`, [dr]);
    assert.equal(gone.status, 'deleted');
    assert.equal(gone.name, null);
    assert.match(gone.phone, /^deleted:/);
    await assert.rejects(privacy.close(org, er.id, { action: 'reject', outcome: 'x' }, user), /done/);
  });

  test('battery health: estimates from SoC meter values, a capacity drop raises the alert, the fleet view', async () => {
    const vtok = (await one<{ id: string }>(`INSERT INTO token (org_id, kind, uid) VALUES ($1, 'rfid', $2) RETURNING id`, [org, `VAN${TAG}`]))!.id;
    const v = (await one<{ id: string }>(`INSERT INTO fleet_vehicle (org_id, name, plate, battery_kwh, token_id) VALUES ($1, 'Van 3', 'DK 3 VAN', 64, $2) RETURNING id`, [org, vtok]))!.id;
    const add = async (daysAgo: number, wh: number, socs: [number, number], peakW: number) => {
      const s = await session(`now() - interval '${daysAgo} days'`, wh, vtok);
      await query(`INSERT INTO meter_value (session_id, ts, measurand, value, unit) VALUES ($1, now() - interval '${daysAgo} days', 'SoC', $2, 'Percent'), ($1, now() - interval '${daysAgo} days' + interval '50 minutes', 'SoC', $3, 'Percent'),
        ($1, now() - interval '${daysAgo} days' + interval '10 minutes', 'Power.Active.Import', $4, 'W')`, [s, socs[0], socs[1], peakW]);
      return s;
    };
    // Four normal sessions: 60 points for ~39.1 kWh → ~60 kWh usable.
    for (const d of [40, 30, 20, 10]) await add(d, 39130, [20, 80], 98000);
    // A small top-up (too little to say) and then a session that shows much less capacity.
    await add(8, 5000, [70, 80], 97000);
    const low = await add(2, 32610, [20, 80], 96000); // 32.61 × 0.92 / 0.6 = 50 kWh
    assert.equal(await battery.estimatePending(), 6);
    assert.equal(await battery.estimatePending(), 0, 'once per session');
    const e = await one<any>(`SELECT capacity_kwh, flags, soc_source FROM vehicle_battery_estimate WHERE session_id = $1`, [low]);
    assert.equal(Number(e.capacity_kwh), 50);
    assert.deepEqual(e.flags, ['capacity_drop']);
    assert.equal(e.soc_source, 'meter');
    assert.equal((await many<any>(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'vehicle.battery_anomaly' AND resolved_at IS NULL`, [org])).length, 1);
    const o = await battery.overview(org);
    const van = o.vehicles.find((x) => x.id === String(v))!;
    assert.equal(van.estimates, 5);
    assert.equal(van.capacityKwh, 60, 'the median of the last 90 days');
    assert.equal(van.sohPct, 93.8);
    assert.deepEqual(van.flags, ['capacity_drop']);
    assert.equal(o.fleet.measured, 1);
    const det = await battery.vehicle(org, String(v));
    assert.equal(det.sessions.length, 6);
    assert.ok(det.monthly.length >= 1);
    await assert.rejects(battery.vehicle(org, '999999999'), /No such vehicle/);
  });
});
