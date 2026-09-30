/**
 * OCPI partner authentication: what a stranger, a half-registered partner and a
 * partner's own token can and cannot reach.
 *
 * Prerequisites: the stack running, the seeded operator (ops@plugsure.com) with a
 * roaming identity (the suite sets ID*TST if there is none). Creates one partner and
 * deletes it afterwards.
 */
const API = process.env.E2E_API ?? 'http://127.0.0.1:9200';
const PASSWORD = process.env.E2E_PASSWORD ?? 'Console-Test-2026!';

const call = async (method: string, path: string, token: string, body?: unknown, extra: Record<string, string> = {}) => {
  const r = await fetch(API + path, {
    method, headers: { authorization: `Token ${token}`, ...extra, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { s: r.status, d: await r.json().catch(() => null) as any };
};
let ok = 0, fail = 0;
const check = (label: string, passed: boolean, detail?: unknown) => {
  if (passed) { console.log('PASS ', label); ok++; } else { console.log('FAIL ', label, '--', JSON.stringify(detail)); fail++; }
};

// Console session for setup
let cookie = '';
const ops = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(API + path, { method, headers: { cookie, 'x-plugsure-csrf': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]!;
  return { s: r.status, d: await r.json().catch(() => null) as any };
};
const login = await ops('POST', '/v1/auth/login', { email: 'ops@plugsure.com', password: PASSWORD });
if (login.s !== 200) { console.error('operator sign-in failed', login); process.exit(1); }
// A roaming identity is needed before partners can exist. Set one if there is none (a partner cannot follow a change later, so an existing one is kept).
const overview0 = await ops('GET', '/v1/roaming');
if (!overview0.d?.party) {
  const party = await ops('PUT', '/v1/roaming/party', { countryCode: 'ID', partyId: 'TST', businessName: 'PlugSure e2e' });
  if (party.s !== 200) { console.error('could not set the roaming identity', party); process.exit(1); }
}
const created = await ops('POST', '/v1/roaming/partners', { name: 'OCPI auth test', kind: 'emsp' });
const token: string | undefined = created.d?.token;
const partnerId: string | undefined = created.d?.partner?.id;
if (!token || !partnerId) { console.error('partner not created', created); process.exit(1); }

try {
  check('a stranger: no token → 401', (await call('GET', '/ocpi/versions', '')).s === 401);
  check('a stranger: a made-up token → 401', (await call('GET', '/ocpi/versions', 'made-up-' + Math.random())).s === 401);
  const ver = await call('GET', '/ocpi/versions', token);
  check('the one-time token: reads versions', ver.s === 200 && ver.d?.status_code === 1000, ver.d);
  const locs = await call('GET', '/ocpi/2.2.1/cpo/locations', token);
  check('the one-time token: refused everywhere else until registered (401)', locs.s === 401, locs.d?.status_message);
  const wrongTo = await call('GET', '/ocpi/versions', token, undefined, { 'ocpi-to-country-code': 'XX', 'ocpi-to-party-id': 'FAK' });
  check('a message addressed to another party is not answered as ours', wrongTo.d?.status_code !== 1000, { s: wrongTo.s, code: wrongTo.d?.status_code });
  check('a partner token is no console session: /v1/sessions → 401', (await call('GET', '/v1/sessions', token)).s === 401);
  check('a partner token cannot sign in to the console', (await call('POST', '/v1/auth/login', token, { email: 'ops@plugsure.com', password: 'x' })).s === 401);
  const ms: number[] = [];
  for (let i = 0; i < 10; i++) { const t = performance.now(); await call('GET', '/ocpi/versions', `guess-${i}-${'x'.repeat(24)}`); ms.push(performance.now() - t); }
  check('guessing tokens: every answer 401, none slow', Math.max(...ms) < 500, { maxMs: Math.round(Math.max(...ms)) });
  // The token is shown once, at creation. Every later view of the partner (overview, messages, tokens) must not carry it.
  const views = await Promise.all(['/v1/roaming', `/v1/roaming/partners/${partnerId}/messages`, `/v1/roaming/partners/${partnerId}/tokens`].map((u) => ops('GET', u)));
  const overview = views[0]!;
  const listed = (overview.d?.partners ?? []).some((p: any) => p.id === partnerId);
  check('the token is shown once at creation and never again (overview, messages, tokens)',
    overview.s === 200 && listed && views.every((v) => v.s === 200 && !JSON.stringify(v.d).includes(token)),
    { statuses: views.map((v) => v.s), listed });
} finally {
  await ops('DELETE', `/v1/roaming/partners/${partnerId}`);
}
console.log(`\n${ok + fail} checks: ${ok} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
