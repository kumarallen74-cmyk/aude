# PlugSure CSMS v1.3.0: field test and gap analysis

**Date:** 26–27 September 2026 · **Build:** v1.3.0 (final) · **Method:** end-to-end run on the split deployment (API and gateway as separate processes, row-level security enforced) with simulated OCPP 1.6, 2.0.1 and 2.1 chargers behaving like field hardware, then a feature comparison with commercial CSMS platforms.

## 1. What was tested

`tools/e2e/field-e2e.mts` (`npm run e2e:field`) drives raw OCPP frames, so the "charger" can misbehave the way real hardware does. **147/147 checks pass.** It runs next to the console suite (96/96), the driver-app suite (48/48), the roaming suites (74/74 `npm run e2e:ocpi`, 60/60 `npm run e2e:ocpi-emsp`, 36/36 `npm run e2e:ocpi-profiles`), the SDK and rate-limit suite (23/23 `npm run e2e:sdk`), the bidirectional charging suite (21/21 `npm run e2e:v2x`), the signed meter values suite (20/20 `npm run e2e:ocmf`), the sandbox OCPP 2.0.1 / 2.1 suite (17/17 `npm run e2e:sandbox-2x`), the white-label driver app suite (28/28 `npm run e2e:brand`), the iOS notifications suite with badges and rich notifications (20/20 `npm run e2e:apns`), the Live Activities suite (14/14 `npm run e2e:live-activity`) and the unit tests (541/541, including the database-backed suites).

| # | Field condition | Result |
|---|---|---|
| 1 | Normal RFID session, idle after full | Billed from meter registers (8.000 kWh) |
| 2 | Ground fault mid-charge (vendor code E-GF-12) | Alert with the vendor code; closed and billed for the 1.5 kWh delivered |
| 3 | TCP connection drops mid-session, then reconnects | Shows offline; session stays open; same transaction continues; one session |
| 4 | Power loss → reboot → StopTransaction(PowerLoss) | Closed with PowerLoss and the right energy |
| 5 | Transaction recorded offline, uploaded 30 min later | Charger's own timestamps kept; billed correctly |
| 6 | Lost responses → duplicate Start and Stop frames | Same transaction id; no double billing |
| 7 | Meter register reset mid-session | No negative or wrapped bill; flagged for review |
| 8 | Blocked and unknown cards | Blocked / Invalid; no session opened |
| 9 | Vendor DataTransfer, schema-invalid frame, garbage | Proper answers and CALLERRORs; connection kept |
| 10 | Charger clock 3 days fast | Flagged for review, not billed blind |
| 11 | ReserveNow / CancelReservation | Delivered to the charger |
| 12 | Two paid drivers race for one connector; prepaid cut-off | Second driver told clearly; charge stopped at the paid energy |
| 13 | Station-level fault (connector 0) | Charger faulted, then recovers |
| 14 | Car stays plugged in after full | Idle fee billed |
| 15–18 | OCPP 2.0.1: offline transaction, duplicate Started, Ended without Started, prepaid cut-off | All correct (string transaction ids) |
| 19 | 2.0.1 NotifyEvent, NotifyReport, MeterValues, ReservationStatusUpdate | Acknowledged; an over-temperature monitor raises one alert |
| 19b | 2.0.1 device model: a report in two parts (the first before the station answers GetBaseReport), SetVariables, GetVariables, monitors, a cleared event; a 1.6 charger | Stored per component (EVSE and connector kept); bad values, security variables and read-only ones refused before anything is sent; accepted and RebootRequired answers stored; monitors added, listed (hard-wired and custom) and cleared; the over-temperature alert resolves; 1.6 refused (409) |
| 20 | Outbound webhooks, including a receiver outage | Signed, delivered, kept and retried |
| 21 | Driver leaves early on a prepaid top-up | Unused balance queued, refunded via provider, shown on the receipt |
| 22 | Paid but never plugged in | Stale claim token refused; full refund queued; bank-transfer refund recorded |
| 23 | Charger offline > threshold; a second site with its own 1440-minute threshold | Critical alert, auto-resolved on reconnect; uptime report counts it; the patient site's charger raises no alert |
| 24 | Connector fault with alert routing on (local SMTP + fake WhatsApp API) | E-mail and WhatsApp template sent; rejected number logged; repeat not re-sent; escalation after no acknowledgement; "resolved" messages on recovery |
| 24b | Rule to "whoever is on duty" with SMS fallback (fake WhatsApp API, fake SMS gateway, signed Meta status callbacks) | WhatsApp refused → SMS to the same person, linked in the log; an override moves duty; delivered/read recorded; a late "failed" from Meta → SMS to the contact's SMS number; forged signature 401; deleting the rota clears it from rules |
| 25 | Month's commission statement for the customer; platform operator changes plan, billing model, finalises | Base = session subtotals excl. PBJT/PPN (cross-checked); 8% tier; pro-rated minimum; customer cannot change its plan; last month billed at last month's rates; finalised month cannot be re-priced |

## 2. Bugs found and fixed

| Severity | Bug | Fix |
|---|---|---|
| **High, revenue** | A paid QRIS claim token never expired. Anyone holding the token (e.g. a screenshot of the QR) could start **unlimited free sessions** later, and a driver who paid and never plugged in kept a live token. | Claim tokens valid for 30 min (`PREPAID_CLAIM_WINDOW_MIN`); Authorize/Start re-check the payment. Retired when the money is refunded. |
| **High, 2.0.1** | Prepaid cut-off on OCPP 2.0.1 stations sent `transactionId: NaN`: the station never stopped, and the driver was charged past what they paid. | One helper (`registry.wireTransactionId`) for every command: string on 2.0.1, integer on 1.6. Used by prepaid stop and throttle, operator limits and driver stop. |
| **High, 2.0.1** | Load management's per-transaction profile had the same NaN id on 2.0.1, so the profile was rejected and the site could exceed its ceiling. | Same helper in `smartcharging.ts`. |
| **High, money** | Refunds were promised in the app ("sisa saldo dikembalikan") but nothing ever issued one. A paid-but-never-started payment sat in `captured` forever, flagged by nothing. | New refund flow (§3.1). |
| **Medium, ops** | A charger going offline was only an in-memory event: no record, no alert, no uptime figure. | Outage history, offline alert, availability report (§3.2). |
| **Medium, interop** | 2.0.1 `NotifyEvent`, `NotifyReport`, `MeterValues` and `ReservationStatusUpdate` got a NotImplemented error. Production 2.0.1 stations send these routinely, often right after boot. | Accepted; an Alerting monitor (over-temperature, RCD trip, tamper) becomes an operator alert. A unit test that wrongly asserted MeterValues doesn't exist in 2.0.1 was corrected. |
| **Medium, report** | Utilisation of **−2923%** in the new report, caused by a charger whose clock ran ahead (session after the window). | Intervals clipped to the window and floored at 0; test asserts every percentage is 0–100. |
| Low | Alerts raised in the API process lost their target, so they could not auto-resolve. | Stored with target type/id in both processes. |
| Low | Offline alert text named only the display name; several units share names. | Includes the OCPP identity. |

## 3. Gaps closed in this release

### 3.1 Refunds (Commercial → Refunds)
- `payment_intent` tracks `refund_state`: due → processing → refunded, or failed. The two sources:
  - unused prepaid balance after a session
  - a payment whose charge never started (worker sweep, claim window + 5 min)
- Finance pays out through the provider's refund API (idempotency key per payment), or records a bank transfer with its reference. A second refund of the same payment is refused. Every action is audited.
- The driver app shows "refund in progress" / "returned" on the session, receipt and history.

