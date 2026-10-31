import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';

/**
 * Phase 14 of the finance review (v1.25.0):
 *   - operator invoicing: a fee statement as an invoice (PDF, e-mailed to the operator's billing address, logged);
 *     a Xendit payment link on PlugSure's own account, polled: paid → the payment recorded on the statement; the
 *     operator's statement of account; the automatic send and a reminder, once each;
 *   - roaming settlement: receivable (our records of the partner's drivers) and payable (its records of ours) per
 *     month and currency, hubs left out; finalised once, an ended month only; a payment received, more refused;
 *     matched on the bank statement (roaming_payment), and then not voidable;
 *   - controls: the change log (finance actions only, CSV), the segregation-of-duties findings (a month reopened
 *     by who locked it, a payment recorded and matched by one person, too few approvers), an acknowledgement, the
 *     workbook.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase14.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const inv = await import('./operator-invoicing.js');
const store = await import('../integrations/store.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID(), B = randomUUID();
let platformOrg = '', operator = '', org = '', site = '', cp = '', conn = '', integ = '', partner = '', hub = '';
let stmt1 = '', stmt2 = '';
let app: FastifyInstance;
let actor = A;
let perms = ['payment:read', 'payment:write', 'audit:read', 'finance:approve', 'platform:admin'];
let actingOrg = () => platformOrg;
const zone = config.billing.timeZone;
const localDay = (t: number = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(t));
const lastMonth = () => {
  let [y, m] = localDay().slice(0, 7).split('-').map(Number) as [number, number];
  m--; if (m === 0) { m = 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
};
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });

// A fake SMTP server: keeps each message.
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

// A fake Xendit: invoices created and read back; paid when told to.
const invoices = new Map<string, any>();
const xendit = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/v2/invoices') {
      const b = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const id = `inv_${randomBytes(4).toString('hex')}`;
      const v = { id, external_id: b.external_id, amount: b.amount, currency: b.currency, status: 'PENDING', invoice_url: `https://checkout.xendit.test/${id}`, expiry_date: new Date(Date.now() + 86_400_000).toISOString() };
      invoices.set(id, v);
      res.end(JSON.stringify(v)); return;
    }
    const m = /^\/v2\/invoices\/([\w-]+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && m && invoices.has(m[1]!)) { res.end(JSON.stringify(invoices.get(m[1]!))); return; }
    res.statusCode = 404; res.end('{"error_code":"NOT_FOUND"}');
  });
});

if (DB_OK) {
  before(async () => {
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', () => r()));
    smtpPort = (smtp.address() as any).port;
    await new Promise<void>((r) => xendit.listen(0, '127.0.0.1', () => r()));
    platformOrg = (await one<{ id: string }>(`INSERT INTO organisation (name, slug, billing_address) VALUES ($1, $2, 'Jl. Sudirman 1, Jakarta') RETURNING id`, [`PlugSure ${TAG}`, `p14-plat-${TAG}`]))!.id;
    operator = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Operator ${TAG}`, `p14-op-${TAG}`]))!.id;
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Roamer ${TAG}`, `p14-ro-${TAG}`]))!.id;
    await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, 'Rina'), ($4, $2, $5, 'Budi')`, [A, platformOrg, `${A.slice(0, 8)}@p14.test`, B, `${B.slice(0, 8)}@p14.test`]);
    await query(`INSERT INTO notification_channel (org_id, kind, enabled, config) VALUES ($1, 'email', true, $2)`,
      [platformOrg, JSON.stringify({ host: '127.0.0.1', port: smtpPort, security: 'none', fromAddress: 'billing@plugsure.test', fromName: 'PlugSure Billing' })]);
    integ = ((await store.save('payments', null, { provider: 'xendit', settings: { environment: 'sandbox', methods: ['QRIS'], baseUrl: `http://127.0.0.1:${(xendit.address() as any).port}` }, secrets: { secretKey: `xnd_development_${TAG}`, callbackToken: 'cb' } }, null)) as any).id;
    const fin = (n: string, period: string, total: number, daysAgo: number) => one<{ id: string }>(
      `INSERT INTO commission_statement (org_id, period, number, gtv_minor, commission_minor, minimum_topup_minor, private_fee_minor, mdr_credit_minor, net_minor, tax_minor, total_minor, data, finalised_at, currency)
       VALUES ($1, $2, $3, 10000000, $4, 0, 0, 0, $4, $5, $6, '{}'::jsonb, now() - make_interval(days => $7), 'IDR') RETURNING id`,
      [operator, `${period}-01`, n, Math.round(total / 1.11), total - Math.round(total / 1.11), total, daysAgo]);
    stmt1 = (await fin(`PS-${TAG}-1`, '2026-08', 1_110_000, 40))!.id;
    stmt2 = (await fin(`PS-${TAG}-2`, '2026-09', 555_000, 2))!.id;

    // Roaming: our charger, a peer partner and a hub.
    site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'ID') RETURNING id`, [org, `Bandung ${TAG}`]))!.id;
    cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name) VALUES ($1, $2, $2) RETURNING id`, [site, `P14-${TAG}`]))!.id;
    const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [cp]))!.id;
    conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, max_power_w) VALUES ($1, 60000) RETURNING id`, [e]))!.id;
    partner = (await one<{ id: string }>(`INSERT INTO ocpi_partner (org_id, name, kind, state, country_code, party_id) VALUES ($1, $2, 'emsp', 'connected', 'ID', 'ABC') RETURNING id`, [org, `Peer ${TAG}`]))!.id;
    hub = (await one<{ id: string }>(`INSERT INTO ocpi_partner (org_id, name, kind, state, country_code, party_id) VALUES ($1, $2, 'hub', 'connected', 'ID', 'HUB') RETURNING id`, [org, `Hub ${TAG}`]))!.id;
    const mid = Date.parse(`${lastMonth()}-15T05:00:00Z`);
    const sess = async (p: string, minor: number) => {
      const s = (await one<{ id: string }>(
        `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, ended_at, energy_wh, state, ocpi_partner_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 20000, 'rated', $8) RETURNING id`, [org, site, conn, cp, `p14-${randomUUID()}`, new Date(mid - 3_600_000), new Date(mid), p]))!.id;
      await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency)
                   VALUES ($1, $2, $3, '[]'::jsonb, $4, 0, 0, 0, 0, 0, $4, '{}'::jsonb, 'IDR')`, [s, org, new Date(mid), minor]);
    };
    await sess(partner, 300_000);
    await sess(partner, 200_000);
    await sess(hub, 999_000);
    await query(
      `INSERT INTO ocpi_remote_cdr (org_id, partner_id, country_code, party_id, cdr_id, data, currency, total_excl_vat, total_incl_vat, total_energy, start_date_time, end_date_time, status)
       VALUES ($1, $2, 'ID', 'ABC', $3, '{}', 'IDR', 100000, 111000, 10, $4, $5, 'accepted'), ($1, $2, 'ID', 'ABC', $6, '{}', 'IDR', 50000, 55500, 5, $4, $5, 'held')`,
      [org, partner, `R1-${TAG}`, new Date(mid - 3_600_000), new Date(mid), `R2-${TAG}`]);

    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: actor, orgId: actingOrg(), assignments: [{ permissions: perms, scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
  });
  after(async () => {
    smtp.close(); xendit.close();
    await app?.close();
    await query(`UPDATE bank_statement_line SET matched_kind = NULL, matched_ref = NULL WHERE org_id = $1`, [org]);
    for (const t of ['bank_statement_line', 'bank_statement', 'roaming_settlement_payment', 'roaming_settlement']) await query(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
    await query(`DELETE FROM platform_invoice_link WHERE org_id = $1`, [operator]);
    await query(`DELETE FROM platform_invoice_send WHERE org_id = $1`, [operator]);
    await query(`DELETE FROM statement_payment WHERE org_id = $1`, [operator]);
    await query(`DELETE FROM commission_statement WHERE org_id = $1`, [operator]);
    await query(`DELETE FROM finance_period_lock WHERE org_id = $1`, [platformOrg]);
    await query(`DELETE FROM finance_org_settings WHERE org_id = ANY($1::uuid[])`, [[platformOrg, org]]);
    await query(`DELETE FROM notification_channel WHERE org_id = $1`, [platformOrg]);
    await query(`DELETE FROM integration WHERE id = $1`, [integ]);
    await query(`DELETE FROM ocpi_remote_cdr WHERE org_id = $1`, [org]);
    await query(`DELETE FROM cdr WHERE org_id = $1`, [org]);
    await query(`DELETE FROM charging_session WHERE org_id = $1`, [org]);
    await query(`DELETE FROM ocpi_partner WHERE org_id = $1`, [org]);
    await query(`DELETE FROM connector WHERE id = $1`, [conn]);
    await query(`DELETE FROM evse WHERE charge_point_id = $1`, [cp]);
    await query(`DELETE FROM charge_point WHERE id = $1`, [cp]);
    await query(`DELETE FROM site WHERE org_id = $1`, [org]);
    await query(`DELETE FROM alert WHERE org_id = ANY($1::uuid[])`, [[platformOrg, org]]);
    await query(`DELETE FROM app_user WHERE org_id = $1`, [platformOrg]).catch(() => { /* audit rows keep them */ });
    for (const o of [platformOrg, operator, org]) await query(`DELETE FROM organisation WHERE id = $1`, [o]).catch(() => { /* audit rows keep it */ });
    await pool.end();
  });
}

