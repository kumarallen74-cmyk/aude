# PlugSure Hub — design (OCPI 2.2.1 roaming hub with clearing and settlement)

**Status:** implemented, v1.8.0 (branch `hub`, from `multi-country` @ 4430f62, v1.7.0). WP H0 done (v1.7.1, §7); WP H1, H2 and H3 done (§13 "as built" sections).
**Date:** 3 October 2026
**Scope:** PlugSure as a neutral roaming hub for Indonesia, Malaysia and Singapore. Drivers of any eMSP app charge at any
connected CPO. Each operator connects **once**, to PlugSure. PlugSure routes OCPI 2.2.1 messages between members,
records every CDR that passes through, and clears and settles the money between them. It keeps a hub commission.
**Not in scope:** OCPI 2.1.1 or 3.0, OICP, FX, PlugSure handling members' money (phase 2), automatic tariff
re-rating of CDRs (phase 2).

Markers used below: **[VERIFY]** is a fact or interpretation that needs confirming before it is relied on.
**[LEGAL]** needs counsel in the named country. **[OWNER]** is a business decision for the owner. Every
**[OWNER]** item has a working default, so engineering is not blocked.

---

## 0. Decisions at a glance

| # | Decision | Why (short) |
|---|---|---|
| D1 | The hub is a **separate OCPI surface** in the same codebase and processes: `/hub/ocpi/versions`, `/hub/ocpi/2.2.1/...`, served on `HUB_PUBLIC_URL` (its own host, e.g. `hub.plugsure.asia`). It has its own token namespace (`hub_connection`). The existing peer surface `/ocpi/*` does not change. | Existing peer connections are unaffected. The hub can be switched off (`HUB_ENABLED=false`) or moved to its own deployment later. |
| D2 | **Hub identity:** one `HUB` role per country, `ID*PSH`, `MY*PSH` and `SG*PSH` [OWNER: party ids]. All three are listed in the hub's credentials (spec: a hub reports itself as role HUB only). Any of the three addresses "the hub". Outbound calls use the hub party of the recipient's country. | Members address the hub with a familiar country code. The invoicing entity can differ per country. |
| D3 | **Registry = members → connections → parties.** A *member* is a legal entity. A *connection* is one OCPI credentials pairing (one platform). A *party* is a (country_code, party_id) with roles. The registry is in new `hub_*` tables. `ocpi_party` and `ocpi_partner` are reused **only on the tenant side** (internal members). | The spec ties endpoints and tokens to a platform, not a party. One platform can carry many parties (PlugSure tenants already do: one CPO party per country plus the home eMSP). |
| D4 | **Internal tenants join with zero configuration.** "Join hub" creates both sides at once with fresh tokens and no HTTP handshake: a `hub_connection(kind='internal')` on the hub side, and an `ocpi_partner(kind='hub')` in the tenant's org. All existing CPO and eMSP code then works against the hub unchanged. | The tenant code already supports a `hub` partner (ClientInfo-gated `partnerActsFor`, `OCPI-to` filtering, broadcast-shaped pushes). |
| D5 | **Internal shortcut = in-process `inject`, still OCPI-over-HTTP semantics.** `ocpiCall` and the hub forwarder pick the transport by URL origin. If the URL is under `HUB_PUBLIC_URL` or `OCPI_PUBLIC_URL`, the request goes through Fastify `inject()` (same hooks, auth, logging, headers). Any other URL goes over HTTPS through the SSRF guard. | One code path and one set of semantics for every member. No load-balancer round trip and no TLS to ourselves. Tests exercise the real handlers. |
| D6 | **The router is spec-faithful.** Requests addressed to one party are forwarded. Requests to the hub's party are Broadcast Push (Locations, Tariffs, Tokens only) or GET All (aggregated). Open routing (no `OCPI-to`) is resolved from content and a **route index** learned from traffic. Hub errors use OCPI codes 4000–4003, plus custom 49xx codes. | Interoperates with external CSMS, eMSPs and other hubs. |
| D7 | **Roaming agreements are required (closed network by default).** A CPO party and an eMSP party exchange functional messages only under an `active` agreement. It is enforced in the router: fan-out recipients, GET All sources, direct and open routes, ClientInfo visibility and ledger admission. A member can opt into "open roaming" with every member that also opted in. | A neutral hub must not leak one operator's network or drivers to parties it has no contract with. |
| D8 | **Callbacks go through the hub.** `response_url` (Commands, ChargingProfiles), the CDR `Location` header and pagination `Link` headers are rewritten to hub URLs. The hub maps them back. | The CPO never needs a direct route to the eMSP. The hub sees the results (for authorization matching and support). |
| D9 | **Every CDR is recorded once in a clearing ledger** (`hub_cdr`, unique per CPO party + CDR id). CDRs are recorded whether they were pushed or pulled through the hub. Each CDR is validated and gets a dispute window (default 14 days) before it is accepted. Credit CDRs offset the original. | It is the single source of truth for statements, commission and disputes. |
| D10 | **Phase 1: PlugSure is a clearing house, not merchant of record, and holds no funds.** The CPO remains the supplier and invoices the eMSP. The hub produces per-cycle statements with **bilateral netting per member pair and currency**, and instructs and records the transfers between members. PlugSure invoices its own commission from the PlugSure entity of the member's country. Phase 2: collection and disbursement through a licensed PSP (Stripe Connect SG/MY, Xendit xenPlatform ID) acting as payment agent. | Holding or moving third-party funds is a licensed activity in all three countries [LEGAL]. MoR would make PlugSure the seller of charging, which brings electricity-sale permits in ID and VAT on the gross [LEGAL]. Hubject's financial service follows the same model: invoices in the CPO's name, payouts through Stripe. |
| D11 | **Per-currency ledgers, no FX.** IDR, MYR and SGD positions never mix. Netting happens only within one currency. | Same as v1.7.0. |
| D12 | **A pre-existing isolation gap is fixed first (WP H0).** The tenant OCPI code scopes sessions, CDRs, tokens, commands and charging profiles by *partner*, not by `OCPI-from` party. Behind any hub, one eMSP could read or act on another eMSP's objects. | It is a prerequisite for connecting tenants to the PlugSure hub. It is already a latent issue with any external hub (§7). |

---

## 1. Research findings

### 1.1 OCPI 2.2.1 hub rules (official spec, `ocpi/ocpi`, branch `release-2.2.1-bugfixes`)

