-- Rollback of 097_assets_bills_cash_benchmark.sql (v1.29.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/097_down.sql
-- Roll the CODE back first. The asset register (with its depreciation runs), suppliers, supplier bills and their
-- payments, cash accounts, balances and transfers are dropped: export them first (Finance → Assets, Bills, Cash).
-- Bank statement lines matched to supplier payments are unmatched.
UPDATE bank_statement_line SET matched_kind = NULL, matched_ref = NULL, matched_auto = false WHERE matched_kind = 'supplier_payment';
ALTER TABLE bank_statement_line DROP CONSTRAINT IF EXISTS bank_statement_line_matched_kind_check;
ALTER TABLE bank_statement_line ADD CONSTRAINT bank_statement_line_matched_kind_check
  CHECK (matched_kind = ANY (ARRAY['gateway_withdrawal', 'statement_payment', 'refund', 'roaming_payment', 'ignored']));
ALTER TABLE bank_statement DROP COLUMN IF EXISTS cash_account_id;
DROP TABLE IF EXISTS fixed_asset_run;
DROP TABLE IF EXISTS fixed_asset;
DROP TABLE IF EXISTS supplier_payment;
DROP TABLE IF EXISTS supplier_bill;
DROP TABLE IF EXISTS cash_transfer;
DROP TABLE IF EXISTS cash_balance;
DROP TABLE IF EXISTS cash_account;
DROP TABLE IF EXISTS supplier;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS fixed_assets;
DELETE FROM schema_migration WHERE name = '097_assets_bills_cash_benchmark.sql';
