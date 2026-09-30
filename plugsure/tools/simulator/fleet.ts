#!/usr/bin/env -S npx tsx
import { VirtualChargePoint, sleep, type StateEvent, type VcpStats } from './charge-point.js';
import { COMMON_FLAG_HELP, has, num, optionsFromArgs, parseArgs, str } from './options.js';

/**
 * Run N virtual chargers against one gateway.
 *
 * Two things this is for:
 *   1. Load. A site with 40 connectors is not the same shape of problem as one.
 *   2. Reconnect storms. A kampung-scale power cut brings every charger back at
 *      once; with --storm the whole fleet is dropped together and you find out
 *      whether the gateway, the DB pool and the provisioning routine survive the
 *      stampede. Backoff jitter is what keeps it from being a thundering herd,
 *      so --jitter 0 is the pathological case worth testing deliberately.
 *
 * Usage:
 *   npx tsx tools/simulator/fleet.ts --count 20 --url ws://127.0.0.1:9220/ocpp
 *   npx tsx tools/simulator/fleet.ts --count 20 --sessions --storm 3
 */

const args = parseArgs(process.argv.slice(2));

if (has(args, 'help') || has(args, 'h')) {
  console.log(`
Fleet runner — N virtual charge points against one gateway.

  npx tsx tools/simulator/fleet.ts [flags]

  --count <n>            chargers to run (default 10)
  --prefix <str>         identity prefix (default SIM-FLEET)
  --stagger <ms>         delay between starts (default 200)
  --sessions             run one charging session on each charger
  --storm <n>            drop the whole fleet n times and let it reconnect
  --storm-gap <ms>       wait between storm rounds (default 6000)
  --duration <s>         hold the fleet up for n seconds before reporting
  --quiet                per-charger lines off; aggregate report only
${COMMON_FLAG_HELP}`);
  process.exit(0);
}

const COUNT = num(args, 'count') ?? 10;
const PREFIX = str(args, 'prefix') ?? 'SIM-FLEET';
const STAGGER = num(args, 'stagger') ?? 200;
const STORM = num(args, 'storm') ?? 0;
const STORM_GAP = num(args, 'storm-gap') ?? 6_000;
const DURATION = num(args, 'duration') ?? 0;
const QUIET = has(args, 'quiet');
const RUN_SESSIONS = has(args, 'sessions');

const base = optionsFromArgs(args);
const stamp = Date.now().toString(36).toUpperCase().slice(-4);

void main().catch((e: Error) => {
  console.error(`\nfleet failed: ${e.message}`);
  process.exit(1);
});

