# PlugSure — deployment runbook

> ## v1.3.0 additions (read with RELEASE-NOTES-v1.3.0.md)
>
> **API ↔ gateway bridge (required for the split deployment).** The API and the
> gateway are separate processes; the charger sockets live in the gateway. Set the
> same `INTERNAL_API_TOKEN` on both, `GATEWAY_INTERNAL_URL` on the API
> (`http://gateway:9220` in compose, `http://127.0.0.1:9220` with systemd) and
> `EVENT_RELAY=true` on the gateway. Without it the console cannot command any
> charger and shows every charger offline. The gateway's `/internal/*` endpoints
> answer 404 without the token; do not expose port 9220 other than through the
> Caddy `/ocpp/*` route.
>
> **Workers** (load management, compliance, reconciliation, FOTA) run in the
> gateway (`RUN_WORKERS=true`, the default). Set `RUN_WORKERS=false` on any second
> gateway replica. The gateway watches its own health and logs a warning only
> when something is wrong:
> - `gateway health`: event-loop delay over 1 s, queries waiting for a
>   database connection, or a worker pass running over a minute;
> - `worker pass took longer than its interval` or `… overlaps a pass still running`;
> - `gateway paused`: the process did not run for more than 30 s, as when the
>   host sleeps, the VM is suspended, or the event loop blocks. Offline alerts
>   and outage durations from that period are shifted by the pause.
>
> `GATEWAY_DIAG=verbose` adds a health summary every 10 s.
>
> **Driver queue** (migration 033, off until switched on per site under Sites →
> Edit site). Offers to the next driver are made in the gateway:
> - at once, when a connector reports Available to the gateway holding its socket;
> - every 15 s by the reservations worker. This pass also retries a hold the charger refused, and ends waits that ran out.
>
> Keep `RUN_WORKERS=true` on exactly one gateway; nothing else to configure.
>
> **Partner-charger reservations** (migration 034). Fleet drivers with a roaming card
> can reserve a partner operator's charger; PlugSure sends the operator OCPI
> `RESERVE_NOW` / `CANCEL_RESERVATION`, and the charger's answer comes back to
> `/ocpi/2.2.1/emsp/commands/…`. Nothing new to expose. Ask each partner whether it
> accepts reservations.
>
> **Reservation fees** (migration 035). Set per site; paid through the operator's
> payment account like a charge (notifications to `/pay/*`, already exposed), or
> billed on the fleet invoice. Refunds appear under Refunds as usual.
>
> **Partner smart charging and hubs** (migration 036).
> - Partners reach `/ocpi/2.2.1/chargingprofiles/…` and `/ocpi/2.2.1/hubclientinfo/…` under the OCPI path already exposed; nothing new to open.
> - A partner's limit is applied by the API process, which runs the site's load-management pass at once. The gateway's 30-second pass keeps applying it after that.
> - Hub client lists are pulled by the gateway's roaming-import worker every 6 hours.
>
> **Bidirectional charging (V2G / V2B)** (migration 038).
> - Needs OCPP 2.1 stations: add `ocpp2.1` to `OCPP_VERSIONS` on the gateway.
> - Discharge is planned by load management: in the gateway every 30 s, and at once when a car's needs arrive, a car reaches its floor or a driver changes their mind.
> - Nothing flows back to the grid unless a site allows export (a PLN agreement). Otherwise discharge is capped at the site's auxiliary load reserve.
>
> **Signed meter values (OCMF)** (migration 039).
> - Nothing to configure on the servers. Sites default to `record`, so readings are kept and verified and a mismatch warns; nothing is parked.
> - For each calibration-law meter, enter its public key and serial on the connector (Onboard). Without a registered key, readings count only as "unverified key".
> - 2.x stations: switch signing on per charger with `POST /v1/charge-points/:identity/signed-metering`. 1.6 stations: use the vendor's configuration key.
> - Sandbox virtual chargers speak the protocol they are registered with, so the gateway needs `ocpp2.0.1` and `ocpp2.1` in `OCPP_VERSIONS` for sandboxes to use them. Their meter keys derive from `SECRETS_KEY`: rotating it changes the keys, and the new ones must be re-registered. To do that, clear `meter_public_key` on the sandbox connectors and restart the gateway, which registers them again as it starts the virtual chargers.
>
> **White-label driver apps** (migration 040).
> - Operators set up their own driver app in Commercial → Driver app; nothing changes for those who do not.
> - A live app is served on the operator's own web address. Update Caddy from `deploy/Caddyfile`:
>   - the global `on_demand_tls { ask http://127.0.0.1:9200/d/tls-ask }`;
>   - the catch-all `https://` block, which must stay last;
>   - `?X-Frame-Options` on the console host.
>   Then `caddy validate` and reload.
> - The operator points its address at this server with a DNS CNAME. The first HTTPS request issues the certificate, and only names saved in the console are allowed. Port 443 must be reachable from the internet for the ACME TLS-ALPN challenge; port 80 as well if you use HTTP-01.
> - Payment return addresses follow the brand automatically. The acquirer's notification URL stays on the platform host (`/pay/*`).
> - Store apps (Play Store / App Store) are built by the operator from the console's build kit, with its own developer accounts and signing keys.
>
> **Native iOS notifications (APNs)** (migration 041).
> - The gateway's push worker sends to Apple: allow outbound HTTPS (HTTP/2, 443) to `api.push.apple.com` and `api.sandbox.push.apple.com`. A proxy that downgrades to HTTP/1.1 breaks it.
> - Keys are the operators', uploaded in the console and sealed with `SECRETS_KEY`. Rotating `SECRETS_KEY` means uploading them again.
> - `APNS_URL_PRODUCTION` / `APNS_URL_DEVELOPMENT` exist for tests only. Leave them unset; plain `http://` is refused in production.
>
> **API rate limits and SDK** (migration 037).
> - Each API key has its own limit: `API_KEY_RATE_LIMIT_PER_MIN`, default 600 a minute, or set per key in the console.
> - `API_RATE_LIMIT_PER_MIN` still limits the console and other callers per IP.
> - `API_KEY_AUTH_FAILURES_PER_MIN` (default 30) limits keys that do not authenticate, per address.
> - Per-key limits are shared by all API processes through Postgres (migration 052; `API_RATE_LIMIT_SHARED`, default on outside development/test). The per-IP and failed-key limits are still kept per API process.
> - The TypeScript SDK is served at `/sdk/plugsure-csms-sdk.tgz` from the console host (inside the office allow-list). Hand it to integrators, or allow `/sdk/*` in the Caddyfile.
>
> **Console sign-in.** Bootstrap the first administrator once:
> `node dist/db/create-admin.js --email … --name … --org-slug …` (compose:
> `docker compose run --rm api node dist/db/create-admin.js …`). Everyone else is
> invited from *Users & Roles*. Behind Caddy set `API_TRUSTED_PROXIES=127.0.0.1`.
>
> **Charger-facing HTTP.** Set `PUBLIC_BASE_URL` to the OCPP hostname; Caddy routes
> `/fw/*` (firmware downloads) and `/diag/*` (log uploads) there to the API. Keep
> `STORAGE_DIR` on a persistent volume.

Target: **one supervised VM in AWS `ap-southeast-3` (Jakarta)**, TLS on 443, one
physical charger for an integration test. Not Kubernetes, not multi-AZ, not yet.

Two supported paths. Pick one and stay on it:

| Path | What runs the processes | Use when |
| --- | --- | --- |
| **A — Docker Compose** (recommended) | `docker compose` on the VM | you want migrations, restarts and log rotation handled for you |
| **B — systemd** | `plugsure-gateway.service`, `plugsure-api.service`, `plugsure-migrate.service` | no Docker allowed on the box, or Postgres is RDS |

