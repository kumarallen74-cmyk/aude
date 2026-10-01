import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { pool, query, tx } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import {
  writeAudit,
  writeAuditIn,
  verifyChain,
  canonicalJson,
  resolveAuditKey,
  advisoryLockKey,
  NIL_ORG,
  type AuditChainFinding,
  type AuditChainResult, jsonSafe } from './audit.js';

/**
 * Attack suite for the audit chain.
 *
 * Every test in "tampering" is a thing the security audit did (or a close
 * relative of it) that the v1 unkeyed chain reported as "intact". Each one must
 * now come back ok:false with a named finding.
 *
 * Run against the throwaway database only:
 *   DATABASE_URL=postgresql://postgres:plugsure@127.0.0.1:5432/plugsure_audit_fix \
 *     npx tsx --test src/services/audit.test.ts
 */

// beforeEach TRUNCATEs audit_log, so the database-backed suites run only
// against the disposable database and are skipped — never silently run —
// anywhere else. The pure suites at the bottom always run.
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) {
  console.warn(
    `[audit.test] SKIPPING the database-backed audit chain suites: DATABASE_URL is ` +
      `"${config.databaseUrl}", and these tests truncate audit_log. Re-run with ` +
      `DATABASE_URL=postgresql://postgres:plugsure@127.0.0.1:5432/plugsure_audit_fix`,
  );
}
const dbDescribe = DB_OK ? describe : describe.skip;
// One file at a time against the audit chain (src/db/test-lock.ts).
const dbLock = databaseTestLock('exclusive', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

let ORG_A = '';
let ORG_B = '';

interface RawRow {
  id: number;
  org_id: string | null;
  seq: number;
  prev_hash: string | null;
  hash: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  before_state: unknown;
  after_state: unknown;
}

async function rowsFor(orgId: string | null): Promise<RawRow[]> {
  const { rows } = await query<RawRow>(
    `SELECT id, org_id, seq, prev_hash, hash, actor_type, actor_id, action,
            target_type, target_id, before_state, after_state
       FROM audit_log WHERE org_key = $1 ORDER BY id`,
    [orgId ?? NIL_ORG],
  );
  return rows;
}

/** Append n plausible entries and return the resulting rows. */
async function appendEntries(orgId: string | null, n: number): Promise<RawRow[]> {
  for (let i = 0; i < n; i++) {
    await writeAudit({
      orgId,
      actorType: 'user',
      actorId: `operator-${i}`,
      action: 'refund.issued',
      targetType: 'payment',
      targetId: `pay-${i}`,
      after: { amountIdr: 5_000_000, reason: 'charger fault' },
      ip: '10.0.0.1',
      userAgent: 'console/1.0',
    });
  }
  return rowsFor(orgId);
}

function kinds(r: AuditChainResult): AuditChainFinding[] {
  return r.problems.map((p) => p.kind);
}

function assertDetects(r: AuditChainResult, kind: AuditChainFinding): void {
  assert.equal(r.ok, false, `expected the chain to be reported broken, got ok:true`);
  assert.ok(
    kinds(r).includes(kind),
    `expected finding "${kind}", got ${JSON.stringify(r.problems, null, 2)}`,
  );
}

/** The v1 hashed body: note it never covered ts, ip or user_agent. */
function v1Body(r: RawRow): string {
  return canonicalJson({
    orgId: r.org_id,
    actorType: r.actor_type,
    actorId: r.actor_id,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    before: r.before_state ?? null,
    after: r.after_state ?? null,
  });
}

/**
 * The v1 algorithm, reimplemented as the attacker's tool.
 *
 * This is precisely the capability the audit demonstrated: alter a row, then
 * recompute that row's hash and every forward hash so the chain is internally
 * consistent again. It needs no secret — which is exactly the finding.
 */
async function recomputeChainUnkeyed(orgId: string | null): Promise<void> {
  const rows = await rowsFor(orgId);
  let prev = '';
  for (const r of rows) {
    const hash = createHash('sha256').update(prev + v1Body(r)).digest('hex');
    await asSuperuserBypassingTriggers(`UPDATE audit_log SET prev_hash = $2, hash = $3 WHERE id = $1`, [r.id, prev, hash]);
    prev = hash;
  }
}

/**
 * Recompute only from `fromId` forward, leaving earlier rows' real (keyed)
 * hashes untouched. The subtler version of the same attack: the tampering
 * shows up exactly at the altered row rather than smearing over the whole log.
 */
async function recomputeForwardUnkeyed(orgId: string | null, fromId: number): Promise<void> {
  const rows = await rowsFor(orgId);
  const start = rows.findIndex((r) => r.id === fromId);
  assert.ok(start >= 0);
  let prev = rows[start]!.prev_hash ?? '';
  for (const r of rows.slice(start)) {
    const hash = createHash('sha256').update(prev + v1Body(r)).digest('hex');
    await asSuperuserBypassingTriggers(`UPDATE audit_log SET prev_hash = $2, hash = $3 WHERE id = $1`, [r.id, prev, hash]);
    prev = hash;
  }
}

/**
 * The v1 verifier, reimplemented so the tests can show what it used to answer.
 * It is the thing that said "intact" to a forged refund.
 */
async function v1VerifySaysIntact(orgId: string | null): Promise<boolean> {
  const rows = await rowsFor(orgId);
  let prev = '';
  for (const r of rows) {
    const expect = createHash('sha256').update(prev + v1Body(r)).digest('hex');
    if (expect !== r.hash || (r.prev_hash ?? '') !== prev) return false;
    prev = r.hash;
  }
  return true;
}

/**
 * What a database superuser can do that the application role cannot: run a
 * statement with every trigger switched off. The verifier must still catch it.
 *
 * Since migration 048 every UPDATE or DELETE of audit_log goes through here:
 * the runtime role holds neither privilege any more, and the
 * audit_log_append_only trigger refuses both for every role. The tampering
 * below is therefore what a SUPERUSER can still do (session_replication_role =
 * replica switches row triggers off) — the attacker the keyed chain exists for.
 */
async function asSuperuserBypassingTriggers(sql: string, params: unknown[] = []): Promise<void> {
  await tx(async (c) => {
    await c.query(`SET LOCAL session_replication_role = replica`);
    await c.query(sql, params);
  });
}

if (DB_OK) {  before(async () => {
    await asSuperuserBypassingTriggers(`DELETE FROM audit_log`);
    await query(`DELETE FROM organisation WHERE slug IN ('audit-test-a','audit-test-b')`);
    const a = await query<{ id: string }>(
      `INSERT INTO organisation (name, slug) VALUES ('Audit Test A','audit-test-a') RETURNING id`,
    );
    const b = await query<{ id: string }>(
      `INSERT INTO organisation (name, slug) VALUES ('Audit Test B','audit-test-b') RETURNING id`,
    );
    ORG_A = a.rows[0]!.id;
    ORG_B = b.rows[0]!.id;
  });

  /**
   * Back to genesis, in ONE transaction. Other test files run concurrently and write audit
   * entries (charger-ca.test.ts, for one). With the truncates as separate statements, an
   * entry committed between them left a log row whose head had been reset to 0, and every
   * later append for that organisation collided on audit_log_org_seq_uniq.
   */
  const resetChains = () => tx(async (c) => {
    // TRUNCATE, not DELETE: migration 004's audit_head_undeletable trigger (a row-level
    // BEFORE DELETE guard) refuses DELETE, and TRUNCATE is the owner-only reset it allows.
    await c.query(`TRUNCATE audit_log, audit_head RESTART IDENTITY`);
    // 002 seeds the platform chain's head row in its genesis state; restore it.
    await c.query(`INSERT INTO audit_head (org_id) VALUES ($1)`, [NIL_ORG]);
    // Since migration 004 every organisation owns a genesis head row from birth (a missing
    // one means tampering); restore them, as the organisation insert trigger created them.
    await c.query(`INSERT INTO audit_head (org_id, entries, last_hash, head_hash)
                   SELECT id, 0, '', '' FROM organisation ON CONFLICT (org_id) DO NOTHING`);
  });

  beforeEach(resetChains);

  after(async () => {
    await resetChains();
    await query(`DELETE FROM organisation WHERE slug IN ('audit-test-a','audit-test-b')`);
    await pool.end();
  });
}

// ───────────────────────────────────────────────────────────── happy path

dbDescribe('audit chain — normal operation', () => {
  test('an untouched chain of N entries verifies', async () => {
    await appendEntries(ORG_A, 5);
    const r = await verifyChain(ORG_A);
    assert.equal(r.ok, true, JSON.stringify(r.problems));
    assert.equal(r.entries, 5);
    assert.equal(r.expectedEntries, 5);
    assert.deepEqual(r.problems, []);
  });

  test('an org that has never been audited verifies as empty', async () => {
    const r = await verifyChain(ORG_B);
    assert.equal(r.ok, true);
    assert.equal(r.entries, 0);
  });

  test('sequence numbers are 1-based and gapless, and prev_hash links each row', async () => {
    const rows = await appendEntries(ORG_A, 4);
    assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3, 4]);
    assert.equal(rows[0]!.prev_hash, '');
    for (let i = 1; i < rows.length; i++) {
      assert.equal(rows[i]!.prev_hash, rows[i - 1]!.hash);
    }
  });

  test('audit_head tracks the terminal hash and the length', async () => {
    const rows = await appendEntries(ORG_A, 3);
    const head = await query<{ entries: number; last_hash: string; head_hash: string }>(
      `SELECT entries, last_hash, head_hash FROM audit_head WHERE org_id = $1`,
      [ORG_A],
    );
    assert.equal(head.rows[0]!.entries, 3);
    assert.equal(head.rows[0]!.last_hash, rows[2]!.hash);
    assert.notEqual(head.rows[0]!.head_hash, rows[2]!.hash, 'head MAC must not be a copy of the terminal hash');
  });

  test('the platform (NULL org) chain works and is keyed on the nil UUID', async () => {
    await appendEntries(null, 3);
    const r = await verifyChain(null);
    assert.equal(r.ok, true, JSON.stringify(r.problems));
    assert.equal(r.entries, 3);

    const head = await query<{ entries: number }>(
      `SELECT entries FROM audit_head WHERE org_id = $1`,
      [NIL_ORG],
    );
    assert.equal(head.rows[0]!.entries, 3, 'platform head is bookkept under the nil UUID');
    const stored = await query<{ org_id: string | null; org_key: string }>(
      `SELECT org_id, org_key FROM audit_log ORDER BY id LIMIT 1`,
    );
    assert.equal(stored.rows[0]!.org_id, null, 'org_id stays NULL: it is a FK to organisation');
    assert.equal(stored.rows[0]!.org_key, NIL_ORG, 'org_key is the derived chain partition');
  });
});

