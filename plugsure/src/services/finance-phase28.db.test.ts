import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 28 of the finance review (v1.39.0):
 *   - statutory statements from the ledger: balance sheet, P&L, indirect cash flow reconciled to cash, equity, notes;
 *   - corporate income tax: fiscal corrections (automatic depreciation, recorded), Article 31E, credits, PPh 29, deferred
 *     tax, finalised and journalled;
 *   - supplier payment runs: proposed, edited, approved by a second person, the bank file, paid;
 *   - corporate cards: import, policy flags, review rules, statements, the cards journal.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase28.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const st = await import('./statutory.js');
const ct = await import('./corporate-tax.js');
const cc = await import('./corporate-cards.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID(), B = randomUUID();
let org = '';
let app: FastifyInstance;
let actor: string = A;
let perms = ['payment:read', 'payment:write', 'finance:approve'];
let bank = '';
let je = 0;
const zone = config.billing.timeZone;
const localDay = (t: number = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(t));
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });
const as = async <T>(user: string, p: string[], fn: () => Promise<T>) => { const u = actor, q = perms; actor = user as typeof actor; perms = p; try { return await fn(); } finally { actor = u; perms = q; } };

/** A posted ledger entry (IDR): [account, debit, credit]. */
async function post(date: string, lines: Array<[string, number, number]>) {
  const e = (await one<{ id: string }>(`INSERT INTO gl_entry (org_id, number, entry_date, month, currency, source, memo, status, posted_at) VALUES ($1, $2, $3, $4, 'IDR', 'manual', 'Test', 'posted', now()) RETURNING id`,
    [org, `JE-${TAG}-${++je}`, date, date.slice(0, 7)]))!.id;
  for (const [a, d, c] of lines) await query(`INSERT INTO gl_line (org_id, entry_id, account_code, debit, credit) VALUES ($1, $2, $3, $4, $5)`, [org, e, a, d, c]);
}
const M = 1_000_000;

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Statutory ${TAG}`, `p28-${TAG}`]))!.id;
    for (const [u, n] of [[A, 'Rina'], [B, 'Budi']] as const) await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, $4)`, [u, org, `${u.slice(0, 8)}@p28.test`, n]);
    bank = (await one<{ id: string }>(`INSERT INTO cash_account (org_id, name, kind, currency, opening_balance_minor, opening_on) VALUES ($1, 'Operating', 'bank', 'IDR', 0, '2024-01-01') RETURNING id`, [org]))!.id;
    app = Fastify({ bodyLimit: 6 * 1024 * 1024 });
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: actor, orgId: org, assignments: [{ permissions: perms, scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
  });
  after(async () => {
    await app?.close();
    await query(`DELETE FROM gl_line WHERE org_id = $1`, [org]);
    for (const t of ['card_statement', 'card_txn', 'corp_card', 'payment_run_item', 'payment_run', 'supplier_payment', 'supplier_bill', 'supplier', 'tax_payment', 'tax_fiscal_correction', 'corporate_tax_year',
      'fixed_asset', 'gl_entry', 'gl_account', 'finance_org_settings']) await query(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
    await query(`DELETE FROM cash_account WHERE org_id = $1`, [org]);
    await query(`DELETE FROM alert WHERE org_id = $1`, [org]);
    await query(`DELETE FROM app_user WHERE org_id = $1`, [org]).catch(() => { /* audit rows keep them */ });
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => { /* audit rows keep it */ });
    await pool.end();
  });
}

