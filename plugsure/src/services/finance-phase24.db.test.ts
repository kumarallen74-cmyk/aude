import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 24 of the finance review (v1.35.0):
 *   - carbon: RECs bought and retired against a month, the green share and the emissions avoided; credits estimated,
 *     verified, issued (with a serial) and sold up to what is available; the ledger (1750, 5150, 4300);
 *   - insurance: a policy's premium paid (the cash position, 1450) and spread over the term by days (6600); a claim paid
 *     at most the loss less the excess (6605); the renewal alert, resolved by renewing;
 *   - pricing: margin by tariff, connector, time band and site from the site's cost per kWh; the elasticity observed
 *     from month-on-month price moves; a what-if;
 *   - compliance: the standard deadlines added once; reminders; evidence checked against its first bytes; a recurring
 *     task done creates the next one; the auditor's requests need a file before they are provided.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase24.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const carbon = await import('./carbon.js');
const insure = await import('./insurance.js');
const pricing = await import('./pricing-analysis.js');
const comply = await import('./compliance-calendar.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID(), B = randomUUID();
let org = '';
let app: FastifyInstance;
let site = '', cp = '', conn = '', connDc = '';
const zone = config.billing.timeZone;
const localDay = (t: number = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(t));
const monthsBack = (n: number) => {
  let [y, m] = localDay().slice(0, 7).split('-').map(Number) as [number, number];
  for (let i = 0; i < n; i++) { m--; if (m === 0) { m = 12; y--; } }
  return `${y}-${String(m).padStart(2, '0')}`;
};
const daysIn = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, mo, 0)).getUTCDate(); };
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });

