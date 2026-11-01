# PlugSure CSMS v1.40.0: release notes

**Date:** 1 November 2026
**Base:** v1.39.0.

v1.40.0 is phase 29 of the finance work:
- revenue recognition and customer contracts;
- intercompany netting and transfer pricing;
- finance data quality and the audit trail;
- scenario planning and sensitivity.

- **Migration:** one, 108. It adds six tables, two columns on intercompany recharges and one ledger source. It is additive.
- **When nothing changes:** the new tabs only read until contracts, policies or scenarios are entered. The data-quality run starts daily (findings only; nothing is changed). The contracts journal appears only where contracts exist.
- **Guide:** `deploy/FINANCE.md`, *Contracts, netting and transfer pricing, data quality and scenarios*.

## New

### Revenue recognition and customer contracts

The new Finance → **Contracts** tab: contracts beyond pay-per-charge, such as a fleet's charging-as-a-service or a B2B site with hardware and a service plan (PSAK 72 / IFRS 15).

- **Contracts** CT-00001…: the customer (optionally a fleet account), the term, the currency, the status, the renewal notice (60 days by default).
- **Performance obligations:** what is promised and its share of the price. Each is recognised:
  - **ratably** over its months (a subscription or service plan; the last month takes the rounding); or
  - at a **point in time** when delivered (hardware, an installation).
- **Billings** and when they were paid, into which account.
- **The schedule** per month:
  - recognised against billed;
  - the **contract liability** (billed ahead: deferred revenue) or the **contract asset** (recognised ahead);
  - the remaining performance obligations.
- **Ledger, the new contracts journal:**
  - billed: Dr 1370 contract receivables / Cr 2280 contract liabilities;
  - recognised: Dr 2280 / Cr 4500 contract revenue;
  - paid: Dr bank / Cr 1370.
- **Renewals:** `finance.contract_renewal_due` within each contract's notice (critical from 14 days). It is resolved when the contract is renewed or ended.

### Intercompany netting and transfer pricing

The new Finance → **Netting & TP** tab, for a group (a parent and its subsidiaries).

**Netting:**
- every issued, unsettled recharge between any two entities, per currency;
- each pair's bilateral net and each entity's multilateral position;
- with the parent as the netting centre: one transfer per entity instead of one per pair, and how much the netting settles without cash;
- a Finance Manager at the parent settles it: every pair's recharges are settled, as by the bilateral settlement.

**Transfer pricing:**
- **The policy** (set at the parent), per kind: management fee, shared services, IT services, energy resale, equipment rental, other. The method is one of:
  - cost plus, with an arm's-length mark-up range;
  - pass-through at cost;
  - a comparable uncontrolled price.
- **Each recharge** gets its kind and the cost underneath, set by the entity that charged it.
- **The check:** each recharge's mark-up is shown as in range, below, above, without a cost, or unclassified.
- **The workpaper** (Excel): the policy, each counterparty and kind summarised, and the year's transactions, for the transfer-pricing documentation (Local File).

### Finance data quality and the audit trail

The new Finance → **Data quality** tab.

| Check | Weight each (at most) |
|---|---|
| A posted entry that does not balance | 15 (30) |
| Lines on an account outside the chart | 5 (15) |
| An entry posted after its month was locked | 10 (20) |
| A journal entry waiting over 30 days | 1 (5) |
| A likely duplicate supplier (the same name without PT/CV/Tbk, NPWP or bank account) | 3 (15) |
| A billing supplier without an NPWP or bank account | 1 (10) |
| A fleet account invoiced without a tax id | 1 (5) |
| An energy, maintenance or rent bill without a site | 1 (10) |
| A bank account without a balance in 35 days | 3 (10) |

- **The score** is 100 less the weights. It is kept per run with the trend, and runs daily (a new worker).
- `finance.data_quality_low` is raised under 70 and resolved when the score is back.
- **History:** each finding opens the record's change history from the audit trail (who, when, before and after). The same history is available for any record through the API.

### Scenario planning and sensitivity

The new Finance → **Scenarios** tab: what-if on the next twelve months.

**The base:**
- the rolling forecast held flat (revenue and energy cost per month);
- running costs at the last twelve months' monthly average (expenses other than energy and depreciation);
- cash today;
- the debt service.

**A scenario** changes:
- the tariff (with an optional elasticity of volume to price);
- utilisation;
- the energy price;
- running costs;
- new sites: from a month, how many, the capex each, revenue and running costs a month at maturity, reached over a ramp (6 months by default).

