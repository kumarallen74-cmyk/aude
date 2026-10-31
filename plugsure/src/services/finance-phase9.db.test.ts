import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { bucketOf } from './collections.js';

/**
 * Phase 9 of the finance review (v1.20.0):
 *   - energy cost and margin: revenue and kWh per site from the charge records; the bill when recorded, else the cost
 *     per kWh (estimate); losses against the kWh billed; the bill allocated to chargers by kWh; one bill per month;
 *   - budgets vs actuals: organisation and site lines, the variance; sites carry no fee / owner-share budget; copy
 *     forward; the off-track alert from the 7th;
 *   - collections: aging buckets, notes and promises, a reminder by e-mail (fake SMTP), the dunning schedule (latest
 *     step once, paused by a promise), a write-off approved by a second person;
 *   - the audit pack: a ZIP with the CSVs, a manifest whose SHA-256s match the files, and the audit chain's check.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase9.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const store = await import('../integrations/store.js');
const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const budgets = await import('./budgets.js');
const collections = await import('./collections.js');

/** A day relative to today in the billing zone (YYYY-MM-DD). */
const localDays = (n: number) => {
  const t = new Intl.DateTimeFormat('en-CA', { timeZone: config.billing.timeZone }).format(new Date());
  return new Date(Date.parse(`${t}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
};
const TAG = randomBytes(3).toString('hex');
const A = randomUUID(), B = randomUUID();
let org = '', site = '', site2 = '', cpA = '', cpB = '', fleet = '', inv = '', xenditId = '';
let app: FastifyInstance;
let actor = A;

// A fake SMTP server that keeps every message.
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

/** The entries of a ZIP the way xlsx.ts writes them (stored or deflated). */
function unzip(b: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let i = 0;
  while (b.readUInt32LE(i) === 0x04034b50) {
    const method = b.readUInt16LE(i + 8), size = b.readUInt32LE(i + 18), nameLen = b.readUInt16LE(i + 26), extra = b.readUInt16LE(i + 28);
    const name = b.subarray(i + 30, i + 30 + nameLen).toString();
    const data = b.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    i += 30 + nameLen + extra + size;
  }
  return out;
}

if (DB_OK) {
  before(async () => {
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', () => r()));
    smtpPort = (smtp.address() as any).port;
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`P9 ${TAG}`, `p9-${TAG}`]))!.id;
    for (const u of [A, B]) await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, $4)`, [u, org, `${u.slice(0, 8)}@p9.test`, u === A ? 'Rina' : 'Andi']);
    site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'ID') RETURNING id`, [org, `Mall ${TAG}`]))!.id;
    site2 = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'ID') RETURNING id`, [org, `Office ${TAG}`]))!.id;
    const cp = async (s: string, id: string) => {
      const c = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name) VALUES ($1, $2, $2) RETURNING id`, [s, id]))!.id;
      const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [c]))!.id;
      const k = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, max_power_w) VALUES ($1, 60000) RETURNING id`, [e]))!.id;
      return { c, k };
    };
    const a = await cp(site, `P9A-${TAG}`), b = await cp(site, `P9B-${TAG}`), c = await cp(site2, `P9C-${TAG}`);
    cpA = a.c; cpB = b.c;
    // September: charger A 300 kWh / Rp 750 000, charger B 100 kWh / Rp 250 000 (site 1); site 2 50 kWh / Rp 125 000.
    const s = async (x: { c: string; k: string }, siteId: string, wh: number, sub: number, at: string) => {
      const sess = (await one<{ id: string }>(
        `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, ended_at, energy_wh, state)
         VALUES ($1, $2, $3, $4, $5, $6, $6::timestamptz + interval '1 hour', $7, 'rated') RETURNING id`, [org, siteId, x.k, x.c, `p9-${TAG}-${randomUUID()}`, at, wh]))!.id;
      await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency)
                   VALUES ($1, $2, $3, '[]'::jsonb, $4, 0, 0, 0, 0, 0, $4, '{}'::jsonb, 'IDR')`, [sess, org, at, sub]);
    };
    await s(a, site, 300_000, 750_000, '2026-09-10T03:00:00Z');
    await s(b, site, 100_000, 250_000, '2026-09-11T03:00:00Z');
    await s(c, site2, 50_000, 125_000, '2026-09-12T03:00:00Z');
    // A fleet invoice due 40 days ago, Rp 1 000 000, Rp 100 000 credited.
    fleet = (await one<{ id: string }>(`INSERT INTO fleet_account (org_id, name, billing_email, phone) VALUES ($1, $2, 'ap@fleet.test', '628123456789') RETURNING id`, [org, `Fleet ${TAG}`]))!.id;
    // Dates in the billing zone (the server counts days past due there), not UTC's.
    const due = localDays(-40);
    inv = (await one<{ id: string }>(
      `INSERT INTO fleet_invoice (org_id, fleet_account_id, period, number, status, due_date, sessions, energy_wh, subtotal_minor, local_tax_minor, taxable_minor, tax_base_minor, tax_minor,
                                  own_total_minor, roaming_total_minor, total_minor, credited_minor, data, currency)
       VALUES ($1, $2, '2026-08-01', $3, 'issued', $4, 10, 100000, 1000000, 0, 1000000, 0, 0, 1000000, 0, 1000000, 100000, '{}'::jsonb, 'IDR') RETURNING id`, [org, fleet, `FI-${TAG}`, due]))!.id;
    await query(`INSERT INTO notification_channel (org_id, kind, enabled, config) VALUES ($1, 'email', true, $2)`,
      [org, JSON.stringify({ host: '127.0.0.1', port: smtpPort, security: 'none', fromAddress: 'billing@operator.test', fromName: 'Operator Billing' })]);
    xenditId = ((await store.save('payments', org, { provider: 'xendit', settings: { environment: 'sandbox', methods: ['QRIS'], baseUrl: 'http://127.0.0.1:9' },
      secrets: { secretKey: `xnd_development_${TAG}`, callbackToken: 'cb' } }, null)) as any).id;
    await query(`INSERT INTO gateway_transaction (integration_id, org_id, provider, external_id, kind, status, cashflow, currency, amount, fee, vat, withholding_tax, channel_code, gateway_created_at, gateway_updated_at)
                 VALUES ($1, $2, 'xendit', $3, 'payment', 'success', 'in', 'IDR', 100000, 700, 77, 0, 'QRIS', '2026-09-10T03:00:00Z', '2026-09-10T03:00:00Z')`, [xenditId, org, `p9-${TAG}`]);
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: actor, orgId: org, assignments: [{ permissions: ['payment:read', 'payment:write'], scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
  });
  after(async () => {
    smtp.close();
    await app?.close();
    for (const t of ['receivable_write_off', 'dunning_reminder', 'receivable_note', 'finance_org_settings', 'finance_budget', 'site_energy_cost', 'site_energy_rate']) await query(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
    await query(`DELETE FROM fleet_invoice WHERE org_id = $1`, [org]);
    await query(`DELETE FROM fleet_account WHERE org_id = $1`, [org]);
    await query(`DELETE FROM cdr WHERE org_id = $1`, [org]);
    await query(`DELETE FROM charging_session WHERE org_id = $1`, [org]);
    await query(`DELETE FROM connector WHERE evse_uuid IN (SELECT e.id FROM evse e JOIN charge_point c ON c.id = e.charge_point_id JOIN site st ON st.id = c.site_id WHERE st.org_id = $1)`, [org]);
    await query(`DELETE FROM evse WHERE charge_point_id IN (SELECT c.id FROM charge_point c JOIN site st ON st.id = c.site_id WHERE st.org_id = $1)`, [org]);
    await query(`DELETE FROM charge_point WHERE site_id IN (SELECT id FROM site WHERE org_id = $1)`, [org]);
    await query(`DELETE FROM site WHERE org_id = $1`, [org]);
    await query(`DELETE FROM gateway_transaction WHERE integration_id = $1`, [xenditId]);
    for (const t of ['notification_channel', 'alert']) await query(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
    await query(`DELETE FROM integration_event WHERE integration_id IN (SELECT id FROM integration WHERE org_id = $1)`, [org]);
    await query(`DELETE FROM integration WHERE org_id = $1`, [org]);
    await query(`DELETE FROM app_user WHERE org_id = $1`, [org]).catch(() => { /* audit rows keep them */ });
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => { /* audit rows keep it */ });
    store.invalidate();
    await pool.end();
  });
}

describe('Aging buckets', () => {
  test('current, 1–30, 31–60, 61–90, over 90', () => {
    assert.deepEqual([-5, 0, 1, 30, 31, 60, 61, 90, 91].map(bucketOf), ['current', 'current', '1-30', '1-30', '31-60', '31-60', '61-90', '61-90', '90+']);
  });
});

dbDescribe('Energy cost and margin', () => {
  test('estimate from the cost per kWh; the bill wins, with losses; allocated to chargers by kWh; one bill a month', async () => {
    let r = (await call('GET', '/v1/finance/energy?month=2026-09')).json();
    let s1 = r.sites.find((x: any) => x.siteId === site);
    assert.deepEqual({ kwh: s1.kwh, rev: s1.revenue, src: s1.source, cost: s1.energyCost }, { kwh: 400, rev: 1_000_000, src: 'unknown', cost: null });
    assert.equal((await call('PUT', `/v1/finance/sites/${site}/energy-rate`, { ratePerKwh: -1 })).statusCode, 422);
    assert.equal((await call('PUT', `/v1/finance/sites/${site}/energy-rate`, { ratePerKwh: 1650 })).statusCode, 200);
    s1 = (await call('GET', '/v1/finance/energy?month=2026-09')).json().sites.find((x: any) => x.siteId === site);
    assert.deepEqual({ src: s1.source, cost: s1.energyCost, margin: s1.margin }, { src: 'estimate', cost: 660_000, margin: 340_000 });

    const bill = await call('POST', `/v1/finance/sites/${site}/energy-bills`, { month: '2026-09', amount: 720_000, kwhBilled: 440, reference: 'PLN 123' });
    assert.equal(bill.statusCode, 201, bill.body);
    assert.equal((await call('POST', `/v1/finance/sites/${site}/energy-bills`, { month: '2026-09', amount: 1 })).statusCode, 409, 'one live bill a month');
    r = (await call('GET', '/v1/finance/energy?month=2026-09')).json();
    s1 = r.sites.find((x: any) => x.siteId === site);
    assert.deepEqual({ src: s1.source, cost: s1.energyCost, perKwh: s1.costPerKwh, loss: s1.lossPct, margin: s1.margin, pct: s1.marginPct }, { src: 'bill', cost: 720_000, perKwh: 1800, loss: 9.09, margin: 280_000, pct: 28 });
    const ch = Object.fromEntries(s1.chargers.map((c: any) => [c.chargePointId, c]));
    assert.deepEqual({ a: ch[cpA].energyCost, b: ch[cpB].energyCost, am: ch[cpA].margin }, { a: 540_000, b: 180_000, am: 210_000 }, 'by kWh: 3/4 and 1/4');
    assert.equal(r.totals.IDR.unknownSites, 1, 'the second site has no cost yet');
    assert.equal((await call('POST', `/v1/finance/energy-bills/${bill.json().id}/void`, {})).statusCode, 422);
    assert.equal((await call('POST', `/v1/finance/energy-bills/${bill.json().id}/void`, { reason: 'Wrong meter' })).statusCode, 200);
    assert.equal((await call('POST', `/v1/finance/sites/${site}/energy-bills`, { month: '2026-09', amount: 720_000, kwhBilled: 440 })).statusCode, 201, 'replaced after the void');
    const t = (await call('GET', '/v1/finance/energy/trend?months=3')).json();
    assert.ok(t.months.some((m: any) => m.month === '2026-09' && m.revenue === 1_125_000));
  });
});

dbDescribe('Budgets vs actuals', () => {
  test('organisation and site lines, the variance; site lines are revenue and energy only; copy forward', async () => {
    assert.equal((await call('PUT', '/v1/finance/budgets', { month: '2026-09', siteId: site, revenue: 900_000, fees: 10 })).statusCode, 422);
    assert.equal((await call('PUT', '/v1/finance/budgets', { month: '2026-09', siteId: site, revenue: 900_000, energyCost: 600_000 })).statusCode, 200);
    assert.equal((await call('PUT', '/v1/finance/budgets', { month: '2026-09', currency: 'IDR', revenue: 1_200_000, energyCost: 700_000, fees: 1000, ownerShare: 0 })).statusCode, 200);
    const c = (await call('GET', '/v1/finance/budgets?month=2026-09')).json();
    const s = c.sites.find((x: any) => x.siteId === site);
    assert.deepEqual({ a: s.lines.revenue.actual, v: s.lines.revenue.variance, e: s.lines.energyCost.variance.amount, f: s.lines.fees.actual }, { a: 1_000_000, v: { amount: 100_000, pct: 11.1 }, e: 120_000, f: null });
    const o = c.organisation.find((x: any) => x.currency === 'IDR');
    assert.deepEqual({ rev: o.lines.revenue.actual, fees: o.lines.fees.actual }, { rev: 1_125_000, fees: 777 });
    assert.equal((await call('POST', '/v1/finance/budgets/copy', { from: '2026-09', months: 2 })).json().copied, 4);
    assert.ok((await call('GET', '/v1/finance/budgets?month=2026-11')).json().sites.find((x: any) => x.siteId === site).budgeted);
  });

  test('the off-track alert, from the 7th, on the month to date', async () => {
    await call('PUT', '/v1/finance/budgets', { month: '2026-09', siteId: site, revenue: 3_000_000, energyCost: 600_000 });
    assert.equal(await budgets.checkOffTrack(new Date('2026-09-03T05:00:00Z')), 0, 'not before the 7th');
    assert.ok(await budgets.checkOffTrack(new Date('2026-09-30T05:00:00Z')) >= 1);
    const a = await one<any>(`SELECT message FROM alert WHERE org_id = $1 AND kind = 'finance.budget_off_track' AND resolved_at IS NULL AND target_id LIKE '2026-09:' || $2 || ':%'`, [org, site]);
    assert.match(a!.message, /revenue \d+% of the budget/);
    assert.match(a!.message, /energy cost \d+% of the budget/);
  });
});

dbDescribe('Collections and dunning', () => {
  test('aging; notes and promises; a reminder now; the schedule sends the latest step once and waits for a promise', async () => {
    let l = (await call('GET', '/v1/finance/collections')).json();
    const r = l.receivables.find((x: any) => x.ref === inv);
    assert.deepEqual({ out: r.outstanding, b: r.bucket, d: r.daysPastDue }, { out: 900_000, b: '31-60', d: 40 });
    assert.equal(l.aging.IDR['31-60'], 900_000);
    assert.equal((await call('GET', `/v1/finance/collections/platform_statement/${inv}`)).statusCode, 404, 'not a platform administrator');

    mails.length = 0;
    const rm = await call('POST', `/v1/finance/collections/fleet_invoice/${inv}/remind`, { channel: 'email' });
    assert.equal(rm.statusCode, 200, rm.body);
    assert.equal(mails.length, 1);
    assert.match(mails[0]!, /Subject: =\?UTF-8\?Q\?Overdue=3A_invoice_FI-/);
    assert.match(mails[0]!, /To: ap@fleet\.test/);
    assert.match(mails[0]!.replace(/=\r\n/g, ''), /40 days past its due date/);

    assert.equal((await call('PUT', '/v1/finance/collections/settings', { enabled: true, channels: ['whatsapp'] })).statusCode, 422, 'WhatsApp needs its template');
    assert.equal((await call('PUT', '/v1/finance/collections/settings', { enabled: true, steps: [-3, 7, 14, 30], channels: ['email'] })).statusCode, 200);
    mails.length = 0;
    assert.equal(await collections.sweepDunning(), 1, 'the latest step reached (30), not 7 and 14 too');
    assert.equal(await collections.sweepDunning(), 0, 'once');
    const h = (await call('GET', `/v1/finance/collections/fleet_invoice/${inv}`)).json();
    assert.deepEqual(h.reminders.map((x: any) => [x.step, x.manual]), [[30, false], [40, true]]);

    const future = localDays(5);
    assert.equal((await call('POST', `/v1/finance/collections/fleet_invoice/${inv}/notes`, { note: 'Will pay Friday', promiseDate: future })).statusCode, 201);
    await query(`UPDATE finance_org_settings SET dunning_steps = '{30,35}' WHERE org_id = $1`, [org]);
    assert.equal(await collections.sweepDunning(), 0, 'a promise to pay pauses the reminders');
    l = (await call('GET', '/v1/finance/collections')).json();
    assert.equal(l.receivables.find((x: any) => x.ref === inv).lastNote.promiseDate, future);
  });

  test('a write-off: by a second person; then out of collections', async () => {
    actor = A;
    assert.equal((await call('POST', `/v1/finance/collections/fleet_invoice/${inv}/write-off`, { reason: '' })).statusCode, 422);
    assert.equal((await call('POST', `/v1/finance/collections/fleet_invoice/${inv}/write-off`, { reason: 'x', amount: 2_000_000 })).statusCode, 422, 'no more than outstanding');
    const w = await call('POST', `/v1/finance/collections/fleet_invoice/${inv}/write-off`, { reason: 'Fleet company closed' });
    assert.equal(w.statusCode, 201, w.body);
    assert.equal((await call('POST', `/v1/finance/collections/fleet_invoice/${inv}/write-off`, { reason: 'again' })).statusCode, 409);
    assert.equal((await call('POST', `/v1/finance/write-offs/${w.json().id}/approve`)).statusCode, 403, 'not the requester');
    actor = B;
    assert.equal((await call('POST', `/v1/finance/write-offs/${w.json().id}/approve`)).statusCode, 200);
    const l = (await call('GET', '/v1/finance/collections')).json();
    assert.equal(l.receivables.some((x: any) => x.ref === inv), false);
    assert.equal(l.writtenOff[0].writeOff.amount, 900_000);
    actor = A;
  });
});

dbDescribe('The audit pack', () => {
  test('a ZIP: the CSVs, a manifest whose SHA-256s match, the audit chain checked', async () => {
    const r = await call('GET', `/v1/finance/accounts/${xenditId}/audit-pack?from=2026-09-01&to=${localDays(0)}`);
    assert.equal(r.statusCode, 200, r.body.slice(0, 300));
    assert.match(r.headers['content-type'] as string, /zip/);
    const files = unzip(r.rawPayload);
    for (const n of ['journal.csv', 'ledger.csv', 'statements.csv', 'statement-payments.csv', 'transfers.csv', 'bank-lines.csv', 'tax-withholdings.csv', 'write-offs.csv', 'audit-log.csv', 'manifest.json', 'README.txt']) {
      assert.ok(files.has(n), n);
    }
    const m = JSON.parse(files.get('manifest.json')!.toString());
    for (const f of m.files) assert.equal(createHash('sha256').update(files.get(f.name)!).digest('hex'), f.sha256, f.name);
    assert.equal(createHash('sha256').update(files.get('manifest.json')!).digest('hex'), r.headers['x-manifest-sha256']);
    assert.equal(m.files.find((f: any) => f.name === 'ledger.csv').rows, 1);
    assert.equal(m.files.find((f: any) => f.name === 'write-offs.csv').rows, 1, 'the write-off approved above, today');
    assert.equal(typeof m.auditChain.ok, 'boolean');
    assert.match(files.get('audit-log.csv')!.toString(), /seq,ts,actor_type,actor,action/);
    assert.match(files.get('README.txt')!.toString(), /sha256sum journal\.csv/);
  });
});
