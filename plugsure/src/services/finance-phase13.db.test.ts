import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { many, one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { sigV4 } from './finance-warehouse.js';

/**
 * Phase 13 of the finance review (v1.24.0):
 *   - driver refund requests: what is refundable; approved automatically by the policy (the refund becomes due);
 *     reviewed otherwise (approve a smaller amount, reject with a note); one open per payment; the window;
 *   - fleet credit: owed against the limit, the 80% warning, cards blocked over the limit and unblocked when back
 *     (a card the customer blocked stays blocked); prepaid: a top-up pays the issued invoice automatically;
 *   - the data export: AWS Signature V4 (the documented example), a local export with its files, an S3 export to a
 *     fake store (signed PUTs), a refused store logged, the ZIP of a day;
 *   - year end: the summary, closing an ended year (every month locked), the pack with its manifest.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/finance-phase13.db.test.ts
 */

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const { registerFinanceRoutes } = await import('../api/finance-routes.js');
const { registerFleetRoutes } = await import('../api/fleet-routes.js');
const dr = await import('./driver-refunds.js');
const credit = await import('./fleet-credit-limits.js');
const wh = await import('./finance-warehouse.js');

const TAG = randomBytes(3).toString('hex');
const A = randomUUID();
let org = '', site = '', cp = '', conn = '', device = '', tokenId = '';
let app: FastifyInstance;
const zone = config.billing.timeZone;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });

// A fake S3-compatible store: records PUTs, refuses when told to.
const puts: Array<{ url: string; auth: string; sha: string; len: number }> = [];
let refuse = false;
const s3 = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    puts.push({ url: req.url ?? '', auth: String(req.headers.authorization ?? ''), sha: String(req.headers['x-amz-content-sha256'] ?? ''), len: body.length });
    if (refuse) { res.statusCode = 403; res.end('<Error><Code>AccessDenied</Code></Error>'); return; }
    res.statusCode = 200; res.end();
  });
});

