-- 037: per-key rate limits and usage for the operator API.
--
--   api_key.rate_limit_per_min  this key's own limit; NULL = the installation
--                               default (API_KEY_RATE_LIMIT_PER_MIN)
--   api_key_usage               requests per key per hour: how many were served,
--                               refused for the rate limit, or answered with an error
--
-- Additive: every existing key keeps the default limit.

ALTER TABLE api_key ADD COLUMN IF NOT EXISTS rate_limit_per_min INT
  CHECK (rate_limit_per_min IS NULL OR rate_limit_per_min BETWEEN 1 AND 100000);

CREATE TABLE IF NOT EXISTS api_key_usage (
  api_key_id  UUID NOT NULL REFERENCES api_key(id) ON DELETE CASCADE,
  org_id      UUID NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
  hour        TIMESTAMPTZ NOT NULL,
  requests    INT NOT NULL DEFAULT 0,
  limited     INT NOT NULL DEFAULT 0,
  errors      INT NOT NULL DEFAULT 0,
  PRIMARY KEY (api_key_id, hour)
);
CREATE INDEX IF NOT EXISTS api_key_usage_org_hour_idx ON api_key_usage (org_id, hour);

ALTER TABLE api_key_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key_usage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_key_usage_tenant ON api_key_usage;
CREATE POLICY api_key_usage_tenant ON api_key_usage
  USING (app_current_org() IS NULL OR org_id = app_current_org())
  WITH CHECK (app_current_org() IS NULL OR org_id = app_current_org());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
