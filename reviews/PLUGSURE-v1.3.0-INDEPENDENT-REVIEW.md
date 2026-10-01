# PlugSure CSMS v1.3.0: independent review

**Date:** 30 September 2026
**Input:** `plugsure-v1.3.0.zip` (463 files, about 65k lines of TypeScript in `src/`, 42 migrations), plus the vendor's Final Audit, Readiness Review and Deployment Guide PDFs.
**Scope:** the whole codebase, covering:
- the OCPP gateway, the operator API and console, and tenant isolation;
- payments, billing and tax, and OCPI roaming;
- the driver app, deployment and CI.

The vendor's documents were checked against the code.

---

## 1. Verdict

**I do not agree with "ready for a supervised pilot" as-is.**

What holds up:
- The engineering is well above average. There is a genuine test culture and careful comments.
- The package builds, typechecks and passes its own suites.
- Tenant isolation holds for normal authenticated API calls.

What stops a pilot:
- Several defects would bill the wrong amount or let a charge happen without payment. These are in OCPP message handling, tariff rating and prepaid authorisation.
- Some permission checks can be bypassed.
- Some secret material fails open when configuration is missing.
- None of these are found by the vendor's suites, because the suites test the intended flows and not these edge cases.

**Before a supervised pilot:** fix the 12 items in §3.1. Most are small, local changes.

**Before public paid charging:** also fix §3.2 (payments, driver sign-in, roaming). That is on top of the two provider accounts the vendor already lists.

---

## 2. What I ran myself

Environment: Node 22.22.2, PostgreSQL 16.13 and TZ=Asia/Jakarta. The API and gateway ran as separate processes, connected as the restricted `plugsure_app` role, so row-level security was active.

| Check | Result |
|---|---|
| `npm ci` from the lockfile | clean. The "KNOWN BLOCKER" comment in `ci.yml` about `@types/ws` is out of date. |
| `npm run typecheck` | clean |
| Migrations 001–042 on an empty PG16 database, then run again | clean; the second run does nothing |
| `npm test` with the default `DATABASE_URL` | **505/505**. The 10 database-backed test files are **skipped** without saying so. They only run when the database name is `plugsure_audit_fix`. |
| `npm test` against `plugsure_audit_fix` with `AUDIT_HMAC_KEY` set | **571/571**, which matches the audit |
| e2e:isolation | 45/45 |
| e2e:ocpi-auth | 9/9 |
| e2e:ocpi | 74/74 |
| e2e:driver | 50/50 |
| e2e:field (`E2E_QUICK=1`) | 132/132 once `OCPP_VERSIONS` includes 2.0.1. With the code default (1.6 only), the 2.0.1 cases fail at the handshake; this is documented. |
| e2e:console | 93/94. One failure: "FOTA: scheduler dispatched UpdateFirmware". Root cause not established; it may be environmental. |
| e2e:postpay | incomplete. My local Postgres was lost mid-run for a sandbox reason unrelated to PlugSure. |

I also exploited two findings live:
- The percent-encoded path trick in §3.1 #6 skips authentication on the running API.
- `/%761/sites` returned 500 where `/v1/sites` returned 401. `POST /%761/charge-points` and `POST /%761/checkout/qris` reached input validation with no credentials at all.

**Important for CI:** `.github/workflows/ci.yml` does not do what it appears to do:
- It runs unit tests against a database named `plugsure`, so every database-backed test is skipped.
- It never runs an e2e suite.
- It never connects as `plugsure_app`.
- Its `docker` job starts the API with `NODE_ENV=production`, no `AUDIT_HMAC_KEY` and a superuser connection. Both startup checks refuse that configuration, so the job cannot pass as written.

---

## 3. Findings

Legend:
- ✅ **Verified**: I re-read the code path myself and, where noted, reproduced it.
- 🔎 **Traced**: from the specialist reviewers' code tracing and scripts. The file and line references are precise, but I did not independently re-run them.

Paths are relative to the package root.

### 3.1 Fix before a supervised pilot

