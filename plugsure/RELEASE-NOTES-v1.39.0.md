# PlugSure CSMS v1.39.0: release notes

**Date:** 1 November 2026
**Base:** v1.38.0.

v1.39.0 is phase 28 of the finance work:
- statutory financial statements;
- corporate income tax and deferred tax;
- supplier payment runs;
- corporate cards and a spend policy.

- **Migration:** one, 107. It adds eight tables, two settings columns and two ledger sources. It is additive.
- **When nothing changes:** the statements and the tax computation only read the ledger. Nothing posts until a year's tax is finalised, a tax payment is recorded from an account, or card transactions exist.
- **Guide:** `deploy/FINANCE.md`, *Financial statements, corporate tax, payment runs and cards*.

## New

### Financial statements

The new Finance → **Financial statements** tab: the year's statements from the ledger, in a currency, with the year before beside them (Excel and PDF, for the auditors).

| Statement | What |
|---|---|
| Financial position | Current and non-current assets; current and non-current liabilities (loans, lease liabilities, deferred grants and deferred tax are non-current); equity: capital, retained earnings, the year's result |
| Profit or loss | Revenue, cost of energy, gross profit, operating expenses, other income and expense, the result before tax, income tax, the result |
| Cash flows (indirect) | The result, depreciation, deferred tax and each working-capital account; investing (fixed and right-of-use assets at cost); financing (loans, lease liabilities, capital) |
| Changes in equity | Opening, the result, capital movements, closing |
| Notes | Each line's accounts, both years |

- Every account belongs to exactly one cash flow line, so the total equals the change in cash and cash equivalents. The statements check it, and that the balance sheet balances.
- The ledger does not close a year: every earlier year's result is shown as retained earnings.
- An account not yet in the chart takes the type its code implies, also in the ledger's own reports.

### Corporate income tax and deferred tax

The new Finance → **Corporate tax** tab: the year's PPh Badan from the books.

**The computation:**
1. The commercial result before tax (the ledger).
2. Fiscal corrections:
   - **automatic:**
     - depreciation: book against fiscal, straight line over the tax groups' lives (IT 4 years; chargers, installation, equipment and vehicles 8; grid connections 16), from the month in service;
     - leases: the PSAK 73 depreciation and interest added back, the rent paid deducted;
     - the increase in the bad-debt allowance;
     - the increase in the loyalty liability;
   - **recorded:**
     - positive (not deductible): entertainment, donations, fines, benefits in kind;
     - negative: final or non-taxable income, losses carried forward.
3. The fiscal profit × 22% (settable). With **Article 31E** (turnover up to 50 billion rupiah), the share of the profit for 4.8 billion of turnover is taxed at half the rate. A loss pays none.
4. Credits: PPh 22 and 23 withheld by others, and PPh 25 paid. **PPh 29** is the tax less the credits (or the amount overpaid). Next year's PPh 25 is (tax − PPh 22 − PPh 23) ÷ 12.
5. **Deferred tax** at the year end: the temporary differences × the rate.
   - Fixed assets: book against fiscal net value (taxable).
   - Leases: the right-of-use asset against the lease liability.
   - The bad-debt allowance and the loyalty liability (deductible later).
   - The net is a liability (2710) or an asset (1470).

**Finalised** by a Finance Manager once the year has ended. The new ledger source, tax, then books in December:
- Dr 9100 current income tax / Cr 2700 corporate income tax payable;
- the PPh 25 credited (Cr 1460) and PPh 22/23 credited (Cr 1465);
- the deferred tax's change (1470 or 2710 against 9110 deferred income tax).

A finalised year keeps its figures and shows whether the books changed since. It is reopened to change.

**Tax paid:** PPh 25 and 29 paid from an account post in their month (Dr 1460 or 2700 / Cr bank) and appear in the cash position.

**The workpaper** for the SPT Tahunan, in Excel: the computation, the corrections, the tax paid and the deferred tax.

### Supplier payment runs

The new Finance → **Payment runs** tab: many bills paid at once.

1. **Propose** (PR-00001…) from a bank account, a payment day and a due-by day. The run takes every approved bill in the account's currency that has a balance, is due by then and is not in another open run.
2. **Adjust** while a draft: lower an amount, take a bill out.
3. **Submit**, then **approve** by a second Finance Manager who neither proposed nor submitted it (or send it back with a note).
4. **The bank file:** one transfer per supplier, as CSV. It comes generic, or laid out like BCA's or Mandiri's bulk transfer templates. Every supplier needs its bank account on file.
5. **Mark paid:** each bill gets its payment (bank transfer, the run's number, from the run's account), so payables, the cash position and the ledger follow. A bill that cannot be paid is listed with the reason.

### Corporate cards and spend policy

The new Finance → **Cards** tab.

- **Cards:** holder, bank, the last four digits only, currency, a single-transaction and a monthly limit, status (active, frozen, closed), and the account the statement is paid from.
- **Transactions:**
  - imported from the bank's CSV (date, merchant, amount, reference, category; a refund negative; lines already imported are skipped), or added;
  - a receipt each (an image or a PDF, up to 3 MB; its type checked).