Both paths put **Caddy** in front for TLS. Both run **two separate processes** —
the OCPP gateway and the API — from the same build. That separation is
deliberate: shipping a billing fix must never drop live charger WebSockets.

```
             :443 wss                    :9220 ws
charger ───────────────▶ Caddy ────────────────────▶ gateway ──┐
                           │                                   ├──▶ Postgres 16
operator ── ssh -L ──▶ 127.0.0.1:9200 ────────────────▶ api ───┘
```

---

## 0. Before you start

`npm ci` works on this tree (it did not for two audit passes — the lockfile had
drifted from `package.json`). Confirm it before you build anything:

```bash
npm ci --dry-run     # must end "added N packages", not "ETARGET"
```

Two settings in this runbook are load-bearing and are the ones most often got
wrong. Neither is optional for a deployment a charger will connect to:

* **`OCPP_MIN_SECURITY_PROFILE=2`** — at the code default of `0` there is NO
  per-charger authentication. Any peer that can reach the OCPP port can open a
  session as any tenant's charge point and inject telemetry into their billing
  data. The API credential you issue to a vendor does not constrain that in any
  way, because it is a different port and a different auth mechanism.
* **`OCPP_TRUST_PROXY_PROTO=true`** when TLS terminates at Caddy rather than at
  the gateway. Without it the gateway sees plaintext and refuses every profile-2
  connection. Since this revision it refuses to *start* in that combination
  rather than rejecting chargers silently, so you will find out immediately.

And run the app as `plugsure_app`, never as the database owner: a superuser
bypasses every row-level security policy, and the process refuses to start that
way under `NODE_ENV=production`.

---

## 1. Prerequisites

**VM**

* Ubuntu 24.04 LTS, `t3.medium` or larger (2 vCPU / 4 GB is comfortable for one
  charger and leaves room for Postgres).
* 20 GB gp3 root volume. The OCPP frame log is the best support tool in the
  product and it is chatty — plan on growth.
* Elastic IP. The charger's Central System URL points at a DNS name that must not
  move; an EIP survives stop/start.

**Security group (inbound)**

| Port | Source | Why |
| --- | --- | --- |
| 443 | `0.0.0.0/0` | chargers (wss) — SIM-card egress IPs are not predictable |
| 80 | `0.0.0.0/0` | **required** for the ACME HTTP-01 challenge |
| 22 | your office CIDR only | ops + the SSH tunnel to the console |

Nothing else. In particular **not** 9200 (API/console) and **not** 5432.

**Software**

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl postgresql-client-16
# Path A
sudo apt-get install -y docker.io docker-compose-v2
# Path B (no Docker): Node 22 from NodeSource + local Postgres 16
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs postgresql-16
# Caddy (both paths)
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

---

## 2. DNS

One `A` record, pointing at the Elastic IP:

```
ocpp.example.id.      A     <ELASTIC_IP>     TTL 300
```

Optional, and only after authentication ships (see §9):

```
console.example.id.   A     <ELASTIC_IP>     TTL 300
```

The supplied `Caddyfile` allow-lists the console host to office / VPN
addresses. **Portal users sign in there too:** site owners and fleet customers
(role *Fleet customer*) are outside your office. If you use either portal,
publish the console for them. Either give it a second hostname without the
allow-list, or add their addresses. Portal users hold no operator permission,
and every portal route checks their own account.

Verify before touching ACME — a wrong record burns Let's Encrypt rate limits:

```bash
dig +short ocpp.example.id            # must print the Elastic IP
curl -s http://ocpp.example.id/.well-known/acme-challenge/ping   # must reach the VM
```

**The OCPP hostname is a hardware commitment.** It is flashed into every charge
point's Central System URL. Changing it later means a site visit per unit. Agree
it with the vendor before commissioning.

### White-label console addresses (v1.5.0, optional)

An operator can brand its console (**Governance → Console branding**: name,
tagline, colours, logo) and give it an address of its own, such as
`console.nusantaracharge.id`. Branding alone needs no server change: every user
of that operator sees it once signed in, on any console address. The operator's
**own address** needs three steps from you:

1. The operator creates a DNS record for the name pointing at this server
   (`A <ELASTIC_IP>`, or a `CNAME` to `console.example.id`).
2. Copy the commented *White-label consoles* template in `deploy/Caddyfile`
   once for that name. Set the hostname and the operator's office or VPN ranges
   in its allow-list, then run `caddy validate` and `systemctl reload caddy`.
   Caddy obtains the certificate on reload.
3. The operator enters the same name under **Console web address** and saves.

On that address the sign-in page shows the operator's brand, and only the
operator's own accounts can sign in. Any other account gets the same answer as
a wrong password, and the attempt is audited as `auth.login_wrong_console`.
Console addresses are deliberately not served by the on-demand catch-all
block, which serves only driver apps, because a console keeps an allow-list.

---

## 3. Certificate

Caddy obtains and renews the certificate automatically — there is no certbot step.

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/ocpp\.example\.id/ocpp.<your-domain>/g; s/ops@example\.id/ops@<your-domain>/' /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo journalctl -u caddy -f          # watch for "certificate obtained successfully"
```

**Test with the staging CA first.** Uncomment the `acme_ca` line in the global
block of the Caddyfile, reload, confirm issuance works end to end, then comment
it out again and **delete the staging certificate** or Caddy keeps serving it:

```bash
sudo rm -rf /var/lib/caddy/.local/share/caddy/certificates
sudo systemctl restart caddy
```

Production Let's Encrypt allows only 5 failed validations per hostname per hour.
Do not discover a firewall problem with the production CA.

Confirm the chain a charger will see:

```bash
openssl s_client -connect ocpp.example.id:443 -servername ocpp.example.id </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates
```

---

## 4. Configuration

Both paths read the same variables. Path A reads `.env` next to
`docker-compose.yml`; Path B reads `/etc/plugsure/plugsure.env` (both app units)
and, for migrations only, `/etc/plugsure/migrate.env` (root-only, v1.4.4).

```bash
sudo install -d -m 0750 -o root -g plugsure /etc/plugsure
sudo install -m 0640 -o root -g plugsure /dev/null /etc/plugsure/plugsure.env
sudo -e /etc/plugsure/plugsure.env
# Path B: the database OWNER's credential, read only by plugsure-migrate.service.
sudo install -m 0600 -o root -g root /dev/null /etc/plugsure/migrate.env
sudo -e /etc/plugsure/migrate.env
```

### Required secrets — the process will not start without these

Two variables have no default and no fallback outside development. The services
call `assertAuditKeyConfigured()` and `assertAuthConfigured()` at boot and
`process.exit(1)` if either is missing. Under `restart: unless-stopped` or a
systemd unit that is exactly a crash loop, and the reason is only visible in the
first few lines of the log. They were previously absent from this document
entirely, so following it end to end produced a service that never came up.

Generate them once, per environment, and keep them out of the repository:

```bash
openssl rand -hex 32   # -> AUDIT_HMAC_KEY
openssl rand -hex 32   # -> SECRETS_KEY
```

| Variable | Notes |
| --- | --- |
| **`POSTGRES_APP_PASSWORD`** | Password for the runtime role `plugsure_app`. **Migrations run as the database owner; the API and gateway do not.** A superuser bypasses every row-level security policy, so `assertRlsPosture()` refuses to start in production as one — which means there is no working deployment without this. `npm run migrate` (and the compose `migrate` service) provisions the role when this is set; the app processes then connect as `postgresql://plugsure_app:<pw>@…`. |
| **`AUDIT_HMAC_KEY`** | Keys the audit log's HMAC chain. **Never rotate it casually:** every entry written under the old key stops verifying, and there is deliberately no downgrade path (one would let an attacker bypass the key). If you must rotate, export the existing chain first and re-anchor. Losing it does not destroy the log, but the tamper-evidence is gone. |
| **`SECRETS_KEY`** | 32-byte hex. Encrypts webhook and payment-provider secrets at rest. Losing it means re-entering every provider credential. |

