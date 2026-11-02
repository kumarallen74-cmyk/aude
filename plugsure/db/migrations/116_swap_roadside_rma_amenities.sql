-- v1.49.0 (phase 37): two-wheeler battery swap, mobile and roadside charging, warranty and RMA, accessibility and
-- site amenities. Additive.
--
--   swap_settings, swap_cabinet, swap_battery, swap_plan, swap_subscription, swap_event     battery swap
--   roadside_settings, roadside_van, roadside_request                                       mobile and roadside charging
--   charger_warranty, rma_case                                                              warranty and RMA
--   site_amenity, accessibility_report                                                      accessibility and amenities

-- ─────────────────────────────────────────────── battery swap
CREATE TABLE IF NOT EXISTS swap_settings (
  org_id            UUID PRIMARY KEY REFERENCES organisation(id),
  enabled           BOOLEAN NOT NULL DEFAULT false,
  currency          TEXT NOT NULL,
  price_per_swap_minor BIGINT NOT NULL DEFAULT 0 CHECK (price_per_swap_minor >= 0),   -- without a plan, or beyond it
  min_soc_out       INTEGER NOT NULL DEFAULT 90 CHECK (min_soc_out BETWEEN 50 AND 100),  -- a pack is ready at this charge
  retire_soh        INTEGER NOT NULL DEFAULT 70 CHECK (retire_soh BETWEEN 40 AND 95),     -- below it a pack is flagged to retire
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS swap_cabinet (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  site_id       UUID NOT NULL REFERENCES site(id),
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  slots         INTEGER NOT NULL CHECK (slots BETWEEN 1 AND 60),
  key_hash      TEXT UNIQUE,        -- the cabinet posts swaps and slot status with this key
  key_prefix    TEXT,
  last_seen_at  TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'archived')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

CREATE TABLE IF NOT EXISTS swap_battery (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  serial        TEXT NOT NULL,
  model         TEXT,
  capacity_wh   INTEGER,
  -- in_cabinet (charging or ready), with_rider, maintenance, retired
  status        TEXT NOT NULL DEFAULT 'in_cabinet' CHECK (status IN ('in_cabinet', 'with_rider', 'maintenance', 'retired')),
  cabinet_id    BIGINT REFERENCES swap_cabinet(id),
  slot          INTEGER,
  rider_id      UUID REFERENCES app_driver(id),
  soc           NUMERIC(5, 1),
  soh           NUMERIC(5, 1),
  temp_c        NUMERIC(5, 1),
  cycles        INTEGER NOT NULL DEFAULT 0,
  fault         TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, serial)
);

CREATE TABLE IF NOT EXISTS swap_plan (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  name          TEXT NOT NULL,
  monthly_minor BIGINT NOT NULL CHECK (monthly_minor >= 0),
  swaps_included INTEGER,            -- null: unlimited
  currency      TEXT NOT NULL,
  archived_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS swap_subscription (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  app_driver_id UUID NOT NULL REFERENCES app_driver(id),
  plan_id       BIGINT NOT NULL REFERENCES swap_plan(id),
  rider_code    TEXT NOT NULL UNIQUE,      -- shown in the app as a QR code; the cabinet reads it
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'lapsed', 'cancelled')),
  paid_minor    BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS swap_subscription_one_idx ON swap_subscription (org_id, app_driver_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS swap_event (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  cabinet_id    BIGINT NOT NULL REFERENCES swap_cabinet(id),
  app_driver_id UUID REFERENCES app_driver(id),
  subscription_id BIGINT REFERENCES swap_subscription(id),
  reference     TEXT NOT NULL,              -- the cabinet's own id (idempotent)
  battery_in_id  BIGINT REFERENCES swap_battery(id),
  battery_out_id BIGINT REFERENCES swap_battery(id),
  soc_in        NUMERIC(5, 1),
  soc_out       NUMERIC(5, 1),
  kwh           NUMERIC(10, 3),              -- the energy the rider takes (from the charge levels)
  -- included (in the plan), paid (from credit), refused
  outcome       TEXT NOT NULL CHECK (outcome IN ('included', 'paid', 'refused')),
  amount_minor  BIGINT NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL,
  reason        TEXT,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cabinet_id, reference)
);
CREATE INDEX IF NOT EXISTS swap_event_org_idx ON swap_event (org_id, at DESC);

