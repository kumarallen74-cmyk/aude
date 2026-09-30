# PlugSure v1.3.0 — Acceptance demonstration (SPEC-UI-CSMS-2026-FINAL §6)

Run this live, in the console, with no terminal open after step 0.

## 0. Preparation (the only CLI steps)

```
npm ci && npm run typecheck && npm test        # must be clean
npm run migrate
node dist/db/create-admin.js --email ops@cpo.id --name "Ops Lead" --org-slug cpo --org-name "PT CPO"
```

Configure `INTERNAL_API_TOKEN`, `GATEWAY_INTERNAL_URL`, `EVENT_RELAY`,
`PUBLIC_BASE_URL`, `OCPP_PUBLIC_URL` as in RELEASE-NOTES-v1.3.0.md.

## 1. Zero CLI dependency

1. Sign in; change the one-time password when prompted.
2. **Sites → Create site**: e.g. *Star Charger Hub — Thamrin*, 3171, L/TM,
   250 kVA, PF 0.95, SPKLU `01.POSO.20.3171.011`, PBJT 1000 bps. The computed card
   shows 237.5 kW, "TM (above the 200 kVA cliff)", 10,000 kWh rekening minimum.
3. **Charge points → Add charge point**: identity, OCPP 1.6-J, vendor/model, site,
   Profile 2 with a generated key and 90-day reminder, two DC CCS2 EVSEs of 120 kW
   with tera expiry dates → Register & commission.
4. Load the commissioning JSON / QR (or the key + URL) into the charger or
   `npm run sim` from a *second* machine, and power it on.
5. **Pass:** the wizard shows **"Hardware Connected & Adopted"** with the reported
   vendor, model and firmware.

## 2. Subscription clamp enforcement

1. **Load management** → the Thamrin site → type 260 kW (or drag past the mark).
2. **Pass:** the input turns red, the message *"Exceeds 250 kVA PLN contract limit.
   Clamped to prevent breaker trip."* appears and the value snaps back to 237.5 kW.
3. API check (optional): `PUT /v1/sites/<id>/power/budget {"ceilingW":260000}` → 422.

## 3. Emergency cable release (< 3 s)

1. Start a session on gun 1 (Remote control → Start, any card).
2. Remote control → **Unlock cable** → confirm; time it.
3. **Pass:** the connector releases within 3 s (the command is sent at priority 0,
   ahead of any provisioning traffic; measure on real hardware — the simulator
   only proves the round trip).

## 4. Indonesian tax breakdown

1. Assign a tariff to the site (Tariffs → plan → Assign), run and stop a session.
2. **Sessions & Revenue** → the session → **Receipt**.
3. **Pass:** the receipt shows Subtotal, **PBJT-TL x %**, **DPP nilai lain (11/12 × price)**,
   **PPN 12 % × DPP (effective 11 %)** and the total.

## Also demonstrate (modules 5–10)

- Tariff wizard rejects a Rp 2,850/kWh peak price (above the Rp 2,467.50 ceiling).
- RFID: issue a card via **Scan from live charger**; block it; push the local list.
- Configuration: fetch keys, change `HeartbeatInterval`, observe the status tag.
- FOTA: upload an image, run a campaign on one charger, watch the tracker reach Verified.
- Diagnostics: request logs with the built-in receiver; open the viewer.
- Users: invite a Site Host scoped to one site; sign in as them and confirm they
  see only that site and no command buttons.
