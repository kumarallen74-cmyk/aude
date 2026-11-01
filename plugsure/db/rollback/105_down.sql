-- Rollback of 105_loyalty_tax_audit_site_pnl_budget_plans.sql (v1.37.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/105_down.sql
-- Roll the CODE back first. Tax audit cases and budget plans (their versions and lines) are dropped: export them first
-- (Finance → Tax audit, Budget planning). Budgets already published from a plan stay in Budgets.
UPDATE gl_entry SET status = 'superseded' WHERE source = 'loyalty' AND status <> 'superseded';
ALTER TABLE gl_entry DROP CONSTRAINT IF EXISTS gl_entry_source_check;
ALTER TABLE gl_entry ADD CONSTRAINT gl_entry_source_check
  CHECK (source IN ('manual', 'gateway', 'assets', 'leases', 'provision', 'bills', 'deposits', 'expenses', 'intercompany', 'reversal', 'payroll', 'customer_deposits', 'projects',
                    'inventory', 'maintenance', 'loans', 'carbon', 'insurance', 'grants', 'landlords', 'chargebacks')) NOT VALID;
DROP TABLE IF EXISTS budget_plan_line;
DROP TABLE IF EXISTS budget_plan;
DROP TABLE IF EXISTS tax_audit_case;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS loyalty_accounting;
DELETE FROM schema_migration WHERE name = '105_loyalty_tax_audit_site_pnl_budget_plans.sql';
