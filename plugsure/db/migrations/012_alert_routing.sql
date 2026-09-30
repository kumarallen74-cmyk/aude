-- 012: alert routing to e-mail and WhatsApp
--
-- Alerts were only visible to someone looking at the console (or a webhook
-- receiver). Operations teams in Indonesia run on WhatsApp; a charger that dies
-- at 02:00 should wake the on-call technician, not wait for the morning shift.
--
--   notification_channel  one e-mail (SMTP) and one WhatsApp (Cloud API) sender per org
--   alert_contact         who can be notified: name, e-mail, WhatsApp number
--   alert_rule            which alerts go to whom: severity, kinds, sites, quiet
--                         hours, "resolved" notices, escalation if unacknowledged
--   alert_notification    outbox + delivery log, one row per message
--
-- All additive. Existing alerts are marked as already routed so the upgrade does
-- not send a burst of notifications for history.

-- ─────────────────────────────────────────────── alert: scope, acknowledgement, repeats, routing progress
ALTER TABLE alert
  ADD COLUMN IF NOT EXISTS site_id            UUID,
  ADD COLUMN IF NOT EXISTS acknowledged_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS acknowledged_by    UUID,
  ADD COLUMN IF NOT EXISTS occurrences        INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_raised_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS routed_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolve_routed_at  TIMESTAMPTZ;
COMMENT ON COLUMN alert.occurrences IS
  'The same open problem (same kind and target) raised again bumps this instead of creating a new alert, so an hourly sweep does not page anyone every hour.';

UPDATE alert SET routed_at = now() WHERE routed_at IS NULL;
UPDATE alert SET resolve_routed_at = now() WHERE resolved_at IS NOT NULL AND resolve_routed_at IS NULL;

CREATE INDEX IF NOT EXISTS alert_unrouted_idx ON alert (raised_at) WHERE routed_at IS NULL;
CREATE INDEX IF NOT EXISTS alert_resolve_unrouted_idx ON alert (resolved_at) WHERE resolved_at IS NOT NULL AND resolve_routed_at IS NULL;
CREATE INDEX IF NOT EXISTS alert_open_target_idx ON alert (org_id, kind, target_type, target_id) WHERE resolved_at IS NULL;

-- ─────────────────────────────────────────────── channels
CREATE TABLE IF NOT EXISTS notification_channel (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organisation(id),
  kind          TEXT NOT NULL CHECK (kind IN ('email', 'whatsapp')),
  enabled       BOOLEAN NOT NULL DEFAULT true,
  -- Non-secret settings (SMTP host/port/sender; WhatsApp phone-number id, template).
  config        JSONB NOT NULL DEFAULT '{}',
  -- SMTP password / WhatsApp access token, sealed with SECRETS_KEY. Never returned by the API.
  secret        TEXT,
  last_test_at  TIMESTAMPTZ,
  last_test_ok  BOOLEAN,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, kind)
);

-- ─────────────────────────────────────────────── contacts
CREATE TABLE IF NOT EXISTS alert_contact (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organisation(id),
  name        TEXT NOT NULL,
  email       TEXT,
  whatsapp    TEXT,            -- E.164 digits without '+', e.g. 6281234567890
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR whatsapp IS NOT NULL)
);

-- ─────────────────────────────────────────────── rules
CREATE TABLE IF NOT EXISTS alert_rule (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organisation(id),
  name                  TEXT NOT NULL,
  enabled               BOOLEAN NOT NULL DEFAULT true,
  min_severity          TEXT NOT NULL DEFAULT 'critical' CHECK (min_severity IN ('info', 'warning', 'critical')),
  kinds                 TEXT[] NOT NULL DEFAULT '{}',   -- empty = every kind
  site_ids              UUID[] NOT NULL DEFAULT '{}',   -- empty = every site (and alerts with no site)
  channels              TEXT[] NOT NULL DEFAULT '{email,whatsapp}',
  contact_ids           UUID[] NOT NULL DEFAULT '{}',
  notify_resolved       BOOLEAN NOT NULL DEFAULT true,
  -- Quiet hours (local time, ALERT_TIMEZONE). Non-critical messages wait until they end.
  quiet_start           TIME,
  quiet_end             TIME,
  -- Escalation: if still open and unacknowledged after N minutes, notify these contacts too.
  escalate_after_min    INTEGER CHECK (escalate_after_min IS NULL OR escalate_after_min BETWEEN 1 AND 1440),
  escalate_contact_ids  UUID[] NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────── outbox / delivery log
CREATE TABLE IF NOT EXISTS alert_notification (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  alert_id         UUID REFERENCES alert(id) ON DELETE CASCADE,   -- NULL for test and storm notices
  rule_id          UUID REFERENCES alert_rule(id) ON DELETE SET NULL,
  contact_id       UUID REFERENCES alert_contact(id) ON DELETE SET NULL,
  channel          TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  destination      TEXT NOT NULL,
  stage            TEXT NOT NULL CHECK (stage IN ('raised', 'escalation', 'resolved', 'storm', 'test')),
  state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'failed', 'suppressed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error       TEXT,
  provider_ref     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at          TIMESTAMPTZ
);
-- A contact in two matching rules still gets ONE message per alert and stage.
CREATE UNIQUE INDEX IF NOT EXISTS alert_notification_once_uq
  ON alert_notification (alert_id, destination, channel, stage) WHERE alert_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS alert_notification_due_idx
  ON alert_notification (next_attempt_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS alert_notification_recent_idx
  ON alert_notification (org_id, destination, channel, created_at DESC);

-- ─────────────────────────────────────────────── row-level security for new tables
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification_channel','alert_contact','alert_rule','alert_notification']
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
