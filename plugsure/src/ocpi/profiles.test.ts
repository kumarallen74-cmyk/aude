import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChargingProfile, profileLimitAt, parseClientInfo, clientInfoOut, type ChargingProfileIn } from './mapping.js';
import { applyPartnerCaps, allocate, type Demand } from '../services/smartcharging.js';

test('charging profile: a valid profile is cleaned; each defect is named', () => {
  const ok = parseChargingProfile({ charging_rate_unit: 'W', start_date_time: '2026-09-28T10:00:00Z', duration: 3600,
    charging_profile_period: [{ start_period: 0, limit: 11000 }, { start_period: 1800, limit: '7000' }] });
  assert.ok(typeof ok !== 'string');
  assert.deepEqual(ok.charging_profile_period, [{ start_period: 0, limit: 11000 }, { start_period: 1800, limit: 7000 }]);
  assert.equal(ok.start_date_time, '2026-09-28T10:00:00.000Z');

  const bad = (b: unknown) => parseChargingProfile(b) as string;
  assert.match(bad(null), /ChargingProfile object/);
  assert.match(bad({ charging_rate_unit: 'kW', charging_profile_period: [{ start_period: 0, limit: 1 }] }), /W or A/);
  assert.match(bad({ charging_rate_unit: 'A', charging_profile_period: [] }), /at least one period/);
  assert.match(bad({ charging_rate_unit: 'A', charging_profile_period: [{ start_period: 60, limit: 16 }] }), /first period must start at 0/);
  assert.match(bad({ charging_rate_unit: 'A', charging_profile_period: [{ start_period: 0, limit: 16 }, { start_period: 0, limit: 8 }] }), /in order/);
  assert.match(bad({ charging_rate_unit: 'A', charging_profile_period: [{ start_period: 0, limit: -1 }] }), /0 or more/);
  assert.match(bad({ charging_rate_unit: 'A', duration: 0, charging_profile_period: [{ start_period: 0, limit: 6 }] }), /duration/);
  assert.match(bad({ charging_rate_unit: 'A', start_date_time: 'soon', charging_profile_period: [{ start_period: 0, limit: 6 }] }), /not a date/);
  assert.match(bad({ charging_rate_unit: 'W', charging_profile_period: Array.from({ length: 201 }, (_, i) => ({ start_period: i * 60, limit: 1000 })) }), /at most 200/);
});

test('charging profile: the limit in force follows the schedule, from its start or from the start of charging', () => {
  const p: ChargingProfileIn = { charging_rate_unit: 'W', start_date_time: '2026-09-28T10:00:00.000Z', duration: 3600,
    charging_profile_period: [{ start_period: 0, limit: 11000 }, { start_period: 1800, limit: 7000 }] };
  const at = (iso: string) => profileLimitAt(p, new Date(iso), new Date('2026-09-28T09:00:00Z'));
  assert.equal(at('2026-09-28T09:59:59Z'), null, 'not started yet');
  assert.equal(at('2026-09-28T10:00:00Z'), 11000);
  assert.equal(at('2026-09-28T10:29:59Z'), 11000);
  assert.equal(at('2026-09-28T10:30:00Z'), 7000);
  assert.equal(at('2026-09-28T11:00:00Z'), null, 'duration over');

  const relative: ChargingProfileIn = { charging_rate_unit: 'A', charging_profile_period: [{ start_period: 0, limit: 32 }, { start_period: 600, limit: 10 }] };
  const started = new Date('2026-09-28T08:00:00Z');
  assert.equal(profileLimitAt(relative, new Date('2026-09-28T08:05:00Z'), started), 32);
  assert.equal(profileLimitAt(relative, new Date('2026-09-28T20:00:00Z'), started), 10, 'the last step holds for the rest of the session');
});