/** A rated session on the 10th of a month at hh:00 local, with its charge record under a tariff name. */
async function session(month: string, hh: number, wh: number, revenue: number, tariff: string, connector = conn) {
  const start = new Date(`${month}-10T${String(hh).padStart(2, '0')}:00:00+07:00`);
  const id = (await one<{ id: string }>(
    `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, ended_at, duration_s, energy_wh, state, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 3600, $8, 'rated', 'IDR') RETURNING id`, [org, site, connector, cp, `p24-${randomUUID()}`, start, new Date(start.getTime() + 3_600_000), wh]))!.id;
  await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency)
               VALUES ($1, $2, $3, '[]', $4, 0, 0, $4, 0, 0, $4, $5, 'IDR')`, [id, org, new Date(start.getTime() + 3_600_000), revenue, JSON.stringify({ id: 't', name: tariff })]);
  return id;
}

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Green ${TAG}`, `p24-${TAG}`]))!.id;
    for (const [u, n] of [[A, 'Rina'], [B, 'Budi']] as const) await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, $4)`, [u, org, `${u.slice(0, 8)}@p24.test`, n]);
    site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'ID') RETURNING id`, [org, `Toll plaza ${TAG}`]))!.id;
    cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name) VALUES ($1, $2, $2) RETURNING id`, [site, `P24-${TAG}`]))!.id;
    const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [cp]))!.id;
    conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, connector_id, connector_type, max_power_w) VALUES ($1, 1, 'cType2', 22000) RETURNING id`, [e]))!.id;
    connDc = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w) VALUES ($1, 2, 'cCCS2', 'DC', 60000) RETURNING id`, [e]))!.id;
    await query(`INSERT INTO site_energy_rate (site_id, org_id, rate_per_kwh, currency) VALUES ($1, $2, 1500, 'IDR')`, [site, org]);
    app = Fastify({ bodyLimit: 6 * 1024 * 1024 });
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: A, orgId: org, assignments: [{ permissions: ['payment:read', 'payment:write', 'invoice:read', 'invoice:write', 'finance:approve'], scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
  });
  after(async () => {
    await app?.close();
    const o = [org];
    await query(`DELETE FROM gl_line WHERE org_id = ANY($1::uuid[])`, [o]);
    for (const t of ['compliance_evidence', 'pbc_request', 'compliance_task', 'insurance_claim', 'insurance_policy', 'carbon_credit_sale', 'carbon_credit', 'rec_purchase',
      'gl_entry', 'gl_account', 'cash_transfer', 'cash_balance', 'cash_account', 'site_energy_rate', 'finance_org_settings']) await query(`DELETE FROM ${t} WHERE org_id = ANY($1::uuid[])`, [o]);
    await query(`UPDATE compliance_task SET next_id = NULL WHERE org_id = $1`, [org]).catch(() => 0);
    await query(`DELETE FROM cdr WHERE org_id = $1`, [org]);
    await query(`DELETE FROM charging_session WHERE org_id = $1`, [org]);
    await query(`DELETE FROM connector WHERE id = ANY($1::uuid[])`, [[conn, connDc]]);
    await query(`DELETE FROM evse WHERE charge_point_id = $1`, [cp]);
    await query(`DELETE FROM charge_point WHERE id = $1`, [cp]);
    await query(`DELETE FROM site WHERE org_id = $1`, [org]);
    await query(`DELETE FROM alert WHERE org_id = $1`, [org]);
    await query(`DELETE FROM app_user WHERE org_id = $1`, [org]).catch(() => { /* audit rows keep them */ });
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => { /* audit rows keep it */ });
    await pool.end();
  });
}

describe('Carbon, insurance, pricing and compliance helpers', () => {
  test('avoided emissions, premium shares by days, time bands, arc elasticity, recurrence, titles, file sniffing', () => {
    assert.equal(carbon.avoidedKg(100, 0, { gridKgPerKwh: 0.8, iceKgPerKwh: 0.7 }), 100 * 0.7 - 100 * 0.8, 'all grid: worse than petrol on a coal-heavy grid');
    assert.equal(carbon.avoidedKg(100, 1, { gridKgPerKwh: 0.8, iceKgPerKwh: 0.7 }), 70);
    assert.equal(insure.monthShare(36_500, '2026-01-01', '2027-01-01', '2026-02'), 2_800, '28 of 365 days');
    assert.equal(insure.monthShare(36_500, '2026-01-15', '2027-01-15', '2026-01'), 1_700, 'from the 15th: 17 days');
    assert.equal(insure.monthShare(36_500, '2026-01-15', '2027-01-15', '2027-01'), 1_400, 'to the 14th: 14 days');
    assert.equal(insure.monthShare(36_500, '2026-01-15', '2027-01-15', '2027-02'), 0);
    assert.deepEqual([pricing.band(5), pricing.band(6), pricing.band(16), pricing.band(17), pricing.band(21), pricing.band(22)], ['night', 'day', 'day', 'peak', 'peak', 'night']);
    assert.equal(pricing.arcElasticity(100, 100, 110, 95), Math.round(((-5 / 97.5) / (10 / 105)) * 100) / 100);
    assert.equal(pricing.arcElasticity(100, 100, 100, 90), null);
    assert.equal(comply.nextDue('2027-01-31', 'monthly'), '2027-02-28');
    assert.equal(comply.nextDue('2027-01-10', 'quarterly'), '2027-04-10');
    assert.equal(comply.nextDue('2028-02-29', 'yearly'), '2029-02-28');
    assert.equal(comply.nextDue('2027-01-10', 'none'), null);
    assert.equal(comply.rollTitle('LKPM Q4 2026', '2027-01-10', '2027-04-10'), 'LKPM Q1 2027');
    assert.equal(comply.rollTitle('Annual GMS FY 2026', '2027-06-30', '2028-06-30'), 'Annual GMS FY 2027');
    assert.equal(comply.sniffOk('application/pdf', Buffer.from('%PDF-1.7\n')), true);
    assert.equal(comply.sniffOk('application/pdf', Buffer.from([0x89, 0x50, 0x4e, 0x47])), false);
    assert.equal(comply.sniffOk('text/csv', Buffer.from('a,b\n1,2\n')), true);
    assert.equal(comply.sniffOk('text/csv', Buffer.from([0x61, 0, 0x62])), false);
    assert.equal(comply.templates(2027).length, 5);
  });
});

dbDescribe('Pricing profitability (v1.35.0)', () => {
  test('margin by tariff, connector, band and site; the elasticity observed; a what-if', async () => {
    const m = monthsBack(1), m2 = monthsBack(2), m3 = monthsBack(3);
    await session(m, 10, 20_000, 50_000, 'Standard');          // day, Type 2: cost 30 000, margin 20 000
    await session(m, 18, 30_000, 90_000, 'Peak plan', connDc);  // peak, CCS2: cost 45 000, margin 45 000
    await session(m2, 11, 30_000, 90_000, 'Standard');          // 3 000 / kWh
    await session(m3, 11, 40_000, 100_000, 'Standard');         // 2 500 / kWh
    const a = (await call('GET', '/v1/finance/pricing?months=1')).json();
    const all = a.totals[0];
    assert.deepEqual([all.sessions, all.kwh, all.revenue, all.energyCost, all.margin], [2, 50, 140_000, 75_000, 65_000]);
    const peak = a.band.find((r: any) => r.key === 'peak'), day = a.band.find((r: any) => r.key === 'day');
    assert.deepEqual([peak.revenue, peak.energyCost, peak.margin, peak.marginPct, peak.pricePerKwh, peak.costPerKwh], [90_000, 45_000, 45_000, 50, 3_000, 1_500]);
    assert.equal(day.margin, 20_000);
    assert.deepEqual(a.tariff.map((r: any) => r.label).sort(), ['Peak plan', 'Standard']);
    assert.deepEqual(a.connector.map((r: any) => r.key).sort(), ['cCCS2', 'cType2']);
    assert.equal(a.site[0].label, `Toll plaza ${TAG}`);
    // Elasticity: 2 500 → 3 000 (m3 → m2) and 3 000 → 2 800 (m2 → m), volumes per day.
    const e1 = pricing.arcElasticity(2_500, 40 / daysIn(m3), 3_000, 30 / daysIn(m2))!, e2 = pricing.arcElasticity(3_000, 30 / daysIn(m2), 2_800, 50 / daysIn(m))!;
    assert.equal(a.elasticity.observations.length, 2);
    assert.equal(a.elasticity.estimate, Math.round(((e1 + e2) / 2) * 100) / 100);
    assert.equal(a.elasticity.source, 'default', 'two moves are too few to price on');
    assert.equal(a.elasticity.used, -0.3);
    const w = (await call('POST', '/v1/finance/pricing/what-if', { months: 1, dimension: 'band', key: 'peak', changePct: 10, elasticity: -0.5 })).json();
    assert.deepEqual([w.after.kwh, w.after.revenue, w.after.energyCost, w.after.margin, w.deltaMargin], [28.5, 94_050, 42_750, 51_300, 6_300]);
    assert.equal((await call('POST', '/v1/finance/pricing/what-if', { dimension: 'band', key: 'nope', changePct: 5 })).statusCode, 404);
    assert.equal((await call('POST', '/v1/finance/pricing/what-if', { changePct: 500 })).statusCode, 422);
    assert.equal((await call('GET', '/v1/finance/pricing?months=99')).statusCode, 400);
    assert.equal((await call('GET', '/v1/finance/pricing?format=xlsx')).rawPayload.subarray(0, 2).toString(), 'PK');
  });
});

dbDescribe('Carbon and green energy (v1.35.0)', () => {
  test('RECs retired for a green share, the emissions avoided; credits issued and sold; the ledger', async () => {
    const m = monthsBack(1);
    const bank = (await call('POST', '/v1/finance/cash/accounts', { name: `Green account ${TAG}`, kind: 'bank', currency: 'IDR', openingBalance: 10_000_000, openingOn: `${monthsBack(4)}-01` })).json();
    // The month has 50 kWh (the pricing test's two sessions); half covered by a REC.
    assert.equal((await call('POST', '/v1/finance/carbon/recs', { registry: 'I-REC', vintage: 2026, mwh: 0, currency: 'IDR' })).statusCode, 422);
    const rec = (await call('POST', '/v1/finance/carbon/recs', { registry: 'I-REC', reference: `R-${TAG}`, vintage: 2026, mwh: 0.025, price: 200_000, currency: 'IDR', boughtOn: `${m}-05`, siteId: site, cashAccountId: bank.id })).json();
    const mo = (await call('POST', `/v1/finance/carbon/recs/${rec.id}/retire`, { month: m })).json();
    assert.equal(mo.greenPct, 50);
    assert.equal(mo.avoidedTonnes, 0.015, '50 × 0.7 − 50 × 0.5 × 0.8 = 15 kg');
    assert.equal((await call('POST', `/v1/finance/carbon/recs/${rec.id}/retire`, { month: m })).statusCode, 409);
    const cr = (await call('POST', '/v1/finance/carbon/credits', { from: m, to: m })).json();
    assert.equal(cr.tonnes, 0.015);
    assert.equal((await call('POST', `/v1/finance/carbon/credits/${cr.id}/sales`, { buyer: 'X', tonnes: 0.01, amount: 1, currency: 'IDR' })).statusCode, 409, 'not issued');
    assert.equal((await call('PUT', `/v1/finance/carbon/credits/${cr.id}`, { status: 'issued' })).statusCode, 422, 'no serial');
    assert.equal((await call('PUT', `/v1/finance/carbon/credits/${cr.id}`, { status: 'verified', standard: 'Verra VCS' })).json().status, 'verified');
    assert.equal((await call('PUT', `/v1/finance/carbon/credits/${cr.id}`, { status: 'estimated' })).statusCode, 422, 'no going back');
    assert.equal((await call('PUT', `/v1/finance/carbon/credits/${cr.id}`, { status: 'issued', serial: `VCS-${TAG}` })).json().status, 'issued');
    const sale = (await call('POST', `/v1/finance/carbon/credits/${cr.id}/sales`, { buyer: `Airline ${TAG}`, tonnes: 0.01, amount: 100_000, currency: 'IDR', soldOn: `${m}-20`, cashAccountId: bank.id })).json();
    assert.equal(sale.available, 0.005);
    assert.equal((await call('POST', `/v1/finance/carbon/credits/${cr.id}/sales`, { buyer: 'More', tonnes: 0.01, amount: 1, currency: 'IDR', soldOn: `${m}-21` })).statusCode, 422);
    assert.equal((await call('PUT', `/v1/finance/carbon/credits/${cr.id}`, { status: 'void' })).statusCode, 409, 'sold');
    const ov = (await call('GET', '/v1/finance/carbon')).json();
    assert.equal(ov.trend.length, 6);
    assert.equal(ov.credits[0].available, 0.005);
    assert.equal(ov.recsHeld, 0);
    const pos = (await call('GET', `/v1/finance/cash?date=${m}-28`)).json();
    assert.equal(pos.accounts.find((x: any) => x.id === bank.id).balance, 10_000_000 - 200_000 + 100_000);
    await call('POST', `/v1/finance/ledger/sync/${m}`);
    const led = (await call('GET', `/v1/finance/ledger?month=${m}&currency=IDR`)).json();
    assert.equal(led.profitAndLoss.month.revenue.find((x: any) => x.code === '4300')?.amount, 100_000);
    assert.equal(Math.abs(led.profitAndLoss.month.expense.find((x: any) => x.code === '5150')?.amount), 200_000);
    assert.equal(led.balanceSheet.assets.find((x: any) => x.code === '1750')?.amount ?? 0, 0, 'bought and retired in the month');
    assert.equal((await call('PUT', '/v1/finance/carbon/settings', { gridKgPerKwh: -1 })).statusCode, 422);
    assert.equal((await call('GET', `/v1/finance/carbon?format=xlsx&from=${m}&to=${m}`)).rawPayload.subarray(0, 2).toString(), 'PK');
  });
});

dbDescribe('Insurance and claims (v1.35.0)', () => {
  test('the premium prepaid and spread by days; a claim paid less the excess; the renewal alert', async () => {
    const m = monthsBack(1), start = `${monthsBack(2)}-01`;
    const endY = Number(start.slice(0, 4)) + 1, end = `${endY}${start.slice(4)}`;
    const bank = (await call('POST', '/v1/finance/cash/accounts', { name: `Insurance account ${TAG}`, kind: 'bank', currency: 'IDR', openingBalance: 50_000_000, openingOn: `${monthsBack(4)}-01` })).json();
    const base = { insurer: `Asuransi ${TAG}`, kind: 'equipment', siteId: site, currency: 'IDR', cover: 500_000_000, premium: 12_000_000, excess: 1_000_000 };
    assert.equal((await call('POST', '/v1/finance/insurance/policies', { ...base, policyNo: 'X', startOn: '2026-05-01', endOn: '2026-04-01' })).statusCode, 422);
    const p = (await call('POST', '/v1/finance/insurance/policies', { ...base, policyNo: `EQ-${TAG}`, startOn: start, endOn: end, paidOn: start, cashAccountId: bank.id })).json();
    assert.equal(p.inForce, true);
    assert.equal((await call('POST', '/v1/finance/insurance/policies', { ...base, policyNo: `EQ-${TAG}`, startOn: start, endOn: end })).statusCode, 409, 'same number');
    const pos = (await call('GET', `/v1/finance/cash?date=${m}-28`)).json();
    assert.equal(pos.accounts.find((x: any) => x.id === bank.id).balance, 50_000_000 - 12_000_000);

    assert.equal((await call('POST', `/v1/finance/insurance/policies/${p.id}/claims`, { kind: 'damage', incidentOn: '2020-01-01', description: 'Before the policy', loss: 1 })).statusCode, 422);
    const c = (await call('POST', `/v1/finance/insurance/policies/${p.id}/claims`, { kind: 'damage', incidentOn: `${m}-12`, description: 'Charger hit by a truck', loss: 5_000_000 })).json();
    assert.match(c.number, /^CL-\d{5}$/);
    assert.equal((await call('POST', `/v1/finance/insurance/claims/${c.id}`, { status: 'accepted' })).statusCode, 409, 'not submitted');
    await call('POST', `/v1/finance/insurance/claims/${c.id}`, { status: 'submitted', insurerRef: 'INS-1' });
    await call('POST', `/v1/finance/insurance/claims/${c.id}`, { status: 'accepted' });
    assert.equal((await call('POST', `/v1/finance/insurance/claims/${c.id}`, { status: 'paid', settled: 4_500_000 })).statusCode, 422, 'above the loss less the excess');
    const paid = (await call('POST', `/v1/finance/insurance/claims/${c.id}`, { status: 'paid', paidOn: `${m}-25` })).json();
    assert.equal(paid.settled, 4_000_000);

    await call('POST', `/v1/finance/ledger/sync/${monthsBack(2)}`);
    await call('POST', `/v1/finance/ledger/sync/${m}`);
    const led = (await call('GET', `/v1/finance/ledger?month=${m}&currency=IDR`)).json();
    const share = (mm: string) => insure.monthShare(12_000_000, start, end, mm);
    assert.equal(Math.abs(led.profitAndLoss.month.expense.find((x: any) => x.code === '6600')?.amount), share(m));
    assert.equal(Math.abs(led.profitAndLoss.month.expense.find((x: any) => x.code === '6605')?.amount), 4_000_000);
    assert.equal(led.balanceSheet.assets.find((x: any) => x.code === '1450')?.amount, 12_000_000 - share(monthsBack(2)) - share(m));

    // A policy ending in 20 days raises the renewal alert; renewing resolves it.
    const t = Date.now();
    const p2 = (await call('POST', '/v1/finance/insurance/policies', { ...base, kind: 'liability', policyNo: `LI-${TAG}`, startOn: localDay(t - 345 * 86_400_000), endOn: localDay(t + 20 * 86_400_000) })).json();
    await insure.sweep();
    const al = await many<any>(`SELECT severity FROM alert WHERE org_id = $1 AND kind = 'finance.insurance_renewal' AND target_id = $2 AND resolved_at IS NULL`, [org, p2.id]);
    assert.equal(al.length, 1);
    assert.equal((await call('GET', '/v1/finance/insurance')).json().renewing.length, 1);
    const r = (await call('POST', `/v1/finance/insurance/policies/${p2.id}/renew`, { premium: 13_000_000 })).json();
    assert.equal(r.startOn, p2.endOn);
    assert.equal(r.premium, 13_000_000);
    assert.equal((await call('POST', `/v1/finance/insurance/policies/${p2.id}/renew`, {})).statusCode, 409);
    assert.equal((await many(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'finance.insurance_renewal' AND target_id = $2 AND resolved_at IS NULL`, [org, p2.id])).length, 0);
    const ov = (await call('GET', '/v1/finance/insurance')).json();
    assert.equal(ov.totals.IDR.recoveryPct, 80);
    assert.equal((await call('GET', '/v1/finance/insurance?format=xlsx')).rawPayload.subarray(0, 2).toString(), 'PK');
  });
});

