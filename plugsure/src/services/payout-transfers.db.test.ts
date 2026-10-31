import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 5 of the finance review (v1.16.0):
 *   - owner payouts through Duitku Disbursement with two people: from the operator's OWN Duitku account only, the
 *     requester cannot approve, never more than is outstanding, limits, sent once, recorded as a statement payment when
 *     Duitku confirms it (the share becomes part-paid / paid), unknown results asked about by the worker;
 *   - a ledger row's whole trail (payment, session, refund, exceptions; the payer masked);
 *   - what each method costs, with Duitku's quoted fees;
 *   - Xendit's reports requested and their links.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/payout-transfers.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const store = await import('../integrations/store.js');
const pxfer = await import('./payout-transfers.js');
const { registerFinanceRoutes } = await import('../api/finance-routes.js');

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const TAG = randomBytes(3).toString('hex');
const SECRET = 'disb-secret-p5';
const REQUESTER = randomUUID(), APPROVER = randomUUID();
let org = '', other = '', duitkuId = '', platformDuitku = '', xenditId = '', owner = '', stmt = '', stmt2 = '';
let app: FastifyInstance;
let actor = REQUESTER, actorOrg = '';
let transferCode = '00', statusCode = '00';
const reports = new Map<string, { status: string; url: string | null }>();
const seen: Array<{ path: string; body: any }> = [];
let base = '';
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0]!;
    const b = raw ? JSON.parse(raw) : {};
    seen.push({ path, body: b });
    res.setHeader('content-type', 'application/json');
    if (path === '/webapi/api/disbursement/inquirysandbox') {
      if (b.signature !== sha(`${b.email}${b.timestamp}${b.bankCode}${b.bankAccount}${b.amountTransfer}${b.purpose}${SECRET}`)) return res.end(JSON.stringify({ responseCode: 'EE' }));
      return res.end(JSON.stringify({ responseCode: '00', accountName: 'PT HOTEL NUSANTARA', disburseId: 990000 + seen.length, custRefNumber: `r${seen.length}` }));
    }
    if (path === '/webapi/api/disbursement/transfersandbox') return res.end(JSON.stringify({ responseCode: transferCode }));
    if (path === '/webapi/api/disbursement/inquirystatus') return res.end(JSON.stringify({ responseCode: statusCode }));
    if (path === '/webapi/api/merchant/paymentmethod/getpaymentmethod') {
      return res.end(JSON.stringify({ paymentFee: [{ paymentMethod: 'SP', totalFee: '700' }, { paymentMethod: 'DA', totalFee: '1500' }, { paymentMethod: 'VC', totalFee: '2900' }] }));
    }
    if (path === '/x/reports' && req.method === 'POST') {
      const id = `report_${seen.length}`;
      reports.set(id, { status: 'PENDING', url: null });
      return res.end(JSON.stringify({ id, type: b.type, status: 'PENDING' }));
    }
    if (path.startsWith('/x/reports/')) {
      const r = reports.get(path.slice('/x/reports/'.length));
      if (!r) { res.statusCode = 404; return res.end('{}'); }
      return res.end(JSON.stringify({ id: path.slice(11), status: r.status, url: r.url }));
    }
    res.statusCode = 404; res.end('{}');
  });
});

const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });
const newStatement = async (share: number, period: string) => (await one<{ id: string }>(
  `INSERT INTO commission_statement (org_id, owner_id, period, number, gtv_minor, commission_minor, minimum_topup_minor, private_fee_minor, mdr_credit_minor,
                                     net_minor, tax_minor, total_minor, owner_share_minor, data, finalised_at, currency)
   VALUES ($1, $2, $3::date, $4, 10000000, 1000000, 0, 0, 0, 1000000, 110000, 1110000, $5, '{}'::jsonb, now(), 'IDR') RETURNING id`,
  [org, owner, period, `PS5-${TAG}-${randomBytes(2).toString('hex')}`, share]))!.id;

