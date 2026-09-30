import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageBudget } from './throttle.js';

test('a burst goes straight through: a charger back from an outage uploads its queue at once', () => {
  const b = new MessageBudget(20, 200, 0);
  const pauses = Array.from({ length: 199 }, () => b.take(0));
  assert.ok(pauses.every((p) => p === 0));
  assert.equal(b.throttled, 0);
});

test('past the burst, reading pauses until a message is affordable again, at the configured rate', () => {
  const b = new MessageBudget(20, 200, 0);
  for (let i = 0; i < 199; i++) b.take(0);
  const p = b.take(0); // the 200th empties the bucket
  assert.ok(p > 0 && p <= 50, `paused ${p} ms (1 message per 50 ms at 20/s)`);
  assert.equal(b.throttled, 1);
  // Sustained: 20 per second get through without pausing again once the rate is respected.
  let t = 1000; let paused = 0;
  for (let i = 0; i < 20; i++) { t += 50; if (b.take(t) > 0) paused++; }
  assert.equal(paused, 0, 'a charger at the allowed rate is never slowed');
});

test('normal traffic is never slowed: heartbeats, meter values and a status change a second', () => {
  const b = new MessageBudget(20, 200, 0);
  let t = 0; let paused = 0;
  for (let i = 0; i < 3600; i++) { t += 1000; if (b.take(t) > 0) paused++; }
  assert.equal(paused, 0);
});

test('a flood is held to the rate: 2,000 frames at once cost about 90 s, not the database', () => {
  const b = new MessageBudget(20, 200, 0);
  let t = 0;
  for (let i = 0; i < 2000; i++) t += b.take(t);
  assert.ok(t >= 89_000 && t <= 91_000, `took ${t} ms`);
});

test('0 disables it', () => {
  const b = new MessageBudget(0, 200, 0);
  assert.ok(Array.from({ length: 5000 }, () => b.take(0)).every((p) => p === 0));
});
