import { connect, boot, sleep, API } from './lib.js';

const p = (s: string, v: any) => console.log(`  ${s.padEnd(56)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);

async function main() {
  console.log('=== one-outstanding-CALL, OUTBOUND direction ===');
  const c = await connect('AUDIT-RPC-01');
  const inflight: string[] = [];
  let peak = 0, cur = 0;
  const held: any[] = [];
  c.onCall = (action, payload, id) => {
    cur++; peak = Math.max(peak, cur);
    inflight.push(action);
    held.push({ id, action });
    // deliberately DO NOT reply yet
    return undefined;
  };
  await boot(c);
  await sleep(1500);
  p('CSMS CALLs in flight at once during provisioning', `${cur} (peak ${peak})`);
  p('  -> outbound one-in-flight enforced?', cur <= 1 ? 'YES' : 'NO');

  console.log('\n=== inbound CALL while the CSMS is awaiting a CALLRESULT ===');
  const hb = await c.call('Heartbeat', {});
  p('charger CALL answered while CSMS awaits its own reply', hb);
  p('  -> so the CSMS does NOT enforce one-in-flight inbound', 'correct per OCPP-J, but README claims "per direction"');

  console.log('\n=== stale / late replies ===');
  // reply to the FIRST held CSMS call now (it may already be past its 30 s timeout later)
  const first = held[0];
  c.ws.send(JSON.stringify([3, first.id, {}]));
  await sleep(500);
  p('replied to the outstanding call', first.action);
  await sleep(800);
  p('did the CSMS advance to the next queued call?', held.length > 1 ? held[held.length - 1].action : 'no further call');

  console.log('\n=== CALLERROR with an ILLEGAL error code from the charger ===');
  const nxt = held[held.length - 1];
  c.ws.send(JSON.stringify([4, nxt.id, 'NotAnOcppErrorCode', 'boom', { any: 'thing' }]));
  await sleep(800);
  p('socket still open after an illegal CALLERROR code?', c.ws.readyState === 1);
  p('  (rpc.ts:168 casts frame[2] to OcppErrorCode with no check)', '');

  console.log('\n=== CALLERROR whose payload fields are wrong types ===');
  const nxt2 = held[held.length - 1];
  c.ws.send(JSON.stringify([4, nxt2.id, 123, { not: 'a string' }, 'not an object']));
  await sleep(600);
  p('socket still open?', c.ws.readyState === 1);

  console.log('\n=== does the CSMS ever emit an invalid CALLERROR code? ===');
  const errFrames = c.frames.filter((f) => Array.isArray(f) && f[0] === 4);
  p('CALLERRORs the CSMS sent us this run', errFrames.map((f) => f[2]));

  console.log('\n=== head-of-line blocking measured ===');
  const c2 = await connect('AUDIT-RPC-02');
  c2.onCall = () => undefined; // never answer
  await boot(c2);
  await sleep(300);
  const t = Date.now();
  const r = await fetch(`${API}/v1/charge-points/AUDIT-RPC-02/commands/remote-stop`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transactionId: 1 }),
    signal: AbortSignal.timeout(35000),
  }).then((x) => `HTTP ${x.status}`).catch((e) => 'aborted: ' + e.message);
  p('RemoteStopTransaction on a mute charger', `${r} after ${Date.now() - t} ms`);
  p('  DESIGN: 1 GetConfiguration + 13 ChangeConfiguration + N TriggerMessage', '');
  p('  + GetLocalListVersion + SendLocalList, each with a 30 s timeout', '');
  p('  => worst-case queue block before an operator command lands', '~8 minutes');

  console.log('\n=== RemoteStop with a missing transactionId ===');
  const c3 = await connect('AUDIT-RPC-03');
  let saw: any = null;
  c3.onCall = (a, pl) => { if (a === 'RemoteStopTransaction') saw = pl; return { status: 'Accepted' }; };
  await boot(c3);
  await sleep(2500);
  await fetch(`${API}/v1/charge-points/AUDIT-RPC-03/commands/remote-stop`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }).catch(() => {});
  await sleep(1500);
  p('payload the CSMS put on the wire for RemoteStopTransaction', saw);

  c.close(); c2.close(); c3.close();
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
