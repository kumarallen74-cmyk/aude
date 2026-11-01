-- Rollback of 100_bank_feeds_withholding_reports_close.sql (v1.32.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/100_down.sql
-- Roll the CODE back first. Bank feeds and match rules, withholding slips, report packs and close sign-offs are dropped:
-- export them first (Finance → Bank feeds, Tax → Withholding slips, Reports, Close). Bank lines a feed imported stay;
-- lines a rule turned into a journal entry go back to unmatched. Supplier tax kinds and bills' withholding kinds are
-- dropped (the amounts withheld stay on the bills).
UPDATE bank_statement_line SET matched_kind = NULL, matched_ref = NULL, matched_auto = false WHERE matched_kind = 'gl_entry';
ALTER TABLE bank_statement_line DROP CONSTRAINT IF EXISTS bank_statement_line_matched_kind_check;
ALTER TABLE bank_statement_line ADD CONSTRAINT bank_statement_line_matched_kind_check
  CHECK (matched_kind = ANY (ARRAY['gateway_withdrawal', 'statement_payment', 'refund', 'roaming_payment', 'supplier_payment', 'ignored']));
DROP TABLE IF EXISTS close_signoff;
DROP TABLE IF EXISTS report_pack;
DROP TABLE IF EXISTS tax_slip;
DROP TABLE IF EXISTS bank_match_rule;
DROP TABLE IF EXISTS bank_feed;
ALTER TABLE supplier_bill DROP COLUMN IF EXISTS wht_kind;
ALTER TABLE supplier DROP COLUMN IF EXISTS treaty_rate_pct;
ALTER TABLE supplier DROP COLUMN IF EXISTS country;
ALTER TABLE supplier DROP COLUMN IF EXISTS id_number;
ALTER TABLE supplier DROP COLUMN IF EXISTS tax_kind;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS report_pack;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS close_policy;
DELETE FROM schema_migration WHERE name = '100_bank_feeds_withholding_reports_close.sql';
