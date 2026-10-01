# PlugSure CSMS v1.4.3 — release notes

**Date:** 2 October 2026
**Base:** v1.4.2

v1.4.3 fixes one cosmetic console defect: the last item in the user manual's list of known limitations. It has no migrations and no new settings, so upgrade by deploying the new build and restarting.

## Fix

- **User menu icons are the right size.** The menu at the top right (name, then **Change password**, **Theme** and **Sign out**) drew its icons 70–137 px wide, because nothing set their size. They are now 16 px, like the console's other small icons, and the menu is back to its compact height (213 px instead of 467 px). This is a style-only change (`src/web/assets/app.css`). Browsers revalidate the stylesheet, so open consoles pick it up on the next load.

## Upgrading from v1.4.2

No database or configuration change. Deploy the build and run `systemctl restart plugsure-api plugsure-gateway`, or restart the containers.

## Verification

- **Build and tests:** typecheck clean; the OpenAPI and SDK tests pass, and the e2e sdk suite passes after the version bump.
- **Generated files:** the OpenAPI document and TypeScript SDK are regenerated.
- **Browser:** the user menu was checked in Chromium, light and dark: each icon is 16×16.