### Production values

| Variable | Production value | Notes |
| --- | --- | --- |
| `NODE_ENV` | `production` | anything else turns on `pino-pretty`; keep logs JSON |
| `DATABASE_URL` | `postgresql://plugsure_app:<pw>@127.0.0.1:5432/plugsure` | The apps' connection, as the runtime role `plugsure_app` (never the owner). Path A overrides this to `@postgres:5432` inside the compose network |
| `DATABASE_URL` in `migrate.env` | `postgresql://plugsure:<pw>@127.0.0.1:5432/plugsure` | Path B only: the owner connection `plugsure-migrate.service` runs migrations with. It lives in the root-only `/etc/plugsure/migrate.env`, never in `plugsure.env`, so the running API and gateway do not hold the owner password (v1.4.4; earlier releases used `MIGRATION_DATABASE_URL` in `plugsure.env`). |
| `LOG_LEVEL` | `info` | `debug` only while chasing a fault; it logs every OCPP frame |
| `TZ` | `Asia/Jakarta` | **not cosmetic** — WBP/LWBP tariff blocks are evaluated in local time |
| **`OCPP_MIN_SECURITY_PROFILE`** | **`2`** | **wss + HTTP Basic. The OCPP 1.6 certification baseline and the only acceptable production setting.** `0` (the code default) accepts any charger with no credential at all; `1` accepts Basic over plaintext. Setting this to `2` makes `checkAuth()` demand Basic credentials matching the stored `AuthorizationKey` for every connection. |
| **`OCPP_TRUST_PROXY_PROTO`** | **`true`** *(when TLS terminates at Caddy)* | **Required whenever `OCPP_MIN_SECURITY_PROFILE >= 2` and TLS is NOT terminated by the gateway itself.** `isTls()` learns the scheme from `X-Forwarded-Proto`, which it ignores unless this is set — so the documented production stack (profile 2 behind Caddy) previously refused 100 % of connections with `403 Security profile 2 requires TLS` while logging a healthy "listening" line. The gateway now refuses to start in that combination. Only enable it when the proxy is the sole ingress and strips client-supplied forwarding headers, or a direct client can claim TLS it does not have. |
| `OCPP_TRUSTED_PROXIES` | `127.0.0.1,::1` *(compose adds `172.16.0.0/12`)* | Addresses or CIDRs whose `X-Forwarded-Proto` and `X-Client-Cert-Fingerprint` the gateway believes. From any other peer those headers are ignored, so a client that reaches port 9220 directly cannot claim TLS or present another charger's certificate fingerprint. List the address your TLS terminator connects from. |
| **`OCPP_AUTO_ADOPT`** | **`false`** | **Production must not adopt strangers.** The code default is `true` only under `NODE_ENV=development` and `false` everywhere else; set it explicitly anyway. With `true` any charge point that connects is created and attached to `OCPP_AUTO_ADOPT_SITE` — that is a bench convenience, and in the field it means an unknown unit can enrol itself into a tenant's fleet and start producing billable sessions. With `false`, unknown identities are parked and refused with `404 unknown charge point — parked for adoption`, and you adopt them deliberately from the console. |
| **`OCPP_VERSIONS`** | **`ocpp1.6,ocpp2.0.1`** | Subprotocols the gateway negotiates, in order of preference. The code default is `ocpp1.6` alone: a unit offering only `ocpp2.0.1` is then refused with `400 No supported OCPP subprotocol offered`. Keep `ocpp1.6` alone until a 2.0.1 model has passed acceptance. Add `ocpp2.1` for OCPP 2.1 stations (needed for bidirectional charging). Sandbox virtual chargers registered as 2.0.1 or 2.1 need those versions listed here too. |
| `OCPP_PORT` | `9220` | behind Caddy; never published directly |
| `OCPP_HOST` | `127.0.0.1` | Interface the gateway binds. Code default: `127.0.0.1` outside `NODE_ENV=development` (`0.0.0.0` in development, for a bench charger on the LAN). Earlier revisions always bound every interface. Set `0.0.0.0` only when chargers or an API on another host reach the gateway without a local proxy — then firewall it. The image (Path A) sets `0.0.0.0` inside the container; the port binding (`OCPP_BIND`) decides exposure. |
| `OCPP_PATH` | `/ocpp` | must match the vendor's configured URL path |
| `OCPP_HEARTBEAT_S` | `300` | drives the Caddy read timeout — keep the proxy above 3× this |
| `OCPP_CALL_TIMEOUT_MS` | `30000` | raise to `60000` for units on poor cellular links |
| `OCPP_KEY_ROTATION_GRACE_MS` | `86400000` | 24 h window in which old + new AuthorizationKey both work |
| `OCPP_AUTO_ADOPT_SITE` | *(unset)* | only meaningful when `OCPP_AUTO_ADOPT=true`: the site (id or name) auto-adopted chargers join. Unset, only a development/test gateway falls back to the oldest site; otherwise unknown chargers are parked. |
| `ALLOW_INSECURE_OCPP` | `false` | Outside `NODE_ENV=development`/`test` the gateway **refuses to start** with `OCPP_MIN_SECURITY_PROFILE` below 2 or `OCPP_AUTO_ADOPT=true`. Set this only to acknowledge a supervised bench; the gateway then logs an error at boot. |
| `API_PORT` | `9200` | |
| `API_HOST` | `127.0.0.1` | **loopback only** — now also the code default (it was `0.0.0.0`, which on Path B exposed the console and `/v1` on every interface despite this table). Path A sets `0.0.0.0` inside the container and binds the host port to `127.0.0.1` (`API_BIND`) instead. |
| `API_RATE_LIMIT_SHARED` | `true` *(default outside development/test)* | Per-API-key limits are kept in Postgres and shared by every API process (one small `UPDATE` per API-key request). `false` keeps per-process buckets: behind N API processes a key then gets N× its limit. If the database does not answer within 1 s the request is limited per process instead (fail open, logged). |
| `OCPP_FRAME_RETENTION_DAYS` | `90` | The gateway's hourly retention pass deletes OCPP frames older than this, in batches of 10,000 with pauses (at most ~50 s per pass; a large backlog is worked off over several hours after an upgrade). `0` keeps them forever. |
| `CONNECTION_ATTEMPT_RETENTION_DAYS` | `30` | Same for the connection-attempt log. |
| `MIGRATION_LOCK_TIMEOUT` | `10s` | How long one migration may wait for a table lock. Past it the migration fails and rolls back (retry; find the blocker in `pg_stat_activity`) rather than queueing every query on that table behind it. Migrators also take an advisory lock, so two never run at once. |
| **`API_TRUSTED_PROXIES`** | *(your ingress IP)* | Comma-separated IPs/CIDRs whose `X-Forwarded-For` is believed. **Leave unset unless you terminate TLS at a proxy.** This used to be a hardcoded "trust everyone", which let any caller forge a fresh client IP per request and so never hit the rate limit — brute force against a bearer token was free — and poisoned the client IP recorded in the audit log. With Caddy on the same host, set `API_TRUSTED_PROXIES=127.0.0.1`. |
| `IDLE_FEE_CAP_IDR` | `100000` | Hard per-session cap on idle/occupancy charges. Not a regulatory figure — a platform safety bound. An unbounded idle fee turned a 60 kWh delivery into a Rp 6,692,360 invoice. Raise it deliberately or not at all. |
| `PPN_RATE_BPS` | `1200` | 12 % headline rate |
| `PPN_DPP_NUM` / `PPN_DPP_DEN` | `11` / `12` | *DPP nilai lain*: DPP = 11/12 × price, PPN = 12 % × DPP. Do not "simplify" to 11 % — the total matches but the DPP printed on the faktur pajak is wrong and fails an audit. |
| `PBJT_IN_PPN_BASE` | `true` | PPN applied on the PBJT-inclusive amount (market practice). **Confirm with a tax advisor before go-live.** |
| `ROUNDING_UNIT_IDR` | `1` | IDR has no practical subunit |
| `PLN_LK_BASE` | `1645` | *layanan khusus* tariff base, IDR/kWh; ceiling = 1.5 × base |
| `PLN_CURAH_BASE` | `707` | *curah* tariff base, IDR/kWh |
| `WBP_START` / `WBP_END` | `17:00` / `22:00` | peak window, local time |
| `HEALTHCHECK_URL` | per role | `http://127.0.0.1:9200/healthz` (api) or `http://127.0.0.1:9220/healthz` (gateway) |
| `HEALTHCHECK_OK_STATUS` | per role | `200` for both. The gateway serves a real `/healthz` that queries the database — an earlier revision of this document said it did not, and told you to health-check on the `426` from the upgrade listener, which proves only that the event loop is alive. |

