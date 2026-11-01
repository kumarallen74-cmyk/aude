# PlugSure CSMS v1.32.0: release notes

**Date:** 1 November 2026
**Base:** v1.31.0.

v1.32.0 is phase 21 of the finance work:
- bank feeds with match rules;
- PPh 21 and 26 withholding on supplier bills, with slips for e-Bupot;
- a management report pack;
- the month close as signed-off steps, with an evidence pack for the auditor.

- **Migration:** one, 100. It adds five tables, two settings columns, four supplier columns and a bill column. It is additive.
- **When nothing changes:** nothing changes until a feed, a rule, a supplier's tax kind, a pack or a sign-off is recorded. Existing suppliers stay companies (PPh 23 at their rate), and the close policy is off.
- **Guide:** `deploy/FINANCE.md`, *Bank feeds, withholding, report pack and close steps*.

## New

### Bank feeds and match rules

The new Finance → **Bank feeds** tab.

**Feeds.** A feed fetches a bank account's mutations every hour from an HTTPS endpoint: a small adapter in front of the bank's API, or an aggregator.
- **Request:** `GET <url>?from=YYYY-MM-DD`, with the token as a bearer. The fetch starts a few days before the last line (banks post late), else at the feed's start date, else 30 days back.
- **Answer:** `{ "transactions": [...] }`, or the list itself. Each transaction has a date, a description, an amount, and optionally a reference, a balance and a type. The amount is signed (money in above 0), or the type is CR or DB.
- **Storage:** new lines land on a statement of the account, exactly like an uploaded one, with the same fingerprint. A feed and an upload of the same days do not double up. Lines are then matched as usual.
- **Security:** the token is sealed and never shown again. Production URLs must be https, and the fetch refuses private addresses.

**Match rules** take what the automatic match left, in priority order; the first rule that fits wins.

| Part | What it is |
|---|---|
| When | direction (any, money in, money out), a text the description or reference contains, an amount range |
| Ignore | the line is marked ignored, with the rule's note (bank fees, transfers between own accounts) |
| Suggest | a journal entry to an account, waiting for approval in the Ledger: Dr bank / Cr the account for money in; Dr the account / Cr bank for money out. The line is matched to it. |

Rules run after every feed run and every upload, and can be applied or previewed by hand. A line in a locked month stays open for a person.

### Withholding: PPh 21, 23 and 26

A supplier now has a **tax kind**:

| Kind | Tax | What a bill withholds by default |
|---|---|---|
| Company | PPh 23 | the supplier's rate × the subtotal |
| Individual (not an employee) | PPh 21 | the Pasal 17 rates on 50% of the gross, per payment (PMK 168/2023): 5% to 60 million, 15% to 250 million, 25% to 500 million, 30% to 5 billion, 35% above; 20% more without an NPWP or NIK |
| Abroad | PPh 26 | the treaty rate when recorded (up to 20%), else 20% of the gross |

An individual can have a NIK (16 digits). A supplier abroad has a country and, optionally, a treaty rate. The amount can still be typed on the bill.

The new Finance → **Withholding** tab:
- **Draft from the bills:** one slip (bukti potong) per payee and kind for the month, from its approved bills. Drafts follow the bills. A draft whose bills are gone is voided.
- **Issue:** the slip gets its number (BP-*kind*-YYYYMM-NNNN, or the Coretax number when known) and date.
- **Issued slips:** an issued slip is not changed by bills recorded later. The draft says how many changed; void the slip and reissue it.
- **e-Bupot (Excel):** the month laid out for the import, with PPh 21 and 26 on one sheet and PPh 23 on the other.
- **Ledger:** PPh 21 posts to the new account 2151 and PPh 26 to 2152; PPh 23 stays on 2150.
- **Tax calendar:** two new obligations, *Pay PPh 21/26 withheld* (the 15th) and *File SPT Masa PPh 21/26* (the 20th), with the slips' amounts. PPh 23 slips add to the PPh 23 figures.

### Management report pack

The new Finance → **Reports** tab. A month's pack for the board or the owners, in the organisation's main currency:

