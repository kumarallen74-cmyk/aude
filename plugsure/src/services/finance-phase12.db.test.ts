import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { dueDate } from './tax-calendar.js';
import { split } from './shared-costs.js';

/**
 * Phase 12 of the finance review (v1.23.0):
 *   - the tax calendar: due dates (the day of the following month, clamped, a weekend moved to Monday); the amounts
 *     PlugSure knows; marking filed (once), voiding; reminders raised for overdue obligations and cleared when filed;
 *   - owner queries: raised on a finalised statement, answered with an adjustment that the owner's next statement
 *     adds to its share (and only that one); rejected; withdrawn;
 *   - shared costs: the split adds up; allocated by kWh / equally to chosen sites; the site P&L; a locked month;
 *   - settlement tracking: late, settled and upcoming days; withdrawals in the bank, short, missing, awaiting.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase12.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const taxCal = await import('./tax-calendar.js');
const disputes = await import('./owner-disputes.js');
const commission = await import('./commission.js');
const settle = await import('./settlement-tracking.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID();
let org = '', siteA = '', siteB = '', owner = '', integ = '';
let app: FastifyInstance;
let perms = ['payment:read', 'payment:write'];

const ym = (offset: number) => {
  const cur = new Intl.DateTimeFormat('en-CA', { timeZone: config.billing.timeZone }).format(new Date()).slice(0, 7);
  const [y, m] = cur.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + offset;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: config.billing.timeZone }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });

if (DB_OK) {
  before(async () => {
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`P12 ${TAG}`, `p12-${TAG}`]))!.id;
    await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, 'Rina')`, [A, org, `${A.slice(0, 8)}@p12.test`]);
    siteA = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'ID') RETURNING id`, [org, `A Jakarta ${TAG}`]))!.id;
    siteB = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'ID') RETURNING id`, [org, `B Bogor ${TAG}`]))!.id;
    // Sessions last month: A 300 kWh / Rp 900 000 (3 sessions), B 100 kWh / Rp 300 000 (1 session).
    const cp = async (s: string, id: string) => {
      const c = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name) VALUES ($1, $2, $2) RETURNING id`, [s, id]))!.id;
      const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [c]))!.id;
      return { c, k: (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, max_power_w) VALUES ($1, 60000) RETURNING id`, [e]))!.id };
    };
    const a = await cp(siteA, `P12A-${TAG}`), b = await cp(siteB, `P12B-${TAG}`);
    const sess = async (site: string, x: { c: string; k: string }, wh: number, sub: number) => {
      const id = (await one<{ id: string }>(
        `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, ended_at, energy_wh, state)
         VALUES ($1, $2, $3, $4, $5, $6, $6::timestamptz + interval '1 hour', $7, 'rated') RETURNING id`, [org, site, x.k, x.c, `p12-${TAG}-${randomUUID()}`, `${ym(-1)}-10T05:00:00Z`, wh]))!.id;
      await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency)
                   VALUES ($1, $2, $3, '[]'::jsonb, $4, 0, 0, 0, 0, 0, $4, '{}'::jsonb, 'IDR')`, [id, org, `${ym(-1)}-10T05:00:00Z`, sub]);
    };
    for (let i = 0; i < 3; i++) await sess(siteA, a, 100_000, 300_000);
    await sess(siteB, b, 100_000, 300_000);
    await query(`INSERT INTO site_energy_rate (site_id, org_id, rate_per_kwh, currency) VALUES ($1, $2, 1000, 'IDR'), ($3, $2, 1000, 'IDR')`, [siteA, org, siteB]);
    owner = (await one<{ id: string }>(`INSERT INTO site_owner (org_id, name) VALUES ($1, $2) RETURNING id`, [org, `Hotel ${TAG}`]))!.id;
    integ = (await one<{ id: string }>(`INSERT INTO integration (org_id, kind, provider) VALUES ($1, 'payments', 'xendit') RETURNING id`, [org]))!.id;
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: A, orgId: org, assignments: [{ permissions: perms, scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
  });
  after(async () => {
    await app?.close();
    await query(`DELETE FROM owner_statement_adjustment WHERE org_id = $1`, [org]);
    await query(`DELETE FROM owner_statement_dispute WHERE org_id = $1`, [org]);
    for (const t of ['tax_filing', 'finance_shared_cost', 'finance_period_lock', 'tax_withholding', 'finance_org_settings', 'site_energy_rate']) await query(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
    await query(`DELETE FROM bank_statement_line WHERE org_id = $1`, [org]);
    await query(`DELETE FROM bank_statement WHERE org_id = $1`, [org]);
    await query(`DELETE FROM gateway_transaction WHERE integration_id = $1`, [integ]);
    await query(`DELETE FROM integration WHERE id = $1`, [integ]);
    await query(`DELETE FROM fleet_invoice WHERE org_id = $1`, [org]);
    await query(`DELETE FROM fleet_account WHERE org_id = $1`, [org]);
    await query(`DELETE FROM commission_statement WHERE org_id = $1`, [org]);
    await query(`DELETE FROM site_owner WHERE org_id = $1`, [org]);
    await query(`DELETE FROM cdr WHERE org_id = $1`, [org]);
    await query(`DELETE FROM charging_session WHERE org_id = $1`, [org]);
    await query(`DELETE FROM connector WHERE evse_uuid IN (SELECT e.id FROM evse e JOIN charge_point c ON c.id = e.charge_point_id JOIN site st ON st.id = c.site_id WHERE st.org_id = $1)`, [org]);
    await query(`DELETE FROM evse WHERE charge_point_id IN (SELECT c.id FROM charge_point c JOIN site st ON st.id = c.site_id WHERE st.org_id = $1)`, [org]);
    await query(`DELETE FROM charge_point WHERE site_id IN (SELECT id FROM site WHERE org_id = $1)`, [org]);
    await query(`DELETE FROM site WHERE org_id = $1`, [org]);
    await query(`DELETE FROM alert WHERE org_id = $1`, [org]);
    await query(`DELETE FROM app_user WHERE org_id = $1`, [org]).catch(() => { /* audit rows keep them */ });
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => { /* audit rows keep it */ });
    await pool.end();
  });
}

