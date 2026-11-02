-- Rollback of 118_screen_advertising.sql (v1.51.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/118_down.sql
-- Roll the CODE back first. Dropped: advertisers, screens, campaigns, creatives (their files stay under
-- STORAGE_DIR/ads), proof of play and advertising invoices (export the invoices first: they are accounting records).
DROP TABLE IF EXISTS ad_invoice;
DROP TABLE IF EXISTS ad_play;
DROP TABLE IF EXISTS ad_creative;
DROP TABLE IF EXISTS ad_campaign;
DROP TABLE IF EXISTS ad_screen;
DROP TABLE IF EXISTS ad_advertiser;
DROP TABLE IF EXISTS ad_settings;
DELETE FROM schema_migration WHERE name = '118_screen_advertising.sql';
