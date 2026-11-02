# EV dealer partnerships (v1.50.0)

**Commercial → Dealers.** Car dealers bundle charging with the cars they sell.

## A dealer's terms

| Term | Meaning |
|---|---|
| Welcome credit | the credit each buyer gets in the app |
| Valid for | how long a welcome code can be redeemed (default 90 days) |
| Paid by | **the dealer**: billed on the monthly statement when a buyer redeems the code (the credit is paid-for credit); **us**: the operator's promotion |
| Commission | a share (in %) of the dealer's buyers' charging before tax, for so many months after each buyer joins |

New terms apply to sales registered afterwards. *Archive* stops the dealer's portal link.

## Registering a sale

The dealer's sales staff use the **portal**: *Portal link* makes a secret link, `https://<console>/dealer/<token>`, shown
once; a new link replaces the old one. The operator can also register a sale from the console (*Sale*).

A sale records the buyer, their mobile number, the car, its VIN (one sale per VIN) and the plate. The welcome code
(`XXXX-XXXX-XXXX`) is shown once: the dealer hands it to the buyer. The buyer enters it in the app (Akun → Kredit) like
any voucher. With a mobile number recorded, only an account with that number can redeem it. A code that is expired or
voided (*Void*, while unused) does not work.

## Statements

Each month, per dealer:
- cars sold, codes redeemed and their credit;
- what the dealer is billed for that credit (when it pays for it);
- its buyers' charging (kWh, before tax, only sessions within each buyer's commission window) and the commission;
- the **net**: positive, the dealer pays; negative, the operator pays the dealer.

Last month's statement is drafted automatically (every 6 hours) and refreshed until it is issued. *Issue* fixes it;
*Settled* records the payment's reference. Each statement downloads as a spreadsheet with the month's sales. Issued
statements also show on the dealer's portal.
