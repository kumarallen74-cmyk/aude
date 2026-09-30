import WebSocket from 'ws';
const GW = 'ws://127.0.0.1:9720/ocpp';
function connect(identity: string, subproto: string[] = ['ocpp1.6']): Promise<string> {
  return new Promise((resolve) => {
    const url = `${GW}/${encodeURIComponent(identity)}`;
    const ws = new WebSocket(url, subproto);
    const t = setTimeout(() => { try{ws.close();}catch{}; resolve('timeout'); }, 5000);
    ws.on('open', () => { clearTimeout(t); ws.send(JSON.stringify([2,'b','BootNotification',{chargePointVendor:'Rival',chargePointModel:'DC180'}])); setTimeout(()=>{try{ws.close();}catch{}; resolve('open');},800); });
    ws.on('error', () => { clearTimeout(t); resolve('error'); });
    ws.on('unexpected-response', (_r,res) => { clearTimeout(t); resolve('HTTP'+res.statusCode); });
  });
}
for (const id of ['RIVAL-DC180-XYZ-001','TOTALLY-UNKNOWN-9999','ANOTHER-UNKNOWN-42']) {
  console.log(id, await connect(id));
}
process.exit(0);
