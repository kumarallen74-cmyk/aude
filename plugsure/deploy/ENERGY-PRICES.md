# Energy market prices (v1.47.0)

**Assets & energy → Energy prices.** Prices per period from a market (day-ahead) or a time-of-use contract, and
charging moved away from the expensive periods.

## Price zones

*Add a price zone*: its currency, and where its prices come from:

- **Imported:** *Import* takes JSON (`[{start, price, minutes}]`, or `{prices: […]}`) or CSV (`start,price[,minutes]`
  per line). Prices are per kWh in minor units; per MWh, add `"per": "MWh"` to each object. Periods are 15, 30 or 60
  minutes (default 60). A period already held is replaced. Two years are kept.
- **Fetched:** an `https` address answering the same JSON or CSV, fetched every hour (and with *Fetch now*), with an
  optional Authorization header (stored sealed). The address goes through the outbound guard. A failed fetch is shown
  on the page; the prices already held stay.

## Shifting charging to cheap hours

Per site (click it under *Sites*): its zone, *Shift charging to cheap hours*, the share of the grid budget it keeps in
an expensive period (default 50 %), and when a period is expensive: at or above a price, or (empty) in the day's most
expensive quarter of periods in the site's time zone. A day where every period has the same price has no expensive
periods.

While a period is expensive the load manager gives the site that share of its grid budget. On-site solar and battery
are added as usual; sessions with a departure (Depot charging) still get the minimum their departure needs; demand
response events apply first. Without a price for now, or if the prices cannot be read, the site has its usual budget.

## Savings

Per site and month: the energy each hour (each session spread over the hours it ran) × that hour's price, against the
same energy at the month's average price. It shows what the timing of charging saved (or cost); it is an estimate from
the sessions, not the supplier's bill.
