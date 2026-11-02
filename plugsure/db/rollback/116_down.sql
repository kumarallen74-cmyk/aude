-- Rollback of 116_swap_roadside_rma_amenities.sql (v1.49.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/116_down.sql
-- Roll the CODE back first. Dropped: swap cabinets, packs, plans, subscriptions and the swap log (export the log
-- first: riders' credit was spent on it); roadside vans and requests; charger warranties and RMA cases; site
-- amenities and accessibility reports.
DROP TABLE IF EXISTS accessibility_report;
DROP TABLE IF EXISTS site_amenity;
DROP TABLE IF EXISTS rma_case;
DROP TABLE IF EXISTS charger_warranty;
DROP TABLE IF EXISTS roadside_request;
DROP TABLE IF EXISTS roadside_van;
DROP TABLE IF EXISTS roadside_settings;
DROP TABLE IF EXISTS swap_event;
DROP TABLE IF EXISTS swap_subscription;
DROP TABLE IF EXISTS swap_plan;
DROP TABLE IF EXISTS swap_battery;
DROP TABLE IF EXISTS swap_cabinet;
DROP TABLE IF EXISTS swap_settings;
DELETE FROM schema_migration WHERE name = '116_swap_roadside_rma_amenities.sql';
