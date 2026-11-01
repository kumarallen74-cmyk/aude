import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 27 of the finance review (v1.38.0):
 *   - FX treasury: the exposure per currency (cash, payables, open hedges) at the month's rate and its revaluation;
 *     hedges marked to market, settled net with the realised result in the ledger (7400, 8400);
 *   - procurement: spend and concentration, part and energy price trends, supplier scorecards, the savings register;
 *   - close automation: working-day due dates, a run of the mechanical steps with what still blocks, owners and overdue
 *     alerts, the automatic run, the days-to-close trend;
 *   - owner finance: an owner's sites, statements, payouts and what is owed, the operator's view, the portal and the pack.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase27.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const { registerOwnerPortalRoutes } = await import('../api/owner-portal-routes.js');
const fxt = await import('./fx-treasury.js');
const pc = await import('./procurement.js');
const ca = await import('./close-automation.js');
const gl = await import('./general-ledger.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID(), B = randomUUID();
let org = '';
let app: FastifyInstance, portalApp: FastifyInstance;
let siteA = '', cp = '', conn = '', owner = '';
const zone = config.billing.timeZone;
const localDay = (t: number = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(t));
const monthsBack = (n: number) => {
  let [y, m] = localDay().slice(0, 7).split('-').map(Number) as [number, number];
  for (let i = 0; i < n; i++) { m--; if (m === 0) { m = 12; y--; } }
  return `${y}-${String(m).padStart(2, '0')}`;
};
const lastDay = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });

async function session(site: string, month: string, wh: number, revenue: number) {
  const start = new Date(`${month}-10T10:00:00+07:00`);
  const id = (await one<{ id: string }>(
    `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, ended_at, duration_s, energy_wh, state, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 3600, $8, 'rated', 'IDR') RETURNING id`, [org, site, conn, cp, `p27-${randomUUID()}`, start, new Date(start.getTime() + 3_600_000), wh]))!.id;
  await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency)
               VALUES ($1, $2, $3, '[]', $4, 0, 0, $4, 0, 0, $4, '{}', 'IDR')`, [id, org, new Date(start.getTime() + 3_600_000), revenue]);
  return id;
}
const supplier = async (name: string) => (await one<{ id: string }>(`INSERT INTO supplier (org_id, name) VALUES ($1, $2) RETURNING id`, [org, `${name} ${TAG}`]))!.id;
const bill = (sid: string, b: { currency?: string; amount: number; on: string; due: string; status: string; category?: string; paidAt?: string | null; rejected?: string | null }) => query(
  `INSERT INTO supplier_bill (org_id, supplier_id, number, category, description, currency, subtotal_minor, vat_minor, wht_minor, bill_date, due_date, status, paid_at, rejected_reason)
   VALUES ($1, $2, $3, $4, 'Bill', $5, $6, 0, 0, $7, $8, $9, $10, $11)`,
  [org, sid, `B-${TAG}-${randomBytes(3).toString('hex')}`, b.category ?? 'maintenance', b.currency ?? 'IDR', b.amount, b.on, b.due, b.status, b.paidAt ?? null, b.rejected ?? null]);

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Treasury ${TAG}`, `p27-${TAG}`]))!.id;
    for (const [u, n] of [[A, 'Rina'], [B, 'Budi']] as const) await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, $4)`, [u, org, `${u.slice(0, 8)}@p27.test`, n]);
    owner = (await one<{ id: string }>(`INSERT INTO site_owner (org_id, name, legal_name) VALUES ($1, $2, 'PT Hotel Nusantara') RETURNING id`, [org, `Hotel ${TAG}`]))!.id;
    siteA = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code, owner_id) VALUES ($1, $2, 'ID', $3) RETURNING id`, [org, `A Mall ${TAG}`, owner]))!.id;
    cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name) VALUES ($1, $2, $2) RETURNING id`, [siteA, `P27-${TAG}`]))!.id;
    const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [cp]))!.id;
    conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, max_power_w) VALUES ($1, 60000) RETURNING id`, [e]))!.id;
    await query(`INSERT INTO site_energy_rate (site_id, org_id, rate_per_kwh, currency) VALUES ($1, $2, 1500, 'IDR')`, [siteA, org]);
    app = Fastify({ bodyLimit: 6 * 1024 * 1024 });
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: A, orgId: org, assignments: [{ permissions: ['payment:read', 'payment:write', 'invoice:read', 'invoice:write', 'finance:approve'], scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
    portalApp = Fastify();
    portalApp.addHook('onRequest', async (req) => { (req as any).principal = { userId: B, orgId: org, ownerIds: [owner], assignments: [] }; });
    await registerOwnerPortalRoutes(portalApp);
  });
  after(async () => {
    await app?.close(); await portalApp?.close();
    const o = [org];
    await query(`DELETE FROM gl_line WHERE org_id = ANY($1::uuid[])`, [o]);
    for (const t of ['close_run', 'close_assignment', 'close_signoff', 'fx_hedge', 'procurement_saving', 'goods_receipt', 'purchase_order_line', 'purchase_order', 'stock_move', 'stock_item', 'stock_location',
      'site_energy_cost', 'supplier_bill', 'supplier', 'owner_statement_dispute', 'statement_payment', 'commission_statement', 'finance_period_lock', 'finance_check_finding',
      'gl_entry', 'gl_account', 'fx_rate', 'site_energy_rate', 'finance_org_settings']) await query(`DELETE FROM ${t} WHERE org_id = ANY($1::uuid[])`, [o]);
    await query(`DELETE FROM cash_account WHERE org_id = $1`, [org]);
    await query(`DELETE FROM cdr WHERE org_id = $1`, [org]);
    await query(`DELETE FROM charging_session WHERE org_id = $1`, [org]);
    await query(`DELETE FROM connector WHERE id = $1`, [conn]);
    await query(`DELETE FROM evse WHERE charge_point_id = $1`, [cp]);
    await query(`DELETE FROM charge_point WHERE id = $1`, [cp]);
    await query(`DELETE FROM site WHERE org_id = $1`, [org]);
    await query(`DELETE FROM site_owner WHERE org_id = $1`, [org]);
    await query(`DELETE FROM alert WHERE org_id = $1`, [org]);
    await query(`DELETE FROM app_user WHERE org_id = $1`, [org]).catch(() => { /* audit rows keep them */ });
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => { /* audit rows keep it */ });
    await pool.end();
  });
}