dbDescribe('Audit and compliance calendar (v1.35.0)', () => {
  test('templates once; reminders; evidence sniffed; recurrence; the auditor requests', async () => {
    const y = Number(localDay().slice(0, 4)) + 1;
    assert.equal((await call('POST', '/v1/finance/compliance/templates', { year: y })).json().added, 5);
    assert.equal((await call('POST', '/v1/finance/compliance/templates', { year: y })).json().added, 0, 'once');
    const due = localDay(Date.now() + 5 * 86_400_000);
    const t = (await call('POST', '/v1/finance/compliance/tasks', { title: `OJK report Q3 ${due.slice(0, 4)}`, category: 'regulator', authority: 'OJK', dueOn: due, recurrence: 'quarterly', ownerId: B, remindDays: 14 })).json();
    assert.equal(t.owner, 'Budi');
    assert.equal((await call('POST', '/v1/finance/compliance/tasks', { title: 'Bad', category: 'nope', dueOn: due })).statusCode, 422);
    await comply.sweep();
    assert.equal((await many(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'finance.compliance_due' AND target_id = $2 AND resolved_at IS NULL AND severity = 'warning'`, [org, t.id])).length, 1);

    const pdf = Buffer.from('%PDF-1.4\n% evidence\n');
    assert.equal((await call('POST', `/v1/finance/compliance/tasks/${t.id}/evidence`, { filename: 'fake.pdf', mime: 'application/pdf', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]).toString('base64') })).statusCode, 422);
    assert.equal((await call('POST', `/v1/finance/compliance/tasks/${t.id}/evidence`, { filename: 'x.exe', mime: 'application/x-msdownload', data: pdf.toString('base64') })).statusCode, 422);
    const big = Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(comply.MAX_EVIDENCE)]);
    assert.equal((await call('POST', `/v1/finance/compliance/tasks/${t.id}/evidence`, { filename: 'big.pdf', mime: 'application/pdf', data: big.toString('base64') })).statusCode, 413);
    const ev = (await call('POST', `/v1/finance/compliance/tasks/${t.id}/evidence`, { filename: 'receipt.pdf', mime: 'application/pdf', data: pdf.toString('base64') })).json();
    assert.equal(ev.bytes, pdf.length);
    const dl = await call('GET', `/v1/finance/compliance/evidence/${ev.id}`);
    assert.equal(dl.headers['content-type'], 'application/pdf');
    assert.deepEqual(dl.rawPayload, pdf);

    assert.equal((await call('POST', `/v1/finance/compliance/tasks/${t.id}/status`, { status: 'waived' })).statusCode, 422, 'a waiver needs a note');
    const done = (await call('POST', `/v1/finance/compliance/tasks/${t.id}/status`, { status: 'done' })).json();
    assert.equal(done.onTime, true);
    assert.ok(done.nextId);
    const next = (await call('GET', `/v1/finance/compliance/tasks/${done.nextId}`)).json();
    assert.equal(next.dueOn, comply.nextDue(due, 'quarterly'));
    assert.equal(next.title, comply.rollTitle(t.title, due, next.dueOn));
    assert.equal(next.owner, 'Budi');
    assert.equal((await many(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'finance.compliance_due' AND target_id = $2 AND resolved_at IS NULL`, [org, t.id])).length, 0);
    assert.equal((await call('PUT', `/v1/finance/compliance/tasks/${t.id}`, { title: 'Changed' })).statusCode, 409, 'done');
    // Reopening and finishing again does not create a second next task.
    await call('POST', `/v1/finance/compliance/tasks/${t.id}/status`, { status: 'open' });
    assert.equal((await call('POST', `/v1/finance/compliance/tasks/${t.id}/status`, { status: 'done' })).json().nextId, done.nextId);

    const pbc = (await call('POST', '/v1/finance/compliance/pbc', { audit: `FY ${y - 1}`, ref: 'A-1', item: 'Bank confirmations for all accounts', dueOn: due, ownerId: A })).json();
    assert.equal((await call('PUT', `/v1/finance/compliance/pbc/${pbc.id}`, { status: 'provided' })).statusCode, 409, 'no file yet');
    assert.equal((await call('PUT', `/v1/finance/compliance/pbc/${pbc.id}`, { status: 'accepted' })).statusCode, 409);
    await call('POST', `/v1/finance/compliance/pbc/${pbc.id}/evidence`, { filename: 'banks.csv', mime: 'text/csv', data: Buffer.from('bank,balance\nBCA,1000\n').toString('base64') });
    assert.equal((await call('PUT', `/v1/finance/compliance/pbc/${pbc.id}`, { status: 'provided' })).json().providedOn, localDay());
    assert.equal((await call('PUT', `/v1/finance/compliance/pbc/${pbc.id}`, { status: 'accepted' })).json().status, 'accepted');
    assert.equal((await call('POST', `/v1/finance/compliance/pbc/${pbc.id}/evidence`, { filename: 'late.csv', mime: 'text/csv', data: Buffer.from('x\n').toString('base64') })).statusCode, 409);

    const ov = (await call('GET', `/v1/finance/compliance?from=${localDay()}&to=${y}-12-31`)).json();
    assert.equal(ov.tasks.filter((x: any) => x.category === 'financial_statements').length, 1);
    assert.equal(ov.stats.pbcOpen, 0);
    assert.equal((await call('GET', '/v1/finance/compliance?format=xlsx')).rawPayload.subarray(0, 2).toString(), 'PK');
  });
});
