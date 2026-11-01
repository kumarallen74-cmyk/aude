# PlugSure CSMS v1.35.0: release notes

**Date:** 1 November 2026
**Base:** v1.34.0.

v1.35.0 is phase 24 of the finance work:
- carbon and green energy credits;
- insurance and claims;
- pricing profitability analysis;
- the audit and compliance calendar.

- **Migration:** one, 103. It adds eight tables, a settings column and two ledger sources. It is additive.
- **When nothing changes:** nothing changes until RECs, policies or deadlines are recorded. The pricing analysis only reads.
- **Guide:** `deploy/FINANCE.md`, *Carbon, insurance, pricing and compliance*.

## New

### Carbon and green energy credits

The new Finance → **Carbon** tab.

**RECs** (renewable energy certificates, 1 MWh each):
- bought for a site or for the portfolio: registry, reference, vintage, MWh, price, the account paid from;
- retired once, against the month of charging they cover.

**Each month, per site and in all:**
- the MWh charged;
- the green share: the REC MWh retired over the MWh charged, at most 100% (the portfolio's RECs are shared by the sites' energy);
- the emissions avoided: what petrol cars would have emitted for the same distance, less the grid's emissions for the energy not covered.

| Factor | Default | Meaning |
|---|---|---|
| `iceKgPerKwh` | 0.7 | kg CO2e a petrol car emits for the distance an EV drives on one kWh |
| `gridKgPerKwh` | 0.8 | kg CO2e per kWh from the grid |

**Carbon credits:**
- estimated from a period's avoided emissions;
- then verified (with the standard) and issued (with the registry serial), never back;
- sold, issued credits only, up to what is left;
- voided only if none are sold.

**Ledger, the new carbon journal:**
- RECs bought: Dr 1750 / Cr bank;
- RECs retired: Dr 5150 / Cr 1750, in the month they cover;
- credits sold: Dr bank / Cr 4300.

The cash position counts REC payments and credit sales. The **report** (Excel) has the months, the RECs, the credits and the sales.

### Insurance and claims

The new Finance → **Insurance** tab.

**Policies** on a site, a charger or the organisation:
- insurer and number (unique);
- kind: property, equipment, liability, business interruption, vehicle, other;
- cover, premium, excess, term;
- when the premium was paid, and from which account.

**The premium:**
- paid: Dr 1450 prepaid insurance / Cr bank;
- spread over the term by days: each month Dr 6600 insurance / Cr 1450;
- the prepaid left is shown per policy and in all.

**Renewals:**
- an active policy ending within 30 days and not renewed raises `finance.insurance_renewal` (critical once it has ended);
- renewing copies it to the next term (from the old end), with a new number and premium, and resolves the alert;
- cancelling resolves it too.

**Claims** under a policy, numbered CL-00001…:
- kind, incident date (inside the term), what happened, the loss, the work order;
- reported → submitted → accepted or rejected → paid → closed;
- the settlement is at most the loss less the excess (the default);
- paid: Dr bank / Cr 6605 insurance recoveries.

The **recovery rate** is settled over loss. The register is in Excel.

### Pricing profitability analysis

The new Finance → **Pricing** tab, over the last 1, 3, 6 or 12 whole months.

