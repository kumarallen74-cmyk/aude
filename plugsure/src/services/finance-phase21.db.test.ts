import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 21 of the finance review (v1.32.0):
 *   - bank feeds: lines fetched from a JSON endpoint with the sealed token, stored once (a second run adds nothing),
 *     matched; the rules ignoring bank fees and suggesting a journal entry for interest;
 *   - withholding: PPh 21 (an individual, Pasal 17 on half the gross), PPh 26 (the treaty rate) and PPh 23 on bills;
 *     the month's slips drafted, issued, refreshed and voided; the e-Bupot workbook; the tax calendar and the ledger;
 *   - report pack: drafted with its figures, the summary needed, approved by a second Finance Manager, the PDF and the
 *     workbook, sent back; sending checked;
 *   - close v2: the steps checked, a failing step accepted only by a Finance Manager with a note, the policy holding
 *     the lock until every step is signed off, the evidence pack.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase21.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const wht = await import('./withholding-tax.js');
const feeds = await import('./bank-feeds.js');

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

// The bank's endpoint.
let bankServer: Server;
let bankUrl = '';
const seen: Array<{ auth: string | undefined; from: string | null }> = [];
let txs: unknown[] = [];

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Close ${TAG}`, `p21-${TAG}`]))!.id;
    for (const [u, n] of [[A, 'Rina'], [B, 'Budi']] as const) await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, $4)`, [u, org, `${u.slice(0, 8)}@p21.test`, n]);
    app = Fastify({ bodyLimit: 6 * 1024 * 1024 });
    app.addHook('onRequest', async (req) => {
      const perms = ['payment:read', 'payment:write', 'invoice:read', 'invoice:write', ...(approver ? ['finance:approve'] : [])];
      (req as any).principal = { userId: principalUser, orgId: org, assignments: [{ permissions: perms, scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
    bankServer = createServer((req, res) => {
      seen.push({ auth: req.headers.authorization, from: new URL(req.url ?? '/', 'http://x').searchParams.get('from') });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ transactions: txs }));
    });
    await new Promise<void>((r) => bankServer.listen(0, '127.0.0.1', () => r()));
    bankUrl = `http://127.0.0.1:${(bankServer.address() as any).port}/mutations`;
  });
  after(async () => {
    await app?.close();
    await new Promise((r) => bankServer?.close(r));
    const o = [org];
    await query(`DELETE FROM gl_line WHERE org_id = ANY($1::uuid[])`, [o]);
    for (const t of ['bank_statement_line', 'bank_statement', 'bank_feed', 'bank_match_rule', 'tax_slip', 'report_pack', 'close_signoff', 'gl_entry', 'gl_account', 'tax_filing',
      'supplier_payment', 'supplier_bill', 'supplier', 'cash_transfer', 'cash_balance', 'cash_account', 'finance_period_lock', 'finance_org_settings']) await query(`DELETE FROM ${t} WHERE org_id = ANY($1::uuid[])`, [o]);
    await query(`DELETE FROM alert WHERE org_id = ANY($1::uuid[])`, [o]);
    await query(`DELETE FROM app_user WHERE org_id = ANY($1::uuid[])`, [o]).catch(() => { /* audit rows keep them */ });
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => { /* audit rows keep it */ });
    await pool.end();
  });
}

describe('Withholding and feed helpers', () => {
  test('Pasal 17 bands, PPh 21 on half the gross (+20% without an id), PPh 26 at the treaty rate; rules; feed parsing', () => {
    assert.equal(wht.pasal17(60_000_000), 3_000_000);
    assert.equal(wht.pasal17(100_000_000), 3_000_000 + 6_000_000);
    assert.deepEqual(wht.pph21(10_000_000, true), { dpp: 5_000_000, tax: 250_000, ratePct: 2.5 });
    assert.equal(wht.pph21(10_000_000, false).tax, 300_000);
    assert.equal(wht.pph21(200_000_000, true).tax, 9_000_000);
    assert.deepEqual(wht.withholdingFor({ tax_kind: 'foreign', treaty_rate_pct: '10' }, 5_000_000), { kind: 'pph26', label: 'PPh 26', dpp: 5_000_000, tax: 500_000, ratePct: 10 });
    assert.equal(wht.withholdingFor({ tax_kind: 'foreign' }, 5_000_000).tax, 1_000_000, '20% without a treaty');
    assert.equal(wht.withholdingFor({ tax_kind: 'company', wht_pct: '2' }, 5_000_000).tax, 100_000);
    const rule = { direction: 'debit', contains: 'biaya adm', amountMin: null, amountMax: 50_000 };
    assert.equal(feeds.fits(rule, { amount: -15_000, description: 'BIAYA ADM BULANAN', reference: null }), true);
    assert.equal(feeds.fits(rule, { amount: 15_000, description: 'BIAYA ADM BULANAN', reference: null }), false, 'money in');
    assert.equal(feeds.fits(rule, { amount: -75_000, description: 'BIAYA ADM BULANAN', reference: null }), false, 'too large');
    const p = feeds.parseFeed(JSON.stringify([{ date: '2026-10-02', description: 'TRF IN', amount: '1,500,000', type: 'CR' }, { date: '2026-10-01', description: 'ADM', amount: 15000, type: 'DB' }, { date: 'x', description: 'bad', amount: 1 }]));
    assert.deepEqual(p.lines.map((l) => [l.date, l.amount]), [['2026-10-01', -15_000], ['2026-10-02', 1_500_000]]);
    assert.equal(p.skipped, 1);
    assert.throws(() => feeds.parseFeed('<html>'), /JSON/);
  });
});

