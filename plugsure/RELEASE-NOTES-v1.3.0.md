# PlugSure CSMS v1.3.0 — Release Notes

**Date:** 26 September 2026 · **Baseline:** v1.2.1 · **Type:** minor (feature release)
**Implements:** SPEC-UI-CSMS-2026-FINAL — *Enterprise CSMS Operator Dashboard UI Architecture & Functional Specification*

## Summary

v1.2.1 shipped a read-only monitoring console. Onboarding a charger, provisioning
its keys, creating a site, setting tariffs, issuing RFID cards or changing a
load-management ceiling all required `.sql` / `.ps1` scripts or raw API calls.

v1.3.0 replaces that console with a full operator dashboard covering all ten
modules of the specification, adds the backend each module needed, and fixes
four platform defects found while wiring it up (see **Defects fixed**). After
this release **no command-line or SQL step is needed for standard station
lifecycle operations**. The single exception is bootstrapping the very first
administrator account (`npm run create-admin`), because nobody can sign in yet.

## Modules delivered

| Spec module | Console | Backend |
|---|---|---|
| 1 · Asset management & onboarding wizard | 5-step wizard: identity & hardware (camera barcode scan), site (with Quick-add site), security (Profile 1/2/3, generated or typed key, rotation reminder, JSON + QR commissioning export, Vault PKI or PEM for mTLS), EVSE & connector builder (plug-type tiles, DC/AC3/AC1, nameplate, V/A, tera class/status/expiry with 30-day warning), review & live BootNotification listener | `POST /v1/charge-points` accepts the full profile + topology; `PUT …/evses`; `GET …/commissioning`; `POST …/keys`; decommission / reinstate |
| 2 · Remote operations cockpit | Per-connector Start (RFID autocomplete, Full / kWh / minutes / IDR presets), Stop (tx + duration summary), Unlock cable, Operative/Inoperative with mandatory maintenance reason, two-step Soft/Hard reset, TriggerMessage, ClearCache | Spec-named routes (`/remote-start`, `/unlock`, `/availability`…); preset limits enforced server-side (`operator-limits.ts`); technician "test-only" starts |
| 3 · Sites & PLN grid capacity | Site hub table; create/edit modal with PLN tariff groups, kVA, PF, phases, **live computed card** (kVA×PF ceiling, 200 kVA TR/TM cliff, 40×kVA rekening minimum), SPKLU ID + scheme, SLO, PBJT bps, OpenStreetMap location picker | `GET/POST/PUT /v1/sites`, save-time validation (SPKLU format, municipality match, PF, PBJT ≤ 10 %) |
| 4 · DLM studio | Ceiling slider with **hard guardrail** (snaps back at kVA×PF with the prescribed message), auxiliary reserve editor, genset/emergency curtailment switch (immediate 0 kW dispatch), drag-and-drop connector priority, allocation plan | Budget PUT now **refuses** a ceiling above the subscription (422); reserve breakdown; `PUT …/power/priorities`; `POST …/power/curtail` |
| 5 · Tariffs & billing | Plan master list; create wizard (flat / ToU WBP-LWBP / tiered), live ceiling checks, service-fee caps by class, bounded idle fee, PPN toggle, PBJT info, MDR absorbed; live invoice preview; assignment to all sites / a site / a connector, AC-only or DC-only | Tariff `status`, `ppn_applies`, `pricing_model`, assignment `current_type`, archive, unassign, `PUT /v1/sites/:id/tariff` |
| 6 · Configuration key studio | GetConfiguration fetch, search, category filter, editable values, RO/RW badge, plain-English descriptions, per-key Save (ChangeConfiguration), reboot-required prompt | `GET/PUT /v1/charge-points/:id/config`, snapshot table, 45-key catalog |
| 7 · RFID & access control | Inventory (holder, phone, account type, expiry, status, limits, lifetime kWh & sessions), issue dialog with **Scan from live charger**, block lost/stolen, SendLocalList to a charger or a whole site | `/v1/tokens` CRUD; cumulative energy/spend limits enforced at Authorize |
| 8 · Sessions & revenue | Filters (dates, site, station, connector type, payment status), explorer with meter start/end, energy subtotal, service fee, PBJT, PPN, MDR estimate, gross; drawer with CDR lines & meter chart; CSV export; **printable tax receipt showing DPP, PPN 11 %, PBJT-TL** | `/v1/sessions/search`, `/v1/sessions.csv`, `/v1/sessions/:id/receipt` |
| 9 · FOTA & diagnostics | Firmware repository (upload binary or HTTPS URL, SHA-256 verify, compatible models), campaign wizard (chargers / sites / fleet, maintenance window, retries), live tracker Initiated → Downloading → Downloaded → Installing → Installed → Verified; GetDiagnostics with built-in upload receiver and a log viewer with error highlighting | Firmware images/campaigns/jobs, scheduler, FirmwareStatusNotification and post-reboot version **verification**; diagnostics requests, `/diag/<token>` receiver, `/fw/<token>` download |
| 10 · Multi-tenancy & RBAC | Sign-in page, Users & Roles (invite, reset password, disable, site-scoped Site Hosts), the spec's permission matrix, API keys | Password login (scrypt, lockout), HttpOnly cookie session + CSRF header, the five spec roles, `/v1/users`, `/v1/roles`, `/v1/auth/*` |

Also retained and rebuilt: dashboard, connection attempts & pending adoption,
compliance vault, hardware quirks, OCPP frame log (now with a live tail), audit log.

## Defects fixed (found while implementing)

1. **Split deployment could not command any charger.** docker-compose and the
   systemd units run the API and the OCPP gateway as separate processes, but the
   charger sockets, the connection registry and the event bus live only in the
   gateway. In production every console command failed with "not connected", every
   charger showed offline, the live stream was silent and the driver app saw every
   station as offline. **Fix:** an API↔gateway bridge (`src/ocpp/bridge.ts`):
   commands via an authenticated internal HTTP endpoint on the gateway, liveness
   mirrored every 3 s, events relayed through Postgres `NOTIFY`. Requires
   `INTERNAL_API_TOKEN` (see Upgrade).
2. **Background workers never ran in production.** The load-management control
   loop, compliance sweep (tera lapse blocking), stuck-session reconciliation,
   alert persistence and prepaid enforcement were only started by the dev
   all-in-one process. They now run in the gateway (`src/services/workers.ts`).
3. **OCPP 2.0.1 chargers rejected every remote command** — commands were sent
   with 1.6 action names and payloads. Commands are now translated per negotiated
   version (`src/ocpp/translate201.ts`); `LogStatusNotification` is now accepted.
4. **Re-seeding duplicated every system role** (`ON CONFLICT (org_id, name)` never
   fires when `org_id` is NULL). Roles are now upserted by lookup at API start.

## Driver app aligned with v1.3

The public driver app (`/app`, API `/d/v1`) was reviewed against the v1.3 data
model and console. It now honours everything an operator sets in the console:

1. **Fleet PINs issued in the RFID centre did not work (defect).** The console
   stores the app PIN with scrypt; the driver app compared it as SHA-256, so no
   card given a PIN in v1.3 could sign in. Both formats now verify, and legacy
   v1.2 SHA-256 PINs are upgraded to scrypt on the next sign-in. The card serial
   is normalised the same way as the RFID centre (a lower-case hex serial is the
   same card).
2. **Fleet PIN brute force (security).** Unlike OTP, fleet sign-in had no attempt
   limit. Five wrong PINs now lock the card for 15 minutes; re-issuing the PIN in
   the RFID centre clears the lock. Needs migration **010** (two columns on `token`).
3. **Card limits and expiry.** A fleet card that is expired, or over its RFID-centre
   energy or spend limit, is refused at sign-in, checkout and start, with the reason
   shown to the driver. Before, the checkout succeeded and the charger then refused
   the card with no explanation.
4. **Maintenance holds.** A connector taken out of service with a maintenance reason
   shows as "Dalam perawatan" and cannot be paid for. The operator's internal reason
   is not shown to the public.
5. **Archived sites and decommissioned chargers** are gone from the station list,
   the connector page and QR/code resolution. Before, an old QR sticker still opened
   a decommissioned charger and let the driver pay.
6. **OCPP 2.0.1 stop.** Stopping from the app sent a numeric transaction id, which
   2.0.1 stations reject; it now sends the station's string id, like the console.
7. **Tax receipt.** The in-app receipt shows PBJT-TL, DPP nilai lain (11/12),
   PPN 12% × DPP (11% effective), the operator NPWP and a receipt number, and hides
   the PPN lines when a tariff is PPN-exempt. New **"Unduh struk pajak"** button:
   the same printable receipt the console issues (`GET /d/v1/charge/:id/receipt.html`,
   owner-only).
8. Charger **display names** and the **GB/T (sGBT)** plug label appear in the app.
9. **Mobile layout review** (320 px small phone, 375 px phone, landscape phone,
   tablet), with a real QRIS charge on a simulated charger:
   - **Pinned header and Pay button broke at 520 px and wider** (landscape phones,
     tablets, desktop browsers): the "phone frame" used `overflow: hidden`,
     which silently disables `position: sticky`, so both scrolled away. It now
     uses `overflow: clip`, and the frame only applies on tall screens, so a
     landscape phone gets the plain full-screen app.
   - **The energy estimate was hidden behind the Pay button** on small phones,
     the one figure a driver needs before paying. The button now reads
     "Bayar Rp 150.000 · ±49,29 kWh", and the estimate card scrolls into view.
   - **Notch and home indicator (installed PWA):** the page opts into
     `viewport-fit=cover` but never used the safe-area insets. The header,
     bottom tabs, pinned button, toast and scanner controls now clear the notch
     and home indicator, instead of the tab bar losing ~34 px to it.
   - **Typing:** the phone field autofills the number; the OTP field accepts
     the SMS code autofill on iOS and Android; the organisation code and card
     number no longer get auto-capitalised or autocorrected.
   - Tap targets: back, theme and language buttons 42 px; "Lihat semua" and the
     account tabs enlarged; no text under 11 px.
10. **Tablet layout** (iPad 768×1024, 1024×768, 1180×820). On tablets and
    desktops the app is a 460 px card centred on the screen. The card now runs
    to the bottom of the screen as a sheet, rounded only at the top. Before, it
    floated with a gap below it, so on short pages (Home, History, Account) the
    fixed tab bar hung 20 px outside the card's bottom edge. The page also
    reserves room for the scrollbar, so the card no longer jumps sideways when a
    page gets long enough to scroll (desktop browsers). The charge flow (Pay
    button, QRIS screen, Save QR, live session and Stop) fits on screen on all
    three sizes. Phones are unchanged.
11. **Two-column layout for tablets and desktops** (at least 900 px wide and
    600 px tall: landscape iPads, large portrait iPads, laptops). The station
    list stays on the left, with the logo, language and theme toggles and
    Home / History / Account. The right column shows whatever the driver is
    doing: station, connector and amount, QRIS and Save QR, live session,
    receipt. The chosen station stays highlighted, the list keeps its scroll
    position, and it refreshes live availability every 30 s while visible.
    In this mode the bottom tab bar, the separate Stations screen and Home's
    duplicate "nearby" list are hidden. Every screen is the same code in both
    layouts. The layout is pure CSS on the screen size, so rotating a tablet
    switches it instantly. Phones and portrait tablets under 900 px keep the
    single-column app, and the hidden list is never fetched on a phone.
    Also fixed: the map-pin icon on a station's address card had no size and
    filled the whole card (on phones too).
12. **Contrast in both themes** (dark is the default; light via the sun/moon
    toggle). Every screen was measured against WCAG AA (4.5:1 for text), on a
    real charge: stations, connector and amount, QRIS, live session, receipt,
    history, account, fleet sign-in, and every status pill, banner and button.
    Gradient buttons and banners were measured against every colour stop.
    - **Dark:** the red **Stop charging** button had white text at 2.79:1; it
      now has dark text, at 6.51:1. The grey "Offline" pill and the receipt
      header labels (3.7–4.3:1) and the "or" divider (2.5:1) now pass.
    - **Light** was weaker across the board. Grey text was at 4.29:1. Green used
      as text (station initials, "See all", the kWh estimate) was at 3.1–3.5:1.
      The Pay / Scan / Sign-in buttons were 3.28:1 and the active-charge banner
      2.6:1. The Available / In use pills and warning banner were about 4.1:1.
      Light-theme greens, amber and grey are now slightly deeper, and the
      buttons and banner use white text there (5.8–8:1).
    New `--on-arus` / `--on-danger` tokens set the text colour on solid green
    and red fills in each theme. The tablet page background outside the app
    card now follows the light theme too.
    Phone follow-up (320 px, dark): every screen, the bottom tab bar (measured
    against the content showing through it: 8.0:1), the sticky header when
    scrolled (16.6:1), the pinned Pay button, and the scanner overlay all pass.
    Two browser-level gaps were fixed:
    - The page declared no `color-scheme`, so the browser drew its own
      parts (scrollbars, autofill highlight, built-in controls) in light style
      inside the dark app. Each theme now declares its own.
    - The phone's status bar and browser toolbar colour (`theme-color`) was
      fixed to dark teal. In the light theme the app sat under a dark bar; it now
      follows the theme toggle and a saved theme on reload.
13. **"Simpan QR" (save QR).** A driver usually pays with the same phone that shows
    the QRIS code, and a phone cannot scan its own screen. The payment screen now
    has a **Simpan QR** button. It saves one PNG with the code, amount, station,
    expiry time and reference. The driver then pays by choosing that image from
    the gallery in any bank or e-wallet app. On phones it opens the share sheet
    ("Save Image" / save to gallery); elsewhere it downloads the file. When the
    driver switches back from the bank app, the app checks the payment
    immediately and starts the charge. Checkout returns the QR as a PNG
    (`qr.qrPng`) alongside the existing SVG. The saved image keeps the standard
    4-module white margin; a decoder reads it back to exactly the issued QRIS
    string, including a realistic 255-character payload and when shrunk to 240 px.

## Operator console on phones and tablets

The console was reviewed at 375 px (phone) and ~880 px (tablet); every module and
detail drawer now fits without sideways scrolling. Desktop (> 900 px) is unchanged.

1. **Drawers survived navigation (defect, all screen sizes).** Opening a charger,
   then choosing another page from the menu, left the drawer open on top, and
   drawers stacked up. On a phone the full-width drawer hid the new page. Every
   navigation now closes open drawers and dialogs. The phone's Back button closes
   an open drawer, and the serial-number scanner no longer leaves the camera
   running when you navigate away.
2. **Pages wider than the phone.** Dashboard, Load management, Compliance, Hardware
   quirks and the charger drawer used a 380 px minimum card width, so the whole
   page scrolled sideways and cut off buttons (e.g. "Edit" on the hardware card).
   Grids now never demand more than the screen has; long status pills wrap.
3. **Menu backdrop.** The slide-in menu had no backdrop: tapping outside it didn't
   close it and the tap went through to the page underneath. It now dims the page
   and closes on tap.
4. **Touch targets.** Buttons are at least 36–40 px tall on touch-width screens,
   including the per-connector **Unlock cable**, Start and Take out of service
   buttons (26 px before). Tabs and segmented controls are taller too.
5. **No zoom-on-focus.** Form fields use 16 px text on phones, so iOS no longer
   zooms the page each time a field is tapped.
6. KPI cards sit two per row on phones, so the fleet list is reached without
   scrolling past a column of cards. Drawers are full width with tighter padding.

7. **Search on phones.** A search button in the header opens the global search
   (chargers, sites, RFID cards) as a full-width bar. Tapping a result, or pressing
   Enter, opens it, and the bar folds away; the × or a tap elsewhere closes it.
   Desktop search is unchanged.

8. **Tablets (iPad portrait 768 px, landscape 1024 px).** A landscape tablet is
   wider than 900 px, so it gets the desktop layout. It had mouse-sized controls
   under a finger: 26 px Receipt and Resolve buttons, 32 px fields and a 24 px
   slider (85 undersized controls across Dashboard, Sessions, Power, Onboarding,
   Tariffs and Charge points). Touch sizing now follows the pointer as well as
   the width (`pointer: coarse`): 36–40 px buttons, 40 px fields and dropdowns,
   a taller slider and toggle switches, and roomier menu items. On portrait
   tablets and phones, form fields are now 40 px tall as well as 16 px text.
   A mouse-driven desktop is unchanged.
9. **Wide tables keep their first column pinned** below 1280 px. Sessions has
   12+ columns and shows under half of them on a tablet; scrolling sideways to
   the tax and total columns used to lose the Session column that identifies
   the row.
10. The fleet table's icon-only Start and Reboot buttons have accessible
    labels. Before, only a hover tooltip named them, and touchscreens and
    screen readers don't get hover tooltips.

11. **Dark mode contrast.** Every module, drawer, dialog, toast and onboarding
    step was measured against WCAG AA (4.5:1 for text) in dark mode, light
    mode, and the dark theme chosen from the user menu. In dark mode, white text
    sat on the red and amber fills, which become light pastels there:
    - amber warning toast: 1.86:1
    - completed onboarding step ✓: 2.25:1
    - red danger buttons (Block card, Disable user, Decommission): 2.52:1
    - red error toast and the sidebar alert badge: 2.52:1

    New `--crit-ink` / `--warn-ink` tokens (white in light mode, near-black in
    dark mode), like the existing `--accent-ink`, bring these to 7.2–8.9:1.
    Dark-mode secondary text is slightly lighter, for small labels on tinted
    tiles (4.47 → 4.9:1).
    Light mode was also borderline: grey secondary text on the page background
    (4.47:1), grey "muted" tags (4.19:1) and green tags (4.497:1) are now
    4.6–4.8:1, with barely visible colour shifts. All 15 pages and every
    drawer and dialog now pass in both themes.
12. **Dark mode on tablets.** Portrait and landscape iPad were re-checked in
    dark mode: every page, the slide-in menu, the phone search bar and its
    results, drawers, dialogs, and the pinned first column. Its cells match the
    row, header and totals backgrounds exactly.
    - **Overlays did not dim anything in dark mode.** The menu, drawer and dialog
      backdrops used a slate tint, which on a dark page changed nothing
      (1.01:1). The menu or a dialog therefore sat on an undimmed page with no
      visible edge, because shadows do not show on dark backgrounds. New
      `--scrim` / `--scrim-strong` tokens use black in dark mode (the page
      behind gets about 60% darker), and drawers and dialogs now have a
      1 px border. Light mode is unchanged.
    - **Placeholder text** ("Find a charger, site or card…", filter hints) used
      the browser's default grey, 3.8:1 on dark panels. It now uses the
      theme's secondary text colour: 6.7:1 dark, 5.4:1 light.

Data tables keep their columns and scroll sideways inside their own box, which is
the intended pattern for dense NOC tables.

## Final field test and gap review

A final end-to-end run drove simulated OCPP 1.6 and 2.0.1 chargers through field
conditions: faults, dropped connections, power loss, offline transactions,
retried frames, meter resets, clock skew, racing drivers, prepaid cut-off and
receiver outages. The feature set was also compared with ChargePoint, Driivz,
AMPECO, Monta, Virta, EV Connect and Shell Recharge. Full report:
**`docs/GAP-ANALYSIS-v1.3.md`**. New suite: `npm run e2e:field` (**65/65**).

**Defects fixed**
1. **Prepaid QR tokens never expired (revenue).** A paid claim token could start
   unlimited free sessions later, e.g. from a screenshot of the QR. Tokens are now
   valid for 30 minutes after payment, and Authorize/Start re-check the payment.
2. **OCPP 2.0.1 prepaid cut-off sent `transactionId: NaN`.** The station kept
   charging past what the driver paid. Load management's per-transaction profile
   had the same fault on 2.0.1. Every command now uses one helper that sends a
   string id on 2.0.1 and an integer on 1.6.
3. **Refunds were promised but never paid.** The app said the unused balance
   would be returned. A payment whose charge never started sat in `captured`
   forever.
4. **Offline chargers left no trace.** There was no record, no alert and no uptime
   figure.
5. **Routine 2.0.1 messages were refused.** `NotifyEvent`, `NotifyReport`,
   `MeterValues` and `ReservationStatusUpdate` got NotImplemented.
6. Alerts raised in the API process lost their target, so they could not
   auto-resolve.

**New**
- **Refunds** (Commercial → Refunds). Unused prepaid balance, and payments whose
  charge never started (swept after the claim window), are queued automatically.
  Finance pays them through the provider's refund API or records a bank transfer
  with its reference. A payment cannot be refunded twice, and every action is
  audited. The driver app shows "refund in progress" / "returned".
- **Availability** (Operate → Availability).
  - Outage history per charger.
  - A critical alert when a charger is offline longer than
    `OFFLINE_ALERT_MINUTES` (default 15). It resolves itself on reconnect.
  - **Fixed (27 Sep):** a charger that came back while the offline sweep was
    part-way through could still get an offline alert a moment later. That alert
    never resolved, because its reconnect had already been handled, and it was
    routed by e-mail and WhatsApp. An alert is now raised only while the outage
    is still open and the charger is not connected, and a reconnect resolves again
    shortly afterwards to catch one in flight.
  - **Gateway health (28 Sep):** the gateway times every background worker pass
    and watches event-loop delay and database-connection waits. It logs a warning
    only when something is wrong, including `gateway paused` when the process
    did not run for more than 30 s (a sleeping host or a blocked event loop).
    `GATEWAY_DIAG=verbose` adds a summary every 10 s. This came from investigating
    a 6.6-minute stall in a test run, which turned out to be the test laptop's lid
    closing (Windows Modern Standby), not PlugSure. Under instrumentation a full
    regression showed no overlapping or overlong worker passes, event-loop delay
    under 60 ms, no database waits, and offline alerts 74–120 s after disconnect
    (threshold 60 s + a 60 s sweep).
  - A per-charger report: uptime %, outages, longest outage, sessions, kWh,
    revenue and utilisation, with CSV export.
- **Webhooks** (Govern → Webhooks).
  - Events: sessions, CDRs, charger connect/disconnect/boot, connector status,
    alerts, refunds and firmware, delivered through an outbox.
  - HMAC-SHA256 signed; the secret is sealed at rest and shown once.
  - Retried with back-off for about 11 hours, then kept for replay.
  - SSRF-guarded at connect time in production.
  - A test button and a delivery log.
- **2.0.1 device events.** A monitor in Alerting state (over-temperature, RCD
  trip, tamper) becomes an operator alert.

## Alert routing: e-mail and WhatsApp

Alerts used to reach only someone watching the console, or a webhook receiver.
**Govern → Alert routing** now sends them to people. In Indonesia that
mostly means WhatsApp.

- **Channels.**
  - *E-mail:* any SMTP server (Google Workspace, Microsoft 365, SES, Mailgun,
    Brevo, a local relay), with STARTTLS or TLS.
  - *WhatsApp:* the WhatsApp Business Cloud API (Meta), or a BSP offering the
    same API. Alerts are business-initiated, so they use an **approved Utility
    template** with three body variables: status, what and where, time.
  - The SMTP password and the WhatsApp token are write-only in the console
    and sealed at rest with `SECRETS_KEY`.
  - Each channel has a **Send a test** button.
- **Contacts:** name, e-mail and/or WhatsApp number. Indonesian numbers in any
  spelling (0812…, +62 812…, 812…) are normalised to 62812….
- **Rules:**
  - minimum severity
  - alert types (whole families such as all compliance alerts)
  - sites
  - e-mail, WhatsApp or both
  - **quiet hours:** warnings wait until morning; critical always goes
  - **"resolved" messages** to everyone who was told
  - **escalation:** if nobody presses **Acknowledge** within N minutes, a second
    set of contacts is notified
- **Acknowledge** on the dashboard's open alerts ("someone is on it") stops
  escalation.
- **Delivery log** of every message: sent, queued or held, failed with the
  provider's reason, or suppressed. Failed messages can be retried.
- **Reliability.** Messages are queued in the database and sent by the gateway's
  worker every 5 s.
  - Temporary failures retry at 1, 5 and 15 min.
  - Permanent ones (number not on WhatsApp, template not approved, mailbox
    rejected) fail at once, with the reason.
  - An alert raised in either process, or while the gateway was restarting, is
    still routed.
- **No paging storms.**
  - The same open problem raised again (e.g. the hourly compliance sweep
    re-raising a lapsed tera) now bumps the existing alert ("raised 3×")
    instead of creating a new one and paging again.
  - A person in two matching rules gets one message.
  - Over 20 messages to one recipient in 15 minutes (a site-wide power cut)
    sends one "messages paused" notice instead of dozens.
  - An alert that clears before it is sent (a fault that recovers in seconds)
    pages nobody.
- **Connector faults now resolve themselves** when the connector reports any
  other status. Before, they stayed open until someone clicked Resolve.
- Alerts now record their site: faults, tera and key-rotation alerts, SLO,
  prepaid refunds and device alarms. Rules can therefore be scoped per site.
- New permissions `alert:read` / `alert:write`: Super Admin and CPO Operations
  Manager manage routing; Field Technicians can view it.
- Needs migration **012**. `CONSOLE_PUBLIC_URL` (defaults to `PUBLIC_BASE_URL`)
  puts a console link in every message. `ALERT_TIMEZONE` (default Asia/Jakarta)
  and `ALERT_NOTIFY_MAX_PER_15MIN` (default 20) are optional.
- New dependency: **nodemailer** 7 (no dependencies of its own).

### Alerting follow-ups: delivery status, SMS, on-call rotas, per-site thresholds

- **WhatsApp delivery status.** "Sent" only ever meant that WhatsApp accepted
  the message. Each WhatsApp channel now has its own **callback URL** and
  **verify token** (Edit settings shows both) for Meta's webhook.
  - Save the Meta **app secret** on the channel. Callbacks are checked against
    it (`X-Hub-Signature-256`, HMAC-SHA256 of the raw body): forged ones get 401,
    an unknown URL 404, and without the secret they are refused (403).
  - The delivery log shows **delivered** and **read** with their times, and
    **failed** with Meta's reason (e.g. 131047, more than 24 hours).
  - Callbacks for messages PlugSure did not send are ignored.
- **SMS as a third channel:** Twilio (sender number or Messaging Service),
  Zenziva, or your own gateway (`POST { to, message, channel: "sms",
  purpose: "alert" }` with a bearer token).
  - The credential is write-only and sealed. There is a **Send a test** button.
  - A contact can have a separate SMS number; otherwise SMS goes to their
    WhatsApp number.
  - Texts are one line, status first, at most two SMS segments:
    `PlugSure CRITICAL: Connector fault at … (27 Sep 08:00 WIB)`.
- **SMS fallback.** A rule can say "send an SMS instead when a WhatsApp message
  fails". This covers WhatsApp refusing the number, retries running out, or
  Meta reporting a failure later.
  - The SMS goes to the same person, with the same alert.
  - The log links it to the failed WhatsApp message.
  - One SMS per alert and person.
- **On-call rotas** (Alert routing → On-call rotas):
  - People take **daily or weekly** shifts in turn, handing over at a local
    time (`ALERT_TIMEZONE`) from a start date.
  - **Overrides** put someone else on duty for a period (leave, a swap; up to
    92 days); the latest override wins.
  - The page shows who is on duty, until when, and who is next.
  - Rules and escalations can notify **"whoever is on duty"** on a rota,
    alongside or instead of named people. The person is looked up when the
    alert is routed.
  - Deleting a rota takes it out of every rule; removing a contact takes them
    out of every rota.
- **Per-site offline threshold.** Sites → Monitoring → "Offline alert after"
  (1–1440 minutes) overrides `OFFLINE_ALERT_MINUTES` for that site, for example
  a site with a weak mobile signal. Empty means the fleet default.
- API: `GET /v1/alert-routing` adds `channels.sms` and `rotas`.
  - `PUT /v1/alert-routing/channels/sms`. The WhatsApp channel accepts
    `webhookSecret`.
  - Rules accept `rotaIds`, `escalateRotaIds` and `smsFallback`. Contacts
    accept `sms`.
  - New endpoints: `POST /v1/alert-routing/rotas`,
    `PUT`/`DELETE /v1/alert-routing/rotas/:id`,
    `POST /v1/alert-routing/rotas/:id/overrides` and
    `DELETE /v1/alert-routing/rotas/:id/overrides/:overrideId`.
  - Sites accept `offlineAlertMinutes`.
  - The public `GET`/`POST /hooks/whatsapp/:key` is outside `/v1`.
  - 228 operations in the OpenAPI document.
- Needs migration **029** (additive: existing rules, contacts and channels
  behave as before).

## Platform commission and fee statements

The published pricing (commission on public charging, a minimum per charger,
a flat fee for private chargers) had nothing behind it in the CSMS. It now
produces a monthly statement per customer organisation.

- **Commission base:** the session subtotal (energy, service, admin and idle
  fees). **PBJT-TL and PPN are excluded:** they are taxes the site owner
  collects for the state. Unused prepaid balances and payments that never
  started a charge are never in the base, because the base comes from rated
  sessions, not payments.