describe('Statutory, tax and card helpers', () => {
  test('cash flow lines, tax with Article 31E, fiscal depreciation, card flags', () => {
    assert.equal(st.lineOf('1100', 'asset'), 'cash');
    assert.equal(st.lineOf('1690', 'asset'), 'fixed_assets');
    assert.equal(st.lineOf('2500', 'liability'), 'noncurrent_liabilities');
    assert.equal(st.lineOf('9100', 'other'), 'income_tax');
    assert.deepEqual(ct.taxOn(35_500_000, 80_000_000, 22, true), { tax: 3_905_000, facilityShare: 100 });
    assert.equal(ct.taxOn(1_000_000_000, 9_600_000_000, 22, true).tax, 165_000_000, 'half the profit at half the rate');
    assert.equal(ct.taxOn(1_000_000_000, 60_000_000_000, 22, true).tax, 220_000_000, 'over Rp 50 billion: no facility');
    assert.equal(ct.taxOn(-5, 1, 22, true).tax, 0);
    assert.deepEqual(ct.fiscalDepreciation(60 * M, '2024-07', 96, 2025), { depreciation: 7_500_000, netValue: 48_750_000 });
    assert.deepEqual(ct.fiscalDepreciation(60 * M, '2024-07', 96, 2024), { depreciation: 3_750_000, netValue: 56_250_000 });
    const pol = { receiptAbove: 100_000, weekendFlag: true, blockedCategories: ['other'], blockedMerchants: ['steam'] };
    const f = cc.flagsFor([
      { id: '1', cardId: 'c', txnOn: '2026-10-03', merchant: 'Pertamina', category: 'fuel', amount: 250_000, hasReceipt: true },
      { id: '2', cardId: 'c', txnOn: '2026-10-05', merchant: 'Hotel', category: 'travel', amount: 1_200_000, hasReceipt: false },
      { id: '3', cardId: 'c', txnOn: '2026-10-06', merchant: 'Grab', category: 'travel', amount: 80_000, hasReceipt: false },
      { id: '4', cardId: 'c', txnOn: '2026-10-06', merchant: 'grab ', category: 'travel', amount: 80_000, hasReceipt: false },
      { id: '5', cardId: 'c', txnOn: '2026-10-07', merchant: 'Steam Games', category: 'other', amount: 900_000, hasReceipt: true },
    ], { singleLimit: 1_000_000, monthlyLimit: 2_000_000 }, pol);
    assert.deepEqual(f.get('1'), ['weekend']);
    assert.deepEqual(f.get('2'), ['over_single_limit', 'no_receipt']);
    assert.deepEqual(f.get('3'), []);
    assert.deepEqual(f.get('4'), ['duplicate']);
    assert.deepEqual(f.get('5'), ['over_monthly_limit', 'blocked_category', 'blocked_merchant']);
  });
});

