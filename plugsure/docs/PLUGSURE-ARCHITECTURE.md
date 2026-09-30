# PlugSure — Technical Architecture & Product Specification

**EV charging management platform for Indonesia**
Version 0.1 · 23 August 2026 · Prepared for PlugSure (plugsure.com)

---

## 0. How to read this document

Sections 1–3 are the product argument: what PlugSure is, who buys it, and why an Indonesian-specific CSMS beats a generic one. Sections 4–13 are the system design. Section 14 is the build sequence. Section 15 lists the things we could not verify from public sources and that must be closed with counsel, PLN, Kemendag or Autel before the design is frozen.

Facts drawn from research are footnoted with their source in Section 17. Anything marked **[VERIFY]** is a claim we could not confirm from a primary source.

---

## 1. Executive summary

PlugSure is a **multi-tenant Charging Station Management System (CSMS)** for the Indonesian market. It manages OCPP-connected charging hardware — beginning with Autel MaxiCharger AC and DC units — for commercial charge point operators (CPOs), fleet depots, and white-label partners operating under a licence holder's umbrella.

The generic CSMS feature set is commoditised globally. AMPECO, Monta, Driivz and a dozen others already do real-time monitoring, load management, RBAC and OCPP well. **PlugSure's defensible position is the Indonesian compliance and commercial layer that none of them have and no local player has yet productised:**

| Differentiator | Why no international vendor has it |
|---|---|
| `Q × 707` / `N × 1,650` PLN tariff multiplier modelling with versioned, effective-dated bases | PLN tariffs are formula-driven, not a rate table. A hardcoded rate breaks on the next Direksi decision. |
| Per-municipality **PBJT** tax resolution (up to 10%, set per kabupaten/kota) | Indonesia has no single national electricity consumption tax rate. |
| **Tera / tera-ulang** metrology lifecycle per connector, with commercial blocking on lapse | Kemendag classified EVSE as UTTP and launched mandatory verification on 25 May 2026. This compliance burden is three months old and no incumbent tool addresses it. |
| **SPKLU ID** as a first-class structured identifier (`01.POSO.20.3275.010`) — parsed, validated, and used to drive tax geography and tenancy | The ID encodes the legal operating scheme and municipality. It is the natural join key for compliance. |
| **SLO** certificate tracking with expiry alerting | Mandatory before commercial operation; a third certificate regime with a third expiry per site. |
| **Coretax e-Faktur** integration with B2C/B2B session separation | Indonesia-only tax infrastructure with a hard sequencing constraint (no invoice before NSFP returns). |
| **kVA-headroom load management** tied to the `40 × kVA` rekening minimum and the 200 kVA TR/TM cliff | The ROI case for load management in Indonesia is capacity-cost avoidance, not energy-price arbitrage. |
| **TKDN certification** for the software itself | Permenperin 35/2025 brought software into TKDN scope. At TKDN + BMP ≥ 40%, foreign platforms are *legally excluded* from PLN/SOE/government procurement. |

**The strategic prize is TKDN.** PLN is a BUMN and procures through LKPP e-Katalog under P3DN rules. An Indonesian-incorporated company writing software in Indonesia with Indonesian engineers scores highly on a labour-weighted formula. Certification would make PlugSure the only compliant choice in a large class of procurements.

**Market timing is favourable.** Indonesia has ~5,016 SPKLU units against a 2030 government target of 62,918 — roughly 13× growth needed, at ~14,500 units/year versus 2025's actual 4,655. Private CPOs will build most of that gap. BEV sales grew 88.6% year-on-year in Jan–Jul 2026. Home charging is structurally constrained (typical residential connections are 1,300–2,200 VA against a 7 kW charger's ~7,700 VA requirement), which makes Indonesia a **public-charging-first market** — unlike Europe or China.

**Price anchor:** PLN charges **2% of charging revenue** for the app/payment layer in its partnership schemes. That 2% buys app presence and payment only — no load management, no smart charging, no fleet billing, no compliance tooling. The gap between what PLN's 2% delivers and what a CPO actually needs is PlugSure's pricing headroom.

---

## 2. Product scope

### 2.1 Personas and what each needs

| Persona | Primary surface | Core jobs |
|---|---|---|
| **CPO operations engineer** | Operator console | See every charger's live state; diagnose a fault without a site visit; reset/unlock remotely; read the raw OCPP frame log |
| **CPO commercial manager** | Operator console | Set tariffs within regulatory ceilings; see utilisation and revenue by site; manage site-host revenue shares |
| **Site host** (mall, hotel, office) | Limited portal | See their own sites only; see their revenue share; request support |
| **Fleet manager** | Fleet console | Assign vehicles/drivers to tokens; schedule depot charging; allocate cost by cost centre; monthly consolidated invoice |
| **Finance / tax** | Finance module | Reconcile sessions → payments → settlement; issue e-Faktur; track PPh 23 bukti potong |
| **Compliance officer** | Compliance vault | Track SPKLU IDs, SLO, tera certificates and their expiries; export for inspection |
| **Field technician** | Mobile-responsive console | Commission a charger; run the provisioning diff; verify a connector; log a site visit |
| **Driver (registered)** | Mobile web / app | Find a charger; start/stop; see live session; pay; receipts; history |
| **Driver (walk-up)** | Mobile web only, no install | Scan QR → pick amount → pay QRIS → charge |
| **Platform admin (PlugSure)** | Admin console | Onboard tenants; manage the vendor quirk registry; monitor fleet-wide protocol health |

### 2.2 Module inventory and release phasing

| # | Module | v1 (M0–M6) | v2 (M6–M12) | v3 (M12+) |
|---|---|---|---|---|
| 1 | Tenancy, RBAC, audit log | ● | | |
| 2 | Site / asset hierarchy + compliance vault | ● | | |
| 3 | OCPP 1.6J gateway + canonical model | ● | | |
| 4 | Real-time monitoring & remote diagnostics | ● | | |
| 5 | Token & local auth list management | ● | | |
| 6 | Tariff engine (Indonesian layered pricing) | ● | | |
| 7 | Session rating & CDR generation | ● | | |
| 8 | Payments — QRIS pre-purchase (Tier 3) + B2B VA (Tier 4) | ● | | |
| 9 | Smart charging & site load management | ● | | |
| 10 | Operator console (web) | ● | | |
| 11 | Driver mobile web (guest flow) | ● | | |
| 12 | Open REST API + webhooks | ● | | |
| 13 | Alerting (email + WhatsApp) | ● | | |
| 14 | e-Faktur via PJAP | | ● | |
| 15 | Driver accounts + e-wallet tokenisation (Tier 1) + card pre-auth (Tier 2) | | ● | |
| 16 | Firmware OTA management | | ● | |
| 17 | Fleet/depot module | | ● | |
| 18 | Revenue share & automated site-host payouts | | ● | |
| 19 | Reporting & analytics warehouse | | ● | |
| 20 | White-label theming + custom domains | | ● | |
| 21 | OCPP 2.0.1 adapter | | ● | |
| 22 | Native driver app | | | ● |
| 23 | OCPI 2.3.0 CPO role | | | ● |
| 24 | PLN Single Gateway / SPKLU registry integration | | ● | |
| 25 | Battery swap (SPBKLU) sessions — OCPP 2.1 Block S | | | ● |
| 26 | V2G / DER control, BESS & solar integration | | | ● |

---

## 3. Technology stack — recommendation and rationale

**Recommended: TypeScript / Node.js across the board.**

| Layer | Choice | Why |
|---|---|---|
| OCPP gateway | **Node 22 + `ws`**, custom OCPP-J RPC layer, **Ajv** schema validation | OCPP-J is JSON over WebSocket — Node's sweet spot. Thousands of long-lived, low-throughput connections is an I/O-bound workload, not CPU-bound. `mikuso/ocpp-rpc` (MIT) is the alternative if you prefer not to own the transport; **CitrineOS** (Apache-2.0, LF Energy, OCA-certified for 2.0.1) is the architectural reference and a legitimate fork base. |
| API / business services | **Fastify** + **Zod** | Fastest mainstream Node HTTP server; schema-first fits the OpenAPI requirement. |
| Database | **PostgreSQL 16** + **TimescaleDB** hypertables for meter values and OCPP frame logs | One database for OLTP and time series. Timescale compression on the frame log is the difference between retaining 90 days and retaining 2 weeks. PostGIS for site geo. |
| Cache / queue | **Redis** (pub/sub for charger→console fan-out, distributed locks for the smart-charging control loop) | |
| Async work | **BullMQ** on Redis | CDR generation, payment reconciliation, tera-expiry sweeps, firmware rollouts. |
| Dashboard | **React 19 + Vite + TanStack Query**, server-sent events for live state | |
| Driver web | **Next.js** (SSR, low-end Android, first paint matters) | |
| Auth | Phone + OTP (WhatsApp primary, SMS fallback) for drivers; email + TOTP for operators; SSO (OIDC) for enterprise tenants | Phone-first is the Indonesian norm; email-primary login costs conversion. |
| Hosting | **AWS `ap-southeast-3` (Jakarta)** | Latency to chargers; removes data-residency from every enterprise sale; satisfies pass-through obligations from public-sector customers; **may improve TKDN scoring** versus offshore. |
| IaC | Terraform + ECS Fargate (or EKS at scale) | |

