# PlugSure Hub — operations runbook (platform operator)

**Audience:** PlugSure's platform team (platform administrators and on-call).
**Scope:** enabling the OCPI 2.2.1 roaming hub on a PlugSure deployment, onboarding members, agreements, monitoring,
token rotation, suspensions and troubleshooting. The design is `docs/HUB-DESIGN.md`; the guide for external members
is `deploy/HUB-ONBOARDING.md` (send it to every new member).

Clearing and settlement (the CDR ledger, disputes, settlement runs, statements, fee invoices, payments) is §8; its
design and rules are `docs/HUB-DESIGN.md` §8 and "H2 as built".

---

## 1. Enable the hub

The hub is off by default (`HUB_ENABLED=false`): nothing under `/hub` is mounted, no hub worker runs, the console
shows no Hub menu and `/v1/hub/*` answers 404. Turning it on changes nothing for existing roaming partners
(`/ocpi/*`) or tenants.

### 1.1 Settings (`/etc/plugsure/plugsure.env`, API and gateway alike)

| Variable | Default | Meaning |
|---|---|---|
| `HUB_ENABLED` | `false` | Mounts the hub surface `/hub/ocpi/*`, the platform API `/v1/hub/*`, the tenant card and the hub workers. |
| `HUB_PUBLIC_URL` | `OCPI_PUBLIC_URL` | Public origin of the hub, its **own host**: `https://hub.plugsure.asia`. Members' versions URL is `<this>/hub/ocpi/versions`. |
| `HUB_PARTIES` | `ID*PSH,MY*PSH,SG*PSH` | The hub's own parties (role HUB), one per country. The process refuses to start when malformed. Choose once: members store them. |
| `HUB_BUSINESS_NAME`, `HUB_WEBSITE` | `PlugSure Hub`, empty | The business details in the hub's credentials. |
| `HUB_SELF_JOIN` | `false` | Tenants may join the hub themselves (Roaming → PlugSure Hub → Join). Off: a platform admin joins them. |
| `HUB_FORWARD_TIMEOUT_MS` | `10000` | Deadline of a forwarded request (then `4002`). |
| `HUB_REALTIME_TIMEOUT_MS` | `4000` | Deadline of a real-time authorisation (below the tenants' `OCPI_REALTIME_AUTH_TIMEOUT_MS`). |
| `HUB_CALLBACK_TTL_S` | `900` | Validity of a rewritten command `response_url`. |
| `HUB_ALIVE_AFTER_MIN` | `5` | Idle minutes before a member's versions URL is checked. Two failures → its parties OFFLINE. |
| `HUB_TOKEN_GRACE_MIN` | `60` | Minutes the old token keeps working after a rotation forced by the platform. |
| `HUB_ALERT_ERROR_RATE_PCT` | `25` | Alert `hub.forward_error_rate` when this share of a connection's outbound calls failed in 15 min … |
| `HUB_ALERT_MIN_REQUESTS` | `20` | … and it had at least this many. |
| `HUB_AGREEMENT_PLATFORM_APPROVAL` | `false` | Reserved for member-proposed agreements (not used yet). |

Restart both services after a change: `systemctl restart plugsure-api plugsure-gateway`.

### 1.2 DNS and TLS

1. Create `hub.plugsure.asia` (A/AAAA, or a CNAME to the API host) **[OWNER: final hostname]**. Use a hostname of
   its own: the hub's base URL must differ from the tenants' `OCPI_PUBLIC_URL`, and members must never be handed
   the console or tenant OCPI hostnames.
2. Add the hub site block to Caddy (`deploy/Caddyfile`, block `hub.example.id`): it serves `/hub/ocpi/*` only,
   proxies to the API on `127.0.0.1:9200`, and answers 404 for everything else. Replace the hostname, then
   `caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy`. The certificate is issued on reload
   (DNS must already point here).
3. Set `HUB_PUBLIC_URL=https://hub.plugsure.asia` and restart.
4. Check from outside: `curl -sS https://hub.plugsure.asia/hub/ocpi/versions` → HTTP 401 (a token is required: the
   surface is up). `https://hub.plugsure.asia/` → 404.

### 1.3 Migration

The hub's tables come with migration `072_hub_core.sql` (additive; the only change to an existing table is
`organisation.hub_only` with a constant default). `npm run migrate` / `plugsure-migrate.service` applies it as
usual; rollback is `db/rollback/072_down.sql` (drops every hub table).

### 1.4 First check in the console

