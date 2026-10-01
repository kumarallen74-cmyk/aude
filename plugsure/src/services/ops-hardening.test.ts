import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import pino from 'pino';
import { config } from '../config.js';
import { pool, query, one } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { REDACT_PATHS, censor } from '../logger.js';
import { decisionFrom, takeKeyToken, TokenBuckets } from './ratelimit.js';
import { runRetention } from './retention.js';
import { listAttempts, attemptStats, identitySeenUnregistered } from './connections.js';
import { MultipartFileStream, streamMultipartFile } from '../api/multipart-stream.js';

/**
 * Operations hardening (v1.3 ops pass): log redaction, the shared API-key rate
 * limiter, retention of the diagnostic logs, tenant-bounded connection history,
 * and streamed multipart diagnostics uploads. Database-backed tests run only
 * against the disposable database (plugsure_audit_fix).
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
const dbTest = DB_OK ? test : test.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);
after(() => (DB_OK ? pool.end() : undefined));

// ─────────────────────────────────────────────── logger redaction

function capture() {
  const lines: any[] = [];
  const sink = new Writable({ write(chunk, _e, cb) { lines.push(JSON.parse(String(chunk))); cb(); } });
  return { log: pino({ redact: { paths: REDACT_PATHS, censor } }, sink), lines };
}

test('logs: secrets vanish, driver identifiers keep only their last four characters', () => {
  const { log, lines } = capture();
  log.info({ cp: 'CP-1', idTag: '04A2B3C4D5E6F7', status: 'Accepted' }, 'Authorize');
  log.info({ uid: 'DEADBEEF1234', partner: 'X' }, 'roaming');
  log.info({ emaid: 'IDPLGC000012345', phone: '+6281234567890' }, 'pnc');
  log.info({ cp: 'CP-1', idToken: { idToken: 'AABBCCDDEEFF', type: 'ISO14443' } }, 'Authorize (2.0.1)');
  log.info({ password: 'hunter2hunter2', token: 'abc', req: { headers: { authorization: 'Bearer psk_x', cookie: 'sid=1' } } }, 'oops');
  log.info({ key: 'HeartbeatInterval', cp: 'CP-1' }, 'config key');
  assert.equal(lines[0].idTag, '***E6F7');
  assert.equal(lines[0].cp, 'CP-1');
  assert.equal(lines[1].uid, '***1234');
  assert.equal(lines[2].emaid, '***2345');
  assert.equal(lines[2].phone, '***7890');
  assert.equal(lines[3].idToken.idToken, '***EEFF', 'the token inside an OCPP 2.0.1 IdTokenType');
  assert.equal(lines[4].password, '[Redacted]');
  assert.equal(lines[4].token, '[Redacted]');
  assert.equal(lines[4].req.headers.authorization, '[Redacted]');
  assert.equal(lines[4].req.headers.cookie, '[Redacted]');
  assert.equal(lines[5].key, 'HeartbeatInterval', 'configuration key NAMES are not secrets');
  assert.ok(!JSON.stringify(lines).includes('04A2B3C4D5'));
});

// ─────────────────────────────────────────────── rate limits

test('rate limit: the shared bucket\'s state gives the same headers as the in-process one', () => {
  const b = new TokenBuckets();
  const t0 = 1_000_000;
  for (let i = 0; i < 10; i++) b.take('k', 10, t0);
  const mem = b.take('k', 10, t0);
  assert.deepEqual(decisionFrom(10, false, 0), mem);
  assert.deepEqual(decisionFrom(20, true, 19), { allowed: true, limit: 20, remaining: 19, resetS: 3, retryAfterS: 0 });
});

test('rate limit: sharing off uses the in-process bucket', async () => {
  const d = await takeKeyToken('not-a-uuid-key', 5, false);
  assert.equal(d.allowed, true);
  assert.equal(d.remaining, 4);
});

async function fixtureOrg(slug: string) {
  return (await one<{ id: string }>(
    `INSERT INTO organisation (name, slug) VALUES ($1, $1) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [slug]))!.id;
}

dbTest('rate limit: the shared bucket gives a key its limit ACROSS processes, atomically', async () => {
  const orgId = await fixtureOrg('ops-hardening-ratelimit');
  const key = (await one<{ id: string }>(
    `INSERT INTO api_key (org_id, name, prefix, key_hash) VALUES ($1, 'ops test', $2, 'x') RETURNING id`,
    [orgId, `psk_t${Date.now().toString(36)}`]))!.id;
  try {
    // 30 concurrent requests against a limit of 20 (as if from several API processes).
    const ds = await Promise.all(Array.from({ length: 30 }, () => takeKeyToken(key, 20, true)));
    assert.equal(ds.filter((d) => d.allowed).length, 20, 'exactly the limit, no more');
    const refused = ds.find((d) => !d.allowed)!;
    assert.equal(refused.remaining, 0);
    assert.ok(refused.retryAfterS >= 1 && refused.retryAfterS <= 3, `20 a minute refills one every 3 s (${refused.retryAfterS})`);
    // A raised limit applies at once, as in the in-process bucket.
    const raised = await takeKeyToken(key, 1200, true);
    assert.equal(raised.allowed, true);
    assert.equal(raised.limit, 1200);
    assert.ok(raised.remaining >= 1100);
    // A database failure falls back to the in-process bucket (fail open).
    const bogus = await takeKeyToken('00000000-0000-0000-0000-000000000000', 7, true);
    assert.equal(bogus.allowed, true, 'FK violation -> per-process bucket');
    assert.equal(bogus.limit, 7);
  } finally {
    await query(`DELETE FROM api_key WHERE id = $1`, [key]);
  }
  assert.equal((await one(`SELECT 1 FROM api_key_rate_bucket WHERE api_key_id = $1`, [key])), null, 'bucket goes with its key');
});

// ─────────────────────────────────────────────── retention

dbTest('retention: old frames and attempts are deleted in batches; recent ones and other tables stay', async () => {
  const tag = `RET-${Date.now().toString(36)}`;
  const DAY = 86_400_000;
  // Far older than any real row in the test database, so only ours qualify.
  const ancient = new Date(Date.now() - 4000 * DAY);
  const recent = new Date(Date.now() - 1 * DAY);
  await query(
    `INSERT INTO ocpp_frame (ocpp_identity, ts, direction, message_type, action, payload)
     SELECT $1, CASE WHEN g <= 25 THEN $2::timestamptz ELSE $3::timestamptz END, 'in', 2, 'Heartbeat', '{}'::jsonb
       FROM generate_series(1, 30) g`,
    [tag, ancient, recent]);
  await query(
    `INSERT INTO connection_attempt (ocpp_identity, ts, outcome)
     SELECT $1, CASE WHEN g <= 12 THEN $2::timestamptz ELSE $3::timestamptz END, 'rejected_unknown_cp'
       FROM generate_series(1, 15) g`,
    [tag, ancient, recent]);
  try {
    const r = await runRetention({ ocppFrameDays: 3000, connectionAttemptDays: 3000, batchRows: 4, pauseMs: 0 });
    assert.equal(r.incomplete, false);
    const left = await one<{ f: number; a: number }>(
      `SELECT (SELECT count(*)::int FROM ocpp_frame WHERE ocpp_identity = $1) AS f,
              (SELECT count(*)::int FROM connection_attempt WHERE ocpp_identity = $1) AS a`, [tag]);
    assert.deepEqual(left, { f: 5, a: 3 });
    // 0 keeps a table forever.
    await query(`UPDATE ocpp_frame SET ts = $2 WHERE ocpp_identity = $1`, [tag, ancient]);
    await runRetention({ ocppFrameDays: 0, connectionAttemptDays: 0, pauseMs: 0 });
    assert.equal((await one<{ n: number }>(`SELECT count(*)::int AS n FROM ocpp_frame WHERE ocpp_identity = $1`, [tag]))!.n, 5);
    // A time budget stops a pass part way; the next pass continues.
    const partial = await runRetention({ ocppFrameDays: 3000, connectionAttemptDays: 0, batchRows: 1, pauseMs: 0, maxPassMs: 0 });
    assert.equal(partial.incomplete, true);
  } finally {
    await query(`DELETE FROM ocpp_frame WHERE ocpp_identity = $1`, [tag]);
    await query(`DELETE FROM connection_attempt WHERE ocpp_identity = $1`, [tag]);
  }
});

// ─────────────────────────────────────────────── connection history per tenant

dbTest('connection history: a tenant sees attempts only from when the identity became its own', async () => {
  const ident = `HIST-${Date.now().toString(36)}`;
  const orgId = await fixtureOrg('ops-hardening-history');
  const siteId = (await one<{ id: string }>(`INSERT INTO site (org_id, name) VALUES ($1, 'History test') RETURNING id`, [orgId]))!.id;
  try {
    // The charger knocked while it was unregistered (another operator's, perhaps)...
    await query(`INSERT INTO connection_attempt (ocpp_identity, ts, outcome, remote_ip) VALUES ($1, now() - interval '2 days', 'rejected_unknown_cp', '198.51.100.7')`, [ident]);
    assert.equal((await identitySeenUnregistered(ident)).attempts, 1);
    assert.equal((await identitySeenUnregistered(`${ident}-never`)).attempts, 0);
    // ...then this tenant registered it.
    await query(`INSERT INTO charge_point (site_id, ocpp_identity, adopted_at) VALUES ($1, $2, now() - interval '1 hour')`, [siteId, ident]);
    await query(`INSERT INTO connection_attempt (ocpp_identity, ts, outcome) VALUES ($1, now(), 'accepted_pending_adoption')`, [ident]);
    const seen = await listAttempts({ identity: ident, orgId });
    assert.deepEqual(seen.map((r: any) => r.outcome), ['accepted_pending_adoption'], 'the pre-registration attempt is not the tenant\'s');
    assert.equal((await listAttempts({ identity: ident })).length, 2, 'the platform view is unchanged');
    const stats = await attemptStats(3 * 24 * 60, orgId);
    assert.equal(Number(stats.rejected), 0);
  } finally {
    await query(`DELETE FROM connection_attempt WHERE ocpp_identity = $1`, [ident]);
    await query(`DELETE FROM charge_point WHERE ocpp_identity = $1`, [ident]);
    await query(`DELETE FROM site WHERE id = $1`, [siteId]);
  }
});

// ─────────────────────────────────────────────── streamed multipart uploads

const B = '----plugsureBoundary7MA4YWxk';
const body = (file: Buffer) => Buffer.concat([
  Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n`),
  Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="diag-2026.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n`),
  file,
  Buffer.from(`\r\n--${B}--\r\n`),
]);
async function collect(r: Readable) { const parts: Buffer[] = []; for await (const c of r) parts.push(c as Buffer); return Buffer.concat(parts); }

test('multipart: the file part streams out byte-exact, whatever the chunking', async () => {
  // Bytes that look like CRLF and partial boundaries must survive.
  const file = Buffer.concat([Buffer.from('line1\r\n--not-the-boundary\r\n'), Buffer.from([0, 1, 2, 13, 10, 45, 45]), Buffer.alloc(3000, 0x41)]);
  const whole = body(file);
  for (const size of [1, 2, 7, 64, 1000, whole.length]) {
    const chunks: Buffer[] = [];
    for (let i = 0; i < whole.length; i += size) chunks.push(whole.subarray(i, i + size));
    const out = await streamMultipartFile(Readable.from(chunks), `multipart/form-data; boundary=${B}`, 1 << 20);
    assert.equal(out.fileName, 'diag-2026.tar.gz');
    assert.ok((await collect(out)).equals(file), `chunk size ${size}`);
  }
});

test('multipart: no file part, no boundary, or an oversized body is refused (400)', async () => {
  const noFile = Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="x"\r\n\r\ny\r\n--${B}--\r\n`);
  await assert.rejects(streamMultipartFile(Readable.from([noFile]), `multipart/form-data; boundary=${B}`, 1 << 20), (e: any) => e.statusCode === 400);
  await assert.rejects(streamMultipartFile(Readable.from([noFile]), 'multipart/form-data', 1 << 20), (e: any) => e.statusCode === 400);
  const big = new MultipartFileStream(B, 100);
  const out = Readable.from([body(Buffer.alloc(500, 1))]).pipe(big);
  await assert.rejects(collect(out), (e: any) => e.statusCode === 400 && /limit/.test(e.message));
});

test('multipart: a consumer that gives up early leaves no paused request behind (shutdown would hang)', async () => {
  const chunks = [body(Buffer.alloc(200_000, 7))];
  const src = Readable.from(chunks.flatMap((c) => Array.from({ length: Math.ceil(c.length / 1000) }, (_, i) => c.subarray(i * 1000, (i + 1) * 1000))));
  const out = await streamMultipartFile(src, `multipart/form-data; boundary=${B}`, 1 << 20);
  out.destroy(); // e.g. saveStream's size cap
  await new Promise<void>((resolve) => src.once('end', resolve));
  assert.equal(src.readableEnded, true, 'the rest of the body was read and discarded');
});
