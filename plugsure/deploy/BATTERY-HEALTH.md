# EV battery health (v1.48.0)

**Assets & energy → Battery health.** For fleet vehicles, from their own charging.

## What it needs

- **The vehicle** in Depot charging, with its **charging card** (to find its sessions) and its **battery size** (kWh).
- **The state of charge** at the start and the end of a charge: from the car over OCPP (the `SoC` measurand; most DC
  chargers send it), or else from the fleet's telematics (Depot charging → Telematics), the reading closest to the
  start and to the end, within 30 minutes.

## How it is estimated

For each charge that gained at least 20 points of charge: usable capacity ≈ energy delivered × 0.92 (charging losses)
÷ the share of the battery gained. The state of health is the median of the last 90 days' estimates against the battery
size; the degradation per year is the trend of every estimate over at least 30 days.

These are estimates from charging, not the car's own battery management figures. One charge says little; the trend over
many charges is what to read. Very cold or very hot batteries, AC charging that tapers and wrong battery sizes all move
the numbers.

## Flags and the alert

| Flag | Meaning |
|---|---|
| capacity drop | an estimate 10 % below the vehicle's recent median |
| slow charging | the peak power under 60 % of its usual on fast chargers |
| low health | under 75 % of the battery size |
| not used | above 130 % of the battery size (usually a wrong battery size or SoC) |

A capacity drop or slow charging raises `vehicle.battery_anomaly` for the vehicle: worth a look by the fleet's
workshop.
