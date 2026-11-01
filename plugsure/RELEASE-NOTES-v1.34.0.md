# PlugSure CSMS v1.34.0: release notes

**Date:** 1 November 2026
**Base:** v1.33.0.

v1.34.0 is phase 23 of the finance work:
- inventory and spare parts;
- maintenance cost tracking;
- revenue assurance;
- investor and lender reporting.

- **Migration:** one, 102. It adds eleven tables, two supplier bill columns and three ledger sources. It is additive.
- **When nothing changes:** nothing changes until items, work orders, loans or covenants are recorded. Revenue assurance starts checking sessions daily; its findings only inform.
- **Guide:** `deploy/FINANCE.md`, *Inventory, maintenance, revenue assurance and lenders*.

## New

### Inventory and spare parts

The new Finance → **Inventory** tab.

**Items:** spare parts, consumables and tools by SKU. Each has a unit, a reorder point and quantity, the usual supplier, and the moving average cost.

**Locations:** depots and site stores.

**Moves:**

| Move | What it does |
|---|---|
| Receipt | Adds stock at its price, optionally against an approved purchase order. It re-averages the cost: (value held + receipt) ÷ (quantity held + received). |
| Issue | Takes stock out to a work order, or by hand, at the average cost. |
| Transfer | Moves stock between locations at the average cost. |
| Count | Adjusts to the counted quantity, with a note; the difference is valued at the average cost. |

Stock never goes below zero at a location.

**Alerts:** items at or below their reorder point raise `finance.stock_reorder` (checked daily, resolved above it).

**Ledger, the new inventory journal:**
- receipts: Dr 1700 inventory / Cr 2105 goods received not invoiced;
- issues: Dr 6260 spare parts used / Cr 1700;
- counts: against 6265 stock adjustments;
- a supplier bill marked as **stock** clears 2105 instead of being expensed.

### Maintenance cost tracking

The new Finance → **Maintenance** tab.

**Work orders** on a charger or a site:
- corrective, preventive or warranty;
- open, in progress, done, or cancelled;
- numbered WO-00001….

**A work order's cost:**
- labour: hours × rate;
- parts: issued from stock;
- contractors: the supplier bills linked to it;
- accrual: a done order whose contractor has not billed carries the contractor's estimate at the month's end (2110, reversed the next month).

**Warranty claims** on the supplier for an order's cost are submitted, accepted or rejected, then paid. The amount recovered reduces the net cost (6205).

**Costs** per charger and per site over a period: labour, parts, contractors, accrued, recovered, net, the energy delivered, and the **cost per kWh**; also by kind of order. Excel.

**Ledger, the new maintenance journal:**
- labour of orders done in the month (6270 / 2115);
- the contractor accrual and its reversal (6200 / 2110);
- warranty paid (bank / 6205).

### Revenue assurance

The new Finance → **Assurance** tab. Every session of a month is checked against what was billed:

| Check | Found when |
|---|---|
| Not billed | ended more than two hours ago, with energy, and no charge record |
| Roaming, no charge record | the same, for a partner's driver |
| Billed at zero | 0.1 kWh or more, with no discount explaining it |
| Energy billed differs | from the session's by more than 2% (and 0.1 kWh) |
| Meter values differ | the session's energy against its meter register, by more than 2% (and 0.1 kWh) |
| Signed values not verified | the charger's signed meter values failed |
| Price far below the site | less than half the site's median per kWh for the month (10 or more sessions) |

**Expected amount:** the energy at the site's median price per kWh, or the billed amount scaled by the energy.

**Reviewing a finding:**
- **Recovered:** with the amount.
- **Written off:** with a note.
- **Dismissed:** with a note.

A finding found again keeps its review. One no longer found (billed since, or corrected) is dismissed.

**Schedule and summary:**
- The worker checks this month and the last daily, and raises `finance.revenue_findings` when new ones appear.
- The summary per currency shows the open leakage, what was recovered and what was written off.
- Excel.

### Investor and lender reporting

The new Finance → **Lenders** tab.

**Loans:**
- **Terms:** facility, currency, rate, start, term, grace months (interest only), repayment (annuity, equal principal or bullet), and the bank account the loan runs through.
- **Drawdowns:** up to the facility.
- **Payments:** principal (up to the balance), interest and fees.
- **The schedule:** month by month from what is drawn.
- **Ledger:** drawdowns Dr bank / Cr 2500 loans; payments Dr 2500, 7210 interest and 7215 fees / Cr bank.
- **Cash position:** counts them.

**Covenants**, per loan or overall, tested monthly or quarterly over the twelve months to the month's end:

| Covenant | Value | Must be |
|---|---|---|
| DSCR | EBITDA ÷ (principal + interest paid) | at least the threshold |
| Interest cover | EBITDA ÷ interest paid | at least |
| Leverage | loans outstanding ÷ EBITDA | at most |
| Minimum cash | the cash position at the month's end | at least |

EBITDA comes from the posted ledger: revenue − expenses + depreciation (6400, 6410). Sync the months first.

**Test results:**
- Each test is kept with its headroom.
- A breach raises `finance.covenant_breach` (critical); less than 10% headroom raises a warning.
- The worker tests last month: monthly covenants every month, quarterly covenants in March, June, September and December.

