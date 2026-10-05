-- 055: two-step verification (TOTP) for console accounts; driver sign-in codes bound to
--      the device that asked for them.
--
--   app_user.totp_secret          the account's TOTP secret (RFC 6238), SEALED with
--                                 SECRETS_KEY (services/secrets.ts, AAD bound to the user),
--                                 never stored in clear. NULL = two-step verification off.
--   app_user.totp_pending_secret  a secret being enrolled: shown once as a QR code, promoted
--                                 to totp_secret only when the user proves it with a code.
--   app_user.totp_enabled_at      when enrolment was confirmed.
--   app_user.totp_last_step       the last 30-second time step a code was ACCEPTED for. A code
--                                 is accepted only for a later step, so an observed code
--                                 (shoulder-surfed, phished, logged) cannot be replayed.
--   app_user.totp_recovery_hashes sha256 of each unused recovery code (80-bit random codes,
--                                 so a fast hash is enough). A used code is removed from the
--                                 array in the same statement that accepts it: single use.
--   auth_session.mfa_pending      a session created by a correct password for an account with
--                                 two-step verification, not yet completed with a code. The
--                                 API serves it only the code step and sign-out
--                                 (api/server.ts), and it lives five minutes.
--   driver_otp.device_id          the app install that asked for the code. Only that device
--                                 can verify it, and the wrong-code budget is per number AND
--                                 device: a stranger who knows a driver's number can no
--                                 longer lock that number out for a day with ten bad guesses.
--                                 NULL for codes issued before this migration (any device).
--
-- Failed codes count against the SAME per-account lockout as failed passwords
-- (app_user.failed_logins / locked_until, LOGIN_MAX_FAILURES / LOGIN_LOCK_MINUTES).

ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS totp_secret TEXT,
  ADD COLUMN IF NOT EXISTS totp_pending_secret TEXT,
  ADD COLUMN IF NOT EXISTS totp_enabled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS totp_last_step BIGINT,
  ADD COLUMN IF NOT EXISTS totp_recovery_hashes TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE auth_session ADD COLUMN IF NOT EXISTS mfa_pending BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE driver_otp ADD COLUMN IF NOT EXISTS device_id UUID REFERENCES driver_device(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS driver_otp_phone_device_idx ON driver_otp (phone, device_id, created_at DESC);

-- No GRANT here: this migration only adds columns (and an index), which the runtime role's
-- existing table grants already cover. A blanket `GRANT … ON ALL TABLES` would hand
-- UPDATE/DELETE on audit_log back to plugsure_app and undo 048's append-only audit log.
