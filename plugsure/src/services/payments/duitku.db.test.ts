import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { one, pool, query } from '../../db/pool.js';
import { databaseTestLock } from '../../db/test-lock.js';
import { DuitkuProvider } from './duitku.js';

/**
 * Duitku as the fallback acquirer (v1.13.0):
 *   - signatures (md5 as in Duitku's SDK, and HMAC-SHA256), the callback verified (signature, merchant code), the
 *     inquiry for QRIS and e-wallets, the status check;
 *   - startPaymentWithFallback: the main acquirer (Xendit) does not answer → the same payment goes to Duitku, and its
 *     record names Duitku's account; refusals, saved cards, OVO and no fallback account do not move;
 *   - Duitku's signed callback through /pay/notify/<key> captures it;
 *   - Finance: a pending payment Duitku reports paid is applied; paid payments get a ledger row with Duitku's fee and the
 *     settlement estimated from its schedule.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/payments/duitku.db.test.ts
 */

const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const KEY = 'duitku-api-key-test';
const MERCHANT = 'DTEST1';

describe('Duitku adapter (no database)', () => {
  const d = new DuitkuProvider({ environment: 'sandbox', merchantCode: MERCHANT, apiKey: KEY, callbackUrl: 'https://x.test/pay/notify/k' });
  const h = new DuitkuProvider({ environment: 'sandbox', merchantCode: MERCHANT, apiKey: KEY, callbackUrl: 'https://x.test/pay/notify/k', signature: 'hmac' });
  test('signatures: md5 with the key appended (the SDK), or HMAC-SHA256 keyed with it', () => {
    assert.equal(d.sign(`${MERCHANT}ord1100000`), md5(`${MERCHANT}ord1100000${KEY}`));
    assert.equal(h.sign(`${MERCHANT}ord1100000`), createHmac('sha256', KEY).update(`${MERCHANT}ord1100000`).digest('hex'));
  });
  test('the callback: verified by signature and merchant code; paid is resultCode 00', () => {
    const body = (o: Record<string, string>) => new URLSearchParams(o).toString();
    const ok = body({ merchantCode: MERCHANT, amount: '50000', merchantOrderId: 'ps-abc', resultCode: '00', reference: 'DREF1', signature: md5(`${MERCHANT}50000ps-abc${KEY}`) });
    assert.deepEqual(d.parseNotification(ok), { providerRef: 'ps-abc', paid: true, status: 'resultCode 00', amountMinor: 50000, paymentId: 'DREF1', currency: 'IDR' });
    assert.equal(d.parseNotification(ok.replace('amount=50000', 'amount=5000')), null, 'a changed amount breaks the signature');
    assert.equal(d.parseNotification(body({ merchantCode: 'OTHER', amount: '50000', merchantOrderId: 'ps-abc', resultCode: '00', signature: md5(`OTHER50000ps-abc${KEY}`) })), null);
    assert.equal(h.parseNotification(ok), null, 'an md5 callback is not an HMAC one');
    const failed = body({ merchantCode: MERCHANT, amount: '50000', merchantOrderId: 'ps-abc', resultCode: '01', signature: md5(`${MERCHANT}50000ps-abc${KEY}`) });
    assert.equal(d.parseNotification(failed)!.paid, false);
    assert.equal(d.canRefund(), false, 'refunds by bank transfer');
    assert.equal(d.orderRef('charge:x'), d.orderRef('charge:x'));
    assert.ok(d.orderRef('charge:x').length <= 50);
  });
});

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const store = await import('../../integrations/store.js');
const reg = await import('./registry.js');
const fin = await import('../finance.js');
const { bus } = await import('../events.js');

