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

## Month lock, investments, revenue alerts and statements of account (v1.22.0)

- **Close** (tab). Lock a month once the accountant has closed it. Only a
  month that has ended can be locked. The dialog first shows what is still
  open:
  - sites with sessions but no energy bill;
  - currencies with no rate;
  - bank lines not matched.

  In a locked month, energy bills, exchange rates, budgets and site
  investments can't be added, changed or voided. To reopen it, a Finance
  Manager (`finance:approve`) gives a reason. Who locked and who reopened it
  stay in the history.
- **Investments** (tab). *Record an investment*: the site, a category
  (chargers, installation, grid connection, other), the amount, the date it
  was paid, and the months it is depreciated over (default 96). Per site,
  Finance shows:
  - the net book value (straight-line depreciation from the month after);
  - the margin recovered since the first investment;
  - the payback month, reached or estimated at the last 6 months' average;
  - a year's ROI.

  Click a site to see or void its investments.
- **Revenue drop alerts** (Settings). Each morning, each site's revenue
  yesterday is compared with the same weekday over the 4 weeks before. A
  drop by the threshold (default 50%) raises `finance.revenue_drop` on the
  site: route it in Govern → Alert routing. Sites with too little history,
  or a baseline under the minimum, aren't compared.
- **Statements of account** (Fleet billing). Open an account's drawer →
  **Statement**. Pick a month to see:
  - the opening balance;
  - invoices, credit notes, payments and refunds, with the running balance;
  - the closing balance and the invoices still open.

  Download it as a PDF or Excel, or e-mail it to the billing address. In
  Fleet billing → **Settings → Statements of account**, choose a day (1–28).
  On that day every account with movements or a balance is e-mailed last
  month's statement, once.

## Tax calendar, owner queries, site P&L and settlements (v1.23.0)

- **Tax calendar** (Tax). Each period's obligations, and what PlugSure
  recorded for each:
  - PPh 23 payment and its SPT Masa Unifikasi;
  - PPN payment and the SPT Masa PPN;
  - the e-Faktur upload.

  Each is due on a day of the following month. A weekend moves it to Monday;
  public holidays aren't known. *Mark filed* takes the date, the NTPN or BPE,
  and the amount. *Settings* sets the due days (confirm them with your
  adviser: the rules change), turns obligations off, and turns on the
  `finance.tax_due` reminders: a warning before the due date, critical
  once overdue.
- **Owner queries** (Payables). A site owner queries a finalised statement
  from the portal (Payouts → *Query*). Answer it with one of:
  - *reject*: the statement stands;
  - *resolve*: explained;
  - *adjust*: an amount added to the owner's share on its **next** statement
    finalised (negative if the owner owes it back).

  Finalised statements never change. The owner sees the answer and where the
  adjustment went.
- **Site P&L** (tab). Shared costs (rent, maintenance contracts, SIM cards,
  insurance, staff) are entered once per month, from a month until a month or
  ongoing. They are spread over the currency's sites, or the ones chosen, by
  kWh, sessions, revenue or equally.

  Each site's contribution = revenue − energy cost − its shared costs −
  depreciation. A cost counting in a locked month can be ended later but not
  voided.
- **Settlements** (tab). Per payments account, from the gateway's ledger:
  - what it said it would settle each day, and what it has;
  - a day past the grace days (default 2) with payments still pending is
    *late*;
  - each withdrawal to the bank against the bank lines matched under Bank:
    in the bank, short, not in the bank (statements cover the days after it,
    default 3), or awaiting the statement.

  Alerts: `finance.settlement_late`, `finance.withdrawal_missing`.

## Driver refunds, fleet credit, data export and year end (v1.24.0)

- **Driver refund requests** (Refunds → Driver requests). From a charge's
  receipt in the app, a driver asks for money back and gives a reason:
  - unused balance;
  - charging failed;
  - overcharged;
  - other.

  The amount can be up to what is left on the payment (captured − the
  charge − already refunded). *Overcharged* and *other* can go up to what was
  paid, and need a message. With the **Policy**, unused balance and failed
  charges up to an amount are approved at once. The rest wait here
  (`finance.driver_refund_request`): approve, possibly for less, or reject
  with a note the driver sees.

  An approved request makes the payment's refund due in the list below, paid
  as any refund. Drivers can ask within the policy's days of the payment,
  once per payment.
