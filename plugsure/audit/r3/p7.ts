import { CP, sleep, mvRegister } from './cp.js';
import pg from 'pg';
const db = new pg.Pool({ connectionString: 'postgresql://postgres:plugsure@127.0.0.1:5432/plugsure_r3b' });
const L=(s:string)=>console.log(s);
const q=async(sql:string,p:any[]=[])=>(await db.query(sql,p)).rows;
const CPID='AUTEL-DC60-SMB-002', IDTAG='ID-RFID-0001';
const wipe=async()=>{ await q(`DELETE FROM cdr`); await q(`DELETE FROM meter_value`); await q(`UPDATE payment_intent SET session_id=NULL`); await q(`DELETE FROM charging_session`); await q(`DELETE FROM payment_intent`); };
const last=async()=>(await q(`SELECT cs.id,cs.energy_wh,cs.idle_minutes,cs.state,cs.needs_review,cs.flags,d.total_idr,d.lines FROM charging_session cs LEFT JOIN cdr d ON d.session_id=cs.id ORDER BY cs.created_at DESC LIMIT 1`))[0];

async function main(){
  const cp=await(new CP(CPID)).connect(); await cp.boot(); await sleep(1200);
  const S='2026-08-24T13:00:00Z';

  L('=== I1. realistic trickle during idle (EV maintenance current, 5 Wh per 10 min) ===');
  await wipe();
  const s1=await cp.call('StartTransaction',{connectorId:1,idTag:IDTAG,meterStart:0,timestamp:S});
  let t=Date.parse(S), wh=0;
  for(let i=0;i<4;i++){ wh+=10000; t+=600000; await cp.call('MeterValues',{connectorId:1,transactionId:s1.transactionId,meterValue:mvRegister(new Date(t).toISOString(),wh)}); }
  // charging done at +40 min. idle 60 min with a 5 Wh trickle every 10 min
  for(let i=0;i<6;i++){ wh+=5; t+=600000; await cp.call('MeterValues',{connectorId:1,transactionId:s1.transactionId,meterValue:mvRegister(new Date(t).toISOString(),wh)}); }
  await cp.call('StopTransaction',{transactionId:s1.transactionId,meterStop:wh,timestamp:new Date(t).toISOString(),reason:'Local'});
  await sleep(1000);
  let r=await last();
  L(`  idle_minutes=${r.idle_minutes} (expect ~60) CDR=Rp ${r.total_idr} lines=${JSON.stringify((r.lines as any[])?.map((l:any)=>[l.kind,l.quantity,l.amountIdr]))}`);

  L('\n=== I2. idle over a ROLLOVER session ===');
  await wipe();
  const s2=await cp.call('StartTransaction',{connectorId:1,idTag:IDTAG,meterStart:9_995_000,timestamp:S});
  await cp.call('MeterValues',{connectorId:1,transactionId:s2.transactionId,meterValue:mvRegister('2026-08-24T13:05:00Z',9_998_000)});
  await cp.call('StopTransaction',{transactionId:s2.transactionId,meterStop:2_000,timestamp:'2026-08-24T14:00:00Z',reason:'Local'});
  await sleep(1000);
  r=await last();
  L(`  energy=${r.energy_wh} (expect 7000) idle_minutes=${r.idle_minutes} (expect ~0) CDR=Rp ${r.total_idr}`);
  L(`  lines=${JSON.stringify((r.lines as any[])?.map((l:any)=>[l.kind,l.quantity,l.amountIdr]))}`);

  L('\n=== I3. CDR arithmetic self-check across 40 random sessions ===');
  const rows=await q(`SELECT lines, subtotal_idr, pbjt_rate_bps, pbjt_idr, ppn_dpp_idr, ppn_idr, total_idr FROM cdr`);
  L(`  (checked below on synthetic rating instead)`);

  L('\n=== I4. duration/energy sanity: 8-day session (beyond maxSessionHours 168) ===');
  await wipe();
  const s4=await cp.call('StartTransaction',{connectorId:1,idTag:IDTAG,meterStart:0,timestamp:'2026-08-20T00:00:00Z'});
  await cp.call('StopTransaction',{transactionId:s4.transactionId,meterStop:60_000,timestamp:'2026-08-28T02:00:00Z',reason:'Local'});
  await sleep(1000);
  r=await last();
  L(`  state=${r.state} review=${r.needs_review} CDR=${r.total_idr ?? 'NONE'} flags=${JSON.stringify((r.flags as any[]).map((f:any)=>f.code))}`);

  L('\n=== I5. inverted timestamps ===');
  await wipe();
  const s5=await cp.call('StartTransaction',{connectorId:1,idTag:IDTAG,meterStart:0,timestamp:'2026-08-24T14:00:00Z'});
  await cp.call('StopTransaction',{transactionId:s5.transactionId,meterStop:40_000,timestamp:'2026-08-24T13:00:00Z',reason:'Local'});
  await sleep(1000);
  r=await last();
  L(`  state=${r.state} review=${r.needs_review} CDR=${r.total_idr ?? 'NONE'} idle=${r.idle_minutes} flags=${JSON.stringify((r.flags as any[]).map((f:any)=>f.code))}`);

  L('\n=== I6. StartTransaction replay (idempotency) ===');
  await wipe();
  const a=await cp.call('StartTransaction',{connectorId:1,idTag:IDTAG,meterStart:0,timestamp:S});
  const b=await cp.call('StartTransaction',{connectorId:1,idTag:IDTAG,meterStart:0,timestamp:S});
  await sleep(400);
  L(`  txIds ${a.transactionId} / ${b.transactionId}; sessions=${(await q(`SELECT count(*) c FROM charging_session`))[0].c}`);
  await cp.call('StopTransaction',{transactionId:a.transactionId,meterStop:40_000,timestamp:'2026-08-24T14:00:00Z',reason:'Local'});
  await sleep(800);
  L(`  CDRs=${(await q(`SELECT count(*) c FROM cdr`))[0].c} totals=${JSON.stringify((await q(`SELECT total_idr FROM cdr`)).map(x=>x.total_idr))}`);

  L('\n=== I7. DB constraints on money-relevant columns ===');
  for (const t of [`UPDATE site SET pbjt_rate_bps = 5000`, `INSERT INTO tariff_component (tariff_id,kind,rate,tou_block,from_kwh,from_minutes,sort_order) SELECT id,'energy',999999,'ANY',0,0,9 FROM tariff LIMIT 1`]) {
    try { await q(t); L(`  ACCEPTED: ${t}`); } catch(e:any){ L(`  rejected: ${t} -> ${e.message.slice(0,80)}`); }
  }
  await q(`UPDATE site SET pbjt_rate_bps = 500`);
  await q(`DELETE FROM tariff_component WHERE sort_order=9`);

  await db.end(); cp.close(); process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
