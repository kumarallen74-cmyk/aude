# The trip planner (v1.46.0)

**Driver app → Stasiun → Rencanakan perjalanan** (or `#trip`).

The driver chooses where from (their location, or a station) and where to (a station, or coordinates), the battery
now, the car's range on a full battery, its connector and the reserve to arrive with. The app remembers the car.

## How the stops are chosen

- The road distance is the straight line × 1.3. No road map is used, so distances are estimates; the stops are the
  network's real stations.
- Stations count when they are within 15 km of the straight line, have the car's connector (if one is chosen) and are
  publicly listed (not private chargers). A white-label app plans with its operator's stations only.
- From the start, among the stations the car reaches with the reserve left, the one that takes it furthest, preferring
  free and fast ones; it charges to 80 % (above that, at half speed), and so on, up to 8 stops.
- If no station is within reach, the plan says how far the car gets.

Each stop opens its station, to reserve or join the queue there.

## API

`POST /d/v1/trips/plan` with `{from: {lat, lon}, to: {lat, lon}, socPct, rangeKm, batteryKwh?, carMaxKw?,
reservePct?, connectorTypes?, minPowerKw?}`.