### 3.2 Availability and uptime (Operate → Availability)
- One `charge_point_outage` row per outage. Outages the gateway could not see (e.g. its own restart) are reconstructed from last-seen times.
- A charger offline longer than `OFFLINE_ALERT_MINUTES` (default 15), or its site's own threshold (Sites → Monitoring, 1–1440 minutes), raises **one** critical alert. It resolves itself when the charger reconnects.
- Report per charger: uptime %, outages, offline minutes, longest outage, sessions, kWh, revenue, utilisation, online now. KPIs and CSV export (formula-injection safe). Site-scoped users see only their sites.

### 3.3 Outbound webhooks (Govern → Webhooks)
- Events:
  - session.started / ended
  - cdr.created
  - charge_point.connected / disconnected / booted
  - connector.status_changed
  - alert.raised
  - refund.due / completed
  - firmware.status
- An outbox table gives at-least-once delivery, with back-off at 30 s, 2 m, 10 m, 30 m, 1 h, 3 h and 6 h (≈ 11 h). After that, a delivery is dead-lettered as *failed* and can be replayed from the console.
- `PlugSure-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")` plus `PlugSure-Delivery` (the event id, for de-duplication). The secret is sealed at rest (AES-256-GCM, `SECRETS_KEY`) and shown once, on create or rotate.
- SSRF protection in production:
  - https only
  - private, loopback and link-local addresses refused, checked **at connect time** (so DNS rebinding is covered)
  - redirects are not followed
- An endpoint is disabled only on sustained failure (50 in a row **and** no success for 24 h). A short receiver restart does not cut the integration.

