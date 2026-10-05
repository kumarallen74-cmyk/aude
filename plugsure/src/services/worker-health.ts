import { monitorEventLoopDelay } from 'node:perf_hooks';
import { logger } from '../logger.js';
import { pool, many } from '../db/pool.js';
import { config } from '../config.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { guardedFetch } from './net-guard.js';

/**
 * Health of the gateway's background work: how long each worker pass takes,
 * whether passes of the same worker pile up, how late the event loop runs, and
 * whether queries are queueing for a database connection.
 *
 * Quiet by default: a warning only when something is wrong (a pass longer than
 * its interval, an overlapping pass, event-loop delay over 1 s, queries waiting
 * for a connection). GATEWAY_DIAG=verbose logs a summary every 10 s as well.
 *
 * v1.5.1: a failing worker used to produce nothing but a log line per pass —
 * refunds, card holds or the roaming push could fail for days with nobody told.
 * Each worker now keeps its failure streak and its last success, and the health
 * monitor turns a worker that keeps failing (or has not succeeded for far longer
 * than its interval) into an operator ALERT — the ordinary alert table, so the
 * console shows it and alert routing / on-call rotas page for it — resolved
 * automatically when the worker succeeds again. See checkWorkers() below.
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
  /** When the worker was first run in this process (the staleness clock before any success). */
  registeredAt: number;
  /** Passes that failed, in total and in a row (reset by a success). */
  failures: number;
  consecutiveFailures: number;
  /** When the current failure streak began (null while not failing). */
  failingSince: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  /**
   * Alert state as this process knows it: 'unknown' after a (re)start — an alert
   * left open by the previous process may exist — then 'open' or 'clear'.
   */
  alert: 'unknown' | 'open' | 'clear';
}

export const workerStats = new Map<string, WorkerStat>();

/** Wrap a worker pass: count it, time it, and warn when passes overlap or run past their interval. */
export function instrumentWorker(name: string, intervalMs: number, fn: () => Promise<unknown>): () => void {
  const s: WorkerStat = {
    name, intervalMs, runs: 0, inFlight: 0, overlaps: 0, lastMs: 0, maxMs: 0, lastStartedAt: null,
    registeredAt: Date.now(), failures: 0, consecutiveFailures: 0, failingSince: null,
    lastSuccessAt: null, lastFailureAt: null, lastError: null, alert: 'unknown',
  };
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
      .then(
        () => recordOutcome(s, null),
        (e) => {
          recordOutcome(s, e as Error);
          logger.warn({ worker: name, err: (e as Error).message, consecutiveFailures: s.consecutiveFailures }, 'worker pass failed');
        },
      )
      .finally(() => {
        s.inFlight--;
        s.lastMs = Date.now() - t0;
        s.maxMs = Math.max(s.maxMs, s.lastMs);
        if (s.lastMs > intervalMs) logger.warn({ worker: name, ms: s.lastMs, intervalMs }, 'worker pass took longer than its interval');
      });
  };
}

/**
 * A pass's outcome. A pass that SKIPPED because another runner holds the
 * worker's lock (workers.ts `exclusive`) resolved normally and counts as a
 * success: the work is being done, just not here.
 */
export function recordOutcome(s: WorkerStat, err: Error | null, now = Date.now()): void {
  if (err) {
    s.failures++;
    s.consecutiveFailures++;
    s.failingSince ??= now;
    s.lastFailureAt = now;
    s.lastError = String(err.message ?? err).slice(0, 300);
  } else {
    s.consecutiveFailures = 0;
    s.failingSince = null;
    s.lastSuccessAt = now;
  }
}

// ─────────────────────────────────────────── assessment

/**
 * When a worker counts as unhealthy.
 *
 *  failing  WORKER_ALERT_FAILURES passes in a row (default 3) have failed, AND
 *           the streak is at least a minute old — so the 3-second outbox workers
 *           do not page anyone for a ten-second database blip.
 *  stale    no successful pass for 3 × its interval, and at least 10 minutes:
 *           a pass that hangs (never resolves) or keeps being skipped looks like
 *           this. Counted from the worker's first run in this process until its
 *           first success.
 *
 * A worker that runs every 6 hours therefore alerts on its third failure in a
 * row (18 h); lower WORKER_ALERT_FAILURES to hear sooner.
 */
