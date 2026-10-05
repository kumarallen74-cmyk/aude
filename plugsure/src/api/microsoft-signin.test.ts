import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { hashPassword, ensureSystemRoles, setUserRole } from '../services/users.js';
import { beginEnrolment, confirmEnrolment } from '../services/mfa.js';
import { base32Decode, hotp, timeStep } from '../services/totp.js';
import {
  MS_PERSONAL_TENANT, MicrosoftSignInError, msTxCookie, microsoftConfigProblem, resetMicrosoftCaches, sha256Hex, validateIdToken,
} from '../services/microsoft-signin.js';
import { MockEntra, newKey, ENTRA_ROLES, type MockIdentity } from '../../tools/testing/mock-entra.js';
import { buildApi } from './server.js';
import { issueApiKey } from '../services/auth.js';
import { runRetention } from '../services/retention.js';
import { resetOpsAlertOrgCache } from '../services/worker-health.js';
import { bindingsFromCookie } from './microsoft-routes.js';

/**
 * "Sign in with Microsoft" end to end against a MOCK Entra ID (tools/testing/mock-entra.ts:
 * a real RSA key, discovery, JWKS, authorize and token endpoints on a local port), through the
 * real Fastify app (inject) and database:
 *   · the flow: PKCE, state, nonce, browser binding, single use, expiry;
 *   · the ID token checks, one by one (wrong aud / iss / signature / kid / nonce, expired …);
 *   · user matching: by e-mail then by oid, never creating a user, only inside the organisation
 *     the tenant is connected to (cross-tenant isolation), disabled / locked / oid conflicts;
 *   · two-step verification: Microsoft MFA (amr) counts, otherwise the TOTP step or enrolment;
 *   · connecting / disconnecting a tenant: permission, one organisation per tenant, audit;
 *   · the feature is off (404) without MS_CLIENT_ID.
 *
 *   DATABASE_URL=postgresql://…/plugsure_audit_fix NODE_ENV=test npx tsx --test src/api/microsoft-signin.test.ts
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[microsoft-signin.test] SKIPPING database-backed suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const HOST = 'console.test';
const PW = 'Correct-Horse-2026!';
const SLUGS = { a: 'ms-signin-test-a', b: 'ms-signin-test-b', c: 'ms-signin-test-c' } as const;
const TENANT = { a: randomUUID(), b: randomUUID(), c: randomUUID(), unlinked: randomUUID() };
const org: Record<keyof typeof SLUGS, string> = { a: '', b: '', c: '' };
const ids: Record<string, string> = {};
const mock = new MockEntra();
let app: FastifyInstance;

// ------------------------------------------------------------------ helpers

function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string | null {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  for (const c of list) {
    const first = String(c).split(';')[0]!;
    if (first.startsWith(`${name}=`)) return first;
  }
  return null;
}
const rawSetCookie = (res: { headers: Record<string, unknown> }, name: string) => {
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw : [String(raw ?? '')]).find((c) => String(c).startsWith(`${name}=`)) ?? '';
};

async function mkUser(key: string, orgKey: keyof typeof SLUGS, role: string, email = `${key}@${orgKey}.ms-signin.test`) {
  const r = await one<{ id: string }>(
    `INSERT INTO app_user (org_id, email, name, status, password_hash) VALUES ($1, $2, $3, 'active', $4) RETURNING id`,
    [org[orgKey], email, key, await hashPassword(PW)],
  );
  ids[key] = r!.id;
  await setUserRole(r!.id, org[orgKey], role);
}

async function cleanup() {
  const orgs = (await query<{ id: string }>(`SELECT id FROM organisation WHERE slug = ANY($1)`, [Object.values(SLUGS)])).rows.map((r) => r.id);
  if (!orgs.length) return;
  await query(`DELETE FROM org_identity_provider WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM api_key WHERE org_id = ANY($1::uuid[])`, [orgs]).catch(() => {});
  await query(`DELETE FROM alert WHERE org_id = ANY($1::uuid[]) AND kind = 'platform.microsoft_tenant_linked'`, [orgs]).catch(() => {});
  await query(`DELETE FROM oidc_login_tx WHERE org_id = ANY($1::uuid[])`, [orgs]);
  await query(`DELETE FROM user_role WHERE user_id IN (SELECT id FROM app_user WHERE org_id = ANY($1::uuid[]))`, [orgs]);
  await query(`DELETE FROM app_user WHERE org_id = ANY($1::uuid[])`, [orgs]);
}

/** One Microsoft account per (tenant, address), like a real directory: the same oid every time. */
const oids = new Map<string, string>();
const ident = (tid: string, upn: string | null, extra: Partial<MockIdentity> = {}, oid?: string): MockIdentity => {
  const key = `${tid}|${(upn ?? extra.email ?? '').toLowerCase()}`;
  if (!oid) {
    if (!oids.has(key)) oids.set(key, randomUUID());
    oid = oids.get(key)!;
  }
  return { tid, oid, ...(upn ? { preferred_username: upn } : {}), name: 'Someone', ...extra };
};

/** The browser: start → (Microsoft) → callback. Returns the callback's answer and cookies. */
async function signIn(
  id: MockIdentity | null,
  opts: { host?: string; tamper?: MockEntra['tamper']; error?: MockEntra['nextError']; startUrl?: string; startCookie?: string; dropBinding?: boolean; ip?: string } = {},
) {
  const host = opts.host ?? HOST;
  mock.nextIdentity = id;
  mock.tamper = opts.tamper ?? null;
  mock.nextError = opts.error ?? null;
  const remoteAddress = opts.ip ?? '127.0.0.1';
  const start = await app.inject({ method: opts.startUrl ? 'POST' : 'GET', url: opts.startUrl ?? '/v1/auth/microsoft/start', headers: { host, ...(opts.startCookie ? { cookie: opts.startCookie, 'x-plugsure-csrf': '1' } : {}) }, remoteAddress });
  const authorizeUrl = opts.startUrl ? start.json().url : String(start.headers.location ?? '');
  const binding = cookieFrom(start, 'ps_ms_tx');
  const atMs = await fetch(authorizeUrl, { redirect: 'manual' });
  const back = new URL(atMs.headers.get('location') ?? '');
  const callbackPath = back.pathname + back.search;
  const callback = await app.inject({ method: 'GET', url: callbackPath, headers: { host, ...(binding && !opts.dropBinding ? { cookie: binding } : {}) }, remoteAddress });
  mock.tamper = null;
  return {
    start, binding, authorizeUrl, callbackPath, callback,
    location: String(callback.headers.location ?? ''),
    session: cookieFrom(callback, 'ps_session'),
  };
}

const as = (session: string | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { host: HOST, cookie: session ?? '', ...(method === 'GET' ? {} : { 'x-plugsure-csrf': '1' }) }, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function passwordSession(email: string) {
  const r = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { host: HOST }, payload: { email, password: PW } });
  assert.equal(r.statusCode, 200, r.body);
  return cookieFrom(r, 'ps_session');
}

const lastAudit = async (action: string) =>
  one<{ org_id: string | null; actor_id: string | null; target_id: string | null; after_state: any }>(
    `SELECT org_id, actor_id, target_id, after_state FROM audit_log WHERE action = $1 ORDER BY ts DESC, seq DESC LIMIT 1`, [action]);

const binding = (userId: string) => one<{ ms_tenant_id: string | null; ms_object_id: string | null }>(`SELECT ms_tenant_id, ms_object_id FROM app_user WHERE id = $1`, [userId]);

// ------------------------------------------------------------------ setup

