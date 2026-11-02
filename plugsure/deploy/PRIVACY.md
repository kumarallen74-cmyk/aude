# Data privacy: UU PDP (v1.48.0)

**Govern → Privacy.** Indonesia's Personal Data Protection law (UU No. 27 of 2022) makes the operator, as the data
controller, answer drivers' requests about their data and keep records of it. This page is that record-keeping.
The law and the operator's own counsel decide what is required; nothing here is legal advice.

## Settings

- **Data protection officer:** name and e-mail.
- **Answer within:** hours, default 72 (3 × 24 hours). Each request's deadline is set from it when it arrives.
- **Retention:**
  - plates (camera reads and finished parking stays), cleared to `*`;
  - survey comments, cleared;
  - closed support cases: the customer's details and the messages are cleared.

  Empty: kept. Charges, payments and CDRs are kept for tax and accounting.

## Requests

- **From the app** (Akun → Data pribadi): the driver is signed in with their number, so the request is verified
  already.
- **By e-mail or phone:** *Record a request*. A phone number finds the account. Then *Verify*: say how the identity was
  checked (for example, called back on the account's number).
- **Completing a request:**
  - **Access / copy:** *Complete*, then download the JSON copy of their data (account, charges, payments, saved cards
    by brand and last four, support cases, surveys, credit, consents) and send it to them.
  - **Correction:** the corrected name or e-mail.
  - **Erasure:** the account is deleted as the app's own *Hapus akun* does: signed out everywhere, cards detached,
    phone hashed, name and e-mail removed. It is refused while a charge is unpaid or running, or a reservation or
    queue entry is open; settle those first.
  - **Objection:** the consents named (default all) are withdrawn.
- **Reject:** with the reason the person is told.

`privacy.request_due` is raised when a request is due within a day; route it to the DPO (Govern → Alert routing).

## Consents and inventory

The consents page shows how many drivers have each consent now and every grant and withdrawal (kept as proof). The
inventory lists each category of personal data the operator holds, where, why, the legal basis, the retention and how
many records: a starting point for the operator's record of processing.
