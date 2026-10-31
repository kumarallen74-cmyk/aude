# Duitku: the fallback acquirer

From v1.13.0, PlugSure can use **Duitku** as a **fallback** for drivers'
charging payments. Xendit stays the main acquirer. Duitku is only asked when
Xendit does not answer, for example when it is down, times out, returns a
server error or rejects the key. The driver then gets Duitku's QRIS code, or
its e-wallet or card page, and charges as usual. Nothing changes while Xendit
answers.

## What moves to Duitku

| Payment | Moves to Duitku when Xendit fails |
|---|---|
| QRIS, DANA, ShopeePay, LinkAja, card (one-off sale) | Yes, if the method is ticked on the Duitku account |
| OVO | No. Xendit may already have pushed the request to the driver's phone. |
| Saved cards, card holds, linked e-wallets, post-pay | No. Duitku's API does not offer them. |
| Membership passes, reservations, unpaid sessions | No: they keep Xendit's own retry. Charging payments are what move. |

A refusal by Xendit, such as a declined e-wallet or an amount below the
minimum, is shown to the driver as before. It does not move to Duitku.

Each time a payment moves, the operator gets an alert: *Payments moved to the
fallback acquirer*. The integration's activity also shows the error.

## Setup

1. **At Duitku** (dashboard.duitku.com):
   1. Create a **project** for PlugSure.
   2. Activate the payment methods you want: QRIS (`SP` ShopeePay QRIS, or
      `NQ` Nobu QRIS), DANA, ShopeePay, LinkAja and cards.
   3. Note the project's **merchant code** and **API key**.
   4. Ask Duitku whether the project signs with the classic MD5 scheme (the
      one in Duitku's SDK) or HMAC-SHA256.
   5. Optionally, enable **Disbursement (Transfer Online)** and note its
      **user ID**, **e-mail** and **secret key**. With it, Finance shows the
      balance, and (v1.15.0) refunds of Duitku payments can be sent from the
      Refunds page and owners' bank accounts checked by name.
2. **In PlugSure:** go to **Govern → Integrations → Payments — fallback**,
   provider **Duitku**:
   - **Environment:** sandbox or production.
   - **Merchant code** and **API key.**
   - **Payment methods:** tick only those active on the project.
   - **QRIS method on the account:** SP or NQ.
   - **Advanced:** the signature scheme, the Disbursement credentials, the
     refund-transfer limits (v1.15.0: largest transfer, default 5,000,000
     rupiah; all transfers approved in a day, default 25,000,000), and a base
     URL (for a proxy only).
3. **Test** asks Duitku for the project's payment methods. It reports whether
   the key works and whether the QRIS method is active.
4. **`PUBLIC_BASE_URL`** must be the public host. PlugSure sends Duitku its
   callback URL (`https://<public host>/pay/notify/<key>`) with every
   payment, so it does not need to be pasted into Duitku. `/pay/*` must be
   reachable from the internet; it already is for Xendit.

Each operator may connect its own Duitku account, in the **Your account** part
of the card. Otherwise the platform's account applies, as for payments.

## How a Duitku payment is confirmed

- **Callback.** Duitku posts a signed callback (form fields `merchantCode`,
  `amount`, `merchantOrderId`, `resultCode`, `signature`).
  - PlugSure checks the signature with the API key and the merchant code.
  - It checks the amount like every payment, then captures the payment.
  - It answers `200 OK`.
- **Lost callbacks.** Every 15 minutes, the Finance sync asks Duitku about
  pending Duitku payments older than three minutes (`transactionStatus`). A
  payment Duitku reports paid is applied exactly as its callback would have
  been.

## Refunds

Duitku has no refund API. Refunds of Duitku payments, such as unused balance or
a charge that never started, appear on the **Refunds** page as due. Pay them by
bank transfer and record the transfer reference, or (v1.15.0) send them through
Disbursement:

1. **Send via Disbursement** (`payment:write`): enter the driver's bank code,
   account number and account holder. Duitku's inquiry returns the holder's
   name the bank has; the console shows whether it matches. The refund is held
   while the transfer is open, so it cannot be paid another way too.
2. **Approve and send**, by a **second person** with `payment:write`. The
   requester cannot approve their own transfer. Within the limits, PlugSure
   checks the account again (the bank's name must not have changed) and sends
   the transfer once.
3. The result:
   - **paid** (`00`): the refund is recorded refunded, method *Duitku
     Disbursement*;
   - **refused**: the refund is due again (a bank transfer, or another request);
   - **not known** (no answer, timeout): the worker asks Duitku
     (`inquirystatus`) every few minutes; only a confirmed payment counts. After
     a day the operator is alerted; check Duitku's dashboard and **Settle by
     hand** (paid, or not paid) with a note.
4. **Reject** (or **Withdraw**, for the requester) before it is sent, with a
   reason: the refund is due again.

Every step is in the audit log (`refund.transfer_requested`, `_approved`,
`_rejected`, `_resolved`). The account number is stored sealed.

**Owners' bank accounts** (Finance → Payables → Bank details → *Check name with
the bank*): the same inquiry, with nothing transferred. It needs the bank code.
The check is cleared when the account number, bank code or holder changes.

**Owners' shares** (v1.16.0, Finance → Payables → *Send via Disbursement*): the
same two-person flow from the operator's own Duitku account, with its own
limits (largest payout, default 50,000,000 rupiah; payouts per day, default
100,000,000). A confirmed payout is recorded against the statement. See
[FINANCE.md](FINANCE.md).

**To confirm with Duitku before live transfers:** the Disbursement paths
(`/webapi/api/disbursement/inquiry`, `/transfer`, and `inquirysandbox` /
`transfersandbox` in the sandbox; `/inquirystatus`), the signatures
(SHA-256 of email + timestamp + bank code + account + amount + purpose + secret
key for the inquiry; with account name, customer reference and disburseId for
the transfer; email + timestamp + disburseId + secret key for the status), and
the bank codes.

## Finance

The Duitku account appears in **Commercial → Finance** as *… · Duitku
(fallback)*. Duitku has no ledger or settlement API, so PlugSure builds the
ledger itself:

- **Ledger:** from its own Duitku payments, with the amount and fee Duitku
  reports for each (`transactionStatus`).
- **Settlement:** estimated from Duitku's schedule:
  - QRIS and e-wallets: 2 working days;
  - cards: 4 working days.

  A row is marked settled once that date has passed. Public holidays are not
  counted, so check the bank statement around holidays.
- **Balance:** from Disbursement (`checkBalance`), when its credentials are
  saved. It shows the effective (available) balance.
- **Reconciliation:** the same checks as for Xendit. A Duitku payment that
  Duitku does not know is reported *missing at the gateway*.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Test: "Duitku refused: 401" | Wrong merchant code or API key, or the wrong environment: sandbox keys only work with sandbox. |
| Test: "the QRIS method SP is NOT among them" | Choose the QRIS method your project has (SP or NQ), or ask Duitku to activate QRIS. |
| Callbacks answered 401 (integration activity: rejected) | The signature scheme differs. Switch *Signature scheme* (MD5 / HMAC-SHA256) to the one your project uses. |
| "Duitku needs PUBLIC_BASE_URL" | Set `PUBLIC_BASE_URL` on the API to the public host and restart. |
| Payments never move to Duitku | The fallback only takes over when Xendit errors. Its alert and the Xendit integration's activity show when it happened. Check that the method is ticked on the Duitku account. |
| Refund transfer: "Duitku could not check the account" | Wrong bank code or account number, or the Disbursement credentials are wrong. Duitku's answer is in the message. |
| Approve: "would pass the daily limit" | Approve it the next day (platform time zone), raise the limit in the integration, or pay it by bank transfer. |
| A transfer stays *sent, not confirmed* | Duitku has not confirmed it. Check it in Duitku's dashboard, then **Settle by hand**. |
