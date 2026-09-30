-- ═══════════════════════════════════════════════════════════════════════════
-- 008: OCPP Security Profile 3 — client-certificate binding (mutual TLS)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Profile 2 authenticates a charger with the per-unit AuthorizationKey (auth_key_hash).
-- Profile 3 replaces that secret with a CLIENT CERTIFICATE. The certificate is
-- verified against the deployment CA at the TLS terminator (the reverse proxy in
-- the shipped Caddy setup, or the gateway itself); the CSMS then binds that cert
-- to THIS charge point so a trusted charger cannot use another unit's certificate.
--
-- We store only the certificate's SHA-256 FINGERPRINT (64 lowercase hex chars),
-- never the certificate or any private key. The gateway compares the presented
-- cert's fingerprint against this value on connect (see src/ocpp/client-cert.ts).
--
-- Additive and safe on a live 1.6/Profile-2 fleet: the column is nullable and
-- unused until a charge point is actually raised to security_profile = 3, which
-- setSecurityProfile() refuses to do until this binding exists.

ALTER TABLE charge_point
  ADD COLUMN IF NOT EXISTS client_cert_fingerprint TEXT;   -- SHA-256, lowercase hex, no colons

COMMENT ON COLUMN charge_point.client_cert_fingerprint IS
  'OCPP Security Profile 3: expected client-certificate SHA-256 fingerprint (64 hex chars). NULL = no mTLS binding.';
