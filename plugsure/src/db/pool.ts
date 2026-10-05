import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config, isRelaxedEnv } from '../config.js';
import { logger } from '../logger.js';

// Keep IDR integers as numbers, and NUMERIC as strings we parse deliberately.
// (node-pg returns NUMERIC as string by default, which is what we want for money.)
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

/** A non-negative integer from the environment, or the default. */
function envMs(name: string, d: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return d;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer (milliseconds), got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * Connection limits.
 *
 * There were none: no connect timeout (a saturated pool or an unreachable
 * database made every request hang until the client gave up), no statement
 * timeout (one runaway query held a pooled connection and its locks forever),
 * and a hard-coded pool size.
 *
 * - `PG_CONNECT_TIMEOUT_MS` (10 s): how long `pool.connect()` waits for a
 *   connection — a new one, or a free one from a saturated pool — before failing.
 * - `PG_STATEMENT_TIMEOUT_MS` (30 s): per STATEMENT, sent as a startup parameter
 *   so it holds on every connection the pool opens. A request transaction that
 *   is merely open is not running a statement, so this never kills one.
 * - `PG_IDLE_IN_TX_TIMEOUT_MS` (0 = off): deliberately OFF by default. A
 *   firmware upload (POST /v1/firmware/images/upload, up to MAX_FIRMWARE_BYTES)
 *   streams the request body to disk INSIDE the request's org-scoped
 *   transaction, which sits idle-in-transaction for as long as the upload takes
 *   — 15 minutes and more on a slow site link. A timeout here would terminate
 *   the session under the upload and fail it at the end. Set it (e.g. 1800000)
 *   only if no upload can take that long on your network.
 * - `PG_POOL_MAX` (20).
 *
 * The migrator shares this pool, so a data migration with a single statement
 * longer than PG_STATEMENT_TIMEOUT_MS needs `SET LOCAL statement_timeout = 0`
 * at its top, or the runner started with PG_STATEMENT_TIMEOUT_MS=0.
 */
export const poolLimits = {
  max: envMs('PG_POOL_MAX', 20) || 20,
  connectionTimeoutMillis: envMs('PG_CONNECT_TIMEOUT_MS', 10_000),
  statementTimeoutMs: envMs('PG_STATEMENT_TIMEOUT_MS', 30_000),
  idleInTransactionTimeoutMs: envMs('PG_IDLE_IN_TX_TIMEOUT_MS', 0),
};

/**
 * Row-level security bypass, explicit and per connection (migration 048).
 *
 * The policies used to read `app_current_org() IS NULL OR org_id = …`: an
 * unset org meant "every row". That was how the unscoped processes worked —
 * the OCPP gateway, the workers, the driver API (/d/*), OCPI (/ocpi/*),
 * payment notifications (/pay/*), login, SSE — but it also meant that inside
 * a tenant's request, anything that lost or blanked the org saw every tenant.
 *
 * Now the policies read `app_rls_bypass() OR org_id = app_current_org()`.
 * Every pooled connection starts with the bypass ON at SESSION level — a
 * startup parameter (`options` on the pool below), so it is in force before
 * the first query with no window and no extra round trip — and the unscoped
 * processes are unchanged. `enterOrgScope`/`withOrg` switch it OFF with
 * `set_config(..., true)` — LOCAL to the request transaction — together with
 * the org. Inside a request, a missing org therefore matches nothing.
 *
 * LOCAL settings end with their transaction (COMMIT or ROLLBACK), so a client
 * goes back to the pool with the session value (bypass on, no org) restored;
 * the pool never hands out a connection still scoped to the last tenant.
 * (A SET from the pool's 'connect' event would do the same, but it queues
 * behind the first caller's query — deprecated in node-pg, gone in pg@9.)
 *
 * `connectionWithBypass` appends `-c app.rls_bypass=on` to any `options` the
 * DATABASE_URL already carries. node-pg lets a URL parameter override the
 * config object, so the URL's own `options` is moved into ours rather than
 * left to replace it.
 */
export function connectionWithBypass(url: string): { connectionString: string; options: string } {
  const bypass = '-c app.rls_bypass=on';
  try {
    const u = new URL(url);
    const own = u.searchParams.get('options');
    if (own === null) return { connectionString: url, options: bypass };
    u.searchParams.delete('options');
    return { connectionString: u.toString(), options: `${own} ${bypass}` };
  } catch {
    return { connectionString: url, options: bypass };
  }
}

export const pool = new pg.Pool({
  ...connectionWithBypass(config.databaseUrl),
  max: poolLimits.max,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: poolLimits.connectionTimeoutMillis,
  // 0 means "no limit" to Postgres too; omit rather than send it.
  ...(poolLimits.statementTimeoutMs ? { statement_timeout: poolLimits.statementTimeoutMs } : {}),
  ...(poolLimits.idleInTransactionTimeoutMs ? { idle_in_transaction_session_timeout: poolLimits.idleInTransactionTimeoutMs } : {}),
});

/**
 * An idle pooled client whose connection dies (a database restart, a network
 * blip, an administrator's pg_terminate_backend) makes the POOL emit 'error'.
 * With no listener that is an uncaught exception and the whole process exits —
 * the gateway dropping every charger because Postgres restarted. The pool has
 * already discarded the client; log and carry on.
 */
pool.on('error', (err) => {
  logger.error({ err: err.message, code: (err as { code?: string }).code }, 'idle database connection failed; the pool discarded it');
});

/**
 * The database client the current async context should use.
 *
 * This exists so Postgres row-level security can actually BIND. The policies
 * from migration 002 test `app_current_org()`, which reads the
 * `app.current_org_id` GUC — and nothing ever set it, so `app_current_org()`
 * returned NULL, every policy short-circuited to true, and RLS was decorative.
 * The README said enforcement was "at the query layer, with RLS as the second
 * line of defence"; there was no second line.
 *
 * The GUC is per-session, and `SET LOCAL` is per-transaction, so the org has to
 * be pinned to a connection that every query in the request then uses. Threading
 * a client parameter through every call site would be a rewrite; an
 * AsyncLocalStorage keeps `query`/`one`/`many` unchanged at ~200 call sites and
 * makes the scoped client the default inside a request.
 */
interface Scope {
  /** Null until the request has authenticated and claimed a connection. */
  client: pg.PoolClient | null;
  orgId: string | null;
  /**
   * Work to run if the bound transaction does NOT commit — after its ROLLBACK,
   * on a fresh connection, outside this scope. Set together with `client`.
   * See `onScopeRollback`.
   */
  rollbackHooks?: RollbackHook[];
}

/** Why a scoped transaction ended without committing. */
export type ScopeRollbackReason = 'rolled_back' | 'commit_failed';
type RollbackHook = (reason: ScopeRollbackReason) => Promise<void>;

const scope = new AsyncLocalStorage<Scope>();

/**
 * The client for this async context, or the pool when unscoped.
 *
 * The `client.release()`-then-reuse hazard is guarded here rather than trusted:
 * a released or ended client must never silently serve a query, because the
 * failure mode is not an error but a query running on someone else's
 * transaction.
 */
function conn(): pg.PoolClient | pg.Pool {
  const c = scope.getStore()?.client;
  if (!c) return pool;
  const anyC = c as unknown as { _ending?: boolean; _ended?: boolean };
  if (anyC._ending || anyC._ended) {
    logger.error('a released database client was still bound to this async context — falling back to the pool');
    return pool;
  }
  return c;
}

/**
 * Establish a request-scoped store and run `fn` inside it.
 *
 * This is `run`, NOT `enterWith`, and the difference is not cosmetic.
 * `enterWith` writes the store onto the current async RESOURCE, and Node pools
 * and reuses `HTTPParser` objects process-wide — so a store set during an API
 * request rode a recycled parser out of the HTTP server and into the OCPP
 * gateway's WebSocket upgrade in the same process. Every charger frame after
 * the first console page load then resolved to the API request's already
 * released client: BootNotification failed, the frame log stopped recording,
 * and the process died. `run` confines the store to this call's own subtree.
 *
 * The store is created empty and filled in later, because authentication has
 * not happened yet at the point the context must be established.
 */
export function runInRequestScope(fn: () => void): void {
  scope.run({ client: null, orgId: null }, fn);
}

/**
 * Run `fn` with NO request scope, i.e. on the plain pool.
 *
 * Fire-and-forget work started inside a handler (dispatching a control loop
 * after a budget change) otherwise inherits the request's pinned transaction: a
 * failing query there aborts it, and the COMMIT that follows silently rolls back
 * the operator's own write. Use together with the response's 'finish' event so
 * the work starts only after the request transaction has committed.
 */
export function outsideRequestScope<T>(fn: () => T): T {
  return scope.exit(fn);
}

/**
 * Start `fn` once the HTTP response has been written (so the request
 * transaction has committed), outside the request scope. Errors are handed to
 * `onError`, never thrown.
 */
export function afterResponse(
  res: { once(event: 'finish', cb: () => void): unknown },
  fn: () => Promise<unknown>,
  onError: (e: Error) => void = () => {},
): void {
  res.once('finish', () => outsideRequestScope(() => void fn().catch((e) => onError(e as Error))));
}

/** The organisation pinned to this async context, if any. Diagnostics only. */
export function currentScopeOrg(): string | null {
  return scope.getStore()?.orgId ?? null;
}

/**
 * Register `fn` to run if the transaction bound to this async context ends
 * WITHOUT committing — a 4xx/5xx reply, a thrown handler, a failed COMMIT.
 *
 * Returns false (and registers nothing) when no transaction is bound: then
 * nothing will roll the caller's work back, and there is nothing to make up.
 *
 * The hook runs after the ROLLBACK, after the connection is back in the pool,
 * and OUTSIDE the request scope (so its own queries open their own transaction
 * on the pool rather than reaching for the client that just rolled back). It
 * is awaited before the reply is written when the rollback happens in onSend.
 * Errors are logged, never thrown. This exists for the audit log: a record of
 * a failed operation must survive the failure (src/services/audit.ts).
 */
export function onScopeRollback(fn: RollbackHook): boolean {
  const s = scope.getStore();
  if (!s?.client || !s.rollbackHooks) return false;
  s.rollbackHooks.push(fn);
  return true;
}

async function runRollbackHooks(hooks: RollbackHook[], reason: ScopeRollbackReason): Promise<void> {
  // splice: each hook runs at most once even if a caller settles twice.
  for (const h of hooks.splice(0)) {
    try {
      await outsideRequestScope(() => h(reason));
    } catch (e) {
      logger.error({ err: e, reason }, 'work registered for a rolled-back request transaction failed');
    }
  }
}

/**
 * Pin the transaction's tenant AND switch the RLS bypass off, both LOCAL.
 *
 * One statement, so the two never disagree. (A pinned org also beats the
 * bypass in `app_rls_bypass()` itself — see migration 048 — so an org with the
 * bypass still on would be isolated anyway.) An empty or missing org is passed
 * through as '' on purpose: with the bypass off, `org_id = NULL` matches
 * nothing, so a request that lost its tenant sees no rows instead of all of
 * them.
 */
async function pinOrg(client: pg.PoolClient, orgId: string): Promise<void> {
  await client.query(
    `SELECT set_config('app.current_org_id', $1, true), set_config('app.rls_bypass', 'off', true)`,
    [orgId ?? ''],
  );
}

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return conn().query<T>(text, params as any[]);
}