- **Published rates by default,** per site and month:
  - Standard below Rp 150M: 8%
  - Volume Rp 150–500M: 6.5%
  - Network above Rp 500M: 5%

  The whole month is charged at the tier reached; a plan can switch to banded
  rates instead.
- **Minimum:** AC Rp 150,000 and DC Rp 350,000 per charger per month,
  credited against that charger's commission. Only a quiet charger pays the
  top-up. AC is lower because at Rp 350,000 almost every public AC charger paid
  the minimum: a 7 kW charger only earns more than that in commission above
  ~37% utilisation.
- **Private sites** pay a flat fee instead: Rp 250,000 per AC charger and
  Rp 450,000 per DC charger. Minimums and fees are pro-rated by days in service.
- **MDR:** the estimated QRIS processing fee (MDR) is credited back, since the
  pricing page says the commission covers payment processing. A plan can make
  it the site owner's cost instead.
- **Tax on the statement:** PPN on the platform's fee (DPP 11/12 × 12%), and
  the 2% PPh 23 a withholding customer may deduct.
- **Customers** see **Commercial → Statements**:
  - the month's draft, projected to month end
  - per-site and per-charger lines, with notes
  - CSV and a printable statement
  - finalised statements

  It needs org-wide `invoice:read` access.
- **The platform operator** sees **Govern → Platform billing** (platform
  administrators only):
  - every customer's month
  - each customer's plan, **versioned by effective month**, so a rate change
    never re-prices a month already worked. A customer on the published rates
    follows them if they change; a custom plan stays as agreed.
  - each site as public (commission) or private (platform fee)
  - **Finalise**: after a month ends, the statement is frozen and numbered
    (`PSC-YYYYMM-…`)

  A customer cannot change its own plan or billing model. A finalised month
  cannot be re-priced by a back-dated plan. A private site where drivers paid
  is flagged.
- **Month allocation:** a session counts in the month its charge record was
  issued, so a finalised month never changes.
- `create-admin --platform-admin` creates the operator's billing account. Put
  it in the operator's own organisation, never in a customer's.
- Needs migration **013**. Optional: `BILLING_ISSUER_NAME`,
  `BILLING_ISSUER_NPWP`, `BILLING_TIMEZONE` (default Asia/Jakarta).
- The statement is not a tax invoice; issue the faktur pajak separately.
  Split settlement at the payment gateway, where money goes straight to the
  site owner, still depends on the gateway contracted.

## Site owners: owner portal and per-owner billing

For networks PlugSure operates on other businesses' sites (hotels, retail,
offices).

**Owners** (Commercial → Owners)
- Legal name, NPWP, contact and the sites each owner owns.
- A site that already has charging history with one owner cannot move to
  another, either directly or by removing the owner first. The new owner would
  see the previous owner's sessions and revenue. Create a new site and move the
  chargers instead.

**Owner portal login** (role *Site Owner (portal)*)
- Invited from the owner (or Users & Roles) with a one-time password; signs in
  with e-mail and password and chooses its own password at first sign-in.
- The grant is per owner and follows the owner's sites automatically. An owner
  with no sites, or an archived owner, has no access at all, never the
  organisation-wide read-only fallback.
- The console shows only Dashboard, Charge points, Availability, Sessions &
  Revenue and Statements, all read-only:
  - its own revenue
  - its own sites' alerts
  - session CSV export for its accounting
  - its monthly statement, with charging units, amounts and "Your share"
- No commands, settings, tariffs, other owners' data, or the live event stream.

**Billing** (Commercial → Billing, for org-wide finance staff)
- Every owner's month:
  - sessions and kWh
  - gross collected, PBJT + PPN, commission base
  - **owner share**, **operator share**, MDR
- A row for the operator's own sites (no owner), and totals that add up. CSV
  export.
- Per owner: its statement, its **own plan** (versioned by month; without one
  the owner is on the published rates), and **Finalise month**.
- Owner share = commission base − operator's fee before PPN − MDR. Base = owner
  share + operator share + MDR, checked in tests.

**Driver receipts**
- Each owner has a *seller of record* setting. The default stays *operator*.
  Once payments settle to the owner's own merchant account, set it to *owner*,
  and the owner's legal name and NPWP go on the console and in-app tax receipts.

**Hardening found by an endpoint audit for this feature**
- A charger moved to another owner's site no longer shows that site's users its
  earlier OCPP log (with RFID idTags), diagnostics or connection details. A new
  `site_assigned_at` column bounds what site-scoped users see.
- The availability report counted a moved charger's sessions, energy and
  revenue at its new site. It now counts only the site's own sessions.
- Alerts are now listed and counted per site for site-scoped users.
- Dashboard revenue works for site-scoped users. It was always empty.
- The live event stream stays operator-only, since its events carry no site.

Needs migration **014** (additive).

## Owner portal: phone and tablet review

Reviewed at 375 px (phone), 768×1024 (portrait tablet) and 1024×768 (landscape
tablet) as a real Site Owner. Layout held on every page: no sideways scroll,
and wide tables scroll in their own box. The review found these issues:

**Security (server side, for every site-scoped viewer: Site Owner and Site Host)**
- **Drivers' RFID card numbers were shown in full.** On UID-only cards the
  number *is* the credential, so an owner could clone a fleet customer's card
  and charge on its account. Cards are now masked to the last four characters
  (`••••2BA0`), and driver names are withheld (UU PDP). This applies to the
  session list and search, CSV export, the charger's active session and the tax
  receipt. The operator still sees everything.
- **Session search matched partial card numbers.** An owner could have rebuilt
  a full card number digit by digit from hits and misses. Site-scoped viewers
  now match whole values only.
- **The raw OCPP log** (which carries those card numbers) was readable by a
  site-scoped read-only login through the API. It is now limited to org-wide
  operators and to users who may configure or command that charger. This
  covers the log, its NDJSON export and the live frame stream.

**Portal UI**
- The dashboard greeted the owner with the operator's name ("Good morning, Ibu
  Nusantara Charge…"). It now reads "Good morning, Sari — PT … your chargers,
  operated by …". Greetings skip honorifics (Ibu, Bapak, Pak, Mr …) for
  everyone.
- Links to pages the owner cannot open ("OCPP log →", "All sites →", site rows)
  bounced silently to the dashboard. They are now removed or point to the
  owner's chargers.
- The charger drawer showed Remote control, Configuration and Security tabs and
  an "OCPP frames" button that the owner cannot use. The portal now shows
  Overview, Connectors and Sessions, and the tab bar fits a phone.
- The top bar showed a "live" indicator (the stream is off in the portal), and
  search offered sites and cards. Search now covers only the owner's chargers.
- The drawer and dialog close button was 30 px on touch screens, for every
  user. It is now 40 px.
- "offline for 1 minutes" now reads "1 minute".

## Owner portal: dark mode review

Reviewed as a real Site Owner in explicit dark mode (user menu) and in system
dark mode (the device setting), on a 375 px phone and a 768×1024 tablet. Every
text element was measured against its actual background:

- Pages: dashboard, chargers, sessions, availability and statements.
- Drawers: charger (Overview, Connectors, Sessions), session (Summary & billing,
  Metering) and statement.
- Menus: the navigation menu, the user menu and search.
- Before the console loads: the sign-in page with its error message, and the
  forced "Choose a new password" dialog with its validation error.

All text passes WCAG AA (4.5:1). Chart bars and the status stack bar are 7.7:1.
Two issues were fixed, for every user:

- **Form field borders were 1.53:1 in dark mode**, so empty inputs, dropdowns and
  the segmented filters were hard to find (WCAG 1.4.11 asks for 3:1). A new
  `--field-line` token now draws them at 3.4:1. Light mode is unchanged.
- **The phone's browser toolbar followed the device theme, not the console's.**
  Choosing Dark on a phone set to light left a white bar above a dark console.
  The `theme-color` now follows the theme picked in the user menu.

## One-time passwords enforced by the server

A one-time password is issued when a user is invited or reset, and is often
sent over chat or e-mail. Until now only the console made the user replace it:
the same password worked indefinitely against the API itself.

- The API now serves a session holding a one-time password only four things:
  `GET /v1/auth/me`, `GET /v1/meta`, `POST /v1/auth/change-password` and
  `POST /v1/auth/logout`.
- Everything else gets `403 {code: "password_change_required"}`. This applies to
  cookie and bearer session tokens alike; API keys are unaffected.
- The console shows only the "Choose a new password" dialog (with *Sign out*)
  and loads nothing else until the password is changed.
- A password reset still ends the user's existing sessions.
- The console test suite previously used an invited technician's one-time
  password directly; two of its permission checks were passing for the wrong
  reason. They now change the password first and assert the real refusal.

## Code-review follow-ups

The three smaller items the code review left open are fixed.

- **Firmware URL verification could reach the internal network (SSRF).**
  *Verify checksum* downloaded an operator-supplied URL with a plain `fetch`,
  unlike webhooks. Anyone with `firmware:write` could point it at the cloud
  metadata endpoint or an internal service, directly, through DNS rebinding, or
  through a redirect. The error, size and hash then revealed what answered.
  - Firmware verification now uses the webhooks' guard, moved to
    `services/net-guard.ts`: https only, no credentials in the URL, and in
    production no private, loopback, link-local or metadata addresses.
  - The address is checked when the connection is made, so rebinding is covered.
  - Up to three redirects are followed, because firmware often comes from a CDN
    link, and every hop is checked again.
  - A file whose declared size is over the firmware limit is refused before
    downloading.
  - In production an internal URL is refused when the image is added, too.
- **Tariff writes were not atomic.**
  - Assigning a tariff deleted the old assignment and inserted the new one as
    separate statements. Two simultaneous assigns to the same scope both
    inserted, leaving duplicates. It is now one transaction, serialised per
    tariff and scope.
  - Creating a tariff wrote the tariff and its prices separately. A failure
    part-way left a tariff missing some prices, which could then be assigned
    and under-bill. The tariff and its prices are now saved together or not at
    all.
  - New tests fail on the old code: 2 assignments instead of 1, and a
    half-written tariff.
- **Re-running the seed duplicated or destroyed data.**
  - Each run added another copy of the demo site; the chargers stayed on the
    first copy.
  - Each run deleted *every* tariff in the organisation, including the
    operator's own. Once a session referenced a tariff, the run failed halfway
    and left no tariff at all.
  - Each run added another working full-rights API key.

  The seed now finds the site and the demo tariff before creating them, leaves
  other tariffs alone, and rotates its API key (earlier seed keys are revoked).
  Checked on a fresh database: after four runs there is one site, one tariff
  with 4 prices, one assignment, one live key, 16 system roles, and the
  operator's own tariff is still there.

## Roaming: OCPI 2.2.1 (charge point operator and service provider)

Drivers of other networks can now charge on this operator's chargers. Their
provider (an eMSP, reached directly or through a roaming hub such as Hubject,
Gireve or e-clearing.net) is billed with a charge detail record (CDR) for
every session. Prices, taxes, receipts and the operator's own drivers are
unchanged. The work is in `src/ocpi/`; nothing is shared or sent until an
operator sets it up under **Commercial → Roaming**.

**Setting up**
- **Roaming identity:** country code and three-character party ID (e.g.
  `ID*PLS`). Every EVSE id is built from it (`ID*PLS*E…`).
- **Partners:** two ways to connect, both following the OCPI credentials
  handshake.
  - *The partner connects to us:* the console issues a versions URL and a
    one-time token A to send them. It stops working once they register.
  - *We connect to them:* enter the versions URL and token they gave you.
    PlugSure picks version 2.2.1, registers, and stores the partner's token.
- A partner can be suspended (locked out, nothing sent), resumed, or
  disconnected (the partner is told).
- **Shared sites:** opt in per site. A site needs a map location, a street
  address and a city (new site field). Private sites cannot be shared.

**What partners get**
- **Locations** (pull, and pushed on change):
  - sites with chargers, plugs (CCS2, Type 2, CHAdeMO, GB/T), power and tariff
  - live EVSE status: a fault goes out as `OUTOFORDER` within seconds, an
    offline charger shows `UNKNOWN`, maintenance shows `INOPERATIVE`, a
    reservation shows `RESERVED`
  - changes from any console edit go out within a minute
- **Tariffs:**
  - energy per kWh, with the peak (WBP) and off-peak (LWBP) windows and tiers
  - the service and admin fee as one flat price, not charged below 0.1 kWh
  - idle fee and time fee per hour
  - PPN as `vat` (11 % effective)
  - PBJT-TL varies by location and has no OCPI field, so it is stated in the
    tariff's alt text (English and Indonesian); the CDR carries the exact total
- **Sessions:** PUT when the session starts, PATCH as energy moves, PUT when it
  ends.
- **CDRs:** POSTed once the session is rated. Each CDR carries the tariff that
  priced it, energy/fixed/parking costs and a parking period.
  - `total_cost.incl_vat` is the receipt total.
  - `excl_vat` is subtotal + PBJT-TL. Set `OCPI_PBJT_IN_EXCL_VAT=false` if your
    tax advisor treats PBJT otherwise.
- A partner can pull only its own drivers' sessions and CDRs.

**Drivers at the charger**
- Partners push their drivers' tokens (cards and app accounts). A token is
  looked up only when the idTag is not one of the operator's own cards, so an
  own card always wins.
  - "Pre-approved" tokens (whitelist `ALWAYS`, `ALLOWED`, `ALLOWED_OFFLINE`)
    are accepted at the charger without asking the partner, so they work if
    the partner is down.
  - `NEVER` tokens are checked with the partner in real time. The charger waits
    at most 5 s (`OCPI_REALTIME_AUTH_TIMEOUT_MS`); no answer means no charge.
  - A token the partner invalidated is Blocked.
- Works on OCPP 1.6 and 2.0.1 chargers alike.

**Commands from partners**
- `START_SESSION`, `STOP_SESSION`, `UNLOCK_CONNECTOR`, `RESERVE_NOW`,
  `CANCEL_RESERVATION`.
- The HTTP answer says whether the command goes to the charger. The charger's
  outcome (`ACCEPTED`, `EVSE_OCCUPIED`, `EVSE_INOPERATIVE`, `TIMEOUT`…) is
  POSTed to the partner's `response_url` afterwards.
- The session records how it was started: `COMMAND`, `AUTH_REQUEST` or
  `WHITELIST`, with the partner's authorization reference.
- A partner may stop only its own drivers' sessions. It may unlock a connector
  only when its own driver is on it or just left (15 minutes).
- OCPI reservation ids are strings; OCPP needs integers, so PlugSure keeps the
  mapping.

**Delivery and security**
- Calls to partners go through an outbox:
  - retried with back-off for about 11 hours
  - in order per object (a session's PUT, its PATCHes, then the CDR)
  - rendered from the database when sent, so a retry never carries stale data
  - a failed CDR raises an alert and can be sent again from the console
- Tokens:
  - Tokens partners use to call us are stored hashed (and sealed, for `GET
    /credentials`).
  - Tokens we use are sealed with `SECRETS_KEY`.
  - `Authorization: Token <base64>` (2.2.1) and the raw form (2.1.1 style) are
    both accepted.
- Hub routing headers (`OCPI-from/to-country-code`, `-party-id`) are sent on
  every call and checked on every request. A message addressed to another party
  is refused.
- Partner URLs, including `response_url`, go through the same SSRF guard as
  webhooks: https only and public addresses only in production, checked at
  connect time.
- Every call in both directions is logged for the console's message view.
  Commands reach chargers through the audited command path.

**Console:** Commercial → Roaming, with three tabs.
- **Partners:** status, message log, what was sent, the partner's tokens.
- **Shared sites:** share or stop sharing, with the reason when a site cannot
  be shared.
- **Roaming sessions:** partner, contract id, how the session started, and
  whether its CDR was accepted.

New permissions `roaming:read` / `roaming:write`: Super Admin and CPO
Operations Manager; Financial Auditor reads.

**Deployment:** partners must reach `/ocpi/*` from the internet. The console
host sits behind an IP allow-list, so `deploy/Caddyfile` adds an `ocpi.`
hostname that serves only `/ocpi/*`. Set `OCPI_PUBLIC_URL` to it. Needs
migration **015** (additive).

### Roaming, the other way round: your cards on other networks (eMSP)

The operator's own RFID and fleet cards can now charge at other operators'
(CPOs') chargers, directly or through a hub. The CPO sends a charge record
for every session; the operator pays it and bills the card holder. It is set
up on the same Roaming page, with the same roaming identity: PlugSure
registers as both CPO and eMSP.

**Setting up**
- Add the operator as a partner of type *Charge point operator*, either way
  round, like any partner.
- **Cards abroad:** allow roaming per card, or share all active cards at once.
  - A shared card gets an eMAID-style contract id (`ID-PLS-C1A2B3C4D`) and is
    sent to every connected CPO.
  - Blocking a card in the RFID centre, or stopping its roaming, reaches the
    CPOs within seconds (sent as `valid: false`).
- Only RFID cards can roam. Driver-app users pay upfront by QRIS and have
  nothing to bill a session on another network to.

**How cards are checked**
- A card without limits is `ALLOWED`: the CPO may accept it at the charger
  without asking.
- A card with an energy or spending limit is `NEVER` whitelisted: the CPO must
  ask PlugSure before every session.
- PlugSure answers `ALLOWED` with an authorization reference, or `BLOCKED`,
  `EXPIRED`, `NO_CREDIT` or `NOT_ALLOWED`. An unshared card is unknown (2004).
- **Limits hold across networks:** a card's energy and spending limits count
  roaming charges too, at your own chargers, in the driver app and when a CPO
  asks.

**What CPOs send us**
- **Their network:** locations, EVSE status and tariffs. Pushed as they
  change, imported in full when the partner connects (following OCPI paging),
  and refreshed every six hours.
- **Our drivers' sessions:** shown under *Cards abroad → Charging now*.
- **Charge records:** we answer with a Location URL to read the record back.
  - The same CDR posted twice is acknowledged once.
  - A CDR changed under the same id is refused (409), since OCPI CDRs cannot
    be changed; corrections come as credit CDRs.
- A CPO may publish only for its own parties, and sessions or CDRs must carry
  one of our cards.

**Commands we send**
- The *Partner network* tab lists the CPOs' chargers with live status.
  - *Start* sends `START_SESSION` with a shared card, for a driver whose card
    will not read, or a support call.
  - A running session can be stopped (`STOP_SESSION`), and `UNLOCK_CONNECTOR`
    is available through the API.
- The CPO's answer and the charger's result, posted back to us, show under
  *Recent commands*.

**Billing on:** *Cards abroad* lists every charge record (where, which
card/holder/fleet, energy, excl. and incl. VAT) and exports it as CSV,
protected against formula injection, to invoice fleets. Needs migration
**016** (additive). No new settings.

### Roaming in the driver app

Fleet drivers whose card is shared for roaming now find and use partner
chargers in the app.

- **Stations:** below PlugSure's own stations, a **Jaringan mitra** (partner
  network) section lists the connected operators' sites.
  - Live availability, fastest power, distance and operator.
  - The operator's energy price per kWh, before tax.
  - A partner site shows its chargers with their status; available ones have
    **Mulai isi** (start charging).
  - Also in the side column of the tablet and desktop layout.
- **Charging:** *Mulai isi* sends `START_SESSION` with the driver's card. A
  live screen follows the charge:
  - Contacting the charger, then charging with energy and time as the operator
    reports them.
  - **Stop** sends `STOP_SESSION`.
  - Then it waits for the operator's bill, and finally shows the total
    including tax.
  - If the operator refuses or the charger cannot start, the driver is told why
    and to tap the card at the charger instead.
- **Charge details:** the operator's charge record, with site, address, EVSE,
  record number, energy, time and cost lines, before and after tax, marked
  *billed to your company*.
- **History:** includes partner-network charges started in the app, and
  charge records from sessions started by tapping the card at a partner
  charger. A live partner charge shows in the *charging now* banner.
- **Who sees it:** only fleet drivers whose card is shared and within its
  limits. Guests, QRIS drivers and cards not shared see nothing new; a card
  not shared gets the reason. One driver's partner charges and records are
  invisible to other drivers.
- Everything is translated into English. Unrelated to roaming, the status in
  every history row ("Selesai", "Berlangsung"…) now translates too; before, it
  stayed Indonesian.
- Needs migration **017** (additive).

**Not included:**
- a map view at the time (added next; see **Driver app: map, favourites,
  notifications and reservations**, where partner sites appear as markers too)
- automatic invoicing of roaming charges to fleets (the CSV is the hand-off)
- OCPI `ChargingProfiles` and `HubClientInfo` (added later; see **Roaming: partner
  smart charging and hubs**)
- charging preferences (answered `NOT_POSSIBLE`)
- signed meter data
- a certification test with a real partner or hub. Each hub runs its own
  connection test before going live.

## Driver app: map, favourites, notifications and reservations

Four driver-app features from the gap analysis (P2), built together because
they share the station screens.

**Station map**
- *Stasiun* has a **Daftar | Peta** (list | map) switch; the tab reopens
  whichever the driver used last. On a tablet or desktop, **Peta** is in the
  side navigation and the map fills the right-hand pane.
- Markers:
  - green with the number of free connectors
  - grey when full or offline
  - blue for partner-network sites (fleet cards that roam)
- Tapping a marker shows the station card; tapping the card opens the station.
- Drag, wheel, pinch, double-tap and the +/− buttons zoom and pan. **Lokasi
  saya** centres on the phone's position. The first view fits every station and
  the driver.
- The map is built into the app: raster tiles, no library and no API key.
  Tiles come from `MAP_TILE_URL` (OpenStreetMap by default) with the attribution
  in `MAP_ATTRIBUTION`. The page's CSP follows the configured tile host. The
  OpenStreetMap Foundation's tile server is meant for light use, so a busy
  deployment should point `MAP_TILE_URL` at its own or a commercial tile
  service.
- A site without coordinates stays in the list, and the map says how many are
  missing.

**Favourites**
- A star on every station and partner-site screen. Favourites appear in a
  **Favorit** section on Home.
- They are kept per phone and, for a driver signed in with a phone number, per
  account, so they follow the driver to a new phone.
- A partner-network location can be a favourite only for a driver whose card
  may roam. The limit is 50 favourites.

**Push notifications (Web Push, no app store)**
- **Akun → Notifikasi** switches them on for the phone. A *Beri tahu saya saat
  selesai* card offers them on the live charge screen, and *Ingatkan saya* on a
  reservation.
- Sent for:
  - charging started, and finished (with kWh)
  - receipt ready (with total)
  - refund paid
  - a partner network's charge record for a roaming card
  - reservation reminder 5 minutes before the end, and reservation ended
- Tapping a notification opens the right screen (`#s/<charge>`, `#rr/<record>`,
  `#home`, `#history`). Messages follow the app language.
- Standard Web Push: payloads are encrypted to the phone (RFC 8291 `aes128gcm`)
  and signed with a VAPID key (RFC 8292). Both are implemented in
  `services/webpush.ts` without a dependency and checked against the RFC's test
  vector.
- The VAPID key pair is generated once and stored sealed with `SECRETS_KEY`,
  unless `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` are set.
- Sending is an outbox in the gateway:
  - each event goes once to each phone
  - retries at 30 s, 5 min and 30 min
  - a subscription the push service reports gone (404/410) is deleted
  - rows are pruned after 14 days
- In production, notifications go only to the known push services in
  `PUSH_ALLOWED_HOSTS` (the endpoint comes from the phone, so this is an SSRF
  guard), over the same guarded DNS lookup as webhooks.
- A service worker (`/app/sw.js`) receives the notifications. It caches
  nothing, so deploys still reach phones on the next load.
- On iPhone, Web Push works only for the app added to the Home Screen; the app
  says so there.

**Reservations (OCPP ReserveNow)**
- A driver signed in with a phone number or fleet card sees **Pesan konektor
  15 menit** (reserve for 15 minutes) on an available connector.
  - The charger receives `ReserveNow`.
  - Home shows the reservation with a live countdown, **Mulai isi** and
    **Batalkan**.
  - Cancelling sends `CancelReservation`.
- While a connector is reserved, other drivers see it as *Dipesan* (reserved),
  and paying for it or starting a fleet charge on it is refused. The holder
  charges normally.
- A fleet driver's reservation holds their card. A QRIS driver's holds a claim
  token that becomes the payment's token at checkout, so the charger's reserved
  idTag and the paid idTag are the same.
- The reservation is marked used when that idTag starts a session on the
  connector. At the end it expires, with a push, and an unpaid claim token is
  retired.
- Limits:
  - one live reservation per driver, one per connector (enforced by unique
    indexes)
  - after `DRIVER_RESERVATION_NO_SHOW_LIMIT` (2) unused reservations in 24 h,
    reserving pauses until the next day
  - no fee
- A charger that answers Occupied, Faulted or Rejected, or is offline, gets the
  reason back and nothing is held.
- Reserved connectors also show as `RESERVED` to roaming partners (OCPI EVSE
  status). OCPI reservation ids and ReserveNow ids now share one sequence, so
  they never collide on a charger.
- Turn reservations off with `DRIVER_RESERVATIONS=false`; the length is
  `DRIVER_RESERVATION_MINUTES`.

Needs migration **018** (additive): favourites, push subscriptions and outbox,
reservations with RLS, the shared ReserveNow id sequence, and a small platform
settings table for the VAPID key.

**Not included:**
- marker clustering (close stations overlap until zoomed in)
- offline map tiles
- a native app (Web Push covers Android, desktop and installed iPhone apps)
- reservation fees
- reserving a partner-network charger (OCPI `RESERVE_NOW` towards CPOs)

## Published API (OpenAPI 3.1) and developer sandbox

The operator API is now documented, published and testable without hardware
(gap analysis P1).

**The API document**
- `/openapi.json` is an OpenAPI 3.1 document covering the whole integration
  API: 160 operations in 25 groups at release of that feature, 182 with fleet
  billing, 192 with promotions and memberships, 211 with Plug & Charge, 216 with onboarding, 221 with integrations.
  - Each operation has its parameters, request body with an example, response
    schemas, error statuses, and the permissions its handler checks
    (`x-permissions`).
  - The 11 webhook events are documented under `webhooks`, with the envelope
    and the signature header.
  - Console sign-in and platform administration are left out on purpose.
- `/api-docs.html` is a readable API reference, self-hosted with no external
  library.
  - Search, grouped by area, with request and response fields as trees.
  - A curl command for every operation.
  - **Try it** sends a request with a key the developer pastes in. The key is
    kept in that browser tab only.
- The document is generated from a catalogue kept next to the code
  (`src/api/openapi/`, `npm run openapi`), and three checks keep it accurate:
  - A unit test fails when a route and the catalogue disagree, statically and
    against the running API.
  - The same test fails when the committed document is out of date, or when a
    schema does not compile.
  - The sandbox end-to-end test calls every documented GET and validates the
    live response against its schema.
  - Permissions are read from each handler's own source, so they cannot drift
    from the code.

**Developer sandboxes (Govern → Developers)**
- **Create a sandbox** makes a separate tenant with:
  - a Jakarta site
  - a 60 kW DC charger with two connectors and a 22 kW AC charger, both
    virtual
  - a legal tariff
  - three RFID cards (one blocked)
  - an API key with operator rights inside the sandbox only, shown once
- Up to 3 sandboxes per operator. The key can be rotated, and the sandbox can
  be deleted, which archives it and keeps its audit trail.
- **Virtual chargers speak real OCPP 1.6.** They are the QA simulator's charge
  point, run by the gateway and attached through an in-memory socket instead
  of the network. Everything above the transport is the production code path:
  commands, metering, rating, tax receipts, alerts, webhooks, the OCPP log.
  - They answer remote start and stop, reset, unlock, availability,
    configuration, local lists, smart charging, reservations, firmware updates
    (they report each stage and reboot on the new version), and diagnostics
    (they upload a generated log).
  - Energy accrues 30× faster than the wall clock, so a session gives kWh in
    seconds.
- `POST /v1/sandbox/chargers/{identity}/simulate` acts out what happens at a
  real charger:
  - a cable plugged in, and a card tapped (optionally charging until the car
    is full)
  - a stop at the charger, and an unplug
  - a connector fault with a vendor code, and clearing it
  - the 4G link dropping (the session carries on, and its messages are sent on
    reconnect) and coming back
  - a reboot
- `GET /v1/sandbox` describes the sandbox. `POST /v1/sandbox/reset` brings
  every charger back online, stops sessions and clears faults.
- A charger registered through the API inside a sandbox becomes virtual too,
  so integrators can test onboarding end to end. It answers Pending until it
  is activated.
- **Isolation:**
  - A sandbox is its own tenant under row-level security. Its key cannot see
    the operator, and the operator's own lists do not include sandbox chargers.
  - Sandbox sites never appear in the driver app or in platform billing.
  - Roaming changes are refused in a sandbox.
  - Nothing on the network can connect as a virtual charger: the upgrade is
    refused whatever the credentials.
  - Auto-adopt never puts a charger into a sandbox.
- `deploy/Caddyfile` gains an optional `api.` host for integrators.
  - It serves `/v1/*`, `/openapi.json` and `/api-docs.html`.
  - It strips cookies, so only API keys work there, and it does not serve the
    console sign-in routes. The console can stay behind its allow-list.

**API fixes found while documenting it**
- A malformed id (e.g. `/v1/sessions/not-a-uuid`) answered **500**; it is now
  **400**.
- A command to a charger that is not connected answered **500**; it is now
  **409** with `code: "charger_offline"`.
- The QA simulator's charger stayed "in session" after a card was refused at
  Authorize, and so refused every later start. This is fixed, with a
  regression test.

Needs migration **019** (additive): `organisation.sandbox_of_org_id` and
`archived_at`, and `charge_point.virtual`. There are no new settings.

**Not included:**
- OCPP 2.0.1 virtual chargers (the virtual fleet speaks 1.6; the 2.0.1 path
  is covered by the other end-to-end suites)
- generated client SDKs (any OpenAPI generator works on the document)
- the driver app API (`/d/*`) and the OCPI endpoints (`/ocpi/*`, specified by
  OCPI 2.2.1) are not in the document
- per-key rate limits (the limit is per IP)

## Fleet monthly statements, B2B invoices and e-Faktur (Commercial → Fleet billing)

Companies whose drivers charge with fleet cards now get one monthly invoice,
with PPN stated the way a faktur pajak needs it, and the operator gets the file
to issue those faktur in Coretax (gap analysis P2).

**Fleet accounts**
- A fleet account is the company a card is billed to. It holds:
  - the legal name
  - NPWP (a 15-digit one is converted to 16 digits) or NIK
  - NITKU (empty means the head office)
  - address, one or more billing e-mails, and a contact
  - payment terms (default 14 days)
  - whether partner-network charging is re-billed
- A card's fleet name in the RFID centre decides its account. A database
  trigger creates the account the first time a name is used and keeps the link
  whichever path wrote the card: the console, the API, the seed or a sandbox.
  Existing fleet cards are linked by migration 020.
- Cards can also be moved between accounts by UID. Renaming an account renames
  the fleet on its cards.

**The monthly statement and invoice**
- **At your stations:** every session charged with the account's cards, by the
  month its charge record was issued (as for commission statements),
  prepaid QRIS sessions excluded. Grouped per site:
  - sessions and kWh
  - energy and fees, and PBJT-TL at the site's own rate
  - the price subject to PPN
  - **DPP nilai lain = 11/12 of the summed price**, and **PPN = 12% of the
    DPP**, per line
- These are the figures the faktur carries, so invoice and faktur agree to the
  rupiah. The per-session receipts round each session separately. Any
  difference, at most a rupiah per session, is shown; it was zero in the test.
- **Partner networks:** charge records other operators sent for the cards are
  re-billed at the amount the operator charged, in a separate section, and are
  not on the operator's faktur. Records in another currency are left off with a
  warning. This can be switched off per account.
- **Issuing:**
  - An invoice can be issued only after the month ends: one account at a time,
    or **Issue all**.
  - Numbers are `PREFIX/YYYY/MM/NNNN`, sequential per organisation and year
    (the prefix is set in Settings). The due date follows the account's terms.
  - The invoice freezes the statement, with seller and buyer details as they
    were.
  - Each session or partner record is on at most one live invoice, enforced by
    the database.
  - **Void** keeps the number, marks the invoice void and releases its charges
    for a corrected invoice. If the faktur was already exported, it warns to
    cancel or replace it in Coretax. A paid invoice cannot be voided.
- **Documents:** an A4 printable invoice (print to PDF from the browser) with
  an appendix of sessions by card, and a session CSV. Drafts can be printed
  too, marked DRAFT.
- **E-mail:** the invoice is sent to the account's billing address(es) through
  the organisation's e-mail channel (Alert routing), with the invoice (HTML)
  and the session list (CSV) attached. `sendEmail` gained attachment support.
- **Payment:** record the date and bank reference; the list shows overdue
  invoices.
- The Fleet billing page warns about fleet-card sessions whose card is on no
  account, which would otherwise go unbilled.

**e-Faktur (Coretax)**
- **e-Faktur XML** produces the Coretax bulk-import file (Faktur Pajak → Pajak
  Keluaran → Impor Data) for a month's invoices:
  - one faktur per invoice with PPN, transaction code **04** (PPN 12% on DPP
    nilai lain)
  - one line per site, with TaxBase = price, OtherTaxBase = DPP and VAT = PPN
  - seller and buyer TIN and NITKU; a NIK buyer is sent as National ID
- Invoices whose buyer has no NPWP/NIK, or that carry no PPN, are skipped and
  named.
- **The export is blocked until** the seller's NPWP and NITKU are saved, and
  the item type (goods or services), the 6-digit code and the unit code are
  set and ticked as confirmed with a tax adviser. How EV charging is
  classified is not something the software should guess; changing any of these
  clears the confirmation.
- After approving the faktur in Coretax, record its number on the invoice;
  it is printed there.
- **Verify before relying on it:** the XML follows the DJP import template.
  Import the first file into Coretax and check the drafts before approving,
  because DJP revises the template.

**API:** 22 operations under `/v1/fleet-accounts`, `/v1/fleet-invoices` and
`/v1/fleet-billing`, documented in `/openapi.json`.
- Reading needs `invoice:read`; issuing, voiding, payments, sending and
  settings need `invoice:write`.
- Changing an account's cards also needs `token:write`.
- Everything is audited.

Needs migration **020** (additive): fleet accounts with the card link and
trigger, invoices and their items with RLS, and the seller's NITKU, billing
address and invoice settings on the organisation. There are no new
environment variables.

**Not included:**
- a server-generated PDF file (the invoice prints to PDF from the browser)
- credit notes (void and re-issue instead)
- online payment of invoices, and automatic payment matching
- a portal for fleet companies
- sending the faktur through Coretax's API (the XML is imported by hand)
- e-Bupot / PPh withholding

### Credit notes, PDF invoices and the fleet customer portal

- **PDF invoices.** The server now generates each fleet invoice as an A4 PDF.
  - Contents: seller and buyer with NPWP, the lines per site with DPP and PPN, partner networks and memberships, credits and the amount due, how to pay, and an appendix with every card and session.
  - Each page is numbered.
  - A draft month prints as a draft.
  - Invoice e-mails attach the PDF (with the session CSV) instead of an HTML copy.
  - The PDF writer is built in: no new dependency and no browser on the server.
- **Credit notes** (Invoices → open an invoice → Credit note), numbered `PREFIX-CN/YYYY/MM/NNNN`. They cover the whole of what is left, or lines of an amount each, and each comes with its own PDF.
  - The invoice never changes: its figures stay those of the faktur pajak.
  - Amounts include PPN. A line with PPN is split into price, DPP (11/12) and PPN (12% of DPP) exactly like an invoice line, so the tax reversed is right to the rupiah. A credit can never take back more than the invoice charged (in total, DPP or PPN), or more of its untaxed part.
  - **Unpaid invoice:** the credit reduces what is owed; when nothing is left the invoice is settled ("Settled by credit note …").
  - **Paid invoice:** refunded (record the refund when paid out) or deducted from the account's next invoice, which then shows the deduction and the amount due.
  - A credit note can be e-mailed, and voided while nothing has been done with it (voiding one that settled an invoice re-opens the invoice). An invoice with live credit notes cannot be voided.
  - If the invoice's faktur pajak was already reported, the console warns that a nota pembatalan is needed in Coretax. Credit notes are not in the XML export.
  - **Credit notes** tab: every credit note, filterable to those still to refund or deduct.
- **Fleet customer portal.** A fleet customer's own staff sign in to the console with the new role **Fleet customer (portal)**, granted per fleet account. Invite them from the account's **Portal access** tab or from Users & Roles.
  - They see what they owe, their invoices and credit notes (PDF, and the session CSV), this month so far, and their cards with this month's use.
  - They can **block a lost card**, which stops working at once, on partner networks too. They can unblock only a card they blocked; a card the operator blocked stays blocked, and the operator's list shows "blocked by the customer".
  - The grant carries one permission, `fleet:portal`, that no operator route accepts. Every portal route checks the user's own account (another account's documents are 404, operator pages 403). The console shows them only the portal page.
