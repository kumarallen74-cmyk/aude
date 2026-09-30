import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { query, tx } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Append-only, KEYED hash-chained audit log.
 *
 * Every entry commits — under HMAC-SHA256 with a server-held key — to
 *
 *     (previous entry's hash, canonical(entry), per-org sequence number)
 *
 * and every append transactionally advances a per-org `audit_head` row that
 * records how long the chain is and a keyed MAC over its terminal state.
 *
 * Why all three parts:
 *
 *   * KEYED, because a plain SHA-256 chain is a checksum, not evidence. Anyone
 *     with UPDATE on audit_log could alter a row and recompute every forward
 *     hash. A red-team pass did exactly that — a refund of 5,000,000 was
 *     rewritten to 500 — and the old verifyChain still answered "intact".
 *   * SEQUENCE NUMBER, because a hash chain has no idea what its own length is.
 *     Deleting the newest row leaves a shorter but perfectly self-consistent
 *     chain. Seq turns a deletion into a gap, and reordering into a descending
 *     step, both of which are covered by the MAC and so cannot be repaired.
 *   * HEAD, because even a gapless chain cannot prove nothing was cut from its
 *     tail. `audit_head.entries` is monotonic — it is never recomputed from
 *     audit_log — so a truncation is a permanent length mismatch, and a later
 *     legitimate append reopens it as a seq gap rather than papering over it.
 *
 * Retained 7 years and exportable by the tenant. Every remote command issued to
 * a charger goes through here with its actor: when a driver calls to ask why
 * their session stopped, support answers in one query.
 */
export interface AuditEntry {
  orgId?: string | null;
  actorType: 'user' | 'api_client' | 'system' | 'charge_point';
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Chain partition key for platform-level (NULL org) entries.
 *
 * `audit_log.org_id` is a FK to organisation and stays NULL for platform
 * events; `audit_head.org_id` is a primary key and cannot be. The generated
 * column `audit_log.org_key = COALESCE(org_id, NIL_ORG)` reconciles them, so
 * chain selection and head bookkeeping use one and the same key: one chain per
 * tenant plus exactly one platform chain. See db/migrations/003.
 */
export const NIL_ORG = '00000000-0000-0000-0000-000000000000';

/** Domain separator. Bump if the hashed body ever changes shape. */
const CHAIN_VERSION = 2;

/** Any pg client — a pooled client inside a caller's transaction, or the pool. */
export type AuditClient = pg.ClientBase;

/**
 * Canonical JSON: keys sorted at every level.
 *
 * This matters. Postgres JSONB does not preserve key order, so hashing
 * `JSON.stringify(obj)` on write and `JSON.stringify(rowFromDb)` on verify
 * produces different digests for identical data and every chain check fails.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`).join(',')}}`;
}

// ───────────────────────────────────────────────────────────────────── keying

/**
 * Resolve the audit HMAC key for an environment. Exported so the refusal is
 * directly testable without re-importing the module under a forged NODE_ENV.
 *
 * Outside development an empty key is fatal: running unkeyed would silently
 * downgrade the log to the checksum the audit already broke.
 */
export function resolveAuditKey(env: string, key: string): Buffer {
  if (key.length > 0) return Buffer.from(key, 'utf8');
  if (env !== 'development') {
    throw new Error(
      'AUDIT_HMAC_KEY is empty. The audit log chain is keyed (HMAC-SHA256); without a key ' +
        'it is only a checksum and anyone who can write to audit_log can forge it. ' +
        `Set AUDIT_HMAC_KEY to a high-entropy secret (e.g. \`openssl rand -hex 32\`) before starting in NODE_ENV=${env}.`,
    );
  }
  // Development only: a deterministic key so `npm test` and a restarted dev
  // server can still verify chains written by the previous run.
  return createHash('sha256').update('plugsure.audit.dev-key.v2').digest();
}

let cachedKey: Buffer | null = null;
let warnedAboutDevKey = false;

function auditKey(): Buffer {
  if (cachedKey) return cachedKey;
  const key = resolveAuditKey(config.env, config.security.auditHmacKey);
  if (config.security.auditHmacKey.length === 0 && !warnedAboutDevKey) {
    warnedAboutDevKey = true;
    logger.warn(
      '════════════════════════════════════════════════════════════════════\n' +
        ' AUDIT_HMAC_KEY is not set. Using a WELL-KNOWN development key.\n' +
        ' The audit chain is NOT tamper-evident in this process. Never run\n' +
        ' this configuration anywhere real; startup refuses it outside\n' +
        ' NODE_ENV=development.\n' +
        '════════════════════════════════════════════════════════════════════',
    );
  }
  cachedKey = key;
  return key;
}

/**
 * Call once at process start so a missing key fails loudly at boot rather than
 * at the first audited action. Safe to call repeatedly.
 */
export function assertAuditKeyConfigured(): void {
  auditKey();
}

function hmacHex(...parts: string[]): string {
  const h = createHmac('sha256', auditKey());
  for (const p of parts) h.update(p);
  return h.digest('hex');
}

/** Constant-time hex compare; avoids leaking a valid prefix to a probing writer. */
function hashesEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ─────────────────────────────────────────────────────────────── chain hashes

interface ChainBody {
  orgKey: string;
  orgId: string | null;
  ts: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  userAgent: string | null;
}

/**
 * The entry MAC. Every mutable column of the row is inside it — including `ts`,
 * `ip` and `user_agent`, which the v1 chain left uncovered, so an entry's
 * timestamp or source address could be rewritten undetected.
 *
 * The tuple is canonical-JSON encoded rather than concatenated, so no field can
 * be shifted into another (a `prev_hash` of ''+seq '12' vs '1'+'2').
 */
function entryHash(prevHash: string, seq: number, body: ChainBody): string {
  return hmacHex(
    canonicalJson({ v: CHAIN_VERSION, kind: 'entry', prev: prevHash, seq, entry: body }),
  );
}

/**
 * The head MAC. Deliberately NOT a copy of the terminal entry's hash: that
 * value is sitting in audit_log for the attacker to read, so a plain copy would
 * let anyone who truncates the tail rewrite a consistent head. This requires
 * the key.
 */
function headHash(orgKey: string, entries: number, lastHash: string): string {
  return hmacHex(
    canonicalJson({ v: CHAIN_VERSION, kind: 'head', orgKey, entries, last: lastHash }),
  );
}

function chainKeyFor(orgId: string | null | undefined): string {
  return orgId ?? NIL_ORG;
}

/**
 * Advisory lock key for a chain, using the full signed 64 bits Postgres allows.
 *
 * v1 took `readInt32BE(0)` — 32 bits — so two unrelated tenants had a ~1-in-4bn
 * chance per pair of serialising against each other for no reason. Passed as a
 * decimal string because node-pg has no native BigInt binding for int8.
 */
export function advisoryLockKey(orgId: string | null): string {
  const h = createHash('sha256').update(`plugsure.audit.chain.v2:${chainKeyFor(orgId)}`).digest();
  return h.readBigInt64BE(0).toString();
}

/**
 * Round-trip a value through the exact transformation Postgres JSONB applies, so
 * the hashed body and the stored body can never disagree. Undefined-valued keys
 * disappear, and so does anything else JSON.stringify refuses to represent.
 */
export function jsonSafe(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  const s = JSON.stringify(v);
  return s === undefined ? null : JSON.parse(s);
}

function bodyFrom(e: {
  orgId: string | null;
  ts: Date;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  userAgent: string | null;
}): ChainBody {
  return {
    orgKey: chainKeyFor(e.orgId),
    orgId: e.orgId,
    ts: e.ts.toISOString(),
    actorType: e.actorType,
    actorId: e.actorId,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId,
    // NORMALISED to what Postgres will actually store.
    //
    // canonicalJson maps an `undefined` property to `null`, so the MAC was
    // computed over `{"name":null}`. JSON.stringify then DROPS that key on the
    // way into JSONB, so verification read back `{}` and recomputed a different
    // MAC — and the row was reported `mutated` forever. An ordinary
    // `POST /v1/api-keys` with the optional `name` omitted was enough to mark a
    // tenant's whole seven-year audit log "broken", which is worse than useless:
    // it trains an operator to ignore the one alarm that matters.
    before: jsonSafe(e.before),
    after: jsonSafe(e.after),
    ip: e.ip,
    userAgent: e.userAgent,
  };
}

// ──────────────────────────────────────────────────────────────────── writing

/**
 * Append an entry using a caller-supplied transaction.
 *
 * Use this whenever the audited action is itself a database change: the entry
 * commits or rolls back with the action, so an action can never succeed with
 * its audit record lost (or vice versa). v1 opened its own transaction
 * unconditionally, which made exactly that split possible.
 */
export async function writeAuditIn(c: AuditClient, e: AuditEntry): Promise<void> {
  const orgId = e.orgId ?? null;
  const orgKey = chainKeyFor(orgId);

  // Transaction-scoped advisory lock per chain. Without it two concurrent
  // appends read the same predecessor and the chain forks. It is released at
  // COMMIT/ROLLBACK of the caller's transaction.
  await c.query('SELECT pg_advisory_xact_lock($1::bigint)', [advisoryLockKey(orgId)]);

  // The head — not the table — is the authority on where the chain is. Reading
  // MAX(seq) from audit_log instead would let a truncation heal itself: delete
  // row N, append, and the new row would take seq N and chain onto N-1 as if
  // nothing had happened. `entries` only ever goes up.
  const headRow = await c.query<{ entries: number; last_hash: string }>(
    `SELECT entries, last_hash FROM audit_head WHERE org_id = $1 FOR UPDATE`,
    [orgKey],
  );
  const prevEntries = headRow.rows[0]?.entries ?? 0;
  const prevHash = headRow.rows[0]?.last_hash ?? '';
  const seq = prevEntries + 1;

  const ts = new Date();
  const body = bodyFrom({
    orgId,
    ts,
    actorType: e.actorType,
    actorId: e.actorId ?? null,
    action: e.action,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    // NORMALISED to what Postgres will actually store.
    //
    // canonicalJson maps an `undefined` property to `null`, so the MAC was
    // computed over `{"name":null}`. JSON.stringify then DROPS that key on the
    // way into JSONB, so verification read back `{}` and recomputed a different
    // MAC — and the row was reported `mutated` forever. An ordinary
    // `POST /v1/api-keys` with the optional `name` omitted was enough to mark a
    // tenant's whole seven-year audit log "broken", which is worse than useless:
    // it trains an operator to ignore the one alarm that matters.
    before: jsonSafe(e.before),
    after: jsonSafe(e.after),
    ip: e.ip ?? null,
    userAgent: e.userAgent ?? null,
  });
  const hash = entryHash(prevHash, seq, body);

  await c.query(
    `INSERT INTO audit_log (org_id, ts, actor_type, actor_id, action, target_type, target_id,
                            before_state, after_state, ip, user_agent, seq, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      orgId,
      ts,
      body.actorType,
      body.actorId,
      body.action,
      body.targetType,
      body.targetId,
      // The SAME normalised value that went into the MAC.
      body.before === null ? null : JSON.stringify(body.before),
      body.after === null ? null : JSON.stringify(body.after),
      body.ip,
      body.userAgent,
      seq,
      prevHash,
      hash,
    ],
  );

  await c.query(
    `INSERT INTO audit_head (org_id, entries, last_hash, head_hash, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (org_id) DO UPDATE
       SET entries = EXCLUDED.entries,
           last_hash = EXCLUDED.last_hash,
           head_hash = EXCLUDED.head_hash,
           updated_at = now()`,
    [orgKey, seq, hash, headHash(orgKey, seq, hash)],
  );
}

/**
 * Append an entry in its own transaction.
 *
 * Convenience wrapper for callers with nothing to join. If the audited action
 * touches the database, prefer `writeAuditIn` inside that action's transaction.
 */
export async function writeAudit(e: AuditEntry): Promise<void> {
  await tx((c) => writeAuditIn(c, e));
}

// ──────────────────────────────────────────────────────────────── verification

export type AuditChainFinding =
  /** A row's contents no longer match the MAC it carries — with or without a recomputed chain. */
  | 'mutated'
  /** A row's prev_hash does not name its predecessor: something was spliced. */
  | 'broken_link'
  /** A row exists that was never appended by this service. */
  | 'forged_row'
  /** A gap in the sequence: an entry was deleted from the middle. */
  | 'deleted'
  /** Fewer rows survive than the head says were appended: the tail was cut. */
  | 'truncated'
  /** Sequence order disagrees with id order: rows were swapped or reinserted. */
  | 'reordered'
  /** The head row for a non-empty chain is gone. */
  | 'missing_head'
  /** The head row was rewritten, or does not describe the chain that is present. */
  | 'head_mismatch';

export interface AuditChainProblem {
  kind: AuditChainFinding;
  /** audit_log.id the problem is anchored to, when determinable. */
  atId?: number;
  /** Chain position the problem is anchored to, when determinable. */
  atSeq?: number;
  detail: string;
}

export interface AuditChainResult {
  ok: boolean;
  /** Rows actually present for this chain. */
  entries: number;
  /** Entries the head says were ever appended. Monotonic; never recomputed from the rows. */
  expectedEntries: number;
  /** Everything the verifier could name, earliest first. */
  problems: AuditChainProblem[];
  /** First failing row id, for callers that only render one. Kept from the v1 shape. */
  brokenAtId?: number;
}

interface AuditRow {
  id: number;
  org_id: string | null;
  ts: Date;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  before_state: unknown;
  after_state: unknown;
  ip: string | null;
  user_agent: string | null;
  seq: number;
  prev_hash: string | null;
  hash: string;
}

/**
 * Verify an organisation's chain. `null` verifies the platform (nil-org) chain.
 *
 * Detects, and names: mutation of a row (whether or not the forward hashes were
 * recomputed), deletion of any row including the newest, deletion of the whole
 * chain, insertion of a forged row, reordering, and tampering with the head
 * record itself.
 */
export async function verifyChain(orgId: string | null): Promise<AuditChainResult> {
  const orgKey = chainKeyFor(orgId);

  const [rowsRes, headRes] = await Promise.all([
    query<AuditRow>(
      `SELECT id, org_id, ts, actor_type, actor_id, action, target_type, target_id,
              before_state, after_state, ip, user_agent, seq, prev_hash, hash
         FROM audit_log WHERE org_key = $1 ORDER BY id`,
      [orgKey],
    ),
    query<{ entries: number; last_hash: string; head_hash: string }>(
      `SELECT entries, last_hash, head_hash FROM audit_head WHERE org_id = $1`,
      [orgKey],
    ),
  ]);

  const rows = rowsRes.rows;
  const head = headRes.rows[0];
  const problems: AuditChainProblem[] = [];

  /**
   * A missing head row is ALWAYS tampering now.
   *
   * It used to mean "this org has simply never been audited", so deleting an
   * org's audit_log rows AND its audit_head row — the most complete possible
   * destruction of the evidence — was the one state that verified clean. Since
   * migration 004 every organisation gets a genesis head row the moment it is
   * created, by trigger, so its absence cannot be innocent.
   */
  if (!head) {
    const orgExists =
      orgId === null
        ? true // the platform chain's head is seeded by migration 002
        : ((await query(`SELECT 1 FROM organisation WHERE id = $1`, [orgId])).rowCount ?? 0) > 0;
    if (!orgExists && rows.length === 0) {
      return { ok: true, entries: 0, expectedEntries: 0, problems: [] };
    }
    if (rows.length === 0) {
      return {
        ok: false,
        entries: 0,
        expectedEntries: 0,
        problems: [
          {
            kind: 'missing_head',
            detail:
              `org ${orgKey} exists but has neither audit rows nor an audit_head row. ` +
              `Every organisation is created with a genesis head, so this chain was erased ` +
              `in full, head included.`,
          },
        ],
      };
    }
    problems.push({
      kind: 'missing_head',
      atId: rows[0]?.id,
      detail: `${rows.length} audit rows exist for org ${orgKey} but its audit_head row is gone; the expected length and terminal hash cannot be checked.`,
    });
  }

  const expectedEntries = head?.entries ?? 0;

  // A head row that has never been advanced (entries 0, no terminal hash) is
  // the genesis state — 002 seeds exactly this for the platform chain. There is
  // nothing to MAC yet, so an empty chain with an empty head verifies.
  if (head && rows.length === 0 && expectedEntries === 0 && head.last_hash === '') {
    return { ok: true, entries: 0, expectedEntries: 0, problems: [] };
  }

  // Walk in id order. Sequence numbers must run 1..n with no gaps and in the
  // same order as the ids, and each row must reproduce its own MAC.
  let prevHash = '';
  let expectSeq = 1;
  let lastSeq = 0;
  for (const r of rows) {
    if (r.seq !== expectSeq) {
      if (r.seq > expectSeq) {
        problems.push({
          kind: 'deleted',
          atId: r.id,
          atSeq: r.seq,
          detail: `sequence jumps from ${expectSeq - 1} to ${r.seq}: ${r.seq - expectSeq} entr${r.seq - expectSeq === 1 ? 'y was' : 'ies were'} deleted before row ${r.id}.`,
        });
      } else {
        problems.push({
          kind: 'reordered',
          atId: r.id,
          atSeq: r.seq,
          detail: `row ${r.id} carries sequence ${r.seq} but ${expectSeq} was due: rows are out of order or duplicated.`,
        });
      }
    }
    if (r.seq <= lastSeq) {
      problems.push({
        kind: 'reordered',
        atId: r.id,
        atSeq: r.seq,
        detail: `sequence ${r.seq} appears at row id ${r.id}, after sequence ${lastSeq}; id order and chain order disagree.`,
      });
    }

    const body = bodyFrom({
      orgId: r.org_id,
      ts: r.ts instanceof Date ? r.ts : new Date(r.ts),
      actorType: r.actor_type,
      actorId: r.actor_id,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      before: r.before_state ?? null,
      after: r.after_state ?? null,
      ip: r.ip,
      userAgent: r.user_agent,
    });

    // Check against the hash the row itself claims to chain onto, so a row
    // whose contents were rewritten is distinguishable from one that was
    // spliced into the wrong place.
    const selfConsistent = hashesEqual(entryHash(r.prev_hash ?? '', r.seq, body), r.hash);
    const linked = hashesEqual(r.prev_hash ?? '', prevHash);

    if (!selfConsistent) {
      problems.push({
        kind: linked ? 'mutated' : 'forged_row',
        atId: r.id,
        atSeq: r.seq,
        detail: linked
          ? `row ${r.id} (seq ${r.seq}) does not match its own keyed hash: its contents were altered after it was written.`
          : `row ${r.id} (seq ${r.seq}) carries neither a valid keyed hash nor a link to its predecessor: it was not written by this service.`,
      });
    } else if (!linked) {
      problems.push({
        kind: 'broken_link',
        atId: r.id,
        atSeq: r.seq,
        detail: `row ${r.id} (seq ${r.seq}) chains onto ${short(r.prev_hash)} but its predecessor hashes to ${short(prevHash)}.`,
      });
    }

    prevHash = r.hash;
    lastSeq = r.seq;
    expectSeq = r.seq + 1;
  }

  // Length. `entries` is monotonic, so this catches a cut tail even when every
  // surviving row is individually perfect — the case v1 could not see at all.
  if (head) {
    if (rows.length < expectedEntries) {
      problems.push({
        kind: 'truncated',
        atSeq: rows.length + 1,
        detail:
          rows.length === 0
            ? `every audit row for org ${orgKey} has been deleted; ${expectedEntries} were appended.`
            : `${expectedEntries - rows.length} of ${expectedEntries} appended entries are missing (last surviving sequence ${lastSeq}).`,
      });
    } else if (rows.length > expectedEntries) {
      problems.push({
        kind: 'forged_row',
        detail: `${rows.length} rows present but only ${expectedEntries} were ever appended: ${rows.length - expectedEntries} row(s) were inserted.`,
      });
    }

    // Terminal state. Both halves are keyed, so an attacker cannot re-derive a
    // head that matches whatever they left behind.
    const claimed = headHash(orgKey, expectedEntries, head.last_hash);
    if (!hashesEqual(claimed, head.head_hash)) {
      problems.push({
        kind: 'head_mismatch',
        detail: `the audit_head record for org ${orgKey} does not carry a valid keyed MAC over (entries=${expectedEntries}, last=${short(head.last_hash)}): it was rewritten.`,
      });
    } else if (rows.length === expectedEntries && expectedEntries > 0) {
      const terminal = rows[rows.length - 1];
      if (terminal && !hashesEqual(terminal.hash, head.last_hash)) {
        problems.push({
          kind: 'head_mismatch',
          atId: terminal.id,
          detail: `the head names ${short(head.last_hash)} as the terminal entry but the last surviving row hashes to ${short(terminal.hash)}.`,
        });
      }
    }
  }

  const brokenAtId = problems.find((p) => p.atId !== undefined)?.atId;
  return {
    ok: problems.length === 0,
    entries: rows.length,
    expectedEntries,
    problems,
    ...(brokenAtId !== undefined ? { brokenAtId } : {}),
  };
}

function short(h: string | null | undefined): string {
  if (!h) return '<none>';
  return h.length <= 12 ? h : `${h.slice(0, 12)}…`;
}
