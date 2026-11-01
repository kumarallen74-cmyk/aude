import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 29 of the finance review (v1.40.0):
 *   - customer contracts: obligations recognised ratably or when delivered, billings, the contract liability, the
 *     contracts journal, renewals;
 *   - intercompany netting across the group through the parent, settling every pair; the transfer-pricing policy and
 *     the check of each recharge's mark-up;
 *   - finance data quality: the checks, the score, the alert, a record's history;
 *   - scenarios: new sites with capex and a ramp, cash and runway, a covenant on the lowest cash, sensitivity.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase29.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const rc = await import('./revenue-contracts.js');
const icn = await import('./ic-netting.js');
const dq = await import('./data-quality.js');
const sc = await import('./scenarios.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID();
let org = '', s1 = '', s2 = '', orgS = '', orgQ = '';
let app: FastifyInstance;
let principalOrg = '';
let bank = '';
const zone = config.billing.timeZone;
const localDay = (t: number = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(t));
const monthsBack = (n: number) => {
  let [y, m] = localDay().slice(0, 7).split('-').map(Number) as [number, number];
  for (let i = 0; i < n; i++) { m--; if (m === 0) { m = 12; y--; } }
  return `${y}-${String(m).padStart(2, '0')}`;
};
const addMonths = (m: string, k: number) => { const [y, mo] = m.split('-').map(Number) as [number, number]; const t = y * 12 + mo - 1 + k; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const lastDay = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });
const asOrg = async <T>(o: string, fn: () => Promise<T>) => { const p = principalOrg; principalOrg = o; try { return await fn(); } finally { principalOrg = p; } };
const M = 1_000_000;

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Group ${TAG}`, `p29-${TAG}`]))!.id;
    s1 = (await one<{ id: string }>(`INSERT INTO organisation (name, slug, parent_org_id) VALUES ($1, $2, $3) RETURNING id`, [`Sub One ${TAG}`, `p29-a-${TAG}`, org]))!.id;
    s2 = (await one<{ id: string }>(`INSERT INTO organisation (name, slug, parent_org_id) VALUES ($1, $2, $3) RETURNING id`, [`Sub Two ${TAG}`, `p29-b-${TAG}`, org]))!.id;
    orgS = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Plans ${TAG}`, `p29-s-${TAG}`]))!.id;
    orgQ = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Quality ${TAG}`, `p29-q-${TAG}`]))!.id;
    await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, 'Rina')`, [A, org, `${A.slice(0, 8)}@p29.test`]);
    bank = (await one<{ id: string }>(`INSERT INTO cash_account (org_id, name, kind, currency, opening_balance_minor, opening_on) VALUES ($1, 'Operating', 'bank', 'IDR', 0, $2) RETURNING id`, [org, `${monthsBack(12)}-01`]))!.id;
    principalOrg = org;
    app = Fastify({ bodyLimit: 6 * 1024 * 1024 });
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: A, orgId: principalOrg, assignments: [{ permissions: ['payment:read', 'payment:write', 'finance:approve'], scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
  });
  after(async () => {
    await app?.close();
    const os = [org, s1, s2, orgS, orgQ];
    await query(`DELETE FROM gl_line WHERE org_id = ANY($1::uuid[])`, [os]);
    for (const t of ['contract_billing', 'contract_obligation', 'customer_contract', 'intercompany_recharge', 'intercompany_settlement', 'tp_policy', 'dq_run', 'finance_scenario', 'covenant',
      'supplier_bill', 'supplier', 'gl_entry', 'gl_account', 'cash_balance', 'finance_org_settings']) await query(`DELETE FROM ${t} WHERE org_id = ANY($1::uuid[])`, [os]);
    await query(`DELETE FROM cash_account WHERE org_id = ANY($1::uuid[])`, [os]);
    await query(`DELETE FROM alert WHERE org_id = ANY($1::uuid[])`, [os]);
    await query(`DELETE FROM app_user WHERE org_id = ANY($1::uuid[])`, [os]).catch(() => { /* audit rows keep them */ });
    for (const o of [s1, s2, orgS, orgQ, org]) await query(`DELETE FROM organisation WHERE id = $1`, [o]).catch(() => { /* audit rows keep it */ });
    await pool.end();
  });
}

