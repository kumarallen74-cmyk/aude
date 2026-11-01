-- Rollback of 095_digests_tariffs_owner_docs_fleet_automation.sql (v1.27.0).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/095_down.sql
-- Roll the CODE back first. Digest subscriptions and their log, site tariffs and fleet payment links are dropped
-- (expire open links at Xendit first; invoices they marked paid stay paid). Withholdings recorded on owners' shares
-- are voided (export them first: Finance → Tax), as v1.26.0 has no such kind.
UPDATE tax_withholding SET kind = 'platform_fee', voided_at = COALESCE(voided_at, now()), void_reason = COALESCE(void_reason, 'Rolled back from v1.27.0 (owner share)') WHERE kind = 'owner_share';
ALTER TABLE tax_withholding DROP CONSTRAINT IF EXISTS tax_withholding_kind_check;
ALTER TABLE tax_withholding ADD CONSTRAINT tax_withholding_kind_check CHECK (kind = ANY (ARRAY['gateway_fee', 'platform_fee']));
DROP INDEX IF EXISTS tax_withholding_owner_idx;
ALTER TABLE tax_withholding DROP COLUMN IF EXISTS owner_id;
DROP TABLE IF EXISTS fleet_invoice_link;
DROP TABLE IF EXISTS site_tariff;
DROP TABLE IF EXISTS finance_digest_send;
DROP TABLE IF EXISTS finance_digest_subscription;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS fleet_automation;
ALTER TABLE finance_org_settings DROP COLUMN IF EXISTS finance_digest;
DELETE FROM schema_migration WHERE name = '095_digests_tariffs_owner_docs_fleet_automation.sql';
