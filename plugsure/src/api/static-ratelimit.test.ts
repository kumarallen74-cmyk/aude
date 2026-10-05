import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

/**
 * The per-IP API rate limit counted the console's own files: one console page load is ~60 requests
 * (index.html, ~45 ES modules, CSS, fonts), so ten page loads a minute from one office NAT answered
 * 429 to the console's JavaScript and left a blank page. Static files are exempt; the API, the
 * sign-in route and an encoded path posing as a file stay limited exactly as before.
 */
describe('API rate limit and static files', () => {
  test('static assets never use up the API allowance; API calls are still limited', async (t) => {
    let app: Awaited<ReturnType<typeof import('./server.js')['buildApi']>>;
    try {
      app = await (await import('./server.js')).buildApi();
      await app.ready();
    } catch (e) {
      t.skip(`API could not be built here (${(e as Error).message})`);
      return;
    }
    const was = config.api.rateLimitPerMin;
    (config.api as any).rateLimitPerMin = 5;
    try {
      const ip = '203.0.113.7';
      for (const url of ['/', '/index.html', '/js/app.js', '/js/core.js', '/js/views/tariffs.js', '/assets/app.css', '/app/', '/app/sw.js', '/app/manifest.webmanifest']) {
        for (let i = 0; i < 3; i++) {
          const r = await app.inject({ method: 'GET', url, remoteAddress: ip });
          assert.equal(r.statusCode, 200, `${url} answered ${r.statusCode}`);
        }
      }
      // 27 static requests later the API allowance is untouched: 5 calls pass the limiter, the 6th is 429.
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await app.inject({ method: 'GET', url: '/v1/auth/me', remoteAddress: ip })).statusCode);
      assert.deepEqual(codes.slice(0, 5).filter((c) => c === 429), [], `API calls within the limit: ${codes}`);
      assert.equal(codes[5], 429, `the 6th API call is limited: ${codes}`);
      // an encoded API path and sign-in are never exempt
      const ip2 = '203.0.113.8';
      const enc: number[] = [];
      for (let i = 0; i < 6; i++) enc.push((await app.inject({ method: 'GET', url: '/%761/sessions', remoteAddress: ip2 })).statusCode);
      assert.equal(enc[5], 429, `encoded API path limited: ${enc}`);
      const ip3 = '203.0.113.9';
      const login: number[] = [];
      for (let i = 0; i < 6; i++) login.push((await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'x@example.com', password: 'nope' }, remoteAddress: ip3 })).statusCode);
      assert.equal(login[5], 429, `sign-in limited: ${login}`);
    } finally {
      (config.api as any).rateLimitPerMin = was;
      await app.close();
      await pool.end();
    }
  });
});
