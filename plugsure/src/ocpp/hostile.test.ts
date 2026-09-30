import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { OcppRpcConnection } from './rpc.js';

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

function harness(handler: (action: string, payload: any) => any) {
  const ws = new FakeSocket();
  const seen: any[] = [];
  const deviations: string[] = [];
  const conn = new OcppRpcConnection(
    'TEST-CP',
    ws as unknown as WebSocket,
    async (action, payload) => {
      seen.push(payload);
      return handler(action, payload);
    },
    {
      callTimeoutMs: 1_000,
      deviationSink: (action, ds) => deviations.push(...ds.map((d) => `${action}${d.message}`)),
    },
  );
  const inbound = async (frame: unknown[]) => {
    ws.emit('message', Buffer.from(JSON.stringify(frame)));
    await new Promise((r) => setTimeout(r, 5));
  };
  return { ws, conn, seen, deviations, inbound };
}

const NUL = String.fromCharCode(0);
const BOOT_OK = { currentTime: '2026-08-23T00:00:00Z', interval: 300, status: 'Accepted' };

/**
 * A single NUL byte anywhere in an inbound string permanently bricked that
 * charger's BootNotification. Postgres rejects 0x00 in text, so the handler
 * threw and the charger received a DETERMINISTIC InternalError on every retry
 * until it gave up. Deterministic is what makes it fatal: a transient error is
 * survivable, a permanent one strands the unit.
 *
 * The frame-logging path already stripped NULs on the way to the database, and
 * that half worked — so the evidence was recorded while the session was not,
 * which is the most confusing possible failure to debug on site.
 */
describe('control characters in inbound payloads', () => {
  test('a NUL byte no longer bricks the charger', async () => {
    const h = harness(() => BOOT_OK);
    await h.inbound([2, 'n1', 'BootNotification', { chargePointVendor: `A${NUL}B`, chargePointModel: 'M' }]);

    const reply = h.ws.sent[0] as any[];
    assert.equal(reply[0], 3, 'the frame must be answered, not refused');
    assert.equal(h.seen[0].chargePointVendor, 'AB', 'stripped before the handler sees it');
  });

  test('the deviation is recorded for the vendor, not silently swallowed', async () => {
    const h = harness(() => BOOT_OK);
    await h.inbound([2, 'n2', 'BootNotification', { chargePointVendor: `A${NUL}B`, chargePointModel: 'M' }]);
    assert.ok(
      h.deviations.some((d) => d.includes('control characters removed')),
      `expected a recorded deviation, got ${JSON.stringify(h.deviations)}`,
    );
  });

  test('control characters nested in arrays are stripped too', async () => {
    const h = harness(() => ({}));
    await h.inbound([
      2, 'n3', 'MeterValues',
      {
        connectorId: 1,
        meterValue: [
          {
            timestamp: '2026-08-23T00:00:00Z',
            sampledValue: [{ value: `10${NUL}00`, unit: 'Wh', measurand: 'Energy.Active.Import.Register' }],
          },
        ],
      },
    ]);
    assert.equal(h.seen[0].meterValue[0].sampledValue[0].value, '1000');
  });

  test('newlines and tabs survive — vendor diagnostic strings use them', async () => {
    const h = harness(() => BOOT_OK);
    await h.inbound([2, 'n4', 'BootNotification', { chargePointVendor: 'A\nB\tC', chargePointModel: 'M' }]);
    assert.equal(h.seen[0].chargePointVendor, 'A\nB\tC');
  });

  test('a clean payload is passed through untouched and records nothing', async () => {
    const h = harness(() => BOOT_OK);
    await h.inbound([2, 'n5', 'BootNotification', { chargePointVendor: 'Autel', chargePointModel: 'M' }]);
    assert.equal(h.seen[0].chargePointVendor, 'Autel');
    assert.deepEqual(h.deviations, []);
  });
});

/**
 * StopTransaction without meterStop. The spec requires the field, but rejecting
 * the frame left the session `active` forever — holding the
 * one-active-session-per-connector index and never being billed — because the
 * charger retried, got the identical deterministic error, and gave up. The
 * running-total fallback for exactly this case was already written and was
 * unreachable, because validation refused the frame before the handler ran.
 */
describe('StopTransaction without meterStop', () => {
  test('is tolerated so the session can close and bill from the running total', async () => {
    const h = harness(() => ({ idTagInfo: { status: 'Accepted' } }));
    await h.inbound([
      2, 's1', 'StopTransaction',
      { transactionId: 1000, timestamp: '2026-08-23T00:00:00Z', idTag: 'ID-RFID-0001' },
    ]);
    const reply = h.ws.sent[0] as any[];
    assert.equal(reply[0], 3, `expected a CALLRESULT, got ${JSON.stringify(reply)}`);
    assert.equal(h.seen.length, 1, 'the handler must run so the session can be closed');
  });

  test('and the deviation is recorded', async () => {
    const h = harness(() => ({ idTagInfo: { status: 'Accepted' } }));
    await h.inbound([
      2, 's2', 'StopTransaction',
      { transactionId: 1000, timestamp: '2026-08-23T00:00:00Z', idTag: 'ID-RFID-0001' },
    ]);
    assert.ok(h.deviations.some((d) => d.includes('meterStop')), JSON.stringify(h.deviations));
  });

  test('a genuinely malformed StopTransaction is still refused', async () => {
    const h = harness(() => ({ idTagInfo: { status: 'Accepted' } }));
    await h.inbound([2, 's3', 'StopTransaction', { transactionId: 'not-a-number', timestamp: 'nope' }]);
    assert.equal((h.ws.sent[0] as any[])[0], 4);
  });
});

/**
 * Ajv reported only errors[0], so `tolerated` could hold at most one entry: a
 * BootNotification with an over-length vendor AND an over-length model recorded
 * the vendor and silently dropped the model — the exact deviation the quirk
 * registry exists to capture.
 */
describe('multiple tolerated deviations in one payload', () => {
  test('all of them are recorded, not just the first', async () => {
    const h = harness(() => BOOT_OK);
    await h.inbound([
      2, 'm1', 'BootNotification',
      {
        chargePointVendor: 'A-Very-Long-Vendor-Name-Indeed',
        chargePointModel: 'A-Very-Long-Model-Name-Indeed',
      },
    ]);
    assert.equal((h.ws.sent[0] as any[])[0], 3, 'still accepted');
    assert.ok(h.deviations.some((d) => d.includes('chargePointVendor')), JSON.stringify(h.deviations));
    assert.ok(h.deviations.some((d) => d.includes('chargePointModel')), JSON.stringify(h.deviations));
  });

  test('a fatal error alongside tolerable ones still rejects the frame', async () => {
    const h = harness(() => BOOT_OK);
    await h.inbound([
      2, 'm2', 'BootNotification',
      { chargePointVendor: 'A-Very-Long-Vendor-Name-Indeed' }, // chargePointModel missing
    ]);
    assert.equal((h.ws.sent[0] as any[])[0], 4, 'a missing required field is not tolerable');
  });
});
