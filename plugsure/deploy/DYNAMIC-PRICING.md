# Dynamic pricing (v1.43.0)

Dynamic pricing moves the energy price with the time of day, the grid's peak hours, how busy a site is, or how much solar it
produces. It is set up under **Commercial → Dynamic pricing**. Viewing it needs `tariff:read`; changing it needs
`tariff:write`.

## Rules

Each rule applies to one site or every site and changes the price by −50 % to +50 % when it matches:

- **At these times:** on chosen days, between two hours in the site's own time zone (22 to 6 runs overnight);
- **In the grid's peak hours:** the peak hours of the site's energy tariff (Finance → Energy tariffs; 17:00–22:00 by
  default);
- **When the site is busy:** at least X % of its connectors are in use;
- **When solar is producing:** the site's solar output is at least X kW. This needs a fresh reading from its energy box
  (Assets → Solar & battery).

Matching rules add up. The result stays between the **floor** and the **cap** (80 % and 130 % of the tariff by default).
Nothing changes until dynamic pricing is switched on in Settings.

## What moves and what never does

- **Moves:** the energy rate, and the per-minute time fee unless that is switched off.
- **Never moves:**
  - session, admin and idle fees;
  - an energy band at the PLN formula rate;
  - roaming partners' sessions, which are priced on the tariffs published to them.
- **The regulated energy ceiling:** an increase is held at the ceiling, so a dynamic price never puts a session above it.

## What drivers see and pay

- **Before starting:** the driver app shows each site's price now: in the map list, on the connector page (with "the price
  right now is X % above/below the tariff"), and in the pre-paid quote.
- **During the charge:** a session is priced at the factor in force when it started, for its whole charge.
- **Pre-paid charges:** the energy a payment buys is computed at the factor when the driver paid, and its session is billed
  at that same factor.
- **Kept factors:** each site's factor is refreshed every minute and kept for two minutes, so what a driver saw is what they
  get.

## Preview

**Preview** on a site shows:

- the factor hour by hour for the next 7 days (time and peak rules);
- the factor now, with why;
- a 10 kWh charge priced as a real session would be (including any hold at the ceiling);
- how the last 30 days' energy revenue would have changed under the time and peak rules. This leaves out the busy and solar
  rules, and drivers may change when they charge.

## Rollback

`db/rollback/110_down.sql` drops the rules and settings. Sessions keep their totals.
