-- Rollback of 088_budgets_energy_collections.sql (v1.20.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/088_down.sql
-- Roll the CODE back first. Energy bills and rates, budgets, collections settings, notes, the reminder log and
-- write-off requests are dropped (export them first if needed).
DROP TABLE IF EXISTS receivable_write_off;
DROP TABLE IF EXISTS dunning_reminder;
DROP TABLE IF EXISTS receivable_note;
DROP TABLE IF EXISTS finance_org_settings;
DROP TABLE IF EXISTS finance_budget;
DROP TABLE IF EXISTS site_energy_cost;
DROP TABLE IF EXISTS site_energy_rate;
DELETE FROM schema_migration WHERE name = '088_budgets_energy_collections.sql';
