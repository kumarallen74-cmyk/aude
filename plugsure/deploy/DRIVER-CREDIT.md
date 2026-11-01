# Driver credit: gift cards, vouchers and referrals (v1.45.0)

**Commercial → Credit & referrals.** Viewing needs `tariff:read`; changes need `tariff:write`. The month's movement is
under `GET /v1/finance/driver-credit` (`payment:read`).

Switch it on in **Settings**, which also sets:
- the currency;
- how long credit lasts (months);
- the least amount a charge must pay through the payment gateway when it is paid partly with credit (your acquirer's
  minimum).

## Codes

- **Gift cards** are sold, for example to a company for its staff. Record what the buyer paid per card (at most its
  value), the day it was sold and the buyer.
- **Vouchers** are given away, for a campaign or as a goodwill gesture.

Each batch makes up to 10,000 codes such as `K7QX-M2PA-9HTD`. **The codes are shown, and downloaded as CSV, only when
the batch is created**; only a hash is kept. *Void unused* stops the codes not redeemed yet.

A driver redeems a code in the app (Account → Kredit). The credit is with the operator that issued it. A code works
once. A driver who enters 10 wrong codes in an hour has to wait.

## Referrals

With referrals on, a driver who has charged with you gets a code to share. A new driver enters it in the app. When that
driver's first paid session reaches the minimum energy, both get their reward as credit, checked every 15 minutes.

Refused:
- the driver's own code;
- a driver who has already charged with you;
- a second code;
- a code entered on a device the referrer has used;
- referrals past the referrer's monthly cap.

## Paying with credit

At checkout the driver ticks *Pakai kredit*.

1. Credit is held, promotional credit first and then paid-for credit, the soonest to expire first.
2. Only the rest goes to the payment gateway, never less than the minimum you set.
3. Credit is a means of payment, not a discount: the charge record and its taxes are on the full price.
4. When the session settles, the money paid through the gateway is used first and then credit. What the session did not
   use comes back as credit, paid-for credit first.

So credit is never refunded as cash. A card hold or a post-pay charge captures only what credit does not cover.

Credit held by a charge that never ran comes back within two hours. That covers a payment that failed or expired, or a
charge that never started.

## Expiry

Each credit expires after the months set, or at its batch's end date if that is sooner. Paid-for credit that expires
unused is breakage.

## Accounting

The ledger posts each month's movement under source `driver_credit`:

| Event | Debit | Credit |
| --- | --- | --- |
| Gift cards sold | bank 1100 (price paid); 6450 for any discount on their value | 2260 gift card liability (value) |
| Charging paid with gift card credit | 2260 | 4110 charging paid with credit |
| Charging paid with vouchers and referral credit | 6450 driver credit promotions | 4110 |
| Gift card credit expired | 2260 | 4160 gift card breakage |

A goodwill credit can be given to a driver (`POST /v1/credit/drivers/{id}/adjust`). Only promotional credit can be taken
back.