if (DB_OK) {
  before(async () => {
    await mock.start();
    process.env.MS_CLIENT_ID = mock.clientId;
    process.env.MS_CLIENT_SECRET = mock.clientSecret;
    process.env.MS_AUTHORITY_BASE = mock.base;
    process.env.MS_SIGNIN_RATE_PER_MIN = '100000';
    process.env.CONSOLE_MFA_REQUIRED = 'true';
    await cleanup();
    await ensureSystemRoles();
    for (const k of Object.keys(SLUGS) as Array<keyof typeof SLUGS>) {
      org[k] = (await one<{ id: string }>(
        `INSERT INTO organisation (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, archived_at = NULL RETURNING id`,
        [`MS sign-in ${k}`, SLUGS[k]],
      ))!.id;
    }
    await query(`INSERT INTO org_identity_provider (org_id, provider, tenant_id) VALUES ($1, 'microsoft', $2), ($3, 'microsoft', $4)`, [org.a, TENANT.a, org.b, TENANT.b]);
    await mkUser('ops', 'a', 'cpo_operations_manager');
    await mkUser('ops2', 'a', 'cpo_operations_manager');
    await mkUser('boss', 'a', 'super_admin');
    await mkUser('totpboss', 'a', 'super_admin');
    await mkUser('disabled', 'a', 'cpo_operations_manager');
    await mkUser('locked', 'a', 'cpo_operations_manager');
    await mkUser('bound', 'a', 'cpo_operations_manager');
    await mkUser('otp', 'a', 'cpo_operations_manager');
    await mkUser('domain', 'a', 'cpo_operations_manager', 'domain@other-domain.test');
    await mkUser('bops', 'b', 'cpo_operations_manager');
    await mkUser('bboss', 'b', 'super_admin');
    await mkUser('cboss', 'c', 'super_admin');
    await mkUser('cops', 'c', 'cpo_operations_manager');
    await mkUser('plat', 'a', 'platform_admin');
    process.env.OPS_ALERT_ORG_ID = org.a;
    resetOpsAlertOrgCache();
    await query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [ids.disabled]);
    await query(`UPDATE app_user SET locked_until = now() + interval '10 minutes' WHERE id = $1`, [ids.locked]);
    await query(`UPDATE app_user SET ms_tenant_id = $2, ms_object_id = $3, ms_bound_at = now() WHERE id = $1`, [ids.bound, TENANT.a, randomUUID()]);
    await query(`UPDATE app_user SET must_change_password = true WHERE id = $1`, [ids.otp]);
    app = await buildApi();
    await app.ready();
  });
  beforeEach(() => {
    mock.nextError = null;
    mock.tamper = null;
  });
  after(async () => {
    await app?.close();
    await cleanup();
    await mock.stop();
    await pool.end();
  });
}

// ------------------------------------------------------------------ configuration

describe('configuration', () => {
  const base = { MS_CLIENT_ID: randomUUID(), MS_CLIENT_SECRET: 's3cret' };
  test('off without MS_CLIENT_ID, and a secret without an id is a mistake', () => {
    assert.equal(microsoftConfigProblem({}, false), null);
    assert.match(microsoftConfigProblem({ MS_CLIENT_SECRET: 'x' }, false)!, /MS_CLIENT_ID is not/);
  });
  test('the client id is a GUID and a secret is required (value or file, not both)', () => {
    assert.match(microsoftConfigProblem({ MS_CLIENT_ID: 'plugsure' }, true)!, /GUID/);
    assert.match(microsoftConfigProblem({ MS_CLIENT_ID: base.MS_CLIENT_ID }, true)!, /no client secret/);
    const dir = mkdtempSync(join(tmpdir(), 'ms-secret-'));
    writeFileSync(join(dir, 'secret'), 'from-a-file\n');
    assert.equal(microsoftConfigProblem({ MS_CLIENT_ID: base.MS_CLIENT_ID, MS_CLIENT_SECRET_FILE: join(dir, 'secret') }, true), null);
    assert.match(microsoftConfigProblem({ ...base, MS_CLIENT_SECRET_FILE: join(dir, 'secret') }, true)!, /not both/);
    assert.match(microsoftConfigProblem({ MS_CLIENT_ID: base.MS_CLIENT_ID, MS_CLIENT_SECRET_FILE: join(dir, 'missing') }, true)!, /cannot be read/);
  });
  test('outside development and test: only a Microsoft authority, and an https PUBLIC_BASE_URL', () => {
    const prod = (env: Record<string, string>) => microsoftConfigProblem({ ...base, ...env }, false);
    assert.match(prod({ MS_AUTHORITY_BASE: 'http://127.0.0.1:9' })!, /must be https:\/\/login\.microsoftonline\.com/);
    assert.match(prod({ MS_AUTHORITY_BASE: 'https://evil.example' })!, /must be https:\/\/login\.microsoftonline\.com/);
    assert.match(prod({ MS_AUTHORITY_BASE: 'https://login.microsoftonline.com/common' })!, /origin only/);
    if (!config.console.publicBaseUrl) {
      assert.match(prod({})!, /PUBLIC_BASE_URL/);
      assert.match(prod({ PUBLIC_BASE_URL: 'http://csms.example.co.id' })!, /PUBLIC_BASE_URL/);
      assert.equal(prod({ PUBLIC_BASE_URL: 'https://csms.example.co.id' }), null);
    }
  });
});

// ------------------------------------------------------------------ the ID token, check by check

