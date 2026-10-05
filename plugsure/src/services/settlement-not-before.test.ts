import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settlementRecoveryNotBefore, unsettledPaymentsParams, UNSETTLED_PAYMENTS_SQL } from './sessions.js';

test('SETTLEMENT_RECOVERY_NOT_BEFORE: unset or blank means no cutoff', () => {
  assert.equal(settlementRecoveryNotBefore({}), null);
  assert.equal(settlementRecoveryNotBefore({ SETTLEMENT_RECOVERY_NOT_BEFORE: '  ' }), null);
});

test('SETTLEMENT_RECOVERY_NOT_BEFORE: a timestamp is parsed', () => {
  const d = settlementRecoveryNotBefore({ SETTLEMENT_RECOVERY_NOT_BEFORE: '2026-10-03T08:00:00+07:00' });
  assert.equal(d?.toISOString(), '2026-10-03T01:00:00.000Z');
});

test('SETTLEMENT_RECOVERY_NOT_BEFORE: garbage is refused, not ignored', () => {
  assert.throws(() => settlementRecoveryNotBefore({ SETTLEMENT_RECOVERY_NOT_BEFORE: 'yesterday' }), /not a valid timestamp/);
});

test('the selection filters on the cutoff and the report can pass none', () => {
  assert.match(UNSETTLED_PAYMENTS_SQL, /\$4::timestamptz IS NULL OR d\.issued_at >= \$4/);
  const cutoff = new Date('2026-10-03T00:00:00Z');
  assert.equal(unsettledPaymentsParams(undefined, cutoff)[3], cutoff);
  assert.equal(unsettledPaymentsParams('00000000-0000-0000-0000-000000000000', null)[3], null);
});