Sources: [transport_and_format](https://github.com/ocpi/ocpi/blob/release-2.2.1-bugfixes/transport_and_format.asciidoc),
[status_codes](https://github.com/ocpi/ocpi/blob/release-2.2.1-bugfixes/status_codes.asciidoc),
[credentials](https://github.com/ocpi/ocpi/blob/release-2.2.1-bugfixes/credentials.asciidoc),
[mod_hub_client_info](https://github.com/ocpi/ocpi/blob/release-2.2.1-bugfixes/mod_hub_client_info.asciidoc),
[mod_cdrs](https://github.com/ocpi/ocpi/blob/release-2.2.1-bugfixes/mod_cdrs.asciidoc),
[mod_commands](https://github.com/ocpi/ocpi/blob/release-2.2.1-bugfixes/mod_commands.asciidoc),
[mod_charging_profiles](https://github.com/ocpi/ocpi/blob/release-2.2.1-bugfixes/mod_charging_profiles.asciidoc),
[mod_tokens](https://github.com/ocpi/ocpi/blob/release-2.2.1-bugfixes/mod_tokens.asciidoc).

**Routing headers** (transport_and_format § Message Routing)
- `OCPI-to-country-code`, `OCPI-to-party-id`, `OCPI-from-country-code` and `OCPI-from-party-id` SHALL be implemented on
  every request and response of a **functional** module.
- Configuration modules (Credentials, Versions, HubClientInfo) "are not to be routed … routing headers SHALL NOT be
  used". The hub answers these itself.

**Headers per scenario**

| Scenario | Leg | TO headers | FROM headers |
|---|---|---|---|
| Direct request | requester → hub | receiving party | requesting party |
| | hub → receiver | receiving party | requesting party |
| Direct response | receiver → hub | requesting party | receiving party |
| | hub → requester | requesting party | receiving party |
| Broadcast | requester → hub | the Hub | requesting party |
| | hub → each receiver | receiving party | the Hub |
| | receiver's response | the Hub | receiving party |
| Open routing | requester → hub | (omitted) | requesting party |
| | hub → receiver | receiving party | requesting party |
| GET All | requester → hub | the Hub | requesting party |
| | hub's response | requesting party | the Hub |

**Broadcast Push**
- Only POST, PUT and PATCH are broadcast, each to every client with the "opposite role": CPO → all eMSPs and NSPs,
  eMSP → all CPOs. "Other" counts as an eMSP-type role.
- "GET SHALL NOT be used in combination with Broadcast Push."
- Broadcast is meant for Tokens and Locations, "not so much for CDRs and Sessions … specific to only one party and
  possibly protected by GDPR".
- For client-owned objects, the URL segments keep the **original** party's country_code and party_id.
- The hub answers the broadcaster first and then fans out.
- **Our reading:** Tariffs are broadcastable, being network-wide data like Locations. DELETE (Tariffs) is
  broadcast the same way, although the text lists only POST/PUT/PATCH. [VERIFY with OCPI community; harmless]

**Open Routing Request**
- With the `OCPI-to-` headers omitted, "the Hub can then decide to which party a request needs to be routed, or
  that it needs to be broadcasted if the destination cannot be determined".
- Allowed for GET (not GET All), POST, PUT, PATCH and DELETE.

**GET All via Hubs**
- The client calls the hub's Sender interface with the hub in `OCPI-to`.
- "The Hub can then combine objects from different connected parties". The owner of each object is read from the
  object's own `country_code` and `party_id`.

**Other transport rules**
- Timestamps: the hub SHALL NOT change `last_updated`.
- Message ids: on forwarding, the hub uses a **new `X-Request-ID`** and the **same `X-Correlation-ID`**.

**Pagination**
- Responses carry `Link: <…>; rel="next"`, `X-Total-Count` and `X-Limit`.
- The Link must carry the original filters.
- The spec does not say how a hub treats a receiver's Link header. Rewriting it to a hub URL is required by
  construction, since the requester cannot call the receiver directly. That is our design, not a spec text.

**Status codes**
- 4xxx are hub errors:
  - 4000 generic
  - 4001 unknown receiver (TO address unknown)
  - 4002 timeout on forwarded request
  - 4003 connection problem (receiver not connected)
  - 49xx custom
- "When a server encounters an error … it sends the status code to the Hub. The Hub SHALL then forward this error to
  the client which sent the request (when the request was not a Broadcast Push)."
- Requests that reach the OCPI layer "MUST NOT" get an HTTP error status. **[VERIFY]** The spec does not say which
  HTTP status should carry a 4xxx code. We use HTTP 200 for 4001–4003, except 401/403 for authentication, and log
  it. PlugSure's own `ocpiCall` treats any non-1xxx code as a failure, so this is safe internally.

**Credentials**
- `roles` is a list of `CredentialsRole`, and each (role, party_id, country_code) must be unique.
- "A platform can have the same role more than once."
- "A Hub SHALL only report itself as role: Hub. A Hub SHALL NOT report all the other connected parties as a role …
  SHALL report connected parties via the HubClientInfo module."

**HubClientInfo** (data owner: Hub; a configuration module)
- `ClientInfo {party_id, country_code, role, status, last_updated}`, with status `CONNECTED`, `OFFLINE`, `PLANNED` or
  `SUSPENDED`.
- **Push:** the hub PUTs `{receiver}/{country_code}/{party_id}` to connected clients on every change. Objects are
  never deleted; they become SUSPENDED.
- **Pull:** `GET` on the hub's Sender interface returns the full list. It is "not for operational flow".
- OFFLINE: "Do not queue Push messages. When the other party comes back online, it is their responsibility to do a GET
  to get back in sync."
- PLANNED "may also be used when a Hub has some configuration indicating which parties have contracts with each
  other".
- **Still-alive check:** after "X minutes (when unsure, start with 5 minutes)" without a message, the hub sends `GET`
  to the party's versions endpoint.

**Commands and ChargingProfiles**
- Asynchronous results go to the `response_url` given in the request (body for Commands and PUT ChargingProfile,
  query string for GET and DELETE ChargingProfile).
- The CPO's synchronous answer carries `timeout` in seconds.
- The CPO pushes ActiveChargingProfile updates (PUT) to the Sender interface.
- The spec does not describe hub handling of response_url. A hub must rewrite it: the CPO may not be able to reach
  the eMSP, and the hub must be able to route the POST.

**Tokens real-time authorization**
- `POST {tokens_sender}/{token_uid}/authorize[?type=]`, with optional `LocationReferences` in the body.
- Tokens with `whitelist=NEVER` require it.
- The URL carries **no** country or party, so through a hub it needs `OCPI-to` headers or a hub-side token index
  (open routing).

**CDRs**
- POST to the eMSP's receiver. The eMSP answers with a `Location` URL, which the CPO later GETs.
- CDRs cannot be changed or deleted. Corrections are **Credit CDRs**: `credit=true`, `credit_reference_id` = original
  id, "only the values in `total_cost` SHALL contain the negative amounts", id up to 39 characters.
- "How far back in time a CPO can send a Credit CDR is not defined by OCPI. It is up [to] the business contracts".
  So the dispute and credit windows are ours to set contractually.

### 1.2 How commercial hubs clear and settle (brief)

| Hub | Model (as published) | Source |
|---|---|---|
| Hubject (OICP, also takes OCPI 2.2.1 CDRs) | *Hubject Financial Services*: "end-to-end invoicing and payment". **Invoices issued in the CPO's name** to the EMP (PDF + JSON + CSV of CDRs). Payments run on **Stripe's** infrastructure; CPOs set up payout accounts; a "small percentage of the payout transaction volumes" is the fee. EU/EEA/CH only; B2B only. Earlier *Invoice Management* combined CPO tariffs with CDRs and gave CPOs a monthly overview per EMP. | [Hubject FAQ CPO](https://support.hubject.com/hc/en-us/articles/26990001350813-FAQ-CPO), [Hubject invoice management](https://www.hubject.com/blog-posts/hubject-launches-new-eroaming-feature-invoice-management), [electrive 2021](https://www.electrive.com/2021/12/07/hubject-starts-automatic-invoice-management) |
| Gireve (OCPI hub, FR/EU) | "Trusted and neutral third party" clearing: CDR quality checks, pricing recomputed and **cross-checked with the roaming agreement**, B2B invoices per CDR sent to eMSPs, payment status tracking with reminders. To process payments it obtained **payment-agent status under ACPR via the EMI Xpollens** (SEPA): a licence was needed to move funds between operators. | [Gireve clearing](https://www.gireve.com/clearing-services/), [Gireve ACPR](https://www.gireve.com/acpr-agreement-gireve-takes-a-major-step-toward-simplifying-roaming-invoicing/), [Gireve B2B invoicing](https://www.gireve.com/gireve-facilitates-b2b-invoicing-of-ev-charging-in-roaming-situations/) |
| enapi (OCPI platform) | "Faulty CDRs are flagged early, disputes are resolved before invoices are sent"; shared real-time view per session; payment processing "coming soon". | [enapi financial](https://enapi.com/product/financial) |
| e-clearing.net | Could not confirm its current clearing terms from public sources. **[VERIFY]** before citing it. | — |

**What we take from this**
1. Validate CDRs and resolve disputes **before** the money moves.
2. The CPO stays the seller and invoices are in its name. The hub is a service provider that charges a fee.
3. A hub moves money only with a licence of its own or through a licensed PSP (Hubject: Stripe; Gireve: Xpollens).
4. Validation against the agreement's tariff (Gireve) is a phase-2 feature for us. Phase 1 runs plausibility checks.

**Not found publicly:** dispute window lengths, settlement cycles and commission percentages. They are contractual.
Our defaults are 14-day dispute window, monthly cycle and fee placeholders **[OWNER]**.

### 1.3 Regulatory flags (licensing) — for counsel, not conclusions

| Country | Why it matters | Flag |
|---|---|---|
| SG | The Payment Services Act 2019 licenses "domestic money transfer", "cross-border money transfer", "merchant acquisition" and "account issuance" services (MPI/SPI licences). Collecting from eMSPs and paying CPOs would likely be money transfer. Recording and instructing only (phase 1) likely is not. | **[LEGAL-SG]** |
| MY | Collection and disbursement for third parties may fall under the Financial Services Act 2013 (payment systems / designated payment instruments) or the Money Services Business Act 2011 (remittance). MY↔SG settlement also touches BNM foreign exchange policy. | **[LEGAL-MY]** |
| ID | Bank Indonesia Regulation PBI 22/23/PBI/2020 (payment systems): holding or transferring funds for others needs a PJP licence. Law 7/2011 (Currency) requires rupiah for transactions in Indonesia, which IDR ledgers satisfy. **As MoR, PlugSure would be reselling charging/electricity**, which in ID is tied to SPKLU business licensing **[LEGAL-ID]**. This is a strong argument against MoR. | **[LEGAL-ID]** |

---

## 2. Topology and concepts

```
                 ┌──────────────── PlugSure hub (/hub/ocpi, HUB_PUBLIC_URL) ────────────────┐
 external CPO ───┤ hub_connection(kind=external) ─┐                                          │
 (other CSMS)    │                                ├─ router ── route index ── agreements     │
 external eMSP ──┤ hub_connection(kind=external) ─┤      │                                   │
                 │                                │   hub_outbox (broadcast, callbacks)       │
 PlugSure tenant ┤ hub_connection(kind=internal) ─┘   hub_cdr ledger → clearing → statements │
  (CPO+eMSP)     └──────────────────────────────────────────────────────────────────────────┘
        ▲  in-process inject (D5)
        └── tenant side: ocpi_partner(kind='hub') in the tenant org, existing /ocpi surface
```

- **Member** (`hub_member`): a contracting legal entity, e.g. "PT Charge Indo" or a PlugSure tenant organisation.
  Netting, statements and invoices are per member.
- **Connection** (`hub_connection`): one credentials pairing. It holds tokens, the versions URL, endpoints and its
  transport (`external` or `internal`). A member usually has one; it may have more (e.g. a separate platform per
  country).
- **Party** (`hub_party`): a (country_code, party_id, role). It always belongs to one connection, which belongs to
  one member. ClientInfo is per party and role. Routing addresses (country_code, party_id).
- **Hub party** (`hub_self_party`): `ID*PSH`, `MY*PSH`, `SG*PSH`, linked to the PlugSure entity (`hub_entity`) of
  that country.
- **Agreement** (`hub_agreement`): CPO party ⇄ eMSP party, with commercial overrides.

**Endpoints are per connection, not per party.** The spec ties the versions URL and endpoint list to the credentials
exchange, so all parties of one platform share them. The brief's "versions/endpoints per party" is therefore stored
on the connection. Parties reference their connection.

---

## 3. Data model

Two migrations:
- `db/migrations/072_hub_core.sql` (H1): registry, routing, outbox, logs.
- `db/migrations/073_hub_clearing.sql` (H2): ledger, disputes, fees, settlement.

Both are **additive only**: no existing table is altered except one nullable column on `organisation`.

### 3.1 RLS model

All hub tables use the 048 shape:

```sql
USING (app_rls_bypass() OR <org predicate>) WITH CHECK (app_rls_bypass() OR <org predicate>)
```

**Platform admins.** Platform routes run unscoped, as `/v1/platform/*` does today: the bypass is on and no org is
pinned. They see everything. Every platform route checks `platform:admin` itself.

**Tenant view.** Rows carry the owning `org_id`, denormalised, so a tenant's console request sees only its own rows.
Two-sided rows (agreements, CDRs, disputes, positions) carry `cpo_org_id` and `emsp_org_id`, and the predicate is
`cpo_org_id = app_current_org() OR emsp_org_id = app_current_org()`.

**External members also get an org.** Each external member gets an `organisation` row with `hub_only = true`. This
lightweight org has no CSMS features; its console shows only the hub views. RLS and tenant views then work the same
for internal and external members. **[OWNER]** confirms that external members get console logins (default: yes,
invited by a platform admin).

**Tables with no tenant policy** (bypass only): `hub_connection` (tokens), `hub_route_index`, `hub_outbox`,
`hub_callback`, `hub_message`, `hub_self_party`, `hub_entity`. Tenants read connection status through
`hub_party` and views, never tokens.

```sql
ALTER TABLE organisation ADD COLUMN IF NOT EXISTS hub_only BOOLEAN NOT NULL DEFAULT false;
```

### 3.2 072_hub_core.sql (H1)

```sql
-- PlugSure entities that invoice hub fees (one per country where PlugSure has an entity) [OWNER: which exist]
CREATE TABLE hub_entity (
  country_code   TEXT PRIMARY KEY CHECK (country_code IN ('ID','MY','SG')),
  legal_name     TEXT NOT NULL,
  tax_id         TEXT,                        -- NPWP / SST no. / GST no.
  tax_registered BOOLEAN NOT NULL DEFAULT false,
  address        TEXT NOT NULL,
  bank_details   TEXT,                        -- sealed (services/secrets.ts)
  invoice_prefix TEXT NOT NULL,               -- e.g. 'PSH-ID-'
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The hub's own OCPI identities (role HUB)
CREATE TABLE hub_self_party (
  country_code   TEXT PRIMARY KEY CHECK (country_code ~ '^[A-Z]{2}$'),
  party_id       TEXT NOT NULL CHECK (party_id ~ '^[A-Z0-9]{3}$'),
  business_name  TEXT NOT NULL,
  website        TEXT,
  entity_country TEXT REFERENCES hub_entity(country_code),
  UNIQUE (country_code, party_id)
);

CREATE TABLE hub_member (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL UNIQUE REFERENCES organisation(id),  -- tenant org, or the hub_only org of an external member
  kind             TEXT NOT NULL CHECK (kind IN ('internal','external')),
  legal_name       TEXT NOT NULL,
  country_code     TEXT NOT NULL CHECK (country_code IN ('ID','MY','SG')),   -- of incorporation: picks the invoicing entity
  tax_id           TEXT,
  billing_email    TEXT,
  status           TEXT NOT NULL DEFAULT 'onboarding' CHECK (status IN ('onboarding','active','suspended','terminated')),
  open_roaming     BOOLEAN NOT NULL DEFAULT false,   -- D7 opt-in
  fee_plan_id      UUID,                             -- FK added in 073
  contract_ref     TEXT,                             -- signed hub agreement reference
  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE hub_connection (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id        UUID NOT NULL REFERENCES hub_member(id),
  kind             TEXT NOT NULL CHECK (kind IN ('external','internal')),
  state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','connected','suspended','closed')),
  -- token the member presents to us (A while pending, C after); sha-256 for lookup, sealed for GET /credentials
  token_in_hash    TEXT UNIQUE,
  token_in         TEXT,
  -- previous token_in during a rotation grace period
  token_prev_hash  TEXT UNIQUE,
  token_prev_until TIMESTAMPTZ,
  token_out        TEXT,                    -- sealed: what we present to the member
  versions_url     TEXT,
  version          TEXT,
  endpoints        JSONB NOT NULL DEFAULT '[]',
  peer_org_id      UUID REFERENCES organisation(id),       -- internal: the tenant org
  peer_partner_id  UUID REFERENCES ocpi_partner(id),       -- internal: the tenant's 'hub' partner row
  rate_limit_per_min INTEGER NOT NULL DEFAULT 600,
  realtime_limit_per_min INTEGER NOT NULL DEFAULT 1200,
  capture_bodies_until TIMESTAMPTZ,         -- support: redacted bodies logged until then (max 72 h)
  last_inbound_at  TIMESTAMPTZ,
  last_alive_ok_at TIMESTAMPTZ,
  alive_failures   INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  registered_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX hub_connection_internal_uq ON hub_connection (peer_org_id) WHERE kind = 'internal' AND state <> 'closed';

-- One owner (member) per (country_code, party_id), whatever roles it registers under it.
CREATE TABLE hub_party_key (
  country_code   TEXT NOT NULL,
  party_id       TEXT NOT NULL,
  member_id      UUID NOT NULL REFERENCES hub_member(id),
  PRIMARY KEY (country_code, party_id),
  UNIQUE (country_code, party_id, member_id)
);

CREATE TABLE hub_party (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id      UUID NOT NULL REFERENCES hub_member(id),
  org_id         UUID NOT NULL REFERENCES organisation(id),   -- = member.org_id (RLS)
  connection_id  UUID REFERENCES hub_connection(id),
  country_code   TEXT NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  party_id       TEXT NOT NULL CHECK (party_id ~ '^[A-Z0-9]{3}$'),
  role           TEXT NOT NULL CHECK (role IN ('CPO','EMSP','NSP','OTHER','SCSP','NAP')),
  business_name  TEXT NOT NULL,
  website        TEXT,
  status         TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('CONNECTED','OFFLINE','PLANNED','SUSPENDED')),
  admin_suspended BOOLEAN NOT NULL DEFAULT false,      -- SUSPENDED by the platform (sticky; alive checks do not lift it)
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (country_code, party_id, role),
  -- (cc, pid) may carry two roles (CPO and EMSP) of the same member, never of two members:
  FOREIGN KEY (country_code, party_id, member_id) REFERENCES hub_party_key (country_code, party_id, member_id)
);

CREATE TABLE hub_agreement (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cpo_party_id    UUID NOT NULL REFERENCES hub_party(id),
  emsp_party_id   UUID NOT NULL REFERENCES hub_party(id),
  cpo_org_id      UUID NOT NULL REFERENCES organisation(id),
  emsp_org_id     UUID NOT NULL REFERENCES organisation(id),
  status          TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','suspended','ended')),
  proposed_by     TEXT NOT NULL CHECK (proposed_by IN ('cpo','emsp','platform')),
  cpo_accepted_at  TIMESTAMPTZ,
  emsp_accepted_at TIMESTAMPTZ,
  valid_from      TIMESTAMPTZ,
  valid_to        TIMESTAMPTZ,
  allow_realtime_auth BOOLEAN NOT NULL DEFAULT true,
  allow_commands  BOOLEAN NOT NULL DEFAULT true,
  allow_charging_profiles BOOLEAN NOT NULL DEFAULT true,
  fee_plan_id     UUID,                     -- FK added in 073 (per-agreement commission override)
  notes           TEXT,                     -- commercial notes (e.g. tariff reference); not parsed
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX hub_agreement_live_uq ON hub_agreement (cpo_party_id, emsp_party_id) WHERE status IN ('proposed','active','suspended');

-- What the router learned from traffic, for open routing and CDR validation.
CREATE TABLE hub_route_index (
  kind            TEXT NOT NULL CHECK (kind IN ('location','token','session','reservation','authorization','command_session')),
  key             TEXT NOT NULL,            -- location_id | uid||':'||type | session_id | reservation_id | authorization_reference
  owner_party_id  UUID NOT NULL REFERENCES hub_party(id),   -- CPO for location/session/reservation; eMSP for token/authorization
  counter_party_id UUID REFERENCES hub_party(id),           -- the other side when known (session's eMSP, auth's CPO)
  data            JSONB,                    -- e.g. token whitelist, auth location_id, session status
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ,              -- authorization/reservation/session entries expire (90 days)
  PRIMARY KEY (kind, key, owner_party_id)
);

CREATE TABLE hub_outbox (
  id               BIGSERIAL PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('broadcast','callback','clientinfo','forward_retry')),
  origin_party_id  UUID REFERENCES hub_party(id),      -- null for hub-originated (clientinfo)
  recipient_connection_id UUID NOT NULL REFERENCES hub_connection(id) ON DELETE CASCADE,
  recipient_party_id UUID REFERENCES hub_party(id),    -- null for clientinfo (not routed)
  module           TEXT NOT NULL,
  method           TEXT NOT NULL CHECK (method IN ('POST','PUT','PATCH','DELETE')),
  url              TEXT,                 -- absolute (callbacks) or null = recipient endpoint + path_suffix
  path_suffix      TEXT,
  body             JSONB,
  object_key       TEXT NOT NULL,        -- ordering/coalescing key, e.g. 'locations:ID:CPX:LOC1'
  correlation_id   TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered','failed','dropped')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status      INTEGER,
  last_ocpi_status INTEGER,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at     TIMESTAMPTZ
);
CREATE INDEX hub_outbox_due_idx ON hub_outbox (next_attempt_at) WHERE state = 'pending';
CREATE INDEX hub_outbox_object_idx ON hub_outbox (recipient_connection_id, object_key, id) WHERE state = 'pending';

-- Rewritten response_url / CDR Location / cursors that need server state.
CREATE TABLE hub_callback (
  id               TEXT PRIMARY KEY,         -- 128-bit random, base64url; the only secret in the URL
  kind             TEXT NOT NULL CHECK (kind IN ('command_result','profile_result','active_profile','cdr_location')),
  origin_party_id  UUID NOT NULL REFERENCES hub_party(id),   -- who gave the original URL (eMSP / SCSP)
  target_party_id  UUID NOT NULL REFERENCES hub_party(id),   -- who may call the hub URL (CPO)
  original_url     TEXT NOT NULL,            -- sealed
  command          TEXT,                     -- START_SESSION ... / SET|GET|CLEAR
  ref              TEXT,                     -- session_id / authorization_reference for the index
  uses             INTEGER NOT NULL DEFAULT 0,
  max_uses         INTEGER,                  -- 1 for command results; null = until expiry
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL
);

CREATE TABLE hub_message (                   -- routing log for support; NO bodies unless capture is on
  id               BIGSERIAL PRIMARY KEY,
  correlation_id   TEXT NOT NULL,
  request_id_in    TEXT,
  request_id_out   TEXT,
  leg              TEXT NOT NULL CHECK (leg IN ('in','out')),
  connection_id    UUID,
  from_party       TEXT,                      -- 'ID*CPX'
  to_party         TEXT,                      -- 'MY*EMX' | 'HUB' | null (open)
  route            TEXT NOT NULL,             -- direct|broadcast|open|get_all|hub|callback
  module           TEXT,
  method           TEXT NOT NULL,
  path             TEXT NOT NULL,             -- token uids in paths masked: /tokens/ID/EMX/04AB…(sha8)
  http_status      INTEGER,
  ocpi_status      INTEGER,
  duration_ms      INTEGER,
  bytes            INTEGER,
  error            TEXT,
  body_redacted    JSONB,                     -- only while capture_bodies_until > now()
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX hub_message_corr_idx ON hub_message (correlation_id);
CREATE INDEX hub_message_conn_idx ON hub_message (connection_id, created_at DESC);
```

**Uniqueness note.** "One member per (country_code, party_id)" cannot be a plain unique index on `hub_party`, because
the same (cc, pid) may carry CPO and EMSP rows of one member. `hub_party_key` enforces it: its primary key admits one
owner, and `hub_party` references it by FK. `registerMember` and `joinInternal` insert the key with
`ON CONFLICT DO NOTHING`, then verify the owner. Another member's key → 2001 "party already registered on the hub".

**RLS policies (072)**
- `hub_member`, `hub_party`: `org_id = app_current_org()`.
- `hub_agreement`: `cpo_org_id = … OR emsp_org_id = …`.
- Everything else: bypass only.
- Grants follow the 015 pattern.

### 3.3 073_hub_clearing.sql (H2)

```sql
CREATE TABLE hub_fee_plan (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  currency         TEXT NOT NULL CHECK (currency IN ('IDR','MYR','SGD')),
  -- charged to the CPO side, on total_cost.excl_vat of each accepted CDR
  cpo_bps          INTEGER NOT NULL DEFAULT 0 CHECK (cpo_bps BETWEEN 0 AND 5000),
  cpo_fixed_minor  BIGINT  NOT NULL DEFAULT 0,
  cpo_min_minor    BIGINT  NOT NULL DEFAULT 0,
  cpo_max_minor    BIGINT,
  -- charged to the eMSP side
  emsp_bps         INTEGER NOT NULL DEFAULT 0 CHECK (emsp_bps BETWEEN 0 AND 5000),
  emsp_fixed_minor BIGINT  NOT NULL DEFAULT 0,
  is_default       BOOLEAN NOT NULL DEFAULT false,
  effective_from   DATE NOT NULL,
  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX hub_fee_plan_default_uq ON hub_fee_plan (currency, effective_from) WHERE is_default;
ALTER TABLE hub_member    ADD CONSTRAINT hub_member_fee_fk    FOREIGN KEY (fee_plan_id) REFERENCES hub_fee_plan(id);
ALTER TABLE hub_agreement ADD CONSTRAINT hub_agreement_fee_fk FOREIGN KEY (fee_plan_id) REFERENCES hub_fee_plan(id);

CREATE TABLE hub_cdr (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cpo_party_id       UUID NOT NULL REFERENCES hub_party(id),
  emsp_party_id      UUID NOT NULL REFERENCES hub_party(id),
  cpo_member_id      UUID NOT NULL REFERENCES hub_member(id),
  emsp_member_id     UUID NOT NULL REFERENCES hub_member(id),
  cpo_org_id         UUID NOT NULL REFERENCES organisation(id),
  emsp_org_id        UUID NOT NULL REFERENCES organisation(id),
  agreement_id       UUID REFERENCES hub_agreement(id),
  cdr_id             TEXT NOT NULL,             -- CiString(39)
  session_id         TEXT,
  credit             BOOLEAN NOT NULL DEFAULT false,
  credit_reference_id TEXT,
  credits_cdr_id     UUID REFERENCES hub_cdr(id),   -- the original, for a credit CDR
  credited_by_cdr_id UUID REFERENCES hub_cdr(id),   -- set on the original when credited
  currency           TEXT NOT NULL CHECK (currency IN ('IDR','MYR','SGD')),  -- other currencies: refused (held) at intake
  total_excl_minor   BIGINT NOT NULL,           -- toMinor(total_cost.excl_vat), signed (credit < 0)
  total_incl_minor   BIGINT,                    -- null when incl_vat absent (flag 'no_incl_vat')
  total_excl_raw     NUMERIC(18,4) NOT NULL,    -- as received (4 dp), audit
  total_incl_raw     NUMERIC(18,4),
  energy_kwh         NUMERIC(12,3) NOT NULL,
  start_at           TIMESTAMPTZ NOT NULL,
  end_at             TIMESTAMPTZ NOT NULL,
  location_country   TEXT,                      -- alpha-3 from cdr_location.country
  location_id        TEXT,
  evse_uid           TEXT,
  auth_method        TEXT,
  authorization_reference TEXT,
  token_type         TEXT,
  token_uid_hash     TEXT,                      -- sha-256(uid); uid itself only inside body
  contract_id        TEXT,
  body               JSONB NOT NULL,            -- the CDR as received (financial record)
  source             TEXT NOT NULL CHECK (source IN ('push','pull_tap','hub_pull')),
  flags              TEXT[] NOT NULL DEFAULT '{}',
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('held','pending','accepted','disputed','credited','written_off','void')),
  dispute_deadline   TIMESTAMPTZ NOT NULL,
  accepted_at        TIMESTAMPTZ,
  forward_state      TEXT NOT NULL DEFAULT 'pending' CHECK (forward_state IN ('pending','delivered','failed','not_needed')),
  emsp_location_url  TEXT,                      -- eMSP's Location header (sealed)
  fee_plan_id        UUID REFERENCES hub_fee_plan(id),
  fee_cpo_minor      BIGINT,                    -- frozen at acceptance
  fee_emsp_minor     BIGINT,
  settlement_run_id  UUID,                      -- FK below
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cpo_party_id, cdr_id)
);
CREATE INDEX hub_cdr_status_idx ON hub_cdr (status, dispute_deadline);
CREATE INDEX hub_cdr_emsp_idx ON hub_cdr (emsp_org_id, received_at DESC);
CREATE INDEX hub_cdr_cpo_idx  ON hub_cdr (cpo_org_id, received_at DESC);
CREATE INDEX hub_cdr_session_idx ON hub_cdr (cpo_party_id, session_id) WHERE NOT credit;

CREATE TABLE hub_dispute (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hub_cdr_id       UUID NOT NULL REFERENCES hub_cdr(id),
  cpo_org_id       UUID NOT NULL, emsp_org_id UUID NOT NULL,   -- RLS
  raised_by        TEXT NOT NULL CHECK (raised_by IN ('emsp','cpo','platform')),
  reason           TEXT NOT NULL CHECK (reason IN ('unknown_token','not_authorized','duplicate','amount','energy',
                                                  'tariff_mismatch','session_not_found','other')),
  claimed_minor    BIGINT,                         -- amount the disputer considers correct (optional)
  message          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','cpo_accepted','cpo_rejected','escalated','resolved')),
  resolution       TEXT CHECK (resolution IN ('credited','upheld','partially_credited','written_off')),
  resolution_note  TEXT,
  credit_cdr_id    UUID REFERENCES hub_cdr(id),     -- the credit CDR that resolved it
  respond_by       TIMESTAMPTZ NOT NULL,            -- CPO response deadline (default +10 days)
  created_by       UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by      UUID, resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX hub_dispute_open_uq ON hub_dispute (hub_cdr_id) WHERE status <> 'resolved';

CREATE TABLE hub_settlement_run (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  currency        TEXT NOT NULL CHECK (currency IN ('IDR','MYR','SGD')),
  period_start    TIMESTAMPTZ NOT NULL,
  period_end      TIMESTAMPTZ NOT NULL,         -- exclusive
  cut_off_at      TIMESTAMPTZ NOT NULL,         -- CDRs accepted before this are included
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalised','void')),
  totals          JSONB NOT NULL DEFAULT '{}',
  created_by      UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalised_by    UUID, finalised_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX hub_settlement_run_live_uq ON hub_settlement_run (currency, period_start) WHERE status <> 'void';
ALTER TABLE hub_cdr ADD CONSTRAINT hub_cdr_run_fk FOREIGN KEY (settlement_run_id) REFERENCES hub_settlement_run(id);

-- Bilateral net position per member pair (unordered pair stored with payer/payee after netting)
CREATE TABLE hub_settlement_position (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           UUID NOT NULL REFERENCES hub_settlement_run(id) ON DELETE CASCADE,
  member_a_id      UUID NOT NULL REFERENCES hub_member(id),   -- a < b (uuid order)
  member_b_id      UUID NOT NULL REFERENCES hub_member(id),
  org_a_id         UUID NOT NULL, org_b_id UUID NOT NULL,      -- RLS
  a_owes_b_minor   BIGINT NOT NULL,   -- Σ CDR totals where B is CPO, A is eMSP (incl VAT basis)
  b_owes_a_minor   BIGINT NOT NULL,
  net_minor        BIGINT NOT NULL,   -- |a_owes_b - b_owes_a|
  payer_member_id  UUID REFERENCES hub_member(id),            -- null when net = 0
  payee_member_id  UUID REFERENCES hub_member(id),
  cdr_count        INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','confirmed','overdue','written_off')),
  due_date         DATE NOT NULL,
  UNIQUE (run_id, member_a_id, member_b_id)
);

CREATE TABLE hub_statement (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           UUID NOT NULL REFERENCES hub_settlement_run(id),
  member_id        UUID NOT NULL REFERENCES hub_member(id),
  org_id           UUID NOT NULL,                            -- RLS
  currency         TEXT NOT NULL,
  number           TEXT NOT NULL UNIQUE,                     -- 'PSH-ST-2026-10-IDR-000123'
  receivable_minor BIGINT NOT NULL,   -- as CPO
  payable_minor    BIGINT NOT NULL,   -- as eMSP
  net_minor        BIGINT NOT NULL,   -- receivable - payable (after bilateral netting = Σ positions)
  fee_net_minor    BIGINT NOT NULL,   -- hub fee for the period (both sides), excl tax
  data             JSONB NOT NULL,    -- frozen rendering data (positions, CDR counts, disputes carried)
  pdf_key          TEXT,              -- services/storage.ts
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, member_id)
);

CREATE TABLE hub_payment (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id      UUID NOT NULL REFERENCES hub_settlement_position(id),
  payer_member_id  UUID NOT NULL, payee_member_id UUID NOT NULL,
  payer_org_id     UUID NOT NULL, payee_org_id UUID NOT NULL,   -- RLS
  currency         TEXT NOT NULL,
  amount_minor     BIGINT NOT NULL CHECK (amount_minor > 0),
  method           TEXT NOT NULL CHECK (method IN ('bank_transfer','stripe_connect','xendit','other')),
  reference        TEXT,
  paid_at          DATE NOT NULL,
  recorded_by      UUID NOT NULL,
  recorded_side    TEXT NOT NULL CHECK (recorded_side IN ('payer','payee','platform')),
  confirmed_by_payee_at TIMESTAMPTZ,
  evidence_key     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE hub_fee_invoice (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id        UUID NOT NULL REFERENCES hub_member(id),
  org_id           UUID NOT NULL,                              -- RLS
  entity_country   TEXT NOT NULL REFERENCES hub_entity(country_code),
  run_id           UUID REFERENCES hub_settlement_run(id),
  currency         TEXT NOT NULL,
  number           TEXT NOT NULL UNIQUE,
  net_minor        BIGINT NOT NULL,
  tax_scheme       TEXT NOT NULL,                              -- ID_PPN | SG_GST | MY_SST | NONE | REVERSE_CHARGE
  tax_base_minor   BIGINT NOT NULL,
  tax_minor        BIGINT NOT NULL,
  total_minor      BIGINT NOT NULL,
  wht_expected_minor BIGINT NOT NULL DEFAULT 0,               -- ID PPh 23 (2 %) the member withholds
  status           TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','paid','void')),
  pdf_key          TEXT,
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at          TIMESTAMPTZ
);
```

**RLS policies (073)**
- `hub_cdr` and `hub_dispute`: two-sided.
- `hub_settlement_position`: `org_a_id`/`org_b_id`.
- `hub_statement` and `hub_fee_invoice`: `org_id`.
- `hub_payment`: payer or payee org.
- `hub_fee_plan` and `hub_settlement_run`: bypass only. Tenants see their fee plan through the API, never the
  table.

**Retention**
- `hub_cdr`, statements, payments and invoices are kept **10 years**. This is the longest bookkeeping horizon
  across ID, MY and SG **[VERIFY]**: ID 10 y (UU KUP), SG 5 y, MY 7 y.
- `hub_message`: 30 days.
- Captured bodies: 72 h.
- `hub_outbox` delivered rows: 14 days; failed rows: 60 days.
- `hub_route_index`: expiring kinds are kept 90 days.

### 3.4 Relationship to existing tables

| Existing | Hub use |
|---|---|
| `ocpi_party` (org, country) | Source of an **internal** member's parties. `joinInternal(orgId)` copies the CPO roles (every party) and the EMSP role (home party) into `hub_party`. When the tenant later edits its parties (`PUT /v1/roaming/parties/:country`), a hook calls `syncInternalParties(orgId)`, which adds or suspends parties and pushes ClientInfo. |
| `ocpi_partner` | For an internal member, one row `kind='hub'`, `name='PlugSure Hub'`, in the tenant org, created by `joinInternal`. `endpoints` = the hub's endpoint list, `roles` = the hub's HUB roles, `country_code`/`party_id` = the hub party of the tenant's home country, `state='connected'`. Its token_in and token_out are the mirror of the `hub_connection` tokens. External members never get an `ocpi_partner` row. |
| `ocpi_hub_client` | Filled on the tenant side by the hub's ClientInfo pushes, through the existing `receiveClientInfo` (unchanged). |
| `ocpi_push`, `ocpi_message` | Unchanged. Tenant pushes to the hub use them, exactly as with any partner. |

---

## 4. Party registry and onboarding

### 4.1 Hub credentials and versions

`src/hub/credentials.ts`:
- `hubVersions(base)` → `[{version:'2.2.1', url: base+'/hub/ocpi/2.2.1'}]`.
- `hubEndpoints(base)` returns the list below.
- `hubCredentials(token, base)` → `{token, url: base+'/hub/ocpi/versions', roles: hub_self_party.map(p => ({role:'HUB', country_code, party_id, business_details}))}`.

| identifier | role | URL (`/hub/ocpi/2.2.1/…`) |
|---|---|---|
| credentials | SENDER, RECEIVER | `credentials` |
| hubclientinfo | SENDER | `hubclientinfo` |
| locations, tariffs, sessions, cdrs, tokens | SENDER | `sender/{module}` |
| locations, tariffs, sessions, cdrs, tokens | RECEIVER | `receiver/{module}` |
| commands | RECEIVER | `receiver/commands` (eMSPs send commands) |
| commands | SENDER | `sender/commands` (base of rewritten response_urls; see §5.6) |
| chargingprofiles | RECEIVER | `receiver/chargingprofiles` |
| chargingprofiles | SENDER | `sender/chargingprofiles` (CPO's ActiveChargingProfile PUTs + result callbacks) |

The hub needs both roles per module because it stands in for both sides. `/hub/ocpi/*` is **not** under the
`/ocpi/` prefix, so the existing `registerOcpiApi` preHandler (`underPrefix(req,'/ocpi/')`) never sees hub traffic.
H1 must check the other global hooks for the same assumption: rate limit, stream guard and CSP (`src/api/server.ts`).

### 4.2 External member: member starts (hub issues token A)

1. A platform admin creates the member (`POST /v1/hub/members`). This creates the `hub_only` org and `hub_member`.
2. The admin then calls `POST /v1/hub/members/:id/connections`.
   - It creates `hub_connection(pending)` with token A, which is shown once.
   - It shows the versions URL `HUB_PUBLIC_URL/hub/ocpi/versions`.
3. The member GETs versions and version details with token A, then POSTs its credentials (token B, its URL, its
   roles).
4. `registerMember(conn, body)` does the following, mirroring `registration.registerFromPartner`:
   - Validate roles: each role must be CPO, EMSP, NSP, OTHER or SCSP. **HUB is refused** (no hub-to-hub
     peering in phase 1 **[OWNER]**). Each (cc, pid) must be free or already this member's.
   - Discover the endpoints with B, through the SSRF guard (`partnerUrlProblem`).
   - Issue token C.
   - Upsert the `hub_party` rows: status `CONNECTED` if the member is `active`, else `PLANNED` until the admin
     activates it.
   - Race-safe `UPDATE … WHERE state='pending' AND token_in_hash=$A` (same pattern as today).
   - Return the hub's credentials.
5. Afterwards (`setImmediate`):
   - `pushClientInfoAbout(newParties)` to all counterparties that have agreements with them;
   - `pushClientInfoTo(conn)`: the full list of the parties visible to this member.

**PUT /credentials** (update, token rotation by the member):
- Allowed changes: the token, the URL and the endpoints. The party set cannot change (same rule as
  `registration.ts`). A new party needs an admin to approve it: `POST /v1/hub/connections/:id/parties`, then the
  member PUTs again.

**DELETE /credentials:**
- The connection is closed and its parties become `SUSPENDED`. ClientInfo is pushed.
- Pending outbox rows to it are marked `dropped`.

### 4.3 External member: hub starts

The member gives its versions URL and token A. `POST /v1/hub/connections/:id/connect {versions_url, token}` runs
`connectToMember()`, mirroring `connectToPartner`:
- discover with A;
- POST the hub's credentials with token B;
- receive token C;
- validate roles as in §4.2.

### 4.4 Internal member (PlugSure tenant): zero-config

`joinInternal(orgId, actor)` in `src/hub/registry.ts` runs in **one transaction**:
1. Require `ocpi_party` rows for the org. Without them the call fails with 409 "set up roaming identity first".
2. Upsert `hub_member(kind='internal', org_id=orgId, legal_name=org.legal_name, country_code=org.home_country)`.
3. Generate two tokens:
   - `t1`, which the tenant presents to the hub: stored as `hub_connection.token_in_hash`/`token_in` and as the
     partner's `token_out`;
   - `t2`, which the hub presents to the tenant: stored as `hub_connection.token_out` and as the partner's
     `token_in_hash`/`token_in`.
4. Insert the `ocpi_partner(kind='hub', state='connected', endpoints=hubEndpoints(HUB_PUBLIC_URL), roles=HUB roles,
   country_code/party_id = hub party of the tenant's home country, registered_at=now())`.
5. Insert `hub_connection(kind='internal', state='connected', peer_org_id, peer_partner_id,
   endpoints=ourEndpoints(OCPI_PUBLIC_URL), versions_url=OCPI_PUBLIC_URL/ocpi/versions, version='2.2.1')`.
   `ourEndpoints` is the tenant-side function; it is the same for every org because the org is identified by token.
6. Insert the `hub_party` rows from `getParties(orgId)`: a CPO role for every party, an EMSP role for the home party.
   Status = CONNECTED.
7. After commit:
   - ClientInfo pushes as in §4.2;
   - `syncOrg(orgId, {forceAll:true, partnerId})`: the existing push.ts broadcasts the tenant's published locations,
     tariffs and shared tokens to the hub (the hub fans them out);
   - `importFromCpo(partner)`: the existing GET All through the hub imports agreed CPOs' locations.

Who can trigger it:
- a platform admin (`POST /v1/hub/members/join-tenant {org_id}`), or
- a tenant with `roaming:write`, if `HUB_SELF_JOIN=true` (`POST /v1/roaming/hub/join`).

The tenant starts `onboarding`; a platform admin activates it after the contract is signed.

`leaveInternal(orgId)`:
- closes the connection;
- sets the partner to `closed` (existing `closePartner(partner,false)`);
- suspends the parties.

Ledger rows are kept.

### 4.5 Status lifecycle

| Event | hub_party.status | ClientInfo push |
|---|---|---|
| registration done, member active | CONNECTED | to agreed counterparties |
| registration done, member onboarding | PLANNED | — (not visible) |
| alive check fails twice (≈10 min) | OFFLINE | yes |
| any inbound message or alive OK | CONNECTED (unless admin_suspended) | yes, if it changed |
| admin suspends party, connection or member | SUSPENDED (admin_suspended) | yes |
| DELETE credentials / connection closed | SUSPENDED | yes |

**Token rotation.**
- Hub-initiated, as the spec does it: the hub calls PUT on the member's credentials with a new token B'. It keeps
  accepting the member's old C until the member's PUT returns the new C'.
- `POST /v1/hub/connections/:id/rotate`: the platform forces a rotation. The old token_in stays valid for
  `HUB_TOKEN_GRACE_MIN` (default 60) via `token_prev_hash`.

---

## 5. Routing engine (`src/hub/`)

### 5.1 Files (H1 ownership)

| File | Content |
|---|---|
| `src/hub/server.ts` | `registerHubApi(app)`: hooks and routes under `/hub/ocpi`; mounted only when `config.hub.enabled` |
| `src/hub/registry.ts` | members, connections and parties CRUD; `joinInternal`, `leaveInternal`, `syncInternalParties`; `connectionByToken(hashes)`; `partyByKey(cc,pid,role?)`; `partiesOfConnection` |
| `src/hub/credentials.ts` | `hubVersions`, `hubEndpoints`, `hubCredentials`, `registerMember`, `connectToMember`, `closeConnection`, `rotateConnectionToken` |
| `src/hub/router.ts` | `classify(req)` → `RouteDecision`; `routeDirect`, `routeOpen`, `routeBroadcast`, `routeGetAll`; `forward()` |
| `src/hub/rewrite.ts` | `rewriteLink`, `rewriteResponseUrl`, `rewriteCdrLocation`, `openCursor`/`sealCursor` |
| `src/hub/index.ts` | `learn(decision, req, res)` keeps `hub_route_index` up to date; `resolveOpen(module, req)` |
| `src/hub/agreements.ts` | `agreementBetween(cpoPartyId, emspPartyId)`; `mayRoute(from, to, module, method)`; `visibleCounterparties(partyId, role)`; CRUD and approval workflow |
| `src/hub/outbox.ts` | `enqueueHub()`, `deliverHubDue()`, coalescing, the offline rule, `replayHub()`, `pruneHub()` |
| `src/hub/clientinfo.ts` | `clientInfoFor(viewerConnection)`, `pushClientInfoAbout(parties)`, `pushClientInfoTo(conn)`, `aliveChecks()` |
| `src/hub/transport.ts` | `hubCall()` (outbound to a member: inproc vs HTTPS), `injectorFor(url)` |
| `src/hub/log.ts` | `logHub()`, `redact(body, module)` |
| `src/hub/errors.ts` | `HubError(http, ocpi, msg)`, `HUB_STATUS` = {GENERIC:4000, UNKNOWN_RECEIVER:4001, TIMEOUT:4002, CONNECTION:4003, NO_AGREEMENT:4901, NOT_BROADCASTABLE:4902, FROM_MISMATCH:4903, AMBIGUOUS:4904, RATE_LIMITED:4905} |
| `src/hub/ledger-tap.ts` | `tapCdr(from, to, cdr, source)`: the **interface** H2 implements (H1 ships a stub that inserts the minimal row) |

### 5.2 Request pipeline

`preHandler` on `/hub/ocpi/*`:

1. **Authenticate.**
   - `tokensFromAuthHeader` → hash → `hub_connection` by `token_in_hash` or `token_prev_hash` (while the grace
     period is valid).
   - No match → 401.
   - State not `connected` → only versions and credentials are allowed (as `/ocpi`).
   - Connection or member suspended → 403 OCPI 2000 "suspended".
2. **Rate limit.**
   - `takeKeyToken('hub:'+conn.id, conn.rate_limit_per_min)`, reusing `services/ratelimit.ts` with shared buckets.
   - Real-time authorize uses its own bucket, `'hubrt:'+conn.id`.
   - Exceeded → HTTP 429 with OCPI 4905 and `Retry-After`.
3. **Size.**
   - Request body up to 1 MB (the Fastify `bodyLimit` already in place).
   - Forwarded responses are capped at 20 MB (the existing client cap). A GET All page is capped at
     `min(limit, 100)` objects.
4. **Classify** (`classify`): module, interface (`sender`/`receiver`/config/callback), method, path params.
5. **Config modules** (versions, credentials, hubclientinfo) are answered by the hub. Routing headers are ignored
   (the spec says they SHALL NOT be used).
6. **From check** for functional modules:
   - Take `OCPI-from-country-code`/`-party-id`. Missing headers are allowed only if the connection has exactly one
     party for the role this interface needs; the hub then infers it.
   - The from party must be a `hub_party` of **this connection**, with status CONNECTED or OFFLINE, and with a role
     fit for the interface:

     | Hub interface | Caller role |
     |---|---|
     | `receiver/locations`, `receiver/tariffs`, `receiver/sessions`, `receiver/cdrs` | CPO |
     | `receiver/tokens`, `receiver/commands` | EMSP (or OTHER) |
     | `receiver/chargingprofiles` | EMSP or SCSP |
     | `sender/*` GETs | the opposite role of the data owner |

   - Mismatch → 403 OCPI 4903 ("OCPI-from does not belong to this connection").
   - For **client-owned object URLs** (`receiver/{module}/{cc}/{pid}/…`), cc and pid must equal the from party.
     Body `country_code`/`party_id`, when present, must equal the URL. Otherwise → 400 OCPI 2001.
7. **Target** (`OCPI-to-*`):
   - a hub party → `broadcast` (non-GET) or `get_all` (GET list);
   - a member party → `direct`;
   - none → `open`.
   - An unknown to → HTTP 200 with OCPI 4001.
   - A to that is SUSPENDED or PLANNED, or OFFLINE on a synchronous request → OCPI 4003.
8. **Agreement** (`mayRoute`) for direct and open routes → OCPI 4901 "no active roaming agreement between X and Y".
   Module flags (`allow_commands` …) are checked here too.
9. **Execute** the route, **learn** (index), **tap** (ledger) and **log** (`hub_message`: one `in` row plus one
   `out` row per forwarded leg, sharing `correlation_id`).

### 5.3 Routing table (what happens per module)

Notation:
- **D** = direct (to = party);
- **B** = broadcast (to = hub);
- **GA** = GET All (to = hub);
- **O** = open (no to);
- "idx" = route index lookup.

| Hub interface & method | Caller | D | to = hub | O (no to) | Index learned |
|---|---|---|---|---|---|
| `receiver/locations/{cc}/{pid}/{loc}[/{evse}[/{conn}]]` PUT/PATCH | CPO | forward if agreement | **B** to agreed EMSP/NSP/OTHER with a `locations RECEIVER` endpoint | **B** (spec: broadcast when destination unknown) | location(loc → cpo) |
| `receiver/locations/…` GET (CPO checks its copy) | CPO | forward | 2001 (GET is not broadcast) | 4001 | — |
| `receiver/tariffs/{cc}/{pid}/{id}` PUT/DELETE | CPO | forward | **B** | **B** | — |
| `receiver/tokens/{cc}/{pid}/{uid}[?type]` PUT/PATCH | eMSP | forward | **B** to agreed CPOs with `tokens RECEIVER` | **B** | token(uid:type → emsp, data.whitelist) |
| `receiver/sessions/{cc}/{pid}/{id}` PUT | CPO | forward | 4902 (sessions are not broadcastable) | to = body `cdr_token.country_code/party_id` (EMSP role) | session(id → cpo, counter = emsp) |
| `receiver/sessions/…` PATCH | CPO | forward | 4902 | idx session | session |
| `receiver/cdrs` POST | CPO | forward | 4902 | to = `cdr_token` party | **ledger tap**; Location rewrite |
| `receiver/cdrs/{hubCdrId}` GET | CPO | — (hub URL) | — | `hub_callback(cdr_location)` → GET the eMSP's Location | — |
| `receiver/commands/{TYPE}` POST | eMSP | forward | 4902 | START_SESSION, RESERVE_NOW, UNLOCK_CONNECTOR: idx location(location_id), filtered to CPOs agreed with from (4904 if still ambiguous); STOP_SESSION: idx session (counter = from); CANCEL_RESERVATION: idx reservation | authorization(auth_ref → emsp, counter = cpo, data.location_id); reservation; response_url rewrite |
| `receiver/chargingprofiles/{session_id}` GET/PUT/DELETE | eMSP or SCSP | forward | 4902 | idx session | response_url rewrite; command_session (session → setter) |
| `sender/locations` GET (list) | eMSP | forward (Link rewrite) | **GA** across agreed CPOs | treated as **GA** (lenient; logged `open_get_all`) | location (from results) |
| `sender/locations/{loc}[/{evse}[/{conn}]]` GET | eMSP | forward | 2001 | idx location (agreed CPOs) | — |
| `sender/tariffs` GET | eMSP | forward | **GA** | GA | — |
| `sender/sessions` GET (date_from required) | eMSP | forward + response filter | **GA** + response filter | GA | session |
| `sender/sessions/{id}/charging_preferences` PUT | eMSP | forward | 4902 | idx session | — |
| `sender/cdrs` GET | eMSP | forward + filter + **ledger tap** | **GA** + filter + tap | GA | — |
| `sender/tokens` GET | CPO | forward | **GA** across agreed eMSPs | GA | token |
| `sender/tokens/{uid}/authorize[?type]` POST | CPO | forward (real-time timeout) | 4902 | idx token(uid:type), else 4001 | authorization(response `authorization_reference` → emsp, counter = cpo, location_id) |
| `sender/chargingprofiles/{session_id}` PUT (ActiveChargingProfile update) | CPO | forward | 4902 | idx command_session → setter; else session's eMSP | — |
| `sender/commands/{cbId}`, `sender/chargingprofiles/result/{cbId}` POST | CPO | — | — | hub_callback → original URL (outbox, async) | authorization confirmations |
| `hubclientinfo` GET (list) | any | — | — | own | — |

**Response filter (defence in depth, D12).** On `sender/sessions` and `sender/cdrs` responses, the hub drops every
object whose `cdr_token.country_code`/`party_id` is not the requester. The dropped count is logged as
`filtered=N`. The filter does not adjust `X-Total-Count`: the spec offers no right answer here, and this is a safety
net that should never fire against a correct CPO. A non-zero count raises the alert `hub.response_filtered`.

### 5.4 Forwarding (`forward()`)

1. **Recipient endpoint.** Take the target connection's endpoint for (module, opposite role):

   | Hub interface | Recipient interface |
   |---|---|
   | `receiver/*` | the recipient's `RECEIVER` endpoint |
   | `sender/*` | the recipient's `SENDER` endpoint |

   No such endpoint → OCPI 4003 "receiver does not implement {module} {role}". For a broadcast, the recipient is
   skipped instead.
2. **URL.** Append the inbound path suffix after the module segment to the recipient's endpoint URL and keep the
   query string. For example, `…/hub/ocpi/2.2.1/receiver/locations/ID/CPX/L1/E1` →
   `{recipient.locations.RECEIVER}/ID/CPX/L1/E1`. Path segments are re-encoded with `encodeURIComponent`, never
   copied raw.
3. **Headers.**

   | Header | Value |
   |---|---|
   | `Authorization` | `Token base64(recipient token_out)` |
   | `X-Request-ID` | new UUID |
   | `X-Correlation-ID` | the inbound one, if well-formed, else new |
   | `OCPI-from-*` | the original sender (direct/open); the hub party (broadcast) |
   | `OCPI-to-*` | the recipient party |
   | `Content-Type` | as inbound |
   | other inbound headers | dropped (cookies, forwarded-for, etc.) |
4. **Body.** As received, byte-for-byte JSON after parse and re-serialise; `last_updated` is never touched (spec).
   **Exception:** a `response_url` is rewritten (§5.6).
5. **Deadline.**

   | Request | Default |
   |---|---|
   | most requests | `HUB_FORWARD_TIMEOUT_MS` 10 000 |
   | real-time authorize | `HUB_REALTIME_TIMEOUT_MS` 4 000 |

   The real-time default is below PlugSure's own 5 000 ms caller default, so the hub answers 4002 before the
   caller gives up. Timeout → HTTP 200 with OCPI 4002. Connection refused, DNS or TLS failure → OCPI 4003.
6. **Response relay.**
   - Pass through the recipient's HTTP status and OCPI envelope (the spec says the hub SHALL forward the
     receiver's 2xxx/3xxx).
   - Set `OCPI-from` = recipient and `OCPI-to` = requester.
   - Pass `X-Total-Count` and `X-Limit` through.
   - Rewrite `Link` (§5.6).
   - Rewrite `Location` (CDR POST, §5.6).
   - Drop every other upstream header.
7. **Liveness.** A successful forward sets the recipient party CONNECTED (if OFFLINE) and updates
   `last_inbound_at`-style liveness for the alive checker.

**Transport (`hubCall`, D5).**

| URL | Transport |
|---|---|
| under `config.ocpi.publicUrl` (a tenant's `/ocpi`) or `config.hub.publicUrl` | in-process (`inject`) |
| anything else | `ocpiCall`-equivalent HTTPS with `guardedLookup`, no redirects and a hard deadline |

H1 extracts the HTTP half of `ocpi/client.ts` into `requestOcpi({…, transport})` so that `ocpiCall` and `hubCall`
share it. `ocpiCall` gets the same origin test, so tenant → hub calls are in-process too.

### 5.5 Broadcast fan-out (`routeBroadcast`)

1. Validate the from party, the URL ownership and the body (JSON object, `last_updated` present).
2. **Recipients** = every `hub_party` P that meets all of these:
   - P has the opposite role (CPO → EMSP, NSP and OTHER; EMSP/OTHER → CPO);
   - P is not on the sender's member — no echo to self, so a tenant that is both CPO and eMSP does not receive its
     own locations;
   - P's connection is connected and has a `{module} RECEIVER` endpoint;
   - an active agreement exists between the sender and P, or both members have `open_roaming`;
   - P's status is CONNECTED.
3. **One outbox row per recipient party.**
   - `object_key` = `{module}:{cc}:{pid}:{id}` (the location id is the key for its EVSE and connector PATCHes as
     well, so they stay ordered).
   - `path_suffix` and the body are stored, and `kind='broadcast'`.
   - **Coalescing:** a new PUT for (recipient, object_key) marks older *unsent* (`attempts=0`) PUT and PATCH rows of
     that key `dropped`. A PATCH is appended. This is the same idea as push.ts's dedupe, but with stored bodies.
4. **Respond at once** with `1000`, `OCPI-from` = hub party and `OCPI-to` = sender. The spec says the hub answers
   the broadcaster.
5. **Delivery** (`deliverHubDue`, workers, every 5 s; same claim SQL pattern and backoff as `push.ts`, with
   `BACKOFF_S` and `MAX_ATTEMPTS` exported from there):
   - Ordered per (recipient_connection, object_key).
   - Recipient **OFFLINE or SUSPENDED** → row `dropped` ("do not queue push messages"; the recipient resyncs with
     GET All). Exception: the outbox keeps `callback` rows and retries them through OFFLINE periods for up to
     24 h, because an eMSP that missed a command result cannot GET it back.
   - A 2xxx answer from the recipient → `failed` with no retry, logged and counted per recipient on the health
     page. 3xxx, 4xxx or a network error → retry.
6. Broadcast PATCH to a recipient that answers 2003 (unknown location) → the hub cannot re-render the location.
   It enqueues a `GET` of the full location from the origin CPO (direct, as the hub party), then a PUT to that
   recipient. **[Phase-1 option]** If this proves complex, the hub just records it; recipients resync via GA.
   Default: implement it, since it mirrors push.ts's `patch_evse` fallback.

### 5.6 Rewrites (`rewrite.ts`)

**Pagination `Link`** (direct GET and GET All)
- Upstream `<U>; rel="next"` becomes `<HUB/hub/ocpi/2.2.1/sender/{module}?hub_cursor=C>; rel="next"`.
- C = `seal(JSON{v:1, conn: requesterConnectionId, kind:'direct'|'all', module, src: [...], i, next: U, exp})` with
  AAD `'hub-cursor'`, base64url.
- The cursor is bound to the requesting connection, so another member's token cannot replay it. It expires after
  1 h.
- `hub_cursor` is the only parameter honoured on such a call. Others are ignored, because the upstream Link already
  carries the filters (the spec requires that).

**GET All composite cursor** (`routeGetAll`)
1. Sources = agreed counterparties with the right role and the module's `SENDER` endpoint, sorted by `cc*pid` for
   a stable order.
2. Probe first:
   - On the first call, probe every source in parallel (concurrency 8, real-time deadline 4 s) with the original
     query and `limit=1`, to read `X-Total-Count`.
   - The page total = Σ totals. Failed sources count 0 and are listed in the `hub_message` error ("sources
     skipped: …").
   - This keeps the spec's required `X-Total-Count` honest without a cache.
3. Then serve source i's pages in order:
   - each hub page = one upstream page with `limit=min(requested,100)`;
   - when source i has no `next`, move to source i+1, with the original query and offset 0.
4. `Link` is present while any source remains. `X-Limit` = the requested limit, capped at 100.
5. **Phase 2:** a location and tariff mirror (filled from broadcast traffic) to serve GA from the database. Not
   needed for the pilot volumes: 3 countries and a handful of CPOs.

**`response_url`** (Commands body; ChargingProfiles PUT body and GET/DELETE query)
- Create a `hub_callback` row:
  - `kind` = command_result or profile_result;
  - origin = eMSP party, target = CPO party, `original_url` sealed;
  - `max_uses` = 1 for commands; null for profiles. A profile row may receive repeated results, but only until
    expiry.
  - `expires_at`:
    - commands: now + `HUB_CALLBACK_TTL_S` (default 900 s; the CPO's `timeout` is typically 30–120 s, and late
      results still need to land);
    - profiles: 24 h.
- Replace the URL with `HUB/hub/ocpi/2.2.1/sender/commands/{TYPE}/{cbId}` or
  `…/sender/chargingprofiles/result/{cbId}`.
- The original URL is checked with `partnerUrlProblem` before it is accepted (SSRF). Internal tenants' URLs pass
  as in-process.

**Callback inbound** (`POST …/sender/commands/{TYPE}/{cbId}`)
1. The token's connection must own `target_party_id`, and `OCPI-from` must equal it. Else 403 / 4903.
2. Unknown or expired id → 404 with OCPI 2000.
3. `uses >= max_uses` → **idempotent**: answer 1000 and do not forward again.
4. Otherwise answer 1000 at once and enqueue `kind='callback'` to `original_url` with the origin connection's
   token. From = CPO, to = eMSP. This keeps CPO latency low and survives a slow eMSP.
5. Learn: for START_SESSION ACCEPTED, set the `authorization` index entry's `data.confirmed=true`.

**CDR `Location`**
- On a forwarded CDR POST, the eMSP's `Location` header is stored in `hub_cdr.emsp_location_url` (sealed).
- The CPO receives `Location: HUB/hub/ocpi/2.2.1/receiver/cdrs/{hub_cdr.id}`.
- A CPO GET of that URL is authorised: the from party must be the `hub_cdr.cpo_party_id`. The hub then forwards the
  GET to the stored URL with the eMSP connection's token.
- If the eMSP gave no Location, the hub serves `hub_cdr.body` itself.

### 5.7 Idempotency and duplicates

**Most writes are idempotent by construction.** PUT, PATCH and DELETE of OCPI objects are idempotent; retries are
safe.

**CDR POST**
- Ledger insert `ON CONFLICT (cpo_party_id, cdr_id) DO NOTHING`.
- A duplicate whose forward was `delivered` → answer 1000 with the stored hub `Location`, and do not forward again.
- A duplicate whose forward was `pending` or `failed` → forward again (the CPO is retrying because the eMSP failed).
- A duplicate that differs in amounts → 2001 "CDR id already used with different content; send a credit CDR".
  The `cdr_duplicate_conflict` flag is added on the original.

**Commands**
- Inbound `X-Request-ID` is remembered for 10 minutes per connection in an in-memory LRU (`hub_dedupe`; size 10k).
- A repeat while the first is in flight or answered → the cached response is returned.
- Lost on restart; the eMSP's own retry semantics apply. A table is not justified.

**Callbacks:** `max_uses`, as above.

**Ledger tap:** taps of pulled CDRs (`sender/cdrs` GA or direct) also use `ON CONFLICT DO NOTHING`, with
`source='pull_tap'`.

### 5.8 ClientInfo (hub as SENDER) and alive checks

**Visibility**
- A viewer connection sees, for each of its parties, every counterparty that:
  - has an `active` agreement with it, or is mutually `open_roaming`, and
  - has the opposite role.
- Its own other parties are **not** listed, because the tenant code would otherwise treat itself as a hub client.
- Parties without an agreement are not listed. **[OWNER]** Alternative: list them as `PLANNED` to advertise the
  network. The default is not to list, to keep commercial relationships private and match the closed model.

**Endpoints**
- `GET /hub/ocpi/2.2.1/hubclientinfo` returns the paged list for the caller (offset, limit, date_from/date_to on
  `last_updated`). It sends no routing headers.

**Push**
- `pushClientInfoAbout(partyIds)` enqueues `kind='clientinfo'`, `PUT {viewer hubclientinfo RECEIVER}/{cc}/{pid}`,
  for every viewer that can see the party.
- It is triggered by status changes, agreement activation (both sides learn of each other), suspension and
  `ended`. On `ended`, the party is pushed as SUSPENDED to the former counterparty: objects cannot be deleted, so
  SUSPENDED is the spec's "invalidate".
- ClientInfo rows are not dropped when OFFLINE. They are retried for 24 h.

**Effect on tenants.** The existing `receiveClientInfo` stores these rows, and `partnerActsFor` then lets the hub
partner act only for agreed parties. That is a second enforcement point inside the tenant.

**Alive checks** (`aliveChecks`, workers, every minute)
- For each connected connection with no inbound or successful outbound in `HUB_ALIVE_AFTER_MIN` (5): GET the
  member's versions URL (real-time deadline).
- Two consecutive failures → all its parties OFFLINE, with a ClientInfo push.
- Success → back to CONNECTED.
- Internal connections pass trivially, through in-process.

### 5.9 Agreements: where enforcement happens

| Point | Rule |
|---|---|
| Broadcast fan-out | recipients ∩ agreed |
| GET All sources | sources ∩ agreed |
| Direct / open routes | `mayRoute(from,to)`. The CPO/eMSP pair is derived from the roles: if from and to are both CPO, or both eMSP, the route is refused with 2001 (no such business case in phase 1) |
| Open-routing index lookup | candidates filtered to agreed counterparties *before* the ambiguity check |
| Real-time authorize | `allow_realtime_auth` |
| Commands | `allow_commands` |
| ChargingProfiles | `allow_charging_profiles` |
| ClientInfo visibility | agreed only |
| Ledger admission | a CDR with no active agreement at `start_at` → `held` (`no_agreement`), forwarded anyway **[OWNER]**, since the session already happened and withholding the CDR harms the driver relationship; not settled until resolved |

**Agreement workflow.**
1. One side proposes, in the tenant or member console or as a platform admin.
2. The other side accepts.
3. A platform admin may require approval: with `HUB_AGREEMENT_PLATFORM_APPROVAL=true` (default false), status only
   becomes `active` after the admin approves too.
4. On activation:
   - push ClientInfo to both sides;
   - enqueue a "welcome sync": a GA-equivalent nudge. The hub cannot push the CPO's data itself, so it does the
     following:
     - for an **internal CPO**, it calls `syncOrg(orgId,{forceAll:true, partnerId})`;
     - for an **external CPO**, it sends nothing. The eMSP pulls via GA, and future broadcasts include it.

### 5.10 Logging and support

- `hub_message`: one `in` row per inbound request and one `out` row per forwarded leg, with:
  - `correlation_id`;
  - from and to as `CC*PID`;
  - route, module and method;
  - the **masked path** (`redact.path`: token uids and contract ids → first 4 chars + `…` + sha-256 prefix 8);
  - statuses, duration and bytes.
- **Bodies** are logged only when the admin turns on capture for one connection (`capture_bodies_until`, max 72 h,
  audited). `redact.body` masks `uid`, `contract_id`, `visual_number`, `auth_id`, `name` and `email`. It is never
  on for `credentials`.
- **Console "trace"** shows all legs of one correlation id.
- **Health metrics**, rolling per connection, from `hub_message`: success rate, p95 latency, 4002/4003 counts,
  outbox backlog and dropped counts. Alerts (`alert.raised`, platform org `NIL_ORG`) fire on:
  - `hub.connection_offline` (> 15 min);
  - `hub.outbox_backlog` (> 1 000 pending for one connection);
  - `hub.forward_error_rate` (> 20 % over 15 min);
  - `hub.response_filtered`.

### 5.11 Workers (`src/services/workers.ts` additions, only when `HUB_ENABLED`)

| Job | Every | Function |
|---|---|---|
| `hub-outbox` | 5 s | `deliverHubDue(100)` |
| `hub-alive` | 60 s | `aliveChecks()` |
| `hub-clientinfo-resync` | 6 h | full ClientInfo push to every connection (repairs drift) |
| `hub-cdr-accept` | 15 min | H2 `autoAccept()` |
| `hub-cdr-pull` | 24 h | H2 `pullCdrsFromCpos()`: GET `cdrs SENDER` of CPOs **that do not push**, date_from = last pull, tapped to the ledger, not forwarded |
| `hub-dispute-escalate` | 1 h | H2 `escalateOverdue()` |
| `hub-settlement-draft` | daily | H2 creates or refreshes draft runs |
| `hub-prune` | daily | `pruneHub()` |

All of them run under the existing `exclusive()` lock pattern.

---

## 6. Internal shortcut (decision D5, detail)

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| (a) Loopback HTTPS through the public URL | uniform | LB/TLS round trip, SSRF guard must allow ourselves, double rate limiting, fragile in dev | no |
| (b) Direct function calls (hub calls `emsp.receiveLocation` etc.) | fastest | a second code path per module; diverges from what external members see; bypasses the tenant's auth/headers; big surface for bugs | no |
| (c) **In-process `inject()` into the same Fastify app** | identical semantics (hooks, auth, headers, logging); no network; deadline enforced with `Promise.race`; tests exercise the real code | the inject target must be in the process | **yes** |

**Process placement**
- **Synchronous routing** (direct, open, GA, real-time authorize, commands) runs in the **API process**, where both
  the hub and `/ocpi` are mounted. It injects into `app`.
- **Asynchronous delivery** (hub outbox in workers; tenant `ocpi_push` to the hub in workers) needs an injector in
  the workers process. `injectorFor()` lazily builds a **minimal Fastify instance** that mounts only
  `registerOcpiApi` and `registerHubApi`, with the same `bodyLimit`, once per process.
  - All handlers reachable from outbox deliveries are DB-only. These are PUT/PATCH/DELETE on locations, tariffs,
    tokens and sessions; POST cdrs; ClientInfo PUT; and callback POSTs into `/ocpi/2.2.1/emsp/commands/…`.
  - **Commands are never delivered from the outbox.** They are synchronous routes in the API process.
  - **[VERIFY in H1]** Grep that no handler reachable from those routes needs the OCPP registry. `handleCommand`
    and `profiles.setProfile` do, but they are only reached synchronously.
- **Origin test:** `new URL(u).origin === new URL(config.ocpi.publicUrl).origin` (or the hub's). The path decides
  the surface.
- **Logging and transport label:** `hub_message.route` gets the suffix `+inproc` and `ocpi_message.error` stays null.
  The tenant still sees normal `ocpi_message` rows for its partner "PlugSure Hub".

**Two tenants on PlugSure:** a CPO tenant A and an eMSP tenant B.
1. A's push.ts sends PUT location (to = hub) → inject → hub broadcast → outbox → inject → B's
   `/ocpi/2.2.1/emsp/locations/…` with B's hub partner token.
2. B's driver starts: B's `sendCommand` posts to the hub `receiver/commands` (to = A's party) → hub → inject → A's
   `/ocpi/2.2.1/commands/START_SESSION`.
3. The result comes back via the rewritten response_url → hub callback → outbox → B.

No bilateral A↔B partner rows are needed.

---

## 7. WP H0 — tenant-side isolation behind hubs (pre-existing gap, fix first)

**Finding (from code review, v1.7.0).** The CPO-side and eMSP-side handlers scope by `partner.id`. A hub partner
stands for many parties, so every party behind one hub shares that id:

| Code | Gap behind a hub |
|---|---|
| `store.listSessions` / `listCdrs` (`cs.ocpi_partner_id = $2`) | an eMSP behind the hub pulling `GET /sessions` gets **every** hub eMSP's sessions on this CPO |
| `server.ts` tokens GET/PATCH (`t.partner_id !== partner.id`) | eMSP X can read or patch eMSP Y's token pushed through the same hub (PUT is guarded by `partnerActsFor` on the URL party; GET/PATCH are not) |
| `commands.ts` STOP_SESSION (`cs.ocpi_partner_id = $3`) | X can stop Y's driver's session |
| `profiles.ts` set/clear/get profile (by partner) | X can limit Y's driver's session |
| `emsp.ts` receiveSession/receiveCdr/getRemoteCdr/receiveCommandResult (partner-scoped) | a CPO behind a hub can overwrite another CPO's session or CDR records for our drivers if ids collide; `receiveCommandResult` accepts the result of a command sent to another CPO |
| `server.ts` command handler `from` falls back to `partner.country_code` | through a hub, `from` must be required |

**Fix (H0, owned by H1's engineer, done first, also shipped to `multi-country` as a point release).** When
`partner.kind === 'hub'`, every handler additionally scopes by the **OCPI-from party**:
- `ctx(req).from` = `{cc,pid}` from the headers. It is required for functional modules when the partner is a hub
  (2001 if missing), and must satisfy `partnerActsFor(partner, cc, pid, role)`.
- Sessions and CDRs: the token party must equal from (`t.country_code = $from_cc AND t.party_id = $from_pid` joined
  through `ocpi_token`).
- Tokens GET/PATCH: `t.country_code/party_id` must equal from.
- STOP_SESSION and profiles: the session's token party must equal from.
- eMSP side: `receiveSession`, `receiveCdr` and `getRemote*` match the URL or body party = from, and
  `ocpi_remote_*` lookups include `country_code/party_id = from`. `receiveCommandResult` requires
  `ocpi_command.partner_id = partner.id` **and** that the command's target party (store `to` in
  `ocpi_command.request`) = from.

Tests go in `src/ocpi/trust.test.ts` (one test per row above), plus `hub-e2e` isolation step 13.

**Status: done in v1.7.1** (commit 7f95c8c on `multi-country`, merged here). As built:
- `server.ts` preHandler: `hubModuleRole(path)` gives the role per module; `ctx(req).acting` is the checked
  from-party (null for a peer). Missing from → 400/2001; not announced in that role → 403/2000. GET locations /
  tariffs (public) may be pulled by the hub without from; configuration modules never need it.
- Command target stored as `ocpi_command.request.to` (not sent); results from another party → 404. Commands
  stored before v1.7.1 or addressed to the hub accept any announced CPO.
- Also covered beyond the table: UNLOCK_CONNECTOR, CANCEL_RESERVATION, RESERVE_NOW id reuse, START_SESSION /
  RESERVE_NOW with another eMSP's token (it used to rewrite that token), locations/tariffs on the eMSP side,
  charging-profile results addressed to the hub (now OCPI-to = the eMSP), pushes' OCPI-from = the object's party.
- Tests: `src/ocpi/hub-isolation.test.ts` (one per row, plus peer regressions) instead of `trust.test.ts`;
  stack-level cases in `tools/e2e/ocpi-profiles-e2e.mts` (to fold into `hub-e2e` step 13g).

---

## 8. Clearing and settlement (H2)

### 8.1 Role of PlugSure (D10)

- **Phase 1 (recommended): clearing house, not MoR, no funds.**
  - The CPO supplies the charging service to the eMSP and is the seller; tax on the CDR is the CPO's.
  - The hub provides "roaming and clearing services" to both, for a fee.
  - The hub computes, per cycle and currency, what each member owes each other member, and issues statements and
    payment instructions. The payer transfers directly to the payee. Both sides record or confirm the payment in
    the console. The hub chases overdue positions and may suspend a member for non-payment (contract).
  - **Netting** is bilateral only: A↔B in one currency. It is a contractual set-off between the two parties, and
    it is legal without the hub holding funds **[LEGAL: confirm set-off clause enforceable in ID/MY/SG]**.
    Multilateral netting needs a central counterparty that receives and pays funds, so it is phase 2.
- **Phase 2:** collection and payout through a licensed PSP: Stripe Connect (SG and MY; PlugSure as platform,
  members as connected accounts) and Xendit xenPlatform (ID). The PSP holds the funds and the licence. The hub fee
  can be deducted at source (`application_fee`), and multilateral netting becomes possible. `hub_payment.method`
  already allows it.
- **Why not MoR:**
  1. PlugSure would resell charging (electricity) in ID, which brings SPKLU licensing **[LEGAL-ID]**.
  2. VAT/GST would apply to the gross in three countries, PlugSure would need tax registration everywhere, and
     cross-border supplies follow.
  3. PlugSure would carry the credit risk of every eMSP.
  4. Money transmission licensing would apply.
  5. Hubject and Gireve keep the CPO as the invoicing party.

**What the CPO's tax invoice is.**
- The hub statement is **not** a tax invoice.
- The CPO issues its own tax invoice to the eMSP from the statement data (CSV and JSON per counterparty).
  PlugSure-tenant CPOs get a button that generates it with the existing invoice/PDF machinery (Phase 1.1).
- **Self-billing** by the hub in the CPO's name, as Hubject does, needs per-country self-billing or agent
  arrangements **[LEGAL]**. Not phase 1.

### 8.2 Intake and validation (`src/hub/clearing/intake.ts`)

`tapCdr(fromParty, toParty, cdr, source)` is called by the router on CDR POST (before forwarding) and on CDRs seen in
GET responses.

1. **Parse.**
   - Reuse field checks from `emsp.receiveCdr`: id ≤ 39 characters, `currency`, `total_cost.excl_vat`, `total_energy`,
     `start_date_time`, `end_date_time`, `cdr_token`, `cdr_location`.
   - A malformed CDR on POST → 2001, and it is not forwarded. A malformed CDR seen in a pull is logged and skipped.
2. **Parties.**
   - CPO = from (push) or the object's cc/pid (pull).
   - eMSP = `cdr_token.country_code/party_id`. The eMSP must be a `hub_party` with role EMSP or OTHER.
   - Agreement lookup at `start_date_time`.
3. **Amounts.**
   - `toMinor(excl_vat, currency)` and `toMinor(incl_vat)` with the `domain/money` exponent (IDR 0, MYR and SGD 2),
     rounding half-up. Raw 4-dp values are kept.
   - Credit CDRs carry negative totals. Other currencies → `held` (`unsupported_currency`).
4. **Hard checks → `held`** (hub ops must release or void):
   - `no_agreement`;
   - `unsupported_currency`;
   - `currency_country_mismatch`: the currency is not the location's country currency per the `domain/country`
     registry;
   - `implausible`: reuse `emsp.cdrPlausibilityProblem` (excl ≤ incl, energy ≤ `CDR_MAX_KWH`, price per kWh ≤
     country cap, end > start, duration ≤ 48 h);
   - `credit_unknown_reference`;
   - `credit_amount_mismatch`: the credit total must equal minus the original's;
   - `cdr_duplicate_conflict`.
5. **Soft flags → `pending`, shown to both sides:**
   - `no_session_seen`: no session index entry for (cpo, session_id), when the CPO uses the sessions module;
   - `no_authorization_seen`:
     - `auth_method=AUTH_REQUEST` and no authorization index entry with this `authorization_reference` for this
       (cpo, emsp); or
     - `COMMAND` and no START_SESSION through the hub with that reference;
   - `whitelist_token_unknown`: WHITELIST and the token was never broadcast by the eMSP;
   - `late_cdr`: `end_at` older than 60 days at receipt;
   - `overlap`: same token hash with an overlapping time window on another EVSE;
   - `duplicate_session`: another non-credit CDR for the same (cpo, session_id);
   - `no_incl_vat`.
6. **Dispute deadline** = `received_at + HUB_DISPUTE_DAYS` (14).
   - A credit CDR is `accepted` immediately and links `credits_cdr_id`/`credited_by_cdr_id`. If the original was in
     a settled run, the credit offsets in the next run. If it was not yet settled, both settle together (net zero).
7. **Return.**
   - Forwarding proceeds for `pending` and for `held`; held is forwarded too **[OWNER]**, default forward.
   - The tap never blocks forwarding, except for malformed CDRs.

### 8.3 Lifecycle

```
pending ──(deadline passes, no dispute)──► accepted ──(in run)──► settled (settlement_run_id set)
   │                                          ▲
   ├─(eMSP disputes ≤ deadline)─► disputed ─(resolved: upheld)┘
   │                                 └─(credit CDR received / written_off)─► credited | written_off
held ──(platform releases)──► pending (deadline restarts) | void
```

- `autoAccept()`: `UPDATE hub_cdr SET status='accepted', accepted_at=now(), fee_* = computeFees(…) WHERE
  status='pending' AND dispute_deadline <= now()`.
  - Fees are computed and frozen at acceptance.
  - Most-specific plan wins:
    - CPO side: agreement plan, else CPO member plan, else default plan of the currency effective at `start_at`;
    - eMSP side: agreement plan, else eMSP member plan, else default.
- **Disputes** (console/API, eMSP side or platform; deadline: before `dispute_deadline`):
  - Reason, message and optional `claimed_minor`.
  - The CPO responds by `respond_by` (+10 days):
    - **accept** → the CPO must send a credit CDR (and optionally a new CDR). The dispute auto-resolves
      `credited` when the credit CDR for that id arrives. Until then the CDR stays `disputed` (excluded from runs).
    - **reject** with a reason → the eMSP may escalate within 5 days, or the dispute auto-resolves `upheld` (the
      CDR becomes `accepted`).
  - Overdue CPO response → `escalated` to the platform.
  - Platform resolution: `upheld` (accepted), `written_off` (excluded; the CPO is not paid), or
    `partially_credited` (the CPO must send credit + new CDR; the platform may mark it written_off if the CPO does
    not comply in 10 days).
  - Every transition is audited (`audit()` with `hub.dispute_*`).
  - OCPI has no dispute module, so this is console/API only. **[OWNER]** Window lengths are defaults.

### 8.4 Fees (hub commission)

```
fee_cpo  = clamp(round(excl_minor × cpo_bps / 10000) + cpo_fixed_minor, cpo_min_minor, cpo_max_minor)
fee_emsp = round(excl_minor × emsp_bps / 10000) + emsp_fixed_minor
```

- Credit CDRs produce negative fees, which reverse the original's frozen fee. The minimum is not reapplied.
- Basis = **excl. VAT** amount. The hub fee is not a share of tax.
- **Default plans** are seeded per currency with `cpo_bps=0` and `emsp_bps=0` until the owner sets them **[OWNER]**.
  A typical structure to decide on: CPO pays a % of excl-VAT turnover with a per-CDR minimum, and optionally the
  eMSP pays a fixed per-CDR fee. Public hubs do not disclose rates (see §1.2).
- Fees are **not netted** against member positions in phase 1. PlugSure holds no funds, so it invoices its fees
  separately (§8.6).

### 8.5 Settlement runs, netting, statements (`src/hub/clearing/settlement.ts`)

**Cycle**
- Monthly per currency (`HUB_CYCLE=monthly`; `weekly` supported). Each period follows the currency's country time
  zone: IDR `Asia/Jakarta`, MYR `Asia/Kuala_Lumpur`, SGD `Asia/Singapore`.
- Draft run: `period_end` = the first day of the next month, 00:00 local.
- Finalisation from `period_end + HUB_DISPUTE_DAYS + 1` days, so that CDRs received late in the month have passed
  their window. Example: the September run finalises on 16 October.

**`buildRun(currency, periodStart)`**
- Draft, idempotent: re-running a draft recomputes it.
- Includes CDRs with `status='accepted' AND currency=$c AND settlement_run_id IS NULL AND received_at <
  period_end`. Credit CDRs are included by the same rule.
- Carried CDRs (pending or disputed at cut-off) are listed in the statement data as "carried forward" with count and
  amount.

**Per member pair (A < B)**
- `a_owes_b` = Σ `total_incl_minor` (fallback `total_excl_minor` with flag `no_incl_vat`) over CDRs where cpo_member
  = B and emsp_member = A. `b_owes_a` is the reverse.
- **Basis is incl. VAT.** The eMSP pays the CPO the gross the CPO invoices.
- `net`, payer and payee follow from these. `due_date` = finalised date + `HUB_PAYMENT_TERMS_DAYS` (14)
  **[OWNER]**.

**Same member on both sides.** A member's own parties never roam with each other through the hub. Such CDRs are
refused at intake (`self_roaming` hard flag); a tenant's own drivers on its own chargers are not roaming.

**`finaliseRun(runId, actor)`**
1. Locks the run and stamps `settlement_run_id` on its CDRs.
2. Creates `hub_settlement_position` rows and one `hub_statement` per member that has any position or fee.
3. Freezes `data`.
4. Renders the PDF with `services/pdf.ts` (`PdfDoc`/`Flow`, the same machinery as commission statements), plus a
   CSV of CDRs per counterparty.
5. Issues fee invoices (§8.6).
6. Notifies members by email and webhook `hub.statement.issued`.

A finalised run is immutable. Corrections flow through credit CDRs into the next run.

**Statement contents** (per member, per currency)
- Per counterparty: as CPO (receivable) and as eMSP (payable), CDR count, energy, gross incl. and excl. VAT, then
  the net and its direction, due date and payment instruction (payee bank details as entered by the payee).
- Carried and disputed items.
- Hub fees summary, with a reference to the fee invoice.

**Payments**
- `POST /v1/hub/payments` records a payment. Either side or the platform can record it; a payee recording counts
  as confirmation.
- The position becomes `paid` when the recorded sum ≥ net, and `confirmed` once the payee confirms.
- Past the due date and unpaid → `overdue`, an alert, and a reminder email on days 1, 7 and 14.
- **[OWNER]** Auto-suspension of a payer's eMSP parties after N days overdue. Default off; a manual action is
  offered.

### 8.6 Hub fee invoices and tax

- One invoice per member, currency and run: Σ `fee_cpo` on the CDRs where the member is CPO + Σ `fee_emsp` where it
  is eMSP.
- **Issuing entity:** the PlugSure entity of the member's country (`hub_member.country_code` → `hub_entity`).
  - If PlugSure has no entity there, the invoice comes from `HUB_DEFAULT_ENTITY` (cross-border), and tax handling
    becomes reverse-charge or none **[LEGAL]**.
  - Currency = the run currency. An MY member settling IDR CDRs therefore gets an IDR fee invoice from the MY
    entity **[VERIFY]** with accounting: invoicing in a foreign currency is allowed but needs local-currency tax
    conversion at the official rate. That is FX for tax reporting only, and **flagged**.
- **Tax** reuses the engines. Compute with `engineFor(ctx).computeFee({netMinor, …})`, where `ctx` is a new
  `platformTaxContext(entityCountry, at)` that builds a TaxContext for the PlugSure entity rather than an
  operator org:

  | Entity | Treatment |
  |---|---|
  | ID | PPN 12 % × DPP 11/12 (effective 11 %), as for platform commission today. Expect **PPh 23 2 %** withholding (`wht_expected_minor`), as in Architecture §9.8; track the bukti potong |
  | SG | GST 9 % if `hub_entity.tax_registered` **[VERIFY: registration threshold S$1m]**; NONE otherwise. Overseas customers: zero-rated international service? **[LEGAL-SG]** |
  | MY | Service tax 8 % on taxable services if registered **[VERIFY: whether a B2B digital/clearing service is "taxable service" Group G/I]** |
  | Cross-border | the recipient may self-account (ID PPN on foreign services, SG reverse charge, MY imported taxable services) **[LEGAL]**; invoice with `tax_scheme='REVERSE_CHARGE'`, tax 0 |

- Numbering: `{invoice_prefix}{YYYY}-{seq}` per entity. Sequences are per entity and gapless, with a row lock, as
  the existing invoice numbering does.
- PDFs come from `services/pdf.ts`. e-Faktur export for ID invoices goes through the existing `services/efaktur.ts`
  shape **[VERIFY field mapping for a platform-issued invoice]**.

### 8.7 Files (H2 ownership)

| File | Content |
|---|---|
| `src/hub/clearing/intake.ts` | `tapCdr`, `validateCdr` (pure, unit-tested), `classifyFlags` |
| `src/hub/clearing/fees.ts` | `planFor(side, cdr)`, `computeFees` (pure) |
| `src/hub/clearing/disputes.ts` | `openDispute`, `respondDispute`, `escalate`, `resolveDispute`, `escalateOverdue`, `onCreditCdr` |
| `src/hub/clearing/settlement.ts` | `autoAccept`, `buildRun`, `finaliseRun`, `positionsOf`, `recordPayment`, `confirmPayment`, `markOverdue` |
| `src/hub/clearing/statements.ts` | `statementData`, `statementPdf`, `statementCsv` |
| `src/hub/clearing/invoices.ts` | `issueFeeInvoices(run)`, `feeInvoicePdf`, `platformTaxContext` |
| `src/hub/clearing/pull.ts` | `pullCdrsFromCpos()` |
| `src/services/tax/index.ts` (small addition) | export `platformTaxContext` (or put it in `invoices.ts` to avoid touching the tax module; H2's choice, reviewed by the tax owner) |

---

## 9. Console and API (H3 owns UI; routes are owned by the WP whose data they serve)

### 9.1 Platform admin — `src/api/hub-routes.ts` (H1 core routes; H2 adds `hub-clearing-routes.ts`)

All routes require `platform:admin`, run unscoped and are audited (`hub.*` actions).

| Route | Purpose |
|---|---|
| `GET /v1/hub/overview` | counts: members, parties by status, agreements, 24 h traffic, backlog, open disputes, overdue positions |
| `GET/POST /v1/hub/members`, `GET/PATCH /v1/hub/members/:id` | create an external member (+ `hub_only` org, invite admin user), activate, suspend, terminate, open_roaming, fee plan |
| `POST /v1/hub/members/join-tenant` `{org_id}` | internal zero-config join |
| `POST /v1/hub/members/:id/connections` | new external connection: returns **token A once** + versions URL |
| `POST /v1/hub/connections/:id/connect` `{versions_url, token}` | hub-initiated handshake |
| `POST /v1/hub/connections/:id/(suspend\|resume\|rotate\|close)` | lifecycle |
| `POST /v1/hub/connections/:id/capture` `{hours≤72}` | body capture for support |
| `POST /v1/hub/connections/:id/parties` | approve an additional party |
| `GET /v1/hub/parties`, `PATCH /v1/hub/parties/:id` | status, suspend |
| `GET/POST /v1/hub/agreements`, `PATCH /v1/hub/agreements/:id` `{action: approve\|suspend\|resume\|end, fee_plan_id}` | agreements |
| `GET /v1/hub/messages?connection=&party=&correlation=&route=&status=&from=&to=` | message log (paged) |
| `GET /v1/hub/messages/trace/:correlationId` | all legs |
| `GET /v1/hub/outbox?state=&connection=`, `POST /v1/hub/outbox/replay` `{connection_id}` | outbox |
| `GET /v1/hub/health` | per-connection metrics |
| `GET /v1/hub/cdrs?status=&flag=&cpo=&emsp=&currency=`, `GET /v1/hub/cdrs/:id`, `POST /v1/hub/cdrs/:id/(release\|void)` | ledger (H2) |
| `GET /v1/hub/disputes`, `POST /v1/hub/disputes/:id/resolve` | disputes (H2) |
| `GET/POST /v1/hub/fee-plans` | fee plans (H2) |
| `GET/POST /v1/hub/settlement-runs`, `GET /v1/hub/settlement-runs/:id`, `POST /v1/hub/settlement-runs/:id/finalise` | runs (H2) |
| `GET /v1/hub/statements/:id(.pdf\|.csv)`, `GET /v1/hub/fee-invoices`, `POST /v1/hub/payments`, `POST /v1/hub/payments/:id/confirm` | statements, payments (H2) |
| `GET/PUT /v1/hub/entities`, `GET/PUT /v1/hub/self-parties` | configuration |

### 9.2 Member/tenant view — added to `src/api/roaming-routes.ts` under `/v1/roaming/hub/*`

Permissions: `roaming:read` / `roaming:write`. Scoped by RLS.

| Route | Purpose |
|---|---|
| `GET /v1/roaming/hub` | membership, connection state, own parties, directory of members open for agreements (name, country, roles, open_roaming) |
| `POST /v1/roaming/hub/join` | self-join (when `HUB_SELF_JOIN`) |
| `GET/POST /v1/roaming/hub/agreements`, `POST /v1/roaming/hub/agreements/:id/(accept\|end)` | propose and accept |
| `GET /v1/roaming/hub/cdrs?side=cpo\|emsp&status=` | own ledger rows (both sides) |
| `POST /v1/roaming/hub/cdrs/:id/dispute`, `POST /v1/roaming/hub/disputes/:id/(respond\|escalate)` | disputes |
| `GET /v1/roaming/hub/statements`, `GET …/:id(.pdf\|.csv)`, `GET /v1/roaming/hub/fee-invoices(/:id.pdf)` | documents |
| `GET /v1/roaming/hub/positions`, `POST /v1/roaming/hub/payments`, `POST /v1/roaming/hub/payments/:id/confirm` | payments |
| `PUT /v1/roaming/hub/bank-details` | payee bank details (sealed; shown on counterparties' statements) |

**Webhooks** (existing `services/webhooks.ts`): `hub.cdr.flagged`, `hub.dispute.opened`, `hub.dispute.updated`,
`hub.statement.issued` and `hub.payment.overdue`.

### 9.3 UI (H3)

- **Platform:** new view `src/web/js/views/hub.js`, menu "Hub" visible only to platform admins when `HUB_ENABLED`.
  Tabs:
  - **Members** (with a wizard: legal details → connection → token A shown once with a copy button + versions URL →
    status);
  - **Agreements**;
  - **Traffic** (health table, message log with trace drawer, outbox with replay);
  - **Clearing** (ledger with flag filters, held queue, disputes);
  - **Settlement** (runs per currency, draft preview, finalise with confirm, positions, payments, overdue);
  - **Fees & invoices**;
  - **Settings** (entities, hub parties).
- **Tenant / external member:** inside `roaming.js`, a "PlugSure Hub" section with membership, agreements
  (directory + proposals), "Hub CDRs" (both sides, dispute button), statements and invoices, and payments.
  `hub_only` orgs see only this section plus users and API keys. `src/web/js/core.js` hides the CSMS menus when
  `org.hub_only`.

---

## 10. Security

1. **A party can only send as itself** (§5.2 step 6): the from party must belong to the token's connection, and URL
   and body ownership must equal from.
2. **A party only receives what is addressed to it:**
   - direct and open routes go to exactly one recipient;
   - broadcast goes to agreed recipients only;
   - GA aggregates only agreed sources;
   - responses are filtered on sessions and CDRs;
   - callbacks are bound to (target party, id, expiry, uses);
   - cursors are sealed and bound to the requesting connection;
   - the CDR Location is bound to the CPO party.
3. **Tokens:**
   - 32 random bytes, base64url;
   - stored as a hash plus a sealed copy (`seal()`, AAD `hub_connection:{id}:in|out`);
   - shown once on creation;
   - rotation with a grace period;
   - DELETE credentials or close kills them at once.
4. **SSRF:** every external member URL goes through `partnerUrlProblem` + `guardedLookup` (https only in prod, no
   private IPs, no redirects, hard deadline). That covers the versions URL, the endpoints, `response_url`
   originals and Location URLs. The in-process transport is chosen only by exact origin equality with our own
   configured public URLs, never by hostname resolution.
5. **Abuse limits:**
   - per-connection token buckets;
   - per-connection outbox backlog cap (10 000 pending; above that, new broadcasts *to* that recipient are
     dropped and an alert fires);
   - broadcast fan-out cap per inbound message (1 000 recipients);
   - inbound body 1 MB; GA page ≤ 100; callbacks ≤ 1 per command id.
6. **Header hygiene:** echo only well-formed `X-Request-ID`/`X-Correlation-ID` (reuse `idLike`); never forward
   inbound `Authorization`, cookies or `X-Forwarded-*`.
7. **Audit** (`services/audit.ts`, platform chain `NIL_ORG` and member org chain) covers:
   - member, connection and party lifecycle;
   - token issue and rotation;
   - capture on/off;
   - agreement transitions;
   - CDR release/void;
   - dispute transitions;
   - run finalise;
   - payment record/confirm;
   - fee plan change.
8. **RLS** as in §3.1. A new policy lint runs in `assertRlsPosture` (pool.ts): hub tables must use the 048 shape.
9. **Data protection:** token uids are hashed in the ledger columns and masked in logs; CDR bodies (which contain
   uid and contract_id) are visible only to the two parties and platform admins. Retention is as in §3.3.
   **[LEGAL]** cross-border transfer of CDR data under UU PDP (ID) and PDPA (MY/SG). Hub contracts should carry a
   data processing clause.

---

## 11. Testing

### 11.1 Unit (no DB, `node:test`, next to sources)

| File | Covers |
|---|---|
| `src/hub/router.test.ts` | `classify` for every row of §5.3; from/URL ownership mismatches; to = hub vs party vs none; role-fit table |
| `src/hub/rewrite.test.ts` | Link rewrite + cursor seal/unseal/binding/expiry; response_url rewrite in body and query; Location rewrite |
| `src/hub/index.test.ts` | `resolveOpen` with ambiguity, agreement filtering, expiry |
| `src/hub/outbox.test.ts` | coalescing (PUT supersedes unsent PUT/PATCH), ordering per object, OFFLINE drop, callback retry window |
| `src/hub/clientinfo.test.ts` | visibility matrix (agreement, open_roaming, own parties excluded) |
| `src/hub/clearing/intake.test.ts` | every hard and soft flag; credit CDR pairing; minor-unit rounding (IDR 0 dp, MYR/SGD 2 dp, 4-dp inputs) |
| `src/hub/clearing/fees.test.ts` | plan precedence, clamp, credit reversal |
| `src/hub/clearing/settlement.test.ts` | netting (A↔B, both directions, zero net, three members), carried items, immutability |
| `src/ocpi/trust.test.ts` | the H0 cases |

### 11.2 DB tests (existing pattern, `*.db.test.ts` with the test database)

- registry race (two POSTs with token A);
- `joinInternal` transaction;
- RLS: tenant A cannot see B's hub_cdr / positions / statements; an external `hub_only` org sees only its rows;
  `hub_connection` is invisible inside any org scope.

### 11.3 E2E — `tools/e2e/hub-e2e.mts` (`npm run e2e:hub`; added to CI)

**Setup**
- Start the API and workers with `HUB_ENABLED=true`, `HUB_PUBLIC_URL=http://127.0.0.1:<port>` and relaxed env.
- Two fakes are in-process HTTP servers. The **fake external CPO "MY*XCP"** is reused from the `ocpi-emsp-e2e` mock
  CPO and parameterised. The **fake external eMSP "SG*XEM"** is reused from the `ocpi-e2e` mock eMSP.
- Shared helpers move to `tools/e2e/lib/ocpi-fakes.mts`; the existing suites import them (H3 does the move, so the
  e2e owner is single). Each fake records every request (headers + body) and can answer with programmable delays
  and errors.
- **Internal tenant "ID*PLT"**: CPO + eMSP, a simulated charger (`tools/simulator`), one published ID site, one
  shared RFID card.

**Steps (each asserts the spec headers on every leg: from/to, a new X-Request-ID, the same X-Correlation-ID)**

| # | Step | Asserts |
|---|---|---|
| 1 | Onboard: platform creates XCP (hub issues token A; the fake POSTs credentials) and XEM (hub-initiated connect with the fake's token A); `join-tenant` for PLT | tokens; the hub's credentials list only HUB roles; hub_party rows; PLANNED before activation |
| 2 | Agreements: XCP↔XEM, XCP↔PLT(eMSP), PLT(CPO)↔XEM; **none** between PLT(CPO)↔PLT(eMSP) (same member) | ClientInfo PUTs to each fake only for agreed parties; tenant `ocpi_hub_client` rows |
| 3 | Location broadcast: XCP PUTs a location with to = hub | 1000 at once; XEM's fake and PLT's `ocpi_remote_location` receive it with from = hub, URL cc/pid = MY/XCP, `last_updated` unchanged; an EVSE PATCH follows in order |
| 4 | Tenant location broadcast: PLT site published → push.ts → hub | XEM receives it; XCP (a CPO) does **not** |
| 5 | eMSP pull via hub: XEM GET `sender/locations` with to = hub, limit 1 | Link rewritten to `hub_cursor`; walking all pages yields XCP + PLT locations; X-Total-Count = sum; a cursor replayed with PLT's token → 401/403 |
| 6 | Tokens: XEM broadcasts a token `whitelist=NEVER` | it reaches XCP and PLT; PLT's charger presents it → PLT real-time authorize → hub (open routing by token index) → XEM fake answers ALLOWED with an authorization_reference; the charger starts |
| 7 | Remote start: PLT's eMSP (app driver hold path, or console command) START_SESSION at an XCP location, with to omitted (open routing by location index) | XCP fake receives response_url = hub callback; it posts the result; PLT's `ocpi_command.result = ACCEPTED`; a second POST of the same callback → 1000 and not forwarded |
| 8 | Session + CDR routed: XCP PUTs a session (no to; routed by cdr_token to PLT), PATCHes it, POSTs the CDR | PLT `ocpi_remote_session/cdr` hold the data; XCP receives a hub Location; XCP GET on that Location returns the CDR; **hub_cdr** row pending with no flags (authorization seen in step 7) |
| 9 | Reverse direction: an XEM driver on PLT's charger (step 6) → PLT pushes session + CDR (to = XEM) | XEM fake receives them; hub_cdr row (cpo = PLT, emsp = XEM) |
| 10 | Dispute: XEM disputes the PLT CDR (`amount`); PLT accepts → PLT sends a credit CDR + a new CDR (console action on the tenant side; phase-1 manual: PLT re-issues via the existing replay path) | dispute resolves `credited`; the original is credited; the new CDR is pending |
| 11 | Settlement: the clock is advanced by `HUB_TEST_NOW` (a test-only override honoured when `NODE_ENV=test`); `autoAccept`; `buildRun` + `finaliseRun` per currency | positions: IDR run PLT↔XEM nets, with XEM paying PLT the new CDR amount; MYR run XCP↔PLT (PLT owes XCP); fees per plan (the test sets cpo_bps=300, emsp_fixed=100); statements per member (PDF opens, CSV rows = CDRs); fee invoices with tax per entity |
| 12 | Payments: XEM records a payment, PLT confirms | position `confirmed` |
| 13 | Isolation attacks | (a) XEM sends with from = XCP → 4903; (b) XEM addresses PLT(CPO) for commands without `allow_commands` → 4901; (c) a party with no agreement (new external eMSP "SG*NOA") GA on locations → empty, and broadcast never reaches it; (d) NOA GET `sender/sessions` direct to XCP → 4901; (e) XCP pushes a location under URL cc/pid of PLT → 2001; (f) callback id used by a party that is not the target → 403; (g) H0: via the hub, XEM GETs PLT's sessions → only XEM's; STOP_SESSION of XCP-eMSP's session by XEM → UNKNOWN_SESSION; (h) unknown to → 4001; suspended XEM → 4003 for synchronous calls and broadcast rows dropped; (i) rate limit → 4905 |
| 14 | Liveness | stop the XEM fake → 2 alive failures → OFFLINE, ClientInfo pushed to XCP and PLT; restart → CONNECTED |
| 15 | Peer regression | the existing `ocpi-e2e`, `ocpi-emsp-e2e`, `ocpi-auth-e2e` and `ocpi-profiles-e2e` pass unchanged with `HUB_ENABLED=true` and `false` |

---

## 12. Rollout

1. **Flag.**
   - `HUB_ENABLED` (default `false`). While false, `/hub/ocpi` is not mounted, hub workers do not start, and the hub
     console menus are hidden.
   - Related settings: `HUB_PUBLIC_URL`, `HUB_SELF_JOIN`, `HUB_AGREEMENT_PLATFORM_APPROVAL`, `HUB_DISPUTE_DAYS`,
     `HUB_PAYMENT_TERMS_DAYS`, `HUB_FORWARD_TIMEOUT_MS`, `HUB_REALTIME_TIMEOUT_MS`, `HUB_CALLBACK_TTL_S`,
     `HUB_ALIVE_AFTER_MIN`, `HUB_TOKEN_GRACE_MIN`, `HUB_CYCLE` and `HUB_DEFAULT_ENTITY`. All go in `config.ts` as
     `config.hub.*` with tests in `config.test.ts`.
2. **Migrations 072 and 073 are additive.** They only create tables and add one nullable-default column on
   `organisation`; no rewrite, no lock on hot tables. They are safe to run on the live pilot with no maintenance
   window. Rollback = `db/rollback/073_down.sql` and `072_down.sql`, which drop the hub tables and refuse if
   `hub_cdr` has rows.
3. **Zero effect on peers.**
   - `/ocpi/*` code paths are changed only by H0, which tightens scoping for `kind='hub'` partners and changes
     nothing for `emsp`, `cpo` or `authority` partners. Regression is covered by the four existing OCPI e2e suites.
   - The in-process transport in `ocpiCall` applies only to URLs under our own public origins; existing partners are
     external URLs.
4. **Order.**
   1. Ship H0 as v1.7.1 to the pilot.
   2. Deploy `hub` with the flag off.
   3. Staging run of `hub-e2e`.
   4. Enable on staging with two friendly external parties (sandbox).
   5. Enable in production with internal tenants only (`join-tenant` for the pilot operator, which is a no-op
      until agreements exist).
   6. Onboard the first external members.
   7. First settlement run in parallel with manual reconciliation for 2 cycles before statements go out.
5. **Public hostname:** `hub.plugsure.<tld>` with TLS. The same ingress routes `/hub/ocpi/*` to the API. Register
   the hub party ids **[OWNER]**.

---

## 13. Work packages

Sequencing:
- **H0** first (small; 2–3 days).
- **H1** starts at once on the schema.
- **H2** starts when 072 (and the `tapCdr` interface + `hub_party`/`hub_member` types in `src/hub/types.ts`) are
  merged on `hub`.
- **H3** starts in parallel with H1 on docs and fakes, and builds UI against routes as they land.

Each WP: its own branch off `hub` and PR into `hub`. Every PR runs `npm test`, the existing 15 e2e suites and
(from H1 M3) `e2e:hub`.

### H0 — tenant isolation behind hubs (H1's engineer)

**Files:** `src/ocpi/server.ts`, `store.ts`, `commands.ts`, `profiles.ts`, `emsp.ts`, `trust.test.ts`.

**Acceptance**
- With `partner.kind==='hub'`, the from party is required and checked with `partnerActsFor`.
- Sessions, CDR lists, token GET/PATCH, STOP_SESSION, chargingprofiles, remote session/CDR writes and command
  results are scoped to from.
- New trust tests (≥ 8) pass.
- Non-hub partners: byte-identical behaviour (existing tests unchanged).

### H1 — routing core

**Owns:**
- `db/migrations/072_hub_core.sql`, `db/rollback/072_down.sql`;
- `src/hub/{types,server,registry,credentials,router,rewrite,index,agreements,outbox,clientinfo,transport,log,errors,ledger-tap(stub)}.ts`
  and their tests;
- `src/api/hub-routes.ts` (non-clearing routes);
- `src/config.ts` (`hub` block);
- `src/services/workers.ts` (hub-outbox, hub-alive, hub-clientinfo-resync, hub-prune entries);
- the `ocpi/client.ts` refactor (`requestOcpi` + in-process transport);
- `ocpi/push.ts` (export `BACKOFF_S`/`MAX_ATTEMPTS` only);
- `src/api/server.ts` (mount line);
- a `roaming-routes.ts` hook for `syncInternalParties` (one line).

**Milestones**
- **M1:** schema + registry + credentials both directions + internal join + ClientInfo SENDER. Tests: handshake
  unit and DB tests.
- **M2:** router: direct, open, broadcast with outbox, GA with cursors, rewrites, index, agreements, errors, log,
  rate limits.
- **M3:** alive checks, health metrics, alerts, `hub-e2e` steps 1–9, 13 and 14 green (with the H2 tap stub).

**Acceptance**
- Every routing-table row in §5.3 has a unit test.
- The spec header table (§1.1) is asserted on every e2e leg.
- 4001, 4002, 4003, 4901–4905 are produced as specified.
- Broadcast never reaches an unagreed party.
- Internal routing performs no network I/O (assert via the `hub_message` route suffix `+inproc` and no sockets
  opened to its own port).
- p95 added hub latency (in-process legs) < 30 ms on the e2e machine.
- `HUB_ENABLED=false` → no `/hub` routes and no hub workers; existing suites green.

### H1 as built (branch `hub`, v1.8.0-dev)

**Status: done.** `HUB_ENABLED=false` (the default) mounts nothing under `/hub`, starts no hub worker and never
uses the in-process transport; `/v1/hub/*` answers 404. Everything below is additive.

**Files.** `db/migrations/072_hub_core.sql`, `db/rollback/072_down.sql`; `src/hub/{types,errors,transport,call,
registry,credentials,agreements,route-index,router,rewrite,outbox,clientinfo,lifecycle,log,ledger-tap,server}.ts`;
`src/api/hub-routes.ts` (+ `catalogue/hub.ts`); `src/config.ts` (`config.hub`); `src/services/workers.ts`;
`src/ocpi/client.ts` (`requestOcpi`); `tools/e2e/hub-e2e.mts`, `tools/e2e/lib/ocpi-fakes.mts`.

**Configuration.** `HUB_ENABLED`, `HUB_PUBLIC_URL` (default `OCPI_PUBLIC_URL`), `HUB_PARTIES` (default
`ID*PSH,MY*PSH,SG*PSH`, refused at start-up when malformed), `HUB_BUSINESS_NAME`, `HUB_WEBSITE`, `HUB_SELF_JOIN`,
`HUB_AGREEMENT_PLATFORM_APPROVAL`, `HUB_FORWARD_TIMEOUT_MS` (10 000), `HUB_REALTIME_TIMEOUT_MS` (4 000),
`HUB_CALLBACK_TTL_S` (900), `HUB_ALIVE_AFTER_MIN` (5), `HUB_TOKEN_GRACE_MIN` (60). H2 adds its own.

**Deviations from the design, with reasons**

| # | Design | As built | Why |
|---|---|---|---|
| 1 | 072 and 073 | H1 ships **072 only**; 073 stays H2's clearing migration | 073 is clearing (§3.3); nothing in H1 needs it |
| 2 | `hub_outbox.body`, `hub_callback.body` JSONB | **JSON** | JSONB reorders keys; a forwarded body must be the body received (the e2e compares byte-for-byte) |
| 3 | `hub_callback` without a body | `body JSON` added (kind `cdr_location`) + index on (target, kind, ref) | H1 has no `hub_cdr`: the hub serves the CDR itself when the eMSP gave no `Location`, and detects a duplicate CDR POST (same CPO party + id: 1000 with the same Location, not forwarded; different totals: 2001) from it |
| 4 | Broadcast legs `from` = the hub | as designed, **and** the tenant side (`ocpi/server.ts`, `hubBroadcastActor`) accepts it | H0 required from = the object's owner, so a spec-faithful hub broadcast was refused by our own tenants. Now: a hub partner speaking as one of its own HUB parties, on a PUT/PATCH/DELETE of `emsp/locations`, `emsp/tariffs` or `tokens`, acts for the owner in the URL, which must still be a party the hub announced (ClientInfo) in that role. Peers unchanged |
| 5 | `to` = hub on a non-broadcast module → 4902 | **open routing** (logged `open`); GET of one object with `to` = hub → 2001 | A PlugSure tenant addresses the hub when it does not know the party (`sendCommand` without `locationParty`). 4902 is defined but not produced |
| 6 | `tapCdr` stub inserting a minimal row | `onCdrRouted(event, forward)` (+ optional `admit`) in `ledger-tap.ts`, no-op by default; `setCdrLedger()` for H2 | The ledger table is H2's (073); the contract is below |
| 7 | Rate limits in the shared buckets (`takeKeyToken`) | per-process `TokenBuckets` keyed `hub:`/`hubrt:` + connection id | `api_key_rate_take()` takes API-key UUIDs. With N API processes a member gets up to N× its limit. **[H2/ops]** add a text-keyed shared bucket if that matters |
| 8 | Cursor bound to the connection | bound to the connection **and** the requesting party; carries the GA total | Two parties on one connection must not read each other's pages |
| 9 | `hub_self_party` edited by `/v1/hub/self-parties` | read-only route; the table is **mirrored from `HUB_PARTIES`** at start-up | The brief: party ids from config. A PUT can come with H3 if the owner wants them editable |
| 10 | External member URLs: SSRF guard | plus: a member URL on one of our own origins is refused | It would loop through the in-process transport |
| 11 | PUT /credentials by the member | its old token dies **at once** (spec); only a platform-forced rotation keeps the old token for `HUB_TOKEN_GRACE_MIN` | Spec behaviour; rotation is the only case where the member cannot switch atomically |
| 12 | Alert `hub.connection_offline` after 15 min | raised when the parties go OFFLINE (two failed alive checks ≈ 10 min idle + 2 checks) | Simpler; same intent |
| 13 | Alerts `hub.forward_error_rate`, `hub.response_filtered` | not raised; `/v1/hub/health` exposes the numbers and the filter logs `hub.response_filtered` | **[H3]** alert routing on top of the health numbers |
| 14 | Platform routes per §9.1 | all of the H1 ones, plus `POST /v1/hub/members/leave-tenant`, `POST /v1/hub/connections/:id/alive-check`, `PATCH /v1/hub/connections/:id` (rate limits), `GET /v1/hub/self-parties`; tenant `GET /v1/roaming/hub`, `POST /v1/roaming/hub/join` (in `hub-routes.ts`, not `roaming-routes.ts`). `/v1/hub/*` is always registered (OpenAPI coverage) and answers 404 while off | Support and e2e need a forced alive check; the tenant routes avoid touching `roaming-routes.ts` beyond the party hook |
| 15 | Agreement workflow (propose/accept, platform approval) | the platform creates agreements **active** (or `activate:false` → proposed, then `approve`); suspend/resume/end; module flags. `HUB_AGREEMENT_PLATFORM_APPROVAL` is read by nobody yet | Tenant/member proposals are H3's console |
| 16 | In-process calls and the per-IP API limit (not in the design) | an injected call carries a per-process secret header and is exempt from the per-IP limit | Otherwise all hub ⇄ tenant traffic counted against 127.0.0.1 |
| 17 | Pending ClientInfo before data (not in the design) | a recipient's pending ClientInfo rows are claimed before its other rows (while fewer than 2 attempts); the welcome sync after an agreement first delivers the outbox | A tenant refuses a party's data until ClientInfo announced the party |
| 18 | e2e fakes moved into `lib/ocpi-fakes.mts` by H3 | a new generic fake (`FakeParty`) used by `hub-e2e`; the existing suites keep their own | H3 owns refactoring the existing suites |

**What the router does (as built).** Pipeline per §5.2: token → connection (current token, or the previous one
during a forced rotation's grace) → 401; pending → versions/credentials only; suspended connection or member → 403;
rate limit → 429/4905; from-party (`pickFrom`: a party of this connection, role fit for the interface, CONNECTED or
OFFLINE; inferred only when exactly one fits) → 403/4903; URL and body ownership → 400/2001; `to` → direct /
broadcast / GET All / open; agreement (`mayRoute` with module flags) → 403/4901 or 400/2001; receiver reachable
(SUSPENDED, PLANNED, OFFLINE, no endpoint → 200/4003); forward (new X-Request-ID, same X-Correlation-ID, body
untouched except `response_url`; timeout → 200/4002, connection error → 200/4003); relay (receiver's HTTP status
and envelope; `OCPI-from` = receiver, `OCPI-to` = requester; `X-Total-Count`/`X-Limit` passed; `Link` → hub
cursor, `Location` → hub URL). Open routing per §5.3: sessions by `cdr_token` (PUT) or the session index (PATCH),
CDRs by `cdr_token`, commands by the location / session / reservation index, real-time authorize by the token index,
GET of one location by the location index, ActiveChargingProfile by the profile setter. Index lookups are filtered by
agreement and module flag before the ambiguity check (4904). Broadcast (locations, tariffs incl. DELETE, tokens):
1000 at once, one outbox row per agreed CONNECTED recipient with the module's RECEIVER endpoint (fan-out cap 1 000,
backlog cap 10 000), coalesced, ordered per object, dropped for OFFLINE/SUSPENDED recipients, EVSE PATCH → 2003 →
full location re-fetched from its CPO and PUT. GET All: agreed sources probed in parallel for `X-Total-Count`, one
upstream page per hub page, agreement re-checked on every page, the source's own `Link` followed only on its
endpoint's origin. Sessions/CDRs in pulls are filtered to the requester's tokens. Callbacks: command results
(`max_uses` 1; a repeat is 1000 and not forwarded), charging-profile results, CDR Location (bound to the CPO party).
Commands are de-duplicated per connection by X-Request-ID for 10 min (in memory).

**ClientInfo and liveness.** Visibility = agreed (or mutually open) counterparties of the opposite role, never
the member's own other parties, never PLANNED. Pushed through the outbox on registration, activation, suspension,
closing, agreement activation (both sides) and end (SUSPENDED); full resync every 6 h; `GET hubclientinfo` paged.
Alive checks every minute for connections idle `HUB_ALIVE_AFTER_MIN`: two failures → parties OFFLINE (pushed);
any inbound message or answer → CONNECTED.

**The ledger hook (contract for H2)** — `src/hub/ledger-tap.ts`:

```ts
setCdrLedger({ admit?(e: CdrRoutedEvent): Promise<string | null>,           // push only, BEFORE forwarding; a message → 2001, not forwarded
               onCdrRouted(e: CdrRoutedEvent, forward: ForwardOutcome | null): Promise<void> })
CdrRoutedEvent = { source: 'push' | 'pull', cpo: CdrPartyRef, emsp: CdrPartyRef,  // CdrPartyRef = { id (hub_party), country_code, party_id, role, member_id, org_id }
  agreement_id: string | null,            // the active agreement at routing time; null under mutual open roaming
  cdr_id, session_id, credit, credit_reference_id, currency,
  totals: { cost_excl_vat, cost_incl_vat, energy_kwh, time_hours, parking_time_hours },   // numbers as received (4 dp), null when absent
  start_date_time, end_date_time, last_updated, cdr /* raw, exactly as routed */,
  routing: { correlation_id, request_id_in, request_id_out, route: 'direct'|'open'|'get_all', from_connection_id, to_connection_id,
             hub_location /* the hub URL handed to the CPO (push) */ }, at }
ForwardOutcome = { delivered, http_status, ocpi_status, error, emsp_location }        // null for pulls
```

Called outside any request transaction; failures are logged and never change the answer (a throwing `admit`
forwards anyway). Push: once per CDR POST routed (a duplicate already delivered is answered from the hub's state and
not reported again). Pull: once per CDR in each page an eMSP receives (after the response filter) — the same CDR
pulled twice is reported twice, so H2 inserts `ON CONFLICT (cpo_party_id, cdr_id) DO NOTHING`. The hub never alters
a CDR.

**Platform-admin API for H3** (all `platform:admin`, unscoped, audited `hub.*` on the platform chain and, for one
member, on its own chain; tokens never returned except token A once):
`GET /v1/hub/overview`, `GET /v1/hub/self-parties`; `GET|POST /v1/hub/members`, `GET|PATCH /v1/hub/members/:id`
(`action`: activate/suspend/resume/terminate; `open_roaming`; details), `POST /v1/hub/members/join-tenant|leave-tenant`,
`POST /v1/hub/members/:id/connections` (token A + versions URL); `GET /v1/hub/connections[/:id]`,
`PATCH /v1/hub/connections/:id` (limits), `POST /v1/hub/connections/:id/{connect,suspend,resume,rotate,close,
alive-check,capture,parties}`; `GET /v1/hub/parties`, `PATCH /v1/hub/parties/:id` (suspend/resume);
`GET|POST /v1/hub/agreements`, `PATCH /v1/hub/agreements/:id` (approve/suspend/resume/end, flags);
`GET /v1/hub/messages` (filters: connection, correlation, route, party, status, from, to, before, limit),
`GET /v1/hub/messages/trace/:correlationId`; `GET /v1/hub/outbox`, `POST /v1/hub/outbox/replay`; `GET /v1/hub/health`.
Tenant: `GET /v1/roaming/hub`, `POST /v1/roaming/hub/join` (`HUB_SELF_JOIN`).

**Migration rehearsal.** A copy of the pilot rehearsal data (79 sessions, 15 organisations) brought to v1.7.1 (071)
with the v1.7.1 code, then 072 applied by the migrator: **70 ms** (33 statements, 63 ms of statement time in one
transaction). The only change to an existing table is `organisation.hub_only` (constant default: no rewrite; a
brief ACCESS EXCLUSIVE lock, bounded by `MIGRATION_LOCK_TIMEOUT`). `072_down.sql` then removes every hub table and
the column and the migrator re-applies 072 cleanly.

**Tests.** Unit (no DB): `src/hub/router.test.ts` (every routing-table row, from-party check, headers, response
filter), `rewrite.test.ts`, `outbox.test.ts`, `log.test.ts` (redaction, ledger event, `HUB_PARTIES`),
`src/ocpi/hub-broadcast.test.ts`, `disabled.test.ts`. DB: `src/hub/hub.db.test.ts` (join, party-key rule,
registration race, agreements incl. validity window and open roaming, index ambiguity and agreement filtering,
ClientInfo visibility, outbox coalescing and ordering, RLS as `plugsure_app`, the HTTP surface in-process with
4001/4002/4003/4901/4903/4905). E2E: `tools/e2e/hub-e2e.mts` (in CI with `HUB_ENABLED=true` for the whole e2e
job): steps 1–9, 13 (a–i, minus the STOP_SESSION half of g, covered by `hub-isolation.test.ts`) and 14 of §11.3,
plus token rotation and the member's own credentials update. Steps 10–12 are H2's.

Results on the `hub` branch: unit suite **1303/1303** (1224 before H1; +79: router 23, rewrite 13, outbox 10,
log/ledger/config 7, hub DB 19, disabled 3, tenant broadcast actor 4). `hub-e2e` **87/87**, twice on one database
(re-runnable). The CI e2e job's 15 suites with `HUB_ENABLED=true` all green; `ocpi`, `ocpi-emsp`, `ocpi-auth`,
`ocpi-profiles` green with the hub on **and** off; with it off `/hub/ocpi/*` and `/v1/hub/*` answer 404.

**Open points.** [VERIFY 14.3-1] HTTP 200 for 4001–4003 (as designed). Deviation 7 (per-process rate buckets).
Deviation 13 (two alerts). H2 must call `setCdrLedger()` and own 073. H3: tenant/member agreement proposals,
console, onboarding guide, moving the old suites' fakes to `lib/ocpi-fakes.mts`.

### H2 — clearing and settlement (starts after 072 is merged)

**Owns:** `db/migrations/073_hub_clearing.sql`, `db/rollback/073_down.sql`, `src/hub/clearing/*`,
`src/api/hub-clearing-routes.ts`, the `/v1/roaming/hub/{cdrs,disputes,statements,positions,payments,fee-invoices,bank-details}`
routes (in a new file `src/api/roaming-hub-routes.ts`, to avoid a `roaming-routes.ts` conflict with H1), the
hub-cdr-accept / hub-cdr-pull / hub-dispute-escalate / hub-settlement-draft workers, statement and fee invoice PDFs,
and the real `tapCdr`.

**Acceptance**
- Every CDR forwarded or pulled through the hub has exactly one `hub_cdr` row (e2e count check).
- Every hard and soft flag has a unit test.
- Credit pairing works.
- `autoAccept` respects disputes.
- Fee computation matches §8.4, including credit reversal.
- A run is idempotent while draft and immutable once finalised.
- Netting matches hand-computed fixtures for 3 members × 2 currencies.
- PDFs render (`pdf.test.ts` pattern) in ID, MY and SG formats with the correct entity, tax lines and PPh 23 note
  (ID).
- RLS DB tests pass.
- `hub-e2e` steps 8–12 green.

### H2 as built (branch `hub`, v1.8.0-dev)

**Status: done.** With `HUB_ENABLED=false` nothing changes: the ledger is registered only by `registerHubApi`, no
clearing worker starts, and `/v1/hub/clearing/*` and `/v1/roaming/hub/clearing/*` answer 404 (H1's hook). Migration 073
is additive.

**Files.** `db/migrations/073_hub_clearing.sql`, `db/rollback/073_down.sql`; `src/hub/clearing/{index,intake,accept,fees,
disputes,netting,period,settlement,invoices,documents,queries,notify}.ts` (+ tests); `src/api/hub-clearing-routes.ts`
(platform), `src/api/roaming-hub-routes.ts` (member), `src/api/openapi/catalogue/hub-clearing.ts`; one line each in
`src/hub/server.ts` (ledger registration), `src/api/server.ts` (route mounts), `src/services/workers.ts`,
`src/config.ts`; `tools/e2e/hub-clearing-e2e.mts` (`npm run e2e:hub-clearing`, in CI after `e2e:hub`), one ledger
check added to `hub-e2e.mts`.

**Configuration** (`config.hub`, refused at start-up when out of range) — all **[OWNER]** defaults:
`HUB_DISPUTE_DAYS` (14; an agreement may set its own `dispute_days`), `HUB_DISPUTE_RESPONSE_DAYS` (10, CPO answer),
`HUB_DISPUTE_ESCALATE_DAYS` (5, eMSP may escalate a rejection), `HUB_CREDIT_DUE_DAYS` (10, credit CDR after an
accepted dispute), `HUB_PAYMENT_TERMS_DAYS` (14), `HUB_CYCLE` (`monthly` | `weekly`), `HUB_DEFAULT_ENTITY` (`SG`,
cross-border invoicing), `HUB_LATE_CDR_DAYS` (60).

#### Tables (073)

| Table | What | RLS |
|---|---|---|
| `hub_cdr` | the ledger: one row per (CPO party, CDR id), as designed (§3.3) plus `routing` (correlation/request ids, route, connections, hub Location), `hold_note`, per-side `fee_*_plan_id`; `source` push / pull; status `held / pending / disputed / accepted / credited / written_off / void` | two-sided (`cpo_org_id`, `emsp_org_id`) |
| `hub_dispute`, `hub_dispute_note` | disputes and their evidence/history (one note per transition, plus free notes) | two-sided |
| `hub_fee_plan`, `hub_fee_assignment` | commission plans per currency (CPO part, eMSP part); per-currency overrides per agreement or per member | platform only |
| `hub_settlement_run` | one live run per (currency, cycle, period); `preview` (draft) / `totals` (finalised) | platform only |
| `hub_settlement_position` | bilateral net per member pair and run; `paid_minor`, status, due date, reminders | `org_a_id` / `org_b_id` |
| `hub_statement` | one per member and run; frozen `data` (counterparties, CDRs, carried items, fee invoice) | `org_id` |
| `hub_fee_invoice` | commission invoice per member and run (non-zero commission); tax, PPh 23 expected, frozen `data` | `org_id` |
| `hub_payment` | transfers recorded on a position (partial allowed) | payer / payee org |
| `hub_doc_seq` | gapless numbering (statements per year; fee invoices per entity and year) | platform only |
| additions | `hub_agreement.dispute_days`; `hub_member.bank_details` (sealed); `hub_entity.placeholder`, seeded **placeholder** rows for ID/MY/SG; three zero **placeholder** default plans (`TODO(commercial)`) | — |

Amounts are integers in minor units of the row's currency (IDR rupiah, MYR sen, SGD cents; `domain/money` `toMinor`,
half-up on the first dropped digit, the 4-dp value kept in `total_*_raw`). Currencies never mix.

#### Intake (`intake.ts`, wired with `setCdrLedger` in `registerHubApi`)

- `admit` (push, before forwarding) refuses with 2001: malformed (id, ISO currency, `total_cost.excl_vat`,
  `total_energy`, dates, `cdr_token.uid`, `cdr_location`, a credit's `credit_reference_id`, negative non-credit
  totals); **self-roaming** (CPO and eMSP of the same member); an id the ledger holds with **different content**
  (unless the earlier push never reached the eMSP).
- `onCdrRouted` → `tapCdr`: under an advisory lock per (CPO party, id), insert once; a repeat (push retry, any number of
  pulls) only updates the delivery state. Different content seen in a pull: the first version stays, flag
  `cdr_duplicate_conflict` + alert.
- **Hard flags → `held`** (alert `hub.cdr_held`; still forwarded): `no_agreement` (agreement not valid at `start_at`;
  or no mutual open roaming), `unsupported_currency`, `currency_country_mismatch` (location country's currency),
  `implausible` (WP2 `cdrPlausibilityProblem`: per-currency price cap, 500 kWh, incl ≥ excl, ≤ 7 days),
  `credit_unknown_reference`, `credit_amount_mismatch`, `credit_already_applied`, `credit_original_not_payable`,
  `cdr_duplicate_conflict`, `not_delivered` (push failed: cleared when a retry or a pull reaches the eMSP).
- **Soft flags** (pending): `no_session_seen`, `no_authorization_seen`, `whitelist_token_unknown`, `late_cdr`,
  `overlap`, `duplicate_session`, `no_incl_vat`.
- **Credit CDRs** are stored negative whatever sign they carry. An exact credit of a payable original is `accepted` at
  once: the original becomes `credited` (its fees frozen if they were not), the credit's fees are the exact reversal, a
  live dispute on the original resolves `credited`. Both settle in the next run that takes them (net zero together, or
  an offset after the original was settled). A held credit released by the platform pairs as a partial credit (fees
  reversed pro rata).
- `dispute_deadline` = received + the agreement's `dispute_days` (else `HUB_DISPUTE_DAYS`). `autoAccept` (worker every
  15 min, or `POST /v1/hub/clearing/accept-due`) accepts pending CDRs past it and **freezes the fees**.

#### Commission (`fees.ts`) — TODO(commercial): every default is 0

`fee = clamp(round_half_up(excl_minor × bps / 10 000) + fixed, min, max)` per side (CPO part paid by the CPO, eMSP
part by the eMSP), on the excl.-tax total. Plan per side: the agreement's plan for the currency, else that side's
member plan, else the currency default effective at `start_at`. Fees are per member, **not netted**, invoiced
separately.

#### Dispute state machine (`disputes.ts`)

```
open ──accept (CPO)──► accepted ──credit CDR arrives──► credited                    (final)
  │                       └──no credit by credit_due_by (+10 d)──► escalated
  ├──reject (CPO, note required)──► rejected ──escalate (eMSP, by escalate_by +5 d)──► escalated
  │                                     └──escalate_by passes──► expired (CDR accepted)  (final)
  ├──no answer by respond_by (+10 d)──► escalated
  └──withdraw (eMSP)──► withdrawn (final; CDR pending again, or accepted if its window passed)
escalated ──resolve (platform): upheld → resolved (CDR accepted) | written_off → resolved (CDR written off)
                                | credit_required → accepted (the CPO must send the credit CDR)
```
Only the eMSP (or the platform) raises, only on a `pending` CDR within its window; reasons `unknown_token,
not_authorized, duplicate, amount, energy, tariff_mismatch, session_not_found, other`; optional `claimed_minor`.
Every transition writes a `hub_dispute_note` and an audit entry (`hub.dispute_*`) on the platform chain and both
members' chains, and alerts the other side (`hub.dispute_opened` / `hub.dispute_updated`; `hub.dispute_escalated`
to the platform). Worker `hub-dispute-escalate` (hourly) applies the deadlines.

#### Settlement (`settlement.ts`, `netting.ts`, `period.ts`)

- **Periods** per currency in its country's zone (IDR `Asia/Jakarta`, MYR `Asia/Kuala_Lumpur`, SGD `Asia/Singapore`):
  monthly `2026-10` = [1 Oct 00:00, 1 Nov 00:00) local; weekly `2026-10-05` (a Monday). A run takes the currency's
  `accepted` and `credited` CDRs, unsettled, **received** before `period_end`; pending / disputed / held ones are
  "carried" (listed on the statements).
- **Run**: `POST runs` creates the draft or refreshes it (idempotent, nothing stamped); `preview` recomputes; `finalise`
  is refused before `period_end`, and before `finalisable_at` (= period end + dispute days + 1) unless `force`; it stamps
  the CDRs and writes positions, statements and fee invoices in one transaction; finalising again returns the run
  unchanged (`alreadyFinalised: true`). A draft can be voided; a finalised run is immutable (corrections = credit CDRs).
  Worker `hub-settlement-draft` (6 h) keeps the previous period's draft of each currency fresh and alerts
  `hub.settlement_ready` once it can be finalised; finalising stays a human action.
- **Netting** (pure, `netting.ts`): per member pair, Σ incl.-tax totals (excl. when absent) each way; net, payer,
  payee; per member receivable (as CPO), payable (as eMSP), net = receivable − payable = Σ signed bilateral nets
  (asserted); fees per member.
- **Statements** `PSH-ST-{YYYY}-{CUR}-{000001}`; HTML / PDF / CSV rendered from the frozen data (same styles and PdfDoc
  machinery as commission statements and fleet invoices). Not a tax invoice. A payer's statement prints the payee's
  bank details (`PUT /v1/roaming/hub/clearing/bank-details`).
- **Fee invoices** `{entity prefix}{YYYY}-{000001}` from the entity of the member's country (`HUB_DEFAULT_ENTITY` with
  `REVERSE_CHARGE`, no tax, when none): `platformTaxContext` + `engineFor(...).computeFee`: ID PPN 12 % × DPP 11/12
  when PKP and PPh 23 2 % expected from Indonesian members; SG GST when registered; MY service tax when registered
  [VERIFY]; NONE otherwise. Placeholder issuers, cross-border and foreign-currency tax reporting are flagged on the
  document. A negative commission (credits) yields a credit note.
- **Payments**: payer, payee (counts as confirmed) or platform record `amount_minor`, `paid_at`, `reference`,
  `method`; partial payments add up; more than the outstanding balance is refused; the payee confirms. Position status
  `open → partially_paid → paid → confirmed`, `overdue` past the due date (worker `hub-payment-overdue`, hourly:
  alerts `hub.payment_overdue` to the payer and the platform on days 1, 7 and 14 — one catch-up reminder if the
  worker missed days), `nothing_due` when net is 0, `written_off` by the platform. Fee invoices: the platform marks
  them paid; overdue ones alert `hub.fee_invoice_overdue`.

#### API for H3

All JSON; amounts integers in minor units next to `currency`; DATE fields `YYYY-MM-DD`; errors `{ "error": "…" }`
with 400 (validation), 403 (wrong side / permission), 404 (not found or not yours), 409 (state). Lists return at most
500 rows; the ledger is keyset-paged (`next_cursor`). OpenAPI: `src/api/openapi/catalogue/hub-clearing.ts` (internal
until H3 publishes).

Platform (`platform:admin`, unscoped, audited) — `/v1/hub/clearing/…`:

| Route | Purpose |
|---|---|
| `GET overview` | ledger by currency/status, held flags, disputes, runs, outstanding positions, fee invoices |
| `GET cdrs` `?status=a,b&flag=&currency=&cpo_member=&emsp_member=&member=&agreement=&run=&unsettled=true&from=&to=&q=&cursor=&limit=` · `GET cdrs.csv` · `GET cdrs/:id` (body, routing, disputes, credit links) | ledger |
| `POST cdrs/:id/release {note}` · `POST cdrs/:id/void {note}` · `POST cdrs/:id/dispute {reason,message,claimed_minor?}` · `POST accept-due` | held queue, platform dispute, run the acceptance now |
| `GET disputes ?status=&member=&cdr=` · `GET disputes/:id` (+ notes) · `POST disputes/:id/resolve {outcome: upheld\|written_off\|credit_required, note}` · `POST disputes/:id/{escalate,withdraw} {note?}` · `POST disputes/:id/notes {note}` | disputes |
| `GET/POST fee-plans` · `PATCH fee-plans/:id` · `GET agreements` · `PUT agreements/:id/terms {dispute_days?, fee_plans?: {"MYR": id\|null}}` · `GET/PUT members/:id/terms {fee_plans}` | commission (TODO(commercial)) |
| `GET entities` · `PUT entities/:country {legal_name, address, invoice_prefix, tax_id?, tax_registered?, bank_details?, placeholder?}` | issuing entities |
| `GET runs ?currency=&status=` · `POST runs {currency, period, cycle?}` (201 new / 200 existing) · `GET runs/:id` (+ positions, statements, fee invoices when final) · `POST runs/:id/{preview,finalise {force?},void}` | settlement runs |
| `GET positions ?member=&run=&status=&currency=` · `POST positions/:id/write-off {note}` · `GET payments ?position=&member=` · `POST payments {position_id, amount_minor, paid_at, reference, method?, note?}` · `POST payments/:id/confirm` | positions and payments |
| `GET statements ?member=&run=&currency=&period=` · `GET statements/:id` · `GET statements/:id/{html,pdf,csv}` · `GET fee-invoices ?member=&run=&status=` · `GET fee-invoices/:id` · `GET fee-invoices/:id/{html,pdf}` · `POST fee-invoices/:id/paid {paid_at, reference?}` | documents |

Member (`roaming:read` / `roaming:write`; the caller's org must be a hub member, else 404; runs in its RLS scope) —
`/v1/roaming/hub/clearing/…`: `GET summary`; `GET cdrs` (`?side=cpo|emsp` + the ledger filters) · `GET cdrs.csv` ·
`GET cdrs/:id` · `POST cdrs/:id/dispute` (eMSP); `GET disputes` · `GET disputes/:id` · `POST disputes/:id/respond
{action: accept|reject, note}` (CPO) · `POST disputes/:id/{escalate,withdraw}` (eMSP) · `POST disputes/:id/notes`;
`GET statements` · `GET statements/:id` · `GET statements/:id/{html,pdf,csv}`; `GET fee-invoices` · `GET
fee-invoices/:id` · `GET fee-invoices/:id/{html,pdf}`; `GET fee-plans` (own terms per currency); `GET positions`
(with `direction: pay|receive|none`) · `GET payments` · `POST payments` (payer, or payee = confirmed) · `POST
payments/:id/confirm` (payee); `PUT bank-details {bank_details}`. Rows carry `side` and counterparty names
(`*_member_name`).

Examples:

```jsonc
// POST /v1/roaming/hub/clearing/cdrs/3f0c…/dispute   (the eMSP)
{ "reason": "amount", "message": "The agreed tariff is RM 0.96/kWh", "claimed_minor": 1296 }
// 201
{ "dispute": { "id": "6a26…", "hub_cdr_id": "3f0c…", "status": "open", "reason": "amount", "currency": "MYR", "claimed_minor": 1296,
               "respond_by": "2026-10-13T16:30:13Z", "credit_due_by": null, "escalate_by": null, "resolution": null } }

// POST /v1/roaming/hub/clearing/disputes/6a26…/respond   (the CPO)
{ "action": "accept", "note": "Agreed: credit and re-issue at the agreed tariff." }
// 200 { "dispute": { "status": "accepted", "credit_due_by": "2026-10-13T16:31:02Z", … } }

// GET /v1/roaming/hub/clearing/cdrs?side=emsp&status=pending,disputed
{ "cdrs": [ { "id": "3f0c…", "cdr_id": "CDR-0042", "side": "emsp", "cpo": "MY*CPX", "emsp": "SG*EMX", "cpo_member_name": "Charge MY Sdn Bhd",
              "currency": "MYR", "total_excl_minor": 1500, "total_incl_minor": 1620, "energy_kwh": 12.5, "status": "pending",
              "flags": ["no_incl_vat"], "dispute_deadline": "2026-10-10T16:30:11Z", "fee_cpo_minor": null, "fee_emsp_minor": null,
              "settlement_run_id": null, "dispute_id": null, … } ],
  "next_cursor": null }

// POST /v1/hub/clearing/runs   { "currency": "MYR", "period": "2026-09" }
// 201
{ "created": true, "run": { "id": "9b1e…", "currency": "MYR", "cycle": "monthly", "period": "2026-09", "time_zone": "Asia/Kuala_Lumpur",
  "period_start": "2026-08-31T16:00:00Z", "period_end": "2026-09-30T16:00:00Z", "finalisable_at": "2026-10-15T16:00:00Z", "status": "draft",
  "preview": { "cdrCount": 5, "grossMinor": 2916, "feeMinor": 136, "finalisable": true, "periodEnded": true,
    "positions": [ { "memberA": "…", "memberB": "…", "aOwesB": 540, "bOwesA": 1296, "net": 756, "payer": "<XEM>", "payee": "<XCP>",
                     "payerName": "Charge SG Pte Ltd", "payeeName": "Charge MY Sdn Bhd", "cdrCount": 4 } ],
    "members": [ { "memberId": "…", "name": "…", "receivable": 2376, "payable": 540, "net": 1836, "feeCpo": 36, "feeEmsp": 0, "feeNet": 36, … } ],
    "carried": { "count": 1, "amountMinor": 108, "byStatus": { "disputed": 1 } } } } }

// POST /v1/hub/clearing/runs/9b1e…/finalise   {}        → 200 { "run": { "status": "finalised", "totals": {…} }, "alreadyFinalised": false }
// GET  /v1/roaming/hub/clearing/positions?run=9b1e…
{ "positions": [ { "id": "…", "currency": "MYR", "net_minor": 756, "paid_minor": 0, "outstanding_minor": 756, "status": "open",
                   "due_date": "2026-10-30", "direction": "pay", "payer_member_name": "…", "payee_member_name": "…", … } ] }
// POST /v1/roaming/hub/clearing/payments   { "position_id": "…", "amount_minor": 756, "paid_at": "2026-10-20", "reference": "TRF-123", "method": "bank_transfer" }
// 201 { "payment": { "id": "…", "recorded_side": "payer", "confirmed_by_payee_at": null, … }, "position": { "status": "paid", "paid_minor": 756, … } }
// POST /v1/roaming/hub/clearing/payments/<id>/confirm   (the payee)  → { "payment": {…}, "position": { "status": "confirmed" } }
```

Statement `data` (frozen; what the screens show): `member`, `currency`, `period`, `cycle`, `periodStart/End`,
`timeZone`, `totals {receivableMinor, payableMinor, netMinor, feeCpoMinor, feeEmspMinor, feeNetMinor, cdrsAsCpo,
cdrsAsEmsp, energyAs*Kwh}`, `counterparties [{memberId, name, country, positionId, receivableMinor, payableMinor,
netMinor, direction, cdrCount, dueDate, payeeBankDetails}]`, `cdrs [{cdrId, side, counterparty, start, end, energyKwh,
exclMinor, inclMinor, amountMinor, credit, credits, feeMinor}]`, `carried {count, amountMinor, items}`, `feeInvoice
{id, number, totalMinor}`, `dueDate`, `issuedAt`.

#### Deviations from the design, with reasons

| # | Design | As built | Why |
|---|---|---|---|
| 1 | `/v1/hub/{cdrs,disputes,fee-plans,settlement-runs,statements,fee-invoices,payments}`, member `/v1/roaming/hub/{cdrs,…}`, documents `:id(.pdf\|.csv)` | everything under `/v1/hub/clearing/*` and `/v1/roaming/hub/clearing/*`; documents `:id/{html,pdf,csv}` | WP brief; one prefix per surface for H3; plain path segments in the OpenAPI catalogue |
| 2 | dispute statuses `open/cpo_accepted/cpo_rejected/escalated/resolved`, resolutions incl. `partially_credited` | `open/accepted/rejected/escalated` + final `credited/expired/resolved/withdrawn`; resolution `credited/upheld/written_off`; platform `credit_required` (→ accepted) covers partial credits (credit + corrected CDR) | WP brief's states; the unanswered/overdue paths need `escalated`; `withdrawn` lets an eMSP retract |
| 3 | evidence in the dispute row | `hub_dispute_note` (every transition + free notes, both sides see them) | evidence trail |
| 4 | `hub_member.fee_plan_id` / `hub_agreement.fee_plan_id` | per-currency `hub_fee_assignment` (agreement or member); the 072 columns get their FKs but are not read; `emsp_min/max` added | a plan is per currency; one column cannot hold three |
| 5 | one dispute window | `hub_agreement.dispute_days` overrides `HUB_DISPUTE_DAYS` | WP brief |
| 6 | `source` push / pull_tap / hub_pull; `emsp_location_url` | push / pull; the eMSP Location stays in H1's `hub_callback`; `routing` JSONB added | the router owns Locations; routing ids for support |
| 7 | duplicate with other content → held | refused by `admit` (2001) on push; flagged on pull | a CDR cannot change; matches the router's own rule |
| 8 | — | undelivered pushes held (`not_delivered`) until a retry or a pull reaches the eMSP; the CPO may correct an undelivered CDR under the same id | the eMSP must not be charged for a CDR it never received |
| 9 | credit totals negative | magnitudes accepted and stored negative | some platforms send credit = true with positive totals |
| 10 | draft run writes positions | the draft keeps a `preview` JSON; positions/statements only at finalise | a draft is re-runnable without deleting rows |
| 11 | `pdf_key` (stored PDFs) | rendered on demand from frozen `data` | deterministic; no storage lifecycle |
| 12 | statement number `PSH-ST-2026-10-IDR-000123` | `PSH-ST-{YYYY}-{CUR}-{seq}` gapless per year | gapless numbering without a per-month sequence |
| 13 | position `open/paid/confirmed/overdue/written_off` | + `partially_paid`, `nothing_due`; `paid_minor`, `reminders_sent`, write-off route; overpayment refused | WP brief: partial payments and outstanding balance |
| 14 | webhooks `hub.cdr.flagged`, `hub.dispute.*`, `hub.statement.issued`, `hub.payment.overdue` | alerts of those kinds through the existing `alert.raised` (stored, routed, and delivered by the `alert.raised` webhook) | no change to the webhook event list (shared module); [H3] dedicated events if wanted |
| 15 | `hub-cdr-pull` worker (`pull.ts`): the hub pulls CDRs of CPOs that do not push | **not built** — CDRs are recorded when pushed or when an eMSP pulls them through the hub | needs per-member "pushes or not" settings and a pull cursor; [H2-later] |
| 16 | statement emails | alerts only (`hub.statement_issued` to each member org) | no hub email templates yet [H3] |
| 17 | `hub-settlement-draft` daily | every 6 h, previous period only; alerts once when finalisable; `hub-payment-overdue` added (hourly) | cheap and idempotent |
| 18 | e-Faktur export of ID fee invoices | not built | [VERIFY field mapping] first |
| 19 | entities edited by `PUT /v1/hub/entities` | `PUT /v1/hub/clearing/entities/:country`; 073 seeds placeholders flagged `placeholder` | [OWNER] entities unknown |
| 20 | ledger hook registered at API start | in `registerHubApi` | the gateway's minimal in-process hub instance routes tenant pushes too (found by the e2e) |

#### Tests and rehearsal

Unit (no DB): `period.test.ts` (ID/MY/SG month boundaries at local midnight, year end, leap February, weekly,
tiling), `fees.test.ts` (half-up minor units in IDR/MYR/SGD, fixed/min/max, exact and pro-rata credit reversal),
`netting.test.ts` (one way, both ways, symmetry, zero net, 3 members × 2 currencies by hand, credits same/next run,
fees not netted, currency isolation), `intake.test.ts` (minor units from 4-dp inputs, credit signs, malformed, every
hard and soft flag), `disputes.test.ts` (every transition, wrong side 403, impossible 409, final states),
`invoices.test.ts` (ID PPN/DPP/PPh 23, SG GST, MY SST, NONE, reverse charge; position status; HTML/PDF/CSV, CSV
formula escaping). DB: `clearing.db.test.ts` (push + 2 pulls and a concurrent race → one row; undelivered → held →
released by a pull; admit rules; no-agreement hold and release; credit holds; dispute flows incl. deadlines and
written-off; autoAccept respects disputes; draft idempotent and nothing stamped; finalise refused early; 3-member MYR
fixture + IDR run by hand; KL cut-off one second before / at midnight; finalise twice; credit offset in the next
run; partial payments, payee confirmation, overpayment refused; overdue reminders; RLS as `plugsure_app`: a member
sees only its own ledger, disputes, positions, statements, invoices, payments, and no platform tables).
E2E `hub-clearing-e2e.mts` (45 checks): the WP flow end to end, see the file header.

**Results** on the `hub` branch: unit suite **1368/1368** (1303 before H2; +65: period 9, fees 7, netting 10, intake 7,
disputes 4, invoices/documents 9, clearing DB 18, disabled 1). `hub-clearing-e2e` **45/45** (three times on one
database: re-runnable), `hub-e2e` **88/88** (87 + the ledger check). The whole CI e2e job (17 suites, HUB_ENABLED=true)
green on a fresh database, and `ocpi`, `ocpi-emsp`, `ocpi-auth`, `ocpi-profiles` green with the hub on and off.

**Migration rehearsal.** A copy of the database after the full e2e job (14 organisations, 65 sessions, 61 CDRs; H1
hub data: 6 members, 10 parties, 6 agreements, 225 routing log rows) taken back to 072 (`073_down.sql`, 79 ms), then
`npm run migrate`: 073 alone, **≈ 90 ms of statement time** (46 statements, one transaction; 0.7 s wall including
node start-up). Counts and digests of the existing rows unchanged; 3 placeholder entities and 3 zero default plans
seeded; every hub table with forced RLS. The only changes to existing tables are three nullable / constant-default
columns (`hub_entity`, `hub_member`, `hub_agreement`: no rewrite) and two FKs on the small `hub_member` /
`hub_agreement` tables (brief SHARE ROW EXCLUSIVE locks, bounded by `MIGRATION_LOCK_TIMEOUT`). A second `migrate` is
a no-op; `073_down.sql` refuses while `hub_cdr` holds rows ("export and remove it deliberately first").

**Open points.**
- [OWNER] Commission model and rates (all 0, `TODO(commercial)`); dispute, response, escalation, credit and payment
  windows (14/10/5/10/14 days); monthly cycle; whether held CDRs are forwarded (yes); overdue auto-suspension (not
  built); who may write off a position (platform only).
- [OWNER/LEGAL] The PlugSure entities (legal names, tax ids, registrations) — seeded as flagged placeholders; documents
  from a placeholder say "not valid as a tax invoice".
- [LEGAL] Bilateral set-off enforceability (ID/MY/SG); hub statements as the basis of the CPO's own invoices (not
  self-billing); fee invoices in a currency other than the entity's (tax reporting at the official rate); SG GST
  zero-rating for overseas members; MY service tax scope of a clearing service; ID PPh 23 on hub fees; cross-border
  reverse charge; retention (10 y assumed) and cross-border CDR data (UU PDP / PDPA).
- [H2-later] Hub-initiated pull of CDRs from CPOs that do not push (`hub-cdr-pull`); e-Faktur export of ID fee
  invoices; statement e-mails; dedicated webhook event types.
- [H3] Console screens on the APIs above (ledger with flag filters and held queue, disputes with notes, runs with
  preview/finalise, statements/invoices downloads, positions and payments, fee plans, entities, member bank details).

### H3 — console, docs, test fakes

**Owns:**
- `src/web/js/views/hub.js`, the hub sections of `src/web/js/views/roaming.js`, `src/web/js/core.js`
  (`hub_only` menus);
- `tools/e2e/lib/ocpi-fakes.mts` (extracted from the existing suites; those suites are updated to import it,
  behaviour unchanged), `tools/e2e/hub-e2e.mts` (with H1 and H2 adding their steps), the `package.json` script;
- `deploy/HUB-ONBOARDING.md`;
- `docs/HUB-DESIGN.md` upkeep;
- `RELEASE-NOTES-v1.8.0.md`.

`deploy/HUB-ONBOARDING.md` is for external operators:
- what PlugSure Hub is;
- the commercial prerequisites (signed hub agreement, roaming agreements);
- the technical prerequisites (OCPI 2.2.1, HTTPS public endpoints, routing headers on every functional request,
  ClientInfo RECEIVER recommended);
- the two handshake paths with curl examples;
- the module checklist per role;
- addressing: to = party vs to = hub (broadcast/GA) vs open routing;
- callbacks and Location behaviour;
- error codes 4001–4003 and 49xx;
- rate limits;
- the test sandbox;
- go-live checklist;
- CDR, dispute and settlement rules and timelines;
- support contacts and correlation ids.

**Acceptance**
- The console flows work end to end in `console-e2e` additions: onboard a member, see token A once, propose and
  accept an agreement, view a trace, finalise a run, download a statement.
- A visual check passes at 360 px and desktop.
- The onboarding guide is reviewed by walking it through with the fake external CPO (every command in the guide is
  executed by a doc test or the e2e).

### H3 as built (step 1: console, docs, fakes; clearing screens follow H2)

**Console.** `src/web/js/views/hub.js`: menu **Governance → Hub**, platform admins only and only with `HUB_ENABLED`
(`features.hub` in `/v1/auth/me`; a view may now declare `when()` in `app.js`). Tabs: **Overview** (KPIs, members and
parties by country, 24 h traffic per route, open hub alerts, connection health, hub endpoint), **Members** (filters;
new external member with token A shown once — copy buttons, versions URL, next steps; join a tenant; member drawer
with Connections — connect, alive check, rotate, suspend/resume, approve a party, rate limits, body capture, close —,
Parties — suspend/resume —, Agreements, Traffic, Details), **Agreements** (list or CPO × provider matrix; create;
approve/suspend/resume/end; module flags), **Message log** (party, module, route, status, correlation id; trace
drawer with every leg, redacted bodies when captured), **Outbox** (backlog per recipient, replay failed, rows).
**Clearing** appears only when the build registers `/v1/hub/clearing/*` (`overview.modules.clearing`); it is a
placeholder until H2's screens. Every lifecycle action asks for a reason (required for suspend/close/end/terminate,
typed phrase for terminate/close/end/remove) and the API stores it in the audit entry (`after.reason`).
Tenant: **Roaming → Partners → PlugSure Hub** card (membership status and what it means, its parties, its
agreements with counterparty and modules, Join when `HUB_SELF_JOIN`).

**API additions (small, `hub-routes.ts`).** `reason` on every lifecycle body → audit; overview `membersByCountry`,
`partiesByCountry`, `alerts`, `modules`; `GET /v1/hub/tenants` (join picker); `module` filter on the message log;
tenant `GET /v1/roaming/hub` returns `agreements` (counterparty name, never tokens/endpoints).

**Alerts.** `src/hub/alerts.ts`: `hub.forward_error_rate` (worker every 5 min; `HUB_ALERT_ERROR_RATE_PCT` 25 of at
least `HUB_ALERT_MIN_REQUESTS` 20 outbound legs in 15 min; resolved below), `hub.response_filtered` (raised by the
router's response filter), and stale `hub.connection_offline` resolved when the parties are back. **Fix:** H1 raised
hub alerts with `org_id = NIL_ORG`, which the alert table's foreign key refuses — none was ever stored. Hub alerts are
now raised in the connection's member organisation (`raiseHubAlert`), incl. `hub.connection_offline` and
`hub.outbox_backlog`.

**Docs.** `deploy/HUB-ONBOARDING.md` (external members), `deploy/HUB-OPERATIONS.md` (platform operator), a `hub.*`
site block in `deploy/Caddyfile`, README configuration row, `.env.example`.

**Fakes.** `tools/e2e/lib/ocpi-fakes.mts` now also holds the peer suites' partners (`MockPeer`, `MockEmspPartner`,
`MockCpoPartner`, `MockSpAndHub`), moved unchanged from `ocpi-e2e`, `ocpi-emsp-e2e` and `ocpi-profiles-e2e`.

**Tests.** `tools/e2e/hub-console-e2e.mts` (`npm run e2e:hub-console`, in CI after `e2e:hub`): every call the screens
make, in operator order, against a fake member. Unit: `src/hub/alerts.test.ts`.

### H3 as built (step 2: clearing screens, v1.8.0)

**Console.** `src/web/js/views/hub-clearing.js` (shared helpers in `hub-common.js`): Hub → **Clearing** for platform
admins — Overview (ledger by currency × status, held by flag, disputes, runs, outstanding, fee invoices, "accept due
now"), Ledger (filters, keyset paging, CSV; CDR drawer with release / void / dispute, credit links, body, trace),
Disputes (drawer with notes; resolve / escalate / withdraw), Settlement runs (create, preview, finalise with typed
`FINALISE` and `force` before `finalisable_at`, void with `VOID`; positions, members, CDRs, documents), Positions &
payments (record, confirm, write-off with `WRITE OFF`), Documents (statements HTML / PDF / CSV, fee invoices HTML /
PDF, mark paid), Commission (fee plans, agreement and member terms), Entities (placeholder flag). Roaming → **PlugSure
Hub** for members: summary, own ledger (dispute as eMSP), disputes (respond as CPO, escalate / withdraw as eMSP,
notes), statements and invoices, positions and payments, commission terms, bank details. Money per currency with
`fmt.money`, never summed across currencies.

**`hub_only` consoles.** `/v1/auth/me` → `org.hubOnly`; `app.js` then shows only views flagged `hubOnly` (Roaming —
its PlugSure Hub tab alone —, Users & Roles, Developers) and no charger search.

**Fixes.** joinTenant takes the member's country from the tenant's home OCPI party (re-join follows a moved identity;
`join-country.db.test.ts`). `OCPI_PUBLIC_URL=` empty falls back to `PUBLIC_BASE_URL`. Clearing platform alerts
(`orgId` null) were stored under `NIL_ORG` and refused by the foreign key: now in the target member's organisation
(the run's `hub.settlement_ready` is logged only). Run finalise / void take a `reason` (audited). Dispute detail rows
carry member names. The router race in `app.js` (a stale view's error painted over the next view) is fixed.
The member clearing routes and the tenant hub routes are **published** in the OpenAPI document (318 operations).

**Tests.** `hub-console-e2e` extended with every clearing call of the screens (paging, filters, CSV, CDR and dispute
drawers, fee plans and terms, entities, runs incl. void / finalise reasons, documents, positions, payments, the
tenant's tab and a hub-only organisation).

---

## 14. Open questions

### 14.1 Owner [OWNER]

1. **Hub party ids** (`ID*PSH`, `MY*PSH`, `SG*PSH`?), and which **PlugSure legal entities** exist or will exist per
   country, i.e. who issues fee invoices.
2. **Commission model and rates:** CPO %, minimum, eMSP per-CDR fee, per-currency values, volume tiers.
   Placeholders are zero.
3. **Dispute window** (default 14 days), CPO response time (10 days), **payment terms** (14 days), **cycle**
   (monthly).
4. **Closed vs open network:** agreements required (default) vs open roaming opt-in. Should parties without an
   agreement appear as PLANNED in ClientInfo (default no)?
5. **CDRs without an agreement:** forward and hold (default), or refuse.
6. **Self-join** for tenants, and platform approval of agreements.
7. **Hub-to-hub peering** (e.g. with Gireve or Hubject OCPI) — phase 2?
8. **Auto-suspension** for overdue payers.
9. **Logins for external members** (hub-only orgs) vs API-only.
10. **Phase-2 PSP choice** for collection and payouts (Stripe Connect SG/MY, Xendit ID) and timing.

### 14.2 Legal and tax [LEGAL]

1. Confirm that **phase-1 clearing without handling funds** needs no payment licence in SG (PSA), MY (FSA/MSBA) or
   ID (PBI 22/23/2020). Confirm that bilateral **set-off** clauses are enforceable.
2. **MoR rejection:** confirm that reselling charging would require SPKLU/electricity licensing in ID, and what
   applies in MY (Energy Commission) and SG (EMA/LTA EVCO licence).
3. **Tax on hub fees:** PPN and PPh 23 for the ID entity; SG GST registration and zero-rating for overseas members;
   MY service tax scope for a clearing/platform service; cross-border reverse-charge mechanics; invoicing in a
   currency other than the entity's.
4. **CPO→eMSP invoices across borders** (e.g. SG CPO, MY eMSP): GST zero-rating? Not the hub's liability in phase 1,
   but the statement layout should support it.
5. **Data protection:** UU PDP, PDPA MY and PDPA SG for routing and storing CDRs (contract ids, locations, times)
   across borders; DPA clauses; retention (10 y assumed).
6. **Self-billing** (the hub issuing invoices in the CPO's name, Hubject-style) as a later option.

### 14.3 Interoperability [VERIFY]

1. The HTTP status that carries 4xxx hub errors (we use 200).
2. Broadcast of Tariffs and DELETE.
3. Whether external eMSPs expect `OCPI-to` absent on GA.

To be checked with the first external members during sandbox testing.

---

## Sources

- OCPI 2.2.1 (release-2.2.1-bugfixes):
  - [transport_and_format](https://github.com/ocpi/ocpi/blob/release-2.2.1-bugfixes/transport_and_format.asciidoc) (Message Routing, Broadcast Push, Open Routing, GET All via Hubs, Unique message IDs, Pagination)
  - [status_codes](https://github.com/ocpi/ocpi/blob/release-2.2.1-bugfixes/status_codes.asciidoc) (4xxx hub errors)
  - [credentials](https://github.com/ocpi/ocpi/blob/release-2.2.1-bugfixes/credentials.asciidoc) (CredentialsRole; hub reports only role HUB)
  - [mod_hub_client_info](https://github.com/ocpi/ocpi/blob/release-2.2.1-bugfixes/mod_hub_client_info.asciidoc)
  - [mod_commands](https://github.com/ocpi/ocpi/blob/release-2.2.1-bugfixes/mod_commands.asciidoc)
  - [mod_charging_profiles](https://github.com/ocpi/ocpi/blob/release-2.2.1-bugfixes/mod_charging_profiles.asciidoc)
  - [mod_tokens](https://github.com/ocpi/ocpi/blob/release-2.2.1-bugfixes/mod_tokens.asciidoc)
  - [mod_cdrs](https://github.com/ocpi/ocpi/blob/release-2.2.1-bugfixes/mod_cdrs.asciidoc) (Credit CDRs, Location response URL)
- Hubject: [FAQ CPO (Financial Services)](https://support.hubject.com/hc/en-us/articles/26990001350813-FAQ-CPO), [Invoice Management launch](https://www.hubject.com/blog-posts/hubject-launches-new-eroaming-feature-invoice-management), [electrive 2021](https://www.electrive.com/2021/12/07/hubject-starts-automatic-invoice-management)
- Gireve: [Clearing services](https://www.gireve.com/clearing-services/), [ACPR payment agent agreement](https://www.gireve.com/acpr-agreement-gireve-takes-a-major-step-toward-simplifying-roaming-invoicing/), [B2B invoicing](https://www.gireve.com/gireve-facilitates-b2b-invoicing-of-ev-charging-in-roaming-situations/)
- enapi: [Financial clearing](https://enapi.com/product/financial)
- Regulatory references are named for counsel (Payment Services Act 2019 SG; Financial Services Act 2013 and Money
  Services Business Act 2011 MY; PBI 22/23/PBI/2020 and Law 7/2011 ID). They were not verified in this design
  (§1.3).
- Code: `src/ocpi/*.ts`, `src/api/roaming-routes.ts`, migrations 015, 016, 036, 047, 048, 059, 060;
  `docs/MULTI-COUNTRY-DESIGN.md` §2.4, §D7, §D8; `RELEASE-NOTES-v1.7.0.md`.
