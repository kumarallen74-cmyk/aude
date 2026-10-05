# PlugSure CSMS v1.5.1 — release notes

**Date:** 2 October 2026
**Base:** v1.5.0

v1.5.1 fixes the findings of the v1.5.0 review, by area. Each area's team adds
its own section below; keep one heading per area.

**Upgrade:** read "Upgrade notes / actions for operators" at the end before
deploying. In short: run `npm ci` (dependencies changed) and `npm run migrate`
(migrations 055 and 057, additive); `NODE_ENV` must now be set or the processes
refuse to start; administrators are made to enrol in two-step verification at
their next sign-in; Docker Compose installs get a new fixed network.

## Billing

**Payments of rated sessions are no longer left unsettled by a crash** (was: the
card-hold capture, the post-pay e-wallet charge and the refund of an unused
pre-purchase ran after the CDR was committed; a crash or database error in between
left the hold `held` until it lapsed at the acquirer — energy delivered, nothing
collected — or the unused balance never reached the refund queue, and nothing looked
again).
- Settlement (`settlePrepaid`) is safe to run again and safe to stop halfway: every
  step that moves money comes first and is idempotent on its own; the payment is then
  marked settled by exactly one caller, which alone raises the alerts and flags. A
  capture already requested is left to the hold worker (its retries and alerts are not
  reset). A settlement failure no longer fails the rating: the CDR stands.
- New worker `settlement-recovery` (every 5 minutes, one runner platform-wide; optional
  cutoff `SETTLEMENT_RECOVERY_NOT_BEFORE`, read-only `npm run settlement:report`;
  picks rows in random order so payments that keep failing cannot starve the rest):
  settles payments whose session's CDR is older than 5 minutes and younger than 30
  days but that were never settled, with the CDR's total. Older ones are left to an
  operator (the hold has lapsed at the acquirer by then). See the upgrade note: its
  first run may settle payments stranded before this release.

**A payment notification for less than the amount asked is no longer just logged**
(was: logged and answered 200, so the acquirer never asked again; the money stayed
taken or held, nothing owed it back and nobody was told). In every case the payment
buys nothing (no session can start with it; its single-use claim token is retired),
and one critical alert of kind `payment.amount_mismatch` is raised (a repeated
notification raises nothing more):
- a card hold authorised for less: released through the card-hold machinery
  (Refunds → Card holds); nothing was taken, so nothing is refunded;
- a QRIS / e-wallet / card payment for less: recorded as taken on a payment marked
  voided (never captured) and queued for a full refund (Refunds);
- a 30-day pass paid for less: the pass is not activated, what was taken is recorded
  (mode `pass`) and queued for a full refund, and the checkout is voided (the driver
  buys again in the app). An automatic renewal paid for less is not retried
  automatically — an acquirer that charged the wrong amount once may do so again —
  so auto-renewal is switched off for that pass with the reason shown to the driver.

**Payment notifications are checked against the account that took the payment more
strictly.** An organisation's own acquirer account now settles only that
organisation's payments, whatever the integration ids say; and outside development
and test a notification is refused (`wrong_account`) when one side names an account
and the other none.

## Security

