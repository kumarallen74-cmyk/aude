# PlugSure CSMS v1.33.0: release notes

**Date:** 1 November 2026
**Base:** v1.32.0.

v1.33.0 is phase 22 of the finance work:
- payroll;
- customer credit and security deposits;
- capex projects;
- a cash forecast that learns from the charging history.

- **Migration:** one, 101. It adds seven tables, three fleet account columns, a project link on orders, bills and assets, two settings columns and three ledger sources. It is additive.
- **When nothing changes:** nothing changes until employees, reviews, deposits or projects are recorded. The cash forecast is computed on demand and stored daily.
- **Guide:** `deploy/FINANCE.md`, *Payroll, credit, capex projects and the cash forecast*.

## New

### Payroll

The new Finance → **Payroll** tab.

**Employees:** each has:
- salary and fixed allowances;
- PTKP status, NIK and NPWP;
- BPJS Kesehatan and Ketenagakerjaan, with the JKK rate;
- the bank account, sealed;
- a start date and an end date.

They are numbered EMP-0001….

**A month's run** in a currency has one line per employee in service. Each line takes overtime, a bonus and other deductions.

**BPJS:**

| Programme | Employer | Employee | Base |
|---|---|---|---|
| Kesehatan | 4% | 1% | salary and fixed allowances, capped (default 12 million) |
| JHT | 3.7% | 2% | salary and fixed allowances |
| JP | 2% | 1% | capped (default 10 547 400) |
| JKK | the employee's rate (0.24–1.74%) | — | |
| JKM | 0.3% | — | |

**PPh 21** (PP 58/2023, PMK 168/2023):
- **January to November:** the TER rate of the employee's category on the month's gross. The categories are A (TK/0, TK/1, K/0), B (TK/2, TK/3, K/1, K/2) and C (K/3). The gross is the salary, allowances, overtime and bonus, plus the employer's JKK, JKM and Kesehatan.
- **December, and a leaver's last month:** the year's tax at the Pasal 17 rates, less what was withheld earlier in the year. The tax is on the year's gross less the occupational cost (5%, at most 6 million a year), less the employee's JHT and JP, less the PTKP, rounded down to the thousand.
- **No tax id:** 20% more without an NPWP or NIK.
- **Settings:** a Finance Manager can replace the TER tables and the caps.

**Approval and payment:**
- Submitted, then approved by a second person under the approvals matrix (new row: **Payroll runs**).
- Recorded as paid from a cash account on a day.
- Voided while not paid.

**Files:** payslips (PDF), the bank transfer list (CSV with the unsealed account numbers; `payment:write`, audited) and Excel.

**Elsewhere:**
- **Ledger:** salaries (6100) and the employer's BPJS (6105) against net pay (2170), PPh 21 (2151), BPJS payable (2180) and other deductions (2190); the payment against the bank.
- **Cash position:** counts the payment.
- **Scorecard:** operating costs include the payroll.

### Customer credit and security deposits

The new Finance → **Credit** tab, for fleet customers.

**Score:** 0–100, from the last 12 months of invoices in the account's credit currency:
- the share paid late;
- the average days late;
- what is overdue now, and for how long;
- how much of the limit is used;
- how long the customer has been billed.

A security deposit softens it.

**Grades and suggested limits:** A (85+), B (70+), C (55+), D (40+) or E. The suggested limit is the average monthly billing of the last six months times the grade's multiple, plus the deposit, rounded to the 100 000:

| Grade | Multiple |
|---|---|
| A | 3 |
| B | 2 |
| C | 1.5 |
| D | 1 |
| E | 0 |

**Reviews:**
- One open review per account, with the score, the reasons and the suggestion.
- A Finance Manager approves it or rejects it with a note.
- Approving sets:
  - the new limit;
  - a hold, or its release;
  - the next review date (default 6 months for A and B, 3 for C, 1 for D and E).
- Accounts due for review get a review opened daily, with `finance.credit_review_due`.

**Hold:** blocks the account's cards, whatever its credit mode, until released. It uses the credit check of v1.24.0.

