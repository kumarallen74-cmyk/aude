import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 16 of the finance review (v1.27.0):
 *   - finance digests: subscribing (checks), sending now (the reader's e-mail), the worker once a day at the hour;
 *   - energy tariffs: a site's tariff, its load by hour (peak share), the options compared, the price for a target
 *     margin, the saving from moving load off-peak;
 *   - owner documents: tax withheld recorded on a statement, the documents list, the payout advice and the yearly
 *     statement as PDF, in the operator's console and the Site Owner portal (its own owner only);
 *   - fleet automation: last month invoiced on the day, an invoice held for its e-Faktur number, then sent with a
 *     Xendit payment link; the link paid → the invoice paid.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase16.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const { registerOwnerPortalRoutes } = await import('../api/owner-portal-routes.js');
const digest = await import('./finance-digest.js');
const fleetAuto = await import('./fleet-automation.js');
const store = await import('../integrations/store.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID(), OWNER_USER = randomUUID();
let org = '', site = '', cp = '', conn = '', owner = '', other = '', integ = '', acct = '', token = '';
let app: FastifyInstance;
let principal: any = null;
const zone = config.billing.timeZone;
const localDay = (t: number = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(t));
const lastMonth = () => {
  let [y, m] = localDay().slice(0, 7).split('-').map(Number) as [number, number];
  m--; if (m === 0) { m = 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
};
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });
const asOperator = () => { principal = { userId: A, orgId: org, assignments: [{ permissions: ['payment:read', 'payment:write', 'invoice:read', 'invoice:write'], scopeType: 'org', scopeId: null }] }; };

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

const invoices = new Map<string, any>();
const xendit = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/v2/invoices') {
      const b = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const id = `inv_${randomBytes(4).toString('hex')}`;
      const v = { id, external_id: b.external_id, amount: b.amount, status: 'PENDING', invoice_url: `https://checkout.xendit.test/${id}`, expiry_date: new Date(Date.now() + 86_400_000).toISOString() };
      invoices.set(id, v); res.end(JSON.stringify(v)); return;
    }
    const m = /^\/v2\/invoices\/([\w-]+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && m && invoices.has(m[1]!)) { res.end(JSON.stringify(invoices.get(m[1]!))); return; }
    res.statusCode = 404; res.end('{}');
  });
});

