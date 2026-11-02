-- v1.46.0 (phase 34): the technician field app, residential and workplace charging, number-plate cameras and parking.
-- (The trip planner needs no tables.) Additive.
--
--   work_order.* (field), field_template, work_order_photo, field_op         the field app
--   private_group, private_group_charger, private_unit, private_member,
--   private_statement                                                       residential and workplace charging
--   anpr_camera, plate_event, parking_visit, site.parking_*                 cameras and parking

-- ─────────────────────────────────────────────── the field app
CREATE TABLE IF NOT EXISTS field_template (
  id                 BIGSERIAL PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organisation(id),
  name               TEXT NOT NULL,
  kind               TEXT CHECK (kind IS NULL OR kind IN ('corrective', 'preventive', 'warranty')),
  -- [{id, label, required}]
  items              JSONB NOT NULL DEFAULT '[]'::jsonb,
  require_signature  BOOLEAN NOT NULL DEFAULT false,
  require_photo      BOOLEAN NOT NULL DEFAULT false,
  archived_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE work_order ADD COLUMN IF NOT EXISTS assignee_id UUID;
ALTER TABLE work_order ADD COLUMN IF NOT EXISTS scheduled_for DATE;
ALTER TABLE work_order ADD COLUMN IF NOT EXISTS template_id BIGINT REFERENCES field_template(id);
-- [{id, label, required, done, note, at}]
ALTER TABLE work_order ADD COLUMN IF NOT EXISTS checklist JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE work_order ADD COLUMN IF NOT EXISTS field_notes TEXT;
ALTER TABLE work_order ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ;
ALTER TABLE work_order ADD COLUMN IF NOT EXISTS signature_name TEXT;
ALTER TABLE work_order ADD COLUMN IF NOT EXISTS signature_path TEXT;
ALTER TABLE work_order ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS work_order_assignee_idx ON work_order (org_id, assignee_id, status);

CREATE TABLE IF NOT EXISTS work_order_photo (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  work_order_id   BIGINT NOT NULL REFERENCES work_order(id),
  path            TEXT NOT NULL,
  sha256          TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  mime            TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  caption         TEXT,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (work_order_id, sha256)
);

-- Changes made offline carry the app's own id: replayed once only.
CREATE TABLE IF NOT EXISTS field_op (
  org_id      UUID NOT NULL REFERENCES organisation(id),
  op_id       TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, op_id)
);

-- ─────────────────────────────────────────────── residential and workplace charging
CREATE TABLE IF NOT EXISTS private_group (
  id                   BIGSERIAL PRIMARY KEY,
  org_id               UUID NOT NULL REFERENCES organisation(id),
  site_id              UUID NOT NULL REFERENCES site(id),
  name                 TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('residential', 'workplace')),
  -- per_unit: each unit (apartment) billed; cost_centre: each team's cost centre; none: free to members.
  billing              TEXT NOT NULL DEFAULT 'per_unit' CHECK (billing IN ('per_unit', 'cost_centre', 'none')),
  rate_minor           BIGINT CHECK (rate_minor IS NULL OR rate_minor >= 0),
  monthly_fee_minor    BIGINT NOT NULL DEFAULT 0 CHECK (monthly_fee_minor >= 0),
  currency             TEXT NOT NULL,
  manager_name         TEXT,
  manager_email        TEXT,
  portal_token_hash    TEXT UNIQUE,
  portal_token_prefix  TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at          TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS private_group_charger (
  charge_point_id  UUID PRIMARY KEY REFERENCES charge_point(id),
  group_id         BIGINT NOT NULL REFERENCES private_group(id),
  org_id           UUID NOT NULL REFERENCES organisation(id)
);

CREATE TABLE IF NOT EXISTS private_unit (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organisation(id),
  group_id       BIGINT NOT NULL REFERENCES private_group(id),
  code           TEXT NOT NULL,
  name           TEXT,
  billing_email  TEXT,
  archived_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS private_unit_code_uq ON private_unit (group_id, upper(code)) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS private_member (
  id           BIGSERIAL PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES organisation(id),
  unit_id      BIGINT NOT NULL REFERENCES private_unit(id),
  name         TEXT NOT NULL,
  token_id     UUID REFERENCES token(id),
  plate        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS private_member_token_uq ON private_member (token_id) WHERE token_id IS NOT NULL AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS private_statement (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organisation(id),
  group_id       BIGINT NOT NULL REFERENCES private_group(id),
  unit_id        BIGINT NOT NULL REFERENCES private_unit(id),
  month          TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  sessions       INTEGER NOT NULL DEFAULT 0,
  kwh            NUMERIC(12,3) NOT NULL DEFAULT 0,
  energy_minor   BIGINT NOT NULL DEFAULT 0,
  fee_minor      BIGINT NOT NULL DEFAULT 0,
  amount_minor   BIGINT NOT NULL DEFAULT 0,
  currency       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'paid', 'void')),
  issued_at      TIMESTAMPTZ,
  paid_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (unit_id, month)
);

