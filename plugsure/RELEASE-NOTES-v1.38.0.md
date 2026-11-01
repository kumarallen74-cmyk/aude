# PlugSure CSMS v1.38.0: release notes

**Date:** 1 November 2026
**Base:** v1.37.0.

v1.38.0 is phase 27 of the finance work:
- owner and partner finance;
- treasury FX and hedging;
- procurement analytics;
- finance close automation.

- **Migration:** one, 106. It adds four tables, a settings column and one ledger source. It is additive.
- **When nothing changes:** the new tabs only read until hedges, savings or close owners are recorded. Automatic close runs are off until turned on. The fx journal appears in the ledger only for hedges settled.
- **Guide:** `deploy/FINANCE.md`, *Owner finance, FX and hedges, procurement and close automation*.

## New

### Owner and partner finance

The new Finance → **Owner finance** tab, and a new *Your sites' results* card in the owner portal (Payouts).

**For each site owner**, over the last 3, 6 or 12 whole months, per month:
- the owner's sites: sessions, kWh and charging revenue (Margin);
- the finalised statements: the gross, the operator's commission, the owner's share, what was paid, what is still owed;
- per site, the period's sessions, kWh and revenue;
- open queries and what they claim.

**The operator's view:** every owner with its sites, share, paid and outstanding, the oldest statement unpaid and open queries, sorted by what is owed.

**In the portal,** the owner downloads:
- the results in Excel;
- a **year pack**: the statements, payments and monthly site results as CSV, a README and a manifest with each file's SHA-256 (also in the `x-manifest-sha256` header). Each download is audited.

### Treasury FX and hedging

The new Finance → **FX & hedges** tab.

**The exposure** at a day, per currency other than the reporting one:

| Line | From |
|---|---|
| Cash and bank | Cash position |
| Receivables | Fleet invoices issued and unpaid |
| Payables | Approved supplier bills unpaid |
| Loans | Outstanding (Lenders) |
| Hedges | Open forwards: the currency bought +, the currency sold − |

- Gross = cash + receivables − payables − loans; net adds the hedges; the share hedged is how much of the gross the hedges offset.
- Net in the reporting currency at the month's rate (Settings → Currencies).
- The revaluation: the net × the change since the previous month's rate.
- The effect of a 10% move.

**Hedges:** forward contracts with a bank:
- buy a notional of one currency against another at a contract rate (one unit bought, in the currency sold), traded on a date, maturing on a date, settled to an account in the currency sold;
- open ones are marked to market at the month's rate (cross rates from both currencies' rates);
- **settled** net, as a non-deliverable forward: the realised result, notional × (rate of the day − contract rate), in the currency sold;
- or cancelled (nothing posts).

**Ledger, the new fx journal:** each hedge settled in the month. A gain: Dr bank / Cr 7400 FX gains. A loss: Dr 8400 FX losses / Cr bank. The settlement also moves the account's balance in the cash position.

### Procurement analytics

The new Finance → **Procurement** tab, over 3, 6 or 12 whole months.

- **Spend:** approved and paid supplier bills (before VAT) per supplier, category and month; the top supplier's and top five's share.
- **Prices:**
  - spare parts: each item's unit cost on receipt, first against last;
  - energy: each site's cost per kWh from its energy bills;
  - a rise over 10% is flagged.
- **Supplier scorecards:**

| Measure | From |
|---|---|
| On time | Approved orders whose last goods receipt is by the expected date (an order not received and past its date is late to today) |
| Days late | The average |
| Bills rejected | The share of the supplier's bills |
| Paid on time | Bills paid by their due date |

The score is the average of the measures present, each 0–100 (a day late costs 5 points): **A** from 90, **B** from 75, **C** from 60, else **D**.

- **Savings register:** a negotiated saving's price per unit before and after and the quantity expected over a period. Expected = (before − after) × quantity; to date, by the share of the period passed. Voided, not deleted.

### Finance close automation

The new Finance → **Close automation** tab, on top of the month close (Close steps).

