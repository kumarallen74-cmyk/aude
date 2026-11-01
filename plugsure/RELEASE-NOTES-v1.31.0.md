# PlugSure CSMS v1.31.0: release notes

**Date:** 1 November 2026
**Base:** v1.30.0.

v1.31.0 is phase 20 of the finance work:
- a general ledger fed by every finance module;
- expense claims and petty cash;
- intercompany recharges;
- a monthly KPI scorecard.

- **Migration:** one, 099. It adds eleven tables, two settings columns and a column on cash accounts. It is additive.
- **When nothing changes:** nothing changes until a month is synced into the ledger, or claims, recharges or targets are recorded.
- **Guide:** `deploy/FINANCE.md`, *Ledger, expenses, intercompany and scorecard*.

## New

### General ledger

The new Finance → **Ledger** tab.

**Chart of accounts:** seeded with the codes the finance modules post to: banks, gateway, deposits, receivables, PPN input, assets and right-of-use assets, payables, tax payables, lease liabilities, equity, revenue, expenses, and other income and expense. Accounts can be added, renamed and deactivated. A code a module posts to that is missing from the chart is added, typed by its first digit.

**Sync:** posts a month's entries from the modules, one per source and currency:

| Source | What it posts |
|---|---|
| Gateway | Each payments account's journal: collections, fees and VAT, withholding, refunds, payouts to the bank, owner payouts |
| Assets | The recorded depreciation and disposals journal |
| Leases | The recorded lease journal (PSAK 73) |
| Provision | The recorded bad-debt provision's movement |
| Bills | Supplier bills of the month: expense, or asset if capitalised; PPN input; supplier payable; PPh 23 payable. Payments: payable against the bank or petty cash |
| Deposits | Placed: deposits against the bank. Closed: bank against deposits, plus interest income and penalties |
| Expenses | Claims approved: expense by category, PPN input, claims payable. Reimbursed: claims payable against petty cash or the bank |
| Intercompany | Recharges issued: receivable / recharge income. Recharges received: recharge expense / payable. Settlements: through the bank |

Syncing again keeps unchanged entries and replaces changed ones; the old entries are kept as superseded. A locked month, or one that has not started, cannot be synced.

**Manual journal entries:**
- An entry needs a date, a currency, a memo and lines that balance, on active accounts.
- It is submitted, then approved by a second person; the approvals matrix has a new **Manual journal entries** row.
- It posts once approved, and is numbered JE-YYYYMM-NNNN.
- A posted manual entry is reversed (swapped lines, posted), never edited.
- A module's entry is corrected in the module and synced again.
- Locked months are respected.

**Reports**, per currency, with Excel:
- the trial balance to a month's end;
- profit and loss for the month and the year to date (revenue, expenses, other income and expense, result);
- the balance sheet at the month's end, with the result of earlier years and of this year in equity.

Each report says whether it balances. An account's lines can be listed for a month.

### Expense claims and petty cash

The new Finance → **Expenses** tab.

**Claims** are numbered EX-00001…. A console user makes a claim for themselves, with lines:
- date, category (fuel, travel, meals, parking, tools, supplies, phone, other), site, description, amount and PPN;
- receipts: JPEG, PNG, WebP or PDF, up to 3 MB, checked to be the type they say.

**Policy:** a receipt amount (default 100 000; a line at or above it needs its receipt before the claim is submitted) and limits per category, both set by a Finance Manager.

**Approval:**
- By someone other than the claimant; the approvals matrix has a new **Expense claims** row.
- A line above its category's limit needs a Finance Manager.
- A claim can be rejected with a reason, corrected and submitted again.
- It can be voided by the claimant or a Finance Manager.

**Reimbursing:** from a cash account (petty cash or a bank) on a date. The cash position counts it out of that account.

**Petty cash:**
- **Balance and float:** cash accounts of kind cash show their balance, the float (imprest) and the top-up to it.
- **Counting:** a count records the notes and coins, the total, what the books expected and the difference. The count becomes the account's balance for that day.

