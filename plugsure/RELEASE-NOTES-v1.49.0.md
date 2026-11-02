# PlugSure CSMS v1.49.0: release notes

**Date:** 2 November 2026
**Base:** v1.48.0.

v1.49.0 is phase 37. It adds four features:
- two-wheeler battery swap: cabinets, packs, riders' plans paid from credit, and the cabinets' own API;
- mobile and roadside charging: vans dispatched to cars, paid from credit and on site;
- warranty and RMA for chargers;
- accessibility and site amenities: shown and filtered in the driver app, with drivers' reports.

- **Migration:** one, 116. It is additive: thirteen tables.
- **When nothing changes:** battery swap and roadside charging are off until turned on. No warranties, cases or
  amenities exist until recorded. The app's station list gains only `amenities` and `accessible`.
- **New workers:**
  - battery swap, every 5 minutes: plan renewals, cabinets not reporting;
  - roadside, every minute: requests waiting for a van;
  - warranty, every 6 hours: warranties ending, RMA cases waiting.
- **Guides:**
  - [`deploy/BATTERY-SWAP.md`](deploy/BATTERY-SWAP.md)
  - [`deploy/ROADSIDE.md`](deploy/ROADSIDE.md)
  - [`deploy/WARRANTY-RMA.md`](deploy/WARRANTY-RMA.md)
  - [`deploy/AMENITIES.md`](deploy/AMENITIES.md)

## New

### Two-wheeler battery swap

**Assets & energy → Battery swap.**

- **Cabinets**: at a site, with their slots. Each controller posts to its own address with its key:
  - its slots' status (each pack's serial, charge, health, temperature, fault);
  - an authorisation before it opens a door;
  - each swap done, idempotent by the cabinet's reference.

  The page shows each cabinet online or not reporting, with its packs ready and charging.
- **Packs**: every pack, wherever it is (a cabinet slot, a rider, maintenance, retired), with its charge, health and
  cycles. Packs reporting a fault, or below the retirement health, raise `swap.battery_attention`.
- **Plans**: a monthly fee with swaps included (or unlimited, or pay per swap). Riders subscribe in the app, which shows
  their rider code (Akun → Tukar baterai motor).
- **Paying**: a swap within the plan is included. Beyond it, it costs the price per swap, paid from the rider's credit.
  Without enough credit the swap is refused. The monthly fee is paid from credit at subscribing and at each renewal;
  without enough credit, the plan lapses.
- **The swap log**: the packs in and out, their charge, the energy taken, included, paid or refused (and why).

### Mobile and roadside charging

**Operate → Roadside.**

- **Requests**: from the app (Akun → Isi daya darurat: location, energy, connector, a landmark; the estimated cost shown
  first) or taken by phone. Each is quoted at the call-out fee plus the kWh at the price per kWh. A request outside
  every van's service radius is refused.
- **Dispatch**: the vans that can go, nearest first, with their distance, ETA and energy left. One request per van.
  The request moves on through on the way, charging and done. A request waiting 10 minutes without a van raises
  `roadside.unassigned`.
- **Paying**: the call-out fee plus the kWh delivered, from the driver's credit as far as it goes. The rest is collected
  on site (cash, QRIS, a card terminal) or invoiced.
- **The app**: the request's progress (the van, the ETA, the distance), refreshed every 15 seconds, a button to call the
  crew, and a cancel button until the charge starts.

### Warranty and RMA

**Maintain → Warranty & RMA.**

- **Warranties**: per charger, with the supplier, the dates, what is covered (parts, labour, shipping, on-site), the
  reference and extensions. Each charger is covered, ending soon (60 days), expired or without a warranty.
  `warranty.expiring` is raised once per warranty.
- **RMA cases**: a charger or a part returned. Its warranty status is worked out from the charger's warranty on the day.
  It goes through requested, approved (the manufacturer's RMA number), shipped (tracking), replaced (the replacement's
  serial) and closed, or rejected (the reason), with its history. Out of warranty, the manufacturer's charge is recorded.
  `rma.stale` is raised when a case waits on the manufacturer for 14 days. The money recovered stays on the work order's
  warranty claim, as before.

### Accessibility and site amenities

**Assets & energy → Amenities & access.**

- **Amenities** (toilets, prayer room, food, shop, Wi-Fi, shade, lighting, security, lounge, free parking) and the hours.
- **Accessibility**: accessible bays, a step-free route, the bay width, the cable reach and the height of the controls.
  These make a score of 5. A site with an accessible bay and a step-free route is accessible.
- **The driver app**: stations show their amenities and accessibility, the station list filters on them, and drivers
  report problems from the station. Each report raises `access.report`, which is resolved here.

## API

- **34 operations** (`src/api/openapi/catalogue/phase37.ts`), 1054 in all:
  - `/v1/battery-swap*`;
  - `/v1/roadside*`;
  - `/v1/warranty*`, `/v1/warranties*`, `/v1/rma*`;
  - `/v1/site-amenities`, `/v1/sites/{id}/amenities`, `/v1/accessibility-reports*`.
- **Public, with each cabinet's own key:** the cabinets' API, `POST /v1/swap/cabinets/{key}`.
- **Driver API:**
  - `GET /d/v1/swap`, `POST /d/v1/swap/subscription`;
  - `GET /d/v1/roadside`, `POST /d/v1/roadside/requests`, `POST /d/v1/roadside/cancel`;
  - `POST /d/v1/sites/{siteId}/accessibility-reports`;
  - on `/d/v1/stations`, `amenities` and `accessible`, filtered by `amenities=`.
- The SDK is regenerated (1.49.0).

## Upgrading

1. Run migration 116 (`db/migrations/116_swap_roadside_rma_amenities.sql`; rollback `db/rollback/116_down.sql`).
2. Deploy. Nothing else is required.
3. Optional: see `deploy/README.md` item 42.

## Tests

`src/services/phase37.db.test.ts` covers:
- battery swap: the cabinet's key and status, a plan paid from credit, swaps included, then paid, then refused,
  idempotency, the packs' movements, the pack alert, the lapse;
- roadside: the quote, the radius, the nearest van, the waiting alert, one request per van, done paid from credit with
  the rest collected;
- warranty and RMA: coverage, a case in warranty, each step's field, the stale and expiring alerts;
- amenities: the score, the app's filter, a driver's report and resolving it.

The least-privilege test and the English for the driver app and the driver API cover the new tables and messages.
