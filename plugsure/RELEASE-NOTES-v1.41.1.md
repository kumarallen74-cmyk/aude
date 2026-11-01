# PlugSure CSMS v1.41.1: release notes

**Date:** 1 November 2026
**Base:** v1.41.0.

v1.41.1 fixes what a whole-system review found after the finance build and the menu restructure.

- **Migration:** none.
- **API:** still 823 operations.
  - Close automation and Corporate cards also return `people` (below).
  - Some descriptions and messages name the console's places as they are now called.

## How the review was done

- **The console, page by page:** a browser opened every sidebar page and clicked every tab (in Finance, every section and tab), then followed every link found on those pages. It ran as each kind of user:
  - platform administrator (light, dark and phone width);
  - CPO operations manager;
  - finance manager;
  - financial auditor;
  - field technician;
  - read-only support;
  - a customer organisation's owner;
  - a site owner (owner portal);
  - a fleet customer (fleet portal).
  
  It recorded page errors, refused or failed API calls, error messages shown, text such as `undefined` or `NaN`, links that lead nowhere and pages wider than a phone.
- **The driver web app:** at phone width, in light and dark mode, through each of its screens.
- **The API:** every read operation in the OpenAPI document (323), with ids taken from the lists, checked for server errors.
- **End-to-end suites:** all of them, including the 18 that the CI pipeline does not run, against a stack started as the pipeline starts it.

## Fixed

### Roles

- **Plug & Charge → Contracts.** A role without access to cards and contracts (e.g. a financial auditor) now does not see the tab. Before, the page stopped with an error. A tab that fails to load now shows the reason on the page.
- **Connections → Pending adoption.** The tab is shown only to platform administrators, who are the only ones who can adopt a charger. Other roles saw a refused request.
- **Finance → Month close → Automation and Corporate cards.** A finance manager (who may not read the user list) could not name a close step's owner or a card's holder: the list to pick from was empty, and the console's request for it was refused.
  - Both now return `people` to a caller who may write finance: the organisation's active console users, by id and name only (no roles, sign-ins or lock state).
  - The console uses that list when the user list is not available, and no longer asks for the user list without the permission.
- **Links to pages the role cannot open.** Before, such a link opened the role's first page without saying why. Now it is shown as plain text, or hidden when it is a button. This applies on every page, drawer and dialog.
- **Hidden pages and permissions.** Hidden pages such as *Add charge point* now also check the role's permission when opened from a direct link.

### Layout

**Phone width:** five tables in Finance (including Settings → *Contracted rates*) now scroll sideways instead of widening the page.

### Wording

"Where to find it" hints in the console, alert messages, e-mails, API descriptions and guides now use the current names:
- **Governance** (not "Govern");
- **Governance → WhatsApp** and **Governance → Driver app**;
- **Finance → Owners, Fleet billing, Refunds, Owner billing, Platform statements.**

### Driver app

**Account, before signing in:** the app no longer asks for loyalty points, which need a phone-number account.

### Tests and documentation

- **apns e2e suite:** checks the notification picture's address against the API it was given, not a fixed port.
- **field e2e suite:** the instructions to create the platform operator include `--platform-admin`.
- **`VERSION`:** gives the SDK's actual address, `/sdk/plugsure-csms-sdk.tgz`.

## Checked and found working

- **API:** no server error on any read operation.
- **Rejected requests** come back as the right 4xx with a message, for example:
  - a feature that is not configured (WhatsApp, PlugSure Hub, the platform's NPWP for e-Faktur);
  - a record that does not exist.
- **Console:**
  - every page and tab for every role above, with no page error and no unexpected refusal;
  - in light and dark mode;
  - at phone width, every page fits.
- **Driver app:** every screen, with no error, in both themes, at phone width.

## Upgrading

Deploy. There is nothing to migrate or configure.

**Rollback:** roll the code back to v1.41.0.

## Verification

- **Server:** typecheck clean; all unit and database tests passing, 2 of them new: the people a finance user can assign (active console users only), returned by both endpoints to a finance writer and not to a reader.
- **End-to-end:** every suite passing.
