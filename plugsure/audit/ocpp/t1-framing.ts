import { connect, boot, sleep, j } from './lib.js';

/** Test 1: RPC framing / malformed frames. */
const results: string[] = [];
function rec(name: string, outcome: string) {
  results.push(`${name.padEnd(46)} => ${outcome}`);
  console.log(`${name.padEnd(46)} => ${outcome}`);
}

async function main() {
  const c = await connect('AUDIT-FRAME-01');
  await boot(c);
  await sleep(400);

  const before = c.frames.length;
  const probe = async (name: string, raw: string, waitMs = 900) => {
    const mark = c.frames.length;
    c.sendRaw(raw);
    await sleep(waitMs);
    const got = c.frames.slice(mark);
    rec(name, got.length ? j(got) : 'NO RESPONSE (silently dropped)');
    return got;
  };

  await probe('non-array frame', '{"a":1}');
  await probe('array length 1', '[2]');
  await probe('unknown messageTypeId 5', '[5,"u1","Foo",{}]');
  await probe('messageTypeId 9 with payload', '[9,"u2",{}]');
  await probe('non-string uniqueId (number)', '[2,12345,"Heartbeat",{}]');
  await probe('object as uniqueId', '[2,{"x":1},"Heartbeat",{}]');
  await probe('null uniqueId', '[2,null,"Heartbeat",{}]');
  await probe('uniqueId 200 chars', `[2,"${'A'.repeat(200)}","Heartbeat",{}]`);
  await probe('CALL missing payload (len 3)', '[2,"u3","Heartbeat"]');
  await probe('CALL non-string action', '[2,"u4",42,{}]');
  await probe('CALL null action', '[2,"u5",null,{}]');
  await probe('CALL payload is array', '[2,"u6","Heartbeat",[1,2,3]]');
  await probe('CALL payload is string', '[2,"u7","Heartbeat","hello"]');
  await probe('unparseable JSON', '{{{');
  await probe('unknown action', '[2,"u8","NotARealOcppAction",{}]');

  // duplicate uniqueId, two CALLs same id
  const mark = c.frames.length;
  c.sendRaw('[2,"DUP","Heartbeat",{}]');
  c.sendRaw('[2,"DUP","Heartbeat",{}]');
  await sleep(1000);
  rec('duplicate uniqueId x2', j(c.frames.slice(mark)));

  // CALLRESULT for a uniqueId the CSMS never sent
  await probe('unsolicited CALLRESULT', '[3,"never-sent",{}]');
  await probe('unsolicited CALLERROR', '[4,"never-sent","GenericError","x",{}]');

  // huge payload
  const huge = 'x'.repeat(2_000_000);
  const m2 = c.frames.length;
  c.sendRaw(j([2, 'HUGE', 'DataTransfer', { vendorId: 'v', data: huge }]));
  await sleep(2500);
  rec('2MB payload DataTransfer', c.frames.length > m2 ? j(c.frames.slice(m2)).slice(0, 200) : 'NO RESPONSE');

  // pipelined inbound CALLs — is one-outstanding enforced inbound?
  const m3 = c.frames.length;
  for (let i = 0; i < 5; i++) c.sendRaw(j([2, `PIPE${i}`, 'Heartbeat', {}]));
  await sleep(1500);
  rec('5 pipelined inbound CALLs', `${c.frames.slice(m3).length} replies: ${c.frames.slice(m3).map((f) => f[1]).join(',')}`);

  console.log('\nsocket still open?', c.ws.readyState === 1);
  c.close();
  await sleep(300);
  process.exit(0);
}
main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