**Why not Go or Java:** both are defensible for the OCPP layer specifically. Go's `lorenzodonini/ocpp-go` (MIT) is mature for 1.6 + Security Extension. But splitting the stack across two languages costs more in a small team than it saves in runtime efficiency, and the OCPP workload is not CPU-bound. Revisit if a single gateway node must hold >20,000 concurrent chargers.

**Explicitly avoid:** embedding **SteVe** — it is GPL-3.0 and would infect a proprietary SaaS. Study it; do not link it.

---

## 4. System architecture

### 4.1 Context

```
        ┌──────────────┐   ┌──────────────┐   ┌───────────────┐
        │ Autel & other│   │  Drivers     │   │ CPO / fleet   │
        │ charge points│   │ (web / app)  │   │  operators    │
        └──────┬───────┘   └──────┬───────┘   └──────┬────────┘
      wss:// OCPP-J          HTTPS │                  │ HTTPS
               │                   │                  │
    ═══════════▼═══════════════════▼══════════════════▼═══════════
                        P L U G S U R E   P L A T F O R M
    ═══════════╤═══════════════════╤══════════════════╤═══════════
               │                   │                  │
     ┌─────────▼──────┐  ┌─────────▼────────┐  ┌──────▼─────────┐
     │ Xendit /       │  │ PJAP → Coretax   │  │ PLN Single     │
     │ Midtrans (PJP) │  │ (e-Faktur)       │  │ Gateway [VERIFY]│
     └────────────────┘  └──────────────────┘  └────────────────┘
     ┌────────────────┐  ┌──────────────────┐  ┌────────────────┐
     │ WhatsApp BSP   │  │ Autel firmware   │  │ OCPI peers     │
     │ / SMS          │  │ artefact store   │  │ (v3)           │
     └────────────────┘  └──────────────────┘  └────────────────┘
```

### 4.2 Service decomposition

Start as a **modular monolith** with hard internal module boundaries, plus **one separately deployable service: the OCPP gateway.** The gateway must scale and restart on a different cadence to the API — a deploy of the billing code should never drop 4,000 charger WebSockets.

```
┌───────────────────────────────────────────────────────────────┐
│ ocpp-gateway  (stateless-ish, sticky by chargePointId)        │
│  · WS/WSS termination, subprotocol negotiation                │
│  · OCPP-J RPC framing, one-in-flight-CALL enforcement         │
│  · Ajv schema validation both directions                      │
│  · 1.6J adapter → canonical events   (2.0.1 adapter in v2)    │
│  · Raw frame log → Timescale                                  │
│  · Connection registry in Redis (which node owns which CP)    │
└───────────────┬───────────────────────────────────────────────┘
                │ canonical events (Redis Streams) ▲ commands
┌───────────────▼───────────────────────────────────────────────┐
│ plugsure-core  (Fastify modular monolith)                     │
│  identity · tenancy · assets · tokens · sessions · rating     │
│  tariffs · payments · compliance · smartcharging · alerts     │
│  webhooks · reporting · admin                                 │
└───────────────┬───────────────────────────────────────────────┘
                │
┌───────────────▼───────────────────────────────────────────────┐
│ workers (BullMQ)  cdr · settlement · efaktur · expiry-sweep   │
│                   firmware-rollout · reconciliation           │
└───────────────────────────────────────────────────────────────┘
```

**Why not microservices on day one:** a 6-person team shipping in 6 months does not have the operational budget for 12 services. The module boundaries are what matter; the deployment boundary can follow later. The gateway is split out because its *lifecycle* differs, not because its domain does.

### 4.3 Connection ownership and horizontal scale

Each charge point holds one long-lived WebSocket to one gateway node. To send a command from the API to a charger, the API must reach the node that owns that socket.

- Gateway nodes register `cp:{chargePointId} → node:{nodeId}` in Redis with a TTL refreshed on heartbeat.
- Commands are published to `cmd:{nodeId}` (Redis pub/sub); the owning node picks them up, issues the OCPP CALL, and publishes the CALLRESULT to `cmdres:{correlationId}`.
- The API awaits the correlated result with a timeout (default 30 s; `Reset` and `UpdateFirmware` get longer).
- On node loss the charger reconnects (Autel units retry automatically) and re-registers elsewhere. **Design assumption: any gateway node may die at any time and the only cost is a reconnect.**

---

## 5. Canonical domain model

**The single highest-leverage decision in this design: the canonical model is OCPP 2.0.1-shaped, and the 1.6 adapter maps *up* into it.** Every downstream consumer — rating, smart charging, the console, the API — sees one shape regardless of the protocol version the charger speaks. Adding 2.0.1 then costs an adapter, not a rewrite.

### 5.1 Topology

```
Organisation (tenant)
 └─ Site                       ← grid connection, kVA, tariff geography, SPKLU ID, SLO
     └─ ChargePoint            ← the OCPP endpoint; vendor/model/firmware; security profile
         └─ EVSE (evseId ≥ 1)  ← the independently-startable charging unit
             └─ Connector      ← physical plug; connector type; the *metrological* meter
```

| Concept | OCPP 1.6 | OCPP 2.0.1 | Canonical |
|---|---|---|---|
| Station | ChargeBoxId | ChargingStation | `charge_point` |
| Unit | `connectorId = N` | `evseId = N` | `evse` with `evse_id = N` |
| Plug | (same as connector) | `connectorId` under EVSE | `connector`, `connector_id = 1` for 1.6 |
| Station itself | `connectorId = 0` | `evseId = 0` | `evse_id = 0` sentinel |
| Transaction id | CSMS-assigned **integer** | Station-assigned **string** | **string**, always |

**Rule:** 1.6 `connectorId = N` maps to `(evse_id = N, connector_id = 1)`. This is lossless for every single-plug-per-EVSE unit, which is every Autel AC unit and most DC units. Dual-gun DC units where the guns share a power stack are modelled as one EVSE with two connectors *only if the hardware reports it that way*; otherwise as two EVSEs — the quirk registry records which.

### 5.2 Transaction unification

The 1.6 adapter synthesises the 2.0.1 event shape:

| 1.6 message | Canonical event |
|---|---|
| `StartTransaction` | `TransactionEvent(eventType=Started, triggerReason=Authorized\|CablePluggedIn)` |
| `MeterValues` (with `transactionId`) | `TransactionEvent(eventType=Updated, triggerReason=MeterValuePeriodic)` |
| `StatusNotification` during a transaction | `TransactionEvent(eventType=Updated, triggerReason=ChargingStateChanged)` |
| `StopTransaction` | `TransactionEvent(eventType=Ended, triggerReason=<mapped from reason>)` |

The rating engine, the console live view, the webhook emitter and the OCPI adapter all consume `TransactionEvent` only. None of them contains a `if (version === '1.6')` branch.

### 5.3 Core entities

