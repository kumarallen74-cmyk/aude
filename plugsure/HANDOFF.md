# PlugSure v1.3.0 — Deployment Handoff (Enterprise Operator Console)

**New in v1.3.0:** the full operator console of SPEC-UI-CSMS-2026-FINAL (onboarding
wizard, remote cockpit, sites & PLN capacity, DLM studio, tariff builder, config key
studio, RFID centre, sessions & tax receipts, FOTA & diagnostics, users & RBAC), plus
four platform fixes: the API<->gateway bridge for the split deployment, background
workers in the gateway, OCPP 2.0.1 command translation, duplicate system roles.
The driver app is aligned with the console (fleet PINs from the RFID centre, card
limits, maintenance holds, archived sites, the 2.0.1 stop, the full tax receipt).
A final field-conditions test and a gap review against commercial CSMS platforms
(`docs/GAP-ANALYSIS-v1.3.md`) added the following, and fixed a non-expiring prepaid QR
token and the 2.0.1 prepaid/DLM transaction id:
- refunds
- charger uptime history, offline alerts and the availability report
- signed outbound webhooks
- the routine 2.0.1 device messages
**Alert routing** sends alerts to people by e-mail (any SMTP server), WhatsApp (Business
Cloud API, approved template, with delivery status from Meta's signed webhook) and SMS
(Twilio, Zenziva or your gateway; also as a fallback when WhatsApp fails), with rules,
on-call rotas and overrides, quiet hours, escalation, acknowledge and a delivery log.
Sites can have their own offline-alert threshold. It is set up in the console (Govern → Alert routing); see the deployment
guide, "Alert notifications".
**Platform statements** turn the published pricing into a monthly statement per customer:
- commission on the session subtotal, excluding PBJT and PPN, at 8 / 6.5 / 5% per site
- a minimum per charger (AC Rp 150,000, DC Rp 350,000)
- private-charger fees

Customers see them under Commercial → Statements. PlugSure's platform administrator sets plans and billing models and finalises months under Govern → Platform billing. Create that account with `create-admin --platform-admin`.
**Site owners** get a read-only owner portal. They sign in with e-mail and password and see only their own chargers, sessions and statement with their share. **Billing** shows every owner's charging units and amounts, and the owner and operator shares with totals (Commercial → Owners / Billing). The portal has been reviewed on phone and tablet, in light and dark mode (WCAG AA contrast).
**Roaming (OCPI 2.2.1)** lets other networks' drivers charge on your chargers; their provider is billed with a charge record per session. Connect a provider or a hub under Commercial → Roaming (they register with a one-time token, or you register with theirs), then choose which sites to share. Partners get locations with live availability, tariffs, sessions and CDRs, push their drivers' tokens, and can start, stop, unlock and reserve. The other way round, connect a charge point operator and share your RFID/fleet cards (Cards abroad): they charge on its network, you receive its charge records and export them to bill your fleets; card limits count roaming charges. Fleet drivers with a roaming card see partner chargers in the driver app, start and stop charges there, and get the operator's charge record. Expose `/ocpi/*` on its own hostname (`deploy/Caddyfile`) and set `OCPI_PUBLIC_URL`.
**Driver app** additions:
- a station map (Daftar | Peta)
- favourite stations that follow a signed-in driver to a new phone
- Web Push notifications (charging started and finished, receipt, refund, partner charge record, reservation reminder and end), switched on under Akun → Notifikasi
- 15-minute connector reservations sent to the charger as `ReserveNow`; fleet drivers with a roaming card can also reserve a partner operator's charger (OCPI RESERVE_NOW)
- nearby stations on the map grouped into a numbered bubble until you zoom in

Nothing to set up: the push key is generated and stored on first use. Busy deployments should point `MAP_TILE_URL` at their own tile service. The gateway needs outbound HTTPS to the push services.
**Published API and developer sandbox:**
- The operator API is documented as OpenAPI 3.1 at `/openapi.json`, with a readable reference with "Try it" at `/api-docs.html`. It covers 266 operations and the 11 webhook events. A generated TypeScript SDK (no dependencies) is downloadable from Govern → Developers (`/sdk/plugsure-csms-sdk.tgz`; rebuild with `npm run openapi && npm run sdk`). Each API key has its own rate limit (default 600 a minute, `API_KEY_RATE_LIMIT_PER_MIN`; per key under Users & roles → API keys), with RateLimit headers and usage by hour.
- Under **Govern → Developers** an operator creates sandbox tenants. Each has two virtual chargers that speak real OCPP inside the gateway (register more as OCPP 1.6, 2.0.1 or 2.1), plus its own API key. Integrators can then build and test with no hardware and no risk to live data.
- An optional `api.` host in `deploy/Caddyfile` serves the API to integrators with API keys only.
- Keep the document current with `npm run openapi` after changing a route; a unit test fails otherwise.

**Fleet billing (Commercial → Fleet billing):**
- Companies whose drivers use fleet cards get one invoice a month. It covers charging at your stations per site (PBJT-TL, and PPN 12% on DPP nilai lain per line) and partner-network charging re-billed at cost.
- Invoices are numbered and frozen, and generated as PDF. You can e-mail them (PDF and session list), record payments, void and re-issue, and correct them with **credit notes** (reducing what is owed, refunded, or deducted from the next invoice).
- The **fleet customer portal**: the customer's own staff (role Fleet customer) see what they owe, their invoices and credit notes as PDF, this month so far and their cards, and can block a lost card. They must be able to reach the console address.
- The e-Faktur XML imports into Coretax.
- Before the first export, set your NPWP/NITKU and the e-Faktur item classification in Settings, confirmed with your tax adviser, and import one test file into Coretax.

**Promotions and memberships (Commercial → Promotions & plans):**
- Membership plans offer a member price per kWh, % off energy, included kWh and a waived service fee.
- Fleet accounts or cards are enrolled in the console, with the monthly fee on the fleet invoice (with its own e-Faktur line), billed by the day for part of a month. Drivers buy a plan in the app as a 30-day pass, renewed automatically with a saved card or linked e-wallet if they choose, and can switch plans with the unused days credited.
- **Loyalty points** (off by default): drivers earn points on each session and can have them taken off their next sessions (before tax). The console shows the points outstanding and their value, a liability for finance.
- Promotions cover happy hours, new drivers, fleet deals, plan members and promo codes. They can be limited by days, time, sites, AC/DC, minimum kWh, uses and budget.
- Discounts are receipt lines applied before PBJT-TL and PPN. Each session gets the customer's cheapest allowed combination.
- If fleet memberships are invoiced, set the membership-fee e-Faktur item in Fleet billing → Settings.

**ISO 15118 Plug & Charge (Operate → Plug & Charge), CSMS side:**
- A car with a contract certificate charges when plugged in. The CSMS checks the certificate (chain to the MO roots, OCSP) and then the contract, which works like a card: limits, fleet account, membership.
- OCPP 2.0.1 natively, and 1.6 through DataTransfer (OCA application note).
- Chargers' V2G certificates are signed by the PKI (or your sub-CA in Vault), delivered and renewed before they expire. Trust anchors are installed from the console. Every exchange is logged.
- Real use needs a V2G PKI (Hubject or similar) behind the PKI gateway described in deploy/README.md, and 15118-capable chargers. The built-in test PKI (`PNC_PKI=mock`) is for development and sandboxes only.

**Onboarding with automatic charger certificates (Operate → Onboarding):**
- One page for bringing chargers onto PlugSure: those in progress (waiting, refused at the handshake with the reason, awaiting activation, getting a certificate, connected), every charger's client certificate, and the certificate authority.
- The wizard takes the hardware details and issues the charger's credentials. For Security Profile 3 it issues the client certificate automatically from PlugSure's charging-station CA: a key made for the charger (bundle downloaded once), the charger's own CSR, or zero-touch over OCPP (Profile 2 first, then CSR → CertificateSigned → Profile 3).
- Certificates are renewed over OCPP before they expire, without ever locking a charger out.
- **Before Profile 3 in production:**
  - put the CA on the TLS terminator (Onboarding → Certificate authority; uncomment the `client_auth` block in deploy/Caddyfile);
  - update Caddy from deploy/Caddyfile, whose new `header_up X-Client-Cert-Fingerprint` line closes a spoofing hole.

**Integrations (Govern → Integrations):**
- The QRIS acquirer, driver sign-in codes, the Plug & Charge PKI and map tiles are connected from the console, with secrets encrypted and write-only, connection tests and an activity log.
- **QRIS:** Midtrans, Xendit or a bank over BI-SNAP. Each operator can use its own merchant account, and the platform account is the default. Payments are confirmed only by signed notifications to `/pay/notify/<key>` (expose `/pay/*`), and refunds go through the acquirer where it offers them.
- **Sign-in codes:** WhatsApp (Meta Cloud API), Twilio, Zenziva or your own gateway, with a fallback channel.
- **Before launch:** in production, QRIS checkout and phone sign-in are refused until both are connected. You need a contract and credentials with each provider, and a test in its sandbox.

**E-wallet and card payments:**
- Drivers can pay a charge or a 30-day pass with GoPay, ShopeePay, OVO, DANA, LinkAja or a card as well as QRIS, as a pre-purchase exactly like QRIS.
- **Operators** tick the methods in Govern → Integrations → Payments (default: QRIS only).
- **Acquirers:** Midtrans offers GoPay, ShopeePay and cards on the Snap page; Xendit offers OVO (push to the phone), DANA, ShopeePay, LinkAja and cards on the invoice page.
- **Cards** are paid on the acquirer's hosted 3-D Secure page, so card numbers never reach PlugSure.
- The acquirer returns the driver to `/app/paid.html`, and the signed notification confirms the payment.
- **Refunds:** by API where the acquirer supports it; otherwise by bank transfer.
- **Before launch:** enable only methods that are activated on the acquirer account, and test each in the acquirer's sandbox.

**Card holds and saved cards:**
- **Holds:** with holds on, a card payment for charging is a pre-authorisation. The card is held for the chosen amount, the rated total is captured when the session ends and the rest released at once. Unused holds are released automatically, so there is no refund queue for cards.
- **Failed captures** are retried automatically. They are listed under Refunds → Card holds with a Retry button, and a critical alert follows the last automatic try.
- **Saved cards:** signed-in drivers can save a card. PlugSure keeps only the acquirer's token (sealed), the brand, last four digits and expiry. A saved card is bound to one driver and one operator's acquirer account. A card whose token has ended at the acquirer (deleted at the bank, or expired: Midtrans 411, Xendit token expired / cancelled) is refused with a message naming it ("Mastercard •••• 1117 … tidak bisa dipakai") and no longer offered.
- **Expired holds:** a hold whose authorisation expired at the acquirer before capture (Midtrans 407 or its expiry notification, Xendit EXPIRED) ends at once with one critical alert (`payment.hold_expired`). The console shows it as *expired, not charged* with the amount to collect and no retry, and the driver pays what the session cost from the receipt in the app (QRIS, e-wallet, card, saved card or linked e-wallet, as a separate settlement payment that buys no energy); once paid, the hold shows as paid in the app and the alert resolves, and a second payment for the same hold is refunded in full. Migration 028 (`payment_intent.settles_intent_id`). An unused hold that expired is simply released.
- **Acquirers:** Midtrans (Snap authorize, capture, cancel; saved_token_id, 3-D Secure again by default) and Xendit (Payments API v3; confirm its fields in the sandbox).
- **Operators** switch both on in Integrations → Payments; they are off by default. Card pre-authorisation (and card saving / One Click) must be enabled on the acquirer account.

**Linked e-wallets:**
- Signed-in drivers link GoPay (Midtrans GoPay Tokenization, or Xendit v3 payment tokens once Xendit activates GoPay recurring), or OVO, DANA, ShopeePay or LinkAja (Xendit reusable payment methods), once, approving in the e-wallet app.
- After that, charges and passes are paid in one tap. The chosen amount is charged, and unused balance is refunded automatically through the acquirer.
- A link is bound to the driver and the operator's acquirer account; tokens are sealed.
- Operators switch linking on in Integrations → Payments (off by default); e-wallet tokenisation must be enabled on the acquirer account.

**Post-pay with linked e-wallets (optional):**
- The session starts with nothing charged; the chosen amount is its limit, and the rated total is charged to the linked e-wallet afterwards.
- Guards: the operator's per-session limit (default Rp 200,000), a balance check for GoPay, OVO, DANA, ShopeePay and LinkAja (where the acquirer reports it; for GoPay at Midtrans, the active wallet or GoPay Tabungan, never PAY_LATER, with the token looked up again before each charge; a link ended in the e-wallet app or expired (GoPay, OVO, DANA, ShopeePay, LinkAja) is refused with "link … again", not a balance message, and an unpaid post-pay session (link ended, insufficient balance, refused otherwise, waiting for the e-wallet PIN, or the PIN confirmation expired, was denied or was cancelled) can be paid in the app with any method, a payment arriving after the session is paid otherwise refunded in full; the home screen and session screen show unpaid sessions, and phones with notifications get reminders 15 min, 1 day and 3 days after the session; the automatic e-wallet retries pause only while an in-app payment can still complete; an unpaid session's tax receipt is a nil transaction (Rp 0, "NIHIL / NIL") until paid; Xendit's link callbacks activate or end links at once (point Xendit's payment method and payment token callbacks at the payment notification URL); optionally, post-pay only when it can be checked), and no new post-pay session while one is unpaid.
- Failed charges are retried automatically, paid by the driver from the receipt (Bayar sekarang, including the e-wallet PIN when asked), or retried under Refunds → Holds and post-pay.

