# PlugSure CSMS v1.5.0 — release notes

**Date:** 2 October 2026
**Base:** v1.4.4

v1.5.0 adds a white-label operator console. It has one additive migration (054) and no new settings. Upgrade by deploying the new build and restarting; the migration runs on start as usual.

## White-label operator console

An operator can now show its own brand in the operator console instead of PlugSure's. Before, only the driver app could be white-labelled (v1.3.0).

**Setting it up:** **Governance → Console branding**, which needs `org:write` (a Super Administrator has it). Every field except the product name is optional:
- **Product name:** up to 30 characters. It replaces "PlugSure" in the sidebar, on the sign-in page and in the window title.
- **Tagline:** shown under the name in the sidebar, replacing "Enterprise CSMS". It can be left empty.
- **Brand colour:** used for the sign-in panel, avatars and the logo tile.
- **Accent colour:** used for buttons, links, the selected page and highlights.
- **Logo:** a square PNG, 64 to 2048 pixels and up to 1 MB. It is stored as 256 × 256 and also becomes the browser-tab icon. Without a logo, the product name's initials are shown on the brand colour.
- **Console web address:** see below.
- **"Powered by PlugSure":** a credit line under the version in the sidebar. It is on by default and can be turned off.

**Colours stay readable.** As with the driver app, the accent is darkened for the light theme and lightened for the dark one, so text in it reads at 4.5:1 or more (WCAG AA). That holds on every console surface and on the accent's own tint. The brand colour is darkened if needed so white text on it reads at 4.5:1. The page shows each colour as it is actually used, with its contrast ratio.

**Who sees it:** every user of the operator, once signed in, on any console address. That includes the operator's staff and its site owners and fleet customers in their portals. Other operators keep their own brand, or PlugSure's.

**The console's own web address** (optional), for example `console.nusantaracharge.id`:
- On that address the sign-in page shows the operator's brand before anyone signs in.
- Only the operator's own accounts can sign in there. Any other account gets exactly the answer a wrong password gets, so the address cannot be used to find out whether a password is right. The attempt is audited as `auth.login_wrong_console`.
- An address belongs to one operator: another operator's console, or any driver app, is refused it with 409. A developer sandbox cannot be branded (409).
- **The server needs a Caddy site block for each address**, so that the console keeps its office or VPN allow-list. `deploy/Caddyfile` has a commented template, and `deploy/README.md` §2 has the steps.

**Back to PlugSure** removes the brand. Its web address then shows PlugSure's sign-in page and accepts any account again.

**API:**
- `GET`, `PUT` and `DELETE /v1/console-brand`.
- `PUT` and `DELETE /v1/console-brand/logo`.
- `/v1/auth/me` returns `consoleBrand`.
- Before sign-in, the console reads `GET /console-brand.json` (the brand of the requesting address), and logos are served at `/console-brand/<sha256>.png` (public, cached).
- Every change is audited (`console_brand.*`).

**Not white-labelled:**
- the API reference (`/api-docs.html`);
- the wording inside individual console pages that names PlugSure, such as the driver-app page;
- printable receipts, which are unchanged.

## Fix: driver-app web addresses and identifiers across operators

When an operator saved its driver app, the check that "another operator already uses this web address, short name, package name or bundle identifier" ran inside the operator's own request. Row-level security limits that request to the operator's own rows, so the check never found the clash. The database's uniqueness rule still stopped the duplicate, but the operator got a server error instead of the 409 that names the field. The check now looks across operators, and it also covers console web addresses.

## Upgrading

- **Migration 054** adds the `console_brand` table, with row-level security in the post-048 form. It is additive and needs no data change.
- **Without branding nothing changes:** every console looks as before.
- **Docker Compose and systemd:** deploy the new build and restart. On systemd, `plugsure-migrate.service` applies 054 on start.

## Verification

- typecheck clean; 826/826 unit and database tests, including the new console-brand tests:
  - contrast across colour combinations;
  - validation;
  - cross-operator address checks as the runtime role;
  - the logo.
- `console-brand` end-to-end suite (32 checks) against the running stack as `plugsure_app`:
  - saving and validation;
  - the sign-in page by address;
  - own account accepted and another operator's refused with the wrong-password answer;
  - the refusal audited;
  - the address protected from other operators' consoles and driver apps;
  - the logo served as 256 × 256;
  - a read-only key refused;
  - removal.
- Browser check (Chromium, light and dark), on the brand's address and on PlugSure's own:
  - the sign-in page, the sidebar, the window title, the tab icon and the accent colours;
  - PlugSure's own address unchanged.