```
organisation      id, name, npwp, pkp_status, iuptlu_number, licence_scheme, parent_org_id
user              id, org_id, phone, email, name, status, mfa_secret
role              id, org_id (null = system role), name, permissions[]
user_role         user_id, role_id, scope_type (org|site|fleet), scope_id
site              id, org_id, name, address, kabupaten_kota_code, geo,
                  grid_tariff_group (C/TR, C/TM, L/TR…), connected_kva, phases,
                  spklu_id, spklu_scheme, slo_number, slo_expiry, pbjt_rate_bps
charge_point      id, site_id, ocpp_identity, vendor, model, firmware, serial,
                  ocpp_version, security_profile, auth_key_hash, last_seen_at,
                  status, quirk_profile_id
evse              id, charge_point_id, evse_id, max_power_w
connector         id, evse_id, connector_id, connector_type, max_power_w, phases,
                  meter_serial, meter_accuracy_class, tera_type_approval_no,
                  tera_last_at, tera_due_at, tera_status
token             id, org_id, kind (rfid|app|autocharge|emaid), uid, driver_id,
                  fleet_id, status, valid_from, valid_to, offline_allowed
driver            id, org_id, phone, name, email, npwp, default_payment_method_id
charging_session  id, org_id, site_id, connector_id, ocpp_transaction_id,
                  token_id, driver_id, started_at, ended_at, stop_reason,
                  meter_start_wh, meter_stop_wh, energy_wh, duration_s,
                  state, tariff_version_id, cdr_id, payment_intent_id
meter_value       session_id, ts, measurand, phase, value, unit   (hypertable)
ocpp_frame        charge_point_id, ts, direction, message_type, action,
                  unique_id, payload                              (hypertable)
tariff            id, org_id, name, currency, active_from, active_to
tariff_component  tariff_id, kind (energy|time|session|idle|admin), rate,
                  unit, applies_from_s, applies_from_kwh, tou_block (WBP|LWBP|ANY),
                  day_mask, time_from, time_to
cdr               id, session_id, issued_at, lines[], subtotal, pbjt, ppn_dpp,
                  ppn_amount, total, tariff_snapshot (jsonb)
payment_intent    id, session_id|invoice_id, provider, provider_ref, method,
                  mode (prepurchase|tokenized|preauth|postpaid), amount_authorised,
                  amount_captured, state, raw_events (jsonb)
invoice           id, org_id, customer_org_id, period, lines[], total,
                  efaktur_nsfp, efaktur_status, va_number
charging_profile  id, connector_id|charge_point_id, purpose, stack_level, kind,
                  schedule (jsonb), valid_from, valid_to, ocpp_profile_id, state
site_power_budget site_id, ceiling_kw, reserve_kw, source (static|meter|genset),
                  strategy, updated_at
audit_log         id, org_id, actor_user_id, actor_type, action, target_type,
                  target_id, before (jsonb), after (jsonb), ip, user_agent, ts
quirk_profile     id, vendor, model, firmware_pattern, findings (jsonb)
webhook_endpoint  id, org_id, url, secret, events[], state
```

---

## 6. OCPP layer design

### 6.1 Transport

- Subprotocol negotiated from `Sec-WebSocket-Protocol`, preferring `ocpp2.1` > `ocpp2.0.1` > `ocpp1.6`. Echo exactly one.
- Also accept a version-in-path form (`/ocpp/1.6/{id}`) as a fallback for chargers with broken negotiation, but **header negotiation is authoritative**. Record the negotiated version on the connection.
- URL shape: `wss://ocpp.plugsure.com:443/ocpp/{chargePointId}`. **The charge point ID is the last path segment and PlugSure does not get to choose it** — Autel's config app defaults to the unit's serial number when `Chargebox Identity` is left blank, and installers routinely leave it blank. Accept long alphanumeric identities.
- **One outstanding CALL per direction.** This is the single most common implementation error. Queue outbound CALLs per connection; do not pipeline.
- `Heartbeat.conf` must return `currentTime`. Chargers set their clock from it, and skipping it silently corrupts billing timestamps.

### 6.2 Security

| Profile | Transport | CS auth | Use |
|---|---|---|---|
| 0 | `ws://` | none | Bench only. Never in production. |
| 1 | `ws://` | HTTP Basic | Never internet-facing. |
| **2** | `wss://` | HTTP Basic (`chargePointId` : `AuthorizationKey`) | **Production baseline.** Mandated by the updated OCPP 1.6 certification programme. |
| 3 | mutual TLS | client certificate | Target for high-value DC sites, v2. |

`AuthorizationKey` must be randomly generated, 16–20 bytes, hex-encoded, and **WriteOnly** — never returned in a `GetConfiguration` response. PlugSure stores only a hash plus an encrypted copy in a KMS-backed secret, never plaintext in the primary DB.

**Rotation order matters and getting it wrong bricks the charger:** set `AuthorizationKey` *first*, then raise `SecurityProfile`. Accept both old and new keys for a grace window (default 24 h) and handle the charger reconnecting with the new credential on the very next connect.

### 6.3 Provisioning routine

On every `BootNotification`:

1. Resolve or create the `charge_point` by OCPP identity. If unknown, park it in a **pending-adoption** queue rather than rejecting — a rejected charger retries forever and the installer has no feedback loop.
2. Look up `quirk_profile` by `(chargePointVendor, chargePointModel, firmwareVersion)`.
3. `GetConfiguration` with no keys (dumps all) → diff against desired state.
4. `ChangeConfiguration` per differing key. **Record every `Rejected` / `NotSupported` into the quirk profile and continue.** Autel units are documented to reject `MeterValuesSampledData=Energy.Active.Import.Register`; treating that as a fatal provisioning error would strand the fleet.
5. `TriggerMessage(StatusNotification)` per connector to establish initial state.
6. Sync the local auth list (`GetLocalListVersion` → `SendLocalList` if stale).

Desired configuration baseline:

| Key | Value | Rationale |
|---|---|---|
| `HeartbeatInterval` | `300` | 5 min. Balance liveness against 4G data cost. |
| `MeterValueSampleInterval` | `60` | 1-minute granularity for live session display and load control. |
| `MeterValuesSampledData` | `Energy.Active.Import.Register,Power.Active.Import,Current.Import,Voltage,SoC` | Degrade gracefully — most units reject some measurands. |
| `StopTxnSampledData` | `Energy.Active.Import.Register` | `StopTransaction.transactionData` is often where the authoritative total lives. |
| `ClockAlignedDataInterval` | `900` | Aligns with the WBP/LWBP boundary logic. |
| `WebSocketPingInterval` | `60` | Detect dead 4G sockets before the driver does. |
| `LocalAuthListEnabled` | `true` | **Non-negotiable in Indonesia.** 4G backhaul drops. |
| `LocalAuthorizeOffline` | `true` | |
| `AllowOfflineTxForUnknownId` | `false` | Prevents free electricity during an outage. Revisit per tenant. |
| `StopTransactionOnInvalidId` | `true` | |
| `TransactionMessageAttempts` | `10` | Store-and-forward depth for queued transaction messages. |
| `TransactionMessageRetryInterval` | `30` | |
| `ConnectionTimeOut` | `120` | |

### 6.4 The vendor quirk registry — build this on day one

Keyed on `(vendor, model, firmware_version_pattern)`, storing empirically discovered facts:

```jsonc
{
  "vendor": "Autel", "model": "MaxiCharger AC Wallbox", "firmware": "^V1\\.4\\.",
  "rejectedConfigKeys": ["MeterValuesSampledData"],
  "emittedMeasurands": ["Energy.Active.Import.Register", "Power.Active.Import"],
  "chargingRateUnit": "A",                  // AC wants amps; DC wants watts
  "compositeScheduleTrustworthy": false,
  "txDefaultProfileOnConnector0Propagates": true,
  "acceptsRemoteFirmwareUpdate": null,      // [VERIFY] — key acceptance test
  "maxLocalAuthListEntries": 1000,
  "notes": "Rejects Energy.Active.Import.Register in MeterValuesSampledData; falls back to charger default."
}
```

This registry is what makes multi-vendor support cost a sprint instead of a rewrite. Populate it from the frame log automatically where possible.

### 6.5 Autel-specific onboarding and known risks

**Configuration path.** Autel chargers are pointed at a third-party backend via the **`Autel Config`** installer app over Bluetooth LE. The form fields are `Security Profile` (e.g. `WSS`), `Server IP/Domain`, `Server Path`, `Server Port`, `Chargebox Identity` (blank = use serial), plus APN settings on 4G units. The endpoint assembles as `wss://<domain>:<port><path><chargeBoxId>`.

`Autel Config` **has no public registration** — installers must be enrolled as Autel partners. Budget for this in procurement. The consumer `Autel Charge` app exposes an OCPP server list on some builds, but it is often a pre-provisioned whitelist of partner backends rather than a free-text field. **Do not plan on that path**; separately, ask Autel whether PlugSure can be added to that in-app list — if granted it is a real distribution advantage.

**Risks that must be closed before any fleet commitment:**

