import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

/**
 * Migration 048, proven as the RUNTIME role.
 *
 * The rest of the suite connects as the postgres superuser, which ignores every
 * row-level security policy — so it cannot show that RLS does anything. This
 * file points the application pool at `plugsure_app` (RLS_TEST_APP_URL) and
 * keeps a separate superuser pool only for fixtures and cleanup.
 *
 * Runs only against the disposable database (plugsure_audit_fix); skipped
 * anywhere else.
 */
const SUPER_URL = process.env.DATABASE_URL ?? '';
/**
 * The runtime role's connection: the test database's host, port and name, as
 * POSTGRES_APP_USER (default plugsure_app) with POSTGRES_APP_PASSWORD — the
 * password `npm run migrate` provisions. RLS_TEST_APP_URL overrides it. Without
 * a password there is no way to connect as the runtime role: skipped, loudly.
 */
function appUrl(): string | null {
  if (process.env.RLS_TEST_APP_URL) return process.env.RLS_TEST_APP_URL;
  const password = process.env.POSTGRES_APP_PASSWORD;
  if (!password || !SUPER_URL) return null;
  const u = new URL(SUPER_URL);
  u.username = process.env.POSTGRES_APP_USER ?? 'plugsure_app';
  u.password = password;
  return u.toString();
}
const APP_URL = appUrl();
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(SUPER_URL) && APP_URL !== null;
if (DB_OK) process.env.DATABASE_URL = APP_URL!;

// Imported only now, so config.databaseUrl — and with it the pool — is the runtime role.
const { pool, query, one, runInRequestScope, enterOrgScope, withOrg } = await import('./pool.js');
const { writeAudit, verifyChain, NIL_ORG } = await import('../services/audit.js');
const { databaseTestLock } = await import('./test-lock.js');

const dbDescribe = DB_OK ? describe : describe.skip;
if (!DB_OK) {
  console.warn(
    '[rls-fail-closed.test] SKIPPED: needs DATABASE_URL on the plugsure_audit_fix test database and ' +
      'POSTGRES_APP_PASSWORD (as given to `npm run migrate`) or RLS_TEST_APP_URL to connect as the runtime role',
  );
}

const dbLock = databaseTestLock('shared', DB_OK);
const su = DB_OK ? new pg.Pool({ connectionString: SUPER_URL, max: 2 }) : null;

const tag = randomBytes(5).toString('hex');
let ORG_A = '';
let ORG_B = '';
let SITE_A = '';
let SITE_B = '';

/** Run `fn` the way the API runs a handler: inside a request scope. */
function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => runInRequestScope(() => void fn().then(resolve, reject)));
}

async function siteIdsVisible(): Promise<string[]> {
  const r = await query<{ id: string }>(`SELECT id FROM site WHERE id = ANY($1::uuid[]) ORDER BY name`, [[SITE_A, SITE_B]]);
  return r.rows.map((x) => x.id);
}

