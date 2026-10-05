import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hubBroadcastActor } from './server.js';

/**
 * A hub's Broadcast Push arrives FROM the hub itself (OCPI 2.2.1: hub → each receiver, from = the Hub),
 * with the owner in the URL. The tenant side then acts for that owner (still checked against the hub's
 * announced clients by the caller). Anything else keeps the H0 rule: from = the acting party.
 */

const hub = { kind: 'hub' as const, roles: [{ role: 'HUB', country_code: 'ID', party_id: 'PSH' }, { role: 'HUB', country_code: 'SG', party_id: 'PSH' }] };
const HUBP = { country_code: 'ID', party_id: 'PSH' };
const V = '/ocpi/2.2.1';

describe('hubBroadcastActor', () => {
  test('locations / tariffs (eMSP side) and tokens (CPO side) written by the hub as itself act for the URL owner', () => {
    assert.deepEqual(hubBroadcastActor(hub, HUBP, `${V}/emsp/locations/:cc/:pid/:loc`, 'PUT', { cc: 'my', pid: 'cpx', loc: 'L1' }), { country_code: 'MY', party_id: 'CPX' });
    assert.deepEqual(hubBroadcastActor(hub, HUBP, `${V}/emsp/locations/:cc/:pid/:loc/:evse`, 'PATCH', { cc: 'MY', pid: 'CPX' }), { country_code: 'MY', party_id: 'CPX' });
    assert.deepEqual(hubBroadcastActor(hub, HUBP, `${V}/emsp/tariffs/:cc/:pid/:id`, 'DELETE', { cc: 'MY', pid: 'CPX' }), { country_code: 'MY', party_id: 'CPX' });
    assert.deepEqual(hubBroadcastActor(hub, HUBP, `${V}/tokens/:cc/:pid/:uid`, 'PUT', { cc: 'SG', pid: 'EMX' }), { country_code: 'SG', party_id: 'EMX' });
  });
  test('not for a party that is not one of the hub\'s own HUB roles', () => {
    assert.equal(hubBroadcastActor(hub, { country_code: 'MY', party_id: 'CPX' }, `${V}/emsp/locations/:cc/:pid/:loc`, 'PUT', { cc: 'MY', pid: 'CPX' }), null);
  });
  test('not for a peer (non-hub) partner', () => {
    assert.equal(hubBroadcastActor({ kind: 'emsp', roles: [{ role: 'EMSP', country_code: 'ID', party_id: 'PSH' }] }, HUBP, `${V}/tokens/:cc/:pid/:uid`, 'PUT', { cc: 'SG', pid: 'EMX' }), null);
  });
  test('not for reads, sessions, CDRs, commands, or anything without an owner in the URL', () => {
    assert.equal(hubBroadcastActor(hub, HUBP, `${V}/emsp/locations/:cc/:pid/:loc`, 'GET', { cc: 'MY', pid: 'CPX' }), null);
    assert.equal(hubBroadcastActor(hub, HUBP, `${V}/emsp/sessions/:cc/:pid/:id`, 'PUT', { cc: 'MY', pid: 'CPX' }), null);
    assert.equal(hubBroadcastActor(hub, HUBP, `${V}/emsp/cdrs`, 'POST', {}), null);
    assert.equal(hubBroadcastActor(hub, HUBP, `${V}/commands/:command`, 'POST', { command: 'START_SESSION' }), null);
    assert.equal(hubBroadcastActor(hub, HUBP, `${V}/tokens/:cc/:pid/:uid`, 'PUT', { cc: 'SGP', pid: 'EMX' }), null);
  });
});
