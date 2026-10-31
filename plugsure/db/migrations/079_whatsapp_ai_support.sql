-- 079: WhatsApp customer support with an AI assistant (Claude) and a human inbox (v1.11.0).
--
--   integration.kind 'ai_support'  the platform's AI assistant (Govern → Integrations → WhatsApp AI support):
--                                   provider anthropic (Claude), its API key (sealed), model, mode (auto / draft / off)
--                                   and the operator's knowledge text. No schema of its own beyond the kind.
--   whatsapp_conversation           one row per customer number writing to PlugSure's WhatsApp number: the number
--                                   SEALED (it is needed to reply) and as an HMAC for lookup, masked for display;
--                                   who answers (ai / human), when the customer last wrote (Meta's 24-hour window
--                                   for free-form replies), the AI's pending draft, the driver account it matched.
--   whatsapp_chat_message            the conversation's messages, both ways: text only (media is noted, not kept),
--                                   who wrote it (customer, ai, staff, system), Meta's message id, and for AI replies
--                                   the model and tokens. Kept 90 days (src/services/retention.ts); a conversation
--                                   with no message left goes with them.
--   whatsapp_message.purpose         gains 'support': replies are in the delivery ledger like every other message.
--
-- Platform tables without an organisation (a customer writes to the platform's number, not to an operator): no RLS,
-- like whatsapp_event; only platform administrators reach them (src/api/whatsapp-routes.ts). Additive and idempotent.
-- Rollback: db/rollback/079_down.sql.

ALTER TABLE integration DROP CONSTRAINT IF EXISTS integration_kind_check;
ALTER TABLE integration ADD CONSTRAINT integration_kind_check
  CHECK (kind IN ('payments', 'otp', 'otp_fallback', 'pnc_pki', 'map_tiles', 'ai_support'));

ALTER TABLE whatsapp_message DROP CONSTRAINT IF EXISTS whatsapp_message_purpose_check;
ALTER TABLE whatsapp_message ADD CONSTRAINT whatsapp_message_purpose_check
  CHECK (purpose IN ('otp', 'alert', 'test', 'other', 'support'));

CREATE TABLE IF NOT EXISTS whatsapp_conversation (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- HMAC-SHA256 of the digits (SECRETS_KEY): finds the conversation without storing the number in the clear.
  phone_hash        TEXT NOT NULL UNIQUE,
  -- seal(): the number in E.164, opened only to send a reply.
  phone_sealed      TEXT NOT NULL,
  phone_masked      TEXT NOT NULL,
  -- The WhatsApp profile name the customer chose (Meta's contacts[].profile.name).
  profile_name      TEXT,
  app_driver_id     UUID REFERENCES app_driver(id) ON DELETE SET NULL,
  -- ai: the assistant answers (mode auto) or drafts (mode draft); human: staff answer, the assistant is quiet;
  -- closed: nothing pending (a new message from the customer reopens it with the assistant).
  handler           TEXT NOT NULL DEFAULT 'ai' CHECK (handler IN ('ai', 'human', 'closed')),
  handoff_reason    TEXT,
  -- The AI's suggested reply in draft mode, for staff to send or edit.
  draft             TEXT,
  last_inbound_at   TIMESTAMPTZ,
  last_message_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Customer messages since staff last opened it.
  unread            INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_conversation_recent_idx ON whatsapp_conversation (last_message_at DESC);

CREATE TABLE IF NOT EXISTS whatsapp_chat_message (
  id                BIGSERIAL PRIMARY KEY,
  conversation_id   UUID NOT NULL REFERENCES whatsapp_conversation(id) ON DELETE CASCADE,
  direction         TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  author            TEXT NOT NULL CHECK (author IN ('customer', 'ai', 'staff', 'system')),
  body              TEXT NOT NULL,
  -- Meta's id: inbound for de-duplication (Meta retries), outbound for the delivery status (whatsapp_message).
  wamid             TEXT UNIQUE,
  staff_user_id     UUID,
  model             TEXT,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  error_text        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_chat_message_conv_idx ON whatsapp_chat_message (conversation_id, id);
CREATE INDEX IF NOT EXISTS whatsapp_chat_message_created_idx ON whatsapp_chat_message (created_at);
CREATE INDEX IF NOT EXISTS whatsapp_chat_message_ai_idx ON whatsapp_chat_message (created_at) WHERE author = 'ai';

-- No blanket GRANT (see 053/055/070/076): exactly what src/services/whatsapp-support.ts and retention.ts use.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_conversation TO plugsure_app;
    GRANT SELECT, INSERT, DELETE ON whatsapp_chat_message TO plugsure_app;
    REVOKE UPDATE, TRUNCATE ON whatsapp_chat_message FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE whatsapp_chat_message_id_seq TO plugsure_app;
  END IF;
END $$;
