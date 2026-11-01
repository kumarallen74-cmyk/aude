-- 111 (v1.44.0) phase 32: fleet depot scheduling, queue improvements, carbon per session and site, the diagnostics bot.
--
--   fleet_vehicle            a fleet's vehicle: name/plate, battery, the card it charges with, its usual departure time
--                            and the charge it needs by then
--   session_departure        per charging session: when it must be ready and how much energy it needs; where that came
--                            from (the vehicle, the car over OCPP, the console); what the planner last worked out
--   site.depot_scheduling    the load manager plans this site's charging to meet departures (off: as before)
--   site.queue_priority      the queue's priority lane: none | fleet | members | fleet_members
--   driver_queue_entry.priority  this driver was in the priority lane when they joined
--   site.grid_kg_per_kwh     a site's own grid emission factor (overrides the province's and the default)
--   diagnostic_run           a diagnostics bot run on a charger: its steps, what it found, the summary, the work order
--
-- Additive. Rollback: db/rollback/111_down.sql.

CREATE TABLE IF NOT EXISTS fleet_vehicle (
  id                  BIGSERIAL PRIMARY KEY,
  org_id              UUID NOT NULL REFERENCES organisation(id),
  fleet_account_id    UUID REFERENCES fleet_account(id),
  name                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  plate               TEXT CHECK (plate IS NULL OR length(plate) <= 20),
  battery_kwh         NUMERIC(8,2) CHECK (battery_kwh IS NULL OR battery_kwh > 0),
  token_id            UUID REFERENCES token(id),
  departure_time      TEXT CHECK (departure_time IS NULL OR departure_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  target_soc_pct      INTEGER CHECK (target_soc_pct IS NULL OR target_soc_pct BETWEEN 10 AND 100),
  target_kwh          NUMERIC(8,2) CHECK (target_kwh IS NULL OR target_kwh > 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS fleet_vehicle_token_idx ON fleet_vehicle (token_id) WHERE token_id IS NOT NULL AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS session_departure (
  session_id        UUID PRIMARY KEY REFERENCES charging_session(id),
  org_id            UUID NOT NULL REFERENCES organisation(id),
  site_id           UUID NOT NULL REFERENCES site(id),
  vehicle_id        BIGINT REFERENCES fleet_vehicle(id),
  departure_at      TIMESTAMPTZ NOT NULL,
  needed_wh         INTEGER NOT NULL CHECK (needed_wh > 0),
  source            TEXT NOT NULL CHECK (source IN ('vehicle', 'ocpp', 'console')),
  plan_state        TEXT NOT NULL DEFAULT 'on_track' CHECK (plan_state IN ('on_track', 'deferred', 'at_risk', 'ready', 'missed')),
  required_w        INTEGER,
  eta_at            TIMESTAMPTZ,
  planned_at        TIMESTAMPTZ,
  alerted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_departure_site_idx ON session_departure (site_id, departure_at);

ALTER TABLE site ADD COLUMN IF NOT EXISTS depot_scheduling BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE site ADD COLUMN IF NOT EXISTS queue_priority TEXT NOT NULL DEFAULT 'none' CHECK (queue_priority IN ('none', 'fleet', 'members', 'fleet_members'));
ALTER TABLE site ADD COLUMN IF NOT EXISTS grid_kg_per_kwh NUMERIC(6,4) CHECK (grid_kg_per_kwh IS NULL OR grid_kg_per_kwh BETWEEN 0 AND 3);
ALTER TABLE driver_queue_entry ADD COLUMN IF NOT EXISTS priority BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS diagnostic_run (
  id                BIGSERIAL PRIMARY KEY,
  org_id            UUID NOT NULL REFERENCES organisation(id),
  charge_point_id   UUID NOT NULL REFERENCES charge_point(id),
  status            TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  allow_reset       BOOLEAN NOT NULL DEFAULT false,
  steps             JSONB NOT NULL DEFAULT '[]'::jsonb,
  findings          JSONB NOT NULL DEFAULT '[]'::jsonb,
  verdict           TEXT CHECK (verdict IS NULL OR verdict IN ('healthy', 'fixed', 'needs_visit', 'needs_attention', 'unreachable')),
  summary           TEXT,
  work_order_id     BIGINT REFERENCES work_order(id),
  started_by        UUID,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS diagnostic_run_cp_idx ON diagnostic_run (charge_point_id, started_at DESC);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['fleet_vehicle', 'session_departure', 'diagnostic_run'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON fleet_vehicle, session_departure, diagnostic_run TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON fleet_vehicle, session_departure, diagnostic_run FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE fleet_vehicle_id_seq, diagnostic_run_id_seq TO plugsure_app;
  END IF;
END $$;
