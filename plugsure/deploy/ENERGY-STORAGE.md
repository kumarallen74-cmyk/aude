# Solar and battery storage at a site (v1.42.0)

A site can record its solar inverter(s) and battery storage. When it does, PlugSure:

- shows what they produce and save;
- lets the site's load manager use **measured** solar output and battery discharge on top of the grid connection;
- tells the battery what to do next (a **set-point**).

Set it up in **Assets → Solar & storage**. It needs the `site:write` permission; reading needs `site:read`.

## 1. Record the assets

- **Solar:** the inverter's AC capacity in kW (this caps what is counted) and, optionally, the panels' kWp.
- **Battery:** its power in kW, its usable energy in kWh, and the state-of-charge band to keep it in (10 % to 95 % by
  default).
- Optionally, the commissioning date and the cost (used for the payback figure).

## 2. The site's settings

| Setting | Default | What it does |
|---|---|---|
| Solar first | on | count measured solar output for the chargers |
| Peak shaving | off | keep the grid import under a target. Needs the target in kW. The battery covers the rest. |
| Trust | 80 % | the share of the measured solar and battery power that is counted, a margin for a passing cloud |
| Maximum age | 120 s | a reading older than this is ignored: the load manager falls back to the grid budget alone |

The load manager adds solar and battery power **only from a fresh reading**. It never adds a forecast, and it never goes
over the inverter's or the battery's installed power. When no recent reading has arrived, the site runs exactly as it did
before. PLN curtailment and the site's reserve still apply first.

## 3. Connect the energy box

The site's energy management system, inverter gateway or a small box on site (Modbus/SunSpec → HTTPS) posts readings to
PlugSure. Make a key with **Site key** on the site's card. It is shown once; making a new one stops the old one.

```
POST /v1/energy/sites/<siteId>/readings
Authorization: Bearer pse_…            (or X-Site-Key: pse_…)
Content-Type: application/json

{ "ts": "2026-11-01T10:15:00+07:00", "solarW": 18400, "batteryW": 5200, "batterySocPct": 64, "gridW": 21000 }
```

- `solarW`: solar output now (W, ≥ 0).
- `batteryW`: battery power. **Positive means discharging into the site**, negative means charging.
- `batterySocPct`: the battery's state of charge, from 0 to 100. Without it, no set-point is given.
- `gridW`: the grid import (negative means export). Optional; used for the figures.
- Several readings at once: `{ "readings": [ … ] }`, up to 500, for catching up after a network outage. `ts` must be
  within the last seven days. A repeated `ts` is ignored, so retries are safe.
- Post every 15 to 60 seconds. At most 120 posts a minute per site are accepted.

The answer carries the set-point for the battery:

```
{ "accepted": 1, "duplicates": 0,
  "setpoint": { "batteryW": 7000, "mode": "discharge", "reason": "the chargers want 60 kW; the grid part is 45 kW", "gridPartW": 45000, "demandW": 60000 } }
```

`batteryW` is positive to discharge and negative to charge. It always stays inside the battery's power and SoC band.

- **discharge:** the chargers want more than the grid part plus solar (peak shaving).
- **charge_solar:** solar the chargers do not use.
- **charge_offpeak:** charging from the grid off-peak (the site's tariff hours), while the grid part has room.
- **idle:** nothing to do, the battery is full or empty, or there is no recent state of charge.

The box may follow the set-point or not: the load manager only counts what the battery actually reports discharging.

## 4. Results

**Results** on a site's card shows, per day:

- solar produced, used on site and exported;
- grid import;
- battery in and out (and how much of the charge came from the grid);
- self-consumption;
- the peak grid power, against what it would have been without the battery;
- the savings at the site's energy tariff: solar used, plus battery discharge, less the cost of charging the battery from
  the grid.

Readings are kept for 400 days.

## Rollback

`db/rollback/109_down.sql` drops the tables. The load manager then uses the grid budget alone, as before.
