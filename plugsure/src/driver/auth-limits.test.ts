import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { hashPassword } from '../services/users.js';
import Fastify from 'fastify';
import { fleetLogin, issueDevice, sendOtp, verifyOtp, FLEET_LOGIN_FAILED } from './identity.js';
import { registerDriverApi } from './server.js';

/**
 * The driver app's unauthenticated sign-in steps under a parallel burst
 * (database-backed). Each check here failed on v1.3.0:
 *   - an OTP's five-guess limit was read, compared, then incremented, so a burst
 *     compared every guess against one code, and a code could sign in twice;
 *   - a fleet PIN's lock was checked before scrypt and `read + 1` written back, so
 *     a burst recorded one failure and never locked the card;
 *   - the one-code-a-minute throttle was written after the send, so a burst of
 *     sends for one number all went out; and there was no per-address or global cap.
 *
 *   DATABASE_URL=postgresql://…/plugsure_audit_fix NODE_ENV=test npx tsx --test src/driver/auth-limits.test.ts
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[auth-limits.test] SKIPPING database-backed suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'auth-limits-test';
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
let orgId = '';
let deviceId = '';
const phones: string[] = [];
/** A fresh +62 number per test, so runs never share counters. */
const newPhone = () => {
  const p = `+62857${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  phones.push(p);
  return p;
};
const ENV = ['DRIVER_OTP_PER_IP_PER_HOUR', 'DRIVER_OTP_GLOBAL_PER_DAY', 'DRIVER_OTP_VERIFY_FAILURES_PER_DAY', 'DRIVER_PIN_FAILURES_PER_IP_PER_HOUR'];

async function cleanup(): Promise<void> {
  const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (org) {
    await query(`DELETE FROM driver_device WHERE fleet_token_id IN (SELECT id FROM token WHERE org_id = $1)`, [org.id]);
    await query(`DELETE FROM token WHERE org_id = $1`, [org.id]);
  }
  if (phones.length) {
    await query(`DELETE FROM driver_otp WHERE phone = ANY($1)`, [phones]);
    await query(`UPDATE driver_device SET app_driver_id = NULL WHERE app_driver_id IN (SELECT id FROM app_driver WHERE phone = ANY($1))`, [phones]);
    await query(`DELETE FROM app_driver WHERE phone = ANY($1)`, [phones]);
    await query(`DELETE FROM driver_auth_limit WHERE split_part(key, ':', 2) = ANY($1)`, [phones]);
  }
  await query(`DELETE FROM driver_auth_limit WHERE key LIKE '%:198.51.100.%'`);
  // Card budgets are keyed by what was typed (organisation slug + serial), not by the row.
  await query(`DELETE FROM driver_auth_limit WHERE key LIKE 'pin-card:${SLUG}:%' OR key LIKE 'pin-card:no-such-org-auth-limits:%'`);
}

/** A live code for `phone` whose value we know, without going through the sender. */
async function plantCode(phone: string, code: string): Promise<void> {
  await query(`INSERT INTO driver_otp (phone, code_hash, expires_at) VALUES ($1, $2, now() + interval '5 minutes')`, [phone, sha256(code)]);
}

if (DB_OK) {
  before(async () => {
    await cleanup();
    orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug) VALUES ('Auth Limits Test', $1)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [SLUG],
    ))!.id;
    deviceId = (await issueDevice('auth-limits.test')).deviceId;
  });
  afterEach(() => { for (const k of ENV) delete process.env[k]; });
  after(async () => {
    await cleanup();
    await query(`DELETE FROM driver_device WHERE id = $1`, [deviceId]);
    await pool.end();
  });
}

dbDescribe('OTP verification under a parallel burst', () => {
  test('a burst of 60 wrong guesses gets five comparisons, and the right code is then refused', async () => {
    const phone = newPhone();
    await plantCode(phone, '424242');
    const guesses = Array.from({ length: 60 }, (_, i) => String(100000 + i));
    const rs = await Promise.all(guesses.map((g) => verifyOtp(deviceId, phone, g)));
    const compared = rs.filter((r) => !r.ok && r.error === 'Kode salah. Coba lagi.').length;
    assert.ok(compared <= 5, `${compared} guesses were compared against one code`);
    const row = await one<{ attempts: number }>(`SELECT attempts FROM driver_otp WHERE phone = $1`, [phone]);
    assert.equal(row!.attempts, 5);
    const right = await verifyOtp(deviceId, phone, '424242');
    assert.equal(right.ok, false);
  });

  test('two concurrent right answers sign in once', async () => {
    const phone = newPhone();
    await plantCode(phone, '135791');
    const rs = await Promise.all(Array.from({ length: 8 }, () => verifyOtp(deviceId, phone, '135791')));
    assert.equal(rs.filter((r) => r.ok).length, 1);
  });

  test('a new code does not reset the number: 10 wrong codes a day from one device, then no verifying or sending for it', async () => {
    const phone = newPhone();
    for (let i = 0; i < 2; i++) {
      await plantCode(phone, '999999');
      for (let j = 0; j < 5; j++) assert.equal((await verifyOtp(deviceId, phone, '000000')).ok, false);
      await query(`UPDATE driver_otp SET consumed_at = now() WHERE phone = $1`, [phone]);
    }
    await plantCode(phone, '777777');
    const r = await verifyOtp(deviceId, phone, '777777');
    assert.equal(r.ok, false);
    if (!r.ok) { assert.match(r.error, /besok/); assert.equal(r.limited, true); }
    const s = await sendOtp(phone, undefined, { ip: '198.51.100.9', deviceId });
    assert.equal(s.ok, false);
    if (!s.ok) assert.equal(s.limited, true);
  });

  test('a right code gives back its slot of the daily budget', async () => {
    process.env.DRIVER_OTP_VERIFY_FAILURES_PER_DAY = '2';
    const phone = newPhone();
    for (let i = 0; i < 4; i++) {
      await plantCode(phone, '246802');
      assert.equal((await verifyOtp(deviceId, phone, '246802')).ok, true, `sign-in ${i + 1}`);
    }
  });
});

dbDescribe('OTP sending: limits are claimed before the send', () => {
  test('a burst of sends for one number sends one code', async () => {
    const phone = newPhone();
    const rs = await Promise.all(Array.from({ length: 20 }, () => sendOtp(phone, undefined, { ip: '198.51.100.1' })));
    assert.equal(rs.filter((r) => r.ok).length, 1);
    assert.ok(rs.filter((r) => !r.ok).every((r) => !r.ok && r.limited && /Tunggu sebentar/.test(r.error)));
    const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM driver_otp WHERE phone = $1`, [phone]);
    assert.equal(n!.n, 1);
  });

  test('per address: a burst over different numbers stops at the limit', async () => {
    process.env.DRIVER_OTP_PER_IP_PER_HOUR = '3';
    const rs = await Promise.all(Array.from({ length: 12 }, () => sendOtp(newPhone(), undefined, { ip: '198.51.100.2' })));
    assert.equal(rs.filter((r) => r.ok).length, 3);
    assert.ok(rs.filter((r) => !r.ok).every((r) => !r.ok && r.limited));
    // Another address is not affected.
    assert.equal((await sendOtp(newPhone(), undefined, { ip: '198.51.100.3' })).ok, true);
  });

  test('installation-wide daily cap', async () => {
    await query(`DELETE FROM driver_auth_limit WHERE key = 'otp-global'`);
    process.env.DRIVER_OTP_GLOBAL_PER_DAY = '2';
    try {
      const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => sendOtp(newPhone(), undefined, { ip: `198.51.100.${10 + i}` })));
      assert.equal(rs.filter((r) => r.ok).length, 2);
    } finally {
      await query(`DELETE FROM driver_auth_limit WHERE key = 'otp-global'`);
    }
  });

  test('the development code still comes back, and verifies', async () => {
    const phone = newPhone();
    const s = await sendOtp(phone, undefined, { ip: '198.51.100.4', deviceId });
    assert.equal(s.ok, true);
    assert.match(String(s.ok && s.devCode), /^\d{6}$/);
    assert.equal((await verifyOtp(deviceId, phone, (s as { devCode: string }).devCode)).ok, true);
  });
});