| # | Risk | Severity | Action |
|---|---|---|---|
| 1 | Enabling third-party OCPP may be **irreversible** and permanently disables Autostart. Autel support is documented as saying *"Once your charger takes the 3rd party OCPP configuration there is no way for us to make changes to it."* Confirmed on a US AC unit; **[VERIFY]** for EU/global DC SKUs. | **HIGH** | Get written confirmation from Autel APAC that the endpoint can be re-pointed in the field. Bench-test on a sacrificial unit first. |
| 2 | **No confirmed Autel presence in Indonesia** — no public evidence of a local office, distributor, or SNI/import certification. | **HIGH** | Identify the distributor, RMA path and certification status before specifying Autel. |
| 3 | `SetChargingProfile` current control is firmware-sensitive; some builds accept the profile but do not change current. | **MED** | Validate acceptance *and actual current response* per firmware build as an acceptance test. |
| 4 | OCPP 2.0.1 support is model- and firmware-dependent. Only **DH480** is documented as "1.6J & 2.0.1"; **DC Compact** says "upgradeable"; the **EU AC Wallbox datasheet says 1.6J only**. | **MED** | **Treat 1.6J as the contractual baseline** for any Autel AC fleet. |
| 5 | Whether OCPP `UpdateFirmware` from a third-party CSMS works at all. **[VERIFY]** | **MED** | Key acceptance test before promising OTA. |
| 6 | "Plug & Charge ready" is ambiguous — true ISO 15118-2 PnC with contract certificates, or Autocharge (EVCCID/MAC)? **[VERIFY]** | **MED** | Ship **Autocharge** for Indonesia regardless; PnC requires an eMAID PKI that does not meaningfully exist here. Model eMAID as just another token type so it can be added later. |
| 7 | Firmware was observed downloading over plain **HTTP** before switching to HTTPS after reboot. | **MED** | Security-relevant for a regulated deployment; raise with Autel. |
| 8 | No published Autel `DataTransfer` vendor extension catalogue. | **LOW** | **Never reject an unknown `DataTransfer`** — respond `UnknownVendorId`/`UnknownMessageId`, log the frame, and mine the logs. That is how the extensions get discovered. |

**Architectural instruction:** treat Autel's **local dynamic load balancing** (external meter + CT clamps over Modbus RS485, plus master/secondary coordination between units — documented limit **8 chargers per meter**) as the *safety net that guarantees the incoming breaker*, and layer OCPP `SetChargingProfile` on top for tariff- and grid-driven shaping. **Never build the site power budget on the assumption that OCPP smart charging alone protects the breaker** — the RS485 path works when the WAN is down, and in Indonesia the WAN will be down.

### 6.6 Offline tolerance — a first-class requirement, not a nice-to-have

Indonesian sites are predominantly 4G-backhauled with poor fixed-line reliability. The platform must assume disconnection is normal:

- Chargers queue `StartTransaction` / `StopTransaction` / `MeterValues` while offline and replay them on reconnect, often **out of order and with stale timestamps**.
- **Bill on the charger's timestamps, not on receipt time.**
- Key sessions on `(chargePointId, connectorId, chargerLocalTxRef, startTimestamp)` and make CDR generation **idempotent**.
- Keep the local auth list synced aggressively so offline authorisation continues to work.
- Surface "last seen" and an explicit connectivity timeline per charger in the console — a charger that is offline is not necessarily faulted, and support must be able to tell the difference at a glance.

---

## 7. Tariff and rating engine

### 7.1 The Indonesian pricing stack

A single retail session can carry five layers. **The engine must be composable, not a flat rate:**

```
1. Energy        kWh × rate          rate may be regulated: N × 1,650 (0.8 ≤ Q ≤ 3 for bulk; 1 ≤ N ≤ 1.5)
2. Service fee   per session         ceiling: Rp 25,000 fast (>22–50 kW), Rp 57,000 ultrafast (>50 kW)
3. Admin fee     operator discretion e.g. Rp 4,000
4. PBJT          up to 10%           set per kabupaten/kota by perda — VARIES BY MUNICIPALITY
5. PPN           12% on DPP = 11/12 × price → 11% effective
```

**Do not hardcode any of these.** Model:

- **`tariff_base`** — a versioned, effective-dated table of regulatory bases (`707` for curah, `1,650` for layanan khusus). These are subject to quarterly tariff adjustment; the Q3 2026 L tariff published at **Rp 1,645**, not 1,650.
- **`multiplier`** — `Q` (bulk, 0.8–3.0) or `N` (special service, 1.0–1.5), a per-tenant, per-site configurable. The widely-quoted Rp 2,466–2,475/kWh retail price is simply `N = 1.5`.
- **`regulatory_ceiling`** — a hard constraint layer *above* operator pricing. A tariff that would exceed the ceiling for its charging class is rejected at save time, not at billing time.
- **Charging class** derived from connector `max_power_w`: slow ≤ 7 kW, medium >7–22 kW, fast >22–50 kW, ultrafast >50 kW. This drives which ceiling applies.

### 7.2 Time-of-use — build it now even though it is currently flat

WBP (peak) and LWBP (off-peak) blocks are structurally present in the SPKLU tariff schedules, but the current lampiran prices both blocks the same. PLN already applies WBP/LWBP differentials to industrial categories, and it runs a 30% night discount (22:00–05:00) on *home* charging — clear policy appetite for temporal signals.

**Model WBP/LWBP as a first-class dimension in `tariff_component` from v1.** Retrofitting time-of-use into a flat-rate engine is expensive; anticipating it is nearly free.

### 7.3 Tax resolution

- **PBJT is per-municipality.** A CPO operating in Jakarta, Bandung, Surabaya and Bali faces four potentially different rates. Resolve it from the site's `kabupaten_kota_code` — which the SPKLU ID already encodes (`…3275…` = Kota Bekasi). Store the resolved rate **on the CDR**, not derived at report time.
- **PPN arithmetic must follow the regulation exactly:** `DPP = 11/12 × price`, then `PPN = 12% × DPP`. Applying 11% directly gives the right total but the **wrong DPP on the faktur pajak**, which fails an audit. Electricity is VAT-exempt only for household customers at or below 6,600 VA — an SPKLU connection is far above that, so both PLN's supply to the CPO and the CPO's sale to the driver are VATable.
- **Every tax field is stored per transaction, not derived at report time.** Rates change; historical invoices must remain reproducible exactly as issued.

### 7.4 Rating pipeline

```
TransactionEvent(Ended)
   → resolve tariff version effective at session start (never "current")
   → apply components in order, respecting ToU blocks and stepped thresholds
   → apply regulatory ceiling check (log a compliance warning if the tariff would have exceeded it)
   → resolve PBJT from site municipality
   → compute DPP and PPN
   → freeze a tariff_snapshot on the CDR
   → emit cdr.created  → payment capture / invoice accrual / webhook / OCPI CDR (v3)
```

**The legal meter wins.** Where the OCPP `MeterValues` stream and the metrologically verified meter register diverge, bill from the verified register. `StopTransaction.transactionData` typically carries the authoritative total; prefer it over the last periodic sample.

---

## 8. Smart charging and load management

### 8.1 Why it sells in Indonesia

The ROI argument here is **not** energy-price arbitrage — SPKLU tariffs are currently block-flat. It is capacity-cost avoidance, and it is quantifiable:

1. **`Rekening minimum = 40 × connected kVA × block cost`.** The minimum monthly bill is set by *subscribed capacity*, equivalent to 40 hours of full-capacity running, whether used or not. Load management that lets an operator subscribe less kVA reduces the floor on the monthly bill directly. **Expose "kVA headroom" as a first-class operator metric — it maps to money.**
2. **The 200 kVA TR/TM cliff.** Above 200 kVA a connection moves to medium voltage at 20 kV, requiring the customer to provide their own transformer, switchgear and MV metering — a step change in cost, complexity and lead time. Load management that caps aggregate site draw below 200 kVA keeps the site on TR. Note the power-factor trap: a 168 kW peak load is 177 kVA at PF 0.95 but **210 kVA at PF 0.80** — it crosses the cliff on power factor alone.
3. **Shared building circuits.** In Indonesian malls, offices and apartments chargers are almost never on a dedicated supply; they share the building connection with HVAC, lifts and lighting. Without dynamic balancing against the building's real-time load, chargers either trip the main or must be throttled to a uselessly conservative static limit.
4. **Genset transfer.** Genset backup is common in Indonesian commercial buildings and is sized for building essentials, not 120 kW of DC charging. **Chargers must curtail or stop when the site transfers to genset** — this needs a site input signal and a curtailment policy.

### 8.2 Control architecture — three layers, defence in depth

```
Layer 3  PlugSure optimiser        cloud, seconds-to-minutes, revenue/fairness/ToU aware
Layer 2  OCPP SetChargingProfile   per station and per transaction; survives brief WAN loss
Layer 1  Charger-local DLB         RS485 CT clamps + master/secondary; works with WAN down
                                   ← THIS is what guarantees the breaker
```

### 8.3 The optimiser

Inputs: site `ceiling_kw`, live building load (from a site meter or CT input where available), per-connector live draw, active session priorities (fleet SLA > paid public > free workplace), tariff ToU windows, genset/curtailment signals.

Outputs: `ChargePointMaxProfile` at `connectorId = 0` (the station-level ceiling — persistent, this is your breaker guard) plus `TxProfile` per active transaction for fine allocation.

**OCPP 1.6 smart charging traps the design must respect:**

