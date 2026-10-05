import { config } from '../config.js';
import { TokenBuckets, type Decision } from '../services/ratelimit.js';

/**
 * The driver API (`/d/`) behind carrier-grade NAT: thousands of phones share one public address, so the per-address
 * limit of the API (600 a minute) would refuse a whole mobile network at once. For `/d/` the address limit is a much
 * higher abuse cap (`DRIVER_IP_RATE_LIMIT_PER_MIN`, 6000), and each device token gets its own token bucket
 * (`DRIVER_DEVICE_RATE_LIMIT_PER_MIN`, 600 — ten a second, far above what the app sends while charging).
 */
export const deviceBuckets = new TokenBuckets();

/** The per-address limit for a request path. */
export function ipLimitFor(path: string): number {
  return path.startsWith('/d/') ? config.driverApp.ipRateLimitPerMin : config.api.rateLimitPerMin;
}

/** One request by this device. */
export function takeDevice(deviceId: string, limitPerMin = config.driverApp.deviceRateLimitPerMin, now = Date.now()): Decision {
  return deviceBuckets.take(`dev:${deviceId}`, limitPerMin, now);
}
