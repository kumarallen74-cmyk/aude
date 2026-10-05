# PlugSure CSMS v1.8.0 — release notes

**Date:** 3 October 2026
**Base:** v1.7.1
**Type:** feature release — **PlugSure Hub**, an OCPI 2.2.1 roaming hub with clearing and settlement

**Upgrade:** additive. Two migrations (072, 073), no change to existing behaviour while the hub is off — and it is
**off by default** (`HUB_ENABLED=false`). For the pilot this release is a code swap plus two quick migrations.
Design and as-built record: `docs/HUB-DESIGN.md`. Runbook: `deploy/HUB-OPERATIONS.md`. Guide for external members:
`deploy/HUB-ONBOARDING.md`.

---

## 1. What is new

### 1.1 PlugSure Hub (routing)

PlugSure can act as a neutral OCPI 2.2.1 hub for Indonesia, Malaysia and Singapore. Operators (CPOs) and service
providers (eMSPs) connect **once**, to PlugSure, and roam with every member they have an agreement with.

- **Its own surface** `/hub/ocpi/versions`, `/hub/ocpi/2.2.1/…` on its own host (`HUB_PUBLIC_URL`), its own token
  namespace. The existing peer surface `/ocpi/*` and every existing partner are untouched.
- **Hub identity:** one party with role HUB per country (`HUB_PARTIES`, default `ID*PSH,MY*PSH,SG*PSH`).
- **Members:** external platforms (credentials handshake, token A shown once; either side may start) and PlugSure
  tenants (zero-configuration join, in-process transport: no network calls).
- **Routing per OCPI 2.2.1:** addressed, broadcast (locations, tariffs, tokens; outbox with ordering and
  coalescing), GET All with hub cursors, open routing (sessions and CDRs by token, commands by location / session /
  reservation, real-time authorisation by token), callbacks (`response_url`, CDR `Location`) rewritten and relayed;
  routing headers on every leg (from / to, a new `X-Request-ID`, the same `X-Correlation-ID`).
- **Agreements** CPO ⇄ eMSP, with per-agreement module flags (real-time authorisation, commands, charging profiles)
  and validity dates; mutual open roaming as an option. No agreement → nothing is routed (OCPI `4901`).
- **HubClientInfo** pushed to every member (only parties it may roam with), alive checks, OFFLINE / CONNECTED.
- **Errors:** `4001` unknown receiver, `4002` timeout, `4003` receiver unreachable, `4901` no agreement, `4903`
  from-party mismatch, `4904` ambiguous, `4905` rate limited (HTTP 429, `Retry-After`).
- **Support:** a redacted routing log (token uids masked; bodies only with a time-limited, audited body capture), a
  trace of every leg of a correlation id, per-connection health.

### 1.2 Clearing and settlement

- **Ledger:** every CDR pushed or pulled through the hub is recorded once (`hub_cdr`), with hard flags (held: no
  agreement, wrong currency, implausible values, bad credits, conflicting duplicates, not delivered) and soft flags.
- **Disputes** by the eMSP within the dispute window (default 14 days, per agreement): the CPO accepts (credit CDR)
  or rejects, the eMSP may escalate, PlugSure decides (upheld / credit required / written off). Every step leaves a
  note both sides see and an audit entry.