dbDescribe('Bank feeds and match rules', () => {
  test('fetched with the token, stored once, matched by the rules', async () => {
    const m = monthsBack(1);
    const bank = (await call('POST', '/v1/finance/cash/accounts', { name: 'BCA Operating', kind: 'bank', currency: 'IDR', openingBalance: 10_000_000, openingOn: `${m}-01` })).json();
    assert.equal((await call('POST', '/v1/finance/bank-feeds', { name: 'BCA', cashAccountId: bank.id, url: 'not a url' })).statusCode, 422);
    const f = await call('POST', '/v1/finance/bank-feeds', { name: 'BCA', cashAccountId: bank.id, url: bankUrl, token: 'secret-token-1', since: `${m}-01` });
    assert.equal(f.statusCode, 201, f.body);
    const feed = f.json();
    assert.equal(feed.hasToken, true);
    assert.ok(!f.body.includes('secret-token-1'), 'the token is not returned');
    const stored = await one<{ token_sealed: string }>(`SELECT token_sealed FROM bank_feed WHERE id = $1`, [feed.id]);
    assert.ok(!stored!.token_sealed.includes('secret-token-1'), 'sealed');

    assert.equal((await call('POST', '/v1/finance/bank-rules', { name: 'Fees', action: 'ignore', direction: 'debit', contains: 'biaya adm' })).statusCode, 422, 'an ignore rule needs a note');
    assert.equal((await call('POST', '/v1/finance/bank-rules', { name: 'Interest', action: 'suggest', accountCode: '9999', contains: 'bunga' })).statusCode, 422, 'no such account');
    assert.equal((await call('POST', '/v1/finance/bank-rules', { name: 'Fees', action: 'ignore', direction: 'debit', contains: 'biaya adm', note: 'Bank fee', amountMax: 50_000 })).statusCode, 201);
    assert.equal((await call('POST', '/v1/finance/bank-rules', { name: 'Interest', action: 'suggest', direction: 'credit', accountCode: '7300', contains: 'bunga', priority: 10 })).statusCode, 201);

    txs = [
      { date: `${m}-28`, description: 'BIAYA ADM', amount: 15_000, type: 'DB', balance: 10_000_000 - 15_000 },
      { date: `${m}-30`, description: 'BUNGA JASA GIRO', amount: 42_500, type: 'CR' },
      { date: `${m}-30`, description: 'TRF DARI PT LAIN', amount: 750_000, reference: 'INV-77' },
    ];
    const r1 = await call('POST', `/v1/finance/bank-feeds/${feed.id}/run`);
    assert.equal(r1.statusCode, 200, r1.body);
    assert.deepEqual({ a: r1.json().added, i: r1.json().ignored, s: r1.json().suggested }, { a: 3, i: 1, s: 1 });
    assert.equal(seen.at(-1)!.auth, 'Bearer secret-token-1');
    assert.equal(seen.at(-1)!.from, `${m}-01`, 'from the start date');
    const r2 = (await call('POST', `/v1/finance/bank-feeds/${feed.id}/run`)).json();
    assert.deepEqual({ a: r2.added, d: r2.duplicates }, { a: 0, d: 3 }, 'nothing new');
    assert.equal((seen.at(-1)!.from ?? '') < `${m}-30`, true, 'from a few days before the last line');

    const lines = await many<any>(`SELECT description, matched_kind, matched_ref, note FROM bank_statement_line WHERE org_id = $1 ORDER BY id`, [org]);
    assert.deepEqual(lines.map((l) => l.matched_kind), ['ignored', 'gl_entry', null]);
    const je = (await call('GET', `/v1/finance/ledger/entries/${lines[1].matched_ref}`)).json();
    assert.equal(je.status, 'awaiting_approval');
    assert.deepEqual(je.lines.map((l: any) => [l.account, l.debit, l.credit]), [['1100', 42_500, 0], ['7300', 0, 42_500]]);
    const list = (await call('GET', '/v1/finance/bank-feeds')).json();
    assert.equal(list.feeds[0].lastStatus, 'ok');
    assert.equal(list.feeds[0].linesImported, 3);
    assert.equal(list.rules.find((x: any) => x.name === 'Fees').matchedCount, 1);
    assert.equal((await call('GET', '/v1/finance/bank-rules/preview')).json().lines.length, 0, 'the open line fits no rule');
  });
});

