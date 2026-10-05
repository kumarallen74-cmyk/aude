-- 074: PlugSure Hub — review fixes (v1.8.0, review180).
--
-- 1. Row-level security: inside a member's request scope the hub tables are READ-ONLY. 072/073 gave each member
--    policy FOR ALL (USING … WITH CHECK …), so a member-scoped connection could also UPDATE its own hub_member
--    (status, open_roaming), hub_party (status) and hub_agreement (status, module flags) rows, and the clearing
--    rows it is a side of. No code path does that — every change goes through the hub services on an unscoped
--    connection — but the database should say so too. Now: a SELECT policy per member side (the 048 shape,
--    fail closed) and writes only with app_rls_bypass().
-- 2. hub_outbox.url is sealed by the code from now on (like hub_callback.original_url): the column comment only.
--
-- Policies only: no rewrite, no data change; brief locks on small hub tables (bounded by MIGRATION_LOCK_TIMEOUT).
-- Nothing reads these tables while HUB_ENABLED=false. Rollback: db/rollback/074_down.sql.

DO $$
DECLARE t text;
BEGIN
  -- one org column
  FOREACH t IN ARRAY ARRAY['hub_member','hub_party','hub_statement','hub_fee_invoice'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_write', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass()) WITH CHECK (app_rls_bypass())', t || '_write', t);
  END LOOP;
  -- two-sided: the CPO's and the eMSP's organisation
  FOREACH t IN ARRAY ARRAY['hub_agreement','hub_cdr','hub_dispute','hub_dispute_note'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_write', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (app_rls_bypass() OR cpo_org_id = app_current_org() OR emsp_org_id = app_current_org())', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass()) WITH CHECK (app_rls_bypass())', t || '_write', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS hub_settlement_position_tenant ON hub_settlement_position;
DROP POLICY IF EXISTS hub_settlement_position_write ON hub_settlement_position;
CREATE POLICY hub_settlement_position_tenant ON hub_settlement_position FOR SELECT
  USING (app_rls_bypass() OR org_a_id = app_current_org() OR org_b_id = app_current_org());
CREATE POLICY hub_settlement_position_write ON hub_settlement_position USING (app_rls_bypass()) WITH CHECK (app_rls_bypass());

DROP POLICY IF EXISTS hub_payment_tenant ON hub_payment;
DROP POLICY IF EXISTS hub_payment_write ON hub_payment;
CREATE POLICY hub_payment_tenant ON hub_payment FOR SELECT
  USING (app_rls_bypass() OR payer_org_id = app_current_org() OR payee_org_id = app_current_org());
CREATE POLICY hub_payment_write ON hub_payment USING (app_rls_bypass()) WITH CHECK (app_rls_bypass());

COMMENT ON COLUMN hub_outbox.url IS 'Target URL of a callback row, sealed (services/secrets.ts, AAD hub_outbox_url:{object_key}); legacy rows may hold it in clear';