describe('Tax due dates and the cost split', () => {
  test('the day of the following month, clamped to its last day, a weekend moved to Monday', () => {
    assert.equal(dueDate('2026-09', 15), '2026-10-15', 'a Thursday');
    assert.equal(dueDate('2026-09', 31), '2026-11-02', '31 October 2026 is a Saturday');
    assert.equal(dueDate('2027-01', 31), '2027-03-01', 'February has 28 days; the 28th is a Sunday');
    assert.equal(dueDate('2026-10', 20), '2026-11-20');
  });
  test('the parts add up to the cost; equal when nothing to weigh by', () => {
    assert.deepEqual(split(1000, [3, 1]), [750, 250]);
    assert.deepEqual(split(100, [1, 1, 1]), [34, 33, 33]);
    assert.deepEqual(split(10, [0, 0]), [5, 5]);
    const p = split(999_999, [7, 13, 0, 2]);
    assert.equal(p.reduce((a, x) => a + x, 0), 999_999);
    assert.equal(p[2], 0);
  });
});

dbDescribe('The tax calendar', () => {
  test('amounts, filing once, voiding; reminders for what is overdue, cleared when filed', async () => {
    const P = ym(-2);
    await query(`INSERT INTO tax_withholding (org_id, kind, period, counterparty, base_minor, rate_bps, amount_minor) VALUES ($1, 'gateway_fee', $2, 'Xendit', 1000000, 200, 20000)`, [org, P]);
    const fa = (await one<{ id: string }>(`INSERT INTO fleet_account (org_id, name) VALUES ($1, $2) RETURNING id`, [org, `Fleet ${TAG}`]))!.id;
    await query(
      `INSERT INTO fleet_invoice (org_id, fleet_account_id, period, number, status, issued_at, due_date, sessions, energy_wh, subtotal_minor, local_tax_minor, taxable_minor, tax_base_minor, tax_minor,
                                  own_total_minor, roaming_total_minor, total_minor, data, currency)
       VALUES ($1, $2, $3, $4, 'issued', $5, $6, 1, 1000, 1000000, 0, 1000000, 916667, 110000, 1110000, 0, 1110000, '{}'::jsonb, 'IDR')`,
      [org, fa, `${P}-01`, `TX-${TAG}`, `${P}-20T03:00:00Z`, `${P}-28`]);
    assert.equal((await call('PUT', '/v1/finance/tax/calendar/settings', { obligations: { pph23_pay: { day: 0 } } })).statusCode, 422);
    // Due on the 1st of the month after P (≤ today, whatever today is): overdue.
    const s = await call('PUT', '/v1/finance/tax/calendar/settings', { obligations: { pph23_pay: { day: 1 }, efaktur: { enabled: false } }, reminders: true });
    assert.equal(s.statusCode, 200, s.body);
    const cal = (await call('GET', '/v1/finance/tax/calendar')).json();
    const it = (k: string) => cal.items.find((x: any) => x.obligation === k && x.period === P);
    assert.equal(it('pph23_pay').amount, 20000);
    assert.equal(it('ppn_pay').amount, 110000, 'PPN on the fleet invoice');
    assert.equal(it('efaktur'), undefined, 'disabled');
    assert.ok(['overdue', 'due_soon'].includes(it('pph23_pay').status));

    assert.ok(await taxCal.remind() >= 1);
    const al = await one<any>(`SELECT * FROM alert WHERE org_id = $1 AND kind = 'finance.tax_due' AND target_id = $2 AND resolved_at IS NULL`, [org, `pph23_pay:${P}`]);
    assert.ok(al, 'a reminder');
    assert.equal((await call('POST', '/v1/finance/tax/filings', { obligation: 'pph23_pay', period: P, filedOn: addDays(today(), 1), reference: 'NTPN X' })).statusCode, 422, 'not in the future');
    const f = await call('POST', '/v1/finance/tax/filings', { obligation: 'pph23_pay', period: P, filedOn: today(), reference: 'NTPN 0A1B2C3D', amount: 20000 });
    assert.equal(f.statusCode, 201, f.body);
    assert.equal((await call('POST', '/v1/finance/tax/filings', { obligation: 'pph23_pay', period: P, filedOn: today(), reference: 'NTPN again' })).statusCode, 409, 'once');
    assert.ok((await one<any>(`SELECT resolved_at FROM alert WHERE id = $1`, [al.id]))!.resolved_at, 'cleared when filed');
    const after1 = (await call('GET', '/v1/finance/tax/calendar')).json().items.find((x: any) => x.obligation === 'pph23_pay' && x.period === P);
    assert.deepEqual({ st: after1.status, ref: after1.filing.reference, by: after1.filing.by }, { st: 'filed', ref: 'NTPN 0A1B2C3D', by: 'Rina' });
    assert.equal((await call('POST', `/v1/finance/tax/filings/${f.json().id}/void`, { reason: 'Wrong NTPN' })).statusCode, 200);
    assert.notEqual((await call('GET', '/v1/finance/tax/calendar')).json().items.find((x: any) => x.obligation === 'pph23_pay' && x.period === P).status, 'filed');
  });
});

