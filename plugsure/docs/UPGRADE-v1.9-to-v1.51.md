# Upgrading the pilot from v1.9.1 to v1.51.0

This is the one runbook for the live Indonesian pilot, which runs **v1.9.1**. It goes straight to **v1.51.0** (`main` at `085da14`; there is no `v1.51.0` git tag yet, so check out that commit or tag it first). It puts the steps from the 43 release notes in between (v1.9.2 to v1.51.0) in the order you do them. Each release's own notes (`RELEASE-NOTES-v1.x.y.md`) stay the reference for its features.

It is the same shape as `docs/UPGRADE-v1.5-to-v1.9.md`, which brought the pilot to v1.9.

## What changes for the pilot when everything new stays off

| Change | What it means |
|---|---|
| **41 migrations, 078 → 118** | All additive: new tables, new columns, new check values. No table is rewritten and no column is renamed or dropped. One `npm run migrate` applies them in a few seconds on pilot-sized data. |
| **New background jobs (59)** | They start with the gateway. Almost all of them do nothing until their feature is set up (see § 4.3). |
| **The Xendit ledger sync** (v1.12.0) | If the pilot has a Xendit integration, the gateway starts reading its balance and transactions every 15 minutes. It only reads. Without the Balance and Transactions permissions it raises a worker alert (step 1.4). |
| **Console menu reorganised** (v1.41.0) | *Govern* is now *Governance*, and the Finance screens are grouped differently. `deploy/FINANCE.md` § *Finding your way* says where things moved. |
| **Roles** (v1.21.0, v1.32.0) | New built-in roles (Finance Manager, Financial Auditor) and permissions are added at start-up. Existing roles keep what they had. |
| **New dependencies** | `@anthropic-ai/sdk`, `@xmldom/xmldom` and `xml-crypto` (for AI support and SAML). `npm ci` or the Docker image installs them. Node 22 or later as before. |
| **The PlugSure app's link host** (v1.9.2) | `app.plugsure.co.id` serves the mobile app's link pages. This needs the Caddy change in step 2.3. |
| Settings, units, Caddyfile | `.env.example` and the systemd units are unchanged since v1.9.1, so no new setting is required. The Caddyfile changed in comments only, plus the driver-app block for v1.9.2. |

Nothing new is switched on for drivers or chargers until you configure it: WhatsApp sign-in codes, AI support, Duitku, payouts, dynamic pricing, SAML, SCIM, the status page, battery swap, advertising and the rest all wait for their settings.

## 1. Before the window (a day or more ahead)

1. **Rehearse on a copy of production.**
   1. Restore the latest dump into a scratch database.
   2. Re-apply the role default that `pg_restore` drops: `ALTER ROLE plugsure_app IN DATABASE <db> SET app.rls_bypass = 'on'` (`deploy/pitr/RESTORE.md` §2a).
   3. From a v1.51.0 checkout (`npm ci`), run `npm run migrate` against the copy. It must report **078 → 118** applied, with no error.
   4. Start v1.51.0 against the copy. Sign in, open a few sessions, receipts and invoices, and export the sessions CSV. Compare the CSV with one from production: the existing columns must be identical (new columns may be added at the end).
   5. Time the migration. That is your window estimate.

   The migration and the rollback scripts run from a **source checkout** with dev dependencies (`npm ci`), not from the Docker image, which ships only the compiled apps and the migrations. On Docker, run them from a checkout on the host against the published Postgres port.