dbDescribe('Operator invoicing of PlugSure fees', () => {
  test('the invoice e-mailed with its PDF; a payment link paid at Xendit is recorded; the statement of account', async () => {
    actor = A; actingOrg = () => platformOrg;
    perms = ['payment:read', 'payment:write', 'audit:read', 'finance:approve', 'platform:admin'];
    const l = (await call('GET', `/v1/finance/platform-invoices?operatorId=${operator}`)).json();
    assert.equal(l.invoices.length, 2);
    const one1 = l.invoices.find((x: any) => x.statementId === stmt1);
    assert.deepEqual({ st: one1.status, out: one1.outstanding }, { st: 'overdue', out: 1_110_000 }, 'issued 40 days ago, 14-day terms');

    assert.equal((await call('POST', `/v1/finance/platform-invoices/${stmt1}/send`, {})).statusCode, 422, 'no billing e-mail yet');
    assert.equal((await call('PUT', `/v1/finance/operators/${operator}/billing-email`, { billingEmail: 'not-an-email' })).statusCode, 422);
    assert.equal((await call('PUT', `/v1/finance/operators/${operator}/billing-email`, { billingEmail: 'ap@operator.test' })).statusCode, 200);

    const sent = await call('POST', `/v1/finance/platform-invoices/${stmt1}/send`, { link: true });
    assert.equal(sent.statusCode, 200, sent.body);
    assert.match(sent.json().link, /^https:\/\/checkout\.xendit\.test\//, 'a payment link was made and is in the e-mail');
    const mail = mails.at(-1)!;
    assert.match(mail, /Invoice_PS-/);
    assert.match(mail, /application\/pdf/);
    assert.match(mail, /checkout\.xendit\.test/);
    const pdf = await call('GET', `/v1/finance/platform-invoices/${stmt1}/pdf`);
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf.rawPayload.subarray(0, 5).toString(), '%PDF-');

    const d = (await call('GET', `/v1/finance/platform-invoices/${stmt1}`)).json();
    assert.equal(d.link.amount, 1_110_000);
    assert.equal(d.sends.length, 1);
    assert.equal((await call('POST', `/v1/finance/platform-invoices/${stmt1}/link`)).json().id, d.link.id, 'one open link per statement');

    // Still pending at Xendit; then paid.
    assert.equal((await call('POST', `/v1/finance/platform-invoices/${stmt1}/link/check`)).json().state, 'pending');
    const x = invoices.get([...invoices.keys()][0]!)!;
    Object.assign(x, { status: 'PAID', paid_at: new Date().toISOString(), paid_amount: 1_110_000, payment_method: 'BANK_TRANSFER' });
    const chk = (await call('POST', `/v1/finance/platform-invoices/${stmt1}/link/check`)).json();
    assert.equal(chk.state, 'paid');
    assert.deepEqual({ paid: chk.invoice.paid, out: chk.invoice.outstanding }, { paid: 1_110_000, out: 0 });
    const p = await one<any>(`SELECT kind, amount_minor, reference FROM statement_payment WHERE statement_id = $1`, [stmt1]);
    assert.equal(p.kind, 'platform_fee');
    assert.match(p.reference, /^Xendit PSF-/);
    assert.equal(await inv.checkLink(platformOrg, d.link.id), 'paid', 'checked again: recorded once');
    assert.equal(Number((await one<any>(`SELECT count(*) AS n FROM statement_payment WHERE statement_id = $1`, [stmt1])).n), 1);

    const acct = (await call('GET', `/v1/finance/operators/${operator}/fee-account`)).json();
    assert.deepEqual({ inv: acct.currencies[0].invoiced, paid: acct.currencies[0].paid, bal: acct.currencies[0].balance }, { inv: 1_665_000, paid: 1_110_000, bal: 555_000 });
    const csv = await call('GET', `/v1/finance/operators/${operator}/fee-account?format=csv`);
    assert.match(csv.body, /"payment"/);

    // Someone without platform:admin sees none of it.
    perms = ['payment:read', 'payment:write'];
    assert.equal((await call('GET', '/v1/finance/platform-invoices')).statusCode, 403);
    perms = ['payment:read', 'payment:write', 'audit:read', 'finance:approve', 'platform:admin'];
  });

  test('automatic: each statement e-mailed once, and a reminder when one is reached', async () => {
    assert.equal((await call('PUT', '/v1/finance/platform-invoices/settings', { autoSend: true, reminderDays: [-30], linkDays: 0 })).statusCode, 422);
    const s = await call('PUT', '/v1/finance/platform-invoices/settings', { autoSend: true, autoLink: false, reminderDays: '-30' });
    assert.equal(s.statusCode, 422, 'reminders are -14 to 180 days');
    assert.equal((await call('PUT', '/v1/finance/platform-invoices/settings', { autoSend: true, autoLink: false, reminderDays: [-12] })).statusCode, 200);
    const before = mails.length;
    const r1 = await inv.sweep();
    assert.equal(r1.sent, 1, 'the second statement (the first was sent by hand)');
    const r2 = await inv.sweep();
    assert.equal(r2.sent, 0, 'not again');
    assert.equal(r2.reminded, 1, 'due in 12 days: the -12 reminder is reached');
    assert.equal((await inv.sweep()).reminded, 0, 'once');
    assert.equal(mails.length - before, 2);
    assert.match(mails.at(-1)!, /Payment_reminder/);
  });
});

