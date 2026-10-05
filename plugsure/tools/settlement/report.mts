/**
 * Read-only report of payments the settlement-recovery sweep would settle (v1.5.1).
 *
 * Run it on the pilot BEFORE the sweep acts on old payments: anything listed here that
 * operations already captured, charged or refunded by hand at the acquirer must be
 * settled in the console first, or the sweep would collect / refund it a second time.
 *
 *   NODE_ENV=production DATABASE_URL=... npm run settlement:report
 *
 * It ignores SETTLEMENT_RECOVERY_NOT_BEFORE on purpose (it shows everything in the
 * 30-day window) and never writes.
 */
import { pool } from '../../src/db/pool.js';
import { UNSETTLED_PAYMENTS_SQL, unsettledPaymentsParams } from '../../src/services/sessions.js';

const client = await pool.connect();
try {
  await client.query('BEGIN READ ONLY');
  // The sweep runs platform-wide; so does this report.
  await client.query(`SELECT set_config('app.rls_bypass', 'on', true)`);
  const { rows } = await client.query(UNSETTLED_PAYMENTS_SQL, unsettledPaymentsParams(undefined, null));
  await client.query('ROLLBACK');
  if (!rows.length) {
    console.log('No unsettled payments of rated sessions in the last 30 days. Nothing for the sweep to do.');
  } else {
    console.log(`${rows.length} unsettled payment(s) the sweep would settle:\n`);
    console.table(rows.map((r) => ({
      cdr_issued: new Date(r.issued_at).toISOString(),
      org: r.org_id,
      session: r.session_id,
      payment: r.intent_id,
      mode: r.mode,
      hold_state: r.hold_state ?? '',
      cdr_total_minor: Number(r.total_minor),
    })));
    console.log('\nCheck each against the acquirer dashboard before letting the sweep run on them.');
  }
} finally {
  client.release();
  await pool.end();
}
