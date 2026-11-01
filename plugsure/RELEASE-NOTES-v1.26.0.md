# PlugSure CSMS v1.26.0: release notes

**Date:** 1 November 2026
**Base:** v1.25.0.

v1.26.0 is phase 15 of the finance work: Finance today for the phone, subscription and membership revenue, the monthly PPN return, and automatic owner payouts.

- **Migration:** one, 094 (three new tables; three columns; additive).
- **When nothing changes:** until automatic payouts are turned on or a PPN period is recorded. Finance today, Subscriptions and PPN only read until used.
- **Guide:** `deploy/FINANCE.md`, *Finance today, subscriptions, PPN and automatic payouts*.

## New

### Finance today

A phone-first page, Commercial → **Finance today** (payment:read):

- **Figures:** today's takings (sessions, kWh), the month to date against last month, cash (gateways and the last bank balance), and what is owed with the DSO.
- **Approvals:** owner payouts, refund transfers, write-offs, owner bank changes and driver refund requests that are waiting, oldest first.
- **Deciding:** approve or reject on the phone, through the same routes as in Finance. The person who asked, or who gave the first approval, cannot decide, and the approvals matrix applies.

### Subscription and membership revenue

The new Finance → **Subscriptions** tab. A membership or pass is paid ahead for its period, and its revenue is earned day by day over it.

| | |
|---|---|
| Billed | Charges (before tax) paid in the month, or invoiced to a fleet. |
| Recognised | The part of each charge's period that falls in the month. |
| Deferred | At the start and end of the month: billed for days still to come (a liability). |
| MRR / ARR | The monthly fee of every paying subscription active at the month's end. |
| Subscribers | New, cancelled, expired, churn. |

Per plan as well, and a **journal** for the month (billed into deferred revenue, earned out of it) with your account codes. Excel export.

### PPN return (SPT Masa PPN)

The new Finance → **PPN** tab, for a tax period, in rupiah:

- **Output tax:**
  - retail charge records not billed on a fleet invoice;
  - fleet invoices less credit notes;
  - memberships and passes paid.
- **Input tax:** the **faktur masukan** you record: supplier and NPWP, number (once), date (not after the period), DPP and PPN (at most 12% of it), creditable or not. VAT on gateway fees and on PlugSure's fee statement is suggested, and counted once recorded with its faktur.
- **Net:** output − input − the overpayment brought forward. It is either **payable** (kurang bayar, due by the end of the next month) or **carried forward** (lebih bayar).
- **Record as filed** with the NTPN of the payment (or as filed but unpaid). A filed period can be amended while no later one is filed, and records added to it need *amend*.
- **Exports:** working papers (Excel), the faktur masukan list as CSV, and the output (keluaran) list as CSV for checking against Coretax.
- Organisations not marked PKP are told they file no PPN return.

### Automatic owner payouts

The new Finance → **Auto payouts** tab:

- **Settings:** on or off, days to wait after a statement is finalised (default 3, time for the owner to raise a query), a minimum amount.
- **Per owner:** on, off or the default, its own minimum, and a **hold** with a reason.
- **Worker:** hourly (`owner-payout-automation`). For each ready statement it requests the payout of the owner's share through Xendit payouts or Duitku Disbursement, marked automatic. It is **never sent by itself**: it waits for the approvals as any payout does.
- **Skipped, with the reason shown,** while:
  - the owner is held, off, or below the minimum;
  - a query is open on the statement, or a bank change is waiting;
  - the bank details or bank code are missing, or the name check failed;
  - a payout is already open;
  - the wait has not passed.

### API

Twelve new operations (484 in all):

| Operation | Permission |
|---|---|
| `GET /v1/finance/today` | `payment:read` |
| `GET /v1/finance/subscription-revenue` | `payment:read` |
| `GET /v1/finance/subscription-revenue/trend` | `payment:read` |
| `PUT /v1/finance/subscription-revenue/accounts` | `payment:write`, audited |
| `GET /v1/finance/ppn` | `payment:read` |
| `POST /v1/finance/ppn/input-invoices` | `payment:write`, audited |
| `POST /v1/finance/ppn/input-invoices/{id}/void` | `payment:write`, audited |
| `POST /v1/finance/ppn/{month}/file` | `payment:write`, audited |
| `GET /v1/finance/owner-payouts/automation` | `payment:read` |
| `PUT /v1/finance/owner-payouts/automation` | `payment:write`, audited |
| `PUT /v1/finance/owner-payouts/automation/owners/{oid}` | `payment:write`, audited |
| `POST /v1/finance/owner-payouts/automation/run` | `payment:write`, audited |

One new hourly worker: `owner-payout-automation`.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **094**:
   - `owner_payout_rule`, `ppn_input_invoice` and `ppn_period`, with row-level security and no DELETE for the runtime role;
   - `payout_transfer.automatic`;
   - the automatic-payout and subscription-revenue settings.
2. Optionally:
   - turn on automatic owner payouts;
   - set the subscription revenue accounts;
   - if you are a PKP, record last month's faktur masukan and the filing.

**Rollback:**
1. Roll the code back to v1.25.0.
2. Export the PPN working papers.
3. Run `db/rollback/094_down.sql`.

Payouts already requested stay, and are approved as before.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 3 of them new. They cover:
  - automatic payouts: the preview's reasons (waiting, a query open, no bank details, held); a ready statement requested once, waiting for approval and marked automatic;
  - Finance today: the automatic payout listed, decidable by the person asking;
  - subscription revenue: billed, recognised pro rata across two months, deferred at the start and end, MRR, the journal balanced;
  - PPN:
    - output from a charge record and a paid pass;
    - the faktur checks (date, 12%, once);
    - an overpayment carried into the next period;
    - the NTPN required when payable;
    - filed once, amending, no amendment under a later filing.
- **Database:** the least-privilege pins cover the three new tables, and the 094 rollback was checked.

**To confirm before live use:**
- The PPN treatment of retail charging (digunggung) and of memberships with your tax adviser.
- The subscription revenue account codes in your chart of accounts.
- The wait and minimum for automatic owner payouts.
