-- Rollback of 077_driver_idempotency.sql (v1.9.1).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/077_down.sql
-- Roll the CODE back first. Stored idempotent answers are dropped (a retry after this creates a new payment, as
-- before 1.9.1); development / preview app tokens fall back to the brand's bundle id.
DROP TABLE IF EXISTS driver_idempotency;
ALTER TABLE push_subscription DROP COLUMN IF EXISTS app_id;
ALTER TABLE live_activity DROP COLUMN IF EXISTS app_id;
ALTER TABLE live_activity_start_token DROP COLUMN IF EXISTS app_id;
DELETE FROM schema_migration WHERE name = '077_driver_idempotency.sql';
