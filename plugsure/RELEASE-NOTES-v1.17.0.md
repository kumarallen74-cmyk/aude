# PlugSure CSMS v1.17.0: release notes

**Date:** 31 October 2026
**Base:** v1.16.0.

v1.17.0 is phase 6 of the finance work: the accounting journal, the monthly close e-mail, Xendit Payouts beside Duitku Disbursement, and a fix for a flaky end-to-end check.

- **Migration:** one, 085 (one new table, two columns; additive).
- **When nothing changes:** until the settings are saved, the close e-mail is turned on, or Xendit payouts are enabled on the Xendit integration.
- **Guide:** `deploy/FINANCE.md`, *Accounting journal, monthly close e-mail and Xendit payouts*.

## New

### Accounting journal

Finance → **Journal** exports the period as double-entry journal entries, as Excel or CSV. There is one entry per day and kind, and every entry balances:

- collections;
- gateway fees and VAT on fees;
- withholding tax, as the gateway reports it;
- refunds;
- withdrawals to the bank;
- owner payouts recorded against statements.

Set your own account codes in **Finance → Settings**. The Excel export also has a *By account* sheet, which nets to zero.

### Monthly close e-mail

Set it up in **Finance → Settings**:

- On the 1st of each month, the previous month's finance export (Excel and PDF) and the journal are e-mailed to up to 10 recipients. They go out through your e-mail channel.
- Each month is sent once. A failure is shown in Settings and retried hourly.
- **Send last month now** sends it at once.

### Xendit Payouts

On the Xendit integration (Payments → advanced), *Send refunds and owner payouts through Xendit Payouts*, with its limits. The secret key needs Xendit's Money-out write permission.

- **Refunds:** refunds of Xendit payments, such as cards or QRIS past its refund window, can be sent to the driver's bank account from the Refunds page.
- **Owner payouts:** owners' shares can be sent from Payables. When both Xendit and Duitku are set up, Xendit is offered first, and you can choose in the dialog.
- **Same flow:** the two-person approval and limits of v1.15.0 / v1.16.0 apply.
- **Names:** Xendit does not check the account holder's name; the approver sees the name entered.
- **Bank codes:** the usual codes map to Xendit's channels (014 BCA → ID_BCA); you can also enter Xendit's own codes.
- **Results:** *SUCCEEDED* records the transfer. *FAILED*, *CANCELLED* or *REVERSED* is final, and the refund or payout is due again.
- **Duplicates:** each payout is sent with an idempotency key, so a lost answer is asked again without paying twice.

### Flaky end-to-end check fixed

The console suite sent a remote start with a blocked card, waited a fixed 3 seconds, then started the real session. Under CI load the two runs overlapped on the simulated charger.

- The simulated charger now refuses a start while a session is still being authorised.
- The test asks again until the charger accepts.

### Fix

*What each method costs* (v1.16.0) now gives one row per method across gateways. Before, Xendit's ID_DANA / CARDS and Duitku's DANA / CARD appeared as different methods.

### API

Four new operations (373 in all):

| Operation | Permission |
|---|---|
| `GET /v1/finance/accounts/{id}/settings` | `payment:read` |
| `PUT /v1/finance/accounts/{id}/settings` | `payment:write`, audited |
| `GET /v1/finance/accounts/{id}/journal` | `payment:read`, audited |
| `POST /v1/finance/accounts/{id}/close-email/send` | `payment:write`, audited |

Other changes:

- Refund and payout transfers gain `rail` (`duitku` or `xendit`).
- `POST /v1/finance/statements/{sid}/payout` takes an optional `rail`.
- Owner shares gain `payoutRails`; refund rows gain `disbursement_rail`.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **085**:
   - `gateway_account_settings`;
   - `rail` on `refund_transfer` and `payout_transfer`.
2. Optionally:
   - set your chart of accounts and the close e-mail in Finance → Settings;
   - enable Xendit payouts on the Xendit integration.

**Rollback:** roll the code back to v1.16.0, then run `db/rollback/085_down.sql`. Check Xendit's dashboard first for payouts in flight.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 9 of them new. They cover:
  - the journal: entries balanced, the operator's codes, nets to zero, CSV and Excel;
  - settings validation;
  - the close e-mail: attachments through a fake SMTP server, once a month, the failure kept;
  - Xendit Payouts:
    - for refunds: two people, the channel mapping, the idempotency key, SUCCEEDED recording the refund, FAILED being final;
    - for owner payouts, recorded against the statement.
- **Simulator change:** the sandbox tests pass.
- **End to end:** console, field and queue suites pass locally in CI's order.

**To confirm with Xendit before live use:** the Payouts v2 fields, its channel codes, and the Money-out permission.
