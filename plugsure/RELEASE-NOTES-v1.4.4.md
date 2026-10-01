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

A charge that was paid *before* the operator suspended the charger is not started either. The driver is told the charger is temporarily out of service and that any unused payment will be refunded, and the charger is not sent a start it would refuse. The unused-payment sweep then refunds it.

A reservation fee paid *after* the charger was suspended holds nothing and sends no ReserveNow, and the fee is marked for refund.

**Suspending also releases what drivers already hold on the charger:**
- live reservations are cancelled (CancelReservation), and their fee is waived or refunded whatever the grace period, so it is not counted as a no-show;
- queue offers go back to waiting, so the driver keeps their place.

- roaming partners' reservations (OCPI) on the charger are cancelled too;
- the drivers concerned get a push notice ("Reservasi dibatalkan" / "Giliran Anda ditunda").

The database changes happen in the suspend request; CancelReservation, the notices and the queue's next offer are sent after it has committed. A ReserveNow still in flight when the charger is suspended cannot revive the reservation. A reservation that had already lapsed before the suspension is left to expire normally. The suspend response reports how many were released (`reservationsReleased`).

**Known limitation:** a driver put back to waiting keeps their original join time, so on a site with a short maximum wait their place can expire soon after.

The operator API's walk-up QRIS checkout (`POST /v1/checkout/qris`) also answers 409 for a suspended, unadopted or decommissioned charger, or a connector on maintenance hold.

The new driver messages have English translations.

### Resume no longer backdates an outage
**Suspending** now closes any open outage, and its offline alert, because a suspension is planned downtime.

**Resuming:**
- A charger that is **connected** is marked online at once. Before, it stayed `offline` until its next boot.
- A charger that is **not connected** is marked offline from the moment of resume, and its outage starts then. Before, the next sweep dated it from the last contact before the suspension, so the whole suspension counted as downtime in the availability report and a critical "offline" alert fired immediately.

### The database owner password is no longer given to the running apps (systemd)
On the systemd path, `MIGRATION_DATABASE_URL` (the database owner) lived in `/etc/plugsure/plugsure.env`, which both the API and the gateway load. So both processes carried the owner password, which defeats the restricted `plugsure_app` role and the append-only audit log.

Migrations now run in a new one-shot unit, `deploy/plugsure-migrate.service`. Only that unit reads the owner credential, from a root-only `/etc/plugsure/migrate.env`.
- `plugsure-api.service` and `plugsure-gateway.service` each start it as a privileged `ExecStartPre=+…systemctl start`. So every start or restart runs the migrator first, and a failed migration fails that start. `Restart=always` then retries it, for example while the database is still coming up at boot.
- The gateway therefore never starts against an old schema either.
- The nightly backup's `/etc/plugsure/backup.env`, which also holds the owner credential, is now root-only (0600).
- Both app units hide `migrate.env` and `backup.env` with `InaccessiblePaths=`.
- Both app units set `TimeoutStartSec=infinity`, so a long migration (bounded by the migrate unit's own 600 s) is not reported as a failed start while it runs.

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
    - new `migrate.env` (with its optional keys) and the install steps for the new unit;
    - owner commands for checks, backups and troubleshooting use `OWNER_URL`, which is read out of `migrate.env` safely and works on local Postgres and RDS, with the Docker Compose equivalent alongside. Before, they ran as `plugsure_app`, which sees no rows under row-level security;
    - backup and migration commands updated.
  - `docs/DEPLOYMENT-GUIDE-v1.3.html` is marked superseded.
  - `docs/ACCEPTANCE-v1.4.md`:
    - suspend and resume now include the driver-app checks and an accurate account of Resume;
    - decommission says to power-cycle the charger first, because an open connection is not dropped.

## Upgrading

**From v1.4.3 or v1.4.2 on Docker Compose:** deploy the new image and restart. No other change.

**On systemd:**
1. Create `/etc/plugsure/migrate.env`, owned by root:root with mode 0600, containing:
   - `DATABASE_URL=` the owner connection (the old `MIGRATION_DATABASE_URL`);
   - `POSTGRES_APP_PASSWORD=` the `plugsure_app` password.
2. Remove `MIGRATION_DATABASE_URL` and `POSTGRES_APP_PASSWORD` from `/etc/plugsure/plugsure.env`. If the nightly backup is installed, also make `/etc/plugsure/backup.env` root:root 0600.
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
  - **driver-plus:** a suspended charger offers no reservation and refuses one, with no ReserveNow sent; suspending with a live reservation sends CancelReservation, tells the driver by push, and leaves no reservation to lapse into a no-show;
  - **reservation-fees:** a fee paid after suspension holds nothing and is owed back;
  - **pilot-fixes:** the operator QRIS checkout is refused for a suspended charger, and a charger resumed while disconnected is offline from now.
- **systemd units:** checked under systemd 255, the version in Ubuntu 24.04, with the real unit files and a stand-in for `node`:
  - every start and restart of the API and gateway runs the migrator first, as `plugsure` with the owner credential;
  - the running API and gateway get only the `plugsure_app` connection, and cannot read `migrate.env` or `backup.env`;
  - a failed migration fails the start, and `Restart=always` recovers once the database is back;
  - `systemd-analyze verify`, which CI now also runs on the new unit, reports no syntax errors.
- **Gateway:** checked to refuse insecure production configurations without opening its port.
