import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { namesMatch } from './refund-transfers.js';
import { refundWindowDays, refundDaysLeft } from './refund-windows.js';

/**
 * Phase 4 of the finance review (v1.15.0):
 *   - refunds sent through Duitku Disbursement with two people: the account checked by name (inquiry), the requester
 *     cannot approve, limits per transfer and per day, sent once, '00' records the refund refunded (disbursement); a
 *     refusal makes it due again; an unknown result is asked about by the worker; rejection before sending; while a
 *     transfer is open the refund cannot be paid another way;
 *   - owners' bank accounts checked by name, the check cleared when the account or holder changes;
 *   - the Refunds list: the gateway's refund window, the ledger's refund status and fee, the fee the gateway keeps;
 *   - owner statements: the gateway's ACTUAL fee as the QRIS MDR where Finance has the payment, else the estimate.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/refund-transfers.db.test.ts
 */

describe('names as the banks write them (no database)', () => {
  test('equal ignoring case and punctuation, or one\'s words all in the other', () => {
    assert.ok(namesMatch('Budi Santoso', 'BUDI SANTOSO'));
    assert.ok(namesMatch('PT. Hotel Nusantara', 'PT HOTEL NUSANTARA TBK'));
    assert.ok(namesMatch('BUDI SANTOSO', 'Budi'), 'a bank\'s short form');
    assert.ok(!namesMatch('Budi Santoso', 'SITI RAHAYU'));
    assert.ok(!namesMatch('Budi', null));
  });
  test('refund windows: Xendit e-wallets and QRIS; Duitku and others none', () => {
    assert.equal(refundWindowDays('xendit', 'OVO'), 90);
    assert.equal(refundWindowDays('xendit', 'QRIS'), 7);
    assert.equal(refundWindowDays('xendit', null), 7, 'no channel: QRIS');
    assert.equal(refundWindowDays('xendit', 'CARD'), null);
    assert.equal(refundWindowDays('duitku', 'QRIS'), null);
    assert.equal(refundDaysLeft(30, new Date(Date.now() - 10 * 86_400_000)), 20);
    assert.equal(refundDaysLeft(7, new Date(Date.now() - 9 * 86_400_000)), -2);
  });
});

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const store = await import('../integrations/store.js');
const xfer = await import('./refund-transfers.js');
const refunds = await import('./refunds.js');
const { draftStatement } = await import('./commission.js');
const { registerFinanceRoutes } = await import('../api/finance-routes.js');

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const TAG = randomBytes(3).toString('hex');
const EMAIL = 'disb@plugsure.test', SECRET = 'disb-secret-key', USER = '3551';
const REQUESTER = randomUUID(), APPROVER = randomUUID();
let org = '', duitkuId = '', xenditId = '', owner = '', site = '', cp = '', conn = '';
let app: FastifyInstance;
let actor = REQUESTER;
// The fake Disbursement: account → the bank's name; what the transfer answers; what inquirystatus answers.
const accounts = new Map<string, string>([['1234567890', 'BUDI SANTOSO'], ['5550001111', 'PT HOTEL NUSANTARA']]);
let transferCode = '00', statusCode = '00';
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
      if (b.signature !== sha(`${b.email}${b.timestamp}${b.bankCode}${b.bankAccount}${b.amountTransfer}${b.purpose}${SECRET}`)) return res.end(JSON.stringify({ responseCode: 'EE', responseDesc: 'Wrong signature' }));
      const name = accounts.get(b.bankAccount);
      if (!name) return res.end(JSON.stringify({ responseCode: 'EE', responseDesc: 'Invalid account' }));
      return res.end(JSON.stringify({ responseCode: '00', accountName: name, disburseId: 880000 + seen.length, custRefNumber: `0000${seen.length}`, bankCode: b.bankCode, bankAccount: b.bankAccount }));
    }
    if (path === '/webapi/api/disbursement/transfersandbox') {
      const ok = b.signature === sha(`${b.email}${b.timestamp}${b.bankCode}${b.bankAccount}${b.accountName}${b.custRefNumber}${b.amountTransfer}${b.purpose}${b.disburseId}${SECRET}`);
      return res.end(JSON.stringify({ responseCode: ok ? transferCode : 'EE', responseDesc: ok ? (transferCode === '00' ? 'Success' : 'Pending') : 'Wrong signature' }));
    }
    if (path === '/webapi/api/disbursement/inquirystatus') {
      const ok = b.signature === sha(`${b.email}${b.timestamp}${b.disburseId}${SECRET}`);
      return res.end(JSON.stringify({ responseCode: ok ? statusCode : 'EE' }));
    }
    res.statusCode = 404; res.end('{}');
  });
});

