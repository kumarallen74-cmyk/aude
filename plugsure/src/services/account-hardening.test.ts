import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { one, pool, query, withOrg } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { login, hashPassword, changePassword, createUser, resetPassword, ensureSystemRoles, EmailUnavailableError } from './users.js';
import { authenticate, createSession } from './auth.js';

/**
 * Console account hardening (migration 053, database-backed):
 *   · a password change ends the user's OTHER sessions and keeps the one that made it;
 *   · a one-time password expires after TEMP_PASSWORD_TTL_HOURS, and the refusal is the
 *     same generic answer as a wrong password;
 *   · a console session idle longer than SESSION_IDLE_MINUTES is refused;
 *   · an e-mail address taken in ANOTHER organisation is refused like one taken in this
 *     one (no 500), without aborting the request's transaction, and case-insensitively.
 *
 * Runs only against the disposable test database:
 *   DATABASE_URL=postgresql://postgres:…@127.0.0.1:5433/plugsure_audit_fix npx tsx --test …
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[account-hardening.test] SKIPPING database-backed suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUGS = ['acct-hardening-a', 'acct-hardening-b'];
const PW = 'Correct-Horse-2026!';
const NEXT = 'Battery-Staple-2026?';
let orgA = '';
let orgB = '';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const signedIn = (token: string) => authenticate(bearer(token)).then(() => true, () => false);

async function cleanup() {
  for (const slug of SLUGS) {
    const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [slug]);
    if (!org) continue;
    await query(`DELETE FROM user_role WHERE user_id IN (SELECT id FROM app_user WHERE org_id = $1)`, [org.id]);
    await query(`DELETE FROM app_user WHERE org_id = $1`, [org.id]);
  }
}

if (DB_OK) {
  before(async () => {
    await cleanup();
    await ensureSystemRoles();
    const mk = async (slug: string) =>
      (await one<{ id: string }>(
        `INSERT INTO organisation (name, slug) VALUES ($1, $1) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [slug]))!.id;
    orgA = await mk(SLUGS[0]!);
    orgB = await mk(SLUGS[1]!);
    await query(`INSERT INTO app_user (org_id, email, name, status, password_hash) VALUES ($1, 'ah-pw@plugsure.test', 'PW', 'active', $2)`, [orgA, await hashPassword(PW)]);
  });
  after(async () => { await cleanup(); await pool.end(); });
}

dbDescribe('a password change ends every other session of the account', () => {
  test('the session that changed it stays signed in; the others are revoked', async () => {
    const a = await login('ah-pw@plugsure.test', PW);
    const b = await login('ah-pw@plugsure.test', PW);
    assert.ok(a.ok && b.ok);
    assert.equal(await changePassword(a.user!.id, PW, NEXT, a.token), null);
    assert.equal(await signedIn(a.token!), true, 'the session making the change continues');
    assert.equal(await signedIn(b.token!), false, 'another session (perhaps the attacker\'s) ends');
    assert.equal((await login('ah-pw@plugsure.test', NEXT)).ok, true);
  });
});

dbDescribe('one-time passwords expire', () => {
  let userId = '';
  let temp = '';
  test('a fresh invitation signs in, and its expiry follows TEMP_PASSWORD_TTL_HOURS', async () => {
    process.env.TEMP_PASSWORD_TTL_HOURS = '5';
    try {
      const c = await createUser(orgA, { name: 'Invitee', email: 'ah-temp@plugsure.test', role: 'support_readonly' });
      userId = c.id;
      temp = c.temporaryPassword;
    } finally {
      delete process.env.TEMP_PASSWORD_TTL_HOURS;
    }
    const row = await one<{ hours: number }>(`SELECT extract(epoch FROM temp_password_expires_at - now()) / 3600 AS hours FROM app_user WHERE id = $1`, [userId]);
    assert.ok(Math.abs(Number(row!.hours) - 5) < 0.05, `expires in ~5 h, got ${row!.hours}`);
    const r = await login('ah-temp@plugsure.test', temp);
    assert.equal(r.ok, true);
    assert.equal(r.mustChangePassword, true);
  });
  test('an expired one is refused with the same answer as an unknown address', async () => {
    await query(`UPDATE app_user SET temp_password_expires_at = now() - interval '1 minute' WHERE id = $1`, [userId]);
    const r = await login('ah-temp@plugsure.test', temp);
    assert.equal(r.ok, false);
    assert.equal(r.error, (await login('ah-nobody@plugsure.test', 'x')).error);
  });
  test('a reset issues a new one with a new clock (default 72 h)', async () => {
    temp = await resetPassword(userId);
    const row = await one<{ hours: number }>(`SELECT extract(epoch FROM temp_password_expires_at - now()) / 3600 AS hours FROM app_user WHERE id = $1`, [userId]);
    assert.ok(Math.abs(Number(row!.hours) - 72) < 0.05, `expires in ~72 h, got ${row!.hours}`);
    assert.equal((await login('ah-temp@plugsure.test', temp)).ok, true);
  });
  test('choosing a real password clears the expiry; the real password never expires', async () => {
    assert.equal(await changePassword(userId, temp, NEXT, null), null);
    const row = await one<{ e: Date | null; m: boolean }>(`SELECT temp_password_expires_at AS e, must_change_password AS m FROM app_user WHERE id = $1`, [userId]);
    assert.equal(row!.e, null);
    assert.equal(row!.m, false);
  });
  test('a writer that sets must_change_password without an expiry (the seed) still gets one', async () => {
    await query(`UPDATE app_user SET password_hash = $2, must_change_password = true WHERE id = $1`, [userId, await hashPassword(PW)]);
    const row = await one<{ hours: number }>(`SELECT extract(epoch FROM temp_password_expires_at - now()) / 3600 AS hours FROM app_user WHERE id = $1`, [userId]);
    assert.ok(Math.abs(Number(row!.hours) - 72) < 0.05, `trigger default ~72 h, got ${row!.hours}`);
    // …and clearing the flag by hand (as the integrations e2e does) clears it.
    await query(`UPDATE app_user SET must_change_password = false WHERE id = $1`, [userId]);
    assert.equal((await one<{ e: Date | null }>(`SELECT temp_password_expires_at AS e FROM app_user WHERE id = $1`, [userId]))!.e, null);
  });
});

dbDescribe('idle console sessions are refused', () => {
  let userId = '';
  before(async () => {
    userId = (await one<{ id: string }>(`SELECT id FROM app_user WHERE email = 'ah-pw@plugsure.test'`))!.id;
  });
  const tokenHash = async (token: string) => {
    const secret = token.slice(token.indexOf('_') + 1);
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(secret, 'utf8').digest('hex');
  };
  test('idle longer than SESSION_IDLE_MINUTES (default 60): refused', async () => {
    const token = await createSession(userId);
    const h = await tokenHash(token);
    await query(`UPDATE auth_session SET last_seen_at = now() - interval '61 minutes' WHERE token_hash = $1`, [h]);
    assert.equal(await signedIn(token), false);
    process.env.SESSION_IDLE_MINUTES = '120';
    try {
      assert.equal(await signedIn(token), true, 'a longer configured idle window accepts it');
    } finally {
      delete process.env.SESSION_IDLE_MINUTES;
    }
  });
  test('use refreshes last_seen_at, at most once a minute', async () => {
    const token = await createSession(userId);
    const h = await tokenHash(token);
    await query(`UPDATE auth_session SET last_seen_at = now() - interval '30 seconds' WHERE token_hash = $1`, [h]);
    assert.equal(await signedIn(token), true);
    const fresh = await one<{ s: number }>(`SELECT extract(epoch FROM now() - last_seen_at) AS s FROM auth_session WHERE token_hash = $1`, [h]);
    assert.ok(Number(fresh!.s) >= 29, 'not rewritten within the minute');
    await query(`UPDATE auth_session SET last_seen_at = now() - interval '50 minutes' WHERE token_hash = $1`, [h]);
    assert.equal(await signedIn(token), true);
    const touched = await one<{ s: number }>(`SELECT extract(epoch FROM now() - last_seen_at) AS s FROM auth_session WHERE token_hash = $1`, [h]);
    assert.ok(Number(touched!.s) < 5, 'refreshed after a minute');
  });
});

dbDescribe('an e-mail address taken in another organisation', () => {
  test('is refused like a local duplicate, case-insensitively, and the request transaction survives', async () => {
    await createUser(orgA, { name: 'Taken', email: 'ah-taken@plugsure.test', role: 'support_readonly' });
    const made = await withOrg(orgB, async () => {
      await assert.rejects(
        createUser(orgB, { name: 'Other', email: 'AH-Taken@plugsure.test', role: 'support_readonly' }),
        (e) => e instanceof EmailUnavailableError,
      );
      // Not an aborted transaction: the same request can carry on and commit.
      return createUser(orgB, { name: 'Fine', email: 'ah-fine@plugsure.test', role: 'support_readonly' });
    });
    const row = await one<{ org_id: string }>(`SELECT org_id FROM app_user WHERE id = $1`, [made.id]);
    assert.equal(row?.org_id, orgB);
  });
  test('the database itself refuses a case variant (053 lower(email) index)', async () => {
    await assert.rejects(
      query(`INSERT INTO app_user (org_id, email, name) VALUES ($1, 'AH-TAKEN@plugsure.test', 'x')`, [orgB]),
      (e: any) => e.code === '23505',
    );
  });
});
