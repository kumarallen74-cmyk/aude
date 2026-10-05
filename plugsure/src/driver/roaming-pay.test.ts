import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { one, many, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { seal } from '../services/secrets.js';
import { bus } from '../services/events.js';
import { invalidate } from '../integrations/store.js';
import { saveCard } from '../services/payments/cards.js';
import { attemptHold } from '../services/payments/holds.js';
import { tokenHash } from '../ocpi/mapping.js';
import { getPartner, type PartnerRow } from '../ocpi/store.js';
import { authorizeForCpo, receiveCdr, cardUsage, limitProblem, locationCurrency, cdrPlausibilityProblem } from '../ocpi/emsp.js';
import { listRoamingStations, startRoaming, roamingStatus, roamingReceipt, roamingHistory } from './roaming.js';
import { settleRoamingHold, sweepRoamingHolds, validateRoamingSettings, holdAmount, parseRoamingSettings, appTokenUid, HOLD_SETTLE_WITHIN_MS, roamingHoldMinMinor, releaseRoamingHold, roamingOwed } from './roaming-pay.js';
import { payUnpaid, confirmUnpaidPayment, unpaidSessions, unpaidStatus } from './charge.js';
import type { DriverPrincipal } from './identity.js';

/**
 * Roaming for every signed-in app driver (docs/MULTI-COUNTRY-DESIGN.md §D7, WP2) and the
 * eMSP's per-currency checks.
 *
 *  - pure: plausibility caps per currency (IDR 25,000 / MYR 10 / SGD 5 per kWh), unknown currency held;
 *    the currency of a partner location; hold settings validation and defaults.
 *  - database: a retail driver's hold in the partner's currency (IDR, MYR, SGD) placed BEFORE
 *    START_SESSION; the CDR captures exactly its total (≤ hold); above the hold a shortfall;
 *    a CDR in another currency releases the hold (no FX); a refused start releases at once;
 *    the 4-day rule with and without a session total; settlement once only; APP_USER real-time
 *    authorisation only with an open hold; fleet-card spending limits per currency.
 *
 *   DATABASE_URL=postgresql://postgres:…@127.0.0.1:5433/plugsure_audit_fix npx tsx --test src/driver/roaming-pay.test.ts
 */

describe('eMSP: plausibility caps and currencies (pure)', () => {
  const at = new Date('2026-09-01T03:00:00Z');
  const c = (over: Record<string, unknown>) =>
    cdrPlausibilityProblem({ currency: 'IDR', excl: 40_000, incl: 44_400, energyKwh: 10, start: at, end: new Date(at.getTime() + 3600_000), ...over } as any);
  test('per-currency ceilings: IDR 25,000, MYR 10.00, SGD 5.00 per kWh (major units)', () => {
    assert.equal(c({ currency: 'IDR', excl: 240_000, incl: 250_000 }), null);
    assert.match(String(c({ currency: 'IDR', excl: 240_000, incl: 250_001 })), /above 25000 IDR\/kWh/);
    assert.equal(c({ currency: 'MYR', excl: 90, incl: 100 }), null);
    assert.match(String(c({ currency: 'MYR', excl: 95, incl: 100.01 })), /above 10 MYR\/kWh/);
    assert.equal(c({ currency: 'SGD', excl: 45, incl: 50 }), null);
    assert.match(String(c({ currency: 'SGD', excl: 46, incl: 50.5 })), /above 5 SGD\/kWh/);
  });
  test('an unknown currency is held (fail closed), whatever the amount', () => {
    assert.match(String(c({ currency: 'EUR', excl: 1, incl: 1 })), /unsupported currency "EUR"/);
    assert.match(String(c({ currency: 'XXX', excl: 0, incl: 0 })), /unsupported currency/);
  });
  test('the currency of a partner location: its OCPI country (alpha-3), else the party\'s country', () => {
    assert.equal(locationCurrency({ country: 'MYS' }, 'ID'), 'MYR');
    assert.equal(locationCurrency({ country: 'SGP' }, 'MY'), 'SGD');
    assert.equal(locationCurrency({ country: 'IDN' }, null), 'IDR');
    assert.equal(locationCurrency({}, 'MY'), 'MYR');
    assert.equal(locationCurrency({ country: 'NLD' }, 'ID'), null, 'a location in a country we do not support has no currency');
    assert.equal(locationCurrency(null, 'NL'), null);
  });
  test('hold settings: defaults per currency, validated overrides', () => {
    const s = parseRoamingSettings({});
    assert.equal(s.appDrivers, false);
    assert.deepEqual([holdAmount(s, 'IDR'), holdAmount(s, 'MYR'), holdAmount(s, 'SGD')], [300_000, 10_000, 8_000]);
    const v = validateRoamingSettings({ appDrivers: true, holdMinor: { SGD: 12_000 } });
    assert.ok('settings' in v && v.settings.appDrivers && holdAmount(v.settings, 'SGD') === 12_000 && holdAmount(v.settings, 'MYR') === 10_000);
    assert.ok('error' in validateRoamingSettings({ holdMinor: { EUR: 100 } }));
    assert.ok('error' in validateRoamingSettings({ holdMinor: { MYR: 12.5 } }), 'a hold is a whole number of sen');
    assert.ok('error' in validateRoamingSettings({ holdMinor: { IDR: -1 } }));
  });
  test('a hold has a floor per currency: at least Stripe\'s minimum and a configurable floor (review 9)', () => {
    assert.deepEqual([roamingHoldMinMinor('IDR', {}), roamingHoldMinMinor('MYR', {}), roamingHoldMinMinor('SGD', {})], [50_000, 2_000, 1_500]);
    assert.equal(roamingHoldMinMinor('SGD', { ROAMING_HOLD_MIN_SGD: '3000' }), 3_000);
    assert.equal(roamingHoldMinMinor('SGD', { ROAMING_HOLD_MIN_SGD: '10' }), 50, 'never below Stripe\'s minimum charge');
    assert.match(String((validateRoamingSettings({ holdMinor: { SGD: 40 } }) as any).error), /between 1500 and/);
    assert.ok('error' in validateRoamingSettings({ holdMinor: { MYR: 1_999 } }));
    assert.ok('settings' in validateRoamingSettings({ holdMinor: { MYR: 2_000 } }));
  });
  test('the virtual app token uid is stable per (operator, driver) and fits an idTag', () => {
    const a = appTokenUid('org-1', 'drv-1');
    assert.match(a, /^APP[0-9A-F]{17}$/);
    assert.equal(a, appTokenUid('org-1', 'drv-1'));
    assert.notEqual(a, appTokenUid('org-2', 'drv-1'));
  });
});

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[roaming-pay.test] SKIPPING database-backed suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'roaming-pay-test';
const PHONE = '+628990077001';
const party = { country_code: 'ID', party_id: 'RPT', business_name: 'Roaming Pay Test' };
let orgId = '';
let cpo: PartnerRow;
let driverId = '';
let deviceId = '';
const cards: Record<string, string> = {};
const alerts: Array<{ kind: string; targetId?: string }> = [];
bus.on('alert.raised', (e: any) => { alerts.push({ kind: e.kind, targetId: e.targetId }); });

/** The partner CPO: answers commands (START_SESSION ACCEPTED unless told otherwise). */
let commandAnswer = 'ACCEPTED';
const commands: any[] = [];
let mockUrl = '';
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url?.startsWith('/commands/')) { try { commands.push(JSON.parse(body)); } catch { /* ignore */ } }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { result: commandAnswer, timeout: 30 }, status_code: 1000, timestamp: new Date().toISOString() }));
  });
});