dbDescribe('Roaming settlement', () => {
  test('per partner and month; hubs left out; finalised once; paid; matched on the bank statement', async () => {
    actor = A; actingOrg = () => org;
    perms = ['payment:read', 'payment:write', 'audit:read'];
    const m = lastMonth();
    const o = (await call('GET', `/v1/finance/roaming?month=${m}`)).json();
    assert.equal(o.rows.length, 1, 'the hub is not a settlement partner');
    const row = o.rows[0];
    assert.deepEqual(row.live, { receivable: 500_000, payable: 111_000, net: 389_000, receivableCdrs: 2, payableCdrs: 1 }, 'held partner records are not owed');
    assert.equal(row.settlement, null);
    const d = (await call('GET', `/v1/finance/roaming/partners/${partner}?month=${m}`)).json();
    assert.deepEqual({ c: d.currency, r: d.receivable.length, p: d.payable.length }, { c: 'IDR', r: 2, p: 1 });

    assert.equal((await call('POST', `/v1/finance/roaming/partners/${partner}/settle`, { month: localDay().slice(0, 7), currency: 'IDR' })).statusCode, 409, 'this month has not ended');
    assert.equal((await call('POST', `/v1/finance/roaming/partners/${hub}/settle`, { month: m, currency: 'IDR' })).statusCode, 404);
    const st = await call('POST', `/v1/finance/roaming/partners/${partner}/settle`, { month: m, currency: 'IDR' });
    assert.equal(st.statusCode, 200, st.body);
    const s = st.json();
    assert.deepEqual({ net: s.net, dir: s.direction, out: s.outstanding, status: s.status }, { net: 389_000, dir: 'receive', out: 389_000, status: 'open' });
    assert.match(s.number, /^RS-\d{6}-ABC-IDR-/);
    assert.equal((await call('POST', `/v1/finance/roaming/partners/${partner}/settle`, { month: m, currency: 'IDR' })).statusCode, 409, 'once');

    assert.equal((await call('POST', `/v1/finance/roaming/settlements/${s.id}/payments`, { amount: 400_000, paidOn: localDay(), reference: 'TRF-X' })).statusCode, 422, 'more than is outstanding');
    const p = await call('POST', `/v1/finance/roaming/settlements/${s.id}/payments`, { amount: 389_000, paidOn: localDay(), reference: `ROAM-${TAG}` });
    assert.equal(p.statusCode, 200, p.body);
    assert.deepEqual({ rec: p.json().recorded, status: p.json().status }, { rec: 'received', status: 'settled' });

    // The partner's transfer on the bank statement is matched to it.
    const [y, mo, dd] = localDay().split('-');
    const csv = ['Account No,Date,Val. Date,Transaction Code,Description,Reference No.,Debit,Credit,Balance',
      `1,${dd}/${mo}/${y},${dd}/${mo}/${y},1,TRF PEER ROAM-${TAG},,0.00,"389,000.00",`].join('\n');
    const up = (await call('POST', '/v1/finance/bank-statements', { filename: 'oct.csv', csv })).json();
    assert.equal(up.matched, 1);
    const line = await one<any>(`SELECT matched_kind, matched_ref FROM bank_statement_line WHERE org_id = $1`, [org]);
    assert.deepEqual(line, { matched_kind: 'roaming_payment', matched_ref: p.json().paymentId });
    assert.equal((await call('POST', `/v1/finance/roaming/payments/${p.json().paymentId}/void`, { reason: 'typo' })).statusCode, 409, 'matched: undo the match first');

    const again = (await call('GET', `/v1/finance/roaming?month=${m}`)).json();
    assert.equal(again.rows[0].settlement.status, 'settled');
    assert.equal(again.rows[0].drift, 0);
    const out = await call('GET', `/v1/finance/roaming?month=${m}&format=csv`);
    assert.match(out.body, /"settled"/);
  });
});

