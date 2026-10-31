# PlugSure CSMS v1.22.0: release notes

**Date:** 31 October 2026
**Base:** v1.21.0.

v1.22.0 is phase 11 of the finance work: locking closed months, site investments with payback, revenue drop alerts, and statements of account for fleet customers.

- **Migration:** one, 090 (four new tables, two columns; additive).
- **When nothing changes:** until a month is locked, an investment recorded, or revenue alerts or automatic statements turned on.
- **Guide:** `deploy/FINANCE.md`, *Month lock, investments, revenue alerts and statements of account*.

## New

### Month lock

Finance → **Close** lists the last 24 months.

- **Lock:** once the accountant has closed a month, lock it (*Close & lock…*, with an optional note). Only a month that has ended can be locked.
- **What it stops:** entries dated in the month can no longer be added, changed or voided (the API answers 409):
  - energy bills (Margin);
  - exchange rates, typed or fetched (Settings → Currencies);
  - budgets, saved or copied into it;
  - site investments.
- **Checklist:** before locking, the dialog shows what is still open. That is:
  - sites with sessions but no energy bill (their margin is an estimate);
  - currencies with no rate into the reporting currency;
  - bank statement lines not matched.
- **Reopen:** needs a Finance Manager (`finance:approve`) and a reason. Each lock keeps who closed it, and who reopened it and why. A month can be locked again.

### Site investments and payback

Finance → **Investments**: record what a site cost to build. Each investment has:

- a category: chargers, installation, grid connection or other;
- the amount, in the site's currency;
- the date it was paid;
- the months it is depreciated over (default 96).

Per site, Finance then shows:

- **Invested**, by category.
- **Depreciation:** straight line, from the month after payment. The last month takes the rounding. Shown per month, accumulated, and as the net book value.
- **Margin recovered:** revenue − energy cost since the first investment, and the share of the investment it covers. Months with no known energy cost are counted.
- **Payback:** the month the margin covered the investment. If it hasn't yet, the month it will at the last 6 months' average margin, marked as an estimate.
- **ROI:** a year's margin at that average, less a year's depreciation, ÷ invested.

### Revenue drop alerts

Turn them on in Finance → **Settings → Revenue drop alerts**.

- **The check:** each morning, every site's revenue yesterday is compared with its baseline: the average of the same weekday over the 4 weeks before.
- **The alert:** a fall by the threshold (default 50%) or more is recorded, and raises a warning alert, `finance.revenue_drop`, on the site. It points to a charger down, a payment method failing, or a tariff typed wrong.
- **Clearing:** the alert clears on the first day the site is back.
- **Skipped sites:** a site isn't compared if fewer than 3 of the 4 weeks had revenue, or if its baseline is under the minimum set.
- **The list:** the last 90 days' drops are listed under the setting.

### Fleet statements of account

In a fleet account's drawer (Fleet billing → Accounts), the new **Statement** tab shows the month in each currency:

- the opening balance;
- invoices, credit notes, payments and refunds, with the running balance;
- the closing balance;
- the invoices still open at month end, with days past due.

How each movement counts:

- **Void invoices** are left out.
- **A credit note** counts once, when it is issued, however it is settled.
- **A payment** is what was left on the invoice when it was marked paid.

Delivery:

- **Download:** as a PDF or as Excel.
- **E-mail:** to the billing address, with the PDF attached, through the e-mail channel.
- **Automatic:** in Fleet billing → **Settings → Statements of account**, choose a day of the month (1–28). On that day, every account with a billing address that had movements or owes something is e-mailed its statement for the month just ended, once. A failed send is retried up to 3 times.
- **Log:** every send is logged, automatic or by hand, with the closing balance.

### API

Sixteen new operations (434 in all):

| Operation | Permission |
|---|---|
| `GET /v1/finance/periods` | `payment:read` |
| `GET /v1/finance/periods/{month}/checklist` | `payment:read` |
| `POST /v1/finance/periods/{month}/lock` | `payment:write`, audited |
| `POST /v1/finance/periods/{month}/reopen` | `payment:write` + `finance:approve`, audited |
| `GET /v1/finance/investments` | `payment:read` |
| `POST /v1/finance/investments` | `payment:write`, audited |
| `POST /v1/finance/investments/{iid}/void` | `payment:write`, audited |
| `GET /v1/finance/revenue-alerts` | `payment:read` |
| `PUT /v1/finance/revenue-alerts/settings` | `payment:write`, audited |
| `POST /v1/finance/revenue-alerts/check` | `payment:write` |
| `GET /v1/fleet-accounts/{id}/account-statement` | `invoice:read` |
| `GET /v1/fleet-accounts/{id}/account-statement.pdf` | `invoice:read` |
| `GET /v1/fleet-accounts/{id}/account-statement.xlsx` | `invoice:read` |
| `POST /v1/fleet-accounts/{id}/account-statement/send` | `invoice:write`, audited |
| `GET /v1/fleet-account-statements` | `invoice:read` |
| `PUT /v1/fleet-account-statements/settings` | `invoice:write`, audited |

Other changes:
- The energy bill, budget, exchange rate and investment endpoints answer **409** for a locked month.
- Two new workers: `finance-revenue-drops` (every 3 hours, for yesterday) and `fleet-statements` (hourly).

## Fixed

- **Hub test:** an intermittent failure in the CI hub suite is fixed (*the tenant answers through the hub with the routing headers swapped*). `pushAgreementChange` starts its own outbox pass. That pass could hold the ClientInfo row, and the test's own delivery calls then returned at once. The test now waits until the ClientInfo is delivered.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **090**:
   - `finance_period_lock`, `site_investment`, `revenue_anomaly` and `fleet_statement_send`, with row-level security and no DELETE for the runtime role;
   - `revenue_alerts` and `fleet_statements` on the finance settings.
2. Optionally:
   - lock the months already closed;
   - record site investments;
   - turn on revenue drop alerts, and route `finance.revenue_drop` (Govern → Alert routing);
   - turn on automatic statements of account.

**Rollback:** roll the code back to v1.21.0, then run `db/rollback/090_down.sql`. Month locks, investments, the drops found and the statement log are dropped.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 5 of them new. They cover:
  - depreciation, including the rounding;
  - the month lock: only an ended month; each entry kind refused; reopening needs a Finance Manager and a reason; locked again;
  - investments: net book value, margin recovered, payback, ROI, a void;
  - revenue drops: found, alerted once, and cleared;
  - statements of account: the running balance, open invoices, PDF, Excel, an e-mail through a fake SMTP server, the automatic send once.
- **Database:** the least-privilege pins cover the four new tables, and the 090 rollback was checked.

**To confirm before live use:**
- The depreciation period your accountant uses for chargers and installation.
- The drop threshold that suits your quietest sites.
