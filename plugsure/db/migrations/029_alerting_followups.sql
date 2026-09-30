-- 029: alerting follow-ups — delivery status, SMS, on-call rotas, per-site offline thresholds.
--
--   WhatsApp delivery status  Meta's webhook reports each message delivered, read or failed
--                             after WhatsApp accepted it ("sent" only meant accepted).
--   SMS                       a third alert channel (Twilio, Zenziva or your own gateway),
--                             and an optional fallback when WhatsApp fails.
--   On-call rotas             who is on duty this week (or day), with overrides; rules and
--                             escalations can notify whoever is on duty.
--   Offline threshold         per site, overriding OFFLINE_ALERT_MINUTES.
--
-- All additive: existing rules, contacts and channels behave exactly as before.

-- ─────────────────────────────────────────────── per-site offline threshold
ALTER TABLE site
  ADD COLUMN IF NOT EXISTS offline_alert_minutes INTEGER
    CHECK (offline_alert_minutes IS NULL OR offline_alert_minutes BETWEEN 1 AND 1440);
COMMENT ON COLUMN site.offline_alert_minutes IS
  'Minutes a charger at this site may be offline before the critical alert; NULL = the fleet default (OFFLINE_ALERT_MINUTES).';

-- ─────────────────────────────────────────────── SMS as a channel
ALTER TABLE notification_channel DROP CONSTRAINT IF EXISTS notification_channel_kind_check;
ALTER TABLE notification_channel ADD CONSTRAINT notification_channel_kind_check CHECK (kind IN ('email', 'whatsapp', 'sms'));
ALTER TABLE alert_notification DROP CONSTRAINT IF EXISTS alert_notification_channel_check;
ALTER TABLE alert_notification ADD CONSTRAINT alert_notification_channel_check CHECK (channel IN ('email', 'whatsapp', 'sms'));

-- A contact can have a separate SMS number; otherwise SMS goes to the WhatsApp number.
ALTER TABLE alert_contact ADD COLUMN IF NOT EXISTS sms TEXT;
ALTER TABLE alert_contact DROP CONSTRAINT IF EXISTS alert_contact_check;
ALTER TABLE alert_contact ADD CONSTRAINT alert_contact_check CHECK (email IS NOT NULL OR whatsapp IS NOT NULL OR sms IS NOT NULL);

-- ─────────────────────────────────────────────── WhatsApp delivery status (Meta webhook)
ALTER TABLE notification_channel
  ADD COLUMN IF NOT EXISTS webhook_key     TEXT UNIQUE,   -- the secret path segment of this channel's status webhook
  ADD COLUMN IF NOT EXISTS verify_token    TEXT,          -- Meta's subscription check (hub.verify_token)
  ADD COLUMN IF NOT EXISTS webhook_secret  TEXT;          -- the Meta app secret (X-Hub-Signature-256), sealed

ALTER TABLE alert_notification
  ADD COLUMN IF NOT EXISTS delivery        TEXT CHECK (delivery IS NULL OR delivery IN ('delivered', 'read', 'failed')),
  ADD COLUMN IF NOT EXISTS delivered_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS read_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_error  TEXT,
  -- An SMS sent because this WhatsApp message failed points at it.
  ADD COLUMN IF NOT EXISTS fallback_of     BIGINT REFERENCES alert_notification(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS alert_notification_ref_idx ON alert_notification (channel, provider_ref) WHERE provider_ref IS NOT NULL;

-- ─────────────────────────────────────────────── rules: SMS fallback, rotas
ALTER TABLE alert_rule
  ADD COLUMN IF NOT EXISTS sms_fallback       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rota_ids           UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS escalate_rota_ids  UUID[] NOT NULL DEFAULT '{}';

-- ─────────────────────────────────────────────── on-call rotas
CREATE TABLE IF NOT EXISTS on_call_rota (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organisation(id),
  name            TEXT NOT NULL,
  member_ids      UUID[] NOT NULL DEFAULT '{}',      -- alert contacts, in rotation order
  shift           TEXT NOT NULL DEFAULT 'weekly' CHECK (shift IN ('daily', 'weekly')),
  handover_time   TIME NOT NULL DEFAULT '08:00',     -- local time (ALERT_TIMEZONE)
  starts_on       DATE NOT NULL,                     -- the first shift begins at handover_time on this day
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS on_call_override (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organisation(id),
  rota_id     UUID NOT NULL REFERENCES on_call_rota(id) ON DELETE CASCADE,
  contact_id  UUID NOT NULL REFERENCES alert_contact(id) ON DELETE CASCADE,
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS on_call_override_rota_idx ON on_call_override (rota_id, starts_at, ends_at);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['on_call_rota','on_call_override']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$I_tenant ON %1$I', t);
    EXECUTE format($f$
      CREATE POLICY %1$I_tenant ON %1$I
        USING (app_current_org() IS NULL OR org_id = app_current_org())
        WITH CHECK (app_current_org() IS NULL OR org_id = app_current_org())
    $f$, t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