dbDescribe('Owner queries', () => {
  test('an adjustment is added to the next statement finalised, once; a rejection; a withdrawal', async () => {
    const st = (await one<{ id: string }>(
      `INSERT INTO commission_statement (org_id, owner_id, period, number, gtv_minor, commission_minor, minimum_topup_minor, private_fee_minor, mdr_credit_minor,
                                         net_minor, tax_minor, total_minor, owner_share_minor, data, finalised_at, currency)
       VALUES ($1, $2, $3, $4, 1000000, 100000, 0, 0, 0, 100000, 11000, 111000, 800000, $5::jsonb, now(), 'IDR') RETURNING id`,
      [org, owner, `${ym(-3)}-01`, `Q-${TAG}`, JSON.stringify({ sites: [{ name: 'Lobby' }, { name: 'Basement' }] })]))!.id;
    const mine = await disputes.forOwner(org, owner);
    assert.deepEqual(mine.statements[0]!.lines, ['Lobby', 'Basement']);
    await assert.rejects(disputes.raise(org, owner, { statementId: st, message: 'short' }, null), /10 to 2000/);
    const other = (await one<{ id: string }>(`INSERT INTO site_owner (org_id, name) VALUES ($1, $2) RETURNING id`, [org, `Other ${TAG}`]))!.id;
    await assert.rejects(disputes.raise(org, other, { statementId: st, message: 'Not my statement at all, surely.' }, null), /No such statement/);
    const q1 = await disputes.raise(org, owner, { statementId: st, line: 'Lobby', message: 'Two sessions on the 12th are missing from the lobby.', claimed: 185000 }, null);
    const q2 = await disputes.raise(org, owner, { statementId: st, message: 'The minimum top-up looks wrong to me.' }, null);
    const q3 = await disputes.raise(org, owner, { statementId: st, message: 'Please resend the statement as PDF.' }, null);
    assert.ok(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'finance.owner_dispute' AND target_id = $2 AND resolved_at IS NULL`, [org, q1.id]), 'the operator is alerted');

    const list = (await call('GET', '/v1/finance/owner-queries')).json();
    assert.equal(list.open, 3);
    assert.equal((await call('POST', `/v1/finance/owner-queries/${q1.id}/answer`, { decision: 'adjust', answer: 'Added two sessions.', amount: 0 })).statusCode, 422);
    const a = await call('POST', `/v1/finance/owner-queries/${q1.id}/answer`, { decision: 'adjust', answer: 'Two sessions were missed: added to your next statement.', amount: 185000 });
    assert.equal(a.statusCode, 200, a.body);
    assert.equal((await call('POST', `/v1/finance/owner-queries/${q1.id}/answer`, { decision: 'reject', answer: 'Again' })).statusCode, 409);
    assert.equal((await call('POST', `/v1/finance/owner-queries/${q2.id}/answer`, { decision: 'reject', answer: 'The minimum applies to the DC charger from its first full month.' })).json().state, 'rejected');
    assert.deepEqual(await disputes.withdraw(org, owner, q3.id), { ok: true });
    assert.equal((await call('GET', '/v1/finance/owner-queries')).json().pendingAdjustments[0].amount, 185000);
    assert.ok((await one<any>(`SELECT resolved_at FROM alert WHERE org_id = $1 AND kind = 'finance.owner_dispute' AND target_id = $2`, [org, q1.id]))!.resolved_at);

    // The next statement (last month) carries it in the owner's share; the one after does not.
    const draft = await commission.draftStatement(org, ym(-1), owner, 'IDR');
    assert.equal(draft.adjustments.length, 1);
    assert.equal(draft.totals.ownerShareMinor, 185000, 'no sites: the share is the adjustment');
    assert.match(commission.statementHtml({ ...draft, owner: { name: 'Hotel' }, issuer: { name: 'Op' }, billTo: { name: 'Hotel' }, org: { name: 'Op' } }), /Adjustment: Query on statement Q-/);
    const fin = await commission.finalise(org, ym(-1), null, owner, 'IDR');
    assert.ok('number' in fin, JSON.stringify(fin));
    const row = await one<any>(`SELECT owner_share_minor, data FROM commission_statement WHERE org_id = $1 AND owner_id = $2 AND period = $3::date`, [org, owner, `${ym(-1)}-01`]);
    assert.equal(Number(row.owner_share_minor), 185000);
    assert.equal(row.data.adjustments.length, 1);
    assert.equal((await commission.draftStatement(org, ym(0), owner, 'IDR')).adjustments.length, 0, 'applied once');
    const view = (await disputes.forOwner(org, owner)).disputes.find((d) => d.id === q1.id)!;
    assert.deepEqual({ st: view.state, adj: view.adjustment?.amount, to: view.adjustment?.appliedTo }, { st: 'adjusted', adj: 185000, to: (fin as any).number });
  });
});

dbDescribe('Shared costs and the site P&L', () => {
  test('allocated by kWh and equally to chosen sites; P&L; ending and voiding around a locked month', async () => {
    const M = ym(-1);
    assert.equal((await call('POST', '/v1/finance/shared-costs', { category: 'rent', description: 'x', amount: 1, monthFrom: M })).statusCode, 422);
    const c1 = await call('POST', '/v1/finance/shared-costs', { category: 'maintenance', description: 'Service contract', amount: 400_000, basis: 'kwh', monthFrom: ym(-3) });
    assert.equal(c1.statusCode, 201, c1.body);
    const c2 = (await call('POST', '/v1/finance/shared-costs', { category: 'connectivity', description: 'SIM cards', amount: 100_001, basis: 'equal', siteIds: [siteA, siteB], monthFrom: M, monthTo: M })).json();
    const c3 = (await call('POST', '/v1/finance/shared-costs', { category: 'rent', description: 'Car park B only', amount: 50_000, basis: 'sessions', siteIds: [siteB], monthFrom: M })).json();
    const p = (await call('GET', `/v1/finance/site-pnl?month=${M}`)).json();
    assert.equal((await call('GET', '/v1/finance/site-pnl')).json().month, M, 'last month by default');
    assert.equal((await call('GET', '/v1/finance/site-pnl?month=2026-13')).statusCode, 422);
    const A_ = p.sites.find((s: any) => s.siteId === siteA), B_ = p.sites.find((s: any) => s.siteId === siteB);
    assert.deepEqual([A_.shared.maintenance, B_.shared.maintenance], [300_000, 100_000], '300 kWh against 100');
    assert.deepEqual([A_.shared.connectivity + B_.shared.connectivity, B_.shared.rent, A_.shared.rent], [100_001, 50_000, 0]);
    // A: Rp 900 000 revenue − 300 kWh × Rp 1 000 − shared (300 000 + 50 001 or 50 000).
    assert.equal(A_.contribution, 900_000 - 300_000 - A_.sharedTotal);
    assert.equal(p.totals.IDR.shared, 550_001);
    assert.equal(p.totals.IDR.contribution, 1_200_000 - 400_000 - 550_001);
    assert.equal((await call('GET', `/v1/finance/site-pnl?month=${ym(0)}`)).json().totals.IDR.shared, 400_000 + 50_000, 'the SIM cards ended');

    // Lock last month: the contract cannot be voided or ended before it; it can be ended after.
    await query(`INSERT INTO finance_period_lock (org_id, month) VALUES ($1, $2)`, [org, M]);
    assert.equal((await call('POST', `/v1/finance/shared-costs/${c1.json().id}/void`, { reason: 'Wrong' })).statusCode, 409);
    assert.equal((await call('POST', `/v1/finance/shared-costs/${c1.json().id}/end`, { monthTo: ym(-2) })).statusCode, 409);
    assert.equal((await call('POST', `/v1/finance/shared-costs/${c1.json().id}/end`, { monthTo: M })).statusCode, 200);
    assert.equal((await call('POST', '/v1/finance/shared-costs', { category: 'insurance', description: 'Policy', amount: 10_000, monthFrom: M })).statusCode, 409);
    assert.equal((await call('POST', `/v1/finance/shared-costs/${c2.id}/void`, { reason: 'Entered twice' })).statusCode, 409, 'counts in the locked month');
    await query(`UPDATE finance_period_lock SET reopened_at = now(), reopen_reason = 'test' WHERE org_id = $1`, [org]);
    assert.equal((await call('POST', `/v1/finance/shared-costs/${c3.id}/void`, { reason: 'Entered twice' })).statusCode, 200);
    const costs = (await call('GET', '/v1/finance/shared-costs')).json().costs;
    assert.equal(costs.find((x: any) => x.id === c1.json().id).monthTo, M);
    assert.equal(costs.find((x: any) => x.id === c3.id).voided, true);
  });
});

dbDescribe('Settlement tracking', () => {
  test('late, settled and upcoming days; withdrawals in the bank, short, missing and awaiting the statement', async () => {
    const t = today();
    const g = (ext: string, kind: string, amount: number, net: number, est: string | null, status: string | null, created: string) => one<{ id: string }>(
      `INSERT INTO gateway_transaction (integration_id, org_id, provider, external_id, kind, status, cashflow, currency, amount, fee, vat, withholding_tax, net_amount,
                                        settlement_status, estimated_settlement_at, gateway_created_at, gateway_updated_at)
       VALUES ($1, $2, 'xendit', $3, $4, 'success', $5, 'IDR', $6, 0, 0, 0, $7, $8, $9, $10, $10) RETURNING id::text`,
      [integ, org, `${ext}-${TAG}`, kind, kind === 'payout' ? 'out' : 'in', amount, net, status, est ? `${est}T05:00:00Z` : null, `${created}T05:00:00Z`]).then((r) => r!.id);
    await g('late1', 'payment', 100_000, 99_000, addDays(t, -6), 'pending', addDays(t, -8));
    await g('late2', 'payment', 50_000, 49_500, addDays(t, -6), 'settled', addDays(t, -8));
    await g('ok', 'payment', 20_000, 19_800, addDays(t, -10), 'settled', addDays(t, -12));
    await g('soon', 'payment', 30_000, 29_700, addDays(t, 2), 'pending', t);
    const wIn = await g('w-in', 'payout', 200_000, 200_000, null, null, addDays(t, -9));
    const wShort = await g('w-short', 'payout', 150_000, 150_000, null, null, addDays(t, -8));
    await g('w-miss', 'payout', 70_000, 70_000, null, null, addDays(t, -7));
    await g('w-new', 'payout', 60_000, 60_000, null, null, addDays(t, -1));
    const bs = (await one<{ id: string }>(`INSERT INTO bank_statement (org_id, bank, filename) VALUES ($1, 'BCA', 'x.csv') RETURNING id`, [org]))!.id;
    const line = (no: number, d: string, amount: number, kind: string | null, ref: string | null) => query(
      `INSERT INTO bank_statement_line (statement_id, org_id, line_no, line_date, description, amount_minor, fingerprint, matched_kind, matched_ref) VALUES ($1, $2, $3, $4, 'line', $5, $6, $7, $8)`,
      [bs, org, no, d, amount, `${TAG}-${no}`, kind, ref]);
    await line(1, addDays(t, -9), 200_000, 'gateway_withdrawal', wIn);
    await line(2, addDays(t, -8), 149_000, 'gateway_withdrawal', wShort);
    await line(3, addDays(t, -2), 5_000, null, null);

    const v = await settle.overview({ id: integ, orgId: org }, org);
    const day = (d: string) => v.settlements.find((s) => s.day === d)!;
    assert.deepEqual((({ state, expected, settled, pending }) => ({ state, expected, settled, pending }))(day(addDays(t, -6))), { state: 'late', expected: 148_500, settled: 49_500, pending: 99_000 });
    assert.equal(day(addDays(t, -10)).state, 'settled');
    assert.equal(day(addDays(t, 2)).state, 'upcoming');
    const w = Object.fromEntries(v.withdrawals.map((x) => [x.reference, x]));
    assert.equal(w[`w-in-${TAG}`].state, 'in_bank');
    assert.deepEqual({ s: w[`w-short-${TAG}`].state, by: w[`w-short-${TAG}`].shortBy }, { s: 'short', by: 1_000 });
    assert.equal(w[`w-miss-${TAG}`].state, 'missing', 'statements cover the days after it');
    assert.equal(w[`w-new-${TAG}`].state, 'awaiting_statement');
    assert.deepEqual(v.summary.late, { days: 1, amount: { IDR: 99_000 } });

    assert.equal((await call('PUT', '/v1/finance/settlement-tracking/settings', { graceDays: 30 })).statusCode, 422);
    assert.equal((await call('PUT', '/v1/finance/settlement-tracking/settings', { graceDays: 7 })).statusCode, 200);
    assert.equal((await settle.overview({ id: integ, orgId: org }, org)).summary.late.days, 0, 'within 7 days of grace');
    await call('PUT', '/v1/finance/settlement-tracking/settings', { graceDays: 2 });
    await settle.check();
    const alerts = await many<any>(`SELECT kind FROM alert WHERE org_id = $1 AND target_id = $2 AND resolved_at IS NULL ORDER BY kind`, [org, integ]);
    assert.deepEqual(alerts.map((a) => a.kind), ['finance.settlement_late', 'finance.withdrawal_missing']);
    await query(`UPDATE gateway_transaction SET settlement_status = 'settled' WHERE integration_id = $1 AND kind = 'payment'`, [integ]);
    await settle.check();
    assert.deepEqual((await many<any>(`SELECT kind FROM alert WHERE org_id = $1 AND target_id = $2 AND resolved_at IS NULL`, [org, integ])).map((a) => a.kind), ['finance.withdrawal_missing']);
  });
});
