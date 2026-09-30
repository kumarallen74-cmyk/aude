# Virtual charge point simulator

An OCPP 1.6J charge point that misbehaves on demand.

A bench unit will not reproduce, when you ask it to, the things that actually
break a CSMS in Indonesia: a 4G backhaul that drops mid-session, a charger that
boots believing it is 1970, a three-phase meter that reports per phase, a whole
kampung of chargers reconnecting after a power cut. Every one of those is a flag
here. And Autel bench units carry a documented risk that switching to a
third-party OCPP backend may be irreversible — so the simulator is where you
find these out, not the hardware.

| file | what it is |
| --- | --- |
| `charge-point.ts` | `VirtualChargePoint` — the reusable client. Import it in tests. |
| `autel-sim.ts` | CLI: one charger, plus the named scenarios. `npm run sim` |
| `fleet.ts` | CLI: N chargers at once, for load and reconnect storms. |
| `options.ts` | shared flag parsing. |

Run everything with `npx tsx`. Nothing needs building.

```bash
npx tsx tools/simulator/autel-sim.ts --help
npx tsx tools/simulator/fleet.ts --help
```

Point it at a gateway with `--url` (default `ws://127.0.0.1:9220/ocpp`); the
charge point identity is appended as the final path segment. Scenarios also read
the REST API for their assertions — `--api` (default `http://127.0.0.1:9200`).

---

## Scenarios

`--scenario <name>` runs an end-to-end script and prints a PASS/FAIL summary.
Exit code is non-zero if a check that *should* hold did not.

Three row kinds appear in the summary:

- **PASS / FAIL** — behaviour that must hold. A FAIL is a regression.
- **DEFECT** — a known, unfixed CSMS bug that this run *successfully reproduced*.
  It flips to **FIXED** when the defect goes away, which is your signal to turn
  the row into a `check`.
- **INFO** — measurements, no judgement.

```bash
npx tsx tools/simulator/autel-sim.ts --scenario offline-replay \
  --url ws://127.0.0.1:9220/ocpp --api http://127.0.0.1:9200
```

### `happy`
Connect, negotiate, boot, absorb the provisioning burst, run one full session,
then verify against the API that the CSMS billed exactly the energy delivered.
The virtual charger reports **factory-default** configuration on
`GetConfiguration`, so provisioning has real work to do and really does write
~13 keys.

### `offline-replay`
The headline capability. Starts a session online, cuts the backhaul a quarter of
the way in, keeps charging and metering with the link down, finishes the session
offline — `StopTransaction` included — then restores the link and replays.

Every queued message carries the timestamp at which it *occurred*, not the time
it was finally sent, so the checks prove the CSMS bills on the charger's clock
and not on arrival time.

```bash
# ordered replay: everything should reconcile
npx tsx tools/simulator/autel-sim.ts --scenario offline-replay

# deliberately break the ordering, to test idempotency
npx tsx tools/simulator/autel-sim.ts --scenario offline-replay --replay-shuffle
npx tsx tools/simulator/autel-sim.ts --scenario offline-replay --replay-duplicate
```

`--replay-shuffle` is random — a single clean run proves nothing. Run it a few
times.

### `duplicate-start`
Sends the exact retry a charger performs when the `CALLRESULT` for its
`StartTransaction` never arrives: byte-identical payload, same `meterStart`, same
timestamp. Reproduces the duplicate-session defect.

### `reconnect-storm`
Drops one charger `--rounds` times (default 8) and reports the observed backoff
delays, then points a second charger at a dead port to show the delay doubling
and the `--backoff-attempts` give-up path. For a *fleet*-wide storm use
`fleet.ts --storm`.

### `bad-clock`
Boots with a large clock offset and runs a session.
`--clock-skew -20y` simulates a unit with a dead RTC and no NTP.

### `meter-rollover`
Starts the energy register just below a `--rollover` width and runs a session
across the wrap.

### `hostile`
50% of inbound CSMS calls answered `CALLERROR`, four kinds of malformed frame, an
action the CSMS has never heard of, and a well-formed call with a garbage
payload — then checks the connection is still usable.

---

## `VirtualChargePoint` as a library