if (DB_OK) {
  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    (config.console as { publicBaseUrl: string }).publicBaseUrl = 'https://ocpp.plugsure.test';
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1,$2) RETURNING id`, [`P5 ${TAG}`, `p5-${TAG}`]))!.id;
    other = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1,$2) RETURNING id`, [`P5 other ${TAG}`, `p5-other-${TAG}`]))!.id;
    actorOrg = org;
    for (const u of [REQUESTER, APPROVER]) await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, $4)`, [u, org, `${u.slice(0, 8)}@p5.test`, u === REQUESTER ? 'Rina' : 'Andi']);
    const disb = { disbursementUserId: '3551', disbursementEmail: 'p5@plugsure.test', disbursementMaxPayout: 2_000_000, disbursementMaxPayoutPerDay: 2_200_000 };
    duitkuId = ((await store.save('payments_fallback', org, { provider: 'duitku', settings: { environment: 'sandbox', merchantCode: 'DP5', methods: ['QRIS', 'DANA'], qrisMethod: 'SP', baseUrl: base, ...disb }, secrets: { apiKey: 'k', disbursementSecretKey: SECRET } }, null)) as any).id;
    // A platform account (org NULL): it must never pay another operator's owners.
    platformDuitku = (await one<{ id: string }>(`SELECT id FROM integration WHERE kind = 'payments_fallback' AND org_id IS NULL AND archived_at IS NULL LIMIT 1`))?.id ?? '';
    xenditId = ((await store.save('payments', org, { provider: 'xendit', settings: { environment: 'sandbox', methods: ['QRIS'], baseUrl: `${base}/x` }, secrets: { secretKey: `xnd_development_${TAG}`, callbackToken: 'cb' } }, null)) as any).id;
    owner = (await one<{ id: string }>(`INSERT INTO site_owner (org_id, name, legal_name) VALUES ($1, $2, 'PT Hotel Nusantara') RETURNING id`, [org, `Hotel ${TAG}`]))!.id;
    stmt = await newStatement(1_500_000, '2026-09-01');
    stmt2 = await newStatement(900_000, '2026-08-01');
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: actor, orgId: actorOrg, assignments: [{ permissions: ['payment:read', 'payment:write'], scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
    await call('PUT', `/v1/finance/owners/${owner}/bank-account`, { bankName: 'BCA', bankCode: '014', holderName: 'PT Hotel Nusantara', accountNumber: '5550001111' });
  });
  after(async () => {
    server.close();
    await app?.close();
    await query(`DELETE FROM payout_transfer WHERE org_id = $1`, [org]);
    await query(`DELETE FROM gateway_report WHERE integration_id = $1`, [xenditId]);
    await query(`DELETE FROM statement_payment WHERE org_id = $1`, [org]);
    await query(`DELETE FROM reconciliation_exception WHERE integration_id = $1`, [xenditId]);
    await query(`DELETE FROM gateway_transaction WHERE integration_id IN ($1, $2)`, [xenditId, duitkuId]);
    await query(`DELETE FROM payment_intent WHERE org_id = $1`, [org]);
    await query(`DELETE FROM commission_statement WHERE org_id = $1`, [org]);
    await query(`DELETE FROM owner_bank_account WHERE org_id = $1`, [org]);
    await query(`DELETE FROM site_owner WHERE org_id = $1`, [org]);
    await query(`DELETE FROM alert WHERE org_id = $1`, [org]);
    await query(`DELETE FROM integration_event WHERE integration_id IN (SELECT id FROM integration WHERE org_id = $1)`, [org]);
    await query(`DELETE FROM integration WHERE org_id = $1`, [org]);
    await query(`DELETE FROM app_user WHERE org_id = $1`, [org]).catch(() => { /* audit rows keep them */ });
    for (const o of [org, other]) await query(`DELETE FROM organisation WHERE id = $1`, [o]).catch(() => { /* audit rows keep it */ });
    store.invalidate();
    await pool.end();
  });
}

dbDescribe('Owner payouts through Duitku Disbursement', () => {
  test('requested from the operator\'s own account; the requester cannot approve; paid → recorded against the statement', async () => {
    actor = REQUESTER;
    const shares = (await call('GET', '/v1/finance/owner-shares')).json();
    assert.equal(shares.payoutsAvailable, true);
    const r = await call('POST', `/v1/finance/statements/${stmt}/payout`, { amount: 1_000_000, note: 'September, first part' });
    assert.equal(r.statusCode, 201, r.body);
    const t = r.json().transfer;
    assert.deepEqual({ s: t.state, n: t.checkedName, m: t.namesMatch, a: t.accountMasked }, { s: 'awaiting_approval', n: 'PT HOTEL NUSANTARA', m: true, a: '••••1111' });
    assert.equal((await one<any>(`SELECT integration_id FROM payout_transfer WHERE id = $1`, [t.id]))!.integration_id, duitkuId, 'the operator\'s own account');
    assert.equal((await call('POST', `/v1/finance/statements/${stmt}/payout`, { amount: 100 })).statusCode, 409, 'one open payout per statement');
    assert.equal((await call('POST', `/v1/finance/payout-transfers/${t.id}/approve`)).statusCode, 403);
    actor = APPROVER;
    const a = (await call('POST', `/v1/finance/payout-transfers/${t.id}/approve`)).json().transfer;
    assert.equal(a.state, 'succeeded');
    assert.ok(a.statementPaymentId);
    const p = (await one<any>(`SELECT * FROM statement_payment WHERE id = $1`, [a.statementPaymentId]))!;
    assert.deepEqual({ k: p.kind, amt: Number(p.amount_minor), ref: p.reference.startsWith('Duitku Disbursement ') }, { k: 'owner_payout', amt: 1_000_000, ref: true });
    const share = (await call('GET', '/v1/finance/owner-shares')).json().shares.find((x: any) => x.statementId === stmt);
    assert.deepEqual({ s: share.status, o: share.outstanding }, { s: 'partial', o: 500_000 });
  });

  test('never more than is outstanding; limits per payout and per day; rejection', async () => {
    actor = REQUESTER;
    assert.equal((await call('POST', `/v1/finance/statements/${stmt}/payout`, { amount: 600_000 })).statusCode, 422, 'more than the 500 000 outstanding');
    const big = await newStatement(3_000_000, '2026-07-01');
    const over = await call('POST', `/v1/finance/statements/${big}/payout`, {});
    assert.equal(over.statusCode, 422);
    assert.match(over.json().error, /largest payout/);
    // 1 000 000 approved today; 900 000 + 500 000 more would pass 2 200 000 (the second).
    const t2 = (await call('POST', `/v1/finance/statements/${stmt2}/payout`, {})).json().transfer;
    assert.equal(t2.amount, 900_000, 'the outstanding amount by default');
    const t3 = (await call('POST', `/v1/finance/statements/${stmt}/payout`, {})).json().transfer;
    actor = APPROVER;
    assert.equal((await call('POST', `/v1/finance/payout-transfers/${t2.id}/approve`)).json().transfer.state, 'succeeded');
    const lim = await call('POST', `/v1/finance/payout-transfers/${t3.id}/approve`);
    assert.equal(lim.statusCode, 422);
    assert.match(lim.json().error, /daily limit/);
    assert.equal((await call('POST', `/v1/finance/payout-transfers/${t3.id}/reject`, { reason: 'tomorrow' })).json().transfer.state, 'rejected');
    assert.equal((await call('GET', '/v1/finance/owner-shares')).json().shares.find((x: any) => x.statementId === stmt2).status, 'paid');
  });

  test('an unknown result is asked about; only a confirmed payout is recorded', async () => {
    await query(`UPDATE payout_transfer SET approved_at = now() - interval '2 days' WHERE org_id = $1 AND state = 'succeeded'`, [org]);
    actor = REQUESTER;
    const t = (await call('POST', `/v1/finance/statements/${stmt}/payout`, {})).json().transfer;
    transferCode = 'TO';
    actor = APPROVER;
    const a = (await call('POST', `/v1/finance/payout-transfers/${t.id}/approve`)).json().transfer;
    assert.deepEqual([a.state, a.statementPaymentId], ['sent', null]);
    await query(`UPDATE payout_transfer SET updated_at = now() - interval '10 minutes' WHERE id = $1`, [t.id]);
    statusCode = 'TO';
    await pxfer.sweepPayouts();
    assert.equal((await one<any>(`SELECT state FROM payout_transfer WHERE id = $1`, [t.id]))!.state, 'sent');
    await query(`UPDATE payout_transfer SET updated_at = now() - interval '10 minutes' WHERE id = $1`, [t.id]);
    statusCode = '00';
    assert.equal(await pxfer.sweepPayouts(), 1);
    assert.ok((await one<any>(`SELECT statement_payment_id FROM payout_transfer WHERE id = $1`, [t.id]))!.statement_payment_id);
    assert.equal((await call('GET', '/v1/finance/owner-shares')).json().shares.find((x: any) => x.statementId === stmt).status, 'paid');
    transferCode = '00';
  });

  test('another operator: no payouts from someone else\'s (or the platform\'s) account', async () => {
    actorOrg = other;
    const r = (await call('GET', '/v1/finance/owner-shares')).json();
    assert.equal(r.payoutsAvailable, false, platformDuitku ? 'the platform\'s Duitku account is not offered to an operator' : 'no account of its own');
    assert.equal((await call('POST', `/v1/finance/statements/${stmt}/payout`, {})).statusCode, 404);
    assert.deepEqual((await call('GET', '/v1/finance/payout-transfers')).json().transfers, []);
    actorOrg = org;
  });
});

dbDescribe('Trail, method costs and Xendit reports', () => {
  test('a ledger row\'s trail: the payment, its refund, the other rows, exceptions; the payer masked', async () => {
    const pi = (await one<{ id: string }>(
      `INSERT INTO payment_intent (org_id, provider, method, mode, state, amount_authorised_minor, amount_captured_minor, integration_id, channel, provider_ref, raw_events, refund_state, refund_due_minor, refund_method, refund_ref, refunded_minor, refunded_at)
       VALUES ($1, 'xendit', 'qris', 'prepurchase', 'captured', 80000, 80000, $2, 'QRIS', $3, '[{"at":"2026-10-30T01:00:00Z","status":"SUCCEEDED","paymentId":"qrpy_9"}]'::jsonb, 'refunded', 30000, 'provider', 'qrr_9', 30000, now()) RETURNING id`,
      [org, xenditId, `ps-${TAG}-t`]))!.id;
    const ins = (ext: string, kind: string, amount: number) => one<{ id: string }>(
      `INSERT INTO gateway_transaction (integration_id, org_id, provider, external_id, kind, status, cashflow, currency, amount, fee, vat, gateway_created_at, gateway_updated_at, payment_intent_id, channel_code, raw)
       VALUES ($1, $2, 'xendit', $3, $4, 'success', $5, 'IDR', $6, 560, 61.6, now(), now(), $7, 'QRIS', $8) RETURNING id`,
      [xenditId, org, ext, kind, kind === 'payment' ? 'in' : 'out', amount, pi, JSON.stringify({ id: ext, customer: { mobile_number: '+628123456789' }, channel_code: 'QRIS' })]);
    const pay = (await ins(`tx-${TAG}-p`, 'payment', 80000))!.id;
    await ins(`tx-${TAG}-r`, 'refund', 30000);
    const r = await call('GET', `/v1/finance/accounts/${xenditId}/transactions/${pay}/trail`);
    assert.equal(r.statusCode, 200, r.body);
    const t = r.json();
    assert.equal(t.transaction.gatewayId, `tx-${TAG}-p`);
    assert.equal(t.related.length, 1);
    assert.equal(t.related[0].kind, 'refund');
    assert.deepEqual({ s: t.payment.state, r: t.payment.refund.state, ev: t.payment.events.length }, { s: 'captured', r: 'refunded', ev: 1 });
    assert.ok(!JSON.stringify(t.transaction.raw).includes('628123456789'), 'the payer\'s number is masked');
    assert.equal((await call('GET', `/v1/finance/accounts/${xenditId}/transactions/999999999/trail`)).statusCode, 404);
    actorOrg = other;
    assert.equal((await call('GET', `/v1/finance/accounts/${xenditId}/transactions/${pay}/trail`)).statusCode, 404, 'not another operator\'s');
    actorOrg = org;
  });

  test('what each method costs: from the ledger, per 100 000; Duitku\'s quoted fees by method', async () => {
    const from = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), to = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const r = (await call('GET', `/v1/finance/method-costs?from=${from}&to=${to}`)).json();
    const x = r.accounts.find((a: any) => a.id === xenditId);
    const q = x.methods.find((m: any) => m.channel === 'QRIS');
    assert.deepEqual({ n: q.payments, avg: q.averageFee, per: q.per100k }, { n: 1, avg: 621.6, per: 777 });
    const d = r.accounts.find((a: any) => a.id === duitkuId);
    assert.deepEqual(d.quoted, [{ channel: 'QRIS', fee: 700 }, { channel: 'DANA', fee: 1500 }, { channel: 'CARD', fee: 2900 }]);
  });

  test('Xendit reports: requested, generating, then a link (audited); not for a Duitku account', async () => {
    const r = await call('POST', `/v1/finance/accounts/${xenditId}/reports?from=2026-10-01&to=2026-10-31`, { type: 'TRANSACTIONS' });
    assert.equal(r.statusCode, 201, r.body);
    const rep = r.json().report;
    assert.deepEqual({ s: rep.status, ready: rep.ready }, { s: 'PENDING', ready: false });
    const sent = seen.find((x) => x.path === '/x/reports')!.body;
    assert.deepEqual({ t: sent.type, f: sent.format }, { t: 'TRANSACTIONS', f: 'CSV' });
    assert.equal((await call('GET', `/v1/finance/accounts/${xenditId}/reports/${rep.id}`)).json().report.status, 'PENDING');
    const ext = (await one<any>(`SELECT external_id FROM gateway_report WHERE id = $1`, [rep.id]))!.external_id;
    reports.set(ext, { status: 'COMPLETED', url: 'https://xendit-reports.test/r.csv?sig=1' });
    const done = (await call('GET', `/v1/finance/accounts/${xenditId}/reports/${rep.id}`)).json().report;
    assert.deepEqual({ s: done.status, ready: done.ready, url: done.url }, { s: 'COMPLETED', ready: true, url: undefined }, 'no link unless asked');
    assert.equal((await call('GET', `/v1/finance/accounts/${xenditId}/reports/${rep.id}?link=true`)).json().report.url, 'https://xendit-reports.test/r.csv?sig=1');
    assert.equal((await call('GET', `/v1/finance/accounts/${xenditId}/reports`)).json().reports.length, 1);
    assert.equal((await call('POST', `/v1/finance/accounts/${xenditId}/reports`, { type: 'NOPE' })).statusCode, 422);
    assert.equal((await call('POST', `/v1/finance/accounts/${duitkuId}/reports`, { type: 'TRANSACTIONS' })).statusCode, 409);
  });
});
