-- Rollback of 112_support_forecast_credit_telematics.sql (v1.45.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/112_down.sql
-- Roll the CODE back first. Dropped: support cases and their messages, macros and settings; site candidates; driver
-- credit (gift cards, vouchers, referrals and the credit ledger — export Finance → Driver credit first: drivers' unused
-- paid-for credit is owed to them); telematics connections and readings. Ledger entries already posted from driver
-- credit stay (their source is kept valid by leaving 'driver_credit' out only once none remain).
DROP TABLE IF EXISTS vehicle_telemetry;
DROP INDEX IF EXISTS fleet_vehicle_telematics_uq;
ALTER TABLE fleet_vehicle DROP COLUMN IF EXISTS telematics_vehicle_id;
ALTER TABLE fleet_vehicle DROP COLUMN IF EXISTS telematics_connection_id;
DROP TABLE IF EXISTS telematics_connection;
ALTER TABLE driver_charge DROP COLUMN IF EXISTS credit_settled_at;
ALTER TABLE driver_charge DROP COLUMN IF EXISTS credit_used_minor;
ALTER TABLE driver_charge DROP COLUMN IF EXISTS credit_hold_minor;
DROP TABLE IF EXISTS driver_credit_entry;
DROP TABLE IF EXISTS referral;
DROP TABLE IF EXISTS referral_code;
DROP TABLE IF EXISTS gift_card;
DROP TABLE IF EXISTS gift_card_batch;
DROP TABLE IF EXISTS credit_settings;
DROP TABLE IF EXISTS site_candidate;
DROP TABLE IF EXISTS support_macro;
DROP TABLE IF EXISTS support_message;
DROP TABLE IF EXISTS support_case;
DROP TABLE IF EXISTS support_settings;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM gl_entry WHERE source = 'driver_credit') THEN
    ALTER TABLE gl_entry DROP CONSTRAINT IF EXISTS gl_entry_source_check;
    ALTER TABLE gl_entry ADD CONSTRAINT gl_entry_source_check
      CHECK (source IN ('manual', 'gateway', 'assets', 'leases', 'provision', 'bills', 'deposits', 'expenses', 'intercompany', 'reversal', 'payroll', 'customer_deposits', 'projects',
                        'inventory', 'maintenance', 'loans', 'carbon', 'insurance', 'grants', 'landlords', 'chargebacks', 'loyalty', 'fx', 'tax', 'cards', 'contracts'));
  END IF;
END $$;
DELETE FROM schema_migration WHERE name = '112_support_forecast_credit_telematics.sql';
