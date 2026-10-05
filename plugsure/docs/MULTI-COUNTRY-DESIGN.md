# PlugSure CSMS — Multi-country / multi-currency design (Indonesia, Malaysia, Singapore)

**Status:** design for the release after v1.6.0 (base: `master` @ 977d92c). **Audience:** the engineers implementing WP1–WP3.
**Date:** 3 October 2026. Items marked **[VERIFY]** are not confirmed from a primary source and must be closed (tax adviser, regulator, acquirer) before the behaviour they control goes live in that country. None of them blocks WP1.

---

## 1. Summary

PlugSure today is Indonesia-only in its data model and arithmetic, not only in its UI: 61 money columns are named `*_idr` and hold whole rupiah, one global `config.tax` (PPN 12 % × DPP 11/12 + per-municipality PBJT) taxes everything, every tariff is validated against PLN/Kepmen ceilings, OCPI output hardcodes `IDR`, `IDN` and `Asia/Jakarta`, payments assume Indonesian rails, and about 20 files default to Jakarta time.

This release makes **country a property of the site** (with an organisation default), stores **every amount as an integer in the currency's PlugSure unit plus a `currency` column**, and puts country-specific behaviour behind four registries:

| Registry | ID (unchanged behaviour) | MY | SG |
|---|---|---|---|
| Money unit (`domain/money.ts`) | IDR, exponent **0** (whole rupiah, as stored today) | MYR, exponent 2 (sen) | SGD, exponent 2 (cents) |
| Tax engine (`services/tax/`) | `ID_PPN_PBJT` (current arithmetic, byte-identical) | `MY_SST` service tax, **off unless the org is registered and EV charging is confirmed taxable** [VERIFY] | `SG_GST` 9 %, GST-inclusive consumer prices |
| Regulatory profile (`services/regulatory/`) | PLN formula + ceilings, Kepmen 182.K/2023 fee caps, tera blocking, WBP/LWBP | no price regulation; platform safety caps only | no price regulation; LTA rules: guest option, accepted payment modes, OCPI data feed |
| Payment provider (`services/payments/`) | Midtrans, Xendit, SNAP QRIS (unchanged) | **Stripe** (cards with holds, FPX, GrabPay) | **Stripe** (cards with holds, PayNow, GrabPay) |

Key decisions in one line each:

1. **Country and currency live on the site** (`site.country_code`, currency derived from the country); the organisation has a home country, a reporting time zone and per-country tax registrations. One organisation may run sites in several countries.
2. A charge is always **priced, taxed, paid and settled in the site's currency**. **No FX conversion of money anywhere in this phase**; a foreign driver pays in the site currency and the card issuer converts.
3. **Rename `*_idr` → `*_minor`** (and Indonesian tax names to neutral ones), add `currency` to every money-bearing row, backfill `'IDR'` through constant defaults (instant). Existing values are not touched: IDR's PlugSure exponent is 0.
4. Public API and webhooks stay backward compatible: legacy `*Idr` / `*_idr` fields are emitted as aliases while the amount's currency is IDR.
5. One new acquirer adapter, **Stripe**, for MY and SG. Adyen is broader but heavier; Xendit MY is the phase-2 add-on for DuitNow QR and Touch 'n Go.
6. Roaming (PlugSure as eMSP) opens to **all signed-in app drivers**, guaranteed by a **card hold in the partner location's currency**; spending limits and CDR plausibility caps become per-currency and **fail closed** for an unknown currency.
7. OCPI: one **party per (organisation, country)**, all listed in the credentials `roles`; currency, `country` and `time_zone` come from the site; prices are published excl. VAT with the country's VAT %.

Work is split into three sequential work packages: **WP1 core** (schema, money, country, tax, regulatory, rating, time zones, OCPI), **WP2 apps** (roaming for all drivers, eMSP currency handling, console / driver app / documents, i18n, commission and fleet billing), **WP3 payments** (Stripe adapter, per-country acquirer routing). WP1 is split into an additive part (zero downtime) and a rename part (one short maintenance window).

---

## 2. Research findings

### 2.1 Per-country facts that drive the design