### Intercompany recharges

The new Finance → **Intercompany** tab, for a parent organisation and its subsidiaries:

| Action | What it does |
|---|---|
| Recharge | The entity that carried a cost charges another (IC-00001…): month, description, amount, currency. Issued or drafted. The charging entity sees a receivable, the other a payable. Drafts are visible only to the charging entity. |
| Allocate | Splits a cost across the group by kWh, sessions or revenue in the month, or equally. Each other entity's share becomes a draft recharge to review and issue. |
| Balances | Per counterparty and currency: receivable, payable, net. |
| Settle | Nets everything issued and open with an entity in a currency, says who pays whom, and marks the recharges settled. Each entity sees the settlement from its own side. |

A voided recharge needs a reason; a settled one cannot be voided. An organisation outside the group is refused.

### KPI scorecard

The new Finance → **Scorecard** tab, in the organisation's main currency (the reporting currency, else its sites' first):

| KPI | Better |
|---|---|
| Revenue, sessions, kWh | higher |
| Margin %, utilisation % | higher |
| Collection days | lower |
| Cash at the month's end | higher |
| Operating costs (supplier bills of the month and expense claims approved in it) | lower |

**Targets:** monthly, per KPI. A month's targets can be copied from another month.

**Colours:**
- green when the KPI meets its target;
- amber within the band (default 10%);
- red beyond the band;
- no colour when there is no target.

**Trend:** six months of each KPI.

**E-mail:** the last month's scorecard is e-mailed on a day of the month (1–28) to up to 20 recipients, once a month, through the organisation's e-mail channel. It can also be sent now.

The benchmark (v1.29.0) gains `by=org`: every site of the organisation together.

### API

Thirty-eight new operations (610 in all):

