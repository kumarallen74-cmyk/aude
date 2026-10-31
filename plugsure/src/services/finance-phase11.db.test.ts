import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { depreciationIn } from './site-investments.js';

/**
 * Phase 11 of the finance review (v1.22.0):
 *   - month lock: only an ended month; energy bills, budgets, exchange rates and investments in it are refused; a
 *     Finance Manager reopens it (with a reason), then they are accepted again; the checklist;
 *   - site investments: straight-line depreciation (rounding in the last month), net book value, the margin
 *     recovered and the payback month, a void;
 *   - revenue drop alerts: a day far below its weekday baseline is recorded and alerted once; a normal day clears it;
 *   - fleet statements of account: opening balance, invoices, credit notes and payments with the running balance,
 *     the open invoices at month end; e-mailed with the PDF (fake SMTP) and logged; the automatic send once a month.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase11.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const { registerFleetRoutes } = await import('../api/fleet-routes.js');
const anomalies = await import('./revenue-anomalies.js');
const soa = await import('./fleet-statements.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID(), B = randomUUID();
let org = '', siteId = '', siteQuiet = '', fleet = '';
let app: FastifyInstance;
let actor = A;
let perms = ['payment:read', 'payment:write'];

/** A month relative to this one, in the billing zone (0 = this month, -1 = last month). */
const ym = (offset: number) => {
  const cur = new Intl.DateTimeFormat('en-CA', { timeZone: config.billing.timeZone }).format(new Date()).slice(0, 7);
  const [y, m] = cur.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + offset;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const M = ym(-1), PM = ym(-2);

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
      mails.push(buf.slice(0, end)); buf = buf.slice(end + 5); data = false;
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
let cpA: { c: string; k: string };
const session = async (site: string, x: { c: string; k: string }, sub: number, at: string) => {
  const sess = (await one<{ id: string }>(
    `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, ended_at, energy_wh, state)
     VALUES ($1, $2, $3, $4, $5, $6, $6::timestamptz + interval '1 hour', 10000, 'rated') RETURNING id`, [org, site, x.k, x.c, `p11-${TAG}-${randomUUID()}`, at]))!.id;
  await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency)
               VALUES ($1, $2, $3, '[]'::jsonb, $4, 0, 0, 0, 0, 0, $4, '{}'::jsonb, 'IDR')`, [sess, org, at, sub]);
};

if (DB_OK) {
  before(async () => {
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', () => r()));
    smtpPort = (smtp.address() as any).port;
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`P11 ${TAG}`, `p11-${TAG}`]))!.id;
    for (const u of [A, B]) await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, $4)`, [u, org, `${u.slice(0, 8)}@p11.test`, u === A ? 'Rina' : 'Andi']);
    siteId = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'ID') RETURNING id`, [org, `Jakarta ${TAG}`]))!.id;
    siteQuiet = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'ID') RETURNING id`, [org, `Bogor ${TAG}`]))!.id;
    const c = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name) VALUES ($1, $2, $2) RETURNING id`, [siteId, `P11A-${TAG}`]))!.id;
    const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [c]))!.id;
    const k = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, max_power_w) VALUES ($1, 60000) RETURNING id`, [e]))!.id;
    cpA = { c, k };
    // Rp 300 000 of revenue in each of the last 6 months (the 10th), energy at Rp 0 per kWh (cost known, nothing).
    for (let i = -6; i <= -1; i++) await session(siteId, cpA, 300_000, `${ym(i)}-10T05:00:00Z`);
    await query(`INSERT INTO site_energy_rate (site_id, org_id, rate_per_kwh, currency) VALUES ($1, $2, 0, 'IDR')`, [siteId, org]);
    fleet = (await one<{ id: string }>(`INSERT INTO fleet_account (org_id, name, billing_email) VALUES ($1, $2, 'ap@fleet.test') RETURNING id`, [org, `Fleet ${TAG}`]))!.id;
    await query(`INSERT INTO notification_channel (org_id, kind, enabled, config) VALUES ($1, 'email', true, $2)`,
      [org, JSON.stringify({ host: '127.0.0.1', port: smtpPort, security: 'none', fromAddress: 'finance@operator.test', fromName: 'Operator Finance' })]);
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: actor, orgId: org, assignments: [{ permissions: perms, scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
    await registerFleetRoutes(app);
  });
  after(async () => {
    smtp.close();
    await app?.close();
    for (const t of ['fleet_statement_send', 'revenue_anomaly', 'site_investment', 'finance_period_lock', 'finance_budget', 'site_energy_cost', 'fx_rate', 'finance_org_settings', 'site_energy_rate']) await query(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
    await query(`DELETE FROM fleet_credit_note WHERE org_id = $1`, [org]);
    await query(`DELETE FROM fleet_invoice WHERE org_id = $1`, [org]);
    await query(`DELETE FROM fleet_account WHERE org_id = $1`, [org]);
    await query(`DELETE FROM cdr WHERE org_id = $1`, [org]);
    await query(`DELETE FROM charging_session WHERE org_id = $1`, [org]);
    await query(`DELETE FROM connector WHERE evse_uuid IN (SELECT e.id FROM evse e JOIN charge_point c ON c.id = e.charge_point_id JOIN site st ON st.id = c.site_id WHERE st.org_id = $1)`, [org]);
    await query(`DELETE FROM evse WHERE charge_point_id IN (SELECT c.id FROM charge_point c JOIN site st ON st.id = c.site_id WHERE st.org_id = $1)`, [org]);
    await query(`DELETE FROM charge_point WHERE site_id IN (SELECT id FROM site WHERE org_id = $1)`, [org]);
    await query(`DELETE FROM site WHERE org_id = $1`, [org]);
    for (const t of ['notification_channel', 'alert']) await query(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
    await query(`DELETE FROM app_user WHERE org_id = $1`, [org]).catch(() => { /* audit rows keep them */ });
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => { /* audit rows keep it */ });
    await pool.end();
  });
}

