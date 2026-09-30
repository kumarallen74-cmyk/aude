-- 024: third-party integrations configured from the console (Govern → Integrations).
--
-- QRIS acquirer, driver sign-in codes (WhatsApp / SMS), the Plug & Charge PKI
-- and map tiles used to be environment variables only. A row here overrides the
-- environment for its kind. Secrets are sealed with SECRETS_KEY and never sent
-- back to the console; only a hint (the last characters) is.
--
-- org_id NULL = platform-wide (the platform operator's accounts: driver
-- sign-in, the PKI, map tiles, and the default QRIS account); an
-- organisation's own row (QRIS: its own merchant account) takes precedence.

CREATE TABLE IF NOT EXISTS integration (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID REFERENCES organisation(id),
  kind               TEXT NOT NULL CHECK (kind IN ('payments', 'otp', 'otp_fallback', 'pnc_pki', 'map_tiles')),
  provider           TEXT NOT NULL,
  settings           JSONB NOT NULL DEFAULT '{}'::jsonb,
  secrets_sealed     TEXT,
  secret_hints       JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled            BOOLEAN NOT NULL DEFAULT true,
  -- The unguessable part of this account's payment webhook URL (/pay/notify/<key>).
  webhook_key        TEXT UNIQUE,
  last_test_at       TIMESTAMPTZ,
  last_test_ok       BOOLEAN,
  last_test_message  TEXT,
  updated_by         UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A QRIS account replaced by another is ARCHIVED, not overwritten: payments it
-- took still get its notifications and refunds. One live row per scope and kind.
ALTER TABLE integration ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
DROP INDEX IF EXISTS integration_scope_kind_uq;
CREATE UNIQUE INDEX IF NOT EXISTS integration_scope_kind_live_uq
  ON integration (COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), kind) WHERE archived_at IS NULL;

-- What each integration did: payments created and notified, codes sent, tests.
CREATE TABLE IF NOT EXISTS integration_event (
  id              BIGSERIAL PRIMARY KEY,
  integration_id  UUID REFERENCES integration(id) ON DELETE SET NULL,
  org_id          UUID REFERENCES organisation(id),
  kind            TEXT NOT NULL,
  provider        TEXT NOT NULL,
  action          TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integration_event_kind_idx ON integration_event (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS integration_event_org_idx ON integration_event (org_id, created_at DESC);

-- Which account took a payment (for its refund and its webhook).
ALTER TABLE payment_intent ADD COLUMN IF NOT EXISTS integration_id UUID REFERENCES integration(id) ON DELETE SET NULL;
ALTER TABLE subscription_charge ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE subscription_charge ADD COLUMN IF NOT EXISTS integration_id UUID REFERENCES integration(id) ON DELETE SET NULL;

-- Platform rows (org_id NULL) are readable in every tenant scope, because an
-- organisation without its own account falls back to them; they are written
-- only outside a tenant scope (the platform operator's routes).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['integration', 'integration_event'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$I_tenant ON %1$I', t);
    EXECUTE format($p$CREATE POLICY %1$I_tenant ON %1$I
      USING (app_current_org() IS NULL OR org_id IS NULL OR org_id = app_current_org())
      WITH CHECK (app_current_org() IS NULL OR org_id = app_current_org())$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
