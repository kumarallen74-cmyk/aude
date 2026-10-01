// PlugSure v1.3 — the TypeScript SDK and per-key rate limits, end to end.
//
// Uses the BUILT SDK (sdk/typescript/dist, `npm run sdk`) against the running
// API, with a key the test issues and limits to 20 requests a minute:
// typed calls, errors, CSV, the RateLimit headers, a burst refused with 429,
// the SDK waiting and retrying, the limit changed and reset from the console,
// usage by hour, keys that do not authenticate, and a real webhook delivery
// verified with the SDK's helper.
//
// Same prerequisites as console-e2e.mts (API on 9200, the seeded operator).
//     npx tsx tools/e2e/sdk-e2e.mts
// NEVER point this at production.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { PlugSure, PlugSureError, parseWebhook, verifyWebhookSignature, API_VERSION } from '../../sdk/typescript/dist/index.js';

const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const HOOK_PORT = Number(process.env.E2E_SDK_HOOK_PORT ?? 9314);
const results: Array<{ ok: boolean; name: string }> = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push({ ok, name });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -- ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}`}`);
};

let cookie = '';
async function ops(method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch {}
  return { status: r.status, data: d, headers: r.headers };
}

// A webhook receiver that keeps the raw body, as a real one must.
const hooks: Array<{ body: string; signature: string }> = [];
const receiver = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { hooks.push({ body: Buffer.concat(chunks).toString('utf8'), signature: String(req.headers['plugsure-signature'] ?? '') }); res.writeHead(204).end(); });
});
await new Promise<void>((r) => receiver.listen(HOOK_PORT, '127.0.0.1', () => r()));