### 3.4 Alert routing by e-mail, WhatsApp and SMS (Govern → Alert routing)
- **Channels.**
  - E-mail: any SMTP server (STARTTLS/TLS).
  - WhatsApp: the Business Cloud API (Meta) or a compatible BSP, using an approved Utility template.
    - **Delivery status:** each channel gets its own callback URL and verify token for Meta's webhook. Callbacks are checked against the app secret (`X-Hub-Signature-256`); delivered, read and failed (with Meta's reason) show in the log.
  - SMS: Twilio, Zenziva or your own gateway, as a channel of its own or as a **fallback**: when WhatsApp refuses a number, gives up, or Meta later reports the message failed, the same alert goes by SMS (to the contact's SMS number, or else their WhatsApp number). One SMS per alert and person.
  - Secrets are write-only and sealed; each channel has a test button.
- **On-call rotas:** people take daily or weekly shifts in turn, handing over at a local time; overrides cover leave and swaps (up to 92 days). The console shows who is on duty, until when, and who is next.
- **Rules:** severity, alert types, sites, channels, contacts and "whoever is on duty" on a rota (for the first message and for escalation).
  - Quiet hours hold warnings until morning; critical always goes.
  - "Resolved" messages go to everyone who was told.
  - Escalation goes to a second set of contacts when nobody acknowledges.
- **Paging hygiene:**
  - A repeat of the same open problem is folded into one alert.
  - Each person gets one message per alert, even when several rules match.
  - A flood guard caps messages at 20 per recipient per 15 min.
  - A fault that clears before sending pages nobody.
  - Connector faults resolve themselves.
- **Delivery log** with the provider's failure reason, and retry. Permanent failures (not on WhatsApp, template missing) fail at once.

### 3.5 OCPP 2.0.1 coverage and the device model (charger drawer → Device model)
See §2 for NotifyEvent, NotifyReport, MeterValues and ReservationStatusUpdate. The device model (migration 032):
- **Report.** "Request report" sends GetBaseReport (full inventory, configurable only, or summary). The station's NotifyReport parts are stored as they arrive, grouped by component, EVSE and connector. Each variable keeps:
  - its attributes (Actual, Target, MinSet, MaxSet), each with a value and a mutability;
  - its characteristics (data type, unit, limits, allowed values, and whether it can be monitored).

  The console shows "receiving… / complete" while the parts arrive.
- **Set and read.** Values are checked against what the station reported before SetVariables goes out:
  - whole numbers and decimals within their limits;
  - true/false;
  - a date and time;
  - one of the listed options, or a list of them (each value only once).

  Read-only and constant attributes are refused. Accepted and RebootRequired answers are stored, and RebootRequired is flagged. The refresh button reads one value now (GetVariables).
- **Protected.** The console never sets these; each has its own safe flow:
  - SecurityCtrlr variables (Security tab);
  - the network connection profile and its priority (Onboarding);
  - anything named like a password or key.
- **Monitors.** "Monitor…" on a variable that supports monitoring adds a monitor (SetVariableMonitoring) with a severity from 0 to 9:
  - an upper or lower threshold;
  - a change (delta);
  - a periodic reading, or one aligned to the clock.

  "Monitoring report" lists the station's own monitors (hard-wired, preconfigured and custom). Remove sends ClearVariableMonitoring.
- **Events.** A monitor in Alerting still raises one alert. The alert now **resolves** when the station reports the event cleared.
- 1.6 chargers keep the Configuration tab; the Device model tab says so.

### 3.6 Roaming over OCPI 2.2.1 (Commercial → Roaming)
- **PlugSure as the charge point operator.** Other networks' drivers charge on the operator's chargers; their provider (eMSP), direct or through a hub, is billed with a CDR per session.
- **Connecting:** the credentials handshake both ways. The partner registers with a one-time token from the console, or the operator registers with the partner's versions URL and token. Partners can be suspended, resumed and disconnected.
- **Shared per site:** locations with EVSEs, plugs and tariffs. Status changes are pushed within seconds (a fault is `OUTOFORDER`, an offline charger `UNKNOWN`); edits are republished within a minute. Only the partner's own sessions and CDRs can be pulled.
- **Tariffs:**
  - peak/off-peak windows, tiers, flat service fee, time and idle fees
  - PPN as `vat`
  - PBJT-TL in the alt text; the CDR carries the exact total, with `excl_vat` = subtotal + PBJT-TL by default
- **Drivers:** pushed tokens are accepted at the charger ("pre-approved"), or checked with the partner in real time (`NEVER`, 5 s limit). The operator's own cards always take precedence. Works on OCPP 1.6 and 2.0.1.
- **Commands:** START_SESSION, STOP_SESSION, UNLOCK_CONNECTOR, RESERVE_NOW and CANCEL_RESERVATION, with the charger's outcome POSTed to the partner. A partner may stop and unlock only for its own drivers.
- **Delivery:** an ordered outbox with back-off; each body is rendered when sent. A CDR the partner refuses raises an alert and can be replayed.
- **Security:** partner tokens stored hashed and sealed; hub routing headers checked; partner URLs go through the webhook SSRF guard; every call is logged.
- **Verified by `npm run e2e:ocpi`: 74/74 checks** against a mock eMSP and a raw charger.
- **The eMSP role too:** the operator's RFID and fleet cards charge on other operators' networks.
  - Cards are shared per card with an eMAID-style contract id. Limited cards must be checked with PlugSure in real time, and limits count roaming charges.
  - CPOs push their network, our drivers' sessions and CDRs. CDRs are immutable and exportable as CSV to bill fleets.
  - The console can start and stop charges at a CPO's charger.
  - In the driver app, fleet drivers with a roaming card find partner chargers, start and stop charges there, and see the operator's charge record and history.
  - Fleet drivers can also **reserve** a partner charger for 15 minutes (OCPI RESERVE_NOW with their card; CANCEL_RESERVATION to cancel), with the charger's answer, a countdown, reminders and one reservation at a time (migration 034).
  - **Verified by `npm run e2e:ocpi-emsp`: 60/60 checks** against a mock CPO, including the driver app and reservations.
- **Partner smart charging (OCPI ChargingProfiles, CPO role; migration 036):**
  - A partner can set, read and lift a charging limit on its driver's session.
  - The limit caps the session inside site load management, which still sends the only transaction profile. So a partner can slow a session down but never push it past the site budget, the PLN subscription or the station ceiling.
  - Applied at once. Schedules of up to 200 steps, absolute or counted from the start of charging.
  - The charger's result goes to the partner's response_url. The limits in force are listed under Roaming sessions.
- **Hubs (OCPI HubClientInfo):**
  - The parties behind a hub, and their status, arrive when the hub pushes them. They are also pulled in full after registration, every 6 hours and on demand.
  - Once a hub has sent its list, it may only act for parties on it that are CONNECTED or OFFLINE.
  - **Verified by `npm run e2e:ocpi-profiles`: 36/36 checks** with a raw charger, a mock service provider and a mock hub.

### 3.7 Driver app: map, favourites, push notifications, reservations, queue
- **Map:** a Daftar | Peta switch on Stations. Markers show free connectors; partner sites appear for roaming fleet cards. Tap a marker for the station card. Stations that would overlap are grouped into a numbered bubble; tapping it zooms in until they split, or lists them when they share one spot. Pan, pinch and "my location" work. Tiles come from `MAP_TILE_URL` (OpenStreetMap by default), and the CSP follows that host.
- **Favourites:** a star on station and partner-site screens, and a Favorit section on Home. Stored per phone and per signed-in account, so they follow the driver to a new phone.
- **Push notifications:** standard Web Push, with no app store.
  - Sent for: charging started and finished, receipt ready, refund paid, a partner network's charge record, and a reservation's reminder and end.
  - Messages follow the app language and open the right screen.
  - Payloads are encrypted to the phone (RFC 8291). They are signed with a VAPID key (RFC 8292) that is generated once and sealed in the database.
  - Delivery is a gateway outbox with retries; subscriptions the push service reports gone are removed. In production, only the known push services are reachable (SSRF guard).
- **Reservations:** signed-in drivers reserve a connector for 15 minutes.
  - The charger gets `ReserveNow`; cancelling sends `CancelReservation`.
  - Other drivers see *Reserved* and cannot pay for the connector.
  - The reserved idTag is the one the holder pays with or taps, so the charger honours it.
  - Limits: one reservation per driver, and a pause after 2 no-shows a day.
  - A reservation ends with a push, and it shows as `RESERVED` to roaming partners.
- **Verified by `npm run e2e:driver-plus`: 46/46 checks.** The test uses a raw OCPP 1.6 charger and a mock push service. The mock decrypts every notification with the test's own subscription keys and verifies the VAPID signature against the published key. Reminder and expiry are covered by moving the clock in the database; a push service's `410 Gone` removes the subscription.
- **Reservation fees** (migration 035), per site and off by default:
  - App drivers pay the fee (with PPN where the operator is PKP) before the connector is held. Fleet cards' fees go on the fleet invoice, PDF, CSV and e-Faktur.
  - Kept once the connector is held. Refunded, or left off the invoice, when the charger refuses, the connector was taken meanwhile, or the driver cancels within 2 minutes.
  - **Verified by `npm run e2e:reservation-fees`: 12/12 checks.**
- **Queue at busy sites** (migration 033), off until switched on per site (Sites → Edit site → Driver queue):
  - A signed-in driver who finds every suitable connector taken joins from the station page. They may pick AC/DC and a plug type, or take any connector.
  - First come, first served: a freed connector goes to the earliest waiting driver who can use it. The charger holds it for them (ReserveNow) for the *time to start* (2–15 min, default 5). Meanwhile the app refuses to pay for or reserve it for anyone else.
  - The driver starts as with a reservation, or skips. Not taken in time, the driver misses the turn, the connector goes to the next driver, and nobody waits past the *longest wait* (default 120 min).
  - Push at each step. The console shows the queue live, the last 24 hours and the median wait; an operator can remove a driver (audited).
  - **Verified by `npm run e2e:queue`: 19/19 checks** with a raw OCPP 1.6 charger and four drivers.
### 3.8 Published API and developer sandbox (Govern → Developers)
- **OpenAPI 3.1:** served at `/openapi.json`, with a readable reference with "Try it" at `/api-docs.html`.
  - It covers 182 operations in 25 groups, with request and response schemas, error statuses, and the permissions each handler checks.
  - The 11 webhook events are included, with the envelope and the signature header.
  - It is generated from a catalogue next to the code, so it cannot drift. A unit test compares it with the registered routes, and the sandbox end-to-end test validates live responses against it.
- **Sandboxes:** separate tenants, up to 3 per operator.
  - Each has a site, a tariff, RFID cards and two virtual chargers that speak real OCPP 1.6 inside the gateway, plus its own API key.
  - Everything behaves as in production: commands, sessions, receipts, alerts and webhooks.
  - A simulation endpoint acts out a card tap, a fault, a dropped 4G link or a reboot.
  - Isolation: sandboxes never appear in the driver app, in roaming or in platform billing, and cannot be reached from the network.
- **Found while documenting:** a malformed id answered 500 and now answers 400. A command to an offline charger answered 500 and now answers 409.
- **Verified by `npm run e2e:api-sandbox`: 38/38 checks**, including a contract check of 56 GET operations against the published schemas.
- **TypeScript SDK** (`@plugsure/csms-sdk`, Govern → Developers):
  - It is generated from the document, with one typed method per operation and no dependencies.
  - It retries a request refused for the rate limit after the wait the API asks for, and checks webhook signatures.
  - A unit test holds it to the document.
- **Per-key rate limits** (migration 037):
  - Each API key has its own token bucket: 600 a minute by default, or set per key. Every answer to a key carries RateLimit headers; over the limit it gets 429 with Retry-After.
  - Usage is shown per key, for the last 24 hours and by hour.
  - Guessed keys are refused after 30 a minute per address, while valid keys keep working.
  - **Verified by `npm run e2e:sdk`: 23/23 checks** with the built SDK against the running API.

### 3.9 Fleet monthly statements, B2B invoices and e-Faktur (Commercial → Fleet billing)
- **Fleet accounts:** the company each fleet card is billed to, with legal name, NPWP/NIK, NITKU, billing e-mails and payment terms. A card's fleet name links it to its account through a database trigger.
- **Monthly invoice per account:**
  - Charging at the operator's stations, grouped per site with PBJT-TL at the site's rate. The price subject to PPN, DPP nilai lain (11/12) and PPN 12% are computed per line, the figures the faktur carries.
  - Partner-network charging is re-billed at cost, off the faktur.
  - Invoices are issued after the month ends and numbered `PREFIX/YYYY/MM/NNNN`. Each is frozen, and a session is never billed twice.
  - Void and re-issue, payments with overdue tracking, a **PDF invoice** (A4, generated by the server: parties, lines per site, DPP/PPN, credits and the amount due, how to pay, and an appendix of every card and session), a printable HTML copy and CSV, and e-mail with the PDF and CSV attached through the organisation's SMTP channel.
- **Credit notes** (numbered `PREFIX-CN/YYYY/MM/NNNN`, with a PDF): all or part of an issued or paid invoice; the invoice itself never changes.
  - Amounts include PPN; a line with PPN is split into DPP (11/12) and PPN (12% of DPP) like an invoice line. A credit can never take back more than the invoice charged, in total, DPP or PPN, or more of its untaxed part.
  - Unpaid invoice: the credit reduces what is owed and settles the invoice when nothing is left. Paid invoice: refunded (recorded when paid out) or deducted from the account's next invoice.
  - A warning when the invoice's faktur pajak was already reported, since a nota pembatalan is then needed in Coretax. Void a credit note issued in error while nothing has been done with it.
- **Fleet customer portal:** the customer's own staff sign in (role *Fleet customer*, granted per fleet account).
  - They see what they owe, their invoices and credit notes as PDF, this month so far, and their cards.
  - They can block a lost card, and unblock only one they blocked.
  - Their grant carries a single `fleet:portal` permission that no operator route accepts, and every portal route checks their own account.
- **e-Faktur:** Coretax bulk-import XML, transaction code 04, one line per site.
  - Buyers without NPWP/NIK are skipped and named.
  - Export is blocked until the seller NPWP/NITKU and the item classification are saved and confirmed with a tax adviser.
  - The Coretax faktur number is recorded back on the invoice.
- **Verified by `npm run e2e:fleet-billing`: 53/53 checks** in a sandbox, on real OCPP sessions at two sites with different PBJT rates. The run covers:
  - invoice lines against the session receipts (rounding difference 0)
  - the XML's DPP and PPN against the invoice
  - e-mail to a local SMTP server
  - void and re-issue without double billing, and payment
  - the invoice and credit notes as PDF (text checked)
  - partial and full credits: the tax split, settling and re-opening an invoice, refunds, and deduction from the next invoice
  - the portal: invite and sign-in; own invoices and PDFs; other accounts 404; operator pages 403; blocking and unblocking a card, but never one the operator blocked
  - live responses against the published schemas
- **To confirm before production:** import the first XML file into Coretax, since the DJP template changes from time to time. Also check with the tax adviser whether EV charging is goods (A) or services (B), and its code.

### 3.10 Promotions, memberships and passes (Commercial → Promotions & plans)
- **Discounts at rating:** applied after the regulatory caps and before PBJT-TL and PPN, as named negative lines on the receipt. Each session gets the membership plus at most one promotion, choosing whichever allowed combination is cheapest for the customer, judged at the session's start.
- **Membership plans:** a monthly fee with any of a member price per kWh, % off energy, included kWh and a waived service fee, optionally for AC/DC or chosen sites only.
  - Fleet accounts or cards are enrolled in the console. Their fee goes on the monthly fleet invoice with PPN, and as its own e-Faktur line with its own item classification. **A membership in force for part of a month is billed for its days** (e.g. "10 of 30 days").
  - Drivers buy a plan in the app as a 30-day pass (QRIS, e-wallet or card), with a reminder before it ends.
  - **Automatic renewal** with a saved card or linked e-wallet: the pass renews a day before it ends. A PIN or 3-D Secure step waits for the driver, who is told. A decline is retried at 1, 6 and 12 hours. A removed card, an ended link or a plan no longer offered stops renewal, with the reason.
  - **Switching plans** credits the unused value of the current pass. A dearer plan costs the difference now; a cheaper one is free and runs longer. The switch takes effect when paid, so an abandoned payment never costs the driver their pass. The charges it replaces end at the switch, so nothing is credited twice.
- **Loyalty points** (Loyalty tab): drivers signed in to the app earn points on what each session costs them.
  - Those who choose to use them have points taken off their next sessions automatically, as a discount line before PBJT-TL and PPN, up to a set share of the energy and fees.
  - Points are spent oldest first and expire after a set number of months. The receipt shows points used and earned.
  - The console shows the points outstanding and what they are worth (a liability), the top holders (phones masked), and allows goodwill adjustments.
- **Promotions:** % off, promo price per kWh, rupiah off, free kWh or waived fees. The audience is everyone, new drivers, fleet accounts, plan members or a promo code. They can be limited by dates, weekdays, a time window, sites, AC/DC, minimum kWh, total and per-customer uses, and a budget, with usage statistics.
- **Driver app:** a promo code on the charge screen. The quote and the prepaid allowance use the best discount, and the membership section shows the kWh left.
- **Verified by `npm run e2e:pricing`: 24/24 checks, and in `npm run e2e:card-holds` (38/38).**
  - On real OCPP sessions in a sandbox: member price, included kWh, waived fee and a stacked happy hour; the tax on the discounted price; per-customer limits; the fee on the fleet invoice and e-Faktur.
  - In the driver app: codes, QRIS passes, renewal, and the switch quote.
  - A card membership for 10 days of the month, billed for those days.
  - Automatic renewal by the worker with the saved card; nothing charged twice; renewal stopping when the card is removed.
  - Switching up (the difference paid) and down (free and longer, without double credit).
  - Loyalty: earned on a session, spent on the next as a discount before tax, shown on both receipts, adjusted in the console, and expired.
  - Live responses against the published schemas.
- **Not built:** promotions on roaming sessions, vouchers, and points on fleet-card sessions (points belong to app accounts). Unattended renewal on Midtrans needs saved-card 3-D Secure off (`savedCard3ds: false`); otherwise every renewal waits for the driver.

### 3.11 ISO 15118 Plug & Charge, CSMS side (Operate → Plug & Charge)
- **Charger messages:** OCPP 2.0.1 natively, and OCPP 1.6 through DataTransfer (OCA application note):
  - Authorize with an eMAID and a contract certificate (the chain, or the hash data of a chain the charger checked);
  - GetCertificateStatus (OCSP for the car);
  - Get15118EVCertificate (contract certificate installation or update, passed to the PKI);
  - SignCertificate / CertificateSigned for the charger's V2G certificate.
- **Contract authorisation:** the certificate first — its chain to the operator's MO roots, expiry, and OCSP at the responder named in it — and then the contract.
  - A contract is a token of kind `emaid`, so card limits, fleet accounts and memberships apply.
  - Partners' contracts are matched through their roaming tokens.
  - An unreachable OCSP responder is accepted or refused according to a setting.
- **Charger certificates and trust stores:**
  - V2G certificates are signed by the PKI or the operator's Vault sub-CA, delivered, shown with their expiry, and renewed 30 days before they expire, with an alert a week before.
  - Trust anchors (V2G and MO roots) are fetched from the PKI or uploaded, and installed on chargers. The installed certificates can be read and deleted.
  - Plug & Charge is switched on per charger (`ISO15118PnCEnabled` / `ISO15118Ctrlr.PnCEnabled`).
- **Developers:** a test PKI (not in production) with OCSP. Sandbox virtual chargers speak Plug & Charge, and the simulate event `plug-and-charge` brings a car.
- **Security:** OCSP URLs come from certificates, so requests to them pass the SSRF guard. DER, X.509 and OCSP are handled on Node's crypto with no new dependency, and cross-checked with OpenSSL in tests.
- **Verified by `npm run e2e:pnc`: 37/37 checks**, with raw 2.0.1 and 1.6 chargers and a sandbox virtual charger.
- **Found while building:** commands to a 2.0.1 station that the API had not yet seen through the bridge went out in 1.6 form. Fixed.
- **To go live:**
  - a V2G PKI provider (Hubject or similar) with a CPO agreement, reached through the PKI gateway (deploy/README.md);
  - 15118-capable chargers with Plug & Charge firmware;
  - a test on each charger model.

### 3.12 Onboarding with automatic charger certificates (Operate → Onboarding)
- **Onboarding page:**
  - chargers in progress and where each one is: waiting, refused at the handshake with the reason, awaiting activation, getting a certificate, connected;
  - every charger's client certificate, with renewal;
  - the certificate authority, with its download and the Caddy settings.

  The wizard takes the hardware details, site, credentials and connectors, then watches the charger connect.
- **Security Profile 3 certificates from PlugSure's own charging-station CA**, three ways:
  - key and certificate generated at onboarding (the bundle is downloaded once, the key not stored);
  - the charger's own CSR signed;
  - zero-touch over OCPP: Profile 2 → CSR → CertificateSigned → SecurityProfile 3.

  CN = the OCPP identity, and the fingerprint is bound to that one charger.
- **Renewal:** over OCPP before expiry, with an alert two weeks before. The previous certificate is accepted until the new one is used, so a renewal cannot lock a charger out.
- **Found and fixed:**
  - The shipped Caddyfile let a charger forge `X-Client-Cert-Fingerprint` under `OCPP_TRUST_PROXY_PROTO=true`; it now assigns it.
  - The gateway's own TLS never requested client certificates.
- **Verified by `npm run e2e:onboarding`: 19/19 checks**, including real Profile 3 connections accepted and refused, and the zero-touch switch.
- **Not built:** PKCS#12 bundles, automatic profile raise on 2.0.1 (SetNetworkProfile), and revocation lists for charger certificates.

### 3.13 Integrations (Govern → Integrations)
- **Console-managed integrations** with secrets sealed and write-only, connection tests, an activity log and audit:
  - the QRIS acquirer, per operator with a platform default;
  - driver sign-in codes, with a fallback;
  - the Plug & Charge PKI;
  - map tiles.
- **QRIS:** Midtrans, Xendit and bank-direct BI-SNAP adapters.
  - Console checkout, the driver app and app passes create charges at the acquirer.
  - Payments are confirmed only by signed notifications at `/pay/notify/<key>`: captured once and for the full amount.
  - Refunds go through the acquirer where it offers them.
  - Switching acquirer archives the old account, so its payments keep their notifications and refunds.
- **Sign-in codes:** WhatsApp Cloud API (authentication template), Twilio, Zenziva or your own gateway, with a fallback channel. Codes are shown on screen only in development.
- **Verified by `npm run e2e:integrations`: 21/21 checks** against local fakes of each provider.
- **To go live:** sign with the providers, enter the credentials, paste the notification URL into the acquirer's dashboard, and test each in its sandbox. The adapters follow the providers' published APIs; confirm field names in each sandbox, the bank SNAP paths in particular.

### 3.14 E-wallet and card payments
- **Methods:** GoPay, ShopeePay, OVO, DANA, LinkAja and credit/debit cards beside QRIS, for charges and 30-day passes, in the same pre-purchase model (fixed amount, signed notification, unused balance refunded).
- **Per acquirer:**
  - Midtrans: GoPay and ShopeePay (Core API deeplinks), cards through Snap with 3-D Secure.
  - Xendit: OVO (push to the phone), DANA, ShopeePay and LinkAja (e-wallet charges), cards through invoices.
  - Bank-direct SNAP stays QRIS only.
- **Operators** choose the methods per acquirer (default QRIS only). The driver app offers only those, and the server refuses any other.
- **Card data never reaches PlugSure:** cards are paid on the acquirer's hosted page, so PlugSure stays out of PCI DSS card-data scope.
- **Refunds:** by API where the acquirer offers one (Midtrans for every method; Xendit for e-wallets, using the stored charge id); otherwise by bank transfer, with a clear message.
- **Verified by `npm run e2e:payment-methods`: 21/21 checks** against local fakes, plus 12 adapter unit tests.
- **Not built:** linked e-wallets (tokenisation), virtual accounts, instalments.

### 3.15 Card pre-authorisation (holds) and saved cards
- **Holds:** a card payment for charging holds the chosen amount; the rated total is captured and the rest released at once.
  - A zero-energy session, or a hold never used within 35 minutes, is released entirely (its claim token stops working). No refund queue for cards.
  - Captures and releases run after rating, off the charger's path. Automatic retries with back-off; Refunds → Card holds with Retry now; a critical alert after the last try.
- **Saved cards:** signed-in drivers save a card while paying.
  - Only the acquirer's token (sealed), brand, last four and expiry are stored, so PCI DSS card-data scope is unchanged.
  - One-tap payments for charging (as holds) and passes (as sales).
  - Bound to the driver and to the operator's acquirer account; removable in the app; never shown to operators.
- **Acquirers:** Midtrans (Snap authorize, capture, cancel, saved_token_id, One Click or 3-D Secure again) and Xendit (Payments API v3 sessions, manual capture, payment tokens). The sandbox supports both.
- A saved card whose token has ended at the acquirer (Midtrans 411, Xendit token expired or cancelled) is refused with a message naming it and no longer offered.
- A hold whose authorisation expired before capture ends at once with a critical alert, "expired, not charged" in the console with the amount to collect, and a receipt that says nothing was taken. The driver pays it from the receipt in the app with any offered method (a separate settlement payment, migration 028); once paid, the console shows "expired, paid in app" and the alert resolves, and a second payment for the same hold is refunded.
- **Verified by `npm run e2e:card-holds`: 38/38 checks** on real OCPP sessions, plus 9 adapter unit tests.
- **Not built:** raising a hold that runs short, holds for fleet sessions, card entry on PlugSure pages, network tokens and card updater.

### 3.16 Linked e-wallets (GoPay, OVO, DANA, ShopeePay, LinkAja)
- **Link once, pay in one tap:** signed-in drivers link GoPay (Midtrans GoPay Tokenization) or OVO / DANA / ShopeePay / LinkAja (Xendit reusable payment methods), approving in the e-wallet app. Later charges and passes need no redirect (the PIN only when the e-wallet asks).
- **Charge now, refund automatically:** the chosen amount is charged as a pre-purchase; unused balance (or an unused payment) is refunded automatically through the acquirer, with no operator action.
- **Safety:** links are bound to the driver and the operator's acquirer account; tokens are sealed; guests cannot link; unlinking also unlinks at the acquirer.
- **Verified by `npm run e2e:linked-wallets`: 19/19 checks** on real OCPP sessions, plus 6 adapter unit tests.
- **Not built:** ShopeePay linking through Midtrans (Midtrans tokenises GoPay only). GoPay is now offered through Xendit too (v3: one-time and linked).

### 3.17 Post-pay with linked e-wallets
- **Optional:** sessions start with nothing charged; the chosen amount is the limit; the rated total is charged to the linked e-wallet afterwards (no refunds).
- **Guards:** the operator's per-session limit (larger amounts charged up front); a balance check before starting for GoPay (Midtrans: the active wallet, else GoPay Tabungan, never PAY_LATER, with the token refreshed before each charge; or Xendit's token_details; a GoPay, OVO, DANA, ShopeePay or LinkAja link ended in the e-wallet app or expired tells the driver to link it again, and an unpaid session, whether its link ended, the balance was not enough, it waits for the PIN or the PIN expired, was denied or was cancelled, can be paid in the app with another method; a payment that arrives after it is paid otherwise is refunded; the app shows unpaid sessions and Web Push reminds the driver (no WhatsApp reminder: that needs a template and opt-in); an unpaid session's tax receipt is issued as a nil transaction until paid (to confirm with the tax adviser); Xendit's link callbacks end or activate links at once; Xendit's failure codes are checked against its published reference only, not its sandbox) and OVO / DANA / ShopeePay / LinkAja (Xendit, where reported), optionally post-pay only when the balance can be checked; no new post-pay session while one is unpaid (the next payment is taken up front).
- **Collection:** automatic retries; "Bayar sekarang" on the driver's receipt (with the e-wallet PIN when asked, settled by the acquirer's notification); Refunds → Holds and post-pay with Retry now; a critical alert after the last try.
- **Verified by `npm run e2e:postpay`: 40/40 checks** on real OCPP sessions.
- **Not built:** collecting an unpaid session by other means. Which Xendit e-wallets report a balance must be confirmed in Xendit's sandbox.

