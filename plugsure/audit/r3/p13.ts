import { CP, sleep } from './cp.js';
const L=(s:string)=>console.log(s);
async function main(){
  L('1) one HTTP request that enters an org scope');
  const r = await fetch('http://127.0.0.1:9600/v1/tariffs');
  L('   GET /v1/tariffs -> ' + r.status);
  await sleep(1500);
  L('2) now connect a charge point and boot (pure OCPP path, no org scope)');
  try {
    const cp = await (new CP('AUTEL-AC22-SMB-001')).connect();
    const b = await cp.boot();
    L('   BootNotification -> ' + JSON.stringify(b));
    cp.close();
  } catch(e:any){ L('   BootNotification FAILED: '+e.message); }
  process.exit(0);
}
main();
