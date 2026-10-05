-- 062: roaming for signed-in app drivers (docs/MULTI-COUNTRY-DESIGN.md §D7, WP2).
--
-- An app driver's charge on a partner network is guaranteed by a card hold in the
-- partner location's currency (payment_intent.roaming_charge_id, added by 059). The
-- hold is settled once, when the partner's charge record is accepted: captured up to
-- its total, the rest released; a shortfall is recorded for the operator.
--
-- Additive: fleet-card roaming (017) is unchanged.

ALTER TABLE driver_roaming_charge
  ADD COLUMN IF NOT EXISTS hold_minor       INTEGER,
  ADD COLUMN IF NOT EXISTS start_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settled_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settle_outcome   TEXT,
  ADD COLUMN IF NOT EXISTS shortfall_minor  INTEGER,
  ADD COLUMN IF NOT EXISTS remote_cdr_id    UUID REFERENCES ocpi_remote_cdr(id);

ALTER TABLE driver_roaming_charge DROP CONSTRAINT IF EXISTS driver_roaming_charge_settle_outcome_check;
ALTER TABLE driver_roaming_charge ADD CONSTRAINT driver_roaming_charge_settle_outcome_check
  CHECK (settle_outcome IS NULL OR settle_outcome IN ('captured', 'shortfall', 'currency_mismatch', 'not_started', 'released_no_cdr', 'captured_session_total'));
ALTER TABLE driver_roaming_charge DROP CONSTRAINT IF EXISTS driver_roaming_charge_currency_fk;
ALTER TABLE driver_roaming_charge ADD CONSTRAINT driver_roaming_charge_currency_fk FOREIGN KEY (currency) REFERENCES currency_unit(code);

CREATE INDEX IF NOT EXISTS driver_roaming_charge_app_driver_idx ON driver_roaming_charge (app_driver_id, created_at DESC) WHERE app_driver_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS driver_roaming_charge_open_hold_idx ON driver_roaming_charge (created_at) WHERE payment_intent_id IS NOT NULL AND settled_at IS NULL;
CREATE INDEX IF NOT EXISTS payment_intent_roaming_charge_idx ON payment_intent (roaming_charge_id) WHERE roaming_charge_id IS NOT NULL;
