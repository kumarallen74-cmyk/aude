-- Rollback of 110_scim_dynamic_pricing_demand_response_status.sql (v1.43.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/110_down.sql
-- Roll the CODE back first. Dropped: the SCIM configuration, groups and links (the console users it created stay, with
-- the roles they have), dynamic pricing rules and settings, demand-response programmes and events with their
-- measurements, and the status page with its incidents and subscribers. Export what you need first.
-- Sessions keep their totals; the price factor each was fixed at (dynamic_price_bps) is dropped with its column.
DROP TABLE IF EXISTS status_subscriber;
DROP TABLE IF EXISTS status_incident;
DROP TABLE IF EXISTS status_page;
DROP TABLE IF EXISTS dr_event_site;
DROP TABLE IF EXISTS dr_event;
DROP TABLE IF EXISTS dr_program;
ALTER TABLE payment_intent DROP COLUMN IF EXISTS dynamic_price_bps;
ALTER TABLE charging_session DROP COLUMN IF EXISTS dynamic_price_reason;
ALTER TABLE charging_session DROP COLUMN IF EXISTS dynamic_price_bps;
DROP TABLE IF EXISTS site_price_now;
DROP TABLE IF EXISTS dynamic_price_rule;
DROP TABLE IF EXISTS dynamic_price_settings;
DROP TABLE IF EXISTS scim_group_member;
DROP TABLE IF EXISTS scim_group;
DROP TABLE IF EXISTS scim_user;
DROP TABLE IF EXISTS scim_config;
DELETE FROM schema_migration WHERE name = '110_scim_dynamic_pricing_demand_response_status.sql';