dbDescribe('fleet PIN under a parallel burst', () => {
  test('a burst of 30 wrong PINs locks the card; the right PIN is then refused', async () => {
    await query(`INSERT INTO token (org_id, kind, uid, status, pin_hash) VALUES ($1, 'rfid', 'BURST-01', 'Accepted', $2)`, [orgId, await hashPassword('482913')]);
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => fleetLogin(deviceId, SLUG, 'BURST-01', String(100000 + i))));
    assert.ok(rs.every((r) => !r.ok));
    const t = await one<{ locked: boolean }>(`SELECT (pin_locked_until > now()) AS locked FROM token WHERE org_id = $1 AND uid = 'BURST-01'`, [orgId]);
    assert.equal(t!.locked, true);
    const right = await fleetLogin(deviceId, SLUG, 'BURST-01', '482913');
    assert.equal(right.ok, false);
    // Locked answers exactly like a wrong PIN: the lock must not mark the card as real.
    if (!right.ok) assert.equal(right.error, FLEET_LOGIN_FAILED);
  });

  test('a right PIN clears the counter', async () => {
    await query(`INSERT INTO token (org_id, kind, uid, status, pin_hash) VALUES ($1, 'rfid', 'RESET-01', 'Accepted', $2)`, [orgId, await hashPassword('112233')]);
    for (let i = 0; i < 4; i++) assert.equal((await fleetLogin(deviceId, SLUG, 'RESET-01', '000000')).ok, false);
    assert.equal((await fleetLogin(deviceId, SLUG, 'RESET-01', '112233')).ok, true);
    for (let i = 0; i < 4; i++) assert.equal((await fleetLogin(deviceId, SLUG, 'RESET-01', '000000')).ok, false);
    assert.equal((await fleetLogin(deviceId, SLUG, 'RESET-01', '112233')).ok, true);
  });

  test('per card: a daily attempt budget across addresses and lock windows; a right PIN gives its slot back', async () => {
    process.env.DRIVER_PIN_ATTEMPTS_PER_CARD_PER_DAY = '6';
    try {
      await query(`INSERT INTO token (org_id, kind, uid, status, pin_hash) VALUES ($1, 'rfid', 'CARD-DAY-01', 'Accepted', $2)`, [orgId, await hashPassword('909090')]);
      assert.equal((await fleetLogin(deviceId, SLUG, 'CARD-DAY-01', '909090', '198.51.100.70')).ok, true);
      for (let i = 0; i < 4; i++) assert.equal((await fleetLogin(deviceId, SLUG, 'CARD-DAY-01', '000000', `198.51.100.${71 + i}`)).ok, false);
      // Lift the 15-minute lock as if it had expired: only the daily budget is left to stop the next guesses.
      await query(`UPDATE token SET pin_failures = 0, pin_locked_until = NULL WHERE org_id = $1 AND uid = 'CARD-DAY-01'`, [orgId]);
      assert.equal((await fleetLogin(deviceId, SLUG, 'CARD-DAY-01', '000000', '198.51.100.80')).ok, false);
      assert.equal((await fleetLogin(deviceId, SLUG, 'CARD-DAY-01', '000000', '198.51.100.81')).ok, false);
      const r = await fleetLogin(deviceId, SLUG, 'CARD-DAY-01', '909090', '198.51.100.82');
      assert.equal(r.ok, false, 'six attempts used today: even the right PIN waits until tomorrow');
      if (!r.ok) { assert.equal(r.limited, true); assert.match(r.error, /kartu ini hari ini/); }
    } finally {
      delete process.env.DRIVER_PIN_ATTEMPTS_PER_CARD_PER_DAY;
    }
  });

  test('per address: wrong PINs across many cards stop at the limit; a right PIN costs nothing', async () => {
    process.env.DRIVER_PIN_FAILURES_PER_IP_PER_HOUR = '3';
    const ip = '198.51.100.50';
    await query(`INSERT INTO token (org_id, kind, uid, status, pin_hash) VALUES ($1, 'rfid', 'IPOK-01', 'Accepted', $2)`, [orgId, await hashPassword('555666')]);
    for (let i = 0; i < 3; i++) assert.equal((await fleetLogin(deviceId, SLUG, 'IPOK-01', '555666', ip)).ok, true);
    for (let i = 0; i < 3; i++) {
      const r = await fleetLogin(deviceId, SLUG, `NOPE-${i}`, '000000', ip);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.limited, undefined);
    }
    const r = await fleetLogin(deviceId, SLUG, 'IPOK-01', '555666', ip);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.limited, true);
  });
});