Sign in as a platform administrator (`npm run create-admin -- … --platform-admin` creates one). **Governance → Hub**
appears. Overview → **Hub endpoint** shows the versions URL and the hub parties. If the menu is missing, the API
was not restarted with `HUB_ENABLED=true` (the console reads it from `/v1/auth/me`).

## 2. Members

A **member** is a contracting legal entity. It has one or more **connections** (one credentials handshake each)
and **parties** (country code + party id + role) on them. Statuses: `onboarding` → `active` ⇄ `suspended` →
`terminated`. A member's parties stay **PLANNED** (invisible to everyone) until it is activated.

### 2.1 Onboard an external member (its own platform)

Hub → **Members** → **New external member**:

1. Legal name, country of incorporation (selects the PlugSure entity that invoices it), tax id, billing e-mail,
   contract reference. Leave **Open roaming** off unless the contract says otherwise.
2. Keep **Issue its registration token (token A) now** on. The dialog shows the **versions URL** and **token A once**
   (copy buttons; PlugSure stores only a hash). Send them to the member's technical contact over a secure channel,
   with `deploy/HUB-ONBOARDING.md`. Token A only allows the handshake.
3. The member runs the handshake (guide §4.1). The member's drawer → **Connections** then shows the connection
   **connected**, its versions URL, OCPI version, endpoints and parties (**planned**).
4. When the contract is signed: **Activate** (give a reason, e.g. the contract number; it goes into the audit log).
   Its parties become **CONNECTED**.
5. Create its **agreements** (§3). Nothing is routed before.

**The member gives you its own URL and token instead** (it wants to be called first): untick token A when creating
the member, then **New connection** → on the pending connection **Connect with their URL and token**.

**Token A lost or leaked before use:** close the pending connection (**Close**) and issue a new one (**New
connection**).

### 2.2 Join a PlugSure tenant (zero configuration)

Hub → Members → **Join a tenant**. Only tenants with a roaming identity (Roaming → identity) are listed. The join
is one transaction, no network calls: its identities become hub parties (CPO for each; eMSP for the home party) and
a **PlugSure Hub** partner appears in the tenant's Roaming page. Activate it like an external member. With
`HUB_SELF_JOIN=true` tenants can join themselves from Roaming → **PlugSure Hub**.

A tenant leaves with **Remove from hub** in its drawer (type `REMOVE`): its hub connection and partner are closed,
its parties SUSPENDED; it can join again later.

### 2.3 Additional parties

A member adding a country or a role: on its connection, **Approve a party** (role, country code, party id, business
name). The party is added PLANNED; the member then confirms it with `PUT /credentials` listing the new role. A
(country code, party id) can belong to one member only.

### 2.4 Member lifecycle

| Action | Effect | Undo |
|---|---|---|
| **Suspend** (reason required) | every connection of the member refused (HTTP 403), parties SUSPENDED for counterparties, queued broadcasts to it dropped | **Resume** |
| **Terminate** (type `TERMINATE`) | every connection closed, tokens dead, parties SUSPENDED for good; records kept | none: create a new member |
| **Details** tab | legal name, tax id, billing e-mail, contract reference, open roaming | — |

## 3. Agreements

Without an active agreement (or mutual open roaming) the hub routes nothing between two parties (`4901`), and
neither sees the other in HubClientInfo.

Hub → **Agreements** (list, or **Matrix**: CPO parties × provider parties; a cell shows the agreement, `+` creates
one):

- **New agreement**: a CPO party, a provider party (eMSP, NSP, SCSP, Other) of **another** member, optional validity
  dates, modules (real-time authorisation, commands, charging profiles; on by default), notes. Created **active**
  unless you untick it (then **proposed** → **Approve**).
- Click an agreement: change the **modules** (a module turned off is refused with `4901`), **Suspend** (reason
  required) / **Resume**, **End** (final; type `END`).