### 3.18 ISO 15118-20 and bidirectional charging (V2G / V2B, OCPP 2.1; migration 038)
- **OCPP 2.1** is a protocol of its own (enabled in `OCPP_VERSIONS`), with its wider enumerations. Chargers are registered and booted as 2.1.
- **The car's needs.** ISO 15118 charging needs (NotifyEVChargingNeeds, 2.0.1 and 2.1) are stored per session:
  - energy transfer modes, including bidirectional DC_BPT / AC_BPT;
  - control mode, departure, energy and SoC;
  - charge and discharge power.
  The car's schedule, external charging limits and reported profiles are accepted too. Export registers and SoC are tracked beside the billed import.
- **The site's programme.** Hours, a limit, a battery floor and the driver's credit per kWh. Without a PLN export agreement, discharge is capped at the site's own auxiliary load, so nothing flows back to the grid.
- **Consent.** Nothing discharges without it: the driver's (in the app, with their own floor) or the fleet's standing consent.
- **Load management** plans discharge each pass and sends OCPP 2.1 discharge setpoints (CentralSetpoint). It stops at the floor, an hour before departure, outside the hours, and on withdrawal. The station is told the allowed transfer modes.
- **The bill.** The credit comes off the session before tax.
- **Verified by `npm run e2e:v2x`: 21/21 checks** with a raw 2.1 station.
- **Sandbox:** the virtual 2.1 chargers offer DC_BPT and AC_BPT, so V2G can be tried end to end without hardware (§ 3.19).
- **Not built, and why:**
  - **Grid-code functions** (frequency and voltage support, OCPP 2.1 DER control) and **price schedules sent to the car** (15118-20 dynamic mode):
    - their parameters come from a grid code, and Indonesia has no published DER grid code for EV chargers;
    - they need a certified inverter-grade 2.1 charger to test.
    - Build them when a PLN or DSO programme defines them.
  - **Market settlement of exported energy:**
    - PLN is the single buyer, so there is no market a CPO can sell into;
    - rooftop-PV net metering (Permen ESDM 2/2024) does not credit exports and does not cover EV discharge.
    - The credit stays the operator's own.
