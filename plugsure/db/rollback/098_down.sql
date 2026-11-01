-- Rollback of 098_purchase_orders_leases_treasury_checks.sql (v1.30.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/098_down.sql
-- Roll the CODE back first. Purchase orders (with their lines and receipts), leases and their recorded months, deposits
-- and the anomaly findings are dropped: export them first (Finance → Orders, Leases, Treasury, Review). Supplier bills
-- stay, without their order.
DROP TABLE IF EXISTS finance_check_finding;
DROP TABLE IF EXISTS deposit;
DROP TABLE IF EXISTS lease_run;
DROP TABLE IF EXISTS lease;
ALTER TABLE supplier_bill DROP COLUMN IF EXISTS purchase_order_id;
DROP TABLE IF EXISTS goods_receipt;
DROP TABLE IF EXISTS purchase_order_line;
DROP TABLE IF EXISTS purchase_order;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS procurement;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS treasury;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS finance_checks;
DELETE FROM schema_migration WHERE name = '098_purchase_orders_leases_treasury_checks.sql';
