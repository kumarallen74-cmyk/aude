import WebSocket from 'ws';
const auth = 'Basic ' + Buffer.from('AUTEL-AC22-SMB-001:0123456789abcdef0123456789abcdef').toString('base64');
new Promise<void>(r=>{
  const ws=new WebSocket('ws://127.0.0.1:9324/ocpp/AUTEL-AC22-SMB-001',['ocpp1.6'],{headers:{Authorization:auth}});
  ws.on('open',()=>{console.log('security_profile=2 charge point CONNECTED OVER PLAIN ws:// WITH VALID BASIC AUTH -> transport encryption NOT enforced');ws.close();r();});
  ws.on('unexpected-response',(_a,b)=>{console.log('HTTP',b.statusCode);r();});
  ws.on('error',(e:any)=>{console.log('ERR',e.message);r();});
  setTimeout(()=>r(),5000);
}).then(()=>process.exit(0));