describe('Contract, netting, transfer pricing, data quality and scenario helpers', () => {
  test('recognition, the netting centre, mark-ups, the score and the projection', () => {
    const sub = { amount: 1_200_000, recognition: 'ratably' as const, startMonth: '2026-01', endMonth: '2026-12', deliveredOn: null };
    assert.equal(rc.recognisedIn(sub, '2026-03'), 100_000);
    assert.equal(rc.recognisedTo(sub, '2026-03'), 300_000);
    assert.equal(rc.recognisedTo(sub, '2027-05'), 1_200_000);
    assert.deepEqual(['2026-01', '2026-02', '2026-03'].map((m) => rc.recognisedIn({ ...sub, amount: 1000, endMonth: '2026-03' }, m)), [333, 333, 334]);
    assert.equal(rc.recognisedIn({ ...sub, recognition: 'point_in_time', deliveredOn: '2026-02-15' }, '2026-02'), 1_200_000);
    assert.deepEqual(icn.viaCentre([{ orgId: 'p', name: 'P', net: 300 }, { orgId: 'a', name: 'A', net: -500 }, { orgId: 'b', name: 'B', net: 200 }], 'p'), [{ from: 'a', to: 'p', amount: 500 }, { from: 'p', to: 'b', amount: 200 }]);
    const pol = { method: 'cost_plus', minPct: 5, maxPct: 10 };
    assert.deepEqual(icn.tpStatus(1100, 1000, pol), { markupPct: 10, status: 'ok' });
    assert.equal(icn.tpStatus(1200, 1000, pol).status, 'above');
    assert.equal(icn.tpStatus(1020, 1000, pol).status, 'below');
    assert.equal(icn.tpStatus(1020, null, pol).status, 'no_cost');
    assert.equal(icn.tpStatus(1020, null, { method: 'cup', minPct: 0, maxPct: 0 }).status, 'ok');
    assert.equal(icn.tpStatus(1020, 1000, null).status, 'unclassified');
    assert.equal(dq.normaliseName('PT. Daya Instalasi Prima, Tbk'), 'daya instalasi prima');
    assert.equal(dq.scoreOf([...Array(2)].map(() => ({ check: 'unbalanced_entry' })).concat([...Array(6)].map(() => ({ check: 'duplicate_supplier' })))).score, 55, '30 and 15, each capped');
    const base = { months: ['2026-01', '2026-02', '2026-03'], revenue: [1000, 1000, 1000], energy: [400, 400, 400], opex: 300, cash: 1000, debtService: 100, interest: 0, debt: 0 };
    assert.deepEqual(sc.project(base, sc.ZERO).rows.map((r) => r.cash), [1200, 1400, 1600]);
    assert.equal(sc.project(base, { ...sc.ZERO, tariffPct: 10 }).rows[0]!.ebitda, 400);
    const p = sc.project(base, { ...sc.ZERO, newSites: [{ fromMonth: '2026-02', count: 1, capexPerSite: 2000, revenuePerSiteMonth: 600, opexPerSiteMonth: 100, rampMonths: 2 }] });
    assert.deepEqual(p.rows.map((r) => [r.revenue, r.energy, r.opex, r.capex, r.cash]), [[1000, 400, 300, 0, 1200], [1300, 520, 400, 2000, -520], [1600, 640, 400, 0, -60]]);
    assert.deepEqual([p.minCash, p.minCashMonth, p.runwayMonths], [-520, '2026-02', 1]);
    assert.equal(sc.sensitivity(base, sc.ZERO)[0]!.driver, 'tariffPct', 'revenue moves most');
    assert.throws(() => sc.assumptionsOf({ tariffPct: 1000 }), /tariffPct/);
  });
});

