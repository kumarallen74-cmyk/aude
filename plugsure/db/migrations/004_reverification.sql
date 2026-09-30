-- ═══════════════════════════════════════════════════════════════════════════
-- 004: fixes for the defects the SECOND, independent audit found in the first
--      remediation pass
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Three independent auditors re-ran the product after remediation. Most of the
-- first pass held; what follows are the database-level parts of what did not.

-- ─────────────────────────────────────────────── audit: whole-chain erasure
--
-- verifyChain could see a truncated tail and a rewritten head, but not the two
-- cases below:
--
--   1. WHOLE-CHAIN ERASURE. Delete every audit_log row for an org AND its
--      audit_head row. The verifier found no rows and no head, concluded the
--      org had simply never been audited, and returned ok. The most complete
--      possible destruction of the evidence was the one state that verified
--      clean.
--
--   2. HEAD ROLLBACK. audit_head.entries is described as monotonic but nothing
--      enforced it, so restoring an older (still validly MAC'd) head row
--      alongside a matching truncation was consistent end to end.
--
-- (1) is closed by giving every organisation a head row at creation time: a
-- tenant with no head row is then always tampering, never a fresh tenant. The
-- trigger below is what makes that true even for rows inserted by a path that
-- forgets — including psql.
--
-- (2) is closed by refusing any UPDATE that moves `entries` backwards. Neither
-- stops a determined superuser, which is why the operator guide also calls for
-- shipping head_hash off-box; they do stop the application role, a compromised
-- API credential, and an ordinary mistake.

CREATE OR REPLACE FUNCTION audit_head_for_new_org() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_head (org_id, entries, last_hash, head_hash)
  VALUES (NEW.id, 0, '', '')
  ON CONFLICT (org_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER organisation_seeds_audit_head
  AFTER INSERT ON organisation
  FOR EACH ROW EXECUTE FUNCTION audit_head_for_new_org();

-- Backfill: every organisation that predates this migration.
INSERT INTO audit_head (org_id, entries, last_hash, head_hash)
SELECT o.id, 0, '', '' FROM organisation o
ON CONFLICT (org_id) DO NOTHING;

CREATE OR REPLACE FUNCTION audit_head_is_append_only() RETURNS trigger AS $$
BEGIN
  IF NEW.entries < OLD.entries THEN
    RAISE EXCEPTION
      'audit_head.entries is append-only: refusing to move org % from % to %',
      OLD.org_id, OLD.entries, NEW.entries
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_head_no_rollback
  BEFORE UPDATE ON audit_head
  FOR EACH ROW EXECUTE FUNCTION audit_head_is_append_only();

-- Deleting a head row is how erasure hides; there is no legitimate reason to do
-- it, so it is refused outright rather than merely detected after the fact.
CREATE OR REPLACE FUNCTION audit_head_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_head rows are permanent: refusing to delete org %', OLD.org_id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_head_undeletable
  BEFORE DELETE ON audit_head
  FOR EACH ROW EXECUTE FUNCTION audit_head_no_delete();

-- ────────────────────────────────────────────── tariffs: bounded time fees
--
-- An `idle` component with no upper bound produced Rp 6,692,360 on a 60 kWh
-- delivery. The rating engine now caps it and the save path rejects it, but the
-- column has to exist for a component to declare its bound in the first place;
-- 002 added to_minutes, and this documents the invariant the two enforce.
COMMENT ON COLUMN tariff_component.to_minutes IS
  'Upper bound of the minute band, exclusive. REQUIRED for kind in (idle, time): '
  'without it the worst-case charge is unknowable and validateTariff refuses the tariff.';

-- ──────────────────────────────────────── charge points: administrative state
COMMENT ON COLUMN charge_point.status IS
  'Connectivity (online/offline/provisioning) OR an administrative state '
  '(pending_adoption/suspended/decommissioned). Administrative states are owned by '
  'the operator and are never overwritten by a gateway connect — liveness lives in '
  'last_seen_at.';
