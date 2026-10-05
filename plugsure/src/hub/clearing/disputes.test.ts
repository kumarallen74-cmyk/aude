import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { nextStatus, LIVE, FINAL, type DisputeAction, type Side } from './disputes.js';
import { HubError } from '../errors.js';

/** The dispute state machine (§8.3, "H2 as built"): every allowed transition, and who may make it. */
describe('dispute state machine', () => {
  const ALLOWED: Array<[string, DisputeAction, Side, string]> = [
    ['open', 'accept', 'cpo', 'accepted'],
    ['open', 'reject', 'cpo', 'rejected'],
    ['open', 'withdraw', 'emsp', 'withdrawn'],
    ['open', 'escalate', 'platform', 'escalated'],
    ['open', 'expire_response', 'system', 'escalated'],
    ['open', 'resolve_upheld', 'platform', 'resolved'],
    ['open', 'resolve_written_off', 'platform', 'resolved'],
    ['open', 'resolve_credit_required', 'platform', 'accepted'],
    ['open', 'credit', 'system', 'credited'],
    ['accepted', 'credit', 'system', 'credited'],
    ['accepted', 'expire_credit', 'system', 'escalated'],
    ['accepted', 'withdraw', 'emsp', 'withdrawn'],
    ['rejected', 'escalate', 'emsp', 'escalated'],
    ['rejected', 'expire_escalation', 'system', 'expired'],
    ['rejected', 'withdraw', 'emsp', 'withdrawn'],
    ['rejected', 'credit', 'system', 'credited'],
    ['escalated', 'resolve_upheld', 'platform', 'resolved'],
    ['escalated', 'resolve_written_off', 'platform', 'resolved'],
    ['escalated', 'resolve_credit_required', 'platform', 'accepted'],
    ['escalated', 'credit', 'system', 'credited'],
    ['escalated', 'withdraw', 'emsp', 'withdrawn'],
  ];

  test('allowed transitions', () => {
    for (const [from, action, by, to] of ALLOWED) assert.equal(nextStatus(from, action, by), to, `${from} --${action} (${by})`);
  });

  test('the wrong side is refused (403)', () => {
    const wrong: Array<[string, DisputeAction, Side]> = [
      ['open', 'accept', 'emsp'], ['open', 'reject', 'emsp'], ['open', 'accept', 'platform'], ['open', 'withdraw', 'cpo'],
      ['rejected', 'escalate', 'cpo'], ['open', 'resolve_upheld', 'cpo'], ['escalated', 'resolve_written_off', 'emsp'], ['open', 'expire_response', 'platform'],
    ];
    for (const [from, action, by] of wrong) {
      assert.throws(() => nextStatus(from, action, by), (e: unknown) => e instanceof HubError && e.http === 403, `${from} --${action} (${by})`);
    }
  });

  test('impossible transitions are refused (409)', () => {
    const none: Array<[string, DisputeAction]> = [
      ['open', 'expire_escalation'], ['open', 'expire_credit'], ['accepted', 'accept'], ['accepted', 'reject'], ['rejected', 'accept'],
      ['escalated', 'accept'], ['escalated', 'escalate'], ['open', 'escalate'],
    ];
    for (const [from, action] of none.filter(([f, a]) => !(f === 'open' && a === 'escalate'))) {
      assert.throws(() => nextStatus(from, action, 'cpo'), (e: unknown) => e instanceof HubError && (e.http === 409 || e.http === 403), `${from} --${action}`);
    }
    assert.throws(() => nextStatus('open', 'escalate', 'emsp'), (e: unknown) => e instanceof HubError && e.http === 403, 'the eMSP escalates only a rejection');
  });

  test('final states accept nothing', () => {
    for (const s of FINAL) {
      for (const a of ['accept', 'reject', 'escalate', 'withdraw', 'resolve_upheld', 'credit', 'expire_escalation'] as DisputeAction[]) {
        assert.throws(() => nextStatus(s, a, 'platform'), (e: unknown) => e instanceof HubError && e.http === 409, `${s} --${a}`);
      }
    }
    assert.deepEqual([...LIVE].sort(), ['accepted', 'escalated', 'open', 'rejected']);
  });
});
