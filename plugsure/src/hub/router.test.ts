import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classify, filterObjects, partyHeader, pickFrom } from './router.js';
import { HubError } from './errors.js';
import type { HubParty } from './types.js';

/**
 * The router's pure parts (design §5.2, §5.3): classification of every routing-table row, the from-party
 * check, routing headers and the response filter. The routing itself is exercised end to end by
 * tools/e2e/hub-e2e.mts and in-process by hub.db.test.ts.
 */

const party = (cc: string, pid: string, role: string, status = 'CONNECTED', id = `${cc}${pid}${role}`): HubParty => ({
  id, member_id: 'm', org_id: 'o', connection_id: 'c', country_code: cc, party_id: pid, role: role as HubParty['role'], business_name: 'x', website: null,
  status: status as HubParty['status'], admin_suspended: false, status_changed_at: new Date(),
});

const err = (fn: () => unknown): HubError => {
  try { fn(); } catch (e) { if (e instanceof HubError) return e; throw e; }
  throw new Error('expected a HubError');
};

describe('classify: every row of the routing table (§5.3)', () => {
  test('receiver/locations PUT/PATCH: CPO → eMSP side, broadcastable, client-owned URL', () => {
    for (const [path, method] of [['receiver/locations/MY/CPX/L1', 'PUT'], ['receiver/locations/MY/CPX/L1/E1', 'PATCH'], ['receiver/locations/MY/CPX/L1/E1/1', 'PUT']] as const) {
      const c = classify(path, method);
      assert.equal(c.module, 'locations');
      assert.deepEqual(c.callerRoles, ['CPO']);
      assert.ok(c.targetRoles.includes('EMSP') && c.targetRoles.includes('NSP') && c.targetRoles.includes('OTHER'));
      assert.equal(c.broadcastable, true);
      assert.deepEqual(c.urlParty, { country_code: 'MY', party_id: 'CPX' });
    }
  });
  test('receiver/locations GET (a CPO checks its copy): not broadcastable', () => {
    const c = classify('receiver/locations/MY/CPX/L1', 'GET');
    assert.equal(c.broadcastable, false);
    assert.equal(c.list, false);
  });
  test('receiver/locations: other methods and malformed paths are refused', () => {
    assert.equal(err(() => classify('receiver/locations/MY/CPX/L1', 'DELETE')).http, 405);
    assert.equal(err(() => classify('receiver/locations/MY/CPX', 'PUT')).http, 404);
  });
  test('receiver/tariffs PUT and DELETE are broadcast (our reading of the spec)', () => {
    assert.equal(classify('receiver/tariffs/MY/CPX/T1', 'PUT').broadcastable, true);
    assert.equal(classify('receiver/tariffs/MY/CPX/T1', 'DELETE').broadcastable, true);
    assert.equal(err(() => classify('receiver/tariffs/MY/CPX/T1', 'PATCH')).http, 405);
  });
  test('receiver/tokens PUT/PATCH: eMSP → CPO, broadcastable', () => {
    const c = classify('receiver/tokens/SG/EMX/04AB?type=RFID', 'PUT');
    assert.deepEqual([...c.callerRoles], ['EMSP', 'OTHER']);
    assert.deepEqual([...c.targetRoles], ['CPO']);
    assert.equal(c.broadcastable, true);
    assert.deepEqual(c.segs, ['SG', 'EMX', '04AB']);
  });
  test('receiver/sessions PUT/PATCH: CPO → eMSP side, NOT broadcastable', () => {
    const c = classify('receiver/sessions/MY/CPX/S1', 'PUT');
    assert.equal(c.broadcastable, false);
    assert.deepEqual([...c.callerRoles], ['CPO']);
    assert.ok(c.targetRoles.includes('EMSP'));
    assert.equal(classify('receiver/sessions/MY/CPX/S1', 'PATCH').broadcastable, false);
  });
  test('receiver/cdrs POST: CPO → eMSP; GET receiver/cdrs/{id} is the hub Location', () => {
    const c = classify('receiver/cdrs', 'POST');
    assert.equal(c.kind, 'functional');
    assert.equal(c.broadcastable, false);
    assert.equal(classify('receiver/cdrs/abcDEF', 'GET').kind, 'cdr_location');
    assert.equal(err(() => classify('receiver/cdrs', 'GET')).http, 405);
  });
  test('receiver/commands/{TYPE} POST: eMSP → CPO, commands flag, command upper-cased', () => {
    const c = classify('receiver/commands/start_session', 'POST');
    assert.deepEqual(c.segs, ['START_SESSION']);
    assert.equal(c.flag, 'commands');
    assert.deepEqual([...c.targetRoles], ['CPO']);
    assert.equal(err(() => classify('receiver/commands/START_SESSION', 'GET')).http, 404);
  });
  test('receiver/chargingprofiles/{session} GET/PUT/DELETE: eMSP or SCSP → CPO', () => {
    for (const m of ['GET', 'PUT', 'DELETE']) {
      const c = classify('receiver/chargingprofiles/S1', m);
      assert.ok(c.callerRoles.includes('SCSP') && c.callerRoles.includes('EMSP'));
      assert.equal(c.flag, 'chargingprofiles');
    }
  });
  test('sender lists (locations, tariffs, sessions, cdrs): eMSP side → CPO, GET All when to = hub', () => {
    for (const m of ['locations', 'tariffs', 'sessions', 'cdrs']) {
      const c = classify(`sender/${m}`, 'GET');
      assert.equal(c.list, true, m);
      assert.ok(c.callerRoles.includes('EMSP') && c.callerRoles.includes('NSP'), m);
      assert.deepEqual([...c.targetRoles], ['CPO'], m);
    }
    assert.equal(classify('sender/locations/L1/E1', 'GET').list, false);
    assert.equal(err(() => classify('sender/locations', 'POST')).http, 405);
  });
  test('sender/sessions/{id}/charging_preferences PUT', () => {
    const c = classify('sender/sessions/S1/charging_preferences', 'PUT');
    assert.equal(c.list, false);
    assert.deepEqual([...c.targetRoles], ['CPO']);
  });
  test('sender/tokens: GET list (CPO pulls eMSP tokens) and real-time authorize', () => {
    const l = classify('sender/tokens', 'GET');
    assert.equal(l.list, true);
    assert.deepEqual([...l.callerRoles], ['CPO']);
    const a = classify('sender/tokens/04AB/authorize', 'POST');
    assert.equal(a.realtime, true);
    assert.equal(a.flag, 'realtime');
    assert.deepEqual(a.segs, ['04AB', 'authorize']);
  });
  test('callbacks: command results and charging-profile results; ActiveChargingProfile PUT', () => {
    const c = classify('sender/commands/START_SESSION/cb123', 'POST');
    assert.equal(c.kind, 'callback_command');
    assert.deepEqual([...c.callerRoles], ['CPO']);
    assert.equal(classify('sender/chargingprofiles/result/cb123', 'POST').kind, 'callback_profile');
    const ap = classify('sender/chargingprofiles/S1', 'PUT');
    assert.equal(ap.kind, 'functional');
    assert.deepEqual([...ap.callerRoles], ['CPO']);
  });
  test('unknown interfaces and modules', () => {
    assert.equal(err(() => classify('elsewhere/locations', 'GET')).http, 404);
    assert.equal(err(() => classify('sender/parking', 'GET')).http, 404);
  });
  test('path segments are decoded once; a malformed escape is refused', () => {
    assert.deepEqual(classify('receiver/tokens/SG/EMX/A%2FB', 'PUT').segs, ['SG', 'EMX', 'A/B']);
    assert.equal(err(() => classify('receiver/tokens/SG/EMX/%E0%A4%A', 'PUT')).ocpi, 2001);
  });
});