| Trap | Rule |
|---|---|
| `TxProfile` requires an active transaction, `transactionId` is mandatory, and `connectorId = 0` is invalid | Never send `TxProfile` to connector 0. |
| `ChargePointMaxProfile` is **only** valid at `connectorId = 0` | |
| A profile at the highest stack level **with no `duration`** never expires, so the charger never falls back | **Always set `duration` or `validTo` on transient profiles.** Clear aggressively. |
| Effective limit = min(prevailing `ChargePointMaxProfile`, prevailing `TxProfile` else `TxDefaultProfile`) | |
| On multi-connector units, how the station splits its `ChargePointMaxProfile` total between connectors is **not specified by OCPP 1.6** — it is vendor-defined | Real hazard for Autel dual-socket AC Ultra and dual-gun DC. Record the observed behaviour in the quirk registry and do not assume fairness. |
| `chargingRateUnit`: AC wants `A`, DC wants `W`; query `ChargingScheduleAllowedChargingRateUnit` | **Store watts + phase count internally; convert at the adapter boundary** using 230 V L-N / 400 V L-L, 50 Hz. |
| `ClearChargingProfile` with no fields clears **everything** on the station | Always scope it. |
| `GetCompositeSchedule` implementation varies significantly by vendor | Useful for diagnostics; **do not make it load-bearing in the control loop.** |

**Fail-safe:** if the optimiser cannot reach a charger, the charger falls back to its `TxDefaultProfile`, which is set conservatively to the site's safe static allocation. If the optimiser itself is unhealthy, it stops issuing profiles rather than issuing stale ones — a stale ceiling is worse than a conservative one.

**Certification note:** if PlugSure certifies as an OCPP 1.6 CSMS, **Smart Charging is mandatory, not optional** (unlike on the charging-station side). Budget it into v1.

---

## 9. Payments architecture

### 9.1 The constraint that shapes everything

At session start the final amount is unknown. Payment must be secured before electricity flows, but the amount is only known after. Globally this is solved with a pre-authorisation hold. **In Indonesia the dominant rail cannot hold funds: QRIS has no pre-authorisation and, in its current form, never will.** It is a single immediate debit of a fixed amount.

The workaround — charge the maximum then refund the difference — should **not** be built. Debiting Rp 250,000 to deliver Rp 80,000 of electricity is a conversion killer in a price-sensitive market, refund settlement is slow and issuer-dependent, and a high refund ratio attracts PJP risk-team attention.

### 9.2 The tiered model

| Tier | Who | Mechanism | Notes |
|---|---|---|---|
| **1** | Registered driver | **E-wallet tokenisation** (Xendit). Link once at signup; validate token at session start (no debit, no hold); charge the **exact** final amount server-side at session end. | The primary path. Strictly better UX than pre-auth — one clean transaction for the right amount, no "why is Rp 250,000 pending on my DANA". Fits Indonesian habits: ShopeePay 91% / GoPay 67% / DANA 67% / OVO 44% three-month usage. |
| **2** | Premium / fleet driver | **Card pre-auth then capture** (Midtrans, best-documented; 7-day hold, capture ≤ authorised). | Card penetration is ~35%, so this is a premium path, not a default. First transaction must clear 3DS; One Click and recurring need **acquirer approval with real lead time — start that negotiation early**. |
| **3** | Walk-up guest, **no app install** | **QRIS dynamic MPM pre-purchase.** Driver scans the charger QR → picks Rp 50k / 100k / 150k → pays → the charger delivers exactly that much energy and stops. | Inverts the unknown-amount problem instead of fighting it. **This is what PLN already does at SPKLU via PLN Mobile**, so it matches driver expectations. |
| **4** | B2B fleet | **Postpaid**, accrued to a corporate account, monthly invoice against a **dedicated fixed virtual account**. | Solves Indonesia's reconciliation problem — banks do not reliably expose sender identity, and 60–80% of B2B volume moves by bank transfer. |

### 9.3 Two rules that are not negotiable

**Do not build a stored-balance driver wallet — not without counsel and a licensing plan.** Under PBI 20/6/PBI/2018, a closed-loop wallet is exempt from BI licensing only below **Rp 1,000,000,000 of float**, and open-loop requires a licence at *any* float level. Two problems compound:

- The Rp 1bn ceiling arrives fast: 10,000 drivers × Rp 100,000 average balance = Rp 1bn. That is a small, entirely achievable user base.
- **A multi-tenant CPO platform may not be closed-loop at all.** The test is whether the payment recipient is the same party that issued the e-money. If a driver tops up a PlugSure balance and spends it on electricity delivered by a third-party site host, a regulator can readily characterise the recipient as another party — making it **open loop, licence required, exemption inapplicable**.

This is precisely where the multi-tenant architecture collides with the regulation. It is a board-level decision, not an implementation detail. **Engage Indonesian payments counsel before a single line of wallet code is written**, and include PADG 32/2025 in the brief.

**Do not build charge-max-then-refund on QRIS.** See 9.1.

### 9.4 Gateway selection

**Xendit primary, Midtrans secondary.**

- **Xendit** is the only gateway with both capabilities this product needs: **e-wallet tokenisation** (documented for OVO; **[VERIFY]** DANA/ShopeePay/GoPay coverage — it determines the addressable base) and **xenPlatform native sub-merchant splitting**, which lets each site host be a sub-merchant with funds split at transaction time and PlugSure's take-rate deducted automatically rather than reconciled after the fact.
- **Midtrans** wins on headline price — **VA at Rp 4,000 flat versus Xendit's Rp 13,000 list** is a strong argument on VA-heavy B2B volume — and on pre-auth documentation quality. Its **GoPay Mini App** is a genuine distribution asset: PlugSure embedded inside GoPay, users auto-logged-in without re-entering a phone number, no setup fee. For a new CPO with no brand recognition that is a materially cheaper acquisition channel than app-store campaigns.
- Xendit's published rates are **list prices, heavily negotiated at volume**. Get written quotes from both against a projected volume profile.

### 9.5 The October 2026 MDR change is a genuine tailwind

From **1 October 2026**, Bank Indonesia extends **0% MDR to all merchant categories for transactions ≤ Rp 100,000**. At ~Rp 2,466/kWh, a 20 kWh top-up is ~Rp 49,000 and a 40 kWh session ~Rp 99,000 — both under the line. AC destination charging is almost always under it.

**Deliberately price the QRIS pre-purchase tiers at or below Rp 100,000.** A meaningful majority of session volume will then attract zero MDR.

This also **weakens the financial case for a prepaid wallet** — the classic reason to push stored balance is amortising per-transaction fees, and if per-session acceptance is free below Rp 100k that argument largely evaporates along with the reason to take on e-money regulatory risk.

**Open items to confirm in writing with the PJP:** whether EV charging is assigned the SPBU merchant category (0.4% MDR) or standard (0.7%) — globally EV charging has its own MCC 5552 and we found no BI/ASPI guidance on the Indonesian mapping; who is the "merchant" in a multi-tenant model (PlugSure or the site host), which determines the classification; and the settlement SLA per channel, which sets the working capital needed to pay site hosts. **Surcharging is prohibited** — MDR cannot be passed to the consumer as a line item, so build it into the kWh tariff.

### 9.6 Integration non-negotiables

Webhook signature verification. Idempotency keys on every handler. Explicit payment state machine with only legal transitions. Server-to-server status polling as a backstop with exponential backoff. **Daily three-way reconciliation** — internal sessions vs PJP transactions vs settlement report — with a manual exception queue and no auto-correction of discrepancies.

### 9.7 e-Faktur

No Indonesian payment gateway issues tax invoices. **Invoicing, VAT and e-Faktur are PlugSure's build**, not the gateway's.

Use a **PJAP** (Penyedia Jasa Aplikasi Perpajakan — Mekari Klikpajak, OnlinePajak, Pajakku) rather than integrating Coretax directly. DJP interfaces change with little notice and this is not where a CPO platform should spend engineering capacity.

**Critical sequencing constraint:** a faktur may not be issued to the customer before the serial number (**NSFP**) is returned by Coretax. The invoicing pipeline must treat this as a **synchronous dependency with an explicit pending state**, not a fire-and-forget async job. This is a common and expensive design error.

A public charging session is high-volume, low-value and often anonymous, so per-session e-Faktur is impractical: issue on request for B2B/fleet and for consumers who need one, and cover retail sessions with simplified documentation. **Distinguish B2C from B2B sessions at the transaction level** — their invoicing paths differ.

### 9.8 PlugSure's own receivables

Under PMK 141/2015, *jasa sehubungan dengan software* is an object of **PPh 23 at 2%** (4% without NPWP). Indonesian corporate customers will withhold 2% from PlugSure's invoices. It is a creditable prepayment of corporate income tax — cash-flow timing, not lost revenue — but PlugSure must collect **bukti potong** from every customer to claim it. **Model receivables net of 2% and build bukti potong tracking into finance from day one.** Note also that characterising the contract as a software *licence/royalty* rather than a *service* changes the rate to 15% — describe and structure the offering as a service consistently.