| # | Sev | Finding | Where | Status |
|---|---|---|---|---|
| 1 | **Critical** | **OCPP frames from one charger are handled concurrently, not in order.** `void this.onMessage(...)` is never awaited, although the comment says frames are processed in order. Offline-replay bursts run StartTransaction, MeterValues and StopTransaction in parallel. Two copies of the same StartTransaction can both pass the "existing session" check; the second then closes the first as "superseded", so the charger keeps charging on a closed session and the energy is lost. The duplicate-reply cache is only filled after a handler finishes, so it does not catch back-to-back duplicates. | `src/ocpp/rpc.ts:211`; `adapter16.ts:303-317`; `sessions.ts:791` | ✅ |
| 2 | **Critical** | **An OCPP 2.0.1 session with no start register bills the charger's lifetime meter.** `meterStartWh = energyWhFrom(mv) ?? 0`, and `meterValue` on Started is optional in 2.0.1. The first Updated sample (for example 8,450,000 Wh) becomes the session energy. No check compares energy against connector power × duration. | `src/ocpp/adapter201.ts:375`; `src/services/sessions.ts:113,215` | ✅ |
| 3 | **High** | **`SECRETS_KEY` is not enforced.** If it is unset, every sealed secret uses `sha256('plugsure-development-secrets-key')`, a constant printed in the source. That covers acquirer keys, OCPI tokens, webhook secrets, e-wallet and card tokens, the VAPID key and the charger CA key. Any non-hex string is also accepted, including the README placeholder. The comment "the process refuses to start without it" is false; only docker-compose's `:?` guard protects you, and the systemd path has none. | `src/services/secrets.ts:17-22`; `charge-card.ts:142` | ✅ |
| 4 | **High** | **Privilege escalation through user management.** Any `user:write` holder, including an API key issued with only that permission, can create a `super_admin` or reset any user's password. That includes a user holding `platform:admin` in the same organisation. `assertGrantable` is applied to API keys but not to users. | `src/api/console-routes.ts:872,899,936`; `services/users.ts:221` | ✅ |
| 5 | **High** | **`charge_point:command` bypasses the firmware, smart-charging and security guards.** The generic `/commands/:command` route accepts `update-firmware` with any `location` URL, `set-charging-profile` / `clear-charging-profile` without `smartcharging:write` or the site power-budget caps, and `change-configuration` of `AuthorizationKey` / `SecurityProfile`, which the config route blocks. `api_client`, `field_technician` and `technician` hold this permission. | `src/api/server.ts:472-600` | ✅ |
| 6 | **High** | **Authentication is decided on the raw `req.url` prefix.** `/%761/...`, or an absolute-form request target, reaches `/v1` handlers with the auth, CSRF, must-change-password and org-scope (RLS) hooks all skipped. Today it fails closed only because handlers crash on `req.principal === undefined`. That still gives an unauthenticated exists/doesn't-exist oracle across tenants (500 vs 404), and one refactor would turn it into full access. The driver API (`/d/v1`) has the same pattern. | `src/api/server.ts:170,205,282`; `src/driver/server.ts:186,214` | ✅ reproduced |
| 7 | **High** | **The gateway trusts `X-Forwarded-Proto` and `X-Client-Cert-Fingerprint` from any peer.** It listens on all interfaces with no host setting. Anyone who reaches :9220 directly can present a victim's (non-secret) certificate fingerprint and log in as a Profile 3 charger. This is so on the systemd path, or with `OCPP_BIND=0.0.0.0`. Separately, when the gateway terminates TLS itself it never checks `socket.authorized`. | `src/ocpp/server.ts:105,432`; `client-cert.ts:76-86` | 🔎 |
| 8 | **High** | **The quick-start configuration is an open gateway.** `.env.example` sets `OCPP_MIN_SECURITY_PROFILE=0` and `OCPP_AUTO_ADOPT=true`, and compose loads it with `NODE_ENV=production`. Nothing refuses that combination at startup. Auto-adopt also ignores `OCPP_AUTO_ADOPT_SITE`: it puts unknown chargers into the oldest site of any tenant, with status `provisioning`, so they can bill immediately. | `.env.example:10-11`; `services/assets.ts:71-83` | ✅ |
| 9 | **High** | **Public sign-in on `api.example.id`.** In Caddy's directive order, `handle` runs before `respond`. `handle @api` therefore proxies `/v1/auth/login` and the intended `respond @signin 404` never runs. The result is operator-password spraying and account-lockout DoS from the internet, bypassing the office allow-list. The login counter is also raced: it is read, incremented in JavaScript and written back. | `deploy/Caddyfile:340-355`; `services/users.ts:127-146` | ✅ (Caddyfile read; directive order per Caddy docs) |
| 10 | **High** | **Tariff rating errors that under- or over-bill.** Three separate defects:<br>(a) Energy tiers are applied within each time-of-use block, not across the session. A 60 kWh session split 30/30 across 17:00 never reaches tier 2.<br>(b) Time-windowed energy components are double-priced across a window boundary: 20 kWh was billed as 40 kWh. The session is then parked, and the driver's live running cost shows double.<br>(c) Idle minutes compare raw `meter_value.value` with a fixed ≥ 50 threshold, whatever the unit or phase. Chargers reporting in kWh get the whole session billed as idle, or never any idle fee. | `src/services/tariff.ts:506-552,540`; `sessions.ts:1004-1024` | 🔎 (the reviewer ran `rateSession` with these inputs) |
| 11 | **High** | **Background workers run on every gateway, with no leader election.** `RUN_WORKERS` defaults to true. With two gateway replicas, pass auto-renewal captures the saved card twice. The second charge then fails its insert on the unique index and is never recorded. Holds, refunds, the load-management (DLM) loop and FOTA also run twice. | `src/services/workers.ts:160,183`; `driver/membership.ts:384-430` | 🔎 |
| 12 | **Medium** | **Several security switches test `NODE_ENV === 'production'` exactly.** With `staging`, `prod`, or `NODE_ENV` unset:<br>• the OTP `devCode` is returned to the caller, so anyone can sign in as any driver;<br>• the SSRF guard is off;<br>• sandbox checkout can mark payments paid;<br>• a superuser database role is allowed;<br>• the cookie is not `Secure`. | `driver/identity.ts:161`; `net-guard.ts:18`; `integration-routes.ts:144-180`; `db/pool.ts:290` | 🔎 |

