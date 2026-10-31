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
| **Excel** (.xlsx) | Four sheets: Summary, By channel, Fees, Transactions. |
| **CSV** | Every transaction, UTF-8 with a BOM, so Excel opens it with the right characters. |
| **PDF** | The summary, by channel, fees by month, then every transaction. For the monthly close. |

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
