import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addLegacyMoneyAliases, acceptLegacyMoneyKeys, liveEventForClient, legacyNamesFor, LegacyKeyConflict, LegacyKeyCurrency, assertLegacyRupiah } from './legacy-money.js';

test('legacy names for the renamed amounts', () => {
  assert.deepEqual(legacyNamesFor('totalMinor'), ['totalIdr']);
  assert.deepEqual(legacyNamesFor('total_minor'), ['total_idr']);
  assert.deepEqual(legacyNamesFor('taxMinor'), ['ppnIdr']);
  assert.deepEqual(legacyNamesFor('tax_minor'), ['ppn_idr']);
  assert.deepEqual(legacyNamesFor('localTaxMinor'), ['pbjtIdr']);
  assert.deepEqual(legacyNamesFor('local_tax_minor'), ['pbjt_idr']);
  assert.deepEqual(new Set(legacyNamesFor('taxBaseMinor')), new Set(['ppnDppIdr', 'dppIdr']));
  assert.deepEqual(new Set(legacyNamesFor('tax_base_minor')), new Set(['ppn_dpp_idr', 'dpp_idr']));
  assert.deepEqual(legacyNamesFor('taxableMinor'), ['taxBaseIdr']);
  assert.deepEqual(legacyNamesFor('taxTotalMinor'), ['taxIdr']);
  assert.deepEqual(legacyNamesFor('local_tax_rate_bps'), ['pbjt_rate_bps']);
  assert.deepEqual(legacyNamesFor('fee_tax_minor'), ['fee_ppn_idr']);
  assert.deepEqual(legacyNamesFor('member_rate'), ['member_rate_idr']);
  assert.deepEqual(legacyNamesFor('energyWh'), []);
});

test('aliases are added for IDR (stated or implied), never for MYR or SGD', () => {
  const { body, added } = addLegacyMoneyAliases<any>({
    id: 'a', totalMinor: 30000, tax: { taxMinor: 3000, localTaxMinor: 500, taxBaseMinor: 24000 },
    rows: [{ total_minor: 10, currency: 'IDR' }, { total_minor: 1234, currency: 'MYR' }, { total_minor: 999, currency: 'SGD', nested: { amountMinor: 5 } }],
    energyWh: 1000,
  });
  assert.equal(added, true);
  assert.equal(body.totalIdr, 30000);
  assert.equal((body.tax as any).ppnIdr, 3000);
  assert.equal((body.tax as any).pbjtIdr, 500);
  assert.equal((body.tax as any).ppnDppIdr, 24000);
  assert.equal((body.tax as any).dppIdr, 24000);
  assert.equal((body.rows[0] as any).total_idr, 10);
  assert.equal((body.rows[1] as any).total_idr, undefined, 'no rupiah alias on a MYR amount');
  assert.equal((body.rows[2] as any).total_idr, undefined);
  assert.equal((body.rows[2] as any).nested.amountIdr, undefined, 'currency is inherited by nested objects');
  assert.equal((body as any).energyWhIdr, undefined);
  // A key that already exists is never overwritten.
  assert.equal(addLegacyMoneyAliases<any>({ totalMinor: 1, totalIdr: 2 }).body.totalIdr, 2);
  // Nothing to alias: reported, for the Deprecation header.
  assert.equal(addLegacyMoneyAliases({ energyWh: 1, currency: 'SGD', totalMinor: 5 }).added, false);
  // Arrays at the top level, nulls, dates.
  const arr = addLegacyMoneyAliases([{ amountMinor: null, at: new Date(0) }]).body as any[];
  assert.equal(arr[0].amountIdr, null);
  assert.ok(arr[0].at instanceof Date);
});

test('no rupiah alias when another key names a non-IDR currency (a card limit in ringgit)', () => {
  const { body } = addLegacyMoneyAliases<any>({ items: [
    { uid: 'A', spend_limit_minor: 5000, spend_limit_currency: 'MYR', lifetime_spend_minor: 1234 },
    { uid: 'B', spend_limit_minor: 100000, spend_limit_currency: 'IDR', lifetime_spend_minor: 50000 },
    { uid: 'C', spendLimitMinor: 800, spendLimitCurrency: 'SGD' },
  ] });
  assert.equal(body.items[0].spend_limit_idr, undefined, 'sen never under a rupiah name');
  assert.equal(body.items[0].lifetime_spend_idr, undefined);
  assert.equal(body.items[1].spend_limit_idr, 100000, 'an IDR limit keeps its v1.6 name');
  assert.equal(body.items[1].lifetime_spend_idr, 50000);
  assert.equal(body.items[2].spendLimitIdr, undefined);
});

