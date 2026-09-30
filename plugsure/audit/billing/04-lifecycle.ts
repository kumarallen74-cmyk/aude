import { CP, sleep, mvRegister } from './cp.js';
import pg from 'pg';

const db = new pg.Pool({ connectionString: 'postgresql://postgres:plugsure@127.0.0.1:5432/plugsure_audit_c' });
const L = (s: string) => console.log(s);
const q = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows;

const CPID = 'AUTEL-DC60-SMB-002'; // connector 1 is verified, connector 2 is tera-lapsed
const IDTAG = 'ID-RFID-0001';

async function sessionsFor(label: string) {
  return q(
    `SELECT cs.id, cs.ocpp_transaction_id tx, cs.state, cs.started_at, cs.ended_at,
            cs.meter_start_wh ms, cs.meter_stop_wh mstop, cs.energy_wh, cs.idem_key,
            d.total_idr, d.subtotal_idr, d.issued_at
       FROM charging_session cs LEFT JOIN cdr d ON d.session_id = cs.id
       JOIN charge_point cp ON cp.id = cs.charge_point_id
      WHERE cp.ocpp_identity = $1 ORDER BY cs.created_at`,
    [CPID],
  );
}
const dump = async (title: string) => {
  L(`  -- DB state (${title}):`);
  for (const r of await sessionsFor(title)) {
    L(`     tx=${r.tx} state=${r.state} meter ${r.ms}->${r.mstop} energy=${r.energy_wh} cdr=${r.total_idr ?? '-'} idem=${String(r.idem_key).slice(0, 10)}`);
  }
};
const wipe = async () => {
  await q(`DELETE FROM cdr WHERE session_id IN (SELECT cs.id FROM charging_session cs JOIN charge_point cp ON cp.id=cs.charge_point_id WHERE cp.ocpp_identity=$1)`, [CPID]);
  await q(`DELETE FROM meter_value WHERE session_id IN (SELECT cs.id FROM charging_session cs JOIN charge_point cp ON cp.id=cs.charge_point_id WHERE cp.ocpp_identity=$1)`, [CPID]);
  await q(`DELETE FROM charging_session cs USING charge_point cp WHERE cp.id=cs.charge_point_id AND cp.ocpp_identity=$1`, [CPID]);
};

