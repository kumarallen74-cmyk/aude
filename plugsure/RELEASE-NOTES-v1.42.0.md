# PlugSure CSMS v1.42.0: release notes

**Date:** 1 November 2026
**Base:** v1.41.1.

v1.42.0 is phase 30. It adds four features:
- solar and battery storage at a site;
- charger health and failure prediction;
- a custom report builder;
- SAML single sign-on for the console.

- **Migration:** one, 109. It adds eight tables and allows `saml` as a session's sign-in method. It is additive.
- **When nothing changes:** a site with no solar or battery recorded charges exactly as before. Charger health is scored daily: it only reads, and it raises `charger.health_at_risk` alerts. No report is e-mailed until someone schedules one. SAML is off until an organisation's administrator connects an identity provider.
- **New dependencies:** `xml-crypto` and `@xmldom/xmldom`, for verifying SAML signatures.
- **Guides:**
  - [`deploy/ENERGY-STORAGE.md`](deploy/ENERGY-STORAGE.md), including the energy box API;
  - [`deploy/SAML-SIGN-IN.md`](deploy/SAML-SIGN-IN.md).

## New

### Solar and battery storage

**Assets → Solar & storage.**

- Record each site's solar inverters (kW AC, kWp) and batteries (kW, usable kWh, a state-of-charge band).
- The site's settings are solar first, peak shaving with a grid target, trust (80 %) and the maximum age of a reading (120 s).
- The site's energy box posts readings with a site key: `POST /v1/energy/sites/{siteId}/readings`. The readings are solar, battery power and state of charge, and grid import. Up to 500 can be sent at once, and a repeated timestamp is ignored.
- **The load manager** adds the measured solar output and battery discharge to the grid budget:
  - only from a fresh reading;
  - counted at the trust share;
  - capped at the installed power.
  
  It never adds a forecast. With peak shaving on, the grid part is capped at the target. PLN curtailment and the reserve still come first. Without a fresh reading, the site runs on the grid budget alone, as before.
- **A set-point for the battery** comes back in each answer: discharge to cover the chargers above the grid part, charge from unused solar, or charge off-peak while the grid has room. It always stays inside the battery's power and SoC band.
- **Results** per day:
  - solar produced, used and exported;
  - grid import;
  - battery in and out (and how much of the charge came from the grid);
  - self-consumption;
  - the peak grid power against what it would have been without the battery;
  - the savings at the site's tariff, counting solar used and battery discharge, less the cost of charging the battery from the grid.

### Charger health and failure prediction

**Maintenance → Charger health.**

- **The score:** each charger is scored from 0 to 100 over the last 30 days, from outages and hours offline, faults (StatusNotification), reboots (BootNotification), failed starts (sessions that ended with almost no energy), and a fault now.
- **At risk:** a score under 60, a fault now, the same fault code three times in seven days, or faults speeding up. **Watch:** a score under 80, or any recent fault or outage. Each charger shows the reasons.
- **The list:** sorted worst first, with the 7-day and 30-day trend and any open work orders. The drawer shows the details and 90 days of history.
- **A work order** (corrective) opens from the list with one click.
- **The daily run** keeps the history and raises `charger.health_at_risk` for chargers that become at risk. Route the alert like the others.

### Custom report builder

**Operate → Report builder.**

- **Datasets:** sessions, chargers (with their health), outages, work orders and posted ledger lines. Each needs its usual read permission.
- **Building:** choose the columns, or group by fields (dates by day, week, month, quarter or year) and count, sum, average, minimum or maximum. Add filters, a sort, a row limit (at most 5,000) and a bar or line chart.
- **Output:** run the report, or download it as Excel.
- **Saving and sending:** save it for the organisation, and e-mail it daily, weekly or monthly to up to ten addresses (from 07:00; monthly on the 1st), or send it now. A scheduled send uses only its creator's organisation-wide permissions, so a report cannot send data its creator cannot read.
- **Safety:** reports run only on whitelisted fields, with parameterized filters, scoped to the organisation.
- **API:** `/v1/reports/builder` and `/v1/reports/saved`.

### SAML single sign-on

**Users & Roles → Single sign-on (SAML).**

- **Providers:** each organisation connects its own identity provider, such as Okta, Entra ID, Google Workspace, OneLogin or ADFS. It enters the entity ID, the sign-on URL, up to three signing certificates and the allowed e-mail domains. The page shows PlugSure's entity ID, ACS URL and metadata to enter at the provider.
- **Signing in:** the sign-in page offers **Sign in with single sign-on (SSO)**. The work e-mail's domain picks the organisation.
- **Verification:**
  - the stored certificate only, with RSA-SHA256 or stronger;
  - only the signed parts of the message are read (signature wrapping is defended against);
  - issuer, audience, recipient, destination and validity times are checked;
  - the response must answer PlugSure's own request (no IdP-initiated or replayed assertions);
  - the browser that started the sign-in must finish it (no login CSRF);
  - no DOCTYPE and no encrypted assertions.
- **Accounts:** an existing user is matched by e-mail and linked. **Automatic account set-up** is optional, per organisation:
  - only for allowed domains;
  - with the role from a group → role map;
  - never an administrator role.

  Disabled and locked users stay refused. A user with an authenticator app still gives its code.
- **Audit:** `auth.saml_refused` (with the reason), `user.saml_provisioned` and `user.saml_linked`.

## Upgrade

1. Deploy. Migration 109 runs on start.
2. For SAML, `PUBLIC_BASE_URL` must be set.
3. Route `charger.health_at_risk` under alert routing if you want it.

## Rollback

`db/rollback/109_down.sql` drops the new tables. Single sign-on sessions become password sessions and are ended by the next sign-in. The load manager goes back to the grid budget alone.

## API

844 operations (21 new; the four SAML browser steps are not in the public reference).
