-- 109 (v1.42.0) phase 30: solar and battery storage, charger health, the report builder, SAML single sign-on.
--
--   site_energy_asset     on-site solar (kWp, inverter kW) or a battery (kWh, kW, state-of-charge limits)
--   site_energy_settings  per site: solar-first charging, peak shaving and its target, the share of measured output
--                         the load manager may count on, and the hashed key the site's energy box posts readings with
--   site_energy_reading   what the site's energy box measured: solar output, battery power (+ discharging) and state of
--                         charge, grid import; kept 400 days (services/retention.ts)
--   charger_health        a charger's daily health: the score, its parts, the risk and why
--   report_definition     a saved custom report: dataset, columns, filters, grouping, chart, and an optional e-mail
--                         schedule
--   org_saml_provider     an organisation's SAML identity provider (Okta, Microsoft Entra ID, Google Workspace…):
--                         its entity id, sign-on URL and signing certificates, the allowed e-mail domains, automatic
--                         account set-up and the group → role map
--   saml_login_tx         a SAML sign-in in flight (ten minutes): the request id the answer must refer to, the
--                         browser it belongs to, and once the identity provider answered, the verified identity
--   saml_user_link        which identity-provider account (NameID) is which console user
--   auth_session.auth_method  gains 'saml'
--
-- Additive. Rollback: db/rollback/109_down.sql.

