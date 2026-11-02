import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 35 (v1.47.0):
 *   - home charging: the amount under the cap; meter readings (the counter only goes up); a month drafted from
 *     readings and from OCPP sessions; approve, the payroll export; the employee's page and their reading;
 *   - card terminals: the amount to capture; a pre-authorisation refused when the charger is not connected; a payment
 *     linked to its session, captured at the session's total (never above the hold) through a signed callback; a
 *     polled void; the receipt; the settlement report matched;
 *   - energy prices: parsing (JSON, CSV, per MWh), the expensive quarter, the cap on the grid part, a site's cap now,
 *     the savings from charging at cheap hours;
 *   - surveys: NPS, the stable sample; asking after a charge, once; a detractor's comment opens a support case.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/phase35.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const home = await import('./home-charging.js');
const term = await import('./terminals.js');
const prices = await import('./energy-prices.js');
const surveys = await import('./surveys.js');

const TAG = randomBytes(3).toString('hex');
let org = '', site = '', cp = '', conn = '', dr = '', dev = '', tok = '';

describe('Phase 35, pure', () => {
  test('home: the amount under the cap', () => {
    assert.deepEqual(home.amountFor(120.5, 1444.7, null), { amountMinor: 174086, capped: false });
    assert.deepEqual(home.amountFor(500, 1500, 500000), { amountMinor: 500000, capped: true });
  });

  test('terminals: capture the total, never above the hold; nothing without energy', () => {
    assert.deepEqual(term.captureAmount(100000, 45210, 12000), { action: 'capture', amountMinor: 45210 });
    assert.deepEqual(term.captureAmount(100000, 130000, 30000), { action: 'capture', amountMinor: 100000 });
    assert.deepEqual(term.captureAmount(100000, null, 0), { action: 'void', amountMinor: 0 });
    assert.deepEqual(term.captureAmount(100000, 0, 500), { action: 'void', amountMinor: 0 });
  });

  test('prices: parsing, the expensive quarter, the cap on the grid part', () => {
    const j = prices.parsePrices({ prices: [{ start: '2026-11-02T00:00:00Z', price: 1200 }, { startsAt: 1793577600, value: 900, minutes: 30 }, { start: 'nope', price: 1 }] });
    assert.equal(j.points.length, 2);
    assert.equal(j.skipped, 1);
    assert.equal(j.points[1]!.minutes, 30);
    assert.equal(prices.parsePrices([{ start: '2026-11-02T00:00:00Z', price: 85000, per: 'MWh' }]).points[0]!.priceMinor, 85);
    const c = prices.parsePrices('start,price\n2026-11-02T01:00:00Z,1300\n2026-11-02T02:00:00Z;1400');
    assert.equal(c.points.length, 2);
    assert.equal(c.skipped, 1, 'the header');
    const day = [500, 600, 700, 800, 900, 1000, 1100, 1200];
    assert.equal(prices.expensiveCut(day), 1100, 'the top quarter: 1100 and 1200');
    assert.equal(prices.isExpensive(1100, day, null), true);
    assert.equal(prices.isExpensive(1000, day, null), false);
    assert.equal(prices.isExpensive(1000, day, 1000), true, 'a threshold decides when set');
    assert.equal(prices.isExpensive(700, [700, 700, 700], null), false, 'a flat day has no expensive hours');
    assert.equal(prices.applyPriceCap(30000, 5000, { capPct: 50 }), 17500, 'half the grid part, solar untouched');
    assert.equal(prices.applyPriceCap(30000, 0, null), 30000);
  });

  test('prices: energy spread over the hours, the saving against the average', () => {
    const h0 = Date.UTC(2026, 10, 1, 0);
    const kwh = prices.spreadHourly([{ start: new Date(h0 + 30 * 60_000), end: new Date(h0 + 90 * 60_000), kwh: 10 }]);
    assert.deepEqual([...kwh.entries()].map(([h, e]) => [h - h0, Math.round(e * 100) / 100]), [[0, 5], [3_600_000, 5]]);
    // All the energy in the cheap hour (100) with an expensive one (300) in the month: average 200.
    const s = prices.savingsOf(new Map([[h0, 10]]), new Map([[h0, 100], [h0 + 3_600_000, 300]]));
    assert.equal(s.costMinor, 1000);
    assert.equal(s.atAverageMinor, 2000);
    assert.equal(s.savingsMinor, 1000);
  });

  test('surveys: NPS and the stable sample', () => {
    assert.deepEqual(surveys.nps([10, 9, 8, 7, 6, 0]), { nps: 0, responses: 6, promoters: 2, passives: 2, detractors: 2 });
    assert.equal(surveys.nps([10, 10, 3]).nps, 33);
    assert.equal(surveys.nps([]).nps, null);
    const id = randomUUID();
    assert.equal(surveys.sampled(id, 37), surveys.sampled(id, 37), 'the same charge, the same answer');
    assert.equal(surveys.sampled(id, 100), true);
    const n = Array.from({ length: 2000 }, () => surveys.sampled(randomUUID(), 25)).filter(Boolean).length;
    assert.ok(n > 400 && n < 600, `about a quarter sampled (${n})`);
  });
});

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`P35 ${TAG}`, `p35-${TAG}`]))!.id;
    site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code, timezone, lat, lon) VALUES ($1, $2, 'ID', 'Asia/Jakarta', -6.2, 106.8) RETURNING id`, [org, `Plaza ${TAG}`]))!.id;
    cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name, adopted_at) VALUES ($1, $2, $2, now()) RETURNING id`, [site, `P35-${TAG}`]))!.id;
    const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [cp]))!.id;
    conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, max_power_w, status) VALUES ($1, 22000, 'Available') RETURNING id`, [e]))!.id;
    dr = (await one<{ id: string }>(`INSERT INTO app_driver (phone, name) VALUES ($1, 'Dewi') RETURNING id`, [`+6281${TAG}35`]))!.id;
    dev = (await one<{ id: string }>(`INSERT INTO driver_device (device_hash, app_driver_id) VALUES ($1, $2) RETURNING id`, [`p35-${TAG}`, dr]))!.id;
    tok = (await one<{ id: string }>(`INSERT INTO token (org_id, kind, uid) VALUES ($1, 'rfid', $2) RETURNING id`, [org, `P35${TAG}`]))!.id;
  });
  after(async () => {
    for (const t of ['survey_response', 'survey_settings', 'support_message', 'support_case', 'support_settings', 'terminal_settlement_line', 'terminal_txn', 'payment_terminal',
      'home_reimbursement', 'home_meter_reading', 'home_charger', 'energy_price', 'alert'])
      await query(`DELETE FROM ${t} WHERE org_id = $1`, [org]).catch((e) => console.error(t, e.message));
    await query(`UPDATE site SET price_zone_id = NULL WHERE id = $1`, [site]).catch(() => {});
    await query(`DELETE FROM energy_price_zone WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM remote_start_request WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM driver_charge WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM cdr WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM charging_session WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM driver_device WHERE id = $1`, [dev]).catch(() => {});
    await query(`DELETE FROM token WHERE org_id = $1`, [org]).catch(() => {});
    await query(`DELETE FROM app_driver WHERE id = $1`, [dr]).catch(() => {});
    await query(`DELETE FROM connector WHERE id = $1`, [conn]).catch(() => {});
    await query(`DELETE FROM evse WHERE charge_point_id = $1`, [cp]).catch(() => {});
    await query(`DELETE FROM charge_point WHERE id = $1`, [cp]).catch(() => {});
    await query(`DELETE FROM site WHERE id = $1`, [site]).catch(() => {});
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => {});
    await pool.end();
  });
}

const lastMonth = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
const session = async (startSql: string, wh: number, tokenId: string | null, state = 'rated', totalMinor: number | null = null) => {
  const s = (await one<{ id: string }>(
    `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, token_id, idem_key, started_at, ended_at, energy_wh, state)
     VALUES ($1,$2,$3,$4,$5,$6, ${startSql}, ${startSql} + interval '1 hour', $7, $8) RETURNING id`, [org, site, conn, cp, tokenId, `p35-${randomUUID()}`, wh, state]))!.id;
  if (totalMinor != null) await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency) VALUES ($1,$2,now(),'[]'::jsonb,$3,0,0,0,0,0,$3,'{}'::jsonb,'IDR')`, [s, org, totalMinor]);
  return s;
};

