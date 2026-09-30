import { monitorEventLoopDelay } from 'node:perf_hooks';
import { logger } from '../logger.js';
import { pool } from '../db/pool.js';

/**
 * Health of the gateway's background work: how long each worker pass takes,
 * whether passes of the same worker pile up, how late the event loop runs, and
 * whether queries are queueing for a database connection.
 *
 * Quiet by default: a warning only when something is wrong (a pass longer than
 * its interval, an overlapping pass, event-loop delay over 1 s, queries waiting
 * for a connection). GATEWAY_DIAG=verbose logs a summary every 10 s as well.
 */

export interface WorkerStat {
  name: string;
  intervalMs: number;
  runs: number;
  inFlight: number;
  /** Passes started while the previous one was still running. */
  overlaps: number;
  lastMs: number;
  maxMs: number;
  lastStartedAt: number | null;
}

export const workerStats = new Map<string, WorkerStat>();

/** Wrap a worker pass: count it, time it, and warn when passes overlap or run past their interval. */
export function instrumentWorker(name: string, intervalMs: number, fn: () => Promise<unknown>): () => void {
  const s: WorkerStat = { name, intervalMs, runs: 0, inFlight: 0, overlaps: 0, lastMs: 0, maxMs: 0, lastStartedAt: null };
  workerStats.set(name, s);
  return () => {
    if (s.inFlight > 0) {
      s.overlaps++;
      logger.warn({ worker: name, inFlight: s.inFlight + 1, overlaps: s.overlaps }, 'worker pass overlaps a pass still running');
    }
    s.inFlight++;
    s.runs++;
    const t0 = Date.now();
    s.lastStartedAt = t0;
    void fn()
      .catch((e) => logger.warn({ worker: name, err: (e as Error).message }, 'worker pass failed'))
      .finally(() => {
        s.inFlight--;
        s.lastMs = Date.now() - t0;
        s.maxMs = Math.max(s.maxMs, s.lastMs);
        if (s.lastMs > intervalMs) logger.warn({ worker: name, ms: s.lastMs, intervalMs }, 'worker pass took longer than its interval');
      });
  };
}

/** Event-loop delay, pool pressure and long-running passes, every 10 s. Returns a stop function. */
export function startHealthMonitor(): () => void {
  const verbose = process.env.GATEWAY_DIAG === 'verbose';
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  let lastTick = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const gapMs = now - lastTick - 10_000; // a late tick is itself event-loop delay
    lastTick = now;
    const maxLagMs = Math.round(h.max / 1e6);
    const p99LagMs = Math.round(h.percentile(99) / 1e6);
    h.reset();
    const running = [...workerStats.values()].filter((w) => w.inFlight > 0)
      .map((w) => ({ worker: w.name, inFlight: w.inFlight, forMs: w.lastStartedAt ? now - w.lastStartedAt : null }));
    const poolState = { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
    if (gapMs > 30_000) {
      // Nothing ran for this long: either the process was not scheduled at all (the host slept,
      // e.g. a laptop lid closed or Windows Modern Standby, or the VM was paused) or something
      // blocked the event loop. Timers, sockets and workers all resume together afterwards, so
      // offline alerts and outage durations from this period are shifted by the pause.
      logger.warn({ pausedForS: Math.round(gapMs / 1000), maxLagMs },
        'gateway paused: the event loop did not run for this long (host sleep or suspend, or a blocked event loop)');
    }
    const unhealthy = maxLagMs > 1000 || gapMs > 1000 || poolState.waiting > 0 || running.some((r) => (r.forMs ?? 0) > 60_000);
    if (verbose || unhealthy) {
      (unhealthy ? logger.warn : logger.info).call(logger, { maxLagMs, p99LagMs, tickLateMs: Math.max(0, gapMs), pool: poolState, running }, 'gateway health');
    }
  }, 10_000);
  timer.unref?.();
  return () => { clearInterval(timer); h.disable(); };
}
