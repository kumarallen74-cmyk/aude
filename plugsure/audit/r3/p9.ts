import { CP, sleep } from './cp.js';
import pg from 'pg';
const db=new pg.Pool({connectionString:'postgresql://postgres:plugsure@127.0.0.1:5432/plugsure_r3b'});
const L=(s:string)=>console.log(s);
const q=async(sql:string,p:any[]=[])=>(await db.query(sql,p)).rows;
const API='http://127.0.0.1:9600', CPID='AUTEL-DC60-SMB-002', IDTAG='ID-RFID-0001';
const post=async(u:string,b:any)=>{const r=await fetch(API+u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});return{s:r.status,b:await r.json() as any};};
const clean=async()=>{await q(`DELETE FROM cdr`);await q(`DELETE FROM meter_value`);await q(`UPDATE payment_intent SET session_id=NULL`);await q(`DELETE FROM charging_session`);await q(`DELETE FROM tariff_assignment WHERE scope_type='connector'`);};

async function main(){
  const cp=await(new CP(CPID)).connect(); await cp.boot(); await sleep(1200);
  const conn=(await q(`SELECT c.id, c.max_power_w FROM connector c JOIN evse e ON e.id=c.evse_uuid JOIN charge_point cp ON cp.id=e.charge_point_id WHERE cp.ocpp_identity=$1 AND e.evse_id=1`,[CPID]))[0];
  L(`connector max_power_w=${conn.max_power_w}`);

  L('=== Y1. plnScheme "none": is there ANY energy-rate ceiling? ===');
  await clean();
  const y1=await post('/v1/tariffs',{name:'Y-NONE',plnScheme:'none',activeFrom:'2026-01-01T00:00:00Z',appliesToMaxPowerW:60000,components:[
    {kind:'energy',rate:10000,touBlock:'ANY',fromKwh:0},{kind:'session',rate:21000,touBlock:'ANY'}]});
  L(`  create -> HTTP ${y1.s} ok=${y1.b.ok} flags=${JSON.stringify(y1.b.flags)}`);
  await post(`/v1/tariffs/${y1.b.tariffId}/assign`,{scopeType:'connector',scopeId:conn.id,priority:30});
  const s1=await cp.call('StartTransaction',{connectorId:1,idTag:IDTAG,meterStart:0,timestamp:'2026-08-24T10:00:00Z'});
  await cp.call('StopTransaction',{transactionId:s1.transactionId,meterStop:40000,timestamp:'2026-08-24T12:00:00Z',reason:'Local'});
  await sleep(1000);
  let r=(await q(`SELECT cs.needs_review,d.total_idr,d.subtotal_idr,d.regulatory_flags FROM charging_session cs LEFT JOIN cdr d ON d.session_id=cs.id ORDER BY cs.created_at DESC LIMIT 1`))[0];
  L(`  40 kWh @ Rp10,000/kWh -> CDR Rp ${r.total_idr} review=${r.needs_review} flags=${JSON.stringify((r.regulatory_flags as any[])?.map((f:any)=>f.code))}`);

  L('\n=== Y2. appliesToMaxPowerW bypass, assigned to a 30 kW (fast) connector ===');
  await clean();
  await q(`UPDATE connector SET max_power_w=30000 WHERE id=$1`,[conn.id]);
  const y2=await post('/v1/tariffs',{name:'Y-BYPASS2',plnScheme:'layanan_khusus',plnBaseRate:1645,plnMultiplier:1.5,activeFrom:'2026-01-01T00:00:00Z',appliesToMaxPowerW:60000,components:[
    {kind:'energy',rate:2467.5,touBlock:'ANY',fromKwh:0},{kind:'session',rate:50000,touBlock:'ANY'}]});
  L(`  create (declared ultrafast) -> HTTP ${y2.s} ok=${y2.b.ok}`);
  await post(`/v1/tariffs/${y2.b.tariffId}/assign`,{scopeType:'connector',scopeId:conn.id,priority:30});
  const s2=await cp.call('StartTransaction',{connectorId:1,idTag:IDTAG,meterStart:0,timestamp:'2026-08-24T10:00:00Z'});
  await cp.call('StopTransaction',{transactionId:s2.transactionId,meterStop:40000,timestamp:'2026-08-24T12:00:00Z',reason:'Local'});
  await sleep(1000);
  r=(await q(`SELECT cs.id,cs.needs_review,cs.review_reason,d.total_idr FROM charging_session cs LEFT JOIN cdr d ON d.session_id=cs.id ORDER BY cs.created_at DESC LIMIT 1`))[0];
  L(`  session on a 30 kW connector: review=${r.needs_review} reason=${r.review_reason} CDR=${r.total_idr ?? 'NONE'}`);
  const rr=await post(`/v1/sessions/${r.id}/rerate`,{});
  L(`  rerate -> HTTP ${rr.s} ${JSON.stringify(rr.b)}`);
  r=(await q(`SELECT needs_review,review_reason FROM charging_session WHERE id=$1`,[r.id]))[0];
  L(`  after rerate: review=${r.needs_review} reason=${r.review_reason}  -> permanently unbillable`);
  await q(`UPDATE connector SET max_power_w=$2 WHERE id=$1`,[conn.id, conn.max_power_w]);

  L('\n=== Y3. detectRollover false-positive band sweep ===');
  const { } = {};
  await db.end(); cp.close(); process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