if (DB_OK) {
  before(async () => {
    await dbLock.acquire();
    const mk = async (n: string) =>
      (await su!.query<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`RLS ${n}`, `rls-${n}-${tag}`])).rows[0]!.id;
    ORG_A = await mk('a');
    ORG_B = await mk('b');
    SITE_A = (await su!.query<{ id: string }>(`INSERT INTO site (org_id, name) VALUES ($1, 'RLS site A') RETURNING id`, [ORG_A])).rows[0]!.id;
    SITE_B = (await su!.query<{ id: string }>(`INSERT INTO site (org_id, name) VALUES ($1, 'RLS site B') RETURNING id`, [ORG_B])).rows[0]!.id;
  });

  after(async () => {
    // audit_log is append-only for every role since 048; the test-only way out is
    // the superuser with row triggers switched off (session_replication_role).
    const c = await su!.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`);
      await c.query(`DELETE FROM audit_log WHERE org_id = ANY($1::uuid[])`, [[ORG_A, ORG_B]]);
      await c.query(`DELETE FROM audit_head WHERE org_id = ANY($1::uuid[])`, [[ORG_A, ORG_B]]);
      await c.query(`DELETE FROM site WHERE org_id = ANY($1::uuid[])`, [[ORG_A, ORG_B]]);
      await c.query(`DELETE FROM organisation WHERE id = ANY($1::uuid[])`, [[ORG_A, ORG_B]]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    await su!.end();
    await pool.end();
    await dbLock.release();
  });
}

dbDescribe('RLS fails closed (as plugsure_app)', () => {
  test('the test really runs as a role RLS binds', async () => {
    const r = await one<{ u: string; s: boolean; b: boolean }>(
      `SELECT current_user AS u, rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname = current_user`,
    );
    assert.equal(r?.u, 'plugsure_app');
    assert.equal(r?.s, false);
    assert.equal(r?.b, false);
  });

  test('an unscoped pooled connection (gateway, workers, /d, /ocpi, /pay) has the bypass on and sees every tenant', async () => {
    assert.equal((await one<{ v: string }>(`SELECT current_setting('app.rls_bypass') AS v`))?.v, 'on');
    assert.deepEqual(new Set(await siteIdsVisible()), new Set([SITE_A, SITE_B]));
  });

  test('bypass off and NO org: zero rows everywhere, and nothing can be written', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.current_org_id', '', true), set_config('app.rls_bypass', 'off', true)`);
      for (const t of ['site', 'charge_point', 'charging_session', 'audit_log', 'audit_head', 'driver_charge', 'token', 'integration']) {
        const n = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE ${t === 'integration' ? 'org_id IS NOT NULL' : 'true'}`)).rows[0]!.n;
        assert.equal(n, 0, `${t} must read empty with no org`);
      }
      // System roles (org_id NULL) are shared reference data and stay readable.
      const roles = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM role WHERE org_id IS NULL`)).rows[0]!.n;
      assert.ok(roles > 0, 'system roles readable');
      await assert.rejects(c.query(`INSERT INTO site (org_id, name) VALUES ($1, 'nope')`, [ORG_A]), /row-level security/);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }

    // The same through the API's own entry point with a blank tenant.
    await inRequest(async () => {
      const h = await enterOrgScope('');
      try {
        assert.deepEqual(await siteIdsVisible(), []);
      } finally {
        await h.rollback();
      }
    });
  });

  test('enterOrgScope: only its own org, no foreign writes, and the connection goes back unscoped', async () => {
    let scoped = null as pg.PoolClient | null;
    await inRequest(async () => {
      const h = await enterOrgScope(ORG_A);
      scoped = h.client;
      assert.deepEqual(await siteIdsVisible(), [SITE_A]);
      assert.equal((await one<{ v: string }>(`SELECT current_setting('app.rls_bypass') AS v`))?.v, 'off');
      await query('SAVEPOINT foreign_write');
      await assert.rejects(query(`INSERT INTO site (org_id, name) VALUES ($1, 'into B')`, [ORG_B]), /row-level security/);
      await query('ROLLBACK TO SAVEPOINT foreign_write');
      // A tenant cannot touch the shared system roles either.
      const upd = await query(`UPDATE role SET permissions = permissions WHERE org_id IS NULL`).catch((e: Error) => e);
      assert.ok(upd instanceof Error && /row-level security/.test(upd.message), 'system roles are read-only in a request');
      await h.rollback();
    });

    // pg-pool hands back the most recently released idle client: the same one.
    const c = await pool.connect();
    try {
      assert.equal(c, scoped, 'expected the scoped client back from the pool');
      const s = (await c.query<{ b: string; o: string }>(
        `SELECT current_setting('app.rls_bypass') AS b, COALESCE(current_setting('app.current_org_id', true), '') AS o`,
      )).rows[0]!;
      assert.equal(s.b, 'on', 'LOCAL bypass=off ended with the transaction');
      assert.equal(s.o, '', 'LOCAL org ended with the transaction');
    } finally {
      c.release();
    }
  });

  test('a pinned org beats the bypass (pre-048 code that only pins the org stays isolated)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.current_org_id', $1, true)`, [ORG_A]); // bypass left on
      const ids = (await c.query<{ id: string }>(`SELECT id FROM site WHERE id = ANY($1::uuid[])`, [[SITE_A, SITE_B]])).rows.map((r) => r.id);
      assert.deepEqual(ids, [SITE_A]);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  });

  test('withOrg (platform billing acting as a tenant) is scoped the same way', async () => {
    assert.deepEqual(await withOrg(ORG_B, siteIdsVisible), [SITE_B]);
  });
});

dbDescribe('audit_log is append-only (as plugsure_app)', () => {
  test('the runtime role can append — head advanced via ON CONFLICT DO UPDATE — but not rewrite, delete or truncate', async () => {
    await writeAudit({ orgId: ORG_A, actorType: 'system', action: 'test.append_1' });
    await writeAudit({ orgId: ORG_A, actorType: 'system', action: 'test.append_2' });
    // Refused by the missing privilege, or — if a later migration re-granted it —
    // by the append-only trigger. Either way the row is untouched.
    await assert.rejects(query(`UPDATE audit_log SET action = 'forged' WHERE org_id = $1`, [ORG_A]), /permission denied|append-only/);
    await assert.rejects(query(`DELETE FROM audit_log WHERE org_id = $1`, [ORG_A]), /permission denied|append-only/);
    await assert.rejects(query(`TRUNCATE audit_log`), /permission denied/);
    await assert.rejects(query(`DELETE FROM audit_head WHERE org_id = $1`, [ORG_A]), /permission denied|permanent/);
    assert.equal((await su!.query(`SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'forged'`, [ORG_A])).rowCount, 0);
  });

  test('the runtime role holds no UPDATE, DELETE or TRUNCATE on audit_log', async () => {
    const r = (await query<{ u: boolean; d: boolean; t: boolean }>(
      `SELECT has_table_privilege('audit_log', 'UPDATE') AS u, has_table_privilege('audit_log', 'DELETE') AS d,
              has_table_privilege('audit_log', 'TRUNCATE') AS t`,
    )).rows[0]!;
    assert.deepEqual(
      r,
      { u: false, d: false, t: false },
      'migration 048 revokes these; a later migration that runs `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL ' +
        'TABLES IN SCHEMA public TO plugsure_app` (053 does) hands them back — grant per table instead',
    );
  });

  test('the trigger refuses UPDATE and DELETE even for the owner/superuser', async () => {
    await assert.rejects(su!.query(`UPDATE audit_log SET action = 'forged' WHERE org_id = $1`, [ORG_A]), /append-only/);
    await assert.rejects(su!.query(`DELETE FROM audit_log WHERE org_id = $1`, [ORG_A]), /append-only/);
  });

  test('inside a tenant\'s request the platform chain is invisible', async () => {
    await inRequest(async () => {
      const h = await enterOrgScope(ORG_A);
      try {
        assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_head WHERE org_id = $1`, [NIL_ORG]))?.n, 0);
        assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE org_id IS NULL`))?.n, 0);
        assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_head WHERE org_id = $1`, [ORG_A]))?.n, 1);
      } finally {
        await h.rollback();
      }
    });
  });
});

dbDescribe('audit entries survive a failed request (as plugsure_app)', () => {
  const entries = (action: string) =>
    su!.query<{ after_state: Record<string, unknown> | null }>(
      `SELECT after_state FROM audit_log WHERE org_id = $1 AND action = $2`, [ORG_B, action],
    ).then((r) => r.rows);

  test('a request that rolls back keeps its audit entry, marked, and loses its other writes', async () => {
    const action = `test.refund_failed_${tag}`;
    await inRequest(async () => {
      const h = await enterOrgScope(ORG_B);
      await query(`INSERT INTO site (org_id, name) VALUES ($1, $2)`, [ORG_B, action]);
      await writeAudit({ orgId: ORG_B, actorType: 'user', actorId: 'u1', action, after: { error: 'acquirer refused' } });
      await h.rollback(); // the API does this for every reply >= 400
    });
    const rows = await entries(action);
    assert.equal(rows.length, 1, 'exactly one entry: the rolled-back one never existed');
    assert.deepEqual(rows[0]!.after_state, { error: 'acquirer refused', requestTransaction: 'rolled_back' });
    assert.equal((await su!.query(`SELECT 1 FROM site WHERE name = $1`, [action])).rowCount, 0, 'the action itself was rolled back');
    const chain = await verifyChain(ORG_B);
    assert.equal(chain.ok, true, JSON.stringify(chain.problems));
  });

  test('a request that commits writes its entry once, unmarked', async () => {
    const action = `test.ok_${tag}`;
    await inRequest(async () => {
      const h = await enterOrgScope(ORG_B);
      await writeAudit({ orgId: ORG_B, actorType: 'user', actorId: 'u1', action, after: { n: 1 } });
      await h.commit();
      await h.rollback(); // a late safety-net call is a no-op, and runs no hooks
    });
    const rows = await entries(action);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.after_state, { n: 1 });
  });

  test('an already-failed transaction: the audit write is deferred, COMMIT is reported as failed, the entry survives', async () => {
    const action = `test.after_error_${tag}`;
    await inRequest(async () => {
      const h = await enterOrgScope(ORG_B);
      await query('SELECT 1/0').catch(() => {}); // a handler that swallowed a failed query
      await writeAudit({ orgId: ORG_B, actorType: 'user', actorId: 'u1', action });
      // Postgres turns this COMMIT into a ROLLBACK without raising; it must not pass for success.
      await assert.rejects(h.commit(), /did not commit/);
    });
    const rows = await entries(action);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.after_state, { requestTransaction: 'commit_failed' });
    const chain = await verifyChain(ORG_B);
    assert.equal(chain.ok, true, JSON.stringify(chain.problems));
  });
});
