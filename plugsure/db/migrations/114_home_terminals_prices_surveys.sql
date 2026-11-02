-- v1.47.0 (phase 35): home charging reimbursement, card payment terminals, energy market prices, driver surveys. Additive.
--
--   home_charger, home_meter_reading, home_reimbursement                    home charging reimbursement
--   payment_terminal, terminal_txn, terminal_settlement_line                card payment terminals
--   energy_price_zone, energy_price, site.price_*                           energy market prices and price-aware charging
--   survey_settings, survey_response                                        driver surveys and NPS

-- ─────────────────────────────────────────────── home charging reimbursement
CREATE TABLE IF NOT EXISTS home_charger (
  id                  BIGSERIAL PRIMARY KEY,
  org_id              UUID NOT NULL REFERENCES organisation(id),
  employee_name       TEXT NOT NULL,
  employee_email      TEXT,
  employee_ref        TEXT,                      -- the payroll number
  address             TEXT,
  -- ocpp: an OCPP charger of the operator's (its sessions count); readings: the employee's meter readings
  mode                TEXT NOT NULL CHECK (mode IN ('ocpp', 'readings')),
  charge_point_id     UUID REFERENCES charge_point(id),
  token_id            UUID REFERENCES token(id), -- ocpp: only this card's sessions count (none: all)
  rate_minor_per_kwh  NUMERIC(14, 4) NOT NULL CHECK (rate_minor_per_kwh >= 0),
  monthly_cap_minor   BIGINT CHECK (monthly_cap_minor IS NULL OR monthly_cap_minor >= 0),
  currency            TEXT NOT NULL,
  portal_token_hash   TEXT UNIQUE,
  portal_token_prefix TEXT,
  archived_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS home_charger_cp_idx ON home_charger (charge_point_id) WHERE charge_point_id IS NOT NULL AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS home_meter_reading (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  home_charger_id BIGINT NOT NULL REFERENCES home_charger(id),
  read_on         DATE NOT NULL,
  kwh_total       NUMERIC(14, 3) NOT NULL CHECK (kwh_total >= 0),
  source          TEXT NOT NULL CHECK (source IN ('console', 'employee')),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (home_charger_id, read_on)
);

CREATE TABLE IF NOT EXISTS home_reimbursement (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  home_charger_id BIGINT NOT NULL REFERENCES home_charger(id),
  month           TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  kwh             NUMERIC(14, 3) NOT NULL,
  sessions        INTEGER,
  rate_minor_per_kwh NUMERIC(14, 4) NOT NULL,
  amount_minor    BIGINT NOT NULL,
  capped          BOOLEAN NOT NULL DEFAULT false,
  currency        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'paid', 'void')),
  approved_by     UUID,
  approved_at     TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (home_charger_id, month)
);