CREATE TABLE IF NOT EXISTS site_energy_asset (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  site_id          UUID NOT NULL REFERENCES site(id),
  kind             TEXT NOT NULL CHECK (kind IN ('solar', 'battery')),
  name             TEXT NOT NULL,
  -- solar: the array's peak (kWp) and the inverter's AC limit (kW); battery: its power (kW, both ways)
  capacity_kw      NUMERIC(10, 2) NOT NULL CHECK (capacity_kw > 0),
  peak_kwp         NUMERIC(10, 2) CHECK (peak_kwp IS NULL OR peak_kwp > 0),
  -- battery only: usable energy and the state-of-charge band it is kept in
  energy_kwh       NUMERIC(10, 2) CHECK (energy_kwh IS NULL OR energy_kwh > 0),
  min_soc_pct      NUMERIC(5, 2) CHECK (min_soc_pct IS NULL OR min_soc_pct BETWEEN 0 AND 100),
  max_soc_pct      NUMERIC(5, 2) CHECK (max_soc_pct IS NULL OR max_soc_pct BETWEEN 0 AND 100),
  commissioned_on  DATE,
  cost_minor       BIGINT CHECK (cost_minor IS NULL OR cost_minor >= 0),
  note             TEXT,
  archived_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind = 'solar' OR (energy_kwh IS NOT NULL AND min_soc_pct IS NOT NULL AND max_soc_pct IS NOT NULL AND min_soc_pct < max_soc_pct))
);
CREATE INDEX IF NOT EXISTS site_energy_asset_site_idx ON site_energy_asset (site_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS site_energy_settings (
  site_id           UUID PRIMARY KEY REFERENCES site(id),
  org_id            UUID NOT NULL REFERENCES organisation(id),
  solar_first       BOOLEAN NOT NULL DEFAULT true,
  peak_shaving      BOOLEAN NOT NULL DEFAULT false,
  peak_target_kw    NUMERIC(10, 2) CHECK (peak_target_kw IS NULL OR peak_target_kw > 0),
  -- the share of MEASURED solar and battery output the load manager may add to the grid budget (never forecasts)
  trust_pct         SMALLINT NOT NULL DEFAULT 80 CHECK (trust_pct BETWEEN 0 AND 100),
  -- readings older than this are not counted at all
  max_age_s         SMALLINT NOT NULL DEFAULT 120 CHECK (max_age_s BETWEEN 15 AND 900),
  ingest_key_hash   TEXT CHECK (ingest_key_hash IS NULL OR ingest_key_hash ~ '^[0-9a-f]{64}$'),
  ingest_key_hint   TEXT,
  updated_by        UUID REFERENCES app_user(id),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS site_energy_reading (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  site_id          UUID NOT NULL REFERENCES site(id),
  ts               TIMESTAMPTZ NOT NULL,
  solar_w          INTEGER CHECK (solar_w IS NULL OR solar_w >= 0),
  battery_w        INTEGER,            -- + discharging into the site, - charging
  battery_soc_pct  NUMERIC(5, 2) CHECK (battery_soc_pct IS NULL OR battery_soc_pct BETWEEN 0 AND 100),
  grid_w           INTEGER,            -- + import from the grid, - export
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, ts)
);
CREATE INDEX IF NOT EXISTS site_energy_reading_site_ts_idx ON site_energy_reading (site_id, ts DESC);

CREATE TABLE IF NOT EXISTS charger_health (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  charge_point_id  UUID NOT NULL REFERENCES charge_point(id) ON DELETE CASCADE,
  day              DATE NOT NULL,
  score            SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
  risk             TEXT NOT NULL CHECK (risk IN ('ok', 'watch', 'at_risk')),
  parts            JSONB NOT NULL DEFAULT '{}',
  reasons          TEXT[] NOT NULL DEFAULT '{}',
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (charge_point_id, day)
);
CREATE INDEX IF NOT EXISTS charger_health_org_day_idx ON charger_health (org_id, day DESC);

CREATE TABLE IF NOT EXISTS report_definition (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  name             TEXT NOT NULL,
  dataset          TEXT NOT NULL,
  spec             JSONB NOT NULL,     -- columns, filters, group by, sort, chart (validated by services/report-builder.ts)
  frequency        TEXT CHECK (frequency IS NULL OR frequency IN ('daily', 'weekly', 'monthly')),
  weekday          SMALLINT CHECK (weekday IS NULL OR weekday BETWEEN 1 AND 7),
  recipients       TEXT[] NOT NULL DEFAULT '{}',
  last_period      TEXT,
  last_sent_at     TIMESTAMPTZ,
  created_by       UUID REFERENCES app_user(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS org_saml_provider (
  org_id             UUID PRIMARY KEY REFERENCES organisation(id) ON DELETE CASCADE,
  enabled            BOOLEAN NOT NULL DEFAULT false,
  idp_entity_id      TEXT NOT NULL,
  sso_url            TEXT NOT NULL CHECK (sso_url ~ '^https://'),
  -- PEM bodies of the identity provider's signing certificates (two during a rollover)
  certificates       TEXT[] NOT NULL CHECK (cardinality(certificates) BETWEEN 1 AND 3),
  allowed_domains    TEXT[] NOT NULL DEFAULT '{}',
  jit_enabled        BOOLEAN NOT NULL DEFAULT false,
  group_attribute    TEXT,
  -- [{group, role}] — never an administrator role (services/saml.ts refuses them)
  role_map           JSONB NOT NULL DEFAULT '[]',
  updated_by         UUID REFERENCES app_user(id),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS org_saml_provider_entity_key ON org_saml_provider (idp_entity_id);

CREATE TABLE IF NOT EXISTS saml_login_tx (
  id_hash         TEXT PRIMARY KEY CHECK (id_hash ~ '^[0-9a-f]{64}$'),
  org_id          UUID NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
  request_id      TEXT NOT NULL UNIQUE,
  browser_hash    TEXT NOT NULL CHECK (browser_hash ~ '^[0-9a-f]{64}$'),
  host            TEXT NOT NULL,
  ip              TEXT,
  -- set when the identity provider's answer was verified; the finish step reads it once
  identity        JSONB,
  answered_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS saml_login_tx_expires_idx ON saml_login_tx (expires_at);

CREATE TABLE IF NOT EXISTS saml_user_link (
  org_id      UUID NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
  name_id     TEXT NOT NULL,
  user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  PRIMARY KEY (org_id, name_id)
);

-- A console session signed in with SAML (alongside 'password' and 'microsoft').
ALTER TABLE auth_session DROP CONSTRAINT IF EXISTS auth_session_auth_method_check;
ALTER TABLE auth_session ADD CONSTRAINT auth_session_auth_method_check CHECK (auth_method IN ('password', 'microsoft', 'saml'));

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['site_energy_asset', 'site_energy_settings', 'site_energy_reading', 'charger_health', 'report_definition',
                           'org_saml_provider', 'saml_login_tx', 'saml_user_link'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON site_energy_asset, site_energy_settings, charger_health, report_definition,
      org_saml_provider, saml_user_link TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON site_energy_asset, site_energy_settings, charger_health, report_definition,
      org_saml_provider, saml_user_link FROM plugsure_app;
    -- Readings are never changed; retention (services/retention.ts) removes those past 400 days.
    GRANT SELECT, INSERT, DELETE ON site_energy_reading TO plugsure_app;
    REVOKE UPDATE, TRUNCATE ON site_energy_reading FROM plugsure_app;
    -- A sign-in in flight is single use: consumed by deleting it (as oidc_login_tx).
    GRANT SELECT, INSERT, UPDATE, DELETE ON saml_login_tx TO plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE site_energy_asset_id_seq, site_energy_reading_id_seq, charger_health_id_seq, report_definition_id_seq TO plugsure_app;
  END IF;
END $$;
