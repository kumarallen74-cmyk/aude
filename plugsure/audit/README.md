# Audit artefacts — 23 August 2026

Test scripts written by four independent auditors during the verification pass. They are
preserved because they are reproductions, not documentation: each one demonstrates a finding
in `docs/VERIFICATION-REPORT.md`.

| Directory | Track | Notable scripts |
|---|---|---|
| `ocpp/` | OCPP 1.6J conformance | `t1` framing/malformed frames · `t2` schema validation · `t3` handshake and URL shapes · `t4` adapter semantics · `t5` smart charging · `t6` robustness · `t7` command latency · `t9` identity takeover |
| `security/` | Security & multi-tenancy | `probe.sh` cross-tenant read/write · `seed_org_b.sql` second tenant · `audit_attack.ts` hash-chain forgery · `xss_render.mjs` attribute-context XSS |
| `billing/` | Billing correctness | `01-tax` rounding drift · `02-tariff` tiers and ToU · `02b-clock` event-loop blocking · `03-inverse` prepaid allowance · `04-lifecycle` replay and idempotency · `05-tariff-asof` retroactive pricing · `06-prepaid-concurrency` · `07-meter-authority` |
| `readiness/` | Operational readiness | URL/subprotocol probes, restart and reconnect tests, commissioning-failure evidence checks |

These were run against isolated databases (`plugsure_audit_a`…`_d`) on ports 9301–9304 / 9321–9324.
They do not modify anything under `src/`, `db/` or `tools/`.
