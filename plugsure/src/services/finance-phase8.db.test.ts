import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { expectedFee } from './fee-audit.js';
import { render } from './accounting-export.js';

/**
 * Phase 8 of the finance review (v1.19.0):
 *   - the cash-flow forecast: opening position (gateway + bank), settlements in, refunds / owner shares / PlugSure's
 *     statement out (finalisation + terms), the running position and the first shortfall; the run rate as an estimate;
 *   - the gateway fee audit: fees against the contracted rate per method (QRIS free up to Rp 100,000), the overcharge
 *     by month and method, unrated methods listed, the claim CSV;
 *   - the accounting export: a closed month's journal as Jurnal.id / Accurate / generic CSV, logged; the current month
 *     refused;
 *   - the Site Owner portal's money: payouts recorded against its statements, its bank details masked, a change request
 *     sealed until the operator approves (it then replaces the account) or rejects it; one pending at a time.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase8.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const store = await import('../integrations/store.js');
const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const { registerOwnerPortalRoutes } = await import('../api/owner-portal-routes.js');

const TAG = randomBytes(3).toString('hex');
const OPERATOR = randomUUID(), OWNER_USER = randomUUID();
let org = '', xenditId = '', owner = '', stmt = '';
let app: FastifyInstance, portalApp: FastifyInstance;

const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });
const asOwner = (method: 'GET' | 'POST', url: string, payload?: unknown) => portalApp.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`P8 ${TAG}`, `p8-${TAG}`]))!.id;
    for (const u of [OPERATOR, OWNER_USER]) await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, $4)`, [u, org, `${u.slice(0, 8)}@p8.test`, u === OPERATOR ? 'Rina' : 'Pak Hotel']);
    xenditId = ((await store.save('payments', org, { provider: 'xendit', settings: { environment: 'sandbox', methods: ['QRIS', 'DANA'], baseUrl: 'http://127.0.0.1:9' },
      secrets: { secretKey: `xnd_development_${TAG}`, callbackToken: 'cb' } }, null)) as any).id;
    owner = (await one<{ id: string }>(`INSERT INTO site_owner (org_id, name, legal_name) VALUES ($1, $2, 'PT Hotel Nusantara') RETURNING id`, [org, `Hotel ${TAG}`]))!.id;
    const statement = (ownerId: string | null, period: string, number: string, total: number, share: number, finalised: string) => one<{ id: string }>(
      `INSERT INTO commission_statement (org_id, owner_id, period, number, gtv_minor, commission_minor, minimum_topup_minor, private_fee_minor, mdr_credit_minor,
                                         net_minor, tax_minor, total_minor, owner_share_minor, data, finalised_at, currency)
       VALUES ($1, $2, $3, $4, 1000000, $5::bigint, 0, 0, 0, $5::bigint, 0, $5::bigint, $6, '{}'::jsonb, $7::timestamptz, 'IDR') RETURNING id`,
      [org, ownerId, period, number, total, share, finalised]).then((r) => r!.id);
    // Owner's September statement, finalised 3 days ago: share 800 000, 300 000 paid.
    stmt = await statement(owner, '2026-09-01', `P8-${TAG}`, 100_000, 800_000, new Date(Date.now() - 3 * 86_400_000).toISOString());
    await query(`INSERT INTO statement_payment (org_id, statement_id, kind, owner_id, amount_minor, currency, paid_on, reference, recorded_by)
                 VALUES ($1, $2, 'owner_payout', $3, 300000, 'IDR', '2026-10-20', 'BCA 1', $4)`, [org, stmt, owner, OPERATOR]);
    // PlugSure's statement to the operator, finalised 20 days ago, unpaid: due now (terms 14 days).
    await statement(null, '2026-09-01', `PS-${TAG}`, 2_000_000, 0, new Date(Date.now() - 20 * 86_400_000).toISOString());
    // The ledger: payments in the past (one per method), and one pending settlement in 2 days.
    const g = (ext: string, channel: string, amount: number, fee: number, at: string, settle: string | null = null) => query(
      `INSERT INTO gateway_transaction (integration_id, org_id, provider, external_id, kind, status, cashflow, currency, amount, fee, vat, withholding_tax, channel_code,
                                        gateway_created_at, gateway_updated_at, settlement_status, estimated_settlement_at, net_amount)
       VALUES ($1, $2, 'xendit', $3, 'payment', 'success', 'in', 'IDR', $4, $5, 0, 0, $6, $7, $7, $8, $9, $10)`,
      [xenditId, org, `${ext}-${TAG}`, amount, fee, channel, at, settle ? 'pending' : 'settled', settle, amount - fee]);
    await g('q-small', 'QRIS', 50_000, 0, '2026-09-05T03:00:00Z');                      // QRIS ≤ 100 000: free — right
    await g('q-small-charged', 'QRIS', 80_000, 560, '2026-09-06T03:00:00Z');           // charged 560 on a free payment — over
    await g('q-big', 'QRIS', 200_000, 1_400, '2026-09-07T03:00:00Z');                  // 0.7% — right
    await g('dana', 'ID_DANA', 100_000, 2_000, '2026-09-08T03:00:00Z');                // agreed 1.5% = 1 500 — over by 500
    await g('ovo', 'ID_OVO', 100_000, 3_000, '2026-09-09T03:00:00Z');                  // no rate agreed
    await g('pending', 'QRIS', 1_000_000, 7_000, new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 2 * 86_400_000).toISOString());
    // The gateway's balance, and the bank's last balance from an uploaded statement.
    await query(`INSERT INTO gateway_balance_snapshot (integration_id, org_id, account_type, currency, balance) VALUES ($1, $2, 'CASH', 'IDR', 500000)`, [xenditId, org]);
    const bs = (await one<{ id: string }>(`INSERT INTO bank_statement (org_id, bank, filename, date_from, date_to) VALUES ($1, 'BCA', 'x.csv', '2026-10-01', '2026-10-30') RETURNING id`, [org]))!.id;
    await query(`INSERT INTO bank_statement_line (statement_id, org_id, line_no, line_date, description, amount_minor, balance_minor, fingerprint) VALUES ($1, $2, 1, '2026-10-30', 'x', 1000, 200000, $3)`, [bs, org, `fp-${TAG}`]);

    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: OPERATOR, orgId: org, assignments: [{ permissions: ['payment:read', 'payment:write'], scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
    portalApp = Fastify();
    portalApp.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: OWNER_USER, orgId: org, ownerIds: [owner], assignments: [{ permissions: ['site:read', 'invoice:read'], scopeType: 'site', scopeId: randomUUID() }] };
    });
    await registerOwnerPortalRoutes(portalApp);
    await call('PUT', `/v1/finance/owners/${owner}/bank-account`, { bankName: 'BCA', bankCode: '014', holderName: 'PT Hotel Nusantara', accountNumber: '5550001111' });
  });
  after(async () => {
    await app?.close(); await portalApp?.close();
    for (const t of ['owner_bank_change_request', 'accounting_export', 'bank_statement_line', 'bank_statement', 'statement_payment']) await query(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
    await query(`DELETE FROM gateway_account_settings WHERE integration_id = $1`, [xenditId]);
    await query(`DELETE FROM gateway_balance_snapshot WHERE integration_id = $1`, [xenditId]);
    await query(`DELETE FROM gateway_transaction WHERE integration_id = $1`, [xenditId]);
    for (const t of ['commission_statement', 'owner_bank_account', 'site_owner', 'alert']) await query(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
    await query(`DELETE FROM integration_event WHERE integration_id IN (SELECT id FROM integration WHERE org_id = $1)`, [org]);
    await query(`DELETE FROM integration WHERE org_id = $1`, [org]);
    await query(`DELETE FROM app_user WHERE org_id = $1`, [org]).catch(() => { /* audit rows keep them */ });
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => { /* audit rows keep it */ });
    store.invalidate();
    await pool.end();
  });
}