dbDescribe('Statutory statements and corporate tax (v1.39.0)', () => {
  test('two years of statements reconciled; the tax computation, finalised and journalled', async () => {
    // 2024: capital 100, a charger 60 (July), revenue 50, energy 20, depreciation 7.5 (six months).
    await post('2024-01-10', [['1100', 100 * M, 0], ['3100', 0, 100 * M]]);
    await post('2024-06-20', [['1600', 60 * M, 0], ['1100', 0, 60 * M]]);
    await post('2024-12-31', [['1100', 50 * M, 0], ['4100', 0, 50 * M], ['5100', 20 * M, 0], ['1100', 0, 20 * M], ['6400', 7_500_000, 0], ['1690', 0, 7_500_000]]);
    // 2025: a loan 30, maintenance 8 unpaid, revenue 80, energy 30, depreciation 15.
    await post('2025-03-01', [['1100', 30 * M, 0], ['2500', 0, 30 * M]]);
    await post('2025-06-15', [['6200', 8 * M, 0], ['2100', 0, 8 * M]]);
    await post('2025-12-31', [['1100', 80 * M, 0], ['4100', 0, 80 * M], ['5100', 30 * M, 0], ['1100', 0, 30 * M], ['6400', 15 * M, 0], ['1690', 0, 15 * M]]);

    const s = (await call('GET', '/v1/finance/financial-statements?year=2025')).json();
    assert.equal(s.currency, 'IDR');
    assert.deepEqual(s.checks, { balanced: true, cashFlowReconciles: true });
    assert.deepEqual([s.current.profitAndLoss.revenue, s.current.profitAndLoss.grossProfit, s.current.profitAndLoss.resultBeforeTax, s.prior.profitAndLoss.result], [80 * M, 50 * M, 27 * M, 22_500_000]);
    const bs = s.current.balanceSheet;
    assert.deepEqual([bs.currentAssets, bs.nonCurrentAssets, bs.currentLiabilities, bs.nonCurrentLiabilities, bs.equity.capital, bs.equity.retainedEarnings, bs.equity.result, bs.equity.total],
      [150 * M, 37_500_000, 8 * M, 30 * M, 100 * M, 22_500_000, 27 * M, 149_500_000]);
    assert.deepEqual([s.cashFlow.operating, s.cashFlow.investingTotal, s.cashFlow.financingTotal, s.cashFlow.cashOpen, s.cashFlow.cashClose], [50 * M, 0, 30 * M, 70 * M, 150 * M]);
    assert.deepEqual([s.cashFlowPrior.operating, s.cashFlowPrior.investingTotal, s.cashFlowPrior.financingTotal], [30 * M, -60 * M, 100 * M]);
    assert.deepEqual([s.equity.opening, s.equity.result, s.equity.closing], [122_500_000, 27 * M, 149_500_000]);
    assert.ok(s.notes.find((n: any) => n.line === 'fixed_assets').accounts.some((a: any) => a.code === '1690' && a.amount === -22_500_000));
    for (const f of ['xlsx', 'pdf']) assert.equal((await call('GET', `/v1/finance/financial-statements?year=2025&format=${f}`)).statusCode, 200);

    // The same charger in the asset register: 48 months in the books, 96 fiscally (group 2).
    await query(`INSERT INTO fixed_asset (org_id, tag, category, description, currency, cost_minor, residual_minor, acquired_on, in_service, life_months, method) VALUES ($1, $2, 'chargers', 'DC charger', 'IDR', $3, 0, '2024-06-20', '2024-07', 48, 'straight_line')`, [org, `FA-${TAG}`, 60 * M]);
    assert.equal((await call('POST', '/v1/finance/corporate-tax/corrections', { year: 2025, direction: 'positive', category: 'entertainment', description: 'Entertainment without a nominative list', amount: 2 * M })).statusCode, 201);
    assert.equal((await call('POST', '/v1/finance/corporate-tax/corrections', { year: 2025, direction: 'negative', category: 'final_income', description: 'Deposit interest (final)', amount: 1 * M })).statusCode, 201);
    assert.equal((await call('POST', '/v1/finance/corporate-tax/corrections', { year: 2025, direction: 'up', category: 'other', description: 'x', amount: 1 })).statusCode, 422);
    assert.equal((await call('POST', '/v1/finance/corporate-tax/payments', { year: 2025, kind: 'pph25', month: '2025-05', amount: 1_200_000, paidOn: '2025-06-10', cashAccountId: bank, reference: 'NTPN-1' })).statusCode, 201);
    assert.equal((await call('POST', '/v1/finance/corporate-tax/payments', { year: 2025, kind: 'pph23', amount: 300_000, paidOn: '2025-09-01', reference: 'Bukti potong customer' })).statusCode, 201);
    assert.equal((await call('POST', '/v1/finance/corporate-tax/payments', { year: 2025, kind: 'pph23', amount: 1, paidOn: '2025-09-01', cashAccountId: bank })).statusCode, 422, 'withheld by others: no account');

    let c = (await call('GET', '/v1/finance/corporate-tax?year=2025')).json();
    const dep = c.corrections.find((x: any) => x.category === 'depreciation');
    assert.deepEqual([dep.direction, dep.amount], ['positive', 7_500_000], 'book 15 against fiscal 7.5');
    assert.deepEqual([c.resultBeforeTax, c.positive, c.negative, c.fiscalProfit, c.facilitySharePct, c.tax], [27 * M, 9_500_000, 1 * M, 35_500_000, 100, 3_905_000]);
    assert.deepEqual([c.credits.pph25, c.credits.pph23, c.pph29, c.nextPph25], [1_200_000, 300_000, 2_405_000, 300_417]);
    assert.deepEqual([c.deferred.items.find((i: any) => i.item === 'fixed_assets').amount, c.deferred.net, c.deferred.asset], [-11_250_000, -2_475_000, 2_475_000]);
    assert.equal((await call('PUT', '/v1/finance/corporate-tax/settings', { facility31e: false })).statusCode, 200);
    assert.equal((await call('GET', '/v1/finance/corporate-tax?year=2025')).json().tax, 7_810_000, 'without Article 31E: 22%');
    await call('PUT', '/v1/finance/corporate-tax/settings', { facility31e: true });

    assert.equal((await as(B, ['payment:read', 'payment:write'], () => call('POST', '/v1/finance/corporate-tax/2025/decide', { action: 'finalise' }))).statusCode, 403);
    assert.equal((await call('POST', `/v1/finance/corporate-tax/${new Date().getFullYear()}/decide`, { action: 'finalise' })).statusCode, 422, 'not before the year ends');
    c = (await call('POST', '/v1/finance/corporate-tax/2025/decide', { action: 'finalise' })).json();
    assert.equal(c.status, 'final');
    assert.equal((await call('POST', '/v1/finance/corporate-tax/corrections', { year: 2025, direction: 'positive', category: 'fines', description: 'Late filing fine', amount: 100_000 })).statusCode, 409, 'final');
    const dec = await ct.journal(org, '2025-12'), may = await ct.journal(org, '2025-06');
    const L = dec.IDR!, sum = (a: string, k: 'debit' | 'credit') => L.filter((l) => l.account === a).reduce((x, l) => x + l[k], 0);
    assert.deepEqual([sum('9100', 'debit'), sum('2700', 'credit'), sum('1460', 'credit'), sum('1465', 'credit'), sum('1470', 'debit'), sum('9110', 'credit')], [3_905_000, 3_905_000, 1_200_000, 300_000, 2_475_000, 2_475_000]);
    assert.deepEqual(may.IDR!.map((l) => [l.account, l.debit, l.credit]), [['1460', 1_200_000, 0], ['1100', 0, 1_200_000]]);
    assert.equal((await call('GET', '/v1/finance/corporate-tax?year=2025&format=xlsx')).statusCode, 200);
    assert.equal((await call('POST', '/v1/finance/corporate-tax/2025/decide', { action: 'reopen' })).json().status, 'draft');
  });
});

