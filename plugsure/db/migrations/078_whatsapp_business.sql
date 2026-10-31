-- 078: the WhatsApp Business (Meta Cloud API) dashboard: its message ledger and account events (v1.10.0).
--
--   (no schema change)          the sign-in code integration on the WhatsApp Cloud API (otp / otp_fallback provider
--                                whatsapp_cloud) gains optional settings: the WABA id and the app secret (sealed), and
--                                a webhook key with a server-made verify token. Its webhook /hooks/whatsapp-cloud/<key>
--                                receives Meta's statuses and account events. A Meta app has ONE callback URL, so that
--                                webhook also tracks delivery of operator alerts sent from the same app.
--   whatsapp_message             one row per message PlugSure sent from that number (sign-in codes, test sends):
--                                purpose, template, the MASKED number (never the
--                                full one, never a code), Meta's message id (wamid) and the delivery status the
--                                webhook reports. Kept 180 days (src/services/retention.ts).
--   whatsapp_event               account-level webhook events: template approved / paused / rejected, number quality,
--                                account updates. Trimmed payloads; the last 500 / 90 days are kept.
--
-- whatsapp_message is a platform table with the integration_event policy shape (org_id NULL = platform rows, readable
-- in every tenant scope; written outside a tenant scope only). whatsapp_event has no org at all (no RLS, like
-- driver_idempotency). Additive and idempotent. Rollback: db/rollback/078_down.sql.

CREATE TABLE IF NOT EXISTS whatsapp_message (
  id                BIGSERIAL PRIMARY KEY,
  org_id            UUID REFERENCES organisation(id),
  purpose           TEXT NOT NULL CHECK (purpose IN ('otp', 'alert', 'test', 'other')),
  template          TEXT,
  language          TEXT,
  -- maskPhone(): +6281****890. The full number is never stored.
  to_masked         TEXT NOT NULL,
  -- NULL when Meta refused the message (nothing to track).
  wamid             TEXT UNIQUE,
  status            TEXT NOT NULL CHECK (status IN ('accepted', 'sent', 'delivered', 'read', 'failed')),
  error_code        TEXT,
  error_text        TEXT,
  pricing_category  TEXT,
  billable          BOOLEAN,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at           TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  read_at           TIMESTAMPTZ,
  failed_at         TIMESTAMPTZ,
  -- When the webhook last reported on it: the dashboard's "last status received".
  webhook_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS whatsapp_message_created_idx ON whatsapp_message (created_at);
CREATE INDEX IF NOT EXISTS whatsapp_message_status_idx ON whatsapp_message (status, created_at);

CREATE TABLE IF NOT EXISTS whatsapp_event (
  id          BIGSERIAL PRIMARY KEY,
  field       TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_event_created_idx ON whatsapp_event (created_at);

-- The post-048 shape (app_rls_bypass(), never `app_current_org() IS NULL`), with platform rows as integration_event.
ALTER TABLE whatsapp_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_message FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS whatsapp_message_tenant ON whatsapp_message;
CREATE POLICY whatsapp_message_tenant ON whatsapp_message
  USING (app_rls_bypass() OR org_id IS NULL OR org_id = app_current_org())
  WITH CHECK (app_rls_bypass() OR org_id = app_current_org());

-- No blanket GRANT (see 053/055/070/076): exactly what src/services/whatsapp-cloud.ts and retention.ts use.
-- An event is recorded once and never changed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_message TO plugsure_app;
    GRANT SELECT, INSERT, DELETE ON whatsapp_event TO plugsure_app;
    REVOKE UPDATE, TRUNCATE ON whatsapp_event FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE whatsapp_message_id_seq, whatsapp_event_id_seq TO plugsure_app;
  END IF;
END $$;
