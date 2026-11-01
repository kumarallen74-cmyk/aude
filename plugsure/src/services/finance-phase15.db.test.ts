import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 15 of the finance review (v1.26.0):
 *   - automatic owner payouts: the preview's reasons (waiting, a query open, no bank details, held), a payout
 *     requested by the worker for a ready statement (marked automatic, waiting for approval), never twice;
 *   - subscription revenue: billed, recognised pro rata over the period, deferred at the start and end, MRR, the
 *     journal balanced;
 *   - PPN: output from charge records and paid subscriptions, input from recorded faktur masukan, the checks, filing
 *     with the NTPN, the overpayment carried forward into the next period, amending;
 *   - finance today: the approvals waiting, with who may decide.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase15.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const auto = await import('./owner-payout-automation.js');
const store = await import('../integrations/store.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID(), B = randomUUID();
const SECRET = 'disb-secret-p15';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let org = '', site = '', cp = '', conn = '', ownerA = '', ownerB = '', duitkuId = '', plan = '', sub = '';
let app: FastifyInstance;
let actor = A;
const zone = config.billing.timeZone;
const localDay = (t: number = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(t));
const monthsBack = (n: number) => {
  let [y, m] = localDay().slice(0, 7).split('-').map(Number) as [number, number];
  for (let i = 0; i < n; i++) { m--; if (m === 0) { m = 12; y--; } }
  return `${y}-${String(m).padStart(2, '0')}`;
};
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });

let base = '';
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0]!;
    const b = raw ? JSON.parse(raw) : {};
    res.setHeader('content-type', 'application/json');
    if (path === '/webapi/api/disbursement/inquirysandbox') {
      if (b.signature !== sha(`${b.email}${b.timestamp}${b.bankCode}${b.bankAccount}${b.amountTransfer}${b.purpose}${SECRET}`)) return res.end(JSON.stringify({ responseCode: 'EE' }));
      return res.end(JSON.stringify({ responseCode: '00', accountName: 'PT HOTEL NUSANTARA', disburseId: 880001, custRefNumber: 'r1' }));
    }
    res.statusCode = 404; res.end('{}');
  });
});

let periodN = 0;
const ownerStatement = (owner: string, share: number, daysAgo: number) => one<{ id: string }>(
  `INSERT INTO commission_statement (org_id, owner_id, period, number, gtv_minor, commission_minor, minimum_topup_minor, private_fee_minor, mdr_credit_minor,
                                     net_minor, tax_minor, total_minor, owner_share_minor, data, finalised_at, currency)
   VALUES ($1, $2, make_date(2025, 1, 1) + make_interval(months => $6), $3, 10000000, 1000000, 0, 0, 0, 1000000, 110000, 1110000, $4, '{}'::jsonb, now() - make_interval(days => $5), 'IDR') RETURNING id`,
  [org, owner, `OS-${TAG}-${randomBytes(2).toString('hex')}`, share, daysAgo, periodN++]).then((r) => r!.id);