describe('FX, procurement and close helpers', () => {
  test('cross rates, hedge results, grades and scores, savings to date, working days', () => {
    const r = new Map([['USD', 160], ['SGD', 120]]);
    assert.equal(fxt.crossRate(r, 'IDR', 'USD', 'IDR'), 160);
    assert.equal(fxt.crossRate(r, 'IDR', 'IDR', 'USD'), 1 / 160);
    assert.equal(fxt.crossRate(r, 'IDR', 'USD', 'SGD'), 160 / 120);
    assert.equal(fxt.crossRate(r, 'IDR', 'MYR', 'IDR'), null);
    assert.equal(fxt.hedgeResult(500_000, 158, 161), 1_500_000);
    assert.equal(fxt.hedgeResult(100_000, 16_000, 16_250, 'USD', 'IDR'), 250_000, 'USD 1,000 (cents) × Rp 250');
    assert.equal(fxt.convert(100_000, 3_500, 'MYR', 'IDR'), 3_500_000, 'RM 1,000 at Rp 3,500');
    assert.equal(fxt.convert(350_000, 1 / 3_500, 'IDR', 'MYR'), 10_000);
    assert.deepEqual([fxt.exponentOf('IDR'), fxt.exponentOf('USD'), fxt.exponentOf('JPY')], [0, 2, 0]);
    assert.deepEqual([pc.grade(95), pc.grade(75), pc.grade(60), pc.grade(59), pc.grade(null)], ['A', 'B', 'C', 'D', null]);
    assert.equal(pc.score({ onTimePct: 50, avgDaysLate: 2.5, rejectedPct: 50, paidOnTimePct: 100 }), 72);
    assert.equal(pc.score({ onTimePct: null, avgDaysLate: null, rejectedPct: null, paidOnTimePct: null }), null);
    assert.deepEqual(pc.savingToDate(100, 90, 100, '2026-01-01', '2026-01-10', '2026-01-05'), { expected: 1000, toDate: 500, passedPct: 50 });
    assert.deepEqual(pc.savingToDate(100, 90, 100, '2026-01-01', '2026-01-10', '2025-12-31'), { expected: 1000, toDate: 0, passedPct: 0 });
    // 31 October 2026 is a Saturday: the 1st working day after is Monday 2 November, the 3rd Wednesday 4 November.
    assert.equal(ca.workingDay('2026-10', 1), '2026-11-02');
    assert.equal(ca.workingDay('2026-10', 3), '2026-11-04');
    assert.equal(ca.workingDay('2026-02', 1), '2026-03-02');
    assert.equal(ca.daysToClose('2026-09', '2026-10-05'), 5);
  });
});

