#!/usr/bin/env -S npx tsx
import { VirtualChargePoint, sleep, type StateEvent, type VcpOptions } from './charge-point.js';
import { COMMON_FLAG_HELP, has, num, optionsFromArgs, parseArgs, str, type Args } from './options.js';

/**
 * Virtual Autel-style charge point (OCPP 1.6J) — CLI.
 *
 * Test with simulators before you touch hardware. A virtual fleet gets you
 * reconnect storms, offline replay and failure paths that a bench unit will not
 * reproduce on demand — and Autel bench units carry a documented risk that
 * switching to a third-party OCPP backend may be irreversible.
 *
 * Usage:
 *   npx tsx tools/simulator/autel-sim.ts --id AUTEL-AC22-SMB-001 --session
 *   npx tsx tools/simulator/autel-sim.ts --scenario offline-replay
 *   npx tsx tools/simulator/autel-sim.ts --help
 *
 * Every scenario prints a PASS/FAIL summary and exits non-zero if a check that
 * SHOULD hold does not. Checks that document a known, unfixed defect are marked
 * DEFECT and do not fail the run — they fail when the defect disappears.
 */

const SCENARIOS = [
  'happy',
  'offline-replay',
  'duplicate-start',
  'reconnect-storm',
  'bad-clock',
  'meter-rollover',
  'hostile',
] as const;
type ScenarioName = (typeof SCENARIOS)[number];

const args = parseArgs(process.argv.slice(2));

if (has(args, 'help') || has(args, 'h')) {
  printHelp();
  process.exit(0);
}

const API = (str(args, 'api') ?? 'http://127.0.0.1:9200').replace(/\/+$/, '');
/**
 * Bearer token for the API-backed assertions. Without it every one of them
 * degrades to "not reachable" and the suite reports PASS while checking nothing.
 */
const API_KEY = str(args, 'api-key') ?? process.env.PLUGSURE_KEY ?? '';
const base = optionsFromArgs(args);

async function main() {
  const scenario = str(args, 'scenario');
  if (scenario) {
    if (!SCENARIOS.includes(scenario as ScenarioName)) {
      console.error(`unknown scenario: ${scenario}\nknown: ${SCENARIOS.join(', ')}`);
      process.exit(2);
    }
    const code = await runScenario(scenario as ScenarioName);
    process.exit(code);
  }

  // Legacy mode: connect, optionally run one session, otherwise stay up.
  const cp = make({});
  wire(cp);
  await cp.start();
  if (has(args, 'session')) {
    await settle(cp);
    await cp.runSession();
    await sleep(1_000);
    await cp.stop();
    process.exit(0);
  }
}

// ------------------------------------------------------------------ factory

function make(over: Partial<VcpOptions>): VirtualChargePoint {
  return new VirtualChargePoint({ ...base, ...over });
}

/** Human-readable running commentary, shared by every mode. */
function wire(cp: VirtualChargePoint, quiet = false) {
  const tag = `[${cp.opts.id}]`;
  cp.on('state', (s: StateEvent) => {
    const extra = [
      s.attempt ? `attempt=${s.attempt}` : '',
      s.delayMs ? `in ${s.delayMs}ms` : '',
      s.reason ?? '',
    ]
      .filter(Boolean)
      .join(' ');
    console.log(`${tag} ${s.from} -> ${s.to} ${extra}`.trimEnd());
  });
  cp.on('boot', (b: any) => console.log(`${tag} boot ${b?.status}, heartbeat every ${b?.interval}s`));
  cp.on('limit', (l: any) => console.log(`${tag} charging limit -> ${(l.limitW / 1000).toFixed(1)} kW (${l.source})`));
  cp.on('transaction-started', (t: any) => console.log(`${tag} transaction ${t.transactionId ?? '(offline)'} started at ${t.timestamp}`));
  cp.on('transaction-stopped', (t: any) =>
    console.log(`${tag} transaction ${t.transactionId ?? '(offline)'} stopped, ${(t.deliveredWh / 1000).toFixed(2)} kWh`),
  );
  cp.on('queued', (q: any) => console.log(`${tag} OFFLINE queued ${q.action} @ ${q.occurredAt} (depth ${q.depth})`));
  cp.on('replay-start', (r: any) =>
    console.log(`${tag} REPLAY ${r.count} queued message(s), oldest ${r.oldest}${r.shuffled ? ' [shuffled]' : ''}${r.duplicated ? ' [duplicated]' : ''}`),
  );
  cp.on('replayed', (r: any) => console.log(`${tag}   replayed ${r.action} @ ${r.occurredAt}`));
  cp.on('replay-done', (r: any) => console.log(`${tag} REPLAY done: ${r.sent} sent, ${r.remaining} still queued`));
  cp.on('fault', (f: any) => console.log(`${tag} FAULT ${f.kind} ${f.key ?? f.detail ?? f.action ?? f.reason ?? ''}`));
  cp.on('error', (e: Error) => !quiet && console.log(`${tag} error: ${e.message}`));
  if (!quiet) {
    cp.on('meter', (m: any) =>
      process.stdout.write(
        `${tag}   ${(m.deliveredWh / 1000).toFixed(2)} kWh @ ${(m.powerW / 1000).toFixed(1)} kW  register ${Math.round(m.registerWh)} Wh  ${m.online ? 'online' : 'OFFLINE'}   \r`,
      ),
    );
    cp.on('transaction-stopped', () => process.stdout.write('\n'));
  }
}

