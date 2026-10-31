-- Rollback of 093_platform_invoicing_roaming_settlement_controls.sql (v1.25.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/093_down.sql
-- Roll the CODE back first. Bank lines matched to roaming payments are unmatched; the invoice send log, payment links
-- (payments they recorded stay on the statements), roaming settlements and their payments, and operators' billing
-- e-mail are dropped. Open Xendit payment links stay open at Xendit: expire them there first.
UPDATE bank_statement_line SET matched_kind = NULL, matched_ref = NULL, matched_auto = false WHERE matched_kind = 'roaming_payment';
ALTER TABLE bank_statement_line DROP CONSTRAINT IF EXISTS bank_statement_line_matched_kind_check;
ALTER TABLE bank_statement_line ADD CONSTRAINT bank_statement_line_matched_kind_check
  CHECK (matched_kind = ANY (ARRAY['gateway_withdrawal', 'statement_payment', 'refund', 'ignored']));
DROP TABLE IF EXISTS roaming_settlement_payment;
DROP TABLE IF EXISTS roaming_settlement;
DROP TABLE IF EXISTS platform_invoice_link;
DROP TABLE IF EXISTS platform_invoice_send;
ALTER TABLE organisation DROP COLUMN IF EXISTS billing_email;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS platform_invoicing;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS finance_controls;
DELETE FROM schema_migration WHERE name = '093_platform_invoicing_roaming_settlement_controls.sql';
