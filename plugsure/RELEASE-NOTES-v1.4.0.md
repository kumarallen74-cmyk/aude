# PlugSure CSMS v1.4.0 — release notes

**Date:** 2 October 2026
**Base:** v1.3.0 (28 September 2026)

v1.4.0 fixes every finding of the independent review of v1.3.0. The full review is at `../reviews/PLUGSURE-v1.3.0-INDEPENDENT-REVIEW.md` in the delivery, and in the repository next to this package. It covers 12 pilot blockers, 13 public-launch blockers and the remaining hardening items, with a commit per area. No features were added; the work is correctness, security and operations.

Migrations 043–053 are new (045 is unused). All are additive and forward-only. Take a database backup before upgrading.

## Before you upgrade

Outside `NODE_ENV=development`/`test`, the processes now **refuse to start** in each of these cases:

| Condition | What to set |
|---|---|
| `SECRETS_KEY` missing, too short or the README placeholder | 64 hex characters: `openssl rand -hex 32` |
| `OCPP_MIN_SECURITY_PROFILE` below 2, or `OCPP_AUTO_ADOPT=true` (gateway) | Profile 2+ and auto-adopt off. `ALLOW_INSECURE_OCPP=true` is for a supervised bench only. |

`NODE_ENV=staging` (or anything that is not `development` or `test`) is now treated as production.

Roaming needs `OCPI_PUBLIC_URL` (or `PUBLIC_BASE_URL`). Without it, the OCPI API and roaming commands answer 503.

On the systemd path:
- `API_HOST` and the new `OCPP_HOST` default to `127.0.0.1`. Docker Compose and the image set `0.0.0.0` inside the container.
- Set `OCPP_TRUSTED_PROXIES` if your TLS terminator does not connect from loopback.
- Use `systemctl restart`, not `reload`.

The supplied Caddyfile is corrected: the API host no longer proxies operator sign-in. Re-deploy `deploy/Caddyfile`.

## What changed

### Charging and billing correctness

- **Message handling:** a charger's OCPP requests are handled one at a time, in order. Session start is atomic per connector, so duplicate starts can no longer close each other.
- **2.0.1 start register:** a 2.0.1 transaction without a start register no longer bills the charger's lifetime meter. Grossly implausible energy is parked for review.
- **Tariffs:**
  - Tiers count across the whole session.
  - Time-windowed prices are applied once.
  - Idle minutes respect units and phases, and the time component excludes them.
  - A rate of 0 means free.
  - Assignments are versioned and apply from the session start.
- **1.6 stops** bill the final meter reading (`meterStop` or the End register), not the last periodic sample.
- **Offline transactions** with a refused card are kept as unauthorised sessions for review, never lost and never billed automatically.

### Payments

- **Prepaid QR / claim tokens:** a token only works on the connector it was paid for. The claim window runs from payment.
- **Idempotent charges:** post-pay, e-wallet, saved-card and pass charges use deterministic references, saved before the acquirer is called. A retry looks up the status instead of charging again.
- **Pass payments:** must come from the operator's own acquirer account, for the full price.
- **Midtrans captures:** a capture whose response was lost is reconciled.
- **Refunds:** cannot be paid twice, and a database CHECK keeps a refund ≤ the amount captured.
- **Post-pay limits:** the limit counts every session a driver has open.
- **Points and promotions:** reserved atomically. Pre-purchase sessions no longer use loyalty points.

### Security and tenant isolation

- **Row-level security** fails closed. The audit log is append-only, and audit entries of failed actions are kept.
- **Authentication** is decided on the matched route; percent-encoded paths no longer skip it.
- **Privilege escalation is closed:**
  - user management can only grant what the caller holds;
  - each raw charger command needs its own permission.
- **Charger authentication:** proxy headers are trusted only from configured proxies. Certificates are signed only on request, over Profile 2+.
- **Plug & Charge:** certificate chains and OCSP are checked properly, and the check fails closed.
- **Roaming partners** cannot declare their own identity or take over another partner's tokens. Unlinked or implausible partner CDRs are held for review and are not invoiced.
- **Driver sign-in:**
  - OTP and PIN attempts are counted atomically, with per-phone, IP, device, card and global limits.
  - Limit refusals answer 429.
- **Outbound calls** have hard deadlines and the SSRF guard. Provider responses are not echoed to operators.
- **Console:**
  - one-time passwords expire;
  - a password change signs out other sessions;
  - sessions have an idle timeout;
  - dialogs escape their content.

### Fiscal

- **e-Faktur** is dated the last day of the month billed. Already-exported invoices are skipped unless asked for (`reexport=true`).
- **Fleet invoices** use the fleet the card was on at the time of the session.
- **Commission:**
  - tier upper bounds are inclusive (exactly Rp 500M is 6.5%);
  - 'whole' mode has no cliff;
  - sessions count at the site where they ran.
- **Receipts** show a rounding line.
- **Tera/SLO dates** are no longer shown a day early.

### Operations

