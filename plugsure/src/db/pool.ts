import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Keep IDR integers as numbers, and NUMERIC as strings we parse deliberately.
// (node-pg returns NUMERIC as string by default, which is what we want for money.)
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000,
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
}

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
  try {
    await client.query('BEGIN');
    // set_config's third argument = true means "local to this transaction",
    // and the parameterised form keeps the org id out of the SQL text.
    await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
    const out = await scope.run({ client, orgId }, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export interface OrgScopeHandle {
  client: pg.PoolClient;
  orgId: string;
  /** Commit and release. Safe to call twice. */
  commit(): Promise<void>;
  /** Roll back and release. Safe to call twice. */
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
    await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
  } catch (e) {
    client.release();
    throw e;
  }
  store.client = client;
  store.orgId = orgId;
  const finish = async (verb: 'COMMIT' | 'ROLLBACK') => {
    if (settled) return;
    settled = true;
    // Unbind BEFORE releasing, so nothing in this context can reach the client
    // once it is back in the pool.
    if (store.client === client) {
      store.client = null;
      store.orgId = null;
    }
    try {
      await client.query(verb);
    } catch (e) {
      logger.warn({ err: e, verb }, 'failed to close request transaction');
    } finally {
      client.release();
    }
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

/** Log the RLS posture at boot; refuse to start in production without it. */
export async function assertRlsPosture(): Promise<void> {
  const p = await rlsPosture().catch(() => null);
  if (!p) return;
  if (p.effective) {
    logger.info({ dbUser: p.user }, 'row-level security is in force for application queries');
    return;
  }
  const message =
    `The database user "${p.user}" ${p.superuser ? 'is a superuser' : 'has BYPASSRLS'}, so every ` +
    `row-level security policy is ignored and tenant isolation rests entirely on the query layer. ` +
    `Connect as plugsure_app (migration 006 gives it LOGIN and the grants it needs) — ` +
    `see deploy/README.md.`;
  if (config.env === 'production') throw new Error(message);
  logger.warn(message);
}