| Operation | Permission |
|---|---|
| `GET /v1/finance/ledger` | `payment:read` |
| `POST /v1/finance/ledger/sync/{month}` | `payment:write`, audited |
| `GET /v1/finance/ledger/accounts` | `payment:read` |
| `PUT /v1/finance/ledger/accounts/{code}` | `payment:write`, audited |
| `GET /v1/finance/ledger/accounts/{code}/lines` | `payment:read` |
| `GET /v1/finance/ledger/entries` | `payment:read` |
| `POST /v1/finance/ledger/entries` | `payment:write`, audited |
| `GET /v1/finance/ledger/entries/{id}` | `payment:read` |
| `POST /v1/finance/ledger/entries/{id}/submit` | `payment:write`, audited |
| `POST /v1/finance/ledger/entries/{id}/approve` | `payment:write` and the approvals matrix, audited |
| `POST /v1/finance/ledger/entries/{id}/reject` | `payment:write`, audited |
| `POST /v1/finance/ledger/entries/{id}/reverse` | `payment:write`, audited |
| `GET /v1/finance/expenses` | `payment:read` |
| `PUT /v1/finance/expenses/policy` | `finance:approve`, audited |
| `POST /v1/finance/expenses` | `payment:read` (a console user's own claim), audited |
| `GET /v1/finance/expenses/receipts/{rid}` | `payment:read` |
| `GET /v1/finance/expenses/{id}` | `payment:read` |
| `POST /v1/finance/expenses/{id}/lines` | `payment:read` (the claimant) |
| `POST /v1/finance/expenses/{id}/lines/{lid}/remove` | `payment:read` (the claimant) |
| `POST /v1/finance/expenses/{id}/lines/{lid}/receipts` | `payment:read`, audited |
| `POST /v1/finance/expenses/{id}/submit` | `payment:read` (the claimant), audited |
| `POST /v1/finance/expenses/{id}/approve` | `payment:write` and the approvals matrix, audited |
| `POST /v1/finance/expenses/{id}/reject` | `payment:write`, audited |
| `POST /v1/finance/expenses/{id}/void` | the claimant or `finance:approve`, audited |
| `POST /v1/finance/expenses/{id}/reimburse` | `payment:write`, audited |
| `GET /v1/finance/petty-cash` | `payment:read` |
| `PUT /v1/finance/petty-cash/{id}/float` | `payment:write`, audited |
| `POST /v1/finance/petty-cash/{id}/counts` | `payment:write`, audited |
| `GET /v1/finance/intercompany` | `payment:read` |
| `POST /v1/finance/intercompany/recharges` | `payment:write`, audited |
| `POST /v1/finance/intercompany/allocate` | `payment:write`, audited |
| `POST /v1/finance/intercompany/recharges/{id}/issue` | `payment:write`, audited |
| `POST /v1/finance/intercompany/recharges/{id}/void` | `payment:write`, audited |
| `POST /v1/finance/intercompany/settle` | `payment:write`, audited |
| `GET /v1/finance/scorecard` | `payment:read` |
| `PUT /v1/finance/scorecard/targets/{month}` | `payment:write`, audited |
| `PUT /v1/finance/scorecard/settings` | `payment:write`, audited |
| `POST /v1/finance/scorecard/send` | `payment:write`, audited |

The approvals matrix accepts the kinds `journal_entry` and `expense_claim`. The cash position counts reimbursed claims.

New worker: `finance-scorecard`, every 6 hours. It sends the monthly e-mail once, on or after its day.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **099**:
   - `gl_account`, `gl_entry`, `gl_line`, `expense_claim`, `expense_claim_line`, `expense_receipt`, `cash_count`, `intercompany_recharge`, `intercompany_settlement`, `kpi_target` and `kpi_scorecard_send`, with row-level security and no DELETE for the runtime role. Intercompany recharges are visible to both the charging and the charged organisation.
   - `cash_account.float_minor`.
   - The expense policy and scorecard settings.
2. Optionally:
   - post the opening balances as a manual journal entry;
   - sync each closed month;
   - set the expense policy, the petty cash float, the approvals matrix rows, the KPI targets and the scorecard e-mail.

**Rollback:**
1. Roll the code back to v1.30.0.
2. Export the ledger, claims and recharges.
3. Run `db/rollback/099_down.sql`.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 5 of them new. They cover:
  - **helpers:** lines netted per account, and the scorecard colours by direction and band;
  - **ledger:**
    - unbalanced entries and unknown accounts refused;
    - a manual entry approved by a second person only;
    - a month synced from bills, a deposit and a payment, unchanged on a second sync and replaced when a payment is added;
    - the trial balance and balance sheet balancing;
    - profit and loss with the bill and a manual expense;
    - the supplier payable net of PPh 23 and the payment;
    - a reversal (once only), and a module's entry not reversible;
    - a locked month refused;
  - **expense claims:**
    - two receipts needed before submitting, and a receipt of the wrong type refused;
    - the claimant cannot approve;
    - a line over its limit refused without finance:approve;
    - reimbursed from petty cash, and the receipt served back byte for byte;
    - the float's top-up, and a count with its difference becoming the balance;
    - the ledger posting the claim against petty cash;
  - **intercompany:**
    - a recharge to a subsidiary seen as a payable there, one back, and an equal allocation (drafts hidden from the other side);
    - an outsider refused;
    - netted and settled from both sides;
    - a settled recharge not voidable;
    - both ledgers balancing, with the subsidiary's recharge expense;
  - **scorecard:**
    - targets set and copied from another month;
    - actuals and colours (revenue red, operating costs green, no target uncoloured);
    - six months of trend;
    - the e-mail settings and send checked.
- **Database:**
  - the least-privilege pins cover the eleven new tables;
  - the 099 rollback was checked.
- **Console:** the four tabs were checked in light and dark mode and at phone width, with no page errors.

**To confirm before live use:**
- **Chart of accounts:** the seeded chart against your chart of accounts. The asset and lease journals post to 1100 Bank; the gateway journal posts to its own bank code (default 1110).
- **Opening balances:** posted once, as a manual entry, before syncing months.
- **Expense policy:** the limits and the receipt amount.
- **KPI targets:** the targets and the amber band.
