import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorRateBreached } from './alerts.js';

test('hub.forward_error_rate: needs the minimum number of legs before a rate counts', () => {
  assert.equal(errorRateBreached({ out_15m: 5, errors_15m: 5 }, 25, 20), false);
  assert.equal(errorRateBreached({ out_15m: 0, errors_15m: 0 }, 25, 0), false);
});

test('hub.forward_error_rate: at or above the threshold raises, below does not', () => {
  assert.equal(errorRateBreached({ out_15m: 20, errors_15m: 5 }, 25, 20), true);
  assert.equal(errorRateBreached({ out_15m: 20, errors_15m: 4 }, 25, 20), false);
  assert.equal(errorRateBreached({ out_15m: 400, errors_15m: 399 }, 100, 20), false);
  assert.equal(errorRateBreached({ out_15m: 400, errors_15m: 400 }, 100, 20), true);
});
