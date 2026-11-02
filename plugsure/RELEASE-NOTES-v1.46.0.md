# PlugSure CSMS v1.46.0: release notes

**Date:** 2 November 2026
**Base:** v1.45.0.

v1.46.0 is phase 34. It adds four features:
- a field app for technicians;
- residential and workplace charging, with a page for the building or office manager;
- number-plate cameras and parking;
- a trip planner in the driver app.

- **Migration:** one, 113. It is additive. It adds:
  - eleven tables;
  - nine columns on `work_order` (who, when, the checklist, arrival, signature);
  - four on `site` (the parking rules).
- **When nothing changes:** there are no checklists, private groups or cameras. Work orders, the public map, OCPP
  authorisation and the driver app behave as before until they are set up.
- **New worker:** parking (every 5 minutes): links plate-started sessions to their stay and raises `parking.overstay`
  for a car parked longer than its site allows. It acts only at sites with cameras.
- **Guides:**
  - [`deploy/FIELD-APP.md`](deploy/FIELD-APP.md)
  - [`deploy/PRIVATE-CHARGING.md`](deploy/PRIVATE-CHARGING.md)
  - [`deploy/PLATES-PARKING.md`](deploy/PLATES-PARKING.md)
  - [`deploy/TRIP-PLANNER.md`](deploy/TRIP-PLANNER.md)

## New

### Technician field app

**Maintain → Field**, built for a phone.

- **Jobs:** the work orders assigned to me, and unassigned ones to take. Open and in progress first, then done in the
  last 7 days.
- **On site:** directions, *I have arrived* (the job is in progress), the charger as it is now (online, connectors,
  errors, open alerts) and *Check now*, which asks the charger for a fresh status and heartbeat.
- **Checklist:** from the job's template. Templates are set per kind of job (corrective, preventive, warranty) or
  per job. Required items must be ticked before the job can be finished.
- **Photos:** taken with the phone's camera, shrunk to 1600 px, JPEG, PNG or WebP up to 3 MB. The same photo sent twice
  is kept once; the file's type is checked against its content.
- **Parts:** issued from stock to the job (inventory), so their cost is the job's.
- **Finishing:** hours and notes, and the site contact's signature drawn on the screen. A template can require a
  photo and a signature.
- **Offline:** without a signal, changes wait on the phone and are sent when it is back. Each carries its own id, so
  it is applied once however often it arrives.
- **Office:** plan a job (the technician, the day, the checklist) and keep the checklists.
- **Permissions:** the *field technician* role works jobs (`charge_point:command`); planning and checklists need
  `charge_point:write`.

### Residential and workplace charging

**Assets & energy → Private charging.**

- **A group:** an apartment building's (units are flats) or an office's (units are teams or cost centres) chargers
  at a site.
- **Private chargers:** they leave the public map and the app does not sell them. At the charger, only a member's
  card is accepted (OCPP 1.6 `Authorize`/`StartTransaction`: other cards get `Blocked`).
- **Members:** a person in a unit with their card (a new card number is added to RFID cards) and, for the plate
  cameras, their plate. A card belongs to one member at a time.
- **Statements:** each month, per unit, the energy the unit's cards drew on the group's chargers × the group's rate
  (or the charge records' totals without a rate), plus a monthly fee. Draft, issue, mark paid or void; a spreadsheet
  per month. Billing can also be off (free to members).
- **The manager's page:** a secret link (`/building/<token>`, made and replaced from the console). The manager sees
  the units, this month's energy, the members (cards masked) and the statements, and adds or removes members and
  units. Their changes are in the audit log.

### Number-plate cameras and parking

**Assets & energy → Plates & parking.**

- **Cameras:** each posts its reads to its own address (`POST /v1/anpr/events/<key>`): plate, confidence, and the
  direction if it knows it. Reads below 60 % confidence are only recorded.
- **Stays:** an entry opens a visit, an exit closes it. A camera that sees both ways takes the direction from any
  open stay.
- **Known cars:** fleet vehicles (by plate) and residents or staff with a plate.
- **The barrier:** per camera, opened for known cars, everyone or never. PlugSure POSTs to the barrier controller's
  address through the outbound guard, with an optional Authorization header kept sealed.
- **The fee:** per site, a grace after charging ends, then a fee per started hour. Residents and staff do not pay it.
  Settle a stay as paid or waived.
- **Longest stay:** a car parked past it raises `parking.overstay` once.
- **Plate start:** at a site with it on, a known car with a card on file that arrived in the last 15 minutes starts
  charging when it plugs in (the connector reports *Preparing*). Only when exactly one such car is waiting, so the
  wrong card is never used.

### Trip planner

**Driver app → Stasiun → Rencanakan perjalanan.**

- From my location (or a station) to a station or coordinates, with the battery now, the car's range, its connector
  and the reserve to arrive with.
- Stops are real stations within 15 km of the way. The road distance is the straight line × 1.3 (no road map is used,
  so it is an estimate). Each stop shows the distance from the start, the battery on arrival, charging to 80 %, the
  minutes and kWh, and how many connectors are free now; it opens the station to reserve or queue.
- `POST /d/v1/trips/plan`. The car's settings are remembered on the phone.

## API

- **38 operations** (`src/api/openapi/catalogue/phase34.ts`), 951 in all: `/v1/field/*`, `/v1/private-groups*`,
  `/v1/private-statements/*`, `/v1/building/{token}` (the manager's link), `/v1/anpr/*`, `/v1/parking/visits*` and
  `/v1/sites/{siteId}/parking`.
- **Public, with their own keys:** the camera webhook and the manager's page.
- The SDK is regenerated (1.46.0).

## Upgrading

1. Run migration 113 (`db/migrations/113_field_private_anpr.sql`; rollback `db/rollback/113_down.sql`).
2. Deploy. Nothing else is required.
3. Optional: see `deploy/README.md` item 39.

## Tests

- `src/services/phase34.db.test.ts`: the parking fee; the trip planner; a field job from the checklist to the
  signature, with an offline change applied once; a private group (only members' cards, off the public map,
  statements, the manager's link); cameras (entry, barrier, exit with the fee, low confidence, settling, overstay).
- The least-privilege test covers the new tables.
- The driver app's and the driver API's English cover the new messages.
