import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query, one } from './pool.js';
import { logger } from '../logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '../../db/migrations');

async function main() {
  await query(`CREATE TABLE IF NOT EXISTS schema_migration (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

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
    logger.info({ migration: f }, 'applying migration');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migration (name) VALUES ($1)', [f]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      logger.error({ migration: f, err: e }, 'migration failed');
      throw e;
    } finally {
      client.release();
    }
  }
  logger.info({ count: files.length }, 'migrations up to date');
  await provisionRuntimeRole();
  await pool.end();
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

main().catch((e) => {
  logger.error(e);
  process.exit(1);
});
