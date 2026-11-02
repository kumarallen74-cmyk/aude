import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 38 (v1.50.0), EV dealer partnerships: a dealer and its terms; a sale with a welcome code (shown once, one per
 * VIN); the code redeemed in the app as credit (only by the buyer's number, once, not after it expires or is voided);
 * the month's statement (credit billed to the dealer, its buyers' charging within the commission window, the
 * commission and the net); issuing and settling; the portal link.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/phase38.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const dealers = await import('./dealers.js');
const credit = await import('./driver-credit.js');

const TAG = randomBytes(3).toString('hex');
const rnd = () => String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
let org = '', site = '', cp = '', conn = '', buyer = '', other = '', phone = '', dev = '', tok = '';

describe('Phase 38, pure', () => {
  test('the commission', () => {
    assert.equal(dealers.commissionOf(1_000_000, 250), 25_000);
    assert.equal(dealers.commissionOf(333, 1500), 50);
    assert.equal(dealers.commissionOf(0, 5000), 0);
  });
});

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`P38 ${TAG}`, `p38-${TAG}`]))!.id;
    site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code, timezone) VALUES ($1, $2, 'ID', 'Asia/Jakarta') RETURNING id`, [org, `Site ${TAG}`]))!.id;
    cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, adopted_at, status) VALUES ($1, $2, now(), 'active') RETURNING id`, [site, `P38-${TAG}`]))!.id;
    const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [cp]))!.id;
    conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, max_power_w, status) VALUES ($1, 60000, 'Available') RETURNING id`, [e]))!.id;
    phone = `+62812${rnd()}`;
    buyer = (await one<{ id: string }>(`INSERT INTO app_driver (phone, name) VALUES ($1, 'Sari') RETURNING id`, [phone]))!.id;
    other = (await one<{ id: string }>(`INSERT INTO app_driver (phone, name) VALUES ($1, 'Someone') RETURNING id`, [`+62813${rnd()}`]))!.id;
    dev = (await one<{ id: string }>(`INSERT INTO driver_device (device_hash, app_driver_id) VALUES ($1, $2) RETURNING id`, [`p38-${TAG}`, buyer]))!.id;
    tok = (await one<{ id: string }>(`INSERT INTO token (org_id, kind, uid) VALUES ($1, 'rfid', $2) RETURNING id`, [org, `P38${TAG}`]))!.id;
    await query(`INSERT INTO credit_settings (org_id, enabled, currency) VALUES ($1, true, 'IDR') ON CONFLICT (org_id) DO UPDATE SET enabled = true`, [org]);
  });
}

/** A charge by the buyer in the app, ended at `at`, with its charge record (before tax). */
async function charge(at: string, subtotal: number) {
  const s = await one<{ id: string }>(`INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, token_id, state, started_at, ended_at, energy_wh)
    VALUES ($1,$2,$3,$4,$5,$6,'ended',$7::timestamptz - interval '1 hour',$7,20000) RETURNING id`, [org, site, conn, cp, `p38-${Math.random()}`, tok, at]);
  await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot)
    VALUES ($1,$2,$3,'[]',$4,0,0,$4,1100,$5,$6,'{}')`, [s!.id, org, at, subtotal, Math.round(subtotal * 0.11), subtotal + Math.round(subtotal * 0.11)]);
  await query(`INSERT INTO driver_charge (device_id, app_driver_id, org_id, connector_uuid, token_id, session_id, mode) VALUES ($1,$2,$3,$4,$5,$6,'prepaid')`, [dev, buyer, org, conn, tok, s!.id]);
}