dbDescribe('Customer contracts (v1.40.0)', () => {
  test('obligations, billings, the contract liability, the journal and renewals', async () => {
    const S = monthsBack(10), start = `${S}-01`, end = lastDay(addMonths(S, 11));
    const c = await call('POST', '/v1/finance/contracts', { customer: 'PT Armada Logistik', currency: 'IDR', startOn: start, endOn: end, obligations: [{ description: 'Charging-as-a-service, 12 months', kind: 'subscription', amount: 1_200_000, recognition: 'ratably' }, { description: 'Wallbox, 2 units', kind: 'hardware', amount: 500_000, recognition: 'point_in_time' }] });
    assert.equal(c.statusCode, 201, c.body);
    const ct = c.json();
    assert.deepEqual([ct.number, ct.value, ct.obligations[0].startMonth, ct.obligations[0].endMonth], ['CT-00001', 1_700_000, S, addMonths(S, 11)]);
    assert.equal((await call('POST', `/v1/finance/contracts/${ct.id}/obligations`, { description: 'x', kind: 'service', amount: 1, recognition: 'ratably', startMonth: S, endMonth: monthsBack(11) })).statusCode, 422);
    const hw = ct.obligations.find((o: any) => o.kind === 'hardware').id;
    await call('PUT', `/v1/finance/contracts/${ct.id}/obligations/${hw}`, { deliveredOn: `${monthsBack(9)}-15` });
    let g = (await call('POST', `/v1/finance/contracts/${ct.id}/billings`, { billedOn: `${S}-05`, amount: 1_700_000, reference: 'INV-ARM-01' })).json();
    const bid = g.billings[0].id;
    g = (await call('POST', `/v1/finance/contracts/${ct.id}/billings/${bid}/paid`, { paidOn: `${S}-20`, cashAccountId: bank })).json();
    assert.deepEqual([g.recognised, g.billed, g.paid, g.contractLiability, g.contractAsset, g.remaining], [1_600_000, 1_700_000, 1_700_000, 100_000, 0, 100_000], '11 months of 100 000 and the wallbox');
    assert.deepEqual(g.schedule[0], { month: S, recognised: 100_000, billed: 1_700_000, contractLiability: 1_600_000, contractAsset: 0 });
    const j = (await rc.journal(org, S)).IDR!;
    const sum = (a: string, k: 'debit' | 'credit') => j.filter((l) => l.account === a).reduce((x, l) => x + l[k], 0);
    assert.deepEqual([sum('1370', 'debit'), sum('2280', 'credit'), sum('2280', 'debit'), sum('4500', 'credit'), sum('1100', 'debit'), sum('1370', 'credit')], [1_700_000, 1_700_000, 100_000, 100_000, 1_700_000, 1_700_000]);
    assert.equal((await rc.journal(org, monthsBack(9))).IDR!.filter((l) => l.account === '4500').reduce((x, l) => x + l.credit, 0), 600_000);
    assert.equal((await call('POST', `/v1/finance/contracts/${ct.id}/billings/${bid}/void`)).statusCode, 409, 'paid');

    const t = localDay();
    const r2 = (await call('POST', '/v1/finance/contracts', { customer: 'Mall Kelapa', currency: 'IDR', startOn: addDays(t, -300), endOn: addDays(t, 30), renewalNoticeDays: 60 })).json();
    await rc.sweep();
    assert.ok(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'finance.contract_renewal_due' AND target_id = $2 AND resolved_at IS NULL`, [org, r2.id]));
    assert.equal((await call('PUT', `/v1/finance/contracts/${r2.id}`, { endOn: addDays(t, 395) })).json().endOn, addDays(t, 395));
    assert.equal(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'finance.contract_renewal_due' AND target_id = $2 AND resolved_at IS NULL`, [org, r2.id]), null, 'renewed');
    const l = (await call('GET', '/v1/finance/contracts')).json();
    assert.equal(l.totals.IDR.contractLiability, 100_000);
    assert.equal((await call('GET', '/v1/finance/contracts?format=xlsx')).statusCode, 200);
  });
});

