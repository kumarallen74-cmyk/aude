import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { config } from '../config.js';
import { one, many, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { seal } from './secrets.js';
import { tokenHash } from '../ocpi/mapping.js';
import { computeFleetStatement, extractInclusiveTax, type FleetSession, type FleetRoaming } from './fleet-calc.js';
import { periodOverview, statementFor, issueInvoice, efakturExport, saveSettings, invoiceHtml, invoiceCsv, docTax, FleetBillingError } from './fleet-billing.js';
import { invoicePdf } from './fleet-pdf.js';
import { issueCreditNote, getCreditNote, computeCredit } from './fleet-credit.js';
import * as commission from './commission.js';
import { receiptHtml } from './session-query.js';
import { feeTaxerFor } from './benefits.js';
import { pkpFeeTax } from './tax/id.js';
import { connectorDetail as connectorDetailOrOther } from '../driver/stations.js';

/** The connector as a driver of its own operator sees it (never another operator's). */
async function connectorDetail(id: string) {
  const d = await connectorDetailOrOther(id);
  return d === 'other_operator' ? null : d;
}
import { membershipOverview } from '../driver/membership.js';

/**
 * Fleet invoices per currency (docs/MULTI-COUNTRY-DESIGN.md §WP2): one invoice per account,
 * month AND currency — amounts of different currencies are never added; a partner's charge
 * record in ringgit goes on the ringgit invoice instead of being dropped; Singapore GST is
 * computed on each line's sum; e-Faktur carries only rupiah invoices; documents name the
 * currency and the country's tax.
 *
 *   DATABASE_URL=postgresql://postgres:…@127.0.0.1:5433/plugsure_audit_fix npx tsx --test src/services/fleet-currency.test.ts
 */

/** The text of every page of a PDF from this writer (inflated streams, literal strings). */
function pdfText(buf: Buffer): string {
  const s = buf.toString('latin1');
  const out: string[] = [];
  const re = /<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const page = inflateSync(buf.subarray(start, start + Number(m[1]))).toString('latin1');
    for (const t of page.matchAll(/\(((?:[^()\\]|\\.)*)\) Tj/g)) out.push(t[1]!.replace(/\\([0-7]{3}|.)/g, (_x, e: string) => (e.length === 3 ? String.fromCharCode(parseInt(e, 8)) : e)));
  }
  return out.join('\n');
}

const TAX = { ppnRateBps: 1200, dppNum: 11, dppDen: 12 };
const sess = (over: Partial<FleetSession>): FleetSession => ({
  id: 's', startedAt: '2026-09-10T01:00:00Z', endedAt: '2026-09-10T02:00:00Z', siteId: 'site', siteName: 'Site', ocppIdentity: 'CP', cardUid: 'C1',
  holder: null, energyWh: 10_000, subtotalMinor: 0, localTaxMinor: 0, taxBaseMinor: 0, ppnRateBps: 0, taxMinor: 0, totalMinor: 0, ...over,
});
const roam = (over: Partial<FleetRoaming>): FleetRoaming => ({
  id: 'r', operator: 'P', location: null, cardUid: 'C1', startedAt: '2026-09-11T01:00:00Z', endedAt: '2026-09-11T02:00:00Z',
  energyKwh: 10, exclVat: 0, inclVat: null, currency: 'IDR', ...over,
});

