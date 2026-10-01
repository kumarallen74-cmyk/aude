-- 044: a refund can never be larger than what was taken.
--
-- refund_due_idr was bounded only by the code paths that set it. A refund is
-- paid from it (through the acquirer, or recorded as a bank transfer), so a bug
-- or a hand-edited row that owed back more than the payment captured would pay
-- the driver money PlugSure never received. The database now refuses it.
--
-- Added NOT VALID (existing rows are not scanned under a lock on a busy table),
-- then validated in the same migration only when no existing row breaks it; a
-- database that has such rows keeps the constraint for every new write, and the
-- rows are listed by:
--   SELECT id, refund_due_idr, amount_captured_idr FROM payment_intent
--    WHERE refund_due_idr > amount_captured_idr;
-- A payment without a captured amount (NULL) is not judged by it.

ALTER TABLE payment_intent DROP CONSTRAINT IF EXISTS payment_intent_refund_within_captured;
ALTER TABLE payment_intent ADD CONSTRAINT payment_intent_refund_within_captured
  CHECK (refund_due_idr IS NULL OR (refund_due_idr >= 0 AND refund_due_idr <= amount_captured_idr)) NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM payment_intent WHERE refund_due_idr < 0 OR refund_due_idr > amount_captured_idr) THEN
    ALTER TABLE payment_intent VALIDATE CONSTRAINT payment_intent_refund_within_captured;
  END IF;
END $$;

COMMENT ON CONSTRAINT payment_intent_refund_within_captured ON payment_intent IS
  'A refund owed back is never more than the payment captured (refund_due_idr <= amount_captured_idr).';
