import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { fits, overlaps, assign, positionOf, connectorTypeOf, type Want, type FreeConnector } from './queue.js';
import { validateSite, siteInputFrom } from '../services/sites.js';

const any: Want = { current: null, type: null };
const dc: Want = { current: 'DC', type: null };
const ac: Want = { current: 'AC', type: null };
const chademo: Want = { current: 'DC', type: 'cChaDeMo' };
const ccs = (id: string): FreeConnector => ({ id, current: 'DC', type: 'cCCS2' });
const t2 = (id: string): FreeConnector => ({ id, current: 'AC', type: 'sType2' });
const e = (id: string, w: Want) => ({ id, ...w });

describe('driver queue: who can use what', () => {
  test('fits: AC/DC and plug type, empty meaning any', () => {
    assert.equal(fits(any, ccs('a')), true);
    assert.equal(fits(dc, ccs('a')), true);
    assert.equal(fits(ac, ccs('a')), false);
    assert.equal(fits(chademo, ccs('a')), false);
    assert.equal(fits({ current: null, type: 'sType2' }, t2('b')), true);
  });

  test('overlaps: two drivers compete only if some connector could serve both', () => {
    assert.equal(overlaps(any, dc), true);
    assert.equal(overlaps(ac, dc), false);
    assert.equal(overlaps(chademo, { current: 'DC', type: 'cCCS2' }), false);
    assert.equal(overlaps(chademo, dc), true);
  });

  test('an unset plug type is the usual one for its current', () => {
    assert.equal(connectorTypeOf(null, 'DC'), 'cCCS2');
    assert.equal(connectorTypeOf(null, 'AC'), 'sType2');
    assert.equal(connectorTypeOf('cChaDeMo', 'DC'), 'cChaDeMo');
  });
});

describe('driver queue: first come, first served', () => {
  test('the earliest driver who can use a free connector gets it', () => {
    const pairs = assign([e('1', any), e('2', any)], [ccs('x')]);
    assert.deepEqual(pairs.map((p) => [p.entry.id, p.connector.id]), [['1', 'x']]);
  });

  test('a later driver is served first only with a connector the earlier one cannot use', () => {
    // 1 needs DC, 2 takes anything; only an AC connector is free → 2 gets it, 1 keeps waiting (and first place).
    const pairs = assign([e('1', dc), e('2', any)], [t2('ac1')]);
    assert.deepEqual(pairs.map((p) => [p.entry.id, p.connector.id]), [['2', 'ac1']]);
  });

  test('several free connectors go out in queue order, one each', () => {
    const pairs = assign([e('1', ac), e('2', dc), e('3', any), e('4', any)], [ccs('d1'), t2('a1'), ccs('d2')]);
    assert.deepEqual(pairs.map((p) => [p.entry.id, p.connector.id]), [['1', 'a1'], ['2', 'd1'], ['3', 'd2']]);
  });

  test('nothing free, or nothing that fits: no offers', () => {
    assert.deepEqual(assign([e('1', any)], []), []);
    assert.deepEqual(assign([e('1', chademo)], [ccs('x'), t2('y')]), []);
  });

  test('position counts only the drivers ahead who compete for the same connectors', () => {
    const q = [e('1', dc), e('2', ac), e('3', any), e('4', dc)];
    assert.equal(positionOf(q, '1'), 1);
    assert.equal(positionOf(q, '2'), 1); // the DC driver ahead is no competition for AC
    assert.equal(positionOf(q, '3'), 3);
    assert.equal(positionOf(q, '4'), 3); // 1 (DC) and 3 (any) are ahead; 2 (AC) is not
    assert.equal(positionOf(q, 'nope'), null);
  });
});

describe('driver queue: site settings', () => {
  test('ranges are checked; empty keeps the stored value; the switch reads form values', () => {
    assert.deepEqual(validateSite({ queueOfferMinutes: 5, queueMaxLength: 20, queueMaxWaitMinutes: 120 }, false).errors, {});
    const bad = validateSite({ queueOfferMinutes: 1, queueMaxLength: 201, queueMaxWaitMinutes: 10 }, false).errors;
    assert.deepEqual(Object.keys(bad).sort(), ['queueMaxLength', 'queueMaxWaitMinutes', 'queueOfferMinutes']);
    assert.equal(validateSite({ queueOfferMinutes: 2.5 }, false).errors.queueOfferMinutes !== undefined, true);
    const input = siteInputFrom({ queueEnabled: 'on', queueOfferMinutes: '', queueMaxLength: '30' });
    assert.equal(input.queueEnabled, true);
    assert.equal('queueOfferMinutes' in input, false);
    assert.equal(input.queueMaxLength, 30);
    assert.equal(siteInputFrom({ queueEnabled: false }).queueEnabled, false);
    assert.equal('queueEnabled' in siteInputFrom({ name: 'x' }), false);
  });
});
