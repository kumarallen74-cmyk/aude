I've completed the research. Here is the report.

---

# Technical Research Report: Autel Hardware, OCPP, OCPI, and CSMS Feature Benchmarks
**Prepared:** August 2026 · **Context:** PlugSure — EV charging management software (CSMS) for Indonesia

> **Verification note:** Items marked **[UNVERIFIED]** could not be confirmed from primary sources during this research and should be validated with the vendor or by reading the OCA specification PDFs directly (they are free but require an OCA account / are mirrored in the `mobilityhouse/ocpp` repo under `docs/v16` and `docs/v201`).

---

## 1. Autel Energy Charging Hardware

### 1.1 Current commercial product line (global, as of Aug 2026)

Autel splits its catalogue by region and the **US and EU/global SKUs are materially different** — this is the single biggest source of confusion when specifying Autel for Indonesia. The US site (`autelenergy.us`) shows NACS/J1772/NEMA products; the global site (`autelenergy.com/global`) and EU site (`autelenergy.eu`) show Type 2 / CCS2.

**AC line**

| Model | Power | Connector | Notes |
|---|---|---|---|
| **MaxiCharger AC Compact** | 7.4 kW (1P) / 22 kW (3P) | Type 2 socket (EU cable compatible) | 336×187×85 mm; BLE, Wi-Fi, Ethernet, 4G, **RS485**; IP54/IK10; RCD 30 mA AC + 6 mA DC; supports **ALM (Adaptive Load Management) over RS485**; 3-yr warranty ([source](https://autelenergy.com/global/product/ac-compact)) |
| **MaxiCharger AC Wallbox** (EU/global workhorse) | 7.4 / 11 / 22 kW, 32 A max | IEC 62196-2 Type 2, 5 m tethered cable **or** socket (optional shutter) | **OCPP 1.6J**; **integrated MID-certified meter, accuracy class B (±1.0 %)**; RFID ISO 15693 / ISO 14443 / NFC ISO 18092; BLE, Wi-Fi, Ethernet, RS485, 4G, **CAN, Modbus TCP/IP**; IP65; −40 °C…+55 °C; CE (TÜV) to IEC/EN 61851-1; OTA updates ([EU datasheet](https://wallboxcenter.de/wp-content/uploads/2026/06/Autel-Maxi-Charger-22-MID-BK_Datenblatt.pdf)) |
| **MaxiCharger AC Wallbox** (UK/Sevadis SKUs) | 7.4 kW 1P: `EVAUTDSSEVOB`, `EVAUTDS4GSEVOB`; 11/22 kW 3P: `EVAUTCS4GSEVB`, `EVAUTCS4GLCD` | Type 2 socket, Mode 3 | **OCPP 1.6**; IP54, IK08; integrated 6 mA DC + 30 mA AC RCD; **PME fault detection** (no earth rod needed); "dynamic load balancing & static load management" built in ([Sevadis datasheet](https://sevadis.com/wp-content/uploads/2024/05/Sevadis-MaxiCharger-AC-Wall-Mounted-Datasheet-LR.pdf)) |
| **MaxiCharger AC Ultra** | EU: **22 kW total, dual socket** (two vehicles simultaneously); US: 2 × 19.2 kW | Dual Type 2 sockets (EU) | 8″ LCD touchscreen, **IK10 screen**, IP54; RFID reader; credit-card reader option; optional energy meters and logo customisation; ad-serving on screen; pedestal option. US variant claims Plug-and-Charge-ready and Wi-Fi hotspot sharing for **up to 16 units** ([EU launch](https://www.businesswire.com/news/home/20230806813972/en/Autel-Energy-launches-MaxiCharger-AC-Ultra-worlds-most-powerful-AC-charger-for-European-markets), [US page](https://autelenergy.us/pages/maxicharger-ac-ultra)) |
| **MaxiCharger AC Pro / AC Elite** | 19.2 kW / 12 kW | J1772 / NACS | **US-market only** — not relevant to Indonesia |

**DC line**

| Model | Power | Connectors | Notes |
|---|---|---|---|
| **MaxiCharger DC Compact** | 40 kW (47 kW peak) | **2 × CCS2**, or 1 × CCS2 + 1 × CHAdeMO, or 1 × CCS2 | 150–950 V, 133 A max, >96 % peak efficiency; **OCPP 1.6J, stated "upgradeable to 2.0.1"**; **ISO 15118 supported**; 4G/Wi-Fi/Ethernet; 21.5″ IK10 touchscreen with ad capability; IP54/IK10; −35 °C…+55 °C; pedestal (1570×970×350 mm) or trolley (1300×720×775 mm); IEC 61851-1/-23/-21-2 ([Sevadis DC Compact datasheet](https://sevadis.com/wp-content/uploads/2024/07/MaxiCharger-DC-Compact-40-47kW-Datasheet.pdf)) |
| **MaxiCharger DC Fast** | 60–120 kW and 120–240 kW, **field-expandable in 20 kW increments** | 2 connectors, 200–400 A, 4/5/7 m cables | 27″ touchscreen; 96 % efficiency at full power; BLE/Wi-Fi/4G/Ethernet; OTA; RFID + card reader + app; "Plug-and-Charge ready" ([global page](https://autelenergy.com/global/product/dc-fast)) |
| **MaxiCharger DH480** (fully modular all-in-one) | 120 → 480 kW, modular. **480 kW liquid-cooled / 320 kW air-cooled** | **2 × CCS2; 1 × CCS2 + 1 × CHAdeMO; 2 × CCS2 + 1–2 × CHAdeMO**. Up to 4 ports, each up to 480 kW | **Explicitly "OCPP 1.6J & OCPP 2.0.1"**; **ISO 15118**; certifications CE, CB, UKCA, **Eichrecht, MID, LNE**, EMC Class A; payment terminals **NAYAX VPOS Touch, ONYX, Payter P66**; power modules hot-swappable in ~5 min ([DH480 datasheet](https://www.elfor.org/wp-content/uploads/2024/09/MaxiCharger-DH480_camion.pdf)) |
| **MaxiCharger DC HiPower** | 320–640 kW (expandable from 320 kW base); up to 480 kW single-vehicle | 4 connectors, **650 A liquid-cooled cables**; serves up to **8 vehicles simultaneously** via power distribution | 15.6″ screen, floor mount, 5 m cable. Autel claims 99.5 % compatibility / first-time-success rate ([global page](https://www.autelenergy.com/global/product/dc-hipower)) |
| **MaxiCharger MCS** | Megawatt Charging System for HDV | MCS | Announced for Europe; not commercially relevant for Indonesia yet **[UNVERIFIED for SEA availability]** |

**Adjacent products:** ESA500 (125 kW / 261 kWh BESS), EMU300/EMU600 energy-management controllers, MaxiPower X/S integrated PV-ESS. Relevant if PlugSure wants to model behind-the-meter storage for Indonesian sites with weak grid connections.

### 1.2 Southeast Asia / Indonesia availability

- **Confirmed SEA presence:** Singapore (DC fast rollout from 2023, expanded since), Thailand (Autel showcased at **EV Charge Live Thailand 2026** and hosted Spark EV's 250-site nationwide milestone; also demonstrated a **960 kW MaxiCharger system** in Thailand), Malaysia/Australia via the 2023 "Asia and Australia complete line" expansion. Sources: [Businesswire Asia/Australia expansion](https://www.businesswire.com/news/home/20230308005943/en/Autel-Expands-Its-Presence-in-Asia-and-Australia-Markets-With-a-Complete-Line-of-EV-Charging-Solutions), [Singapore rollout](https://www.businesswire.com/news/home/20230413005600/en/Autel-Energy-Rolling-Out-EV-Charging-Stations-in-Singapore-Accelerating-Sustainable-Development-Across-Southeast-Asia), [Thailand 2026](https://www.thaipr.net/en/energy_en/3688601).
- **Indonesia specifically: [UNVERIFIED].** I found **no** public evidence of an Autel Indonesia office, an authorised Indonesian distributor, or Autel units in PLN's SPKLU programme. Recommend contacting Autel Energy APAC directly and confirming: (a) local distributor and spare-parts/RMA path, (b) SNI / Kemendag import certification status, (c) whether the global (Type 2 / CCS2) SKUs are stocked regionally.
- **Connector implications for Indonesia:** Indonesia's public network is CCS2-dominant with legacy CHAdeMO and some GB/T from early Chinese imports; AC is Type 2. Autel's global SKUs cover **Type 2, CCS2, CHAdeMO**. **GB/T: [UNVERIFIED]** — I found no Autel GB/T variant in the global catalogue. If GB/T is required (e.g., for Wuling/DFSK legacy fleets), assume it is a China-domestic-only SKU and plan around it.

### 1.3 Autel Cloud vs. third-party CSMS — can you point Autel at your own backend?

**Yes — but with real, deployment-affecting caveats.**

**Autel's own CSMS ("Autel Charge Cloud")** is OCPP-based and is sold as SE / Lite / Pro subscription tiers per L2 port (USD 29.99 trial → USD 240–1,100 for 1–5 yr Pro). Critically, the store page states it is **"Available in US and Canada Only"** ([store page](https://store.autelenergy.com/products/autel-charge-cloud)). That is a strong commercial argument for a third-party CSMS in Indonesia. Autel's CSMS achieved **OCPP 2.0.1 certification (Core + Advanced Security profiles)** in June 2024 ([Businesswire](https://secure.businesswire.com/news/home/20240607053291/en/Autel-Energys-Charging-Station-Management-System-CSMS-Achieves-OCPP-2.0.1-Certification-Advancing-EV-Charging-Interoperability-and-Security)) — note this certified the **CSMS**, not the chargers.

**Two configuration paths exist:**

**(a) `Autel Config` — the installer app (the one you want).** Available on [iOS](https://apps.apple.com/us/app/autel-config/id1607007731) and [Android](https://play.google.com/store/apps/details?id=com.autel.config). It connects to the charger over **Bluetooth LE** (the charger advertises its serial number; ZDI found 4 BLE services / 14 characteristics). It exposes an explicit OCPP form. Confirmed field names from a real third-party onboarding guide ([Clenergy EV onboarding guide for Autel/Sevadis MaxiCharger](https://partners.clenergy-ev.com/hubfs/Onboarding%20Guides%20(PDF)/Autel%20Sevadis%20Maxicharger%20-%20Onboarding%20Guide%20(New%20branding).pdf?hsLang=en)):

- **`Security Profile`** — dropdown, e.g. `WSS`
- **`Server IP/Domain`** — e.g. `clenergy.online`
- **`Server Path`** — e.g. `/`
- **`Server Port`** — e.g. `8081`
- **`Chargebox Identity`** — *leave empty to use the charger's serial number as the OCPP identity*
- APN settings for 4G models: APN, username, password, `IPv4/IPv6`, `PAP/CHAP`

  So the effective endpoint is assembled as `wss://<Server IP/Domain>:<Port><Server Path><ChargeBoxId>`. **Design implication for PlugSure:** your ingress must accept the charge point ID as the final URL path segment and must tolerate a **serial-number-derived ChargeBoxId** (Autel serials are long alphanumerics). Do not assume you can choose the ID.

- **Access caveat:** ZDI notes `Autel Config` **"lacks public registration, implying some other way of obtaining valid credentials"** for technicians ([ZDI part two](https://www.thezdi.com/blog/2025/1/15/reviewing-the-attack-surface-of-the-autel-maxicharger-part-two)). In practice you must be onboarded as an Autel installer/partner. Budget for this in procurement.

**(b) `Autel Charge` — the consumer/owner app.** Has an **"OCPP Server" list under the settings gear**, but on many firmware builds this is a **pre-provisioned whitelist of partner backends** (e.g. "ChargeLab WSS") rather than a free-text URL field ([ChargeLab guide](https://chargelab.zendesk.com/hc/en-us/articles/42340494306203-Autel-AC-Lite-Maxi-Charge-Configuration-Guide)). Some users report a free-form IP/port entry on other builds ([HA discussion](https://github.com/lbbrhzn/ocpp/discussions/669)). **Do not plan on this path** — plan on `Autel Config` + partner enrolment, and confirm with Autel whether PlugSure can be added to the in-app server list (this is a meaningful commercial ask and a genuine distribution advantage if granted).

### 1.4 Known Autel OCPP quirks and caveats — **read this before committing**

1. **Switching to third-party OCPP may be irreversible and disables Autostart.** Documented case: after enabling third-party OCPP, **Autostart could not be re-enabled**, and Autel Support responded *"Once your charger takes the 3rd party OCPP configuration there is no way for us to make changes to it"*, offering only warranty replacement ([issue #1955](https://github.com/lbbrhzn/ocpp/issues/1955)). Confirmed on a US 40 A AC unit; **[UNVERIFIED]** for EU/global DC SKUs, but assume the same until proven otherwise. **Action: test on a sacrificial unit, and get written confirmation from Autel that the OCPP endpoint can be re-pointed in the field.**
2. **`ChangeConfiguration` rejections.** Chargers have been observed returning `Rejected` for `MeterValuesSampledData=Energy.Active.Import.Register` ([discussion #669](https://github.com/lbbrhzn/ocpp/discussions/669)). Your CSMS must not treat a `Rejected` on a metering key as a fatal provisioning error — degrade gracefully and fall back to whatever the charger already reports.
3. **Connection stability / churn.** Multiple reports of chargers going unavailable and heartbeat/status entities dropping. Firmware version matters materially; several reporters only got stable behaviour after both charger firmware and client updates.
4. **Charging-current control (`SetChargingProfile`) is firmware-sensitive.** EVCC users could not adjust current until evcc ≥ 0.120.1/0.120.3 ([evcc discussion #9572](https://github.com/evcc-io/evcc/discussions/9572)). Validate `TxDefaultProfile` and `TxProfile` acceptance *and actual current response* per firmware build.
5. **Firmware delivery initially over plain HTTP.** ZDI observed the charger downloading firmware over **unencrypted HTTP** before switching to HTTPS after a reboot; cloud gateway is `gateway-eneprodus.autel.com` on AWS. Security-relevant for a regulated Indonesian deployment.
6. **Vendor-specific `DataTransfer` extensions: [UNVERIFIED].** I found **no** published Autel `vendorId`/`messageId` catalogue. Plan to capture raw WebSocket frames from a bench unit and log every unrecognised `DataTransfer` rather than rejecting it. Your CSMS **must** answer unknown `DataTransfer.req` with `status: "UnknownVendorId"` / `"UnknownMessageId"` rather than erroring the connection.
7. **The `ocpp2.0.1` claim is model- and firmware-dependent.** Only **DH480** is documented as "OCPP 1.6J & OCPP 2.0.1"; **DC Compact** says "1.6J, upgradeable to 2.0.1"; the **AC Wallbox EU datasheet says OCPP 1.6J only**. **Treat 1.6J as the contractual baseline** for any Autel AC fleet.

### 1.5 Feature checklist — Autel

| Capability | Status |
|---|---|
| **OCPP 1.6J** | Yes, across the line — this is the safe baseline |
| **OCPP 2.0.1** | DH480: yes. DC Compact: "upgradeable". AC Wallbox EU: not stated. Autel *CSMS* is 2.0.1-certified; charger-side OCA certification **[UNVERIFIED]** |
| **ISO 15118 / Plug & Charge** | DC Compact and DH480 list ISO 15118 in safety/comms standards. US AC/DC pages say "Plug-and-Charge ready". **Whether this is 15118-2 PnC with contract certificates, or merely Autocharge (MAC/EVCCID-based), is [UNVERIFIED]** — this distinction is critical and must be confirmed |
| **MID-certified metering** | **Yes** — EU AC Wallbox has integrated MID class-B (±1.0 %) meter; DH480 is MID + **Eichrecht** + LNE certified. AC Ultra offers "optional energy meters" |
| **RFID reader** | Yes across AC and DC. AC Wallbox supports **ISO 15693, ISO 14443, NFC ISO 18092** — so both MIFARE Classic/DESFire and vicinity cards |
| **Payment terminal** | DH480 integrates **NAYAX VPOS Touch / ONYX / Payter P66**. AC Ultra & DC Fast offer credit-card readers (US-centric). **No evidence of QRIS support** — for Indonesia, expect to drive payment from your own app/QR rather than the terminal |
| **Dynamic load balancing (CT clamps / meter)** | **Yes.** External **energy meter + CT clamps**, wired to the charger over **Modbus RS485 (max 500 m)** ([Sevadis DLB doc](https://sevadis.com/wp-content/uploads/2024/03/Sevadis-Dynamic-Balancing-Document.pdf)). AC Compact calls it ALM over RS485 |
| **Local load balancing between units** | **Yes, master/secondary.** One charger is Master; secondaries coordinate over the site's Wi-Fi/wired internet. **Limit: 8 chargers per meter** (Sevadis doc). The US AC Ultra page separately claims Wi-Fi hotspot sharing for up to 16 units — **the two figures conflict; verify per model** |
| **Power sharing on DC** | DC Compact and HiPower do internal dynamic power sharing across guns |
| **OTA firmware** | Yes, via Autel cloud/web portal. **Whether OCPP `UpdateFirmware` from a third-party CSMS works is [UNVERIFIED]** and is a key acceptance test |

**Architectural recommendation:** treat Autel's **local DLB (RS485 + master/secondary)** as a *safety net* independent of your CSMS, and layer OCPP `SetChargingProfile` on top for tariff/grid-driven shaping. Do not build your site power budget on the assumption that OCPP smart charging alone will protect the incoming breaker — the RS485 CT-clamp path is what actually guarantees it, and it works when the WAN is down.

---

## 2. OCPP Protocol — What a CSMS Must Implement

### 2.1 OCPP 1.6J — transport

- **WebSocket subprotocol:** `ocpp1.6` in the `Sec-WebSocket-Protocol` header. Your server **must** echo exactly one negotiated subprotocol; some chargers offer `ocpp1.6` only, some offer a list.
- **Connection URL:** `ws(s)://host[:port]/path/<chargeBoxId>` — the ChargeBoxId is conventionally the last path segment.
- **RPC framing (OCPP-J):** JSON arrays. `[2, uniqueId, action, payload]` = CALL; `[3, uniqueId, payload]` = CALLRESULT; `[4, uniqueId, errorCode, errorDescription, errorDetails]` = CALLERROR. **Only one outstanding CALL per direction** — this is the #1 thing naive implementations get wrong.
- **Standard error codes:** `NotImplemented`, `NotSupported`, `InternalError`, `ProtocolError`, `SecurityError`, `FormationViolation`, `PropertyConstraintViolation`, `OccurrenceConstraintViolation`, `TypeConstraintViolation`, `GenericError`.

### 2.2 OCPP 1.6J — required message set by Feature Profile

Confirmed against [ocpp.md 1.6J reference](https://ocpp.md/ocpp-1.6j/).

**Core (mandatory — 16 messages)**

| CP → CS | CS → CP |
|---|---|
| `Authorize` | `ChangeAvailability` |
| `BootNotification` | `ChangeConfiguration` |
| `Heartbeat` | `ClearCache` |
| `MeterValues` | `GetConfiguration` |
| `StartTransaction` | `RemoteStartTransaction` |
| `StatusNotification` | `RemoteStopTransaction` |
| `StopTransaction` | `Reset` |
| | `UnlockConnector` |
| **`DataTransfer` — bidirectional** | |

**FirmwareManagement (optional, 4):** `GetDiagnostics`, `UpdateFirmware` (CS→CP); `DiagnosticsStatusNotification`, `FirmwareStatusNotification` (CP→CS).
**LocalAuthListManagement (2):** `SendLocalList`, `GetLocalListVersion`.
**Reservation (2):** `ReserveNow`, `CancelReservation`.
**SmartCharging (3):** `SetChargingProfile`, `ClearChargingProfile`, `GetCompositeSchedule`.
**RemoteTrigger (1):** `TriggerMessage`.

**Practical build order for PlugSure:** Core first (gets you connectivity + billable sessions), then RemoteTrigger (`TriggerMessage` is your recovery tool for stuck/silent chargers), then SmartCharging, then LocalAuthList (essential for Indonesian sites with unreliable connectivity), then FirmwareManagement, then Reservation.

**Key state machine — `StatusNotification` connector status values:** `Available`, `Preparing`, `Charging`, `SuspendedEVSE`, `SuspendedEV`, `Finishing`, `Reserved`, `Unavailable`, `Faulted`. `connectorId = 0` means the charge point itself, not a connector. Note that 1.6 chargers commonly report `SuspendedEV` during a normal end-of-charge taper — do not treat it as a fault.

**Transaction handling gotchas:**
- `StartTransaction.conf` returns a CSMS-assigned integer `transactionId`. The charger references this in `MeterValues` and `StopTransaction`. **You must handle offline-queued `StartTransaction` messages arriving late** with old `timestamp` values — bill on the charger's timestamps, not on receipt time.
- `StopTransaction` carries `transactionData` (a full `MeterValue` array) — this is often where the authoritative energy total lives.
- `StopTransaction.reason`: `EmergencyStop`, `EVDisconnected`, `HardReset`, `Local`, `Other`, `PowerLoss`, `Reboot`, `Remote`, `SoftReset`, `UnlockCommand`, `DeAuthorized`.
- **Clock sync:** `Heartbeat.conf` returns `currentTime`. Chargers rely on this. Skipping it silently corrupts your billing timestamps. ([Named as a top-5 mistake by ocpplab](https://www.ocpplab.com/blog/ocpp-implementation-guide).)

**Configuration keys you will actually use (1.6 standard set):**
`HeartbeatInterval`, `MeterValueSampleInterval`, `MeterValuesSampledData`, `MeterValuesAlignedData`, `ClockAlignedDataInterval`, `StopTxnSampledData`, `StopTxnAlignedData`, `ConnectionTimeOut`, `WebSocketPingInterval`, `NumberOfConnectors`, `SupportedFeatureProfiles`, `AuthorizeRemoteTxRequests`, `LocalAuthorizeOffline`, `LocalPreAuthorize`, `AllowOfflineTxForUnknownId`, `LocalAuthListEnabled`, `LocalAuthListMaxLength`, `SendLocalListMaxLength`, `AuthorizationCacheEnabled`, `TransactionMessageAttempts`, `TransactionMessageRetryInterval`, `ResetRetries`, `StopTransactionOnEVSideDisconnect`, `StopTransactionOnInvalidId`, `UnlockConnectorOnEVSideDisconnect`, `ConnectorPhaseRotation`, `MinimumStatusDuration`, `GetConfigurationMaxKeys`.
**Smart-charging keys:** `ChargeProfileMaxStackLevel`, `ChargingScheduleAllowedChargingRateUnit`, `ChargingScheduleMaxPeriods`, `MaxChargingProfilesInstalled`, `ConnectorSwitch3to1PhaseSupported`.

> Your provisioning routine should be: `BootNotification` → `GetConfiguration` (no keys = dump all) → diff against desired state → `ChangeConfiguration` per differing key → record what was `Rejected` / `NotSupported` as a per-model capability profile. **Persist that capability profile** — it is the foundation of multi-vendor support.

### 2.3 OCPP 1.6 Smart Charging — the part most CSMSs get wrong

Confirmed against [ocpp.md smart charging deep-dive](https://ocpp.md/ocpp-1.6j/smart-charging/).

**`chargingProfilePurpose` — three values:**

| Purpose | Scope | Persistence | Constraints |
|---|---|---|---|
| **`ChargePointMaxProfile`** | Whole charge point, all connectors | Persistent | **Only valid on `connectorId = 0`**. This is your grid/breaker ceiling |
| **`TxDefaultProfile`** | Station-wide (`connectorId = 0`) or per-connector | Persistent, applies to *new* transactions | No transaction required. Your "standing tariff/policy" profile |
| **`TxProfile`** | One connector, current transaction only | Discarded at transaction end | **Requires an active transaction; `transactionId` is mandatory; `connectorId = 0` is invalid** |

**Stacking:** Profiles of the same purpose coexist at different integer `stackLevel` values (≥ 0). **The prevailing profile is the one with the highest `stackLevel` that is currently valid.** A `SetChargingProfile` that matches an existing profile on **both** `stackLevel` **and** `chargingProfilePurpose` **replaces** it.

> **Trap:** a profile installed at the highest stack level **with no `duration`** never expires, so the charger never falls back to a lower level. Always set `duration` or `validTo` on transient profiles, and clear aggressively.

**Composite limit:** effective limit = **min(** prevailing `ChargePointMaxProfile`, **and** prevailing `TxProfile` — or prevailing `TxDefaultProfile` if no `TxProfile` exists **)**. On multi-connector units the `ChargePointMaxProfile` is a *total* across connectors, and **how the charge point internally allocates that total between connectors is not specified by OCPP 1.6** — it is vendor-defined. This is a real interoperability hazard for Autel dual-socket AC Ultra and dual-gun DC.

**`chargingRateUnit`: `A` vs `W`**
- `A` = amps per phase; `W` = watts. Query **`ChargingScheduleAllowedChargingRateUnit`** to learn what the hardware accepts. Behaviour on mismatch is vendor-dependent — validate before sending.
- **Practical guidance:** AC chargers overwhelmingly want `A`; DC chargers want `W`. Your internal model should store watts and convert at the adapter boundary using the connector's known phase count and nominal voltage (in Indonesia, 230 V L-N / 400 V L-L, 50 Hz).
- `numberPhases` (default 3) applies per `chargingSchedulePeriod`. `minChargingRate` is **an informational hint to the optimiser, not an enforced floor**.

**`chargingProfileKind`:**
- `Absolute` — periods offset from a fixed `startSchedule` datetime
- `Recurring` — repeats per `recurrencyKind` (`Daily` | `Weekly`); the reference date anchors the cycle
- `Relative` — periods offset from transaction start; only meaningful for `TxProfile` / `TxDefaultProfile`

**`ClearChargingProfile`:** optional filters `id`, `connectorId`, `chargingProfilePurpose`, `stackLevel`, combined with AND. **Sending it with no fields clears everything on the station.** Returns `Accepted` or `Unknown`.

**`GetCompositeSchedule`:** asks the charger for its own merged view over a duration. `connectorId = 0` = station-level. **Implementation varies significantly by vendor** — useful for diagnostics but do not make it load-bearing in your control loop.

### 2.4 OCPP 1.6 Security Extension (a.k.a. the OCA Security Whitepaper, folded into 1.6 Edition 3)

**Security Profiles:**

| Profile | Transport | CS authentication | CSMS authentication |
|---|---|---|---|
| **0** | Plain `ws://` | None | None |
| **1** | Plain `ws://` | HTTP Basic Auth | None |
| **2** | `wss://` (TLS, server cert) | HTTP Basic Auth | Server certificate |
| **3** | `wss://` (mutual TLS) | **Client certificate** | Server certificate |

**How 1.6J Basic Auth actually works** ([CoreEVI](https://coreevi.com/a/2/ocpp-basic-auth-securityprofile)):
- **Username = the `chargePointId`** (the last path segment of the WS URL). **Password = the value of config key `AuthorizationKey`.**
- Per the OCA Security Whitepaper, `AuthorizationKey` must be **randomly generated binary, 16–20 bytes, hex-encoded**, and is **WriteOnly** — the charger must **not** return it in a `GetConfiguration` response.
- Sent as a standard `Authorization: Basic base64(chargePointId:key)` header on the WebSocket upgrade request.
- **Rotation order matters:** set `AuthorizationKey` *first*, then raise `SecurityProfile`. Doing it in the other order bricks the connection. Your CSMS should accept **both the old and new key for a grace window** during rotation, and must handle the charger reconnecting with the new credential on the very next connect.

**Security-extension config keys:** `SecurityProfile`, `AuthorizationKey`, `CpoName`, `AdditionalRootCertificateCheck`, `CertificateSignedMaxChainSize`, `CertificateStoreMaxLength`.

**Security-extension messages** (implement these if you want Profile 2/3 and signed firmware — **[list is from spec knowledge, cross-check against 1.6 Ed.3 PDF]**): `SecurityEventNotification`, `SignCertificate`, `CertificateSigned`, `InstallCertificate`, `DeleteCertificate`, `GetInstalledCertificateIds`, `ExtendedTriggerMessage`, `GetLog`, `LogStatusNotification`, `SignedUpdateFirmware`, `SignedFirmwareStatusNotification`.

> **Note for certification planning:** the *updated* OCPP 1.6 certification programme now **mandates Security Profile 2 support**. Profile 2 (TLS + Basic Auth) is the practical minimum for anything internet-facing ([amina](https://aminacharging.com/articles/ocpp-security-profiles/)).

### 2.5 ISO 15118 Plug & Charge over OCPP 1.6

OCPP 1.6 has no native 15118 support, so the OCA defined a `DataTransfer` wrapper ([OCA whitepaper: *Using ISO 15118 Plug & Charge with OCPP 1.6*, v1.0, 2020-09-16](https://openchargealliance.org/wp-content/uploads/2023/11/ocpp_1_6_ISO_15118_v10.pdf)):

- **`vendorId` = `org.openchargealliance.iso15118pnc`** (fixed)
- **`messageId` = the OCPP 2.0.1 message name** (`Authorize`, `SignCertificate`, `CertificateSigned`, `Get15118EVCertificate`, `GetCertificateStatus`, `InstallCertificate`, `DeleteCertificate`, `GetInstalledCertificateIds`, `TriggerMessage`)
- **`data` = the JSON payload of that 2.0.1 message**
- For PnC sessions, **the plain `Authorize.req` SHALL NOT be used** — only the wrapped form, carrying the **eMAID** and OCSP data.
- Config keys: `CentralContractValidationAllowed` (pass unvalidated PEM certs to the backend when the CP lacks the root), `ContractValidationOffline` (local validation against cached chains + local auth list).

**Recommendation for Indonesia:** PnC requires a contract-certificate PKI and eMAID issuance that does not meaningfully exist in Indonesia today. **Ship Autocharge instead** (EVCCID/MAC-based auto-authorisation — non-standard but universally used), and design the token model so a real 15118 eMAID can be added later as just another token type.

### 2.6 OCPP 2.0.1 — what is structurally different

Confirmed against [ocpp.md 2.0.1](https://ocpp.md/ocpp-2.0.1/) and [OCA "What is new in OCPP 2.0.1"](https://openchargealliance.org/wp-content/uploads/2024/01/new_in_ocpp_201-v10.pdf).

**64 messages across 15 functional blocks (A–P):** A Security, B Provisioning, C Authorization, D LocalAuthList/Transactions, E Transactions, F Remote Control, G Availability, H Reservation, I TariffAndCost, J Metering, K Smart Charging, L Firmware, M ISO 15118 Certificate Mgmt, N Diagnostics, O Display Message, P Data Transfer. (Block letters vary slightly between the OCA doc and secondary references — use the spec.)

**Five structural changes that drive your architecture:**

1. **Device model replaces flat config.** Instead of `GetConfiguration`/`ChangeConfiguration` over a flat key-value list, 2.0.1 has a **Component / Variable** tree: `GetVariables`, `SetVariables`, `GetBaseReport`, `NotifyReport`, `GetReport`, `SetVariableMonitoring`, `NotifyEvent`, `ClearVariableMonitoring`. The standardised catalogue has ~**73 components and ~249 component/variable pairings** (e.g. `AuthCtrlr`, `TxCtrlr`, `SmartChargingCtrlr`, `SecurityCtrlr`, `OCPPCommCtrlr`). Each variable has attributes (`Actual`, `Target`, `MinSet`, `MaxSet`) and characteristics (type, unit, ranges). **This is not a rename of 1.6 config — it is a different data model, and your persistence layer must accommodate both.**
2. **`TransactionEvent` replaces `StartTransaction` / `StopTransaction` / (transactional) `MeterValues`.** One message with `eventType` ∈ {`Started`, `Updated`, `Ended`}, plus `triggerReason` (`Authorized`, `CablePluggedIn`, `ChargingStateChanged`, `MeterValuePeriodic`, `EVCommunicationLost`, `RemoteStop`, `StopAuthorized`, …), `seqNo`, `chargingState`, and embedded `meterValue[]`. **The charging station generates the `transactionId` locally** (a string), which massively improves offline behaviour — no round-trip needed to start billing.
3. **Hierarchical topology.** `ChargingStation → EVSE (evseId ≥ 1) → Connector`. **`evseId = 0` addresses the station itself.** 1.6's flat `connectorId` maps to `(evseId, connectorId)` — your canonical model must be the 2.0.1 shape, with 1.6 mapped *up* into it.
4. **Security is first-class and mandatory.** Three profiles: **1** = HTTP Basic + TLS-less/server-only depending on edition, **2** = TLS + Basic Auth, **3** = mutual TLS with client certificates. Plus `SignCertificate`/`CertificateSigned`, `InstallCertificate`, `DeleteCertificate`, `GetInstalledCertificateIds`, `SecurityEventNotification`, `GetLog`/`LogStatusNotification`, and **signed firmware updates**. Note the profile numbering/semantics shifted slightly from the 1.6 security extension — read the 2.0.1 Part 2 security chapter, don't assume.
5. **ISO 15118-2 is native.** `Get15118EVCertificate`, `GetCertificateStatus`, `NotifyEVChargingNeeds`, `NotifyEVChargingSchedule`, `AuthorizeRequest` with `iso15118CertificateHashData` — no `DataTransfer` wrapper.

**Smart charging in 2.0.1** — **four** purposes instead of three, in priority order:
1. `ChargingStationExternalConstraints` (grid/DSO-imposed — **new**, and the CSMS cannot be the only writer)
2. `ChargingStationMaxProfile`
3. `TxDefaultProfile`
4. `TxProfile`

Plus: `NotifyChargingLimit`, `ClearedChargingLimit`, `ReportChargingProfiles`, `GetChargingProfiles`, EV-sourced schedules via `NotifyEVChargingNeeds` / `NotifyEVChargingSchedule`, and a much better-specified `GetCompositeSchedule`.

**Reservation in 2.0.1:** `ReserveNow` / `CancelReservation` remain, plus **`ReservationStatusUpdate`** (CS → CSMS) so the station can tell you a reservation expired or was used — a real gap in 1.6.

**Also new and useful:** Display Messages (`SetDisplayMessage`, `GetDisplayMessages`, `NotifyDisplayMessages`, `ClearDisplayMessage`) — lets the CSMS push tariff/branding text to the charger screen; `CostUpdated` for live cost display; `NotifyCustomerInformation` / `CustomerInformation` for GDPR-style data requests.

### 2.7 OCPP 2.1 — status as of Aug 2026 (relevant to your roadmap)

Released **January 2025**; **Edition 2 published 4 Dec 2025**, adding Parts 5 and 6 (certification profiles and test cases). OCPP 2.0.1 **Edition 4** also published Dec 2025 (errata roll-up). Sources: [OCA 2.1 announcement](https://openchargealliance.org/ocpp-2-1-is-now-available/), [new editions](https://openchargealliance.org/new-editions-of-the-ocpp-2-1-and-2-0-1-now-available/).

2.1 is a **functional superset of 2.0.1**: all 64 messages retained unchanged, **+27 new = 91 total**; blocks expand from 15 to 19. New blocks: **DER Control** (volt-watt, frequency-watt, reactive power), **Bidirectional/V2X** (incl. aFRR signalling), **TariffAndCost** (first-class tariff model, mid-transaction tariff changes, local cost calculation, `CostUpdated` moves here), **Battery Swap** (explicitly aimed at **two- and three-wheelers** — directly relevant to Indonesia's motorcycle-dominant market). Also: prepaid cards, ad-hoc card payment, **secure dynamic QR codes**, transaction resumption after forced reboot. New RPC frame types **CALLRESULTERROR (5)** and **SEND (6)** (one-way telemetry that doesn't consume the request slot). Backward-compatible with 2.0.1; **not** with 1.6. ([ocpp.md 2.1 migration guide](https://ocpp.md/ocpp-2.1/))

> **Strategic note for PlugSure:** OCPP 2.1's **battery swap** block and **dynamic QR payment** are unusually well-aligned with the Indonesian market (motorcycle swap networks, QRIS). Even if you ship 1.6J first, shape your canonical model so 2.1 concepts (tariffs, swap sessions) are not structurally excluded.

### 2.8 Practical strategy for supporting 1.6 **and** 2.0.1 (and later 2.1) simultaneously

Market reality in 2026: **OCPP 1.6 is still dominant**; 2.0.1 adoption is gradual and hardware-gated ([AMPECO OCPP handbook](https://www.ampeco.com/guides/complete-ocpp-guide/)). For Indonesia, where imported hardware skews to 1.6J, **1.6J must be your first-class citizen and 2.0.1 your forward path.** Plan for a decade of coexistence.

**Recommended architecture — three layers:**

```
┌─────────────────────────────────────────────────────────┐
│  Domain / Business layer                                │
│  ChargingStation · EVSE · Connector · Session · Token   │
│  Tariff · ChargingPolicy · Command · Event              │
│  (2.0.1-shaped canonical model — 1.6 maps UP into it)   │
└────────────────────┬────────────────────────────────────┘
                     │  canonical commands & events
        ┌────────────┴────────────┬──────────────┐
┌───────▼───────┐  ┌──────────────▼──┐  ┌────────▼────────┐
│ 1.6J adapter  │  │ 2.0.1 adapter   │  │ 2.1 adapter     │
│ + per-vendor  │  │ + device model  │  │ (later)         │
│   quirk table │  │   translation   │  │                 │
└───────┬───────┘  └────────┬────────┘  └────────┬────────┘
        └──────────┬────────┴────────────────────┘
        ┌──────────▼──────────────────────────────┐
        │ OCPP-J transport: WS/WSS, subprotocol   │
        │ negotiation, RPC framing, schema        │
        │ validation, one-in-flight-CALL enforcement│
        └─────────────────────────────────────────┘
```

**Concrete rules:**

1. **Negotiate at the handshake, not the URL.** Read `Sec-WebSocket-Protocol` and pick the highest supported (`ocpp2.1` > `ocpp2.0.1` > `ocpp1.6`). Some CSMSs use version-in-path (`/ocpp/1.6/{id}` vs `/ocpp/2.0.1/{id}`) — e.g. Dynamo CSMS does this ([docs](https://dynamo-csms.mintlify.app/concepts/ocpp-protocols)). **Support both**: version-in-path as a fallback for chargers with broken subprotocol negotiation, but treat header negotiation as authoritative. Record the negotiated version on the connection object.
2. **Canonical model = 2.0.1 shape.** Store `(evseId, connectorId)`; for 1.6, map `connectorId = N` → `(evseId = N, connectorId = 1)` and `connectorId = 0` → the station. Store transaction IDs as **strings** (1.6 integers stringify cleanly; 2.0.1 IDs are already strings). Store charging limits internally in **watts + phase count**, convert to `A`/`W` at the adapter.
3. **Unify transactions on the 2.0.1 event shape.** The 1.6 adapter synthesises `TransactionEvent(Started)` from `StartTransaction`, `TransactionEvent(Updated)` from each `MeterValues`, and `TransactionEvent(Ended)` from `StopTransaction`. Your billing engine then only ever sees one shape. This is the single highest-leverage decision in the whole design.
4. **Unify configuration behind a capability/variable abstraction.** Model everything as `(component, variable, value)`. The 1.6 adapter flattens to `component = null, variable = <configKey>`; 2.0.1 uses the real tree. Expose one internal API: `getVariable()` / `setVariable()`.
5. **Per-vendor quirk registry, keyed on `(chargePointVendor, chargePointModel, firmwareVersion)` from `BootNotification`.** Store: which config keys are rejected, which `MeterValuesSampledData` measurands are actually emitted, whether `A` or `W` is accepted, whether `GetCompositeSchedule` is trustworthy, whether `connectorId=0` `TxDefaultProfile` propagates. Populate it empirically. **This registry is what makes multi-vendor support tractable — build it on day one, not year two.**
6. **Never reject unknown `DataTransfer`.** Log it, respond `UnknownVendorId`/`UnknownMessageId`, and mine the logs. That is how you discover Autel's undocumented extensions.
7. **Idempotency and replay.** Offline chargers replay queued `StartTransaction`/`StopTransaction`/`MeterValues` on reconnect, often out of order and with stale timestamps. Key sessions on `(chargePointId, connectorId, chargerLocalTxRef, startTimestamp)` and make CDR generation idempotent.
8. **Test with simulators, not only hardware.** Use `ocpp-rpc` or `mobilityhouse/ocpp` to build a virtual charger fleet for load, reconnect-storm, and failure-path testing before you touch an Autel unit ([ocpplab guidance](https://www.ocpplab.com/blog/ocpp-implementation-guide)).

---

## 3. Open-Source References

### 3.1 CSMS implementations

| Project | License | Versions | Stack | Maturity / notes |
|---|---|---|---|---|
| **[SteVe](https://github.com/steve-community/steve)** | **GPL-3.0** ⚠️ | OCPP **1.2/1.5/1.6, S (SOAP) + J**, incl. **1.6 Security Extensions (profiles 0–3, cert mgmt, signed firmware)** | Java (JDK 25+), Maven, MySQL/MariaDB | Since 2013 (RWTH Aachen). ~1.1k ★, 486 forks, 3,452 commits. REST API + OpenAPI, Docker/K8s. **No OCPP 2.0.1. No OCPI.** Commercial SaaS "Powerfill" derives from it and holds OCA 1.6 certification. **GPL-3.0 is a serious constraint for a commercial SaaS** — study it, don't embed it |
| **[CitrineOS](https://github.com/citrineos/citrineos-core)** | **Apache-2.0** ✅ | **OCPP 1.6 + 2.0.1** (dynamic AJV schema validation both ways) | TypeScript/Node, Fastify, `ws`, PostgreSQL + PostGIS, RabbitMQ, Redis, S3/GCS/MinIO, Hasura GraphQL, Next.js + Refine UI | **LF Energy project.** **OCA-certified for OCPP 2.0.1 Core + Advanced Security.** v1.9.1 (Apr 2026). ~254 ★, 2,836 commits. Modular via `@AsHandler` / `@AsMessageEndpoint` / `@AsDataEndpoint` decorators. **The best architectural reference for a modern dual-version CSMS**, and the license permits commercial use |
| **[EVerest](https://lfenergy.org/projects/everest/)** | **Apache-2.0** | 1.6, 2.0.1 (OCA-certified), 2.1 in development | C++ | LF Energy. **Charging-station-side stack** (firmware), not a CSMS. Useful as (a) a reference for correct CS behaviour and (b) a test peer. **Note: the standalone `EVerest/libocpp` repo is now archived/read-only** — development moved into the EVerest monorepo |
| **[OpenChargingCloud/CSMS](https://github.com/OpenChargingCloud/CSMS)** | check repo | OCPP | .NET | Smaller; useful reference **[UNVERIFIED maturity]** |

### 3.2 Protocol libraries

| Library | License | Language | Versions | Notes |
|---|---|---|---|---|
| **[mobilityhouse/ocpp](https://github.com/mobilityhouse/ocpp)** | **MIT** (docs CC-BY-ND) | Python | **1.6 (errata v4), 2.0.1 (Ed. 2 & Ed. 3 errata 2024-11)** | v2.1.0 (Jul 2025), 1k+ ★, 30 releases. Message dataclasses + `@on`/`@after` routing. **Does not give you a full CSMS** — no state machine, no persistence, bring your own WS server. Excellent for a simulator |
| **[mikuso/ocpp-rpc](https://github.com/mikuso/ocpp-rpc)** | **MIT** | Node.js | **Bundles schemas for 1.6, 2.0.1, and 2.1** | Client **and** server. Handles subprotocol negotiation, strict schema validation, reconnection, and **security profiles 1/2/3 out of the box**. v2.0 has breaking changes from 1.x. ~132 ★. **If PlugSure is a Node/TypeScript shop, this is the transport layer to start from** |
| **[lorenzodonini/ocpp-go](https://github.com/lorenzodonini/ocpp-go)** | **MIT** | Go | **1.6 + 1.6 Security Extension (full)**, 2.0.1 ("needs more real-world testing") | Central System **and** Charge Point roles. OCPP-J only (no SOAP). Automatic message validation, configurable WS ping-pong (client pings every 54 s default). ~369 ★ |
| **[c-jimenez/open-ocpp](https://github.com/c-jimenez/open-ocpp)** | check repo | C++ | 1.6 + 2.0.1 | Useful if you ever build charger-side firmware |

**Recommendation:** if PlugSure is TypeScript/Node → **`ocpp-rpc` for transport + CitrineOS as the architectural model** (and possibly as a starting fork, given Apache-2.0). If Python → `mobilityhouse/ocpp` + your own Fastify/FastAPI + Postgres. If Go → `ocpp-go`. **Avoid embedding SteVe** (GPL-3.0) in a proprietary SaaS.

### 3.3 OCPP compliance and certification

**The programme** ([OCA certification](https://openchargealliance.org/certification-program/)):
- Three tracks: **OCPP 1.6**, **OCPP 2.0.1**, and **White Label Certification** (for rebadged hardware).
- Five accredited independent test labs: **Dekra, DNV, Korea Smart Grid Association, Korea Testing Certification Institute, Korea Testing Laboratory**.
- You submit a **PICS** (Protocol Implementation Conformance Statement) — separate forms for Charging Station and CSMS — then a lab runs the test plan.

**Certification profiles:**

| OCPP 1.6 | Status |
|---|---|
| **Core** | Mandatory for both CS and CSMS |
| **Smart Charging** | **Mandatory for CSMS**, optional for CS |
| **Advanced Security** | Optional (TLS + client auth) |

| OCPP 2.0.1 | Status |
|---|---|
| **Core** | Mandatory |
| **Advanced Security** | Optional (TLS with client authentication) |
| **Smart Charging** | Optional (all profile types incl. stacking) |
| **ISO 15118 Support** | Optional (15118 smart charging + PnC authorization) |

Programme opened 2023. ([1.6](https://openchargealliance.org/certificationocpp/certification-ocpp-1-6/) · [2.0.1](https://openchargealliance.org/certificationocpp/certification-ocpp-2-0-1/))

> **Note for PlugSure:** if you certify as a CSMS on 1.6, **Smart Charging is mandatory, not optional**. Budget the smart-charging implementation into your v1, not v2.

**OCTT (OCPP Compliance Test Tool)** — [test tool page](https://openchargealliance.org/test-tool/):
- Web-based, cloud-hosted, tests **both** CS and CSMS, for OCPP 1.6 and 2.0.1.
- **Test case counts:** CS — 102 (1.6) + 422 (2.0.1); **CSMS — 76 (1.6) + 254 (2.0.1)**.
- **Pricing (three components, all required):**

| Component | OCA Members | Non-members |
|---|---|---|
| OCPP 1.6 test-case set | €6,000 | €15,000 |
| OCPP 2.0.1 test-case set | €6,000 | €15,000 |
| Instance (one-time) | €2,000 | €4,000 |
| Annual subscription / instance | €1,800 | €2,400 |

- **A 14-day free trial with a limited test-case subset is available** — request via the OCA service portal. **Do this early**; it will surface protocol bugs far faster than field testing.
- OCA also runs **Plugfests** for multi-vendor interoperability testing.

**Budget guidance:** OCA membership pays for itself immediately if you intend to certify (€8k vs €19k for 1.6 alone). Realistic path: OCTT trial → 1.6 Core + Smart Charging CSMS certification → 2.0.1 later.

---

## 4. OCPI / Roaming

**Current version: OCPI 2.3.0.** OCPI **2.2.1 is no longer maintained**. **OCPI 3.0 exists as a draft**, originally targeted mid-2025, with modules intended to stay backward-compatible with 2.3.0 ([EVRoaming Foundation](https://evroaming.org/ocpi/)). Governance: EVRoaming Foundation, OCPI Development Work Group.

**What 2.3.0 added:** EU National Access Point (AFIR) compliance data, **Plug & Charge indication**, vehicle types on locations, multi-tier tax support (North America and elsewhere), and **optional Payment Terminal and Booking modules**.

**Modules that matter for a CPO** ([AMPECO OCPI guide](https://www.ampeco.com/guides/the-complete-ocpi-guide/)):

| Module | CPO role | Purpose |
|---|---|---|
| **Credentials** | both | Token exchange and registration handshake between platforms. Mandatory |
| **Versions** | both | Version negotiation and endpoint discovery. Mandatory |
| **Locations** | **Sender** | Publish sites, EVSEs, connectors, capabilities, real-time availability |
| **Tariffs** | **Sender** | Publish pricing so the eMSP can show the driver the cost |
| **Sessions** | **Sender** | Live session data (energy, power, status) |
| **CDRs** | **Sender** | Charge Detail Records — the billable, settleable record |
| **Tokens** | **Receiver** | Receive eMSP tokens (RFID/app) and authorise them. Supports real-time authorization requests |
| **Commands** | **Receiver** | `START_SESSION`, `STOP_SESSION`, `RESERVE_NOW`, `CANCEL_RESERVATION`, `UNLOCK_CONNECTOR` from the eMSP |
| **ChargingProfiles** | **Receiver** | Smart-charging instructions from an external party |
| **HubClientInfo** | both | Connection status of peers behind a roaming hub |

Topology: direct **peer-to-peer** (bilateral) or via a **roaming hub** (one connection, many peers, hub takes a fee). OCPI 2.2+ supports a platform holding **multiple roles** (CPO **and** eMSP) rather than one.

### Does OCPI matter for Indonesia?

**Short answer: not yet operationally, but yes architecturally.**

- **[UNVERIFIED]** I found **no evidence of an OCPI roaming hub, a clearing house, or bilateral OCPI agreements operating in Indonesia** as of Aug 2026. Regional OCPI activity is concentrated in Europe, with growing NA and some SEA (Singapore/Thailand) interest.
- **What actually matters in Indonesia today is PLN.** Under the PLN-integrated SPKLU model, **PLN Mobile is the mandatory driver app** ([Pingalax developer guide](https://pingalax.id/developer-guide-ev-charging-infrastructure/)). That is a *de facto* roaming requirement, but it will almost certainly be satisfied by a **PLN-proprietary API, not OCPI**. **Action: get PLN's SPKLU integration spec early — it is likely the single biggest external-interface risk in the project.**
- **Why build OCPI anyway:**
  1. It is the cleanest available **internal boundary** between your CPO core and any external consumer. If you model Locations/Sessions/CDRs/Tariffs/Tokens/Commands as an OCPI-shaped internal contract, the PLN adapter, a future partner app, and a future real roaming peer are all just adapters.
  2. It future-proofs against a regional hub emerging (Singapore/Thailand/Malaysia interconnect is plausible within the horizon of this platform).
  3. The OCPI **Tariffs** object is a well-designed, battle-tested tariff data model. Even if you never federate, **steal it for your internal tariff engine** rather than inventing one.
- **Priority: build OCPI 2.3.0 CPO-side in phase 2–3, not phase 1.** Phase 1 should be a PLN/partner adapter behind an OCPI-shaped internal interface.

---

## 5. Reference Platform Feature Sets — Benchmark

### 5.1 On "Ampon.io"

**`ampon.io` does exist** and brands itself **"AmpOn — Smart EV Charging Software for Every Scale."** However, the site is a JavaScript-rendered SPA and returned only metadata to fetching — **I could not extract its feature set, company details, OCPP support, or pricing. [UNVERIFIED]**. There are also two similarly-named platforms you may be conflating: **AmpUp** (`ampup.io`, US, fleet/workplace focus) and **Ampcontrol** (`ampcontrol.io`, US, OCPP smart-charging/optimisation). **AMPECO** (`ampeco.com`, Bulgaria/global) is the large white-label CSMS vendor and is almost certainly the intended reference.

### 5.2 AMPECO — module inventory

From [ampeco.com](https://www.ampeco.com/):

- **Operations & maintenance:** remote maintenance, firmware updates, automated alerts, **auto-recovery algorithms**, "CoOperator" AI ops agent
- **Driver & user management:** EV driver accounts, vehicle profiles, **Plug & Charge**, **Autocharge**
- **Driver interfaces:** white-label mobile app, web portal, ad-hoc (no-app) charging
- **B2B partner management:** multi-partner, **sub-operator** hierarchies
- **Payments & billing:** tariff and plan management, B2C payments, receipts and invoicing, **tax and fiscalisation compliance**, physical payment terminals
- **Roaming:** roaming hub connections, OCPI
- **Energy management:** smart charging, **Dynamic Load Management (DLM)**, flexibility services, electricity-meter integration, **V2G**
- **Security & compliance:** information-security architecture, data protection, **multi-tenant isolation**
- **Developer tools:** RESTful API, **50+ marketplace integrations**, custom dashboards
- **Hardware:** **180+ charger manufacturers** supported, payment terminals, electricity meters

### 5.3 Monta — module inventory

From [monta.com](https://monta.com/):

- **CPMS:** **900+ hardware models from 250+ brands**, OCPP-native, remote diagnostics, automated fault resolution
- **Driver app (Monta Charge):** in-app, **App Clip**, terminal, RFID; driver membership and group management
- **Hardware portal:** firmware management, hardware compatibility tracking, station/team/equipment administration
- **Billing & invoicing:** automated payments, **real-time session settlement**, **EMI-licensed** payment handling, VAT compliance across 30+ markets
- **Revenue sharing:** split billing, roaming fee management, **dynamic / location-based / per-group tariffs**
- **Subscriptions:** memberships and loyalty
- **eMSP / roaming:** **100+ direct OCPI integrations**, access to 1M+ charge points, bilateral agreement management
- **White-label:** full platform rebranding, custom driver app
- **Energy:** smart charging, automatic load balancing, **grid-price-responsive scheduling**, grid services / balancing-market participation
- **Developer platform:** **REST API with 150+ endpoints**, **webhooks on all objects**, data-warehouse integration, SSO
- **AI:** session analyzer (3M+ sessions/mo), automated driver support (claims 83 % of support calls), smart diagnostics, natural-language dashboard builder

### 5.4 Consolidated CSMS feature benchmark for PlugSure

| # | Module | Must-have capabilities | Indonesia-specific notes |
|---|---|---|---|
| 1 | **Tenant / org management** | Multi-tenant isolation, sub-operators/resellers, role-based access (owner, operator, site host, technician, finance, support), audit log | Essential if PlugSure sells to multiple SPKLU operators and to PLN partners under one platform |
| 2 | **Site / location hierarchy** | Organisation → Site → Charge Point → EVSE → Connector. Geo, opening hours, access rules, images, amenities, **grid connection capacity per site** | Site power capacity is the anchor for load management; model it explicitly |
| 3 | **Tariff engine** | Per-kWh, per-minute, session/flagfall fee, idle/overstay fee, time-of-use windows, tiered/stepped rates, per-group and per-token pricing, currency, tax/VAT (**PPN 11 %**), rounding rules, minimum charge, **effective-dated tariff versions** | **Regulated ceilings apply.** PLN energy tariff quoted at **Rp 2,466.78/kWh**, with service charge for fast charging **capped at Rp 25,000/session** and ultra-fast at **Rp 933.22/kWh** — per Permen ESDM 1/2023 ([Pingalax](https://pingalax.id/developer-guide-ev-charging-infrastructure/), **secondary source — verify against the regulation text**). Your tariff engine needs a **hard regulatory cap layer** above operator pricing |
| 4 | **Billing & invoicing** | Wallet/prepaid balance, post-paid, pre-authorisation and capture, refunds, receipts, tax invoices, revenue share / split payouts to site hosts, settlement reports, dunning | **QRIS is table stakes in Indonesia.** Also GoPay/OVO/DANA/ShopeePay e-wallets, Virtual Account bank transfer, and card. Prepaid wallet is the dominant local pattern. **e-Faktur** tax-invoice compliance for B2B |
| 5 | **Roaming** | OCPI 2.3.0 CPO role (Locations, Tariffs, Sessions, CDRs, Tokens, Commands), peer + hub, CDR reconciliation | Phase 2–3. **Phase 1 = PLN SPKLU adapter behind an OCPI-shaped internal interface** |
| 6 | **Driver app** | Map + filtering, real-time availability, remote start/stop, session live view, payment, history and receipts, favourites, **QR-code scan-to-start**, notifications, vehicle profile | **QR scan-to-charge is the highest-value flow in Indonesia** (no app install friction, pairs with QRIS). Bahasa Indonesia localisation. Design for low-end Android and poor connectivity |
| 7 | **RFID / token management** | Token CRUD, assign to driver/group/fleet, whitelist/blacklist, **local auth list sync** (`SendLocalList`/`GetLocalListVersion`), authorization cache, offline authorisation policy, Autocharge (EVCCID) tokens, future eMAID/PnC tokens | Autel readers support ISO 15693 / 14443 / NFC 18092. **Offline auth is critical** given Indonesian connectivity — invest in the local-list sync path |
| 8 | **Smart charging & load management** | Site power budget, per-connector allocation, `SetChargingProfile` generation with correct purpose/stack level, ToU/price-driven scheduling, solar/BESS integration, fallback-safe behaviour when WAN drops | Combine CSMS-level shaping with charger-local RS485 CT-clamp DLB. **PLN capacity upgrade cost is a real constraint** — load management is a commercial selling point, not a nice-to-have |
| 9 | **Reporting / analytics** | Uptime and availability (define your SLA metric carefully), session volume, energy delivered, revenue, utilisation heatmaps by site/time, fault frequency by model/firmware, driver cohort analysis, exportable + data-warehouse feed | Regulatory reporting to ESDM/PLN will likely be required — design exports early |
| 10 | **Remote diagnostics** | Live connector state, `TriggerMessage`-based refresh, `GetDiagnostics`/`GetLog`, raw OCPP message log per charger (**invaluable**), remote reset, `UnlockConnector`, connectivity history | The raw OCPP frame log is your single best support tool. Retain it |
| 11 | **Firmware OTA** | `UpdateFirmware`/`SignedUpdateFirmware`, `FirmwareStatusNotification` tracking, staged rollout, per-model/firmware inventory, rollback plan | **Verify whether Autel accepts OCPP-driven firmware updates from a third-party CSMS — [UNVERIFIED] and a key acceptance test** |
| 12 | **Alerting** | Rule-based (offline > N min, faulted, session failure rate, energy anomaly, meter drift), routing to email/SMS/WhatsApp/webhook, escalation, on-call, auto-recovery actions | **WhatsApp is the dominant ops channel in Indonesia** — integrate it, not just email |
| 13 | **Open API / webhooks** | REST API covering every domain object, webhooks on every state change, OAuth2/API keys, rate limits, versioning, OpenAPI spec, sandbox | Benchmark: Monta 150+ endpoints + webhooks on all objects |
| 14 | **White-labelling** | Branded operator portal, branded driver app, custom domain, theming, branded receipts and emails, per-tenant terms | Directly relevant if PlugSure sells the platform to multiple Indonesian operators |
| 15 | **(Bonus) Fleet / depot** | Vehicle roster, driver-to-vehicle assignment, depot scheduling, reimbursement, cost centres | Strong fit for Indonesian logistics, ride-hailing (Gojek/Grab), and **two/three-wheeler** fleets |
| 16 | **(Bonus) Battery swap** | Swap-station sessions, battery inventory, SoH tracking | **OCPP 2.1 Block S.** Uniquely relevant given Indonesia's motorcycle market — a genuine differentiator |

---

## 6. Key Risks and Recommended Next Actions

1. **[HIGH] Autel third-party OCPP may be one-way.** Documented evidence that enabling third-party OCPP permanently disables Autostart and that Autel support cannot revert it. **Action:** obtain written confirmation from Autel APAC, and bench-test on a sacrificial unit before any fleet commitment.
2. **[HIGH] No confirmed Autel presence in Indonesia.** **Action:** identify the distributor, RMA path, and SNI/import certification status before specifying Autel.
3. **[HIGH] PLN SPKLU integration spec is unknown and is likely mandatory.** **Action:** obtain PLN's integration documentation early; it will shape your session, tariff, and token models more than OCPI will.
4. **[MED] "Plug & Charge ready" on Autel is ambiguous.** Confirm whether it is true ISO 15118-2 PnC or Autocharge. **Ship Autocharge for Indonesia regardless.**
5. **[MED] Regulatory tariff caps** (Permen ESDM 1/2023) must be enforced in the tariff engine as a hard constraint layer. **Action:** verify the current figures against the regulation text, not secondary sources — the numbers I found are from an industry blog.
6. **[MED] Certifying as a 1.6 CSMS makes Smart Charging mandatory.** Scope it into v1.
7. **[LOW] Start the OCTT 14-day free trial now** — it costs nothing and will find protocol bugs faster than field deployment.
8. **Architecture decision to lock in early:** 2.0.1-shaped canonical domain model, version adapters below it, per-vendor quirk registry keyed on `BootNotification`, OCPI-shaped internal boundary for all external consumers. This one decision determines whether adding vendor #2 and protocol version #2 costs a sprint or a rewrite.

---

## Sources

**Autel hardware & OCPP configuration**
- [Autel Energy global product catalogue](https://autelenergy.com/global/product/all) · [DC HiPower](https://www.autelenergy.com/global/product/dc-hipower) · [DC Fast](https://autelenergy.com/global/product/dc-fast) · [DC Compact](https://autelenergy.com/global/product/dc-compact) · [AC Compact](https://autelenergy.com/global/product/ac-compact) · [AC Ultra (US)](https://autelenergy.us/pages/maxicharger-ac-ultra)
- [MaxiCharger AC Wallbox EU datasheet (MID)](https://wallboxcenter.de/wp-content/uploads/2026/06/Autel-Maxi-Charger-22-MID-BK_Datenblatt.pdf) · [Sevadis AC Wall-Mounted datasheet](https://sevadis.com/wp-content/uploads/2024/05/Sevadis-MaxiCharger-AC-Wall-Mounted-Datasheet-LR.pdf) · [Sevadis DC Compact 40–47 kW datasheet](https://sevadis.com/wp-content/uploads/2024/07/MaxiCharger-DC-Compact-40-47kW-Datasheet.pdf) · [MaxiCharger DH480 datasheet](https://www.elfor.org/wp-content/uploads/2024/09/MaxiCharger-DH480_camion.pdf) · [Sevadis Dynamic Load Balancing explained](https://sevadis.com/wp-content/uploads/2024/03/Sevadis-Dynamic-Balancing-Document.pdf) · [Sevadis software configuration guide](https://sevadis.com/wp-content/uploads/2023/10/Updated-Sevadis-MaxiCharger-Software-Configuration-Step-by-Step-Guide.pdf)
- [Clenergy EV — Autel/Sevadis onboarding guide (OCPP field names)](https://partners.clenergy-ev.com/hubfs/Onboarding%20Guides%20(PDF)/Autel%20Sevadis%20Maxicharger%20-%20Onboarding%20Guide%20(New%20branding).pdf?hsLang=en) · [ChargeLab Autel configuration guide](https://chargelab.zendesk.com/hc/en-us/articles/42340494306203-Autel-AC-Lite-Maxi-Charge-Configuration-Guide) · [Autel Config app (iOS)](https://apps.apple.com/us/app/autel-config/id1607007731)
- [ZDI — Attack surface of the Autel MaxiCharger, part two](https://www.thezdi.com/blog/2025/1/15/reviewing-the-attack-surface-of-the-autel-maxicharger-part-two) · [Issue #1955 — enabling OCPP disables Autostart irreversibly](https://github.com/lbbrhzn/ocpp/issues/1955) · [Discussion #669 — Autel OCPP quirks](https://github.com/lbbrhzn/ocpp/discussions/669) · [Issue #1523](https://github.com/lbbrhzn/ocpp/issues/1523) · [evcc discussion #9572](https://github.com/evcc-io/evcc/discussions/9572)
- [Autel CSMS achieves OCPP 2.0.1 certification](https://secure.businesswire.com/news/home/20240607053291/en/Autel-Energys-Charging-Station-Management-System-CSMS-Achieves-OCPP-2.0.1-Certification-Advancing-EV-Charging-Interoperability-and-Security) · [Autel Charge Cloud store page (US/Canada only)](https://store.autelenergy.com/products/autel-charge-cloud) · [AC Ultra Europe launch](https://www.businesswire.com/news/home/20230806813972/en/Autel-Energy-launches-MaxiCharger-AC-Ultra-worlds-most-powerful-AC-charger-for-European-markets) · [Asia/Australia expansion](https://www.businesswire.com/news/home/20230308005943/en/Autel-Expands-Its-Presence-in-Asia-and-Australia-Markets-With-a-Complete-Line-of-EV-Charging-Solutions) · [Singapore rollout](https://www.businesswire.com/news/home/20230413005600/en/Autel-Energy-Rolling-Out-EV-Charging-Stations-in-Singapore-Accelerating-Sustainable-Development-Across-Southeast-Asia) · [Thailand 2026](https://www.thaipr.net/en/energy_en/3688601)

**OCPP protocol**
- [ocpp.md — OCPP 1.6J reference](https://ocpp.md/ocpp-1.6j/) · [1.6J smart charging deep-dive](https://ocpp.md/ocpp-1.6j/smart-charging/) · [OCPP 2.0.1 reference](https://ocpp.md/ocpp-2.0.1/) · [OCPP 2.1 migration guide](https://ocpp.md/ocpp-2.1/)
- [OCA — What is new in OCPP 2.0.1 (PDF)](https://openchargealliance.org/wp-content/uploads/2024/01/new_in_ocpp_201-v10.pdf) · [OCA — Using ISO 15118 Plug & Charge with OCPP 1.6 (PDF)](https://openchargealliance.org/wp-content/uploads/2023/11/ocpp_1_6_ISO_15118_v10.pdf) · [OCPP 1.6 spec (mirror)](https://downloads.regulations.gov/FHWA-2022-0008-0403/attachment_6.pdf) · [OCPP 1.6 errata v4 (mirror)](https://downloads.regulations.gov/FHWA-2022-0008-0403/attachment_5.pdf) · [OCPP 2.0.1 Part 4 JSON-over-WebSockets (mirror)](https://downloads.regulations.gov/FHWA-2022-0008-0404/attachment_1.pdf)
- [OCA — OCPP 2.1 is now available](https://openchargealliance.org/ocpp-2-1-is-now-available/) · [OCA — New editions of OCPP 2.1 and 2.0.1 (Dec 2025)](https://openchargealliance.org/new-editions-of-the-ocpp-2-1-and-2-0-1-now-available/) · [OCA certification programme](https://openchargealliance.org/certification-program/) · [OCPP 1.6 certification](https://openchargealliance.org/certificationocpp/certification-ocpp-1-6/) · [OCPP 2.0.1 certification](https://openchargealliance.org/certificationocpp/certification-ocpp-2-0-1/) · [OCTT test tool & pricing](https://openchargealliance.org/test-tool/)
- [amina — OCPP security profiles explained](https://aminacharging.com/articles/ocpp-security-profiles/) · [CoreEVI — OCPP basic auth & SecurityProfile](https://coreevi.com/a/2/ocpp-basic-auth-securityprofile) · [OCPPLab — CSMS implementation guide](https://www.ocpplab.com/blog/ocpp-implementation-guide) · [AMPECO OCPP handbook 2026](https://www.ampeco.com/guides/complete-ocpp-guide/) · [ChargeLab — 1.6 vs 2.0.1](https://chargelab.co/blog/ocpp-1.6-vs-ocpp-2.0.1-key-differences-for-ev-charging-csms-and-charger-firmware) · [Dynamo CSMS protocol docs](https://dynamo-csms.mintlify.app/concepts/ocpp-protocols)

**Open source**
- [SteVe](https://github.com/steve-community/steve) · [CitrineOS core](https://github.com/citrineos/citrineos-core) · [CitrineOS on LF Energy](https://lfenergy.org/projects/citrineos/) · [EVerest on LF Energy](https://lfenergy.org/projects/everest/) · [EVerest/libocpp (archived)](https://github.com/EVerest/libocpp) · [mobilityhouse/ocpp](https://github.com/mobilityhouse/ocpp) · [mikuso/ocpp-rpc](https://github.com/mikuso/ocpp-rpc) · [lorenzodonini/ocpp-go](https://github.com/lorenzodonini/ocpp-go) · [c-jimenez/open-ocpp](https://github.com/c-jimenez/open-ocpp)

**OCPI**
- [EVRoaming Foundation — OCPI](https://evroaming.org/ocpi/) · [OCPI downloads](https://evroaming.org/ocpi-downloads/) · [AMPECO complete OCPI guide 2026](https://www.ampeco.com/guides/the-complete-ocpi-guide/) · [OCPI 2.3.0 repo](https://github.com/ocpi/ocpi/blob/2.3.0/release/core/README.md)

**Indonesia**
- [Pingalax — SPKLU deployment guide: PLN vs independent](https://pingalax.id/developer-guide-ev-charging-infrastructure/) · [Pingalax — What is SPKLU](https://pingalax.id/what-is-spklu/) · [ICCT — Charging Indonesia's vehicle fleet (PDF, Feb 2024)](https://theicct.org/wp-content/uploads/2024/02/ID-88-%E2%80%93-Indonesia-charging_final2.pdf) · [Emerhub — partnering with PLN](https://emerhub.com/indonesia/pln-partnership-to-open-an-ev-charging-station-in-indonesia/) · [SUPRA International — Indonesia EV infrastructure market](https://supra-international.com/insights/charging-ahead-indonesia-s-push-to-dominate-southeast-asia-s-ev-infrastructure-market)

**Reference platforms**
- [AMPECO](https://www.ampeco.com/) · [Monta](https://monta.com/) · [AmpOn](https://ampon.io/) *(content not extractable)* · [AmpUp](https://www.ampup.io/) · [Ampcontrol](https://www.ampcontrol.io/) · [ChargeLab](https://chargelab.co/software) · [S44 — CSMS platform guide](https://www.s44.team/resources/complete-guide-ev-charging-software-platforms)

agentId: af3639ce35d2f9da7 (use SendMessage with to: 'af3639ce35d2f9da7', summary: '<5-10 word recap>' to continue this agent)
<usage>subagent_tokens: 138989
tool_uses: 93
duration_ms: 1255867</usage>