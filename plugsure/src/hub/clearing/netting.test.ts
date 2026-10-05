import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { net, positionFor, settlementAmount, type NetInput } from './netting.js';

/** Bilateral netting (§8.5): hand-computed fixtures, symmetry, credits, currency isolation. */
describe('bilateral netting', () => {
  // Fixed ids so the A < B order is known: A < B < C.
  const A = '00000000-0000-4000-8000-00000000000a';
  const B = '00000000-0000-4000-8000-00000000000b';
  const C = '00000000-0000-4000-8000-00000000000c';
  const cdr = (cpo: string, emsp: string, incl: number | null, excl = incl ?? 0, cur = 'IDR', fees: [number, number] = [0, 0]): NetInput =>
    ({ cpo_member_id: cpo, emsp_member_id: emsp, currency: cur, total_excl_minor: excl, total_incl_minor: incl, fee_cpo_minor: fees[0], fee_emsp_minor: fees[1], energy_kwh: 10 });

  test('the amount that moves is incl. tax; excl. tax when the CDR had no incl_vat', () => {
    assert.equal(settlementAmount({ total_excl_minor: 1_500, total_incl_minor: 1_620 }), 1_620);
    assert.equal(settlementAmount({ total_excl_minor: 1_500, total_incl_minor: null }), 1_500);
  });

  test('one direction: the eMSP pays the CPO', () => {
    const r = net([cdr(B, A, 44_400), cdr(B, A, 11_100)], 'IDR');
    assert.equal(r.positions.length, 1);
    const p = r.positions[0]!;
    assert.deepEqual([p.memberA, p.memberB, p.aOwesB, p.bOwesA, p.net, p.payer, p.payee, p.cdrCount], [A, B, 55_500, 0, 55_500, A, B, 2]);
    const a = r.members.find((m) => m.memberId === A)!;
    const b = r.members.find((m) => m.memberId === B)!;
    assert.deepEqual([a.receivable, a.payable, a.net], [0, 55_500, -55_500]);
    assert.deepEqual([b.receivable, b.payable, b.net], [55_500, 0, 55_500]);
  });

  test('both directions net; swapping the roles mirrors the result exactly (symmetry)', () => {
    const fwd = net([cdr(B, A, 44_400), cdr(A, B, 30_000), cdr(A, B, 4_400)], 'IDR');
    const p = fwd.positions[0]!;
    assert.deepEqual([p.aOwesB, p.bOwesA, p.net, p.payer, p.payee], [44_400, 34_400, 10_000, A, B]);
    const rev = net([cdr(A, B, 44_400), cdr(B, A, 30_000), cdr(B, A, 4_400)], 'IDR');
    const q = rev.positions[0]!;
    assert.deepEqual([q.aOwesB, q.bOwesA, q.net, q.payer, q.payee], [34_400, 44_400, 10_000, B, A]);
    assert.equal(positionFor(p, A).signedNet, -positionFor(q, A).signedNet);
    assert.equal(positionFor(p, B).signedNet, -10_000 * -1);
  });

  test('a zero net has no payer', () => {
    const r = net([cdr(B, A, 2_500, 2_500, 'SGD'), cdr(A, B, 2_500, 2_500, 'SGD')], 'SGD');
    assert.deepEqual([r.positions[0]!.net, r.positions[0]!.payer, r.positions[0]!.payee], [0, null, null]);
  });

  test('three members × two currencies (hand-computed)', () => {
    // MYR: B→A 16.20 + C→A 10.00 ; A→B 5.00 ; C→B 3.30 ; credit of the A→B one (−5.00)
    const myr = net([
      cdr(A, B, 1_620, 1_500, 'MYR'), cdr(A, C, 1_000, 1_000, 'MYR'), cdr(B, A, 500, 500, 'MYR'), cdr(B, C, 330, 300, 'MYR'), cdr(B, A, -500, -500, 'MYR'),
    ], 'MYR');
    const pos = (x: string, y: string) => myr.positions.find((p) => p.memberA === x && p.memberB === y)!;
    // A↔B: B owes A 1620; A owes B 500 − 500 = 0 → B pays A 1620
    assert.deepEqual([pos(A, B).aOwesB, pos(A, B).bOwesA, pos(A, B).net, pos(A, B).payer], [0, 1_620, 1_620, B]);
    // A↔C: C owes A 1000
    assert.deepEqual([pos(A, C).net, pos(A, C).payer, pos(A, C).payee], [1_000, C, A]);
    // B↔C: C owes B 330
    assert.deepEqual([pos(B, C).net, pos(B, C).payer, pos(B, C).payee], [330, C, B]);
    const m = (id: string) => myr.members.find((x) => x.memberId === id)!;
    assert.deepEqual([m(A).receivable, m(A).payable, m(A).net], [2_620, 0, 2_620]);
    assert.deepEqual([m(B).receivable, m(B).payable, m(B).net], [330, 1_620, -1_290]);
    assert.deepEqual([m(C).receivable, m(C).payable, m(C).net], [0, 1_330, -1_330]);
    assert.equal(myr.members.reduce((s, x) => s + x.net, 0), 0, 'what members receive equals what they pay');
    // IDR, the same three members, independently.
    const idr = net([cdr(C, A, 44_400), cdr(A, C, 50_000), cdr(B, C, 12_345)], 'IDR');
    const ac = idr.positions.find((p) => p.memberA === A && p.memberB === C)!;
    assert.deepEqual([ac.aOwesB, ac.bOwesA, ac.net, ac.payer], [44_400, 50_000, 5_600, C]);
    assert.equal(idr.positions.length, 2);
  });

  test('a credit CDR offsets its original in the same run (net zero, fees reversed)', () => {
    const r = net([cdr(B, A, 1_620, 1_500, 'MYR', [45, 100]), cdr(B, A, -1_620, -1_500, 'MYR', [-45, -100])], 'MYR');
    assert.deepEqual([r.positions[0]!.net, r.positions[0]!.payer, r.positions[0]!.cdrCount], [0, null, 2]);
    const b = r.members.find((m) => m.memberId === B)!;
    const a = r.members.find((m) => m.memberId === A)!;
    assert.deepEqual([b.feeCpo, a.feeEmsp, b.feeNet, a.feeNet], [0, 0, 0, 0]);
  });

  test('a credit for an original settled earlier makes the CPO the payer in the next run', () => {
    const r = net([cdr(B, A, -1_620, -1_500, 'MYR')], 'MYR');
    assert.deepEqual([r.positions[0]!.net, r.positions[0]!.payer, r.positions[0]!.payee], [1_620, B, A]);
  });

  test('fees are per member and not netted', () => {
    const r = net([cdr(B, A, 10_000, 9_000, 'IDR', [270, 100]), cdr(A, B, 5_000, 4_500, 'IDR', [135, 100])], 'IDR');
    const a = r.members.find((m) => m.memberId === A)!;
    const b = r.members.find((m) => m.memberId === B)!;
    assert.deepEqual([a.feeCpo, a.feeEmsp, a.feeNet], [135, 100, 235]);
    assert.deepEqual([b.feeCpo, b.feeEmsp, b.feeNet], [270, 100, 370]);
    assert.equal(r.positions[0]!.net, 5_000, 'the position nets amounts only');
  });

  test('currencies never mix: a CDR of another currency is an error, not a total', () => {
    assert.throws(() => net([cdr(B, A, 100, 100, 'IDR'), cdr(B, A, 100, 100, 'MYR')], 'IDR'), /cannot net a MYR CDR in a IDR run/);
    assert.throws(() => net([cdr(A, A, 100)], 'IDR'), /itself/);
    assert.throws(() => net([cdr(B, A, 1.5 as number, 1, 'MYR')], 'MYR'), /whole number/);
  });

  test('an empty run has no positions', () => {
    assert.deepEqual(net([], 'SGD'), { positions: [], members: [] });
  });
});