/** A paid charge: payment captured, optionally a session with a charge record of `used`. */
async function paidCharge(captured: number, used: number | null, paidDaysAgo = 1, wh = 10_000) {
  const pi = (await one<{ id: string }>(
    `INSERT INTO payment_intent (org_id, provider, method, mode, state, amount_captured_minor, amount_authorised_minor, currency, paid_at, created_at)
     VALUES ($1, 'xendit', 'qris', 'prepurchase', 'captured', $2, $2, 'IDR', now() - make_interval(days => $3), now() - make_interval(days => $3)) RETURNING id`, [org, captured, paidDaysAgo]))!.id;
  if (used != null) {
    const sess = (await one<{ id: string }>(
      `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, ended_at, energy_wh, state, payment_intent_id)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 day', now() - interval '23 hours', $6, 'rated', $7) RETURNING id`, [org, site, conn, cp, `p13-${randomUUID()}`, wh, pi]))!.id;
    await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency)
                 VALUES ($1, $2, now() - interval '23 hours', '[]'::jsonb, $3, 0, 0, 0, 0, 0, $3, '{}'::jsonb, 'IDR')`, [sess, org, used]);
  }
  const dc = (await one<any>(
    `INSERT INTO driver_charge (device_id, org_id, connector_uuid, token_id, payment_intent_id, mode, amount_minor) VALUES ($1, $2, $3, $4, $5, 'prepaid', $6) RETURNING *`,
    [device, org, conn, tokenId, pi, captured]))!;
  return { pi, dc };
}

if (DB_OK) {
  before(async () => {
    await new Promise<void>((r) => s3.listen(0, '127.0.0.1', () => r()));
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`P13 ${TAG}`, `p13-${TAG}`]))!.id;
    await query(`INSERT INTO app_user (id, org_id, email, name) VALUES ($1, $2, $3, 'Rina')`, [A, org, `${A.slice(0, 8)}@p13.test`]);
    site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, $2, 'ID') RETURNING id`, [org, `Jakarta ${TAG}`]))!.id;
    cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, display_name) VALUES ($1, $2, $2) RETURNING id`, [site, `P13-${TAG}`]))!.id;
    const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id) VALUES ($1, 1) RETURNING id`, [cp]))!.id;
    conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, max_power_w) VALUES ($1, 60000) RETURNING id`, [e]))!.id;
    device = (await one<{ id: string }>(`INSERT INTO driver_device (device_hash) VALUES ($1) RETURNING id`, [`p13-${TAG}`]))!.id;
    tokenId = (await one<{ id: string }>(`INSERT INTO token (org_id, kind, uid) VALUES ($1, 'prepaid', $2) RETURNING id`, [org, `P13PRE${TAG}`]))!.id;
    app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as any).principal = { userId: A, orgId: org, assignments: [{ permissions: ['payment:read', 'payment:write', 'invoice:read', 'invoice:write'], scopeType: 'org', scopeId: null }] };
    });
    await registerFinanceRoutes(app);
    await registerFleetRoutes(app);
  });
  after(async () => {
    s3.close();
    await app?.close();
    await rm(join(config.storage.dir, 'warehouse', org), { recursive: true, force: true }).catch(() => {});
    for (const t of ['driver_refund_request', 'finance_export_run', 'fleet_credit_alert', 'fleet_prepay_entry', 'finance_period_lock', 'tax_withholding', 'finance_org_settings']) await query(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
    await query(`DELETE FROM driver_charge WHERE org_id = $1`, [org]);
    await query(`DELETE FROM fleet_invoice WHERE org_id = $1`, [org]);
    await query(`DELETE FROM cdr WHERE org_id = $1`, [org]);
    await query(`DELETE FROM charging_session WHERE org_id = $1`, [org]);
    await query(`DELETE FROM payment_intent WHERE org_id = $1`, [org]);
    await query(`DELETE FROM token WHERE org_id = $1`, [org]);
    await query(`DELETE FROM fleet_account WHERE org_id = $1`, [org]);
    await query(`DELETE FROM driver_device WHERE id = $1`, [device]);
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

describe('AWS Signature V4', () => {
  test('the documented example (GET Object, AWS S3 API reference)', () => {
    const auth = sigV4({
      method: 'GET', path: '/test.txt', payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' },
      region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    assert.equal(auth, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });
});

dbDescribe('Driver refund requests', () => {
  test('refundable; approved by the policy; reviewed otherwise; one per payment; the window', async () => {
    await call('PUT', '/v1/finance/driver-refunds/policy', { autoApproveUpTo: 50_000, windowDays: 30 });
    // Paid Rp 100 000, used Rp 60 000: Rp 40 000 left, approved at once.
    const a = await paidCharge(100_000, 60_000);
    assert.equal((await dr.refundable(a.pi))!.refundable, 40_000);
    await assert.rejects(dr.request(a.dc, { reason: 'unused_balance', amount: 50_000 }), /Paling banyak Rp/);
    const r1 = await dr.request(a.dc, { reason: 'unused_balance' });
    assert.deepEqual({ st: r1.state, auto: r1.auto, amt: r1.amount }, { st: 'approved', auto: true, amt: 40_000 });
    const pi1 = await one<any>(`SELECT refund_state, refund_due_minor FROM payment_intent WHERE id = $1`, [a.pi]);
    assert.deepEqual({ s: pi1.refund_state, d: Number(pi1.refund_due_minor) }, { s: 'due', d: 40_000 }, 'into the refund queue');
    await assert.rejects(dr.request(a.dc, { reason: 'other', message: 'Asking a second time, sorry.' }), /sudah diproses/);

    // A failed start above the automatic amount: reviewed; approved for less.
    const b = await paidCharge(80_000, null);
    const r2 = await dr.request(b.dc, { reason: 'charging_failed' });
    assert.equal(r2.state, 'pending', 'Rp 80 000 is above the automatic Rp 50 000');
    assert.ok(await one(`SELECT 1 FROM alert WHERE org_id = $1 AND kind = 'finance.driver_refund_request' AND target_id = $2 AND resolved_at IS NULL`, [org, r2.id]));
    const l = (await call('GET', '/v1/finance/driver-refunds')).json();
    assert.equal(l.pending, 1);
    assert.equal((await call('POST', `/v1/finance/driver-refunds/${r2.id}/approve`, { amount: 90_000 })).statusCode, 422, 'not more than asked');
    const ok = await call('POST', `/v1/finance/driver-refunds/${r2.id}/approve`, { amount: 75_000, note: 'Less the admin fee' });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(Number((await one<any>(`SELECT refund_due_minor FROM payment_intent WHERE id = $1`, [b.pi])).refund_due_minor), 75_000);

    // Overcharged needs a message; rejected with a note; a withdrawal; too late.
    const c = await paidCharge(50_000, 50_000);
    await assert.rejects(dr.request(c.dc, { reason: 'overcharged' }), /apa yang salah/);
    const r3 = await dr.request(c.dc, { reason: 'overcharged', message: 'The tariff on the screen was lower.', amount: 10_000 });
    assert.equal((await call('POST', `/v1/finance/driver-refunds/${r3.id}/reject`, {})).statusCode, 422, 'a note');
    assert.equal((await call('POST', `/v1/finance/driver-refunds/${r3.id}/reject`, { note: 'The tariff was shown before charging.' })).json().state, 'rejected');
    assert.equal((await dr.forPayment(c.pi))!.note, 'The tariff was shown before charging.');
    const d = await paidCharge(30_000, 0);
    const r4 = await dr.request(d.dc, { reason: 'other', message: 'Charger cable was damaged.' });
    assert.deepEqual(await dr.withdraw(d.pi, r4.id), { ok: true });
    const old = await paidCharge(30_000, 0, 40);
    await assert.rejects(dr.request(old.dc, { reason: 'charging_failed' }), /30 hari/);
  });
});

dbDescribe('Fleet credit limits and prepay', () => {
  test('the 80% warning; cards blocked over the limit and unblocked when back; a prepaid deposit pays the invoice', async () => {
    const acct = (await one<{ id: string }>(`INSERT INTO fleet_account (org_id, name) VALUES ($1, $2) RETURNING id`, [org, `Fleet ${TAG}`]))!.id;
    // Cards join a fleet account by its name (a trigger sets fleet_account_id from fleet_name).
    const t1 = (await one<{ id: string }>(`INSERT INTO token (org_id, kind, uid, account_type, fleet_name) VALUES ($1, 'rfid', $2, 'fleet', $3) RETURNING id`, [org, `F1${TAG}`, `Fleet ${TAG}`]))!.id;
    const t2 = (await one<{ id: string }>(`INSERT INTO token (org_id, kind, uid, account_type, fleet_name, status, customer_blocked_at) VALUES ($1, 'rfid', $2, 'fleet', $3, 'Blocked', now()) RETURNING id`, [org, `F2${TAG}`, `Fleet ${TAG}`]))!.id;
    const inv = (n: string, total: number, account = acct) => one<{ id: string }>(
      `INSERT INTO fleet_invoice (org_id, fleet_account_id, period, number, status, issued_at, due_date, sessions, energy_wh, subtotal_minor, local_tax_minor, taxable_minor, tax_base_minor, tax_minor,
                                  own_total_minor, roaming_total_minor, total_minor, data, currency)
       VALUES ($1, $2, '2026-09-01', $3, 'issued', now() - interval '20 days', current_date + 10, 1, 1000, $4, 0, $4, 0, 0, $4, 0, $4, '{}'::jsonb, 'IDR') RETURNING id`, [org, account, `${n}-${TAG}`, total]).then((r) => r!.id);
    const fleetSession = async (amount: number) => {
      const s = (await one<{ id: string }>(
        `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, token_id, started_at, ended_at, energy_wh, state, fleet_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, now() - interval '2 hours', now() - interval '1 hour', 10000, 'rated', $7) RETURNING id`, [org, site, conn, cp, `p13f-${randomUUID()}`, t1, acct]))!.id;
      await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency)
                   VALUES ($1, $2, now() - interval '1 hour', '[]'::jsonb, $3, 0, 0, 0, 0, 0, $3, '{}'::jsonb, 'IDR')`, [s, org, amount]);
    };
    const i1 = await inv('FC1', 700_000);
    await fleetSession(150_000);
    assert.equal((await call('PUT', `/v1/fleet-accounts/${acct}/credit`, { mode: 'credit', limit: 0 })).statusCode, 422);
    const p = (await call('PUT', `/v1/fleet-accounts/${acct}/credit`, { mode: 'credit', limit: 1_000_000, currency: 'IDR', block: true })).json();
    assert.deepEqual({ owed: p.owed, open: p.openInvoices, unbilled: p.notInvoiced, pct: p.usedPct, over: p.over }, { owed: 850_000, open: 700_000, unbilled: 150_000, pct: 85, over: false });
    const al = await one<any>(`SELECT severity FROM alert WHERE org_id = $1 AND kind = 'fleet.credit_limit' AND target_id = $2 AND resolved_at IS NULL`, [org, acct]);
    assert.equal(al?.severity, 'warning', '80% used');

    await fleetSession(200_000);
    let c = await credit.check(org, acct);
    assert.deepEqual({ level: c.level, blocked: c.blocked }, { level: 100, blocked: 1 }, 'over: the accepted card blocked');
    assert.deepEqual((await many<any>(`SELECT uid, status, credit_blocked_at IS NOT NULL AS credit FROM token WHERE fleet_account_id = $1 ORDER BY uid`, [acct])).map((r) => [r.status, r.credit]), [['Blocked', true], ['Blocked', false]]);
    assert.equal((await one<any>(`SELECT severity FROM alert WHERE org_id = $1 AND kind = 'fleet.credit_limit' AND target_id = $2 AND resolved_at IS NULL`, [org, acct]))!.severity, 'critical');
    // The invoice is paid: back under the limit, the card blocked for credit is unblocked; the customer's block stays.
    await query(`UPDATE fleet_invoice SET status = 'paid', paid_at = current_date WHERE id = $1`, [i1]);
    c = await credit.check(org, acct);
    assert.equal(c.unblocked, 1);
    assert.equal((await one<any>(`SELECT status FROM token WHERE id = $1`, [t1]))!.status, 'Accepted');
    assert.equal((await one<any>(`SELECT status FROM token WHERE id = $1`, [t2]))!.status, 'Blocked', 'the customer\'s block');

    // Prepaid: an issued invoice of Rp 300 000; a top-up of Rp 500 000 pays it (automatically).
    const pre = (await one<{ id: string }>(`INSERT INTO fleet_account (org_id, name) VALUES ($1, $2) RETURNING id`, [org, `Prepaid ${TAG}`]))!.id;
    const i2 = await inv('FP1', 300_000, pre);
    assert.equal((await call('POST', `/v1/fleet-accounts/${pre}/credit/entries`, { amount: 500_000, reference: 'BCA 1' })).statusCode, 409, 'prepaid first');
    await call('PUT', `/v1/fleet-accounts/${pre}/credit`, { mode: 'prepaid', currency: 'IDR' });
    assert.equal((await call('POST', `/v1/fleet-accounts/${pre}/credit/entries`, { amount: 500_000 })).statusCode, 422, 'a reference');
    assert.equal((await call('POST', `/v1/fleet-accounts/${pre}/credit/entries`, { amount: 500_000, reference: 'BCA 20261101-1' })).statusCode, 201);
    const inv2 = await one<any>(`SELECT status, paid_reference FROM fleet_invoice WHERE id = $1`, [i2]);
    assert.deepEqual({ s: inv2.status, r: inv2.paid_reference }, { s: 'paid', r: 'Prepaid deposit' });
    const pp = (await call('GET', `/v1/fleet-accounts/${pre}/credit`)).json();
    assert.equal(pp.deposit, 200_000);
    assert.deepEqual(pp.entries.map((e: any) => [e.kind, e.amount]), [['invoice', -300_000], ['topup', 500_000]]);
    assert.equal((await call('POST', `/v1/fleet-invoices/${i2}/pay-from-deposit`)).statusCode, 409, 'already paid');
    assert.ok((await call('GET', '/v1/fleet-credit')).json().accounts.length >= 2);
  });
});

