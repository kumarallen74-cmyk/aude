# PlugSure CSMS v1.14.0: release notes

**Date:** 31 October 2026
**Base:** v1.13.0.

v1.14.0 records **owner payouts and statement payments** in Finance. PlugSure moves no money: the operator's bank makes the transfers, and PlugSure records them, so Finance shows what is still owed. This is phase 3 of the finance review of 31 October 2026.

- **Migration:** one, 082 (two new tables, additive).
- **When nothing changes:** until someone records a payment. Owners' shares show as *due*, as in v1.13.0.
- **Guide:** `deploy/FINANCE.md`, *Payouts and statement payments*.

## New

### Owners' shares: due, part-paid, paid

**Commercial → Finance → Payables** lists each finalised commission statement with the site owner's share, what has been paid and what is outstanding.

- **Record payout:** the amount, the date, the bank reference of the transfer and a note.
  - A part payment leaves the share *part-paid*.
  - PlugSure refuses more than is outstanding, and a date in the future.
- **Void:** a payout recorded by mistake is voided with a reason. Payouts are never deleted.
- **KPI:** *Owners' shares outstanding*, with the number of statements not fully paid.

### Owners' bank details

Per site owner: the bank, an optional bank code, the account holder and the account number.

- The number is **sealed** with `SECRETS_KEY`, bound to the owner. The console and the API show only its last four digits.
- Editing without a number keeps the saved one.

### Transfer list

A CSV of what is owed, one line per statement not fully paid, with the owners' bank details and the **full** account numbers, for the bank's bulk transfer. Downloading it needs `payment:write` and is audited.

### Operators' statements to PlugSure

For platform administrators, on the platform account (**Receivables**): the statement total each operator owes PlugSure, with the payments received recorded and voided the same way.

### API

Eight operations under `/v1/finance` (352 in all), in the OpenAPI document and the TypeScript SDK:

| Operation | Permission |
|---|---|
| `GET /v1/finance/owner-shares` | `payment:read` |
| `GET /v1/finance/owner-shares/transfer-list.csv` | `payment:write`, audited |
| `GET /v1/finance/operator-statements` | `platform:admin` |
| `GET /v1/finance/statements/{sid}/payments` | `payment:read` |
| `POST /v1/finance/statements/{sid}/payments` | `payment:write`, audited |
| `POST /v1/finance/statement-payments/{pid}/void` | `payment:write`, audited |
| `GET /v1/finance/owners/{oid}/bank-account` | `payment:read` |
| `PUT /v1/finance/owners/{oid}/bank-account` | `payment:write`, audited |

A platform statement is visible only to platform administrators; an owner statement only to its operator. Any other answers 404.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **082**: `owner_bank_account` and `statement_payment`, each with tenant isolation (row-level security). The application role may not delete a statement payment.
2. Enter the owners' bank details (Finance → Payables → *Bank details*), then record payouts as the bank makes them.

No new settings. `SECRETS_KEY` (required since v1.4.0) seals the account numbers.

**Rollback:** roll the code back to v1.13.0, then run `db/rollback/082_down.sql`. The recorded payments and the bank details are dropped. Export them first if they are needed; the transfers themselves are in the bank's records.

## Verification

- **Server:** typecheck clean; unit and database tests passing, 5 of them new. They cover:
  - the bank details: sealed, masked, kept when omitted, validated;
  - payouts: part and full payment, the refusal of more than is outstanding and of a future date, voiding;
  - tenant isolation, and platform statements for platform administrators only;
  - the transfer list.
- **Least privilege:** the grants on the two new tables pinned in `src/db/least-privilege.test.ts`.
- **Migration 082:** applies, rolls back and re-applies cleanly.
- **Console:** Payables and Receivables checked in the light and dark themes and at phone width.