- On activation both sides get ClientInfo for each other and PlugSure tenants on either side run a "welcome sync"
  (their network is published to the counterparty and the counterparty's network imported).

Tenants see their agreements (counterparty, status, modules) under Roaming → **PlugSure Hub**.

## 4. Monitoring

### 4.1 Hub → Overview

| Tile / table | Watch for |
|---|---|
| Parties connected | `offline` > 0: a member's platform stopped answering alive checks. |
| Requests, 24 h | error share; a jump usually means one member's endpoint is failing. |
| Outbox backlog | `failed` > 0 (deliveries the hub gave up retrying). |
| Open hub alerts | see §4.2. |
| By country | members and party statuses per country. |
| Connection health | per connection: traffic in/out (15 min), outbound errors, p95 latency, `4002`/`4003` (24 h), outbox, last seen and last problem. Click a row for the member. |

### 4.2 Alerts

Hub alerts use the normal alert pipeline (Governance → Alert routing; they are raised in the member's
organisation and listed on the Hub overview):

| Kind | Raised when | Resolved when |
|---|---|---|
| `hub.connection_offline` | a member failed two alive checks: its parties are OFFLINE | its parties are back (checked every 5 min) |
| `hub.forward_error_rate` | ≥ `HUB_ALERT_ERROR_RATE_PCT` of ≥ `HUB_ALERT_MIN_REQUESTS` outbound calls to a connection failed in 15 min | the rate drops below |
| `hub.response_filtered` | a CPO returned sessions or CDRs of another eMSP to a requester; the hub withheld them | manually (a CPO bug to raise with the member) |
| `hub.outbox_backlog` | over 10 000 queued broadcasts to one connection: new broadcasts to it are dropped | manually, once it caught up |

### 4.3 Message log and trace

Hub → **Message log**: every request the hub received (`in`) and every leg it forwarded (`out`), filtered by party
(`MY*ABC`), module, route, status (errors only) or correlation id. Token uids in paths are masked; bodies are not
logged. Click a row for the **trace**: every leg of that `X-Correlation-ID` in order, with HTTP and OCPI status,
timing and request ids. Members quote the correlation id when they call support.

**Body capture** (member drawer → connection → **Body capture**, reason required): for up to 72 hours the log keeps
that connection's bodies, redacted (token uids, contract ids, names, e-mail masked); they are deleted after 72 hours.
Turn it off when done. Each switch is audited.

### 4.4 Outbox

Hub → **Outbox**: per recipient, queued / failed / dropped (24 h); the rows with their last answer. Broadcasts,
command results and ClientInfo are retried with back-off (callbacks and ClientInfo for up to 24 hours), then
**failed**. After the cause is fixed
(the member's endpoint, its token), **Replay failed** queues them again in their original order.

## 5. Tokens

| Situation | Action |
|---|---|
| Routine rotation, or a member's token may have leaked | member drawer → connection → **Rotate token**. The hub PUTs new credentials to the member; the member's old token works for `HUB_TOKEN_GRACE_MIN` (60 min). The connection shows "old token in grace period". |
| The member rotates itself | nothing to do: its `PUT /credentials` kills its old token at once. |
| Token A not used / leaked | **Close** the pending connection; **New connection**. |
| A PlugSure tenant's in-process connection | **Rotate token** replaces both internal tokens at once; nothing to send anyone. |

Tokens are never shown after creation (token A once). They are stored hashed (lookup) and sealed with
`SECRETS_KEY`.

## 6. Suspending

| Scope | Where | Effect |
|---|---|---|
| One **party** | member drawer → Parties → **Suspend** (reason) | that party only: not routed (`4003`), SUSPENDED for counterparties; stays suspended whatever its connection does (alive checks do not lift it) |
| One **connection** | Connections → **Suspend** (reason) | requests on it refused (403), its parties SUSPENDED, queued messages to it dropped |
| One **agreement** | Agreements → agreement → **Suspend** (reason) | routing between those two parties stops (`4901`) |
| The **member** | drawer header → **Suspend** (reason) | all of the above for every connection |

Each has its **Resume**. Every action and its reason is in the audit log (Governance → Audit log, platform chain,
and the member's own chain).

## 7. Troubleshooting

| Symptom | Look at | Usual cause / fix |
|---|---|---|
| Member's handshake fails (`POST /credentials` → 2001/3001) | Message log, module `credentials`, the member's connection; the error text | its versions URL not reachable over public HTTPS, not 2.2.1, a private address, or a role already owned by another member. |
| Connection stays **waiting for handshake** | nothing in the log for it | the member has not called yet, or used a wrong token A (401s are not logged per connection: ask for its request time). |
| Parties **OFFLINE** | Overview → health: last problem (`alive check: …`) | the member's versions URL is down or its TLS broken. **Alive check** re-tests now. Any request from it brings it back. |
| A member gets `4901` | Agreements (matrix) | no agreement, agreement suspended/ended, outside its validity dates, or the module flag off. |
| A member gets `4001` | the `OCPI-to` in the trace | addressing a party that does not exist or is not visible to it (no agreement). |
| A member gets `4003` | the receiver's health | the receiver OFFLINE/SUSPENDED/PLANNED, or it lacks the interface (endpoints list). |
| A member gets `4903` | the trace: `from` | it sends as a party that is not on its connection (needs **Approve a party** + its `PUT /credentials`). |
| A member gets `4905` | its rate | raise **Rate limits** on the connection if its volume is legitimate. |
| Broadcasts not arriving | Outbox, filtered by recipient | receiver OFFLINE (dropped), no `{module}` RECEIVER endpoint, failed after 24 h (fix, then **Replay failed**). |
| A tenant does not see a hub CPO's sites | its Roaming → Partner network; the tenant's PlugSure Hub partner | agreement not active yet; the welcome sync runs on activation (Refresh their network in the partner drawer re-imports). |

When escalating to engineering, include the correlation id, the member, and the time (UTC).

## 8. Clearing and settlement (Hub → Clearing)

Every CDR routed through the hub lands in the **ledger** once. Amounts are per currency (IDR, MYR, SGD), never added
up across currencies. Settings: `HUB_DISPUTE_DAYS`, `HUB_DISPUTE_RESPONSE_DAYS`, `HUB_DISPUTE_ESCALATE_DAYS`,
`HUB_CREDIT_DUE_DAYS`, `HUB_PAYMENT_TERMS_DAYS`, `HUB_CYCLE`, `HUB_DEFAULT_ENTITY`, `HUB_LATE_CDR_DAYS`.

| Task | Where | Notes |
|---|---|---|
| Daily check | Clearing → **Overview** | held CDRs (by reason), live and escalated disputes, draft runs ready to finalise, outstanding positions, fee invoices |
| Held CDRs | Overview → a held reason, or Ledger → status *held* → the CDR | **Release** (note required: it becomes payable) or **Void** (note + typed `VOID`: never settled). The CDR was forwarded to the eMSP either way |
| A CDR's history | Ledger (filters: status, flag, currency, member, dates, id; *Load more*; CSV) → the CDR | amounts, flags, dispute window, commission once accepted, run, credit links, the body as received, the routing correlation id (→ trace) |
| Accept due CDRs now | Overview → **Accept due CDRs now** | the worker does it every 15 min; accepting freezes the commission |
| Escalated disputes | **Disputes** (live) → the dispute | read the notes of both sides; **Resolve**: upheld (the eMSP pays), credit required (the CPO must send a credit CDR), written off (nobody pays). A note is required and both members see it. **Escalate** / **Withdraw** exist for exceptional cases |
| Month end | **Settlement runs** → **New run** (currency, cycle, period `YYYY-MM`) | creates the draft (idempotent); the preview shows positions per member pair, members' receivable / payable / net, commission and what is carried (pending, disputed, held). **Refresh preview** any time |
| Finalise | the run → **Finalise** (type `FINALISE`, note) | from `finalisable_at` (period end + dispute window + 1 day); earlier only with *force*. Writes numbered statements, bilateral positions and fee invoices. Final: corrections are credit CDRs in a later run. A draft can be **voided** (type `VOID`) |
| Documents | **Documents**, or the run → Documents | statements (View / PDF / CSV) per member, fee invoices (View / PDF); **Mark paid** when PlugSure receives a fee invoice payment |
| Payments between members | **Positions & payments** | members record and confirm their transfers themselves (Roaming → PlugSure Hub); the platform can record one for them, confirm, or **Write off** what remains (type `WRITE OFF`, note) |
| Commission | **Commission** | fee plans per currency (CPO and eMSP parts: %, fixed, min, max — `TODO(commercial)`, 0 today); **agreement terms** (dispute window, plan per currency) and **member terms** override the default. A change applies to CDRs accepted from then on |
| Issuing entities | **Entities** | PlugSure's entity per country on fee invoices. Seeded as **placeholders** (red flag; documents say "not valid as a tax invoice") until the owner confirms them |

Members see their own side under Roaming → **PlugSure Hub**: summary, ledger (the eMSP disputes there), disputes
(the CPO accepts or rejects, the eMSP escalates or withdraws, both add notes), statements and fee invoices,
positions and payments, their commission terms, and the **bank details** printed on their payers' statements — ask
every member to set them before the first run.

Alerts: `hub.cdr_held`, `hub.dispute_opened` / `_updated` / `_escalated`, `hub.statement_issued`,
`hub.payment_recorded`, `hub.payment_overdue` (days 1, 7, 14), `hub.fee_invoice_overdue`. Platform alerts are stored in
the organisation of the member concerned and are all listed on the Hub overview.

## 9. Turning the hub off

`HUB_ENABLED=false` + restart: members get connection errors, the console hides the Hub menu, data stays in the
database. Tell members before (they will see their parties OFFLINE everywhere). Re-enabling restores everything.