Compose-only knobs: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`,
`PG_HOST_PORT`, `OCPP_HOST_PORT`, `API_HOST_PORT`, `OCPP_BIND`, `API_BIND`,
`PLUGSURE_TAG`.

Minimal production `/etc/plugsure/plugsure.env`:

```ini
NODE_ENV=production
TZ=Asia/Jakarta
LOG_LEVEL=info
# The apps connect as the restricted runtime role, never as the owner: as the
# owner (or a superuser) row-level security would not constrain them.
DATABASE_URL=postgresql://plugsure_app:CHANGE_ME_APP@127.0.0.1:5432/plugsure
# The owner connection and POSTGRES_APP_PASSWORD do NOT go here: they belong in
# /etc/plugsure/migrate.env (below), which only plugsure-migrate.service reads.

# No defaults. The process exits at boot without these — see "Required secrets".
AUDIT_HMAC_KEY=CHANGE_ME_openssl_rand_hex_32
SECRETS_KEY=CHANGE_ME_openssl_rand_hex_32

OCPP_PORT=9220
OCPP_PATH=/ocpp
OCPP_VERSIONS=ocpp1.6,ocpp2.0.1
OCPP_MIN_SECURITY_PROFILE=2
OCPP_TRUST_PROXY_PROTO=true
OCPP_AUTO_ADOPT=false
OCPP_HEARTBEAT_S=300
API_PORT=9200
API_HOST=127.0.0.1
API_TRUSTED_PROXIES=127.0.0.1
```

Production `/etc/plugsure/migrate.env` (Path B, root:root 0600):

```ini
# The database OWNER: migrations need DDL and create/alter plugsure_app.
DATABASE_URL=postgresql://plugsure:CHANGE_ME@127.0.0.1:5432/plugsure
# Migrations set plugsure_app's password from this: the same value as in
# plugsure.env's DATABASE_URL.
POSTGRES_APP_PASSWORD=CHANGE_ME_APP
# Optional: MIGRATION_LOCK_TIMEOUT=10s, PG_STATEMENT_TIMEOUT_MS=0 (a long data
# migration), POSTGRES_APP_USER (only if the runtime role is not plugsure_app).
```

Write values unquoted, one `KEY=value` per line (systemd `EnvironmentFile` syntax).
For owner commands by hand (checks, backups, troubleshooting), read the URL out of the
file rather than sourcing it as shell code, so a password with `$`, `&` or quotes is safe:

```bash
# Path B (local Postgres or RDS alike)
OWNER_URL=$(sudo sed -n 's/^DATABASE_URL=//p' /etc/plugsure/migrate.env)
psql "$OWNER_URL" -c "select 1"
# Path A (Docker Compose)
docker compose exec postgres psql -U postgres plugsure -c "select 1"
```

> **Read the commissioning order below before you point a charger at this.**
> With `OCPP_MIN_SECURITY_PROFILE=2` and `OCPP_AUTO_ADOPT=false` — the correct
> production values — a charger that has not been registered AND issued an
> `AuthorizationKey` first is refused, every time. That is the intended
> behaviour, but this document used to stop here, so following it produced a
> deployment that rejected 100 % of connections with no indication why.

### Integrations: payments (QRIS, e-wallets, cards), sign-in codes, PKI, map tiles

Connected in the console (Govern → Integrations); settings there override the
environment variables. Secrets are stored sealed with `SECRETS_KEY`.
**Changing `SECRETS_KEY` makes them unreadable**, so enter them again.

- **Payments** (required before selling): Midtrans, Xendit, or a bank over
  BI-SNAP. Each operator may connect its own merchant account; the platform
  administrator's is the default.
  1. Save the account.
  2. Paste the **payment notification URL** it shows
     (`https://<public host>/pay/notify/<key>`) into the provider's dashboard.
     Set `PUBLIC_BASE_URL`, so the URL shown is the public one.
  3. Run **Test**.

  Payments are confirmed only by those notifications, so `/pay/*` must be
  reachable from the internet. `deploy/Caddyfile` routes it on the OCPP host.
  4. Tick the **payment methods** drivers may use. QRIS is the default. You can
     add GoPay, ShopeePay and cards with Midtrans, or OVO, DANA, ShopeePay,
     LinkAja and cards with Xendit. Enable only methods that are activated on
     your acquirer account.

  **E-wallets and cards** are pre-purchases like QRIS. Cards are paid on the
  acquirer's hosted 3-D Secure page, so card data never touches PlugSure. The
  acquirer sends the driver back to `https://<driver host>/app/paid.html`.
  That host is `DRIVER_PUBLIC_URL` on the API, else `CONSOLE_PUBLIC_URL`, else
  the request's own host. With Midtrans, set the Snap *Finish URL* to the same
  page in the dashboard as a fallback. Xendit refunds e-wallet payments by API;
  its QRIS and card payments are refunded by bank transfer from the Refunds
  page.

  **Card holds and saved cards** (optional, off by default):
  - *Card payments: hold, then charge only what is used* makes a card payment
    for charging a pre-authorisation. The rated total is captured when the
    session ends, and the rest released.
  - *Let signed-in drivers save a card* keeps the acquirer's token, never the
    card number. A card whose token has ended at the acquirer (deleted at the
    bank, or expired) is refused with a message naming it and no longer offered.
  - Ask your acquirer to enable card pre-authorisation, and card saving (for
    Midtrans One Click, only if you turn off *ask for 3-D Secure every time*).
  - Failed captures appear under **Refunds → Card holds** and are retried
    automatically. A hold that expired at the acquirer before capture is shown
    as *expired, not charged* with the amount to collect (no retry), with a
    critical alert. The driver can pay it from the receipt in the app; it then
    shows as *expired, paid in app* and the alert resolves.
  - A Midtrans authorisation lapses after 7 days by default, so clear sessions
    parked for review before then.

  **Linked e-wallets** (optional, off by default): *Let signed-in drivers link
  … for one-tap payments* lets drivers link GoPay (Midtrans GoPay
  Tokenization) or OVO / DANA (Xendit reusable payment methods) once and pay
  in one tap. ShopeePay and LinkAja link through Xendit too, and so does GoPay once Xendit activates GoPay recurring on the account.
  - The chosen amount is charged, and unused balance is refunded
    automatically through the acquirer.
  - Ask the acquirer to enable e-wallet tokenisation, and tick the e-wallet as
    a method.

  **Post-pay** (optional, off by default): *Linked e-wallets: charge after
  the session* starts the session with nothing charged and charges the rated
  total to the linked e-wallet afterwards.
  - Set the per-session limit under Advanced (default Rp 200,000); larger
    amounts are charged up front.
  - E-wallet balances are checked before starting where the acquirer reports
    them (GoPay at Midtrans, the wallet or GoPay Tabungan and never PayLater, or at Xendit; a GoPay, OVO, DANA, ShopeePay or LinkAja link the driver ended in the e-wallet app, or that expired, is refused with "link … again"; OVO, DANA, ShopeePay, LinkAja at Xendit). Turn on
    *Post-pay only when the e-wallet balance can be checked* (Advanced) to charge
    up front any e-wallet whose balance cannot be read.
  - Unpaid charges are retried, payable by the driver from the receipt (by the e-wallet again, or in the app with any other method, also while the e-wallet PIN is pending or after it expired, was denied or was cancelled); the app shows unpaid sessions on the home screen and sends Web Push reminders; an unpaid session's tax receipt is a nil transaction (Rp 0) until paid. With Xendit, point the payment method and payment token callbacks at the same URL as payments, and
    listed under **Refunds → Holds and post-pay**.
