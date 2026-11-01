import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 23 of the finance review (v1.34.0):
 *   - inventory: items, locations, receipts at a price re-averaging the cost, issues to a work order, transfers, counts,
 *     never below zero; the reorder alert; the inventory journal;
 *   - maintenance: a work order's labour, parts and contractor bill; the accrual until billed; warranty claimed and paid;
 *     costs per charger and per kWh;
 *   - revenue assurance: unbilled, zero-amount, energy-mismatch, meter-mismatch and price-outlier sessions found once,
 *     reviewed (recovered, written off), dismissed when corrected;
 *   - lenders: a loan drawn and repaid on its schedule, the ledger and cash position, covenants tested from the ledger
 *     (DSCR, leverage, minimum cash) with a breach alert; the lender pack.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase23.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const lend = await import('./lenders.js');
const assure = await import('./revenue-assurance.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID(), B = randomUUID();
let org = '';
let app: FastifyInstance;
let principalUser: string = A;
let site = '', cp = '', conn = '';
const zone = config.billing.timeZone;
const localDay = (t: number = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(t));
const monthsBack = (n: number) => {
  let [y, m] = localDay().slice(0, 7).split('-').map(Number) as [number, number];
  for (let i = 0; i < n; i++) { m--; if (m === 0) { m = 12; y--; } }
  return `${y}-${String(m).padStart(2, '0')}`;
};
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });
const as = async <T>(user: string, fn: () => Promise<T>) => { const u = principalUser; principalUser = user; try { return await fn(); } finally { principalUser = u; } };

/** A session in a month (the 10th, 10:00 local) with energy, and a charge record unless total is null. */
async function session(month: string, wh: number, total: number | null, o: { kwhBilled?: number; meter?: [number, number]; day?: number } = {}) {
  const start = new Date(`${month}-${String(o.day ?? 10).padStart(2, '0')}T10:00:00+07:00`);
  const id = (await one<{ id: string }>(
    `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, ended_at, duration_s, energy_wh, state, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 3600, $8, $9, 'IDR') RETURNING id`, [org, site, conn, cp, `p23-${randomUUID()}`, start, new Date(start.getTime() + 3_600_000), wh, total == null ? 'ended' : 'rated']))!.id;
  if (total != null) {
    const lines = [{ kind: 'energy', description: 'Energy', quantity: o.kwhBilled ?? wh / 1000, unit: 'kWh', unitRate: 2500, amountMinor: total }];
    await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency)
                 VALUES ($1, $2, $3, $4, $5, 0, 0, $5, 0, 0, $5, '{}', 'IDR')`, [id, org, start, JSON.stringify(lines), total]);
  }
  if (o.meter) for (const [k, v] of o.meter.entries()) await query(`INSERT INTO meter_value (session_id, ts, measurand, value, unit) VALUES ($1, $2, 'Energy.Active.Import.Register', $3, 'Wh')`, [id, new Date(start.getTime() + k * 3_000_000), v]);
  return id;
}

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Spares ${TAG}`, `p23-${TAG}`]))!.id;
    for (const [u, n] of [[A, 'Rina'], [B, 'Budi']] as const) await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, $4)`, [u, org, `${u.slice(0, 8)}@p23.test`, n]);
    site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'ID') RETURNING id`, [org, `Rest area ${TAG}`]))!.id;
    cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name) VALUES ($1, $2, $2) RETURNING id`, [site, `P23-${TAG}`]))!.id;
    const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [cp]))!.id;
    conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, max_power_w) VALUES ($1, 60000) RETURNING id`, [e]))!.id;
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
    for (const t of ['covenant_test', 'covenant', 'loan_payment', 'loan_drawdown', 'loan', 'revenue_finding', 'warranty_claim', 'stock_move', 'supplier_payment', 'supplier_bill', 'work_order', 'stock_item', 'stock_location',
      'purchase_order_line', 'purchase_order', 'gl_entry', 'gl_account', 'supplier', 'cash_transfer', 'cash_balance', 'cash_account', 'finance_org_settings']) await query(`DELETE FROM ${t} WHERE org_id = ANY($1::uuid[])`, [o]);
    await query(`DELETE FROM meter_value WHERE session_id IN (SELECT id FROM charging_session WHERE org_id = $1)`, [org]);
    await query(`DELETE FROM cdr WHERE org_id = $1`, [org]);
    await query(`DELETE FROM charging_session WHERE org_id = $1`, [org]);
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

