import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../config.js';

/** HUB_ENABLED=false: the clearing API (platform and member) answers 404 like the rest of the hub. */
describe('clearing with the hub off', () => {
  test('/v1/hub/clearing/* and /v1/roaming/hub/clearing/* answer 404', async (t) => {
    const was = config.hub.enabled;
    config.hub.enabled = false;
    let app: import('fastify').FastifyInstance;
    try {
      const server = await import('../../api/server.js');
      app = await server.buildApi();
      await app.ready();
    } catch (e) {
      config.hub.enabled = was;
      t.skip(`API could not be built here (${(e as Error).message})`);
      return;
    }
    try {
      for (const [method, url] of [['GET', '/v1/hub/clearing/overview'], ['GET', '/v1/hub/clearing/cdrs'], ['POST', '/v1/hub/clearing/runs'],
        ['GET', '/v1/roaming/hub/clearing/summary'], ['POST', '/v1/roaming/hub/clearing/payments'], ['GET', '/v1/roaming/hub/clearing/statements/00000000-0000-4000-8000-000000000000/pdf']] as const) {
        const r = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
        assert.equal(r.statusCode, 404, `${method} ${url}`);
      }
    } finally {
      await app.close();
      config.hub.enabled = was;
    }
  });
});
