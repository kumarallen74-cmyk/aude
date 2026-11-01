import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 33 (v1.45.0):
 *   - the support desk: due times, a case from the app linked to its session, a reply and an internal note, a macro, the
 *     inbound e-mail webhook (a new case, then a reply to it by its [PS-n] tag), the SLA sweep and its alert, stats;
 *   - demand forecasting: the hour-of-week profile and trend, connectors to add, the candidate score, a site's forecast;
 *   - driver credit: gift card and voucher batches, redeeming (once, wrong codes refused), holding for a charge
 *     (promotional first), settling (the rest comes back, paid-for first), what credit pays at settlement, referrals
 *     (rewarded after a qualifying session, own code and repeat refused), the month's movement and its ledger lines;
 *   - telematics: the field map, the webhook (unknown vehicles counted), a fresh state of charge.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/phase33.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const desk = await import('./support-desk.js');
const fc = await import('./demand-forecast.js');
const credit = await import('./driver-credit.js');
const tlm = await import('./telematics.js');

const TAG = randomBytes(3).toString('hex');
let org = '', site = '', cp = '', conn = '', drA = '', drB = '', devA = '', devB = '', tok = '', sessionId = '';

describe('Phase 33, pure', () => {
  test('support: due times by priority; categories guessed; quoted e-mail stripped', () => {
    const t0 = new Date('2026-11-01T00:00:00Z');
    const d = desk.dueTimes('urgent', desk.DEFAULT_SLA, t0);
    assert.equal(d.firstDue.toISOString(), '2026-11-01T00:30:00.000Z');
    assert.equal(d.resolveDue.toISOString(), '2026-11-01T04:00:00.000Z');
    assert.equal(desk.guessCategory('Saya minta refund, uang kembali'), 'refund');
    assert.equal(desk.guessCategory('Charger mati, tidak bisa mengisi'), 'charger_fault');
    assert.equal(desk.guessCategory('QRIS charged twice'), 'payment');
    assert.equal(desk.stripQuoted('Thanks, that worked.\n\nOn Mon, 1 Nov 2026 at 10:00 PlugSure wrote:\n> We refunded it.'), 'Thanks, that worked.');
  });

  test('forecast: the profile, the trend, connectors to add, the score', () => {
    const now = new Date('2026-11-02T00:00:00Z'); // Monday 07:00 Jakarta
    // Every weekday 18:00–20:00 (Jakarta) one of two connectors busy, for 8 weeks.
    const spans: Array<{ start: Date; end: Date; kwh: number }> = [];
    for (let d = 1; d <= 56; d++) {
      const day = new Date(now.getTime() - d * 86_400_000);
      const wd = fc.weekHour(day, 'Asia/Jakarta');
      if (Math.floor(wd / 24) > 4) continue;
      const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 11)); // 18:00 Jakarta
      spans.push({ start, end: new Date(start.getTime() + 2 * 3_600_000), kwh: 20 });
    }
    const p = fc.profileOf(spans, 2, 'Asia/Jakarta', now);
    const mon18 = 0 * 24 + 18, mon19 = 19, mon20 = 20;
    assert.ok(Math.abs(p[mon18]!.occupancy - 0.5) < 0.01, `Monday 18:00 half busy (${p[mon18]!.occupancy})`);
    assert.ok(Math.abs(p[mon19]!.occupancy - 0.5) < 0.01);
    assert.equal(p[mon20]!.occupancy, 0);
    assert.ok(Math.abs(p[mon18]!.sessions - 1) < 0.01);
    assert.equal(p[5 * 24 + 18]!.occupancy, 0, 'Saturday quiet');
    assert.equal(fc.trendOf(spans, now), 1);
    assert.equal(fc.connectorsToAdd(4, 0.95), 2, '4 × 0.95/0.7 = 5.4 → 6');
    assert.equal(fc.connectorsToAdd(4, 0.6), 0);
    assert.ok(Math.abs(fc.haversineKm({ lat: -6.2, lon: 106.8 }, { lat: -6.3, lon: 106.8 }) - 11.12) < 0.05);
    const sites = [{ lat: -6.2, lon: 106.8, sessions30d: 600, peakOccupancy: 0.9 }];
    const near = fc.scorePlace({ lat: -6.21, lon: 106.8, connectors: 2 }, sites, 600);
    const far = fc.scorePlace({ lat: -7.2, lon: 106.8, connectors: 2 }, sites, 600);
    assert.ok(near.demandScore > far.demandScore);
    assert.equal(far.gapScore, 100, 'more than 10 km from any site');
    assert.equal(near.sitesWithin5km, 1);
    assert.equal(near.pressureScore, 90);
  });

  test('credit: codes, what credit pays at settlement', () => {
    const c = credit.newCode();
    assert.match(c, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(credit.hashCode(c.toLowerCase().replace(/-/g, ' ')), credit.hashCode(c), 'case and separators do not matter');
    assert.equal(credit.creditShare('preauth', 30_000, 50_000, 0), 30_000, 'a card hold captures only the rest');
    assert.equal(credit.creditShare('preauth', 30_000, 20_000, 0), 20_000);
    assert.equal(credit.creditShare('prepurchase', 30_000, 50_000, 20_000), 30_000, 'paid 20k, cost 50k: credit pays 30k');
    assert.equal(credit.creditShare('prepurchase', 30_000, 15_000, 20_000), 0, 'cost under what was paid: credit untouched, the gateway money is refunded');
    assert.equal(credit.creditShare('prepurchase', 30_000, 35_000, 20_000), 15_000);
  });

  test('telematics: the field map', () => {
    const now = new Date('2026-11-01T10:00:00Z');
    const rs = tlm.readingsFrom({ data: { vehicles: [{ vin: 'V1', battery: { level: '0.62' }, odo: 12345, ts: 1793520000 }, { vin: '', battery: { level: 0.5 } }, { vin: 'V2', battery: { level: 2 } }] } },
      { list: 'data.vehicles', vehicleId: 'vin', socPct: 'battery.level', socIsFraction: 'true', odometerKm: 'odo', at: 'ts' }, now);
    assert.equal(rs.length, 2, 'a reading without an id is dropped');
    assert.equal(rs[0]!.vehicleId, 'V1');
    assert.equal(rs[0]!.socPct, 62);
    assert.equal(rs[0]!.odometerKm, 12345);
    assert.equal(rs[0]!.at.toISOString(), new Date(1793520000 * 1000).toISOString(), 'seconds since 1970');
    assert.equal(rs[1]!.socPct, null, '2 as a share is out of range: dropped, not guessed');
    assert.equal(tlm.readingsFrom({ vehicleId: 'X', socPct: 70, at: '2030-01-01T00:00:00Z' }, {}, now)[0]!.at.toISOString(), now.toISOString(), 'a time in the future is taken as now');
  });
});

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`P33 ${TAG}`, `p33-${TAG}`]))!.id;
    site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code, timezone, lat, lon) VALUES ($1, $2, 'ID', 'Asia/Jakarta', -6.2, 106.8) RETURNING id`, [org, `Hub ${TAG}`]))!.id;
    cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name, adopted_at) VALUES ($1, $2, $2, now()) RETURNING id`, [site, `P33-${TAG}`]))!.id;
    const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [cp]))!.id;
    conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, max_power_w) VALUES ($1, 22000) RETURNING id`, [e]))!.id;
    drA = (await one<{ id: string }>(`INSERT INTO app_driver (phone, name, email) VALUES ($1, 'Ana', 'ana@example.com') RETURNING id`, [`+6281${TAG}01`]))!.id;
    drB = (await one<{ id: string }>(`INSERT INTO app_driver (phone, name) VALUES ($1, 'Budi') RETURNING id`, [`+6281${TAG}02`]))!.id;
    devA = (await one<{ id: string }>(`INSERT INTO driver_device (device_hash, app_driver_id) VALUES ($1, $2) RETURNING id`, [`p33-${TAG}-a`, drA]))!.id;
    devB = (await one<{ id: string }>(`INSERT INTO driver_device (device_hash, app_driver_id) VALUES ($1, $2) RETURNING id`, [`p33-${TAG}-b`, drB]))!.id;
    tok = (await one<{ id: string }>(`INSERT INTO token (org_id, kind, uid) VALUES ($1, 'rfid', $2) RETURNING id`, [org, `P33${TAG}`]))!.id;
    sessionId = (await one<{ id: string }>(
      `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, ended_at, energy_wh, state) VALUES ($1,$2,$3,$4,$5, now() - interval '2 hours', now() - interval '1 hour', 12000, 'rated') RETURNING id`,
      [org, site, conn, cp, `p33-${randomUUID()}`]))!.id;
    await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency) VALUES ($1,$2,now(),'[]'::jsonb,30000,0,0,0,0,0,30000,'{}'::jsonb,'IDR')`, [sessionId, org]);
  });
  after(async () => {
    for (const t of ['support_message', 'support_case', 'support_macro', 'support_settings', 'driver_credit_entry', 'referral', 'referral_code', 'gift_card', 'gift_card_batch', 'credit_settings', 'vehicle_telemetry', 'site_candidate', 'alert'])
      await query(`DELETE FROM ${t} WHERE org_id = $1`, [org]).catch((e) => console.error(t, e.message));
    await query(`DELETE FROM fleet_vehicle WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM telematics_connection WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM driver_charge WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM cdr WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM charging_session WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM driver_device WHERE id = ANY($1::uuid[])`, [[devA, devB]]).catch(() => {});
    await query(`DELETE FROM token WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM app_driver WHERE id = ANY($1::uuid[])`, [[drA, drB]]).catch(() => {});
    await query(`DELETE FROM connector WHERE id = $1`, [conn]).catch(() => {});
    await query(`DELETE FROM evse WHERE charge_point_id = $1`, [cp]).catch(() => {});
    await query(`DELETE FROM charge_point WHERE id = $1`, [cp]).catch(() => {});
    await query(`DELETE FROM site WHERE id = $1`, [site]).catch(() => {});
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => {});
    await pool.end();
  });
}