dbDescribe('Intercompany netting and transfer pricing (v1.40.0)', () => {
  test('the group nets through the parent; every pair settled; mark-ups against the policy', async () => {
    const m = localDay().slice(0, 7);
    const rech = async (from: string, to: string, amt: number, n: string) => (await one<{ id: string }>(
      `INSERT INTO intercompany_recharge (org_id, to_org_id, number, month, description, basis, amount_minor, currency, status, issued_at) VALUES ($1, $2, $3, $4, 'Shared costs', 'fixed', $5, 'IDR', 'issued', now()) RETURNING id`, [from, to, `IC-${TAG}-${n}`, m, amt]))!.id;
    const r1 = await rech(org, s1, 1_000_000, '1'), r2 = await rech(s1, org, 300_000, '2');
    await rech(s1, s2, 200_000, '3');
    const r4 = await rech(s2, org, 400_000, '4');
    const n = (await call('GET', '/v1/finance/intercompany/netting')).json();
    const c = n.currencies.find((x: any) => x.currency === 'IDR');
    const pos = (o: string) => c.positions.find((p: any) => p.orgId === o).net;
    assert.deepEqual([c.gross, pos(org), pos(s1), pos(s2), c.bilateralTransfers], [1_900_000, 300_000, -500_000, 200_000, 3]);
    assert.deepEqual(c.transfers.map((t: any) => [t.fromName, t.toName, t.amount]), [[`Sub One ${TAG}`, `Group ${TAG}`, 500_000], [`Group ${TAG}`, `Sub Two ${TAG}`, 200_000]]);

    assert.equal((await asOrg(s1, () => call('PUT', '/v1/finance/intercompany/transfer-pricing/policies', { kind: 'management_fee', method: 'cost_plus', markupPct: 7, minPct: 5, maxPct: 10 }))).statusCode, 403, 'the parent sets it');
    assert.equal((await call('PUT', '/v1/finance/intercompany/transfer-pricing/policies', { kind: 'management_fee', method: 'cost_plus', markupPct: 7, minPct: 5, maxPct: 10 })).statusCode, 200);
    assert.equal((await call('PUT', `/v1/finance/intercompany/recharges/${r1}/tp`, { tpKind: 'management_fee', cost: 920_000 })).statusCode, 200);
    assert.equal((await call('PUT', `/v1/finance/intercompany/recharges/${r2}/tp`, { tpKind: 'management_fee', cost: 250_000 })).statusCode, 404, 'the charging entity classifies it');
    await icn.setRechargeTp(s1, String(r2), { tpKind: 'management_fee', cost: 250_000 });
    await icn.setRechargeTp(s2, String(r4), { tpKind: 'it_services', cost: 400_000 });
    const tp = (await call('GET', '/v1/finance/intercompany/transfer-pricing')).json();
    const it = (id: string) => tp.items.find((x: any) => x.id === String(id));
    assert.deepEqual([it(r1).markupPct, it(r1).status, it(r2).markupPct, it(r2).status, it(r4).status], [8.7, 'ok', 20, 'above', 'unclassified']);
    assert.deepEqual(tp.summary, { total: 4, ok: 1, below: 0, above: 1, noCost: 0, unclassified: 2 });
    assert.equal((await call('GET', '/v1/finance/intercompany/transfer-pricing?format=xlsx')).statusCode, 200);

    assert.equal((await asOrg(s1, () => call('POST', '/v1/finance/intercompany/netting/settle', { currency: 'IDR' }))).statusCode, 403);
    const st = (await call('POST', '/v1/finance/intercompany/netting/settle', { currency: 'IDR' })).json();
    assert.equal(st.settlements.length, 3);
    assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM intercompany_recharge WHERE number LIKE $1 AND status = 'issued'`, [`IC-${TAG}-%`]))!.n, 0);
    assert.equal((await call('GET', '/v1/finance/intercompany/netting')).json().currencies.length, 0);
  });
});

dbDescribe('Finance data quality (v1.40.0)', () => {
  test('the checks, the score and its alert, and a record history', async () => {
    await query(`INSERT INTO gl_account (org_id, code, name, type) VALUES ($1, '1100', 'Bank', 'asset')`, [orgQ]);
    for (const k of [1, 2]) {
      const e = (await one<{ id: string }>(`INSERT INTO gl_entry (org_id, number, entry_date, month, currency, source, memo, status, posted_at) VALUES ($1, $2, $3, $4, 'IDR', 'manual', 'x', 'posted', now()) RETURNING id`, [orgQ, `JE-Q-${TAG}-${k}`, localDay(), localDay().slice(0, 7)]))!.id;
      await query(`INSERT INTO gl_line (org_id, entry_id, account_code, debit, credit) VALUES ($1, $2, '1100', 100, 0), ($1, $2, '4100', 0, 90)`, [orgQ, e]);
    }
    const sup = async (name: string, tax: string | null) => (await one<{ id: string }>(`INSERT INTO supplier (org_id, name, tax_id) VALUES ($1, $2, $3) RETURNING id`, [orgQ, name, tax]))!.id;
    const a = await sup('PT Daya Prima', '01.234.567.8-901.000');
    await sup('Daya Prima Tbk', null);
    await query(`INSERT INTO supplier_bill (org_id, supplier_id, number, category, description, currency, subtotal_minor, vat_minor, wht_minor, bill_date, due_date, status) VALUES ($1, $2, 'EN-1', 'energy', 'PLN', 'IDR', 1000, 0, 0, $3, $3, 'approved')`, [orgQ, a, localDay()]);
    await query(`INSERT INTO cash_account (org_id, name, kind, currency, opening_balance_minor, opening_on) VALUES ($1, 'Old account', 'bank', 'IDR', 0, $2)`, [orgQ, addDays(localDay(), -60)]);
    const r = await asOrg(orgQ, () => call('POST', '/v1/finance/data-quality/run'));
    assert.equal(r.statusCode, 201, r.body);
    const x = r.json();
    assert.deepEqual(x.counts, { unbalanced_entry: 2, unknown_account: 1, duplicate_supplier: 1, supplier_incomplete: 1, bill_no_site: 1, stale_cash_balance: 1 });
    assert.equal(x.score, 100 - 30 - 5 - 3 - 1 - 1 - 3);
    assert.ok(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'finance.data_quality_low' AND resolved_at IS NULL`, [orgQ]), 'under 70');
    const o = (await asOrg(orgQ, () => call('GET', '/v1/finance/data-quality'))).json();
    assert.equal(o.last.score, x.score);

    const s = (await call('POST', '/v1/finance/scenarios', { name: 'History check', assumptions: { tariffPct: 5 } })).json();
    await call('PUT', `/v1/finance/scenarios/${s.id}`, { assumptions: { tariffPct: 8 } });
    const h = (await call('GET', `/v1/finance/history?targetType=finance_scenario&targetId=${s.id}`)).json();
    assert.deepEqual(h.changes.map((c: any) => c.action), ['finance.scenario_updated', 'finance.scenario_created']);
    assert.equal(h.changes[1].by, 'Rina');
    assert.equal((await call('GET', '/v1/finance/history?targetType=DROP;&targetId=1')).statusCode, 400);
    await call('PUT', `/v1/finance/scenarios/${s.id}`, { archive: true });
  });
});

