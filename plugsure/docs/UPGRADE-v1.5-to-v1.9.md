# Upgrading the pilot from v1.5.0 to v1.9.0

This is the one runbook for the live Indonesian pilot, which runs v1.5.0 with every new feature switched off. It goes straight to v1.9.0 and puts the steps from the v1.5.1, v1.6.0, v1.7.0, v1.7.1, v1.8.0 and v1.9.0 release notes in the order you do them. Integrators (ERP, BI, fleet back offices, roaming partners) read `docs/COMPATIBILITY-v1.5-to-v1.9.md`: an API-key integration built for v1.5.0 keeps working.

What changes for the pilot when everything new stays off:

| Change | What it means |
|---|---|
| **Two-step verification** for console administrators (v1.5.1) | Every administrator enrols an authenticator app at the next sign-in. |
| **Money columns renamed** (migration 060, v1.7.0) | You need a short maintenance window with both processes stopped. API answers still carry the v1.5 field names. |
| **`NODE_ENV` must be set** (v1.5.1) | The systemd units now force `production`. Check your environment file (step 2). |
| **Settlement-recovery worker** (v1.5.1) | On its first run it may capture or refund old payments that were never settled (step 6). |
| **Docker Compose network** (v1.5.1) | It moves to `plugsure-net`. Check `API_TRUSTED_PROXIES`. |
| Hub, Microsoft sign-in, Malaysia/Singapore, Stripe, the mobile app backend | Off unless switched on (§ Later). |

Migrations 055–076 (056 and 064–069 are unused) apply in one `npm run migrate`, in well under a second on pilot-sized data.

## 1. Before the window (a day or more ahead)

1. **Rehearse on a copy of production.**
   1. Restore the latest dump into a scratch database.
   2. Re-apply the role default that `pg_restore` drops: `ALTER ROLE plugsure_app IN DATABASE <db> SET app.rls_bypass = 'on'` (`deploy/pitr/RESTORE.md` §2a).
   3. Run `npm run migrate` with v1.9.0.
   4. Run `DATABASE_URL=<copy> npx tsx tools/multicountry/rerate-compare.mts` with production's tax settings. It must report **zero differences**. It reads only.
   5. Start v1.9.0 against the copy, sign in, open a few sessions, receipts and invoices, and export the sessions CSV. Compare the CSV with one from production: the columns must be identical.

   `rerate-compare` and the rollback scripts run from a **source checkout** with dev dependencies (`npm ci`), not from the Docker image, which ships only the compiled apps and the migrations. On Docker, run them from a checkout on the host against the published Postgres port.
2. **Tell administrators** that the console will ask them to set up two-step verification (an authenticator app) at their next sign-in, and to keep the ten recovery codes. For a staged rollout, set `CONSOLE_MFA_REQUIRED=false` first and remove it once everyone has enrolled. Have them enrol **right after the upgrade**: until an administrator has enrolled, someone holding only their password could enrol first.
3. **Settlement recovery.** Set `SETTLEMENT_RECOVERY_NOT_BEFORE` to the planned upgrade time (e.g. `2026-10-12T02:00:00+07:00`), so the new worker only settles payments rated after the upgrade (step 6).
4. **Roaming through an external hub?** Check v1.7.1's notes. A hub partner must now send `OCPI-from-*` headers. Peer partners are unaffected.

## 2. Pre-flight on the server (just before the window)

- **`NODE_ENV`.** v1.5.0's `.env.example` shipped `NODE_ENV=development`. On systemd, `EnvironmentFile=` overrode the unit's value, so a pilot whose `/etc/plugsure/plugsure.env` was copied from it has been running with development behaviour. The v1.9.0 units force production, and then the gateway refuses to start on anything development allowed. So check:
  ```bash
  sudo grep -E '^(NODE_ENV|OCPP_MIN_SECURITY_PROFILE|OCPP_AUTO_ADOPT|SECRETS_KEY|PUBLIC_BASE_URL)=' /etc/plugsure/plugsure.env
  ```
  - `OCPP_MIN_SECURITY_PROFILE` must be 2 or more.
  - `OCPP_AUTO_ADOPT` must not be `true`.
  - `SECRETS_KEY` must be 64 hex characters.
  - `PUBLIC_BASE_URL` must be `https://`, on the OCPP host.

  Remove a `NODE_ENV=development` line. Cookies become `Secure` and the gateway binds `127.0.0.1` behind Caddy.
- **Docker Compose:** if `API_TRUSTED_PROXIES` or `OCPP_TRUSTED_PROXIES` name the old bridge address or `172.16.0.0/12`, change them to `PLUGSURE_NET_GATEWAY` (default `172.31.253.1`).
- **systemd:** the v1.4.4 split is unchanged. Only `plugsure-migrate.service` reads `/etc/plugsure/migrate.env`.

## 3. The window (low traffic, about 02:00 WIB; plan 15 minutes, expect 5)