const TAG = randomBytes(3).toString('hex');
let org = '', xenditId = '', duitkuId = '', duitkuKey = '';
let xenditDown = true;
const orders = new Map<string, { amount: number; method: string; status: string; fee: number }>();
const seen: Array<{ path: string; body: any }> = [];
let base = '';
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0]!;
    let body: any = null;
    try { body = JSON.parse(raw); } catch { /* */ }
    seen.push({ path, body });
    res.setHeader('content-type', 'application/json');
    // The main acquirer (Xendit) under /x: down when xenditDown.
    if (path.startsWith('/x/')) {
      if (xenditDown) { res.statusCode = 503; return res.end(JSON.stringify({ error_code: 'SERVER_ERROR', message: 'unavailable' })); }
      return res.end(JSON.stringify({ qr_string: 'XENDIT-QR', expires_at: new Date(Date.now() + 9e5).toISOString() }));
    }
    if (path === '/webapi/api/merchant/v2/inquiry') {
      const ok = body.signature === md5(`${body.merchantCode}${body.merchantOrderId}${body.paymentAmount}${KEY}`);
      if (!ok) { res.statusCode = 401; return res.end(JSON.stringify({ Message: 'Wrong signature' })); }
      orders.set(body.merchantOrderId, { amount: body.paymentAmount, method: body.paymentMethod, status: '01', fee: body.paymentMethod === 'SP' ? 350 : 1500 });
      return res.end(JSON.stringify({
        merchantCode: body.merchantCode, reference: `DREF-${body.merchantOrderId.slice(3, 9)}`, statusCode: '00', statusMessage: 'SUCCESS',
        ...(body.paymentMethod === 'SP' ? { qrString: `DUITKU-QR-${body.merchantOrderId}` } : { paymentUrl: `https://sandbox.duitku.test/pay/${body.merchantOrderId}` }),
      }));
    }
    if (path === '/webapi/api/merchant/transactionStatus') {
      const o = orders.get(body.merchantOrderId);
      if (!o) { res.statusCode = 404; return res.end(JSON.stringify({ Message: 'Transaction not found' })); }
      return res.end(JSON.stringify({ merchantOrderId: body.merchantOrderId, reference: `DREF-${body.merchantOrderId.slice(3, 9)}`, amount: String(o.amount), fee: String(o.fee), statusCode: o.status, statusMessage: o.status === '00' ? 'SUCCESS' : 'PROCESS' }));
    }
    res.statusCode = 404; res.end('{}');
  });
});

const intent = async (channel = 'QRIS') => (await one<{ id: string }>(
  `INSERT INTO payment_intent (org_id, provider, method, mode, state, amount_authorised_minor, integration_id, channel, expires_at)
   VALUES ($1, 'xendit', 'qris', 'prepurchase', 'pending', 50000, $2, $3, now() + interval '30 minutes') RETURNING id`, [org, xenditId, channel]))!.id;
const prepareFor = (id: string) => (p: any) => query(
  `UPDATE payment_intent SET provider_ref = COALESCE($2, provider_ref), channel = $3, provider = COALESCE($4, provider),
          integration_id = CASE WHEN $4::text IS NULL THEN integration_id ELSE $5::uuid END WHERE id = $1`,
  [id, p.providerRef, p.channel, p.account?.provider ?? null, p.account?.integrationId ?? null]).then(() => undefined);

