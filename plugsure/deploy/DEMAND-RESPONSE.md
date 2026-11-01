# Grid demand response (v1.43.0)

When the grid operator (PLN) or an aggregator asks the operator's sites to cut or cap their power for a period, the load
manager holds charging to that request during the event. It also measures what it delivered, for the incentive claim.

It is set up under **Assets & energy → Grid events**. Viewing it needs `smartcharging:read`; changing it needs
`smartcharging:write`.

## Programmes

A programme covers some of the operator's sites and has an optional incentive per kWh. Events arrive in one of three ways:

- **Webhook:** the grid operator or aggregator posts events to PlugSure. Select **Key** on the programme to make a key (shown
  once; a new key stops the old one). Events are posted like this:

  ```
  POST /v1/dr/programs/<id>/events
  Authorization: Bearer pdr_…
  Content-Type: application/json

  { "id": "evt-2026-11-02-1", "start": "2026-11-02T17:00:00+07:00", "end": "2026-11-02T19:00:00+07:00", "limitKw": 120 }
  ```

  - **What to ask:** `limitKw` is the grid limit for the programme's sites together. It is split between them in
    proportion to their usual budget. Alternatively, `reducePct` (1 to 100) cuts each site by that share of what it would
    otherwise get. Use `durationMinutes` instead of `end` if that is easier. `siteIds` limits the event to some of the
    programme's sites.
  - **Updating and cancelling:** a repeat with the same `id` updates the event. `"status": "cancelled"` calls it off.
  - **Limits:** an event lasts at most 24 hours and starts at most 30 days ahead. At most 60 posts a minute per programme.
  - **Answers:** `201` for a new event, `200` for an update, `401` for a wrong key, `422` with the reason otherwise.
- **OpenADR 3:** PlugSure polls the grid operator's OpenADR 3 server (VTN) every 5 minutes, or at once with **Poll**. Enter
  the server's URL, the OAuth token URL, the programme's ID on the server, and the client ID and secret (the secret is
  kept encrypted).
  - **What is read:** an event's `intervalPeriod` (start and duration), and either an `IMPORT_CAPACITY_LIMIT` payload (kW,
    as a limit) or a `SIMPLE` level (1, 2 or 3, as a 30 %, 60 % or 100 % reduction).
  - **Connections:** outbound calls use https to public addresses only and never follow redirects.
- **By hand:** **Add event** on any programme, for a phone call or an e-mail from the control room.

Each new event raises a `grid.demand_response` alert, so route it to whoever watches the sites.

## During an event

The load manager caps the grid part of the site's budget to the event:

- PLN curtailment, the reserve and peak shaving still apply first.
- On-site solar and battery output is added on top, because it does not come from the grid.
- With several events at once, the strictest wins.

The operator can **Opt out** of an event. This is recorded with who and why, and a later repeat from the grid operator
does not undo it. The grid operator may then not pay the incentive.

## What is measured

On every pass (about every 30 seconds) the load manager records two things for each site:

- the power the chargers asked for, within the usual budget (the baseline);
- the power they were given.

**Grid events** shows the reduction in kWh and the average kW, and the incentive at the programme's rate. These are the
load manager's own figures, not a utility meter's. If the programme needs metered data, use the site's meter.

## Rollback

`db/rollback/110_down.sql` drops programmes, events and measurements; charging goes back to the usual budget.
