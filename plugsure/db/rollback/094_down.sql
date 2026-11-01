-- Rollback of 094_payout_rules_ppn_subscription_revenue.sql (v1.26.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/094_down.sql
-- Roll the CODE back first. Owner payout rules, recorded input VAT invoices and filed PPN periods are dropped (export
-- the PPN working papers first); payouts the worker requested stay, without the automatic mark.
DROP TABLE IF EXISTS ppn_period;
DROP TABLE IF EXISTS ppn_input_invoice;
DROP TABLE IF EXISTS owner_payout_rule;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS subscription_revenue;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS owner_payouts;
ALTER TABLE payout_transfer DROP COLUMN IF EXISTS automatic;
DELETE FROM schema_migration WHERE name = '094_payout_rules_ppn_subscription_revenue.sql';