dbDescribe('ID token validation', () => {
  const nonce = 'the-nonce';
  const expect = () => ({ clientId: mock.clientId, nonceHash: sha256Hex(nonce), authorityBase: mock.base });
  const good = () => mock.claimsFor({ tid: TENANT.a, oid: randomUUID(), preferred_username: 'x@y.test' }, nonce);
  const refused = async (token: string, why: RegExp, code = 'failed') => {
    await assert.rejects(validateIdToken(token, expect()), (e: unknown) => e instanceof MicrosoftSignInError && e.code === code && why.test(e.detail));
  };

  test('a well-formed token passes and yields its claims', async () => {
    const c = await validateIdToken(mock.mint({ ...good(), amr: ['pwd', 'mfa'], email: 'X@Y.test' }), expect());
    assert.equal(c.tid, TENANT.a);
    assert.equal(c.preferredUsername, 'x@y.test');
    assert.equal(c.email, 'x@y.test');
    assert.deepEqual(c.amr, ['pwd', 'mfa']);
  });
  test('alg none and HS256 are refused', async () => {
    const [h, p] = mock.mint(good()).split('.');
    const none = Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url');
    await refused(`${none}.${p}.`, /not a compact JWS|alg none/);
    await refused(`${none}.${p}.AAAA`, /alg none refused/);
    await refused(mock.mint(good(), { header: { alg: 'HS256' } }), /alg HS256 refused/);
    assert.ok(h);
  });
  test('a bad signature is refused', async () => {
    const t = mock.mint(good()).split('.');
    const forged = Buffer.from(JSON.stringify({ ...good(), oid: randomUUID() })).toString('base64url');
    await refused(`${t[0]}.${forged}.${t[2]}`, /bad signature/);
    await refused(mock.mint(good(), { key: newKey(mock.keys[0]!.kid) }), /bad signature/); // same kid, another key
  });
  test('an unknown kid is refused, and does not make us re-fetch the JWKS each time', async () => {
    resetMicrosoftCaches();
    await validateIdToken(mock.mint(good()), expect()); // fills the cache
    const before = mock.jwksFetches;
    const stranger = newKey('kid-nobody-published');
    await refused(mock.mint(good(), { key: stranger }), /unknown kid/);
    await refused(mock.mint(good(), { key: stranger }), /unknown kid/);
    await refused(mock.mint(good(), { key: stranger }), /unknown kid/);
    assert.ok(mock.jwksFetches - before <= 1, `JWKS fetched ${mock.jwksFetches - before} times for unknown kids within minutes`);
  });
  test('a rotated key is found by re-fetching the JWKS', async () => {
    resetMicrosoftCaches();
    const fresh = newKey('k-rotated');
    mock.keys.push(fresh);
    try {
      const c = await validateIdToken(mock.mint(good(), { key: fresh }), expect());
      assert.equal(c.tid, TENANT.a);
    } finally {
      mock.keys.pop();
      resetMicrosoftCaches();
    }
  });
  test('wrong audience (also an array without our client as azp)', async () => {
    await refused(mock.mint({ ...good(), aud: randomUUID() }), /wrong audience/);
    await refused(mock.mint({ ...good(), aud: [randomUUID(), mock.clientId] }), /wrong audience/);
    await validateIdToken(mock.mint({ ...good(), aud: [mock.clientId] }), expect());
  });
  test('wrong issuer: another tenant\'s, the template, another host', async () => {
    await refused(mock.mint({ ...good(), iss: mock.issuerFor(TENANT.b) }), /wrong issuer/);
    await refused(mock.mint({ ...good(), iss: `${mock.base}/{tenantid}/v2.0` }), /wrong issuer/);
    await refused(mock.mint({ ...good(), iss: `https://login.microsoftonline.com/${TENANT.a}/v2.0` }), /wrong issuer/);
  });
  test('expired, not yet valid, issued long ago or in the future', async () => {
    const now = Math.floor(Date.now() / 1000);
    await refused(mock.mint({ ...good(), exp: now - 120 }), /expired/);
    await validateIdToken(mock.mint({ ...good(), exp: now - 30 }), expect()); // inside the skew
    await refused(mock.mint({ ...good(), nbf: now + 600 }), /not yet valid/);
    await refused(mock.mint({ ...good(), iat: now - 3600, nbf: now - 3600 }), /iat out of range/);
    await refused(mock.mint({ ...good(), iat: now + 600, nbf: now }), /iat out of range/);
  });
  test('a nonce that is not this sign-in\'s, a missing tid or oid', async () => {
    await refused(mock.mint({ ...good(), nonce: 'another' }), /nonce mismatch/);
    const { nonce: _n, ...noNonce } = good();
    await refused(mock.mint(noNonce), /nonce mismatch/);
    const { oid: _o, ...noOid } = good();
    await refused(mock.mint(noOid), /no oid/);
    const { tid: _t, ...noTid } = good();
    await refused(mock.mint(noTid), /no tid/);
  });
  test('a personal Microsoft account is refused with its own answer', async () => {
    const t = mock.mint(mock.claimsFor({ tid: MS_PERSONAL_TENANT, oid: randomUUID(), preferred_username: 'me@outlook.com' }, nonce));
    await refused(t, /personal/, 'personal_account');
  });
});

// ------------------------------------------------------------------ the flow