- **Fleet credit** (Fleet billing → an account → **Credit**). Choose one:
  - **Credit limit:** what the account owes (invoices not paid + charging
    not invoiced yet) against the limit.
  - **Prepaid deposit:** record top-ups. Issued invoices are paid from the
    deposit automatically (or by hand), and marked paid.

  Warnings at 80% and 100% (`fleet.credit_limit`). With *Block the cards*,
  the account's cards are blocked while it is over, and unblocked when it is
  back under: only the cards blocked for credit, never a card the customer
  or you blocked.
- **Data export** (Settings). Each night, the day before's finance data as
  gzipped CSV or JSON Lines, laid out `<prefix>/<dataset>/date=<day>/` for a
  BI tool or a warehouse:
  - payments, charges, refunds, statement payments, fleet invoices and
    credit notes;
  - snapshots of statements, shared costs, investments, PPh 23 and sites.

  The target is either an S3-compatible bucket (AWS S3, Cloudflare R2, MinIO,
  Wasabi; Signature V4, the secret kept sealed; give it a key that can only
  write to that bucket) or the server's storage. Any day can be exported
  again, or downloaded as a ZIP. Each run is logged with its files' SHA-256.
- **Year end** (tab). A year's months and sites, with:
  - revenue, energy, shared costs, depreciation and contribution;
  - each owner's share, paid and still due;
  - the PPh 23 withheld, with records missing a bukti potong flagged;
  - the tax filings marked.

  *Close the year* locks every month (Close). The *Year-end pack* is one ZIP
  for the accountant: the workbook, each table as CSV, a README and a
  manifest of SHA-256s.

## Fee invoices, roaming settlement and controls (v1.25.0)

- **Fee invoices** (Govern → Fee invoices; platform administrators). Each
  finalised fee statement (Platform billing) is PlugSure's invoice to the
  operator, due 14 days after finalising:
  - **E-mail:** the invoice PDF, to the operator's billing e-mail (set it in
    the invoice's drawer), through your e-mail channel. Each send is logged.
  - **Payment link:** a Xendit invoice on PlugSure's own Xendit account
    (Integrations, platform level) for what is outstanding. The operator pays
    by virtual account, e-wallet or card; the hourly worker asks Xendit, and a
    paid link is recorded on the statement as a platform-fee payment. If the
    payment cannot be recorded (for example it would overpay),
    `finance.platform_invoice_link` is raised: record it by hand.
  - **Automatic:** e-mail each statement once it is finalised (with a link if
    you choose), and reminders on days from the due date (e.g. 3, 14, 30).
  - **Statement of account:** each operator's fee statements and payments,
    with the running balance (CSV).
- **Roaming** (tab). With each roaming partner (an eMSP or CPO over OCPI;
  hubs are not settled here), for a month and a currency:
  - **They owe:** our charge records of sessions their drivers started at our
    chargers.
  - **We owe:** their accepted charge records of our drivers (held records are
    not owed until accepted).
  - **Net,** and once the month has ended, **Finalise** freezes it as the
    settlement statement (RS-…), with both sides' records as CSV for the
    partner. Record the transfer received or paid; it is matched on the bank
    statement (Bank) like a statement payment. Records that arrive after
    finalising show as drift.
- **Controls** (tab; audit:read). For a month, checks on who did what:
  - bank details approved, then that owner paid, by the same person;
  - a payment recorded and matched to its bank line by the same person;
  - a driver's refund approved and recorded paid by the same person;
  - a month reopened by the person who locked it;
  - fewer people holding finance:approve than the minimum (default 2);
  - payments recorded outside working hours (set them to check);
  - a write-off with no note or reminder before it.

  Nothing is blocked: a Finance Manager reviews each finding and
  acknowledges it with a note (audited). The **change log** lists every
  finance action from the audit log with what was recorded (CSV), and the
  **controls report** is the month's workbook for the auditor.

## Finance today, subscriptions, PPN and automatic payouts (v1.26.0)

- **Finance today** (Commercial → Finance today). Made for the phone:
  today's takings, the month so far, cash and what is owed, and every
  approval waiting (owner payouts, refund transfers, write-offs, owner bank
  changes, driver refund requests). Approve or reject there: the same rules
  apply as in Finance (never the person who asked; the approvals matrix).
