# Stripe for Malaysia and Singapore

PlugSure takes Malaysian and Singapore payments through **Stripe** (docs/MULTI-COUNTRY-DESIGN.md §2.3, §D6, WP3).
Indonesian payments are unchanged: Midtrans, Xendit or a BI-SNAP bank, as before.

| | Singapore | Malaysia |
|---|---|---|
| Stripe account | Stripe **Singapore** (SGD) | Stripe **Malaysia** (MYR) |
| Card (Visa, Mastercard, …) | **hold** (pre-authorisation) → capture of the session's total; or a sale | same |
| Saved cards (signed-in drivers) | yes | yes |
| PayNow | QR code, pre-purchase, unused balance refunded | — |
| FPX online banking | — | pre-purchase (RM 2 – RM 30,000), refunded likewise |
| GrabPay | pre-purchase | pre-purchase |
| Minimum charge | S$0.50 | RM 2.00 |

## 1. One Stripe account per country

Stripe accounts are per country and settle in that country's currency, and PayNow / FPX exist only on SG / MY
accounts. The operator (or the platform, for operators without their own) therefore connects **one Stripe account per
country**: the Singapore company's account for SG sites, the Malaysian company's account for MY sites. In PlugSure each
is a separate payments integration with `countryCode` `SG` or `MY`; a charger's payments go to the account of its site's
country. A Stripe account in the wrong country is refused by *Test connection* (it reads the account's country).

Malaysia and Singapore must be enabled on the deployment (`MULTI_COUNTRY=true`).

## 2. In the Stripe Dashboard (each account)

1. **Activate the account** for the legal entity in that country (business details, bank account, identity checks).
   Use the business category for EV charging; Stripe assigns the MCC.
2. **Payment methods** (Settings → Payment methods): turn on **Cards**; on SG **PayNow** (and GrabPay if wanted); on MY
   **FPX** (accept FPX's terms) and GrabPay if wanted. GrabPay is activated per account by Stripe
   ([GrabPay availability](https://support.stripe.com/questions/grabpay-availability-and-getting-started)).
3. **Check before going live (open items, design §2.5 V4):**
   - **PayNow and MCC 5552.** Stripe's PayNow terms prohibit "Petroleum and Petroleum Products, Fuel Dealers, Service
     Stations, Automated Fuel Dispensers" ([Stripe — PayNow, prohibited business categories](https://docs.stripe.com/payments/paynow#prohibited-business-categories)).
     Ask Stripe support in writing whether an EV charging operator (MCC 5552) may use PayNow. Until confirmed, leave
     PAYNOW unticked in PlugSure: the card hold alone satisfies LTA's payment condition (Visa/Mastercard).
   - **PayNow as an SG guest method.** Whether a PayNow pre-purchase with a refund of the unused part is a "deposit"
     under the LTA licence conditions is open (V2). The SG guest default is the card hold.
   - **Minimum capture amount.** Stripe's minimum *charge* is S$0.50 / RM 2.00
     ([Stripe — minimum charge amounts](https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts)) and
     PlugSure refuses smaller payments before asking Stripe. Whether a *partial capture* below that minimum is accepted
     is not documented: a session costing less than S$0.50 on a held card may fail to capture, and then shows under
     *Refunds → Card holds* with Stripe's message and a critical alert like any failed capture. Confirm with Stripe.
4. **Webhook endpoint** (Workbench → Webhooks → *Create an event destination* → *Your account*):
   - **Endpoint URL**: the URL PlugSure shows for this integration under *Govern → Integrations*
     (`https://<PUBLIC_BASE_URL>/pay/notify/<key>`; one per account; `/pay/*` must be public — deploy/Caddyfile does
     that already).
   - **API version**: the version PlugSure pins, **`2026-09-30.endive`** (the integration's *Stripe API version* field
     if you changed it).
   - **Events**: `payment_intent.succeeded`, `payment_intent.amount_capturable_updated`,
     `payment_intent.payment_failed`, `payment_intent.canceled`, `payment_intent.processing`,
     `payment_intent.requires_action`, `refund.created`, `refund.updated`, `refund.failed`, `charge.refund.updated`.
     (`charge.refunded` and any other event are harmless: verified and answered 200, nothing done.)
   - Copy the **signing secret** (`whsec_…`).
5. **API keys** (Workbench → API keys): the **publishable key** (`pk_live_…`) and a **restricted key** (`rk_live_…`)
   with *write* on PaymentIntents, Refunds, Customers and PaymentMethods, *read* on Balance and Account (or the secret
   key `sk_live_…`).

## 3. In PlugSure

*Govern → Integrations → Payments*, the country's account (API: `PUT /v1/integrations/payments` with
`"provider": "stripe", "countryCode": "SG"`):

| Field | Value |
|---|---|
| Publishable key | `pk_live_…` (the card page loads Stripe.js with it) |
| Secret key | `rk_live_…` or `sk_live_…` — sealed with `SECRETS_KEY`, never shown again |
| Webhook signing secret | `whsec_…` — while rolling it in Stripe, paste the new and the old one separated by a space |
| Payment methods | CARD, and PAYNOW (SG) / FPX (MY) / GRABPAY as enabled in Stripe |
| Card holds | on: the card is authorised for the chosen amount and only the session's total is captured |
| Saved cards | on: signed-in drivers may keep a card at Stripe (PlugSure keeps only brand, last four, expiry and Stripe's reference) |

Then **Test connection**: it checks the key with Stripe (`GET /v1/balance`), that the account is in this country
(`GET /v1/account`), and that the publishable and secret keys are of the same mode.

PlugSure refuses, when saving: a Stripe account without `countryCode` MY or SG; PayNow on a MY account or FPX on an SG
account; a webhook secret not starting `whsec_`; a publishable and a secret key of different modes; test keys in
production (below).

## 4. Test mode

Use the account's **test keys** (`pk_test_…`, `sk_test_…`, and the test endpoint's `whsec_…`) on a development or
staging deployment. **In production (`NODE_ENV=production`) test keys are refused** — on save and again on every call —
so a live deployment cannot silently take test payments; a staging deployment running with `NODE_ENV=production` may
tick *Allow Stripe test mode* on the integration. Webhook events must also match the key's mode (`livemode`); a live
event at a test integration (or the reverse) is refused.

Manual acceptance run (design §6.3), with test keys against Stripe itself:
1. SG card hold of **S$30** with test card `4242 4242 4242 4242` on the card page; charge ~19 kWh at S$0.65 incl. GST;
   the session's total (e.g. S$12.34) is captured and the rest released (Dashboard: *Uncaptured* → *Succeeded* with
   *partially refunded/released* amount).
2. A card requiring 3-D Secure (`4000 0025 0000 3155`) on the page; then the same card saved and used again.
3. PayNow: the QR in the app links to Stripe's test page — *Authorize test payment*; the payment is confirmed by
   webhook; after the session the unused balance is refunded and reaches *refunded* via `refund.updated`.
4. MY FPX: choose any bank on the page, authorise on the test redirect; confirmed by webhook. `test_offline_bank`
   shows the offline-bank error.
5. GrabPay (MY or SG): authorise on the test redirect.
6. Send a test event from the Dashboard with a wrong secret configured: PlugSure answers 400; restore it.

The automated equivalent runs in CI against a local fake Stripe: `npm run e2e:stripe` (tools/e2e/stripe-e2e.mts) and
`src/services/payments/stripe*.test.ts`.

## 5. How PlugSure uses Stripe

All calls go to `https://api.stripe.com` through PlugSure's outbound guard (`providerFetch`), form-encoded, with the API
version pinned in `Stripe-Version` and an `Idempotency-Key` on every POST. No Stripe SDK is installed.

| PlugSure | Stripe | Notes |
|---|---|---|
| Card hold (mode `preauth`) | PaymentIntent `capture_method=manual`, `payment_method_types[]=card`; confirmed on PlugSure's card page | `payment_intent.amount_capturable_updated` → held. Capture: `POST /v1/payment_intents/:id/capture {amount_to_capture}` — a partial capture releases the rest ([Stripe — place a hold](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method)). Release: `POST …/cancel`. An uncaptured authorisation lapses after 7 days (Visa MIT ~5); Stripe then cancels it (`cancellation_reason: automatic`) and PlugSure ends the hold. |
| Card sale (`prepurchase`) | the same with `capture_method=automatic` | when holds are off, and for passes |
| Saved card | a Customer per saved card (metadata: PlugSure driver id only), `setup_future_usage=off_session`; later `PaymentIntent {customer, payment_method, confirm: true, return_url}` | 3-D Secure → `next_action.redirect_to_url`; a detached / expired card is reported ended and no longer offered |
| PayNow (`prepurchase`) | PaymentIntent `payment_method_data[type]=paynow`, `confirm=true` → `next_action.paynow_display_qr_code.data` shown as the QR | QR valid 1 hour; refunds asynchronous, up to 90 days ([Stripe — PayNow](https://docs.stripe.com/payments/paynow)) |
| FPX (`prepurchase`) | PaymentIntent `payment_method_types[]=fpx`; the bank chosen on PlugSure's card page | RM 2 – RM 30,000 ([Stripe — FPX](https://docs.stripe.com/payments/fpx/accept-a-payment)) |
| GrabPay (`prepurchase`) | `payment_method_data[type]=grabpay`, `confirm=true`, `return_url` → `next_action.redirect_to_url.url` | no minimum ([Stripe — GrabPay](https://docs.stripe.com/payments/grabpay/accept-a-payment)) |
| Refund of unused balance | `POST /v1/refunds {payment_intent, amount}`, `Idempotency-Key: refund-<payment>` | pending → `refund.updated` / `refund.failed` |

**The card page** (`/pay/stripe/<reference>/<payment intent>`) is PlugSure's own page with Stripe's **Payment Element**
(Stripe.js from `js.stripe.com`, the only page whose Content-Security-Policy admits it). It asks for **no e-mail, phone
or name** and offers no Link sign-up: Singapore's licence conditions require a guest option with no personal details,
and Stripe Checkout (Stripe's hosted page) always asks for an e-mail address unless one is passed in
([Stripe API — customer_email](https://docs.stripe.com/api/checkout/sessions/create)). Card numbers go from the driver's
browser to Stripe; PCI scope stays SAQ A.

**Webhooks** ([Stripe — verify signatures manually](https://docs.stripe.com/webhooks#verify-manually)): the
`Stripe-Signature` header `t=…,v1=…` is checked as HMAC-SHA256 of `"<t>.<raw body>"` with the signing secret, every
`v1` (a rolled secret signs twice) compared in constant time, other schemes ignored, and the timestamp must be within
**5 minutes**. Events are applied **once per event id** (table `payment_webhook_event`, migration 070): a re-delivery
or replay is answered 200 and not applied again. As for every acquirer, a notification is applied only by the account
that took the payment and for its organisation; a payment or hold reported for **less** than asked is not accepted
(a hold is released, money taken is refunded in full, critical alert); a payment reported in **another currency** is
never booked (critical alert; refund it in the Stripe Dashboard).

**Idempotency** ([Stripe — idempotent requests](https://docs.stripe.com/api/idempotent_requests)): Stripe replays the
saved answer of a key for 24 hours, failures included. PaymentIntents use `pi-<reference>` (a repeated checkout gets the
same PaymentIntent) and refunds `refund-<payment>` (never paid twice). Captures and cancels use a fresh key per attempt
under the hold's key — safe because a PaymentIntent is captured at most once, and PlugSure looks up its status before
each attempt — so a failed attempt (a replayed 500) does not block the hold worker's retries.

## 6. Rotating keys

- **Webhook secret**: in Stripe *Roll secret* with a delay; paste `whsec_new whsec_old` into PlugSure; after the delay,
  paste `whsec_new` alone.
- **Secret / restricted key**: create the new key, save it in PlugSure, *Test connection*, then expire the old one.
