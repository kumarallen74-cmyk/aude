import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import type { DealTerms } from './landlord-deals.js';

/**
 * Phase 25 of the finance review (v1.36.0):
 *   - grants: a capital grant received, deferred and released over its period, clawed back from the deferred balance
 *     first; a per-kWh grant claimed from the kWh charged, approved (income) and paid short; conditions and their alert;
 *   - landlord deals: higher-of with a minimum guarantee (the top-up), rent-free months, an energy recharge; a statement
 *     issued as the landlord's bill; the rent accrued until billed; the statements drafted by the worker;
 *   - chargebacks: recorded on a payment, deadlines, won or lost in the ledger, the evidence PDF; fraud signals (repeat
 *     tokens, refunded and charged back, failed bursts, the rate) and blocking a token;
 *   - the board pack: the risk, sustainability and grants sections, the trend and the slides.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase25.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const grants = await import('./grants.js');
const landlords = await import('./landlord-deals.js');
const cbacks = await import('./chargebacks.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID(), B = randomUUID();
let org = '';
let app: FastifyInstance;
let principalUser: string = A;
let site = '', cp = '', conn = '', token = '';
const zone = config.billing.timeZone;
const localDay = (t: number = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(t));
const monthsBack = (n: number) => {
  let [y, m] = localDay().slice(0, 7).split('-').map(Number) as [number, number];
  for (let i = 0; i < n; i++) { m--; if (m === 0) { m = 12; y--; } }
  return `${y}-${String(m).padStart(2, '0')}`;
};
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });
const as = async <T>(user: string, fn: () => Promise<T>) => { const u = principalUser; principalUser = user; try { return await fn(); } finally { principalUser = u; } };

/** A rated session on the 10th of a month with its charge record; returns the session id. */
async function session(month: string, wh: number, revenue: number) {
  const start = new Date(`${month}-10T10:00:00+07:00`);
  const id = (await one<{ id: string }>(
    `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, token_id, idem_key, started_at, ended_at, duration_s, energy_wh, state, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 3600, $9, 'rated', 'IDR') RETURNING id`, [org, site, conn, cp, token, `p25-${randomUUID()}`, start, new Date(start.getTime() + 3_600_000), wh]))!.id;
  await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency)
               VALUES ($1, $2, $3, $4, $5, 0, 0, $5, 0, 0, $5, '{"name":"Standard"}', 'IDR')`, [id, org, new Date(start.getTime() + 3_600_000), JSON.stringify([{ kind: 'energy', description: 'Energy', quantity: wh / 1000, unit: 'kWh', amountMinor: revenue }]), revenue]);
  await query(`INSERT INTO meter_value (session_id, ts, measurand, value, unit) VALUES ($1, $2, 'Energy.Active.Import.Register', 1000, 'Wh'), ($1, $3, 'Energy.Active.Import.Register', $4, 'Wh')`, [id, start, new Date(start.getTime() + 3_600_000), 1000 + wh]);
  return id;
}

/** A captured card payment for a session. */
async function payment(sessionId: string | null, amount: number, o: { refunded?: number; state?: string; at?: Date; connector?: string } = {}) {
  return (await one<{ id: string }>(
    `INSERT INTO payment_intent (org_id, session_id, provider, provider_ref, method, mode, state, amount_authorised_minor, amount_captured_minor, captured_at, currency, refunded_minor, refunded_at, connector_uuid, created_at)
     VALUES ($1, $2, 'xendit', $3, 'card', 'preauth', $4, $5, $6, $7, 'IDR', $8, $9, $10, $11) RETURNING id`,
    [org, sessionId, `ps-${TAG}-${randomBytes(4).toString('hex')}`, o.state ?? 'captured', amount, o.state && o.state !== 'captured' ? null : amount, o.state && o.state !== 'captured' ? null : o.at ?? new Date(),
      o.refunded ?? null, o.refunded ? new Date() : null, o.connector ?? null, o.at ?? new Date()]))!.id;
}

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Grants ${TAG}`, `p25-${TAG}`]))!.id;
    for (const [u, n] of [[A, 'Rina'], [B, 'Budi']] as const) await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, $4)`, [u, org, `${u.slice(0, 8)}@p25.test`, n]);
    site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'ID') RETURNING id`, [org, `Mall ${TAG}`]))!.id;
    cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name) VALUES ($1, $2, $2) RETURNING id`, [site, `P25-${TAG}`]))!.id;
    const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [cp]))!.id;
    conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, connector_type, max_power_w) VALUES ($1, 'cCCS2', 60000) RETURNING id`, [e]))!.id;
    token = (await one<{ id: string }>(`INSERT INTO token (org_id, kind, uid) VALUES ($1, 'rfid', $2) RETURNING id`, [org, `04A1B2C3${TAG}`]))!.id;
    await query(`INSERT INTO site_energy_rate (site_id, org_id, rate_per_kwh, currency) VALUES ($1, $2, 1500, 'IDR')`, [site, org]);
    app = Fastify({ bodyLimit: 6 * 1024 * 1024 });
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: principalUser, orgId: org, assignments: [{ permissions: ['payment:read', 'payment:write', 'invoice:read', 'invoice:write', 'finance:approve'], scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
  });
  after(async () => {
    await app?.close();
    const o = [org];
    await query(`DELETE FROM gl_line WHERE org_id = ANY($1::uuid[])`, [o]);
    await query(`UPDATE landlord_statement SET bill_id = NULL WHERE org_id = $1`, [org]);
    for (const t of ['chargeback', 'landlord_statement', 'landlord_deal', 'grant_clawback', 'grant_claim', 'grant_condition', 'grant_programme', 'report_pack', 'supplier_payment', 'supplier_bill', 'supplier',
      'gl_entry', 'gl_account', 'cash_transfer', 'cash_balance', 'cash_account', 'site_energy_rate', 'finance_org_settings']) await query(`DELETE FROM ${t} WHERE org_id = ANY($1::uuid[])`, [o]);
    await query(`DELETE FROM payment_intent WHERE org_id = $1`, [org]);
    await query(`DELETE FROM meter_value WHERE session_id IN (SELECT id FROM charging_session WHERE org_id = $1)`, [org]);
    await query(`DELETE FROM cdr WHERE org_id = $1`, [org]);
    await query(`DELETE FROM charging_session WHERE org_id = $1`, [org]);
    await query(`DELETE FROM token WHERE org_id = $1`, [org]);
    await query(`DELETE FROM connector WHERE id = $1`, [conn]);
    await query(`DELETE FROM evse WHERE charge_point_id = $1`, [cp]);
    await query(`DELETE FROM charge_point WHERE id = $1`, [cp]);
    await query(`DELETE FROM site WHERE org_id = $1`, [org]);
    await query(`DELETE FROM alert WHERE org_id = $1`, [org]);
    await query(`DELETE FROM app_user WHERE org_id = $1`, [org]).catch(() => { /* audit rows keep them */ });
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => { /* audit rows keep it */ });
    await pool.end();
  });
}

