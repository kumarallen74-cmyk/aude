import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Finance (v1.12.0), against the database and a fake Xendit:
 *   - the transaction sync: pages followed with after_id, fee / VAT / net / settlement stored, re-sync updates (settled),
 *     a run stopped on its page limit continues from its cursor; matching to payments, passes and refunds;
 *   - balance snapshots; the overview, receivables, payables, fees (QRIS actual vs estimate);
 *   - reconciliation: paid at Xendit but pending in PlugSure (applied from the ledger), amount mismatch, missing at
 *     the gateway, settlement overdue; cleared exceptions close themselves; the alert;
 *   - the routes: accounts per caller (an operator never sees another's or the platform's), exports (CSV, a valid
 *     .xlsx, a PDF), audit, permissions.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const store = await import('../integrations/store.js');
const fin = await import('./finance.js');
const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const { zip, crc32 } = await import('./xlsx.js');

const TAG = randomBytes(3).toString('hex');
let org = '', other = '', acct = '';
let app: FastifyInstance;
let role: 'finance' | 'viewer' | 'platform' | 'other' = 'finance';

// ── the fake Xendit: transactions newest first, pages of `limit`, after_id
let base = '';
let txs: any[] = [];
let balance = 1_234_567.5;
const seen: Array<{ path: string; query: URLSearchParams; auth?: string }> = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  seen.push({ path: u.pathname, query: u.searchParams, auth: req.headers.authorization });
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/balance') return res.end(JSON.stringify({ balance }));
  if (u.pathname === '/transactions') {
    const since = u.searchParams.get('updated[gte]');
    const list = txs.filter((t) => !since || t.updated >= since).sort((a, b) => (a.updated < b.updated ? 1 : -1));
    const after = u.searchParams.get('after_id');
    const start = after ? list.findIndex((t) => t.id === after) + 1 : 0;
    const limit = Number(u.searchParams.get('limit') ?? 10);
    const page = list.slice(start, start + limit);
    return res.end(JSON.stringify({ data: page, has_more: start + limit < list.length }));
  }
  res.statusCode = 404; res.end(JSON.stringify({ error_code: 'NOT_FOUND', message: 'no fake' }));
});

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const H = 3_600_000, D = 24 * H;
const ref = (n: number) => `ps-${TAG}${String(n).padStart(26, '0')}`;
const tx = (id: string, o: Record<string, unknown>) => ({
  id: `txn_${TAG}_${id}`, product_id: `qrpy_${TAG}_${id}`, type: 'PAYMENT', status: 'SUCCESS', channel_category: 'QR_CODE', channel_code: 'QRIS',
  currency: 'IDR', cashflow: 'MONEY_IN', settlement_status: 'PENDING', estimated_settlement_time: iso(-D),
  fee: { xendit_fee: 350, value_added_tax: 38.5, xendit_withholding_tax: 0, third_party_withholding_tax: 0, status: 'COMPLETED' },
  created: iso(2 * H), updated: iso(2 * H), ...o,
});
const intent = async (n: number, o: { state?: string; amount?: number; paidAgo?: number; refund?: string | null; refundRef?: string | null; channel?: string } = {}) => (await one<{ id: string }>(
  `INSERT INTO payment_intent (org_id, provider, provider_ref, method, mode, state, amount_authorised_minor, amount_captured_minor, integration_id, paid_at, channel, refund_state, refund_due_minor, refund_ref, expires_at)
   VALUES ($1, 'xendit', $2, 'qris', 'prepurchase', $3::text, $4::int, CASE WHEN $3::text IN ('captured', 'refunded') THEN $4::int END, $5, CASE WHEN $3::text IN ('captured', 'refunded') THEN now() - make_interval(secs => $6::bigint / 1000.0) END, $7, $8::text, CASE WHEN $8::text IS NOT NULL THEN $4::int END, $9, now() + interval '10 minutes')
   RETURNING id`,
  [org, ref(n), o.state ?? 'captured', o.amount ?? 50_000, acct, o.paidAgo ?? 2 * H, o.channel ?? 'QRIS', o.refund ?? null, o.refundRef ?? null]))!.id;

