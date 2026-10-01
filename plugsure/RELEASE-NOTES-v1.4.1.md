# PlugSure CSMS v1.4.1 — release notes

**Date:** 2 October 2026
**Base:** v1.4.0

v1.4.1 adds one operator action and a hardware acceptance checklist. It has no migrations and no new settings, so upgrade by deploying the new build and restarting.

## Suspend and resume a charge point

v1.4.0's gateway already handled a suspended charge point, but nothing in the console or API could put one in that state. Operators can now take a charger out of service without decommissioning it.

- **Console:** open the charger, choose **Suspend…** and give an optional reason. A suspended charger shows a banner with **Resume**, and the charger list can be filtered by *Suspended*.
- **API:**
  - `POST /v1/charge-points/:identity/suspend` with an optional `{ "reason": "…" }`, and `POST /v1/charge-points/:identity/resume`.
  - Both need `charge_point:write`.
  - Both answer 409 when the current state doesn't allow the change.
- **While suspended:**
  - The charger keeps its key and stays connected.
  - New cards, starts and remote starts are refused.
  - After a reboot it is answered `Pending`.
  - A session already running finishes and is billed normally.
- **Resume** returns it to service. A connected charger is asked to boot again, so it is `Accepted` at once with nothing to change on the unit.
- **Audit:** both actions are logged as `charge_point.suspended` (with the reason) and `charge_point.resumed`.

**Behaviour change:** a remote start on a suspended, unadopted or decommissioned charger now answers 409 with the reason. Before, the command was sent and the charger's start was then refused.

## Hardware acceptance checklist

`docs/ACCEPTANCE-v1.4.md` is the checklist to run on a real charger before the pilot. It covers:
- connection security and card authorisation;
- meter accuracy against a reference meter, and billing to the rupiah;
- prepaid connector binding and refunds;
- network loss, power loss and offline sessions;
- the 3-second cable release;
- compliance states, including suspend and resume;
- maintenance, audit checks and sign-off.

## Verification

- **Build and tests:** typecheck clean; unit and database tests 816/816.
- **Generated files:** the OpenAPI document and TypeScript SDK are regenerated (271 operations).
- **End-to-end, on a fresh database as `plugsure_app`:**

| Suite | Result | Note |
|---|---|---|
| pilot-fixes | 25/25 | 9 new checks for suspend and resume |
| console | 96/96 | |
| field | 139/139 | |
| isolation | 45/45 | |

- **Browser:** the console flow was checked in Chromium.

## Unchanged from v1.4.0

Still needed before a public launch:
- the acceptance test on real charger hardware (`docs/ACCEPTANCE-v1.4.md`);
- the QRIS acquirer and SMS/WhatsApp provider contracts;
- the e-Faktur item classification confirmed with a tax adviser;
- a V2G PKI provider for Plug & Charge;
- store accounts for white-label apps.