dbDescribe('Scenario planning (v1.40.0)', () => {
  test('new sites with capex and a ramp; cash, runway and a covenant; compare and sensitivity', async () => {
    await query(`INSERT INTO cash_account (org_id, name, kind, currency, opening_balance_minor, opening_on) VALUES ($1, 'Operating', 'bank', 'IDR', $2, $3)`, [orgS, 10 * M, `${monthsBack(1)}-01`]);
    const ld = await import('./lenders.js');
    await ld.saveCovenant(orgS, null, { kind: 'min_cash', threshold: 5 * M, currency: 'IDR' });
    const m0 = localDay().slice(0, 7);
    const s = await asOrg(orgS, () => call('POST', '/v1/finance/scenarios', { name: 'Two new sites', currency: 'IDR', assumptions: { newSites: [{ fromMonth: m0, count: 2, capexPerSite: 5 * M, revenuePerSiteMonth: 3 * M, opexPerSiteMonth: 500_000, rampMonths: 2 }] } }));
    assert.equal(s.statusCode, 201, s.body);
    assert.equal((await asOrg(orgS, () => call('POST', '/v1/finance/scenarios', { name: 'Bad', assumptions: { tariffPct: 1000 } }))).statusCode, 422);
    const c = (await asOrg(orgS, () => call('GET', `/v1/finance/scenarios?sensitivityOf=${s.json().id}`))).json();
    const [base, sites] = c.scenarios;
    assert.deepEqual([base.name, base.minCash, base.covenants[0].passed], ['Base', 10 * M, true]);
    assert.deepEqual(sites.rows.slice(0, 2).map((r: any) => [r.revenue, r.opex, r.capex, r.cash]), [[3 * M, 1 * M, 10 * M, 2 * M], [6 * M, 1 * M, 0, 7 * M]]);
    assert.deepEqual([sites.minCash, sites.minCashMonth, sites.runwayMonths, sites.covenants[0].passed], [2 * M, m0, null, false], 'the lowest cash breaks the 5 million covenant');
    assert.equal(c.sensitivity.of, 'Two new sites');
    assert.equal(c.sensitivity.drivers.length, 4);
    assert.equal((await asOrg(orgS, () => call('GET', '/v1/finance/scenarios?format=xlsx'))).statusCode, 200);
  });
});
