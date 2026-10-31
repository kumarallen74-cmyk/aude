-- Rollback of 081_payments_fallback.sql (v1.13.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/081_down.sql
-- Roll the CODE back first. The fallback accounts are removed; payments they took keep their record (integration_id
-- set to NULL by the foreign key) and any refund of them is made by bank transfer from the Refunds page.
DELETE FROM integration_event WHERE kind = 'payments_fallback';
DELETE FROM integration WHERE kind = 'payments_fallback';
ALTER TABLE integration DROP CONSTRAINT IF EXISTS integration_kind_check;
ALTER TABLE integration ADD CONSTRAINT integration_kind_check
  CHECK (kind IN ('payments', 'otp', 'otp_fallback', 'pnc_pki', 'map_tiles', 'ai_support'));
DELETE FROM schema_migration WHERE name = '081_payments_fallback.sql';