- **Before live use:** bench-test each car and charger pair. AC_BPT runs in the sandbox, but has not been tried on AC bidirectional hardware, which is still rare.

### 3.19 Signed meter values (OCMF) and the sandbox over OCPP 2.0.1 / 2.1 (migration 039)
- **Signed meter values:**
  - OCMF readings are read from 1.6 `SignedData` and 2.x `signedMeterValue`;
  - they are verified (ECDSA P-256 / SHA-256) against the meter key registered on the connector;
  - they are checked against the billed energy (2 Wh tolerance) and the connector's meter serial.
- **Outcome per session:**
  - statuses: `verified`, `unverified_key` (only the charger's own key), `mismatch`, `invalid`, `incomplete` or `missing`;
  - per-site policy: `off`, `record` (warn) or `require`, which parks unverified sessions before invoicing.
- **Where it shows:**
  - the receipt, the driver app and a console tab;
  - a Transparency Software XML download;
  - OCPI CDR `signed_data`.
  Signing on 2.x stations is switched on with SetVariables.
- **Sandbox:**
  - virtual chargers now speak the protocol they are registered with (1.6, 2.0.1 or 2.1);
  - each has a signing meter, with its key registered automatically;
  - on 2.1 the virtual car is bidirectional (DC_BPT / AC_BPT).
- **Bugs fixed:**
  - a 1.6 `SignedData` sample was parsed as `NaN` and could become the final register reading;
  - an AC car's first SoC (from a meter value) did not re-plan discharge.
- **Verified by `npm run e2e:ocmf` (20/20)** with raw 1.6 and 2.0.1 chargers, and **`npm run e2e:sandbox-2x` (17/17)** with virtual 2.0.1 and 2.1 DC / AC chargers.
- **Not built:**
  - other signed formats (EDL, DLMS): stored as `unsupported`;
  - an embedded Transparency Software viewer: the XML is for the official tool.

### 3.20 White-label driver apps (migration 040)
- **One app, many brands:** an operator's own driver app is PlugSure's driver app rendered per request, with the operator's name, tagline, colours, icon, support contacts and legal pages. It shows only that operator's stations, so every fix reaches every brand at once.
- **Colours:** one accent colour is checked against WCAG AA (4.5:1) on every surface of both themes and nudged until it passes. The console shows the colours as used.
- **Icons:** from one uploaded PNG come the launcher, maskable, iPhone and App Store sizes, made without an image library.
- **Scope:** another operator's charger is named as such when scanned or opened, and refused before any payment.
- **Serving:**
  - a draft is previewed at `/app/?brand=` and shown live in the console;
  - a live app runs on the operator's own web address, with an on-demand TLS certificate that Caddy requests only after the API confirms the name;
  - the address serves Digital Asset Links and the Apple app-site association.
- **Store builds:** a build kit holds:
  - an Android Trusted Web Activity project (Bubblewrap) with a CI workflow;
  - an iOS Capacitor shell;
  - icons, store listings (Indonesian and English) and data-safety answers.
- **Verified by `npm run e2e:brand` (28/28)** and 8 unit tests.
- **Not built:**
  - the store builds themselves: they need the operator's developer accounts, signing keys, an Android SDK and a Mac;
  - native push in the iOS shell: added in § 3.21;
  - custom fonts;
  - more than one brand per operator.

### 3.21 Native iOS notifications through APNs (migration 041)
- **What drivers get:** the white-label iOS app gets the same notifications as the web app, natively. The operator's APNs key (`.p8`) is stored encrypted and checked with Apple from the console without notifying anyone.
- **Delivery:** the gateway sends over HTTP/2 with an ES256 provider token (no library):
  - a development (Xcode) token is found on the development server and remembered;
  - uninstalled apps' tokens are dropped;
  - a refused key is flagged in the console and retried, not blamed on the phones.
- **The app:** it registers through Capacitor's PushNotifications plugin, and the build kit carries the plugin, the capability and the AppDelegate hooks.
- **Verified by `npm run e2e:apns` (15/15)** against a stand-in APNs server that checks provider tokens as Apple does, and 4 unit tests.
- **Not built:**
  - badges and rich notifications: added in § 3.22;
  - silent pushes;
  - a run on a real iPhone against Apple (needs a Mac, the Apple account and a device).

### 3.22 Badges and rich iOS notifications
- **Badge:** the app icon counts sessions waiting to be paid in that operator's app. Every notification carries the count, and a badge-only update follows a payment.
- **Rich notifications:**
  - the site as a subtitle;
  - buttons: stop charging, view receipt, pay now, give up my turn, cancel reservation;
  - time-sensitive "your turn" and reservation reminders;
  - on "charging finished", a picture of the charge (energy, time, peak and power curve, in the brand's colour), drawn without libraries, from a signed, expiring address. Chrome's Web Push shows it too.
- **The kit** carries the category registration and the Notification Service Extension.
- **Verified by `npm run e2e:apns` (20/20)** and 4 more unit tests.
- **Not built:**
  - Live Activities: added in § 3.23;
  - buttons on Web Push;
  - compiling the Swift files, which needs a Mac.

### 3.23 Live Activities (migration 042)
- **What is shown:** a charge under way on the iPhone's lock screen and in the Dynamic Island, with energy, power, battery or prepaid progress, and the time (counted on the phone). Then "finished", and the final cost for 30 minutes.
- **How it starts:** the app starts it for a charge started in the app. On iOS 17.2+, PlugSure starts it by push for a charge started without the app, once per phone and session.
- **Updates:** the gateway sends them within Apple's budget: the first at once, then only real changes, at most every 30 s at low priority, with a stale date and a heartbeat. Dismissed activities are dropped.
- **The kit:** the widget extension, the attributes, a Capacitor plugin and its registration.
- **Verified by `npm run e2e:live-activity` (14/14)** and 3 unit tests.
- **Cost during the charge (added):** the cost so far on the lock screen and in the driver app for every payment mode, priced by the same function as the charge record, idle fee included. `e2e:live-activity` now 17/17; see RELEASE-NOTES-v1.3.0.md, *Cost during the charge*.
- **Not built:**
  - compiling and running the Swift on a device.

## 4. Comparison with commercial platforms


Compared with the publicly documented capabilities of ChargePoint, Driivz, AMPECO, Monta, Virta, EV Connect and Shell Recharge (Greenlots). ● = has it, ◐ = partial, ○ = missing.

| Capability | Typical in commercial CSMS | PlugSure v1.3 |
|---|---|---|
| OCPP 1.6J (Security Profiles 0–3) | ● all | ● |
| OCPP 2.0.1 core | ● most (Driivz, AMPECO, Monta, Virta) | ● core + device events + ISO 15118 certificate messages + device model (report, set/get variables with validation, monitors) + charging needs and smart-charging messages |
| OCPP 2.1, ISO 15118-20 bidirectional charging (V2G / V2B) | ◐ few, mostly pilots | ● new: 2.1 protocol, charging needs, per-site discharge programme capped at the site's own load by default, driver and fleet consent, discharge setpoints from load management, credit before tax |
| Remote ops, config, FOTA, diagnostics | ● all | ● |
| Charger onboarding and certificate provisioning | ● all | ● new: onboarding page and wizard; Profile 3 certificates issued by PlugSure's CA (generated, CSR, or zero-touch over OCPP) and renewed without lock-out |
| Field robustness (offline tx, retries, meter reset, clock skew) | ● all | ● verified by the field test |
| Smart charging / DLM | ● all | ● incl. genset curtailment and PLN kVA guardrail |
| Uptime / availability reporting and offline alerts | ● all | ● new in this release |
| Tariffs: ToU, idle fee, session fee | ● all | ● incl. PPN/PBJT-TL tax receipts (local advantage) |
| Ad-hoc payment (QR/card) | ● all | ● QRIS through Midtrans, Xendit or a bank (BI-SNAP), plus GoPay, ShopeePay, OVO, DANA, LinkAja and cards (hosted 3-D Secure page) through Midtrans or Xendit, chosen per operator, with signed notifications and refunds; card pre-authorisation (capture what was used), saved cards (acquirer tokens, one tap) and linked GoPay / OVO / DANA / ShopeePay / LinkAja (one tap, automatic refunds, optional post-pay); ◐ needs the operator's acquirer contract |
| Refunds | ● all | ● new; provider API or recorded bank transfer |
| Webhooks | ● Monta, AMPECO, Driivz, EV Connect | ● new |
| Alert notifications (e-mail / SMS / chat), on-call escalation | ● all | ● new: e-mail, WhatsApp (with delivery status) and SMS (or SMS fallback), on-call rotas with overrides, quiet hours, escalation, acknowledge, per-site offline thresholds |
| Driver app (find, pay, charge, receipt) | ● all | ● PWA with station map, favourites and push notifications (Web Push), incl. partner network for roaming fleet cards |
| Driver login by SMS/WhatsApp OTP | ● all | ● WhatsApp (Meta Cloud API), Twilio, Zenziva or your own gateway, with a fallback, set in the console; ◐ needs the provider account |
| RFID / fleet cards, limits, local lists | ● all | ● |
| Multi-tenant RBAC, site-scoped hosts, audit trail | ● all | ● tamper-evident audit chain |
| **OCPI 2.2.1 roaming** | ● all (Hubject/Gireve/e-clearing) | ● both roles, direct or via a hub (new): other networks' drivers here (CPO), your fleet cards there (eMSP), partner smart charging (ChargingProfiles) and hub client lists (HubClientInfo); certification with a real hub pending |
| **ISO 15118 Plug & Charge** | ● Driivz, AMPECO, ChargePoint | ● new, CSMS side: contract authorisation with OCSP, V2G certificate issuance and renewal, trust-store management, OCPP 2.0.1 and 1.6; ◐ needs a V2G PKI provider behind the PKI gateway |
| Signed meter values (Eichrecht / OCMF) | ● EU-focused platforms | ● new: OCMF verified against the registered meter key and the bill, per-site record / require policy, receipt, Transparency Software XML, OCPI `signed_data`; tera certification tracked beside it |
| Fleet / B2B invoicing and statements | ● all | ● new: fleet accounts with NPWP/NITKU, monthly invoices (PPN per line on DPP nilai lain, partner networks re-billed), e-mail, payments, Coretax e-Faktur XML, PDF invoices, credit notes, fleet customer portal |
| Site-host / owner portal with revenue share | ● ChargePoint, AMPECO, Driivz, Monta | ● new: owner login (read-only, own sites), per-owner statements with owner and operator shares, operator Billing across owners |
| Platform billing of the operator's customers (commission, minimums, platform fees) | ● all (per-site revenue share) | ● new: published tiers, per-charger minimum, private fees, versioned plans, finalised statements |
| Reservations (driver-facing) | ● most | ● new: 15-minute reservations in the app (ReserveNow / CancelReservation), no-show limit, and on partner networks for roaming fleet cards (OCPI RESERVE_NOW); reservation fees per site (paid in the app, or on the fleet invoice) |
| Queue / waitlist | ◐ some (ChargePoint Waitlist) | ● new: per-site first-come-first-served queue; a freed connector held on the charger for the next driver, missed turns passed on, walk-ups kept out |
| Promotions, member pricing, subscriptions | ● AMPECO, Monta, Driivz | ● new: membership plans (member price, % off, included kWh, no service fee) for fleets on the invoice and drivers as QRIS passes; promotions with codes, happy hours, audiences, limits and budgets; automatic pass renewal, proration and loyalty points |
| White-label driver app | ● AMPECO, Monta, Driivz | ● new: the operator's name, colours (contrast-checked), icon set and web address, only its stations, a live console preview, a Play Store / App Store build kit (TWA + Capacitor), and native iOS notifications (APNs) with badges, buttons and a picture of the charge, and Live Activities on the lock screen; ◐ store builds need the operator's developer accounts |
| Public REST API with OpenAPI spec and sandbox | ● all | ● new: OpenAPI 3.1 (266 operations, webhooks, permissions), a generated TypeScript SDK, per-key rate limits with usage, API reference with "Try it", sandbox tenants with virtual OCPP 1.6 / 2.0.1 / 2.1 chargers (signing meters, a bidirectional car on 2.1) and event simulation |

**Where PlugSure is stronger for Indonesia:**
- PLN kVA × PF ceiling guardrail and genset curtailment
- tera / SLO compliance vault with connector blocking
- PPN 12 % × DPP 11/12 and PBJT-TL receipts
- QRIS-first payment, with the local e-wallets (GoPay, OVO, DANA, ShopeePay, LinkAja) beside it
- alerting over WhatsApp, the channel Indonesian operations teams actually use

## 5. Restrictions and limits to know

1. **Payments and sign-in codes need provider accounts.** The adapters are built (Govern → Integrations), but in production QRIS checkout and phone sign-in are refused until they are connected. A production launch needs:
   - a contracted QRIS acquirer (Midtrans, Xendit or a bank via SNAP), with its notification URL set in the acquirer's dashboard (and, for e-wallets and cards, those channels activated on the account; for holds and saved cards, card pre-authorisation and saving enabled; for linked e-wallets, e-wallet tokenisation enabled)
   - a WhatsApp Business sender with an approved authentication template, or an SMS account — **without it drivers cannot sign in**

   See `deploy/DRIVER-APP-PILOT.md` for the pilot workaround.
2. **Refunds on the mock provider always succeed.** On a real PJP, "Refund via provider" is only available if that provider exposes a refund API. Otherwise finance records bank transfers, which the console supports.
3. **Prepaid idle buffer.** A prepaid top-up reserves a worst-case idle allowance (grace + 15 min at the idle rate). With a steep idle fee (e.g. Rp 1,000/min) a small top-up buys very little energy: in the test, Rp 20,000 bought only 99 Wh. This is intentional, because the payment must cover the overstay. Operators should keep idle fees moderate, or set a minimum top-up, on prepaid-heavy sites.
4. **Claim window.** A driver has 30 minutes after paying to start. After that the payment is refunded in full and the QR stops working.
5. **WhatsApp and SMS alerts** have their own limits:
   - They need a Meta Business account, a registered sender number and an **approved template**. Approval usually takes minutes to a day.
   - "Sent" means **accepted by WhatsApp**. Delivered, read and late failures come back only once the channel's callback URL, verify token and app secret are set in the Meta app (Edit settings shows them). Until then, test every contact's number with **Send a test**.
   - Meta charges per business-initiated (Utility) conversation.
   - SMS costs per message and Indonesian operators filter unregistered senders: register an alphanumeric sender (Twilio Messaging Service, or your aggregator) before relying on the fallback.
   - The status webhook must be reachable from the internet at the API's public address.
6. **Webhook delivery** runs in the gateway process. With `RUN_WORKERS=false` on every gateway, nothing is sent.
7. **Uptime history starts at this upgrade.** Chargers already offline when migration 011 is applied get an outage dated from their last-seen time, so expect a burst of offline alerts for units that were quietly dead. Decommission chargers that are gone for good.
8. **Portals sign in at the console address.** Site owners and fleet customers are outside the office, but the supplied Caddyfile keeps the console behind an office / VPN allow-list. Publish it for them on its own hostname, or add their addresses. Credit notes are not part of the e-Faktur XML: record the nota pembatalan (or a replacement faktur) in Coretax by hand when the invoice's faktur was already reported.

## 6. Roadmap (not built: platform-scale, or needs a third party)

| Priority | Item | Why not now / what it needs |
|---|---|---|
| **P0 before launch** | Live QRIS acquirer | Built (§ 3.13 to § 3.17): Midtrans, Xendit and bank SNAP adapters, e-wallets and cards through Midtrans and Xendit, signed notifications, refunds. Remaining: the contract and credentials (with each e-wallet and card channel activated), and a sandbox test. |
| **P0 before launch** | SMS / WhatsApp OTP provider | Built (§ 3.13): WhatsApp Cloud API, Twilio, Zenziva or your gateway, with a fallback. Remaining: the account (an approved WhatsApp authentication template, or an SMS sender) and a test. |
| Done | OCPI 2.2.1, CPO role (credentials both ways, locations, tariffs, sessions, CDRs, tokens with real-time authorisation, the five commands, hub routing headers) | Delivered in v1.3.0 (§ 3.6). Before live traffic: each partner's or hub's connection test, and the roaming tax and settlement terms. |
| Done | OCPI eMSP role for RFID/fleet cards (card sharing, real-time authorisation, received network, sessions and CDRs, START/STOP commands, CSV for billing on), and roaming in the driver app | Delivered in v1.3.0 (§ 3.6). Needs a roaming agreement with each CPO. |
| Done | OCPI ChargingProfiles (CPO role) and HubClientInfo (fleet invoicing of roaming charges is done, § 3.9) | Delivered in v1.3.0 (§ 3.6; migration 036). A partner's limit only lowers a session within load management. Sending profiles to other operators for our own cards (eMSP side) is a follow-up. |
| Done | Alerting follow-ups: WhatsApp delivery-status webhook, SMS channel and fallback, on-call rotas, per-site offline thresholds | Delivered in v1.3.0 (§ 3.4, migration 029). Needs the Meta app's webhook set up, and an SMS account with a registered sender. |
| Done | Published OpenAPI spec + sandbox tenant | Delivered in v1.3.0 (§ 3.8), with a generated TypeScript SDK and per-key rate limits (migration 037). SDKs in other languages: standard OpenAPI generators. Limits are per API process. |
| Done | Driver: map view, favourites, push notifications, reservations | Delivered in v1.3.0 (§ 3.7). Busy deployments should set their own map tile service. |
| Done | Driver: queue / waitlist | Delivered in v1.3.0 (§ 3.7; migration 033). Before switching it on at a site, check that its chargers accept ReserveNow. |
| Done | Driver: grouped map markers; reserving partner-network chargers | Delivered in v1.3.0 (§ 3.6, § 3.7; migration 034). Ask each partner whether it accepts reservations (OCPI RESERVE_NOW); one that does not answers NOT_SUPPORTED and the driver is told. |
| Done | Driver: reservation fees | Delivered in v1.3.0 (§ 3.7; migration 035). Set per site; paid in the app before the connector is held, or on the fleet invoice. |
| Done | Fleet monthly statements and B2B invoices (PDF, e-Faktur), credit notes and the fleet customer portal | Delivered in v1.3.0 (§ 3.9; migration 030). Before the first real export: confirm the e-Faktur item classification with a tax adviser, and import one file into Coretax to check it. Portal users must be able to reach the console address (it sits behind an office allow-list in the supplied Caddyfile). |
| Done | Promotions, member/fleet pricing, subscriptions, automatic renewal, proration and loyalty points | Delivered in v1.3.0 (§ 3.10; migration 031). App passes need the live acquirer (P0); unattended renewal needs saved cards or linked e-wallets turned on there. |
| Done | OCPP 2.0.1 device model in the console: base and monitoring reports, validated SetVariables, GetVariables, variable monitors, cleared events resolving alerts | Delivered in v1.3.0 (§ 3.5; migration 032). Check each 2.0.1 station model's report once on the bench: vendors differ in which variables they report and which they let you change. |
| Done | ISO 15118 Plug & Charge (CSMS side) | Delivered in v1.3.0 (§ 3.11). To go live: a V2G PKI provider behind the PKI gateway, and 15118-capable chargers. |
| Done | ISO 15118-20 charging needs and bidirectional charging (V2G / V2B) over OCPP 2.1 | Delivered in v1.3.0 (§ 3.18; migration 038). To go live: OCPP 2.1 chargers and 15118-20 cars tested together on the bench; a PLN export agreement only if energy should flow to the grid. Grid-code functions (DER control) are follow-ups. |
| Done | Signed meter values (OCMF), and sandbox chargers on OCPP 2.0.1 / 2.1 | Delivered in v1.3.0 (§ 3.19; migration 039). Register each meter's public key (from its label or the vendor) on its connector. Keep `record` unless a market or customer requires verified readings. |
| P3 | Grid-code functions (DER control, frequency / voltage support) and price schedules to the car | Needs a PLN or DSO grid code for EV discharge and certified inverter-grade OCPP 2.1 chargers; none exist in Indonesia yet. |
| P3 | Energy-market settlement of exported energy | PLN is the single buyer; no market or export tariff for EV discharge. The credit remains the operator's own. |
| Done | White-label driver apps per operator, with a store build kit | Delivered in v1.3.0 (§ 3.20; migration 040). To publish: the operator's web address pointed here, then the Play and Apple developer accounts, signing keys, and a build from the kit (JDK/Android SDK; a Mac with Xcode). |
