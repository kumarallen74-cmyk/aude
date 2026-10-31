-- Rollback of 090_period_locks_investments_anomalies_statements.sql (v1.22.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/090_down.sql
-- Roll the CODE back first. Month locks, site investments, the revenue anomalies found, the statement-of-account log
-- and the two settings (revenue alerts, automatic statements) are dropped.
DROP TABLE IF EXISTS fleet_statement_send;
DROP TABLE IF EXISTS revenue_anomaly;
DROP TABLE IF EXISTS site_investment;
DROP TABLE IF EXISTS finance_period_lock;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS fleet_statements, DROP COLUMN IF EXISTS revenue_alerts;
DELETE FROM schema_migration WHERE name = '090_period_locks_investments_anomalies_statements.sql';
