import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { corsHeadersFor, parseWebOrigins, registerDriverCors } from './cors.js';

/** DRIVER_WEB_ORIGINS: CORS for browser builds of the native app — driver API only, exact origins, off by default. */
describe('driver API CORS (DRIVER_WEB_ORIGINS)', () => {
  test('exact origins only; http:// only outside production; junk ignored', () => {
    assert.deepEqual(parseWebOrigins('http://localhost:8081, https://Preview.PlugSure.asia/ ,*,https://x.test/path,ftp://a', 'development'),
      { origins: ['http://localhost:8081', 'https://preview.plugsure.asia'], ignored: ['*', 'https://x.test/path', 'ftp://a'] });
    assert.deepEqual(parseWebOrigins('http://localhost:8081,https://preview.plugsure.asia', 'production'),
      { origins: ['https://preview.plugsure.asia'], ignored: ['http://localhost:8081'] });
    assert.deepEqual(parseWebOrigins(undefined, 'development'), { origins: [], ignored: [] });
  });

  test('headers only for a listed origin on /d/v1/*; never for the operator API or /app', () => {
    const allowed = ['http://localhost:8081'];
    assert.equal(corsHeadersFor('/d/v1/stations', 'http://localhost:8081', [], false), null, 'off by default');
    assert.equal(corsHeadersFor('/d/v1/stations', 'http://evil.test', allowed, false), null);
    assert.equal(corsHeadersFor('/v1/auth/login', 'http://localhost:8081', allowed, true), null, 'operator API: never');
    assert.equal(corsHeadersFor('/app/', 'http://localhost:8081', allowed, false), null);
    assert.equal(corsHeadersFor('/d/v1/stations', undefined, allowed, false), null);
    const h = corsHeadersFor('/d/v1/map', 'http://localhost:8081', allowed, true)!;
    assert.equal(h['access-control-allow-origin'], 'http://localhost:8081');
    assert.equal(h.vary, 'Origin');
    assert.match(h['access-control-allow-headers']!, /authorization/);
    assert.match(h['access-control-allow-headers']!, /x-driver-brand/);
    assert.match(h['access-control-allow-headers']!, /idempotency-key/);
    assert.match(h['access-control-expose-headers']!, /ETag/);
    assert.equal(h['access-control-allow-credentials'], undefined, 'bearer tokens only: no credentials');
  });

  test('on a server: preflight 204 for a listed origin, nothing for others, the console untouched', async () => {
    const app = Fastify();
    registerDriverCors(app, 'http://localhost:8081');
    app.get('/d/v1/stations', async () => ({ stations: [] }));
    app.post('/v1/things', async () => ({ ok: true }));
    const pre = await app.inject({ method: 'OPTIONS', url: '/d/v1/charge/prepaid', headers: { origin: 'http://localhost:8081', 'access-control-request-method': 'POST' } });
    assert.equal(pre.statusCode, 204);
    assert.equal(pre.headers['access-control-allow-origin'], 'http://localhost:8081');
    assert.match(String(pre.headers['access-control-allow-methods']), /POST/);
    const get = await app.inject({ method: 'GET', url: '/d/v1/stations', headers: { origin: 'http://localhost:8081' } });
    assert.equal(get.statusCode, 200);
    assert.equal(get.headers['access-control-allow-origin'], 'http://localhost:8081');
    const other = await app.inject({ method: 'OPTIONS', url: '/d/v1/stations', headers: { origin: 'http://evil.test', 'access-control-request-method': 'GET' } });
    assert.notEqual(other.statusCode, 204);
    assert.equal(other.headers['access-control-allow-origin'], undefined);
    const consolePre = await app.inject({ method: 'OPTIONS', url: '/v1/things', headers: { origin: 'http://localhost:8081', 'access-control-request-method': 'POST' } });
    assert.notEqual(consolePre.statusCode, 204);
    assert.equal(consolePre.headers['access-control-allow-origin'], undefined);
    await app.close();
  });

  test('unset: no hook, no headers', async () => {
    const app = Fastify();
    registerDriverCors(app, '');
    app.get('/d/v1/stations', async () => ({ stations: [] }));
    const r = await app.inject({ method: 'GET', url: '/d/v1/stations', headers: { origin: 'http://localhost:8081' } });
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    await app.close();
  });
});