dbDescribe('driver API: limits answer 429; OCPI response_url never from the Host header', () => {
  test('roaming commands are refused outside development when OCPI_PUBLIC_URL is unset, whatever the Host says', async () => {
    const app = Fastify();
    await registerDriverApi(app);
    const { deviceToken } = await issueDevice('auth-limits.test');
    const saved = { env: config.env, url: config.ocpi.publicUrl };
    try {
      (config as { env: string }).env = 'production';
      (config.ocpi as { publicUrl: string }).publicUrl = '';
      const body = { partnerId: 'p', countryCode: 'ID', partyId: 'XYZ', locationId: 'L1', evseUid: 'E1' };
      for (const url of ['/d/v1/roaming/charge', '/d/v1/roaming/reservations', '/d/v1/roaming/charge/00000000-0000-0000-0000-000000000000/stop']) {
        const r = await app.inject({ method: 'POST', url, payload: body, headers: { authorization: `Bearer ${deviceToken}`, host: 'evil.example', 'x-forwarded-host': 'evil.example' } });
        assert.equal(r.statusCode, 503, url);
        assert.equal(r.json().code, 'ocpi_url_not_configured');
      }
    } finally {
      (config as { env: string }).env = saved.env;
      (config.ocpi as { publicUrl: string }).publicUrl = saved.url;
      await query(`DELETE FROM driver_device WHERE device_hash = $1`, [sha256(deviceToken.slice(4))]);
      await app.close();
    }
  });

  test('a send refused for a limit is 429 with the Indonesian message', async () => {
    const app = Fastify();
    await registerDriverApi(app);
    const { deviceToken } = await issueDevice('auth-limits.test');
    try {
      const phone = newPhone();
      const send = () => app.inject({ method: 'POST', url: '/d/v1/otp/send', payload: { phone }, headers: { authorization: `Bearer ${deviceToken}` } });
      assert.equal((await send()).statusCode, 200);
      const again = await send();
      assert.equal(again.statusCode, 429);
      assert.match(again.json().error, /Tunggu sebentar/);
    } finally {
      await query(`DELETE FROM driver_device WHERE device_hash = $1`, [sha256(deviceToken.slice(4))]);
      await app.close();
    }
  });
});

