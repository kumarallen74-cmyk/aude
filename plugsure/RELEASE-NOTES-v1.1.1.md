# PlugSure CSMS v1.1.1 — Release Notes

**Date:** 7 September 2026 · **Milestone:** 2 · **Supersedes:** v1.1.0 (same day) · **Baseline:** v1.0.0 (1 Sep 2026)

## Summary

v1.1.1 is v1.1.0 plus **committed automated tests for the OCPP 2.0.1 adapter**.
No runtime behaviour changed versus v1.1.0; the only functional edit was an
internal, behaviour-preserving refactor that made the 2.0.1 mapping unit-testable.

As with v1.1.0: OCPP 2.0.1 is **additive and disabled by default**, the 1.6J path
is byte-for-byte unchanged from v1.0.0, there are **no DB migrations**, and **no
config changes are required** to deploy. Deploy exactly as v1.0.0.

## What v1.1.x adds over v1.0.0 (recap)

OCPP **2.0.1** support alongside 1.6J, negotiated per connection so both coexist.
New: `src/ocpp/schemas201.ts`, `src/ocpp/adapter201.ts`. Modified (1.6 preserved by
defaulting to `ocpp1.6`): `validate.ts`, `rpc.ts`, `server.ts`, `adapter16.ts`.
Enable with `OCPP_VERSIONS=ocpp1.6,ocpp2.0.1` (test-env first; certify with a 2.0.1
simulator / dual-stack hardware / OCTT before production).

## New in v1.1.1

- **`src/ocpp/validate201.test.ts`** — version scoping (2.0.1 actions known only on
  2.0.1; 1.6 actions only on 1.6; `ocpp2.1` resolves to the 2.0.1 set) and 2.0.1
  request/response schema validation, including that a 1.6-shaped frame is rejected
  on a 2.0.1 connection and that the 1.6 path is unaffected.
- **`src/ocpp/adapter201.test.ts`** — the pure 2.0.1→canonical mapping: meter-value
  reshaping (`unitOfMeasure.unit` → flat unit, kWh→Wh), TransactionEvent
  field-for-field mapping, deterministic retry-safe idempotency key on Started,
  no key on Updated/Ended, `meterStopAbsent` on Ended, and the trigger/status maps.
- **Refactor (behaviour-preserving):** the mapping in `adapter201.ts` was extracted
  into an exported pure function `toCanonicalTransactionEvent201(ctx, payload)`; the
  I/O (auth + session write) stays in the handler. No change to what goes on the wire.

## Verification (this release)

- `npm run typecheck` → clean.
- `npm test` → **162 unit tests passing, 0 failing** (was 136 in v1.0.0/v1.1.0; +26
  new 2.0.1 tests).
- The full existing OCPP suite (55 cases) still passes unchanged — 1.6J unaffected.

## Upgrade

Drop-in from v1.0.0 or v1.1.0. Same build/run steps, same env, no migrations. If you
are not using 2.0.1 yet, deploy and do nothing further — it stays dormant.