if (DB_OK) {
  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    (config.console as { publicBaseUrl: string }).publicBaseUrl = 'https://ocpp.plugsure.test';
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug, npwp, pkp) VALUES ($1, $2, '0123456789012345', true) RETURNING id`, [`P15 ${TAG}`, `p15-${TAG}`]))!.id;
    await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, 'Rina'), ($4, $2, $5, 'Andi')`, [A, org, `${A.slice(0, 8)}@p15.test`, B, `${B.slice(0, 8)}@p15.test`]);
    const disb = { disbursementUserId: '3551', disbursementEmail: 'p15@plugsure.test', disbursementMaxPayout: 5_000_000, disbursementMaxPayoutPerDay: 9_000_000 };
    duitkuId = ((await store.save('payments_fallback', org, { provider: 'duitku', settings: { environment: 'sandbox', merchantCode: 'DP15', methods: ['QRIS'], qrisMethod: 'SP', baseUrl: base, ...disb }, secrets: { apiKey: 'k', disbursementSecretKey: SECRET } }, null)) as any).id;
    ownerA = (await one<{ id: string }>(`INSERT INTO site_owner (org_id, name, legal_name) VALUES ($1, $2, 'PT Hotel Nusantara') RETURNING id`, [org, `Hotel ${TAG}`]))!.id;
    ownerB = (await one<{ id: string }>(`INSERT INTO site_owner (org_id, name) VALUES ($1, $2) RETURNING id`, [org, `Mall ${TAG}`]))!.id;
    site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'ID') RETURNING id`, [org, `Surabaya ${TAG}`]))!.id;
    cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name) VALUES ($1, $2, $2) RETURNING id`, [site, `P15-${TAG}`]))!.id;
    const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [cp]))!.id;
    conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, max_power_w) VALUES ($1, 60000) RETURNING id`, [e]))!.id;
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: actor, orgId: org, assignments: [{ permissions: ['payment:read', 'payment:write'], scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
    await call('PUT', `/v1/finance/owners/${ownerA}/bank-account`, { bankName: 'BCA', bankCode: '014', holderName: 'PT Hotel Nusantara', accountNumber: '5550001111' });
  });
  after(async () => {
    server.close();
    await app?.close();
    for (const t of ['payout_transfer', 'statement_payment', 'owner_statement_dispute', 'owner_payout_rule', 'ppn_input_invoice', 'ppn_period', 'finance_org_settings']) await query(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
    await query(`DELETE FROM commission_statement WHERE org_id = $1`, [org]);
    await query(`DELETE FROM owner_bank_account WHERE org_id = $1`, [org]);
    await query(`DELETE FROM site_owner WHERE org_id = $1`, [org]);
    await query(`DELETE FROM subscription_charge WHERE org_id = $1`, [org]);
    await query(`DELETE FROM subscription WHERE org_id = $1`, [org]);
    await query(`DELETE FROM subscription_plan WHERE org_id = $1`, [org]);
    await query(`DELETE FROM cdr WHERE org_id = $1`, [org]);
    await query(`DELETE FROM charging_session WHERE org_id = $1`, [org]);
    await query(`DELETE FROM token WHERE org_id = $1`, [org]);
    await query(`DELETE FROM connector WHERE id = $1`, [conn]);
    await query(`DELETE FROM evse WHERE charge_point_id = $1`, [cp]);
    await query(`DELETE FROM charge_point WHERE id = $1`, [cp]);
    await query(`DELETE FROM site WHERE org_id = $1`, [org]);
    await query(`DELETE FROM integration WHERE id = $1`, [duitkuId]);
    await query(`DELETE FROM alert WHERE org_id = $1`, [org]);
    await query(`DELETE FROM app_user WHERE org_id = $1`, [org]).catch(() => { /* audit rows keep them */ });
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => { /* audit rows keep it */ });
    await pool.end();
  });
}

dbDescribe('Automatic owner payouts', () => {
  test('the preview\'s reasons; a ready statement requested once, waiting for approval; a hold', async () => {
    actor = A;
    const ready = await ownerStatement(ownerA, 1_200_000, 10);
    const fresh = await ownerStatement(ownerA, 800_000, 0);
    const queried = await ownerStatement(ownerA, 600_000, 10);
    await query(`INSERT INTO owner_statement_dispute (org_id, owner_id, statement_id, message, state) VALUES ($1, $2, $3, 'The kWh look low.', 'open')`, [org, ownerA, queried]);
    const noBank = await ownerStatement(ownerB, 500_000, 10);

    assert.equal((await call('PUT', '/v1/finance/owner-payouts/automation', { enabled: true, delayDays: 99 })).statusCode, 422);
    assert.equal((await call('PUT', '/v1/finance/owner-payouts/automation', { enabled: true, delayDays: 3, minAmount: 100_000 })).statusCode, 200);
    const p = (await call('GET', '/v1/finance/owner-payouts/automation')).json();
    const why = (id: string) => p.candidates.find((c: any) => c.statementId === id);
    assert.equal(why(ready).ready, true);
    assert.match(why(fresh).reason, /Waiting 3 more day/);
    assert.match(why(queried).reason, /query open/);
    assert.match(why(noBank).reason, /bank details/);

    const r = (await call('POST', '/v1/finance/owner-payouts/automation/run')).json();
    assert.deepEqual(r.requested.map((x: any) => x.statementId), [ready], JSON.stringify(r.failed));
    const t = await one<any>(`SELECT state, automatic, requested_by, amount_minor FROM payout_transfer WHERE statement_id = $1`, [ready]);
    assert.deepEqual({ s: t.state, a: t.automatic, by: t.requested_by, amt: Number(t.amount_minor) }, { s: 'awaiting_approval', a: true, by: null, amt: 1_200_000 }, 'never sent by itself');
    assert.equal(await auto.sweep(), 0, 'not twice');
    assert.match((await auto.preview(org)).candidates.find((c) => c.statementId === ready)!.reason!, /already open/);

    // Finance today: the automatic payout waits for a decision, which anyone (no requester) may take.
    const today = (await call('GET', '/v1/finance/today')).json();
    const a = today.approvals.find((x: any) => x.kind === 'payout_transfer');
    assert.deepEqual({ by: a.requestedBy, can: a.canDecide, auto: a.automatic, amt: a.amount }, { by: 'automatic', can: true, auto: true, amt: 1_200_000 });
    assert.match(a.approve, /\/v1\/finance\/payout-transfers\/\d+\/approve$/);
    assert.ok(Array.isArray(today.month));

    assert.equal((await call('PUT', `/v1/finance/owner-payouts/automation/owners/${ownerA}`, { hold: true })).statusCode, 422, 'a reason');
    assert.equal((await call('PUT', `/v1/finance/owner-payouts/automation/owners/${ownerA}`, { hold: true, holdReason: 'Lease renegotiation' })).statusCode, 200);
    assert.match((await auto.preview(org)).candidates.find((c) => c.statementId === fresh)!.reason!, /Held: Lease renegotiation/);
  });
});

dbDescribe('Subscription revenue', () => {
  test('billed, recognised pro rata, deferred; MRR; the journal balanced', async () => {
    const lm = monthsBack(1), tm = localDay().slice(0, 7);
    plan = (await one<{ id: string }>(`INSERT INTO subscription_plan (org_id, name, monthly_fee_minor, active, currency) VALUES ($1, 'Pass Jakarta', 300000, true, 'IDR') RETURNING id`, [org]))!.id;
    const tok = (await one<{ id: string }>(`INSERT INTO token (org_id, kind, uid) VALUES ($1, 'rfid', $2) RETURNING id`, [org, `P15SUB${TAG}`]))!.id;
    const ps = new Date(`${lm}-15T00:00:00+07:00`), pe = new Date(ps.getTime() + 30 * 86_400_000);
    sub = (await one<{ id: string }>(
      `INSERT INTO subscription (org_id, plan_id, subscriber_kind, token_id, billing, status, started_at, current_period_start, current_period_end)
       VALUES ($1, $2, 'card', $3, 'qris', 'active', $4, $4, $5) RETURNING id`, [org, plan, tok, ps, pe]))!.id;
    await query(
      `INSERT INTO subscription_charge (subscription_id, org_id, period_start, period_end, fee_minor, tax_base_minor, tax_minor, total_minor, via, state, paid_at, currency)
       VALUES ($1, $2, $3, $4, 300000, 300000, 33000, 333000, 'qris', 'paid', $3, 'IDR')`, [sub, org, ps, pe]);
    const monthEnd = new Date(`${tm}-01T00:00:00+07:00`).getTime();
    const recLm = Math.round(300_000 * (monthEnd - ps.getTime()) / (30 * 86_400_000));

    const r = (await call('GET', `/v1/finance/subscription-revenue?month=${lm}`)).json();
    const c = r.currencies.find((x: any) => x.currency === 'IDR');
    assert.deepEqual({ b: c.billed, r: c.recognised, ds: c.deferredStart, de: c.deferredEnd }, { b: 300_000, r: recLm, ds: 0, de: 300_000 - recLm });
    assert.equal(c.mrr, 300_000);
    assert.equal(c.subscribers.new, 1);
    const dr = r.journal.reduce((a: number, j: any) => a + j.debit, 0), cr = r.journal.reduce((a: number, j: any) => a + j.credit, 0);
    assert.equal(dr, cr, 'balanced');
    assert.equal(r.journal.find((j: any) => j.credit === recLm).code, '4-1200');

    const r2 = (await call('GET', `/v1/finance/subscription-revenue?month=${tm}`)).json().currencies.find((x: any) => x.currency === 'IDR');
    assert.deepEqual({ b: r2.billed, r: r2.recognised, ds: r2.deferredStart, de: r2.deferredEnd }, { b: 0, r: 300_000 - recLm, ds: 300_000 - recLm, de: 0 });
    const x = await call('GET', `/v1/finance/subscription-revenue?month=${lm}&format=xlsx`);
    assert.equal(x.rawPayload.subarray(0, 2).toString(), 'PK');
    assert.equal((await call('PUT', '/v1/finance/subscription-revenue/accounts', { revenue: { code: 'bad code!', name: 'x' } })).statusCode, 422);
  });
});

dbDescribe('PPN return', () => {
  test('output and input; the checks; filed with the NTPN; the overpayment carried forward; amending', async () => {
    const m2 = monthsBack(2), lm = monthsBack(1);
    // A charge record last month: DPP 100 000, PPN 11 000. (The subscription above: DPP 300 000, PPN 33 000.)
    const s = (await one<{ id: string }>(
      `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, ended_at, energy_wh, state)
       VALUES ($1, $2, $3, $4, $5, $6, $6, 20000, 'rated') RETURNING id`, [org, site, conn, cp, `p15-${randomUUID()}`, new Date(`${lm}-10T05:00:00+07:00`)]))!.id;
    await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency)
                 VALUES ($1, $2, $3, '[]', 100000, 0, 0, 100000, 1100, 11000, 111000, '{}', 'IDR')`, [s, org, new Date(`${lm}-10T05:00:00+07:00`)]);

    // Two months ago: only input, so an overpayment to carry.
    const bad = await call('POST', '/v1/finance/ppn/input-invoices', { month: m2, supplier: 'PLN', faktur: `010.000-${TAG}.1`, date: `${lm}-02`, dpp: 1_000_000, ppn: 110_000 });
    assert.equal(bad.statusCode, 422, 'dated after the period');
    assert.equal((await call('POST', '/v1/finance/ppn/input-invoices', { month: m2, supplier: 'PLN', faktur: `010.000-${TAG}.1`, date: `${m2}-02`, dpp: 100_000, ppn: 50_000 })).statusCode, 422, 'over 12%');
    assert.equal((await call('POST', '/v1/finance/ppn/input-invoices', { month: m2, supplier: 'PLN', supplierNpwp: '01.234.567.8-901.000', faktur: `010.000-${TAG}.1`, date: `${m2}-02`, dpp: 1_000_000, ppn: 100_000 })).statusCode, 201);
    assert.equal((await call('POST', '/v1/finance/ppn/input-invoices', { month: m2, supplier: 'PLN', faktur: `010.000-${TAG}.1`, date: `${m2}-02`, dpp: 1, ppn: 0 })).statusCode, 409, 'recorded once');
    const f2 = await call('POST', `/v1/finance/ppn/${m2}/file`, {});
    assert.equal(f2.statusCode, 200, f2.body);
    assert.deepEqual({ p: f2.json().payable, c: f2.json().carriedForward }, { p: 0, c: 100_000 });

    // Last month: output 44 000; input 5 500; 100 000 brought forward → 61 500 carried.
    assert.equal((await call('POST', '/v1/finance/ppn/input-invoices', { month: lm, supplier: 'Xendit', faktur: `010.000-${TAG}.2`, date: `${lm}-28`, dpp: 50_000, ppn: 5_500 })).statusCode, 201);
    const p = (await call('GET', `/v1/finance/ppn?month=${lm}`)).json();
    assert.equal(p.output.lines.find((l: any) => l.key === 'retail').ppn, 11_000);
    assert.equal(p.output.lines.find((l: any) => l.key === 'subscriptions').ppn, 33_000);
    assert.deepEqual({ o: p.output.ppn, i: p.input.ppn, bf: p.broughtForward, from: p.broughtFrom, pay: p.payable, cf: p.carriedForward },
      { o: 44_000, i: 5_500, bf: 100_000, from: m2, pay: 0, cf: 61_500 });
    assert.equal((await call('POST', `/v1/finance/ppn/${localDay().slice(0, 7)}/file`, {})).statusCode, 409, 'not ended');

    // Without the brought-forward it would be payable: amend two months ago to show the NTPN rule.
    const vid = (await one<{ id: string }>(`SELECT id FROM ppn_input_invoice WHERE org_id = $1 AND month = $2`, [org, m2]))!.id;
    assert.equal((await call('POST', `/v1/finance/ppn/input-invoices/${vid}/void`, { reason: 'Wrong period' })).statusCode, 200);
    assert.equal((await call('POST', `/v1/finance/ppn/${m2}/file`, { amend: true })).statusCode, 200, 'nothing payable two months ago either way');
    const p2 = (await call('GET', `/v1/finance/ppn?month=${lm}`)).json();
    assert.deepEqual({ pay: p2.payable, cf: p2.carriedForward }, { pay: 38_500, cf: 0 });
    assert.equal((await call('POST', `/v1/finance/ppn/${lm}/file`, {})).statusCode, 422, 'payable: the NTPN');
    assert.equal((await call('POST', `/v1/finance/ppn/${lm}/file`, { ntpn: 'short' })).statusCode, 422);
    const f = await call('POST', `/v1/finance/ppn/${lm}/file`, { ntpn: 'ABCD1234EFGH5678' });
    assert.equal(f.statusCode, 200, f.body);
    assert.equal((await call('POST', `/v1/finance/ppn/${lm}/file`, { ntpn: 'ABCD1234EFGH5678' })).statusCode, 409, 'filed: amend');
    assert.equal((await call('POST', `/v1/finance/ppn/${m2}/file`, { amend: true })).statusCode, 409, 'a later period is filed');
    assert.equal((await call('POST', '/v1/finance/ppn/input-invoices', { month: lm, supplier: 'PLN', faktur: `010.000-${TAG}.3`, date: `${lm}-05`, dpp: 10_000, ppn: 1_100 })).statusCode, 409, 'filed: amend');
    const g = (await call('GET', `/v1/finance/ppn?month=${lm}`)).json();
    assert.equal(g.filed.ntpn, 'ABCD1234EFGH5678');
    assert.equal(g.filed.differs, false);
    assert.ok(g.periods.length >= 2);
    assert.match((await call('GET', `/v1/finance/ppn?month=${lm}&format=input-csv`)).body, /"Xendit"/);
    assert.match((await call('GET', `/v1/finance/ppn?month=${lm}&format=output-csv`)).body, /Digunggung/);
    assert.equal((await call('GET', `/v1/finance/ppn?month=${lm}&format=xlsx`)).rawPayload.subarray(0, 2).toString(), 'PK');
  });
});