---

## 10. Compliance module

This is the module that competitors do not have. It is a **document vault with expiry alerting and enforcement hooks**, covering three separate certificate regimes with three different expiries per site.

| Artefact | Held at | Fields | Enforcement |
|---|---|---|---|
| **SPKLU Identity Number** | Site | Full ID, parsed components (entity code, operating scheme, sequence, municipality code), issue date | Format-validated. Municipality code drives PBJT resolution. Operating scheme drives the tenancy/permission model. |
| **SLO** (Sertifikat Laik Operasi) | Site | Certificate number, issuing LIT, issue date, expiry **[VERIFY period for SPKLU]** | Mandatory before commercial operation. Alert at 90/30/7 days. |
| **Tera / tera-ulang** | **Connector** | Meter serial, accuracy class (0.5 / 1 / 2.5), type-approval number, last tera date, next due date, seal status | **Block the connector from commercial sessions when verification lapses.** Alert at 60/30/7 days. |
| **Licence chain** | Organisation | NIB, WILUS, RUPTL endorsement, IUPTLU number, operating scheme | Drives what the tenant is legally permitted to do in-platform. |

**Why this matters now:** Kemendag launched type approval, tera and tera ulang for EV charger measuring instruments on **25 May 2026**, classifying EVSE as UTTP — the same regime as fuel dispensers. The government targets phased testing of **all operational SPKLU within one year** (~May 2027), covering 4,769 EVSE units across 3,097 locations at launch. **[VERIFY]** the tera-ulang interval (annual for most UTTP categories) and the penalties for operating unverified, with Direktorat Metrologi.

**Session records must be tamper-evident and reconcilable to the legally verified meter register**, not merely to an OCPP `MeterValues` stream. Where the two diverge, the legal meter wins for billing. Provide an export format suitable for metrology inspection.

**A useful legal carve-out to design around:** entities that merely lease equipment or perform maintenance in partnership with a licensed provider explicitly **do not need** WILUS, RUPTL, IUPTLU or an SPKLU identity number. This is the basis on which PlugSure serves site hosts as a pure software vendor without becoming a licensed electricity seller — and it means a large share of the addressable market operates *under someone else's licence*. **The tenancy model must support a licence-holder umbrella with many sub-operators beneath it.**

---

## 11. Access control, audit, and data protection

### 11.1 RBAC

Permissions are `(action, resource)` pairs; roles are named bundles; assignments are **scoped** to an organisation, a site, or a fleet. A site host gets `session:read` scoped to their sites only and never sees another host's revenue.

System roles: `platform_admin`, `org_owner`, `org_operator`, `finance`, `compliance`, `technician`, `site_host`, `fleet_manager`, `support_readonly`, `api_client`. Tenants may define custom roles from the same permission vocabulary.

Enforcement is at the **query layer**, not the controller — every tenant-scoped query goes through a repository that injects the scope predicate. Postgres row-level security is enabled as a second line of defence, not the first.

### 11.2 Audit log

Append-only, tamper-evident (hash-chained per organisation), covering: authentication events, permission changes, tariff changes (with before/after), **every remote command issued to a charger and who issued it**, token issuance and revocation, compliance document changes, payment state transitions, and data exports. Retained 7 years, queryable and exportable by the tenant.

Every remote command in the console shows the actor. When a driver calls to ask why their session stopped, support must be able to answer in one query.

### 11.3 UU PDP (UU 27/2022)

Fully in force — the two-year transition expired 17 October 2024. Charging data is sensitive in aggregate: identity, location, travel patterns and payment.

Obligations to design in: explicit, informed, separable consent; purpose limitation and minimisation; data subject rights (access, rectification, erasure, portability, objection, withdrawal); **breach notification within 72 hours**; records of processing; DPIA for high-risk processing; and a **DPO** — likely required, since the platform performs large-scale regular systematic monitoring.

Sanctions run from written warning through suspension to an **administrative fine up to 2% of annual revenue**, with criminal provisions up to 5 years and Rp 5bn. The **Badan PDP has still not been established** (target 2026, Kemkomdigi exercising oversight in the interim) — but criminal provisions are enforced by police and prosecutors, not the data authority. **Do not read the absent regulator as absent risk**; enforcement capacity is about to increase sharply and a platform launching now should be compliant by design rather than retrofitting under a new regulator's first enforcement wave.

### 11.4 PSE registration and data residency

PlugSure is a **PSE Lingkup Privat** and **must register via OSS before the system begins operation**. Sanctions escalate to permanent access blocking, which Komdigi has actively used.

On residency, stated precisely: PP 71/2019 **permits** private PSEs to process and store data outside Indonesia — it relaxed the strict onshore mandate of PP 82/2012. The binding condition is guaranteed access for government supervision and law enforcement, plus declaring data location at registration. Two qualifications: **sector rules can override** (BI/OJK impose stricter onshore requirements on payment services — structuring payments through a licensed PSP avoids inheriting this), and **contracting with PLN or government can flow an onshore obligation through contractually** even though PlugSure's own obligation is permissive. UU PDP separately governs cross-border transfer.

**Host in AWS `ap-southeast-3` (Jakarta) anyway.** Four independent reasons converge: latency to chargers and drivers; removing the residency question from every enterprise and government sales conversation; satisfying pass-through obligations; and **possibly improving TKDN scoring**, since foreign cloud is a foreign-service cost line that dilutes the domestic ratio. Evaluate hosting for TKDN and residency **jointly, not separately**.

---

## 12. Open API, webhooks, and integrations

**REST + OpenAPI 3.1**, versioned by URL (`/v1/`), OAuth2 client credentials for machine clients and API keys for simple integrations, per-tenant rate limits, cursor pagination, and a sandbox with a built-in virtual charger fleet.

**Webhooks on every state change** — this is the benchmark set by Monta (150+ endpoints, webhooks on all objects). Signed with HMAC-SHA256 over the raw body, timestamped to prevent replay, at-least-once with exponential backoff and a dead-letter queue the tenant can inspect and replay from.

Event vocabulary: `charge_point.*` (connected, disconnected, booted, faulted, recovered), `connector.status_changed`, `session.*` (started, updated, ended, rated), `cdr.created`, `payment.*` (authorised, captured, failed, refunded), `token.*`, `compliance.expiring`, `compliance.lapsed`, `alert.raised`, `firmware.*`.

**OCPI as an internal boundary, not just a roaming feature.** There is no evidence of an OCPI roaming hub or clearing house operating in Indonesia today, and what actually matters commercially is PLN — under PLN's partnership schemes, PLN Mobile is the driver app by commercial construction, and that integration will almost certainly be a PLN-proprietary API rather than OCPI. **Getting PLN's SPKLU integration spec early is the single biggest external-interface risk in the project.**

But shaping the internal contract as OCPI 2.3.0 objects (Locations, Sessions, CDRs, Tariffs, Tokens, Commands) means the PLN adapter, a future partner app, and a future real roaming peer are all *just adapters*. And the OCPI **Tariffs** object is a well-designed, battle-tested model — steal it for the internal tariff engine rather than inventing one. Build the actual OCPI CPO role in v3.

---

## 13. Observability, alerting, and support tooling

**The raw OCPP frame log is the single best support tool in the product.** Every frame in both directions, per charge point, searchable, with a session-scoped view. Store in a Timescale hypertable with compression; retain 90 days hot, 1 year compressed. When a driver disputes a session or a charger behaves oddly, this is what answers the question.

Alert rules (evaluated per tenant, configurable thresholds): charger offline > N minutes; connector `Faulted`; session failure rate above baseline for a site or model; energy anomaly (delivered energy inconsistent with power × duration — a meter-drift and fraud signal); **compliance expiry approaching**; payment capture failure; site load ceiling breached; gateway protocol error rate by vendor/firmware.

Routing to email, **WhatsApp** (the dominant ops channel in Indonesia — not an afterthought), SMS and webhooks, with escalation and on-call schedules.

**A WhatsApp cost design note worth acting on:** Meta moved to per-message pricing on 1 July 2025, and **utility templates are free inside an open customer service window**. A charging session inherently opens one — the driver initiates contact by starting the session. Structuring session notifications ("charging started", "80% complete", "session ended, Rp 87,400 charged") as utility templates *inside that window* drives per-session messaging cost toward zero. Design the flow around the window deliberately rather than blasting marketing-category templates. **[VERIFY]** current Indonesia per-message rates with Meta or the BSP; figures circulating publicly derive from the retired conversation model.

