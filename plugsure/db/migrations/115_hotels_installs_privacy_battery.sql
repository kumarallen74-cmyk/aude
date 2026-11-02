-- v1.48.0 (phase 36): hotels and hospitality, the installation pipeline, data privacy (UU PDP), EV battery health.
-- Additive.
--
--   hotel_property, hotel_stay, hotel_charge                                  hotels: room charging, valet
--   install_project, install_task, install_document, install_stage_event      the installation pipeline
--   privacy_settings, privacy_request, privacy_consent                        data privacy
--   vehicle_battery_estimate                                                  EV battery health

-- ─────────────────────────────────────────────── hotels
CREATE TABLE IF NOT EXISTS hotel_property (
  id                BIGSERIAL PRIMARY KEY,
  org_id            UUID NOT NULL REFERENCES organisation(id),
  site_id           UUID NOT NULL REFERENCES site(id),
  name              TEXT NOT NULL,
  -- pms: each charge is posted to the guest's folio at the hotel's PMS (its address); statement: the hotel is billed monthly
  posting           TEXT NOT NULL CHECK (posting IN ('pms', 'statement')),
  pms_url           TEXT,
  pms_secret_sealed TEXT,
  pms_key_hash      TEXT UNIQUE,      -- the PMS posts check-ins and check-outs with this key
  pms_key_prefix    TEXT,
  valet_token_hash  TEXT UNIQUE,      -- the valet page's secret link
  valet_token_prefix TEXT,
  currency          TEXT NOT NULL,
  archived_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hotel_stay (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  property_id   BIGINT NOT NULL REFERENCES hotel_property(id),
  room          TEXT NOT NULL,
  guest_name    TEXT NOT NULL,
  reservation_ref TEXT,
  arrival_on    DATE,
  departure_on  DATE,
  plate         TEXT,
  token_id      UUID REFERENCES token(id),   -- the stay's guest card (charging is started with it)
  status        TEXT NOT NULL DEFAULT 'in_house' CHECK (status IN ('in_house', 'checked_out')),
  checked_out_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hotel_stay_room_idx ON hotel_stay (property_id, room) WHERE status = 'in_house';

CREATE TABLE IF NOT EXISTS hotel_charge (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  property_id   BIGINT NOT NULL REFERENCES hotel_property(id),
  stay_id       BIGINT NOT NULL REFERENCES hotel_stay(id),
  session_id    UUID NOT NULL UNIQUE,
  started_by    TEXT,                          -- valet, console
  kwh           NUMERIC(12, 3),
  amount_minor  BIGINT,
  currency      TEXT NOT NULL,
  -- charging; posted (to the folio) / on_statement; post_failed (retried); void
  status        TEXT NOT NULL DEFAULT 'charging' CHECK (status IN ('charging', 'posted', 'on_statement', 'post_failed', 'void')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  posted_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────── the installation pipeline
CREATE TABLE IF NOT EXISTS install_project (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  number           TEXT NOT NULL,
  name             TEXT NOT NULL,
  address          TEXT,
  stage            TEXT NOT NULL DEFAULT 'survey' CHECK (stage IN ('survey', 'design', 'permit', 'grid', 'install', 'commission', 'live', 'cancelled')),
  site_id          UUID REFERENCES site(id),
  candidate_id     BIGINT,
  capex_project_id BIGINT REFERENCES capex_project(id),
  owner_id         UUID REFERENCES app_user(id),
  chargers_planned INTEGER,
  kw_planned       NUMERIC(10, 1),
  target_live_on   DATE,
  live_on          DATE,
  notes            TEXT,
  stage_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  overdue_alerted_on DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);

CREATE TABLE IF NOT EXISTS install_task (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organisation(id),
  project_id  BIGINT NOT NULL REFERENCES install_project(id),
  stage       TEXT NOT NULL,
  title       TEXT NOT NULL,
  required    BOOLEAN NOT NULL DEFAULT true,
  due_on      DATE,
  assignee_id UUID REFERENCES app_user(id),
  done_at     TIMESTAMPTZ,
  done_by     UUID,
  sort        INTEGER NOT NULL DEFAULT 0,
  removed_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS install_document (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organisation(id),
  project_id  BIGINT NOT NULL REFERENCES install_project(id),
  kind        TEXT NOT NULL CHECK (kind IN ('survey', 'drawing', 'permit', 'grid', 'photo', 'commissioning', 'contract', 'other')),
  name        TEXT NOT NULL,
  path        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  uploaded_by UUID,
  removed_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS install_stage_event (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organisation(id),
  project_id  BIGINT NOT NULL REFERENCES install_project(id),
  from_stage  TEXT,
  to_stage    TEXT NOT NULL,
  note        TEXT,
  user_id     UUID,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────── data privacy
CREATE TABLE IF NOT EXISTS privacy_settings (
  org_id                 UUID PRIMARY KEY REFERENCES organisation(id),
  dpo_name               TEXT,
  dpo_email              TEXT,
  response_hours         INTEGER NOT NULL DEFAULT 72 CHECK (response_hours BETWEEN 24 AND 2160),
  plate_retention_days   INTEGER CHECK (plate_retention_days IS NULL OR plate_retention_days BETWEEN 7 AND 3650),
  survey_comment_days    INTEGER CHECK (survey_comment_days IS NULL OR survey_comment_days BETWEEN 30 AND 3650),
  support_case_days      INTEGER CHECK (support_case_days IS NULL OR support_case_days BETWEEN 90 AND 3650),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS privacy_request (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  number          TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('access', 'export', 'correction', 'erasure', 'objection')),
  status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'verified', 'done', 'rejected')),
  channel         TEXT NOT NULL CHECK (channel IN ('app', 'email', 'console', 'other')),
  app_driver_id   UUID,
  subject_name    TEXT,
  subject_email   TEXT,
  subject_phone   TEXT,
  details         TEXT,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at          TIMESTAMPTZ NOT NULL,
  verified_at     TIMESTAMPTZ,
  verified_by     UUID,
  verification    TEXT,
  closed_at       TIMESTAMPTZ,
  closed_by       UUID,
  outcome         TEXT,
  result          JSONB,
  due_alerted_at  TIMESTAMPTZ,
  UNIQUE (org_id, number)
);

CREATE TABLE IF NOT EXISTS privacy_consent (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organisation(id),
  app_driver_id  UUID NOT NULL,
  purpose        TEXT NOT NULL CHECK (purpose IN ('marketing', 'analytics', 'location')),
  granted        BOOLEAN NOT NULL,
  source         TEXT NOT NULL,
  text_version   TEXT,
  at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS privacy_consent_driver_idx ON privacy_consent (app_driver_id, purpose, at DESC);

-- ─────────────────────────────────────────────── battery health
CREATE TABLE IF NOT EXISTS vehicle_battery_estimate (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  vehicle_id    BIGINT NOT NULL REFERENCES fleet_vehicle(id),
  session_id    UUID NOT NULL UNIQUE,
  at            TIMESTAMPTZ NOT NULL,
  soc_start     NUMERIC(5, 1),
  soc_end       NUMERIC(5, 1),
  soc_source    TEXT,                  -- meter (OCPP SoC) or telematics
  kwh           NUMERIC(10, 3),
  capacity_kwh  NUMERIC(10, 2),        -- estimated usable capacity (null when the session says too little)
  peak_kw       NUMERIC(8, 2),
  flags         TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicle_battery_estimate_vehicle_idx ON vehicle_battery_estimate (vehicle_id, at DESC);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['hotel_property', 'hotel_stay', 'hotel_charge', 'install_project', 'install_task', 'install_document', 'install_stage_event',
                           'privacy_settings', 'privacy_request', 'privacy_consent', 'vehicle_battery_estimate'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON hotel_property, hotel_stay, hotel_charge, install_project, install_task, install_document, install_stage_event,
                                    privacy_settings, privacy_request, privacy_consent, vehicle_battery_estimate TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON hotel_property, hotel_stay, hotel_charge, install_project, install_task, install_document, install_stage_event,
                               privacy_settings, privacy_request, privacy_consent, vehicle_battery_estimate FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE hotel_property_id_seq, hotel_stay_id_seq, hotel_charge_id_seq, install_project_id_seq, install_task_id_seq, install_document_id_seq,
                                    install_stage_event_id_seq, privacy_request_id_seq, privacy_consent_id_seq, vehicle_battery_estimate_id_seq TO plugsure_app;
  END IF;
END $$;
