# PlugSure CSMS v1.12.0: release notes

**Date:** 31 October 2026
**Base:** v1.11.0.

v1.12.0 adds **Finance** (Commercial → Finance): the payment gateway's side of the money for each Xendit account.

- **What it shows:** what Xendit collected, what it charged in fees and VAT, what it has settled to the bank and what is still to come, refunds and payouts. All of it is matched to PlugSure's own payments, and the differences are flagged.
- **Migration:** one, 080 (additive).
- **Setup:** none beyond the Xendit account already connected. Its secret key needs the Balance and Transactions read permissions (`deploy/FINANCE.md`).

This is phase 1 of the finance review of 31 October 2026. Duitku as a fallback gateway (phase 2) and recording owners' payouts (phase 3) follow.

## New

### Finance (Commercial → Finance)

**Who can see it:**

- **Platform administrators:** PlugSure's own Xendit account.
- **Operators with their own Xendit account:** theirs, never another's.
- **Permissions:** reading needs `payment:read`. Syncing, applying a payment and resolving a difference need `payment:write`.

| Tab | Shows |
|---|---|
| **Overview** | Collected, fees incl. VAT and the effective rate, refunds, net, settled. Receivable now (with the overdue part), the balance at Xendit, refunds due. A daily chart, by channel, the next settlement dates. |
| **Payments** | Xendit's ledger: every payment, refund, payout and transfer, with fee, VAT, net and settlement status (expected date, settled). Each row is matched to PlugSure's payment, pass or refund. Filters and search. |
| **Receivables** | Paid and not yet settled, by expected day, overdue flagged. For an operator, its fleet invoices issued and not paid. |
| **Payables** | Refunds due, each with the e-wallet's refund window and the days left. Site owners' shares on finalised statements, listed as due. |
| **Fees** | By month and channel, with the rate. QRIS fees actually charged against PlugSure's estimate (the MDR on owner statements). |
| **Reconciliation** | Differences between Xendit and PlugSure, open first (below). |

- **Period:** this month, last month, 30 or 90 days, or any dates up to 400 days. It applies to every tab.
- **Exports:**
  - **Excel:** sheets for Summary, By channel, Fees and Transactions.
  - **CSV:** the transactions.
  - **PDF:** for the monthly close.

### Sync and reconciliation

- **Ledger:** every 15 minutes, the transactions changed since the last run are read from Xendit (`GET /transactions`). The first run reads the last 35 days. A long backlog continues from where the last run stopped.
- **Balance:** read every hour (`GET /balance`).
- **Reconciliation:** every 6 hours, it compares the last 35 days and lists the differences:
  - **Paid at Xendit, not in PlugSure**, for example a lost notification. *Apply payment* applies it exactly as the notification would have been, including a refund when the charge can no longer start.
  - **Paid in PlugSure, absent at Xendit.**
  - **Amounts that differ.**
  - **Pending more than a day.**
  - **Settlement overdue.**
  - **Refunds out of step.**
- **Closing differences:** one that is put right closes itself; others are resolved with a note.
- **Alert:** open differences raise one alert per account, *Payments differ from the gateway*, which resolves when none are left.
- **Audit:** every action is audited (`finance.synced`, `finance.exception_applied`, `finance.exception_resolved`, `finance.exported`).

### API

These are new routes under `/v1/finance/accounts`, in the OpenAPI document under *Finance*. The document now has 344 operations.

| Routes | Purpose |
|---|---|
| `GET /` | The accounts the caller may see |
| `GET /:id/overview`, `/transactions`, `/receivables`, `/payables`, `/fees`, `/exceptions` | The tabs' data |
| `POST /:id/exceptions/:eid/apply`, `POST /:id/exceptions/:eid/resolve` | Act on a reconciliation difference |
| `POST /:id/sync` | Sync, read the balance and reconcile now |
| `GET /:id/export?format=csv\|xlsx\|pdf` | The period's export |

The Excel and PDF files are written by PlugSure itself; no new dependency.

## Upgrading

1. Deploy and run `npm run migrate`.
   - This applies **080**: the gateway ledger, balance snapshots, sync state, reconciliation.
   - It is additive and instant.
2. In Xendit's dashboard, give the secret key saved in PlugSure **read** permission for **Balance** and **Transactions**.
3. Open **Commercial → Finance**. The first sync runs within 15 minutes, or at once with *Sync now*.

**Rollback:** roll the code back to v1.11.0, then run `db/rollback/080_down.sql`. The synced ledger is dropped; it can be synced again from Xendit after a re-upgrade. Payments are untouched.

## Verification

- **Server:**
  - Typecheck clean.
  - Unit and database tests passing, 8 of them new, against a stand-in for Xendit's API. They cover:
    - sync paging and resuming;
    - fees, VAT and net amounts;
    - matching;
    - the reports;
    - each kind of difference;
    - applying a missed payment;
    - exports (a valid .xlsx, a PDF, CSV);
    - permissions and one operator's isolation from another.
  - The runtime role's privileges on the new tables are pinned by the least-privilege test.
- **Migration 080:** applies, rolls back and re-applies cleanly.
- **Console:** rendered against a stand-in Xendit with five weeks of transactions (389), in light and dark mode and at phone width; the exports were downloaded and checked.
