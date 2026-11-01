-- Rollback of 103_carbon_insurance_compliance.sql (v1.35.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/103_down.sql
-- Roll the CODE back first. Renewable energy certificates, carbon credits and their sales, insurance policies and claims,
-- the compliance calendar with its evidence files, and the auditor's requests are dropped: export them first (Finance →
-- Carbon, Insurance, Compliance).
UPDATE gl_entry SET status = 'superseded' WHERE source IN ('carbon', 'insurance') AND status <> 'superseded';
ALTER TABLE gl_entry DROP CONSTRAINT IF EXISTS gl_entry_source_check;
ALTER TABLE gl_entry ADD CONSTRAINT gl_entry_source_check
  CHECK (source IN ('manual', 'gateway', 'assets', 'leases', 'provision', 'bills', 'deposits', 'expenses', 'intercompany', 'reversal', 'payroll', 'customer_deposits', 'projects',
                    'inventory', 'maintenance', 'loans')) NOT VALID;
DROP TABLE IF EXISTS compliance_evidence;
DROP TABLE IF EXISTS pbc_request;
DROP TABLE IF EXISTS compliance_task;
DROP TABLE IF EXISTS insurance_claim;
DROP TABLE IF EXISTS insurance_policy;
DROP TABLE IF EXISTS carbon_credit_sale;
DROP TABLE IF EXISTS carbon_credit;
DROP TABLE IF EXISTS rec_purchase;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS carbon;
DELETE FROM schema_migration WHERE name = '103_carbon_insurance_compliance.sql';
