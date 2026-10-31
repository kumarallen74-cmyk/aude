-- Rollback of 079_whatsapp_ai_support.sql (v1.11.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/079_down.sql
-- Roll the CODE back first. The support conversations and their messages are dropped, with the AI support
-- integration (its API key goes with it) and the replies' rows in the delivery ledger.
DROP TABLE IF EXISTS whatsapp_chat_message;
DROP TABLE IF EXISTS whatsapp_conversation;
DELETE FROM whatsapp_message WHERE purpose = 'support';
ALTER TABLE whatsapp_message DROP CONSTRAINT IF EXISTS whatsapp_message_purpose_check;
ALTER TABLE whatsapp_message ADD CONSTRAINT whatsapp_message_purpose_check CHECK (purpose IN ('otp', 'alert', 'test', 'other'));
DELETE FROM integration_event WHERE kind = 'ai_support';
DELETE FROM integration WHERE kind = 'ai_support';
ALTER TABLE integration DROP CONSTRAINT IF EXISTS integration_kind_check;
ALTER TABLE integration ADD CONSTRAINT integration_kind_check CHECK (kind IN ('payments', 'otp', 'otp_fallback', 'pnc_pki', 'map_tiles'));
DELETE FROM schema_migration WHERE name = '079_whatsapp_ai_support.sql';
