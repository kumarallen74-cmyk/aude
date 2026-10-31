-- Rollback of 083_refund_disbursement.sql (v1.15.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/083_down.sql
-- Roll the CODE back first. Refund transfers are dropped (export the Refunds page first if needed; the transfers are in
-- Duitku's records). Refunds paid by Disbursement are kept as refunded, recorded as bank transfers ('manual').
-- A refund still waiting on a transfer goes back to due (check Duitku's dashboard first for any transfer in flight).
UPDATE payment_intent SET refund_state = 'due', refund_method = NULL, refund_error = NULL WHERE refund_state = 'processing' AND refund_method = 'disbursement';
UPDATE payment_intent SET refund_method = 'manual' WHERE refund_method = 'disbursement';
ALTER TABLE payment_intent DROP CONSTRAINT IF EXISTS payment_intent_refund_method_check;
ALTER TABLE payment_intent ADD CONSTRAINT payment_intent_refund_method_check CHECK (refund_method IN ('provider', 'manual'));
DROP TABLE IF EXISTS refund_transfer;
ALTER TABLE owner_bank_account DROP COLUMN IF EXISTS name_check_status, DROP COLUMN IF EXISTS name_check_name, DROP COLUMN IF EXISTS name_checked_at;
DELETE FROM schema_migration WHERE name = '083_refund_disbursement.sql';
