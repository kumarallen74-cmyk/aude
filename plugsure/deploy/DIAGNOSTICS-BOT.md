# Diagnostics bot (v1.44.0)

A first-line check of a charger, run from the console. It reads what the charger has reported, asks it for more, and
says what is wrong and whether someone has to go.

It is under **Maintain → Charger health**: open a charger, then the *Diagnostics* tab.

- Viewing runs needs `charge_point:read`.
- Running the bot needs `charge_point:command`.
- Opening a work order from a run needs `charge_point:write` or `payment:write`.

## What it does

Each run goes through these steps, recorded one by one:

1. **Connection.** Whether the charger is connected, its last heartbeat, and reboots and refused OCPP calls in the
   last 24 hours.
2. **Errors.** Its StatusNotification error codes over 7 days, explained from a built-in list of the OCPP 1.6 codes:
   what each means, what to do, and whether it usually needs a visit. Vendor codes are listed as they are.
3. **A fresh status** (when connected). It asks the charger (TriggerMessage) for a StatusNotification and a
   Heartbeat.
4. **Configuration** (when connected). It reads HeartbeatInterval, MeterValueSampleInterval, WebSocketPingInterval
   and ConnectionTimeOut, and flags any value outside its usual range.
5. **A soft reset** (only if *Allow a soft reset* was ticked, a connector is Faulted and nothing is charging). It then
   waits up to 90 seconds for the fault to clear.

The bot never changes the configuration and never does a hard reset.

## The verdict

| Verdict | Meaning |
| --- | --- |
| **healthy** | nothing to do |
| **fixed** | the soft reset cleared the fault |
| **needs attention** | something to change or watch, remotely |
| **needs a visit** | offline, a fault that needs hands on site, or one still there after the reset |
| **unreachable** | the charger did not answer |

The summary says what to do, in order. With *Open a work order* ticked, a corrective work order is opened with the
summary when someone has to act. *Open work order* on a finished run does the same afterwards.

One run at a time per charger. A second within 10 minutes of the first is refused while the first is still running.

## API

- `GET /v1/diagnostics-bot/charge-points/{cpId}` returns the last 20 runs.
- `POST /v1/diagnostics-bot/charge-points/{cpId}` takes `{allowReset, openWorkOrder}` and answers 202 with `{id}`.
- `GET /v1/diagnostics-bot/runs/{id}`
- `POST /v1/diagnostics-bot/runs/{id}/work-order`

Each run is audited (`diagnostics_bot.*`).