dbDescribe('Treasury FX and hedging (v1.38.0)', () => {
  test('exposure and revaluation; hedges marked, settled net to the ledger', async () => {
    const m0 = localDay().slice(0, 7), mPrev = monthsBack(1), today = localDay();
    await query(`INSERT INTO finance_org_settings (org_id, reporting_currency) VALUES ($1, 'IDR') ON CONFLICT (org_id) DO UPDATE SET reporting_currency = 'IDR'`, [org]);
    await query(`INSERT INTO fx_rate (org_id, month, currency, reporting, rate, source) VALUES ($1, $2, 'USD', 'IDR', 16000, 'manual'), ($1, $3, 'USD', 'IDR', 15500, 'manual')`, [org, m0, mPrev]);
    const usd = (await one<{ id: string }>(`INSERT INTO cash_account (org_id, name, kind, currency, opening_balance_minor, opening_on) VALUES ($1, 'USD account', 'bank', 'USD', 200000, $2) RETURNING id`, [org, `${monthsBack(2)}-01`]))!.id;
    const idr = (await one<{ id: string }>(`INSERT INTO cash_account (org_id, name, kind, currency, opening_balance_minor, opening_on) VALUES ($1, 'Operating', 'bank', 'IDR', 0, $2) RETURNING id`, [org, `${monthsBack(2)}-01`]))!.id;
    const s = await supplier('Charger Co');
    await bill(s, { currency: 'USD', amount: 1_000_000, on: `${mPrev}-05`, due: addDays(today, 30), status: 'approved', category: 'equipment' });
    const h1 = await call('POST', '/v1/finance/fx-hedges', { bank: 'Bank Mandiri', reference: 'FWD-1', buyCurrency: 'USD', sellCurrency: 'IDR', notional: 500_000, rate: 15_800, tradeOn: `${mPrev}-06`, maturityOn: addDays(today, 30), purpose: 'Charger invoice', cashAccountId: idr });
    assert.equal(h1.statusCode, 201, h1.body);
    assert.equal(h1.json().sellAmount, 79_000_000, 'USD 5,000 at Rp 15,800');
    assert.equal((await call('POST', '/v1/finance/fx-hedges', { bank: 'X', buyCurrency: 'USD', sellCurrency: 'IDR', notional: 1, rate: 158, tradeOn: today, maturityOn: today, cashAccountId: usd })).statusCode, 422, 'settles in the currency sold');
    assert.equal((await call('POST', '/v1/finance/fx-hedges', { bank: 'X', buyCurrency: 'USD', sellCurrency: 'USD', notional: 1, rate: 1, tradeOn: today, maturityOn: today })).statusCode, 422);

    const ex = (await call('GET', '/v1/finance/fx-exposure')).json();
    const u = ex.currencies.find((c: any) => c.currency === 'USD');
    assert.deepEqual([u.cash, u.payables, u.gross, u.hedges, u.net, u.hedgedPct], [200_000, 1_000_000, -800_000, 500_000, -300_000, 62.5]);
    assert.deepEqual([u.rate, u.previousRate, u.netReporting, u.revaluation, u.sensitivity], [16_000, 15_500, -48_000_000, -1_500_000, -4_800_000], 'USD −3,000 at Rp 16,000');
    assert.equal(ex.currencies.some((c: any) => c.currency === 'IDR'), false, 'the reporting currency is not an exposure');
    assert.equal((await call('GET', '/v1/finance/fx-exposure?format=xlsx')).statusCode, 200);

    const hs = (await call('GET', '/v1/finance/fx-hedges')).json();
    assert.deepEqual([hs.hedges[0].marketRate, hs.hedges[0].markToMarket], [16_000, 1_000_000]);

    const st = await call('PUT', `/v1/finance/fx-hedges/${h1.json().id}`, { status: 'settled', settledOn: today, settledRate: 16_100 });
    assert.equal(st.statusCode, 200, st.body);
    assert.equal(st.json().realised, 1_500_000);
    assert.equal((await call('PUT', `/v1/finance/fx-hedges/${h1.json().id}`, { status: 'cancelled' })).statusCode, 409);
    const h2 = (await call('POST', '/v1/finance/fx-hedges', { bank: 'BCA', buyCurrency: 'USD', sellCurrency: 'IDR', notional: 100_000, rate: 15_800, tradeOn: `${mPrev}-06`, maturityOn: today, cashAccountId: idr })).json();
    assert.equal((await call('PUT', `/v1/finance/fx-hedges/${h2.id}`, { status: 'settled', settledOn: today, settledRate: 15_000 })).json().realised, -800_000);
    const h3 = (await call('POST', '/v1/finance/fx-hedges', { bank: 'BNI', buyCurrency: 'USD', sellCurrency: 'IDR', notional: 100_000, rate: 15_800, tradeOn: today, maturityOn: today })).json();
    assert.equal((await call('PUT', `/v1/finance/fx-hedges/${h3.id}`, { status: 'cancelled' })).json().status, 'cancelled');

    const j = await fxt.journal(org, m0);
    const L = j.IDR!;
    const sum = (code: string, k: 'debit' | 'credit') => L.filter((l) => l.account === code).reduce((a, l) => a + l[k], 0);
    assert.deepEqual([sum('7400', 'credit'), sum('8400', 'debit'), sum('1100', 'debit'), sum('1100', 'credit')], [1_500_000, 800_000, 1_500_000, 800_000]);
    const synced = await gl.sync(org, m0, A);
    assert.ok(synced.posted >= 1);
    const posted = await many<any>(`SELECT l.account_code AS code, sum(l.debit)::bigint AS d, sum(l.credit)::bigint AS c FROM gl_line l JOIN gl_entry e ON e.id = l.entry_id
                                    WHERE e.org_id = $1 AND e.source = 'fx' AND e.status = 'posted' GROUP BY 1`, [org]);
    assert.equal(Number(posted.find((p) => p.code === '7400')?.c), 1_500_000);
    // The cash position carries the net settlements into the IDR account.
    const pos = (await call('GET', '/v1/finance/cash')).json();
    assert.equal(pos.accounts.find((a: any) => a.id === String(idr)).balance, 700_000);
  });
});