2. **Check the database size of the big tables.** Migrations 083, 109 and 110 add a check constraint to `payment_intent`, `auth_session` and `charging_session` and new columns to `charging_session` and `payment_intent`. Each migration has a 10-second `lock_timeout` (`MIGRATION_LOCK_TIMEOUT`), so with both processes stopped (step 3.2) nothing can block them. On pilot-sized tables they finish in well under a second.
3. **Tell users** that the console menu changed (v1.41.0): *Govern* → *Governance*, and the Finance pages moved. Point finance users at `deploy/FINANCE.md` § *Finding your way*.
4. **Xendit.** If the pilot uses Xendit, give the secret key saved in PlugSure **read** permission for **Balance**, **Transactions** and **Report** in Xendit's dashboard. Without it, the new ledger sync raises a worker alert every pass. It does not affect payments.
5. **Storage for advertising** (v1.51.0). Charger-screen creatives are kept under `STORAGE_DIR/ads`. Check that `STORAGE_DIR` is on a persistent volume and in the backup. It already holds receipts and uploads.

## 2. Pre-flight on the server (just before the window)

1. **Settings.** No new setting is required. Check these still hold:
   ```bash
   sudo grep -E '^(NODE_ENV|PUBLIC_BASE_URL|SECRETS_KEY|STORAGE_DIR|CONSOLE_PUBLIC_URL)=' /etc/plugsure/plugsure.env
   ```
   - `PUBLIC_BASE_URL` must be the public `https://` host. Duitku (v1.13.0) and the WhatsApp webhooks (v1.10.0) are given URLs built on it.
   - `CONSOLE_PUBLIC_URL` should be the console's public address. SAML (v1.42.0), the status page and SCIM (v1.43.0) build their links on it. Set it now so they work when you switch them on.
   - `BILLING_ISSUER_NPWP` (v1.18.0) is only needed for the platform's e-Faktur.
   - `FX_RATES_URL` is optional (v1.21.0 rates feed).
2. **systemd:** the unit files are unchanged since v1.9.1. Only `plugsure-migrate.service` reads `/etc/plugsure/migrate.env`.
3. **Caddy on `app.plugsure.co.id`** (v1.9.2). The driver-app site block must route the mobile app's link pages to the API (`127.0.0.1:9200`), as in `deploy/DRIVER-APP-PILOT.md` §2:
   ```caddy
   @driver path /app /app/* /d /d/* /.well-known/apple-app-site-association /.well-known/assetlinks.json /c/* /s/* /r/* /paid /account/delete
   ```
   Then run `caddy validate` and `systemctl reload caddy`. This is safe to do before the window: v1.9.1 answers those paths with 404.
4. **`/hooks/*`** must stay reachable from the internet on the OCPP host. The shipped Caddyfile already routes it. The WhatsApp Cloud API (v1.10.0), Duitku and Xendit payout callbacks use it.

## 3. The window (low traffic, about 02:00 WIB; plan 30 minutes, expect 10)

1. Announce it. Take the pre-upgrade backup as the owner, and keep it until the pilot has run two weeks on v1.51.0:
   ```bash
   OWNER_URL=$(sudo sed -n 's/^DATABASE_URL=//p' /etc/plugsure/migrate.env)
   sudo -u plugsure pg_dump "$OWNER_URL" -Fc -f /var/backups/plugsure/plugsure-pre-1.51-$(date +%F-%H%M).dump
   ```
   Or note the point-in-time-recovery position (`deploy/pitr/RESTORE.md`).
2. Stop both processes: `sudo systemctl stop plugsure-api plugsure-gateway`, or `docker compose stop api gateway`. Chargers keep charging on local authorisation and queue their messages.
3. Deploy v1.51.0 and install the new dependencies.
   - **systemd:** check out `085da14` (or the `v1.51.0` tag once it exists), then run `npm ci && npm run build`. Copy `src/web` and `src/driver-web` into `dist/`. The unit files need no change.
   - **Docker:** build the image from that commit (`docker compose build`).
4. Migrate.
   - **systemd:** `sudo systemctl start plugsure-migrate`, then `journalctl -u plugsure-migrate -n 80`.
   - **Docker:** `docker compose run --rm migrate`.

   It applies **078 → 118**. Check with:
   ```bash
   psql "$OWNER_URL" -c "select name from schema_migration order by name desc limit 3"
   ```
   The newest must be `118_screen_advertising.sql`. Migrations do **not** run on their own when the API starts; this step is required.
