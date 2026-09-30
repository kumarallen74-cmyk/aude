import WebSocket from 'ws';
const GW = 'ws://127.0.0.1:9720/ocpp';
function boot(identity: string, closeMs: number): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${GW}/${encodeURIComponent(identity)}`, ['ocpp1.6']);
    const t = setTimeout(() => { try{ws.terminate();}catch{}; resolve('timeout'); }, 6000);
    ws.on('open', () => {
      ws.send(JSON.stringify([2,'b','BootNotification',{chargePointVendor:'Rival',chargePointModel:'DC180',firmwareVersion:'1.2.3'}]));
      setTimeout(()=>{ clearTimeout(t); try{ws.terminate();}catch{}; resolve('closed@'+closeMs); }, closeMs);
    });
    ws.on('error', () => { clearTimeout(t); resolve('error'); });
    ws.on('unexpected-response', (_r,res)=>{clearTimeout(t);resolve('HTTP'+res.statusCode);});
  });
}
// connect the real org-B charger and terminate mid-boot processing
const id = process.argv[2] || 'RIVAL-DC180-XYZ-001';
const ms = Number(process.argv[3] ?? 50);
console.log(await boot(id, ms));
process.exit(0);
