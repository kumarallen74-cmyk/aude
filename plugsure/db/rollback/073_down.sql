-- Rollback of 073_hub_clearing.sql (PlugSure Hub clearing and settlement).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/073_down.sql
--
-- Refuses while the ledger holds rows: hub_cdr, statements, payments and fee invoices are financial records
-- (kept 10 years, §3.3). Export them first; then delete them deliberately if a rollback is really meant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migration WHERE name = '074_hub_review_fixes.sql') THEN
    RAISE EXCEPTION '074 is applied: roll it back first (074_down.sql)';
  END IF;
  IF to_regclass('public.hub_cdr') IS NOT NULL AND EXISTS (SELECT 1 FROM hub_cdr) THEN
    RAISE EXCEPTION 'hub_cdr holds % rows: the clearing ledger is a financial record; export and remove it deliberately first', (SELECT count(*) FROM hub_cdr);
  END IF;
END $$;

DROP TABLE IF EXISTS hub_payment;
DROP TABLE IF EXISTS hub_fee_invoice;
DROP TABLE IF EXISTS hub_statement;
DROP TABLE IF EXISTS hub_settlement_position;
DROP TABLE IF EXISTS hub_dispute_note;
DROP TABLE IF EXISTS hub_dispute;
DROP TABLE IF EXISTS hub_cdr;
DROP TABLE IF EXISTS hub_settlement_run;
DROP TABLE IF EXISTS hub_fee_assignment;
ALTER TABLE hub_member    DROP CONSTRAINT IF EXISTS hub_member_fee_fk;
ALTER TABLE hub_agreement DROP CONSTRAINT IF EXISTS hub_agreement_fee_fk;
DROP TABLE IF EXISTS hub_fee_plan;
DROP TABLE IF EXISTS hub_doc_seq;
ALTER TABLE hub_agreement DROP COLUMN IF EXISTS dispute_days;
ALTER TABLE hub_member    DROP COLUMN IF EXISTS bank_details;
DELETE FROM hub_entity WHERE placeholder;
ALTER TABLE hub_entity    DROP COLUMN IF EXISTS updated_at;
ALTER TABLE hub_entity    DROP COLUMN IF EXISTS placeholder;

DELETE FROM schema_migration WHERE name = '073_hub_clearing.sql';
