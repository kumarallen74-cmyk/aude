import { CP, sleep, mvRegister } from './cp.js';
import pg from 'pg';
const db = new pg.Pool({ connectionString: 'postgresql://postgres:plugsure@127.0.0.1:5432/plugsure_r3b' });
const L = (s:string)=>console.log(s);
const q = async (sql:string,p:any[]=[])=>(await db.query(sql,p)).rows;
const CPID='AUTEL-DC60-SMB-002', IDTAG='ID-RFID-0001', API='http://127.0.0.1:9600';
const wipe = async()=>{ await q(`DELETE FROM cdr`); await q(`DELETE FROM meter_value`); await q(`UPDATE payment_intent SET session_id=NULL`); await q(`DELETE FROM charging_session`); await q(`DELETE FROM payment_intent`); };
const last = async()=>(await q(`SELECT cs.id,cs.energy_wh,cs.state,cs.needs_review,cs.review_reason,cs.payment_mode,cs.prepaid_amount_idr,cs.prepaid_energy_wh,cs.idle_minutes,cs.flags,d.total_idr,d.lines FROM charging_session cs LEFT JOIN cdr d ON d.session_id=cs.id ORDER BY cs.created_at DESC LIMIT 1`))[0];

async function checkout(amount:number){
  const res = await fetch(`${API}/v1/checkout/qris`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ocppIdentity:CPID,connectorId:1,amountIdr:amount})});
  return {status:res.status, body: await res.json() as any};
}

async function main(){
  await q(`DELETE FROM tariff_assignment WHERE scope_type='connector'`);
  await q(`DELETE FROM tariff WHERE name IN ('NIGHT','OLD','NEW')`);
  const cp = await (new CP(CPID)).connect(); await cp.boot(); await sleep(1200);

  L('=== P1. QRIS checkout Rp 100,000 on the seed tariff ===');
  await wipe();
  const c1 = await checkout(100_000);
  L(`  ${c1.status} allowanceWh=${c1.body.allowanceWh} kWh=${c1.body.allowanceKwh} mdr=${c1.body.estimatedMdrIdr} zeroBand=${c1.body.inZeroMdrBand}`);
  const ref = c1.body.qr.providerRef;
  await fetch(`${API}/v1/checkout/qris/${ref}/simulate-payment`,{method:'POST'});

  L('\n=== P2. drive the session to exactly the allowance, then leave the car plugged for 60 min ===');
  const startIso = '2026-08-24T13:00:00Z';
  const s = await cp.call('StartTransaction',{connectorId:1,idTag:IDTAG,meterStart:0,timestamp:startIso});
  let row = await last();
  L(`  session payment_mode=${row.payment_mode} prepaid_amount=${row.prepaid_amount_idr} prepaid_wh=${row.prepaid_energy_wh}`);
  const allow = Number(row.prepaid_energy_wh);
  // deliver in 5-minute samples at 60 kW (5 kWh per sample) until past the allowance
  let wh=0, t=Date.parse(startIso);
  while (wh < allow) { wh = Math.min(allow, wh+5000); t+=300000; await cp.call('MeterValues',{connectorId:1,transactionId:s.transactionId,meterValue:mvRegister(new Date(t).toISOString(), wh)}); }
  await sleep(500);
  // car sits idle for 60 min with flat register
  for (let i=0;i<6;i++){ t+=600000; await cp.call('MeterValues',{connectorId:1,transactionId:s.transactionId,meterValue:mvRegister(new Date(t).toISOString(), wh)}); }
  await cp.call('StopTransaction',{transactionId:s.transactionId,meterStop:wh,timestamp:new Date(t).toISOString(),reason:'Local'});
  await sleep(1200);
  row = await last();
  L(`  delivered=${row.energy_wh} Wh, idle_minutes=${row.idle_minutes}`);
  L(`  CDR total = Rp ${row.total_idr}   prepaid = Rp ${row.prepaid_amount_idr}`);
  L(`  lines = ${JSON.stringify((row.lines as any[])?.map((l:any)=>[l.kind,l.quantity,l.amountIdr]))}`);
  L(`  >>> SHORTFALL = Rp ${Number(row.total_idr) - Number(row.prepaid_amount_idr)} uncollectable from a walk-up guest`);
  L(`  payment_intent captured = ${JSON.stringify(await q(`SELECT state, amount_authorised_idr, amount_captured_idr, session_id IS NOT NULL AS bound FROM payment_intent`))}`);

  L('\n=== P3. overrun: charger reports every 15 min at 60 kW; how far past the allowance? ===');
  await wipe();
  const c3 = await checkout(100_000); const ref3 = c3.body.qr.providerRef;
  await fetch(`${API}/v1/checkout/qris/${ref3}/simulate-payment`,{method:'POST'});
  const s3 = await cp.call('StartTransaction',{connectorId:1,idTag:IDTAG,meterStart:0,timestamp:startIso});
  let r3 = await last(); const allow3 = Number(r3.prepaid_energy_wh);
  let wh3=0, t3=Date.parse(startIso);
  for (let i=0;i<3;i++){ wh3+=15000; t3+=900000; await cp.call('MeterValues',{connectorId:1,transactionId:s3.transactionId,meterValue:mvRegister(new Date(t3).toISOString(), wh3)}); await sleep(200); }
  await cp.call('StopTransaction',{transactionId:s3.transactionId,meterStop:wh3,timestamp:new Date(t3).toISOString(),reason:'Local'});
  await sleep(1200);
  r3 = await last();
  L(`  allowance=${allow3} Wh; delivered=${r3.energy_wh} Wh; CDR=Rp ${r3.total_idr} vs paid Rp 100000; shortfall=Rp ${Number(r3.total_idr)-100000}`);

  L('\n=== P4. two drivers scan the same connector; only the newest intent is claimed ===');
  await wipe();
  const a = await checkout(50_000); await fetch(`${API}/v1/checkout/qris/${a.body.qr.providerRef}/simulate-payment`,{method:'POST'});
  await sleep(50);
  const b = await checkout(250_000); await fetch(`${API}/v1/checkout/qris/${b.body.qr.providerRef}/simulate-payment`,{method:'POST'});
  const s4 = await cp.call('StartTransaction',{connectorId:1,idTag:IDTAG,meterStart:0,timestamp:startIso});
  await sleep(400);
  const r4 = await last();
  L(`  claimed prepaid_amount=${r4.prepaid_amount_idr} (A paid 50,000 first; B paid 250,000 second)`);
  L(`  intents: ${JSON.stringify(await q(`SELECT amount_authorised_idr amt, state, session_id IS NOT NULL bound FROM payment_intent ORDER BY created_at`))}`);
  await cp.call('StopTransaction',{transactionId:s4.transactionId,meterStop:1000,timestamp:'2026-08-24T13:10:00Z',reason:'Local'});
  await sleep(600);

  L('\n=== P5. QRIS ceiling + MDR ===');
  const over = await checkout(10_000_001);
  L(`  amountIdr=10,000,001 -> HTTP ${over.status}`);
  for (const amt of [50_000, 99_999, 100_000, 100_001, 500_000]) {
    const cc = await checkout(amt);
    L(`  ${amt} -> ${cc.status} allowanceWh=${cc.body.allowanceWh} mdr=${cc.body.estimatedMdrIdr}`);
    await q(`DELETE FROM payment_intent`);
  }

  L('\n=== P6. amount below the fixed fees ===');
  const low = await checkout(20_000);
  L(`  20,000 -> HTTP ${low.status} ${JSON.stringify(low.body)}`);

  await db.end(); cp.close(); process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