dbDescribe('Supplier payment runs (v1.39.0)', () => {
  test('proposed, edited, approved by a second person, the bank file and paid', async () => {
    const t = localDay();
    const sup = async (n: string, withBank: boolean) => (await one<{ id: string }>(`INSERT INTO supplier (org_id, name, bank_name, account_number, account_name, email) VALUES ($1, $2, $3, $4, $5, 'ap@sup.test') RETURNING id`,
      [org, `${n} ${TAG}`, withBank ? 'BCA' : null, withBank ? '123-456-7890' : null, withBank ? `PT ${n}` : null]))!.id;
    const s1 = await sup('Teknik', true), s2 = await sup('Kabel', false);
    const bill = async (s: string, amt: number, due: string) => (await one<{ id: string }>(
      `INSERT INTO supplier_bill (org_id, supplier_id, number, category, description, currency, subtotal_minor, vat_minor, wht_minor, bill_date, due_date, status) VALUES ($1, $2, $3, 'maintenance', 'Service', 'IDR', $4, 0, 0, $5, $6, 'approved') RETURNING id`,
      [org, s, `INV-${TAG}-${randomBytes(2).toString('hex')}`, amt, addDays(t, -20), due]))!.id;
    const b1 = await bill(s1, 1_000_000, addDays(t, -5)), b2 = await bill(s1, 500_000, addDays(t, 3)), b3 = await bill(s2, 300_000, addDays(t, -1));
    await bill(s1, 700_000, addDays(t, 30));
    const p = await call('POST', '/v1/finance/payment-runs', { cashAccountId: bank, payOn: t, dueBy: addDays(t, 7) });
    assert.equal(p.statusCode, 201, p.body);
    let r = p.json();
    assert.deepEqual([r.number, r.items.length, r.total, r.missingBank], ['PR-00001', 3, 1_800_000, [`Kabel ${TAG}`]]);
    assert.equal((await call('POST', '/v1/finance/payment-runs', { cashAccountId: bank, payOn: t, dueBy: addDays(t, 7) })).statusCode, 422, 'the bills are in an open run');
    const i1 = r.items.find((i: any) => i.billId === String(b1)).id, i3 = r.items.find((i: any) => i.billId === String(b3)).id;
    assert.equal((await call('PUT', `/v1/finance/payment-runs/${r.id}/items`, { amounts: { [i1]: 2_000_000 } })).statusCode, 422, 'over the balance');
    r = (await call('PUT', `/v1/finance/payment-runs/${r.id}/items`, { amounts: { [i1]: 600_000 }, remove: [i3] })).json();
    assert.deepEqual([r.items.length, r.total, r.missingBank], [2, 1_100_000, []]);
    assert.equal((await call('GET', `/v1/finance/payment-runs/${r.id}/bank-file`)).statusCode, 409, 'not before approval');
    await call('POST', `/v1/finance/payment-runs/${r.id}/submit`);
    assert.equal((await call('POST', `/v1/finance/payment-runs/${r.id}/decide`, { approve: true })).statusCode, 403, 'not the proposer');
    assert.equal((await as(B, ['payment:read', 'payment:write'], () => call('POST', `/v1/finance/payment-runs/${r.id}/decide`, { approve: true }))).statusCode, 403, 'a Finance Manager');
    r = (await as(B, ['payment:read', 'payment:write', 'finance:approve'], () => call('POST', `/v1/finance/payment-runs/${r.id}/decide`, { approve: true }))).json();
    assert.equal(r.status, 'approved');
    const f = await call('GET', `/v1/finance/payment-runs/${r.id}/bank-file?format=bca`);
    assert.equal(f.statusCode, 200);
    assert.match(f.body, /^No,Account Number,Account Name,Amount/);
    assert.match(f.body, /1,1234567890,PT Teknik,1100000,PR-00001/);
    r = (await call('POST', `/v1/finance/payment-runs/${r.id}/paid`, { paidOn: t })).json();
    assert.equal(r.status, 'paid');
    const pays = await many<any>(`SELECT bill_id::text AS b, amount_minor, reference, cash_account_id::text AS a FROM supplier_payment WHERE org_id = $1 ORDER BY amount_minor`, [org]);
    assert.deepEqual(pays.map((x) => [x.b, Number(x.amount_minor), x.reference, x.a]), [[String(b2), 500_000, 'PR-00001', String(bank)], [String(b1), 600_000, 'PR-00001', String(bank)]]);
    assert.deepEqual((await many<any>(`SELECT id::text AS id, status FROM supplier_bill WHERE id = ANY($1::bigint[]) ORDER BY id`, [[b1, b2]])).map((x) => x.status), ['approved', 'paid'], 'b1 part paid');
    assert.equal((await call('POST', `/v1/finance/payment-runs/${r.id}/cancel`, { reason: 'x' })).statusCode, 409);
    // b1's remaining 400 000 and b3 can go in a new run.
    assert.equal((await call('POST', '/v1/finance/payment-runs', { cashAccountId: bank, payOn: t, dueBy: addDays(t, 7) })).json().total, 700_000);
  });
});

