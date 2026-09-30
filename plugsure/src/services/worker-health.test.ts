import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { instrumentWorker, workerStats } from './worker-health.js';

/** Worker pass bookkeeping: durations and overlapping passes (behaviour unchanged: they still run). */
describe('worker health', () => {
  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

  test('an overlapping pass is counted and still runs; a failing pass is contained', async () => {
    const g = gate();
    let calls = 0;
    const run = instrumentWorker('t-overlap', 60_000, async () => { calls++; await g.p; throw new Error('boom'); });
    run(); run();
    const s = workerStats.get('t-overlap')!;
    assert.deepEqual({ calls, inFlight: s.inFlight, overlaps: s.overlaps }, { calls: 2, inFlight: 2, overlaps: 1 });
    g.open(); await new Promise((r) => setImmediate(r));
    assert.equal(s.inFlight, 0, 'the failure is logged, not thrown, and both passes are finished');
    assert.equal(s.runs, 2);
  });

  test('pass duration is recorded', async () => {
    const run = instrumentWorker('t-duration', 60_000, () => new Promise((r) => setTimeout(r, 30)));
    run();
    await new Promise((r) => setTimeout(r, 60));
    const s = workerStats.get('t-duration')!;
    assert.ok(s.lastMs >= 25 && s.maxMs >= s.lastMs, `lastMs ${s.lastMs}`);
  });
});