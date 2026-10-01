# PlugSure

Multi-tenant EV charging management system (CSMS) for Indonesia.

OCPP 1.6J today, 2.0.1-shaped internally so 2.0.1 costs an adapter rather than a rewrite.
Built for Autel MaxiCharger hardware first, multi-vendor by construction.

See [`docs/PLUGSURE-ARCHITECTURE.md`](docs/PLUGSURE-ARCHITECTURE.md) for the full technical
architecture and product specification, including the Indonesian regulatory analysis this
codebase implements.

**v1.5.0 — white-label operator console (2 October 2026).** Each operator can show its own
product name, tagline, colours and logo in the console (Governance → Console branding), and give
the console its own web address, where the sign-in page shows the brand and only that operator's
accounts can sign in. Migration 054 (additive), no new settings; see
[`RELEASE-NOTES-v1.5.0.md`](RELEASE-NOTES-v1.5.0.md).

**v1.4.4 — pre-deployment review fixes (2 October 2026).** The driver app no longer sells,
reserves or queues on a suspended charger; resume no longer backdates an outage; on systemd the
database owner credential moves to a root-only `migrate.env` read only by the new
`plugsure-migrate.service`. No migrations; systemd installs need one configuration change — see
[`RELEASE-NOTES-v1.4.4.md`](RELEASE-NOTES-v1.4.4.md).

**v1.4.3 — user menu icons (2 October 2026).** The user menu's icons are drawn at their intended
size. Style only; no migrations or new settings; see [`RELEASE-NOTES-v1.4.3.md`](RELEASE-NOTES-v1.4.3.md).

**v1.4.2 — fixes (2 October 2026).** Scan from live charger finds tapped cards again, the sidebar
shows the installed version, suspended chargers no longer offer Start, and the deployment docs are
corrected (acceptance health check; systemd database roles). No migrations or new settings; see
[`RELEASE-NOTES-v1.4.2.md`](RELEASE-NOTES-v1.4.2.md).

**v1.4.1 — suspend and resume (2 October 2026).** Operators can suspend a charge point from the
console or API (no new sessions, credentials kept) and resume it. Adds the hardware acceptance
checklist [`docs/ACCEPTANCE-v1.4.md`](docs/ACCEPTANCE-v1.4.md). No migrations or new settings; see
[`RELEASE-NOTES-v1.4.1.md`](RELEASE-NOTES-v1.4.1.md).

**v1.4.0 — review fixes (2 October 2026).** Every finding of the independent review of v1.3.0 is
fixed: billing correctness, payment idempotency, tenant isolation, roaming trust, driver sign-in
limits, charger PKI and operations. Several settings are now required outside development
(`SECRETS_KEY`, OCPP security profile ≥ 2 with auto-adopt off, `OCPI_PUBLIC_URL` for roaming). Read
[`RELEASE-NOTES-v1.4.0.md`](RELEASE-NOTES-v1.4.0.md) before upgrading.