/**
 * Wait for the gateway's provisioning burst to go quiet, and return every
 * CS->CP action it sent. Reads the charge point's own inbound log, because
 * provisioning begins before start() has even resolved.
 */
async function settle(cp: VirtualChargePoint, quietMs = 900, maxMs = 12_000): Promise<string[]> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const last = cp.inboundCalls.at(-1)?.at;
    if (last === undefined) {
      if (Date.now() - t0 > quietMs * 3) break; // the gateway never said anything
    } else if (Date.now() - last >= quietMs) {
      break;
    }
    await sleep(100);
  }
  return cp.inboundCalls.map((c) => c.action);
}

/** A session the CSMS considers finished, whatever it calls that internally. */
const CLOSED_STATES = ['ended', 'rated', 'billed', 'invoiced'];

// ------------------------------------------------------------------ report

type Kind = 'check' | 'defect' | 'info';

class Report {
  private rows: { kind: Kind; ok: boolean; label: string; detail: string }[] = [];
  constructor(readonly name: string) {
    console.log(`\n=== scenario: ${name} ===\n`);
  }
  check(ok: boolean, label: string, detail = '') {
    this.rows.push({ kind: 'check', ok, label, detail });
  }
  /** A known, unfixed defect. `reproduced` true means the scenario did its job. */
  defect(reproduced: boolean, label: string, detail = '') {
    this.rows.push({ kind: 'defect', ok: reproduced, label, detail });
  }
  info(label: string, detail = '') {
    this.rows.push({ kind: 'info', ok: true, label, detail });
  }
  finish(): number {
    console.log(`\n--- ${this.name} summary ---`);
    let failed = 0;
    for (const r of this.rows) {
      let mark: string;
      if (r.kind === 'info') mark = 'INFO  ';
      else if (r.kind === 'defect') mark = r.ok ? 'DEFECT' : 'FIXED ';
      else {
        mark = r.ok ? 'PASS  ' : 'FAIL  ';
        if (!r.ok) failed++;
      }
      console.log(`${mark} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
    }
    const verdict = failed === 0 ? 'PASS' : `FAIL (${failed})`;
    console.log(`--- ${this.name}: ${verdict} ---\n`);
    return failed === 0 ? 0 : 1;
  }
}

// ------------------------------------------------------------------ api probe

/**
 * Read from the CSMS API.
 *
 * The API grew bearer authentication and this did not, so every API-backed
 * assertion in every scenario silently degraded to `INFO — API not reachable`.
 * The headline check of the `happy` scenario — "the CSMS billed exactly the
 * energy we delivered" — had not actually run in a long time. A 401 is now
 * distinguished from an unreachable host and reported as a failure, because a
 * check that quietly stops checking is worse than no check.
 */
class ApiUnauthorised extends Error {}

async function api<T = any>(path: string): Promise<T | null> {
  const key = API_KEY;
  try {
    const res = await fetch(`${API}${path}`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
    if (res.status === 401 || res.status === 403) {
      throw new ApiUnauthorised(
        key
          ? `the API rejected the supplied key (${res.status})`
          : 'the API requires a bearer token — pass --api-key or set PLUGSURE_KEY',
      );
    }
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof ApiUnauthorised) throw e;
    return null;
  }
}

interface ApiSession {
  id: string;
  ocpp_transaction_id: string | null;
  state: string;
  energy_wh: number;
  started_at: string;
  ended_at: string | null;
  meter_start_wh: number;
  meter_stop_wh: number | null;
  ocpp_identity?: string;
}

/**
 * /v1/sessions is a summary view and omits ocpp_transaction_id, so pull the
 * detail record for each session belonging to this identity.
 */
async function sessionsFor(identity: string): Promise<ApiSession[]> {
  const rows = await api<any[]>(`/v1/sessions?limit=200`);
  if (!rows) return [];
  const mine = rows.filter((r) => (r.ocpp_identity ?? '') === identity);
  const out: ApiSession[] = [];
  for (const row of mine) {
    const detail = await api<any>(`/v1/sessions/${row.id}`);
    if (detail) out.push({ ...row, ...detail });
  }
  return out;
}

// ------------------------------------------------------------------ scenarios

async function runScenario(name: ScenarioName): Promise<number> {
  switch (name) {
    case 'happy':
      return scenarioHappy();
    case 'offline-replay':
      return scenarioOfflineReplay();
    case 'duplicate-start':
      return scenarioDuplicateStart();
    case 'reconnect-storm':
      return scenarioReconnectStorm();
    case 'bad-clock':
      return scenarioBadClock();
    case 'meter-rollover':
      return scenarioMeterRollover();
    case 'hostile':
      return scenarioHostile();
  }
}

// --- happy ---------------------------------------------------------------

async function scenarioHappy(): Promise<number> {
  const r = new Report('happy');
  const id = str(args, 'id') ?? `SIM-HAPPY-${stamp()}`;
  const cp = make({ id, targetKwh: num(args, 'kwh') ?? 4 });
  wire(cp);

  let booted = false;
  cp.on('boot', () => (booted = true));
  await cp.start();
  r.check(booted, 'BootNotification accepted');
  r.check(cp.state === 'booted', 'reached booted state', `state=${cp.state}`);

  const provisioning = await settle(cp);
  r.check(provisioning.includes('GetConfiguration'), 'CSMS ran provisioning (GetConfiguration)');
  r.check(
    provisioning.includes('ChangeConfiguration'),
    'CSMS pushed desired configuration',
    `${provisioning.filter((a) => a === 'ChangeConfiguration').length} keys`,
  );
  r.info('CSMS -> CP calls during provisioning', unique(provisioning).join(', '));

  const before = cp.stats.framesOut;
  const s = await cp.runSession();
  r.check(s.transactionId != null, 'CSMS assigned a transactionId', String(s.transactionId));
  r.check(s.deliveredWh > 0, 'energy delivered', `${(s.deliveredWh / 1000).toFixed(2)} kWh`);
  r.check(s.queued === 0, 'nothing left in the offline queue');
  r.info('frames sent during the session', String(cp.stats.framesOut - before));

  await sleep(600);
  const rows = await sessionsFor(id);
  const mine = rows.find((x) => String(x.ocpp_transaction_id) === String(s.transactionId));
  if (mine) {
    r.check(CLOSED_STATES.includes(mine.state), 'CSMS closed the session', `state=${mine.state}`);
    r.check(
      Math.abs(mine.energy_wh - s.deliveredWh) < 60,
      'CSMS billed the energy we delivered',
      `csms=${mine.energy_wh} Wh, charger=${Math.round(s.deliveredWh)} Wh`,
    );
  } else {
    r.check(
      false,
      'the CSMS API could not confirm this session',
      API_KEY
        ? `${API}/v1/sessions returned nothing for this transaction`
        : `no API credential — pass --api-key or set PLUGSURE_KEY, or these checks verify nothing`,
    );
  }

  await cp.stop();
  return r.finish();
}

// --- offline-replay ------------------------------------------------------

async function scenarioOfflineReplay(): Promise<number> {
  const r = new Report('offline-replay');
  const id = str(args, 'id') ?? `SIM-OFFLINE-${stamp()}`;
  // reconnect:false so the SCENARIO owns the outage window — otherwise the
  // backoff brings the link back after a second and there is nothing to replay.
  const cp = make({
    id,
    targetKwh: num(args, 'kwh') ?? 6,
    speed: num(args, 'speed') ?? 120,
    reconnect: false,
  });
  wire(cp);

  const queued: string[] = [];
  const replayed: string[] = [];
  let replayStart: any = null;
  let replayWallClock = 0;
  cp.on('queued', (q: any) => queued.push(`${q.action}@${q.occurredAt}`));
  cp.on('replayed', (x: any) => replayed.push(`${x.action}@${x.occurredAt}`));
  cp.on('replay-start', (x: any) => {
    replayStart = x;
    replayWallClock = Date.now();
  });

  await cp.start();
  await settle(cp);

  // Cut the backhaul a quarter of the way in and leave it down for the rest of
  // the session — Start online, everything after it offline.
  const cutAtWh = ((num(args, 'kwh') ?? 6) * 1000) / 4;
  let dropped = false;
  let deliveredAtDrop = 0;
  cp.on('meter', (m: any) => {
    if (!dropped && m.deliveredWh > cutAtWh) {
      dropped = true;
      deliveredAtDrop = m.deliveredWh;
      console.log(`\n[${id}] --- cutting the backhaul mid-session ---`);
      cp.dropConnection('simulated 4G outage');
    }
  });

  const s = await cp.runSession();
  const queuedAtEnd = cp.pendingOffline.length;
  r.check(dropped, 'connection was cut mid-session', `after ${(deliveredAtDrop / 1000).toFixed(2)} kWh`);
  r.check(cp.state !== 'booted', 'charger genuinely stayed offline', `state=${cp.state}`);
  r.check(queued.length > 0, 'messages were queued while offline', `${queued.length} queued`);
  r.check(
    queued.filter((q) => q.startsWith('MeterValues')).length > 1,
    'MeterValues kept accumulating while offline',
    `${queued.filter((q) => q.startsWith('MeterValues')).length} samples`,
  );
  r.check(
    queued.some((q) => q.startsWith('StopTransaction')),
    'StopTransaction was preserved rather than lost',
  );
  r.check(replayed.length === 0, 'nothing was replayed while still offline');
  r.info('offline queue depth at session end', String(queuedAtEnd));
  r.info(
    'queue contents',
    queued.map((q) => q.split('@')[0]).join(', '),
  );

  // Backhaul comes back.
  console.log(`\n[${id}] --- backhaul restored, reconnecting ---`);
  await sleep(400);
  await cp.start();
  for (let i = 0; i < 80 && (cp.pendingOffline.length > 0 || replayed.length < queuedAtEnd); i++) await sleep(150);
  await sleep(400);

  r.check(cp.state === 'booted', 'charger reconnected', `state=${cp.state}`);
  r.check(replayed.length >= queuedAtEnd, 'the whole offline queue was replayed', `${replayed.length}/${queuedAtEnd}`);
  r.check(cp.pendingOffline.length === 0, 'offline queue drained', `${cp.pendingOffline.length} left`);
  const inOrder = replayed.map((x) => x.split('@')[1] ?? '').every((t, i, a) => i === 0 || t >= a[i - 1]!);
  if (cp.opts.replayShuffle) {
    r.info('replay was deliberately shuffled', inOrder ? 'still landed in order by chance' : 'out of order, as requested');
  } else {
    r.check(inOrder, 'replayed in occurrence order, oldest first');
  }
  if (cp.opts.replayDuplicate) {
    r.info('every queued message was replayed twice', `${replayed.length} sends for ${queuedAtEnd} events`);
  }
  if (replayStart) {
    const lagMs = replayWallClock - new Date(String(replayStart.oldest)).getTime();
    r.check(lagMs > 1_000, 'replayed messages carry timestamps from BEFORE the reconnect', `oldest is ${(lagMs / 1000).toFixed(1)}s stale`);
    r.info('oldest replayed timestamp', String(replayStart.oldest));
    r.info(
      'replay order',
      replayed.slice(0, 3).join('  ') + (replayed.length > 3 ? `  ... (${replayed.length} total)` : ''),
    );
  }
  r.info('delivered before the cut', `${(deliveredAtDrop / 1000).toFixed(2)} kWh`);
  r.info('delivered in total', `${(s.deliveredWh / 1000).toFixed(2)} kWh`);

  await sleep(900);
  const rows = await sessionsFor(id);
  const mine = rows.find((x) => String(x.ocpp_transaction_id) === String(s.transactionId));
  if (mine) {
    r.check(CLOSED_STATES.includes(mine.state), 'CSMS closed the session after replay', `state=${mine.state}`);
    const billedCorrectly = Math.abs(mine.energy_wh - s.deliveredWh) < 120;
    const detail = `csms=${mine.energy_wh} Wh, charger=${Math.round(s.deliveredWh)} Wh`;
    if (cp.opts.replayShuffle || cp.opts.replayDuplicate) {
      // With the disorder options on, a mismatch is the POINT of the run: it
      // says the CSMS depends on arrival order, not on charger-supplied facts.
      // A shuffle is random, so a clean total on one run proves nothing — rerun it.
      if (billedCorrectly) r.info('this shuffle happened to bill correctly (rerun — the order is random)', detail);
      else r.defect(true, 'billing depends on replay ORDER, not on the charger timestamps', detail);
    } else {
      r.check(billedCorrectly, 'CSMS billed the FULL session, including the offline stretch', detail);
    }
    const span = mine.ended_at ? new Date(mine.ended_at).getTime() - new Date(mine.started_at).getTime() : 0;
    r.info('CSMS session span', `${(span / 1000).toFixed(1)}s (charger timestamps, not arrival times)`);
    if (mine.ended_at) {
      r.check(
        new Date(mine.ended_at).getTime() < replayWallClock,
        'CSMS billed on the charger clock, not on when the replay arrived',
        `ended_at=${mine.ended_at}, replayed at ${new Date(replayWallClock).toISOString()}`,
      );
    }
  } else {
    r.check(
      false,
      'the CSMS API could not confirm this session',
      API_KEY
        ? `${API}/v1/sessions returned nothing for this transaction`
        : `no API credential — pass --api-key or set PLUGSURE_KEY, or these checks verify nothing`,
    );
  }

  await cp.stop();
  return r.finish();
}

// --- duplicate-start -----------------------------------------------------

async function scenarioDuplicateStart(): Promise<number> {
  const r = new Report('duplicate-start');
  const id = str(args, 'id') ?? `SIM-DUP-${stamp()}`;
  const cp = make({ id });
  wire(cp, true);

  await cp.start();
  await settle(cp);

  const idTag = cp.opts.idTag;
  const timestamp = cp.now();
  const meterStart = Math.round(cp.meterWh);
  const payload = { connectorId: 1, idTag, meterStart, timestamp };

  await cp.call('Authorize', { idTag });
  const first = await cp.call('StartTransaction', payload);
  console.log(`[${id}] first  StartTransaction -> transactionId ${first?.transactionId}`);

  // The retry a charger performs when the CALLRESULT never arrives: byte for
  // byte the same request, same occurrence timestamp, same meterStart.
  const second = await cp.duplicateStart(payload);
  console.log(`[${id}] retry  StartTransaction -> transactionId ${second?.transactionId}`);

  r.check(first?.transactionId != null, 'first StartTransaction accepted', String(first?.transactionId));
  r.check(second?.transactionId != null, 'duplicate StartTransaction answered', String(second?.transactionId));

  const sameId = String(first?.transactionId) === String(second?.transactionId);
  r.defect(
    !sameId,
    'CSMS mints a NEW transactionId for an identical retry',
    `first=${first?.transactionId} retry=${second?.transactionId}`,
  );

  await sleep(700);
  const rows = await sessionsFor(id);
  const forThisCp = rows.filter(
    (x) => String(x.ocpp_transaction_id) === String(first?.transactionId) || String(x.ocpp_transaction_id) === String(second?.transactionId),
  );
  if (rows.length > 0 || forThisCp.length > 0) {
    r.defect(
      forThisCp.length > 1,
      'a single physical plug-in produced more than one CSMS session',
      `${forThisCp.length} session rows for one StartTransaction`,
    );
    r.info(
      'session rows',
      forThisCp.map((x) => `${x.ocpp_transaction_id}:${x.state}`).join(', ') || '(none visible)',
    );
    r.info(
      'root cause',
      'idem_key is hashed over the CSMS-assigned transactionId, which is fresh on every StartTransaction, so the retry cannot collide with the original',
    );
  } else {
    r.check(
      false,
      'the CSMS API could not confirm this session',
      API_KEY
        ? `${API}/v1/sessions returned nothing — the transactionId comparison above still stands`
        : 'no API credential — pass --api-key or set PLUGSURE_KEY',
    );
  }

  // Leave nothing active behind.
  for (const t of [first?.transactionId, second?.transactionId]) {
    if (t == null) continue;
    await cp
      .call('StopTransaction', {
        transactionId: t,
        idTag,
        meterStop: meterStart,
        timestamp: cp.now(),
        reason: 'Other',
      })
      .catch(() => {});
  }

  await cp.stop();
  return r.finish();
}

// --- reconnect-storm -----------------------------------------------------

async function scenarioReconnectStorm(): Promise<number> {
  const r = new Report('reconnect-storm');
  const id = str(args, 'id') ?? `SIM-STORM-${stamp()}`;
  const rounds = num(args, 'rounds') ?? 8;
  const cp = make({
    id,
    backoffBaseMs: num(args, 'backoff-base') ?? 150,
    backoffMaxMs: num(args, 'backoff-max') ?? 5_000,
    backoffJitter: num(args, 'jitter') ?? 0.4,
  });
  wire(cp, true);

  const delays: number[] = [];
  const boots: number[] = [];
  cp.on('reconnect-scheduled', (x: any) => {
    delays.push(x.delayMs);
    console.log(`[${id}] backoff attempt ${x.attempt}: ${x.delayMs}ms`);
  });
  cp.on('boot', () => boots.push(Date.now()));

  await cp.start();
  await settle(cp, 500, 5_000);

  for (let i = 0; i < rounds; i++) {
    cp.dropConnection(`storm round ${i + 1}`);
    // Wait for it to come back before knocking it down again.
    const deadline = Date.now() + 15_000;
    while (cp.state !== 'booted' && Date.now() < deadline) await sleep(50);
    if (cp.state !== 'booted') break;
  }

  r.check(boots.length >= rounds, `charger re-booted after every drop`, `${boots.length} boots / ${rounds + 1} expected`);
  r.check(cp.stats.reconnects >= rounds, 'reconnects counted', `${cp.stats.reconnects}`);
  r.check(cp.state === 'booted', 'ended online', `state=${cp.state}`);
  r.check(delays.length >= rounds, 'a backoff was scheduled for each drop', `${delays.length} backoffs`);
  r.check(
    new Set(delays).size > 1,
    'backoff delays are jittered (not a synchronised stampede)',
    `${delays.length} delays, ${new Set(delays).size} distinct`,
  );
  r.info('observed backoff delays (ms)', delays.join(', '));

  // Growth check: a run of consecutive failures must escalate.
  const noReconnect = make({
    id: `${id}-DEAD`,
    url: (base.url ?? 'ws://127.0.0.1:9220/ocpp').replace(/:(\d+)/, ':1'),
    backoffBaseMs: 100,
    backoffMaxMs: 10_000,
    backoffJitter: 0,
    backoffMaxAttempts: 5,
  });
  const escalating: number[] = [];
  noReconnect.on('reconnect-scheduled', (x: any) => escalating.push(x.delayMs));
  let gaveUp = false;
  noReconnect.on('gave-up', () => (gaveUp = true));
  await noReconnect.start();
  for (let i = 0; i < 80 && !gaveUp; i++) await sleep(100);
  await noReconnect.stop();
  r.check(
    escalating.length >= 3 && escalating[1]! > escalating[0]! && escalating[2]! > escalating[1]!,
    'backoff grows exponentially against a dead endpoint',
    escalating.join(' -> '),
  );
  r.check(gaveUp, 'honours --backoff-attempts and gives up', `after ${escalating.length} attempts`);

  await cp.stop();
  return r.finish();
}

// --- bad-clock -----------------------------------------------------------

async function scenarioBadClock(): Promise<number> {
  const r = new Report('bad-clock');
  const id = str(args, 'id') ?? `SIM-CLOCK-${stamp()}`;
  const skewMs = base.clockSkewMs ?? -20 * 365.25 * 86_400_000;
  const cp = make({ id, clockSkewMs: skewMs, targetKwh: num(args, 'kwh') ?? 2 });
  wire(cp);

  await cp.start();
  await settle(cp);
  r.info('charger believes it is', cp.now());
  r.info('clock skew applied', `${(skewMs / (365.25 * 86_400_000)).toFixed(2)} years`);

  const s = await cp.runSession();
  r.check(s.transactionId != null, 'CSMS accepted a session from a charger with a dead RTC', String(s.transactionId));

  await sleep(700);
  const rows = await sessionsFor(id);
  const mine = rows.find((x) => String(x.ocpp_transaction_id) === String(s.transactionId));
  if (mine) {
    const startYear = new Date(mine.started_at).getUTCFullYear();
    const nowYear = new Date().getUTCFullYear();
    r.info('CSMS stored started_at as', `${mine.started_at} (year ${startYear})`);
    r.defect(
      startYear !== nowYear,
      'CSMS bills on the charger clock with no sanity bound',
      `session dated ${startYear}, real year ${nowYear}`,
    );
    r.check(CLOSED_STATES.includes(mine.state), 'session still closed cleanly', `state=${mine.state}`);
    r.check(
      Math.abs(mine.energy_wh - s.deliveredWh) < 60,
      'energy total unaffected by the skew',
      `csms=${mine.energy_wh} Wh`,
    );
  } else {
    r.check(
      false,
      'the CSMS API could not confirm this session',
      API_KEY
        ? `${API}/v1/sessions returned nothing for this transaction`
        : `no API credential — pass --api-key or set PLUGSURE_KEY, or these checks verify nothing`,
    );
  }

  await cp.stop();
  return r.finish();
}

// --- meter-rollover ------------------------------------------------------

async function scenarioMeterRollover(): Promise<number> {
  const r = new Report('meter-rollover');
  const id = str(args, 'id') ?? `SIM-ROLL-${stamp()}`;
  const width = num(args, 'rollover') ?? 1_000_000; // a 6-digit kWh register in Wh
  const target = num(args, 'kwh') ?? 4;
  // Start just under the wrap so the session crosses it.
  const start = width - Math.round(target * 1000 * 0.4);
  const cp = make({ id, rolloverWh: width, meterStartWh: start, targetKwh: target });
  wire(cp);

  const registers: number[] = [];
  cp.on('meter', (m: any) => registers.push(Math.round(m.registerWh)));

  await cp.start();
  await settle(cp);
  r.info('register width', `${width} Wh, starting at ${start} Wh`);

  const s = await cp.runSession();
  const wrapped = registers.some((v, i) => i > 0 && v < registers[i - 1]!);
  r.check(wrapped, 'the energy register wrapped mid-session', `${registers[0]} ... ${registers.at(-1)}`);
  r.info('delivered', `${(s.deliveredWh / 1000).toFixed(2)} kWh`);

  await sleep(700);
  const rows = await sessionsFor(id);
  const mine = rows.find((x) => String(x.ocpp_transaction_id) === String(s.transactionId));
  if (mine) {
    const ok = Math.abs(mine.energy_wh - s.deliveredWh) < 120;
    r.info('CSMS energy', `${mine.energy_wh} Wh vs ${Math.round(s.deliveredWh)} Wh actually delivered`);
    r.defect(!ok, 'CSMS does not detect a register wrap (energy = stop - start)', `error ${Math.round(mine.energy_wh - s.deliveredWh)} Wh`);
  } else {
    r.check(
      false,
      'the CSMS API could not confirm this session',
      API_KEY
        ? `${API}/v1/sessions returned nothing for this transaction`
        : `no API credential — pass --api-key or set PLUGSURE_KEY, or these checks verify nothing`,
    );
  }

  await cp.stop();
  return r.finish();
}

// --- hostile -------------------------------------------------------------

async function scenarioHostile(): Promise<number> {
  const r = new Report('hostile');
  const id = str(args, 'id') ?? `SIM-HOSTILE-${stamp()}`;
  const cp = make({ id, callErrorRate: num(args, 'callerror-rate') ?? 0.5 });
  wire(cp, true);

  let closed = false;
  cp.on('state', (s: StateEvent) => {
    if (s.to === 'disconnected') closed = true;
  });

  await cp.start();
  const provisioning = await settle(cp);
  r.check(cp.state === 'booted', 'booted despite a 50% CALLERROR rate on inbound calls');
  r.check(cp.stats.callErrorsOut > 0, 'CALLERRORs were actually injected', `${cp.stats.callErrorsOut} of ${cp.stats.callsIn} inbound calls`);
  r.info('CSMS kept provisioning through the errors', unique(provisioning).join(', '));

  for (const kind of ['truncated-json', 'not-array', 'short-array', 'bad-type'] as const) {
    cp.sendMalformed(kind);
    await sleep(250);
    r.check(cp.isOpen, `socket survived a ${kind} frame`);
  }

  // A CALL the CSMS has never heard of must be answered, not fatal.
  const unknown = await cp.call('BananaNotification', { fruit: 'pisang' }).then(
    (v) => ({ ok: true, v }),
    (e: Error) => ({ ok: false, v: e.message }),
  );
  /**
   * `cp.call()` REJECTS on a CALLERROR, so `unknown.ok` is false exactly when
   * the CSMS did the spec-correct thing. The assertion was inverted, so a
   * correct `CALLERROR NotImplemented` scored FAIL — permanently, which is how a
   * test suite teaches people to ignore it.
   *
   * What actually matters is that the CSMS ANSWERED and the socket survived: a
   * CALLRESULT would mean it pretended to handle an action it does not know, and
   * silence would mean it dropped the connection.
   */
  const answered = unknown.ok || /NotImplemented|not implemented/i.test(String(unknown.v));
  r.check(
    answered,
    'CSMS answered an unknown action (NotImplemented) instead of dropping the connection',
    JSON.stringify(unknown.v).slice(0, 80),
  );
  r.check(cp.isOpen, 'the socket survived an unknown action');

  // A well-formed CALL with a garbage payload.
  const garbage = await cp.call('StatusNotification', { connectorId: 'not-a-number', status: 42 }).then(
    () => ({ ok: true, v: 'accepted' }),
    (e: Error) => ({ ok: false, v: e.message }),
  );
  r.info('malformed StatusNotification payload', garbage.v as string);

  // Reply to a uniqueId that was never called: must be ignored, not fatal.
  cp.sendMalformed('bad-type');
  await sleep(200);

  const hb = await cp.call('Heartbeat', {}).then(
    (v: any) => Boolean(v?.currentTime),
    () => false,
  );
  r.check(hb, 'connection still usable afterwards (Heartbeat answered with currentTime)');
  r.check(!closed, 'the gateway never dropped us for misbehaving');
  r.info('frames', `in=${cp.stats.framesIn} out=${cp.stats.framesOut} callErrorsOut=${cp.stats.callErrorsOut}`);

  await cp.stop();
  return r.finish();
}

// ------------------------------------------------------------------ util

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

function stamp(): string {
  return `${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

function printHelp() {
  console.log(`
Virtual Autel-style charge point (OCPP 1.6J).

  npx tsx tools/simulator/autel-sim.ts [flags]

  --scenario <name>             run a named end-to-end scenario and print
                                a PASS/FAIL summary. One of:
                                  ${SCENARIOS.join('\n                                  ')}
  --api <http://host:port>      CSMS API used for scenario assertions
                                (default http://127.0.0.1:9200)
  --rounds <n>                  reconnect-storm rounds (default 8)
${COMMON_FLAG_HELP}
Examples
  npx tsx tools/simulator/autel-sim.ts --id AUTEL-AC22-SMB-001 --session --kwh 12
  npx tsx tools/simulator/autel-sim.ts --scenario offline-replay --url ws://127.0.0.1:9220/ocpp
  npx tsx tools/simulator/autel-sim.ts --scenario bad-clock --clock-skew -20y
  npx tsx tools/simulator/autel-sim.ts --per-phase --session      # 3x under-billing repro
`);
}

// Class declarations above are not hoisted, so the entry point goes last.
void main().catch((e: Error) => {
  console.error(`\nsimulator failed: ${e.message}`);
  process.exit(1);
});
