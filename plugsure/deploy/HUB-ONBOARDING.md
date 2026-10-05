# Connecting to PlugSure Hub — guide for operators and service providers

**Audience:** the technical team of a charge point operator (CPO), an e-mobility service provider (eMSP) or a
navigation/smart-charging service that connects its own platform to PlugSure Hub.
**Protocol:** OCPI 2.2.1 only. **Markets:** Indonesia, Malaysia, Singapore.

PlugSure's own CSMS customers do not need this guide: the PlugSure team connects them to the hub from the console
with no handshake.

---

## 1. What PlugSure Hub is

PlugSure Hub is an OCPI 2.2.1 roaming hub. You connect **once**, to PlugSure, instead of signing and
integrating with every operator or provider separately. The hub:

- **routes** your OCPI messages to the party they are addressed to (and only to parties you have a roaming
  agreement with);
- **broadcasts** your locations, tariffs and tokens to every party you have an agreement with;
- **tells you who is behind it** with the HubClientInfo module (which parties exist and whether they are connected);
- **records every CDR** that passes through it, for clearing and settlement between members (the commercial terms
  are in your hub agreement; settlement statements are a separate document).

The hub never changes the business content of your messages. It re-addresses them (routing headers), rewrites
callback URLs it has to proxy (`response_url`, the CDR `Location`, paging `Link`s) and otherwise forwards the body as
received.

```
 your platform ── one OCPI connection ──▶ PlugSure Hub ──▶ operator A, provider B, PlugSure tenants …
               ◀── broadcasts, routed requests, ClientInfo ──
```

## 2. Prerequisites

**Commercial**

1. A signed **PlugSure Hub agreement** (membership, fees, settlement terms). Ask your PlugSure account manager.
2. A **roaming agreement** for each counterparty you want to roam with. PlugSure records it on the hub; until one is
   active, the hub routes nothing between you and that party (OCPI status `4901`).

**Technical**

| Requirement | Detail |
|---|---|
| OCPI version | **2.2.1**. Your versions endpoint must list 2.2.1; other versions are ignored. |
| Public HTTPS endpoints | A versions URL and module endpoints reachable from the internet over HTTPS with a publicly trusted certificate. Private, loopback and link-local addresses are refused. |
| Party identities | Your country code(s) and 3-character party ID(s) (ISO 15118 / eMI3 style, e.g. `MY*ABC`), one per role you play. A (country code, party ID) belongs to one hub member. |
| Routing headers | `OCPI-from-country-code`, `OCPI-from-party-id`, `OCPI-to-country-code`, `OCPI-to-party-id` on **every functional request** (§5). |
| Request ids | `X-Request-ID` (new for every request) and `X-Correlation-ID` (kept across a chain of requests) on every request. Quote the correlation id to support. |
| HubClientInfo | Implement the `hubclientinfo` **RECEIVER** interface (strongly recommended): the hub PUTs the status of every party you can roam with. |
| Clock | NTP-synchronised; all timestamps UTC (`Z`). |

## 3. Your roles and modules

Implement the interfaces of your role. The hub implements both sides of every module, so you talk to the hub exactly
as you would to a direct partner.

