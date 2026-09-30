-- 022: ISO 15118 Plug & Charge (CSMS side).
--
-- A Plug & Charge contract is a token of kind 'emaid' whose uid is the eMAID
-- without separators, so card limits, fleet accounts, memberships and receipts
-- apply to it unchanged. These tables add the certificate side: the operator's
-- trust anchors, the chargers' V2G (SECC) certificates, and a log of every
-- certificate exchange. Additive: nothing happens until Plug & Charge is
-- switched on for the organisation.

ALTER TABLE organisation
  ADD COLUMN IF NOT EXISTS pnc_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Chargers the operator has marked as ISO 15118 capable: their V2G certificate
-- is watched and renewed before it expires.
ALTER TABLE charge_point
  ADD COLUMN IF NOT EXISTS pnc_enabled       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pnc_installed     JSONB,
  ADD COLUMN IF NOT EXISTS pnc_installed_at  TIMESTAMPTZ;

-- Root certificates the operator's chargers should trust: the V2G root (for the
-- charger's own certificate chain) and the mobility operators' roots (contract
-- certificates). From the PKI provider or uploaded.
CREATE TABLE IF NOT EXISTS pnc_trust_anchor (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organisation(id),
  kind         TEXT NOT NULL CHECK (kind IN ('V2GRootCertificate', 'MORootCertificate')),
  pem          TEXT NOT NULL,
  subject      TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  not_after    TIMESTAMPTZ NOT NULL,
  source       TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('pki', 'upload')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, fingerprint)
);

-- A charger's certificate: requested with SignCertificate, signed, delivered
-- with CertificateSigned.
CREATE TABLE IF NOT EXISTS pnc_certificate (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organisation(id),
  charge_point_id   UUID NOT NULL REFERENCES charge_point(id),
  certificate_type  TEXT NOT NULL CHECK (certificate_type IN ('V2GCertificate', 'ChargingStationCertificate')),
  state             TEXT NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'signed', 'delivered', 'rejected', 'failed')),
  csr_subject       TEXT,
  subject           TEXT,
  serial            TEXT,
  fingerprint       TEXT,
  not_before        TIMESTAMPTZ,
  not_after         TIMESTAMPTZ,
  chain_pem         TEXT,
  error             TEXT,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS pnc_certificate_cp_idx ON pnc_certificate (charge_point_id, requested_at DESC);

-- Every Plug & Charge exchange with a charger or the PKI, for troubleshooting.
CREATE TABLE IF NOT EXISTS pnc_event (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  charge_point_id  UUID REFERENCES charge_point(id),
  action           TEXT NOT NULL,
  outcome          TEXT NOT NULL,
  emaid            TEXT,
  detail           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pnc_event_org_idx ON pnc_event (org_id, created_at DESC);

-- Test PKI only (PNC_PKI=mock, refused in production): its CA keys, sealed
-- with SECRETS_KEY, and the contract certificates it issued (for its OCSP
-- answers). Platform-wide, like a real V2G PKI.
CREATE TABLE IF NOT EXISTS pnc_mock_ca (
  name        TEXT PRIMARY KEY,
  cert_pem    TEXT NOT NULL,
  key_sealed  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pnc_mock_contract (
  serial      TEXT PRIMARY KEY,
  emaid       TEXT NOT NULL,
  cert_pem    TEXT NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS token_emaid_idx ON token (org_id, uid) WHERE kind = 'emaid';

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['pnc_trust_anchor', 'pnc_certificate', 'pnc_event'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$I_tenant ON %1$I', t);
    EXECUTE format($p$CREATE POLICY %1$I_tenant ON %1$I
      USING (app_current_org() IS NULL OR org_id = app_current_org())
      WITH CHECK (app_current_org() IS NULL OR org_id = app_current_org())$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
