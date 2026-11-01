# PlugSure CSMS v1.45.0: release notes

**Date:** 2 November 2026
**Base:** v1.44.0.

v1.45.0 is phase 33. It adds four features:
- a support case desk;
- demand forecasting and site planning;
- driver credit (gift cards, vouchers and referrals);
- vehicle telematics.

- **Migration:** one, 112. It is additive. It adds:
  - thirteen tables;
  - three columns on `driver_charge` (credit held and used);
  - two on `fleet_vehicle` (the telematics link);
  - the `driver_credit` ledger source.
- **When nothing changes:** the desk and credit are off, there are no candidates and no telematics connections.
  Checkout, receipts and depot planning behave as before until they are switched on.
- **New workers:**
  - support SLAs, every 5 minutes;
  - driver credit (stale holds, expiry, referrals), every 15 minutes;
  - telematics polling, every 5 minutes.

  Each acts only on what has been set up.
- **Guides:**
  - [`deploy/SUPPORT-DESK.md`](deploy/SUPPORT-DESK.md)
  - [`deploy/DEMAND-PLANNING.md`](deploy/DEMAND-PLANNING.md)
  - [`deploy/DRIVER-CREDIT.md`](deploy/DRIVER-CREDIT.md)
  - [`deploy/DEPOT-CHARGING.md`](deploy/DEPOT-CHARGING.md) (telematics)

## New

### Support case desk

**Operate → Support.**

- **Where cases come from:**
  - **App:** *Laporkan masalah* on a receipt. The case is linked to the session, charger, site and payment; the driver
    follows replies in the app, with push notifications.
  - **E-mail:** an inbound webhook with its own key. A reply carrying `[PS-n]` is added to its case; replies go out
    through the operator's e-mail channel.
  - **WhatsApp:** when the assistant hands a conversation to staff, a case opens for the operator the driver last
    charged with. Replies go back on WhatsApp.
  - **Staff:** for calls and walk-ins.
- **SLA:** first-answer and resolution times per priority. A case past either is marked once and raises
  `support.sla_breach`.
- **Working cases:** assignment, macros (with `{{name}}`, `{{number}}`, `{{charger}}`, `{{site}}`), internal notes,
  driver satisfaction (1–5), and figures over 30 days.

### Demand forecasting and site planning

**Assets & energy → Demand & planning.**

- **By hour:** each site's occupancy, sessions and kWh for each hour of the week over 8 weeks (recent weeks weighted
  more), as a heatmap.
- **Forecast:** the next 1–14 days, hour by hour, from the profile and the trend.
- **Advice:** add connectors (with how many) where a site is busy 80 % or more for long stretches or turns drivers away;
  flag under-used sites.
- **Candidate sites:** scored on nearby demand, the gap to the nearest site and the pressure on sites nearby, with
  estimated sessions a day.

### Driver credit

**Commercial → Credit & referrals.** In the app: Account → Kredit, and *Pakai kredit* at checkout.

- **Codes:** gift cards (sold, a liability until used) and vouchers (given away, promotional). The codes are shown once.
- **Referrals:** both drivers are rewarded after the new driver's first paid session of at least the minimum energy.
  Refused: a driver's own code, existing drivers, a referrer's device, and referrals past the monthly cap.
- **Paying with credit:** credit pays part of a charge; the rest goes through the payment gateway (at least the
  operator's minimum). Credit is a means of payment: the charge record and its taxes stay on the full price. The money
  paid through the gateway is used first, and what a session does not use comes back as credit, never as cash.
- **Ledger:** the `driver_credit` source posts each month:
  - gift card sales: 1100 / 2260;
  - credit used: 2260 or 6450 / 4110;
  - breakage: 2260 / 4160.

### Vehicle telematics

**Depot charging → Telematics.**

- **Connecting:** a fleet's platform posts readings to PlugSure, or PlugSure reads it (https, sealed authorization,
  through the outbound guard). A field map says where each value is.
- **Use:** a reading from the last 30 minutes stands in for the car's own state of charge in depot planning. The
  vehicles table shows the latest battery level and range.

## API

There are 31 new operations, 913 in all; see `src/api/openapi/catalogue/phase33.ts`. The driver app's API adds:
- `/d/v1/credit`, `/d/v1/credit/redeem` and `/d/v1/credit/referral`;
- `/d/v1/support/cases` (list and report, one case, replies and rating);
- `useCredit` on `/d/v1/charge/prepaid`;
- credit fields on the quote and the receipt.

## Upgrade

1. Run migration 112 (`npm run migrate`).
2. Restart the API and the gateway.
3. Nothing to configure until a feature is switched on.

Rollback: `db/rollback/112_down.sql`. Before rolling back, export what drivers' paid-for credit is owed (Finance →
driver credit).