dbDescribe('Procurement analytics (v1.38.0)', () => {
  test('spend and concentration, price trends, scorecards and the savings register', async () => {
    const m1 = monthsBack(1), m2 = monthsBack(2);
    const s1 = await supplier('Parts Co'), s2 = await supplier('PLN');
    await bill(s1, { amount: 1_000_000, on: `${m1}-05`, due: `${m1}-25`, status: 'paid', paidAt: `${m1}-20T10:00:00+07:00` });
    await bill(s1, { amount: 9_000_000, on: `${m1}-06`, due: `${m1}-26`, status: 'rejected', rejected: 'Wrong price' });
    await bill(s2, { amount: 3_000_000, on: `${m1}-07`, due: `${m1}-27`, status: 'approved', category: 'energy' });
    for (const [exp, got] of [[`${m1}-10`, `${m1}-15`], [`${m1}-20`, `${m1}-18`]] as const) {
      const po = (await one<{ id: string }>(`INSERT INTO purchase_order (org_id, supplier_id, number, currency, description, expected_on, status, approved_at) VALUES ($1, $2, $3, 'IDR', 'Parts', $4, 'approved', now()) RETURNING id`, [org, s1, `PO-${TAG}-${exp}`, exp]))!.id;
      const ln = (await one<{ id: string }>(`INSERT INTO purchase_order_line (org_id, order_id, seq, description, quantity, unit_price_minor, received_qty) VALUES ($1, $2, 1, 'Cable', 10, 100000, 10) RETURNING id`, [org, po]))!.id;
      await query(`INSERT INTO goods_receipt (org_id, order_id, line_id, quantity, received_on) VALUES ($1, $2, $3, 10, $4)`, [org, po, ln, got]);
    }
    const item = (await one<{ id: string }>(`INSERT INTO stock_item (org_id, sku, name, currency, supplier_id) VALUES ($1, $2, 'Type 2 cable', 'IDR', $3) RETURNING id`, [org, `CBL-${TAG}`, s1]))!.id;
    const loc = (await one<{ id: string }>(`INSERT INTO stock_location (org_id, name) VALUES ($1, 'Store') RETURNING id`, [org]))!.id;
    for (const [d, u] of [[`${m2}-10`, 100_000], [`${m1}-10`, 115_000]] as const) await query(`INSERT INTO stock_move (org_id, item_id, location_id, kind, qty, unit_cost_minor, value_minor, on_date) VALUES ($1, $2, $3, 'receipt', 5, $4, $5, $6)`, [org, item, loc, u, u * 5, d]);
    for (const [m, a] of [[m2, 1_500_000], [m1, 1_800_000]] as const) await query(`INSERT INTO site_energy_cost (org_id, site_id, month, amount_minor, kwh_billed, currency) VALUES ($1, $2, $3, $4, 1000, 'IDR')`, [org, siteA, m, a]);

    const r = (await call('GET', '/v1/finance/procurement?months=3')).json();
    const c = r.spend.currencies.find((x: any) => x.currency === 'IDR');
    assert.deepEqual([c.total, c.bills, c.topSupplierPct], [4_000_000, 2, 75], 'rejected bills are not spend');
    assert.equal(c.categories[0].category, 'energy');
    const part = r.prices.parts.find((p: any) => p.itemId === String(item));
    assert.deepEqual([part.first, part.last, part.changePct, part.rising], [100_000, 115_000, 15, true]);
    const en = r.prices.energy.find((x: any) => x.siteId === siteA);
    assert.deepEqual([en.first, en.last, en.changePct, en.rising], [1500, 1800, 20, true]);
    const card = r.scorecards.suppliers.find((x: any) => x.supplierId === String(s1));
    assert.deepEqual([card.onTimePct, card.avgDaysLate, card.rejectedPct, card.paidOnTimePct, card.score, card.grade], [50, 2.5, 50, 100, 72, 'C']);

    assert.equal((await call('POST', '/v1/finance/procurement/savings', { category: 'parts', description: 'Cable', currency: 'IDR', baselineUnit: 100, negotiatedUnit: 100, quantity: 1, periodFrom: '2025-01-01', periodTo: '2025-12-31' })).statusCode, 422);
    const sv = await call('POST', '/v1/finance/procurement/savings', { supplierId: s1, category: 'parts', description: 'Cable, annual price', currency: 'IDR', baselineUnit: 100_000, negotiatedUnit: 90_000, quantity: 100, periodFrom: '2025-01-01', periodTo: '2025-12-31' });
    assert.equal(sv.statusCode, 201, sv.body);
    assert.deepEqual([sv.json().expected, sv.json().toDate, sv.json().unitSavingPct], [1_000_000, 1_000_000, 10]);
    assert.equal((await call('GET', '/v1/finance/procurement')).json().savings.totals.IDR.expected, 1_000_000);
    assert.equal((await call('POST', `/v1/finance/procurement/savings/${sv.json().id}/void`)).json().voided, true);
    assert.equal((await call('GET', '/v1/finance/procurement')).json().savings.totals.IDR, undefined);
    assert.equal((await call('GET', '/v1/finance/procurement?format=xlsx')).statusCode, 200);
    assert.equal((await call('GET', '/v1/finance/procurement?months=5')).statusCode, 400);
  });
});