```ts
import { VirtualChargePoint } from './tools/simulator/charge-point.js';

const cp = new VirtualChargePoint({
  id: 'AUTEL-AC22-SMB-001',
  url: 'ws://127.0.0.1:9220/ocpp',
  reconnect: true,
  backoffBaseMs: 1_000,
});

cp.on('state', (s) => console.log(s.from, '->', s.to, s.delayMs ?? ''));
cp.on('queued', (q) => console.log('offline queue depth', q.depth));
cp.on('replayed', (x) => console.log('replayed', x.action, 'from', x.occurredAt));

await cp.start();
await cp.runSession({ kwh: 8 });
await cp.stop();
```

Useful events: `state`, `open`, `boot`, `call` (CS→CP), `frame`, `limit`,
`transaction-started`, `transaction-stopped`, `meter`, `queued`, `replay-start`,
`replayed`, `replay-done`, `fault`, `reconnect-scheduled`, `gave-up`,
`upgrade-rejected`, `stale-reply`, `error`.

Useful methods: `start()`, `stop()`, `runSession()`, `duplicateStart()`,
`dropConnection()`, `sendMalformed()`, `replayOfflineQueue()`, `call()`.
Useful state: `state`, `stats`, `meterWh`, `transactionId`, `pendingOffline`,
`inboundCalls`.

`inboundCalls` exists because the gateway's provisioning burst starts the instant
`BootNotification.conf` is written — before any caller of `start()` could have
subscribed to an event. Read the array; don't race a listener.

---

## Behaviour worth knowing

**Reconnect.** Exponential backoff from `--backoff-base`, doubling to
`--backoff-max`, multiplied by `1 ± --jitter`. Without jitter a site-wide power
cut brings every charger back on the same tick; `--jitter 0` is the pathological
case, worth testing on purpose.

**Store and forward.** `StartTransaction`, `MeterValues` and `StopTransaction`
are never dropped when the link is down — they queue with their occurrence
timestamp and replay in order on reconnect. `StatusNotification` and `Heartbeat`
are *not* transactional and are simply lost, which is correct: the CSMS recovers
those with `TriggerMessage`. A session that starts while offline runs without a
`transactionId` until its replayed `StartTransaction` returns one, at which point
every still-queued message for that session is stamped with it.

**Charging model.** Obeys `SetChargingProfile` in both units — `A` is per phase,
so the ceiling is `limit x numberPhases x voltage`; `W` is the whole station.
Tapers over the last 20% of the session to 15% of the ceiling, like a real
battery moving from constant current to constant voltage. Reports a monotonic
`Energy.Active.Import.Register` plus `Power.Active.Import`, `Current.Import`,
`Voltage` and `SoC`.

**Provisioning.** `GetConfiguration` returns *factory* defaults
(`HeartbeatInterval` 86400, metering off, local auth list disabled), so the CSMS
must diff and write. `ChangeConfiguration` writes stick for the life of the
process, including across reconnects — so re-provisioning after a reconnect
correctly does nothing.

**Heartbeats** follow the `interval` in `BootNotification.conf`, and re-follow it
when the CSMS changes `HeartbeatInterval` via `ChangeConfiguration`.

**One outstanding call.** Outbound CALLs are queued, never pipelined. Replies to
an unknown or stale `uniqueId` are ignored and emit `stale-reply`.

**Unsupported actions** get a proper `CALLERROR NotImplemented`. Everything the
gateway can send is answered: `GetConfiguration`, `ChangeConfiguration`,
`TriggerMessage`, `RemoteStartTransaction`, `RemoteStopTransaction`,
`SetChargingProfile`, `ClearChargingProfile`, `GetCompositeSchedule`,
`ClearCache`, `Reset`, `UnlockConnector`, `ChangeAvailability`,
`GetLocalListVersion`, `SendLocalList`, `DataTransfer`.

---

## Fault injection

Each is independent; combine freely.