dbDescribe('Phase 35 with the database', () => {
  test('home charging: readings and OCPP, a month drafted, approved, the payroll export, the employee\'s page', async () => {
    const m = lastMonth();
    const rd = await home.save(org, null, { employeeName: 'Rudi', employeeRef: 'EMP-7', mode: 'readings', rateMinorPerKwh: 1444.7, currency: 'IDR' }) as any;
    await home.addReading(org, rd.id, { readOn: `${m}-01`, kwhTotal: 1000 }, 'console');
    await assert.rejects(home.addReading(org, rd.id, { readOn: `${m}-20`, kwhTotal: 990 }, 'console'), /cannot be lower/);
    // The month: the last reading in it minus the last one before it.
    await home.addReading(org, rd.id, { readOn: `${m}-28`, kwhTotal: 1180.5 }, 'console');
    const before = new Date(`${m}-01T00:00:00Z`); before.setUTCDate(0);
    await home.addReading(org, rd.id, { readOn: before.toISOString().slice(0, 10), kwhTotal: 950 }, 'console');
    const oc = await home.save(org, null, { employeeName: 'Sinta', employeeRef: 'EMP-9', mode: 'ocpp', chargePointId: cp, tokenId: tok, rateMinorPerKwh: 1500, monthlyCapMinor: 15000, currency: 'IDR' }) as any;
    await assert.rejects(home.save(org, null, { employeeName: 'Copy', mode: 'ocpp', chargePointId: cp, rateMinorPerKwh: 1, currency: 'IDR' }), /already/);
    await session(`($1::text)::date`.replace('$1', `'${m}-10'`), 9000, tok);
    await session(`($1::text)::date`.replace('$1', `'${m}-11'`), 4000, null); // another card: not counted
    const d = await home.draft(org, m);
    assert.equal(d.drafted, 2);
    const r1 = d.reimbursements.find((r) => r.employeeRef === 'EMP-7')!;
    assert.equal(r1.kwh, 230.5, '1180.5 − 950');
    assert.equal(r1.amountMinor, Math.round(230.5 * 1444.7));
    const r2 = d.reimbursements.find((r) => r.employeeRef === 'EMP-9')!;
    assert.equal(r2.kwh, 9);
    assert.equal(r2.amountMinor, 13500);
    assert.equal(r2.capped, false);
    // Off the public map.
    const { listStations } = await import('../driver/stations.js');
    assert.ok(!(await listStations(undefined, org)).some((s: any) => s.siteId === site), 'the home charger is not listed');
    await assert.rejects(home.setStatus(org, r1.id, 'paid', null), /draft reimbursement cannot be marked paid/);
    assert.equal((await home.setStatus(org, r1.id, 'approve', null)).status, 'approved');
    assert.equal((await home.draft(org, m)).drafted, 1, 'the approved one stays');
    const csv = await home.payrollCsv(org, m);
    assert.match(csv, /^employee_ref,employee_name/);
    assert.match(csv, /EMP-7,Rudi/);
    assert.doesNotMatch(csv, /EMP-9/, 'only approved ones');
    assert.ok((await home.xlsxFor(org, m)).length > 1000);
    // The employee's page.
    const link = await home.rotatePortal(org, rd.id);
    const v = await home.portalView(link.token);
    assert.equal(v.employeeName, 'Rudi');
    assert.equal(v.reimbursements[0]!.status, 'approved');
    const today = new Date().toISOString().slice(0, 10);
    const after = await home.portalReading(link.token, { readOn: today, kwhTotal: 1200 });
    assert.equal(after.readings[0]!.kwhTotal, 1200);
    await assert.rejects(home.portalView('hcr_wrongwrongwrongwrongwrong'), /not valid/);
  });

  test('terminals: refused when the charger is not connected; a payment captured by callback; a polled void; the receipt; settlement', async () => {
    const hits: Array<{ sig: string | undefined; body: any }> = [];
    let answer = 500;
    const srv = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { hits.push({ sig: req.headers['x-plugsure-signature'] as string, body: JSON.parse(b) }); res.statusCode = answer; res.end('{}'); }); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const port = (srv.address() as any).port;
      await assert.rejects(term.saveTerminal(org, null, { siteId: site, name: 'T', maxPreauthMinor: 100000, callbackUrl: 'ftp://example.com/x' }), /callbackUrl/);
      const t = await term.saveTerminal(org, null, { siteId: site, chargePointId: cp, name: 'Reader 1', maxPreauthMinor: 200000, callbackUrl: `http://127.0.0.1:${port}/cb`, callbackSecret: 's3cret' }) as any;
      assert.match(t.key, /^trm_/);
      // The charger is not connected: not accepted, to be voided.
      const no = await term.ingest(t.key, { type: 'preauth', reference: 'R-1', amountMinor: 150000, cardBrand: 'VISA', cardLast4: '4242', connectorId: 1 }, 'https://csms.test') as any;
      assert.equal(no.accepted, false);
      assert.equal(no.status, 'void_due');
      assert.equal((await term.ingest(t.key, { type: 'preauth', reference: 'R-1', amountMinor: 150000 }) as any).duplicate, true, 'a repeated reference is the same payment');
      await assert.rejects(term.ingest(t.key, { type: 'preauth', reference: 'R-2', amountMinor: 999999 }), /At most/);
      // A payment whose car charged: as if the charger had started (a guest card, the session).
      const guest = (await one<{ id: string }>(`INSERT INTO token (org_id, kind, uid, valid_to) VALUES ($1, 'guest', $2, now() + interval '10 minutes') RETURNING id`, [org, `TRM-${TAG}`]))!.id;
      const rcpt = `trr_${randomBytes(18).toString('base64url')}`;
      const { createHash } = await import('node:crypto');
      const xid = (await one<{ id: string }>(`INSERT INTO terminal_txn (org_id, terminal_id, reference, connector_uuid, token_id, card_brand, card_last4, preauth_minor, currency, status, receipt_token_hash)
        VALUES ($1,$2,'R-3',$3,$4,'VISA','4242',100000,'IDR','preauth',$5) RETURNING id`, [org, Number(t.id), conn, guest, createHash('sha256').update(rcpt).digest('hex')]))!.id;
      await session(`now() - interval '2 hours'`, 18000, guest, 'rated', 54321);
      answer = 500;
      // One pass: the session is found, it has ended, its charge record decides the capture, the callback is tried.
      const r = await term.settle();
      assert.equal(r.linked, 1);
      assert.ok(r.decided >= 1);
      let x = (await term.txns(org)).find((p) => p.id === String(xid))!;
      assert.equal(x.amountMinor, 54321, 'the session\'s total');
      assert.equal(x.status, 'capture_due', 'the terminal answered 500: still due');
      assert.equal((await one<any>(`SELECT status FROM token WHERE id = $1`, [guest])).status, 'Expired', 'the guest card is retired');
      const cap = hits.find((h) => h.body.reference === 'R-3')!;
      assert.equal(cap.body.action, 'capture');
      assert.match(cap.sig ?? '', /^t=\d+,v1=[0-9a-f]{64}$/, 'signed');
      // The terminal accepts the next try.
      answer = 200;
      await query(`UPDATE terminal_txn SET updated_at = now() - interval '1 hour' WHERE terminal_id = $1`, [Number(t.id)]);
      await term.settle();
      x = (await term.txns(org)).find((p) => p.id === String(xid))!;
      assert.equal(x.status, 'captured');
      // The receipt.
      const rec = await term.receipt(rcpt);
      assert.deepEqual([rec.status, rec.amountMinor, rec.kwh, rec.card], ['paid', 54321, 18, 'VISA ··4242']);
      // A terminal that polls: the void waits for it.
      const k = await term.saveTerminal(org, null, { siteId: site, name: 'Kiosk', maxPreauthMinor: 100000 }) as any;
      const v = await term.ingest(k.key, { type: 'preauth', reference: 'K-1', amountMinor: 50000, ocppIdentity: `P35-${TAG}`, connectorId: 1 }) as any;
      assert.equal(v.accepted, false);
      const polled = await term.ingest(k.key, { type: 'poll' }) as any;
      assert.deepEqual(polled.instructions, [{ reference: 'K-1', action: 'void', amountMinor: 0 }]);
      assert.equal((await term.ingest(k.key, { type: 'voided', reference: 'K-1' }) as any).status, 'voided');
      assert.deepEqual((await term.ingest(k.key, { type: 'poll' }) as any).instructions, []);
      // Settlement: matched, a different amount, an unknown reference.
      const s = await term.reconcile(org, { csv: 'reference,amount,date\nR-3,54321,2026-11-01\nR-1,100,2026-11-01\nZZZ,5,2026-11-01' });
      assert.deepEqual([s.matched, s.mismatch, s.unknown], [1, 1, 1]);
      assert.equal((await term.txns(org)).find((p) => p.id === String(xid))!.settledMinor, 54321);
      await assert.rejects(term.ingest('trm_wrongwrongwrongwrongwrong', { type: 'poll' }), /Unknown key/);
    } finally { srv.close(); }
  });

  test('energy prices: a zone, a day, the site\'s cap now, the savings', async () => {
    const z = await prices.saveZone(org, null, { name: 'Java day-ahead', currency: 'IDR', source: 'manual' }) as any;
    // Today (Jakarta): 24 hours, cheap at night (800), dearer by day (1500), and this hour the dearest (2500).
    const now = new Date();
    const hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
    const startLocal = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(now)}T00:00:00+07:00`);
    const list = Array.from({ length: 24 }, (_, i) => {
      const at = new Date(startLocal.getTime() + i * 3_600_000);
      return { start: at.toISOString(), price: at.getTime() === hour.getTime() ? 2500 : i < 6 || i >= 22 ? 800 : 1500 };
    });
    assert.deepEqual(await prices.importPrices(org, z.id, { prices: list }), { stored: 24, skipped: 0 });
    const day = await prices.day(org, z.id);
    assert.equal(day.periods.length, 24);
    assert.equal(day.max, 2500);
    // The site shifts: this hour is expensive, the grid part falls to 40 %.
    assert.equal(await prices.capNow(site, now), null, 'not shifting yet');
    await prices.siteSettings(org, site, { zoneId: z.id, shift: true, capPct: 40 });
    const c = await prices.capNow(site, now);
    assert.deepEqual(c, { capPct: 40, priceMinor: 2500, expensive: true });
    await prices.siteSettings(org, site, { zoneId: z.id, shift: true, capPct: 40, thresholdMinor: 3000 });
    assert.equal((await prices.capNow(site, now))!.expensive, false, 'below the site\'s threshold');
    // Savings this month: a session in a cheap night hour.
    const nightIso = list[2]!.start;
    await session(`'${nightIso}'::timestamptz`, 10000, null);
    const sv = await prices.savings(org, new Date().toISOString().slice(0, 7));
    const mine = sv.sites.find((s) => s.siteId === site)!;
    assert.ok(mine.pricedKwh >= 10);
    assert.ok((mine.savingsMinor ?? 0) > 0, `charging at night saved something (${mine.savingsMinor})`);
    assert.equal((await prices.zones(org))[0]!.sites, 1);
  });

  test('surveys: asked once after a charge; a detractor\'s comment opens a support case; NPS', async () => {
    const s1 = await session(`now() - interval '3 hours'`, 12000, tok);
    const dc = (await one<{ id: string }>(`INSERT INTO driver_charge (device_id, token_id, app_driver_id, org_id, connector_uuid, mode, session_id) VALUES ($1,$2,$3,$4,$5,'fleet',$6) RETURNING id`, [dev, tok, dr, org, conn, s1]))!.id;
    assert.deepEqual(await surveys.pending(dr, dc), { ask: false }, 'surveys are off');
    await surveys.saveSettings(org, { enabled: true, samplePct: 100, minGapDays: 0 });
    const desk = await import('./support-desk.js');
    await desk.saveSettings(org, { enabled: true }, null);
    const p = await surveys.pending(dr, dc) as any;
    assert.equal(p.ask, true);
    assert.match(p.question, /merekomendasikan/);
    await assert.rejects(surveys.respond(dr, { chargeId: dc, score: 11 }), /0 sampai 10/);
    const r = await surveys.respond(dr, { chargeId: dc, score: 3, tags: ['broken', 'nonsense'], comment: 'Konektor 1 tidak mengunci.' });
    assert.match(r.caseRef ?? '', /^PS-\d+$/);
    await assert.rejects(surveys.respond(dr, { chargeId: dc, score: 9 }), /sudah menilai/);
    assert.deepEqual(await surveys.pending(dr, dc), { ask: false }, 'once per charge');
    const c = await one<any>(`SELECT category, session_id FROM support_case WHERE org_id = $1 ORDER BY id DESC LIMIT 1`, [org]);
    assert.equal(c.category, 'charger_fault');
    assert.equal(c.session_id, s1);
    // A promoter on another charge.
    const s2 = await session(`now() - interval '2 hours'`, 8000, tok);
    const dc2 = (await one<{ id: string }>(`INSERT INTO driver_charge (device_id, token_id, app_driver_id, org_id, connector_uuid, mode, session_id) VALUES ($1,$2,$3,$4,$5,'fleet',$6) RETURNING id`, [dev, tok, dr, org, conn, s2]))!.id;
    await surveys.respond(dr, { chargeId: dc2, score: 10 });
    const o = await surveys.overview(org);
    assert.deepEqual([o.nps, o.responses, o.promoters, o.detractors], [0, 2, 1, 1]);
    assert.equal(o.bySite[0]!.responses, 2);
    assert.deepEqual(o.tags, [{ tag: 'broken', all: 1, detractors: 1 }]);
    const low = await surveys.responses(org, { band: 'detractor' });
    assert.equal(low.length, 1);
    assert.equal(low[0]!.caseRef, r.caseRef);
  });
});
