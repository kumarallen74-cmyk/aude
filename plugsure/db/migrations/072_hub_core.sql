-- 072: PlugSure Hub — routing core (docs/HUB-DESIGN.md §3.2, WP H1).
--
-- Additive only: new hub_* tables and one column with a constant default on organisation (no rewrite in
-- Postgres 11+). Nothing reads these tables while HUB_ENABLED=false. Rollback: db/rollback/072_down.sql.
--
-- RLS (§3.1): the 048 shape everywhere. hub_member and hub_party carry the member's org (tenant view);
-- hub_agreement is two-sided (cpo_org_id / emsp_org_id). Every other table holds tokens, routing state or
-- logs and is for the unscoped hub router and platform routes only: its policy admits the bypass alone.

ALTER TABLE organisation ADD COLUMN IF NOT EXISTS hub_only BOOLEAN NOT NULL DEFAULT false;

-- PlugSure entities that invoice hub fees (filled by H2 / platform settings).
CREATE TABLE IF NOT EXISTS hub_entity (
  country_code   TEXT PRIMARY KEY CHECK (country_code IN ('ID','MY','SG')),
  legal_name     TEXT NOT NULL,
  tax_id         TEXT,
  tax_registered BOOLEAN NOT NULL DEFAULT false,
  address        TEXT NOT NULL,
  bank_details   TEXT,
  invoice_prefix TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The hub's own OCPI identities (role HUB). Mirrored from HUB_PARTIES at start-up (src/hub/registry.ts).
CREATE TABLE IF NOT EXISTS hub_self_party (
  country_code   TEXT PRIMARY KEY CHECK (country_code ~ '^[A-Z]{2}$'),
  party_id       TEXT NOT NULL CHECK (party_id ~ '^[A-Z0-9]{3}$'),
  business_name  TEXT NOT NULL,
  website        TEXT,
  entity_country TEXT REFERENCES hub_entity(country_code),
  UNIQUE (country_code, party_id)
);

CREATE TABLE IF NOT EXISTS hub_member (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL UNIQUE REFERENCES organisation(id),
  kind             TEXT NOT NULL CHECK (kind IN ('internal','external')),
  legal_name       TEXT NOT NULL,
  country_code     TEXT NOT NULL CHECK (country_code IN ('ID','MY','SG')),
  tax_id           TEXT,
  billing_email    TEXT,
  status           TEXT NOT NULL DEFAULT 'onboarding' CHECK (status IN ('onboarding','active','suspended','terminated')),
  open_roaming     BOOLEAN NOT NULL DEFAULT false,
  fee_plan_id      UUID,
  contract_ref     TEXT,
  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hub_connection (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id        UUID NOT NULL REFERENCES hub_member(id),
  kind             TEXT NOT NULL CHECK (kind IN ('external','internal')),
  state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','connected','suspended','closed')),
  token_in_hash    TEXT UNIQUE,
  token_in         TEXT,
  token_prev_hash  TEXT UNIQUE,
  token_prev_until TIMESTAMPTZ,
  token_out        TEXT,
  versions_url     TEXT,
  version          TEXT,
  endpoints        JSONB NOT NULL DEFAULT '[]',
  peer_org_id      UUID REFERENCES organisation(id),
  peer_partner_id  UUID REFERENCES ocpi_partner(id),
  rate_limit_per_min INTEGER NOT NULL DEFAULT 600 CHECK (rate_limit_per_min BETWEEN 1 AND 100000),
  realtime_limit_per_min INTEGER NOT NULL DEFAULT 1200 CHECK (realtime_limit_per_min BETWEEN 1 AND 100000),
  capture_bodies_until TIMESTAMPTZ,
  last_inbound_at  TIMESTAMPTZ,
  last_alive_ok_at TIMESTAMPTZ,
  alive_failures   INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  registered_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hub_connection_internal_uq ON hub_connection (peer_org_id) WHERE kind = 'internal' AND state <> 'closed';
CREATE INDEX IF NOT EXISTS hub_connection_member_idx ON hub_connection (member_id);

-- One owner (member) per (country_code, party_id), whatever roles it registers under it.
CREATE TABLE IF NOT EXISTS hub_party_key (
  country_code   TEXT NOT NULL,
  party_id       TEXT NOT NULL,
  member_id      UUID NOT NULL REFERENCES hub_member(id),
  PRIMARY KEY (country_code, party_id),
  UNIQUE (country_code, party_id, member_id)
);

CREATE TABLE IF NOT EXISTS hub_party (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id      UUID NOT NULL REFERENCES hub_member(id),
  org_id         UUID NOT NULL REFERENCES organisation(id),
  connection_id  UUID REFERENCES hub_connection(id),
  country_code   TEXT NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  party_id       TEXT NOT NULL CHECK (party_id ~ '^[A-Z0-9]{3}$'),
  role           TEXT NOT NULL CHECK (role IN ('CPO','EMSP','NSP','OTHER','SCSP','NAP')),
  business_name  TEXT NOT NULL,
  website        TEXT,
  status         TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('CONNECTED','OFFLINE','PLANNED','SUSPENDED')),
  admin_suspended BOOLEAN NOT NULL DEFAULT false,
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (country_code, party_id, role),
  FOREIGN KEY (country_code, party_id, member_id) REFERENCES hub_party_key (country_code, party_id, member_id)
);
CREATE INDEX IF NOT EXISTS hub_party_connection_idx ON hub_party (connection_id);
CREATE INDEX IF NOT EXISTS hub_party_member_idx ON hub_party (member_id);

CREATE TABLE IF NOT EXISTS hub_agreement (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cpo_party_id    UUID NOT NULL REFERENCES hub_party(id),
  emsp_party_id   UUID NOT NULL REFERENCES hub_party(id),
  cpo_org_id      UUID NOT NULL REFERENCES organisation(id),
  emsp_org_id     UUID NOT NULL REFERENCES organisation(id),
  status          TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','suspended','ended')),
  proposed_by     TEXT NOT NULL CHECK (proposed_by IN ('cpo','emsp','platform')),
  cpo_accepted_at  TIMESTAMPTZ,
  emsp_accepted_at TIMESTAMPTZ,
  valid_from      TIMESTAMPTZ,
  valid_to        TIMESTAMPTZ,
  allow_realtime_auth BOOLEAN NOT NULL DEFAULT true,
  allow_commands  BOOLEAN NOT NULL DEFAULT true,
  allow_charging_profiles BOOLEAN NOT NULL DEFAULT true,
  fee_plan_id     UUID,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (cpo_party_id <> emsp_party_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS hub_agreement_live_uq ON hub_agreement (cpo_party_id, emsp_party_id) WHERE status IN ('proposed','active','suspended');
CREATE INDEX IF NOT EXISTS hub_agreement_emsp_idx ON hub_agreement (emsp_party_id);

-- What the router learned from traffic, for open routing (and H2's CDR validation).
CREATE TABLE IF NOT EXISTS hub_route_index (
  kind            TEXT NOT NULL CHECK (kind IN ('location','token','session','reservation','authorization','command_session')),
  key             TEXT NOT NULL,
  owner_party_id  UUID NOT NULL REFERENCES hub_party(id),
  counter_party_id UUID REFERENCES hub_party(id),
  data            JSONB,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ,
  PRIMARY KEY (kind, key, owner_party_id)
);
CREATE INDEX IF NOT EXISTS hub_route_index_expiry_idx ON hub_route_index (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS hub_outbox (
  id               BIGSERIAL PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('broadcast','callback','clientinfo','forward_retry')),
  origin_party_id  UUID REFERENCES hub_party(id),
  recipient_connection_id UUID NOT NULL REFERENCES hub_connection(id) ON DELETE CASCADE,
  recipient_party_id UUID REFERENCES hub_party(id),
  module           TEXT NOT NULL,
  method           TEXT NOT NULL CHECK (method IN ('POST','PUT','PATCH','DELETE')),
  url              TEXT,
  path_suffix      TEXT,
  -- JSON, not JSONB: the body is forwarded as received, key order included (JSONB reorders keys).
  body             JSON,
  object_key       TEXT NOT NULL,
  correlation_id   TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered','failed','dropped')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status      INTEGER,
  last_ocpi_status INTEGER,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS hub_outbox_due_idx ON hub_outbox (next_attempt_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS hub_outbox_object_idx ON hub_outbox (recipient_connection_id, object_key, id) WHERE state = 'pending';

-- Rewritten response_url / CDR Location that need server state.
CREATE TABLE IF NOT EXISTS hub_callback (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('command_result','profile_result','active_profile','cdr_location')),
  origin_party_id  UUID NOT NULL REFERENCES hub_party(id),
  target_party_id  UUID NOT NULL REFERENCES hub_party(id),
  original_url     TEXT NOT NULL,
  command          TEXT,
  ref              TEXT,
  -- cdr_location: the CDR as forwarded (JSON: key order kept), served when the eMSP gave no Location.
  body             JSON,
  uses             INTEGER NOT NULL DEFAULT 0,
  max_uses         INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS hub_callback_ref_idx ON hub_callback (target_party_id, kind, ref);
CREATE INDEX IF NOT EXISTS hub_callback_expiry_idx ON hub_callback (expires_at);

CREATE TABLE IF NOT EXISTS hub_message (
  id               BIGSERIAL PRIMARY KEY,
  correlation_id   TEXT NOT NULL,
  request_id_in    TEXT,
  request_id_out   TEXT,
  leg              TEXT NOT NULL CHECK (leg IN ('in','out')),
  connection_id    UUID,
  from_party       TEXT,
  to_party         TEXT,
  route            TEXT NOT NULL,
  module           TEXT,
  method           TEXT NOT NULL,
  path             TEXT NOT NULL,
  http_status      INTEGER,
  ocpi_status      INTEGER,
  duration_ms      INTEGER,
  bytes            INTEGER,
  error            TEXT,
  body_redacted    JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hub_message_corr_idx ON hub_message (correlation_id);
CREATE INDEX IF NOT EXISTS hub_message_conn_idx ON hub_message (connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hub_message_created_idx ON hub_message (created_at);

-- ───────────────────────────────────────────── row-level security (048 shape)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hub_entity','hub_self_party','hub_connection','hub_party_key','hub_route_index',
                           'hub_outbox','hub_callback','hub_message'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_platform', t);
    -- Platform only: the hub router and /v1/hub routes run unscoped. Inside a tenant's request: nothing.
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass()) WITH CHECK (app_rls_bypass())', t || '_platform', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['hub_member','hub_party'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) '
                   'WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

ALTER TABLE hub_agreement ENABLE ROW LEVEL SECURITY;
ALTER TABLE hub_agreement FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hub_agreement_tenant ON hub_agreement;
CREATE POLICY hub_agreement_tenant ON hub_agreement
  USING (app_rls_bypass() OR cpo_org_id = app_current_org() OR emsp_org_id = app_current_org())
  WITH CHECK (app_rls_bypass() OR cpo_org_id = app_current_org() OR emsp_org_id = app_current_org());

-- Grants per table (no blanket GRANT: see 053/055).
GRANT SELECT, INSERT, UPDATE, DELETE ON hub_entity, hub_self_party, hub_member, hub_connection, hub_party_key, hub_party,
  hub_agreement, hub_route_index, hub_outbox, hub_callback, hub_message TO plugsure_app;
GRANT USAGE, SELECT ON SEQUENCE hub_outbox_id_seq, hub_message_id_seq TO plugsure_app;
