# PlugSure CSMS v1.28.0: release notes

**Date:** 1 November 2026
**Base:** v1.27.0.

v1.28.0 is phase 17 of the finance work: driver funds and breakage, group consolidation, a rolling revenue forecast, and payment plans with the bad-debt provision.

- **Migration:** one, 096 (five new tables; three settings columns; additive).
- **When nothing changes:** until breakage is recognised, an elimination recorded, a plan agreed or a provision recorded. The new tabs only read until used.
- **Guide:** `deploy/FINANCE.md`, *Driver funds, group, revenue forecast, plans and provision*.

## New

### Driver funds

The new Finance → **Driver funds** tab: money drivers paid ahead and the operator holds, as a liability per currency.

| | |
|---|---|
| In use | Paid for a charge that has not ended. |
| Unused | Charged less than paid, not refunded: owed to the driver. Balances whose gateway refund window closes within 7 days are flagged. |
| Refund due | Refunds approved, not paid yet. |
| Loyalty | Points outstanding at the programme's point value. |
| Breakage | Unused balances older than the breakage days (default 180), by month of payment. |

- **Recognising breakage:** a Finance Manager recognises a month's breakage, once per month and currency. It moves to revenue and leaves the liability.
- **The month:** collected, used by charging, refunded and breakage recognised, beside the gateway's ledger for the same payments, with any difference.
- **Excel:** the position, the movement and the breakage.

PlugSure has no stored-value top-up product: drivers pay before each charge. This ledger tracks the money that model leaves with the operator.

### Group consolidation

The new Finance → **Group** tab, for a parent organisation and its subsidiaries (`organisation.parent_org_id`), for a month:

- **Per entity:**
  - revenue, energy cost, shared costs, depreciation and contribution;
  - owners' shares and PlugSure's fees on the month's statements;
  - the operating result;
  - sites, sessions and kWh.
- **The group:** added up per currency, less **intercompany eliminations**, and in the parent's reporting currency at its monthly rates, naming any currency without a rate.
- **Eliminations:** recorded (revenue or cost, with a reason) and voidable. Fleet invoices one entity issued to another entity, matched by NPWP, are suggested.
- **Trend:** twelve months of group revenue and result.

A subsidiary, or an organisation without subsidiaries, is told so instead.

### Rolling revenue forecast

The new Finance → **Revenue forecast** tab (the cash-flow Forecast is unchanged). Per site:

- **Model:**
  - a straight line fitted to the last 12 months (flat at the average with fewer than 6 months of history);
  - seasonality once there are 13 months of history;
  - the next 12 months under a scenario: growth % a year, price change %, energy cost change %;
  - energy cost from each site's last 3 months (bills, or its cost per kWh).
- **Budget:** each month against its revenue budget (Budgets). When the next 3 months fall below budget by more than the threshold, `finance.forecast_below_budget` is raised (checked daily) and resolved when they recover.
- **Totals:** per currency. The scenario can be saved as the default.

### Payment plans and the bad-debt provision

The new Finance → **Plans & provision** tab.

**Payment plans** for issued fleet invoices:

- **Agreeing:** the balance in 2–24 instalments, monthly or every 7–92 days, from a first date, with grace days. One active plan per invoice.
- **Payments:** pay the earliest instalments first. When everything is paid, the invoice is marked paid and the plan completed.
- **Reminders:** an e-mail 3 days before each instalment, once.
- **Default:** an instalment unpaid past the grace days defaults the plan (`finance.payment_plan_defaulted`), and the invoice returns to Collections.

**Bad-debt provision:**

- **Calculation:** receivables (Collections) by age bucket × rates. Defaults: current 1%, 1–30 days 5%, 31–60 15%, 61–90 30%, over 90 60%. A Finance Manager sets the rates, older buckets at least as high. An invoice on an active plan counts as current.
- **Recording a month:** stores the provision, the previous one and the movement for the journal (Dr bad-debt expense, Cr allowance; a release the other way). Recording again replaces it.

### API

Sixteen new operations (514 in all):

| Operation | Permission |
|---|---|
| `GET /v1/finance/driver-funds` | `payment:read` |
| `PUT /v1/finance/driver-funds/settings` | `payment:write`, audited |
| `POST /v1/finance/driver-funds/breakage` | `finance:approve`, audited |
| `GET /v1/finance/group` | `payment:read` |
| `GET /v1/finance/group/trend` | `payment:read` |
| `POST /v1/finance/group/eliminations` | `payment:write`, audited |
| `POST /v1/finance/group/eliminations/{id}/void` | `payment:write`, audited |
| `GET /v1/finance/rolling-forecast` | `payment:read` |
| `PUT /v1/finance/rolling-forecast/settings` | `payment:write`, audited |
| `GET /v1/finance/payment-plans` | `invoice:read` |
| `POST /v1/fleet-invoices/{id}/payment-plan` | `invoice:write`, audited |
| `POST /v1/finance/payment-plans/{id}/payments` | `invoice:write`, audited |
| `POST /v1/finance/payment-plans/{id}/cancel` | `invoice:write`, audited |
| `GET /v1/finance/provision` | `payment:read` |
| `PUT /v1/finance/provision/rates` | `finance:approve`, audited |
| `POST /v1/finance/provision/{month}/record` | `payment:write`, audited |

New workers:
- `payment-plans`, every 6 hours: reminders and defaults;
- `finance-forecast-check`, daily.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **096**:
   - `driver_funds_breakage`, `consolidation_elimination`, `payment_plan`, `payment_plan_instalment` and `bad_debt_provision`, with row-level security and no DELETE for the runtime role;
   - the forecast, provision-rate and driver-funds settings.
2. Optionally:
   - set the breakage days, the forecast scenario and the provision rates;
   - for a group, set the subsidiaries' parent organisation;
   - route `finance.forecast_below_budget` and `finance.payment_plan_defaulted`.

**Rollback:**
1. Roll the code back to v1.27.0.
2. Export the breakage, eliminations, plans and provisions.
3. Run `db/rollback/096_down.sql`.

Payments recorded on invoices through plans stay.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 5 of them new. They cover:
  - the forecast's least-squares line and seasonal indexes;
  - driver funds:
    - in use, unused, refund due and breakage from real payment and charge records;
    - breakage recognised once and leaving the liability;
    - the month's movement;
  - group consolidation:
    - a parent and a subsidiary added up, with the parent first;
    - an intercompany fleet invoice suggested by NPWP, eliminated, then voided;
    - a subsidiary told it heads no group;
  - the rolling forecast: a growing site, a price scenario, below budget raising the alert;
  - payment plans and the provision:
    - a plan of 3 instalments paid in two parts marks the invoice paid;
    - a late plan defaults with its alert;
    - the provision by bucket, with a plan counting as current;
    - the rates' order;
    - a month recorded with its movement.
- **Database:** the least-privilege pins cover the five new tables, and the 096 rollback was checked.

**To confirm before live use:**
- The breakage days and the accounting treatment of breakage with your accountant.
- The provision rates against your collection history.
- The group structure (parent and subsidiaries) and the reporting currency's monthly rates.
