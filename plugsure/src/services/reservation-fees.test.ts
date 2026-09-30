import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { computeFleetStatement, splitFees, type FeeLine } from './fleet-calc.js';
import { feeTax } from './benefits.js';
import { validateSite, siteInputFrom } from './sites.js';

const TAX = { ppnRateBps: 1200, dppNum: 11, dppDen: 12 } as any;

const reservation = (id: string, fee: number, pkp = true): FeeLine => {
  const t = feeTax(fee, pkp);
  return { kind: 'reservation', reservationId: id, subscriptionId: '', planName: 'Hub Senayan', subscriber: 'CARD-1', feeIdr: fee,
    taxBaseIdr: t.ppn > 0 ? fee : 0, dppIdr: t.dpp, ppnIdr: t.ppn, totalIdr: t.total, periodStart: '2026-09-01T03:00:00.000Z', periodEnd: '2026-09-01T03:15:00.000Z' };
};
const membership: FeeLine = { subscriptionId: 's1', planName: 'Armada Plus', subscriber: 'PT Logistik', feeIdr: 100_000, taxBaseIdr: 100_000, dppIdr: 91_667, ppnIdr: 11_000, totalIdr: 111_000, periodStart: '2026-09-01', periodEnd: '2026-10-01' };

describe('reservation fees', () => {
  test('a Rp 5,000 fee at a PKP operator: DPP 11/12, PPN 12% of DPP, Rp 5,550 to pay; not PKP: no PPN', () => {
    assert.deepEqual(feeTax(5000, true), { dpp: 4583, ppn: 550, total: 5550 });
    assert.deepEqual(feeTax(5000, false), { dpp: 0, ppn: 0, total: 5000 });
  });

  test('on the fleet invoice: reservations and memberships add to the fees and the faktur totals, and are shown apart', () => {
    const fees = [membership, reservation('r1', 5000), reservation('r2', 5000)];
    const st = computeFleetStatement([], [], { includeRoaming: false, cfg: TAX, fees });
    assert.equal(st.totals.feesIdr, 111_000 + 5550 + 5550);
    assert.equal(st.totals.ppnIdr, 11_000 + 550 + 550);
    assert.equal(st.totals.dppIdr, 91_667 + 4583 + 4583);
    assert.equal(st.totals.totalIdr, st.totals.feesIdr);
    const s = splitFees(st.fees);
    assert.deepEqual([s.memberships.length, s.reservations.length, s.membershipsIdr, s.reservationsIdr], [1, 2, 111_000, 11_100]);
    assert.deepEqual(splitFees(undefined), { memberships: [], reservations: [], membershipsIdr: 0, reservationsIdr: 0 });
  });

  test('the site setting: Rp 0 to 100,000; empty means free', () => {
    assert.deepEqual(validateSite({ reservationFeeIdr: 5000 }, false).errors, {});
    assert.ok(validateSite({ reservationFeeIdr: 100_001 }, false).errors.reservationFeeIdr);
    assert.ok(validateSite({ reservationFeeIdr: -1 }, false).errors.reservationFeeIdr);
    assert.equal(siteInputFrom({ reservationFeeIdr: '' }).reservationFeeIdr, 0);
    assert.equal(siteInputFrom({ reservationFeeIdr: '7500' }).reservationFeeIdr, 7500);
  });
});