-- ─────────────────────────────────────────────── mobile and roadside charging
CREATE TABLE IF NOT EXISTS roadside_settings (
  org_id          UUID PRIMARY KEY REFERENCES organisation(id),
  enabled         BOOLEAN NOT NULL DEFAULT false,
  currency        TEXT NOT NULL,
  callout_minor   BIGINT NOT NULL DEFAULT 0 CHECK (callout_minor >= 0),
  per_kwh_minor   BIGINT NOT NULL DEFAULT 0 CHECK (per_kwh_minor >= 0),
  radius_km       INTEGER NOT NULL DEFAULT 30 CHECK (radius_km BETWEEN 1 AND 300),
  max_kwh         INTEGER NOT NULL DEFAULT 20 CHECK (max_kwh BETWEEN 1 AND 200),
  phone           TEXT,                 -- the dispatch desk, shown to the driver
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roadside_van (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  name          TEXT NOT NULL,
  plate         TEXT,
  kwh_capacity  NUMERIC(8, 1) NOT NULL CHECK (kwh_capacity > 0),
  kw_output     NUMERIC(8, 1) NOT NULL CHECK (kw_output > 0),
  base_lat      DOUBLE PRECISION,
  base_lon      DOUBLE PRECISION,
  lat           DOUBLE PRECISION,
  lon           DOUBLE PRECISION,
  located_at    TIMESTAMPTZ,
  technician_id UUID REFERENCES app_user(id),
  status        TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'busy', 'off_duty', 'archived')),
  kwh_left      NUMERIC(8, 1),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roadside_request (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  number        TEXT NOT NULL,
  app_driver_id UUID REFERENCES app_driver(id),
  name          TEXT,
  phone         TEXT,
  lat           DOUBLE PRECISION NOT NULL,
  lon           DOUBLE PRECISION NOT NULL,
  address       TEXT,
  vehicle       TEXT,
  plate         TEXT,
  connector     TEXT,                 -- CCS2, Type 2, CHAdeMO, GB/T
  soc           INTEGER,
  kwh_requested NUMERIC(8, 1) NOT NULL,
  van_id        BIGINT REFERENCES roadside_van(id),
  -- requested → assigned → en_route → charging → done; cancelled
  status        TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'assigned', 'en_route', 'charging', 'done', 'cancelled')),
  eta_at        TIMESTAMPTZ,
  kwh_delivered NUMERIC(8, 2),
  quote_minor   BIGINT NOT NULL,
  amount_minor  BIGINT,
  credit_minor  BIGINT NOT NULL DEFAULT 0,  -- paid from the driver's credit
  collect_minor BIGINT NOT NULL DEFAULT 0,  -- left to collect on site
  collected_by  TEXT,                       -- cash, qris, card_terminal, invoice
  currency      TEXT NOT NULL,
  cancel_reason TEXT,
  note          TEXT,
  assigned_at   TIMESTAMPTZ,
  arrived_at    TIMESTAMPTZ,
  done_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE INDEX IF NOT EXISTS roadside_request_open_idx ON roadside_request (org_id, status) WHERE status NOT IN ('done', 'cancelled');

