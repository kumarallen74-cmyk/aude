# PlugSure CSMS v1.16.0: release notes

**Date:** 31 October 2026
**Base:** v1.15.0.

v1.16.0 is phase 5 of the finance review of 31 October 2026, the review's last items.

- **Migration:** one, 084 (two new tables, additive).
- **When nothing changes:** owner payouts are only sent when Disbursement is set up on the operator's own Duitku account and someone sends one. Reports are only generated when requested.
- **Guide:** `deploy/FINANCE.md`, *Trail, method costs, owner payouts and Xendit reports*.

## New

### A payment's whole trail

Finance → Payments: click a row to open a drawer showing:

- the gateway transaction and its raw record (the payer's details masked);
- the other ledger rows of the same payment (its refunds);
- PlugSure's payment, with its state history and refund;
- the charging session: site, charger, energy, the driver's number masked, and the receipt;
- Disbursement refund transfers;
- the membership pass it paid;
- reconciliation differences.

### What each method costs

Finance → Fees → **What each method costs**, per gateway account you can see, over the period:

- payments, the average fee and VAT per payment, the effective rate, and the cost per 100,000 rupiah collected;
- the lowest per method, marked;
- for a Duitku account, what Duitku quotes today for 100,000 rupiah, including methods not used yet.

### Owners' shares paid through Duitku Disbursement

This applies once Disbursement is set up on the operator's own Duitku account. In Finance → Payables, **Send via Disbursement** on an owner's share:

1. **Request.** The amount, up to what is outstanding, goes to the owner's saved bank account, which needs the bank code. Duitku returns the holder's name.
2. **Approve.** A second person approves the payout; never the person who requested it.
   - Limits apply to one payout and to all payouts approved in a day. They are set on the Duitku integration; defaults 50,000,000 and 100,000,000 rupiah.
   - What is outstanding is checked again before sending.
3. **Record.** When Duitku confirms the payout, it is **recorded against the statement**, so the share shows part-paid or paid.
   - Refused: nothing is recorded.
   - Not confirmed: the worker asks Duitku again. After a day the operator is alerted, and the payout can be settled by hand.

The platform's Duitku account never pays an operator's owners. Recording a payout the operator's bank made (v1.14.0) works as before. Every step is audited.

### Xendit reports from the console

Finance → **Xendit reports** asks Xendit to generate its own report for the period, as CSV:

- transactions;
- balance history;
- upcoming settlements (the next 30 days).

The report is ready in a few minutes. **Download** asks Xendit for a fresh link, since Xendit's links expire. The secret key needs Xendit's Report permission. Requests and downloads are audited.

### API

Ten new operations (369 in all), in the OpenAPI document and the TypeScript SDK:

| Operation | Permission |
|---|---|
| `GET /v1/finance/accounts/{id}/transactions/{tid}/trail` | `payment:read` |
| `GET /v1/finance/method-costs` | `payment:read` |
| `GET /v1/finance/accounts/{id}/reports` | `payment:read` |
| `POST /v1/finance/accounts/{id}/reports` | `payment:read`, audited |
| `GET /v1/finance/accounts/{id}/reports/{rid}` | `payment:read`; `link=true` audited |
| `GET /v1/finance/payout-transfers` | `payment:read` |
| `POST /v1/finance/statements/{sid}/payout` | `payment:write`, audited |
| `POST /v1/finance/payout-transfers/{tid}/approve` | `payment:write`, second person, audited |
| `POST /v1/finance/payout-transfers/{tid}/reject` | `payment:write`, audited |
| `POST /v1/finance/payout-transfers/{tid}/resolve` | `payment:write`, audited |

`GET /v1/finance/owner-shares` gains `payoutsAvailable`.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **084**: `payout_transfer` and `gateway_report`. Both have row-level security, and the application role may not delete from them.
2. Optionally:
   - set the payout limits on the Duitku integration (Payments — fallback);
   - give the Xendit secret key the Report permission.

No new settings.

**Rollback:** roll the code back to v1.15.0, then run `db/rollback/084_down.sql`.

- Payouts already paid stay recorded as statement payments.
- Check Duitku's dashboard first for payouts in flight.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 9 of them new. They cover:
  - owner payouts:
    - only from the operator's own account, and not for another operator;
    - the requester cannot approve, and a payout is sent once;
    - never more than is outstanding;
    - the per-payout and daily limits;
    - rejection;
    - recorded as a statement payment once confirmed;
    - unknown results asked about;
  - the trail (payer masked, another operator refused);
  - method costs, with Duitku's quoted fees;
  - Xendit reports: requested, generating, the link, refused for a Duitku account.
- **Migration 084:** applies, rolls back and re-applies cleanly.

**To confirm with the gateways before live use:**

- **Xendit:** the Report API's fields and the Report permission.
- **Duitku:** the Disbursement paths, signatures and codes (see `deploy/DUITKU.md`).
