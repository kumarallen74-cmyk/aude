-- Rollback of 080_gateway_finance.sql (v1.12.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/080_down.sql
-- Roll the CODE back first. The synced gateway ledger, balance snapshots and reconciliation results are dropped;
-- everything in them can be synced again from the gateway after a re-upgrade. Payments themselves are untouched.
DROP TABLE IF EXISTS reconciliation_exception;
DROP TABLE IF EXISTS gateway_sync_state;
DROP TABLE IF EXISTS gateway_balance_snapshot;
DROP TABLE IF EXISTS gateway_transaction;
DELETE FROM schema_migration WHERE name = '080_gateway_finance.sql';