dbDescribe('the sign-in flow', () => {
  test('start: authorization code + PKCE S256, state, nonce, query response mode; a Lax binding cookie', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/auth/microsoft/start', headers: { host: HOST } });
    assert.equal(r.statusCode, 302);
    const u = new URL(String(r.headers.location));
    assert.equal(u.origin + u.pathname, `${mock.base}/organizations/oauth2/v2.0/authorize`);
    const p = u.searchParams;
    assert.equal(p.get('client_id'), mock.clientId);
    assert.equal(p.get('response_type'), 'code');
    assert.equal(p.get('response_mode'), 'query');
    assert.equal(p.get('scope'), 'openid profile email');
    assert.equal(p.get('code_challenge_method'), 'S256');
    assert.match(p.get('code_challenge')!, /^[A-Za-z0-9_-]{43}$/);
    assert.match(p.get('state')!, /^[A-Za-z0-9_-]{43}$/);
    assert.match(p.get('nonce')!, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(p.get('redirect_uri'), `http://${HOST}/v1/auth/microsoft/callback`);
    const c = rawSetCookie(r, 'ps_ms_tx');
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Lax/);
    assert.match(c, /Path=\/v1\/auth\/microsoft\//);
    assert.match(c, /Max-Age=600/);
    // Only hashes of state and nonce are kept, and the verifier is sealed.
    const tx = await one<{ state_hash: string; code_verifier: string }>(`SELECT state_hash, code_verifier FROM oidc_login_tx WHERE state_hash = $1`, [sha256Hex(p.get('state')!)]);
    assert.ok(tx);
    assert.doesNotMatch(tx!.code_verifier, /^[A-Za-z0-9_-]{43}$/);
  });

  test('first sign-in matches by e-mail address and binds (tid, oid); then by oid even after the address changes', async () => {
    const who = ident(TENANT.a, 'OPS@a.ms-signin.test');
    const oid = who.oid;
    const first = await signIn(who);
    assert.equal(first.callback.statusCode, 303, first.callback.body);
    assert.equal(first.location, '/');
    assert.match(first.session ?? '', /^ps_session=pss_/);
    assert.match(rawSetCookie(first.callback, 'ps_session'), /SameSite=Strict/);
    assert.match(rawSetCookie(first.callback, 'ps_ms_tx'), /Max-Age=0/, 'the binding cookie is cleared');
    // The code was redeemed with the client secret and the PKCE verifier (the mock checks both).
    assert.equal(mock.lastTokenForm?.client_secret, mock.clientSecret);
    assert.match(mock.lastTokenForm?.code_verifier ?? '', /^[A-Za-z0-9_-]{43}$/);
    const me = await as(first.session, 'GET', '/v1/auth/me');
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.id, ids.ops);
    assert.equal(me.json().user.signedInWith, 'microsoft');
    assert.deepEqual(await binding(ids.ops!), { ms_tenant_id: TENANT.a, ms_object_id: oid });
    assert.equal((await lastAudit('user.microsoft_bound'))?.target_id, ids.ops);
    const login = await lastAudit('auth.login');
    assert.equal(login?.actor_id, ids.ops);
    assert.equal(login?.after_state?.method, 'microsoft');

    // Entra now says another address (renamed, or someone set it to a colleague's): the oid wins.
    const again = await signIn(ident(TENANT.a, 'ops2@a.ms-signin.test', {}, oid));
    assert.equal(again.location, '/');
    assert.equal((await as(again.session, 'GET', '/v1/auth/me')).json().user.id, ids.ops, 'signed in as the BOUND user, not ops2');
    assert.deepEqual(await binding(ids.ops2!), { ms_tenant_id: null, ms_object_id: null });
  });

  test('`email` never outvotes the UPN, and alone counts only when the tenant verified its domain (xms_edov)', async () => {
    // A UPN naming nobody, an `email` naming ops2: the UPN decides — nobody.
    const upnWins = await signIn(ident(TENANT.a, 'stranger@a.ms-signin.test', { email: 'ops2@a.ms-signin.test', xms_edov: true }));
    assert.equal(upnWins.location, '/?ms=no_user');
    // No UPN; an unverified `email`: not enough.
    const unverified = await signIn(ident(TENANT.a, null, { email: 'ops2@a.ms-signin.test' }));
    assert.equal(unverified.location, '/?ms=no_user');
    assert.match(String((await lastAudit('auth.microsoft_refused'))?.after_state?.detail), /xms_edov/);
    assert.equal((await signIn(ident(TENANT.a, null, { email: 'ops2@a.ms-signin.test', xms_edov: false }))).location, '/?ms=no_user');
    assert.deepEqual(await binding(ids.ops2!), { ms_tenant_id: null, ms_object_id: null });
    // Verified by the tenant: it matches.
    const r = await signIn(ident(TENANT.a, null, { email: 'ops2@a.ms-signin.test', xms_edov: true }));
    assert.equal(r.location, '/');
    assert.equal((await as(r.session, 'GET', '/v1/auth/me')).json().user.id, ids.ops2);
  });

  test('guests are refused: acct=1, a foreign idp, an #EXT# UPN', async () => {
    assert.equal((await signIn(ident(TENANT.a, 'ops@a.ms-signin.test', { acct: 1 }, randomUUID()))).location, '/?ms=guest_account');
    assert.equal((await signIn(ident(TENANT.a, 'ops@a.ms-signin.test', { idp: 'https://sts.windows.net/' + randomUUID() + '/' }, randomUUID()))).location, '/?ms=guest_account');
    assert.equal((await signIn(ident(TENANT.a, 'ops_a.ms-signin.test#EXT#@atenant.onmicrosoft.com', {}, randomUUID()))).location, '/?ms=guest_account');
    // A member's idp naming its own tenant (the v1 form) is not a guest.
    const own = await signIn(ident(TENANT.a, 'ops@a.ms-signin.test', { idp: `https://sts.windows.net/${TENANT.a}/` }));
    assert.equal(own.location, '/');
  });

  test('a personal Microsoft account is refused', async () => {
    const r = await signIn(ident(MS_PERSONAL_TENANT, 'ops@a.ms-signin.test'));
    assert.equal(r.location, '/?ms=personal_account');
    assert.equal(r.session, null);
    assert.equal((await lastAudit('auth.microsoft_refused'))?.after_state?.reason, 'personal_account');
  });

  test('a tenant no organisation connected is refused (and audited)', async () => {
    const r = await signIn(ident(TENANT.unlinked, 'ops@a.ms-signin.test'));
    assert.equal(r.location, '/?ms=not_linked');
    assert.equal(r.session, null);
    assert.equal((await lastAudit('auth.microsoft_refused'))?.after_state?.reason, 'not_linked');
  });

  test('a person without a console user is refused; no account is created', async () => {
    const count = async () => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM app_user WHERE org_id = $1`, [org.a]))!.n;
    const n = await count();
    const r = await signIn(ident(TENANT.a, 'newcomer@a.ms-signin.test'));
    assert.equal(r.location, '/?ms=no_user');
    assert.equal(r.session, null);
    assert.equal(await count(), n);
    const a = await lastAudit('auth.microsoft_refused');
    assert.equal(a?.org_id, org.a, 'audited in the organisation the tenant belongs to');
    assert.equal(a?.after_state?.reason, 'no_user');
  });

  test('disabled and locked users are refused', async () => {
    assert.equal((await signIn(ident(TENANT.a, 'disabled@a.ms-signin.test'))).location, '/?ms=disabled');
    assert.equal((await signIn(ident(TENANT.a, 'locked@a.ms-signin.test'))).location, '/?ms=locked');
    assert.deepEqual(await binding(ids.disabled!), { ms_tenant_id: null, ms_object_id: null }, 'a refused sign-in binds nothing');
  });

  test('a user bound to another Microsoft account is refused (oid conflict), and audited', async () => {
    const before = await binding(ids.bound!);
    const r = await signIn(ident(TENANT.a, 'bound@a.ms-signin.test'));
    assert.equal(r.location, '/?ms=oid_conflict');
    assert.deepEqual(await binding(ids.bound!), before);
    const a = await lastAudit('auth.microsoft_refused');
    assert.equal(a?.after_state?.reason, 'oid_conflict');
    assert.equal(a?.target_id, ids.bound);
  });

  test('cross-tenant isolation: tenant A\'s token never reaches organisation B\'s users', async () => {
    // B's user's address, from A's tenant: matched only inside A, so nobody.
    const r = await signIn(ident(TENANT.a, 'bops@b.ms-signin.test'));
    assert.equal(r.location, '/?ms=no_user');
    assert.deepEqual(await binding(ids.bops!), { ms_tenant_id: null, ms_object_id: null });
    // And the other way round.
    assert.equal((await signIn(ident(TENANT.b, 'ops@a.ms-signin.test'))).location, '/?ms=no_user');
    // B's own tenant signs B's user in.
    const ok = await signIn(ident(TENANT.b, 'bops@b.ms-signin.test'));
    assert.equal((await as(ok.session, 'GET', '/v1/auth/me')).json().org.id, org.b);
    // A's tenant presenting the oid B's user is bound to still reaches nobody in B.
    const bOid = (await binding(ids.bops!))!.ms_object_id!;
    assert.equal((await signIn(ident(TENANT.a, 'nobody@a.ms-signin.test', {}, bOid))).location, '/?ms=no_user');
  });

  test('state is single use: replaying the callback is refused', async () => {
    const r = await signIn(ident(TENANT.a, 'ops@a.ms-signin.test'));
    assert.equal(r.location, '/');
    const replay = await app.inject({ method: 'GET', url: r.callbackPath, headers: { host: HOST, cookie: r.binding! } });
    assert.equal(replay.headers.location, '/?ms=expired');
    assert.equal(cookieFrom(replay, 'ps_session'), null);
  });

  test('an expired transaction is refused (and consumed)', async () => {
    mock.nextIdentity = ident(TENANT.a, 'ops@a.ms-signin.test');
    const start = await app.inject({ method: 'GET', url: '/v1/auth/microsoft/start', headers: { host: HOST } });
    const state = new URL(String(start.headers.location)).searchParams.get('state')!;
    await query(`UPDATE oidc_login_tx SET expires_at = now() - interval '1 second' WHERE state_hash = $1`, [sha256Hex(state)]);
    const back = new URL((await fetch(String(start.headers.location), { redirect: 'manual' })).headers.get('location')!);
    const cb = await app.inject({ method: 'GET', url: back.pathname + back.search, headers: { host: HOST, cookie: cookieFrom(start, 'ps_ms_tx')! } });
    assert.equal(cb.headers.location, '/?ms=expired');
    assert.equal(await one(`SELECT 1 FROM oidc_login_tx WHERE state_hash = $1`, [sha256Hex(state)]), null);
  });

  test('login CSRF: a callback in a browser without the binding cookie (or on another host) is refused', async () => {
    const r = await signIn(ident(TENANT.a, 'ops@a.ms-signin.test'), { dropBinding: true });
    assert.equal(r.location, '/?ms=expired');
    assert.equal(r.session, null);
    assert.match(String((await lastAudit('auth.microsoft_refused'))?.after_state?.detail), /binding/);
    // Another host: the redirect URI is per host and so is every cookie.
    mock.nextIdentity = ident(TENANT.a, 'ops@a.ms-signin.test');
    const start = await app.inject({ method: 'GET', url: '/v1/auth/microsoft/start', headers: { host: HOST } });
    const back = new URL((await fetch(String(start.headers.location), { redirect: 'manual' })).headers.get('location')!);
    const cb = await app.inject({ method: 'GET', url: back.pathname + back.search, headers: { host: 'elsewhere.test', cookie: cookieFrom(start, 'ps_ms_tx')! } });
    assert.equal(cb.headers.location, '/?ms=expired');
  });

  test('token checks through the flow: nonce, audience, issuer, expiry, unknown kid', async () => {
    const id = () => ident(TENANT.a, 'ops@a.ms-signin.test');
    const cases: Array<[string, MockEntra['tamper']]> = [
      ['nonce', (t) => { t.payload.nonce = 'replayed-from-another-sign-in'; }],
      ['audience', (t) => { t.payload.aud = randomUUID(); }],
      ['issuer', (t) => { t.payload.iss = mock.issuerFor(TENANT.b); }],
      ['expired', (t) => { t.payload.exp = Math.floor(Date.now() / 1000) - 3600; }],
      ['kid', (t) => { t.header.kid = 'never-published'; }],
    ];
    for (const [name, tamper] of cases) {
      const r = await signIn(id(), { tamper });
      assert.equal(r.location, '/?ms=failed', name);
      assert.equal(r.session, null, name);
    }
  });

  test('Microsoft errors: cancelled, admin consent needed', async () => {
    assert.equal((await signIn(null, { error: { error: 'access_denied', error_description: 'The user cancelled' } })).location, '/?ms=cancelled');
    assert.equal((await signIn(null, { error: { error: 'invalid_client', error_description: 'AADSTS65001: The user or administrator has not consented' } })).location, '/?ms=consent');
    assert.equal((await signIn(null, { error: { error: 'server_error', error_description: 'AADSTS50000: boom' } })).location, '/?ms=failed');
  });

  test('a wrong client secret at the token endpoint fails the sign-in, without leaking anything', async () => {
    process.env.MS_CLIENT_SECRET = 'not-the-secret';
    try {
      const r = await signIn(ident(TENANT.a, 'ops@a.ms-signin.test'));
      assert.equal(r.location, '/?ms=failed');
      assert.match(String((await lastAudit('auth.microsoft_refused'))?.after_state?.detail), /invalid_client AADSTS7000215/);
      assert.doesNotMatch(JSON.stringify((await lastAudit('auth.microsoft_refused'))?.after_state), /not-the-secret|code-/);
    } finally {
      process.env.MS_CLIENT_SECRET = mock.clientSecret;
    }
  });

  test('allowed domains: a first match needs an address in one of them', async () => {
    await query(`UPDATE org_identity_provider SET allowed_domains = '{a.ms-signin.test}' WHERE org_id = $1`, [org.a]);
    try {
      assert.equal((await signIn(ident(TENANT.a, 'domain@other-domain.test'))).location, '/?ms=no_user');
      assert.equal((await signIn(ident(TENANT.a, 'ops2@a.ms-signin.test'))).location, '/');
    } finally {
      await query(`UPDATE org_identity_provider SET allowed_domains = '{}' WHERE org_id = $1`, [org.a]);
    }
  });

  test('rate limited per client address', async () => {
    process.env.MS_SIGNIN_RATE_PER_MIN = '3';
    try {
      const codes: number[] = [];
      let last = '';
      for (let i = 0; i < 5; i++) {
        const r = await app.inject({ method: 'GET', url: '/v1/auth/microsoft/start', headers: { host: HOST }, remoteAddress: '10.77.0.1' });
        codes.push(r.statusCode);
        last = String(r.headers.location);
      }
      assert.deepEqual(codes.slice(0, 3), [302, 302, 302]);
      assert.equal(last, '/?ms=rate_limited');
    } finally {
      process.env.MS_SIGNIN_RATE_PER_MIN = '100000';
    }
  });
});

// ------------------------------------------------------------------ two-step verification and holds

dbDescribe('two-step verification and session holds', () => {
  test('the sign-in that creates the binding never skips the console\'s second factor, whatever amr says', async () => {
    // An administrator without an authenticator app: held to enrolment on the binding sign-in.
    const first = await signIn(ident(TENANT.a, 'boss@a.ms-signin.test', { amr: ['pwd', 'mfa'] }));
    assert.equal(first.location, '/');
    assert.ok((await binding(ids.boss!))?.ms_object_id, 'bound');
    assert.equal((await as(first.session, 'GET', '/v1/sites')).json().code, 'mfa_enrolment_required');
    assert.equal((await as(first.session, 'GET', '/v1/auth/me')).json().user.mfaViaMicrosoft, false);
  });

  test('Microsoft MFA (amr "mfa") satisfies the requirement for an administrator once bound: no enrolment hold', async () => {
    const r = await signIn(ident(TENANT.a, 'boss@a.ms-signin.test', { amr: ['pwd', 'mfa'] }));
    assert.equal(r.location, '/');
    const sites = await as(r.session, 'GET', '/v1/sites');
    assert.equal(sites.statusCode, 200, sites.body);
    assert.equal((await as(r.session, 'GET', '/v1/auth/me')).json().user.mfaEnrolmentRequired, false);
    assert.equal((await lastAudit('auth.login'))?.after_state?.secondFactor, 'microsoft_mfa');
  });

  test('without amr "mfa" an administrator without an authenticator app must enrol, exactly as after a password', async () => {
    const r = await signIn(ident(TENANT.a, 'boss@a.ms-signin.test', { amr: ['pwd'] }));
    const sites = await as(r.session, 'GET', '/v1/sites');
    assert.equal(sites.statusCode, 403);
    assert.equal(sites.json().code, 'mfa_enrolment_required');
  });

  test('MS_TRUST_MFA_CLAIM=false: amr is ignored, also for sessions already let in on it', async () => {
    const before = await signIn(ident(TENANT.a, 'boss@a.ms-signin.test', { amr: ['mfa'] }));
    const plain = await signIn(ident(TENANT.a, 'ops@a.ms-signin.test', { amr: ['mfa'] }));
    assert.equal((await as(before.session, 'GET', '/v1/sites')).statusCode, 200);
    process.env.MS_TRUST_MFA_CLAIM = 'false';
    try {
      // The administrator's session rested on Microsoft's MFA: it ends at once (sign in again: the console's factor).
      assert.equal((await as(before.session, 'GET', '/v1/sites')).statusCode, 401);
      // Nothing would have been asked of an ordinary user without an authenticator app: carries on.
      assert.equal((await as(plain.session, 'GET', '/v1/sites')).statusCode, 200);
      const r = await signIn(ident(TENANT.a, 'boss@a.ms-signin.test', { amr: ['mfa'] }));
      assert.equal((await as(r.session, 'GET', '/v1/sites')).json().code, 'mfa_enrolment_required');
    } finally {
      delete process.env.MS_TRUST_MFA_CLAIM;
    }
  });

  test('an account with an authenticator app gets the code step (pending session), unless Microsoft did MFA', async () => {
    const e = await beginEnrolment(ids.totpboss!, 'totpboss@a.ms-signin.test');
    const secret = base32Decode(e.secret);
    const t = Date.now();
    await confirmEnrolment(ids.totpboss!, hotp(secret, timeStep(t)), null, t);

    // The binding sign-in, even WITH Microsoft MFA: the console's code first.
    const r = await signIn(ident(TENANT.a, 'totpboss@a.ms-signin.test', { amr: ['pwd', 'mfa'] }));
    assert.equal(r.location, '/');
    assert.equal((await lastAudit('user.microsoft_bound'))?.target_id, ids.totpboss);
    const held = await as(r.session, 'GET', '/v1/sites');
    assert.equal(held.statusCode, 403);
    assert.equal(held.json().code, 'mfa_required');
    assert.equal((await lastAudit('auth.login_mfa_challenge'))?.after_state?.method, 'microsoft');
    const ok = await as(r.session, 'POST', '/v1/auth/mfa/verify', { code: hotp(secret, timeStep(t) + 1) });
    assert.equal(ok.statusCode, 200, ok.body);
    const full = cookieFrom(ok, 'ps_session');
    assert.equal((await as(full, 'GET', '/v1/sites')).statusCode, 200);
    assert.equal((await as(full, 'GET', '/v1/auth/me')).json().user.signedInWith, 'microsoft', 'the full session stays a Microsoft session');

    const viaMfa = await signIn(ident(TENANT.a, 'totpboss@a.ms-signin.test', { amr: ['mfa', 'rsa'] }));
    assert.equal((await as(viaMfa.session, 'GET', '/v1/sites')).statusCode, 200, 'Entra did MFA: no code step');
  });

  test('a one-time password does not hold a Microsoft session, and the Microsoft sign-in ends it', async () => {
    const pw = await passwordSession('otp@a.ms-signin.test');
    assert.equal((await as(pw, 'GET', '/v1/sites')).json().code, 'password_change_required', 'a password session is held');
    const r = await signIn(ident(TENANT.a, 'otp@a.ms-signin.test'));
    assert.equal((await as(r.session, 'GET', '/v1/sites')).statusCode, 200);
    assert.equal((await as(r.session, 'GET', '/v1/auth/me')).json().user.mustChangePassword, false);
    // The waiting one-time password (e.g. issued by a reset after a compromise) no longer works.
    const again = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { host: HOST }, payload: { email: 'otp@a.ms-signin.test', password: PW } });
    assert.equal(again.statusCode, 401);
    assert.equal((await lastAudit('user.one_time_password_ended'))?.target_id, ids.otp);
    const listed = (await one<{ expired: boolean }>(`SELECT temp_password_expires_at <= now() AS expired FROM app_user WHERE id = $1`, [ids.otp]))!;
    assert.equal(listed.expired, true, 'shown as "one-time password expired" in Users & Roles');
  });

  test('CONSOLE_ADMIN_HOSTS: an administrator signing in with Microsoft on another host is refused', async () => {
    config.console.adminHosts.push('office.test');
    try {
      const r = await signIn(ident(TENANT.a, 'boss@a.ms-signin.test', { amr: ['mfa'] }));
      assert.equal(r.location, '/?ms=admin_host');
      assert.equal(r.session, null);
      // An ordinary user still signs in there.
      assert.equal((await signIn(ident(TENANT.a, 'ops2@a.ms-signin.test'))).location, '/');
    } finally {
      config.console.adminHosts.length = 0;
    }
  });
});

// ------------------------------------------------------------------ connecting the tenant

dbDescribe('connecting and disconnecting a tenant', () => {
  test('only user management may connect; the panel needs user:read', async () => {
    const ops = await passwordSession('cops@c.ms-signin.test');
    assert.equal((await as(ops, 'POST', '/v1/auth/microsoft/link', {})).statusCode, 403);
    assert.equal((await as(ops, 'GET', '/v1/auth/microsoft/tenant')).statusCode, 200);
    assert.equal((await as(ops, 'DELETE', '/v1/auth/microsoft/tenant')).statusCode, 403);
    assert.equal((await as(ops, 'PUT', '/v1/auth/microsoft/tenant', { allowedDomains: [] })).statusCode, 403);
  });

  test('connecting needs a MEMBER account holding a tenant administrator role (wids)', async () => {
    process.env.CONSOLE_MFA_REQUIRED = 'false';
    try {
      const boss = await passwordSession('cboss@c.ms-signin.test');
      const link = (extra: Partial<MockIdentity>) => signIn(ident(TENANT.c, 'someone@c-corp.test', extra, randomUUID()), { startUrl: '/v1/auth/microsoft/link', startCookie: boss! });
      assert.equal((await link({})).location, '/?ms=roles_missing#/users/microsoft', 'no wids claim at all');
      assert.equal((await link({ wids: [ENTRA_ROLES.member, ENTRA_ROLES.userAdministrator] })).location, '/?ms=not_tenant_admin#/users/microsoft');
      assert.equal((await link({ wids: [ENTRA_ROLES.globalAdministrator], acct: 1 })).location, '/?ms=guest_account#/users/microsoft');
      assert.equal((await link({ wids: [ENTRA_ROLES.globalAdministrator], idp: 'live.com' })).location, '/?ms=guest_account#/users/microsoft');
      assert.equal((await as(boss, 'GET', '/v1/auth/microsoft/tenant')).json().tenant, null, 'nothing connected');
      assert.equal((await lastAudit('org.microsoft_tenant_link_failed'))?.after_state?.reason, 'guest_account');
    } finally {
      process.env.CONSOLE_MFA_REQUIRED = 'true';
    }
  });

  test('an administrator connects the tenant of a validated sign-in; it then signs the organisation\'s users in', async () => {
    process.env.CONSOLE_MFA_REQUIRED = 'false'; // a password session of a Super Administrator, without enrolling here
    const boss = await passwordSession('cboss@c.ms-signin.test');
    try {
      const before = await as(boss, 'GET', '/v1/auth/microsoft/tenant');
      assert.equal(before.json().tenant, null);
      assert.equal(before.json().redirectUri, `http://${HOST}/v1/auth/microsoft/callback`);
      const r = await signIn(ident(TENANT.c, 'it-admin@c-corp.test', { wids: [ENTRA_ROLES.member, ENTRA_ROLES.globalAdministrator] }), { startUrl: '/v1/auth/microsoft/link', startCookie: boss! });
      assert.equal(r.start.statusCode, 200, r.start.body);
      assert.equal(r.location, '/?ms=linked#/users/microsoft');
      assert.equal(r.session, null, 'connecting a tenant signs nobody in');
      const after = (await as(boss, 'GET', '/v1/auth/microsoft/tenant')).json();
      assert.equal(after.tenant.tenantId, TENANT.c);
      assert.equal(after.tenant.linkedBy.id, ids.cboss);
      assert.equal(after.tenant.linkedByAccount, 'it-admin@c-corp.test');
      const a = await lastAudit('org.microsoft_tenant_linked');
      assert.equal(a?.org_id, org.c);
      assert.equal(a?.after_state?.tenantId, TENANT.c);
      assert.equal(a?.after_state?.provenRole, 'Global Administrator');
      // The platform operator is told (OPS_ALERT_ORG_ID = organisation A here).
      const alert = await one<{ severity: string; message: string }>(
        `SELECT severity, message FROM alert WHERE org_id = $1 AND kind = 'platform.microsoft_tenant_linked' AND target_id = $2 AND resolved_at IS NULL`, [org.a, TENANT.c]);
      assert.ok(alert, 'platform alert raised');
      assert.match(alert!.message, /MS sign-in c/);
      // Connected: C's staff sign in.
      assert.equal((await signIn(ident(TENANT.c, 'cops@c.ms-signin.test'))).location, '/');
      // Already connected: disconnect first.
      assert.equal((await as(boss, 'POST', '/v1/auth/microsoft/link', {})).statusCode, 409);
    } finally {
      process.env.CONSOLE_MFA_REQUIRED = 'true';
    }
  });

  test('a tenant belongs to one organisation: B cannot connect A\'s tenant', async () => {
    process.env.CONSOLE_MFA_REQUIRED = 'false';
    try {
      await query(`DELETE FROM org_identity_provider WHERE org_id = $1`, [org.b]);
      const bboss = await passwordSession('bboss@b.ms-signin.test');
      const r = await signIn(ident(TENANT.a, 'someone@a-corp.test', { wids: [ENTRA_ROLES.applicationAdministrator] }), { startUrl: '/v1/auth/microsoft/link', startCookie: bboss! });
      assert.equal(r.location, '/?ms=tenant_taken#/users/microsoft');
      assert.equal((await as(bboss, 'GET', '/v1/auth/microsoft/tenant')).json().tenant, null);
      const a = await lastAudit('org.microsoft_tenant_link_failed');
      assert.equal(a?.org_id, org.b);
      assert.equal(a?.after_state?.reason, 'tenant_taken');
      assert.equal((await one<{ org_id: string }>(`SELECT org_id FROM org_identity_provider WHERE tenant_id = $1`, [TENANT.a]))?.org_id, org.a);
    } finally {
      await query(`INSERT INTO org_identity_provider (org_id, provider, tenant_id) VALUES ($1, 'microsoft', $2) ON CONFLICT DO NOTHING`, [org.b, TENANT.b]);
      process.env.CONSOLE_MFA_REQUIRED = 'true';
    }
  });

  test('an administrator who lost user management before Microsoft sent them back cannot connect', async () => {
    process.env.CONSOLE_MFA_REQUIRED = 'false';
    await query(`DELETE FROM org_identity_provider WHERE org_id = $1`, [org.b]);
    try {
      const bboss = await passwordSession('bboss@b.ms-signin.test');
      mock.nextIdentity = ident(TENANT.b, 'it@b-corp.test', { wids: [ENTRA_ROLES.globalAdministrator] });
      const start = await app.inject({ method: 'POST', url: '/v1/auth/microsoft/link', headers: { host: HOST, cookie: bboss!, 'x-plugsure-csrf': '1' } });
      await setUserRole(ids.bboss!, org.b, 'cpo_operations_manager');
      const back = new URL((await fetch(start.json().url, { redirect: 'manual' })).headers.get('location')!);
      const cb = await app.inject({ method: 'GET', url: back.pathname + back.search, headers: { host: HOST, cookie: cookieFrom(start, 'ps_ms_tx')! } });
      assert.equal(cb.headers.location, '/?ms=link_forbidden#/users/microsoft');
      assert.equal(await one(`SELECT 1 FROM org_identity_provider WHERE org_id = $1`, [org.b]), null);
    } finally {
      await setUserRole(ids.bboss!, org.b, 'super_admin');
      await query(`INSERT INTO org_identity_provider (org_id, provider, tenant_id) VALUES ($1, 'microsoft', $2) ON CONFLICT DO NOTHING`, [org.b, TENANT.b]);
      process.env.CONSOLE_MFA_REQUIRED = 'true';
    }
  });

  test('allowed domains are validated and audited', async () => {
    process.env.CONSOLE_MFA_REQUIRED = 'false';
    try {
      const boss = await passwordSession('cboss@c.ms-signin.test');
      assert.equal((await as(boss, 'PUT', '/v1/auth/microsoft/tenant', { allowedDomains: ['not a domain'] })).statusCode, 400);
      const ok = await as(boss, 'PUT', '/v1/auth/microsoft/tenant', { allowedDomains: ['@C-Corp.test', 'c.ms-signin.test'] });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.deepEqual(ok.json().tenant.allowedDomains, ['c-corp.test', 'c.ms-signin.test']);
      assert.deepEqual((await lastAudit('org.microsoft_tenant_updated'))?.after_state?.allowedDomains, ['c-corp.test', 'c.ms-signin.test']);
    } finally {
      process.env.CONSOLE_MFA_REQUIRED = 'true';
    }
  });

  test('an administrator unbinds one user: their Microsoft sessions end, the next sign-in binds afresh', async () => {
    process.env.CONSOLE_MFA_REQUIRED = 'false';
    try {
      const r = await signIn(ident(TENANT.c, 'cops@c.ms-signin.test'));
      assert.ok((await binding(ids.cops!))?.ms_object_id);
      const boss = await passwordSession('cboss@c.ms-signin.test');
      const list = (await as(boss, 'GET', '/v1/users')).json();
      assert.equal(list.find((u: any) => u.id === ids.cops).microsoft_bound, true);
      const ops = await passwordSession('cops@c.ms-signin.test');
      assert.equal((await as(ops, 'DELETE', `/v1/users/${ids.boss}/microsoft`)).statusCode, 403);
      assert.equal((await as(boss, 'DELETE', `/v1/users/${ids.ops}/microsoft`)).statusCode, 404, 'another organisation\'s user');
      const un = await as(boss, 'DELETE', `/v1/users/${ids.cops}/microsoft`);
      assert.equal(un.statusCode, 200, un.body);
      assert.deepEqual(await binding(ids.cops!), { ms_tenant_id: null, ms_object_id: null });
      assert.equal((await as(r.session, 'GET', '/v1/auth/me')).statusCode, 401, 'the Microsoft session ended');
      assert.equal((await as(ops, 'GET', '/v1/auth/me')).statusCode, 200, 'a password session is untouched');
      assert.equal((await lastAudit('user.microsoft_unbound'))?.target_id, ids.cops);
      assert.equal((await as(boss, 'DELETE', `/v1/users/${ids.cops}/microsoft`)).statusCode, 404);
    } finally {
      process.env.CONSOLE_MFA_REQUIRED = 'true';
    }
  });

  test('disconnecting: every binding goes, Microsoft sessions end, sign-ins from the tenant are refused', async () => {
    process.env.CONSOLE_MFA_REQUIRED = 'false';
    try {
      const r = await signIn(ident(TENANT.c, 'cops@c.ms-signin.test'));
      const boss = await passwordSession('cboss@c.ms-signin.test');
      const del = await as(boss, 'DELETE', '/v1/auth/microsoft/tenant');
      assert.equal(del.statusCode, 200, del.body);
      assert.equal(del.json().tenantId, TENANT.c);
      assert.ok(del.json().usersUnbound >= 1);
      assert.equal((await as(r.session, 'GET', '/v1/auth/me')).statusCode, 401);
      assert.equal((await as(boss, 'GET', '/v1/auth/me')).statusCode, 200);
      assert.deepEqual(await binding(ids.cops!), { ms_tenant_id: null, ms_object_id: null });
      assert.equal((await lastAudit('org.microsoft_tenant_unlinked'))?.org_id, org.c);
      assert.equal((await signIn(ident(TENANT.c, 'cops@c.ms-signin.test'))).location, '/?ms=not_linked');
      assert.equal((await as(boss, 'DELETE', '/v1/auth/microsoft/tenant')).statusCode, 404);
    } finally {
      process.env.CONSOLE_MFA_REQUIRED = 'true';
    }
  });

  test('row-level security: an organisation sees only its own connected tenant', async () => {
    process.env.CONSOLE_MFA_REQUIRED = 'false';
    try {
      const bboss = await passwordSession('bboss@b.ms-signin.test');
      assert.equal((await as(bboss, 'GET', '/v1/auth/microsoft/tenant')).json().tenant.tenantId, TENANT.b);
    } finally {
      process.env.CONSOLE_MFA_REQUIRED = 'true';
    }
  });
});