/** A session at the site ending at a local time (YYYY-MM-DDTHH:MM), lasting an hour. */
async function session(localEnd: string, wh: number, minor: number, extra: { token?: string; fleet?: string } = {}) {
  const end = new Date(`${localEnd}:00+07:00`);
  const s = (await one<{ id: string }>(
    `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, token_id, started_at, ended_at, energy_wh, state, fleet_account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'rated', $10) RETURNING id`,
    [org, site, conn, cp, `p16-${randomUUID()}`, extra.token ?? null, new Date(end.getTime() - 3_600_000), end, wh, extra.fleet ?? null]))!.id;
  await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency)
               VALUES ($1, $2, $3, '[]', $4, 0, 0, $4, 1100, $5, $6, '{}', 'IDR')`, [s, org, end, minor, Math.round(minor * 0.11), minor + Math.round(minor * 0.11)]);
  return s;
}

if (DB_OK) {
  before(async () => {
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', () => r()));
    smtpPort = (smtp.address() as any).port;
    await new Promise<void>((r) => xendit.listen(0, '127.0.0.1', () => r()));
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug, npwp, pkp) VALUES ($1, $2, '0123456789012345', true) RETURNING id`, [`P16 ${TAG}`, `p16-${TAG}`]))!.id;
    await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, 'Rina'), ($4, $2, $5, 'Pak Budi')`, [A, org, `rina-${TAG}@p16.test`, OWNER_USER, `budi-${TAG}@hotel.test`]);
    await query(`INSERT INTO notification_channel (org_id, kind, enabled, config) VALUES ($1, 'email', true, $2)`,
      [org, JSON.stringify({ host: '127.0.0.1', port: smtpPort, security: 'none', fromAddress: 'finance@op.test', fromName: 'Operator Finance' })]);
    integ = ((await store.save('payments', org, { provider: 'xendit', settings: { environment: 'sandbox', methods: ['QRIS'], baseUrl: `http://127.0.0.1:${(xendit.address() as any).port}` }, secrets: { secretKey: `xnd_development_${TAG}`, callbackToken: 'cb' } }, null)) as any).id;
    site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'ID') RETURNING id`, [org, `Bekasi ${TAG}`]))!.id;
    cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name) VALUES ($1, $2, $2) RETURNING id`, [site, `P16-${TAG}`]))!.id;
    const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [cp]))!.id;
    conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, max_power_w) VALUES ($1, 60000) RETURNING id`, [e]))!.id;
    owner = (await one<{ id: string }>(`INSERT INTO site_owner (org_id, name, legal_name) VALUES ($1, $2, 'PT Hotel Bekasi') RETURNING id`, [org, `Hotel ${TAG}`]))!.id;
    other = (await one<{ id: string }>(`INSERT INTO site_owner (org_id, name) VALUES ($1, $2) RETURNING id`, [org, `Mall ${TAG}`]))!.id;
    asOperator();
    app = Fastify();
    app.addHook('onRequest', async (req) => { (req as any).principal = principal; });
    await registerFinanceRoutes(app);
    await registerOwnerPortalRoutes(app);
  });
  after(async () => {
    smtp.close(); xendit.close();
    await app?.close();
    for (const t of ['fleet_invoice_link', 'finance_digest_send', 'finance_digest_subscription', 'site_tariff', 'tax_withholding', 'statement_payment', 'finance_org_settings']) await query(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
    await query(`DELETE FROM fleet_invoice_item WHERE org_id = $1`, [org]);
    await query(`DELETE FROM fleet_invoice WHERE org_id = $1`, [org]);
    await query(`DELETE FROM commission_statement WHERE org_id = $1`, [org]);
    await query(`DELETE FROM cdr WHERE org_id = $1`, [org]);
    await query(`DELETE FROM charging_session WHERE org_id = $1`, [org]);
    await query(`DELETE FROM token WHERE org_id = $1`, [org]);
    await query(`DELETE FROM fleet_account WHERE org_id = $1`, [org]);
    await query(`DELETE FROM site_owner WHERE org_id = $1`, [org]);
    await query(`DELETE FROM connector WHERE id = $1`, [conn]);
    await query(`DELETE FROM evse WHERE charge_point_id = $1`, [cp]);
    await query(`DELETE FROM charge_point WHERE id = $1`, [cp]);
    await query(`DELETE FROM site WHERE org_id = $1`, [org]);
    await query(`DELETE FROM integration WHERE id = $1`, [integ]);
    await query(`DELETE FROM notification_channel WHERE org_id = $1`, [org]);
    await query(`DELETE FROM alert WHERE org_id = $1`, [org]);
    await query(`DELETE FROM app_user WHERE org_id = $1`, [org]).catch(() => { /* audit rows keep them */ });
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => { /* audit rows keep it */ });
    await pool.end();
  });
}

dbDescribe('Energy tariffs', () => {
  test('the site\'s tariff; the load by hour; the options; the price for a target; moving load off-peak', async () => {
    asOperator();
    // Last month: half the energy at 18:00–19:00 (peak), half at 02:00–03:00.
    const lm = lastMonth();
    await session(`${lm}-10T19:00`, 50_000, 125_000);
    await session(`${lm}-11T03:00`, 50_000, 125_000);
    assert.equal((await call('PUT', `/v1/finance/tariffs/sites/${site}`, { tariffClass: 'B-3', powerKva: 0 })).statusCode, 422);
    assert.equal((await call('PUT', `/v1/finance/tariffs/sites/${site}`, { tariffClass: 'B-3', powerKva: 240, peakFrom: 22, peakTo: 17 })).statusCode, 422);
    const t = await call('PUT', `/v1/finance/tariffs/sites/${site}`, { tariffClass: 'B-3', powerKva: 240 });
    assert.equal(t.statusCode, 200, t.body);
    assert.deepEqual({ p: t.json().ratePeak, o: t.json().rateOffpeak, f: t.json().peakFrom }, { p: 1450.09, o: 1035.78, f: 17 }, 'the catalogue\'s rates by default');
    const s = (await call('GET', `/v1/finance/tariffs/sites/${site}/simulate?months=3&targetMarginPct=40&shiftPct=50`)).json();
    assert.equal(s.load.kwh, 100);
    assert.equal(s.load.peakSharePct, 50);
    assert.equal(s.load.hours[18], 50);
    assert.equal(s.revenuePerKwh, 2500);
    const cur = s.options.find((o: any) => o.current);
    assert.equal(cur.costPerKwh, 1242.94, '(1450.09 + 1035.78) / 2');
    assert.ok(Math.abs(cur.priceForTarget - 1242.94 / 0.6) < 0.02, 'cost ÷ (1 − 40%)');
    assert.ok(s.options.some((o: any) => o.id === 'SPKLU'), 'the SPKLU bulk tariff is compared');
    assert.equal(s.cheapest, 'SPKLU');
    assert.ok(s.shift.savingPerMonth > 0, 'moving half the peak load saves money');
    assert.match(s.recommendation, /margin/);
  });
});

dbDescribe('Owner documents', () => {
  test('tax withheld; the documents; the payout advice and the yearly statement; the portal sees only its owner', async () => {
    asOperator();
    const st = (await one<{ id: string }>(
      `INSERT INTO commission_statement (org_id, owner_id, period, number, gtv_minor, commission_minor, minimum_topup_minor, private_fee_minor, mdr_credit_minor,
                                         net_minor, tax_minor, total_minor, owner_share_minor, data, finalised_at, currency)
       VALUES ($1, $2, '2026-09-01', $3, 10000000, 1000000, 0, 0, 0, 1000000, 110000, 1110000, 2000000, '{}', now() - interval '20 days', 'IDR') RETURNING id`, [org, owner, `OS16-${TAG}`]))!.id;
    const pay = (await one<{ id: string }>(`INSERT INTO statement_payment (org_id, statement_id, kind, owner_id, amount_minor, currency, paid_on, reference, recorded_by) VALUES ($1, $2, 'owner_payout', $3, 1800000, 'IDR', '2026-10-15', 'TRF-OWN-1', $4) RETURNING id`, [org, st, owner, A]))!.id;
    assert.equal((await call('POST', `/v1/finance/owners/${owner}/withholdings`, { statementId: st, ratePct: 40 })).statusCode, 422, 'at most 30%');
    const w = await call('POST', `/v1/finance/owners/${owner}/withholdings`, { statementId: st, ratePct: 10, bukti: '2610-00123', buktiDate: '2026-10-15' });
    assert.equal(w.statusCode, 201, w.body);
    assert.equal(w.json().amount, 200_000, '10% of the share');
    const d = (await call('GET', `/v1/finance/owners/${owner}/documents`)).json();
    assert.deepEqual({ adv: d.advices.length, wh: d.withholdings[0].bukti, yrs: d.years }, { adv: 1, wh: '2610-00123', yrs: ['2026'] });
    const y = await call('GET', `/v1/finance/owners/${owner}/documents/year/2026`);
    assert.equal(y.rawPayload.subarray(0, 5).toString(), '%PDF-');

    // The Site Owner portal: its own owner only.
    principal = { userId: OWNER_USER, orgId: org, ownerIds: [owner], assignments: [{ permissions: [], scopeType: 'owner', scopeId: owner }] };
    const pd = (await call('GET', '/v1/owner-portal/documents')).json();
    assert.equal(pd.advices[0].reference, 'TRF-OWN-1');
    const adv = await call('GET', `/v1/owner-portal/documents/advice/${pay}`);
    assert.equal(adv.statusCode, 200);
    assert.equal(adv.rawPayload.subarray(0, 5).toString(), '%PDF-');
    assert.equal((await call('GET', '/v1/owner-portal/documents/year/2026')).statusCode, 200);
    principal = { userId: OWNER_USER, orgId: org, ownerIds: [other], assignments: [{ permissions: [], scopeType: 'owner', scopeId: other }] };
    assert.equal((await call('GET', `/v1/owner-portal/documents/advice/${pay}`)).statusCode, 404, 'another owner\'s payment');
    assert.equal((await call('GET', '/v1/owner-portal/documents')).json().advices.length, 0);
    asOperator();
  });
});

dbDescribe('Fleet invoicing automation', () => {
  test('issued on the day; held for the e-Faktur number; sent with a payment link; the link paid → the invoice paid', async () => {
    asOperator();
    acct = (await one<{ id: string }>(`INSERT INTO fleet_account (org_id, name, legal_name, billing_email, tax_id, tax_id_kind) VALUES ($1, $2, 'PT Armada', 'ap@armada.test', '0987654321098765', 'TIN') RETURNING id`, [org, `Armada ${TAG}`]))!.id;
    token = (await one<{ id: string }>(`INSERT INTO token (org_id, kind, uid, account_type, fleet_name) VALUES ($1, 'rfid', $2, 'fleet', $3) RETURNING id`, [org, `FL16${TAG}`, `Armada ${TAG}`]))!.id;
    await session(`${lastMonth()}-12T10:00`, 30_000, 90_000, { token, fleet: acct });
    assert.equal((await call('PUT', '/v1/finance/fleet-automation', { issueDay: 31 })).statusCode, 422);
    const s = await call('PUT', '/v1/finance/fleet-automation', { autoIssue: true, issueDay: 1, autoSend: true, requireEfaktur: true, paymentLinks: true });
    assert.equal(s.statusCode, 200, s.body);
    const r1 = await fleetAuto.run(org);
    assert.equal(r1.issued.length, 1, JSON.stringify(r1));
    assert.equal(r1.sent.length, 0);
    assert.match(r1.held[0]!.hold, /e-Faktur/);
    const inv = (await one<{ id: string; tax_minor: string }>(`SELECT id, tax_minor FROM fleet_invoice WHERE fleet_account_id = $1`, [acct]))!;
    assert.ok(Number(inv.tax_minor) > 0);
    assert.equal((await fleetAuto.run(org)).issued.length, 0, 'the month is invoiced once');

    await query(`UPDATE fleet_invoice SET efaktur_number = '04002600000001' WHERE id = $1`, [inv.id]);
    const before = mails.length;
    const r2 = (await call('POST', '/v1/finance/fleet-automation/run')).json();
    assert.equal(r2.sent.length, 1, JSON.stringify(r2));
    assert.equal(mails.length - before, 1);
    assert.match(mails.at(-1)!.replace(/=\r\n/g, ''), /checkout\.xendit\.test/, 'the payment link is in the e-mail');
    const p = (await call('GET', '/v1/finance/fleet-automation')).json();
    assert.equal(p.toSend.length, 0);
    const link = p.links[0];
    assert.equal(link.status, 'pending');

    const x = [...invoices.values()].find((v) => v.external_id.startsWith('FI-'))!;
    Object.assign(x, { status: 'PAID', paid_at: new Date().toISOString(), payment_method: 'BANK_TRANSFER' });
    await fleetAuto.sweep();
    const paid = await one<any>(`SELECT status, paid_reference FROM fleet_invoice WHERE id = $1`, [inv.id]);
    assert.equal(paid.status, 'paid');
    assert.match(paid.paid_reference, /^Xendit FI-/);
  });
});

dbDescribe('Finance digests', () => {
  test('subscribing; sending now; the worker once a day at the hour', async () => {
    asOperator();
    assert.equal((await call('PUT', '/v1/finance/digest', { frequency: 'hourly' })).statusCode, 422);
    assert.equal((await call('PUT', '/v1/finance/digest', { frequency: 'daily', channels: ['whatsapp'] })).statusCode, 422, 'a number');
    const s = await call('PUT', '/v1/finance/digest', { frequency: 'daily', channels: ['email'], hour: 0, sections: ['figures', 'approvals', 'overdue', 'anomalies'] });
    assert.equal(s.statusCode, 200, s.body);
    const before = mails.length;
    const r = (await call('POST', '/v1/finance/digest/send')).json();
    assert.deepEqual(r.results.map((x: any) => x.ok), [true]);
    assert.match(r.text, /Waiting for approval/);
    assert.match(r.text, /Overdue/);
    assert.equal(mails.length - before, 1);
    assert.match(mails.at(-1)!, new RegExp(`To: rina-${TAG}@p16\\.test`));
    assert.equal(await digest.sweep(), 0, 'sent by hand today: not again');
    // Tomorrow, as it were: the worker sends it once at the hour.
    await query(`UPDATE finance_digest_subscription SET last_sent_at = now() - interval '1 day' WHERE user_id = $1`, [A]);
    assert.equal(await digest.sweep(), 1);
    assert.equal(await digest.sweep(), 0, 'once a day');
    assert.equal((await call('GET', '/v1/finance/digest')).json().sends.length, 2);
  });
});
