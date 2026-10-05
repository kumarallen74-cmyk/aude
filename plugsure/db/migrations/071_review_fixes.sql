-- 071: v1.7.0 review fixes (RELEASE-NOTES-v1.7.0.md, "Review fixes"). Additive.
--
-- 1. Stripe TEST mode. A payments account that runs on test keys (allowed only by a platform administrator) is
--    marked integration.test_mode. Everything paid through it is tagged at insert — payment_intent.test_mode and
--    subscription_charge.test_mode from the account, the CDR from the payment of its session — so receipts are
--    not tax invoices ("TEST"), and commission statements and revenue totals leave them out.
-- 2. App-driver roaming shortfalls (more than the hold, or a partner CDR after the 4-day sweep) are owed by the
--    driver and paid in the app (the unpaid-session flow): driver_roaming_charge.shortfall_paid_at and the
--    settlement payment that paid it; settle_outcome 'late_cdr' for a charge record that arrived after the sweep.

ALTER TABLE integration ADD COLUMN IF NOT EXISTS test_mode BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE payment_intent ADD COLUMN IF NOT EXISTS test_mode BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE subscription_charge ADD COLUMN IF NOT EXISTS test_mode BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cdr ADD COLUMN IF NOT EXISTS test_mode BOOLEAN NOT NULL DEFAULT false;

-- Tagged from the account at insert (and when a row is moved to another account, which does not happen today).
CREATE OR REPLACE FUNCTION payment_test_mode_tag() RETURNS trigger AS $$
BEGIN
  IF NEW.integration_id IS NOT NULL THEN
    NEW.test_mode := COALESCE((SELECT i.test_mode FROM integration i WHERE i.id = NEW.integration_id), false);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS payment_intent_test_mode ON payment_intent;
CREATE TRIGGER payment_intent_test_mode BEFORE INSERT OR UPDATE OF integration_id ON payment_intent
  FOR EACH ROW EXECUTE FUNCTION payment_test_mode_tag();
DROP TRIGGER IF EXISTS subscription_charge_test_mode ON subscription_charge;
CREATE TRIGGER subscription_charge_test_mode BEFORE INSERT OR UPDATE OF integration_id ON subscription_charge
  FOR EACH ROW EXECUTE FUNCTION payment_test_mode_tag();

-- A CDR is a test record when its session was paid (or held) through a test-mode account.
CREATE OR REPLACE FUNCTION cdr_test_mode_tag() RETURNS trigger AS $$
BEGIN
  NEW.test_mode := EXISTS (
    SELECT 1 FROM charging_session cs JOIN payment_intent pi ON pi.id = cs.payment_intent_id
     WHERE cs.id = NEW.session_id AND pi.test_mode
    UNION ALL
    SELECT 1 FROM payment_intent pi WHERE pi.session_id = NEW.session_id AND pi.test_mode);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS cdr_test_mode ON cdr;
CREATE TRIGGER cdr_test_mode BEFORE INSERT ON cdr FOR EACH ROW EXECUTE FUNCTION cdr_test_mode_tag();

REVOKE ALL ON FUNCTION payment_test_mode_tag() FROM PUBLIC;
REVOKE ALL ON FUNCTION cdr_test_mode_tag() FROM PUBLIC;

ALTER TABLE driver_roaming_charge
  ADD COLUMN IF NOT EXISTS shortfall_paid_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS shortfall_settlement_id  UUID REFERENCES payment_intent(id);
ALTER TABLE driver_roaming_charge DROP CONSTRAINT IF EXISTS driver_roaming_charge_settle_outcome_check;
ALTER TABLE driver_roaming_charge ADD CONSTRAINT driver_roaming_charge_settle_outcome_check
  CHECK (settle_outcome IS NULL OR settle_outcome IN ('captured', 'shortfall', 'currency_mismatch', 'not_started', 'released_no_cdr',
                                                      'captured_session_total', 'late_cdr'));
-- A driver's open shortfalls (refuse new roaming holds and charges while one is owed).
CREATE INDEX IF NOT EXISTS driver_roaming_charge_owed_idx ON driver_roaming_charge (app_driver_id)
  WHERE shortfall_minor > 0 AND shortfall_paid_at IS NULL;