describe('fleet statement per currency (pure)', () => {
  test('a ringgit statement takes ringgit partner records in sen and leaves the rupiah ones to the rupiah statement', () => {
    const c = computeFleetStatement(
      [sess({ subtotalMinor: 2400, totalMinor: 2400 })],
      [roam({ id: 'a', currency: 'MYR', exclVat: 12.5, inclVat: 13.25 }), roam({ id: 'b', currency: 'IDR', exclVat: 30_000, inclVat: 33_300 })],
      { includeRoaming: true, cfg: TAX, currency: 'MYR', invoiceTax: () => ({ taxBaseMinor: 0, taxMinor: 0 }) },
    );
    assert.equal(c.currency, 'MYR');
    assert.deepEqual(c.roaming.map((x) => [x.id, x.amountMinor]), [['a', 1325]]);
    assert.equal(c.totals.totalMinor, 2400 + 1325);
    assert.match(c.warnings.join(' '), /not on this MYR statement/);
  });
  test('Singapore GST extracted from the receipts\' gross: 3 × S$13.00 incl. GST is S$39.00, never a cent more (review 8)', () => {
    const one = { subtotalMinor: 1193, taxBaseMinor: 1193, ppnRateBps: 900, taxMinor: 107, totalMinor: 1300 };
    const c = computeFleetStatement([sess({ id: 'a', ...one }), sess({ id: 'b', ...one }), sess({ id: 'c', ...one })], [],
      { includeRoaming: true, cfg: TAX, currency: 'SGD', invoiceTax: extractInclusiveTax(900) });
    assert.equal(c.sites[0]!.taxMinor, 322); // round(3900 × 9 / 109) = round(322.02)
    assert.equal(c.sites[0]!.taxableMinor, 3578);
    assert.equal(c.sites[0]!.subtotalMinor + c.sites[0]!.taxMinor, 3900);
    assert.equal(c.totals.ownTotalMinor, 3900);
    assert.equal(c.totals.receiptsTotalMinor, 3900);
    assert.equal(c.totals.roundingMinor, 0);
  });
  test('a sweep of inclusive SG receipts: the invoice never exceeds their sum; untaxed sessions pass through', () => {
    for (let n = 1; n <= 40; n++) {
      const ss = Array.from({ length: n }, (_, i) => { const gross = 100 + ((i * 37) % 1900); const tax = Math.round((gross * 900) / 10_900);
        return sess({ id: `s${i}`, subtotalMinor: gross - tax, taxBaseMinor: gross - tax, ppnRateBps: 900, taxMinor: tax, totalMinor: gross }); });
      ss.push(sess({ id: 'free', subtotalMinor: 555, totalMinor: 555 }));
      const c = computeFleetStatement(ss, [], { includeRoaming: true, cfg: TAX, currency: 'SGD', invoiceTax: extractInclusiveTax(900) });
      assert.equal(c.totals.ownTotalMinor, c.totals.receiptsTotalMinor, `n=${n}`);
      assert.equal(c.totals.subtotalMinor + c.totals.taxMinor, c.totals.receiptsTotalMinor);
    }
  });
  test('a rupiah statement is exactly as before (PPN on DPP 11/12; foreign records left off)', () => {
    const t = { subtotalMinor: 100_000, localTaxMinor: 10_000, taxBaseMinor: 100_833, ppnRateBps: 1200, taxMinor: 12_100, totalMinor: 122_100 };
    const c = computeFleetStatement([sess(t)], [roam({ currency: 'SGD', exclVat: 10, inclVat: 10.9 })], { includeRoaming: true, cfg: TAX });
    assert.equal(c.currency, 'IDR');
    assert.equal(c.sites[0]!.taxBaseMinor, 100_833);
    assert.equal(c.sites[0]!.taxMinor, 12_100);
    assert.equal(c.roaming.length, 0);
  });
  test('documents: IDR labels as v1.6; SGD with GST; MYR unregistered says no service tax', () => {
    assert.equal(docTax({ currency: 'IDR', seller: { pkp: true } }).m(12_345), 'Rp 12.345');
    const sg = docTax({ currency: 'SGD', taxScheme: 'SG_GST', taxRateBps: 900 });
    assert.equal(sg.m(1300), 'S$ 13.00');
    assert.equal(sg.tax, 'GST 9%');
    const my = docTax({ currency: 'MYR', taxScheme: 'NONE', taxRateBps: 0 });
    assert.equal(my.m(123456), 'RM 1,234.56');
    assert.equal(my.registered, false);
    assert.match(my.noTaxNote, /No service tax/);
  });
  test('a credit note on a GST invoice splits GST on the whole price (no DPP fraction)', () => {
    const c = computeCredit({ totalMinor: 3901, taxBaseMinor: 3579, taxMinor: 322 }, true, { lines: [{ description: 'goodwill', amountMinor: 1090, taxed: true }] },
      { ppnRateBps: 900, dppNum: 1, dppDen: 1 }, 'X', 'SGD');
    assert.deepEqual([c.totalMinor, c.taxBaseMinor, c.taxMinor], [1090, 1000, 90]);
    assert.throws(() => computeCredit({ totalMinor: 500, taxBaseMinor: 0, taxMinor: 0 }, false, { lines: [{ description: 'too much', amountMinor: 600, taxed: false }] },
      { ppnRateBps: 0, dppNum: 1, dppDen: 1 }, 'X', 'MYR'), /At most RM 5\.00/);
  });
});

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[fleet-currency.test] SKIPPING database-backed suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'fleet-currency-test';
const PERIOD = '2026-08';
let orgId = '';
let accountId = '';
let cardId = '';
const sites: Record<string, { site: string; cp: string; conn: string }> = {};

