# PlugSure CSMS v1.24.0: release notes

**Date:** 31 October 2026
**Base:** v1.23.0.

v1.24.0 is phase 13 of the finance work: driver refund requests in the app, fleet credit limits and prepaid deposits, a nightly finance data export, and the year-end close.

- **Migration:** one, 092 (four new tables; seven columns; additive).
- **When nothing changes:** until a policy, a credit mode or the export is set, or a driver asks for a refund. Drivers can ask from the receipt at once: every request waits for review until a policy approves some automatically.
- **Guide:** `deploy/FINANCE.md`, *Driver refunds, fleet credit, data export and year end*.

## New

### Driver refund requests

**The driver's side:** on a charge's receipt, the app shows **Ajukan pengembalian dana** (*Ask for a refund*) when the charge was paid in the app. The driver chooses:

- a reason: unused balance not returned, charging failed, charged too much, or other;
- an amount;
- a message.

The receipt then shows the request's state. A request still waiting can be withdrawn.

**Limits on what can be asked:**

- **Amount:** at most what is left on the payment (captured − the charge − already refunded). *Overcharged* and *other* can go up to what was paid, and need a message.
- **One open request per payment.** None while a refund is already on its way.
- **The window:** within the policy's days of the payment (default 30).

**Policy and review:** set them in Refunds → **Driver requests → Policy**.

- **Automatic approval:** unused balance, and failed charges (under 0.1 kWh delivered), up to an amount are approved at once.
- **Review:** every other request is alerted (`finance.driver_refund_request`). Finance approves it, possibly for less, or rejects it with a note the driver sees.

**After approval:** the payment's refund is due and is paid like any refund: through the gateway, bank transfer or disbursement, with their approvals.

**Language:** messages are Indonesian, or English in the app's English mode.

### Fleet credit limits and prepaid deposits

In Fleet billing → an account → **Credit**:

| Mode | How it works |
|---|---|
| None | As before: invoiced monthly. |
| Credit limit | What the account owes (its invoices not paid and its charging not invoiced yet) against the limit. |
| Prepaid deposit | The operator records top-ups (with the bank reference) and adjustments. Issued invoices are paid from the deposit automatically (or by hand, *Pay from deposit*) and marked paid. |

- **Hourly check, and after any change:** a warning at 80% used, critical at 100% (`fleet.credit_limit`, once per level).
- **Blocking:** with *Block the cards*, the account's cards are blocked while it is over and unblocked when it is back under. Only the cards blocked for credit are unblocked: a card the customer or the operator blocked stays blocked. An operator changing a card's status takes it out of the credit check.
- **Not counted:** amounts are in the account's credit currency; partner-network charging and reservation fees are not counted until invoiced.

### Finance data export

In Finance → **Settings → Data export**, each night the day before is exported for a BI tool or a warehouse:

- **By day:** payments (the gateway ledger), charges (charge records with site and kWh), refunds, statement payments, fleet invoices and credit notes.
- **Snapshots:** statements, shared costs, site investments, PPh 23 records and sites.
- **Format:** gzipped CSV (with a header row) or gzipped JSON Lines.
- **Layout:** `<prefix>/<dataset>/date=<day>/part-0.csv.gz`, and `snapshot_date=` for snapshots.

**Targets:**

- **S3-compatible bucket:** AWS S3, Cloudflare R2, MinIO, Wasabi, or Google Cloud Storage's XML API. PUTs are signed with AWS Signature V4, and the secret key is kept sealed and never shown.
- **The server's storage:** `STORAGE_DIR/warehouse/<organisation>`.

**Runs:**

- Any ended day can be exported again by hand, or downloaded as one ZIP with a manifest.
- Each run is logged with every file's rows, size and SHA-256.
- A failed nightly run is retried, up to 3 times a day.

### Year end

The new Finance → **Year end** tab, for a year:

- **Months and sites:** revenue, energy cost, shared costs, depreciation and contribution, and which months are locked.
- **Site owners:** their share on the year's statements, what was paid, and what is still due.
- **PPh 23:** the year's records and their total, with those missing a bukti potong number flagged.
- **Tax filings:** the obligations marked filed (Tax calendar).

Actions:

- **Close the year:** once it has ended, every month is locked (Close). Reopening a month still needs a Finance Manager.
- **Year-end pack:** one ZIP for the accountant, with the workbook, each table as CSV, a README and a manifest of SHA-256s.

### API

Fifteen new operations (462 in all):

| Operation | Permission |
|---|---|
| `GET /v1/finance/driver-refunds` | `payment:read` |
| `POST /v1/finance/driver-refunds/{qid}/{decision}` | `payment:write`, audited |
| `PUT /v1/finance/driver-refunds/policy` | `payment:write`, audited |
| `GET /v1/finance/warehouse` | `payment:read` |
| `PUT /v1/finance/warehouse/settings` | `payment:write`, audited |
| `POST /v1/finance/warehouse/run` | `payment:write`, audited |
| `GET /v1/finance/warehouse/days/{day}` | `payment:read`, audited |
| `GET /v1/finance/year-end` | `payment:read` |
| `POST /v1/finance/year-end/{year}/close` | `payment:write`, audited |
| `GET /v1/finance/year-end/{year}/pack` | `payment:read`, audited |
| `GET /v1/fleet-credit` | `invoice:read` |
| `GET /v1/fleet-accounts/{id}/credit` | `invoice:read` |
| `PUT /v1/fleet-accounts/{id}/credit` | `invoice:write`, audited |
| `POST /v1/fleet-accounts/{id}/credit/entries` | `invoice:write`, audited |
| `POST /v1/fleet-invoices/{id}/pay-from-deposit` | `invoice:write`, audited |

The driver API gains `GET` and `POST /d/v1/charge/{id}/refund-request`, and `POST /d/v1/charge/{id}/refund-request/{rid}/withdraw`.

Two new hourly workers: `fleet-credit` and `finance-export`.

## Upgrading

1. Deploy and run `npm run migrate`. This applies **092**:
   - `driver_refund_request`, `fleet_prepay_entry`, `fleet_credit_alert` and `finance_export_run`, with row-level security and no DELETE for the runtime role;
   - the credit columns on `fleet_account`, and `credit_blocked_at` on `token`;
   - the refund policy and export settings.
2. Optionally:
   - set the driver refund policy;
   - set fleet credit limits or deposits;
   - set the export, with a bucket and an access key that can only write to it;
   - route `finance.driver_refund_request` and `fleet.credit_limit`.

**Rollback:**
1. Roll the code back to v1.23.0.
2. Note any deposits still held.
3. Run `db/rollback/092_down.sql`.

The rollback unblocks the cards blocked for credit first. Refunds already approved stay in the Refunds queue.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 5 of them new. They cover:
  - Signature V4 against AWS's documented example;
  - driver requests: what is refundable, automatic approval into the refund queue, review with a smaller amount, rejection, withdrawal, one per payment, the window;
  - fleet credit: the 80% warning; blocking over the limit; unblocking when paid, with the customer's own block kept; a prepaid top-up paying the issued invoice;
  - the export: local files with their SHA-256s; an S3 export to a fake store with signed PUTs; a refused store logged (502); the ZIP;
  - year end: the summary, closing the year, the pack.

  The driver messages' English is checked by the i18n test.
- **Database:** the least-privilege pins cover the four new tables, and the 092 rollback was checked.

**To confirm before live use:**
- The automatic approval amount for driver refunds.
- Each fleet customer's limit or deposit terms.
- The bucket's access policy: write-only for this key.
