# PlugSure Hub mobile app — product specification (v1, native iOS + Android)

**Status:** draft for review. Branch `mobile` (from `hub`, v1.8.0).
**Date:** 4 October 2026
**Owner:** mobile product lead
**Stack:** React Native (New Architecture) + Expo SDK 55 (RN 0.83, React 19.2), TypeScript, expo-router, EAS Build / Submit / Update.
**Scope:** the PlugSure-branded consumer app for EV drivers in Indonesia (ID), Malaysia (MY) and Singapore (SG): find,
start, pay for and track charging at any charger reachable through PlugSure — chargers hosted on the PlugSure CSMS and
chargers of every CPO connected to the PlugSure Hub. The same code base later produces white-label builds for operators
(today served as a PWA in a TWA / Capacitor shell, `src/services/brand.ts`).

Markers: **[VERIFY]** needs confirming before it is relied on; **[OWNER]** is a business decision with a working default;
**[LEGAL]** needs counsel; **[BACKEND]** refers to an item in §14 (backend gap list).

---

## 0. Summary for decision makers

- **Problem in our markets:** drivers need one app per network. In Malaysia guides still tell EV owners to install every
  network's app ([soyacincau 2023](https://soyacincau.com/2023/01/15/ev-buyers-guide-malaysia-charging-apps-to-download-install/));
  roaming is arriving piecemeal (Gentari ⇄ JomCharge ⇄ chargEV, [Lowyat](https://lowyat.net/2023/296480/gentari-jomcharge-chargev-cross-access);
  ChargeSini ⇄ Gentari in Sept 2026, [carz.com.my](https://www.carz.com.my/2026/09/one-app-more-chargers-chargesini-and-gentari-roaming-goes-live?amp=1));
  a national platform is approved but undated ([soyacincau 2025](https://soyacincau.com/2025/11/13/national-e-mobility-service-platform-unify-malaysia-ev-infra/)).
  In Singapore dealers and super-apps are bolting on single networks (PML OneGo + Charge+, Motorist by end-2026,
  [motorist.sg](https://www.motorist.sg/article/6363/pml-onego-app-adds-ev-charging-across-singapore-and-malaysia)).
  Indonesia is fragmented between PLN Mobile (SPKLU) and CPO apps (Voltron, Starvo …).
- **The most-cited failure is not "missing features", it is "the start did not work"**: Gentari Go sessions failed at
  three sites while the same charger started fine from JomCharge, and the app kept a dead session "active" for minutes
  ([soyacincau, Sept 2026](https://soyacincau.com/2026/09/01/gentari-seriously-needs-to-buck-up-failed-gentari-go-charging-app/)).
  Shell Recharge reviews: slow map, cannot stop a session, unresponsive support ([Kimola](https://kimola.com/reports/shell-recharge-feedback-report-unlock-user-insights-google-play-it-it-145422)).
- **Our position:** the only app in the region that is *the hub itself* — one account, one payment set, every connected
  network, with the start path the hub routes (and can diagnose) end to end, honest "per the operator" prices before
  start, a reliability signal fed by real session outcomes (we see every OCPP / OCPI result), and local rails
  (QRIS, GoPay/OVO/DANA/ShopeePay/LinkAja, PayNow, FPX, GrabPay, cards with holds) already built in the backend.
- **MVP** (§6): map + list with live availability and filters; QR / code start; guest charge in < 60 s at hosted chargers;
  phone-OTP account; partner-network charging behind a card hold; live session with push + iOS Live Activity +
  Android ongoing notification; receipts and history; favourites; reservations and queue where the operator offers them;
  report-a-problem + post-session rating; en / id first, ms and zh-Hans in v1.1; dark mode; WCAG 2.2 AA.
- **Blocking backend gaps** (§14, P0): the PlugSure app has no explicit eMSP organisation (`emspOrgForApp(null)` only
  works when exactly one org has app roaming on); APNs / Live Activities refuse unbranded apps (409); no FCM at all;
  no account deletion; duplicate stations when hosted tenants also appear via the hub; per-operator saved cards break
  "one wallet"; no bbox/pagination on `/d/v1/stations`; no app-version gate.

---

## 1. Competitor benchmark

### 1.1 Who we looked at

Global aggregators / eMSPs: PlugShare, Plugsurfing, Chargemap, Electroverse (Octopus), Bonnet (OVO), Shell Recharge,
ChargePoint, Chargefox (AU), Tesla app (non-Tesla charging). Regional: Setel, Gentari Go, JomCharge, chargEV,
ChargeSini, DC Handal (MY); Charge+, SP app (SP Mobility), Shell Recharge SG, CDG ENGIE, ChargEco (SG); PLN Mobile
(formerly Charge.IN), Voltron, Starvo (ID).

Sources (fetched 2026-10-04):
- Plugsurfing: 1M+ points, 18+ partner networks, price compare + max-rate filter, trip planner, card/key, Apple/Google Pay — [plugsurfing.com](https://plugsurfing.com/plugsurfing-ev-charging-app)
- Electroverse: multi-network, card, route planner (≤ 5 waypoints), vehicle compatibility filter, CarPlay; cons: no digital wallet, failed remote session without notification, Android Auto late — [smarthomecharge](https://www.smarthomecharge.co.uk/reviews/electric-universe-review)
- Chargemap: map, filters incl. community rating, route planner (8M routes 2024, export to Google Maps), reviews, favourites, Pass — [blog.chargemap.com](https://blog.chargemap.com/?p=17733)
- PlugShare: community check-ins (5M+), PlugScore, photos; cannot pay/start in most of MY — [businesswire](https://www.businesswire.com/news/home/20220803005264/en), [soyacincau](https://soyacincau.com/2023/01/15/ev-buyers-guide-malaysia-charging-apps-to-download-install/)
- ChargePoint: filters, route optimiser, Apple/Google Pay, RFID, waitlist, alerts, CarPlay + Android Auto, Lock/Home-screen widgets, photo + problem reports, chatbot — [chargepoint.com](https://www.chargepoint.com/resources/how-use-chargepoint-app/)
- Chargefox: post-session star rating with reason; "charging speed insights" before plug-in — [chargefox.com](https://www.chargefox.com/news/rate-your-charging-experience)
- Tesla (non-Tesla): price and free stalls per site, dynamic pricing, membership, start by stall number; does not show charger generation — [electrifying.com](https://www.electrifying.com/blog/knowledge-hub/how-to-charge-a-non-tesla-at-a-tesla-supercharger)
- Bonnet: multi-network, refill plan, real-time data, in-app support — [fullycharged.show](https://fullycharged.show/about/bonnet-ev-charging-made-easy/)
- Shell Recharge: slow map, stop not working, poor support, limited payment — [Kimola report](https://kimola.com/reports/shell-recharge-feedback-report-unlock-user-insights-google-play-it-it-145422)
- Gentari Go: failed starts, stuck sessions; trip planner incl. roaming partners (Power Pass early access) — [soyacincau](https://soyacincau.com/2026/09/01/gentari-seriously-needs-to-buck-up-failed-gentari-go-charging-app/), [carz.com.my](https://www.carz.com.my/2025/1/gentari-go-app-now-features-trip-planner)
- JomCharge: AutoCharge (VIN, plug-and-go) at 200+ locations, filter for it; partner brands only — [carz.com.my](https://www.carz.com.my/2024/06/over-200-jomcharge-charging-location-autocharge-points-enabled)
- chargEV: subscription (RM240/yr), real-time status; older AC needs a card — [soyacincau](https://soyacincau.com/2023/01/15/ev-buyers-guide-malaysia-charging-apps-to-download-install/)
- Setel: EV charging for Gentari/JomCharge in the fuel super-app, wallet + Mesra points — [ringgitplus](https://ringgitplus.com/en/blog/apps/setel-rolls-out-ev-charging-feature.html)
- ChargeSini ⇄ Gentari roaming: live bays, exact per-kWh rate, saved card — [carz.com.my](https://www.carz.com.my/2026/09/one-app-more-chargers-chargesini-and-gentari-roaming-goes-live?amp=1)
- SP app: find, card-linked payment, start/stop, session updates — [spdigital.sg](https://spdigital.sg/spapp/ev-charging)
- Charge+ via OneGo (SG + MY), card billing, Singpass sign-up — [motorist.sg](https://www.motorist.sg/article/6363/pml-onego-app-adds-ev-charging-across-singapore-and-malaysia)
- SG networks overview (SP, Charge+, CDG ENGIE, Shell, Bluecharge …) — [evreporter](https://evreporter.com/leading-electric-vehicle-charging-networks-in-singapore/)
- Voltron: find, real-time availability, start/monitor, pay, Voltron Points; iPhone, English only, too few ratings to show — [App Store](https://apps.apple.com/kr/app/id6448490407)
- PLN Mobile: SPKLU locator and charging (Charge.IN merged in) — [CNBC Indonesia](https://www.cnbcindonesia.com/news/20231230174413-4-501530/traveling-pakai-ev-cek-spklu-terdekat-di-pln-mobile), [Kontan](https://industri.kontan.co.id/news/permudah-pengisian-baterai-kendaraan-listrik-pln-hadirkan-aplikasi-charge-in)

**[VERIFY]** Store ratings move weekly and were not systematically scraped; cells marked "?" below were not confirmed from
a source today. Before the design review, export current ratings and the last 90 days of 1–2★ reviews (AppFollow /
appbot) for Gentari Go, JomCharge, chargEV, Charge+, SP, PLN Mobile, Voltron and tag them with the themes in §1.3.

### 1.2 Feature × app

Legend: ● yes · ◐ partial / some markets / some networks · ○ no · ? not confirmed.
"Target" is the PlugSure Hub app: **M** = MVP, **S** = should (v1.1), **L** = later.

| Feature | PlugShare | Plugsurfing | Chargemap | Electroverse | ChargePoint | Chargefox | Tesla | Gentari Go | JomCharge | SP app | PLN Mobile | **Target** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Map of many networks | ● | ● | ● | ● | ● | ◐ | ○ | ◐ (roaming) | ◐ (roaming) | ○ | ○ | **M** (hosted + every hub CPO with an agreement) |
| Live availability per connector | ◐ | ● | ◐ | ● | ● | ● | ● (stalls) | ● | ● | ● | ● | **M** |
| Filters: connector / power / network | ● | ● | ● | ● | ● | ◐ | ○ | ? | ● (incl. AutoCharge) | ◐ | ? | **M** (+ "available now", "price ≤", "startable in app") |
| Price before start | ○ | ● | ◐ | ● | ● | ● | ● | ● | ● | ? | ● | **M** (incl. tax label, fees, hold amount) |
| Start in app | ○ (MY) | ● | ◐ (Pass) | ● | ● | ● | ● | ● | ● | ● | ● | **M** |
| QR scan to start | ○ | ● | ? | ● | ● | ● | ○ | ? | ● | ? | ● | **M** + universal link from the QR |
| Guest charge without account | ○ | ○ | ○ | ○ | ◐ (Apple/Google Pay) | ○ | ○ | ○ | ○ | ○ | ○ | **M** (hosted chargers; QRIS / card hold / PayNow) — differentiator |
| Local wallets (QRIS, GoPay, OVO, DANA, PayNow, FPX, GrabPay, TnG) | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ◐ | ◐ | ○ | ◐ | **M** (TnG / DuitNow / Boost / NETS later — reserved in `provider.ts`) |
| Apple Pay / Google Pay | ○ | ● | ? | ○ | ● | ? | ○ | ? | ? | ? | ○ | **S** (Stripe PaymentSheet; Midtrans/Xendit [VERIFY]) |
| Card / RFID ordering | ○ | ● | ● | ● | ● | ● | ○ | ? | ? | ? | ○ | **L** (fleet RFID exists; consumer card **[OWNER]**) |
| Plug & Charge / AutoCharge | ○ | ◐ | ○ | ○ | ◐ | ○ | ● | ◐ | ◐ (VIN) | ○ | ○ | **L** (ISO 15118 PnC exists CSMS-side, `src/pnc`) |
| Reservations | ○ | ○ | ○ | ○ | ◐ | ○ | ○ | ? | ? | ○ | ? | **M where offered** (built incl. partner reservations) |
| Queue / waitlist | ○ | ○ | ○ | ○ | ● | ○ | ○ | ○ | ○ | ○ | ○ | **M where offered** (built) |
| Live session, push | ○ | ● | ◐ | ◐ (failures silent) | ● | ● | ● | ◐ (stuck sessions) | ● | ● | ? | **M** |
| iOS Live Activity / Android live notification | ○ | ? | ○ | ? | ● (widgets) | ? | ● | ? | ? | ? | ○ | **M** — differentiator in the region |
| Receipts / tax invoice | ○ | ● | ◐ | ● | ● | ● | ● | ● | ● | ● | ● | **M** (PPN / GST / SST labels per country, PDF) |
| Favourites | ● | ● | ● | ● | ● | ● | ○ | ? | ? | ? | ? | **M** |
| Reviews / photos / check-ins | ● | ◐ | ● | ○ | ● | ◐ (rating) | ○ | ○ | ○ | ○ | ○ | **M**: rating + problem report; **S**: photos, tips |
| Reliability score | ● (PlugScore) | ○ | ◐ | ○ | ○ | ◐ (speed insights) | ○ | ○ | ○ | ○ | ○ | **M** — computed from real start/stop outcomes, not just votes — differentiator |
| Route planner | ● | ● | ● | ● (≤ 5 waypoints) | ● | ? | ● (car) | ◐ (early access) | ○ | ○ | ? | **S** (corridor search); **L** (full SoC-aware planner / ABRP hand-off) |
| Membership / passes / loyalty | ○ | ◐ | ● (Pass) | ● | ◐ | ○ | ● | ● | ? | ? | ? | **M** (passes, loyalty built) |
| Offline map cache | ? | ? | ● | ? | ? | ? | ○ | ? | ? | ? | ? | **M** (last viewport + favourites); **S** (region packs) |
| CarPlay / Android Auto | ○ | ? | ● | ◐ (CarPlay) | ● | ? | n/a | ? | ? | ? | ○ | **L** (§12) |
| Widgets | ○ | ○ | ○ | ○ | ● | ○ | ● | ○ | ○ | ○ | ○ | **L** (generated iOS widget code exists in the kit) |
| Languages | many | many | many | en | many | en | many | en, ms? | en, ms? | en | id | **M** en, id; **S** ms, zh-Hans |
| Dark mode | ● | ● | ● | ● | ● | ? | ● | ? | ? | ? | ? | **M** |
| In-app support / chat | ○ | ● | ● | ● | ● (bot) | ● | ● | ? | ? | ? | ● | **M**: call/WhatsApp operator from the session; **S**: ticket |

### 1.3 Review themes (what drivers punish)

| Theme | Evidence | Our answer |
|---|---|---|
| Start fails / app and charger disagree | Gentari Go fails where JomCharge works; stuck "active" session ([soyacincau](https://soyacincau.com/2026/09/01/gentari-seriously-needs-to-buck-up-failed-gentari-go-charging-app/)) | Start state machine with explicit timeouts and a server-side "no session after N s → release hold, say so, offer retry / another connector"; reliability score; hub trace id on every failure for support. |
| Cannot stop / session state wrong | Shell Recharge ([Kimola](https://kimola.com/reports/shell-recharge-feedback-report-unlock-user-insights-google-play-it-it-145422)); Electroverse silent failures ([smarthomecharge](https://www.smarthomecharge.co.uk/reviews/electric-universe-review)) | Stop button always visible; "stop at the charger" fallback text; push on every state change incl. interrupted; Live Activity marks stale after 180 s. |
| One app per network | MY guides ([soyacincau](https://soyacincau.com/2023/01/15/ev-buyers-guide-malaysia-charging-apps-to-download-install/)) | The hub. |
| Payment friction (top-ups, minimums, card only, no wallets) | Shell Recharge MY RM200 token minimum (same source); Electroverse no digital wallet | No stored-value; pay per session; local rails; holds only for the amount chosen; Apple/Google Pay in v1.1. |
| Slow map | Shell Recharge | Viewport API with clustering server-side, cached tiles, 60 fps budget (§10). |
| Wrong / missing info (power, generation, price) | Tesla app omits charger generation ([electrifying](https://www.electrifying.com/blog/knowledge-hub/how-to-charge-a-non-tesla-at-a-tesla-supercharger)) | Per-connector kW, AC/DC, connector, price with tax label, last successful session time. |
| Support unreachable | Shell Recharge | Operator phone/WhatsApp on the session and receipt screens (brand `supportPhone`), problem report with photo. |

### 1.4 Table stakes vs differentiators

**Table stakes (must be at parity on day 1):** multi-network map with live status; filters (connector, power,
AC/DC, network, available now); price before start; QR and in-app start; live session with push; stop in app;
receipts/history; favourites; card payment; account; dark mode; English + national language.

**Differentiators we can credibly ship (backend already has most of it):**
1. **Guest charge in < 60 s** at hosted chargers, no account (QRIS / card hold / PayNow).
2. **Local rails everywhere**: QRIS + 5 ID e-wallets with linking and post-pay, PayNow, FPX, GrabPay.
3. **Hub-native reliability**: a score from real outcomes (starts accepted/refused, sessions with 0 kWh, faults) across
   *all* networks, not just community votes.
4. **Live Activity + Android 16 Live Update** for every session incl. partner networks.
5. **Reservations and queue** at busy sites (rare in the region).
6. **Honest money**: hold amount shown before start ("S$80 is held and released after charging"), tax label, the
   partner's tariff "per the operator", unpaid-shortfall flow.
7. **Cross-border**: one account and receipts in IDR / MYR / SGD with no FX (KL → Singapore trip works with one app).

---

## 2. Current capabilities (backend v1.8.0, branch `hub`)

> As of 1.9.0-dev the P0 gaps noted in this section are closed; see §15 for the API as built.

### 2.1 Driver API (`src/driver/server.ts`, mounted at `/d/`)

| Area | Endpoints (method path) | Notes |
|---|---|---|
| Public browse | `GET /d/v1/stations?lat&lon`, `GET /d/v1/connectors/:id`, `GET /d/v1/resolve?code`, `GET /d/v1/meta`, `GET /d/v1/sites/:siteId/queue` | No auth. `stations` returns **all** publicly listed sites (no bbox, no paging, price computed per connector in a loop). `resolve` accepts connector UUID, `IDENTITY:n`, `IDENTITY/n`, bare identity, SPKLU id. |
| Identity | `POST /d/v1/device` → `psd_…` token; `GET /d/v1/me`; `POST /d/v1/otp/send`, `/otp/verify`; `POST /d/v1/account/name`; `POST /d/v1/fleet/login` (org slug + RFID + PIN); `POST /d/v1/signout` | Tiers: guest (device) → account (phone OTP) → fleet. Rate limits per number/IP/device. No email, no social sign-in, **no account deletion**. |
| Charge (hosted) | `POST /d/v1/charge/quote`, `/charge/prepaid`, `/charge/fleet`, `/charge/:id/confirm-payment`, `/charge/:id/start`, `GET /charge/:id/status`, `POST /charge/:id/stop`, `/charge/:id/v2x`, `GET /charge/:id/receipt`, `/receipt.html`, `POST /charge/:id/pay-now`, `GET /d/v1/unpaid`, `POST|GET /charge/:id/pay-unpaid[/confirm-payment]`, `GET /d/v1/history` | Prepaid amount with QRIS / e-wallet / card (hold) / PayNow / FPX / GrabPay; post-pay with linked e-wallet; payment `action` is `qr` / `redirect` / `done`; return URL `…/app/paid.html?for=…`. History: last 40 + roaming, no paging. |
| Roaming (partner CPOs) | `GET /d/v1/roaming/stations`, `POST /roaming/charge`, `GET /roaming/charge/:id/status`, `POST /roaming/charge/:id/stop`, `GET /roaming/cdr/:id`, `POST|GET /roaming/reservations[/:id][/cancel]` | Signed-in app drivers (card hold in the location's currency) or fleet cards. Stations from `ocpi_remote_location` of the eMSP org. |
| Payment instruments | `GET /d/v1/cards`, `DELETE /d/v1/cards/:id`, `POST /d/v1/wallets`, `GET /d/v1/wallets/:id` | Saved cards are acquirer tokens **valid only at the operator whose acquirer issued them** (`cards.ts`). |
| Memberships / loyalty | `GET|POST /d/v1/memberships`, `PUT /memberships/:id/auto-renew`, `GET|POST /memberships/charges/:id[/confirm-payment]`, `GET /d/v1/loyalty`, `PUT /loyalty/:orgId` | Per-operator 30-day passes, points. |
| Reservations / queue | `GET /d/v1/reservation`, `POST /d/v1/reservations`, checkout + cancel; `GET|POST /d/v1/queue`, `POST /queue/:id/leave` | Global switch `DRIVER_RESERVATIONS`; fees supported. |
| Favourites | `GET|POST /d/v1/favourites`, `DELETE /favourites/:id` | Own and partner stations. |
| Push | `GET /d/v1/push`, `POST /push/subscribe|unsubscribe` (Web Push/VAPID); `POST /push/apns`, `/push/apns/remove`; `POST /d/v1/live-activities`, `/live-activities/start-token`, `/live-activities/ended` | **APNs and Live Activities only for a white-label brand** (409 without one). **No FCM.** Live Activities cover hosted sessions only (no roaming). |
| Branding | `X-Driver-Brand` / host → `req.brand`; `/.well-known/apple-app-site-association`, `assetlinks.json` per brand | A brand **restricts every endpoint to the brand org's own chargers** (preHandler `other_operator`). |
| i18n | `X-Driver-Lang` → server messages; Indonesian source strings, English dictionary (`src/driver/i18n.ts`) | `domain/locale.ts`: `Lang = 'id' | 'en'` only. |

PWA (`src/driver-web/index.html`, ~3,000 lines): map with client-side clustering merging own + partner stations,
scanner, pay flows, live session, receipts, history, account, favourites, push, dark/light, id/en. It is the functional
reference for the native app; screens in `docs/app-screens/*.png`.

### 2.2 Which "app" is the PlugSure Hub consumer app at the data level?

Today, the code knows two kinds of driver app:

1. **A white-label operator app** (`driver_app_brand` row, request carries the brand): scoped to that operator's org;
   partner networks through that org's own eMSP role (`emspOrgForApp(brandOrgId)` when its roaming setting
   `appDrivers` is on).
2. **"No brand: the PlugSure app, across every operator"** (`brandOf` comment in `server.ts`):
   - **Hosted chargers** (every tenant on the PlugSure CSMS): `/d/v1/stations` lists them cross-tenant. A charge is a
     direct session at that tenant; **the tenant is the merchant**, paid through **the tenant's own acquirer** (its
     Midtrans/Xendit/Stripe integration). No roaming, no hold unless the method is a card hold. Guests allowed.
   - **Partner chargers** (CPOs reached through the hub or bilateral OCPI): `/d/v1/roaming/stations` reads
     `ocpi_remote_location WHERE org_id = emspOrgForApp(null)`. With no brand, `emspOrgForApp` returns the org **only if
     exactly one organisation** has `roaming_settings.appDrivers = true`; with zero or two-plus it returns null and
     roaming is disabled for the PlugSure app. The driver is signed in; a virtual `APP_USER` token
     (`APP` + hash of org + driver) is minted under that org's home eMSP party; a card hold is placed on **that org's**
     acquirer in the location's currency; the CPO bills that org through the hub's clearing ledger (HUB-DESIGN §8).

**Decision (recommended, [OWNER] to confirm):** the PlugSure Hub app's driver belongs to a dedicated
**"PlugSure Mobility" eMSP tenant organisation** that:
- has OCPI parties `ID*PSM`, `MY*PSM`, `SG*PSM` **[OWNER: party ids]** (EMSP role at least in the home country;
  contract ids `XX-PSM-…`), its own acquirer integrations per country (Midtrans/Xendit for IDR, Stripe SG/MY), and
  `roaming_settings.appDrivers = true` with hold amounts per currency;
- **joins the PlugSure Hub as an internal member** (`joinInternal`, HUB-DESIGN §4.4) and holds active agreements (or
  open roaming) with every CPO party — so the hub delivers all agreed CPOs' locations and tariffs into its
  `ocpi_remote_location` / `ocpi_remote_tariff`;
- owns a **network-scope brand** (new, [BACKEND] G1/G2): app name "PlugSure", APNs key, FCM credentials, bundle ids,
  universal-link domain — but **without** the org-scoping preHandler, so hosted tenants remain directly chargeable.

Consequences the app must model:
- **Two charge paths, one UI.** Each station carries `path: 'direct' | 'roaming'`. Direct = hosted tenant, guest OK, the
  tenant's payment methods; roaming = signed-in, card hold via PlugSure Mobility. The app hides this except where it
  changes what the driver must do (sign in, hold notice, "price per the operator").
- **Hosted tenants that also joined the hub would appear twice** (directly and via the hub import). Prefer the direct
  path ([BACKEND] G5).
- **Saved cards are per acquirer.** A card saved at operator A cannot pay operator B's hosted charger; it *can* pay
  every roaming charge (all on PlugSure Mobility's acquirer). Long-term "one wallet" means either routing hosted
  tenants through PlugSure Mobility as eMSP as well (then PlugSure Mobility is merchant of record to the driver —
  normal for an eMSP, separate from the hub entity's non-MoR stance in HUB-DESIGN D10, **[LEGAL]** per country), or
  network tokenisation at the acquirer. MVP: show "usable at" on each card and pre-select a matching one.
- Guests cannot roam (HUB-DESIGN / MULTI-COUNTRY §D7): a guest tapping a partner station sees "Sign in with your phone
  number to charge on partner networks (about 30 s)".

---

## 3. Personas and key journeys

| Persona | Context | Needs | Success metric |
|---|---|---|---|
| **Rina — first-timer, Jakarta** | Rented / new EV, at an SPKLU in a mall, never used the app | Scan, see price, pay with QRIS/GoPay, done — no sign-up | QR scan → energy flowing < 60 s (p50), < 90 s (p90) |
| **Hafiz — daily commuter, Klang Valley** | Charges 2–3×/week near office, cares about price and free bays | Favourites, availability, "notify me when free", passes | Weekly active; ≤ 3 taps from open to start at a favourite |
| **Mei Ling — road-tripper KL → Singapore** | Cross-border, MYR then SGD, unfamiliar networks | Corridor chargers with reliability, one account, cards valid both sides, offline fallback at Second Link / Woodlands | Zero "app needed per network" moments; all receipts in one history |
| **Budi — fleet driver, Surabaya** | Company EV, fleet RFID, postpaid | Fleet login, roaming with fleet card, no personal payment | Fleet sessions start without payment UI |
| **Operator support agent** (secondary) | Gets a call "it won't start" | Session / hub trace id from the driver | Ticket resolved without asking for screenshots |

### J1 — first charge as guest in under 60 s (hosted charger)
1. Driver scans the sticker QR with the **camera app** → universal link `https://go.plugsure.asia/c/<code>` opens the
   app (installed) or an App Clip / Instant App **[L]** / the PWA (not installed) **(t ≈ 3 s)**.
2. App boots cold (≤ 2.0 s budget), silently obtains a device token (`POST /d/v1/device`) in parallel with
   `GET /d/v1/resolve?code=` **(t ≈ 5 s)**.
3. **Connector screen**: name, kW, connector, status, price per kWh incl. tax label, fees, "Plug in your car" prompt.
   Amount presets from the server (`presetsMinor`) with the default selected **(t ≈ 15 s)**.
4. Method sheet: last-used or country default (ID: QRIS; SG: PayNow / card hold; MY: card hold / FPX). One tap
   **(t ≈ 20 s)**.
5. QRIS: QR shown + "Open GoPay/OVO/DANA…" buttons (deep link to the wallet app with the QR) — or e-wallet redirect —
   or Stripe PaymentSheet (v1.1) **(t ≈ 40 s)**.
6. Payment confirmed (poll `confirm-payment` + push) → auto `start` → **Starting…** with a 0–45 s progress
   (OCPP RemoteStart accepted → Charging) **(t ≈ 50 s)**.
7. Live session; Live Activity / ongoing notification starts. Offer "Save your receipts — add phone number" *after*
   charging starts, never before.
Failure branches: connector not plugged (status Available after start → "Plug in, we'll start automatically for 2 min");
start refused → refund/hold release message with the exact amount and when; charger offline → suggest nearest
available connector at the same site.

### J2 — regular commuter
Home tab opens on **Favourites strip** with live availability; tap → connector → "Start with GoPay ••12" (linked
wallet, post-pay) → slide to start. "Notify me when one is free" joins the queue (where offered) or sets a local
availability watch (S, [BACKEND] G14). Weekly summary push (kWh, cost) opt-in (L).

### J3 — road trip KL → Singapore
Before: **Trip** (S) — enter destination; app returns DC chargers within N km of the route polyline with reliability,
price and currency, filtered to "startable in app" and the car's connector (vehicle profile). Save as a trip; region
pack offline (S). On the road: CarPlay/Android Auto (L). Across the border: currency switches from MYR to SGD
automatically per site; the card hold at a Singapore partner shows "S$80 held"; receipts in each currency; history
shows totals per currency (no FX). Edge: roaming starts at partner CPOs can take 30–60 s — show "Waiting for <operator>…"
with the operator's name and a "Start at the charger instead" hint after 60 s.

### J4 — fleet driver
Account → "I have a fleet card" → org code + RFID uid + PIN (`/fleet/login`). Start shows "Billed to <Fleet>"; no
payment UI. Partner stations show if the fleet card is roaming-enabled, else the reason from the API.

---

## 4. MVP scope

### Must (v1.0, store launch)
1. Map + list with clustering, live status, distance, price-from, network badge, `direct`/partner indicator.
2. Filters: connector type, AC/DC, min power, available now, network/operator, startable in app, open now (if data).
3. Search (place / station name / charger code) — place search via the map provider's geocoder **[OWNER: provider]**.
4. Station + connector detail: connectors, status, kW, price (energy, time, idle, session fee; tax inclusive/exclusive
   label), hold amount for partner charges, opening hours, address, directions hand-off (Google Maps / Apple Maps /
   Waze), last successful charge time, reliability badge.
5. QR scanner + manual code entry; universal links / app links for charger QR.
6. Guest flow (device token) at hosted chargers; phone OTP account (id/my/sg numbers).
7. Payment: QRIS, linked e-wallets (GoPay/OVO/DANA/ShopeePay/LinkAja incl. post-pay), card (hosted checkout page in an
   in-app browser — `ASWebAuthenticationSession` / Chrome Custom Tabs), PayNow QR, FPX, GrabPay; saved cards and
   wallets management.
8. Partner-network charging (roaming) for signed-in drivers with hold notice; fleet card charging.
9. Live session: energy, power, SoC (when reported), elapsed time, estimated cost, stop; status polling + push.
10. iOS Live Activity (hosted + roaming) and Android ongoing notification (Live Update on Android 16).
11. Push notifications: charging started / interrupted / finished / idle fee soon / receipt ready / unpaid reminder /
    reservation and queue events / roaming CDR settled.
12. Receipts (in-app + PDF/share), history with paging, unpaid sessions pay-now.
13. Favourites.
14. Reservations and queue where enabled; memberships (passes) and loyalty read/redeem.
15. Report a problem (category, optional photo, connector) + post-session 1–5★ rating with reason (Chargefox pattern).
16. Reliability badge on stations (from G9).
17. Account: name, phone, language, theme, notification settings, sign out, **delete account**.
18. Languages en + id; dark mode; WCAG 2.2 AA; Dynamic Type / font scale up to 200 %.
19. Force-update / soft-update gate; maintenance banner.
20. Crash reporting + privacy-preserving analytics (§13).

### Should (v1.1, ≤ 3 months after launch)
Apple Pay / Google Pay (Stripe PaymentSheet; QRIS-native wallets already cover ID), ms + zh-Hans, route corridor search
("chargers along my route"), vehicle profile (connector, max DC kW → filters and estimates), photos and tips on
stations, availability watch ("tell me when free"), region offline packs, biometric lock, in-app support tickets,
Sign in with Apple / Google (only if we add social login — see §11.2), Home-screen widget (favourite station status).

### Later
Full SoC-aware route planner or ABRP integration, CarPlay / Android Auto, Plug & Charge / AutoCharge enrolment
(VIN/EMAID contract, `src/pnc`), consumer RFID card ordering, App Clip / Instant App for QR, Wear OS / watchOS,
smart-charging preferences (V2X consent exists: `/charge/:id/v2x`), subscriptions across networks, referral, TnG /
DuitNow / Boost / NETS rails (reserved channels).

---

## 5. Navigation and information architecture

Bottom tab bar (4 tabs; Scan is a prominent centre action, not a tab destination):

| Tab | Root screen | Contains |
|---|---|---|
| **Map** | Map (toggle to List) | Search, filters, station sheet → connector → pay → session |
| **Scan** (centre FAB) | Scanner (modal) | Camera, torch, manual code; → connector |
| **Activity** | Current session (if any) on top, then history | Live session, receipts, unpaid, reservations, queue |
| **Account** | Profile | Sign-in, payment methods, passes & points, favourites, vehicle (S), language, theme, notifications, help, legal, delete account |

Favourites appear as a horizontal strip on the Map tab and as a list under Account. A global **session pill** floats
above the tab bar whenever a session, reservation or queue offer is active (tap → Activity).

Routing (expo-router): `/(tabs)/map`, `/(tabs)/activity`, `/(tabs)/account`, `/scan` (modal), `/station/[siteId]`,
`/partner/[partnerId]/[locationId]`, `/connector/[id]`, `/pay/[connectorId]`, `/session/[kind]/[id]`
(`kind` = `charge` | `roaming`), `/receipt/[kind]/[id]`, `/c/[code]` (deep-link resolver), `/paid` (payment return).

---

## 6. Screen-by-screen spec

Every screen defines **loading** (skeletons, never spinners > 300 ms without context), **empty**, **error**
(human sentence + retry + support link; network vs server vs business error), **offline** (cached data with
"Last updated hh:mm" + disabled actions that need the network), and **permission-denied** where relevant.

### 6.1 Onboarding / first open
- No sign-up wall. 2 cards max: "Charge at every network" / "Pay with QRIS, e-wallets, cards". Skip always visible.
- Location permission asked **in context** on first map open (pre-prompt explaining "to show chargers near you");
  denied → map centres on the country by locale/IP-free heuristic (SIM country / device region) and shows a banner.
- Notification permission asked **after the first successful start** (pre-prompt: "Know when charging finishes").
- Device token issued silently on first launch; stored in secure storage.

### 6.2 Map
- MapLibre GL (vector tiles, `/d/v1/meta.map.tileUrl` raster fallback) **[OWNER: tile provider; OSM's public tiles
  are not for production traffic]**. Server-side clusters by zoom ([BACKEND] G7). Marker = availability colour
  (available / busy / out of order / unknown) + max power glyph; partner network badge.
- Bottom sheet (peek → half → full): nearest stations list sorted by distance, then availability.
- Filter chips row: Available now · DC fast · connector (from vehicle profile) · Startable in app · More (sheet).
- States: loading (last cached clusters + shimmer); empty viewport ("No chargers here. Zoom out" + nearest N
  suggestion); offline (cached clusters greyed, status "unknown"); location denied (banner + search).
- Perf: 60 fps pan/zoom on a mid-range Android (e.g. Galaxy A35), ≤ 500 markers rendered (clusters beyond).

### 6.3 Station detail (hosted or partner)
Header: name, operator (+ "via PlugSure Hub" for partner), address, distance, directions, favourite, share.
Reliability badge (G9): "Reliable — 96 % of starts in 30 days" / "Mixed" / "New" / "Reported issue 2 h ago".
Connectors grouped by type and power with status and price; amenities/opening hours where present (OCPI
`opening_times`, `facilities`); photos (S); recent problem reports (last 7 days). Queue panel if the site has a queue.
Partner: "Prices per <operator>; a hold of S$80 is placed and released after charging" (from `holdMinor`).
States: connector list empty → "This station has no public connectors"; stale data (partner location not updated in
24 h) → "Status may be out of date".

### 6.4 Connector / start
Price breakdown with tax label (`pricesIncludeTax`), fees, idle fee rule, membership price if applicable.
Hosted: amount presets (`presetsMinor`), promo code field (collapsed), method picker (cards filtered by `usableAt`).
Partner: method = saved card on PlugSure Mobility (or add card), hold amount. Fleet: "Billed to <fleet>".
Primary CTA "Slide to start" (avoid accidental taps; also full-width button for accessibility setting "Reduce
gestures"). Disabled with reason when not startable (`startable=false, reason`).
States: connector busy → offer queue / reserve / nearest free; suspended → message from server; guest at partner →
sign-in CTA.

### 6.5 Payment
- QRIS / PayNow: QR rendered natively from `qrString`, amount, expiry countdown, "Open in GoPay/OVO/DANA/ShopeePay/
  LinkAja" deep links (Android intents / iOS URL schemes) **[VERIFY schemes per wallet]**, "Save QR" for paying from
  another phone. Poll every 2 s up to expiry + push.
- Redirect methods (e-wallet checkout, FPX, GrabPay, Stripe card page): `ASWebAuthenticationSession` / Custom Tabs
  with the app's universal link as return URL ([BACKEND] G11: `returnUrl` must accept the app's link, today it is
  `…/app/paid.html?for=…`).
- Card native sheet (S): Stripe PaymentSheet with PaymentIntent `capture_method=manual` for holds ([BACKEND] G10).
- States: pending, success → auto start, failed (provider reason mapped), expired (new QR button), cancelled.

### 6.6 Starting
Timeline: Paid ✓ → Charger accepted ✓ → Car connected ✓ → Charging. Each step with its own timeout (hosted 45 s,
roaming 90 s). On timeout: server resolves (release/refund) and the app shows the exact outcome; never leave a
"starting" state without an exit. Show hub/session reference for support.

### 6.7 Live session
Big energy (kWh) and cost so far; power (kW) sparkline; SoC ring when available; elapsed; idle-fee countdown after
"Finishing"; Stop (confirm); "Problem?" → report / call operator. Background: Live Activity / ongoing notification.
Poll `status` every 5 s foreground; push-driven in background. Offline: freeze with "Reconnecting…" and keep Stop
available (queued; the charger can also be stopped physically — say so).

### 6.8 Finished / receipt
Summary, rating prompt (1–5★ + reason chips), receipt with tax lines per country, PDF share, "Charge again here".
Partner: "Final amount from <operator> arrives within 48 h — we'll notify you" until the CDR is settled
(`notifyRoamingCdr`).

### 6.9 Activity
Current session card; unpaid banner (`/d/v1/unpaid`) with Pay; reservations and queue entries; history list
(paged, filter by currency/month) with totals per currency.

### 6.10 Account
Signed-out: phone OTP (country picker defaulting from device region; +62/+60/+65), fleet login link. Signed-in: name,
phone, payment methods (cards with "usable at", linked e-wallets with relink state), passes and loyalty, favourites,
vehicle (S), language, appearance (System/Light/Dark), notifications (per category), biometric lock (S), help
(FAQ, contact), legal (terms, privacy — brand `privacyUrl`/`termsUrl`), app version, **Delete account** (§11.4).

### 6.11 Scanner
Camera with viewfinder, torch, "Enter code" (charger id printed on the unit; SPKLU id). Accepts any URL (takes `code`,
`c`, `#c/`, last path segment — same rules as the PWA) and raw codes. Camera denied → manual entry + settings link.

### 6.12 System screens
Force update (blocking, store link), soft update (dismissable), maintenance (from `/d/v1/app/config`), no network
(global banner), server error (retry with backoff).

---

## 7. Design principles

- **Brand tokens from `brand.ts`:** `palette(accentColor, badgeColor)` already derives, per theme, `accent` (≥ 4.5:1 on
  every surface), `deep`, `on` (text on fill), `glow`, plus `badge`. Surfaces: dark `#0a1417 / #0f1e22 / #15282d`,
  light `#ffffff / #eef3f2 / #f2f6f5`. PlugSure default accent `#2fd6a7` (teal, dark-theme accent used in charge
  cards). The RN theme module imports the same algorithm (shared package `@plugsure/brand-tokens`, extracted from
  `brand.ts`, [BACKEND] G18) so white-label builds pass contrast automatically.
- **Status colours are not brand colours**: available / occupied / fault / offline use fixed, colour-blind-safe hues +
  shape/icon + text; never colour alone.
- **Large targets:** ≥ 48 × 48 dp (Android) / 44 × 44 pt (iOS); primary actions in the thumb zone; WCAG 2.2 2.5.8
  target size (≥ 24 px minimum, we use 44+).
- **Accessibility WCAG 2.2 AA:** contrast 4.5:1 text / 3:1 UI; Dynamic Type and Android font scale up to 200 % without
  truncating prices; VoiceOver/TalkBack labels on markers ("Mall X, 2 of 4 available, 120 kW DC, from Rp 2,466 per
  kWh"); focus order; no time limits without extension (QR expiry announces remaining time and offers "new QR");
  2.5.7 dragging alternatives (slide-to-start has a button alternative); 3.3.8 accessible authentication (OTP autofill
  `textContentType=oneTimeCode` / SMS Retriever; no cognitive tests); reduce motion respected.
- **Dark mode** first-class (default: system). Map style switches with theme.
- **RTL:** not needed (en, id, ms, zh-Hans are LTR).
- **Money:** always currency-explicit (`Rp`, `RM`, `S$`), formatted by `formatMoney` rules (server) and `Intl` in app;
  tax label next to prices.
- **Honesty:** show what we don't know ("status unknown", "price per operator") instead of guessing.

## 8. Languages

| Priority | Language | Why | Server today |
|---|---|---|---|
| v1.0 | English (en-GB formats) | SG/MY default; tourists | ✓ dictionary |
| v1.0 | Bahasa Indonesia | ID market; source language of server strings | ✓ source |
| v1.1 | Bahasa Melayu | MY national language; government/fleet buyers | ✗ — `Lang = 'id' \| 'en'` ([BACKEND] G16) |
| v1.1 | 简体中文 (zh-Hans) | Large SG/MY Chinese-speaking driver base | ✗ ([BACKEND] G16) |
| later | Tamil | SG official language | ✗ |

App strings: i18next with ICU plurals, JSON per locale, pseudo-locale in CI to catch truncation (Bahasa strings run
~30 % longer than English). Language choice: stored → device → brand default (same as `pickLang`). The app sends
`X-Driver-Lang` on every request.

## 9. Offline behaviour

- Cache last 3 viewports' clusters and stations (MMKV / SQLite), favourites with last status, current session,
  last 50 history items and receipts (PDF on demand only).
- Map tiles: OS-level HTTP cache for raster; MapLibre offline pack for a region in S.
- Actions requiring network (pay, start, stop, reserve) disabled with explanation; Stop shows "stop at the charger" when
  offline.
- Requests are idempotent on retry (client `Idempotency-Key` header on POSTs that create payments/charges —
  [BACKEND] G12).

## 10. Performance budgets

| Metric | Budget (p75, mid-range Android = Galaxy A35 / iPhone 12) |
|---|---|
| Cold start to interactive map with cached data | ≤ 2.0 s Android, ≤ 1.5 s iOS |
| Map first fresh clusters after launch | ≤ 1.0 s after location fix on 4G |
| Map pan/zoom | 60 fps, < 1 % janky frames (Hermes, Fabric) |
| Scan → connector screen | ≤ 1.0 s |
| JS bundle (Hermes bytecode) | ≤ 6 MB; install size ≤ 45 MB Android (AAB per-ABI), ≤ 60 MB iOS |
| API p95 (`stations` viewport) | ≤ 300 ms server, payload ≤ 50 KB gzipped |
| Memory | ≤ 250 MB on the map |
| Crash-free sessions | ≥ 99.8 %; ANR rate < 0.47 % (Play bad-behaviour threshold) |

## 11. Security and privacy

### 11.1 Security
- **Token storage:** device token (`psd_…`) in Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) /
  Android Keystore-backed EncryptedSharedPreferences via `expo-secure-store`. Never in AsyncStorage / logs / Sentry
  breadcrumbs (scrubber).
- **Transport:** TLS 1.2+ only; ATS on. **Certificate pinning: not in v1** — the API sits behind Caddy with on-demand
  ACME certificates and white-label custom hostnames; pinning leaf keys would break on rotation. Option for v1.1:
  pin to the ISRG/issuer SPKI with a backup pin, remotely disable-able via `/app/config` **[OWNER]**.
- **Biometric lock (S):** optional, gates the app and payment-method changes (`expo-local-authentication`).
- **Jailbreak / root:** detect (Play Integrity API / App Attest) and **report** to the backend for risk scoring of
  payment endpoints; do not block (hurts legit users). Device attestation on `/d/v1/device` and OTP send
  ([BACKEND] G13) to curb SMS pumping.
- **Payments:** no card data in the app except inside Stripe's SDK / acquirer pages (PCI SAQ-A scope unchanged).
- **Screens with QR codes / receipts:** allow screenshots (drivers share QRs); hide in app switcher snapshot? No.
- Session expiry: device tokens are long-lived; add rotation on sign-in and revoke on sign-out (exists: `signout`).

### 11.2 Sign-in options
Phone OTP stays primary (it is what local wallets and SPKLU users know). **Recommendation: no social login in v1.0.**
If Google sign-in is added (v1.1), App Store guideline 4.8 requires an equivalent privacy-preserving option
(Sign in with Apple qualifies) ([guidelines](https://developer.apple.com/app-store/review/guidelines/)). Phone OTP alone
does not trigger 4.8.

### 11.3 Permissions rationale
| Permission | When | Rationale string (en) |
|---|---|---|
| Location (when in use) | First map open | "PlugSure uses your location to show chargers near you. It is not stored." |
| Camera | First scan | "To scan the QR code on the charger." |
| Notifications | After first start | "So we can tell you when charging finishes or is interrupted." |
| Photos (S) | Attaching a photo to a report | Picker only (PHPicker / Android Photo Picker — no library permission). |
No background location in v1 (route planner uses foreground only).

### 11.4 Account deletion (store requirement)
Apple 5.1.1(v): apps that support account creation must offer deletion in the app
([guidelines](https://developer.apple.com/app-store/review/guidelines/)); Google Play requires in-app deletion and a
web deletion link in the Data safety form. Flow: Account → Delete account → explain what is deleted vs retained
(tax receipts / invoices retained as legally required per country — ID 10 yrs, MY 7 yrs, SG 5 yrs **[LEGAL]**;
outstanding unpaid amounts must be settled or are kept as a debt record) → OTP re-confirm → done. [BACKEND] G4.

### 11.5 Privacy labels / Data safety
Collected: phone number (account), device ID (app functionality), precise location (not stored server-side; sent as
query lat/lon for distance — declare "not linked" if not logged; **[VERIFY]** request logs), purchase history
(linked), crash data (not linked), product interaction (analytics, not linked, no tracking → no ATT prompt).
PDP Law (ID UU 27/2022), PDPA (MY, SG): privacy notice per country, consent for marketing push separately.

## 12. Notifications, Live Activities, widgets, car

### 12.1 Push transport
- **iOS:** APNs (backend has `services/apns.ts`, token auth with p8 per brand). Needs the PlugSure network brand
  ([BACKEND] G1) or a platform credential.
- **Android:** **FCM HTTP v1 — not implemented** ([BACKEND] G2). Expo Notifications can deliver to FCM directly; we
  use native device tokens (`getDevicePushTokenAsync`) not Expo's push service, so the backend owns delivery and
  white-label builds use each operator's Firebase project.
- Categories / channels (Android notification channels; iOS interruption levels): Charging (time-sensitive),
  Payments (active), Reservations & queue (time-sensitive), Account (passive), Promotions (off by default, separate
  consent).
- Rich notifications: "charging finished" card image from `/d/n/charge/:id.png` (signed URL) via iOS Notification
  Service Extension and Android BigPictureStyle.

### 12.2 iOS Live Activities
Backend content state is a wire contract (`ChargingAttributes.ContentState`: status, energyWh, powerW, socPercent,
progressPct, costIdr, estimateIdr, startedAt, endedAt, currency). Native module: `expo-live-activity` or a small
config-plugin Swift target (widget extension) generated from the existing kit's `ios/LiveActivity/*.swift`.
Push-to-start token (iOS 17.2+) registered at launch; update tokens per activity. Gaps: roaming sessions not covered;
formatter must use `currency` (TODO WP2 in `live-activity.ts`) ([BACKEND] G3).

### 12.3 Android live session
Foreground-service-free approach: an **ongoing notification** updated by FCM data messages (high priority on state
changes, normal for progress), with `Notification.ProgressStyle` on Android 16 (Live Updates)
([developer.android.com](https://developer.android.com/about/versions/16/features/progress-centric-notifications)),
falling back to standard progress notifications. Requires a native module (Expo config plugin + Kotlin). Backend must
send the same snapshot cadence as Live Activities (`MIN_INTERVAL_S` 30 s, heartbeat 150 s) over FCM ([BACKEND] G2).

### 12.4 Widgets (later)
Home-screen widget: favourite station availability; Lock-screen: current session (iOS uses the Live Activity).

### 12.5 CarPlay / Android Auto (later)
- CarPlay: the **EV charging app** category requires an entitlement request to Apple
  (`com.apple.developer.carplay-charging`) and the CarPlay templates (POI, list, information); approval is not
  automatic **[VERIFY current process]**.
- Android Auto: Car App Library, category `androidx.car.app.category.CHARGING`, Play quality review for cars.
- Scope: nearby/available chargers, favourites, navigate, session status; no payment entry while driving.

## 13. Deep links, analytics, crash reporting

### 13.1 Deep links / universal links
- Domain **`go.plugsure.asia`** **[OWNER]** dedicated to links (not the API host), serving
  `apple-app-site-association` and `assetlinks.json` for the PlugSure app ([BACKEND] G6: today these are only
  generated per white-label brand, components `/app/*`).
- Paths: `/c/<code>` charger QR (new stickers), `/app/*` (existing PWA links and QR stickers using `?code=`/`#c/`),
  `/s/<siteId>` station share, `/r/<kind>/<id>` receipt, `/paid?for=…` payment return.
- Not installed: the same URL serves the PWA (already does at `/app`) with a smart banner → store.
- QR stickers printed today by operators: whatever URL they encode must keep working — the resolver accepts the last
  path segment / `code` / `c` param, so it does.

### 13.2 Analytics
Event schema (no PII, device-scoped random id, no ad id): `app_open`, `map_viewport`, `filter_apply`,
`station_view`, `scan_success/fail`, `quote_view`, `pay_method_select`, `pay_success/fail(reason)`,
`start_requested`, `start_confirmed(latency_ms)`, `start_failed(reason)`, `stop`, `session_complete(kwh)`,
`rating_submit`, `problem_report`, `signup_otp_sent/verified`. North-star: successful starts per week; guardrail:
start failure rate by network. Tool: PostHog (EU/self-host) **[OWNER]**; consent per PDPA.

### 13.3 Crash and performance
Sentry React Native (`@sentry/react-native` with the Expo plugin): native + JS crashes, source maps and dSYMs
uploaded from EAS Build, performance traces for cold start and API calls, release health per channel, PII scrubbing
(Authorization header, `psd_` tokens, phone numbers).

## 14. Backend gap list (driver API)

Priority: **P0** blocks store launch · **P1** needed for MVP quality · **P2** v1.1 · **P3** later.

**Status (1.9.0-dev, branch `mobile`):** G1–G8 are built — the contract as built is §15, which supersedes the sketches
below where they differ (e.g. the map is `GET /d/v1/map` plus a paged `GET /d/v1/stations`; FCM subscriptions live in
`push_subscription` with `kind = 'fcm'`; account deletion is immediate after the code). G16 has its hook only
(`X-Driver-Lang: ms|zh` answered in English).

| # | Pri | Gap | Change (endpoint · method · payload) |
|---|---|---|---|
| G1 | P0 | **PlugSure app identity / network brand.** Unbranded requests have no org for roaming unless exactly one org has `appDrivers`; APNs and Live Activities return 409 without a brand; a brand scopes everything to one org. | Migration: `driver_app_brand.scope TEXT NOT NULL DEFAULT 'operator' CHECK (scope IN ('operator','network'))`. A `network` brand (the PlugSure Mobility org): (a) skips the `other_operator` preHandler and passes `brandOrg = null` to station/connector/resolve queries; (b) `emspOrgForApp` returns the brand's org; (c) APNs/LA/FCM credentials come from it. Client sends `X-Driver-Brand: plugsure` (or uses the network brand's hostname). |
| G2 | P0 | **No FCM / Android push.** | `POST /d/v1/push/fcm {token, lang, appVersion}` · `POST /d/v1/push/fcm/remove {token}`; table `driver_push_fcm(device_id, brand_org_id, token, lang, created_at, last_ok_at, gone_at)`; `services/fcm.ts` (HTTP v1, OAuth2 service-account JWT, per-brand service account sealed like the p8); fan-out in `notifyDevices`/`deliverPush`; `UNREGISTERED` → gone. Console: brand → Firebase service account upload + check. |
| G3 | P0 | **Live session for Android + roaming.** LA only for hosted sessions; no Android equivalent. | `POST /d/v1/live-sessions {platform:'android', ref, token}` registering an FCM target for session snapshots; extend `liveActivityPass` to roaming sessions (`ocpi_remote_session`/roaming charge status) and to FCM data messages `{type:'session', ref, contentState}` with collapse key per ref; widget formatter uses `currency`. |
| G4 | P0 | **Account deletion.** | `POST /d/v1/account/delete/start` → sends OTP; `POST /d/v1/account/delete {code}` → refuses with 409 `{code:'unpaid', unpaid:[…]}` if money owed or a session/hold active; otherwise anonymises `app_driver` (phone hash only for fraud/limits, name null), removes saved cards at the acquirer (detach), unlinks e-wallets, deletes push tokens, favourites, keeps receipts with driver id nulled. Public web form `/account/delete` (Play requirement) with OTP. |
| G5 | P0 | **Duplicate stations** (hosted tenant also imported via the hub). | In `listRoamingStations` exclude `ocpi_remote_location` whose (country_code, party_id) belongs to an internal hub member / an org on this platform (join `hub_party`/`ocpi_party`); or mark `alsoDirect: siteId`. Prefer direct. |
| G6 | P0 | **Universal links for the PlugSure app.** AASA/assetlinks only for white-label brands, and only `/app/*`. | Serve AASA/assetlinks for the network brand on its link domain with components `/c/*`, `/s/*`, `/r/*`, `/paid*`, `/app/*`; add `GET /c/:code` → 302 to `/app/?code=` for the web fallback. |
| G7 | P0 | **Map API scale.** `/d/v1/stations` returns every site, computes price per connector in a loop, no bbox/paging; partner stations separate and require auth. | `GET /d/v1/map?bbox=w,s,e,n&zoom=&filters…` → `{clusters:[{lat,lon,count,available}], stations:[compact…], etag}` merging hosted + partner (partner visible to guests too, `startable:false, reason:'sign_in'`); server-side clustering (supercluster-equivalent, cached per tile); filters `connector=CCS2,TYPE2&minKw=50&dc=1&available=1&network=…&startable=1`; `ETag`/`If-None-Match`; prices from a materialised `site_price_from` refreshed on tariff change. `GET /d/v1/stations?near=lat,lon&limit=&cursor=` for the list view. |
| G8 | P0 | **App version gate + remote config.** | `GET /d/v1/app/config?platform=ios|android&version=1.0.3&build=42` → `{minSupported, latest, storeUrl, force:boolean, maintenance:{active, message}, features:{applePay, routePlanner, …}, links:{terms, privacy, support}}`; values per brand from console. |
| G9 | P1 | **Reliability score, ratings, problem reports.** | Table `connector_reliability_daily` (starts requested/accepted/failed, sessions 0 kWh, faults minutes) from OCPP + roaming command results; `reliability: {score:0-100, label, basis:'30d', lastSuccessAt}` on station/connector views. `POST /d/v1/charge/:id/rating {stars:1-5, reasons:[…], comment}` (and `/roaming/charge/:id/rating`); `POST /d/v1/reports {connectorId|partnerRef, category:'broken'|'blocked'|'payment'|'cable'|'other', comment, photoUploadId?}` → operator alert (existing alert routing) and, for partners, a support ticket to the CPO (OCPI has no module — email/console) ; `GET /d/v1/stations/:id/reports?days=7`. |
| G10 | P1 | **Native payments.** Card flow is a hosted Stripe page; no Apple/Google Pay. | `POST /d/v1/payments/stripe/payment-sheet {connectorId|roamingRef, amountMinor, mode:'hold'|'charge', saveCard}` → `{paymentIntentClientSecret, customerId, ephemeralKey, publishableKey, merchantCountry}` (Stripe RN PaymentSheet, Apple Pay/Google Pay enabled); then existing `confirm-payment`. Midtrans/Xendit: keep redirect/QR (Snap in-app browser); `[VERIFY]` Xendit/Midtrans RN SDK maturity before native. |
| G11 | P1 | **Return URL for native apps.** `returnUrl` is always `…/app/paid.html`. | Accept `returnUrl` from an allow-list per brand (`https://go.plugsure.asia/paid`, custom scheme `plugsure://paid`), else default. |
| G12 | P1 | **Idempotency** on payment/charge creation. | `Idempotency-Key` header on `charge/prepaid`, `roaming/charge`, `reservations`, `memberships`, `wallets`, stored 24 h per device. |
| G13 | P1 | **Abuse controls** for public endpoints. | Optional App Attest / Play Integrity token on `POST /d/v1/device` and `/otp/send` (`X-Attest`), risk-scored, not blocking at first. |
| G14 | P1 | **History paging and per-currency totals.** | `GET /d/v1/history?cursor=&limit=20&currency=` → `{charges, nextCursor, totals:[{currency,totalMinor,kwh}]}`. |
| G15 | P1 | **Cards "one wallet" problem.** Saved card usable only at its acquirer. | Short term: `usableAt` + `integrationId` on cards (exists) + `GET /d/v1/connectors/:id` returns `acceptsCardIds`. Long term **[OWNER]/[LEGAL]**: route hosted charges of opted-in tenants through PlugSure Mobility (eMSP) so one card works everywhere. |
| G16 | P2 | **Malay and Chinese server strings.** | `Lang = 'id'|'en'|'ms'|'zh'`; dictionaries in `src/driver/i18n.ts`; `LOCALE_TAG` ms-MY / zh-Hans-SG; receipts and push templates; `X-Driver-Lang` accepts them. |
| G17 | P2 | **Route corridor search.** | `POST /d/v1/route/chargers {polyline (encoded), bufferKm:5, minKw, connectors[], startable}` → stations ordered along the route with distance-from-start; routing itself from the map provider (client), not our server. |
| G18 | P2 | **Shared brand tokens + white-label build config.** | Extract `palette/contrast/readableOn` into `sdk/brand-tokens` (pure TS) used by server and app; `GET /d/v1/brand` → public brand + palette for runtime theming; build kit adds `app.config` JSON for Expo (§17). |
| G19 | P2 | **Availability watch.** | `POST /d/v1/watches {siteId, connectorTypes, minKw, until}` → push when a matching connector turns Available (for sites without a queue). |
| G20 | P2 | **Vehicle profile.** | `GET|PUT /d/v1/vehicle {make, model, connectors[], maxDcKw, batteryKwh}`; used for filters and estimates. Optional public EV database. |
| G21 | P2 | **Photos.** | `POST /d/v1/uploads` (presigned PUT to object storage, image ≤ 5 MB, EXIF stripped server-side) → `uploadId`; moderation queue in console. |
| G22 | P3 | Plug & Charge / AutoCharge enrolment for app drivers (EMAID contract provisioning via `src/pnc`, VIN/MAC autocharge). | `POST /d/v1/autocharge {vehicleId}` … design separately. |
| G23 | P3 | OpenAPI catalogue (`src/api/openapi/catalogue/driver-app.ts`) updated for every endpoint above; generate the app's typed client from it. | — |

## 15. Driver API for the mobile app (as built)

**Status:** built on branch `mobile` (backend 1.9.0-dev, migration 075), covering the P0 gaps G1–G8 of §14. This
section is the contract the native app is built against; where it differs from §14's sketch, this section wins.
Tested by `tools/e2e/mobile-api-e2e.mts` (CI step "e2e — mobile app driver API") and unit tests
(`src/driver/mobile-api.test.ts`, `src/driver/mobile.db.test.ts`, `src/services/fcm.test.ts`).

### 15.1 The PlugSure app's identity (G1) — decision taken

- **PlugSure Mobility** is an ordinary tenant organisation (slug `plugsure-mobility`, its own console, users, acquirer
  integrations per country, roaming hold amounts) with OCPI parties `ID*PSM`, `MY*PSM`, `SG*PSM` (home first;
  [OWNER] to confirm the party ids) and `roaming_settings.appDrivers = true`. It owns the **one network-scope brand**
  (`driver_app_brand.scope = 'network'`, slug **`plugsure`**, unique). It can join the PlugSure Hub as an internal
  member (`MOBILITY_JOIN_HUB=1`), so the hub delivers every agreed CPO's locations and tariffs to it.
- Set up with `npm run mobility:setup` (idempotent; `tools/mobility/setup.mts`, settings from the environment:
  `PLUGSURE_APP_ORG_ID` to adopt an existing organisation, `MOBILITY_PARTIES`, `MOBILITY_LINK_HOST`,
  `MOBILITY_IOS_BUNDLE_ID`, `MOBILITY_IOS_TEAM_ID`, `MOBILITY_ANDROID_PACKAGE`, `MOBILITY_ANDROID_CERT_SHA256`,
  `MOBILITY_PRIVACY_URL`, `MOBILITY_TERMS_URL`, `MOBILITY_SUPPORT_EMAIL`, `MOBILITY_ICON_PNG`, `MOBILITY_LIVE=1`,
  `MOBILITY_APNS_KEY_ID` + `MOBILITY_APNS_P8_FILE`, `MOBILITY_FCM_SA_FILE`, `MOBILITY_JOIN_HUB=1`), then
  `npm run create-admin -- --email … --org-slug plugsure-mobility` for its console. The development seed creates it
  (link host `go.plugsure.test`, bundle / package `asia.plugsure.app`, team `PSTEAM0001`, console
  `mobility@plugsure.com` with the seed password; `SEED_MOBILITY=0` leaves it out).
- **The app sends `X-Driver-Brand: plugsure` on every request** (or calls the API on the brand's own web address once
  it is live). With the network brand:
  - no operator scoping: stations, connectors, resolve, history cover **every** hosted operator (as without a brand);
  - partner networks (roaming) go through **PlugSure Mobility's** eMSP role (holds on its acquirer);
  - APNs, Live Activities and FCM work, with the brand's credentials (before: 409 without an operator brand);
  - Live Activities / live sessions and push-to-start cover sessions **at any operator** for that phone.
- Operator (white-label) brands behave exactly as before (`scope = 'operator'`). Requests **without** a brand (the web
  app at `/app`) are unchanged too: their partner-network eMSP is still "the single organisation with app roaming on",
  and PlugSure Mobility is not counted there.

### 15.2 Conventions

| | |
|---|---|
| Base | `https://<api host>/d/v1/…` (link-domain paths in §15.8 are at the root) |
| Auth | `Authorization: Bearer psd_…` from `POST /d/v1/device` (unchanged). Public (token optional): `GET /d/v1/stations`, `/map`, `/connectors/:id`, `/resolve`, `/links/resolve`, `/meta`, `/app/config`, `/sites/:id/queue`. Missing token elsewhere → `401 {"error":"device token required","code":"no_device"}` |
| Brand | `X-Driver-Brand: plugsure` (the PlugSure app) or an operator slug (white-label builds) |
| Language | `X-Driver-Lang: id` \| `en`; `ms` and `zh`/`zh-Hans` are accepted and answered in **English** until the server has Malay / Chinese messages (G16 hook, `APP_ONLY_LANGS`). Messages are written in Indonesian and translated per request |
| Errors | JSON `{"error": "<human text>", "code"?: "<machine code>", …}`; 400 bad input, 401 no token, 404 not found / `other_operator`, 409 state conflict, 422 refused input, 429 rate limit |
| Money | integers in the PlugSure minor unit of `currency` (IDR whole rupiah, MYR sen, SGD cents); rates per kWh in major units (`…Major`) |
| Caching | `/d/v1/map`: `ETag` + `If-None-Match` → 304, `Cache-Control: private, max-age=15`; `/d/v1/app/config`: `private, max-age=60` |

### 15.3 Remote configuration and version gate (G8)

`GET /d/v1/app/config?platform=ios|android&version=1.0.3&build=42` — public; call at launch and on resume.

```json
{
  "platform": "android", "version": "1.0.3", "build": 42,
  "minSupported": "1.0.0", "latest": "1.2.0",
  "storeUrl": "https://play.google.com/store/apps/details?id=asia.plugsure.app",
  "force": false, "softUpdate": true,
  "maintenance": { "active": false, "message": null },
  "features": { "roaming": true, "reservations": true, "queue": true, "memberships": true, "favourites": true,
                "liveActivities": true, "accountDeletion": true, "applePay": false, "googlePay": false, "routePlanner": false },
  "links": { "terms": "https://…/terms", "privacy": "https://…/privacy", "support": "mailto:help@…", "faq": null, "status": null,
             "accountDeletion": "https://go.plugsure.asia/account/delete" },
  "brand": { "slug": "plugsure", "name": "PlugSure", "shortName": "PlugSure", "supportEmail": "help@…", "supportPhone": null,
             "privacyUrl": "https://…", "termsUrl": "https://…", "accent": "#2fd6a7", "scope": "network" },
  "languages": { "server": ["id", "en"], "fallback": { "ms": "en", "zh": "en" } },
  "polling": { "liveSessionS": 5, "paymentS": 2 }
}
```

- `force`: `version < minSupported` → blocking update screen (`storeUrl`). `softUpdate`: `version < latest`. No or
  malformed `version` → never forced. Versions compare numerically (`1.10.0 > 1.9.9`).
- `maintenance.message` is in the request's language. `features` = defaults ← console switches; `roaming` and
  `reservations` are false when the server cannot offer them, whatever the switch.
- `platform` other than ios/android → `400 {"code":"bad_platform"}`. Without a brand: `brand: null`, no gate.
- Console (PlugSure Mobility, or an operator for its app): `GET|PUT /v1/driver-app/app-config` with
  `{ios?:{minSupported?,latest?,storeUrl?}, android?:{…}, maintenance?:{active,messageId?,messageEn?}, features?:{<name>:bool}, links?:{support?,faq?,status?}}`
  (whole object replaced; 422 `{"fields":{"ios.minSupported":"…"}}` for a bad version, non-https URL or unknown feature).

### 15.4 Stations, the map and paging (G7, G5)

**`GET /d/v1/stations`** — unchanged when called without `bbox`, `limit` or `cursor` (`{"stations":[StationView…]}`,
every station; nearest first with `lat`/`lon`). With any of them (the native list view):

`GET /d/v1/stations?near=-6.22,106.99&bbox=106.6,-6.4,107.1,-6.0&limit=20&cursor=…`

```json
{ "stations": [ { "siteId": "…", "name": "Summarecon Mall Bekasi — P2 Basement", "lat": -6.2246, "lon": 106.9998, "distanceKm": 0.4,
                  "operator": "Nusantara Charge", "connectors": [ { "connectorId": "…", "typeLabel": "CCS2", "current": "DC", "maxPowerKw": 60,
                  "status": "Available", "available": true, "blockedReason": null, … } ], "availableCount": 1, "totalCount": 3,
                  "maxPowerKw": 60, "fastest": "60 kW DC", "priceFromMinor": 2466, "priceFromMajor": 2466, "currency": "IDR",
                  "countryCode": "ID", "timezone": "Asia/Jakarta", "pricesIncludeTax": false } ],
  "total": 37, "nextCursor": "eyJvIjoyMCwidCI6…" }
```
`bbox=w,s,e,n` (degrees; `w > e` crosses the antimeridian); `near=lat,lon` (or `lat`+`lon`); `limit` 1–200
(default 50); `cursor` from `nextCursor` (opaque, tied to the same query; another query's cursor → 400 `bad_cursor`).
Hosted stations only, full `StationView` (same shape as before). Errors: 400 `bad_bbox` / `bad_limit` / `bad_cursor`.

**`GET /d/v1/map?bbox=w,s,e,n&zoom=12[&near=lat,lon][&limit=200][&cursor=…][&cluster=0][filters]`** — the map:
hosted **and** partner stations merged, clustered on the server.

Filters: `connector=CCS2,TYPE2` (labels without spaces: CCS2, CCS1, TYPE2, TYPE1, CHADEMO, GBT, TESLA), `minKw=50`,
`dc=1`, `available=1`, `network=hosted|partner`, `startable=1`.

```json
{
  "zoom": 8, "bbox": [106.0, -7.0, 108.0, -5.5],
  "clusters": [ { "id": "c8:1209:430", "lat": -6.2001, "lon": 106.8001, "count": 12, "available": 9,
                  "bbox": [106.75, -6.25, 106.86, -6.15], "expansionZoom": 10 } ],
  "stations": [
    { "id": "5657b3d4-…", "kind": "hosted", "path": "direct", "siteId": "5657b3d4-…", "name": "Summarecon Mall Bekasi — P2 Basement",
      "operator": "Nusantara Charge", "address": "Jl. Bulevar Ahmad Yani, Bekasi", "lat": -6.2246, "lon": 106.9998, "distanceKm": 0.4,
      "availableCount": 1, "totalCount": 3, "maxPowerKw": 60, "dc": true, "connectorTypes": ["Type 2", "CCS2", "CHAdeMO"],
      "priceFromMinor": 2466, "priceFromMajor": 2466, "currency": "IDR", "pricesIncludeTax": false,
      "startable": true, "reason": null, "reasonCode": null },
    { "id": "<partnerId>:ID:EXT:LOC1", "kind": "partner", "path": "roaming", "name": "External CPO", "operator": "EXT",
      "lat": -6.2, "lon": 106.95, "availableCount": 1, "totalCount": 1, "maxPowerKw": 120, "dc": true, "connectorTypes": ["CCS2"],
      "priceFromMinor": 120, "priceFromMajor": 1.2, "currency": "MYR", "pricesIncludeTax": false,
      "startable": false, "reason": "Sign in to charge on partner networks.", "reasonCode": "sign_in",
      "partner": { "partnerId": "…", "countryCode": "ID", "partyId": "EXT", "locationId": "LOC1", "holdMinor": 5000 } }
  ],
  "total": 14, "unclustered": 2, "nextCursor": null,
  "partners": { "enabled": true, "reason": "Sign in to charge on partner networks." }
}
```
- Clustering: grid of 4×4 cells per 256-px tile width at `zoom` (≈ 64 px); ≥ 2 stations in a cell are one cluster
  (`count`, `available` = stations with a free connector, their `bbox`, and `expansionZoom` at which they separate).
  From zoom 15, or `cluster=0`, no clusters. `total` = all matching stations; `unclustered` = stations returned
  outside clusters, paged by `limit` (1–500, default 200) / `cursor`, nearest to `near` (else the viewport centre) first.
- `path: "direct"` = hosted operator (guests can start, operator's payment methods); `"roaming"` = partner network
  (signed-in, card hold via PlugSure Mobility; `holdMinor` in `currency`). `reasonCode`: `sign_in` (guest),
  `payment` (no usable payment for that currency), `fleet_limit`, `unavailable` (nothing free now), null.
  Partner prices are "per the operator" (`pricesIncludeTax: false` when the tariff carries VAT, null when unknown).
- **G5:** a partner location whose OCPI party belongs to an operator **hosted here** (not hub-only, not a sandbox,
  with sites) is left out where hosted operators are listed directly (the PlugSure app, the unbranded web app; not an
  operator's own app). Same for `GET /d/v1/roaming/stations` (which also gained `reasonCode`).
- Prices are resolved for all connectors of the answer in **one batch** (`headlinePrices`: two queries, the same
  resolution rules as charging — connector > site > org assignment, AC/DC-only, the site's country, the regulated
  default). Benchmark below.
- Errors: 400 `bad_bbox` (required), `bad_zoom` (0–22), `bad_limit`, `bad_cursor`.

**Benchmark** (`npm run bench:stations`, c5434 copy, 2,003 connectors / 501 sites in ID, MY, SG, 7 runs, median):

| Path | v1.8 | v1.9 |
|---|---|---|
| Headline prices for every connector (what `/d/v1/stations` did per connector) | 5,737 ms | **99 ms** (batched) |
| `GET /d/v1/stations` (every station, full answer) | ≈ 5.8 s | 123 ms |
| `GET /d/v1/stations?bbox=` (Jakarta) | — | 5.7 ms |
| `GET /d/v1/map` zoom 12 (Jakarta viewport) | — | 4.6 ms (2.3 KB) |
| `GET /d/v1/map` zoom 5 (Java + Malaysia + Singapore, 9 clusters) | — | 127 ms (1.7 KB) |

### 15.5 Links and QR codes (G6)

`GET /d/v1/links/resolve?url=<scanned text or URL>` — public. Accepts link-domain URLs, the web app's links
(`?code=`, `?c=`, `#c/`, `#s/`, `#r/`, `#rr/`), any other URL (its last path segment: operators' printed stickers),
a custom scheme (`plugsure://c/CODE`) or a bare code (connector UUID, `IDENTITY:n`, `IDENTITY/n`, identity, SPKLU id,
or a partner **EVSE id** such as `MY*ABC*E123`, matched ignoring `*`).

```json
{ "kind": "connector", "path": "direct", "connectorId": "…", "siteId": "…", "connector": { "ocppIdentity": "AUTEL-DC60-SMB-002", "connectorNo": 1, "status": "Available", … } }
{ "kind": "partner_evse", "path": "roaming", "name": "KL Sentral", "operator": "ABC", "status": "AVAILABLE",
  "partner": { "partnerId": "…", "countryCode": "MY", "partyId": "ABC", "locationId": "L1", "evseUid": "L1-E1", "connectorId": "1" } }
{ "kind": "site", "siteId": "…" }            { "kind": "charge", "chargeId": "…" }        { "kind": "receipt", "chargeId": "…" }
{ "kind": "partner_receipt", "cdrId": "…" }  { "kind": "payment_return", "for": "charge" }
```
404 `{"code":"not_found"}` (unknown) or `{"code":"other_operator"}` (an operator's app scanning another operator's charger).

**Link domain** (the network brand's `hostname`, e.g. `go.plugsure.asia` [OWNER]; served once the brand is live):
- `GET /.well-known/apple-app-site-association` → `{"applinks":{"details":[{"appIDs":["<TeamID>.<bundle id>"],"components":[{"/":"/c/*"},{"/":"/s/*"},{"/":"/r/*"},{"/":"/paid*"},{"/":"/app/*"}]}]},"webcredentials":{"apps":["<TeamID>.<bundle id>"]}}`
  (operator brands: `/app/*` only, as before).
- `GET /.well-known/assetlinks.json` → `[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"asia.plugsure.app","sha256_cert_fingerprints":["AB:CD:…"]}}]`.
- Web fallbacks (app not installed; 302): `/c/<code>` → `/app/#c/<code>`; `/s/<siteId>` → `/app/#home`;
  `/r/charge/<id>` → `/app/#r/<id>`; `/r/partner/<cdrId>` → `/app/#rr/<cdrId>`; `/paid?…` → `/app/paid.html?…`.
- New QR stickers: `https://go.plugsure.asia/c/<IDENTITY>:<connectorNo>`. Old stickers keep working via the resolver.

### 15.6 Push notifications (G1, G2)

| Endpoint | Body | Answer |
|---|---|---|
| `POST /d/v1/push/fcm` (Android) | `{"token":"<FCM registration token>","lang":"id"\|"en"}` | `{"ok":true}`; 409 `no_brand` without a brand; 422 bad token / no service account |
| `POST /d/v1/push/fcm/remove` | `{"token":"…"}` | `{"ok":true}` |
| `POST /d/v1/push/apns` (iOS, unchanged; now with the network brand) | `{"token":"<hex>","lang":"id"}` | `{"ok":true}` |
| `POST /d/v1/push/apns/remove` | `{"token":"…"}` | `{"ok":true}` |
| `GET /d/v1/push` | — | `{"subscribed":true,"webpush":0,"apns":0,"fcm":1}` |

Use the native device token (`getDevicePushTokenAsync`), not Expo's push service. Re-register at every launch
(tokens rotate); at most five subscriptions per device. A token FCM reports `UNREGISTERED` (or a token of another
Firebase project) is deleted.

**Android message** (FCM HTTP v1, a notification message: the system shows it in the background, the app's
`onMessageReceived` gets it in the foreground):
```json
{ "message": { "token": "…",
  "notification": { "title": "Charging finished", "body": "Mall · 12.5 kWh charged", "image": "https://go.plugsure.asia/d/n/charge/<id>.png?…" },
  "data": { "type": "session.ended", "url": "/app/#s/<chargeId>", "ref": "<chargeId>", "tag": "s-<sessionId>", "category": "PS_RECEIPT",
            "actions": "{\"receipt\":\"/app/#r/<chargeId>\"}", "urgent": "1" },
  "android": { "priority": "HIGH", "ttl": "86400s", "notification": { "channel_id": "charging", "tag": "s-<sessionId>", "image": "…" } } } }
```
`data.type` values: `session.started`, `session.ended`, `cdr.created`, `refund.completed`, `session.unpaid`,
`roaming.cdr`, `reservation.reminder|expired|released`, `queue.offer|missed|expired|removed|closed|requeued`.
Channels the app must create: **`charging`** (session.*; importance high), **`payments`** (cdr, refund, unpaid,
roaming.cdr), **`reservations`** (reservation.*, queue.*; high), **`account`**, **`promotions`** (unused, off by
default). `actions` values are `/app/…` routes or `queue-leave:<id>` / `reservation-cancel:<id>` (as on iOS).
On `session.started` the app should register a live session for `data.ref` (§15.7) — Android's equivalent of
push-to-start. Badge-only updates (iOS) are not sent to Android.

**Credentials** — console of the brand's organisation (PlugSure Mobility for the PlugSure app):
`PUT /v1/driver-app/fcm {"serviceAccount": <the service account JSON, object or text>}` → stored sealed, checked with
Google at once by a validate-only send (`fcmCheckOk`, `fcmCheckDetail`, `fcmProjectId` in the brand); `POST /v1/driver-app/fcm/check`;
`DELETE /v1/driver-app/fcm`. APNs as before (`PUT /v1/driver-app/apns {keyId, p8}`). Delivery: `services/fcm.ts`, an
RS256 JWT (scope `firebase.messaging`) exchanged at the account's `token_uri` for an access token, kept 55 min; no new
dependency. `FCM_URL` overrides the endpoint on a development/test bench only.

### 15.7 Live sessions (G3)

| Endpoint | Body | Answer |
|---|---|---|
| `POST /d/v1/live-sessions` | `{"platform":"android","ref":"<chargeId \| sessionId \| roaming chargeId>","token":"<FCM token>"}` or `{"platform":"ios","ref":…,"token":"<activity update token hex>","contentVersion":2}` | `{"ok":true,"kind":"charge"\|"session"\|"roaming"}`; 409 `no_brand`; 422 bad token / not this phone's charge / no credentials |
| `POST /d/v1/live-sessions/ended` | `{"ref":"…"}` (closed on the phone) | `{"ok":true}` |
| `POST /d/v1/live-activities` (iOS, as before) | `{"ref","token","contentVersion"?:2}` | as before (now any operator with the network brand, and roaming refs) |
| `POST /d/v1/live-activities/start-token` | `{"token"}` (iOS 17.2+ push-to-start) | as before; with the network brand, starts for sessions at any operator |

`ref` may be a hosted charge (`chargeId` from `/charge/prepaid`), a session started by a fleet card, or a partner-network
charge (`/roaming/charge` id). The gateway's pass (every 5 s) sends at most one update per 30 s while figures change
(energy ≥ 50 Wh, power ≥ 1 kW, SoC, cost step), a heartbeat every 150 s, at once on a change of state; "finished" at
the end; the end with the final cost once rated (partner networks: from the partner's charge record, else ends after 5 min).

**Android data message** (data-only; the app posts / updates one ongoing notification per `ref` —
`Notification.ProgressStyle` on Android 16, a standard progress notification before):
```json
{ "message": { "token": "…", "android": { "priority": "HIGH|NORMAL", "ttl": "600s|120s", "collapse_key": "ls-<ref>" },
  "data": { "type": "live_session", "event": "update|end", "ref": "<ref>", "path": "direct|roaming", "status": "charging|finished",
    "energyWh": "6000", "powerW": "45000", "socPercent": "44", "progressPct": "", "costMinor": "", "estimateMinor": "18250", "currency": "IDR",
    "startedAt": "1791122400", "endedAt": "", "progress": "44", "progressMax": "100", "progressIndeterminate": "0", "ongoing": "1",
    "staleAt": "1791122580", "site": "Summarecon Mall Bekasi", "connector": "DC 60 kW",
    "contentState": "{\"status\":\"charging\",\"energyWh\":6000,…}" } } }
```
All values are strings (FCM rule); empty string = unknown. `event: "end"` carries `dismissAt` instead of `staleAt`
and `ongoing: "0"`. HIGH priority for a change of state, NORMAL for progress.

**iOS content state, version 2** (register with `contentVersion: 2`): `{status, energyWh, powerW, socPercent,
progressPct, costIdr, estimateIdr, startedAt, endedAt, currency}` — the key names stay (wire contract) but
`costIdr` / `estimateIdr` are **minor units of `currency`**, which is always present; every currency carries its cost.
Version 1 (the installed white-label widgets) is unchanged (no cost for non-IDR sessions).

### 15.8 Account deletion (G4)

| Endpoint | Body | Answer |
|---|---|---|
| `POST /d/v1/account/delete/start` | signed in: `{}`; web form / signed out: `{"phone":"+6281…"}` | `{"ok":true,"phoneMasked":"+62 812-****-7890","blockers":[…],"deleted":[…],"retained":[…],"devCode"?:"123456"}` (code sent by SMS/WhatsApp; `devCode` on development only; a number without an account gets the same answer and nothing is sent); 429 rate limit (one code a minute per number) |
| `POST /d/v1/account/delete` | `{"code":"123456"}` (+ `"phone"` when signed out) | `{"ok":true,"deleted":[…],"retained":[…],"summary":{…counts}}`; 400 wrong / expired code; 409 `{"error":"…","code":"unpaid"\|"active_session"\|"open_hold"\|"active_reservation"\|"in_queue","blockers":[…],"unpaid"?:[{chargeId,kind,owedMinor,currency,site}]}`; 404 no account |
| `GET /account/delete` | — | the public web form (Google Play's deletion link), no inline script (`/d/account-delete.js`) |

**Policy (decided; [LEGAL] to confirm retention periods):**
- Deletion is **immediate** once confirmed with a code sent to the account's number — **no grace period** (the code is
  the safeguard; a pending deletion that still signs in confuses drivers and store reviewers).
- **Refused** while money is owed or in flight: unpaid sessions (expired hold, failed post-pay, partner shortfall), a
  charge in progress or paid and about to start, a card hold not settled (hosted or partner), a live reservation or
  queue place. The app shows `blockers` with Pay / Stop actions.
- **Deleted:** name, e-mail, phone number (replaced by `deleted:<HMAC-SHA256>` — kept only to recognise the number's
  past account for fraud and support; a new sign-in with the number starts a new, empty account); saved cards and linked
  e-wallets (detached at the acquirer, tokens erased); favourites; loyalty membership (points forfeited); pass
  auto-renewal (a paid pass runs to its end); every device of the account signed out and its device token revoked;
  push subscriptions, Live Activity / live-session and push-to-start tokens; pending sign-in codes and counters.
- **Kept** (tax and consumer law — ID 10 years, MY 7, SG 5): charges, payments, refunds, charge records and receipts,
  invoices, partner-network charge records, loyalty ledger — linked to the pseudonymised account row, which nobody can
  sign in to. Operators' own customer records are theirs. Each deletion is logged in `app_driver_deletion` (counts only).
- After `200`, the app discards its device token, issues a new one (`POST /d/v1/device`) and returns to the guest map.

### 15.9 Changed endpoints, summary

| Endpoint | Change |
|---|---|
| all `/d/v1/*` with `X-Driver-Brand: plugsure` | network brand: not operator-scoped; eMSP = PlugSure Mobility; native push and Live Activities enabled |
| `GET /d/v1/stations` | optional `bbox`, `near`, `limit`, `cursor` (paged answer); prices batched (same values) |
| `GET /d/v1/roaming/stations` | partner locations of hosted operators left out (no brand / network brand); `reasonCode` added |
| `GET /d/v1/push` | adds per-kind counts |
| `POST /d/v1/live-activities` | `contentVersion`; partner-network refs; any operator with the network brand |
| `X-Driver-Lang` | `ms`, `zh` accepted (English answers for now) |
| new | `GET /d/v1/map`, `GET /d/v1/links/resolve`, `GET /d/v1/app/config`, `POST /d/v1/push/fcm[/remove]`, `POST /d/v1/live-sessions[/ended]`, `POST /d/v1/account/delete/start`, `POST /d/v1/account/delete`, `GET /account/delete`, `GET /c/*`, `/s/:siteId`, `/r/:kind/:id`, `/paid` |
| console (OpenAPI catalogue, SDK) | `PUT` / `DELETE /v1/driver-app/fcm`, `POST /v1/driver-app/fcm/check`, `GET` / `PUT /v1/driver-app/app-config`; `DriverAppBrand` gains `scope`, `fcm*`, `appConfig` |

The driver API (`/d/v1`) is not part of the published operator OpenAPI document (G23, P3): this section is its
reference; the console routes above are in `src/web/openapi.json` and the SDK.

### 15.10 What the owner must provide before store submission

- **Firebase:** a project for the PlugSure app; the Android app registered (package `asia.plugsure.app` or final
  [OWNER]) and its `google-services.json` in the build; a **service account** with the "Firebase Cloud Messaging API
  Admin" role and the FCM API enabled → upload in PlugSure Mobility's console (Driver app → Android notifications) or
  `MOBILITY_FCM_SA_FILE`.
- **Apple:** Team ID and bundle id (`MOBILITY_IOS_TEAM_ID`, `MOBILITY_IOS_BUNDLE_ID`) for the app-site association and
  the APNs topic; an **APNs auth key (.p8)** with its Key ID; Associated Domains entitlement `applinks:<link domain>`.
- **Android App Links:** the **SHA-256 fingerprints** of the Play App Signing key and the upload key
  (`MOBILITY_ANDROID_CERT_SHA256`, comma-separated).
- **Link domain** (`go.plugsure.asia` [OWNER]) pointed at the API (Caddy on-demand TLS answers for brand hostnames),
  the app icon, and `MOBILITY_LIVE=1`.
- OCPI party ids, PlugSure Mobility's acquirer integrations per country and roaming hold amounts (console), hub
  membership (`MOBILITY_JOIN_HUB=1`) and agreements with CPOs; legal review of the retention periods (§15.8).

### 15.11 Browser builds of the app (CORS) and the app's own conformance run

- `DRIVER_WEB_ORIGINS` (comma-separated exact origins, empty by default): CORS for the **driver API only**
  (`/d/v1/*`) for browser builds of the native app on another origin — the Expo web build in development
  (`http://localhost:8081`) or a hosted preview. Preflights answered with `Access-Control-Allow-Origin: <origin>`,
  `Vary: Origin`, the driver headers (`Authorization`, `Content-Type`, `Idempotency-Key`, `If-None-Match`,
  `X-Driver-Brand`, `X-Driver-Lang`, `X-App-Version`, `X-App-Platform`, `X-App-Build`) and `ETag` exposed; no
  credentials (bearer tokens only). In production only `https://` origins are accepted. The operator API (`/v1/*`,
  whose CSRF guard relies on never granting a preflight), `/app` and unlisted origins are unchanged
  (`src/driver/cors.ts`, tests in `cors.test.ts`).
- The unpaid-session note on the expired hold / failed post-pay (`hold_error`, shown in the console) names the amount
  in major units of the currency (`S$ 1.30`; it printed minor units, `S$ 130`, for currencies with cents).
- The app proves this contract end to end with `mobile/scripts/real-backend.mts` (Playwright on the web build, the
  CI e2e environment, `npm run sim`, the fake Stripe of the stripe e2e): guest QRIS charge with a live session,
  phone OTP, favourites, a Singapore card hold that lapses → unpaid → deletion refused (409 `unpaid`) → paid in the
  app (PayNow) → deleted with a new device token, and `/c/<IDENTITY>:<n>` resolved to its connector.

### 15.12 Review fixes (payment return, map cost, limits, deletion race)

- **Payment return to the app (G11).** Every payment request may carry `returnUrl`. It is honoured only when it is
  the requesting brand's own `<slug>://paid` (the app's URL scheme IS the brand slug: `plugsure://`,
  `nusantaracharge://`) or its link domain's `https://<hostname>/paid`; anything else is ignored (the web app's
  `/app/paid.html`, as before — the PWA is unchanged). Acquirers (Stripe, Midtrans, Xendit, the sandbox) always get
  an https URL on this server, `/paid?for=<kind>&app=<slug>`, which redirects (302) to `<slug>://paid?<the
  acquirer's result parameters>`; `app` must name a brand, so it is no open redirect (`src/driver/app-return.ts`).
  The app's in-app browser (ASWebAuthenticationSession / Custom Tabs) closes on that URL and the pay screen polls
  the server — the return is never proof of payment.
- **`GET /d/v1/map` cost.** A viewport may span at most 16 tiles at its zoom (`360 × 16 / 2^zoom` degrees both ways,
  the whole world from zoom 4 down); larger → 400 `{code: "bbox_too_large", maxSpanDeg}`. Partner (OCPI) locations
  and tariffs are kept in memory per eMSP organisation and re-read when their version changes (row counts and newest
  row versions of locations, tariffs and partners — any writer, any process — checked per request), with a 60 s TTL;
  only locations inside the viewport are built; hosted headline prices are computed only for the stations returned
  (not those inside clusters); the page is chosen with a bounded heap instead of sorting everything.
  `npm run bench:stations` (2,003 connectors, 3,000 partner locations, median): zoom 12 + partners 40.3 → 5.7 ms;
  zoom 15 list (cluster=0) 32.6 → 2.8 ms; zoom 5 164 → 43 ms; zoom 5 + partners 157 → 35 ms.
- **Rate limits for carrier NAT.** On `/d/` each device token has its own token bucket
  (`DRIVER_DEVICE_RATE_LIMIT_PER_MIN`, 600) → 429 `rate_limited` with `Retry-After`; the per-address limit there is a
  higher abuse cap (`DRIVER_IP_RATE_LIMIT_PER_MIN`, 6000). The operator API keeps `API_RATE_LIMIT_PER_MIN`.
- **FCM token endpoint.** In production the service account's assertion is always sent to
  `https://oauth2.googleapis.com/token` (an uploaded file naming another `token_uri` is refused).
- **Account deletion race.** The blockers check and the deletion run under a per-driver advisory lock that every
  charge, reservation, queue join and partner-network charge of a signed-in driver also takes; a request that waited
  for a deletion finds no account (401 `no_device`).
- The seeded operator is "Nusantara Charge" (was "Nusantara Charge Nusantara") and its chargers have display names;
  the driver API already prefers a charger's display name over its OCPP identity.

## 16. App Store and Google Play compliance

| Topic | Rule | Our approach |
|---|---|---|
| Payments | Charging is a physical service consumed outside the app → must **not** use IAP; Apple Pay / card entry allowed (3.1.3(e)) ([guidelines](https://developer.apple.com/app-store/review/guidelines/)); Play Payments policy exempts physical goods/services | Acquirer flows only; memberships/passes are for charging (physical) **[VERIFY with App Review: passes are access to physical service]** |
| Login | 4.8 applies only with third-party/social login | Phone OTP only in v1.0 |
| Account deletion | 5.1.1(v) in-app; Play in-app + web link | §11.4, G4 |
| Guest access | 5.1.1(v): don't force login when not needed | Browse and hosted charging without account |
| Privacy | App Privacy labels; Play Data safety; privacy policy URL | §11.5 |
| Minimum OS | Expo SDK 55: iOS ≥ 15.1, Android 7 (API 24) ([expo.dev](https://expo.dev/blog/upgrading-to-sdk-55)) | **Ship iOS 16.2+** (Live Activities need 16.1/16.2; push-to-start 17.2), **Android 8.0 (API 26)+**; compile/target **API 36** — required for new apps and updates from 31 Aug 2026 ([dev.to summary](https://dev.to/mr_manushukla/android-target-api-36-is-due-aug-31-2026-api-37-is-next-the-play-store-migration-checklist-2f9i)); Android 16 also enforces edge-to-edge and large-screen resizability → layouts must adapt to tablets/foldables |
| Xcode SDK | Apple requires the current SDK for submissions **[VERIFY: iOS 26 SDK minimum since April 2026]** | EAS Build image pinned to latest Xcode |
| Location | Foreground only; purpose strings | §11.3 |
| Background | No background location; push-driven updates | — |
| Store listing | Screenshots per locale (en, id, ms, zh), App Preview video of the 60-s guest flow | — |
| Reviewer access | Demo account + demo charger (sandbox chargers exist on OCPP 2.0.1/2.1) | Provide review notes with a sandbox QR |

## 17. White-label build configuration

Single repo `apps/driver` (Expo). `app.config.ts` reads `APP_VARIANT` (e.g. `plugsure`, `nusantaracharge`) and loads
`variants/<variant>.json` — generated from the console's build kit ([BACKEND] G18):

```ts
// app.config.ts (sketch)
const v = require(`./variants/${process.env.APP_VARIANT ?? 'plugsure'}.json`);
export default ({ config }) => ({
  ...config,
  name: v.appName, slug: v.slug, scheme: v.scheme,               // plugsure://
  version: v.versionName,
  ios: { bundleIdentifier: v.iosBundleId, buildNumber: String(v.versionCode),
         associatedDomains: [`applinks:${v.linkHost}`], infoPlist: { NSLocationWhenInUseUsageDescription: v.strings.location } },
  android: { package: v.androidPackage, versionCode: v.versionCode, googleServicesFile: `./variants/${v.slug}/google-services.json`,
             intentFilters: [{ action: 'VIEW', autoVerify: true, data: [{ scheme: 'https', host: v.linkHost, pathPrefix: '/c' }] }] },
  icon: `./variants/${v.slug}/icon.png`, splash: { backgroundColor: v.palette.dark.surface },
  updates: { url: `https://u.expo.dev/${v.easProjectId}` }, runtimeVersion: { policy: 'fingerprint' },
  extra: { apiBase: v.apiBase, brandSlug: v.slug, brandScope: v.scope /* network|operator */,
           accentColor: v.accentColor, badgeColor: v.badgeColor, defaultLocale: v.defaultLocale,
           features: v.features /* roaming, reservations, queue, memberships, applePay, routePlanner */,
           sentryDsn: v.sentryDsn, eas: { projectId: v.easProjectId } },
});
```

- Each operator variant: its own bundle id/package, Apple team, Firebase project, APNs key (already uploaded per
  brand), Sentry project or environment tag, EAS project (or one project with per-variant channels **[OWNER]**).
- Runtime: the app sends `X-Driver-Brand: <slug>`; `scope=operator` variants inherit today's org scoping.
- Feature flags: build-time defaults, overridden by `/d/v1/app/config.features` (G8).
- The PWA remains the web fallback for every brand.

## 18. Release process

- **EAS Build** profiles: `development` (dev client), `preview` (internal distribution, staging API), `production`.
  Per-variant matrix in CI (GitHub Actions → `eas build --profile production --platform all` with `APP_VARIANT`).
- **EAS Submit** to TestFlight / Play internal track; staged rollout on Play (5 → 20 → 50 → 100 %), phased release on
  iOS (7 days).
- **EAS Update (OTA):** channels `production`, `staging`, `preview` per variant; `runtimeVersion` by fingerprint so a
  JS bundle never lands on an incompatible native build; OTA only for JS/assets (no native changes, no store-
  reviewable feature changes — Apple 3.3.1(b) / 2.5.2 spirit); rollouts at 10 % → 100 % with Sentry release-health
  gate (crash-free ≥ 99.5 %) and `eas update:rollback`.
- **Versioning:** SemVer `MAJOR.MINOR.PATCH` for marketing version; build number / versionCode monotonic per variant
  (EAS `autoIncrement`); OTA updates tagged with git SHA; the backend's `/app/config.minSupported` enforces floors.
- **Release cadence:** native every 2 weeks; OTA hotfixes as needed. Release notes in en + id (+ ms, zh later).
- **Quality gates:** typecheck, unit (Jest), component tests (RNTL), E2E with Maestro against the sandbox chargers
  (guest QRIS flow, OTP sign-in, roaming hold start, stop, receipt), accessibility checks (axe-like lint + manual
  VoiceOver/TalkBack pass), performance check on a low-end device farm (Firebase Test Lab / BrowserStack).

## 19. Open questions and uncertainties

1. **[OWNER]** PlugSure Mobility as a separate eMSP tenant vs. reusing an existing tenant; party ids; which legal
   entity is merchant for roaming holds in each country; licensing as eMSP is distinct from the hub [LEGAL].
2. **[OWNER]/[LEGAL]** One wallet across hosted operators (G15) needs PlugSure Mobility as MoR or acquirer network
   tokens — affects PPN/GST/SST invoicing (tenant invoices today).
3. **[VERIFY]** Partner CPO start latency and status freshness through the hub; partners without real-time EVSE status
   push will show stale availability — need a freshness flag.
4. **[VERIFY]** Store ratings and review themes for regional apps (systematic export pending, §1.1).
5. **[VERIFY]** E-wallet deep-link schemes for QRIS hand-off (GoPay, OVO, DANA, ShopeePay, LinkAja) and whether acquirers
   provide app-switch URLs (Midtrans `deeplink_redirect`, Xendit `mobile_deeplink_checkout_url`).
6. **[VERIFY]** CarPlay charging entitlement process and Android Auto charging category review times.
7. **[OWNER]** Map/geocoding provider (MapTiler, Stadia, Mapbox, Google) and costs at scale.
8. Malaysia's national e-mobility platform (MARii) may become a hub or registry we must connect to; monitor.
9. Guests cannot roam (by design): the < 60 s promise holds only at hosted chargers; partner chargers need sign-in
   (~30 s extra). Could a guest card hold suffice for roaming? Policy decision [OWNER].
