# PlugSure CSMS v1.4.2 — release notes

**Date:** 2 October 2026
**Base:** v1.4.1

v1.4.2 fixes three console defects and two documentation errors found while writing the v1.4.1 user manual. It has no migrations and no new settings, so upgrade by deploying the new build and restarting.

## Fixes

- **RFID & Access → Scan from live charger now finds cards.** It listed nothing, because it looked for the card number at the top of the stored OCPP message instead of inside its body. It now finds cards tapped on OCPP 1.6 chargers (`Authorize`, `StartTransaction`) and 2.0.1 chargers (`Authorize`, `TransactionEvent`) in the last 30 minutes. Cards that are already registered are left out.
- **The sidebar shows the installed version.** It always read `v1.3.0`. The version now comes from the API (`GET /v1/auth/me` → `features.version`, read from `package.json`).
- **Suspended chargers no longer offer Start.** The charger list's quick Start button and the per-gun Start buttons on the Remote control tab are hidden while a charger is suspended. The tab says why. Stop and Unlock cable stay available, so a session already running can still be ended. The API already refused these starts with 409; now the console doesn't offer them.

## Documentation

- **`docs/ACCEPTANCE-v1.4.md`, step 0 health check.** It asked for `curl https://<ocpp-host>/healthz`, which the supplied Caddyfile answers with 404. The step now checks `/healthz` on the server (`127.0.0.1:9220` and `127.0.0.1:9200`) and, from outside, expects `426` from `https://<ocpp-host>/ocpp/<identity>`. The record sheet asks for the exact build tag.
- **`deploy/README.md`, systemd path:**
  - The sample `/etc/plugsure/plugsure.env` pointed `DATABASE_URL` at the database owner. Now `DATABASE_URL` is the runtime role `plugsure_app`, `MIGRATION_DATABASE_URL` is the owner connection `plugsure-api.service` migrates with, and `POSTGRES_APP_PASSWORD` is set.
  - The owner role must be created with `--createrole`, because migrations create and alter `plugsure_app`. Without it the first migration fails with "permission denied to alter role".
  - On PostgreSQL 16, if `plugsure_app` already exists in the cluster, the owner also needs `GRANT plugsure_app TO plugsure WITH ADMIN OPTION`.

## Upgrading from v1.4.1

No database or configuration change. Deploy the build and run `systemctl restart plugsure-api plugsure-gateway`, or restart the containers.

If you followed the old `deploy/README.md` sample and your apps connect as the owner, switch `DATABASE_URL` to `plugsure_app` and add `MIGRATION_DATABASE_URL`. In production, the start-up check already refuses a superuser.

## Verification

- **Build and tests:** typecheck clean; unit and database tests pass, including a new test for the scan, which fails on v1.4.1.
- **Generated files:** the OpenAPI document and TypeScript SDK are regenerated (271 operations).
- **End-to-end, on a fresh database as `plugsure_app`:** console (with a new scan-from-charger check), pilot-fixes and sdk.
- **Browser:** the sidebar version and the hidden Start buttons were checked in Chromium.
- **Migrations:** run as an owner with and without CREATEROLE, to confirm the README fix.
