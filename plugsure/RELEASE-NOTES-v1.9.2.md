# PlugSure CSMS v1.9.2: release notes

**Date:** 26 October 2026
**Base:** v1.9.1.

v1.9.2 points the PlugSure app at its **live host, `app.plugsure.co.id`**, and at the company's contacts and policies (PT. Railsure Solutions Indonesia). The web app (`https://app.plugsure.co.id/app/`) and the driver API already run on that host. The app was configured for `plugsure.asia`, which was never live. This is done before the store submission and the Xendit activation, so the app, the payment pages and the website describe one business.

There are no code-behaviour changes and no migration. Operator brands (white-label apps) are not affected.

## What changed

| | Before (v1.9.1) | Now (v1.9.2) |
|---|---|---|
| App API (`apiBase`) | `https://api.plugsure.asia` | **`https://app.plugsure.co.id`** (already serves `/d/*`) |
| Link domain: QR and share links, payment return `/paid`, account deletion, universal links / App Links | `go.plugsure.asia` | **`app.plugsure.co.id`** |
| Staging API (development and preview builds) | `staging-api.plugsure.asia` | `staging.plugsure.co.id` (create it, or change `mobile/eas.json`) |
| Support | `help@plugsure.asia`, placeholder numbers | **`hello@railsure.co.id`**, WhatsApp / phone **+62 811 3555 570** |
| Terms / privacy / help | `plugsure.asia/legal/…` | `https://plugsure.com/terms.html`, `https://plugsure.com/privacy.html`, `https://plugsure.com` |

Unchanged: the operator console stays on `https://dashboard.plugsure.co.id/`, and the website and policies on `https://plugsure.com` (pricing, terms, privacy, refunds).

The app's universal links (`applinks:app.plugsure.co.id`) and Android App Links follow the brand file (`mobile/brands/plugsure.json`).

Server code had no plugsure.asia address: hosts come from configuration. Its examples, tests and docs were updated; the hub guides now use `hub.plugsure.co.id` as the example.

**`deploy/DRIVER-APP-PILOT.md` §2:** the dedicated driver-app Caddy block now also serves the link pages:
- `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`;
- `/c/*`, `/s/*` and `/r/*`;
- `/paid` and `/account/delete`.

Before, it served only `/app` and `/d/*`. A host serving both the web app and the links needs all of them.

## Deploying (in this order)

1. **Caddy on `app.plugsure.co.id`.** Make sure its site block routes the paths above to the API (`127.0.0.1:9200`), as in the updated `DRIVER-APP-PILOT.md` §2 block. Then run `caddy validate` and `systemctl reload caddy`.
2. **Deploy v1.9.2** as usual: no migration (`npm run migrate` reports nothing to apply).
3. **Make `app.plugsure.co.id` the PlugSure Mobility brand's link host.** From a source checkout:
   ```bash
   MOBILITY_LINK_HOST=app.plugsure.co.id \
   MOBILITY_SUPPORT_EMAIL=hello@railsure.co.id \
   MOBILITY_TERMS_URL=https://plugsure.com/terms.html \
   MOBILITY_PRIVACY_URL=https://plugsure.com/privacy.html \
   npm run mobility:setup      # plus MOBILITY_IOS_BUNDLE_ID / _TEAM_ID, MOBILITY_ANDROID_PACKAGE / _CERT_SHA256 when known
   ```
4. **Check from outside:**
   - `https://app.plugsure.co.id/d/health` answers;
   - `https://app.plugsure.co.id/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` answer JSON (with the iOS team id and Android fingerprints once they are set in step 3);
   - `https://app.plugsure.co.id/app/` opens the web app;
   - `https://app.plugsure.co.id/account/delete` shows the deletion form.
5. **Staging:** create `staging.plugsure.co.id` for development and preview builds, or tell the developer the staging address to put in `mobile/eas.json`.

## Mobile app

- **New builds are needed.** The API address and link domain are built into the app, so run the EAS builds from v1.9.2 or later.
- **Apple:** the app's Associated Domains capability is now `applinks:app.plugsure.co.id`. EAS syncs capabilities on the next build.
- **Android:** App Links verify against `https://app.plugsure.co.id/.well-known/assetlinks.json`.

## Verification

- **Mobile:** typecheck, lint and 253 tests passing.
- **Server:** typecheck and the full unit suite (1,475 tests) passing.
