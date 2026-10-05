import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mask, redactBody, redactPath } from './log.js';
import { cdrEvent, setCdrLedger, admitCdr, onCdrRouted, type CdrPartyRef } from './ledger-tap.js';
import { hubPartiesFrom, parseHubParties } from '../config.js';

describe('the redacted message log (§5.10)', () => {
  test('token uids in paths are masked (first 4 + hash), the query is dropped', () => {
    const p = redactPath('/hub/ocpi/2.2.1/receiver/tokens/SG/EMX/04ABCDEF0123?type=RFID');
    assert.match(p, /^\/hub\/ocpi\/2\.2\.1\/receiver\/tokens\/SG\/EMX\/04AB…\([0-9a-f]{8}\)$/);
    const a = redactPath('/xem/2.2.1/s/tokens/04ABCDEF0123/authorize');
    assert.ok(a.includes('/tokens/04AB…(') && a.endsWith('/authorize') && !a.includes('04ABCDEF0123'));
    assert.equal(redactPath('/hub/ocpi/2.2.1/sender/locations?hub_cursor=SECRET'), '/hub/ocpi/2.2.1/sender/locations');
  });
  test('bodies: uid, contract_id, visual_number, auth_id, name, email, token and response_url are masked at any depth', () => {
    const b = redactBody({ cdr_token: { uid: '04ABCDEF', contract_id: 'SG-EMX-C123456', type: 'RFID' }, total_energy: 6, owner: { name: 'Budi', email: 'b@x.id' } }) as any;
    assert.equal(b.cdr_token.type, 'RFID');
    assert.equal(b.total_energy, 6);
    assert.ok(b.cdr_token.uid.startsWith('04AB…') && !JSON.stringify(b).includes('04ABCDEF'));
    assert.ok(!JSON.stringify(b).includes('Budi') && !JSON.stringify(b).includes('b@x.id'));
    assert.equal(mask('ab'), `…(${mask('ab').slice(2, 10)})`);
  });
});

describe('the ledger hook (onCdrRouted, for H2)', () => {
  const cpo: CdrPartyRef = { id: 'p1', country_code: 'MY', party_id: 'CPX', role: 'CPO', member_id: 'm1', org_id: 'o1' };
  const emsp: CdrPartyRef = { id: 'p2', country_code: 'SG', party_id: 'EMX', role: 'EMSP', member_id: 'm2', org_id: 'o2' };
  const routing = { correlation_id: 'c', request_id_in: 'r', request_id_out: null, route: 'direct' as const, from_connection_id: 'k1', to_connection_id: 'k2', hub_location: null };
  test('the event carries the parties, currency, totals (as received), ids and the raw CDR', () => {
    const cdr = { id: 'CDR1', session_id: 'S1', currency: 'MYR', total_cost: { excl_vat: 15, incl_vat: '16.2000' }, total_energy: 12.5, total_time: 0.5,
      start_date_time: '2026-10-01T10:00:00Z', end_date_time: '2026-10-01T10:30:00Z', last_updated: '2026-10-01T10:31:00Z', credit: false };
    const e = cdrEvent(cdr, cpo, emsp, routing, 'push', 'a1');
    assert.equal(e.cdr_id, 'CDR1');
    assert.equal(e.currency, 'MYR');
    assert.deepEqual(e.totals, { cost_excl_vat: 15, cost_incl_vat: 16.2, energy_kwh: 12.5, time_hours: 0.5, parking_time_hours: null });
    assert.equal(e.agreement_id, 'a1');
    assert.equal(e.cdr, cdr);
    assert.equal(e.credit, false);
  });
  test('credit CDRs keep their reference; missing totals are null', () => {
    const e = cdrEvent({ id: 'CR1', credit: true, credit_reference_id: 'CDR1', currency: 'SGD' }, cpo, emsp, routing, 'pull', null);
    assert.equal(e.credit, true);
    assert.equal(e.credit_reference_id, 'CDR1');
    assert.equal(e.totals.cost_excl_vat, null);
  });
  test('no-op by default; an implementation is called, and its failures never escape', async () => {
    const e = cdrEvent({ id: 'X' }, cpo, emsp, routing, 'push', null);
    assert.equal(await admitCdr(e), null);
    const seen: string[] = [];
    setCdrLedger({ admit: async (x) => (x.cdr_id === 'BAD' ? 'malformed' : null), onCdrRouted: async (x) => { seen.push(x.cdr_id); throw new Error('boom'); } });
    assert.equal(await admitCdr({ ...e, cdr_id: 'BAD' }), 'malformed');
    await onCdrRouted(e, null);
    assert.deepEqual(seen, ['X']);
    setCdrLedger({ admit: async () => { throw new Error('down'); }, onCdrRouted: async () => {} });
    assert.equal(await admitCdr(e), null, 'a failing admit forwards anyway');
    setCdrLedger(null);
  });
});

describe('HUB_PARTIES', () => {
  test('one CC*PID per country', () => {
    assert.deepEqual(parseHubParties('ID*PSH, my*psh,SG*PSH'), [
      { country_code: 'ID', party_id: 'PSH' }, { country_code: 'MY', party_id: 'PSH' }, { country_code: 'SG', party_id: 'PSH' }]);
  });
  test('malformed, duplicate or empty lists refuse to start', () => {
    assert.throws(() => parseHubParties('IDN*PSH'));
    assert.throws(() => parseHubParties('ID*PS'));
    assert.throws(() => parseHubParties('ID*PSH,ID*PSX'));
    assert.throws(() => parseHubParties(' , '));
  });
  test('review180: HUB_PARTIES unset or empty → the default; malformed refuses only with the hub enabled', () => {
    const dflt = parseHubParties('ID*PSH,MY*PSH,SG*PSH');
    for (const enabled of [false, true]) {
      assert.deepEqual(hubPartiesFrom(undefined, enabled), dflt);
      assert.deepEqual(hubPartiesFrom('', enabled), dflt);
      assert.deepEqual(hubPartiesFrom('  ', enabled), dflt);
    }
    assert.deepEqual(hubPartiesFrom('IDN*PSH', false), dflt, 'the hub is off: start anyway');
    assert.throws(() => hubPartiesFrom('IDN*PSH', true));
    assert.deepEqual(hubPartiesFrom('MY*PSX', true), [{ country_code: 'MY', party_id: 'PSX' }]);
  });
});
