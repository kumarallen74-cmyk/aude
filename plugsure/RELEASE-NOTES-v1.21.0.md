# PlugSure CSMS v1.21.0: release notes

**Date:** 31 October 2026
**Base:** v1.20.0.

v1.21.0 is phase 10 of the finance work: a summary of the key figures, scheduled report e-mails, consolidation across currencies, and an approvals matrix with a Finance Manager role.

- **Migration:** one, 089 (two new tables, ten columns; additive).
- **When nothing changes:** until a reporting currency, approval rules or report schedules are set. Summary shows at once. Existing approvals keep the second-person rule.
- **Guide:** `deploy/FINANCE.md`, *Summary, currencies, approvals and report e-mails*.

## New

### Summary

Finance → **Summary** (the first tab) shows these figures for each currency:

- **Revenue this month:** compared with last month to the same day, and with the same month last year.
- **Margin.**
- **Owed by customers, and DSO:** days sales outstanding, which is what customers owe ÷ the last 90 days' revenue per day.
- **Cash:** gateway balances plus the last bank statement.
- **Last 30 days:** the fee rate and the refund rate.
- **Energy this month.**
- **Trends:** 12-month lines for revenue and margin.

With a reporting currency set, revenue, margin and receivables are also shown consolidated into it.

### Multi-currency consolidation

For operators with sites in several currencies (IDR, MYR, SGD), set the reporting currency in Finance → **Settings → Currencies**.

- **Rates:** set a rate per month for each other currency. Enter it by hand, or fetch the ECB reference rate (frankfurter API; `FX_RATES_URL` to change it).
- **Where it shows:** Summary, Margin and Budgets add consolidated totals.
- **Missing rates:** a currency without a rate for the month is listed, never counted at 1 or left out silently.

### Approvals matrix and Finance Manager

- **New permission:** `finance:approve`. It is held by:
  - the new **Finance Manager** role (finance, no fleet control);
  - organisation owners;
  - super administrators.
- **Rules:** in Finance → **Settings → Approvals**, for refunds, owner payouts, write-offs and owner bank-detail changes, require one of these above an amount:
  - **A Finance Manager:** the approver must hold `finance:approve`.
  - **Two approvers:** two different people, neither the requester. The first approval is recorded and shown as *1 of 2 approved*. The second sends the transfer, or completes the write-off or change.
- **Who sets them:** only someone with `finance:approve` can change the matrix.
- **Audit:** first approvals are audited separately (`…_first_approval`).

### Report e-mails

In Finance → **Settings → Report e-mails**, schedule chosen reports as one Excel workbook, through your e-mail channel, to up to 10 recipients:

- **Reports:** summary, margin, collections, budgets, and a 30-day forecast.
- **Weekly:** on the chosen weekday from 07:00.
- **Monthly:** on the 1st, covering the month just ended.
- **Once per period:** each schedule is sent once per week or month. A failure is shown and retried hourly.
- **Send now:** sends one at once.

The monthly close e-mail (v1.17.0) is unchanged.

### API

Eleven new operations (418 in all):

| Operation | Permission |
|---|---|
| `GET /v1/finance/summary` | `payment:read` |
| `GET /v1/finance/fx-rates` | `payment:read` |
| `PUT /v1/finance/fx-rates/reporting-currency` | `payment:write`, audited |
| `PUT /v1/finance/fx-rates` | `payment:write`, audited |
| `POST /v1/finance/fx-rates/fetch` | `payment:write`, audited |
| `GET /v1/finance/approval-rules` | `payment:read` |
| `PUT /v1/finance/approval-rules` | `payment:write` + `finance:approve`, audited |
| `GET /v1/finance/report-schedules` | `payment:read` |
| `POST /v1/finance/report-schedules` | `payment:write`, audited |
| `PUT /v1/finance/report-schedules/{rid}` | `payment:write`, audited |
| `POST /v1/finance/report-schedules/{rid}/send` | `payment:write`, audited |

Other changes:
- Transfers, write-offs and bank change requests gain `firstApprovedBy`.
- Their approve endpoints may answer with the item still waiting, after a first approval.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **089**:
   - `fx_rate` and `finance_report_schedule`, with row-level security and no DELETE for the runtime role;
   - `reporting_currency` and `approval_rules` on the finance settings;
   - `first_approved_by` / `_at` on transfers, write-offs and bank change requests.

   The roles update at start-up (Finance Manager, `finance:approve`).
2. Optionally:
   - give your finance lead the Finance Manager role;
   - set the approvals matrix;
   - set a reporting currency and rates;
   - schedule report e-mails.

**Rollback:** roll the code back to v1.20.0, then run `db/rollback/089_down.sql`. First approvals on items still waiting are dropped; they then need a full approval again.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 5 of them new. They cover:
  - the matrix: only `finance:approve` sets it; two approvers, where the same person can't approve twice; a Finance Manager for bank changes;
  - currencies: a manual rate, fetching from a fake ECB, consolidated totals, a currency without a rate listed;
  - the summary: revenue, receivables and DSO, margin, consolidated totals;
  - report e-mails: validation, when a schedule is due, sending through a fake SMTP server, once per period.
- **Database:** the least-privilege pins cover the two new tables, and the 089 rollback was checked.
- **Console:** Summary and the new Settings cards were checked in light and dark themes and at 390 px.

**To confirm before live use:**
- The rate source your accountant books with (ECB or Bank Indonesia), and whether to enter rates by hand.
- Who gets the Finance Manager role.