// ───────────────────────────────────────────────────────────── the attacks

dbDescribe('audit chain — tampering', () => {
  test('ATTACK: forge a refund and recompute every forward hash with the unkeyed algorithm', async () => {
    await appendEntries(ORG_A, 6);
    const rows = await rowsFor(ORG_A);
    const victim = rows[2]!;

    // The exact audit finding: 5,000,000 becomes 500.
    await asSuperuserBypassingTriggers(`UPDATE audit_log SET after_state = $2 WHERE id = $1`, [
      victim.id,
      JSON.stringify({ amountIdr: 500, reason: 'charger fault' }),
    ]);
    await recomputeChainUnkeyed(ORG_A);

    // The reproduction: under the old unkeyed algorithm this now verifies
    // perfectly, which is why the audit's forged refund passed.
    assert.equal(await v1VerifySaysIntact(ORG_A), true, 'the v1 chain is the attacker-repairable one');

    const r = await verifyChain(ORG_A);
    assertDetects(r, 'mutated');
    // Rewriting the whole chain unkeyed invalidates every row, so the first
    // failure is row 1, not the row the attacker cared about.
    assert.equal(r.problems.length >= 1, true);
    assert.ok(
      r.problems.some((p) => p.atId === victim.id),
      'the altered row is named among the problems',
    );
  });

  test('ATTACK: forge a refund and recompute only forward of it', async () => {
    await appendEntries(ORG_A, 6);
    const rows = await rowsFor(ORG_A);
    const victim = rows[2]!;

    await asSuperuserBypassingTriggers(`UPDATE audit_log SET after_state = $2 WHERE id = $1`, [
      victim.id,
      JSON.stringify({ amountIdr: 500, reason: 'charger fault' }),
    ]);
    await recomputeForwardUnkeyed(ORG_A, victim.id);

    const r = await verifyChain(ORG_A);
    assertDetects(r, 'mutated');
    assert.equal(r.brokenAtId, victim.id, 'points at the row that was altered');
  });

  test('ATTACK: mutate a row and leave the hashes alone', async () => {
    await appendEntries(ORG_A, 4);
    const rows = await rowsFor(ORG_A);
    const victim = rows[1]!;
    await asSuperuserBypassingTriggers(`UPDATE audit_log SET action = 'refund.voided' WHERE id = $1`, [victim.id]);

    const r = await verifyChain(ORG_A);
    assertDetects(r, 'mutated');
    assert.equal(r.brokenAtId, victim.id);
  });

  test('ATTACK: rewrite a timestamp (v1 never hashed ts)', async () => {
    await appendEntries(ORG_A, 3);
    const rows = await rowsFor(ORG_A);
    await asSuperuserBypassingTriggers(`UPDATE audit_log SET ts = ts - interval '30 days' WHERE id = $1`, [rows[1]!.id]);
    assertDetects(await verifyChain(ORG_A), 'mutated');
  });

  test('ATTACK: rewrite the source IP (v1 never hashed ip/user_agent)', async () => {
    await appendEntries(ORG_A, 3);
    const rows = await rowsFor(ORG_A);
    await asSuperuserBypassingTriggers(`UPDATE audit_log SET ip = '203.0.113.9' WHERE id = $1`, [rows[0]!.id]);
    assertDetects(await verifyChain(ORG_A), 'mutated');
  });

  test('ATTACK: delete the newest row (truncation — the case v1 could not see)', async () => {
    await appendEntries(ORG_A, 5);
    const rows = await rowsFor(ORG_A);
    await asSuperuserBypassingTriggers(`DELETE FROM audit_log WHERE id = $1`, [rows[4]!.id]);

    const r = await verifyChain(ORG_A);
    assertDetects(r, 'truncated');
    assert.equal(r.entries, 4);
    assert.equal(r.expectedEntries, 5);
  });

  test('ATTACK: delete the newest row AND rewrite audit_head to match', async () => {
    const rows = await appendEntries(ORG_A, 5);
    await asSuperuserBypassingTriggers(`DELETE FROM audit_log WHERE id = $1`, [rows[4]!.id]);
    // The attacker can read the surviving terminal hash out of audit_log, so a
    // head that merely copied it would be trivially repairable. The head MAC is
    // keyed, so this fails.
    // Layer 1 (migration 004): the database refuses to move the head backwards.
    await assert.rejects(
      query(`UPDATE audit_head SET entries = 4, last_hash = $2 WHERE org_id = $1`, [ORG_A, rows[3]!.hash]),
      /append-only/,
    );
    // Layer 2: a superuser who switches the triggers off is still caught by the keyed MAC.
    await asSuperuserBypassingTriggers(`UPDATE audit_head SET entries = 4, last_hash = $2 WHERE org_id = $1`, [
      ORG_A,
      rows[3]!.hash,
    ]);
    assertDetects(await verifyChain(ORG_A), 'head_mismatch');
  });

  test('ATTACK: a later legitimate append does not heal an earlier truncation', async () => {
    const rows = await appendEntries(ORG_A, 4);
    await asSuperuserBypassingTriggers(`DELETE FROM audit_log WHERE id = $1`, [rows[3]!.id]);
    await appendEntries(ORG_A, 1); // seq 5, not a reused seq 4

    const r = await verifyChain(ORG_A);
    assertDetects(r, 'deleted');
    assert.deepEqual((await rowsFor(ORG_A)).map((x) => x.seq), [1, 2, 3, 5]);
  });

  test('ATTACK: delete a middle row', async () => {
    await appendEntries(ORG_A, 5);
    const rows = await rowsFor(ORG_A);
    await asSuperuserBypassingTriggers(`DELETE FROM audit_log WHERE id = $1`, [rows[2]!.id]);

    const r = await verifyChain(ORG_A);
    assertDetects(r, 'deleted');
    assert.equal(r.problems.find((p) => p.kind === 'deleted')?.atSeq, 4);
  });

  test('ATTACK: delete a middle row and recompute the chain unkeyed', async () => {
    await appendEntries(ORG_A, 5);
    const rows = await rowsFor(ORG_A);
    await asSuperuserBypassingTriggers(`DELETE FROM audit_log WHERE id = $1`, [rows[2]!.id]);
    await recomputeChainUnkeyed(ORG_A);
    assertDetects(await verifyChain(ORG_A), 'deleted');
  });

  test('ATTACK: delete every row for an org', async () => {
    await appendEntries(ORG_A, 6);
    await asSuperuserBypassingTriggers(`DELETE FROM audit_log WHERE org_key = $1`, [ORG_A]);

    const r = await verifyChain(ORG_A);
    assertDetects(r, 'truncated');
    assert.equal(r.entries, 0);
    assert.equal(r.expectedEntries, 6);
  });

  test('ATTACK: delete the audit_head row for a chain that has entries', async () => {
    await appendEntries(ORG_A, 3);
    // Layer 1 (migration 004): head rows are undeletable.
    await assert.rejects(query(`DELETE FROM audit_head WHERE org_id = $1`, [ORG_A]), /permanent/);
    // Layer 2: with the triggers bypassed, the missing head is still detected.
    await asSuperuserBypassingTriggers(`DELETE FROM audit_head WHERE org_id = $1`, [ORG_A]);
    assertDetects(await verifyChain(ORG_A), 'missing_head');
  });

  test('ATTACK: insert a forged row with a plausible hash', async () => {
    const rows = await appendEntries(ORG_A, 3);
    const last = rows[2]!;
    const plausible = createHash('sha256').update(`${last.hash}forged`).digest('hex');
    await query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id,
                              after_state, seq, prev_hash, hash)
       VALUES ($1,'user','attacker','refund.issued','payment','pay-x',$2,$3,$4,$5)`,
      [ORG_A, JSON.stringify({ amountIdr: 1 }), last.seq + 1, last.hash, plausible],
    );

    const r = await verifyChain(ORG_A);
    assert.equal(r.ok, false);
    assert.ok(
      kinds(r).includes('forged_row') || kinds(r).includes('mutated'),
      `expected the forged row to be rejected, got ${JSON.stringify(r.problems)}`,
    );
    assert.equal(r.entries, 4);
    assert.equal(r.expectedEntries, 3, 'the head still knows only 3 entries were appended');
  });

  test('a forged row cannot reuse an existing sequence number', async () => {
    const rows = await appendEntries(ORG_A, 3);
    await assert.rejects(
      query(
        `INSERT INTO audit_log (org_id, actor_type, action, seq, prev_hash, hash)
         VALUES ($1,'user','refund.issued',$2,'','deadbeef')`,
        [ORG_A, rows[1]!.seq],
      ),
      /audit_log_org_seq_uniq|duplicate key/i,
    );
  });

  test('ATTACK: swap the ids of two rows (reordering)', async () => {
    await appendEntries(ORG_A, 4);
    const rows = await rowsFor(ORG_A);
    const a = rows[1]!.id;
    const b = rows[2]!.id;
    await asSuperuserBypassingTriggers(`UPDATE audit_log SET id = -1 WHERE id = $1`, [a]);
    await asSuperuserBypassingTriggers(`UPDATE audit_log SET id = $1 WHERE id = $2`, [a, b]);
    await asSuperuserBypassingTriggers(`UPDATE audit_log SET id = $1 WHERE id = -1`, [b]);

    assertDetects(await verifyChain(ORG_A), 'reordered');
  });

  test('ATTACK: move a platform entry into a tenant chain by flipping org_id', async () => {
    await appendEntries(ORG_A, 2);
    await appendEntries(null, 3);
    const platform = await rowsFor(null);

    // org_key is GENERATED ALWAYS from org_id, so the row changes chain the
    // moment org_id changes. If the destination already occupies that seq the
    // unique index refuses the move outright.
    await assert.rejects(
      asSuperuserBypassingTriggers(`UPDATE audit_log SET org_id = $2 WHERE id = $1`, [platform[1]!.id, ORG_A]),
      /audit_log_org_seq_uniq|duplicate key/i,
      'a colliding move is rejected by the per-chain sequence index',
    );

    // Moving the platform's seq-3 row into ORG_A (which only has seq 1..2)
    // collides with nothing, so the verifier has to catch it.
    await asSuperuserBypassingTriggers(`UPDATE audit_log SET org_id = $2 WHERE id = $1`, [platform[2]!.id, ORG_A]);

    const src = await verifyChain(null);
    const dst = await verifyChain(ORG_A);
    assertDetects(src, 'truncated');
    assert.equal(dst.ok, false, 'destination chain gained an alien row');
    assert.ok(
      kinds(dst).some((k) => k === 'forged_row' || k === 'mutated'),
      `expected the alien row to be rejected, got ${JSON.stringify(dst.problems)}`,
    );
  });
});

// ───────────────────────────────────────────────────── concurrency & isolation

dbDescribe('audit chain — concurrency and isolation', () => {
  test('20 concurrent appends all land, the chain verifies, and the head agrees', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        writeAudit({
          orgId: ORG_A,
          actorType: 'api_client',
          actorId: `client-${i}`,
          action: 'ocpp.RemoteStopTransaction',
          targetType: 'charge_point',
          targetId: `CP-${i}`,
          after: { connectorId: i },
        }),
      ),
    );

    const rows = await rowsFor(ORG_A);
    assert.equal(rows.length, 20, 'no append was lost or overwritten');
    assert.deepEqual(rows.map((r) => r.seq).sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => i + 1));

    const r = await verifyChain(ORG_A);
    assert.equal(r.ok, true, JSON.stringify(r.problems));

    const head = await query<{ entries: number }>(
      `SELECT entries FROM audit_head WHERE org_id = $1`,
      [ORG_A],
    );
    assert.equal(head.rows[0]!.entries, 20);
    assert.equal(r.entries, r.expectedEntries);
  });

  test('two orgs keep independent chains that do not interfere', async () => {
    await Promise.all([
      appendEntries(ORG_A, 5),
      appendEntries(ORG_B, 7),
      appendEntries(null, 3),
    ]);

    const a = await verifyChain(ORG_A);
    const b = await verifyChain(ORG_B);
    const p = await verifyChain(null);
    assert.equal(a.ok, true, JSON.stringify(a.problems));
    assert.equal(b.ok, true, JSON.stringify(b.problems));
    assert.equal(p.ok, true, JSON.stringify(p.problems));
    assert.deepEqual([a.entries, b.entries, p.entries], [5, 7, 3]);

    // Breaking A must not implicate B or the platform chain.
    const rows = await rowsFor(ORG_A);
    await asSuperuserBypassingTriggers(`DELETE FROM audit_log WHERE id = $1`, [rows[4]!.id]);
    assert.equal((await verifyChain(ORG_A)).ok, false);
    assert.equal((await verifyChain(ORG_B)).ok, true);
    assert.equal((await verifyChain(null)).ok, true);
  });

  test('two chains use distinct 64-bit advisory lock keys', () => {
    const ka = BigInt(advisoryLockKey(ORG_A));
    const kb = BigInt(advisoryLockKey(ORG_B));
    assert.notEqual(ka, kb);
    // v1 truncated to 32 bits; the high half must actually carry entropy.
    const wide = [ORG_A, ORG_B, null, NIL_ORG].some(
      (o) => BigInt.asUintN(64, BigInt(advisoryLockKey(o))) >> 32n !== 0n,
    );
    assert.ok(wide, 'lock keys should use more than the low 32 bits');
  });
});

// ──────────────────────────────────────────────── transactional participation

dbDescribe('audit chain — transactional append', () => {
  test('writeAuditIn commits with the action it records', async () => {
    await tx(async (c) => {
      await c.query(`UPDATE organisation SET pkp = true WHERE id = $1`, [ORG_A]);
      await writeAuditIn(c, {
        orgId: ORG_A,
        actorType: 'user',
        actorId: 'operator-1',
        action: 'organisation.pkp.enabled',
        targetType: 'organisation',
        targetId: ORG_A,
        after: { pkp: true },
      });
    });

    const r = await verifyChain(ORG_A);
    assert.equal(r.ok, true, JSON.stringify(r.problems));
    assert.equal(r.entries, 1);
  });

  test('writeAuditIn rolls back with the action, leaving no orphan entry or head drift', async () => {
    await appendEntries(ORG_A, 2);
    await assert.rejects(
      tx(async (c) => {
        await writeAuditIn(c, {
          orgId: ORG_A,
          actorType: 'user',
          action: 'organisation.deleted',
          targetType: 'organisation',
          targetId: ORG_A,
        });
        throw new Error('the audited action failed');
      }),
      /the audited action failed/,
    );

    const r = await verifyChain(ORG_A);
    assert.equal(r.ok, true, 'a rolled-back action leaves the chain consistent');
    assert.equal(r.entries, 2);
    assert.equal(r.expectedEntries, 2, 'the head rolled back with the entry');
  });
});

// ──────────────────────────────────────────────────────── keying and encoding

describe('audit keying', () => {
  test('an empty HMAC key outside development throws a clear startup error', () => {
    for (const env of ['production', 'staging', 'test']) {
      assert.throws(
        () => resolveAuditKey(env, ''),
        (e: unknown) => e instanceof Error && /AUDIT_HMAC_KEY/.test(e.message),
        `env=${env} must refuse an empty key`,
      );
    }
  });

  test('a configured key is used verbatim, and development falls back deterministically', () => {
    assert.deepEqual(resolveAuditKey('production', 's3cret'), Buffer.from('s3cret', 'utf8'));
    const d1 = resolveAuditKey('development', '');
    const d2 = resolveAuditKey('development', '');
    assert.deepEqual(d1, d2, 'the dev key must be stable across restarts or old chains stop verifying');
    assert.notDeepEqual(d1, resolveAuditKey('development', 's3cret'));
  });

  test('canonicalJson stays key-order independent', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    assert.equal(canonicalJson({ a: [{ y: 1, x: 2 }] }), canonicalJson({ a: [{ x: 2, y: 1 }] }));
    assert.equal(canonicalJson(null), 'null');
    assert.equal(canonicalJson(undefined), 'null');
  });
});

describe('audit body normalisation', () => {
  test('an undefined property does not desynchronise the MAC from the row', () => {
    // canonicalJson maps undefined -> null, but JSON.stringify DROPS the key on
    // the way into JSONB. The MAC was therefore computed over a body the
    // database never stored, and verification reported `mutated` forever. One
    // POST /v1/api-keys with the optional `name` omitted was enough to mark a
    // tenant's entire audit log broken.
    const withUndefined = { name: undefined, prefix: 'abc', permissions: ['org:read'] };
    const normalised = jsonSafe(withUndefined);

    // What the database will hold, byte for byte.
    const stored = JSON.parse(JSON.stringify(normalised));
    assert.equal(
      canonicalJson(normalised),
      canonicalJson(stored),
      'the hashed body must survive a round trip through JSONB unchanged',
    );
    assert.ok(!Object.keys(normalised as object).includes('name'));
  });

  test('null and undefined both normalise to null', () => {
    assert.equal(jsonSafe(undefined), null);
    assert.equal(jsonSafe(null), null);
  });

  test('nested undefined properties are stripped too', () => {
    const v = jsonSafe({ a: 1, b: { c: undefined, d: 2 }, e: [1, undefined, 3] });
    assert.deepEqual(v, { a: 1, b: { d: 2 }, e: [1, null, 3] });
    assert.equal(canonicalJson(v), canonicalJson(JSON.parse(JSON.stringify(v))));
  });
});
