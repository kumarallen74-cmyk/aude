# PlugSure driver app — phone pilot runbook

How to get the **real** driver app (not the offline demo) onto iPhones and
Android phones, hitting the real `/d/v1` API, for a closed pilot.

This layers on top of `deploy/README.md` — it does **not** replace it. The base
runbook stands up Postgres, the API process (port 9200) and the OCPP gateway
(port 9220) behind Caddy. The driver app is served by the **API process** at two
paths:

```
/app        the mobile web app (static PWA)      -> src/driver-web
/d/v1/*     the driver API (device-token auth)    -> src/driver
/d/health   public health probe
```

The base runbook keeps port 9200 **loopback-only** (operators reach the console
over an SSH tunnel). For a phone pilot we expose **only** `/app` and `/d/*` to
the internet over HTTPS — never `/` (console) or `/v1/*` (operator/admin API).

> **Why HTTPS is non-negotiable for phones.** The in-app QR scanner uses the
> camera, and browsers only grant camera access on a *secure context* (HTTPS or
> localhost). Over plain `http://<ip>` the scanner is dead and the PWA won't
> install. Every path below terminates TLS.

---

## Decide two things first

**1. How payments get captured (no real QRIS acquirer yet).**
The QRIS provider is still the platform mock, so a real bank QR won't capture.
Both mock-capture endpoints — the driver's `confirm-payment` and the operator's
`simulate-payment` — are **development-only** (`config.env !== 'development'` →
403). So pick one:

| Mode | How a payment is captured | Security posture |
| --- | --- | --- |
| **Dev-mode pilot** (fastest) | The app's own "Simulasikan pembayaran (demo)" button works; OTP codes are returned in-app | `NODE_ENV=development` loosens RLS posture and returns OTP codes — acceptable **only** behind an unguessable host + IP allow-list, never public |
| **Prod-mode pilot** (cleaner) | Keep `NODE_ENV=production`; an operator flips the intent to `captured` (psql one-liner below, or a real provider webhook when it ships) | RLS in force, OTP codes hidden — the correct posture; costs one manual step per payment |

For a small supervised pilot, **prod-mode + manual capture** is recommended.
Dev-mode is fine for a quick internal UX test you control end to end.

**2. What acts as the charger.**
The live-charging screen only moves when a real OCPP session feeds it meter
values. Two options, and they are **not** equivalent:

- **A real Autel charger (recommended).** The full one-tap loop works: phone
  pays → app sends `RemoteStartTransaction` → charger starts → meter values →
  the ring climbs → stop → receipt. Commission it per `deploy/README.md` §4 and
  `deploy/AUTEL-HANDOUT.md`.
- **The bundled simulator (`tools/simulator/autel-sim.ts`).** It validates the
  session/billing/receipt path, but it is **charger-initiated** — it does *not*
  listen for the app's `RemoteStartTransaction`. So the phone's "Mulai isi"
  button won't drive it directly; you drive the session from the charger side
  using the claim token as the idTag (see §5). Good for backend validation, not
  a clean one-tap phone demo.

---

## 1. Fastest path — a tunnel (same-day, no DNS/EIP)

For a quick pilot on your own phones without provisioning DNS, an Elastic IP or
certificates, put a tunnel in front of the **driver paths only**. This gives an
instant HTTPS URL (so the camera works) and never exposes the console.

Run the stack per `deploy/README.md` §5 (dev-mode is fine here). Then, on the
box, expose only `/app` and `/d` — a tiny local reverse proxy scopes the paths,
and the tunnel points at that:

```bash
# 1) a path-scoped local proxy on :8088 that ONLY forwards the driver surface
cat > /tmp/driver-only.Caddyfile <<'EOF'
:8088 {
  @driver path /app /app/* /d /d/*
  handle @driver { reverse_proxy 127.0.0.1:9200 }
  handle { respond "PlugSure driver app pilot." 404 }
}
EOF
caddy run --config /tmp/driver-only.Caddyfile &

# 2) tunnel the internet to :8088  (Cloudflare Tunnel shown; ngrok http 8088 works too)
cloudflared tunnel --url http://127.0.0.1:8088
# -> prints https://<random>.trycloudflare.com   ← open THIS on the phone, at /app
```

Open `https://<random>.trycloudflare.com/app` on the phone. Because the proxy
only matches `/app*` and `/d/*`, requests to `/` or `/v1/*` get a 404 — the
operator console and admin API are never reachable through the tunnel.