dbDescribe('Finance close automation (v1.38.0)', () => {
  test('a run, owners and due days, overdue alerts, the automatic run and the trend', async () => {
    const m1 = monthsBack(1), m3 = monthsBack(3);
    const run = await call('POST', '/v1/finance/close-automation/run', { month: m1 });
    assert.equal(run.statusCode, 201, run.body);
    const acts = run.json().actions as Array<{ action: string; status: string }>;
    assert.equal(acts.find((a) => a.action === 'ledger_synced')?.status, 'done');
    assert.equal(acts.find((a) => a.action === 'anomalies_reviewed')?.status, 'done');
    assert.equal(run.json().blocking, acts.filter((a) => a.action.startsWith('blocking:')).length);
    assert.equal((await call('POST', '/v1/finance/close-automation/run', { month: localDay().slice(0, 7) })).statusCode, 422, 'not before the month ends');

    assert.equal((await call('PUT', '/v1/finance/close-automation/owners', { assignments: [{ step: 'nope' }] })).statusCode, 422);
    assert.equal((await call('PUT', '/v1/finance/close-automation/owners', { assignments: [{ step: 'bank_reconciled', ownerId: randomUUID() }] })).statusCode, 422, 'not a user of the organisation');
    const own = await call('PUT', '/v1/finance/close-automation/owners', { assignments: [{ step: 'bank_reconciled', ownerId: B, dueDay: 1 }, { step: 'fx_rates', ownerId: A, dueDay: 2 }] });
    assert.equal(own.statusCode, 200, own.body);
    assert.equal(own.json().assignments.find((a: any) => a.step === 'bank_reconciled').owner, 'Budi');
    assert.equal((await call('PUT', '/v1/finance/close-automation/settings', { enabled: true, runOnDay: 1 })).json().enabled, true);
    assert.equal((await call('PUT', '/v1/finance/close-automation/settings', { runOnDay: 11 })).statusCode, 422);

    const ov = (await call('GET', `/v1/finance/close-automation?month=${m1}`)).json();
    const br = ov.calendar.steps.find((s: any) => s.step === 'bank_reconciled');
    assert.deepEqual([br.owner, br.dueOn], ['Budi', ca.workingDay(m1, 1)]);
    assert.equal(ov.runs.length, 1);

    // Later in the month after: the automatic run happens once that day, and steps not signed off are overdue.
    const later = new Date(`${localDay().slice(0, 7)}-25T12:00:00+07:00`);
    await ca.sweep(later);
    await ca.sweep(later);
    const auto = await many<any>(`SELECT * FROM close_run WHERE org_id = $1 AND month = $2 AND automatic`, [org, m1]);
    assert.equal(auto.length, 1, 'once a day');
    const al = await one<any>(`SELECT * FROM alert WHERE org_id = $1 AND kind = 'finance.close_step_overdue' AND target_id = $2 AND resolved_at IS NULL`, [org, `${m1}:bank_reconciled`]);
    assert.ok(al, 'overdue alert');
    assert.match(al.message, /Budi/);
    await query(`INSERT INTO finance_period_lock (org_id, month, locked_at) VALUES ($1, $2, now())`, [org, m1]);
    await ca.sweep(later);
    assert.equal((await one<any>(`SELECT count(*)::int AS n FROM alert WHERE org_id = $1 AND kind = 'finance.close_step_overdue' AND resolved_at IS NULL`, [org]))!.n, 0, 'resolved once locked');
    assert.equal((await call('POST', '/v1/finance/close-automation/run', { month: m1 })).statusCode, 409);

    await query(`INSERT INTO finance_period_lock (org_id, month, locked_at) VALUES ($1, $2, $3)`, [org, m3, `${addDays(lastDay(m3), 4)}T12:00:00+07:00`]);
    const tr = (await call('GET', `/v1/finance/close-automation?month=${m1}`)).json().trend;
    assert.equal(tr.months.find((m: any) => m.month === m3).days, 4);
  });
});

