# PlugSure CSMS v1.41.0: release notes

**Date:** 1 November 2026
**Base:** v1.40.0.

v1.41.0 reorganises the console's menu. Finance had grown to 77 tabs in one row; it now has ten sections.

- **Migration:** none.
- **API:** no change (823 operations). Some descriptions, alert texts and e-mails now name the tabs as they are called now.
- **Links:** every earlier `#/finance/<tab>` link still opens its tab, in its section.
- **Guide:** `deploy/FINANCE.md`, *Finding your way*.

## Finance in ten sections

The page shows a row of sections and, under it, the section's own tabs. On a phone both rows scroll sideways, and the selected section and tab stay in sight. On a wide screen the tabs wrap.

| Section | Tabs |
|---|---|
| Overview | Summary, Scorecard, Reports, Benchmark |
| Revenue | Payments, Gateway, Gateway fees, Settlements, Gateway reconciliation, Subscriptions, Contracts, Loyalty costs, Pricing analysis, Roaming settlement, Driver funds, Chargebacks, Revenue assurance |
| Receivables | Gateway receivables, Fleet invoicing, Collections, Plans & provision, Customer credit |
| Spend | Refunds & shares due, Purchase orders, Supplier bills, Payment runs, Expenses, Corporate cards, Procurement, Payroll, Landlords, Insurance, Inventory, Maintenance |
| Cash & treasury | Cash position, Cash forecast, Bank reconciliation, Bank feeds, Treasury & deposits, FX & hedges, Lenders, Auto payouts |
| Assets | Fixed assets, Leases, Site investments, Capex projects, Grants, Carbon |
| Planning | Budgets, Budget planning, Revenue forecast, Scenarios, Energy margin, Site P&L, Portfolio, Energy tariffs |
| Tax | Tax calendar, PPN, Withholding, Corporate tax, Tax audit |
| Ledger & close | Ledger, Month close, Year end, Financial statements |
| Group & governance | Group, Intercompany, Netting & TP, Owner finance, Controls, Anomaly review, Data quality, Audit calendar, Settings |

**Merged tabs.** Each of these is now one tab with a switch:
- **Month close:** *Periods* (was Close), *Steps* (was Close steps) and *Automation* (was Close automation).
- **Cash forecast:** *All accounts* (was Cash forecast) and *Gateway settlements* (was Forecast).

**Renamed tabs:**

| Was | Now |
|---|---|
| Overview | Gateway |
| Fees | Gateway fees |
| Reconciliation | Gateway reconciliation |
| Receivables | Gateway receivables |
| Payables | Refunds & shares due |
| Orders | Purchase orders |
| Bills | Supplier bills |
| Cards | Corporate cards |
| Cash | Cash position |
| Bank | Bank reconciliation |
| Treasury | Treasury & deposits |
| Credit | Customer credit |
| Assurance | Revenue assurance |
| Pricing | Pricing analysis |
| Roaming | Roaming settlement |
| Assets | Fixed assets |
| Investments | Site investments |
| Projects | Capex projects |
| Margin | Energy margin |
| Tariffs | Energy tariffs |
| Tax | Tax calendar |
| Review | Anomaly review |
| Compliance | Audit calendar |

**Where Finance opens:** Summary (it opened on the gateway's Overview).

**The gateway filters** (account, period, Sync, Excel/CSV/PDF, Journal, Audit pack, Xendit reports) show only on the nine views that read the gateway account. Before, they showed above every tab and most tabs ignored them.

**Without a gateway account**, Finance used to show only the site owners' shares. Now:
- every section works;
- the gateway views say how to connect an account;
- Refunds & shares due still lists the owners' shares.

## The sidebar

A new **Finance** group, between Commercial and Maintenance:

| Order | Item |
|---|---|
| 1 | Finance today |
| 2 | Finance |
| 3 | Refunds |
| 4 | Owner billing (was Billing) |
| 5 | Platform statements (was Statements; still *Statements* in the Site Owner portal) |
| 6 | Fleet billing |
| 7 | Owners |
| 8 | Payouts |

- **WhatsApp** (was under Operate) and **Driver app** (was under Commercial) are now under **Governance**.
- Items that shared a position now have their own:
  - Promotions & plans and RFID & Access;
  - Hub and Fee invoices.
- **Commercial** keeps My fleet, Tariffs & Billing, Sessions & Revenue, Promotions & plans, RFID & Access and Roaming.

## Upgrading

Deploy. There is nothing to migrate or configure. Tell finance users where things moved (FINANCE.md, *Finding your way*).

**Rollback:** roll the code back to v1.40.0.

## Verification

- **Server:** typecheck clean; all unit and database tests passing.
- **Console:** checked in the browser:
  - each of the 77 earlier `#/finance/<tab>` links opens its own view, in the right section and tab, with the gateway filters shown exactly on the nine gateway views, and no page errors;
  - clicking a section opens its first tab;
  - the Month close switch updates the link;
  - Finance without a gateway account;
  - the Site Owner portal's sidebar;
  - light and dark mode and phone width.