Auth: **WhatsApp OTP primary, SMS fallback** (~Rp 690/SMS). At 100,000 OTPs/month that is ~Rp 69M on SMS-only versus a fraction with WhatsApp-first. SMS fallback is not optional — WhatsApp delivery can fail.

Platform telemetry: OpenTelemetry traces across gateway → core → workers, correlated by session ID; RED metrics per endpoint; a fleet-wide protocol health dashboard broken down by vendor and firmware, which is how new quirks get discovered.

---

## 14. Build sequence

### Phase 0 — Foundations (weeks 1–4)
Repo, CI, Terraform for the Jakarta VPC, Postgres + Timescale, Redis. Tenancy, RBAC, audit log. **Register in SIINas immediately** (free, gates TKDN) and start PSE registration. Request the OCTT 14-day free trial — it costs nothing and finds protocol bugs faster than field testing.

### Phase 1 — OCPP core and monitoring (weeks 5–12)
OCPP-J transport with security profile 2. 1.6J adapter, canonical model, quirk registry. Provisioning routine. Real-time console with live connector state, remote start/stop, reset, unlock, and the raw frame log. Virtual charger simulator for load and failure-path testing. **Bench-test a real Autel unit against risks 1, 3 and 5 in §6.5.**

### Phase 2 — Sessions, tariffs, money (weeks 13–20)
Token management and local auth list sync. Session lifecycle and CDR generation with idempotency. Indonesian layered tariff engine with regulatory ceilings, `Q`/`N` multipliers, ToU dimension, per-municipality PBJT, exact PPN arithmetic. QRIS pre-purchase (Tier 3) driver web. B2B VA postpaid (Tier 4).

### Phase 3 — Load management and compliance (weeks 21–26)
Site power budget, optimiser, `SetChargingProfile` generation with correct purpose and stack levels, fail-safe fallback. kVA-headroom metric. Compliance vault: SPKLU ID parsing, SLO and tera lifecycle with connector blocking on lapse. Alerting with WhatsApp. Open API v1 + webhooks. **→ v1 launch.**

### Phase 4 — v2 (months 7–12)
Driver accounts, e-wallet tokenisation (Tier 1), card pre-auth (Tier 2). e-Faktur via PJAP. Firmware OTA. Fleet module. Revenue share and automated site-host payouts via xenPlatform. Reporting warehouse. White-label theming. **OCPP 2.0.1 adapter.** Pursue **TKDN certification** and **OCPP 1.6 CSMS certification** (Core + Smart Charging — Smart Charging is mandatory for a CSMS).

### Phase 5 — v3 (months 13+)
Native driver app. OCPI 2.3.0 CPO role. PLN Single Gateway integration. Battery swap (SPBKLU) — OCPP 2.1 Block S is explicitly aimed at two- and three-wheelers, which is a large and distinct Indonesian market (~1,700–1,839 swap units today, and SPBKLU capital entry is ~Rp 85.5m versus ~Rp 400m for a fast-charging SPKLU). DER/V2X.

### Indicative team
2 backend (one owning the OCPP gateway), 1 frontend, 1 full-stack for the driver surface, 0.5 DevOps, 1 product/compliance lead with Indonesian energy-sector fluency. The compliance lead is not optional — most of the moat lives in that role's domain knowledge.

---

## 15. Open questions to close before the design freezes

Ranked by impact.

| # | Question | Why it matters | How to close |
|---|---|---|---|
| 1 | **PLN's SPKLU integration spec** — what does PLN Mobile / Charge.IN actually require? | Likely the biggest external-interface risk; will shape session, tariff and token models more than OCPI | PLN partnership team, directly |
| 2 | Is **Single Gateway** integration mandatory for private CPOs? API or manual upload? What schema? | Could be a required compliance feature; being early is a differentiator | Direktorat Pembinaan Pengusahaan Ketenagalistrikan; attend a bimtek |
| 3 | **Can Autel chargers be re-pointed to a different OCPP backend after the first switch?** | If irreversible, it changes procurement and pilot design entirely | Written confirmation from Autel APAC + sacrificial bench unit |
| 4 | Does a multi-tenant CPO platform holding driver balances qualify as **closed-loop e-money**? | Determines whether a wallet is buildable at all; the Rp 1bn exemption may not apply | Indonesian payments counsel. Brief must include PADG 32/2025 |
| 5 | Has **Permen ESDM 1/2023** been amended or replaced 2024–2026? Does **Kepmen 24.K/2025** supersede the 182.K/2023 fee ceilings? | Foundation of the licensing model and the billing ceilings | JDIH ESDM primary text + energy counsel |
| 6 | **Tera-ulang interval** and penalties for EVSE | Drives the compliance-alerting design | Direktorat Metrologi, Kemendag |
| 7 | Exact **TKDN calculation annex for software** under Permenperin 35/2025 | Determines achievable score, and hiring/hosting structure should be set *before* certification | TKDN consultant + SIINas |
| 8 | Which **e-wallets support Xendit tokenisation** beyond OVO? Is partial capture available in Indonesia? | Determines Tier 1's addressable base | Xendit, in writing |
| 9 | Is EV charging assigned **SPBU MDR (0.4%)** or standard (0.7%)? Who is the merchant in a multi-tenant model? | 0.3% delta is material at scale | PJP, in writing at onboarding |
| 10 | Current **Q and N values** PLN applies by scheme and voltage level | Tariff engine defaults | PLN partnership team |
| 11 | Is **SNI certification mandatory** for EVSE? **SLO validity period** for SPKLU? | Hardware onboarding validation; compliance field config | BSN / Kemenperin; a LIT such as Sucofindo |
| 12 | Does Autel accept **OCPP-driven firmware updates** from a third-party CSMS? | Gates the OTA feature promise | Bench acceptance test |

**A note on sourcing.** Indonesian government portals — `gatrik.esdm.go.id`, `jdih.esdm.go.id`, `peraturan.bpk.go.id`, `tkdn.kemenperin.go.id` — are heavily JavaScript-rendered and frequently blocked automated retrieval during this research. Several primary regulatory documents were reachable only through secondary reporting or direct PDF links. **Items 5, 2 and 1 in particular should be confirmed against primary text with Indonesian energy-sector counsel before the PRD is frozen** — a change there would alter product requirements rather than merely refine them.

---

## 16. Non-functional requirements

| Area | Target |
|---|---|
| Charger connection capacity | 20,000 concurrent WebSockets per gateway cluster; 5,000 per node |
| Command round-trip | p95 < 3 s from API call to CALLRESULT, excluding charger-side latency |
| Console live update | p95 < 2 s from OCPP frame to browser |
| Availability | 99.9% for the OCPP gateway (a charger that cannot connect cannot earn); 99.5% for the console |
| Session durability | Zero session loss on gateway node failure — chargers reconnect and replay |
| Data retention | Frame log 90 d hot / 1 y compressed; meter values 3 y; CDRs and invoices 10 y (tax); audit log 7 y |
| RPO / RTO | RPO 5 min (PITR), RTO 1 h |
| Localisation | Full Bahasa Indonesia and English across all surfaces, including receipts, emails and WhatsApp templates. IDR formatting, WIB/WITA/WIT time zones |
| Driver web performance | First contentful paint < 2 s on a 3G connection and a low-end Android device |

---

## 17. Sources