describe('Grant, landlord and chargeback helpers', () => {
  test('release schedules; the month of a deal (higher of, rent-free, escalation, part month, margin, lease); masking', () => {
    assert.equal(grants.releaseIn([{ month: '2026-01', amount: 1000 }], 3, '2026-01'), 333);
    assert.equal(grants.releaseIn([{ month: '2026-01', amount: 1000 }], 3, '2026-03'), 334, 'the last month takes the rounding');
    assert.equal(grants.releaseIn([{ month: '2026-01', amount: 1000 }], 3, '2026-04'), 0);
    assert.equal(grants.releasedTo([{ month: '2026-01', amount: 1000 }, { month: '2026-02', amount: 300 }], 3, '2026-02'), 333 + 333 + 100);
    assert.equal(grants.releaseIn([{ month: '2026-01', amount: 1200 }], 12, '2026-03', '2026-02'), 0, 'stops after a clawback');
    const base: DealTerms = { basis: 'higher_of', fixed: 0, sharePct: 10, minimum: 500_000, escalationPct: 10, rentFreeMonths: 1, rechargePerKwh: 100, startOn: '2026-01-01', endOn: null, inLease: false };
    const f = (revenue: number, kwh = 0, energyCost: number | null = null, shareOf: 'revenue' | 'margin' = 'revenue') => ({ revenue, kwh, energyCost, shareOf });
    assert.deepEqual((({ share, topUp, recharge, total, rentFree }) => ({ share, topUp, recharge, total, rentFree }))(landlords.computeMonth(base, '2026-01', f(2_000_000, 20))), { share: 200_000, topUp: 0, recharge: 2_000, total: 202_000, rentFree: true });
    assert.equal(landlords.computeMonth(base, '2026-02', f(2_000_000)).topUp, 300_000, 'the minimum guarantee');
    assert.equal(landlords.computeMonth(base, '2027-02', f(0)).minimum, 550_000, 'escalated in the second year');
    assert.equal(landlords.computeMonth({ ...base, basis: 'fixed', fixed: 3_000_000, rentFreeMonths: 0, startOn: '2026-04-16' }, '2026-04', f(0)).fixed, 1_500_000, '15 of 30 days');
    assert.equal(landlords.computeMonth({ ...base, basis: 'fixed', fixed: 3_000_000, rentFreeMonths: 0, endOn: '2026-06-01' }, '2026-06', f(0)).fixed, 0, 'ended');
    assert.equal(landlords.computeMonth({ ...base, basis: 'share', rentFreeMonths: 0 }, '2026-03', f(1_000_000, 0, 400_000, 'margin')).share, 60_000, '10% of the margin');
    assert.equal(landlords.computeMonth({ ...base, basis: 'share', rentFreeMonths: 0 }, '2026-03', f(1_000_000, 0, null, 'margin')).marginUnknown, true);
    const lease = landlords.computeMonth({ ...base, basis: 'fixed_plus_share', fixed: 1_000_000, rentFreeMonths: 0, inLease: true, rechargePerKwh: 0 }, '2026-03', f(1_000_000));
    assert.deepEqual([lease.fixed, lease.share, lease.total, lease.inLease], [1_000_000, 100_000, 100_000, true], 'the fixed rent is in the lease');
    assert.equal(cbacks.mask('04A1B2C3D4'), '••••••C3D4');
    assert.equal(cbacks.mask('abc'), '••••');
  });
});

