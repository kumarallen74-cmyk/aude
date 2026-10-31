-- Rollback of 091_tax_calendar_disputes_costs_settlements.sql (v1.23.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/091_down.sql
-- Roll the CODE back first. Tax filings marked, owner disputes and their adjustments (also those not yet applied to
-- a statement: settle them by hand first), shared costs and the two settings are dropped. Statements already
-- finalised keep the adjustments they include (in their frozen data and owner share).
DROP TABLE IF EXISTS owner_statement_adjustment;
DROP TABLE IF EXISTS owner_statement_dispute;
DROP TABLE IF EXISTS finance_shared_cost;
DROP TABLE IF EXISTS tax_filing;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS settlement_tracking, DROP COLUMN IF EXISTS tax_calendar;
DELETE FROM schema_migration WHERE name = '091_tax_calendar_disputes_costs_settlements.sql';
