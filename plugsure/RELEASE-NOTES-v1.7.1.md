# PlugSure CSMS v1.7.1 — release notes

**Date:** 3 October 2026
**Base:** v1.7.0
**Type:** security fix (roaming through a hub)

**Upgrade:** drop-in. No migrations, no new settings, no dependency changes. Replace the
code and restart both processes (API and gateway). Rolling back to v1.7.0 is also a plain
code swap.

## Who is affected

Only operators with a roaming partner of kind **hub** (Roaming → partners, kind "Hub")
in state *connected*. A hub is an external roaming platform that connects many eMSPs and
CPOs through one OCPI connection.

- **No hub partner configured:** you are not affected. Peer connections (a partner of
  kind eMSP or CPO, one OCPI connection per company) were always scoped correctly and
  behave exactly as in v1.7.0.
- **A hub partner configured:** affected since roaming hubs were introduced (v1.3.0),
  including v1.5.0, v1.6.0 and v1.7.0. Upgrade, then check the hub's message log
  (Roaming → partner → messages) for requests about other parties' objects (see
  "What to check" below).

To find out, run as the database owner:

```sql
SELECT o.name AS operator, p.name AS partner, p.state, p.country_code, p.party_id
  FROM ocpi_partner p JOIN organisation o ON o.id = p.org_id
 WHERE p.kind = 'hub' AND p.state <> 'closed';
```

No rows: nothing to do beyond the upgrade.

## The issue

A hub connection is one partner row with one credentials token, but it stands for every
party behind the hub (the hub tells us who they are through HubClientInfo). The OCPI
handlers scoped what a request could read or change by the **connection**, not by the
**party** that sent it (OCPI 2.2.1 routing headers `OCPI-from-country-code` /
`OCPI-from-party-id`). So any party behind the same hub could act on another's objects:

| As | Could | Where (v1.7.0) |
|---|---|---|
| eMSP X behind the hub | pull **every** hub eMSP's sessions and charge records (driver data, energy, cost) | `store.ts` `listSessions` / `listCdrs` (`cs.ocpi_partner_id = $2`) |
| eMSP X | read and PATCH eMSP Y's token (e.g. invalidate Y's driver's card at our chargers) | `server.ts` tokens GET / PATCH (`t.partner_id !== partner.id`) |
| eMSP X | push a token under Y's party (PUT checked only that the hub may act for Y) | `server.ts` tokens PUT |
| eMSP X | stop Y's driver's session | `commands.ts` STOP_SESSION (`cs.ocpi_partner_id = $3`) |
| eMSP X | unlock the connector of Y's driver mid-charge | `commands.ts` UNLOCK_CONNECTOR (`latest.ocpi_partner_id`) |
| eMSP X | cancel or replace Y's reservation (same reservation id) | `commands.ts` CANCEL_RESERVATION / RESERVE_NOW |
| eMSP X | send START_SESSION / RESERVE_NOW with Y's token, rewriting Y's stored token on the way | `commands.ts` (token checked only against the hub) |
| eMSP X | set, read or lift a charging limit on Y's driver's session | `profiles.ts` `activeSession` (`cs.ocpi_partner_id = $3`) |
| CPO A behind the hub | publish or overwrite locations, tariffs, sessions and charge records under CPO B's party, and read B's | `emsp.ts` `receiveLocation` / `receiveTariff` / `receiveSession` / `receiveCdr`, `getRemote*` |
| CPO A | post the result of a command we sent to CPO B | `emsp.ts` `receiveCommandResult` |

Also, the results of a charging-profile request were addressed (`OCPI-to`) to the hub
itself, not to the eMSP that asked, so a hub could not route them back; and a command
from a hub without `OCPI-from` headers had its result addressed to the hub.

Exploiting it needs a party behind a connected hub (or the hub itself): it is not
reachable from the internet at large, nor by a peer partner.

## The fix

For a partner of kind **hub**, every functional module now:

