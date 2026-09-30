import WebSocket from 'ws';
const ID = process.argv[2] ?? 'RECONN-001';
let attempt = 0;
function connect(){
  attempt++;
  const t0 = Date.now();
  const ws = new WebSocket(`ws://127.0.0.1:9324/ocpp/${ID}`, ['ocpp1.6'], {handshakeTimeout:4000});
  ws.on('open', ()=>{
    console.log(`[${new Date().toISOString()}] attempt ${attempt}: OPEN`);
    ws.send(JSON.stringify([2,'b'+attempt,'BootNotification',{chargePointVendor:'Autel',chargePointModel:'MaxiCharger AC Wallbox',firmwareVersion:'V1.4.12'}]));
    setInterval(()=>{ if(ws.readyState===1) ws.send(JSON.stringify([2,'h'+Date.now(),'Heartbeat',{}])); }, 5000);
  });
  ws.on('message',(d)=>{const s=d.toString(); if(s.includes('BootNotification')||s.includes('"b'))console.log('  <-',s.slice(0,140));});
  ws.on('close',(c,r)=>{ console.log(`[${new Date().toISOString()}] attempt ${attempt}: CLOSE code=${c} reason=${r?.toString()||''} (after ${Date.now()-t0}ms) — retrying in 3s`); setTimeout(connect,3000); });
  ws.on('error',(e:any)=>console.log(`[${new Date().toISOString()}] attempt ${attempt}: ERR ${e.message}`));
}
connect();
