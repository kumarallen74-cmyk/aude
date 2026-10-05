import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { hashPassword, ensureSystemRoles, setUserRole, setUserStatus } from '../services/users.js';
import { authenticate, createSession } from '../services/auth.js';
import { beginEnrolment, confirmEnrolment } from '../services/mfa.js';
import { base32Decode, hotp, timeStep } from '../services/totp.js';
import { buildApi } from './server.js';
import { watchLiveStream } from './stream-guard.js';

/**
 * The console's sign-in over HTTP (database-backed, the real Fastify app via inject):
 *   · sign-out revokes a Bearer `pss_` session, not only the cookie;
 *   · the two-step verification step: password → pending → code → full session;
 *   · an administrator's 2FA reset (not on oneself);
 *   · a live stream ends once its session is revoked or its user disabled.
 *
 *   DATABASE_URL=postgresql://…/plugsure_audit_fix NODE_ENV=test npx tsx --test src/api/console-auth.test.ts
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[console-auth.test] SKIPPING database-backed suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'console-auth-test';
const PW = 'Correct-Horse-2026!';
let orgId = '';
const ids: Record<string, string> = {};
let app: FastifyInstance;

const signedIn = (token: string) => authenticate({ authorization: `Bearer ${token}` }).then(() => true, () => false);
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie'] ?? '').split(';')[0]!;

async function cleanup() {
  const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (!org) return;
  await query(`DELETE FROM user_role WHERE user_id IN (SELECT id FROM app_user WHERE org_id = $1)`, [org.id]);
  await query(`DELETE FROM app_user WHERE org_id = $1`, [org.id]);
}

async function mkUser(key: string, role: string) {
  const r = await one<{ id: string }>(
    `INSERT INTO app_user (org_id, email, name, status, password_hash) VALUES ($1, $2, $3, 'active', $4) RETURNING id`,
    [orgId, `${key}@console-auth.plugsure.test`, key, await hashPassword(PW)],
  );
  ids[key] = r!.id;
  await setUserRole(r!.id, orgId, role);
}

if (DB_OK) {
  before(async () => {
    await cleanup();
    await ensureSystemRoles();
    orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug) VALUES ('Console Auth Test', $1) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    await mkUser('boss', 'super_admin');
    await mkUser('two', 'super_admin');
    await mkUser('ops', 'cpo_operations_manager');
    app = await buildApi();
    await app.ready();
  });
  afterEach(() => {
    delete process.env.STREAM_REVALIDATE_SECONDS;
  });
  after(async () => {
    await app?.close();
    await cleanup();
    await pool.end();
  });
}

dbDescribe('sign-out', () => {
  test('revokes a Bearer pss_ session, not only the cookie', async () => {
    const token = await createSession(ids.ops!);
    const r = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${token}` } });
    assert.equal(r.statusCode, 200);
    assert.equal(await signedIn(token), false);
  });

  test('still revokes the cookie session', async () => {
    const token = await createSession(ids.ops!);
    const r = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie: `ps_session=${token}`, 'x-plugsure-csrf': '1' } });
    assert.equal(r.statusCode, 200);
    assert.equal(await signedIn(token), false);
  });
});

dbDescribe('two-step verification over HTTP', () => {
  test('password, then the code, then the console; nothing in between', async () => {
    const e = await beginEnrolment(ids.two!, 'two@console-auth.plugsure.test');
    const secret = base32Decode(e.secret);
    const t = Date.now();
    await confirmEnrolment(ids.two!, hotp(secret, timeStep(t)), null, t);

    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'two@console-auth.plugsure.test', password: PW } });
    assert.equal(login.statusCode, 200);
    assert.equal(login.json().mfaRequired, true);
    const pending = cookieOf(login);
    assert.match(pending, /^ps_session=pss_/);
    const h = { cookie: pending, 'x-plugsure-csrf': '1' };

    const held = await app.inject({ method: 'GET', url: '/v1/sites', headers: h });
    assert.equal(held.statusCode, 403);
    assert.equal(held.json().code, 'mfa_required');

    const wrong = await app.inject({ method: 'POST', url: '/v1/auth/mfa/verify', headers: h, payload: { code: '000000' } });
    assert.equal(wrong.statusCode, 400, 'a wrong code: try again on the same pending session');
    assert.match(wrong.json().error, /invalid code/);
    // The failure stayed counted although the request transaction rolled back.
    assert.equal((await one<{ n: number }>(`SELECT failed_logins AS n FROM app_user WHERE id = $1`, [ids.two]))!.n, 2);

    const ok = await app.inject({ method: 'POST', url: '/v1/auth/mfa/verify', headers: h, payload: { code: hotp(secret, timeStep(t) + 1) } });
    assert.equal(ok.statusCode, 200, ok.body);
    const full = cookieOf(ok);
    assert.notEqual(full, pending, 'a fresh session, not the pending one promoted');
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: full } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.mfa.enabled, true);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { cookie: pending } })).statusCode, 401);

    const audit = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND action IN ('auth.login_mfa_challenge', 'auth.mfa_failed', 'auth.login')`, [ids.two]);
    assert.ok(audit!.n >= 3, 'challenge, failure and sign-in are audited');
  });

  test('an administrator resets another user\'s two-step verification, never their own', async () => {
    const boss = await createSession(ids.boss!);
    const h = { authorization: `Bearer ${boss}` };
    const own = await app.inject({ method: 'POST', url: `/v1/users/${ids.boss}/reset-mfa`, headers: h });
    assert.equal(own.statusCode, 400);
    const r = await app.inject({ method: 'POST', url: `/v1/users/${ids.two}/reset-mfa`, headers: h });
    assert.equal(r.statusCode, 200, r.body);
    const st = await one<{ on: boolean }>(`SELECT (totp_secret IS NOT NULL) AS on FROM app_user WHERE id = $1`, [ids.two]);
    assert.equal(st!.on, false);
    const a = await one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.mfa_reset' AND target_id = $1`, [ids.two]);
    assert.equal(a!.n, 1);
  });
});

dbDescribe('live streams re-check their session', () => {
  /** Open GET /v1/stream on a listening copy of the app; resolves on headers, with an `ended` promise. */
  async function openStream(port: number, token: string) {
    return new Promise<{ status: number; ended: Promise<number>; destroy: () => void }>((resolve, reject) => {
      const req = http.get({ port, path: '/v1/stream', headers: { authorization: `Bearer ${token}` } }, (res) => {
        const t0 = Date.now();
        const ended = new Promise<number>((done) => { res.on('end', () => done(Date.now() - t0)); res.on('close', () => done(Date.now() - t0)); });
        res.resume();
        resolve({ status: res.statusCode ?? 0, ended, destroy: () => req.destroy() });
      });
      req.on('error', reject);
    });
  }

  test('a revoked session or a disabled user ends an open /v1/stream', async () => {
    process.env.STREAM_REVALIDATE_SECONDS = '0.2';
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;

    const tokA = await createSession(ids.ops!);
    const a = await openStream(port, tokA);
    assert.equal(a.status, 200);
    const stillOpen = await Promise.race([a.ended.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 700))]);
    assert.equal(stillOpen, true, 'a valid session keeps its stream');
    await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${tokA}` } });
    const endedAfter = await Promise.race([a.ended, new Promise<number>((r) => setTimeout(() => r(-1), 3000))]);
    assert.ok(endedAfter > 0, 'the stream ended after sign-out');

    const tokB = await createSession(ids.ops!);
    const b = await openStream(port, tokB);
    assert.equal(b.status, 200);
    await setUserStatus(ids.ops!, 'disabled');
    const endedB = await Promise.race([b.ended, new Promise<number>((r) => setTimeout(() => r(-1), 3000))]);
    assert.ok(endedB > 0, 'the stream ended after the user was disabled');
    await setUserStatus(ids.ops!, 'active');
  });

  test('the re-check does not count as activity, and a lost permission ends the stream', async () => {
    const token = await createSession(ids.ops!);
    await query(`UPDATE auth_session SET last_seen_at = now() - interval '10 minutes' WHERE token_hash IS NOT NULL AND user_id = $1`, [ids.ops]);
    let closed = false;
    let allowed = true;
    const fakeReq = { headers: { authorization: `Bearer ${token}`, host: 'x' }, url: '/v1/stream', routeOptions: { url: '/v1/stream' } } as any;
    const stop = watchLiveStream(fakeReq, { intervalMs: 50, stillAllowed: () => allowed, close: () => { closed = true; } });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(closed, false);
    const seen = await one<{ idle: boolean }>(`SELECT bool_and(last_seen_at < now() - interval '9 minutes') AS idle FROM auth_session WHERE user_id = $1 AND revoked_at IS NULL`, [ids.ops]);
    assert.equal(seen!.idle, true, 'an open tab does not keep an idle session alive');
    allowed = false;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(closed, true);
    stop();
  });
});
