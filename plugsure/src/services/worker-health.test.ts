import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { one, many, query, pool } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import {
  workerStats, instrumentWorker, recordOutcome, assessWorker, checkWorkers, pingHeartbeat, resetHeartbeat,
  workerHealthReport, resetOpsAlertOrgCache, HEALTH_RULES, WORKER_ALERT_KIND, type WorkerStat, type WorkerAlertDeps,
} from './worker-health.js';

/**
 * Worker failures become operator alerts (v1.5.1). They used to be log lines only:
 * a refunds or card-holds worker could fail for days with nobody told.
 */

/** Worker pass bookkeeping: durations and overlapping passes (behaviour unchanged: they still run). */
describe('worker health', () => {
  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

  test('an overlapping pass is counted and still runs; a failing pass is contained', async () => {
    const g = gate();
    let calls = 0;
    const run = instrumentWorker('t-overlap', 60_000, async () => { calls++; await g.p; throw new Error('boom'); });
    run(); run();
    const s = workerStats.get('t-overlap')!;
    assert.deepEqual({ calls, inFlight: s.inFlight, overlaps: s.overlaps }, { calls: 2, inFlight: 2, overlaps: 1 });
    g.open(); await new Promise((r) => setImmediate(r));
    assert.equal(s.inFlight, 0, 'the failure is logged, not thrown, and both passes are finished');
    assert.equal(s.runs, 2);
    assert.equal(s.consecutiveFailures, 2, 'v1.5.1: and counted');
  });

  test('pass duration is recorded', async () => {
    const run = instrumentWorker('t-duration', 60_000, () => new Promise((r) => setTimeout(r, 30)));
    run();
    await new Promise((r) => setTimeout(r, 60));
    const s = workerStats.get('t-duration')!;
    assert.ok(s.lastMs >= 25 && s.maxMs >= s.lastMs, `lastMs ${s.lastMs}`);
  });
});

const MIN = 60_000;
const T0 = Date.parse('2026-10-02T00:00:00Z');

function stat(name: string, intervalMs = MIN, at = T0): WorkerStat {
  const s: WorkerStat = {
    name, intervalMs, runs: 0, inFlight: 0, overlaps: 0, lastMs: 0, maxMs: 0, lastStartedAt: null,
    registeredAt: at, failures: 0, consecutiveFailures: 0, failingSince: null,
    lastSuccessAt: null, lastFailureAt: null, lastError: null, alert: 'unknown',
  };
  workerStats.set(name, s);
  return s;
}

const boom = new Error('connect ECONNREFUSED');

function fakeDeps(orgs: string[] = ['org-1']) {
  const raised: Array<{ orgId: string; worker: string; problem: string }> = [];
  const resolved: Array<{ orgId: string; worker: string }> = [];
  const deps: WorkerAlertDeps = {
    orgs: async () => orgs,
    raise: async (orgId, s, problem) => { raised.push({ orgId, worker: s.name, problem }); },
    resolve: async (orgId, worker) => { resolved.push({ orgId, worker }); },
  };
  return { deps, raised, resolved };
}

describe('worker health: assessment', () => {
  beforeEach(() => workerStats.clear());

  test('a failure streak is unhealthy only after N failures AND a minute', () => {
    const s = stat('refunds', 5 * MIN);
    recordOutcome(s, null, T0);
    for (let i = 0; i < HEALTH_RULES.failures - 1; i++) recordOutcome(s, boom, T0 + 1000 * (i + 1));
    assert.equal(assessWorker(s, T0 + 2 * MIN), null, 'not yet N failures');
    recordOutcome(s, boom, T0 + 10_000);
    assert.equal(assessWorker(s, T0 + 20_000), null, 'N failures, but the streak is under a minute old (a blip)');
    assert.equal(assessWorker(s, T0 + 2 * MIN), 'failing');
    assert.equal(s.lastError, 'connect ECONNREFUSED');
    recordOutcome(s, null, T0 + 3 * MIN);
    assert.equal(assessWorker(s, T0 + 3 * MIN), null, 'one success clears the streak');
    assert.equal(s.consecutiveFailures, 0);
    assert.equal(s.failures, HEALTH_RULES.failures);
  });

  test('no success for 3 intervals (at least 10 minutes) is stale: a hung pass', () => {
    const fast = stat('push', 3_000);
    assert.equal(assessWorker(fast, T0 + 9 * MIN), null, 'the 10-minute floor');
    assert.equal(assessWorker(fast, T0 + 11 * MIN), 'stale', 'never succeeded since it was first run');
    recordOutcome(fast, null, T0 + 11 * MIN);
    assert.equal(assessWorker(fast, T0 + 12 * MIN), null);
    const hourly = stat('compliance', 60 * MIN);
    recordOutcome(hourly, null, T0);
    assert.equal(assessWorker(hourly, T0 + 179 * MIN), null);
    assert.equal(assessWorker(hourly, T0 + 181 * MIN), 'stale');
  });

  test('instrumentWorker records successes and failures of real passes', async () => {
    let fail = true;
    const run = instrumentWorker('flaky', MIN, async () => { if (fail) throw boom; });
    run();
    await new Promise((r) => setImmediate(r));
    const s = workerStats.get('flaky')!;
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(s.lastSuccessAt, null);
    fail = false;
    run();
    await new Promise((r) => setImmediate(r));
    assert.equal(s.consecutiveFailures, 0);
    assert.ok(s.lastSuccessAt);
    assert.equal(s.runs, 2);
    const report = workerHealthReport();
    assert.equal(report.ok, true);
    assert.equal(report.workers[0]!.name, 'flaky');
    assert.equal(report.workers[0]!.failures, 1);
  });
});