async function cleanup(): Promise<void> {
  const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (org) {
    await query(`UPDATE payment_intent SET roaming_charge_id = NULL WHERE org_id = $1`, [org.id]);
    await query(`DELETE FROM driver_roaming_charge WHERE org_id = $1`, [org.id]);
    await query(`DELETE FROM payment_intent WHERE org_id = $1`, [org.id]);
    await query(`DELETE FROM integration_event WHERE org_id = $1 OR integration_id IN (SELECT id FROM integration WHERE org_id = $1)`, [org.id]);
    await query(`DELETE FROM driver_card WHERE integration_id IN (SELECT id FROM integration WHERE org_id = $1)`, [org.id]);
    await query(`DELETE FROM integration WHERE org_id = $1`, [org.id]);
    await query(`DELETE FROM ocpi_message WHERE org_id = $1`, [org.id]);
    await query(`DELETE FROM ocpi_partner WHERE org_id = $1`, [org.id]);
    await query(`DELETE FROM ocpi_party WHERE org_id = $1`, [org.id]);
    await query(`DELETE FROM token WHERE org_id = $1`, [org.id]);
  }
  await query(`DELETE FROM driver_device WHERE app_driver_id IN (SELECT id FROM app_driver WHERE phone = $1)`, [PHONE]);
  await query(`DELETE FROM app_driver WHERE phone = $1`, [PHONE]);
}

