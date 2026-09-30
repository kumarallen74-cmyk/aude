import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTsSdk, tsType } from './sdk-ts.js';
import { SPEC_FILE } from './generate.js';
import { sign } from '../../services/webhooks.js';
import { PlugSure, PlugSureError, verifyWebhookSignature, parseWebhook, WebhookSignatureError } from '../../../sdk/typescript/src/index.js';

/**
 * The TypeScript SDK: generated from the published document, so it cannot
 * drift from the API; and its runtime (URLs, errors, rate-limit retries,
 * webhook signatures) checked against a fake fetch and the server's own signer.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');

describe('TypeScript SDK', () => {
  test('the committed generated.ts is what the published document generates (run npm run sdk)', () => {
    const spec = JSON.parse(readFileSync(join(ROOT, SPEC_FILE), 'utf8'));
    const { text, operations } = buildTsSdk(spec);
    assert.equal(readFileSync(join(ROOT, 'sdk', 'typescript', 'src', 'generated.ts'), 'utf8'), text);
    const count = Object.values(spec.paths as Record<string, object>).reduce((n: number, p) => n + Object.keys(p).length, 0);
    assert.equal(operations.length, count, 'one method per operation');
    assert.equal(new Set(operations.map((o) => o.id)).size, count, 'method names are unique');
    assert.ok(operations.every((o) => /^[a-z][A-Za-z0-9]*$/.test(o.id)), 'method names are camelCase identifiers');
  });

  test('schemas become TypeScript types', () => {
    assert.equal(tsType({ type: ['string', 'null'] }), 'string | null');
    assert.equal(tsType({ type: 'array', items: { anyOf: [{ type: 'integer' }, { type: 'null' }] } }), '(number | null)[]');
    assert.equal(tsType({ enum: ['a', 'b'] }), '"a" | "b"');
    assert.equal(tsType({ const: 'x' }), '"x"');
    assert.equal(tsType({ $ref: '#/components/schemas/CpDetail' }), 'CpDetail');
    assert.equal(tsType({ type: 'object', additionalProperties: { type: 'number' } }), 'Record<string, number>');
    assert.equal(tsType({ type: 'object', required: ['id'], properties: { id: { type: 'string' }, 'odd-key': { type: 'boolean' } } }),
      '{\n  id: string;\n  "odd-key"?: boolean;\n}');
    assert.equal(tsType({}), 'unknown');
  });

  /** A fake fetch that answers from a script and records what it was sent. */
  function fake(answers: Array<{ status: number; body?: unknown; headers?: Record<string, string>; text?: string }>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const a = answers.shift() ?? { status: 500 };
      const text = a.text ?? (a.body === undefined ? '' : JSON.stringify(a.body));
      return new Response(text || null, { status: a.status, headers: { 'content-type': 'application/json', ...a.headers } });
    }) as unknown as typeof fetch;
    return { f, calls };
  }

  test('requests: bearer key, encoded path parameters, query arrays and JSON bodies', async () => {
    const { f, calls } = fake([{ status: 200, body: { ocpp_identity: 'A/B 1' }, headers: { 'ratelimit-limit': '120', 'ratelimit-remaining': '119', 'ratelimit-reset': '1' } }, { status: 200, body: [] }, { status: 200, body: { ok: true } }]);
    const ps = new PlugSure({ apiKey: 'psk_0123456789ab_secret', baseUrl: 'https://api.example.id/', fetch: f });
    const cp = await ps.getChargePoint({ identity: 'A/B 1' });
    assert.equal(cp.ocpp_identity, 'A/B 1');
    assert.equal(calls[0]!.url, 'https://api.example.id/v1/charge-points/A%2FB%201');
    assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer psk_0123456789ab_secret');
    assert.deepEqual(ps.rateLimit, { limit: 120, remaining: 119, resetS: 1 });
    await ps.listChargingSessions({ query: { limit: 5, siteId: undefined, from: '2026-09-01T00:00:00Z' } });
    assert.equal(calls[1]!.url, 'https://api.example.id/v1/sessions?limit=5&from=2026-09-01T00%3A00%3A00Z');
    await ps.startSessionRemotely({ identity: 'CP1', body: { idTag: 'FLEET-1', connectorId: 1 } });
    assert.equal(calls[2]!.init.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[2]!.init.body)), { idTag: 'FLEET-1', connectorId: 1 });
  });

  test('errors: status, code and body; a 429 is retried after Retry-After, then given up', async () => {
    const { f, calls } = fake([
      { status: 404, body: { error: 'charge point not found' } },
      { status: 429, body: { error: 'rate limit exceeded', code: 'rate_limited' }, headers: { 'retry-after': '1' } },
      { status: 200, body: [] },
      { status: 429, body: { error: 'rate limit exceeded', code: 'rate_limited' }, headers: { 'retry-after': '1' } },
    ]);
    const ps = new PlugSure({ apiKey: 'psk_x', baseUrl: 'https://api.example.id', fetch: f, maxRetries: 1 });
    await assert.rejects(ps.getChargePoint({ identity: 'NOPE' }), (e: any) => e instanceof PlugSureError && e.status === 404 && /not found/.test(e.message));
    const t0 = Date.now();
    assert.deepEqual(await ps.listChargePoints(), []);
    assert.ok(Date.now() - t0 >= 900, 'waited for Retry-After');
    await assert.rejects(ps.listChargePoints({ maxRetries: 0 }), (e: any) => e.status === 429 && e.code === 'rate_limited' && e.retryAfterS === 1);
    assert.equal(calls.length, 4);
  });

  test('a wait longer than maxRetryWaitS is thrown, not slept', async () => {
    const { f, calls } = fake([{ status: 429, body: { error: 'x', code: 'rate_limited' }, headers: { 'retry-after': '120' } }]);
    const ps = new PlugSure({ apiKey: 'psk_x', baseUrl: 'https://api.example.id', fetch: f, maxRetryWaitS: 5 });
    await assert.rejects(ps.listChargePoints(), (e: any) => e.status === 429 && e.retryAfterS === 120);
    assert.equal(calls.length, 1);
  });

  test('webhooks: a signature made by the server verifies; tampering, old or missing ones do not', async () => {
    const secret = 'whsec_test_secret';
    const body = JSON.stringify({ id: 'evt_1', type: 'session.ended', created_at: '2026-09-28T10:00:00Z', api_version: '2026-09', data: { orgId: 'o', sessionId: 's', energyWh: 1000, durationS: 60 } });
    const now = Math.floor(Date.now() / 1000);
    const signature = sign(secret, body, now);
    assert.equal(await verifyWebhookSignature({ secret, signature, body }), true);
    assert.equal(await verifyWebhookSignature({ secret, signature, body: new TextEncoder().encode(body) }), true);
    assert.equal(await verifyWebhookSignature({ secret, signature, body: body.replace('1000', '9000') }), false);
    assert.equal(await verifyWebhookSignature({ secret: 'other', signature, body }), false);
    assert.equal(await verifyWebhookSignature({ secret, signature: sign(secret, body, now - 600), body }), false, 'older than 5 minutes');
    assert.equal(await verifyWebhookSignature({ secret, signature: undefined, body }), false);
    const event = await parseWebhook({ secret, signature, body });
    assert.equal(event.type, 'session.ended');
    await assert.rejects(parseWebhook({ secret, signature: 't=1,v1=00', body }), WebhookSignatureError);
  });
});