dbDescribe('a stranger who knows a driver\'s number cannot lock it out (codes are bound to the requesting device)', () => {
  test('ten wrong guesses from another device leave the driver\'s own device able to ask for and use a code', async () => {
    const phone = newPhone();
    const attacker = (await issueDevice('auth-limits.test attacker')).deviceId;
    try {
      // The attacker asks for codes for the victim's number and guesses wrong, ten times.
      for (let i = 0; i < 2; i++) {
        await query(`INSERT INTO driver_otp (phone, code_hash, expires_at, device_id) VALUES ($1, $2, now() + interval '5 minutes', $3)`, [phone, sha256('999999'), attacker]);
        for (let j = 0; j < 5; j++) assert.equal((await verifyOtp(attacker, phone, '000000')).ok, false);
        await query(`UPDATE driver_otp SET consumed_at = now() WHERE phone = $1`, [phone]);
      }
      const locked = await verifyOtp(attacker, phone, '000000');
      assert.equal(locked.ok, false);
      if (!locked.ok) assert.equal(locked.limited, true, 'the attacker\'s own device is out of guesses');

      // The driver's device asks for a code and signs in.
      const s = await sendOtp(phone, undefined, { ip: '198.51.100.90', deviceId });
      assert.equal(s.ok, true, JSON.stringify(s));
      const v = await verifyOtp(deviceId, phone, (s as { devCode: string }).devCode);
      assert.equal(v.ok, true, JSON.stringify(v));
    } finally {
      await query(`DELETE FROM driver_otp WHERE device_id = $1`, [attacker]);
      await query(`DELETE FROM driver_device WHERE id = $1`, [attacker]);
    }
  });

  test('a code can be verified only by the device that asked for it', async () => {
    const phone = newPhone();
    const other = (await issueDevice('auth-limits.test other')).deviceId;
    try {
      const s = await sendOtp(phone, undefined, { ip: '198.51.100.91', deviceId });
      assert.equal(s.ok, true);
      const code = (s as { devCode: string }).devCode;
      const stolen = await verifyOtp(other, phone, code);
      assert.equal(stolen.ok, false, 'the right code from another device is not accepted');
      const row = await one<{ attempts: number }>(`SELECT attempts FROM driver_otp WHERE phone = $1`, [phone]);
      assert.equal(row!.attempts, 0, 'and it did not spend one of the code\'s five attempts');
      assert.equal((await verifyOtp(deviceId, phone, code)).ok, true);
    } finally {
      await query(`DELETE FROM driver_device WHERE id = $1`, [other]);
    }
  });
});

