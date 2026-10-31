# PlugSure CSMS v1.19.0: release notes

**Date:** 31 October 2026
**Base:** v1.18.0.

v1.19.0 is phase 8 of the finance work: a cash-flow forecast, a gateway fee audit against the contracted rates, accounting software exports, and payouts and bank details in the Site Owner portal.

- **Migration:** one, 087 (two new tables, two columns; additive).
- **When nothing changes:** until contracted rates are entered, a month is exported, or an owner sends a bank change. The Forecast tab and the owner's Payouts page show at once.
- **Guide:** `deploy/FINANCE.md`, *Forecast, fee audit, accounting export and the owner portal*.

## New

### Cash-flow forecast

Finance → **Forecast** shows the next 30, 60 or 90 days:

- **Opening position:** the gateway's last balance plus the bank balance on the last uploaded statement. A part that is unknown is said so.
- **In:** settlements the gateway expects, fleet invoices, Hub positions and post-pay sessions.
- **Out:** refunds due, owners' shares and PlugSure's statements not paid in full. Their due date is finalisation plus the payment terms, 14 days by default and adjustable.
- **Result:** the running position by day, a chart, and the **first shortfall**. Optionally, the last 28 days' collection rate is added, labelled an estimate. Exportable as CSV.

### Gateway fee audit

Enter the rates agreed with the gateway in **Finance → Settings → Contracted rates**, per method: a percentage, a fixed fee, a minimum, and an amount up to which the method is free (QRIS: Rp 100,000).

- **Fees → Fee audit** checks every payment's fee against the agreed rate, by month and method.
- It totals the overcharge and lists methods without a rate.
- **Claim (CSV)** lists the overcharged payments with the gateway's own ids, for its account manager.

### Accounting software export

In **Finance → Settings → Accounting software**, choose Jurnal.id, Accurate Online or a generic CSV.

- **Export:** a closed month's journal becomes the package's import file, with your chart of accounts.
- **Log:** each export is recorded, so the last 12 months show which went to the books, when and by whom.
- **Current month:** refused, because it is still moving.

### Owner portal: payouts and bank details

Site Owner users get a **Payouts** page:

- what the operator recorded as paid against each statement, with dates and references, and what is still due;
- the bank account payouts go to, masked;
- **Request a change:** the new number is sealed until the operator approves it under **Finance → Payables → Bank detail changes**. The person who asked cannot approve it, and a rejection carries a reason the owner sees.
- The operator is alerted (`finance.owner_bank_change_requested`). One request waits at a time, and the owner may withdraw it.

### API

Six new operations for operators (390 in all, with 4 for the owner portal, which stay internal):

| Operation | Permission |
|---|---|
| `GET /v1/finance/accounts/{id}/forecast` | `payment:read` |
| `GET /v1/finance/accounts/{id}/fee-audit` | `payment:read` (CSV audited) |
| `GET /v1/finance/accounts/{id}/accounting-exports` | `payment:read` |
| `POST /v1/finance/accounts/{id}/accounting-exports` | `payment:read`, audited |
| `GET /v1/finance/owner-bank-requests` | `payment:read` |
| `POST /v1/finance/owner-bank-requests/{rid}/{decision}` | `payment:write`, audited |

Finance settings gain `contractRates` and `accountingPackage`.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **087**:
   - `contract_rates` and `accounting_package` on `gateway_account_settings`;
   - `owner_bank_change_request` and `accounting_export`, with row-level security and no DELETE for the runtime role.
2. Optionally:
   - enter the contracted rates;
   - choose the accounting package;
   - route `finance.owner_bank_change_requested` to whoever looks after owners.

**Rollback:** roll the code back to v1.18.0, then run `db/rollback/087_down.sql`. This drops the rates, pending owner requests and the export log.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 7 of them new. They cover:
  - the forecast: opening position, flows, terms, shortfall, run rate, CSV;
  - the fee audit: free-up-to, percentage plus fixed, minimum, overcharge by method, unrated methods, CSV;
  - accounting files for each package, with formulas neutralised; closed months only; the log;
  - the owner portal: payouts, masked bank details, the sealed request, one pending at a time, approve and reject, withdraw, operators kept out.
- **Database:** the least-privilege pins cover the two new tables, and the 087 rollback was checked.
- **Console:** Forecast, Fees, Settings, Payables and the owner's Payouts page were checked in light and dark themes and at 390 px.

**To confirm before live use:**
- Jurnal.id's and Accurate's current import templates, against a first test import.
- The contracted rates, from your agreement with the gateway.
