import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { OcppRpcConnection, OcppCallError } from './rpc.js';

/**
 * A WebSocket stand-in: records what the CSMS puts on the wire and lets a test
 * push charger frames in.
 */
class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: unknown[][] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  terminate() {
    this.readyState = 3;
  }
}

function harness(handler: (action: string, payload: any) => Promise<any> | any) {
  const ws = new FakeSocket();
  const calls: Array<{ action: string; payload: any }> = [];
  const conn = new OcppRpcConnection(
    'TEST-CP',
    ws as unknown as WebSocket,
    async (action, payload) => {
      calls.push({ action, payload: payload as any });
      return handler(action, payload);
    },
    { callTimeoutMs: 1_000 },
  );
  const inbound = async (frame: unknown[]) => {
    ws.emit('message', Buffer.from(JSON.stringify(frame)));
    // let the handler's microtasks settle
    await new Promise((r) => setTimeout(r, 5));
  };
  return { ws, conn, calls, inbound };
}

const BOOT = { chargePointVendor: 'Autel', chargePointModel: 'MaxiCharger DC' };

/**
 * The reply cache was added to stop a reconnecting charger's retry from
 * double-executing a handler. As shipped it keyed on the MessageId ALONE.
 *
 * OCPP 1.6 only requires a MessageId to be unique among a charger's OUTSTANDING
 * calls. Real firmware uses a short counter that restarts at 0 or 1 on reboot,
 * so "1" is a StartTransaction now and something else a minute later. Two
 * consequences, both money-losing:
 *   - a later request is answered with an earlier request's reply, and
 *   - the later request never reaches the handler at all.
 */