- **Alert delivery status and SMS** (optional; Govern → Alert routing): the
  WhatsApp channel shows a callback URL (`https://<public host>/hooks/whatsapp/<key>`)
  and a verify token for the Meta app's webhook (field `messages`); save the
  Meta **app secret** on the channel so callbacks can be verified. Like
  `/pay/*`, `/hooks/*` must be reachable from the internet; `deploy/Caddyfile`
  routes both on the OCPP host. The SMS channel (Twilio, Zenziva or your
  gateway) needs outbound HTTPS from the gateway. Per-site offline thresholds
  are set on each site (Monitoring).
- **Driver sign-in codes** (required for phone sign-in): WhatsApp Cloud API
  (an approved *Authentication* template with a copy-code button, e.g.
  `plugsure_otp` in `id`), Twilio, Zenziva, or your own gateway. You can add an
  SMS fallback. **Test** with your own number.
- **Plug & Charge PKI** and **map tiles**: see those sections. The `PNC_*` and
  `MAP_TILE_*` variables keep working when nothing is set in the console.

In production, QRIS checkout and phone sign-in are refused until their
provider is connected.

### Charger certificates (Security Profile 3)

Onboarding (Operate → Onboarding → Add charge point) issues a charger's client
certificate automatically from PlugSure's **charging-station CA**:
- **Issue automatically** — key and certificate made for the charger; the
  bundle (`client.key`, `client.crt`, `ca.pem`, `chain.pem`) is downloaded once.
- **Sign the charger's request (CSR)** — the key never leaves the charger.
- **Profile 2, then Profile 3 automatically** — after its first connection
  PlugSure asks the charger for a CSR over OCPP, installs the certificate with
  CertificateSigned and sets `SecurityProfile` 3 (OCPP 1.6 Security
  Whitepaper chargers; on 2.0.1 the certificate is installed and the profile
  is raised with the charger's network profile).

Each certificate's CN is the charger's OCPP identity, and its fingerprint is
bound to that one charger. Certificates are renewed over OCPP
`CHARGER_CERT_RENEW_DAYS` (30) days before they expire. During a renewal the
old certificate works until the charger uses the new one.

The CA is created on first use (its key sealed with `SECRETS_KEY`), or bring
your own with `CHARGER_CA_CERT_FILE` + `CHARGER_CA_KEY_FILE`. **Whatever
terminates TLS must trust it:**
- **Caddy** (the shipped setup): download it from Onboarding → Certificate
  authority to `/etc/caddy/plugsure-charger-ca.pem` and uncomment the `tls {
  client_auth … }` block in `deploy/Caddyfile`. The `header_up
  X-Client-Cert-Fingerprint` line is already there and must stay: it overwrites
  any value a charger sends. Keep `OCPP_TRUST_PROXY_PROTO=true` on the API and
  the gateway.
- **The gateway terminating TLS itself** (`OCPP_TLS_CERT_PATH` /
  `OCPP_TLS_KEY_PATH`): it asks every charger for a certificate and trusts the
  CA already. Nothing to configure.

Chargers also need the root of the OCPP host's own TLS certificate. With a
public CA, that is the CA's root (ISRG Root X1 for Let's Encrypt). With a
private one, set `CSMS_ROOT_CA_FILE` and it is included in every onboarding
bundle as `csms-root.pem`.

### Plug & Charge (ISO 15118) — optional

Plug & Charge needs a V2G PKI: the contract and certificate service of a
Plug & Charge ecosystem (Hubject or similar), with which the operator holds a
CPO agreement. PlugSure implements the CSMS side and talks to the PKI through
a small **PKI gateway**: a service you (or your provider) run in front of the
PKI's own API. Set it on **both** the API and the gateway:

```ini
PNC_PKI=http
PNC_PKI_URL=https://pki-gateway.internal.example.id
PNC_PKI_TOKEN=<bearer token the gateway expects>
# Optional: sign chargers' V2G certificates with your own CPO sub-CA in Vault
# PNC_V2G_SIGNER=vault
# PNC_VAULT_MOUNT=pki_v2g
# PNC_VAULT_ROLE=secc
```

The gateway contract (JSON; `Authorization: Bearer PNC_PKI_TOKEN`):

| Call | Request | Answer |
|---|---|---|
| `POST /v1/certificates/sign` | `{ csr, certificateType: "V2GCertificate", chargingStation }` | `{ certificateChain }` — PEM, leaf first, without the root |
| `POST /v1/ev-certificates` | `{ iso15118SchemaVersion, action: "Install" \| "Update", exiRequest, chargingStation }` | `{ status: "Accepted" \| "Failed", exiResponse }` — base64 EXI |
| `GET /v1/roots` | — | `{ v2gRoots: [pem], moRoots: [pem] }` |

OCSP needs no configuration: the CSMS asks the responder named in each
certificate, over http or https, through the same SSRF guard as webhooks (no
private addresses in production, 5 s timeout, `PNC_OCSP_TIMEOUT_MS`). Allow the
gateway outbound HTTP/HTTPS to the PKI's OCSP responders.

Then, in the console under **Operate → Plug & Charge**:
1. Trust anchors → **Fetch from the PKI**.
2. Chargers → for each ISO 15118 charger: **Switch Plug & Charge on**,
   **Install trust anchors**, **Request V2G certificate**. Certificates are
   renewed automatically `PNC_RENEW_DAYS` (30) days before they expire; an alert
   is raised a week before.
3. Contracts → register your customers' eMAIDs (fleet contracts are billed on
   the fleet invoice). Partners' contracts arrive through roaming.
4. Overview → **Plug & Charge on**.

`PNC_PKI=mock` is a built-in test PKI for development and sandboxes. The
process refuses it in production (it behaves as `none`).

### Commissioning order — do these BEFORE the charger dials in

A production gateway refuses unknown identities (`OCPP_AUTO_ADOPT=false`) and
demands Basic credentials over TLS (`OCPP_MIN_SECURITY_PROFILE=2`). Both halves
have to exist in the database first.

Set `PLUGSURE_KEY` to an operator API key (the seed prints one; `POST /v1/api-keys`
issues more — note that a key can only ever be granted permissions its issuer
already holds).

1. **Register the identity**, exactly as the vendor configured it —
   case-sensitive, character-exact.

   ```bash
   curl -sS -X POST http://127.0.0.1:9200/v1/charge-points \
     -H "Authorization: Bearer $PLUGSURE_KEY" -H 'Content-Type: application/json' \
     -d '{"ocppIdentity":"AUTEL-DC60-SMB-002","siteId":"<site-uuid>"}'
   ```

   The row is created in `pending_adoption`, and the response lists the remaining
   steps. A charger that connects at this point completes the WebSocket upgrade
   and is answered `Pending` at BootNotification: visible in the console,
   recorded as `accepted_pending_adoption` in the attempt log, not yet able to
   transact.

   *If the unit has already dialled in and been refused*, it is in the adoption
   queue instead — `POST /v1/pending-chargers/<identity>/adopt` with the same
   body does the same job from that side. Use one or the other, not both; the
   second returns `409 that identity is already registered`.

