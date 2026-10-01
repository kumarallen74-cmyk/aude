import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import * as registry from './registry.js';
import { provisionChargePoint } from './provisioning.js';
import { CONSENSUS_MIN_ORGS, parseRateUnits, pickRateUnit, recordChargerRateUnits, recordFinding } from './quirks.js';

/**
 * Provisioning and learned charging-rate units.
 *   DATABASE_URL=postgresql://postgres:…@127.0.0.1:5433/plugsure_audit_fix npx tsx --test src/ocpp/provisioning.test.ts
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[provisioning.test] SKIPPING database suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);
if (DB_OK) after(async () => { await pool.end(); });

describe('charging rate units (pure)', () => {
  test('1.6 and 2.0.1 spellings; "Current,Power" is both, not watts only', () => {
    assert.equal(parseRateUnits('Current'), 'A');
    assert.equal(parseRateUnits('Power'), 'W');
    assert.equal(parseRateUnits('Current,Power'), 'A,W');
    assert.equal(parseRateUnits('A,W'), 'A,W');
    assert.equal(parseRateUnits('W'), 'W');
    assert.equal(parseRateUnits(''), null);
    assert.equal(parseRateUnits('Volts'), null);
  });
  test('the charger\'s own answer first; a model value only when confirmed; else the hardware\'s unit', () => {
    assert.equal(pickRateUnit('W', { chargingRateUnit: 'A', chargingRateUnitConfirmedBy: 'seed' }, 'A'), 'W');
    assert.equal(pickRateUnit('A,W', null, 'A'), 'A');
    assert.equal(pickRateUnit('A,W', null, 'W'), 'W');
    assert.equal(pickRateUnit(null, { chargingRateUnit: 'W' }, 'A'), 'A', 'unconfirmed model value ignored');
    assert.equal(pickRateUnit(null, { chargingRateUnit: 'W', chargingRateUnitConfirmedBy: 'consensus' }, 'A'), 'W');
    assert.equal(pickRateUnit(null, null, 'W'), 'W');
  });
});

/** A connection that answers like a charger, recording what it was sent. */
function fakeCharger(identity: string, version: 'ocpp1.6' | 'ocpp2.0.1', answer: (action: string, payload: any) => any) {
  const sent: Array<{ action: string; payload: any }> = [];
  registry.register({
    ocppIdentity: identity,
    chargePointId: randomUUID(),
    version,
    ws: { readyState: 1 } as any,
    rpc: { call: async (action: string, payload: any) => { sent.push({ action, payload }); return answer(action, payload); }, queueDepth: 0 } as any,
    connectedAt: new Date(),
  });
  return sent;
}

dbDescribe('provisioning', () => {
  // A charge point id that does not exist: no local list to sync, nothing written.
  const ctx = (id: string) => ({ ocppIdentity: id, chargePointId: randomUUID(), orgId: randomUUID() });

  test('1.6: a charger reporting 100000 connectors gets at most 128 status triggers', async () => {
    const id = 'PROV-TEST-16';
    const sent = fakeCharger(id, 'ocpp1.6', (action) => {
      if (action === 'GetConfiguration') return { configurationKey: [{ key: 'NumberOfConnectors', value: '100000' }] };
      if (action === 'GetLocalListVersion') return { listVersion: 0 };
      return { status: 'Accepted' };
    });
    try {
      await provisionChargePoint(id, ctx(id) as any);
      const triggers = sent.filter((s) => s.action === 'TriggerMessage');
      assert.equal(triggers.length, 128);
      assert.equal(triggers.at(-1)!.payload.connectorId, 128);
    } finally {
      registry.unregister(id);
    }
  });

  test('2.0.1: provisioning speaks 2.0.1 (GetVariables / SetVariables / one station-wide TriggerMessage)', async () => {
    const id = 'PROV-TEST-201';
    const sent = fakeCharger(id, 'ocpp2.0.1', (action, p) => {
      if (action === 'GetVariables') return { getVariableResult: p.getVariableData.map((d: any) => ({ ...d, attributeStatus: 'Accepted', attributeValue: d.variable.name === 'NumberOfConnectors' ? '100000' : 'x' })) };
      if (action === 'SetVariables') return { setVariableResult: p.setVariableData.map((d: any) => ({ component: d.component, variable: d.variable, attributeStatus: 'Accepted' })) };
      return { status: 'Accepted' };
    });
    try {
      await provisionChargePoint(id, ctx(id) as any);
      const actions = new Set(sent.map((s) => s.action));
      for (const only16 of ['GetConfiguration', 'ChangeConfiguration']) assert.ok(!actions.has(only16), `${only16} must not reach a 2.0.1 station`);
      assert.ok(actions.has('GetVariables') && actions.has('SetVariables'));
      const triggers = sent.filter((s) => s.action === 'TriggerMessage');
      assert.equal(triggers.length, 1);
      assert.deepEqual(triggers[0]!.payload, { requestedMessage: 'StatusNotification' });
      // Keys with no device-model variable are not sent (and so not recorded as rejected).
      assert.ok(sent.filter((s) => s.action === 'SetVariables').every((s) => s.payload.setVariableData.length === 1));
    } finally {
      registry.unregister(id);
    }
  });
});

