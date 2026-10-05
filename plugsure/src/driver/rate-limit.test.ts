import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ipLimitFor, takeDevice, takeAnonymous, deviceBuckets } from './rate-limit.js';
import { config } from '../config.js';

/** Carrier NAT: /d/ is limited per device token, with a much higher per-address cap; the operator API is unchanged. */
describe('driver API rate limits', () => {
  test('per-address limit: the abuse cap on /d/, the API limit elsewhere', () => {
    assert.equal(ipLimitFor('/d/v1/map?bbox=1,2,3,4'), config.driverApp.ipRateLimitPerMin);
    assert.equal(ipLimitFor('/v1/sites'), config.api.rateLimitPerMin);
    assert.ok(config.driverApp.ipRateLimitPerMin >= 10 * config.api.rateLimitPerMin);
  });
  test('each device has its own bucket: one busy phone does not limit another behind the same address', () => {
    deviceBuckets.clear();
    const t = 1_000_000;
    for (let i = 0; i < 5; i++) assert.equal(takeDevice('a', 5, t).allowed, true);
    const refused = takeDevice('a', 5, t);
    assert.equal(refused.allowed, false);
    assert.ok(refused.retryAfterS >= 1);
    assert.equal(takeDevice('b', 5, t).allowed, true, 'another device');
    assert.equal(takeDevice('a', 5, t + 12_000).allowed, true, 'refilled after a fifth of a minute');
  });
  test('v1.9.0: requests without a device token (browse, resolver, minting a token) get the ordinary per-address budget, not the NAT cap', () => {
    deviceBuckets.clear();
    const t = 2_000_000;
    assert.ok(config.driverApp.anonIpRateLimitPerMin <= config.api.rateLimitPerMin);
    for (let i = 0; i < 3; i++) assert.equal(takeAnonymous('198.51.100.7', 3, t).allowed, true);
    assert.equal(takeAnonymous('198.51.100.7', 3, t).allowed, false, 'one address: refused past its budget');
    assert.equal(takeAnonymous('198.51.100.8', 3, t).allowed, true, 'another address');
    assert.equal(takeDevice('198.51.100.7', 3, t).allowed, true, 'a device token is counted separately');
  });
});