5. Start the gateway, then the API. Watch:
   - chargers reconnecting and their offline queues replaying;
   - `/healthz` and Governance → Platform health (the new workers appear there; none should be failing);
   - the first sessions, CDRs and payment notifications.

## 4. After the window

1. **Smoke test** as an administrator: open the dashboard, a site, a charger, a session and its receipt; the Finance pages; and Governance → Integrations. Start and stop one charge on a test charger.
2. **The mobile app's link host** (v1.9.2). From the source checkout:
   ```bash
   MOBILITY_LINK_HOST=app.plugsure.co.id \
   MOBILITY_SUPPORT_EMAIL=hello@railsure.co.id \
   MOBILITY_TERMS_URL=https://plugsure.com/terms.html \
   MOBILITY_PRIVACY_URL=https://plugsure.com/privacy.html \
   npm run mobility:setup      # plus MOBILITY_IOS_BUNDLE_ID / _TEAM_ID, MOBILITY_ANDROID_PACKAGE / _CERT_SHA256 when known
   ```
   Then check from outside:
   - `https://app.plugsure.co.id/d/health` answers;
   - `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` answer JSON;
   - `/app/` opens the web app, and `/account/delete` shows the deletion form.
3. **Background jobs.** The new workers only act on what you have set up:
   - e-mails and WhatsApp messages (close e-mail, scheduled reports, digests, dunning reminders, statements of account, platform invoices) go only where recipients and an *on* switch are set;
   - money moves (owner payouts, refunds by transfer, payment runs) need a person, or automatic payouts switched on, and two-person approval where the approvals matrix says so;
   - data retention (v1.48.0, Privacy) clears plates, survey comments and old support cases only when a retention period is set;
   - the rest raise alerts (Governance → Alert routing decides who gets them).

   The Xendit ledger sync (v1.12.0) is the one that runs at once on an existing Xendit integration. It only reads.
4. **Integrations:**
   1. Call one list endpoint and one export with an API key.
   2. Send a test webhook (`POST /v1/webhooks/{id}/test`).
   3. Compare one day's sessions CSV with the day before.

   The API only gained fields and endpoints since v1.9.1. An integration built for v1.9 keeps working.
5. **Alert routing.** Many releases add alert kinds (`finance.*`, `fleet.*`, `charger.health_at_risk`, `grid.demand_response` and more). Unrouted alerts still appear in the console. Route the ones you want under Governance → Alert routing.
6. Keep the pre-upgrade dump for at least two weeks.

## 5. Rollback

- **In the window, or soon after with nothing new used:** stop both processes, restore the pre-upgrade dump, re-apply the `app.rls_bypass` role default, and redeploy v1.9.1 (tag `v1.9.1`).
- **Later, keeping what happened on v1.51.0:**
  1. Export what the new features recorded that you need to keep. Each release's *Rollback* note says what its down script drops: for example driver credit owed (v1.45.0), deposits held (v1.24.0), payouts and transfers in flight at Duitku or Xendit (v1.15.0–v1.17.0), open payment links (v1.25.0, v1.27.0).
  2. Stop both processes.
  3. Run the down scripts from `db/rollback/` **newest first**, as the owner: `118_down.sql`, `117_down.sql`, … down to `078_down.sql`.
     ```bash
     for n in $(seq 118 -1 78); do psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f db/rollback/$(printf %03d $n)_down.sql || break; done
     ```
  4. Deploy v1.9.1 with its own unit files.

  Rehearse this on the copy from step 1.1 before you need it.

## Later (each switch is independent; none is needed for the pilot)

Each feature has its own guide in `deploy/`. `deploy/README.md` § 4 (*Integrations: payments*) lists the optional steps by release, from item 5 (v1.12.0) to item 44 (v1.51.0). The ones operators ask about first:

