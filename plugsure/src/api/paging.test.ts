import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitParam, offsetParam, PagingError } from './paging.js';

test('limit: absent → default; a whole number ≥ 1 → itself; above the maximum → the maximum', () => {
  assert.equal(limitParam(undefined, 50, 500), 50);
  assert.equal(limitParam('', 50, 500), 50);
  assert.equal(limitParam('10', 50, 500), 10);
  assert.equal(limitParam(' 10 ', 50, 500), 10);
  assert.equal(limitParam('1000000000', 50, 500), 500);
  assert.equal(limitParam(undefined, 900, 500), 500, 'the default is capped too');
});

test('limit: anything else is the caller’s mistake (400), never SQL', () => {
  for (const bad of ['abc', '-5', '0', '2.5', '1e9', '10abc', '0x10', 'NaN', 'Infinity', ' ']) {
    assert.throws(() => limitParam(bad, 50, 500), (e: any) => e instanceof PagingError && e.statusCode === 400, bad);
  }
});

test('offset: absent → 0; a whole number ≥ 0; anything else 400', () => {
  assert.equal(offsetParam(undefined), 0);
  assert.equal(offsetParam('0'), 0);
  assert.equal(offsetParam('40'), 40);
  for (const bad of ['-1', 'xyz', '1.5']) assert.throws(() => offsetParam(bad), PagingError, bad);
});