// ------------------------------------------------------------------ switched off

dbDescribe('without MS_CLIENT_ID', () => {
  test('the button is not offered and every route answers 404', async () => {
    const on = await app.inject({ method: 'GET', url: '/console-sign-in.json', headers: { host: HOST } });
    assert.equal(on.json().microsoft, true);
    assert.equal(typeof on.json().multiCountry, 'boolean');
    const saved = process.env.MS_CLIENT_ID;
    delete process.env.MS_CLIENT_ID;
    try {
      assert.equal((await app.inject({ method: 'GET', url: '/console-sign-in.json', headers: { host: HOST } })).json().microsoft, false);
      assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/microsoft/start', headers: { host: HOST } })).statusCode, 404);
      assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/microsoft/callback?state=x&code=y', headers: { host: HOST } })).statusCode, 404);
      process.env.CONSOLE_MFA_REQUIRED = 'false';
      const boss = await passwordSession('bboss@b.ms-signin.test');
      assert.equal((await as(boss, 'POST', '/v1/auth/microsoft/link', {})).statusCode, 404);
      assert.equal((await as(boss, 'GET', '/v1/auth/microsoft/tenant')).statusCode, 404);
      assert.equal((await as(boss, 'GET', '/v1/auth/me')).json().features.microsoftSignIn, false);
    } finally {
      process.env.MS_CLIENT_ID = saved;
      process.env.CONSOLE_MFA_REQUIRED = 'true';
    }
  });
});

