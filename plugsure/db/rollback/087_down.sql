-- Rollback of 087_fee_audit_owner_portal_accounting.sql (v1.19.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/087_down.sql
-- Roll the CODE back first. Contracted rates, the accounting package, owners' pending bank change requests and the
-- export log are dropped (re-enter the rates; ask owners to send pending changes again).
DROP TABLE IF EXISTS accounting_export;
DROP TABLE IF EXISTS owner_bank_change_request;
ALTER TABLE gateway_account_settings DROP COLUMN IF EXISTS accounting_package;
ALTER TABLE gateway_account_settings DROP COLUMN IF EXISTS contract_rates;
DELETE FROM schema_migration WHERE name = '087_fee_audit_owner_portal_accounting.sql';