describe('worker health: alerts', () => {
  beforeEach(() => workerStats.clear());

  test('raised once per unhealthy spell, resolved when the worker succeeds again', async () => {
    const s = stat('card-holds', MIN);
    const { deps, raised, resolved } = fakeDeps(['org-1', 'org-2']);
    recordOutcome(s, null, T0);
    assert.equal(await checkWorkers(T0, deps), true);
    assert.deepEqual(resolved.map((r) => r.orgId), ['org-1', 'org-2'], 'after a restart, the first success clears what the last process left open');
    resolved.length = 0;
    assert.equal(await checkWorkers(T0 + 10_000, deps), true);
    assert.equal(resolved.length, 0, 'nothing to resolve while clear');

    for (let i = 1; i <= HEALTH_RULES.failures; i++) recordOutcome(s, boom, T0 + i * MIN);
    assert.equal(await checkWorkers(T0 + 5 * MIN, deps), false);
    assert.deepEqual(raised, [
      { orgId: 'org-1', worker: 'card-holds', problem: 'failing' },
      { orgId: 'org-2', worker: 'card-holds', problem: 'failing' },
    ]);
    recordOutcome(s, boom, T0 + 6 * MIN);
    assert.equal(await checkWorkers(T0 + 6 * MIN, deps), false);
    assert.equal(raised.length, 2, 'de-duplicated: no new alert while it is open');
    assert.equal(s.alert, 'open');

    recordOutcome(s, null, T0 + 7 * MIN);
    assert.equal(await checkWorkers(T0 + 7 * MIN, deps), true);
    assert.equal(resolved.length, 2, 'auto-resolved on recovery');
    assert.equal(s.alert, 'clear');
  });

  test('a worker still failing after a restart is not resolved, and alerts once more', async () => {
    const s = stat('refunds', 5 * MIN);
    const { deps, raised, resolved } = fakeDeps();
    for (let i = 0; i < HEALTH_RULES.failures; i++) recordOutcome(s, boom, T0 + i * 5 * MIN);
    await checkWorkers(T0 + 20 * MIN, deps);
    assert.equal(resolved.length, 0, 'never resolved without a success');
    assert.equal(raised.length, 1, 'persistAlert folds this into the open row (see the database test)');
  });

  test('with no organisation to alert, the problem is only logged — and retried after the cache', async () => {
    const s = stat('roaming', 3_000);
    const { deps, raised } = fakeDeps([]);
    for (let i = 0; i < HEALTH_RULES.failures; i++) recordOutcome(s, boom, T0);
    assert.equal(await checkWorkers(T0 + 2 * MIN, deps), false);
    assert.equal(raised.length, 0);
    assert.equal(s.alert, 'open', 'logged once per spell, not every round');
  });

  test('an alert that cannot be written stops the round and is tried again on the next', async () => {
    const s = stat('webhooks', 3_000);
    const t = stat('push', 3_000);
    let calls = 0;
    const deps: WorkerAlertDeps = {
      orgs: async () => ['org-1'],
      raise: async () => { calls++; if (calls === 1) throw new Error('database down'); },
      resolve: async () => {},
    };
    for (let i = 0; i < HEALTH_RULES.failures; i++) { recordOutcome(s, boom, T0); recordOutcome(t, boom, T0); }
    assert.equal(await checkWorkers(T0 + 2 * MIN, deps), false);
    assert.deepEqual([s.alert, t.alert, calls], ['unknown', 'unknown', 1], 'one failure ends the round (one warning, not one per worker)');
    assert.equal(await checkWorkers(T0 + 2 * MIN + 10_000, deps), false);
    assert.deepEqual([s.alert, t.alert, calls], ['open', 'open', 3]);
  });
});

