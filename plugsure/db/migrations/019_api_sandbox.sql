-- v1.3: developer sandbox tenants.
--
-- A sandbox is an ordinary organisation marked as the sandbox OF another one
-- (the operator who created it). Its chargers are virtual: simulated inside the
-- gateway process and attached without a network socket, so no real hardware
-- can connect as one and a sandbox can never command a real charger. Everything
-- above the transport — the OCPP adapters, sessions, billing, webhooks — is the
-- production code path.
--
-- Additive: nothing is a sandbox and nothing is virtual until someone creates one.

ALTER TABLE organisation
  ADD COLUMN IF NOT EXISTS sandbox_of_org_id UUID REFERENCES organisation(id),
  ADD COLUMN IF NOT EXISTS sandbox_created_by TEXT,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS organisation_sandbox_of_idx ON organisation (sandbox_of_org_id) WHERE sandbox_of_org_id IS NOT NULL;

ALTER TABLE charge_point
  ADD COLUMN IF NOT EXISTS virtual BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS charge_point_virtual_idx ON charge_point (id) WHERE virtual;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
