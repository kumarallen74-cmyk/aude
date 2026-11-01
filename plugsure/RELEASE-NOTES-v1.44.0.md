# PlugSure CSMS v1.44.0: release notes

**Date:** 1 November 2026
**Base:** v1.43.0.

v1.44.0 is phase 32. It adds four features:
- fleet depot scheduling;
- driver queue improvements;
- carbon per session and site;
- a diagnostics bot.

- **Migration:** one, 111. It is additive. It adds three tables (`fleet_vehicle`, `session_departure`,
  `diagnostic_run`), three columns on `site` (`depot_scheduling`, `queue_priority`, `grid_kg_per_kwh`) and one on
  `driver_queue_entry` (`priority`).
- **When nothing changes:** depot scheduling is off on every site, there is no priority lane, and sites have no grid
  factor of their own, so the organisation's default applies as before. The bot only runs when someone starts it. The
  estimated waits and the receipt's CO₂ line are shown wherever the queue or the receipt already was.
- **Guides:**
  - [`deploy/DEPOT-CHARGING.md`](deploy/DEPOT-CHARGING.md)
  - [`deploy/DIAGNOSTICS-BOT.md`](deploy/DIAGNOSTICS-BOT.md)
  - [`deploy/FINANCE.md`](deploy/FINANCE.md), *Carbon per session and site*
  - [`deploy/README.md`](deploy/README.md), *Driver queue*

## New

### Fleet depot scheduling

**Assets & energy → Depot charging.**

- **Vehicles:** each has a card, a battery size, a usual departure and a target (kWh, or a state of charge). A session
  started with the card gets the vehicle's next departure.
- **Where a departure comes from:** one set in the console first, then the car's own OCPP 2.x charging needs, then the
  vehicle's.
- **The plan:** at a depot site, every control-loop run plans each session with a departure:
  - *ready:* held at its minimum;
  - *on track:* at least the power it needs, with the tighter deadlines first;
  - *deferred:* waits for off-peak when the off-peak hours are enough;
  - *at risk:* full power, first;
  - *missed:* charged first.
- **Ready by:** the page shows each session's estimated ready time and whether it is late.
- **Alert:** `fleet.vehicle_not_ready` is raised once when a session turns at risk, and resolved when it is ready.

### Driver queue improvements

- **Estimated wait:** every place in the queue has one. It is based on the site's typical session over 30 days and how
  long each busy connector has been charging. It is shown:
  - in the driver app (*Perkiraan X menit*);
  - on the station, for a new driver;
  - on the public status page ("N waiting · about X min").
- **Priority lane:** set per site, for fleet cards, subscription members, or both. Those drivers join ahead of the
  others, in the order they joined.
- **Analytics:** Sites → Queue shows the last 30 days:
  - joins and charges from the queue;
  - no-shows and abandonment;
  - the median and 90th-percentile wait;
  - the priority lane's share and wait;
  - joins by hour.

  `GET /v1/sites/{siteId}/queue/analytics` and `GET /v1/queue/analytics` give the same data.

### Carbon per session and site

This extends the v1.35.0 carbon module.

- **Grid factors:** a session's grid factor is the site's own, else its province's (by BPS code, set under Emission
  factors), else the default.
- **Solar:** the share of the session's energy that the site's energy box measured coming from solar, during the
  session, counts as zero emissions.
- **Per site, measured** (Finance → Carbon): kWh, factor and source, solar share, and CO₂e emitted and avoided, over up
  to 92 days.
- **ESG report:** an Excel workbook with Summary, Sites and Methodology sheets. Without dates, both cover the last 30 days.
- **Receipt:** the driver's receipt shows the CO₂ avoided against petrol.
- **API:** `GET /v1/sessions/{id}/carbon`.

### Diagnostics bot

**Maintain → Charger health → a charger → Diagnostics.**

- **What it reads:** the connection, 7 days of error codes (explained from the OCPP 1.6 list), reboots and refused
  calls.
- **What it asks:** when the charger is connected, a fresh status and heartbeat, and its key configuration, flagging
  any value outside its usual range.
- **Soft reset:** only when allowed, a connector is Faulted and nothing is charging. It then waits for the fault to
  clear.
- **Never:** a configuration change or a hard reset.
- **Result:** a verdict (healthy, fixed, needs attention, needs a visit, unreachable) and a summary of what to do. A
  corrective work order can be opened from it, automatically or by hand.

## API

There are 15 new operations, 883 in all. See `src/api/openapi/catalogue/phase32.ts`.

## Upgrade

1. Run migration 111 (`npm run migrate`).
2. Restart the API and the gateway.
3. Nothing to configure.

Rollback: `db/rollback/111_down.sql`.