async function cleanup(): Promise<void> {
  const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (!org) return;
  const cs = `SELECT id FROM charging_session WHERE org_id = $1`;
  await query(`DELETE FROM commission_statement WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM commercial_plan WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM fleet_credit_note WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM fleet_invoice_item WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM fleet_invoice WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM cdr WHERE session_id IN (${cs})`, [org.id]);
  await query(`DELETE FROM charging_session WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM ocpi_partner WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM token WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM fleet_account WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM org_tax_registration WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM subscription_plan WHERE org_id = $1`, [org.id]);
  for (const cc of ['ID', 'MY', 'SG']) {
    const ident = `FLTCUR-${cc}`;
    await query(`DELETE FROM connector WHERE evse_uuid IN (SELECT e.id FROM evse e JOIN charge_point cp ON cp.id = e.charge_point_id WHERE cp.ocpp_identity = $1)`, [ident]);
    await query(`DELETE FROM evse WHERE charge_point_id IN (SELECT id FROM charge_point WHERE ocpp_identity = $1)`, [ident]);
    await query(`DELETE FROM charge_point WHERE ocpp_identity = $1`, [ident]);
  }
  await query(`DELETE FROM site WHERE org_id = $1`, [org.id]);
}

if (DB_OK) {
  before(async () => {
    await cleanup();
    orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug, pkp) VALUES ('Fleet Currency Test', $1, true) ON CONFLICT (slug) DO UPDATE SET pkp = true RETURNING id`, [SLUG]))!.id;
    await query(`INSERT INTO org_tax_registration (org_id, country_code, scheme, registration_no, registered, effective_from) VALUES ($1, 'SG', 'SG_GST', 'M90000000X', true, '2024-01-01')`, [orgId]);
    for (const [cc, tz] of [['ID', 'Asia/Jakarta'], ['MY', 'Asia/Kuala_Lumpur'], ['SG', 'Asia/Singapore']] as const) {
      const site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code, timezone) VALUES ($1, $2, $3, $4) RETURNING id`, [orgId, `Hub ${cc}`, cc, tz]))!.id;
      const cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, ocpp_version, status) VALUES ($1, $2, 'ocpp1.6', 'online') RETURNING id`, [site, `FLTCUR-${cc}`]))!.id;
      const e = await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1, 1, 22000) RETURNING id`, [cp]);
      const conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w) VALUES ($1, 1, 'Type2', 'AC', 22000) RETURNING id`, [e!.id]))!.id;
      sites[cc] = { site, cp, conn };
    }
    const card = await one<{ id: string; fleet_account_id: string }>(
      `INSERT INTO token (org_id, kind, uid, status, account_type, fleet_name) VALUES ($1, 'rfid', 'FC-CARD-1', 'Accepted', 'fleet', 'FC Fleet') RETURNING id, fleet_account_id`, [orgId]);
    cardId = card!.id;
    accountId = card!.fleet_account_id;
    await query(`UPDATE fleet_account SET include_roaming = true, tax_id = '0012345678901000', tax_id_kind = 'TIN', address = 'Jakarta' WHERE id = $1`, [accountId]);
    // Sessions: rupiah (PPN), ringgit (no tax), Singapore dollars (GST, inclusive).
    const rated = async (cc: string, cur: string, t: { sub: number; local: number; base: number; rate: number; tax: number; total: number }, scheme: string) => {
      const s = await one<{ id: string }>(
        `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, token_id, state, started_at, ended_at, energy_wh, currency)
         VALUES ($1,$2,$3,$4,$5,$6,'ended','2026-08-10T03:00:00Z','2026-08-10T04:00:00Z',20000,$7) RETURNING id`,
        [orgId, sites[cc]!.site, sites[cc]!.conn, sites[cc]!.cp, `fc-${Math.random()}`, cardId, cur]);
      await query(
        `INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency, tax_scheme, prices_include_tax)
         VALUES ($1,$2,'2026-08-10T04:00:00Z','[]',$3,0,$4,$5,$6,$7,$8,'{}',$9,$10,$11)`,
        [s!.id, orgId, t.sub, t.local, t.base, t.rate, t.tax, t.total, cur, scheme, cur === 'SGD']);
    };
    await rated('ID', 'IDR', { sub: 100_000, local: 0, base: 91_667, rate: 1200, tax: 11_000, total: 111_000 }, 'ID_PPN_PBJT');
    await rated('MY', 'MYR', { sub: 2400, local: 0, base: 0, rate: 0, tax: 0, total: 2400 }, 'NONE');
    await rated('SG', 'SGD', { sub: 1193, local: 0, base: 1193, rate: 900, tax: 107, total: 1300 }, 'SG_GST');
    // A partner network's charge records for the card in three currencies.
    const tok = `p-${Math.random()}`;
    const partner = (await one<{ id: string }>(
      `INSERT INTO ocpi_partner (org_id, name, kind, state, token_in_hash, token_in, token_out, roles, country_code, party_id, endpoints)
       VALUES ($1,'FC Partner','cpo','connected',$2,$3,$4,'[]','MY','FCP','[]') RETURNING id`, [orgId, tokenHash(tok), seal(tok), seal('o' + tok)]))!.id;
    for (const [id, cur, excl, incl] of [['R-MY', 'MYR', 12.5, 13.25], ['R-ID', 'IDR', 30_000, 33_300], ['R-SG', 'SGD', 9.17, 10]] as const) {
      await query(
        `INSERT INTO ocpi_remote_cdr (org_id, partner_id, country_code, party_id, cdr_id, token_id, data, currency, total_excl_vat, total_incl_vat, total_energy,
                                      start_date_time, end_date_time, status, received_at)
         VALUES ($1,$2,'MY','FCP',$3,$4,'{}',$5,$6,$7,10,'2026-08-11T01:00:00Z','2026-08-11T02:00:00Z','accepted','2026-08-12T01:00:00Z')`,
        [orgId, partner, `${id}-${randomBytes(3).toString('hex')}`, cardId, cur, excl, incl]);
    }
    await saveSettings(orgId, { npwp: '0987654321098765', efaktur: { itemCode: '000000', unitCode: 'UM.0033', confirmed: true } }, 'test');
  });
  after(async () => {
    await cleanup();
    await pool.end();
  });
}

dbDescribe('fleet invoices per currency', () => {
  test('the month shows one row per currency for the account, none of them mixing amounts', async () => {
    const o = await periodOverview(orgId, PERIOD);
    const mine = o.rows.filter((r: any) => r.accountId === accountId);
    assert.deepEqual(mine.map((r: any) => r.currency), ['IDR', 'MYR', 'SGD']);
    const by = Object.fromEntries(mine.map((r: any) => [r.currency, r]));
    assert.equal(by.IDR.totalMinor, 111_000 + 33_300);
    assert.equal(by.MYR.totalMinor, 2400 + 1325);
    assert.equal(by.SGD.totalMinor, 1300 + 1000, 'GST recomputed on the line: 1193 × 9 % = 107');
  });

  test('the ringgit draft takes only ringgit: its session and the partner record in sen', async () => {
    const st: any = await statementFor(orgId, accountId, PERIOD, 'MYR');
    assert.equal(st.currency, 'MYR');
    assert.deepEqual(st.sessions.map((s: any) => s.totalMinor), [2400]);
    assert.deepEqual(st.roaming.map((r: any) => r.amountMinor), [1325]);
    assert.equal(st.taxScheme, 'NONE');
    await assert.rejects(statementFor(orgId, accountId, PERIOD, 'EUR'), (e: unknown) => e instanceof FleetBillingError && e.status === 400);
  });

  test('two invoices for the same month, one per currency; a second one in the same currency is refused', async () => {
    const idr = await issueInvoice(orgId, accountId, PERIOD, 'test', 'IDR');
    const myr = await issueInvoice(orgId, accountId, PERIOD, 'test', 'MYR');
    const sgd = await issueInvoice(orgId, accountId, PERIOD, 'test', 'SGD');
    assert.equal(idr.currency, 'IDR');
    assert.equal(myr.totalMinor, 3725);
    assert.equal(sgd.totalMinor, 2300);
    const rows = await many<{ currency: string; total_minor: number; tax_minor: number }>(
      `SELECT currency, total_minor, tax_minor FROM fleet_invoice WHERE fleet_account_id = $1 ORDER BY currency`, [accountId]);
    assert.deepEqual(rows.map((r) => [r.currency, Number(r.total_minor), Number(r.tax_minor)]), [['IDR', 144_300, 11_000], ['MYR', 3725, 0], ['SGD', 2300, 107]]);
    await assert.rejects(issueInvoice(orgId, accountId, PERIOD, 'test', 'MYR'), (e: unknown) => e instanceof FleetBillingError && e.status === 409);
  });

  test('e-Faktur carries the rupiah invoice only; a ringgit invoice asked for by id is skipped', async () => {
    const all = await many<{ id: string; currency: string }>(`SELECT id, currency FROM fleet_invoice WHERE fleet_account_id = $1`, [accountId]);
    const r = await efakturExport(orgId, PERIOD, all.map((x) => x.id));
    assert.equal(r.included.length, 1);
    assert.ok(r.skipped.some((s) => /MYR invoice is not Indonesian/.test(s.reason)));
    assert.ok(r.skipped.some((s) => /SGD invoice is not Indonesian/.test(s.reason)));
    assert.match(r.xml, /<TaxInvoiceDate>2026-08-31<\/TaxInvoiceDate>/);
  });

  test('documents name the currency and the tax: SGD with GST and the registration, MYR without tax, IDR as before', async () => {
    const inv = await many<{ id: string; currency: string }>(`SELECT id, currency FROM fleet_invoice WHERE fleet_account_id = $1`, [accountId]);
    const get = async (cur: string) => (await import('./fleet-billing.js')).getInvoice(orgId, inv.find((i) => i.currency === cur)!.id);
    const sg = invoiceHtml(await get('SGD'));
    assert.match(sg, /GST 9%/);
    assert.match(sg, /S\$ 23\.00/);
    assert.match(sg, /GST Reg\. No\. M90000000X/);
    assert.doesNotMatch(sg, /PPN|DPP|PBJT|Rp /);
    const my = invoiceHtml(await get('MYR'));
    assert.match(my, /RM 37\.25/);
    assert.match(my, /No service tax is charged/);
    assert.doesNotMatch(my, /PPN|Rp /);
    const id = invoiceHtml(await get('IDR'));
    assert.match(id, /PPN 12% × DPP/);
    assert.match(id, /Rp 144\.300/);
    assert.match(invoiceCsv(await get('SGD')), /Receipt \/ amount \(SGD minor\)/);
    const pdf = pdfText(invoicePdf(await get('SGD')));
    assert.ok(pdf.includes('S$ 23.00') && pdf.includes('GST 9%') && !pdf.includes('PPN'), 'the PDF prints S$ and GST');
  });

  test('a credit note on the SGD invoice is in SGD with GST on the whole price', async () => {
    const inv = (await one<{ id: string }>(`SELECT id FROM fleet_invoice WHERE fleet_account_id = $1 AND currency = 'SGD'`, [accountId]))!;
    const cn = await issueCreditNote(orgId, inv.id, { reason: 'goodwill', lines: [{ description: 'goodwill', amountMinor: 109, taxed: true }] }, 'test');
    const c = await getCreditNote(orgId, cn.id);
    assert.equal(c.currency, 'SGD');
    assert.deepEqual([c.totalMinor, c.taxBaseMinor, c.taxMinor], [109, 100, 9]);
  });
});

dbDescribe('commission statements per currency', () => {
  test('GTV is summed per currency: the rupiah statement has the Indonesian site only, the SGD one the Singapore site', async () => {
    const idr: any = await commission.statementFor(orgId, PERIOD, null, 'IDR');
    const sgd: any = await commission.statementFor(orgId, PERIOD, null, 'SGD');
    assert.deepEqual(idr.sites.map((x: any) => x.name), ['Hub ID']);
    assert.equal(idr.totals.gtvMinor, 100_000);
    assert.deepEqual(sgd.sites.map((x: any) => x.name), ['Hub SG']);
    assert.equal(sgd.totals.gtvMinor, 1193);
    assert.equal(sgd.currency, 'SGD');
    assert.equal(sgd.totals.taxMinor, 0, 'issued without tax until V6');
    assert.deepEqual(idr.currencies, ['IDR', 'MYR', 'SGD']);
    assert.match(commission.statementHtml(sgd), /S\$ /);
    assert.doesNotMatch(commission.statementHtml(sgd), /Rp |PPN|DPP/);
  });
  test('a plan per currency; finalising each currency gives its own statement', async () => {
    const r = await commission.savePlan(orgId, { ...((await commission.planFor(orgId, '2026-08', null, 'MYR')).plan), minPerChargerAcMinor: 5_000 }, null, '2026-07', null, 'MYR');
    assert.ok(!('error' in r));
    assert.equal((await commission.planFor(orgId, PERIOD, null, 'MYR')).plan.minPerChargerAcMinor, 5_000);
    assert.equal((await commission.planFor(orgId, PERIOD, null, 'IDR')).custom, false, 'the rupiah plan is untouched');
    const a = await commission.finalise(orgId, PERIOD, null, null, 'IDR');
    const b = await commission.finalise(orgId, PERIOD, null, null, 'SGD');
    assert.ok('number' in a && 'number' in b);
    assert.ok(!(a as any).number.endsWith('-SGD') && (b as any).number.endsWith('-SGD'));
    const rows = await commission.listFinalised(orgId);
    assert.deepEqual(rows.map((x: any) => x.currency).sort(), ['IDR', 'SGD']);
    assert.deepEqual(await commission.finalise(orgId, PERIOD, null, null, 'SGD'), { error: 'already finalised' });
  });
});

dbDescribe('receipts per country', () => {
  const sessionIn = async (cur: string) => (await one<{ id: string }>(`SELECT id FROM charging_session WHERE org_id = $1 AND currency = $2`, [orgId, cur]))!.id;
  test('Singapore: an English tax invoice with GST 9 % included, the GST registration and SGT times', async () => {
    const h = (await receiptHtml(await sessionIn('SGD')))!;
    assert.match(h, /<html lang="en">/);
    assert.match(h, /Tax Invoice \/ Charging Receipt/);
    assert.match(h, /GST Reg\. No\. M90000000X/);
    assert.match(h, /GST 9% \(included\)/);
    assert.match(h, /S\$ 13\.00/);
    assert.match(h, /Price before GST/);
    assert.match(h, / SGT</);
    assert.doesNotMatch(h, /PPN|DPP|PBJT|Rp |Kepmen|SPKLU/);
  });
  test('Malaysia (not registered): no service tax charged, ringgit, MYT', async () => {
    const h = (await receiptHtml(await sessionIn('MYR')))!;
    assert.match(h, /No tax charged/);
    assert.match(h, /RM 24\.00/);
    assert.match(h, / MYT</);
    assert.doesNotMatch(h, /PPN|Rp |GST/);
  });
  test('Singapore, GST-registered: a S$0.00 receipt still shows its GST line, and an unrated one shows no tax lines', async () => {
    // UI sweep v1.7.0: a session that delivered nothing printed "Not GST-registered S$ 0.00" under the GST
    // registration number; an unrated session printed "Subtotal S$ 0.00 · Not GST-registered S$ 0.00".
    const base = (await one<any>(`SELECT site_id, connector_uuid, charge_point_id, token_id FROM charging_session WHERE id = $1`, [await sessionIn('SGD')]))!;
    const mk = async () => (await one<{ id: string }>(
      `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, token_id, state, started_at, ended_at, energy_wh, currency)
       VALUES ($1,$2,$3,$4,$5,$6,'ended','2026-08-11T03:00:00Z','2026-08-11T03:05:00Z',0,'SGD') RETURNING id`,
      [orgId, base.site_id, base.connector_uuid, base.charge_point_id, `fc-${Math.random()}`, base.token_id]))!.id;
    const zero = await mk();
    const unrated = await mk();
    try {
      await query(
        `INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency, tax_scheme, prices_include_tax)
         VALUES ($1,$2,'2026-08-11T03:05:00Z','[]',0,0,0,0,900,0,0,'{}','SGD','SG_GST',true)`, [zero, orgId]);
      const z = (await receiptHtml(zero))!;
      assert.match(z, /GST Reg\. No\. M90000000X/);
      assert.match(z, /GST 9% \(included\)/);
      assert.doesNotMatch(z, /Not GST-registered/);
      const u = (await receiptHtml(unrated))!;
      assert.match(u, /has not been rated yet/);
      assert.doesNotMatch(u, /Not GST-registered|Price before GST|GST 9%/);
    } finally {
      await query(`DELETE FROM cdr WHERE session_id = ANY($1::uuid[])`, [[zero, unrated]]);
      await query(`DELETE FROM charging_session WHERE id = ANY($1::uuid[])`, [[zero, unrated]]);
    }
  });
  test('Indonesia: the bilingual PPN / DPP / PBJT receipt as before', async () => {
    const h = (await receiptHtml(await sessionIn('IDR')))!;
    assert.match(h, /Tanda Terima Pengisian Daya \/ Charging Receipt/);
    assert.match(h, /PPN 12% × DPP/);
    assert.match(h, /Rp 111\.000/);
  });
});


dbDescribe('fees per currency: reservation fees and passes (§D3, non-session supplies)', () => {
  test('a rupiah fee is taxed as before; Singapore GST is inside the price; Malaysia unregistered is not taxed', async () => {
    const idr = await feeTaxerFor(orgId, 'IDR', true);
    assert.deepEqual(idr(10_000), pkpFeeTax(10_000, true));
    assert.equal(idr.inclusive, false);
    const sgd = await feeTaxerFor(orgId, 'SGD', false);
    assert.equal(sgd.scheme, 'SG_GST');
    assert.equal(sgd.inclusive, true);
    assert.deepEqual(sgd(2000), { dpp: 2000 - Math.round((2000 * 900) / 10_900), ppn: Math.round((2000 * 900) / 10_900), total: 2000 });
    const myr = await feeTaxerFor(orgId, 'MYR', false);
    assert.equal(myr(1000).ppn, 0);
    assert.equal(myr(1000).total, 1000);
  });

  test('a reservation fee is in the site\'s currency and taxed by its country', async () => {
    await query(`UPDATE site SET reservation_fee_minor = $2 WHERE id = $1`, [sites.SG!.site, 200]);
    await query(`UPDATE site SET reservation_fee_minor = $2 WHERE id = $1`, [sites.MY!.site, 500]);
    await query(`UPDATE site SET reservation_fee_minor = $2 WHERE id = $1`, [sites.ID!.site, 5000]);
    const sg = await connectorDetail(sites.SG!.conn);
    assert.equal(sg?.currency, 'SGD');
    assert.deepEqual(sg?.reservationFee && { cur: sg.reservationFee.currency, total: sg.reservationFee.totalMinor, tax: sg.reservationFee.taxMinor }, { cur: 'SGD', total: 200, tax: 17 });
    assert.deepEqual(sg?.presetsMinor, [1_000, 2_000, 3_000, 5_000, 8_000], 'S$ presets');
    const my = await connectorDetail(sites.MY!.conn);
    assert.deepEqual(my?.reservationFee && { cur: my.reservationFee.currency, total: my.reservationFee.totalMinor, tax: my.reservationFee.taxMinor }, { cur: 'MYR', total: 500, tax: 0 });
    const id = await connectorDetail(sites.ID!.conn);
    const v16 = pkpFeeTax(5000, true);
    assert.deepEqual(id?.reservationFee && { cur: id.reservationFee.currency, total: id.reservationFee.totalMinor, tax: id.reservationFee.taxMinor }, { cur: 'IDR', total: v16.total, tax: v16.ppn });
    assert.deepEqual(id?.presetsMinor, [50_000, 100_000, 150_000, 200_000, 300_000, 500_000], 'rupiah presets as before');
  });

  test('passes: each plan in its own currency, priced with that country\'s tax', async () => {
    const sgd = (await one<{ id: string }>(`INSERT INTO subscription_plan (org_id, name, monthly_fee_minor, offered_in_app, active, currency) VALUES ($1, 'FC Pass SG', 3000, true, true, 'SGD') RETURNING id`, [orgId]))!.id;
    const idr = (await one<{ id: string }>(`INSERT INTO subscription_plan (org_id, name, monthly_fee_minor, offered_in_app, active) VALUES ($1, 'FC Pass ID', 99000, true, true) RETURNING id`, [orgId]))!.id;
    const o = await membershipOverview({ deviceId: '00000000-0000-4000-8000-000000000001', appDriverId: null, fleetTokenId: null, fleet: null, account: null });
    const sg = o.plans.find((p) => p.id === sgd)!;
    const id = o.plans.find((p) => p.id === idr)!;
    assert.deepEqual({ cur: sg.currency, total: sg.totalMinor, incl: sg.pricesIncludeTax }, { cur: 'SGD', total: 3000, incl: true });
    assert.deepEqual({ cur: id.currency, total: id.totalMinor, incl: id.pricesIncludeTax }, { cur: 'IDR', total: pkpFeeTax(99000, true).total, incl: false });
  });
});
