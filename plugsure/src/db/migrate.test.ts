import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Import the migrator WITHOUT running it (see the bottom of migrate.ts).
process.env.PLUGSURE_MIGRATE_IMPORT_ONLY = '1';
const { migrationLockTimeout } = await import('./migrate.js');
const { pool } = await import('./pool.js');
after(() => pool.end());

test('migrator: lock_timeout defaults to 10s and accepts Postgres durations', () => {
  assert.equal(migrationLockTimeout(undefined), '10s');
  assert.equal(migrationLockTimeout('500ms'), '500ms');
  assert.equal(migrationLockTimeout('2min'), '2min');
  assert.equal(migrationLockTimeout('0'), '0');
});

test('migrator: a malformed MIGRATION_LOCK_TIMEOUT is refused, not passed to the database', () => {
  for (const bad of ['', 'ten seconds', "1s'; DROP TABLE x; --", '-5s']) {
    assert.throws(() => migrationLockTimeout(bad), /MIGRATION_LOCK_TIMEOUT/);
  }
});
