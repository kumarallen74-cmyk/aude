-- 053: console account hardening.
--
--   app_user.temp_password_expires_at
--                              when the administrator-issued one-time password (invitation,
--                              reset, create-admin without --password) stops working. Set by
--                              the application from TEMP_PASSWORD_TTL_HOURS (default 72); a
--                              sign-in with an expired one gets the same generic refusal as a
--                              wrong password. NULL whenever must_change_password is false.
--   auth_session.last_seen_at  last use of a console session, refreshed at most once a minute;
--                              a session idle longer than SESSION_IDLE_MINUTES (default 60) is
--                              refused even inside its 12-hour lifetime.
--   app_user_email_lower_key   e-mail addresses are unique case-insensitively. The original
--                              UNIQUE(email) let "Ops@x" and "ops@x" coexist; sign-in already
--                              matches on lower(email), so the two would fight over one login.

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS temp_password_expires_at TIMESTAMPTZ;

-- One-time passwords already handed out start their clock now rather than never expiring.
UPDATE app_user SET temp_password_expires_at = now() + interval '72 hours'
 WHERE must_change_password AND temp_password_expires_at IS NULL;

/*
 * Safety net for writers that do not set the expiry themselves (db/seed.ts in production
 * without SEED_ADMIN_PASSWORD, ad-hoc SQL): a one-time password always gets one, using the
 * default TTL. The application's own paths (services/users.ts, create-admin) set it from
 * TEMP_PASSWORD_TTL_HOURS and are left alone. A new password hash written under
 * must_change_password with an unchanged (stale) expiry gets a fresh one, so re-issuing a
 * one-time password never hands out one that is already expired. Clearing the flag clears
 * the expiry.
 */
CREATE OR REPLACE FUNCTION app_user_temp_password_expiry() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.must_change_password THEN
    NEW.temp_password_expires_at := NULL;
  ELSIF NEW.temp_password_expires_at IS NULL
     OR (TG_OP = 'UPDATE'
         AND NEW.password_hash IS DISTINCT FROM OLD.password_hash
         AND NEW.temp_password_expires_at IS NOT DISTINCT FROM OLD.temp_password_expires_at) THEN
    NEW.temp_password_expires_at := now() + interval '72 hours';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS app_user_temp_password_expiry ON app_user;
CREATE TRIGGER app_user_temp_password_expiry
  BEFORE INSERT OR UPDATE OF must_change_password, password_hash, temp_password_expires_at ON app_user
  FOR EACH ROW EXECUTE FUNCTION app_user_temp_password_expiry();

ALTER TABLE auth_session ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Case-insensitive uniqueness. Existing case-variant duplicates cannot be merged here (they
-- may belong to different organisations), so the migration must not fail on them: it leaves
-- the case-sensitive constraint in place, raises a NOTICE naming the count, and the index can
-- be created by hand once an operator has resolved them.
DO $$
DECLARE
  dupes integer;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT lower(email) FROM app_user WHERE email IS NOT NULL GROUP BY lower(email) HAVING count(*) > 1
  ) d;
  IF dupes = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS app_user_email_lower_key ON app_user (lower(email));
  ELSE
    RAISE NOTICE '053: % e-mail address(es) exist in app_user in more than one letter case; '
                 'app_user_email_lower_key NOT created. Resolve them (SELECT lower(email), array_agg(id) '
                 'FROM app_user GROUP BY 1 HAVING count(*) > 1), then: CREATE UNIQUE INDEX '
                 'app_user_email_lower_key ON app_user (lower(email));', dupes;
  END IF;
END;
$$;

-- No GRANT here: this migration only adds columns, which the runtime role's existing table grants
-- already cover. A blanket `GRANT … ON ALL TABLES` would hand UPDATE/DELETE on audit_log back to
-- plugsure_app and undo 048's append-only audit log.
