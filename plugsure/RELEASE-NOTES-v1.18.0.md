# PlugSure CSMS v1.18.0: release notes

**Date:** 31 October 2026
**Base:** v1.17.0.

v1.18.0 is phase 7 of the finance work: bank statement reconciliation, alerts for transfers waiting for approval, payout results by callback, and PPh 23 and e-Faktur for PlugSure's platform fee.

- **Migration:** one, 086 (three new tables; additive).
- **When nothing changes:** until a bank statement is uploaded or a withholding recorded. Approval alerts start at once for new transfer requests; route them in Govern → Alert routing.
- **Guide:** `deploy/FINANCE.md`, *Bank statements, approval alerts, payout callbacks and tax*.

## New

### Bank statement reconciliation

Finance → **Bank** takes the operator's bank statement as the bank's CSV export:

- **Formats:** BCA (one amount column with CR / DB), Mandiri (debit and credit), BRI, or any export with a date, a description and an amount (or debit and credit) column.
- **Matching:** each line is matched to what should appear on the account:
  - credits: withdrawals from the gateway;
  - debits: owner payouts recorded against statements, and refunds paid by bank transfer;
  - for platform administrators, credits: operators' payments of PlugSure's statements.

  A line matches a record of the same amount within 4 days, and a reference found in the description wins.
- **Overlaps:** uploading an overlapping period skips the lines already there.
- **By hand:** match a line to one of the nearest records, ignore it with a note (a bank fee, another business), or undo. A record matches one line only.

### Approval alerts

A refund or owner payout waiting for a second person raises an alert, which alert routing can send by e-mail, WhatsApp or SMS.

- **Kinds:** `finance.transfer_awaiting_approval`; after 24 hours, a critical `finance.transfer_approval_overdue`.
- **Resolution:** both resolve when the transfer is approved or rejected.
- **Console:** Refunds and Finance show the number waiting as a badge.

### Payout callbacks

Xendit's `payout.*` events and Duitku Disbursement's callback now settle a sent transfer in seconds, not at the next 5-minute check.

- They arrive at the account's existing notification URL (`/pay/notify/<key>`). For Xendit, set the payout callback URL in the dashboard to it.
- The callback only names the transfer: PlugSure asks the gateway for the result itself, so a forged or replayed callback cannot mark anything paid.
- Unknown ids are acknowledged and left to the worker.

### Tax

Finance → **Tax**:

- **PPh 23:** per month, the suggested base and 2% for the gateway's fees (on the operator's own accounts, excluding VAT) and for PlugSure's platform fee.
  - Record what was withheld, with the bukti potong's number and date (or add it later).
  - Void a mistaken record with a reason.
  - Export the year as CSV for the tax adviser.
  - Platform administrators see what operators recorded on PlugSure's fee.
- **e-Faktur for PlugSure's fee** (platform administrators): a month's finalised platform statements with PPN as Coretax's import XML.
  - The same format as fleet invoices.
  - PlugSure (`BILLING_ISSUER_NPWP`) is the seller and each operator (its NPWP) the buyer.
  - Operators without a valid NPWP are left out and counted.

Finance prepares the figures; it files nothing. The treatment is the operator's and its adviser's.

### API

Eleven new operations (384 in all):

| Operation | Permission |
|---|---|
| `GET /v1/finance/approvals` | `payment:read` |
| `GET /v1/finance/bank-statements` | `payment:read` |
| `POST /v1/finance/bank-statements` | `payment:write`, audited |
| `GET /v1/finance/bank-lines` | `payment:read` |
| `GET /v1/finance/bank-lines/{lid}/candidates` | `payment:read` |
| `POST /v1/finance/bank-lines/{lid}/match` | `payment:write`, audited |
| `GET /v1/finance/tax/pph23` | `payment:read` |
| `POST /v1/finance/tax/withholdings` | `payment:write`, audited |
| `POST /v1/finance/tax/withholdings/{wid}/bukti` | `payment:write`, audited |
| `POST /v1/finance/tax/withholdings/{wid}/void` | `payment:write`, audited |
| `GET /v1/finance/tax/platform-efaktur` | `platform:admin`, audited |

The OpenAPI document gains the `TaxWithholding` schema.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **086**: `bank_statement`, `bank_statement_line` and `tax_withholding`. All three use row-level security, and the runtime role cannot delete from them.
2. Optionally:
   - route the two approval alerts to the people who approve;
   - set Xendit's payout callback URL;
   - set `BILLING_ISSUER_NPWP` for the platform e-Faktur.

**Rollback:** roll the code back to v1.17.0, then run `db/rollback/086_down.sql`. This drops uploaded statements and withholding records.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 7 of them new. They cover:
  - approval alerts: raised, counted for the approver and not the requester, escalated once after 24 hours, resolved on approval;
  - payout callbacks: a forged token ignored, a pending answer left to the worker, success recorded against the statement, a replay doing nothing;
  - bank statements:
    - the BCA, Mandiri and BRI formats, amounts and dates;
    - automatic matching, overlapping uploads, and by-hand match, ignore and undo, with the other direction refused;
  - PPh 23:
    - the suggested bases and 2%;
    - validation, the bukti potong and voids;
    - the CSV;
  - the platform e-Faktur: platform administrators only, PlugSure's NPWP required, the operator the buyer, operators without an NPWP left out.
- **Database:** the least-privilege pins cover the three new tables, and the 086 rollback was checked.

**To confirm before live use:**
- Xendit's payout callback fields (`event`, `data.id`).
- Duitku Disbursement's callback body (`disburseId`).
- The PPh 23 treatment, with the operator's tax adviser.
