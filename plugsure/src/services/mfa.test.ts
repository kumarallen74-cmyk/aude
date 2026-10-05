import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { login, hashPassword, ensureSystemRoles, setUserRole } from './users.js';
import { authenticate, adminHostAllowed, createSession, type AuthResult } from './auth.js';
import { beginEnrolment, checkSecondFactor, completeSignIn, confirmEnrolment, mfaStatus, resetMfa } from './mfa.js';
import { base32Decode, hotp, timeStep } from './totp.js';
import { sessionHold } from '../api/session-holds.js';

/**
 * Two-step verification for console accounts (migration 055, database-backed):
 * enrolment, the second sign-in step on a pending session, replay refusal, single-use
 * recovery codes, the shared lockout, enforcement for administrators with the enrolment
 * grace path, CONSOLE_ADMIN_HOSTS, and the administrator's reset.
 *
 *   DATABASE_URL=postgresql://…/plugsure_audit_fix NODE_ENV=test npx tsx --test src/services/mfa.test.ts
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[mfa.test] SKIPPING database-backed suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'mfa-test';
const PW = 'Correct-Horse-2026!';
let orgId = '';
const ids: Record<string, string> = {};

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const auth = (token: string) => authenticate(bearer(token)).catch(() => null);
/** The authenticator app: the code for `step`, from the account's stored (sealed) secret via a fresh enrolment. */
const secrets: Record<string, Buffer> = {};
const codeAt = (who: string, step: number) => hotp(secrets[who]!, step);

async function cleanup() {
  const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (!org) return;
  await query(`DELETE FROM user_role WHERE user_id IN (SELECT id FROM app_user WHERE org_id = $1)`, [org.id]);
  await query(`DELETE FROM app_user WHERE org_id = $1`, [org.id]);
}

async function mkUser(key: string, role: string) {
  const r = await one<{ id: string }>(
    `INSERT INTO app_user (org_id, email, name, status, password_hash) VALUES ($1, $2, $3, 'active', $4) RETURNING id`,
    [orgId, `${key}@mfa.plugsure.test`, key, await hashPassword(PW)],
  );
  ids[key] = r!.id;
  await setUserRole(r!.id, orgId, role);
}

/** Enrol `who` with the clock at `nowMs`; returns the recovery codes. */
async function enrol(who: string, nowMs: number): Promise<string[]> {
  const e = await beginEnrolment(ids[who]!, `${who}@mfa.plugsure.test`);
  secrets[who] = base32Decode(e.secret);
  return (await confirmEnrolment(ids[who]!, hotp(secrets[who]!, timeStep(nowMs)), null, nowMs)).recoveryCodes;
}

const T0 = Date.now();
const S0 = timeStep(T0);

if (DB_OK) {
  before(async () => {
    await cleanup();
    await ensureSystemRoles();
    orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug) VALUES ('MFA Test', $1) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    await mkUser('admin', 'super_admin');
    await mkUser('locky', 'super_admin');
    await mkUser('fresh', 'super_admin');
    await mkUser('tech', 'field_technician');
    await mkUser('resetme', 'cpo_operations_manager');
  });
  afterEach(() => {
    delete process.env.CONSOLE_MFA_REQUIRED;
    (config.console as { adminHosts: string[] }).adminHosts = [];
  });
  after(async () => { await cleanup(); await pool.end(); });
}

dbDescribe('enrolment', () => {
  test('a code from the app turns it on; the secret is sealed and only recovery-code hashes are kept', async () => {
    const codes = await enrol('admin', T0);
    assert.equal(codes.length, 10);
    const row = await one<any>(`SELECT totp_secret, totp_pending_secret, totp_last_step, totp_recovery_hashes FROM app_user WHERE id = $1`, [ids.admin]);
    assert.match(row.totp_secret, /^enc:v2:/, 'sealed with SECRETS_KEY and the user as associated data');
    assert.equal(row.totp_pending_secret, null);
    assert.equal(Number(row.totp_last_step), S0, 'the confirming code cannot be replayed at sign-in');
    assert.equal(row.totp_recovery_hashes.length, 10);
    assert.ok(row.totp_recovery_hashes.every((h: string) => /^[0-9a-f]{64}$/.test(h) && !codes.includes(h)));
    assert.deepEqual(await mfaStatus(ids.admin!), { enabled: true, enabledAt: (await mfaStatus(ids.admin!)).enabledAt, recoveryCodesLeft: 10 });
    await assert.rejects(beginEnrolment(ids.admin!, 'x'), /already on/, 'a session cannot replace a working secret');
  });

  test('a wrong code does not turn it on', async () => {
    await beginEnrolment(ids.fresh!, 'fresh@mfa.plugsure.test');
    await assert.rejects(confirmEnrolment(ids.fresh!, '000000', null), /not right/);
    assert.equal((await mfaStatus(ids.fresh!)).enabled, false);
  });
});