if (DB_OK) {
  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1,$2) RETURNING id`, [`Fin ${TAG}`, `fin-${TAG}`]))!.id;
    other = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1,$2) RETURNING id`, [`Fin other ${TAG}`, `fin-other-${TAG}`]))!.id;
    const saved = await store.save('payments', org, {
      provider: 'xendit', settings: { environment: 'sandbox', methods: ['QRIS'], baseUrl: base },
      secrets: { secretKey: `xnd_development_${TAG}`, callbackToken: `cb-${TAG}` },
    }, null);
    acct = (saved as any).id;
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      const perms = role === 'finance' ? ['payment:read', 'payment:write'] : role === 'viewer' ? ['org:read'] : role === 'platform' ? ['payment:read', 'payment:write', 'platform:admin'] : ['payment:read', 'payment:write'];
      (req as any).principal = { userId: randomUUID(), orgId: role === 'other' ? other : org, assignments: [{ permissions: perms, scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
  });
  after(async () => {
    await app?.close();
    server.close();
    await query(`DELETE FROM reconciliation_exception WHERE integration_id = $1`, [acct]);
    await query(`DELETE FROM gateway_transaction WHERE integration_id = $1`, [acct]);
    await query(`DELETE FROM gateway_balance_snapshot WHERE integration_id = $1`, [acct]);
    await query(`DELETE FROM gateway_sync_state WHERE integration_id = $1`, [acct]);
    await query(`DELETE FROM integration_event WHERE integration_id = $1`, [acct]);
    await query(`DELETE FROM payment_intent WHERE org_id = $1`, [org]);
    await query(`DELETE FROM alert WHERE org_id = $1`, [org]);
    await query(`DELETE FROM integration WHERE org_id = $1`, [org]);
    for (const o of [org, other]) await query(`DELETE FROM organisation WHERE id = $1`, [o]).catch(() => { /* audit rows keep it */ });
    store.invalidate();
    await pool.end();
  });
}