dbDescribe('Withholding slips', () => {
  test('PPh 21, 23 and 26 on bills; slips drafted, issued, refreshed and voided; e-Bupot; calendar and ledger', async () => {
    const m = monthsBack(1);
    assert.equal((await call('POST', '/v1/finance/suppliers', { name: `Bad ${TAG}`, taxKind: 'individual', idNumber: '123' })).statusCode, 422, 'NIK is 16 digits');
    const ind = (await call('POST', '/v1/finance/suppliers', { name: `Agus Teknisi ${TAG}`, taxKind: 'individual', idNumber: '3174012345678901' })).json();
    const abroad = (await call('POST', '/v1/finance/suppliers', { name: `SG Software ${TAG}`, taxKind: 'foreign', country: 'SG', treatyRatePct: 10 })).json();
    const co = (await call('POST', '/v1/finance/suppliers', { name: `PT Rapi ${TAG}`, whtPct: 2 })).json();
    assert.equal(ind.taxKind, 'individual');
    const mk = async (supplierId: string, number: string, subtotal: number) => {
      const r = await call('POST', '/v1/finance/bills', { supplierId, number, category: 'maintenance', description: 'Work', subtotal, billDate: `${m}-12`, currency: 'IDR' });
      assert.equal(r.statusCode, 201, r.body);
      await as(B, () => call('POST', `/v1/finance/bills/${r.json().id}/approve`));
      return r.json();
    };
    const b1 = await mk(ind.id, 'AG-1', 10_000_000);
    const b2 = await mk(abroad.id, 'SG-1', 5_000_000);
    const b3 = await mk(co.id, 'R-1', 4_000_000);
    assert.deepEqual([b1.whtKind, b1.wht, b2.whtKind, b2.wht, b3.whtKind, b3.wht], ['pph21', 250_000, 'pph26', 500_000, 'pph23', 80_000]);

    const d1 = (await call('POST', `/v1/finance/tax/slips/${m}/draft`)).json();
    assert.equal(d1.created, 3);
    assert.equal(d1.billsNotOnSlip, 0);
    const s21 = d1.slips.find((x: any) => x.kind === 'pph21');
    assert.deepEqual([s21.gross, s21.dpp, s21.tax, s21.ratePct], [10_000_000, 5_000_000, 250_000, 5]);
    const iss = (await call('POST', `/v1/finance/tax/slips/${s21.id}/issue`, { issuedOn: `${m}-28` })).json();
    assert.match(iss.number, /^BP-PPH21-\d{6}-0001$/);
    assert.equal((await call('POST', `/v1/finance/tax/slips/${s21.id}/issue`)).statusCode, 409);
    await mk(ind.id, 'AG-2', 2_000_000);
    const d2 = (await call('POST', `/v1/finance/tax/slips/${m}/draft`)).json();
    assert.deepEqual({ c: d2.created, i: d2.issuedChanged, open: d2.billsNotOnSlip }, { c: 0, i: 1, open: 1 }, 'an issued slip is not changed');
    assert.equal((await call('POST', `/v1/finance/tax/slips/${s21.id}/void`, { reason: 'x' })).statusCode, 422);
    assert.equal((await call('POST', `/v1/finance/tax/slips/${s21.id}/void`, { reason: 'Reissue with AG-2' })).json().status, 'void');
    const d3 = (await call('POST', `/v1/finance/tax/slips/${m}/draft`)).json();
    const again = d3.slips.find((x: any) => x.kind === 'pph21' && x.status === 'draft');
    assert.deepEqual([again.gross, again.tax], [12_000_000, 250_000 + 50_000]);
    assert.equal(d3.totals.pph26.tax, 500_000);
    assert.equal((await call('GET', `/v1/finance/tax/slips/${m}/ebupot`)).rawPayload.subarray(0, 2).toString(), 'PK');

    const cal = (await call('GET', '/v1/finance/tax/calendar')).json();
    const p21 = cal.items.find((x: any) => x.obligation === 'pph21_pay' && x.period === m);
    assert.equal(p21.amount, 300_000 + 500_000, 'PPh 21 and 26 slips');

    await call('POST', `/v1/finance/ledger/sync/${m}`);
    const r = (await call('GET', `/v1/finance/ledger?month=${m}&currency=IDR`)).json();
    const liab = (code: string) => r.balanceSheet.liabilities.find((x: any) => x.code === code)?.amount ?? 0;
    assert.deepEqual([liab('2150'), liab('2151'), liab('2152')], [80_000, 300_000, 500_000]);
  });
});

