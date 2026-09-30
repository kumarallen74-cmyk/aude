# PlugSure — Verification & Validation

**Question asked:** is the platform ready to hand to Autel so they can point a real MaxiCharger at it?

**Answer after three independent audit passes and three remediations: not yet, but the remaining
gap is small and named.** 23 August 2026.

---

## 1. What actually happened

This document exists because the first answer was wrong, and so was the second.

| Pass | Auditors | Findings | What the remediation did |
|---|---|---|---|
| **1** | 4 (OCPP, security, billing, readiness) | 33 | Closed the large majority. Introduced 3 new defects. |
| **2** | 3, blind, isolated databases | 34 | Closed the criticals. Introduced 1 new CRITICAL. |
| **3** | 3, blind, isolated databases | 33 | Closed all criticals and highs. Verified live. |

Read that table before reading anything else in this report. **Every remediation pass so far has
introduced at least one defect larger than something it fixed.** The most recent example is the
worst: a change made to switch Postgres row-level security on — a security improvement — used
`AsyncLocalStorage.enterWith`, and because Node reuses HTTP parser objects process-wide, the API's
database client leaked into the OCPP gateway. Two auditors reproduced it independently. After any
browser request to the console, **every BootNotification failed and the process died.**

That pattern is the single most important finding in this document, and it is not about any
individual bug. A codebase this size, with this much regulatory and protocol surface, does not
converge by inspection. It converges by adversarial reproduction, and the reproductions have to be
re-run after every change.

---

## 2. Method

Auditors worked in parallel, in isolated databases on separate ports, without sight of each other's
findings, and were instructed to run reproductions rather than reason from the code. They were told
explicitly not to trust a comment claiming something was fixed — in passes 2 and 3, several such
comments were false.

| Pass | Track | Isolation |
|---|---|---|
| 1 | OCPP conformance / security / billing / readiness | `plugsure_audit_{a,b,c,d}`, ports 930x/932x |
| 2 | protocol+ops / security / billing | `plugsure_rv_{a,b,c}`, ports 950x/952x |
| 3 | protocol+ops / security / billing | `plugsure_r3{p,s,b}`, ports 96xx–98xx |

Every finding below carries a `file:line` and a reproduction that was executed. Findings that could
not be reproduced were dropped by the auditor who raised them.

---

## 3. What the third pass found, and what was done

### Critical — money invented or given away

**A young meter's backwards reading was billed as a register wrap.**
`detectRollover` accepted any candidate whose implied delivery was under 500 kWh. For any starting
register below 65,536 Wh the 16-bit candidate always satisfies that, so **100 % of backwards
readings in that band were billed as real energy** — up to 65 kWh that a UTTP-certified meter never
registered. Every newly commissioned charger sits in that band, as does every board or meter
replacement. A unit that started at 45,000 Wh and reported 0 at StopTransaction billed Rp 140,645 of
electricity that did not exist.
*Fixed:* a wrap now has to look like one — the start register near the top of its width and the stop
register restarted near zero — and the 16-bit candidate is gone. Verified live: that session is now
parked as `METER_WENT_BACKWARDS` with no CDR. Eight unit tests, including an exhaustive sweep of the
whole sub-65 kWh band.

**A tariff created through our own API, passed by our own validator, billed the same kWh twice.**
Tier bounds were derived per ToU block, so an `ANY` component and a `WBP` component never truncated
each other. A 40 kWh session invoiced 80 kWh at 2× the regulated ceiling — Rp 115,035 overcharged —
with `needs_review = false` and no regulatory flag. The CDR stated a quantity the meter could not
support, which is a faktur-pajak problem independently of the money.
*Fixed:* a delivered kWh belongs to exactly one ToU block, and within that block exactly one
component prices it; a block-specific price shadows the catch-all. A `DOUBLE_PRICED_ENERGY` check now
exists alongside `UNPRICED_ENERGY` — there had been a detector for undercharging and none for
overcharging, which is the direction that reaches a customer.

**A QRIS pre-purchase had no payer.**
Checkout recorded an amount and a connector and nothing else, and the allowance went to whoever
started the next transaction on that connector. A driver who scanned the QR and paid Rp 500,000 lost
all of it to anyone who plugged in first, and `grep -rn refund src/services` returns nothing — there
is no refund path in the system to make them whole. The same ordering silently orphaned the earlier
of two queued payers.
*Fixed:* an intent now names the token that may claim it. A driver with a token supplies it; a
walk-up — the case QRIS exists for — gets a single-use token minted at checkout and shown on the
payment screen. Verified live: an unrelated RFID starting on that connector gets a plain postpaid
session, and only the payer's token claims the Rp 500,000.

**The gateway died on any database error at connect or disconnect.**
`void assets.setChargePointStatus(...)` with no `.catch()`, under Node 22's default
`--unhandled-rejections=throw`. One transient error closed **every other charger's socket on the
box**, and `deploy/plugsure-gateway.service` has `StartLimitBurst=5` — five of those inside five
minutes and systemd stops restarting altogether.
*Fixed:* the status writes are caught, and each entrypoint installs `unhandledRejection` /
`uncaughtException` handlers **after** startup, so a genuine startup failure (a port already bound,
a missing secret) still exits rather than lingering as a zombie.

