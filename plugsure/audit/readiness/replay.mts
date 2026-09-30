import WebSocket from 'ws';
const ID='REPLAY-TEST-001';
const ws=new WebSocket(`ws://127.0.0.1:9324/ocpp/${ID}`,['ocpp1.6']);
const send=(f:any[])=>{ws.send(JSON.stringify(f));return new Promise(r=>setTimeout(r,700));};
ws.on('message',d=>console.log('  <-',d.toString().slice(0,220)));
ws.on('open',async()=>{
  await send([2,'b','BootNotification',{chargePointVendor:'Autel',chargePointModel:'MaxiCharger AC Wallbox',firmwareVersion:'V1.4.12'}]);
  await send([2,'s0','StatusNotification',{connectorId:1,errorCode:'NoError',status:'Available',timestamp:new Date().toISOString()}]);
  const t0=new Date(Date.now()-3600_000).toISOString(), t1=new Date().toISOString();
  console.log('--- first delivery (charger was offline, now replaying) ---');
  await send([2,'st1','StartTransaction',{connectorId:1,idTag:'ID-RFID-0001',meterStart:1000000,timestamp:t0}]);
  await send([2,'sp1','StopTransaction',{transactionId:9999,idTag:'ID-RFID-0001',meterStop:1010000,timestamp:t1,reason:'Local'}]);
  console.log('--- DUPLICATE replay of the SAME frames (charger did not see the ack) ---');
  await send([2,'st2','StartTransaction',{connectorId:1,idTag:'ID-RFID-0001',meterStart:1000000,timestamp:t0}]);
  await send([2,'sp2','StopTransaction',{transactionId:9999,idTag:'ID-RFID-0001',meterStop:1010000,timestamp:t1,reason:'Local'}]);
  setTimeout(()=>{ws.close();process.exit(0);},2500);
});
