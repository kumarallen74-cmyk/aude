import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { one, many, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { seal } from '../services/secrets.js';
import { invalidate } from '../integrations/store.js';
import * as registry from '../ocpp/registry.js';
import { FakeStripe } from '../../tools/testing/fake-stripe.js';
import { reserve } from './reservations.js';
import { buyPass } from './membership.js';
import type { DriverPrincipal } from './identity.js';

/**
 * Reservation fees and 30-day passes go to the acquirer of their own country (docs/MULTI-COUNTRY-DESIGN.md §D6):
 * a Singapore site's reservation fee to the operator's Stripe Singapore account in S$, a ringgit pass to its Stripe
 * Malaysia account in RM (FPX), a Singapore-dollar pass by PayNow (a QR) — never the Indonesian acquirer, and never
 * another country's account: with no account for the country, the driver is told payments are not available there.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/driver/fees-per-country.test.ts
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[fees-per-country.test] SKIPPING (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'fees-per-country';
const SLUG_MY_ONLY = 'fees-per-country-my';
const SK = 'sk_test_51FeesPerCountry', WH = 'whsec_feesPerCountry';
const ids: Record<string, string> = {};
const IDENT = { sg: `FPC-SG-${randomBytes(3).toString('hex')}`, sg2: `FPC-SG2-${randomBytes(3).toString('hex')}` };
let sg: FakeStripe, my: FakeStripe;
const tokens: number[] = [];

async function cleanup(): Promise<void> {
  const orgs = (await many<{ id: string }>(`SELECT id FROM organisation WHERE slug = ANY($1::text[])`, [[SLUG, SLUG_MY_ONLY]])).map((r) => r.id);
  if (!orgs.length) return;
  await query(`DELETE FROM integration_event WHERE org_id = ANY($1::uuid[]) OR integration_id IN (SELECT id FROM integration WHERE org_id = ANY($1::uuid[]))`, [orgs]);
  await query(`DELETE FROM reservation_checkout WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM subscription_charge WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM subscription WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM subscription_plan WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM payment_intent WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM driver_reservation WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM token WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM connector WHERE evse_uuid IN (SELECT e.id FROM evse e JOIN charge_point cp ON cp.id = e.charge_point_id JOIN site s ON s.id = cp.site_id WHERE s.org_id = ANY($1::uuid[]))`, [orgs]);
  await query(`DELETE FROM evse WHERE charge_point_id IN (SELECT cp.id FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE s.org_id = ANY($1::uuid[]))`, [orgs]);
  await query(`DELETE FROM charge_point WHERE site_id IN (SELECT id FROM site WHERE org_id = ANY($1::uuid[]))`, [orgs]);
  await query(`DELETE FROM site WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM integration WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM driver_device WHERE app_driver_id IN (SELECT id FROM app_driver WHERE phone LIKE '+6590000777%')`);
  await query(`DELETE FROM app_driver WHERE phone LIKE '+6590000777%'`);
}

async function site(org: string, cc: 'SG' | 'MY', ident: string, feeMinor: number): Promise<string> {
  const tz = cc === 'SG' ? 'Asia/Singapore' : 'Asia/Kuala_Lumpur';
  const s = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code, timezone, reservation_fee_minor) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [org, `Fees ${ident}`, cc, tz, feeMinor]))!.id;
  const cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, ocpp_version, status) VALUES ($1, $2, 'ocpp1.6', 'online') RETURNING id`, [s, ident]))!.id;
  const e = await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1, 1, 22000) RETURNING id`, [cp]);
  const conn = (await one<{ id: string }>(
    `INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w, status) VALUES ($1, 1, 'Type2', 'AC', 22000, 'Available') RETURNING id`, [e!.id]))!.id;
  // Online for reserve(): a registered connection whose socket is open (no command is sent before the fee is paid).
  tokens.push(registry.register({ ocppIdentity: ident, chargePointId: cp, version: 'ocpp1.6', rpc: {} as any, ws: { readyState: 1 } as any, connectedAt: new Date() }));
  return conn;
}

const stripeIntegration = (org: string, cc: 'SG' | 'MY', url: string) => one<{ id: string }>(
  `INSERT INTO integration (org_id, kind, provider, settings, secrets_sealed, webhook_key, country_code)
   VALUES ($1, 'payments', 'stripe', $2, $3, $4, $5) RETURNING id`,
  [org, JSON.stringify({ baseUrl: url, publishableKey: 'pk_test_51FeesPerCountry', methods: cc === 'SG' ? ['CARD', 'PAYNOW', 'GRABPAY'] : ['CARD', 'FPX', 'GRABPAY'], cardHolds: true, saveCards: true }),
    seal(JSON.stringify({ secretKey: SK, webhookSecret: WH })), `fpc${cc}${randomBytes(10).toString('hex')}`, cc]);

let driver: DriverPrincipal;
const RET = { returnUrl: 'https://csms.example/app/paid.html?for=reservation' };

if (DB_OK) {
  before(async () => {
    sg = await new FakeStripe({ secretKey: SK, webhookSecret: WH, country: 'SG' }).start();
    my = await new FakeStripe({ secretKey: SK, webhookSecret: WH, country: 'MY' }).start();
    for (const f of [sg, my]) f.behaviour.deliver = false;
    await cleanup();
    ids.org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ('Fees per country', $1) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    ids.orgMy = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ('Fees MY only', $1) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG_MY_ONLY]))!.id;
    ids.intSg = (await stripeIntegration(ids.org, 'SG', sg.url))!.id;
    ids.intMy = (await stripeIntegration(ids.org, 'MY', my.url))!.id;
    // The second operator has a Malaysian account only.
    ids.intMyOnly = (await stripeIntegration(ids.orgMy, 'MY', my.url))!.id;
    ids.connSg = await site(ids.org, 'SG', IDENT.sg, 150);
    ids.connSgNoAccount = await site(ids.orgMy, 'SG', IDENT.sg2, 150);
    const d = (await one<{ id: string }>(`INSERT INTO app_driver (phone) VALUES ('+65900007771') RETURNING id`))!.id;
    const dev = (await one<{ id: string }>(`INSERT INTO driver_device (device_hash, app_driver_id) VALUES ($1, $2) RETURNING id`, [randomBytes(16).toString('hex'), d]))!.id;
    driver = { deviceId: dev, appDriverId: d, fleetTokenId: null, fleet: null, account: { id: d, phone: '+65900007771', name: null } };
    invalidate();
  });
  after(async () => {
    registry.unregister(IDENT.sg); registry.unregister(IDENT.sg2);
    await cleanup();
    await query(`DELETE FROM driver_device WHERE id = $1`, [driver?.deviceId]).catch(() => undefined);
    await sg?.stop(); await my?.stop();
    await pool.end();
  });
}

const lastPost = (f: FakeStripe) => f.requests.filter((r) => r.method === 'POST' && r.path === '/v1/payment_intents').at(-1);

dbDescribe('reservation fees per country', () => {
  test('a Singapore site\'s fee by PayNow: the Singapore Stripe account, in S$, shown as a QR', async () => {
    const before = { sg: sg.requests.length, my: my.requests.length };
    const r = await reserve(driver, ids.connSg!, { ...RET, channel: 'PAYNOW' });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.checkout?.currency, 'SGD');
    assert.equal(r.checkout?.totalMinor, 150);
    assert.equal(r.payment?.action, 'qr');
    assert.equal(r.payment?.channel, 'PAYNOW');
    assert.ok(r.qr?.qrString && r.qr.qrImage.startsWith('data:image/'), 'the PayNow code is rendered like QRIS');
    const req = lastPost(sg)!;
    assert.deepEqual([req.body.amount, req.body.currency], ['150', 'sgd']);
    assert.match(String(req.body.description), /reservation Fees /, 'English description outside Indonesia');
    assert.equal(my.requests.length, before.my, 'the Malaysian account is not asked');
    const pi = await one<any>(`SELECT pi.provider, pi.integration_id, pi.currency, pi.mode FROM reservation_checkout co JOIN payment_intent pi ON pi.id = co.payment_intent_id WHERE co.id = $1`, [r.checkout!.id]);
    assert.deepEqual(pi, { provider: 'stripe', integration_id: ids.intSg, currency: 'SGD', mode: 'reservation' });
    await query(`UPDATE reservation_checkout SET state = 'cancelled' WHERE id = $1`, [r.checkout!.id]);
  });

  test('a card for the fee: Stripe\'s card page, a sale (no hold) in S$', async () => {
    const r = await reserve(driver, ids.connSg!, { ...RET, channel: 'CARD' });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.payment?.action, 'redirect');
    assert.match(String(r.payment?.checkoutUrl), /\/pay\/stripe\/ps_[0-9a-f]{32}\/pi_/);
    const req = lastPost(sg)!;
    assert.deepEqual([req.body.currency, req.body.capture_method], ['sgd', 'automatic']);
    await query(`UPDATE reservation_checkout SET state = 'cancelled' WHERE id = $1`, [r.checkout!.id]);
  });

  test('an operator with no Singapore account: its Malaysian account is never used (development: the sandbox; production: refused)', async () => {
    const n = my.requests.length;
    const r = await reserve(driver, ids.connSgNoAccount!, { ...RET, channel: 'CARD' });
    assert.equal(my.requests.length, n, 'the Malaysian account is not asked');
    // Outside production an organisation without an account for the country gets the multi-currency sandbox
    // (PAYMENT_PROVIDER unset → mock); production refuses it (integrations/store.ts: no dev-only acquirer).
    if (r.ok) {
      const pi = await one<any>(`SELECT pi.provider, pi.integration_id, pi.currency FROM reservation_checkout co JOIN payment_intent pi ON pi.id = co.payment_intent_id WHERE co.id = $1`, [r.checkout!.id]);
      assert.deepEqual(pi, { provider: 'mock', integration_id: null, currency: 'SGD' });
      await query(`UPDATE reservation_checkout SET state = 'cancelled' WHERE id = $1`, [r.checkout!.id]);
    } else {
      assert.equal(r.error, 'Pembayaran belum tersedia di operator ini.');
    }
  });
});

dbDescribe('30-day passes per country', () => {
  test('a ringgit pass by FPX: the Malaysian Stripe account, in RM, on Stripe\'s page (bank list)', async () => {
    const plan = (await one<{ id: string }>(`INSERT INTO subscription_plan (org_id, name, monthly_fee_minor, offered_in_app, active, currency) VALUES ($1, 'Pass MY', 3900, true, true, 'MYR') RETURNING id`, [ids.org]))!.id;
    const n = sg.requests.length;
    const r = await buyPass(driver, plan, { returnUrl: 'https://csms.example/app/paid.html?for=pass', channel: 'FPX' });
    assert.equal(r.ok, true, (r as any).error);
    if (!r.ok) return;
    assert.equal(r.currency, 'MYR');
    assert.equal(r.payment?.method, 'bank');
    assert.match(String(r.payment?.checkoutUrl), /\/pay\/stripe\//);
    const req = lastPost(my)!;
    assert.deepEqual([req.body.amount, req.body.currency, req.body['payment_method_types[0]'] ?? req.body.payment_method_types?.[0]], ['3900', 'myr', 'fpx']);
    assert.equal(sg.requests.length, n, 'the Singapore account is not asked');
    const ch = await one<any>(`SELECT provider, integration_id, currency, via, channel FROM subscription_charge WHERE id = $1`, [r.chargeId]);
    assert.deepEqual(ch, { provider: 'stripe', integration_id: ids.intMy, currency: 'MYR', via: 'bank', channel: 'FPX' });
  });

  test('a Singapore-dollar pass by PayNow: the Singapore account, a QR to scan', async () => {
    const plan = (await one<{ id: string }>(`INSERT INTO subscription_plan (org_id, name, monthly_fee_minor, offered_in_app, active, currency) VALUES ($1, 'Pass SG', 2500, true, true, 'SGD') RETURNING id`, [ids.org]))!.id;
    const r = await buyPass(driver, plan, { returnUrl: 'https://csms.example/app/paid.html?for=pass', channel: 'PAYNOW' });
    assert.equal(r.ok, true, (r as any).error);
    if (!r.ok) return;
    assert.equal(r.currency, 'SGD');
    assert.equal(r.payment?.action, 'qr');
    assert.ok(r.qr?.qrString);
    assert.deepEqual([lastPost(sg)!.body.amount, lastPost(sg)!.body.currency], ['2500', 'sgd']);
    const ch = await one<any>(`SELECT provider, integration_id, currency, via FROM subscription_charge WHERE id = $1`, [r.chargeId]);
    assert.deepEqual(ch, { provider: 'stripe', integration_id: ids.intSg, currency: 'SGD', via: 'qr' });
  });

  test('a method the country does not have is refused before Stripe is asked (PayNow in Malaysia)', async () => {
    const plan = (await one<{ id: string }>(`INSERT INTO subscription_plan (org_id, name, monthly_fee_minor, offered_in_app, active, currency) VALUES ($1, 'Pass MY 2', 3900, true, true, 'MYR') RETURNING id`, [ids.org]))!.id;
    const n = my.requests.length;
    const r = await buyPass(driver, plan, { returnUrl: 'https://csms.example/app/paid.html?for=pass', channel: 'PAYNOW' });
    assert.equal(r.ok, false);
    assert.match(String((r as any).error), /PayNow tidak tersedia di operator ini\./);
    assert.equal(my.requests.length, n);
  });
});
