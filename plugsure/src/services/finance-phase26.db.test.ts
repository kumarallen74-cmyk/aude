import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 26 of the finance review (v1.37.0):
 *   - loyalty costs: the points liability at month ends with the learned breakage, the ledger's true-up (2250, 4150),
 *     promotion and points cost per promotion and site;
 *   - tax audit readiness: the year's equalisation and its gaps (withholding without a slip), the tax office's letters
 *     with their deadlines, the pack;
 *   - site P&L: rent, maintenance, insurance and grants on top of the month's site P&L; ranking and signals;
 *   - budget planning: a version seeded from the forecast, lines, submitted and approved by a second person, published
 *     to Budgets; a later version superseding it.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase26.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const la = await import('./loyalty-accounting.js');
const ta = await import('./tax-audit.js');
const sp = await import('./site-pnl.js');
const bp = await import('./budget-planning.js');
const ins = await import('./insurance.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID(), B = randomUUID();
let org = '';
let app: FastifyInstance;
let principalUser: string = A;
let siteA = '', siteB = '', cp = '', conn = '', driver = '';
const zone = config.billing.timeZone;
const localDay = (t: number = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(t));
const monthsBack = (n: number) => {
  let [y, m] = localDay().slice(0, 7).split('-').map(Number) as [number, number];
  for (let i = 0; i < n; i++) { m--; if (m === 0) { m = 12; y--; } }
  return `${y}-${String(m).padStart(2, '0')}`;
};
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });
const as = async <T>(user: string, fn: () => Promise<T>) => { const u = principalUser; principalUser = user; try { return await fn(); } finally { principalUser = u; } };

