import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { one, many, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { createTariff, assignTariff, loadTariffForConnector } from './tariff-store.js';
import { handleTransactionEvent, rateAndCreateCdr, sessionIdemKey } from './sessions.js';
import { siteCountryProblem, validateSite } from './sites.js';
import { setParty, getParties, renderLocations, renderTariffs, removeParty } from '../ocpi/store.js';
import { resolveTaxContext } from './tax/index.js';
import type { TransactionEvent } from '../domain/canonical.js';

/**
 * One operator in three countries (database-backed; docs/MULTI-COUNTRY-DESIGN.md §5.5).
 *
 * Sessions go through the real OCPP event path at an Indonesian, a Malaysian and a
 * Singapore site of the same organisation: each is frozen in its site's currency,
 * priced only by tariffs of its country, taxed by its country's engine, and published
 * to roaming partners under its country's party, with its own time zone.
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[multi-country.test] SKIPPING (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'multi-country-test';
const IDENT = { ID: 'MC-TEST-ID-01', MY: 'MC-TEST-MY-01', SG: 'MC-TEST-SG-01' } as const;
type C = keyof typeof IDENT;
let orgId = '';
const site: Record<C, string> = { ID: '', MY: '', SG: '' };
const cp: Record<C, string> = { ID: '', MY: '', SG: '' };
const connector: Record<C, string> = { ID: '', MY: '', SG: '' };
const tariff: Record<C, string> = { ID: '', MY: '', SG: '' };
let txSeq = Date.now() % 1_000_000;

async function cleanup(): Promise<void> {
  const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (!org) return;
  const cs = `SELECT id FROM charging_session WHERE org_id = $1`;
  await query(`DELETE FROM cdr WHERE session_id IN (${cs})`, [org.id]);
  await query(`DELETE FROM meter_value WHERE session_id IN (${cs})`, [org.id]);
  await query(`DELETE FROM charging_session WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM tariff_assignment WHERE tariff_id IN (SELECT id FROM tariff WHERE org_id = $1)`, [org.id]);
  await query(`DELETE FROM tariff_component WHERE tariff_id IN (SELECT id FROM tariff WHERE org_id = $1)`, [org.id]);
  await query(`DELETE FROM tariff WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM token WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM ocpi_object_state WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM ocpi_party WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM org_tax_registration WHERE org_id = $1`, [org.id]);
  for (const id of Object.values(IDENT)) {
    await query(`DELETE FROM connector WHERE evse_uuid IN (SELECT e.id FROM evse e JOIN charge_point cp ON cp.id = e.charge_point_id WHERE cp.ocpp_identity = $1)`, [id]);
    await query(`DELETE FROM evse WHERE charge_point_id IN (SELECT id FROM charge_point WHERE ocpp_identity = $1)`, [id]);
    await query(`DELETE FROM charge_point WHERE ocpp_identity = $1`, [id]);
  }
  await query(`DELETE FROM site_power_budget WHERE site_id IN (SELECT id FROM site WHERE org_id = $1)`, [org.id]);
  await query(`DELETE FROM site WHERE org_id = $1`, [org.id]);
}

const backdate = async (tariffId: string) => {
  await query(`UPDATE tariff SET active_from = now() - interval '2 days' WHERE id = $1`, [tariffId]);
  await query(`UPDATE tariff_assignment SET valid_from = now() - interval '2 days' WHERE tariff_id = $1`, [tariffId]);
};

if (DB_OK) {
  before(async () => {
    await cleanup();
    orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug, pkp) VALUES ('Multi Country Test', $1, true)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    const defs: Record<C, [string, string, number]> = {
      ID: ['Asia/Jakarta', 'Jakarta Hub', 1000], MY: ['Asia/Kuala_Lumpur', 'Kuala Lumpur Hub', 0], SG: ['Asia/Singapore', 'Singapore Hub', 0],
    };
    for (const c of Object.keys(IDENT) as C[]) {
      const [tz, name, pbjt] = defs[c];
      site[c] = (await one<{ id: string }>(
        `INSERT INTO site (org_id, name, address, city, lat, lon, timezone, country_code, local_tax_rate_bps, roaming_publish)
         VALUES ($1,$2,'Jalan 1',$3,$4,$5,$6,$7,$8,true) RETURNING id`,
        [orgId, name, name.split(' ')[0], c === 'ID' ? -6.2 : c === 'MY' ? 3.15 : 1.29, c === 'ID' ? 106.8 : c === 'MY' ? 101.7 : 103.85, tz, c, pbjt]))!.id;
      cp[c] = (await one<{ id: string }>(
        `INSERT INTO charge_point (site_id, ocpp_identity, ocpp_version, status) VALUES ($1,$2,'ocpp1.6','online') RETURNING id`, [site[c], IDENT[c]]))!.id;
      const e = await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1, 1, 22000) RETURNING id`, [cp[c]]);
      connector[c] = (await one<{ id: string }>(
        `INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w, tera_status, tera_cert_status)
         VALUES ($1, 1, 'sType2', 'AC', 22000, 'verified', 'verified') RETURNING id`, [e!.id]))!.id;
    }
    await query(`INSERT INTO token (org_id, kind, uid, status) VALUES ($1, 'rfid', 'MC-CARD', 'Accepted')`, [orgId]);
    // Singapore: GST-registered. Malaysia: not registered for service tax (the default).
    await query(`INSERT INTO org_tax_registration (org_id, country_code, scheme, registration_no, registered, effective_from) VALUES ($1,'SG','SG_GST','201912345M',true,'2024-01-01')`, [orgId]);

    // An organisation-wide rupiah tariff, and a tariff per foreign site.
    const id = await createTariff({ orgId, name: 'MC ID', appliesToMaxPowerW: 22_000, components: [
      { kind: 'energy', rate: 2_400, touBlock: 'ANY' }, { kind: 'session', rate: 5_000, touBlock: 'ANY' }] as any });
    assert.equal(id.ok, true, JSON.stringify(id));
    tariff.ID = id.tariffId!;
    assert.equal((await assignTariff(tariff.ID, 'org', orgId)).ok, true);
    await backdate(tariff.ID);
    const my = await createTariff({ orgId, name: 'MC MY', countryCode: 'MY', appliesToMaxPowerW: 22_000, components: [
      { kind: 'energy', rate: 1.2, touBlock: 'ANY' }, { kind: 'idle', rate: 0.5, touBlock: 'ANY', fromMinutes: 15, toMinutes: 75 }] as any });
    assert.equal(my.ok, true, JSON.stringify(my));
    tariff.MY = my.tariffId!;
    const sg = await createTariff({ orgId, name: 'MC SG', countryCode: 'SG', appliesToMaxPowerW: 22_000, components: [
      { kind: 'energy', rate: 0.65, touBlock: 'ANY' }] as any });
    assert.equal(sg.ok, true, JSON.stringify(sg));
    tariff.SG = sg.tariffId!;
  });
  after(async () => {
    await cleanup();
    await pool.end();
  });
}

const iso = (t: number) => new Date(t).toISOString();
const reg = (wh: number) => [{ measurand: 'Energy.Active.Import.Register', value: wh, unit: 'Wh' }];

/** 20 kWh over an hour, then stopped at once; returns the session id. */
async function charge(c: C, kwh = 20): Promise<string> {
  const t0 = Date.now() - 90 * 60_000;
  const transactionId = String(++txSeq);
  const evse = { chargePointId: cp[c], ocppIdentity: IDENT[c], evseId: 1, connectorId: 1 };
  const idemKey = sessionIdemKey(IDENT[c], 1, 'MC-CARD', 1_000_000, iso(t0));
  const ev = (over: Partial<TransactionEvent>): TransactionEvent =>
    ({ transactionId, evse, idToken: { type: 'ISO14443', idToken: 'MC-CARD' }, idemKey, seqNo: 0, meterValue: [], ...over } as TransactionEvent);
  const s = await handleTransactionEvent(ev({ eventType: 'Started', triggerReason: 'Authorized', timestamp: iso(t0), meterValue: [{ timestamp: iso(t0), sampledValue: reg(1_000_000) }] }), cp[c]);
  assert.ok(s, `session started at ${c}`);
  const end = t0 + 60 * 60_000;
  await handleTransactionEvent(ev({ eventType: 'Ended', triggerReason: 'EVDisconnected', seqNo: 1, timestamp: iso(end), stoppedReason: 'EVDisconnected',
    meterValue: [{ timestamp: iso(end), sampledValue: reg(1_000_000 + kwh * 1000) }] }), cp[c]);
  return s!.id;
}

dbDescribe('one operator, three countries', () => {
  test('tariffs are per country: the organisation-wide rupiah tariff never prices a Malaysian or Singapore site', async () => {
    const at = new Date();
    const idT = await loadTariffForConnector(connector.ID, orgId, at);
    assert.equal(idT.tariff.id, tariff.ID);
    const myT = await loadTariffForConnector(connector.MY, orgId, at);
    assert.equal(myT.fallback, true, 'nothing of Malaysia assigned yet');
    assert.equal(myT.tariff.currency, 'MYR');
    assert.equal(myT.tariff.countryCode, 'MY');
    // A rupiah tariff cannot be assigned to the Malaysian site.
    const wrong = await assignTariff(tariff.ID, 'site', site.MY);
    assert.equal(wrong.ok, false);
    assert.equal(wrong.flags[0]!.code, 'TARIFF_COUNTRY_MISMATCH');
    // Its own country's tariffs can.
    assert.equal((await assignTariff(tariff.MY, 'site', site.MY)).ok, true);
    assert.equal((await assignTariff(tariff.SG, 'site', site.SG)).ok, true);
    assert.equal((await assignTariff(tariff.SG, 'site', site.MY)).flags[0]?.code, 'TARIFF_COUNTRY_MISMATCH');
    await backdate(tariff.MY);
    await backdate(tariff.SG);
    assert.equal((await loadTariffForConnector(connector.MY, orgId, at)).tariff.id, tariff.MY);
  });

  test('each session is frozen in its site\'s currency and taxed by its country', async () => {
    const ids: Record<C, string> = { ID: await charge('ID'), MY: await charge('MY'), SG: await charge('SG') };
    for (const c of Object.keys(ids) as C[]) await rateAndCreateCdr(ids[c]);
    const rows = await many<{ country_code: string; s_cur: string; cdr_cur: string; tax_scheme: string; subtotal_minor: number; tax_minor: number; local_tax_minor: number; total_minor: number; prices_include_tax: boolean; tax_rate_bps: number; tax_detail: any }>(
      `SELECT si.country_code, cs.currency AS s_cur, d.currency AS cdr_cur, d.tax_scheme, d.subtotal_minor, d.tax_minor, d.local_tax_minor, d.total_minor,
              d.prices_include_tax, d.tax_rate_bps, d.tax_detail
         FROM charging_session cs JOIN site si ON si.id = cs.site_id JOIN cdr d ON d.session_id = cs.id
        WHERE cs.id = ANY($1::uuid[]) ORDER BY si.country_code`, [Object.values(ids)]);
    const by = Object.fromEntries(rows.map((r) => [r.country_code, r]));
    // Indonesia: 20 kWh × Rp 2,400 + Rp 5,000 = 53,000; PBJT-TL 10 % on energy; PPN 12 % × DPP 11/12.
    assert.deepEqual(
      [by.ID!.s_cur, by.ID!.cdr_cur, by.ID!.tax_scheme, by.ID!.subtotal_minor, by.ID!.local_tax_minor, by.ID!.tax_minor, by.ID!.total_minor, by.ID!.prices_include_tax],
      ['IDR', 'IDR', 'ID_PPN_PBJT', 53_000, 4_800, 6_358, 64_158, false],
    );
    assert.equal(by.ID!.tax_detail.dppFraction, '11/12');
    // Malaysia: RM 1.20 × 20 kWh = RM 24.00 in sen, no service tax.
    assert.deepEqual([by.MY!.s_cur, by.MY!.cdr_cur, by.MY!.tax_scheme, by.MY!.subtotal_minor, by.MY!.tax_minor, by.MY!.total_minor], ['MYR', 'MYR', 'NONE', 2400, 0, 2400]);
    // Singapore: S$0.65 incl. GST × 20 kWh = S$13.00, of which GST S$1.07.
    assert.deepEqual(
      [by.SG!.s_cur, by.SG!.cdr_cur, by.SG!.tax_scheme, by.SG!.subtotal_minor, by.SG!.tax_minor, by.SG!.total_minor, by.SG!.prices_include_tax, by.SG!.tax_rate_bps],
      ['SGD', 'SGD', 'SG_GST', 1193, 107, 1300, true, 900],
    );
  });

  test('a site\'s country cannot change once it has sessions; MY/SG sites need MULTI_COUNTRY', async () => {
    assert.deepEqual(await siteCountryProblem(orgId, { countryCode: 'ID' }, site.MY), { status: 409, error: 'The site has charging sessions: its country (and currency) can no longer change.' });
    assert.equal(await siteCountryProblem(orgId, { countryCode: 'MY' }, site.MY), null, 'unchanged is fine');
    const before = config.features.multiCountry;
    try {
      (config.features as { multiCountry: boolean }).multiCountry = false;
      assert.equal((await siteCountryProblem(orgId, { countryCode: 'SG' }, null))?.status, 422);
      const input: { countryCode?: string; timezone?: string } = {};
      assert.equal(await siteCountryProblem(orgId, input, null), null);
      assert.deepEqual(input, { countryCode: 'ID', timezone: 'Asia/Jakarta' }, 'a new site defaults to the home country and its zone');
      (config.features as { multiCountry: boolean }).multiCountry = true;
      const sg: { countryCode?: string; timezone?: string } = { countryCode: 'SG' };
      assert.equal(await siteCountryProblem(orgId, sg, null), null);
      assert.equal(sg.timezone, 'Asia/Singapore');
      assert.deepEqual(validateSite({ ...sg, name: 'x' }, true).errors, {});
    } finally {
      (config.features as { multiCountry: boolean }).multiCountry = before;
    }
  });

  test('the tax context comes from the registration in force at the site', async () => {
    assert.equal((await resolveTaxContext({ orgId, country: 'SG', at: new Date() })).scheme, 'SG_GST');
    assert.equal((await resolveTaxContext({ orgId, country: 'MY', at: new Date() })).scheme, 'NONE');
    assert.equal((await resolveTaxContext({ orgId, country: 'SG', at: new Date('2023-06-01T00:00:00Z') })).scheme, 'NONE', 'not yet registered then');
    assert.equal((await resolveTaxContext({ orgId, country: 'SG', at: new Date(), overrides: { exempt: true } })).scheme, 'NONE');
  });

  test('roaming: each site under its country\'s party, with its country and time zone; tariffs in their currency', async () => {
    await setParty(orgId, { country_code: 'ID', party_id: 'MCX', business_name: 'MC Indonesia' });
    await setParty(orgId, { country_code: 'SG', party_id: 'MCX', business_name: 'MC Singapore' }, { home: false });
    const parties = await getParties(orgId);
    assert.deepEqual(parties.map((p) => [p.country_code, p.is_home]), [['ID', true], ['SG', false]]);
    const locs = await renderLocations(orgId, parties, { onlyPublished: false });
    const by = Object.fromEntries(locs.map((l) => [l.location.country, l.location]));
    assert.deepEqual([by.IDN!.country_code, by.IDN!.time_zone], ['ID', 'Asia/Jakarta']);
    // Review fix 9: no MY party — the Malaysian site is NOT published under the Indonesian identity; it is flagged.
    const myLoc = locs.find((l) => l.location.country === 'MYS')!;
    assert.equal(myLoc.published, false);
    assert.match(String(myLoc.problem), /no OCPI party for MY/);
    assert.deepEqual([by.SGP!.country_code, by.SGP!.time_zone], ['SG', 'Asia/Singapore']);
    const ts = await renderTariffs(orgId, parties, [tariff.ID, tariff.MY, tariff.SG]);
    const t = Object.fromEntries(ts.map((x) => [x.tariff.currency, x.tariff]));
    assert.equal(t.IDR!.country_code, 'ID');
    assert.equal((t.IDR!.elements[0]!.price_components[0] as any).vat, 11);
    assert.deepEqual(t.SGD!.elements[0]!.price_components, [{ type: 'ENERGY', price: 0.5963, vat: 9, step_size: 1 }]); // 0.65 / 1.09
    assert.equal(t.SGD!.country_code, 'SG');
    assert.equal(t.MYR, undefined, 'no MY party: the ringgit tariff is not published either');
    await setParty(orgId, { country_code: 'MY', party_id: 'MCX', business_name: 'MC Malaysia' }, { home: false });
    const withMy = Object.fromEntries((await renderTariffs(orgId, await getParties(orgId), [tariff.MY])).map((x) => [x.tariff.currency, x.tariff]));
    assert.deepEqual(withMy.MYR!.elements[0]!.price_components, [{ type: 'ENERGY', price: 1.2, step_size: 1 }], 'no service tax: no vat');
    assert.equal(withMy.MYR!.country_code, 'MY');
    const myNow = (await renderLocations(orgId, await getParties(orgId), { onlyPublished: false })).find((l) => l.location.country === 'MYS')!;
    assert.deepEqual([myNow.location.country_code, myNow.location.time_zone], ['MY', 'Asia/Kuala_Lumpur']);
    await removeParty(orgId, 'MY');
    // The home party moves; the SG party stays.
    await setParty(orgId, { country_code: 'SG', party_id: 'MCX', business_name: 'MC Singapore (home)' });
    assert.deepEqual((await getParties(orgId)).map((p) => [p.country_code, p.is_home, p.business_name]), [['SG', true, 'MC Singapore (home)']]);
  });
});
