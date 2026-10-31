-- Rollback of 084_payout_transfers.sql (v1.16.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/084_down.sql
-- Roll the CODE back first. Payout transfers are dropped; payouts they paid stay recorded as statement payments (with
-- their Duitku reference). Check Duitku's dashboard first for transfers in flight (state sending / sent).
DROP TABLE IF EXISTS payout_transfer;
DROP TABLE IF EXISTS gateway_report;
DELETE FROM schema_migration WHERE name = '084_payout_transfers.sql';
