-- 052: operations hardening — a shared per-key rate limiter, and retention support.
--
--   api_key_rate_bucket   each API key's token bucket, shared by every API process.
--                         The buckets lived in each process's memory, so behind N
--                         API processes a key got N times its limit.
--   api_key_rate_take()   takes one token atomically (row lock), refilling by the
--                         DATABASE clock so every API host agrees on elapsed time.
--
-- Retention (src/services/retention.ts) needs no new index:
--   * connection_attempt already has an index on (ts DESC) from migration 002.
--   * ocpp_frame has none on ts, and deliberately gets none here. A plain
--     CREATE INDEX on the largest table in the database takes a SHARE lock for
--     the whole build, blocking every frame INSERT — the gateway's connections
--     would queue behind it and chargers stall — and CREATE INDEX CONCURRENTLY
--     cannot run inside the migrator's per-file transaction. The retention pass
--     instead walks ocpp_frame from its oldest primary key (ids and ts both
--     increase with insertion), which costs no index and no lock.
--
-- Additive; nothing existing changes.

CREATE TABLE IF NOT EXISTS api_key_rate_bucket (
  api_key_id     UUID PRIMARY KEY REFERENCES api_key(id) ON DELETE CASCADE,
  tokens         DOUBLE PRECISION NOT NULL,
  limit_per_min  INT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
-- For the retention pass that forgets buckets nobody has used for a day.
CREATE INDEX IF NOT EXISTS api_key_rate_bucket_updated_idx ON api_key_rate_bucket (updated_at);

-- The same token bucket as TokenBuckets.take() in src/services/ratelimit.ts: the
-- limit per minute is both the burst and the refill rate; a lowered limit caps the
-- bucket at once, a raised one credits the difference at once.
CREATE OR REPLACE FUNCTION api_key_rate_take(p_key UUID, p_limit INT)
RETURNS TABLE (ok BOOLEAN, remaining_tokens DOUBLE PRECISION)
LANGUAGE plpgsql AS $$
DECLARE
  lim INT := GREATEST(1, p_limit);
  b   api_key_rate_bucket%ROWTYPE;
  t   DOUBLE PRECISION;
  ts  TIMESTAMPTZ;
BEGIN
  INSERT INTO api_key_rate_bucket (api_key_id, tokens, limit_per_min, updated_at)
  VALUES (p_key, lim, lim, clock_timestamp())
  ON CONFLICT (api_key_id) DO NOTHING;
  -- Concurrent requests for one key serialise here, and only here.
  SELECT * INTO b FROM api_key_rate_bucket WHERE api_key_id = p_key FOR UPDATE;
  -- Read the clock AFTER the lock: a waiter must not refill from a moment
  -- earlier than the holder's update.
  ts := clock_timestamp();
  t := b.tokens;
  IF lim > b.limit_per_min THEN t := t + (lim - b.limit_per_min); END IF;
  t := LEAST(lim, t + GREATEST(0, EXTRACT(EPOCH FROM (ts - b.updated_at))) * lim / 60.0);
  ok := t >= 1;
  IF ok THEN t := t - 1; END IF;
  UPDATE api_key_rate_bucket SET tokens = t, limit_per_min = lim, updated_at = ts WHERE api_key_id = p_key;
  remaining_tokens := t;
  RETURN NEXT;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON api_key_rate_bucket TO plugsure_app;
GRANT EXECUTE ON FUNCTION api_key_rate_take(UUID, INT) TO plugsure_app;
