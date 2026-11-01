import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 19 of the finance review (v1.30.0):
 *   - purchase orders: approval by a second person, goods received in parts, the three-way match (a bill above what was
 *     received needs a Finance Manager; matched once the rest arrives), cancel refused after a receipt, closed;
 *   - leases (PSAK 73): the liability and right-of-use asset, the schedule ending at 0, the month's journal balanced and
 *     recorded, void refused after, an early end with its gain or loss, a short-term lease expensed;
 *   - treasury: a deposit out of the bank account and into the cash position's deposits, interest accrued, broken with a
 *     penalty and back in the account, a maturing alert, idle cash;
 *   - anomaly review: duplicate bills and payments, round amounts, a large bill from a new supplier; dismissed and
 *     confirmed, cleared when the condition is gone, a review kept when found again.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase19.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const leases = await import('./leases.js');
const treasury = await import('./treasury.js');
const checks = await import('./finance-checks.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID(), B = randomUUID();
let org = '', site = '', cp = '', evse = '', conn = '';
let app: FastifyInstance;
let principalUser: string = A;
let approver = true;
const zone = config.billing.timeZone;
const localDay = (t: number = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(t));
const daysAgo = (n: number) => localDay(Date.now() - n * 86_400_000);
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

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Procure ${TAG}`, `p19-${TAG}`]))!.id;
    for (const [u, n] of [[A, 'Rina'], [B, 'Budi']] as const) await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, $4)`, [u, org, `${u.slice(0, 8)}@p19.test`, n]);
    site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'ID') RETURNING id`, [org, `Depok ${TAG}`]))!.id;
    cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name) VALUES ($1, $2, $2) RETURNING id`, [site, `P19-${TAG}`]))!.id;
    evse = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [cp]))!.id;
    conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, max_power_w) VALUES ($1, 60000) RETURNING id`, [evse]))!.id;
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      const perms = ['payment:read', 'payment:write', 'invoice:read', 'invoice:write', ...(approver ? ['finance:approve'] : [])];
      (req as any).principal = { userId: principalUser, orgId: org, assignments: [{ permissions: perms, scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
  });
  after(async () => {
    await app?.close();
    const o = [org];
    for (const t of ['finance_check_finding', 'deposit', 'lease_run', 'lease', 'supplier_payment']) await query(`DELETE FROM ${t} WHERE org_id = ANY($1::uuid[])`, [o]);
    await query(`DELETE FROM fixed_asset WHERE org_id = ANY($1::uuid[])`, [o]);
    await query(`DELETE FROM supplier_bill WHERE org_id = ANY($1::uuid[])`, [o]);
    for (const t of ['goods_receipt', 'purchase_order_line', 'purchase_order', 'supplier', 'cash_transfer', 'cash_balance', 'cash_account', 'finance_org_settings']) await query(`DELETE FROM ${t} WHERE org_id = ANY($1::uuid[])`, [o]);
    await query(`DELETE FROM connector WHERE id = $1`, [conn]);
    await query(`DELETE FROM evse WHERE id = $1`, [evse]);
    await query(`DELETE FROM charge_point WHERE id = $1`, [cp]);
    await query(`DELETE FROM site WHERE org_id = $1`, [org]);
    await query(`DELETE FROM alert WHERE org_id = $1`, [org]);
    await query(`DELETE FROM app_user WHERE org_id = $1`, [org]).catch(() => { /* audit rows keep them */ });
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => { /* audit rows keep it */ });
    await pool.end();
  });
}

describe('Lease and deposit maths', () => {
  test('the liability is the discounted payments; it ends at 0; the interest is the difference; short-term is expensed', () => {
    const t = { payment: 10_000_000, frequency: 'monthly' as const, timing: 'advance' as const, termMonths: 36, ratePct: 9, directCosts: 1_000_000, startMonth: '2026-01', exempt: null, endedMonth: null };
    const s = leases.schedule(t);
    assert.equal(s.rou, s.liability + 1_000_000);
    assert.equal(s.rows.length, 36);
    assert.equal(s.rows[35]!.closing, 0);
    assert.equal(s.rows.reduce((a, r) => a + r.interest, 0), 360_000_000 - s.liability);
    assert.equal(s.rows.reduce((a, r) => a + r.depreciation, 0), s.rou);
    assert.equal(s.rows[0]!.interest, Math.round((s.liability - 10_000_000) * (Math.pow(1.09, 1 / 12) - 1)), 'in advance: interest after the payment');
    assert.equal(leases.presentValue({ ...t, ratePct: 0 }), 360_000_000, 'no discount');
    const short = leases.schedule({ ...t, termMonths: 12, exempt: 'short_term' });
    assert.equal(short.liability, 0);
    assert.equal(short.rows.reduce((a, r) => a + r.expense, 0), 120_000_000);
    const p = leases.positionAt(t, '2026-12');
    assert.equal(p.current + p.nonCurrent, p.liability);
    assert.equal(p.current, p.liability - s.rows.find((r) => r.month === '2027-12')!.closing);
  });
  test('interest actual/365 with the final tax; idle cash above the minimums', () => {
    assert.deepEqual(treasury.interest(1_000_000_000, 5, 20, '2026-01-01', '2026-01-31'), { days: 30, gross: Math.round(1_000_000_000 * 5 * 30 / 36_500), tax: Math.round(Math.round(1_000_000_000 * 5 * 30 / 36_500) * 0.2), net: Math.round(1_000_000_000 * 5 * 30 / 36_500) - Math.round(Math.round(1_000_000_000 * 5 * 30 / 36_500) * 0.2) });
    const idle = treasury.idleCash({ currencies: [{ currency: 'IDR', minimum: 100_000_000, lowest: 873_456_789, weeks: [{ week: 1, closing: 900_000_000 }, { week: 4, closing: 873_456_789 }] }] }, { indicativeRatePct: 4, buffer: 50_000_000 });
    assert.equal(idle[0]!.amount, 720_000_000, 'rounded down to two figures');
    assert.equal(idle[0]!.termMonths, 1);
    assert.ok(idle[0]!.netInterest3m > idle[0]!.netInterest1m);
  });
});

dbDescribe('Purchase orders and the three-way match', () => {
  test('approved by a second person, received in parts, a bill matched against what arrived', async () => {
    const sup = (await call('POST', '/v1/finance/suppliers', { name: `Mitra Instalasi ${TAG}`, termsDays: 30 })).json();
    const r = await call('POST', '/v1/finance/purchase-orders', { supplierId: sup.id, siteId: site, description: 'Two DC chargers installed', expectedOn: localDay(),
      lines: [{ description: 'DC charger 60 kW', quantity: 2, unitPrice: 250_000_000 }, { description: 'Installation', quantity: 1, unitPrice: 50_000_000 }] });
    assert.equal(r.statusCode, 201, r.body);
    const po = r.json();
    assert.match(po.number, /^PO-\d{5}$/);
    assert.deepEqual({ st: po.status, ordered: po.ordered, cur: po.currency }, { st: 'awaiting_approval', ordered: 550_000_000, cur: 'IDR' });
    assert.equal((await call('POST', `/v1/finance/purchase-orders/${po.id}/approve`)).statusCode, 403, 'not the submitter');
    assert.equal((await call('POST', `/v1/finance/purchase-orders/${po.id}/receipts`, { lines: [{ lineId: po.lines[0].id, quantity: 1 }] })).statusCode, 409, 'not approved yet');
    assert.equal((await as(B, () => call('POST', `/v1/finance/purchase-orders/${po.id}/approve`))).json().status, 'approved');

    const rc = (await call('POST', `/v1/finance/purchase-orders/${po.id}/receipts`, { lines: [{ lineId: po.lines[0].id, quantity: 1 }], note: 'First unit delivered' })).json();
    assert.equal(rc.received, 250_000_000);
    assert.equal((await call('POST', `/v1/finance/purchase-orders/${po.id}/receipts`, { lines: [{ lineId: po.lines[0].id, quantity: 2 }] })).statusCode, 422, 'more than outstanding');
    assert.equal((await call('POST', `/v1/finance/purchase-orders/${po.id}/cancel`, { reason: 'changed mind' })).statusCode, 409, 'goods received');

    // A bill for everything while only one charger arrived.
    const bill = (await call('POST', '/v1/finance/bills', { supplierId: sup.id, number: 'MI-77', category: 'installation', siteId: site, description: 'Chargers and installation', subtotal: 550_000_000, vat: 60_500_000, billDate: localDay(), purchaseOrderId: po.id })).json();
    assert.equal(bill.purchaseOrder, po.number);
    assert.equal(bill.match.status, 'over_billed');
    const other = (await call('POST', '/v1/finance/suppliers', { name: `Other ${TAG}` })).json();
    assert.equal((await call('POST', '/v1/finance/bills', { supplierId: other.id, number: 'X1', category: 'other', description: 'x', subtotal: 1, billDate: localDay(), purchaseOrderId: po.id })).statusCode, 422, 'another supplier\'s order');
    const refused = await as(B, () => call('POST', `/v1/finance/bills/${bill.id}/approve`), false);
    assert.equal(refused.statusCode, 403);
    assert.match(refused.json().error, /three-way match/);

    await call('POST', `/v1/finance/purchase-orders/${po.id}/receipts`, { lines: [{ lineId: po.lines[0].id, quantity: 1 }, { lineId: po.lines[1].id, quantity: 1 }] });
    const m = (await call('GET', `/v1/finance/purchase-orders/${po.id}`)).json();
    assert.deepEqual({ st: m.match.status, rec: m.match.received, billed: m.match.billed }, { st: 'matched', rec: 550_000_000, billed: 550_000_000 });
    const ok = (await as(B, () => call('POST', `/v1/finance/bills/${bill.id}/approve`), false)).json();
    assert.equal(ok.status, 'approved');
    assert.equal(ok.matchOverridden, undefined);
    const list = (await call('GET', '/v1/finance/purchase-orders')).json();
    assert.equal(list.commitments.length, 0, 'billed in full: nothing committed');
    assert.equal((await call('POST', `/v1/finance/purchase-orders/${po.id}/close`, { reason: 'All delivered' })).json().status, 'closed');
    assert.equal((await call('GET', '/v1/finance/purchase-orders?format=xlsx')).rawPayload.subarray(0, 2).toString(), 'PK');
  });
});

dbDescribe('Leases', () => {
  test('recognised, in the journal and recorded, ended early with its gain or loss; a short-term lease expensed', async () => {
    const start = monthsBack(2);
    const r = await call('POST', '/v1/finance/leases', { description: 'Parking bays, Depok', siteId: site, startMonth: start, termMonths: 60, payment: 15_000_000, timing: 'advance', ratePct: 8.5, directCosts: 2_000_000 });
    assert.equal(r.statusCode, 201, r.body);
    const l = r.json();
    assert.equal(l.exempt, null);
    assert.ok(l.initialLiability > 0 && l.initialLiability < 900_000_000);
    assert.equal(l.status, 'active');
    const short = (await call('POST', '/v1/finance/leases', { description: 'Generator hire', currency: 'IDR', startMonth: start, termMonths: 6, payment: 3_000_000, ratePct: 8 })).json();
    assert.equal(short.exempt, 'short_term');

    const jStart = (await call('GET', `/v1/finance/leases/journal?month=${start}`)).json().currencies.find((c: any) => c.currency === 'IDR');
    assert.equal(jStart.recognised, l.initialLiability);
    assert.equal(jStart.debit, jStart.credit, 'balanced');
    const j = (await call('GET', `/v1/finance/leases/journal?month=${monthsBack(1)}`)).json().currencies.find((c: any) => c.currency === 'IDR');
    assert.equal(j.debit, j.credit);
    assert.equal(j.payments, 15_000_000 + 3_000_000);
    assert.equal(j.expense, 3_000_000);
    assert.equal((await call('POST', `/v1/finance/leases/journal/${monthsBack(1)}/record`)).statusCode, 200);
    assert.equal((await call('POST', `/v1/finance/leases/${l.id}/void`, { reason: 'typo' })).statusCode, 409, 'in a recorded month');

    const pos = (await call('GET', '/v1/finance/leases')).json();
    const mine = pos.leases.find((x: any) => x.id === l.id);
    assert.equal(mine.position.current + mine.position.nonCurrent, mine.position.liability);
    assert.equal(pos.totals.IDR.liability, mine.position.liability);

    const ended = (await call('POST', `/v1/finance/leases/${l.id}/end`, { month: localDay().slice(0, 7), note: 'Site closed' })).json();
    assert.equal(ended.status, 'ended');
    const je = (await call('GET', `/v1/finance/leases/journal?month=${localDay().slice(0, 7)}`)).json().currencies.find((c: any) => c.currency === 'IDR');
    assert.equal(je.debit, je.credit);
    assert.ok(je.lines.some((x: any) => /ended early/.test(x.description)));
    const sched = (await call('GET', `/v1/finance/leases/${l.id}`)).json().schedule;
    assert.equal(sched.length, 2, 'stops at the end');
    assert.equal((await call('GET', '/v1/finance/leases?format=xlsx')).rawPayload.subarray(0, 2).toString(), 'PK');
  });
});

dbDescribe('Treasury', () => {
  test('a deposit out of the account and back with interest; broken with a penalty; maturing alert; idle cash', async () => {
    const acct = (await call('POST', '/v1/finance/cash/accounts', { name: 'Mandiri operating', kind: 'bank', currency: 'IDR', openingBalance: 2_000_000_000, openingOn: daysAgo(20), minimum: 100_000_000 })).json();
    const d = await call('POST', '/v1/finance/treasury/deposits', { cashAccountId: acct.id, bankName: 'Mandiri', reference: 'TD-01', principal: 1_000_000_000, ratePct: 5, placedOn: daysAgo(10), termMonths: 1 });
    assert.equal(d.statusCode, 201, d.body);
    const dep = d.json();
    assert.equal(dep.accrued.days, 10);
    assert.equal(dep.accrued.gross, Math.round(1_000_000_000 * 5 * 10 / 36_500));
    let cash = (await call('GET', '/v1/finance/cash')).json();
    assert.equal(cash.accounts.find((a: any) => a.id === acct.id).balance, 1_000_000_000, 'out of the account');
    assert.equal(cash.totals.IDR.deposits, 1_000_000_000);

    assert.equal((await call('POST', `/v1/finance/treasury/deposits/${dep.id}/close`, { penalty: 1, closedOn: localDay(), interestReceived: 500_000 })).statusCode, 200, 'broken early with a penalty');
    const broken = (await call('GET', `/v1/finance/treasury/deposits/${dep.id}`)).json();
    assert.equal(broken.status, 'broken');
    cash = (await call('GET', '/v1/finance/cash')).json();
    assert.equal(cash.accounts.find((a: any) => a.id === acct.id).balance, 2_000_000_000 + 500_000 - 1, 'back with the interest, less the penalty');
    assert.equal(cash.totals.IDR.deposits, 0);

    const soon = (await call('POST', '/v1/finance/treasury/deposits', { cashAccountId: acct.id, bankName: 'BNI', principal: 300_000_000, ratePct: 4.5, placedOn: daysAgo(27), termDays: 30 })).json();
    assert.ok((await treasury.sweep()) >= 1);
    assert.ok(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = $2 AND target_id = $3 AND resolved_at IS NULL`, [org, treasury.MATURING_ALERT, soon.id]));
    const w = (await call('GET', '/v1/finance/cash/weeks')).json().currencies.find((c: any) => c.currency === 'IDR');
    assert.ok(w.largest.some((f: any) => f.kind === 'deposit_maturity'));
    const t = (await call('GET', '/v1/finance/treasury')).json();
    assert.equal(t.totals.IDR.principal, 300_000_000);
    assert.ok(t.idleCash.find((x: any) => x.currency === 'IDR'));
    assert.equal((await call('POST', `/v1/finance/treasury/deposits/${soon.id}/close`, { closedOn: daysAgo(1), penalty: 5 })).statusCode, 200);
    assert.equal(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = $2 AND target_id = $3 AND resolved_at IS NULL`, [org, treasury.MATURING_ALERT, soon.id]), null, 'resolved');
    assert.equal((await call('POST', '/v1/finance/treasury/deposits', { cashAccountId: acct.id, bankName: 'BNI', principal: 1, ratePct: 4 })).statusCode, 422, 'a term is needed');
  });
});

dbDescribe('Finance anomaly review', () => {
  test('found, reviewed, cleared and kept', async () => {
    const sup = (await call('POST', '/v1/finance/suppliers', { name: `Baru Sekali ${TAG}` })).json();
    const b1 = (await call('POST', '/v1/finance/bills', { supplierId: sup.id, number: 'BS-1', category: 'services', description: 'Consulting', subtotal: 60_000_000, billDate: daysAgo(5) })).json();
    const b2 = (await call('POST', '/v1/finance/bills', { supplierId: sup.id, number: 'BS-2', category: 'services', description: 'Consulting', subtotal: 60_000_000, billDate: daysAgo(2) })).json();
    await as(B, () => call('POST', `/v1/finance/bills/${b1.id}/approve`));
    await call('POST', `/v1/finance/bills/${b1.id}/payments`, { amount: 20_000_000, paidOn: daysAgo(1) });
    await call('POST', `/v1/finance/bills/${b1.id}/payments`, { amount: 20_000_000, paidOn: daysAgo(1) });

    const run = (await call('POST', '/v1/finance/checks/run')).json();
    assert.ok(run.added >= 4, JSON.stringify(run));
    const open = (await call('GET', '/v1/finance/checks')).json();
    const kinds = new Set(open.findings.map((f: any) => f.kind));
    for (const k of ['duplicate_bill', 'duplicate_payment', 'round_amount', 'new_supplier_large']) assert.ok(kinds.has(k), `${k} found`);
    assert.equal(open.findings[0].severity, 'critical', 'the duplicate payment first');

    const dupBill = open.findings.find((f: any) => f.kind === 'duplicate_bill');
    const dupPay = open.findings.find((f: any) => f.kind === 'duplicate_payment');
    const round = open.findings.find((f: any) => f.kind === 'round_amount');
    assert.equal((await call('POST', `/v1/finance/checks/${round.id}/review`, { decision: 'dismiss', note: 'Agreed deposit' })).json().status, 'dismissed');
    assert.equal((await call('POST', `/v1/finance/checks/${dupPay.id}/review`, { decision: 'confirm', note: 'Paid twice, asking for a refund' })).json().status, 'confirmed');
    assert.ok(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = $2`, [org, checks.CONFIRMED_ALERT]));
    assert.equal((await call('POST', `/v1/finance/checks/${round.id}/review`, { decision: 'confirm', note: 'again' })).statusCode, 409);

    // The duplicate bill is voided: its finding clears; the reviewed ones keep their review.
    await call('POST', `/v1/finance/bills/${b2.id}/void`, { reason: 'Duplicate' });
    const again = (await call('POST', '/v1/finance/checks/run')).json();
    assert.ok(again.cleared >= 1);
    const all = (await call('GET', '/v1/finance/checks?status=all')).json().findings;
    assert.equal(all.find((f: any) => f.id === dupBill.id).status, 'cleared');
    assert.equal(all.find((f: any) => f.id === round.id).status, 'dismissed');
    assert.equal(all.find((f: any) => f.id === dupPay.id).status, 'confirmed');

    assert.equal((await call('PUT', '/v1/finance/checks/settings', { disabled: ['out_of_hours', 'nope'] })).statusCode, 422);
    await call('PUT', '/v1/finance/checks/settings', { disabled: ['out_of_hours'] });
    assert.equal((await call('GET', '/v1/finance/checks')).json().summary.find((s: any) => s.kind === 'out_of_hours').enabled, false);
  });
});
