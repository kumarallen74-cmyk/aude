-- Rollback of 117_dealer_partnerships.sql (v1.50.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/117_down.sql
-- Roll the CODE back first. Dropped: dealers, their sales (and unredeemed welcome codes) and statements; credit
-- already redeemed stays with the drivers (its link to the sale is dropped). Export the statements first.
ALTER TABLE driver_credit_entry DROP COLUMN IF EXISTS dealer_sale_id;
DROP TABLE IF EXISTS dealer_statement;
DROP TABLE IF EXISTS dealer_sale;
DROP TABLE IF EXISTS dealer;
DELETE FROM schema_migration WHERE name = '117_dealer_partnerships.sql';
