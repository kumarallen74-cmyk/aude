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
   5. Optionally, for the balance in Finance, enable **Disbursement
      (Transfer Online)** and note its **user ID**, **e-mail** and **secret
      key**.
2. **In PlugSure:** go to **Govern → Integrations → Payments — fallback**,
   provider **Duitku**:
   - **Environment:** sandbox or production.
   - **Merchant code** and **API key.**
   - **Payment methods:** tick only those active on the project.
   - **QRIS method on the account:** SP or NQ.
   - **Advanced:** the signature scheme, the Disbursement credentials, and a
     base URL (for a proxy only).
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
bank transfer and record the transfer reference, as for QRIS refunds today.

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
