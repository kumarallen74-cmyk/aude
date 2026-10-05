# PlugSure Hub — mobile app (iOS + Android)

The PlugSure-branded EV-charging app for Indonesia, Malaysia and Singapore, and the code base for operators'
white-label apps. Product spec: [`../plugsure/docs/MOBILE-APP-SPEC.md`](../plugsure/docs/MOBILE-APP-SPEC.md).

**Stack:** Expo SDK 57 (React Native 0.86, React 19.2, New Architecture, Hermes), Expo Router (typed routes),
TypeScript strict, TanStack Query 5, i18next, react-native-maps, expo-camera / -notifications / -secure-store /
-web-browser / -location / -print / -sharing, supercluster, Jest + React Native Testing Library.

```
mobile/
  app.config.ts            per-variant Expo config (APP_VARIANT, APP_ENV, API_BASE_URL …)
  brands/<variant>.json    white-label brand files (+ brands/<variant>/ generated icons, splash, notification icon)
  eas.json                 EAS Build / Submit profiles
  plugins/                 config plugins: iOS Live Activity (+ widget-extension target), Android live session
  modules/live-activity/   local Expo module: ActivityKit bridge (Swift), autolinked
  modules/live-update/     local Expo module: Android 16 Live Update / progress notification (Kotlin), autolinked
  scripts/                 generate-assets.mjs, screenshots.mjs (mock), real-backend.mts (journeys vs plugsure/)
  src/app/                 routes (Expo Router) — every file is a screen
  src/api/                 typed driver-API client, ONE FILE PER AREA (+ mock/ demo backend)
  src/lib/                 pure domain logic (money, deep links, session state machine, filters, clustering …)
  src/components/          design system   src/theme/  tokens + brand palette   src/i18n/  en, id (+ ms, zh scaffolding)
  src/state/               auth (device token), settings, network, query client, pending checkout, active charge
  src/native/              push (APNs/FCM), Live Activity / ongoing notification, location, directions, auth browser
  src/features/            screen-level hooks and flows (stations, live session, checkout flow, tab bar, app gate)
```

## Architecture in one page

- **API client** (`src/api/`): `Http` adds `Authorization: Bearer psd_…`, `X-Driver-Brand`, `X-Driver-Lang`
  (`id|en`), `X-App-Version`, `X-App-Platform`, timeouts, and `Idempotency-Key` on payment / charge creation.
  Errors are classified (`offline`, `timeout`, `auth`, `not_found`, `rate_limited`, `business`, `server`) so every
  screen can say a human sentence and offer retry. One module per area — `stations`, `links`, `identity`, `charge`,
  `roaming`, `payments`, `favourites`, `push`, `account`, `appConfig`, `feedback`, `memberships`, `reservations` (and
  queues) — each follows the contract of spec **§15** (the backend as built).
- **Graceful degradation for what is not built yet (P1)**: ratings and problem reports ([§14 G9]) are feature-detected
  (`src/api/capabilities.ts`: a Fastify *route not found* 404 / 405 / 501 marks them unsupported for 6 h → WhatsApp
  hand-off); history paging ([§14 G14]) is sent and ignored by today's server; `ms` / `zh` are not offered until
  translated (the PlugSure brand ships `en`, `id`). Everything in G1–G8 and G11 is called as built, without fallbacks.
- **The map** (`src/features/mapViewport.ts`): `GET /d/v1/map` — hosted and partner stations merged, de-duplicated
  and **clustered on the server** by zoom, filtered server-side (connector, minKw, DC, available, network, startable;
  operator, price cap, AC-only and opening hours stay on the phone), plus the same call with `cluster=0` for the list
  under the map (nearest first). The last answer is kept for a cold start offline. Station / partner screens and
  search use `GET /d/v1/stations` and `/d/v1/roaming/stations` (full detail).
- **Session state machine** (`src/lib/sessionMachine.ts`): pure reducer over server snapshots — phases paying →
  starting → charging → finishing → completed / failed / refunding / refunded / released; start timeouts (45 s hosted,
  90 s roaming) never leave the driver in "starting"; reconnecting after two failed polls; Stop stays available;
  polling every 2–5 s in the foreground, push / Live Activity in the background.
