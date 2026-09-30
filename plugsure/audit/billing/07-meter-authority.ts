import { CP, sleep, mvRegister } from './cp.js';
import pg from 'pg';
const db = new pg.Pool({ connectionString: 'postgresql://postgres:plugsure@127.0.0.1:5432/plugsure_audit_c' });
const L = (s: string) => console.log(s);
const q = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows;
const CPID = 'AUTEL-DC60-SMB-002', IDTAG = 'ID-RFID-0001';
const wipe = async () => { await q(`DELETE FROM cdr`); await q(`DELETE FROM meter_value`); await q(`UPDATE payment_intent SET session_id=NULL`); await q(`DELETE FROM charging_session`); };
const last = async () => (await q(`SELECT cs.energy_wh, cs.meter_stop_wh, cs.state, d.total_idr, d.lines FROM charging_session cs LEFT JOIN cdr d ON d.session_id=cs.id ORDER BY cs.created_at DESC LIMIT 1`))[0];
const START = '2026-08-22T02:00:00Z', END = '2026-08-22T03:00:00Z';

async function main() {
  const cp = await (new CP(CPID)).connect(); await cp.boot(); await sleep(1200);

  L('=== 8a. "The legal meter wins": is StopTransaction.transactionData preferred over the scalar meterStop? ===');
  await wipe();
  const s = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 1_000_000, timestamp: START });
  await cp.call('StopTransaction', {
    transactionId: s.transactionId, meterStop: 1_010_000, timestamp: END, reason: 'Local',
    transactionData: [{ timestamp: END, sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: '1060000', unit: 'Wh', context: 'Transaction.End' }] }],
  });
  await sleep(600);
  const a = await last();
  L(`  transactionData says register 1,060,000 (60 kWh); scalar meterStop says 1,010,000 (10 kWh).`);
  L(`  billed energy_wh = ${a.energy_wh}, meter_stop_wh = ${a.meter_stop_wh}, CDR total = Rp ${a.total_idr}`);
  L(`  -> ${Number(a.energy_wh) === 60_000 ? 'transactionData wins (as documented)' : 'SCALAR meterStop WINS — transactionData is IGNORED. 50 kWh (Rp ' + Math.round(50 * 2467.5).toLocaleString('en-US') + ') unbilled.'}`);

  L('\n=== 8b. StopTransaction with NO meterStop field (permitted to be absent by some stacks) ===');
  await wipe();
  const s2 = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 2_000_000, timestamp: START });
  await cp.call('MeterValues', { connectorId: 1, transactionId: s2.transactionId, meterValue: mvRegister('2026-08-22T02:50:00Z', 2_045_000) });
  await sleep(300);
  const mid = await last();
  L(`  mid-session energy_wh = ${mid.energy_wh} (45 kWh delivered)`);
  await cp.call('StopTransaction', { transactionId: s2.transactionId, timestamp: END, reason: 'PowerLoss' });
  await sleep(600);
  const b = await last();
  L(`  after StopTransaction with meterStop omitted: energy_wh = ${b.energy_wh}, meter_stop_wh = ${b.meter_stop_wh}, CDR = Rp ${b.total_idr}`);
  L(`  -> adapter16.ts:255 coerces a missing meterStop to 0, so the documented "fall back to the running total" path in sessions.ts:135 is DEAD. 45 kWh (Rp ${Math.round(45 * 2467.5).toLocaleString('en-US')}) unbilled.`);

  L('\n=== 8c. MeterValues reported in kWh instead of Wh ===');
  await wipe();
  const s3 = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 3_000_000, timestamp: START });
  await cp.call('StopTransaction', {
    transactionId: s3.transactionId, meterStop: 3_020_000, timestamp: END, reason: 'Local',
    transactionData: [{ timestamp: END, sampledValue: [{ measurand: 'Energy.Active.Import.Register', value: '3020', unit: 'kWh' }] }],
  });
  await sleep(600);
  const c = await last();
  L(`  billed energy_wh = ${c.energy_wh}, CDR = Rp ${c.total_idr} (kWh conversion is handled in canonical.ts:126-135, but see 8a — transactionData never reaches it)`);

  L('\n=== 8d. Can a CDR be mutated after issue by ANY later traffic? ===');
  await wipe();
  const s4 = await cp.call('StartTransaction', { connectorId: 1, idTag: IDTAG, meterStart: 4_000_000, timestamp: START });
  await cp.call('StopTransaction', { transactionId: s4.transactionId, meterStop: 4_020_000, timestamp: END, reason: 'Local' });
  await sleep(500);
  const before = await q(`SELECT id, total_idr, subtotal_idr, issued_at, lines FROM cdr`);
  L(`  CDR issued: total=${before[0].total_idr} at ${before[0].issued_at.toISOString()}`);
  for (const attempt of [
    () => cp.call('MeterValues', { connectorId: 1, transactionId: s4.transactionId, meterValue: mvRegister('2026-08-22T04:00:00Z', 4_500_000) }),
    () => cp.call('StopTransaction', { transactionId: s4.transactionId, meterStop: 9_000_000, timestamp: '2026-08-22T06:00:00Z', reason: 'Local' }),
  ]) { await attempt(); await sleep(300); }
  const after = await q(`SELECT id, total_idr, subtotal_idr, issued_at FROM cdr`);
  const sess = await q(`SELECT energy_wh, meter_stop_wh, state FROM charging_session`);
  L(`  after replaying MeterValues(4,500,000) and StopTransaction(9,000,000):`);
  L(`    CDR rows = ${after.length}, total = ${after[0].total_idr} -> CDR IMMUTABLE: ${after[0].total_idr === before[0].total_idr && after[0].id === before[0].id}`);
  L(`    session row: energy_wh=${sess[0].energy_wh} meter_stop_wh=${sess[0].meter_stop_wh} state=${sess[0].state}`);
  L(`    -> the session row drifted to ${sess[0].energy_wh} Wh while the CDR still says ${before[0].subtotal_idr} subtotal for 20,000 Wh.`);
  L(`       Any report built from charging_session.energy_wh will not reconcile with the CDRs.`);

  await wipe(); cp.close(); await db.end(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
