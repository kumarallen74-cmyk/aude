# Compatibility for integrators: v1.5.0 → v1.9.0-dev

**Audience:** anyone whose system talks to PlugSure CSMS without a person in the loop: an operator's ERP or
accounting package, a BI export, a fleet back office, a roaming partner. **Scope:** an **Indonesian (IDR)
organisation on default settings** (`MULTI_COUNTRY` and `HUB_ENABLED` off, every site in Indonesia), upgraded from
the pilot's v1.5.0 through v1.5.1, v1.6.0, v1.7.0/1.7.1, v1.8.0 to 1.9.0-dev.

**Short answer:** an integration built against v1.5.0 keeps working **unchanged**: same paths, same operation ids
(SDK method names), same request bodies (v1.5 field names accepted), same response fields (v1.5 names still sent for
rupiah amounts), same webhook envelope, headers and signature, same CSV columns, same e-Faktur XML, same OCPI
payloads. New things are additions. The exceptions are a handful of **deliberate security fixes** listed in §3; none
of them touches an API-key integration that follows the v1.5 documentation.

## 1. How this was proven

| Check | What ran | Result |
| --- | --- | --- |
| v1.5.0's own e2e suites against the new server | 28 suites from the v1.5.0 commit (`d51e80d`: console, api-sandbox, sdk, ocpi, ocpi-emsp, ocpi-auth, ocpi-profiles, fleet-billing, pricing, card-holds, postpay, payment-methods, linked-wallets, isolation, pilot-fixes, field, integrations, driver, driver-plus, onboarding, brand, console-brand, queue, reservation-fees, pnc, v2x, ocmf, sandbox-2x), unchanged, against a v1.5.0 server and a 1.9.0-dev server side by side | v1.5.0: 1094/1094. 1.9.0-dev: 1087/1094; the 7 differences are the intended security changes in §3 |
| OpenAPI contract | Structured diff of the v1.5.0 document against the current one (paths, parameters, request required fields, response fields, types, enums, webhooks). Now a unit test: `src/api/openapi/compat-v15.test.ts` (fixture `fixtures/contract-v1.5.0.json.gz`) | 0 removed or renamed operations, parameters or fields; 0 operation ids changed; 0 newly required inputs |
| v1.5.0 SDK | The v1.5.0 tarball (`plugsure-csms-sdk-1.5.0`) installed in a scratch project, a scripted "ERP" (an API key with v1.5 permissions: lists, details, CSV/XML exports, creates and updates with v1.5 bodies, webhooks verified with the SDK's helper, the live event stream). Each answer validated against the **v1.5.0** schema of its operation | 45/45 on v1.5.0 and 45/45 on 1.9.0-dev |
| Webhooks | Every delivery captured during the suites (11 event types incl. `ping`) on both servers; payload shapes, headers and signatures compared | Same envelope, headers, `api_version` (`2026-09`), signature scheme; only additions |
| Exports | Every CSV / XML / HTML / PDF the suites downloaded, both servers, compared after masking ids and times; plus a byte comparison on one database upgraded from the v1.5.0 one | Identical structure; byte-identical on the same data |
| OCPI | All OCPI traffic of the ocpi suites (answers and pushes to the partner), both servers | Same shapes; values equal apart from ids |
| Upgrade path | The v1.5.0 database after all suites, dumped, restored and migrated to 1.9.0-dev; every GET of the v1.5.0 document (≈ 260 calls, incl. every export) compared with the v1.5.0 server on the original | Same statuses, content types, fields and values; CSV / HTML / PDF text identical |

## 2. What changed for an IDR integrator

### 2.1 Operator API (`/v1`, API keys)

| Area | v1.5.0 | Now | Action |
| --- | --- | --- | --- |
| Paths and methods | 276 operations | 323: all 276 unchanged, 47 added (Microsoft sign-in, organisation settings and tax registrations, roaming settings and parties, PlugSure Hub membership and clearing, Android notifications / app configuration, MFA reset) | None |
| Operation ids (SDK method names) | — | unchanged for all 276 | None |
| Permissions per operation (`x-permissions`) | — | unchanged for all 276 | None; a v1.5 key keeps its access |
| Money in responses | `totalIdr`, `total_idr`, `ppnIdr`, `pbjt_idr`, `dpp_idr`, … | The amount is now `totalMinor`, `total_minor`, `taxMinor`, `local_tax_minor`, `tax_base_minor`, … **and the v1.5 name is still sent beside it with the same value** whenever the amount is in IDR (always, for an Indonesian organisation). Objects gain `currency` | None. Plan to read the `*Minor` names before a future `/v2` |
| `Deprecation` header | — | Responses carrying a legacy name have `Deprecation: true` and `Link: </api-docs.html#money>; rel="deprecation"` | Informational |
| Money in requests | v1.5 names (`amountIdr`, `pbjtRateBps`, `reservationFeeIdr`, `spendLimitIdr`, …) | Still accepted (mapped to the new names). Sending both names with different values is a 400; a rupiah name on an amount in MYR/SGD is a 400 (cannot happen for an IDR organisation) | None |
| Rate limits per API key | token bucket, `RateLimit-*` headers, 429 + `Retry-After` | unchanged (per-device limits of 1.9 apply to the driver app API `/d/v1`, not to keys) | None |
| Errors | `{ "error": … }`, 400/401/403/404/409/422/429 | unchanged | None |
| Hub operations (`/v1/roaming/hub…`) | did not exist | published, answer **404** while `HUB_ENABLED` is off (documented on each operation) | Ignore |
| Live event stream `GET /v1/stream` | `{kind, payload}`; `cdr.created.totalIdr`, `refund.*.amountIdr`, `payment.hold_*.capturedIdr / releasedIdr` | same, plus `totalMinor` / `amountMinor` / … and `currency` | None |

### 2.2 Webhooks

| Area | v1.5.0 | Now |
| --- | --- | --- |
| Event types | 11 | the same 11, no new types |
| Envelope | `{ id, type, created_at, api_version, data }`, `api_version: "2026-09"` | unchanged |
| Headers | `PlugSure-Event`, `PlugSure-Delivery`, `PlugSure-Signature: t=…,v1=<HMAC-SHA256>`, `User-Agent: PlugSure-Webhooks/1.4` | unchanged |
| `cdr.created` | `cdrId, sessionId, totalIdr` | + `totalMinor`, `currency` (`totalIdr` kept, equal) |
| `refund.due` / `refund.completed` | `amountIdr`, … | + `amountMinor`, `currency` (`amountIdr` kept) |
| `alert.raised` `kind` values | open set | new kinds may appear: `payment.amount_mismatch` (v1.5.1), `roaming.hold_shortfall`, `roaming.hold_unsettled`, `roaming.cdr_unmatched`, `roaming.currency_mismatch` (v1.7) |
| Retries, dedupe on `id` | — | unchanged |

### 2.3 SDK

| Area | Now |
| --- | --- |
| The v1.5.0 tarball you already use | Works unchanged against 1.9.0-dev (all 276 methods exist with the same names; answers fit its types; `parseWebhook` / `verifyWebhookSignature` verify real deliveries) |
| Upgrading to the 1.9.0-dev tarball | Same method names. Rupiah fields are typed under the new names; the v1.5 names are still in the types as **deprecated, optional** (`totalIdr?: number`), because they are absent for MYR/SGD amounts. Code compiled with `strictNullChecks` that reads `totalIdr` needs `?? 0` or a switch to `totalMinor`. Request types accept either name for a required amount |

### 2.4 Exports

| Export | Format now (IDR organisation) |
| --- | --- |
| `GET /v1/sessions.csv` | **Byte-for-byte the v1.5 file**: UTF-8 with BOM, CRLF, the same 25 columns in the same order (`session_id` … `gross_total_idr`), kWh with 3 decimals, rupiah integers. Only an organisation with a site **outside** Indonesia gets the multi-currency columns (`…_minor`, `currency` last) |
| `GET /v1/billing/statement.csv`, `.html` | unchanged |
| `GET /v1/fleet-invoices/{id}/invoice.csv`, `.html`, `.pdf`; fleet portal copies | unchanged columns and layout |
| `GET /v1/fleet-accounts/{id}/statement.html`, `.pdf`; credit notes `.pdf` | unchanged |
| `GET /v1/roaming/abroad.csv` | unchanged (17 columns, `currency` already present in v1.5) |
| `GET /v1/fleet-billing/periods/{period}/efaktur.xml` (Coretax) | unchanged: the generator gives byte-identical XML for the same invoices; same `X-PlugSure-Skipped` header and 409 gates |
| `GET /v1/sessions/{id}/receipt`, `/signed-data.xml` | unchanged |
| Console CSV buttons (availability, billing) | unchanged headers for an IDR organisation (`Revenue IDR`) |
| Formula-injection guard (`'` before `= + - @`) | unchanged in these exports |

### 2.5 OCPI 2.2.1 peers

| Area | Now |
| --- | --- |
| Peer (non-hub) connections, CPO and eMSP roles | Unchanged: locations, tariffs (IDR, same prices), sessions, CDRs, tokens, commands, charging profiles; same shapes and values |
| A partner of kind **hub** (an external roaming hub) | Must send `OCPI-from-country-code` / `OCPI-from-party-id` on functional requests (§3) |
| PlugSure Hub (v1.8) | Off by default; nothing under `/hub` exists |

## 3. Intentional changes (security and money safety) — not regressions

These made 7 of v1.5.0's own e2e checks fail on purpose. None affects an API-key integration.

| Change | Since | Who notices | Why |
| --- | --- | --- | --- |
| Requests from an OCPI **hub** partner must carry `OCPI-from-*` (else 2001 / HTTP 400), are checked against the hub's announced parties, and see only that party's objects | v1.7.1 | Operators with a roaming partner of kind *hub* (4 checks of ocpi-profiles) | Parties behind one hub could read and act on each other's sessions, CDRs and tokens. OCPI 2.2.1 says SHALL. Peer connections unchanged |
| A payment notification for **less** than the payment is recorded, voided and refunded in full (critical alert `payment.amount_mismatch`), instead of being left pending | v1.5.1 | Payment flows (1 check of integrations) | Money was stranded on a pending payment |
| A driver sign-in code works only on the device that asked for it | v1.5.1 | Driver app (1 check of integrations) | A stranger could use or lock out a number |
| Fleet driver sign-in answers one uniform error (lock still applies after 5 wrong PINs) | v1.5.1 | Driver app (1 check of driver) | The old message told an attacker the card was locked |
| `NODE_ENV` must be set (unset = refuse to start) | v1.5.1 | Whoever deploys | Fails closed instead of running as development |
| Two-step verification required for **console administrators** (`user:write` or `platform:*`) outside development | v1.5.1 | A script that signs in with an administrator's **password** (`POST /v1/auth/login`) | Machines must use API keys (as v1.5 already advised); keys are unaffected |
| API keys cannot change or disconnect the Microsoft tenant | v1.6.0 | — (new operations) | |

Database columns: migration 060 (v1.7.0) renamed the 61 `*_idr` columns to `*_minor` (and three rate columns). The
database is not an integration surface; a report or ETL reading tables directly must use the new names (mapping in
`tools/codemods/idr-to-minor.mts`; rollback `db/rollback/060_down.sql`).

## 4. Breaks found by this review and fixed (in this release, before the pilot upgrade)

| Surface | Break in 1.9.0-dev as it was | Fix |
| --- | --- | --- |
| Sessions CSV | Header renamed to `…_minor` + `currency` column for every organisation: an ERP import mapping `gross_total_idr` failed | An organisation whose sites are all in Indonesia gets the v1.5 columns byte for byte; multi-currency columns only with a site abroad (`session-query.ts`, test `services/compat-v15.test.ts`) |
| `GET /v1/sessions/search` | `totals.energy_wh`, `revenue_minor`, `local_tax_minor`, `tax_minor` returned as **strings** (v1.5 and the document: numbers) | Numbers again |
| OpenAPI document / SDK types | `POST /v1/checkout/qris`, `PUT /v1/loyalty`, credit-note lines **required** the new names (`amountMinor`, …): a client validating against the document (or the new SDK's types) could not send the v1.5 body the server still accepts | A required amount may be given under either name (`anyOf` in request bodies); responses still promise the new name |
| OpenAPI document | Hub operations answered 404 with the hub off but documented only 200 (v1.5's contract test failed) | 404 documented, with the condition |
| `GET /v1/stream` | Events written raw: `cdr.created.totalIdr`, `refund.*.amountIdr`, `payment.hold_*.capturedIdr` disappeared | Legacy names added for IDR as in responses and webhooks (`legacy-money.ts liveEventForClient`, test) |

## 5. ERP integrator checklist

1. **Before the upgrade:** note your API key ids and webhook endpoint ids; nothing needs to change in your code.
2. **Authenticate with an API key** (`Authorization: Bearer psk_…`). If any job signs in with a console user's
   password, move it to a key now: administrators need two-step verification after v1.5.1.
3. **Money fields:** keep reading `totalIdr` / `total_idr` / `ppnIdr` / `pbjt_idr` / `dpp_idr` …; they are still
   sent for every rupiah amount. Ignore the `Deprecation: true` header or log it. When convenient, switch to the
   `…Minor` / `…_minor` names and read `currency` (for IDR the value is identical: whole rupiah).
4. **Ignore unknown fields** (`currency`, `*Minor`, new objects) and unknown enum values such as new
   `alert.raised` kinds, as the v1.5 document already asked.
5. **Webhooks:** no change. Keep verifying `PlugSure-Signature` on the raw body and deduplicating on `id`.
6. **CSV imports:** no change while all your sites are in Indonesia. If you ever open a site outside Indonesia, the
   sessions CSV switches to `…_minor` columns plus `currency`: map them before that day.
7. **e-Faktur / Coretax:** no change in the XML or the settings it needs.
8. **SDK:** the v1.5.0 tarball keeps working. If you upgrade it, fix `strictNullChecks` errors on the deprecated
   `*Idr` properties (now optional) or move to `*Minor`.
9. **OCPI:** peers: nothing. If your partner is a *hub*, confirm it sends `OCPI-from-*` headers (OCPI 2.2.1).
10. **After the upgrade:** call one list endpoint and one export with your key, send a test webhook ping
    (`POST /v1/webhooks/{id}/test`), and compare one day's sessions CSV with the day before.
