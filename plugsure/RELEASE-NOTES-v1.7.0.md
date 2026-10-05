# PlugSure CSMS v1.7.0 — release notes

**Date:** 3 October 2026
**Base:** v1.6.0
**Design and implementation notes:** [`docs/MULTI-COUNTRY-DESIGN.md`](docs/MULTI-COUNTRY-DESIGN.md) (§10 WP1, §11 WP3, §12 integration)

## Overview

v1.7.0 lets one operator run chargers in **Indonesia, Malaysia and Singapore**. A site has a country, and its country
decides the currency, the tax, the price rules, the time zone, the payment methods and the OCPI identity. Nothing is
converted between currencies anywhere (no FX). A foreign driver pays in the site's currency and the card issuer does
the conversion.

**For the live Indonesian pilot, behaviour does not change.** Every v1.6 amount keeps its value, the Indonesian tax
arithmetic is the v1.6 code moved behind an interface (371 golden cases replay byte for byte, and every pilot CDR
re-rates with zero difference), Indonesian receipts, invoices, statements and driver messages are unchanged, and
the v1.6 API field names still work. One migration (060) renames columns. It needs a **short maintenance window**
with both processes stopped. The rest is additive. See the upgrade steps below.

Malaysia and Singapore stay off until the platform sets `MULTI_COUNTRY=true`.

## Countries & currencies

- **Country on the site** (`site.country_code`: `ID`, `MY`, `SG`; default the organisation's home country). The
  currency comes from the country: IDR, MYR, SGD. A site cannot change country once it has sessions (409).
- **Organisation:** home country, reporting time zone, default language and per-country tax registrations
  (*Govern → Organisation*; `GET /v1/countries`, `GET/PUT /v1/org/settings`, `POST /v1/org/tax-registrations`).
  An organisation may run sites in several countries.
- **Money in minor units of each row's currency.** Every `*_idr` column is now `*_minor`, and every money-bearing row
  carries `currency`, which is frozen when the row is created. IDR keeps PlugSure's exponent 0 (whole rupiah, as
  stored before), so no existing value changes. MYR and SGD are stored in sen and cents. Amounts of different
  currencies are never added: totals, KPIs, statements and invoices are per currency.
- **Time zones** per site (WIB/WITA/WIT, MYT, SGT, validated per country) and per organisation (dashboards, alerts,
  billing days). The Jakarta defaults in services are gone. `ALERT_TIMEZONE` and `BILLING_TIMEZONE` remain the
  platform's defaults.
- Phone numbers: +62, +60 and +65 mobiles. Charger certificates carry `C=` the organisation's home country.

## Tax

One engine per scheme, chosen per CDR by the site's country and the organisation's registration there:

| Scheme | When | What |
|---|---|---|
| `ID_PPN_PBJT` | Indonesian sites | Exactly v1.6: PPN 12 % on DPP 11/12, PBJT-TL per site, same env settings (`PPN_*`, `PBJT_*`, `ROUNDING_UNIT_IDR`) |
| `SG_GST` | SG site, organisation GST-registered | 9 %, prices **GST-inclusive** by default (IRAS display rule) |
| `MY_SST` | MY site, registered **and** "EV charging taxable" ticked | 8 % service tax. **Off by default** (open question V1) |
| `NONE` | otherwise | no tax; receipts say why |

The same engines tax reservation fees, 30-day passes, fleet invoices and credit notes. On MY/SG fleet invoices the
tax of each line is **extracted from the sum of the receipts' gross** (`round(gross × rate / (10000 + rate))`), so an
invoice never charges a fleet more than the prices its drivers were shown. Indonesian invoices keep PPN on DPP 11/12
per line, as v1.6.
Per-site exemptions apply in every engine. MY/SG receipts are in English and use the engine's labels: GST with the
registration number (*Tax Invoice* when GST is charged), service tax, or "no tax charged". e-Faktur carries rupiah
invoices only. MyInvois is an export stub (later phase).

## Price rules

