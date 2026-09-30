-- 013: platform commission and fee statements
--
-- The published commercial model (plugsure.com/pricing):
--   public, paid charging  commission on gross transaction value per site and
--                          month, tiered 8% / 6.5% / 5%, with a minimum per
--                          charger credited against commission
--   private charging       flat platform fee per charger (AC / DC)
-- The CSMS computed none of it. The commission base is the session SUBTOTAL
-- (energy, service, admin and idle fees) — PBJT-TL and PPN are taxes the site
-- owner collects for the state and are excluded.
--
--   commercial_plan       the rates agreed with each customer organisation, one
--                         row per version, effective from a month; set by the
--                         platform operator only (platform:admin). A month is
--                         billed at the version in force for that month, so a
--                         rate change never re-prices a month already worked.
--   site.billing_model    public (commission) or private (platform fee)
--   commission_statement  a month's statement, frozen when finalised

CREATE TABLE IF NOT EXISTS commercial_plan (
  org_id          UUID NOT NULL REFERENCES organisation(id),
  effective_from  DATE NOT NULL,                 -- first day of a month
  plan            JSONB NOT NULL,                -- {"published": true} = follow the published rates
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      UUID,
  PRIMARY KEY (org_id, effective_from)
);
-- Re-runnable: bring a table created without versions to this shape.
ALTER TABLE commercial_plan ADD COLUMN IF NOT EXISTS effective_from DATE NOT NULL DEFAULT DATE '2000-01-01';
ALTER TABLE commercial_plan ALTER COLUMN effective_from DROP DEFAULT;
ALTER TABLE commercial_plan DROP CONSTRAINT IF EXISTS commercial_plan_pkey;
ALTER TABLE commercial_plan ADD PRIMARY KEY (org_id, effective_from);

ALTER TABLE site
  ADD COLUMN IF NOT EXISTS billing_model TEXT NOT NULL DEFAULT 'public';
ALTER TABLE site DROP CONSTRAINT IF EXISTS site_billing_model_chk;
ALTER TABLE site ADD CONSTRAINT site_billing_model_chk CHECK (billing_model IN ('public', 'private'));
COMMENT ON COLUMN site.billing_model IS
  'public = drivers pay, platform takes commission on the session subtotal; private = no driver payment, flat platform fee per charger. Set by the platform operator.';

CREATE TABLE IF NOT EXISTS commission_statement (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organisation(id),
  period             DATE NOT NULL,              -- first day of the month
  number             TEXT NOT NULL UNIQUE,
  gtv_idr            BIGINT NOT NULL,
  commission_idr     BIGINT NOT NULL,
  minimum_topup_idr  BIGINT NOT NULL,
  private_fee_idr    BIGINT NOT NULL,
  mdr_credit_idr     BIGINT NOT NULL,
  net_idr            BIGINT NOT NULL,
  ppn_idr            BIGINT NOT NULL,
  total_idr          BIGINT NOT NULL,
  data               JSONB NOT NULL,             -- the full statement as issued
  finalised_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalised_by       UUID,
  UNIQUE (org_id, period)
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['commercial_plan','commission_statement']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$I_tenant ON %1$I', t);
    EXECUTE format($f$
      CREATE POLICY %1$I_tenant ON %1$I
        USING (app_current_org() IS NULL OR org_id = app_current_org())
        WITH CHECK (app_current_org() IS NULL OR org_id = app_current_org())
    $f$, t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
