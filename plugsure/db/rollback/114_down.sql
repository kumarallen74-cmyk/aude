-- Rollback of 114_home_terminals_prices_surveys.sql (v1.47.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/114_down.sql
-- Roll the CODE back first. Dropped: home chargers, meter readings and reimbursements; payment terminals, their
-- transactions (capture any still due at the provider first) and settlement lines; price zones, prices and the sites'
-- price settings; survey settings and responses.
DROP TABLE IF EXISTS survey_response;
DROP TABLE IF EXISTS survey_settings;
ALTER TABLE site DROP COLUMN IF EXISTS price_threshold_minor, DROP COLUMN IF EXISTS price_cap_pct, DROP COLUMN IF EXISTS price_shift, DROP COLUMN IF EXISTS price_zone_id;
DROP TABLE IF EXISTS energy_price;
DROP TABLE IF EXISTS energy_price_zone;
DROP TABLE IF EXISTS terminal_settlement_line;
DROP TABLE IF EXISTS terminal_txn;
DROP TABLE IF EXISTS payment_terminal;
DROP TABLE IF EXISTS home_reimbursement;
DROP TABLE IF EXISTS home_meter_reading;
DROP TABLE IF EXISTS home_charger;
DELETE FROM schema_migration WHERE name = '114_home_terminals_prices_surveys.sql';