**The lender pack** (PDF and Excel):
- the twelve months' results per currency;
- the covenants' tests;
- each loan and its schedule.

### API

Twenty-eight new operations (696 in all):

| Operation | Permission |
|---|---|
| `GET /v1/finance/inventory` (`format=xlsx`) | `payment:read` |
| `POST /v1/finance/inventory/items`, `PUT …/items/{id}` | `payment:write`, audited |
| `POST /v1/finance/inventory/locations`, `PUT …/locations/{id}` | `payment:write`, audited |
| `GET /v1/finance/inventory/moves` | `payment:read` |
| `POST /v1/finance/inventory/moves` | `payment:write`, audited |
| `GET /v1/finance/maintenance` | `payment:read` |
| `GET /v1/finance/maintenance/costs` (`format=xlsx`) | `payment:read` |
| `POST /v1/finance/maintenance`, `PUT …/{id}` | `payment:write`, audited |
| `GET /v1/finance/maintenance/{id}` | `payment:read` |
| `POST /v1/finance/maintenance/{id}/claims` | `payment:write`, audited |
| `POST /v1/finance/maintenance/claims/{cid}` | `payment:write`, audited |
| `POST /v1/finance/bills/{id}/links` | `payment:write`, audited |
| `GET /v1/finance/assurance` (`format=xlsx`) | `payment:read` |
| `POST /v1/finance/assurance/run` | `payment:write`, audited |
| `POST /v1/finance/assurance/findings/{id}` | `payment:write`, audited |
| `GET /v1/finance/lenders` | `payment:read` |
| `GET /v1/finance/lenders/pack` (`format=pdf`, `xlsx`, audited) | `payment:read` |
| `POST /v1/finance/lenders/loans`, `PUT …/loans/{id}` | `payment:write`, audited |
| `GET /v1/finance/lenders/loans/{id}` | `payment:read` |
| `POST /v1/finance/lenders/loans/{id}/drawdowns`, `…/payments` | `payment:write`, audited |
| `POST /v1/finance/lenders/covenants`, `PUT …/covenants/{id}` | `payment:write`, audited |
| `POST /v1/finance/lenders/covenants/test` | `payment:write`, audited |

**Ledger:** three new sources (inventory, maintenance, loans) and new accounts 1700, 2105, 2110, 2115, 2500, 6205, 6260, 6265, 6270, 7210 and 7215.

**New workers:**
- `stock-reorder`, daily;
- `revenue-assurance`, daily;
- `covenant-tests`, every 12 hours, once per month and covenant.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **102**:
   - `stock_item`, `stock_location`, `stock_move`, `work_order`, `warranty_claim`, `revenue_finding`, `loan`, `loan_drawdown`, `loan_payment`, `covenant` and `covenant_test`, with row-level security and no DELETE for the runtime role;
   - `supplier_bill.stock` and `.work_order_id`;
   - the ledger's new sources.
2. Optionally:
   - record the opening stock as receipts;
   - mark stock bills;
   - record work orders;
   - review the first assurance month;
   - add the loans and covenants;
   - sync the ledger's months;
   - route the new alerts.

**Rollback:**
1. Roll the code back to v1.33.0.
2. Export stock, work orders, findings and the lender pack.
3. Run `db/rollback/102_down.sql`.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 4 of them new. They cover:
  - **helpers:**
    - annuity, equal-principal with grace, and bullet schedules;
    - the covenants' evaluation (met, breached, nothing to cover);
    - the median;
  - **inventory and maintenance:**
    - receipts re-averaging the cost;
    - an issue to a work order;
    - a transfer, and a count with its note;
    - never below zero;
    - the order's labour, parts and accrual;
    - the inventory and maintenance journals (1700, 2105, 6260, 6265, 6270, 6200);
    - the stock bill clearing 2105, and the contractor's bill replacing the accrual;
    - a warranty claim accepted and paid;
    - cost per charger and per kWh;
    - the reorder alert;
  - **revenue assurance:**
    - not billed, billed at zero, energy and meter mismatch, and a price outlier, each found once with the expected amount from the site's median;
    - the leakage;
    - recovered and written off (a note needed);
    - a corrected session's finding dismissed while the reviews are kept;
  - **lenders:**
    - a loan drawn (not above the facility) and paid (not above the balance);
    - the schedule's grace;
    - the cash position and the ledger (2500, 7210);
    - leverage breached with a critical alert, and minimum cash met;
    - the lender pack in PDF and Excel.
- **Database:**
  - the least-privilege pins cover the eleven new tables;
  - the 102 rollback was checked.
- **Console:** the four tabs were checked in light and dark mode and at phone width, with no page errors.

**To confirm before live use:**
- **Covenant definitions:** each loan agreement's definitions of EBITDA, debt service and leverage. The calculation here is a common one; adjust thresholds to match.
- **Revenue assurance tolerances:** the 2% and 0.1 kWh tolerances, and the half-the-median price rule, against your tariffs (membership prices, free sessions).
- **Inventory valuation:** the moving average method suits your accounting policy.
- **Maintenance labour rates:** internal technicians' labour rates.