- **Subscriptions** (tab). A membership or pass is paid ahead for its
  period, and its revenue is earned day by day over it:
  - **recognised:** the part of each charge's period in the month;
  - **deferred:** what was billed for days still to come (a liability);
  - **MRR / ARR, subscribers and churn,** per plan;
  - **journal:** billed into deferred revenue, earned out of it (set the
    account codes; Excel).
- **PPN** (tab; PKP only). The monthly return, SPT Masa PPN, in rupiah:
  - **output:** retail charge records (not on a fleet invoice), fleet
    invoices less credit notes, memberships and passes paid;
  - **input:** the faktur masukan you record (supplier, NPWP, number, DPP,
    PPN). The gateway's VAT on fees and PlugSure's fee statement are
    suggested, counted once recorded with their faktur;
  - **net:** payable (kurang bayar) or carried forward (lebih bayar) into
    the next period;
  - **record as filed** with the NTPN of the payment; amend while no later
    period is filed. Working papers (Excel) and masukan / keluaran CSVs.
- **Auto payouts** (tab). Once an owner statement is finalised and the wait
  has passed, the payout of the owner's share is requested hourly. It still
  waits for the approvals. Skipped, with the reason shown, while the owner is
  held or below the minimum, has a query open on the statement or a bank
  change waiting, or has no checked bank details.

## Digests, tariffs, owner documents and fleet automation (v1.27.0)

- **Finance digests** (Finance today → *Your digest*). Each person picks
  daily or weekly, an hour, e-mail and/or WhatsApp. The digest has the
  figures, the approvals waiting (and how many are theirs to decide),
  overdue receivables, cash and revenue drops. WhatsApp needs an approved
  template with one parameter, named in Finance → Settings.
- **Tariffs** (tab). Set each site's tariff: the PLN class, kVA, peak (WBP)
  and off-peak (LWBP) rates and the peak hours (17:00–22:00 by default).
  *Simulate* shows:
  - when the site's cars charge, by hour;
  - the energy cost under the site's tariff and each class in the
    catalogue (indicative rates), with losses from recorded bills;
  - the margin against what drivers paid per kWh, and the price per kWh
    that reaches a target margin;
  - the saving from moving part of the peak load off-peak.