| Section | What it shows |
|---|---|
| Results | profit and loss for the month and the year to date (the ledger), beside the budget |
| Cash | the position at the month's end; the 13-week view's lowest point and the first week below the minimum |
| Scorecard | each KPI against its target, green, amber or red |
| Sites | the five with the most revenue, and the three with the lowest margin |
| Payables | owed, overdue, due in 14 days, awaiting approval, the largest suppliers |

The figures are a snapshot taken when the pack is drafted. They can be refreshed while it is a draft, so the pack shows what was reviewed.

**Workflow:**
1. Each section takes commentary; the summary is required.
2. The pack is submitted for review.
3. It is approved by a Finance Manager who did not submit it. A reviewer can send it back with a reason. An approved pack is sent back only by a Finance Manager.
4. Once approved, it is e-mailed with the PDF and the Excel attached, to up to 20 recipients, through the organisation's e-mail channel.

### Close steps

The new Finance → **Close steps** tab. Each step of the month close is checked from the data:

| Step | Checks out when |
|---|---|
| Ledger synced | every module's entry for the month is posted |
| Journal entries approved | none is a draft or awaiting approval |
| Bank reconciled | every bank line of the month is matched or ignored |
| Anomalies reviewed | no finance check finding is open |
| Depreciation recorded | the month's run is recorded (when assets are in service) |
| Leases recorded | the month's journal is recorded (when there are leases) |
| Withholding slips issued | no draft slip; every withholding bill is on a slip |
| Energy bills in, exchange rates in | as in the v1.22.0 checklist |

**Signing off:**
- Anyone with `payment:write` signs off a step that checks out.
- A step that does not check out is *accepted as is* only by a Finance Manager, with a note.
- A sign-off can be withdrawn while the month is open.

**Policy:** when the close policy is enforced (a Finance Manager sets it), a month is locked only once every step is signed off.

**Evidence pack** (Excel), for the auditor:
- the steps, with their checks and sign-offs;
- the sign-off and lock history;
- each currency's trial balance;
- the month's finance actions from the audit log.

The Financial Auditor role (read-only) can read the close and download the pack. Downloads are audited.

### API

Twenty-seven new operations (637 in all):

| Operation | Permission |
|---|---|
| `GET /v1/finance/bank-feeds` | `payment:read` |
| `POST /v1/finance/bank-feeds` | `payment:write`, audited |
| `PUT /v1/finance/bank-feeds/{id}` | `payment:write`, audited |
| `POST /v1/finance/bank-feeds/{id}/run` | `payment:write`, audited |
| `POST /v1/finance/bank-rules` | `payment:write`, audited |
| `PUT /v1/finance/bank-rules/{id}` | `payment:write`, audited |
| `GET /v1/finance/bank-rules/preview` | `payment:read` |
| `POST /v1/finance/bank-rules/apply` | `payment:write`, audited |
| `GET /v1/finance/tax/slips` | `payment:read` |
| `POST /v1/finance/tax/slips/{month}/draft` | `payment:write`, audited |
| `GET /v1/finance/tax/slips/{month}/ebupot` | `payment:read` |
| `POST /v1/finance/tax/slips/{id}/issue` | `payment:write`, audited |
| `POST /v1/finance/tax/slips/{id}/void` | `payment:write`, audited |
| `GET /v1/finance/report-packs` | `payment:read` |
| `PUT /v1/finance/report-packs/settings` | `payment:write`, audited |
| `POST /v1/finance/report-packs` | `payment:write`, audited |
| `GET /v1/finance/report-packs/{id}` (`format=pdf`, `xlsx`) | `payment:read` |
| `PUT /v1/finance/report-packs/{id}/commentary` | `payment:write` |
| `POST /v1/finance/report-packs/{id}/submit` | `payment:write`, audited |
| `POST /v1/finance/report-packs/{id}/send-back` | `payment:write` (`finance:approve` once approved), audited |
| `POST /v1/finance/report-packs/{id}/approve` | `finance:approve`, not the submitter, audited |
| `POST /v1/finance/report-packs/{id}/send` | `payment:write`, audited |
| `GET /v1/finance/close` | `payment:read` |
| `PUT /v1/finance/close/policy` | `finance:approve`, audited |
| `GET /v1/finance/close/{month}/evidence` | `payment:read`, audited |
| `POST /v1/finance/close/{month}/steps/{step}/sign-off` | `payment:write` (`finance:approve` to accept as is), audited |
| `POST /v1/finance/close/{month}/steps/{step}/revoke` | `payment:write`, audited |

