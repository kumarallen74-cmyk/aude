# PlugSure CSMS v1.43.0: release notes

**Date:** 1 November 2026
**Base:** v1.42.0.

v1.43.0 is phase 31. It adds four features:
- SCIM user provisioning;
- dynamic pricing;
- grid demand response;
- a public status page.

- **Migration:** one, 110. It adds thirteen tables, plus a column on sessions and one on payments (the price factor fixed for each). It is additive.
- **When nothing changes:** none of the four does anything until an operator sets it up. Dynamic pricing and SCIM are off by default, there are no demand-response programmes and the status page is off. Two new workers run: dynamic prices every minute, OpenADR polling every 5 minutes. Both only act on what has been set up.
- **Guides:**
  - [`deploy/SCIM.md`](deploy/SCIM.md)
  - [`deploy/DYNAMIC-PRICING.md`](deploy/DYNAMIC-PRICING.md)
  - [`deploy/DEMAND-RESPONSE.md`](deploy/DEMAND-RESPONSE.md)
  - [`deploy/STATUS-PAGE.md`](deploy/STATUS-PAGE.md)

## New

### SCIM user provisioning

**Users & Roles → Provisioning (SCIM).** The endpoint is SCIM 2.0 at `…/scim/v2`, with a per-organisation token. Okta, Entra ID, Google Workspace, OneLogin and others can use it.

- **Users:** created, updated and deactivated by the identity provider. An existing console user is taken over by e-mail; new users have no password and sign in with single sign-on. Deactivation ends every session. Nothing is deleted.
- **Roles:**
  - Roles come only from groups, through a group → role map (or the SAML one). The first match in the map's order decides; with no matching group, a person has no role.
  - A group never gives an administrator role or a site-limited one.
  - Administrators are never changed or deactivated by provisioning.
- **Audit:** `user.scim_*`, `group.scim_*`, `org.scim_*`.

### Dynamic pricing

**Commercial → Dynamic pricing.**

- **Rules:** by time and day, the grid's peak hours, how busy a site is, or its solar output. The rules add up and stay inside a floor and a cap (80 % to 130 % by default).
- **What moves:** only the energy price, and the per-minute time fee unless that is switched off. Fees, the PLN formula rate and roaming sessions never move. An increase is held at the regulated energy ceiling.
- **Fixed prices:**
  - A session is fixed at the factor in force when it starts.
  - A pre-paid charge keeps the factor it was paid at, so the energy bought is the energy billed.
  - The driver app shows the price now in the map, on the connector page and in the quote.
- **Preview:** a 7-day hour-by-hour grid, a sample charge priced as a real session would be, and the effect on the last 30 days.

### Grid demand response

**Assets & energy → Grid events.**

- **Programmes:** events arrive by webhook (the grid operator or aggregator posts them with a programme key), from an OpenADR 3 server PlugSure polls (OAuth 2 client credentials; `IMPORT_CAPACITY_LIMIT` and `SIMPLE` levels), or by hand.
- **During an event:** the load manager caps the sites' grid part to a kW limit (split by usual budget) or a % reduction. Curtailment, reserve and peak shaving apply first, and on-site solar and battery are added on top.
- **Measurement and incentive:** every pass records the baseline (what the chargers asked for within the usual budget) and what they were given. The screen shows the reduction in kWh and kW and the incentive.
- **Control:** operators can opt out of an event, and each new event raises the `grid.demand_response` alert.

### Public status page

**Maintain → Status page.**

- **Address:** `/status/<slug>` on the shared console, and `/status` on the operator's own approved address.
- **Content:** each site's live state (working, partly out of service, out of service, maintenance), connector counts, open incidents, planned maintenance and the last 14 days. It is in light and dark and refreshes every minute.
- **Incidents and maintenance:** posted with public updates.
- **E-mail updates:** confirmed by link, with one-click unsubscribe, sent through the operator's e-mail channel.

## Fixed

- **SAML (v1.42.0):** a group could be mapped to the site-limited Site Host / Landlord role, and automatic account set-up then granted it organisation-wide. Such a person would see every site. Site-, owner- and fleet-limited roles can no longer be given by a group (SAML or SCIM).

- **Console:** a page that listens for clicks on the whole page kept listening after the operator moved to another page, so its handler also ran there. For example, an "Edit" on one page opened another page's form, and a row's × on the report builder could open Developers' "Delete this sandbox?" dialog. Every page now starts on a fresh page element.

## Upgrade

1. Deploy. Migration 110 runs on start.
2. If you use the status page or SCIM, keep `CONSOLE_PUBLIC_URL` set: the links are built on it.
3. Route `grid.demand_response` in alert routing if you join a demand-response programme.

## Rollback

`db/rollback/110_down.sql` drops the new tables and the two columns. Users created by SCIM stay.

## API

868 operations (24 new; the two status-page e-mail links are internal and not listed). The SCIM 2.0 endpoint (`/scim/v2`) is outside `/v1` and is described in `deploy/SCIM.md`.
