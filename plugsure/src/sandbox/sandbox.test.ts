import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { socketPair, type MemorySocket } from './memory-socket.js';
import { VirtualChargePoint } from './virtual-charge-point.js';

/**
 * The sandbox's transport and virtual charger, without a gateway: the test
 * plays the CSMS on the other end of the in-memory socket.
 */

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
/**
 * Wait until `cond` holds (or 5 s pass), then let the assertion decide. Fixed sleeps failed
 * when the whole unit suite ran files in parallel and the event loop was slow.
 */
async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await tick(10);
}

/** A minimal CSMS: answers the charger's calls and records them; can call the charger. */
function fakeCsms(server: MemorySocket, answers: Record<string, (p: any) => any> = {}) {
  const calls: Array<{ action: string; payload: any }> = [];
  const pending = new Map<string, (v: any) => void>();
  server.on('message', (raw: Buffer) => {
    const f = JSON.parse(raw.toString());
    if (f[0] === 2) {
      calls.push({ action: f[2], payload: f[3] });
      const a = answers[f[2]];
      const result = a ? a(f[3]) : f[2] === 'BootNotification' ? { status: 'Accepted', interval: 300, currentTime: new Date().toISOString() } : f[2] === 'Authorize' ? { idTagInfo: { status: 'Accepted' } } : f[2] === 'StartTransaction' ? { transactionId: 42, idTagInfo: { status: 'Accepted' } } : {};
      server.send(JSON.stringify([3, f[1], result]));
    } else if (f[0] === 3) {
      pending.get(f[1])?.(f[2]);
    }
  });
  let n = 0;
  const call = (action: string, payload: unknown) => new Promise<any>((res) => {
    const id = `c${++n}`;
    pending.set(id, res);
    server.send(JSON.stringify([2, id, action, payload]));
  });
  return { calls, call, statuses: () => calls.filter((c) => c.action === 'StatusNotification').map((c) => c.payload) };
}

async function booted(answers: Record<string, (p: any) => any> = {}, opts: Record<string, unknown> = {}) {
  const [client, server] = socketPair('ocpp1.6');
  const csms = fakeCsms(server, answers);
  const vcp = new VirtualChargePoint({
    id: 'SBX-TEST-1', connectors: 2, reconnect: false, reservations: true, speed: 600, meterIntervalS: 60,
    transport: async () => client, ...opts,
  });
  await vcp.start();
  await until(() => csms.statuses().length >= Number(opts.connectors ?? 2));
  return { vcp, csms, client, server };
}

describe('sandbox: in-memory socket', () => {
  test('delivers messages asynchronously both ways, answers pings, and closes both ends', async () => {
    const [a, b] = socketPair('ocpp1.6');
    const got: string[] = [];
    b.on('message', (m: Buffer) => got.push(m.toString()));
    a.send('hello');
    assert.deepEqual(got, [], 'not delivered synchronously');
    await until(() => got.length > 0);
    assert.deepEqual(got, ['hello']);
    let pong = false;
    b.on('pong', () => { pong = true; });
    b.ping();
    await until(() => pong);
    assert.ok(pong, 'the peer answers a ping');
    let closedA = false; let closedB = false;
    a.on('close', () => { closedA = true; });
    b.on('close', () => { closedB = true; });
    b.terminate();
    await until(() => closedA && closedB);
    assert.ok(closedA && closedB && a.readyState === 3 && b.readyState === 3);
    a.send('after close');
    await tick();
    assert.deepEqual(got, ['hello']);
  });
});

describe('sandbox: virtual charger', () => {
  test('boots over an injected transport and reports every connector', async () => {
    const { vcp, csms } = await booted();
    assert.equal(csms.calls[0]?.action, 'BootNotification');
    assert.deepEqual(csms.statuses().map((s) => [s.connectorId, s.status]), [[1, 'Available'], [2, 'Available']]);
    assert.equal(vcp.snapshot().online, true);
    await vcp.stop();
  });

  test('ReserveNow holds a connector; a remote start with another card is refused; CancelReservation frees it', async () => {
    const { vcp, csms } = await booted();
    const r = await csms.call('ReserveNow', { connectorId: 1, expiryDate: new Date(Date.now() + 60_000).toISOString(), idTag: 'CARD-A', reservationId: 7 });
    assert.equal(r.status, 'Accepted');
    await until(() => csms.statuses().at(-1)?.status === 'Reserved');
    assert.equal(csms.statuses().at(-1)?.status, 'Reserved');
    assert.equal((await csms.call('ReserveNow', { connectorId: 1, expiryDate: new Date(Date.now() + 60_000).toISOString(), idTag: 'CARD-B', reservationId: 8 })).status, 'Occupied');
    assert.equal((await csms.call('RemoteStartTransaction', { connectorId: 1, idTag: 'CARD-B' })).status, 'Rejected');
    assert.equal((await csms.call('CancelReservation', { reservationId: 7 })).status, 'Accepted');
    await until(() => csms.statuses().at(-1)?.status === 'Available');
    assert.equal(csms.statuses().at(-1)?.status, 'Available');
    assert.deepEqual(vcp.snapshot().reservations, []);
    await vcp.stop();
  });

  test('a fault is reported with its vendor code, blocks remote start, and clears', async () => {
    const { vcp, csms } = await booted();
    await vcp.setFault(2, { errorCode: 'GroundFailure', vendorErrorCode: 'E-GF-12' });
    const f = csms.statuses().at(-1);
    assert.deepEqual([f.connectorId, f.status, f.errorCode, f.vendorErrorCode], [2, 'Faulted', 'GroundFailure', 'E-GF-12']);
    assert.equal((await csms.call('RemoteStartTransaction', { connectorId: 2, idTag: 'X' })).status, 'Rejected');
    await vcp.setFault(2, null);
    assert.equal(csms.statuses().at(-1)?.status, 'Available');
    await vcp.stop();
  });

  test('a card refused at Authorize leaves the charger idle (regression: it stayed "charging")', async () => {
    const { vcp, csms } = await booted({ Authorize: () => ({ idTagInfo: { status: 'Blocked' } }) });
    const r = await vcp.runSession({ connectorId: 1, idTag: 'BLOCKED' });
    assert.equal(r.transactionId, null);
    assert.equal(vcp.charging, false);
    assert.ok(!csms.calls.some((c) => c.action === 'StartTransaction'));
    await vcp.stop();
  });

  test('a session meters energy and stops when told, with the given reason', async () => {
    const { vcp, csms } = await booted();
    const run = vcp.runSession({ connectorId: 1, idTag: 'CARD-A', kwh: 50 });
    await until(() => vcp.charging);
    await tick(400); // let it meter some energy (a minimum: a slow loop only adds time)
    assert.equal(vcp.charging, true);
    assert.ok(vcp.stopSession('EVDisconnected'));
    const done = await run;
    const stop = csms.calls.find((c) => c.action === 'StopTransaction')!.payload;
    assert.equal(stop.reason, 'EVDisconnected');
    assert.equal(stop.transactionId, 42);
    assert.ok(done.deliveredWh > 0 && stop.meterStop > 1_234_000);
    await vcp.stop();
  });
});
