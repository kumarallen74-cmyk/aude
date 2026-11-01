-- Rollback of 096_driver_funds_consolidation_plans_provisions.sql (v1.28.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/096_down.sql
-- Roll the CODE back first. Recognised breakage, eliminations, payment plans (with their instalments) and recorded
-- provisions are dropped: export them first (Finance → Driver funds, Group, Collections, Provision). Payments
-- recorded on fleet invoices through a plan stay.
DROP TABLE IF EXISTS bad_debt_provision;
DROP TABLE IF EXISTS payment_plan_instalment;
DROP TABLE IF EXISTS payment_plan;
DROP TABLE IF EXISTS consolidation_elimination;
DROP TABLE IF EXISTS driver_funds_breakage;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS provision_rates;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS forecast;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS driver_funds;
DELETE FROM schema_migration WHERE name = '096_driver_funds_consolidation_plans_provisions.sql';
