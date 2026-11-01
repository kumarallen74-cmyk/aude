# PlugSure CSMS v1.29.0: release notes

**Date:** 1 November 2026
**Base:** v1.28.0.

v1.29.0 is phase 18 of the finance work: a fixed asset register, supplier bills and payables, the cash position across bank accounts and gateways, and KPI benchmarking of sites and owners.

- **Migration:** one, 097 (eight new tables; one settings column; a column on bank statements; a bank-match kind; additive).
- **When nothing changes:** until assets, suppliers, bills or cash accounts are recorded. The new tabs only read until used.
- **Guide:** `deploy/FINANCE.md`, *Assets, bills, cash and benchmarking*.

## New

### Fixed asset register

The new Finance → **Assets** tab.

**Each asset** has:
- a tag (FA-00001…), a category and, optionally, a site and a charge point;
- its cost before PPN and a residual value;
- the month it goes into service (by default, the month after it was bought);
- its life and its depreciation method.

**Methods:**
- **Straight line:** (cost − residual) ÷ life. The last month takes the rounding.
- **Declining balance:** the net book value × the yearly rate ÷ 12 (by default, double the straight-line rate). It never goes below the residual, and the last month of its life brings it to the residual.

**Disposing of an asset** records the date and the proceeds. Depreciation stops from that month, and the gain or loss (proceeds − net book value) goes into the month's journal.

**Importing:** site investments (v1.22.0) become assets once (straight line over their months).

**The month's journal**, per currency:
- Dr depreciation expense / Cr accumulated depreciation, by category.
- For disposals: Dr accumulated depreciation, Dr bank, Cr cost, and the gain or loss.

The account codes can be set. *Record the month* keeps it once the month has ended. After that, an asset in it can be disposed of but not voided. Locked months are respected.

**The register** shows cost, accumulated depreciation, net book value and status as of any month, and exports to Excel.

### Supplier bills and payables

The new Finance → **Bills** tab.

**Suppliers:** NPWP, contact, bank details, payment terms and the PPh 23 rate withheld. Bank-detail changes are audited in full.

