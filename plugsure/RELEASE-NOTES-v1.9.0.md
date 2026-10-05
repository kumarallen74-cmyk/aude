# PlugSure CSMS v1.9.0: release notes

**Date:** 5 October 2026
**Base:** 1.9.0-dev (branch `mobile`), the package handed over for review. It is v1.5.0 plus v1.5.1, v1.6.0, v1.7.0, v1.7.1 and v1.8.0, plus the driver API and the Expo app for the native PlugSure app.

v1.9.0 is 1.9.0-dev made releasable. It fixes what an independent review of the whole package found before the pilot upgrade: six reviews (money and tax, sign-in and security, payments, OCPI and the Hub, the driver API and mobile app, deployment), plus end-to-end runs in the pilot's configuration and with every feature on. It also adds the missing runbook (**`docs/UPGRADE-v1.5-to-v1.9.md`**), a working rollback, and CI for what ships.

For what the earlier releases changed, see the release notes v1.5.1–v1.8.0. For integrators, see `docs/COMPATIBILITY-v1.5-to-v1.9.md`.

## Fixed

### Blocker

**The public account-deletion form showed a stranger an account's open charges.**
- **What happened:** on the web form (`/account/delete`, which needs no sign-in), anyone who typed a phone number got back, before any code was checked:
  - that account's unpaid charges, with site, amount and charge id;
  - any charging session in progress;
  - whether it held a reservation or a queue place.

  A number with an account also answered differently, and hit different limits, from one without, so the form revealed which numbers have accounts.
- **Now:**
  - The web form never shows what blocks a deletion. The owner learns it after the code proves the number is theirs (confirm answers 409 with the list).
  - The answer and the limits applied are identical whether or not the number has an account. Nothing is sent to a number without one.
  - In the app, signed in, nothing changes.

### Before the pilot upgrade

- **Rollback.**
  - `deploy/README.md` §7 still said "roll back the code, leave the schema". After migration 060 renamed the money columns, v1.5.0 cannot run on a 1.9 schema.
  - Even with the down scripts, v1.5.0 could not save a commercial plan afterwards, because 063 drops the index its `ON CONFLICT` uses. `060_down.sql` now recreates `commercial_plan_version_uq`.
  - `060_down.sql` refuses to round a member rate entered with more than two decimals.
  - §7 now gives two procedures: restore the pre-upgrade backup (primary), or the down chain `075 → 074 → 073 → 072 → 060` (rehearsed, below).
- **An upgrade runbook.** `docs/UPGRADE-v1.5-to-v1.9.md` puts every step from v1.5.1 to v1.9.0 in order for the pilot:
  - the `NODE_ENV` pre-flight: the v1.9 systemd units force production, which a v1.5 environment file copied from `.env.example` did not;
  - the two-step verification rollout;
  - the settlement-recovery cut-off;
  - the 060 window with `rerate-compare`, which runs from a source checkout, not the Docker image;
  - Docker's new network.
- **Migration 075 granted every table to the application again.** Every migration since 048 says not to: it hands UPDATE and DELETE on the append-only audit log back to the application. The migrator re-revoked that after each run, but a 075 applied by hand left it open.
  - 075 now grants only what its new table needs.
  - The new migration 076 restores least privilege on every database, including one that already ran the 1.9.0-dev copy: the audit log, sign-in transactions, payment webhook events, the country and currency tables, and the account-deletion record.
- **Driver API rate limit.** 1.9.0-dev raised the per-address limit on `/d/` from 600 to 6,000 requests a minute, for phones behind carrier NAT. Requests without a device token had no other limit. That covered:
  - public map and station browsing;
  - the QR and link resolver, which scans partner locations;
  - minting device tokens.

  Requests without a token now get the ordinary 600 a minute per address (`DRIVER_ANON_IP_RATE_LIMIT_PER_MIN`). Requests with a token keep the NAT cap and their own per-device limit.
- **`npm run mobility:setup` could turn an operator's own white-label app into the PlugSure app.** That app would then show every operator's chargers, and its store apps would stop finding their brand. It now refuses before writing anything, unless `MOBILITY_CONVERT_BRAND=1`. It also refuses `MOBILITY_JOIN_HUB` while the hub is off.
- **CI didn't test what the pilot runs.**
  - The end-to-end job ran only with every feature on. A new job, `end-to-end (pilot configuration)`, runs 30 suites with the hub, Microsoft sign-in and multi-country off. 18 of them weren't run by CI at all, among them the OCPI roaming suites (including the v1.7.1 hub-scoping fix), the driver app suites and the SDK suite.
  - A new `mobile app` job runs the app's typecheck, lint and tests, and builds a production Android bundle.
  - Two suites that had gone stale because CI never ran them are fixed: `integrations`, which predated v1.5.1's intended payment and sign-in changes, and `sdk`, whose CI job now builds the SDK first.
  - The country-literal check failed on a deliberate v1.5 compatibility check.

### Payments

