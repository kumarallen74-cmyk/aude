import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 20 of the finance review (v1.31.0):
 *   - general ledger: a manual entry balanced and approved by a second person; the trial balance, profit and loss and
 *     balance sheet balancing; a month synced from the modules (bills, deposits, expense claims), unchanged on a second
 *     sync and superseded when a module changes; a reversal; a locked month refused;
 *   - expense claims: a receipt needed above the amount, the claimant cannot approve, a line over its limit needs a
 *     Finance Manager, reimbursed out of petty cash; the receipt served back; a petty cash count and its difference;
 *   - intercompany: a parent and a subsidiary recharging each other, seen from both sides, netted and settled; a cost
 *     allocated across the group; an outsider refused;
 *   - scorecard: targets, actuals and colours, the band, the e-mail settings checked.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase20.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const ledger = await import('./general-ledger.js');
const scorecard = await import('./kpi-scorecard.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID(), B = randomUUID(), C = randomUUID();
let parent = '', child = '', outsider = '';
let app: FastifyInstance;
let principalUser: string = A, principalOrg = '';
let approver = true;
const zone = config.billing.timeZone;
const localDay = (t: number = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(t));
const monthsBack = (n: number) => {
  let [y, m] = localDay().slice(0, 7).split('-').map(Number) as [number, number];
  for (let i = 0; i < n; i++) { m--; if (m === 0) { m = 12; y--; } }
  return `${y}-${String(m).padStart(2, '0')}`;
};
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });
const as = async <T>(user: string, fn: () => Promise<T>, canApprove = true, org = principalOrg) => {
  const u = principalUser, c = approver, o = principalOrg; principalUser = user; approver = canApprove; principalOrg = org;
  try { return await fn(); } finally { principalUser = u; approver = c; principalOrg = o; }
};
// The smallest valid PNG (1 × 1).
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');

