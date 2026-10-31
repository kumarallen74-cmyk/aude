import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 6 of the finance review (v1.17.0):
 *   - the accounting journal: double-entry entries per day and kind, every entry balanced, the operator's account codes;
 *   - the finance settings: the chart of accounts and the close e-mail, validated;
 *   - the monthly close e-mail: the export, PDF and journal attached, through the organisation's e-mail channel, a month
 *     once; refused without a channel;
 *   - Xendit Payouts as a rail: a refund of a Xendit payment and an owner payout sent through Xendit, two people, bank
 *     codes mapped to Xendit's channels, SUCCEEDED records them, FAILED is final.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-journal.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const store = await import('../integrations/store.js');
const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const close = await import('./finance-close-mail.js');
const xfer = await import('./refund-transfers.js');
const pxfer = await import('./payout-transfers.js');

const TAG = randomBytes(3).toString('hex');
const REQUESTER = randomUUID(), APPROVER = randomUUID();
let org = '', xenditId = '', owner = '', stmt = '';
let app: FastifyInstance;
let actor = REQUESTER;

// A fake Xendit: payouts (ACCEPTED, then whatever `payoutStatus` says), and nothing else.
const payouts = new Map<string, { status: string; body: any }>();
let payoutStatus = 'SUCCEEDED';
const seen: Array<{ path: string; body: any; headers: http.IncomingHttpHeaders }> = [];
let base = '';
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0]!;
    const b = raw ? JSON.parse(raw) : {};
    seen.push({ path, body: b, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    if (path === '/v2/payouts' && req.method === 'POST') {
      const key = String(req.headers['idempotency-key']);
      const existing = [...payouts.entries()].find(([, p]) => p.body.key === key);
      if (existing) return res.end(JSON.stringify({ id: existing[0], status: 'ACCEPTED' }));
      const id = `disb-${payouts.size + 1}-${TAG}`;
      payouts.set(id, { status: 'ACCEPTED', body: { ...b, key } });
      return res.end(JSON.stringify({ id, status: 'ACCEPTED', reference_id: b.reference_id }));
    }
    if (path.startsWith('/v2/payouts/')) {
      const p = payouts.get(path.slice('/v2/payouts/'.length));
      if (!p) { res.statusCode = 404; return res.end('{}'); }
      return res.end(JSON.stringify({ status: payoutStatus, failure_code: payoutStatus === 'FAILED' ? 'INVALID_DESTINATION' : undefined }));
    }
    res.statusCode = 404; res.end('{}');
  });
});

// A fake SMTP server: accepts every message and keeps it.
const mails: string[] = [];
let smtpPort = 0;
const smtp = net.createServer((sock) => {
  let data = false, buf = '';
  sock.write('220 fake ESMTP\r\n');
  sock.on('data', (chunk) => {
    buf += chunk.toString('latin1');
    if (data) {
      const end = buf.indexOf('\r\n.\r\n');
      if (end < 0) return;
      mails.push(buf.slice(0, end));
      buf = buf.slice(end + 5);
      data = false;
      sock.write('250 queued\r\n');
    }
    let i;
    while (!data && (i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake\r\n250 8BITMIME\r\n');
      else if (cmd === 'DATA') { data = true; sock.write('354 go\r\n'); }
      else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 ok\r\n');
    }
  });
});

const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });

if (DB_OK) {
  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', () => r()));
    smtpPort = (smtp.address() as any).port;
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1,$2) RETURNING id`, [`P6 ${TAG}`, `p6-${TAG}`]))!.id;
    for (const u of [REQUESTER, APPROVER]) await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, $4)`, [u, org, `${u.slice(0, 8)}@p6.test`, u === REQUESTER ? 'Rina' : 'Andi']);
    xenditId = ((await store.save('payments', org, { provider: 'xendit', settings: {
      environment: 'sandbox', methods: ['QRIS', 'DANA'], baseUrl: base, payoutsEnabled: true, disbursementMaxPerTransfer: 1_000_000, disbursementMaxPayout: 5_000_000,
    }, secrets: { secretKey: `xnd_development_${TAG}`, callbackToken: 'cb' } }, null)) as any).id;
    owner = (await one<{ id: string }>(`INSERT INTO site_owner (org_id, name, legal_name) VALUES ($1, $2, 'PT Hotel Nusantara') RETURNING id`, [org, `Hotel ${TAG}`]))!.id;
    stmt = (await one<{ id: string }>(
      `INSERT INTO commission_statement (org_id, owner_id, period, number, gtv_minor, commission_minor, minimum_topup_minor, private_fee_minor, mdr_credit_minor,
                                         net_minor, tax_minor, total_minor, owner_share_minor, data, finalised_at, currency)
       VALUES ($1, $2, '2026-09-01', $3, 1000000, 100000, 0, 0, 0, 100000, 11000, 111000, 800000, '{}'::jsonb, now(), 'IDR') RETURNING id`, [org, owner, `P6-${TAG}`]))!.id;
    // The ledger: 15 October (WIB): a payment, its fee and VAT, withholding tax, a refund, a withdrawal to the bank.
    const g = (ext: string, kind: string, cashflow: string, amount: number, fee: number, vat: number, wht = 0) => query(
      `INSERT INTO gateway_transaction (integration_id, org_id, provider, external_id, kind, status, cashflow, currency, amount, fee, vat, withholding_tax, gateway_created_at, gateway_updated_at)
       VALUES ($1, $2, 'xendit', $3, $4, 'success', $5, 'IDR', $6, $7, $8, $9, '2026-10-15T03:00:00Z', '2026-10-15T03:00:00Z')`, [xenditId, org, `${ext}-${TAG}`, kind, cashflow, amount, fee, vat, wht]);
    await g('p1', 'payment', 'in', 100_000, 700, 77, 14);
    await g('p2', 'payment', 'in', 50_000, 350, 38.5);
    await g('r1', 'refund', 'out', 20_000, 0, 0);
    await g('w1', 'payout', 'out', 120_000, 0, 0);
    await query(`INSERT INTO statement_payment (org_id, statement_id, kind, owner_id, amount_minor, currency, paid_on, reference, recorded_by)
                 VALUES ($1, $2, 'owner_payout', $3, 300000, 'IDR', '2026-10-20', 'BCA 1', $4)`, [org, stmt, owner, REQUESTER]);
    await query(`INSERT INTO notification_channel (org_id, kind, enabled, config) VALUES ($1, 'email', true, $2)`,
      [org, JSON.stringify({ host: '127.0.0.1', port: smtpPort, security: 'none', fromAddress: 'finance@plugsure.test', fromName: 'PlugSure Finance' })]);
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: actor, orgId: org, assignments: [{ permissions: ['payment:read', 'payment:write'], scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
    await call('PUT', `/v1/finance/owners/${owner}/bank-account`, { bankName: 'BCA', bankCode: '014', holderName: 'PT Hotel Nusantara', accountNumber: '5550001111' });
  });
  after(async () => {
    server.close(); smtp.close();
    await app?.close();
    await query(`DELETE FROM payout_transfer WHERE org_id = $1`, [org]);
    await query(`DELETE FROM refund_transfer WHERE org_id = $1`, [org]);
    await query(`DELETE FROM statement_payment WHERE org_id = $1`, [org]);
    await query(`DELETE FROM gateway_account_settings WHERE integration_id = $1`, [xenditId]);
    await query(`DELETE FROM gateway_transaction WHERE integration_id = $1`, [xenditId]);
    await query(`DELETE FROM payment_intent WHERE org_id = $1`, [org]);
    await query(`DELETE FROM commission_statement WHERE org_id = $1`, [org]);
    await query(`DELETE FROM owner_bank_account WHERE org_id = $1`, [org]);
    await query(`DELETE FROM site_owner WHERE org_id = $1`, [org]);
    await query(`DELETE FROM notification_channel WHERE org_id = $1`, [org]);
    await query(`DELETE FROM alert WHERE org_id = $1`, [org]);
    await query(`DELETE FROM integration_event WHERE integration_id IN (SELECT id FROM integration WHERE org_id = $1)`, [org]);
    await query(`DELETE FROM integration WHERE org_id = $1`, [org]);
    await query(`DELETE FROM app_user WHERE org_id = $1`, [org]).catch(() => { /* audit rows keep them */ });
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => { /* audit rows keep it */ });
    store.invalidate();
    await pool.end();
  });
}

