# PlugSure CSMS v1.30.0: release notes

**Date:** 1 November 2026
**Base:** v1.29.0.

v1.30.0 is phase 19 of the finance work:
- purchase orders with goods received and the three-way match;
- lease accounting under PSAK 73;
- treasury, with time deposits and idle-cash suggestions;
- a finance anomaly review.

- **Migration:** one, 098. It adds seven tables, three settings columns and a column on supplier bills. It is additive.
- **When nothing changes:** nothing changes until orders, leases or deposits are recorded. The anomaly checks start finding things on their first daily run.
- **Guide:** `deploy/FINANCE.md`, *Orders, leases, treasury and review*.

## New

### Purchase orders and the three-way match

The new Finance → **Orders** tab.

**Raising an order:**
- An order goes to a supplier, with lines (description, quantity, unit price), a site, a currency and an expected date.
- Orders are numbered PO-00001….
- An order can be saved as a draft or submitted.

**Approval:**
- An order is approved by a second person, never the one who submitted it.
- The approvals matrix has a new **Purchase orders** row: a Finance Manager, or two approvers, above an amount.
- An order can be rejected with a reason.
- It can be cancelled while nothing has been received or billed, and closed when it is done.

**Receiving:** goods or work are received per line, with a date and a note, and never more than was ordered.

**The match:**
- A supplier bill names its order. The order must be to the same supplier, in the same currency, and approved.
- The match compares what was **ordered**, what was **received** (quantity received × unit price) and what was **billed** on the order, with a tolerance (default 2%, set by a Finance Manager). The result is:

| Match | Meaning |
|---|---|
| Matched | Billed is no more than received, within the tolerance. |
| Nothing received | Nothing has been received on the order yet. |
| Over billed | Billed is above what was received. |
| Over ordered | Billed is above what was ordered. |

- A bill that does not match can be approved only by a Finance Manager. The approval records `matchOverridden`.

**Commitments:** approved orders not yet billed in full, per currency and supplier.

### Lease accounting (PSAK 73)

The new Finance → **Leases** tab is for leases the operator holds: a site's land or parking bays, a transformer, a vehicle.

**Terms:**
- the payment;
- its frequency (monthly, quarterly or yearly);
- its timing (in advance or in arrears);
- the term and the start month;
- the borrowing rate;
- initial direct costs.

**Recognition:**
- The **lease liability** is the payments discounted at the monthly rate, (1 + rate)^(1/12) − 1.
- The **right-of-use asset** is the liability plus the initial direct costs.

**Each month:**
- Interest accrues on the liability. In advance, it is charged after the month's payment.
- The payment reduces the liability.
- The asset is depreciated straight-line.
- The last month takes the rounding, so the liability ends at 0.

