-- 015: roaming over OCPI 2.2.1 — PlugSure as the charge point operator (CPO)
--
-- Drivers of other networks (e-mobility service providers, "eMSPs", reached
-- directly or through a roaming hub) charge on this operator's chargers, and
-- the operator bills their provider with a charge detail record.
--
--   ocpi_party          this organisation's own roaming identity (country + party id)
--   ocpi_partner        one connection: an eMSP, or a hub standing for many
--   ocpi_token          driver tokens the partners pushed to us
--   ocpi_authorization  one-shot approvals (a START_SESSION command, a real-time "allowed")
--   ocpi_reservation    OCPI reservation ids <-> OCPP integer reservation ids
--   ocpi_object_state   what was last published per location/tariff, for last_updated
--   ocpi_push           outbox of calls to partners (at-least-once, ordered per object)
--   ocpi_message        request/response log for the console
--
-- All additive. Nothing is published and nothing is sent until an operator
-- sets the roaming identity, connects a partner and publishes a site.

ALTER TABLE site ADD COLUMN IF NOT EXISTS city TEXT;
-- Opt-in per site: a location is shared with roaming partners only when set.
ALTER TABLE site ADD COLUMN IF NOT EXISTS roaming_publish BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS ocpi_party (
  org_id         UUID PRIMARY KEY REFERENCES organisation(id),
  country_code   TEXT NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  party_id       TEXT NOT NULL CHECK (party_id ~ '^[A-Z0-9]{3}$'),
  business_name  TEXT NOT NULL,
  website        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (country_code, party_id)
);

CREATE TABLE IF NOT EXISTS ocpi_partner (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organisation(id),
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'emsp' CHECK (kind IN ('emsp', 'hub')),
  state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'connected', 'suspended', 'closed')),
  -- The token the partner presents to us: SHA-256 for lookup, sealed for
  -- GET /credentials (which must return it). Token A while pending, C after.
  token_in_hash    TEXT UNIQUE,
  token_in         TEXT,
  -- The token we present to the partner (sealed): their A while registering, then their C.
  token_out        TEXT,
  versions_url     TEXT,
  version          TEXT,
  endpoints        JSONB NOT NULL DEFAULT '[]',
  roles            JSONB NOT NULL DEFAULT '[]',
  country_code     TEXT,
  party_id         TEXT,
  last_error       TEXT,
  last_success_at  TIMESTAMPTZ,
  registered_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ocpi_partner_org_idx ON ocpi_partner (org_id);

CREATE TABLE IF NOT EXISTS ocpi_token (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organisation(id),
  partner_id            UUID NOT NULL REFERENCES ocpi_partner(id) ON DELETE CASCADE,
  country_code          TEXT NOT NULL,
  party_id              TEXT NOT NULL,
  uid                   TEXT NOT NULL,
  type                  TEXT NOT NULL CHECK (type IN ('AD_HOC_USER', 'APP_USER', 'OTHER', 'RFID')),
  contract_id           TEXT NOT NULL,
  visual_number         TEXT,
  issuer                TEXT NOT NULL,
  group_id              TEXT,
  valid                 BOOLEAN NOT NULL,
  whitelist             TEXT NOT NULL CHECK (whitelist IN ('ALWAYS', 'ALLOWED', 'ALLOWED_OFFLINE', 'NEVER')),
  language              TEXT,
  default_profile_type  TEXT,
  energy_contract       JSONB,
  last_updated          TIMESTAMPTZ NOT NULL,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, country_code, party_id, uid, type)
);
-- A charger only presents the uid: look tokens up by it.
CREATE INDEX IF NOT EXISTS ocpi_token_uid_idx ON ocpi_token (org_id, uid);

