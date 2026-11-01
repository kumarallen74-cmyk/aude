-- Rollback of 107 (v1.39.0): corporate tax, payment runs, corporate cards.
-- Run with the code rolled back to v1.38.0. Export the tax computations, payment runs and card transactions first
-- (Finance → Corporate tax, Payment runs, Cards). Supplier payments recorded by paid runs stay (they are the bills'
-- payments); ledger entries from the tax and cards sources are superseded.
UPDATE gl_entry SET status = 'superseded' WHERE source IN ('tax', 'cards') AND status <> 'superseded';
ALTER TABLE gl_entry DROP CONSTRAINT IF EXISTS gl_entry_source_check;
ALTER TABLE gl_entry ADD CONSTRAINT gl_entry_source_check
  CHECK (source IN ('manual', 'gateway', 'assets', 'leases', 'provision', 'bills', 'deposits', 'expenses', 'intercompany', 'reversal', 'payroll', 'customer_deposits', 'projects',
                    'inventory', 'maintenance', 'loans', 'carbon', 'insurance', 'grants', 'landlords', 'chargebacks', 'loyalty', 'fx')) NOT VALID;
DROP TABLE IF EXISTS card_statement;
DROP TABLE IF EXISTS card_txn;
DROP TABLE IF EXISTS corp_card;
DROP TABLE IF EXISTS payment_run_item;
DROP TABLE IF EXISTS payment_run;
DROP TABLE IF EXISTS tax_payment;
DROP TABLE IF EXISTS tax_fiscal_correction;
DROP TABLE IF EXISTS corporate_tax_year;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS card_policy;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS corporate_tax;
DELETE FROM schema_migration WHERE name = '107_corporate_tax_payment_runs_cards.sql';