### 3.2 Fix before public paid charging

| # | Sev | Finding | Where | Status |
|---|---|---|---|---|
| 13 | **High** | **A prepaid QR/claim token works on any connector of the operator.** On the wrong connector the claim finds nothing, so the session starts as `postpaid` with no allowance and no payer. The unclaimed payment is then refunded in full after 35 minutes, which means free, unlimited charging. The same trick works while the first session is running. | `src/ocpp/adapter16.ts:574-590`; `sessions.ts:1156-1187`; `refunds.ts:57-75` | ✅ |
| 14 | **High** | **Pass (membership) payments are not bound to the acquirer account and have no amount check.** A tenant with its own Midtrans key can sign a `settlement` for another operator's pass order id and mark it paid. `payment_intent` has this check (`integration_id`); `subscription_charge` does not. | `src/services/payments/registry.ts:442-455` | ✅ |
| 15 | **High** | **Post-pay and e-wallet charges are not idempotent.** `chargeWallet` mints a random order id or idempotency key on every attempt, and saves the reference only after the acquirer replies. If a timeout happens after a successful charge, the retry charges again, and the first charge's settlement is dropped as `unknown_payment`. | `payments/holds.ts:289-299`; `midtrans.ts:624`; `xendit.ts:134-138`; `driver/charge.ts:343-406` | 🔎 |
| 16 | **High** | **Driver OTP attempts are raced.** The code reads `attempts`, compares, then increments, with no atomic claim, so a parallel burst checks hundreds of guesses against one code. A new code resets the counter. There is no per-IP or daily cap on `/otp/send`, so an attacker can run up SMS/WhatsApp bills. The fleet PIN counter has the same race, and PINs are only 4 digits. | `src/driver/identity.ts:137-191,244-272` | ✅ (OTP) / 🔎 (PIN, SMS) |
| 17 | **High** | **An OCPI partner can declare its own identity.** `roles`, `country_code`, `party_id` and `kind` (including `HUB`) are taken from the partner's `/credentials` body. A hub that has not yet sent HubClientInfo "acts for anyone". The `upsertToken` ON CONFLICT clause sets `partner_id = EXCLUDED.partner_id`, so one partner can take over another's tokens and re-validate a revoked one. | `src/ocpi/registration.ts:105-146`; `ocpi/store.ts:81-91,429-438`; `ocpi/server.ts:230-241` | ✅ |
| 18 | **High** | **Any connected partner can post CDRs onto fleet invoices.** `GET /emsp/tokens` returns every shared card to every partner. `POST /emsp/cdrs` accepts any amount, including negative ones, with no session or authorisation link. The CDRs go straight onto fleet invoices and count against spend limits. | `src/ocpi/emsp.ts:291-322`; `ocpi/server.ts:319-392`; `fleet-calc.ts:175-181` | 🔎 |
| 19 | Medium | **Midtrans hold capture has no idempotency.** A lost reply leads to `capture_failed` plus a critical alert, although the money was taken, and the `capture` notification does not reconcile it. | `midtrans.ts:676-687`; `registry.ts:393-396` | 🔎 |
| 20 | Medium | **A refund can be paid twice (by the provider and by manual bank transfer).** Manual completion is allowed while a provider refund is `processing`. Xendit `pending` refunds are never polled. No database constraint stops `refund_due > captured`. | `services/refunds.ts:134-166` | 🔎 |
| 21 | Medium | **The post-pay limit can be bypassed with concurrent sessions**, because only `capturing`/`capture_failed` sessions count as outstanding. | `registry.ts:205-213`; `holds.ts:318-327` | 🔎 |
| 22 | Medium | **Loyalty points and promotion limits can be over-used.**<br>• Points are priced without a lock and consumed later, with errors swallowed, so concurrent rating spends them twice.<br>• On prepaid sessions the points discount is refunded as cash.<br>• Promotion budgets and per-customer caps are checked, then recorded, so concurrent sessions exceed them.<br>• A new device id resets "new driver" eligibility. | `sessions.ts:577-585,678-682,764-766`; `loyalty.ts:209-222`; `benefits.ts:363-459` | 🔎 |
| 23 | Medium | **One slow receiver stalls every tenant's webhook and OCPI delivery.** There is only an idle-socket timeout and no total deadline, and each worker pass is single-flight with `Promise.all`. The same trick hangs OCPI real-time authorisation. | `services/webhooks.ts:80-157`; `ocpi/client.ts:296-322`; `workers.ts:104-125` | 🔎 |
| 24 | Medium | **Tenant-configured outbound URLs skip the SSRF guard.** This covers the payment `baseUrl`, the SMS gateway, the Twilio, Zenziva and WhatsApp bases, and SMTP host:port. Connection tests echo 120–160 characters of the response body. | `payments/provider.ts:325-335`; `notify-transports.ts:60-196`; `integration-routes.ts:229` | 🔎 |
| 25 | Medium | **An OCPI command `response_url` can be derived from the `Host` / `X-Forwarded-Host` header** when `OCPI_PUBLIC_URL` is unset. The partner then POSTs command results, carrying our credentials token, to a host of the attacker's choosing. | `driver/server.ts:662`; `api/roaming-routes.ts:25`; `ocpi/server.ts:43` | 🔎 |

