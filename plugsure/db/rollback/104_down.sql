-- Rollback of 104_grants_landlords_chargebacks_board.sql (v1.36.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/104_down.sql
-- Roll the CODE back first. Grants with their conditions, claims and clawbacks, landlord deals and statements, and
-- chargebacks are dropped: export them first (Finance → Grants, Landlords, Chargebacks). Supplier bills issued from
-- landlord statements stay. Report packs keep their data; the new sections are ignored by v1.35.0.
UPDATE gl_entry SET status = 'superseded' WHERE source IN ('grants', 'landlords', 'chargebacks') AND status <> 'superseded';
ALTER TABLE gl_entry DROP CONSTRAINT IF EXISTS gl_entry_source_check;
ALTER TABLE gl_entry ADD CONSTRAINT gl_entry_source_check
  CHECK (source IN ('manual', 'gateway', 'assets', 'leases', 'provision', 'bills', 'deposits', 'expenses', 'intercompany', 'reversal', 'payroll', 'customer_deposits', 'projects',
                    'inventory', 'maintenance', 'loans', 'carbon', 'insurance')) NOT VALID;
DROP TABLE IF EXISTS chargeback;
DROP TABLE IF EXISTS landlord_statement;
DROP TABLE IF EXISTS landlord_deal;
DROP TABLE IF EXISTS grant_clawback;
DROP TABLE IF EXISTS grant_claim;
DROP TABLE IF EXISTS grant_condition;
DROP TABLE IF EXISTS grant_programme;
DELETE FROM schema_migration WHERE name = '104_grants_landlords_chargebacks_board.sql';