dbDescribe('Owner and partner finance (v1.38.0)', () => {
  test("an owner's results, statements and what is owed; the operator's view; the portal and the pack", async () => {
    const m1 = monthsBack(1);
    await session(siteA, m1, 50_000, 500_000);
    const st = (await one<{ id: string }>(
      `INSERT INTO commission_statement (org_id, owner_id, period, number, gtv_minor, commission_minor, minimum_topup_minor, private_fee_minor, mdr_credit_minor, net_minor, tax_minor, total_minor, owner_share_minor, data, finalised_at, currency)
       VALUES ($1, $2, $3, $4, 500000, 50000, 0, 0, 0, 50000, 0, 50000, 450000, '{}'::jsonb, now(), 'IDR') RETURNING id`, [org, owner, `${m1}-01`, `OS-${TAG}`]))!.id;
    await query(`INSERT INTO statement_payment (org_id, statement_id, kind, owner_id, amount_minor, currency, paid_on, reference, recorded_by) VALUES ($1, $2, 'owner_payout', $3, 200000, 'IDR', $4, 'TRF-1', $5)`, [org, st, owner, `${m1}-28`, A]);
    await query(`INSERT INTO owner_statement_dispute (org_id, owner_id, statement_id, message, claimed_minor, state) VALUES ($1, $2, $3, 'Sessions missing', 10000, 'open')`, [org, owner, st]);

    const s = (await call('GET', `/v1/finance/owners/${owner}/finance?months=3`)).json();
    const c = s.currencies.find((x: any) => x.currency === 'IDR');
    const mm = c.months.find((m: any) => m.month === m1);
    assert.deepEqual([mm.sessions, mm.kwh, mm.revenue, mm.gross, mm.commission, mm.share, mm.paid, mm.outstanding], [1, 50, 500_000, 500_000, 50_000, 450_000, 200_000, 250_000]);
    assert.equal(c.totals.sharePct, 90);
    assert.deepEqual(s.openQueries, { count: 1, claimed: 10_000 });
    assert.equal(c.sites[0].siteId, siteA);
    assert.equal((await call('GET', `/v1/finance/owners/${randomUUID()}/finance`)).statusCode, 404);
    assert.equal((await call('GET', `/v1/finance/owners/${owner}/finance?format=xlsx`)).statusCode, 200);

    const ops = (await call('GET', '/v1/finance/owner-finance?months=3')).json();
    const row = ops.owners.find((o: any) => o.ownerId === owner);
    assert.deepEqual([row.share, row.paid, row.outstanding, row.oldestUnpaid, row.openQueries, row.sites], [450_000, 200_000, 250_000, m1, 1, 1]);

    const p = await portalApp.inject({ method: 'GET', url: '/v1/owner-portal/finance?months=3' });
    assert.equal(p.statusCode, 200, p.body);
    assert.equal(p.json().owner.id, owner);
    const pk = await portalApp.inject({ method: 'GET', url: `/v1/owner-portal/finance/pack?year=${m1.slice(0, 4)}` });
    assert.equal(pk.statusCode, 200, pk.body);
    assert.match(String(pk.headers['x-manifest-sha256']), /^[0-9a-f]{64}$/);
    assert.equal(pk.rawPayload.subarray(0, 2).toString(), 'PK');
    assert.ok(pk.rawPayload.includes(Buffer.from('statements.csv')));
  });
});