dbDescribe('signing in with two-step verification', () => {
  test('a right password gives a pending session that opens nothing but the code step', async () => {
    const r = await login('admin@mfa.plugsure.test', PW);
    assert.equal(r.ok, true);
    assert.equal(r.mfaRequired, true);
    const a = (await auth(r.token!)) as AuthResult;
    assert.equal(a.mfaPending, true);
    assert.equal(sessionHold(a, 'GET', '/v1/sites', 'x')?.body.code, 'mfa_required');
    assert.equal(sessionHold(a, 'GET', '/v1/auth/me', 'x')?.body.code, 'mfa_required');
    assert.equal(sessionHold(a, 'POST', '/v1/auth/mfa/verify', 'x'), null);
    assert.equal(sessionHold(a, 'POST', '/v1/auth/logout', 'x'), null);
    const exp = await one<{ mins: number }>(`SELECT extract(epoch FROM expires_at - now()) / 60 AS mins FROM auth_session WHERE id = $1`, [a.credentialId]);
    assert.ok(exp!.mins <= 5.1, 'a pending session lives five minutes');
  });

  test('the right code replaces the pending session with a full one; the same code again is refused (replay)', async () => {
    const T = T0 + 30_000; // the next step: the enrolment code used S0
    const first = await login('admin@mfa.plugsure.test', PW);
    const ok = await completeSignIn(ids.admin!, first.token!, codeAt('admin', S0 + 1), T);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(await auth(first.token!), null, 'the pending token is dead');
    const full = (await auth((ok as { token: string }).token)) as AuthResult;
    assert.equal(full.mfaPending, false);
    assert.equal(full.mfaEnrolmentRequired, false);
    assert.equal((await one<{ n: number }>(`SELECT failed_logins AS n FROM app_user WHERE id = $1`, [ids.admin]))!.n, 0);

    const second = await login('admin@mfa.plugsure.test', PW);
    const replay = await completeSignIn(ids.admin!, second.token!, codeAt('admin', S0 + 1), T);
    assert.equal(replay.ok, false);
    if (!replay.ok) assert.equal(replay.replay, true);
    const older = await completeSignIn(ids.admin!, second.token!, codeAt('admin', S0), T);
    assert.equal(older.ok, false, 'an older step is refused too');
    // Two concurrent uses of one fresh code: exactly one is accepted.
    const [a, b] = await Promise.all([checkSecondFactor(ids.admin!, codeAt('admin', S0 + 2), T + 30_000), checkSecondFactor(ids.admin!, codeAt('admin', S0 + 2), T + 30_000)]);
    assert.equal([a, b].filter((x) => x.ok).length, 1);
    await query(`UPDATE app_user SET failed_logins = 0 WHERE id = $1`, [ids.admin]);
  });

  test('only a pending session takes a code, and it turns into one full session at most', async () => {
    await query(`UPDATE app_user SET failed_logins = 0, locked_until = NULL WHERE id = $1`, [ids.admin]);
    const full = await createSession(ids.admin!);
    const r = await completeSignIn(ids.admin!, full, codeAt('admin', timeStep(Date.now()) + 1));
    assert.equal(r.ok, false, 'a full session has nothing to complete');
    assert.equal(await auth(full) !== null, true, 'and is left alone');
    const codes = await (async () => { await resetMfa(ids.admin!); return enrol('admin', T0); })();
    const p = await login('admin@mfa.plugsure.test', PW);
    const both = await Promise.all([completeSignIn(ids.admin!, p.token!, codes[0]!), completeSignIn(ids.admin!, p.token!, codes[1]!)]);
    assert.equal(both.filter((x) => x.ok).length, 1, 'two right answers racing on one pending session: one session');
    await query(`UPDATE app_user SET failed_logins = 0, locked_until = NULL WHERE id = $1`, [ids.admin]);
  });

  test('a recovery code signs in once', async () => {
    const codes = await (async () => {
      await resetMfa(ids.tech!);
      return enrol('tech', T0);
    })();
    const p1 = await login('tech@mfa.plugsure.test', PW);
    assert.equal(p1.mfaRequired, true);
    const r1 = await completeSignIn(ids.tech!, p1.token!, codes[3]!.toUpperCase());
    assert.equal(r1.ok, true, JSON.stringify(r1));
    if (r1.ok) { assert.equal(r1.method, 'recovery_code'); assert.equal(r1.recoveryCodesLeft, 9); }
    const p2 = await login('tech@mfa.plugsure.test', PW);
    const r2 = await completeSignIn(ids.tech!, p2.token!, codes[3]!);
    assert.equal(r2.ok, false, 'used once already');
    assert.equal((await mfaStatus(ids.tech!)).recoveryCodesLeft, 9);
    await query(`UPDATE app_user SET failed_logins = 0, locked_until = NULL WHERE id = $1`, [ids.tech]);
  });

  test('wrong codes count towards the sign-in lockout; the lock ends the pending session and refuses even the right code', async () => {
    await enrol('locky', T0);
    const p = await login('locky@mfa.plugsure.test', PW); // takes slot 1
    const results = [];
    for (let i = 0; i < config.console.loginMaxFailures - 1; i++) results.push(await completeSignIn(ids.locky!, p.token!, '000000', T0 + 30_000));
    assert.ok(results.every((r) => !r.ok));
    assert.equal((results.at(-1) as { locked?: boolean }).locked, true, 'the attempt that reaches LOGIN_MAX_FAILURES locks');
    assert.equal(await auth(p.token!), null, 'the pending session ended with the lock');
    const right = await completeSignIn(ids.locky!, p.token!, codeAt('locky', S0 + 1), T0 + 30_000);
    assert.equal(right.ok, false);
    const again = await login('locky@mfa.plugsure.test', PW);
    assert.equal(again.ok, false, 'and the password step is locked too');
  });

  test('a burst of wrong codes is counted, not raced past', async () => {
    await query(`UPDATE app_user SET failed_logins = 0, locked_until = NULL WHERE id = $1`, [ids.admin]);
    const p = await login('admin@mfa.plugsure.test', PW);
    await Promise.all(Array.from({ length: 30 }, (_, i) => completeSignIn(ids.admin!, p.token!, String(100000 + i))));
    const row = await one<{ locked: boolean }>(`SELECT (locked_until > now()) AS locked FROM app_user WHERE id = $1`, [ids.admin]);
    assert.equal(row!.locked, true);
    await query(`UPDATE app_user SET failed_logins = 0, locked_until = NULL WHERE id = $1`, [ids.admin]);
  });
});

