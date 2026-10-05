import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/pool.js';

/**
 * GET /healthz answers 503 when the database does not (v1.5.1). It answered 200
 * with {ok:false}, and every health checker that judges by status code — the
 * Dockerfile HEALTHCHECK, the compose healthcheck, a load balancer — saw a
 * healthy API that could serve nothing.
 *
 * The database is "down" by making the pool's query reject: no real outage is
 * needed, and no database is touched while it is.
 */
describe('API /healthz', () => {
  test('200 with the database up, 503 with it down', async (t) => {
    let app: Awaited<ReturnType<typeof import('./server.js')['buildApi']>>;
    try {
      app = await (await import('./server.js')).buildApi();
      await app.ready();
    } catch (e) {
      t.skip(`API could not be built here (${(e as Error).message})`);
      return;
    }
    const realQuery = pool.query;
    try {
      const up = await app.inject({ method: 'GET', url: '/healthz' });
      if (up.statusCode === 503) {
        t.skip('no database reachable here');
        return;
      }
      assert.equal(up.statusCode, 200);
      assert.equal(up.json().ok, true);

      (pool as any).query = async () => { throw new Error('connect ECONNREFUSED'); };
      const down = await app.inject({ method: 'GET', url: '/healthz' });
      assert.equal(down.statusCode, 503);
      assert.deepEqual([down.json().ok, down.json().db], [false, false]);
    } finally {
      (pool as any).query = realQuery;
      await app.close();
      await pool.end();
    }
  });
});
