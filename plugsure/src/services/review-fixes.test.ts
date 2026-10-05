import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import * as store from '../integrations/store.js';
import { draftStatement } from './commission.js';
import { receiptHtml, searchSessions } from './session-query.js';
import { billingZone, billingZoneFor, alertZone, invalidateOrgZones } from './org-timezone.js';

/**
 * v1.7.0 review fixes, database-backed:
 *  1. Stripe test mode: only a platform administrator may allow it; payments through a test-key account are tagged
 *     (payment_intent, CDR) and their receipts are "TEST — not a tax invoice"; commission and revenue leave them out.
 *  3. Months and days in the organisation's zone: a Singapore operator's September starts at 00:00 SGT (16:00 UTC on
 *     31 August), not at 00:00 WIB; Indonesia keeps BILLING_TIMEZONE / ALERT_TIMEZONE.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/review-fixes.test.ts
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[review-fixes.test] SKIPPING database-backed suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

describe('time zone of an organisation\'s months (pure)', () => {
  test('Indonesia and rupiah: the platform zone, as v1.6; a home-country statement: the organisation\'s zone; another country\'s currency: that country\'s zone', () => {
    assert.equal(billingZoneFor('ID', 'Asia/Makassar', 'IDR', 'Asia/Jakarta'), 'Asia/Jakarta', 'Indonesian rupiah statements keep BILLING_TIMEZONE');
    assert.equal(billingZoneFor('ID', 'Asia/Jakarta', null, 'Asia/Jakarta'), 'Asia/Jakarta');
    assert.equal(billingZoneFor('SG', 'Asia/Singapore', 'SGD'), 'Asia/Singapore');
    assert.equal(billingZoneFor('MY', 'Asia/Kuching', 'MYR'), 'Asia/Kuching', 'the organisation\'s own Malaysian zone');
    assert.equal(billingZoneFor('ID', 'Asia/Jakarta', 'SGD'), 'Asia/Singapore', 'an Indonesian operator\'s SGD statement: Singapore time');
    assert.equal(billingZoneFor('SG', 'Asia/Singapore', 'MYR'), 'Asia/Kuala_Lumpur');
  });
});

const SLUG = 'review-fixes-sg';
const ids: Record<string, string> = {};

async function cleanup(): Promise<void> {
  const o = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (!o) return;
  await query(`DELETE FROM cdr WHERE org_id = $1`, [o.id]);
  await query(`UPDATE charging_session SET payment_intent_id = NULL WHERE org_id = $1`, [o.id]);
  await query(`DELETE FROM payment_intent WHERE org_id = $1`, [o.id]);
  await query(`DELETE FROM charging_session WHERE org_id = $1`, [o.id]);
  await query(`DELETE FROM commission_statement WHERE org_id = $1`, [o.id]);
  await query(`DELETE FROM connector WHERE evse_uuid IN (SELECT e.id FROM evse e JOIN charge_point cp ON cp.id = e.charge_point_id JOIN site s ON s.id = cp.site_id WHERE s.org_id = $1)`, [o.id]);
  await query(`DELETE FROM evse WHERE charge_point_id IN (SELECT cp.id FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE s.org_id = $1)`, [o.id]);
  await query(`DELETE FROM charge_point WHERE site_id IN (SELECT id FROM site WHERE org_id = $1)`, [o.id]);
  await query(`DELETE FROM site WHERE org_id = $1`, [o.id]);
  await query(`DELETE FROM integration WHERE org_id = $1`, [o.id]);
}

/** A rated SGD session (S$13.00 incl. 9 % GST), its CDR issued at `issuedAt`, paid through `integrationId` (or the sandbox). */
async function session(issuedAt: string, integrationId: string | null): Promise<string> {
  const s = (await one<{ id: string }>(
    `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, state, started_at, ended_at, energy_wh, currency)
     VALUES ($1,$2,$3,$4,$5,'ended', $6::timestamptz - interval '1 hour', $6, 20000, 'SGD') RETURNING id`,
    [ids.org, ids.site, ids.conn, ids.cp, `rf-${randomUUID()}`, issuedAt]))!.id;
  const pi = (await one<{ id: string }>(
    `INSERT INTO payment_intent (org_id, provider, method, mode, state, amount_authorised_minor, amount_captured_minor, integration_id, channel, currency, session_id)
     VALUES ($1, $2, 'card', 'prepurchase', 'captured', 3000, 3000, $3, 'CARD', 'SGD', $4) RETURNING id`,
    [ids.org, integrationId ? 'stripe' : 'mock', integrationId, s]))!.id;
  await query(`UPDATE charging_session SET payment_intent_id = $2 WHERE id = $1`, [s, pi]);
  await query(
    `INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency, tax_scheme, prices_include_tax)
     VALUES ($1,$2,$3,'[]',1193,0,0,1193,900,107,1300,'{}','SGD','SG_GST',true)`, [s, ids.org, issuedAt]);
  return s;
}

