import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { parseAmount, parseDate, parseStatement } from './bank-recon.js';

/**
 * Phase 7 of the finance review (v1.18.0):
 *   - approval alerts: a transfer waiting for a second person raises an alert; after 24 hours a critical one; both
 *     resolve on approval; the console's count (and how many the caller may approve);
 *   - payout callbacks: Xendit's payout.* names the payout, PlugSure asks Xendit and settles at once; unknown ids are
 *     acknowledged;
 *   - bank statements: BCA / Mandiri / BRI CSV parsed, lines matched to gateway withdrawals and owner payouts, an
 *     overlapping upload skips lines already there, manual match / ignore / undo;
 *   - PPh 23: the year's suggested bases (gateway fees, PlugSure's fee), records with the bukti potong, voids, CSV;
 *   - PlugSure's platform-fee statements as Coretax e-Faktur XML (platform administrators).
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase7.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const store = await import('../integrations/store.js');
const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const approvals = await import('./transfer-approvals.js');
const { payoutCallback } = await import('./transfer-callbacks.js');
const { XenditProvider } = await import('./payments/xendit.js');

const TAG = randomBytes(3).toString('hex');
const REQUESTER = randomUUID(), APPROVER = randomUUID();
// A month no other test uses, for the platform e-Faktur (which reads every operator's statements).
const EF_PERIOD = `20${40 + (parseInt(TAG.slice(0, 2), 16) % 50)}-0${1 + (parseInt(TAG.slice(2, 3), 16) % 9)}`;
let org = '', xenditId = '', owner = '', stmt = '', platformStmt = '';
let app: FastifyInstance;
let actor = REQUESTER;
let perms = ['payment:read', 'payment:write'];

// A fake Xendit: payouts accepted, then whatever `payoutStatus` says.
const payouts = new Map<string, { body: any }>();
let payoutStatus = 'SUCCEEDED';
let base = '';
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0]!;
    res.setHeader('content-type', 'application/json');
    if (path === '/v2/payouts' && req.method === 'POST') {
      const key = String(req.headers['idempotency-key']);
      const existing = [...payouts.entries()].find(([, p]) => p.body.key === key);
      if (existing) return res.end(JSON.stringify({ id: existing[0], status: 'ACCEPTED' }));
      const id = `disb-${payouts.size + 1}-${TAG}`;
      payouts.set(id, { body: { ...JSON.parse(raw || '{}'), key } });
      return res.end(JSON.stringify({ id, status: 'ACCEPTED' }));
    }
    if (path.startsWith('/v2/payouts/')) {
      if (!payouts.has(path.slice('/v2/payouts/'.length))) { res.statusCode = 404; return res.end('{}'); }
      return res.end(JSON.stringify({ status: payoutStatus }));
    }
    res.statusCode = 404; res.end('{}');
  });
});

const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });
const openAlerts = (kind: string, id: string) => one<{ n: number }>(`SELECT count(*)::int AS n FROM alert WHERE org_id = $1 AND kind = $2 AND target_id = $3 AND resolved_at IS NULL`, [org, kind, id]).then((r) => r!.n);

if (DB_OK) {
  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug, npwp) VALUES ($1, $2, '0123456789012345') RETURNING id`, [`P7 ${TAG}`, `p7-${TAG}`]))!.id;
    for (const u of [REQUESTER, APPROVER]) await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, $4)`, [u, org, `${u.slice(0, 8)}@p7.test`, u === REQUESTER ? 'Rina' : 'Andi']);
    xenditId = ((await store.save('payments', org, { provider: 'xendit', settings: {
      environment: 'sandbox', methods: ['QRIS'], baseUrl: base, payoutsEnabled: true, disbursementMaxPerTransfer: 1_000_000, disbursementMaxPayout: 5_000_000,
    }, secrets: { secretKey: `xnd_development_${TAG}`, callbackToken: 'cb-token' } }, null)) as any).id;
    owner = (await one<{ id: string }>(`INSERT INTO site_owner (org_id, name, legal_name) VALUES ($1, $2, 'PT Hotel Nusantara') RETURNING id`, [org, `Hotel ${TAG}`]))!.id;
    const statement = (ownerId: string | null, period: string, number: string, net: number, tax: number, share: number) => one<{ id: string }>(
      `INSERT INTO commission_statement (org_id, owner_id, period, number, gtv_minor, commission_minor, minimum_topup_minor, private_fee_minor, mdr_credit_minor,
                                         net_minor, tax_minor, total_minor, owner_share_minor, data, finalised_at, currency)
       VALUES ($1, $2, $3, $4, 1000000, $5::bigint, 0, 0, 0, $5::bigint, $6::bigint, $5::bigint + $6::bigint, $7, $8::jsonb, now(), 'IDR') RETURNING id`,
      [org, ownerId, period, number, net, tax, share, JSON.stringify({ totals: { taxBaseMinor: Math.round((net * 11) / 12) } })]).then((r) => r!.id);
    stmt = await statement(owner, '2026-09-01', `P7-${TAG}`, 100_000, 11_000, 800_000);
    platformStmt = await statement(null, `${EF_PERIOD}-01`, `PS-${TAG}`, 240_000, 26_400, 0);
    await statement(null, '2026-10-01', `PS10-${TAG}`, 500_000, 55_000, 0);
    // The ledger, October: two payments (fees 700 + 350), a withdrawal of 120 000 to the bank on 15 October.
    const g = (ext: string, kind: string, cashflow: string, amount: number, fee: number) => query(
      `INSERT INTO gateway_transaction (integration_id, org_id, provider, external_id, kind, status, cashflow, currency, amount, fee, vat, withholding_tax, gateway_created_at, gateway_updated_at)
       VALUES ($1, $2, 'xendit', $3, $4, 'success', $5, 'IDR', $6, $7, 0, 0, '2026-10-15T03:00:00Z', '2026-10-15T03:00:00Z')`, [xenditId, org, `${ext}-${TAG}`, kind, cashflow, amount, fee]);
    await g('p1', 'payment', 'in', 100_000, 700);
    await g('p2', 'payment', 'in', 50_000, 350);
    await g('w1', 'payout', 'out', 120_000, 0);
    await query(`INSERT INTO statement_payment (org_id, statement_id, kind, owner_id, amount_minor, currency, paid_on, reference, recorded_by)
                 VALUES ($1, $2, 'owner_payout', $3, 300000, 'IDR', '2026-10-20', 'BCA 1', $4)`, [org, stmt, owner, REQUESTER]);
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: actor, orgId: org, assignments: [{ permissions: perms, scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
    await call('PUT', `/v1/finance/owners/${owner}/bank-account`, { bankName: 'BCA', bankCode: '014', holderName: 'PT Hotel Nusantara', accountNumber: '5550001111' });
  });
  after(async () => {
    server.close();
    await app?.close();
    for (const t of ['tax_withholding', 'bank_statement_line', 'bank_statement', 'payout_transfer', 'refund_transfer', 'statement_payment']) await query(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
    await query(`DELETE FROM gateway_account_settings WHERE integration_id = $1`, [xenditId]);
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

dbDescribe('Approval alerts and payout callbacks', () => {
  test('a payout waiting for a second person: alert, count, overdue after 24 hours, resolved on approval; the callback settles it', async () => {
    actor = REQUESTER;
    const r = await call('POST', `/v1/finance/statements/${stmt}/payout`, { amount: 500_000, rail: 'xendit' });
    assert.equal(r.statusCode, 201, r.body);
    const t = r.json().transfer;
    assert.equal(await openAlerts(approvals.AWAITING, String(t.id)), 1, 'the approvers are told');
    const mine = (await call('GET', '/v1/finance/approvals')).json();
    assert.deepEqual({ p: mine.payouts, total: mine.total, forMe: mine.forMe }, { p: 1, total: 1, forMe: 0 }, 'the requester cannot approve their own');
    actor = APPROVER;
    assert.equal((await call('GET', '/v1/finance/approvals')).json().forMe, 1);

    await query(`UPDATE payout_transfer SET requested_at = now() - interval '25 hours' WHERE id = $1`, [t.id]);
    assert.ok(await approvals.escalateWaiting() >= 1);
    assert.equal(await openAlerts(approvals.OVERDUE, String(t.id)), 1);
    await approvals.escalateWaiting();
    assert.equal(await openAlerts(approvals.OVERDUE, String(t.id)), 1, 'once');

    const a = (await call('POST', `/v1/finance/payout-transfers/${t.id}/approve`)).json().transfer;
    assert.equal(a.state, 'sent');
    assert.equal(await openAlerts(approvals.AWAITING, String(t.id)) + await openAlerts(approvals.OVERDUE, String(t.id)), 0, 'both resolve');
    assert.equal((await call('GET', '/v1/finance/approvals')).json().total, 0);

    // Xendit's callback: verified by the callback token, it names the payout; PlugSure asks Xendit and settles.
    const ref = (await one<any>(`SELECT disburse_id FROM payout_transfer WHERE id = $1`, [t.id]))!.disburse_id;
    const p = new XenditProvider({ secretKey: 'x', callbackToken: 'cb-token', baseUrl: base } as any);
    const body = JSON.stringify({ event: 'payout.succeeded', data: { id: ref, status: 'SUCCEEDED' } });
    assert.equal(p.parsePayoutEvent(body, { 'x-callback-token': 'wrong' }), null, 'a forged callback is not read');
    assert.deepEqual(p.parsePayoutEvent(body, { 'x-callback-token': 'cb-token' }), { ref, event: 'payout.succeeded' });
    assert.equal(p.parsePayoutEvent(JSON.stringify({ event: 'invoice.paid', data: { id: ref } }), { 'x-callback-token': 'cb-token' }), null);
    payoutStatus = 'ACCEPTED';
    assert.equal(await payoutCallback(xenditId, ref), 'payout_pending', 'Xendit has not finished: left to the worker');
    payoutStatus = 'SUCCEEDED';
    assert.equal(await payoutCallback(xenditId, ref), 'payout_succeeded');
    const done = (await one<any>(`SELECT state, statement_payment_id FROM payout_transfer WHERE id = $1`, [t.id]))!;
    assert.equal(done.state, 'succeeded');
    assert.ok(done.statement_payment_id, 'recorded against the statement');
    assert.equal(await payoutCallback(xenditId, ref), 'payout_unknown', 'a replay does nothing');
    assert.equal(await payoutCallback(xenditId, 'disb-nope'), 'payout_unknown');
  });
});

describe('Bank statement parsing', () => {
  test('amounts and dates in the banks\' formats', () => {
    assert.deepEqual(parseAmount('1,234,567.00 CR'), { value: 1234567, side: 'CR' });
    assert.deepEqual(parseAmount('1.234.567,50'), { value: 1234567.5, side: null });
    assert.deepEqual(parseAmount('120,000.00 DB'), { value: 120000, side: 'DB' });
    assert.equal(parseAmount('—'), null);
    assert.equal(parseDate('15/10', 2026), '2026-10-15', 'BCA leaves out the year');
    assert.equal(parseDate('15/10/2026', 2026), '2026-10-15');
    assert.equal(parseDate('2026-10-15', 2026), '2026-10-15');
    assert.equal(parseDate('15 Oct 2026', 2026), '2026-10-15');
  });

  test('BCA (one amount with CR/DB), Mandiri (debit and credit), BRI', () => {
    const bca = parseStatement(['Informasi Rekening - Mutasi Rekening', '', 'Tanggal Transaksi,Keterangan,Cabang,Jumlah,Saldo',
      "'15/10/2026,TRSF E-BANKING CR XENDIT,0000,\"120,000.00 CR\",\"1,120,000.00\"", "'16/10/2026,BIAYA ADM,0000,\"10,000.00 DB\",\"1,110,000.00\"", 'Saldo Awal,,,,'].join('\n'));
    assert.equal(bca.bank, 'BCA');
    assert.deepEqual(bca.lines.map((l) => [l.date, l.amount]), [['2026-10-15', 120_000], ['2026-10-16', -10_000]]);
    const mandiri = parseStatement(['Account No,Date,Val. Date,Transaction Code,Description,Reference No.,Debit,Credit,Balance',
      '123,15/10/2026,15/10/2026,9999,XENDIT PAYOUT,REF-1,0.00,"120,000.00","1,120,000.00"', '123,20/10/2026,20/10/2026,9999,TRF HOTEL,REF-2,"300,000.00",0.00,"820,000.00"'].join('\n'));
    assert.equal(mandiri.bank, 'Mandiri');
    assert.deepEqual(mandiri.lines.map((l) => [l.date, l.amount, l.reference]), [['2026-10-15', 120_000, 'REF-1'], ['2026-10-20', -300_000, 'REF-2']]);
    const bri = parseStatement(['TGL_TRAN,DESK_TRAN,MUTASI_DEBET,MUTASI_KREDIT,SALDO_AKHIR_MUTASI', '15/10/26,XENDIT,0,120000,1120000'].join('\n'));
    assert.equal(bri.bank, 'BRI');
    assert.equal(bri.lines[0]!.amount, 120_000);
    assert.throws(() => parseStatement('a,b\n1,2'), /No header row/);
  });
});

dbDescribe('Bank statement reconciliation', () => {
  const csv = ['Account No,Date,Val. Date,Transaction Code,Description,Reference No.,Debit,Credit,Balance',
    `1,15/10/2026,15/10/2026,1,XENDIT PAYOUT w1-${TAG},,0.00,"120,000.00",`,
    '1,21/10/2026,21/10/2026,1,TRF PT HOTEL NUSANTARA,,"300,000.00",0.00,',
    '1,22/10/2026,22/10/2026,1,BIAYA ADMIN,,"15,000.00",0.00,'].join('\n');

  test('upload: the withdrawal and the owner payout matched; the fee left open; an overlapping upload adds nothing', async () => {
    actor = REQUESTER;
    const r = await call('POST', '/v1/finance/bank-statements', { filename: 'mandiri-oct.csv', csv });
    assert.equal(r.statusCode, 201, r.body);
    const u = r.json();
    assert.deepEqual({ bank: u.bank, lines: u.lines, matched: u.matched, from: u.from, to: u.to }, { bank: 'Mandiri', lines: 3, matched: 2, from: '2026-10-15', to: '2026-10-22' });
    const again = (await call('POST', '/v1/finance/bank-statements', { filename: 'again.csv', csv })).json();
    assert.deepEqual({ lines: again.lines, dup: again.duplicates }, { lines: 0, dup: 3 });
    const ls = (await call('GET', '/v1/finance/bank-lines')).json().lines;
    const by = (amt: number) => ls.find((l: any) => l.amount === amt);
    assert.equal(by(120_000).match.kind, 'gateway_withdrawal');
    assert.equal(by(-300_000).match.kind, 'statement_payment');
    assert.equal(by(-15_000).match, null);
    assert.equal((await call('GET', '/v1/finance/bank-lines?open=true')).json().lines.length, 1);
    assert.equal((await call('GET', '/v1/finance/bank-statements')).json().statements.length, 2);
  });

  test('by hand: ignored needs a note; undo; a candidate of the other direction is refused; matched again', async () => {
    const ls = (await call('GET', '/v1/finance/bank-lines')).json().lines;
    const fee = ls.find((l: any) => l.amount === -15_000), wd = ls.find((l: any) => l.amount === 120_000);
    assert.equal((await call('POST', `/v1/finance/bank-lines/${fee.id}/match`, { kind: 'ignored' })).statusCode, 422);
    assert.equal((await call('POST', `/v1/finance/bank-lines/${fee.id}/match`, { kind: 'ignored', note: 'Bank fee' })).statusCode, 200);
    assert.equal((await call('POST', `/v1/finance/bank-lines/${wd.id}/match`, { kind: 'none' })).statusCode, 200);
    const cands = (await call('GET', `/v1/finance/bank-lines/${wd.id}/candidates`)).json().candidates;
    assert.equal(cands[0].kind, 'gateway_withdrawal');
    assert.ok(cands.every((c: any) => c.amount > 0), 'credits only');
    const payout = ls.find((l: any) => l.amount === -300_000).match;
    assert.equal((await call('POST', `/v1/finance/bank-lines/${wd.id}/match`, { kind: payout.kind, ref: payout.ref })).statusCode, 422);
    assert.equal((await call('POST', `/v1/finance/bank-lines/${wd.id}/match`, { kind: cands[0].kind, ref: cands[0].ref })).statusCode, 200);
    assert.equal((await call('GET', '/v1/finance/bank-lines?open=true')).json().lines.length, 0);
    assert.equal((await call('POST', '/v1/finance/bank-statements', { csv: 'nothing here' })).statusCode, 422);
  });
});

dbDescribe('PPh 23 and the platform e-Faktur', () => {
  test('suggestions: 2% of the month\'s gateway fees and of PlugSure\'s fee; recorded, bukti potong, voided; CSV', async () => {
    actor = REQUESTER;
    const y = (await call('GET', '/v1/finance/tax/pph23?year=2026')).json();
    const gw = y.suggestions.find((s: any) => s.kind === 'gateway_fee' && s.period === '2026-10');
    assert.deepEqual({ base: gw.base, sug: gw.suggested, withheld: gw.withheld }, { base: 1050, sug: 21, withheld: 0 });
    const pf = y.suggestions.find((s: any) => s.kind === 'platform_fee' && s.period === '2026-10');
    assert.deepEqual({ base: pf.base, sug: pf.suggested, n: pf.number }, { base: 500_000, sug: 10_000, n: `PS10-${TAG}` });
    assert.equal(y.suggestions.some((s: any) => s.statementId === stmt), false, 'the owner\'s statement is not PlugSure\'s fee');

    for (const bad of [{ kind: 'x' }, { kind: 'gateway_fee', period: '2026-13', counterparty: 'X', base: 1 }, { kind: 'gateway_fee', period: '2026-10', counterparty: '', base: 1 },
      { kind: 'gateway_fee', period: '2026-10', counterparty: 'X', base: 1.5 }, { kind: 'gateway_fee', period: '2026-10', counterparty: 'X', base: 1, counterpartyNpwp: '123' },
      { kind: 'platform_fee', period: '2026-10', counterparty: 'X', base: 1, statementId: stmt }]) {
      assert.equal((await call('POST', '/v1/finance/tax/withholdings', bad)).statusCode, 422, JSON.stringify(bad));
    }
    const r = await call('POST', '/v1/finance/tax/withholdings', { kind: 'gateway_fee', period: '2026-10', counterparty: gw.counterparty, integrationId: xenditId, base: 1050 });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().amount, 21, 'base × 2% by default');
    const p = (await call('POST', '/v1/finance/tax/withholdings', { kind: 'platform_fee', period: '2026-10', counterparty: pf.counterparty, statementId: pf.statementId, base: 500_000, buktiNumber: 'BP-1', buktiDate: '2026-11-05' })).json();
    let after = (await call('GET', '/v1/finance/tax/pph23?year=2026')).json();
    const gw2 = after.suggestions.find((s: any) => s.kind === 'gateway_fee' && s.period === '2026-10');
    assert.deepEqual({ w: gw2.withheld, missing: gw2.buktiMissing }, { w: 21, missing: true });
    assert.equal(after.suggestions.find((s: any) => s.kind === 'platform_fee' && s.period === '2026-10').buktiMissing, false);
    assert.equal((await call('POST', `/v1/finance/tax/withholdings/${r.json().id}/bukti`, { buktiNumber: 'BP-2', buktiDate: '5 Nov' })).statusCode, 422);
    assert.equal((await call('POST', `/v1/finance/tax/withholdings/${r.json().id}/bukti`, { buktiNumber: 'BP-2', buktiDate: '2026-11-06' })).statusCode, 200);
    assert.equal((await call('POST', `/v1/finance/tax/withholdings/${p.id}/void`, {})).statusCode, 422, 'a reason');
    assert.equal((await call('POST', `/v1/finance/tax/withholdings/${p.id}/void`, { reason: 'Entered twice' })).statusCode, 200);
    assert.equal((await call('POST', `/v1/finance/tax/withholdings/${p.id}/void`, { reason: 'again' })).statusCode, 404);
    after = (await call('GET', '/v1/finance/tax/pph23?year=2026')).json();
    assert.equal(after.suggestions.find((s: any) => s.kind === 'platform_fee' && s.period === '2026-10').withheld, 0, 'a void no longer counts');
    assert.equal(after.recorded.length, 2);
    const csv = await call('GET', '/v1/finance/tax/pph23?year=2026&format=csv');
    assert.match(csv.headers['content-type'] as string, /text\/csv/);
    assert.match(csv.body, /BP-2/);
    assert.match(csv.body, /voided: Entered twice/);
    assert.equal((await call('GET', '/v1/finance/tax/pph23?year=26')).statusCode, 400);
  });

  test('the platform e-Faktur: platform administrators; PlugSure\'s NPWP required; the operator the buyer', async () => {
    const q = `/v1/finance/tax/platform-efaktur?period=${EF_PERIOD}&itemOpt=B&itemCode=000000&unitCode=UM.0030`;
    assert.equal((await call('GET', q)).statusCode, 403, 'operators cannot');
    perms = ['payment:read', 'payment:write', 'platform:admin'];
    const was = config.billing.issuerNpwp;
    try {
      (config.billing as any).issuerNpwp = '';
      assert.equal((await call('GET', q)).statusCode, 409, 'no NPWP for PlugSure');
      (config.billing as any).issuerNpwp = '0999888777666555';
      assert.equal((await call('GET', q.replace('itemOpt=B', 'itemOpt=C'))).statusCode, 422);
      const r = await call('GET', q);
      assert.equal(r.statusCode, 200, r.body);
      assert.match(r.headers['content-type'] as string, /xml/);
      assert.match(r.body, /<TIN>0999888777666555<\/TIN>/, 'PlugSure the seller');
      assert.match(r.body, /<BuyerTin>0123456789012345<\/BuyerTin>/, 'the operator the buyer');
      assert.match(r.body, new RegExp(`PS-${TAG}`));
      assert.match(r.body, /<TaxBase>240000/);
      assert.match(r.body, /<VAT>26400/);
      assert.equal(r.headers['x-efaktur-skipped'], '0');
      await query(`UPDATE organisation SET npwp = NULL WHERE id = $1`, [org]);
      assert.equal((await call('GET', q)).statusCode, 409, 'no buyer NPWP: nothing to export');
    } finally {
      (config.billing as any).issuerNpwp = was;
      perms = ['payment:read', 'payment:write'];
      await query(`UPDATE organisation SET npwp = '0123456789012345' WHERE id = $1`, [org]);
    }
    assert.ok(platformStmt);
  });
});