### 3.3 Medium: operability, protocol and isolation hardening

**Tenant isolation**
- **RLS fails open, and "every business table" is not accurate.**
  - Every policy is `app_current_org() IS NULL OR org_id = app_current_org()`. The gateway, workers, `/d/*`, `/ocpi/*`, `/pay/*` and SSE therefore run as `plugsure_app` and see every tenant.
  - These tables have no RLS: `audit_log`, `auth_session`, `role`, `user_role`, `connector`, `evse`, `meter_value`, `ocpp_frame`, `tariff_component`, `tariff_assignment`, `charging_profile`, `connection_attempt`, `app_driver`, `driver_card`, `push_subscription`, `driver_charge`.
  - `can()` lets `platform:admin` satisfy every permission in every org.
  - Authenticated requests are still correctly scoped, and e2e:isolation 45/45 confirms that.
  - Location: `db/migrations/002_hardening.sql` and later migrations.
- **The runtime role can UPDATE/DELETE `audit_log`**, and the HMAC key is in the same process, so the audit chain only detects tampering by someone with database access alone (`006_runtime_role.sql:53,57`).
- **Audit rows for failed operations are rolled back** with the 4xx transaction, e.g. `refund.failed` (`services/audit.ts`; `api/server.ts:140-147`).
- **Charger identities are first-come across the platform.** Any tenant can pre-register another operator's identity and then read its pre-registration connection history (`api/server.ts:741,816`; `connections.ts:100`).

**OCPP protocol handling**
- **Suspended and decommissioned chargers are still Accepted** at boot and can open billable sessions (`adapter16.ts:153`; `adapter201.ts:246`).
- **Rejected authorisations discard the transaction.** 1.6 returns transactionId 0 and 2.0.1 creates no session, so offline transactions with a since-blocked card are lost (`adapter16.ts:287`; `adapter201.ts:430`).
- **In 2.0.1, a token presented after Started is ignored.** With TxStartPoint=EVConnected the token arrives on an Updated event and is never authorised or bound (`adapter201.ts:427-445`).
- **1.6 StopTransaction bills the last sampled value rather than `meterStop`**, silently under-billing up to 500 Wh / 2% per session (`adapter16.ts:429`).
- **Learned charger quirks are global, keyed by self-reported vendor and model.** One tenant's charger can switch every Autel unit to watts-based profiles, so the PLN capacity ceiling is not applied (`provisioning.ts:83-99`; `quirks.ts`; `smartcharging.ts:521`).
- **The charger CA signs unsolicited SignCertificate CSRs at any security profile.** This can mint lasting Profile 3 credentials (`charger-ca.ts:225-270`).
- **Plug & Charge chain and OCSP checks are weak.** Basic constraints (`CA:TRUE`) and path length are not checked, OCSP freshness is not checked, and the check fails open when OCSP is unavailable. The reviewer forged a contract certificate that validated (`pnc/service.ts:215-261`; `pnc/der.ts:413-455`).
- **1.6 provisioning messages are sent to 2.0.1 stations untranslated**, and a charger-reported `NumberOfConnectors` drives an unbounded loop (`provisioning.ts:103-110`).

**Billing and fiscal**
- **e-Faktur `TaxInvoiceDate` is the issue date, which is always in the following month.** A faktur gabungan must be dated by the last day of the delivery month (`fleet-billing.ts:650`; `efaktur.ts:109`).
- **Fleet invoices use the card's current fleet, not the fleet at session time** (`fleet-billing.ts:270`).
- **Tariff assignments have no effective dates.** Unassigning a tariff re-rates parked sessions at the default price (`tariff-store.ts:52-72`).
- **The time component also bills idle minutes**, so overstay is charged twice (`tariff.ts:603`).