| Module | CPO implements | eMSP implements | Through the hub |
|---|---|---|---|
| credentials | RECEIVER (+ SENDER calls) | RECEIVER (+ SENDER calls) | handshake with the hub only |
| locations | SENDER (GET) and pushes to the hub's RECEIVER | RECEIVER | broadcast (push) / GET All via the hub |
| tariffs | SENDER and pushes | RECEIVER | broadcast / GET All |
| tokens | RECEIVER (+ real-time `authorize` calls to the hub's SENDER) | SENDER (GET, `authorize`) and pushes | broadcast / GET All / addressed |
| sessions | SENDER and pushes | RECEIVER | addressed to the token's eMSP |
| cdrs | SENDER and POSTs | RECEIVER | addressed to the token's eMSP; recorded for clearing |
| commands | RECEIVER | SENDER (calls the hub's RECEIVER) | addressed or routed by location/session |
| chargingprofiles | RECEIVER | SENDER (or SCSP) | addressed or routed by session |
| hubclientinfo | RECEIVER (recommended) | RECEIVER (recommended) | the hub is the SENDER |

The hub's own endpoints are listed in its version details (`GET {versions URL}` → 2.2.1 →
`endpoints`). They follow this layout:

| Identifier | Role (the hub's) | URL |
|---|---|---|
| credentials | SENDER, RECEIVER | `https://hub.plugsure.asia/hub/ocpi/2.2.1/credentials` |
| hubclientinfo | SENDER | `…/2.2.1/hubclientinfo` |
| locations, tariffs, sessions, cdrs, tokens, commands, chargingprofiles | SENDER | `…/2.2.1/sender/{module}` |
| the same | RECEIVER | `…/2.2.1/receiver/{module}` |

Always take the URLs from the version details, never hard-code them. `hub.plugsure.asia` is used in this guide as
the production host **[OWNER: final hostname]**.

## 4. Connecting: the credentials handshake

PlugSure creates your membership and a **connection**. There are two ways to run the handshake.

### 4.1 You start (most common): PlugSure gives you token A

PlugSure sends you, over a secure channel:

- the **versions URL**: `https://hub.plugsure.asia/hub/ocpi/versions`;
- a **registration token (token A)**, valid until you complete the handshake.

Tokens travel in the `Authorization` header as `Token <base64 of the token>` (OCPI 2.2.1). The hub also accepts the
raw token for clients still on the 2.1.1 convention.

**Step 1 — versions** (with token A):

```bash
TOKEN_A='…token A as received…'
AUTH="Authorization: Token $(printf %s "$TOKEN_A" | base64 -w0)"
curl -sS https://hub.plugsure.asia/hub/ocpi/versions -H "$AUTH" \
  -H "X-Request-ID: $(uuidgen)" -H "X-Correlation-ID: $(uuidgen)"
# {"data":[{"version":"2.2.1","url":"https://hub.plugsure.asia/hub/ocpi/2.2.1"}],"status_code":1000,…}
```

**Step 2 — version details** (the hub's endpoints):

```bash
curl -sS https://hub.plugsure.asia/hub/ocpi/2.2.1 -H "$AUTH" \
  -H "X-Request-ID: $(uuidgen)" -H "X-Correlation-ID: $(uuidgen)"
```

**Step 3 — post your credentials** to the hub's `credentials` endpoint: a token B that **you** generate (the hub
uses it to call you), your versions URL and your roles:

```bash
curl -sS -X POST https://hub.plugsure.asia/hub/ocpi/2.2.1/credentials -H "$AUTH" \
  -H "X-Request-ID: $(uuidgen)" -H "X-Correlation-ID: $(uuidgen)" -H 'Content-Type: application/json' \
  -d '{
        "token": "your-token-B-a-long-random-string",
        "url": "https://ocpi.your-platform.example/versions",
        "roles": [
          { "role": "CPO", "country_code": "MY", "party_id": "ABC",
            "business_details": { "name": "ABC Charging Sdn Bhd", "website": "https://abc.example" } }
        ]
      }'
```

Token B is your own random secret (at most 255 characters). Before answering, the hub calls your versions URL and version details **with token B** to learn your endpoints. It
then answers with its own credentials:

```json
{ "data": { "token": "…token C…", "url": "https://hub.plugsure.asia/hub/ocpi/versions",
            "roles": [ { "role": "HUB", "country_code": "ID", "party_id": "PSH", "business_details": { "name": "PlugSure Hub" } },
                       { "role": "HUB", "country_code": "MY", "party_id": "PSH", "business_details": { "name": "PlugSure Hub" } },
                       { "role": "HUB", "country_code": "SG", "party_id": "PSH", "business_details": { "name": "PlugSure Hub" } } ] },
  "status_code": 1000, "timestamp": "…" }
```

- Use **token C** for every later request. Token A stops working at once.
- The hub reports itself only with role **HUB**, one party per country (`ID*PSH`, `MY*PSH`, `SG*PSH`
  **[OWNER: party ids]**). Any of them addresses "the hub".
- Your parties start **PLANNED** (invisible to others) until PlugSure activates your membership.

### 4.2 PlugSure starts: you give us your versions URL and a token A

If your platform prefers to be called first, send PlugSure your versions URL and a token A of yours. The hub
calls your versions endpoint, POSTs its credentials (its token B) to your `credentials` RECEIVER and keeps the
token C you return. Your platform must accept our token B from then on.

### 4.3 Afterwards

| Operation | How |
|---|---|
| Rotate your token | `PUT …/2.2.1/credentials` with a new token B (same roles). The hub returns a new token C; the old token C stops working **immediately**, so switch atomically. |
| Rotation forced by PlugSure | PlugSure may rotate a connection (security incident, yearly rotation): the hub PUTs new credentials to you; your old token C stays valid for a grace period (60 minutes by default). |
| Add a party (new country, new role) | Ask PlugSure to approve it first, then `PUT …/credentials` listing the new role. Unapproved roles are refused (`2001`). |
| Disconnect | `DELETE …/credentials`. Your parties show SUSPENDED to everyone; nothing more is routed. Reconnecting needs a new token A. |

## 5. Addressing: routing headers

Every **functional** request (all modules except `versions`, `credentials` and `hubclientinfo`) carries:

| Header | Value |
|---|---|
| `OCPI-from-country-code`, `OCPI-from-party-id` | the party you send as — one of the parties of **your** connection, in a role that fits the interface (e.g. CPO when pushing locations) |
| `OCPI-to-country-code`, `OCPI-to-party-id` | the receiver: another member's party, **or** a hub party (`ID*PSH`…) for broadcast / GET All, or omitted for open routing (below) |
| `X-Request-ID` | new for this request |
| `X-Correlation-ID` | the id of the chain (the hub keeps it on every leg it forwards) |

If your connection has exactly one party for the role the interface needs, missing `OCPI-from-*` headers are
inferred; send them anyway. A `from` party that is not yours is refused with HTTP 403 / `4903`. URL and body
ownership must match `from`: pushing `…/receiver/locations/MY/XYZ/…` as `MY*ABC` is refused with `2001`.

### 5.1 Three ways to address

| `OCPI-to-*` | Meaning | Used for |
|---|---|---|
| a member's party (`SG*XEM`) | **addressed**: forwarded to that party only, if you have an active agreement with it | sessions, CDRs, commands, charging profiles, a token to one CPO, a GET of one object |
| a hub party (`MY*PSH`) | **broadcast** (PUT/PATCH/DELETE) or **GET All** (GET of a list) | pushing locations, tariffs, tokens to every agreed counterparty; pulling everyone's locations, tariffs, tokens, sessions, CDRs |
| omitted | **open routing**: the hub finds the receiver | PUT session → the eMSP of `cdr_token`; POST CDR → the eMSP of `cdr_token`; commands → the CPO of the location/session/reservation; real-time `authorize` → the eMSP that issued the token; PUT/PATCH location, tariff, token → broadcast |

**Broadcast.** The hub answers `1000` at once (it has queued the message) and delivers it to every party of the
opposite role you have an active agreement with (or, with mutual open roaming, every open-roaming party), in order
per object, retrying with back-off. It is never sent back to your own parties. Broadcasts are not delivered to a receiver
while it is OFFLINE or SUSPENDED: after an outage of your platform, catch up with a GET All (below). The hub forwards broadcasts
with `OCPI-from` = the hub party and keeps the object's own `country_code`/`party_id` in the URL and body.

**GET All.** `GET …/sender/locations` (or tariffs, tokens, sessions, cdrs) with `OCPI-to` = a hub party returns the
objects of every agreed party, paged. Follow the `Link` header exactly as given: it is a hub cursor bound to your
connection and party. `X-Total-Count` is the sum over the sources. Sessions and CDRs are filtered to **your** tokens.

**Callbacks.** The hub replaces the `response_url` of commands and charging profiles with a hub URL, and the
`Location` of a CDR POST with a hub URL. Use them as received: the hub relays the result to the original sender.
A command result URL accepts one result.

## 6. Status codes from the hub

The hub relays the receiver's own HTTP status and OCPI envelope unchanged. When the hub itself cannot deliver, it
answers with an OCPI hub status code:

| OCPI status | HTTP | Meaning | What to do |
|---|---|---|---|
| `4001` Unknown receiver | 200 | The `OCPI-to` party is not on the hub (or open routing found nobody). | Check the party in HubClientInfo; check your agreement. |
| `4002` Timeout | 200 | The receiver did not answer in time (10 s; real-time authorisation 4 s). | Retry later; for real-time authorisation, fall back to your whitelist rules. |
| `4003` Connection problem | 200 | The receiver is OFFLINE, SUSPENDED or PLANNED, unreachable, or does not implement that interface. | Retry later; do not retry tight loops. |
| `4901` No agreement | 403 | No active roaming agreement between you and the receiver, or the agreement does not allow this module (commands, real-time authorisation, charging profiles). | Ask PlugSure / the counterparty. |
| `4902` Not broadcastable | 400 | Broadcast of a module that is never broadcast (sessions, CDRs, commands). | Address the receiver or omit `OCPI-to`. |
| `4903` From mismatch | 403 | `OCPI-from` is not a party of your connection, or not in a role for this interface. | Fix the header. |
| `4904` Ambiguous | 400 | Open routing matched more than one receiver. | Address the receiver explicitly. |
| `4905` Rate limited | 429 | Too many requests (default 600/min; real-time authorisation 1 200/min per connection). `Retry-After` says when to retry. | Back off. |
| `2001` | 400 | Invalid or missing parameters (ownership mismatch, malformed body, a duplicate CDR with different totals). | Fix the request. |

## 7. HubClientInfo

The hub PUTs `…/hubclientinfo/{country_code}/{party_id}` to your RECEIVER for every party you may roam with:
`{ party_id, country_code, role, status, last_updated }`, with status `CONNECTED`, `OFFLINE` (its platform stopped
answering) or `SUSPENDED` (agreement ended or suspended, or the party suspended by PlugSure). You never see parties
you have no agreement with, nor `PLANNED` ones. A full resend happens every 6 hours. You can also pull the list:
`GET …/2.2.1/hubclientinfo` (paged).

**Liveness.** If your platform sends nothing for 5 minutes, the hub GETs your versions URL. Two failed checks put
your parties OFFLINE for your counterparties; any request from you, or a successful check, brings them back.

## 8. Test environment

PlugSure runs a **sandbox hub** for integration **[OWNER: hostname, e.g. `https://hub-sandbox.plugsure.asia/hub/ocpi/versions`]**
with test parties of both roles, so you can test every flow before production:

1. PlugSure issues a sandbox token A; run §4.1.
2. Push a test location (`OCPI-to` = a hub party) and check it arrives at the test eMSP (PlugSure support can show
   you the trace by correlation id).
3. As an eMSP: push a token, start a session with `START_SESSION`, receive the session and the CDR.
4. As a CPO: real-time `authorize` a test token, push a session and POST a CDR; GET the CDR back via the hub
   `Location`.
5. Check the error paths: an unknown `OCPI-to` (`4001`), a party you have no agreement with (`4901`).

## 9. Go-live checklist

- [ ] Hub agreement signed; roaming agreements requested for each counterparty.
- [ ] Production versions URL and endpoints on HTTPS with a publicly trusted certificate.
- [ ] Party ids confirmed with PlugSure (one owner per country code + party id).
- [ ] Sandbox flows of §8 passed for your role.
- [ ] Routing headers, `X-Request-ID` and `X-Correlation-ID` on every functional request.
- [ ] HubClientInfo RECEIVER implemented; you stop sending to SUSPENDED parties.
- [ ] Callbacks used as received (`response_url`, CDR `Location`, `Link`).
- [ ] Retry policy: back-off on `4002`/`4003`/`4905`; no retry on `4901`/`4903`/`2001`.
- [ ] Token storage: token C kept secret; rotation procedure tested (`PUT /credentials`).
- [ ] Production token A received over a secure channel; handshake done; PlugSure has activated the membership.
- [ ] First live location broadcast and first CDR traced with PlugSure support.

## 10. CDRs, disputes and settlement

Every CDR routed through the hub (pushed or pulled) is recorded with its routing data. CPOs send one CDR per session,
never change a CDR once sent (send a credit CDR and a new CDR to correct one), and use the same CDR id only once per
party. The dispute window, settlement cycle, statements and payment terms are in your hub agreement and the
settlement guide **[OWNER: link once published]**.

## 11. Support

- **Contact:** hub-support@plugsure.asia **[OWNER: final address / phone / hours]**.
- **Always quote** the `X-Correlation-ID` (and the time, in UTC) of the request in question: PlugSure support sees every
  leg of it.
- PlugSure can turn on **body capture** for your connection for up to 72 hours to diagnose a problem; captured bodies
  are redacted (token uids, contract ids, names and e-mail masked) and deleted after 72 hours.
- Planned maintenance is announced to your technical contact by e-mail; the hub answers `4003` for parties whose
  platforms are down, never silently drops addressed messages.