**The request-scoped database client leaked into the gateway** — the regression described in §1.
*Fixed:* `AsyncLocalStorage.run` established in an `onRequest` hook, never `enterWith`, plus a guard
in `conn()` that refuses to serve a query from a released client. Verified with the auditor's own
reproduction: 6/6 clean boots where it was 0/6.

**There was no `DATABASE_URL` a production process would start with.**
Two gates that excluded each other: as a superuser, `assertRlsPosture()` refuses to start (a
superuser bypasses every RLS policy, so the "second line of defence" would be decorative); as
`plugsure_app`, the gateway's boot-time `CREATE SEQUENCE IF NOT EXISTS` failed with *permission
denied for schema public* — Postgres checks the ACL before `IF NOT EXISTS` short-circuits, so it
failed on every start for a sequence that already existed. And migration 002 created the role
`NOLOGIN` with no password, so the error message's own advice could not be followed.
*Fixed:* the sequence moved into migration 006, the role gets `LOGIN` and its grants, the migrator
provisions its password, and `docker-compose.yml` points the app services at it. Verified live: the
stack now starts under `NODE_ENV=production` logging **"row-level security is in force for
application queries"** — which it had never done before.

### High

- **An unbounded idle fee** billed Rp 6,692,360 for a 60 kWh delivery, 32.4× the legal maximum,
  automatically and unflagged. Now bounded at save time and capped on the invoice; the same session
  bills Rp 300,204.
- **`plnScheme: 'none'` switched the energy ceiling off entirely** — Rp 10,000/kWh saved and billed
  with no flag, 4.05× the ceiling. The scheme is a property of the supply, not a field a tariff opts
  out of; an unstated scheme now resolves to layanan khusus.
- **The idle-minute detector was wrong in both directions.** `ORDER BY value DESC` is not "the last
  increase": a post-charge maintenance trickle collapsed idle to zero (so the occupancy fee never
  fired), and after a register wrap it inflated to nearly the whole session (so a customer was
  charged for time they spent charging). Now the last materially-increasing sample.
- **A parked session could never be billed by anyone.** Re-rating hit the same violation and
  re-parked, `force: true` had no caller anywhere in the codebase, and the route answered HTTP 200
  `{"ok": false}` — which a console reads as success. Every session on a misconfigured connector
  accumulated the same permanent loss.
- **Prepaid sessions were never reconciled against what was collected**, in either direction:
  measured deltas from −Rp 58,552 (energy given away to a guest with no card on file) to +Rp 26,869
  (money kept for energy never delivered). The allowance now reserves the worst case, and any
  remaining delta is recorded and alerted; a refund owed parks the session.
- **The load optimiser sent a permanent 0 A ceiling to every idle charger.**
  `ChargePointMaxProfile` is persistent by design, so this is not a momentary instruction — it is a
  charger stranded at zero amps until the CSMS comes back. And a unit reporting `Preparing`
  (which OCPP 1.6 specifies for "plugged in, not energised") deadlocked: held at 0 A it cannot
  energise, so it never reports Charging, so it is never allocated power.
- **A charge point could walk itself out of `pending_adoption`** through the station-level
  StatusNotification path and start billing sessions no operator had ever approved.
- **The documented production configuration still refused every charger.** `OCPP_TRUST_PROXY_PROTO`
  was required for profile 2 behind Caddy and appeared in no documentation, `.env.example`, compose
  file or systemd unit. The gateway logged a cheerful "listening" and answered 403 to everything.
  Now documented, and the gateway **refuses to start** in that combination.
- **The commissioning runbook could not be followed.** Two of its four steps named endpoints that did
  not exist. `POST /v1/charge-points` now exists (pre-registering an identity is the right model),
  and the section is rewritten around the routes that are actually there — including `/activate`,
  which is what moves a unit out of `pending_adoption` and had never been mentioned.
- **`npm ci` was broken** by a `@types/ws` version that does not exist, blocking both documented
  deploy paths. Flagged as a known blocker for two audits without being fixed. Fixed.
- **Ordinary API calls destroyed the audit chain's tamper-evidence.** `canonicalJson` maps an
  `undefined` property to `null`, but `JSON.stringify` drops the key on the way into JSONB — so the
  MAC was computed over a body the database never stored, and verification reported `mutated`
  forever. One `POST /v1/api-keys` with the optional `name` omitted marked a tenant's entire
  seven-year log broken. Worse than useless: it trains an operator to ignore the one alarm that
  matters. Fixed and verified live.

### Medium and low