dbDescribe('Grants and incentives (v1.36.0)', () => {
  test('a capital grant deferred, released and clawed back; a per-kWh grant claimed and paid short; conditions', async () => {
    const m2 = monthsBack(2), m1 = monthsBack(1);
    const bank = (await call('POST', '/v1/finance/cash/accounts', { name: `Grant account ${TAG}`, kind: 'bank', currency: 'IDR', openingBalance: 0, openingOn: `${monthsBack(4)}-01` })).json();
    const std = (await call('POST', '/v1/finance/grants', { grantor: 'Kementerian ESDM', programme: `SPKLU standard ${TAG}`, kind: 'capital', currency: 'IDR', awarded: 120_000_000 })).json();
    assert.equal(std.releaseMonths, grants.DEFAULT_RELEASE_MONTHS, 'released over a charger\'s useful life by default');
    await call('PUT', `/v1/finance/grants/${std.id}`, { status: 'rejected' });
    assert.equal((await call('POST', '/v1/finance/grants', { grantor: 'Kementerian ESDM', programme: 'SPKLU', kind: 'capital', currency: 'IDR', awarded: 1, releaseMonths: 999 })).statusCode, 422);
    const g = (await call('POST', '/v1/finance/grants', { grantor: 'Kementerian ESDM', programme: `SPKLU build ${TAG}`, kind: 'capital', currency: 'IDR', awarded: 120_000_000, releaseMonths: 12, siteId: site, awardedOn: `${m2}-01` })).json();
    const due = localDay(Date.now() + 5 * 86_400_000);
    const withCond = (await call('POST', `/v1/finance/grants/${g.id}/conditions`, { description: 'Four chargers live and reporting', dueOn: due })).json();
    await grants.sweep();
    assert.equal((await many(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'finance.grant_condition_due' AND resolved_at IS NULL`, [org])).length, 1);
    assert.equal((await call('POST', `/v1/finance/grants/${g.id}/claims`, { amount: 130_000_000 })).statusCode, 422, 'more than awarded');
    let r = (await call('POST', `/v1/finance/grants/${g.id}/claims`, { amount: 60_000_000, submit: true })).json();
    const claim = r.claims[0];
    assert.match(claim.number, /^GC-\d{5}$/);
    assert.equal(claim.status, 'submitted');
    assert.equal((await call('POST', `/v1/finance/grants/claims/${claim.id}`, { status: 'submitted' })).statusCode, 409);
    r = (await call('POST', `/v1/finance/grants/claims/${claim.id}`, { status: 'paid', on: `${m2}-15`, cashAccountId: bank.id })).json();
    assert.equal(r.status, 'active');
    assert.equal(r.received, 60_000_000);
    assert.equal(r.toClaim, 60_000_000);
    const pos = (await call('GET', `/v1/finance/cash?date=${m1}-28`)).json();
    assert.equal(pos.accounts.find((a: any) => a.id === bank.id).balance, 60_000_000);
    assert.equal((await call('POST', `/v1/finance/grants/conditions/${withCond.conditions[0].id}`, { status: 'breached' })).statusCode, 422, 'a breach needs a note');
    await call('POST', `/v1/finance/grants/conditions/${withCond.conditions[0].id}`, { status: 'breached', note: 'Only two chargers by the date' });
    assert.equal((await many(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'finance.grant_condition_due' AND resolved_at IS NULL`, [org])).length, 0);
    assert.equal((await call('POST', `/v1/finance/grants/${g.id}/clawbacks`, { amount: 70_000_000, onDate: `${m1}-20` })).statusCode, 422, 'a note');
    assert.equal((await call('POST', `/v1/finance/grants/${g.id}/clawbacks`, { amount: 99_000_000, onDate: `${m1}-20`, note: 'x' })).statusCode, 422, 'more than received');
    r = (await call('POST', `/v1/finance/grants/${g.id}/clawbacks`, { amount: 52_000_000, onDate: `${m1}-20`, note: 'Two chargers short', conditionId: withCond.conditions[0].id })).json();
    await call('POST', `/v1/finance/ledger/sync/${m2}`);
    await call('POST', `/v1/finance/ledger/sync/${m1}`);
    const l2 = (await call('GET', `/v1/finance/ledger?month=${m2}&currency=IDR`)).json();
    assert.equal(l2.profitAndLoss.month.revenue.find((x: any) => x.code === '4400')?.amount, 5_000_000, 'a twelfth released');
    assert.equal(l2.balanceSheet.liabilities.find((x: any) => x.code === '2600')?.amount, 55_000_000);
    const l1 = (await call('GET', `/v1/finance/ledger?month=${m1}&currency=IDR`)).json();
    // Deferred before the clawback: 60M − 10M = 50M; the clawback takes it all, and 2M more as an expense.
    assert.equal(l1.balanceSheet.liabilities.find((x: any) => x.code === '2600')?.amount ?? 0, 0);
    assert.equal(l1.balanceSheet.liabilities.find((x: any) => x.code === '2610')?.amount, 52_000_000);
    assert.equal(Math.abs(l1.profitAndLoss.month.expense.find((x: any) => x.code === '6700')?.amount), 2_000_000);
    assert.equal(r.deferred, 0);

    // Per kWh: 1 000 a kWh charged at the site in m1 (40 kWh).
    await session(m1, 40_000, 120_000);
    const k = (await call('POST', '/v1/finance/grants', { grantor: 'PLN', programme: `Charging incentive ${TAG}`, kind: 'per_kwh', currency: 'IDR', awarded: 0, ratePerKwh: 1000, siteId: site })).json();
    r = (await call('POST', `/v1/finance/grants/${k.id}/claims`, { periodFrom: `${m1}-01`, periodTo: `${m1}-28`, submit: true })).json();
    const kc = r.claims[0];
    assert.deepEqual([kc.kwh, kc.amount], [40, 40_000]);
    await call('POST', `/v1/finance/grants/claims/${kc.id}`, { status: 'approved', on: `${m1}-25` });
    assert.equal((await call('POST', `/v1/finance/grants/claims/${kc.id}`, { status: 'paid', on: `${m1}-27`, paid: 50_000 })).statusCode, 422);
    await call('POST', `/v1/finance/grants/claims/${kc.id}`, { status: 'paid', on: `${m1}-27`, paid: 30_000, cashAccountId: bank.id });
    await call('POST', `/v1/finance/ledger/sync/${m1}`);
    const l1b = (await call('GET', `/v1/finance/ledger?month=${m1}&currency=IDR`)).json();
    assert.equal(l1b.profitAndLoss.month.revenue.find((x: any) => x.code === '4400')?.amount, 5_000_000 + 30_000, 'released plus the per-kWh claim, paid short');
    assert.equal(l1b.balanceSheet.assets.find((x: any) => x.code === '1350')?.amount ?? 0, 0);
    assert.equal((await call('GET', '/v1/finance/grants?format=xlsx')).rawPayload.subarray(0, 2).toString(), 'PK');
  });
});