- Outstanding amounts, overdue flags and the account list now take credits into account.
- API: `GET /v1/fleet-invoices/:id/invoice.pdf` and `GET /v1/fleet-accounts/:id/statement.pdf`.
  - `POST /v1/fleet-invoices/:id/credit-notes`.
  - `GET /v1/fleet-credit-notes`, `GET /v1/fleet-credit-notes/:id` and `GET /v1/fleet-credit-notes/:id/credit-note.pdf`.
  - `POST /v1/fleet-credit-notes/:id/refunded`, `…/void` and `…/send`.
  - Invoices gain `creditedIdr`, `priorCreditIdr`, `balanceIdr`, `creditNotes` and `priorCredits`.
  - Users accept `fleetAccountId` for the new role. `/v1/auth/me` returns `fleets`.
  - 237 operations. The portal's own routes (`/v1/fleet-portal/…`) are for its console sign-in only and are not in the published document.
- Needs migration **030** (additive: nothing is credited and nobody has portal access until you create them).
- **Deployment note:** portal users are outside your office, and the supplied Caddyfile keeps the console behind an office / VPN allow-list. Publish it for them (its own hostname without the allow-list, or their addresses). The same applies to site owners.

## Promotions, memberships and passes (Commercial → Promotions & plans)

Operators can now sell monthly memberships and run promotions, and drivers can
enter promo codes and buy passes in the app (gap analysis P2).

**How a discount is applied**
- Discounts are applied when the session is rated: after the regulatory price
  caps, and before PBJT-TL and PPN. So both taxes fall with the discount.
- Each discount is a negative line on the receipt, named after the plan or
  promotion, of the same kind as what it reduces. An energy discount is an
  energy line, so PBJT-TL (a tax on electricity) is charged on the discounted
  energy.
- A session gets the customer's membership plus at most one promotion. The
  software takes whichever allowed combination is cheapest for the customer.
- A promotion marked "not with memberships" competes with the membership
  instead of adding to it.
- Eligibility is judged at the time the session started. No discount can take
  energy or fees below zero.

**Membership plans**
- A plan has a monthly fee, plus any of:
  - a member price per kWh (used only where it is lower than the tariff)
  - % off energy
  - kWh included per month
  - the service fee waived
  - AC/DC only, or chosen sites only
- **Fleet members:** a fleet account (all its cards) or a single card is
  enrolled in the console.
  - The fee is charged on the monthly **fleet invoice**, with DPP 11/12 and PPN
    12% as its own line. Alternatively the membership can be complimentary.
  - A month's fee is billed once. Voiding the invoice releases the fee for the
    corrected invoice.
  - A cancelled membership is still billed for the month it was cancelled in.
  - The e-Faktur file carries the fee as its own line, with its own item type
    and codes (services, by default). These are set in Fleet billing →
    Settings and confirmed like the charging item.
- **App passes:** a plan marked "offered in the app" can be bought by a
  signed-in driver as a **30-day pass paid by QRIS** (fee + PPN).
  - Renewing adds 30 days from the end of the current pass. It is not renewed
    automatically.
  - The driver gets a push notification 3 days before the pass ends.
  - A driver can hold one live membership per operator.
- Included kWh are counted per calendar month (per 30 days for a pass). The
  app shows what is left.

**Promotions**
- Kinds: % off energy, a promotional price per kWh, rupiah off the session,
  free kWh, or the service fee waived.
- Who can use one:
  - everyone
  - new drivers (no earlier rated session)
  - chosen fleet accounts
  - members of chosen plans
  - whoever enters its **promo code** in the driver app (any case)
- Limits:
  - start and end dates
  - days of the week, and a time window (happy hour; it may cross midnight)
  - sites, and AC/DC
  - a minimum kWh
  - total uses and uses per customer (by app account, card or device)
  - a rupiah budget
- The list shows each promotion's uses, number of customers and the discount
  given so far.

**Driver app**
- A promo code box on the charge screen:
  - the quote shows the member price or promotion, and how much more energy
    the same rupiah buys;
  - an unknown or ineligible code is explained.
- The prepaid allowance is computed with the best discount, so the driver
  gets more kWh for the amount paid.
- The receipt shows each discount line.
- Account → **Langganan** lists the plans on offer and the driver's passes,
  with the kWh left, and has a QRIS payment screen.

**API:** 10 operations under `/v1/subscription-plans`, `/v1/subscriptions` and
`/v1/promotions`, documented in `/openapi.json`.
- Reading needs `tariff:read`; changes need `tariff:write`.
- Changes are audited.
- The driver app's `/d/v1/memberships` routes are for the app only.
- `FleetStatement` gained `fees` and `totals.feesIdr`.

Needs migration **021** (additive):
- plans, memberships, included-kWh usage, per-session benefit records,
  membership charges, promotions and redemptions, all with RLS;
- the promo code on a driver's prepaid charge;
- the fees total on fleet invoices.

There are no new environment variables.

**Not included:**
- automatic renewal or card-on-file billing of passes
- a live QRIS acquirer (the mock one is used, as for charging)
- proration of fees for part of a month
- promotions on partner-network (roaming) sessions
- referral programmes, loyalty points, gift vouchers

### Passes renew automatically, plans switch with proration, and loyalty points

- **Automatic renewal.** A driver can have their pass renew itself with a saved card or a linked e-wallet: tick it when paying, or turn it on (and off) under Account.
  - The renewal worker (every 15 minutes, in the gateway) charges the method a day before the pass ends. The new 30 days follow on without a gap, at the plan's current fee.
  - A payment that needs the driver (an e-wallet PIN, 3-D Secure) waits for them. The app shows "confirm in GoPay" with a button, and the driver gets a push notification. Buying by hand meanwhile is refused, so nobody pays twice.
  - A decline is retried after 1, 6 and 12 hours, and the driver is told after the first.
  - A removed card, an ended e-wallet link or a plan no longer offered stops renewal, with the reason, and the driver is told.
  - The reminder three days before the end says "renews on … with …" when it will.
  - A renewal the acquirer later reports as expired, refused or cancelled is retried the same way.
  - On Midtrans, unattended saved-card charges need `savedCard3ds: false` on the acquirer settings. Otherwise each renewal waits for 3-D Secure.
- **Switching plans with proration.** A driver with days left on one plan can switch to another at the same operator. The app quotes the switch.
  - The unused value of the current pass (each paid window, pro rata) is credited against the new plan's fee.
  - A dearer plan costs the difference now, for 30 days. A cheaper or equal one costs nothing, and its window is lengthened by the credit left over at the new plan's daily price.
  - The plan changes when the switch is paid, so an abandoned payment leaves the old pass untouched. The charges it replaces end at the switch, so nothing is credited twice.
- **Fleet memberships billed by the day.** A membership that starts or is cancelled mid-month is billed for the days it was in force, e.g. "card ABC-001, 10 of 30 days". The share is on the invoice line and in the e-Faktur item name. A whole month still costs the whole fee.
- **Loyalty points** (Promotions & plans → Loyalty points), per operator, off by default.
  - Drivers signed in to the app earn points on what each session costs them: *n* points per Rp 1,000 of the receipt total.
  - A driver who ticks "use my points" has them taken off their next sessions automatically. This is a discount line before PBJT-TL and PPN, like a promotion, at most the set share of the energy and service fees. It is applied on top of the cheapest membership/promotion combination.
  - Points are spent oldest first, and expire after the set number of months (a worker every 6 hours).
  - The receipt shows the points used and earned. The app's account screen shows each operator's balance, its value, points expiring within 30 days and the recent history.
  - The console shows the points outstanding and what they are worth (a liability to account for), points earned, spent and expired this month, and the drivers with the most points (phones masked). Goodwill adjustments show in the driver's history and can never go below zero. All changes are audited.
  - A session earns and spends at most once, so re-rating cannot double either.
- API:
  - New: `GET`/`PUT /v1/loyalty`, `GET /v1/loyalty/members` and `POST /v1/loyalty/adjust`.
  - Memberships gain `auto_renew`, `renew_error` and `renew_next_at`.
  - Driver app: `PUT /d/v1/memberships/:id/auto-renew`, `GET /d/v1/loyalty` and `PUT /d/v1/loyalty/:orgId`. `POST /d/v1/memberships` accepts `autoRenew` and handles switching.
  - The receipt gains `loyalty`.
  - 241 operations.
- Needs migration **031** (additive: no pass renews, nothing changes for months already invoiced, and nobody earns points until an operator switches loyalty on).

## OCPP 2.0.1 device model (charger drawer → Device model)

An OCPP 2.0.1 station describes itself as components (EVSE 1, Connector 1/2, OCPPCommCtrlr, SampledDataCtrlr…), each with variables. Until now its NotifyReport was acknowledged and dropped, and there was no way to change a 2.0.1 setting from the console (gap analysis P2). The new **Device model** tab in the charger drawer:

- **Request report** sends GetBaseReport: the full inventory, configurable settings only, or a summary.
  - The station's NotifyReport parts are stored as they arrive, grouped by component, EVSE and connector.
  - The tab shows "requested → receiving (n items) → complete", or the station's refusal.
  - A part that arrives before the station has even answered the request is kept.
  - Each variable shows:
    - its value, and any Target, MinSet or MaxSet;
    - its data type, unit, limits and allowed values;
    - whether it is read-only, read-write or write-only.
- **Save** sends SetVariables for one variable, **after** checking the value against what the station reported:
  - whole numbers and decimals within the station's limits;
  - true/false;
  - a date and time;
  - one of the listed options, or a comma list of them (each once).

  Read-only and constant attributes are refused. Accepted and RebootRequired answers are stored; RebootRequired is flagged.
- **Protected variables** are shown but never set here; each has its own safe flow:
  - SecurityCtrlr (Security tab);
  - the network connection profile and its priority (Onboarding);
  - anything named like a password or key.
- The **refresh** button on a row reads the value now (GetVariables) and stores it.
- **Monitors.**
  - "Monitor…" on a variable that supports monitoring adds one (SetVariableMonitoring): an upper or lower threshold, a delta, or a periodic or clock-aligned reading, with a severity from 0 (danger) to 9 (debug), optionally only during sessions.
  - "Monitoring report" (GetMonitoringReport / NotifyMonitoringReport) lists the station's own monitors: hard-wired, preconfigured and custom.
  - Remove sends ClearVariableMonitoring.
- **Cleared events.** A monitor in Alerting already raised one `charge_point.device_event` alert. The alert now resolves when the station reports the event **cleared**; before, it stayed open until someone resolved it.
- 1.6 chargers keep the Configuration tab. For them the Device model tab says so, and the API answers 409.
- Permissions: reading needs `charge_point:read`. Requests, changes and monitors need `charge_point:config` or `charge_point:command`, like the Configuration tab. Every command is in the audit log.
- API (7 new, 248 operations):
  - `GET /v1/charge-points/:identity/device-model`
  - `POST …/device-model/report`, `…/device-model/monitoring-report` and `…/device-model/get`
  - `PUT …/device-model/variable`
  - `POST …/device-model/monitors`
  - `DELETE …/device-model/monitors/:monitorId`
- The gateway now accepts NotifyMonitoringReport (schema-checked).
- Needs migration **032** (additive: three new tables; nothing changes for 1.6 chargers).
- Verified by field test scenario 19b (9 checks) and 9 unit tests.

## Driver queue at busy sites (Sites → Driver queue; driver app)

At a busy site, a driver who finds every suitable connector taken can now join a queue in the app instead of circling back (gap analysis P3). Off until an operator switches it on for a site.

**The policy (per site, in Edit site → Driver queue)**
- First come, first served. A driver may ask for AC or DC and a plug type, or take any connector.
- When a connector frees up, it goes to the earliest waiting driver who can use it. A later driver is served first only with a connector the earlier one cannot use.
- The freed connector is **held on the charger** (OCPP ReserveNow) for that driver, for the *time to start* (2–15 minutes, default 5).
  - Walk-ups cannot take it.
  - While drivers are waiting, the app also refuses to pay for or reserve a free connector they could use: the connector shows "Queued".
