# PlugSure CSMS v1.4.4 — release notes

**Date:** 2 October 2026
**Base:** v1.4.3

v1.4.4 fixes what the pre-deployment review of v1.4.0–v1.4.3 found. It has no database migrations and no new application settings. **systemd installs must make one configuration change** (see *Upgrading*).

## Fixes

### The driver app no longer sells charging on a suspended charger
Suspend and resume (v1.4.1) was not reflected in the driver app. A suspended charger's connectors showed as **Available**. Drivers could pay for them, reserve them and be offered them from the queue, and then the charger refused the start, so the money came back only through the refund process.

Now a suspended charger:
- stays on the map, with its connectors shown as **Unavailable** ("Sementara tidak beroperasi");
- refuses quotes, payments and checkouts;
- offers no reservation and refuses one, so no fee is charged and no ReserveNow is sent;
- is never offered to the next driver in a queue.

A charge that was paid *before* the operator suspended the charger is not started either. The driver is told the charger is temporarily out of service, and the charger is not sent a start it would refuse.

### Resume no longer backdates an outage
**Suspending** now closes any open outage, and its offline alert, because a suspension is planned downtime.

**Resuming:**
- A charger that is **connected** is marked online at once. Before, it stayed `offline` until its next boot.
- A charger that is **not connected** gets an outage that starts at the moment of resume. Before, the next sweep dated it from the last contact before the suspension, so the whole suspension counted as downtime in the availability report and a critical "offline" alert fired immediately.

### The database owner password is no longer given to the running apps (systemd)
On the systemd path, `MIGRATION_DATABASE_URL` (the database owner) lived in `/etc/plugsure/plugsure.env`, which both the API and the gateway load. So both processes carried the owner password, which defeats the restricted `plugsure_app` role and the append-only audit log.

Migrations now run in a new one-shot unit, `deploy/plugsure-migrate.service`. Only that unit reads the owner credential, from a root-only `/etc/plugsure/migrate.env`.
- `plugsure-api.service` requires it and starts after it, so every API start still migrates first, and a failed migration still stops the start.
- `plugsure-gateway.service` is ordered after both.

Docker Compose already kept the owner credential in its `migrate` service only and is unchanged.

### Smaller fixes
- **Scan from live charger** no longer offers a roaming partner's card for registration. Registering one would have billed that driver's sessions locally instead of to the partner.
- **Gateway start-up:** the refusals for an insecure production configuration (profile below 2, auto-adoption, profile 2 without TLS or a trusted proxy) now happen before the port is opened. Before, the gateway listened briefly before exiting.
- **OpenAPI:**
  - The remote-start descriptions list the 409 for suspended, unadopted and decommissioned chargers.
  - The `status` descriptions include `suspended`.
  - The suspend and resume descriptions match the new behaviour.
- **Documentation:**
  - `deploy/README.md`:
    - new `migrate.env` and the install steps for the new unit;
    - troubleshooting `psql` commands now run as the owner, because `plugsure_app` sees no rows under row-level security;
    - backup and migration commands updated.
  - `docs/ACCEPTANCE-v1.4.md`:
    - suspend and resume now include the driver-app checks and an accurate account of Resume;
    - decommission says to power-cycle the charger first, because an open connection is not dropped.

## Upgrading

**From v1.4.3 or v1.4.2 on Docker Compose:** deploy the new image and restart. No other change.

**On systemd:**
1. Create `/etc/plugsure/migrate.env`, owned by root:root with mode 0600, containing:
   - `DATABASE_URL=` the owner connection (the old `MIGRATION_DATABASE_URL`);
   - `POSTGRES_APP_PASSWORD=` the `plugsure_app` password.
2. Remove `MIGRATION_DATABASE_URL` and `POSTGRES_APP_PASSWORD` from `/etc/plugsure/plugsure.env`.
3. Install `deploy/plugsure-migrate.service`, and the updated `plugsure-api.service` and `plugsure-gateway.service`, into `/etc/systemd/system/`.
4. Run `systemctl daemon-reload`, then `systemctl restart plugsure-api plugsure-gateway`.

`deploy/README.md` §4–5 has the details.

## Verification

- **Tests:**
  - typecheck clean;
  - unit and database tests, including two new outage tests: one shows the old backdating, the other the fix;
  - a roaming-card case in the scan test, which fails on v1.4.3.
- **End-to-end, all 29 suites in full mode on a fresh database as `plugsure_app`.** New checks:
  - **driver:** a suspended charger is shown Unavailable and refuses a quote and a checkout; a paid charge cannot start once the charger is suspended; a connected charger reads online straight after Resume;
  - **driver-plus:** a suspended charger offers no reservation, refuses one and sends no ReserveNow.
- **systemd units:** checked with `systemd-analyze verify`, which CI now also runs on the new unit.
- **Gateway:** checked to refuse insecure production configurations without opening its port.
