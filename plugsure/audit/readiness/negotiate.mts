import WebSocket from 'ws';
const log = (...a:any[])=>console.log(...a);

async function scenario(name:string, protos:any, frames:any[][]) {
  return new Promise<void>((res)=>{
    const id = name.replace(/\W+/g,'-');
    const ws = new WebSocket(`ws://127.0.0.1:9324/ocpp/${id}`, protos, {handshakeTimeout:4000});
    let sub:any=null;
    ws.on('upgrade',(r)=>sub=r.headers['sec-websocket-protocol']);
    ws.on('open', async ()=>{
      log(`\n[${name}] OPEN subprotocol=${JSON.stringify(sub)}`);
      for (const f of frames) { ws.send(JSON.stringify(f)); await new Promise(r=>setTimeout(r,600)); }
      setTimeout(()=>{ws.close(); res();}, 1200);
    });
    ws.on('message',(d)=>log(`  <- ${d.toString().slice(0,300)}`));
    ws.on('unexpected-response',(_a,r)=>{log(`[${name}] HTTP ${r.statusCode}`); res();});
    ws.on('error',(e:any)=>{log(`[${name}] ERR ${e.message}`); res();});
    setTimeout(()=>res(), 9000);
  });
}

(async()=>{
  // charger offers both 1.6 and 2.0.1 (newer Autel firmware does this)
  await scenario('DUALPROTO', ['ocpp1.6','ocpp2.0.1'], [
    [2,'m1','BootNotification',{chargePointVendor:'Autel',chargePointModel:'MaxiCharger AC Wallbox',firmwareVersion:'V1.4.12'}],
  ]);
  // unknown DataTransfer
  await scenario('DTTEST', ['ocpp1.6'], [
    [2,'b1','BootNotification',{chargePointVendor:'Autel',chargePointModel:'MaxiCharger AC Wallbox'}],
    [2,'d1','DataTransfer',{vendorId:'com.autel.evcharger',messageId:'SetPricing',data:'{"x":1}'}],
    [2,'u1','SecurityEventNotification',{type:'SettingSystemTime',timestamp:new Date().toISOString()}],
    [2,'z1','SignCertificate',{csr:'---'}],           // not implemented
    [2,'g1','GarbageAction',{}],                       // unknown action
    [2,'bad','StartTransaction',{connectorId:'not-a-number'}], // schema violation
  ]);
  // malformed frames
  await scenario('MALFORMED', ['ocpp1.6'], [
    [2,'b2','BootNotification',{chargePointVendor:'Autel',chargePointModel:'X'}],
  ]);
  process.exit(0);
})();
