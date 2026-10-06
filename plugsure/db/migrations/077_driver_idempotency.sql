-- 077: the driver app after the v1.9.0 review (v1.9.1).
--
--   driver_idempotency          one row per (device, Idempotency-Key) on the driver API's money-creating POSTs
--                               (src/driver/idempotency.ts). The key is CLAIMED (INSERT … ON CONFLICT DO NOTHING) before
--                               the payment is created, so a retry after a client timeout cannot create a second
--                               payment_intent: it gets the stored answer (state 'done'), or 409 while the first is
--                               still running. A 5xx or a thrown error deletes the claim (the client may retry).
--                               Rows older than 24 h are ignored and pruned by the next request.
--   push_subscription.app_id    the iOS / Android app id (bundle id / package) that registered the token: the brand's
--   live_activity.app_id        own, or its `.preview` / `.dev` build (mobile/app.config.ts). APNs is addressed to that
--   live_activity_start_token   topic; before, a development or preview build's token got DeviceTokenNotForTopic on
--     .app_id                   the store bundle id and was deleted as gone. NULL: the brand's id, as before.
--
-- Platform-level like driver_auth_limit (keyed to a device, not a tenant: no org_id, no RLS; see 048). Additive and
-- idempotent. Rollback: db/rollback/077_down.sql.

CREATE TABLE IF NOT EXISTS driver_idempotency (
  device_id      UUID NOT NULL REFERENCES driver_device(id) ON DELETE CASCADE,
  key            TEXT NOT NULL CHECK (key ~ '^[A-Za-z0-9_-]{8,128}$'),
  -- 'POST /d/v1/charge/:id/pay-unpaid': the method and the route PATTERN (the charge id is in request_hash).
  route          TEXT NOT NULL,
  -- sha256 of the canonical JSON of the body and the route parameters.
  request_hash   TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'done')),
  status_code    INT,
  response_body  JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, key)
);
CREATE INDEX IF NOT EXISTS driver_idempotency_created_idx ON driver_idempotency (created_at);

ALTER TABLE push_subscription ADD COLUMN IF NOT EXISTS app_id TEXT;
ALTER TABLE live_activity ADD COLUMN IF NOT EXISTS app_id TEXT;
ALTER TABLE live_activity_start_token ADD COLUMN IF NOT EXISTS app_id TEXT;

-- No blanket GRANT (see 053/055/070/076): exactly what src/driver/idempotency.ts uses.
GRANT SELECT, INSERT, UPDATE, DELETE ON driver_idempotency TO plugsure_app;
