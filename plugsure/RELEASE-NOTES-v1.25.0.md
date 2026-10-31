# PlugSure CSMS v1.25.0: release notes

**Date:** 31 October 2026
**Base:** v1.24.0.

v1.25.0 is phase 14 of the finance work: PlugSure's fee invoices to operators with payment links, roaming settlement with partners, and finance controls.

- **Migration:** one, 093 (four new tables; three columns; one constraint widened; additive).
- **When nothing changes:** until a platform administrator sends a fee invoice or turns on automatic invoicing, or an operator finalises a roaming settlement. The Roaming and Controls tabs only read.
- **Guide:** `deploy/FINANCE.md`, *Fee invoices, roaming settlement and controls*.

## New

### Fee invoices to operators

A new page for platform administrators, Govern → **Fee invoices**. Each finalised fee statement (Platform billing) is PlugSure's invoice to the operator, due 14 days after finalising.

| | |
|---|---|
| Invoice PDF | PlugSure as seller, the operator as buyer: the fee lines, tax, total, payments received, the amount due, how to pay. |
| E-mail | To the operator's billing e-mail, with the PDF, through the e-mail channel. Every send is logged. |
| Payment link | A Xendit invoice on PlugSure's own Xendit account for what is outstanding. The hourly worker asks Xendit; when it is paid, the payment is recorded on the statement (platform fee), once. |
| Reminders | Automatic, on days from the due date (e.g. 3, 14, 30), with the link. |
| Statement of account | Each operator's fee statements and payments with the running balance (CSV). |

- **Automatic invoicing** (off by default): each statement is e-mailed once it is finalised, optionally with a link. Failed sends are retried, at most 3 times a day.
- **A paid link that cannot be recorded** (for example it would overpay the statement) raises `finance.platform_invoice_link`: record it by hand.
- **Collections** now uses the operator's billing e-mail for fee-statement reminders.

### Roaming settlement

The new Finance → **Roaming** tab. With each roaming partner (an eMSP or CPO over OCPI; hubs and authorities are not settled here), for a month and a currency:

| | |
|---|---|
| They owe | Our charge records of sessions their drivers started at our chargers. |
| We owe | Their accepted charge records of our drivers (held records are not owed). |
| Net | They owe − we owe: positive, they pay us; negative, we pay them. |

- **Finalise** an ended month to freeze it as the settlement statement, numbered RS-…, once per partner, month and currency. Both sides' records download as CSV for the partner.
- **Payments:** record the transfer received or paid, with the bank reference. More than is outstanding is refused; a mistaken payment is voided with a reason.
- **Bank reconciliation:** the payments are matched to bank statement lines (`roaming_payment`), automatically by amount and date or by hand. A matched payment cannot be voided until the match is undone.
- **Drift:** charge records that arrive after a month is finalised show as the difference to the frozen figures.

### Finance controls

The new Finance → **Controls** tab (audit:read).

**Change log:** every finance action in the audit log (finance, billing, refunds, fleet invoices, credit notes and credit, site owners, controls) with what was recorded before and after; by date, person, action and target; CSV.

**Segregation of duties,** checked for a month:

| Control | Finding |
|---|---|
| Bank details, then paid | The person who approved an owner's new bank account later paid that owner (a payout recorded or a transfer approved) within 90 days. |
| Recorded and matched | A payment recorded and matched to its bank line by hand by the same person. |
| Refund approved and paid | A driver's refund request approved and the refund recorded paid by hand by the same person. |
| Reopened by who locked it | A month reopened by the person who locked it. |
| Too few approvers | Fewer active people holding finance:approve than the minimum (default 2). |
| Outside working hours | Payments and transfers recorded outside the working hours or at weekends (off until the hours are set). |
| Write-off without history | A receivable written off with no note or reminder before. |

- Nothing is blocked: the approvals matrix and the two-person transfers stay the preventive controls.
- A Finance Manager **acknowledges** a finding with a note (audited as `controls.finding_acknowledged`).
- The **controls report** is the month's workbook: the controls, the findings, the change log, and the actions per person.

### API

Twenty new operations (472 public, with 10 more for platform administration):

| Operation | Permission |
|---|---|
| `GET /v1/finance/platform-invoices` | `platform:admin` |
| `PUT /v1/finance/platform-invoices/settings` | `platform:admin`, audited |
| `GET /v1/finance/platform-invoices/{sid}` | `platform:admin` |
| `GET /v1/finance/platform-invoices/{sid}/pdf` | `platform:admin` |
| `POST /v1/finance/platform-invoices/{sid}/send` | `platform:admin`, audited |
| `POST /v1/finance/platform-invoices/{sid}/link` | `platform:admin`, audited |
| `POST /v1/finance/platform-invoices/{sid}/link/cancel` | `platform:admin`, audited |
| `POST /v1/finance/platform-invoices/{sid}/link/check` | `platform:admin` |
| `PUT /v1/finance/operators/{oid}/billing-email` | `platform:admin`, audited |
| `GET /v1/finance/operators/{oid}/fee-account` | `platform:admin` |
| `GET /v1/finance/roaming` | `payment:read` |
| `GET /v1/finance/roaming/partners/{pid}` | `payment:read` |
| `POST /v1/finance/roaming/partners/{pid}/settle` | `payment:write`, audited |
| `POST /v1/finance/roaming/settlements/{id}/payments` | `payment:write`, audited |
| `POST /v1/finance/roaming/payments/{id}/void` | `payment:write`, audited |
| `GET /v1/finance/change-log` | `audit:read` (CSV audited) |
| `GET /v1/finance/controls` | `audit:read` |
| `PUT /v1/finance/controls/settings` | `finance:approve`, audited |
| `POST /v1/finance/controls/acknowledge` | `finance:approve`, audited |
| `GET /v1/finance/controls/report` | `audit:read`, audited |

The ten platform-administration operations are marked internal in the OpenAPI document.

One new hourly worker: `platform-invoicing` (payment links checked, automatic invoices and reminders).

## Upgrading

1. Deploy and run `npm run migrate`. This applies **093**:
   - `platform_invoice_send`, `platform_invoice_link`, `roaming_settlement` and `roaming_settlement_payment`, with row-level security and no DELETE for the runtime role;
   - `organisation.billing_email`, and the invoicing and controls settings;
   - `roaming_payment` as a bank statement line match.
2. Optionally:
   - platform administrators: set each operator's billing e-mail and automatic invoicing; connect PlugSure's own Xendit account for payment links; route `finance.platform_invoice_link`;
   - operators: finalise last month's roaming settlements; set the controls' thresholds.

**Rollback:**
1. Roll the code back to v1.24.0.
2. Expire any open payment links at Xendit.
3. Run `db/rollback/093_down.sql`.

The rollback unmatches bank lines matched to roaming payments. Payments the links recorded stay on the statements.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 4 of them new. They cover:
  - fee invoices: the e-mail with the PDF and link; the link pending, then paid at a fake Xendit and recorded once; the statement of account; platform administrators only; the automatic send and a reminder, once each;
  - roaming: receivable and payable per partner (hubs and held records left out); finalising an ended month once; a payment, more refused; matched on an uploaded bank statement, and then not voidable;
  - controls: the change log (finance only, CSV, the range checked); a month reopened by who locked it and too few approvers found; an acknowledgement; working hours; the workbook; audit:read required.
- **Database:** the least-privilege pins cover the four new tables, and the 093 rollback was checked.

**To confirm before live use:**
- PlugSure's own Xendit account and its invoice settings (methods offered on the payment page).
- Each operator's billing e-mail.
- With each roaming partner, the month's figures before finalising (their CDRs against ours).