if (DB_OK) {
  before(async () => {
    await cleanup();
    ids.org = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug, home_country_code, timezone) VALUES ('Review SG', $1, 'SG', 'Asia/Singapore')
       ON CONFLICT (slug) DO UPDATE SET home_country_code = 'SG', timezone = 'Asia/Singapore' RETURNING id`, [SLUG]))!.id;
    invalidateOrgZones(ids.org);
    ids.site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code, timezone) VALUES ($1, 'Review SG Hub', 'SG', 'Asia/Singapore') RETURNING id`, [ids.org]))!.id;
    ids.cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, ocpp_version, status, commissioned_at) VALUES ($1, 'REVIEW-SG-1', 'ocpp1.6', 'online', '2026-01-01') RETURNING id`, [ids.site]))!.id;
    const e = await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1, 1, 22000) RETURNING id`, [ids.cp]);
    ids.conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w) VALUES ($1, 1, 'Type2', 'AC', 22000) RETURNING id`, [e!.id]))!.id;
  });
  after(async () => { await cleanup(); store.invalidate(); await pool.end(); });
}

const stripeInput = (over: Record<string, unknown> = {}) => ({
  provider: 'stripe', countryCode: 'SG',
  settings: { publishableKey: 'pk_test_51ReviewFix', methods: ['CARD'], baseUrl: 'http://127.0.0.1:1', ...over },
  secrets: { secretKey: 'sk_test_51ReviewFix', webhookSecret: 'whsec_reviewFix01' },
});

dbDescribe('Stripe test mode (review 1)', () => {
  test('only a platform administrator may allow Stripe test mode', async () => {
    await assert.rejects(() => store.save('payments', ids.org!, { ...stripeInput({ allowTestMode: true }), platformAdmin: false }, null),
      (e: any) => e instanceof store.IntegrationError && e.statusCode === 403 && /platform administrator/.test(e.message));
    const ok = await store.save('payments', ids.org!, { ...stripeInput({ allowTestMode: true }), platformAdmin: true }, null);
    assert.equal(ok?.testMode, true);
    assert.equal(ok?.settings.allowTestMode, true);
    // An operator re-saving it (even unchanged) is refused; unticking it is fine.
    await assert.rejects(() => store.save('payments', ids.org!, { ...stripeInput({ allowTestMode: true }) }, null), (e: any) => e.statusCode === 403);
    const off = await store.save('payments', ids.org!, { ...stripeInput() }, null);
    assert.equal(off?.settings.allowTestMode, false);
    assert.equal(off?.testMode, true, 'test keys are still test mode (allowed outside production)');
    ids.int = off!.id;
  });

  test('payments and CDRs through a test-key account are tagged; receipts are not tax invoices; commission and revenue leave them out', async () => {
    const test1 = await session('2026-09-10T04:00:00Z', ids.int!);
    const live1 = await session('2026-09-11T04:00:00Z', null);
    assert.equal((await one<any>(`SELECT pi.test_mode FROM charging_session cs JOIN payment_intent pi ON pi.id = cs.payment_intent_id WHERE cs.id = $1`, [test1]))!.test_mode, true);
    assert.equal((await one<any>(`SELECT test_mode FROM cdr WHERE session_id = $1`, [test1]))!.test_mode, true);
    assert.equal((await one<any>(`SELECT test_mode FROM cdr WHERE session_id = $1`, [live1]))!.test_mode, false);
    const rt = (await receiptHtml(test1))!;
    assert.match(rt, /TEST — not a tax invoice/);
    assert.doesNotMatch(rt, /Tax Invoice \/ Charging Receipt/);
    assert.match((await receiptHtml(live1))!, /Tax Invoice \/ Charging Receipt/, 'a live GST receipt is still a tax invoice');
    const st = await draftStatement(ids.org!, '2026-09', undefined, 'SGD');
    assert.equal(st.totals.sessions, 1, 'the TEST session earns no commission');
    assert.equal(st.totals.gtvMinor, 1193, 'GTV of the live session only (net of GST)');
    const found = await searchSessions(ids.org!, { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' } as any, null);
    const sgd = found.totals.byCurrency.find((x) => x.currency === 'SGD')!;
    assert.equal(sgd.sessions, 2);
    assert.equal(sgd.revenue_minor, 1300, 'revenue leaves the TEST session out');
    assert.equal(found.rows.find((r: any) => r.id === test1)?.test_mode, true, 'the list marks it TEST');
  });
});

dbDescribe('months in the organisation\'s zone (review 3)', () => {
  test('a Singapore operator\'s September starts at 00:00 SGT, not 00:00 WIB', async () => {
    assert.equal(await billingZone(ids.org!, 'SGD'), 'Asia/Singapore');
    assert.equal(await alertZone(ids.org!), 'Asia/Singapore');
    const before = (await draftStatement(ids.org!, '2026-09', undefined, 'SGD')).totals.sessions;
    // 00:30 SGT on 1 September = 16:30 UTC on 31 August = 23:30 WIB on 31 August.
    await session('2026-08-31T16:30:00Z', null);
    assert.equal((await draftStatement(ids.org!, '2026-09', undefined, 'SGD')).totals.sessions, before + 1, 'in September (SGT)');
    assert.equal((await draftStatement(ids.org!, '2026-08', undefined, 'SGD')).totals.sessions, 0, 'not in August');
    // 23:30 SGT on 30 September = 15:30 UTC: still September in Singapore.
    await session('2026-09-30T15:30:00Z', null);
    assert.equal((await draftStatement(ids.org!, '2026-09', undefined, 'SGD')).totals.sessions, before + 2);
    assert.equal((await draftStatement(ids.org!, '2026-10', undefined, 'SGD')).totals.sessions, 0);
  });

  test('an Indonesian organisation keeps the platform zones (BILLING_TIMEZONE, ALERT_TIMEZONE)', async () => {
    const idOrg = await one<{ id: string }>(`SELECT id FROM organisation WHERE home_country_code = 'ID' LIMIT 1`);
    assert.equal(await billingZone(idOrg!.id, 'IDR'), config.billing.timeZone);
    assert.equal(await alertZone(idOrg!.id), config.alerts.timeZone);
    assert.equal(await billingZone(idOrg!.id, 'SGD'), 'Asia/Singapore');
  });
});
