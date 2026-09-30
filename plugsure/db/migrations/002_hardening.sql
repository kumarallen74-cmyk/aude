-- Hardening migration — closes the findings in docs/VERIFICATION-REPORT.md.
-- Every block below names the finding it addresses.

-- ─────────────────────────────────────────────── V5: connection evidence
-- A rejected upgrade previously wrote nothing anywhere, so a charger that could
-- not connect left no trace but a stdout line. This is the table a joint
-- debugging session with a hardware vendor actually runs on.

CREATE TABLE connection_attempt (
  id                BIGSERIAL PRIMARY KEY,
  ts                TIMESTAMPTZ NOT NULL DEFAULT now(),
  remote_ip         TEXT,
  forwarded_for     TEXT,
  request_path      TEXT,
  ocpp_identity     TEXT,
  charge_point_id   UUID REFERENCES charge_point(id) ON DELETE SET NULL,
  subprotocols      TEXT,            -- exactly what the charger offered
  negotiated        TEXT,            -- what we echoed back, if anything
  auth_present      BOOLEAN NOT NULL DEFAULT false,
  auth_scheme       TEXT,
  tls               BOOLEAN NOT NULL DEFAULT false,
  user_agent        TEXT,
  outcome           TEXT NOT NULL,   -- accepted | rejected_unknown_cp | rejected_auth
                                     -- | rejected_no_subprotocol | rejected_no_identity
                                     -- | rejected_tls_required | rejected_malformed_path | error
  http_status       INTEGER,
  detail            TEXT
);
CREATE INDEX ON connection_attempt (ts DESC);
CREATE INDEX ON connection_attempt (ocpp_identity, ts DESC);
CREATE INDEX ON connection_attempt (outcome, ts DESC);

-- ─────────────────────────────────────────────── V3: key provisioning
ALTER TABLE charge_point
  ADD COLUMN auth_key_rotated_at TIMESTAMPTZ,
  ADD COLUMN auth_key_prev_hash  TEXT,          -- accepted during the rotation grace window
  ADD COLUMN adopted_at          TIMESTAMPTZ,
  ADD COLUMN pending_reason      TEXT,
  ADD COLUMN first_seen_at       TIMESTAMPTZ;

-- ─────────────────────────────────────────────── M3: status detail was discarded
-- StatusNotification carried timestamp, vendorErrorCode and info; all three were
-- dropped. The vendor fault code is exactly what a hardware integration needs.
ALTER TABLE connector
  ADD COLUMN vendor_error_code TEXT,
  ADD COLUMN status_info       TEXT;

-- ─────────────────────────────────────────────── H10: liveness
ALTER TABLE charge_point
  ADD COLUMN last_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN offline_since     TIMESTAMPTZ;
CREATE INDEX ON charge_point (last_seen_at);

