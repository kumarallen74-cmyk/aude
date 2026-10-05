import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CURSOR_TTL_MS, cdrLocationUrl, commandCallbackUrl, cursorUrl, filtersOf, linkNext, newCallbackId, openCursor, parseLinkNext,
  profileCallbackUrl, queryWithResponseUrl, sameOrigin, sealCursor, withQuery, withResponseUrl,
} from './rewrite.js';

/** Rewrites (design §5.6): Link → sealed hub cursor; response_url and CDR Location → hub callbacks. */

const base = { conn: 'conn-1', kind: 'all' as const, module: 'locations', from: 'p-1', src: ['s1', 's2'], i: 0, next: null, q: 'date_from=2026-01-01T00%3A00%3A00Z', limit: 10, total: 42 };

describe('hub cursors', () => {
  test('seal and open round trip, url-safe', () => {
    const t = sealCursor(base);
    assert.match(t, /^[A-Za-z0-9_-]+$/);
    const c = openCursor(t, 'conn-1');
    assert.ok(typeof c === 'object');
    assert.deepEqual({ ...c, exp: 0 }, { v: 1, ...base, exp: 0 });
  });
  test('bound to the requesting connection: another member\'s token cannot use it', () => {
    assert.equal(openCursor(sealCursor(base), 'conn-2'), 'other_connection');
  });
  test('expires after an hour', () => {
    const now = Date.now();
    const t = sealCursor(base, now);
    assert.ok(typeof openCursor(t, 'conn-1', now + CURSOR_TTL_MS - 1000) === 'object');
    assert.equal(openCursor(t, 'conn-1', now + CURSOR_TTL_MS + 1), 'expired');
  });
  test('tampered or foreign values are malformed', () => {
    const t = sealCursor(base);
    assert.equal(openCursor(t.slice(0, -4) + 'AAAA', 'conn-1'), 'malformed');
    assert.equal(openCursor('not-a-cursor', 'conn-1'), 'malformed');
  });
  test('the hub Link points at the hub\'s own sender endpoint, with only the cursor', () => {
    const u = cursorUrl('https://hub.example', 'tariffs', 'TOKEN');
    assert.equal(u, 'https://hub.example/hub/ocpi/2.2.1/sender/tariffs?hub_cursor=TOKEN');
    assert.equal(linkNext(u), `<${u}>; rel="next"`);
  });
});

describe('Link and query handling', () => {
  test('parseLinkNext finds rel="next" (quoted or not, among others)', () => {
    assert.equal(parseLinkNext('<https://a/x?offset=10>; rel="next"'), 'https://a/x?offset=10');
    assert.equal(parseLinkNext('<https://a/p>; rel="prev", <https://a/n>; rel=next'), 'https://a/n');
    assert.equal(parseLinkNext(['<https://a/n>; rel="next"']), 'https://a/n');
    assert.equal(parseLinkNext(''), null);
    assert.equal(parseLinkNext(undefined), null);
  });
  test('filtersOf keeps filters, drops paging and the cursor, caps limit at 100', () => {
    assert.deepEqual(filtersOf({ date_from: 'x', offset: '20', limit: '500', hub_cursor: 'c' }), { q: 'date_from=x', limit: 100 });
    assert.deepEqual(filtersOf({ limit: '5' }), { q: '', limit: 5 });
    assert.deepEqual(filtersOf({ limit: 'nope' }), { q: '', limit: 100 });
  });
  test('withQuery adds filters, limit and offset to an endpoint URL', () => {
    const u = new URL(withQuery('https://cpo.example/ocpi/locations', 'date_from=x', 10, 0));
    assert.equal(u.searchParams.get('date_from'), 'x');
    assert.equal(u.searchParams.get('limit'), '10');
    assert.equal(u.searchParams.get('offset'), '0');
  });
  test('sameOrigin compares scheme, host and port', () => {
    assert.equal(sameOrigin('https://a.example/x', 'https://a.example:443/y'), true);
    assert.equal(sameOrigin('https://a.example/x', 'https://evil.example/x'), false);
    assert.equal(sameOrigin('https://a.example/x', 'http://a.example/x'), false);
    assert.equal(sameOrigin('nonsense', 'https://a.example'), false);
  });
});

describe('callback URLs', () => {
  test('ids are 128-bit random, url-safe', () => {
    const a = newCallbackId();
    assert.match(a, /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(a, newCallbackId());
  });
  test('command, profile and CDR Location URLs are on the hub', () => {
    assert.equal(commandCallbackUrl('https://h', 'START_SESSION', 'id1'), 'https://h/hub/ocpi/2.2.1/sender/commands/START_SESSION/id1');
    assert.equal(profileCallbackUrl('https://h', 'id2'), 'https://h/hub/ocpi/2.2.1/sender/chargingprofiles/result/id2');
    assert.equal(cdrLocationUrl('https://h', 'id3'), 'https://h/hub/ocpi/2.2.1/receiver/cdrs/id3');
  });
  test('response_url in a body is replaced, nothing else is touched (key order kept)', () => {
    const b = { response_url: 'https://emsp/r', token: { uid: 'x' }, location_id: 'L', last_updated: '2026-01-01T00:00:00Z' };
    const r = withResponseUrl(b, 'https://h/cb');
    assert.equal(r.response_url, 'https://h/cb');
    assert.deepEqual(Object.keys(r), Object.keys(b));
    assert.equal(r.last_updated, b.last_updated);
    assert.equal(b.response_url, 'https://emsp/r');
  });
  test('response_url in a query (charging profiles GET / DELETE) is replaced', () => {
    const q = new URLSearchParams(queryWithResponseUrl({ duration: '900', response_url: 'https://emsp/r' }, 'https://h/cb'));
    assert.equal(q.get('duration'), '900');
    assert.equal(q.get('response_url'), 'https://h/cb');
    assert.equal(q.getAll('response_url').length, 1);
  });
});
