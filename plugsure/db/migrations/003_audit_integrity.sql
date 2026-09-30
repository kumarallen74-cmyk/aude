-- ═══════════════════════════════════════════════════════════════════════════
-- 003: audit log integrity — keyed chain, per-org sequence, truncation head
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Closes the audit findings:
--   * the chain was an unkeyed SHA-256, so any writer could recompute it;
--   * deleting the newest row (or every row) verified as "intact";
--   * the chain was selected with `org_id IS NOT DISTINCT FROM`, which leaves
--     the NULL/platform partition implicit and untyped.
--
-- The keying itself lives in the application (HMAC-SHA256 with
-- config.security.auditHmacKey). This migration supplies the columns the
-- verifier needs to reason about ORDER and LENGTH, which a hash chain alone
-- cannot express.
--
-- ─────────────────────────────────────────────────────────── NULL-org scheme
-- `audit_log.org_id` must stay nullable: it is a FK to organisation(id) and
-- platform-level events belong to no tenant. `audit_head.org_id` is a primary
-- key and cannot be NULL. The two are reconciled by a single derived column:
--
--     org_key = COALESCE(org_id, '00000000-0000-0000-0000-000000000000')
--
-- It is GENERATED ALWAYS ... STORED so it cannot drift from org_id and cannot
-- be set independently by a writer. Every chain is keyed by org_key: one chain
-- per tenant, plus exactly one platform chain under the nil UUID — the same
-- key 002_hardening.sql already chose for audit_head. Chain selection and head
-- bookkeeping therefore agree by construction, and moving a row between
-- partitions (flipping org_id) moves its org_key too, which breaks the source
-- chain's sequence and fails the destination chain's hash and uniqueness.

ALTER TABLE audit_log
  ADD COLUMN seq     BIGINT,
  ADD COLUMN org_key UUID GENERATED ALWAYS AS
    (COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED;

COMMENT ON COLUMN audit_log.seq IS
  'Per-org_key sequence number, 1-based and gapless. Committed to by the entry '
  'HMAC, so a deletion leaves a gap that cannot be closed without the key.';
COMMENT ON COLUMN audit_log.org_key IS
  'Chain partition key: org_id, or the nil UUID for platform-level entries.';

-- Backfill any rows written by the v1 (unkeyed) implementation so the NOT NULL
-- constraint can be applied. NOTE FOR OPERATORS: v1 rows carry unkeyed SHA-256
-- hashes and will NOT verify under the v2 keyed algorithm. Archive/export them
-- (they are still readable) and re-anchor the chain before relying on
-- verifyChain in production; there is deliberately no "verify v1 rows the old
-- way" path, because an attacker could then downgrade rows to bypass the key.
UPDATE audit_log a
   SET seq = n.rn
  FROM (
    SELECT id,
           row_number() OVER (
             PARTITION BY COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid)
             ORDER BY id
           ) AS rn
      FROM audit_log
  ) n
 WHERE a.id = n.id;

ALTER TABLE audit_log ALTER COLUMN seq SET NOT NULL;

-- Two rows can never claim the same position in a chain, so a forged row has
-- to either duplicate a hash-covered seq (rejected here) or leave a gap
-- (rejected by the verifier).
CREATE UNIQUE INDEX audit_log_org_seq_uniq ON audit_log (org_key, seq);
CREATE INDEX audit_log_org_key_id_idx ON audit_log (org_key, id);

-- ───────────────────────────────────────────────────────── keyed head record
-- 002 gave audit_head (entries, head_hash). head_hash must NOT be a plain copy
-- of the terminal entry's hash: that value is visible in audit_log, so an
-- attacker who truncates the tail could restore a matching head unaided.
-- Instead:
--     last_hash = terminal entry's hash        (plain, for cheap appends)
--     head_hash = HMAC(key, orgKey || entries || last_hash)
-- Rewriting the head therefore requires the HMAC key.
ALTER TABLE audit_head
  ADD COLUMN last_hash TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN audit_head.entries IS
  'Monotonic count of entries ever appended for this org_key. Never recomputed '
  'from audit_log, so a deletion stays visible as a length mismatch or a seq gap.';
COMMENT ON COLUMN audit_head.last_hash IS 'Hash of the terminal entry; the next append chains onto it.';
COMMENT ON COLUMN audit_head.head_hash IS 'Keyed MAC over (org_key, entries, last_hash). Not forgeable without the key.';
