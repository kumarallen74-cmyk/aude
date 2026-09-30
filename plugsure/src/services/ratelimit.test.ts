import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBuckets, rateLimitHeaders, tooManyFailures, recordFailure, clearFailures } from './ratelimit.js';

test('token bucket: a key may burst its limit, then refills at its limit per minute', () => {
  const b = new TokenBuckets();
  const t0 = 1_000_000;
  for (let i = 0; i < 60; i++) assert.equal(b.take('k', 60, t0).allowed, true, `request ${i + 1}`);
  const refused = b.take('k', 60, t0);
  assert.equal(refused.allowed, false);
  assert.equal(refused.remaining, 0);
  assert.equal(refused.retryAfterS, 1, '60 a minute refills one a second');
  assert.equal(b.take('k', 60, t0 + 999).allowed, false);
  assert.equal(b.take('k', 60, t0 + 1000).allowed, true);
  // A full minute later the whole allowance is back, never more.
  const later = b.take('k', 60, t0 + 10 * 60_000);
  assert.equal(later.remaining, 59);
  // Keys do not share buckets.
  assert.equal(b.take('other', 60, t0).remaining, 59);
});

test('token bucket: a lowered limit applies at once; headers follow the IETF fields', () => {
  const b = new TokenBuckets();
  const t0 = 5_000_000;
  b.take('k', 600, t0);
  const d = b.take('k', 10, t0);
  assert.equal(d.limit, 10);
  assert.equal(d.remaining, 9);
  const h = rateLimitHeaders(d);
  assert.equal(h['RateLimit-Limit'], '10');
  assert.equal(h['RateLimit-Remaining'], '9');
  assert.equal(h['RateLimit-Policy'], '10;w=60');
  assert.equal(h['Retry-After'], undefined);
  for (let i = 0; i < 9; i++) b.take('k', 10, t0);
  const refused = b.take('k', 10, t0);
  assert.equal(rateLimitHeaders(refused)['Retry-After'], '6', '10 a minute refills one every 6 s');
});

test('failed key attempts: an IP is refused after the allowance, for the rest of the minute', () => {
  clearFailures();
  const t0 = 9_000_000;
  for (let i = 0; i < 3; i++) {
    assert.equal(tooManyFailures('10.0.0.1', 3, t0), 0);
    recordFailure('10.0.0.1', t0);
  }
  assert.equal(tooManyFailures('10.0.0.1', 3, t0 + 20_000), 40);
  assert.equal(tooManyFailures('10.0.0.2', 3, t0), 0, 'other addresses are unaffected');
  assert.equal(tooManyFailures('10.0.0.1', 3, t0 + 61_000), 0, 'a new minute starts afresh');
  clearFailures();
});

test('token bucket: a raised limit applies at once, even to a key that was throttled', () => {
  const b = new TokenBuckets();
  const t0 = 1_000_000;
  for (let i = 0; i < 20; i++) b.take('k', 20, t0);
  assert.equal(b.take('k', 20, t0).allowed, false, 'drained at 20 a minute');
  // The operator raises it to 1,200. The very next request, in the same millisecond, goes through.
  const d = b.take('k', 1200, t0);
  assert.equal(d.allowed, true);
  assert.equal(d.limit, 1200);
  assert.ok(d.remaining >= 1100, `the extra allowance is there at once (${d.remaining})`);
  // Never more than the new limit.
  assert.ok(b.take('k', 5000, t0).remaining <= 5000);
});