**OCPP 2.0.1 device model (charger drawer → Device model):**
- Ask a 2.0.1 station for its components and variables (GetBaseReport); the report is stored as it arrives.
- Change a variable (SetVariables), checked first against the station's own data type, limits and allowed values; read one now (GetVariables).
- Add, list and remove the station's variable monitors. An over-temperature or similar alert now resolves when the station reports it cleared.
- Security and network settings are never changed here (Security tab, Onboarding). 1.6 chargers keep the Configuration tab.
- On the bench, request a full report from each 2.0.1 model once: vendors differ in what they report and let you change.

**Reservation fees (Sites → Edit site → Reservations):** off by default (Rp 0). With a fee set, app drivers pay it (QRIS, e-wallet, card, saved card or linked e-wallet) before the connector is held; fleet cards' fees go on the monthly fleet invoice (and its e-Faktur, with the fee item code). The fee is kept once the connector is held; it is refunded (Refunds) or left off the invoice when the charger refuses, or the driver cancels within 2 minutes.

**Driver queue at busy sites (Sites → Edit site → Driver queue):**
- Off by default. Switched on for a site, drivers who find every suitable connector taken join a queue in the app (AC/DC and plug type, or any).
- A connector that frees up is held on the charger (ReserveNow) for the first driver waiting who can use it, for 2–15 minutes. Walk-ups cannot take it. Not started in time, the driver misses the turn and the next one gets it.
- The site drawer's **Driver queue** tab shows who is waiting and who holds a connector, with the last 24 hours. An operator can remove a driver.
- Runs in the gateway (the reservations worker, every 15 s); nothing to configure. Chargers must accept ReserveNow: check each model once.

