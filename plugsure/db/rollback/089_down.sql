-- Rollback of 089_fx_reports_approvals.sql (v1.21.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/089_down.sql
-- Roll the CODE back first. Exchange rates, report schedules, the approvals matrix and first approvals (on transfers
-- and write-offs still waiting for a second approval) are dropped.
DROP TABLE IF EXISTS finance_report_schedule;
DROP TABLE IF EXISTS fx_rate;
ALTER TABLE owner_bank_change_request DROP COLUMN IF EXISTS first_approved_at, DROP COLUMN IF EXISTS first_approved_by;
ALTER TABLE receivable_write_off DROP COLUMN IF EXISTS first_approved_at, DROP COLUMN IF EXISTS first_approved_by;
ALTER TABLE payout_transfer DROP COLUMN IF EXISTS first_approved_at, DROP COLUMN IF EXISTS first_approved_by;
ALTER TABLE refund_transfer DROP COLUMN IF EXISTS first_approved_at, DROP COLUMN IF EXISTS first_approved_by;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS approval_rules, DROP COLUMN IF EXISTS reporting_currency;
DELETE FROM schema_migration WHERE name = '089_fx_reports_approvals.sql';
