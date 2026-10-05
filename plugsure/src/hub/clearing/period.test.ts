import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, daysBetween, finalisableAt, localDateString, periodBounds, periodOf, previousPeriod, zoneOfCurrency } from './period.js';

/** Settlement periods follow each currency's country calendar (IDR WIB +7, MYR/SGD +8): cut-offs at month ends. */
describe('settlement periods and time-zone cut-offs', () => {
  const at = (s: string) => new Date(s);

  test('each currency settles in its country\'s zone', () => {
    assert.equal(zoneOfCurrency('IDR'), 'Asia/Jakarta');
    assert.equal(zoneOfCurrency('MYR'), 'Asia/Kuala_Lumpur');
    assert.equal(zoneOfCurrency('SGD'), 'Asia/Singapore');
    assert.throws(() => zoneOfCurrency('EUR'));
  });

  test('IDR: October 2026 is [30 Sep 17:00Z, 31 Oct 17:00Z) — local midnight in Jakarta', () => {
    const b = periodBounds('IDR', '2026-10')!;
    assert.equal(b.start.toISOString(), '2026-09-30T17:00:00.000Z');
    assert.equal(b.end.toISOString(), '2026-10-31T17:00:00.000Z');
    assert.equal(b.timeZone, 'Asia/Jakarta');
  });

  test('MYR and SGD: October 2026 is [30 Sep 16:00Z, 31 Oct 16:00Z)', () => {
    for (const cur of ['MYR', 'SGD'] as const) {
      const b = periodBounds(cur, '2026-10')!;
      assert.equal(b.start.toISOString(), '2026-09-30T16:00:00.000Z', cur);
      assert.equal(b.end.toISOString(), '2026-10-31T16:00:00.000Z', cur);
    }
  });

  test('a CDR received one second before / at local midnight on 31 October falls in October / November', () => {
    assert.equal(periodOf(at('2026-10-31T16:59:59Z'), 'IDR'), '2026-10');
    assert.equal(periodOf(at('2026-10-31T17:00:00Z'), 'IDR'), '2026-11');
    assert.equal(periodOf(at('2026-10-31T15:59:59Z'), 'MYR'), '2026-10');
    assert.equal(periodOf(at('2026-10-31T16:00:00Z'), 'MYR'), '2026-11');
    assert.equal(periodOf(at('2026-10-31T16:00:00Z'), 'SGD'), '2026-11');
    // The same instant is still October in Jakarta but already November in Singapore.
    assert.equal(periodOf(at('2026-10-31T16:30:00Z'), 'IDR'), '2026-10');
    assert.equal(periodOf(at('2026-10-31T16:30:00Z'), 'SGD'), '2026-11');
  });

  test('year end and February (leap year)', () => {
    assert.equal(periodBounds('IDR', '2026-12')!.end.toISOString(), '2026-12-31T17:00:00.000Z');
    assert.equal(periodOf(at('2026-12-31T17:30:00Z'), 'IDR'), '2027-01');
    assert.equal(periodOf(at('2026-12-31T16:30:00Z'), 'IDR'), '2026-12');
    assert.equal(periodBounds('SGD', '2028-02')!.end.toISOString(), '2028-02-29T16:00:00.000Z');
    assert.equal(periodBounds('MYR', '2027-02')!.end.toISOString(), '2027-02-28T16:00:00.000Z');
  });

  test('a CDR is in exactly one period: bounds tile the calendar', () => {
    for (const cur of ['IDR', 'MYR', 'SGD'] as const) {
      for (const p of ['2026-01', '2026-02', '2026-06', '2026-11']) {
        const b = periodBounds(cur, p)!;
        assert.equal(periodOf(b.start, cur), p);
        assert.equal(periodOf(new Date(b.end.getTime() - 1), cur), p);
        assert.notEqual(periodOf(b.end, cur), p);
      }
    }
  });

  test('weekly cycle: Monday to Monday, local', () => {
    assert.equal(periodOf(at('2026-10-07T05:00:00Z'), 'SGD', 'weekly'), '2026-10-05');
    assert.equal(periodOf(at('2026-10-04T16:30:00Z'), 'SGD', 'weekly'), '2026-10-05'); // Mon 00:30 SGT
    assert.equal(periodOf(at('2026-10-04T16:30:00Z'), 'IDR', 'weekly'), '2026-09-28'); // Sun 23:30 WIB
    const b = periodBounds('IDR', '2026-10-05', 'weekly')!;
    assert.equal(b.start.toISOString(), '2026-10-04T17:00:00.000Z');
    assert.equal(b.end.toISOString(), '2026-10-11T17:00:00.000Z');
    assert.equal(periodBounds('IDR', '2026-10-06', 'weekly'), null, 'a weekly period starts on a Monday');
  });

  test('malformed periods are refused', () => {
    for (const p of ['2026-13', '2026-1', '26-10', '2026-10-01', '']) assert.equal(periodBounds('IDR', p), null, p);
  });

  test('previous period, finalisation date, local dates', () => {
    assert.equal(previousPeriod(at('2026-11-01T02:00:00Z'), 'IDR'), '2026-10');
    assert.equal(previousPeriod(at('2027-01-01T01:00:00Z'), 'SGD'), '2026-12');
    assert.equal(previousPeriod(at('2026-10-31T17:30:00Z'), 'IDR'), '2026-10', 'already 1 Nov in Jakarta');
    // September's run (period end 1 Oct 00:00 local) finalises after the 14-day window of CDRs received on 30 Sep.
    const end = periodBounds('IDR', '2026-09')!.end;
    assert.equal(finalisableAt(end, 14).toISOString(), '2026-10-15T17:00:00.000Z');
    assert.equal(localDateString(at('2026-10-31T17:30:00Z'), 'IDR'), '2026-11-01');
    assert.equal(localDateString(at('2026-10-31T15:30:00Z'), 'SGD'), '2026-10-31');
    assert.equal(addDays('2026-12-25', 14), '2027-01-08');
    assert.equal(daysBetween('2026-10-15', '2026-10-29'), 14);
  });
});
