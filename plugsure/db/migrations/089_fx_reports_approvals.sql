-- 089 (v1.21.0) finance phase 10.
--
--   finance_org_settings.reporting_currency   the currency consolidated totals are shown in (NULL: none)
--   finance_org_settings.approval_rules       the approvals matrix: per kind (refund, payout, write_off, bank_change)
--                                             {above, rule}: above the amount (in the minor unit; bank_change: always),
--                                             rule 'finance_approver' (the approver holds finance:approve) or
--                                             'two_approvers' (two different people, neither the requester)
--   fx_rate                                   the month's rate from a currency to the reporting currency
--   finance_report_schedule                   reports e-mailed weekly or monthly as Excel
--   first_approved_by / _at                   the first of two approvals, on refund_transfer, payout_transfer,
--                                             receivable_write_off and owner_bank_change_request
--
-- Additive. Rollback: db/rollback/089_down.sql.

ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS reporting_currency TEXT CHECK (reporting_currency IS NULL OR reporting_currency ~ '^[A-Z]{3}$');
ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS approval_rules JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE refund_transfer ADD COLUMN IF NOT EXISTS first_approved_by UUID REFERENCES app_user(id);
ALTER TABLE refund_transfer ADD COLUMN IF NOT EXISTS first_approved_at TIMESTAMPTZ;
ALTER TABLE payout_transfer ADD COLUMN IF NOT EXISTS first_approved_by UUID REFERENCES app_user(id);
ALTER TABLE payout_transfer ADD COLUMN IF NOT EXISTS first_approved_at TIMESTAMPTZ;
ALTER TABLE receivable_write_off ADD COLUMN IF NOT EXISTS first_approved_by UUID REFERENCES app_user(id);
ALTER TABLE receivable_write_off ADD COLUMN IF NOT EXISTS first_approved_at TIMESTAMPTZ;
ALTER TABLE owner_bank_change_request ADD COLUMN IF NOT EXISTS first_approved_by UUID REFERENCES app_user(id);
ALTER TABLE owner_bank_change_request ADD COLUMN IF NOT EXISTS first_approved_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS fx_rate (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organisation(id),
  month       TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  currency    TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reporting   TEXT NOT NULL CHECK (reporting ~ '^[A-Z]{3}$'),
  rate        NUMERIC(20,8) NOT NULL CHECK (rate > 0),
  source      TEXT NOT NULL CHECK (source IN ('manual', 'ecb')),
  updated_by  UUID REFERENCES app_user(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, month, currency, reporting)
);

CREATE TABLE IF NOT EXISTS finance_report_schedule (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  name            TEXT NOT NULL,
  reports         TEXT[] NOT NULL CHECK (reports <@ ARRAY['summary', 'margin', 'collections', 'budgets', 'forecast']::text[] AND cardinality(reports) > 0),
  frequency       TEXT NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
  weekday         INT CHECK (weekday IS NULL OR weekday BETWEEN 1 AND 7),
  recipients      TEXT[] NOT NULL,
  integration_id  UUID REFERENCES integration(id),
  enabled         BOOLEAN NOT NULL DEFAULT true,
  last_sent_at    TIMESTAMPTZ,
  last_period     TEXT,
  last_error      TEXT,
  created_by      UUID REFERENCES app_user(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS finance_report_schedule_org_idx ON finance_report_schedule (org_id) WHERE archived_at IS NULL;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['fx_rate', 'finance_report_schedule'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON fx_rate, finance_report_schedule TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON fx_rate, finance_report_schedule FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE fx_rate_id_seq, finance_report_schedule_id_seq TO plugsure_app;
  END IF;
END $$;