- **Owner documents** (Auto payouts → *Documents* on an owner; and the
  owner's own Site Owner portal → *Your payouts*):
  - a payout advice (PDF) for each payment recorded;
  - tax withheld from the owner's share (e.g. PPh 4(2) on rent), recorded
    per statement with the bukti potong number;
  - the annual statement (PDF): share, withheld, paid, due;
  - the statements in automatic payouts and why each waits.
- **Fleet invoicing** (tab). On a day of the month, last month is invoiced
  for every fleet account with charges. Issued invoices are e-mailed with a
  Xendit payment link (your own Xendit account); a paid link marks the
  invoice paid. With *Hold for the e-Faktur number*, an invoice with PPN to
  a buyer with an NPWP waits until its faktur number is set. Reminders stay
  with Collections' dunning.

## Driver funds, group, revenue forecast, plans and provision (v1.28.0)

- **Driver funds** (tab). Money drivers paid ahead, held as a liability:
  - **in use:** paid for a charge that has not ended;
  - **unused:** charged less than paid, not refunded — owed to the driver;
  - **refund due:** approved, not paid yet;
  - **loyalty:** points outstanding at their value.

  Unused balances older than the breakage days (default 180) are breakage
  candidates by month of payment. A Finance Manager *recognises* a month's
  breakage (once): it moves to revenue and out of the liability. The month's
  movement (collected, used, refunded, breakage) is shown beside the
  gateway's ledger for the same payments.
- **Group** (tab; the parent organisation). The parent and its subsidiaries
  for a month:
  - **per entity:** revenue, energy, shared costs, depreciation, owners'
    shares, PlugSure fees and the operating result;
  - **the group:** less intercompany eliminations (record them; fleet
    invoices between entities, matched by NPWP, are suggested), and in the
    parent's reporting currency.
- **Revenue forecast** (tab). Each site's next 12 months:
  - built from its trend (flat at the average with fewer than 6 months of
    history), and its seasonality once there are 13 months;
  - under a scenario: growth, price and energy cost changes;
  - against the revenue budget, with an alert when the next 3 months fall
    below it by the threshold (`finance.forecast_below_budget`, daily).
- **Plans & provision** (tab).
  - **Payment plans:** agree instalments (2–24, monthly or every N days)
    for an overdue fleet invoice. Payments pay the earliest instalments, and
    when all are paid the invoice is paid. A reminder goes 3 days before
    each instalment. An instalment unpaid past the grace days defaults the
    plan (`finance.payment_plan_defaulted`).
  - **Provision:** receivables by age × rates (a Finance Manager sets them;
    an invoice on a plan counts as current). *Record* the month for the
    journal: Dr bad-debt expense, Cr allowance for the movement.

## Assets, bills, cash and benchmarking (v1.29.0)

- **Assets** (tab). The fixed asset register:
  - **each asset:** category, site and charge point, cost before PPN and a
    residual value, the month it goes into service (by default the month
    after it was bought), its life, and the method: straight line, or
    declining balance at a yearly rate (by default double the straight-line
    rate), never below the residual;
  - **importing:** *Import* turns the site investments into assets
    (straight line over their months);
  - **disposing:** *Dispose* records the date and the proceeds. Depreciation
    stops from that month, and the gain or loss is in that month's journal.
    *Void* is for an asset recorded in error, and only before its
    depreciation is in a recorded month;
  - **the journal:** for a month, Dr depreciation expense / Cr accumulated
    depreciation by category, and for disposals, Dr accumulated, Dr bank,
    Cr cost, and the gain or loss. *Record the month* once it has ended. The
    account codes are in the settings (`PUT /v1/finance/assets/accounts`).
- **Bills** (tab). What the operator owes its suppliers:
  - **suppliers:** NPWP, bank details, payment terms, and the PPh 23 rate
    withheld. A changed bank account is audited in full;
  - **a bill:** the supplier's number, its dates (due by default after the
    terms), category, site, subtotal, PPN and PPh 23 (by default the
    supplier's rate). It is saved as a draft or submitted;
  - **approval:** by a second person, never the submitter. The approvals
    matrix's *Supplier bills* row can require a Finance Manager or two
    approvers above an amount. *Reject* sends it back with a reason;
  - **paying:** payments are recorded against an approved bill. When they
    reach the payable, the bill is paid. Bank transfers are candidates in
    Bank reconciliation;
  - **capitalising:** equipment or installation can be capitalised: on
    approval it becomes an asset (the subtotal, over the months given);
  - **ageing:** by supplier and days past due (not due, 1–30, 31–60, 61–90,
    90+), with what falls due in 14 days. An approved bill past due raises
    `finance.supplier_bill_overdue` (daily), resolved when it is paid.
- **Cash** (tab). The cash position:
  - **accounts:** bank and cash accounts, each with an opening balance and
    an optional minimum;
  - **an account's balance:** its latest anchor, plus the transfers and
    supplier payments from it since. The anchor is a balance taken by hand,
    the last balance on a bank statement of the account, or the opening
    balance. A statement belongs to the account when it is linked, or when
    the account number ends with the account's last digits;
  - **gateway balances:** Xendit's and others' balances come from the
    gateway's snapshots;
  - **staleness:** accounts with no balance for more than 7 days are
    flagged;
  - **the next 13 weeks:** from today's position, the gateway forecast's
    flows (settlements, fleet invoices, Hub, refunds, owner shares,
    PlugSure's statements) and supplier bills by due date, week by week,
    with the first week below the accounts' minimums;
  - **below the minimum:** an account below its minimum raises
    `finance.cash_below_minimum` (daily).
- **Benchmark** (tab). Sites, or site owners, over the last 1 to 12 months,
  against their peers in the same currency:
  - **metrics:** revenue, revenue per kWh, utilisation, margin, revenue per
    connector a month, and collection days (from the charge to the money;
    fewer is better);
  - **per metric:** the quartiles, each one's percentile rank (100 is the
    best), and outliers beyond 1.5 × the interquartile range, flagged good
    or bad;
  - **the score:** the average rank.

## Orders, leases, treasury and review (v1.30.0)

- **Orders** (tab). Purchase orders to suppliers:
  - **raising:** lines (description, quantity, unit price), site, expected
    date; numbered PO-00001…;
  - **approval:** by a second person, never the submitter; the approvals
    matrix's *Purchase orders* row can require a Finance Manager or two
    approvers above an amount;
  - **receiving:** goods or work received per line, never more than
    ordered;
  - **the three-way match:** a bill names its order (Bills → the order).
    Ordered, received (quantity × unit price) and billed are compared with
    a tolerance (default 2%). A bill above what was received, or with
    nothing received, is approved only by a Finance Manager;
  - **commitments:** approved orders not yet billed in full.
- **Leases** (tab). PSAK 73:
  - **recognising:** the payments (monthly, quarterly or yearly; in advance
    or arrears) discounted at the borrowing rate are the lease liability;
    the right-of-use asset is the liability plus initial direct costs;
  - **each month:** interest on the liability, the payment, and
    straight-line depreciation of the asset; the liability is split into
    current (the next 12 months) and non-current;
  - **exempt:** leases of 12 months or less (and low-value ones) are
    expensed straight-line;
  - **ending early:** the liability and the asset's net book value are
    derecognised with the gain or loss;
  - **the journal:** *Record the month* once it has ended. Lease payments
    also appear in Cash → the next 13 weeks.
- **Treasury** (tab). Time deposits:
  - **placing:** from a bank account (the money leaves it), with the rate,
    the term and the final tax on the interest (default 20%);
  - **interest:** accrued actual/365, gross, tax and net, to today and at
    maturity;
  - **closing:** at maturity (back into the account with the interest, or
    rolled over), or broken early with any penalty;
  - **idle cash:** what could be placed: the lowest point of the next 13
    weeks above the accounts' minimums and a buffer, with the interest it
    would earn at an indicative rate;
  - **alerts:** `finance.deposit_maturing` within 7 days or past maturity.
- **Review** (tab). Anomaly checks over the last 90 days, daily and on
  demand: duplicate bills, duplicate payments, round-amount payments,
  large bills from new suppliers, bills split below the approval amount,
  and entries made at weekends or at night. *Dismiss* (it is fine) or
  *Confirm* (it needs action: `finance.anomaly_confirmed`), with a note. A
  finding whose condition is gone clears itself; a reviewed one keeps its
  review. Checks can be turned off one by one, and the thresholds set.

## Ledger, expenses, intercompany and scorecard (v1.31.0)

- **Ledger** (tab). The general ledger:
  - **chart of accounts:** seeded with the codes the finance modules post
    to; accounts can be added, renamed and deactivated (a type cannot
    change once an account has posted lines);
  - **sync:** *Sync* a month to post the modules' entries, one per source
    and currency: the gateway journals, the recorded depreciation, lease
    and provision journals, supplier bills and payments, deposits, expense
    claims and intercompany. Syncing again keeps unchanged entries and
    replaces changed ones (the old ones are kept as superseded). A locked
    month cannot be synced;
  - **journal entries:** manual entries with balanced lines are submitted
    and post once a second person approves them (the approvals matrix's
    *Manual journal entries* row can require a Finance Manager or two
    approvers). A posted entry is reversed, never edited. Post the opening
    balances this way first;
  - **reports:** the trial balance to a month's end, profit and loss for
    the month and the year to date, and the balance sheet (this year's
    result in equity), per currency, with Excel.
- **Expenses** (tab). Expense claims and petty cash:
  - **claims:** a console user makes a claim with lines (date, category,
    site, amount, PPN) and attaches receipts (images or PDFs, up to 3 MB);
    a line at or above the receipt amount needs its receipt before the claim
    is submitted;
  - **approval:** by someone other than the claimant (the *Expense claims*
    row of the approvals matrix); a line above its category's limit needs a
    Finance Manager;
  - **reimbursing:** from petty cash or a bank account; the cash position
    counts it;
  - **petty cash:** set the float; *Count* records the notes and coins, the
    difference against the books, and makes the count the balance for the
    day; top up with a transfer (Cash).
- **Intercompany** (tab; organisations in a group). Recharges between the
  parent and its subsidiaries: issued by the entity that carried the cost,
  seen by both; *Allocate a cost* splits one across the group by kWh,
  sessions, revenue or equally (draft recharges to review and issue);
  *Settle* nets everything open with an entity and says who pays whom.
- **Scorecard** (tab). Monthly targets for revenue, sessions, kWh, margin,
  utilisation, collection days, cash and operating costs; each KPI green,
  amber (within the band, default 10%) or red; six months' trend; e-mailed
  on a day of the month to the recipients (the organisation's e-mail
  channel).

## Bank feeds, withholding, report pack and close steps (v1.32.0)

- **Bank feeds** (tab). A feed fetches a bank account's mutations every
  hour: `GET <url>?from=YYYY-MM-DD` with the token as a bearer, answering
  `{ "transactions": [ { "date", "description", "amount", "reference",
  "balance", "type" } ] }` (or the list itself; the amount signed, or
  `type` CR / DB). Put a small adapter in front of the bank's own API, or
  use an aggregator. New lines land on a statement of the account,
  exactly like an uploaded one: the same fingerprint, so an upload of the
  same days does not double them. They are matched as usual, then go
  through the **match rules** in priority order: by direction, a text the
  line contains and an amount range, *ignore* (with a note: bank fees,
  transfers between own accounts) or *suggest* a journal entry to an
  account (Dr bank / Cr the account for money in, the other way for money
  out), which waits for approval in the Ledger. The rules also run after
  every upload. *Preview* shows what they would take. The token is sealed
  and never shown again; production feeds must be https.
- **Withholding** (tab), on supplier bills by the supplier's kind:
  - **company:** PPh 23 at the supplier's rate;
  - **individual** (not an employee): PPh 21, the Pasal 17 rates (5% to
    60 million, 15% to 250 million, 25% to 500 million, 30% to 5 billion,
    35% above) on 50% of the gross, per payment; 20% more without an NPWP
    or NIK;
  - **abroad:** PPh 26 at the treaty rate when recorded (keep the
    certificate of domicile), else 20%.
  The amount can still be typed on the bill. *Draft from the bills* makes
  one slip per payee and kind for the month; *Issue* gives it its number
  (the Coretax number when known) and date; an issued slip is not changed
  by bills recorded later: void and reissue it. *e-Bupot (Excel)* lays the
  month out for the import (PPh 21 and 26, and PPh 23). The ledger posts
  PPh 21 to 2151 and PPh 26 to 2152; the tax calendar gains *Pay* and
  *File SPT Masa PPh 21/26* with the slips' amounts.
- **Reports** (tab). A month's management report pack: results against
  budget (the ledger; sync the month first), cash at the month's end and
  the 13-week low, the scorecard, the top sites and the lowest margins,
  payables. The figures are a snapshot, refreshed on demand while it is a
  draft. Commentary per section (the summary is needed). Submitted, then
  approved by a Finance Manager other than the submitter; a reviewer can
  send it back with a reason. Approved, it is e-mailed with the PDF and
  Excel to the recipients (the organisation's e-mail channel).
- **Close steps** (tab). The month close as steps checked from the data:
  ledger synced, journal entries approved, bank reconciled, anomalies
  reviewed, depreciation and leases recorded, withholding slips issued,
  energy bills and exchange rates in. A step that checks out is signed
  off; one that does not is *accepted as is* only by a Finance Manager,
  with a note. With the **policy** enforced, a month is locked only once
  every step is signed off. The **evidence pack** (Excel) has the steps
  and sign-offs, the lock history, each currency's trial balance and the
  month's finance actions from the audit log; the Financial Auditor role
  can read it and nothing else.

## Payroll, credit, capex projects and the cash forecast (v1.33.0)

- **Payroll** (tab). Employees with salary and fixed allowances, PTKP
  status, NIK and NPWP, BPJS and the JKK rate, and the bank account
  (sealed). *Draft a payroll* for a month and currency: one line per
  employee in service; overtime, bonus and other deductions per line.
  - **BPJS:** Kesehatan 5% (4% employer, 1% employee) of the salary and
    fixed allowances up to the cap (default 12 million); JHT 3.7% + 2%;
    JP 2% + 1% up to the cap (default 10 547 400); JKK at the employee's
    rate and JKM 0.3%, the employer's.
  - **PPh 21:** January to November, the TER rate of the employee's
    category (A: TK/0, TK/1, K/0; B: TK/2, TK/3, K/1, K/2; C: K/3) on the
    month's gross (salary, allowances, overtime, bonus and the employer's
    JKK, JKM and Kesehatan). December, and a leaver's last month: the
    year's tax at the Pasal 17 rates (gross less 5% occupational cost up to
    6 million, the employee's JHT and JP, and the PTKP) less what was
    withheld. 20% more without an NPWP or NIK. **Have a tax adviser confirm
    the TER tables and the caps**; a Finance Manager can replace them.
  - Submitted, approved under the approvals matrix (*Payroll runs*),
    recorded paid from a cash account. Payslips (PDF), the bank transfer
    list (CSV) and Excel. The ledger posts salaries (6100) and the
    employer's BPJS (6105) against net pay (2170), PPh 21 (2151) and BPJS
    payable (2180); the scorecard's operating costs include payroll.
- **Credit** (tab). Fleet customers scored 0–100 from the last 12 months
  of invoices (share paid late, days late, overdue now, limit used,
  tenure; a security deposit helps) and graded A–E, with a suggested
  limit (average monthly billing × 3, 2, 1.5, 1 or 0, plus the deposit).
  A Finance Manager decides a review: the limit, a hold (the cards are
  blocked until released) and the next review (6, 3 or 1 months by
  grade). Reviews due are opened daily with finance.credit_review_due.
  **Security deposits** are received, applied to an issued invoice (paid
  in full from the deposit) or returned; the ledger holds them on 2200.
- **Projects** (tab). Capex projects with a budget by category; link
  purchase orders and bills. Committed (approved orders not billed),
  actual (approved bills) and the forecast against the budget;
  finance.capex_over_budget when it is over. Bills on a project post to
  assets under construction (1610). *Complete* makes one asset of the cost
  (bills capitalised on their own excepted) and moves it to 1600;
  *Cancel* writes the spending off (8300).
- **Cash forecast** (tab). Daily for 30 to 180 days per currency: the
  committed flows of the 13-week view, the collections learnt from 180
  days of charging (weekday pattern, level and trend; a band of about
  80%), the next payrolls and open projects' remaining spend. Scenarios:
  collections at a percentage, bills paid later, capex in or out. The
  worker stores each day's forecast (its accuracy is shown) and raises
  finance.cash_forecast_shortfall when the position is forecast below the
  accounts' minimums.

## Inventory, maintenance, revenue assurance and lenders (v1.34.0)

- **Inventory** (tab). Spare parts, consumables and tools by SKU, held at
  depots and site stores. Receipts at their price (optionally against an
  approved purchase order) re-average the cost; issues (to a work order),
  transfers and counts move stock at the moving average cost, never below
  zero at a location. Items at or below their reorder point raise
  finance.stock_reorder. The ledger's inventory journal: receipts Dr 1700 /
  Cr 2105 goods received not invoiced; issues Dr 6260 / Cr 1700; counts
  against 6265. Mark the supplier's bill for the stock as *stock*
  (`POST /v1/finance/bills/{id}/links`) so it clears 2105 instead of being
  expensed.
- **Maintenance** (tab). Work orders on a charger or site: corrective,
  preventive or warranty. Their cost is labour (hours × rate), parts
  issued, and contractors' bills linked to the order; a done order whose
  contractor has not billed carries the estimate as an accrual (2110,
  reversed the next month). Warranty claims on the supplier are accepted,
  rejected or paid (6205). Costs per charger over a period, with the cost
  per kWh delivered.
- **Assurance** (tab). Each month's sessions checked daily against what
  was billed: not billed (or a roaming session without a charge record),
  billed at zero, energy billed or metered off by more than 2%, signed
  meter values not verified, a price per kWh below half the site's median.
  The expected amount uses the site's median price per kWh. Findings are
  recovered (with the amount), written off or dismissed; one found again
  keeps its review, and one no longer found is dismissed.
- **Lenders** (tab). Loans with drawdowns, payments (principal, interest,
  fees) and the schedule (annuity, equal principal or bullet, with grace
  months); the ledger posts 2500, 7210 and 7215 and the cash position
  counts them. Covenants (DSCR, interest cover, leverage, minimum cash) are
  tested monthly or quarterly over the twelve months to the month's end
  from the posted ledger (sync the months first): EBITDA = revenue −
  expenses + depreciation. A breach raises finance.covenant_breach
  (critical), less than 10% headroom a warning. The lender pack (PDF and
  Excel) has the results, the covenant tests and the schedules.

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