| Feature | Release | Guide |
|---|---|---|
| WhatsApp sign-in codes (Meta Cloud API), AI support | v1.10.0, v1.11.0 | `deploy/WHATSAPP.md` |
| Duitku fallback payments, disbursement refunds and payouts | v1.13.0–v1.16.0 | `deploy/DUITKU.md` |
| Finance (ledger, payables, close, tax, treasury and the rest) | v1.12.0–v1.41.1 | `deploy/FINANCE.md` |
| SAML single sign-on, SCIM provisioning | v1.42.0, v1.43.0 | `deploy/SAML-SIGN-IN.md`, `deploy/SCIM.md` |
| Dynamic pricing, demand response, the public status page | v1.43.0 | `deploy/DYNAMIC-PRICING.md`, `deploy/DEMAND-RESPONSE.md`, `deploy/STATUS-PAGE.md` |
| Depot charging, OCPP diagnostics bot | v1.44.0 | `deploy/DEPOT-CHARGING.md`, `deploy/DIAGNOSTICS-BOT.md` |
| Support desk, driver credit and gift cards | v1.45.0 | `deploy/SUPPORT-DESK.md`, `deploy/DRIVER-CREDIT.md` |
| Field app, private charging, plates and parking, trip planner | v1.46.0 | `deploy/FIELD-APP.md`, `deploy/PRIVATE-CHARGING.md`, `deploy/PLATES-PARKING.md`, `deploy/TRIP-PLANNER.md` |
| Home charging, card terminals, energy prices, surveys | v1.47.0 | `deploy/HOME-CHARGING.md`, `deploy/CARD-TERMINALS.md`, `deploy/ENERGY-PRICES.md`, `deploy/SURVEYS.md` |
| Hotels, installations, privacy (UU PDP), battery health | v1.48.0 | `deploy/HOTELS.md`, `deploy/INSTALLATIONS.md`, `deploy/PRIVACY.md`, `deploy/BATTERY-HEALTH.md` |
| Battery swap, roadside charging, warranty and RMA, amenities | v1.49.0 | `deploy/BATTERY-SWAP.md`, `deploy/ROADSIDE.md`, `deploy/WARRANTY-RMA.md`, `deploy/AMENITIES.md` |
| Car dealers, charger-screen advertising | v1.50.0, v1.51.0 | `deploy/DEALERS.md`, `deploy/ADVERTISING.md` |

Before switching on AI support (v1.11.0), add to plugsure.com/privacy.html that support messages are kept 90 days and are processed by Anthropic to write replies. Before the first payroll (v1.33.0), have a tax adviser confirm the TER tables and the BPJS caps.

## Migrations in this upgrade

| Migration | Release | Adds |
|---|---|---|
| 078 | v1.10.0 | WhatsApp message log and Meta events |
| 079 | v1.11.0 | Support conversations, AI support integration |
| 080 | v1.12.0 | Gateway ledger, balance snapshots, reconciliation |
| 081–085 | v1.13.0–v1.17.0 | Duitku fallback, owner bank accounts, refund and payout transfers, finance settings |
| 086–108 | v1.18.0–v1.40.0 | The finance suite (one migration per release) |
| — | v1.41.0, v1.41.1 | No migration |
| 109 | v1.42.0 | Solar and storage, charger health, custom reports, SAML |
| 110 | v1.43.0 | SCIM, dynamic pricing, demand response, status page |
| 111 | v1.44.0 | Depot scheduling, queue priority, carbon, diagnostics |
| 112 | v1.45.0 | Support desk, demand forecasting, driver credit, telematics |
| 113 | v1.46.0 | Field app, private charging, plates and parking |
| 114 | v1.47.0 | Home charging, card terminals, energy prices, surveys |
| 115 | v1.48.0 | Hotels, installations, privacy, battery health |
| 116 | v1.49.0 | Battery swap, roadside, warranty and RMA, amenities |
| 117 | v1.50.0 | Dealer partnerships |
| 118 | v1.51.0 | Charger-screen advertising |

Every migration has its down script in `db/rollback/`.