Changes to existing operations:
- **Suppliers:** they accept `taxKind`, `idNumber`, `country` and `treatyRatePct`.
- **Bills:** they show `whtKind`.
- **Bank statement upload:** it answers with the rules' results.
- **Month lock** (`POST /v1/finance/periods/{month}/lock`): it answers 409 while the close policy is enforced and steps are not signed off.

New worker: `bank-feeds`, every hour.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **100**:
   - `bank_feed`, `bank_match_rule`, `tax_slip`, `report_pack` and `close_signoff`, with row-level security and no DELETE for the runtime role;
   - `supplier.tax_kind` (default company), `id_number`, `country` and `treaty_rate_pct`;
   - `supplier_bill.wht_kind` (default pph23);
   - `gl_entry` as a bank line match;
   - the close policy and report pack settings.
2. Optionally:
   - set each individual's and foreign supplier's tax kind;
   - add the bank feeds and the match rules;
   - set the report pack recipients;
   - enforce the close policy;
   - give the external auditor the Financial Auditor role.

**Rollback:**
1. Roll the code back to v1.31.0.
2. Export the slips (e-Bupot), the packs (PDF) and the close evidence.
3. Run `db/rollback/100_down.sql`.

Lines a feed imported stay. Lines a rule matched to a journal entry go back to unmatched.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 5 of them new. They cover:
  - **helpers:**
    - the Pasal 17 bands;
    - PPh 21 on half the gross, and 20% more without an id;
    - PPh 26 at the treaty rate or 20%;
    - rules fitting by direction, text and amount;
    - feed parsing (signed amounts and CR/DB types, lines that cannot be read skipped, an answer that is not JSON refused);
  - **bank feeds:**
    - the token sealed, sent as a bearer and never returned;
    - three lines fetched, then nothing new on a second run, fetched from a few days before the last line;
    - a bank fee ignored by a rule;
    - interest suggested as a journal entry (bank against 7300) awaiting approval;
  - **withholding:**
    - PPh 21, 26 and 23 on bills by the supplier's kind;
    - three slips drafted and one issued;
    - a later bill leaving the issued slip unchanged, then the slip voided and redrafted;
    - the e-Bupot workbook;
    - the tax calendar's PPh 21/26 amount;
    - the ledger posting 2150, 2151 and 2152;
  - **report pack:**
    - an ended month only;
    - the summary needed before submitting;
    - not approved by the submitter, nor without finance:approve;
    - final once approved;
    - the PDF and Excel;
    - the recipients checked, and sending without an e-mail channel refused;
    - sent back with the reason;
  - **close steps:**
    - a failing step accepted only by a Finance Manager with a note;
    - the lock refused under the policy until every step is signed off;
    - a withdrawn sign-off;
    - the lock;
    - no change once locked;
    - the evidence pack.
- **Database:**
  - the least-privilege pins cover the five new tables;
  - the 100 rollback was checked.
- **Console:** the four tabs were checked in light and dark mode and at phone width, with no page errors.

**To confirm before live use:**
- **PPh 21 for individuals:** have a tax adviser confirm the per-payment basis. PMK 168/2023 applies to non-employees who are not paid continuously; continuing payments to the same person may need the cumulative method.
- **Tax object codes:** fill them in the e-Bupot workbook (the column is left empty).
- **Treaty rates:** record them only with the payee's certificate of domicile.
- **Bank feed endpoint:** the adapter's answer format, and its time zone for dates.
- **Report pack:** the figures depend on the ledger. Sync the month before drafting.
