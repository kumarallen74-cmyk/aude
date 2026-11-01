-- Rollback of 109_solar_battery_health_reports_saml.sql (v1.42.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/109_down.sql
-- Roll the CODE back first. Solar and battery assets, settings and readings, charger health history, saved reports and
-- the SAML configuration are dropped: export what you need first. Console users created by SAML stay (password sign-in
-- or Microsoft as before; they have no password until an administrator resets it).
-- SAML sessions end (their users sign in again with a password or Microsoft).
UPDATE auth_session SET revoked_at = COALESCE(revoked_at, now()), auth_method = 'password' WHERE auth_method = 'saml';
ALTER TABLE auth_session DROP CONSTRAINT IF EXISTS auth_session_auth_method_check;
ALTER TABLE auth_session ADD CONSTRAINT auth_session_auth_method_check CHECK (auth_method IN ('password', 'microsoft'));
DROP TABLE IF EXISTS saml_user_link;
DROP TABLE IF EXISTS saml_login_tx;
DROP TABLE IF EXISTS org_saml_provider;
DROP TABLE IF EXISTS report_definition;
DROP TABLE IF EXISTS charger_health;
DROP TABLE IF EXISTS site_energy_reading;
DROP TABLE IF EXISTS site_energy_settings;
DROP TABLE IF EXISTS site_energy_asset;
DELETE FROM schema_migration WHERE name = '109_solar_battery_health_reports_saml.sql';