test('legacy request keys are accepted; a conflicting pair is refused', () => {
  assert.deepEqual(acceptLegacyMoneyKeys({ reservationFeeIdr: 5000, name: 'x', pbjtRateBps: 1000 }), { reservationFeeMinor: 5000, name: 'x', localTaxRateBps: 1000 });
  assert.deepEqual(acceptLegacyMoneyKeys({ tiers: [{ upToIdr: 10, rateBps: 800 }] }), { tiers: [{ upToMinor: 10, rateBps: 800 }] });
  assert.deepEqual(acceptLegacyMoneyKeys({ amountMinor: 5, amountIdr: 5 }), { amountMinor: 5 });
  assert.throws(() => acceptLegacyMoneyKeys({ amountMinor: 5, amountIdr: 6 }), LegacyKeyConflict);
  // Integration setting keys and the QRIS estimate are not renamed.
  assert.deepEqual(acceptLegacyMoneyKeys({ postpayLimitIdr: 200000 }), { postpayLimitIdr: 200000 });
  assert.equal(acceptLegacyMoneyKeys(null), null);
});

test('a v1.6 rupiah name for an amount in another currency is refused (400), never read as sen (review 5b)', () => {
  assert.throws(() => acceptLegacyMoneyKeys({ spendLimitIdr: 5000, spendLimitCurrency: 'MYR' }), LegacyKeyCurrency);
  assert.throws(() => acceptLegacyMoneyKeys({ items: [{ amountIdr: 100, currency: 'SGD' }] }), /amountIdr is a rupiah amount .* in SGD: send amountMinor/);
  // IDR beside it: accepted as before, and recorded.
  const used: string[] = [];
  assert.deepEqual(acceptLegacyMoneyKeys({ spendLimitIdr: 5000, spendLimitCurrency: 'IDR' }, used), { spendLimitMinor: 5000, spendLimitCurrency: 'IDR' });
  assert.deepEqual(used, ['spendLimitIdr']);
  // A route updating a row already in MYR refuses the rupiah name; IDR rows and the new name pass.
  assert.throws(() => assertLegacyRupiah(['spendLimitIdr'], ['spendLimitIdr', 'spend_limit_idr'], 'MYR'), LegacyKeyCurrency);
  assert.doesNotThrow(() => assertLegacyRupiah(['spendLimitIdr'], ['spendLimitIdr'], 'IDR'));
  assert.doesNotThrow(() => assertLegacyRupiah([], ['spendLimitIdr'], 'MYR'));
});

test('live events (/v1/stream) keep the v1.5 rupiah names for IDR, and get none for MYR', () => {
  const cdr = liveEventForClient<any>({ kind: 'cdr.created', payload: { orgId: 'o', cdrId: 'c', sessionId: 's', totalMinor: 52000, currency: 'IDR' } });
  assert.equal(cdr.payload.totalIdr, 52000);
  assert.equal(cdr.payload.totalMinor, 52000);
  const hold = liveEventForClient<any>({ kind: 'payment.hold_captured', payload: { orgId: 'o', paymentIntentId: 'p', capturedMinor: 30000, releasedMinor: 20000, currency: 'IDR' } });
  assert.equal(hold.payload.capturedIdr, 30000);
  assert.equal(hold.payload.releasedIdr, 20000);
  const refund = liveEventForClient<any>({ kind: 'refund.due', payload: { orgId: 'o', paymentIntentId: 'p', amountMinor: 1250, currency: 'MYR', reason: 'x' } });
  assert.equal(refund.payload.amountIdr, undefined, 'sen are never sent as rupiah');
  const status = { kind: 'connector.status', payload: { orgId: 'o', ocppIdentity: 'X', status: 'Available' } };
  assert.deepEqual(liveEventForClient(status), status);
});