dbDescribe('required for administrators, with an enrolment grace path', () => {
  test('an administrator without it may only enrol; others are not held; once enrolled the hold lifts', async () => {
    process.env.CONSOLE_MFA_REQUIRED = 'true';
    await resetMfa(ids.resetme!); // an ops manager: not an administrator
    const adminTok = await createSession(ids.fresh!);
    const a = (await auth(adminTok)) as AuthResult;
    assert.equal(a.mfaEnrolmentRequired, true);
    assert.equal(sessionHold(a, 'GET', '/v1/sites', 'x')?.body.code, 'mfa_enrolment_required');
    assert.equal(sessionHold(a, 'GET', '/v1/stream', 'x')?.body.code, 'mfa_enrolment_required');
    for (const [m, p] of [['GET', '/v1/auth/me'], ['GET', '/v1/meta'], ['POST', '/v1/auth/mfa/enrol'], ['POST', '/v1/auth/mfa/enrol/confirm'], ['POST', '/v1/auth/logout']]) {
      assert.equal(sessionHold(a, m!, p!, 'x'), null, `${m} ${p}`);
    }
    const ops = (await auth(await createSession(ids.resetme!))) as AuthResult;
    assert.equal(ops.mfaEnrolmentRequired, false, 'optional for a non-administrator role');

    process.env.CONSOLE_MFA_REQUIRED = 'false';
    assert.equal(((await auth(adminTok)) as AuthResult).mfaEnrolmentRequired, false, 'CONSOLE_MFA_REQUIRED=false makes it optional');
    process.env.CONSOLE_MFA_REQUIRED = 'true';

    await enrol('fresh', T0);
    // Enrolment ended the other (password-only) sessions; a new full one is not held.
    assert.equal(await auth(adminTok), null);
    assert.equal(((await auth(await createSession(ids.fresh!))) as AuthResult).mfaEnrolmentRequired, false);
  });

  test('a one-time password is replaced first, then enrolment', async () => {
    process.env.CONSOLE_MFA_REQUIRED = 'true';
    const tok = await createSession(ids.resetme!);
    await setUserRole(ids.resetme!, orgId, 'super_admin'); // promoted mid-session
    await query(`UPDATE app_user SET must_change_password = true WHERE id = $1`, [ids.resetme]);
    const a = (await auth(tok)) as AuthResult;
    assert.equal(sessionHold(a, 'POST', '/v1/auth/mfa/enrol', 'x')?.body.code, 'password_change_required');
    await query(`UPDATE app_user SET must_change_password = false WHERE id = $1`, [ids.resetme]);
    assert.equal(sessionHold((await auth(tok)) as AuthResult, 'GET', '/v1/sites', 'x')?.body.code, 'mfa_enrolment_required', 'promotion holds at the next request');
    await setUserRole(ids.resetme!, orgId, 'cpo_operations_manager');
  });
});

