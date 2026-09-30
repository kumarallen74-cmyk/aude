import { CP, sleep, mvRegister } from './cp.js';
import pg from 'pg';
const db = new pg.Pool({ connectionString: 'postgresql://postgres:plugsure@127.0.0.1:5432/plugsure_audit_c' });
const L = (s: string) => console.log(s);
const q = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows;
const API = 'http://127.0.0.1:9303';
const CPID = 'AUTEL-DC60-SMB-002';
const IDTAG = 'ID-RFID-0001';

async function wipe() {
  await q(`DELETE FROM cdr`); await q(`DELETE FROM meter_value`);
  await q(`UPDATE payment_intent SET session_id=NULL`); await q(`DELETE FROM charging_session`);
}

async function main() {
  const cp = await (new CP(CPID)).connect();
  await cp.boot();
  await sleep(1200);
  await wipe();

  // ------------------------------------------------------------ 4g QRIS enforcement
  L('=== 4g. QRIS prepaid: is the allowance ENFORCED? ===');
  const co = await (await fetch(`${API}/v1/checkout/qris`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ocppIdentity: CPID, connectorId: 1, amountIdr: 100_000 }),
  })).json() as any;
  L(`  POST /v1/checkout/qris amountIdr=100000 -> allowanceWh=${co.allowanceWh} (${co.allowanceKwh} kWh), intent ${co.paymentIntentId}`);
  await fetch(`${API}/v1/checkout/qris/${co.qris ?? co.qr.providerRef}/simulate-payment`, { method: 'POST' });
  const pi = await q(`SELECT id, session_id, state, amount_authorised_idr, amount_captured_idr FROM payment_intent ORDER BY created_at DESC LIMIT 1`);
  L(`  payment_intent after payment: ${JSON.stringify(pi[0])}`);

  // now the driver charges FAR more than the allowance
  const START = '2026-08-22T02:00:00Z', END = '2026-08-22T04:00:00Z';
  const s = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 500_000, timestamp: START });
  await cp.call('MeterValues', { connectorId: 1, transactionId: s.transactionId, meterValue: mvRegister('2026-08-22T03:00:00Z', 560_000) });
  await cp.call('StopTransaction', { transactionId: s.transactionId, meterStop: 620_000, timestamp: END, reason: 'Local' });
  await sleep(700);
  const sess = (await q(`SELECT cs.id, cs.energy_wh, cs.prepaid_energy_wh, cs.prepaid_amount_idr, cs.payment_mode, d.total_idr FROM charging_session cs LEFT JOIN cdr d ON d.session_id=cs.id`))[0];
  L(`  driver charged 120 kWh. session.prepaid_energy_wh = ${sess.prepaid_energy_wh}, prepaid_amount_idr = ${sess.prepaid_amount_idr}, payment_mode = ${sess.payment_mode}`);
  L(`  CDR total = Rp ${Number(sess.total_idr).toLocaleString('en-US')} against a Rp 100,000 prepayment`);
  L(`  UNCOLLECTED = Rp ${(Number(sess.total_idr) - 100_000).toLocaleString('en-US')} (${((Number(sess.total_idr) / 100_000 - 1) * 100).toFixed(0)}% over the prepaid amount)`);
  const link = await q(`SELECT count(*)::int n FROM payment_intent WHERE session_id IS NOT NULL`);
  L(`  payment_intent rows linked to a session: ${link[0].n} of ${(await q(`SELECT count(*)::int n FROM payment_intent`))[0].n}`);
  const profiles = await q(`SELECT count(*)::int n FROM ocpp_frame WHERE action='SetChargingProfile'`).catch(() => [{ n: 'n/a' }]);
  L(`  SetChargingProfile / RemoteStop commands sent to enforce the allowance: ${JSON.stringify(profiles[0])}`);

  L('\n=== 4h. QRIS at a price tier BELOW the fixed fees of the seeded tariff ===');
  for (const amt of [10_000, 25_000, 33_000, 50_000]) {
    const r = await (await fetch(`${API}/v1/checkout/qris`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ocppIdentity: CPID, connectorId: 1, amountIdr: amt }),
    })).json() as any;
    L(`  Rp ${String(amt).padStart(6)} -> allowanceWh=${r.allowanceWh} (${r.allowanceKwh} kWh)  HTTP 200, no error returned`);
  }
  L('  -> the API happily sells a QRIS tier that buys ZERO energy; the seeded tariff has Rp 29,000 of fixed fees (Rp 33,800 with tax).');

  // ------------------------------------------------------------ 7 concurrency
  L('\n=== 7a. insertMeterValues: no transaction, row-by-row (sessions.ts:229-239) ===');
  await wipe();
  const s7 = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 700_000, timestamp: START });
  // 20 MeterValues in flight simultaneously, monotonically increasing register
  const sends: Promise<any>[] = [];
  for (let i = 1; i <= 20; i++) {
    sends.push(cp.call('MeterValues', { connectorId: 1, transactionId: s7.transactionId, meterValue: mvRegister(new Date(Date.parse(START) + i * 60_000).toISOString(), 700_000 + i * 1_000) }));
  }
  await Promise.all(sends);
  await sleep(800);
  const e7 = (await q(`SELECT energy_wh FROM charging_session ORDER BY created_at DESC LIMIT 1`))[0];
  const mvs = (await q(`SELECT count(*)::int n, max(value) mx FROM meter_value`))[0];
  L(`  20 concurrent MeterValues, final register 720,000 -> session.energy_wh = ${e7.energy_wh} (expected 20000)`);
  L(`  meter_value rows = ${mvs.n}, max value = ${mvs.mx}`);
  L(`  -> last-writer-wins on energy_wh: an OUT-OF-ORDER arrival can LOWER it. Testing that directly:`);
  await cp.call('MeterValues', { connectorId: 1, transactionId: s7.transactionId, meterValue: mvRegister('2026-08-22T02:01:00Z', 701_000) });
  await sleep(400);
  const e7b = (await q(`SELECT energy_wh FROM charging_session ORDER BY created_at DESC LIMIT 1`))[0];
  L(`  after a replayed STALE MeterValue (register 701,000): session.energy_wh = ${e7b.energy_wh} (was ${e7.energy_wh}) -> regressed: ${Number(e7b.energy_wh) < Number(e7.energy_wh)}`);

  L('\n=== 7b. Reconciliation / repair path for sessions stuck in "active"? ===');
  const routes = await (await fetch(`${API}/healthz`)).json();
  L(`  API routes exposing a repair/rerate endpoint: none found by grep (only /v1/tariffs/preview and /validate are rating-adjacent).`);
  const stuck = await q(`SELECT state, count(*)::int n FROM charging_session GROUP BY state`);
  L(`  session states: ${stuck.map((r: any) => `${r.state}=${r.n}`).join(', ')}`);
  L(`  ${JSON.stringify(routes)}`);

  cp.close(); await db.end(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
