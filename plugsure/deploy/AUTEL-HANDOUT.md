# PlugSure CSMS — OCPP 1.6J integration details for Autel

**Send this document to Autel. Send the AuthorizationKey separately, by a different channel.**

Replace every `<…>` placeholder before sending. Nothing else in this document should change.

---

## 1. Connection

| Setting | Value |
|---|---|
| **Central System URL** | `wss://<ocpp.your-domain.id>/ocpp/{chargePointIdentity}` |
| Example | `wss://ocpp.plugsure.id/ocpp/AUTEL-DC60-JKT-001` |
| Transport | WebSocket over TLS 1.2+, port 443 |
| **WebSocket subprotocol** | `ocpp1.6` — **only** |
| OCPP security profile | **2** (TLS + HTTP Basic) |
| HTTP Basic username | the `chargePointIdentity`, byte-for-byte |
| HTTP Basic password | the `AuthorizationKey` — **sent separately** |
| Server certificate | Let's Encrypt. The charger's trust store must contain **ISRG Root X1** |
| Client certificate | not required (profile 3 / mTLS is not enabled) |

**The identity is the last path segment of the URL and is also the Basic username.**
They must match exactly — same case, same characters. Permitted characters are
`A–Z a–z 0–9 . _ : -`; no spaces and no `/`.

**A unit that offers only `ocpp2.0.1` will be refused with HTTP 400.** Autel's
dual-stack DC units must be configured for OCPP 1.6J. We advertise only 1.6
deliberately: advertising a version we do not fully implement would be worse than
not offering it.

### On the unit (Autel MaxiCharger)

*Settings → OCPP*

| Field | Value |
|---|---|
| OCPP version | OCPP 1.6J |
| Central System URL | as above, including `/ocpp/` and the identity |
| Charge Point Identity | as agreed per unit |
| Authorization Key | as sent separately |
| Security profile | 2 |
| HeartbeatInterval | 300 s (our BootNotification response returns this) |
| MeterValueSampleInterval | 60 s recommended |

Reconnect behaviour: exponential backoff, minimum 10 s. **Do not retry rapidly on
a 401** — that means the key is wrong, not that we are busy.

---

## 2. What each rejection means

Every connection attempt is logged on our side with its outcome, source IP, offered
subprotocols, TLS state and whether credentials were presented. If a unit will not
connect, tell us the identity and a UTC timestamp and we can say exactly why —
usually within a minute.

| Status | Cause | Fix |
|---|---|---|
| `101` | Success — the WebSocket is open | — |
| `400` | No supported subprotocol offered | Set the unit to OCPP 1.6J |
| `401` | Missing or wrong Basic credentials | Check the username is the identity and the key matches |
| `403` | Connected without TLS at security profile 2 | Use `wss://`, not `ws://` |
| `404` | Identity not registered with us | Send us the exact identity string; we register it |

A `BootNotification` answered **`Pending`** rather than `Accepted` is not an error:
it means the unit has reached us and authenticated, but has not yet been approved
by an operator. Tell us and we will activate it.

---

## 3. What we need from Autel

Before commissioning, for each unit:

1. **Charge point identity** — exactly as it will be configured. We register it in
   advance; an unregistered identity is refused.
2. **Vendor, model, firmware version and serial number** as the unit will report
   them in `BootNotification`.
3. Confirmation the unit will run **OCPP 1.6J** (not 2.0.1) for this test.
4. Confirmation the trust store contains **ISRG Root X1**.

If the firmware deviates from OCPP 1.6 in any way you already know about — a field
longer than the spec allows, a numeric value where the spec says string, an
undocumented `DataTransfer` vendorId — please tell us rather than leaving us to
discover it. We record deviations rather than dropping frames, but we would prefer
to expect them.

---

## 4. Commissioning checklist

1. Set the URL, identity, AuthorizationKey and security profile on the unit.
2. Power-cycle. Confirm `BootNotification` returns **Accepted**.
3. Confirm heartbeats arrive every 300 s.
4. Plug in a vehicle, start a session, let it run a few minutes, stop it.
   Confirm `StartTransaction`, `MeterValues` and `StopTransaction` all appear.
5. Confirm the energy we bill matches the unit's own meter reading.

We will be watching the frame log live throughout and can read back every message
in both directions.

---

## 5. What we will test together

Beyond a session working at all, these are the behaviours we specifically need to
observe on real hardware, because a simulator cannot settle them:

- **Which `MeterValues` measurands the unit actually emits**, whatever we request.
- **Whether the unit accepts `SetChargingProfile`**, in which unit (A or W), and
  whether a `TxDefaultProfile` sent to connector 0 reaches the connectors.
- **Whether `GetCompositeSchedule` returns something trustworthy.** Implementations
  vary widely; we never make load management depend on it until we have measured it.
- **How a dual-gun DC unit splits its station power** between connectors. OCPP 1.6
  does not specify this, so it is vendor-defined and has to be observed.
- **Meter register width and rollover behaviour**, and whether `transactionData` and
  `meterStop` ever disagree.
- **Behaviour across a WAN outage**: whether the unit buffers and replays
  transactions, and in what order.
- **The final register in `StopTransaction`** — whether it is ever absent, and
  whether it can be lower than the last `MeterValues` sample.

None of these need a separate test run; they fall out of a normal session if we
are watching. We will send you a written summary of what we observed.

---

## 6. Support

| | |
|---|---|
| Contact | `<ops@your-domain.id>` |
| Include | the charge point identity **and** a UTC timestamp |

We look every incident up by those two fields, so both matter.

---

## 7. Key handling

The `AuthorizationKey` is sent by a separate channel from this document, and never
appears in it.

Rotate it after commissioning. Both the old and the new key are accepted for 24
hours after rotation, so there is no downtime and no coordinated restart: set the
new key on the unit at any point in that window.