**OCPP and hardware** — [OCA certification programme](https://openchargealliance.org/certification-program/) · [OCTT test tool](https://openchargealliance.org/test-tool/) · [What is new in OCPP 2.0.1](https://openchargealliance.org/wp-content/uploads/2024/01/new_in_ocpp_201-v10.pdf) · [ISO 15118 PnC over OCPP 1.6](https://openchargealliance.org/wp-content/uploads/2023/11/ocpp_1_6_ISO_15118_v10.pdf) · [ocpp.md 1.6J](https://ocpp.md/ocpp-1.6j/) · [ocpp.md smart charging](https://ocpp.md/ocpp-1.6j/smart-charging/) · [ocpp.md 2.0.1](https://ocpp.md/ocpp-2.0.1/) · [ocpp.md 2.1](https://ocpp.md/ocpp-2.1/) · [CoreEVI — OCPP basic auth & SecurityProfile](https://coreevi.com/a/2/ocpp-basic-auth-securityprofile) · [amina — OCPP security profiles](https://aminacharging.com/articles/ocpp-security-profiles/) · [CitrineOS](https://github.com/citrineos/citrineos-core) · [SteVe](https://github.com/steve-community/steve) · [mikuso/ocpp-rpc](https://github.com/mikuso/ocpp-rpc) · [lorenzodonini/ocpp-go](https://github.com/lorenzodonini/ocpp-go) · [mobilityhouse/ocpp](https://github.com/mobilityhouse/ocpp)

**Autel** — [Autel global catalogue](https://autelenergy.com/global/product/all) · [MaxiCharger AC Wallbox EU datasheet (MID)](https://wallboxcenter.de/wp-content/uploads/2026/06/Autel-Maxi-Charger-22-MID-BK_Datenblatt.pdf) · [Sevadis DC Compact datasheet](https://sevadis.com/wp-content/uploads/2024/07/MaxiCharger-DC-Compact-40-47kW-Datasheet.pdf) · [MaxiCharger DH480 datasheet](https://www.elfor.org/wp-content/uploads/2024/09/MaxiCharger-DH480_camion.pdf) · [Sevadis dynamic load balancing](https://sevadis.com/wp-content/uploads/2024/03/Sevadis-Dynamic-Balancing-Document.pdf) · [Clenergy — Autel/Sevadis OCPP onboarding guide](https://partners.clenergy-ev.com/hubfs/Onboarding%20Guides%20(PDF)/Autel%20Sevadis%20Maxicharger%20-%20Onboarding%20Guide%20(New%20branding).pdf?hsLang=en) · [ChargeLab Autel config guide](https://chargelab.zendesk.com/hc/en-us/articles/42340494306203-Autel-AC-Lite-Maxi-Charge-Configuration-Guide) · [ZDI — Autel MaxiCharger attack surface](https://www.thezdi.com/blog/2025/1/15/reviewing-the-attack-surface-of-the-autel-maxicharger-part-two) · [Autostart disabled irreversibly (issue #1955)](https://github.com/lbbrhzn/ocpp/issues/1955) · [Autel OCPP quirks (discussion #669)](https://github.com/lbbrhzn/ocpp/discussions/669) · [Autel Charge Cloud — US/Canada only](https://store.autelenergy.com/products/autel-charge-cloud)

**Indonesian regulation** — [Perpres 79/2023 full text](https://jdih.kemenkeu.go.id/api/download/2426f667-7c15-4afb-8a52-4efc01da5e9b/2023perpres079.pdf) · [Permen ESDM 1/2023](https://peraturan.bpk.go.id/Details/252409/permen-esdm-no-1-tahun-2023) · [Permen ESDM 7/2024 (tariffs)](https://jdih.esdm.go.id/common/dokumen-external/Permen%20ESDM%20Nomor%207%20Tahun%202024.pdf) · [Ditjen Gatrik — SPKLU licensing IUPTL-PWU](https://gatrik.esdm.go.id/infogatrik/api//storage/2025/konten/pdf/7QYZeAN2hV_02062025021414.pdf) · [Ditjen Gatrik — PP 28/2025 & Single Gateway](https://gatrik.esdm.go.id/berita/?slug=pasca-pp-28-2025-pemerintah-sederhanakan-izin-spklu-dan-perkuat-sistem-data-ketenagalistrikan&category=ketenagalistrikan) · [ESDM — SPKLU service fee ceilings](https://www.esdm.go.id/id/media-center/arsip-berita/percepat-ekosistem-kendaraan-listrik-pemerintah-resmi-terbitkan-tarif-dan-biaya-layanan-pengisian-listrik-pada-spklu) · [Prolegal — SPKLU licence types](https://prolegal.id/jenis-jenis-izin-usaha-stasiun-pengisian-kendaraan-listrik-umum-spklu/)

**Metrology** — [Kemendag — EVSE tera launch, 25 May 2026](https://www.kemendag.go.id/berita/siaran-pers/kemendag-luncurkan-layanan-persetujuan-tipe-tera-dan-tera-ulang-alat-ukur-pengisi-daya-kendaraan-listrik) · [Antara — alat ukur SPKLU wajib ditera](https://www.antaranews.com/berita/4105503/pemerintah-sebut-alat-ukur-di-spklu-wajib-ditera) · [Permendag 24/2024](https://peraturan.bpk.go.id/Details/305838/permendag-no-24-tahun-2024) · [BSN — SNI SPKLU](https://www.bsn.go.id/main/berita/detail/17758/ribuan-spklu-standar-sni-beredar-di-indonesia)

**Grid & business case** — [CNBC — Q3 2026 PLN tariff table](https://www.cnbcindonesia.com/news/20260727084544-4-753968/daftar-resmi-tarif-listrik-pln-per-kwh-berlaku-juli-september-2026) · [Listrik Indonesia — tarif curah & 50% connection discount](https://listrikindonesia.com/detail/14957/tingkatkan-minat-bangun-spklu-pln-beri-tarif-curah-dan-diskon-penyambungan-50) · [Masko — TR vs TM economics](https://www.maskoelectrical.com/post/biaya-dan-potensi-bisnis-spklu-tr-vs-tm) · [Masko — PLN partnership schemes](https://www.maskoelectrical.com/post/cara-menjalin-kerja-sama-dengan-pln-untuk-membangun-spklu-di-lokasi-anda) · [DDTC — PBJT rates under UU HKPD](https://news.ddtc.co.id/berita/nasional/44010/begini-ketentuan-tarif-pbjt-atas-konsumsi-tenaga-listrik-di-uu-hkpd)

**TKDN** — [Permenperin 35/2025](https://peraturan.bpk.go.id/Details/333003/permenperin-no-35-tahun-2025) · [Kontrak Hukum — TKDN 2025 update](https://kontrakhukum.com/article/update-aturan-tkdn-terbaru-tahun-2025/) · [UNO — minimum TKDN thresholds](https://uno.id/batas-minimal-nilai-tkdn/)

**Data protection** — [UU 27/2022 (PDP)](https://peraturan.bpk.go.id/Details/229798/uu-no-27-tahun-202) · [PP 71/2019](https://jdih.komdigi.go.id/produk_hukum/view/id/695/t/peraturan+pemerintah+nomor+71+tahun+2019) · [Permenkominfo 5/2020](https://jdih.komdigi.go.id/produk_hukum/view/id/759/t/peraturan+menteri+komunikasi+dan+informatika+nomor+5+tahun+2020) · [Hukumonline — PDP sanctions](https://www.hukumonline.com/berita/a/ancaman-sanksi-administratif-hingga-pidana-dalam-uu-pelindungan-data-pribadi-lt633c69ce2de5c/) · [AWS Jakarta region](https://aws.amazon.com/blogs/aws/now-open-aws-asia-pacific-jakarta-region)

**Payments** — [Bank Indonesia — QRIS](https://www.bi.go.id/en/fungsi-utama/sistem-pembayaran/ritel/kanal-layanan/qris/default.aspx) · [BI — MDR QRIS](https://www.bi.go.id/id/publikasi/ruang-media/cerita-bi/Pages/mdr-qris.aspx) · [ANTARA — 0% MDR expansion Oct 2026](https://www.antaranews.com/berita/5697901/bi-perluas-kebijakan-mdr-qris-0-persen-untuk-pelaku-umkm) · [Xendit pricing](https://www.xendit.co/en-id/pricing/) · [Xendit — eWallet tokenisation](https://help.xendit.co/hc/en-us/articles/13322736469529-How-to-create-eWallet-Tokenization) · [Xendit — split payments](https://docs.xendit.co/docs/split-payments) · [Midtrans pricing](https://midtrans.com/pricing) · [Midtrans — pre-authorization](https://docs.midtrans.com/reference/card-feature-pre-authorization) · [Midtrans — disbursement (Iris)](https://docs.midtrans.com/docs/disbursement-overview) · [Midtrans — GoPay Mini App](https://midtrans.com/product/gopay-mini-app) · [SSEK — e-money limits](https://ssek.com/blog/bank-indonesia-sets-new-limits-for-the-provision-of-e-money/) · [MUC — 12% luxury / 11% non-luxury VAT](https://muc.co.id/en/article/effective-now-12-vat-for-luxury-goods-11-for-non-luxury-goods) · [Meta — WhatsApp per-message pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)

**Market** — [NTV — 5,016 SPKLU June 2026](https://www.ntvnews.id/ekonomi/01113855/pln-perluas-jaringan-spklu-seiring-lonjakan-konsumsi-listrik-kendaraan-listrik) · [Jawa Pos — 62,918 target by 2030](https://www.jawapos.com/ekonomi/2605110427/esdm-patok-target-fantastis-jumlah-spklu-62-ribu-hingga-2030-saat-ini-baru-4892-unit) · [CNN — BEV sales +88.6% Jan–Jul 2026](https://www.cnnindonesia.com/otomotif/20260818100748-603-1393454/penjualan-mobil-listrik-di-indonesia-melesat-88-persen) · [Gardu Oto — non-PLN fast charging tariffs Aug 2026](https://www.garduoto.com/142917/peta-tarif-fast-charging-non-pln-di-indonesia-mana-paling-praktis) · [AMPECO](https://www.ampeco.com/) · [Monta](https://monta.com/)