2. **Issue the AuthorizationKey**, and write the same value into the charger's
   own OCPP settings (Autel: *Settings → OCPP → Authorization Key*).

   ```bash
   curl -sS -X POST http://127.0.0.1:9200/v1/charge-points/AUTEL-DC60-SMB-002/authorization-key \
     -H "Authorization: Bearer $PLUGSURE_KEY"
   ```

   The key is returned **once**. Setting a security profile ≥ 1 without a stored
   key is refused, which is why this step cannot be skipped.

3. **Set the security profile** to match what the charger will actually offer.
   Note this is a `PUT`, not a `POST`.

   ```bash
   curl -sS -X PUT http://127.0.0.1:9200/v1/charge-points/AUTEL-DC60-SMB-002/security-profile \
     -H "Authorization: Bearer $PLUGSURE_KEY" -H 'Content-Type: application/json' \
     -d '{"profile":2}'
   ```

   Profile 2 additionally requires TLS. If TLS terminates at Caddy rather than at
   the gateway, `OCPP_TRUST_PROXY_PROTO=true` must be set — see the variable
   table above. Without it the gateway sees plaintext and refuses every profile-2
   connection, and since this release it refuses to *start* in that combination
   rather than rejecting chargers silently.

4. **Activate it.** This is what moves the unit OUT of `pending_adoption`:

   ```bash
   curl -sS -X POST http://127.0.0.1:9200/v1/charge-points/AUTEL-DC60-SMB-002/activate \
     -H "Authorization: Bearer $PLUGSURE_KEY"
   ```

   Only now will BootNotification answer `Accepted` and the unit transact.

5. **Watch `GET /v1/connection-attempts`** while the installer power-cycles the
   unit. Every attempt is recorded with its outcome, TLS state, offered
   subprotocols and whether credentials were presented — which turns "it doesn't
   connect" into a one-line answer.

   Note that `GET /v1/pending-chargers` — the queue of identities that knocked
   and were turned away — requires `platform:admin`, because an unknown identity
   belongs to no tenant and listing them to any operator would enumerate every
   other tenant's hardware. Your own attempts appear in `/v1/connection-attempts`
   once step 1 has made them resolvable.

---

## 5. First deploy

### Path A — Docker Compose

```bash
git clone <repo> /opt/plugsure && cd /opt/plugsure
cp .env.example .env && sudo -e .env
docker compose build
docker compose up -d
docker compose ps                              # migrate = Exited(0); others = healthy
```

`.env` must contain all five of these or `docker compose up` refuses to start and
tells you which one is missing (they are declared `${VAR:?...}` in the compose
file, deliberately, so a missing secret is a startup error rather than a
container that restarts forever):

```ini
POSTGRES_PASSWORD=...                    # the database owner
POSTGRES_APP_PASSWORD=...                # the runtime role the apps connect as
AUDIT_HMAC_KEY=...                       # openssl rand -hex 32
SECRETS_KEY=...                          # openssl rand -hex 32
OCPP_TRUST_PROXY_PROTO=true              # TLS terminates at Caddy
```

The `migrate` service runs as the database owner, applies the schema, and
provisions the `plugsure_app` role's password from `POSTGRES_APP_PASSWORD`. The
`gateway` and `api` services then connect as that role. Confirm it worked:

```bash
docker compose logs api | grep 'row-level security'
# -> "row-level security is in force for application queries"
```

If that line says something else, the apps are running as a superuser and RLS is
doing nothing.

Boot order is enforced by the compose file, not by luck:
`postgres` (healthy) → `migrate` (exits 0) → `gateway` + `api`. The apps
**cannot** start against an unmigrated database.

Seed the demo org/site once, if you want something in the console:

```bash
docker compose run --rm migrate node dist/db/seed.js
```

### Path B — systemd

```bash
sudo useradd --system --home /opt/plugsure --shell /usr/sbin/nologin plugsure
sudo git clone <repo> /opt/plugsure && cd /opt/plugsure
sudo -u plugsure npm ci                # see §0 if this fails
sudo -u plugsure npm run build
sudo -u plugsure cp -R src/web dist/web            # operator console
sudo -u plugsure cp -R src/driver-web dist/driver-web  # driver app (/app)
sudo chown -R plugsure:plugsure /opt/plugsure

# The owner needs CREATEROLE: migrations create the runtime role plugsure_app
# and set its LOGIN and password. Without it the first migration fails with
# "permission denied to alter role".
sudo -u postgres createuser plugsure --createrole --pwprompt
sudo -u postgres createdb plugsure -O plugsure
# Only if plugsure_app already exists in this cluster (created by another role):
# PostgreSQL 16 also requires the owner to hold ADMIN OPTION on it.
#   sudo -u postgres psql -c "GRANT plugsure_app TO plugsure WITH ADMIN OPTION"

sudo install -m 0644 deploy/plugsure-migrate.service deploy/plugsure-api.service \
    deploy/plugsure-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now plugsure-api plugsure-gateway
```

Both `plugsure-api.service` and `plugsure-gateway.service` start the one-shot
`plugsure-migrate.service` (a privileged `ExecStartPre=+…systemctl start`) before their
own process, so every start or restart runs the migrator first. A failed migration fails
that start, and `Restart=always` retries it — for example while the database is still
coming up at boot. Only the migrate unit reads the owner credential
(`/etc/plugsure/migrate.env`, root-only); the API and gateway load `plugsure.env` alone,
and `InaccessiblePaths=` hides `migrate.env` and `backup.env` from them.

**Upgrading a Path B install from v1.4.3 or earlier:** move `MIGRATION_DATABASE_URL`
(as `DATABASE_URL`) and `POSTGRES_APP_PASSWORD` out of `plugsure.env` into a new
root-only `migrate.env`, install `plugsure-migrate.service` with the updated
`plugsure-api.service` and `plugsure-gateway.service`, then `systemctl daemon-reload`
and `systemctl restart plugsure-api plugsure-gateway`. If you run the nightly backup, also
make `/etc/plugsure/backup.env` root-only (`chown root:root`, `chmod 0600`): it holds the
owner credential too.

**The `cp -R src/web dist/web` step is not optional.** `src/api/server.ts`
resolves its static root as `join(here, '../web')`, which for `dist/api/server.js`
is `dist/web`. Without it the console 404s while `/healthz` looks fine. (The
Dockerfile does this copy for you on Path A.)

---

## 6. Migrations

Idempotent — applied files are recorded in `schema_migration`, so re-running is a
no-op. Safe to run before every deploy.

```bash
# Path A
docker compose run --rm migrate
# Path B (reads the owner credential from /etc/plugsure/migrate.env)
sudo systemctl start plugsure-migrate && journalctl -u plugsure-migrate -n 50 --no-pager
# From source (dev only; tsx is a devDependency)
npm run migrate
```

Check state:

```bash
# as the owner (OWNER_URL as in §4; Path A: docker compose exec postgres psql -U postgres plugsure):
# plugsure_app is subject to row-level security and would see no rows
psql "$OWNER_URL" -c "select name, applied_at from schema_migration order by name"
```

Each file runs in its own transaction with `lock_timeout` = `MIGRATION_LOCK_TIMEOUT`
(10 s): a migration that cannot get a table lock fails and rolls back instead of
stalling the gateway's writes behind it — re-run it when the blocking transaction
(see `pg_stat_activity`) is gone. The whole run holds an advisory lock, so a
second migrator (another host, a manual run during a restart) waits, then
finds everything applied. Because each file is one transaction, a migration
cannot use `CREATE INDEX CONCURRENTLY`; an index on a large, busy table (above
all `ocpp_frame`) is better created by hand with `CONCURRENTLY` before the
upgrade, so the migration's `CREATE INDEX IF NOT EXISTS` finds it and does
nothing. Migration 052 deliberately adds no index on `ocpp_frame` for this
reason (the retention pass walks its primary key instead).

