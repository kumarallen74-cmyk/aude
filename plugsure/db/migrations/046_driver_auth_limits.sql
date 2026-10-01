-- 046: rate limits for the driver app's unauthenticated sign-in steps.
--
--   driver_auth_limit   one fixed-window counter per key, claimed atomically
--                       (INSERT … ON CONFLICT DO UPDATE … WHERE … RETURNING)
--                       BEFORE the guarded work runs, so a parallel burst cannot
--                       all read "under the limit" and all proceed.
--
-- Keys (see src/driver/identity.ts):
--   otp-phone:<+62…>    codes sent to a number: 1 per minute, N per 24 h
--   otp-ip:<ip>         codes requested from one client address per hour
--   otp-device:<uuid>   codes requested by one app install per hour
--   otp-global          codes sent by the whole installation per 24 h (SMS cost cap)
--   otp-verify:<+62…>   wrong codes entered for a number per 24 h, across codes
--   pin-ip:<ip>         wrong fleet PINs entered from one client address per hour
--
-- Platform-level like driver_otp (no organisation, no RLS). Rows idle for two
-- days are pruned by the sender; no window is longer than 24 h.

CREATE TABLE IF NOT EXISTS driver_auth_limit (
  key           TEXT PRIMARY KEY,
  window_start  TIMESTAMPTZ NOT NULL DEFAULT now(),
  hits          INT NOT NULL DEFAULT 0,
  last_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS driver_auth_limit_last_idx ON driver_auth_limit (last_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