dbDescribe('Management report pack', () => {
  test('drafted with figures, summary needed, approved by a second Finance Manager, files, sent back', async () => {
    const m = monthsBack(1);
    assert.equal((await call('POST', '/v1/finance/report-packs', { month: localDay().slice(0, 7) })).statusCode, 422, 'an ended month');
    const p = await call('POST', '/v1/finance/report-packs', { month: m, currency: 'IDR' });
    assert.equal(p.statusCode, 201, p.body);
    const pack = p.json();
    assert.equal(pack.status, 'draft');
    assert.equal(typeof pack.data.results.month.result, 'number');
    assert.ok(pack.data.scorecard.kpis.length >= 8);
    assert.ok(pack.data.payables.total > 0, 'the withholding bills are owed');
    assert.equal((await call('POST', `/v1/finance/report-packs/${pack.id}/submit`)).statusCode, 422, 'the summary is needed');
    assert.equal((await call('PUT', `/v1/finance/report-packs/${pack.id}/commentary`, { commentary: { nonsense: 'x' } })).statusCode, 422);
    await call('PUT', `/v1/finance/report-packs/${pack.id}/commentary`, { commentary: { summary: 'A quiet month; maintenance ahead of plan.', cash: 'Comfortable.' } });
    assert.equal((await call('POST', `/v1/finance/report-packs/${pack.id}/submit`)).json().status, 'in_review');
    assert.equal((await call('POST', '/v1/finance/report-packs', { month: m })).statusCode, 409, 'not refreshed in review');
    assert.equal((await call('POST', `/v1/finance/report-packs/${pack.id}/approve`)).statusCode, 403, 'not the submitter');
    assert.equal((await as(B, () => call('POST', `/v1/finance/report-packs/${pack.id}/approve`), false)).statusCode, 403, 'a Finance Manager');
    const ok = (await as(B, () => call('POST', `/v1/finance/report-packs/${pack.id}/approve`))).json();
    assert.equal(ok.status, 'approved');
    assert.equal(ok.approvedBy, 'Budi');
    assert.equal((await call('PUT', `/v1/finance/report-packs/${pack.id}/commentary`, { commentary: { summary: 'late' } })).statusCode, 409, 'final once approved');
    assert.equal((await call('GET', `/v1/finance/report-packs/${pack.id}?format=pdf`)).rawPayload.subarray(0, 4).toString(), '%PDF');
    assert.equal((await call('GET', `/v1/finance/report-packs/${pack.id}?format=xlsx`)).rawPayload.subarray(0, 2).toString(), 'PK');
    assert.match((await call('POST', `/v1/finance/report-packs/${pack.id}/send`)).body, /No recipients/);
    assert.equal((await call('PUT', '/v1/finance/report-packs/settings', { recipients: ['board@p21.test', 'nope'] })).statusCode, 422);
    assert.deepEqual((await call('PUT', '/v1/finance/report-packs/settings', { recipients: 'board@p21.test, owner@p21.test' })).json().recipients, ['board@p21.test', 'owner@p21.test']);
    assert.match((await call('POST', `/v1/finance/report-packs/${pack.id}/send`)).body, /e-mail channel/);
    assert.equal((await as(B, () => call('POST', `/v1/finance/report-packs/${pack.id}/send-back`, { reason: 'Add the site notes' }), false)).statusCode, 403, 'an approved pack takes a Finance Manager');
    const back = (await call('POST', `/v1/finance/report-packs/${pack.id}/send-back`, { reason: 'Add the site notes' })).json();
    assert.equal(back.status, 'draft');
    assert.equal(back.commentary.review, 'Add the site notes');
    const list = (await call('GET', '/v1/finance/report-packs')).json();
    assert.equal(list.packs[0].month, m);
    assert.equal(list.packs[0].data, undefined, 'the list has no figures');
  });
});