dbDescribe('Finance: the Xendit ledger', () => {
  let paid = '', late = '', short = '', refunded = '', absent = '';

  test('sync: every page, fees, VAT, net and settlement; matched to payments and refunds', async () => {
    paid = await intent(1);
    late = await intent(2, { state: 'pending' });            // paid at Xendit, the notification never came
    short = await intent(3, { amount: 60_000 });            // Xendit says 50,000
    refunded = await intent(4, { refund: 'processing', refundRef: `rfd_${TAG}_4` });
    absent = await intent(5, { paidAgo: 3 * D });           // PlugSure says paid, Xendit has nothing
    txs = [
      tx('1', { reference_id: ref(1), amount: 50_000, net_amount: 49_611.5 }),
      tx('2', { reference_id: ref(2), amount: 50_000, created: iso(H), updated: iso(H) }),
      tx('3', { reference_id: ref(3), amount: 50_000 }),
      tx('4', { reference_id: ref(4), amount: 75_000, settlement_status: 'SETTLED', created: iso(4 * D), updated: iso(4 * D) }),
      tx('r4', { type: 'REFUND', cashflow: 'MONEY_OUT', product_id: `rfd_${TAG}_4`, reference_id: `x-${TAG}`, amount: 75_000, settlement_status: null, estimated_settlement_time: null, fee: { xendit_fee: 0, value_added_tax: 0 } }),
      tx('ovo', { reference_id: ref(9), amount: 20_000, channel_category: 'EWALLET', channel_code: 'ID_OVO', settlement_status: 'PENDING', estimated_settlement_time: iso(3 * D), created: iso(6 * D), updated: iso(6 * D), fee: { xendit_fee: 300, value_added_tax: 33 } }),
      tx('out', { type: 'DISBURSEMENT', cashflow: 'MONEY_OUT', reference_id: `wd-${TAG}`, amount: 1_000_000, channel_category: 'BANK', channel_code: 'ID_BCA', settlement_status: null, estimated_settlement_time: null, fee: { xendit_fee: 4_000, value_added_tax: 440 } }),
    ];
    seen.length = 0;
    const r = await fin.syncTransactions(acct);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.rows, 7);
    assert.equal(r.complete, true);
    const calls = seen.filter((s) => s.path === '/transactions');
    assert.equal(calls[0]!.query.get('limit'), '50');
    assert.ok(calls[0]!.query.get('updated[gte]'), 'the first run asks for the last 35 days');
    assert.equal(calls[0]!.auth, 'Basic ' + Buffer.from(`xnd_development_${TAG}:`).toString('base64'));
    const g1 = (await one<any>(`SELECT * FROM gateway_transaction WHERE integration_id = $1 AND external_id = $2`, [acct, `txn_${TAG}_1`]))!;
    assert.equal(Number(g1.amount), 50_000);
    assert.equal(Number(g1.fee), 350);
    assert.equal(Number(g1.vat), 38.5);
    assert.equal(Number(g1.net_amount), 49_611.5);
    assert.equal(g1.settlement_status, 'pending');
    assert.equal(g1.matched, 'intent');
    assert.equal(g1.payment_intent_id, paid);
    assert.equal(g1.org_id, org);
    const r4 = (await one<any>(`SELECT * FROM gateway_transaction WHERE integration_id = $1 AND external_id = $2`, [acct, `txn_${TAG}_r4`]))!;
    assert.equal(r4.kind, 'refund');
    assert.equal(r4.matched, 'refund');
    assert.equal(r4.payment_intent_id, refunded);
    const out = (await one<any>(`SELECT * FROM gateway_transaction WHERE integration_id = $1 AND external_id = $2`, [acct, `txn_${TAG}_out`]))!;
    assert.equal(out.kind, 'payout');
    assert.equal(Number(out.net_amount), 1_004_440, 'money out: amount + fee + VAT when Xendit gives no net');
    assert.equal((await one<any>(`SELECT matched FROM gateway_transaction WHERE integration_id = $1 AND external_id = $2`, [acct, `txn_${TAG}_ovo`]))!.matched, null);
  });

  test('re-sync: only what changed since (with an overlap); a settlement is recorded once', async () => {
    const t1 = txs.find((t) => t.id === `txn_${TAG}_1`)!;
    Object.assign(t1, { settlement_status: 'SETTLED', updated: iso(0) });
    seen.length = 0;
    const r = await fin.syncTransactions(acct);
    assert.equal(r.ok, true);
    assert.ok(r.rows >= 1 && r.rows < 7, `only recent changes (${r.rows})`);
    const g1 = (await one<any>(`SELECT * FROM gateway_transaction WHERE integration_id = $1 AND external_id = $2`, [acct, `txn_${TAG}_1`]))!;
    assert.equal(g1.settlement_status, 'settled');
    assert.ok(g1.settled_seen_at);
    const since = new Date(seen.find((s) => s.path === '/transactions')!.query.get('updated[gte]')!);
    // The newest change synced before was an hour ago: asked from then minus the 10-minute overlap.
    const age = Date.now() - since.getTime();
    assert.ok(age > 69 * 60_000 && age < 72 * 60_000, `from the watermark minus the overlap (${Math.round(age / 60_000)} min)`);
  });

  test('a long backlog continues from its cursor on the next run', async () => {
    const bulk = Array.from({ length: 120 }, (_, i) => tx(`bulk${i}`, { reference_id: `bulk-${TAG}-${i}`, amount: 1_000, created: iso(10 * D), updated: iso(10 * D - i * 1000) }));
    txs.push(...bulk);
    await query(`UPDATE gateway_sync_state SET watermark = now() - interval '20 days' WHERE integration_id = $1`, [acct]);
    // 120 changes: three pages of 50. With one page a run, the run stops and the next continues from its cursor.
    fin.setMaxPages(1);
    try {
      const r1 = await fin.syncTransactions(acct);
      assert.equal(r1.complete, false);
      const st = (await one<any>(`SELECT * FROM gateway_sync_state WHERE integration_id = $1`, [acct]))!;
      assert.ok(st.resume_after_id, 'the cursor is kept');
      seen.length = 0;
      const r2 = await fin.syncTransactions(acct);
      assert.equal(r2.complete, false);
      assert.equal(seen.find((x) => x.path === '/transactions')!.query.get('after_id'), st.resume_after_id, 'the next run starts from the cursor');
      const r3 = await fin.syncTransactions(acct);
      assert.equal(r3.complete, true);
      assert.equal((await one<any>(`SELECT resume_after_id FROM gateway_sync_state WHERE integration_id = $1`, [acct]))!.resume_after_id, null);
    } finally { fin.setMaxPages(40); }
    assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM gateway_transaction WHERE integration_id = $1 AND external_id LIKE $2`, [acct, `txn_${TAG}_bulk%`]))!.n, 120);
    txs = txs.filter((t) => !t.id.includes('_bulk'));
    await query(`DELETE FROM gateway_transaction WHERE integration_id = $1 AND external_id LIKE $2`, [acct, `txn_${TAG}_bulk%`]);
  });

  test('balance snapshot; overview, receivables, payables, fees', async () => {
    assert.equal(await fin.snapshotBalance(acct), 1_234_567.5);
    const p = fin.periodOf(new Date(Date.now() - 30 * D).toISOString().slice(0, 10), new Date().toISOString().slice(0, 10));
    const o = await fin.overview(acct, p);
    assert.equal(o.collected, 50_000 * 3 + 75_000 + 20_000);
    assert.equal(o.payments, 5);
    assert.equal(o.refunds, 75_000);
    assert.equal(o.payouts, 1_000_000);
    assert.equal(o.balance!.amount, 1_234_567.5);
    assert.ok(o.receivable.amount > 0);
    assert.ok(o.receivable.overdue > 0, 'the OVO payment was due three days ago');
    assert.equal(o.net, o.collected - o.fees - o.vat - o.refunds);
    assert.ok(o.byChannel.some((c) => c.channel === 'QRIS') && o.byChannel.some((c) => c.channel === 'ID_OVO'));
    const rv = await fin.receivables(acct, org);
    assert.ok(rv.rows.every((r) => r.settlement === 'pending'));
    assert.ok(rv.byDay.some((d) => d.overdue));
    const pay = await fin.payables(acct);
    const rf = pay.refunds.find((x) => x.paymentId === refunded)!;
    assert.equal(rf.state, 'processing');
    const fe = await fin.fees(acct, p);
    assert.ok(fe.rows.length >= 2);
    assert.equal(fe.qris.payments, 4);
    assert.equal(fe.qris.actual, 4 * 388.5);
  });

  test('reconciliation: the differences, applied or resolved; cleared ones close themselves; an alert', async () => {
    const r = await fin.reconcile(acct);
    const ex = await fin.exceptions(acct, 'open', 100);
    const kinds = (k: string) => ex.filter((e) => e.kind === k);
    const missing = kinds('missing_in_plugsure');
    assert.ok(missing.some((e) => e.paymentId === late && e.canApply), 'paid at Xendit, pending in PlugSure');
    assert.ok(missing.some((e) => e.reference === ref(9) && !e.canApply), 'paid at Xendit, unknown to PlugSure');
    assert.ok(kinds('amount_mismatch').some((e) => e.paymentId === short));
    assert.ok(kinds('missing_at_gateway').some((e) => e.paymentId === absent));
    assert.ok(kinds('settlement_overdue').length >= 1);
    assert.ok(kinds('refund_mismatch').some((e) => e.paymentId === refunded), 'refund succeeded at Xendit, still processing in PlugSure');
    assert.equal(r.open, ex.length);
    assert.ok(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'finance.reconciliation' AND resolved_at IS NULL`, [org]));
    // Apply the late payment: it becomes paid in PlugSure through the normal notification path.
    const m = missing.find((e) => e.paymentId === late)!;
    const applied = await app.inject({ method: 'POST', url: `/v1/finance/accounts/${acct}/exceptions/${m.id}/apply` });
    assert.equal(applied.statusCode, 200, applied.body);
    assert.ok(applied.json().outcome);
    assert.notEqual((await one<{ state: string }>(`SELECT state FROM payment_intent WHERE id = $1`, [late]))!.state, 'pending');
    assert.equal((await app.inject({ method: 'POST', url: `/v1/finance/accounts/${acct}/exceptions/${m.id}/apply` })).statusCode, 409, 'once');
    const unknown = missing.find((e) => e.reference === ref(9))!;
    assert.equal((await app.inject({ method: 'POST', url: `/v1/finance/accounts/${acct}/exceptions/${unknown.id}/apply` })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/finance/accounts/${acct}/exceptions/${unknown.id}/resolve`, payload: { note: '' } })).statusCode, 422);
    const res = await app.inject({ method: 'POST', url: `/v1/finance/accounts/${acct}/exceptions/${unknown.id}/resolve`, payload: { note: 'A manual invoice, not a charging payment.' } });
    assert.equal(res.statusCode, 200);
    // Put the amount right and refund PlugSure's refund: those clear on the next pass.
    await query(`UPDATE payment_intent SET amount_captured_minor = 50000, amount_authorised_minor = 50000 WHERE id = $1`, [short]);
    await query(`UPDATE payment_intent SET refund_state = 'refunded', refunded_minor = refund_due_minor, refunded_at = now() WHERE id = $1`, [refunded]);
    await fin.reconcile(acct);
    const after = await fin.exceptions(acct, null, 100);
    const ofKind = (k: string, id: string) => after.find((e) => e.kind === k && e.paymentId === id)!;
    assert.equal(ofKind('amount_mismatch', short).state, 'resolved');
    assert.match(ofKind('amount_mismatch', short).resolution!, /Cleared/);
    assert.equal(ofKind('refund_mismatch', refunded).state, 'resolved');
    assert.equal(after.find((e) => e.id === unknown.id)!.state, 'resolved', 'a resolved exception is not reopened');
    assert.ok(await one(`SELECT 1 FROM audit_log WHERE action = 'finance.exception_applied' AND target_id = $1`, [acct]));
  });

  test('routes: accounts per caller, periods, filters, exports, permissions', async () => {
    const accts = (await app.inject({ method: 'GET', url: '/v1/finance/accounts' })).json().accounts;
    assert.ok(accts.some((a: any) => a.id === acct && a.testMode));
    assert.ok(accts.every((a: any) => a.orgId === org), 'an operator never sees the platform\'s account');
    const ov = await app.inject({ method: 'GET', url: `/v1/finance/accounts/${acct}/overview?from=2026-01-01&to=2026-12-31` });
    assert.equal(ov.statusCode, 200, ov.body);
    assert.equal(ov.json().account.id, acct);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/finance/accounts/${acct}/overview?from=31-10-2026` })).statusCode, 400);
    const list = (await app.inject({ method: 'GET', url: `/v1/finance/accounts/${acct}/transactions?kind=payment&matched=true&from=2026-01-01&to=2026-12-31` })).json();
    assert.ok(list.transactions.length >= 3 && list.transactions.every((t: any) => t.kind === 'payment' && t.matched));
    assert.equal((await app.inject({ method: 'GET', url: `/v1/finance/accounts/${acct}/transactions?kind=nope` })).statusCode, 400);
    for (const path of ['receivables', 'payables', 'fees', 'exceptions']) {
      assert.equal((await app.inject({ method: 'GET', url: `/v1/finance/accounts/${acct}/${path}` })).statusCode, 200, path);
    }
    // Exports: CSV (BOM, header, a row per transaction), a valid .xlsx (a zip with its parts), a PDF.
    const csv = await app.inject({ method: 'GET', url: `/v1/finance/accounts/${acct}/export?format=csv&from=2026-01-01&to=2026-12-31` });
    assert.equal(csv.statusCode, 200);
    assert.match(csv.headers['content-type'] as string, /text\/csv/);
    assert.ok(csv.body.startsWith('﻿Date,Gateway id,Type'));
    assert.ok(csv.body.includes(`txn_${TAG}_1`));
    const x = await app.inject({ method: 'GET', url: `/v1/finance/accounts/${acct}/export?format=xlsx&from=2026-01-01&to=2026-12-31` });
    assert.equal(x.statusCode, 200);
    const buf = x.rawPayload;
    assert.equal(buf.readUInt32LE(0), 0x04034b50, 'a zip');
    const parts = unzip(buf);
    assert.ok(parts['xl/workbook.xml']!.includes('name="Transactions"'));
    assert.ok(parts['xl/worksheets/sheet4.xml']!.includes(`txn_${TAG}_1`));
    assert.match(x.headers['content-disposition'] as string, /attachment; filename="plugsure-finance-2026-01-01-2026-12-31\.xlsx"/);
    const pdf = await app.inject({ method: 'GET', url: `/v1/finance/accounts/${acct}/export?format=pdf&from=2026-01-01&to=2026-12-31` });
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf.rawPayload.subarray(0, 5).toString(), '%PDF-');
    assert.ok(await one(`SELECT 1 FROM audit_log WHERE action = 'finance.exported' AND target_id = $1`, [acct]));
    // Another operator: not its account.
    role = 'other';
    try {
      assert.equal((await app.inject({ method: 'GET', url: `/v1/finance/accounts/${acct}/overview` })).statusCode, 404);
      assert.deepEqual((await app.inject({ method: 'GET', url: '/v1/finance/accounts' })).json().accounts.filter((a: any) => a.id === acct), []);
    } finally { role = 'finance'; }
    // Without payment:read, nothing; without payment:write, no actions.
    role = 'viewer';
    try {
      assert.equal((await app.inject({ method: 'GET', url: '/v1/finance/accounts' })).statusCode, 403);
      assert.equal((await app.inject({ method: 'POST', url: `/v1/finance/accounts/${acct}/sync` })).statusCode, 403);
    } finally { role = 'finance'; }
    const s = await app.inject({ method: 'POST', url: `/v1/finance/accounts/${acct}/sync` });
    assert.equal(s.statusCode, 200, s.body);
    assert.equal(s.json().sync.ok, true);
    assert.equal(s.json().balance, 1_234_567.5);
  });

  test('a Xendit error is the sync\'s state, not an exception', async () => {
    const saveBase = base;
    await query(`UPDATE integration SET settings = jsonb_set(settings, '{baseUrl}', to_jsonb($2::text)) WHERE id = $1`, [acct, `${saveBase}/broken`]);
    store.invalidate();
    const r = await fin.syncTransactions(acct);
    assert.equal(r.ok, false);
    assert.match(r.error!, /Xendit transactions: 404/);
    const st = (await one<any>(`SELECT * FROM gateway_sync_state WHERE integration_id = $1`, [acct]))!;
    assert.equal(st.last_ok, false);
    await query(`UPDATE integration SET settings = jsonb_set(settings, '{baseUrl}', to_jsonb($2::text)) WHERE id = $1`, [acct, saveBase]);
    store.invalidate();
    void many;
  });

  test('xlsx: the zip is well formed (CRC, sizes)', () => {
    const z = zip([{ name: 'a.txt', data: Buffer.from('hello') }]);
    const parts = unzip(z);
    assert.equal(parts['a.txt'], 'hello');
    assert.equal(crc32(Buffer.from('hello')), 0x3610a686);
  });
});

/** A minimal unzip for the tests: the central directory, then each entry (deflate), CRC checked. */
function unzip(b: Buffer): Record<string, string> {
  const end = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = b.readUInt16LE(end + 10), cdOff = b.readUInt32LE(end + 16);
  const out: Record<string, string> = {};
  let p = cdOff;
  for (let i = 0; i < n; i++) {
    const comp = b.readUInt32LE(p + 20), nameLen = b.readUInt16LE(p + 28), off = b.readUInt32LE(p + 42), crc = b.readUInt32LE(p + 16);
    const name = b.subarray(p + 46, p + 46 + nameLen).toString();
    const lnl = b.readUInt16LE(off + 26), lel = b.readUInt16LE(off + 28);
    const data = inflateRawSync(b.subarray(off + 30 + lnl + lel, off + 30 + lnl + lel + comp));
    assert.equal(crc32(data), crc, `CRC of ${name}`);
    out[name] = data.toString();
    p += 46 + nameLen + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
  }
  return out;
}