1. **requires** `OCPI-from-country-code` and `OCPI-from-party-id`: missing or malformed →
   HTTP 400, OCPI status **2001**. Locations and tariffs that we publish (GET) are the
   exception: a hub may pull them as itself, as before, and if it does send the headers
   they are checked.
2. **checks** the from-party against the hub's announced clients (HubClientInfo,
   CONNECTED or OFFLINE) **in the module's role**: EMSP for sessions, CDRs, tokens,
   commands and charging profiles; CPO for the eMSP-side endpoints (`/emsp/…`). Unknown,
   suspended, planned or wrong-role party → HTTP 403, OCPI status **2000**.
3. **scopes** to that party's objects:
   - sessions and CDRs pulled: only those whose token belongs to the from-party;
   - tokens: GET / PATCH only of the from-party's tokens (another's answers 404 / 2004),
     PUT only under its own party (403);
   - STOP_SESSION, UNLOCK_CONNECTOR, CANCEL_RESERVATION: only for the from-party's
     drivers (`UNKNOWN_SESSION` / `REJECTED` otherwise); START_SESSION and RESERVE_NOW
     only with the from-party's own token; a reservation id another party behind the
     hub already uses is refused, not replaced;
   - charging profiles (PUT / GET / DELETE): only on the from-party's drivers' sessions
     (`UNKNOWN_SESSION` otherwise);
   - eMSP side: locations, tariffs and sessions only under the URL party = from-party,
     CDRs only with body party = from-party (403 otherwise); GETs of what was received
     only for the from-party (404); a command result only from the party the command was
     addressed to (we now store that party with the command; commands sent before
     v1.7.1, or addressed to the hub itself, accept any CPO the hub announced, as
     before).
4. **addresses** results back to the from-party: command results and charging-profile
   results go out with `OCPI-to-*` = the eMSP that asked (not the hub). Session and CDR
   pushes were already addressed to the token's party; they, and location / tariff
   pushes, now also carry `OCPI-from-*` = the party the object is published under (its
   country's party; the home party for a single-country operator, so unchanged there).

Peer (non-hub) connections: unchanged. They are scoped by their connection as before and
need no routing headers.

**Hubs must send `OCPI-from-*` on functional requests** (OCPI 2.2.1 transport and format,
"Message Routing": SHALL). Configuration modules (versions, credentials, hubclientinfo)
are not routed and need none. A hub that does not send them will see its requests
refused with 2001 after the upgrade; ask the hub operator to fix it.

## What to check after upgrading (hub partners only)

- Roaming → the hub partner → messages: any 400 (2001) or 403 answers right after the
  upgrade mean the hub is not sending `OCPI-from-*`, or names parties it has not
  announced. Refresh its client list (Roaming → partner → hub clients → refresh) and
  contact the hub operator.
- Before the upgrade, look in the hub's message log (`ocpi_message`, direction `in`) for
  GET `…/sessions`, `…/cdrs`, `…/tokens/…`, POST `…/commands/STOP_SESSION` and
  `…/chargingprofiles/…` calls. The log does not record headers, so it cannot tell which
  party sent a call; a hub with only one eMSP behind it could not have exposed anything.

## Tests

- `src/ocpi/hub-isolation.test.ts` (new, 19 tests): one per hole above through the real
  OCPI routes (Fastify inject) against the test database, plus peer regressions. All
  fail on v1.7.0 except the peer and configuration-module cases.
- `tools/e2e/ocpi-profiles-e2e.mts`: hub isolation through the running stack — a hub
  request without `OCPI-from` (2001), ABC pushing a token for DEF (403), ABC's driver
  charging, DEF unable to see, stop or limit ABC's session or read its token, an
  unannounced party (403), and ABC's result addressed back to ABC.
- Full unit suite 1224/1224; the CI end-to-end job and the `ocpi`, `ocpi-emsp`,
  `ocpi-auth` and `ocpi-profiles` suites pass.
