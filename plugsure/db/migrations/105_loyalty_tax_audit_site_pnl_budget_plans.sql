-- 105 (v1.37.0) finance phase 26.
--
--   finance_org_settings  .loyalty_accounting {breakagePct}: a fixed breakage rate instead of the one learned from the
--                         points that expired against those redeemed
--   tax_audit_case        a letter from the tax office (DJP): SP2DK (a request for clarification), an office or field
--                         audit; the year, the taxes, the dates (received, respond by), status, the amounts assessed
--   budget_plan           a year's budget, versioned: draft → submitted → approved (published to Budgets) or rejected;
--                         a later approved version supersedes the one before
--   budget_plan_line      its lines: a site (or the organisation), a month, a category, an amount
--   gl_entry.source       gains 'loyalty'
--
-- Additive. Rollback: db/rollback/105_down.sql.

ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS loyalty_accounting JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS tax_audit_case (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organisation(id),
  kind           TEXT NOT NULL CHECK (kind IN ('sp2dk', 'office_audit', 'field_audit', 'other')),
  letter_no      TEXT NOT NULL,
  tax_year       INT NOT NULL CHECK (tax_year BETWEEN 2000 AND 2100),
  taxes          TEXT[] NOT NULL DEFAULT '{}',
  received_on    DATE NOT NULL,
  respond_by     DATE,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'responded', 'closed_no_change', 'assessed', 'objected', 'paid')),
  assessed_minor BIGINT CHECK (assessed_minor IS NULL OR assessed_minor >= 0),
  currency       TEXT NOT NULL DEFAULT 'IDR' CHECK (currency ~ '^[A-Z]{3}$'),
  responded_on   DATE,
  closed_on      DATE,
  note           TEXT,
  created_by     UUID REFERENCES app_user(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, letter_no)
);

CREATE TABLE IF NOT EXISTS budget_plan (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  year          INT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  version       INT NOT NULL CHECK (version >= 1),
  name          TEXT NOT NULL,
  currency      TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'superseded')),
  seeded_from   TEXT,
  note          TEXT,
  created_by    UUID REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_by  UUID REFERENCES app_user(id),
  submitted_at  TIMESTAMPTZ,
  decided_by    UUID REFERENCES app_user(id),
  decided_at    TIMESTAMPTZ,
  decision_note TEXT,
  UNIQUE (org_id, year, currency, version)
);

CREATE TABLE IF NOT EXISTS budget_plan_line (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  plan_id       BIGINT NOT NULL REFERENCES budget_plan(id),
  site_id       UUID REFERENCES site(id),
  month         TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  category      TEXT NOT NULL CHECK (category IN ('revenue', 'energy_cost', 'rent', 'maintenance', 'insurance', 'staff', 'marketing', 'it', 'other_opex', 'capex')),
  amount_minor  BIGINT NOT NULL CHECK (amount_minor >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS budget_plan_line_uq ON budget_plan_line (plan_id, COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid), month, category);

ALTER TABLE gl_entry DROP CONSTRAINT IF EXISTS gl_entry_source_check;
ALTER TABLE gl_entry ADD CONSTRAINT gl_entry_source_check
  CHECK (source IN ('manual', 'gateway', 'assets', 'leases', 'provision', 'bills', 'deposits', 'expenses', 'intercompany', 'reversal', 'payroll', 'customer_deposits', 'projects',
                    'inventory', 'maintenance', 'loans', 'carbon', 'insurance', 'grants', 'landlords', 'chargebacks', 'loyalty'));

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['tax_audit_case', 'budget_plan', 'budget_plan_line'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON tax_audit_case, budget_plan, budget_plan_line TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON tax_audit_case, budget_plan, budget_plan_line FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE tax_audit_case_id_seq, budget_plan_id_seq, budget_plan_line_id_seq TO plugsure_app;
  END IF;
END $$;
