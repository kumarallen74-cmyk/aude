# PlugSure CSMS v1.2.1 — Release Notes

**Date:** 26 September 2026 · **Baseline:** v1.2.0 · **Type:** patch (additive)

## Summary
Adds a hard clamp so the load manager can never allocate power past a site's
subscribed capacity (connected_kVA × PF). Fixes the Load Management issue where the
Star Charger Hub's managed ceiling was set to the full installed nameplate
(240 kW = 252.63 kVA) — above its 250 kVA subscription.

## Changes vs v1.2.0
- `src/services/smartcharging.ts` — new exported helpers `subscriptionCeilingW()` and
  `clampCeilingW()`; `loadSiteBudget()` now clamps the effective ceiling to
  connected_kVA × PF and logs a warning when a stored ceiling had to be clamped.
- `src/services/capacity.test.ts` — NEW, 8 unit tests (incl. the exact 240 kW → 237.5 kW case).

## Behaviour
- Additive and safe: a correctly-set ceiling (≤ subscription) is unchanged; only a
  too-high one is pulled down.
- Retroactive at read time: the effective ceiling is corrected on the next read even if
  `ceiling_w` is still stored too high — and a warning is logged pointing at the bad config.
- No DB migration; no required config change.

## Also do (config)
Correct the affected site's stored budget: `ceiling_w = 237500` (250 kVA × 0.95),
`reserve_w = 7500` (~3% margin), via `PUT /v1/sites/<siteId>/power/budget`.

## Verification
`tsc --noEmit` clean; `npm test` **183 passing / 0 failing** (+8 vs v1.2.0's 175).
Run these against your v1.2.0 checkout after applying to confirm in your environment.
