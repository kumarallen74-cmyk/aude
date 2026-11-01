# PlugSure CSMS v1.27.0: release notes

**Date:** 1 November 2026
**Base:** v1.26.0.

v1.27.0 is phase 16 of the finance work: finance digests, electricity tariffs with a margin simulation, site owners' payout and tax documents, and fleet invoicing automation.

- **Migration:** one, 095 (four new tables; three columns; one constraint widened; additive).
- **When nothing changes:** until someone subscribes to a digest, sets a tariff or turns fleet automation on. Owners see their new Documents card at once.
- **Guide:** `deploy/FINANCE.md`, *Digests, tariffs, owner documents and fleet automation*.

## New

### Finance digests

**Subscribing:** each console user subscribes in Finance today → **Your digest**:

- off, daily, or weekly on a chosen weekday;
- at an hour in the billing time zone;
- by e-mail and/or WhatsApp.

**Contents:**

| Section | Contents |
|---|---|
| Figures | Yesterday (or the last 7 days), and the month to date against last month. |
| Approvals | What waits, and how many are the reader's to decide. |
| Overdue | Receivables past due, the largest first. |
| Cash | Gateway and bank balances. |
| Anomalies | Revenue drops of the last week. |

**Sending:**

- A digest is sent at most once a day. The new worker `finance-digest` runs every 15 minutes, and a digest sent by hand counts for the day.
- WhatsApp needs an approved template with one parameter (the text), named in Finance → Settings.
- Each send is logged.

### Electricity tariffs and simulation

The new Finance → **Tariffs** tab:

- **Per site:** the PLN class, connected power (kVA), the peak (WBP) and off-peak (LWBP) rates per kWh, the peak hours (17:00–22:00 by default), and a fixed monthly charge.
- **Simulate:**
  - **Load:** when the site's cars charge, spread over the hours each session ran, with the peak share.
  - **Cost:** per month and per kWh, under the site's own tariff and each class in the catalogue (SPKLU bulk, B-2, B-3, I-3, special service). Losses come from recorded bills (billed kWh ÷ delivered kWh).
  - **Margin:** against the revenue per kWh drivers paid, and the price per kWh for a target margin.
  - **Moving load:** the saving from moving a share of the peak load off-peak.

The catalogue's rates are indicative, for comparison: your bills and PLN's current tariff decide.

### Site owners' payout and tax documents

**For the operator** (Finance → Auto payouts → *Documents* on an owner):

- **Tax withheld:** record tax withheld from an owner's share on a statement (e.g. PPh 4(2) on rent, up to 30%), with the bukti potong number and date.
- **Payments and annual statement:** see the owner's payments, and download the annual statement.

**For the owner** (Site Owner portal → *Your payouts* → **Documents**):

- a **payout advice** (PDF) for each payment;
- the tax withheld with the bukti potong numbers;
- the **annual statement** (PDF): share, withheld, paid and due per month;
- the statements in automatic payouts, and why each is waiting.

### Fleet invoicing automation

The new Finance → **Fleet invoicing** tab:

- **Issue:** on a day of the month (1–28), last month is invoiced for every fleet account with charges, once.
- **Send:** issued invoices are e-mailed to the fleet's billing address. The e-mail now carries the payment link when one is open.
- **Hold for the e-Faktur number:** an invoice with PPN to a buyer with an NPWP waits until its faktur number is set.
- **Payment links:**
  - a Xendit invoice on the operator's own Xendit account for the balance;
  - when it is paid, the invoice is marked paid with the Xendit reference;
  - a paid link that cannot be applied raises `finance.fleet_invoice_link`.
- **Reminders** stay with Collections' dunning.

A new hourly worker: `fleet-automation`.

### API

Seventeen new operations (498 public, plus 3 for the Site Owner portal):

| Operation | Permission |
|---|---|
| `GET /v1/finance/digest` | `payment:read` (console users) |
| `PUT /v1/finance/digest` | `payment:read` (own subscription) |
| `POST /v1/finance/digest/send` | `payment:read` (own digest) |
| `PUT /v1/finance/digest/settings` | `payment:write`, audited |
| `GET /v1/finance/tariffs` | `payment:read` |
| `PUT /v1/finance/tariffs/sites/{sid}` | `payment:write`, audited |
| `GET /v1/finance/tariffs/sites/{sid}/simulate` | `payment:read` |
| `GET /v1/finance/owners/{oid}/documents` | `payment:read` |
| `POST /v1/finance/owners/{oid}/withholdings` | `payment:write`, audited |
| `GET /v1/finance/owners/{oid}/documents/year/{year}` | `payment:read` |
| `GET /v1/finance/fleet-automation` | `invoice:read` |
| `PUT /v1/finance/fleet-automation` | `invoice:write`, audited |
| `POST /v1/finance/fleet-automation/run` | `invoice:write`, audited |
| `POST /v1/fleet-invoices/{id}/payment-link` | `invoice:write`, audited |
| `GET /v1/owner-portal/documents` | Site Owner portal |
| `GET /v1/owner-portal/documents/advice/{pid}` | Site Owner portal |
| `GET /v1/owner-portal/documents/year/{year}` | Site Owner portal |

## Upgrading

1. Deploy and run `npm run migrate`. This applies **095**:
   - `finance_digest_subscription`, `finance_digest_send`, `site_tariff` and `fleet_invoice_link`, with row-level security and no DELETE for the runtime role;
   - the digest and fleet automation settings;
   - `tax_withholding` gains `owner_id` and the kind `owner_share`.
2. Optionally:
   - name the digest WhatsApp template;
   - set site tariffs;
   - turn on fleet invoicing automation;
   - route `finance.fleet_invoice_link`.

**Rollback:**
1. Roll the code back to v1.26.0.
2. Expire open fleet payment links at Xendit.
3. Export owners' withholdings (they are voided by the rollback).
4. Run `db/rollback/095_down.sql`.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 4 of them new. They cover:
  - tariffs: the catalogue's rates by default, the load by hour (peak share), the cost per kWh, the price for a target margin, SPKLU the cheapest, the saving from moving load;
  - owner documents:
    - tax withheld (the 30% limit), the documents list, the annual statement and the payout advice as PDF;
    - the portal sees only its own owner;
  - fleet automation:
    - last month invoiced once;
    - held for the e-Faktur number, then sent with a Xendit link in the e-mail;
    - the link paid at a fake Xendit marks the invoice paid;
  - digests: the checks, sending now by e-mail, the worker once a day.
- **Database:** the least-privilege pins cover the four new tables, and the 095 rollback was checked.

**To confirm before live use:**
- PLN's current tariff for each site (the catalogue is indicative).
- The withholding rates on owners' shares with your tax adviser.
- The digest WhatsApp template's approval in Meta.
