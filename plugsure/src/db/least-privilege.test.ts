import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { many, pool } from './pool.js';

/**
 * v1.9.0: the runtime role keeps least privilege. No migration after 048 hands every table back with a blanket
 * grant (it re-opens the append-only audit log), and on a migrated database the tables that are append-only,
 * write-once or reference data have exactly the privileges the code uses (migration 076).
 */
after(() => pool.end());
const DIR = join(import.meta.dirname, '..', '..', 'db', 'migrations');
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);

test('no migration after 048 grants ALL TABLES or ALL SEQUENCES to the runtime role', () => {
  const offenders = readdirSync(DIR).filter((f) => f.endsWith('.sql') && f > '048')
    .filter((f) => /^\s*GRANT\b[^;]*\bON\s+ALL\s+(TABLES|SEQUENCES)\b/im.test(readFileSync(join(DIR, f), 'utf8').replace(/--.*$/gm, '')));
  assert.deepEqual(offenders, []);
});

test('the runtime role has exactly the privileges the code uses on restricted tables', { skip: !DB_OK }, async () => {
  const rows = await many<{ t: string; p: string }>(
    `SELECT table_name AS t, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p
       FROM information_schema.role_table_grants
      WHERE grantee = 'plugsure_app' AND table_name = ANY($1::text[]) GROUP BY 1 ORDER BY 1`,
    [['app_driver_deletion', 'audit_head', 'driver_idempotency', 'audit_log', 'country', 'currency_unit', 'oidc_login_tx', 'payment_webhook_event']]);
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.t, r.p])), {
    app_driver_deletion: 'INSERT,SELECT',
    audit_head: 'INSERT,SELECT,UPDATE',
    audit_log: 'INSERT,SELECT',
    driver_idempotency: 'DELETE,INSERT,SELECT,UPDATE',
    country: 'SELECT',
    currency_unit: 'SELECT',
    oidc_login_tx: 'DELETE,INSERT,SELECT',
    payment_webhook_event: 'DELETE,INSERT,SELECT',
  });
});
