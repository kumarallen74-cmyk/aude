-- Rollback of 108_contracts_transfer_pricing_data_quality_scenarios.sql (v1.40.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/108_down.sql
-- Roll the CODE back first. Contracts, the transfer-pricing policy and recharges' TP fields, data-quality runs and
-- scenarios are dropped: export them first. Ledger entries from the contracts source are superseded.
UPDATE gl_entry SET status = 'superseded' WHERE source = 'contracts' AND status <> 'superseded';
ALTER TABLE gl_entry DROP CONSTRAINT IF EXISTS gl_entry_source_check;
ALTER TABLE gl_entry ADD CONSTRAINT gl_entry_source_check
  CHECK (source IN ('manual', 'gateway', 'assets', 'leases', 'provision', 'bills', 'deposits', 'expenses', 'intercompany', 'reversal', 'payroll', 'customer_deposits', 'projects',
                    'inventory', 'maintenance', 'loans', 'carbon', 'insurance', 'grants', 'landlords', 'chargebacks', 'loyalty', 'fx', 'tax', 'cards')) NOT VALID;
DROP TABLE IF EXISTS finance_scenario;
DROP TABLE IF EXISTS dq_run;
DROP TABLE IF EXISTS tp_policy;
ALTER TABLE intercompany_recharge DROP COLUMN IF EXISTS cost_minor;
ALTER TABLE intercompany_recharge DROP COLUMN IF EXISTS tp_kind;
DROP TABLE IF EXISTS contract_billing;
DROP TABLE IF EXISTS contract_obligation;
DROP TABLE IF EXISTS customer_contract;
DELETE FROM schema_migration WHERE name = '108_contracts_transfer_pricing_data_quality_scenarios.sql';
