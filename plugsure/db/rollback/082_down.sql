-- Rollback of 082_statement_payments.sql (v1.14.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/082_down.sql
-- Roll the CODE back first. The recorded payouts and statement payments and the owners' bank details are dropped
-- (export them first from Finance if they are needed: the transfers themselves are in the bank's records).
DROP TABLE IF EXISTS statement_payment;
DROP TABLE IF EXISTS owner_bank_account;
DELETE FROM schema_migration WHERE name = '082_statement_payments.sql';