- **A late card-hold authorisation is released, not ignored.** A hold whose start timed out was marked failed. If the acquirer authorised it after all, that notification was dropped as a duplicate and the driver's card stayed blocked. Now it is queued for release. This affects roaming holds and any hold that lapsed.
- **A payment voided as underpaid stays voided.** A later "paid" notification for the full amount would have marked it captured over the refund already queued for the short amount, so the second payment would never be paid back. Now:
  - it stays voided;
  - a critical alert is raised;
  - a repeat of the original notification is still a quiet duplicate.
- **Money taken on a refused notification is now raised.** A notification from the wrong payment account, or a capture confirmed above its hold, now raises a critical `payment.amount_mismatch` alert. Before, it was only logged.

### Sign-in and accounts

- **API keys can't reset another user's two-step verification.** A key (one factor) plus a password reset could become a console session without a second factor. Now a signed-in administrator is required: an API key gets 403 `console_user_required`.
- **Account deletion clears only that number's sign-in counters.** A substring match also reset the counters of longer numbers starting with the same digits.
- **Deleted accounts are described as pseudonymised, not anonymised.** The phone number is replaced by a hash keyed with `SECRETS_KEY`.
- **"Already used by another organisation" now works.** These checks for roaming party ids ran inside the operator's own request, where row-level security hides other organisations, so a clash came back as a 500. They now see across organisations and answer 409.

### OCPI and the PlugSure Hub

The Hub fixes matter only once `HUB_ENABLED=true`. The pilot keeps it off, and it was confirmed inert there.

- **Direct addressing (`OCPI-to`) now checks ownership.** A session command (STOP_SESSION, CANCEL_RESERVATION), a charging profile or a charging preference about a session or reservation is refused unless it comes from that object's own eMSP. Open routing already checked this.
- **An active member's fresh connection (token A)** may register only parties it already holds or that a platform admin approved. Before, it could claim any party id not yet on the hub, and route under it at once.
- **Settlement: a payment the payee never confirms no longer settles a position.** Past the due date the position is overdue, with reminders to both sides, until the payee confirms. Before, a payer could silence reminders by recording a transfer that never happened.
- **The routing log no longer stores members' callback URLs in clear.** These are response URLs and CDR locations, which are sealed at rest.
- **An empty `HUB_CYCLE=` or `HUB_DEFAULT_ENTITY=` uses the default** instead of stopping a server that doesn't run the hub.
- **A session or CDR at a site in a country where the operator has no roaming party** is left out of the page, and logged, instead of failing a partner's whole page with a 500.

### Driver app server and mobile app

- **Caddy routes the PlugSure app's public pages** on its link domain: QR and share links (`/c`, `/s`, `/r`), the payment return (`/paid`) and the account-deletion form that the app stores require. Before, these answered 404.
- **The paged `/d/v1/stations` prices only the page it returns,** as `/d/v1/map` does. It used to price every station in the box.
- **Mobile app:**
  - A production build refuses demo data, a non-https API, or an `EXPO_PUBLIC_API_BASE_URL` override.
  - Deleting the account also clears the local active charge, pending checkout and push token.
  - The screen tests have a 20-second timeout, because the first screen compiles slowly on a busy CI machine.

### Docs

- `deploy/DRIVER-APP-PILOT.md`: the supervised-capture SQL used the old `*_idr` column names.
- `HANDOFF.md` and `VERSION` now show the current release.

## Not changed (known, documented)

- **Fleet invoices and partner CDRs in other currencies.** A partner CDR in a currency PlugSure does not support (EUR, USD) and accepted by an operator appears on no fleet statement, and the v1.5 warning about it is gone. With `MULTI_COUNTRY` off, a MYR or SGD partner CDR makes its own MYR/SGD fleet invoice.
- **The fleet-portal card total** adds amounts across currencies. That is harmless while every row is IDR.
- **The mobile app's version gate** compares only the marketing version (`1.0.0` in `app.config.ts`). Raise it with every store release.
- **The account-deletion SMS** is the ordinary sign-in text.

## Upgrading

Follow `docs/UPGRADE-v1.5-to-v1.9.md`. From 1.9.0-dev, deploy and run `npm run migrate` to apply 076. Every new feature stays off unless switched on.

## Verification

- **Server:**
  - typecheck clean;
  - 1,455 unit and database tests, all passing;
  - migrations 001–076 from an empty database;
  - a v1.5.0 database upgraded to 1.9.0.
- **End-to-end, pilot configuration** (hub, Microsoft sign-in and multi-country off): all 30 suites in full mode as `plugsure_app`.
- **End-to-end, everything on** (CI's configuration): all 37 suites, including the Hub, Hub clearing, Hub console, Microsoft sign-in, multi-country, Stripe and mobile API suites.
- **Rollback rehearsal on one database with real data:**
  1. v1.5.0, with its own suites, including sessions, invoices, refunds and commercial plans;
  2. upgraded to 1.9.0 and used;
  3. rolled back with the documented chain;
  4. v1.5.0's migrator and its own suites passed on it, including the field suite, which saves a commercial plan.
- **Mobile app:** typecheck, lint, 215 tests, and a production Android bundle.