describe('Lender and assurance helpers', () => {
  test('schedules (annuity, equal principal, bullet, grace); covenant evaluation; median', () => {
    const a = lend.schedule(12_000_000, 12, '2026-01-15', 12, 0, 'annuity');
    assert.equal(a.length, 12);
    assert.equal(a.at(-1)!.closing, 0);
    assert.equal(a.reduce((s, r) => s + r.principal, 0), 12_000_000);
    assert.equal(a[0]!.interest, 120_000);
    assert.ok(Math.abs(a[0]!.payment - a[5]!.payment) <= 2, 'level payments');
    const g = lend.schedule(6_000_000, 6, '2026-01-01', 6, 2, 'equal_principal');
    assert.deepEqual(g.slice(0, 2).map((r) => r.principal), [0, 0], 'interest only in the grace months');
    assert.equal(g[2]!.principal, 1_500_000);
    const bl = lend.schedule(5_000_000, 10, '2026-01-01', 4, 0, 'bullet');
    assert.deepEqual(bl.map((r) => r.principal), [0, 0, 0, 5_000_000]);
    const m = { ebitda: 1_200_000, interest: 200_000, debtService: 800_000, debt: 3_000_000, cash: 500_000 };
    assert.deepEqual(lend.evaluate('dscr', 1.25, m), { value: 1.5, passed: true, headroomPct: 20 });
    assert.equal(lend.evaluate('leverage', 2, m).passed, false, '2.5× is above 2×');
    assert.equal(lend.evaluate('interest_cover', 3, m).value, 6);
    assert.equal(lend.evaluate('min_cash', 1_000_000, m).passed, false);
    assert.equal(lend.evaluate('dscr', 1.25, { ...m, debtService: 0 }).value, null, 'nothing to cover');
    assert.equal(assure.median([5, 1, 3]), 3);
    assert.equal(assure.median([4, 1, 3, 2]), 2.5);
  });
});

