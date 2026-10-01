import { query, pool } from '../db/pool.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

/**
 * Rate limits for the operator API.
 *
 *   per API key   a token bucket: the key's limit per minute is both the burst
 *                 it may send at once and the rate it refills at. A key that
 *                 sends steadily below its limit is never refused; one that
 *                 bursts gets its limit at once, then its limit per minute.
 *   per IP        the fixed window in server.ts, for the console and callers
 *                 without a key. Key requests are exempt, until an address has
 *                 sent more keys that do not authenticate than its small
 *                 allowance a minute (guessing): its failed attempts are then
 *                 answered 429, and its key requests count against its IP window
 *                 (valid keys keep working within it).
 *
 * With API_RATE_LIMIT_SHARED (the default outside development and test) each
 * key's bucket lives in Postgres (api_key_rate_bucket, migration 052), so a key
 * gets its limit across ALL API processes; before, each process kept its own
 * buckets and a key behind N processes got N times its limit. If the database
 * cannot answer (error, or slower than SHARED_TIMEOUT_MS) the request is limited
 * by this process's in-memory bucket instead — fail open towards availability,
 * with a warning — and the in-memory path is the only one when sharing is off.
 *
 * Every request made with a key is counted per hour (served, refused for the
 * limit, answered with an error) and written to api_key_usage once a minute.
 */

export interface Decision {
  allowed: boolean;
  /** The key's limit per minute. */
  limit: number;
  /** Requests it may still send at once. */
  remaining: number;
  /** Seconds until the bucket is full again. */
  resetS: number;
  /** When refused: seconds until one more request is allowed. */
  retryAfterS: number;
}

interface Bucket { tokens: number; at: number; limit: number }

export class TokenBuckets {
  private buckets = new Map<string, Bucket>();

  take(key: string, limitPerMin: number, now = Date.now()): Decision {
    const limit = Math.max(1, Math.floor(limitPerMin));
    const rate = limit / 60_000; // tokens per ms
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: limit, at: now, limit };
      this.buckets.set(key, b);
    } else {
      // A lowered limit takes effect at once (the cap below). A RAISED one does too: the extra
      // allowance is credited now. It used to refill towards the new limit, so a key an operator
      // raised because it was throttled stayed refused until its empty bucket refilled (50 ms at
      // 1,200 a minute, a second at 60), and whether its next request passed was a race.
      if (limit > b.limit) b.tokens += limit - b.limit;
      b.tokens = Math.min(limit, b.tokens + (now - b.at) * rate);
      b.at = now;
      b.limit = limit;
    }
    const allowed = b.tokens >= 1;
    if (allowed) b.tokens -= 1;
    const resetS = Math.ceil((limit - b.tokens) / rate / 1000);
    const retryAfterS = allowed ? 0 : Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000));
    if (this.buckets.size > 50_000) this.prune(now);
    return { allowed, limit, remaining: Math.max(0, Math.floor(b.tokens)), resetS, retryAfterS };
  }

  /** Forget buckets that have been full for a while (nobody is using them). */
  prune(now = Date.now()) {
    for (const [k, b] of this.buckets) if (now - b.at > 10 * 60_000) this.buckets.delete(k);
  }

  clear() { this.buckets.clear(); }
}

export const keyBuckets = new TokenBuckets();

/** A bucket state as the token-bucket arithmetic sees it, turned into a Decision. */
export function decisionFrom(limitPerMin: number, allowed: boolean, tokensLeft: number): Decision {
  const limit = Math.max(1, Math.floor(limitPerMin));
  const rate = limit / 60_000;
  const tokens = Math.max(0, Math.min(limit, tokensLeft));
  return {
    allowed,
    limit,
    remaining: Math.floor(tokens),
    resetS: Math.ceil((limit - tokens) / rate / 1000),
    retryAfterS: allowed ? 0 : Math.max(1, Math.ceil((1 - tokens) / rate / 1000)),
  };
}

const SHARED_TIMEOUT_MS = 1_000;
let lastSharedWarnAt = 0;

/**
 * Take one request from an API key's allowance: the shared (Postgres) bucket when
 * API_RATE_LIMIT_SHARED is on, else — or when the database fails — this process's.
 */
