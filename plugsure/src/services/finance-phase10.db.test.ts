import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { duePeriod } from './report-schedules.js';

/**
 * Phase 10 of the finance review (v1.21.0):
 *   - the approvals matrix: only finance:approve sets it; a write-off above the threshold needs two approvers (the
 *     first recorded, the second completes it, not the same person); a bank change needs a Finance Manager;
 *   - currencies: the reporting currency, a rate by hand and from the ECB (a fake), consolidated margin totals, the
 *     currencies without a rate listed;
 *   - the summary: revenue month to date per currency, the receivables and DSO, fee and refund rates;
 *   - report e-mails: validation, when a schedule is due (weekly / monthly, once per period), sent through a fake SMTP
 *     server with the workbook attached.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase10.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID(), B = randomUUID(), C = randomUUID();
let org = '', siteId = '', siteMy = '', fleet = '', inv = '', owner = '';
let app: FastifyInstance;
let actor = A;
let perms = ['payment:read', 'payment:write'];

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
// A fake ECB rates API (frankfurter's shape).
const fxSeen: string[] = [];
const fxServer = http.createServer((req, res) => {
  fxSeen.push(req.url ?? '');
  res.setHeader('content-type', 'application/json');
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.searchParams.get('from') === 'MYR' && u.searchParams.get('to') === 'IDR') return res.end(JSON.stringify({ amount: 1, base: 'MYR', rates: { IDR: 3500.5 } }));
  res.statusCode = 404; res.end('{}');
});

const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });

if (DB_OK) {
  before(async () => {
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', () => r()));
    smtpPort = (smtp.address() as any).port;
    await new Promise<void>((r) => fxServer.listen(0, '127.0.0.1', () => r()));
    process.env.FX_RATES_URL = `http://127.0.0.1:${(fxServer.address() as any).port}`;
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`P10 ${TAG}`, `p10-${TAG}`]))!.id;
    for (const u of [A, B, C]) await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, $4)`, [u, org, `${u.slice(0, 8)}@p10.test`, u === A ? 'Rina' : u === B ? 'Andi' : 'Sari']);
    siteId = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'ID') RETURNING id`, [org, `Jakarta ${TAG}`]))!.id;
    siteMy = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'MY') RETURNING id`, [org, `KL ${TAG}`]))!.id;
    const cp = async (s: string, id: string) => {
      const c = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name) VALUES ($1, $2, $2) RETURNING id`, [s, id]))!.id;
      const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [c]))!.id;
      const k = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, max_power_w) VALUES ($1, 60000) RETURNING id`, [e]))!.id;
      return { c, k };
    };
    const a = await cp(siteId, `P10A-${TAG}`), b = await cp(siteMy, `P10B-${TAG}`);
    const now = new Date();
    const s = async (x: { c: string; k: string }, site: string, wh: number, sub: number, cur: string, at: Date) => {
      const sess = (await one<{ id: string }>(
        `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, ended_at, energy_wh, state)
         VALUES ($1, $2, $3, $4, $5, $6, $6::timestamptz + interval '1 hour', $7, 'rated') RETURNING id`, [org, site, x.k, x.c, `p10-${TAG}-${randomUUID()}`, at.toISOString(), wh]))!.id;
      await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency)
                   VALUES ($1, $2, $3, '[]'::jsonb, $4, 0, 0, 0, 0, 0, $4, '{}'::jsonb, $5)`, [sess, org, at.toISOString(), sub, cur]);
    };
    // This month: Rp 1 000 000 in Jakarta, RM 100.00 (10000 sen) in KL. Issued now (not an hour ago: just after
    // midnight on the 1st, that is last month in the billing zone).
    await s(a, siteId, 400_000, 1_000_000, 'IDR', now);
    await s(b, siteMy, 50_000, 10_000, 'MYR', now);
    await query(`INSERT INTO site_energy_rate (site_id, org_id, rate_per_kwh, currency) VALUES ($1, $2, 1500, 'IDR'), ($3, $2, 0.5, 'MYR')`, [siteId, org, siteMy]);
    fleet = (await one<{ id: string }>(`INSERT INTO fleet_account (org_id, name, billing_email) VALUES ($1, $2, 'ap@fleet.test') RETURNING id`, [org, `Fleet ${TAG}`]))!.id;
    inv = (await one<{ id: string }>(
      `INSERT INTO fleet_invoice (org_id, fleet_account_id, period, number, status, due_date, sessions, energy_wh, subtotal_minor, local_tax_minor, taxable_minor, tax_base_minor, tax_minor,
                                  own_total_minor, roaming_total_minor, total_minor, data, currency)
       VALUES ($1, $2, '2026-08-01', $3, 'issued', $4, 1, 1000, 500000, 0, 500000, 0, 0, 500000, 0, 500000, '{}'::jsonb, 'IDR') RETURNING id`,
      [org, fleet, `FI10-${TAG}`, new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10)]))!.id;
    owner = (await one<{ id: string }>(`INSERT INTO site_owner (org_id, name) VALUES ($1, $2) RETURNING id`, [org, `Owner ${TAG}`]))!.id;
    await query(`INSERT INTO notification_channel (org_id, kind, enabled, config) VALUES ($1, 'email', true, $2)`,
      [org, JSON.stringify({ host: '127.0.0.1', port: smtpPort, security: 'none', fromAddress: 'finance@operator.test', fromName: 'Operator Finance' })]);
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: actor, orgId: org, assignments: [{ permissions: perms, scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
  });
  after(async () => {
    smtp.close(); fxServer.close();
    delete process.env.FX_RATES_URL;
    await app?.close();
    for (const t of ['finance_report_schedule', 'fx_rate', 'receivable_write_off', 'owner_bank_change_request', 'owner_bank_account', 'finance_org_settings', 'site_energy_rate']) await query(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
    await query(`DELETE FROM fleet_invoice WHERE org_id = $1`, [org]);
    await query(`DELETE FROM fleet_account WHERE org_id = $1`, [org]);
    await query(`DELETE FROM site_owner WHERE org_id = $1`, [org]);
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

describe('When a report schedule is due', () => {
  test('weekly on its weekday from 07:00, once per ISO week; monthly on the 1st, once per month', () => {
    // 2026-11-02 is a Monday; 07:30 in Jakarta is 00:30 UTC.
    const mon = new Date('2026-11-02T00:30:00Z'), early = new Date('2026-11-01T23:00:00Z');
    assert.equal(duePeriod({ frequency: 'weekly', weekday: 1, last_period: null }, mon), '2026-W45');
    assert.equal(duePeriod({ frequency: 'weekly', weekday: 1, last_period: '2026-W45' }, mon), null, 'once');
    assert.equal(duePeriod({ frequency: 'weekly', weekday: 2, last_period: null }, mon), null, 'not its day');
    assert.equal(duePeriod({ frequency: 'weekly', weekday: 1, last_period: null }, early), null, 'before 07:00');
    assert.equal(duePeriod({ frequency: 'monthly', weekday: null, last_period: null }, new Date('2026-11-01T01:00:00Z')), '2026-11');
    assert.equal(duePeriod({ frequency: 'monthly', weekday: null, last_period: '2026-11' }, new Date('2026-11-01T01:00:00Z')), null);
    assert.equal(duePeriod({ frequency: 'monthly', weekday: null, last_period: null }, mon), null, 'only the 1st');
  });
});

dbDescribe('The approvals matrix', () => {
  test('only finance:approve sets it; two approvers for a large write-off; a Finance Manager for a bank change', async () => {
    perms = ['payment:read', 'payment:write'];
    assert.equal((await call('PUT', '/v1/finance/approval-rules', { rules: { write_off: { above: 100_000, rule: 'two_approvers' } } })).statusCode, 403);
    perms = ['payment:read', 'payment:write', 'finance:approve'];
    assert.equal((await call('PUT', '/v1/finance/approval-rules', { rules: { write_off: { above: 1, rule: 'three' } } })).statusCode, 422);
    const r = await call('PUT', '/v1/finance/approval-rules', { rules: { write_off: { above: 100_000, rule: 'two_approvers' }, bank_change: { rule: 'finance_approver' } } });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().rules.bank_change, { above: 0, rule: 'finance_approver' });

    actor = A; perms = ['payment:read', 'payment:write'];
    const w = (await call('POST', `/v1/finance/collections/fleet_invoice/${inv}/write-off`, { reason: 'Customer gone' })).json();
    actor = B;
    const first = (await call('POST', `/v1/finance/write-offs/${w.id}/approve`)).json();
    assert.deepEqual({ st: first.state, f: first.firstApproval }, { st: 'pending', f: true }, 'the first of two');
    assert.equal((await call('POST', `/v1/finance/write-offs/${w.id}/approve`)).statusCode, 403, 'not the same person twice');
    assert.equal((await one<any>(`SELECT first_approved_by FROM receivable_write_off WHERE id = $1`, [w.id]))!.first_approved_by, B);
    actor = C;
    assert.equal((await call('POST', `/v1/finance/write-offs/${w.id}/approve`)).json().state, 'approved');

    // A bank change: an approver without finance:approve is refused; a Finance Manager approves.
    const ownerUser = randomUUID();
    await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, 'Owner user')`, [ownerUser, org, `${ownerUser.slice(0, 8)}@owner.test`]);
    const { requestChange } = await import('./owner-portal.js');
    const rq = await requestChange(org, owner, { bankName: 'BCA', holderName: 'Owner', accountNumber: '1234567890' }, ownerUser);
    actor = B; perms = ['payment:read', 'payment:write'];
    const no = await call('POST', `/v1/finance/owner-bank-requests/${rq.id}/approve`);
    assert.equal(no.statusCode, 403);
    assert.match(no.json().error, /Finance Manager/);
    perms = ['payment:read', 'payment:write', 'finance:approve'];
    assert.equal((await call('POST', `/v1/finance/owner-bank-requests/${rq.id}/approve`)).json().state, 'approved');
    actor = A; perms = ['payment:read', 'payment:write'];
  });
});

dbDescribe('Currencies and consolidation', () => {
  test('the reporting currency; a rate by hand and from the ECB; consolidated margin; a currency without a rate listed', async () => {
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: config.billing.timeZone }).format(new Date()).slice(0, 7);
    assert.equal((await call('PUT', '/v1/finance/fx-rates', { month, currency: 'MYR', rate: 3500 })).statusCode, 409, 'the reporting currency first');
    assert.equal((await call('PUT', '/v1/finance/fx-rates/reporting-currency', { currency: 'idr' })).json().reportingCurrency, 'IDR');
    let e = (await call('GET', `/v1/finance/energy?month=${month}`)).json();
    assert.deepEqual({ cur: e.consolidated.currency, missing: e.consolidated.missing, rev: e.consolidated.revenue }, { cur: 'IDR', missing: ['MYR'], rev: 1_000_000 }, 'MYR not counted without a rate');
    assert.equal((await call('PUT', '/v1/finance/fx-rates', { month, currency: 'IDR', rate: 1 })).statusCode, 422, 'not the reporting currency itself');
    const f = await call('POST', '/v1/finance/fx-rates/fetch', { month });
    assert.equal(f.statusCode, 200, f.body);
    assert.deepEqual(f.json().rates, [{ currency: 'MYR', rate: 3500.5 }]);
    assert.ok(fxSeen.some((u) => /from=MYR&to=IDR/.test(u)));
    e = (await call('GET', `/v1/finance/energy?month=${month}`)).json();
    assert.deepEqual({ missing: e.consolidated.missing, rev: e.consolidated.revenue }, { missing: [], rev: 1_000_000 + Math.round(10_000 * 3500.5) });
    assert.equal((await call('PUT', '/v1/finance/fx-rates', { month, currency: 'MYR', rate: 3400 })).statusCode, 200);
    const list = (await call('GET', `/v1/finance/fx-rates?month=${month}`)).json();
    assert.deepEqual(list.rates.map((r: any) => [r.currency, r.rate, r.source]), [['MYR', 3400, 'manual']]);
    assert.deepEqual(list.currencies, ['IDR', 'MYR']);
  });
});

dbDescribe('The summary', () => {
  test('revenue month to date per currency; receivables and DSO; consolidated totals', async () => {
    // The first invoice was written off above; another one is owed.
    await query(
      `INSERT INTO fleet_invoice (org_id, fleet_account_id, period, number, status, due_date, sessions, energy_wh, subtotal_minor, local_tax_minor, taxable_minor, tax_base_minor, tax_minor,
                                  own_total_minor, roaming_total_minor, total_minor, data, currency)
       VALUES ($1, $2, '2026-09-01', $3, 'issued', $4, 1, 1000, 500000, 0, 500000, 0, 0, 500000, 0, 500000, '{}'::jsonb, 'IDR')`,
      [org, fleet, `FI10B-${TAG}`, new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)]);
    const s = (await call('GET', '/v1/finance/summary')).json();
    const idr = s.perCurrency.find((p: any) => p.currency === 'IDR'), myr = s.perCurrency.find((p: any) => p.currency === 'MYR');
    assert.equal(idr.revenue.mtd, 1_000_000);
    assert.equal(myr.revenue.mtd, 10_000);
    assert.equal(idr.receivables, 500_000, 'the fleet invoice');
    assert.equal(idr.dso, Math.round(500_000 / (1_000_000 / 90)));
    assert.equal(idr.margin.mtd, 1_000_000 - 600_000, '400 kWh at Rp 1 500');
    assert.equal(s.consolidated.currency, 'IDR');
    assert.equal(s.consolidated.revenueMtd.amount, 1_000_000 + 10_000 * 3400);
  });
});

dbDescribe('Report e-mails', () => {
  test('validated; sent now with the workbook; the worker sends a due schedule once', async () => {
    assert.equal((await call('POST', '/v1/finance/report-schedules', { name: 'Weekly', reports: ['nope'], frequency: 'weekly', recipients: ['a@b.test'] })).statusCode, 422);
    assert.equal((await call('POST', '/v1/finance/report-schedules', { name: 'Weekly', reports: ['summary'], frequency: 'daily', recipients: ['a@b.test'] })).statusCode, 422);
    assert.equal((await call('POST', '/v1/finance/report-schedules', { name: 'Weekly', reports: ['summary'], frequency: 'weekly', recipients: ['x'] })).statusCode, 422);
    assert.equal((await call('POST', '/v1/finance/report-schedules', { name: 'With forecast', reports: ['forecast'], frequency: 'weekly', recipients: ['a@b.test'] })).statusCode, 422, 'no payments account');
    const c = await call('POST', '/v1/finance/report-schedules', { name: 'Finance weekly', reports: ['summary', 'margin', 'collections', 'budgets'], frequency: 'weekly', weekday: 1, recipients: 'cfo@operator.test, Accountant@Firm.test' });
    assert.equal(c.statusCode, 201, c.body);
    assert.deepEqual(c.json().recipients, ['cfo@operator.test', 'accountant@firm.test']);
    mails.length = 0;
    const sent = await call('POST', `/v1/finance/report-schedules/${c.json().id}/send`);
    assert.equal(sent.statusCode, 200, sent.body);
    assert.equal(mails.length, 1);
    assert.match(mails[0]!, /To: cfo@operator\.test, accountant@firm\.test/);
    assert.match(mails[0]!, /plugsure-finance-weekly-\d{4}-\d{2}-\d{2}\.xlsx/);
    assert.match(mails[0]!.replace(/=\r\n/g, ''), /IDR: revenue this month 1000000/);

    const { sendDue } = await import('./report-schedules.js');
    mails.length = 0;
    const mon = new Date('2026-11-02T00:30:00Z');
    assert.equal(await sendDue(mon), 1);
    assert.equal(await sendDue(mon), 0, 'once per week');
    assert.equal((await one<any>(`SELECT last_period FROM finance_report_schedule WHERE id = $1`, [c.json().id]))!.last_period, '2026-W45');
    assert.equal((await call('PUT', `/v1/finance/report-schedules/${c.json().id}`, { archived: true })).statusCode, 200);
    assert.equal((await call('GET', '/v1/finance/report-schedules')).json().schedules.length, 0);
  });
});