dbDescribe('fleet sign-in gives one answer for every failure', () => {
  test('unknown organisation, unknown, blocked, expired and unactivated card, and wrong PIN answer the same', async () => {
    const pin = await hashPassword('314159');
    await query(`INSERT INTO token (org_id, kind, uid, status, pin_hash) VALUES ($1, 'rfid', 'UNI-OK-01', 'Accepted', $2)`, [orgId, pin]);
    await query(`INSERT INTO token (org_id, kind, uid, status, pin_hash) VALUES ($1, 'rfid', 'UNI-BLK-01', 'Blocked', $2)`, [orgId, pin]);
    await query(`INSERT INTO token (org_id, kind, uid, status, pin_hash, valid_to) VALUES ($1, 'rfid', 'UNI-EXP-01', 'Accepted', $2, now() - interval '1 day')`, [orgId, pin]);
    await query(`INSERT INTO token (org_id, kind, uid, status) VALUES ($1, 'rfid', 'UNI-NOPIN-01', 'Accepted')`, [orgId]);
    const rs = await Promise.all([
      fleetLogin(deviceId, 'no-such-org-auth-limits', 'UNI-OK-01', '314159'),
      fleetLogin(deviceId, SLUG, 'UNI-NOPE-01', '314159'),
      fleetLogin(deviceId, SLUG, 'UNI-BLK-01', '314159'),
      fleetLogin(deviceId, SLUG, 'UNI-EXP-01', '314159'),
      fleetLogin(deviceId, SLUG, 'UNI-NOPIN-01', '314159'),
      fleetLogin(deviceId, SLUG, 'UNI-OK-01', '000000'),
    ]);
    for (const r of rs) {
      assert.equal(r.ok, false);
      if (!r.ok) { assert.equal(r.error, FLEET_LOGIN_FAILED); assert.equal(r.limited, undefined); }
    }
    assert.equal((await fleetLogin(deviceId, SLUG, 'UNI-OK-01', '314159')).ok, true);
  });

  test('a made-up card runs out of its daily attempts exactly like a real one', async () => {
    process.env.DRIVER_PIN_ATTEMPTS_PER_CARD_PER_DAY = '3';
    try {
      await query(`INSERT INTO token (org_id, kind, uid, status, pin_hash) VALUES ($1, 'rfid', 'UNI-DAY-01', 'Accepted', $2)`, [orgId, await hashPassword('271828')]);
      const run = async (uid: string) => {
        const out = [];
        for (let i = 0; i < 4; i++) out.push(await fleetLogin(deviceId, SLUG, uid, '000000', `198.51.100.${120 + i}`));
        return out.map((r) => (r.ok ? 'ok' : `${r.limited ? 'limited' : 'refused'}:${r.error}`));
      };
      assert.deepEqual(await run('UNI-DAY-01'), await run('UNI-DAY-FAKE-01'));
    } finally {
      delete process.env.DRIVER_PIN_ATTEMPTS_PER_CARD_PER_DAY;
    }
  });
});
