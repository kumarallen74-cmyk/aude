-- Rollback of 078_whatsapp_business.sql (v1.10.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/078_down.sql
-- Roll the CODE back first. The WhatsApp dashboard's message ledger and account events are dropped. The sign-in code
-- integration keeps the settings 1.10.0 added to it (WABA id; app secret and verify token, sealed) and its webhook key:
-- the older code ignores them (it only follows a payments row's webhook key), and they apply again after a re-upgrade.
-- Operator alert channels keep their own /hooks/whatsapp/<key>; point the Meta app's callback back at it if it was moved.
DROP TABLE IF EXISTS whatsapp_event;
DROP TABLE IF EXISTS whatsapp_message;
DELETE FROM schema_migration WHERE name = '078_whatsapp_business.sql';