dbDescribe('charging rate units are per charger; the model value needs consensus', () => {
  const sfx = Date.now().toString(36);
  const orgs: string[] = [], sites: string[] = [], cps: string[] = [];
  let profileId = '';
  const context = { vendor: 'RateUnitTest', model: `M-${sfx}` };

  before(async () => {
    profileId = (await one<{ id: string }>(`INSERT INTO quirk_profile (vendor, model, findings) VALUES ($1, $2, '{}') RETURNING id`, [context.vendor, context.model]))!.id;
    for (let i = 0; i < CONSENSUS_MIN_ORGS + 1; i++) {
      const org = (await one<{ id: string }>(`INSERT INTO organisation (name, slug) VALUES ($1, $2) RETURNING id`, [`Rate Unit Org ${i}`, `rate-unit-${sfx}-${i}`]))!.id;
      const site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, pbjt_rate_bps) VALUES ($1, 'Rate Hub', 1000) RETURNING id`, [org]))!.id;
      const cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, status, quirk_profile_id) VALUES ($1, $2, 'online', $3) RETURNING id`, [site, `RATE-${sfx}-${i}`, profileId]))!.id;
      orgs.push(org); sites.push(site); cps.push(cp);
    }
  });
  after(async () => {
    await query(`DELETE FROM charge_point WHERE id = ANY($1::uuid[])`, [cps]);
    await query(`DELETE FROM site WHERE id = ANY($1::uuid[])`, [sites]);
    await query(`DELETE FROM organisation WHERE id = ANY($1::uuid[])`, [orgs]);
    await query(`DELETE FROM quirk_profile WHERE id = $1`, [profileId]);
  });
  const model = async () => (await one<{ f: any }>(`SELECT findings AS f FROM quirk_profile WHERE id = $1`, [profileId]))!.f;

  test('one charger answering "Power" changes that charger only', async () => {
    await recordChargerRateUnits(cps[0]!, profileId, 'W', context);
    assert.equal((await one<{ u: string }>(`SELECT charging_rate_units AS u FROM charge_point WHERE id = $1`, [cps[0]]))!.u, 'W');
    assert.equal((await model()).chargingRateUnit, undefined);
    // Nor through the generic finding path.
    await recordFinding(profileId, { chargingRateUnit: 'W', notes: 'x' } as any, context);
    assert.equal((await model()).chargingRateUnit, undefined);
  });

  test(`agreement across ${CONSENSUS_MIN_ORGS} tenants sets it; one dissenting charger withdraws it`, async () => {
    for (let i = 1; i < CONSENSUS_MIN_ORGS; i++) await recordChargerRateUnits(cps[i]!, profileId, 'W', context);
    assert.deepEqual([(await model()).chargingRateUnit, (await model()).chargingRateUnitConfirmedBy], ['W', 'consensus']);
    await recordChargerRateUnits(cps[CONSENSUS_MIN_ORGS]!, profileId, 'A', context);
    assert.equal((await model()).chargingRateUnit, undefined);
  });

  test('a seed or operator value is never moved by chargers', async () => {
    await query(`UPDATE quirk_profile SET findings = '{"chargingRateUnit":"A","chargingRateUnitConfirmedBy":"operator"}' WHERE id = $1`, [profileId]);
    for (const cp of cps) await recordChargerRateUnits(cp, profileId, 'W', context);
    assert.deepEqual([(await model()).chargingRateUnit, (await model()).chargingRateUnitConfirmedBy], ['A', 'operator']);
  });
});