**Never edit an applied migration in place.** It will not re-run, and the next
environment built from empty will get a schema this one does not have. Add a new
numbered file.

---

## 7. Rollback

Roll back the **code**; leave the schema alone. Migrations here are
forward-only — there are no down-migrations, and inventing one under pressure is
how billing data is lost.

```bash
# Path A — redeploy the previous image tag
PLUGSURE_TAG=<previous-sha> docker compose up -d --no-deps gateway api
docker compose logs -f --tail=100 gateway

# Path B
cd /opt/plugsure && sudo -u plugsure git checkout <previous-sha>
sudo -u plugsure npm ci && sudo -u plugsure npm run build && \
  sudo -u plugsure cp -R src/web dist/web && sudo -u plugsure cp -R src/driver-web dist/driver-web
sudo systemctl restart plugsure-api plugsure-gateway
```

Tag every deploy so there is something to roll back *to*:
`docker compose build && docker tag plugsure:local plugsure:$(git rev-parse --short HEAD)`.

If a **migration** is the problem, restore from a snapshot rather than
hand-editing:

```bash
# take one before every deploy (as the OWNER — plugsure_app is subject to RLS)
sudo install -d -o plugsure -g plugsure -m 0700 /var/backups/plugsure   # once; the nightly backup uses it too
sudo -u plugsure pg_dump "$OWNER_URL" -Fc -f /var/backups/plugsure/plugsure-predeploy-$(date +%F-%H%M).dump   # OWNER_URL as in §4
```

### Backups and restore rehearsal

`tools/backup/pg-backup.sh` writes a `pg_dump -Fc` of the whole database and a
tar of `STORAGE_DIR` (firmware images, charger diagnostics — they are not in the
database), checks the dump is readable, writes SHA-256 sums, optionally copies
everything off the host (`BACKUP_OFFSITE_CMD`), and only then deletes files older
than `BACKUP_RETENTION_DAYS` (14). Path B schedules it nightly with
`deploy/plugsure-backup.service` + `deploy/plugsure-backup.timer` (install notes
in the unit). On Path A run it from the host against `PG_HOST_PORT` with the
superuser, and archive the `plugsure-storage` volume
(`docker run --rm -v plugsure-storage:/s -v /var/backups/plugsure:/b debian tar czf /b/storage-$(date +%F).tar.gz -C /s .`).

A backup that has never been restored is a hope. **Rehearse a restore monthly,
and after every major upgrade**, into a scratch database on a non-production host
(the commands are the real recovery procedure):

```bash
# 1. Fetch the newest backup and verify it.
cd /var/backups/plugsure && sha256sum -c plugsure-<stamp>.sha256

# 2. Restore into an empty database. Roles are cluster-wide and not in the dump:
#    create the owner role and plugsure_app first (NOLOGIN is enough for a rehearsal).
sudo -u postgres psql -c "CREATE ROLE plugsure NOLOGIN" 2>/dev/null || true
sudo -u postgres psql -c "CREATE ROLE plugsure_app NOLOGIN" 2>/dev/null || true
sudo -u postgres createdb plugsure_restore -O plugsure
time pg_restore --exit-on-error --jobs=4 -d plugsure_restore plugsure-db-<stamp>.dump

# 3. Check it is complete and current.
psql -d plugsure_restore -c "select max(name) from schema_migration"
psql -d plugsure_restore -c "select count(*), max(started_at) from charging_session"
psql -d plugsure_restore -c "select has_table_privilege('plugsure_app','charging_session','SELECT')"

# 4. Point a scratch API at it (DATABASE_URL as plugsure_app, the SAME AUDIT_HMAC_KEY
#    and SECRETS_KEY) and verify the audit chain: Govern → Audit → Verify. A restore
#    without the original SECRETS_KEY loses every sealed provider credential.

# 5. Restore the file storage and spot-check a firmware image.
tar -xzf plugsure-storage-<stamp>.tar.gz -C /tmp/restore-check

# 6. Record how long steps 2-5 took: that is your real recovery time.
sudo -u postgres dropdb plugsure_restore
```

For the real thing: stop both units, restore into a fresh `plugsure` database,
restore `STORAGE_DIR`, start `plugsure-api` (migrations then bring an older dump
up to the current schema) and `plugsure-gateway`. Keep `AUDIT_HMAC_KEY` and
`SECRETS_KEY` in a secrets store separate from the backups — the backup is
useless without them, and dangerous alongside them.

---

## 8. Logs

Everything is single-line JSON on stdout (pino).

```bash
# Path A
docker compose logs -f gateway
docker compose logs --since 30m api | jq -c 'select(.level >= 40)'

# Path B
journalctl -u plugsure-gateway -f
journalctl -u plugsure-api --since "30 min ago" -o cat | jq -c 'select(.level >= 40)'

# TLS edge
journalctl -u caddy -f
tail -f /var/log/caddy/ocpp-access.log | jq -c '{ts,status,uri:.request.uri,ip:.request.remote_ip}'
```

Levels: `50` error, `40` warn, `30` info, `20` debug.

Rotation is configured (compose: `max-size 20m` × 5 files; journald: system
default; Caddy: 50 MiB × 10). For shipping off-box, install the CloudWatch agent
and tail the docker json-file logs or the journal — nothing in the app needs to
change, because it only ever writes to stdout.

The richest fault-finding tool is the **OCPP frame log**, not the process log:

```bash
psql "$OWNER_URL" -c \
  "select ts, direction, message_type, action, unique_id
     from ocpp_frame
    where ocpp_identity = '<IDENTITY>'
    order by ts desc limit 50"
# message_type: 2 = CALL, 3 = CALLRESULT, 4 = CALLERROR
```

---

## 9. Health checks

```bash
# API (loopback only)
curl -s http://127.0.0.1:9200/healthz | jq
# {"ok":true,"connectedChargePoints":1,"time":"..."}

# Gateway — /healthz reports database reachability and the live charger count.
curl -s http://127.0.0.1:9220/healthz | jq
# A plain GET to / answers 426 Upgrade Required, which is also correct: the listener exists
# only to be upgraded to a WebSocket.
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9220/    # => 426

# TLS edge from outside
curl -sI https://ocpp.example.id/ocpp/ | head -1                    # => 404 (no id) or 426

# Container health as Docker sees it
docker compose ps
docker inspect --format '{{.State.Health.Status}}' plugsure-gateway-1
```

`connectedChargePoints` is the number that matters on integration day: it is a
live count of chargers holding a WebSocket.

**Reaching the console.** The API requires a bearer token on every `/v1/` route
— an API key (`psk_…`) or a console session (`pss_…`). The seed prints one key,
once; `POST /v1/api-keys` issues more, and a key can only ever carry permissions
its issuer already holds. Startup logs `auth: "bearer"`; a request without a
credential gets `401`.

*(An earlier revision of this document stated the API was unauthenticated. That
has not been true since bearer auth shipped, and the paragraph is corrected here
because believing it would lead you to over-restrict the network and then be
surprised by 401s.)*

Bind it to loopback anyway and reach it over a tunnel: the console is an
operator surface, not a public one, and defence in depth costs nothing here.

```bash
ssh -N -L 9200:127.0.0.1:9200 plugsure@<vm-ip>
# then open http://127.0.0.1:9200/
```

---

## 10. When a charger cannot connect

Work down the list; each step tells you which layer to stop looking at.

1. **Is it reaching the VM at all?**
   ```bash
   tail -f /var/log/caddy/ocpp-access.log | jq -c '{ts,status,uri:.request.uri,ip:.request.remote_ip}'
   ```
   Nothing at all → DNS, SIM/APN routing, or the security group. Check
   `dig +short ocpp.example.id` from outside and confirm 443 is open.

