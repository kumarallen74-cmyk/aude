-- 110 (v1.43.0) phase 31: SCIM user provisioning, dynamic pricing, grid demand response, the public status page.
--
--   scim_config            an organisation's SCIM 2.0 endpoint: on/off, the hashed bearer token its identity provider
--                          uses, and the group → role map (falls back to the SAML one)
--   scim_user              which console user an identity provider created or took over (its externalId, userName)
--   scim_group             a group the identity provider pushed; its members decide a provisioned user's role
--   scim_group_member      who is in which group
--   dynamic_price_settings per organisation: dynamic pricing on/off and the band every price stays inside (floor, cap)
--   dynamic_price_rule     a rule: at these times / in the grid's peak hours / when the site is this busy / when this
--                          much solar is spare, prices move by this many percent (one site or all)
--   site_price_now         each site's price factor now, with the rules behind it (what drivers are shown, and what a
--                          session starting now is fixed at)
--   charging_session       gains dynamic_price_bps and dynamic_price_reason: the factor fixed when the session started
--   payment_intent         gains dynamic_price_bps: the factor a pre-purchase's energy allowance was computed with
--   dr_program             a demand-response programme: a webhook the grid operator or aggregator posts events to, or
--                          an OpenADR 3 server PlugSure polls; its sites and the incentive per kWh
--   dr_event               an event: when, which sites, the grid limit (kW) or the reduction (%), its state
--   dr_event_site          per event and site, what the load manager measured: the power the chargers would have
--                          drawn and what they drew, integrated over the event
--   status_page            an organisation's public status page: on/off, its address (slug), title, the sites shown
--   status_incident        an incident or a planned maintenance window, with its updates
--   status_subscriber      e-mail subscribers (confirmed by link; one-click unsubscribe)
--
-- Additive. Rollback: db/rollback/110_down.sql.

