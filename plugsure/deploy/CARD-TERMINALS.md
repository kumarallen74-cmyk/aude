# Card payment terminals (v1.47.0)

**Commercial → Card terminals.** A card reader on the charger (or a kiosk for the whole site) lets drivers pay by
tapping a card, with no app.

## How a payment works

1. The terminal pre-authorises an amount on the card (the hold) and posts it to PlugSure.
2. PlugSure starts the connector with a single-use guest card, limited to the amount (the connector's tariff turns it
   into an energy limit; the session is stopped when it is reached). If the connector is not available or the charger
   does not start, the answer is `accepted: false`, and the terminal voids the hold at once.
3. When the session ends, its charge record decides the amount (never more than the hold). No energy: void. A car that
   never charged within 10 minutes: void.
4. The terminal captures (or voids). It gets the instruction either from its callback address or by polling.

## Set up

1. *Add a terminal*: its site, its charger (none: a kiosk; the driver chooses the charger on it), the largest hold, and
   either a **callback address** (PlugSure POSTs `{reference, action: "capture" | "void", amountMinor, currency}`,
   signed `X-PlugSure-Signature: t=<unix>,v1=<HMAC-SHA256(secret, "t.body")>`; any 2xx means done; retried with
   back-off, and after 10 failures the payment is *failed* and `payment.terminal_failed` is raised) or none (the
   terminal polls).
2. The terminal's address is shown once: `https://<console>/v1/terminals/events/<key>`. The terminal (or its payment
   app or gateway) POSTs JSON there:

   | type | body | answer |
   |---|---|---|
   | `preauth` | `reference`, `amountMinor`, `cardBrand`, `cardLast4`, `connectorId`; a kiosk adds `chargePointId` or `ocppIdentity` | `{accepted, txnId, receiptUrl, energyLimitKwh}` (not accepted: void it) |
   | `cancel` | `reference` | before the car charged |
   | `poll` | — | `{instructions: [{reference, action, amountMinor}]}` |
   | `captured` / `voided` | `reference` (`amountMinor`) | after doing an instruction |
   | `failed` | `reference`, `error` | it could not |

   A repeated `preauth` with the same reference is the same payment.
3. Show `receiptUrl` as a QR code on the terminal's screen: the driver's receipt (energy, amount, card's last four).

## Settlement

The acquirer pays the captures out in batches. *Settlement report*: paste or choose the provider's CSV (reference,
amount in minor units, date). Each line is matched: *matched*, *differs* (the amounts differ, or PlugSure has not seen
the capture) or *unknown*. Captures not in any report after 3 days are counted as *not settled*.

Card data never reaches PlugSure: only the brand and the last four digits the terminal sends.
