import WebSocket from 'ws';
const ID='REPLAY2-001';
const ws=new WebSocket(`ws://127.0.0.1:9324/ocpp/${ID}`,['ocpp1.6']);
const acks=new Map<string,any>();
const send=(f:any[])=>{ws.send(JSON.stringify(f));return new Promise(r=>setTimeout(r,800));};
ws.on('message',d=>{const m=JSON.parse(d.toString()); if(m[0]===3) acks.set(m[1],m[2]);});
ws.on('open',async()=>{
  await send([2,'b','BootNotification',{chargePointVendor:'Autel',chargePointModel:'MaxiCharger AC Wallbox',firmwareVersion:'V1.4.12'}]);
  await send([2,'s','StatusNotification',{connectorId:1,errorCode:'NoError',status:'Available',timestamp:new Date().toISOString()}]);
  const t0=new Date(Date.now()-3600_000).toISOString(), t1=new Date().toISOString();
  await send([2,'st1','StartTransaction',{connectorId:1,idTag:'ID-RFID-0001',meterStart:1000000,timestamp:t0}]);
  const tx=acks.get('st1').transactionId; console.log('CSMS assigned transactionId =',tx);
  await send([2,'sp1','StopTransaction',{transactionId:tx,idTag:'ID-RFID-0001',meterStop:1010000,timestamp:t1,reason:'Local'}]);
  console.log('--- replaying the identical StartTransaction (1.6 retry: charger has no txId yet) ---');
  await send([2,'st2','StartTransaction',{connectorId:1,idTag:'ID-RFID-0001',meterStart:1000000,timestamp:t0}]);
  console.log('CSMS assigned transactionId on replay =',acks.get('st2').transactionId);
  await send([2,'sp2','StopTransaction',{transactionId:tx,idTag:'ID-RFID-0001',meterStop:1010000,timestamp:t1,reason:'Local'}]);
  setTimeout(()=>{ws.close();process.exit(0);},3000);
});