**Position:** the liability as of any month, split into current (the next 12 months' reduction) and non-current, and the asset's net book value.

**Exempt leases:** leases of 12 months or less are short-term, and low-value leases can be marked as such. They are expensed straight-line instead.

**Ending early:** the liability left and the asset's net book value are derecognised, with the gain or loss.

**The month's journal**, per currency:

| Event | Debit | Credit |
|---|---|---|
| Recognition | Right-of-use asset | Lease liability |
| Depreciation | ROU depreciation | Accumulated ROU depreciation |
| Interest | Lease interest | Lease liability |
| Payment | Lease liability | Bank |
| Exempt lease: expense | Lease expense | Accrued lease |
| Exempt lease: payment | Accrued lease | Bank |
| Early end | Liability; accumulated depreciation | ROU asset; and the gain or loss |

*Record the month* keeps it once the month has ended. A recorded lease can be ended but not voided. Locked months are respected.

**Elsewhere:** lease payments appear as money going out in Cash → the next 13 weeks. Excel export.

### Treasury

The new Finance → **Treasury** tab is for time deposits.

**Placing a deposit:**
- From one of the operator's bank accounts (Cash): the bank, the bilyet reference, the principal and the rate a year.
- The term: a maturity date, months or days.
- The final tax on the interest (PPh final, default 20%).
- The cash position counts the money out of the account, and shows deposits beside the total.

**Interest** accrues actual/365: gross, tax and net, to today and at maturity.

**Closing a deposit:**
- **Matured:** the interest received (by default the expected net) goes back into the account. It can be rolled over into a new deposit, with or without the interest.
- **Broken early:** with the interest received and any penalty.

**Idle cash:** per currency, what could be placed. It is the 13-week view's lowest point above the accounts' minimums and a buffer, rounded down. The suggestion gives a term and the net interest it would earn at an indicative rate.

**Elsewhere:**
- Maturities appear as money coming in in the 13-week view.
- `finance.deposit_maturing` is raised for a deposit maturing within 7 days or past maturity (checked daily). It is resolved when the deposit is closed.
- Excel export.

### Finance anomaly review

The new Finance → **Review** tab. Checks run over the last 90 days, daily and on demand:

| Check | Finds | Severity |
|---|---|---|
| Duplicate bill | Two bills from one supplier, same subtotal, within 14 days, different numbers | warning |
| Duplicate payment | Two payments on one bill, same amount, same day | critical |
| Round amount | A supplier payment that is a multiple of 1 000 000, at or above 10 000 000 | info |
| Large bill from a new supplier | A bill of 50 000 000 or more within 30 days of the supplier being added | warning |
| Split bills | Bills from one supplier on one day, each below the matrix's supplier-bill amount, together above it | warning |
| Out of hours | Bills, payments, transfers, balances and deposits entered at weekends or 22:00–06:00 | info |

**Reviewing a finding:**
- **Dismiss** it (it is fine) or **confirm** it (it needs action), with a note. Confirming raises `finance.anomaly_confirmed`.
- A finding whose condition is gone is cleared.
- A reviewed finding keeps its review when it is found again.

**Settings:** a Finance Manager sets the thresholds and can turn checks off one by one.

### API

Twenty-six new operations (572 in all):

| Operation | Permission |
|---|---|
| `GET /v1/finance/purchase-orders` | `payment:read` |
| `POST /v1/finance/purchase-orders` | `payment:write`, audited |
| `PUT /v1/finance/purchase-orders/settings` | `finance:approve`, audited |
| `GET /v1/finance/purchase-orders/{id}` | `payment:read` |
| `POST /v1/finance/purchase-orders/{id}/submit` | `payment:write`, audited |
| `POST /v1/finance/purchase-orders/{id}/approve` | `payment:write` and the approvals matrix, audited |
| `POST /v1/finance/purchase-orders/{id}/reject` | `payment:write`, audited |
| `POST /v1/finance/purchase-orders/{id}/cancel` | `payment:write`, audited |
| `POST /v1/finance/purchase-orders/{id}/close` | `payment:write`, audited |
| `POST /v1/finance/purchase-orders/{id}/receipts` | `payment:write`, audited |
| `GET /v1/finance/leases` | `payment:read` |
| `POST /v1/finance/leases` | `payment:write`, audited |
| `GET /v1/finance/leases/journal` | `payment:read` |
| `POST /v1/finance/leases/journal/{month}/record` | `payment:write`, audited |
| `GET /v1/finance/leases/{id}` | `payment:read` |
| `POST /v1/finance/leases/{id}/end` | `payment:write`, audited |
| `POST /v1/finance/leases/{id}/void` | `payment:write`, audited |
| `GET /v1/finance/treasury` | `payment:read` |
| `PUT /v1/finance/treasury/settings` | `payment:write`, audited |
| `POST /v1/finance/treasury/deposits` | `payment:write`, audited |
| `GET /v1/finance/treasury/deposits/{id}` | `payment:read` |
| `POST /v1/finance/treasury/deposits/{id}/close` | `payment:write`, audited |
| `GET /v1/finance/checks` | `payment:read` |
| `POST /v1/finance/checks/run` | `payment:write` |
| `PUT /v1/finance/checks/settings` | `finance:approve`, audited |
| `POST /v1/finance/checks/{id}/review` | `payment:write`, audited |

Changes to existing operations:
- `POST /v1/finance/bills` accepts `purchaseOrderId`.
- `GET /v1/finance/bills/{id}` includes the match.
- `GET /v1/finance/cash` includes deposits per currency.
- The approvals matrix accepts the kind `purchase_order`.

New workers, both daily:
- `deposits-maturing`;
- `finance-checks`.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **098**:
   - `purchase_order`, `purchase_order_line`, `goods_receipt`, `lease`, `lease_run`, `deposit` and `finance_check_finding`, with row-level security and no DELETE for the runtime role;
   - `supplier_bill.purchase_order_id`;
   - the procurement, treasury and checks settings.
2. Optionally:
   - record the site leases and the deposits;
   - set the purchase-order row of the approvals matrix and the match tolerance;
   - review the anomaly checks' first findings;
   - route `finance.deposit_maturing` and `finance.anomaly_confirmed`.

**Rollback:**
1. Roll the code back to v1.29.0.
2. Export the orders, leases and deposits.
3. Run `db/rollback/098_down.sql`. Supplier bills stay, without their order.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 6 of them new. They cover:
  - **lease maths:**
    - the liability as the discounted payments;
    - interest in advance charged after the payment;
    - total interest equal to payments minus the liability;
    - the liability ending at 0;
    - depreciation adding up to the asset;
    - a short-term lease expensed;
    - current and non-current adding up;
  - **deposit maths:**
    - interest actual/365 with the final tax;
    - idle cash above the minimums and the buffer;
  - **purchase orders:**
    - approval by a second person;
    - receiving in parts, and never more than ordered;
    - a cancel refused after a receipt;
    - a bill naming another supplier's order refused;
    - an over-billed bill refused without finance:approve, then matched once the rest arrives;
    - commitments emptied, and the order closed;
  - **leases:**
    - recognition balanced in the start month;
    - the month's journal with an exempt lease;
    - recorded, after which void is refused;
    - current and non-current;
    - an early end with its derecognition, balanced;
  - **treasury:**
    - a deposit out of the account and into the deposits total;
    - accrued interest;
    - broken with interest and a penalty, and back in the account;
    - the maturing alert raised and resolved;
    - the maturity in the 13-week view;
    - idle cash;
  - **anomaly review:**
    - duplicate bill, duplicate payment, round amount and new-supplier findings;
    - a dismissed finding, and a confirmed one raising its alert;
    - a voided duplicate clearing its finding, while reviews are kept;
    - checks turned off.
- **Database:**
  - the least-privilege pins cover the seven new tables;
  - the 098 rollback was checked.
- **Console:** the four tabs and the order drawer were checked in light and dark mode and at phone width, with no page errors.

**To confirm before live use:**
- **Borrowing rate and lease terms:** with your accountant, including which leases are short-term or low value.
- **Journal account codes:** the lease journal's codes against your chart of accounts (fixed for now: 1650, 1659, 2400, 2410, 6410, 6420, 7200, 7100, 8100, 1100; listed in `GET /v1/finance/leases` as accounts).
- **Match tolerance:** the three-way match tolerance.
- **Anomaly thresholds:** the anomaly checks' thresholds.