dbDescribe('Month close v2', () => {
  test('steps checked, accepted only by a Finance Manager, the policy holding the lock, the evidence pack', async () => {
    const m = monthsBack(3);
    const s0r = await call('GET', `/v1/finance/close?month=${m}`);
    assert.equal(s0r.statusCode, 200, s0r.body);
    const s0 = s0r.json();
    assert.equal(s0.total, 9);
    assert.equal(s0.canLock, true, 'no policy yet');
    const failing = s0.steps.filter((x: any) => !x.ok).map((x: any) => x.step);
    const passing = s0.steps.filter((x: any) => x.ok).map((x: any) => x.step);
    assert.ok(passing.includes('journals_approved'));
    // A failing step: a draft journal entry in the month.
    await call('POST', '/v1/finance/ledger/entries', { date: `${m}-05`, currency: 'IDR', memo: 'Accrual', draft: true, lines: [{ account: '6200', debit: 100 }, { account: '2100', credit: 100 }] });
    const s1 = (await call('GET', `/v1/finance/close?month=${m}`)).json();
    assert.equal(s1.steps.find((x: any) => x.step === 'journals_approved').ok, false);
    assert.equal((await as(B, () => call('POST', `/v1/finance/close/${m}/steps/journals_approved/sign-off`, {}), false)).statusCode, 403, 'accepting takes a Finance Manager');
    assert.equal((await call('POST', `/v1/finance/close/${m}/steps/journals_approved/sign-off`, { note: 'no' })).statusCode, 422, 'a note');
    const s2 = (await call('POST', `/v1/finance/close/${m}/steps/journals_approved/sign-off`, { note: 'Accrual reversed next month' })).json();
    const st = s2.steps.find((x: any) => x.step === 'journals_approved');
    assert.deepEqual([st.complete, st.signoff.accepted, st.signoff.by], [true, true, 'Rina']);
    assert.equal((await call('POST', `/v1/finance/close/${m}/steps/journals_approved/sign-off`, { note: 'again please' })).statusCode, 409);

    assert.equal((await as(B, () => call('PUT', '/v1/finance/close/policy', { enforce: true }), false)).statusCode, 403);
    assert.equal((await call('PUT', '/v1/finance/close/policy', { enforce: true })).json().enforce, true);
    const refused = await call('POST', `/v1/finance/periods/${m}/lock`, {});
    assert.equal(refused.statusCode, 409);
    assert.match(refused.body, /not signed off/);
    for (const step of passing.filter((x: string) => x !== 'journals_approved')) {
      const r = await as(B, () => call('POST', `/v1/finance/close/${m}/steps/${step}/sign-off`, {}), false);
      assert.equal(r.statusCode, 200, `${step}: ${r.body}`);
    }
    for (const step of failing) await call('POST', `/v1/finance/close/${m}/steps/${step}/sign-off`, { note: 'Accepted for the test' });
    const ready = (await call('GET', `/v1/finance/close?month=${m}`)).json();
    assert.deepEqual([ready.ready, ready.canLock], [true, true]);
    assert.equal((await call('POST', `/v1/finance/close/${m}/steps/fx_rates/revoke`)).statusCode, 200);
    assert.equal((await call('GET', `/v1/finance/close?month=${m}`)).json().ready, false);
    await call('POST', `/v1/finance/close/${m}/steps/fx_rates/sign-off`, { note: 'Accepted for the test' });
    const locked = await call('POST', `/v1/finance/periods/${m}/lock`, { note: 'Closed' });
    assert.equal(locked.statusCode, 200, locked.body);
    assert.equal((await call('POST', `/v1/finance/close/${m}/steps/fx_rates/revoke`)).statusCode, 409, 'locked');
    const ev = await call('GET', `/v1/finance/close/${m}/evidence`);
    assert.equal(ev.rawPayload.subarray(0, 2).toString(), 'PK');
    assert.equal((await call('GET', '/v1/finance/close?month=nope')).statusCode, 422);
  });
});