**v1.3 — Enterprise operator console.** Sign in at the API root (`/`) to onboard chargers,
manage sites and PLN capacity, run load management, build tariffs, issue RFID cards, tune OCPP
configuration, roll out firmware and manage users — no scripts or SQL. Bootstrap the first admin
with `npm run create-admin`. See [`RELEASE-NOTES-v1.3.0.md`](RELEASE-NOTES-v1.3.0.md) and
[`docs/ACCEPTANCE-v1.3.md`](docs/ACCEPTANCE-v1.3.md).
Deployment: [`docs/PlugSure-v1.3.0-Deployment-Guide.pdf`](docs/PlugSure-v1.3.0-Deployment-Guide.pdf).
Final pre-deployment audit (29 Sep 2026): [`docs/FINAL-AUDIT-v1.3.0.md`](docs/FINAL-AUDIT-v1.3.0.md) ([PDF](docs/PlugSure-v1.3.0-Final-Audit.pdf)) — production build, fresh PostgreSQL 16, all unit tests (the current count is in CI's `npm test` output), all 28 e2e suites.
Go-live status: [`docs/READINESS-REVIEW-v1.3.md`](docs/READINESS-REVIEW-v1.3.md)
([PDF](docs/PlugSure-v1.3.0-Readiness-Review.pdf)) — ready for a supervised pilot; public paid
charging is blocked on a QRIS acquirer and an OTP provider.

---

> ## Status (v1.3.0, 29 September 2026)
>
> **Ready for a supervised pilot, not yet for public paid charging**, which
> waits on a contracted QRIS acquirer and an SMS/WhatsApp sign-in provider
> ([`docs/READINESS-REVIEW-v1.3.md`](docs/READINESS-REVIEW-v1.3.md)).
> `npm test`: **571 passing**, plus the end-to-end suites listed under
> *Verification* in [`RELEASE-NOTES-v1.3.0.md`](RELEASE-NOTES-v1.3.0.md).
>
> **It has still never run against real charger hardware.** Pass
> [`docs/ACCEPTANCE-v1.4.md`](docs/ACCEPTANCE-v1.4.md) on at least one real
> charger before the pilot: the simulator proves the protocol path, not the
> hardware. The history below is why that matters.
>
> ## History: three audit passes, three remediations, 100 findings closed (v1.1–v1.2)
>
> | Pass | Auditors | Findings | Outcome |
> |---|---|---|---|
> | 1 | 4 | 33 | closed — and introduced 3 new defects |
> | 2 | 3, blind | 34 | closed — and introduced 1 new CRITICAL |
> | 3 | 3, blind | 33 | closed, verified live |
>
> **Read that table before you trust anything below it.** Every remediation pass
> so far has introduced at least one defect larger than something it fixed. The
> most recent was a change made to switch Postgres row-level security *on*: it
> used `AsyncLocalStorage.enterWith`, Node reuses HTTP parser objects
> process-wide, and the API's database client leaked into the OCPP gateway — so
> after any browser request to the console, every BootNotification failed and the
> process died. Two auditors reproduced it independently.
>
> The register is in [`docs/VERIFICATION-REPORT.md`](docs/VERIFICATION-REPORT.md)
> and the reproduction scripts are under [`audit/`](audit/). Each fix carries a
> regression test or a named simulator scenario that reproduces the original
> defect and now passes (**136 unit tests** at the time; 571 in v1.3.0).
>
> **This has still never met real Autel hardware**, and a fourth audit pass is
> warranted before it does — three passes have each found real defects in the
> previous remediation, and there is no reason to assume this one is different.
> The hardware risks in [§6.5 of the architecture](docs/PLUGSURE-ARCHITECTURE.md)
> remain open.

## What runs today

Legend: ✅ verified working · ⚠️ works with a named caveat · ⬜ not started

| Area | Status |
|---|---|
| OCPP-J framing, one-outstanding-CALL queue, reconnect generation token | ✅ |
| **Inbound schema validation** (Ajv, all 11 CP→CS actions) | ✅ database and runtime errors can no longer reach the wire |
| **`CALLERROR` semantics** | ✅ malformed frames answered per spec; unknown actions get `NotImplemented`; `MessageId` validated |
| **Spec-deviation tolerance** | ✅ a 21-character Autel model name and a numeric `sampledValue.value` are accepted and recorded as quirks, not dropped |
| **Subprotocol negotiation** | ✅ pinned to what we can actually speak; a dual-stack charger gets `ocpp1.6` |
| **WSS / TLS** | ✅ the gateway terminates TLS itself, or trusts a proxy's `X-Forwarded-Proto` |
| **Security profiles 0–2** | ✅ key generation and rotation with a grace window; profile ≥1 refused without a key; profile 2 refused without TLS |
| **Connection evidence** | ✅ every pre-upgrade attempt recorded — IP, path, subprotocols, TLS, credentials, outcome |
| **Adoption queue** | ✅ unknown identities are queued and adoptable from the console, with near-match suggestions |
| Canonical 2.0.1-shaped model; 1.6 adapter synthesising `TransactionEvent` | ✅ |
| Boot provisioning, graceful degrade on rejected keys | ✅ runs on a background lane; operator commands never queue behind it |
| Vendor quirk registry | ✅ row-locked, retracts stale findings, readable in the console |
| **Session idempotency / offline replay** | ✅ keyed on charger-supplied facts; the `offline-replay` and `duplicate-start` scenarios pass |
| Tariff arithmetic — PPN `11/12` DPP, PBJT, ToU, WBP+LWBP | ✅ (rounding drift 0.5 ppm over 10,000 sessions) |
| **Tariff resolution as of session start** | ✅ the effective instant is a required argument |
| **Regulatory ceiling enforcement** | ✅ enforced on the write path; an illegal tariff returns 422 and is not saved |
| **Banded tiers, day/time windows, idle fees** | ✅ tiers bill their own band; the window fields are live; idle minutes are computed from the meter series |
| **Meter authority** | ✅ `transactionData` preferred, per-phase registers summed, absent `meterStop` tolerated and billed from the running total, a final register below the running total billed at the higher figure |
| **Register rollover** | ✅ a wrap must LOOK like one — start near the top of its width, stop restarted near zero. The old "implied energy under 500 kWh" test billed phantom energy on every meter under 65.5 kWh |
| **Energy priced exactly once** | ✅ a kWh belongs to one ToU block and one component within it; `DOUBLE_PRICED_ENERGY` sits alongside `UNPRICED_ENERGY` |
| **Occupancy fees are bounded** | ✅ `to_minutes` required, worst case checked at save time, capped on the invoice. Unbounded, an idle fee billed Rp 6,692,360 for 60 kWh |
| **Nothing bills silently when it looks wrong** | ✅ an implausible clock, inverted timestamps or a backwards meter park the session for review instead of invoicing it |
| Site load management | ✅ station ceiling and default profiles are actually sent; profiles are cleared and reconciled |
| Compliance vault: SPKLU ID, SLO, tera with connector blocking | ✅ |
| **QRIS pre-purchase** | ✅ the allowance is bound to the PAYER's token, reserves the worst case, is written to the session, throttled at 90% and stopped at the limit; zero-allowance tiers are refused |
| **Driver app — public charging** | ✅ QR-first mobile web app (Bahasa Indonesia): scan → pay QRIS → live session → receipt. Guest-first, optional phone-OTP account, fleet RFID mode. Served at `/app`, verified end-to-end against the compiled build. |
| **Driver API** | ✅ Platform-level surface at `/d` — public station finder, connector resolution, guest checkout, remote start/stop, live status, itemised receipt with the full Indonesian tax breakdown and prepaid refund reconciliation. |
| **Prepaid settlement** | ⚠️ every prepaid session is reconciled against what was collected and the delta recorded and alerted — but there is no refund rail, so an over-collection parks the session for a human |
| **API authentication** | ✅ bearer API keys and sessions; the tenant comes from the credential, never a header |
| **Tenant isolation** | ✅ every resource route resolves its owning organisation; `can()` fails closed; Postgres RLS genuinely engaged — the app runs as a non-superuser and each request pins `app.current_org_id` |
| **Delegation** | ✅ a credential can only ever grant permissions it already holds. Without this, an `org_owner` key — exactly what you hand a vendor — could mint a `platform:admin` key |
| **Audit log** | ✅ HMAC-keyed chain with per-org sequence and a head record — mutation, deletion, truncation and reordering all detected |
| Operator console | ✅ attribute-safe escaping, CSP, and views for connections, adoption and quirks |
| Raw OCPP frame log | ✅ handshake metadata captured, time/action filters, NDJSON export |
| Charge point simulator | ✅ reconnect with backoff, offline store-and-forward, fault injection, seven named scenarios |
| Deployment | ✅ Dockerfile, compose, systemd units, Caddy TLS config, CI, runbook |
| Rate limiting, security headers, secret handling | ✅ |
| OCPP 2.0.1 adapter, e-Faktur, real PJP integration, OCPI, firmware OTA | ⬜ not started |

### Known caveats

- **Never tested against real Autel hardware.** Every result above is against the
  simulator. The eight hardware risks in the architecture register are still open.
- **`OCPP_MIN_SECURITY_PROFILE` defaults to `0`** — no per-charger authentication.
  Correct for a bench, wrong for anything else. At profile 0 an unauthenticated
  peer can open a session as any tenant's charger and inject telemetry, and the
  API credential you hand a vendor does not constrain that at all. Set it to `2`
  before the OCPP port is reachable by anyone but you.
- **Run the app as `plugsure_app`, not as the database owner.** A superuser
  bypasses every RLS policy; the process refuses to start that way in production.
  `POSTGRES_APP_PASSWORD` provisions the role during migration.
- **The payment provider is a mock.** QRIS settlement and reconciliation against a
  real acquirer do not exist.
- **`ClearCache`, `GetDiagnostics`, `UpdateFirmware`, `ReserveNow` are routed but unexercised** —
  no charger has answered them.
- **`AUDIT_HMAC_KEY` must be set outside development**, or the process refuses to start.
- **Pre-v2 audit rows will not verify** — the chain is keyed now; archive and re-anchor before trusting `verifyChain` on old data.
- **The console's CSP needs `'unsafe-inline'`** because a `<meta>` tag cannot carry a nonce. The header from Fastify is the real fix.

---

## The driver app

A QR-first mobile web app for drivers, served by the same process at **`/app`** (no
separate deployment). Guest-first: a walk-up driver scans the QR on a charger, sees the
price, pays with QRIS, watches the session live, and gets an itemised receipt — no account,
no app store. An optional phone-OTP account carries history across devices; fleet drivers
sign in with an RFID token and a PIN and charge postpaid, billed to their organisation.

- **Public browse** (no auth): `GET /d/v1/stations`, `GET /d/v1/connectors/:id`, `GET /d/v1/resolve?code=`
- **Guest charge**: `POST /d/v1/device` → `/d/v1/charge/prepaid` → pay → `/d/v1/charge/:id/start` → `/status` → `/receipt`
- **Identity**: phone OTP (`/d/v1/otp/*`) and fleet login (`/d/v1/fleet/login`)

The driver surface is deliberately separate from the operator API: public browse needs no
auth, everything else is a device token (`psd_…`), and none of it enters the per-request org
scope — a driver legitimately reads across CPO tenants for their own charges, filtered
explicitly by driver identity. See `src/driver/` and migration `007_driver_app.sql`.

## Quick start

Requires Node 22+ and PostgreSQL 16.

```bash
npm install
cp .env.example .env          # adjust DATABASE_URL if needed
createdb plugsure

npm run migrate               # schema
npm run seed                  # a Jakarta CPO tenant, Autel hardware, a regulated tariff
npm run dev                   # gateway :9220 + API and console :9200
```

Open <http://localhost:9200>.

In a second terminal, connect virtual chargers:

```bash
npx tsx tools/simulator/autel-sim.ts --id AUTEL-AC22-SMB-001 --connectors 1
npx tsx tools/simulator/autel-sim.ts --id AUTEL-DC60-SMB-002 --connectors 2 --dc
```

Or run a named failure scenario — offline replay, a duplicate `StartTransaction`,
a reconnect storm, a 1970 clock — each with a PASS/FAIL summary:

```bash
npx tsx tools/simulator/autel-sim.ts --scenario offline-replay
npx tsx tools/simulator/fleet.ts --count 20 --storm 3
```

See [`tools/simulator/README.md`](tools/simulator/README.md) for every scenario
and fault flag.

Then drive a full session end to end:

```bash
# start charging
curl -X POST localhost:9200/v1/charge-points/AUTEL-AC22-SMB-001/commands/remote-start \
  -H 'content-type: application/json' -d '{"connectorId":1,"idTag":"ID-RFID-0001"}'

# constrain the site and let the optimiser allocate
SITE=$(curl -s localhost:9200/v1/charge-points | jq -r '.[0].site_id')
curl -X PUT localhost:9200/v1/sites/$SITE/power/budget \
  -H 'content-type: application/json' -d '{"ceilingW":55000,"reserveW":5000}'
curl -X POST localhost:9200/v1/sites/$SITE/power/apply

# QRIS pre-purchase: rupiah in, energy allowance out
curl -X POST localhost:9200/v1/checkout/qris -H 'content-type: application/json' \
  -d '{"ocppIdentity":"AUTEL-AC22-SMB-001","connectorId":1,"amountIdr":75000}'
```

The seed deliberately includes one connector whose **tera ulang has lapsed**
(`AUTEL-DC60-SMB-002` connector 2). Starting a commercial session there returns `409` —
that is the metrology compliance gate doing its job, not a bug.

Run the test suite (tariff arithmetic, tax, allocation, SPKLU parsing, compliance gates):

```bash
npx tsx --test src/services/tariff.test.ts
npx tsc --noEmit
```

---

## Layout

```
db/migrations/           SQL schema
src/
  config.ts              tax rates, regulatory ceilings, PLN formula bases — all versioned, none hardcoded in logic
  domain/
    canonical.ts         the 2.0.1-shaped model everything downstream consumes
    spklu.ts             SPKLU identity parsing, charging-class classification
  ocpp/
    rpc.ts               OCPP-J framing, one-outstanding-CALL enforcement
    server.ts            WS server, subprotocol negotiation, Basic auth, connection lifecycle
    adapter16.ts         1.6J -> canonical events
    provisioning.ts      post-boot config diff and local auth list sync
    quirks.ts            vendor quirk registry (seeded with known Autel behaviour)
    commands.ts          outbound commands, audited, with OCPP 1.6 smart-charging guards
    registry.ts          connection ownership (Redis in production)
  services/
    tariff.ts            Indonesian layered rating + inverse rating for prepaid QRIS
    tax.ts               PBJT and PPN (DPP nilai lain = 11/12 x price)
    sessions.ts          idempotent session lifecycle and CDR generation
    smartcharging.ts     site budget, allocation, kVA headroom
    compliance.ts        tera/SLO/SPKLU lifecycle and enforcement
    authz.ts             scoped RBAC
    audit.ts             hash-chained audit log
    payments/            provider interface + sandbox implementation
  api/server.ts          REST API + console
  web/index.html         operator console (single file, no build step)
tools/simulator/         virtual Autel charge point
```

---

## Design decisions worth knowing before you change anything

**The canonical model is OCPP 2.0.1-shaped and 1.6 maps *up* into it.** The rating engine,
the console, the webhook emitter and any future OCPI adapter see one shape and contain no
version branches. This is the decision that determines whether adding protocol version #2
costs a sprint or a rewrite.

**Only one OCPP CALL may be outstanding per direction.** `OcppRpcConnection` queues rather
than pipelines. This is the single most common OCPP implementation error.

**Never treat a rejected config key as fatal.** Autel units are documented to reject
`MeterValuesSampledData`. Provisioning records the rejection in the quirk registry and
continues. A fatal error here strands the fleet.

**Never reject an unknown `DataTransfer`.** Respond `UnknownVendorId`/`UnknownMessageId`,
log the frame, and mine the logs — that is how undocumented vendor extensions get found.

**Bill on the charger's timestamps, not receipt time.** Chargers replay queued transaction
messages after an outage, out of order and with stale timestamps. Sessions are keyed on an
idempotency hash of charger-supplied facts.

**OCPP smart charging does not protect the breaker.** The charger's own RS485 CT-clamp load
balancing does, and it works when the WAN is down. The cloud optimiser shapes for tariff
and fairness on top of that floor.

**Always bound a charging profile.** A top-stack-level profile with no `duration` never
expires and the charger never falls back.

**Compute PPN exactly as the regulation specifies:** `DPP = 11/12 × price`, then
`PPN = 12% × DPP`. Applying 11% directly gives the right total and the wrong DPP on the
faktur pajak, which fails an audit.

**PBJT is per-municipality, not national.** It resolves from the site's kabupaten/kota code
— which the SPKLU identity number already encodes.

**Do not build a stored-balance driver wallet without legal advice.** Under PBI
20/6/PBI/2018 the closed-loop exemption stops at Rp 1bn of float, and a multi-tenant CPO
platform may not be closed-loop at all. See §9.3 of the architecture document.

---

## Configuration

Everything regulatory lives in `src/config.ts` and is environment-overridable, because all
of it moves:

| Variable | Default | Why it is not a constant |
|---|---|---|
| `PPN_RATE_BPS` | `1200` | Indonesian VAT changed twice in three years |
| `PPN_DPP_NUM` / `PPN_DPP_DEN` | `11` / `12` | DPP nilai lain mechanism |
| `PBJT_IN_PPN_BASE` | `true` | Treatment not unambiguous in public sources — verify with a tax advisor |
| `PLN_LK_BASE` | `1645` | Layanan khusus base moves with quarterly tariff adjustment |
| `PLN_CURAH_BASE` | `707` | Bulk base; `Q` is set by PLN Direksi decision |
| `WBP_START` / `WBP_END` | `17:00` / `22:00` | Peak window, currently priced flat for SPKLU but structurally present |
| `OCPP_MIN_SECURITY_PROFILE` | `0` | Set to `2` for anything internet-facing |
| `OCPP_AUTO_ADOPT` | `true` | Development only. In production unknown chargers are parked for adoption |

---

## Production deltas

This is a scaffold with a working vertical slice, not a deployment. Before production:

1. **Split the gateway out.** Its lifecycle differs from the API — a billing deploy must
   never drop 4,000 charger WebSockets. `npm run gateway` and `npm run api` already run
   separately; they need a real transport between them.
2. **Move the connection registry and event bus to Redis.** `src/ocpp/registry.ts` and
   `src/services/events.ts` are the seams; both are already isolated behind small interfaces.
3. **Replace `setInterval` workers with BullMQ.**
4. **Make `meter_value` and `ocpp_frame` TimescaleDB hypertables** with compression. Without
   it, frame-log retention is two weeks rather than ninety days.
5. **Real identity.** `principalFor()` in `src/api/server.ts` returns a development principal.
   The authorization checks around it are the real thing; only the identity source is stubbed.
6. **Real payment provider.** Implement `PaymentProvider` against Xendit (e-wallet
   tokenisation, xenPlatform splits) and Midtrans (QRIS, VA, card pre-auth).
7. **Enable Postgres row-level security** as a second line of defence behind the query-layer
   scoping.
8. **Set `OCPP_MIN_SECURITY_PROFILE=2`** and provision `AuthorizationKey` per charge point —
   set the key *first*, then raise the profile, or the charger is bricked.