describe('the from-party check (§5.2 step 6)', () => {
  const own = [party('MY', 'CPX', 'CPO'), party('MY', 'CPX', 'EMSP'), party('SG', 'CPY', 'CPO'), party('SG', 'OLD', 'CPO', 'SUSPENDED')];
  test('a party of this connection in a fitting role', () => {
    assert.equal(pickFrom(own, { country_code: 'MY', party_id: 'CPX' }, ['CPO']).role, 'CPO');
    assert.equal(pickFrom(own, { country_code: 'MY', party_id: 'CPX' }, ['EMSP', 'OTHER']).role, 'EMSP');
  });
  test('a party of another connection → 403 / 4903', () => {
    const e = err(() => pickFrom(own, { country_code: 'ID', party_id: 'PLS' }, ['CPO']));
    assert.equal(e.http, 403);
    assert.equal(e.ocpi, 4903);
  });
  test('the right party in the wrong role → 4903', () => {
    assert.equal(err(() => pickFrom(own, { country_code: 'SG', party_id: 'CPY' }, ['EMSP'])).ocpi, 4903);
  });
  test('a SUSPENDED (or PLANNED) party cannot send', () => {
    const e = err(() => pickFrom(own, { country_code: 'SG', party_id: 'OLD' }, ['CPO']));
    assert.equal(e.http, 403);
    assert.equal(e.ocpi, 2000);
  });
  test('no headers: inferred only when exactly one party fits', () => {
    assert.equal(pickFrom(own, null, ['EMSP']).party_id, 'CPX');
    assert.equal(err(() => pickFrom(own, null, ['CPO'])).ocpi, 2001);
    assert.equal(err(() => pickFrom(own, null, ['SCSP'])).ocpi, 2001);
  });
});

describe('routing headers', () => {
  test('well-formed OCPI-from / OCPI-to are upper-cased; malformed ones are ignored', () => {
    assert.deepEqual(partyHeader({ 'ocpi-to-country-code': 'my', 'ocpi-to-party-id': 'cpx' }, 'to'), { country_code: 'MY', party_id: 'CPX' });
    assert.equal(partyHeader({ 'ocpi-from-country-code': 'MYS', 'ocpi-from-party-id': 'CPX' }, 'from'), null);
    assert.equal(partyHeader({ 'ocpi-from-country-code': 'MY' }, 'from'), null);
    assert.equal(partyHeader({ 'ocpi-from-country-code': 'MY', 'ocpi-from-party-id': 'C X' }, 'from'), null);
  });
});

describe('the response filter (defence in depth, §5.3)', () => {
  const src = { country_code: 'MY', party_id: 'CPX' };
  const me = { country_code: 'SG', party_id: 'EMX' };
  test('locations: only the source\'s own objects', () => {
    const r = filterObjects('locations', [{ id: '1', ...src }, { id: '2', country_code: 'MY', party_id: 'OTH' }, null], src, me);
    assert.deepEqual(r.kept.map((x) => x.id), ['1']);
    assert.equal(r.dropped, 2);
  });
  test('sessions and CDRs: only the requester\'s drivers', () => {
    const items = [
      { id: 'a', ...src, cdr_token: { country_code: 'SG', party_id: 'EMX' } },
      { id: 'b', ...src, cdr_token: { country_code: 'SG', party_id: 'OTH' } },
      { id: 'c', ...src },
    ];
    for (const m of ['sessions', 'cdrs']) {
      const r = filterObjects(m, items, src, me);
      assert.deepEqual(r.kept.map((x) => x.id), ['a'], m);
      assert.equal(r.dropped, 2, m);
    }
  });
});