- **Policy flags:**
  - over the single or the monthly limit;
  - at a weekend;
  - a blocked category or merchant;
  - no receipt at or above the amount set (100 000 by default);
  - a likely duplicate.
- **Review:**
  - nobody reviews their own card;
  - a flagged transaction is approved only by a Finance Manager, with a note;
  - personal spending is rejected and owed back by the holder.
- **Statements:** the bank's monthly total against the transactions (the difference shown), and its payment.
- **Ledger, the new cards source:** each month's spending by category (Dr the expense / Cr 2165 corporate cards payable; personal spending Dr 1480 receivable from employees); a statement paid, Dr 2165 / Cr bank.

### API

28 new operations (803 in all):

| Operation | Permission |
|---|---|
| `GET /v1/finance/financial-statements` (`year`, `currency`, `format=xlsx` or `pdf`) | `payment:read` |
| `GET /v1/finance/corporate-tax` (`year`, `currency`, `format=xlsx`) | `payment:read` |
| `PUT …/corporate-tax/settings`, `POST …/corrections`, `POST …/corrections/{id}/void`, `POST …/payments`, `POST …/payments/{id}/void` | `payment:write`, audited |
| `POST /v1/finance/corporate-tax/{year}/decide` | `payment:write` and `finance:approve`, audited |
| `GET /v1/finance/payment-runs`, `GET …/payment-runs/{id}` | `payment:read` |
| `POST /v1/finance/payment-runs`, `PUT …/{id}/items`, `POST …/{id}/submit`, `POST …/{id}/paid`, `POST …/{id}/cancel`, `GET …/{id}/bank-file` | `payment:write`, audited |
| `POST /v1/finance/payment-runs/{id}/decide` | `payment:write` and `finance:approve`, audited |
| `GET /v1/finance/cards`, `GET …/cards/transactions` (`format=xlsx`), `GET …/transactions/{tid}/receipt` | `payment:read` |
| `POST /v1/finance/cards`, `PUT …/cards/{id}`, `PUT …/cards/policy`, `POST …/cards/{id}/import`, `POST …/cards/{id}/transactions`, `PUT …/transactions/{tid}/receipt`, `POST …/transactions/{tid}/review`, `PUT …/cards/{id}/statements` | `payment:write`, audited (except the receipt) |

**Ledger:**
- two new sources: tax and cards;
- new accounts: 1460, 1465, 1470, 1480, 2165, 2700, 2710, 6380, 9100 and 9110.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **107**:
   - `corporate_tax_year`, `tax_fiscal_correction`, `tax_payment`, `payment_run`, `payment_run_item`, `corp_card`, `card_txn` and `card_statement`, with row-level security and no DELETE for the runtime role;
   - `finance_org_settings.corporate_tax` and `.card_policy`;
   - the ledger's new sources.
2. Optionally:
   - sync last year's months and read the statements;
   - record last year's fiscal corrections and tax paid;
   - add suppliers' bank accounts;
   - add company cards and set the policy.

**Rollback:**
1. Roll the code back to v1.38.0.
2. Export the tax computations, payment runs and card transactions.
3. Run `db/rollback/107_down.sql`. Supplier payments recorded by paid runs stay (they are the bills' payments); ledger entries from the tax and cards sources are superseded.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 5 of them new. They cover:
  - **helpers:**
    - the statements' lines;
    - the tax with and without Article 31E (and over its limit);
    - fiscal depreciation;
    - every card policy flag;
  - **statements:**
    - two years of postings: the balance sheet, profit or loss, cash flows (operating, investing, financing, both years) and equity, to the rupiah;
    - the balance and cash checks;
    - Excel and PDF;
  - **corporate tax:**
    - the automatic depreciation correction (book 15 million against fiscal 7.5 million);
    - recorded corrections;
    - Article 31E;
    - credits, PPh 29 and next year's PPh 25;
    - the deferred tax asset on the asset's difference;
    - finalising (a Finance Manager, an ended year), the December and the PPh 25 journals, a final year refusing changes, reopening;
  - **payment runs:**
    - proposed by due date, without bills in another open run;
    - amounts limited to the balance;
    - suppliers without a bank account listed;
    - approval by a second Finance Manager only;
    - the BCA-layout file;
    - paid with the run's reference, one bill part-paid;
    - its remainder free for a new run;
  - **cards:**
    - never the full card number;
    - the import, and a second import skipped;
    - each flag on its transaction;
    - a receipt checked and clearing its flag;
    - review refused on your own card and for a flagged one without a Finance Manager and a note;
    - personal spending owed back;
    - the statement matching;
    - the cards journal by category.
- **Database:**
  - the least-privilege pins cover the eight new tables;
  - the 107 rollback was checked.
- **Console:** the four new tabs were checked in light and dark mode and at phone width, with no page errors.

**To confirm before live use:**
- **Corporate tax:** the fiscal lives per asset category, the automatic corrections and the treatment of PPh 22/23 credits (posted against 1465, to clear against the receivables they were withheld from) with your tax advisor. The computation supports the SPT Tahunan; it does not replace it.
- **Bank files:** the BCA and Mandiri layouts against each bank's current bulk transfer template before the first upload.
- **Cards:** the receipt amount and the blocked categories and merchants for your policy.
