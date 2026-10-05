-- Rollback of 075_mobile_app.sql (the PlugSure Hub mobile app backend).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/075_down.sql
-- Roll the CODE back first (1.8.x does not know these columns). Android subscriptions, Android and partner-network live
-- sessions and the network brand's FCM key are dropped; deleted accounts stay anonymised (that cannot be undone, and
-- must not be: the driver asked for it).
DELETE FROM push_subscription WHERE kind = 'fcm';
DELETE FROM live_activity WHERE transport = 'fcm' OR roaming_charge_id IS NOT NULL;
ALTER TABLE push_subscription DROP CONSTRAINT IF EXISTS push_subscription_kind_fields;
ALTER TABLE push_subscription ADD CONSTRAINT push_subscription_kind_fields CHECK (
  (kind = 'webpush' AND p256dh IS NOT NULL AND auth IS NOT NULL) OR (kind = 'apns' AND brand_org_id IS NOT NULL));
ALTER TABLE push_subscription DROP CONSTRAINT IF EXISTS push_subscription_kind_check;
ALTER TABLE push_subscription ADD CONSTRAINT push_subscription_kind_check CHECK (kind IN ('webpush', 'apns'));
ALTER TABLE live_activity DROP CONSTRAINT IF EXISTS live_activity_ref_check;
ALTER TABLE live_activity ADD CONSTRAINT live_activity_check CHECK (charge_id IS NOT NULL OR session_id IS NOT NULL);
DROP INDEX IF EXISTS live_activity_roaming_idx;
ALTER TABLE live_activity DROP COLUMN IF EXISTS transport, DROP COLUMN IF EXISTS roaming_charge_id, DROP COLUMN IF EXISTS content_version;
-- A network brand is an organisation's brand like any other once its scope is gone: remove it instead.
DELETE FROM driver_app_brand WHERE scope = 'network';
DROP INDEX IF EXISTS driver_app_brand_one_network;
ALTER TABLE driver_app_brand DROP CONSTRAINT IF EXISTS driver_app_brand_scope_check, DROP CONSTRAINT IF EXISTS driver_app_brand_fcm_fields,
  DROP CONSTRAINT IF EXISTS driver_app_brand_app_config_object;
ALTER TABLE driver_app_brand DROP COLUMN IF EXISTS scope, DROP COLUMN IF EXISTS fcm_project_id, DROP COLUMN IF EXISTS fcm_client_email,
  DROP COLUMN IF EXISTS fcm_sa_sealed, DROP COLUMN IF EXISTS fcm_checked_at, DROP COLUMN IF EXISTS fcm_check_ok, DROP COLUMN IF EXISTS fcm_check_detail,
  DROP COLUMN IF EXISTS app_config;
DROP TABLE IF EXISTS app_driver_deletion;
-- app_driver.deleted_at stays (harmless; the anonymised rows keep their date).
DROP INDEX IF EXISTS site_latlon_idx;
DELETE FROM schema_migration WHERE name = '075_mobile_app.sql';
