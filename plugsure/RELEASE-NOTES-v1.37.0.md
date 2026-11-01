# PlugSure CSMS v1.37.0: release notes

**Date:** 1 November 2026
**Base:** v1.36.0.

v1.37.0 is phase 26 of the finance work:
- driver and fleet loyalty costs;
- tax audit readiness;
- site P&L and portfolio review;
- the budget planning workflow.

- **Migration:** one, 105. It adds three tables, a settings column and one ledger source. It is additive.
- **When nothing changes:** the new tabs only read until letters or budget versions are recorded. The loyalty journal appears in the ledger once months are synced, and only where points exist.
- **Guide:** `deploy/FINANCE.md`, *Loyalty costs, tax audit, portfolio and budget planning*.

## New

### Loyalty and promotion costs

The new Finance → **Loyalty costs** tab: the finance side of the points and promotions that already run under Commercial → Promotions & plans.

**The points liability** at each month's end:
- the points outstanding (earned − redeemed − expired ± adjusted, from the points ledger);
- × what a point is worth (the programme's point value): the gross liability;
- less breakage, the share that will never be used: learned from the last twelve months (points expired ÷ points expired or redeemed), or a fixed rate set here (0–90%);
- the net is revenue deferred (PSAK 72 / IFRS 15: points are a material right).

**Ledger, the new loyalty journal:** the month's change in the net liability. Up: Dr 4150 loyalty points deferred / Cr 2250 loyalty points liability. Down: the reverse, as redeemed points already lowered the charge record's price.

**Promotion cost** over 3, 6 or 12 months:
- per promotion: uses, customers, the discount and the revenue it came with;
- per site: discounts plus points redeemed, as a share of the site's revenue.

### Tax audit readiness

The new Finance → **Tax audit** tab: being ready before the tax office (DJP) asks.

**Equalisation** for a year, per month (rupiah):

| Check | Against | An open item when |
|---|---|---|
| The PPN return as filed | Today's figures | They differ: an amendment (pembetulan) may be needed; or the month is not filed |
| Charging revenue (charge records) | PPN output's retail DPP | A PKP's differ materially (fleet invoices, credit notes and memberships are shown beside) |
| PPN on approved supplier bills | Faktur masukan recorded | The bills' PPN is materially above what is recorded (faktur masukan also cover VAT without a bill, such as gateway fees) |
| PPh 21/23/26 withheld on bills | Bukti potong issued | A bill has no issued slip |
| Fleet invoices with PPN | e-Faktur numbers | One has none |

- Differences under Rp 1,000 or 0.5% are not material.
- **Readiness** is the share of the year's ended months with nothing open.

**The tax office's letters:**
- an SP2DK, an office or field audit, or other: the letter number, the year, the taxes, the received and respond-by dates (an SP2DK: 14 days by default);
- open → responded → closed with no change, or assessed (the SKP amount) → objected or paid;
- `finance.tax_audit_due` warns from 7 days before the respond-by date, critical once past.

**The audit pack:** one ZIP with the equalisation workbook, the open items as CSV, a README and a manifest with each file's SHA-256 (also in the `x-manifest-sha256` header).

### Site P&L and portfolio review

The new Finance → **Portfolio** tab: each site's full result over the last 3, 6 or 12 whole months. It builds on the month's site P&L (Cost allocation) and adds what later modules know about the site.

| Line | From |
|---|---|
| Revenue, energy cost | Margin (bills, else the site's cost per kWh) |
| Shared costs | Cost allocation |
| Rent | The site's landlord deal (the fixed rent of a deal held in a lease is left out) |
| Maintenance | Work orders done (or opened) in the month, net of warranty recovered |
| Insurance | The month's share of the premium of paid policies on the site or its chargers |
| **Operating result** | Revenue less all of the above |
| Depreciation | The site's investments |
| Grants | Capital grants for the site, released |
| **Contribution** | Operating result − depreciation + grants |

Sites are ranked per currency by contribution. Each gets a **signal** with its reasons:

| Signal | When |
|---|---|
| Review for closure | An operating loss in most months and overall: it does not pay its running costs |
| Fix | The contribution is below zero; or rent is over 30% of revenue, energy over 80%, or maintenance per kWh over twice the portfolio's median |
| Grow | Top quarter of the portfolio and the last three months better than the three before |
| Keep | Otherwise |

The review is in Excel (sites and the monthly contribution) and as a PDF.

### Budget planning

The new Finance → **Budget planning** tab: next year's budget, built and approved before it is used.

**Versions** per year and currency (v1, v2, …): draft → submitted → approved, or rejected with a note.

**Seeding:**
- *forecast*: the rolling forecast's revenue and energy cost per site by calendar month, plus each site's rent, maintenance and insurance at the last twelve months' monthly average (the portfolio review);
- *copy*: another version's lines;
- *empty*;
- a growth % a year, compounded monthly.

**Lines:**
- per site: revenue, energy cost, rent, maintenance, insurance;
- for the organisation's departments: staff, marketing, IT, other opex, capex.

**Approval:**
- by a second person with `finance:approve`, not the one who submitted it;
- approving publishes each site's revenue and energy cost to Budgets for every month not locked, so budget against actual and the forecast's alerts use them;
- the version approved before is superseded.

### API

13 new operations (762 in all):

| Operation | Permission |
|---|---|
| `GET /v1/finance/loyalty` (`months`, `format=xlsx`) | `payment:read` |
| `PUT /v1/finance/loyalty/settings` | `payment:write`, audited |
| `GET /v1/finance/tax-audit` (`year`, `format=xlsx`) | `payment:read` |
| `GET /v1/finance/tax-audit/pack` (`year`) | `payment:read`, audited |
| `POST /v1/finance/tax-audit/cases`, `PUT …/cases/{id}` | `payment:write`, audited |
| `GET /v1/finance/portfolio` (`months`, `to`, `format=xlsx` or `pdf`) | `payment:read` |
| `GET /v1/finance/budget-plans`, `GET …/budget-plans/{id}` (`format=xlsx`) | `payment:read` |
| `POST /v1/finance/budget-plans`, `PUT …/{id}/lines`, `POST …/{id}/submit` | `payment:write`, audited |
| `POST /v1/finance/budget-plans/{id}/decide` | `payment:write` and `finance:approve`, audited |

**Ledger:** a new source (loyalty) and new accounts 2250 and 4150.

**New worker:** `tax-audit-letters`, daily.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **105**:
   - `tax_audit_case`, `budget_plan` and `budget_plan_line`, with row-level security and no DELETE for the runtime role;
   - `finance_org_settings.loyalty_accounting`;
   - the ledger's new source.
2. Optionally:
   - set a breakage rate;
   - sync the ledger's months;
   - review last year's equalisation;
   - record open tax office letters;
   - build next year's budget;
   - route `finance.tax_audit_due`.

**Rollback:**
1. Roll the code back to v1.36.0.
2. Export the tax audit letters and the budget versions.
3. Run `db/rollback/105_down.sql`. Budgets already published from a plan stay.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 5 of them new. They cover:
  - **helpers:**
    - breakage and the net liability;
    - material differences;
    - growth;
    - the portfolio signals;
  - **loyalty:**
    - the liability at two month ends with the learned breakage (25%) and the change;
    - the ledger's true-up (2250 left at the net liability, 4150 released);
    - a fixed breakage rate;
    - promotion and points cost per promotion and site;
  - **tax audit:**
    - withholding without a bukti potong and PPN on bills without faktur masukan found;
    - an SP2DK's 14 days and its alert, resolved once assessed;
    - the status steps;
    - the pack with its manifest hash;
  - **portfolio:**
    - rent, maintenance, insurance and a grant on the site P&L, to the rupiah;
    - the ranking;
    - a site paying 400% of its revenue in rent flagged for closure review;
    - Excel and PDF;
  - **budget planning:**
    - a version seeded from the forecast with rent from the last twelve months;
    - lines checked by site or department;
    - not changed once submitted;
    - not approved by the submitter;
    - a rejection needs a note;
    - approval publishing to Budgets;
    - a copied version 2 superseding version 1.
- **Database:**
  - the least-privilege pins cover the three new tables;
  - the 105 rollback was checked.
- **Console:** the four new tabs were checked in light and dark mode and at phone width, with no page errors.

**To confirm before live use:**
- **Breakage:** the rate your auditors accept for points (the learned rate needs a year of history to settle).
- **Portfolio thresholds:** the 30% rent, 80% energy and twice-the-median maintenance thresholds against your sites.
