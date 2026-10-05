import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cdrEvent, type CdrPartyRef } from '../ledger-tap.js';
import { classifyFlags, isHard, parseCdr, HARD_FLAGS, SOFT_FLAGS, type IntakeContext, type ParsedCdr } from './intake.js';

/** CDR intake (§8.2): field checks, minor units, credit normalisation, and every hard and soft flag. */
describe('hub CDR intake', () => {
  const cpo: CdrPartyRef = { id: 'p-cpo', country_code: 'MY', party_id: 'CPX', role: 'CPO', member_id: 'm1', org_id: 'o1' };
  const emsp: CdrPartyRef = { id: 'p-emsp', country_code: 'SG', party_id: 'EMX', role: 'EMSP', member_id: 'm2', org_id: 'o2' };
  const routing = { correlation_id: 'c', request_id_in: null, request_id_out: null, route: 'direct' as const, from_connection_id: 'x', to_connection_id: null, hub_location: null };
  const base = (over: Record<string, unknown> = {}) => ({
    country_code: 'MY', party_id: 'CPX', id: 'CDR1', start_date_time: '2026-10-01T10:00:00Z', end_date_time: '2026-10-01T10:40:00Z', session_id: 'S1',
    cdr_token: { country_code: 'SG', party_id: 'EMX', uid: 'TOKEN1', type: 'RFID', contract_id: 'SG-EMX-C1' }, auth_method: 'COMMAND', authorization_reference: 'REF1',
    cdr_location: { id: 'LOC1', country: 'MYS', evse_uid: 'E1' }, currency: 'MYR', total_cost: { excl_vat: 15, incl_vat: 16.2 }, total_energy: 12.5, last_updated: '2026-10-01T10:41:00Z',
    ...over,
  });
  const parse = (over: Record<string, unknown> = {}) => parseCdr(cdrEvent(base(over), cpo, emsp, routing, 'push', 'a1'));
  const ok = (over: Record<string, unknown> = {}): ParsedCdr => {
    const r = parse(over);
    if (!r.ok) throw new Error(r.problem);
    return r.cdr;
  };
  const ctx = (over: Partial<IntakeContext> = {}): IntakeContext => ({
    receivedAt: new Date('2026-10-01T11:00:00Z'), agreementOk: true, cpoUsesSessions: true, sessionSeen: true, authorizationSeen: true, whitelistTokenKnown: true,
    overlap: false, duplicateSession: false, original: null, emspPartyId: 'p-emsp', ...over,
  });

  test('minor units per currency, half-up on the first dropped digit (4-dp inputs)', () => {
    const m = ok({ total_cost: { excl_vat: 15.0049, incl_vat: 16.2051 } });
    assert.deepEqual([m.exclMinor, m.inclMinor, m.exclRaw], [1_500, 1_621, 15.0049]);
    const s = ok({ currency: 'SGD', cdr_location: { id: 'L', country: 'SGP' }, total_cost: { excl_vat: 1.005, incl_vat: 1.0955 } });
    assert.deepEqual([s.exclMinor, s.inclMinor], [101, 110]);
    const i = ok({ currency: 'IDR', cdr_location: { id: 'L', country: 'IDN' }, total_cost: { excl_vat: 40000.5, incl_vat: 44400.4999 } });
    assert.deepEqual([i.exclMinor, i.inclMinor], [40_001, 44_400], 'IDR has no minor digits');
    const n = ok({ total_cost: { excl_vat: 15 } });
    assert.equal(n.inclMinor, null);
  });

  test('a credit CDR is negative whatever sign it was sent with', () => {
    for (const sign of [1, -1]) {
      const c = ok({ id: 'CR1', credit: true, credit_reference_id: 'CDR1', total_cost: { excl_vat: sign * 15, incl_vat: sign * 16.2 }, total_energy: sign * 12.5 });
      assert.deepEqual([c.credit, c.creditReferenceId, c.exclMinor, c.inclMinor, c.energyKwh], [true, 'CDR1', -1_500, -1_620, -12.5]);
    }
  });

  test('malformed CDRs are refused with a reason', () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ id: 'X'.repeat(40) }, /id/],
      [{ currency: 'myr' }, /ISO 4217/],
      [{ total_cost: {} }, /excl_vat/],
      [{ total_energy: null }, /total_energy/],
      [{ start_date_time: 'yesterday' }, /start_date_time/],
      [{ end_date_time: '2026-10-01T09:00:00Z' }, /before/],
      [{ cdr_token: { country_code: 'SG', party_id: 'EMX' } }, /cdr_token/],
      [{ cdr_location: null }, /cdr_location/],
      [{ credit: true }, /credit_reference_id/],
      [{ total_cost: { excl_vat: -1, incl_vat: -1 } }, /credit CDR/],
      [{ credit: true, credit_reference_id: 'CDR1', total_cost: { excl_vat: 0, incl_vat: 0 } }, /non-zero/],
    ];
    for (const [over, re] of bad) {
      const r = parse(over);
      assert.equal(r.ok, false, JSON.stringify(over));
      if (!r.ok) assert.match(r.problem, re);
    }
  });

  test('a clean CDR has no flags', () => {
    assert.deepEqual(classifyFlags(ok(), ctx()), { flags: [], holdNote: null });
  });

  test('hard flags (held)', () => {
    const flags = (over: Record<string, unknown>, c: Partial<IntakeContext> = {}) => classifyFlags(ok(over), ctx(c)).flags;
    assert.deepEqual(flags({}, { agreementOk: false }), ['no_agreement']);
    assert.ok(flags({ currency: 'EUR' }).includes('unsupported_currency'));
    assert.deepEqual(flags({ cdr_location: { id: 'L', country: 'IDN' } }), ['currency_country_mismatch']);
    assert.deepEqual(flags({ cdr_location: { id: 'L', country: 'THA' } }), ['currency_country_mismatch']);
    assert.deepEqual(flags({ total_cost: { excl_vat: 500, incl_vat: 540 } }), ['implausible'], 'above RM 10/kWh');
    assert.deepEqual(flags({ total_energy: 501, total_cost: { excl_vat: 100, incl_vat: 108 } }), ['implausible'], 'above 500 kWh');
    assert.deepEqual(flags({ total_cost: { excl_vat: 16.2, incl_vat: 15 } }), ['implausible'], 'incl < excl');
    assert.deepEqual(flags({ end_date_time: '2026-10-09T10:00:00Z' }), ['implausible'], 'longer than 7 days');
    const credit = { id: 'CR1', credit: true, credit_reference_id: 'CDR1', total_cost: { excl_vat: -15, incl_vat: -16.2 }, total_energy: -12.5 };
    const orig = { id: 'o', status: 'pending', credit: false, currency: 'MYR', emsp_party_id: 'p-emsp', total_excl_minor: 1_500, total_incl_minor: 1_620, credited_by_cdr_id: null };
    assert.deepEqual(flags(credit, { original: orig }), [], 'an exact credit of a payable original');
    assert.deepEqual(flags(credit, { original: null }), ['credit_unknown_reference']);
    assert.deepEqual(flags(credit, { original: { ...orig, emsp_party_id: 'other' } }), ['credit_unknown_reference'], 'another eMSP\'s CDR');
    assert.deepEqual(flags(credit, { original: { ...orig, currency: 'SGD' } }), ['credit_unknown_reference']);
    assert.deepEqual(flags(credit, { original: { ...orig, credited_by_cdr_id: 'x' } }), ['credit_already_applied']);
    assert.deepEqual(flags(credit, { original: { ...orig, status: 'held' } }), ['credit_original_not_payable']);
    assert.deepEqual(flags({ ...credit, total_cost: { excl_vat: -10, incl_vat: -10.8 } }, { original: orig }), ['credit_amount_mismatch']);
    // review180: settlement moves incl. tax when present, so a credit must carry incl_vat exactly when its original did
    // (else a "full" credit leaves the tax owed: original +1620, credit −1500).
    assert.deepEqual(flags({ ...credit, total_cost: { excl_vat: -15 } }, { original: orig }), ['credit_amount_mismatch', 'no_incl_vat'], 'credit without incl_vat of an original with it');
    assert.deepEqual(flags(credit, { original: { ...orig, total_incl_minor: null } }), ['credit_amount_mismatch'], 'credit with incl_vat of an original without it');
    assert.deepEqual(flags({ ...credit, total_cost: { excl_vat: -15 } }, { original: { ...orig, total_incl_minor: null } }), ['no_incl_vat'], 'both without incl_vat');
    for (const f of ['no_agreement', 'implausible', 'credit_amount_mismatch', 'cdr_duplicate_conflict', 'not_delivered']) assert.ok(isHard(f), f);
  });

  test('soft flags (pending, shown to both sides)', () => {
    const flags = (over: Record<string, unknown>, c: Partial<IntakeContext> = {}) => classifyFlags(ok(over), ctx(c)).flags;
    assert.deepEqual(flags({}, { sessionSeen: false }), ['no_session_seen']);
    assert.deepEqual(flags({}, { sessionSeen: false, cpoUsesSessions: false }), [], 'a CPO that does not use the sessions module');
    assert.deepEqual(flags({}, { authorizationSeen: false }), ['no_authorization_seen']);
    assert.deepEqual(flags({ auth_method: 'AUTH_REQUEST' }, { authorizationSeen: false }), ['no_authorization_seen']);
    assert.deepEqual(flags({ auth_method: 'WHITELIST' }, { authorizationSeen: false, whitelistTokenKnown: false }), ['whitelist_token_unknown']);
    assert.deepEqual(flags({}, { receivedAt: new Date('2026-12-15T00:00:00Z') }), ['late_cdr']);
    assert.deepEqual(flags({}, { overlap: true }), ['overlap']);
    assert.deepEqual(flags({}, { duplicateSession: true }), ['duplicate_session']);
    assert.deepEqual(flags({ total_cost: { excl_vat: 15 } }), ['no_incl_vat']);
    for (const f of SOFT_FLAGS) assert.equal(isHard(f), false, f);
    assert.equal(HARD_FLAGS.length + SOFT_FLAGS.length, 17);
  });

  test('the hold note says why', () => {
    const r = classifyFlags(ok({ total_cost: { excl_vat: 500, incl_vat: 540 } }), ctx({ agreementOk: false }));
    assert.match(r.holdNote!, /no roaming agreement/);
    assert.match(r.holdNote!, /MYR\/kWh/);
  });
});
