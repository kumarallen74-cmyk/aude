import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query, one } from './pool.js';
import { logger } from '../logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '../../db/migrations');

/**
 * One migrator at a time, cluster-wide: a session-level advisory lock on a fixed
 * key, held on a dedicated connection for the whole run.
 *
 * Nothing stopped two migrators running at once — `docker compose up` on two
 * hosts, a systemd ExecStartPre racing a manual `npm run migrate`, two replicas
 * of a migrate job. Both read schema_migration, both applied the same file, and
 * the loser failed half way (or, for a non-idempotent file, both succeeded). The
 * second runner now waits for the first, then finds everything applied.
 */
const MIGRATION_LOCK_KEY = 'plugsure.schema_migration';

/**
 * How long one migration may WAIT for a table lock (env MIGRATION_LOCK_TIMEOUT,
 * a Postgres interval such as '10s' or '500ms'; default 10s, '0' = wait forever).
 *
 * An ALTER TABLE queues for an ACCESS EXCLUSIVE lock behind any long transaction
 * on that table — and every query that arrives after it queues behind the ALTER.
 * With no timeout one slow report during a deploy stalled the gateway's frame
 * writes and every API request touching the table. With it the migration fails
 * fast (the transaction rolls back, nothing half-applied) and can be retried.
 */
export function migrationLockTimeout(raw = process.env.MIGRATION_LOCK_TIMEOUT): string {
  const v = (raw ?? '10s').trim();
  if (!/^\d+\s*(us|ms|s|min|h|d)?$/.test(v)) {
    throw new Error(`MIGRATION_LOCK_TIMEOUT must be a duration like 10s, 500ms or 2min, got ${JSON.stringify(raw)}`);
  }
  return v;
}

async function main() {
  const lockTimeout = migrationLockTimeout();
  const lock = await pool.connect();
  let lockHealthy = true;
  try {
    const waiting = setTimeout(() => logger.info('waiting for another migrator to finish (advisory lock)'), 2_000);
    await lock.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [MIGRATION_LOCK_KEY]);
    clearTimeout(waiting);
    try {
      await migrateAll(lockTimeout);
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [MIGRATION_LOCK_KEY]).catch(() => { lockHealthy = false; });
    }
  } finally {
    lock.release(lockHealthy ? undefined : true);
  }
  await provisionRuntimeRole();
  await pool.end();
}

async function migrateAll(lockTimeout: string) {
  await query(`CREATE TABLE IF NOT EXISTS schema_migration (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  // Read under the lock: a migrator that waited sees what the first one applied.
  const applied = new Set(
    (await query<{ name: string }>('SELECT name FROM schema_migration')).rows.map((r) => r.name),
  );

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  for (const f of files) {
    if (applied.has(f)) {
      logger.debug({ migration: f }, 'already applied');
      continue;
    }
    const sql = await readFile(join(migrationsDir, f), 'utf8');
    logger.info({ migration: f, lockTimeout }, 'applying migration');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Transaction-local: ends with this migration's COMMIT / ROLLBACK.
      await client.query(`SELECT set_config('lock_timeout', $1, true)`, [lockTimeout]);
      await client.query(sql);
      await client.query('INSERT INTO schema_migration (name) VALUES ($1)', [f]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      if ((e as { code?: string }).code === '55P03') {
        logger.error({ migration: f, lockTimeout },
          'migration could not get a table lock within MIGRATION_LOCK_TIMEOUT (a long transaction holds it); nothing was applied — retry, or find the blocker in pg_stat_activity');
      } else {
        logger.error({ migration: f, err: e }, 'migration failed');
      }
      throw e;
    } finally {
      client.release();
    }
  }
  logger.info({ count: files.length }, 'migrations up to date');
}

/**
 * Give the runtime role a password so the applications can actually connect.
 *
 * Migration 006 creates `plugsure_app` with LOGIN and the right grants, but a
 * role with no password cannot authenticate over TCP — and the applications
 * refuse to start as a superuser, because a superuser bypasses every row-level
 * security policy. Between those two facts there was no DATABASE_URL a
 * production process would accept: the documented container path could not come
 * up at all.
 *
 * The migrator runs as the owner and is the one place that legitimately holds
 * DDL rights, so this belongs here rather than in a shell one-liner in
 * docker-compose.yml where the quoting is unreadable and untestable.
 *
 * Skipped silently when POSTGRES_APP_PASSWORD is unset — a developer running
 * against a local superuser DSN does not need it.
 */
async function provisionRuntimeRole() {
  const role = process.env.POSTGRES_APP_USER ?? 'plugsure_app';
  const password = process.env.POSTGRES_APP_PASSWORD;
  if (!password) return;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
    throw new Error(`POSTGRES_APP_USER must be a plain lowercase identifier, got ${JSON.stringify(role)}`);
  }

  /**
   * ALTER ROLE and GRANT cannot take bind parameters, and a DO block cannot
   * either — so the statements are BUILT by Postgres itself with format(%I/%L)
   * over bound values, then executed. That keeps the password out of the SQL we
   * write by hand, and lets Postgres do the quoting it alone gets right.
   */
  const built = await one<{ alter_sql: string; grant_sql: string }>(
    `SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS alter_sql,
            format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), $1::text) AS grant_sql`,
    [role, password],
  );
  if (!built) throw new Error('could not build the runtime role statements');
  await query(built.alter_sql);
  await query(built.grant_sql);
  logger.info({ role }, 'runtime role provisioned — the applications connect as this, not as the owner');
}

// Always runs when loaded, as before (an entry-point check by path would silently
// skip migrating under a symlinked deploy root). A unit test that only wants
// migrationLockTimeout() sets PLUGSURE_MIGRATE_IMPORT_ONLY before importing.
if (!process.env.PLUGSURE_MIGRATE_IMPORT_ONLY) {
  main().catch((e) => {
    logger.error(e);
    process.exit(1);
  });
}