describe('worker health: HEARTBEAT_URL', () => {
  const saved = { url: process.env.HEARTBEAT_URL, every: process.env.HEARTBEAT_INTERVAL_MS };
  beforeEach(() => { resetHeartbeat(); delete process.env.HEARTBEAT_INTERVAL_MS; });
  after(() => {
    if (saved.url === undefined) delete process.env.HEARTBEAT_URL; else process.env.HEARTBEAT_URL = saved.url;
    if (saved.every === undefined) delete process.env.HEARTBEAT_INTERVAL_MS; else process.env.HEARTBEAT_INTERVAL_MS = saved.every;
  });

  test('not configured: nothing is sent', async () => {
    delete process.env.HEARTBEAT_URL;
    let n = 0;
    assert.equal(await pingHeartbeat(T0, (async () => { n++; return { status: 200, headers: {}, text: '' }; }) as any), false);
    assert.equal(n, 0);
  });

  test('pinged through the outbound guard at most once per interval; a failed ping is retried', async () => {
    process.env.HEARTBEAT_URL = 'https://hc-ping.example/abc';
    const urls: string[] = [];
    let status = 200;
    const fetcher = (async (u: string) => { urls.push(u); return { status, headers: {}, text: 'OK' }; }) as any;
    assert.equal(await pingHeartbeat(T0, fetcher), true);
    assert.equal(await pingHeartbeat(T0 + 30_000, fetcher), false, 'within the minute');
    assert.equal(await pingHeartbeat(T0 + 61_000, fetcher), true);
    status = 500;
    assert.equal(await pingHeartbeat(T0 + 122_000, fetcher), false);
    assert.equal(workerHealthReport().heartbeat.lastError, 'HTTP 500');
    status = 200;
    assert.equal(await pingHeartbeat(T0 + 123_000, fetcher), true, 'a failure does not wait out the interval');
    assert.deepEqual(urls, Array(4).fill('https://hc-ping.example/abc'));
  });

  test('the real guarded fetch refuses a URL the outbound guard does not allow', async () => {
    process.env.HEARTBEAT_URL = 'ftp://example.com/x';
    assert.equal(await pingHeartbeat(T0), false);
    assert.match(String(workerHealthReport().heartbeat.lastError), /only http\(s\)/);
  });
});

// ─────────────────────────────────────────── against the database

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[worker-health.test] SKIPPING database-backed suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
const SLUG = 'worker-health-test';

dbDescribe('worker health: alerts in the alert table', () => {
  let orgId = '';
  const savedOrg = process.env.OPS_ALERT_ORG_ID;
  before(async () => {
    await dbLock.acquire();
    orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug) VALUES ('Worker Health Test', $1) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    await query(`DELETE FROM alert WHERE org_id = $1`, [orgId]);
    process.env.OPS_ALERT_ORG_ID = orgId;
    resetOpsAlertOrgCache();
  });
  after(async () => {
    await query(`DELETE FROM alert WHERE org_id = $1`, [orgId]);
    if (savedOrg === undefined) delete process.env.OPS_ALERT_ORG_ID; else process.env.OPS_ALERT_ORG_ID = savedOrg;
    resetOpsAlertOrgCache();
    workerStats.clear();
    await dbLock.release();
    await pool.end();
  });

  test('one open critical alert across a restart, resolved on recovery', async () => {
    workerStats.clear();
    const now = Date.now();
    let s = stat('refunds', 5 * MIN, now - 30 * MIN);
    for (let i = 0; i < HEALTH_RULES.failures; i++) recordOutcome(s, boom, now - 20 * MIN + i * MIN);
    assert.equal(await checkWorkers(now), false);

    // The gateway restarts while the worker is still failing: fresh state, same open alert.
    workerStats.clear();
    s = stat('refunds', 5 * MIN, now - 30 * MIN);
    for (let i = 0; i < HEALTH_RULES.failures; i++) recordOutcome(s, boom, now - 10 * MIN + i * MIN);
    await checkWorkers(now);

    const open = await many<{ severity: string; occurrences: number; message: string; resolved_at: Date | null }>(
      `SELECT severity, occurrences, message, resolved_at FROM alert WHERE org_id = $1 AND kind = $2 AND target_type = 'worker' AND target_id = 'refunds'`,
      [orgId, WORKER_ALERT_KIND]);
    assert.equal(open.length, 1, 'de-duplicated into one row');
    assert.equal(open[0]!.occurrences, 2);
    assert.equal(open[0]!.severity, 'critical', 'refunds move money');
    assert.match(open[0]!.message, /"refunds" has failed 3 times in a row.*ECONNREFUSED/);
    assert.equal(open[0]!.resolved_at, null);

    recordOutcome(s, null, now);
    assert.equal(await checkWorkers(now), true);
    const row = await one<{ resolved_at: Date | null }>(
      `SELECT resolved_at FROM alert WHERE org_id = $1 AND kind = $2 AND target_id = 'refunds'`, [orgId, WORKER_ALERT_KIND]);
    assert.ok(row?.resolved_at, 'auto-resolved');
  });

  test('a non-money worker raises a warning', async () => {
    workerStats.clear();
    const now = Date.now();
    const s = stat('roaming-prune', 6 * 60 * MIN, now - 30 * MIN);
    for (let i = 0; i < HEALTH_RULES.failures; i++) recordOutcome(s, boom, now - 10 * MIN);
    await checkWorkers(now);
    const row = await one<{ severity: string }>(
      `SELECT severity FROM alert WHERE org_id = $1 AND kind = $2 AND target_id = 'roaming-prune' AND resolved_at IS NULL`, [orgId, WORKER_ALERT_KIND]);
    assert.equal(row?.severity, 'warning');
  });
});