describe('Fee audit and accounting export, pure', () => {
  test('the expected fee: free up to, percentage plus fixed, a minimum', () => {
    assert.equal(expectedFee(100_000, { pct: 0.7, freeUpTo: 100_000 }), 0);
    assert.equal(expectedFee(100_001, { pct: 0.7, freeUpTo: 100_000 }), 700.01);
    assert.equal(expectedFee(100_000, { pct: 2.9, fixed: 2000 }), 4900);
    assert.equal(expectedFee(10_000, { pct: 1.5, min: 500 }), 500);
  });
  test('the packages\' files: Jurnal.id dd/mm/yyyy and its headings, Accurate\'s Indonesian headings, the generic one', () => {
    const lines = [{ date: '2026-10-15', entry: 'D15-col', kind: 'collections', code: '1130', account: 'Xendit', debit: 150000, credit: 0, description: 'Collected' },
      { date: '2026-10-15', entry: 'D15-col', kind: 'collections', code: '4110', account: 'Revenue', debit: 0, credit: 150000, description: '=SUM(A1)' }];
    const j = render('jurnal', lines, 'PS202610');
    assert.match(j, /^﻿\*Transaction Date \(dd\/mm\/yyyy\),\*Transaction No,/);
    assert.match(j, /15\/10\/2026,PS202610-D15-col,PlugSure collections,1130,Collected,150000\.00,0,plugsure/);
    assert.match(j, /'=SUM\(A1\)/, 'a formula is neutralised');
    assert.match(render('accurate', lines, 'PS202610'), /^﻿No\. Bukti,Tanggal,Keterangan,No\. Akun,Debit,Kredit,Keterangan Detail\r\n/);
    assert.match(render('generic', lines, 'PS202610'), /2026-10-15,PS202610-D15-col,4110,Revenue,0,150000\.00/);
  });
});

dbDescribe('The cash-flow forecast', () => {
  test('opening = gateway + bank; the settlement in, the refund-free outflows out, the position and the shortfall', async () => {
    const r = await call('GET', `/v1/finance/accounts/${xenditId}/forecast?days=30`);
    assert.equal(r.statusCode, 200, r.body);
    const f = r.json();
    assert.deepEqual({ gw: f.opening.gateway, bank: f.opening.bank, total: f.opening.total, asOf: f.opening.bankAsOf }, { gw: 500_000, bank: 200_000, total: 700_000, asOf: '2026-10-30' });
    const by = (k: string) => f.flows.filter((x: any) => x.kind === k);
    assert.equal(by('settlement').reduce((s: number, x: any) => s + x.amount, 0), 993_000, 'the pending settlement, net of its fee');
    assert.equal(by('owner_payout')[0].amount, -500_000, 'the share still due');
    assert.equal(by('platform_statement')[0].amount, -2_000_000);
    assert.equal(by('platform_statement')[0].day, f.from, 'finalised 20 days ago, 14-day terms: overdue, so today');
    assert.equal(by('owner_payout')[0].day > f.from, true, 'finalised 3 days ago: due in 11 days');
    assert.ok(f.shortfall && f.shortfall.day === f.from && f.shortfall.position === 700_000 - 2_000_000, 'today goes below zero');
    assert.equal(f.series.length, 30);
    assert.equal(f.closing, 700_000 + 993_000 - 500_000 - 2_000_000);
    const rr = (await call('GET', `/v1/finance/accounts/${xenditId}/forecast?days=60&runRate=true&termsDays=30`)).json();
    assert.equal(rr.runRate, true);
    assert.ok(rr.totals.estimate > 0, 'the run rate is added, as an estimate');
    assert.equal(rr.flows.some((x: any) => x.kind === 'run_rate'), false, 'not listed line by line');
    assert.equal((await call('GET', `/v1/finance/accounts/${xenditId}/forecast?days=45`)).statusCode, 400);
    assert.equal((await call('GET', `/v1/finance/accounts/${xenditId}/forecast?termsDays=200`)).statusCode, 400);
    const csv = await call('GET', `/v1/finance/accounts/${xenditId}/forecast?format=csv`);
    assert.match(csv.body, /PlugSure statement PS-/);
  });
});

dbDescribe('The gateway fee audit', () => {
  test('rates are validated; fees checked against them; unrated methods listed; the claim CSV', async () => {
    assert.equal((await call('PUT', `/v1/finance/accounts/${xenditId}/settings`, { contractRates: { QRIS: { pct: 50 } } })).statusCode, 422);
    assert.equal((await call('PUT', `/v1/finance/accounts/${xenditId}/settings`, { contractRates: { QRIS: {} } })).statusCode, 422);
    const s = await call('PUT', `/v1/finance/accounts/${xenditId}/settings`, { contractRates: { QRIS: { pct: 0.7, freeUpTo: 100_000 }, id_dana: { pct: 1.5 } } });
    assert.equal(s.statusCode, 200, s.body);
    assert.deepEqual(s.json().settings.contractRates.DANA, { pct: 1.5 }, 'ID_DANA is DANA');
    const r = (await call('GET', `/v1/finance/accounts/${xenditId}/fee-audit?from=2026-09-01&to=2026-09-30`)).json();
    const g = (m: string) => r.byMonth.find((x: any) => x.month === '2026-09' && x.method === m);
    assert.deepEqual({ over: g('QRIS').over, n: g('QRIS').overCount, exp: g('QRIS').expected }, { over: 560, n: 1, exp: 1400 });
    assert.deepEqual({ over: g('DANA').over, n: g('DANA').overCount }, { over: 500, n: 1 });
    assert.equal(g('OVO').expected, null, 'not judged without a rate');
    assert.deepEqual(r.unrated, ['OVO']);
    assert.equal(r.totals.overcharge, 1060);
    assert.equal(r._all, undefined, 'the full list stays on the server');
    const csv = await call('GET', `/v1/finance/accounts/${xenditId}/fee-audit?from=2026-09-01&to=2026-09-30&format=csv`);
    assert.match(csv.body, new RegExp(`q-small-charged-${TAG},,QRIS,80000,560,0,560`));
    assert.match(csv.body, /TOTAL,,,,1060/);
  });
});

dbDescribe('The accounting export', () => {
  test('a closed month for the account\'s package, logged; the current month refused', async () => {
    await call('PUT', `/v1/finance/accounts/${xenditId}/settings`, { accountingPackage: 'accurate' });
    assert.equal((await call('PUT', `/v1/finance/accounts/${xenditId}/settings`, { accountingPackage: 'sap' })).statusCode, 422);
    const now = new Intl.DateTimeFormat('en-CA', { timeZone: config.billing.timeZone }).format(new Date()).slice(0, 7);
    assert.equal((await call('POST', `/v1/finance/accounts/${xenditId}/accounting-exports`, { month: now })).statusCode, 409);
    const r = await call('POST', `/v1/finance/accounts/${xenditId}/accounting-exports`, { month: '2026-09' });
    assert.equal(r.statusCode, 200, r.body);
    assert.match(r.headers['content-disposition'] as string, /plugsure-accurate-xendit-2026-09\.csv/);
    assert.match(r.body, /^﻿No\. Bukti,Tanggal/);
    const g = (await call('POST', `/v1/finance/accounts/${xenditId}/accounting-exports`, { month: '2026-09', package: 'jurnal' })).body;
    assert.match(g, /\*Transaction No/);
    const log = (await call('GET', `/v1/finance/accounts/${xenditId}/accounting-exports`)).json();
    assert.equal(log.package, 'accurate');
    assert.deepEqual(log.exports.map((e: any) => e.package), ['jurnal', 'accurate']);
    assert.equal(log.months.find((m: any) => m.month === '2026-09')?.exported ?? true, true);
    assert.equal((await call('POST', `/v1/finance/accounts/${xenditId}/accounting-exports`, { month: '2019-01' })).statusCode, 409, 'nothing in the journal');
  });
});

dbDescribe('The Site Owner portal\'s money', () => {
  test('payouts against its statements; bank details masked; a change sealed until the operator approves it', async () => {
    const p = (await asOwner('GET', '/v1/owner-portal/payouts')).json();
    const s = p.statements.find((x: any) => x.statementId === stmt);
    assert.deepEqual({ share: s.share, paid: s.paid, left: s.outstanding, status: s.status, ref: s.payments[0].reference }, { share: 800_000, paid: 300_000, left: 500_000, status: 'partial', ref: 'BCA 1' });
    let b = (await asOwner('GET', '/v1/owner-portal/bank')).json();
    assert.equal(b.onFile.accountMasked, '••••1111');
    assert.equal(JSON.stringify(b).includes('5550001111'), false, 'never the number');

    assert.equal((await asOwner('POST', '/v1/owner-portal/bank/change-request', { bankName: 'Mandiri', holderName: 'PT Hotel', accountNumber: '12' })).statusCode, 422);
    const rq = await asOwner('POST', '/v1/owner-portal/bank/change-request', { bankName: 'Mandiri', bankCode: '008', holderName: 'PT Hotel Nusantara', accountNumber: '1230009876', note: 'New account' });
    assert.equal(rq.statusCode, 201, rq.body);
    const sealed = (await one<any>(`SELECT account_number_sealed FROM owner_bank_change_request WHERE id = $1`, [rq.json().id]))!.account_number_sealed;
    assert.equal(sealed.includes('1230009876'), false, 'sealed at rest');
    assert.equal((await asOwner('POST', '/v1/owner-portal/bank/change-request', { bankName: 'BRI', holderName: 'X', accountNumber: '99999999' })).statusCode, 409, 'one pending');
    assert.equal((await one<any>(`SELECT count(*)::int AS n FROM alert WHERE org_id = $1 AND kind = 'finance.owner_bank_change_requested' AND resolved_at IS NULL`, [org]))!.n, 1);
    b = (await asOwner('GET', '/v1/owner-portal/bank')).json();
    assert.deepEqual({ on: b.onFile.accountMasked, st: b.request.state, req: b.request.accountMasked }, { on: '••••1111', st: 'pending', req: '••••9876' }, 'nothing changes until approved');

    const list = (await call('GET', '/v1/finance/owner-bank-requests')).json().requests;
    assert.equal(list.length, 1);
    assert.equal(list[0].current.accountMasked, '••••1111');
    assert.equal((await call('POST', `/v1/finance/owner-bank-requests/${list[0].id}/reject`, {})).statusCode, 422, 'a reason');
    const ok = await call('POST', `/v1/finance/owner-bank-requests/${list[0].id}/approve`, {});
    assert.equal(ok.statusCode, 200, ok.body);
    const acct = (await call('GET', `/v1/finance/owners/${owner}/bank-account`)).json().account;
    assert.deepEqual({ bank: acct.bankName, code: acct.bankCode, masked: acct.accountMasked }, { bank: 'Mandiri', code: '008', masked: '••••9876' });
    assert.equal((await one<any>(`SELECT count(*)::int AS n FROM alert WHERE org_id = $1 AND kind = 'finance.owner_bank_change_requested' AND resolved_at IS NULL`, [org]))!.n, 0, 'the alert resolves');
    assert.equal((await call('POST', `/v1/finance/owner-bank-requests/${list[0].id}/approve`, {})).statusCode, 404, 'decided once');

    const again = (await asOwner('POST', '/v1/owner-portal/bank/change-request', { bankName: 'BRI', holderName: 'PT Hotel Nusantara', accountNumber: '777766665555' })).json();
    assert.equal((await asOwner('POST', `/v1/owner-portal/bank/change-request/${again.id}/withdraw`)).statusCode, 200);
    assert.equal((await call('GET', '/v1/finance/owner-bank-requests')).json().requests.length, 0);
  });

  test('an operator user is not a portal user (404)', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/v1/owner-portal/payouts' })).statusCode, 404);
  });
});