**Process and deployment**
- **The database pool has no connection timeout, `statement_timeout` or error listener.** Every `/v1` request holds a pooled connection in a transaction, including 512 MB firmware uploads (`db/pool.ts:10-14`).
- **`systemctl reload plugsure-gateway` kills the gateway**: `ExecReload` sends HUP, and nothing handles it.
- **`API_HOST` defaults to `0.0.0.0`**, where the docs say `127.0.0.1`.
- **`uncaughtException` is logged and the process continues.**
- **API shutdown hangs while a console SSE stream is open.**
- **`ocpp_frame` and `connection_attempt` grow without limit**: no retention, and no automated backups.
- **RFID idTags and eMAIDs are logged in plain text**, with no pino `redact` configuration.
- **API-key rate limits are per process only.**

### 3.4 Low (selected)

**OCPP and charger security**
- Issuing an AuthorizationKey twice before the charger applies it locks the charger out, and a leaked key keeps working for 24 hours.
- Signed-meter (OCMF) begin/end readings are not tied to one transaction.
- A late pong from a replaced socket counts for the new one.
- CALLRESULT payloads are not validated.
- `assertRlsPosture` fails open if its own query errors.

**Payments and billing**
- A zero-rate tier is billed at the PLN formula rate.
- Commission tier boundary at exactly Rp 500M, and a cliff in `whole` mode.
- Commission uses the charger's current site, not the site at session time.
- Receipt lines don't add up when `ROUNDING_UNIT_IDR > 1`.
- Tera and SLO dates are shown one day early under `TZ=Asia/Jakarta`.
- The e-Faktur export re-includes invoices already exported.
- The prepaid claim window runs from checkout, not from payment.
- The Xendit callback parser has no event allowlist, so GoPay link events are dropped.
- BI-SNAP notifications have no timestamp freshness check and re-serialise the body before hashing.
- A non-integer `amountIdr` orphans an already-charged payment.

**Roaming and secrets**
- net-guard misses NAT64, 6to4, IPv4-compatible IPv6 and `192.0.0.0/24`.
- A failed OCPI push is retried forever and blocks its queue.
- OCPI credentials POST is racy.
- Roaming tokens are matched by uid alone.
- Approvals are not bound to a connector.
- Sealed secrets have no associated data, so they can be moved between rows, and unprefixed values are read as plain text.

**Console and accounts**
- `confirmDialog` inserts raw HTML: markup injection only, because CSP blocks scripts.
- A password change does not revoke other sessions, and temporary passwords never expire.
- A cross-tenant email-existence oracle: a 500 on the unique-constraint error.

**Repository hygiene**
- The `description` in `package.json` is triple-mojibake.
- There is no `.gitignore`.
- A binary SDK `.tgz` sits under `src/web`.
- About 3.4 MB of PDFs and HTML are in `docs/`.
- `@types/node@24` does not match the Node 22 target.

---

## 4. Vendor claims checked

