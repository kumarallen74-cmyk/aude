-- 051: billing facts captured when they happen, not looked up when billed.
--
--   charging_session.fleet_account_id
--                              the fleet account the session's card belonged to WHEN
--                              THE SESSION STARTED. Fleet invoices used the card's
--                              current fleet (token.fleet_account_id), so moving a card
--                              to another account re-billed its past, not yet invoiced
--                              sessions to the new account. Set by a trigger from the
--                              card on insert (and if the card on a session is ever
--                              changed), so every path that writes a session keeps it.
--   ocpi_remote_cdr.fleet_account_id
--                              the same for a partner network's charge record: the
--                              card's fleet when the record was received.
--   tariff_assignment.valid_from / valid_to
--                              assignments are versioned. Unassigning deleted the row,
--                              so a session parked for review and rated later fell back
--                              to the default tariff; and an assignment applied to every
--                              unrated session since the tariff's own active_from, so
--                              attaching a tariff re-priced sessions that had already
--                              run. A session is now priced by the assignment in force
--                              at its start (tariff-store.ts loadTariffForConnector).
--   tariff_component.rate NULL
--                              an energy component with no rate is billed at the PLN
--                              formula rate; 0 now means free. A zero rate used to mean
--                              "formula", so a "first 5 kWh free" tier was billed at
--                              the formula rate. Existing zero-rate energy components
--                              meant the formula and are converted to NULL, so they
--                              bill exactly as before.

-- ------------------------------------------------------------ the fleet at session time

ALTER TABLE charging_session ADD COLUMN IF NOT EXISTS fleet_account_id UUID REFERENCES fleet_account(id);
ALTER TABLE ocpi_remote_cdr  ADD COLUMN IF NOT EXISTS fleet_account_id UUID REFERENCES fleet_account(id);

-- The card's fleet, taken when the row is written. An explicit value from the
-- writer is kept; a change of card on the row takes the new card's fleet.
CREATE OR REPLACE FUNCTION billing_capture_fleet_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.fleet_account_id IS NULL AND NEW.token_id IS NOT NULL THEN
      SELECT fleet_account_id INTO NEW.fleet_account_id FROM token WHERE id = NEW.token_id;
    END IF;
  ELSIF NEW.token_id IS DISTINCT FROM OLD.token_id THEN
    NEW.fleet_account_id := NULL;
    IF NEW.token_id IS NOT NULL THEN
      SELECT fleet_account_id INTO NEW.fleet_account_id FROM token WHERE id = NEW.token_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS charging_session_fleet_account ON charging_session;
CREATE TRIGGER charging_session_fleet_account BEFORE INSERT OR UPDATE OF token_id ON charging_session
  FOR EACH ROW EXECUTE FUNCTION billing_capture_fleet_account();
DROP TRIGGER IF EXISTS ocpi_remote_cdr_fleet_account ON ocpi_remote_cdr;
CREATE TRIGGER ocpi_remote_cdr_fleet_account BEFORE INSERT OR UPDATE OF token_id ON ocpi_remote_cdr
  FOR EACH ROW EXECUTE FUNCTION billing_capture_fleet_account();

-- Backfill, best evidence first:
--   1. a session or record already on a live fleet invoice belongs to that invoice's
--      account (that is who was billed for it);
--   2. otherwise the card's current fleet — card moves before this migration were
--      not recorded anywhere, so this is the best that is known.
UPDATE charging_session cs SET fleet_account_id = i.fleet_account_id
  FROM fleet_invoice_item it JOIN fleet_invoice i ON i.id = it.invoice_id
 WHERE it.kind = 'session' AND it.ref_id = cs.id AND cs.fleet_account_id IS NULL;
UPDATE charging_session cs SET fleet_account_id = t.fleet_account_id
  FROM token t
 WHERE t.id = cs.token_id AND t.fleet_account_id IS NOT NULL AND cs.fleet_account_id IS NULL;
UPDATE ocpi_remote_cdr r SET fleet_account_id = i.fleet_account_id
  FROM fleet_invoice_item it JOIN fleet_invoice i ON i.id = it.invoice_id
 WHERE it.kind = 'roaming' AND it.ref_id = r.id AND r.fleet_account_id IS NULL;
UPDATE ocpi_remote_cdr r SET fleet_account_id = t.fleet_account_id
  FROM token t
 WHERE t.id = r.token_id AND t.fleet_account_id IS NOT NULL AND r.fleet_account_id IS NULL;

CREATE INDEX IF NOT EXISTS charging_session_fleet_account_idx ON charging_session (fleet_account_id, started_at)
  WHERE fleet_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ocpi_remote_cdr_fleet_account_idx ON ocpi_remote_cdr (fleet_account_id)
  WHERE fleet_account_id IS NOT NULL;

-- ------------------------------------------------------------ versioned tariff assignments

ALTER TABLE tariff_assignment
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS valid_to   TIMESTAMPTZ;
-- The table recorded no creation time: an existing assignment has always applied.
UPDATE tariff_assignment SET valid_from = '-infinity' WHERE valid_from IS NULL;
ALTER TABLE tariff_assignment ALTER COLUMN valid_from SET DEFAULT now(), ALTER COLUMN valid_from SET NOT NULL;
ALTER TABLE tariff_assignment DROP CONSTRAINT IF EXISTS tariff_assignment_valid_range;
ALTER TABLE tariff_assignment ADD CONSTRAINT tariff_assignment_valid_range CHECK (valid_to IS NULL OR valid_to >= valid_from);

-- One open assignment per tariff, scope and current type. Duplicates left from
-- before the assign path replaced rows: the resolver always picked the highest
-- priority, so the others never priced anything and are closed from the start.
UPDATE tariff_assignment ta SET valid_to = ta.valid_from
  FROM (SELECT id, row_number() OVER (PARTITION BY tariff_id, scope_type, scope_id, current_type ORDER BY priority DESC, id) AS n
          FROM tariff_assignment WHERE valid_to IS NULL) d
 WHERE d.id = ta.id AND d.n > 1;
CREATE UNIQUE INDEX IF NOT EXISTS tariff_assignment_open_uniq ON tariff_assignment
  (tariff_id, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(current_type, ''))
  WHERE valid_to IS NULL;

-- ------------------------------------------------------------ energy at the formula rate, explicitly

ALTER TABLE tariff_component ALTER COLUMN rate DROP NOT NULL;
ALTER TABLE tariff_component DROP CONSTRAINT IF EXISTS tariff_component_rate_present;
ALTER TABLE tariff_component ADD CONSTRAINT tariff_component_rate_present CHECK (rate IS NOT NULL OR kind = 'energy');
UPDATE tariff_component SET rate = NULL WHERE kind = 'energy' AND rate = 0;