- The driver starts as with a reservation: pay (the held idTag is the payment's claim token), or a fleet card.
  - **Skip** gives the place up.
  - An offer not taken in time is a **missed turn**: the driver leaves the queue and the connector goes to the next one. There is one chance, so a no-show does not hold everyone up twice. A missed turn is not counted as a reservation no-show.
- At most *longest queue* drivers (1–200, default 20), waiting at most *longest wait* (15–720 minutes, default 120).
- Switching the queue off ends the waiting (the drivers are told).

**Driver app**
- **Station page:** a Queue section shows how many are waiting and the time to start. The driver can pick a connector type and tap **Join the queue**. Once in, the section shows their place ("number 2 in the queue": counting only the drivers ahead who compete for the same connectors) and how long they may wait, with **Leave the queue**.
- **Home:** the place in the queue, refreshed every 15 seconds. When it is the driver's turn, the card becomes **Your turn!** with a countdown, **Start charging** and **Skip**. A turn missed, a wait that ran out, or removal by the operator is explained once.
- **Push notifications**: your turn (with the time to start by), missed, wait ended, removed, queue closed. Indonesian and English.

**Console (Sites → site → Driver queue)**
- Who is waiting, in order (masked phone or fleet card, what they want, how long), and who holds a connector until when.
- The last 24 hours: charged, missed, left, waited too long, removed, with the median wait from joining to the offer.
- **Remove** a driver: their held connector goes to the next one, and they are told. Audited as `driver_queue.removed`.

**How it runs.** Offers are made in the gateway: the moment a connector reports Available, and every 15 seconds by the reservations worker. That also retries a hold the charger refused, and ends waits that are too long. Nothing to configure.

- API:
  - `GET /v1/sites/:siteId/queue` and `DELETE /v1/sites/:siteId/queue/:entryId`; 250 operations.
  - Sites gain `queueEnabled`, `queueOfferMinutes`, `queueMaxLength` and `queueMaxWaitMinutes`.
  - Driver app: `GET /d/v1/queue`, `GET /d/v1/sites/:siteId/queue` (public), `POST /d/v1/queue` and `POST /d/v1/queue/:id/leave`.
  - A queue offer appears in `GET /d/v1/reservation` with `queue: true`.
- Needs migration **033** (additive: no site has a queue until it is switched on).
- Verified by `npm run e2e:queue` (19 checks, on a raw OCPP 1.6 charger with a CCS2 and a CHAdeMO connector and four signed-in drivers) and 9 unit tests.

## Driver app: grouped map markers, and reserving partner chargers

**Grouped markers on the map.**
- **Before:** with hundreds of stations, the markers of a city piled on top of each other.
- **Grouping:** stations that would overlap at the current zoom are now shown as one round bubble with the number of stations.
  - Green if any of PlugSure's stations in it has a free connector; blue for partner stations only.
  - Worked out once per zoom step, so pinching does not reshuffle markers.
- **Tapping a bubble** zooms in until the group splits. Stations at the very same spot, which never split, are listed in the card at the bottom instead (ten, and how many more with a pointer to the List).
- **Legend:** "Several stations close together".
- Nothing to set up. It is fast with thousands of stations: one pass over them per zoom step.

**Reserving a partner operator's charger** (gap analysis P3, "reserving partner-network chargers"). A fleet driver whose card may roam can now reserve a partner charger for 15 minutes (`DRIVER_RESERVATION_MINUTES`), like a PlugSure one:
- **Reserving:** "Reserve for 15 min" under a free partner charger. PlugSure (as the eMSP) sends the operator OCPI **RESERVE_NOW** with the driver's roaming card, our own reservation id and the expiry.
  - The operator answers at once whether it will try; the app shows "waiting for the charger to answer".
  - The charger's answer follows to our command endpoint: reserved, or refused with the reason (in use, not working, no answer, reservations not supported).
- **While reserved:** the station shows "Reserved for you" with the time to start by and **Cancel**. Home shows the reservation with a countdown, **Start charging** and **Cancel**. Starting a charge there uses the reservation up; so does a session the operator reports for the card at that location (tapping the card at the charger).
- **Cancel** sends **CANCEL_RESERVATION** with the same id.
- **Push:** a reminder five minutes before the end, and "reservation ended" when it lapses (the reservations worker).
- **One at a time:** one reservation per driver across PlugSure chargers, partner chargers and site queues.
- **Console:** the commands appear in the roaming command log (Commercial → Roaming) with their results.
- API (driver app):
  - `POST /d/v1/roaming/reservations`, `GET /d/v1/roaming/reservations/:id` and `POST /d/v1/roaming/reservations/:id/cancel`.
  - `GET /d/v1/reservation` now also returns `partner`.
  - The roaming command log may list `RESERVE_NOW` and `CANCEL_RESERVATION`.
- Needs migration **034** (additive: the command log accepts the two commands; a table ties a partner reservation to the phone).
- Verified by 7 new checks in `npm run e2e:ocpi-emsp` (now 60) against the mock CPO, and 4 unit tests for the map grouping.
- Before live use, ask each partner whether it accepts reservations: an operator that does not answers NOT_SUPPORTED, and the driver is told.

## Reservation fees (Sites → Edit site → Reservations)

Reserving a connector was free. An operator can now charge for it, per site (gap analysis P3):
- **Setting:** *Reservation fee*, Rp 0 (free, the default) to Rp 100,000, before PPN. A PKP operator adds PPN as for other fees (DPP 11/12, 12%): Rp 5,000 is Rp 5,550 to pay.
- **App drivers pay it first.**
  - "Reserve 15 min" shows the fee with its PPN. The driver chooses how to pay as for a charge: QRIS, e-wallet, card, a saved card or a linked e-wallet.
  - The connector is held (ReserveNow) only once the payment is confirmed. A saved card or linked e-wallet does this at once; QRIS and the e-wallet or card pages do it on the acquirer's notification. The app shows "Pay the reservation fee" and waits.
- **Fleet cards** reserve with nothing to pay. The fee goes on the fleet's next monthly invoice under "Connector reservations": one line per reservation (when, site, card, fee, PPN), counted in the month the connector was held. It is also on the invoice PDF, in the CSV, and as its own e-Faktur line with the fee item code.
- **The policy.** The fee pays for holding the connector:
  - **Kept** once the connector is held, whether or not the driver then charges or turns up.
  - **Not charged, or refunded,** when:
    - the charger refuses the hold;
    - someone else took the connector while the driver was paying;
    - the driver cancels within 2 minutes;
    - a payment arrives after the driver gave up, or after the checkout expired (30 minutes).

  Refunds go through Refunds as usual, automatically for linked e-wallets. A fleet fee is simply left off the invoice.
- **Queue turns stay free.**
- API:
  - Sites gain `reservationFeeIdr`.
  - The connector detail in the driver app gains `reservationFee` and `reservationPay`.
  - `POST /d/v1/reservations` takes payment options like a charge and, with a fee, answers with the checkout (and the QR).
  - New: `GET /d/v1/reservations/checkout/:id`, `POST …/confirm-payment` (development) and `POST …/cancel`.
  - Fleet statements and invoices list reservation fees in `fees` with `kind: "reservation"`.
- Needs migration **035** (additive: nothing is charged until an operator sets a fee on a site).
- Verified by `npm run e2e:reservation-fees` (12 checks: paying and holding, refunds on a quick cancel, a late payment and a refused hold, the fee kept after the grace, a fleet card's fee on the statement, waived, and invoiced once) and 3 unit tests.

## Roaming: partner smart charging and hubs (OCPI ChargingProfiles, HubClientInfo)

Two OCPI 2.2.1 modules that were missing (gap analysis P3).

**ChargingProfiles (§ 14, we are the RECEIVER).** A partner can limit how fast one of its drivers' sessions charges on your chargers. The request can come from the driver's service provider or from a smart-charging provider acting for it.
- The partner can:
  - **set** a limit: `PUT …/chargingprofiles/{session_id}`, a W or A schedule with up to 200 steps, absolute or counted from the start of charging;
  - **ask** what is in force: `GET …?duration=`. PlugSure asks the charger (GetCompositeSchedule). If the charger answers without a schedule, it describes the last profile it sent;
  - **lift** its limit: `DELETE`.
- PlugSure answers at once (ACCEPTED, or UNKNOWN_SESSION for a session that isn't this partner's or has ended). What the charger then did goes to the partner's `response_url` through the roaming outbox.
- **The partner can only slow a session down.** Its limit caps the session inside site load management. Load management remains the only thing that sends transaction profiles to the charger (stack level 5, as before), so the site's power budget, its PLN subscription and the station ceiling still decide. A limit above what the site allows changes nothing.
- The control pass runs as soon as the limit arrives, instead of waiting up to 30 seconds. A limit that steps down over time is re-evaluated on every pass.
- A partner may change a session's limit at most every 5 seconds; faster changes are answered TOO_OFTEN.
- The console shows the limits under Roaming → Roaming sessions → "Charging limits from partners": who set each limit, what it allows now, and whether the charger took it.

**HubClientInfo (§ 16).** A roaming hub tells us which operators and service providers are behind it, and whether each is connected.
- We receive its updates (`PUT …/hubclientinfo/{country_code}/{party_id}`). If the hub offers the list, we also pull it in full, following its pages: after it registers, every 6 hours, and from the console.
- An update older than the one we hold is ignored. A full pull forgets parties the hub no longer lists.
- **What it changes:** once a hub has sent its list, it may act (push tokens, send commands, publish locations) only for parties on the list that are CONNECTED or OFFLINE, not for SUSPENDED or PLANNED ones. A hub that has sent no list is still trusted for any party, as before.
- The console shows the list in the hub's panel, on a "Behind this hub" tab, with a "Refresh from hub" button.

**API**
- OCPI: our 2.2.1 endpoint list adds `chargingprofiles` and `hubclientinfo` (both RECEIVER).
- Console:
  - `GET /v1/roaming/charging-profiles`;
  - `GET /v1/roaming/partners/:id/hub-clients` and `POST /v1/roaming/partners/:id/hub-clients/refresh`;
  - the partner list gains `hub_clients`.
- 253 operations.

**Upgrade and tests**
- Needs migration **036**. It is additive: nothing changes until a partner sends a limit or a hub sends its list.
- Verified by `npm run e2e:ocpi-profiles` (36 checks, with a raw OCPP 1.6 charger, a mock service provider and a mock hub) and 4 unit tests.

**Not included**
- Sending charging profiles to other operators for our own cards (the eMSP side).
- Telling a partner by itself when the limit in force changes (the optional push of ActiveChargingProfile). The partner can ask with GET instead.

## API: TypeScript SDK and per-key rate limits (Govern → Developers, Users & roles → API keys)

Both were listed as optional follow-ups to the published API (gap analysis § 6).

**A TypeScript SDK (`@plugsure/csms-sdk`)**
- It is generated from the published OpenAPI document (`npm run sdk`), so it cannot drift from the API. A unit test fails when the committed SDK no longer matches the document.
- One typed method per operation, named by its operation id: `listChargePoints()`, `getChargePoint({ identity })`, `startSessionRemotely({ identity, body })`.
  - Every component schema is a TypeScript type.
  - Every webhook event is a type, with `WebhookEvent` covering all of them.
- **No dependencies.** It uses the platform's fetch, so it runs on Node 18 or later, Deno, Bun and browsers.
- **Return values:**
  - JSON answers come back parsed;
  - CSV, XML and HTML as text;
  - PDFs as an `ArrayBuffer`;
  - event streams as the raw `Response`.
- **Errors** are thrown as `PlugSureError`, with `status`, `code` and the body.
- **Retries:**
  - A request refused for the rate limit is sent again after the wait the API asks for (`maxRetries`, default 2; never longer than `maxRetryWaitS`, default 60 s).
  - Reads that fail with 502, 503 or 504, or with a network error, are retried with back-off.
- `plugsure.rateLimit` tells the caller how much of its allowance is left.
- **Webhooks:** `verifyWebhookSignature` and `parseWebhook` check the `PlugSure-Signature` of a delivery against its raw body, and refuse signatures older than 5 minutes.
- **Download:** Govern → Developers → **TypeScript SDK** (`/sdk/plugsure-csms-sdk.tgz`), then `npm install ./plugsure-csms-sdk.tgz`. The package carries its README.
- **Operation ids are tidier:** articles are dropped, possessives removed and acronyms camel-cased (`getAChargePoint` → `getChargePoint`, `listAPIKeys` → `listApiKeys`). Anyone who generated a client from the earlier document gets the new names when they regenerate.

**Rate limits per API key**
- Each key now has its own limit instead of sharing its IP's.
  - It works as a token bucket: a key may send its whole minute's allowance at once, then refills steadily.
  - The default is 600 requests a minute (`API_KEY_RATE_LIMIT_PER_MIN`). An administrator sets a different limit per key when issuing it, or later with the **Limit** button; empty means the default. A change applies from the key's next request.
- **Every answer to a key** carries `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` and `RateLimit-Policy`. Over the limit, the answer is 429 with `Retry-After` and `code: "rate_limited"`.
- **Usage:** the key list shows each key's requests in the last 24 hours, how many were over the limit and how many were errors. `GET /v1/api-keys/:id/usage` gives the same by hour.
- **Console and other callers without a key** keep the per-IP limit (`API_RATE_LIMIT_PER_MIN`).
- **Guessing keys:** requests with a key that does not authenticate get a small allowance per address (30 a minute, `API_KEY_AUTH_FAILURES_PER_MIN`).
  - Beyond it, those requests are answered 429, and all key requests from that address count against its IP limit.
  - Valid keys from the same address keep working.
- The limits are kept per API process. An installation that runs several API processes behind a balancer gives each key its limit per process.

**API**
- New:
  - `PATCH /v1/api-keys/:id` (name or `rateLimitPerMin`; audited as `api_key.updated`);
  - `GET /v1/api-keys/:id/usage`.
- `POST /v1/api-keys` takes `rateLimitPerMin`.
- The key list gains `rate_limit_per_min`, `effective_rate_limit_per_min`, `requests_24h`, `limited_24h` and `errors_24h`.
- 255 operations.

**Upgrade and tests**
- Needs migration **037** (additive: every key keeps the default limit).
- Verified by `npm run e2e:sdk` (23 checks, using the built SDK against the running API: typed calls, CSV, 404 and 403, the headers, a burst refused and the SDK's retry, the limit changed and reset from the console, usage by hour, guessed keys, and a real webhook delivery verified) and 9 unit tests.

**Not included**
- SDKs in other languages. The OpenAPI document works with standard generators (openapi-generator for PHP, Python, Java, Go…).
- Limits shared across several API processes.

## ISO 15118-20 and bidirectional charging (V2G / V2B, OCPP 2.1)

Cars that speak ISO 15118-20 can tell the charger what they need and, if they support bidirectional power transfer, give energy back. This release is the CSMS side (gap analysis P3).

**OCPP 2.1**
- 2.1 is now a protocol of its own, not an alias of 2.0.1. It is accepted when listed in `OCPP_VERSIONS` (e.g. `ocpp1.6,ocpp2.0.1,ocpp2.1`).
- Chargers can be registered as 2.1 in the console and the API, and a 2.1 station's boot records 2.1.
- 2.1 has its own message schemas: the 2.0.1 set with 2.1's wider enumerations (new trigger and stop reasons such as OperationModeChanged, new measurands, new id-token types). Before, a 2.1 station reporting one of those was refused.
- A 2.1 station asking for its charger certificate now gets the 2.x trigger message; before, it was sent the 1.6 one.

**What the car says (OCPP 2.0.1 and 2.1)**
- **Charging needs.** NotifyEVChargingNeeds is stored and linked to the session:
  - the energy transfer mode requested and the ones available (including DC_BPT / AC_BPT);
  - ISO 15118-20 control mode, departure time, energy wanted and target SoC;
  - battery size, SoC, and maximum charge and discharge power.
  Load management re-plans at once.
- **Other messages from the station.** NotifyEVChargingSchedule (the car's schedule, kept), NotifyChargingLimit / ClearedChargingLimit (a limit from an energy management system or the grid, kept on the charger) and ReportChargingProfiles are answered instead of refused.
- **Meter values.** The export register (Energy.Active.Export.Register) and the car's SoC are tracked per session, beside the import register. What a session is billed for charging is unchanged.

**Giving energy back**
- **The operator's programme, per site** (Sites → Edit site → Bidirectional charging):
  - the hours cars may give energy back, for example PLN's evening peak;
  - a site limit;
  - a battery floor (default 40 %);
  - the driver's credit per kWh.
- **Nothing flows back to PLN by default.** Discharge is capped at the site's own auxiliary load, the reserve set in load management, so the cars only cover what the building would otherwise draw (V2B). Export to the grid must be allowed explicitly, and the console warns that it needs a PLN export agreement.
- **Consent.** Nothing discharges without it.
  - **App drivers** see an offer on the live-charge screen when the site has a programme and their car offered bidirectional transfer. They agree with their own battery floor (never below the site's), and can withdraw at any time.
  - **Fleets** give standing consent for their cards (Fleet billing → account → V2G), with their own floor.
  - The credit rate is fixed when consent is given.
- **Who decides.** Site load management plans discharge on every pass. It shares the pool fairly, capped by what each car and connector can do. It sends each chosen car a discharge setpoint (operation mode CentralSetpoint, a negative setpoint, with a discharge limit; a Dynamic profile for cars in ISO 15118-20 dynamic control) in place of its charging limit, using the same profile id and stack.
- A car stops discharging:
  - at its floor (re-planned the moment the SoC report arrives);
  - an hour before its driver leaves;
  - outside the programme's hours;
  - when consent is withdrawn (the station is also told, with NotifyAllowedEnergyTransfer, that bidirectional transfer is no longer allowed).
  After stopping at the floor, a car resumes only 2 % above it.
- **Only OCPP 2.1 chargers are asked to discharge.** 2.0.1 cannot carry a discharge setpoint.
- **The credit** for energy given back is taken off the session before PBJT-TL and PPN, like a discount. It never takes the session below zero. It appears on the receipt as "Credit for energy given back", and on a fleet's invoice through its sessions.

**Console and API**
- A session's new **Car (ISO 15118)** tab shows:
  - what the car asked for and can do;
  - its battery level;
  - energy given back and the credit;
  - consent and its source;
  - whether it is discharging now, or why not.
- `GET /v1/sessions/:id` gains `v2x`, `energy_export_wh`, `soc_percent`, `v2x_consent`, `v2x_discharging` and `operation_mode`.
- Sites gain `v2xEnabled`, `v2xWindows`, `v2xMaxDischargeW`, `v2xAllowExport`, `v2xMinSocPercent` and `v2xCreditIdrPerKwh`. Fleet accounts gain `v2xAllowed` and `v2xMinSocPercent`.
- **Driver app:**
  - `POST /d/v1/charge/:id/v2x` (`enabled`, `minSocPercent`);
  - the live status gains `v2x`.

**Upgrade and tests**
- Needs migration **038**. It is additive: nothing discharges until an operator enables a site and a driver or fleet agrees.
- Verified by `npm run e2e:v2x` (21 checks, with a raw OCPP 2.1 station) and 6 unit tests (the needs, the hours, the planner's rules, the credit, the 2.1 schemas).

**Not included**
- Grid-code functions (frequency and voltage support, DER control, SetDERControl) and price or tariff schedules sent to the car.
- Energy-market settlement of exported energy (the credit is the operator's own).
- Bidirectional AC (AC_BPT) is planned in watts like DC. It now runs end to end against the sandbox's virtual AC charger (see the next section), but has not been tried on AC bidirectional hardware. Check it on the bench.
- ~~Sandbox virtual chargers remain OCPP 1.6.~~ Resolved: sandbox chargers now speak 2.0.1 and 2.1 (next section).
- Before live use: test each 15118-20 car and 2.1 charger pair on the bench, including dynamic control mode, and agree the credit's tax treatment with a tax adviser.

## Signed meter values (OCMF), and a sandbox that speaks OCPP 2.0.1 and 2.1

**Signed meter values.** Calibration-law meters sign their register readings, so a driver or an auditor can check the kWh billed against what the meter itself recorded. PlugSure reads, keeps and verifies them in the Open Charge Metering Format (OCMF), the format used by most Eichrecht meters. It checks the ECDSA P-256 signature with SHA-256.

- **Where the readings come from:**
  - OCPP 1.6: `SignedData` samples, in MeterValues or in StopTransaction's `transactionData`;
  - OCPP 2.0.1 and 2.1: `signedMeterValue`, whose `publicKey`, if the station sends one, is kept beside the reading.
- **The meter key** is registered per connector (Onboard → connector → Meter public key; `meterPublicKey` in the API). It accepts:
  - hex DER or base64 DER;
  - PEM;
  - the raw 65-byte point printed on many meter labels.
  It is stored as hex DER. A key that is not a P-256 public key is refused.
- **Verification when a session ends:**
  - Each reading is re-checked against the registered key.
  - Readings must come from one meter, and its serial must match the connector's.
  - The signed begin and end import readings must match the billed energy within 2 Wh.
  - Each session gets a `signed_status`:

  | Status | Meaning |
  |---|---|
  | `verified` | Signed by the registered key and matching the bill |
  | `unverified_key` | Valid, but only against a key the charger sent, not a registered one |
  | `mismatch` | Signed energy differs from the bill (both figures shown) |
  | `invalid` | A signature failed, another meter, or a key conflict |
  | `incomplete` | Begin or end reading missing |
  | `missing` | No signed data where it is required |

  A key the charger sends never makes a session `verified`. If it differs from the registered key, the reading is `invalid`.
- **Per-site policy** (Sites → Edit site → Signed meter data):
  - `off`;
  - `record` (default): keep and verify; `mismatch` and `invalid` raise a warning, and the session is still billed;
  - `require`: any session that is not `verified` is parked for review with `SIGNED_METER_<STATUS>` and not invoiced until someone decides.
- **What drivers and auditors get:**
  - the tax receipt has a signed-data section: status, readings, OCMF text and meter key;
  - the driver app receipt shows "Meter bertanda tangan" with the status;
  - a session's new **Signed meter data** tab has the same, plus a download for the Transparency Software;
  - OCPI CDRs carry `signed_data`.
- **API:**
  - `GET /v1/sessions/:id/signed-data`;
  - `GET /v1/sessions/:id/signed-data.xml` (for the Transparency Software);
  - `POST /v1/charge-points/:identity/signed-metering` (`enabled`). On 2.0.1 and 2.1 it sets `SampledDataCtrlr` / `AlignedDataCtrlr.SignReadings`, and `OCPPCommCtrlr.PublicKeyWithSignedMeterValue=OncePerTransaction`, with SetVariables. On 1.6 there is no standard setting, so the call returns 409 `not_ocpp2` (use the vendor's configuration key);
  - `GET /v1/sessions/:id` gains `signed_status`, `signed_energy_wh` and `signed_detail`.
- **Bug fixed:** a 1.6 `SignedData` sample used to be parsed as a number (`NaN`). It could then be taken as the final register reading. Signed samples are now kept as signed data only, and non-numeric values are never used as registers.

**Sandbox chargers speak OCPP 2.0.1 and 2.1.** A virtual charger now speaks the protocol it is registered with. Before, every virtual charger spoke 1.6 whatever its registration. A translation layer between the simulator and its socket makes it a 2.x station:
- **Messages:** TransactionEvent with its own string transaction id and sequence numbers, RequestStart/StopTransaction, SetVariables/GetVariables with a device model (GetBaseReport → NotifyReport), and the 2.x charging-profile, reservation, certificate and firmware messages.
- **Signing meter:** each virtual charger has one. Its key is derived from the installation secret and the charger's identity, and it is registered automatically with meter serial `SBX-MTR-<identity>`. Sessions in a sandbox are therefore `verified`, and `SignReadings=false` switches signing off.
- **On 2.1, the virtual car is bidirectional:**
  - it offers DC_BPT on a DC charger and AC_BPT on an AC one (NotifyEVChargingNeeds, 11 kW back);
  - it discharges on a negative setpoint;
  - its SoC falls and the station's export register rises.
- **Simulate:** `tap-card` accepts `soc` and `bidirectional`.
- **Protocol change:** changing a virtual charger's protocol restarts it speaking the new one, once any session has ended.

**Bug fixed (bidirectional charging).** An AC car sends no battery level with its charging needs, so its first SoC arrives in a meter value. Until the next periodic load-management pass, a consenting car stayed "battery level unknown" and was not asked to discharge. The first SoC for a consenting session now triggers an immediate re-plan.

**Upgrade and tests**
- Needs migration **039**. It is additive:
  - `signed_meter_value`, with row-level security;
  - `connector.meter_public_key`;
  - `site.signed_meter_policy`, default `record`;
  - three session columns.
  Nothing changes for chargers that do not sign.
- Tests:
  - `npm run e2e:ocmf`: 20 checks with raw 1.6 and 2.0.1 chargers and a test meter key;
  - `npm run e2e:sandbox-2x`: 17 checks with virtual 2.0.1 and 2.1 (DC and AC) chargers;
  - 6 unit tests: parsing, key forms, verification, the 1.6 `NaN` fix and the 2.x translation.

**Not included, and why**
- **Other signed formats** (EDL, the German "Alfen" format, DLMS-signed): these are stored and shown as `unsupported`. Add them only when a market needs them.
- **Grid-code functions** (frequency and voltage support, DER control) and **price schedules sent to the car**:
  - These are OCPP 2.1 DER control and ISO 15118-20 dynamic mode. Their parameters come from a grid code: Indonesia has no published DER grid code for EV chargers yet, and PLN's interconnection rules do not cover EV discharge.
  - They cannot be tested without a certified inverter-grade 2.1 charger.
  - Build them when a PLN or DSO programme defines the parameters.
- **Energy-market settlement of exported energy:**
  - Indonesia has no retail or wholesale market a CPO can sell into. PLN is the single buyer.
  - PLN's rooftop-PV net metering (Permen ESDM 2/2024) does not cover EV discharge, and exports are not credited.
  - The credit therefore stays the operator's own, and export is off by default.
- **Bidirectional AC on hardware:**
  - The code path is the same as DC. It is now exercised end to end in the sandbox (AC_BPT, discharge, credit, signed readings).
  - Hardware testing needs AC-bidirectional cars and 2.1 wallboxes, which are rare. It stays a bench item in docs/ACCEPTANCE-v1.3.md.

## White-label driver apps (Commercial → Driver app)

An operator can now give its drivers its own app: PlugSure's driver app under the operator's name, colours and icon, on the operator's web address, showing only its stations. It is the same code as PlugSure's app, rendered per request, so it gets every fix and feature at once. There is no fork to maintain.

**What changes in the app**
- **The name** replaces "PlugSure" everywhere drivers see it:
  - the app itself, the page title and the manifest;
  - receipts and the payment description on the acquirer's page and statements;
  - the SMS text of the sign-in code (WhatsApp uses its approved template).
- **Tagline:** the operator's own, with its English.
- **Colours:** one accent colour is used in both themes. PlugSure nudges it lighter in the dark theme and darker in the light theme until text in it reads at 4.5:1 or more (WCAG AA) on every surface. Text on the accent is black or white, whichever reads better. The console shows the colours as used, with their contrast ratios.
- **Icon:** one square PNG (512–2048 px, 1024 best). Every size is made from it without an image library:
  - launcher sizes;
  - a maskable icon on the icon background inside the 80 % safe zone;
  - iPhone sizes;
  - an opaque 1024 px App Store icon.
- **Support and legal:** the operator's support WhatsApp/phone, e-mail, privacy policy and terms appear under Account → Bantuan.
- **Push notifications** carry the brand's name and icon on its own web address.

**Only the operator's stations**
- The station list, the map and scanned or typed charger codes are scoped to the operator.
- A charger of another operator is named as such ("Charger ini dikelola operator lain, bukan <app>"), not "unknown code". The same applies to its connector page, and to paying, reserving or queueing there. The check runs before anything is charged.
- History shows charges at the operator's sites.
- Payments already go to the operator's own acquirer account.

**Where it is served**
- **Draft:** a preview at `/app/?brand=<name>`, shown live in the console in a phone frame. The driver app may be framed by its own origin for this; everything else keeps `frame-ancestors 'none'`.
- **Live:** on the operator's web address. The operator points it at PlugSure with a DNS CNAME, and Caddy issues the certificate on first use. Caddy first asks the API (`/d/tls-ask`) whether the name belongs to a driver app, so nobody else can make it request certificates. After a card or e-wallet payment, drivers return to the app's own address.
- The web address also serves `/.well-known/assetlinks.json` (Android) and `/.well-known/apple-app-site-association` (iOS). These prove the store apps belong to it.

**Store builds (the build kit)**
- The console's **Build kit** is a zip with everything needed to build and list the app:
  - **Android:** a Trusted Web Activity project for Bubblewrap (`twa-manifest.json`) with the brand's address, package name, version and icons; launcher icons per density; the Digital Asset Links file; and a GitHub Actions workflow that builds the signed App Bundle.
  - **iOS:** a Capacitor shell (config, `package.json`, an offline page), the App Store icon, and Info.plist and entitlement additions (camera for QR, location for "near me", associated domains).
  - **Store texts:** listings in Indonesian and English, and data-safety / App Privacy answers.
  - **README:** the steps, with what is still missing.
- The console tracks what each store needs:
  - package name and signing-certificate fingerprints (the upload key and Play's app-signing key);
  - bundle identifier and Apple Team ID;
  - privacy policy;
  - version name and code. The code can only go up.

**API** (tag "Driver app"; `org:read` / `org:write`)
- `GET /v1/driver-app`: the brand, the palette as used, readiness per store, and the preview and live addresses.
- `PUT /v1/driver-app`: save it, or set it live. Live needs an icon and a web address.
- `PUT /v1/driver-app/icon`: base64 PNG.
- `GET /v1/driver-app/kit`: the zip.
- `DELETE /v1/driver-app`: a live app needs `?confirm=<name>`.
- Changes are audited: created, updated, icon changed, published, kit downloaded, deleted.

**Upgrade and tests**
- Needs migration **040** (`driver_app_brand`, with row-level security), which is additive. Operators without a brand keep the PlugSure app, unchanged.
- Caddy:
  - add the `on_demand_tls { ask … }` global option and the catch-all `https://` block at the end of `deploy/Caddyfile`;
  - the console host's `X-Frame-Options` becomes `?X-Frame-Options`, so the API's same-origin value for `/app/` survives.
  These changes were not run through `caddy validate` here (no Caddy on the test machine). Validate them on the server.
- Verified by `npm run e2e:brand` (28 checks) and 8 unit tests:
  - PNG decoding, resizing and the opaque icon;
  - the zip writer;
  - validation;
  - contrast for eight accents including white, black, yellow and navy;
  - the rendered page still parsing, with no "PlugSure" left;
  - the manifest, push worker and association files;
  - the kit.

**Not included**
- **Building and uploading the store apps themselves.** That needs the operator's Google Play and Apple developer accounts, signing keys, a JDK / Android SDK (Android) and a Mac with Xcode (iOS). The kit is ready for that, but no store build was made or tested here.
- ~~**Native push in the iOS app.**~~ Added: see the next section.
- **Other:**
  - custom fonts;
  - per-brand translations beyond the tagline;
  - a brand for sandboxes (refused);
  - several brands per operator.
- **Membership plans and roaming partners** in a branded app are the operator's own already, so nothing changes there.
- **Apple review:** Apple reviews apps that mainly show a website strictly (guideline 4.2). The README says how to present the app.
## Native iOS notifications (APNs) for white-label apps

The iOS app of a white-label brand now gets native notifications through the Apple Push Notification service. Web Push is not available inside its Capacitor shell. Drivers get the same notifications as before, in their language:

- charging started and finished;
- receipts and refunds;
- reservation reminders;
- their turn in the queue;
- unpaid sessions.

**How it works**
- **The operator's key:** the operator uploads its APNs authentication key (Commercial → Driver app → iOS notifications): the `.p8` file and its Key ID.
  - It is stored encrypted with `SECRETS_KEY` and never returned.
  - It is checked with Apple at once, against the brand's Team ID and bundle identifier.
  - The check asks APNs about a device token that cannot exist. Apple checks the key first, so nobody is notified.
- **The iPhone registers:** the app page runs inside the shell and detects it. It asks iOS for permission, takes the device token from Capacitor's PushNotifications plugin, and registers it with the brand (`POST /d/v1/push/apns`). It registers again on each start, because tokens can change. Tapping a notification opens its screen.
- **Delivery:** the gateway's push worker sends to APNs over HTTP/2.
  - It uses an ES256 provider token signed with the key, reused for 50 minutes as Apple asks. There is no library: Node's own `http2` and `crypto`.
  - Headers: the brand's bundle id as topic, push type `alert`, and priority 10 for time-critical messages (reservations, the queue), 5 for the rest.
  - A collapse id per session.
  - An expiry of 10 minutes or a day, as for Web Push.
- **Apple's answers:**
  - A token of a build run from Xcode, which production does not know, is found on the development server, and the environment is remembered.
  - `Unregistered` / `BadDeviceToken` / `DeviceTokenNotForTopic`: the app was deleted or the token is wrong, and the subscription is removed.
  - A refused key (`InvalidProviderToken`…): the console shows "Apple refused the key while sending". Messages are retried and the iPhones are not blamed.
  - `429` / `5xx`: retried with the usual back-off.
- **Removing a key or an app:** removing only the key keeps the iPhones, because device tokens belong to the app and a new key for the same app reaches them. Deleting the white-label app drops its iPhones.
- **Build kit:** it now adds:
  - `@capacitor/push-notifications`, with notifications shown in the foreground too;
  - the Push Notifications capability (`aps-environment`);
  - the two `AppDelegate.swift` methods that hand the token to Capacitor;
  - step-by-step instructions for creating the key.
  The console's App Store checklist includes the key, and the kit warns when it is missing.

**API**
- `PUT /v1/driver-app/apns` (`keyId`, `p8`).
- `POST /v1/driver-app/apns/check`.
- `DELETE /v1/driver-app/apns`.
- `GET /v1/driver-app` gains `apnsKeyId`, `apnsConfigured`, `apnsCheckOk`, `apnsCheckDetail`, `apnsCheckedAt` and `iosPushDevices`.
- Driver API: `POST /d/v1/push/apns` and `POST /d/v1/push/apns/remove`.

**Upgrade and tests**
- Needs migration **041**, which is additive:
  - `push_subscription` gains `kind` (`webpush` | `apns`), `brand_org_id` and `apns_env`;
  - `driver_app_brand` gains the sealed key and the last check.
- The gateway needs outbound HTTPS (HTTP/2, port 443) to `api.push.apple.com` and `api.sandbox.push.apple.com`.
- Tests:
  - `npm run e2e:apns`: 15 checks (20 with the next section) against a stand-in APNs server that checks every provider token with the operator's public key, as Apple does;
  - 4 unit tests: the provider token and its reuse, key validation, Apple's answers, and sending with the development fallback against a local HTTP/2 server.

**Not included**
- **A real iPhone and Apple's servers:** the Capacitor plugin wiring and delivery to Apple were not run here. That needs a Mac with Xcode, the operator's Apple account and a device. Check them with a TestFlight build before release.
- ~~**Badges, images and actions.**~~ Added: see the next section. Silent / background pushes are not used.
- **Android push:** the Android app is a Trusted Web Activity, which uses Web Push with Chrome's notification delegation, so it needs no FCM.

## Badges and rich iOS notifications

The white-label iOS app's notifications now use what iOS offers beyond a title and a line of text.

**The badge**
- The app icon shows how many charging sessions are waiting to be paid in that operator's app: an expired card hold, or a post-pay charge the e-wallet refused. Every notification to the iPhone carries the count, worked out when it is sent.
- When one is paid (by the driver in the app, or by the e-wallet on a retry), the iPhone gets a badge-only update. It shows nothing and does not replace an unread notification.
- Events: a new `payment.unpaid_settled` event is raised when a driver pays in the app; `payment.hold_captured` already covered the retry.

**Richer notifications**
- **Subtitle:** the site, with the detail below it, so the site is not repeated in the text.
- **Buttons**, each opening the app to carry it out:

  | Notification | Button |
  |---|---|
  | Charging started | Stop charging (asks first, as the app's own button does) |
  | Charging finished, receipt, refund, partner charge record | View receipt |
  | Unpaid session | Pay now |
  | Your turn in the queue | Give up my turn (frees the connector for the next driver) |
  | Reservation ending | Cancel reservation |

  "Stop charging" and "Pay now" need the phone unlocked. The titles follow the phone's language (Indonesian or English).
- **Time-sensitive:** "your turn" and reservation reminders come through Focus and lead their group. A receipt that follows "charging finished" arrives quietly (passive).
- **A picture of the charge:** "Charging finished" carries a 720 × 360 card with the energy in large figures, the time, the peak power and the power curve, in the operator's accent colour.
  - It is drawn from the session's meter readings with no image or font library.
  - It is served from a signed address that expires after 7 days, because the iPhone's Notification Service Extension downloads it without the driver's credentials.
  - Chrome on Android and desktop shows the same picture in Web Push notifications.

**Build kit**
- `PlugSureNotifications.swift` registers the button categories. Call it from `AppDelegate`.
- `NotificationService/NotificationService.swift` is the Notification Service Extension that attaches the picture. Add it as a new target in Xcode.
- The Time Sensitive Notifications entitlement.
- README steps for all three.

**Upgrade and tests**
- No migration: the new fields travel in the existing message payload. Browsers show title and text as before.
- `npm run e2e:apns` now has 20 checks. The new ones cover:
  - the subtitle, category, button target and picture on "charging finished";
  - the badge (1) with an unpaid session;
  - the signed picture, with forged or other-session addresses refused;
  - the badge-only update (0) once paid;
  - "your turn" as time-sensitive, with its button.
- 4 more unit tests: the rich payload and badge-only update; the card (size, opaque, accent and figures); power from the energy register; signed addresses (session, language, expiry).

**Not included**
- **A real iPhone:** the Swift files (categories, service extension) were written for Xcode but not compiled or run here, which needs a Mac.
- **Web Push buttons:** browsers show the picture, but not the buttons.
- **Silent / background pushes.** (~~Live Activities~~: added, see the next section.)

## Live Activities: a charge under way on the lock screen

In a white-label iOS app (iOS 16.2+), a charge under way now shows on the lock screen and in the Dynamic Island.

**What is shown**
- The energy in large figures, the power, and the time since the start. The phone counts the time itself between pushes.
- The battery level, or how much of a prepaid allowance is used, as a bar.
- The app's name and the site, in the operator's accent colour.
- In the Dynamic Island: a bolt and the kWh (compact); energy, power, site and time (expanded).
- When the charge finishes it says so at once. When the charge is rated, it shows the final cost and stays on the lock screen for 30 minutes.
- If updates stop coming (the charger offline), the lock screen shows "Menunggu data charger…".

**How it works**
- **The app starts it** when a charge starts in the app. The app's LiveActivity plugin gives PlugSure the activity's APNs update token (`POST /d/v1/live-activities`), and the page reports when the driver dismisses it.
- **Push-to-start** (iOS 17.2+): the app also gives PlugSure a push-to-start token. A charge started without the app — a fleet card at the charger, a remote start — then gets its activity started by PlugSure:
  - after 20 s, so an open app starts its own first;
  - once only per phone and session;
  - with the attributes and an alert, as Apple requires.
- **Updates:** a pass in the gateway, every 5 s, sends Live Activity pushes (push type `liveactivity`, topic `<bundle>.push-type.liveactivity`) with the operator's APNs key.
  - The first update goes at once, at priority 10.
  - After that, only a real change (50 Wh, 1 kW, the battery or progress) is sent, at most every 30 s and at priority 5, within Apple's budget. A heartbeat every 150 s moves the stale date on.
  - "Finished" and the end are sent at priority 10.
- **Apple's answers:** a dismissed activity (410) is dropped, a refused key is flagged in the console as for notifications, and an Xcode build's token is found on the development server.

**Build kit**
- `LiveActivity/ChargingAttributes.swift`: the activity's data, shared by the app and the widget.
- `LiveActivity/ChargingLiveActivity.swift`: the widget extension, drawing the lock screen and Dynamic Island.
- `LiveActivity/LiveActivityPlugin.swift`: the Capacitor plugin that starts activities and reports tokens.
- `LiveActivity/MyViewController.swift`: registers the plugin.
- `NSSupportsLiveActivities` in the Info.plist additions.
- README steps: a Widget Extension target, target membership, and the storyboard class.

**Console and API**
- `GET /v1/driver-app` gains `liveActivities` (`active`, `pushToStart`).
- Driver API:
  - `POST /d/v1/live-activities` (`ref`, `token`);
  - `POST /d/v1/live-activities/start-token` (`token`);
  - `POST /d/v1/live-activities/ended` (`ref`).
- `window.BRAND` gains the accent colour.

**Upgrade and tests**
- Needs migration **042**, which is additive: `live_activity`, `live_activity_start_token` and `live_activity_push_start`.
- `LIVE_ACTIVITY_MIN_INTERVAL_S` (default 30) sets the shortest gap between routine updates.
- Tests:
  - `npm run e2e:live-activity`: 14 checks, through the gateway's real pass and a stand-in APNs;
  - 3 unit tests: payloads, the update plan and throttle, and ending;
  - the kit test checks that Swift string interpolation survives in the generated files.

**Not included**
- **A real iPhone:** the Swift files (widget, plugin) were written for Xcode and ActivityKit but not compiled or run here, which needs a Mac.
- **Cost during the charge:** added later in this release; see **Cost during the charge**.
- **Frequent updates** (`NSSupportsLiveActivitiesFrequentUpdates`): not needed at one update per 30 s.
- **Credential changes** reach the gateway within 30 s: it keeps each brand's APNs credentials cached for that long.

## ISO 15118 Plug & Charge (Operate → Plug & Charge)

With Plug & Charge, a car that has a charging contract identifies itself with
its contract certificate: the driver plugs in and charging starts, with no card
or app (gap analysis P3). This release is the **CSMS side**. Real use needs:
- a V2G PKI (Hubject or similar) with a CPO agreement;
- 15118-capable chargers with Plug & Charge firmware;
- cars with contract certificates.

**From the charger, over OCPP 2.0.1 and over OCPP 1.6**
- On OCPP 1.6 the messages travel inside DataTransfer, per the OCA application
  note (vendorId `org.openchargealliance.iso15118pnc`).
- **Authorize with a contract** works in two steps:
  1. **The certificate.** The charger sends either:
     - the hash data of a contract chain it has already checked; or
     - the chain itself, which the CSMS then checks up to one of the operator's
       mobility-operator (MO) roots, with expiry and signatures.

     Each certificate is then checked by **OCSP** with the responder named in
     it.
  2. **The contract.** It must be registered, and is treated like a card:
     status, expiry, energy and spend limits, fleet account, membership.

  The answer carries both results, `idTokenInfo` and `certificateStatus`:
  | Case | idTokenInfo | certificateStatus |
  |---|---|---|
  | Revoked certificate | Invalid | CertificateRevoked |
  | Someone else's certificate for this eMAID | Invalid | CertChainError |
  | Cancelled contract | Blocked | ContractCancelled |
  | Contract not registered | Invalid | ContractCancelled |

  When the OCSP responder cannot be reached, a setting decides: accept (the
  default, since the charger checked the chain) or refuse.
- **GetCertificateStatus:** the OCSP answer the charger hands to the car.
- **Get15118EVCertificate:** installs or updates the car's contract
  certificate. The request is passed to the PKI and its EXI answer returned.
- **SignCertificate (V2G):** the PKI signs the charger's own V2G certificate,
  and CertificateSigned is sent back. Alternatively, the operator's own CPO
  sub-CA in Vault can sign it. Station certificates stay with Security
  Profile 3.
- Sessions started with an eMAID, with or without separators, are billed to
  the contract. A fleet contract appears on its fleet invoice.
- Partners' contracts are matched through their roaming tokens (OCPI
  `contract_id`).

**Operator side**
- **Overview:** the PKI in use, a set-up checklist and the settings.
- **Contracts:** register eMAIDs (retail or fleet), cancel, reactivate.
- **Trust anchors:** the V2G and MO roots, fetched from the PKI or uploaded.
- **Chargers:** per charger you can:
  - switch Plug & Charge on (`ISO15118PnCEnabled` / `ISO15118Ctrlr.PnCEnabled`);
  - install the trust anchors;
  - request its V2G certificate;
  - read what it has installed, and delete a certificate.

  Each charger's certificate state and expiry are shown.
- **Renewal:** chargers with Plug & Charge on are asked for a new certificate
  30 days before theirs expires, and an alert is raised a week before.
- **Log:** every exchange with a charger or the PKI, with its outcome.

**Developers**
- The built-in **test PKI** (`PNC_PKI=mock`, refused in production) issues
  charger certificates and test contract certificates, and answers OCSP.
- In a sandbox, the virtual chargers speak Plug & Charge (1.6 with
  DataTransfer). The simulate event `plug-and-charge` brings a car with a
  contract.
- **API:** 19 operations under `/v1/pnc`, documented in `/openapi.json`
  (211 operations in total).

**Also in this release**
- DER, X.509, CSR and OCSP (RFC 6960) handling is written on Node's own
  crypto, with no new dependency. OpenSSL accepts the certificates it builds;
  this is tested.
- OCSP responder URLs come from certificates, so requests to them go through
  the SSRF guard: http or https only, no private addresses in production, no
  redirects, a size limit and a 5-second timeout.

**Found while building:** a command to a 2.0.1 station that the API process had
not yet seen through the bridge went out in 1.6 form. For example,
ChangeConfiguration went out instead of SetVariables, and the answer looked
like success. The command path now uses the charger's registered version until
the bridge reports the connection.

Needs migration **022** (additive):
- the organisation's Plug & Charge settings (off by default);
- the per-charger switch;
- trust anchors, chargers' certificates and the exchange log, all with RLS;
- the test PKI's tables.

New optional environment variables: `PNC_PKI`, `PNC_PKI_URL`, `PNC_PKI_TOKEN`,
`PNC_V2G_SIGNER`, `PNC_VAULT_MOUNT`, `PNC_VAULT_ROLE`, `PNC_RENEW_DAYS` and
`PNC_OCSP_TIMEOUT_MS` (deploy/README.md, "Plug & Charge").

**Not included:**
- **the PKI itself.** Integrating a provider is done through the PKI gateway
  contract in deploy/README.md, and must be verified against that provider's
  API during onboarding;
- the test PKI does not decode EXI (Get15118EVCertificate returns a marker);
- contract certificate provisioning for cars (the MO / OEM side);
- ISO 15118-20 and bidirectional charging;
- OCPP 2.0.1 device-model management of the 15118 controller beyond the
  switch-on variable;
- certificate revocation lists (OCSP only).

## Onboarding with automatic charger certificates (Operate → Onboarding)

Connecting a new charger to PlugSure now has its own page. Security Profile 3
(mutual TLS) certificates are issued by PlugSure itself, instead of needing an
external Vault or a certificate made elsewhere.

**Onboarding page**
- **In progress:** chargers registered in the last 90 days, with their
  hardware and where each one is:
  - waiting for its first connection;
  - refused at the handshake, with the reason;
  - connected but not activated;
  - getting its certificate;
  - connected.
- **Certificates:** every charger's client certificate: where it came from,
  its serial and expiry, the latest request, and **Renew over OCPP**.
- **Certificate authority:** the CA to give the TLS terminator, as a download
  and with the Caddy settings.
- **Add charge point** opens the wizard. It takes the hardware details
  (manufacturer, model, serial by camera scan, firmware, OCPP version), the
  site, the security settings and the connectors, then watches the charger
  connect.

**Certificates, three ways** (wizard step 3)
- **Issue automatically:** PlugSure's charging-station CA makes an ECDSA P-256
  or RSA 2048 key and a certificate (CN = the OCPP identity, O = the operator,
  TLS client use), valid 1–5 years.
  - The bundle is `client.key`, `client.crt`, `ca.pem` and `chain.pem` (plus
    `csms-root.pem` when configured), downloaded once.
  - The key is not stored.
- **Sign the charger's request (CSR):** the key never leaves the charger. A
  request for another identity, a broken one, or a weak key is refused.
- **Zero-touch over OCPP:** the charger is commissioned on Profile 2 with
  "move it to Profile 3 automatically". After its first boot PlugSure:
  1. asks it for a CSR (ExtendedTriggerMessage on 1.6, TriggerMessage on
     2.0.1);
  2. signs it and installs it with CertificateSigned;
  3. sets `SecurityProfile` 3 on the charger;
  4. enforces Profile 3.

  The wizard shows the progress.

Either way the certificate's fingerprint is bound to that one charger, and
Profile 3 is enforced in the safe order (credential first).

**Renewal:** certificates from PlugSure's CA are renewed over OCPP 30 days
before they expire (at most once a day), and an alert is raised two weeks
before. A new certificate does not lock a charger out: the previous one is
accepted until the charger connects with the new one, and is refused from then
on.

**The CA** is created on first use: ECDSA P-256, 20 years, its key sealed
with `SECRETS_KEY`. You can use your own instead with `CHARGER_CA_CERT_FILE` +
`CHARGER_CA_KEY_FILE`.

**Found and fixed while building**
- **Security: the shipped Caddyfile did not overwrite `X-Client-Cert-Fingerprint`.**
  With `OCPP_TRUST_PROXY_PROTO=true` (the recommended production value), a
  charger could send that header naming another charger's certificate and pass
  Profile 3 without holding it. The Caddyfile now assigns the header from the
  certificate Caddy verified, and includes the client-certificate block to
  enable.
- **When the gateway terminates TLS itself it never asked for a client
  certificate**, so Profile 3 could not work in that deployment. It now does,
  and trusts the charging-station CA.

**OCPP**
- SignCertificate for the charge point's own certificate is now accepted on
  1.6 (Security Whitepaper) and on 2.0.1 (`ChargingStationCertificate`). It was
  refused before.
- CertificateSigned, ExtendedTriggerMessage and the `SecurityProfile` change
  are sent to the charger.

**API:**
- `POST /v1/charge-points/:identity/keys` accepts `method: "auto" | "csr"`
  (with `keyType`, `csr`, `days`) for Profile 3, and `autoCertificate` for
  Profile 2.
- New:
  - `GET /v1/onboarding`
  - `GET /v1/charger-ca` and `GET /v1/charger-ca/ca.pem`
  - `GET /v1/station-certificates`
  - `POST /v1/charge-points/:identity/certificate/request`
- 216 operations in total.
- The commissioning status gains `security` (profile, certificate, zero-touch
  progress).

Needs migration **023** (additive): the platform CA table, and certificate
columns on the charge point (the previous fingerprint during a change, serial,
expiry, source, the zero-touch flag).

New optional environment variables: `CHARGER_CA_CERT_FILE`,
`CHARGER_CA_KEY_FILE`, `CHARGER_CERT_DAYS` (730), `CHARGER_CERT_RENEW_DAYS`
(30) and `CSMS_ROOT_CA_FILE`. See deploy/README.md, "Charger certificates".

**Not included:**
- PKCS#12 (.p12/.pfx) bundles; PEM files are provided;
- raising a 2.0.1 station's security profile automatically, which needs
  SetNetworkProfile and a reset;
- certificate revocation lists or OCSP for charger certificates;
- revoking a charger means unbinding or replacing its certificate, or
  decommissioning it.

## Integrations: QRIS acquirer, sign-in codes, Plug & Charge PKI, map tiles (Govern → Integrations)

The services PlugSure depends on are now connected from the console instead
of only through environment variables. Settings made here override the
environment.

**How it works**
- **Secrets** (server keys, tokens, private keys) are sealed with `SECRETS_KEY`
  and are write-only. The page shows only that a secret is set, with its last
  four characters, and a secret is entered again only to change it.
- **Connection tests** are provided for every provider, plus an activity log
  (payments created and notified, codes sent). Numbers are masked in the log
  and codes are never logged.
- **Audit:** every change is audited with the names of the secrets that
  changed, never their values.
- **Who configures what:** QRIS accounts are per operator (its own merchant
  account), with a platform default as fallback. Sign-in codes, the PKI and
  map tiles are platform-wide.

**QRIS payments.** The payment path was the built-in sandbox everywhere; it
now runs through a real acquirer.
- **Midtrans** (Core API, `qris`): notifications verified by SHA-512
  signature, refunds by API.
- **Xendit** (QR Codes API, dynamic): callbacks verified with the verification
  token. Refunds are by bank transfer on the Refunds page.
- **Bank direct over BI-SNAP**: access token signed with your RSA key, QR
  signed by HMAC, notifications verified with the bank's public key over the
  SNAP string-to-sign. Paths are configurable per bank.
- **Sandbox**, in development only.

Console checkout, the driver app's prepaid checkout and app passes all create
the charge at the operator's acquirer.
- Each acquirer account gets its own notification URL, `/pay/notify/<key>`,
  to paste into the provider's dashboard.
- A notification is accepted only with the account's signature or token. It
  captures a payment once, and only for its full amount.
- A notification for an app pass activates the pass.
- Each payment remembers the account that took it. After switching acquirer,
  the old account is archived, not overwritten: its URL still settles its
  payments and its refunds still go to it.
- The driver app shows the "simulate payment" button only with the sandbox.

**Sign-in codes.**
- Providers:
  - **WhatsApp** (Meta Cloud API, an authentication template with the
    copy-code button);
  - **SMS** via Twilio or Zenziva;
  - **your own HTTP gateway**.
- A **fallback** channel is used when the main one fails, for example a number
  without WhatsApp.
- Codes are no longer shown on screen, except with the development provider.

**Plug & Charge PKI.** The PKI gateway URL and token, and the V2G signer (PKI
or your Vault sub-CA), are now console settings. `PNC_*` still works as the
fallback.

**Map tiles.** The driver app's tile service (https only). The page's security
policy follows it.

**Managed on their own pages** (the Integrations page links them): e-mail
(SMTP) and WhatsApp alerts, outbound webhooks, roaming, the developer API,
charger certificates and Plug & Charge contracts.

**Found and fixed while building**
- The first design overwrote an acquirer account when the operator switched
  provider. Payments already taken would have lost their notifications and
  their refunds. Old accounts are now archived.
- A flaky check in the API sandbox suite read a fragment of the API key that
  could be one character long.

**API:** five operations under `/v1/integrations` (221 in total at that point). The public
`POST /pay/notify/:key` is not under `/v1`.

Needs migration **024** (additive): integrations, their activity, and the
account on each payment. **Expose `/pay/*` publicly** (`deploy/Caddyfile` does,
on the OCPP host). There are no new environment variables.

**Not included:**
- e-wallet tokenisation and virtual accounts (e-wallet and card *payments* are
  covered in the next section);
- automatic settlement reports;
- signing up for any provider account, which you do with each provider. Every
  adapter follows the provider's published API, and must be tested in that
  provider's sandbox before live traffic.

## E-wallet and card payments beside QRIS

Drivers can now pay for a charge or a 30-day pass with **GoPay, ShopeePay,
OVO, DANA, LinkAja or a credit/debit card** as well as QRIS, wherever the
operator's acquirer offers them.

**Same model as QRIS.**
- The driver pays a fixed amount up front.
- The acquirer's signed notification confirms it: captured once, only for the
  full amount.
- The charger delivers that much energy.
- Unused balance goes to the refund queue, as with QRIS.
- PlugSure never sees card numbers. Cards are paid on the acquirer's own hosted
  page with 3-D Secure, so the platform stays outside PCI DSS card-data scope.

**Operators** choose the methods in Govern → Integrations → Payments, with a
checkbox per method their acquirer offers. The choice defaults to QRIS only, so
nothing changes until an operator enables more. Enable only methods that are
activated on the acquirer account.

| Acquirer | QRIS | E-wallets | Cards | Refund by API |
|---|---|---|---|---|
| **Midtrans** | Core API | GoPay and ShopeePay (Core API; the driver is sent to the app by deeplink) | Snap, `credit_card` only, 3-D Secure | all methods |
| **Xendit** | QR Codes | OVO (a push to the driver's OVO app), DANA, ShopeePay, LinkAja (e-wallet charges, redirect) | Invoices limited to `CREDIT_CARD` | e-wallets (with the charge id); QRIS and cards by bank transfer |
| **Bank direct (SNAP)** | yes | — | — | bank transfer |
| **Sandbox** (development) | yes | all, on a test checkout page | yes, on the test page | yes |

**Drivers**
- After choosing the amount, the app shows **"Bayar dengan"**: only the methods
  the operator has enabled. The last choice is remembered.
- **QRIS** shows the QR as before.
- **An e-wallet or a card:**
  - a "Lanjutkan ke GoPay / Kartu" button opens the e-wallet app or the card
    page;
  - the acquirer sends the driver back to `/app/paid.html`, which reopens the
    payment screen;
  - the screen waits for the acquirer's confirmation;
  - once confirmed, charging starts.
- **OVO** asks for the OVO phone number (the signed-in account's by default)
  and the driver approves the push in the OVO app.
- 30-day passes get the same method choice.
- A cancelled or failed payment on the acquirer's page returns the driver to
  the app to try another method; nothing is charged.

**Notifications and refunds**
- New callbacks handled:
  - Midtrans card notifications: `capture` + fraud `accept` is paid; a fraud
    `challenge` is not.
  - Xendit's `ewallet.capture` callback.
  - Xendit's invoice callbacks: `PAID` / `SETTLED` are paid; `EXPIRED` expires
    the payment.
- The acquirer's own payment id is stored for refund APIs that need it.
- Where an acquirer cannot refund a method by API (Xendit QRIS and cards, bank
  direct), the refund fails over to bank transfer on the Refunds page with a
  clear message.
- Each checkout is logged in the Integrations activity with its channel.

**Development:** with the sandbox acquirer, e-wallet and card payments open a
test checkout page (`/pay/sandbox/<ref>`, Bayar / Batal). The payment is
settled exactly as a real notification would settle it. The page is refused in
production, and its return address can only point back into the app.

**Found and fixed while building:** an OVO number typed as `0812…` was
rejected, because it was checked before being normalised to `+62`.

**API:**
- The payments `methods` setting (`PUT /v1/integrations/payments`,
  `settings.methods`); still 221 operations.
- The driver API's quote returns `paymentMethods`.
- Prepaid checkout and pass purchase accept `method` (and `phone` for OVO), and
  return `payment { method, channel, label, action, checkoutUrl }`, with `qr`
  only for QRIS.

Needs migration **025** (additive): the channel, checkout URL and acquirer
payment id on each payment, and `ewallet` / `card` as pass payment types. No
new environment variables. Optionally set `DRIVER_PUBLIC_URL` if the driver
app is served on another host than `CONSOLE_PUBLIC_URL`: the acquirer returns
the driver there.

**Not included:**
- virtual accounts;
- instalments;
- e-wallet and card payments in the console's own QRIS checkout (the QR at the
  charger).

Card pre-authorisation, saved cards and linked e-wallets are covered in the next sections.

## Card pre-authorisation (holds) and saved cards

**Card holds.** With holds on, a card payment for charging becomes a
pre-authorisation:
- The driver's card is **held** for the amount they choose (the ceiling), and
  the charger delivers up to that, as before.
- When the session is rated, PlugSure **captures the actual total**; the
  acquirer releases the rest at once.
- A session that delivers nothing, or a hold that never starts a session
  (after 35 minutes), is **released entirely** and its claim token stops working.
- Nothing goes through the refund queue, because nothing extra was taken.

A 30-day pass is always a sale, never a hold.

**How captures are handled**
- The capture runs in the background after the session is rated, so the
  charger is never kept waiting on the acquirer.
- Captures and releases the acquirer refuses are **retried automatically**
  with back-off (2 minutes, then up to 12 hours between tries, six attempts).
- **Refunds → Card holds** in the console lists holds, failures first with
  the acquirer's error, next try and a **Retry now** button (audited).
- After the last automatic try a critical alert is raised, because an
  authorisation lapses at the acquirer (Midtrans: 7 days by default).
- A session parked for review is settled when an operator clears it, so clear
  it within that time.

**Saved cards.** Signed-in drivers can tick "Simpan kartu ini" when paying by
card.
- The acquirer keeps the card and returns a token. PlugSure stores only that
  token (sealed with `SECRETS_KEY`), the brand, the last four digits and the
  expiry. **Card numbers never reach PlugSure.**
- Next time the saved card is offered first ("Visa ••1111") and pays in one
  tap, as a hold or, for a pass, a sale. With 3-D Secure on (the Midtrans
  default), the driver confirms at the bank page.
- A token only works at the acquirer account that issued it. So a saved card
  belongs to one driver **and** one operator's acquirer account, and is
  offered only there.
- Other drivers cannot use it; guests cannot save cards.
- Account → Kartu tersimpan lists the cards with where they can pay, and
  removes them.
- Operators never see drivers' cards.

**Per acquirer**
- **Midtrans:**
  - holds: Snap `credit_card.type: authorize`, then `POST /v2/capture` for
    the total and `POST /v2/{order_id}/cancel` to release;
  - saved cards: Snap `save_card` with `user_id`, and the notification's
    `saved_token_id`;
  - later payments: Core API `credit_card.token_id`, with 3-D Secure again
    by default. Without it, payments use Midtrans One Click, which Midtrans
    must enable on the account.
- **Xendit** (Payments API v3):
  - a hosted payment session with `capture_method: MANUAL`, and
    `allow_save_payment_method` to save the card;
  - `payment.authorization` callbacks with the `payment_token_id`;
  - captures and cancels on the payment request;
  - saved-card payments by `payment_token_id`, with 3-D Secure when Xendit
    asks.
  - Confirm the v3 field names in Xendit's sandbox before live traffic.
- **Sandbox:** holds and saved cards on the test checkout page; saved cards
  pay at once.

**Operators:** Integrations → Payments has two new switches, both **off by
default**:
- "Card payments: hold, then charge only what is used";
- "Let signed-in drivers save a card".

Midtrans also has "Saved cards: ask for 3-D Secure every time" (on). Card
pre-authorisation, and card saving or One Click where used, must be enabled
on the acquirer account.

**Found and fixed while building:** retrying a failed capture from the console
did nothing. The "try now" mark was written inside the request's transaction,
and the attempt ran on another connection that could not see it yet.

**API:** `GET /v1/card-holds` and `POST /v1/card-holds/:id/retry` (223
operations). The sessions payment status gains `held` and `released`. The
driver API adds:
- `GET /d/v1/cards` and `DELETE /d/v1/cards/:id`;
- `savedCardId` and `saveCard` on checkout and pass purchase;
- `cardHolds`, `canSaveCard` and `savedCards` in the quote.

Needs migration **026** (additive): the hold state on payments and the
`driver_card` table. No new environment variables.

**Not included:**
- raising a hold that runs short, or topping up;
- holds for fleet sessions;
- card data entry on PlugSure's own pages (always the acquirer's page);
- network tokens and card updater services.

Linked e-wallets are covered in the next section.

## Linked e-wallets: GoPay, OVO, DANA, ShopeePay and LinkAja in one tap

Signed-in drivers can **link** GoPay, OVO, DANA, ShopeePay or LinkAja once, approving in the
e-wallet's own app. After that, a charge or a 30-day pass is paid **in one
tap**, with no redirect.
- **Linking:** at the charger, choosing a linkable e-wallet shows "Hubungkan …
  untuk bayar satu ketuk" with the account's phone number (the signed-in
  number by default).
  - The acquirer sends the driver to the e-wallet app to approve, and
    `/app/paid.html?for=link` brings them back. The app confirms the link and
    offers it first from then on ("GoPay ••••7890 · Terhubung").
  - A refused link ends as failed and is not listed.
- **Paying:** the chosen amount is charged at once, as a pre-purchase.
  **Unused balance is refunded automatically** through the acquirer as soon
  as the session settles, with no operator action. A payment that never
  starts a charge is also refunded automatically after the claim window.
  - If the automatic refund fails, it stays in the refund queue as before.
  - Insufficient balance is refused with a clear message, and nothing is
    recorded as paid.
  - When the e-wallet asks for its PIN (for example, above its one-tap
    limit), the driver is sent to confirm it and the payment continues as a
    normal e-wallet payment.
- **Safety:**
  - A link belongs to one driver and one operator's acquirer account, and is
    never usable or visible to another driver.
  - Tokens are sealed with `SECRETS_KEY`; only the masked number is shown.
  - Guests cannot link.
  - Unlinking in Account → Kartu & e-wallet also unlinks at the acquirer.
  - Linking the same e-wallet again replaces the older link.

By default a linked e-wallet is charged at once and the unused balance is
refunded automatically. This way no energy is left unpaid when a balance runs
out, and the pre-purchase safeguards (allowance, claim window, refunds) apply.
Operators can turn on post-pay instead (next section).

**Per acquirer**
- **GoPay** through Midtrans GoPay Tokenization:
  - linking: `POST /v2/pay/account` with the driver's number and the return
    page, then the activation link;
  - the link's status: `GET /v2/pay/account/{id}` → `ENABLED`, with the
    `GOPAY_WALLET` token (or `GOPAY_SAVINGS`, GoPay Tabungan; never
    `PAY_LATER`);
  - charges: `POST /v2/charge` with `gopay.account_id` and the
    `payment_option_token` looked up again just before, settled at once or needing the PIN
    (verification link);
  - refunds by API;
  - unlinking: `/unbind`.
- **OVO, DANA, ShopeePay and LinkAja** through Xendit's reusable payment methods (GoPay through Xendit's v3 payment tokens; see the post-pay section):
  - linking: `POST /v2/payment_methods` (`EWALLET`, `MULTIPLE_USE`), with an
    AUTH link, until `ACTIVE`;
  - charges: `POST /payment_requests` on the payment method;
  - refunds: `POST /refunds` with the payment request;
  - unlinking: `/expire`.
  - Confirm the fields in Xendit's sandbox.
- **Sandbox:** all five, with a test approval page (Izinkan / Tolak); linked
  payments complete at once.

GoPay linking needs Midtrans, and OVO / DANA / ShopeePay / LinkAja linking needs Xendit (Midtrans tokenises GoPay only); each
acquirer links the e-wallets it supports. **Operators** turn on "Let signed-in
drivers link … for one-tap payments" in Integrations → Payments (off by
default) for e-wallets ticked as methods. E-wallet tokenisation must be enabled
on the acquirer account.

**Driver API:**
- `POST /d/v1/wallets` (`connectorId` or `planId`, `channel`, `phone`) and
  `GET /d/v1/wallets/:id`;
- `walletId` on checkout and pass purchase;
- `linkableWallets` and `linkedWallets` in the quote;
- linked e-wallets listed with saved cards in `GET /d/v1/cards` (`kind`).

The operator API is unchanged (223 operations).

Needs migration **027** (additive: e-wallet columns on `driver_card`). No new
environment variables.

**Not included:**
- linking from the Account page without a charger or pass;
- (Xendit's link callbacks were added on 28 Sep; see *Tax receipts for unpaid sessions, Xendit link callbacks* below.)

## Post-pay with linked e-wallets

Optionally, a linked e-wallet is charged **after** the session, for exactly what
it cost. Nothing is taken at the start.
- **Starting:** the amount the driver chooses is the session's **limit**. The
  charger delivers up to that allowance as usual, and the app's button reads
  "Mulai isi · bayar setelah selesai".
- **After rating:** the actual total is charged to the linked e-wallet, the
  same moment a card hold would be captured. Nothing needs refunding.
- **Nothing charged:** a session that never starts (after 35 minutes), or
  that delivers nothing, charges nothing.

**Guards**
- **The operator's limit** per session (default Rp 200,000). Above it, the
  e-wallet is charged up front as before.
- **The e-wallet balance** is checked before starting, where the acquirer
  reports it: GoPay (Midtrans, on the linked account), and OVO, DANA,
  ShopeePay and LinkAja (Xendit, `ewallet.account.balance` on the linked
  payment method, when Xendit fills it in). A limit above the balance is
  refused, the balance is named, and nothing is charged.
- **When the balance cannot be read**, post-pay starts without the check,
  unless the operator turns on *Post-pay only when the e-wallet balance can be
  checked* (Advanced, off by default). In that case the e-wallet is charged up
  front instead, and the quote marks each linked wallet (`linkedWallets[].postpay`)
  so the app says so before the driver taps. Which Xendit e-wallets report a
  balance must be confirmed in Xendit's sandbox.
- **Unpaid sessions:** a driver with an unpaid post-pay session is not offered
  post-pay again. Their next linked-e-wallet payment is charged up front, and
  the app explains why.

**GoPay through Xendit (28 Sep).** GoPay was previously available only through Midtrans. Xendit now offers it too, through its Payments API v3:
- a one-time GoPay payment (channel `GOPAY`, which opens GoPay);
- linking (a `GOPAY_RECURRING` payment token, approved in GoPay), with one-tap charges on the token, refunds through `/refunds`, and unlinking that cancels the token;
- the post-pay balance check reads `token_details.account_balance` on the token, which Xendit documents as the balance of the account bound to the token, returned when the provider makes it available.

Xendit must activate GoPay recurring on the account. Operators tick GoPay under Xendit's payment methods.

**Fixed:** Xendit v3 responses put the redirect in `actions[].value` (with `descriptor: WEB_URL`). The saved-card 3-D Secure path read `actions[].url`, so live it would have refused a saved-card payment that needed 3-D Secure. Both are now read.

**GoPay linked through Midtrans: the balance check for post-pay (28 Sep).** The check already read the balance Midtrans reports on the linked account (Get Pay Account, `GET /v2/pay/account/{id}`). Midtrans' documentation showed three gaps, now closed:
- **GoPay Tabungan.** A linked account can offer `GOPAY_WALLET`, `GOPAY_SAVINGS` (GoPay Tabungan) and `PAY_LATER`. Only the wallet was read, so a driver who uses Tabungan started post-pay unchecked. Now the option a session is charged from is the active wallet, else the active Tabungan, and its balance is checked. `PAY_LATER` is credit, not a balance: it is never counted and never charged. Before, if the wallet option was missing, the link could have stored the first option, which might be `PAY_LATER`.
- **A fresh token for every charge.** Midtrans asks merchants to call Get Pay Account before each payment, because the payment option token can change, for example when the driver upgrades to Tabungan. The post-pay charge (and every linked GoPay charge) now does this and uses the current token. If the lookup itself fails, the token stored at linking is used as before.
- **A link disabled or expired in GoPay** is never charged. (Messages: next paragraph.)

No new settings, migrations or API changes. Unit test 427; `e2e:postpay` check 10.

**A proper message for GoPay links ended in GoPay (28 Sep).** A driver can unlink PlugSure in the GoPay app, or the link can expire. Midtrans then reports the account `DISABLED` or `EXPIRED`; Xendit reports the payment token `EXPIRED` or `CANCELED`. Before, the driver saw "your GoPay balance (Rp 0) is less than the limit", which sent them to top up. Now:
- **Starting a session** with that link is refused with *"Tautan GoPay Anda sudah tidak aktif: diputus di aplikasi GoPay atau kedaluwarsa. Tidak ada yang ditagih. Hubungkan GoPay lagi, atau pilih metode lain."* The response carries `code: "wallet_link_ended"`, and the app rebuilds the payment choices without the link, with **Hubungkan GoPay** offered again. The same applies to 30-day passes and to charging up front, where the charge is refused.
- **The link is marked ended** (`driver_card.status = 'failed'`), so it is no longer offered. The quote drops it and lists GoPay under `linkableWallets` again. It is kept for the payments made with it.
- **After a post-pay session**, a charge to an ended link is not sent. The receipt shows *"Tautan GoPay Anda sudah tidak aktif, jadi belum ada yang ditagih. Hubungkan lagi saat memilih pembayaran di charger, lalu bayar sekarang."* (`settlement.postpay.linkEnded`). **Bayar sekarang** answers with the same guidance (409, `code: "wallet_link_ended"`). Once the driver links GoPay again, "Bayar sekarang" and the automatic retries charge the new link. The console's alert and the Holds and post-pay list show the reason ("link ended: …").
- Midtrans detects this from Get Pay Account, which is already called before every charge. Xendit is checked only after a charge is refused, so a refusal for another reason keeps the usual message.

English translations are in the app. Unit test 428; `e2e:postpay` checks 11–13.

**The same for OVO and DANA (28 Sep).** An OVO or DANA link that the driver ended in the e-wallet app, or that expired, gets the same messages and handling, naming the e-wallet: *"Tautan OVO Anda sudah tidak aktif …"*, `code: "wallet_link_ended"`, the link marked ended, the e-wallet offered for linking again, and an unpaid post-pay session payable once it is linked again.
- Xendit reports it on the linked payment method as `INACTIVE` (deactivated, for example unlinked in the app) or `EXPIRED`. The balance check before post-pay reads that status. After a refused payment request, the payment method is looked up, so a refusal for another reason (such as balance) keeps the usual message.
- **ShopeePay and LinkAja** get the same messages and handling, naming them (*"Tautan ShopeePay Anda sudah tidak aktif …"*, *"Tautan LinkAja …"*). LinkAja reports no balance, but its ended link is still found: the status is read before the balance. Charged up front (post-pay off, above the limit, or *post-pay only when the balance can be checked*), the driver is told to link it again instead of "LinkAja payment refused". Confirm the statuses Xendit sends for each e-wallet in its sandbox.
- With *post-pay only when the balance can be checked* on, the checkout's own quote can find the link ended first. The driver still gets the message naming the e-wallet, with the code.
- **Fixed:** linking an e-wallet again could fail when the acquirer returned the same token or payment method id as the ended link, because a driver's live cards may hold a token only once. The older link is now retired before the new one is activated, including when the acquirer approves the link at once. Before, an at-once approval also left the older link in place.

Unit test 428 (extended, all four e-wallets); `e2e:postpay` checks 21–23 (OVO, DANA) and 24–26 (ShopeePay unlinked after a session and paid once linked again; an expired LinkAja link refused up front).

**Saved cards whose token has ended (28 Sep).** A saved card's token can stop working: the driver deleted or replaced the card at the bank, or the acquirer's token expired. Before, the driver saw *"Kartu ditolak (411 Token id is missing, invalid, or timed out)"*, the card stayed on offer, and it failed the same way every time. Now:
- **Detected** from Midtrans status **411** (*"Token id is missing, invalid, or timed out"*, the one token code in Midtrans' 4xx reference), and at Xendit by looking up the card's v3 payment token after a refused payment (`EXPIRED` / `CANCELED`). A decline by the bank keeps the usual "Kartu ditolak" message.
- **The driver sees** *"Mastercard •••• 1117 yang tersimpan sudah tidak bisa dipakai: dihapus atau kedaluwarsa di penyedia pembayaran. Tidak ada yang ditagih. Bayar dengan kartu (bisa disimpan lagi), atau pilih metode lain."* with `code: "saved_card_ended"`. The app rebuilds the payment choices without the card, and the pass purchase reloads the Account page. The same applies to holds and 30-day passes paid with a saved card.
- **The card is marked ended** (`driver_card.status = 'failed'`). It is no longer offered at checkout or listed under Cards and e-wallets, and a second try is answered without asking the acquirer. Saved again, and if the acquirer gives the same token back, it is offered again.
- **A card past its expiry date** (or the token's expiry) gets a message naming it too (*"Visa •••• 4242 yang tersimpan sudah kedaluwarsa …"*), with the same code.

English translations are in the app. No settings, migrations or operator API changes. Unit test 429; `e2e:card-holds` checks 18–19.

**Card holds that expire before capture (28 Sep).** A card authorisation lapses at the acquirer after some days (Midtrans: 7 by default). Normally the hold is captured when the session is rated, long before that. A capture that keeps failing, or is retried days later, can meet an expired hold. Before, the capture was retried on the usual schedule and each retry failed the same way. The console only said "capture failed", with the acquirer's raw error, and the driver's receipt claimed the amount had been charged. Now:
- **Detected** from Midtrans **407** (*"Expired transaction"*) or `transaction_status: expire` on the capture, and from Midtrans' own expiry notification. At Xendit, after a refused capture the payment request is looked up and must be `EXPIRED`. A refusal while the hold is still authorised is retried as before.
- **The hold ends at once:** no more retries. `hold_error` begins *"hold expired: the card authorisation expired at … before it was captured; Rp … can no longer be taken from the card"*.
- **One critical alert** (`payment.hold_expired`) names the amount and says what to do: contact the driver to collect it another way, or write it off.
- **Console (Refunds → Holds and post-pay):** the hold shows *expired, not charged*, with that explanation and no Retry button. A callout gives the count and the amount to collect. The API's `/v1/card-holds` gains `holds[].expired`, `summary.expired` and `summary.expiredIdr` (documented; still 223 operations). A retry through the API answers 409 with the explanation instead of asking the acquirer again.
- **The driver's receipt:** *"Tidak ditagih dari kartu Anda — Penahanan Rp 50.000 di kartu Anda berakhir di bank sebelum biaya pengisian Rp 21.340 ditagih, jadi tidak ada yang diambil dan dana yang ditahan sudah kembali. Operator dapat menghubungi Anda untuk membayar sesi ini."* (`settlement.hold.expired`, `unpaidIdr`; paid shows 0). English translations are in the app.
- **An unused hold** whose expiry is notified, or a release answered with 407, or `EXPIRED` at Xendit, is simply released: nothing is held, nothing is owed, and its claim token can no longer start a session.

No settings or migrations. Unit test 430; `e2e:card-holds` checks 20–22.

**Paying an expired card hold in the app (28 Sep).** The driver now pays what the session cost straight from the receipt, instead of waiting for the operator to collect it.
- **The receipt** shows *"… Bayar sesi ini sekarang di aplikasi."* ("Pay for this session now in the app") and a **Bayar sekarang · Rp …** button. With more than one way to pay, the button first opens the usual payment choices: the operator's methods, saved cards and linked e-wallets. After the driver pays, the receipt shows *"Dibayar di aplikasi: Rp … (QRIS)"* ("Paid in the app"). English translations are in the app.
- **Every method works:** QRIS (a QR in the app), e-wallets and cards (the e-wallet app or the card page, then back to the receipt), a saved card or a linked e-wallet in one tap. It is always a sale for the amount owed: never a new hold, never post-pay.
- **A separate payment.** It is a new `payment_intent` with `mode: 'settlement'` and `settles_intent_id` pointing at the hold (migration **028**). It buys no energy, is never matched to a session, and is never refunded as "unused": those queries only look at prepurchase / preauth / postpay.
- **When it is paid** (the acquirer's signed notification, a one-tap charge, or the sandbox), the hold becomes `captured` and keeps its "hold expired: paid by the driver in the app (QRIS, Rp …)" note. The console shows *expired, paid in app* and no longer counts it as owed (`holds[].paidInApp`). The `payment.hold_expired` alert resolves, and its text now says the driver is asked to pay in the app.
- **Paid twice.** If the driver starts two payments (say a card page left open, then QRIS) and both complete, the second is refunded in full through the refund queue: *"Paid twice for the same expired card hold"*. Paying an already-paid hold does nothing.
- **Driver API:** `POST /d/v1/charge/:id/pay-expired` (`method`, `savedCardId`, `walletId`, `phone`), `GET /d/v1/charge/:id/pay-expired` (`owedIdr`, `paid`) and, outside production, `…/pay-expired/confirm-payment` for the sandbox. The receipt gains `settlement.hold.payOptions` and `settlement.hold.paidInApp`. The operator API is unchanged (223 operations), apart from the documented `paidInApp` field.

`e2e:card-holds` checks 23–25.

**Paying an unpaid post-pay session in the app when the e-wallet link ended (28 Sep).** A post-pay session whose e-wallet link ended before its charge (unlinked in the e-wallet app, or expired) could only be paid by linking the e-wallet again at a charger and then tapping "pay now". The driver now pays it straight from the receipt, with any method the operator offers. It is the same in-app payment as for expired card holds.
- **The receipt** says *"Tautan GoPay Anda sudah tidak aktif, jadi belum ada yang ditagih. Bayar sesi ini sekarang dengan metode lain."* ("Your GoPay link is no longer active, so nothing has been charged yet. Pay for this session now with another method.") It shows **Bayar sekarang · Rp …**, which opens the payment choices: QRIS, e-wallets, cards, saved cards and other linked e-wallets. Once paid, it shows *"Dibayar di aplikasi: Rp … (QRIS)"* ("Paid in the app").
- **The same settlement payment** (`mode: 'settlement'`, `settles_intent_id`) is used. When it is paid, the session becomes `captured` with the note *"link ended: paid by the driver in the app (QRIS, Rp …; payment …)"*. Post-pay is open to the driver again, the `payment.postpay_failed` alert resolves if one was raised, and the console shows *link ended, paid in app*. The console also explains unpaid ones: the driver can pay in the app or link again.
- **No double charge.** Starting an in-app payment stops the automatic e-wallet retries for that session. If the session is still paid another way (the driver links the e-wallet again and taps "pay now", or the operator retries), any in-app payment that completes afterwards is refunded in full. Paying an already-paid session does nothing, and neither does "pay now" once it is paid in the app. The note on a session paid in the app now names the payment that paid it, which is how a second payment is told apart. This also applies to expired card holds.
- **Driver API:** `POST/GET /d/v1/charge/:id/pay-unpaid` (and `…/confirm-payment` outside production) serve both cases. `/pay-expired` remains as the earlier name. `GET` now also says which kind of unpaid session it is (`kind`: `postpay` | `expired_hold`). The receipt gains `settlement.postpay.payOptions` and `settlement.postpay.paidInApp`.

No migrations (028 already covers it) or settings. `e2e:postpay` checks 26–27.

**Paying in the app when a post-pay charge is refused for insufficient balance (28 Sep).** Any refused post-pay charge (insufficient balance, or refused for another reason) can now be paid in the app too, not only one whose link ended. Before, the driver's only way was to top up and tap "pay now".
- **The receipt** says *"Saldo GoPay Anda tidak cukup untuk tagihan ini. Isi saldo lalu bayar sekarang, atau bayar dengan metode lain."* ("Your GoPay balance is not enough for this charge. Top up and pay now, or pay with another method."). For other refusals: *"Penagihan ke GoPay belum berhasil. Coba bayar sekarang, atau bayar dengan metode lain."* It offers two buttons:
  - **Bayar sekarang dengan GoPay** charges the same e-wallet again, as before;
  - **Bayar dengan metode lain · Rp …** opens every choice: QRIS, e-wallets, cards, saved cards and linked e-wallets, the same one included.
- The receipt gains `settlement.postpay.insufficient` (the refusal named the balance). `paidInApp.reason` is `charge_failed` or `link_ended`, and the paid note starts *"charge failed: paid by the driver in the app (…)"*. The console shows *paid in app*, and for an unpaid refused charge it explains both ways to pay.
- **The e-wallet can still be charged here**, unlike an ended link, so the double-charge guard matters. Starting an in-app payment stops the automatic retries. If the driver then tops up and taps "pay now", or the operator retries, and that pays first, the in-app payment that arrives afterwards is refunded in full (*"Paid twice for the same charging session"*). The session is paid once. The end-to-end run exercises exactly this race.
- If the driver abandons the in-app payment, the session stays unpaid with no automatic retries. It remains payable from the receipt, with "pay now", or by the console retry, and it keeps post-pay closed for that driver until paid.

No migrations or settings. `e2e:postpay` checks 28–29.

**Paying in the app while a post-pay charge waits for the e-wallet PIN (28 Sep).** When the e-wallet asks the driver to confirm the charge with their PIN, the driver can now pay another way instead of confirming it.
- **The receipt** says *"Konfirmasi pembayaran di aplikasi GoPay, atau bayar dengan metode lain."* ("Confirm the payment in the GoPay app, or pay with another method.") It offers **Konfirmasi di GoPay** (the confirmation link, as before) and **Bayar dengan metode lain · Rp …** (every choice). Once paid, it shows *"Anda memilih metode lain daripada konfirmasi PIN e-wallet; Anda sudah membayar sesi ini di aplikasi (QRIS)."* (`paidInApp.reason: pin_not_confirmed`).
- **The pending e-wallet charge is cancelled** at the acquirer when the driver chooses another method (Midtrans `/v2/{order}/cancel`; best effort). The session is marked *"pin not confirmed: …"* and paid with the settlement payment as for other unpaid sessions.
- **Confirmed anyway.** If the cancel does not reach the e-wallet in time and the driver still confirms the PIN, the acquirer's notification finds the session already paid in the app. That e-wallet charge is then refunded to the e-wallet at once: *"Paid twice for the same charging session: the e-wallet charge was confirmed after the session was paid in the app"*. Before, such a notification would have been recorded as a duplicate and the money kept. If the e-wallet charge instead arrives first, the in-app payment is the one refunded, as before.

No migrations or settings. `e2e:postpay` checks 30–31.

**Paying in the app when the e-wallet PIN confirmation expired (28 Sep).** An expired PIN confirmation already left the session unpaid and payable in the app. It now gets its own wording, and a gap around unconfirmed PIN charges is closed.
- **Named.** The acquirer's expiry notification (Midtrans `expire`, Xendit `EXPIRED`) now marks the session *"pin expired: the e-wallet confirmation expired before the driver confirmed it"*. A refusal or cancellation keeps *"the e-wallet charge was not completed"*.
- **The receipt** says *"Konfirmasi PIN GoPay sudah kedaluwarsa, jadi belum ada yang ditagih. Konfirmasi ulang sekarang, atau bayar dengan metode lain."* ("The GoPay PIN confirmation expired, so nothing has been charged yet. Confirm again now, or pay with another method.") It offers **Konfirmasi ulang di GoPay** (a new charge and PIN) and **Bayar dengan metode lain · Rp …**. Once paid in the app: *"Konfirmasi PIN e-wallet Anda kedaluwarsa; Anda sudah membayar sesi ini di aplikasi (QRIS)."* (`settlement.postpay.pinExpired`, `paidInApp.reason: pin_expired`). Paying in the app stops the automatic new PIN request, as for other refused charges.
- **Fixed: an unconfirmed PIN replaced by a new one.** A PIN left unconfirmed with no notification is retried after an hour (or by "pay now" or the console) with a new e-wallet charge. The old pending charge was not cancelled. Had the driver then confirmed it, its payment would no longer have matched the session, which by then pointed at the new charge. The acquirer would have taken the money with nothing recorded in PlugSure. The retry now cancels the old pending charge first (Midtrans `/v2/{order}/cancel`; best effort), so only the new one can be confirmed.

No migrations or settings. `e2e:postpay` checks 32–33. The check that a PIN confirmed after paying in the app is refunded now waits for the refund request itself, not just the "processing" state set a moment before it; it could pass or fail on timing.

**Paying in the app when the e-wallet PIN confirmation is denied (28 Sep).** A PIN confirmation the driver refuses, or that fails (for example a wrong PIN), was already payable in the app as a generic refused charge. It now gets its own wording.
- **Named.** Midtrans `deny`, and a Xendit `FAILED` whose failure code says the driver declined (Xendit's callback status now carries the failure code, e.g. *"FAILED USER_DECLINED_THE_TRANSACTION"*), marks the session *"pin denied: the e-wallet refused the confirmation"*.
- **The receipt** says *"Konfirmasi PIN GoPay ditolak, jadi belum ada yang ditagih. Coba konfirmasi lagi, atau bayar dengan metode lain."* ("The GoPay PIN confirmation was refused, so nothing has been charged yet. Try confirming again, or pay with another method.") It offers **Konfirmasi ulang di GoPay** and **Bayar dengan metode lain · Rp …**. Once paid in the app: *"Konfirmasi PIN e-wallet Anda ditolak; Anda sudah membayar sesi ini di aplikasi (QRIS)."* (`settlement.postpay.pinDenied`, `paidInApp.reason: pin_denied`).
- **The scheduled automatic retry** (a new PIN request 10 minutes after the denial) is dropped once the driver pays in the app.

No migrations or settings. Unit test 431 (the Xendit failure code); `e2e:postpay` check 34.

**Paying in the app when the e-wallet PIN confirmation is cancelled (28 Sep).** A PIN confirmation the driver cancels in the e-wallet app now gets its own wording as well. It was already payable in the app as a generic refused charge.
- **Named.** Midtrans `cancel` and Xendit `CANCELED` for the charge the session is waiting on mark it *"pin cancelled: the driver cancelled the e-wallet confirmation"*. PlugSure's own cancels never land here. When the driver pays in the app, the session has already stopped waiting. When a retry replaces an unconfirmed PIN, the old charge no longer belongs to the session. The end-to-end run sends such a stale cancel and checks that nothing changes.
- **The receipt** says *"Konfirmasi PIN GoPay dibatalkan, jadi belum ada yang ditagih. Konfirmasi lagi, atau bayar dengan metode lain."* ("The GoPay PIN confirmation was cancelled, so nothing has been charged yet. Confirm again, or pay with another method.") It offers **Konfirmasi ulang di GoPay** and **Bayar dengan metode lain · Rp …**. Once paid in the app: *"Anda membatalkan konfirmasi PIN e-wallet; Anda sudah membayar sesi ini di aplikasi (QRIS)."* (`settlement.postpay.pinCancelled`, `paidInApp.reason: pin_cancelled`).

No migrations or settings. `e2e:postpay` check 35.

**Unpaid sessions: a browser pass, Xendit's documented codes, reminders, and retries that resume (28 Sep).**
- **Browser pass** of the in-app payment on a phone-sized screen. Three sandbox sessions were made unpaid on the browser's own device: a denied PIN, insufficient balance, and an expired card hold. Each was paid through the receipt, the payment choices and the QRIS screen, in both languages. It found and fixed:
  - **Wrong note under the linked e-wallet:** the payment choices said *"… Sisa saldo yang tidak terpakai dikembalikan otomatis"* ("unused balance is refunded"), which is wrong when paying exactly what a session cost. They now say what this payment is: the session's cost, nothing held or refunded.
  - **Failed e-wallet preselected:** when paying another way, the choices preselected the e-wallet that had just failed. It stays on offer but is no longer preselected, so QRIS or the first other method is.
  - **No "Simpan QR":** the QRIS screen for an unpaid session lacked it, and a phone cannot scan its own screen. It now has it (the same image as the charging QR), and it checks at once when the driver comes back from the bank app.
  - **English cut in half:** three catch-all word translations (*Bayar → Pay*, *sesi → session*, *Kartu → Card*) ran before the specific ones. The results were "Pay sekarang dengan GoPay", half-Indonesian unpaid-session sentences, and the older "Card ditolak". They now run last. Also fixed: "This card is saved with another operator dan tidak bisa dipakai di sini". A new unit test runs the app's real translation pipeline, in order, over every payment message and fails on any Indonesian left.
  - **Unpaid not shown on the session screen:** it said *Selesai* (finished) with no sign the session was unpaid. See the next point.
- **Telling the driver.**
  - **Session screen:** a finished session that is unpaid says *"Belum terbayar: Rp … — Bayar sesi ini dari struk"* ("Unpaid — pay for this session from the receipt") with **Bayar · lihat struk** ("Pay · view receipt").
  - **Home screen:** one notice (*"Sesi belum dibayar"*, or *"3 sesi belum dibayar"* with the total) whose **Bayar** opens the latest session's receipt (`GET /d/v1/unpaid`).
  - **Web Push reminders:** phones that turned on notifications (the one that paid, and every phone signed in to the same account) get *"Sesi pengisian belum dibayar — {site} · Rp … · ketuk untuk membayar"*. It is sent 15 minutes, 1 day and 3 days after the session, each at most once, none after 7 days, and none once paid. It opens the receipt directly (`/app/#r/{charge}`). A new worker runs every 5 minutes. There is no WhatsApp reminder: messaging drivers there needs an approved template and their opt-in.
- **Xendit's documented codes.** The Payments API reference lists the failure codes. `USER_DECLINED_PAYMENT` (a refused confirmation; the older `USER_DECLINED_THE_TRANSACTION` is still recognised) is named *pin denied*. `USER_DID_NOT_AUTHORIZE` (never authorised in time) is now named *pin expired*; before, it got the generic wording. `INSUFFICIENT_BALANCE` is read by the balance message. Payment-token statuses `EXPIRED` and `CANCELED` are confirmed by Xendit's reference. Payment-method (v2) statuses `INACTIVE` and `EXPIRED` are confirmed by Xendit's official Node SDK. The reference does not spell out when a method becomes `INACTIVE` rather than `EXPIRED`; Xendit describes a method that is not `ACTIVE` as expired, unlinked or never linked, and PlugSure treats both as an ended link. The failure wording is one tested function (`postpayFailureNote`). Not tested against Xendit's sandbox: that needs the operator's Xendit keys.
- **Retries resume after an abandoned in-app payment.** Starting an in-app payment used to stop the automatic e-wallet retries for good, so a driver who walked away left the session unpaid with nothing retrying. Now the retries pause only while that payment can still be completed (its 30 minutes, plus 5 for its notification). The worker also checks: while a settlement payment for the session is pending and unexpired, it moves the retry past its expiry instead of charging the e-wallet. Once it has lapsed, the retries resume as before. The driver's own "pay now" never waits. A payment that arrives after the session is paid is refunded, as before.

No migrations or settings. Unit tests 437 (the translation pipeline, the reminder stages against the test database, and the Xendit codes); `e2e:postpay` 39/39 (the home screen's unpaid list, and retries that wait and then resume).

**Tax receipts for unpaid sessions, Xendit link callbacks, "Simpan QR" for passes (28 Sep).**
- **An unpaid session's tax receipt is a nil transaction.** While a card hold or a post-pay e-wallet charge has not been taken (capturing, or failed), the printable tax receipt shows:
  - the usage (energy, meter, lines with their quantities and rates);
  - every amount as **Rp 0**: line amounts, Subtotal, PBJT-TL, DPP, PPN and Total;
  - the title *"… — NIHIL / NIL"*, receipt number `PS-…-NIL`, and payment *"Belum dibayar / Unpaid"*;
  - a notice: *"Transaksi nihil / Nil transaction. Sesi ini belum dibayar, jadi semua nilai adalah Rp 0. Tanda terima dengan nilai sebenarnya diterbitkan setelah pembayaran diterima."* ("This session has not been paid, so every amount is Rp 0. The receipt with the actual figures is issued once payment is received.")

  Once paid, by the e-wallet or in the app, the receipt carries the real figures under the usual number. A session paid in the app now names the method actually used (*"Dibayar di aplikasi via QRIS"*) instead of the original e-wallet or card. The driver app and the operator console issue the same document, so both show the nil version while unpaid. This follows the operator's instruction for unpaid sessions; confirm the treatment with your tax adviser alongside the e-Faktur item classification.
- **Xendit's link callbacks** arrive on the payment notification URL, checked with the same callback token:
  - `payment_method.activated` / `payment_token.activation` completes a pending link at once, without the app polling;
  - `payment_method.expired` / `payment_token.expiry`, or a status of `INACTIVE` / `EXPIRED` / `CANCELED`, ends a live link at once: it is no longer offered, and the e-wallet can be linked again;
  - `payment_token.failure` fails a pending link.

  A callback with the wrong token is refused (401) and changes nothing; the integration's activity log records each one. Before, PlugSure only found an ended link at the next balance check or charge. **Operators:** in Xendit's dashboard, point the payment method and payment token callbacks at the same URL as payments.
- **"Simpan QR" for 30-day passes.** The pass QRIS screen gets the same save-to-gallery button as charging and unpaid sessions, and checks at once when the driver comes back from the bank app. The saved image now names what is being paid (the pass, or *"Sesi pengisian · belum terbayar"*) instead of the last charging station, which on these screens could have been a different one.
- **Counted sessions in English:** *"1 session"* and *"N sessions"*, with a test. The earlier "3 session" came from a test phrase, not a real screen; no screen showed it.

No migrations or settings. Unit tests 439 (Xendit link events, the plural); `e2e:postpay` 40/40 (the nil tax receipt, then the real one naming QRIS; the link callbacks, a forged one refused).

**When the charge does not go through**
- A refused charge (for example, insufficient balance) is **retried
  automatically**. It shows as unpaid on the driver's receipt with **Bayar
  sekarang**, which charges again.
- It is listed under **Refunds → Holds and post-pay** with **Retry now**. A
  critical alert follows the last automatic try.
- If the e-wallet asks for the driver's **PIN**, the charge waits. The receipt
  and "Bayar sekarang" open the confirmation link, and the acquirer's signed
  notification settles it. If the driver never confirms, a new charge is tried
  an hour later.

**How it is built:** post-pay reuses the card-hold machinery, with nothing
held at the acquirer:
- "capture" charges the linked e-wallet (`chargeWallet`);
- "release" takes nothing;
- the payment mode is `postpay`, and the payment's reference is replaced by
  the acquirer's charge when the charge is made, so its notifications find it.

**Operators:** Integrations → Payments → "Linked e-wallets: charge after the
session (post-pay)", **off by default**, with the limit under Advanced. It
applies to the e-wallets that can be linked (GoPay at Midtrans; OVO, DANA,
ShopeePay and LinkAja at Xendit; all in the sandbox). 30-day passes are always
paid up front.

**API:**
- `GET /v1/card-holds` now also lists post-pay (`kind`: `card_hold` |
  `postpay`, and the `channel`). Still 223 operations.
- The session payment status shows `pending` (post-pay not yet charged) and
  `failed` (charge refused).
- Driver API: the quote returns `walletPostpay`, `postpayLimitIdr` and
  `postpayBlocked`; the payment returns `postpay`; the receipt's settlement
  has `postpay`; and `POST /d/v1/charge/:id/pay-now` is new.

No migration and no new environment variables.

**Not included:**
- collecting an unpaid session by any means other than the e-wallet;
- post-pay for cards (card holds cover that).

## Cost during the charge (driver app, Live Activities)

Before this change the final cost appeared only at the end. Only fleet cards saw
an estimate during the charge, and it could disagree with the bill: it ignored
memberships, promotions, loyalty points and energy given back, and never
included an idle fee, because idle time was only worked out when the charge
stopped. A car left plugged in after it was full showed a flat price while the
fee grew.

**What drivers see**
- **Driver app, live charge screen:** the cost so far for every payment mode
  (QRIS, e-wallets, cards, card holds, post-pay, fleet cards). Prepaid charges
  show it against the amount paid ("Rp 23.415 dari Rp 50.000 dibayar"). A detail
  line gives the tax included and any saving. Once the car stops drawing and an
  idle fee starts, an amber note shows it rising: "Biaya parkir Rp 12.000: mobil
  tidak mengisi selama 12 menit. Cabut untuk menghentikannya." Indonesian and
  English.
- **iOS Live Activities:** the lock screen and the Dynamic Island show the cost
  so far while charging. It stays on "finished" until the charge record is
  rated, then the final cost replaces it (never both).

**How it is priced**
- One pricing path. The pricing half of `rateAndCreateCdr` became
  `priceSession()` (`src/services/sessions.ts`). The charge record and the
  running cost both use it: the tariff as of the start, the cheapest membership
  or promotion combination, energy given back, loyalty points, PBJT-TL and PPN.
  The running cost at the moment a charge stops **is** the bill, to the rupiah.
- `runningCost(sessionId)` prices the charge as if it stopped now, with idle
  time counted up to now from the meter samples, exactly as the stop does. It
  reads only. Once the charge record exists it returns the record's figures,
  marked `final`.
- Cached per session, and recalculated only when the energy, the energy given
  back, the idle minutes or the minute changes: the app polls every few seconds
  and the gateway's Live Activity pass runs every 5 s.

**API and payloads**
- Driver API `GET /d/v1/charge/:id/status`: new `cost` object (`totalIdr`,
  `subtotalIdr`, `taxIdr`, `discountIdr`, `idleFeeIdr`, `idleMinutes`, `asOf`,
  `final`). `estimatedIdr` is kept, now for every mode, and equals
  `cost.totalIdr`, so older app builds keep working.
- Live Activity content-state: new `estimateIdr` (whole rupiah; null once the
  final `costIdr` is known). A change of at least Rp 500 is worth an update on
  its own (`ESTIMATE_STEP_IDR`), within the same 30 s floor and Apple's budget.
- Build kit: `ChargingAttributes.ContentState` gains `estimateIdr: Int?`, shown
  in the widget. Optional, so payloads from an older gateway still decode, and
  older app builds ignore the new key. **Rebuild the iOS app from the new kit**
  for drivers to see it on the lock screen.

**Fixed while testing it: a replaced APNs key flagged as refused**
- The gateway caches each brand's APNs credentials for up to 30 s. For that
  long after an operator uploads a new key, a push could still go out with the
  old key. Apple refused it, and the gateway then marked the **new, working** key
  as "Apple refused the key" in the console.
- Now a refusal is only recorded if the refused credentials are still the
  brand's. The cache is dropped, and a Live Activity update is sent again at
  once with the new key. The console no longer reports a false refusal.
- Found through the Live Activity e2e, which failed intermittently when run
  twice within 30 s. The original v1.3.0 code failed the same way.

**Tests**
- `src/services/running-cost.test.ts` (database-backed, 3 tests): real sessions
  through the OCPP event path. The running cost at the stop equals the charge
  record, to the rupiah, with energy, a service fee and an idle fee (Rp 41,200
  before tax), and with a 20 % promotion (Rp 3,840 off). The idle fee rises while
  no energy flows. Pricing writes nothing.
- `src/services/apns-refused.test.ts` (database-backed, 3 tests): a refusal
  with a replaced key or Team ID leaves the current key good; with the stored
  key it is marked.
- Live Activity unit test and build-kit test extended; the driver app's
  English checked by the i18n test.
- `npm run e2e:live-activity` → **17/17** (3 new checks: the cost so far rising
  with the energy; kept on "finished", then replaced by the final cost; the key
  still accepted in the console after a stale-key refusal), including runs
  started within 30 s of each other. Counts are of pushes Apple accepted.
- `npm run e2e:driver` → **50/50** (2 new checks: a prepaid charge shows its cost
  so far; once rated, the cost shown is the receipt total, marked final).
- Unchanged and re-run on the refactored pricing: `e2e:pricing` 24/24,
  `e2e:v2x` 21/21, `e2e:card-holds` 38/38 (loyalty points).

**`npm test` now runs every test file**
- The script passed `src/**/*.test.ts` unquoted, so `/bin/sh` expanded it as
  `src/*/*.test.ts`. The two files one level deeper,
  `src/api/openapi/spec.test.ts` and `sdk.test.ts`, never ran under `npm test`.
  These are the checks that fail when the OpenAPI document or the SDK is out of
  date. The glob is now quoted, so Node's test runner expands it.
- The database-backed suites still run only against a database named
  `plugsure_audit_fix`; otherwise they are skipped with a warning.

## Security review fixes (29 Sep 2026)

A review of the whole system probed the running stack: path traversal,
unauthenticated access, hostile chargers, sign-in lockout, and the payment and
deployment paths. It found four medium-severity issues, all fixed here. Each
fix has a test that fails on the old code.

**1. The database superuser had a known default password (Docker Compose)**
- `docker-compose.yml` used `${POSTGRES_PASSWORD:-plugsure}`. An `.env` without
  the line gave the superuser the password `plugsure`. The superuser bypasses
  row-level security, so anything that reached PostgreSQL could read every
  tenant's data.
- Now required (`:?`), like the runtime role's password: `docker compose`
  refuses to start without it. `.env.example` lists it.
- **Action on upgrade:** an existing Path A install that relied on the default
  must set `POSTGRES_PASSWORD` in `.env` to the password the database was
  created with (`plugsure`), then change it:
  `ALTER ROLE postgres PASSWORD '<new>';` and update `.env`.
- Test: `src/deploy/compose.test.ts`. No secret in the compose file may have a
  non-empty default.

**2. A payment notification without an amount was booked as paid**
- The underpayment check ran only when the notification stated an amount.
  Without one, the payment was recorded as captured at the amount PlugSure had
  asked for, unverified. Midtrans always signs its amount; a Xendit callback
  without one was accepted. Reproduced on v1.3.0: an authenticated Xendit
  "paid" callback with no amount was booked as captured, Rp 20,000.
- Now it fails closed. A paid or authorised notification without an amount is
  not recorded, gets a 422 (the acquirer retries), and raises a critical alert
  (`payment.amount_missing`). The sandbox provider, whose notifications carry no
  amount and move no money, is the only exception, and it opts out explicitly.
- Test: `e2e:integrations` 22/22 (1 new check). Every other payment suite is
  unchanged: `e2e:payment-methods` 21/21, `e2e:card-holds` 38/38,
  `e2e:linked-wallets` 19/19, `e2e:postpay` 40/40.

**3. No per-charger message limit on the OCPP gateway**
- One connected charger could have about 1,400 messages a second processed,
  each touching the database. A charger needs its key first, so the risk is a
  faulty or compromised unit, not an anonymous attacker.
- Now each connection has a message budget: 20 a second, bursts of 200
  (`OCPP_MAX_MESSAGES_PER_S`, `OCPP_MESSAGE_BURST`; 0 disables it). Past it the
  gateway stops reading that charger's socket until the budget refills, so TCP
  slows the charger down. **Nothing is refused or dropped**; a refused
  transaction message could lose a session's revenue. Messages are processed in
  arrival order. A connection with more than 5,000 frames waiting is closed.
- Real chargers are unaffected: OCPP allows one outstanding request at a time,
  and the burst covers a charger uploading its queue after an outage.
  `e2e:field` 147/147. The frame-size limit still applies; it takes effect once
  the backlog is read.
- Measured: a 2,000-message flood got 261 answers in 3 s (was ~1,400), with a
  warning in the log.
- Test: `src/ocpp/throttle.test.ts` (5 tests).

**4. The API allowed inline script on every page it serves**
- Correction to the review: the console page itself was already protected, by
  its own `<meta>` policy (`script-src 'self'`). The header's `'unsafe-inline'`
  still applied to every other HTML page from the API: the printable session
  receipt, commission statements, fleet invoices, and the receipt in the driver
  app.
- Now `script-src 'self'` everywhere except the two pages that still carry
  inline script: the driver app (`/app`) and the API reference
  (`/api-docs.html`). The policy is in `src/api/csp.ts`.
- The receipt's Print button used an inline `onclick`. It now uses
  `data-print` and a same-origin script, `/d/print.js`, reachable on the console
  and on white-label hosts.
- Test: `src/api/csp.test.ts` (4 tests). It covers the policy per path
  (look-alike paths such as `/application` stay strict), no inline script in
  the printable pages, and no inline handler anywhere in the console (under the
  strict policy one would silently stop working).

**Low-severity fixes from the same review**

- **List parameters.** `limit=-5` on a list returned a 500 (PostgreSQL refused
  the negative limit), and fractions or text were rejected only because the
  database failed on them. The review said `limit=abc` gave a 500; it gave a
  400 already. One parser (`src/api/paging.ts`) now serves every route: a
  clear 400 for a value that is not a whole number of at least 1 (offsets: 0 or
  more), and a large value is still capped as before. **Change:** `1e9` was
  accepted and capped, and is now refused. The error handler also maps negative
  LIMIT/OFFSET to 400 for any route it may miss. Roaming (OCPI) paging keeps its
  lenient parsing, as partners expect. Test: `src/api/paging.test.ts`.
- **WhatsApp webhook verify token** compared in constant time, both sides hashed
  first so the length is not revealed either (`sameSecret`). The challenge echo
  was already plain text.
- **Firmware download links** worked until the image was archived, so a link
  copied from a charger's log or a vendor ticket stayed valid for good. A link
  now works only while a campaign that uses the image is scheduled or running
  and the charger's job is not finished, or for 24 hours after a job last moved
  (`FIRMWARE_LINK_GRACE_HOURS`), for slow downloads and retries. Campaigns are
  the only place links are handed out. `e2e:console` still takes a campaign
  through the charger's download to Verified.
- **Operator sign-in no longer reveals whether an address has an account.** A
  locked account said "temporarily locked" and returned instantly (no password
  hashing), so both the message and the timing confirmed the address. An account
  with no password yet (an invitation) also answered instantly. Now every
  failure (unknown address, wrong password, locked account, invitation) gets the
  same answer and the same password-hashing work: "invalid email or password
  (after 5 failed attempts, sign-in pauses for 15 minutes)". Measured medians:
  105, 102 and 108 ms for an unknown address, a wrong password and an
  invitation. A locked account still refuses the right password.

- **A raised API key rate limit now applies at once.** Raising a throttled
  key's limit (Users & roles → API keys) used to leave it refused until its empty
  bucket refilled towards the new limit, so whether the next request passed was
  a race. The extra allowance is now credited immediately, never beyond the new
  limit. Test: `src/services/ratelimit.test.ts` (fails on the old code);
  `e2e:sdk` 23/23, including "a raised limit applies from the key's next
  request".

Tests: `src/services/login-and-links.test.ts` (7, database-backed; the sign-in
tests fail on the old code), `src/api/paging.test.ts` (3), and the
constant-time comparison (1).

## Isolation and roaming authentication, attacked directly (29 Sep 2026)

The security review had relied on the existing tests for tenant isolation. Two
suites now attack it live and ship with the package.

- **`npm run e2e:isolation` → 45/45.** Two operators are created with their own
  administrators. Operator B tries to read and change everything of operator A:
  charger list, detail, rename, reboot, OCPP log and connections; session list,
  detail, receipt, review flag and remote stop; cards; sites; tariffs, including
  assigning A's tariff to A's or B's site; fleet accounts and invoicing;
  webhooks, including delete and replay; API keys, including revoke and rate
  limit; promotions; users, including role change and deactivation; the audit
  log; and ID swaps. Every attempt gets 404 or an empty list, never A's data
  and never a 500. A's own data is unchanged afterwards. (Webhook replay answers
  `{requeued: 0}` rather than 404: the service filters by organisation in SQL,
  so B learns nothing.) The suite creates and removes its own organisations.
- **`npm run e2e:ocpi-auth` → 9/9.** No token and a made-up token get 401; a
  partner's one-time token reads only `/ocpi/versions` until registration is
  complete; a message addressed to another party is not answered as ours; a
  partner token is no console session (`/v1/sessions` and sign-in refused);
  ten guessed tokens all get 401 quickly; and the token is shown once at
  creation and never appears in the overview, message log or token views.
- **Plug & Charge, by code review:** every query in `authorizeContract` is
  scoped to the charger's organisation (contract lookup joins through the
  charger's site; MO trust anchors and settings are per organisation), so a
  contract registered by one operator cannot authorise at another's charger.
  Not attacked live; `e2e:pnc` (37/37) exercises the flow against the sandbox
  PKI.

**Still needing real infrastructure:** load at 300+ chargers (watch
`GATEWAY_DIAG=verbose` on a loaded staging host: pool waits, event-loop delay,
worker pass times), the Caddy edge live (TLS, the office allow-list, on-demand
certificates for white-label hosts, `X-Client-Cert-Fingerprint`), and the
acceptance test on real charger hardware (`docs/ACCEPTANCE-v1.3.md`).

## Behaviour changes to note

- **Development seed account is now `ops@plugsure.com`** (was `ops@nusantaracharge.id`).
  `npm run seed` creates it, and every `tools/e2e/*` script signs in with it.
  Production is unaffected: its first administrator comes from
  `npm run create-admin`. A development or staging database seeded earlier keeps
  the old account; rename it once, rather than re-seeding (which would add a
  second account):
  `UPDATE app_user SET email = 'ops@plugsure.com' WHERE email = 'ops@nusantaracharge.id';`
  The white-label examples (`app.nusantaracharge.id`, "NusaCharge") are unchanged:
  they illustrate a customer operator's own branded app.

- **Production without a connected acquirer refuses QRIS checkout** with a
  clear message. It used to create sandbox QR codes that could never be paid.
  Connect one under Govern → Integrations before selling.
- **Production without a sign-in code provider refuses to send codes**, and
  says so. It used to report success without sending anything.

- **Charge points may now request their own certificate over OCPP**
  (SignCertificate). They were refused before; now PlugSure's CA signs the
  request when its CN is the charger's identity.
- **With TLS terminated at the gateway, chargers are asked for a client
  certificate.** Chargers without one still connect on Profiles 1 and 2.


- **Error statuses:** a malformed id in a request is now 400 (was 500), and a
  command to a charger that is not connected is 409 with
  `code: "charger_offline"` (was 500). Integrations that retried on 500 should
  treat 409 as "try when the charger is back".

- **A one-time password must be replaced before anything else works**, via the
  API as well as the console. Scripts that sign in as a freshly invited user
  must call `POST /v1/auth/change-password` first.

- **Prepaid claim window.** A driver must start within 30 minutes of paying.
  After that the QR stops working and the full amount goes to the refund queue.
- **After upgrading, expect a burst of offline alerts** for chargers that were
  already quietly offline. Their outage is dated from when they were last seen.
  Decommission units that are gone for good.

- **The console now requires sign-in.** It previously worked only with the
  development auth bypass. Bearer API keys are unaffected.
- **A power ceiling above connected kVA × PF is refused** by
  `PUT /v1/sites/:id/power/budget` (422) instead of being stored and clamped later.
- **"Pending calibration" meters cannot sell energy** (remote start, QRIS and
  driver-app checkout are refused), like lapsed ones. Existing connectors default
  to `verified`, so nothing changes until an operator marks one pending.
- `GET /v1/charge-points` rows gain fields (display name, live session per
  connector…); existing fields are unchanged.
- `get-configuration`, `change-configuration`, `get-diagnostics` also accept the
  new `charge_point:config` permission (technicians). Existing keys keep working.

## Upgrade from v1.2.1

1. Deploy the new build and run migrations (`npm run migrate`, or the compose
   `migrate` service). Migrations **009** to **035** are additive (014: site
   owners; no site has an owner until you assign one. 015 to 017: roaming;
   nothing is shared until you publish a site or share a card. 018: driver
   favourites, push notifications and reservations. 019: developer sandboxes;
   none exists until one is created. 020: fleet billing; existing fleet cards
   are linked to an account per fleet name, nothing is invoiced until you
   issue. 021: promotions and memberships; none exists until one is created. 022: Plug & Charge; off until switched on. 023: charger certificates; nothing changes until one is issued. 024: integrations; environment variables apply until something is set in the console. 025: e-wallet and card payments; QRIS only until an operator enables more. 026: card holds and saved cards; off until an operator enables them. 027: linked e-wallets; off until an operator enables linking. 028: paying an expired card hold in the app, a link from the payment to the hold it settles. 029: alerting follow-ups; no SMS, rota or webhook until one is set up. 030: fleet credit notes and the fleet customer portal; nothing credited and no portal user until created. 031: pass renewal, proration and loyalty points; nothing renews, and nobody earns points, until switched on. 032: the OCPP 2.0.1 device model; empty until a station reports. 033: the driver queue; no site has one until it is switched on. 034: reserving partner chargers; nothing changes until a fleet driver reserves one. 035: reservation fees; nothing is charged until an operator sets a fee on a site): new nullable
   columns, defaults that reproduce v1.2.1 billing, new tables with RLS, the
   fleet PIN lockout counters, refund state, outage history and the webhook
   outbox (011), alert routing (012), and commission statements (013; every
   site starts as "public"). 012 marks existing alerts as already routed, so
   upgrading sends nothing for history.
   Then create the operator's billing account:
   `npm run create-admin -- --email billing@… --org-slug plugsure --org-name "PlugSure" --platform-admin`.
2. Set in `.env` / `/etc/plugsure/plugsure.env`:
   - `INTERNAL_API_TOKEN` (`openssl rand -hex 32`) — **required** for the split
     deployment; compose refuses to start without it.
   - `GATEWAY_INTERNAL_URL` on the API (`http://gateway:9220` in compose,
     `http://127.0.0.1:9220` on one VM) and `EVENT_RELAY=true` on the gateway
     (compose sets both).
   - `PUBLIC_BASE_URL` (the HTTPS host chargers reach, for FOTA downloads and log
     uploads) and `OCPP_PUBLIC_URL` (printed on commissioning QR codes).
   - `API_TRUSTED_PROXIES=127.0.0.1` when Caddy fronts the API, so URLs and the
     Secure cookie see https.
   - Optional: `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_PKI_MOUNT`, `VAULT_PKI_ROLE` for
     Profile 3 certificate issuance.
   - `CONSOLE_PUBLIC_URL` on the gateway (the console address put in alert
     messages; defaults to `PUBLIC_BASE_URL`). The gateway needs outbound access
     to your SMTP server (587/465) and to `graph.facebook.com:443` for WhatsApp.
   - Optional: `OFFLINE_ALERT_MINUTES` (default 15), how long a charger may be
     offline before a critical alert. `SECRETS_KEY` (already required in
     production) now also seals webhook signing secrets; changing it means
     rotating every webhook secret.
   - For roaming: `OCPI_PUBLIC_URL` (the public `ocpi.` host partners call;
     defaults to `PUBLIC_BASE_URL`), and optionally `OCPI_PBJT_IN_EXCL_VAT`
     (default true) on both the API and the gateway. `SECRETS_KEY` also seals
     partner tokens.
   - Driver app, all optional:
     - `MAP_TILE_URL` / `MAP_ATTRIBUTION` on the API. Use your own tile service
       for real traffic.
     - `VAPID_SUBJECT` (a mailto: or https: contact for push services) and
       `PUSH_ALLOWED_HOSTS` on the gateway. Leave `VAPID_PUBLIC_KEY` /
       `VAPID_PRIVATE_KEY` empty to generate and store a key.
     - `DRIVER_RESERVATIONS`, `DRIVER_RESERVATION_MINUTES` and
       `DRIVER_RESERVATION_NO_SHOW_LIMIT`.
     - The gateway needs outbound HTTPS to the push services (FCM, Mozilla,
       Apple, Microsoft).
   - Plug & Charge, optional: `PNC_PKI=http` with `PNC_PKI_URL` and
     `PNC_PKI_TOKEN` (your PKI gateway), on both the API and the gateway.
     Optionally `PNC_V2G_SIGNER=vault` with `PNC_VAULT_MOUNT` / `PNC_VAULT_ROLE`.
     The gateway needs outbound HTTP/HTTPS to the PKI's OCSP responders.
   - Integrations: nothing to set. The QRIS acquirer, sign-in codes, the PKI and map tiles are connected in Govern → Integrations; the `PNC_*` and `MAP_TILE_*` variables remain as fallbacks. **Expose `/pay/*`** on the public host (`deploy/Caddyfile`) for payment notifications.
   - E-wallet and card payments: nothing to set; operators tick the methods in Govern → Integrations → Payments. Optional `DRIVER_PUBLIC_URL` (API) when the driver app is on another host than `CONSOLE_PUBLIC_URL`: acquirers send drivers back to `<it>/app/paid.html`. Register that return URL where the acquirer asks for one (Midtrans Snap finish URL; Xendit takes it per payment).
   - Post-pay with linked e-wallets: nothing to set; operators switch it on in Govern → Integrations → Payments (with a per-session limit).
   - Linked e-wallets: nothing to set; operators switch linking on in Govern → Integrations → Payments once e-wallet tokenisation is enabled on the acquirer account (GoPay Tokenization at Midtrans; OVO / DANA / ShopeePay / LinkAja reusable payment methods at Xendit).
   - Card holds and saved cards: nothing to set; operators switch them on in Govern → Integrations → Payments once card pre-authorisation (and saving / One Click) is enabled on their acquirer account.
   - Charger certificates, optional: `CHARGER_CA_CERT_FILE` / `CHARGER_CA_KEY_FILE` (your own CA; otherwise one is created), `CHARGER_CERT_DAYS`, `CHARGER_CERT_RENEW_DAYS`, `CSMS_ROOT_CA_FILE`. **Update Caddy from `deploy/Caddyfile`**: the `header_up X-Client-Cert-Fingerprint` line closes a spoofing hole, and the `client_auth` block enables Profile 3.
3. Create the first administrator:
   `node dist/db/create-admin.js --email you@cpo.id --name "Ops Lead" --org-slug <slug>`
   (`npm run create-admin -- …` from source). It prints a one-time password.
4. Update Caddy from `deploy/Caddyfile`: `/fw/*` and `/diag/*` on the OCPP host
   (chargers call them), optionally the console hostname with an IP allow-list,
   and, for roaming, the `ocpi.` hostname serving only `/ocpi/*`. Optionally,
   the `api.` hostname for integrators (API keys only; `/v1/*`,
   `/openapi.json`, `/api-docs.html`).
5. Mount a persistent volume at `STORAGE_DIR` (compose: `plugsure-storage`).

## Verification (this release)

Run on 26 Sep 2026 with Node 24 and **PostgreSQL 18** (the product targets 16):

- `npm run typecheck` → **clean** (both `tsconfig.json` and `tsconfig.build.json`).
- **Security review fixes (29 Sep 2026, PostgreSQL 16):** `npm test` → **571
  passing, 0 failing, 0 skipped** (23 new, low-severity and rate-limit fixes included). End-to-end on the two-process stack:
  `e2e:integrations` 22/22, `e2e:field` 147/147, `e2e:payment-methods` 21/21,
  `e2e:card-holds` 38/38, `e2e:linked-wallets` 19/19, `e2e:postpay` 40/40,
  `e2e:console` 96/96, `e2e:driver` 50/50. See **Security review fixes**.
- **Cost during the charge (28–29 Sep 2026, PostgreSQL 16):** `npm test` →
  **548 passing, 0 failing, 0 skipped** (the 541 below plus 7 new), run twice.
  Typecheck clean. End-to-end on the two-process stack as `plugsure_app` with
  row-level security: `e2e:live-activity` 17/17, `e2e:driver` 50/50,
  `e2e:pricing` 24/24, `e2e:v2x` 21/21, `e2e:card-holds` 38/38. See
  **Cost during the charge**.
- `npm test` → **541 passing, 0 failing, 0 skipped**, including the
  database-backed audit-chain and driver-app suites, run against a dedicated
  database. The Web Push encryption matches the RFC 8291 Appendix A test vector
  byte for byte. The OpenAPI suite checks the document against the routes the
  running API registers. Parallel test files no longer interfere:
  - the audit-chain suite resets the chains in one transaction, and runs apart from the other database-backed files (an advisory lock: exclusive for it, shared for them, `src/db/test-lock.ts`). Before, an entry another file wrote between its truncates left that chain behind its log, and the charger-CA tests failed on `audit_log_org_seq_uniq`; the audit suite could also find another file's row where it expected its own. This was test-only: production never truncates the chain.
  - the sandbox transport tests wait for the event instead of a fixed 30–100 ms, which was too short with 16–32 files running at once.
  - Verified by 10 full runs, at the default concurrency and at 1, 16 and 32 files at once, all 481/481.
- **Plug & Charge: 37/37 checks** (`npm run e2e:pnc`), with the test PKI:
  - a raw 2.0.1 station switched on, given its trust anchors and its V2G certificate (TriggerMessage → SignCertificate → CertificateSigned), the chain verified up to the V2G root
  - contracts authorised from the certificate hash data (OCSP) and from the full chain; someone else's certificate, revoked, cancelled and unregistered contracts refused with the right status; OCSP unreachable handled by the setting
  - a session started with the eMAID billed to the contract and its fleet account; GetCertificateStatus and Get15118EVCertificate
  - the trust store read and a certificate deleted; a raw 1.6 charger doing the same inside DataTransfer
  - a sandbox virtual charger set up from the API and a simulated Plug & Charge car charging; live responses against the published schemas
  - its first runs found the 2.0.1 command-version defect above, and a test PKI write that the gateway could not yet see inside the same request
- **Onboarding and charger certificates: 19/19 checks** (`npm run e2e:onboarding`), with the gateway trusting the proxy headers as behind Caddy:
  - the charging-station CA and its download; hardware details saved
  - a key and certificate issued automatically (CN, chain, TLS client use, validity), Profile 3 enforced, the charger connecting over mutual TLS; refused without TLS, without a certificate, with another certificate, and with a password
  - the charger's own CSR signed, and a CSR for another identity or a broken one refused
  - zero-touch on OCPP 1.6: Profile 2 → ExtendedTriggerMessage → SignCertificate → CertificateSigned → SecurityProfile 3, after which the password stops working and the certificate works
  - a renewal where the old certificate works until the new one is used, then stops
  - 2.0.1 SignCertificate(ChargingStationCertificate) and TriggerMessage; the Onboarding page data, the audit trail and the published schemas
- **Integrations: 21/21 checks** (`npm run e2e:integrations`), with a local fake Midtrans, Xendit, WhatsApp Cloud API, Twilio and PKI gateway:
  - Midtrans connected with the secret sealed and only hinted; a key test; console and driver-app checkouts created at Midtrans (no demo button)
  - forged notifications and unknown URLs refused; a signed notification captures once; a short payment is not captured; a refund through Midtrans
  - Xendit with its callback token; the old Midtrans URL still settling its own payments after the switch
  - sign-in codes by WhatsApp (template with the code) and by the Twilio fallback when WhatsApp refuses, each signing the driver in, no code on screen, the activity log masked
  - the PKI gateway used by Plug & Charge; map tiles in the driver app and the page policy; audit without secrets; removal back to the defaults
- **E-wallet and card payments: 21/21 checks** (`npm run e2e:payment-methods`), with a local fake Midtrans (Core API, Snap, refunds) and Xendit (e-wallet charges, invoices, e-wallet refunds), on a real OCPP charger:
  - the sandbox: every method offered; a charge paid by GoPay and a 30-day pass by DANA on the sandbox checkout page; a card payment cancelled there; the return address kept inside the app; OVO without a valid number refused
  - Midtrans with QRIS, GoPay and cards enabled: an unsupported or empty choice refused; only the enabled methods offered and accepted; the GoPay deeplink and Snap card page; a card under fraud challenge not captured, accepted captured; the GoPay refund through Midtrans
  - Xendit: OVO pushed to the driver's number, DANA and card redirects; ewallet.capture and invoice callbacks (a wrong token refused, EXPIRED expiring); the OVO refund with its charge id, a card refund sent to bank transfer
  - the return page, the app's method picker and the console's checkboxes served; activity logged per channel; live responses against the published schemas
  - its first run found the OVO number-format defect above
- 12 new adapter unit tests: Midtrans GoPay/ShopeePay/Snap and card notifications, Xendit OVO/DANA/invoice, callbacks and refunds, and the per-acquirer method lists.
- **Card holds and saved cards: 38/38 checks** (`npm run e2e:card-holds`), on a raw OCPP 1.6 charger with real sessions, the sandbox acquirer and a local fake Midtrans:
  - a card held for Rp 50,000 and saved on the sandbox checkout page; the rated total captured and the rest released, no refund; the receipt's held / charged / released lines
  - the saved card paying in one tap; a zero-energy session releasing the whole hold; an unused hold released by the worker with its claim token refused at the charger; a 30-day pass paid with the saved card as a sale
  - automatic pass renewal by the worker with the saved card (the next 30 days from the old end, nothing charged twice; refused for an unknown method or another driver; stopping with the reason once the card is removed); switching up (the difference paid) and down (free and longer, only the current pass credited)
  - loyalty points: switched on (an invalid value refused), earned on a session and shown on the receipt and in the app, spent on the next session (the driver chose to use them) as a discount line before tax with the captured amount lower, adjusted in the console (never below zero), expired by the worker
  - another driver refused the card, a guest unable to save one, a removed card unable to pay
  - Midtrans: Snap asked for a hold and to save; the authorize notification holding and saving the token for that account only; a capture refused once, listed under Card holds and captured when retried from the console; the capture notification recorded without changing the amount; a Midtrans saved card through 3-D Secure again; a saved token Midtrans no longer accepts (411) refused naming the card ("Mastercard •••• 1117 … tidak bisa dipakai"), no longer offered, and offered again once saved again; an unused hold whose expiry Midtrans notified released with its claim token expired; a capture refused as expired (407) ending the hold with no retries, one critical alert, the console's explanation and the driver's receipt; the driver paying it in the app (the saved card sent to 3-D Secure, then QRIS paid by Midtrans' notification: the hold paid in the app, the alert resolved, paying again a no-op) and the abandoned card payment completed later refunded in full
  - live responses against the published schemas; its first run found the console-retry defect above
- 9 new adapter unit tests: Midtrans and Xendit holds, captures, releases, saved-card charges and notifications, card brands, and the settings' defaults.
- **Linked e-wallets: 19/19 checks** (`npm run e2e:linked-wallets`), on a raw OCPP 1.6 charger with real sessions, the sandbox acquirer and local fakes of Midtrans and Xendit:
  - GoPay linked on the sandbox approval page (guests refused), offered first, paid in one tap; the unused balance refunded automatically after the session; a 30-day pass in one tap
  - an OVO link refused ending failed; a bad number and an e-wallet that cannot be linked refused; another driver unable to use or see the link; an unlinked wallet unable to pay
  - Midtrans GoPay Tokenization: pay account, activation link, ENABLED token, one-tap charge on account id + token, automatic refund through Midtrans, insufficient balance refused, unbind on unlink
  - Xendit OVO: reusable payment method, activation, payment request, automatic refund through the Refunds API; ShopeePay and LinkAja linked and paid in one tap the same way
- 6 new adapter unit tests: Midtrans and Xendit linking (including ShopeePay and LinkAja), status, charges (at once / PIN / refused), Xendit refunds of payment requests, and the settings' defaults.
- **Post-pay with linked e-wallets: 40/40 checks** (`npm run e2e:postpay`), on a raw OCPP 1.6 charger with real sessions, the sandbox acquirer and local fakes of Midtrans and Xendit:
  - a session started with nothing charged, the rated total charged to the linked GoPay afterwards (no refund), the receipt saying so
  - above the operator's limit the e-wallet charged up front; an unused post-pay session released with nothing charged
  - Midtrans: the GoPay balance checked before starting; a charge refused after the session shown unpaid, listed in the console, the next payment taken up front, then paid by the driver from the receipt; a charge needing the GoPay PIN waiting for the driver and settled by Midtrans' signed notification; after an upgrade to GoPay Tabungan the Tabungan balance checked (never PAY_LATER credit) and the charge sent with the token Get Pay Account gives at that moment; a GoPay link ended in GoPay after a session not charged, the receipt and "pay now" saying to link again, and "pay now" charging the new link once linked again; ended before a session: refused with "link again" (not a balance message)
  - Xendit: the OVO, DANA and ShopeePay balances on the linked payment methods checked before post-pay (a larger limit refused naming the balance, nothing charged; a smaller one started); LinkAja reporting no balance starting unchecked, then — with "post-pay only when the balance can be checked" — marked and charged up front; GoPay linked through Xendit (a GOPAY_RECURRING payment token) with its balance from token_details checked, and a one-time GoPay payment through Xendit; OVO unlinked in the OVO app after a session (the receipt and "pay now" saying to link OVO again, then paid once linked again) and an expired DANA link refused at the start with "link DANA again"; ShopeePay unlinked after a session and paid once linked again; an expired LinkAja link charged up front, refused by Xendit, with "link LinkAja again"; a Midtrans post-pay session whose GoPay link ended paid in the app by QRIS (the GoPay retries stopped, post-pay open again, nothing more charged by "pay now" after linking again); a charge refused for insufficient balance paid in the app by QRIS, and the race where the topped-up GoPay pays first via "pay now" and the later QRIS payment is refunded in full; a session waiting for the GoPay PIN paid by QRIS instead (the GoPay charge cancelled at Midtrans), and the PIN confirmed anyway refunded to GoPay automatically; a PIN confirmation that expired (Midtrans "expire") named on the receipt and paid in the app by QRIS; a retry of a never-confirmed PIN cancelling the old pending GoPay charge before asking for a new one; a PIN confirmation the driver refused (Midtrans "deny") or cancelled ("cancel") named on the receipt and paid in the app by QRIS, and a stale cancel for a replaced PIN changing nothing; the home screen's unpaid list; an abandoned in-app payment after which the automatic retries wait for it to lapse and then charge GoPay; the tax receipt of an unpaid session as a nil transaction (Rp 0) and the real one once paid in the app naming QRIS; Xendit link callbacks ending a ShopeePay link and activating a pending LinkAja link, a forged one refused
- Migrations 001–042 applied, then re-run as a no-op; `npm run seed` completed.
- **Promotions and memberships: 24/24 checks** (`npm run e2e:pricing`), on real OCPP sessions in a developer sandbox, then the driver app in the operator's test tenant:
  - plans and memberships, with impossible values and a second live membership refused
  - a member session: member price, 1 included kWh, service fee waived and a happy hour on top, with PBJT-TL and PPN on the discounted price and the allowance used
  - a non-member: the happy hour once, then full price (one use per customer); the member again with the allowance used up
  - discount lines on the tax receipt, and the promotion's statistics
  - the membership fee on the fleet invoice (DPP 11/12, PPN 12%), billed once, with its own e-Faktur line; a card membership in force 10 days of the month billed for those days
  - the driver app: plans on offer, promo codes (unknown and valid) in the quote, a 30-day QRIS pass bought and renewed, the member price in the quote, a switch to another plan quoted with the unused days credited
  - live responses against the published schemas, and the audit trail
- **Fleet billing: 53/53 checks** (`npm run e2e:fleet-billing`), in a developer sandbox on real OCPP sessions at two sites with different PBJT-TL rates:
  - fleet accounts, including the trigger-created one, NPWP normalisation and card moves
  - drafts in the current month, with issuing refused until it ends
  - per-line DPP/PPN arithmetic, and agreement with the session receipts (rounding difference 0)
  - the e-Faktur gate and the XML's DPP/PPN against the invoice, with a buyer without NPWP skipped
  - numbering and due dates, the printable invoice and CSV
  - e-mail with attachments to a local SMTP server
  - void and re-issue without double billing, payment, the faktur number and the audit trail
  - the invoice, a draft and credit notes as PDF, their text checked
  - credit notes: refused beyond the invoice (total, PPN, the untaxed part), without a reason, or on a void invoice; a partial credit split exactly into DPP and PPN; the full remainder settling the invoice and its void re-opening it; a refund recorded; a credit deducted from the next month's invoice and then no longer voidable; e-mail with the PDF; the faktur warning
  - the fleet customer portal: an invited user signs in and holds only `fleet:portal`; own invoices, credit notes, PDFs, CSV and this month (without the operator's notes); another account's documents and a voided invoice 404; operator pages 403; an operator gets nothing from the portal; a lost card blocked and unblocked, an operator-blocked card and another account's card refused
  - every live response against the published schemas
- **Published API and sandbox: 38/38 checks** (`npm run e2e:api-sandbox`) on the
  split deployment:
  - the public document and reference page, with nothing internal published
  - an operator creates a sandbox; its two virtual chargers boot inside the
    gateway
  - isolation: the operator's own lists, simulation with a production key, a
    nested sandbox, roaming, the driver app, and a network connection
    impersonating a virtual charger
  - a signed webhook endpoint
  - remote start and stop through the normal API, with rating, the tax receipt
    and webhooks
  - a card tap charging to a full battery, a blocked card refused, and a ground
    fault with its alert and webhook
  - a dropped link (a command to it answers 409), the link restored, and
    configuration read from the charger
  - a malformed id answering 400
  - a charger onboarded inside the sandbox
  - **69 documented GET operations called and their live responses validated
    against the published schemas** (53 before fleet billing, 56 before promotions, 59 before Plug & Charge, 64 before onboarding, 68 before integrations)
  - reset, key rotation, deletion and the audit trail
  - The first run found the simulator's refused-card defect; it is fixed and
    covered by a unit test that fails without the fix.
- **Reservation fees: 12/12 checks** (`npm run e2e:reservation-fees`), with a raw OCPP 1.6 charger, an app driver paying through the sandbox acquirer and a fleet card: the fee shown with its PPN, the connector held only once paid, refunds on a quick cancel, a late payment and a refused hold, the fee kept after the 2-minute grace, a fleet card's fee on the month's statement, waived when cancelled at once, and invoiced once on last month's invoice
- **Driver queue: 19/19 checks** (`npm run e2e:queue`), with a raw OCPP 1.6 charger (CCS2 and CHAdeMO) and four drivers signed in:
  - settings out of range refused; the site queue public; a guest must sign in
  - joining in order; a second join and a full queue refused; places counted only against drivers who compete
  - a freed connector held on the charger for the first in line (ReserveNow), told by push, refused to everyone else
  - an offer let lapse: a missed turn, the connector to the next driver who fits, not counted as a reservation no-show
  - skipping: CancelReservation, and no offer of a connector the next driver cannot use
  - a hold the charger refuses: walk-ups still cannot pay for or reserve the free connector (shown Queued), and the worker retries
  - the driver whose turn it is pays with the held idTag as the claim token, starts, and is served
  - joining refused while a suitable connector is free; the console list, removal (told, audited, 404 twice), a wait that runs out, and switching the queue off
- **Driver map, favourites, push and reservations: 46/46 checks**
  (`npm run e2e:driver-plus`), run with a raw OCPP 1.6 charger and a mock push
  service on the split deployment:
  - public app settings, the service worker and the CSP tile host
  - favourites, including following the account to a new phone and privacy
    between devices
  - push subscriptions, including malformed keys and endpoints refused
  - ReserveNow and CancelReservation at the charger
  - a reserved connector refused to other drivers
  - a charger that answers Occupied
  - reserve → pay → remote start with the held idTag → StartTransaction with
    the reservation id → reservation used
  - "started", "finished" and "receipt" notifications, which the test decrypts
    itself with the subscription's keys and whose VAPID signatures it checks
  - a language switch, and no duplicates
  - the 5-minute reminder and expiry, with the clock moved in the database
  - a push service's 410 removing the subscription
  - the unpaid claim token retired
  - The app was also checked at phone width in the browser: map tiles and
    markers, the marker card, the favourite star, and the notification switch.
    The service worker registers and activates in Edge.
- **Roaming end-to-end: 74/74 checks** (`npm run e2e:ocpi`) against a mock eMSP
  and a raw OCPP 1.6 charger on the split deployment:
  - registration both ways (including picking 2.2.1 from two offered versions)
  - pulls with paging, and location, tariff and EVSE-status pushes
  - pushed tokens: whitelist and real-time authorisation
  - a roaming session through to its CDR, checked against the session explorer's total
  - the five commands, and a refused unlock during another driver's session
  - hub routing headers, suspension, withdrawal and disconnect
- Stable across repeated runs.
- **Roaming as the card provider (eMSP), with the driver app: 60/60 checks**
  (`npm run e2e:ocpi-emsp`) against a mock CPO:
  - card sharing and withdrawal, whitelist rules and real-time answers
  - importing a paged network, location/EVSE/tariff pushes
  - START/STOP commands with results posted back
  - our driver's session, the CDR (read back, duplicate and changed-CDR handling)
  - a spending limit reached through roaming charges, and the CSV export
  - in the driver app: the partner network, starting, following and stopping a
    charge, the charge details, history, and privacy between drivers
- **Roaming smart charging and hubs: 36/36 checks** (`npm run e2e:ocpi-profiles`), with a raw OCPP 1.6 charger, a mock service provider and a mock hub:
  - **Limits on a running session.**
    - An 11 kW limit reaches the charger as the load-management transaction profile, and the result is posted back.
    - A change within 5 s answers TOO_OFTEN.
    - Asking what is in force reads the charger's composite schedule.
    - Malformed limits, a missing response_url and unknown sessions are refused.
    - A 150 kW limit leaves the session at its 60 kW nameplate.
    - A stepped schedule applies its later step.
    - Lifting the limit restores the full share; lifting it again answers UNKNOWN.
    - Once the session ends, a new limit answers UNKNOWN_SESSION.
  - **Hubs.**
    - The client list is pulled over two pages after the hub registers.
    - Tokens are accepted only for connected parties behind the hub.
    - Pushed updates apply, an older update is ignored, and a mismatched or non-hub update is refused.
    - A hub cannot limit another partner's session.
    - A refresh forgets a party that has left the hub.
  - The console views, and every result delivered through the outbox.
- **TypeScript SDK and per-key rate limits: 23/23 checks** (`npm run e2e:sdk`), using the built SDK against the running API with a key limited to 20 requests a minute:
  - **Calls:** typed calls with path and query parameters; a CSV export as text; 404 and 403 as `PlugSureError`.
  - **The limit:**
    - the RateLimit headers on every answer;
    - a burst of 25 refused beyond the allowance with 429, `rate_limited` and Retry-After;
    - the SDK waiting about 3 s and succeeding;
    - the console session unaffected.
  - **The console:**
    - the key's usage in the last 24 hours and by hour;
    - a raised limit applying at once, and null restoring the default;
    - a fractional limit refused, and changes audited.
  - **Guessed keys:** 401, then 429, while a valid key from the same address keeps working.
  - **Webhooks:** a real delivery verified with the SDK, and a changed body refused.
- **Bidirectional charging over OCPP 2.1: 21/21 checks** (`npm run e2e:v2x`), with a raw OCPP 2.1 station with two DC EVSEs at a depot with 15 kW of auxiliary load:
  - **Setup:**
    - the programme's validation, and the PLN export warning;
    - the station registered and negotiated as 2.1;
    - a fleet's standing consent.
  - **A fleet car:**
    - its ISO 15118-20 needs (DC_BPT) Accepted;
    - asked to give back 11 kW (CentralSetpoint, setpoint −11000 W, its transaction, the load-management stack);
    - the export register and SoC recorded, with a 2.1 trigger reason accepted.
  - **An app driver:**
    - offered the choice, and a floor below the site's refused;
    - consent given, with the station told (NotifyAllowedEnergyTransfer);
    - the two cars then share the building's 15 kW, 7.5 kW each.
  - **Stopping:**
    - the fleet car at its floor goes straight back to charging while the other takes up the load;
    - the driver's withdrawal stops the discharge and tells the station DC only;
    - outside the hours no car discharges.
  - **Other messages from the station** are answered.
  - **The bill:** the fleet session billed 5 kWh with 3 kWh given back credited Rp 6,000 before tax.
- **Signed meter values (OCMF): 20/20 checks** (`npm run e2e:ocmf`), with raw OCPP 1.6 and 2.0.1 chargers and a meter key made by the test:
  - **Keys:** a malformed key refused; the raw point from a meter label stored as hex DER.
  - **1.6 (`SignedData` in StopTransaction):**
    - verified against the registered key and matching the 6 kWh bill;
    - the signed-data API, the Transparency Software XML and the receipt section.
  - **Problems:**
    - a reading changed after signing is `invalid` (warning, still billed);
    - 7 kWh signed against 6 kWh billed is `mismatch`, with both figures;
    - another meter's readings are `invalid`;
    - a missing start reading is `incomplete`;
    - no signing is not assessed under `record`.
  - **The `require` policy:**
    - sessions with no signed data, or with a mismatch, are parked without an invoice;
    - a verified session is billed;
    - an unknown policy is refused.
  - **2.0.1:**
    - `signedMeterValue` with the station's key gives `unverified_key`, never `verified`;
    - SetVariables switches signing on (the three variables);
    - 1.6 answers 409.
- **Sandbox over OCPP 2.0.1 and 2.1: 17/17 checks** (`npm run e2e:sandbox-2x`). Three virtual chargers are registered in a sandbox as 2.0.1 DC, 2.1 DC and 2.1 AC:
  - **Connection:** each comes online speaking its protocol, and its signing meter is registered.
  - **2.0.1:**
    - a card tap charges through TransactionEvents, with a string transaction id, and is billed;
    - the OCMF readings are `verified`;
    - remote start and stop work;
    - `SignReadings=false` stops signing.
  - **2.1 with the sandbox fleet's consent:**
    - DC_BPT and AC_BPT cars are each asked to give back 11 kW;
    - the export register rises and the SoC falls;
    - the session is billed with the credit (2000 IDR/kWh) and verified signed readings.
  - **2.0.1 and V2G:** the same fleet car on the 2.0.1 station is never asked to discharge.
- **White-label driver apps: 28/28 checks** (`npm run e2e:brand`), with a station of the operator and one handed to a second operator:
  - **Validation:** four bad fields are refused field by field; going live without an icon and a web address is refused.
  - **Icon:** non-square and too-small icons are refused; a 1024 px icon is stored. From it come a 192 px launcher, a 512 px maskable icon on the icon background, and a 1024 px App Store icon with no alpha.
  - **Preview:** the page is renamed (no "PlugSure" left), recoloured, and carries its icon and brand. The PlugSure app is unchanged. The manifest keeps the brand. Only `/app/` may be framed, by its own origin.
  - **Scope:**
    - the branded app lists only the operator's stations;
    - another operator's charger code and connector are named as another operator's;
    - a quote at another operator's charger is refused before any payment.
  - **Live:**
    - the address and fingerprint are normalised, and the version code cannot go down;
    - on the web address (Host), the app, manifest, push worker and station scope work without `?brand=`;
    - Digital Asset Links and the Apple app-site association are served there, and nothing on PlugSure's own address;
    - the TLS check allows the brand's address only.
  - **Kit:** the zip's Android project, iOS shell, icons and listings match the brand; the one warning is the missing notifications key.
  - **Removal and audit:** a live app needs confirmation; the audit trail is written; once removed, the address no longer serves the brand.
- **Live Activities: 14/14 checks** (`npm run e2e:live-activity`), through the gateway's pass and a stand-in APNs:
  - **Registration:** refused from the PlugSure app, for a bad token, or for someone else's charge.
  - **Updates:** the first at once (liveactivity type and topic, priority 10, the content-state the app decodes, a stale date); nothing while nothing changes; a real change after 30 s at priority 5.
  - **Push-to-start** for a charge started without the app: attributes, alert and ref, sent once only; the app's token then updated like the others; the console counts.
  - **The end:** "finished" at once, then the end with the rated cost and a 30-minute dismissal date, nothing after.
  - **Dismissed and closed:** a dismissed activity (410) dropped; one closed on the phone ended.
- **Native iOS notifications (APNs), with badges and rich notifications: 20/20 checks** (`npm run e2e:apns`), against a stand-in APNs on the ports the stack is told Apple is at:
  - **Rich and badge:**
    - the site as subtitle over the detail, the receipt button's category and target, a picture for the service extension;
    - badge 1 with an unpaid session, and a badge-only update (0) once it is paid, which shows and replaces nothing;
    - the signed picture served (720 × 360), with forged or other-session addresses refused;
    - "your turn" time-sensitive, with its button.
  - **The key:** refused before the Team ID and bundle id are set; a bad Key ID, a non-key and an RSA key refused with reasons; a wrong key stored but shown as refused; the right key accepted by a check that notifies nobody, and never sent back.
  - **Registration:** refused for the PlugSure app and for a malformed token; one subscription per iPhone, in its language.
  - **Delivery through the real enqueue path and the gateway worker:**
    - topic, alert type, collapse id, the screen to open, and priority 5 (normal) or 10 (the queue);
    - an Xcode token found on the development server and remembered;
    - an uninstalled app's token (410) dropped.
  - **Refused key:** flagged in the console while sending, the message kept for retry, the phones not blamed; "Check with Apple" clears it.
  - **Removal:** new iPhones cannot register; the changes are audited; removing only the key keeps the iPhones (a new key reaches them), deleting the app drops them.
- **Field conditions end-to-end: 147/147 checks** (`npm run e2e:field`). The run
  includes the commission statement, cross-checked against the session
  explorer's own subtotals, and the platform operator's plan, billing-model and
  finalise flow (see
  `docs/GAP-ANALYSIS-v1.3.md`). This includes alert routing end to end, against a
  local SMTP server and a fake WhatsApp Cloud API, with the real transports:
  - test messages
  - fault → e-mail + WhatsApp template
  - a rejected number logged as failed
  - a repeat fault not re-sent
  - escalation, acknowledge, auto-resolve and "resolved" messages
  - the 2.0.1 device model (19b): a report in two parts, the first before the station answers the request; bad values, a security variable, a read-only one and a value outside the list refused before anything is sent; accepted and RebootRequired answers stored; GetVariables; a monitor added on EVSE 1, the station's monitors listed and one cleared; the over-temperature alert resolving when the event is cleared; a 1.6 charger refused
  - alerting follow-ups (24b), with a fake SMS gateway and signed Meta status callbacks: a rule to whoever is on duty; WhatsApp refusing the on-duty person's number → SMS to the same person, linked in the log; an override moving duty; delivered and read recorded; a late "failed" from Meta → SMS to the contact's SMS number; forged signature 401, unknown webhook 404, verify token checked; the callback URL on the public address; deleting a rota clears it from rules
  - a second site with its own 1440-minute offline threshold raising no alert while the fleet default (1 minute in the test) does
- 11 new unit tests for alerting: rota rotation (weekly, daily, wrap-round, before the first shift), overrides (latest wins), local-time handover across time zones, the SMS text, SMS channel settings and Meta signature checks.
- **Driver app end-to-end: 48/48 checks** (`tools/e2e/driver-e2e.mts`) on the split
  deployment. An operator sets up a charger in the console, then a driver finds it,
  pays by QRIS (mock), and charges; remote start through the bridge took 8 ms. The
  driver then stops the charge and gets the tax receipt, with the refund of the
  unused balance. The run also covers fleet sign-in with a console-issued PIN, the
  energy limit, the PIN lockout, and a maintenance hold. A raw **OCPP 2.0.1 station**
  runs the same journey end to end (RequestStartTransaction → TransactionEvent
  Started/Updated → driver stop → RequestStopTransaction → Ended → rated receipt).
  The station's transaction id is a non-numeric string; the test confirms it
  arrives verbatim. With the pre-fix code restored, the same test fails: the
  station receives `"NaN"`.
- **End-to-end: 96/96 checks** (`tools/e2e/console-e2e.mts`) against the real
  **split deployment** (`api.js` + `gateway.js` as separate processes, connecting as
  the non-superuser `plugsure_app` role so row-level security is enforced), with the
  bundled Autel simulator and a raw OCPP 2.0.1 station. Covers every module:
  onboarding to "Hardware Connected & Adopted", cockpit (unlock round-trip 10 ms),
  config studio, RFID + SendLocalList, DLM guardrail and genset curtailment, tariffs
  (Rp 2,850 peak refused), a session stopped by a 1 kWh preset and billed, the tax
  receipt (DPP / PPN / PBJT-TL arithmetic checked to the rupiah), FOTA through to
  **Verified**, diagnostics upload and viewer, 2.0.1 command translation, and RBAC.
- Same suite against the **single-process** build: 93/94 — the only difference is
  the check that the API↔gateway bridge is engaged, which single-process mode does
  not use by design.
- The console was loaded against the real API: all 15 modules and their detail
  drawers render with no script errors.

Defects found and fixed during this verification (all in this package):
1. **Site Host role could not use the console** — list endpoints required an
   organisation-wide grant before filtering to the user's sites, so a site-scoped
   Site Host got 403 on their own sites, fleet and sessions. Lists now accept the
   permission in any scope and filter by visible sites (`assertCanAny`); compliance
   is filtered too, and org-wide alert counts are withheld from site-scoped users.
2. A 2.0.1 charger with a long model name was refused at BootNotification
   (1.6 tolerated it); now tolerated and recorded identically.
3. Background dispatch (control loop after a budget change, genset curtailment,
   the activation boot trigger) ran inside the request transaction — a failure
   there would silently roll back the operator's change. It now runs after commit.
4. The audit-chain test harness still used `DELETE FROM audit_head`, which
   migration 004's anti-tampering trigger forbids, so those suites had failed
   unnoticed since v1.2. Fixed; they now also prove the database refuses the
   attacks and that verification still catches a superuser who bypasses triggers.
5. Hardening: auto-adoption now defaults on only in development; a corrupt stored
   password hash fails the login instead of a 500; `create-admin` no longer
   duplicates a mixed-case email.

**Remaining before production:** run `docs/ACCEPTANCE-v1.3.md` on at least one
real charger (the simulator proves the protocol path, not the hardware), configure
TLS / Security Profile 2 behind Caddy, and contract a live QRIS acquirer and an
SMS/WhatsApp OTP provider before public paid charging. For roaming, run the
first partner's (or hub's) connection test against its test environment, and
agree the roaming tax treatment and settlement terms. The smaller code-review
items are fixed (see **Code-review follow-ups**).