Tunnels are ephemeral (the URL changes on restart) and unsuitable for a real
charger's fixed Central System URL — they are for driver-app phone testing only.

---

## 2. Durable path — Caddy site block on your own hostname

When you want a stable pilot URL (and eventually a real charger), add a
**separate hostname** for the driver app alongside the OCPP one. Point a second
`A` record at the Elastic IP:

```
app.example.id.   A   <ELASTIC_IP>   TTL 300
```

Append this block to `/etc/caddy/Caddyfile` (it mirrors the OCPP block's
"expose only what belongs on the internet" discipline):

```caddy
# =============================================================================
# Driver app — the ONLY other internet-exposed surface. Serves /app and /d only.
# The operator console (/) and admin API (/v1/*) are NOT routed here.
# =============================================================================
app.example.id {
	@driver path /app /app/* /d /d/*
	handle @driver {
		reverse_proxy 127.0.0.1:9200 {
			# Truthful, unspoofable forwarding metadata (same rationale as the OCPP block)
			header_up X-Forwarded-Proto {http.request.scheme}
			header_up X-Forwarded-Host {http.request.host}
			header_up X-Forwarded-For {http.request.remote.host}
			header_up X-Real-IP {http.request.remote.host}
			header_up -X-Forwarded-Ssl
			header_up -X-Forwarded-Scheme
			header_up -Forwarded
			transport http { read_timeout 120s dial_timeout 5s }
		}
	}
	# Everything else on this host is not part of the driver contract.
	handle { respond "PlugSure driver app." 404 }

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		-Server
	}

	# Optional but recommended for a closed pilot: allow-list the testers' IPs.
	# @notpilot not remote_ip 203.0.113.0/24 8.8.8.8/32
	# respond @notpilot "forbidden" 403

	log { output file /var/log/caddy/driver-access.log { roll_size 50MiB roll_keep 10 } format json }
}
```

Then:

```bash
sudo sed -i 's/app\.example\.id/app.<your-domain>/g' /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo journalctl -u caddy -f     # watch for "certificate obtained successfully" for app.<domain>
```

Because `API_HOST=127.0.0.1` (base runbook), 9200 is still unreachable directly;
Caddy is the only way in, and only for `/app` and `/d/*`.

> **Set the security group** to allow 443 and 80 (ACME) as the base runbook
> already requires. No new ports. Test the certificate with the Let's Encrypt
> **staging CA first** (README §3) — a wrong DNS record burns the production rate
> limit.

---

## 3. Pilot environment

Start from the base `plugsure.env` (README §4) and adjust for the pilot:

**Prod-mode pilot (recommended):** keep everything at the README's production
values — `NODE_ENV=production`, RLS in force, `OCPP_MIN_SECURITY_PROFILE=2`,
`OCPP_AUTO_ADOPT=false`. Nothing to change for the driver app itself; it runs
under RLS as a platform surface (verified in the fourth audit). Payments are
captured manually (§4).

**Dev-mode pilot (quick):** set `NODE_ENV=development`. This makes the app's
"Simulasikan pembayaran (demo)" button and in-app OTP codes work with no
operator action — at the cost of the looser posture noted above. Do **not** run
dev-mode on a public hostname without an IP allow-list.

Either way, confirm RLS on boot if you're in production mode:

```bash
docker compose logs api | grep 'row-level security'
# -> "row-level security is in force for application queries"
```

---

## 4. Capturing a mock payment in prod-mode

After the driver taps pay, the app shows the QR and polls for capture. Flip the
intent to `captured` and the phone advances automatically. The safest capture is
by the driver's charge id (visible in the app URL / logs) or the newest pending
intent for the org:

```bash
# capture the most recent pending prepaid intent (one supervised payment at a time)
psql "$DATABASE_URL" -c "
  UPDATE payment_intent
     SET state='captured', amount_captured_minor=amount_authorised_minor,
         captured_at=now(), updated_at=now()
   WHERE id = (SELECT id FROM payment_intent
                WHERE state='pending' AND mode='prepurchase'
                ORDER BY created_at DESC LIMIT 1)
  RETURNING id, amount_authorised_minor;"
```

When a real QRIS acquirer is wired, its webhook does exactly this and the manual
step disappears. (In dev-mode you skip this entirely — the demo button captures.)

---

## 5. Driving a live session

**With a real charger** — nothing extra: the phone's start button sends the
`RemoteStartTransaction` with the minted claim token; the charger begins the
transaction and streams meter values; the app's live ring and receipt follow.
Commission the unit first (README §4). The connector the driver picks in the app
must be a connector that belongs to that registered charge point.

