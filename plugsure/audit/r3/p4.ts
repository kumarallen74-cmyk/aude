import { CP, sleep, mvRegister } from './cp.js';
import pg from 'pg';
const db = new pg.Pool({ connectionString: 'postgresql://postgres:plugsure@127.0.0.1:5432/plugsure_r3b' });
const L = (s: string) => console.log(s);
const q = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows;
const CPID = 'AUTEL-DC60-SMB-002', IDTAG = 'ID-RFID-0001';
const wipe = async () => { await q(`DELETE FROM cdr`); await q(`DELETE FROM meter_value`); await q(`UPDATE payment_intent SET session_id=NULL`); await q(`DELETE FROM charging_session`); };
const last = async () => (await q(`SELECT cs.id, cs.energy_wh, cs.meter_stop_wh, cs.state, cs.needs_review, cs.review_reason, cs.idle_minutes, cs.flags, d.total_idr, d.subtotal_idr, d.lines FROM charging_session cs LEFT JOIN cdr d ON d.session_id=cs.id ORDER BY cs.created_at DESC LIMIT 1`))[0];
const START = '2026-08-22T02:00:00Z', END = '2026-08-22T03:00:00Z';

async function main() {
  const cp = await (new CP(CPID)).connect(); await cp.boot(); await sleep(1200);

  L('=== R1. meterStop = 0 on a session that started at register 45,000 Wh (firmware error) ===');
  await wipe();
  const s1 = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 45_000, timestamp: START });
  await cp.call('StopTransaction', { transactionId: s1.transactionId, meterStop: 0, timestamp: END, reason: 'Local' });
  await sleep(900);
  let r = await last();
  L(`  energy_wh=${r.energy_wh} meter_stop=${r.meter_stop_wh} state=${r.state} review=${r.needs_review} CDR total=Rp ${r.total_idr}`);
  L(`  flags=${JSON.stringify((r.flags as any[]).map((f:any)=>f.code))}`);

  L('\n=== R2. meter went backwards 60,000 -> 55,000 (meter swap) ===');
  await wipe();
  const s2 = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 60_000, timestamp: START });
  await cp.call('StopTransaction', { transactionId: s2.transactionId, meterStop: 55_000, timestamp: END, reason: 'Local' });
  await sleep(900);
  r = await last();
  L(`  energy_wh=${r.energy_wh} state=${r.state} review=${r.needs_review} CDR total=Rp ${r.total_idr} flags=${JSON.stringify((r.flags as any[]).map((f:any)=>f.code))}`);

  L('\n=== R3. genuine 7-digit Wh rollover 9,998,000 -> 3,000 (5 kWh) ===');
  await wipe();
  const s3 = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 9_998_000, timestamp: START });
  await cp.call('StopTransaction', { transactionId: s3.transactionId, meterStop: 3_000, timestamp: END, reason: 'Local' });
  await sleep(900);
  r = await last();
  L(`  energy_wh=${r.energy_wh} (expect 5000) CDR=Rp ${r.total_idr} flags=${JSON.stringify((r.flags as any[]).map((f:any)=>f.code))}`);

  L('\n=== R4. idle minutes: charging stops at 02:20, session ends 03:00 (40 idle min) ===');
  await wipe();
  const s4 = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 100_000, timestamp: START });
  await cp.call('MeterValues', { connectorId:1, transactionId: s4.transactionId, meterValue: mvRegister('2026-08-22T02:10:00Z', 120_000) });
  await cp.call('MeterValues', { connectorId:1, transactionId: s4.transactionId, meterValue: mvRegister('2026-08-22T02:20:00Z', 140_000) });
  await cp.call('MeterValues', { connectorId:1, transactionId: s4.transactionId, meterValue: mvRegister('2026-08-22T02:40:00Z', 140_000) });
  await cp.call('StopTransaction', { transactionId: s4.transactionId, meterStop: 140_000, timestamp: END, reason: 'Local' });
  await sleep(900);
  r = await last();
  L(`  idle_minutes=${r.idle_minutes} (expect 40) energy=${r.energy_wh} CDR=Rp ${r.total_idr}`);
  L(`  lines=${JSON.stringify((r.lines as any[])?.map((l:any)=>[l.kind,l.quantity,l.amountIdr]))}`);

  L('\n=== R5. same but the stop register is 1 Wh higher than the last flat sample ===');
  await wipe();
  const s5 = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 100_000, timestamp: START });
  await cp.call('MeterValues', { connectorId:1, transactionId: s5.transactionId, meterValue: mvRegister('2026-08-22T02:20:00Z', 140_000) });
  await cp.call('MeterValues', { connectorId:1, transactionId: s5.transactionId, meterValue: mvRegister('2026-08-22T02:40:00Z', 140_000) });
  await cp.call('StopTransaction', { transactionId: s5.transactionId, meterStop: 140_001, timestamp: END, reason: 'Local' });
  await sleep(900);
  r = await last();
  L(`  idle_minutes=${r.idle_minutes} (expect ~40) energy=${r.energy_wh} CDR=Rp ${r.total_idr}`);
  L(`  lines=${JSON.stringify((r.lines as any[])?.map((l:any)=>[l.kind,l.quantity,l.amountIdr]))}`);

  L('\n=== R6. zero-energy session (charger faulted immediately) ===');
  await wipe();
  const s6 = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 200_000, timestamp: START });
  await cp.call('StopTransaction', { transactionId: s6.transactionId, meterStop: 200_000, timestamp: '2026-08-22T02:01:00Z', reason: 'EVDisconnected' });
  await sleep(900);
  r = await last();
  L(`  energy=${r.energy_wh} CDR total=Rp ${r.total_idr} lines=${JSON.stringify((r.lines as any[])?.map((l:any)=>[l.kind,l.amountIdr]))}`);

  await db.end(); cp.close(); process.exit(0);
}
main().catch((e)=>{console.error(e);process.exit(1);});
