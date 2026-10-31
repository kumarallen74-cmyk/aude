# PlugSure CSMS v1.20.0: release notes

**Date:** 31 October 2026
**Base:** v1.19.0.

v1.20.0 is phase 9 of the finance work: energy cost and margin, budgets vs actuals, collections with reminders and write-offs, and an audit pack for the year-end auditor.

- **Migration:** one, 088 (seven new tables; additive).
- **When nothing changes:** until energy bills or rates, budgets, or reminders are entered. Collections, Margin and the audit pack show at once.
- **Guide:** `deploy/FINANCE.md`, *Margin, budgets, collections and the audit pack*.

## New

### Energy cost and margin

Finance → **Margin**, per site and month:

- **Figures:** revenue before tax, kWh delivered, the energy cost, and the gross margin.
- **Energy cost:** the electricity bill when recorded. Otherwise the site's cost per kWh times the kWh delivered, marked as an estimate.
- **Losses:** a bill's kWh compared with the kWh delivered to cars shows losses and the site's own use.
- **Per charger:** the bill is split between the site's chargers by the kWh each delivered.
- **Bills:** one live bill per site and month. A wrong one is voided with a reason, never deleted.

### Budgets vs actuals

Finance → **Budgets**:

- **What you budget:** per month, for the organisation (revenue, energy cost, gateway fees, owners' share) or per site (revenue and energy cost).
- **What you see:** actual beside budget, with the variance in amount and percent.
- **Copying:** *Copy to the next 12 months* repeats a month's budget.
- **Alert:** from the 7th of the month, revenue below or energy cost above the budget so far, by more than 15% (adjustable), raises `finance.budget_off_track`.

### Collections and dunning

Finance → **Collections** shows what customers owe:

- unpaid fleet invoices;
- for platform administrators, operators' statements to PlugSure.

It sorts them by age: not due yet, 1–30, 31–60, 61–90 and over 90 days.

- **Notes and promises to pay:** a promise in the future pauses the reminders.
- **Reminders:** send one now by e-mail or WhatsApp. Or turn on the schedule, steps in days from the due date (by default 3 days before, then 7, 14 and 30 days after).
  - Only the latest step reached is sent, once per channel.
  - WhatsApp needs an approved reminder template with three parameters.
- **Write-offs:** with a reason, approved by a second person (`finance.write_off_awaiting_approval`). An approved write-off leaves collections; the invoice itself is unchanged, and the accountant books the bad debt.

### Audit pack

Finance → **Audit pack** downloads one ZIP for the period:

- the CSVs: journal, gateway ledger, statements, statement payments, transfers, bank lines, tax withholdings, write-offs and the audit log;
- `manifest.json`, with each file's rows, size and SHA-256, and the audit log's hash chain verified when the pack was made;
- a README on checking the checksums.

Account numbers appear by their last four digits only. Each download is audited.

### API

Seventeen new operations (407 in all):

| Area | Operations |
|---|---|
| Margin | `GET /v1/finance/energy`, `GET /v1/finance/energy/trend`, `PUT /v1/finance/sites/{sid}/energy-rate`, `POST /v1/finance/sites/{sid}/energy-bills`, `POST /v1/finance/energy-bills/{bid}/void` |
| Budgets | `GET` and `PUT /v1/finance/budgets`, `POST /v1/finance/budgets/copy`, `PUT /v1/finance/budgets/settings` |
| Collections | `GET /v1/finance/collections`, `GET /v1/finance/collections/{kind}/{ref}` and its `/notes`, `/remind`, `/write-off`; `POST /v1/finance/write-offs/{wid}/{decision}`; `PUT /v1/finance/collections/settings` |
| Audit pack | `GET /v1/finance/accounts/{id}/audit-pack` |

Reads need `payment:read`. Changes need `payment:write` and are audited.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **088**: `site_energy_rate`, `site_energy_cost`, `finance_budget`, `finance_org_settings`, `receivable_note`, `dunning_reminder` and `receivable_write_off`. All seven use row-level security, and the runtime role cannot delete from them.
2. Optionally:
   - enter each site's cost per kWh or its monthly bills;
   - set budgets;
   - turn on reminders (and name the WhatsApp template);
   - route `finance.budget_off_track` and `finance.write_off_awaiting_approval`.

**Rollback:** roll the code back to v1.19.0, then run `db/rollback/088_down.sql`. This drops bills, rates, budgets, notes, the reminder log and write-offs.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 7 of them new. They cover:
  - margin: the estimate, the bill with losses, allocation by kWh, one bill a month, void and replace, the trend;
  - budgets: variance, site limits, copy forward, the off-track alert from the 7th;
  - collections:
    - aging buckets;
    - a reminder through a fake SMTP server;
    - the schedule sending the latest step once and pausing for a promise;
    - a write-off approved by a second person;
  - the audit pack: every file present, and the manifest's SHA-256s matching.
- **Database:** the least-privilege pins cover the seven new tables, and the 088 rollback was checked.
- **Console:** Margin, Budgets and Collections were checked in light and dark themes and at 390 px.

**To confirm before live use:**
- The PLN tariff per site.
- The WhatsApp reminder template's wording, approved by Meta.