const loc = (id: string, country: string, tariff: string) => ({
  id, country_code: 'ID', party_id: 'CPX', name: `Partner ${id}`, address: 'Jl. 1', city: 'X', country, coordinates: { latitude: '1.3', longitude: '103.8' },
  evses: [{ uid: `${id}-E1`, evse_id: `${id}*E1`, status: 'AVAILABLE', connectors: [{ id: '1', standard: 'IEC_62196_T2', power_type: 'AC_3_PHASE', max_electric_power: 22000, tariff_ids: [tariff] }] }],
  last_updated: new Date().toISOString(),
});
const LOCS = [
  { id: 'L-ID', country: 'IDN', tariff: 'T-ID', currency: 'IDR', price: 3500 },
  { id: 'L-MY', country: 'MYS', tariff: 'T-MY', currency: 'MYR', price: 1.2 },
  { id: 'L-SG', country: 'SGP', tariff: 'T-SG', currency: 'SGD', price: 0.65 },
];

const principal = (): DriverPrincipal => ({ deviceId, appDriverId: driverId, fleetTokenId: null, fleet: null, account: { id: driverId, phone: PHONE, name: 'Retail' } });

if (DB_OK) {
  before(async () => {
    await cleanup();
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
    mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
    orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug, roaming_settings) VALUES ('Roaming Pay Test', $1, '{"appDrivers": true, "holdMinor": {"MYR": 5000}}')
       ON CONFLICT (slug) DO UPDATE SET roaming_settings = EXCLUDED.roaming_settings RETURNING id`, [SLUG]))!.id;
    await query(`INSERT INTO ocpi_party (org_id, country_code, party_id, business_name) VALUES ($1,$2,$3,$4)`, [orgId, party.country_code, party.party_id, party.business_name]);
    // One sandbox acquirer account per country, with card holds and saved cards on.
    const integ: Record<string, string> = {};
    for (const cc of ['ID', 'MY', 'SG']) {
      integ[cc] = (await one<{ id: string }>(
        `INSERT INTO integration (org_id, kind, provider, settings, secrets_sealed, webhook_key, country_code) VALUES ($1, 'payments', 'mock', $2, $3, $4, $5) RETURNING id`,
        [orgId, JSON.stringify({ methods: ['CARD', 'QRIS'], cardHolds: true, saveCards: true }), seal('{}'), `rpt${cc}${randomBytes(12).toString('hex')}`, cc === 'ID' ? null : cc]))!.id;
    }
    invalidate();
    driverId = (await one<{ id: string }>(`INSERT INTO app_driver (phone) VALUES ($1) RETURNING id`, [PHONE]))!.id;
    deviceId = (await one<{ id: string }>(`INSERT INTO driver_device (device_hash, app_driver_id) VALUES ($1, $2) RETURNING id`, [randomBytes(16).toString('hex'), driverId]))!.id;
    for (const cc of ['ID', 'MY', 'SG']) {
      cards[cc] = (await saveCard(driverId, { provider: 'mock', integrationId: integ[cc]! }, { token: `mock_tok_${cc}${randomBytes(4).toString('hex')}`, brand: 'VISA', last4: '4242' }))!;
    }
    const tok = `cpx-${Math.random()}`;
    const p = await one<{ id: string }>(
      `INSERT INTO ocpi_partner (org_id, name, kind, state, token_in_hash, token_in, token_out, roles, country_code, party_id, endpoints)
       VALUES ($1,'Partner CPX','cpo','connected',$2,$3,$4,$5,'ID','CPX',$6) RETURNING id`,
      [orgId, tokenHash(tok), seal(tok), seal('out-' + tok), JSON.stringify([{ role: 'CPO', country_code: 'ID', party_id: 'CPX' }]),
        JSON.stringify([{ identifier: 'commands', role: 'RECEIVER', url: `${mockUrl}/commands` }])]);
    cpo = (await getPartner(orgId, p!.id))!;
    for (const l of LOCS) {
      await query(`INSERT INTO ocpi_remote_location (org_id, partner_id, country_code, party_id, location_id, data, last_updated) VALUES ($1,$2,'ID','CPX',$3,$4, now())`,
        [orgId, cpo.id, l.id, JSON.stringify(loc(l.id, l.country, l.tariff))]);
      await query(`INSERT INTO ocpi_remote_tariff (org_id, partner_id, country_code, party_id, tariff_id, data, last_updated) VALUES ($1,$2,'ID','CPX',$3,$4, now())`,
        [orgId, cpo.id, l.tariff, JSON.stringify({ id: l.tariff, currency: l.currency, elements: [{ price_components: [{ type: 'ENERGY', price: l.price, step_size: 1 }] }] })]);
    }
  });
  after(async () => {
    await cleanup();
    invalidate();
    mock.close();
    await pool.end();
  });
}

const start = (locId: string, card = 'MY') => startRoaming(principal(), { partnerId: cpo.id, countryCode: 'ID', partyId: 'CPX', locationId: locId, evseUid: `${locId}-E1` }, 'http://127.0.0.1:1', null, { savedCardId: cards[card] });
const cdr = (id: string, currency: string, incl: number, ref: string | null, over: Record<string, unknown> = {}) => ({
  country_code: 'ID', party_id: 'CPX', id, start_date_time: new Date(Date.now() - 3600_000).toISOString(), end_date_time: new Date().toISOString(),
  cdr_token: { country_code: 'ID', party_id: 'RPT', uid: '', type: 'APP_USER', contract_id: 'x' },
  currency, total_cost: { excl_vat: incl, incl_vat: incl }, total_energy: 10, last_updated: new Date().toISOString(),
  ...(ref ? { authorization_reference: ref } : {}), ...over,
});
const intentOf = async (chargeId: string) => (await one<any>(`SELECT * FROM payment_intent WHERE roaming_charge_id = $1`, [chargeId]))!;
const chargeRow = async (chargeId: string) => (await one<any>(`SELECT * FROM driver_roaming_charge WHERE id = $1`, [chargeId]))!;
/** Let the deferred capture / release run (settleHold defers it with setImmediate). */
const settled = async (intentId: string) => { await new Promise((r) => setTimeout(r, 30)); await attemptHold(intentId); return (await one<any>(`SELECT * FROM payment_intent WHERE id = $1`, [intentId]))!; };

dbDescribe('roaming for app drivers: stations and eligibility', () => {
  test('a signed-in driver sees partner stations in every currency, with the hold for each', async () => {
    const r = await listRoamingStations(principal());
    assert.equal(r.enabled, true);
    const by = Object.fromEntries(r.stations.map((s) => [s.locationId, s]));
    assert.deepEqual([by['L-ID']!.currency, by['L-MY']!.currency, by['L-SG']!.currency], ['IDR', 'MYR', 'SGD']);
    assert.deepEqual([by['L-ID']!.holdMinor, by['L-MY']!.holdMinor, by['L-SG']!.holdMinor], [300_000, 5_000, 8_000], 'IDR/SGD defaults, MYR set by the operator');
    assert.equal(by['L-ID']!.priceFromMinor, 3500, 'an IDR price is the rupiah rate, as before');
    assert.equal(by['L-MY']!.priceFromMajor, 1.2);
    assert.equal(by['L-MY']!.priceFromMinor, 120);
    assert.equal(by['L-SG']!.priceCurrency, 'SGD');
    assert.ok(r.stations.every((s) => s.startable));
  });
  test('a guest (not signed in) is told to sign in', async () => {
    const r = await listRoamingStations({ ...principal(), appDriverId: null, account: null });
    assert.equal(r.enabled, false);
    assert.match(String(r.reason), /Masuk/);
  });
});

dbDescribe('roaming for app drivers: the hold before START_SESSION', () => {
  for (const [locId, cur, holdMinor, totalMajor, capture] of [
    ['L-ID', 'IDR', 300_000, 54_321, 54_321],
    ['L-MY', 'MYR', 5_000, 23.45, 2_345],
    ['L-SG', 'SGD', 8_000, 13.07, 1_307],
  ] as const) {
    test(`${cur}: hold ${holdMinor} authorised, then START_SESSION, then the CDR captures exactly its total`, async () => {
      commands.length = 0;
      const r = await start(locId, cur === 'IDR' ? 'ID' : cur === 'MYR' ? 'MY' : 'SG');
      assert.equal(r.ok, true, r.error);
      const pi = await intentOf(r.chargeId!);
      assert.equal(pi.currency, cur);
      assert.equal(Number(pi.amount_authorised_minor), holdMinor);
      assert.equal(pi.mode, 'preauth');
      assert.equal(pi.hold_state, 'held');
      assert.equal(commands.length, 1, 'START_SESSION sent once the hold is authorised');
      assert.equal(commands[0].authorization_reference, pi.id, 'the authorization_reference is the payment intent');
      assert.equal(commands[0].token.type, 'APP_USER');
      // The CPO checks the token in real time: allowed while the hold is open.
      const a = await authorizeForCpo(cpo, party, commands[0].token.uid, 'APP_USER', { location_id: locId });
      assert.equal(a?.allowed, 'ALLOWED');
      const id = await receiveCdr(cpo, party, cdr(`CDR-${cur}`, cur, totalMajor, pi.id, { cdr_token: { ...commands[0].token } }));
      const after = await settled(pi.id);
      assert.equal(after.hold_state, 'captured');
      assert.equal(Number(after.amount_captured_minor), capture);
      const row = await chargeRow(r.chargeId!);
      assert.equal(row.settle_outcome, 'captured');
      assert.equal(row.remote_cdr_id, id);
      // Once settled, the token is no longer authorised.
      assert.equal((await authorizeForCpo(cpo, party, commands[0].token.uid, 'APP_USER', { location_id: locId }))?.allowed, 'NO_CREDIT');
      // The receipt and history show the amounts in the CDR's currency.
      const rc = await roamingReceipt(principal(), id);
      assert.equal(rc?.currency, cur);
      assert.equal(rc?.totalInclVatMinor, capture);
      assert.equal(rc?.hold?.capturedMinor, capture);
      const h = (await roamingHistory(principal())).find((x: any) => x.cdrId === id);
      assert.equal(h?.totalMinor, capture);
      assert.equal(h?.currency, cur);
    });
  }

  test('settlement happens once: the same CDR settled again changes nothing', async () => {
    const row = await one<{ remote_cdr_id: string; payment_intent_id: string }>(`SELECT remote_cdr_id, payment_intent_id FROM driver_roaming_charge WHERE org_id = $1 AND settle_outcome = 'captured' LIMIT 1`, [orgId]);
    const before = await one<any>(`SELECT amount_captured_minor, hold_state FROM payment_intent WHERE id = $1`, [row!.payment_intent_id]);
    assert.deepEqual(await settleRoamingHold(row!.remote_cdr_id), { outcome: 'already_settled' });
    assert.deepEqual(await one<any>(`SELECT amount_captured_minor, hold_state FROM payment_intent WHERE id = $1`, [row!.payment_intent_id]), before);
  });

  test('a CDR above the hold: the hold is captured in full and the shortfall recorded with an alert', async () => {
    const r = await start('L-MY');
    const pi = await intentOf(r.chargeId!);
    alerts.length = 0;
    await receiveCdr(cpo, party, cdr('CDR-MY-BIG', 'MYR', 61.5, pi.id, { cdr_token: { ...commands.at(-1).token }, total_energy: 30 }));
    const after = await settled(pi.id);
    assert.equal(Number(after.amount_captured_minor), 5_000);
    const row = await chargeRow(r.chargeId!);
    assert.equal(row.settle_outcome, 'shortfall');
    assert.equal(Number(row.shortfall_minor), 1_150);
    assert.ok(alerts.some((a) => a.kind === 'roaming.hold_shortfall'));
    // Review fix 2: the shortfall is owed by the driver — on Home, payable in the app, and no new partner charge until paid.
    const owed = (await unpaidSessions(principal())).find((u) => u.chargeId === r.chargeId);
    assert.deepEqual(owed && { kind: owed.kind, owed: owed.owedMinor, cur: owed.currency }, { kind: 'roaming', owed: 1_150, cur: 'MYR' });
    const blocked = await start('L-MY');
    assert.equal(blocked.ok, false);
    assert.equal((blocked as any).code, 'roaming_unpaid');
    const pay = await payUnpaid(principal(), r.chargeId!, { channel: 'CARD', returnUrl: 'https://csms.example/app/paid.html?for=settle' });
    assert.equal(pay.ok, true, (pay as any).error);
    assert.equal((pay as any).amountMinor, 1_150);
    assert.equal((pay as any).currency, 'MYR');
    assert.equal((await confirmUnpaidPayment(principal(), r.chargeId!)).ok, true);
    assert.deepEqual(await unpaidStatus(principal(), r.chargeId!), { kind: 'roaming', owedMinor: 1_150, paid: true });
    assert.ok((await chargeRow(r.chargeId!)).shortfall_paid_at);
    assert.equal((await roamingOwed(driverId)).length, 0);
    const paidBy = await one<any>(`SELECT mode, state, currency, amount_captured_minor FROM payment_intent WHERE id = $1`, [(await chargeRow(r.chargeId!)).shortfall_settlement_id]);
    assert.deepEqual(paidBy, { mode: 'settlement', state: 'captured', currency: 'MYR', amount_captured_minor: 1_150 });
  });

  test('a CDR in another currency: nothing captured (no FX), the hold released, an alert', async () => {
    const r = await start('L-SG', 'SG');
    const pi = await intentOf(r.chargeId!);
    alerts.length = 0;
    await receiveCdr(cpo, party, cdr('CDR-SG-IN-MYR', 'MYR', 12, pi.id, { cdr_token: { ...commands.at(-1).token } }));
    const after = await settled(pi.id);
    assert.equal(after.hold_state, 'released');
    assert.equal(after.amount_captured_minor, null);
    assert.equal((await chargeRow(r.chargeId!)).settle_outcome, 'currency_mismatch');
    assert.ok(alerts.some((a) => a.kind === 'roaming.currency_mismatch'));
  });

  test('a start the partner refuses releases the hold at once', async () => {
    commandAnswer = 'REJECTED';
    try {
      const r = await start('L-MY');
      assert.equal(r.ok, false);
      const pi = await intentOf(r.chargeId!);
      const after = await settled(pi.id);
      assert.equal(after.hold_state, 'released');
      assert.equal((await chargeRow(r.chargeId!)).settle_outcome, 'not_started');
    } finally { commandAnswer = 'ACCEPTED'; }
  });

  test('a start the charger later reports as failed: the status poll releases the hold', async () => {
    const r = await start('L-MY');
    const row = await chargeRow(r.chargeId!);
    await query(`UPDATE ocpi_command SET result = 'EVSE_OCCUPIED' WHERE id = $1`, [row.start_command_id]);
    const st = await roamingStatus(principal(), r.chargeId!);
    assert.equal(st?.state, 'rejected');
    const after = await settled(row.payment_intent_id);
    assert.equal(after.hold_state, 'released');
  });

  test('the 4-day rule: the partner session\'s last total is captured; with none, released + alert', async () => {
    const withTotal = await start('L-SG', 'SG');
    const without = await start('L-MY');
    const tokenUid = commands.at(-1).token.uid;
    const tokenId = (await one<{ id: string }>(`SELECT id FROM token WHERE org_id = $1 AND uid = $2`, [orgId, tokenUid]))!.id;
    await query(`INSERT INTO ocpi_remote_session (org_id, partner_id, country_code, party_id, session_id, token_id, data, status, kwh, last_updated)
                 VALUES ($1,$2,'ID','CPX','S-4D',$3,$4,'ACTIVE',10, now())`,
      [orgId, cpo.id, tokenId, JSON.stringify({ location_id: 'L-SG', currency: 'SGD', total_cost: { excl_vat: 6.5, incl_vat: 7.09 } })]);
    const later = new Date(Date.now() + HOLD_SETTLE_WITHIN_MS + 60_000);
    alerts.length = 0;
    await sweepRoamingHolds(later);
    const a = await settled((await intentOf(withTotal.chargeId!)).id);
    assert.equal(a.hold_state, 'captured');
    assert.equal(Number(a.amount_captured_minor), 709);
    assert.equal((await chargeRow(withTotal.chargeId!)).settle_outcome, 'captured_session_total');
    const b = await settled((await intentOf(without.chargeId!)).id);
    assert.equal(b.hold_state, 'released');
    assert.equal((await chargeRow(without.chargeId!)).settle_outcome, 'released_no_cdr');
    assert.ok(alerts.some((x) => x.kind === 'roaming.hold_unsettled'));

    // Review fix 2: the partner's CDRs arrive after the sweep. The released one is owed in full (pay in the app);
    // the one captured from the session total (S$7.09) that really cost S$6.00 gets S$1.09 back.
    const tok = { ...commands.at(-1).token };
    const late1 = await receiveCdr(cpo, party, cdr('CDR-LATE-MY', 'MYR', 12.34, (await intentOf(without.chargeId!)).id, { cdr_token: tok }));
    const r1 = await chargeRow(without.chargeId!);
    assert.deepEqual([r1.settle_outcome, Number(r1.shortfall_minor), r1.remote_cdr_id], ['late_cdr', 1_234, late1]);
    assert.ok((await unpaidSessions(principal())).some((u) => u.chargeId === without.chargeId && u.kind === 'roaming' && u.owedMinor === 1_234));
    await receiveCdr(cpo, party, cdr('CDR-LATE-SG', 'SGD', 6, (await intentOf(withTotal.chargeId!)).id, { cdr_token: tok }));
    const r2 = await chargeRow(withTotal.chargeId!);
    assert.deepEqual([r2.settle_outcome, r2.shortfall_minor], ['late_cdr', null]);
    const pi2 = await intentOf(withTotal.chargeId!);
    assert.equal(Number(pi2.refund_due_minor), 109, 'S$7.09 captured, the partner charged S$6.00');
    // A second late copy changes nothing.
    assert.deepEqual(await settleRoamingHold(late1), { outcome: 'already_settled' });
    // Paid, so the next tests may start partner charges again.
    assert.equal((await payUnpaid(principal(), without.chargeId!, { channel: 'CARD', returnUrl: 'https://csms.example/app/paid.html' })).ok, true);
    assert.equal((await confirmUnpaidPayment(principal(), without.chargeId!)).ok, true);
    assert.equal((await roamingOwed(driverId)).length, 0);
  });

  test('a hold guarantees only the partner and location it was opened for (review 9)', async () => {
    const r = await start('L-MY');
    assert.equal(r.ok, true, r.error);
    const uid = commands.at(-1).token.uid;
    assert.equal((await authorizeForCpo(cpo, party, uid, 'APP_USER', { location_id: 'L-MY' }))?.allowed, 'ALLOWED');
    assert.equal((await authorizeForCpo(cpo, party, uid, 'APP_USER', { location_id: 'L-ID' }))?.allowed, 'NO_CREDIT');
    await releaseRoamingHold(r.chargeId!, 'not_started');
    await settled((await intentOf(r.chargeId!)).id);
  });

  test('an APP_USER charge record that matches no hold of ours is held for review with an alert, never dropped (review 2)', async () => {
    alerts.length = 0;
    // Accepted (e.g. it quoted an authorization of ours), but no app-driver charge with a hold is behind it.
    const tokenId = (await one<{ id: string }>(`SELECT id FROM token WHERE org_id = $1 AND uid = $2`, [orgId, commands.at(-1).token.uid]))!.id;
    const id = (await one<{ id: string }>(
      `INSERT INTO ocpi_remote_cdr (org_id, partner_id, country_code, party_id, cdr_id, session_id, token_id, data, currency, total_excl_vat, total_incl_vat, total_energy, start_date_time, end_date_time, status)
       VALUES ($1,$2,'ID','CPX','CDR-STRAY','S-NOT-OURS',$3,'{"id":"CDR-STRAY"}','MYR',9.99,9.99,5, now() - interval '2 hours', now() - interval '1 hour','accepted') RETURNING id`,
      [orgId, cpo.id, tokenId]))!.id;
    assert.deepEqual(await settleRoamingHold(id), { outcome: 'unmatched' });
    const row = await one<any>(`SELECT status, hold_reason FROM ocpi_remote_cdr WHERE id = $1`, [id]);
    assert.equal(row.status, 'held');
    assert.match(row.hold_reason, /no roaming charge with a card hold/);
    assert.ok(alerts.some((a) => a.kind === 'roaming.cdr_unmatched'));
    // Accepted by an operator after review: not parked again.
    await query(`UPDATE ocpi_remote_cdr SET status = 'accepted', reviewed_at = now() WHERE id = $1`, [id]);
    assert.deepEqual(await settleRoamingHold(id), { outcome: 'unmatched_reviewed' });
  });

  test('an APP_USER token without an open hold is refused in real time', async () => {
    const uid = commands.at(-1).token.uid;
    const a = await authorizeForCpo(cpo, party, uid, 'APP_USER', { location_id: 'L-MY' });
    assert.equal(a?.allowed, 'NO_CREDIT');
  });

  test('no acquirer with card holds for a currency: listed, not startable', async () => {
    await query(`UPDATE integration SET settings = settings || '{"cardHolds": false}'::jsonb WHERE org_id = $1 AND country_code = 'SG'`, [orgId]);
    invalidate();
    try {
      const r = await listRoamingStations(principal());
      const sg = r.stations.find((s) => s.locationId === 'L-SG')!;
      assert.equal(sg.startable, false);
      assert.match(String(sg.reason), /metode pembayaran/);
      const s = await start('L-SG', 'SG');
      assert.equal(s.ok, false);
    } finally {
      await query(`UPDATE integration SET settings = settings || '{"cardHolds": true}'::jsonb WHERE org_id = $1 AND country_code = 'SG'`, [orgId]);
      invalidate();
    }
  });
});

dbDescribe('eMSP: spending limits per currency', () => {
  let fleetCard = '';
  before(async () => {
    if (!DB_OK) return;
    fleetCard = (await one<{ id: string }>(
      `INSERT INTO token (org_id, kind, uid, status, roaming_shared, contract_id, spend_limit_minor, spend_limit_currency)
       VALUES ($1, 'rfid', 'RPT-FLEET-1', 'Accepted', true, 'ID-RPT-CFLEET01', 100000, 'IDR') RETURNING id`, [orgId]))!.id;
    await query(
      `INSERT INTO ocpi_remote_cdr (org_id, partner_id, country_code, party_id, cdr_id, token_id, data, currency, total_excl_vat, total_incl_vat, total_energy, start_date_time, end_date_time, status)
       VALUES ($1,$2,'ID','CPX','LIM-MY',$3,'{}','MYR',50,55,10, now() - interval '2 hours', now() - interval '1 hour','accepted'),
              ($1,$2,'ID','CPX','LIM-ID',$3,'{}','IDR',40000,44400,10, now() - interval '2 hours', now() - interval '1 hour','accepted')`,
      [orgId, cpo.id, fleetCard]);
  });
  test('usage is counted per currency, in minor units, never added across currencies', async () => {
    assert.deepEqual(await cardUsage(fleetCard, 'IDR'), { wh: 20_000, minor: 44_400, currency: 'IDR' });
    assert.deepEqual(await cardUsage(fleetCard, 'MYR'), { wh: 20_000, minor: 5_500, currency: 'MYR' });
    assert.equal((await cardUsage(fleetCard, 'SGD')).minor, 0);
  });
  test('a card with a rupiah limit is refused in ringgit (fail closed), allowed in rupiah under its limit', async () => {
    const c = { id: fleetCard, energy_limit_wh: null, spend_limit_minor: 100_000, spend_limit_currency: 'IDR' };
    assert.equal(await limitProblem(c, 'IDR'), null);
    assert.equal(await limitProblem(c, 'MYR'), 'currency');
    assert.equal(await limitProblem(c, null), 'currency', 'unknown currency with a limit: refused');
    assert.equal(await limitProblem({ ...c, spend_limit_minor: 44_400 }, 'IDR'), 'spend');
    assert.equal(await limitProblem({ ...c, spend_limit_minor: null }, 'MYR'), null, 'no spending limit: any currency');
    const myrCard = { ...c, spend_limit_minor: 5_000, spend_limit_currency: 'MYR' };
    assert.equal(await limitProblem(myrCard, 'MYR'), 'spend', 'RM 55 used of RM 50');
  });
  test('the CPO\'s real-time check: NOT_ALLOWED at a Malaysian location, ALLOWED at an Indonesian one', async () => {
    const my = await authorizeForCpo(cpo, party, 'RPT-FLEET-1', 'RFID', { location_id: 'L-MY' });
    assert.equal(my?.allowed, 'NOT_ALLOWED');
    assert.match(String(my?.info?.text), /IDR.*MYR/);
    const id = await authorizeForCpo(cpo, party, 'RPT-FLEET-1', 'RFID', { location_id: 'L-ID' });
    assert.equal(id?.allowed, 'ALLOWED');
  });
});

dbDescribe('roaming for app drivers: ordering of holds and the app token', () => {
  test('one virtual token per operator and driver, shared for roaming, never at our own chargers offline', async () => {
    const t = await many<{ kind: string; offline_allowed: boolean; roaming_shared: boolean; contract_id: string }>(`SELECT kind, offline_allowed, roaming_shared, contract_id FROM token WHERE org_id = $1 AND kind = 'app'`, [orgId]);
    assert.equal(t.length, 1);
    assert.equal(t[0]!.offline_allowed, false);
    assert.equal(t[0]!.roaming_shared, true);
    assert.match(t[0]!.contract_id, /^ID-RPT-C[0-9A-F]{8}$/);
  });
});
