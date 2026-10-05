-- Rollback of 074_hub_review_fixes.sql: back to 072/073's member policies (FOR ALL).
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/074_down.sql
-- Sealed hub_outbox.url values stay sealed: roll the CODE back only after the outbox has drained (state <> 'pending'
-- for kind = 'callback'), or 1.8.0-without-074 cannot read them.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hub_member','hub_party','hub_statement','hub_fee_invoice'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_write', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) '
                   'WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['hub_agreement','hub_cdr','hub_dispute','hub_dispute_note'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_write', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR cpo_org_id = app_current_org() OR emsp_org_id = app_current_org()) '
                   'WITH CHECK (app_rls_bypass() OR cpo_org_id = app_current_org() OR emsp_org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;
DROP POLICY IF EXISTS hub_settlement_position_write ON hub_settlement_position;
DROP POLICY IF EXISTS hub_settlement_position_tenant ON hub_settlement_position;
CREATE POLICY hub_settlement_position_tenant ON hub_settlement_position
  USING (app_rls_bypass() OR org_a_id = app_current_org() OR org_b_id = app_current_org())
  WITH CHECK (app_rls_bypass() OR org_a_id = app_current_org() OR org_b_id = app_current_org());
DROP POLICY IF EXISTS hub_payment_write ON hub_payment;
DROP POLICY IF EXISTS hub_payment_tenant ON hub_payment;
CREATE POLICY hub_payment_tenant ON hub_payment
  USING (app_rls_bypass() OR payer_org_id = app_current_org() OR payee_org_id = app_current_org())
  WITH CHECK (app_rls_bypass() OR payer_org_id = app_current_org() OR payee_org_id = app_current_org());
COMMENT ON COLUMN hub_outbox.url IS NULL;
DELETE FROM schema_migration WHERE name = '074_hub_review_fixes.sql';
