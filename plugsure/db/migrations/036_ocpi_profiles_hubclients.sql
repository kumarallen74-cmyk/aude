-- 036: OCPI ChargingProfiles (CPO role) and HubClientInfo.
--
--   ocpi_charging_profile  a partner's charging limit for one of its drivers'
--                          sessions on our chargers (OCPI 2.2.1 § 14). Load
--                          management reads it and never lets the session draw
--                          more; it can only lower what the site budget allows.
--   ocpi_hub_client        the parties behind a roaming hub and their connection
--                          status (OCPI 2.2.1 § 16), pushed by the hub or pulled
--                          from it. A hub that has told us who is behind it may
--                          only act for those parties.
--
-- Additive; nothing changes until a partner sends a profile or a hub its clients.

CREATE TABLE IF NOT EXISTS ocpi_charging_profile (
  session_id          UUID PRIMARY KEY REFERENCES charging_session(id) ON DELETE CASCADE,
  org_id              UUID NOT NULL REFERENCES organisation(id),
  partner_id          UUID NOT NULL REFERENCES ocpi_partner(id) ON DELETE CASCADE,
  -- The OCPI ChargingProfile as received (validated), start_date_time filled in.
  profile             JSONB NOT NULL,
  -- Where the result of the last request goes (the partner's response_url).
  response_url        TEXT,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The outcome reported to the partner for the last request.
  last_result         TEXT CHECK (last_result IN ('ACCEPTED', 'REJECTED', 'UNKNOWN')),
  applied_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ocpi_charging_profile_partner_idx ON ocpi_charging_profile (partner_id);

CREATE TABLE IF NOT EXISTS ocpi_hub_client (
  org_id              UUID NOT NULL REFERENCES organisation(id),
  partner_id          UUID NOT NULL REFERENCES ocpi_partner(id) ON DELETE CASCADE,
  country_code        TEXT NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  party_id            TEXT NOT NULL CHECK (party_id ~ '^[A-Z0-9]{3}$'),
  role                TEXT NOT NULL CHECK (role IN ('CPO', 'EMSP', 'HUB', 'NAP', 'NSP', 'OTHER', 'SCSP')),
  status              TEXT NOT NULL CHECK (status IN ('CONNECTED', 'OFFLINE', 'PLANNED', 'SUSPENDED')),
  last_updated        TIMESTAMPTZ NOT NULL,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_id, country_code, party_id, role)
);

ALTER TABLE ocpi_charging_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE ocpi_charging_profile FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ocpi_charging_profile_tenant ON ocpi_charging_profile;
CREATE POLICY ocpi_charging_profile_tenant ON ocpi_charging_profile
  USING (app_current_org() IS NULL OR org_id = app_current_org())
  WITH CHECK (app_current_org() IS NULL OR org_id = app_current_org());

ALTER TABLE ocpi_hub_client ENABLE ROW LEVEL SECURITY;
ALTER TABLE ocpi_hub_client FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ocpi_hub_client_tenant ON ocpi_hub_client;
CREATE POLICY ocpi_hub_client_tenant ON ocpi_hub_client
  USING (app_current_org() IS NULL OR org_id = app_current_org())
  WITH CHECK (app_current_org() IS NULL OR org_id = app_current_org());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