- **Commission** (PlugSure's fee) per CDR and side, by fee plan per currency (agreement → member → default). The
  shipped plans are **0** (`TODO(commercial)`).
- **Settlement runs** per currency and period in the country's time zone (monthly by default): draft and preview,
  finalise (statements numbered `PSH-ST-…`, bilateral net positions, fee invoices with ID PPN / PPh 23, SG GST, MY
  service tax per the issuing entity), payments between members (partial, payee confirmation, overdue reminders),
  write-off. Currencies are never mixed or converted.

### 1.3 Console

- **Governance → Hub** (platform administrators, only with `HUB_ENABLED`): Overview (members and parties by status and
  country, 24 h traffic and errors, open hub alerts, connection health); Members (new external member → token A once,
  handshakes, activate / suspend / terminate, connections: alive check, rotate, suspend, rate limits, body capture,
  approve parties; join a tenant); Agreements (list and CPO × provider matrix, module flags); Message log and trace;
  Outbox with replay; **Clearing** (overview; ledger with filters, paging, CSV and CDR detail with release / void /
  dispute; disputes with notes, resolve / escalate / withdraw; settlement runs: create, preview, finalise, void;
  positions and payments with write-off; statements and fee invoices as HTML / PDF / CSV, mark paid; commission: fee
  plans, agreement and member terms; issuing entities with the placeholder flag).
- **Roaming → PlugSure Hub** (tenants and external members): membership, its parties and agreements, and its own
  clearing — summary, ledger (dispute as the eMSP), disputes (accept / reject as the CPO, escalate / withdraw as the
  eMSP, notes), statements and fee invoices, positions and payments (record, confirm), commission terms, bank details.
- **External members' consoles** (hub-only organisations) show only the hub page, users and API keys.
- Every destructive action asks for a reason, stored in the audit entry; finalise, void, write-off, terminate and
  close also need a typed phrase.
- Fixed (all views): a view still loading when the operator navigated away could paint its error over the new page
  (seen as "This view failed to load" after a deep link right after sign-in).

### 1.4 API

`/v1/hub/*` and `/v1/hub/clearing/*` (platform administration, internal), `/v1/roaming/hub`,
`/v1/roaming/hub/join` and `/v1/roaming/hub/clearing/*` (a member's own view: **published** in the OpenAPI document
and the SDK, 318 operations). Everything under `/v1/hub` and `/v1/roaming/hub` answers 404 while the hub is off.

## 2. v1.7.1 recap (security)

v1.7.1 (the release this one builds on) fixed party isolation behind roaming hubs on the **tenant** side: a party
behind a hub connection could read or act on another party's sessions, CDRs, tokens, commands and charging profiles
through the same connection. Every request from a hub must now name its from-party, one the hub announced, and is
scoped to it. If you skipped v1.7.1, read `RELEASE-NOTES-v1.7.1.md` ("Who is affected", "What to check") first.
PlugSure Hub relies on it: its broadcasts to tenants are accepted under that rule (`hubBroadcastActor`).

## 3. Configuration

All optional; nothing changes while `HUB_ENABLED=false`. Out-of-range values refuse start-up.

| Setting | Default | Meaning |
|---|---|---|
| `HUB_ENABLED` | `false` | Mounts the hub, its API, console screens and workers |
| `HUB_PUBLIC_URL` | `OCPI_PUBLIC_URL` | The hub's own public origin (its own host, e.g. `https://hub.plugsure.asia`) |
| `HUB_PARTIES` | `ID*PSH,MY*PSH,SG*PSH` | The hub's parties (role HUB), one per country — choose once |
| `HUB_BUSINESS_NAME`, `HUB_WEBSITE` | `PlugSure Hub`, — | In the hub's credentials |
| `HUB_SELF_JOIN` | `false` | Tenants may join from Roaming → PlugSure Hub |
| `HUB_FORWARD_TIMEOUT_MS` / `HUB_REALTIME_TIMEOUT_MS` | 10 000 / 4 000 | Deadlines (then `4002`) |
| `HUB_CALLBACK_TTL_S` | 900 | Validity of a rewritten `response_url` |
| `HUB_ALIVE_AFTER_MIN` | 5 | Idle minutes before an alive check |
| `HUB_TOKEN_GRACE_MIN` | 60 | Old token's validity after a forced rotation |
| `HUB_DISPUTE_DAYS` | 14 | Dispute window (an agreement may set its own) |
| `HUB_DISPUTE_RESPONSE_DAYS` / `HUB_DISPUTE_ESCALATE_DAYS` / `HUB_CREDIT_DUE_DAYS` | 10 / 5 / 10 | Dispute deadlines |
| `HUB_PAYMENT_TERMS_DAYS` | 14 | Positions due after finalising |
| `HUB_CYCLE` | `monthly` | `monthly` or `weekly` |
| `HUB_DEFAULT_ENTITY` | `SG` | Issuer of fee invoices for members of a country without a PlugSure entity |
| `HUB_LATE_CDR_DAYS` | 60 | A CDR older than this is flagged `late_cdr` |
| `HUB_ALERT_ERROR_RATE_PCT` / `HUB_ALERT_MIN_REQUESTS` | 25 / 20 | Alert `hub.forward_error_rate` |

**Alerts** (existing alert pipeline and routing; raised in the member's organisation, listed on the Hub overview):
`hub.connection_offline`, `hub.forward_error_rate`, `hub.response_filtered`, `hub.outbox_backlog`, `hub.cdr_held`,
`hub.dispute_opened` / `_updated` / `_escalated`, `hub.settlement_ready`, `hub.statement_issued`,
`hub.payment_overdue`, `hub.fee_invoice_overdue`.

**Also changed:** `OCPI_PUBLIC_URL` (and `HUB_PUBLIC_URL`) set but **empty** — as in `.env.example` — now falls back to
`PUBLIC_BASE_URL`, as the error messages always said. Before, an empty value disabled roaming's public URL.

## 4. Migrations

| Migration | Content | Rehearsal (pilot data) | Rollback |
|---|---|---|---|
| `072_hub_core.sql` | hub registry, agreements, routing index, outbox, callbacks, routing log; `organisation.hub_only` (constant default) | 70 ms, one transaction | `db/rollback/072_down.sql` (drops every hub table and the column; refuses while a hub-only organisation exists) |
| `073_hub_clearing.sql` | ledger, disputes, fee plans, runs, positions, statements, fee invoices, payments; three nullable / constant-default columns on hub tables; placeholder entities and zero default plans | ≈ 90 ms of statement time, one transaction | `db/rollback/073_down.sql` (refuses while `hub_cdr` has rows) |
| `074_hub_review_fixes.sql` | review fixes: member-scoped RLS on the hub tables becomes read-only (policies only) | policies only, no data | `db/rollback/074_down.sql` (run before 073_down, which now refuses while 074 is recorded) |

Both are **additive**: no rewrite of an existing table, only brief locks on `organisation` (072) and on the small hub
tables (073), bounded by `MIGRATION_LOCK_TIMEOUT`. A second `migrate` is a no-op. Every hub table has forced
row-level security (members see only their own rows).

## 5. Upgrading the pilot

1. Back up as usual (`deploy/README.md`).
2. Deploy the code; run `npm run migrate` (or `plugsure-migrate.service`): 072 and 073 apply in well under a second.
3. Restart the API and the gateway. **Leave `HUB_ENABLED` unset**: the console, the OCPI surface, partners, sessions
   and billing behave exactly as in v1.7.1 (`/v1/hub/*` answers 404, no hub worker starts).
4. Check: the console loads; Roaming works as before; `GET /hub/ocpi/versions` → 404.

To switch the hub on later (staging first): `deploy/HUB-OPERATIONS.md` §1 — DNS and TLS for the hub host, the
`hub.*` block of `deploy/Caddyfile`, `HUB_ENABLED=true`, `HUB_PUBLIC_URL`, restart; then join the pilot operator
(Hub → Members → Join a tenant), which changes nothing until agreements exist.

## 6. Onboarding the first external member

`deploy/HUB-OPERATIONS.md` §2, in short: Hub → Members → **New external member** (legal name, country, tax id,
billing e-mail, contract reference) → the dialog shows the **versions URL and token A once** → send both, with
`deploy/HUB-ONBOARDING.md`, over a secure channel → the member runs the credentials handshake (its connection shows
*connected*, its parties *planned*) → **Activate** once the hub agreement is signed → create its **agreements**
(Hub → Agreements) → watch its first messages in the message log, and its first CDRs in Clearing → Ledger.

## 7. Open items before commercial use

**[OWNER]**
- Hub party ids (`ID*PSH`, `MY*PSH`, `SG*PSH`?) and the hub's public hostname.
- PlugSure's issuing entities per country (legal names, tax ids, registrations, bank details) — seeded as flagged
  **placeholders**; their documents say "not valid as a tax invoice".
- Commission model and rates per currency (all 0 today, `TODO(commercial)`), minimums, tiers.
- Windows: dispute 14 / response 10 / escalation 5 / credit 10 / payment 14 days; monthly cycle; whether held CDRs are
  forwarded (yes today); overdue consequences (no auto-suspension); who may write off (platform only).
- Support contact, hours and the sandbox hub for members.

**[LEGAL]** (per country: ID, MY, SG)
- Licensing of a roaming hub and of clearing between members (payments regulation; PlugSure does not hold members'
  money in this phase).
- Enforceability of bilateral **set-off** (netting) and the hub statement as the basis of members' own invoices.
- Taxes: ID PPN and PPh 23 on hub fees, e-Faktur; MY service tax scope; SG GST and zero-rating for overseas members;
  reverse charge cross-border; fee invoices in a currency other than the entity's.
- Data protection: CDRs and routing logs crossing borders (UU PDP, PDPA MY / SG), retention (10 years assumed for
  ledger and documents; routing log 30 days, captured bodies 72 hours).

## 8. Known limitations

- **No hub-initiated CDR pull** from CPOs that do not push CDRs: such CDRs reach the ledger only when an eMSP pulls
  them through the hub.
- **No e-Faktur export** of Indonesian fee invoices yet.
- **No statement or invoice e-mails**: members are alerted (`hub.statement_issued`) and download from the console.
- **Rate limits are per process** (documented limitation, not changed by the review) (`TokenBuckets`): with N API processes a member gets up to N× its limit.
- **Hub errors `4001`–`4003` travel with HTTP 200** (the spec does not say) — to confirm with the first external
  members [VERIFY].
- Member-proposed agreements (propose / accept in the console) are not built: the platform creates agreements.
- Dedicated webhook event types for hub events are not added; hub alerts go through the existing `alert.raised`
  webhook.

## 9. Review fixes (independent review, review180)

An independent adversarial review of the hub (routing, clearing, console, migrations) found the issues below; each
is fixed with tests on `hub`.

| # | Severity | Issue | Fix |
|---|---|---|---|
| 1 | High | A charging-profile setter was learned **before** forwarding: an eMSP could PUT a profile on another eMSP's session, be refused by the CPO, and still receive that session's ActiveChargingProfile updates (open routing). | Learned only when the CPO answers `ACCEPTED` (`router.ts` afterForward). |
| 2 | Medium | An external member's `response_url` / CDR `Location` on our own origin was called **in-process**, into any path of the API (e.g. `POST /v1/auth/login` with a CPO-chosen body, exempt from the per-IP limit). | Own-origin URLs only from internal members and only under `/ocpi/` or `/hub/ocpi/`; `injectCall` refuses any other path (`transport.ts`). |
| 3 | Medium (money) | A credit CDR without `incl_vat` of an original with it was accepted as exact; settlement moves incl. tax, so the tax stayed owed on a fully credited CDR (and the reverse overpaid). | Such a credit is held `credit_amount_mismatch` (`intake.ts`). |
| 4 | Medium-High | `hub_only` was enforced by the console menus only: an external member's users and API keys could use the whole CSMS API (sites, chargers, roaming identity, partners, sandboxes). | Server-side: a hub-only organisation reaches only `/v1/auth/*`, the console shell (`/v1/meta`, `/v1/stream`, `/v1/alerts`), users and roles, API keys, webhooks, `GET /v1/roaming` and `/v1/roaming/hub*`; anything else is 403 `hub_only` (`api/hub-only.ts`, sessions and API keys alike). The Developers page shows no sandboxes to them. |
| 5 | Medium | Outbox replay re-sent failed broadcasts after newer copies of the same object, rolling recipients back to stale data. | `replayHub` drops (does not replay) a failed row superseded by a later delivered or pending row for the same recipient and object. |
| 6 | Low-Medium | A CDR addressed (OCPI-to) to an eMSP other than its `cdr_token`'s was forwarded and booked to that eMSP. | Refused 2001, not forwarded, not recorded: a CDR goes to the eMSP of its token (OCPI 2.2.1 CdrToken carries that party). Refusing rather than holding, because forwarding it to the wrong eMSP is itself the harm (driver data to a competitor). |
| 7 | Low | A party could broadcast a location or token id another live party had published, making open-routed commands and authorisations about it ambiguous (4904: denial of service). | Refused 2001: the first live holder keeps the id; the newcomer can still address counterparties directly with OCPI-to. |
| 8 | Low | Member-scoped RLS policies were FOR ALL (a member's own scope could update its membership, parties, agreements and clearing rows; no code did). | 074: SELECT-only for members; writes only unscoped (the hub services). |
| 9 | Low | Callback target URLs were kept in clear in `hub_outbox.url` (sealed in `hub_callback`). | Sealed (AAD = the row's object key); rows written before are read as they are. |
| 10 | Low | An empty `HUB_PARTIES` stopped the CSMS from starting even with `HUB_ENABLED=false`. | Unset or empty → the default; malformed refuses only when the hub is enabled. |
| 11 | Low | `072_down.sql` dropped `hub_only`, silently turning external members' organisations into full tenants. | Refuses while any hub-only organisation exists (disable their users and keys and clear the flag deliberately first). |
| 12 | Low | CSV exports wrote credits' negative amounts as text (`'-1620`). | Plain numbers stay numbers; formula-like text is still neutralised. |

## 10. Verification

- Typecheck clean; country-literal ratchet clean.
- Unit and database tests: **1372 / 1372** (1224 at v1.7.1; hub routing +79, clearing +65, console and fixes +4).
- End to end, the whole CI e2e job (18 suites) with `HUB_ENABLED=true` on a fresh database, as the runtime role:
  isolation 45, pilot-fixes 27, field 132, console 106, console-brand 45, ms-login 27, card-holds 38,
  payment-methods 21, linked-wallets 19, postpay 40, pricing 24, fleet-billing 53, reservation-fees 13,
  multi-country 33, stripe 35, **hub 88, hub-clearing 45, hub-console 72** — all passing. The peer OCPI suites
  (`ocpi`, `ocpi-emsp`, `ocpi-auth`, `ocpi-profiles`) pass with the hub on and off.
- After the review fixes (§9), on fresh databases: unit and database tests **1380 / 1380**; `hub` 88 (twice on one
  database), `hub-clearing` 45, `hub-console` **75** (+3: hub-only enforcement, also through an API key) with
  `HUB_ENABLED=true`; with the hub off (and `HUB_PARTIES` empty) `ocpi` 74, `ocpi-emsp` 63, `ocpi-profiles` 46,
  `ocpi-auth` 9, `isolation` 45; rollback rehearsal 074 → 073 → 072 (refused while a hub-only organisation exists)
  and re-migrate.
- Console: a browser sweep of every hub and clearing screen in light and dark themes at 1366×900 and 390×844 (no page
  overflow, no console errors), and click-throughs of onboarding (token A once), a dispute across three consoles
  (tenant eMSP raises, external CPO rejects, tenant escalates, platform resolves), finalising a run and a fee plan.
