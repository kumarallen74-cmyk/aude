# PlugSure CSMS v1.2.0 — Release Notes

**Date:** 7 September 2026 · **Milestone:** 2 · **Baseline:** v1.1.1 (7 Sep 2026)

## Summary

v1.2.0 adds **OCPP Security Profile 3 (mutual TLS)** — certificate-only, bound per
charge point — alongside the existing Profile 0/1/2 paths and the dual-stack
OCPP 1.6J / 2.0.1 support from v1.1.x.

It is **additive and off by default**. OCPP 1.6J, OCPP 2.0.1, and Security
Profiles 0/1/2 behave exactly as in v1.1.1; nothing changes until an operator
explicitly raises a specific charge point to Security Profile 3 (which is itself
guarded — see below). This was independently audited (see "Verification").

## What changed vs v1.1.1

New:
- `src/ocpp/client-cert.ts` — pure client-certificate verification (normalise
  SHA-256, constant-time match, read the presented fingerprint from the socket or
  a trusted proxy header, `checkClientCert`). Fails closed. No I/O.
- `src/ocpp/client-cert.test.ts` — 13 unit tests.
- `db/migrations/008_client_cert.sql` — adds one **nullable** column
  `charge_point.client_cert_fingerprint` (stores only the SHA-256 fingerprint;
  never a certificate or private key). No backfill, no change to existing rows.

Modified (additive; 0/1/2 behaviour preserved):
- `src/ocpp/server.ts` — auth flow: when the required profile is ≥ 3, verify the
  client certificate against the binding **instead of** HTTP Basic auth; profiles
  0/1/2 take the identical prior path.
- `src/services/chargepoint-keys.ts` — `setClientCertFingerprint()`, and
  `setSecurityProfile()` refuses to raise a unit to Profile 3 until a cert binding
  exists (mirrors the AuthorizationKey guard for Profile ≥1).
- `src/services/assets.ts` — the charge-point row carries `client_cert_fingerprint`.
- `src/config.ts` — `gateway.clientCertHeader` (default `x-client-cert-fingerprint`).
- `src/api/server.ts` — `PUT /v1/charge-points/:identity/client-certificate`.

## Deploying / upgrading from v1.1.1

Drop-in. Run migrations (`npm run migrate`) to apply `008_client_cert.sql` — the
one additive nullable column. No required config changes; no behaviour change for
1.6J / 2.0.1 / Profiles 0/1/2. If you are not using Profile 3, deploy and do
nothing further.

## Enabling Security Profile 3 (per charge point)

1. Provision a client certificate to the charger (factory-installed, or a CSR
   signed by your CA).
2. Bind its fingerprint: `PUT /v1/charge-points/<id>/client-certificate
   { "fingerprint": "<sha256>" }`.
3. Configure the reverse proxy (Caddy) for `require_and_verify` against your CA
   bundle and forward `X-Client-Cert-Fingerprint`; set `OCPP_TRUST_PROXY_PROTO=true`.
   (Or terminate TLS in the gateway; it then reads the peer cert from the socket.)
4. Raise the unit: `PUT /v1/charge-points/<id>/security-profile { "profile": 3 }`
   (refused until step 2 is done, so a unit can't be locked out by ordering).

Certify against real hardware, your CA, and the OCPP Compliance Test Tool before
production. See `PlugSure-OCPP-Profile3-mTLS-Guide.pdf` for the full step-by-step,
the Caddy configuration, and the test plan.

## Coverage & scope

Delivers certificate-only Profile 3 with per-charge-point binding — the app-layer
enforcement v1.1.1 lacked. **Not** included (operational, roadmap): automated
certificate lifecycle — in-band provisioning/renewal (SignCertificate /
CertificateSigned / InstallCertificate; native in 2.0.1) and revocation
(CRL/OCSP). Sufficient for a fixed fleet with factory-installed certs and periodic
manual rotation.

## Verification (this release)

- `npm run typecheck` → clean.
- `npm test` → **175 unit tests passing, 0 failing** (+13 client-certificate tests
  vs v1.1.1's 162).
- Independent adversarial audit: with Profile 3 disabled (the default and every
  existing v1.1.1 deployment on Profiles 0/1/2), the 1.6J path, the 2.0.1 path, the
  Profile 0/1/2 auth flow, and all non-OCPP subsystems are unaffected. The new code
  path is unreachable until a unit is explicitly escalated to Profile 3.
