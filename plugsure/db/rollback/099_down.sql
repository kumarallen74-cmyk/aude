-- Rollback of 099_ledger_expenses_intercompany_scorecard.sql (v1.31.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/099_down.sql
-- Roll the CODE back first. The general ledger (chart, entries, lines), expense claims with their receipts, petty cash
-- counts, intercompany recharges and settlements, KPI targets and scorecard sends are dropped: export them first
-- (Finance → Ledger, Expenses, Intercompany, Scorecard). Cash balances recorded by counts stay.
DROP TABLE IF EXISTS kpi_scorecard_send;
DROP TABLE IF EXISTS kpi_target;
DROP TABLE IF EXISTS intercompany_settlement;
DROP TABLE IF EXISTS intercompany_recharge;
DROP TABLE IF EXISTS cash_count;
DROP TABLE IF EXISTS expense_receipt;
DROP TABLE IF EXISTS expense_claim_line;
DROP TABLE IF EXISTS expense_claim;
DROP TABLE IF EXISTS gl_line;
DROP TABLE IF EXISTS gl_entry;
DROP TABLE IF EXISTS gl_account;
ALTER TABLE cash_account DROP COLUMN IF EXISTS float_minor;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS expense_policy;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS kpi_scorecard;
DELETE FROM schema_migration WHERE name = '099_ledger_expenses_intercompany_scorecard.sql';
