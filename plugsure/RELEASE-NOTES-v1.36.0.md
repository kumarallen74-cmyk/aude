# PlugSure CSMS v1.36.0: release notes

**Date:** 1 November 2026
**Base:** v1.35.0.

v1.36.0 is phase 25 of the finance work:
- grants and incentives;
- site lease and landlord deals;
- chargebacks and fraud;
- board and KPI packs.

- **Migration:** one, 104. It adds seven tables and three ledger sources. It is additive.
- **When nothing changes:** nothing changes until grants, landlord deals or chargebacks are recorded. The board pack's new sections appear only for modules in use; packs drafted before stay as they were.
- **Guide:** `deploy/FINANCE.md`, *Grants, landlords, chargebacks and the board pack*.

## New

### Grants and incentives

The new Finance → **Grants** tab: government, utility or development-bank money for charging infrastructure.

| Kind | What it pays for | Ledger |
|---|---|---|
| Capital | Assets (a site build, chargers) | Received: Dr bank / Cr 2600 deferred grant income. Released straight-line from the month received over the assets' useful life (the linked capex project's, else 96 months, a charger's life; PSAK 61 / IAS 20): Dr 2600 / Cr 4400 grant income. |
| Revenue | Running costs | Approved: Dr 1350 grants receivable / Cr 4400. Paid: Dr bank / Cr 1350; a short payment reduces the income. |
| Per kWh | A rate per kWh charged | As revenue; the claim takes the kWh charged in its period at the grant's site (or every site). |

**Conditions:** what the grantor requires, with a due date. Pending ones raise `finance.grant_condition_due` from 14 days ahead (critical once past). Met, breached (a note) or waived (a note).

**Claims** (GC-00001…): at most what is left of the award; draft → submitted → approved or rejected → paid (what was received, to which account).

**Clawbacks:**
- an amount taken back, usually for a condition breached;
- it comes out of the deferred balance first; the rest is an expense (6700);
- it is owed (2610) until repaid;
- a capital grant stops releasing after it.

The cash position counts grants received and clawbacks repaid. The register is in Excel.

### Site lease and landlord deals

The new Finance → **Landlords** tab: what a site pays the owner of its land or car park. The landlord is a supplier. Site owners who share the platform's revenue under a commercial plan stay under Owners and Statements.

| Basis | Each month |
|---|---|
| Fixed | The rent |
| Share | A % of the site's revenue (before tax) or margin (after energy) |
| Higher of | The share, at least the minimum guarantee (the top-up is shown) |
| Fixed plus share | Both |

**Terms:**
- escalation: the fixed rent and the minimum grow each year of the deal;
- rent-free months at the start waive the fixed rent and the minimum (a share is still due);
- a part month is pro-rated by days;
- an energy recharge per kWh when the landlord supplies the power;
- billing monthly or quarterly;
- the PSAK 73 lease holding the fixed rent, when there is one: the fixed part is shown but left out of the statements.

**Statements** (LS-00001…):
- drafted on the 2nd for periods that have ended (or by hand), refreshed while draft;
- issued: the total becomes the landlord's supplier bill (category rent, awaiting approval);
- a PDF for the landlord;
- voided only while the bill is draft, rejected or void.

The terms are fixed once a statement is issued: end the deal and add a new one from the change.

**Ledger:** each month's amount not billed by the month's end is accrued (Dr 6210 rent / Cr 2420 accrued rent) and reversed the next month; the bill then carries it.

### Chargebacks and fraud

The new Finance → **Chargebacks** tab.

**Cases** on a payment (by its reference):
- provider and case number (unique), reason and code;
- amount (default and at most what was captured) and fee;
- received and respond-by dates: the date on the gateway's notice, else 7 calendar days (Xendit's window from the first notice; other gateways give 5 to 10);
- open → evidence submitted → won or lost; or accepted (not contested).

`finance.chargeback_due` warns 3 days ahead of the deadline, critical once past.

**Evidence:** a PDF for the provider built from the payment and its charging session:
- the payment: authorised, captured, any refund;
- the service: site, charger, connector, start and end, the energy delivered and the meter readings;
- the receipt's lines;
- the token and the driver's contact, masked.

**Ledger:**
- received: Dr 1190 disputed funds / Cr 1130 gateway balance, and the fee to 6110;
- won: Dr 1130 / Cr 1190;
- lost or accepted: Dr 6520 chargeback losses / Cr 1190.

**Fraud signals** over 90 days:
- tokens and drivers with two or more chargebacks (block the token from here);
- payments refunded and also charged back;
- five or more failed or expired payments at one connector in a day (card testing);
- the chargeback rate per payment method: `finance.chargeback_rate` from 0.9% (two cases or more), where the card schemes start to act.

### Board and KPI packs

The report pack (Finance → Reports) gains:

| Section | What |
|---|---|
| Risk and compliance | Insurance renewals and open claims; compliance deadlines overdue and due, auditor requests; chargebacks open and lost; grant conditions due or breached |
| Lenders | The month's covenant tests |
| Sustainability | MWh charged, the green share, the emissions avoided |
| Grants | Received, deferred, still to claim, repayable |

