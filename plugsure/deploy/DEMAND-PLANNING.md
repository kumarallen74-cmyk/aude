# Demand & planning (v1.45.0)

**Assets & energy → Demand & planning** (`site:read`; candidates need `site:write`).

## How busy each site is

For each hour of the week (Monday 00:00 to Sunday 23:00, in the site's time), over the last 8 weeks:

- **occupancy:** connector-hours spent charging ÷ connector-hours available;
- **sessions** started;
- **kWh.**

Recent weeks count more: each week back weighs 0.85 of the one after.

The heatmap shows a single site or all sites together. Hover a cell for its figures.

## The forecast

The next 1 to 14 days, hour by hour: each hour's profile × the trend. The trend is sessions in the last 4 weeks ÷ the
4 weeks before, held between 0.7 and 1.5, and taken as 1 when there is too little history.

It is a seasonal average. It says when a site is likely to be busy, not exactly how busy.

## Advice per site

- **add N connectors:** busy 80 % or more for 10 hours a week or more, or 10 or more drivers turned away by the queue
  (left, expired or missed) in 30 days. N is enough to bring the busiest hour to 70 %.
- **under-used:** used less than 5 % of the time.

## Candidate sites

Add the places you are considering, with their coordinates, connectors and power. Each is scored 0–100:

| Part | Weight | What it measures |
| --- | --- | --- |
| Demand | 50 % | Sessions at your sites in the last 30 days, each weighted by distance (halving every 2 km), against the best candidate's |
| Gap | 30 % | How far your nearest site is; 10 km or more counts fully |
| Pressure | 20 % | How busy your sites within 5 km are at their busiest hour |

Each score comes with an estimate of sessions a day: a tenth of the nearby daily demand, scaled by the connectors
planned, at most 8 a connector.

Sites need a map position (Sites → Edit) to count. Without any, scores only measure new ground.

## API

- `GET /v1/demand/sites`
- `GET /v1/demand/forecast?siteId=&days=`
- `GET`, `POST /v1/demand/candidates`
- `PUT /v1/demand/candidates/{id}`