dbDescribe('The accounting journal and the finance settings', () => {
  test('entries per day and kind, each balanced; the By account totals net to zero; the operator\'s codes', async () => {
    const r = await call('PUT', `/v1/finance/accounts/${xenditId}/settings`, { journalAccounts: { revenue: { code: '4-1100', name: 'Pendapatan pengisian' } } });
    assert.equal(r.statusCode, 200, r.body);
    const j = (await call('GET', `/v1/finance/accounts/${xenditId}/journal?format=json&from=2026-10-01&to=2026-10-31`)).json();
    const by = new Map<string, any[]>();
    for (const l of j.lines) by.set(l.entry, [...(by.get(l.entry) ?? []), l]);
    for (const [e, ls] of by) {
      const d = ls.reduce((a: number, l: any) => a + l.debit, 0), c = ls.reduce((a: number, l: any) => a + l.credit, 0);
      assert.equal(Math.round(d * 100), Math.round(c * 100), `entry ${e} balances`);
    }
    const line = (kind: string, code: string, side: 'debit' | 'credit') => j.lines.find((l: any) => l.kind === kind && l.code === code)?.[side];
    assert.equal(line('collections', '4-1100', 'credit'), 150_000, 'the operator\'s revenue code');
    assert.equal(line('collections', '1130', 'debit'), 150_000);
    assert.equal(line('fees', '6110', 'debit'), 1050);
    assert.equal(line('fees', '1410', 'debit'), 115.5);
    assert.equal(line('fees', '1130', 'credit'), 1165.5);
    assert.equal(line('withholding', '2140', 'credit'), 14);
    assert.equal(line('refunds', '4190', 'debit'), 20_000);
    assert.equal(line('withdrawals', '1110', 'debit'), 120_000);
    assert.equal(line('owner_payouts', '2120', 'debit'), 300_000);
    assert.equal(line('owner_payouts', '1110', 'credit'), 300_000);
    const net = j.totals.reduce((a: number, t: any) => a + t.debit - t.credit, 0);
    assert.equal(Math.round(net * 100), 0, 'the journal nets to zero');
    const csv = await call('GET', `/v1/finance/accounts/${xenditId}/journal?format=csv&from=2026-10-01&to=2026-10-31`);
    assert.match(csv.body, /^﻿Date,Entry,Account code,Account,Debit,Credit,Description,Kind\r\n/);
    const x = await call('GET', `/v1/finance/accounts/${xenditId}/journal?from=2026-10-01&to=2026-10-31`);
    assert.equal(x.rawPayload.readUInt32LE(0), 0x04034b50, 'Excel by default');
  });

  test('settings are validated', async () => {
    assert.equal((await call('PUT', `/v1/finance/accounts/${xenditId}/settings`, { journalAccounts: { nope: { code: '1' } } })).statusCode, 422);
    assert.equal((await call('PUT', `/v1/finance/accounts/${xenditId}/settings`, { journalAccounts: { bank: { code: 'has space' } } })).statusCode, 422);
    assert.equal((await call('PUT', `/v1/finance/accounts/${xenditId}/settings`, { closeEmail: { enabled: true, recipients: [] } })).statusCode, 422);
    assert.equal((await call('PUT', `/v1/finance/accounts/${xenditId}/settings`, { closeEmail: { recipients: ['not-an-email'] } })).statusCode, 422);
    const ok = (await call('PUT', `/v1/finance/accounts/${xenditId}/settings`, { closeEmail: { enabled: true, recipients: 'Finance@Operator.test, accountant@firm.test' } })).json();
    assert.deepEqual(ok.settings.closeEmail.recipients, ['finance@operator.test', 'accountant@firm.test']);
    assert.equal(ok.settings.journalAccounts.revenue.code, '4-1100', 'the chart kept');
  });
});