dbDescribe('Landlord deals (v1.36.0)', () => {
  test('higher of a share and a minimum, rent-free, recharge; statements issued as bills; accruals; the worker', async () => {
    const m3 = monthsBack(3), m2 = monthsBack(2), m1 = monthsBack(1);
    await session(m2, 20_000, 2_000_000);
    await session(m1, 10_000, 6_000_000); // with the grant test's 40 kWh and 120 000: 50 kWh, 6 120 000
    const sup = (await call('POST', '/v1/finance/suppliers', { name: `PT Mall Landlord ${TAG}`, termsDays: 30 })).json();
    const deal = { siteId: site, supplierId: sup.id, currency: 'IDR', basis: 'higher_of', sharePct: 10, minimum: 500_000, rentFreeMonths: 1, rechargePerKwh: 100, startOn: `${m3}-01` };
    assert.equal((await call('POST', '/v1/finance/landlords', { ...deal, minimum: 0 })).statusCode, 422, 'higher_of needs a minimum');
    assert.equal((await call('POST', '/v1/finance/landlords', { ...deal, supplierId: '999999999' })).statusCode, 422);
    const d = (await call('POST', '/v1/finance/landlords', deal)).json();
    const ms = Object.fromEntries(d.months.map((x: any) => [x.month, x]));
    assert.deepEqual([ms[m3].rentFree, ms[m3].total], [true, 0]);
    assert.deepEqual([ms[m2].share, ms[m2].topUp, ms[m2].recharge, ms[m2].total], [200_000, 300_000, 2_000, 502_000]);
    assert.deepEqual([ms[m1].share, ms[m1].topUp, ms[m1].recharge, ms[m1].total], [612_000, 0, 5_000, 617_000]);
    assert.deepEqual(d.due, [m3, m2, m1]);

    assert.equal((await call('POST', `/v1/finance/landlords/${d.id}/statements`, { month: localDay().slice(0, 7) })).statusCode, 422, 'not ended');
    const st = (await call('POST', `/v1/finance/landlords/${d.id}/statements`, { month: m2 })).json();
    assert.match(st.number, /^LS-\d{5}$/);
    assert.equal(st.total, 502_000);
    assert.equal((await call('GET', `/v1/finance/landlords/statements/${st.id}?format=pdf`)).rawPayload.subarray(0, 4).toString(), '%PDF');
    const is = (await call('POST', `/v1/finance/landlords/statements/${st.id}/issue`)).json();
    assert.equal(is.status, 'issued');
    const bill = await one<any>(`SELECT * FROM supplier_bill WHERE id = $1`, [is.billId]);
    assert.deepEqual([bill.category, Number(bill.subtotal_minor), bill.number, bill.status], ['rent', 502_000, st.number, 'awaiting_approval']);
    assert.equal((await call('POST', `/v1/finance/landlords/statements/${st.id}/issue`)).statusCode, 409);
    assert.equal((await call('POST', `/v1/finance/landlords/statements/${st.id}/void`)).statusCode, 409, 'its bill is awaiting approval');
    assert.equal((await call('POST', `/v1/finance/landlords/${d.id}/statements`, { month: m2 })).statusCode, 409, 'issued');
    assert.equal((await call('PUT', `/v1/finance/landlords/${d.id}`, { sharePct: 12 })).statusCode, 409, 'terms fixed once issued');
    assert.equal((await call('PUT', `/v1/finance/landlords/${d.id}`, { reference: 'LEASE-7' })).json().reference, 'LEASE-7');

    // Accruals: m2's statement was billed this month, so m2 and m1 are accrued at their ends; m2's reversed in m1.
    await call('POST', `/v1/finance/ledger/sync/${m2}`);
    await call('POST', `/v1/finance/ledger/sync/${m1}`);
    const l1 = (await call('GET', `/v1/finance/ledger?month=${m1}&currency=IDR`)).json();
    assert.equal(l1.balanceSheet.liabilities.find((x: any) => x.code === '2420')?.amount, 617_000);
    assert.equal(Math.abs(l1.profitAndLoss.month.expense.find((x: any) => x.code === '6210')?.amount), 617_000 - 502_000);

    const n = await landlords.sweep();
    assert.ok(n >= 2);
    const o = (await call('GET', '/v1/finance/landlords')).json();
    assert.deepEqual(o.statements.filter((s: any) => s.dealId === d.id).map((s: any) => s.monthFrom).sort(), [m3, m2, m1].sort());
    assert.equal(o.deals.find((x: any) => x.id === d.id).unissued, 0);
    assert.equal((await call('GET', '/v1/finance/landlords?format=xlsx')).rawPayload.subarray(0, 2).toString(), 'PK');
  });
});