- Each section appears when its module is in use, with its own commentary. They are also in the PDF, the Excel (a Board sheet) and the console's Board tab.
- **Trend:** the last twelve packs' revenue and result, shown on the Reports tab.
- **Slides:** the pack as a 16:9 deck (PDF): title, results, the twelve months, scorecard, sites, risk, lenders, sustainability and grants, with the commentary.

### API

25 new operations (749 in all):

| Operation | Permission |
|---|---|
| `GET /v1/finance/grants` (`format=xlsx`), `GET …/grants/{id}` | `payment:read` |
| `POST /v1/finance/grants`, `PUT …/grants/{id}` | `payment:write`, audited |
| `POST /v1/finance/grants/{id}/conditions`, `POST …/grants/conditions/{cid}` | `payment:write`, audited |
| `POST /v1/finance/grants/{id}/claims`, `POST …/grants/claims/{cid}` | `payment:write`, audited |
| `POST /v1/finance/grants/{id}/clawbacks`, `POST …/grants/clawbacks/{cid}/repay` | `payment:write`, audited |
| `GET /v1/finance/landlords` (`format=xlsx`), `GET …/landlords/{id}` | `payment:read` |
| `POST /v1/finance/landlords`, `PUT …/landlords/{id}` | `payment:write`, audited |
| `POST /v1/finance/landlords/{id}/statements` | `payment:write`, audited |
| `GET /v1/finance/landlords/statements/{sid}` (`format=pdf`) | `payment:read` |
| `POST /v1/finance/landlords/statements/{sid}/issue`, `…/void` | `payment:write`, audited |
| `GET /v1/finance/chargebacks` (`status`, `format=xlsx`), `GET …/chargebacks/{id}`, `GET …/chargebacks/fraud` | `payment:read` |
| `GET /v1/finance/chargebacks/{id}/evidence` | `payment:read`, audited |
| `POST /v1/finance/chargebacks`, `POST …/chargebacks/{id}` | `payment:write`, audited |
| `POST /v1/finance/chargebacks/tokens/{tid}/block` | `payment:write`, audited |

`GET /v1/finance/report-packs/{id}` also takes `format=slides`, and `GET /v1/finance/report-packs` returns the `trend`.

**Ledger:** three new sources (grants, landlords, chargebacks) and new accounts 1190, 1350, 2420, 2600, 2610, 4400, 6520 and 6700.

**New workers:**
- `grant-conditions`, daily;
- `landlord-statements`, daily (drafts the periods that have ended);
- `chargeback-checks`, every 6 hours.

**PDF:** documents can now be laid out on other page sizes (the slides are 960 × 540 points); A4 stays the default.

**Fixed:** the lender pack PDF showed `?` for the covenants' ≥ and ≤ (the PDF fonts have no such glyph); it now reads `>=` and `<=`.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **104**:
   - `grant_programme`, `grant_condition`, `grant_claim`, `grant_clawback`, `landlord_deal`, `landlord_statement` and `chargeback`, with row-level security and no DELETE for the runtime role;
   - the ledger's new sources.
2. Optionally:
   - record the grants and their conditions;
   - add the landlords as suppliers and the deals, linking the leases;
   - record open chargebacks;
   - sync the ledger's months;
   - route the new alerts.

**Rollback:**
1. Roll the code back to v1.35.0.
2. Export the grant register, the landlord deals and statements, and the chargebacks.
3. Run `db/rollback/104_down.sql`. Supplier bills issued from statements stay; packs keep their data.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 5 of them new. They cover:
  - **helpers:**
    - release schedules (rounding in the last month, stopping after a clawback);
    - a deal's month: the minimum's top-up, rent-free, escalation in the second year, part months, a share of margin with and without a known cost, the fixed rent in a lease;
    - masking;
  - **grants:**
    - a capital grant over its award refused, received into the cash position, released (4400) and deferred (2600);
    - a condition's alert, breached with a note;
    - a clawback from the deferred balance with the rest an expense (6700, 2610);
    - a per-kWh claim from the kWh charged, approved and paid short (1350 cleared);
  - **landlords:**
    - higher of a share and a minimum with the top-up, a rent-free month, the recharge;
    - a statement issued as the landlord's bill, the PDF, not voided while the bill awaits approval, the terms fixed once issued;
    - the accruals and their reversal (2420, 6210);
    - the worker drafting the periods due;
  - **chargebacks:**
    - not above what was captured, one per case;
    - the deadline alerts;
    - the evidence PDF;
    - lost and accepted in the ledger (1190, 6520) with the fee;
    - repeat tokens, refunded and charged back, a card-testing burst, the rate alert;
    - a token blocked once;
  - **board pack:**
    - the risk, sustainability and grants sections (no lenders);
    - commentary for the new sections;
    - the trend;
    - slides at 16:9, with the PDF and Excel.
- **Database:**
  - the least-privilege pins cover the seven new tables;
  - the 104 rollback was checked.
- **Console:** the three new tabs and the board pack were checked in light and dark mode and at phone width, with no page errors.

**To confirm before live use:**
- **Landlord terms:** each deal against its contract, especially what "revenue" means (before tax, after refunds) and how part months are charged.
