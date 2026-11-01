-- Rollback of 102_inventory_maintenance_assurance_lenders.sql (v1.34.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/102_down.sql
-- Roll the CODE back first. Stock items, locations and moves, work orders and warranty claims, revenue assurance
-- findings, loans with their drawdowns and payments, covenants and their tests are dropped: export them first
-- (Finance → Inventory, Maintenance, Assurance, Lenders). Supplier bills keep their amounts; their stock and work order
-- links are dropped.
UPDATE gl_entry SET status = 'superseded' WHERE source IN ('inventory', 'maintenance', 'loans') AND status <> 'superseded';
ALTER TABLE gl_entry DROP CONSTRAINT IF EXISTS gl_entry_source_check;
ALTER TABLE gl_entry ADD CONSTRAINT gl_entry_source_check
  CHECK (source IN ('manual', 'gateway', 'assets', 'leases', 'provision', 'bills', 'deposits', 'expenses', 'intercompany', 'reversal', 'payroll', 'customer_deposits', 'projects')) NOT VALID;
DROP TABLE IF EXISTS covenant_test;
DROP TABLE IF EXISTS covenant;
DROP TABLE IF EXISTS loan_payment;
DROP TABLE IF EXISTS loan_drawdown;
DROP TABLE IF EXISTS loan;
DROP TABLE IF EXISTS revenue_finding;
DROP TABLE IF EXISTS warranty_claim;
ALTER TABLE supplier_bill DROP COLUMN IF EXISTS work_order_id;
ALTER TABLE supplier_bill DROP COLUMN IF EXISTS stock;
DROP TABLE IF EXISTS stock_move;
DROP TABLE IF EXISTS work_order;
DROP TABLE IF EXISTS stock_location;
DROP TABLE IF EXISTS stock_item;
DELETE FROM schema_migration WHERE name = '102_inventory_maintenance_assurance_lenders.sql';
