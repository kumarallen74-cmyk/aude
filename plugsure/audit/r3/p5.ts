import { CP, sleep, mvRegister } from './cp.js';
import pg from 'pg';
const db = new pg.Pool({ connectionString: 'postgresql://postgres:plugsure@127.0.0.1:5432/plugsure_r3b' });
const L = (s: string) => console.log(s);
const q = async (sql: string, p: any[] = []) => (await db.query(sql, p)).rows;
const CPID = 'AUTEL-DC60-SMB-002', IDTAG = 'ID-RFID-0001';
const API = 'http://127.0.0.1:9600';
const wipe = async () => { await q(`DELETE FROM cdr`); await q(`DELETE FROM meter_value`); await q(`UPDATE payment_intent SET session_id=NULL`); await q(`DELETE FROM charging_session`); };
const last = async () => (await q(`SELECT cs.id, cs.energy_wh, cs.state, cs.needs_review, cs.review_reason, cs.flags, d.total_idr, d.lines, d.regulatory_flags FROM charging_session cs LEFT JOIN cdr d ON d.session_id=cs.id ORDER BY cs.created_at DESC LIMIT 1`))[0];

async function main() {
  const cp = await (new CP(CPID)).connect(); await cp.boot(); await sleep(1200);
  const org = (await q(`SELECT id FROM organisation LIMIT 1`))[0].id;
  const conn = (await q(`SELECT c.id FROM connector c JOIN evse e ON e.id=c.evse_uuid JOIN charge_point cp ON cp.id=e.charge_point_id WHERE cp.ocpp_identity=$1 AND e.evse_id=1`,[CPID]))[0].id;

  L('=== T1. legal night-window tariff + a session outside the window: is it EVER billable? ===');
  await wipe();
  await q(`DELETE FROM tariff_assignment WHERE scope_type='connector'`);
  await q(`DELETE FROM tariff WHERE name='NIGHT'`);
  const t = (await q(`INSERT INTO tariff (org_id,name,pln_scheme,pln_base_rate,pln_multiplier,active_from) VALUES ($1,'NIGHT','layanan_khusus',1645,1.5,'2026-01-01') RETURNING id`,[org]))[0].id;
  await q(`INSERT INTO tariff_component (tariff_id,kind,rate,tou_block,time_from,time_to,from_kwh,from_minutes,sort_order) VALUES ($1,'energy',2467.5,'ANY','00:00','06:00',0,0,0)`,[t]);
  await q(`INSERT INTO tariff_component (tariff_id,kind,rate,tou_block,from_kwh,from_minutes,sort_order) VALUES ($1,'session',21000,'ANY',0,0,1)`,[t]);
  await q(`INSERT INTO tariff_assignment (tariff_id,scope_type,scope_id,priority) VALUES ($1,'connector',$2,10)`,[t,conn]);

  // 20:00 -> 22:00 WIB on 2026-08-24 == 13:00 -> 15:00 UTC
  const s1 = await cp.call('StartTransaction', { connectorId:1, idTag:IDTAG, meterStart:0, timestamp:'2026-08-24T13:00:00Z' });
  await cp.call('StopTransaction', { transactionId:s1.transactionId, meterStop:40_000, timestamp:'2026-08-24T15:00:00Z', reason:'Local' });
  await sleep(900);
  let r = await last();
  L(`  after stop: state=${r.state} review=${r.needs_review} reason=${r.review_reason} CDR=${r.total_idr ?? 'NONE'}`);
  const res1 = await fetch(`${API}/v1/sessions/${r.id}/rerate`, {method:'POST'});
  L(`  POST clear-review -> ${res1.status} ${JSON.stringify(await res1.json())}`);
  await sleep(400);
  r = await last();
  L(`  after clear-review: review=${r.needs_review} reason=${r.review_reason} CDR=${r.total_idr ?? 'NONE'}`);
  L(`  -> 40 kWh delivered (Rp 98,700 energy + Rp 21,000 fee) is UNBILLABLE: ${r.total_idr==null}`);

  L('\n=== T2. same tariff, session half inside the window (04:00-08:00 WIB) ===');
  await wipe();
  const s2 = await cp.call('StartTransaction', { connectorId:1, idTag:IDTAG, meterStart:0, timestamp:'2026-08-24T21:00:00Z' });
  await cp.call('StopTransaction', { transactionId:s2.transactionId, meterStop:40_000, timestamp:'2026-08-25T01:00:00Z', reason:'Local' });
  await sleep(900);
  r = await last();
  L(`  state=${r.state} review=${r.needs_review} reason=${r.review_reason} CDR=${r.total_idr ?? 'NONE'}`);

  L('\n=== T3. tariff changes mid-session: is the START tariff used? ===');
  await wipe();
  await q(`DELETE FROM tariff_assignment WHERE scope_type='connector'`);
  await q(`DELETE FROM tariff WHERE name IN ('NIGHT','OLD','NEW')`);
  const told = (await q(`INSERT INTO tariff (org_id,name,pln_scheme,pln_base_rate,pln_multiplier,active_from,active_to) VALUES ($1,'OLD','layanan_khusus',1645,1.0,'2026-01-01','2026-08-24T14:00:00Z') RETURNING id`,[org]))[0].id;
  await q(`INSERT INTO tariff_component (tariff_id,kind,rate,tou_block,from_kwh,from_minutes,sort_order) VALUES ($1,'energy',1645,'ANY',0,0,0)`,[told]);
  await q(`INSERT INTO tariff_assignment (tariff_id,scope_type,scope_id,priority) VALUES ($1,'connector',$2,10)`,[told,conn]);
  const tnew = (await q(`INSERT INTO tariff (org_id,name,pln_scheme,pln_base_rate,pln_multiplier,active_from) VALUES ($1,'NEW','layanan_khusus',1645,1.5,'2026-08-24T14:00:00Z') RETURNING id`,[org]))[0].id;
  await q(`INSERT INTO tariff_component (tariff_id,kind,rate,tou_block,from_kwh,from_minutes,sort_order) VALUES ($1,'energy',2467.5,'ANY',0,0,0)`,[tnew]);
  await q(`INSERT INTO tariff_assignment (tariff_id,scope_type,scope_id,priority) VALUES ($1,'connector',$2,10)`,[tnew,conn]);
  const s3 = await cp.call('StartTransaction', { connectorId:1, idTag:IDTAG, meterStart:0, timestamp:'2026-08-24T13:00:00Z' });
  await cp.call('StopTransaction', { transactionId:s3.transactionId, meterStop:40_000, timestamp:'2026-08-24T15:00:00Z', reason:'Local' });
  await sleep(900);
  r = await last();
  L(`  CDR=${r.total_idr} lines=${JSON.stringify((r.lines as any[])?.map((l:any)=>[l.description,l.quantity,l.unitRate,l.amountIdr]))}`);
  L(`  -> started under OLD (Rp1645/kWh). 40 kWh at the OLD rate = Rp 65,800 subtotal; at NEW = Rp 98,700.`);
  L(`  snapshot name: ${(await q(`SELECT tariff_snapshot->>'name' n FROM cdr`))[0]?.n}`);

  L('\n=== T4. concurrent MeterValues (20 in flight) ===');
  await wipe();
  await q(`DELETE FROM tariff_assignment WHERE scope_type='connector'`);
  const s4 = await cp.call('StartTransaction', { connectorId:1, idTag:IDTAG, meterStart:0, timestamp:'2026-08-24T13:00:00Z' });
  await Promise.all(Array.from({length:20},(_,i)=>cp.call('MeterValues',{connectorId:1,transactionId:s4.transactionId,meterValue:mvRegister(new Date(Date.parse('2026-08-24T13:00:00Z')+ (i+1)*60000).toISOString(), (i+1)*1000)})));
  await sleep(800);
  const mid = (await q(`SELECT energy_wh FROM charging_session ORDER BY created_at DESC LIMIT 1`))[0];
  L(`  after 20 concurrent samples up to 20,000 Wh: energy_wh=${mid.energy_wh} (expect 20000)`);
  await cp.call('StopTransaction',{transactionId:s4.transactionId, meterStop:20_000, timestamp:'2026-08-24T14:00:00Z', reason:'Local'});
  await sleep(800);
  r = await last();
  L(`  final energy=${r.energy_wh} CDR=${r.total_idr}`);

  await db.end(); cp.close(); process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
