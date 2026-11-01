import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 18 of the finance review (v1.29.0):
 *   - fixed assets: straight-line and declining-balance schedules, the register as of a month, a month's journal
 *     recorded (and an asset in it no longer voidable), a disposal with its gain, site investments imported once;
 *   - supplier bills: PPh 23 from the supplier's rate, approval by a second person (and two approvers under the
 *     matrix), paid in parts, the ageing, the overdue alert, a bill capitalised as an asset, a candidate in bank
 *     reconciliation;
 *   - cash: an account's balance from its opening, a balance taken, a statement and the moves since; a transfer;
 *     below the minimum → alert; the 13-week view with a supplier bill;
 *   - benchmarking: quartiles, ranks and outliers; sites and owners compared.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase18.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const assets = await import('./fixed-assets.js');
const bills = await import('./supplier-bills.js');
const cash = await import('./cash-position.js');
const bench = await import('./finance-benchmark.js');
const recon = await import('./bank-recon.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID(), B = randomUUID(), C = randomUUID();
let org = '', borg = '';
let app: FastifyInstance;
let principalOrg = '';
let principalUser: string = A;
const sites: Array<{ site: string; cp: string; conn: string }> = [];
const zone = config.billing.timeZone;
const localDay = (t: number = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(t));
const daysAgo = (n: number) => localDay(Date.now() - n * 86_400_000);
const monthsBack = (n: number) => {
  let [y, m] = localDay().slice(0, 7).split('-').map(Number) as [number, number];
  for (let i = 0; i < n; i++) { m--; if (m === 0) { m = 12; y--; } }
  return `${y}-${String(m).padStart(2, '0')}`;
};
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });
const as = async <T>(user: string, fn: () => Promise<T>) => { const was = principalUser; principalUser = user; try { return await fn(); } finally { principalUser = was; } };

