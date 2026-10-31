-- Rollback of 085_finance_settings.sql (v1.17.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/085_down.sql
-- Roll the CODE back first. The journal's account codes and the close e-mail settings are dropped.
DROP TABLE IF EXISTS gateway_account_settings;
-- Xendit payout transfers lose their rail (check Xendit's dashboard for any in flight first).
ALTER TABLE refund_transfer DROP COLUMN IF EXISTS rail;
ALTER TABLE payout_transfer DROP COLUMN IF EXISTS rail;
DELETE FROM schema_migration WHERE name = '085_finance_settings.sql';