export async function one<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const r = await query<T>(text, params);
  return r.rows[0] ?? null;
}

export async function many<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await query<T>(text, params);
  return r.rows;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  // Already inside a request-scoped transaction: join it rather than opening a
  // second one on a different connection, which would deadlock against our own
  // row locks and escape the RLS scope.
  const existing = scope.getStore()?.client;
  if (existing) return fn(existing);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` with every query pinned to one connection whose `app.current_org_id`
 * is set, inside a transaction that commits on success and rolls back on throw.
 *
 * This is what makes RLS real: a query that forgets its `WHERE org_id = $1` now
 * returns nothing instead of another tenant's rows.
 *
 * Note the connection cost — one pooled client is held for the duration — so
 * this belongs around a request, never around a long-lived stream. Callers that
 * hold a connection indefinitely (SSE) must stay outside it.
 */
export async function withOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const rollbackHooks: RollbackHook[] = [];
  let reason: ScopeRollbackReason = 'rolled_back';
  let out: T;
  try {
    await client.query('BEGIN');
    // set_config's third argument = true means "local to this transaction",
    // and the parameterised form keeps the org id out of the SQL text.
    await pinOrg(client, orgId);
    out = await scope.run({ client, orgId, rollbackHooks }, fn);
    reason = 'commit_failed';
    await commitOrThrow(client);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await runRollbackHooks(rollbackHooks, reason);
    throw e;
  }
  client.release();
  return out;
}

/**
 * COMMIT, and treat Postgres quietly turning it into a ROLLBACK as the failure
 * it is. A COMMIT of a transaction that has already hit an error (a handler
 * that caught a failed query and carried on) does not raise — it answers with
 * the command tag ROLLBACK and every write of the request is gone.
 */
async function commitOrThrow(client: pg.PoolClient): Promise<void> {
  const r = await client.query('COMMIT');
  if (r.command === 'ROLLBACK') {
    throw new Error('COMMIT was turned into a ROLLBACK: a statement in this transaction had already failed, so none of its writes were kept');
  }
}

export interface OrgScopeHandle {
  client: pg.PoolClient;
  orgId: string;
  /**
   * Commit and release. Safe to call twice: only the first call does anything.
   * REJECTS if the commit did not happen (an error, or Postgres answering a
   * COMMIT of an already-failed transaction with ROLLBACK) — the caller must
   * not report success for writes that were lost.
   */
  commit(): Promise<void>;
  /** Roll back and release. Safe to call twice. Never rejects. */
  rollback(): Promise<void>;
}

/**
 * Open an org-scoped transaction and bind it to the CURRENT async context, so
 * that every continuation of this request uses it without threading a client.
 *
 * `withOrg` cannot be used across an HTTP framework's hook boundary — the route
 * handler runs on a continuation of the hook runner, not of the callback — so
 * the store is established up front by `runInRequestScope` (an `onRequest` hook)
 * and merely POPULATED here, once authentication has resolved the tenant. The
 * caller must run commit/rollback from the response hooks.
 */
export async function enterOrgScope(orgId: string): Promise<OrgScopeHandle> {
  const store = scope.getStore();
  if (!store) {
    throw new Error(
      'enterOrgScope called outside a request scope. The caller must establish one with ' +
        'runInRequestScope first — binding the store any other way (enterWith) leaks it into ' +
        'unrelated work sharing a recycled async resource.',
    );
  }

  const client = await pool.connect();
  let settled = false;
  try {
    await client.query('BEGIN');
    await pinOrg(client, orgId);
  } catch (e) {
    // The connection's state is unknown (a half-open transaction?): destroy it
    // rather than return it to the pool.
    client.release(true);
    throw e;
  }
  const rollbackHooks: RollbackHook[] = [];
  store.client = client;
  store.orgId = orgId;
  store.rollbackHooks = rollbackHooks;
  const finish = async (verb: 'COMMIT' | 'ROLLBACK') => {
    if (settled) return;
    settled = true;
    // Unbind BEFORE releasing, so nothing in this context can reach the client
    // once it is back in the pool.
    if (store.client === client) {
      store.client = null;
      store.orgId = null;
      store.rollbackHooks = undefined;
    }
    let failure: unknown = null;
    try {
      if (verb === 'COMMIT') await commitOrThrow(client);
      else await client.query('ROLLBACK');
    } catch (e) {
      failure = e;
    }
    // A client whose COMMIT or ROLLBACK failed is in an unknown state (still
    // inside the transaction, with this tenant's LOCAL org and the bypass off?
    // a dead socket?). Destroy it rather than hand it to the next request;
    // otherwise LOCAL settings ended with the transaction and the client goes
    // back with its session defaults (bypass on, no org).
    client.release(failure ? true : undefined);

    if (verb === 'ROLLBACK' || failure) {
      await runRollbackHooks(rollbackHooks, verb === 'COMMIT' ? 'commit_failed' : 'rolled_back');
    }
    if (!failure) return;
    if (verb === 'ROLLBACK') {
      logger.warn({ err: failure }, 'failed to roll back request transaction; the connection was discarded');
      return;
    }
    // A failed COMMIT after a successful handler used to be logged at warn and
    // the 2xx sent anyway: the client was told its write happened when it had
    // not. Throw, so the response hook can turn the reply into a 500 — or, if
    // the reply has already gone, log it at error with the request id.
    throw new Error(`the request transaction did not commit: ${(failure as Error)?.message ?? String(failure)}`, { cause: failure });
  };
  return {
    client,
    orgId,
    commit: () => finish('COMMIT'),
    rollback: () => finish('ROLLBACK'),
  };
}

/**
 * Report whether row-level security can actually constrain this connection.
 *
 * A superuser — and any role with BYPASSRLS — ignores every policy, including
 * FORCE ROW LEVEL SECURITY. Connecting as `postgres`, which the default
 * DATABASE_URL does, therefore leaves RLS switched on and doing nothing at all.
 * Say so at boot rather than letting a deployment believe it has a second line
 * of defence it does not have.
 */
export async function rlsPosture(): Promise<{
  user: string;
  superuser: boolean;
  bypassRls: boolean;
  effective: boolean;
}> {
  const r = await pool.query<{ user: string; super: boolean; bypass: boolean }>(
    `SELECT current_user AS user, rolsuper AS super, rolbypassrls AS bypass
       FROM pg_roles WHERE rolname = current_user`,
  );
  const row = r.rows[0];
  const superuser = Boolean(row?.super);
  const bypassRls = Boolean(row?.bypass);
  return {
    user: row?.user ?? 'unknown',
    superuser,
    bypassRls,
    effective: !superuser && !bypassRls,
  };
}

/**
 * Log the RLS posture at boot; refuse to start in production without it.
 *
 * Fails CLOSED: if the posture query itself fails, outside development/test
 * that is a refusal to start, not a silent pass — "could not check" used to be
 * indistinguishable from "checked and fine".
 */
export async function assertRlsPosture(env?: string): Promise<void> {
  const relaxed = isRelaxedEnv(env);
  let p: Awaited<ReturnType<typeof rlsPosture>>;
  try {
    p = await rlsPosture();
  } catch (e) {
    const message = `Could not determine whether row-level security constrains the database user: ${(e as Error).message}`;
    if (!relaxed) throw new Error(message, { cause: e });
    logger.warn(message);
    return;
  }
  await warnOnWeakenedGuards(p.effective);
  if (p.effective) {
    logger.info({ dbUser: p.user }, 'row-level security is in force for application queries');
    return;
  }
  const message =
    `The database user "${p.user}" ${p.superuser ? 'is a superuser' : 'has BYPASSRLS'}, so every ` +
    `row-level security policy is ignored and tenant isolation rests entirely on the query layer. ` +
    `Connect as plugsure_app (migration 006 gives it LOGIN and the grants it needs) — ` +
    `see deploy/README.md.`;
  if (!relaxed) throw new Error(message);
  logger.warn(message);
}

/**
 * Migration 048 rewrote every `app_current_org() IS NULL OR …` policy to the
 * fail-closed `app_rls_bypass() OR …`, and revoked UPDATE/DELETE on audit_log
 * from the runtime role. A later migration that copies the old policy shape
 * re-opens its table to every tenant inside a request, and one that re-runs
 * `GRANT … ON ALL TABLES` hands audit_log back (the 048 trigger still refuses
 * the writes). Neither stops the boot; both are logged loudly.
 */
async function warnOnWeakenedGuards(runtimeRole: boolean): Promise<void> {
  if (runtimeRole) {
    const g = await pool
      .query<{ w: boolean }>(`SELECT has_table_privilege('audit_log', 'UPDATE') OR has_table_privilege('audit_log', 'DELETE') AS w`)
      .catch(() => null);
    if (g?.rows[0]?.w) {
      logger.error('the database user holds UPDATE or DELETE on audit_log (re-granted after migration 048?); REVOKE them — the append-only trigger is now the only guard');
    }
  }
  const r = await pool
    .query<{ t: string }>(
      `SELECT tablename || '.' || policyname AS t FROM pg_policies
        WHERE schemaname = 'public'
          AND (qual LIKE '%app_current_org() IS NULL%' OR with_check LIKE '%app_current_org() IS NULL%')`,
    )
    .catch(() => null);
  if (r?.rows.length) {
    logger.error(
      { policies: r.rows.map((x) => x.t) },
      'row-level security policies still use the fail-open "app_current_org() IS NULL OR ..." shape; ' +
        'write them as "app_rls_bypass() OR org_id = app_current_org()" (see migration 048)',
    );
  }
}

/**
 * Session advisory locks need a connection held for the whole critical section; they come from this small separate
 * pool so code inside the section can still use `pool` freely (taking both from one pool could exhaust it).
 */
let lockPool: pg.Pool | null = null;
export async function withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!lockPool) {
    lockPool = new pg.Pool({ ...connectionWithBypass(config.databaseUrl), max: 8, idleTimeoutMillis: 30_000, allowExitOnIdle: true, connectionTimeoutMillis: poolLimits.connectionTimeoutMillis });
    lockPool.on('error', (err) => logger.warn({ err: err.message }, 'advisory lock connection lost'));
  }
  const c = await lockPool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    try {
      return await fn();
    } finally {
      await c.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => {});
    }
  } finally {
    c.release();
  }
}
export async function endLockPool(): Promise<void> {
  const p = lockPool;
  lockPool = null;
  await p?.end().catch(() => {});
}
