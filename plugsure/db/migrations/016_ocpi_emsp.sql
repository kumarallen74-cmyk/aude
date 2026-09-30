-- 016: roaming over OCPI 2.2.1 — PlugSure as the e-mobility service provider (eMSP)
--
-- The operator's own cards charge on other operators' (CPOs') networks. The
-- CPO sends a charge detail record for every session, which the operator pays
-- and bills on to the card holder (a fleet, a company account).
--
--   token.roaming_shared      a card the operator lets roam; its contract id
--   ocpi_remote_location      charging locations CPO partners published to us
--   ocpi_remote_tariff        their tariffs
--   ocpi_remote_session       our drivers' sessions on their chargers
--   ocpi_remote_cdr           their charge records for those sessions
--   ocpi_command              commands we sent (START/STOP/UNLOCK) and their results
--
-- All additive. Nothing is shared with a CPO until an operator shares a card.

ALTER TABLE token ADD COLUMN IF NOT EXISTS roaming_shared BOOLEAN NOT NULL DEFAULT false;
-- eMAID-style contract id (ID-PLS-C1A2B3C4D-X), given when the card is first shared.
ALTER TABLE token ADD COLUMN IF NOT EXISTS contract_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS token_contract_id_uq ON token (contract_id) WHERE contract_id IS NOT NULL;

ALTER TABLE ocpi_partner DROP CONSTRAINT IF EXISTS ocpi_partner_kind_check;
ALTER TABLE ocpi_partner ADD CONSTRAINT ocpi_partner_kind_check CHECK (kind IN ('emsp', 'cpo', 'hub'));

ALTER TABLE ocpi_object_state DROP CONSTRAINT IF EXISTS ocpi_object_state_object_type_check;
ALTER TABLE ocpi_object_state ADD CONSTRAINT ocpi_object_state_object_type_check CHECK (object_type IN ('location', 'tariff', 'token'));

CREATE TABLE IF NOT EXISTS ocpi_remote_location (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organisation(id),
  partner_id     UUID NOT NULL REFERENCES ocpi_partner(id) ON DELETE CASCADE,
  country_code   TEXT NOT NULL,
  party_id       TEXT NOT NULL,
  location_id    TEXT NOT NULL,
  data           JSONB NOT NULL,
  last_updated   TIMESTAMPTZ NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (partner_id, country_code, party_id, location_id)
);

CREATE TABLE IF NOT EXISTS ocpi_remote_tariff (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organisation(id),
  partner_id     UUID NOT NULL REFERENCES ocpi_partner(id) ON DELETE CASCADE,
  country_code   TEXT NOT NULL,
  party_id       TEXT NOT NULL,
  tariff_id      TEXT NOT NULL,
  data           JSONB NOT NULL,
  last_updated   TIMESTAMPTZ NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (partner_id, country_code, party_id, tariff_id)
);

CREATE TABLE IF NOT EXISTS ocpi_remote_session (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organisation(id),
  partner_id     UUID NOT NULL REFERENCES ocpi_partner(id) ON DELETE CASCADE,
  country_code   TEXT NOT NULL,
  party_id       TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  token_id       UUID REFERENCES token(id),
  data           JSONB NOT NULL,
  status         TEXT,
  kwh            NUMERIC(12,3),
  last_updated   TIMESTAMPTZ NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (partner_id, country_code, party_id, session_id)
);
CREATE INDEX IF NOT EXISTS ocpi_remote_session_token_idx ON ocpi_remote_session (token_id);

CREATE TABLE IF NOT EXISTS ocpi_remote_cdr (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organisation(id),
  partner_id     UUID NOT NULL REFERENCES ocpi_partner(id) ON DELETE CASCADE,
  country_code   TEXT NOT NULL,
  party_id       TEXT NOT NULL,
  cdr_id         TEXT NOT NULL,
  session_id     TEXT,
  token_id       UUID REFERENCES token(id),
  data           JSONB NOT NULL,
  currency       TEXT NOT NULL,
  total_excl_vat NUMERIC(14,2) NOT NULL,
  total_incl_vat NUMERIC(14,2),
  total_energy   NUMERIC(12,3) NOT NULL,
  start_date_time TIMESTAMPTZ NOT NULL,
  end_date_time  TIMESTAMPTZ NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (partner_id, country_code, party_id, cdr_id)
);
CREATE INDEX IF NOT EXISTS ocpi_remote_cdr_token_idx ON ocpi_remote_cdr (token_id);
CREATE INDEX IF NOT EXISTS ocpi_remote_cdr_org_idx ON ocpi_remote_cdr (org_id, end_date_time DESC);

CREATE TABLE IF NOT EXISTS ocpi_command (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organisation(id),
  partner_id     UUID NOT NULL REFERENCES ocpi_partner(id) ON DELETE CASCADE,
  command        TEXT NOT NULL CHECK (command IN ('START_SESSION', 'STOP_SESSION', 'UNLOCK_CONNECTOR')),
  token_id       UUID REFERENCES token(id),
  request        JSONB NOT NULL,
  -- The CPO's synchronous answer (will it forward the command?)...
  response       TEXT,
  -- ...and the charger's outcome, posted back to us later.
  result         TEXT,
  message        TEXT,
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at   TIMESTAMPTZ,
  result_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ocpi_command_org_idx ON ocpi_command (org_id, created_at DESC);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ocpi_remote_location','ocpi_remote_tariff','ocpi_remote_session','ocpi_remote_cdr','ocpi_command']
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
