-- Rollback of 086_bank_statements_tax.sql (v1.18.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/086_down.sql
-- Roll the CODE back first. Uploaded bank statements, their matches and the recorded tax withholdings are dropped
-- (the statements are in the bank; export the withholdings first if needed).
DROP TABLE IF EXISTS bank_statement_line;
DROP TABLE IF EXISTS bank_statement;
DROP TABLE IF EXISTS tax_withholding;
DELETE FROM schema_migration WHERE name = '086_bank_statements_tax.sql';