dbDescribe('Inventory and maintenance', () => {
  test('received, averaged, issued to a work order, transferred, counted; costs, accrual, warranty; the ledger', async () => {
    const m = monthsBack(1);
    const depot = (await call('POST', '/v1/finance/inventory/locations', { name: `Depot ${TAG}` })).json();
    const van = (await call('POST', '/v1/finance/inventory/locations', { name: `Van ${TAG}`, siteId: site })).json();
    const sup = (await call('POST', '/v1/finance/suppliers', { name: `Parts ${TAG}` })).json();
    const item = (await call('POST', '/v1/finance/inventory/items', { sku: `CBL-${TAG}`, name: 'CCS2 cable 5 m', currency: 'IDR', reorderPoint: 2, reorderQty: 4, supplierId: sup.id })).json();
    assert.equal((await call('POST', '/v1/finance/inventory/items', { sku: `CBL-${TAG}`, name: 'Again', currency: 'IDR' })).statusCode, 409);
    const mv = (b: Record<string, unknown>) => call('POST', '/v1/finance/inventory/moves', { itemId: item.id, locationId: depot.id, onDate: `${m}-05`, ...b });
    assert.equal((await mv({ kind: 'issue', qty: 1 })).statusCode, 422, 'nothing on hand');
    await mv({ kind: 'receipt', qty: 4, unitCost: 3_000_000 });
    assert.equal((await mv({ kind: 'receipt', qty: 2, unitCost: 3_600_000 })).json().avgCost, 3_200_000, '(12 + 7.2) ÷ 6 million');

    const wo = (await call('POST', '/v1/finance/maintenance', { title: 'Replace damaged cable', chargePointId: cp, openedOn: `${m}-06`, labourHours: 3, labourRate: 150_000, contractorEstimate: 800_000 })).json();
    assert.match(wo.number, /^WO-\d{5}$/);
    assert.equal(wo.site, `Rest area ${TAG}`);
    const iss = await mv({ kind: 'issue', qty: 1, workOrderId: wo.id });
    assert.equal(iss.json().value, 3_200_000);
    await mv({ kind: 'transfer', qty: 2, toLocationId: van.id });
    assert.equal((await mv({ kind: 'adjust', countedQty: 2 })).statusCode, 422, 'a note is needed');
    const cnt = (await mv({ kind: 'adjust', countedQty: 2, note: 'Counted at month end' })).json();
    assert.deepEqual([cnt.difference, cnt.value], [-1, -3_200_000]);
    const ov = (await call('GET', '/v1/finance/inventory')).json();
    const it = ov.items.find((x: any) => x.id === item.id);
    assert.deepEqual([it.onHand, it.value, it.belowReorder], [4, 12_800_000, false]);
    assert.equal(ov.balances.find((b: any) => b.itemId === item.id && b.locationId === van.id).qty, 2);

    const done = (await call('PUT', `/v1/finance/maintenance/${wo.id}`, { status: 'done', doneOn: `${m}-07` })).json();
    assert.deepEqual([done.cost.labour, done.cost.parts, done.cost.accrual, done.cost.total], [450_000, 3_200_000, 800_000, 4_450_000]);
    await call('POST', `/v1/finance/ledger/sync/${m}`);
    const l1 = (await call('GET', `/v1/finance/ledger?month=${m}&currency=IDR`)).json();
    const bal = (side: 'assets' | 'liabilities', code: string) => l1.balanceSheet[side].find((x: any) => x.code === code)?.amount ?? 0;
    const exp = (code: string) => l1.profitAndLoss.month.expense.find((x: any) => x.code === code)?.amount ?? 0;
    assert.equal(bal('assets', '1700'), 12_800_000, 'inventory at cost');
    assert.equal(bal('liabilities', '2105'), 19_200_000, 'goods received not invoiced');
    assert.deepEqual([exp('6260'), exp('6265'), exp('6270'), exp('6200')], [3_200_000, 3_200_000, 450_000, 800_000]);
    assert.equal(l1.trialBalance.balanced, true);

    // The supplier's bill for the stock clears goods received not invoiced; the contractor's bill replaces the accrual.
    const sb = (await call('POST', '/v1/finance/bills', { supplierId: sup.id, number: `PB-${TAG}`, category: 'equipment', description: 'Cables', subtotal: 19_200_000, billDate: `${m}-08`, currency: 'IDR' })).json();
    assert.equal((await call('POST', `/v1/finance/bills/${sb.id}/links`, { stock: true })).json().stock, true);
    await as(B, () => call('POST', `/v1/finance/bills/${sb.id}/approve`));
    const cb = (await call('POST', '/v1/finance/bills', { supplierId: sup.id, number: `CB-${TAG}`, category: 'maintenance', description: 'Cable fitting', subtotal: 750_000, billDate: `${m}-20`, currency: 'IDR' })).json();
    assert.equal((await call('POST', `/v1/finance/bills/${cb.id}/links`, { workOrderId: wo.id })).statusCode, 200);
    await as(B, () => call('POST', `/v1/finance/bills/${cb.id}/approve`));
    const w2 = (await call('GET', `/v1/finance/maintenance/${wo.id}`)).json();
    assert.deepEqual([w2.cost.contractor, w2.cost.accrual, w2.bills.length], [750_000, 0, 1]);
    await call('POST', `/v1/finance/ledger/sync/${m}`);
    const l2 = (await call('GET', `/v1/finance/ledger?month=${m}&currency=IDR`)).json();
    assert.equal(l2.balanceSheet.liabilities.find((x: any) => x.code === '2105')?.amount ?? 0, 0);
    assert.equal(l2.balanceSheet.liabilities.find((x: any) => x.code === '2110')?.amount ?? 0, 0, 'no accrual once billed');

    const cl = (await call('POST', `/v1/finance/maintenance/${wo.id}/claims`, { supplierId: sup.id, amount: 3_200_000, reference: 'RMA-1' })).json();
    const claimId = cl.claims[0].id;
    await call('POST', `/v1/finance/maintenance/claims/${claimId}`, { status: 'accepted' });
    const paid = (await call('POST', `/v1/finance/maintenance/claims/${claimId}`, { status: 'paid', on: `${m}-25` })).json();
    assert.equal(paid.cost.recovered, 3_200_000);
    assert.equal(paid.cost.net, 450_000 + 3_200_000 + 750_000 - 3_200_000);
    await session(m, 50_000, 125_000);
    const costs = (await call('GET', `/v1/finance/maintenance/costs?from=${m}-01&to=${m}-28`)).json();
    const row = costs.chargers.find((x: any) => x.chargePointId === cp);
    assert.deepEqual([row.orders, row.net, row.kwh], [1, 1_200_000, 50]);
    assert.equal(row.perKwh, 24_000);
    assert.equal((await call('GET', `/v1/finance/maintenance/costs?format=xlsx`)).rawPayload.subarray(0, 2).toString(), 'PK');

    // Reorder: issue down to the point.
    await call('POST', '/v1/finance/inventory/moves', { itemId: item.id, locationId: depot.id, kind: 'issue', qty: 2, onDate: localDay() });
    await (await import('./inventory.js')).sweep();
    assert.equal((await many(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'finance.stock_reorder' AND resolved_at IS NULL`, [org])).length, 1);
  });
});

dbDescribe('Revenue assurance', () => {
  test('unbilled, zero, energy, meter and price findings; reviewed; corrected ones dismissed', async () => {
    const m = monthsBack(2);
    for (let k = 0; k < 10; k++) await session(m, 20_000, 50_000, { day: 1 + k });
    const unbilled = await session(m, 15_000, null, { day: 12 });
    const zero = await session(m, 8_000, 0, { day: 13 });
    const energy = await session(m, 30_000, 75_000, { day: 14, kwhBilled: 20 });
    const meter = await session(m, 10_000, 25_000, { day: 15, meter: [100_000, 125_000] });
    const cheap = await session(m, 40_000, 20_000, { day: 16 });
    const r1 = (await call('POST', '/v1/finance/assurance/run', { month: m })).json();
    assert.equal(r1.added, 5, JSON.stringify(r1));
    const l = (await call('GET', `/v1/finance/assurance?month=${m}`)).json();
    const f = (kind: string, sid: string) => l.findings.find((x: any) => x.kind === kind && x.sessionId === sid);
    assert.equal(f('unbilled', unbilled).expected, 37_500, '15 kWh at the 2 500 median');
    assert.equal(f('zero_amount', zero).expected, 20_000);
    assert.equal(f('energy_mismatch', energy).expected, 112_500, 'billed 20 kWh of 30');
    assert.equal(f('meter_mismatch', meter).detail.meterWh, 25_000);
    assert.equal(f('price_outlier', cheap).gap, 80_000);
    assert.equal(l.summary.IDR.open, 5);
    assert.equal(l.summary.IDR.leakage, 37_500 + 20_000 + 37_500 + 37_500 + 80_000);
    assert.equal((await call('POST', '/v1/finance/assurance/run', { month: m })).json().added, 0, 'found once');

    assert.equal((await call('POST', `/v1/finance/assurance/findings/${f('zero_amount', zero).id}`, { status: 'written_off' })).statusCode, 422, 'a note');
    await call('POST', `/v1/finance/assurance/findings/${f('zero_amount', zero).id}`, { status: 'written_off', note: 'Test session by the installer' });
    const rec = (await call('POST', `/v1/finance/assurance/findings/${f('unbilled', unbilled).id}`, { status: 'recovered', recovered: 37_500, note: 'Invoiced to the fleet' })).json();
    assert.deepEqual([rec.status, rec.recovered], ['recovered', 37_500]);
    // The cheap session is re-billed: no longer an outlier, the open finding is dismissed.
    await query(`UPDATE cdr SET total_minor = 100000, subtotal_minor = 100000 WHERE session_id = $1`, [cheap]);
    const r2 = (await call('POST', '/v1/finance/assurance/run', { month: m })).json();
    assert.equal(r2.cleared, 1);
    const l2 = (await call('GET', `/v1/finance/assurance?month=${m}`)).json();
    assert.equal(l2.findings.find((x: any) => x.sessionId === cheap).status, 'dismissed');
    assert.equal(l2.findings.find((x: any) => x.sessionId === unbilled).status, 'recovered', 'the review kept');
    assert.deepEqual([l2.summary.IDR.recovered, l2.summary.IDR.writtenOff], [37_500, 20_000]);
    assert.equal((await call('GET', `/v1/finance/assurance?month=${m}&format=xlsx`)).rawPayload.subarray(0, 2).toString(), 'PK');
  });
});

dbDescribe('Loans and covenants', () => {
  test('drawn and repaid, the ledger and the cash position; covenants tested with a breach; the lender pack', async () => {
    const m = monthsBack(1);
    const bank = (await call('POST', '/v1/finance/cash/accounts', { name: `Loan account ${TAG}`, kind: 'bank', currency: 'IDR', openingBalance: 1_000_000, openingOn: `${monthsBack(3)}-01` })).json();
    assert.equal((await call('POST', '/v1/finance/lenders/loans', { lender: 'Bank X', currency: 'IDR', facility: 0, ratePct: 10, startOn: `${m}-01`, termMonths: 24 })).statusCode, 422);
    const loan = (await call('POST', '/v1/finance/lenders/loans', { lender: `Bank Mandiri ${TAG}`, currency: 'IDR', facility: 1_200_000_000, ratePct: 9, startOn: `${m}-01`, termMonths: 24, graceMonths: 3, repayment: 'annuity', cashAccountId: bank.id })).json();
    assert.equal((await call('POST', `/v1/finance/lenders/loans/${loan.id}/drawdowns`, { amount: 1_300_000_000 })).statusCode, 422, 'above the facility');
    const d = (await call('POST', `/v1/finance/lenders/loans/${loan.id}/drawdowns`, { amount: 1_000_000_000, onDate: `${m}-02` })).json();
    assert.deepEqual([d.drawn, d.balance, d.undrawn], [1_000_000_000, 1_000_000_000, 200_000_000]);
    assert.equal(d.schedule[0].interest, 7_500_000);
    assert.equal(d.schedule[2].principal, 0, 'grace');
    assert.ok(d.schedule[3].principal > 0);
    const p = (await call('POST', `/v1/finance/lenders/loans/${loan.id}/payments`, { principal: 0, interest: 7_500_000, onDate: `${m}-28` })).json();
    assert.equal(p.interestPaid, 7_500_000);
    assert.equal((await call('POST', `/v1/finance/lenders/loans/${loan.id}/payments`, { principal: 2_000_000_000 })).statusCode, 422);
    const pos = (await call('GET', `/v1/finance/cash?date=${m}-28`)).json();
    assert.equal(pos.accounts.find((a: any) => a.id === bank.id).balance, 1_000_000 + 1_000_000_000 - 7_500_000);
    await call('POST', `/v1/finance/ledger/sync/${m}`);
    const led = (await call('GET', `/v1/finance/ledger?month=${m}&currency=IDR`)).json();
    assert.equal(led.balanceSheet.liabilities.find((x: any) => x.code === '2500').amount, 1_000_000_000);
    assert.equal(led.profitAndLoss.month.other.find((x: any) => x.code === '7210').amount, -7_500_000);

    const c1 = (await call('POST', '/v1/finance/lenders/covenants', { kind: 'leverage', threshold: 3, currency: 'IDR', loanId: loan.id, frequency: 'monthly' })).json();
    await call('POST', '/v1/finance/lenders/covenants', { kind: 'min_cash', threshold: 500_000_000, currency: 'IDR', frequency: 'monthly' });
    assert.equal((await call('POST', '/v1/finance/lenders/covenants', { kind: 'nonsense', threshold: 1, currency: 'IDR' })).statusCode, 422);
    const t = (await call('POST', '/v1/finance/lenders/covenants/test', { month: m })).json();
    const lev = t.results.find((r: any) => r.id === c1.id);
    assert.equal(lev.passed, false, 'a billion of debt against little EBITDA');
    assert.equal(lev.measures.debt, 1_000_000_000);
    assert.equal(lev.measures.interest, 7_500_000);
    assert.equal(t.results.find((r: any) => r.kind === 'min_cash').passed, true);
    assert.equal((await many(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'finance.covenant_breach' AND resolved_at IS NULL AND severity = 'critical'`, [org])).length, 1);
    const list = (await call('GET', '/v1/finance/lenders')).json();
    assert.equal(list.covenants.find((c: any) => c.id === c1.id).tests[0].month, m);
    assert.equal((await call('GET', `/v1/finance/lenders/pack?month=${m}&format=pdf`)).rawPayload.subarray(0, 4).toString(), '%PDF');
    assert.equal((await call('GET', `/v1/finance/lenders/pack?month=${m}&format=xlsx`)).rawPayload.subarray(0, 2).toString(), 'PK');
  });
});