**Bills:**
- The supplier's number, its date and due date (by default the date + the terms), category, site and description.
- The subtotal, PPN and PPh 23 (by default the supplier's rate × the subtotal).
- Payable = subtotal + PPN − PPh 23.

**Approval:** by a second person, never the one who submitted the bill. The approvals matrix has a new **Supplier bills** row: a Finance Manager, or two approvers, above an amount. A bill can be rejected with a reason, corrected and submitted again.

**Capitalising:** equipment, installation or other bills marked to capitalise become an asset on approval: the subtotal, over the months given.

**Payments:**
- Recorded against an approved bill: date, amount, method, reference and the cash account.
- The bill is paid when the payments reach the payable.
- A payment can be voided with a reason, unless it is matched on a bank statement.
- Bank transfers are candidates in bank reconciliation (new match kind `supplier_payment`).

**Payables:**
- Ageing by supplier and days past due: not due, 1–30, 31–60, 61–90, over 90.
- What falls due in the next 14 days, and what is awaiting approval.
- Excel export.
- An approved bill past its due date raises `finance.supplier_bill_overdue` (checked daily), resolved when it is paid.

### Cash position

The new Finance → **Cash** tab.

**Accounts:** bank and cash accounts with an opening balance, the account number's last digits, and an optional minimum.

**An account's balance on a day** is its latest anchor, plus the transfers and supplier payments from the account since. The anchor is one of:
- a balance taken by hand;
- the last balance on a bank statement of the account (linked, or with the same last digits);
- the opening balance.

Each balance says where it came from and how old it is. Accounts with no balance for more than 7 days are flagged.

**Gateways:** the Xendit and Duitku balances come from the gateway's own snapshots.

**Transfers** between accounts in the same currency can be voided with a reason.

**The next 13 weeks**, per currency, start from today's position. Week by week they add:
- what the gateway forecast (v1.19.0) expects in and out: settlements, fleet invoices, Hub positions, refunds, owner shares and PlugSure's statements;
- supplier bills, by due date.

They show the closing position, the lowest point and the first week below the accounts' minimums.

An account below its minimum raises `finance.cash_below_minimum` (checked daily), resolved when it recovers.

### KPI benchmarking

The new Finance → **Benchmark** tab compares sites, or site owners, over the last 1 to 12 ended months. Each is compared with its peers in the same currency.

| Metric | |
|---|---|
| Revenue | Before tax. |
| Revenue / kWh | |
| Utilisation | Charging time ÷ (connectors × the period's hours). |
| Margin | (Revenue − energy cost) ÷ revenue. Energy cost is the bill, else the cost per kWh. |
| Revenue / connector / month | |
| Collection days | From the charge record to the money (the payment, or the fleet invoice paid). Fewer is better. |

**Per metric:**
- the peers' quartiles and median;
- each one's percentile rank (100 is the best; none without peers);
- outliers beyond 1.5 × the interquartile range, flagged good or bad.

The score is the average rank. Excel export.

### API

Thirty-two new operations (546 in all):

| Operation | Permission |
|---|---|
| `GET /v1/finance/assets` | `payment:read` |
| `POST /v1/finance/assets` | `payment:write`, audited |
| `POST /v1/finance/assets/import-investments` | `payment:write`, audited |
| `GET /v1/finance/assets/journal` | `payment:read` |
| `POST /v1/finance/assets/journal/{month}/record` | `payment:write`, audited |
| `PUT /v1/finance/assets/accounts` | `payment:write`, audited |
| `GET /v1/finance/assets/{id}` | `payment:read` |
| `POST /v1/finance/assets/{id}/dispose` | `payment:write`, audited |
| `POST /v1/finance/assets/{id}/void` | `payment:write`, audited |
| `GET /v1/finance/suppliers` | `payment:read` |
| `POST /v1/finance/suppliers` | `payment:write`, audited |
| `PUT /v1/finance/suppliers/{id}` | `payment:write`, audited |
| `GET /v1/finance/bills` | `payment:read` |
| `POST /v1/finance/bills` | `payment:write`, audited |
| `GET /v1/finance/bills/{id}` | `payment:read` |
| `POST /v1/finance/bills/{id}/submit` | `payment:write`, audited |
| `POST /v1/finance/bills/{id}/approve` | `payment:write` and the approvals matrix, audited |
| `POST /v1/finance/bills/{id}/reject` | `payment:write`, audited |
| `POST /v1/finance/bills/{id}/void` | `payment:write`, audited |
| `POST /v1/finance/bills/{id}/payments` | `payment:write`, audited |
| `POST /v1/finance/bills/{id}/payments/{pid}/void` | `payment:write`, audited |
| `GET /v1/finance/payables` | `payment:read` |
| `GET /v1/finance/cash` | `payment:read` |
| `GET /v1/finance/cash/weeks` | `payment:read` |
| `GET /v1/finance/cash/accounts` | `payment:read` |
| `POST /v1/finance/cash/accounts` | `payment:write`, audited |
| `PUT /v1/finance/cash/accounts/{id}` | `payment:write`, audited |
| `POST /v1/finance/cash/accounts/{id}/balances` | `payment:write`, audited |
| `POST /v1/finance/cash/accounts/{id}/statements` | `payment:write`, audited |
| `POST /v1/finance/cash/transfers` | `payment:write`, audited |
| `POST /v1/finance/cash/transfers/{id}/void` | `payment:write`, audited |
| `GET /v1/finance/benchmark` | `payment:read` |

The approvals matrix accepts the kind `supplier_bill`. The bank-reconciliation match kinds now list `roaming_payment` (v1.25.0) and `supplier_payment` in the API description.

New workers, both daily:
- `supplier-bills-overdue`;
- `cash-minimum-check`.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **097**:
   - `supplier`, `supplier_bill`, `supplier_payment`, `cash_account`, `cash_balance`, `cash_transfer`, `fixed_asset` and `fixed_asset_run`, with row-level security and no DELETE for the runtime role;
   - `bank_statement.cash_account_id`;
   - the `supplier_payment` match kind;
   - the asset journal's account settings.
2. Optionally:
   - add the bank and cash accounts with their opening balances;
   - add the suppliers;
   - import the site investments into the asset register;
   - set the supplier-bill row of the approvals matrix;
   - route `finance.supplier_bill_overdue` and `finance.cash_below_minimum`.

**Rollback:**
1. Roll the code back to v1.28.0.
2. Export the register, the bills and the cash accounts.
3. Run `db/rollback/097_down.sql`. Bank lines matched to supplier payments are unmatched.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 6 of them new. They cover:
  - **depreciation:**
    - straight line with the rounding in the last month;
    - declining balance ending at the residual;
    - a disposal stopping it;
  - **benchmark statistics:** quartiles, ranks and outliers;
  - **fixed assets:**
    - the register as of this month;
    - last month's journal balanced and recorded;
    - the void refused for a recorded month;
    - a disposal with its gain;
    - site investments imported once;
  - **supplier bills:**
    - PPh 23 from the supplier's rate, and the due date from the terms;
    - the submitter refused as approver, and two approvers under the matrix;
    - a capitalised bill becoming an asset;
    - the ageing, and the overdue alert raised and resolved;
    - payment in two parts, a payment voided, and the bank-reconciliation candidate;
  - **cash:**
    - the opening, a balance taken, a transfer;
    - below the minimum raising and resolving the alert;
    - a statement by last digits becoming the anchor;
    - a voided transfer;
    - the 13 weeks with a supplier bill;
  - **benchmarking:**
    - five sites, with the outlier flagged good;
    - margin from the energy rate, collection days, utilisation;
    - owners grouped.
- **Database:**
  - the least-privilege pins cover the eight new tables;
  - the 097 rollback was checked.
- **Console:** the four tabs were checked in light and dark mode and at phone width, with no page errors.

**To confirm before live use:**
- **Asset policy:** the lives, residual values and methods per category, with your accountant.
- **Journal account codes:** against your chart of accounts.
- **PPh 23:** the rate per supplier.
- **Opening balances:** each account's opening balance and the date it is from.