describe('inbound replay cache', () => {
  test('a true retry replays the same reply without re-running the handler', async () => {
    let n = 0;
    const h = harness(() => ({ currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' }));
    await h.inbound([2, '1', 'BootNotification', BOOT]);
    n = h.calls.length;
    assert.equal(n, 1);

    await h.inbound([2, '1', 'BootNotification', BOOT]);
    assert.equal(h.calls.length, 1, 'the handler must not run twice for a genuine retry');
    assert.equal(h.ws.sent.length, 2, 'but the charger must still get an answer');
    assert.deepEqual(h.ws.sent[1], h.ws.sent[0]);
  });

  test('a reused MessageId carrying a DIFFERENT action is handled as new', async () => {
    const h = harness((action) =>
      action === 'Heartbeat'
        ? { currentTime: '2026-08-23T00:00:00Z' }
        : { currentTime: '2026-08-23T00:00:00Z', interval: 300, status: 'Accepted' },
    );
    await h.inbound([2, '1', 'BootNotification', BOOT]);
    await h.inbound([2, '1', 'Heartbeat', {}]);

    assert.equal(h.calls.length, 2, 'the Heartbeat must reach the handler');
    assert.equal(h.calls[1]!.action, 'Heartbeat');
    const reply = h.ws.sent[1] as any[];
    assert.equal(reply[0], 3);
    assert.deepEqual(Object.keys(reply[2]), ['currentTime'], 'a Heartbeat must not be answered with a boot result');
  });

  test('a reused MessageId with the same action but a different payload is handled as new', async () => {
    // Two distinct transactions, both sent as MessageId "1" after a reboot.
    // Under the old cache the second START was swallowed and the driver got the
    // first transaction's id -- the session was stranded and never billed.
    const h = harness((_a, p: any) => ({
      transactionId: p.meterStart === 0 ? 101 : 102,
      idTagInfo: { status: 'Accepted' },
    }));
    const start = (meterStart: number) => [
      2, '1', 'StartTransaction',
      { connectorId: 1, idTag: 'ID-RFID-0001', meterStart, timestamp: '2026-08-23T00:00:00Z' },
    ];
    await h.inbound(start(0));
    await h.inbound(start(45_000));

    assert.equal(h.calls.length, 2, 'the second StartTransaction must reach the handler');
    assert.equal((h.ws.sent[0] as any[])[2].transactionId, 101);
    assert.equal((h.ws.sent[1] as any[])[2].transactionId, 102);
  });

  test('a CALLERROR is never cached, so a transient failure stays retryable', async () => {
    let attempt = 0;
    const h = harness(() => {
      attempt++;
      if (attempt === 1) throw new OcppCallError('InternalError', 'database unavailable');
      return { currentTime: '2026-08-23T00:00:00Z' };
    });
    await h.inbound([2, '7', 'Heartbeat', {}]);
    assert.equal((h.ws.sent[0] as any[])[0], 4, 'first attempt fails');

    await h.inbound([2, '7', 'Heartbeat', {}]);
    assert.equal(attempt, 2, 'the retry must actually re-run the handler');
    assert.equal((h.ws.sent[1] as any[])[0], 3, 'and must be able to succeed');
  });

  test('key order in the payload does not defeat replay detection', async () => {
    const h = harness(() => ({ currentTime: '2026-08-23T00:00:00Z', interval: 300, status: 'Accepted' }));
    await h.inbound([2, '3', 'BootNotification', { chargePointVendor: 'Autel', chargePointModel: 'M' }]);
    await h.inbound([2, '3', 'BootNotification', { chargePointModel: 'M', chargePointVendor: 'Autel' }]);
    assert.equal(h.calls.length, 1, 'the same request with reordered keys is still the same request');
  });
});

/**
 * Inbound requests used to be started back to back and left to run
 * concurrently. A StartTransaction and its StopTransaction replayed from an
 * offline queue raced each other, and a duplicate StartTransaction arriving
 * right behind the original ran a second time (the reply cache is only filled
 * when a handler finishes), opening one session and closing it as superseded.
 */
describe('inbound ordering', () => {
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('requests are handled one at a time, in arrival order', async () => {
    const log: string[] = [];
    const h = harness(async (action) => {
      log.push(`start ${action}`);
      await tick(action === 'StartTransaction' ? 30 : 1);
      log.push(`end ${action}`);
      return action === 'StartTransaction' ? { transactionId: 1, idTagInfo: { status: 'Accepted' } } : {};
    });
    h.ws.emit('message', Buffer.from(JSON.stringify([2, 'a', 'StartTransaction', { connectorId: 1, idTag: 'T', meterStart: 0, timestamp: '2026-09-30T00:00:00Z' }])));
    h.ws.emit('message', Buffer.from(JSON.stringify([2, 'b', 'StopTransaction', { transactionId: 1, meterStop: 10, timestamp: '2026-09-30T00:10:00Z' }])));
    await tick(80);
    assert.deepEqual(log, ['start StartTransaction', 'end StartTransaction', 'start StopTransaction', 'end StopTransaction']);
    assert.deepEqual(h.ws.sent.map((f) => f[1]), ['a', 'b'], 'answers go out in order');
  });

  test('a duplicate arriving before the original finishes gets the cached reply, not a second execution', async () => {
    const h = harness(async () => {
      await tick(20);
      return { transactionId: 7, idTagInfo: { status: 'Accepted' } };
    });
    const start = [2, 'dup', 'StartTransaction', { connectorId: 1, idTag: 'T', meterStart: 0, timestamp: '2026-09-30T00:00:00Z' }];
    h.ws.emit('message', Buffer.from(JSON.stringify(start)));
    h.ws.emit('message', Buffer.from(JSON.stringify(start)));
    await tick(80);
    assert.equal(h.calls.length, 1, 'the handler ran once');
    assert.equal(h.ws.sent.length, 2, 'both copies were answered');
    assert.deepEqual(h.ws.sent[1], h.ws.sent[0]);
  });

  test("an answer to our call is not queued behind the request whose handler waits for it", async () => {
    let conn!: OcppRpcConnection;
    const ws = new FakeSocket();
    conn = new OcppRpcConnection(
      'TEST-CP',
      ws as unknown as WebSocket,
      async () => {
        const r = await conn.call<{ status: string }>('GetConfiguration', {});
        return { status: r.status };
      },
      { callTimeoutMs: 1_000 },
    );
    ws.emit('message', Buffer.from(JSON.stringify([2, 'x', 'DataTransfer', { vendorId: 'v' }])));
    await tick(5);
    const out = ws.sent.find((f) => f[0] === 2)!;
    ws.emit('message', Buffer.from(JSON.stringify([3, out[1], { status: 'Accepted' }])));
    await tick(20);
    assert.deepEqual(ws.sent.find((f) => f[0] === 3 && f[1] === 'x')?.[2], { status: 'Accepted' });
  });
});