| flag | what the charger does |
| --- | --- |
| `--reject-metervalues` | answers `Rejected` to `ChangeConfiguration MeterValuesSampledData` — the documented Autel quirk. A CSMS that treats this as fatal strands the fleet. |
| `--reject-key <k1,k2>` | same, for any keys you name |
| `--callerror-rate <0..1>` | answers that fraction of CSMS calls with `CALLERROR InternalError` |
| `--silent` | accepts the socket and never speaks. The CSMS will show it online. |
| `--clock-skew <-20y>` | offsets every timestamp it emits |
| `--omit-meterstop` | leaves `meterStop` out of `StopTransaction` |
| `--txdata-skew <Wh>` | makes `transactionData` disagree with `meterStop` |
| `--rollover <Wh>` | wraps the energy register at that width |
| `--per-phase` | reports the energy register per phase (L1/L2/L3) instead of as one total |
| `--offer a,b` | controls the subprotocols offered on the upgrade |

Two more are methods rather than flags, because they need to fire at a chosen
moment: `cp.dropConnection()` and `cp.sendMalformed(kind)` (`truncated-json`,
`not-array`, `short-array`, `bad-type`). The `offline-replay` and `hostile`
scenarios drive them.

### `--per-phase`

Real 3-phase AC hardware publishes one `Energy.Active.Import.Register` **per
phase**, in `MeterValues` and in `StopTransaction.transactionData` alike. A CSMS
that takes the first Energy sample it finds and ignores the `phase` field reads a
third of the energy. Invisible on any single-phase bench unit.

```bash
npx tsx tools/simulator/autel-sim.ts --per-phase --session --kwh 6 --speed 20
# watch /v1/sessions mid-session: energy_wh sits at 0 while the charger has
# delivered 1.5 kWh, because L1's register reads below meter_start.
```

---

## Transport

```bash
# Basic auth on the upgrade: Authorization: Basic base64(identity:key)
npx tsx tools/simulator/autel-sim.ts --id AUTEL-AC22-SMB-001 --auth-key sekret123

# TLS. --insecure accepts a self-signed cert; local testing only.
npx tsx tools/simulator/autel-sim.ts --wss --insecure --url wss://127.0.0.1:9220/ocpp

# Dual-stack negotiation
npx tsx tools/simulator/autel-sim.ts --offer ocpp1.6,ocpp2.0.1
```

`--wss` also upgrades a `ws://` base URL in place, so you can flip one flag
rather than editing the URL.

---

## Fleet

```bash
# 20 chargers, staggered like a site powering up
npx tsx tools/simulator/fleet.ts --count 20

# one session each
npx tsx tools/simulator/fleet.ts --count 20 --sessions --kwh 4 --speed 120

# drop the whole fleet three times and watch it come back
npx tsx tools/simulator/fleet.ts --count 40 --storm 3 --quiet

# the thundering herd: no jitter, everyone retries on the same tick
npx tsx tools/simulator/fleet.ts --count 40 --storm 3 --jitter 0
```

Reports connections, reconnects, frames in/out and per-second, calls in each
direction, CALLERRORs, sessions and energy, offline queue depth and replays, and
the min/p50/max backoff delay across the fleet. Exits non-zero if any charger is
not online at the end.

---

## Legacy flags

Everything the previous simulator accepted still works and still means the same
thing: `--id`, `--connectors`, `--dc`, `--session`, `--idtag`, `--kwh`,
`--speed`, `--url`, `--reject-metervalues`.

```bash
npx tsx tools/simulator/autel-sim.ts --id AUTEL-AC22-SMB-001 --connectors 1
npx tsx tools/simulator/autel-sim.ts --id AUTEL-DC60-SMB-002 --connectors 2 --dc
npm run sim -- --id AUTEL-AC22-SMB-001 --session --kwh 12
```

Without `--session` the charger connects and stays up, answering commands — which
is what you want when driving it from the console or from
`POST /v1/charge-points/:identity/commands/:command`.

## API credential

The scenarios that verify what the CSMS actually BILLED (`happy`, `offline-replay`,
`meter-rollover`, `bad-clock`, `hostile`) read `GET /v1/sessions`, which requires a
bearer token. Without one they now FAIL rather than silently reporting `INFO — API
not reachable`, which is what they used to do — so the headline assertion of the
`happy` scenario ("the CSMS billed exactly the energy we delivered") had not run in
a long time.

```bash
export PLUGSURE_KEY=psk_...        # printed once by `npm run seed`
npx tsx tools/simulator/autel-sim.ts --scenario happy
# or
npx tsx tools/simulator/autel-sim.ts --scenario happy --api-key psk_...
```