dbDescribe('Phase 38: dealers', () => {
  let dealerId = '', code = '', saleId = '';
  test('a dealer; a sale with a welcome code, shown once, one per VIN', async () => {
    await assert.rejects(dealers.saveDealer(org, null, { name: 'X', commissionBps: 9000 }), /0 to 5000/);
    const d = await dealers.saveDealer(org, null, { name: 'Wuling Denpasar', make: 'Wuling', welcomeMinor: 250_000, funding: 'dealer', commissionBps: 500, commissionMonths: 12 }) as any;
    dealerId = d.id;
    assert.equal(d.currency, 'IDR');
    await assert.rejects(dealers.registerSale(org, dealerId, { buyerName: 'Sari', buyerPhone: '12' }, 'console'), /Not a mobile number/);
    const s = await dealers.registerSale(org, dealerId, { buyerName: 'Sari', buyerPhone: phone.replace('+62', '0'), vehicle: 'Air EV', vin: `LZWADAGA${TAG.toUpperCase().replace(/[IOQ]/g, '1')}123` }, 'console');
    code = s.code; saleId = s.id;
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(s.status, 'pending');
    assert.equal(s.buyerPhone, `…${phone.slice(-4)}`);
    await assert.rejects(dealers.registerSale(org, dealerId, { buyerName: 'Again', vin: s.vin }, 'console'), /already registered/);
    const row = await one<any>(`SELECT code_hash FROM dealer_sale WHERE id = $1`, [saleId]);
    assert.notEqual(row.code_hash, code, 'the code is kept hashed');
  });

  test('redeemed in the app: only by the buyer\'s number, once; credit funded by the dealer', async () => {
    await assert.rejects(credit.redeem(other, code), /hanya untuk nomor HP pembeli/);
    const r = await credit.redeem(buyer, code) as any;
    assert.equal(r.amountMinor, 250_000);
    assert.match(r.dealerSale, /^DS-/);
    assert.equal((await credit.balance(org, buyer, 'IDR')).fundedMinor, 250_000, 'paid for by the dealer');
    await assert.rejects(credit.redeem(buyer, code), /tidak ditemukan atau sudah dipakai/);
    const s = (await dealers.sales(org, { dealerId })).find((x) => x.id === saleId)!;
    assert.equal(s.status, 'redeemed');
    await assert.rejects(dealers.voidSale(org, saleId), /not been redeemed/);
  });

  test('an expired or voided code does not work', async () => {
    const a = await dealers.registerSale(org, dealerId, { buyerName: 'Late' }, 'portal');
    await query(`UPDATE dealer_sale SET code_expires_on = current_date - 1 WHERE id = $1`, [a.id]);
    await assert.rejects(credit.redeem(other, a.code), /kedaluwarsa/);
    const b = await dealers.registerSale(org, dealerId, { buyerName: 'Cancelled' }, 'console');
    await dealers.voidSale(org, b.id);
    await assert.rejects(credit.redeem(other, b.code), /tidak ditemukan/);
  });

  test('the month: credit billed, the buyers\' charging within the window, commission, net; issue and settle', async () => {
    const month = new Date().toISOString().slice(0, 7);
    await query(`UPDATE dealer_sale SET redeemed_at = date_trunc('month', now()) + interval '1 hour' WHERE id = $1`, [saleId]);
    const inMonth = new Date(Date.now() - 60_000).toISOString();
    await charge(inMonth, 400_000);
    await charge(inMonth, 200_000);
    const before = new Date(new Date(`${month}-01T00:00:00Z`).getTime() - 3 * 86_400_000).toISOString();
    await charge(before, 999_000); // before the buyer joined, and last month: not counted
    const p = await dealers.compute(org, dealerId, month);
    assert.equal(p.sales, 2, 'the voided sale is not counted');
    assert.equal(p.redeemed, 1);
    assert.equal(p.billedMinor, 250_000);
    assert.equal(p.revenueMinor, 600_000, 'before tax');
    assert.equal(p.drivers, 1);
    assert.equal(p.kwh, 40);
    assert.equal(p.commissionMinor, 30_000);
    assert.equal(p.netMinor, 220_000, 'the dealer pays');
    const st = await dealers.draft(org, dealerId, month);
    assert.equal(st.status, 'draft');
    await assert.rejects(dealers.act(org, st.id, { action: 'issue' }), /once it is over/);
    await query(`UPDATE dealer_statement SET month = to_char(now() - interval '1 month', 'YYYY-MM') WHERE id = $1`, [st.id]);
    const iss = await dealers.act(org, st.id, { action: 'issue' });
    assert.equal(iss.status, 'issued');
    await assert.rejects(dealers.act(org, st.id, { action: 'settle' }), /reference/);
    const set = await dealers.act(org, st.id, { action: 'settle', reference: 'TRF-0091' });
    assert.equal(set.status, 'settled');
    const x = await dealers.statementXlsx(org, st.id);
    assert.ok(x.data.length > 1000);
  });

  test('the portal link: the dealer registers a sale and sees its month', async () => {
    const r = await dealers.saveDealer(org, dealerId, { rotatePortal: true }) as any;
    assert.match(r.token, /^dlr_/);
    await assert.rejects(dealers.portal('dlr_nope'), /not valid/);
    const s = await dealers.portalSale(r.token, { buyerName: 'Walk-in' });
    assert.ok(s.code);
    const p = await dealers.portal(r.token);
    assert.equal(p.dealer, 'Wuling Denpasar');
    assert.equal(p.exponent, 0);
    assert.ok(p.sales.some((x: any) => x.id === s.id && x.createdVia === 'portal'));
    assert.ok(p.statements.length >= 1, 'issued and settled statements are shown');
    await dealers.saveDealer(org, dealerId, { archive: true });
    await assert.rejects(dealers.portal(r.token), /not valid/);
  });
});