if (DB_OK) {
  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    (config.console as { publicBaseUrl: string }).publicBaseUrl = 'https://ocpp.plugsure.test';
    org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1,$2) RETURNING id`, [`Duitku ${TAG}`, `duitku-${TAG}`]))!.id;
    xenditId = ((await store.save('payments', org, { provider: 'xendit', settings: { environment: 'sandbox', methods: ['QRIS', 'OVO', 'DANA'], baseUrl: `${base}/x` }, secrets: { secretKey: `xnd_development_${TAG}`, callbackToken: 'cb' } }, null)) as any).id;
    const fb = (await store.save('payments_fallback', org, { provider: 'duitku', settings: { environment: 'sandbox', merchantCode: MERCHANT, methods: ['QRIS', 'DANA'], qrisMethod: 'SP', baseUrl: base }, secrets: { apiKey: KEY } }, null)) as any;
    duitkuId = fb.id;
    duitkuKey = fb.webhookPath.split('/').pop();
  });
  after(async () => {
    server.close();
    for (const id of [xenditId, duitkuId]) {
      await query(`DELETE FROM reconciliation_exception WHERE integration_id = $1`, [id]);
      await query(`DELETE FROM gateway_transaction WHERE integration_id = $1`, [id]);
      await query(`DELETE FROM gateway_sync_state WHERE integration_id = $1`, [id]);
      await query(`DELETE FROM integration_event WHERE integration_id = $1`, [id]);
    }
    await query(`DELETE FROM payment_intent WHERE org_id = $1`, [org]);
    await query(`DELETE FROM alert WHERE org_id = $1`, [org]);
    await query(`DELETE FROM integration WHERE org_id = $1`, [org]);
    await query(`DELETE FROM organisation WHERE id = $1`, [org]).catch(() => { /* audit rows keep it */ });
    store.invalidate();
    await pool.end();
  });
}

dbDescribe('Duitku as the fallback acquirer', () => {
  let qrisIntent = '';

  test('the fallback account: a webhook URL, resolved for the organisation', async () => {
    assert.match(duitkuKey, /^[A-Za-z0-9_-]{20,64}$/);
    const fb = await reg.paymentsFallbackFor(org);
    assert.equal(fb?.resolved.provider, 'duitku');
    assert.ok(fb!.provider instanceof DuitkuProvider);
  });

  test('Xendit does not answer: the QRIS payment is made at Duitku and recorded on Duitku\'s account', async () => {
    const acq = await reg.paymentsFor(org);
    const alerts: any[] = [];
    bus.on('alert.raised', (x: any) => alerts.push(x));
    qrisIntent = await intent();
    seen.length = 0;
    const s = await reg.startPaymentWithFallback(acq, org, { channel: 'QRIS', referenceId: `charge:${qrisIntent}`, amountMinor: 50_000, returnUrl: 'https://app.test/paid', prepare: prepareFor(qrisIntent) });
    assert.equal(s.fallback, true);
    assert.match(s.qrString!, /^DUITKU-QR-ps-/);
    const inq = seen.find((x) => x.path === '/webapi/api/merchant/v2/inquiry')!.body;
    assert.equal(inq.paymentMethod, 'SP');
    assert.equal(inq.paymentAmount, 50_000);
    assert.equal(inq.callbackUrl, `https://ocpp.plugsure.test/pay/notify/${duitkuKey}`);
    const pi = (await one<any>(`SELECT * FROM payment_intent WHERE id = $1`, [qrisIntent]))!;
    assert.equal(pi.provider, 'duitku');
    assert.equal(pi.integration_id, duitkuId);
    assert.equal(pi.provider_ref, s.providerRef);
    assert.ok(alerts.some((x) => x.kind === 'payment.acquirer_fallback' && x.orgId === org && /fallback acquirer \(duitku\)/.test(x.message)), 'the operator is alerted');
    assert.ok(await one(`SELECT 1 FROM integration_event WHERE integration_id = $1 AND outcome = 'fallback'`, [xenditId]));
  });

  test('what never moves: Xendit answering, OVO, a saved card, a method the fallback does not offer, no fallback account', async () => {
    const acq = await reg.paymentsFor(org);
    xenditDown = false;
    const ok = await reg.startPaymentWithFallback(acq, org, { channel: 'QRIS', referenceId: `charge:${randomUUID()}`, amountMinor: 50_000, returnUrl: 'https://app.test/paid' });
    assert.equal(ok.fallback, undefined);
    assert.equal(ok.qrString, 'XENDIT-QR');
    xenditDown = true;
    await assert.rejects(reg.startPaymentWithFallback(acq, org, { channel: 'OVO', customerPhone: '+6281234567890', referenceId: `charge:${randomUUID()}`, amountMinor: 50_000, returnUrl: 'https://app.test/paid' }), /Xendit|503|unavailable/i);
    await assert.rejects(reg.startPaymentWithFallback(acq, org, { channel: 'CARD', savedCardId: randomUUID(), appDriverId: randomUUID(), referenceId: `charge:${randomUUID()}`, amountMinor: 50_000, returnUrl: 'https://app.test/paid' }));
    await query(`UPDATE integration SET enabled = false WHERE id = $1`, [duitkuId]);
    store.invalidate();
    try {
      await assert.rejects(reg.startPaymentWithFallback(acq, org, { channel: 'QRIS', referenceId: `charge:${randomUUID()}`, amountMinor: 50_000, returnUrl: 'https://app.test/paid' }));
    } finally {
      await query(`UPDATE integration SET enabled = true WHERE id = $1`, [duitkuId]);
      store.invalidate();
    }
  });

  test('Duitku\'s signed callback captures the payment; a forged one is refused', async () => {
    const pi = (await one<any>(`SELECT provider_ref FROM payment_intent WHERE id = $1`, [qrisIntent]))!;
    const form = (sig: string, amount = '50000') => new URLSearchParams({ merchantCode: MERCHANT, amount, merchantOrderId: pi.provider_ref, resultCode: '00', reference: 'DREF-X', signature: sig }).toString();
    const bad = await reg.handleNotification(duitkuKey, form('0'.repeat(32)), { 'content-type': 'application/x-www-form-urlencoded' }, `/pay/notify/${duitkuKey}`);
    assert.equal(bad.status, 401);
    const good = await reg.handleNotification(duitkuKey, form(md5(`${MERCHANT}50000${pi.provider_ref}${KEY}`)), { 'content-type': 'application/x-www-form-urlencoded' }, `/pay/notify/${duitkuKey}`);
    assert.equal(good.status, 200);
    assert.equal(good.body, 'OK');
    const after = (await one<any>(`SELECT state, amount_captured_minor FROM payment_intent WHERE id = $1`, [qrisIntent]))!;
    assert.equal(after.state, 'captured');
    assert.equal(after.amount_captured_minor, 50_000);
    orders.get(pi.provider_ref)!.status = '00';
  });

  test('Finance: a lost callback is recovered by the status check; paid payments get a ledger row with Duitku\'s fee', async () => {
    // A DANA payment through the fallback whose callback never came, though Duitku has it paid.
    const acq = await reg.paymentsFor(org);
    const lost = await intent('DANA');
    const s = await reg.startPaymentWithFallback(acq, org, { channel: 'DANA', referenceId: `charge:${lost}`, amountMinor: 50_000, returnUrl: 'https://app.test/paid', prepare: prepareFor(lost) });
    assert.match(s.checkoutUrl!, /sandbox\.duitku\.test\/pay\//);
    orders.get(s.providerRef)!.status = '00';
    await query(`UPDATE payment_intent SET created_at = now() - interval '10 minutes' WHERE id = $1`, [lost]);
    const r = await fin.syncTransactions(duitkuId);
    assert.equal(r.ok, true, r.error);
    assert.equal((await one<any>(`SELECT state FROM payment_intent WHERE id = $1`, [lost]))!.state, 'captured', 'applied from the status check');
    const r2 = await fin.syncTransactions(duitkuId);
    assert.equal(r2.ok, true);
    const rows = (await pool.query(`SELECT * FROM gateway_transaction WHERE integration_id = $1 ORDER BY id`, [duitkuId])).rows;
    assert.equal(rows.length, 2);
    const q = rows.find((x: any) => x.channel_code === 'QRIS')!;
    assert.equal(Number(q.fee), 350);
    assert.equal(Number(q.net_amount), 49_650);
    assert.equal(q.matched, 'intent');
    assert.equal(q.payment_intent_id, qrisIntent);
    assert.ok(q.estimated_settlement_at > q.gateway_created_at, 'settlement estimated from Duitku\'s schedule');
    const accts = await fin.accountsFor(org, false);
    const da = accts.find((a) => a.id === duitkuId)!;
    assert.equal(da.fallback, true);
    assert.match(da.label, /Duitku \(fallback\)/);
    const o = await fin.overview(duitkuId, fin.periodOf(new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10), new Date(Date.now() + 864e5).toISOString().slice(0, 10)));
    assert.equal(o.collected, 100_000);
    assert.equal(o.fees, 350 + 1500);
    const rec = await fin.reconcile(duitkuId);
    assert.equal(rec.open, 0, 'the ledger and PlugSure agree');
  });

  test('working days for the settlement estimate skip weekends', () => {
    const fri = new Date('2026-10-30T10:00:00Z');
    assert.equal(fin.addWorkingDays(fri, 2).toISOString().slice(0, 10), '2026-11-03');
    assert.equal(fin.addWorkingDays(new Date('2026-10-27T10:00:00Z'), 2).toISOString().slice(0, 10), '2026-10-29');
  });
});