CREATE TABLE IF NOT EXISTS ocpi_authorization (
  id                       BIGSERIAL PRIMARY KEY,
  org_id                   UUID NOT NULL REFERENCES organisation(id),
  token_id                 UUID NOT NULL REFERENCES ocpi_token(id) ON DELETE CASCADE,
  auth_method              TEXT NOT NULL CHECK (auth_method IN ('COMMAND', 'AUTH_REQUEST')),
  authorization_reference  TEXT,
  connector_uuid           UUID REFERENCES connector(id),
  expires_at               TIMESTAMPTZ NOT NULL,
  used_at                  TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ocpi_authorization_token_idx ON ocpi_authorization (token_id, created_at DESC) WHERE used_at IS NULL;

ALTER TABLE charging_session
  ADD COLUMN IF NOT EXISTS ocpi_partner_id              UUID REFERENCES ocpi_partner(id),
  ADD COLUMN IF NOT EXISTS ocpi_token_id                UUID REFERENCES ocpi_token(id),
  ADD COLUMN IF NOT EXISTS ocpi_auth_method             TEXT,
  ADD COLUMN IF NOT EXISTS ocpi_authorization_reference TEXT;
CREATE INDEX IF NOT EXISTS charging_session_ocpi_partner_idx
  ON charging_session (ocpi_partner_id, started_at) WHERE ocpi_partner_id IS NOT NULL;

-- OCPP 1.6 ReserveNow needs an integer id; OCPI's is the partner's string.
CREATE TABLE IF NOT EXISTS ocpi_reservation (
  id                   SERIAL PRIMARY KEY,
  org_id               UUID NOT NULL REFERENCES organisation(id),
  partner_id           UUID NOT NULL REFERENCES ocpi_partner(id) ON DELETE CASCADE,
  ocpi_reservation_id  TEXT NOT NULL,
  token_id             UUID REFERENCES ocpi_token(id) ON DELETE SET NULL,
  charge_point_id      UUID NOT NULL REFERENCES charge_point(id),
  connector_no         INTEGER NOT NULL,
  expires_at           TIMESTAMPTZ NOT NULL,
  state                TEXT NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'active', 'cancelled', 'failed')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (partner_id, ocpi_reservation_id)
);

CREATE TABLE IF NOT EXISTS ocpi_object_state (
  org_id        UUID NOT NULL REFERENCES organisation(id),
  object_type   TEXT NOT NULL CHECK (object_type IN ('location', 'tariff')),
  object_id     TEXT NOT NULL,
  hash          TEXT NOT NULL,
  last_updated  TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at    TIMESTAMPTZ,
  PRIMARY KEY (org_id, object_type, object_id)
);

CREATE TABLE IF NOT EXISTS ocpi_push (
  id                 BIGSERIAL PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organisation(id),
  partner_id         UUID NOT NULL REFERENCES ocpi_partner(id) ON DELETE CASCADE,
  module             TEXT NOT NULL,
  action             TEXT NOT NULL,
  -- Calls about one object go out in order (a session's PUT before its PATCH,
  -- the CDR last), and a queued call is not queued twice.
  object_key         TEXT NOT NULL,
  -- Set only when the body cannot be re-read from the database at send time
  -- (command results). Otherwise the current state is rendered when sending.
  url                TEXT,
  body               JSONB,
  to_country_code    TEXT,
  to_party_id        TEXT,
  state              TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'failed')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status        INTEGER,
  last_error         TEXT,
  response_location  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ocpi_push_due_idx ON ocpi_push (next_attempt_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS ocpi_push_object_idx ON ocpi_push (partner_id, object_key, id) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS ocpi_message (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  partner_id    UUID REFERENCES ocpi_partner(id) ON DELETE CASCADE,
  direction     TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  method        TEXT NOT NULL,
  url           TEXT NOT NULL,
  http_status   INTEGER,
  ocpi_status   INTEGER,
  duration_ms   INTEGER,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ocpi_message_partner_idx ON ocpi_message (partner_id, created_at DESC);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ocpi_party','ocpi_partner','ocpi_token','ocpi_authorization','ocpi_reservation',
                           'ocpi_object_state','ocpi_push','ocpi_message']
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