describe('Straight-line depreciation', () => {
  test('from the month after, over the life; the last month takes the rounding', () => {
    const inv = { amount: 1000, investedOn: '2026-01-20', lifeMonths: 3 };
    assert.equal(depreciationIn(inv, '2026-01'), 0, 'not the month it was paid');
    assert.deepEqual(['2026-02', '2026-03', '2026-04'].map((m) => depreciationIn(inv, m)), [333, 333, 334]);
    assert.equal(depreciationIn(inv, '2026-05'), 0, 'after its life');
    assert.equal(depreciationIn({ amount: 1200, investedOn: '2025-12-31', lifeMonths: 12 }, '2026-01'), 100, 'across a year end');
  });
});

dbDescribe('Month lock', () => {
  test('only an ended month; entries in it refused until a Finance Manager reopens it', async () => {
    perms = ['payment:read', 'payment:write'];
    assert.equal((await call('POST', `/v1/finance/periods/${ym(0)}/lock`)).statusCode, 409, 'this month has not ended');
    const ck = (await call('GET', `/v1/finance/periods/${M}/checklist`)).json();
    const bills = ck.items.find((i: any) => i.key === 'energy_bills');
    assert.equal(bills.ok, false, 'Jakarta had sessions and no bill');
    assert.ok(bills.sites.some((s: any) => s.id === siteId));
    const l = await call('POST', `/v1/finance/periods/${M}/lock`, { note: 'Closed by the accountant' });
    assert.equal(l.statusCode, 200, l.body);
    assert.equal((await call('POST', `/v1/finance/periods/${M}/lock`)).statusCode, 409, 'already locked');
    const months = (await call('GET', '/v1/finance/periods')).json().months;
    assert.deepEqual((({ locked, lockedBy, note }) => ({ locked, lockedBy, note }))(months.find((x: any) => x.month === M)), { locked: true, lockedBy: 'Rina', note: 'Closed by the accountant' });

    const bill = await call('POST', `/v1/finance/sites/${siteId}/energy-bills`, { month: M, amount: 400_000 });
    assert.equal(bill.statusCode, 409);
    assert.match(bill.json().error, /locked/);
    assert.equal((await call('PUT', '/v1/finance/budgets', { month: M, currency: 'IDR', revenue: 1_000_000 })).statusCode, 409);
    assert.equal((await call('PUT', '/v1/finance/fx-rates/reporting-currency', { currency: 'IDR' })).statusCode, 200);
    assert.equal((await call('PUT', '/v1/finance/fx-rates', { month: M, currency: 'MYR', rate: 3500 })).statusCode, 409);
    assert.equal((await call('POST', '/v1/finance/investments', { siteId, category: 'other', description: 'Signage', amount: 100_000, investedOn: `${M}-05` })).statusCode, 409);
    await call('PUT', '/v1/finance/budgets', { month: ym(-2), currency: 'IDR', revenue: 900_000 });
    const cp = await call('POST', '/v1/finance/budgets/copy', { from: ym(-2), months: 2 });
    assert.equal(cp.statusCode, 409, 'a copy into a locked month');
    assert.match(cp.json().error, /nothing was copied/);
    assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM finance_budget WHERE org_id = $1 AND month = $2`, [org, ym(0)]))!.n, 0, 'not even the open month after it');
    // Another month is not affected.
    assert.equal((await call('PUT', '/v1/finance/budgets', { month: ym(0), currency: 'IDR', revenue: 1_000_000 })).statusCode, 200);

    assert.equal((await call('POST', `/v1/finance/periods/${M}/reopen`, { reason: 'Late bill' })).statusCode, 403, 'not a Finance Manager');
    perms = ['payment:read', 'payment:write', 'finance:approve'];
    actor = B;
    assert.equal((await call('POST', `/v1/finance/periods/${M}/reopen`, { reason: '' })).statusCode, 422, 'a reason');
    assert.equal((await call('POST', `/v1/finance/periods/${M}/reopen`, { reason: 'Late PLN bill' })).statusCode, 200);
    assert.equal((await call('POST', `/v1/finance/sites/${siteId}/energy-bills`, { month: M, amount: 0 })).statusCode, 201, 'open again');
    const h = (await call('GET', '/v1/finance/periods')).json().months.find((x: any) => x.month === M);
    assert.equal(h.locked, false);
    assert.deepEqual((({ lockedBy, reopenedBy, reopenReason }) => ({ lockedBy, reopenedBy, reopenReason }))(h.history[0]), { lockedBy: 'Rina', reopenedBy: 'Andi', reopenReason: 'Late PLN bill' });
    // Locked again, the bill cannot be voided.
    actor = A; perms = ['payment:read', 'payment:write'];
    assert.equal((await call('POST', `/v1/finance/periods/${M}/lock`)).statusCode, 200, 'locked again');
    const b = await one<{ id: string }>(`SELECT id FROM site_energy_cost WHERE org_id = $1 AND month = $2`, [org, M]);
    assert.equal((await call('POST', `/v1/finance/energy-bills/${b!.id}/void`, { reason: 'Wrong' })).statusCode, 409);
    actor = B; perms = ['payment:read', 'payment:write', 'finance:approve'];
    assert.equal((await call('POST', `/v1/finance/periods/${M}/reopen`, { reason: 'For the investment test' })).statusCode, 200);
    actor = A; perms = ['payment:read', 'payment:write'];
  });
});

dbDescribe('Site investments', () => {
  test('depreciation, net book value, margin recovered and the payback month; a void', async () => {
    const start = ym(-6);
    assert.equal((await call('POST', '/v1/finance/investments', { siteId, category: 'rocket', description: 'x', amount: 1, investedOn: `${start}-01` })).statusCode, 422);
    const r = await call('POST', '/v1/finance/investments', { siteId, category: 'chargers', description: '2 × 60 kW DC', amount: 1_200_000, investedOn: `${start}-01`, lifeMonths: 12 });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().investedOn, `${start}-01`);
    const extra = (await call('POST', '/v1/finance/investments', { siteId, category: 'other', description: 'Typo', amount: 5_000, investedOn: `${start}-02` })).json();
    assert.equal((await call('POST', `/v1/finance/investments/${extra.id}/void`, { reason: 'Entered twice' })).statusCode, 200);

    const o = (await call('GET', '/v1/finance/investments')).json();
    const s = o.sites.find((x: any) => x.siteId === siteId);
    assert.equal(s.invested, 1_200_000, 'the voided one left out');
    assert.equal(s.byCategory.chargers, 1_200_000);
    // 100 000 a month from the month after: months -5 … -1 are past.
    assert.deepEqual(s.depreciation, { perMonth: 100_000, accumulated: 500_000, netBookValue: 700_000 });
    // Rp 300 000 margin a month since month -6: covered after 4 months (month -3).
    assert.equal(s.recovered.margin, 1_800_000);
    assert.equal(s.recovered.pct, 150);
    assert.deepEqual(s.payback, { month: ym(-3), projected: false, monthsFromStart: 3 });
    assert.equal(s.averageMonthlyMargin, 300_000);
    assert.equal(s.roiPct, Math.round(((300_000 * 12 - 7 * 100_000) / 1_200_000) * 1000) / 10, 'a year: margin less the 7 months still depreciated (the net book value)');
    assert.equal(o.voided.length, 1);
    assert.equal(o.totals.IDR.invested, 1_200_000);
  });
});

dbDescribe('Revenue drop alerts', () => {
  test('a day far below its weekday baseline is recorded and alerted once; a normal day clears it', async () => {
    // Pick a day 3 days ago; its weekday in the 4 weeks before had Rp 100 000 each, the day itself Rp 20 000.
    const day = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const minus = (n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    for (const n of [7, 14, 21, 28]) await session(siteId, cpA, 100_000, `${minus(n)}T05:00:00Z`);
    await session(siteId, cpA, 20_000, `${day}T05:00:00Z`);
    assert.equal((await call('PUT', '/v1/finance/revenue-alerts/settings', { enabled: true, dropPct: 5 })).statusCode, 422);
    assert.equal((await call('PUT', '/v1/finance/revenue-alerts/settings', { enabled: true, dropPct: 50 })).statusCode, 200);
    const r = (await call('POST', '/v1/finance/revenue-alerts/check', { day })).json();
    const mine = r.found.filter((f: any) => f.siteId === siteId);
    assert.equal(mine.length, 1);
    assert.deepEqual((({ revenue, baseline, dropPct }) => ({ revenue, baseline, dropPct }))(mine[0]), { revenue: 20_000, baseline: 100_000, dropPct: 80 });
    assert.ok(!r.found.some((f: any) => f.siteId === siteQuiet), 'a site without history is not compared');
    await call('POST', '/v1/finance/revenue-alerts/check', { day });
    const al = await many<any>(`SELECT * FROM alert WHERE org_id = $1 AND kind = 'finance.revenue_drop' AND target_id = $2`, [org, siteId]);
    assert.equal(al.length, 1);
    assert.equal(al[0].occurrences, 1, 'the same day is not alerted twice');
    assert.match(al[0].message, /80% below/);
    assert.equal((await call('GET', '/v1/finance/revenue-alerts')).json().anomalies.filter((a: any) => a.siteId === siteId).length, 1);
    // The next day of that weekday back to normal clears it.
    const next = new Date(Date.parse(`${day}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    await session(siteId, cpA, 100_000, `${next}T05:00:00Z`);
    await anomalies.detect(org, next);
    assert.ok((await one<any>(`SELECT resolved_at FROM alert WHERE id = $1`, [al[0].id]))!.resolved_at);
  });
});

