import WebSocket from 'ws';
const cases = [
  { n:'unknown charger, no auth (technician typo in ID)', url:'ws://127.0.0.1:9324/ocpp/AUTEL-NEW-ONSITE-9001', h:{} },
  { n:'known charger, NO auth header (profile 1 required)', url:'ws://127.0.0.1:9324/ocpp/AUTEL-AC22-SMB-001', h:{} },
  { n:'known charger, WRONG password', url:'ws://127.0.0.1:9324/ocpp/AUTEL-AC22-SMB-001', h:{Authorization:'Basic '+Buffer.from('AUTEL-AC22-SMB-001:deadbeef').toString('base64')} },
  { n:'known charger, right user wrong case id', url:'ws://127.0.0.1:9324/ocpp/autel-ac22-smb-001', h:{} },
];
(async()=>{ for(const c of cases){ await new Promise<void>(r=>{
  const ws=new WebSocket(c.url,['ocpp1.6'],{headers:c.h,handshakeTimeout:4000});
  const f=(s:string)=>{console.log(c.n.padEnd(50),'->',s); r();};
  ws.on('open',()=>{f('OPEN');ws.close();});
  ws.on('unexpected-response',(_a,b)=>f(`HTTP ${b.statusCode} ${b.statusMessage}`));
  ws.on('error',(e:any)=>f('ERR '+e.message));
  setTimeout(()=>f('timeout'),5000);
});} process.exit(0);})();