async function main() {
  const t0 = Date.now();
  const fleet: VirtualChargePoint[] = [];
  const stateCounts = new Map<string, number>();
  const backoffs: number[] = [];
  let errors = 0;

  console.log(`starting ${COUNT} chargers against ${base.url ?? 'ws://127.0.0.1:9220/ocpp'} (stagger ${STAGGER}ms)`);

  for (let i = 0; i < COUNT; i++) {
    const id = `${PREFIX}-${stamp}-${String(i + 1).padStart(3, '0')}`;
    const cp = new VirtualChargePoint({
      ...base,
      id,
      // Every charger having its own connector count is closer to a real site.
      connectors: base.connectors ?? (i % 4 === 3 ? 2 : 1),
    });
    cp.on('state', (s: StateEvent) => {
      stateCounts.set(s.to, (stateCounts.get(s.to) ?? 0) + 1);
      if (!QUIET && (s.to === 'backoff' || s.to === 'disconnected')) {
        console.log(`[${id}] ${s.from} -> ${s.to} ${s.delayMs ? `in ${s.delayMs}ms` : ''} ${s.reason ?? ''}`.trimEnd());
      }
    });
    cp.on('reconnect-scheduled', (x: any) => backoffs.push(x.delayMs));
    cp.on('error', () => errors++);
    fleet.push(cp);
  }

  // Staggered start: a fleet that all dials at once is its own kind of test,
  // but the default should look like a site powering up.
  await Promise.all(
    fleet.map(async (cp, i) => {
      await sleep(i * STAGGER);
      await cp.start().catch(() => {});
      if (!QUIET) console.log(`[${cp.opts.id}] ${cp.state}`);
    }),
  );

  const online = () => fleet.filter((c) => c.state === 'booted').length;
  console.log(`\nall started: ${online()}/${COUNT} booted after ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (RUN_SESSIONS) {
    console.log('running one session on each charger...');
    await Promise.all(
      fleet.map(async (cp, i) => {
        await sleep(i * 50);
        await cp.runSession().catch(() => {});
      }),
    );
    console.log('sessions complete');
  }

  for (let round = 1; round <= STORM; round++) {
    console.log(`\n--- reconnect storm round ${round}/${STORM}: dropping all ${COUNT} chargers ---`);
    const dropAt = Date.now();
    for (const cp of fleet) cp.dropConnection(`storm ${round}`);
    // Wait for the fleet to come back, or give up after the gap.
    const deadline = dropAt + STORM_GAP;
    while (Date.now() < deadline && online() < COUNT) await sleep(100);
    console.log(
      `recovered ${online()}/${COUNT} in ${((Date.now() - dropAt) / 1000).toFixed(1)}s`,
    );
  }

  if (DURATION > 0) {
    console.log(`\nholding the fleet up for ${DURATION}s...`);
    await sleep(DURATION * 1_000);
  }

  const agg = fleet.reduce<VcpStats>(
    (a, cp) => {
      for (const k of Object.keys(a) as (keyof VcpStats)[]) a[k] += cp.stats[k];
      return a;
    },
    {
      connections: 0,
      reconnects: 0,
      framesIn: 0,
      framesOut: 0,
      callsIn: 0,
      callsOut: 0,
      callErrorsIn: 0,
      callErrorsOut: 0,
      sessions: 0,
      queuedOffline: 0,
      replayed: 0,
      duplicatesSent: 0,
      energyWh: 0,
      errors: 0,
    },
  );

  const elapsedS = (Date.now() - t0) / 1000;
  console.log(`\n=== fleet report (${COUNT} chargers, ${elapsedS.toFixed(1)}s) ===`);
  console.log(`  booted now         ${online()}/${COUNT}`);
  console.log(`  connections        ${agg.connections}  (reconnects ${agg.reconnects})`);
  console.log(`  frames             in ${agg.framesIn}  out ${agg.framesOut}  (${(agg.framesOut / elapsedS).toFixed(1)}/s out)`);
  console.log(`  calls              CP->CS ${agg.callsOut}  CS->CP ${agg.callsIn}`);
  console.log(`  CALLERRORs         received ${agg.callErrorsIn}  sent ${agg.callErrorsOut}`);
  console.log(`  sessions           ${agg.sessions}  energy ${(agg.energyWh / 1000).toFixed(2)} kWh`);
  console.log(`  offline queue      queued ${agg.queuedOffline}  replayed ${agg.replayed}`);
  console.log(`  socket errors      ${agg.errors} (listener count ${errors})`);
  if (backoffs.length) {
    const sorted = [...backoffs].sort((a, b) => a - b);
    console.log(
      `  backoff delays     n=${backoffs.length} min=${sorted[0]}ms p50=${sorted[Math.floor(sorted.length / 2)]}ms max=${sorted.at(-1)}ms`,
    );
  }
  const states = [...stateCounts.entries()].map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`  state transitions  ${states}`);

  const healthy = online() === COUNT;
  console.log(`=== fleet: ${healthy ? 'PASS' : `FAIL (${COUNT - online()} chargers not online)`} ===\n`);

  await Promise.all(fleet.map((cp) => cp.stop().catch(() => {})));
  process.exit(healthy ? 0 : 1);
}
