-- Rollback of 092_refund_requests_credit_warehouse_yearend.sql (v1.24.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/092_down.sql
-- Roll the CODE back first. Cards blocked for credit are unblocked first (they would stay blocked otherwise). Driver
-- refund requests (refunds they started stay in the Refunds queue), fleet credit settings and deposits (record the
-- deposits still held elsewhere first), the export log and the two settings are dropped.
UPDATE token SET status = 'Accepted', credit_blocked_at = NULL WHERE credit_blocked_at IS NOT NULL AND status = 'Blocked';
DROP TABLE IF EXISTS finance_export_run;
DROP TABLE IF EXISTS fleet_credit_alert;
DROP TABLE IF EXISTS fleet_prepay_entry;
DROP TABLE IF EXISTS driver_refund_request;
ALTER TABLE token DROP COLUMN IF EXISTS credit_blocked_at;
ALTER TABLE fleet_account DROP COLUMN IF EXISTS credit_auto_apply, DROP COLUMN IF EXISTS credit_block, DROP COLUMN IF EXISTS credit_currency,
  DROP COLUMN IF EXISTS credit_limit_minor, DROP COLUMN IF EXISTS credit_mode;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS warehouse, DROP COLUMN IF EXISTS driver_refund_policy;
DELETE FROM schema_migration WHERE name = '092_refund_requests_credit_warehouse_yearend.sql';