-- ─────────────────────────────────────────────── number-plate cameras and parking
ALTER TABLE site ADD COLUMN IF NOT EXISTS parking_grace_minutes INTEGER CHECK (parking_grace_minutes IS NULL OR parking_grace_minutes BETWEEN 0 AND 1440);
ALTER TABLE site ADD COLUMN IF NOT EXISTS parking_fee_per_hour_minor BIGINT CHECK (parking_fee_per_hour_minor IS NULL OR parking_fee_per_hour_minor >= 0);
ALTER TABLE site ADD COLUMN IF NOT EXISTS parking_max_minutes INTEGER CHECK (parking_max_minutes IS NULL OR parking_max_minutes BETWEEN 10 AND 10080);
ALTER TABLE site ADD COLUMN IF NOT EXISTS plate_autostart BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS anpr_camera (
  id                BIGSERIAL PRIMARY KEY,
  org_id            UUID NOT NULL REFERENCES organisation(id),
  site_id           UUID NOT NULL REFERENCES site(id),
  name              TEXT NOT NULL,
  direction         TEXT NOT NULL DEFAULT 'both' CHECK (direction IN ('entry', 'exit', 'both')),
  key_hash          TEXT UNIQUE,
  key_prefix        TEXT,
  -- Who the gate opens for: nobody (no gate), known plates (fleet vehicles, residents, staff), everyone.
  gate_policy       TEXT NOT NULL DEFAULT 'none' CHECK (gate_policy IN ('none', 'known', 'everyone')),
  gate_url          TEXT,
  gate_auth_sealed  TEXT,
  enabled           BOOLEAN NOT NULL DEFAULT true,
  last_seen_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS parking_visit (
  id                  BIGSERIAL PRIMARY KEY,
  org_id              UUID NOT NULL REFERENCES organisation(id),
  site_id             UUID NOT NULL REFERENCES site(id),
  plate               TEXT NOT NULL,
  entered_at          TIMESTAMPTZ NOT NULL,
  exited_at           TIMESTAMPTZ,
  vehicle_id          BIGINT REFERENCES fleet_vehicle(id),
  member_id           BIGINT REFERENCES private_member(id),
  token_id            UUID REFERENCES token(id),
  autostart_session_id UUID REFERENCES charging_session(id),
  charged_wh          BIGINT NOT NULL DEFAULT 0,
  charging_minutes    INTEGER NOT NULL DEFAULT 0,
  overstay_minutes    INTEGER NOT NULL DEFAULT 0,
  fee_minor           BIGINT NOT NULL DEFAULT 0,
  currency            TEXT,
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'paid', 'waived')),
  alerted_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS parking_visit_open_idx ON parking_visit (site_id, plate) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS plate_event (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  site_id         UUID NOT NULL REFERENCES site(id),
  camera_id       BIGINT NOT NULL REFERENCES anpr_camera(id),
  plate           TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('entry', 'exit')),
  confidence      NUMERIC(5,2),
  seen_at         TIMESTAMPTZ NOT NULL,
  matched         TEXT NOT NULL DEFAULT 'none' CHECK (matched IN ('vehicle', 'member', 'none')),
  visit_id        BIGINT REFERENCES parking_visit(id),
  gate_opened     BOOLEAN,
  gate_error      TEXT,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plate_event_site_idx ON plate_event (site_id, seen_at DESC);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['field_template', 'work_order_photo', 'field_op', 'private_group', 'private_group_charger', 'private_unit', 'private_member', 'private_statement',
                           'anpr_camera', 'parking_visit', 'plate_event'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON field_template, work_order_photo, field_op, private_group, private_unit, private_member, private_statement, anpr_camera, parking_visit, plate_event TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON field_template, work_order_photo, field_op, private_group, private_unit, private_member, private_statement, anpr_camera, parking_visit, plate_event FROM plugsure_app;
    -- A charger leaves a group by its row going.
    GRANT SELECT, INSERT, UPDATE, DELETE ON private_group_charger TO plugsure_app;
    REVOKE TRUNCATE ON private_group_charger FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE field_template_id_seq, work_order_photo_id_seq, private_group_id_seq, private_unit_id_seq, private_member_id_seq, private_statement_id_seq,
                                    anpr_camera_id_seq, parking_visit_id_seq, plate_event_id_seq TO plugsure_app;
  END IF;
END $$;