-- ─────────────────────────────────────────────── card payment terminals
CREATE TABLE IF NOT EXISTS payment_terminal (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  site_id          UUID NOT NULL REFERENCES site(id),
  charge_point_id  UUID REFERENCES charge_point(id),  -- none: a kiosk for the whole site (the driver picks the connector)
  name             TEXT NOT NULL,
  serial           TEXT,
  provider         TEXT NOT NULL DEFAULT 'generic',
  key_hash         TEXT UNIQUE,
  key_prefix       TEXT,
  callback_url     TEXT,                              -- capture and void instructions are POSTed here; none: the terminal polls
  callback_secret_sealed TEXT,
  max_preauth_minor BIGINT NOT NULL CHECK (max_preauth_minor > 0),
  currency         TEXT NOT NULL,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  last_seen_at     TIMESTAMPTZ,
  archived_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS terminal_txn (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  terminal_id      BIGINT NOT NULL REFERENCES payment_terminal(id),
  reference        TEXT NOT NULL,                     -- the terminal's own transaction reference
  connector_uuid   UUID REFERENCES connector(id),
  token_id         UUID REFERENCES token(id),         -- the single-use guest token that starts the session
  session_id       UUID,
  card_brand       TEXT,
  card_last4       TEXT,
  preauth_minor    BIGINT NOT NULL CHECK (preauth_minor > 0),
  amount_minor     BIGINT,                            -- what was (or is to be) captured
  currency         TEXT NOT NULL,
  -- preauth: held, waiting for the car; charging; capture_due / void_due: the instruction is waiting to be sent or
  -- polled; captured, voided; failed (the terminal could not capture)
  status           TEXT NOT NULL DEFAULT 'preauth' CHECK (status IN ('preauth', 'charging', 'capture_due', 'void_due', 'captured', 'voided', 'failed')),
  start_status     TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  receipt_token_hash TEXT UNIQUE,
  settled_minor    BIGINT,                            -- from the provider's settlement report
  settled_on       DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (terminal_id, reference)
);
CREATE INDEX IF NOT EXISTS terminal_txn_status_idx ON terminal_txn (status) WHERE status IN ('preauth', 'charging', 'capture_due', 'void_due');

CREATE TABLE IF NOT EXISTS terminal_settlement_line (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  batch         TEXT NOT NULL,
  reference     TEXT NOT NULL,
  amount_minor  BIGINT NOT NULL,
  settled_on    DATE,
  txn_id        BIGINT REFERENCES terminal_txn(id),
  status        TEXT NOT NULL CHECK (status IN ('matched', 'mismatch', 'unknown')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────── energy market prices
CREATE TABLE IF NOT EXISTS energy_price_zone (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  name          TEXT NOT NULL,
  currency      TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('manual', 'url')),
  url           TEXT,
  auth_sealed   TEXT,
  last_fetch_at TIMESTAMPTZ,
  last_error    TEXT,
  archived_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS energy_price (
  zone_id       BIGINT NOT NULL REFERENCES energy_price_zone(id),
  org_id        UUID NOT NULL REFERENCES organisation(id),
  starts_at     TIMESTAMPTZ NOT NULL,
  minutes       INTEGER NOT NULL DEFAULT 60 CHECK (minutes IN (15, 30, 60)),
  price_minor_per_kwh NUMERIC(14, 4) NOT NULL,
  PRIMARY KEY (zone_id, starts_at)
);

ALTER TABLE site ADD COLUMN IF NOT EXISTS price_zone_id BIGINT REFERENCES energy_price_zone(id);
ALTER TABLE site ADD COLUMN IF NOT EXISTS price_shift BOOLEAN NOT NULL DEFAULT false;
-- In an expensive period the site's grid budget falls to this share (sessions keep their minimum).
ALTER TABLE site ADD COLUMN IF NOT EXISTS price_cap_pct INTEGER NOT NULL DEFAULT 50 CHECK (price_cap_pct BETWEEN 0 AND 100);
-- Expensive: at or above this price; none: the day's most expensive quarter of periods.
ALTER TABLE site ADD COLUMN IF NOT EXISTS price_threshold_minor NUMERIC(14, 4);

-- ─────────────────────────────────────────────── driver surveys
CREATE TABLE IF NOT EXISTS survey_settings (
  org_id        UUID PRIMARY KEY REFERENCES organisation(id),
  enabled       BOOLEAN NOT NULL DEFAULT false,
  question      TEXT,
  sample_pct    INTEGER NOT NULL DEFAULT 100 CHECK (sample_pct BETWEEN 1 AND 100),
  min_gap_days  INTEGER NOT NULL DEFAULT 14 CHECK (min_gap_days BETWEEN 0 AND 365),
  case_on_low   BOOLEAN NOT NULL DEFAULT true,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS survey_response (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  driver_charge_id UUID NOT NULL UNIQUE,
  app_driver_id    UUID,
  device_id        UUID,
  site_id          UUID REFERENCES site(id),
  charge_point_id  UUID REFERENCES charge_point(id),
  score            INTEGER NOT NULL CHECK (score BETWEEN 0 AND 10),
  tags             TEXT[] NOT NULL DEFAULT '{}',
  comment          TEXT,
  case_id          BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS survey_response_org_idx ON survey_response (org_id, created_at DESC);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['home_charger', 'home_meter_reading', 'home_reimbursement', 'payment_terminal', 'terminal_txn', 'terminal_settlement_line',
                           'energy_price_zone', 'energy_price', 'survey_settings', 'survey_response'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON home_charger, home_meter_reading, home_reimbursement, payment_terminal, terminal_txn, terminal_settlement_line,
                                    energy_price_zone, survey_settings, survey_response TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON home_charger, home_meter_reading, home_reimbursement, payment_terminal, terminal_txn, terminal_settlement_line,
                               energy_price_zone, survey_settings, survey_response FROM plugsure_app;
    -- A zone's prices are replaced when they are imported again.
    GRANT SELECT, INSERT, UPDATE, DELETE ON energy_price TO plugsure_app;
    REVOKE TRUNCATE ON energy_price FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE home_charger_id_seq, home_meter_reading_id_seq, home_reimbursement_id_seq, payment_terminal_id_seq, terminal_txn_id_seq,
                                    terminal_settlement_line_id_seq, energy_price_zone_id_seq, survey_response_id_seq TO plugsure_app;
  END IF;
END $$;
