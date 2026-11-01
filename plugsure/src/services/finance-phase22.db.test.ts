import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 22 of the finance review (v1.33.0):
 *   - payroll: BPJS and the caps, PPh 21 by TER (category by PTKP), the annual calculation in December, 20% more without
 *     an NPWP or NIK; a run drafted, adjusted, approved by a second person, paid; payslips, the transfer list, the ledger
 *     and the cash position;
 *   - customer credit: the score and grade from the payment history, a review decided by a Finance Manager (limit, hold,
 *     next review), the hold blocking the cards; security deposits received, applied to an invoice, returned;
 *   - capex projects: budget, committed and actual, over budget, completed into an asset (the ledger from assets under
 *     construction), cancelled and written off;
 *   - cash forecast: the learnt weekday pattern and trend; the forecast with payroll and capex; the scenarios.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase22.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const payroll = await import('./payroll.js');
const credit = await import('./customer-credit.js');
const forecast = await import('./cash-forecast.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID(), B = randomUUID();
let org = '';
let app: FastifyInstance;
let principalUser: string = A;
let approver = true;
const zone = config.billing.timeZone;
const localDay = (t: number = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(t));
const monthsBack = (n: number) => {
  let [y, m] = localDay().slice(0, 7).split('-').map(Number) as [number, number];
  for (let i = 0; i < n; i++) { m--; if (m === 0) { m = 12; y--; } }
  return `${y}-${String(m).padStart(2, '0')}`;
};
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });
const as = async <T>(user: string, fn: () => Promise<T>, canApprove = true) => {
  const u = principalUser, c = approver; principalUser = user; approver = canApprove;
  try { return await fn(); } finally { principalUser = u; approver = c; }
};

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Payroll ${TAG}`, `p22-${TAG}`]))!.id;
    for (const [u, n] of [[A, 'Rina'], [B, 'Budi']] as const) await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, $4)`, [u, org, `${u.slice(0, 8)}@p22.test`, n]);
    app = Fastify({ bodyLimit: 6 * 1024 * 1024 });
    app.addHook('onRequest', async (req) => {
      const perms = ['payment:read', 'payment:write', 'invoice:read', 'invoice:write', ...(approver ? ['finance:approve'] : [])];
      (req as any).principal = { userId: principalUser, orgId: org, assignments: [{ permissions: perms, scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
  });
  after(async () => {
    await app?.close();
    const o = [org];
    await query(`DELETE FROM gl_line WHERE org_id = ANY($1::uuid[])`, [o]);
    await query(`UPDATE capex_project SET asset_id = NULL WHERE org_id = ANY($1::uuid[])`, [o]);
    for (const t of ['payroll_line', 'payroll_run', 'employee', 'credit_review', 'customer_deposit', 'fixed_asset', 'supplier_payment', 'supplier_bill', 'purchase_order_line', 'purchase_order',
      'capex_project', 'cash_forecast_run', 'gl_entry', 'gl_account', 'supplier', 'cash_transfer', 'cash_balance', 'cash_account', 'finance_org_settings']) await query(`DELETE FROM ${t} WHERE org_id = ANY($1::uuid[])`, [o]);
    await query(`DELETE FROM fleet_invoice WHERE org_id = ANY($1::uuid[])`, [o]);
    await query(`DELETE FROM token WHERE org_id = ANY($1::uuid[])`, [o]).catch(() => { /* none */ });
    await query(`DELETE FROM fleet_credit_alert WHERE org_id = ANY($1::uuid[])`, [o]).catch(() => { /* none */ });
    await query(`DELETE FROM fleet_account WHERE org_id = ANY($1::uuid[])`, [o]);
    await query(`DELETE FROM alert WHERE org_id = ANY($1::uuid[])`, [o]);
    await query(`DELETE FROM app_user WHERE org_id = ANY($1::uuid[])`, [o]).catch(() => { /* audit rows keep them */ });
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => { /* audit rows keep it */ });
    await pool.end();
  });
}

describe('Payroll, credit and forecast helpers', () => {
  test('PTKP, TER categories and rates, BPJS caps, the December calculation, no tax id', async () => {
    assert.equal(payroll.ptkpAmount('TK/0'), 54_000_000);
    assert.equal(payroll.ptkpAmount('K/3'), 72_000_000);
    assert.deepEqual(['TK/0', 'K/0', 'TK/2', 'K/1', 'K/3'].map((x) => payroll.terCategory(x as any)), ['A', 'A', 'B', 'B', 'C']);
    assert.equal(payroll.terRate(payroll.TER.A, 5_400_000), 0);
    assert.equal(payroll.terRate(payroll.TER.A, 10_000_000), 2);
    assert.equal(payroll.terRate(payroll.TER.A, 2_000_000_000), 34);
    const r = { kesCap: 12_000_000, jpCap: 10_547_400, ter: payroll.TER };
    const e = { ptkp: 'TK/0' as const, hasTaxId: true, kes: true, tk: true, jkkPct: 0.24 };
    const b = payroll.bpjs(e, 20_000_000, r);
    assert.deepEqual([b.kesEmployer, b.kesEmployee, b.jpEmployer, b.jpEmployee, b.jhtEmployee], [480_000, 120_000, 210_948, 105_474, 400_000], 'Kesehatan and JP capped, JHT not');
    // A month: 10 million salary → gross with JKK, JKM and the employer's Kesehatan; TER A on it.
    const x = { base: 9_000_000, allowance: 1_000_000, overtime: 0, bonus: 0, deduction: 0 };
    const m = payroll.computeLine(e, x, r, { final: false, prior: { gross: 0, pph21: 0, pension: 0, months: 0 } });
    assert.equal(m.gross, 10_000_000 + 24_000 + 30_000 + 400_000);
    assert.equal(m.rate, 2.5, 'TER A: 10.35 to 10.7 million');
    assert.equal(m.pph21, Math.round(m.gross * 0.025));
    assert.equal(m.net, 10_000_000 - (100_000 + 200_000 + 100_000) - m.pph21);
    assert.equal(payroll.computeLine({ ...e, hasTaxId: false }, x, r, { final: false, prior: { gross: 0, pph21: 0, pension: 0, months: 0 } }).pph21, Math.round(m.pph21 * 1.2));
    // December: the year's tax less what the 11 months withheld.
    const dec = payroll.computeLine(e, x, r, { final: true, prior: { gross: m.gross * 11, pph21: m.pph21 * 11, pension: 300_000 * 11, months: 11 } });
    const yGross = m.gross * 12, jab = 6_000_000, pension = 3_600_000;
    const pkp = Math.floor((yGross - jab - pension - 54_000_000) / 1000) * 1000;
    assert.equal(dec.detail!.pkp, pkp);
    assert.equal(dec.pph21, (await import('./withholding-tax.js')).pasal17(pkp) - m.pph21 * 11);
  });

  test('credit score and grade; suggested limit', () => {
    const good = credit.scoreOf({ invoices: 12, paidLatePct: 0, avgDaysLate: 0, overdue: 0, maxDaysOverdue: 0, usedPct: 40, tenureMonths: 24, deposit: 0, avgMonthly: 10_000_000 });
    assert.deepEqual([good.score, good.grade], [100, 'A']);
    const bad = credit.scoreOf({ invoices: 10, paidLatePct: 60, avgDaysLate: 25, overdue: 5_000_000, maxDaysOverdue: 45, usedPct: 95, tenureMonths: 3, deposit: 0, avgMonthly: 10_000_000 });
    assert.equal(bad.grade, 'E');
    assert.ok(bad.reasons.some((r) => r.includes('overdue')));
    assert.equal(credit.suggestedLimit('B', 12_340_000, 5_000_000), 29_700_000);
    assert.equal(credit.suggestedLimit('E', 12_340_000, 0), 0);
  });

  test('the forecast learns the weekday pattern and the trend', () => {
    const series: Array<{ day: string; amount: number }> = [];
    const start = Date.parse('2026-05-04T00:00:00Z'); // a Monday
    for (let i = 0; i < 140; i++) {
      const d = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
      const wd = new Date(start + i * 86_400_000).getUTCDay();
      series.push({ day: d, amount: Math.round((1_000_000 + i * 5_000) * (wd === 0 || wd === 6 ? 1.5 : 0.8)) });
    }
    const f = forecast.learn(series, '2026-09-21', 14);
    assert.ok(f.model.season[6]! > f.model.season[2]!, 'weekends above weekdays');
    assert.ok(f.model.trend > 0, 'an upward trend');
    const sat = f.daily.find((x) => new Date(`${x.day}T00:00:00Z`).getUTCDay() === 6)!, tue = f.daily.find((x) => new Date(`${x.day}T00:00:00Z`).getUTCDay() === 2)!;
    assert.ok(sat.expected > tue.expected * 1.5);
    assert.ok(f.daily.every((x) => x.low <= x.expected && x.high >= x.expected));
    assert.ok(f.model.wape != null && f.model.wape < 10, `fits well (${f.model.wape}%)`);
  });
});

dbDescribe('Payroll', () => {
  test('employees, a run drafted, adjusted, approved by a second person, paid; payslip, transfers, ledger, cash', async () => {
    const m = monthsBack(1);
    assert.equal((await call('POST', '/v1/finance/payroll/employees', { name: 'Bad', currency: 'IDR', baseSalary: 1, startOn: '2026-01-01', nik: '12' })).statusCode, 422);
    const e1 = (await call('POST', '/v1/finance/payroll/employees', { name: `Sari ${TAG}`, currency: 'IDR', baseSalary: 9_000_000, allowance: 1_000_000, ptkp: 'TK/0', npwp: '01.234.567.8-901.000',
      startOn: '2025-01-01', bank: { name: 'BCA', accountNumber: '1234567890', accountName: 'Sari' } })).json();
    assert.match(e1.number, /^EMP-\d{4}$/);
    assert.equal(e1.bank.accountLast4, '7890');
    assert.ok(!(await one<{ account_sealed: string }>(`SELECT account_sealed FROM employee WHERE id = $1`, [e1.id]))!.account_sealed.includes('1234567890'), 'sealed');
    await call('POST', '/v1/finance/payroll/employees', { name: `Joko ${TAG}`, currency: 'IDR', baseSalary: 6_000_000, ptkp: 'K/1', startOn: '2025-06-01' });
    await call('POST', '/v1/finance/payroll/employees', { name: `Gone ${TAG}`, currency: 'IDR', baseSalary: 6_000_000, startOn: '2024-01-01', endOn: '2025-12-31' });

    const run = (await call('POST', '/v1/finance/payroll/runs', { month: m, currency: 'IDR' })).json();
    assert.equal(run.lines.length, 2, 'the leaver is not on it');
    const sari = run.lines.find((l: any) => l.name.startsWith('Sari'));
    assert.equal(sari.method, m.endsWith('-12') ? 'annual (Pasal 17)' : 'TER A');
    const adj = (await call('PUT', `/v1/finance/payroll/runs/${run.id}/lines/${sari.id}`, { overtime: 500_000, bonus: 0, deduction: 50_000 })).json();
    const s2 = adj.lines.find((l: any) => l.id === sari.id);
    assert.equal(s2.overtime, 500_000);
    assert.equal(s2.net, 10_500_000 - s2.employeeBpjs - s2.pph21 - 50_000);
    assert.equal(adj.totals.net, adj.lines.reduce((s: number, l: any) => s + l.net, 0));

    assert.equal((await call('POST', `/v1/finance/payroll/runs/${run.id}/submit`)).json().status, 'awaiting_approval');
    assert.equal((await call('POST', `/v1/finance/payroll/runs/${run.id}/approve`)).statusCode, 403, 'not the submitter');
    assert.equal((await as(B, () => call('POST', `/v1/finance/payroll/runs/${run.id}/approve`))).json().status, 'approved');
    const bank = (await call('POST', '/v1/finance/cash/accounts', { name: 'Payroll bank', kind: 'bank', currency: 'IDR', openingBalance: 100_000_000, openingOn: `${m}-01` })).json();
    const csv = await call('GET', `/v1/finance/payroll/runs/${run.id}?format=transfers`);
    assert.match(csv.body, /1234567890/);
    assert.match(csv.body, new RegExp(`GAJI ${m}`));
    const paid = (await call('POST', `/v1/finance/payroll/runs/${run.id}/pay`, { paidOn: `${m}-25`, cashAccountId: bank.id })).json();
    assert.equal(paid.status, 'paid');
    assert.equal((await call('POST', `/v1/finance/payroll/runs/${run.id}/void`, { reason: 'mistake' })).statusCode, 409);
    assert.equal((await call('GET', `/v1/finance/payroll/runs/${run.id}/payslips/${sari.id}`)).rawPayload.subarray(0, 4).toString(), '%PDF');
    assert.equal((await call('GET', `/v1/finance/payroll/runs/${run.id}?format=xlsx`)).rawPayload.subarray(0, 2).toString(), 'PK');

    const pos = (await call('GET', `/v1/finance/cash?date=${m}-28`)).json();
    assert.equal(pos.accounts.find((a: any) => a.id === bank.id).balance, 100_000_000 - paid.totals.net);
    await call('POST', `/v1/finance/ledger/sync/${m}`);
    const led = (await call('GET', `/v1/finance/ledger?month=${m}&currency=IDR`)).json();
    assert.equal(led.trialBalance.balanced, true);
    const exp = (code: string) => led.profitAndLoss.month.expense.find((x: any) => x.code === code)?.amount ?? 0;
    assert.equal(exp('6100'), paid.totals.wages);
    assert.equal(exp('6105'), paid.totals.employerBpjs);
    const liab = (code: string) => led.balanceSheet.liabilities.find((x: any) => x.code === code)?.amount ?? 0;
    assert.deepEqual([liab('2170'), liab('2151'), liab('2180')], [0, paid.totals.pph21, paid.totals.employerBpjs + paid.totals.employeeBpjs]);
    assert.equal((await call('POST', '/v1/finance/payroll/runs', { month: m, currency: 'IDR' })).statusCode, 409, 'already paid');
  });
});

dbDescribe('Customer credit and deposits', () => {
  test('scored from the history, reviewed by a Finance Manager, held; deposits received, applied, returned', async () => {
    const acct = (await one<{ id: string }>(`INSERT INTO fleet_account (org_id, name, credit_mode, credit_limit_minor) VALUES ($1, $2, 'credit', 20000000) RETURNING id`, [org, `Taxi ${TAG}`]))!.id;
    await query(`UPDATE fleet_account SET created_at = now() - interval '2 years' WHERE id = $1`, [acct]);
    const inv = async (n: string, monthsAgo: number, dueDays: number, paidDays: number | null, total: number) => (await one<{ id: string }>(
      `INSERT INTO fleet_invoice (org_id, fleet_account_id, period, number, due_date, sessions, energy_wh, subtotal_minor, local_tax_minor, taxable_minor, tax_base_minor, tax_minor, own_total_minor, roaming_total_minor, total_minor, data, status, issued_at, paid_at, currency)
       VALUES ($1, $2, (date_trunc('month', now()) - make_interval(months => $3))::date, $4, (now() - make_interval(months => $3) + make_interval(days => $5))::date, 1, 1, $6, 0, $6, $6, 0, $6, 0, $6, '{}', $7, now() - make_interval(months => $3), $8, 'IDR') RETURNING id`,
      [org, acct, monthsAgo, `${n}-${TAG}`, dueDays, total, paidDays == null ? 'issued' : 'paid', paidDays == null ? null : new Date(Date.now() - monthsAgo * 30 * 86_400_000 + paidDays * 86_400_000).toISOString().slice(0, 10)]))!.id;
    for (let k = 1; k <= 6; k++) await inv(`F${k}`, k, 14, k % 3 === 0 ? 30 : 10, 6_000_000);
    const open = await inv('F7', 0, 14, null, 6_000_000);
    const d = (await call('GET', `/v1/finance/credit/accounts/${acct}`)).json();
    assert.equal(d.factors.paidLatePct, 33);
    assert.equal(d.factors.avgMonthly, 6_000_000);
    const r = await call('POST', `/v1/finance/credit/accounts/${acct}/reviews`);
    assert.equal(r.statusCode, 201, r.body);
    const rev = r.json();
    assert.ok(['B', 'C'].includes(rev.grade), `grade ${rev.grade} (${rev.score})`);
    assert.equal(rev.suggestedLimit, credit.suggestedLimit(rev.grade, 6_000_000, 0));
    assert.equal((await call('POST', `/v1/finance/credit/accounts/${acct}/reviews`)).statusCode, 409, 'one open review');
    assert.equal((await as(B, () => call('POST', `/v1/finance/credit/reviews/${rev.id}/decide`, { decision: 'approve' }), false)).statusCode, 403);
    assert.equal((await call('POST', `/v1/finance/credit/reviews/${rev.id}/decide`, { decision: 'approve', hold: true })).statusCode, 422, 'a hold needs a note');
    const dec = (await call('POST', `/v1/finance/credit/reviews/${rev.id}/decide`, { decision: 'approve', newLimit: 15_000_000, hold: true, note: 'Pay the open invoice first' })).json();
    assert.deepEqual([dec.status, dec.newLimit, dec.hold], ['approved', 15_000_000, true]);
    const fa = await one<any>(`SELECT credit_limit_minor, credit_hold_at, to_char(next_review_on, 'YYYY-MM-DD') AS n FROM fleet_account WHERE id = $1`, [acct]);
    assert.equal(Number(fa.credit_limit_minor), 15_000_000);
    assert.ok(fa.credit_hold_at);
    assert.ok(fa.n > localDay());
    const ov = (await call('GET', '/v1/finance/credit')).json();
    assert.ok(ov.accounts.find((a: any) => a.id === acct).hold);
    assert.equal((await call('POST', `/v1/finance/credit/accounts/${acct}/hold`, { hold: false })).json().hold, false);

    assert.equal((await call('POST', `/v1/finance/credit/accounts/${acct}/deposits`, { kind: 'returned', amount: 1 })).statusCode, 422, 'nothing held');
    const bank = (await call('POST', '/v1/finance/cash/accounts', { name: 'Deposits bank', kind: 'bank', currency: 'IDR', openingBalance: 0, openingOn: localDay(Date.now() - 10 * 86_400_000) })).json();
    assert.equal((await call('POST', `/v1/finance/credit/accounts/${acct}/deposits`, { kind: 'received', amount: 10_000_000, cashAccountId: bank.id, reference: 'TRF 1' })).statusCode, 201);
    assert.equal((await call('POST', `/v1/finance/credit/accounts/${acct}/deposits`, { kind: 'applied', amount: 5_000_000, invoiceId: open })).statusCode, 422, 'the whole invoice');
    assert.equal((await call('POST', `/v1/finance/credit/accounts/${acct}/deposits`, { kind: 'applied', amount: 6_000_000, invoiceId: open })).statusCode, 201);
    assert.equal((await one<{ status: string }>(`SELECT status FROM fleet_invoice WHERE id = $1`, [open]))!.status, 'paid');
    assert.equal((await call('POST', `/v1/finance/credit/accounts/${acct}/deposits`, { kind: 'returned', amount: 5_000_000 })).statusCode, 422, 'only 4 million held');
    await call('POST', `/v1/finance/credit/accounts/${acct}/deposits`, { kind: 'returned', amount: 4_000_000, cashAccountId: bank.id });
    const deps = (await call('GET', '/v1/finance/customer-deposits')).json();
    assert.equal(deps.held.IDR, 0);
    assert.equal((await call('GET', '/v1/finance/cash')).json().accounts.find((a: any) => a.id === bank.id).balance, 6_000_000);
    await call('POST', `/v1/finance/ledger/sync/${localDay().slice(0, 7)}`);
    const led = (await call('GET', `/v1/finance/ledger?month=${localDay().slice(0, 7)}&currency=IDR`)).json();
    assert.equal(led.profitAndLoss.month.revenue.find((x: any) => x.code === '4200')?.amount, 6_000_000);
    assert.equal(led.balanceSheet.liabilities.find((x: any) => x.code === '2200')?.amount ?? 0, 0);
  });
});

dbDescribe('Capex projects', () => {
  test('budget, committed, actual, over budget; completed into an asset; cancelled and written off', async () => {
    const m = monthsBack(1);
    const sup = (await call('POST', '/v1/finance/suppliers', { name: `Installer ${TAG}`, whtPct: 2 })).json();
    assert.equal((await call('POST', '/v1/finance/projects', { name: 'Site X', currency: 'IDR', budget: { nonsense: 1 } })).statusCode, 422);
    const p = (await call('POST', '/v1/finance/projects', { name: `Rest area KM 57 ${TAG}`, currency: 'IDR', status: 'active', budget: { equipment: 400_000_000, installation: 100_000_000 }, targetOn: localDay(Date.now() + 60 * 86_400_000) })).json();
    assert.match(p.number, /^CP-\d{4}$/);
    assert.equal(p.budget, 500_000_000);
    const po = (await call('POST', '/v1/finance/purchase-orders', { supplierId: sup.id, currency: 'IDR', description: 'Two DC chargers', lines: [{ description: 'DC charger 120 kW', quantity: 2, unitPrice: 220_000_000 }] })).json();
    await as(B, () => call('POST', `/v1/finance/purchase-orders/${po.id}/approve`));
    assert.equal((await call('POST', `/v1/finance/projects/${p.id}/link`, { orderId: po.id })).json().committed, 440_000_000);
    const bill = (await call('POST', '/v1/finance/bills', { supplierId: sup.id, number: `INST-${TAG}`, category: 'installation', description: 'Installation', subtotal: 120_000_000, billDate: `${m}-10`, currency: 'IDR' })).json();
    await as(B, () => call('POST', `/v1/finance/bills/${bill.id}/approve`));
    const v = (await call('POST', `/v1/finance/projects/${p.id}/link`, { billId: bill.id })).json();
    assert.deepEqual([v.actual, v.committed, v.forecast, v.overBudget], [120_000_000, 440_000_000, 560_000_000, true]);
    assert.equal(v.variancePct, 12);
    assert.equal(v.categories.find((c: any) => c.category === 'installation').actual, 120_000_000);
    await (await import('./capex-projects.js')).sweep();
    assert.equal((await many(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'finance.capex_over_budget' AND resolved_at IS NULL`, [org])).length, 1);

    await call('POST', `/v1/finance/ledger/sync/${m}`);
    const l1 = (await call('GET', `/v1/finance/ledger?month=${m}&currency=IDR`)).json();
    assert.equal(l1.balanceSheet.assets.find((x: any) => x.code === '1610')?.amount, 120_000_000, 'assets under construction');
    assert.equal(l1.profitAndLoss.month.expense.find((x: any) => x.code === '6220')?.amount ?? 0, 0, 'not expensed');

    const done = (await call('POST', `/v1/finance/projects/${p.id}/complete`, { completedOn: `${m}-28`, inService: localDay().slice(0, 7) })).json();
    assert.equal(done.status, 'completed');
    assert.equal(done.capitalised, 120_000_000);
    const asset = await one<any>(`SELECT cost_minor, category, capex_project_id FROM fixed_asset WHERE id = $1`, [done.asset.id]);
    assert.deepEqual([Number(asset.cost_minor), asset.category, String(asset.capex_project_id)], [120_000_000, 'chargers', p.id]);
    await call('POST', `/v1/finance/ledger/sync/${m}`);
    const l2 = (await call('GET', `/v1/finance/ledger?month=${m}&currency=IDR`)).json();
    assert.equal(l2.balanceSheet.assets.find((x: any) => x.code === '1610')?.amount ?? 0, 0);
    assert.equal(l2.balanceSheet.assets.find((x: any) => x.code === '1600')?.amount, 120_000_000);
    assert.equal((await call('POST', `/v1/finance/projects/${p.id}/link`, { billId: bill.id })).statusCode, 409, 'completed');

    const q = (await call('POST', '/v1/finance/projects', { name: `Abandoned ${TAG}`, currency: 'IDR', status: 'active', budget: { services: 50_000_000 } })).json();
    const b2 = (await call('POST', '/v1/finance/bills', { supplierId: sup.id, number: `SURV-${TAG}`, category: 'services', description: 'Site survey', subtotal: 8_000_000, billDate: `${m}-12`, currency: 'IDR' })).json();
    await as(B, () => call('POST', `/v1/finance/bills/${b2.id}/approve`));
    await call('POST', `/v1/finance/projects/${q.id}/link`, { billId: b2.id });
    assert.equal((await call('POST', `/v1/finance/projects/${q.id}/cancel`, { reason: 'x' })).statusCode, 422);
    assert.equal((await call('POST', `/v1/finance/projects/${q.id}/cancel`, { reason: 'Landlord withdrew', cancelledOn: `${m}-29` })).json().status, 'cancelled');
    await call('POST', `/v1/finance/ledger/sync/${m}`);
    const l3 = (await call('GET', `/v1/finance/ledger?month=${m}&currency=IDR`)).json();
    assert.equal(l3.profitAndLoss.month.other.find((x: any) => x.code === '8300')?.amount, -8_000_000, 'written off');
    assert.equal(l3.trialBalance.balanced, true);
    assert.equal((await call('GET', '/v1/finance/projects?format=xlsx')).rawPayload.subarray(0, 2).toString(), 'PK');
  });
});

dbDescribe('Cash forecast', () => {
  test('the committed flows, payroll and capex in the forecast; scenarios; stored; settings checked', async () => {
    const f = (await call('GET', '/v1/finance/cash-forecast?horizonDays=60')).json();
    const idr = f.currencies.find((c: any) => c.currency === 'IDR');
    assert.ok(idr, JSON.stringify(f.currencies.map((c: any) => c.currency)));
    assert.equal(idr.days.length, 60);
    assert.match(idr.message, /charging history/);
    const kinds = new Set(idr.largest.map((x: any) => x.kind));
    assert.ok(kinds.has('payroll'), 'the next payroll');
    const noCapex = (await call('GET', '/v1/finance/cash-forecast?horizonDays=60&capex=false')).json().currencies.find((c: any) => c.currency === 'IDR');
    assert.ok(noCapex.closing >= idr.closing);
    assert.equal(idr.days[0].closing - idr.opening, idr.days[0].in + idr.days[0].out + idr.days[0].learned);
    assert.equal((await call('GET', '/v1/finance/cash-forecast?horizonDays=500')).statusCode, 422);
    assert.equal((await call('PUT', '/v1/finance/cash-forecast/settings', { horizonDays: 10 })).statusCode, 422);
    assert.deepEqual((await call('PUT', '/v1/finance/cash-forecast/settings', { horizonDays: 120, collectionsPct: 90 })).json(), { horizonDays: 120, collectionsPct: 90, alert: true });
    const s = (await call('POST', '/v1/finance/cash-forecast/snapshot')).json();
    assert.ok(s.currencies >= 1);
    assert.equal((await many(`SELECT 1 FROM cash_forecast_run WHERE org_id = $1`, [org])).length >= 1, true);
    assert.equal((await call('GET', '/v1/finance/cash-forecast')).json().horizonDays, 120);
  });
});