dbDescribe('The monthly close e-mail', () => {
  test('sent now: the export, PDF and journal attached, through the organisation\'s channel', async () => {
    mails.length = 0;
    const r = await call('POST', `/v1/finance/accounts/${xenditId}/close-email/send`, { month: '2026-10' });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().to, ['finance@operator.test', 'accountant@firm.test']);
    assert.equal(mails.length, 1);
    const m = mails[0]!;
    assert.match(m, /Subject: =\?UTF-8\?Q\?Finance_close_2026-10_/);
    for (const f of ['plugsure-finance-2026-10.xlsx', 'plugsure-finance-2026-10.pdf', 'plugsure-finance-2026-10-journal.xlsx']) assert.ok(m.includes(f), f);
    assert.equal((await call('POST', `/v1/finance/accounts/${xenditId}/close-email/send`, { month: '2026-13' })).statusCode, 422);
  });

  test('the worker: the previous month, once; without a channel it is kept as an error and retried', async () => {
    mails.length = 0;
    const now = new Date('2026-11-01T02:00:00Z');
    assert.equal(close.previousMonth(now), '2026-10');
    assert.equal(await close.closeMailAll(now), 1);
    assert.equal(await close.closeMailAll(now), 0, 'once a month');
    assert.equal(mails.length, 1);
    await query(`UPDATE gateway_account_settings SET close_email_sent_period = '2026-09', close_email_last_at = NULL WHERE integration_id = $1`, [xenditId]);
    await query(`UPDATE notification_channel SET enabled = false WHERE org_id = $1`, [org]);
    assert.equal(await close.closeMailAll(now), 0);
    const s = (await one<any>(`SELECT * FROM gateway_account_settings WHERE integration_id = $1`, [xenditId]))!;
    assert.match(s.close_email_last_error, /e-mail channel/);
    assert.equal(s.close_email_sent_period, '2026-09');
    await query(`UPDATE notification_channel SET enabled = true WHERE org_id = $1`, [org]);
  });
});

