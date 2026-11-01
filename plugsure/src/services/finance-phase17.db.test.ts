import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 17 of the finance review (v1.28.0):
 *   - driver funds: in use, unused (owed), refund due, breakage candidates past the breakage days; recognising a
 *     month's breakage once; the month's movement;
 *   - group consolidation: a parent and a subsidiary added up, an elimination recorded and voided, the suggestion
 *     from a fleet invoice to another group entity, an organisation without subsidiaries answered plainly;
 *   - rolling forecast: the trend and seasonality helpers, a site's forecast with the scenario, below budget → alert;
 *   - payment plans: agreed on an overdue invoice, paid in parts (the invoice paid at the end), a late plan defaulted;
 *     the provision by age bucket (a plan in good standing counts as current), recorded with its movement.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase17.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const rolling = await import('./rolling-forecast.js');
const plans = await import('./payment-plans.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID();
let parent = '', child = '', lone = '', siteP = '', siteC = '', cpP = '', cpC = '', connP = '', connC = '';
let app: FastifyInstance;
let principalOrg = '';
const zone = config.billing.timeZone;
const localDay = (t: number = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(t));
const monthsBack = (n: number) => {
  let [y, m] = localDay().slice(0, 7).split('-').map(Number) as [number, number];
  for (let i = 0; i < n; i++) { m--; if (m === 0) { m = 12; y--; } }
  return `${y}-${String(m).padStart(2, '0')}`;
};
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });

async function siteFor(org: string, name: string) {
  const site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'ID') RETURNING id`, [org, `${name} ${TAG}`]))!.id;
  const cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name) VALUES ($1, $2, $2) RETURNING id`, [site, `P17-${name}-${TAG}`]))!.id;
  const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [cp]))!.id;
  const conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, max_power_w) VALUES ($1, 60000) RETURNING id`, [e]))!.id;
  return { site, cp, conn };
}

/** A session with a charge record ending at `end` (or still running when null), optionally paid by a payment. */
async function session(org: string, s: { site: string; cp: string; conn: string }, end: Date | null, minor: number, pi: string | null = null, wh = 20_000) {
  const start = new Date((end ?? new Date()).getTime() - 3_600_000);
  const id = (await one<{ id: string }>(
    `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, ended_at, energy_wh, state, payment_intent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`, [org, s.site, s.conn, s.cp, `p17-${randomUUID()}`, start, end, wh, end ? 'rated' : 'active', pi]))!.id;
  if (end) await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency)
                        VALUES ($1, $2, $3, '[]', $4, 0, 0, $4, 0, 0, $4, '{}', 'IDR')`, [id, org, end, minor]);
  return id;
}

async function payment(org: string, captured: number, daysAgo: number, extra: { due?: number } = {}) {
  return (await one<{ id: string }>(
    `INSERT INTO payment_intent (org_id, provider, method, mode, state, amount_captured_minor, amount_authorised_minor, currency, paid_at, created_at, channel, refund_state, refund_due_minor)
     VALUES ($1, 'xendit', 'qris', 'prepurchase', 'captured', $2, $2, 'IDR', now() - make_interval(days => $3), now() - make_interval(days => $3), 'QRIS', $4, $5) RETURNING id`,
    [org, captured, daysAgo, extra.due ? 'due' : null, extra.due ?? null]))!.id;
}

async function fleetInvoice(org: string, accountName: string, total: number, dueDaysAgo: number, taxId: string | null = null, period = monthsBack(1)) {
  const acct = (await one<{ id: string }>(`INSERT INTO fleet_account (org_id, name, billing_email, tax_id, tax_id_kind) VALUES ($1, $2, 'ap@fleet.test', $3, $4) RETURNING id`,
    [org, `${accountName} ${TAG}`, taxId, 'TIN']))!.id;
  const id = (await one<{ id: string }>(
    `INSERT INTO fleet_invoice (org_id, fleet_account_id, period, number, status, issued_at, due_date, sessions, energy_wh, subtotal_minor, local_tax_minor, taxable_minor, tax_base_minor, tax_minor,
                                own_total_minor, roaming_total_minor, total_minor, data, currency)
     VALUES ($1, $2, $3::date, $4, 'issued', now() - make_interval(days => $5 + 14), current_date - $5, 1, 1000, $6, 0, $6, $6, 0, $6, 0, $6, '{}', 'IDR') RETURNING id`,
    [org, acct, `${period}-01`, `FI17-${accountName}-${TAG}`, dueDaysAgo, total]))!.id;
  return { acct, id };
}

