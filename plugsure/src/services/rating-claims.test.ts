import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { one, many, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { rateAndCreateCdr } from './sessions.js';
import { balanceOf } from './loyalty.js';
import { benefitsFor } from './benefits.js';

/**
 * Loyalty points and limited promotions are claimed once, under a lock, with
 * the CDR (database-backed).
 *
 *  - two sessions of one driver rated together used to spend the same points
 *    (the second spend failed and was only logged; its CDR kept the discount);
 *  - a pre-purchase rated with points lowered the invoice below what was paid,
 *    and the difference went out as a cash refund;
 *  - max_redemptions, max_per_customer and budget_minor were checked when pricing
 *    and recorded afterwards, so concurrent sessions went past them;
 *  - a device-only guest was a "new driver", and a new per-customer allowance,
 *    on every fresh install.
 *
 * Runs only against the disposable test database:
 *   DATABASE_URL=postgresql://postgres:…@127.0.0.1:5433/plugsure_audit_fix npm test
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[rating-claims.test] SKIPPING database-backed suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'rating-claims-test';
const IDENT = 'RATECLAIM-TEST-01';
const PHONE = '+62800000045';
let orgId = '';
let siteId = '';
let cpId = '';
let connUuid = '';
let driverId = '';
const card: Record<string, string> = {};

async function cleanup(): Promise<void> {
  const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (org) {
    const cs = `SELECT id FROM charging_session WHERE org_id = $1`;
    await query(`DELETE FROM loyalty_entry WHERE org_id = $1`, [org.id]);
    await query(`DELETE FROM loyalty_member WHERE org_id = $1`, [org.id]);
    await query(`DELETE FROM loyalty_program WHERE org_id = $1`, [org.id]);
    await query(`DELETE FROM promotion_redemption WHERE org_id = $1`, [org.id]);
    await query(`DELETE FROM promotion WHERE org_id = $1`, [org.id]);
    await query(`DELETE FROM driver_charge WHERE org_id = $1`, [org.id]);
    await query(`UPDATE payment_intent SET session_id = NULL WHERE org_id = $1`, [org.id]);
    await query(`DELETE FROM cdr WHERE session_id IN (${cs})`, [org.id]);
    await query(`DELETE FROM meter_value WHERE session_id IN (${cs})`, [org.id]);
    await query(`DELETE FROM charging_session WHERE org_id = $1`, [org.id]);
    await query(`DELETE FROM payment_intent WHERE org_id = $1`, [org.id]);
    await query(`DELETE FROM token WHERE org_id = $1`, [org.id]);
    await query(`DELETE FROM connector WHERE evse_uuid IN (SELECT e.id FROM evse e JOIN charge_point cp ON cp.id = e.charge_point_id WHERE cp.ocpp_identity = $1)`, [IDENT]);
    await query(`DELETE FROM evse WHERE charge_point_id IN (SELECT id FROM charge_point WHERE ocpp_identity = $1)`, [IDENT]);
    await query(`DELETE FROM charge_point WHERE ocpp_identity = $1`, [IDENT]);
    await query(`DELETE FROM site WHERE org_id = $1`, [org.id]);
  }
  await query(`DELETE FROM driver_device WHERE app_driver_id IN (SELECT id FROM app_driver WHERE phone = $1)`, [PHONE]);
  await query(`DELETE FROM app_driver WHERE phone = $1`, [PHONE]);
}

if (DB_OK) {
  before(async () => {
    await cleanup();
    orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug) VALUES ('Rating Claims Test', $1)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    siteId = (await one<{ id: string }>(
      `INSERT INTO site (org_id, name, local_tax_rate_bps) VALUES ($1, 'Rating Claims Hub', 1000) RETURNING id`, [orgId]))!.id;
    cpId = (await one<{ id: string }>(
      `INSERT INTO charge_point (site_id, ocpp_identity, ocpp_version, status) VALUES ($1, $2, 'ocpp1.6', 'online') RETURNING id`, [siteId, IDENT]))!.id;
    const e = await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1, 1, 22000) RETURNING id`, [cpId]);
    connUuid = (await one<{ id: string }>(
      `INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w, tera_status, tera_cert_status)
       VALUES ($1, 1, 'Type2', 'AC', 22000, 'verified', 'verified') RETURNING id`, [e!.id]))!.id;
    for (const uid of ['RC-DRIVER', 'RC-B', 'RC-C']) {
      card[uid] = (await one<{ id: string }>(`INSERT INTO token (org_id, kind, uid, status) VALUES ($1, 'rfid', $2, 'Accepted') RETURNING id`, [orgId, uid]))!.id;
    }
    driverId = (await one<{ id: string }>(`INSERT INTO app_driver (phone, name) VALUES ($1, 'Rating Claims') RETURNING id`, [PHONE]))!.id;
    // The driver's card was started from the app (whoForSession finds the account through this).
    const device = (await one<{ id: string }>(
      `INSERT INTO driver_device (device_hash, app_driver_id) VALUES ($1, $2) RETURNING id`, [`rating-claims-${randomUUID()}`, driverId]))!.id;
    await query(
      `INSERT INTO driver_charge (device_id, app_driver_id, org_id, connector_uuid, token_id, mode, created_at)
       VALUES ($1, $2, $3, $4, $5, 'postpaid', now() - interval '90 minutes')`,
      [device, driverId, orgId, connUuid, card['RC-DRIVER']]);
    await query(
      `INSERT INTO loyalty_program (org_id, enabled, earn_per_1000_minor, point_value_minor, max_redeem_bps, expiry_months)
       VALUES ($1, true, 0, 10, 5000, 12)`, [orgId]);
    await query(`INSERT INTO loyalty_member (org_id, app_driver_id, auto_redeem) VALUES ($1, $2, true)`, [orgId, driverId]);
  });
  after(async () => {
    await cleanup();
    await pool.end();
  });
}

/** An ended 20 kWh session, ready to rate. */
async function endedSession(tokenUid: string, paymentIntentId: string | null = null): Promise<string> {
  return (await one<{ id: string }>(
    `INSERT INTO charging_session
        (org_id, site_id, connector_uuid, charge_point_id, idem_key, ocpp_transaction_id, token_id, state,
         started_at, ended_at, meter_start_wh, meter_stop_wh, energy_wh, duration_s, idle_minutes, payment_mode, payment_intent_id,
         prepaid_amount_minor, prepaid_energy_wh)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'ended', now() - interval '60 minutes', now() - interval '20 minutes', 0, 20000, 20000, 2400, 0,
             $8, $9, $10, $11)
     RETURNING id`,
    [orgId, siteId, connUuid, cpId, randomUUID(), String(Math.floor(Math.random() * 1e9)), card[tokenUid],
     paymentIntentId ? 'prepurchase' : 'postpaid', paymentIntentId, paymentIntentId ? 100_000 : null, paymentIntentId ? 30_000 : null],
  ))!.id;
}

async function givePoints(n: number) {
  await query(
    `INSERT INTO loyalty_entry (org_id, app_driver_id, kind, points, remaining, note, expires_at)
     VALUES ($1, $2, 'adjust', $3, $3, 'test', now() + interval '1 year')`, [orgId, driverId, n]);
}

const discountOf = async (sessionId: string, source: string) => {
  const c = await one<{ lines: any[] }>(`SELECT lines FROM cdr WHERE session_id = $1`, [sessionId]);
  assert.ok(c, `session ${sessionId} has a CDR`);
  return c.lines.filter((l) => l.adjustment?.source === source).reduce((a, l) => a - Number(l.amountMinor), 0);
};

async function promotion(over: Record<string, unknown>): Promise<string> {
  const cols = { name: `Promo ${randomUUID().slice(0, 8)}`, kind: 'amount_off', value: 5000, audience: 'everyone', starts_at: new Date(Date.now() - 86_400_000), ...over };
  const keys = Object.keys(cols);
  return (await one<{ id: string }>(
    `INSERT INTO promotion (org_id, ${keys.join(', ')}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
    [orgId, ...Object.values(cols)]))!.id;
}
const redemptions = async (promotionId: string) =>
  many<any>(`SELECT * FROM promotion_redemption WHERE promotion_id = $1`, [promotionId]);

dbDescribe('loyalty points are spent once, with the CDR', () => {
  test('two sessions of one driver rated together cannot both spend the same points', async () => {
    await givePoints(1_000); // Rp 10,000; each 20 kWh session could take more than that
    const a = await endedSession('RC-DRIVER');
    const b = await endedSession('RC-DRIVER');
    const [ca, cb] = await Promise.all([rateAndCreateCdr(a), rateAndCreateCdr(b)]);
    assert.ok(ca && cb, 'both sessions are billed');

    const da = await discountOf(a, 'loyalty');
    const db = await discountOf(b, 'loyalty');
    assert.equal(da + db, 10_000, `the points paid Rp 10,000 in all, not twice (got ${da} + ${db})`);
    assert.ok(da === 0 || db === 0, 'the second session was re-priced without the spent points');
    const redeemed = await one<{ p: number; v: number }>(
      `SELECT COALESCE(-sum(points), 0)::int AS p, COALESCE(-sum(value_minor), 0)::int AS v FROM loyalty_entry WHERE org_id = $1 AND kind = 'redeem'`, [orgId]);
    assert.equal(redeemed!.p, 1_000);
    assert.equal(redeemed!.v, da + db, 'every rupiah of discount on a CDR is a redemption in the ledger');
    assert.equal(await balanceOf(orgId, driverId), 0);
  });

  test('a pre-purchase is never discounted with points (no points-to-cash refund)', async () => {
    await givePoints(1_000);
    const pi = (await one<{ id: string }>(
      `INSERT INTO payment_intent (org_id, provider, method, mode, state, amount_authorised_minor, amount_captured_minor, allowance_wh,
                                   connector_uuid, claim_id_tag, claim_token_minted, captured_at)
       VALUES ($1, 'test', 'qris', 'prepurchase', 'captured', 100000, 100000, 30000, $2, 'RC-DRIVER', false, now()) RETURNING id`,
      [orgId, connUuid]))!.id;
    const s = await endedSession('RC-DRIVER', pi);
    await query(`UPDATE payment_intent SET session_id = $2 WHERE id = $1`, [pi, s]);
    assert.ok(await rateAndCreateCdr(s));
    assert.equal(await discountOf(s, 'loyalty'), 0);
    assert.equal(await balanceOf(orgId, driverId), 1_000, 'the points are still the driver\'s');
    const cdr = await one<{ total_minor: number }>(`SELECT total_minor FROM cdr WHERE session_id = $1`, [s]);
    const settled = await one<{ settlement_delta_minor: number }>(`SELECT settlement_delta_minor FROM payment_intent WHERE id = $1`, [pi]);
    assert.equal(settled!.settlement_delta_minor, Number(cdr!.total_minor) - 100_000, 'only the unused energy is owed back');
    // Spend them, so they do not leak into the promotion tests.
    await query(`UPDATE loyalty_entry SET remaining = 0 WHERE org_id = $1`, [orgId]);
  });
});

dbDescribe('promotion limits hold under concurrent rating', () => {
  // One live promotion per test, whatever an earlier (failed) test left behind.
  beforeEach(() => query(`UPDATE promotion SET active = false WHERE org_id = $1`, [orgId]));

  test('max_redemptions 1: two sessions rated together, one gets it', async () => {
    const p = await promotion({ max_redemptions: 1 });
    const a = await endedSession('RC-B');
    const b = await endedSession('RC-C');
    await Promise.all([rateAndCreateCdr(a), rateAndCreateCdr(b)]);
    assert.equal((await redemptions(p)).length, 1);
    assert.equal((await discountOf(a, 'promotion')) + (await discountOf(b, 'promotion')), 5_000);
    await query(`UPDATE promotion SET active = false WHERE id = $1`, [p]);
  });

  test('max_per_customer 1: one card, two sessions rated together, one gets it', async () => {
    const p = await promotion({ max_per_customer: 1 });
    const a = await endedSession('RC-B');
    const b = await endedSession('RC-B');
    await Promise.all([rateAndCreateCdr(a), rateAndCreateCdr(b)]);
    assert.equal((await redemptions(p)).length, 1);
    assert.equal((await discountOf(a, 'promotion')) + (await discountOf(b, 'promotion')), 5_000);
    await query(`UPDATE promotion SET active = false WHERE id = $1`, [p]);
  });

  test('budget_minor: never paid out beyond it', async () => {
    const p = await promotion({ budget_minor: 7_000 });
    const a = await endedSession('RC-B');
    const b = await endedSession('RC-C');
    await Promise.all([rateAndCreateCdr(a), rateAndCreateCdr(b)]);
    const r = await redemptions(p);
    assert.equal(r.length, 1);
    assert.ok(r.reduce((x, y) => x + Number(y.discount_minor), 0) <= 7_000);
    await query(`UPDATE promotion SET active = false WHERE id = $1`, [p]);
  });
});

dbDescribe('a device-only guest is not a customer that limits can count', () => {
  test('new-driver and per-customer promotions need an account or a card', async () => {
    const fresh = await promotion({ audience: 'new_drivers', name: 'RC new drivers' });
    const once = await promotion({ max_per_customer: 1, name: 'RC once each' });
    const open = await promotion({ name: 'RC open' });
    const where = { siteId, currentType: 'AC' };
    const ids = (b: Awaited<ReturnType<typeof benefitsFor>>) => new Set(b.promotions.map((p) => p.id));

    const guest = ids(await benefitsFor(orgId, { deviceId: randomUUID() }, where, new Date(), 'Asia/Jakarta'));
    assert.ok(!guest.has(fresh), 'a fresh install is not a new driver');
    assert.ok(!guest.has(once), 'a fresh install is not a fresh per-customer allowance');
    assert.ok(guest.has(open), 'open promotions still apply to guests');

    const account = ids(await benefitsFor(orgId, { appDriverId: driverId, deviceId: randomUUID() }, where, new Date(), 'Asia/Jakarta'));
    assert.ok(account.has(fresh) && account.has(once) && account.has(open), 'an account with no billed history qualifies');
    await query(`UPDATE promotion SET active = false WHERE id = ANY($1::uuid[])`, [[fresh, once, open]]);
  });
});