dbDescribe('Chargebacks and fraud (v1.36.0)', () => {
  test('recorded, deadlines, won and lost in the ledger; the evidence; fraud signals; a token blocked', async () => {
    const m1 = monthsBack(1);
    const s1 = (await one<{ id: string }>(`SELECT id FROM charging_session WHERE org_id = $1 ORDER BY started_at DESC LIMIT 1`, [org]))!.id;
    const at = new Date(`${m1}-12T12:00:00+07:00`);
    const p1 = await payment(s1, 150_000, { at });
    const p2 = await payment(s1, 80_000, { at, refunded: 80_000 });
    const pRef = (await one<{ provider_ref: string }>(`SELECT provider_ref FROM payment_intent WHERE id = $1`, [p1]))!.provider_ref;
    assert.equal((await call('POST', '/v1/finance/chargebacks', { paymentRef: pRef, provider: 'xendit', caseRef: 'X', reason: 'fraud', amount: 200_000 })).statusCode, 422, 'above what was captured');
    const c1 = (await call('POST', '/v1/finance/chargebacks', { paymentRef: pRef, provider: 'xendit', caseRef: `CB-${TAG}-1`, reason: 'fraud', reasonCode: '10.4', fee: 15_000, receivedOn: `${m1}-14` })).json();
    assert.deepEqual([c1.amount, c1.respondBy, c1.token?.slice(-4), c1.status], [150_000, `${m1}-21`, `${TAG}`.slice(-4), 'open']);
    assert.equal((await call('POST', '/v1/finance/chargebacks', { paymentRef: pRef, provider: 'xendit', caseRef: `CB-${TAG}-1`, reason: 'fraud', receivedOn: `${m1}-14` })).statusCode, 409);
    const c2 = (await call('POST', '/v1/finance/chargebacks', { paymentId: p2, provider: 'xendit', caseRef: `CB-${TAG}-2`, reason: 'not_received', receivedOn: `${m1}-15` })).json();
    assert.equal(c2.alsoRefunded, true);

    await cbacks.sweep();
    assert.equal((await many(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'finance.chargeback_due' AND resolved_at IS NULL AND severity = 'critical'`, [org])).length, 2, 'both deadlines passed');
    const ev = await call('GET', `/v1/finance/chargebacks/${c1.id}/evidence`);
    assert.equal(ev.rawPayload.subarray(0, 4).toString(), '%PDF');
    assert.equal((await call('POST', `/v1/finance/chargebacks/${c1.id}`, { status: 'won' })).statusCode, 409, 'no evidence yet');
    await call('POST', `/v1/finance/chargebacks/${c1.id}`, { status: 'evidence_submitted', on: `${m1}-16` });
    await call('POST', `/v1/finance/chargebacks/${c1.id}`, { status: 'lost', on: `${m1}-26` });
    await call('POST', `/v1/finance/chargebacks/${c2.id}`, { status: 'accepted', on: `${m1}-16`, note: 'Refunded already; accepted to save the fee' });
    assert.equal((await many(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'finance.chargeback_due' AND resolved_at IS NULL`, [org])).length, 0);
    await call('POST', `/v1/finance/ledger/sync/${m1}`);
    const led = (await call('GET', `/v1/finance/ledger?month=${m1}&currency=IDR`)).json();
    assert.equal(Math.abs(led.profitAndLoss.month.expense.find((x: any) => x.code === '6520')?.amount), 230_000);
    assert.equal(led.balanceSheet.assets.find((x: any) => x.code === '1190')?.amount ?? 0, 0, 'decided');
    const list = (await call('GET', '/v1/finance/chargebacks')).json();
    assert.equal(list.totals.IDR.lostAmount, 230_000);
    assert.equal(list.winRatePct, 0);

    // Card testing: five failed payments at one connector in a day.
    for (let i = 0; i < 5; i++) await payment(null, 10_000, { state: 'failed', at: new Date(`${m1}-18T02:0${i}:00+07:00`), connector: conn });
    const f = (await call('GET', '/v1/finance/chargebacks/fraud')).json();
    assert.equal(f.repeat[0].chargebacks, 2);
    assert.equal(f.repeat[0].tokenId, token);
    assert.equal(f.refundedAndChargedBack.length, 1);
    assert.equal(f.failedBursts[0].failed, 5);
    const card = f.rates.find((x: any) => x.method === 'card');
    assert.deepEqual([card.payments, card.chargebacks, card.overThreshold], [2, 2, true]);
    await cbacks.sweep();
    assert.equal((await many(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'finance.chargeback_rate' AND resolved_at IS NULL`, [org])).length, 1);
    assert.equal((await call('POST', `/v1/finance/chargebacks/tokens/${token}/block`, { reason: 'Two chargebacks' })).json().status, 'Blocked');
    assert.equal((await call('POST', `/v1/finance/chargebacks/tokens/${token}/block`, {})).statusCode, 409);
    assert.equal((await call('GET', '/v1/finance/chargebacks?format=xlsx')).rawPayload.subarray(0, 2).toString(), 'PK');
  });
});

dbDescribe('Board pack (v1.36.0)', () => {
  test('the risk, sustainability and grants sections; commentary; the trend; the slides', async () => {
    const m1 = monthsBack(1);
    const p = (await call('POST', '/v1/finance/report-packs', { month: m1, currency: 'IDR' })).json();
    const b = p.data.board;
    assert.ok(b.risk.chargebacks);
    assert.equal(b.risk.chargebacks.lostAmount, 230_000);
    assert.ok(b.risk.grants.breached >= 1);
    assert.equal(b.lenders, null);
    assert.ok(b.sustainability.mwh > 0);
    assert.equal(b.grants.repayable, 52_000_000);
    assert.equal((await call('PUT', `/v1/finance/report-packs/${p.id}/commentary`, { risk: 'Chargebacks above the scheme threshold; two chargers blocked.', grants: 'ESDM clawback agreed.' })).statusCode, 200);
    assert.equal((await call('PUT', `/v1/finance/report-packs/${p.id}/commentary`, { nonsense: 'x' })).statusCode, 422);
    const list = (await call('GET', '/v1/finance/report-packs')).json();
    assert.equal(list.trend.at(-1).month, m1);
    const sl = await call('GET', `/v1/finance/report-packs/${p.id}?format=slides`);
    assert.equal(sl.headers['content-type'], 'application/pdf');
    assert.equal(sl.rawPayload.subarray(0, 4).toString(), '%PDF');
    assert.match(sl.rawPayload.toString('latin1'), /MediaBox \[0 0 960 540\]/);
    assert.equal((await call('GET', `/v1/finance/report-packs/${p.id}?format=pdf`)).rawPayload.subarray(0, 4).toString(), '%PDF');
    assert.equal((await call('GET', `/v1/finance/report-packs/${p.id}?format=xlsx`)).rawPayload.subarray(0, 2).toString(), 'PK');
    void as;
  });
});