**Security deposits:**
- **Received:** into a cash account.
- **Applied:** to an issued invoice, for its whole amount; the invoice is then paid.
- **Returned:** at most what is held.
- **Voiding:** an entry can be voided with a reason, except an applied one.
- **Ledger:** deposits are held on 2200; an applied deposit becomes fleet revenue (4200).
- **Cash position:** counts the deposits received and returned.

### Capex projects

The new Finance → **Projects** tab: building a site as one project, numbered CP-0001….
- **Setup:** budget by category, site, currency, start and target dates; planned, then active.
- **Linking:** purchase orders and supplier bills are linked, in the project's currency.
- **Figures:**
  - committed: approved orders not yet billed;
  - actual: approved and paid bills;
  - forecast: actual plus committed, with the variance against the budget, in all and per category.
- **Over budget:** `finance.capex_over_budget` when the forecast is above the budget (checked daily, resolved when it no longer is).
- **Ledger while open:** bills on a project post to **assets under construction (1610)**, not to expense.
- **Complete:** every bill must be approved. The cost, less bills capitalised on their own, becomes one asset in the register (category, life, month in service), linked to the project. The ledger moves it from 1610 to 1600.
- **Cancel:** with a reason; the ledger writes what was spent off (8300).

### Cash forecast

The new Finance → **Cash forecast** tab: the cash position day by day for 30 to 180 days, per currency.

| Part | What it is |
|---|---|
| Committed | the 13-week view's flows: gateway settlements, fleet invoices, owner shares, supplier bills, leases, deposits |
| Learnt | the money charging brings in, learnt from 180 days of charge records: each weekday's share (last 12 weeks), and a level and trend (Holt's double exponential smoothing). The pessimistic and optimistic lines are ±1.28 standard deviations of the one-day-ahead errors (about 80%), widening with the horizon. |
| Payroll | the last run's net pay on the 25th of each month not yet paid |
| Capex | open projects' commitments and remaining budget, spread weekly to their target dates |

**Scenarios:** collections at a percentage, supplier bills paid N days later, capex in or out. They can be saved as the default.

**Results:** the lowest point, and the first day below the accounts' minimums, expected and pessimistic.

**Stored daily:** the worker stores each day's forecast. The forecast's accuracy is the weighted absolute percentage error of the collections over the last 30 days. `finance.cash_forecast_shortfall` is raised when the expected position goes below the minimum: critical within 14 days, a warning otherwise.

### API

Thirty-one new operations (668 in all):

| Operation | Permission |
|---|---|
| `GET /v1/finance/payroll` | `payment:read` |
| `PUT /v1/finance/payroll/settings` | `finance:approve`, audited |
| `POST /v1/finance/payroll/employees` | `payment:write`, audited |
| `PUT /v1/finance/payroll/employees/{id}` | `payment:write`, audited |
| `POST /v1/finance/payroll/runs` | `payment:write`, audited |
| `GET /v1/finance/payroll/runs/{id}` (`format=xlsx`; `transfers` with `payment:write`, audited) | `payment:read` |
| `PUT /v1/finance/payroll/runs/{id}/lines/{lid}` | `payment:write` |
| `GET /v1/finance/payroll/runs/{id}/payslips/{lid}` | `payment:read` |
| `POST /v1/finance/payroll/runs/{id}/submit`, `/approve`, `/pay`, `/void` | `payment:write` and the approvals matrix, audited |
| `GET /v1/finance/credit` | `payment:read` |
| `GET /v1/finance/credit/accounts/{id}` | `payment:read` |
| `POST /v1/finance/credit/accounts/{id}/reviews` | `payment:write`, audited |
| `POST /v1/finance/credit/reviews/{id}/decide` | `finance:approve`, audited |
| `POST /v1/finance/credit/accounts/{id}/hold` | `finance:approve`, audited |
| `GET /v1/finance/customer-deposits` | `payment:read` |
| `POST /v1/finance/credit/accounts/{id}/deposits` | `payment:write`, audited |
| `POST /v1/finance/customer-deposits/{id}/void` | `payment:write`, audited |
| `GET /v1/finance/projects` (`format=xlsx`) | `payment:read` |
| `POST /v1/finance/projects` | `payment:write`, audited |
| `POST /v1/finance/projects/unlink` | `payment:write`, audited |
| `GET /v1/finance/projects/{id}` | `payment:read` |
| `PUT /v1/finance/projects/{id}` | `payment:write`, audited |
| `POST /v1/finance/projects/{id}/link`, `/complete`, `/cancel` | `payment:write`, audited |
| `GET /v1/finance/cash-forecast` | `payment:read` |
| `PUT /v1/finance/cash-forecast/settings` | `payment:write`, audited |
| `POST /v1/finance/cash-forecast/snapshot` | `payment:write` |