**The result:**
- per month: revenue, energy, running costs, EBITDA, capex, debt service, net cash and cash;
- the lowest cash and when, and the runway (the first month cash would go below zero);
- each covenant (Lenders) tested on the scenario's EBITDA and lowest cash.

The base and every saved scenario are shown side by side. **Sensitivity:** the twelve-month EBITDA when each driver moves ±10 points, largest first. Everything is available in Excel.

### API

20 new operations (823 in all):

| Operation | Permission |
|---|---|
| `GET /v1/finance/contracts` (`format=xlsx`), `GET …/contracts/{id}` | `payment:read` |
| `POST /v1/finance/contracts`, `PUT …/{id}`, `POST …/{id}/obligations`, `PUT …/{id}/obligations/{oid}`, `POST …/{id}/billings`, `POST …/billings/{bid}/paid`, `POST …/billings/{bid}/void` | `payment:write`, audited |
| `GET /v1/finance/intercompany/netting`, `GET …/intercompany/transfer-pricing` (`year`, `format=xlsx`) | `payment:read` |
| `POST /v1/finance/intercompany/netting/settle` | `payment:write` and `finance:approve`, the parent, audited |
| `PUT /v1/finance/intercompany/transfer-pricing/policies` (the parent), `PUT …/intercompany/recharges/{id}/tp` | `payment:write`, audited |
| `GET /v1/finance/data-quality`, `GET /v1/finance/history` (`targetType`, `targetId`) | `payment:read` |
| `POST /v1/finance/data-quality/run` | `payment:write` |
| `GET /v1/finance/scenarios` (`currency`, `ids`, `sensitivityOf`, `format=xlsx`) | `payment:read` |
| `POST /v1/finance/scenarios`, `PUT …/scenarios/{id}` | `payment:write`, audited |

**Ledger:** a new source (contracts) and new accounts 1370, 2280 and 4500.

**New workers:** `contract-renewals` and `finance-data-quality`, daily.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **108**:
   - `customer_contract`, `contract_obligation`, `contract_billing`, `tp_policy`, `dq_run` and `finance_scenario`, with row-level security and no DELETE for the runtime role;
   - `intercompany_recharge.tp_kind` and `.cost_minor`;
   - the ledger's new source.
2. Optionally:
   - enter contracts and their obligations;
   - set the transfer-pricing policy at the parent;
   - run the data-quality checks;
   - model scenarios;
   - route `finance.contract_renewal_due` and `finance.data_quality_low`.

**Rollback:**
1. Roll the code back to v1.39.0.
2. Export the contracts, the policy and the scenarios.
3. Run `db/rollback/108_down.sql`. Settlements made by the netting stay (they are ordinary settlements); ledger entries from the contracts source are superseded.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 5 of them new. They cover:
  - **helpers:**
    - recognition, ratably (with the rounding) and when delivered;
    - transfers through the netting centre;
    - every transfer-pricing status;
    - supplier name matching;
    - the capped score;
    - a projection with a new site's capex and ramp (cash, the lowest month, the runway);
    - sensitivity;
    - assumptions checked;
  - **contracts:**
    - a subscription and a wallbox recognised over 11 months and on delivery;
    - a billing paid;
    - the contract liability and remaining obligation, to the rupiah;
    - the first month's schedule;
    - the journal (billed, recognised, paid);
    - a renewal alert, resolved by extending the contract;
  - **netting and transfer pricing:**
    - four recharges between three entities: the positions, two transfers instead of three;
    - the policy set only by the parent;
    - recharges classified only by the entity that charged them;
    - mark-ups in range, above, unclassified;
    - the workpaper;
    - the netting settled only by the parent, every pair settled;
  - **data quality:**
    - two unbalanced entries, an account outside the chart, a duplicate and an incomplete supplier, a bill without a site and a stale bank account;
    - the score and its alert;
    - a scenario's history from the audit trail;
  - **scenarios:**
    - two new sites' capex and ramp in cash;
    - the lowest cash breaking a 5 million minimum-cash covenant the base passes;
    - the sensitivity of a chosen scenario;
    - Excel.
- **Database:**
  - the least-privilege pins cover the six new tables;
  - the 108 rollback was checked.
- **Console:** the four new tabs were checked in light and dark mode and at phone width, with no page errors.

**To confirm before live use:**
- **Contracts:** how the price is allocated to each obligation (standalone selling prices) with your auditors.
- **Transfer pricing:** the mark-up ranges against your benchmarking study and DJP's documentation rules.
- **Scenarios:** the running-cost base and the covenants' definitions match your loan agreements.
