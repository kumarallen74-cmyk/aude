import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hubOnlyAllowed } from './hub-only.js';

describe('hub-only organisations: what the API lets them call (review180)', () => {
  test('allowed: auth, the console shell, users, API keys, webhooks, the roaming header and the hub', () => {
    for (const [m, p] of [
      ['POST', '/v1/auth/logout'], ['GET', '/v1/auth/me'], ['POST', '/v1/auth/mfa/verify'], ['GET', '/v1/meta'], ['GET', '/v1/stream'],
      ['GET', '/v1/alerts'], ['GET', '/v1/users'], ['PUT', '/v1/users/:id'], ['GET', '/v1/roles'], ['POST', '/v1/api-keys'], ['DELETE', '/v1/api-keys/:id'],
      ['GET', '/v1/webhooks'], ['GET', '/v1/roaming'], ['GET', '/v1/roaming/hub'], ['GET', '/v1/roaming/hub/clearing/summary'],
      ['POST', '/v1/roaming/hub/clearing/payments/:id/confirm'], ['PUT', '/v1/roaming/hub/clearing/bank-details'],
    ] as const) assert.equal(hubOnlyAllowed(m, p), true, `${m} ${p}`);
  });
  test('refused: the CSMS (sites, chargers, tokens, tariffs, sandboxes, roaming partners and identity), the platform hub API', () => {
    for (const [m, p] of [
      ['GET', '/v1/sites'], ['POST', '/v1/sites'], ['GET', '/v1/charge-points'], ['GET', '/v1/tokens'], ['POST', '/v1/tariffs'], ['GET', '/v1/sandboxes'],
      ['GET', '/v1/roaming/partners'], ['PUT', '/v1/roaming/party'], ['PUT', '/v1/roaming'], ['GET', '/v1/roaming/hubx'], ['GET', '/v1/hub/overview'],
      ['GET', '/v1/dashboard'], ['POST', '/v1/roles'], ['GET', '/v1/metadata'], ['GET', '/v1/usersx'],
    ] as const) assert.equal(hubOnlyAllowed(m, p), false, `${m} ${p}`);
  });
});