**`NODE_ENV` fails closed.** An unset `NODE_ENV` used to mean development (bench
security profile and auto-adoption allowed, sign-in codes shown in the driver app,
gateway on 0.0.0.0). It is now treated as production, and the API, gateway and
all-in-one process refuse to start without it. `.env.example` ships
`NODE_ENV=production` (it is also the template for `/etc/plugsure/plugsure.env`); the
systemd units force `NODE_ENV=production` on `ExecStart` (an `EnvironmentFile=`
overrides the units' own `Environment=`).

**Two-step verification (authenticator app, TOTP) for console accounts.**
- RFC 6238 codes, built on `node:crypto` (no new dependency). Enrolment with a QR code;
  secrets sealed with `SECRETS_KEY`; ten single-use recovery codes, stored hashed; a
  code is accepted once per 30-second step (an observed code cannot be replayed).
  After a correct password the session is pending (5 minutes, code step and sign-out
  only) until the code is given. Wrong codes count towards the same
  `LOGIN_MAX_FAILURES` lockout as wrong passwords. The code challenge, failed codes,
  enrolment and resets are in the audit log.
- Required for administrators (anyone holding user management or a platform
  permission) by `CONSOLE_MFA_REQUIRED` (default `true` outside development/test).
  An administrator without it is made to enrol at next sign-in, before the console
  opens. Other users can turn it on from the user menu.
- Lost phone: another administrator resets it under *Users & Roles → Reset two-step
  verification*; for the last administrator, `create-admin --reset-2fa` on the server.
- `CONSOLE_ADMIN_HOSTS` (optional): host names on which administrator accounts may sign
  in and use a session — set it to the office-only console name when the console is
  also published on an internet-facing portal hostname (`deploy/Caddyfile` note).
- Migration 055.

**Sessions end when they should.** Sign-out now also revokes a console session used as
a Bearer token (`pss_…`). The live streams `/v1/stream` and `/v1/events/frames`
re-check their credential every 60 s (`STREAM_REVALIDATE_SECONDS`) without counting as
activity, and close when it no longer holds (was: checked once, when the stream
opened — a sign-out, a disabled account, a password reset or a revoked API key never
reached a stream already open, which kept delivering live events and the OCPP log).

**Driver sign-in.** Fleet sign-in answers one uniform error whatever was wrong (the
reason is logged), with the attempt budget keyed by what was typed. Sign-in codes are
bound to the app install that asked for them, and the wrong-code budget is per number
and device: a stranger who knows a driver's number can no longer lock that number out
for a day with ten bad guesses.

**Docker Compose: the gateway trusts only its own proxy.** The gateway believed
`X-Forwarded-Proto` and `X-Client-Cert-Fingerprint` from all of `172.16.0.0/12`, so any
container on any Docker bridge network of the host could claim TLS and present a
Profile 3 charger's certificate fingerprint. The project now has its own network,
`plugsure-net`, with a fixed subnet (`PLUGSURE_NET_SUBNET`, default `172.31.253.0/24`),
and the gateway trusts only that network's gateway address (`PLUGSURE_NET_GATEWAY`,
default `172.31.253.1`), which is where the host's Caddy appears from.

## OCPP

**OCPP 2.0.1 / 2.1 RPC error codes per version** (was: the 1.6 list for everyone).
- A 2.x charger receives `FormatViolation` (2.0.1's spelling; `FormationViolation` is
  not a valid 2.0.1 code), `RpcFrameworkError` for a frame that is not a valid RPC
  message (e.g. unreadable MessageId), and `MessageTypeNotSupported` for an unknown
  MessageTypeId. The translation happens where every CALLERROR leaves, so no path
  bypasses it.
- Error codes a 2.x charger sends us are kept (they were flattened to
  `GenericError`); a 2.x charger using the 1.6 spelling is read as `FormatViolation`.
- OCPP 2.1 CALLRESULTERROR (5) and SEND (6) are logged and never answered, as the
  specification requires (they were answered with ProtocolError).
- OCPP 1.6 chargers receive exactly the codes they did before.

**Dual-gun (multi-connector) 2.0.1 EVSEs show the right status** (was: every
connector's StatusNotification was written onto the EVSE's row and the last report
won — the idle CHAdeMO gun reporting Unavailable while the CCS gun charged showed a
busy EVSE as Unavailable, OCPI `INOPERATIVE`).
- Each connector's last report is kept (`evse.connector_status`) and the connector
  rows get a status derived from all of them: a connector in use or reserved makes the
  whole EVSE busy; otherwise each row shows its own connector, and connectors without a
  row of their own fold into the first.
- Faulted alerts are raised per connector (a faulted gun is not cleared by its
  neighbour reporting Available).
- OCPI: an EVSE with several connectors is as usable as its most usable connector
  (only the first connector was consulted).
- Single-connector EVSEs (every 1.6 unit, most 2.0.1 ones) are unchanged.

**A 2.0.1 `TransactionEvent(Ended)` for a transaction never seen to start is recorded**
(was: logged and dropped — and the energy with it). The session is written from what
the event carries (energy from its registers, start time approximate, the token kept
for the reviewer but never bound), flagged `TRANSACTION_RECONSTRUCTED` and parked for
review: not billed, no prepaid claim, no roaming link, no `session.started` /
`session.ended`. An Ended `DeAuthorized` with no energy (the end of a start we refused)
is not recorded.

