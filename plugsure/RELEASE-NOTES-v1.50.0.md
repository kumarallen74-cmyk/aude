# PlugSure CSMS v1.50.0: release notes

**Date:** 2 November 2026
**Base:** v1.49.0.

v1.50.0 is phase 38: EV dealer partnerships. Car dealers give their buyers welcome charging credit, earn a commission
on their buyers' charging, and settle up through monthly statements.

- **Migration:** one, 117. It is additive: three tables, and a link from a credit entry to its sale.
- **When nothing changes:** there are no dealers until one is added. Gift cards and vouchers redeem as before.
- **New worker:** dealers, every 6 hours, drafts last month's statements.
- **Guide:** [`deploy/DEALERS.md`](deploy/DEALERS.md).

## New

**Commercial → Dealers.**

- **Dealers**: the welcome credit per buyer, how long a code is valid, who pays for the credit (the dealer, billed when
  it is redeemed; or the operator), and the commission on the dealer's buyers' charging (a % before tax, for so many
  months).
- **Sales**: registered by the dealer's staff on their portal (a secret link, `/dealer/<token>`) or in the console.
  Each sale records the buyer, their mobile number, the car, the VIN (one sale per VIN) and the plate. The welcome code
  is shown once.
- **Redeeming**: in the app like any voucher (Akun → Kredit). With the buyer's number recorded, only that account can
  redeem it. Codes expire, and an unused one can be voided. Credit the dealer pays for counts as paid-for credit.
- **Statements**: monthly, per dealer:
  - cars sold, codes redeemed;
  - the credit billed to the dealer;
  - the dealer's buyers' charging (kWh and before tax, within each buyer's commission window) and the commission;
  - the net, owed either way.

  Statements are drafted automatically, then issued and settled with a reference. Each one downloads as a
  spreadsheet, and the issued ones show on the dealer's portal.

## API

- **14 operations** (`src/api/openapi/catalogue/phase38.ts`), 1068 in all: `/v1/dealers*`, `/v1/dealer-sales*`,
  `/v1/dealer-statements*`.
- **Public, with each dealer's own link:** `GET /v1/dealer-portal/{token}`, `POST /v1/dealer-portal/{token}/sales`.
- **Driver API:** none new. A welcome code redeems through `POST /d/v1/credit/redeem`.
- The SDK is regenerated (1.50.0).

## Upgrading

1. Run migration 117 (`db/migrations/117_dealer_partnerships.sql`; rollback `db/rollback/117_down.sql`).
2. Deploy. Nothing else is required.
3. Optional: see `deploy/README.md` item 43.

## Tests

`src/services/phase38.db.test.ts` covers:
- the commission and the dealer's terms;
- a sale and its code: shown once, kept hashed, one sale per VIN;
- redeeming: by the buyer's number only, once, not when expired or voided; the credit funded by the dealer;
- the month: the credit billed, the buyers' charging within the window (before tax), the commission and the net;
- issuing, settling and the spreadsheet;
- the portal: registering a sale, seeing the month, and the link stopping when the dealer is archived.