// ------------------------------------------------------------------ the platform operator, API keys, cookies, retention

dbDescribe('platform operator, API keys and the binding cookie', () => {
  test('the platform operator lists every connected tenant and releases a squatted one (audited twice); nobody else can', async () => {
    process.env.CONSOLE_MFA_REQUIRED = 'false';
    try {
      await query(`INSERT INTO org_identity_provider (org_id, provider, tenant_id) VALUES ($1, 'microsoft', $2) ON CONFLICT DO NOTHING`, [org.c, TENANT.c]);
      const r = await signIn(ident(TENANT.c, 'cops@c.ms-signin.test'));
      assert.equal(r.location, '/');
      const cboss = await passwordSession('cboss@c.ms-signin.test');
      assert.equal((await as(cboss, 'GET', '/v1/platform/microsoft-tenants')).statusCode, 403);
      assert.equal((await as(cboss, 'DELETE', `/v1/platform/microsoft-tenants/${TENANT.c}`)).statusCode, 403);
      const plat = await passwordSession('plat@a.ms-signin.test');
      const list = (await as(plat, 'GET', '/v1/platform/microsoft-tenants')).json().tenants;
      assert.deepEqual(list.filter((t: any) => [TENANT.a, TENANT.b, TENANT.c].includes(t.tenantId)).map((t: any) => t.orgName).sort(), ['MS sign-in a', 'MS sign-in b', 'MS sign-in c']);
      const rel = await as(plat, 'DELETE', `/v1/platform/microsoft-tenants/${TENANT.c}`);
      assert.equal(rel.statusCode, 200, rel.body);
      assert.equal(rel.json().orgId, org.c);
      assert.equal(await one(`SELECT 1 FROM org_identity_provider WHERE tenant_id = $1`, [TENANT.c]), null);
      assert.equal((await as(r.session, 'GET', '/v1/auth/me')).statusCode, 401, 'its Microsoft sessions ended');
      assert.equal((await lastAudit('platform.microsoft_tenant_released'))?.org_id, org.a);
      const inC = await lastAudit('org.microsoft_tenant_unlinked');
      assert.equal(inC?.org_id, org.c);
      assert.equal(inC?.after_state?.byPlatformOperator, true);
      assert.equal((await as(plat, 'DELETE', `/v1/platform/microsoft-tenants/${TENANT.c}`)).statusCode, 404);
    } finally {
      process.env.CONSOLE_MFA_REQUIRED = 'true';
    }
  });

  test('an API key with user management cannot change or disconnect the tenant', async () => {
    const key = await issueApiKey({ orgId: org.b, name: 'ms test', permissions: ['user:read', 'user:write'] });
    const h = { host: HOST, authorization: `Bearer ${key.key}` };
    assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/microsoft/tenant', headers: h })).statusCode, 200);
    const put = await app.inject({ method: 'PUT', url: '/v1/auth/microsoft/tenant', headers: h, payload: { allowedDomains: ['x.test'] } });
    assert.equal(put.statusCode, 403);
    assert.equal(put.json().code, 'console_user_required');
    assert.equal((await app.inject({ method: 'DELETE', url: '/v1/auth/microsoft/tenant', headers: h })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/microsoft/link', headers: h })).statusCode, 400);
    assert.ok(await one(`SELECT 1 FROM org_identity_provider WHERE org_id = $1`, [org.b]), 'still connected');
  });

  test('two sign-ins in progress in one browser (two tabs) both complete; the cookie keeps the other', async () => {
    const jar = new Map<string, string>();
    const send = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const keep = (res: { headers: Record<string, unknown> }) => {
      const raw = res.headers['set-cookie'];
      for (const c of (Array.isArray(raw) ? raw : raw ? [String(raw)] : [])) {
        const [pair] = String(c).split(';');
        const i = pair!.indexOf('=');
        if (/Max-Age=0/.test(String(c))) jar.delete(pair!.slice(0, i)); else jar.set(pair!.slice(0, i), pair!.slice(i + 1));
      }
    };
    const begin = async (id: MockIdentity) => {
      mock.nextIdentity = id;
      const st = await app.inject({ method: 'GET', url: '/v1/auth/microsoft/start', headers: { host: HOST, cookie: send() } });
      keep(st);
      const back = new URL((await fetch(String(st.headers.location), { redirect: 'manual' })).headers.get('location')!);
      return back.pathname + back.search;
    };
    const tab1 = await begin(ident(TENANT.a, 'ops@a.ms-signin.test'));
    const tab2 = await begin(ident(TENANT.a, 'ops2@a.ms-signin.test'));
    assert.equal(jar.get('ps_ms_tx')?.split('.').length, 2, 'both bindings in the cookie');
    const cb1 = await app.inject({ method: 'GET', url: tab1, headers: { host: HOST, cookie: send() } });
    keep(cb1);
    assert.equal(cb1.headers.location, '/', 'the first tab\'s sign-in still completes');
    assert.equal(jar.get('ps_ms_tx')?.split('.').length, 1, 'its binding is spent; the other stays');
    const cb2 = await app.inject({ method: 'GET', url: tab2, headers: { host: HOST, cookie: send() } });
    assert.equal(cb2.headers.location, '/');
    assert.match(rawSetCookie(cb2, 'ps_ms_tx'), /Max-Age=0/, 'nothing left: the cookie is cleared');
  });

  test('the binding cookie: __Host- on https; a duplicated or malformed cookie binds nothing', () => {
    const v = 'A'.repeat(43);
    const w = 'B'.repeat(43);
    assert.deepEqual(msTxCookie(true), { name: '__Host-ps_ms_tx', path: '/' });
    assert.deepEqual(bindingsFromCookie(`__Host-ps_ms_tx=${v}.${w}`, true), [v, w]);
    assert.deepEqual(bindingsFromCookie(`ps_ms_tx=${v}`, true), [], 'the plain name does not count on https');
    assert.deepEqual(bindingsFromCookie(`__Host-ps_ms_tx=${v}; __Host-ps_ms_tx=${w}`, true), [], 'two cookies: neither is taken');
    assert.deepEqual(bindingsFromCookie(`ps_ms_tx=${v}; ps_ms_tx=${w}`, false), []);
    assert.deepEqual(bindingsFromCookie(`ps_ms_tx=${v}.short`, false), []);
    assert.deepEqual(bindingsFromCookie(`ps_ms_tx=${[v, v, v, v, v].join('.')}`, false), [], 'more than four');
  });

  test('a duplicated binding cookie on the callback is refused', async () => {
    mock.nextIdentity = ident(TENANT.a, 'ops@a.ms-signin.test');
    const st = await app.inject({ method: 'GET', url: '/v1/auth/microsoft/start', headers: { host: HOST } });
    const good = cookieFrom(st, 'ps_ms_tx')!;
    const back = new URL((await fetch(String(st.headers.location), { redirect: 'manual' })).headers.get('location')!);
    const cb = await app.inject({ method: 'GET', url: back.pathname + back.search, headers: { host: HOST, cookie: `${good}; ps_ms_tx=${'C'.repeat(43)}` } });
    assert.equal(cb.headers.location, '/?ms=expired');
  });

  test('the retention worker purges abandoned sign-in transactions', async () => {
    await app.inject({ method: 'GET', url: '/v1/auth/microsoft/start', headers: { host: HOST } });
    await query(`UPDATE oidc_login_tx SET expires_at = now() - interval '1 minute' WHERE expires_at > now()`);
    const r = await runRetention({ ocppFrameDays: 0, connectionAttemptDays: 0, pauseMs: 0 });
    assert.ok(r.oidcTransactions >= 1);
    assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM oidc_login_tx WHERE expires_at < now()`))!.n, 0);
  });
});