async function siteFor(o: string, name: string, ownerId: string | null = null) {
  const site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code, owner_id) VALUES ($1, $2, 'ID', $3) RETURNING id`, [o, `${name} ${TAG}`, ownerId]))!.id;
  const cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name) VALUES ($1, $2, $2) RETURNING id`, [site, `P18-${name}-${TAG}`]))!.id;
  const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [cp]))!.id;
  const conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, max_power_w) VALUES ($1, 60000) RETURNING id`, [e]))!.id;
  const s = { site, cp, conn };
  sites.push(s);
  return s;
}

async function session(o: string, s: { site: string; cp: string; conn: string }, end: Date, minor: number, hours = 1, paidAfterDays: number | null = null) {
  let pi: string | null = null;
  if (paidAfterDays != null) {
    pi = (await one<{ id: string }>(
      `INSERT INTO payment_intent (org_id, provider, method, mode, state, amount_captured_minor, amount_authorised_minor, currency, paid_at, created_at, channel)
       VALUES ($1, 'xendit', 'qris', 'postpaid', 'captured', $2, $2, 'IDR', $3::timestamptz + make_interval(days => $4), $3, 'QRIS') RETURNING id`, [o, minor, end, paidAfterDays]))!.id;
  }
  const id = (await one<{ id: string }>(
    `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, ended_at, duration_s, energy_wh, state, payment_intent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 20000, 'rated', $9) RETURNING id`,
    [o, s.site, s.conn, s.cp, `p18-${randomUUID()}`, new Date(end.getTime() - hours * 3_600_000), end, hours * 3600, pi]))!.id;
  if (pi) await query(`UPDATE payment_intent SET session_id = $2 WHERE id = $1`, [pi, id]);
  await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency)
               VALUES ($1, $2, $3, '[]', $4, 0, 0, $4, 0, 0, $4, '{}', 'IDR')`, [id, o, end, minor]);
  return id;
}

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Assets ${TAG}`, `p18-a-${TAG}`]))!.id;
    borg = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Bench ${TAG}`, `p18-b-${TAG}`]))!.id;
    for (const [u, n] of [[A, 'Rina'], [B, 'Budi'], [C, 'Citra']] as const) await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, $4)`, [u, org, `${u.slice(0, 8)}@p18.test`, n]);
    await siteFor(org, 'Bandung');
    principalOrg = org;
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: principalUser, orgId: principalOrg, assignments: [{ permissions: ['payment:read', 'payment:write', 'invoice:read', 'invoice:write', 'finance:approve'], scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
  });
  after(async () => {
    await app?.close();
    const orgs = [org, borg];
    await query(`DELETE FROM bank_statement_line WHERE org_id = ANY($1::uuid[])`, [orgs]);
    await query(`DELETE FROM bank_statement WHERE org_id = ANY($1::uuid[])`, [orgs]);
    for (const t of ['fixed_asset_run', 'fixed_asset', 'supplier_payment', 'supplier_bill', 'supplier', 'cash_transfer', 'cash_balance', 'cash_account', 'site_investment', 'finance_org_settings', 'site_energy_cost', 'site_energy_rate']) await query(`DELETE FROM ${t} WHERE org_id = ANY($1::uuid[])`, [orgs]);
    await query(`DELETE FROM cdr WHERE org_id = ANY($1::uuid[])`, [orgs]);
    await query(`UPDATE payment_intent SET session_id = NULL WHERE org_id = ANY($1::uuid[])`, [orgs]);
    await query(`DELETE FROM charging_session WHERE org_id = ANY($1::uuid[])`, [orgs]);
    await query(`DELETE FROM payment_intent WHERE org_id = ANY($1::uuid[])`, [orgs]);
    for (const s of sites) {
      await query(`DELETE FROM connector WHERE id = $1`, [s.conn]);
      await query(`DELETE FROM evse WHERE charge_point_id = $1`, [s.cp]);
      await query(`DELETE FROM charge_point WHERE id = $1`, [s.cp]);
    }
    await query(`DELETE FROM site WHERE org_id = ANY($1::uuid[])`, [orgs]);
    await query(`DELETE FROM site_owner WHERE org_id = ANY($1::uuid[])`, [orgs]);
    await query(`DELETE FROM alert WHERE org_id = ANY($1::uuid[])`, [orgs]);
    await query(`DELETE FROM app_user WHERE org_id = $1`, [org]).catch(() => { /* audit rows keep them */ });
    for (const o of orgs) await query(`DELETE FROM organisation WHERE id = $1`, [o]).catch(() => { /* audit rows keep it */ });
    await pool.end();
  });
}

describe('Depreciation and benchmark helpers', () => {
  test('straight line takes the rounding in the last month; declining balance ends at the residual; a disposal stops it', () => {
    const sl = assets.schedule({ cost: 1_000_001, residual: 0, inService: '2026-01', lifeMonths: 12, method: 'straight_line', ratePct: null, disposedOn: null });
    assert.equal(sl.length, 12);
    assert.equal(sl[0]!.depreciation, 83_333);
    assert.equal(sl[11]!.depreciation, 1_000_001 - 83_333 * 11);
    assert.equal(sl[11]!.netBookValue, 0);
    const db = assets.schedule({ cost: 1_200_000, residual: 200_000, inService: '2026-01', lifeMonths: 24, method: 'declining_balance', ratePct: 50, disposedOn: null });
    assert.equal(db[0]!.depreciation, 50_000, '1.2M × 50% ÷ 12');
    assert.ok(db[1]!.depreciation < db[0]!.depreciation, 'declining');
    assert.ok(db.every((r) => r.netBookValue >= 200_000));
    assert.equal(db[23]!.netBookValue, 200_000, 'the last month takes it to the residual');
    const sold = assets.schedule({ cost: 1_200_000, residual: 0, inService: '2026-01', lifeMonths: 12, method: 'straight_line', ratePct: null, disposedOn: '2026-04-10' });
    assert.deepEqual(sold.map((r) => r.month), ['2026-01', '2026-02', '2026-03']);
    assert.equal(assets.accumulatedTo({ cost: 1_200_000, residual: 0, inService: '2026-01', lifeMonths: 12, method: 'straight_line', ratePct: null, disposedOn: null }, '2026-03'), 300_000);
  });
  test('quartiles, ranks (100 is the best) and outliers', () => {
    assert.equal(bench.quantile([1, 2, 3, 4], 0.5), 2.5);
    assert.equal(bench.rankOf(4, [1, 2, 3, 4]), 100);
    assert.equal(bench.rankOf(1, [1, 2, 3, 4]), 0);
    assert.equal(bench.rankOf(1, [1, 2, 3, 4], true), 100, 'lower is better');
    const row = (id: string, revenue: number) => ({ id, name: id, currency: 'IDR', sites: 1, connectors: 1, sessions: 1, kwh: 10, revenue, energyCost: null, chargingHours: 1, collectionWeighted: 0, collectionBase: 0,
      metrics: { revenue, revenuePerKwh: null, utilisationPct: null, marginPct: null, revenuePerConnector: null, collectionDays: null } });
    const c = bench.compare([row('a', 100), row('b', 110), row('c', 120), row('d', 130), row('e', 1000)]);
    const e = c.rows.find((r) => r.id === 'e')!;
    assert.deepEqual(e.outliers.map((o) => [o.metric, o.direction, o.good]), [['revenue', 'high', true]]);
    assert.equal(c.rows[0]!.id, 'e', 'best score first');
    assert.equal(c.stats.IDR!.revenue!.median, 120);
  });
});

dbDescribe('Fixed assets', () => {
  test('recorded, in the register and journal, recorded month, disposed with a gain; investments imported once', async () => {
    const s = sites[0]!;
    const acquired = `${monthsBack(4)}-20`;
    const r = await call('POST', '/v1/finance/assets', { category: 'chargers', description: 'DC charger 60 kW', siteId: s.site, chargePointId: s.cp, cost: 1_200_000, acquiredOn: acquired, lifeMonths: 12 });
    assert.equal(r.statusCode, 201, r.body);
    const a = r.json();
    assert.match(a.tag, /^FA-\d{5}$/);
    assert.equal(a.inService, monthsBack(3));
    assert.equal(a.currency, 'IDR');
    assert.equal((await call('POST', '/v1/finance/assets', { category: 'chargers', description: 'x', cost: 1, acquiredOn: acquired })).statusCode, 422, 'no site: currency needed (and a description)');

    const reg = (await call('GET', '/v1/finance/assets')).json();
    const mine = reg.assets.find((x: any) => x.id === a.id);
    assert.deepEqual({ acc: mine.accumulated, nbv: mine.netBookValue, now: mine.depreciationThisMonth, st: mine.status }, { acc: 400_000, nbv: 800_000, now: 100_000, st: 'in_service' });
    assert.equal(reg.totals.IDR.cost, 1_200_000);

    const j = (await call('GET', `/v1/finance/assets/journal?month=${monthsBack(1)}`)).json().currencies.find((c: any) => c.currency === 'IDR');
    assert.equal(j.depreciation, 100_000);
    assert.equal(j.debit, j.credit);
    assert.equal(j.lines[0].code, '6400');
    assert.equal((await call('POST', `/v1/finance/assets/journal/${localDay().slice(0, 7)}/record`)).statusCode, 422, 'the month has not ended');
    assert.equal((await call('POST', `/v1/finance/assets/journal/${monthsBack(1)}/record`)).statusCode, 200);
    assert.equal((await call('POST', `/v1/finance/assets/${a.id}/void`, { reason: 'typo' })).statusCode, 409, 'in a recorded month');

    const d = await call('POST', `/v1/finance/assets/${a.id}/dispose`, { disposedOn: localDay(), proceeds: 1_000_000, note: 'Sold to the landlord' });
    assert.equal(d.statusCode, 200, d.body);
    assert.deepEqual({ nbv: d.json().disposal.netBookValue, gain: d.json().disposal.gainLoss }, { nbv: 900_000, gain: 100_000 });
    const jn = (await call('GET', `/v1/finance/assets/journal?month=${localDay().slice(0, 7)}`)).json().currencies.find((c: any) => c.currency === 'IDR');
    assert.equal(jn.depreciation, 0, 'none in the disposal month');
    assert.equal(jn.gainLoss, 100_000);
    assert.equal(jn.debit, jn.credit);
    assert.equal((await call('GET', `/v1/finance/assets/${a.id}`)).json().schedule.length, 3);

    await query(`INSERT INTO site_investment (org_id, site_id, category, description, amount_minor, currency, invested_on, life_months) VALUES ($1, $2, 'grid', 'PLN connection', 600000, 'IDR', $3, 60)`, [org, s.site, `${monthsBack(2)}-05`]);
    const imp = (await call('POST', '/v1/finance/assets/import-investments')).json();
    assert.equal(imp.imported, 1);
    assert.equal((await call('POST', '/v1/finance/assets/import-investments')).json().imported, 0, 'once');
    assert.equal((await call('GET', '/v1/finance/assets?format=xlsx')).rawPayload.subarray(0, 2).toString(), 'PK');
  });
});

dbDescribe('Supplier bills and payables', () => {
  test('PPh 23, a second approver, two approvers under the matrix, paid in parts, ageing, alert, capitalised, reconciled', async () => {
    const sup = (await call('POST', '/v1/finance/suppliers', { name: `Teknik Listrik ${TAG}`, taxId: '01.234.567.8-901.000', whtPct: 2, termsDays: 30, bank: { name: 'BCA', accountNumber: '1234567890', accountName: 'PT Teknik' } })).json();
    assert.equal((await call('POST', '/v1/finance/suppliers', { name: `teknik listrik ${TAG}` })).statusCode, 409, 'the same name');

    const b1 = (await call('POST', '/v1/finance/bills', { supplierId: sup.id, number: 'INV-001', category: 'maintenance', siteId: sites[0]!.site, description: 'Quarterly maintenance', subtotal: 1_000_000, vat: 110_000, billDate: daysAgo(40) })).json();
    assert.deepEqual({ wht: b1.wht, payable: b1.payable, due: b1.dueDate, st: b1.status }, { wht: 20_000, payable: 1_090_000, due: daysAgo(10), st: 'awaiting_approval' });
    assert.equal((await call('POST', '/v1/finance/bills', { supplierId: sup.id, number: 'inv-001', category: 'maintenance', description: 'again', subtotal: 1, billDate: daysAgo(1) })).statusCode, 409);
    assert.equal((await call('POST', `/v1/finance/bills/${b1.id}/approve`)).statusCode, 403, 'not the submitter');
    const ok = await as(B, () => call('POST', `/v1/finance/bills/${b1.id}/approve`));
    assert.equal(ok.json().status, 'approved', ok.body);

    // Two approvers above 500 000.
    await query(`INSERT INTO finance_org_settings (org_id, approval_rules) VALUES ($1, $2) ON CONFLICT (org_id) DO UPDATE SET approval_rules = EXCLUDED.approval_rules`, [org, JSON.stringify({ supplier_bill: { above: 500_000, rule: 'two_approvers' } })]);
    const b2 = (await call('POST', '/v1/finance/bills', { supplierId: sup.id, number: 'INV-002', category: 'equipment', siteId: sites[0]!.site, description: 'AC charger 22 kW', subtotal: 2_400_000, vat: 264_000, wht: 0, billDate: daysAgo(2), capitalise: true, lifeMonths: 48 })).json();
    const first = (await as(B, () => call('POST', `/v1/finance/bills/${b2.id}/approve`))).json();
    assert.equal(first.waitingForSecondApprover, true);
    assert.equal(first.status, 'awaiting_approval');
    assert.equal((await as(B, () => call('POST', `/v1/finance/bills/${b2.id}/approve`))).statusCode, 403, 'the first approver again');
    const second = (await as(C, () => call('POST', `/v1/finance/bills/${b2.id}/approve`))).json();
    assert.equal(second.status, 'approved');
    assert.ok(second.assetId, 'capitalised');
    const asset = (await call('GET', `/v1/finance/assets/${second.assetId}`)).json();
    assert.deepEqual({ cost: asset.cost, life: asset.lifeMonths, cat: asset.category }, { cost: 2_400_000, life: 48, cat: 'equipment' });
    assert.equal((await call('POST', `/v1/finance/bills/${b2.id}/void`, { reason: 'wrong' })).statusCode, 409, 'capitalised');

    // Ageing and the alert.
    const ap = (await call('GET', '/v1/finance/payables')).json().currencies.find((c: any) => c.currency === 'IDR');
    assert.equal(ap.total, 1_090_000 + 2_664_000);
    assert.equal(ap.buckets['1-30'], 1_090_000);
    assert.equal(ap.overdue, 1_090_000);
    assert.ok((await bills.sweep()) >= 1);
    assert.ok(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = $2 AND target_id = $3 AND resolved_at IS NULL`, [org, bills.OVERDUE_ALERT, b1.id]));

    // Paid in two parts.
    assert.equal((await call('POST', `/v1/finance/bills/${b1.id}/payments`, { amount: 2_000_000 })).statusCode, 422, 'more than the balance');
    const p1 = (await call('POST', `/v1/finance/bills/${b1.id}/payments`, { amount: 590_000, reference: 'TRF-77', paidOn: daysAgo(1) })).json();
    assert.deepEqual({ st: p1.status, bal: p1.balance }, { st: 'approved', bal: 500_000 });
    const p2 = (await call('POST', `/v1/finance/bills/${b1.id}/payments`, { reference: 'TRF-78' })).json();
    assert.equal(p2.status, 'paid');
    assert.equal(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = $2 AND target_id = $3 AND resolved_at IS NULL`, [org, bills.OVERDUE_ALERT, b1.id]), null, 'resolved');
    const cands = await recon.candidates(org, false, daysAgo(3), localDay());
    assert.ok(cands.some((c) => c.kind === 'supplier_payment' && c.amount === -590_000 && c.reference === 'TRF-77'));
    const back = (await call('POST', `/v1/finance/bills/${b1.id}/payments/${p2.payments[1].id}/void`, { reason: 'bounced' })).json();
    assert.deepEqual({ st: back.status, bal: back.balance }, { st: 'approved', bal: 500_000 });
    assert.equal((await call('GET', '/v1/finance/payables?format=xlsx')).rawPayload.subarray(0, 2).toString(), 'PK');
  });
});

dbDescribe('Cash position', () => {
  test('balances from the opening, a balance taken, a statement and moves; a transfer; the minimum; 13 weeks', async () => {
    const bank = (await call('POST', '/v1/finance/cash/accounts', { name: 'BCA operating', kind: 'bank', bankName: 'BCA', accountHint: '7788', currency: 'IDR', openingBalance: 5_000_000, openingOn: daysAgo(10), minimum: 3_000_000 })).json();
    const petty = (await call('POST', '/v1/finance/cash/accounts', { name: 'Petty cash', kind: 'cash', currency: 'IDR', openingBalance: 0, openingOn: daysAgo(10) })).json();
    const acct = (pos: any, id: string) => pos.accounts.find((a: any) => a.id === id);
    let pos = (await call('GET', '/v1/finance/cash')).json();
    assert.deepEqual({ b: acct(pos, bank.id).balance, src: acct(pos, bank.id).anchor.source }, { b: 5_000_000, src: 'opening' });

    await call('POST', `/v1/finance/cash/accounts/${bank.id}/balances`, { balance: 4_000_000, onDate: daysAgo(3) });
    const t = await call('POST', '/v1/finance/cash/transfers', { fromAccountId: bank.id, toAccountId: petty.id, amount: 2_000_000, onDate: daysAgo(1), reference: 'TOPUP' });
    assert.equal(t.statusCode, 201, t.body);
    pos = (await call('GET', '/v1/finance/cash')).json();
    assert.deepEqual({ b: acct(pos, bank.id).balance, src: acct(pos, bank.id).anchor.source, p: acct(pos, petty.id).balance, low: acct(pos, bank.id).belowMinimum },
      { b: 2_000_000, src: 'manual', p: 2_000_000, low: true });
    assert.equal(pos.totals.IDR.bank, 2_000_000);
    assert.equal(pos.totals.IDR.cash, 2_000_000);
    assert.equal(pos.daily.IDR.length, 11, 'from the opening date');
    assert.equal(pos.daily.IDR[10].balance, 4_000_000);
    assert.equal(pos.daily.IDR[0].balance, 5_000_000);
    assert.equal((await cash.check(org)), 1);
    assert.ok(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = $2 AND target_id = $3 AND resolved_at IS NULL`, [org, cash.BELOW_MINIMUM_ALERT, bank.id]));

    // The bank's statement (same last digits) today: its balance is the anchor.
    const st = (await one<{ id: string }>(`INSERT INTO bank_statement (org_id, bank, filename, account_hint) VALUES ($1, 'BCA', 'mutasi.csv', '0012347788') RETURNING id`, [org]))!.id;
    await query(`INSERT INTO bank_statement_line (statement_id, org_id, line_no, line_date, description, amount_minor, balance_minor, fingerprint) VALUES ($1, $2, 1, $3, 'SETORAN', 1500000, 3500000, $4)`, [st, org, localDay(), `p18-${TAG}`]);
    pos = (await call('GET', '/v1/finance/cash')).json();
    assert.deepEqual({ b: acct(pos, bank.id).balance, src: acct(pos, bank.id).anchor.source, low: acct(pos, bank.id).belowMinimum }, { b: 3_500_000, src: 'statement', low: false });
    await cash.check(org);
    assert.equal(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = $2 AND target_id = $3 AND resolved_at IS NULL`, [org, cash.BELOW_MINIMUM_ALERT, bank.id]), null, 'resolved');

    assert.equal((await call('POST', '/v1/finance/cash/transfers', { fromAccountId: bank.id, toAccountId: bank.id, amount: 1 })).statusCode, 422);
    assert.equal((await call('POST', `/v1/finance/cash/transfers/${t.json().id}/void`, { reason: 'duplicate' })).statusCode, 200);
    pos = (await call('GET', '/v1/finance/cash')).json();
    assert.equal(acct(pos, petty.id).balance, 0, 'the transfer is void');

    // 13 weeks: the open supplier bill (from the bills test) is an outflow by its due date.
    const wr = await call('GET', '/v1/finance/cash/weeks');
    assert.equal(wr.statusCode, 200, wr.body);
    const w = wr.json();
    const idr = w.currencies.find((c: any) => c.currency === 'IDR');
    assert.equal(idr.weeks.length, 13);
    assert.equal(idr.opening, pos.totals.IDR.total);
    assert.ok(idr.largest.some((f: any) => f.kind === 'supplier_bill'));
    assert.equal(idr.closing, idr.opening + idr.weeks.reduce((s: number, x: any) => s + x.net, 0));
  });
});

dbDescribe('KPI benchmarking', () => {
  test('sites and owners against their peers', async () => {
    const owner = (await one<{ id: string }>(`INSERT INTO site_owner (org_id, name) VALUES ($1, $2) RETURNING id`, [borg, `Hotel ${TAG}`]))!.id;
    const lm = monthsBack(1);
    const mid = new Date(`${lm}-15T12:00:00+07:00`);
    const ss = [];
    for (const [i, rev] of [100_000, 110_000, 120_000, 130_000, 1_000_000].entries()) ss.push(await siteFor(borg, `B${i}`, i < 2 ? owner : null));
    for (const [i, rev] of [100_000, 110_000, 120_000, 130_000, 1_000_000].entries()) await session(borg, ss[i]!, mid, rev, 2, i === 0 ? 3 : 0);
    await query(`INSERT INTO site_energy_rate (org_id, site_id, rate_per_kwh, currency) VALUES ($1, $2, 1500, 'IDR')`, [borg, ss[0]!.site]);
    principalOrg = borg;
    try {
      const b = (await call('GET', '/v1/finance/benchmark?months=1')).json();
      assert.equal(b.rows.length, 5);
      const big = b.rows.find((r: any) => r.revenue === 1_000_000);
      assert.ok(big.outliers.some((o: any) => o.metric === 'revenue' && o.direction === 'high' && o.good));
      assert.equal(big.ranks.revenue, 100);
      const s0 = b.rows.find((r: any) => r.revenue === 100_000);
      assert.equal(s0.metrics.marginPct, Math.round(((100_000 - 1500 * 20) / 100_000) * 1000) / 10, 'energy cost from the rate');
      assert.ok(Math.abs(s0.metrics.collectionDays - 3) < 0.01, 'paid 3 days after');
      assert.equal(s0.metrics.revenuePerKwh, 5_000);
      const hours = b.hours;
      assert.equal(s0.metrics.utilisationPct, Math.round((2 / hours) * 1000) / 10);
      const o = (await call('GET', '/v1/finance/benchmark?months=1&by=owner')).json();
      assert.deepEqual(o.rows.map((r: any) => [r.name, r.sites]).sort(), [[`Hotel ${TAG}`, 2], ['Operator-owned sites', 3]]);
      assert.equal((await call('GET', '/v1/finance/benchmark?months=13')).statusCode, 422);
      assert.equal((await call('GET', '/v1/finance/benchmark?format=xlsx')).rawPayload.subarray(0, 2).toString(), 'PK');
    } finally { principalOrg = org; }
  });
});