-- ─────────────────────────────────────────────── S1/S2: real authentication
CREATE TABLE api_key (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL UNIQUE,        -- shown in the UI, safe to log
  key_hash     TEXT NOT NULL,               -- sha256 of the full secret
  permissions  TEXT[] NOT NULL DEFAULT '{}',
  scope_type   TEXT NOT NULL DEFAULT 'org', -- org | site | fleet
  scope_id     UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX ON api_key (org_id) WHERE revoked_at IS NULL;

-- Driver/operator sessions for the console. Bearer tokens, hashed at rest.
CREATE TABLE auth_session (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX ON auth_session (user_id);

-- ─────────────────────────────────────────────── S4: audit truncation detection
-- The chain alone cannot detect deletion of the newest entries. A separate head
-- row records the expected length and terminal hash.
CREATE TABLE audit_head (
  org_id      UUID PRIMARY KEY,
  entries     BIGINT NOT NULL DEFAULT 0,
  head_hash   TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- NULL org_id (platform-level events) needs a row too; use the nil UUID as its key.
INSERT INTO audit_head (org_id) VALUES ('00000000-0000-0000-0000-000000000000')
  ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────── H11: profile reconciliation
ALTER TABLE charging_profile
  ADD COLUMN cleared_at   TIMESTAMPTZ,
  ADD COLUMN last_error   TEXT,
  ADD COLUMN valid_to     TIMESTAMPTZ,
  ADD COLUMN unit         TEXT NOT NULL DEFAULT 'W',
  ADD COLUMN limit_value  NUMERIC(10,2);
CREATE INDEX ON charging_profile (charge_point_id, connector_no, purpose, stack_level)
  WHERE cleared_at IS NULL;

-- ─────────────────────────────────────────────── B1/H8: session integrity
ALTER TABLE charging_session
  ADD COLUMN charger_tx_ref   TEXT,        -- the charger's own reference, when it gives one
  ADD COLUMN rated_at         TIMESTAMPTZ,
  ADD COLUMN needs_review     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN review_reason    TEXT,
  ADD COLUMN flags            JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN idle_minutes     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN last_meter_at    TIMESTAMPTZ,
  ADD COLUMN payment_intent_id UUID;
CREATE INDEX ON charging_session (state, started_at) WHERE state = 'active';
CREATE INDEX ON charging_session (needs_review) WHERE needs_review = true;

-- Exactly one active session per connector. This is the database-level guard
-- behind the application check; a race cannot produce two.
CREATE UNIQUE INDEX charging_session_one_active_per_connector
  ON charging_session (connector_uuid) WHERE state = 'active';

-- ─────────────────────────────────────────────── B4: prepaid enforcement
ALTER TABLE payment_intent
  ADD COLUMN allowance_wh BIGINT,
  ADD COLUMN captured_at  TIMESTAMPTZ,
  ADD COLUMN connector_uuid UUID REFERENCES connector(id);
CREATE INDEX ON payment_intent (connector_uuid, state)
  WHERE state IN ('pending', 'authorised', 'captured');

-- ─────────────────────────────────────────────── H7: tariff integrity
ALTER TABLE tariff
  ADD COLUMN validated_at   TIMESTAMPTZ,
  ADD COLUMN validation     JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN created_by     TEXT;

-- A tier must declare its upper bound so banded pricing is expressible.
ALTER TABLE tariff_component
  ADD COLUMN to_kwh      NUMERIC(10,3),
  ADD COLUMN to_minutes  INTEGER;

-- ─────────────────────────────────────────────── data hygiene
ALTER TABLE token
  ADD CONSTRAINT token_status_valid
  CHECK (status IN ('Accepted', 'Blocked', 'Expired', 'Invalid', 'ConcurrentTx'));

ALTER TABLE evse
  ADD CONSTRAINT evse_id_sane CHECK (evse_id >= 0 AND evse_id <= 128);

ALTER TABLE site
  ADD CONSTRAINT pbjt_rate_sane CHECK (pbjt_rate_bps >= 0 AND pbjt_rate_bps <= 1000);

-- ─────────────────────────────────────────────── S2: row-level security
-- Second line of defence behind query-layer scoping. Only effective when the
-- application connects as a NON-SUPERUSER role, because superusers bypass RLS.
-- Production must use plugsure_app; see deploy/README.md.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    CREATE ROLE plugsure_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO plugsure_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO plugsure_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO plugsure_app;

-- current_setting('app.current_org_id', true) is set per transaction by the app.
CREATE OR REPLACE FUNCTION app_current_org() RETURNS UUID AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- Tables that carry org_id directly.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['site','driver','token','tariff','charging_session','cdr',
                           'payment_intent','alert','webhook_endpoint','api_key','app_user']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY %1$I_tenant ON %1$I
        USING (app_current_org() IS NULL OR org_id = app_current_org())
        WITH CHECK (app_current_org() IS NULL OR org_id = app_current_org())
    $f$, t);
  END LOOP;
END
$$;

-- charge_point reaches org_id through site.
ALTER TABLE charge_point ENABLE ROW LEVEL SECURITY;
ALTER TABLE charge_point FORCE ROW LEVEL SECURITY;
CREATE POLICY charge_point_tenant ON charge_point
  USING (
    app_current_org() IS NULL
    OR EXISTS (SELECT 1 FROM site s WHERE s.id = charge_point.site_id AND s.org_id = app_current_org())
  )
  WITH CHECK (
    app_current_org() IS NULL
    OR EXISTS (SELECT 1 FROM site s WHERE s.id = charge_point.site_id AND s.org_id = app_current_org())
  );

COMMENT ON FUNCTION app_current_org() IS
  'Per-transaction tenant, set with SET LOCAL app.current_org_id. NULL disables the '
  'policy for trusted internal work (the OCPP gateway, migrations, workers).';