**With the simulator** — the sim won't obey RemoteStart, so drive it from the
charger side using the claim token the app shows on the pay/awaiting-start
screen as the idTag:

```bash
# after the driver has paid and the app shows the claim token (e.g. PS-XXXXXXXX):
npx tsx tools/simulator/autel-sim.ts \
  --id AUTEL-DC60-SMB-002 --session --kwh 8 --idtag PS-XXXXXXXX
```

The sim connects as that charge-point identity, authorizes with the claim token,
runs StartTransaction → MeterValues → StopTransaction; the app reconciles the
session, the ring climbs, and the receipt (with PBJT/PPN and any refund)
renders. Note the sim's identity must be registered/adopted first if
`OCPP_AUTO_ADOPT=false` (README §4), and it connects to the OCPP gateway, not the
driver hostname.

---

## 6. On the phone

1. Open `https://app.<domain>/app` (or the tunnel URL + `/app`).
2. **Add to Home Screen** — iOS Safari: Share → Add to Home Screen; Android
   Chrome: ⋮ → Install app / Add to Home screen. It launches full-screen like a
   native app (this is the PWA; there is no App Store / Play Store build).
3. Walk the flow: find a station → pick a connector → choose an amount → pay →
   (capture per §4 if prod-mode) → live session → receipt → history.
4. Sign-in: phone OTP (dev-mode shows the code in-app; prod-mode needs a real SMS
   provider, still mock here) and fleet RFID+PIN.

### Phone caveats to expect (not bugs)

- **QR camera scan works on Android Chrome, not iOS Safari.** iOS doesn't
  implement the browser `BarcodeDetector` API, so on iPhone the scanner falls
  back to "Masukkan kode manual" (type the charger code). If native-feeling iOS
  scanning matters for the pilot, swap in a JS scanner library (jsQR / ZXing) —
  ask and I'll wire it.
- **Camera needs HTTPS** (handled by every path above) and a physical camera +
  the user granting permission.
- **QRIS payment and OTP SMS are still mock providers.** No real money moves; no
  real SMS is sent. Wire the real acquirer + SMS gateway before any public
  launch.
- **Not native.** No push notifications, no app-store listing — it's an
  installable web app by design.

---

## 7. Pilot pre-flight checklist

- [ ] Stack up per README §5; `row-level security is in force` in the logs (prod-mode).
- [ ] Payment-capture decision made (§0/§4): dev-button or manual/webhook.
- [ ] Charger decision made (§5): real Autel commissioned, or simulator ready.
- [ ] Driver surface reachable over **HTTPS**, console/admin **not** (curl `/`, `/v1/health` on the public host → 404).
- [ ] `GET https://app.<domain>/d/health` → 200.
- [ ] One full loop completed on an Android phone and an iPhone (expect the iOS scan fallback).
- [ ] If public: IP allow-list on the Caddy block, and **not** dev-mode.
```

---

## 8. App Store / Google Play review: the reviewer's sign-in (v1.9.1)

Sign-in is by SMS code, and the store reviewers (Apple App Review, Google Play review) cannot receive one. For the
review only, give them a demo number whose code is fixed:

```bash
# in the API's environment (.env, the systemd unit's EnvironmentFile, or the container's env), then restart the API
DRIVER_REVIEW_PHONE=+6281299990001     # a number you control or none at all; any spelling of a +62/+60/+65 mobile
DRIVER_REVIEW_CODE=583920              # six random digits — 000000, 123456, 111111, 121212, runs… are refused
```

- A code requested for exactly that number is **not sent** to any provider: the fixed code is stored instead (hashed,
  same 5-minute expiry, bound to the requesting device), so "Verify" works as for any driver. The account-deletion
  code (in the app and on `/account/delete`) works the same way for that number.
- Every rate limit still applies (one code a minute, per number / address / device / installation caps, wrong-code
  budget). Each use writes a **warning** to the API log: `review sign-in code issued (DRIVER_REVIEW_PHONE)`, number
  masked.
- Both must be set, or neither. A number that does not normalise or a weak code **stops the API from starting**, with
  the reason in the log.
- Put the number and the code in the review notes (App Store Connect → App Review Information → Sign-in required;
  Play Console → App content → App access), with a sandbox charger QR for the charging flow.

**After approval, remove both variables and restart the API.** The number then signs in like any other (an SMS to a
number nobody receives), and the fixed code no longer works. Re-add them only for the next review.