let keyId = '';
let webhookId = '';
try {
  const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: process.env.E2E_PASSWORD ?? 'Console-Test-2026!' });
  check('setup: operator signs in', login.status === 200, login.data);
  for (const k of (await ops('GET', '/v1/api-keys')).data ?? []) {
    if (String(k.name).startsWith('E2E SDK') && !k.revoked_at) await ops('DELETE', `/v1/api-keys/${k.id}`);
  }
  const badLimit = await ops('POST', '/v1/api-keys', { name: 'E2E SDK bad', permissions: ['charge_point:read'], rateLimitPerMin: 0 });
  check('keys: a rate limit below 1 is refused', badLimit.status === 400 && /rateLimitPerMin/.test(badLimit.data.error), badLimit.data);
  const issued = await ops('POST', '/v1/api-keys', { name: 'E2E SDK', permissions: ['charge_point:read', 'session:read', 'session:export', 'webhook:read', 'webhook:write'], rateLimitPerMin: 20 });
  keyId = issued.data.id;
  check('keys: a key is issued with its own limit (20 a minute)', issued.status === 200 && /^psk_/.test(issued.data.key), issued.data);

  const ps = new PlugSure({ apiKey: issued.data.key, baseUrl: API, maxRetries: 0 });

  // ─────────────────────────────────────────── typed calls
  const cps = await ps.listChargePoints();
  check('sdk: listChargePoints returns the chargers, and the SDK reports the key\'s allowance (20, 19 left)',
    Array.isArray(cps) && cps.length > 0 && ps.rateLimit?.limit === 20 && ps.rateLimit.remaining === 19, { n: cps.length, rl: ps.rateLimit });
  const cp = await ps.getChargePoint({ identity: cps[0]!.ocpp_identity });
  check('sdk: getChargePoint by identity (path parameter)', cp.ocpp_identity === cps[0]!.ocpp_identity && Array.isArray(cp.connectors), { id: cp.ocpp_identity });
  const sessions = await ps.listChargingSessions({ query: { limit: 3 } });
  check('sdk: listChargingSessions with a query parameter', Array.isArray(sessions) && sessions.length <= 3, sessions.length);
  const csv = await ps.exportSessionsAsCsv({ query: { from: new Date(Date.now() - 30 * 86_400_000).toISOString() } });
  check('sdk: a CSV export comes back as text', typeof csv === 'string' && /^[^\n]*,/.test(csv), String(csv).slice(0, 80));
  let notFound: unknown;
  try { await ps.getChargePoint({ identity: 'NO-SUCH-CHARGER-SDK' }); } catch (e) { notFound = e; }
  check('sdk: a 404 is a PlugSureError with its status and message', notFound instanceof PlugSureError && notFound.status === 404 && /not found/i.test(notFound.message), String(notFound));
  let forbidden: unknown;
  try { await ps.listApiKeys(); } catch (e) { forbidden = e; }
  check('sdk: a call the key has no permission for is a 403', forbidden instanceof PlugSureError && forbidden.status === 403, String(forbidden));

  // ─────────────────────────────────────────── the key's rate limit
  const raw = await fetch(`${API}/v1/charge-points`, { headers: { authorization: `Bearer ${issued.data.key}` } });
  check('limit: every answer carries RateLimit-Limit, -Remaining, -Reset and -Policy',
    raw.headers.get('ratelimit-limit') === '20' && Number(raw.headers.get('ratelimit-remaining')) < 20 && Number(raw.headers.get('ratelimit-reset')) > 0 && raw.headers.get('ratelimit-policy') === '20;w=60',
    Object.fromEntries(raw.headers));
  const burst = await Promise.allSettled(Array.from({ length: 25 }, () => ps.listChargePoints()));
  const refused = burst.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason as PlugSureError);
  check('limit: a burst beyond the allowance is refused with 429, code rate_limited and Retry-After',
    refused.length >= 10 && refused.every((e) => e.status === 429 && e.code === 'rate_limited' && (e.retryAfterS ?? 0) >= 1) && burst.some((r) => r.status === 'fulfilled'),
    { ok: burst.length - refused.length, refused: refused.length, sample: refused[0] && { s: refused[0].status, c: refused[0].code, r: refused[0].retryAfterS } });
  const t0 = Date.now();
  const patient = new PlugSure({ apiKey: issued.data.key, baseUrl: API, maxRetries: 3 });
  const after = await patient.listChargePoints();
  const waited = Date.now() - t0;
  check('limit: the SDK waits as the API asks (20 a minute = one every 3 s) and the request goes through', Array.isArray(after) && waited >= 1500 && waited < 15_000, { waited });
  const other = await ops('GET', '/v1/charge-points');
  check('limit: the key\'s limit does not touch the console session', other.status === 200);

  // ─────────────────────────────────────────── changed from the console
  const listed = (await ops('GET', '/v1/api-keys')).data.find((k: any) => k.id === keyId);
  check('console: the key shows its limit and last-24-hour usage (requests and refusals)',
    listed?.rate_limit_per_min === 20 && listed.effective_rate_limit_per_min === 20 && listed.requests_24h >= 30 && listed.limited_24h >= 10 && listed.errors_24h >= 2, listed);
  const usage = await ops('GET', `/v1/api-keys/${keyId}/usage?hours=2`);
  check('console: usage by hour', usage.status === 200 && usage.data.length >= 1 && usage.data.at(-1).requests >= 30 && usage.data.at(-1).limited >= 10, usage.data);
  const raised = await ops('PATCH', `/v1/api-keys/${keyId}`, { rateLimitPerMin: 1200 });
  await ps.listChargePoints().catch(() => null);
  const afterRaise = await fetch(`${API}/v1/charge-points`, { headers: { authorization: `Bearer ${issued.data.key}` } });
  check('console: a raised limit applies from the key\'s next request', raised.status === 200 && raised.data.rate_limit_per_min === 1200 && afterRaise.status === 200 && afterRaise.headers.get('ratelimit-limit') === '1200', { p: raised.data, h: afterRaise.headers.get('ratelimit-limit') });
  const reset = await ops('PATCH', `/v1/api-keys/${keyId}`, { rateLimitPerMin: null });
  check('console: null returns the key to the installation default', reset.status === 200 && reset.data.rate_limit_per_min === null && reset.data.effective_rate_limit_per_min >= 1, reset.data);
  const badPatch = await ops('PATCH', `/v1/api-keys/${keyId}`, { rateLimitPerMin: 1.5 });
  check('console: a fractional limit is refused', badPatch.status === 400, badPatch.data);
  const audit = await ops('GET', '/v1/audit');
  check('console: limit changes are audited', JSON.stringify(audit.data).includes('api_key.updated'));

  // ─────────────────────────────────────────── keys that do not authenticate
  const bogus = `psk_0123456789ab_${'x'.repeat(43)}`;
  const statuses: number[] = [];
  for (let i = 0; i < 35; i++) statuses.push((await fetch(`${API}/v1/charge-points`, { headers: { authorization: `Bearer ${bogus}` } })).status);
  const first429 = statuses.indexOf(429);
  check('guessing: keys that do not authenticate get 401, then 429 once the address has sent too many',
    statuses[0] === 401 && first429 > 5 && statuses.slice(first429).every((s) => s === 429), statuses.join(','));
  const stillOk = await ps.listChargePoints().then(() => true, (e) => e);
  check('guessing: a valid key from the same address keeps working', stillOk === true, String(stillOk));

  // ─────────────────────────────────────────── webhooks, verified with the SDK
  const wh = await ps.createWebhookEndpoint({ body: { url: `http://127.0.0.1:${HOOK_PORT}/hook`, description: 'E2E SDK', events: ['*'] } });
  webhookId = wh.endpoint.id;
  const secret = wh.secret;
  await ps.sendTestPingToWebhook({ id: webhookId });
  const got = hooks.at(-1);
  const valid = got ? await verifyWebhookSignature({ secret, signature: got.signature, body: got.body }) : false;
  const tampered = got ? await verifyWebhookSignature({ secret, signature: got.signature, body: got.body.replace(/"/, '" ') }) : true;
  const event = got ? await parseWebhook({ secret, signature: got.signature, body: got.body }).catch(() => null) : null;
  check('webhooks: a real delivery verifies with the SDK; a changed body does not', valid && !tampered && !!event?.id, { valid, tampered, got: got?.body?.slice(0, 120) });
  // The SDK is generated from the published document, whose version is the package version.
  const pkgVersion = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  check('sdk: carries the API version it was generated from', API_VERSION === pkgVersion, { API_VERSION, pkgVersion });
} catch (e) {
  check('no unexpected exception', false, (e as Error).stack);
} finally {
  if (webhookId) await ops('DELETE', `/v1/webhooks/${webhookId}`).catch(() => null);
  if (keyId) await ops('DELETE', `/v1/api-keys/${keyId}`).catch(() => null);
  receiver.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