- **Regulatory profiles** per country. **ID** keeps everything as before: PLN formula ceilings, Kepmen 182.K/2023 fee
  caps, WBP/LWBP and tera (meter verification) blocking. **MY and SG** have no price regulation; only the platform
  caps apply, including the idle-fee cap (`IDLE_FEE_CAP_MYR`, `IDLE_FEE_CAP_SGD`, default 30.00). There are no PLN or
  formula rates and no tera gate. Reservations and site queues now use the site country's profile too.
- **Tariffs** carry a country, a currency and *prices include tax*. A tariff applies only within its country, and
  assigning it across countries is refused. An MY/SG site with no tariff of its own country is parked for review
  (`RATE_MISSING`). It is never charged at the Indonesian default.
- Prepaid presets and the per-transaction maximum come from the country: presets Rp 50k–500k, RM 10–100 and
  S$10–80; maximum the QRIS cap (Rp 10m), RM 1,000 and S$500.

## Payments (Stripe)

Malaysian and Singapore sites take payments through **Stripe**, with **one Stripe account per country**, connected by
the operator (or the platform) under *Govern → Integrations → Payments* with the country set. A charger's payments,
reservation fees, passes and unpaid-session payments go to the account of **its site's country** (`paymentsFor(org,
country)`), never to another country's account. Indonesian payments (Midtrans, Xendit, BI-SNAP) are unchanged. Guide:
[`deploy/STRIPE.md`](deploy/STRIPE.md).

- **Cards (MY, SG):** a **hold** for the amount the driver chooses. Only the session's total is captured and the rest
  is released at once. Unused holds are cancelled. Cards are entered on PlugSure's Stripe Payment Element page
  `/pay/stripe/<ref>/<payment intent>`, which asks for **no e-mail, phone or name** (the Singapore guest rule). Its CSP
  admits `js.stripe.com` on that path only, and it has a *Cancel and go back to the app* link. Signed-in drivers may
  save a card at Stripe for one-tap payments.
- **PayNow (SG):** a QR code shown in the app like QRIS, valid for one hour. The app polls until Stripe confirms, and the
  unused balance is refunded through Stripe.
- **FPX (MY):** the driver chooses the bank on the Stripe page (Stripe's bank list and terms), then approves in online
  banking. Unused balance is refunded to the bank account. RM 2 – RM 30,000.
- **GrabPay (MY, SG):** redirect to GrabPay; unused balance refunded.
- **Limits:** Stripe's minimum charge (S$0.50, RM 2.00) and FPX's band are checked before Stripe is asked.
- **Webhooks:** the Stripe-Signature is verified (HMAC-SHA256, 5-minute tolerance, rolled secrets). Each event is
  applied once (a replay is acknowledged, not re-applied). Events from another account or organisation are refused,
  underpayments are refused with a critical alert, and a payment in the wrong currency is never booked.
- **Test keys** are refused in production unless an integration explicitly allows test mode, and **only a platform
  administrator** may allow it (audited as `integration.test_mode_allowed`). Every payment through an account on
  test keys is tagged **TEST** (`payment_intent.test_mode`, `cdr.test_mode`). Its receipt reads *TEST — not a tax
  invoice*, and it is left out of commission statements and revenue totals. The console marks such sessions and
  accounts TEST.
- Return path: Stripe returns to `/app/paid.html` with `redirect_status`. A failure or cancellation shows *Payment
  cancelled*; anything else resumes the payment screen.

## Roaming for app drivers

- Partner networks (PlugSure as eMSP) are open to **every signed-in app driver**, not only fleet cards, once the
  operator switches it on (*Roaming → App drivers*, `GET/PUT /v1/roaming/settings`).
- Before `START_SESSION`, a **card hold in the partner location's currency** is placed through the operator's account
  for that country (`authorization_reference` = the payment). Default holds: Rp 300,000, RM 100.00, S$80.00, which
  each operator can change per currency, down to a floor (Rp 50,000 / RM 20 / S$15 by default, never below Stripe's
  minimum; `ROAMING_HOLD_MIN_IDR|MYR|SGD`). When an accepted partner CDR arrives, at most the hold is captured.
  - **A shortfall is owed by the driver.** The app's Home shows it, and the driver pays it in the app through the
    unpaid-session flow (`/d/v1/unpaid`, `…/pay-unpaid`). No new partner charge, and no new prepaid charge, is
    accepted until it is paid.
  - A currency mismatch releases the hold with an alert. A refused start releases the hold at once.
  - A hold with no CDR within 4 days is settled from the last session cost, or released (worker `roaming-holds`).
  - A **CDR arriving after that sweep** is still settled: anything short of its total is owed by the driver (as
    above), and anything captured beyond it is refunded.
  - An accepted APP_USER CDR that matches no hold of ours is **held for review with an alert**
    (`roaming.cdr_unmatched`), not dropped.
- One virtual `APP_USER` token per (operator, driver). In a CPO's real-time check it is valid only while a hold
  opened for **that partner and that location** is open and not yet used by a session. It is never valid at the
  operator's own chargers.
- Fleet cards: spending limits per currency (a limit in another currency **fails closed**). CDR plausibility caps per
  currency: Rp 25,000, RM 10 and S$5 per kWh. An unknown currency is held for review.

## Console & driver app

**Console:** money in each row's currency everywhere (sessions, dashboard, refunds, holds, promotions, plans, loyalty).
Site and tariff forms are per country, and the Indonesian fields are shown only for ID. There are organisation
settings and tax registrations, and Stripe integrations per country (`paymentsByCountry`). Fleet invoices, credit
notes, fleet portal, commission and platform statements are **per currency**: one per (account or owner, month,
currency).

**Driver app:**
- Stations, prices, presets, quotes, sessions, receipts, passes and reservation fees are in the site's or plan's
  currency. Partner networks for app drivers show the hold.
- Language: the driver's choice → the device's language → the operator's default (English for MY/SG brands) →
  Indonesian.
- **Payment methods are rendered from the server's list.** PayNow uses the QR screen with its expiry time, FPX and
  GrabPay use the redirect screen, and card payments use the Stripe page. A method the app does not know shows the
  server's label.
- **Server messages in the driver's language.** The app sends `X-Driver-Lang`. Driver API errors, reasons and labels
  come back in English for English-speaking drivers, which is the default at Malaysian and Singapore chargers when no
  language is sent (`src/driver/i18n.ts`). Indonesian drivers get exactly the v1.6 Indonesian text. kWh figures follow
  the app's language.
- Acquirer descriptions (bank statement text) are English outside Indonesia.

## OCPI

- **One party per (organisation, country).** Credentials `roles` list every CPO party plus the home eMSP role (one party
  = v1.6). Locations, tariffs, sessions and CDRs use the party of the site's country, with `country` (alpha-3) and
  `time_zone` from the site. A site in a country the organisation has **no party** for is not published under
  another country's identity. It stays unpublished with the problem "no OCPI party for MY", and so do its tariffs. `OCPI-to-country-code/-party-id` filters lists. Manage parties under `GET /v1/roaming/parties`
  and `PUT|DELETE /v1/roaming/parties/:country`.
- Tariffs are in the site's currency, with prices **excl. VAT** plus the country's `vat` (ID 11, SG 9, MY none
  unless taxed). Inclusive rates are published net. Alt text is English outside Indonesia.
- Partner kind **`authority`** (LTA): Locations + Tariffs of SG sites only, with a 5-minute full-status heartbeat
  (`ocpi-authority-heartbeat`). LTA's real endpoint and handshake are still open (V3).

## API compatibility

- **New names.** Amounts are `*Minor` / `*_minor` in the currency named next to them (`currency`). Indonesian tax
  fields have neutral names (`taxMinor`, `taxBaseMinor`, `localTaxMinor`, `taxTotalMinor`, `localTaxRateBps`).
- **Legacy names kept for IDR.** In `/v1` and `/d` responses and in webhook payloads, every renamed amount whose
  currency is IDR (or not stated) also carries its **v1.6 name** (`totalIdr`, `ppnIdr`, `total_idr`, …) with the same
  value. Responses that carry one have the header **`Deprecation: true`** and `Link: </api-docs.html#money>;
  rel="deprecation"`. MYR/SGD amounts get **no** `*Idr` alias (a rupiah field holding sen would be a silent error).
- **Requests** may still use the v1.6 names. A body that names both with different values is refused (400).
  A v1.6 name for an amount that is **not in rupiah** is also refused (400). That covers a body naming a non-IDR
  currency next to it, and `spendLimitIdr` for a card whose limit is in MYR/SGD. Such an amount is never read as sen.
- The OpenAPI document marks the legacy names deprecated. They are removed only in a future `/v2`. The SDK is
  regenerated (290 operations). Webhook events `cdr.created`, `refund.*` and `payment.hold_*` carry `currency`.
- New and changed operations: countries, organisation settings and tax registrations, roaming parties and settings,
  per-currency statements (`?currency=`), and integrations per country (`countryCode` on `PUT/DELETE
  /v1/integrations/payments` and `POST …/test`, `paymentsByCountry` in `GET /v1/integrations`). The payment `provider`
  may be `stripe`, with channels `PAYNOW`, `FPX`, `GRABPAY` and method `qr` (PayNow) or `bank` (FPX).
- Frozen documents (CDR lines, invoice and statement data, commercial plans, the OCPI cache) are **not rewritten**.
  They are read through `upgradeLegacyKeys`, and 68 documents re-render byte-identically after the migration.

## Upgrade steps for the live Indonesian pilot

**New settings:** `MULTI_COUNTRY` (default `false`: Indonesian behaviour only), `IDLE_FEE_CAP_MYR`, `IDLE_FEE_CAP_SGD`,
`ROAMING_HOLD_MIN_IDR|MYR|SGD` (optional floors for roaming holds).
Stripe keys are not environment variables (Integrations, sealed with `SECRETS_KEY`). There is no new npm dependency,
but run `npm ci` (the lockfile carries the new version).

**Migrations, in the order `npm run migrate` applies them:**

| Migration | What | Downtime |
|---|---|---|
| 059 | countries, currencies, `currency` on every money row (constant defaults, `NOT VALID` FKs), country/time-zone columns | none (additive; v1.6 runs on it) |
| **060** | **rename `*_idr` → `*_minor`** and the Indonesian tax columns, index/PK swaps (integration per country, commission per currency, OCPI party per country) | **maintenance window: both processes stopped** |
| 061 | validate the 059 constraints | none |
| 062, 063 | roaming settlement columns; commercial plans per currency | none |
| 070 | `payment_webhook_event`, `subscription_charge.via` + `qr`, `bank` | none |
| 071 | review fixes: `test_mode` on integration / payment_intent / subscription_charge / cdr (tagged by triggers), roaming shortfall paid-at, `late_cdr` outcome | none |

The migrator has no stop point, so one `npm run migrate` in the window applies 059 → 060 → 061 → 062 → 063 → 070 → 071.

**Rehearsal timings** (copy of the pilot, PostgreSQL 16; WP1 rehearsal + v1.7.0 integration run):
059 ≈ 55–152 ms, 060 ≈ 52–135 ms, 061 ≈ 78–84 ms, 062 ≈ 72–76 ms, 063 ≈ 65–80 ms, 070 ≈ 73–84 ms, 071 ≈ 81 ms (per
file, including `psql` start-up). The whole `npm run migrate` takes under 1 s of wall time including Node start-up. The rollback script took
116–124 ms, and re-applying 060 afterwards took ≈ 52 ms. The rehearsal checked:
- all 71 money sums and JSON digests unchanged;
- every value unchanged under its new name and every currency `IDR`;
- all 23 FKs valid;
- `rerate-compare`: 0 differences;
- 68 frozen documents byte-identical;
- the v1.6 code passed its e2e suites on the 059 schema, and v1.7 passed them on the migrated data.

**Steps:**

1. **Before the window:** on a **copy** of production (restore the latest dump, then re-apply the `app.rls_bypass`
   role default: `deploy/pitr/RESTORE.md` §2a), run `npm run migrate` and then
   `DATABASE_URL=… npx tsx tools/multicountry/rerate-compare.mts` with the production tax environment. It must report
   zero differences. (It only reads and has no `--dry` flag. It needs the 060 schema, so it cannot run against
   production before the window.)
2. **Window** (low-traffic hour, about 02:00 WIB; plan for 5 minutes, expect under 1):
   1. Announce, and note the PITR point or take a base backup (`deploy/pitr/RESTORE.md`).
   2. `systemctl stop plugsure-api plugsure-gateway`. Chargers keep charging on local authorisation and queue their
      messages.
   3. Deploy v1.7.0, then run `npm ci && npm run migrate` as the migration owner (systemd: `plugsure-migrate.service`).
   4. `npx tsx tools/multicountry/rerate-compare.mts` against production: **zero differences**, otherwise roll back.
   5. Start the gateway, then the API. Watch charger reconnects and offline-queue replay, `/v1/platform/health`, the
      first CDRs and payment notifications. Check a v1.6 API client: it still reads `totalIdr`, now with a
      `Deprecation` header.
3. **Rollback** (only if step 2.4 or 2.5 fails): stop both processes, run
   `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/060_down.sql` as the migration owner, redeploy v1.6.0,
   and start the gateway, then the API.
   - The script deletes its own `schema_migration` row, so no separate `DELETE` is needed.
   - It refuses to run while any row is in MYR/SGD or an organisation has more than one OCPI party.
   - It leaves the additive 059, 061–063 and 070 in place. v1.6 runs on them, as the rehearsal showed.
   - A later `npm run migrate` re-applies 060 alone.
4. **Restores after the upgrade.** `pg_restore` does **not** bring back the role setting that migration 048 made
   (`ALTER ROLE plugsure_app IN DATABASE <db> SET app.rls_bypass = 'on'`). Re-apply it after every logical restore,
   before the apps start: `deploy/pitr/RESTORE.md` §2a has the exact command and a check. A physical PITR restore keeps
   it.
5. **MY/SG later.** Set `MULTI_COUNTRY=true` once the human actions below are closed. Then:
   - create the sites (home country MY or SG for a new operator) and the tax registrations;
   - connect one Stripe account per country in test mode first, and run `deploy/STRIPE.md` §4;
   - add the OCPI parties, and the LTA partner for SG once V3 is closed;
   - set the commission plan in MYR/SGD and the roaming holds.

## Actions needing a human

| # | Action | Owner | Blocks |
|---|---|---|---|
| Stripe | Stripe account approval for the SG and MY entities; activate PayNow (SG), FPX (MY), GrabPay | Operator / PlugSure | Any MY/SG payment |
| V4 | Confirm with Stripe **in writing** that MCC 5552 (EV charging) may use **PayNow** (Stripe's PayNow terms exclude service stations / fuel dispensers), and the **minimum partial capture** below S$0.50 / RM 2.00 | PlugSure → Stripe | Ticking PAYNOW. Card holds alone meet LTA's payment rule |
| — | Stripe test-mode acceptance (`deploy/STRIPE.md` §4): Payment Element with e-mail/phone `never`, SG hold captured below the hold, PayNow webhook, MY FPX test bank, PayNow refund via `refund.updated` | PlugSure | Go-live |
| V2 | **LTA:** is a PayNow pre-purchase with refund of the unused balance a "deposit" under licence condition §2.4.10(iii)? | SG counsel / LTA | PayNow as an SG *guest* method (the default guest method is the card hold) |
| V3 | **LTA:** the OCPI feed endpoint, credentials handshake, push or pull, and module set for the `authority` partner | LTA onboarding | Enabling the LTA partner |
| V7 | SG tax-invoice wording on receipts (GST registration no., simplified tax invoice) | SG tax adviser | Final SG receipt template |
| V1 | **Malaysian SST tax advice:** is public EV charging a taxable service, and at 6 % or 8 %? | MY tax adviser | Ticking "EV charging taxable" (off by default) |
| V5 | **MyInvois threshold** (RM 1m vs RM 3m exemption) and the consolidated B2C e-invoice deadline | MY tax adviser | MyInvois submission (later phase; export stub now) |
| V6 | **MYR/SGD commission figures** (the plans in code are placeholders, `TODO(commercial)` in `services/commission-calc.ts`), plus which PlugSure entity bills MY/SG operators and the tax on that fee | PlugSure finance / counsel | MY/SG commission statements (issued **without tax**, and marked so, until closed) |
| Holds | **Roaming hold amounts per operator** and currency (defaults Rp 300,000 / RM 100 / S$80; *Roaming → App drivers*), and whether to switch roaming on for app drivers | Each operator | Roaming for app drivers |

## Review fixes

An independent review of the branch (no critical findings) led to these changes. Each one has tests.

| # | Finding | Fix |
|---|---|---|
| High 1 | An operator with `org:write` could save Stripe test keys with *Allow test mode*: test cards would dispense real energy, with GST/SST receipts and commission | Only `platform:admin` may allow test mode (403 otherwise; audited). Payments through a test-key account are tagged TEST (migration 071 triggers): receipts *TEST — not a tax invoice*, no commission, no revenue; TEST badges on sessions and on the integration (`src/services/review-fixes.test.ts`) |
| Medium 2 | App-driver roaming: a late CDR after the 4-day sweep was ignored; an unmatched APP_USER CDR returned silently; a shortfall was only alerted | Shortfalls and late CDRs are owed by the driver and paid in the app (unpaid flow); over-capture is refunded; new roaming holds and prepaid charges are refused while one is owed; unmatched CDRs are held for review with an alert (`src/driver/roaming-pay.test.ts`) |
| Medium 3 | Fleet invoice months, commission periods, pass/promotion months, the fleet portal's month and alert quiet hours used the platform zone (WIB) | `services/org-timezone.ts`: the organisation's zone for its home currency, the currency's country zone for another currency; Indonesia keeps `BILLING_TIMEZONE` / `ALERT_TIMEZONE` (month-boundary tests for SG) |
| Low 5b | A v1.6 client's `*Idr` key for a non-IDR amount was read as sen | Refused with a 400 that names the right key |
| Low 7 | `amountForRate` used floating point for MYR/SGD | Integer (BigInt) decimal arithmetic, half-up as `Math.round`; IDR is the v1.6 expression unchanged (371 golden cases unchanged; IDR sweep test) |
| Low 8 | SG fleet invoices re-taxed the summed net (could exceed the receipts by a cent per line) | GST extracted from the receipts' gross per line; the invoice equals the sum of the receipts |
| Low 9 | OCPI fell back to the home (ID) party for a country without one; holds had no floor; a hold guaranteed charges at any location | No fallback (unpublished and flagged); hold floor per currency; a hold is tied to its partner, location and one session |

Also from the review: no `*_idr` alias for an amount whose sibling `*_currency` is not IDR (8c123de). `060_down`
refuses to run while a tariff, card limit, site or live payments account is in another country (18672eb). A Live
Activity shows no cost for MYR/SGD sessions until the widget formats by currency (07a8aa3).

## Known limitations

- **No FX anywhere**, not even an indicative display amount. A foreign card is converted by its issuer.
- Malaysia has **no DuitNow QR, Touch 'n Go or Boost**, and Singapore has **no NETS**. These are phase 2 (Xendit MY or
  another acquirer).
- Live **MyInvois** submission and SG **InvoiceNow** are not built (MyInvois has an export stub).
- **Languages:** Indonesian and English only (no Malay or Chinese). Server messages are translated at the API
  boundary from an Indonesian source text; a new driver message needs its English in `src/driver/i18n.ts`, which a
  unit test enforces. The operator console is not translated by country.
- The **Stripe card page cannot be exercised end to end** without Stripe.js. The local fake covers the API and
  webhooks, but the Payment Element itself needs the manual test-mode run.
- A PayNow QR that expires unpaid ends the checkout. The driver starts a new one, and there is no automatic re-issue.
- The operator-API QRIS checkout (`POST /v1/checkout/qris`) stays Indonesian. It refuses an MY/SG charger (409
  `qris_not_in_country`), so MY/SG sites are paid through the driver app.
- Sessions on MY/SG sites with no tariff of their own country are parked (`RATE_MISSING`), not charged.
- The country-literal ratchet (`npm run check:country-literals`) still lists Indonesian literals in console and
  driver-app files. The count may only go down.