**A replayed Ended / StopTransaction for a session already ended changes nothing**
(was: it announced `session.ended` again to OCPI partners and the driver app and
re-ran rating, which for a session parked for review — including a reconstructed one —
re-raised the needs-review alert on every replay of the station's offline queue). An
ended session whose rating was interrupted is still rated by the reconciliation pass.

**Lost TransactionEvents are detected.** The highest `seqNo` per session is kept
(`charging_session.ocpp_seq_no`); a jump is logged every time and flagged once on the
session (`TRANSACTION_EVENTS_MISSING`, a warning — it does not park the session; energy
is billed from the registers, so a lost Updated loses no energy). Events are still
processed in arrival order; nothing is reordered. Migration 057.

## Operations

**Background worker failures now alert the operator** (was: a log line per failed
pass, so refunds, card holds or the roaming push could fail for days unnoticed).
- A worker that fails `WORKER_ALERT_FAILURES` passes in a row (default 3, and for
  at least a minute), or has not completed a pass for 3× its interval (at least
  10 minutes — a hung pass), raises an alert of kind `platform.worker_failing`
  ("Background worker failing"). Critical for refunds, card holds, pass renewals,
  reconciliation, unpaid reminders and alert routing; warning for the others.
- One alert per worker while the problem lasts (repeats fold into it, also across
  a gateway restart); it resolves itself on the worker's next successful pass.
- It is an ordinary alert: the console lists it, and alert routing, on-call rotas
  and escalation apply (add a rule for the kind, or `platform.*`). It goes to
  `OPS_ALERT_ORG_ID` if set, else the organisation(s) of the platform
  administrators, else the only organisation.
- `GET /v1/platform/health` (platform administrators): the database check and each
  worker's failure streak, last success, last error and alert state, from the
  gateway over the bridge (new internal endpoint `GET /internal/workers`,
  token-protected like the others).
- **External dead-man's switch:** optional `HEARTBEAT_URL` (e.g. a healthchecks.io
  check). The gateway GETs it at most every `HEARTBEAT_INTERVAL_MS` (60 s) after a
  health round in which every worker was healthy, through the outbound guard. Its
  silence covers what an in-app alert cannot: the gateway or database down, the
  host suspended, alert routing itself failing.

**API `/healthz` answers 503 when the database is down** (was: 200 with
`{"ok":false}`, so the Docker HEALTHCHECK, the compose healthcheck and any load
balancer saw a healthy API). The gateway's `/healthz` already answered 503. The
Dockerfile HEALTHCHECK and compose healthchecks are unchanged and now see the
outage.

**Point-in-time recovery.** Continuous WAL archiving and a weekly base backup, with
only PostgreSQL's own tools: `deploy/pitr/postgresql-pitr.conf`,
`tools/backup/wal-archive.sh` / `wal-restore.sh` / `pg-basebackup.sh` /
`wal-offsite.sh`, `deploy/plugsure-basebackup.{service,timer}` (Sunday 03:15, keeps
4) and `deploy/plugsure-wal-offsite.{service,timer}` (every 5 minutes: fails when
archiving is off or failing, then copies the archive off the host). Data loss on a
restore: at most 5 minutes on the host, about 10 off it (was up to a day). The
runbook, with the restore, the monthly restore test and the commands of a real
archive + base backup + PITR restore run on PostgreSQL 16.15, is
`deploy/pitr/RESTORE.md`. Not installed by default; off-site needs a bucket and
credentials (`BACKUP_OFFSITE_CMD`, `WAL_OFFSITE_CMD`).

**One gateway only (documentation corrected).** deploy/README.md said a second
gateway replica could run with `RUN_WORKERS=false`. It cannot: charger sockets
live in the gateway's memory and the API reaches one `GATEWAY_INTERNAL_URL`, so
the second gateway's chargers would show offline and refuse commands.
docs/PLUGSURE-ARCHITECTURE.md §4.3 now describes what is built (the HTTP bridge,
`LISTEN/NOTIFY`, no Redis) and keeps the Redis routing as the planned design.
HANDOFF.md is retitled for the current release.