export async function takeKeyToken(keyId: string, limitPerMin: number, shared = config.api.keyRateLimitShared): Promise<Decision> {
  if (!shared) return keyBuckets.take(keyId, limitPerMin);
  const limit = Math.max(1, Math.floor(limitPerMin));
  let timer: NodeJS.Timeout | undefined;
  try {
    // The plain pool, never a request-scoped transaction: a bucket update must not
    // be rolled back with a refused request, nor hold a row lock until it commits.
    const r = await Promise.race([
      pool.query<{ ok: boolean; remaining_tokens: number }>(`SELECT ok, remaining_tokens FROM api_key_rate_take($1, $2)`, [keyId, limit]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${SHARED_TIMEOUT_MS} ms`)), SHARED_TIMEOUT_MS); }),
    ]);
    const row = r.rows[0];
    if (!row) throw new Error('api_key_rate_take returned no row');
    return decisionFrom(limit, row.ok, Number(row.remaining_tokens));
  } catch (e) {
    if (Date.now() - lastSharedWarnAt > 60_000) {
      lastSharedWarnAt = Date.now();
      logger.warn({ err: (e as Error).message }, 'shared API key rate limit unavailable; limiting per process until it answers');
    }
    return keyBuckets.take(keyId, limit);
  } finally {
    clearTimeout(timer);
  }
}

/** The standard response headers (IETF RateLimit header fields). */
export function rateLimitHeaders(d: Decision): Record<string, string> {
  return {
    'RateLimit-Limit': String(d.limit),
    'RateLimit-Remaining': String(d.remaining),
    'RateLimit-Reset': String(d.resetS),
    'RateLimit-Policy': `${d.limit};w=60`,
    ...(d.allowed ? {} : { 'Retry-After': String(d.retryAfterS) }),
  };
}

// ─────────────────────────────────────────────── failed key attempts per IP

const failures = new Map<string, { n: number; resetAt: number }>();

/** Has this IP sent too many requests with keys that did not authenticate? */
export function tooManyFailures(ip: string, limitPerMin: number, now = Date.now()): number {
  const s = failures.get(ip);
  if (!s || s.resetAt < now) return 0;
  return s.n >= limitPerMin ? Math.ceil((s.resetAt - now) / 1000) : 0;
}

export function recordFailure(ip: string, now = Date.now()) {
  const s = failures.get(ip);
  if (!s || s.resetAt < now) failures.set(ip, { n: 1, resetAt: now + 60_000 });
  else s.n++;
  if (failures.size > 10_000) for (const [k, v] of failures) if (v.resetAt < now) failures.delete(k);
}

export function clearFailures() { failures.clear(); }

// ─────────────────────────────────────────────── usage per key per hour

interface Count { orgId: string; hour: string; requests: number; limited: number; errors: number }
const pending = new Map<string, Count>();

const hourOf = (now: number) => new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString();

export function recordUsage(keyId: string, orgId: string, status: number, now = Date.now()) {
  const hour = hourOf(now);
  const k = `${keyId}|${hour}`;
  const c = pending.get(k) ?? { orgId, hour, requests: 0, limited: 0, errors: 0 };
  c.requests++;
  if (status === 429) c.limited++;
  else if (status >= 400) c.errors++;
  pending.set(k, c);
}

/** Write the counts gathered so far. Safe to call at any time; counts are added, never replaced. */
export async function flushUsage(): Promise<number> {
  if (pending.size === 0) return 0;
  const batch = [...pending.entries()];
  pending.clear();
  let written = 0;
  for (const [k, c] of batch) {
    const keyId = k.split('|')[0]!;
    try {
      await query(
        `INSERT INTO api_key_usage (api_key_id, org_id, hour, requests, limited, errors)
         SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS (SELECT 1 FROM api_key WHERE id = $1)
         ON CONFLICT (api_key_id, hour) DO UPDATE
           SET requests = api_key_usage.requests + EXCLUDED.requests,
               limited = api_key_usage.limited + EXCLUDED.limited,
               errors = api_key_usage.errors + EXCLUDED.errors`,
        [keyId, c.orgId, c.hour, c.requests, c.limited, c.errors],
      );
      written++;
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'could not record API key usage');
    }
  }
  return written;
}

let timer: NodeJS.Timeout | null = null;
export function startUsageFlush(everyMs = 60_000) {
  if (timer) return;
  timer = setInterval(() => void flushUsage(), everyMs);
  timer.unref();
}
export function stopUsageFlush() {
  if (timer) clearInterval(timer);
  timer = null;
}
