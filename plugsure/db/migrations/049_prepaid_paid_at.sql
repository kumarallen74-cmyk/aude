-- 049: the prepaid claim window runs from PAYMENT, not from checkout.
--
--   payment_intent.paid_at   when the money became usable: the first moment the
--                            intent reached 'authorised' (a card hold, or an
--                            acquirer that authorises before it captures) or
--                            'captured'. The 30-minute window in which a paid
--                            prepurchase / hold can start its session
--                            (services/sessions.ts PREPAID_CLAIM_WINDOW_MIN) is
--                            measured from here. It was measured from created_at
--                            (checkout), so a QRIS or e-wallet payment completed
--                            25 minutes into checkout left the driver 5 minutes to
--                            plug in, and one completed after 30 could never start.
--
-- Stamped by a trigger rather than by each writer: the state moves to
-- 'authorised' / 'captured' in a dozen places (acquirer notifications, the
-- driver checkout, saved cards, reconciliation, the operator's manual capture),
-- and a missed one would silently fall back to the old rule. The trigger only
-- ever sets paid_at once and never changes authorised_at / captured_at, which
-- stay owned by the code that writes them.
--
-- Additive: existing rows are backfilled from authorised_at / captured_at (the
-- earlier of the two), falling back to created_at for a paid row that carries
-- neither, which is exactly the rule they were held to before.

ALTER TABLE payment_intent ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

UPDATE payment_intent
   SET paid_at = COALESCE(LEAST(authorised_at, captured_at), created_at)
 WHERE paid_at IS NULL
   AND (state IN ('authorised', 'captured') OR authorised_at IS NOT NULL OR captured_at IS NOT NULL);

CREATE OR REPLACE FUNCTION payment_intent_stamp_paid_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.paid_at IS NULL AND NEW.state IN ('authorised', 'captured') THEN
    -- The timestamps the writer recorded, when it recorded them; otherwise now.
    NEW.paid_at := COALESCE(LEAST(NEW.authorised_at, NEW.captured_at), now());
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS payment_intent_paid_at ON payment_intent;
CREATE TRIGGER payment_intent_paid_at
  BEFORE INSERT OR UPDATE OF state, authorised_at, captured_at ON payment_intent
  FOR EACH ROW EXECUTE FUNCTION payment_intent_stamp_paid_at();

COMMENT ON COLUMN payment_intent.paid_at IS
  'When the payment became usable (first authorised or captured); trigger-maintained. '
  'The prepaid claim window and the unused-payment refund sweep run from here, not from created_at.';

-- No GRANT: this migration adds a column and a trigger, covered by the runtime role's existing table grants.
-- A blanket `GRANT … ON ALL TABLES` would hand UPDATE/DELETE on audit_log back to plugsure_app (see 048).
