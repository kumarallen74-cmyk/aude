# PlugSure CSMS v1.47.0: release notes

**Date:** 2 November 2026
**Base:** v1.46.0.

v1.47.0 is phase 35. It adds four features:
- home charging reimbursement for employees;
- card payment terminals at the charger;
- energy market prices, with charging shifted to cheap hours;
- driver surveys and NPS.

- **Migration:** one, 114. It is additive. It adds ten tables and four columns on `site` (the price zone and its
  shifting).
- **When nothing changes:** there are no home chargers, terminals or price zones, and surveys are off. Billing,
  payments, the load manager and the driver app behave as before until they are set up.
- **New workers:**
  - card terminals, every minute (sessions found, captures and voids sent);
  - energy prices, every hour (zones with an address are fetched).

  Each acts only on what has been set up.
- **Load manager:** at a site that shifts to cheap hours, an expensive period gives the grid part of its budget only
  the site's share (default 50 %). A failure reading the prices leaves the usual budget.
- **Guides:**
  - [`deploy/HOME-CHARGING.md`](deploy/HOME-CHARGING.md)
  - [`deploy/CARD-TERMINALS.md`](deploy/CARD-TERMINALS.md)
  - [`deploy/ENERGY-PRICES.md`](deploy/ENERGY-PRICES.md)
  - [`deploy/SURVEYS.md`](deploy/SURVEYS.md)

## New

### Home charging reimbursement

**Finance → Home charging.**

- **An employee's home charger:** either an OCPP charger PlugSure manages (its sessions count, or only the employee's
  card's), or a meter the employee reads. An OCPP home charger is not on the public map.
- **The rate:** the employee's home electricity price per kWh, with an optional monthly cap.
- **The month:** OCPP: the kWh of the sessions that started in it. Meter: the last reading in the month minus the
  last one before it; a reading below an earlier one is refused.
- **Reimbursements:** drafted per month (employees without the readings needed are listed), approved
  (`finance:approve`), marked paid or voided. The payroll export (CSV) lists the approved ones by payroll number; a
  spreadsheet has the month.
- **The employee's page:** a secret link (`/home-charging/<token>`). The employee sees this month so far and their
  reimbursements, and adds meter readings.

### Card payment terminals

**Commercial → Card terminals.**

- **A terminal:** on a charger, or a kiosk for a site. It posts its events to its own address
  (`POST /v1/terminals/events/<key>`).
- **Paying:** a tap pre-authorises an amount. PlugSure starts the connector with a single-use guest card, limited to
  that amount (the connector's tariff turns it into an energy limit, enforced by a remote stop). When the charger
  cannot start, the answer says so and the terminal voids at once.
- **At the end:** the session's charge record decides the amount, never above the hold; no energy means a void. A car
  that never charged within 10 minutes is voided. The guest card is retired.
- **Instructions:** POSTed to the terminal's callback address (signed `X-PlugSure-Signature`, retried with back-off,
  an alert after 10 failures), or collected by the terminal when it polls.
- **Receipt:** each payment has a page (`/terminal-receipt/<token>`), for the terminal to show as a QR code.
- **Settlement:** the provider's report (CSV: reference, amount, date) is matched to the captures: matched, differs or
  unknown. Captures not in any report after 3 days are counted.

### Energy market prices

**Assets & energy → Energy prices.**

- **Price zones:** prices per kWh for 15, 30 or 60-minute periods. Imported (JSON or CSV, per kWh or per MWh) or
  fetched every hour from an address through the outbound guard.
- **Today:** the zone's curve with its expensive periods: the day's most expensive quarter, or at or above a site's
  threshold.
- **Shifting:** a site on a zone with shifting on gets only part of its grid budget in expensive periods. On-site
  solar and battery are not capped; sessions with a departure (depot charging) still get what their departure needs.
- **Savings:** per site and month, the energy each hour × that hour's price, against the same energy at the month's
  average price.

### Driver surveys and NPS

**Operate → Surveys.**

- **In the app:** after a charge, on the receipt, "how likely are you to recommend us?" (0–10), with optional tags
  and a comment.
- **Who is asked:** a share of charges (the same charge always gets the same answer), at most once every N days per
  driver, once per charge.
- **NPS:** overall, by week, per site and per charger; the tags drivers chose; the scores' distribution.
- **Low scores:** a score of 6 or less with a comment opens a support case linked to the session (when the support
  desk is on).

## Also

On a phone, a console card's header controls now wrap under its title instead of widening the page.

## API

- **34 operations** (`src/api/openapi/catalogue/phase35.ts`), 985 in all: `/v1/home-chargers*`,
  `/v1/home-reimbursements*`, `/v1/home-charging/{token}` (the employee's link), `/v1/terminals*`,
  `/v1/terminal-payments*`, `/v1/terminal-settlements*`, `/v1/terminal-receipts/{token}`, `/v1/energy-prices/*`,
  `/v1/sites/{siteId}/energy-prices` and `/v1/surveys/*`.
- **Public, with their own keys:** the terminal webhook, its receipts and the employee's page.
- **Driver API:** `GET /d/v1/surveys/pending`, `POST /d/v1/surveys`.
- The SDK is regenerated (1.47.0).

## Upgrading

1. Run migration 114 (`db/migrations/114_home_terminals_prices_surveys.sql`; rollback `db/rollback/114_down.sql`).
2. Deploy. Nothing else is required.
3. Optional: see `deploy/README.md` item 40.

## Tests

- `src/services/phase35.db.test.ts`:
  - home charging from meter readings and from OCPP sessions, approval, the payroll export, the employee's page;
  - card terminals: a refused pre-authorisation, a payment captured through a signed callback, a polled void, the
    receipt, settlement matching;
  - energy prices: parsing, the expensive quarter, a site's cap now, the savings;
  - surveys: asked once, a detractor's case, NPS.
- The least-privilege test covers the new tables.
- The driver app's and the driver API's English cover the new messages.
