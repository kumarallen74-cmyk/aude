-- Rollback of 106_owner_finance_fx_hedges_procurement_close.sql (v1.38.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/106_down.sql
-- Roll the CODE back first. FX hedges, procurement savings, the close calendar and the close runs are dropped: export
-- them first (Finance → FX, Procurement, Close).
UPDATE gl_entry SET status = 'superseded' WHERE source = 'fx' AND status <> 'superseded';
ALTER TABLE gl_entry DROP CONSTRAINT IF EXISTS gl_entry_source_check;
ALTER TABLE gl_entry ADD CONSTRAINT gl_entry_source_check
  CHECK (source IN ('manual', 'gateway', 'assets', 'leases', 'provision', 'bills', 'deposits', 'expenses', 'intercompany', 'reversal', 'payroll', 'customer_deposits', 'projects',
                    'inventory', 'maintenance', 'loans', 'carbon', 'insurance', 'grants', 'landlords', 'chargebacks', 'loyalty')) NOT VALID;
DROP TABLE IF EXISTS close_run;
DROP TABLE IF EXISTS close_assignment;
DROP TABLE IF EXISTS procurement_saving;
DROP TABLE IF EXISTS fx_hedge;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS close_automation;
DELETE FROM schema_migration WHERE name = '106_owner_finance_fx_hedges_procurement_close.sql';