dbDescribe('The finance data export', () => {
  test('local files; an S3 store with signed PUTs; a refused store logged; the ZIP of a day', async () => {
    const day = addDays(today(), -1);
    // A charge record at noon on that day (local): the helpers' "23 hours ago" is today after 23:00.
    const sess = (await one<{ id: string }>(
      `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, started_at, ended_at, energy_wh, state)
       VALUES ($1, $2, $3, $4, $5, ($6 || ' 11:00')::timestamp AT TIME ZONE $7, ($6 || ' 12:00')::timestamp AT TIME ZONE $7, 10000, 'rated') RETURNING id`,
      [org, site, conn, cp, `p13-${randomUUID()}`, day, zone]))!.id;
    await query(`INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency)
                 VALUES ($1, $2, ($3 || ' 12:00')::timestamp AT TIME ZONE $4, '[]'::jsonb, 25000, 0, 0, 0, 0, 0, 25000, '{}'::jsonb, 'IDR')`, [sess, org, day, zone]);
    await query(`INSERT INTO tax_withholding (org_id, kind, period, counterparty, base_minor, rate_bps, amount_minor) VALUES ($1, 'gateway_fee', $2, 'Xendit', 1000000, 200, 20000)`, [org, day.slice(0, 7)]);
    assert.equal((await call('POST', '/v1/finance/warehouse/run', { day: today() })).statusCode, 422, 'only an ended day');
    await call('PUT', '/v1/finance/warehouse/settings', { enabled: true, target: 'local', format: 'csv', prefix: 'fin' });
    const r = await call('POST', '/v1/finance/warehouse/run', { day });
    assert.equal(r.statusCode, 200, r.body);
    const files = r.json().files;
    assert.equal(files.length, wh.DAILY.length + wh.SNAPSHOTS.length);
    const charges = files.find((f: any) => f.dataset === 'charges');
    assert.equal(charges.key, `fin/charges/date=${day}/part-0.csv.gz`);
    const body = readFileSync(join(config.storage.dir, 'warehouse', org, charges.key));
    assert.equal(createHash('sha256').update(body).digest('hex'), charges.sha256);
    const csv = gunzipSync(body).toString();
    assert.match(csv.split('\r\n')[0]!, /^cdr_id,session_id,issued_at,site_id,site,/);
    assert.ok(csv.split('\r\n').length - 2 >= 1, 'the charges of the day');
    const wt = gunzipSync(readFileSync(join(config.storage.dir, 'warehouse', org, `fin/tax_withholdings/snapshot_date=${day}/part-0.csv.gz`))).toString();
    assert.match(wt, /Xendit/);

    const ep = `http://127.0.0.1:${(s3.address() as any).port}`;
    assert.equal((await call('PUT', '/v1/finance/warehouse/settings', { enabled: true, target: 's3', endpoint: ep, bucket: 'BAD', accessKeyId: 'AKIATEST', secretAccessKey: 's' })).statusCode, 422);
    const sv = await call('PUT', '/v1/finance/warehouse/settings', { enabled: true, target: 's3', format: 'ndjson', endpoint: ep, region: 'ap-southeast-3', bucket: 'op-finance', prefix: 'plugsure', accessKeyId: 'AKIATEST', secretAccessKey: 'secret-key' });
    assert.equal(sv.statusCode, 200, sv.body);
    assert.equal(sv.json().secretSet, true);
    assert.equal(JSON.stringify(sv.json()).includes('secret-key'), false, 'the secret is never shown');
    puts.length = 0;
    assert.equal((await call('POST', '/v1/finance/warehouse/run', { day })).statusCode, 200);
    assert.equal(puts.length, wh.DAILY.length + wh.SNAPSHOTS.length);
    // S3 keys are URI-encoded in the request (date%3D…).
    assert.ok(puts.some((p) => decodeURIComponent(p.url) === `/op-finance/plugsure/payments/date=${day}/part-0.jsonl.gz`));
    assert.match(puts[0]!.auth, /^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d{8}\/ap-southeast-3\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    // The secret kept when not given again; a refusing store: 502, logged.
    await call('PUT', '/v1/finance/warehouse/settings', { enabled: true, target: 's3', format: 'ndjson', endpoint: ep, region: 'ap-southeast-3', bucket: 'op-finance', prefix: 'plugsure', accessKeyId: 'AKIATEST' });
    refuse = true;
    const bad = await call('POST', '/v1/finance/warehouse/run', { day });
    refuse = false;
    assert.equal(bad.statusCode, 502);
    assert.match(bad.json().error, /403 \(AccessDenied\)/);
    const runs = (await call('GET', '/v1/finance/warehouse')).json().runs;
    assert.deepEqual(runs.slice(0, 3).map((x: any) => [x.target, x.error ? 'error' : 'ok']), [['s3', 'error'], ['s3', 'ok'], ['local', 'ok']]);
    // The worker: yesterday already exported, nothing to do.
    assert.equal(await wh.sweep(), 0);
    const z = await call('GET', `/v1/finance/warehouse/days/${day}`);
    assert.equal(z.statusCode, 200);
    assert.equal(z.rawPayload.subarray(0, 2).toString(), 'PK');
  });
});

dbDescribe('Year end', () => {
  test('the summary; closing an ended year locks its months; the pack', async () => {
    const y = Number(today().slice(0, 4)) - 1;
    await query(`INSERT INTO tax_withholding (org_id, kind, period, counterparty, base_minor, rate_bps, amount_minor, bukti_number) VALUES ($1, 'gateway_fee', $2, 'Xendit', 500000, 200, 10000, 'BP-001'), ($1, 'gateway_fee', $3, 'Xendit', 500000, 200, 10000, NULL)`, [org, `${y}-03`, `${y}-04`]);
    const s = (await call('GET', `/v1/finance/year-end?year=${y}`)).json();
    assert.equal(s.year, y);
    assert.equal(s.months.length, 12);
    assert.deepEqual({ n: s.pph23.records.length, total: s.pph23.total, missing: s.pph23.withoutBukti }, { n: 2, total: 20000, missing: 1 });
    assert.equal((await call('GET', `/v1/finance/year-end?year=${y + 5}`)).statusCode, 422);
    assert.equal((await call('POST', `/v1/finance/year-end/${y + 1}/close`)).statusCode, 409, 'not ended');
    await query(`INSERT INTO finance_period_lock (org_id, month) VALUES ($1, $2)`, [org, `${y}-01`]);
    const c = (await call('POST', `/v1/finance/year-end/${y}/close`)).json();
    assert.deepEqual({ locked: c.locked.length, already: c.alreadyLocked }, { locked: 11, already: [`${y}-01`] });
    assert.equal((await call('GET', `/v1/finance/year-end?year=${y}`)).json().monthsLocked, 12);
    const p = await call('GET', `/v1/finance/year-end/${y}/pack`);
    assert.equal(p.statusCode, 200);
    assert.equal(p.rawPayload.subarray(0, 2).toString(), 'PK');
    assert.match(String(p.headers['x-manifest-sha256']), /^[0-9a-f]{64}$/);
  });
});