async function session(site: string, month: string, wh: number, revenue: number) {
  const start = new Date(`${month}-10T10:00:00+07:00`);
  const id = (await one<{ id: string }>(
    `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, ended_at, duration_s, energy_wh, state, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 3600, $8, 'rated', 'IDR') RETURNING id`, [org, site, conn, cp, `p26-${randomUUID()}`, start, new Date(start.getTime() + 3_600_000), wh]))!.id;
  await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency)
               VALUES ($1, $2, $3, '[]', $4, 0, 0, $4, 0, 0, $4, '{}', 'IDR')`, [id, org, new Date(start.getTime() + 3_600_000), revenue]);
  return id;
}

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Portfolio ${TAG}`, `p26-${TAG}`]))!.id;
    for (const [u, n] of [[A, 'Rina'], [B, 'Budi']] as const) await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, $4)`, [u, org, `${u.slice(0, 8)}@p26.test`, n]);
    siteA = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'ID') RETURNING id`, [org, `A Mall ${TAG}`]))!.id;
    siteB = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'ID') RETURNING id`, [org, `B Office ${TAG}`]))!.id;
    cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name) VALUES ($1, $2, $2) RETURNING id`, [siteA, `P26-${TAG}`]))!.id;
    const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [cp]))!.id;
    conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, max_power_w) VALUES ($1, 60000) RETURNING id`, [e]))!.id;
    await query(`INSERT INTO site_energy_rate (site_id, org_id, rate_per_kwh, currency) VALUES ($1, $3, 1500, 'IDR'), ($2, $3, 1500, 'IDR')`, [siteA, siteB, org]);
    driver = (await one<{ id: string }>(`INSERT INTO app_driver (phone) VALUES ($1) RETURNING id`, [`+62811${Math.floor(Math.random() * 1e8)}`]))!.id;
    app = Fastify({ bodyLimit: 6 * 1024 * 1024 });
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: principalUser, orgId: org, assignments: [{ permissions: ['payment:read', 'payment:write', 'invoice:read', 'invoice:write', 'finance:approve'], scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
  });
  after(async () => {
    await app?.close();
    const o = [org];
    await query(`DELETE FROM gl_line WHERE org_id = ANY($1::uuid[])`, [o]);
    // landlord_statement: another test's landlord sweep (it covers every active deal) may draft one for this deal.
    for (const t of ['budget_plan_line', 'budget_plan', 'finance_budget', 'tax_audit_case', 'promotion_redemption', 'promotion', 'loyalty_entry', 'loyalty_program', 'grant_claim', 'grant_programme', 'insurance_policy', 'landlord_statement', 'landlord_deal',
      'work_order', 'supplier_bill', 'supplier', 'gl_entry', 'gl_account', 'site_energy_rate', 'finance_org_settings']) await query(`DELETE FROM ${t} WHERE org_id = ANY($1::uuid[])`, [o]);
    await query(`DELETE FROM cdr WHERE org_id = $1`, [org]);
    await query(`DELETE FROM charging_session WHERE org_id = $1`, [org]);
    await query(`DELETE FROM app_driver WHERE id = $1`, [driver]).catch(() => 0);
    await query(`DELETE FROM connector WHERE id = $1`, [conn]);
    await query(`DELETE FROM evse WHERE charge_point_id = $1`, [cp]);
    await query(`DELETE FROM charge_point WHERE id = $1`, [cp]);
    await query(`DELETE FROM site WHERE org_id = $1`, [org]);
    await query(`DELETE FROM alert WHERE org_id = $1`, [org]);
    await query(`DELETE FROM app_user WHERE org_id = $1`, [org]).catch(() => { /* audit rows keep them */ });
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => { /* audit rows keep it */ });
    await pool.end();
  });
}

describe('Loyalty, tax audit, site P&L and budget helpers', () => {
  test('breakage and the net liability; material differences; growth; site signals', () => {
    assert.equal(la.breakageRate(-100, -300), 25);
    assert.equal(la.breakageRate(0, 0), 0);
    assert.deepEqual(la.netLiability(600, 10, 25), { gross: 6000, net: 4500 });
    assert.deepEqual(la.netLiability(-5, 10, 0), { gross: 0, net: 0 });
    assert.equal(ta.material(1_000_000, 1_000_500), false, 'within 0.5%');
    assert.equal(ta.material(1_000_000, 1_100_000), true);
    assert.equal(ta.material(500, 1400), false, 'under Rp 1 000');
    assert.equal(bp.grown(1200, 0, 6), 1200);
    assert.equal(bp.grown(1000, 12, 12), 1120);
    const base = { revenue: 1000, kwh: 100, energyCost: 200, shared: 0, depreciation: 0, rent: 100, maintenance: 0, insurance: 0, grants: 0, contribution: 700, operating: 700 };
    assert.equal(sp.signal({ ...base, operating: -100, contribution: -100 }, [-50, -50], [-50, -50], { topQuartile: null, maintPerKwhMedian: null }).signal, 'close_review');
    assert.equal(sp.signal({ ...base, rent: 400 }, [100, 100], [100, 100], { topQuartile: null, maintPerKwhMedian: null }).signal, 'fix');
    assert.match(sp.signal({ ...base, rent: 400 }, [100], [100], { topQuartile: null, maintPerKwhMedian: null }).reasons[0]!, /rent is 40%/);
    assert.equal(sp.signal(base, [300, 400], [300, 400], { topQuartile: 500, maintPerKwhMedian: null }).signal, 'grow');
    assert.equal(sp.signal(base, [400, 300], [400, 300], { topQuartile: 500, maintPerKwhMedian: null }).signal, 'keep');
  });
});

dbDescribe('Loyalty and promotion costs (v1.37.0)', () => {
  test('the liability with learned breakage, the ledger true-up, cost per promotion and site', async () => {
    const m1 = monthsBack(1), m2 = monthsBack(2);
    await query(`INSERT INTO loyalty_program (org_id, enabled, point_value_minor) VALUES ($1, true, 10)`, [org]);
    const s1 = await session(siteA, m1, 50_000, 500_000);
    await query(`INSERT INTO loyalty_entry (org_id, app_driver_id, kind, points, remaining, created_at) VALUES ($1, $2, 'earn', 1000, 600, $3)`, [org, driver, `${m2}-05T10:00:00+07:00`]);
    await query(`INSERT INTO loyalty_entry (org_id, app_driver_id, kind, points, value_minor, session_id, created_at) VALUES ($1, $2, 'redeem', -300, -3000, $3, $4)`, [org, driver, s1, `${m1}-10T11:00:00+07:00`]);
    await query(`INSERT INTO loyalty_entry (org_id, app_driver_id, kind, points, created_at) VALUES ($1, $2, 'expire', -100, $3)`, [org, driver, `${m1}-20T00:00:00+07:00`]);
    const pr = (await one<{ id: string }>(`INSERT INTO promotion (org_id, name, kind, value) VALUES ($1, $2, 'amount_off', 5000) RETURNING id`, [org, `Grand opening ${TAG}`]))!.id;
    await query(`INSERT INTO promotion_redemption (session_id, promotion_id, org_id, customer_key, discount_minor, created_at) VALUES ($1, $2, $3, 'driver:x', 5000, $4)`, [s1, pr, org, `${m1}-10T11:00:00+07:00`]);
    const o = (await call('GET', '/v1/finance/loyalty?months=2')).json();
    const l1 = o.liability.find((l: any) => l.month === m1), l2 = o.liability.find((l: any) => l.month === m2);
    assert.deepEqual([l2.points, l2.breakagePct, l2.net], [1000, 0, 10_000]);
    assert.deepEqual([l1.points, l1.breakagePct, l1.gross, l1.net, l1.change, l1.redeemed, l1.expired, l1.redeemedValue], [600, 25, 6000, 4500, -5500, 300, 100, 3000]);
    assert.equal(o.promotions[0].discount, 5000);
    const site = o.sites.find((s: any) => s.siteId === siteA);
    assert.deepEqual([site.discount, site.pointsRedeemed, site.cost, site.costPct], [5000, 3000, 8000, 1.6]);
    await call('POST', `/v1/finance/ledger/sync/${m2}`);
    await call('POST', `/v1/finance/ledger/sync/${m1}`);
    const led = (await call('GET', `/v1/finance/ledger?month=${m1}&currency=IDR`)).json();
    assert.equal(led.balanceSheet.liabilities.find((x: any) => x.code === '2250')?.amount, 4500);
    assert.equal(led.profitAndLoss.month.revenue.find((x: any) => x.code === '4150')?.amount, 5500, 'released back to revenue');
    assert.equal((await call('PUT', '/v1/finance/loyalty/settings', { breakagePct: 95 })).statusCode, 422);
    await call('PUT', '/v1/finance/loyalty/settings', { breakagePct: 50 });
    assert.equal((await call('GET', '/v1/finance/loyalty?months=1')).json().liability[0].net, 3000);
    await call('PUT', '/v1/finance/loyalty/settings', { breakagePct: '' });
    assert.equal((await call('GET', '/v1/finance/loyalty?format=xlsx')).rawPayload.subarray(0, 2).toString(), 'PK');
  });
});

dbDescribe('Tax audit readiness (v1.37.0)', () => {
  test('the equalisation and its gaps; letters with deadlines; the pack', async () => {
    const m1 = monthsBack(1), year = Number(m1.slice(0, 4));
    const sup = (await call('POST', '/v1/finance/suppliers', { name: `PT Konsultan ${TAG}`, termsDays: 30 })).json();
    const bill = await one<{ id: string }>(`INSERT INTO supplier_bill (org_id, supplier_id, number, category, description, currency, subtotal_minor, vat_minor, wht_minor, wht_kind, bill_date, due_date, status)
      VALUES ($1, $2, $3, 'services', 'Tax advice', 'IDR', 1000000, 110000, 20000, 'pph23', $4, $4, 'approved') RETURNING id`, [org, sup.id, `INV-${TAG}`, `${m1}-12`]);
    const e = (await call('GET', `/v1/finance/tax-audit?year=${year}`)).json();
    const gap = e.gaps.find((g: any) => g.kind === 'no_slip');
    assert.ok(gap, 'withholding without a bukti potong');
    assert.equal(gap.amount, 20_000);
    assert.ok(e.gaps.some((g: any) => g.kind === 'input_vat' && g.month === m1), 'PPN on the bill without faktur masukan');
    const row = e.months.find((m: any) => m.month === m1);
    assert.deepEqual([row.withheld, row.slips, row.billVat], [20_000, 0, 110_000]);
    assert.ok(e.readinessPct < 100);
    void bill;

    const c = (await call('POST', '/v1/finance/tax-audit/cases', { kind: 'sp2dk', letterNo: `S-${TAG}/WPJ.04`, taxYear: year - 1, taxes: ['ppn', 'pph23'], receivedOn: localDay(Date.now() - 10 * 86_400_000) })).json();
    assert.equal(c.respondBy, localDay(Date.now() + 4 * 86_400_000), 'an SP2DK is answered within 14 days');
    assert.equal((await call('POST', '/v1/finance/tax-audit/cases', { kind: 'sp2dk', letterNo: `S-${TAG}/WPJ.04`, taxYear: year - 1 })).statusCode, 409);
    assert.equal((await call('POST', '/v1/finance/tax-audit/cases', { kind: 'sp2dk', letterNo: 'X-1', taxYear: year, taxes: ['vat'] })).statusCode, 422);
    await ta.sweep();
    assert.equal((await many(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'finance.tax_audit_due' AND resolved_at IS NULL AND severity = 'warning'`, [org])).length, 1);
    assert.equal((await call('PUT', `/v1/finance/tax-audit/cases/${c.id}`, { status: 'paid' })).statusCode, 409);
    assert.equal((await call('PUT', `/v1/finance/tax-audit/cases/${c.id}`, { status: 'assessed' })).statusCode, 422, 'the amount assessed');
    const a = (await call('PUT', `/v1/finance/tax-audit/cases/${c.id}`, { status: 'assessed', assessed: 15_000_000 })).json();
    assert.deepEqual([a.status, a.assessed], ['assessed', 15_000_000]);
    assert.equal((await many(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'finance.tax_audit_due' AND resolved_at IS NULL`, [org])).length, 0);
    assert.equal((await call('PUT', `/v1/finance/tax-audit/cases/${c.id}`, { status: 'paid' })).json().closedOn, localDay());
    const pk = await call('GET', `/v1/finance/tax-audit/pack?year=${year}`);
    assert.equal(pk.rawPayload.subarray(0, 2).toString(), 'PK');
    assert.match(String(pk.headers['x-manifest-sha256']), /^[0-9a-f]{64}$/);
    assert.equal((await call('GET', `/v1/finance/tax-audit?year=${year}&format=xlsx`)).rawPayload.subarray(0, 2).toString(), 'PK');
  });
});

dbDescribe('Site P&L and portfolio review (v1.37.0)', () => {
  test('rent, maintenance, insurance and grants on the site P&L; ranks and signals', async () => {
    const m1 = monthsBack(1), m2 = monthsBack(2), m3 = monthsBack(3);
    await session(siteB, m1, 10_000, 100_000);
    const sup = (await call('POST', '/v1/finance/suppliers', { name: `PT Landlord ${TAG}`, termsDays: 30 })).json();
    await call('POST', '/v1/finance/landlords', { siteId: siteA, supplierId: sup.id, currency: 'IDR', basis: 'fixed', fixed: 100_000, startOn: `${m3}-01` });
    await call('POST', '/v1/finance/landlords', { siteId: siteB, supplierId: sup.id, currency: 'IDR', basis: 'fixed', fixed: 400_000, startOn: `${m3}-01` });
    await call('POST', '/v1/finance/maintenance', { title: 'Cable', kind: 'corrective', siteId: siteA, currency: 'IDR', openedOn: `${m1}-05`, labourHours: 1, labourRate: 50_000, status: 'done', doneOn: `${m1}-06` });
    const pStart = `${m2}-01`, pEnd = `${Number(m2.slice(0, 4)) + 1}${m2.slice(4)}-01`;
    await call('POST', '/v1/finance/insurance/policies', { insurer: `Asuransi ${TAG}`, policyNo: `P-${TAG}`, kind: 'equipment', siteId: siteA, currency: 'IDR', cover: 100_000_000, premium: 365_000, startOn: pStart, endOn: pEnd, paidOn: pStart });
    const g = (await call('POST', '/v1/finance/grants', { grantor: 'ESDM', programme: `Build ${TAG}`, kind: 'capital', currency: 'IDR', awarded: 120_000, releaseMonths: 12, siteId: siteA })).json();
    const gc = (await call('POST', `/v1/finance/grants/${g.id}/claims`, { amount: 120_000, submit: true })).json().claims[0];
    await call('POST', `/v1/finance/grants/claims/${gc.id}`, { status: 'paid', on: `${m2}-15` });
    const r = (await call('GET', `/v1/finance/portfolio?months=1&to=${m1}`)).json();
    const a = r.sites.find((s: any) => s.siteId === siteA), b = r.sites.find((s: any) => s.siteId === siteB);
    const insM1 = ins.monthShare(365_000, pStart, pEnd, m1);
    // A: 500 000 revenue, 50 kWh × 1 500 energy, rent 100 000, maintenance 50 000, insurance, grant 10 000.
    assert.deepEqual([a.revenue, a.energyCost, a.rent, a.maintenance, a.insurance, a.grants], [500_000, 75_000, 100_000, 50_000, insM1, 10_000]);
    assert.equal(a.operating, 500_000 - 75_000 - 100_000 - 50_000 - insM1);
    assert.equal(a.contribution, a.operating + 10_000);
    assert.deepEqual([a.rank, b.rank], [1, 2]);
    assert.equal(b.signal, 'close_review', 'rent 400 000 on 100 000 of revenue');
    assert.ok(b.reasons.some((x: string) => /rent is 400%/.test(x)));
    assert.equal(r.totals.IDR.signals.close_review, 1);
    assert.equal((await call('GET', `/v1/finance/portfolio?months=1&to=${m1}&format=pdf`)).rawPayload.subarray(0, 4).toString(), '%PDF');
    assert.equal((await call('GET', `/v1/finance/portfolio?months=1&to=${m1}&format=xlsx`)).rawPayload.subarray(0, 2).toString(), 'PK');
    assert.equal((await call('GET', `/v1/finance/portfolio?to=${localDay().slice(0, 7)}`)).statusCode, 400);
  });
});

dbDescribe('Budget planning (v1.37.0)', () => {
  test('seeded from the forecast, edited, approved by a second person, published; a new version supersedes', async () => {
    const year = Number(localDay().slice(0, 4)) + 1;
    assert.equal((await call('POST', '/v1/finance/budget-plans', { year: year + 9, currency: 'IDR' })).statusCode, 422);
    const p = (await call('POST', '/v1/finance/budget-plans', { year, currency: 'IDR', seed: 'forecast', growthPct: 10 })).json();
    assert.deepEqual([p.version, p.status, p.name], [1, 'draft', `Budget ${year} v1`]);
    const sa = p.sites.find((s: any) => s.siteId === siteA);
    assert.ok(sa.revenue > 0, 'revenue from the forecast');
    assert.ok(sa.rent > 0, 'rent from the last twelve months');
    assert.equal((await call('PUT', `/v1/finance/budget-plans/${p.id}/lines`, { lines: [{ siteId: siteA, month: `${year}-01`, category: 'staff', amount: 1 }] })).statusCode, 422, 'staff is the organisation\'s');
    assert.equal((await call('PUT', `/v1/finance/budget-plans/${p.id}/lines`, { lines: [{ month: `${year + 1}-01`, category: 'staff', amount: 1 }] })).statusCode, 422);
    const e = (await call('PUT', `/v1/finance/budget-plans/${p.id}/lines`, { lines: [{ month: `${year}-01`, category: 'staff', amount: 30_000_000 }, { siteId: siteA, month: `${year}-01`, category: 'revenue', amount: 2_000_000 }] })).json();
    assert.equal(e.organisation.staff[0], 30_000_000);
    assert.equal(e.byCategory.revenue[0] >= 2_000_000, true);
    await call('POST', `/v1/finance/budget-plans/${p.id}/submit`);
    assert.equal((await call('PUT', `/v1/finance/budget-plans/${p.id}/lines`, { lines: [{ month: `${year}-02`, category: 'staff', amount: 1 }] })).statusCode, 409, 'submitted');
    assert.equal((await call('POST', `/v1/finance/budget-plans/${p.id}/decide`, { approve: true })).statusCode, 403, 'not the submitter');
    assert.equal((await as(B, () => call('POST', `/v1/finance/budget-plans/${p.id}/decide`, { approve: false }))).statusCode, 422, 'a rejection needs a note');
    const ok = (await as(B, () => call('POST', `/v1/finance/budget-plans/${p.id}/decide`, { approve: true }))).json();
    assert.equal(ok.status, 'approved');
    assert.ok(ok.published >= 12);
    const fb = await one<any>(`SELECT revenue_minor FROM finance_budget WHERE org_id = $1 AND site_id = $2 AND month = $3`, [org, siteA, `${year}-01`]);
    assert.equal(Number(fb.revenue_minor), 2_000_000);
    const v2 = (await call('POST', '/v1/finance/budget-plans', { year, currency: 'IDR', seed: 'copy', fromPlanId: p.id })).json();
    assert.equal(v2.version, 2);
    assert.equal(v2.previous.version, 1);
    await call('POST', `/v1/finance/budget-plans/${v2.id}/submit`);
    await as(B, () => call('POST', `/v1/finance/budget-plans/${v2.id}/decide`, { approve: true }));
    const list = (await call('GET', '/v1/finance/budget-plans')).json().plans.filter((x: any) => x.year === year);
    assert.deepEqual(list.map((x: any) => [x.version, x.status]), [[2, 'approved'], [1, 'superseded']]);
    assert.equal((await call('GET', `/v1/finance/budget-plans/${v2.id}?format=xlsx`)).rawPayload.subarray(0, 2).toString(), 'PK');
  });
});
