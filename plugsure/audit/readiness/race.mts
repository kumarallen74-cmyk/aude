import WebSocket from 'ws';
(async()=>{
  const ids = ['RACE-A-001','RACE-B-002','RACE-C-003'];
  for (const id of ids) {
    await new Promise<void>(res=>{
      const ws = new WebSocket(`ws://127.0.0.1:9324/ocpp/${id}`, ['ocpp1.6']);
      ws.on('open', ()=>{ ws.terminate(); res(); });   // abrupt close, like a 4G drop
      ws.on('error', ()=>res());
      setTimeout(res, 4000);
    });
    await new Promise(r=>setTimeout(r,300));
  }
  process.exit(0);
})();