**Roaming smart charging and hubs (OCPI ChargingProfiles, HubClientInfo):**
- A partner can limit how fast its driver's session charges on your chargers. The limit caps the session inside load management, so it can slow the session but never exceed the site budget. It applies at once, and the charger's result goes back to the partner.
- The limits in force are listed under Roaming → Roaming sessions.
- A roaming hub tells PlugSure who is behind it; the list is in the hub's panel, on the "Behind this hub" tab. Once a hub has sent its list, it may only act for parties on it that are connected or offline.
- Nothing to configure. Chargers must accept TxProfile SetChargingProfile, which load management already needs. Ask each partner and hub whether it uses these modules.

**ISO 15118-20 and bidirectional charging (V2G / V2B, OCPP 2.1):**
- Add `ocpp2.1` to `OCPP_VERSIONS` to accept 2.1 stations, and register them as OCPP 2.1.
- Cars' charging needs (energy wanted, departure, SoC, whether they can give energy back) show on a session's **Car (ISO 15118)** tab.
- A site's programme (Sites → Edit site → Bidirectional charging) sets the hours, the battery floor and the driver's credit per kWh. By default discharge is capped at the site's auxiliary load, so nothing reaches PLN; allowing export needs a PLN agreement.
- Drivers agree per charge in the app; fleets agree for their cards. The credit comes off the session before tax.
- Test each 15118-20 car and 2.1 charger pair on the bench before live use. Bidirectional AC (AC_BPT) runs in the sandbox but has not been tried on AC hardware.
- Not built, pending a grid code or market: grid-support functions (DER control) and price schedules to the car, and selling exported energy (PLN is the single buyer, so the credit is the operator's own).

**Signed meter values (OCMF):**
- Calibration-law meters sign their readings. PlugSure verifies them (OCMF, ECDSA P-256) against the meter's public key and checks them against the billed energy. Each session gets a status: verified, unverified key, mismatch, invalid, incomplete or missing.
- Enter each meter's public key (from its label or the vendor; hex, base64, PEM or the raw point) on its connector in Onboard, with the meter serial. For 2.x stations, switch signing on with `POST /v1/charge-points/:identity/signed-metering`; for 1.6, use the vendor's configuration key.
- Per site (Sites → Edit site → Signed meter data):
  - `record` (default): keep, verify and warn on a mismatch;
  - `require`: park any session that is not verified before invoicing;
  - `off`.
- Drivers see the status on the receipt. The console's session **Signed meter data** tab has the readings and an XML file for the Transparency Software. OCPI CDRs carry `signed_data`.

**Sandbox chargers on OCPP 2.0.1 and 2.1:** a virtual charger speaks the protocol it is registered with. Each has a signing meter registered automatically. On 2.1 the virtual car can give energy back (DC_BPT / AC_BPT), so integrators can try V2G with no hardware. The gateway must have `ocpp2.0.1` and `ocpp2.1` in `OCPP_VERSIONS`.

**White-label driver apps (Commercial → Driver app):**
- An operator gives its drivers its own app: PlugSure's app with the operator's name, tagline, colours, icon, support contacts and legal pages, showing only its stations. The accent is contrast-checked in both themes. Every icon size is made from one square PNG.
- **Draft:** previewed live in the console and at `/app/?brand=<name>`.
- **Live:** on the operator's own web address (a DNS CNAME to this server). Caddy issues its certificate on demand, after asking the API.
- The console's **Build kit** is the Android project (Trusted Web Activity, Bubblewrap), the iOS shell (Capacitor), icons, store listings and data-safety answers, with step-by-step instructions.
- **Before an operator publishes:**
  - its Google Play and Apple developer accounts;
  - an upload key, whose SHA-256 goes in the console, and later Play's app-signing key;
  - a build from the kit: a JDK and Android SDK for Android, a Mac with Xcode for iOS.
  No store build was made in testing.
- **iOS notifications:** the operator uploads its APNs key (.p8 and Key ID) under Driver app → iOS notifications. PlugSure checks it with Apple, and the iOS app then gets native notifications. The gateway needs outbound HTTPS to `api.push.apple.com` and `api.sandbox.push.apple.com`.
- **Badges and rich iOS notifications:**
  - the app icon counts sessions waiting to be paid;
  - notifications have the site as a subtitle, buttons (stop charging, view receipt, pay now, give up my turn, cancel reservation), time-sensitive "your turn";
  - a picture of the finished charge.
- **Live Activities (iOS 16.2+):**
  - a charge under way on the lock screen and in the Dynamic Island: energy, power, battery or prepaid progress, time, then the final cost;
  - started by the app, or by PlugSure for a charge started without it (iOS 17.2+);
  - updated by the gateway (every 5 s it checks; it sends at most every 30 s at low priority).
  The kit's README covers the Xcode steps (widget extension, plugin, storyboard class).
  The kit's README covers the two Xcode steps (the categories file, the Notification Service Extension). The picture is fetched by iPhones from `/d/n/…` on the app's web address, which Caddy already serves (`/d/*`).
- **Caddy:** update from deploy/Caddyfile. It adds the `on_demand_tls` ask and the catch-all block for driver-app addresses, and makes the console host's `X-Frame-Options` a default so the console can frame the preview. Run `caddy validate`.

Run `npm run migrate` (migrations 001–053; 045 is unused; all additive). **Set `INTERNAL_API_TOKEN`**, then
bootstrap the first admin with `create-admin`. See `RELEASE-NOTES-v1.3.0.md` and
`docs/ACCEPTANCE-v1.3.md`. Typecheck clean; unit tests passing (see CI for the current count). Verified on PostgreSQL 16:
- migrations
- a 96-check console e2e
- a 48-check driver-app e2e (OCPP 1.6 and 2.0.1)
- a 46-check e2e for the map, favourites, push and reservations (`npm run e2e:driver-plus`), with a raw charger and a mock push service that decrypts every notification and checks its VAPID signature
- a 12-check reservation fees e2e (`npm run e2e:reservation-fees`, needs `E2E_DATABASE_URL`): paid in the app before the connector is held, refunds when it cannot be held or is cancelled at once, a fleet card's fee on the fleet invoice
- a 19-check driver queue e2e (`npm run e2e:queue`, needs `E2E_DATABASE_URL`) with a raw charger and four drivers: first come first served, held connectors, missed turns, skips, walk-ups kept out, a refused hold retried, charging from the queue, the console list and removal
- a 147-check field-conditions e2e (`npm run e2e:field`), including alert routing against a local SMTP server, a fake WhatsApp API and a fake SMS gateway (delivery-status webhook, SMS fallback, on-call rotas, per-site offline thresholds), commission statements and the 2.0.1 device model (report, variables, monitors)
- a 74-check roaming e2e (`npm run e2e:ocpi`) against a mock eMSP, and a 60-check one (`npm run e2e:ocpi-emsp`) against a mock CPO, including the driver app and reserving partner chargers
- a 36-check roaming smart charging and hubs e2e (`npm run e2e:ocpi-profiles`) with a raw charger, a mock service provider and a mock hub:
  - partner limits reaching the charger through load management; never above the nameplate; stepped schedules; the composite schedule; lifting a limit
  - the hub's client list pulled over two pages, and only its connected parties allowed
- a 23-check SDK and rate-limit e2e (`npm run e2e:sdk`, after `npm run sdk`):
  - the built TypeScript SDK's typed calls, errors and CSV against the running API
  - a key limited to 20 a minute: RateLimit headers, a burst refused with 429, and the SDK's wait and retry
  - the limit changed and reset from the console, and usage by hour
  - guessed keys refused while valid keys keep working
  - a real webhook delivery verified with the SDK
- a 21-check bidirectional charging e2e (`npm run e2e:v2x`, gateway with `ocpp2.1` in `OCPP_VERSIONS`) with a raw OCPP 2.1 station:
  - ISO 15118-20 needs, and a fleet's and a driver's consent
  - discharge setpoints shared within the site's own load
  - stops at the floor, on withdrawal and outside the hours
  - the credit on the bill
- a 20-check signed meter values e2e (`npm run e2e:ocmf`), with raw 1.6 and 2.0.1 chargers:
  - verified, tampered, mismatched, wrong-meter and incomplete readings;
  - the `require` policy parking sessions;
  - the charger's own key never counted as verified;
  - the XML file and the receipt;
  - SetVariables on 2.0.1
- a 17-check sandbox OCPP 2.x e2e (`npm run e2e:sandbox-2x`), with virtual 2.0.1 and 2.1 (DC and AC) chargers:
  - OCMF verified;
  - remote start and stop;
  - signing switched off;
  - V2G on DC_BPT and AC_BPT with the fleet's consent, and the credit;
  - no discharge on 2.0.1
- a 28-check white-label driver app e2e (`npm run e2e:brand`, needs `E2E_DATABASE_URL`):
  - validation, the icon set and the preview;
  - only the operator's stations, and another operator's charger named and refused before payment;
  - the live web address (Host), the Android and iOS association files and the TLS check;
  - the build kit, removal and the audit trail
- a 14-check Live Activities e2e (`npm run e2e:live-activity`, same prerequisites as the APNs one):
  - activity tokens, updates within Apple's budget, push-to-start once;
  - "finished" and the end with the cost; dismissed and closed activities
- a 20-check iOS notifications (APNs) e2e, with badges and rich notifications, (`npm run e2e:apns`, needs `E2E_DATABASE_URL`, and `APNS_URL_PRODUCTION` / `APNS_URL_DEVELOPMENT` pointing the stack at the test's stand-in APNs on ports 9296 / 9297):
  - the key's validation and its check with Apple;
  - iPhones registering;
  - delivery by the gateway worker, with the development-server fallback, dropped tokens and a refused key
- a 53-check fleet billing e2e (`npm run e2e:fleet-billing`), in a sandbox: invoices against the session receipts, the e-Faktur XML against the invoices, e-mail, void/re-issue, payment, PDFs, credit notes and the fleet customer portal
- a 38-check API and sandbox e2e (`npm run e2e:api-sandbox`), which includes validating 69 live GET responses against the published schemas
- a 24-check promotions and memberships e2e (`npm run e2e:pricing`): discounts on real sessions in a sandbox, tax on the discounted price, limits, the membership fee on the fleet invoice (prorated by day) and e-Faktur, the plan-switch quote, promo codes and QRIS passes in the driver app
- a 37-check Plug & Charge e2e (`npm run e2e:pnc`) with raw 2.0.1 and 1.6 chargers and a sandbox virtual charger: V2G certificate issuance, contract authorisation with OCSP (accepted, revoked, cancelled, unknown), billing to the contract, trust-store management
- a 19-check onboarding e2e (`npm run e2e:onboarding`, gateway with `OCPP_TRUST_PROXY_PROTO=true`): certificates issued automatically and from a CSR, real Profile 3 connections accepted and refused, zero-touch Profile 2 → 3 over OCPP, renewal without lock-out, 2.0.1
- a 21-check integrations e2e (`npm run e2e:integrations`) against local fake Midtrans, Xendit, WhatsApp, Twilio and PKI gateway: signed notifications, capture once, refunds, acquirer switch, WhatsApp codes with SMS fallback, secrets never returned
- a 21-check e-wallet and card e2e (`npm run e2e:payment-methods`) against local fake Midtrans (Core API, Snap) and Xendit (e-wallet charges, invoices): method choice enforced, GoPay deeplink, OVO push, card pages, card fraud challenge, ewallet.capture and invoice callbacks, refunds by API or bank transfer, the sandbox checkout page, a 30-day pass by DANA
- a 38-check card holds and saved cards e2e (`npm run e2e:card-holds`) on real OCPP 1.6 sessions, including automatic pass renewal, plan switching and loyalty points: holds captured for the rated total and released, unused holds released by the worker, one-tap saved cards bound to the driver and the acquirer account, a failed Midtrans capture retried from the console
- a 19-check linked e-wallets e2e (`npm run e2e:linked-wallets`): GoPay, OVO, DANA, ShopeePay and LinkAja linked once and paid in one tap, unused balance refunded automatically through Midtrans and Xendit, links bound to the driver and the account
- a 40-check post-pay e2e (`npm run e2e:postpay`): sessions started with nothing charged and charged the rated total afterwards, the limit, the GoPay / OVO / DANA / ShopeePay balance guards and the checked-balance-only switch, a refused charge paid by the driver from the receipt, a PIN-confirmed charge settled by Midtrans' notification, a GoPay upgraded to Tabungan (its balance checked, the refreshed token charged), and a GoPay link ended in GoPay (the driver told to link again, at the start and on the receipt; "pay now" charging the new link)

Still to do: the acceptance demo on real hardware, and the two P0 items in the gap analysis. The adapters for a live QRIS acquirer and an SMS/WhatsApp OTP provider are built; what remains is to sign the contracts, enter the credentials under Govern → Integrations, and test each provider in its sandbox. For alerts, you also need your own SMTP account and WhatsApp Business sender, with an approved template. For roaming, each partner or hub runs a connection test against its test environment before going live. For Plug & Charge, the PKI provider's onboarding (and the PKI gateway) and a test on each charger model.

## Earlier releases

**New in v1.2.1:** load-management fix — the effective site ceiling is now clamped so it
can never exceed the subscribed capacity (connected_kVA × PF). Additive, no DB migration,
no required config change. Also set the affected site's stored ceiling_w to 237500
(250 kVA × 0.95). See `RELEASE-NOTES-v1.2.1.md`.


**New in v1.2.0:** OCPP Security Profile 3 (mutual TLS), certificate-only, bound per
charge point — additive and **off by default**. 1.6J, 2.0.1 and Profiles 0/1/2 are
unchanged from v1.1.1 (audited). Run `npm run migrate` to apply migration 008 (one
nullable column). Enable per unit via the client-certificate + security-profile API.
See `RELEASE-NOTES-v1.2.0.md`.

**New in v1.1.x:** OCPP 2.0.1 support alongside 1.6J — additive and **disabled by
default**. Deploy exactly as v1.0.0 and it runs as pure 1.6J with no change. Enable
with `OCPP_VERSIONS=ocpp1.6,ocpp2.0.1` (test first). No DB migrations, no required
config changes. v1.1.1 adds committed 2.0.1 unit tests (suite now 162). See
`RELEASE-NOTES-v1.1.1.md`.

Frozen PlugSure CSMS source for production testing & deployment. Source only —
no `node_modules`, no build output. Build per `deploy/README.md`.

## Contents
- `src/`             application source — API, OCPP gateway, driver app + API, operator console, services
- `src/driver-web/`  driver PWA (served at `/app`)
- `src/web/`         operator console (served at `/`): index.html + assets/app.css + js/ (core, app, views/*)
- `db/migrations/`   schema migrations (`007_driver_app.sql` = driver app)
- `deploy/`          runbook (`README.md`), `Caddyfile`, systemd units, `DRIVER-APP-PILOT.md`, Autel handout
- `tools/simulator/` Autel OCPP simulator (`autel-sim.ts`) for charger QA
- `../.github/workflows/ci.yml` (repository root)  CI: typecheck, DB-backed unit tests, e2e as plugsure_app, docker image
- `Dockerfile`, `docker-compose.yml`, `.env.example`

## Build & run (see deploy/README.md)
- Docker Compose (Path A):  `docker compose build && docker compose up -d`
- systemd (Path B):  `npm ci && npm run build && cp -R src/web dist/web && cp -R src/driver-web dist/driver-web`

## Required before go-live (deploy/README.md §4)
- `NODE_ENV=production`, `TZ=Asia/Jakarta`
- Generate `AUDIT_HMAC_KEY` and `SECRETS_KEY` (`openssl rand -hex 32`) — the process will not start without them
- Set `POSTGRES_APP_PASSWORD`; the app connects as role `plugsure_app`, never as the DB owner
- `OCPP_MIN_SECURITY_PROFILE=2`, `OCPP_TRUST_PROXY_PROTO=true` (TLS at proxy), `OCPP_AUTO_ADOPT=false`
- Expose BOTH `/ocpp/*` (gateway :9220) AND `/app` + `/d/*` (API :9200) over HTTPS; keep `/v1` admin loopback-only

## Verify
- `npm run typecheck` → clean
- `npm test` → all passing; CI prints the current count (set DATABASE_URL to a `plugsure_audit_fix` database to include the database-backed suites — without it they are skipped, not failed). A new database-backed test file must take `databaseTestLock('shared', DB_OK)` from `src/db/test-lock.ts` (the audit-chain suite takes it exclusive), or it will collide with the audit suite when files run in parallel
- `npm run openapi -- --check` → the committed `src/web/openapi.json` matches the code
- `npm run e2e:console` / `e2e:driver` / `e2e:driver-plus` / `e2e:queue` / `e2e:field` / `e2e:ocpi` / `e2e:ocpi-emsp` / `e2e:api-sandbox` / `e2e:fleet-billing` / `e2e:pricing` / `e2e:pnc` / `e2e:onboarding` / `e2e:integrations` / `e2e:payment-methods` / `e2e:card-holds` / `e2e:linked-wallets` / `e2e:postpay` against a running test stack (never production). Keep the test machine awake for a full back-to-back run (about 10 minutes). A laptop lid closed or Modern Standby suspends the stack and the tests together, and the timing checks then fail. The gateway logs `gateway paused` when that happens.
  `e2e:driver-plus` needs `E2E_DATABASE_URL` for the reservation reminder / expiry checks; `e2e:fleet-billing` and `e2e:pricing` need it to move sessions into last month. `e2e:onboarding` needs the API and the gateway started with `OCPP_TRUST_PROXY_PROTO=true` (the full suite passes that way).
  `e2e:field` checks the offline alert only if the gateway runs with `OFFLINE_ALERT_MINUTES=1`
  (set `E2E_QUICK=1` to skip it). It needs `E2E_DATABASE_URL` to test the unused-payment refund sweep and
  alert escalation, and a platform administrator (`E2E_PLATFORM_EMAIL` / `E2E_PLATFORM_PASSWORD`) for the
  platform-billing checks.

## Not included by design (client / dev-team responsibility)
- Live QRIS payment acquirer + webhook, and SMS/OTP provider — see `deploy/DRIVER-APP-PILOT.md`.
