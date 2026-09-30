-- 038: ISO 15118-20 charging needs and bidirectional charging (V2G / V2B) over OCPP 2.1.
--
--   ev_charging_needs      what the car told the charger (NotifyEVChargingNeeds, ISO 15118):
--                          energy transfer modes it can use (incl. bidirectional DC_BPT /
--                          AC_BPT), control mode, departure time, energy request, SoC and
--                          charge / discharge power; and the schedule it proposed
--                          (NotifyEVChargingSchedule)
--   site.v2x_*             the operator's bidirectional programme per site: when cars may
--                          give energy back, how much, whether any may flow to the grid,
--                          the battery floor, and the driver's credit per kWh
--   charging_session       energy given back (export register), last SoC, the driver's
--                          consent and floor, the credit rate agreed, and whether the car
--                          is being asked to discharge now
--   fleet_account.v2x_*    a fleet's standing consent for its cards
--   charge_point.external_limit  a limit set on the station by something other than
--                          PlugSure (NotifyChargingLimit: an energy management system, the grid)
--
-- Additive; nothing discharges until an operator enables a site and a driver or fleet consents.

CREATE TABLE IF NOT EXISTS ev_charging_needs (
  id                      BIGSERIAL PRIMARY KEY,
  org_id                  UUID NOT NULL REFERENCES organisation(id),
  charge_point_id         UUID NOT NULL REFERENCES charge_point(id) ON DELETE CASCADE,
  evse_id                 INT NOT NULL,
  session_id              UUID REFERENCES charging_session(id) ON DELETE SET NULL,
  received_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  requested_transfer      TEXT NOT NULL,
  available_transfer      TEXT[] NOT NULL DEFAULT '{}',
  bidirectional           BOOLEAN NOT NULL DEFAULT false,
  control_mode            TEXT,
  departure_time          TIMESTAMPTZ,
  energy_request_wh       INT,
  soc_percent             NUMERIC(5,2),
  target_soc_percent      NUMERIC(5,2),
  ev_capacity_wh          INT,
  max_charge_power_w      INT,
  max_discharge_power_w   INT,
  min_v2x_energy_wh       INT,
  raw                     JSONB NOT NULL,
  ev_schedule             JSONB,
  ev_schedule_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ev_charging_needs_session_idx ON ev_charging_needs (session_id, received_at DESC);
CREATE INDEX IF NOT EXISTS ev_charging_needs_evse_idx ON ev_charging_needs (charge_point_id, evse_id, received_at DESC);

ALTER TABLE site
  ADD COLUMN IF NOT EXISTS v2x_enabled             BOOLEAN NOT NULL DEFAULT false,
  -- [{"from":"17:00","to":"22:00"}] in the site's local time; to < from wraps midnight.
  ADD COLUMN IF NOT EXISTS v2x_windows             JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS v2x_max_discharge_w     INT CHECK (v2x_max_discharge_w IS NULL OR v2x_max_discharge_w > 0),
  -- false: discharge only up to the site's own (auxiliary) load, so nothing flows back to PLN.
  ADD COLUMN IF NOT EXISTS v2x_allow_export        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS v2x_min_soc_percent     INT NOT NULL DEFAULT 40 CHECK (v2x_min_soc_percent BETWEEN 10 AND 95),
  ADD COLUMN IF NOT EXISTS v2x_credit_idr_per_kwh  INT NOT NULL DEFAULT 0 CHECK (v2x_credit_idr_per_kwh BETWEEN 0 AND 20000);

ALTER TABLE charging_session
  ADD COLUMN IF NOT EXISTS export_start_wh         BIGINT,
  ADD COLUMN IF NOT EXISTS energy_export_wh        BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS soc_percent             NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS soc_at                  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS v2x_consent             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS v2x_consent_source      TEXT CHECK (v2x_consent_source IN ('driver', 'fleet')),
  ADD COLUMN IF NOT EXISTS v2x_min_soc_percent     INT,
  ADD COLUMN IF NOT EXISTS v2x_credit_idr_per_kwh  INT,
  ADD COLUMN IF NOT EXISTS v2x_discharging         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS v2x_discharge_w         INT,
  ADD COLUMN IF NOT EXISTS v2x_stop_reason         TEXT,
  ADD COLUMN IF NOT EXISTS operation_mode          TEXT;

ALTER TABLE fleet_account
  ADD COLUMN IF NOT EXISTS v2x_allowed             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS v2x_min_soc_percent     INT NOT NULL DEFAULT 50 CHECK (v2x_min_soc_percent BETWEEN 10 AND 95);

ALTER TABLE charge_point
  ADD COLUMN IF NOT EXISTS external_limit          JSONB;

ALTER TABLE ev_charging_needs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ev_charging_needs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ev_charging_needs_tenant ON ev_charging_needs;
CREATE POLICY ev_charging_needs_tenant ON ev_charging_needs
  USING (app_current_org() IS NULL OR org_id = app_current_org())
  WITH CHECK (app_current_org() IS NULL OR org_id = app_current_org());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
