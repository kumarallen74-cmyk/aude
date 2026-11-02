# PlugSure CSMS v1.48.0: release notes

**Date:** 2 November 2026
**Base:** v1.47.0.

v1.48.0 is phase 36. It adds four features:
- hotels: guests charge on their room, and staff start cars from a valet page;
- an installation pipeline, from survey to live;
- data privacy under UU PDP: requests, consents, an inventory and retention;
- EV battery health for fleet vehicles.

- **Migration:** one, 115. It is additive: eleven tables.
- **When nothing changes:** there are no hotels, projects or privacy settings, and battery health only reads sessions
  of fleet vehicles with a card. Nothing is cleared until a retention is set.
- **New workers:**
  - hotels, every minute: sessions found, then posted to the folio or put on the statement;
  - battery health, every 15 minutes;
  - privacy, hourly: retention, and requests due;
  - installations, every 6 hours: projects past their target.
- **Guides:**
  - [`deploy/HOTELS.md`](deploy/HOTELS.md)
  - [`deploy/INSTALLATIONS.md`](deploy/INSTALLATIONS.md)
  - [`deploy/PRIVACY.md`](deploy/PRIVACY.md)
  - [`deploy/BATTERY-HEALTH.md`](deploy/BATTERY-HEALTH.md)

## New

### Hotels

**Commercial → Hotels.**

- **A hotel at a site.** Its charges go either to the guest's folio in the hotel's PMS (POSTed to its address, signed
  `X-PlugSure-Signature`, retried with back-off; `hotel.post_failed` after 10 failures) or onto a monthly statement to
  the hotel.
- **Guests:** checked in from the console, or by the PMS posting check-ins, check-outs and room moves to its own
  address. Each stay gets its own guest card, retired at check-out. One guest in house per room.
- **The valet page:** a secret link, `/valet/<token>`, for the hotel's staff. It shows the connectors and who is
  charging. Staff plug a car in, choose the room and start, or stop a car. Rooms are shown by the guest's initial only.
  Starts and stops are in the audit log.
- **Charges:** every session of a stay's card. When it ends, the charge record's total goes to the folio or to the
  statement (a spreadsheet per month).

### Installation pipeline

**Assets & energy → Installations.**

- **Stages:** survey, design, permits, grid (the PLN connection), install, commission, live (or cancelled), shown as a
  board.
- **Tasks:** each stage starts with its usual tasks (the PLN application, the SLO inspection, a test charge on every
  connector, …), which can be edited. A stage's required tasks must be done before the project moves on. Every move is
  recorded with who did it and a note.
- **Documents:** survey reports, drawings, permits, the PLN letter, photos, commissioning reports. PDF, images, Word,
  Excel or DWG, up to 15 MB; the file type is checked.
- **Links:** the candidate site it came from, its capex project (budget, spent and committed) and the site it
  becomes. Going live needs that site.
- **Overdue:** a project past its target go-live date raises `install.overdue`, at most once a week. It is resolved
  when the project goes live.

### Data privacy (UU PDP)

**Govern → Privacy.**

- **Requests:** access, a copy (export), correction, erasure or objection. They come from the app (already verified:
  the driver is signed in) or are recorded in the console (found by phone number). Each is due within the response
  time (default 72 hours, 3 × 24).
- **Handling a request:** verified (how the person's identity was checked), then completed or rejected with the
  reason.
  - The copy is a JSON of the person's data.
  - A correction changes the account's name or e-mail.
  - An erasure deletes the account as the app's own deletion does; it is blocked while a charge is unpaid or running.
  - An objection withdraws consents.
- **Consents:** marketing, analytics and location, set by the driver in the app (Akun → Data pribadi). Every grant and
  withdrawal is kept.
- **Inventory:** each category of personal data: what, where, why, the legal basis, the retention and how many
  records.
- **Retention:** plates (camera reads and finished parking stays), survey comments and closed support cases are
  cleared after the days set.
- **Alert:** `privacy.request_due` when a request is due within a day.

### EV battery health

**Assets & energy → Battery health.**

- **Per charge:** for fleet vehicles with a card and a battery size, from their own charges. The state of charge at
  the start and the end comes from the car over OCPP, else from telematics. With 20 points or more gained, the usable
  capacity ≈ energy × 0.92 ÷ the share gained. The peak power is recorded too.
- **Per vehicle:** state of health is the median of the last 90 days against the battery size. The page shows the
  monthly medians and the degradation per year.
- **Flags:**
  - `capacity_drop`: 10 % below the vehicle's recent median;
  - `slow_charging`: under 60 % of its usual peak on fast chargers;
  - `low_health`: under 75 %;
  - `implausible`: the estimate is not used.

  A capacity drop or slow charging raises `vehicle.battery_anomaly`.

## API

- **35 operations** (`src/api/openapi/catalogue/phase36.ts`), 1020 in all:
  - `/v1/hotels*`, `/v1/hotel-stays/*`, `/v1/hotel-charges/*`;
  - `/v1/installations*`;
  - `/v1/privacy/*`;
  - `/v1/battery-health*`.
- **Public, with their own keys:** the PMS webhook and the valet page.
- **Driver API:** `POST /d/v1/privacy/requests`, `GET/PUT /d/v1/privacy/consents`.
- The SDK is regenerated (1.48.0).

## Upgrading

1. Run migration 115 (`db/migrations/115_hotels_installs_privacy_battery.sql`; rollback `db/rollback/115_down.sql`).
2. Deploy. Nothing else is required.
3. Optional: see `deploy/README.md` item 41.

## Tests

`src/services/phase36.db.test.ts` covers:
- hotels: stays, the PMS, a signed folio post, the statement, the valet;
- installations: tasks gating the stages, documents, live, cancel, overdue;
- privacy: verification, the copy, correction, objection, erasure, the app's request and consents, retention, the due
  alert;
- battery health: estimates from SoC meter values, a capacity drop raising the alert, the fleet view.

The least-privilege test and the English for the driver app and the driver API cover the new tables and messages.