| Claim (Final Audit / Readiness Review) | Finding |
|---|---|
| "Row-level security on every business table" | **Overstated.** 16+ tables have no RLS, and the policies allow everything when no org is set (§3.3). Authenticated API isolation does hold (45/45 reproduced). |
| "SECRETS_KEY required; process exits without it" | **False** (§3.1 #3). `AUDIT_HMAC_KEY` *is* enforced. |
| "Frames processed in order; oversized frames cut off; per-charger budget" | Budget and size limit: true. **In order: false** (§3.1 #1). |
| "Payment notifications must state an amount (fail closed); underpayment refused" | True for charging payments. **Not true for passes** (§3.2 #14). |
| "Refunds and captures idempotent" | True for Xendit capture and refund. **False for Midtrans capture, post-pay and e-wallet charges** (§3.2 #15, #19). |
| "Paid QRIS claim tokens expire (30 min)" | Partly. The window runs from checkout, and **the token is not bound to its connector** (§3.2 #13). |
| "Constant-time comparison of every secret" | Holds in everything reviewed. |
| "No SQL injection path; path traversal blocked" | Holds. Dynamic SQL uses whitelisted columns; file paths come from the database. |
| "Sign-in lockout never reveals whether an address has an account" | Holds, but the counter can be raced and the lockout is a DoS lever (§3.1 #9). |
| "571/571 unit and database tests" | **Reproduced**, but only against a database named `plugsure_audit_fix`. CI and the default `npm test` silently run 505. |
| CI runs "typecheck, tests, docker image build" | The docker job cannot pass as written. No e2e suite, no DB-backed tests and no restricted-role runs happen in CI. |

**Documentation inconsistencies**
- **Unit test counts:** 541 (VERSION, HANDOFF, Deployment Guide), 516 (HANDOFF:279), 571 (README, Audit).
- **Driver e2e:** 48 vs 50.
- **Integrations e2e:** 21 vs 22.
- **Target stack:** the Readiness Review says "Node 24 · PostgreSQL 18" and VERSION says "verified on PostgreSQL 18"; the target is Node 22 / PG 16.
- **Migrations:** the Readiness Review says 001–041; there are 42.
- **Defaults:** `deploy/README.md` gives the wrong defaults for `API_HOST` and `OCPP_AUTO_ADOPT`.
- **Stale comments:** in `plugsure-api.service` (SIGTERM) and `ci.yml` (`@types/ws`).

---

## 5. What is genuinely good

- **Money arithmetic.**
  - DPP 11/12 then PPN 12%, and PBJT on energy only: across 28k generated subtotals the lines always summed to the total.
  - Rupiah amounts are integers throughout.
  - Idle and service-fee caps appear as explicit lines.
  - CDRs are issued at most once.
  - Invoice and credit-note numbering take a per-org advisory lock.
  - Credit notes are capped.
- **Meter hygiene.** kWh→Wh conversion, 2.0.1 multipliers, per-phase summing, rollover detection, forward-only energy, and sessions parked (not billed) on inverted timestamps, meters that go backwards, or implausible clocks. Field suite 132/132.
- **Authentication primitives.**
  - scrypt passwords, 256-bit session and API tokens stored as hashes, and constant-time compares.
  - HttpOnly and SameSite=Strict cookies plus a CSRF header.
  - `assertGrantable` on API keys.
  - The per-request org GUC uses `set_config(..., true)` in a pinned transaction, with no leakage between pooled connections.
- **Webhooks and outboxes.** HMAC signatures, secrets shown once, `FOR UPDATE SKIP LOCKED` leasing, and no redirects followed.
- **net-guard.** Correct for decimal, octal and hex IPs, `::ffff:` mapped addresses and the metadata endpoint, and it re-checks at connect time.
- **Signature checks.** Midtrans SHA-512 signature checking, and the per-account check on `payment_intent`.
- **Deployment.**
  - A non-root, multi-stage image.
  - Compose binds everything to loopback and requires secrets.
  - Well-hardened systemd units.
  - Forward-only, gapless, idempotent migrations.
  - Caddy *assigns* (does not append) the forwarded and fingerprint headers.

---

## 6. Suggested order of work

**1. Correctness of money (days).**
- Serialise inbound frames per connection: `await this.onMessage`. (§3.1 #1)
- Make StartTransaction atomic. (§3.1 #1)
- Take `meter_start` from the first register, and add an energy plausibility check. (§3.1 #2)
- Fix the three tariff defects. (§3.1 #10)
- Bind the claim token to its connector. (§3.2 #13)

**2. Fail-closed configuration (hours).**
- Refuse to start without a 64-hex `SECRETS_KEY`. (§3.1 #3)
- Refuse production with security profile < 2 or auto-adopt on. (§3.1 #8)
- Treat only explicit `development`/`test` as insecure. (§3.1 #12)
- Default `API_HOST` and the gateway listen address to `127.0.0.1`. (§3.3)
- Trust proxy headers only from configured CIDRs. (§3.1 #7)

**3. Authorisation (a day).**
- Decide auth from `req.routeOptions.url`. (§3.1 #6)
- Apply `assertGrantable` to user create, update and reset. (§3.1 #4)
- Give each command its own permission. (§3.1 #5)
- Fix the Caddy `handle` order. (§3.1 #9)
- Make the login, OTP and PIN counters atomic. (§3.1 #9, §3.2 #16)

**4. Workers.** Take an advisory lock per worker, claim rows before any money moves, and use deterministic acquirer references. (§3.1 #11, §3.2 #15)

**5. Roaming.**
- Pin partner roles and parties at creation. (§3.2 #17)
- Scope `upsertToken`. (§3.2 #17)
- Gate eMSP CDRs on CPO role, a linked session and operator review. (§3.2 #18)

**6. CI.** Run the DB-backed tests against `plugsure_audit_fix`, plus e2e:isolation and e2e:field as `plugsure_app`, and fix the docker job. That way, what the audit claims is what CI proves.

**7. Hardening.** The remaining Medium items: RLS fail-closed and the tables missing it, pool timeouts, retention and backups, and log redaction.

After steps 1–3 and a re-run of the full suite, the "supervised pilot" verdict would be reasonable. The vendor's hardware acceptance test and edge/load test are still needed as well.

---

## 7. Pilot-blocker fixes (30 September 2026)

All 12 items in §3.1 are fixed on branch `claude/plufsure-csms-review-k1eebw`.
- The delivered v1.3.0 is imported unmodified in commit `d84c62f`.
- Each fix is its own commit on top of it, under `plugsure/`.

| §3.1 | Fix | Commit |
|---|---|---|
| 1 | A charger's requests are handled one at a time, in order. Replies bypass the queue. Session start is atomic per connector (advisory lock), so a duplicate start gets the original session. | `d488d83`, `1705a28` |
| 2 | A missing 2.0.1 start register is recorded as unknown (migration 043), and the first register observed becomes the start. `IMPLAUSIBLE_ENERGY` parks a gross excess (> 20 kWh beyond nameplate × duration) and warns on a small one. | `1705a28`, `39a8131` |
| 3 | The process refuses to start without a usable `SECRETS_KEY` outside development/test. | `0c111c1` |
| 4 | User create, role change, status change and password reset only grant or take over authority the caller holds. | `2a17741` |
| 5 | Raw charger commands need their own permissions: firmware:write with an https, non-internal URL; smartcharging:write, never the station ceiling; the config key rules; charge_point:config for DataTransfer. | `2a17741` |
| 6 | Authentication is decided on the matched route or the raw target, for `/v1`, `/d/v1` and `/ocpi`. | `e055347`, `0669f04` |
| 7 | Forwarding and client-certificate headers are believed only from `OCPP_TRUSTED_PROXIES`. Self-terminated TLS requires a CA-verified certificate. | `0c8db7b` |
| 8 | Outside development/test the gateway refuses to start with security profile < 2 or auto-adopt on, unless `ALLOW_INSECURE_OCPP=true`. `OCPP_AUTO_ADOPT_SITE` is honoured. | `3416c94` |
| 9 | The Caddy sign-in block is its own `handle` ahead of `handle @api`, verified with Caddy 2.8.4. Login failures are counted atomically. | `b29cbf2` |
| 10 | Tiers are banded across the whole session. Windowed components price each segment once. The time component excludes idle minutes. Idle minutes are unit- and phase-correct. | `c863bf0`, `1705a28` |
| 11 | Money-moving and messaging workers run one at a time platform-wide (advisory lock per worker). | `c2785a8` |
| 12 | Only an explicit `development` or `test` relaxes a security control. | `0c111c1` |

### Verification after the fixes

Node 22, PostgreSQL 16, with the API and gateway as separate processes connected as `plugsure_app`.

- **Typecheck and production build:** clean.
- **Unit and database tests:** 602/602. That is the 571 original tests plus 31 new ones, which cover:
  - frame ordering;
  - secrets and environment handling;
  - encoded paths;
  - client-cert and trusted-proxy rules;
  - session integrity;
  - tariff tiers and windows;
  - the login burst;
  - worker locks.
  The new tests that exercise a fixed defect were checked to fail on the original code.
- **End-to-end, every suite in the package plus the new `e2e:pilot-fixes`:** all green.

| Suites | Result |
|---|---|
| pilot-fixes | 16/16 |
| isolation | 45/45 |
| ocpi-auth | 9/9 |
| console | 96/96 |
| field | 132/132 |
| driver | 50/50 |
| driver-plus | 46/46 |
| queue | 19/19 |
| reservation-fees | 12/12 |
| fleet-billing | 53/53 |
| pricing | 24/24 |
| pnc | 37/37 |
| onboarding | 19/19 |
| integrations | 22/22 |
| payment-methods | 21/21 |
| card-holds | 38/38 |
| linked-wallets | 19/19 |
| postpay | 40/40 |
| ocpi | 74/74 |
| ocpi-emsp | 60/60 |
| ocpi-profiles | 36/36 |
| sdk | 23/23 |
| v2x | 21/21 |
| ocmf | 20/20 |
| sandbox-2x | 17/17 |
| brand | 28/28 |
| apns | 20/20 |
| live-activity | 17/17 |
| api-sandbox | 38/38 |

Some suites need their documented prerequisites, and were run with them:
- console needs `PUBLIC_BASE_URL`;
- onboarding needs `OCPP_TRUST_PROXY_PROTO=true`;
- integrations needs a platform-admin account;
- apns and live-activity need `APNS_URL_*` pointed at their stand-ins.

### Operator-visible changes

- A production (or staging) process now **refuses to start** in three cases:
  - without a real `SECRETS_KEY`;
  - with `OCPP_MIN_SECURITY_PROFILE` < 2;
  - with `OCPP_AUTO_ADOPT=true`.
  Set these before upgrading. `ALLOW_INSECURE_OCPP=true` is only for a supervised bench.
- On the systemd path, set `OCPP_TRUSTED_PROXIES` if Caddy does not connect from 127.0.0.1. Compose already includes the Docker bridge range.
- Keys that held only `charge_point:command` (the `api_client` role) can no longer push firmware, set charging profiles or send DataTransfer.
- Migration 043 is additive.

§3.3/§3.4 remain open. §3.2 is addressed in §8.

---

## 8. Public-launch blocker fixes (1 October 2026)

All 13 items in §3.2 are fixed on the same branch.

| §3.2 | Fix | Commit |
|---|---|---|
| 13 | A prepaid token is bound to the connector it was paid for. A start that claims nothing is refused (1.6: transactionId 0, Invalid/ConcurrentTx; 2.0.1: idTokenInfo), and no postpaid session is ever created for a prepaid token. | `064327f` |
| 14 | A pass payment is refused from another operator's acquirer account and when underpaid. A payment after a void is refunded. | `f0296a2` |
| 15 | Post-pay, e-wallet and saved-card charges use deterministic references saved before the call. A retry after a lost answer looks up the status instead of charging again. Checkout and pass purchase record the payment first. | `f0296a2`, `0348509` |
| 16 | OTP and PIN attempts are claimed atomically. There are per-phone, per-IP, per-device, per-card and global budgets, and send budgets are claimed before the SMS goes out. | `756de29` |
| 17 | Partner roles, party and kind are pinned to what the operator chose. A token cannot be moved to another partner. A hub acts for nobody until HubClientInfo arrives. | `7d5ad81` |
| 18 | The eMSP receiver endpoints are CPO-only. Unlinked or implausible CDRs are held for operator review and are not invoiced, counted against limits or shown to drivers. | `7d5ad81` |
| 19 | A Midtrans capture notification reconciles the hold, and a refused capture checks the order status. | `f0296a2` |
| 20 | Refund state changes are conditional. A bank transfer is refused while a provider refund is in flight. Stuck refunds are polled. A DB CHECK enforces refund ≤ captured. | `f0296a2` |
| 21 | The post-pay decision runs under a per-driver lock over all held exposure. | `f0296a2` |
| 22 | Points and promotions are reserved in the CDR transaction under locks. Pre-purchase sessions do not take points. Device-only guests do not get new-driver or per-customer promotions. | `064327f` |
| 23 | Webhooks and OCPI have hard total deadlines; outbox passes use allSettled and run concurrently over leased rows. | `1c207e6` |
| 24 | Every tenant-configured URL goes through guardedFetch, with a connect-time check, no redirects and a size cap. Provider bodies are not echoed. Internal SMTP hosts need `SMTP_ALLOWED_INTERNAL_HOSTS`. net-guard covers NAT64, 6to4 and IPv4-compatible addresses. | `1c207e6` |
| 25 | The OCPI base URL and response_url come from `OCPI_PUBLIC_URL` / `PUBLIC_BASE_URL` only. | `7d5ad81`, `756de29` |

### Verification

- **Typecheck and build:** clean.
- **Unit and database tests:** 702/702.
- **End-to-end:** a fresh database (migrations 001–047, 46 files; 045 was not needed), with the API and gateway run as `plugsure_app`.

| Suite | Result |
|---|---|
| pilot-fixes | 16/16 |
| isolation | 45/45 |
| ocpi-auth | 9/9 |
| console | 96/96 |
| field | 139/139 |
| driver | 50/50 |
| driver-plus | 46/46 |
| queue | 19/19 |
| reservation-fees | 12/12 |
| fleet-billing | 53/53 |
| pricing | 24/24 |
| pnc | 37/37 |
| onboarding | 19/19 |
| integrations | 22/22 |
| payment-methods | 21/21 |
| card-holds | 38/38 |
| linked-wallets | 19/19 |
| postpay | 40/40 |
| ocpi | 74/74 |
| ocpi-emsp | 63/63 |
| ocpi-profiles | 36/36 |
| sdk | 23/23 |
| v2x | 21/21 |
| ocmf | 20/20 |
| sandbox-2x | 17/17 |
| brand | 28/28 |
| apns | 20/20 |
| live-activity | 17/17 |
| api-sandbox | 38/38 |

Two suites were adjusted for intended behaviour:
- **ocpi-emsp:** its CDR now quotes the authorisation it belongs to, and the suite also checks the held/reject flow.
- **postpay:** it releases unused ShopeePay sessions, because exposure now counts every session still held on the same e-wallet.

### What operators must set or know

- **Environment:**
  - `OCPI_PUBLIC_URL` (or `PUBLIC_BASE_URL`) is required outside development/test, or the OCPI API and roaming commands answer 503.
  - A same-host SMTP relay must be listed in `SMTP_ALLOWED_INTERNAL_HOSTS`.
  - Provider URLs on private networks are refused, and provider redirects now fail.
- **Driver sign-in limits:** defaults are 10 codes per phone per day, 10 per IP per hour, 5 per device per hour, 5,000 per day globally, 10 wrong codes per phone per day, 20 PIN attempts per IP per hour, and 15 PIN attempts per card per day. Each can be changed with a `DRIVER_*` environment variable. Mobile carrier NAT may need the per-IP limits raised. Limit refusals answer 429.
- **Roaming:**
  - A partner that is both CPO and eMSP needs two connections.
  - A hub acts for no clients until it sends HubClientInfo.
  - Held partner CDRs wait in `GET /v1/roaming/cdrs/held` until accepted or rejected.
- **Charging and payments:**
  - A prepaid QR presented on the wrong connector is refused at the charger.
  - Pre-purchase sessions no longer use loyalty points (they still earn them).
  - Promotion budgets are never exceeded.
  - Webhook receivers must answer within 15 s.
- **Migrations:** 044 (refund bound), 046 (driver auth limits) and 047 (OCPI trust) are additive.

### Still open

- §3.3/§3.4 (hardening and Low items).
- Xendit has no payment-status lookup by reference; retries rely on its idempotency key.
- A pending refund at an acquirer without a refund-status API stays "processing" with no alert.
- Web Push delivery has only an idle timeout. Its targets are restricted to known push services.