-- ─────────────────────────────────────────────── warranty and RMA
CREATE TABLE IF NOT EXISTS charger_warranty (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  charge_point_id  UUID NOT NULL REFERENCES charge_point(id),
  supplier_id      BIGINT REFERENCES supplier(id),
  starts_on        DATE NOT NULL,
  ends_on          DATE NOT NULL,
  covers           TEXT[] NOT NULL DEFAULT '{parts}',     -- parts, labour, shipping, on_site
  terms            TEXT,
  reference        TEXT,                                   -- the manufacturer's warranty or contract number
  extended         BOOLEAN NOT NULL DEFAULT false,
  expiry_alerted_at TIMESTAMPTZ,
  removed_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS charger_warranty_cp_idx ON charger_warranty (charge_point_id, ends_on DESC);

CREATE TABLE IF NOT EXISTS rma_case (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  number           TEXT NOT NULL,
  charge_point_id  UUID NOT NULL REFERENCES charge_point(id),
  supplier_id      BIGINT REFERENCES supplier(id),
  warranty_id      BIGINT REFERENCES charger_warranty(id),
  work_order_id    BIGINT REFERENCES work_order(id),
  part             TEXT NOT NULL,                        -- what is returned: the charger, a power module, a cable …
  part_serial      TEXT,
  fault            TEXT NOT NULL,
  -- open → requested (from the manufacturer) → approved → shipped (the faulty part) → replaced (the replacement
  -- received) → closed; or rejected
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'requested', 'approved', 'shipped', 'replaced', 'closed', 'rejected')),
  in_warranty      BOOLEAN NOT NULL,
  vendor_ref       TEXT,
  tracking_out     TEXT,
  tracking_back    TEXT,
  replacement_serial TEXT,
  cost_minor       BIGINT,                                -- charged by the manufacturer (out of warranty)
  currency         TEXT NOT NULL,
  outcome          TEXT,
  history          JSONB NOT NULL DEFAULT '[]',
  status_since     TIMESTAMPTZ NOT NULL DEFAULT now(),
  stale_alerted_at TIMESTAMPTZ,
  created_by       UUID REFERENCES app_user(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);

-- ─────────────────────────────────────────────── accessibility and amenities
CREATE TABLE IF NOT EXISTS site_amenity (
  site_id          UUID PRIMARY KEY REFERENCES site(id),
  org_id           UUID NOT NULL REFERENCES organisation(id),
  amenities        TEXT[] NOT NULL DEFAULT '{}',     -- see services/amenities.ts AMENITIES
  accessible_bays  INTEGER NOT NULL DEFAULT 0 CHECK (accessible_bays BETWEEN 0 AND 50),
  step_free        BOOLEAN,
  bay_width_m      NUMERIC(4, 2),
  cable_reach_m    NUMERIC(4, 2),
  max_screen_height_cm INTEGER,
  open_24h         BOOLEAN,
  hours            TEXT,
  notes            TEXT,
  verified_at      DATE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accessibility_report (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  site_id         UUID NOT NULL REFERENCES site(id),
  app_driver_id   UUID REFERENCES app_driver(id),
  -- blocked_bay, no_step_free, cable_short, screen_high, amenity_wrong, other
  kind            TEXT NOT NULL,
  details         TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution      TEXT,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS accessibility_report_site_idx ON accessibility_report (org_id, status, created_at DESC);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['swap_settings', 'swap_cabinet', 'swap_battery', 'swap_plan', 'swap_subscription', 'swap_event', 'roadside_settings', 'roadside_van',
                           'roadside_request', 'charger_warranty', 'rma_case', 'site_amenity', 'accessibility_report'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON swap_settings, swap_cabinet, swap_battery, swap_plan, swap_subscription, swap_event, roadside_settings, roadside_van,
                                    roadside_request, charger_warranty, rma_case, site_amenity, accessibility_report TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON swap_settings, swap_cabinet, swap_battery, swap_plan, swap_subscription, swap_event, roadside_settings, roadside_van,
                               roadside_request, charger_warranty, rma_case, site_amenity, accessibility_report FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE swap_cabinet_id_seq, swap_battery_id_seq, swap_plan_id_seq, swap_subscription_id_seq, swap_event_id_seq, roadside_van_id_seq,
                                    roadside_request_id_seq, charger_warranty_id_seq, rma_case_id_seq, accessibility_report_id_seq TO plugsure_app;
  END IF;
END $$;
