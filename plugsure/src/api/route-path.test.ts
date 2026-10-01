import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { routePath } from './route-path.js';

/**
 * The router percent-decodes the path before matching, so a hook that tests
 * `req.url` can be walked around. A guard built on routePath cannot.
 */
test('a percent-encoded or absolute-form target cannot skip a guard keyed on routePath', async () => {
  const app = Fastify();
  app.addHook('preHandler', async (req, reply) => {
    if (routePath(req).startsWith('/v1/')) return reply.status(401).send({ error: 'auth' });
  });
  app.get('/v1/sessions', async () => ({ secret: true }));
  await app.ready();
  for (const url of ['/v1/sessions', '/%761/sessions', '/%76%31/sessions', '/v1/%73essions']) {
    const r = await app.inject({ method: 'GET', url });
    assert.notEqual(r.statusCode, 200, `${url} reached the handler without the guard`);
  }
  // What the old check saw: the raw target does not start with /v1/, yet the route matched.
  const raw = await app.inject({ method: 'GET', url: '/%761/sessions' });
  assert.equal(raw.statusCode, 401);
  await app.close();
});

test('an unmatched request has no route path', async () => {
  const app = Fastify();
  let seen: string | null = null;
  app.addHook('onRequest', async (req) => { seen = routePath(req); });
  await app.ready();
  await app.inject({ method: 'GET', url: '/nowhere' });
  assert.equal(seen, '');
  await app.close();
});

test('underPrefix: an unmatched path under a guarded prefix still meets the guard (401, not 404)', async () => {
  const { underPrefix } = await import('./route-path.js');
  const app = Fastify();
  app.addHook('preHandler', async (req, reply) => {
    if (underPrefix(req, '/ocpi/')) return reply.status(401).send({ error: 'auth' });
  });
  app.get('/ocpi/versions', async () => ({ ok: true }));
  await app.ready();
  for (const url of ['/ocpi/versions', '/%6fcpi/versions', '/ocpi/2.2.1/no-such-module']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401, url);
  }
  assert.equal((await app.inject({ method: 'GET', url: '/elsewhere' })).statusCode, 404);
  await app.close();
});