dbDescribe('CONSOLE_ADMIN_HOSTS', () => {
  test('host matching: empty allows any host; otherwise exact name, port and case ignored', () => {
    assert.equal(adminHostAllowed('portal.example.id', []), true);
    assert.equal(adminHostAllowed('Console.Example.ID:443', ['console.example.id']), true);
    assert.equal(adminHostAllowed('portal.example.id', ['console.example.id']), false);
    assert.equal(adminHostAllowed(undefined, ['console.example.id']), false);
  });

  test('an administrator is refused like a wrong password on another host; an ordinary user signs in', async () => {
    await query(`UPDATE app_user SET failed_logins = 0, locked_until = NULL WHERE org_id = $1`, [orgId]);
    const refused = await login('admin@mfa.plugsure.test', PW, undefined, null, { refuseAdministrators: true });
    const wrong = await login('admin@mfa.plugsure.test', 'nope', undefined, null);
    assert.equal(refused.ok, false);
    assert.equal(refused.error, wrong.error);
    const ops = await login('resetme@mfa.plugsure.test', PW, undefined, null, { refuseAdministrators: true });
    assert.equal(ops.ok, true);
  });

  test('an administrator\'s session is held on any other host', async () => {
    (config.console as { adminHosts: string[] }).adminHosts = ['console.example.id'];
    const a = (await auth(await createSession(ids.fresh!))) as AuthResult;
    assert.equal(sessionHold(a, 'GET', '/v1/sites', 'portal.example.id')?.body.code, 'admin_host_required');
    assert.equal(sessionHold(a, 'GET', '/v1/sites', 'console.example.id'), null);
    const ops = (await auth(await createSession(ids.resetme!))) as AuthResult;
    assert.equal(sessionHold(ops, 'GET', '/v1/sites', 'portal.example.id'), null);
  });
});

dbDescribe('an administrator\'s reset', () => {
  test('removes the secret and recovery codes and ends every session', async () => {
    await query(`UPDATE app_user SET failed_logins = 0, locked_until = NULL WHERE org_id = $1`, [orgId]);
    const tok = await createSession(ids.tech!);
    await resetMfa(ids.tech!);
    assert.deepEqual(await mfaStatus(ids.tech!), { enabled: false, enabledAt: null, recoveryCodesLeft: 0 });
    assert.equal(await auth(tok), null);
    const row = await one<any>(`SELECT totp_secret, totp_recovery_hashes FROM app_user WHERE id = $1`, [ids.tech]);
    assert.equal(row.totp_secret, null);
    assert.deepEqual(row.totp_recovery_hashes, []);
    const r = await login('tech@mfa.plugsure.test', PW);
    assert.equal(r.ok, true);
    assert.equal(r.mfaRequired, undefined, 'a password alone signs in again (optional for this role)');
  });
});