The approvals matrix accepts the kind `payroll_run`. The ledger has three new sources (payroll, customer deposits, projects) and new accounts 1610, 2170, 2180, 2190, 2200, 4200, 6100, 6105 and 8300.

New workers:
- `credit-reviews`, daily;
- `capex-budget`, daily;
- `cash-forecast`, every 6 hours (stores once a day).

## Upgrading

1. Deploy and run `npm run migrate`. This applies **101**:
   - `employee`, `payroll_run`, `payroll_line`, `credit_review`, `customer_deposit`, `capex_project` and `cash_forecast_run`, with row-level security and no DELETE for the runtime role;
   - the fleet account's hold and next review date;
   - `capex_project_id` on purchase orders, supplier bills and fixed assets;
   - the payroll and cash forecast settings;
   - the ledger's new sources.
2. Before the first payroll:
   - have a tax adviser confirm the TER tables and the BPJS caps;
   - add the employees;
   - set the approvals matrix's payroll row.
3. Optionally:
   - review each fleet customer once;
   - set up the capex projects;
   - set the forecast's horizon;
   - route the three new alerts.

**Rollback:**
1. Roll the code back to v1.32.0.
2. Export the payroll runs, reviews, deposits and projects.
3. Run `db/rollback/101_down.sql`.

Assets capitalised from projects stay in the register.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 7 of them new. They cover:
  - **payroll helpers:**
    - PTKP;
    - the TER categories and bands;
    - BPJS with the caps;
    - a month's gross, PPh 21 and net;
    - 20% more without a tax id;
    - December's annual calculation;
  - **credit helpers:** the score and grade of a good and a bad payer, and the suggested limit;
  - **forecast helper:** the weekday pattern, the trend, the band and the fit error on a synthetic series;
  - **payroll:**
    - an employee with a sealed account;
    - a leaver left out;
    - a line adjusted;
    - not approved by the submitter;
    - the transfer list, paid, not voidable once paid;
    - the payslip and Excel;
    - the cash position;
    - the ledger (salaries, employer BPJS, PPh 21 and BPJS payable; net pay cleared);
  - **credit:**
    - the factors from six months of invoices;
    - a review graded and decided by a Finance Manager only, with the limit, a hold (a note needed) and the next review;
    - the hold released;
    - a deposit received, applied to an invoice (paid), the rest returned;
    - the cash position and the ledger (fleet revenue 4200, deposits cleared);
  - **capex:**
    - the budget, a purchase order committed and a bill actual;
    - over budget, with the alert;
    - assets under construction in the ledger, not expense;
    - completed into an asset (1610 to 1600);
    - a completed project's links frozen;
    - a cancelled project written off (8300);
    - the trial balance balancing;
  - **cash forecast:**
    - the horizon;
    - no history said so;
    - payroll in the flows;
    - capex left out raising the closing;
    - the first day's arithmetic;
    - the settings checked;
    - a snapshot stored.
- **Database:**
  - the least-privilege pins cover the seven new tables;
  - the 101 rollback was checked.
- **Console:** the four tabs were checked in light and dark mode and at phone width, with no page errors.

**To confirm before live use:**
- **TER tables:** confirm them against the PP 58/2023 annex.
- **BPJS caps:** the JP cap changes every year; confirm the Kesehatan cap.
- **JKK rate:** each employee's rate, by the work's risk group.
- **December calculation:** the annual method, for employees who joined during the year.
- **Credit scoring:** the weights and the limit multiples suit your customers.
- **Cash forecast:** it learns from charge records (money charged), not settlements; read it together with the gateway's settlement delay.