dbDescribe('Finance controls', () => {
  test('the change log; findings; an acknowledgement; the workbook', async () => {
    actor = A; actingOrg = () => platformOrg;
    perms = ['payment:read', 'payment:write', 'audit:read', 'finance:approve', 'platform:admin'];
    const log = (await call('GET', '/v1/finance/change-log')).json();
    assert.ok(log.entries.some((e: any) => e.action === 'finance.platform_invoice_sent'), 'the invoice sent above');
    assert.ok(log.entries.every((e: any) => /^(finance|billing|refund|fleet_|site_owner|owner|controls)/.test(e.action)));
    const csv = await call('GET', '/v1/finance/change-log?format=csv&action=finance.platform_invoice');
    assert.match(csv.body, /finance\.platform_invoice_sent/);
    assert.equal((await call('GET', '/v1/finance/change-log?from=2026-10-10&to=2026-10-01')).statusCode, 422);

    // A month locked and reopened by the same person; nobody else holds finance:approve.
    const month = localDay().slice(0, 7);
    await query(`INSERT INTO finance_period_lock (org_id, month, locked_by, locked_at, reopened_by, reopened_at, reopen_reason) VALUES ($1, '2026-01', $2, now() - interval '1 day', $2, now(), 'Late bill')`, [platformOrg, A]);
    const r = (await call('GET', `/v1/finance/controls?month=${month}`)).json();
    const reopen = r.findings.find((f: any) => f.control === 'period_reopened_by_locker');
    assert.ok(reopen, 'reopened by who locked it');
    assert.match(reopen.detail, /Rina reopened 2026-01/);
    assert.ok(r.findings.some((f: any) => f.control === 'approvers_concentration'), 'no one in this organisation holds finance:approve by role');
    assert.equal(r.summary.find((s: any) => s.id === 'after_hours_payments').ran, false, 'not set');

    assert.equal((await call('POST', '/v1/finance/controls/acknowledge', { key: reopen.key })).statusCode, 422, 'a note');
    assert.equal((await call('POST', '/v1/finance/controls/acknowledge', { key: 'nonsense', note: 'x' })).statusCode, 422);
    assert.equal((await call('POST', '/v1/finance/controls/acknowledge', { key: reopen.key, note: 'Checked with the accountant: the late PLN bill.' })).statusCode, 200);
    const r2 = (await call('GET', `/v1/finance/controls?month=${month}`)).json();
    const ack = r2.findings.find((f: any) => f.key === reopen.key);
    assert.equal(ack.acknowledged.note, 'Checked with the accountant: the late PLN bill.');
    assert.equal(r2.summary.find((s: any) => s.id === 'period_reopened_by_locker').open, 0);

    assert.equal((await call('PUT', '/v1/finance/controls/settings', { workingHours: { from: 18, to: 8 } })).statusCode, 422);
    assert.equal((await call('PUT', '/v1/finance/controls/settings', { minApprovers: 1, workingHours: { from: 8, to: 18 } })).statusCode, 200);
    const r3 = (await call('GET', `/v1/finance/controls?month=${month}`)).json();
    assert.equal(r3.summary.find((s: any) => s.id === 'after_hours_payments').ran, true);

    const x = await call('GET', `/v1/finance/controls/report?month=${month}`);
    assert.equal(x.statusCode, 200);
    assert.equal(x.rawPayload.subarray(0, 2).toString(), 'PK');

    perms = ['payment:read'];
    assert.equal((await call('GET', '/v1/finance/change-log')).statusCode, 403, 'audit:read');
    assert.equal((await many(`SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'controls.finding_acknowledged'`, [platformOrg])).length, 1);
  });
});