dbDescribe('Xendit Payouts as a rail', () => {
  test('a refund of a Xendit payment sent through Xendit: two people, bank code → channel, SUCCEEDED → refunded', async () => {
    const pi = (await one<{ id: string }>(
      `INSERT INTO payment_intent (org_id, provider, method, mode, state, amount_authorised_minor, amount_captured_minor, integration_id, channel, refund_state, refund_due_minor, refund_requested_at)
       VALUES ($1, 'xendit', 'card', 'prepurchase', 'captured', 60000, 60000, $2, 'CARD', 'due', 60000, now()) RETURNING id`, [org, xenditId]))!.id;
    assert.equal((await xfer.disbursementAvailable([pi])).get(pi), 'xendit');
    actor = REQUESTER;
    const r = await call('POST', `/v1/refunds/${pi}/disbursement`, { bankCode: '014', accountNumber: '1234567890', holderName: 'Budi Santoso' });
    assert.equal(r.statusCode, 201, r.body);
    const t = r.json().transfer;
    assert.deepEqual({ rail: t.rail, name: t.checkedName }, { rail: 'xendit', name: null });
    assert.equal((await call('POST', `/v1/refunds/${pi}/disbursement`, { bankCode: '999', accountNumber: '1', holderName: 'x' })).statusCode, 422);
    assert.equal((await call('POST', `/v1/refund-transfers/${t.id}/approve`)).statusCode, 403);
    actor = APPROVER;
    seen.length = 0;
    const a = (await call('POST', `/v1/refund-transfers/${t.id}/approve`)).json().transfer;
    assert.equal(a.state, 'sent', 'Xendit accepts; the result comes later');
    const sent = seen.find((x) => x.path === '/v2/payouts')!;
    assert.deepEqual({ ch: sent.body.channel_code, acct: sent.body.channel_properties.account_number, amt: sent.body.amount, key: sent.headers['idempotency-key'] },
      { ch: 'ID_BCA', acct: '1234567890', amt: 60_000, key: `ps-refund-${t.id}` });
    await query(`UPDATE refund_transfer SET updated_at = now() - interval '10 minutes' WHERE id = $1`, [t.id]);
    payoutStatus = 'SUCCEEDED';
    assert.equal(await xfer.sweepTransfers(), 1);
    const p = (await one<any>(`SELECT refund_state, refund_method, refund_ref FROM payment_intent WHERE id = $1`, [pi]))!;
    assert.deepEqual({ s: p.refund_state, m: p.refund_method }, { s: 'refunded', m: 'disbursement' });
    assert.match(p.refund_ref, /^xendit-payout-disb-/);
  });

  test('Xendit\'s refusal is final: the refund is due again', async () => {
    const pi = (await one<{ id: string }>(
      `INSERT INTO payment_intent (org_id, provider, method, mode, state, amount_authorised_minor, amount_captured_minor, integration_id, channel, refund_state, refund_due_minor, refund_requested_at)
       VALUES ($1, 'xendit', 'card', 'prepurchase', 'captured', 40000, 40000, $2, 'CARD', 'due', 40000, now()) RETURNING id`, [org, xenditId]))!.id;
    actor = REQUESTER;
    const t = (await call('POST', `/v1/refunds/${pi}/disbursement`, { bankCode: 'ID_MANDIRI', accountNumber: '9876543210', holderName: 'Siti' })).json().transfer;
    actor = APPROVER;
    await call('POST', `/v1/refund-transfers/${t.id}/approve`);
    await query(`UPDATE refund_transfer SET updated_at = now() - interval '10 minutes' WHERE id = $1`, [t.id]);
    payoutStatus = 'FAILED';
    await xfer.sweepTransfers();
    assert.equal((await one<any>(`SELECT state FROM refund_transfer WHERE id = $1`, [t.id]))!.state, 'failed');
    assert.equal((await one<any>(`SELECT refund_state FROM payment_intent WHERE id = $1`, [pi]))!.refund_state, 'failed');
    payoutStatus = 'SUCCEEDED';
  });

  test('an owner payout through Xendit (the operator\'s own account): recorded against the statement when it succeeds', async () => {
    actor = REQUESTER;
    const shares = (await call('GET', '/v1/finance/owner-shares')).json();
    assert.deepEqual(shares.payoutRails, ['xendit']);
    const t = (await call('POST', `/v1/finance/statements/${stmt}/payout`, { amount: 500_000, rail: 'xendit' })).json().transfer;
    assert.equal(t.rail, 'xendit');
    assert.equal((await call('POST', `/v1/finance/statements/${stmt}/payout`, { amount: 1, rail: 'duitku' })).statusCode, 409, 'no Duitku account');
    actor = APPROVER;
    assert.equal((await call('POST', `/v1/finance/payout-transfers/${t.id}/approve`)).json().transfer.state, 'sent');
    await query(`UPDATE payout_transfer SET updated_at = now() - interval '10 minutes' WHERE id = $1`, [t.id]);
    assert.equal(await pxfer.sweepPayouts(), 1);
    const p = (await one<any>(`SELECT sp.reference, sp.amount_minor FROM payout_transfer t JOIN statement_payment sp ON sp.id = t.statement_payment_id WHERE t.id = $1`, [t.id]))!;
    assert.deepEqual({ ref: p.reference.startsWith('Xendit Payouts disb-'), amt: Number(p.amount_minor) }, { ref: true, amt: 500_000 });
    assert.equal((await call('GET', '/v1/finance/owner-shares')).json().shares.find((x: any) => x.statementId === stmt).status, 'paid', '300 000 recorded + 500 000 sent = 800 000');
  });
});