async function main() {
  const cp = await (new CP(CPID)).connect();
  await cp.boot();
  await cp.call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: new Date().toISOString() });
  await sleep(1500);

  const T0 = new Date('2026-08-20T02:00:00Z').toISOString();
  const T1 = new Date('2026-08-20T03:00:00Z').toISOString();

  // ---------------------------------------------------------------- 5.1
  L('\n=== 5.1 IDENTICAL StartTransaction replayed twice ===');
  await wipe();
  const p = { connectorId: 1, idTag: IDTAG, meterStart: 1_000_000, timestamp: T0 };
  const a = await cp.call('StartTransaction', p);
  const b = await cp.call('StartTransaction', p);
  L(`  StartTransaction returned transactionId ${a.transactionId} then ${b.transactionId}`);
  const rows = await sessionsFor('5.1');
  L(`  sessions created: ${rows.length}  (expected 1 for an idempotent replay)`);
  await dump('5.1');
  // both replayed stops
  await cp.call('StopTransaction', { transactionId: a.transactionId, meterStop: 1_020_000, timestamp: T1, reason: 'Local' });
  await cp.call('StopTransaction', { transactionId: b.transactionId, meterStop: 1_020_000, timestamp: T1, reason: 'Local' });
  await sleep(500);
  const after = await sessionsFor('5.1b');
  L(`  after stopping both replays: ${after.length} sessions, CDR totals = ${after.map((r: any) => r.total_idr).join(' + ')}`);
  L(`  TOTAL CHARGED TO THE DRIVER: Rp ${after.reduce((s: number, r: any) => s + Number(r.total_idr ?? 0), 0).toLocaleString('en-US')} for 20 kWh delivered once`);

  // ---------------------------------------------------------------- 5.2
  L('\n=== 5.2 StopTransaction arriving twice (same tx) ===');
  await wipe();
  const s2 = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 2_000_000, timestamp: T0 });
  await cp.call('StopTransaction', { transactionId: s2.transactionId, meterStop: 2_015_000, timestamp: T1, reason: 'Local' });
  await sleep(300);
  const cdr1 = await sessionsFor('x');
  await cp.call('StopTransaction', { transactionId: s2.transactionId, meterStop: 2_099_000, timestamp: new Date('2026-08-20T05:00:00Z').toISOString(), reason: 'Local' });
  await sleep(300);
  const cdr2 = await sessionsFor('x');
  L(`  after 1st stop: energy=${cdr1[0].energy_wh} total=${cdr1[0].total_idr}`);
  L(`  after 2nd stop (different meterStop 2,099,000): energy=${cdr2[0].energy_wh} total=${cdr2[0].total_idr}`);
  L(`  -> replayed stop is a no-op: ${cdr1[0].energy_wh === cdr2[0].energy_wh && cdr1[0].total_idr === cdr2[0].total_idr}`);
  const mvCount = await q(`SELECT count(*)::int n FROM meter_value WHERE session_id=$1`, [cdr2[0].id]);
  L(`  meter_value rows: ${mvCount[0].n}`);

  // ---------------------------------------------------------------- 5.3
  L('\n=== 5.3 StopTransaction BEFORE its MeterValues ===');
  await wipe();
  const s3 = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 3_000_000, timestamp: T0 });
  await cp.call('StopTransaction', { transactionId: s3.transactionId, meterStop: 3_010_000, timestamp: T1, reason: 'PowerLoss' });
  await sleep(300);
  const beforeMv = (await sessionsFor('x'))[0];
  L(`  after stop: energy=${beforeMv.energy_wh} state=${beforeMv.state} CDR total=${beforeMv.total_idr}`);
  // queued MeterValues replayed after the stop, showing the true final register
  await cp.call('MeterValues', { connectorId: 1, transactionId: s3.transactionId, meterValue: mvRegister(new Date('2026-08-20T02:50:00Z').toISOString(), 3_040_000) });
  await sleep(300);
  const afterMv = (await sessionsFor('x'))[0];
  L(`  after late MeterValues (register 3,040,000 = 40 kWh delivered):`);
  L(`    session.energy_wh = ${afterMv.energy_wh}  (was ${beforeMv.energy_wh})   state=${afterMv.state}`);
  L(`    CDR total_idr     = ${afterMv.total_idr} (unchanged: ${afterMv.total_idr === beforeMv.total_idr})`);
  L(`  -> session row and CDR now DISAGREE by ${Number(afterMv.energy_wh) - Number(beforeMv.energy_wh)} Wh = ${(Number(afterMv.energy_wh) - Number(beforeMv.energy_wh)) / 1000} kWh unbilled`);

  // ---------------------------------------------------------------- 5.4
  L('\n=== 5.4 MeterValues after the session already ended and was rated ===');
  L('  (covered by 5.3: state is "rated" and updateSession has no state guard — sessions.ts:108-122)');
  const st = await q(`SELECT state, energy_wh FROM charging_session WHERE id=$1`, [afterMv.id]);
  L(`  session state after post-CDR MeterValues: ${st[0].state}, energy_wh=${st[0].energy_wh}`);

  // ---------------------------------------------------------------- 5.5
  L('\n=== 5.5 StartTransaction with an OLD timestamp after a newer session on the same connector ===');
  await wipe();
  const newer = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 5_000_000, timestamp: new Date('2026-08-22T10:00:00Z').toISOString() });
  const older = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 4_000_000, timestamp: new Date('2026-08-19T10:00:00Z').toISOString() });
  L(`  newer tx=${newer.transactionId}, replayed older tx=${older.transactionId}`);
  await dump('5.5');
  const active = await q(`SELECT count(*)::int n FROM charging_session cs JOIN charge_point cp ON cp.id=cs.charge_point_id WHERE cp.ocpp_identity=$1 AND cs.state='active'`, [CPID]);
  L(`  concurrent ACTIVE sessions on ONE physical connector: ${active[0].n}`);

  // ---------------------------------------------------------------- 5.6
  L('\n=== 5.6 Two CONCURRENT StopTransaction for the same tx ===');
  await wipe();
  const s6 = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 6_000_000, timestamp: T0 });
  const stop = { transactionId: s6.transactionId, meterStop: 6_030_000, timestamp: T1, reason: 'Local' };
  await Promise.all([cp.call('StopTransaction', stop), cp.call('StopTransaction', { ...stop })]);
  await sleep(600);
  const cdrs = await q(`SELECT count(*)::int n FROM cdr d JOIN charging_session cs ON cs.id=d.session_id JOIN charge_point cp ON cp.id=cs.charge_point_id WHERE cp.ocpp_identity=$1`, [CPID]);
  L(`  CDRs created: ${cdrs[0].n} (expected 1)`);
  await dump('5.6');

  // ---------------------------------------------------------------- 5.7
  L('\n=== 5.7 Meter register ROLLOVER (meterStop < meterStart) ===');
  await wipe();
  const ROLL = 2 ** 32; // 4,294,967,296 Wh — 32-bit Wh register
  const start7 = ROLL - 10_000;
  const stop7 = 15_000; // wrapped: 25 kWh actually delivered
  const s7 = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: start7, timestamp: T0 });
  await cp.call('StopTransaction', { transactionId: s7.transactionId, meterStop: stop7, timestamp: T1, reason: 'Local' });
  await sleep(400);
  const r7 = (await sessionsFor('x'))[0];
  L(`  meterStart=${start7} meterStop=${stop7} -> true delivery = 25,000 Wh`);
  L(`  billed energy_wh = ${r7.energy_wh}, CDR total = Rp ${r7.total_idr}`);
  L(`  REVENUE LOST = Rp ${Math.round(25 * 2467.5)} of energy (billed ${r7.energy_wh} Wh)`);

  // ---------------------------------------------------------------- 5.8
  L('\n=== 5.8 Charger with a wrong clock ===');
  await wipe();
  const s8 = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 8_000_000, timestamp: '2019-03-04T22:00:00Z' });
  const t0 = Date.now();
  await cp.call('StopTransaction', { transactionId: s8.transactionId, meterStop: 8_020_000, timestamp: '2019-03-04T23:30:00Z', reason: 'Local' });
  await sleep(400);
  const r8 = (await sessionsFor('x'))[0];
  L(`  2019 timestamps: billed anyway -> energy=${r8.energy_wh} total=Rp ${r8.total_idr} (rating took ${Date.now() - t0} ms)`);

  L('\n  -- clock skew where ended_at < started_at (charger resyncs mid-session) --');
  await wipe();
  const s8b = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 9_000_000, timestamp: '2026-08-20T10:00:00Z' });
  await cp.call('StopTransaction', { transactionId: s8b.transactionId, meterStop: 9_030_000, timestamp: '2026-08-20T09:00:00Z', reason: 'Local' });
  await sleep(400);
  const r8b = (await sessionsFor('x'))[0];
  L(`  started 10:00Z ended 09:00Z -> stored ended_at=${r8b.ended_at?.toISOString?.() ?? r8b.ended_at}`);
  const dur = await q(`SELECT duration_s FROM charging_session WHERE id=$1`, [r8b.id]);
  L(`  duration_s = ${dur[0].duration_s}, energy=${r8b.energy_wh}, CDR total=Rp ${r8b.total_idr} (billed with no flag)`);

  // ---------------------------------------------------------------- 5.9 cross charge point tx reuse
  L('\n=== 5.9 transactionId collision across charge points / replay of a pre-outage tx id ===');
  await wipe();
  const s9 = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 10_000_000, timestamp: T0 });
  L(`  CSMS assigned tx=${s9.transactionId}. Charger had queued a StopTransaction for its PRE-OUTAGE id ${Number(s9.transactionId) - 500}.`);
  const before9 = await q(`SELECT count(*)::int n FROM charging_session cs JOIN charge_point cp ON cp.id=cs.charge_point_id WHERE cp.ocpp_identity=$1 AND cs.state='active'`, [CPID]);
  await cp.call('StopTransaction', { transactionId: Number(s9.transactionId) - 500, meterStop: 10_020_000, timestamp: T1, reason: 'PowerLoss' });
  await sleep(400);
  const after9 = await q(`SELECT state FROM charging_session cs JOIN charge_point cp ON cp.id=cs.charge_point_id WHERE cp.ocpp_identity=$1`, [CPID]);
  L(`  orphaned stop: sessions still active = ${after9.filter((r: any) => r.state === 'active').length} (was ${before9[0].n}) -> session never bills, stuck 'active'`);

  L('\n=== 5.10 Are there any stuck sessions and is there a repair path? ===');
  const stuck = await q(`SELECT state, count(*)::int n FROM charging_session GROUP BY state ORDER BY 1`);
  L(`  session states across the whole DB: ${stuck.map((r: any) => `${r.state}=${r.n}`).join(', ')}`);

  cp.close();
  await db.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
