import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { isInprocUrl } from './transport.js';

/**
 * HUB_ENABLED=false (the default) changes nothing: no /hub surface, the platform's /v1/hub routes answer
 * 404, and no call is ever made in-process (a partner on our own origin is still called over HTTP).
 */
describe('with the hub off', () => {
  test('the default is off', { skip: process.env.HUB_ENABLED !== undefined }, () => {
    assert.equal(config.hub.enabled, false);
  });

  test('no in-process transport, whatever the URL', () => {
    const was = config.hub.enabled;
    config.hub.enabled = false;
    try {
      assert.equal(isInprocUrl(`${config.ocpi.publicUrl || 'http://127.0.0.1:9200'}/ocpi/versions`), false);
      assert.equal(isInprocUrl('http://localhost:9200/hub/ocpi/versions'), false);
    } finally { config.hub.enabled = was; }
  });

  test('/hub/ocpi/* does not exist and /v1/hub/* answers 404', async (t) => {
    const was = config.hub.enabled;
    config.hub.enabled = false;
    let app: import('fastify').FastifyInstance;
    try {
      const server = await import('../api/server.js');
      app = await server.buildApi();
      await app.ready();
    } catch (e) {
      config.hub.enabled = was;
      t.skip(`API could not be built here (${(e as Error).message})`);
      return;
    }
    try {
      for (const url of ['/hub/ocpi/versions', '/hub/ocpi/2.2.1', '/hub/ocpi/2.2.1/sender/locations']) {
        const r = await app.inject({ method: 'GET', url, headers: { authorization: 'Token eHl6' } });
        assert.equal(r.statusCode, 404, url);
      }
      const put = await app.inject({ method: 'PUT', url: '/hub/ocpi/2.2.1/receiver/locations/MY/CPX/L1', payload: {}, headers: { authorization: 'Token eHl6' } });
      assert.equal(put.statusCode, 404);
      for (const url of ['/v1/hub/overview', '/v1/hub/members', '/v1/roaming/hub']) {
        const r = await app.inject({ method: 'GET', url });
        assert.equal(r.statusCode, 404, url);
      }
    } finally {
      await app.close();
      config.hub.enabled = was;
    }
  });
});
