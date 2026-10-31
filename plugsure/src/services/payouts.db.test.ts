import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Payouts and statement payments, recorded (v1.14.0):
 *   - owner bank details: validated, the number sealed and masked, kept when only the name changes;
 *   - owner shares: due → part-paid → paid as transfers are recorded; over-payment and bad input refused;
 *     a voided payment makes it due again; never deleted;
 *   - the transfer list: what is outstanding with the full account number (payment:write only, audited);
 *   - operators' statements to PlugSure: platform administrators only;
 *   - isolation: another operator sees none of it; Finance's payables carry the paid status.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/payouts.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');

const TAG = randomBytes(3).toString('hex');
let org = '', other = '', owner = '', ownerStmt = '', opStmt = '';
let app: FastifyInstance;
let role: 'finance' | 'reader' | 'platform' | 'other' = 'finance';

const stmt = async (o: { owner?: string | null; share?: number; total?: number; period: string }) => (await one<{ id: string }>(
  `INSERT INTO commission_statement (org_id, owner_id, period, number, gtv_minor, commission_minor, minimum_topup_minor, private_fee_minor, mdr_credit_minor,
                                     net_minor, tax_minor, total_minor, owner_share_minor, data, finalised_at, currency)
   VALUES ($1, $2, $3::date, $4, 1000000, 100000, 0, 0, 0, 100000, 11000, $5, $6, '{}'::jsonb, now(), 'IDR') RETURNING id`,
  [org, o.owner ?? null, o.period, `ST-${TAG}-${randomBytes(3).toString('hex')}`, o.total ?? 111000, o.share ?? null]))!.id;

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1,$2) RETURNING id`, [`Pay ${TAG}`, `pay-${TAG}`]))!.id;
    other = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1,$2) RETURNING id`, [`Pay other ${TAG}`, `pay-other-${TAG}`]))!.id;
    owner = (await one<{ id: string }>(`INSERT INTO site_owner (org_id, name, legal_name) VALUES ($1, $2, $3) RETURNING id`, [org, `Hotel ${TAG}`, `PT Hotel ${TAG}`]))!.id;
    ownerStmt = await stmt({ owner, share: 1_250_000, period: '2026-09-01' });
    opStmt = await stmt({ total: 5_550_000, period: '2026-09-01' });
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      const perms = role === 'finance' || role === 'other' ? ['payment:read', 'payment:write'] : role === 'reader' ? ['payment:read'] : ['payment:read', 'payment:write', 'platform:admin'];
      (req as any).principal = { userId: randomUUID(), orgId: role === 'other' ? other : org, assignments: [{ permissions: perms, scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
  });
  after(async () => {
    await app?.close();
    await query(`DELETE FROM statement_payment WHERE org_id = $1`, [org]);
    await query(`DELETE FROM owner_bank_account WHERE org_id = $1`, [org]);
    await query(`DELETE FROM commission_statement WHERE org_id = $1`, [org]);
    await query(`DELETE FROM site_owner WHERE org_id = $1`, [org]);
    for (const o of [org, other]) await query(`DELETE FROM organisation WHERE id = $1`, [o]).catch(() => { /* audit rows keep it */ });
    await pool.end();
  });
}

const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });

dbDescribe('Payouts and statement payments', () => {
  test('owner bank details: validated, sealed, masked; the number kept when only the name changes', async () => {
    assert.equal((await call('GET', `/v1/finance/owners/${owner}/bank-account`)).statusCode, 404);
    assert.equal((await call('PUT', `/v1/finance/owners/${owner}/bank-account`, { bankName: 'BCA', holderName: 'PT Hotel' })).statusCode, 422, 'the number the first time');
    assert.equal((await call('PUT', `/v1/finance/owners/${owner}/bank-account`, { bankName: 'BCA', holderName: 'PT Hotel', accountNumber: '12ab' })).statusCode, 422);
    const r = await call('PUT', `/v1/finance/owners/${owner}/bank-account`, { bankName: 'BCA', bankCode: '014', holderName: `PT Hotel ${TAG}`, accountNumber: '123 456 7890' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().account.accountMasked, '••••7890');
    const row = (await one<any>(`SELECT * FROM owner_bank_account WHERE owner_id = $1`, [owner]))!;
    assert.ok(!row.account_number_sealed.includes('1234567890'), 'sealed');
    assert.ok(!JSON.stringify(r.json()).includes('1234567890'), 'never returned');
    const again = await call('PUT', `/v1/finance/owners/${owner}/bank-account`, { bankName: 'BCA', bankCode: '014', holderName: `PT Hotel Nusantara ${TAG}` });
    assert.equal(again.json().account.accountMasked, '••••7890', 'the number kept');
    assert.ok(await one(`SELECT 1 FROM audit_log WHERE action = 'finance.owner_bank_account_saved' AND target_id = $1`, [owner]));
    assert.equal((await call('PUT', `/v1/finance/owners/${randomUUID()}/bank-account`, { bankName: 'BCA', holderName: 'x', accountNumber: '1234567' })).statusCode, 404);
  });

  test('owner shares: due → part-paid → paid; over-payment and bad input refused; void makes it due again', async () => {
    const list = async () => (await call('GET', '/v1/finance/owner-shares')).json().shares;
    let s = (await list()).find((x: any) => x.statementId === ownerStmt);
    assert.equal(s.status, 'due');
    assert.equal(s.due, 1_250_000);
    assert.equal(s.bank.accountMasked, '••••7890');
    const pay = (b: Record<string, unknown>, sid = ownerStmt) => call('POST', `/v1/finance/statements/${sid}/payments`, b);
    assert.equal((await pay({ amount: 1_000_000, paidOn: '2026-10-05', reference: '' })).statusCode, 422, 'a reference');
    assert.equal((await pay({ amount: 0, paidOn: '2026-10-05', reference: 'x' })).statusCode, 422);
    assert.equal((await pay({ amount: 1000, paidOn: '05-10-2026', reference: 'x' })).statusCode, 422);
    assert.equal((await pay({ amount: 1000, paidOn: '2099-01-01', reference: 'x' })).statusCode, 422, 'not in the future');
    assert.equal((await pay({ amount: 2_000_000, paidOn: '2026-10-05', reference: 'x' })).statusCode, 422, 'more than outstanding');
    const p1 = await pay({ amount: 1_000_000, paidOn: '2026-10-05', reference: 'BCA 20261005-1', note: 'first part' });
    assert.equal(p1.statusCode, 201, p1.body);
    assert.equal(p1.json().statement.status, 'partial');
    assert.equal(p1.json().statement.outstanding, 250_000);
    const p2 = await pay({ amount: 250_000, paidOn: '2026-10-06', reference: 'BCA 20261006-2' });
    assert.equal(p2.json().statement.status, 'paid');
    s = (await list()).find((x: any) => x.statementId === ownerStmt);
    assert.equal(s.status, 'paid');
    assert.equal(s.lastPaidOn, '2026-10-06');
    // Void the second: due again by its amount; voided, not deleted.
    const v0 = await call('POST', `/v1/finance/statement-payments/${p2.json().paymentId}/void`, { reason: '' });
    assert.equal(v0.statusCode, 422);
    const v = await call('POST', `/v1/finance/statement-payments/${p2.json().paymentId}/void`, { reason: 'wrong reference' });
    assert.equal(v.statusCode, 200);
    assert.equal(v.json().statement.status, 'partial');
    assert.equal((await call('POST', `/v1/finance/statement-payments/${p2.json().paymentId}/void`, { reason: 'again' })).statusCode, 409);
    const d = (await call('GET', `/v1/finance/statements/${ownerStmt}/payments`)).json();
    assert.equal(d.payments.length, 2);
    assert.equal(d.payments.filter((p: any) => p.voided).length, 1);
    assert.ok(await one(`SELECT 1 FROM audit_log WHERE action = 'finance.owner_payout_recorded' AND target_id = $1`, [ownerStmt]));
    assert.ok(await one(`SELECT 1 FROM audit_log WHERE action = 'finance.statement_payment_voided' AND target_id = $1`, [ownerStmt]));
  });

  test('the transfer list: what is outstanding with the full account number; payment:write only; audited', async () => {
    const r = await call('GET', '/v1/finance/owner-shares/transfer-list.csv');
    assert.equal(r.statusCode, 200);
    assert.ok(r.body.startsWith('﻿Owner,Bank,Bank code,Account holder,Account number,Amount'));
    assert.match(r.body, new RegExp(`PT Hotel ${TAG},BCA,014,PT Hotel Nusantara ${TAG},1234567890,250000,IDR`));
    assert.ok(await one(`SELECT 1 FROM audit_log WHERE action = 'finance.transfer_list_exported' AND target_id = $1`, [org]));
    role = 'reader';
    try {
      assert.equal((await call('GET', '/v1/finance/owner-shares/transfer-list.csv')).statusCode, 403);
      assert.equal((await call('GET', '/v1/finance/owner-shares')).statusCode, 200, 'reading is payment:read');
      assert.equal((await call('POST', `/v1/finance/statements/${ownerStmt}/payments`, { amount: 1, paidOn: '2026-10-07', reference: 'x' })).statusCode, 403);
    } finally { role = 'finance'; }
  });

  test('operators\' statements to PlugSure: platform administrators only', async () => {
    assert.equal((await call('GET', '/v1/finance/operator-statements')).statusCode, 403);
    assert.equal((await call('POST', `/v1/finance/statements/${opStmt}/payments`, { amount: 1000, paidOn: '2026-10-07', reference: 'x' })).statusCode, 404, 'an operator cannot record it');
    role = 'platform';
    try {
      const l = (await call('GET', '/v1/finance/operator-statements?status=due')).json().statements;
      assert.ok(l.some((x: any) => x.statementId === opStmt && x.due === 5_550_000));
      const p = await call('POST', `/v1/finance/statements/${opStmt}/payments`, { amount: 5_550_000, paidOn: '2026-10-08', reference: 'Mandiri 8812' });
      assert.equal(p.statusCode, 201, p.body);
      assert.equal(p.json().statement.kind, 'platform_fee');
      assert.equal(p.json().statement.status, 'paid');
      assert.ok(await one(`SELECT 1 FROM audit_log WHERE action = 'finance.platform_fee_recorded' AND target_id = $1`, [opStmt]));
    } finally { role = 'finance'; }
  });

  test('another operator sees none of it', async () => {
    role = 'other';
    try {
      assert.deepEqual((await call('GET', '/v1/finance/owner-shares')).json().shares.filter((x: any) => x.statementId === ownerStmt), []);
      assert.equal((await call('GET', `/v1/finance/statements/${ownerStmt}/payments`)).statusCode, 404);
      assert.equal((await call('POST', `/v1/finance/statements/${ownerStmt}/payments`, { amount: 1, paidOn: '2026-10-07', reference: 'x' })).statusCode, 404);
      assert.equal((await call('GET', `/v1/finance/owners/${owner}/bank-account`)).statusCode, 404);
      assert.equal((await call('PUT', `/v1/finance/owners/${owner}/bank-account`, { bankName: 'X', holderName: 'Y', accountNumber: '99999999' })).statusCode, 404);
      assert.ok(!(await call('GET', '/v1/finance/owner-shares/transfer-list.csv')).body.includes('1234567890'));
    } finally { role = 'finance'; }
  });
});
