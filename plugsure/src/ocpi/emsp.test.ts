import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { contractIdFor, cardToken, type CardRow } from './emsp.js';

const party = { country_code: 'ID', party_id: 'PLS', business_name: 'Nusantara Charge' };
const card = (over: Partial<CardRow> = {}): CardRow => ({
  id: '5b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d', org_id: 'o', uid: '04A1B2C3D4', status: 'Accepted', valid_to: null,
  holder_name: 'Budi', fleet_name: 'Grab Fleet', energy_limit_wh: null, spend_limit_minor: null,
  roaming_shared: true, contract_id: 'ID-PLS-C0A1B2C3D', updated_at: new Date('2026-09-27T01:02:03Z'), ...over,
});

describe('ocpi eMSP: our cards as tokens', () => {
  test('the contract id is eMAID-shaped and stable per card', () => {
    const a = contractIdFor(party, 'card-1');
    assert.match(a, /^ID-PLS-C[0-9A-F]{8}$/);
    assert.equal(a, contractIdFor(party, 'card-1'));
    assert.notEqual(a, contractIdFor(party, 'card-2'));
  });
  test('a shared, active card is a valid RFID token the CPO may accept locally', () => {
    const t = cardToken(party, card());
    assert.equal(t.type, 'RFID');
    assert.equal(t.valid, true);
    assert.equal(t.whitelist, 'ALLOWED');
    assert.equal(t.issuer, 'Nusantara Charge');
    assert.equal(t.group_id, 'GrabFleet');
    assert.equal(t.last_updated, '2026-09-27T01:02:03Z');
  });
  test('a card with a limit must be checked with us before every session', () => {
    assert.equal(cardToken(party, card({ spend_limit_minor: 500_000 })).whitelist, 'NEVER');
    assert.equal(cardToken(party, card({ energy_limit_wh: 100_000 })).whitelist, 'NEVER');
  });
  test('blocked, expired or unshared cards go out as invalid', () => {
    assert.equal(cardToken(party, card({ status: 'Blocked' })).valid, false);
    assert.equal(cardToken(party, card({ valid_to: new Date('2020-01-01') })).valid, false);
    assert.equal(cardToken(party, card({ roaming_shared: false })).valid, false);
  });
});