`StopTransaction` without `meterStop` was rejected, stranding the session forever while the
running-total fallback written for exactly that case sat unreachable behind the validator; a single
NUL byte permanently bricked a charger's BootNotification; only the first tolerated deviation per
payload was ever recorded; meter-source divergence of any magnitude was billed without review;
`OCPP_PATH` was configured, documented and never enforced (`/ocpp/` enrolled a charge point named
"ocpp"); PBJT was levied on the service fee as well as the energy; full fixed fees were charged on a
zero-energy session; the tariff ceiling was not re-checked at assignment; the quirk registry took a
row lock on every metering frame; the simulator's API-backed assertions had silently degraded to
"not reachable" since bearer auth shipped, so the `happy` scenario's headline check had not run in a
long time; and three vendor-visible statements in the deployment guide contradicted the code.

All fixed. See `git log` for the individual changes.

---

## 4. What was retested and confirmed closed

The third-pass auditors were asked to retest the previous rounds' fixes rather than take them on
trust. These came back closed, with reproductions:

- Privilege escalation via `POST /v1/api-keys` — `platform:admin`, unknown permission strings, nested
  arrays, prototype pollution and cross-org `scopeId` all refused.
- Cross-tenant access on every `/v1/` route tried: frames, NDJSON export, site power, budget writes,
  `Reset`, session-by-id, profile reconciliation, activation, QRIS checkout, adopting into a foreign
  site, assigning a tariff to a foreign connector. All 403 or inert.
- The SSE stream delivers nothing belonging to another tenant, and now fails closed on an unscoped
  event rather than open.
- API keys whose base64url secret contains `_` authenticate — this had silently killed roughly half
  of all issued credentials with an indistinguishable 401.
- The inbound reply cache keys on action and payload as well as MessageId, and never caches
  CALLERRORs, so a transient failure stays retryable.
- The keyed audit chain detects mutation, truncation, reordering and forgery; `audit_head` rollback
  and deletion are refused by database triggers; whole-chain erasure is now detectable because every
  organisation gets a genesis head row at creation.
- Session data integrity under load: offline replay ordered, shuffled and duplicated all bill
  exactly the delivered energy; 20 chargers × 3 kWh billed exactly 60.00 kWh with none needing
  review; duplicate `StartTransaction` returns the original transactionId across a reconnect.
- Framing: 26 hostile and malformed frames answered spec-correctly, socket never dropped.
- Forged `X-Forwarded-For` no longer changes `req.ip`, so it can neither bypass the rate limiter nor
  poison the audit log's client IP.
- The tax arithmetic — DPP nilai lain = 11/12 × price, PPN = 12 % × DPP, PBJT before PPN, capped at
  10 % — is correct, and the DPP stored is the one that goes on the faktur.

---

## 5. Where it stands

**Test coverage:** 125 unit tests, `tsc --noEmit` clean, `npm ci` working.

**Verified live on a clean database, running as a non-superuser with RLS in force:**

| Scenario | Before | After |
|---|---|---|
| 45 kWh meter reporting 0 at stop | billed Rp 140,645 of phantom energy | parked, no CDR |
| 60 kWh + 11 h plugged in | Rp 6,692,360 | Rp 300,204 |
| `StopTransaction` with no `meterStop` | session stuck active forever, never billed | billed 6,000 Wh from the running total |
| Charger faults, 0 Wh delivered | Rp 29,138 of fixed fees | Rp 0 |
| Genuine register wrap | — | 1,700 Wh billed across the wrap |
| QRIS payment, attacker plugs in first | attacker takes Rp 500,000 | attacker gets a postpaid session |
| Console request then BootNotification | process dies | 6/6 clean |
| The documented commissioning sequence | two steps 404 | 5/5 steps succeed |

**Still open, and deliberately so:**

- `OCPP_MIN_SECURITY_PROFILE` defaults to `0` — no per-charger authentication. That is correct for a
  bench and wrong for anything else, the gateway warns loudly at startup, and the deployment guide
  requires `2`. **If the OCPP port is reachable by anyone but you, this must be `2` before the vendor
  connects**: at profile 0 an unauthenticated peer can open a session as any tenant's charger and
  inject telemetry, and the API credential you hand the vendor does not constrain that at all.
- OCPP 2.0.1 is modelled but not implemented. Only `ocpp1.6` is advertised, deliberately.
- The payment provider is a mock. QRIS settlement, refunds and reconciliation against a real acquirer
  do not exist; the settlement delta is recorded and alerted, not actioned.
- There is no refund rail. A prepaid session that over-collects parks itself and raises a critical
  alert for a human.

**What must happen before an Autel unit connects:**

1. Set `OCPP_MIN_SECURITY_PROFILE=2`, `OCPP_AUTO_ADOPT=false`, `OCPP_TRUST_PROXY_PROTO=true`, and
   run the commissioning sequence in `deploy/README.md` §4.
2. Deploy under `plugsure_app`, not the database owner, so RLS is a real second line.
3. Set `AUDIT_HMAC_KEY` and `SECRETS_KEY`, and keep them — rotating the audit key stops every
   previously written entry from verifying.
4. **Run a fourth audit pass.** Three passes have each found real defects in the previous
   remediation. There is no reason to assume this one is different, and the cost of finding out on a
   customer's invoice is much higher than the cost of finding out here.