dbDescribe('Phase 33 with the database', () => {
  test('support: a case from the app, a reply, a note, a macro, the SLA alert, stats', async () => {
    const dcId = (await one<{ id: string }>(`INSERT INTO driver_charge (device_id, token_id, app_driver_id, org_id, connector_uuid, mode, session_id) VALUES ($5,$6,$1,$2,$3,'fleet',$4) RETURNING id`, [drA, org, conn, sessionId, devA, tok]))!.id;
    await assert.rejects(desk.driverCreate(drA, { chargeId: dcId, body: 'Saya ditagih dua kali' }), /belum menerima/, 'the desk is off');
    await desk.saveSettings(org, { enabled: true, sla: { normal: { first: 60, resolve: 600 } } }, null);
    const c = await desk.driverCreate(drA, { chargeId: dcId, body: 'Saya ditagih dua kali untuk sesi ini' });
    assert.equal(c.ref, 'PS-1');
    assert.equal(c.category, 'payment');
    const full = await desk.get(org, c.id);
    assert.equal(full.sessionId, sessionId);
    assert.equal(full.chargePointId, cp);
    assert.equal(full.charger, `P33-${TAG}`);
    assert.equal(full.session?.totalMinor, 30000);
    const m = await desk.saveMacro(org, null, { name: 'Refund on the way', body: 'Hi {{name}}, case {{number}}: the refund for {{charger}} is on its way.', setStatus: 'resolved' }) as any;
    await desk.reply(org, c.id, { body: 'Checked the gateway: one payment only.', internal: true }, null);
    const after1 = await desk.reply(org, c.id, { macroId: m.id }, null);
    assert.equal(after1.status, 'resolved', 'the macro set the status');
    assert.ok(after1.firstRespondedAt);
    const last = after1.messages[after1.messages.length - 1]!;
    assert.equal(last.body, `Hi Ana, case PS-1: the refund for P33-${TAG} is on its way.`);
    assert.equal(last.delivery, 'in_app');
    const dv = await desk.driverCase(drA, c.id);
    assert.equal(dv.messages.length, 2, 'the internal note is not shown to the driver');
    await desk.driverReply(drA, c.id, { satisfaction: 5 });
    await desk.driverReply(drA, c.id, { body: 'Masih belum masuk' });
    assert.equal((await desk.get(org, c.id)).status, 'open', 'a reply from the driver reopens it');
    // A second case past its first-answer time.
    const c2 = await desk.create(org, { subject: 'Charger broken', body: 'It does not start', channel: 'console', priority: 'urgent', chargePointId: cp });
    await query(`UPDATE support_case SET first_response_due_at = now() - interval '1 minute' WHERE id = $1`, [c2.id]);
    assert.ok(await desk.slaSweep() >= 1);
    assert.equal((await desk.get(org, c2.id)).breached, true);
    assert.equal((await many(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = $2 AND resolved_at IS NULL`, [org, desk.SLA_ALERT])).length, 1);
    assert.equal(await desk.slaSweep() >= 0, true);
    assert.equal((await many(`SELECT occurrences FROM alert WHERE org_id = $1 AND kind = $2`, [org, desk.SLA_ALERT]))[0]!.occurrences, 1, 'raised once');
    await desk.update(org, c2.id, { status: 'resolved' });
    assert.equal((await many(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = $2 AND resolved_at IS NULL`, [org, desk.SLA_ALERT])).length, 0, 'resolved with the case');
    const l = await desk.list(org, { status: 'active' });
    assert.equal(l.counts.active, 1);
    const st = await desk.stats(org, 30);
    assert.equal(st.opened, 2);
    assert.equal(st.satisfaction, 5);
  });

  test('support: the inbound e-mail webhook opens a case, and a reply to it is added', async () => {
    const { key } = await desk.rotateInboundKey(org, null);
    await assert.rejects(desk.inboundEmail('sup_wrongwrongwrongwrongwrong', { from: 'x@y.co', text: 'hi' }), /Unknown key/);
    const a = await desk.inboundEmail(key, { from: 'Citra <citra@example.com>', fromName: 'Citra', subject: 'Refund please', text: 'My session stopped early, refund please.' });
    assert.equal(a.created, true);
    const c = await desk.get(org, a.caseId);
    assert.equal(c.customerEmail, 'citra@example.com');
    assert.equal(c.category, 'refund');
    const b = await desk.inboundEmail(key, { from: 'citra@example.com', subject: `Re: [${a.ref}] Refund please`, text: 'Any news?\n\nOn Mon, 1 Nov 2026 at 10:00 Support wrote:\n> We are on it' });
    assert.equal(b.created, false);
    assert.equal(b.caseId, a.caseId);
    const again = await desk.get(org, a.caseId);
    assert.equal(again.messages[again.messages.length - 1]!.body, 'Any news?');
    const other = await desk.inboundEmail(key, { from: 'someone@else.com', subject: `Re: [${a.ref}] Refund please`, text: 'Not my case' });
    assert.equal(other.created, true, 'a tag from another sender opens a new case');
  });

  test('forecast: a site\'s profile, advice and a candidate', async () => {
    for (let d = 1; d <= 20; d++) {
      await query(`INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, ended_at, energy_wh, state) VALUES ($1,$2,$3,$4,$5, now() - make_interval(days => $6) - interval '3 hours', now() - make_interval(days => $6) - interval '1 hour', 15000, 'rated')`,
        [org, site, conn, cp, `p33f-${randomUUID()}`, d]);
    }
    const ov = await fc.overview(org);
    const s = ov.sites.find((x) => x.siteId === site)!;
    assert.equal(s.connectors, 1);
    assert.ok(s.utilisationPct > 0);
    assert.ok(s.next7Days.sessions >= 1, `next 7 days: ${s.next7Days.sessions}`);
    const f = await fc.siteForecast(org, site, 2);
    assert.equal(f.forecast.length, 48);
    assert.equal(f.heatmap.length, 168);
    await assert.rejects(fc.siteForecast(org, randomUUID(), 2), /No such site/);
    const cand = await fc.saveCandidate(org, null, { name: 'Mall parking', lat: -6.21, lon: 106.81, connectors: 4 }, null) as any;
    await assert.rejects(fc.saveCandidate(org, null, { name: 'Nowhere', lat: 0, lon: 0 }, null), /coordinates/);
    const list = await fc.candidates(org);
    const c = list.candidates.find((x) => x.id === cand.id)!;
    assert.ok(c.score > 0 && c.score <= 100);
    assert.ok(c.gapKm! < 2);
  });

  test('credit: batches, redeeming, a hold and its settlement, the movement and ledger', async () => {
    await credit.saveSettings(org, { enabled: true, currency: 'IDR', minGatewayMinor: 1000, referralEnabled: true, referrerRewardMinor: 20_000, refereeRewardMinor: 10_000, referralMinKwh: 5 }, null);
    const g = await credit.createBatch(org, { name: 'Corporate gifts', kind: 'gift', valueMinor: 50_000, priceMinor: 45_000, quantity: 2, soldOn: new Date().toISOString().slice(0, 10) }, null);
    assert.equal(g.codes.length, 2);
    const v = await credit.createBatch(org, { name: 'Launch', kind: 'voucher', valueMinor: 15_000, quantity: 1 }, null);
    await assert.rejects(credit.createBatch(org, { name: 'x', kind: 'gift', valueMinor: 100, priceMinor: 200, quantity: 1, soldOn: '2026-11-01' }, null), /at most its value/);
    const r = await credit.redeem(drA, g.codes[0]!.toLowerCase());
    assert.equal(r.amountMinor, 50_000);
    await assert.rejects(credit.redeem(drA, g.codes[0]!), /sudah dipakai/, 'once only');
    await assert.rejects(credit.redeem(drA, 'AAAA-BBBB-CCCC'), /tidak ditemukan/);
    await credit.redeem(drA, v.codes[0]!);
    assert.deepEqual(await credit.balance(org, drA, 'IDR'), { totalMinor: 65_000, fundedMinor: 50_000 });
    // A charge holds 40k: the 15k voucher first, then 25k of the gift card.
    const dc = randomUUID();
    const h = await credit.hold(org, drA, 'IDR', 40_000, dc);
    assert.deepEqual(h, { heldMinor: 40_000, fundedMinor: 25_000 });
    assert.deepEqual(await credit.hold(org, drA, 'IDR', 40_000, dc), h, 'idempotent');
    assert.equal((await credit.balance(org, drA, 'IDR')).totalMinor, 25_000);
    // The session used 30k of it: 10k comes back, paid-for first.
    assert.deepEqual(await credit.settle(dc, 30_000), { usedMinor: 30_000, releasedMinor: 10_000 });
    assert.deepEqual(await credit.settle(dc, 0), { usedMinor: 30_000, releasedMinor: 10_000 }, 'settled once');
    assert.deepEqual(await credit.balance(org, drA, 'IDR'), { totalMinor: 35_000, fundedMinor: 35_000 });
    const m = await credit.movement(org, new Date().toISOString().slice(0, 7), 'IDR');
    assert.equal(m.giftSoldPriceMinor, 90_000);
    assert.equal(m.giftSoldValueMinor, 100_000);
    assert.equal(m.usedFundedMinor, 15_000, 'held 25k of gift credit, 10k came back');
    assert.equal(m.usedPromotionalMinor, 15_000);
    const j = (await credit.journal(org, new Date().toISOString().slice(0, 7))).IDR!;
    const sum = (k: 'debit' | 'credit') => j.reduce((a, l) => a + l[k], 0);
    assert.equal(sum('debit'), sum('credit'), 'balanced');
    assert.ok(j.some((l) => l.account === '2260' && l.credit === 100_000));
    assert.ok(j.some((l) => l.account === '4110' && l.credit === 15_000));
    // A promotional take-back cannot touch paid-for credit.
    await assert.rejects(credit.adjust(org, drA, { amountMinor: -5_000, note: 'oops' }, null), /promotional/);
    // Expiry.
    await query(`UPDATE driver_credit_entry SET expires_at = now() - interval '1 minute' WHERE org_id = $1 AND app_driver_id = $2 AND remaining_minor > 0`, [org, drA]);
    assert.ok(await credit.expireCredits() >= 1);
    assert.equal((await credit.balance(org, drA, 'IDR')).totalMinor, 0);
  });

  test('credit: a referral is rewarded after the new driver\'s first qualifying session', async () => {
    const code = await credit.referralCode(org, drA);
    assert.equal(await credit.referralCode(org, drA), code, 'one code per driver');
    await assert.rejects(credit.applyReferral(drA, null, code), /kode sendiri/);
    const r = await credit.applyReferral(drB, devB, code.toLowerCase());
    assert.equal(r.refereeRewardMinor, 10_000);
    await assert.rejects(credit.applyReferral(drB, devB, code), /sudah memakai/);
    assert.equal(await credit.qualifyReferrals(), 0, 'no session yet');
    const s2 = (await one<{ id: string }>(
      `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, ended_at, energy_wh, state) VALUES ($1,$2,$3,$4,$5, now() + interval '1 second', now() + interval '30 minutes', 8000, 'rated') RETURNING id`,
      [org, site, conn, cp, `p33r-${randomUUID()}`]))!.id;
    await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency) VALUES ($1,$2,now(),'[]'::jsonb,20000,0,0,0,0,0,20000,'{}'::jsonb,'IDR')`, [s2, org]);
    await query(`INSERT INTO driver_charge (app_driver_id, org_id, connector_uuid, mode, session_id, device_id, token_id) VALUES ($1,$2,$3,'fleet',$4,$5,$6)`, [drB, org, conn, s2, devB, tok]);
    assert.equal(await credit.qualifyReferrals(), 1);
    assert.equal((await credit.balance(org, drB, 'IDR')).totalMinor, 10_000);
    assert.equal((await credit.balance(org, drA, 'IDR')).totalMinor, 20_000);
    const dv = await credit.driverCredit(drA);
    assert.equal(dv.referralCodes[0]!.code, code);
  });

  test('telematics: the webhook stores readings for linked vehicles; a fresh reading is the state of charge', async () => {
    const depot = await import('./depot.js');
    const v = await depot.saveVehicle(org, null, { name: 'Van 1', batteryKwh: 60 }) as any;
    const c = await tlm.saveConnection(org, null, { name: 'Fleet platform', kind: 'webhook', fieldMap: { list: 'vehicles', vehicleId: 'vin', socPct: 'soc' } }) as any;
    assert.match(c.key, /^tlm_/);
    await tlm.linkVehicle(org, v.id, { connectionId: c.id, telematicsId: 'VIN123' });
    const r = await tlm.webhook(c.key, { vehicles: [{ vin: 'VIN123', soc: 41 }, { vin: 'NOPE', soc: 10 }] });
    assert.deepEqual(r, { readings: 2, stored: 1, unknownVehicles: 1 });
    assert.equal(await tlm.freshSoc(v.id), 41);
    const lat = await tlm.latest(org);
    assert.equal(lat[0]!.socPct, 41);
    assert.equal(lat[0]!.fresh, true);
    await assert.rejects(tlm.saveConnection(org, null, { name: 'Bad', kind: 'poll', url: 'ftp://example.com/x' }), /only http/);
    await assert.rejects(tlm.webhook('tlm_wrongwrongwrongwrongwrong', {}), /Unknown key/);
    const vs = await depot.vehicles(org);
    assert.equal(vs.find((x: any) => x.id === v.id)!.socPct, 41);
  });
});
