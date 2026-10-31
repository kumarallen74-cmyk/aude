# Finance (Xendit)

From v1.12.0, **Commercial → Finance** shows the payment gateway's side of the
money for each Xendit payments account:

- what Xendit **collected**;
- what it charged in **fees and VAT**;
- what it has **settled** to the bank, and what is still to come;
- what is **owed back** (refunds) or **out** (site owners' shares).

All of it is matched against PlugSure's own payments.

From v1.13.0 the **Duitku fallback account** appears too. Its ledger is built
from PlugSure's Duitku payments, with Duitku's fee and an estimated
settlement date ([DUITKU.md](DUITKU.md#finance)).

## Who sees what

| Account | Seen by |
|---|---|
| PlugSure's own Xendit account (Integrations → Payments, platform) | Platform administrators with `payment:read`. It takes the payments of every operator without its own account. |
| An operator's own Xendit account (Integrations → Payments → Your account) | That operator's users with `payment:read` (Super Admin, CPO Operations Manager, Finance). Never another operator. |

Reading needs `payment:read`. Syncing, applying a payment and resolving a
difference need `payment:write`. Every action is audited (`finance.*`).

## Setup

Nothing beyond the Xendit payments account itself.

1. **Key permissions.** In the Xendit dashboard (Settings → API keys), the
   secret key saved in PlugSure needs **read** permission for:
   - **Balance**;
   - **Transactions** (also listed as "Report" or "Balance history" on some
     dashboards).

   The money-in permissions it already has for payments stay as they are.
2. **First sync.** Within 15 minutes the first sync reads the **last 35
   days**; after that, only what changed. *Sync now* on the Finance page does
   it at once.

No migration step beyond `npm run migrate` (migration **080**), and no new
settings.

## The page

| Tab | Shows |
|---|---|
| **Overview** | For the period: collected, fees incl. VAT (and the effective rate), refunds, **net** (collected − fees − VAT − refunds), settled. Now: **receivable** (paid, not yet settled, with the overdue part), the **balance** at Xendit, refunds due. A daily chart; by channel; the next settlement dates. |
| **Payments** | Xendit's ledger, one row per transaction: payment, refund, payout or transfer, with amount, fee, VAT, net, status and settlement status (*to settle* with the expected date, *settled*). Each row is matched to PlugSure's payment, membership pass or refund. Filters and search. |
| **Receivables** | Money paid by drivers and not yet settled to the bank, by expected settlement day (overdue flagged), and the payments themselves. For an operator, its fleet invoices issued and not paid. |
| **Payables** | Refunds due on payments this account took. Each shows the e-wallet's **refund window**: OVO 90 days, DANA 30, ShopeePay 365, LinkAja 30, GoPay 30; past it, a refund goes by bank transfer. From v1.14.0, the site owners' shares on finalised statements, each *due*, *part-paid* or *paid*, with the payouts recorded against them (below). |
| **Fees** | Fees, VAT on fees and withholding tax by month and channel, with the rate. Also the QRIS fees Xendit actually charged against PlugSure's estimate (the MDR on owner statements). |
| **Reconciliation** | Differences between Xendit and PlugSure (below). |

The **period** (this month, last month, 30 or 90 days, or any dates up to 400
days) applies to every tab and to the exports. Days are in the platform time
zone (WIB).

### Exports

| Format | Contents |
|---|---|
| **Excel** (.xlsx) | Summary, By channel, Fees, Transactions; (v1.15.0) then **By operator** (collected, fees, VAT, refunds, net, owners' shares and paid) and **By site**. |
| **CSV** | Every transaction, UTF-8 with a BOM, so Excel opens it with the right characters. |
| **PDF** | The summary, by channel, (v1.15.0) by operator and by site, fees by month, then every transaction. For the monthly close. |

## Payouts and statement payments (v1.14.0)

PlugSure moves no money: the operator's bank makes the transfers. Finance
records them, so it shows what is still owed.

- **Owners' shares** (Payables). Each finalised commission statement owes its
  site owner the owner's share. Record each transfer you made:
  - **Record payout**: the amount, the date, the bank reference and a note.
    A part payment leaves the share *part-paid*. PlugSure refuses an amount
    above what is outstanding, and a date in the future.
  - **Void**, with a reason, a payout recorded by mistake. Payouts are never
    deleted; a voided one stays in the statement's history.
- **Owners' bank details.** Per owner: the bank, an optional bank code (for
  the bank's bulk-transfer file, e.g. 014 for BCA), the account holder and the
  account number.
  - The number is sealed with `SECRETS_KEY`. The console and the API show
    only its last four digits.
  - Leave the number empty when editing to keep the saved one.
- **Transfer list** (CSV). What is owed, one line per statement not fully
  paid: the owner, bank, bank code, holder, the **full** account number, the
  outstanding amount (minor units of the currency), the statement and a
  description (`PlugSure <statement>`), for the bank's bulk transfer.
  Downloading it needs `payment:write` and is audited.
- **Operators' statements to PlugSure** (Receivables, platform administrators,
  on the platform account). The statement total each operator owes PlugSure,
  with the payments received recorded the same way.

| Who | Can |
|---|---|
| `payment:read` | See owners' shares, payments and masked bank details. |
| `payment:write` | Record and void payouts, save bank details, download the transfer list. |
| `platform:admin` | See operators' statements and record their payments to PlugSure. |

Each record, void, bank-details change and transfer-list download is in the
audit log (`finance.owner_payout_recorded`, `finance.platform_fee_recorded`,
`finance.statement_payment_voided`, `finance.owner_bank_account_saved`,
`finance.transfer_list_exported`).

## Refunds, statements and the month close (v1.15.0)

- **Refunds page.** Each refund shows the gateway's **refund window** for its
  channel and what is left of it: Xendit OVO 90 days, DANA 30, ShopeePay 365,
  LinkAja 30, GoPay 30, **QRIS 7** (Xendit's QRIS table; confirm with Xendit).
  Outstanding refunds whose window closes soonest come first; a KPI counts those
  closing within 7 days. Past the window, a refund goes by bank transfer.
- **QRIS refunds at Xendit** go through the gateway now (they were bank
  transfers): full, or partial where the payer's issuer allows it (DANA,
  ShopeePay, OVO; not LinkAja). A refusal (for example
  `PARTIAL_REFUND_NOT_SUPPORTED`) is shown in words and the refund can then be
  paid by bank transfer.
- **Fees on refunds.** From the ledger: the refund's status at the gateway and
  its refund fee; and, on a partial refund or one made more than 24 hours after
  the payment, the payment's own fee, which Xendit does not return.
- **Duitku refunds** can be sent through Disbursement, with two people
  ([DUITKU.md](DUITKU.md), *Refunds*).
- **Actual MDR on statements.** Owner statements drafted (and finalised) from
  v1.15.0 deduct the gateway's **actual** fee and VAT on the fee for every QRIS
  payment synced here, and PlugSure's estimate only for the rest. The statement
  says which (*actual*, *estimated*, or both with the split). Statements
  already finalised do not change.
- **By operator** on the Overview, and **By operator / By site** in the exports:
  the period's collected, fees, VAT, refunds and net per operator and site, with
  the owners' shares on statements finalised for months starting in the period.
- **Receivables** also show post-pay sessions not charged yet; on the platform's
  account, PlugSure Hub fee invoices unpaid; on an operator's, Hub settlement
  positions owed to it. **Payables** show the Hub positions an operator owes.

## Trail, method costs, owner payouts and Xendit reports (v1.16.0)

- **Trail.** In **Payments** (and Receivables), click a row: a drawer shows the
  gateway transaction and its raw record (the payer's details masked), the other
  rows of the same payment (its refunds), PlugSure's payment with its state
  history and refund, the charging session (site, charger, energy, the driver's
  number masked) with its receipt, Disbursement refund transfers, the membership
  pass it paid, and reconciliation differences.
- **What each method costs** (Fees tab). Per gateway account you can see, over
  the period: payments, the average fee and VAT per payment, the effective rate
  and the cost per 100,000 rupiah collected; the lowest per method is marked.
  For a Duitku account, also what Duitku quotes today for 100,000 rupiah, for
  methods not used yet.
- **Owner payouts through Duitku Disbursement** (Payables). With Disbursement
  on the operator's **own** Duitku account, **Send via Disbursement** on an
  owner's share (due or part-paid):
  1. the amount (up to what is outstanding) goes to the owner's saved bank
     account, which needs the bank code; Duitku returns the holder's name;
  2. a **second person** approves it (never the requester), within the payout
     limits (largest payout, default 50,000,000 rupiah; all payouts approved in
     a day, default 100,000,000), with what is outstanding checked again;
  3. when Duitku confirms it, the payout is **recorded against the statement**
     (reference *Duitku Disbursement <id>*), so the share is part-paid or paid.
     Not confirmed: asked again by the worker; after a day the operator is
     alerted and it can be settled by hand.

  The platform's Duitku account never pays an operator's owners. Recording a
  payout your bank made (v1.14.0) works as before.
- **Xendit reports** (the *Xendit reports* button, Xendit accounts): ask Xendit
  to generate its own report for the period, as CSV: transactions, balance
  history, or upcoming settlements (the next 30 days). It is ready in a few
  minutes; **Download** asks Xendit for a fresh link. The secret key needs
  Xendit's **Report** permission. Requests and downloads are audited.

## Accounting journal, monthly close e-mail and Xendit payouts (v1.17.0)

- **Journal** (the *Journal* button; Excel by default, also CSV). The period as
  double-entry entries, one per day and kind, every entry balanced:

  | Kind | Debit | Credit |
  |---|---|---|
  | Collections | Gateway balance (1130) | Charging revenue (4100) |
  | Gateway fees | Gateway fees (6110), VAT input on fees (1410) | Gateway balance |
  | Withholding tax, as the gateway reports it | Gateway balance | Withholding tax payable (2140) |
  | Refunds through the gateway | Refunds to drivers (4190) | Gateway balance |
  | Withdrawals to the bank | Bank (1110) | Gateway balance |
  | Owner payouts recorded | Owners' shares payable (2120) | Bank |

  The codes in brackets are PlugSure's defaults: set your chart of accounts in
  **Finance → Settings**. The *By account* sheet nets to zero. Check the
  treatment of withholding tax and of revenue (gross of taxes) with your
  accountant.
- **Monthly close e-mail** (Finance → Settings). On the 1st of each month
  (platform time zone), the previous month's finance export (Excel and PDF)
  and the journal go to up to 10 recipients, through your e-mail channel
  (Govern → Alert routing → Channels). Each month is sent once; a failure is
  shown in Settings and retried hourly. **Send last month now** sends it at
  once.
- **Xendit payouts.** On the Xendit integration (Payments → advanced), *Send
  refunds and owner payouts through Xendit Payouts* (the secret key needs the
  **Money-out write** permission) with its limits. Then:
  - refunds of Xendit payments, for example a card or a QRIS payment past its
    refund window, can be sent to the driver's bank account from the Refunds
    page;
  - owners' shares can be sent from Payables (Xendit first when both Xendit and
    Duitku are set up; choose in the dialog).

  The same two-person approval and limits apply. Xendit does not check the
  account holder's name (the approver sees the name entered). Bank codes
  (014 BCA, 008 Mandiri, 002 BRI, 009 BNI, …) map to Xendit's channels, or
  enter Xendit's own (ID_BCA). Xendit's *SUCCEEDED* records the refund or
  payout; *FAILED*, *CANCELLED* or *REVERSED* makes it due again.

## Bank statements, approval alerts, payout callbacks and tax (v1.18.0)

- **Bank** (tab). Upload the operator's bank statement as the bank's CSV
  export: BCA (one amount column with CR / DB), Mandiri (debit and credit),
  BRI, or any bank whose export has a date, a description and an amount (or
  debit and credit) column with headings. PlugSure reads the lines and
  matches each one to what should appear on the account:

  | Line | Matched to |
  |---|---|
  | credit | a withdrawal from the gateway to the bank (Finance's ledger) |
  | debit | an owner payout recorded against a statement |
  | debit | a refund paid by bank transfer (recorded by hand) |
  | credit (platform administrators) | an operator's payment of PlugSure's statement |

  A line matches a record of the same amount within 4 days; a reference
  found in the description wins. Uploading an overlapping period skips the
  lines already there. **Match** an open line by hand (the nearest
  amounts and dates are offered), or ignore it with a note (a bank fee,
  another business); **Undo** reopens it. A record matches one line only.
  Uploads and matches are audited.
- **Approval alerts.** A refund or owner payout waiting for a second person
  raises the alert *finance.transfer_awaiting_approval*; route it to the
  people who approve (Govern → Alert routing: e-mail, WhatsApp, SMS). Waiting
  more than 24 hours, a critical alert follows
  (*finance.transfer_approval_overdue*). Both resolve when the transfer is
  approved or rejected. Refunds and Finance show the number waiting as a
  badge.
- **Payout callbacks.** Xendit's *payout.** events and Duitku Disbursement's
  callback, at the account's notification URL, settle a sent transfer in
  seconds instead of at the next 5-minute check. The callback only names the
  transfer: PlugSure asks the gateway for the result itself, so a forged
  callback cannot mark anything paid. In Xendit's dashboard, set the payout
  callback URL to the same `/pay/notify/<key>` URL as payments.
- **Tax** (tab).
  - *PPh 23.* An operator that withholds PPh 23 withholds 2% of the services
    it pays for. Per month, the tab suggests the base and 2% for the
    gateway's fees (on the operator's own gateway accounts, from Finance's
    ledger, excluding VAT) and for PlugSure's platform fee (its statements to
    the operator, before PPN). **Record** what was withheld, with the bukti
    potong's number and date (or add it later); a mistaken record is voided
    with a reason. **CSV** exports the year's records for the tax adviser.
    Platform administrators see what operators recorded on PlugSure's fee.
  - *e-Faktur for PlugSure's fee* (platform administrators). A month's
    finalised platform statements with PPN as Coretax's import XML, the same
    format as fleet invoices: PlugSure the seller (`BILLING_ISSUER_NPWP` on
    the API), each operator the buyer (the NPWP on its
    organisation record), PPN on DPP nilai lain. Operators without a valid NPWP are
    left out and counted.

  The tax treatment is the operator's and its adviser's: Finance prepares
  the figures and files nothing.

## Forecast, fee audit, accounting export and the owner portal (v1.19.0)

- **Forecast** (tab). The next 30, 60 or 90 days.
  - *Opening position:* the gateway's last balance plus the bank balance on
    the last uploaded statement.
  - *In:* expected settlements, fleet invoices, Hub positions and post-pay
    sessions.
  - *Out:* refunds due, owners' shares and PlugSure's statements not paid in
    full, due at finalisation plus the payment terms (14 days by default).
  - *Result:* the position by day and the first shortfall. *Add the run rate*
    includes the last 28 days' average collections as an estimate.
- **Fee audit** (Fees tab). First enter the rates agreed with the gateway
  under Settings → *Contracted rates*: per method, a percentage, a fixed
  fee, a minimum and the amount up to which it is free. Every payment's fee
  (excluding VAT) is then checked against them:

  | Case | Expected fee |
  |---|---|
  | amount ≤ free-up-to | 0 |
  | otherwise | max(minimum, amount × % + fixed) |

  An overcharge counts above 1 rupiah. *Claim (CSV)* lists the overcharged
  payments with the gateway's ids.
- **Accounting software** (Settings). Choose Jurnal.id, Accurate Online or a
  generic CSV; **Export** turns a closed month's journal into the package's
  import file. Each export is logged. Check the first import against the
  package's template.
- **Owner portal.** Site Owner users see **Payouts**: what was paid against
  each statement and what is still due, and the bank account on file
  (masked). They can ask for a new account. The request is sealed until
  someone in **Finance → Payables → Bank detail changes** approves it (the
  account on file is then replaced) or rejects it with a reason. Confirm
  every change with the owner by phone first: changed bank details are how
  payouts get stolen.

## Margin, budgets, collections and the audit pack (v1.20.0)

- **Margin** (tab). Per site and month:

  | Figure | What it is |
  |---|---|
  | revenue | what drivers paid, before tax |
  | kWh | energy delivered |
  | energy cost | the month's electricity bill (*Record bill*), else the site's cost per kWh (*Cost/kWh*, its PLN tariff with taxes) × kWh, shown as an estimate |
  | margin | revenue − energy cost |

  A bill's kWh beside the kWh delivered shows losses. The bill is split
  between the site's chargers by kWh.
- **Budgets** (tab). Set a month's budget for the organisation (revenue,
  energy cost, gateway fees, owners' share) or a site (revenue and energy
  cost).
  - Actuals are shown beside it with the variance.
  - *Copy to the next 12 months* repeats it.
  - From the 7th, an alert (`finance.budget_off_track`) fires when the month
    so far is off by more than the threshold (15% by default).
- **Collections** (tab). What customers owe, by age: unpaid fleet invoices
  and, for platform administrators, operators' statements.
  - *Note* records a call or a promise to pay; a future promise pauses
    reminders.
  - *Remind* sends one now. *Settings* turns on the schedule: by default 3
    days before, then 7, 14 and 30 days after the due date. The latest step
    reached is sent once per channel. WhatsApp needs an approved template
    with three parameters: customer, document and amount, due date.
  - *Write off* asks a second person to approve; once approved it leaves
    collections. The invoice is unchanged, so book the bad debt in your
    accounts.
- **Audit pack** (button). The period's records as one ZIP:
  - journal, ledger, statements, payments, transfers, bank lines, tax,
    write-offs and the audit log as CSV;
  - `manifest.json` with each file's SHA-256 and the audit chain's check;
  - a README on verifying the checksums.

## Summary, currencies, approvals and report e-mails (v1.21.0)

- **Summary** (first tab). Per currency:
  - revenue this month, against last month to the same day and last year;
  - margin;
  - what customers owe, and DSO (owed ÷ the last 90 days' revenue per day);
  - cash (gateway balances plus the last bank statement);
  - the fee and refund rates over 30 days;
  - 12-month trends.

  With a reporting currency set, consolidated totals come first.
- **Currencies** (Settings). Choose the reporting currency, then for each
  month and other currency enter a rate (1 MYR = n IDR) or *Fetch ECB
  rates*. A currency without a rate is listed beside the consolidated
  total, never counted at 1.
- **Approvals** (Settings). Give your finance lead the **Finance Manager**
  role (Govern → Users); it carries `finance:approve`. Then choose, for
  refunds, owner payouts, write-offs and owner bank-detail changes:
  - *A Finance Manager* above an amount: the approver must hold
    `finance:approve`.
  - *Two approvers* above an amount: two different people, neither the
    requester. The first approval shows *1 of 2 approved*.

  Only a Finance Manager (or owner) can change these rules.
- **Report e-mails** (Settings). *New schedule* picks reports (summary,
  margin, collections, budgets, forecast), weekly (a weekday, from 07:00)
  or monthly (the 1st, for the month just ended), and up to 10 recipients.
  It sends one Excel workbook through your e-mail channel. *Send now* tries
  it at once.

## Reconciliation

Every 6 hours, and on *Sync now*, PlugSure compares the last 35 days of
Xendit's ledger with its payments.

| Difference | Meaning | What to do |
|---|---|---|
| **Paid at the gateway, not in PlugSure** | Xendit took the money but PlugSure never received the notification (its payment is still pending or expired), or the payment is not PlugSure's at all. | **Apply payment**: PlugSure applies it exactly as the lost notification would have been, including a refund if the charge can no longer start. A payment that is not PlugSure's (no `ps-` reference) is resolved with a note. |
| **Paid in PlugSure, not found at the gateway** | Should not happen. | Check the payment in the Xendit dashboard; resolve with what you found. |
| **Amount differs** | Xendit's amount is not the amount PlugSure recorded. | Check both; refund the difference if needed. |
| **Pending more than a day** | A transaction stuck at Xendit. | Ask Xendit support. |
| **Settlement overdue** | A day past Xendit's expected settlement date and still not settled. | Ask Xendit support (QRIS and e-wallets settle in about 2 working days, cards in about 5). |
| **Refund status differs** | A refund succeeded at Xendit but is not refunded in PlugSure, or the reverse. | Check the refund on the Refunds page. |

A difference that is put right closes itself on the next pass, with the note
*Cleared*: for example, a late notification, a settlement or a corrected
refund. Others are closed with **Resolve**, with a note of what was done.

While differences are open, the account's organisation gets one alert: *Payments differ from the gateway*. For PlugSure's own account it goes to the platform operator, like other platform alerts. The alert resolves when none are left open.

## How it works

- **Sync.** Every 15 minutes the sync calls `GET /transactions`, asking for
  everything updated since the last run, minus 10 minutes of overlap. It
  follows Xendit's pages (`after_id`), up to 2,000 transactions a run. A
  longer backlog continues from its cursor on the next run.
- **Ledger.** Each transaction is stored in `gateway_transaction` with
  Xendit's fee, VAT, withholding tax, net amount and settlement status.
  - It is matched by the reference PlugSure gave Xendit (`ps-…`, the
    payment's `provider_ref`).
  - Refunds are matched by the refund id.
- **Balance.** Each hour PlugSure reads `GET /balance` (the cash account) into
  `gateway_balance_snapshot`.
- **Retention.** Snapshots are kept 400 days. The ledger and the
  reconciliation history are financial records and are kept.
- **Archived accounts.** An account archived when the operator changed
  acquirer stays visible and synced for 60 days, while its money settles.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "The last sync failed: Xendit transactions: 403" | The secret key lacks the Transactions (or Balance) read permission: add it in Xendit's dashboard. |
| "Not synced yet" | The first sync runs within 15 minutes of the server starting; *Sync now* runs it at once. |
| Every payment shows *Paid at the gateway, not in PlugSure* | The Xendit account also takes payments that are not PlugSure's (another shop or invoices). Use a separate Xendit account for PlugSure, or resolve those with a note. |
| Fees show 0 for QRIS payments up to Rp 100,000 | Correct: Bank Indonesia's QRIS MDR is 0% up to Rp 100,000 from October 2026. |
