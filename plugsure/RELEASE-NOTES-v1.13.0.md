# PlugSure CSMS v1.13.0: release notes

**Date:** 31 October 2026
**Base:** v1.12.0.

v1.13.0 adds **Duitku as the fallback acquirer**. When Xendit, the main acquirer, does not answer, a driver's charging payment is made at Duitku instead, and the driver charges as usual. This is phase 2 of the finance review of 31 October 2026.

- **Migration:** one, 081 (one constraint).
- **When nothing changes:** until a fallback account is connected (Govern → Integrations → Payments — fallback), and for as long as Xendit answers.
- **Setup:** `deploy/DUITKU.md`.

## New

### Payments — fallback (Duitku)

A new integration with **Duitku** as its provider, per operator or for the platform:

- environment, merchant code and API key;
- the payment methods offered: QRIS, DANA, ShopeePay, LinkAja, cards;
- the QRIS method on the account: SP or NQ;
- the signature scheme: MD5 (Duitku's SDK) or HMAC-SHA256;
- optionally, the Disbursement credentials, for the balance.

**Test** checks the key and whether the QRIS method is active.

### Failover

- **When it applies:** a driver's charging payment for which Xendit does not answer (down, a timeout, a server error, a rejected key).
  - **Which payments move:** QRIS, DANA, ShopeePay, LinkAja or a card sale.
  - **Where they go:** the same payment is made at Duitku and recorded on Duitku's account, so its callback, status checks and Finance follow it.
- **What never moves:**
  - refusals (a declined e-wallet, an amount out of bounds);
  - OVO, which Xendit may already have pushed to the driver's phone;
  - saved cards, card holds, linked e-wallets and post-pay;
  - passes, reservations and unpaid sessions.
- **Alert:** each time, the operator is told: *Payments moved to the fallback acquirer*, with Xendit's error. The Xendit integration's activity lists it too.
- **Confirmation:** Duitku's signed callback, verified with the API key, the merchant code and the amount. A lost callback is recovered within 15 minutes by asking Duitku (`transactionStatus`).
- **Refunds:** Duitku has no refund API, so refunds of Duitku payments are paid by bank transfer from the Refunds page.

### Duitku in Finance

The Duitku account appears in **Commercial → Finance** as *… · Duitku (fallback)*:

- **Ledger:** built from PlugSure's Duitku payments, with the amount and fee Duitku reports.
- **Settlement:** estimated from Duitku's schedule (QRIS and e-wallets 2 working days, cards 4).
- **Balance:** the Disbursement balance, when its credentials are saved.
- **Reconciliation and exports:** the same as for Xendit.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **081**: the `payments_fallback` kind.
2. Optionally, follow `deploy/DUITKU.md`:
   1. Create a Duitku project and activate its methods.
   2. Connect **Payments — fallback** and run **Test**.
3. `PUBLIC_BASE_URL` must be the public host: PlugSure sends Duitku its callback URL with each payment.

**Rollback:** roll the code back to v1.12.0, then run `db/rollback/081_down.sql`. The fallback accounts are removed. Payments they took keep their record, and their refunds go by bank transfer.

## Verification

- **Server:** typecheck clean; unit and database tests passing, 8 of them new, against stand-ins for Xendit and Duitku. They cover:
  - signatures and callback verification;
  - the failover, and what never moves;
  - the callback through `/pay/notify/<key>`;
  - recovery of a lost callback;
  - the Duitku ledger with its fee;
  - the settlement estimate;
  - reconciliation.
- **Integrations e2e:** updated for the seventh integration kind.
- **Migration 081:** applies, rolls back and re-applies cleanly.

**To confirm with Duitku before going live:**

- the signature scheme the project uses;
- the QRIS method code;
- the status codes (00 paid, 01 pending, 02 failed);
- the exact Disbursement endpoints.

They differ between Duitku's 2026 documentation and its SDK.
