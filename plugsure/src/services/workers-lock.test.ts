import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { exclusive } from './workers.js';

// Advisory locks touch no rows, but the convention is that database-backed
// tests run only against the disposable database.
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbTest = DB_OK ? test : test.skip;
after(() => (DB_OK ? pool.end() : undefined));

dbTest('two runners of one worker at once: the pass runs once, the other skips', async () => {
  let runs = 0;
  const pass = async () => { runs++; await new Promise((r) => setTimeout(r, 150)); };
  const [a, b] = await Promise.all([exclusive('test-renewals', pass), exclusive('test-renewals', pass)]);
  assert.equal(runs, 1);
  assert.deepEqual([a, b].sort(), [false, true]);
});

dbTest('the lock is released afterwards, also when the pass throws', async () => {
  await assert.rejects(exclusive('test-throws', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await exclusive('test-throws', async () => undefined), true);
});

dbTest('different workers do not block each other', async () => {
  let n = 0;
  const pass = async () => { n++; await new Promise((r) => setTimeout(r, 50)); };
  await Promise.all([exclusive('test-a', pass), exclusive('test-b', pass)]);
  assert.equal(n, 2);
});
