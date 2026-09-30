import { CP, sleep } from './cp.js';
import pg from 'pg';
const db=new pg.Pool({connectionString:'postgresql://postgres:plugsure@127.0.0.1:5432/plugsure_r3b'});
const L=(s:string)=>console.log(s);
const q=async(sql:string,p:any[]=[])=>(await db.query(sql,p)).rows;
const API='http://127.0.0.1:9600', CPID='AUTEL-DC60-SMB-002', IDTAG='ID-RFID-0001';
const post=async(u:string,b:any)=>{const r=await fetch(API+u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});return{s:r.status,b:await r.json() as any};};

async function main(){
  const cp=await(new CP(CPID)).connect(); await cp.boot(); await sleep(1200);
  await q(`DELETE FROM cdr`);await q(`DELETE FROM meter_value`);await q(`UPDATE payment_intent SET session_id=NULL`);await q(`DELETE FROM charging_session`);
  await q(`DELETE FROM tariff_assignment WHERE tariff_id IN (SELECT id FROM tariff WHERE name LIKE 'X-%')`);
  await q(`DELETE FROM tariff_component WHERE tariff_id IN (SELECT id FROM tariff WHERE name LIKE 'X-%')`);
  await q(`DELETE FROM tariff WHERE name LIKE 'X-%'`);
  const conn=(await q(`SELECT c.id FROM connector c JOIN evse e ON e.id=c.evse_uuid JOIN charge_point cp ON cp.id=e.charge_point_id WHERE cp.ocpp_identity=$1 AND e.evse_id=1`,[CPID]))[0].id;

  L('=== X1. POST /v1/tariffs with base ANY 2467.5 + "peak surcharge" WBP 2467.5 (both cover all energy) ===');
  const r1=await post('/v1/tariffs',{name:'X-DOUBLE',plnScheme:'layanan_khusus',plnBaseRate:1645,plnMultiplier:1.5,activeFrom:'2026-01-01T00:00:00Z',appliesToMaxPowerW:60000,components:[
    {kind:'energy',rate:2467.5,touBlock:'ANY',fromKwh:0},
    {kind:'energy',rate:2467.5,touBlock:'WBP',fromKwh:0},
    {kind:'session',rate:21000,touBlock:'ANY'},
  ]});
  L(`  HTTP ${r1.s} ok=${r1.b.ok} flags=${JSON.stringify(r1.b.flags)}`);
  if(r1.b.tariffId){
    await post(`/v1/tariffs/${r1.b.tariffId}/assign`,{scopeType:'connector',scopeId:conn,priority:20});
    // session 17:00-19:00 WIB = 10:00-12:00 UTC, entirely WBP
    const s=await cp.call('StartTransaction',{connectorId:1,idTag:IDTAG,meterStart:0,timestamp:'2026-08-24T10:00:00Z'});
    await cp.call('StopTransaction',{transactionId:s.transactionId,meterStop:40000,timestamp:'2026-08-24T12:00:00Z',reason:'Local'});
    await sleep(1000);
    const r=(await q(`SELECT cs.needs_review,d.total_idr,d.subtotal_idr,d.lines,d.regulatory_flags FROM charging_session cs LEFT JOIN cdr d ON d.session_id=cs.id ORDER BY cs.created_at DESC LIMIT 1`))[0];
    L(`  billed CDR total=Rp ${r.total_idr} subtotal=Rp ${r.subtotal_idr} review=${r.needs_review}`);
    L(`  lines=${JSON.stringify((r.lines as any[])?.map((l:any)=>[l.description,l.quantity,l.unitRate,l.amountIdr]))}`);
    L(`  regulatory_flags=${JSON.stringify((r.regulatory_flags as any[])?.map((f:any)=>f.code))}`);
    L(`  effective energy rate = Rp ${( (Number(r.subtotal_idr)-21000)/40 ).toFixed(2)}/kWh; regulated ceiling = Rp 2467.50/kWh`);
  }

  L('\n=== X2. POST /v1/tariffs with a night-only energy window (no ceiling breach, perfectly legal) ===');
  const r2=await post('/v1/tariffs',{name:'X-NIGHT',plnScheme:'layanan_khusus',plnBaseRate:1645,plnMultiplier:1.5,activeFrom:'2026-01-01T00:00:00Z',appliesToMaxPowerW:60000,components:[
    {kind:'energy',rate:2000,touBlock:'ANY',fromKwh:0,timeFrom:'00:00',timeTo:'06:00'},
    {kind:'session',rate:21000,touBlock:'ANY'},
  ]});
  L(`  HTTP ${r2.s} ok=${r2.b.ok} flags=${JSON.stringify(r2.b.flags)}  <- accepted with no warning that daytime sessions cannot be priced`);

  L('\n=== X3. tariff with a service fee above the ceiling: does the write path block it? ===');
  const r3=await post('/v1/tariffs',{name:'X-ILLEGAL',plnScheme:'layanan_khusus',plnBaseRate:1645,plnMultiplier:1.5,appliesToMaxPowerW:30000,components:[
    {kind:'energy',rate:2467.5,touBlock:'ANY',fromKwh:0},
    {kind:'session',rate:40000,touBlock:'ANY'},
  ]});
  L(`  HTTP ${r3.s} ${JSON.stringify(r3.b).slice(0,200)}`);

  L('\n=== X4. same illegal fee, but declared as appliesToMaxPowerW=60000 then assigned to a 30 kW connector ===');
  const r4=await post('/v1/tariffs',{name:'X-BYPASS',plnScheme:'layanan_khusus',plnBaseRate:1645,plnMultiplier:1.5,activeFrom:'2026-01-01T00:00:00Z',appliesToMaxPowerW:60000,components:[
    {kind:'energy',rate:2467.5,touBlock:'ANY',fromKwh:0},
    {kind:'session',rate:50000,touBlock:'ANY'},
  ]});
  L(`  HTTP ${r4.s} ok=${r4.b.ok} (Rp 50,000 fee saved because 57,000 ultrafast ceiling was declared)`);

  await db.end(); cp.close(); process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
