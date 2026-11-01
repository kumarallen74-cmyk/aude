-- Rollback of 101_payroll_credit_capex_forecast.sql (v1.33.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/101_down.sql
-- Roll the CODE back first. Employees, payroll runs and payslip lines, credit reviews, customer deposits, capex projects
-- and stored cash forecasts are dropped: export them first (Finance → Payroll, Credit, Projects, Cash forecast). Assets
-- capitalised from projects stay in the register; their link to the project is dropped.
UPDATE gl_entry SET status = 'superseded' WHERE source IN ('payroll', 'customer_deposits', 'projects') AND status <> 'superseded';
ALTER TABLE gl_entry DROP CONSTRAINT IF EXISTS gl_entry_source_check;
ALTER TABLE gl_entry ADD CONSTRAINT gl_entry_source_check
  CHECK (source IN ('manual', 'gateway', 'assets', 'leases', 'provision', 'bills', 'deposits', 'expenses', 'intercompany', 'reversal')) NOT VALID;
ALTER TABLE fixed_asset DROP COLUMN IF EXISTS capex_project_id;
ALTER TABLE supplier_bill DROP COLUMN IF EXISTS capex_project_id;
ALTER TABLE purchase_order DROP COLUMN IF EXISTS capex_project_id;
DROP TABLE IF EXISTS cash_forecast_run;
DROP TABLE IF EXISTS capex_project;
DROP TABLE IF EXISTS customer_deposit;
DROP TABLE IF EXISTS credit_review;
DROP TABLE IF EXISTS payroll_line;
DROP TABLE IF EXISTS payroll_run;
DROP TABLE IF EXISTS employee;
ALTER TABLE fleet_account DROP COLUMN IF EXISTS next_review_on;
ALTER TABLE fleet_account DROP COLUMN IF EXISTS credit_hold_reason;
ALTER TABLE fleet_account DROP COLUMN IF EXISTS credit_hold_at;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS cash_forecast;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS payroll;
DELETE FROM schema_migration WHERE name = '101_payroll_credit_capex_forecast.sql';