dbDescribe('Fleet statements of account', () => {
  test('opening, movements with the running balance, closing and the open invoices; e-mailed and logged; automatic once', async () => {
    perms = ['invoice:read', 'invoice:write'];
    const inv = async (number: string, issued: string, due: string, total: number, extra: { status?: string; paid?: string; credited?: number } = {}) =>
      (await one<{ id: string }>(
        `INSERT INTO fleet_invoice (org_id, fleet_account_id, period, number, status, issued_at, due_date, sessions, energy_wh, subtotal_minor, local_tax_minor, taxable_minor, tax_base_minor, tax_minor,
                                    own_total_minor, roaming_total_minor, total_minor, data, currency, paid_at, credited_minor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 1000, $8, 0, $8, 0, 0, $8, 0, $8, '{}'::jsonb, 'IDR', $9, $10) RETURNING id`,
        [org, fleet, `${issued.slice(0, 7)}-01`, number, extra.status ?? 'issued', `${issued}T03:00:00Z`, due, total, extra.paid ?? null, extra.credited ?? 0]))!.id;
    // Issued last month - 1 (opening), paid in the month; issued in the month, partly credited; one voided (left out).
    await inv(`SA1-${TAG}`, `${PM}-25`, `${M}-09`, 500_000, { status: 'paid', paid: `${M}-08` });
    const i2 = await inv(`SA2-${TAG}`, `${M}-05`, `${M}-19`, 300_000, { credited: 50_000 });
    await inv(`SA3-${TAG}`, `${M}-06`, `${M}-20`, 999_999, { status: 'void' });
    await query(`INSERT INTO fleet_credit_note (org_id, fleet_account_id, invoice_id, number, status, settlement, reason, lines, tax_base_minor, tax_minor, total_minor, issued_at, issued_by, currency)
                 VALUES ($1, $2, $3, $4, 'issued', 'invoice', 'Disputed session', '[]'::jsonb, 0, 0, 50000, $5, 'test', 'IDR')`, [org, fleet, i2, `CN1-${TAG}`, `${M}-12T03:00:00Z`]);

    assert.equal((await call('GET', `/v1/fleet-accounts/${fleet}/account-statement?month=nope`)).statusCode, 422);
    const st = (await call('GET', `/v1/fleet-accounts/${fleet}/account-statement?month=${M}`)).json();
    const c = st.currencies[0];
    assert.equal(st.currencies.length, 1);
    assert.equal(c.opening, 500_000);
    assert.deepEqual(c.entries.map((e: any) => [e.kind, e.debit, e.credit, e.balance]), [
      ['invoice', 300_000, 0, 800_000], ['payment', 0, 500_000, 300_000], ['credit_note', 0, 50_000, 250_000],
    ]);
    assert.equal(c.closing, 250_000);
    assert.deepEqual(c.open.map((o: any) => [o.number, o.outstanding, o.bucket]), [[`SA2-${TAG}`, 250_000, '1-30']]);
    const pdf = await call('GET', `/v1/fleet-accounts/${fleet}/account-statement.pdf?month=${M}`);
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf.rawPayload.subarray(0, 5).toString(), '%PDF-');
    const x = await call('GET', `/v1/fleet-accounts/${fleet}/account-statement.xlsx?month=${M}`);
    assert.equal(x.rawPayload.subarray(0, 2).toString(), 'PK');

    mails.length = 0;
    const sent = await call('POST', `/v1/fleet-accounts/${fleet}/account-statement/send`, { month: M });
    assert.equal(sent.statusCode, 200, sent.body);
    for (let i = 0; i < 50 && !mails.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(mails[0]!.includes('ap@fleet.test'));
    assert.match(mails[0]!, /application\/pdf/);
    const log = (await call('GET', '/v1/fleet-account-statements')).json();
    assert.deepEqual((({ month, automatic, to, closing }) => ({ month, automatic, to, closing }))(log.sent[0]), { month: M, automatic: false, to: 'ap@fleet.test', closing: { IDR: 250_000 } });

    assert.equal((await call('PUT', '/v1/fleet-account-statements/settings', { enabled: true, day: 29 })).statusCode, 422);
    assert.equal((await call('PUT', '/v1/fleet-account-statements/settings', { enabled: true, day: 1 })).statusCode, 200);
    assert.equal(await soa.sweep(), 1, 'last month\'s statement, automatically');
    assert.equal(await soa.sweep(), 0, 'once');
    assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM fleet_statement_send WHERE fleet_account_id = $1 AND automatic AND error IS NULL`, [fleet]))!.n, 1);
  });
});