- **Crashes and shutdown:** an uncaught exception exits and is restarted, and shutdown no longer hangs on open console streams.
- **Logging:** logs redact credentials and mask card IDs, eMAIDs and phone numbers.
- **Background workers:** passes that move money or message people run on one gateway at a time.
- **Retention and backups:**
  - OCPP frames are kept 90 days and connection attempts 30 days.
  - There is a nightly backup script with a systemd timer.
- **Rate limits and uploads:** API-key rate limits are shared across API processes. Diagnostics uploads stream to disk.
- **Migrator:** takes an advisory lock and a lock timeout.
- **CI** runs the database-backed tests and the core end-to-end suites as the restricted role.

## New settings

| Setting | Default |
|---|---|
| `OCPP_HOST` | `127.0.0.1` outside development |
| `OCPP_TRUSTED_PROXIES` | `127.0.0.1,::1` (Compose adds `172.16.0.0/12`) |
| `ALLOW_INSECURE_OCPP` | `false` |
| `SMTP_ALLOWED_INTERNAL_HOSTS` | (none) |
| `DRIVER_OTP_PER_PHONE_PER_DAY` | 10 |
| `DRIVER_OTP_PER_IP_PER_HOUR` | 10 |
| `DRIVER_OTP_PER_DEVICE_PER_HOUR` | 5 |
| `DRIVER_OTP_GLOBAL_PER_DAY` | 5000 |
| `DRIVER_OTP_VERIFY_FAILURES_PER_DAY` | 10 |
| `DRIVER_PIN_FAILURES_PER_IP_PER_HOUR` | 20 |
| `DRIVER_PIN_ATTEMPTS_PER_CARD_PER_DAY` | 15 |
| `TEMP_PASSWORD_TTL_HOURS` | 72 |
| `SESSION_IDLE_MINUTES` | 60 |
| `PG_POOL_MAX` | 20 |
| `PG_CONNECT_TIMEOUT_MS` | 10000 |
| `PG_STATEMENT_TIMEOUT_MS` | 30000 |
| `PG_IDLE_IN_TX_TIMEOUT_MS` | 0 (off) |
| `API_RATE_LIMIT_SHARED` | `true` outside development/test |
| `OCPP_FRAME_RETENTION_DAYS` | 90 |
| `CONNECTION_ATTEMPT_RETENTION_DAYS` | 30 |
| `MIGRATION_LOCK_TIMEOUT` | `10s` |
| `SECRETS_ALLOW_PLAINTEXT` | unset (escape hatch) |
| `BACKUP_*` | see `tools/backup/pg-backup.sh` |

Mobile carriers put many phones behind one address, so the per-IP driver limits may need raising.

## Behaviour operators will notice

- **Chargers:**
  - Suspended chargers boot Pending and refuse new cards; decommissioned ones are refused at connect.
  - A prepaid QR on the wrong connector is refused.
  - Unsolicited certificate requests, and anything below Profile 2, are refused.
  - Registering a charger identity the network has already tried to connect as needs a platform admin.
- **Plug & Charge** refuses when revocation cannot be checked. Organisations that already saved `acceptWhenOcspUnavailable: true` keep it.
- **Roaming:**
  - A partner that is both CPO and eMSP needs two connections.
  - A hub acts for no clients until it sends HubClientInfo.
  - Held partner CDRs are listed at `GET /v1/roaming/cdrs/held`.
- **Accounts and webhooks:**
  - One-time passwords expire after 72 h, and changing a password signs out other sessions.
  - Webhook receivers must answer within 15 s.

## Verification

- **Install and build:** `npm ci`, typecheck and production build are clean on Node 22.
- **Migrations:** 001–053 apply from an empty PostgreSQL 16 database, and a second run is a no-op.
- **Unit and database tests:** 816/816.
- **End-to-end:** all 29 suites pass on a fresh database, with the API and gateway as `plugsure_app`.

| Suite | Result |
|---|---|
| pilot-fixes | 16 |
| isolation | 45 |
| ocpi-auth | 9 |
| console | 96 |
| field | 139 |
| driver | 50 |
| driver-plus | 46 |
| queue | 19 |
| reservation-fees | 12 |
| fleet-billing | 53 |
| pricing | 24 |
| pnc | 37 |
| onboarding | 20 |
| integrations | 22 |
| payment-methods | 21 |
| card-holds | 38 |
| linked-wallets | 19 |
| postpay | 40 |
| ocpi | 74 |
| ocpi-emsp | 63 |
| ocpi-profiles | 36 |
| sdk | 23 |
| v2x | 21 |
| ocmf | 20 |
| sandbox-2x | 17 |
| brand | 28 |
| apns | 20 |
| live-activity | 17 |
| api-sandbox | 38 |

## Unchanged from v1.3.0

These items still have to happen before a public launch:
- the acceptance test on real charger hardware (`docs/ACCEPTANCE-v1.3.md`);
- the QRIS acquirer and SMS/WhatsApp provider contracts;
- the e-Faktur item classification confirmed with a tax adviser;
- a V2G PKI provider for Plug & Charge;
- store accounts for white-label apps.
