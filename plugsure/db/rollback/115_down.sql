-- Rollback of 115_hotels_installs_privacy_battery.sql (v1.48.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/115_down.sql
-- Roll the CODE back first. Dropped: hotel properties, stays and charges (post any charge still due to the hotels
-- first); installation projects, tasks, stage history and documents (their files stay under STORAGE_DIR/install);
-- privacy settings, requests and consent records (export them first: they are evidence of compliance); battery
-- health estimates (recomputed from the sessions if rolled forward again).
DROP TABLE IF EXISTS vehicle_battery_estimate;
DROP TABLE IF EXISTS privacy_consent;
DROP TABLE IF EXISTS privacy_request;
DROP TABLE IF EXISTS privacy_settings;
DROP TABLE IF EXISTS install_stage_event;
DROP TABLE IF EXISTS install_document;
DROP TABLE IF EXISTS install_task;
DROP TABLE IF EXISTS install_project;
DROP TABLE IF EXISTS hotel_charge;
DROP TABLE IF EXISTS hotel_stay;
DROP TABLE IF EXISTS hotel_property;
DELETE FROM schema_migration WHERE name = '115_hotels_installs_privacy_battery.sql';