export const HEALTH_RULES = {
  get failures(): number {
    const n = Number(process.env.WORKER_ALERT_FAILURES);
    return Number.isInteger(n) && n >= 1 ? n : 3;
  },
  failingMinAgeMs: 60_000,
  staleFactor: 3,
  staleMinMs: 10 * 60_000,
};

/**
 * Workers whose failure costs drivers money or leaves a problem unannounced:
 * their alert is critical (critical alerts ignore quiet hours in alert routing).
 */
const CRITICAL_WORKERS = new Set(['refunds', 'card-holds', 'pass-renewals', 'reconcile', 'alert-routing', 'unpaid-reminders']);

export type WorkerProblem = 'failing' | 'stale' | null;

export function assessWorker(s: WorkerStat, now = Date.now()): WorkerProblem {
  if (s.consecutiveFailures >= HEALTH_RULES.failures && s.failingSince !== null && now - s.failingSince >= HEALTH_RULES.failingMinAgeMs) {
    return 'failing';
  }
  const staleAfter = Math.max(HEALTH_RULES.staleFactor * s.intervalMs, HEALTH_RULES.staleMinMs);
  if (now - (s.lastSuccessAt ?? s.registeredAt) > staleAfter) return 'stale';
  return null;
}

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

/** Every worker's state, for the admin health output (no secrets: names, counts, times, the last error). */
export function workerHealthReport(now = Date.now()) {
  const workers = [...workerStats.values()]
    .map((s) => ({
      name: s.name,
      intervalMs: s.intervalMs,
      problem: assessWorker(s, now),
      runs: s.runs,
      inFlight: s.inFlight,
      overlaps: s.overlaps,
      failures: s.failures,
      consecutiveFailures: s.consecutiveFailures,
      lastSuccessAt: iso(s.lastSuccessAt),
      lastFailureAt: iso(s.lastFailureAt),
      lastError: s.lastError,
      lastMs: s.lastMs,
      maxMs: s.maxMs,
      alert: s.alert,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    ok: workers.every((w) => w.problem === null),
    unhealthy: workers.filter((w) => w.problem !== null).map((w) => w.name),
    heartbeat: { configured: Boolean(heartbeatUrl()), lastPingAt: iso(heartbeat.lastPingAt), lastError: heartbeat.lastError },
    workers,
    time: new Date(now).toISOString(),
  };
}

// ─────────────────────────────────────────── alerts

export const WORKER_ALERT_KIND = 'platform.worker_failing';

/**
 * Which organisation's alert list a worker alert goes to.
 *
 * Worker failures are the PLATFORM operator's problem, not a tenant's. Every
 * alert belongs to an organisation (alert.org_id is NOT NULL, and routing rules,
 * contacts and on-call rotas are per organisation), so it goes to:
 *   1. OPS_ALERT_ORG_ID, when set (comma-separated for several);
 *   2. otherwise every organisation with an active platform administrator
 *      (`npm run create-admin -- --platform-admin`) — the operator's own;
 *   3. otherwise the only organisation, on a single-operator install.
 * With none of these the problem is logged at error level and not stored.
 * Re-read every 10 minutes.
 */
let orgCache: { at: number; ids: string[] } | null = null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function opsAlertOrgs(now = Date.now()): Promise<string[]> {
  if (orgCache && now - orgCache.at < 10 * 60_000) return orgCache.ids;
  let ids = (process.env.OPS_ALERT_ORG_ID ?? '').split(',').map((s) => s.trim()).filter((s) => UUID.test(s));
  if (!ids.length) {
    ids = (await many<{ org_id: string }>(
      `SELECT DISTINCT COALESCE(ur.scope_id, u.org_id) AS org_id
         FROM user_role ur JOIN role r ON r.id = ur.role_id JOIN app_user u ON u.id = ur.user_id
        WHERE r.org_id IS NULL AND r.name = 'platform_admin' AND u.status = 'active'`,
    )).map((r) => r.org_id);
  }
  if (!ids.length) {
    const orgs = await many<{ id: string }>(`SELECT id FROM organisation LIMIT 2`);
    if (orgs.length === 1) ids = [orgs[0]!.id];
  }
  orgCache = { at: now, ids };
  return ids;
}

/** For tests: forget the cached organisations. */
export function resetOpsAlertOrgCache(): void {
  orgCache = null;
}

export interface WorkerAlertDeps {
  orgs: () => Promise<string[]>;
  raise: (orgId: string, s: WorkerStat, problem: Exclude<WorkerProblem, null>) => Promise<unknown>;
  resolve: (orgId: string, worker: string) => Promise<unknown>;
}

export function workerAlertMessage(s: WorkerStat, problem: Exclude<WorkerProblem, null>, now = Date.now()): string {
  const since = s.lastSuccessAt ? `last success ${Math.round((now - s.lastSuccessAt) / 60_000)} min ago` : 'no successful pass since the gateway started';
  return problem === 'failing'
    ? `Background worker "${s.name}" has failed ${s.consecutiveFailures} times in a row (${since}): ${s.lastError ?? 'unknown error'}`
    : `Background worker "${s.name}" has not completed a pass for longer than expected (runs every ${Math.round(s.intervalMs / 1000)} s; ${since})`;
}

const defaultDeps: WorkerAlertDeps = {
  orgs: () => opsAlertOrgs(),
  raise: async (orgId, s, problem) => {
    const id = await persistAlert({
      orgId,
      kind: WORKER_ALERT_KIND,
      severity: CRITICAL_WORKERS.has(s.name) ? 'critical' : 'warning',
      message: workerAlertMessage(s, problem),
      targetType: 'worker',
      targetId: s.name,
    });
    // persistAlert logs and swallows its own failure; here it must count as one,
    // or the worker would be marked 'open' with no alert stored.
    if (!id) throw new Error('the alert could not be stored');
  },
  resolve: (orgId, worker) => resolveAlertsFor(orgId, WORKER_ALERT_KIND, 'worker', worker),
};

/**
 * One assessment round over every worker. Raises an alert for a worker that has
 * become unhealthy, and resolves it once the worker has succeeded again.
 *
 * De-duplicated twice: this process raises once per unhealthy spell (state
 * 'open'), and persistAlert folds a repeat of an OPEN alert with the same kind
 * and target into the existing row (occurrences + 1) — so a restart while a
 * worker is still failing does not open a second alert. After a restart the
 * state is 'unknown': the first success resolves whatever the previous process
 * left open (a no-op when there is nothing).
 *
 * Returns whether every worker is healthy (the heartbeat's condition).
 */
export async function checkWorkers(now = Date.now(), deps: WorkerAlertDeps = defaultDeps): Promise<boolean> {
  let allHealthy = true;
  let orgIds: string[] | null = null;
  const orgs = async () => (orgIds ??= await deps.orgs());
  for (const s of workerStats.values()) {
    const problem = assessWorker(s, now);
    try {
      if (problem) {
        allHealthy = false;
        if (s.alert === 'open') continue;
        const ids = await orgs();
        if (!ids.length) {
          logger.error({ worker: s.name, problem, lastError: s.lastError },
            'background worker unhealthy and no organisation to alert (set OPS_ALERT_ORG_ID or create a platform administrator)');
        } else {
          for (const id of ids) await deps.raise(id, s, problem);
          logger.error({ worker: s.name, problem, lastError: s.lastError, consecutiveFailures: s.consecutiveFailures }, 'background worker unhealthy: operator alert raised');
        }
        s.alert = 'open';
      } else if (s.alert !== 'clear' && s.lastSuccessAt !== null && s.consecutiveFailures === 0) {
        for (const id of await orgs()) await deps.resolve(id, s.name);
        if (s.alert === 'open') logger.info({ worker: s.name }, 'background worker recovered: alert resolved');
        s.alert = 'clear';
      }
    } catch (e) {
      // The database may be what is failing: stop this round (one warning, not one
      // per worker) and try again on the next. Not "all healthy": no heartbeat.
      logger.warn({ worker: s.name, err: (e as Error).message }, 'worker health: could not update the alert; retrying next round');
      return false;
    }
  }
  return allHealthy;
}

// ─────────────────────────────────────────── external dead-man's switch

/**
 * HEARTBEAT_URL (optional): an external dead-man's switch, e.g. a healthchecks.io
 * check (https://hc-ping.com/<uuid>) or any monitor that alarms when it is NOT
 * called. The gateway GETs it at most once per HEARTBEAT_INTERVAL_MS (default
 * 60 s) after a health round in which every worker was healthy. It therefore
 * goes quiet — and the external service alarms — when the gateway is down, its
 * event loop is stuck, the host is suspended, OR any worker is unhealthy:
 * including the failures the in-app alert cannot report itself (the database is
 * down, alert routing is the worker that fails, nobody is set up to be paged).
 *
 * Sent through the outbound guard (net-guard.ts): https only and no internal
 * addresses outside development and test.
 */
const heartbeat: { lastPingAt: number | null; lastError: string | null; inFlight: boolean } = { lastPingAt: null, lastError: null, inFlight: false };

export const heartbeatUrl = () => (process.env.HEARTBEAT_URL ?? '').trim();
const heartbeatEveryMs = () => {
  const n = Number(process.env.HEARTBEAT_INTERVAL_MS);
  return Number.isInteger(n) && n >= 10_000 ? n : 60_000;
};

export async function pingHeartbeat(now = Date.now(), fetcher: typeof guardedFetch = guardedFetch): Promise<boolean> {
  const url = heartbeatUrl();
  if (!url || heartbeat.inFlight) return false;
  if (heartbeat.lastPingAt !== null && now - heartbeat.lastPingAt < heartbeatEveryMs()) return false;
  heartbeat.inFlight = true;
  try {
    const r = await fetcher(url, { headers: { 'user-agent': `PlugSure/${config.version} heartbeat` }, timeoutMs: 10_000, maxBytes: 16 * 1024 });
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
    heartbeat.lastPingAt = now;
    heartbeat.lastError = null;
    return true;
  } catch (e) {
    heartbeat.lastError = (e as Error).message;
    logger.warn({ err: heartbeat.lastError }, 'heartbeat ping (HEARTBEAT_URL) failed');
    return false;
  } finally {
    heartbeat.inFlight = false;
  }
}

/** For tests. */
export function resetHeartbeat(): void {
  heartbeat.lastPingAt = null;
  heartbeat.lastError = null;
  heartbeat.inFlight = false;
}

// ─────────────────────────────────────────── monitor

/** Event-loop delay, pool pressure, long-running passes and worker alerts, every 10 s. Returns a stop function. */
export function startHealthMonitor(): () => void {
  const verbose = process.env.GATEWAY_DIAG === 'verbose';
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  let lastTick = Date.now();
  let checking = false;
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
    // Worker alerts, then the heartbeat — only after a round with every worker healthy.
    // One round at a time: with the database down a round can outlast the tick.
    if (checking) return;
    checking = true;
    void checkWorkers(now)
      .then((allHealthy) => (allHealthy ? pingHeartbeat(now) : false))
      .catch((e) => logger.warn({ err: (e as Error).message }, 'worker health round failed'))
      .finally(() => { checking = false; });
  }, 10_000);
  timer.unref?.();
  return () => { clearInterval(timer); h.disable(); };
}

// ─────────────────────────────────────────── API side

/**
 * Worker health for the API's platform health route: the gateway's, fetched over
 * the bridge in the split deployment (the workers run there), or this process's
 * own in a single-process deployment. null when it cannot be had.
 */
export async function fetchWorkerHealth(): Promise<{ source: 'gateway' | 'local'; report: unknown; error?: string } | null> {
  if (config.bridge.gatewayUrl && config.bridge.token) {
    try {
      const res = await fetch(`${config.bridge.gatewayUrl}/internal/workers`, {
        headers: { 'x-internal-token': config.bridge.token },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`gateway answered HTTP ${res.status}`);
      return { source: 'gateway', report: await res.json() };
    } catch (e) {
      return { source: 'gateway', report: null, error: (e as Error).message };
    }
  }
  return workerStats.size ? { source: 'local', report: workerHealthReport() } : null;
}