2. **TLS handshake fails / charger logs "certificate error".**
   Common with Indonesian hardware: an old firmware trust store without ISRG
   Root X1. Verify the chain (§3), then ask the vendor to update the charger's CA
   bundle. Do **not** solve it by dropping to `ws://` — that also drops security
   profile 2.

3. **`404 charge point id missing from path`.**
   The URL has no final identity segment. The identity is *always* the last path
   segment: `wss://host/ocpp/<IDENTITY>`. Also check nobody added `handle_path`
   or a `rewrite` to the Caddyfile — stripping the prefix mangles the path.

4. **`404 unknown charge point — parked for adoption`.**
   Expected in production (`OCPP_AUTO_ADOPT=false`). The unit is parked; adopt it
   in the console, or insert it with the identity the vendor gave you. Identity
   is case- and character-exact.
   Once an identity has dialled in unregistered, only a **platform** operator can
   register or adopt it (a tenant gets `409 identity_needs_platform_approval`):
   identities are platform-wide, and first-come registration let any tenant claim
   another operator's charger. Registering before the unit dials in (the
   commissioning order in §4) is unaffected. A tenant's connection-attempt log
   starts at the moment the identity was registered or adopted in its account.

5. **`401 unauthorized`.**
   Security profile 1/2 Basic auth failed. The username **must equal the charge
   point identity**, and the password is the `AuthorizationKey` whose SHA-256 is
   stored in `charge_point.auth_key_hash`. Rotating a key leaves both valid for
   `OCPP_KEY_ROTATION_GRACE_MS` (24 h). If Caddy is stripping `Authorization`,
   every unit fails identically — the stock Caddyfile forwards it untouched.

6. **`400 no supported OCPP subprotocol offered`.**
   The charger offered a `Sec-WebSocket-Protocol` the gateway is not set to
   speak: only those in `OCPP_VERSIONS` (code default `ocpp1.6` alone; add
   `ocpp2.0.1` for 2.0.1 units, §4). The error text lists them. A charger that omits the
   header entirely is tolerated and treated as 1.6. If units that previously
   worked start failing here, suspect a proxy change injecting an empty
   `Sec-WebSocket-Protocol` header.

7. **Connects, then drops every ~5 minutes.**
   A read timeout below `OCPP_HEARTBEAT_S` (300 s) somewhere in the path — the
   Caddyfile sets 900 s for exactly this reason. Check any load balancer or
   corporate proxy between the charger and the VM; ALB's default idle timeout is
   60 s and will do this.

8. **Connects, then nothing happens.** Read the frames (§8). BootNotification
   rejected, a `CALLRESULT` never arriving, or a clock far out of sync all show up
   there in seconds.

Handy commands:

```bash
docker compose restart gateway            # never fixes step 1–4; only masks step 7
# as the owner (plugsure_app is subject to row-level security and would see no rows)
docker compose exec postgres psql -U postgres plugsure -c "select ocpp_identity, security_profile, last_seen_at from charge_point"
# Path B: psql "$OWNER_URL" -c "…" (OWNER_URL as in §4)
```

---

## 11. What to send the hardware vendor

Everything the vendor needs to commission a unit, and nothing they should not
have:

```
Central System URL                 wss://ocpp.example.id/ocpp/{chargePointIdentity}
  e.g.                             wss://ocpp.example.id/ocpp/AUTEL-AC22-SMB-001
                                   The identity is the last path segment.

Transport                          WebSocket over TLS 1.2+ on port 443
WebSocket subprotocol              ocpp1.6 or ocpp2.0.1: offer the one the unit is
                                   certified for; we answer with exactly one. A 1.6
                                   unit that sends no subprotocol is taken as ocpp1.6.
                                   2.0.1 only where we have enabled it (OCPP_VERSIONS);
                                   otherwise a 2.0.1-only unit gets HTTP 400.
Server certificate                 Let's Encrypt (ISRG Root X1): must be in the unit's
                                   trust store. A private CSMS CA comes as
                                   csms-root.pem in the onboarding bundle.

Security profile 2 (default)       TLS + HTTP Basic
  HTTP Basic username              the chargePointIdentity, byte-for-byte
  HTTP Basic password              AuthorizationKey — sent separately, never in this document
    set on the unit as             1.6: AuthorizationKey
                                   2.0.1: SecurityCtrlr.BasicAuthPassword
Security profile 3 (mutual TLS)    a client certificate replaces the password
  client certificate               from PlugSure's charging-station CA, CN = the
                                   chargePointIdentity, valid for this unit only.
                                   Either our bundle (client.key, client.crt,
                                   chain.pem), or we sign the unit's own CSR, or the
                                   unit starts on profile 2 and we install the
                                   certificate over OCPP.
  renewal                          over OCPP, 30 days before expiry; no site visit

Charge point identity              agreed per unit, case-sensitive; letters, digits
                                   and . _ : - only, at most 128. Must match what we
                                   register in PlugSure.
HeartbeatInterval                  300 s (the CSMS returns this in BootNotification)
Meter sampling                     60 s recommended. 1.6: MeterValueSampleInterval;
                                   2.0.1: SampledDataCtrlr.TxUpdatedInterval
Connection timeout / retry         exponential backoff, minimum 10 s; do NOT hammer
                                   on 401 — the key or certificate is wrong, not busy.

Commissioning checklist
  1. Set the URL, identity and credential (AuthorizationKey, or for
     profile 3 the client certificate) on the unit.
  2. Power-cycle; confirm BootNotification is Accepted. Pending means we
     have not activated the unit yet.
  3. Confirm heartbeats every 300 s.
  4. Plug in, start and stop one session; confirm the transaction messages:
       1.6    StartTransaction / MeterValues / StopTransaction
       2.0.1  TransactionEvent Started / Updated / Ended
  5. 2.0.1 only: we request a device-model report (GetBaseReport); the unit
     must answer with NotifyReport. Send us its variable list and which
     variables are writable.
  6. Send us the unit's vendor, model, firmware version and serial.

Support contact                    ops@example.id  (include the charge point
                                   identity and a UTC timestamp — we look the
                                   frames up by both)
```

Send the `AuthorizationKey` over a separate channel from the URL, and rotate it
after commissioning: both old and new keys are accepted for 24 h
(`OCPP_KEY_ROTATION_GRACE_MS`), so rotation causes no downtime.

Before offering profile 3, finish §4 "Charger certificates" (the TLS terminator
must trust the charging-station CA), then issue the certificate in Operate →
Onboarding.

For a 2.0.1 unit, set `OCPP_VERSIONS=ocpp1.6,ocpp2.0.1` first (§4), and after
step 2 open the charger's **Device model** tab and press **Request report** (step
5). Security and network variables are not writable from that tab by design.

---

## 12. Known gaps at this revision

Deployment-relevant, and none of them are fixed by this runbook:

* **The API/console is not for the open internet.** Every `/v1` route needs a
  signed-in user (password, cookie session, roles) or an API key, but keep port
  9200 on loopback (§9) or behind the Caddyfile's office allow-list. Site-owner
  and fleet-customer portal users need that allow-list widened, or the console
  published on its own hostname.
* **No log shipping off-box** beyond rotation; add the CloudWatch agent (§8).
* **Backups are only as good as the last rehearsal.** The nightly backup timer
  (§7 "Backups and restore rehearsal") is shipped but not installed by default,
  and it copies off the host only if `BACKUP_OFFSITE_CMD` is set.

Fixed since the previous revision of this list: `npm ci` works (§0), and the API
drains in-flight requests on SIGTERM like the gateway (open console live streams
are ended so the drain completes).

`systemctl reload` is not supported for either unit (neither has an
`ExecReload`; node's default action on SIGHUP is to exit, so the old gateway
`ExecReload=kill -HUP` dropped every charger). Configuration is read at start:
use `systemctl restart`.