| # | Topic | Finding | Design consequence | Source(s) | Confidence |
|---|---|---|---|---|---|
| MY-1 | Service tax: rate | Malaysian service tax is **8 %** ad valorem for most taxable services (6 % for a few groups); registration threshold for most taxable services is a turnover of **RM 500,000** in 12 months. | `MY_SST` engine: rate 800 bps by default, per-org registration flag | [PwC Malaysian Tax Booklet — service tax](https://pwc.com/my/en/publications/mtb/service-tax.html) | High |
| MY-2 | Is public EV charging a taxable service (incl. the 1 July 2025 expansion)? | **Not found** in the published taxable-service lists we could read: the July 2025 expansion added rental/leasing, construction, financial, private healthcare, education, beauty, etc.; EV charging is not named. Supply of electricity to domestic consumers above a threshold is a taxable service, but a CPO's charging service is not clearly covered. Sales tax (goods) is not applicable to a service. | **Default: no service tax on MY charging sessions.** The engine supports it per org (`org_tax_registration` with `ev_charging_taxable=true`, rate 8 %) so it is one setting once confirmed. | PwC (above); [KPMG — expanded SST](https://kpmg.com/my/en/insights/2025/06/updates-to-the-expanded-sales-tax-and-service-tax.html); [BDO — service tax updates Oct 2025](https://www.bdo.my/en-gb/insights/tax/sales-and-service-tax-sst/malaysia%E2%80%99s-latest-service-tax-updates) | **[VERIFY]** with a Malaysian tax adviser / RMCD ruling |
| MY-3 | Price regulation of EV charging | **No price cap.** MITI has said charging rates are set by CPOs on commercial terms; per-kWh billing is the market norm (≈ RM 0.21–1.80/kWh). | `MY` regulatory profile has no ceilings; platform safety caps only (idle fee cap, plausibility). | [EVGuru — no EV charging price controls (citing MITI)](https://www.evguru.com.my/post/no-ev-charging-price-controls-in-malaysia-what-jmbs-property-managers-and-homeowners-should-do-rig-1) | Medium (secondary source) [VERIFY] |
| MY-4 | Licensing of CPOs / EVCS | Energy Commission (Suruhanjaya Tenaga) **Guidelines on EVCS (24 Feb 2025)**: activities under s.9(1) Electricity Supply Act 1990 need a licence; defines "CPO"; record-keeping duties; no pricing, payment or data-reporting rules. Public EV chargers have required EVCS registration since 2023. | Store licence/registration references (org + charge point `regulatory_ref`); no software enforcement this phase. | [Rajah & Tann — EC Guidelines on EVCS](https://www.rajahtannasia.com/wp-content/uploads/2025/04/Energy-Commission-Issues-Guidelines-on-Electric-Vehicle-Charging-System-EVCS.pdf); [SoyaCincau — EVCS licence by 31 Mar 2023](https://soyacincau.com/2022/12/18/malaysia-public-ev-chargers-require-evcs-licence-from-energy-commission-by-31-march-2023/) | Medium |
| MY-5 | e-Invoicing (LHDN MyInvois) | Phased: >RM100m from 1 Aug 2024, RM25–100m 1 Jan 2025, RM5–25m 1 Jul 2025, ≤RM5m 1 Jan 2026 (relaxation to 31 Dec 2027). Exemption threshold reported raised from RM1m to **RM3m** (from 1 Sep 2026). B2C sales may be covered by a **consolidated** e-invoice. | Interface + MY stub (monthly consolidated B2C export); live MyInvois submission out of scope this phase. | [ClearTax MY — MyInvois phases](https://www.cleartax.com/my/en/different-phases-implementation-timelines-einvoicing-malaysia) | Medium (secondary) **[VERIFY]** thresholds and consolidation deadline against the current LHDN guideline |
| MY-6 | Rounding | BNM's rounding to the nearest 5 sen applies to **over-the-counter (cash) payments**. PlugSure takes no cash. | MYR totals are exact to the sen; no 5-sen rounding. | [BNM — rounding mechanism for over-the-counter payments](https://www.bnm.gov.my/-/introduction-of-a-rounding-mechanism-for-over-the-counter-payments) | High (cash-only scope stated in the title; non-cash not mentioned) |
| MY-7 | Payment methods | Cards, **FPX** online banking, **DuitNow QR**, e-wallets **Touch 'n Go**, **GrabPay**, ShopeePay, **Boost**. | Phase 1 (Stripe): cards (hold), FPX, GrabPay. Phase 2: Xendit MY or Adyen for DuitNow QR / TNG / Boost. | [Xendit MY payment methods](https://www.xendit.co/en-my/products/all-payment-methods/); [Adyen payment methods](https://docs.adyen.com/payment-methods/) | High |
| SG-1 | GST | **9 %** since 1 Jan 2024; compulsory registration when taxable turnover exceeds **S$1 million**. | `SG_GST` engine, rate 900 bps, per-org registration. | [IRAS — GST rate change](https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/gst-rate-change/gst-rate-change-for-business/overview-of-gst-rate-change); [IRAS — do I need to register](https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/gst-registration-deregistration/do-i-need-to-register-for-gst) | High |
| SG-2 | Price display | "A GST-registered business must show **GST-inclusive** prices on all its price displays and advertisements" (only hotels / F&B with service charge exempt). | SG tariffs are entered and shown **tax-inclusive** (`tariff.prices_include_tax = true` by default for SG); OCPI still publishes excl. VAT + `vat`. | [IRAS — display GST-inclusive price](https://www.iras.gov.sg/news-events/newsroom/display-'gst-inclusive'-price) | High |
| SG-3 | GST e-invoicing | **InvoiceNow** requirement: from 1 Nov 2025 for newly incorporated companies registering voluntarily; from 1 Apr 2026 for all new voluntary registrants. | Interface slot only (`SG` adapter = none); flag for any operator that is a new voluntary registrant. | [GoBusiness — GST InvoiceNow requirement](https://www.gobusiness.gov.sg/news-and-updates/news/gst-invoicenow-requirement) | High for dates; scope for B2C **[VERIFY]** |
| SG-4 | Licensing (EV Charging Act 2022, LTA) | EVCA in force 8 Dec 2023; **EV charging operator licence** required to provide public charging (from 8 Dec 2024); every charger **registered** with LTA and must carry type-approval label and registration mark. Licence: S$1,500 application, S$15,000 fee, 3 years. | Store LTA licence no. (org) and charger registration mark (`charge_point.regulatory_ref`). | [LTA — commencement of EVCA](https://www.lta.gov.sg/content/ltagov/en/newsroom/2023/12/news-releases/commencement_of_EVCA22.html); [EVCA 2022](https://sso.agc.gov.sg/Act/EVCA2022); [LTA — Guidelines for the Licensing of EVCOs (as of 21 Nov 2025)](https://www.lta.gov.sg/content/dam/ltagov/industry_innovations/Technologies/Electric_Vehicles/PDF/Guidelines%20for%20the%20Licensing%20of%20EV%20Charging%20Operators.pdf) | High |
| SG-5 | Payment rules (licence conditions §2.4.10) | (ii) payment possible by **at least one of: Visa/Mastercard credit card, NETS, PayNow**; (iii) **no deposit** may be required — *temporary holds during charging*, advance payments via booking systems, monthly fees and gift cards are not "deposits"; (iv) a **guest option** that needs **no account, no membership fee and no personal details**. | SG guest flow: card hold (Visa/MC) without sign-in, phone or e-mail; PayNow as an alternative. Card hold must not collect an e-mail address (see WP3: Stripe Payment Element, not Stripe Checkout). | LTA EVCO Guidelines (above) | High. Whether a **PayNow pre-purchase with refund of the unused balance** counts as a deposit: **[VERIFY]** with LTA — default SG guest method is the card hold. |
| SG-6 | Data to LTA | Licensee must be **OCPI-compliant (2.2.1)** at application; **dynamic data every 5 minutes via OCPI** for public chargers (operator, location, EVSE id, price per unit excl. GST + GST %, price type ENERGY/FLAT/PARKING_TIME/TIME, status); **static data monthly** via the LTA template on OneMotoring by the 5th working day; retention 3 y static / 1 y dynamic; **≥ 90 % service uptime**; downtime event = 5 % of chargers out > 20 min. Open charger protocol: OCPP "or equivalent". | LTA is configured as an OCPI partner of kind `authority` receiving Locations + Tariffs (WP1); monthly static export + uptime report (WP2). | LTA EVCO Guidelines (above) | High; the exact LTA OCPI endpoint/handshake **[VERIFY]** with LTA onboarding |
| SG-7 | Payment methods / rounding | Cards, **PayNow / SGQR**, NETS, GrabPay. Amounts to the cent; GST computed per invoice and rounded to the cent. | Stripe: cards (hold), PayNow (QR, sale), GrabPay (redirect, sale). NETS out of scope (cards or PayNow satisfy SG-5). | Stripe PayNow (below) | High; IRAS rounding wording **[VERIFY]** |
| ID-1 | Indonesia | Keep current behaviour: PPN 12 % on DPP 11/12, PBJT-TL per kabupaten/kota (≤ 10 %), PLN formula ceilings, Kepmen ESDM 182.K/2023 fee caps, QRIS via Midtrans/Xendit/SNAP, e-Faktur/Coretax. | `ID_PPN_PBJT` engine and `ID` profile are the existing code moved behind the interfaces; golden tests prove identical results. | `docs/PLUGSURE-ARCHITECTURE.md` §7, §9, §17 | As before |

### 2.2 Currency minor units and rounding

| Currency | ISO 4217 exponent | **PlugSure storage exponent** | Rounding |
|---|---|---|---|
| IDR | 2 | **0** (whole rupiah) | Lines and taxes to the rupiah (`Math.round`, as today); optional total rounding unit `ROUNDING_UNIT_IDR` kept |
| MYR | 2 | 2 (sen) | To the sen; no 5-sen cash rounding (MY-6) |
| SGD | 2 | 2 (cents) | To the cent; GST per invoice |

IDR is stored in whole rupiah because (a) that is what every existing row holds, so no data rewrite (a `×100` UPDATE on `cdr`/`payment_intent` would take long locks and overflow the `INTEGER` columns above Rp 21.4 m), (b) Midtrans, Xendit and QRIS all take whole-rupiah integers, (c) OCPI and receipts express rupiah without decimals. The exponent is a property of PlugSure's unit table, documented as such; adapters convert to each provider's own unit (`toProviderAmount`). `INTEGER` columns hold up to 21,474,836.47 MYR/SGD — far above any session; aggregate columns are already `BIGINT`.

### 2.3 Acquirer comparison (MY + SG) and recommendation

| Capability | **Stripe** (MY + SG accounts) | Adyen | Xendit MY |
|---|---|---|---|
| Cards, **manual capture / holds** | Yes; online CIT auth valid **7 days** (Visa MIT ~5 days), partial capture releases the rest | Yes | Cards yes; hold/manual capture **not documented** for MY |
| Saved cards (off-session) | Yes (SetupIntents / `setup_future_usage`) | Yes | Yes (ID); MY [VERIFY] |
| PayNow (SG) | Yes — QR, sale only, **refunds yes (async, ≤ 90 days)**, QR valid 1 h, no disputes | Yes | Not offered for SG acquiring (SG not documented) |
| FPX (MY) | Yes — redirect, sale only, **no manual capture** | Yes | Yes |
| GrabPay (MY, SG) | Yes — redirect, sale only, refunds yes (async) | Yes | MY yes |
| DuitNow QR, Touch 'n Go, Boost | **No** | Yes | DuitNow QR + TNG yes |
| Webhooks, idempotency keys, refunds API | Yes (signed webhooks, `Idempotency-Key`) | Yes | Yes (adapter already exists for ID) |
| Onboarding for a pilot | Self-serve per country | Enterprise sales, volume minimums | Self-serve |

**Recommendation: Stripe for MY and SG in this phase.** One adapter covers both countries and every method the SG licence needs (Visa/MC + PayNow), gives the hold-then-capture card flow PlugSure's card tier and roaming guarantee depend on, and has the best-documented webhooks/refunds. Its gap is MY's QR/e-wallet long tail (DuitNow QR, TNG, Boost): add **Xendit MY** in phase 2 by generalising the existing `XenditProvider` (country/currency parameters) — not Adyen, unless volumes justify enterprise terms. **[VERIFY]** with Stripe: (1) that MCC 5552 (EV charging) is accepted for PayNow — Stripe's PayNow docs prohibit "Service Stations / Automated Fuel Dispensers"; (2) minimum charge and minimum partial capture amounts for MYR/SGD (believed MYR 2.00 / SGD 0.50).

Sources: [Stripe — payment method support table](https://docs.stripe.com/payments/payment-methods/payment-method-support), [Stripe — place a hold](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method), [Stripe — PayNow](https://docs.stripe.com/payments/paynow), [Stripe — FPX](https://docs.stripe.com/payments/fpx), [Stripe — GrabPay](https://docs.stripe.com/payments/grabpay), [Adyen — payment methods](https://docs.adyen.com/payment-methods/), [Xendit MY — payment methods](https://www.xendit.co/en-my/products/all-payment-methods/), [Xendit — SEA local QR methods](https://www.xendit.co/en-sg/blog/cross-border-payment-gateway-sea-local-qr-methods/).

### 2.4 OCPI 2.2.1 facts used

- **Credentials:** `roles` is a list of `CredentialsRole {role, business_details, party_id, country_code}`; "a platform can have the same role more than once, each with its own unique `party_id` and `country_code`"; every role needs a unique (`role`, `party_id`, `country_code`). "A party operating in multiple countries can always use the home country of the company for all connections." → one connection per partner carries all of an organisation's CPO parties. ([credentials](https://github.com/ocpi/ocpi/blob/2.2.1/credentials.asciidoc))
- **Tariff:** `currency` is ISO 4217 per tariff; `PriceComponent.price` is per unit **excl. VAT**, `vat` is the applicable VAT percentage (omitted = none). ([tariffs](https://github.com/ocpi/ocpi/blob/2.2.1/mod_tariffs.asciidoc))
- **Price:** `{excl_vat, incl_vat?}`; numbers are JSON numbers with **4 decimals** unless stated → amounts are in **major units** (`toMajor`). ([types](https://github.com/ocpi/ocpi/blob/2.2.1/types.asciidoc))
- **Location:** `country` is ISO 3166-1 **alpha-3** (`IDN`, `MYS`, `SGP`); `time_zone` is an IANA zone and required; Session/CDR carry `currency`. ([locations](https://github.com/ocpi/ocpi/blob/2.2.1/mod_locations.asciidoc))

### 2.5 Things not found / to close

| # | Question | Owner | Blocks |
|---|---|---|---|
| V1 | Is a public EV charging service a taxable service under Malaysian service tax (and at 6 % or 8 %)? | MY tax adviser | MY tax switched on (WP1 ships with it off) |
| V2 | Does a PayNow pre-purchase with refund count as a "deposit" under LTA §2.4.10(iii)? | LTA / SG counsel | Offering PayNow as SG *guest* method (card hold is default) |
| V3 | LTA OCPI feed endpoint, credentials handshake and whether LTA pulls or we push | LTA onboarding | Enabling the LTA partner |
| V4 | Stripe: MCC 5552 eligibility for PayNow; minimum capture amounts MYR/SGD | Stripe | WP3 go-live |
| V5 | MyInvois exemption threshold (RM1m vs RM3m) and consolidated B2C e-invoice deadline | MY tax adviser | MyInvois live integration (later phase) |
| V6 | Which PlugSure legal entity bills MY/SG operators for the SaaS fee, and the tax on that cross-border service (ID PPN on export of services, SG reverse charge, MY service tax on imported taxable services) | PlugSure finance / counsel | Commission statements for MY/SG orgs (WP2 issues them **without tax** until closed, clearly marked) |
| V7 | SG tax-invoice / simplified tax invoice requirements for charging receipts (GST registration no., wording) | SG tax adviser | SG receipts template wording |

---

## 3. Decisions

### D1. Where country and currency live

- **`site.country_code`** (`'ID' | 'MY' | 'SG'`, `NOT NULL DEFAULT 'ID'`) is the source of truth. The **currency is derived from the country** (`country.currency`), not stored on the site: one fewer column to keep consistent, and a site cannot change country once it has sessions (enforced in `updateSite`).
- **`organisation.home_country_code`** is the default for new sites, the charger-CA `C=`, the eMSP identity, the default console locale and reporting time zone (`organisation.timezone`).
- **One organisation may operate in several countries** (Charge+-style SG + MY). Tax registration is per (organisation, country) in `org_tax_registration`. Where the operator uses separate legal entities per country (the usual case), model them as **child organisations** under `parent_org_id` (already supported); the design does not require it.
- **Every money-bearing row carries its own `currency`**, frozen at creation (`charging_session.currency` at StartTransaction from the site; the CDR, payment intent, invoices copy it). Nothing re-derives a past row's currency from the site.
- **Cross-border driver** (e.g. an Indonesian driver at a Malaysian site): the session is priced, taxed and paid in the site's currency through the site organisation's acquirer for that country. The driver app shows the amount in that currency (optionally an *indicative* conversion is a later feature — **no FX in phase 1, not even for display**). IDR-only methods (QRIS, GoPay, OVO, …) are simply not offered at a MYR site. The card issuer does the conversion.
- **No driver wallet balances exist** (by design, architecture §9.3), so there is no "wallet currency" problem; loyalty points are per organisation and per currency (D2).

### D2. Money storage

- **Rename** every `*_idr` column to `*_minor` and the Indonesian tax columns to neutral names (`ppn` → `tax`, `dpp` → `tax_base`, `pbjt` → `local_tax`, harga jual → `taxable`). Keeping `total_idr` holding SGD cents would be a permanent trap for every SQL report, export and new engineer. Postgres renames are catalogue-only (instant), but they break the running code, so they ship in one migration together with the code (§6.3, one short maintenance window).
- **Add `currency TEXT NOT NULL DEFAULT 'IDR'`** to every money-bearing table, with a `NOT VALID` foreign key to `currency_unit(code)` validated in a later migration (no long lock). Constant defaults are instant in Postgres ≥ 11, so the backfill is free and every existing row is `'IDR'` with its value unchanged (exponent 0).
- **Rates stay decimal in major units** (`tariff_component.rate NUMERIC(14,4)`, `subscription_plan.member_rate`, OCPI prices): a per-kWh price like RM 0.4550 needs fractions of a sen. **Amounts are integers in minor units.** A line amount is `round(quantity × rate × 10^exponent)`.
- **Frozen JSON is never rewritten** (`cdr.lines`, `cdr.tariff_snapshot`, `fleet_invoice.data`, `commission_statement.data`, `payment_intent.raw_events`, `commercial_plan.plan`). New writes use `amountMinor`; readers go through `readMinor(obj, 'amount')`, which accepts `amountMinor ?? amountIdr`. Rows without `currency` in JSON take the row's `currency` column.
- **`src/domain/money.ts`** is the only place that knows exponents, rounding, provider units and formatting.
- **TS identifiers** are renamed mechanically by a codemod (`tools/codemods/idr-to-minor.mts`, §6.2), file by file, typechecked; behaviour changes come after, in separate commits.
- **API compatibility:** `/v1` JSON responses and webhook payloads get legacy aliases (`totalIdr`, `total_idr`, …) added by one serialiser hook whenever the amount's currency is IDR (or absent, which means IDR); request bodies accept legacy keys. Aliases are marked deprecated in OpenAPI and removed only in a future `/v2`.

### D3. Tax engine

- `services/tax/` exposes one interface, chosen per CDR by `site.country_code` + the organisation's registration in that country:

| Scheme | When | Arithmetic |
|---|---|---|
| `ID_PPN_PBJT` | site in ID | Exactly today's `computeTax`: PBJT on energy (config `PBJT_BASE`), PPN 12 % × DPP 11/12, PBJT inside PPN base (`PBJT_IN_PPN_BASE`), `ppnApplies=false` for non-PKP tariffs, optional `ROUNDING_UNIT_IDR`. Parameters stay in env/`config.tax` (moved under `config.tax.id`). |
| `MY_SST` | site in MY, org has `MY_SST` registration with `ev_charging_taxable=true` | `tax = round(base × 800 / 10000)` (rate from registration, default 800 bps); no local tax. Otherwise behaves as `NONE`. |
| `SG_GST` | site in SG, org has active `SG_GST` registration | 9 %. Prices tax-inclusive by default: `tax = round(gross × 900 / 10900)`, `net = gross − tax`. Exclusive tariffs: `tax = round(net × 900/10000)`. |
| `NONE` | not registered (MY default; SG below threshold) | `tax = 0`, `total = subtotal`. Receipts say "No tax charged" / "Not GST-registered". |

- Effective-dated rates live in `services/tax/rates.ts` (`{scheme, from, rateBps, …}`) so a future rate change is a code/config row, and the CDR always stores the rate it used.
- **Per-site override** `site.tax_overrides JSONB` (e.g. `{ "exempt": true, "reason": "..." }` for a private depot) is honoured by every engine.
- **Invoice line structure** (CDR, receipts, fleet invoice) is engine-agnostic: lines (net or gross per `prices_include_tax`) → `subtotal_minor` (net) → `local_tax_minor` → `tax_base_minor` → `tax_minor` → `rounding_minor` → `total_minor`, plus `tax_scheme`, `tax_rate_bps`, `local_tax_rate_bps` and `tax_detail JSONB` (engine extras: ID DPP fraction `11/12`, PBJT base; SG `inclusive: true`).
- **Display rule:** `country.displayPricesInclTax` — SG `true` (IRAS); MY `true` (consumer clarity; prices equal net while not taxed); ID `false` (current behaviour: prices excl. PPN with PPN shown). The driver app and tariff previews show the price the driver will actually pay per kWh in SG/MY.
- **Non-session supplies** (reservation fees, 30-day passes, fleet membership fees, PlugSure's commission) call `engine.computeFee({ amountMinor, inclusive })` instead of the current `PKP_TAX` in `services/benefits.ts`.
- **Invoice-level recomputation** (fleet invoices recompute DPP/PPN on the sum — Indonesian practice) is `engine.invoiceTotals(lines)`; SG/MY compute tax on the invoice sum the same way.
- **E-invoicing hooks:** `services/einvoice/index.ts` registry `{ ID: efaktur (existing XML export), MY: myinvois stub (consolidated monthly B2C summary export, `submit()` throws `NotImplemented`), SG: none }`.

### D4. Tariff regulation — regulatory profiles

`services/regulatory/` exposes `RegulatoryProfile` per country; `validateTariff` and the caps in `rateSession` call the profile of the tariff's country instead of `config.regulatory` directly.

| Hook | ID | MY | SG |
|---|---|---|---|
| `validateTariff(t, maxPowerW)` | PLN multiplier ranges, energy ceiling `base × N/Q`, service+admin fee ceiling per charging class (Kepmen 182.K/2023), unbounded/over-cap time fee | time-fee bound + platform idle cap only | same as MY |
| `applyCaps(lines, cls)` | service-fee cap line, idle cap line (existing) | idle cap line | idle cap line |
| `formulaEnergyRate(t)` | `plnEnergyRate` | `null` (formula rates refused) | `null` |
| `touWindows` | WBP 17:00–22:00 / LWBP (config) | none — only explicit time windows | none |
| `connectorMaySell(c)` | tera status (existing `connectorMaySellEnergy`) | always | always (LTA registration mark is informational this phase) |
| `siteFields` (console) | kabupaten/kota, SPKLU ID/scheme, SLO, PBJT, PLN tariff group, TR/TM | EVCS licence ref | LTA registration (per charger) |
| `idleFeeCapMinor` | `IDLE_FEE_CAP_IDR` (100,000) | `IDLE_FEE_CAP_MYR` default 3000 (RM 30) | `IDLE_FEE_CAP_SGD` default 3000 (S$ 30) |

Tariffs gain `country_code` (validated against the profile) and `prices_include_tax`. PLN fields (`pln_scheme`, `pln_base_rate`, `pln_multiplier`) stay, valid only for `ID` tariffs. Tariff assignment refuses a tariff whose currency differs from the site's.

### D5. Time zones

- `site.timezone` is validated per country: ID `Asia/Jakarta | Asia/Pontianak | Asia/Makassar | Asia/Jayapura` (WIB/WIB/WITA/WIT), MY `Asia/Kuala_Lumpur | Asia/Kuching` (MYT), SG `Asia/Singapore` (SGT). Default = the country's first zone.
- `organisation.timezone` (default from home country) replaces `ALERT_TIMEZONE`, `BILLING_TIMEZONE`, `COMPLIANCE_TZ` and the hardcoded `'Asia/Jakarta'` in dashboard SQL for per-organisation work; the env values remain the **platform** default (platform-wide statements, the platform operator's alerts).
- Every `tz = 'Asia/Jakarta'` default parameter in services is removed: callers must pass the site's (or the organisation's) zone; TypeScript makes it required.
- Labels from one function `tzLabel(tz)` in `domain/timezone.ts`: WIB, WITA, WIT, MYT, SGT, else the IANA name.
- Provider-specific Jakarta times (Midtrans / SNAP `+07:00`) stay inside those adapters — they are the provider's wire format, not a business rule.

### D6. Payments

- Acquirer routing becomes **per (organisation, country)**: `integration.country_code` (NULL = legacy row = `ID`), unique per (org, kind, country). `paymentsFor(orgId, country)`.
- Each provider declares `currencies()`; a payment in a currency the resolved provider does not support is refused (`PaymentsUnavailable`), never sent.
- **Stripe** adapter (WP3) for MY and SG. Midtrans/Xendit/SNAP stay IDR-only; their hardcoded `'ID'/'IDR'` become assertions.
- Channels are extended: `PAYNOW`, `FPX`, `GRABPAY` (and reserved `DUITNOW`, `TNG`, `BOOST`, `NETS` for phase 2). Capability per channel: `hold` (card only), `sale`, `qr` (PayNow), `redirect` (FPX, GrabPay).
- Payment modes map unchanged: card **hold** (preauth → capture ≤ authorised) is the default for MY/SG app drivers and SG guests; **pre-purchase** (fixed amount, energy allowance, refund of the unused part) for PayNow / FPX / GrabPay — the same machinery as QRIS, with per-currency presets and limits from the country profile.

### D7. Roaming (PlugSure as eMSP)

- **Open to all signed-in app drivers** (not guests: a roaming charge needs a driver identity for the receipt and any shortfall). Fleet cards keep today's postpaid fleet-invoice path.
- **Guarantee:** before sending `START_SESSION`, place a **card hold** in the **partner location's currency** (from the partner's OCPI tariff/location country) through the eMSP organisation's acquirer for that country. Hold amount: per-org setting per currency, defaults IDR 300,000 / MYR 100.00 / SGD 80.00. `authorization_reference` = the payment intent id. No acquirer for that currency → the location is listed but not startable ("Not available with your payment methods yet").
- **Settlement:** on an accepted partner CDR, capture `min(total_incl_vat, hold)` (`total_excl_vat` when `incl_vat` is absent, flagged). Shortfall → the existing unpaid-session machinery (`settles_intent_id`). CDR currency ≠ hold currency → no capture, release, alert `roaming.currency_mismatch` (no FX). Start refused/timeout → release at once. **No CDR within 4 days of authorisation** (Visa MIT window ≈ 4 d 18 h) → capture the last OCPI Session `total_cost` if present, else release and raise `roaming.hold_unsettled`.
- IDR registered drivers with a linked e-wallet may use **post-pay** (existing `postpayExposure` limits) instead of a card for IDR locations.
- **Tokens:** one virtual eMSP token per (eMSP org, app driver): `token.kind='app'`, `contract_id` from the org's home party, OCPI type `APP_USER`, whitelist `ALLOWED`; sent inside `START_SESSION` (no Tokens push needed). Real-time authorisation (`authorizeForCpo`) accepts `APP_USER` tokens only while an un-settled authorised roaming hold exists for that driver.
- **Spending limits per currency:** `token.spend_limit_minor` + `token.spend_limit_currency`. A card that has a limit is refused in any other currency (fail closed, clear message). Usage counts only sessions/CDRs in that currency.
- **CDR plausibility caps per currency** in the country/currency registry (major units per kWh): IDR 25,000; MYR 10.00; SGD 5.00. **Unknown currency → held** for review (today it skips the price check).
- **Non-IDR partner tariffs** are shown in their currency (today skipped); `totalIdr: null` for non-IDR CDRs becomes `{totalMinor, currency}`.

### D8. OCPI

- `ocpi_party` primary key becomes `(org_id, country_code)`; `is_home` marks the eMSP/home identity (one per org). Credentials `roles` list every CPO party of the org plus the eMSP role of the home party.
- Location/Tariff/Session/CDR are built with the **party of the site's country**; `country` = alpha-3 from the country table; `time_zone` = `site.timezone` (required; no default).
- Currency from the tariff / session / CDR; amounts via `toMajor()` (4 decimals max).
- Prices **excl. VAT** with `vat` = engine's percentage: ID 11 (effective PPN; PBJT-TL stays in alt text and in `excl_vat` per `OCPI_PBJT_IN_EXCL_VAT`), SG 9, MY 0/omitted unless taxed. Tax-inclusive tariffs publish `price = round4(rate / (1 + vat/100))`.
- `tariff_alt_text`: `en` always; `id` for ID; (`ms`, `zh` later).
- Server endpoints (`GET locations/tariffs/sessions/cdrs`) return objects of all the org's parties; when a hub sends `OCPI-to-country-code/OCPI-to-party-id`, filter to that party.
- **LTA**: partner `kind='authority'` (new) that receives Locations + Tariffs (+ status PATCHes) for SG sites only; dynamic data is our normal push; a 5-minute full-status heartbeat job for SG sites guarantees the LTA interval even without status changes.

### D9. Commission (PlugSure SaaS fee)

- `commercial_plan` gains `currency`; tier boundaries `upToMinor`, minimums and private-site fees are in that currency. Default plans per currency (`DEFAULT_PLANS.IDR` = today's; MYR/SGD values are a **commercial decision** — placeholders in code marked `TODO(commercial)`).
- GTV is summed **per currency**; a multi-country organisation gets **one statement per (org, owner, period, currency)**.
- MDR credit (`estimateQrisMdrIdr`) only for ID; MY/SG 0.
- Tax on the statement through the **platform billing entity per country** (`platform_billing_entity` setting: issuer name, tax id, tax scheme). Until V6 is closed, MY/SG statements are issued **without tax** and say so.

### D10. UI and i18n

- Formatting: `formatMoney(minor, currency, lang)` in `domain/money.ts` (server) and a byte-identical copy in `web/js/money.js` / driver-web inline: currency decides symbol (`Rp`, `RM`, `S$`) and decimals; the **language** decides separators (`id`: `Rp 12.345`, `RM 12,34`; `en`: `Rp 12,345`, `RM 12.34`, `S$ 12.34`).
- Languages this phase: **id** and **en**. Driver app default language: stored choice → device language → the brand's `default_locale` (new; MY/SG brands `en`). `ms`/`zh` later (the translation mechanism already supports adding a dictionary).
- Server-side driver messages stay Indonesian-source + client dictionary (existing `DICT`/`PATTERNS`); money tokens in patterns become currency-agnostic (`(?:Rp|RM|S\$) [\d.,]+`). A server-side message catalogue is out of scope.
- Console: organisation settings (home country, time zone, tax registrations, locale); site form with a country selector that switches currency, time zones and country-specific fields; tariff editor in the tariff's currency with "prices include GST" for SG.

### D11. Charger CA

Charger (leaf) certificates: `C=` the organisation's `home_country_code` (`charger-ca.ts:137`). The platform CA (`charger-ca.ts:62`) keeps `C=ID` (its issuer is the Indonesian platform entity); an existing CA is never re-issued.

### D12. Out of scope (this phase)

Hub role and inter-operator clearing/settlement; **any FX conversion** (money or display); driver wallets/balances; Malaysia DuitNow QR / Touch 'n Go / Boost and SG NETS (phase 2: Xendit MY / NETS acquirer); live MyInvois submission and SG InvoiceNow; server-side message catalogue and `ms`/`zh` translations; MY/SG compliance vaults beyond storing licence/registration references; Stripe Connect split payments / site-host payouts in MY/SG; currencies other than IDR/MYR/SGD; changing Indonesian behaviour.

---

## 4. Code survey (verified)

Counts on `master` @ 977d92c, `src/` + `tools/`: 61 `*_idr` columns in 19 tables; **91 files** reference a column being renamed; 55 non-test and 24 test `.ts` files contain `Idr`/`_idr` identifiers (top: `amountIdr` ×599, `totalIdr` ×303, `total_idr` ×196, `ppnIdr` ×188); 169 `fmt.idr` calls in 16 console views.

| Area | Location (verified) | Issue |
|---|---|---|
| Tax | `services/tax.ts:63-111` `computeTax`, `effectivePpnRateBps`; `config.ts:464-497` | One global Indonesian tax; whole-unit rounding |
| Non-session tax | `services/benefits.ts:549-555` `PKP_TAX`/`feeTax`; `fleet-billing.ts:35`, `fleet-credit.ts:29`, `commission.ts:194` (`TaxCfg` from `config.tax`) | Fees and invoices taxed with PPN only |
| Regulation | `services/tariff.ts:128-300` (`plnEnergyRate`, `validateMultiplier`, `serviceFeeCeiling`, `regulatedEnergyCeiling`, `validateTariff`), caps in `rateSession` ~820-880; `config.ts:505-536` | PLN/Kepmen always applied |
| Tariff currency | `tariff.ts:61` `currency: 'IDR'` type; `tariff-store.ts:35,108,179`; `web/js/views/tariffs.js:518` | Literal IDR |
| Rating | `tariff.ts:491` `rateSession` (tz default Jakarta), `energyLine` `amountIdr: Math.round(kwh*rate)` (1115); `sessions.ts:1004` `PRICING_SELECT`, 1050-1115 `priceSession`, 1248 CDR insert; `SETTLEMENT_TOLERANCE_IDR = 1_000` (1317) | Amount = rupiah; tolerance in rupiah |
| OCPI out | `ocpi/mapping.ts` `country: 'IDN'` (274, 525), `time_zone ?? 'Asia/Jakarta'` (278), `currency: 'IDR'` (388, 458, 535), `effectiveVatPercent` from `config.tax` (296), Rp alt text (380-382), amounts unconverted | |
| OCPI party | `ocpi/store.ts:19-31` `getParty(orgId)` (one per org, PK `org_id`); 20 call sites in `ocpi/*`, `api/roaming-routes.ts` | |
| eMSP | `ocpi/emsp.ts:113-127` `cardUsage`/`overLimit` IDR only; `CDR_MAX_PRICE_PER_KWH = {IDR: 25_000}` (317); `notifyCdr` IDR only (431); `api/roaming-routes.ts:324` IDR usage | |
| Driver roaming | `driver/roaming.ts:35-42` fleet-only eligibility; 95 non-IDR tariffs skipped; 247, 346 `totalIdr` null for non-IDR | |
| Fleet billing | `services/fleet-calc.ts:180` non-IDR roaming CDRs dropped; `fleet_invoice_live_uq (fleet_account_id, period)` | One invoice per month, IDR |
| Payments | `payments/xendit.ts:102,157,225,260,276,295,354,368,444` `country:'ID'`/`'IDR'`; `snap-qris.ts:118,167`; `midtrans.ts:256` `country_code:'62'`; `provider.ts` `Channel` (ID wallets), `QRIS_MAX_TRANSACTION_IDR`, `estimateQrisMdrIdr`; `registry.ts:58-95` one acquirer per org, `postpayLimitIdr` default 200,000, Indonesian error strings; `mock.ts:42` QR `5802ID` | |
| Integrations | `integration_scope_kind_live_uq (org, kind)`; `integrations/store.ts:80` `resolve(kind, orgId)`; `catalogue.ts:60` "(Rp)" | One per kind |
| Time zones | defaults `'Asia/Jakarta'` in `tariff.ts:354,421,484,492,947,987`, `sessions.ts:1084`, `benefits.ts:336`, `operator-limits.ts:62`, `v2x.ts:123`, `session-query.ts:278`, `firmware.ts:405`, `ocpi/mapping.ts:278`, `compliance.ts:44` (`COMPLIANCE_TZ`), `config.ts:348,363`, `driver/notify.ts:45`, `driver/membership.ts:460-461`, `api/console-routes.ts:405-416` (SQL), `web/js/core.js:75-77`, `web/js/views/tariffs.js:651`, `logs.js:115`, `sessions.js:27`; `ocmf.ts:194` offset 420; labels `alert-format.ts:101`; site validation `sites.ts:184` | |
| Site validation | `sites.ts:100-115` BPS code, 5-digit postal code, Indonesian lat/lon box; 132-133 Rp bounds for reservation fee / V2X credit; 141-170 PBJT/SPKLU | |
| Phones | `driver/identity.ts:225-239` `normalisePhone` (+62 only), `alert-format.ts:116-125`, `brand.ts:215`, `payments/registry.ts:332`, `driver/wallets.ts:41` | |
| Locale/format | `id-ID`/`Rp` in `session-query.ts:215`, `commission.ts:346`, `commission-calc.ts:236`, `fleet-pdf.ts:13`, `fleet-billing.ts:691-717`, `fleet-credit.ts:88-256`, `driver/notify.ts:42`, `refunds.ts:97`, `holds.ts:162-189`, `registry.ts:275,474-559`, `loyalty.ts:231`, `api/server.ts:1451`, `integration-routes.ts:226`; console `core.js:62` `fmt.idr`; driver-web `index.html:845-847` `rp()`, `PRESETS` in rupiah (1877, "ribu" 1952) | |
| CA | `charger-ca.ts:62, 137` `C=ID` | |
| Indonesia-only domain | `services/efaktur.ts`, `domain/spklu.ts`, `services/compliance.ts` (tera/SLO), `sites.ts` PLN groups / TR-TM cliff | Keep; gate by country |
| Events/webhooks | `services/events.ts:39,58-65` `totalIdr`, `amountIdr`, `capturedIdr`, `releasedIdr` | Public payloads |
| Constraints | CHECKs in rupiah: `site.reservation_fee_idr ≤ 100000`, `v2x_credit_idr_per_kwh ≤ 20000`, `loyalty_program` bounds | Generic sanity bounds; real bounds per currency in code |

---

## 5. Data model

### 5.1 New reference tables (platform-wide, no RLS, `SELECT` granted to `plugsure_app`)

```
currency_unit  code PK ('IDR'|'MYR'|'SGD'), exponent smallint, iso_exponent smallint, symbol text
country        code PK ('ID'|'MY'|'SG'), alpha3, name, currency → currency_unit,
               timezones text[] (first = default), phone_cc text, default_locale text,
               tax_engine text, regulatory_profile text, active boolean
```

Behavioural constants per country (presets, limits, caps) live in code (`domain/country.ts`), not in these tables; the tables exist for foreign keys and SQL reports.

### 5.2 New / changed columns (migration 059, additive)

| Table | Change |
|---|---|
| `organisation` | `home_country_code TEXT NOT NULL DEFAULT 'ID' → country`, `timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta'`, `default_locale TEXT NOT NULL DEFAULT 'id'`, `roaming_settings JSONB NOT NULL DEFAULT '{}'` (hold amounts per currency) |
| `org_tax_registration` (new, RLS) | `org_id, country_code, scheme ('ID_PKP'|'MY_SST'|'SG_GST'), registration_no, registered bool, ev_charging_taxable bool, rate_bps int NULL, effective_from date, effective_to date NULL, created_at`; backfill one `ID_PKP` row per org from `organisation.pkp/npwp` |
| `site` | `country_code TEXT NOT NULL DEFAULT 'ID' → country`, `tax_overrides JSONB NOT NULL DEFAULT '{}'` |
| `charge_point` | `regulatory_ref TEXT` (SG LTA registration mark, MY EVCS ref) |
| `tariff` | `country_code TEXT NOT NULL DEFAULT 'ID'`, `prices_include_tax BOOLEAN NOT NULL DEFAULT false` (existing `currency` gains FK) |
| `charging_session`, `cdr`, `payment_intent`, `driver_charge`, `driver_reservation`, `reservation_checkout`, `subscription_plan`, `subscription_charge`, `subscription_session`, `promotion`, `promotion_redemption`, `loyalty_program`, `loyalty_entry`, `fleet_invoice`, `fleet_credit_note`, `commission_statement`, `commercial_plan` | `currency TEXT NOT NULL DEFAULT 'IDR'` + FK `NOT VALID` |
| `cdr` | `tax_scheme TEXT NOT NULL DEFAULT 'ID_PPN_PBJT'`, `prices_include_tax BOOLEAN NOT NULL DEFAULT false`, `rounding_minor INTEGER NOT NULL DEFAULT 0`, `tax_detail JSONB NOT NULL DEFAULT '{}'` |
| `token` | `spend_limit_currency TEXT NOT NULL DEFAULT 'IDR'` |
| `integration` | `country_code TEXT` (NULL = ID); unique index → `(org, kind, COALESCE(country_code,'ID'))` |
| `ocpi_party` | `is_home BOOLEAN NOT NULL DEFAULT true`; PK → `(org_id, country_code)`; partial unique `(org_id) WHERE is_home` |
| `ocpi_partner` | kind CHECK adds `'authority'` |
| `driver_roaming_charge` | `app_driver_id UUID`, `payment_intent_id UUID`, `currency TEXT` |
| `payment_intent` | `roaming_charge_id UUID` (FK `driver_roaming_charge`) |
| `app_driver` | `locale TEXT` |
| `driver_app_brand` | `default_locale TEXT NOT NULL DEFAULT 'id'` |
| `fleet_invoice` | live unique index → `(fleet_account_id, period, currency) WHERE status <> 'void'` |
| `commission_statement` | unique index → `(org_id, COALESCE(owner_id,…), period, currency)` |

### 5.3 Column renames (migration 060)

| Table | Old → new |
|---|---|
| `cdr` | `subtotal_idr`→`subtotal_minor`, `pbjt_rate_bps`→`local_tax_rate_bps`, `pbjt_idr`→`local_tax_minor`, `ppn_dpp_idr`→`tax_base_minor`, `ppn_rate_bps`→`tax_rate_bps`, `ppn_idr`→`tax_minor`, `total_idr`→`total_minor` |
| `site` | `pbjt_rate_bps`→`local_tax_rate_bps`, `reservation_fee_idr`→`reservation_fee_minor`, `v2x_credit_idr_per_kwh`→`v2x_credit_minor_per_kwh` |
| `charging_session` | `prepaid_amount_idr`→`prepaid_amount_minor`, `v2x_credit_idr_per_kwh`→`v2x_credit_minor_per_kwh` |
| `payment_intent` | `amount_authorised_idr`→`amount_authorised_minor`, `amount_captured_idr`→`amount_captured_minor`, `settlement_delta_idr`→`settlement_delta_minor`, `refund_due_idr`→`refund_due_minor`, `refunded_idr`→`refunded_minor`, `hold_capture_idr`→`hold_capture_minor` |
| `driver_charge` | `amount_idr`→`amount_minor` |
| `driver_reservation`, `reservation_checkout` | `fee_idr`→`fee_minor`, `fee_dpp_idr`→`fee_tax_base_minor`, `fee_ppn_idr`→`fee_tax_minor`, `fee_total_idr`→`fee_total_minor` |
| `fleet_invoice` | `subtotal_idr`→`subtotal_minor`, `pbjt_idr`→`local_tax_minor`, `tax_base_idr`→`taxable_minor`, `dpp_idr`→`tax_base_minor`, `ppn_idr`→`tax_minor`, `own_total_idr`→`own_total_minor`, `roaming_total_idr`→`roaming_total_minor`, `total_idr`→`total_minor`, `fees_total_idr`→`fees_total_minor`, `credited_idr`→`credited_minor`, `prior_credit_idr`→`prior_credit_minor` |
| `fleet_credit_note` | `dpp_idr`→`tax_base_minor`, `ppn_idr`→`tax_minor`, `total_idr`→`total_minor` |
| `commission_statement` | `gtv_idr`→`gtv_minor`, `commission_idr`→`commission_minor`, `minimum_topup_idr`→`minimum_topup_minor`, `private_fee_idr`→`private_fee_minor`, `mdr_credit_idr`→`mdr_credit_minor`, `net_idr`→`net_minor`, `ppn_idr`→`tax_minor`, `total_idr`→`total_minor`, `owner_share_idr`→`owner_share_minor` |
| `subscription_plan` | `monthly_fee_idr`→`monthly_fee_minor`, `member_rate_idr`→`member_rate` (major units per kWh; type `NUMERIC(12,2)`→`NUMERIC(14,4)`, small table rewrite) |
| `subscription_charge` | `fee_idr`→`fee_minor`, `dpp_idr`→`tax_base_minor`, `ppn_idr`→`tax_minor`, `total_idr`→`total_minor`, `credit_idr`→`credit_minor` |
| `subscription_session`, `promotion_redemption` | `discount_idr`→`discount_minor` |
| `promotion` | `budget_idr`→`budget_minor` (`value` of an `amount_off` promotion = major units of `promotion.currency`) |
| `loyalty_program` | `earn_per_1000_idr`→`earn_per_1000_minor`, `point_value_idr`→`point_value_minor` |
| `loyalty_entry` | `value_idr`→`value_minor` |
| `token` | `spend_limit_idr`→`spend_limit_minor` |

That is all 61 `*_idr` columns plus `cdr.pbjt_rate_bps/ppn_rate_bps` and `site.pbjt_rate_bps`. Check constraints follow the columns automatically (renamed for hygiene); `payment_intent_refund_within_captured` keeps working. There are no views or functions referencing these columns (checked: `pg_views` empty, no `pg_proc` body mentions `idr`).

### 5.4 Migration SQL sketch

**`db/migrations/059_multi_country.sql`** — additive, safe while v1.6 runs (old code ignores new columns; every default is a constant so no table rewrite):

```sql
-- 059: countries, currencies, per-row currency (all additive; existing rows = Indonesia / IDR)
CREATE TABLE IF NOT EXISTS currency_unit (
  code TEXT PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  exponent SMALLINT NOT NULL CHECK (exponent BETWEEN 0 AND 3),     -- PlugSure storage unit
  iso_exponent SMALLINT NOT NULL,
  symbol TEXT NOT NULL
);
INSERT INTO currency_unit VALUES ('IDR',0,2,'Rp'),('MYR',2,2,'RM'),('SGD',2,2,'S$')
  ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS country (
  code TEXT PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$'),
  alpha3 TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  currency TEXT NOT NULL REFERENCES currency_unit(code),
  timezones TEXT[] NOT NULL, phone_cc TEXT NOT NULL, default_locale TEXT NOT NULL,
  tax_engine TEXT NOT NULL, regulatory_profile TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true
);
INSERT INTO country VALUES
  ('ID','IDN','Indonesia','IDR', ARRAY['Asia/Jakarta','Asia/Pontianak','Asia/Makassar','Asia/Jayapura'],'62','id','ID_PPN_PBJT','ID',true),
  ('MY','MYS','Malaysia','MYR',  ARRAY['Asia/Kuala_Lumpur','Asia/Kuching'],'60','en','MY_SST','MY',true),
  ('SG','SGP','Singapore','SGD', ARRAY['Asia/Singapore'],'65','en','SG_GST','SG',true)
ON CONFLICT (code) DO NOTHING;
GRANT SELECT ON currency_unit, country TO plugsure_app;

ALTER TABLE organisation
  ADD COLUMN IF NOT EXISTS home_country_code TEXT NOT NULL DEFAULT 'ID',
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta',
  ADD COLUMN IF NOT EXISTS default_locale TEXT NOT NULL DEFAULT 'id',
  ADD COLUMN IF NOT EXISTS roaming_settings JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE organisation ADD CONSTRAINT organisation_home_country_fk
  FOREIGN KEY (home_country_code) REFERENCES country(code) NOT VALID;

ALTER TABLE site
  ADD COLUMN IF NOT EXISTS country_code TEXT NOT NULL DEFAULT 'ID',
  ADD COLUMN IF NOT EXISTS tax_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE site ADD CONSTRAINT site_country_fk FOREIGN KEY (country_code) REFERENCES country(code) NOT VALID;
ALTER TABLE charge_point ADD COLUMN IF NOT EXISTS regulatory_ref TEXT;

ALTER TABLE tariff
  ADD COLUMN IF NOT EXISTS country_code TEXT NOT NULL DEFAULT 'ID',
  ADD COLUMN IF NOT EXISTS prices_include_tax BOOLEAN NOT NULL DEFAULT false;

-- currency on every money-bearing row
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['charging_session','cdr','payment_intent','driver_charge','driver_reservation',
    'reservation_checkout','subscription_plan','subscription_charge','subscription_session','promotion',
    'promotion_redemption','loyalty_program','loyalty_entry','fleet_invoice','fleet_credit_note',
    'commission_statement','commercial_plan']
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT %L', t, 'IDR');
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_currency_fk');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (currency) REFERENCES currency_unit(code) NOT VALID',
                   t, t || '_currency_fk');
  END LOOP;
END $$;
ALTER TABLE tariff ADD CONSTRAINT tariff_currency_fk FOREIGN KEY (currency) REFERENCES currency_unit(code) NOT VALID;

ALTER TABLE cdr
  ADD COLUMN IF NOT EXISTS tax_scheme TEXT NOT NULL DEFAULT 'ID_PPN_PBJT',
  ADD COLUMN IF NOT EXISTS prices_include_tax BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rounding_minor INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_detail JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE token ADD COLUMN IF NOT EXISTS spend_limit_currency TEXT NOT NULL DEFAULT 'IDR';
ALTER TABLE app_driver ADD COLUMN IF NOT EXISTS locale TEXT;
ALTER TABLE driver_app_brand ADD COLUMN IF NOT EXISTS default_locale TEXT NOT NULL DEFAULT 'id';

-- tax registrations
CREATE TABLE IF NOT EXISTS org_tax_registration (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organisation(id),
  country_code TEXT NOT NULL REFERENCES country(code),
  scheme TEXT NOT NULL CHECK (scheme IN ('ID_PKP','MY_SST','SG_GST')),
  registration_no TEXT, registered BOOLEAN NOT NULL DEFAULT true,
  ev_charging_taxable BOOLEAN NOT NULL DEFAULT true, rate_bps INTEGER CHECK (rate_bps BETWEEN 0 AND 3000),
  effective_from DATE NOT NULL, effective_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS org_tax_registration_open_uq
  ON org_tax_registration (org_id, country_code, scheme) WHERE effective_to IS NULL;
-- RLS exactly like every tenant table (copy the DO-block from 013)
INSERT INTO org_tax_registration (org_id, country_code, scheme, registration_no, registered, effective_from, created_by)
  SELECT id, 'ID', 'ID_PKP', npwp, COALESCE(pkp, false), DATE '2000-01-01', 'migration 059'
    FROM organisation o
   WHERE NOT EXISTS (SELECT 1 FROM org_tax_registration r WHERE r.org_id = o.id);

-- acquirers per country
ALTER TABLE integration ADD COLUMN IF NOT EXISTS country_code TEXT REFERENCES country(code);
DROP INDEX IF EXISTS integration_scope_kind_live_uq;
CREATE UNIQUE INDEX IF NOT EXISTS integration_scope_kind_country_live_uq
  ON integration (COALESCE(org_id,'00000000-0000-0000-0000-000000000000'::uuid), kind, COALESCE(country_code,'ID'))
  WHERE archived_at IS NULL;

-- OCPI: one party per (org, country)
ALTER TABLE ocpi_party ADD COLUMN IF NOT EXISTS is_home BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE ocpi_party DROP CONSTRAINT IF EXISTS ocpi_party_pkey;
ALTER TABLE ocpi_party ADD PRIMARY KEY (org_id, country_code);
CREATE UNIQUE INDEX IF NOT EXISTS ocpi_party_home_uq ON ocpi_party (org_id) WHERE is_home;
ALTER TABLE ocpi_partner DROP CONSTRAINT IF EXISTS ocpi_partner_kind_check;
ALTER TABLE ocpi_partner ADD CONSTRAINT ocpi_partner_kind_check CHECK (kind IN ('emsp','cpo','hub','authority'));

-- roaming guarantee
ALTER TABLE driver_roaming_charge
  ADD COLUMN IF NOT EXISTS app_driver_id UUID REFERENCES app_driver(id),
  ADD COLUMN IF NOT EXISTS payment_intent_id UUID REFERENCES payment_intent(id),
  ADD COLUMN IF NOT EXISTS currency TEXT;
ALTER TABLE payment_intent ADD COLUMN IF NOT EXISTS roaming_charge_id UUID REFERENCES driver_roaming_charge(id);

-- one live invoice / statement per account (org) and month AND currency
DROP INDEX IF EXISTS fleet_invoice_live_uq;
CREATE UNIQUE INDEX IF NOT EXISTS fleet_invoice_live_uq ON fleet_invoice (fleet_account_id, period, currency) WHERE status <> 'void';
DROP INDEX IF EXISTS commission_statement_period_uq;
CREATE UNIQUE INDEX IF NOT EXISTS commission_statement_period_uq
  ON commission_statement (org_id, COALESCE(owner_id,'00000000-0000-0000-0000-000000000000'::uuid), period, currency);
```

Notes: `ocpi_party`, `integration`, `fleet_invoice`, `commission_statement` are small (hundreds of rows), so their index rebuilds and PK swap are milliseconds. Before the PK swap, the plain `ADD COLUMN … REFERENCES` on `integration` validates a small table. The NOT VALID constraints are validated in 061 so that the ACCESS EXCLUSIVE lock of 059 is not held during a scan (each migration file is one transaction in `src/db/migrate.ts`).

**`db/migrations/060_money_minor_rename.sql`** — ships with the renamed code (maintenance window, §9):

```sql
-- 060: amounts are in the row's currency unit (currency_unit.exponent), not rupiah.
ALTER TABLE cdr RENAME COLUMN subtotal_idr TO subtotal_minor;
ALTER TABLE cdr RENAME COLUMN pbjt_rate_bps TO local_tax_rate_bps;
ALTER TABLE cdr RENAME COLUMN pbjt_idr TO local_tax_minor;
ALTER TABLE cdr RENAME COLUMN ppn_dpp_idr TO tax_base_minor;
ALTER TABLE cdr RENAME COLUMN ppn_rate_bps TO tax_rate_bps;
ALTER TABLE cdr RENAME COLUMN ppn_idr TO tax_minor;
ALTER TABLE cdr RENAME COLUMN total_idr TO total_minor;
-- … one RENAME COLUMN per row of the §5.3 table (generated by tools/codemods/idr-to-minor.mts --sql) …
ALTER TABLE subscription_plan RENAME COLUMN member_rate_idr TO member_rate;
ALTER TABLE subscription_plan ALTER COLUMN member_rate TYPE NUMERIC(14,4);
ALTER TABLE site RENAME CONSTRAINT site_reservation_fee_idr_check TO site_reservation_fee_minor_check;
-- … same for the other *_idr_check constraints listed in §4 …
COMMENT ON COLUMN cdr.total_minor IS 'Amount in cdr.currency, in currency_unit.exponent units (IDR: whole rupiah; MYR/SGD: sen/cents).';
```

A reverse script `db/rollback/060_down.sql` (same statements inverted) is kept with the release for the rollback path; it is not a numbered migration.

**`db/migrations/061_multi_country_validate.sql`**: `ALTER TABLE … VALIDATE CONSTRAINT …_currency_fk` for each table above, plus `site_country_fk`, `organisation_home_country_fk`, `tariff_currency_fk` (SHARE UPDATE EXCLUSIVE lock; reads and writes continue).

### 5.5 Invariants (enforced in code, covered by tests)

- `charging_session.currency = country(site.country_code).currency` at creation; never updated.
- `cdr.currency = charging_session.currency`; `payment_intent.currency` = its session's / roaming charge's currency; captures and refunds never cross currencies.
- A tariff assigned to a site/connector has `tariff.currency = site currency` and `tariff.country_code = site.country_code`.
- `site.country_code` cannot change once the site has a session (`updateSite` → 409).
- Sums (`money.sum`) assert one currency; mixed-currency aggregation is a thrown error, not a silent total.

---

## 6. Work packages

Implement **WP1 → WP2 → WP3** in order (WP3 before WP2 is also possible; WP2 only uses the provider interface and the mock provider in tests). Each WP ends green: `npm run typecheck`, `npm test` (982 + new), all e2e suites in the CI order, OpenAPI/SDK regenerated.

### 6.1 WP1 — Core (schema, money, country, tax, regulatory, rating, time zones, OCPI)

WP1 has three commits series: **1a** additive (shippable alone as v1.7.0-rc1, zero downtime), **1b** mechanical rename, **1c** behaviour.

#### WP1a — additive

| File | Change |
|---|---|
| `db/migrations/059_multi_country.sql`, `061_multi_country_validate.sql` | §5.4 |
| `src/domain/money.ts` (new) | `type CurrencyCode = 'IDR'|'MYR'|'SGD'`; `CURRENCIES` (exponent, isoExponent, symbol); `interface Money {currency; minor}`; `isCurrency(x)`; `toMinor(major: number|string, cur)` (decimal-string based, half-up); `toMajor(minor, cur)`; `amountForRate(qty, rateMajor, cur)` = `Math.round(qty * rate * 10**exp)` (same rounding as today's `energyLine`); `roundMinor(x)` = `Math.round`; `sum(list, cur)` (asserts currency); `formatMoney(minor, cur, lang: 'id'|'en', opts?)`; `toProviderAmount(minor, cur, unit: 'minor'|'major'|'whole')`; `readMinor(obj, base)` (legacy `${base}Idr` / `${base}_idr` fallback) |
| `src/domain/country.ts` (new) | `type CountryCode = 'ID'|'MY'|'SG'`; `COUNTRIES: Record<CountryCode, CountryProfile>` with `alpha3, currency, timezones, phoneCc, postalCodeRe (ID ^\d{5}$, MY ^\d{5}$, SG ^\d{6}$), latLonBox, defaultLocale, taxEngine, regulatoryProfile, displayPricesInclTax, prepaidPresetsMinor (ID [50k…500k], MY [1000,2000,3000,5000,10000], SG [1000,2000,3000,5000,8000]), maxPrepaidMinor (ID 10,000,000 = QRIS cap; MY 100000; SG 50000), settlementToleranceMinor (ID 1000; MY 20; SG 10), estimateStepMinor (ID 500; MY 10; SG 10), cdrMaxPricePerKwhMajor (25000 / 10 / 5), reservationFeeMaxMinor (100000 / 2000 / 2000), v2xCreditMaxMinorPerKwh (20000 / 500 / 500), roamingHoldDefaultMinor (300000 / 10000 / 8000), postpayLimitDefaultMinor (200000 / null / null)`; `countryOf(code)`, `currencyOfCountry(code)`; `assertCountry` |
| `src/domain/timezone.ts` (new) | `validTimezones(country)`, `defaultTimezone(country)`, `tzLabel(tz)`, `localParts(d, tz)` (moved from `alert-format.ts`), `utcOffsetMinutes(d, tz)` (for OCMF) |
| `src/config.ts` | `tax` → `tax.id` (same env vars); `regulatory` → `regulatory.id` + `regulatory.idleFeeCap{IDR,MYR,SGD}` (`IDLE_FEE_CAP_MYR`, `IDLE_FEE_CAP_SGD`); `features.multiCountry` (`MULTI_COUNTRY`, default false: MY/SG sites cannot be created until set) |
| `src/db/seed.ts` | seeds ID as today; with `SEED_MULTI_COUNTRY=1` adds a MY and an SG site with their tariffs |

Acceptance (1a): migrations apply twice idempotently on an empty DB and on a copy of the pilot DB; v1.6 code passes its e2e suites against the 059 schema (proves additivity); `money.ts`/`country.ts` unit tests.

#### WP1b — mechanical rename (no behaviour change)

| File | Change |
|---|---|
| `tools/codemods/idr-to-minor.mts` (new) | (1) `--sql`: emits the 060 RENAME statements from the §5.3 map; (2) rewrites SQL identifiers in string literals/template literals of `.ts/.mts/.js/.html` under `src/` and `tools/` using the exact column map (word-boundary, longest first: `ppn_dpp_idr`, `fee_dpp_idr`, `fee_ppn_idr`, `tax_base_idr` before `dpp_idr`, `ppn_idr`, …) and generic `\b([a-z0-9_]+)_idr\b → $1_minor` for SQL aliases (`revenue_idr`, …); (3) TS identifiers with the explicit map `ppnDppIdr→taxBaseMinor, dppIdr→taxBaseMinor, ppnIdr→taxMinor, pbjtIdr→localTaxMinor, pbjtRateBps→localTaxRateBps (not under config.tax), ppnRateBps→taxRateBps (cdr/receipt objects only; config.tax.id keeps ppnRateBps), taxBaseIdr→taxableMinor` then generic `\b([a-z][A-Za-z0-9]*)Idr\b → $1Minor`; excludes `estimateQrisMdrIdr`, `QRIS_MAX_TRANSACTION_IDR`, `ROUNDING_UNIT_IDR`, `IDLE_FEE_CAP_IDR`, env var names, `config.tax.*`, `config.regulatory.*`, and provider wire fields. Prints every changed file; must be re-runnable (idempotent). |
| `db/migrations/060_money_minor_rename.sql`, `db/rollback/060_down.sql` | generated, reviewed by hand |
| all 91 files listed by `grep -rlE '<61 columns>' src tools` (see §4) | codemod output + manual fixes until `tsc` is clean |
| `src/api/legacy-money.ts` (new) + `src/api/server.ts` hook | `addLegacyMoneyAliases(body)`: deep walk; currency context = nearest `currency` field up the tree, default `'IDR'`; for each key `xMinor`/`x_minor` with numeric value in an IDR context add `xIdr`/`x_idr` (and `localTaxMinor`→`pbjtIdr`, `taxMinor`→`ppnIdr`, `taxBaseMinor`→`dppIdr`/`ppnDppIdr`, `local_tax_minor`→`pbjt_idr`, … reverse map from the codemod). Registered as `onSend` for `application/json` on `/v1/*` and the driver API. `acceptLegacyMoneyKeys(body)` as `preValidation`: maps legacy input keys to the new ones, rejecting a body that has both with different values. Add header `Deprecation: true` + `Link: </docs/api#money>` when aliases were added. |
| `src/services/webhooks.ts` | apply `addLegacyMoneyAliases` before signing |
| `src/services/events.ts` | payload types renamed (`totalMinor`, `amountMinor`, `capturedMinor`, `releasedMinor`) + `currency` |
| `src/api/openapi/catalogue/*.ts` | schemas renamed; legacy fields documented as `deprecated: true`; `npm run openapi && npm run sdk` |

Acceptance (1b): `npm test` and every e2e suite pass with only key renames in assertions; **golden re-rate**: `tools/multicountry/rerate-compare.mts` re-prices every CDR of a pilot DB copy with the new code and compares `subtotal/local_tax/tax_base/tax/total` to the stored values — **zero differences**; a v1.6 SDK call (`sdk/typescript`) against the new API still reads `totalIdr`.

#### WP1c — behaviour

| File | Change |
|---|---|
| `src/services/tax/index.ts` (new; `services/tax.ts` becomes a re-export shim, then removed) | `interface TaxEngine { scheme; computeSession(i: SessionTaxInput): TaxResult; computeFee(i: FeeTaxInput): FeeTaxResult; invoiceTotals(i: InvoiceTaxInput): InvoiceTaxResult; ocpiVatPercent(ctx): number|null; labels(lang): TaxLabels }`; `resolveTaxContext(orgId, siteId, at): Promise<TaxContext>` (country, scheme, registration, rates in force at `at`, site overrides); `engineFor(ctx)` |
| `src/services/tax/id.ts` | today's `computeTax`, `clampBps`, `effectivePpnRateBps`, `PKP_TAX`, `dppOf/ppnOf` verbatim behind the interface (`computeFee` = `PKP_TAX`) |
| `src/services/tax/sg.ts`, `my.ts`, `none.ts`, `rates.ts` | §D3 arithmetic; `rates.ts`: `[{scheme:'SG_GST', from:'2024-01-01', rateBps:900}, {scheme:'MY_SST', from:'2024-03-01', rateBps:800}, {scheme:'ID_PPN_PBJT', from:'2025-01-01', ppnRateBps:1200, dpp:[11,12]}]` (ID values still overridable by env) |
| `src/services/regulatory/index.ts`, `id.ts`, `my.ts`, `sg.ts` (new) | `RegulatoryProfile` (§D4). `id.ts` receives `plnEnergyRate`, `validateMultiplier`, `serviceFeeCeiling`, `regulatedEnergyCeiling`, the PLN/Kepmen part of `validateTariff`, the service-fee cap in `rateSession`, `touBlockAt` WBP window, `connectorMaySellEnergy` |
| `src/services/tariff.ts` | `Tariff.currency: CurrencyCode`, `Tariff.countryCode`, `Tariff.pricesIncludeTax`; `validateTariff(t, maxPowerW)` = generic checks + `profile(t.countryCode).validateTariff`; `RatingContext` gains `currency`, `tax: TaxContext`, `timezone` **required**; `rateSession` uses `amountForRate`, `profile.applyCaps`, `engine.computeSession`; `TARIFF_CURRENCY_MISMATCH` violation when `tariff.currency !== ctx.currency`; `conservativeAllowanceWh/driverAllowanceWh/energyAllowanceWh` take `amountMinor` + currency and invert inclusive prices; `fmt` → `formatMoney(…, 'en')`; Jakarta defaults removed |
| `src/services/tariff-store.ts` | read/write `currency`, `country_code`, `prices_include_tax`; `loadTariffForConnector` returns the site currency and refuses a mismatched assignment; fallback tariff per country |
| `src/services/sessions.ts` | session insert sets `currency` from the site's country; `PRICING_SELECT` adds `si.country_code, cu.code AS currency`; `priceSession` builds `TaxContext` once; CDR insert writes `currency, tax_scheme, prices_include_tax, rounding_minor, tax_detail`; `SETTLEMENT_TOLERANCE_IDR` → `countryOf(..).settlementToleranceMinor`; messages via `formatMoney`; `cdr.created` event carries `currency` |
| `src/services/benefits.ts`, `loyalty.ts` | `feeTax` → `engine.computeFee`; promotions/plans/loyalty filtered to the session currency (`promotion.currency`, `subscription_plan.currency`, `loyalty_program.currency`); a benefit in another currency is ignored (logged) |
| `src/services/session-query.ts` | receipt/CSV: currency column, `formatMoney`, tax labels from `engine.labels(lang)`, site time zone |
| `src/services/sites.ts` | `SiteInput.countryCode`; `validateSite` per country (postal code, lat/lon box, time zones, ID-only fields refused for MY/SG, bounds from country profile); `createSite` defaults `country_code` = org home country and refuses non-ID while `features.multiCountry=false`; `updateSite` refuses a country change once sessions exist |
| `src/services/v2x.ts`, `operator-limits.ts`, `firmware.ts`, `compliance.ts`, `ocmf.ts`, `alert-format.ts`, `alert-routing.ts` | remove Jakarta defaults (site tz / org tz); `COMPLIANCE_TZ` → site tz; OCMF offset from `utcOffsetMinutes(d, site tz)`; `formatTime` uses `tzLabel` |
| `src/services/charger-ca.ts` | leaf subject `C=` org home country (line 137) |
| `src/services/live-activity.ts` | `ESTIMATE_STEP_IDR` → per-currency step |
| `src/services/payments/registry.ts`, `src/integrations/store.ts`, `src/integrations/catalogue.ts` | **routing only** (behaviour of providers unchanged): `resolve(kind, orgId, country = 'ID')`, `paymentsFor(orgId, country)`, `providerOfPayment` unchanged (uses `integration_id`); `startPayment` writes `payment_intent.currency`; `PaymentProvider.currencies?(): CurrencyCode[]` (default `['IDR']`) checked before any call |
| `src/ocpi/store.ts` | `getParties(orgId)`, `partyFor(orgId, countryCode)`, `homeParty(orgId)` (old `getParty` = `homeParty`, then call sites migrated); `setParty(orgId, p, {home})`; renderers pass the site's party and country |
| `src/ocpi/mapping.ts` | `buildLocation`: `country` = alpha-3, `time_zone` = `s.timezone` (required in `SiteIn`); `buildTariff`: `currency` = tariff currency, `vat` via engine, inclusive → excl. conversion, alt text per country; `priceOf`, `buildSession`, `buildCdr`: `toMajor`, currency from row; `effectiveVatPercent` moved to `tax/id.ts` |
| `src/ocpi/registration.ts`, `server.ts`, `push.ts`, `hubclients.ts`, `authorize.ts`, `commands.ts` | credentials `roles` = all parties; list endpoints across parties + `OCPI-to-*` filter; push uses `partyFor(site.country_code)`; `authority` partner kind (LTA): Locations/Tariffs push only, SG sites only, 5-minute status heartbeat job (`workers.ts` entry `ocpi-authority-heartbeat`) |
| `src/api/roaming-routes.ts` | identity endpoints per country (`GET/PUT /v1/roaming/identity/:country`; old `/v1/roaming/identity` = home party) |

Tests to add (WP1):
- `src/domain/money.test.ts`: `toMinor('0.455','MYR')=46`, `amountForRate(12.345, 0.955, 'MYR')=1179`, IDR exponent 0, `formatMoney` id/en for all three currencies, `sum` refuses mixed currencies, `readMinor` legacy keys.
- `src/services/tax/tax.test.ts`: ID golden cases copied from the current `tariff.test.ts` (unchanged numbers); SG inclusive `gross 1090 → tax 90, net 1000`; SG exclusive; SG non-registered; MY default none; MY registered + taxable 8 %; effective-date switch; site exemption override.
- `src/services/regulatory/regulatory.test.ts`: ID ceilings fire only for ID tariffs; MY/SG tariffs at RM 2/kWh pass; idle cap per currency.
- `src/services/tariff.test.ts` additions: MYR session rating (energy+idle) in sen; currency mismatch → violation; allowance inversion with inclusive SGD tariff.
- `src/services/sites.test.ts` (new): country validation matrix; time zone per country; country change refused after sessions.
- `src/ocpi/mapping.test.ts` additions: MY location (`MYS`, `Asia/Kuala_Lumpur`, MY party), SG tariff (`SGD`, `vat: 9`, excl. price from inclusive rate), CDR major units (`1234 sen → 12.34`), ID output byte-identical to before (snapshot).
- `src/ocpi/profiles.test.ts`/`trust.test.ts` additions: credentials with two CPO roles; hub filter by `OCPI-to-country-code`.
- `src/api/legacy-money.test.ts`: aliases added for IDR, not for MYR; legacy input accepted; conflicting input rejected.
- DB test: migrations 059–061 on a database seeded with v1.6 data keep every value; `org_tax_registration` backfill; `rls-fail-closed.test.ts` covers the new RLS table.
- e2e: new `tools/e2e/multi-country-e2e.mts` (`npm run e2e:multi-country`): SG and MY sites with simulated chargers, sessions rated in SGD/MYR, OCPI pull of locations/tariffs/CDRs for each party; added to CI.

Acceptance (WP1): golden re-rate zero diff for ID; a SG session of 20 kWh at S$0.65/kWh incl. GST yields `total_minor=1300, tax_minor=107, subtotal_minor=1193, currency='SGD', tax_scheme='SG_GST'`; a MY session at RM1.20/kWh, no registration, yields `tax_minor=0`; OCPI CDR for it has `currency:"MYR"`, `total_cost.excl_vat` in ringgit; no `'Asia/Jakarta'` literal left outside `domain/country.ts`, the Midtrans/SNAP adapters and tests (`grep` check in CI: `tools/check-country-literals.mts`).

### 6.2 WP2 — Apps (roaming for all drivers, eMSP currency handling, console, driver app, documents, i18n, commission, fleet billing)

| File | Change |
|---|---|
| `src/ocpi/emsp.ts` | `cardUsage(tokenId, currency)` sums only that currency (sessions via `cdr.currency`, remote CDRs via `currency`); `overLimit` uses `spend_limit_currency`, refuses other currencies when a limit exists; `CDR_MAX_PRICE_PER_KWH` from country registry, unknown currency → hold reason `unsupported currency`; `notifyCdr` passes `{totalMinor, currency}`; `cardToken`/APP_USER tokens; `authorizeForCpo` accepts `APP_USER` with an open roaming hold; on accepted CDR → `settleRoamingHold(cdr)` |
| `src/driver/roaming.ts` | eligibility: fleet card **or** signed-in app driver; stations list all currencies with `priceFrom: {minor, currency}` (major → minor via `toMinor`), `startable` + reason per station (acquirer for that currency? saved card or card checkout available?); `startRoaming` for app drivers calls `roaming-pay.ts` first and sends `START_SESSION` only after the hold is authorised; `roamingStatus/receipt/history` return `{totalMinor, currency}`; Indonesian strings unchanged (client translates) |
| `src/driver/roaming-pay.ts` (new) | `ensureRoamingToken(orgId, appDriverId)`; `placeRoamingHold(p, station, cardId|checkout)` → `payment_intent` (`mode='preauth'`, `roaming_charge_id`, `currency`); `settleRoamingHold(remoteCdr)` (capture/shortfall/mismatch rules in §D7); `releaseRoamingHold(chargeId, reason)`; `sweepRoamingHolds()` registered in `services/workers.ts` (every 15 min, `exclusive()` lock), the 4-day rule |
| `src/api/roaming-routes.ts` | usage per currency (`roaming_minor` + `currency`), held CDR accept path calls `settleRoamingHold`; org roaming settings (hold amounts per currency) |
| `src/services/fleet-calc.ts`, `fleet-billing.ts`, `fleet-credit.ts`, `fleet-pdf.ts`, `fleet-portal.ts` | statements and invoices **per currency** (one invoice per account, period and currency; roaming CDRs in other currencies go to that currency's invoice instead of being dropped); tax via `engine.invoiceTotals`; labels/formatting via engine + `formatMoney`; e-Faktur export only for `ID` invoices (`einvoice` registry); invoice number prefix unchanged |
| `src/services/einvoice/index.ts`, `myinvois.ts` (new) | registry; `myinvois.ts`: `consolidatedB2CExport(orgId, period)` → JSON summary (counts, totals, tax) + `submit()` throwing `NotImplemented` |
| `src/services/commission-calc.ts`, `commission.ts` | `Plan.currency`, `Tier.upToMinor`, `DEFAULT_PLANS` per currency; `computeStatement` per currency; `draftStatement/finalise/listFinalised/platformOverview` per currency; tax via the platform billing entity of the currency's country (none for MY/SG until V6, shown on the statement); MDR credit ID only |
| `src/services/payments/provider.ts` | `estimateQrisMdrIdr` unchanged but only called for ID |
| `src/services/refunds.ts`, `payments/holds.ts`, `payments/registry.ts` (messages only) | operator messages via `formatMoney(minor, currency, 'en')`; driver messages Indonesian with `formatMoney(…, 'id')` |
| `src/driver/charge.ts` | `quotePrepaid(connectorUuid, amountMinor)`: currency from the connector's site, limits/presets from the country profile (`maxPrepaidMinor` replaces `QRIS_MAX_TRANSACTION_IDR` for non-ID); `paymentSetupFor(orgId, country)`; responses include `currency`, `presetsMinor`, `pricesIncludeTax`; receipts with engine labels (`PPN`/`DPP` for ID, `GST 9%` for SG, `Service tax 8%` / none for MY) |
| `src/driver/notify.ts`, `membership.ts`, `reservations.ts`, `stations.ts`, `server.ts`, `identity.ts`, `wallets.ts` | money via `formatMoney` with the subscription's `lang`; times in the site tz; stations list price in site currency (inclusive in SG/MY); `normalisePhone(raw, defaultCountry)` accepting `+62`, `+60` (`^601\d{8,9}$`), `+65` (`^65[89]\d{7}$`); brand `default_locale` exposed |
| `src/services/alert-format.ts`, `alert-routing.ts`, `brand.ts` | WhatsApp/phone normalisation per org home country |
| `src/driver-web/index.html`, `paid.html`, `i18n.test.ts` | `rp()` → `money(minor, currency)`; `kwh` with `LANG` locale; presets from the server; "ribu" only for IDR; language default: stored → device → brand `default_locale`; `PATTERNS` money tokens generalised; SG guest flow without sign-in shown for card-hold / PayNow; roaming screens for app drivers (card choice, hold notice "S$80 is held and released after charging") |
| `src/web/js/core.js` + `src/web/js/money.js` (new) | `fmt.money(minor, currency)`; `fmt.idr` kept as `fmt.money(v,'IDR')` until all views move; `fmt.time/date` take the org tz from `/v1/auth/me` (`org.timezone`) |
| `src/web/js/views/*.js` (16 files with `fmt.idr`, plus `sites.js`, `tariffs.js`, `settings`/org view, `roaming.js`, `logs.js`, `sessions.js`, `firmware.js`, `rfid.js`) | currency-aware tables and forms; site form country selector (currency, tz options, ID-only fields hidden for MY/SG; `regulatory_ref` on chargers); tariff editor: currency from target sites, "Prices include GST" toggle (SG default on), PLN panel only for ID, preview in the tariff's currency; org settings: home country, time zone, locale, tax registrations (ID PKP/NPWP, MY SST no. + "EV charging taxable" switch with the [VERIFY] note, SG GST no.); roaming: identity per country, hold amounts per currency, LTA partner preset; spend limit with currency on cards |
| `src/api/console-routes.ts` | dashboard SQL uses `org.timezone` (lines 405-416), revenue per currency (no cross-currency totals: one figure per currency); org settings endpoints; `GET /v1/countries` (reference data for forms) |
| `src/api/server.ts`, `integration-routes.ts` | `formatMoney` in messages and the sandbox payment page |
| `src/services/uptime.ts` + `tools/lta/static-report.mts` (new) | SG monthly static data CSV in LTA's template columns (fields from the LTA guideline; template file to be obtained, V3) and the 90 % uptime figure per month |

Tests to add (WP2):
- `src/ocpi/emsp.test.ts`: per-currency usage and limits; card with IDR limit refused for MYR; MYR CDR above 10/kWh held; unknown currency held; APP_USER real-time auth only with an open hold.
- `src/driver/roaming-pay.test.ts` (new, DB): hold → START → CDR capture ≤ hold; CDR > hold → shortfall unpaid; currency mismatch → release + alert; start rejected → release; 4-day sweep with and without session `total_cost`; idempotent settlement on repeated CDR.
- `src/services/fleet-billing.test.ts`/`fleet-credit.test.ts`: account with IDR and MYR sessions → two invoices; MYR roaming CDR lands on MYR invoice; e-Faktur export ignores MYR invoice.
- `src/services/commission-calc.test.ts`: per-currency tiers; SG statement without tax marked.
- `src/driver-web/i18n.test.ts`: every message with `RM 12.34`/`S$ 12.34` translates; no Indonesian left in `en`.
- `src/driver/identity` test: MY/SG phone normalisation.
- e2e: extend `driver-e2e`, `ocpi-emsp-e2e`, `fleet-billing-e2e`, `console-e2e` (site in SG, tariff with GST, receipt), new `roaming-retail-e2e.mts` (mock CPO partner in MY, app driver hold → CDR → capture).

Acceptance (WP2): a signed-in driver with a saved MYR-acquirer card starts a session at a mock MY partner, the hold is authorised before `START_SESSION`, the CDR captures exactly the CDR total; the console shows MYR/SGD amounts with correct symbols and the SG org's times in SGT; an Indonesian org sees byte-identical screens and documents (visual diff of the e2e screenshots) except the "IDR" currency label where a column was added.

### 6.3 WP3 — Payments (Stripe adapter for MY and SG)

| File | Change |
|---|---|
| `src/services/payments/stripe.ts` (new) | `StripeProvider implements PaymentProvider` (+ `ProviderExtras`). Config: `secretKey`, `webhookSecret`, `country` ('MY'|'SG'), `baseUrl`. `currencies()` = MYR or SGD by account country. `channels()`: SG `CARD, PAYNOW, GRABPAY`; MY `CARD, FPX, GRABPAY`. **Card hold**: PaymentIntent `capture_method=manual`, `payment_method_types=[card]`, confirmed client-side with the Payment Element on PlugSure's page (no e-mail/phone collected — SG guest rule); `captureHold` → `POST /v1/payment_intents/:id/capture {amount_to_capture}`; `releaseHold` → `/cancel`; `chargeSavedCard` → PaymentIntent `customer`, `payment_method`, `off_session=true`, `confirm=true` (`capture_method` per `preauth`), `requires_action` → `pending` with the hosted 3DS URL; saved cards via `setup_future_usage=off_session` on a Customer created per app driver (`customerId` = PlugSure driver id in `metadata`). **PayNow** (`createQrisCharge`-equivalent `createQrCharge`): PaymentIntent `payment_method_types=[paynow]`, confirm with `payment_method_data[type]=paynow` → `next_action.paynow_display_qr_code.data` as `qrString`, `expires_at` (1 h). **FPX / GrabPay**: `createCheckout` → PaymentIntent confirmed with `return_url`, `next_action.redirect_to_url.url` as `checkoutUrl`. `refund` → `POST /v1/refunds {payment_intent, amount}` with `Idempotency-Key`; async results via `parseRefundEvent` (`refund.updated/failed`) and `refundStatus`. `verifyWebhook`: `Stripe-Signature` `t=…,v1=…`, HMAC-SHA256 over `${t}.${rawBody}`, constant-time compare, 300 s tolerance (`notificationFresh`). `parseNotification`: `payment_intent.succeeded` (paid, `amount_received`), `payment_intent.amount_capturable_updated` (authorised, `amount_capturable`), `payment_intent.payment_failed`, `payment_intent.canceled`, saved card from the PaymentMethod (`brand`, `last4`, `exp_*`). `testConnection` → `GET /v1/balance`. Every POST carries `Idempotency-Key`; amounts via `toProviderAmount(minor, cur, 'minor')`, currency lower-case. All calls through `providerFetch` (SSRF guard). `cardFeatures()` = `{holds: true, savedCards: true}`; `canRefund()` true for all its channels. |
| `src/services/payments/provider.ts` | `Channel` adds `'PAYNOW'|'FPX'|'GRABPAY'` (reserve `'DUITNOW'|'TNG'|'BOOST'|'NETS'`); `CHANNEL_LABEL`; `methodOf` (PAYNOW → 'qr'); amounts renamed `amountMinor` + `currency` on every args/result type; `createQrCharge` (QRIS keeps `createQrisCharge` as an alias in its adapters) |
| `src/services/payments/registry.ts` | `providerFor` case `'stripe'`; `availableMethods(r, provider, currency)`; per-currency `postpayOptions` (off for MYR/SGD); `handleNotification` checks `payment_intent.currency` = notification currency (mismatch → `payment.amount_mismatch` path); Indonesian guidance strings only for IDR channels |
| `src/services/payments/xendit.ts`, `midtrans.ts`, `snap-qris.ts`, `mock.ts` | `currencies() = ['IDR']`; hardcoded `country:'ID'`/`'IDR'` become `assertIdr(a.currency)`; `mock.ts` supports all three currencies (QR string with the right country tag `5802MY/SG`) |
| `src/services/payments/holds.ts`, `prepaid.ts`, `cards.ts` | currency through capture/release/settlement; `listCards` already scoped by acquirer → per-country Stripe account naturally separates MY and SG cards |
| `src/integrations/catalogue.ts` | provider `stripe` (fields: secret key, webhook signing secret, country MY/SG, methods multi-select, roaming hold amount); `postpayLimitIdr` field → `postpayLimitMinor` (legacy key read) |
| `src/api/integration-routes.ts` | Stripe test-connection; the per-integration webhook URL `/pay/notify/<key>` is what the operator registers in the Stripe dashboard |
| `src/driver-web/pay-stripe.html` (new) + `src/api/csp.ts` | Stripe Payment Element page for card holds and saved cards; CSP adds `script-src https://js.stripe.com`, `frame-src https://js.stripe.com https://hooks.stripe.com`, `connect-src https://api.stripe.com` **only on that page** |

Tests to add (WP3):
- `src/services/payments/stripe.test.ts`: request bodies (amount minor, currency, capture_method, idempotency keys) against a local fake Stripe (like the mock Entra in v1.6); webhook signature valid/invalid/stale; each event mapped; partial capture; cancel; refunds sync/async; PayNow QR parsing; 3DS `requires_action`.
- `adapters-idempotency.test.ts`: Stripe joins the matrix.
- `payments-fixes.test.ts`: under-amount notification in SGD → same handling as IDR.
- e2e: `npm run e2e:stripe` with the fake Stripe: SG guest card hold → charge → capture of the session total; SG PayNow pre-purchase → allowance → refund of unused; MY FPX pre-purchase; MY saved-card off-session charge.

Acceptance (WP3): with Stripe test keys (manual run, documented in `deploy/STRIPE.md`): SG test card hold of S$30 captured at S$12.34 with the rest released; PayNow test payment confirmed by webhook; MY FPX test bank succeeds; a refund of a PayNow payment reaches `refunded` via `refund.updated`. Indonesian acquirers unchanged (existing e2e: payment-methods, card-holds, linked-wallets, postpay green).

---

## 7. Implementation notes and conventions

- **Never** compute with a currency implicitly: functions that take an amount take `{minor, currency}` or a `currency` argument next to it. Lint rule (cheap grep in CI `tools/check-country-literals.mts`): no `'IDR'`, `'Asia/Jakarta'`, `'id-ID'`, `'Rp '`, `+62` literals outside `domain/`, ID-specific modules (`tax/id.ts`, `regulatory/id.ts`, `efaktur.ts`, `spklu.ts`, Midtrans/Xendit/SNAP adapters) and tests.
- Rounding stays `Math.round` (half toward +∞) per line and per tax, exactly as today, so Indonesian results are unchanged; SG/MY use the same.
- Statements and receipts never add amounts of different currencies; a multi-currency view shows one row/figure per currency.
- Audit log entries for tariff/site/registration changes include `currency`/`country_code` in `before/after`.
- Driver API and console API return `currency` next to every amount (or once at the object level when all amounts share it).

---

## 8. Risks for the live Indonesian pilot

| Risk | Mitigation |
|---|---|
| Rename (060) breaks the running v1.6 code between migrate and restart | 060 ships only with the renamed code, applied in a maintenance window with both processes stopped (§9); chargers queue transactions offline and replay (architecture §6.6) |
| Silent arithmetic drift in Indonesian invoices | Golden re-rate of every pilot CDR (zero diff) in CI on a sanitised pilot snapshot and again on production before restart; ID tax engine is a move, not a rewrite |
| External API consumers / webhooks break | Legacy alias layer for IDR, deprecation headers, SDK regenerated with both names; announce in release notes |
| Frozen documents (invoices, statements, CDR lines) unreadable after rename | `readMinor` legacy fallback; e2e renders a v1.6-issued invoice/statement after upgrade |
| OCPI partners see a changed party set | Home party unchanged (`is_home`), `country_code`/`party_id` unchanged for existing ID objects; only new parties appear; contract ids unchanged |
| `ocpi_party` PK swap / index rebuilds lock | Tables are tiny; `MIGRATION_LOCK_TIMEOUT` (10 s) fails fast if a long transaction holds them |
| Codemod over-renames (provider wire fields, env names) | Explicit exclusion list; typecheck; adapter request-body unit tests (`adapters-idempotency.test.ts`) assert unchanged wire payloads |
| MY tax misapplied | MY engine off by default; switching it on requires an explicit org registration with "EV charging taxable", audited |
| SG compliance (guest option, GST display) | SG sites refuse publishing a tariff that is not tax-inclusive when the org is GST-registered (warning otherwise); SG guest flow tested without sign-in |
| Stripe PayNow MCC exclusion | PayNow behind its own method switch; card holds satisfy LTA §2.4.10(ii) alone |

---

## 9. Rollout / upgrade steps

1. **v1.7.0-rc1 (WP1a)**: `npm ci`, `npm run migrate` (059, 061). Zero downtime: additive only, v1.6 behaviour unchanged. Baseline the golden re-rate on a **copy** of production: restore the latest dump into a scratch database (re-apply the `app.rls_bypass` role default, `deploy/pitr/RESTORE.md` §2a), migrate the copy to 060 and run `tools/multicountry/rerate-compare.mts` against it. The tool has no `--dry` flag and needs none: it only reads, and it reads the 060 column names, so it cannot run against a 059 database (production before the window).
2. **v1.7.0 (WP1b + WP1c)** — maintenance window, low-traffic hour (≈ 02:00 WIB), expected 2–5 min:
   1. Announce; take a base backup / note the PITR point (`deploy/pitr/RESTORE.md`).
   2. Stop API and gateway (`systemctl stop plugsure-api plugsure-gateway`). Chargers keep charging on local auth and queue messages.
   3. `npm ci && npm run migrate`: 060, then the additive 061–063 and 070 in the same run (the migrator has no stop point; and 059 first when rc1 was skipped). All of them took under 0.2 s each on the pilot rehearsal copy (RELEASE-NOTES-v1.7.0.md, Upgrade).
   4. `tsx tools/multicountry/rerate-compare.mts` against production: must report zero differences; otherwise roll back (step 6).
   5. Start gateway, then API. Watch: charger reconnects, offline queue replay, `/v1/platform/health`, first CDRs, payment notifications.
   6. Rollback path: stop processes, `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/060_down.sql` (as the migration owner), redeploy v1.7.0-rc1 (or v1.6), start gateway then API. The script deletes its own `schema_migration` row (no separate `DELETE`), refuses to run if any row is in a currency other than IDR or an organisation has more than one OCPI party, and leaves the additive migrations (059, 061–063, 070) in place. Re-running `npm run migrate` later re-applies 060 alone.
3. **v1.7.x (WP2, WP3)**: no further renames; additive migrations only. `MULTI_COUNTRY=false` keeps MY/SG site creation off.
4. **MY/SG pilot**: create the operator org (home country MY or SG), tax registrations, Stripe integration per country (test keys first), OCPI identity per country, LTA partner (SG, after V3); set `MULTI_COUNTRY=true`; commission plan in MYR/SGD (commercial). Run the SG/MY e2e against staging with Stripe test mode; then production with one site per country.
5. Close V1–V7 before enabling: MY service tax (V1), SG PayNow guest (V2), LTA feed (V3), Stripe PayNow (V4), MY/SG commission tax (V6).

---

## 10. Implementation notes (WP1, branch `multi-country`)

WP1 (a, b, c) is implemented as designed except where listed below. Indonesian results are unchanged: 371 v1.6 golden rating/tax cases (`src/services/tax/golden-id.fixture.json`, generated by `tools/multicountry/golden-gen.mts` from v1.6 code) replay byte-identically, and so do all 13 CI e2e suites.

### 10.1 Deviations from the design

- **Index / PK swaps moved from 059 to 060.** The v1.6 code uses `integration (kind, org_id) WHERE live`, `commission_statement (org_id, period)` and `ocpi_party PK (org_id)` as `ON CONFLICT` arbiters. Changing them in 059 would break v1.6 running on rc1. 060 therefore carries `integration_scope_kind_country_live_uq`, `commission_statement_period_uq` (+ currency), `ocpi_party PK (org_id, country_code)` and the partial unique `ocpi_party_home_uq (org_id) WHERE is_home`. `fleet_invoice_live_uq` (+ currency) stays in 059 because v1.6 has no arbiter on it.
- **RLS on `org_tax_registration`** uses the 048 fail-closed shape, `app_rls_bypass() OR org_id = app_current_org()`, not the sketch in §5.4. The startup policy check rejects anything else.
- **Renames.** `taxIdr` → `taxTotalMinor`, not `taxMinor`, because `taxMinor` collides with `ppnIdr` → `taxMinor`. `pbjtRateBps` → `localTaxRateBps`. The `member_rate` column is `NUMERIC(14,4)`, so its scale differs while its value does not. These names are left as they are because they are Indonesian-only: `ppnRateBps` on ID receipts and in config; `config.tax.id.*` and `config.regulatory.id.*`, with `estimateQrisMdrIdr`, `roundingUnitIdr`, `idleFeeCapIdr` and `serviceFeeCeilingIdr`; `postpayLimitIdr`; and the iOS Live Activity wire keys `costIdr` / `estimateIdr` (app contract; the currency travels next to them when it is not IDR). The codemod (`tools/codemods/idr-to-minor.mts`) lists all of these exclusions.
- **Legacy aliases.** These are Fastify `preValidation`/`preSerialization` hooks on `/v1/` and `/d/` (`src/api/legacy-money.ts`), plus the webhook envelope. Responses carry `Deprecation` and `Link` headers. A request that sends both the old and the new key with different values gets 400. Frozen JSON (CDR lines, invoice/credit-note documents, commission plans, OCPI cache) is **not rewritten**; it is read through `upgradeLegacyKeys`. 68 documents re-rendered byte-identically on the migrated data (§10.3).
- **Rating fails closed.** A non-ID tariff without a tax context throws. A MY/SG site with no tariff of its own country falls back to `defaultTariff(country)`, which has no price, so rating flags `RATE_MISSING` (a violation) and the session is parked for review rather than charged at the Indonesian default. Tariff snapshots get `countryCode` / `pricesIncludeTax` only when they differ from the default, so ID snapshots stay byte-identical.
- **Compliance time zone.** `COMPLIANCE_TZ = defaultTimezone('ID')` (WIB) stays for the Indonesian certificates (tera/SLO). The sweep covers ID sites only, and connectors outside Indonesia show `exempt`.
- **OCPI API path.** It is `GET /v1/roaming/parties`, `PUT|DELETE /v1/roaming/parties/:country` instead of `/identity/:country`. `ocpi_partner.kind = 'authority'` registers with role `NAP`; LTA's real role and module set is still **[VERIFY V3]**. The authority heartbeat worker (`ocpi-authority-heartbeat`, every 5 min) and pushes go to SGP authorities only.
- **Payments.** `mock` accepts IDR, MYR and SGD; the real adapters declare `currencies()`. Stripe is WP3.
- **Literal check is a ratchet.** `tools/check-country-literals.mts` and `tools/country-literals-baseline.json` record 38 files / 177 literals still to clear (console JS and driver-web Jakarta and `Rp ` literals, Indonesian messages, IDR-only payment paths). Counts may only go down. A unit test enforces this.
- **Left for WP2 / WP3**, with the helpers already in place:
  - reservation, membership and pass fee paths and their receipt labels (still IDR / ID engine);
  - fleet billing and commission per currency (statements and invoices are IDR-only; `fleet_invoice_live_uq` and `commission_statement_period_uq` already include currency);
  - eMSP spend limits and CDR plausibility caps per currency (`token.spend_limit_currency` and `cdrMaxPricePerKwh(currency)` exist; the checks are not wired);
  - console/driver UI formatting (`formatMoney` / `moneyText`);
  - Stripe.
- **Rollback script.** `db/rollback/060_down.sql` deletes its own `schema_migration` row. It refuses to run if any row has a non-IDR currency or an organisation has more than one OCPI party. 059/061 stay, because they are additive. §9 step 2.6 does not need the separate `DELETE`. `rerate-compare.mts` has no `--dry` flag; it is read-only already.

### 10.2 Hooks for WP2 / WP3

- **Money:** `domain/money.ts`: `toMinor`/`toMajor`, `formatMoney`, `moneyText(amount, cur, 'id'|'en'|'plain'|'rate')`, `toProviderAmount`/`fromProviderAmount`, `readMinor`, `upgradeLegacyKeys`.
- **Countries and time zones:** `domain/country.ts` provides `COUNTRIES` (presets, caps, tolerances), `countryOf`, `currencyOfCountry`, `cdrMaxPricePerKwh`. `domain/timezone.ts` provides `tzLabel`, `localParts`, `utcOffsetMinutes`.
- **Tax:** `services/tax/index.ts`: `taxContextForSite(siteId)`, `resolveTaxContext`, `engineFor(ctx)` with `.computeSession`, `.computeFee`, `.invoiceTotals`, `.labels`.
- **Regulatory profiles:** `services/regulatory/index.ts`: `profileFor(country)`.
- **Payments:** `paymentsFor(org, country)`, `startPayment({…, currency})`, `currenciesOf(provider)`, `assertCurrency`. `integration.country_code` scopes each integration.
- **Events:** `cdr.created`, `refund.*` and `payment.hold_*` carry `currency`.
- **Console:** `/v1/auth/me` returns `org.homeCountry`, `org.timezone`, `org.defaultLocale` and `features.multiCountry`. The dashboard uses `organisation.timezone`.
- **Roaming (WP2):** `organisation.roaming_settings`, `driver_roaming_charge` (`app_driver_id`, `payment_intent_id`, `currency`), `payment_intent.roaming_charge_id`.
- **Seed and tests:** `SEED_MULTI_COUNTRY=1` seeds MY/SG sites, tariffs and an SG GST registration. `npm run e2e:multi-country` runs 32 checks (SG GST-inclusive charge, OCPI per-party filtering, MYR/SGD tariffs and CDRs, a 409 on changing a site's country, legacy aliases).

### 10.3 Migration rehearsal (pilot_rehearsal, PostgreSQL on :5434)

1. **Data.** Master (977d92c) was migrated, seeded, and run through the e2e suites. Result: 50 sessions, 46 CDRs, 90 payment intents, 6 fleet invoices (with credit notes), 10 subscription charges. It was dumped and restored for each step.
2. **059 + 061 (rc1).** All 71 money sums and JSON digests were unchanged. The v1.6 code passed card-holds, pricing, fleet-billing, reservation-fees, pilot-fixes and isolation on the 059 schema, which shows 059 is additive. 059 took ≈55 ms and 061 ≈78 ms.
3. **060.** It took ≈52–99 ms; `npm run migrate` wall time is under 1 s including node startup. Every value is unchanged under its new name and every currency is `IDR`. All 23 FKs are valid, no `*_idr` column remains, the `ID_PKP` registration backfill produced 3 rows, and a second run is a no-op. `rerate-compare` reported 0 differences (46 CDRs at this step; 75 after the further runs, 59 of them fully re-rated, 16 with discounts tax-checked only). 68 frozen documents (invoice HTML/CSV/PDF, credit-note PDFs, receipts) rendered byte-identically with v1.6 code before the migration and v1.7 code after it. Old-name API reads return the aliases and the `Deprecation` header.
4. **v1.7 on the migrated data.** pilot-fixes 28, card-holds 39, pricing 25, fleet-billing 54, reservation-fees 14 and isolation 46 all pass. **Finding:** `pg_restore` does not restore `ALTER ROLE plugsure_app IN DATABASE … SET app.rls_bypass` (set by 048), so a restored copy fails RLS until it is re-applied. This matters for restore and PITR drills, not for the in-place upgrade.
5. **Rollback.** `060_down.sql` took 116 ms. All money sums matched the pre-rollback state (member_rate 6000.0000 → 6000.00, numerically equal). The ocpi_party PK returned to `(org_id)`. v1.6 code then passed pilot-fixes, pricing, fleet-billing, reservation-fees and isolation. Re-applying 060 took ≈52 ms, sums were unchanged, and the PK was `(org_id, country_code)` again.

---

## 11. Implementation notes (WP3, branch `multi-country`)

WP3 is implemented as designed in §6.3, except where listed below. Operator guide: `deploy/STRIPE.md`.

### 11.1 What was built

- **`services/payments/stripe.ts`** — `StripeProvider` over Stripe's REST API through `providerFetch` (no SDK; form-encoded,
  `Stripe-Version: 2026-09-30.endive` pinned and overridable per integration, an `Idempotency-Key` on every POST).
  One integration = one Stripe account = one country (`integration.country_code` MY or SG) = one currency.
- **Method → mode.** CARD → `preauth` (manual capture; holds on) or `prepurchase` (sale); saved card → the same, confirmed
  server-side; PAYNOW → `prepurchase` (QR, `method = 'qr'`); FPX → `prepurchase` (`method = 'bank'`); GRABPAY →
  `prepurchase` (`method = 'ewallet'`). No `postpay` (Stripe has no linked e-wallets here). Unused pre-purchase balance
  is refunded through the existing refund queue and Stripe's Refunds API.
- **Registry.** `providerFor('stripe')`; `availableMethods(r, provider, currency)` filters channels by currency
  (`CHANNEL_CURRENCIES`), so the sandbox in Indonesia offers exactly the v1.6 list; `startPayment` refuses amounts
  outside the acquirer's `amountLimits` (Stripe minimum S$0.50 / RM 2.00, FPX RM 2–30,000) before anything is recorded
  at the acquirer, passes `currency` to the adapter (non-IDR only, so Indonesian requests are byte-identical), and
  handles `action: 'qr'` from `createCheckout`. `handleNotification` gained three generic hooks (`ProviderExtras`):
  `eventId` (de-duplication), `parseOtherEvent` (verified but unused events answered 2xx) and `savedCardDetails`.
  `applyNotification` refuses a notification whose currency differs from the payment's (`currency_mismatch`), and the
  underpayment messages use `moneyText` (IDR text unchanged).
- **Integrations.** Catalogue entry `stripe` (publishable key, secret/restricted key, webhook signing secret(s),
  methods, holds, saved cards, `allowTestMode`, `apiVersion`, `baseUrl`). `PUT/DELETE/POST …/test /v1/integrations/payments`
  take `countryCode`; `GET /v1/integrations` adds `paymentsByCountry`. Saving validates country, methods per country,
  key prefixes and modes, and refuses test keys in production unless `allowTestMode`. `Resolved.countryCode` added.
- **Driver checkout** (`driver/charge.ts`): the quote, the prepaid checkout and "pay the unpaid session" now resolve the
  acquirer of the charger's country and record the payment's `currency`. Reservations and passes still resolve the
  Indonesian account (left for WP2 with the other fee paths, §10.1).
- **Card page** `/pay/stripe/<ref>/<payment intent>` (`services/payments/stripe-page.ts`, script `/pay/stripe.js`) with a
  CSP admitting `js.stripe.com` on that path only (`api/csp.ts`). Not in `driver-web/` (WP2's area).
- **Migration 070** (`070_stripe_payments.sql`, numbered to stay clear of WP2): `payment_webhook_event` (RLS fail-closed
  shape, explicit grants) and `subscription_charge.via` + `qr`, `bank`.
- **Tests.** `stripe.test.ts` (21, no DB), `stripe-registry.test.ts` (14, DB), Stripe in `adapters-idempotency.test.ts`,
  CSP test; `tools/testing/fake-stripe.ts` (stateful fake: idempotency replay, minimums, one capture, signed webhooks);
  `tools/e2e/stripe-e2e.mts` (33 checks, in the CI e2e job).

### 11.2 Deviations from §6.3

- **No `createQrCharge`.** PayNow goes through `createCheckout` returning `action: 'qr'` with `qrString` (the `Checkout`
  type gained both); QRIS keeps `createQrisCharge`. One code path for every non-QRIS channel.
- **Saved cards.** A Stripe Customer is created per saved card (metadata: the PlugSure driver id only), and the token
  PlugSure seals is `<customer>/<payment_method>`. No customer-mapping table is needed; a card is still usable only at
  the account that saved it. Saved-card charges are confirmed on-session with `return_url` (the driver is present), so
  3-D Secure comes back as `next_action.redirect_to_url`. Brand/last four are read from `GET /v1/payment_methods/:id`
  (webhook objects are not expanded).
- **Declines are not failures.** `payment_intent.payment_failed` maps to `requires_payment_method` (the Payment Element
  lets the driver try another card on the same PaymentIntent); only an expired PayNow QR maps to `expired`. A
  cancellation with `cancellation_reason: automatic` (an authorisation that lapsed) maps to `expired` and ends the hold.
- **Capture/cancel idempotency keys are per attempt** (`hold-capture-<id>:<random>`): Stripe replays the saved answer
  of a key for 24 h, failures included, which would freeze the hold worker's retries; a PaymentIntent can be captured
  only once and its status is read before each attempt, so this cannot double-capture. Refunds keep the stable
  `refund-<id>` key (never paid twice) and are looked up by `metadata.plugsure_idem` when an answer was lost.
- **Currency mismatch on money taken** is voided with a critical alert but **not** queued for automatic refund (the
  refund queue is in the payment's currency); the alert says to refund in the Stripe Dashboard.

### 11.3 Open (needs a human)

- Stripe account approval per country (SG and MY entities), PayNow / FPX / GrabPay activation.
- **V4**: MCC 5552 vs PayNow's prohibited categories (service stations / fuel dispensers) — confirm with Stripe before
  ticking PAYNOW; minimum *partial capture* below S$0.50 / RM 2.00 — confirm with Stripe.
- **V2**: PayNow pre-purchase as an SG guest method (LTA "deposit") — card hold is the default.
- The manual test-mode acceptance run (`deploy/STRIPE.md` §4), including the Payment Element with e-mail/phone set to
  `never` and `billing_details` passed as null on confirm (the fake cannot exercise Stripe.js).
- ~~WP2: driver-web rendering of `action: 'qr'` for PayNow (method `qr`), FPX/GrabPay labels and English/Malay strings;
  the registry's driver messages are still Indonesian; reservations and passes per country.~~ Done in the v1.7.0
  integration (§12); Malay strings remain out of scope (D12).

---

## 12. Integration notes (v1.7.0, branch `multi-country`)

- **Driver messages in the driver's language (deviation from D10).** D10 kept server messages Indonesian with the
  client dictionary translating them. That left API clients and old app versions with Indonesian text at Malaysian and
  Singapore chargers. `src/driver/i18n.ts` now translates at the API boundary instead. The driver modules keep their
  exact Indonesian source text, and every `/d/` JSON answer passes through `localizeBody()` (a `preSerialization`
  hook) only when the request's language is English.
  - **Language order:** `X-Driver-Lang` (the app sends its language on every call) → `Accept-Language` (`ms` reads
    as English) → the white-label operator's `default_locale` → the country of the connector or site the request names
    (MY, SG → English) → Indonesian.
  - **Indonesian answers** are the very same objects, so the pilot's text is unchanged.
  - **English wording** matches the app's own `DICT` wherever both have a message (a unit test enforces it), and a
    second test scans the driver modules so that no Indonesian sentence lacks its English.
  - Acquirer descriptions (statement text) for non-IDR payments are English at the source.
- **Driver app payments** render from the server's method list and the start-payment answer:
  - `action: 'qr'` uses the QRIS screen, named after the channel (PayNow), with its expiry time and an https
    instructions link.
  - `method: 'bank'` (FPX) goes to the Stripe page, where the bank is chosen.
  - GrabPay is an e-wallet redirect.
  - `paid.html` reads Stripe's `redirect_status` and the app's language.
  - Checkout answers carry `currency`, so a screen restored after the acquirer's page keeps S$ / RM.
- **Reservations and passes** already resolved `paymentsFor(org, country)` (WP2). `src/driver/fees-per-country.test.ts`
  now proves it against the fake Stripe. `reservationFeePaid()` and the site queue gate tera by the site country's
  profile (they used the Indonesian rule directly).
- **Rollback rehearsal with every v1.7 migration applied** (pilot_v16 copy, :5434):
  - 059–063 and 070 took 65–153 ms each (including `psql` start-up);
  - `060_down.sql` took 124 ms with 061–070 present and restored all 59 `*_idr` columns;
  - re-running `npm run migrate` re-applied 060 alone.
- **Restores:** `pg_restore` does not restore `ALTER ROLE plugsure_app IN DATABASE … SET app.rls_bypass` (048). This
  was verified again, and the command and check are in `deploy/pitr/RESTORE.md` §2a.
- §9 corrected: `rerate-compare` has no `--dry` flag and needs the 060 schema, and the rollback script deletes its own
  `schema_migration` row.

- **Review fixes** (RELEASE-NOTES-v1.7.0.md, "Review fixes"). They cover:
  - Stripe test mode: platform-admin only, and payments tagged TEST (migration 071);
  - roaming shortfalls and late CDRs owed by the driver and paid in the app; unmatched APP_USER CDRs held for review;
  - per-organisation zones (`services/org-timezone.ts`, deviating from §D5's env defaults only outside Indonesia);
  - legacy `*Idr` request keys refused for non-IDR amounts;
  - integer money arithmetic for MYR/SGD;
  - SG/MY fleet-invoice GST extracted from the receipts' gross;
  - no OCPI home-party fallback;
  - a floor on roaming holds, and holds tied to their partner and location.