**CI runs the payment and pricing end-to-end suites** (card holds, e-wallet and card
payments, linked e-wallets, post-pay, pricing, fleet billing, reservation fees);
they had never run in CI. No extra settings: each brings its own local fake
acquirer. The e2e job's limit is 45 minutes (post-pay alone takes about 5). The
deploy-artefact job also checks the new units and scripts.

**Dependencies** (`npm audit`: 5 high → 0):
- fastify 5.12.5; @fastify/static 8 → 10 (stricter path handling: non-canonical
  paths such as `//` or `/./` are refused with 403; nothing PlugSure serves uses
  them); nodemailer 7 → 10 (Node 20+, TypeScript types bundled — @types/nodemailer
  removed; the error codes PlugSure maps — EAUTH, ETLS, ETIMEDOUT — are unchanged;
  remote-content TLS validation in 9.0 does not apply: PlugSure sends no URL
  attachments); fast-uri and brace-expansion (transitive) updated.

## Upgrade notes / actions for operators

In this order. Take a database backup first, as for any upgrade.

1. **`npm ci`** — dependencies changed (see "Dependencies").
2. **`npm run migrate`** — migrations **055** (two-step verification columns on
   `app_user`, `auth_session.mfa_pending`, `driver_otp.device_id`) and **057**
   (`evse.connector_status`, `charging_session.ocpp_seq_no`). Both additive with
   neutral defaults; 056 is unused. On systemd, `plugsure-migrate.service` runs them.
3. **`NODE_ENV` must be set.** The API, gateway and all-in-one process now refuse to
   start when it is missing (an unset value used to mean development). The systemd
   units set `NODE_ENV=production` themselves and the compose file already did; check
   any other way you start PlugSure (a custom unit, a container, a script). On a
   workstation, put `NODE_ENV=development` in `.env` — `.env.example` now ships
   `production`.
