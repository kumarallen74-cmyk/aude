-- 032: the OCPP 2.0.1 device model — what a station reports about itself.
--
--   device_variable   one row per component/variable the station reported (NotifyReport,
--                     GetVariables): its attributes (Actual, Target, MinSet, MaxSet, each
--                     with value and mutability) and characteristics (data type, unit,
--                     limits, allowed values).
--   device_monitor    the station's variable monitors (NotifyMonitoringReport, and those set
--                     from the console).
--   device_report     report requests (GetBaseReport, GetMonitoringReport) and how far the
--                     answer got, so the console can show "receiving…" and when it finished.
--
-- Nothing changes for 1.6 chargers. Additive.

CREATE TABLE IF NOT EXISTS device_variable (
  org_id              UUID NOT NULL REFERENCES organisation(id),
  charge_point_id     UUID NOT NULL REFERENCES charge_point(id) ON DELETE CASCADE,
  component           TEXT NOT NULL,
  component_instance  TEXT NOT NULL DEFAULT '',
  evse_id             INTEGER NOT NULL DEFAULT 0,       -- 0: the station itself
  connector_id        INTEGER NOT NULL DEFAULT 0,
  variable            TEXT NOT NULL,
  variable_instance   TEXT NOT NULL DEFAULT '',
  attributes          JSONB NOT NULL DEFAULT '[]',      -- [{ type, value, mutability, persistent, constant }]
  characteristics     JSONB,                            -- { dataType, unit, minLimit, maxLimit, valuesList, supportsMonitoring }
  reported_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (charge_point_id, component, component_instance, evse_id, connector_id, variable, variable_instance)
);

CREATE TABLE IF NOT EXISTS device_monitor (
  org_id              UUID NOT NULL REFERENCES organisation(id),
  charge_point_id     UUID NOT NULL REFERENCES charge_point(id) ON DELETE CASCADE,
  monitor_id          INTEGER NOT NULL,
  component           TEXT NOT NULL,
  component_instance  TEXT NOT NULL DEFAULT '',
  evse_id             INTEGER NOT NULL DEFAULT 0,
  connector_id        INTEGER NOT NULL DEFAULT 0,
  variable            TEXT NOT NULL,
  variable_instance   TEXT NOT NULL DEFAULT '',
  type                TEXT NOT NULL,                    -- UpperThreshold | LowerThreshold | Delta | Periodic | PeriodicClockAligned
  value               NUMERIC NOT NULL,
  severity            INTEGER NOT NULL CHECK (severity BETWEEN 0 AND 9),
  in_transaction      BOOLEAN NOT NULL DEFAULT false,   -- only while a transaction is ongoing
  kind                TEXT,                             -- HardWiredMonitor | PreconfiguredMonitor | CustomMonitor (when reported)
  reported_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (charge_point_id, monitor_id)
);

CREATE TABLE IF NOT EXISTS device_report (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organisation(id),
  charge_point_id   UUID NOT NULL REFERENCES charge_point(id) ON DELETE CASCADE,
  request_id        INTEGER NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('base', 'monitoring')),
  report_base       TEXT,                               -- FullInventory | ConfigurationInventory | SummaryInventory (base)
  status            TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'receiving', 'complete', 'rejected', 'empty')),
  items             INTEGER NOT NULL DEFAULT 0,
  requested_by      TEXT,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  note              TEXT,
  UNIQUE (charge_point_id, request_id)
);
CREATE INDEX IF NOT EXISTS device_report_cp_idx ON device_report (charge_point_id, requested_at DESC);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['device_variable','device_monitor','device_report']
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