if (DB_OK) {
  before(async () => {
    parent = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Ledger ${TAG}`, `p20-p-${TAG}`]))!.id;
    child = (await one<{ id: string }>(`INSERT INTO organisation (name, slug, parent_org_id) VALUES ($1, $2, $3) RETURNING id`, [`Ledger Sub ${TAG}`, `p20-c-${TAG}`, parent]))!.id;
    outsider = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Elsewhere ${TAG}`, `p20-o-${TAG}`]))!.id;
    for (const [u, n, o] of [[A, 'Rina', parent], [B, 'Budi', parent], [C, 'Citra', child]] as const) await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, $4)`, [u, o, `${u.slice(0, 8)}@p20.test`, n]);
    principalOrg = parent;
    app = Fastify({ bodyLimit: 6 * 1024 * 1024 });
    app.addHook('onRequest', async (req) => {
      const perms = ['payment:read', 'payment:write', 'invoice:read', 'invoice:write', ...(approver ? ['finance:approve'] : [])];
      (req as any).principal = { userId: principalUser, orgId: principalOrg, assignments: [{ permissions: perms, scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
  });
  after(async () => {
    await app?.close();
    const o = [parent, child, outsider];
    await query(`DELETE FROM gl_line WHERE org_id = ANY($1::uuid[])`, [o]);
    await query(`UPDATE gl_entry SET reversal_of = NULL, reversed_by = NULL WHERE org_id = ANY($1::uuid[])`, [o]);
    for (const t of ['gl_entry', 'gl_account', 'expense_receipt', 'expense_claim_line', 'expense_claim', 'cash_count', 'intercompany_recharge', 'intercompany_settlement', 'kpi_target', 'kpi_scorecard_send',
      'deposit', 'supplier_payment', 'supplier_bill', 'supplier', 'cash_transfer', 'cash_balance', 'cash_account', 'finance_period_lock', 'finance_org_settings']) await query(`DELETE FROM ${t} WHERE org_id = ANY($1::uuid[])`, [o]);
    await query(`DELETE FROM alert WHERE org_id = ANY($1::uuid[])`, [o]);
    await query(`DELETE FROM app_user WHERE org_id = ANY($1::uuid[])`, [o]).catch(() => { /* audit rows keep them */ });
    for (const x of [child, outsider, parent]) await query(`DELETE FROM organisation WHERE id = $1`, [x]).catch(() => { /* audit rows keep it */ });
    await pool.end();
  });
}

describe('Ledger and scorecard helpers', () => {
  test('lines netted per account; colours by direction and band', () => {
    assert.deepEqual(ledger.compact([{ account: '1100', debit: 100, credit: 0 }, { account: '1100', debit: 0, credit: 30 }, { account: '2100', debit: 0, credit: 70 }, { account: '6200', debit: 0, credit: 0 }]),
      [{ account: '1100', debit: 70, credit: 0, description: null, name: undefined }, { account: '2100', debit: 0, credit: 70, description: null, name: undefined }]);
    assert.equal(scorecard.rag('revenue', 100, 100, 10), 'green');
    assert.equal(scorecard.rag('revenue', 91, 100, 10), 'amber');
    assert.equal(scorecard.rag('revenue', 89, 100, 10), 'red');
    assert.equal(scorecard.rag('opex', 105, 100, 10), 'amber', 'lower is better');
    assert.equal(scorecard.rag('opex', 95, 100, 10), 'green');
    assert.equal(scorecard.rag('cash', null, 100, 10), null);
  });
});

dbDescribe('General ledger', () => {
  test('manual entries approved, reports balanced, the modules synced and superseded, reversed, locked month refused', async () => {
    const m = monthsBack(1);
    const date = `${m}-10`;
    assert.equal((await call('POST', '/v1/finance/ledger/entries', { date, currency: 'IDR', memo: 'Capital', lines: [{ account: '1100', debit: 1_000_000 }, { account: '3100', credit: 900_000 }] })).statusCode, 422, 'unbalanced');
    assert.equal((await call('POST', '/v1/finance/ledger/entries', { date, currency: 'IDR', memo: 'Capital', lines: [{ account: '1100', debit: 1 }, { account: '9999', credit: 1 }] })).statusCode, 422, 'no such account');
    const e1r = await call('POST', '/v1/finance/ledger/entries', { date, currency: 'IDR', memo: 'Paid-in capital', lines: [{ account: '1100', debit: 10_000_000 }, { account: '3100', credit: 10_000_000 }] });
    assert.equal(e1r.statusCode, 201, e1r.body);
    const e1 = e1r.json();
    assert.equal(e1.status, 'awaiting_approval');
    assert.match(e1.number, /^JE-\d{6}-\d{4}$/);
    assert.equal((await call('POST', `/v1/finance/ledger/entries/${e1.id}/approve`)).statusCode, 403, 'not the submitter');
    assert.equal((await as(B, () => call('POST', `/v1/finance/ledger/entries/${e1.id}/approve`))).json().status, 'posted');
    const e2 = (await call('POST', '/v1/finance/ledger/entries', { date, currency: 'IDR', memo: 'Cleaning', lines: [{ account: '6200', debit: 250_000, description: 'Site cleaning' }, { account: '1100', credit: 250_000 }] })).json();
    await as(B, () => call('POST', `/v1/finance/ledger/entries/${e2.id}/approve`));

    // Bills, a deposit and an expense claim in the month, then the sync.
    const sup = (await call('POST', '/v1/finance/suppliers', { name: `Rapi ${TAG}`, whtPct: 2 })).json();
    const bill = (await call('POST', '/v1/finance/bills', { supplierId: sup.id, number: 'R-1', category: 'maintenance', description: 'Service', subtotal: 1_000_000, vat: 110_000, billDate: `${m}-05`, currency: 'IDR' })).json();
    await as(B, () => call('POST', `/v1/finance/bills/${bill.id}/approve`));
    const bank = (await call('POST', '/v1/finance/cash/accounts', { name: 'Operating', kind: 'bank', currency: 'IDR', openingBalance: 50_000_000, openingOn: `${m}-01` })).json();
    await call('POST', '/v1/finance/treasury/deposits', { cashAccountId: bank.id, bankName: 'BRI', principal: 20_000_000, ratePct: 5, placedOn: `${m}-15`, termMonths: 3 });
    const s1 = (await call('POST', `/v1/finance/ledger/sync/${m}`)).json();
    assert.ok(s1.posted >= 2, JSON.stringify(s1));
    const s2 = (await call('POST', `/v1/finance/ledger/sync/${m}`)).json();
    assert.deepEqual({ p: s2.posted, s: s2.superseded }, { p: 0, s: 0 }, 'nothing changed');
    await call('POST', `/v1/finance/bills/${bill.id}/payments`, { amount: 500_000, paidOn: `${m}-20`, cashAccountId: bank.id });
    const s3 = (await call('POST', `/v1/finance/ledger/sync/${m}`)).json();
    assert.deepEqual({ p: s3.posted, s: s3.superseded }, { p: 1, s: 1 }, 'the bills entry replaced');

    const r = (await call('GET', `/v1/finance/ledger?month=${m}&currency=IDR`)).json();
    assert.equal(r.trialBalance.balanced, true);
    assert.equal(r.balanceSheet.balanced, true);
    assert.equal(r.profitAndLoss.month.totalExpense, 250_000 + 1_000_000, 'cleaning and the bill');
    assert.equal(r.profitAndLoss.month.result, -1_250_000);
    const ap = r.balanceSheet.liabilities.find((x: any) => x.code === '2100');
    assert.equal(ap.amount, 1_110_000 - 20_000 - 500_000, 'payable less PPh 23, less the payment');
    assert.equal(r.balanceSheet.assets.find((x: any) => x.code === '1150').amount, 20_000_000, 'the deposit');
    const lines = (await call('GET', `/v1/finance/ledger/accounts/6200/lines?month=${m}`)).json().lines;
    assert.equal(lines.length, 2);

    const rev = await call('POST', `/v1/finance/ledger/entries/${e2.id}/reverse`, { date: `${m}-25` });
    assert.equal(rev.statusCode, 201, rev.body);
    assert.equal((await call('POST', `/v1/finance/ledger/entries/${e2.id}/reverse`)).statusCode, 409, 'once');
    const r2 = (await call('GET', `/v1/finance/ledger?month=${m}&currency=IDR`)).json();
    assert.equal(r2.profitAndLoss.month.totalExpense, 1_000_000);
    const modEntry = (await call('GET', `/v1/finance/ledger/entries?month=${m}&source=bills`)).json().entries[0];
    assert.equal((await call('POST', `/v1/finance/ledger/entries/${modEntry.id}/reverse`)).statusCode, 409, 'a module\'s entry is synced, not reversed');

    await query(`INSERT INTO finance_period_lock (org_id, month, locked_by) VALUES ($1, $2, $3)`, [parent, monthsBack(2), A]);
    assert.equal((await call('POST', `/v1/finance/ledger/sync/${monthsBack(2)}`)).statusCode, 409, 'locked');
    assert.equal((await call('POST', '/v1/finance/ledger/entries', { date: `${monthsBack(2)}-03`, currency: 'IDR', memo: 'Late', lines: [{ account: '1100', debit: 1 }, { account: '3100', credit: 1 }] })).statusCode, 409);
    assert.equal((await call('GET', `/v1/finance/ledger?month=${m}&format=xlsx`)).rawPayload.subarray(0, 2).toString(), 'PK');
  });
});

dbDescribe('Expense claims and petty cash', () => {
  test('receipts, a second approver, limits, reimbursed from petty cash; a count', async () => {
    const petty = (await call('POST', '/v1/finance/cash/accounts', { name: 'Petty cash', kind: 'cash', currency: 'IDR', openingBalance: 2_000_000, openingOn: localDay(Date.now() - 5 * 86_400_000) })).json();
    await call('PUT', '/v1/finance/expenses/policy', { receiptAbove: 100_000, limits: { meals: 150_000 } });
    const c = await call('POST', '/v1/finance/expenses', { title: 'Site visit Bogor', currency: 'IDR', lines: [
      { spentOn: localDay(), category: 'fuel', description: 'Fuel', amount: 250_000 }, { spentOn: localDay(), category: 'meals', description: 'Lunch with the landlord', amount: 180_000, vat: 0 }, { spentOn: localDay(), category: 'parking', description: 'Parking', amount: 20_000 }] });
    assert.equal(c.statusCode, 201, c.body);
    const claim = c.json();
    assert.match(claim.number, /^EX-\d{5}$/);
    assert.equal(claim.total, 450_000);
    assert.equal(claim.receiptsMissing, 2);
    assert.equal((await call('POST', `/v1/finance/expenses/${claim.id}/submit`)).statusCode, 422, 'receipts missing');
    for (const l of claim.lines.filter((x: any) => x.receiptNeeded)) {
      const r = await call('POST', `/v1/finance/expenses/${claim.id}/lines/${l.id}/receipts`, { filename: 'receipt.png', mime: 'image/png', data: PNG.toString('base64') });
      assert.equal(r.statusCode, 200, r.body);
    }
    assert.equal((await call('POST', `/v1/finance/expenses/${claim.id}/lines/${claim.lines[2].id}/receipts`, { mime: 'application/pdf', data: PNG.toString('base64') })).statusCode, 422, 'not the type it says');
    const sub = (await call('POST', `/v1/finance/expenses/${claim.id}/submit`)).json();
    assert.equal(sub.status, 'submitted');
    assert.equal(sub.overLimit, true);
    assert.equal((await call('POST', `/v1/finance/expenses/${claim.id}/approve`)).statusCode, 403, 'the claimant');
    assert.equal((await as(B, () => call('POST', `/v1/finance/expenses/${claim.id}/approve`), false)).statusCode, 403, 'over the limit without finance:approve');
    assert.equal((await as(B, () => call('POST', `/v1/finance/expenses/${claim.id}/approve`))).json().status, 'approved');
    const listed = (await call('GET', '/v1/finance/expenses')).json();
    assert.equal(listed.toReimburse.IDR, 450_000);
    const paid = (await call('POST', `/v1/finance/expenses/${claim.id}/reimburse`, { cashAccountId: petty.id, reference: 'PC-1' })).json();
    assert.equal(paid.status, 'reimbursed');
    const rid = paid.lines[0].receipts[0].id;
    const file = await call('GET', `/v1/finance/expenses/receipts/${rid}`);
    assert.equal(file.headers['content-type'], 'image/png');
    assert.deepEqual(file.rawPayload, PNG);

    await call('PUT', `/v1/finance/petty-cash/${petty.id}/float`, { float: 2_000_000 });
    let pc = (await call('GET', '/v1/finance/petty-cash')).json().accounts.find((a: any) => a.id === petty.id);
    assert.deepEqual({ b: pc.balance, top: pc.topUp }, { b: 1_550_000, top: 450_000 });
    const cnt = (await call('POST', `/v1/finance/petty-cash/${petty.id}/counts`, { denominations: { 100000: 15, 50000: 0, 20000: 2 }, note: 'Friday count' })).json();
    assert.deepEqual({ t: cnt.total, e: cnt.expected, d: cnt.difference }, { t: 1_540_000, e: 1_550_000, d: -10_000 });
    pc = (await call('GET', '/v1/finance/petty-cash')).json().accounts.find((a: any) => a.id === petty.id);
    assert.equal(pc.balance, 1_540_000, 'the count is the balance');
    assert.equal(pc.lastCount.difference, -10_000);

    const s = (await call('POST', `/v1/finance/ledger/sync/${localDay().slice(0, 7)}`)).json();
    assert.ok(s.posted >= 1);
    const exp = (await call('GET', `/v1/finance/ledger/entries?source=expenses`)).json().entries[0];
    assert.equal(exp.lines.find((l: any) => l.account === '6310').debit, 250_000);
    assert.ok(exp.lines.some((l: any) => l.account === '1050' && l.credit === 450_000), 'paid from petty cash');
  });
});

dbDescribe('Intercompany', () => {
  test('recharged both ways, seen from both sides, netted and settled; allocated; an outsider refused', async () => {
    const m = monthsBack(1);
    const r1 = (await call('POST', '/v1/finance/intercompany/recharges', { toOrgId: child, month: m, description: 'Shared office rent', amount: 3_000_000, currency: 'IDR' })).json();
    assert.match(r1.number, /^IC-\d{5}$/);
    assert.equal(r1.direction, 'out');
    assert.equal((await call('POST', '/v1/finance/intercompany/recharges', { toOrgId: outsider, month: m, description: 'x', amount: 1, currency: 'IDR' })).statusCode, 422, 'not in the group');
    const seen = (await as(C, () => call('GET', '/v1/finance/intercompany'), true, child)).json();
    assert.equal(seen.recharges.find((x: any) => x.id === r1.id).direction, 'in');
    assert.equal(seen.balances[0].payable, 3_000_000);
    await as(C, () => call('POST', '/v1/finance/intercompany/recharges', { toOrgId: parent, month: m, description: 'Technician days', amount: 1_200_000, currency: 'IDR' }), true, child);

    const alloc = (await call('POST', '/v1/finance/intercompany/allocate', { month: m, description: 'Group insurance', total: 1_000_001, currency: 'IDR', basis: 'equal' })).json();
    assert.equal(alloc.recharges.length, 1);
    assert.equal(alloc.recharges[0].status, 'draft');
    assert.equal(alloc.shares.reduce((a: number, x: any) => a + x.amount, 0), 1_000_001);
    assert.equal((await as(C, () => call('GET', '/v1/finance/intercompany'), true, child)).json().recharges.some((x: any) => x.id === alloc.recharges[0].id), false, 'drafts are not shown to the other entity');
    await call('POST', `/v1/finance/intercompany/recharges/${alloc.recharges[0].id}/issue`);

    const bal = (await call('GET', '/v1/finance/intercompany')).json().balances[0];
    assert.deepEqual({ r: bal.receivable, p: bal.payable, n: bal.net }, { r: 3_000_000 + alloc.recharges[0].amount, p: 1_200_000, n: 3_000_000 + alloc.recharges[0].amount - 1_200_000 });
    const st = (await call('POST', '/v1/finance/intercompany/settle', { otherOrgId: child, currency: 'IDR', reference: 'NET-1' })).json();
    assert.equal(st.recharges, 3);
    assert.equal(st.net, bal.net);
    assert.match(st.direction, /pays you/);
    assert.equal((await call('GET', '/v1/finance/intercompany')).json().balances.length, 0, 'nothing open');
    assert.equal((await call('POST', `/v1/finance/intercompany/recharges/${r1.id}/void`, { reason: 'late' })).statusCode, 409, 'settled');
    const childSettle = (await as(C, () => call('GET', '/v1/finance/intercompany'), true, child)).json().settlements[0];
    assert.equal(childSettle.net, -bal.net, 'the other way round for the subsidiary');

    // Both ledgers post their side.
    await call('POST', `/v1/finance/ledger/sync/${m}`);
    await as(C, () => call('POST', `/v1/finance/ledger/sync/${m}`), true, child);
    const pTb = (await call('GET', `/v1/finance/ledger?month=${m}&currency=IDR`)).json();
    assert.equal(pTb.trialBalance.balanced, true);
    const cTb = (await as(C, () => call('GET', `/v1/finance/ledger?month=${m}&currency=IDR`), true, child)).json();
    assert.equal(cTb.trialBalance.balanced, true);
    assert.equal(cTb.profitAndLoss.month.expense.find((x: any) => x.code === '6900').amount, 3_000_000 + alloc.recharges[0].amount);
  });
});

dbDescribe('Scorecard', () => {
  test('targets, actuals, colours; the e-mail settings checked', async () => {
    const m = monthsBack(1);
    await query(`INSERT INTO finance_org_settings (org_id, reporting_currency) VALUES ($1, 'IDR') ON CONFLICT (org_id) DO UPDATE SET reporting_currency = 'IDR'`, [parent]);
    const t = (await call('PUT', `/v1/finance/scorecard/targets/${m}`, { targets: { revenue: 1_000_000, opex: 2_000_000, cash: 1 } })).json();
    assert.equal(t.targets.revenue, 1_000_000);
    assert.equal((await call('PUT', `/v1/finance/scorecard/targets/${m}`, { targets: { nope: 1 } })).statusCode, 422);
    const copied = (await call('PUT', `/v1/finance/scorecard/targets/${localDay().slice(0, 7)}`, { copyFrom: m, targets: { revenue: 2_000_000 } })).json();
    assert.deepEqual({ r: copied.targets.revenue, o: copied.targets.opex }, { r: 2_000_000, o: 2_000_000 });
    const sc = (await call('GET', `/v1/finance/scorecard?month=${m}`)).json();
    assert.equal(sc.currency, 'IDR');
    const k = (name: string) => sc.kpis.find((x: any) => x.kpi === name);
    assert.deepEqual({ a: k('revenue').actual, rag: k('revenue').rag }, { a: 0, rag: 'red' }, 'no charging in this organisation');
    assert.equal(k('opex').actual, 1_000_000, 'the bill of the month');
    assert.equal(k('opex').rag, 'green');
    assert.equal(k('sessions').rag, null, 'no target');
    assert.equal(sc.trend.length, 6);
    assert.equal((await call('PUT', '/v1/finance/scorecard/settings', { enabled: true })).statusCode, 422, 'no recipients');
    assert.equal((await call('PUT', '/v1/finance/scorecard/settings', { enabled: true, recipients: ['cfo@'] })).statusCode, 422);
    assert.equal((await call('PUT', '/v1/finance/scorecard/settings', { enabled: true, recipients: ['cfo@ledger.test'], day: 5 })).statusCode, 200);
    assert.equal((await call('POST', '/v1/finance/scorecard/send', { month: m })).statusCode, 422, 'no e-mail channel in the test organisation');
  });
});