test('charging profile: a partner cap lowers a session, never raises it, and the site budget still rules', () => {
  const d = (uuid: string, maxPowerW: number): Demand => ({
    ocppIdentity: 'CP', chargePointId: 'cp', connectorNo: 1, maxPowerW, minPowerW: 5000, currentType: 'DC', phases: 3, priority: 0, active: true, connectorUuid: uuid,
  });
  const demands = [d('a', 60000), d('b', 60000)];
  const caps = new Map([['a', 20000], ['c', 1000]]);
  const capped = applyPartnerCaps(demands, caps);
  assert.equal(capped[0]!.maxPowerW, 20000);
  assert.equal(capped[1]!.maxPowerW, 60000, 'an uncapped session is untouched');
  assert.equal(applyPartnerCaps([d('a', 15000)], caps)[0]!.maxPowerW, 15000, 'a cap above the nameplate changes nothing');

  // 100 kW budget: A is capped at 20 kW and B takes the rest (up to its nameplate).
  const [a, b] = allocate(100000, capped);
  assert.equal(a!.allocatedW, 20000);
  assert.equal(b!.allocatedW, 60000);
  // 30 kW budget: the cap is a ceiling, not a reservation — the budget still splits fairly.
  const [a2, b2] = allocate(30000, capped);
  assert.ok(a2!.allocatedW <= 20000 && a2!.allocatedW + b2!.allocatedW <= 30000);

  // A zero cap pauses the session without giving it the usual 5 kW floor.
  const [z] = allocate(100000, applyPartnerCaps([d('a', 60000)], new Map([['a', 0]])));
  assert.equal(z!.allocatedW, 0);
});

test('hub client info: validated against the URL, and written back in OCPI form', () => {
  const c = parseClientInfo({ country_code: 'nl', party_id: 'abc', role: 'CPO', status: 'CONNECTED', last_updated: '2026-09-28T10:00:00Z' }, { country_code: 'NL', party_id: 'ABC' });
  assert.ok(typeof c !== 'string');
  assert.deepEqual(clientInfoOut(c), { party_id: 'ABC', country_code: 'NL', role: 'CPO', status: 'CONNECTED', last_updated: '2026-09-28T10:00:00Z' });
  assert.match(parseClientInfo({ ...c, last_updated: c.last_updated.toISOString() }, { country_code: 'NL', party_id: 'XYZ' }) as string, /match the URL/);
  assert.match(parseClientInfo({ country_code: 'NL', party_id: 'ABC', role: 'CPO', status: 'GONE', last_updated: '2026-09-28T10:00:00Z' }) as string, /status must be/);
  assert.match(parseClientInfo({ country_code: 'NL', party_id: 'ABC', role: 'BANK', status: 'OFFLINE', last_updated: '2026-09-28T10:00:00Z' }) as string, /role must be/);
  assert.match(parseClientInfo({ country_code: 'NL', party_id: 'ABC', role: 'CPO', status: 'OFFLINE' }) as string, /last_updated/);
});

// ── multi-country: one OCPI party per (organisation, country)
import { ourCredentials } from './registration.js';
import { pickParty } from './store.js';

test('credentials list a CPO role per country party and the eMSP role of the home party', () => {
  const home = { country_code: 'ID', party_id: 'PLS', business_name: 'PT PlugSure' };
  const sg = { country_code: 'SG', party_id: 'PLS', business_name: 'PlugSure SG Pte Ltd', website: 'https://plugsure.sg' };
  const c = ourCredentials([home, sg], 'tok', 'https://ocpi.example');
  assert.deepEqual(c.roles.map((r) => [r.role, r.country_code, r.party_id, r.business_details.name]), [
    ['CPO', 'ID', 'PLS', 'PT PlugSure'],
    ['EMSP', 'ID', 'PLS', 'PT PlugSure'],
    ['CPO', 'SG', 'PLS', 'PlugSure SG Pte Ltd'],
  ]);
  // One party: exactly the v1.6 credentials.
  assert.deepEqual(ourCredentials(home, 'tok', 'https://ocpi.example').roles.map((r) => r.role), ['CPO', 'EMSP']);
  assert.deepEqual(ourCredentials([home], 'tok', 'https://ocpi.example'), ourCredentials(home, 'tok', 'https://ocpi.example'));
});

test('a site is published under the party of its country only — never under another country\'s (review 9)', () => {
  const home = { country_code: 'ID', party_id: 'PLS', business_name: 'A' };
  const my = { country_code: 'MY', party_id: 'PLM', business_name: 'B' };
  assert.equal(pickParty([home, my], 'MY'), my);
  assert.equal(pickParty([home, my], 'ID'), home);
  assert.equal(pickParty([home, my], 'SG'), null, 'no SG party: not published (flagged), not the Indonesian identity');
  assert.equal(pickParty([home, my], null), home, 'no country (legacy caller): the home party');
  assert.equal(pickParty(home, 'MY'), null, 'a single Indonesian party does not stand for a Malaysian site');
  assert.equal(pickParty(home, 'ID'), home);
  assert.equal(pickParty([], 'ID'), null);
});
