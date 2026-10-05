import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../config.js';
import { one, pool, query } from '../../db/pool.js';
import { databaseTestLock } from '../../db/test-lock.js';

/**
 * An unpaid session paid in the app (settlementPaid): the expired hold's note names the payment and its amount in
 * MAJOR units of the session's currency ("S$ 1.30", "Rp 12345") — it printed minor units before ("S$ 130").
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/payments/settlement-note.db.test.ts
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(async () => {
  await dbLock.release();
  if (DB_OK) await pool.end().catch(() => {});
});

const { settlementPaid, MAJOR_AMOUNT_SQL } = await import('./holds.js');

dbDescribe('settlementPaid: the paid-in-app note (database)', () => {
  const made: string[] = [];
  after(async () => {
    if (made.length) await query(`DELETE FROM payment_intent WHERE id = ANY($1::uuid[]) AND mode = 'settlement'`, [made]);
    if (made.length) await query(`DELETE FROM payment_intent WHERE id = ANY($1::uuid[])`, [made]);
  });

  async function paidInApp(currency: string, owedMinor: number) {
    const org = (await one<{ id: string }>(`SELECT id FROM organisation ORDER BY created_at LIMIT 1`))!.id;
    const hold = (await one<{ id: string }>(
      `INSERT INTO payment_intent (org_id, provider, method, mode, state, hold_state, hold_error, hold_capture_minor, amount_authorised_minor, currency)
       VALUES ($1, 'stripe', 'card', 'preauth', 'authorised', 'capture_failed', 'hold expired: the card authorisation expired', $2, 2000, $3) RETURNING id`,
      [org, owedMinor, currency]))!.id;
    const s = (await one<{ id: string }>(
      `INSERT INTO payment_intent (org_id, provider, method, channel, mode, state, amount_authorised_minor, amount_captured_minor, settles_intent_id, currency)
       VALUES ($1, 'stripe', 'qr', 'PAYNOW', 'settlement', 'captured', $2, $2, $3, $4) RETURNING id`,
      [org, owedMinor, hold, currency]))!.id;
    made.push(s, hold);
    assert.equal(await settlementPaid(s), true);
    return (await one<{ hold_error: string; hold_state: string }>(`SELECT hold_error, hold_state FROM payment_intent WHERE id = $1`, [hold]))!;
  }

  test('SGD: S$ 1.30 (not "S$ 130")', async () => {
    const r = await paidInApp('SGD', 130);
    assert.equal(r.hold_state, 'captured');
    assert.match(r.hold_error, /^hold expired: paid by the driver in the app \(PAYNOW, S\$ 1\.30; payment [0-9a-f-]{36}\)$/);
  });
  test('IDR (no minor unit): unchanged, Rp 12345', async () => {
    const r = await paidInApp('IDR', 12345);
    assert.match(r.hold_error, /\(PAYNOW, Rp 12345; payment /);
  });
  test('the SQL helper', async () => {
    const r = await one<{ a: string; b: string; c: string }>(
      `SELECT ${MAJOR_AMOUNT_SQL('5', '2')} AS a, ${MAJOR_AMOUNT_SQL('123456', '0')} AS b, ${MAJOR_AMOUNT_SQL('120000', '2')} AS c`);
    assert.deepEqual(r, { a: '0.05', b: '123456', c: '1200.00' });
  });
});
