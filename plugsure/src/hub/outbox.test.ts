import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ATTEMPTS } from '../ocpi/push.js';
import { RETRY_WINDOW_MS, openOutboxUrl, outcomeOf, preflight, sealOutboxUrl } from './outbox.js';

/** The outbox's decisions (design §5.5): the offline rule, the callback retry window, final vs retryable answers. */

const conn = (state: string) => ({ state } as { state: 'connected' });
const party = (status: string) => ({ status } as { status: 'CONNECTED' });

describe('before sending', () => {
  test('a broadcast to a CONNECTED party on a connected connection is sent', () => {
    assert.deepEqual(preflight('broadcast', conn('connected'), party('CONNECTED'), 0), { action: 'send' });
  });
  test('broadcasts to OFFLINE or SUSPENDED parties are dropped (do not queue push messages)', () => {
    assert.equal(preflight('broadcast', conn('connected'), party('OFFLINE'), 0).action, 'drop');
    assert.equal(preflight('broadcast', conn('connected'), party('SUSPENDED'), 0).action, 'drop');
    assert.equal(preflight('broadcast', conn('suspended'), party('CONNECTED'), 0).action, 'drop');
  });
  test('callbacks wait through an outage for up to 24 h, then fail', () => {
    assert.equal(preflight('callback', conn('connected'), party('OFFLINE'), 60_000).action, 'wait');
    assert.equal(preflight('callback', conn('connected'), party('OFFLINE'), RETRY_WINDOW_MS + 1).action, 'fail');
    assert.equal(preflight('callback', conn('connected'), party('CONNECTED'), 0).action, 'send');
  });
  test('ClientInfo is sent to an OFFLINE viewer\'s connection (it is a configuration push) and waits while suspended', () => {
    assert.equal(preflight('clientinfo', conn('connected'), null, 0).action, 'send');
    assert.equal(preflight('clientinfo', conn('suspended'), null, 0).action, 'wait');
  });
  test('a closed connection drops everything', () => {
    for (const k of ['broadcast', 'callback', 'clientinfo'] as const) assert.equal(preflight(k, conn('closed'), party('CONNECTED'), 0).action, 'drop');
    assert.equal(preflight('callback', null, null, 0).action, 'drop');
  });
});

describe('after an attempt', () => {
  test('1xxx → delivered', () => {
    assert.equal(outcomeOf('broadcast', { ok: true, ocpiStatus: 1000, failure: null }, 1, 0), 'delivered');
  });
  test('2xxx → failed at once (the receiver refused this message; no retry)', () => {
    assert.equal(outcomeOf('broadcast', { ok: false, ocpiStatus: 2001, failure: null }, 1, 0), 'failed');
    assert.equal(outcomeOf('callback', { ok: false, ocpiStatus: 2003, failure: null }, 1, 0), 'failed');
  });
  test('3xxx, 4xxx and network errors → retry, until MAX_ATTEMPTS', () => {
    assert.equal(outcomeOf('broadcast', { ok: false, ocpiStatus: 3000, failure: null }, 1, 0), 'retry');
    assert.equal(outcomeOf('broadcast', { ok: false, ocpiStatus: 4003, failure: null }, 1, 0), 'retry');
    assert.equal(outcomeOf('broadcast', { ok: false, ocpiStatus: null, failure: 'timeout' }, 1, 0), 'retry');
    assert.equal(outcomeOf('broadcast', { ok: false, ocpiStatus: null, failure: 'connection' }, MAX_ATTEMPTS, 0), 'failed');
  });
  test('a member URL the SSRF guard refuses is final', () => {
    assert.equal(outcomeOf('callback', { ok: false, ocpiStatus: null, failure: 'policy' }, 1, 0), 'failed');
  });
  test('callbacks stop retrying after 24 h', () => {
    assert.equal(outcomeOf('callback', { ok: false, ocpiStatus: null, failure: 'connection' }, 2, RETRY_WINDOW_MS + 1), 'failed');
  });
});

describe('callback URLs at rest (review180)', () => {
  test('sealed, bound to the row\'s object_key; legacy clear rows still read', () => {
    const url = 'https://emsp.example/ocpi/2.2.1/commands/START_SESSION/abc';
    const sealed = sealOutboxUrl(url, 'callback:x:1');
    assert.ok(!sealed.includes('emsp.example'));
    assert.equal(openOutboxUrl(sealed, 'callback:x:1'), url);
    assert.throws(() => openOutboxUrl(sealed, 'callback:y:1'), 'another row\'s key does not open it');
    assert.equal(openOutboxUrl(url, 'callback:x:1'), url);
  });
});