- **Server state** in TanStack Query (retries only network / 5xx); **device token** in the Keychain / Keystore
  (`expo-secure-store`, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`); last map viewport and stations cached for offline.
- **Design**: Sora (numbers, headings) + Plus Jakarta Sans (text), 4-pt grid, ≥ 44 pt targets; the brand palette is
  ported from the backend's `brand.ts` so any white-label accent reaches 4.5:1; status colours are fixed and always
  paired with an icon and text; Dynamic Type up to 200 % (display numbers capped at 160 % so prices never truncate);
  dark mode; screen-reader labels on stations ("Mall X, 2 of 4 available, 120 kW DC, from Rp 2,466 per kWh").

## Setup

```bash
cd mobile
npm ci                      # Node 22
npm run typecheck && npm run lint && npm test
```

### Run

| What | Command |
|---|---|
| Dev client on a device / simulator (needed: native modules) | `eas build --profile development --platform ios|android` once, then `npm start` |
| Local native run (macOS / Android SDK) | `npx expo run:ios` · `npx expo run:android` |
| Web preview with the built-in demo backend | `EXPO_PUBLIC_API_BASE_URL=mock npx expo start --web` |
| Against a local backend | `API_BASE_URL=http://192.168.1.10:9200 npm start` |
| Web build against a local backend | backend with `DRIVER_WEB_ORIGINS=http://localhost:8081` (CORS for `/d/v1` only, off by default), then `EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:9200 npx expo start --web --clear` |

Expo Go is not supported (Live Activity module, maps config, notification channels need a dev build).

The **demo backend** (`API_BASE_URL=mock` / `EXPO_PUBLIC_API_BASE_URL=mock`) is an in-memory implementation of the
driver API with fictional sites in Jakarta, KL, Johor Bahru and Singapore: OTP code `123456`, fleet PIN `1234`,
"Simulate payment (demo)" on QR screens, simulated charging 40× faster. On web it persists in `localStorage`.

### Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `APP_VARIANT` | app.config.ts | brand file `brands/<variant>.json` (default `plugsure`) |
| `APP_ENV` | app.config.ts | `development` (`.dev` bundle-id suffix) · `preview` (`.preview`) · `production` |
| `API_BASE_URL` | app.config.ts → `extra.apiBase` | override the brand's API host; `mock` = demo backend |
| `EXPO_PUBLIC_API_BASE_URL` | runtime | same, inlined at bundle time (web preview, quick switches) |
| `EAS_PROJECT_ID` | app.config.ts | EAS project (enables EAS Update URL); or `easProjectId` in the brand file |
| `APPLE_TEAM_ID` | app.config.ts | Apple Developer Team ID (or `appleTeamId` in the brand file) |
| `GOOGLE_MAPS_ANDROID_KEY` | react-native-maps plugin | Google Maps SDK key for Android (iOS uses Apple Maps) |
| `GOOGLE_SERVICES_JSON` | app.config.ts | path to `google-services.json` (EAS file secret) for FCM |
| `GOOGLE_SERVICES_PLIST` | app.config.ts | only if Firebase SDKs are added on iOS (push uses APNs directly) |
| `EXPO_PUBLIC_SENTRY_DSN` | app.config.ts + runtime | crash reporting (Sentry, `@sentry/react-native/expo` plugin); **off when unset** (no plugin, no SDK init). Events are scrubbed of tokens, phone numbers and request bodies (`src/native/crash.ts`) |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | Sentry plugin (EAS secret) | source-map upload on EAS builds |
| `EXPO_PUBLIC_GOOGLE_PLACES_KEY` | runtime | place search through Google Places (New) Text Search; **off when unset** (station search only, `src/lib/placeSearch.ts`) |

`EXPO_PUBLIC_*` values are inlined into the bundle: after changing one, export / start with `--clear`, or Metro's
cache keeps the old value.

## White-label builds

1. Copy `brands/plugsure.json` to `brands/<variant>.json`; set `appName`, `easSlug`, `brandSlug` (= the server's
   `driver_app_brand.slug`, sent as `X-Driver-Brand`), `scope` (`operator` = scoped to the operator's own chargers,
   `network` = the PlugSure Hub app), `scheme`, `iosBundleId`, `androidPackage`, `linkHosts` (universal / app-link
   domains), `apiBase`, `accentColor`, `badgeColor`, locales, countries, default region, support + legal links,
   store URLs and `features` (build-time defaults; `/d/v1/app/config.features` overrides at runtime, §15.3).
2. `npm run assets -- <variant>` generates the icon, adaptive-icon layers, splash mark, notification icon and
   favicon from the brand colours (or drop the operator's own PNGs into `brands/<variant>/`).
3. Optional `brands/<variant>/google-services.json` (FCM). Add an EAS profile, e.g. `production-<variant>` with
   `APP_VARIANT=<variant>` (see `production-nusantara`).
4. `APP_VARIANT=<variant> npx expo config --type public` validates the brand file (`brands/validate.js`).

## Build & submit with EAS

What the owner needs:

- **Expo account** + organisation; `npx eas-cli@latest login`; `npx eas-cli init` once per variant → put the project
  id in `brands/<variant>.json` (`easProjectId`) or `EAS_PROJECT_ID`.
- **Apple Developer Program** account; **Team ID** (`appleTeamId` / `APPLE_TEAM_ID`); App Store Connect app record
  (its id → `eas.json` `submit.production.ios.ascAppId`). EAS creates certificates / profiles on the first build.
  Capabilities used: Push Notifications, Associated Domains (`applinks:<linkHost>`), App Groups (Live Activity).
  An **APNs key (.p8)** is uploaded to the PlugSure console per brand (the backend sends push, not Expo).
- **Google Play Console** app; a service-account JSON with release rights → `secrets/play-service-account.json`
  (git-ignored) for `eas submit`; first upload of an AAB is manual in the console.
- **Firebase project** per brand for FCM: add an Android app with the package id, download `google-services.json`
  → `brands/<variant>/google-services.json` or EAS file secret `GOOGLE_SERVICES_JSON`
  (`eas env:create --type file --name GOOGLE_SERVICES_JSON --value ./google-services.json`). The server needs the
  Firebase **service account** to send FCM HTTP v1 (§15.6; uploaded in PlugSure Mobility's console). `GoogleService-Info.plist` is **not** needed on iOS
  (APNs device tokens go straight to the backend) unless Firebase SDKs (Crashlytics, Analytics) are added.
- **Universal links / app links**: the link domain (`go.plugsure.asia`) must serve `apple-app-site-association`
  (appID `<TeamID>.asia.plugsure.hub`, paths `/c/*`, `/s/*`, `/r/*`, `/paid*`, `/app/*`) and
  `/.well-known/assetlinks.json` with the Play app-signing SHA-256 (§15.5).
- Android Google Maps key restricted to the package + signing SHA-1 (`GOOGLE_MAPS_ANDROID_KEY`).

```bash
npx eas-cli build --profile development --platform all          # dev client (internal distribution)
npx eas-cli build --profile preview --platform all              # QA builds against staging
npx eas-cli build --profile production --platform all           # store builds (autoIncrement build numbers)
npx eas-cli submit --profile production --platform ios          # → TestFlight
npx eas-cli submit --profile production --platform android      # → Play internal track (draft)
APP_VARIANT=nusantara npx eas-cli build --profile production-nusantara --platform all
```

Targets: iOS 16.2+ (Live Activities), Android 8.0+ (minSdk 26), compile / target SDK 36 (Play requirement from
31 Aug 2026), edge-to-edge and predictive back on. iOS privacy manifest (`PrivacyInfo.xcprivacy`) is generated from
`ios.privacyManifests` in `app.config.ts`.

### OTA updates (EAS Update)

`runtimeVersion` uses the **fingerprint** policy, so a JS update never lands on an incompatible native build. Build
profiles map to channels `development`, `preview`, `production` (`production-<variant>` per white-label).

```bash
npx eas-cli update --channel preview --message "fix: …"                     # QA
npx eas-cli update --channel production --message "…" --rollout-percentage 10
npx eas-cli update:edit                                                      # raise to 100 % when Sentry is green
npx eas-cli update:rollback                                                  # if not
```

OTA only for JS / assets — native changes, new permissions or store-reviewable features need a store build.
`/d/v1/app/config` (`minSupported` → `force`, `latest` → `softUpdate`) enforces floors (§15.3).

## iOS Live Activity & Android live session (§15.7)

- JS side: `src/native/liveSession.ts`. iOS content state **version 2** (`costIdr` / `estimateIdr` in minor units of
  `currency`, always present); the activity's update token goes to `POST /d/v1/live-sessions {platform:'ios', ref,
  token, contentVersion: 2}`. Native bridge: `modules/live-activity` (Swift, autolinked).
- Widget extension: `plugins/withLiveActivity.js` sets `NSSupportsLiveActivities`, the App Group, copies the widget
  sources to `ios/ChargingWidgets/` and **registers the `ChargingWidgets` app-extension target** with
  `withXcodeProject` (Sources / Frameworks: WidgetKit, SwiftUI / Resources phases, bundle id `<app id>.ChargingWidgets`,
  iOS 16.2, entitlements with the App Group, "Embed Foundation Extensions" in the app target, target dependency;
  idempotent). Verified by `expo prebuild` + reading the generated `project.pbxproj`; **not compiled here** (no Xcode).
  On the first EAS build, EAS creates the extension's provisioning profile; the App Group must exist in the Apple
  account (`group.<bundleId>`).
- Android: `modules/live-update` (Kotlin, autolinked) posts one ongoing notification per charge — on Android 16
  `Notification.ProgressStyle` with a status-bar chip (`shortCriticalText`) and `setRequestPromotedOngoing`
  (`POST_PROMOTED_NOTIFICATIONS` declared by `plugins/withAndroidLiveSession.js`), before 16 a standard progress
  notification. It is fed by the session screen and by FCM `live_session` data messages (foreground listener +
  `expo-task-manager` background task, `src/native/backgroundTasks.ts`); the FCM token is registered per charge with
  `POST /d/v1/live-sessions {platform:'android', ref, token}`, also on a `session.started` push. Without the module
  (Expo Go) a sticky expo-notifications notification is used. The JS side is unit-tested; the Kotlin is **not compiled
  here** (no Android SDK) — the first EAS Android build compiles it.

## Quality gates

| Check | Command |
|---|---|
| Types | `npm run typecheck` |
| Lint (incl. React Compiler rules) | `npm run lint` |
| Unit + component tests (190) | `npm test` |
| i18n completeness (en ⇄ id keys and `{{vars}}`, every `t('…')` key exists) | `npm run i18n:check` |
| Metro bundles | `npm run export:ios` · `npm run export:android` (Hermes bundle ≈ 4 MB, budget 6 MB) |
| Config / dependency health | `npx expo-doctor` |
| Visual review | `EXPO_PUBLIC_API_BASE_URL=mock npm run export:web && npm run screenshots` (Playwright, 390×844 + 360×800, light + dark, en + id) |
| Real backend journeys | see below (`scripts/real-backend.mts`) |

### Journeys against the real backend

`scripts/real-backend.mts` drives the web build against `plugsure/` like a driver, light + dark at 390×844, and
checks the server side too (31 checks): **A** guest → map (server clusters) → station → connector → QRIS (sandbox) →
live session updated by the simulated charger → stop → receipt → history; **B** phone OTP sign-in (development code) →
favourites → Singapore card hold through Stripe (the local fake of the stripe e2e) → the authorisation lapses →
unpaid → account deletion refused (409 unpaid) → paid in the app with PayNow (Save QR) → deleted → new guest device;
**C** QR deep link `/c/<IDENTITY>:<n>` → connector. Setup:

```bash
# plugsure/: the CI e2e env on API 9600 / OCPP 9620, plus DRIVER_WEB_ORIGINS=http://127.0.0.1:8090
npm run migrate && npm run seed            # owner URL; the seed includes PlugSure Mobility (brand `plugsure`)
npx tsx src/apps/gateway.ts & npx tsx src/apps/api.ts &
npm run sim -- --id AUTEL-DC60-SMB-002 --url ws://127.0.0.1:9620/ocpp --dc --connectors 2 --max-power 40000 --speed 6 --meter-interval 30 &
# mobile/
EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:9600 npx expo export --platform web --output-dir dist/web-real --clear
cd ../plugsure && npx tsx ../mobile/scripts/real-backend.mts /tmp/real-shots
```

CI: `.github/workflows/mobile.yml` runs typecheck, lint, tests and `expo export` for iOS and Android per variant.

## Store listing checklist

- **Screenshots**: iPhone 6.9" (1320 × 2868) and 6.5" (1284 × 2778); iPad 13" (2064 × 2752) because
  `supportsTablet` is on; Android phone (1080 × 1920 min, 16:9 or 9:16) and 7"/10" tablets. Per locale (en, id;
  ms, zh-Hans when enabled). App Preview video of the 60-s guest QRIS flow (spec J1).
- **Apple App Privacy labels** (match `PrivacyInfo.xcprivacy`): phone number, name, purchase history, device ID —
  linked, app functionality; precise location — not linked (sent as lat/lon for distance only, [VERIFY] server logs);
  crash data — not linked. No tracking → no ATT prompt.
- **Google Play Data safety**: same data types; encrypted in transit; deletion: in-app + web URL
  (`brands/<variant>.json` `links.deleteAccount` → the server's `/account/delete` web form, §15.8).
- **Account deletion**: Account → Delete account (App Store 5.1.1(v)): a code to the account's number, immediate
  deletion; refused while money is owed or a charge / hold / reservation / queue place is open (shown with actions).
- **Save QR**: iOS asks "Add Photos Only" (`NSPhotoLibraryAddUsageDescription`, after an in-app rationale); Android 10+
  needs no permission to add an image (write-only); Android 8–9 ask for `WRITE_EXTERNAL_STORAGE`, declared with
  `maxSdkVersion="28"` (`plugins/withSaveQrPermission.js`). The `READ_MEDIA_*` permissions are blocked — nothing to
  declare in Play's photo and video permissions form.
- **Android backup**: `allowBackup=false` — the device token, cached stations and a pending checkout belong to this
  phone; the account lives on the server (sign in again on a new phone).
- **Languages**: the PlugSure brand lists `en`, `id` (store listing and `CFBundleLocalizations` follow
  `brands/<variant>.json` `locales`); `ms` / `zh` are added there once translated.
- **Sign in with Apple**: not required — phone OTP only (guideline 4.8 applies only with third-party / social
  login). If Google sign-in is ever added, add Sign in with Apple in the same release.
- **Payments**: physical service, no IAP (3.1.3(e)); passes are access to charging [VERIFY with App Review].
- **Review notes**: a demo phone number + OTP and a sandbox charger QR (the sandbox acquirer shows "Simulate payment").
- Export compliance: `ITSAppUsesNonExemptEncryption = false` (HTTPS only).

## The driver API contract (spec §15) — where each part lives

| Area | As built (§15) | File |
|---|---|---|
| G1 network brand | `X-Driver-Brand: plugsure` on every call (PlugSure Mobility's network brand) | `client.ts`, `http.ts` |
| G8 config | `GET /d/v1/app/config?platform=ios\|android&version&build` → `force` / `softUpdate` decided by the server, `maintenance`, `features`, `links`, `brand`, `polling`; unreachable → never blocks; web asks without `platform` | `appConfig.ts`, `features/AppGate.tsx` |
| G7 map, paging | `GET /d/v1/map?bbox=w,s,e,n&zoom&near&limit&cursor&cluster=0&connector=CCS2,TYPE2&minKw&dc&available&network&startable`; `GET /d/v1/stations?bbox&near&limit&cursor` → `{stations,total,nextCursor}` | `stations.ts`, `features/mapViewport.ts` |
| G5 dedupe | the server leaves out partner locations of hosted operators; the app no longer de-duplicates | `lib/stationModel.ts` |
| G6 links | `GET /d/v1/links/resolve?url=` → connector / partner_evse / site / charge / receipt / partner_receipt / payment_return; 404 `other_operator` shown as such | `links.ts`, `app/c/[code].tsx`, `lib/deeplink.ts` |
| G2 push | `POST /d/v1/push/fcm {token, lang}` (Android), `/push/apns {token, lang}` (iOS), `/remove`; 409 `no_brand` → "needs brand"; re-registered at launch and on resume | `push.ts`, `native/notifications.ts` |
| G3 live sessions | `POST /d/v1/live-sessions {platform, ref, token, contentVersion?: 2}`, `/live-sessions/ended {ref}`; FCM `live_session` data messages | `push.ts`, `native/liveSession.ts` |
| G4 deletion | `POST /d/v1/account/delete/start {}` → `{phoneMasked, blockers, deleted, retained, devCode?}`; `POST /d/v1/account/delete {code}` → deleted, or 409 with `blockers` (Pay / Stop / Activity actions); afterwards a new device token | `account.ts`, `app/delete-account.tsx`, `state/auth.ts` |
| Unpaid sessions | `POST /d/v1/charge/:id/pay-unpaid` (any method the operator offers), `GET …/pay-unpaid` until paid | `charge.ts`, `features/UnpaidPay.tsx` |
| Reservations | `POST /d/v1/reservations {connectorId, …payment}` → held, or a fee `checkout` paid like a charge (`GET /reservations/checkout/:id`, `/confirm-payment` sandbox, `/cancel`) | `reservations.ts`, `features/checkoutFlow.ts` |
| Queues | `GET /d/v1/sites/:id/queue`, `POST /d/v1/queue {siteId, current, type}` (422 with `connectorId` = "free now"), `GET /d/v1/queue`, `POST /queue/:id/leave` | `reservations.ts`, `features/queue.tsx` |
| G11 payment return | every payment sends `returnUrl: <scheme>://paid`; the server honours only the brand's own scheme (scheme = `brandSlug`, enforced by `brands/validate.js`) through an https bounce `/paid?app=<slug>`; the auth session closes on it and the pay screen polls (§15.12) | `native/browser.ts`, `features/checkoutFlow.ts` |
| Not built (P1) | ratings / reports (G9: feature-detected), history paging (G14), ms / zh messages (G16) | `feedback.ts`, `charge.ts` |

## Not done here / follow-ups

- MapLibre with the operator's vector tiles ([OWNER]); react-native-maps (Apple / Google) behind the same props.
- Apple / Google Pay (v1.1, G10); analytics.
- Compile the Kotlin module and the widget extension on the first EAS build (not possible in this environment).