4. **Two-step verification rollout.** With the default `CONSOLE_MFA_REQUIRED=true`,
   every administrator (user management or any platform permission) is made to enrol
   an authenticator app at their **next sign-in**, before the console opens. Tell
   them beforehand, and have them keep the ten recovery codes. For a staged rollout
   set `CONSOLE_MFA_REQUIRED=false` (optional for everyone; the API logs a warning),
   let administrators enrol from the user menu, then remove the setting. Recovery: a
   lost phone is reset by another administrator (*Users & Roles → Reset two-step
   verification*); for the last administrator, on the server:
   `npm run create-admin -- --email <admin> --org-slug <org> --reset-2fa` (it also
   sets a new one-time password and ends the account's sessions).
5. **`CONSOLE_ADMIN_HOSTS`** (optional): if the console is also published on an
   internet-facing portal hostname, set this to the office-only console host name;
   administrators are then refused on any other host.
6. **Docker Compose: new network.** The stack now runs on a named network
   `plugsure-net` with a fixed subnet (`PLUGSURE_NET_SUBNET`, default
   `172.31.253.0/24`; gateway `PLUGSURE_NET_GATEWAY`, default `172.31.253.1`).
   `docker compose up -d` creates it and moves every service onto it (the old
   `plugsure_default` network is left unused; remove it with
   `docker network prune` if you like). If compose reports an overlapping address
   pool, pick another free /24 and set both variables. The gateway now trusts
   forwarding headers only from `PLUGSURE_NET_GATEWAY` (was all of `172.16.0.0/12`): if
   you set `OCPP_TRUSTED_PROXIES` yourself, or run Caddy as a container, update it.
   **Check `API_TRUSTED_PROXIES`** too: a value naming the old Docker bridge address or
   `172.16.0.0/12` must become the new gateway address, or the API sees every client as
   the proxy (one shared rate-limit bucket, the proxy's address in the audit log).
7. **First run of the settlement-recovery worker.** Within 5 minutes of the gateway
   starting, it settles payments of sessions rated in the **last 30 days** that were
   never settled: it may capture card holds still held at the acquirer (a hold that has
   already lapsed fails and alerts), charge post-pay e-wallets, and queue refunds of
   unused pre-purchase balances. Expect a burst of `prepaid.*` / payment alerts and new
   entries under Refunds on that first run; review them. Older payments are left to an
   operator.
   **Recommended safe rollout:** before deploying, set `SETTLEMENT_RECOVERY_NOT_BEFORE`
   to the upgrade time (e.g. `2026-10-05T22:00:00+07:00`) so the sweep only acts on
   payments rated after the upgrade. Then run `npm run settlement:report` (read-only)
   to list the older stranded payments, check each against the Midtrans/Xendit
   dashboards, settle by hand any that ops already handled, and only then remove the
   setting so the sweep picks up the genuinely open ones. A malformed value stops the
   gateway at start-up.
8. **Point-in-time recovery** (optional, recommended): follow `deploy/pitr/RESTORE.md`.
   Turning WAL archiving on needs a **restart of PostgreSQL** (a reload is not enough;
   the gateway and API reconnect by themselves) — plan a short window. The off-site
   copy needs a bucket and credentials on the host (`BACKUP_OFFSITE_CMD`,
   `WAL_OFFSITE_CMD`); without them the archive stays on the database host only.
9. **Worker alerts and the dead-man's switch** (optional, recommended): set
   `HEARTBEAT_URL` (e.g. a healthchecks.io check) so the gateway, the database or the
   host being down is noticed from outside; set `OPS_ALERT_ORG_ID` to the platform
   operator's organisation if it is not the platform administrators' own; and add an
   alert-routing rule for `platform.*` (Govern → Alert routing) to an on-call rota, or
   `platform.worker_failing` alerts are only listed in the console.
10. **Field tests on Autel hardware** before relying on the OCPP 2.0.1 changes (Autel
    units stay on OCPP 1.6J until a 2.0.1 model passes acceptance; 1.6 behaviour is
    unchanged):
    - **dual-gun status:** on a dual-gun DC unit on 2.0.1, plug one gun in and charge;
      check the console, the driver app and OCPI show the EVSE busy while the other gun
      reports Unavailable, and each gun's own status once it is free;
    - **FormatViolation acceptance:** send a malformed call from the unit's side (or
      trigger one) and check the unit accepts a `FormatViolation` / `RpcFrameworkError`
      CALLERROR without disconnecting or retrying forever;
    - **seqNo per transaction:** confirm the unit numbers TransactionEvents per
      transaction (0 at each Started), as the 2.0.1 specification says, with two
      EVSEs charging at once. A unit that counts per station would get
      `TRANSACTION_EVENTS_MISSING` flagged on sessions that lost nothing (a warning:
      not parked, billing unaffected), and a reconstructed Ended would name events
      "never received" that never existed — report it as a quirk if so.

## Verification

_(each team adds its counts; final counts on the merged tree)_

Merged tree (billing, security, OCPP and operations, plus the follow-ups: replayed
Ended idempotent, underpaid pass refunded):
- typecheck clean; migrations 001-057 applied to an empty database, then seed;
- unit and database tests: 924 passing, 0 failing.

Operations (on its own branch, before merging the other areas):
- typecheck clean; `npm ci` from the lockfile; `npm audit`: 0 vulnerabilities;
- unit and database tests: 842 passing (829 + 13 new: worker health, alerts in the
  alert table, heartbeat, API /healthz 503);
- e2e, split deployment as `plugsure_app`, in the CI job's order: isolation 45/45,
  pilot fixes 27/27, field (quick) 132/132, console 97/97, white-label console
  45/45, card holds 38/38, payment methods 21/21, linked e-wallets 19/19,
  post-pay 40/40, pricing 24/24, fleet billing 53/53, reservation fees 13/13;
- live: with `SELECT` on `site` revoked from `plugsure_app`, six workers raised one
  `platform.worker_failing` alert each in the platform administrator's
  organisation within two minutes; all six resolved themselves within 50 s of the
  grant coming back. `GET /v1/platform/health`: 200 for a platform administrator,
  403 for an operator's super administrator;
- PITR: archive, base backup and a restore to a chosen time proven on a throwaway
  PostgreSQL 16.15 cluster (deploy/pitr/RESTORE.md §4).