1. Announce it. Take the pre-upgrade backup as the owner, and keep it until the pilot has run a week on v1.9.0:
   ```bash
   OWNER_URL=$(sudo sed -n 's/^DATABASE_URL=//p' /etc/plugsure/migrate.env)
   sudo -u plugsure pg_dump "$OWNER_URL" -Fc -f /var/backups/plugsure/plugsure-pre-1.9-$(date +%F-%H%M).dump
   ```
   Or note the point-in-time-recovery position (`deploy/pitr/RESTORE.md`).
2. Stop both processes: `sudo systemctl stop plugsure-api plugsure-gateway`, or `docker compose stop api gateway`. Chargers keep charging on local authorisation and queue their messages.
3. Deploy v1.9.0 and install the new dependencies.
   - **systemd:** check out the `v1.9.0` tag, then run `npm ci && npm run build`. Copy `src/web` and `src/driver-web` into `dist/` and install the unit files from `deploy/`.
   - **Docker:** pull or build the `v1.9.0` image.
4. Migrate.
   - **systemd:** `sudo systemctl start plugsure-migrate`, then `journalctl -u plugsure-migrate -n 50`.
   - **Docker:** the `migrate` service.

   It applies 055 → 076.
5. Run `npx tsx tools/multicountry/rerate-compare.mts` against production from the checkout. It must report **zero differences**. Otherwise roll back (§5).
6. Start the gateway, then the API. Watch:
   - chargers reconnecting and their offline queues replaying;
   - `/healthz` and Govern → Platform health;
   - the first CDRs and payment notifications.

## 4. After the window

1. **Every administrator signs in and enrols two-step verification.** A lost phone is reset by another administrator (Users & Roles → Reset two-step verification; API keys cannot do this). For the last administrator, on the server: `npm run create-admin -- --email <admin> --org-slug <org> --reset-2fa`. This is the whole create-admin command, so besides removing two-step verification and ending that administrator's sessions it also:
   - sets a new one-time password, printed on the console, unless you pass `--password`;
   - makes the account a super administrator of that organisation.

   Hand the password over in person, and remove the role afterwards if they should not keep it.
2. **Settlement recovery.**
   1. Run `npm run settlement:report`. It reads only and lists payments from before the upgrade that were never settled.
   2. Check each one against the Midtrans/Xendit dashboards and settle by hand any that operations already handled.
   3. Then remove `SETTLEMENT_RECOVERY_NOT_BEFORE` and restart the gateway, so the worker takes the genuinely open ones.
3. **Integrations:**
   1. Call one list endpoint and one export with an API key.
   2. Send a test webhook (`POST /v1/webhooks/{id}/test`).
   3. Compare one day's sessions CSV with the day before.

   v1.5 field names are still sent, with a `Deprecation` header.
4. **Recommended, from v1.5.1:**
   - point-in-time recovery: `deploy/pitr/RESTORE.md`, which needs a PostgreSQL restart;
   - `HEARTBEAT_URL`, plus an alert-routing rule for `platform.*` to an on-call rota.
5. Keep the pre-upgrade dump for at least a week.

## 5. Rollback

`deploy/README.md` §7 has the full procedure, rehearsed for v1.9.0.

- **In the window:** stop both processes, restore the pre-upgrade dump, re-apply the `app.rls_bypass` role default, and redeploy v1.5.0.
- **Later, keeping what happened on v1.9.0:**
  1. Stop both processes.
  2. Export `app_driver_deletion`.
  3. Run `075_down`, `074_down`, `073_down`, `072_down` and `060_down` from `db/rollback/`.
  4. `DELETE FROM auth_session WHERE mfa_pending`.
  5. Deploy v1.5.0 with its own unit files.

## Later (each switch is independent; none is needed for the pilot)

| Feature | Switch | Guide |
|---|---|---|
| Sign in with Microsoft | `MS_CLIENT_ID`, `MS_CLIENT_SECRET_FILE` | `deploy/MICROSOFT-SIGN-IN.md` |
| Malaysian / Singapore sites, Stripe | `MULTI_COUNTRY=true` | RELEASE-NOTES-v1.7.0 § "MY/SG later", `deploy/STRIPE.md` |
| PlugSure Hub (OCPI roaming hub) | `HUB_ENABLED=true`, `HUB_PUBLIC_URL`, the `hub.*` Caddy block | `deploy/HUB-OPERATIONS.md`, `deploy/HUB-ONBOARDING.md` |
| The PlugSure mobile app | `npm run mobility:setup` (PlugSure Mobility, its own organisation), its link domain in DNS (served by Caddy's catch-all block), the FCM service account and APNs key | `docs/MOBILE-APP-SPEC.md` §15, `deploy/DRIVER-APP-PILOT.md` |

Two guards in `mobility:setup`:
- It refuses to turn an organisation that already has its own driver app into the PlugSure app. Use a separate organisation, or set `MOBILITY_CONVERT_BRAND=1` if that conversion is really intended.
- It refuses `MOBILITY_JOIN_HUB` while the hub is off.

Behaviour changes worth briefing operators on:
- An Indonesian fleet card with a spending limit is refused at a partner location whose currency PlugSure does not support, or cannot determine. v1.5 allowed it and counted only IDR.
- An underpaid payment notification is now voided and refunded in full, with a critical alert. v1.5 left it pending.
- A driver's sign-in code works only on the device that asked for it.
