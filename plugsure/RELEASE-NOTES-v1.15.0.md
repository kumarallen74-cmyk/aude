# PlugSure CSMS v1.15.0: release notes

**Date:** 31 October 2026
**Base:** v1.14.0.

v1.15.0 is phase 4 of the finance review of 31 October 2026: the parts of the review not built in phases 1 to 3.

- **Migration:** one, 083 (one new table, three columns, one constraint widened; additive).
- **When nothing changes:** Disbursement is used only when its credentials are saved on the Duitku account and someone sends a refund with it. Statements already finalised are unchanged.
- **Guides:** `deploy/FINANCE.md` (*Refunds, statements and the month close*), `deploy/DUITKU.md` (*Refunds*).

## New

### Refunds

- **Refund window** per refund: the gateway's limit for its channel and the days left.
  - Xendit: OVO 90 days, DANA 30, ShopeePay 365, LinkAja 30, GoPay 30, QRIS 7.
  - Refunds whose window closes soonest are listed first. A KPI counts those closing within 7 days.
- **QRIS refunds through Xendit** (before: bank transfer only).
  - Full refunds, and partial ones where the payer's issuer allows them (DANA, ShopeePay, OVO).
  - The gateway's refusals are shown in words (partial refund not allowed, window closed, already refunded), and the refund can then be paid by bank transfer.
- **Gateway status and fees** from Finance's ledger:
  - the refund's status at the gateway, and its refund fee;
  - the payment's own fee, which Xendit keeps on a partial refund or one made more than 24 hours after the payment.

### Duitku refunds through Disbursement, with two people

Refunds of Duitku payments can be sent to the driver's bank account from the Refunds page.

1. **Request** (`payment:write`): Duitku's inquiry returns the account holder's name the bank has, compared with the name entered. The refund is held meanwhile.
2. **Approve and send**, by a **second person**: never the one who requested it.
   - Limits apply: the largest transfer (default 5,000,000 rupiah) and all transfers approved in a day (default 25,000,000). Both are set on the Duitku integration.
   - The account is checked again, and the transfer sent once.
3. **The result:**
   - paid: the refund is recorded as refunded;
   - refused: the refund is due again;
   - not known: the worker asks Duitku. After a day the operator is alerted, and the transfer can be settled by hand after checking Duitku's dashboard.
4. **Reject** or withdraw, with a reason, before the transfer is sent.

The account number is stored sealed. Every step is audited.

### Owners' bank accounts checked by name

Finance → Payables → *Bank details* → **Check name with the bank**:

- Duitku Disbursement's inquiry returns the holder's name the bank has: *name matches*, *name differs* or *check failed*.
- Nothing is transferred.
- The check is cleared when the account number, bank code or holder changes.

### Actual MDR on owner statements

Owner statements deduct the gateway's **actual** fee and VAT on the fee for every QRIS payment Finance has synced. PlugSure's estimate is used only for the rest.

- The statement says which: *actual*, *estimated*, or the split between them.
- The API's `mdrBasis` carries the amounts and counts.
- Statements finalised before v1.15.0 are not changed.

### The accountant's month close

- **Finance → Overview → By operator**: per operator over the period:
  - collected, fees incl. VAT, refunds and net;
  - the owners' shares on its statements, and what was paid against them.
- **Excel export:** two new sheets, **By operator** and **By site**, after the four existing ones (their order is unchanged).
- **PDF export:** by operator and by site.
- **Receivables:**
  - post-pay sessions not charged yet;
  - on the platform's account, PlugSure Hub fee invoices unpaid;
  - on an operator's account, the Hub settlement positions owed to it.
- **Payables:** the Hub positions an operator owes.

### API

Seven new operations (359 in all), in the OpenAPI document and the TypeScript SDK:

| Operation | Permission |
|---|---|
| `GET /v1/finance/accounts/{id}/breakdown` | `payment:read` |
| `POST /v1/finance/owners/{oid}/bank-account/check` | `payment:write`, audited |
| `GET /v1/refund-transfers` | `payment:read` |
| `POST /v1/refunds/{id}/disbursement` | `payment:write`, audited |
| `POST /v1/refund-transfers/{tid}/approve` | `payment:write`, second person, audited |
| `POST /v1/refund-transfers/{tid}/reject` | `payment:write`, audited |
| `POST /v1/refund-transfers/{tid}/resolve` | `payment:write`, audited |

Other API changes:

- `GET /v1/refunds` rows gain:
  - the refund window and days left;
  - `partial`;
  - the gateway refund status and fee;
  - `fee_kept`;
  - `disbursement_available`.
- The refunds summary gains `closing_soon_count`.
- Statements gain `mdrBasis`.
- Receivables gain `postpay`, `hubFeeInvoices` and `hubPositions`; payables gain `hubPositions`.
- `refund_method` and the `refund.completed` webhook may be `disbursement`.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **083**:
   - the `refund_transfer` table (row-level security; the application role may not delete it);
   - the name-check columns on `owner_bank_account`;
   - `disbursement` added as a refund method.
2. Optionally, save the Disbursement credentials on the Duitku integration (Payments — fallback) and set the limits.

No new settings.

**Rollback:** roll the code back to v1.14.0, then run `db/rollback/083_down.sql`.

- A refund waiting on a transfer goes back to due. Check Duitku's dashboard first for transfers in flight.
- Refunds paid by Disbursement stay refunded, recorded as bank transfers.

## Verification

- **Server:** typecheck clean; 1,536 unit and database tests passing, 12 of them new. They cover:
  - the bank-name matching and the refund windows;
  - Disbursement transfers:
    - the requester cannot approve, and a transfer is sent once;
    - the per-transfer and daily limits;
    - refused, unknown and confirmed results, and settling by hand;
    - rejection;
    - a held refund cannot be paid another way;
    - only Duitku payments with Disbursement;
  - owners' name checks;
  - the Refunds list's window, gateway status and fees;
  - the actual MDR on a statement;
  - the month close by operator and site, and its Excel export;
  - Xendit QRIS refunds, full and partial, and their refusal.
- **End to end:** integrations 22/22; payment methods 21/21.
- **Migration 083:** applies, rolls back and re-applies cleanly.
- **Console:** Refunds, the Disbursement dialog and transfers, and Finance (Overview by operator, Receivables, Payables) checked in the light and dark themes and at phone width, with no script errors.

**To confirm with the gateways before live traffic:**

- **Xendit:** the QRIS refund fields, its callback (`qr.refund`) and the QRIS refund window (7 or 30 days).
- **Duitku:** the Disbursement paths, signatures, response codes and bank codes (`deploy/DUITKU.md`).
