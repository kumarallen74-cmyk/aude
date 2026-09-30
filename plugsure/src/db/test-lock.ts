import pg from 'pg';
import { config } from '../config.js';

/**
 * TEST SUPPORT ONLY: keeps the audit-chain suite apart from the other database-backed
 * test files.
 *
 * node:test runs test files in parallel, all against the one disposable database.
 * audit.test.ts owns the WHOLE audit chain: it truncates audit_log and audit_head
 * and asserts on what is in them. Every other database-backed file writes audit
 * entries of its own (issuing a certificate, creating a tariff…). Together they
 * collided: the audit suite found another file's row where it expected its own,
 * and a reset between another file's appends left that file's chain behind its log
 * (audit_log_org_seq_uniq).
 *
 * The lock is one Postgres advisory lock, held on its own connection for the whole
 * file:
 * - audit.test.ts takes it EXCLUSIVE;
 * - every other database-backed test file takes it SHARED, so those files still run
 *   in parallel with each other, and files without a database are not held up at all.
 *
 * A new database-backed test file must call `databaseTestLock('shared')` too.
 */
const KEY = 7_203_001; // arbitrary; used by nothing else

export function databaseTestLock(mode: 'shared' | 'exclusive', enabled = true) {
  let client: pg.Client | null = null;
  return {
    async acquire() {
      if (!enabled) return;
      client = new pg.Client({ connectionString: config.databaseUrl });
      await client.connect();
      await client.query(mode === 'exclusive' ? 'SELECT pg_advisory_lock($1)' : 'SELECT pg_advisory_lock_shared($1)', [KEY]);
    },
    async release() {
      if (!client) return;
      // Closing the session releases the lock, even if the unlock itself fails.
      await client.end().catch(() => {});
      client = null;
    },
  };
}