dbDescribe('Corporate cards (v1.39.0)', () => {
  test('import with policy flags, review rules, the statement and the cards journal', async () => {
    assert.equal((await call('POST', '/v1/finance/cards', { holderName: 'Budi', bank: 'BCA', last4: '4111111111111111', currency: 'IDR' })).statusCode, 422, 'never the full number');
    const card = (await call('POST', '/v1/finance/cards', { holderId: B, holderName: 'Budi', bank: 'BCA', last4: '4321', currency: 'IDR', singleLimit: 1_000_000, monthlyLimit: 2_000_000, cashAccountId: bank })).json();
    assert.equal(card.masked, '•••• 4321');
    await call('PUT', '/v1/finance/cards/policy', { blockedMerchants: ['Steam'] });
    const csv = 'Date,Merchant,Amount,Reference,Category\n2026-10-03,Pertamina,250000,REF1,fuel\n2026-10-05,Hotel Santika,"1.200.000",REF2,\n2026-10-06,Grab,80000,,travel\n2026-10-06,Grab,80000,,travel\n2026-10-07,Steam Games,900000,REF4,other\n';
    let im = (await call('POST', `/v1/finance/cards/${card.id}/import`, { csv })).json();
    assert.deepEqual([im.added, im.skipped], [5, 0]);
    im = (await call('POST', `/v1/finance/cards/${card.id}/import`, { csv })).json();
    assert.deepEqual([im.added, im.skipped], [0, 5], 'already imported');
    let ts = (await call('GET', `/v1/finance/cards/transactions?cardId=${card.id}`)).json().transactions;
    const by = (m: string) => ts.filter((t: any) => t.merchant === m);
    assert.deepEqual(by('Pertamina')[0].flags, ['weekend', 'no_receipt']);
    assert.deepEqual(by('Hotel Santika')[0].flags, ['over_single_limit', 'no_receipt']);
    assert.deepEqual(by('Grab').map((t: any) => t.flags.join()).sort(), ['', 'duplicate']);
    assert.deepEqual(by('Steam Games')[0].flags, ['over_monthly_limit', 'blocked_merchant', 'no_receipt']);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
    assert.equal((await call('PUT', `/v1/finance/cards/transactions/${by('Pertamina')[0].id}/receipt`, { mime: 'image/png', filename: 'struk.png', data: png })).statusCode, 200);
    assert.equal((await call('PUT', `/v1/finance/cards/transactions/${by('Pertamina')[0].id}/receipt`, { mime: 'image/png', data: Buffer.from('hello').toString('base64') })).statusCode, 422, 'not a PNG');
    ts = (await call('GET', `/v1/finance/cards/transactions?cardId=${card.id}`)).json().transactions;
    assert.deepEqual(by('Pertamina')[0].flags, ['weekend']);
    assert.equal((await call('GET', `/v1/finance/cards/transactions/${by('Pertamina')[0].id}/receipt`)).headers['content-type'], 'image/png');

    const grab = by('Grab').find((t: any) => !t.flags.length).id, dup = by('Grab').find((t: any) => t.flags.length).id;
    assert.equal((await as(B, perms, () => call('POST', `/v1/finance/cards/transactions/${grab}/review`, { action: 'approve' }))).statusCode, 403, 'not on your own card');
    assert.equal((await call('POST', `/v1/finance/cards/transactions/${grab}/review`, { action: 'approve' })).json().status, 'approved');
    const hotel = by('Hotel Santika')[0].id;
    assert.equal((await as(randomUUID(), ['payment:read', 'payment:write'], () => call('POST', `/v1/finance/cards/transactions/${hotel}/review`, { action: 'approve', note: 'ok' }))).statusCode, 403, 'flagged: a Finance Manager');
    assert.equal((await call('POST', `/v1/finance/cards/transactions/${hotel}/review`, { action: 'approve' })).statusCode, 422, 'flagged: with a note');
    assert.equal((await call('POST', `/v1/finance/cards/transactions/${hotel}/review`, { action: 'approve', category: 'travel', note: 'Site visit Surabaya, receipt to follow' })).json().category, 'travel');
    assert.equal((await call('POST', `/v1/finance/cards/transactions/${by('Steam Games')[0].id}/review`, { action: 'reject' })).statusCode, 422);
    await call('POST', `/v1/finance/cards/transactions/${by('Steam Games')[0].id}/review`, { action: 'reject', note: 'Personal: deducted from the next salary' });
    await call('POST', `/v1/finance/cards/transactions/${dup}/review`, { action: 'reject', note: 'Charged twice: disputed with the bank' });

    const stmt = (await call('PUT', `/v1/finance/cards/${card.id}/statements`, { month: '2026-10', total: 2_510_000, paidOn: '2026-10-25' })).json();
    assert.deepEqual([stmt.transactions, stmt.difference, stmt.paidOn], [2_510_000, 0, '2026-10-25']);
    const ov = (await call('GET', '/v1/finance/cards?month=2026-10')).json();
    const oc = ov.cards.find((c: any) => c.id === card.id);
    assert.deepEqual([oc.spent, oc.usedPct, oc.owedByHolder, oc.open], [2_510_000, 125.5, 980_000, 1]);

    const j = (await cc.journal(org, '2026-10')).IDR!;
    const s = (a: string, k: 'debit' | 'credit') => j.filter((l) => l.account === a).reduce((x, l) => x + l[k], 0);
    assert.deepEqual([s('6310', 'debit'), s('6320', 'debit'), s('1480', 'debit'), s('2165', 'credit'), s('2165', 'debit'), s('1100', 'credit')], [250_000, 1_280_000, 980_000, 2_510_000, 2_510_000, 2_510_000]);
    assert.equal((await call('GET', '/v1/finance/cards/transactions?format=xlsx')).statusCode, 200);
  });
});