**A run**, for an ended month not locked:
1. fetch the ECB rates still missing, when a reporting currency is set;
2. record depreciation and the lease journal, when not yet recorded;
3. sync the ledger (every module's journal);
4. run the finance checks;
5. record each close step whose check still fails as blocking.

Each action's result (done, skipped or its error) is kept with the run. Nothing is signed off or locked: people do that.

**Automatic:** from a working day after the month's end (1 by default), the worker runs the previous month once a day until it is locked.

**Owners:**
- each step has an owner and a due working day after the month's end (3 by default; Monday to Friday);
- the calendar shows each step's due date, owner, check and sign-off;
- `finance.close_step_overdue` is raised for a step not signed off by its date, and resolved once it is or the month is locked.

**The trend:** the days from each month's end to its lock, over the last twelve months locked, with the average and the best.

### API

15 new operations (775 in the public specification; the owner portal's two are internal):

| Operation | Permission |
|---|---|
| `GET /v1/finance/fx-exposure` (`date`, `format=xlsx`) | `payment:read` |
| `GET /v1/finance/fx-hedges` (`month`) | `payment:read` |
| `POST /v1/finance/fx-hedges`, `PUT …/fx-hedges/{id}` | `payment:write`, audited |
| `GET /v1/finance/procurement` (`months`, `to`, `format=xlsx`) | `payment:read` |
| `POST /v1/finance/procurement/savings`, `POST …/savings/{id}/void` | `payment:write`, audited |
| `GET /v1/finance/close-automation` (`month`) | `payment:read` |
| `PUT /v1/finance/close-automation/settings`, `PUT …/owners`, `POST …/run` | `payment:write`, audited |
| `GET /v1/finance/owner-finance`, `GET /v1/finance/owners/{oid}/finance` (`format=xlsx`) | `payment:read` |
| `GET /v1/owner-portal/finance` (`format=xlsx`), `GET /v1/owner-portal/finance/pack` (`year`) | The site owner's portal sign-in; the pack audited |

**Ledger:** a new source (fx) and new accounts 7400 and 8400.

**New worker:** `close-automation`, every 6 hours.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **106**:
   - `fx_hedge`, `procurement_saving`, `close_assignment` and `close_run`, with row-level security and no DELETE for the runtime role;
   - `finance_org_settings.close_automation`;
   - the ledger's new source.
2. Optionally:
   - set the month's rates and record open forwards;
   - record negotiated savings;
   - give the close steps owners and due days, and turn automatic runs on;
   - route `finance.close_step_overdue`.

**Rollback:**
1. Roll the code back to v1.37.0.
2. Export the hedges and the savings register.
3. Run `db/rollback/106_down.sql`. Ledger entries already posted from settled hedges stay (re-sync the month after the rollback to supersede them).

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 5 of them new. They cover:
  - **helpers:**
    - cross rates and hedge results;
    - grades and scores;
    - savings to date;
    - working days after a month end (a Saturday month end) and days to close;
  - **FX:**
    - the exposure from cash, payables and a hedge, at the month's rate, with the revaluation and a 10% move, to the rupiah;
    - a hedge marked to market;
    - a gain and a loss settled, a cancellation, the fx journal (7400, 8400) posted by the ledger sync;
    - the settlement account's balance;
    - a settlement account in the wrong currency refused;
  - **procurement:**
    - spend without rejected bills and the top supplier's share;
    - a part's 15% rise and energy per kWh up 20%;
    - a scorecard (50% on time, 2.5 days late, 50% rejected, 100% paid on time: 72, C);
    - a saving recorded, totalled and voided;
  - **close automation:**
    - a run with its actions and what blocks;
    - not before the month ends, not once locked;
    - owners checked against the organisation's users;
    - the calendar's due dates;
    - the automatic run once a day;
    - an overdue alert naming the owner, resolved once the month is locked;
    - the days-to-close trend;
  - **owner finance:**
    - an owner's month to the rupiah (revenue, share, paid, owed) and open queries;
    - the operator's view with the oldest statement unpaid;
    - the portal's view and its year pack with the manifest hash.
- **Database:**
  - the least-privilege pins cover the four new tables;
  - the 106 rollback was checked.
- **Console:** the four new tabs and the owner portal's card were checked in light and dark mode and at phone width, with no page errors.

**To confirm before live use:**
- **Hedge accounting:** settled forwards post their result to profit and loss; open ones are shown marked to market but not booked. Confirm with your auditors whether PSAK 71 hedge accounting (or month-end revaluation entries) is needed.
- **Close due days:** working days count Monday to Friday; public holidays are not left out.