CREATE TABLE IF NOT EXISTS scim_config (
  org_id        UUID PRIMARY KEY REFERENCES organisation(id),
  enabled       BOOLEAN NOT NULL DEFAULT false,
  token_hash    TEXT,
  token_hint    TEXT,
  role_map      JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_used_at  TIMESTAMPTZ,
  updated_by    UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scim_user (
  user_id       UUID PRIMARY KEY REFERENCES app_user(id),
  org_id        UUID NOT NULL REFERENCES organisation(id),
  external_id   TEXT,
  user_name     TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scim_user_org_idx ON scim_user (org_id, lower(user_name));

CREATE TABLE IF NOT EXISTS scim_group (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organisation(id),
  display_name  TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 300),
  external_id   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS scim_group_name_idx ON scim_group (org_id, lower(display_name));

CREATE TABLE IF NOT EXISTS scim_group_member (
  group_id      UUID NOT NULL REFERENCES scim_group(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES app_user(id),
  org_id        UUID NOT NULL REFERENCES organisation(id),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS scim_group_member_user_idx ON scim_group_member (user_id);

CREATE TABLE IF NOT EXISTS dynamic_price_settings (
  org_id        UUID PRIMARY KEY REFERENCES organisation(id),
  enabled       BOOLEAN NOT NULL DEFAULT false,
  floor_pct     INTEGER NOT NULL DEFAULT 80 CHECK (floor_pct BETWEEN 50 AND 100),
  cap_pct       INTEGER NOT NULL DEFAULT 130 CHECK (cap_pct BETWEEN 100 AND 200),
  include_time  BOOLEAN NOT NULL DEFAULT true,
  updated_by    UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dynamic_price_rule (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  site_id       UUID REFERENCES site(id),
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  kind          TEXT NOT NULL CHECK (kind IN ('time', 'peak', 'occupancy', 'solar')),
  day_mask      INTEGER NOT NULL DEFAULT 127 CHECK (day_mask BETWEEN 1 AND 127),
  hour_from     INTEGER CHECK (hour_from BETWEEN 0 AND 23),
  hour_to       INTEGER CHECK (hour_to BETWEEN 1 AND 24),
  threshold     NUMERIC(10,2),
  adjust_pct    INTEGER NOT NULL CHECK (adjust_pct BETWEEN -50 AND 50 AND adjust_pct <> 0),
  enabled       BOOLEAN NOT NULL DEFAULT true,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS dynamic_price_rule_org_idx ON dynamic_price_rule (org_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS site_price_now (
  site_id       UUID PRIMARY KEY REFERENCES site(id),
  org_id        UUID NOT NULL REFERENCES organisation(id),
  factor_bps    INTEGER NOT NULL CHECK (factor_bps BETWEEN 5000 AND 20000),
  rules         JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason        TEXT,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until   TIMESTAMPTZ NOT NULL
);

ALTER TABLE charging_session ADD COLUMN IF NOT EXISTS dynamic_price_bps INTEGER CHECK (dynamic_price_bps IS NULL OR dynamic_price_bps BETWEEN 5000 AND 20000);
ALTER TABLE charging_session ADD COLUMN IF NOT EXISTS dynamic_price_reason TEXT;
ALTER TABLE payment_intent ADD COLUMN IF NOT EXISTS dynamic_price_bps INTEGER CHECK (dynamic_price_bps IS NULL OR dynamic_price_bps BETWEEN 5000 AND 20000);

CREATE TABLE IF NOT EXISTS dr_program (
  id                      BIGSERIAL PRIMARY KEY,
  org_id                  UUID NOT NULL REFERENCES organisation(id),
  name                    TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  kind                    TEXT NOT NULL CHECK (kind IN ('webhook', 'openadr3')),
  enabled                 BOOLEAN NOT NULL DEFAULT true,
  site_ids                UUID[] NOT NULL DEFAULT '{}',
  token_hash              TEXT,
  token_hint              TEXT,
  vtn_url                 TEXT,
  program_ref             TEXT,
  client_id               TEXT,
  client_secret           TEXT,
  token_url               TEXT,
  incentive_minor_per_kwh BIGINT CHECK (incentive_minor_per_kwh IS NULL OR incentive_minor_per_kwh >= 0),
  currency                TEXT NOT NULL DEFAULT 'IDR',
  last_poll_at            TIMESTAMPTZ,
  last_error              TEXT,
  created_by              UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at             TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS dr_event (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  program_id    BIGINT NOT NULL REFERENCES dr_program(id),
  ext_id        TEXT NOT NULL,
  site_ids      UUID[] NOT NULL,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL CHECK (ends_at > starts_at),
  limit_kw      NUMERIC(10,2) CHECK (limit_kw IS NULL OR limit_kw >= 0),
  reduce_pct    INTEGER CHECK (reduce_pct IS NULL OR reduce_pct BETWEEN 1 AND 100),
  status        TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'opted_out')),
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  opted_out_by  UUID,
  note          TEXT,
  CHECK (limit_kw IS NOT NULL OR reduce_pct IS NOT NULL),
  UNIQUE (program_id, ext_id)
);
CREATE INDEX IF NOT EXISTS dr_event_window_idx ON dr_event (starts_at, ends_at) WHERE status = 'scheduled';

CREATE TABLE IF NOT EXISTS dr_event_site (
  event_id        BIGINT NOT NULL REFERENCES dr_event(id),
  site_id         UUID NOT NULL REFERENCES site(id),
  org_id          UUID NOT NULL REFERENCES organisation(id),
  baseline_wh     NUMERIC(16,3) NOT NULL DEFAULT 0,
  actual_wh       NUMERIC(16,3) NOT NULL DEFAULT 0,
  limit_w         INTEGER,
  samples         INTEGER NOT NULL DEFAULT 0,
  last_sample_at  TIMESTAMPTZ,
  PRIMARY KEY (event_id, site_id)
);

CREATE TABLE IF NOT EXISTS status_page (
  org_id        UUID PRIMARY KEY REFERENCES organisation(id),
  enabled       BOOLEAN NOT NULL DEFAULT false,
  slug          TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  title         TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  intro         TEXT CHECK (intro IS NULL OR length(intro) <= 1000),
  site_ids      UUID[],
  show_counts   BOOLEAN NOT NULL DEFAULT true,
  updated_by    UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS status_page_slug_idx ON status_page (slug);

CREATE TABLE IF NOT EXISTS status_incident (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  kind            TEXT NOT NULL CHECK (kind IN ('incident', 'maintenance')),
  title           TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  impact          TEXT NOT NULL DEFAULT 'minor' CHECK (impact IN ('minor', 'major', 'critical')),
  status          TEXT NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  site_ids        UUID[] NOT NULL DEFAULT '{}',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  scheduled_from  TIMESTAMPTZ,
  scheduled_to    TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  updates         JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by      UUID,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind = 'incident' OR (scheduled_from IS NOT NULL AND scheduled_to IS NOT NULL AND scheduled_to > scheduled_from))
);
CREATE INDEX IF NOT EXISTS status_incident_org_idx ON status_incident (org_id, started_at DESC);

CREATE TABLE IF NOT EXISTS status_subscriber (
  id                 BIGSERIAL PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organisation(id),
  email              TEXT NOT NULL,
  confirm_hash       TEXT,
  unsubscribe_hash   TEXT NOT NULL,
  confirmed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS status_subscriber_email_idx ON status_subscriber (org_id, lower(email));

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['scim_config', 'scim_user', 'scim_group', 'scim_group_member', 'dynamic_price_settings', 'dynamic_price_rule',
                           'site_price_now', 'dr_program', 'dr_event', 'dr_event_site', 'status_page', 'status_incident', 'status_subscriber'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON scim_config, scim_user, dynamic_price_settings, dynamic_price_rule, site_price_now,
      dr_program, dr_event, dr_event_site, status_page, status_incident TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON scim_config, scim_user, dynamic_price_settings, dynamic_price_rule, site_price_now,
      dr_program, dr_event, dr_event_site, status_page, status_incident FROM plugsure_app;
    -- Groups and their members are the identity provider's: it may delete them (SCIM DELETE /Groups, PATCH remove).
    GRANT SELECT, INSERT, UPDATE, DELETE ON scim_group, scim_group_member TO plugsure_app;
    -- A subscriber who unsubscribes is removed.
    GRANT SELECT, INSERT, UPDATE, DELETE ON status_subscriber TO plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE dynamic_price_rule_id_seq, dr_program_id_seq, dr_event_id_seq, status_incident_id_seq, status_subscriber_id_seq TO plugsure_app;
  END IF;
END $$;
