# PlugSure CSMS v1.23.0: release notes

**Date:** 31 October 2026
**Base:** v1.22.0.

v1.23.0 is phase 12 of the finance work: a tax filing calendar, site owners' queries on their statements, cost allocation by site with a site P&L, and gateway settlement tracking.

- **Migration:** one, 091 (four new tables, two columns; additive).
- **When nothing changes:** until obligations are marked filed or reminders turned on, an owner sends a query, a shared cost is entered, or settlements are checked. The Settlements tab works at once from the existing ledger.
- **Guide:** `deploy/FINANCE.md`, *Tax calendar, owner queries, site P&L and settlements*.

## New

### Tax filing calendar

At the top of Finance → **Tax**, each period's monthly obligations are listed, the last 6 periods and the current one:

| Obligation | Default due day |
|---|---|
| Pay PPh 23 withheld | 15th of the following month |
| File SPT Masa PPh Unifikasi | 20th |
| Pay PPN | end of the following month |
| File SPT Masa PPN | end of the following month |
| Upload e-Faktur to Coretax | 15th |

- **Due dates:** a due date on a weekend moves to Monday. Public holidays aren't known.
- **Amounts:** what PlugSure recorded is shown beside each obligation:
  - the PPh 23 withheld (Finance → Tax);
  - the PPN on fleet invoices less credit notes;
  - the fakturs not yet exported.

  The accountant still files the returns.
- **Mark filed:** with the date, the NTPN, BPE or receipt number, and the amount. Each obligation and period is marked once; a mark can be undone with a reason.
- **Settings:** the due days are settings, because the rules change (PMK 81/2024) and an adviser may set earlier dates. Any obligation can be turned off.
- **Reminders** (off by default): `finance.tax_due`, a warning from the reminder days before (default 5), critical once overdue, and cleared when filed.

### Owner statement queries

**The owner's side:** in the Site Owner portal (Payouts), each finalised statement has **Query**. The owner says:

- what the query is about: a site on the statement, or the whole statement;
- what is wrong;
- optionally, the amount they believe they're owed.

At most 5 open queries per statement. The operator is alerted (`finance.owner_dispute`).

**The operator's side:** in Finance → **Payables → Owner queries**, the operator answers with one of:

- **Reject:** the statement stands. The answer says why.
- **Resolve:** explained; nothing changes.
- **Adjust:** an amount the operator owes the owner, or a negative amount the owner owes back.

**Where adjustments go:** an agreed adjustment is added to the owner's share on the **next** statement finalised for that owner and currency. It appears there as its own line, and payouts follow. A finalised statement never changes. The owner sees the answer, and which statement took the adjustment.

### Cost allocation by site and the site P&L

The new Finance → **Site P&L** tab.

**Shared costs:** rent, maintenance contracts, connectivity (SIM cards), insurance, staff, other. Each is:

- an amount per month, from a month until a month or ongoing;
- spread over the currency's sites, or the sites chosen, by kWh, sessions, revenue or equally;
- split equally when the sites had none of the chosen measure that month;
- split in whole units, so the parts add up to the cost.

**Per site and month:** revenue − energy cost (Margin) − its share of the shared costs, by category − depreciation of its investments (Investments) = its **contribution**. Totals are shown per currency.

**Locked months:**

- a cost starting in a locked month can't be recorded;
- a cost counting in a locked month can't be voided, only ended;
- it can't be ended in a way that removes it from a locked month.

### Gateway settlement tracking

The new Finance → **Settlements** tab, per payments account, from the gateway's ledger:

- **Settlements by day:**
  - what the gateway said it would settle (net of fees, VAT and withholding), and what it has marked settled;
  - a day past the grace days (default 2) with payments still pending is **late**.
- **Withdrawals to the bank**, checked against the bank statement lines matched to them (Finance → Bank):
  - **in the bank**;
  - **short:** the bank line is less than the withdrawal;
  - **not in the bank:** the uploaded statements cover the days after it (default 3) and no line was matched;
  - **awaiting the statement**.
- **Alerts:** `finance.settlement_late` and `finance.withdrawal_missing` on the account, cleared when put right. For PlugSure's own account they go to the platform's operations organisations.

### API

Thirteen new operations (447 in all):

| Operation | Permission |
|---|---|
| `GET /v1/finance/tax/calendar` | `payment:read` |
| `PUT /v1/finance/tax/calendar/settings` | `payment:write`, audited |
| `POST /v1/finance/tax/filings` | `payment:write`, audited |
| `POST /v1/finance/tax/filings/{fid}/void` | `payment:write`, audited |
| `GET /v1/finance/owner-queries` | `payment:read` |
| `POST /v1/finance/owner-queries/{qid}/answer` | `payment:write`, audited |
| `GET /v1/finance/shared-costs` | `payment:read` |
| `POST /v1/finance/shared-costs` | `payment:write`, audited |
| `POST /v1/finance/shared-costs/{cid}/end` | `payment:write`, audited |
| `POST /v1/finance/shared-costs/{cid}/void` | `payment:write`, audited |
| `GET /v1/finance/site-pnl` | `payment:read` |
| `GET /v1/finance/accounts/{id}/settlements` | `payment:read` |
| `PUT /v1/finance/settlement-tracking/settings` | `payment:write`, audited |

The owner portal also gains three internal operations: `GET` and `POST /v1/owner-portal/queries`, and `POST /v1/owner-portal/queries/{qid}/withdraw`.

Other changes:
- An owner's statement, draft or finalised, includes `adjustments` and `totals.adjustmentsMinor` when it carries any. Its `ownerShareMinor` includes them.
- Two new workers, each every 6 hours: `finance-tax-calendar` and `finance-settlements`.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **091**:
   - `tax_filing`, `owner_statement_dispute`, `owner_statement_adjustment` and `finance_shared_cost`, with row-level security and no DELETE for the runtime role;
   - `tax_calendar` and `settlement_tracking` on the finance settings.
2. Optionally:
   - check the tax calendar's due days with your adviser, and turn on its reminders;
   - enter shared costs;
   - set the settlement grace days;
   - route the new alerts.

**Rollback:**
1. Roll the code back to v1.22.0.
2. Settle any adjustments not yet on a statement by hand.
3. Run `db/rollback/091_down.sql`.

Statements already finalised keep the adjustments they include.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 6 of them new. They cover:
  - due dates (clamped, weekends), and the split adding up;
  - the calendar: amounts, filing once, undo, reminders raised and cleared;
  - owner queries: the adjustment on the next statement only, a rejection, a withdrawal, the alert;
  - shared costs by kWh and equally, the site P&L, and locked months;
  - settlements: late, settled and upcoming days; withdrawals in the bank, short, missing and awaiting; the alerts.
- **Database:** the least-privilege pins cover the four new tables, and the 091 rollback was checked.

**To confirm before live use:**
- The due days with your tax adviser (PMK 81/2024, and Coretax's dates).
- How shared costs should be spread, per cost.