const duitkuIntent = async (amount = 30_000) => (await one<{ id: string }>(
  `INSERT INTO payment_intent (org_id, provider, method, mode, state, amount_authorised_minor, amount_captured_minor, integration_id, channel, provider_ref, refund_state, refund_due_minor, refund_reason, refund_requested_at)
   VALUES ($1, 'duitku', 'qris', 'prepurchase', 'captured', $3, $3, $2, 'QRIS', $4, 'due', $3, 'test unused', now()) RETURNING id`,
  [org, duitkuId, amount, `ps-${randomBytes(8).toString('hex')}`]))!.id;
const pi = (id: string) => one<any>(`SELECT * FROM payment_intent WHERE id = $1`, [id]);
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });
const ACCOUNT = { bankCode: '014', accountNumber: '1234567890', holderName: 'Budi Santoso' };

if (DB_OK) {
  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    (config.console as { publicBaseUrl: string }).publicBaseUrl = 'https://ocpp.plugsure.test';
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1,$2) RETURNING id`, [`Disb ${TAG}`, `disb-${TAG}`]))!.id;
    for (const u of [REQUESTER, APPROVER]) await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, $4)`, [u, org, `${u.slice(0, 8)}@disb.test`, u === REQUESTER ? 'Rina Requester' : 'Andi Approver']);
    duitkuId = ((await store.save('payments_fallback', org, { provider: 'duitku', settings: {
      environment: 'sandbox', merchantCode: 'DTEST1', methods: ['QRIS'], qrisMethod: 'SP', baseUrl: base, disbursementUserId: USER, disbursementEmail: EMAIL,
      disbursementMaxPerTransfer: 100_000, disbursementMaxPerDay: 150_000,
    }, secrets: { apiKey: 'k', disbursementSecretKey: SECRET } }, null)) as any).id;
    xenditId = ((await store.save('payments', org, { provider: 'xendit', settings: { environment: 'sandbox', methods: ['QRIS', 'OVO'], baseUrl: `${base}/x` }, secrets: { secretKey: `xnd_development_${TAG}`, callbackToken: 'cb' } }, null)) as any).id;
    owner = (await one<{ id: string }>(`INSERT INTO site_owner (org_id, name, legal_name) VALUES ($1, $2, $3) RETURNING id`, [org, `Hotel ${TAG}`, `PT Hotel Nusantara`]))!.id;
    site = (await one<{ id: string }>(`INSERT INTO site (org_id, name) VALUES ($1, $2) RETURNING id`, [org, `Disb site ${TAG}`]))!.id;
    cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, ocpp_version, status, commissioned_at) VALUES ($1, $2, 'ocpp1.6', 'online', '2026-01-01') RETURNING id`, [site, `DISB-${TAG}`]))!.id;
    const e = await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1, 1, 22000) RETURNING id`, [cp]);
    conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w) VALUES ($1, 1, 'Type2', 'AC', 22000) RETURNING id`, [e!.id]))!.id;
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: actor, orgId: org, assignments: [{ permissions: ['payment:read', 'payment:write'], scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
  });
  after(async () => {
    server.close();
    await app?.close();
    await query(`DELETE FROM refund_transfer WHERE org_id = $1`, [org]);
    for (const id of [xenditId, duitkuId]) await query(`DELETE FROM gateway_transaction WHERE integration_id = $1`, [id]);
    await query(`DELETE FROM cdr WHERE org_id = $1`, [org]);
    await query(`UPDATE charging_session SET payment_intent_id = NULL WHERE org_id = $1`, [org]);
    await query(`DELETE FROM payment_intent WHERE org_id = $1`, [org]);
    await query(`DELETE FROM charging_session WHERE org_id = $1`, [org]);
    await query(`DELETE FROM connector WHERE id = $1`, [conn]);
    await query(`DELETE FROM evse WHERE charge_point_id = $1`, [cp]);
    await query(`DELETE FROM charge_point WHERE id = $1`, [cp]);
    await query(`DELETE FROM site WHERE id = $1`, [site]);
    await query(`DELETE FROM owner_bank_account WHERE org_id = $1`, [org]);
    await query(`DELETE FROM site_owner WHERE org_id = $1`, [org]);
    await query(`DELETE FROM alert WHERE org_id = $1`, [org]);
    await query(`DELETE FROM integration_event WHERE integration_id IN (SELECT id FROM integration WHERE org_id = $1)`, [org]);
    await query(`DELETE FROM integration WHERE org_id = $1`, [org]);
    await query(`DELETE FROM app_user WHERE org_id = $1`, [org]).catch(() => { /* audit rows keep them */ });
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => { /* audit rows keep it */ });
    store.invalidate();
    await pool.end();
  });
}

dbDescribe('Refunds through Duitku Disbursement, with two people', () => {
  test('request: the account checked by name; the refund held; the requester cannot approve; a second person sends it once', async () => {
    const id = await duitkuIntent();
    actor = REQUESTER;
    const r = await call('POST', `/v1/refunds/${id}/disbursement`, ACCOUNT);
    assert.equal(r.statusCode, 201, r.body);
    const t = r.json().transfer;
    assert.deepEqual({ s: t.state, name: t.checkedName, match: t.namesMatch, acct: t.accountMasked }, { s: 'awaiting_approval', name: 'BUDI SANTOSO', match: true, acct: '••••7890' });
    const sealed = (await one<any>(`SELECT account_number_sealed FROM refund_transfer WHERE id = $1`, [t.id]))!.account_number_sealed;
    assert.ok(!String(sealed).includes('1234567890'), 'the number is sealed');
    assert.deepEqual([(await pi(id)).refund_state, (await pi(id)).refund_method], ['processing', 'disbursement']);
    // While it is open the refund cannot be paid another way.
    assert.equal((await refunds.markRefundedManually(id, 'BCA 123', null)).ok, false);
    assert.equal((await refunds.processRefund(id, null)).ok, false);
    assert.equal((await call('POST', `/v1/refunds/${id}/disbursement`, ACCOUNT)).statusCode, 409, 'one open transfer per refund');
    // The requester cannot approve their own.
    assert.equal((await call('POST', `/v1/refund-transfers/${t.id}/approve`)).statusCode, 403);
    actor = APPROVER;
    seen.length = 0;
    const a = await call('POST', `/v1/refund-transfers/${t.id}/approve`);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(a.json().transfer.state, 'succeeded');
    assert.deepEqual(seen.map((x) => x.path), ['/webapi/api/disbursement/inquirysandbox', '/webapi/api/disbursement/transfersandbox'], 'a fresh inquiry, then the transfer');
    const tr = seen[1]!.body;
    assert.deepEqual({ amt: tr.amountTransfer, acct: tr.bankAccount, name: tr.accountName }, { amt: 30_000, acct: '1234567890', name: 'BUDI SANTOSO' });
    const p = (await pi(id))!;
    assert.deepEqual({ s: p.refund_state, m: p.refund_method, amt: Number(p.refunded_minor) }, { s: 'refunded', m: 'disbursement', amt: 30_000 });
    assert.equal((await call('POST', `/v1/refund-transfers/${t.id}/approve`)).statusCode, 409, 'sent once');
  });

  test('limits: one transfer, and all approved in a day', async () => {
    actor = REQUESTER;
    const big = await duitkuIntent(120_000);
    const r = await call('POST', `/v1/refunds/${big}/disbursement`, ACCOUNT);
    assert.equal(r.statusCode, 422);
    assert.match(r.json().error, /largest transfer/);
    assert.equal((await pi(big)).refund_state, 'due', 'nothing held');
    // 30 000 already approved today; 100 000 more would pass 150 000.
    const a = await duitkuIntent(100_000), b = await duitkuIntent(40_000);
    const ta = (await call('POST', `/v1/refunds/${a}/disbursement`, ACCOUNT)).json().transfer;
    const tb = (await call('POST', `/v1/refunds/${b}/disbursement`, ACCOUNT)).json().transfer;
    actor = APPROVER;
    assert.equal((await call('POST', `/v1/refund-transfers/${ta.id}/approve`)).json().transfer.state, 'succeeded', '130 000 today');
    const over = await call('POST', `/v1/refund-transfers/${tb.id}/approve`);
    assert.equal(over.statusCode, 422);
    assert.match(over.json().error, /daily limit/);
    assert.equal((await one<any>(`SELECT state FROM refund_transfer WHERE id = $1`, [tb.id]))!.state, 'awaiting_approval', 'it waits');
    // Rejected (withdrawn by its requester): the refund is due again, nothing sent.
    actor = REQUESTER;
    assert.equal((await call('POST', `/v1/refund-transfers/${tb.id}/reject`, {})).statusCode, 422, 'a reason is required');
    const rj = await call('POST', `/v1/refund-transfers/${tb.id}/reject`, { reason: 'over the daily limit' });
    assert.equal(rj.json().transfer.state, 'rejected');
    assert.equal((await pi(b)).refund_state, 'due');
  });

  test('a refused transfer makes the refund due again; an unknown result is asked about and only a confirmed one counts', async () => {
    await query(`UPDATE refund_transfer SET approved_at = now() - interval '2 days' WHERE org_id = $1 AND state = 'succeeded'`, [org]);
    actor = REQUESTER;
    const id = await duitkuIntent(20_000);
    const t = (await call('POST', `/v1/refunds/${id}/disbursement`, ACCOUNT)).json().transfer;
    transferCode = 'EE';
    actor = APPROVER;
    const a = (await call('POST', `/v1/refund-transfers/${t.id}/approve`)).json().transfer;
    assert.equal(a.state, 'failed');
    assert.deepEqual([(await pi(id)).refund_state, (await pi(id)).refund_method], ['failed', null]);
    assert.equal((await refunds.markRefundedManually(id, 'BCA 777', null)).ok, true, 'payable by bank transfer now');

    actor = REQUESTER;
    const id2 = await duitkuIntent(25_000);
    const t2 = (await call('POST', `/v1/refunds/${id2}/disbursement`, ACCOUNT)).json().transfer;
    transferCode = 'TO';
    actor = APPROVER;
    assert.equal((await call('POST', `/v1/refund-transfers/${t2.id}/approve`)).json().transfer.state, 'sent');
    assert.equal((await pi(id2)).refund_state, 'processing');
    // The refunds worker leaves it alone (not a gateway refund) …
    await query(`UPDATE payment_intent SET updated_at = now() - interval '1 hour' WHERE id = $1`, [id2]);
    await refunds.sweepProcessingRefunds();
    assert.deepEqual([(await pi(id2)).refund_state, (await pi(id2)).refund_method], ['processing', 'disbursement']);
    // … and asks Duitku: not confirmed yet → still sent; '00' → refunded.
    await query(`UPDATE refund_transfer SET updated_at = now() - interval '10 minutes' WHERE id = $1`, [t2.id]);
    statusCode = 'TO';
    await xfer.sweepTransfers();
    assert.equal((await one<any>(`SELECT state FROM refund_transfer WHERE id = $1`, [t2.id]))!.state, 'sent');
    await query(`UPDATE refund_transfer SET updated_at = now() - interval '10 minutes' WHERE id = $1`, [t2.id]);
    statusCode = '00';
    assert.equal(await xfer.sweepTransfers(), 1);
    assert.equal((await pi(id2)).refund_state, 'refunded');
    transferCode = '00';
  });

  test('settled by hand: a transfer Duitku never confirmed', async () => {
    actor = REQUESTER;
    const id = await duitkuIntent(15_000);
    const t = (await call('POST', `/v1/refunds/${id}/disbursement`, ACCOUNT)).json().transfer;
    transferCode = 'LD';
    actor = APPROVER;
    await call('POST', `/v1/refund-transfers/${t.id}/approve`);
    transferCode = '00';
    assert.equal((await call('POST', `/v1/refund-transfers/${t.id}/resolve`, { outcome: 'failed' })).statusCode, 422, 'a note is required');
    const r = await call('POST', `/v1/refund-transfers/${t.id}/resolve`, { outcome: 'failed', note: 'Duitku dashboard: failed, bank offline' });
    assert.equal(r.json().transfer.state, 'failed');
    assert.equal((await pi(id)).refund_state, 'failed');
    assert.equal((await call('POST', `/v1/refund-transfers/${t.id}/resolve`, { outcome: 'succeeded', note: 'x' })).statusCode, 409);
    const list = (await call('GET', '/v1/refund-transfers?open=true')).json().transfers;
    assert.ok(list.every((x: any) => ['awaiting_approval', 'sending', 'sent'].includes(x.state)));
  });

  test('only Duitku payments, and only with Disbursement set up', async () => {
    actor = REQUESTER;
    const x = (await one<{ id: string }>(
      `INSERT INTO payment_intent (org_id, provider, method, mode, state, amount_authorised_minor, amount_captured_minor, integration_id, channel, refund_state, refund_due_minor, refund_requested_at)
       VALUES ($1, 'xendit', 'qris', 'prepurchase', 'captured', 9000, 9000, $2, 'QRIS', 'due', 9000, now()) RETURNING id`, [org, xenditId]))!.id;
    assert.equal((await call('POST', `/v1/refunds/${x}/disbursement`, ACCOUNT)).statusCode, 409);
    const id = await duitkuIntent();
    assert.ok((await xfer.disbursementAvailable([id, x])).has(id));
    assert.equal((await call('POST', `/v1/refunds/${id}/disbursement`, { ...ACCOUNT, accountNumber: '99' })).statusCode, 422);
    assert.equal((await call('POST', `/v1/refunds/${id}/disbursement`, { ...ACCOUNT, accountNumber: '9999999999' })).statusCode, 422, 'Duitku cannot find the account');
    assert.equal((await pi(id)).refund_state, 'due');
  });
});

dbDescribe('Owners\' bank accounts checked by name', () => {
  test('matched, mismatch; the check cleared when the holder or the account changes', async () => {
    actor = REQUESTER;
    await call('PUT', `/v1/finance/owners/${owner}/bank-account`, { bankName: 'BCA', bankCode: '014', holderName: 'PT Hotel Nusantara', accountNumber: '5550001111' });
    const c = await call('POST', `/v1/finance/owners/${owner}/bank-account/check`);
    assert.equal(c.statusCode, 200, c.body);
    assert.deepEqual({ s: c.json().check.status, n: c.json().account.nameCheck.bankName }, { s: 'matched', n: 'PT HOTEL NUSANTARA' });
    // The same account, the name unchanged: the check stands.
    await call('PUT', `/v1/finance/owners/${owner}/bank-account`, { bankName: 'Bank Central Asia', bankCode: '014', holderName: 'PT Hotel Nusantara' });
    assert.equal((await call('GET', `/v1/finance/owners/${owner}/bank-account`)).json().account.nameCheck.status, 'matched');
    await call('PUT', `/v1/finance/owners/${owner}/bank-account`, { bankName: 'BCA', bankCode: '014', holderName: 'Siti Rahayu' });
    assert.equal((await call('GET', `/v1/finance/owners/${owner}/bank-account`)).json().account.nameCheck, null, 'a new holder: not checked');
    assert.equal((await call('POST', `/v1/finance/owners/${owner}/bank-account/check`)).json().check.status, 'mismatch');
    await call('PUT', `/v1/finance/owners/${owner}/bank-account`, { bankName: 'BCA', bankCode: '014', holderName: 'Siti Rahayu', accountNumber: '1234567890' });
    assert.equal((await call('GET', `/v1/finance/owners/${owner}/bank-account`)).json().account.nameCheck, null, 'a new account: not checked');
  });
});

dbDescribe('The Refunds list and the actual MDR', () => {
  test('a Xendit QRIS refund: its window, the ledger\'s refund status and fee, the payment\'s fee kept on a partial refund', async () => {
    const id = (await one<{ id: string }>(
      `INSERT INTO payment_intent (org_id, provider, method, mode, state, amount_authorised_minor, amount_captured_minor, integration_id, channel, provider_ref, provider_payment_id, paid_at, refund_state, refund_due_minor, refund_requested_at, refund_ref)
       VALUES ($1, 'xendit', 'qris', 'prepurchase', 'captured', 50000, 50000, $2, 'QRIS', $3, 'qrpy_t1', now() - interval '3 days', 'processing', 20000, now(), 'qrr_t1') RETURNING id`,
      [org, xenditId, `ps-${TAG}-w`]))!.id;
    const g = (kind: string, ext: string, fee: number, vat: number) => query(
      `INSERT INTO gateway_transaction (integration_id, org_id, provider, external_id, kind, status, cashflow, currency, amount, fee, vat, gateway_created_at, gateway_updated_at, payment_intent_id)
       VALUES ($1, $2, 'xendit', $3, $4, $5, $6, 'IDR', 50000, $7, $8, now(), now(), $9)`, [xenditId, org, ext, kind, kind === 'refund' ? 'pending' : 'success', kind === 'refund' ? 'out' : 'in', fee, vat, id]);
    await g('payment', `txp-${TAG}`, 350, 38.5);
    await g('refund', 'qrr_t1', 0, 0);
    const row = (await refunds.listRefunds(org)).find((r: any) => r.id === id);
    assert.deepEqual(
      { w: row.refund_window_days, left: row.refund_days_left, p: row.partial, gs: row.gateway_refund_status, kept: row.fee_kept },
      { w: 7, left: 4, p: true, gs: 'pending', kept: 389 });
    const due = (await refunds.listRefunds(org)).filter((r: any) => r.refund_state !== 'refunded');
    assert.equal(due[0].id, id, 'the refund whose window closes first leads');
    const before = (await refunds.refundSummary(org)).closing_soon_count;
    await query(`UPDATE payment_intent SET refund_state = 'due' WHERE id = $1`, [id]);
    assert.equal((await refunds.refundSummary(org)).closing_soon_count, before + 1, 'processing is not counted; due is');
  });

  test('owner statements: the gateway\'s actual fee where Finance has the payment, else the estimate', async () => {
    const session = async (withLedger: boolean) => {
      const s = (await one<{ id: string }>(
        `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, state, started_at, ended_at, energy_wh, currency)
         VALUES ($1,$2,$3,$4,$5,'ended', '2026-09-15T03:00:00Z', '2026-09-15T04:00:00Z', 40000, 'IDR') RETURNING id`,
        [org, site, conn, cp, `mdr-${randomUUID()}`]))!.id;
      const p = (await one<{ id: string }>(
        `INSERT INTO payment_intent (org_id, provider, method, mode, state, amount_authorised_minor, amount_captured_minor, integration_id, channel, session_id)
         VALUES ($1, 'xendit', 'qris', 'prepurchase', 'captured', 200000, 200000, $2, 'QRIS', $3) RETURNING id`, [org, xenditId, s]))!.id;
      await query(`UPDATE charging_session SET payment_intent_id = $2 WHERE id = $1`, [s, p]);
      await query(
        `INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot)
         VALUES ($1,$2,'2026-09-15T04:00:00Z','[]',180180,0,0,165165,1200,19820,200000,'{}')`, [s, org]);
      if (withLedger) {
        await query(
          `INSERT INTO gateway_transaction (integration_id, org_id, provider, external_id, kind, status, cashflow, currency, amount, fee, vat, gateway_created_at, gateway_updated_at, payment_intent_id)
           VALUES ($1, $2, 'xendit', $3, 'payment', 'success', 'in', 'IDR', 200000, 1550.75, 170.58, now(), now(), $4)`, [xenditId, org, `mdr-${randomUUID()}`, p]);
      }
    };
    await session(true);
    await session(false);
    const st = await draftStatement(org, '2026-09');
    assert.deepEqual(st.mdrBasis, { actualMinor: 1721, estimatedMinor: 1400, actualPayments: 1, estimatedPayments: 1 });
    assert.equal(st.totals.mdrEstimateMinor, 1721 + 1400, 'the statement\'s MDR is actual + estimated');
  });

  test('the month close by operator and site, in the Excel export; post-pay and Hub in receivables and payables', async () => {
    const fin = await import('./finance.js');
    const { toXlsx } = await import('./finance-export.js');
    const p = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000) };
    const b = await fin.closeBreakdown(xenditId, p);
    const mine = b.byOperator.find((x) => x.orgId === org)!;
    assert.ok(mine, 'the operator is listed');
    assert.equal(mine.collected, 250_000, 'the QRIS payment and the statement\'s ledger payment');
    assert.equal(Math.round(mine.fees + mine.vat), 389 + 1721);
    const site1 = b.bySite.find((x) => x.site === `Disb site ${TAG}`)!;
    assert.equal(site1.collected, 200_000, 'attributed to its session\'s site');
    assert.ok(b.bySite.some((x) => x.site === null && x.collected === 50_000), 'no session: no site');
    const close = await fin.monthClose(xenditId, p as any);
    const zip = toXlsx({ id: xenditId, label: 'Test' } as any, close).toString('latin1');
    // Six sheets now: Summary, By channel, Fees, Transactions, then By operator and By site (the names are inside the deflated workbook).
    assert.ok(zip.includes('xl/worksheets/sheet6.xml') && !zip.includes('xl/worksheets/sheet7.xml'));
    assert.ok(close.bySite.length && close.byOperator.length);
    const r = await fin.receivables(xenditId, org);
    assert.deepEqual(r.postpay, { count: 0, amount: 0, failed: 0 });
    assert.deepEqual(r.hubPositions, []);
    assert.deepEqual((await fin.payables(xenditId, org)).hubPositions, []);
  });
});
