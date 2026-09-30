-- 023: automatic charger certificates (OCPP Security Profile 3) and onboarding.
--
-- PlugSure's own charging-station CA issues each charger's client certificate:
-- at onboarding (a key generated for the charger, or the charger's CSR), or
-- over OCPP (SignCertificate → CertificateSigned) with the charger keeping its
-- key. Only the certificate's fingerprint authenticates the charger, as before.
-- Additive: nothing changes for chargers until a certificate is issued.

-- The platform's CAs. The key is sealed with SECRETS_KEY. Platform-wide (not
-- per tenant): the TLS terminator trusts one CA file, and each certificate is
-- still bound to exactly one charger by its fingerprint.
CREATE TABLE IF NOT EXISTS platform_ca (
  name        TEXT PRIMARY KEY,
  cert_pem    TEXT NOT NULL,
  key_sealed  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE charge_point
  -- The previous certificate stays accepted until the charger connects with the
  -- new one, so a certificate change can never lock a charger out.
  ADD COLUMN IF NOT EXISTS client_cert_prev_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS client_cert_serial           TEXT,
  ADD COLUMN IF NOT EXISTS client_cert_not_after        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS client_cert_source           TEXT,
  -- Commissioned on Profile 2 with "the charger generates its key": PlugSure asks
  -- for its CSR after the first boot and moves it to Profile 3 once installed.
  ADD COLUMN IF NOT EXISTS cert_auto_upgrade            BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE charge_point DROP CONSTRAINT IF EXISTS charge_point_client_cert_source_check;
ALTER TABLE charge_point ADD CONSTRAINT charge_point_client_cert_source_check
  CHECK (client_cert_source IS NULL OR client_cert_source IN ('plugsure_ca', 'plugsure_ca_csr', 'ocpp_csr', 'vault', 'external'));

-- pnc_certificate (022) records station certificates too (certificate_type
-- 'ChargingStationCertificate'); 'issued' = handed out at onboarding.
ALTER TABLE pnc_certificate DROP CONSTRAINT IF EXISTS pnc_certificate_state_check;
ALTER TABLE pnc_certificate ADD CONSTRAINT pnc_certificate_state_check
  CHECK (state IN ('requested', 'signed', 'issued', 'delivered', 'rejected', 'failed'));
ALTER TABLE pnc_certificate ADD COLUMN IF NOT EXISTS key_type TEXT;
ALTER TABLE pnc_certificate ADD COLUMN IF NOT EXISTS source TEXT;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