if (DB_OK) {
  before(async () => {
    parent = (await one<{ id: string }>(`INSERT INTO organisation (name, slug, npwp) VALUES ($1, $2, '0111111111111111') RETURNING id`, [`Group ${TAG}`, `p17-g-${TAG}`]))!.id;
    child = (await one<{ id: string }>(`INSERT INTO organisation (name, slug, parent_org_id) VALUES ($1, $2, $3) RETURNING id`, [`Subsidiary ${TAG}`, `p17-c-${TAG}`, parent]))!.id;
    lone = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Lone ${TAG}`, `p17-l-${TAG}`]))!.id;
    await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, 'Rina')`, [A, parent, `${A.slice(0, 8)}@p17.test`]);
    ({ site: siteP, cp: cpP, conn: connP } = await siteFor(parent, 'Jakarta'));
    ({ site: siteC, cp: cpC, conn: connC } = await siteFor(child, 'Surabaya'));
    principalOrg = parent;
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: A, orgId: principalOrg, assignments: [{ permissions: ['payment:read', 'payment:write', 'invoice:read', 'invoice:write', 'finance:approve'], scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
  });
  after(async () => {
    await app?.close();
    const orgs = [parent, child, lone];
    for (const t of ['payment_plan_instalment', 'payment_plan', 'bad_debt_provision', 'consolidation_elimination', 'driver_funds_breakage', 'finance_budget', 'finance_org_settings', 'receivable_note', 'dunning_reminder']) await query(`DELETE FROM ${t} WHERE org_id = ANY($1::uuid[])`, [orgs]);
    await query(`DELETE FROM fleet_invoice WHERE org_id = ANY($1::uuid[])`, [orgs]);
    await query(`DELETE FROM fleet_account WHERE org_id = ANY($1::uuid[])`, [orgs]);
    await query(`DELETE FROM cdr WHERE org_id = ANY($1::uuid[])`, [orgs]);
    await query(`DELETE FROM charging_session WHERE org_id = ANY($1::uuid[])`, [orgs]);
    await query(`DELETE FROM payment_intent WHERE org_id = ANY($1::uuid[])`, [orgs]);
    for (const c of [connP, connC]) await query(`DELETE FROM connector WHERE id = $1`, [c]);
    for (const c of [cpP, cpC]) { await query(`DELETE FROM evse WHERE charge_point_id = $1`, [c]); await query(`DELETE FROM charge_point WHERE id = $1`, [c]); }
    await query(`DELETE FROM site WHERE org_id = ANY($1::uuid[])`, [orgs]);
    await query(`DELETE FROM alert WHERE org_id = ANY($1::uuid[])`, [orgs]);
    await query(`DELETE FROM app_user WHERE org_id = $1`, [parent]).catch(() => { /* audit rows keep them */ });
    for (const o of [child, lone, parent]) await query(`DELETE FROM organisation WHERE id = $1`, [o]).catch(() => { /* audit rows keep it */ });
    await pool.end();
  });
}

describe('Forecast helpers', () => {
  test('a least-squares line; seasonal indexes from 13 months or more', () => {
    assert.deepEqual(rolling.fit([10, 20, 30, 40]), { a: 10, b: 10 });
    assert.deepEqual(rolling.fit([5]), { a: 5, b: 0 });
    const flat = rolling.seasonality([{ month: '2026-01', revenue: 100 }]);
    assert.equal(flat[1], 1, 'too short: no seasonality');
    const h = Array.from({ length: 24 }, (_, i) => { const m = (i % 12) + 1; return { month: `${2025 + Math.floor(i / 12)}-${String(m).padStart(2, '0')}`, revenue: m === 12 ? 200 : 100 }; });
    const s = rolling.seasonality(h);
    assert.ok(s[12]! > 1.8 && s[1]! < 1, 'December above, the rest below the average');
  });
});

dbDescribe('Driver funds', () => {
  test('in use, unused, refund due, breakage; recognised once; the movement', async () => {
    principalOrg = parent;
    // Paid 200 days ago, used 60 000 of 100 000: 40 000 unused, past the 180 days.
    const old = await payment(parent, 100_000, 200);
    await session(parent, { site: siteP, cp: cpP, conn: connP }, new Date(Date.now() - 200 * 86_400_000 + 7_200_000), 60_000, old);
    // Recent, fully used.
    const used = await payment(parent, 50_000, 3);
    await session(parent, { site: siteP, cp: cpP, conn: connP }, new Date(Date.now() - 3 * 86_400_000 + 7_200_000), 50_000, used);
    // Recent, 70 000 used of 100 000: 30 000 unused (not yet breakage).
    const recent = await payment(parent, 100_000, 10);
    await session(parent, { site: siteP, cp: cpP, conn: connP }, new Date(Date.now() - 10 * 86_400_000 + 7_200_000), 70_000, recent);
    // Charging now.
    const live = await payment(parent, 80_000, 0);
    await session(parent, { site: siteP, cp: cpP, conn: connP }, null, 0, live);
    // A refund approved, not paid: 25 000 of a 40 000 payment that used 15 000.
    const due = await payment(parent, 40_000, 5, { due: 25_000 });
    await session(parent, { site: siteP, cp: cpP, conn: connP }, new Date(Date.now() - 5 * 86_400_000 + 7_200_000), 15_000, due);

    const r = (await call('GET', '/v1/finance/driver-funds')).json();
    const c = r.position.currencies.find((x: any) => x.currency === 'IDR');
    assert.deepEqual({ inUse: c.inUse, unused: c.unused, due: c.refundDue, cand: c.breakageCandidate }, { inUse: 80_000, unused: 70_000, due: 25_000, cand: 40_000 });
    assert.equal(c.liability, 80_000 + 70_000 + 25_000);
    const b = r.position.breakage.find((x: any) => x.currency === 'IDR');
    assert.deepEqual({ amt: b.amount, n: b.payments }, { amt: 40_000, n: 1 });

    assert.equal((await call('PUT', '/v1/finance/driver-funds/settings', { breakageDays: 10 })).statusCode, 422);
    assert.equal((await call('POST', '/v1/finance/driver-funds/breakage', { month: localDay().slice(0, 7), currency: 'IDR' })).statusCode, 422, 'nothing that old this month');
    const rec = await call('POST', '/v1/finance/driver-funds/breakage', { month: b.month, currency: 'IDR' });
    assert.equal(rec.statusCode, 200, rec.body);
    assert.equal(rec.json().amount, 40_000);
    assert.equal((await call('POST', '/v1/finance/driver-funds/breakage', { month: b.month, currency: 'IDR' })).statusCode, 409, 'once');
    const after = (await call('GET', '/v1/finance/driver-funds')).json().position.currencies.find((x: any) => x.currency === 'IDR');
    assert.deepEqual({ unused: after.unused, rec: after.recognisedBreakage }, { unused: 30_000, rec: 40_000 }, 'out of the liability');
    const m = (await call('GET', '/v1/finance/driver-funds')).json().movement.currencies.find((x: any) => x.currency === 'IDR');
    const thisMonth = localDay().slice(0, 7);
    const inMonth = ([[50_000, 3], [100_000, 10], [80_000, 0], [40_000, 5], [100_000, 200]] as const).filter(([, d]) => localDay(Date.now() - d * 86_400_000).slice(0, 7) === thisMonth).reduce((x, [v]) => x + v, 0);
    assert.equal(m.collected, inMonth, 'paid this month (in the billing zone)');
    assert.equal(m.breakage, 40_000);
    assert.equal((await call('GET', '/v1/finance/driver-funds?format=xlsx')).rawPayload.subarray(0, 2).toString(), 'PK');
  });
});

dbDescribe('Group consolidation', () => {
  test('the entities added up; an elimination; the suggestion; no subsidiaries answered plainly', async () => {
    principalOrg = parent;
    // A month of its own (the other tests charge in the last 14 months).
    const lm = monthsBack(16);
    const mid = new Date(`${lm}-15T05:00:00+07:00`);
    await session(parent, { site: siteP, cp: cpP, conn: connP }, mid, 300_000);
    await session(child, { site: siteC, cp: cpC, conn: connC }, mid, 200_000);
    // The subsidiary invoices a fleet account with the parent's NPWP: intercompany.
    await fleetInvoice(child, 'GroupFleet', 50_000, -10, '0111111111111111', lm);
    const g = (await call('GET', `/v1/finance/group?month=${lm}`)).json();
    assert.equal(g.grouped, true);
    assert.equal(g.entities.length, 2);
    assert.equal(g.entities[0].id, parent, 'the parent first');
    assert.equal(g.group.revenue.IDR, 500_000);
    const sug = g.eliminations.suggestions[0];
    assert.match(sug.description, /Subsidiary .* to Group/);
    assert.equal(sug.amount, 50_000);

    assert.equal((await call('POST', '/v1/finance/group/eliminations', { month: lm, kind: 'revenue', description: sug.description, amount: 0, currency: 'IDR' })).statusCode, 422);
    const e = await call('POST', '/v1/finance/group/eliminations', { month: lm, kind: 'revenue', description: sug.description, amount: 50_000, currency: 'IDR' });
    assert.equal(e.statusCode, 201, e.body);
    const g2 = (await call('GET', `/v1/finance/group?month=${lm}`)).json();
    assert.equal(g2.net.IDR.revenue, 450_000);
    assert.equal(g2.eliminations.suggestions[0].recorded, true);
    assert.equal((await call('POST', `/v1/finance/group/eliminations/${e.json().id}/void`, { reason: 'Billed at cost: kept' })).statusCode, 200);
    assert.equal((await call('GET', `/v1/finance/group?month=${lm}`)).json().net.IDR.revenue, 500_000);

    principalOrg = child;
    assert.equal((await call('GET', '/v1/finance/group')).json().grouped, false, 'a subsidiary heads no group');
    principalOrg = parent;
  });
});

dbDescribe('Rolling forecast', () => {
  test('a growing site; the scenario; below budget → alert', async () => {
    principalOrg = parent;
    // 14 months of growing revenue at the parent's site (100 000 + 10 000 a month).
    for (let k = 14; k >= 1; k--) await session(parent, { site: siteP, cp: cpP, conn: connP }, new Date(`${monthsBack(k)}-10T05:00:00+07:00`), 100_000 + (14 - k) * 10_000);
    const f = (await call('GET', '/v1/finance/rolling-forecast')).json();
    const s = f.sites.find((x: any) => x.siteId === siteP);
    assert.ok(s.monthsOfHistory >= 14);
    assert.ok(s.trendPerMonth > 0, 'growing');
    assert.equal(s.forecast.length, 12);
    assert.ok(s.forecast[11].revenue > s.forecast[0].revenue, 'the trend continues');
    const up = (await call('GET', '/v1/finance/rolling-forecast?pricePct=10')).json().sites.find((x: any) => x.siteId === siteP);
    assert.ok(Math.abs(up.forecast[0].revenue - Math.round(s.forecast[0].revenue * 1.1)) <= 2, 'a 10% price change');
    assert.equal((await call('GET', '/v1/finance/rolling-forecast?growthPct=900')).statusCode, 422);

    await query(`INSERT INTO finance_budget (org_id, site_id, month, currency, revenue_minor) VALUES ($1, $2, $3, 'IDR', $4)`, [parent, siteP, localDay().slice(0, 7), s.forecast[0].revenue * 3]);
    assert.ok((await call('GET', '/v1/finance/rolling-forecast')).json().sites.find((x: any) => x.siteId === siteP).belowBudget);
    assert.equal(await rolling.check(parent), 1);
    assert.ok(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = $2 AND target_id = $3 AND resolved_at IS NULL`, [parent, rolling.ALERT, siteP]));
  });
});

dbDescribe('Payment plans and the provision', () => {
  test('a plan agreed, paid in parts, the invoice paid; a late plan defaulted; the provision by bucket, recorded', async () => {
    principalOrg = lone;
    const a = await fleetInvoice(lone, 'Armada', 900_000, 45);   // 45 days overdue
    const b = await fleetInvoice(lone, 'Truck', 300_000, 100);   // 100 days overdue
    const p0 = (await call('GET', '/v1/finance/provision')).json().currencies.find((x: any) => x.currency === 'IDR');
    assert.equal(p0.buckets.find((x: any) => x.bucket === '31-60').amount, 900_000);
    assert.equal(p0.provision, Math.round(900_000 * 0.15) + Math.round(300_000 * 0.6));

    assert.equal((await call('POST', `/v1/fleet-invoices/${a.id}/payment-plan`, { count: 1, firstDue: localDay() })).statusCode, 422);
    const pl = await call('POST', `/v1/fleet-invoices/${a.id}/payment-plan`, { count: 3, firstDue: localDay(), graceDays: 5 });
    assert.equal(pl.statusCode, 201, pl.body);
    const plan = pl.json();
    assert.deepEqual(plan.instalments.map((x: any) => x.amount), [300_000, 300_000, 300_000]);
    assert.equal((await call('POST', `/v1/fleet-invoices/${a.id}/payment-plan`, { count: 2, firstDue: localDay() })).statusCode, 409, 'one active plan');
    // On a plan in good standing, the invoice counts as current.
    const p1 = (await call('GET', '/v1/finance/provision')).json().currencies.find((x: any) => x.currency === 'IDR');
    assert.equal(p1.provision, Math.round(900_000 * 0.01) + Math.round(300_000 * 0.6));

    const pay1 = (await call('POST', `/v1/finance/payment-plans/${plan.id}/payments`, { amount: 450_000, reference: 'TRF-1' })).json();
    assert.deepEqual(pay1.instalments.map((x: any) => x.paid), [300_000, 150_000, 0]);
    assert.equal((await call('POST', `/v1/finance/payment-plans/${plan.id}/payments`, { amount: 500_000, reference: 'TRF-2' })).statusCode, 422, 'more than is left');
    const pay2 = (await call('POST', `/v1/finance/payment-plans/${plan.id}/payments`, { amount: 450_000, reference: 'TRF-2' })).json();
    assert.equal(pay2.status, 'completed');
    assert.equal((await one<any>(`SELECT status FROM fleet_invoice WHERE id = $1`, [a.id])).status, 'paid');

    // A plan on the other invoice falls behind.
    const p2 = (await call('POST', `/v1/fleet-invoices/${b.id}/payment-plan`, { count: 2, firstDue: localDay(), graceDays: 2 })).json();
    await query(`UPDATE payment_plan_instalment SET due_date = current_date - 10 WHERE plan_id = $1 AND seq = 1`, [p2.id]);
    const sw = await plans.sweep();
    assert.ok(sw.defaulted >= 1);
    assert.equal((await call('GET', '/v1/finance/payment-plans?status=defaulted')).json().plans.length, 1);
    assert.ok(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = $2 AND resolved_at IS NULL`, [lone, plans.DEFAULTED_ALERT]));

    assert.equal((await call('PUT', '/v1/finance/provision/rates', { '1-30': 50 })).statusCode, 422, 'older at least as high');
    const lm = monthsBack(1);
    const r1 = (await call('POST', `/v1/finance/provision/${lm}/record`)).json().currencies.find((x: any) => x.currency === 'IDR');
    assert.deepEqual({ p: r1.provision, prev: r1.previous, mv: r1.movement }, { p: Math.round(300_000 * 0.6), prev: 0, mv: Math.round(300_000 * 0.6) });
    const h = (await call('GET', '/v1/finance/provision')).json().history;
    assert.equal(h[0].month, lm);
    assert.equal((await call('GET', '/v1/finance/provision?format=xlsx')).rawPayload.subarray(0, 2).toString(), 'PK');
    principalOrg = parent;
  });
});