**Rows** by:
- tariff (the name frozen on the charge record);
- connector type;
- time band in the billing zone: night 22:00–06:00, day 06:00–17:00, peak 17:00–22:00 (PLN's peak hours);
- site.

**Each row, per currency:** sessions, kWh, revenue before tax, energy cost, margin and margin %, the price and the cost per kWh.

**Energy cost per session:** the site's bill for the month spread over the kWh delivered, else the site's cost per kWh (Finance → Energy). kWh with no known cost are shown as *not costed*.

**Price elasticity:**
- where a site's price per kWh moved by 5% or more from one month to the next (last twelve months), the change in kWh per day over the change in price (arc elasticity) is an observation;
- the median is the estimate, used (kept within −3 and 0) once there are three or more observations; until then −0.3 is assumed.

**What-if** on any row: a price change of x% with an elasticity gives the volume, revenue, energy cost and margin after, and the change in margin.

### Audit and compliance calendar

The new Finance → **Compliance** tab. Tax deadlines stay in the tax calendar.

**Deadlines:**
- title; category: financial statements, regulator, licence, corporate, other tax, audit, other;
- authority, due date, owner;
- recurrence: none, monthly, quarterly, yearly;
- reminder days.

**Reminders:** from the reminder window an open deadline raises `finance.compliance_due` (critical once overdue). Done or waived (a waiver needs a note) resolves it.

**Recurrence:** marking a recurring deadline done creates the next one (once), on the same day of the next month, quarter or year, with the quarter or year in its title moved on.

**The standard deadlines** for a year, added once each:

| Deadline | Authority | Due | Recurs |
|---|---|---|---|
| LKPM (investment activity report) | BKPM / OSS | 10 January | quarterly |
| Charging-station (SPKLU) operations report | Ditjen Gatrik, ESDM | 15 January | quarterly |
| WLKP (company manpower report) | Kemnaker | 31 January | yearly |
| Audited financial statements | Auditor (KAP) | 30 April | yearly |
| Annual GMS and annual report | Shareholders (UU 40/2007) | 30 June | yearly |

These are a starting point: check them with the organisation's advisers.

**Evidence** on a deadline or an auditor's request:
- PDF, PNG, JPEG, XLSX, DOCX or CSV, up to 5 MB;
- the type checked against the file's first bytes;
- a SHA-256 kept; downloaded as uploaded.

**The auditor's PBC list** (prepared by client): audit, reference, item, requested and due dates, owner; requested → in progress → provided (a file needed) → accepted.

**KPIs:** overdue, due within 30 days, done on time over the last twelve months, open and overdue requests. Excel.

### API

28 new operations (724 in all):

| Operation | Permission |
|---|---|
| `GET /v1/finance/carbon` (`format=xlsx` with `from`, `to`) | `payment:read` |
| `GET /v1/finance/carbon/months/{month}` | `payment:read` |
| `PUT /v1/finance/carbon/settings` | `payment:write`, audited |
| `POST /v1/finance/carbon/recs`, `…/recs/{id}/retire` | `payment:write`, audited |
| `POST /v1/finance/carbon/credits`, `PUT …/credits/{id}`, `POST …/credits/{id}/sales` | `payment:write`, audited |
| `GET /v1/finance/insurance` (`format=xlsx`) | `payment:read` |
| `POST /v1/finance/insurance/policies`, `PUT …/policies/{id}`, `POST …/policies/{id}/renew` | `payment:write`, audited |
| `POST /v1/finance/insurance/policies/{id}/claims`, `POST …/claims/{id}` | `payment:write`, audited |
| `GET /v1/finance/pricing` (`months`, `siteId`, `format=xlsx`) | `payment:read` |
| `POST /v1/finance/pricing/what-if` | `payment:read` |
| `GET /v1/finance/compliance` (`from`, `to`, `format=xlsx`) | `payment:read` |
| `POST /v1/finance/compliance/templates` | `payment:write`, audited |
| `POST /v1/finance/compliance/tasks`, `PUT …/tasks/{id}`, `POST …/tasks/{id}/status` | `payment:write`, audited |
| `GET /v1/finance/compliance/tasks/{id}`, `…/pbc/{id}`, `…/evidence/{id}` | `payment:read` |
| `POST /v1/finance/compliance/tasks/{id}/evidence`, `…/pbc/{id}/evidence` | `payment:write`, audited |
| `POST /v1/finance/compliance/pbc`, `PUT …/pbc/{id}` | `payment:write`, audited |

**Ledger:** two new sources (carbon, insurance) and new accounts 1450, 1750, 4300, 5150, 6600 and 6605.

**New workers:**
- `insurance-renewals`, daily;
- `compliance-reminders`, every 12 hours.

**Fixed:** six descriptions in the v1.34.0 API catalogue showed a placeholder instead of an apostrophe.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **103**:
   - `rec_purchase`, `carbon_credit`, `carbon_credit_sale`, `insurance_policy`, `insurance_claim`, `compliance_task`, `pbc_request` and `compliance_evidence`, with row-level security and no DELETE for the runtime role;
   - `finance_org_settings.carbon`;
   - the ledger's new sources.
2. Optionally:
   - set the emission factors for your grid;
   - record the RECs and the insurance policies;
   - sync the ledger's months;
   - check the sites' cost per kWh or bills;
   - add the standard deadlines and the auditors' requests;
   - route the new alerts.

**Rollback:**
1. Roll the code back to v1.34.0.
2. Export the carbon report, the insurance register, the compliance calendar and the evidence files.
3. Run `db/rollback/103_down.sql`.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 5 of them new. They cover:
  - **helpers:**
    - the emissions avoided;
    - premium shares by days, part months at both ends;
    - the time bands and arc elasticity;
    - recurrence (month ends, leap years) and titles moved on;
    - file sniffing;
  - **pricing:**
    - margin by tariff, connector, band and site from the site's cost per kWh;
    - two price moves observed and their median, too few to use (−0.3 assumed);
    - a what-if;
  - **carbon:**
    - a REC retired once for a 50% green share, and the tonnes avoided;
    - credits estimated, verified, issued (a serial needed) and sold up to what is left; not voided once sold;
    - the cash position and the ledger (4300, 5150, 1750);
  - **insurance:**
    - the premium in the cash position and spread by days (6600, 1450);
    - a claim's steps, the settlement capped at the loss less the excess (6605);
    - the renewal alert, resolved by renewing;
  - **compliance:**
    - the standard deadlines added once;
    - a reminder alert;
    - evidence of the wrong type, too large and accepted, downloaded byte for byte;
    - a recurring deadline done creating the next one only once;
    - a PBC request needing a file before it is provided.
- **Database:**
  - the least-privilege pins cover the eight new tables;
  - the 103 rollback was checked.
- **Console:** the four tabs were checked in light and dark mode and at phone width, with no page errors.

**To confirm before live use:**
- **Emission factors:** the grid factor for your region (the Indonesian grid averages are published by ESDM) and the petrol factor for your drivers' cars.
- **Carbon credits:** that your registry and standard accept charging-based credits, and how they want the baseline.
- **Insurance accounting:** spreading the premium by days suits your accounting policy.
- **Compliance dates:** the standard deadlines against the current regulations and your licences.
