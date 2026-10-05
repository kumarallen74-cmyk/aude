# PlugSure CSMS v1.9.1: release notes

**Date:** 5 October 2026
**Base:** v1.9.0.

v1.9.1 fixes what a review of the driver apps found before their store release: the native PlugSure app for iOS and Android (`mobile/`), the driver web app (`/app`, also the shell of operators' iOS apps), and the driver API they share. The operator console, billing and the pilot's charging flows are unchanged. One migration (077, additive).

## Upgrading

- **From v1.9.0:** deploy, then run `npm run migrate` (applies 077, in well under a second). There are no new required settings.
- **From v1.5.0 (the pilot):** follow `docs/UPGRADE-v1.5-to-v1.9.md`. It now applies 055 → 077.
- **Rollback:** the chain in `deploy/README.md` §7 now starts with `077_down`.

## Fixed

### Payments in the driver apps

- **A retried payment could charge twice.**
  - The apps sent an `Idempotency-Key` header, but the server ignored it. A payment retried after a timeout (a saved card can take longer than the app's 15 seconds) created a second payment.
  - The server now honours the key on every money-creating driver request:
    - prepaid and fleet charges;
    - settling an unpaid session, including `pay-expired` and `pay-now`;
    - reservations;
    - partner (roaming) charges and reservations;
    - passes.
  - The key is claimed before any work starts. A repeat gets the first answer back, marked `Idempotent-Replayed: true`.
  - New error codes:
    - `idempotency_in_progress` (409): a repeat while the first request is still running.
    - `idempotency_key_reused` (422): the same key for a different request.
    - `bad_idempotency_key` (400): a malformed key.
  - When the outcome of a request is unknown (an acquirer timeout), the key stays claimed for 10 minutes. A retry is answered "still processing" instead of charging again, and the payment notification settles the first attempt.
  - The apps keep one key per attempt across timeouts and retries.
- **A paid charge could be left unstarted.**
  - Only the payment screen started a charge. If the app was killed or lost signal after paying, the charge never started, and the driver waited for the refund.
  - Now the session screen starts a paid charge whose start was never confirmed, and offers "Try starting again" with the reason.
  - The start result survives a restart, and a pending payment can be resumed from the tab bar.
- **Wrong screen after settling an unpaid session.** The payment return (`/paid`) sent an unpaid-session settlement to the charge screen, which tried to start a charge that had already ended. It now goes to the settlement screen.
- **Web app: one payment screen could act on another.**
  - Listeners for "back from the bank app" and live-session polls outlived their screens. A later payment could be abandoned, or an earlier charge started or stopped in its place.
  - Every screen now cleans up when the driver leaves it.
  - A late price quote can no longer re-enable Pay.
  - A QR payment starts its charge once.
- **Partner charges:** "Use new card" could be tapped while a start was running, placing a second card hold.

### Accounts and sign-in

- **Sign-out now revokes the device.** Charges and receipts belong to the device that made them. Before, after a sign-out the next person on a shared browser or phone saw, and could act on, the previous driver's charges.
  - The device token is now revoked, and its push and live-session tokens are removed.
  - The app takes a new device token.
  - The account's own charges show again after signing in.
- **Account deletion in the web app.** Account → Delete account explains what is deleted and what is kept, asks for the code, and lists anything that must be settled first. This is required for operators' iOS apps (App Store guideline 5.1.1(v)).
- **App Review sign-in.** Reviewers cannot receive the sign-in SMS. The new settings `DRIVER_REVIEW_PHONE` and `DRIVER_REVIEW_CODE` (off unless set) give one number a fixed code:
  - nothing is sent for it;
  - every limit and the device binding still apply;
  - each use is logged;
  - a weak or malformed code stops the server from starting.

  Set them for the review and remove them after approval (`deploy/DRIVER-APP-PILOT.md` §8).

### Native app: iOS

- **The store build could not be made.**
  - Expo SDK 57 needs iOS 16.4; the app targeted 16.2.
  - The Live Activity widget's Info.plist had no bundle keys.
  - EAS was not told about the widget, so the widget was never provisioned.

  All three are fixed. The widget follows the app's version, and its unused App Group is removed.
- **Live Activities:**
  - A fractional battery level no longer stops updates.
  - Push tokens are no longer lost when they arrive early.
  - Reopening the app mid-charge no longer creates a second Live Activity.
- **App Review:**
  - The app is iPhone-only for the first release.
  - No Face ID purpose string (the app does not use Face ID).
  - An accurate motion purpose string.
  - Unused background modes removed.
  - The privacy manifest declares ratings and problem reports.
- **Development and preview builds** receive push and Live Activities, and open universal links. The apps send their bundle id, which the server uses as the push topic.

### Native app: Android

- **The store build could not be made.** The live-session notification used an Android 16 call that only exists from API 36.1; the app compiles against 36. It now uses the documented extra.
- **Notifications:**
  - Live-session updates no longer show as blank notifications while the app is open.
  - A charge started outside the app (card, web, another phone) now gets the live notification: the server sends Android an extra data-only message.
  - The finished state is shown, then dismissed.
  - Rotated push tokens are registered again.
- **Save QR works on Android 10.**
- **Production builds** refuse to build without the Maps key, the Firebase file, the EAS project id or the Apple team id. Before, they built and then crashed on the map or never received push.
- **Manifest:**
  - The unused location service is removed.
  - App Links match `/paid` exactly.
  - Development and preview builds verify App Links.

### Web app security

- **Scripts:** the driver pages allow only scripts carrying a per-response nonce. Before, any inline script could run, and the device token lives in browser storage.
- **Caching:** the page is served `no-store`.
- **`paid.html`:** its script moved to `paid.js`.

### Other

- **Repeated starts:** `/d/v1/charge/:id/start` on a charge that has already started now answers `code: already_started`, as well as the existing message.
- **Over-the-air updates:** an update published from a developer's shell can no longer point production apps at the demo or a local backend.
- **Mobile CI:** generates the iOS and Android projects for both brands and checks them (plist keys, deployment targets, permissions, App Links). Compiling them still needs EAS or macOS / Android SDK runners.

## Not changed (known, documented)

- **Native compilation:** the Swift and Kotlin changes could not be compiled here. The first EAS build of each platform confirms them. `mobile/README.md` lists what to check.
- **App store placeholders:** `eas.json` and `brands/*.json` still hold placeholders for the App Store Connect app id, the Apple team id and the EAS project id. Production EAS builds now refuse to build without them.
- **iOS notifications:**
  - Push-to-start for Live Activities, notification categories and rich-notification images are sent by the server but not used by the app yet.
  - iPad layouts are not built.

## Verification

- **Server:** typecheck clean; 1,475 unit and database tests, all passing. Migrations 001–077 apply from an empty database. The rollback chain 077 → 060 runs and re-applies.
- **End-to-end, everything on:** 23 suites, 1,104 checks. They cover the driver app, the driver extras, the queue, reservation fees, the mobile API, APNs, Live Activities, white-label brands, card holds, payment methods, linked e-wallets, post-pay, integrations, onboarding, OCPI CPO and eMSP, the SDK, the API sandbox, the field suite, the console and isolation.
  - The linked-e-wallet check was updated for `paid.js`.
  - The API sandbox suite passed when run on its own (38/38). In the long run, its rate limit answered first.
- **Mobile app:** typecheck and lint clean; 253 tests. A production prebuild of both brands passes the new project checks.
