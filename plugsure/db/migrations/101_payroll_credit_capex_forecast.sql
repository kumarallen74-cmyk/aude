-- 101 (v1.33.0) finance phase 22.
--
--   employee                a person on the payroll: NIK, NPWP, PTKP status (TER category), salary and fixed allowances,
--                           BPJS Kesehatan and Ketenagakerjaan, the JKK rate, the bank account (sealed), start and end
--   payroll_run             a month's payroll in a currency: drafted from the employees, approved under the approvals
--                           matrix (kind payroll_run), paid from a cash account; totals
--   payroll_line            one employee's month: salary, allowances, overtime, bonus, BPJS (employee and employer), the
--                           taxable gross, PPh 21 (TER for January to November, the annual Pasal 17 in December), net pay
--   credit_review           a fleet customer's credit review: the score (0–100) and grade from the payment history, the
--                           suggested limit, the decision (by a Finance Manager) and the next review date
--   fleet_account           .credit_hold_at / .credit_hold_reason (a hold on new charging on credit), .next_review_on
--   customer_deposit        security deposits held from fleet customers: received, returned, applied to an invoice
--   capex_project           a site build: budget by category, status, the asset it was capitalised into
--   purchase_order, supplier_bill, fixed_asset   .capex_project_id
--   cash_forecast_run       a day's forecast per currency (kept to measure the forecast's accuracy)
--   finance_org_settings    .payroll {terOverride, jpCap, kesCap}, .cash_forecast {horizonDays, alert, collectionsPct}
--
-- Additive. Rollback: db/rollback/101_down.sql.

ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS payroll JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS cash_forecast JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS employee (
  id                     BIGSERIAL PRIMARY KEY,
  org_id                 UUID NOT NULL REFERENCES organisation(id),
  number                 TEXT NOT NULL,
  name                   TEXT NOT NULL,
  email                  TEXT,
  nik                    TEXT,
  npwp                   TEXT,
  ptkp                   TEXT NOT NULL DEFAULT 'TK/0' CHECK (ptkp IN ('TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3')),
  position               TEXT,
  site_id                UUID REFERENCES site(id),
  currency               TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  base_salary_minor      BIGINT NOT NULL CHECK (base_salary_minor >= 0),
  allowance_minor        BIGINT NOT NULL DEFAULT 0 CHECK (allowance_minor >= 0),
  bpjs_kesehatan         BOOLEAN NOT NULL DEFAULT true,
  bpjs_ketenagakerjaan   BOOLEAN NOT NULL DEFAULT true,
  jkk_rate_pct           NUMERIC(4,2) NOT NULL DEFAULT 0.24 CHECK (jkk_rate_pct >= 0 AND jkk_rate_pct <= 2),
  bank_name              TEXT,
  account_sealed         TEXT,
  account_name           TEXT,
  start_on               DATE NOT NULL,
  end_on                 DATE,
  created_by             UUID REFERENCES app_user(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);

CREATE TABLE IF NOT EXISTS payroll_run (
  id                 BIGSERIAL PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organisation(id),
  month              TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  currency           TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'awaiting_approval', 'approved', 'paid', 'void')),
  totals             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by         UUID REFERENCES app_user(id),
  submitted_by       UUID REFERENCES app_user(id),
  submitted_at       TIMESTAMPTZ,
  first_approved_by  UUID REFERENCES app_user(id),
  first_approved_at  TIMESTAMPTZ,
  approved_by        UUID REFERENCES app_user(id),
  approved_at        TIMESTAMPTZ,
  paid_on            DATE,
  cash_account_id    BIGINT REFERENCES cash_account(id),
  void_reason        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_run_live_uq ON payroll_run (org_id, month, currency) WHERE status <> 'void';

CREATE TABLE IF NOT EXISTS payroll_line (
  id                 BIGSERIAL PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organisation(id),
  run_id             BIGINT NOT NULL REFERENCES payroll_run(id),
  employee_id        BIGINT NOT NULL REFERENCES employee(id),
  base_minor         BIGINT NOT NULL DEFAULT 0,
  allowance_minor    BIGINT NOT NULL DEFAULT 0,
  overtime_minor     BIGINT NOT NULL DEFAULT 0,
  bonus_minor        BIGINT NOT NULL DEFAULT 0,
  deduction_minor    BIGINT NOT NULL DEFAULT 0,
  employer_minor     BIGINT NOT NULL DEFAULT 0,
  employee_bpjs_minor BIGINT NOT NULL DEFAULT 0,
  gross_minor        BIGINT NOT NULL DEFAULT 0,
  pph21_minor        BIGINT NOT NULL DEFAULT 0,
  net_minor          BIGINT NOT NULL DEFAULT 0,
  data               JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (run_id, employee_id)
);

ALTER TABLE fleet_account ADD COLUMN IF NOT EXISTS credit_hold_at TIMESTAMPTZ;
ALTER TABLE fleet_account ADD COLUMN IF NOT EXISTS credit_hold_reason TEXT;
ALTER TABLE fleet_account ADD COLUMN IF NOT EXISTS next_review_on DATE;

CREATE TABLE IF NOT EXISTS credit_review (
  id                 BIGSERIAL PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organisation(id),
  fleet_account_id   UUID NOT NULL REFERENCES fleet_account(id),
  currency           TEXT NOT NULL,
  score              INT NOT NULL CHECK (score BETWEEN 0 AND 100),
  grade              TEXT NOT NULL CHECK (grade IN ('A', 'B', 'C', 'D', 'E')),
  factors            JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_limit_minor   BIGINT NOT NULL DEFAULT 0,
  suggested_limit_minor BIGINT NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected')),
  new_limit_minor    BIGINT,
  hold               BOOLEAN,
  note               TEXT,
  next_review_on     DATE,
  created_by         UUID REFERENCES app_user(id),
  decided_by         UUID REFERENCES app_user(id),
  decided_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_deposit (
  id                 BIGSERIAL PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organisation(id),
  fleet_account_id   UUID NOT NULL REFERENCES fleet_account(id),
  currency           TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  kind               TEXT NOT NULL CHECK (kind IN ('received', 'returned', 'applied')),
  amount_minor       BIGINT NOT NULL CHECK (amount_minor > 0),
  on_date            DATE NOT NULL,
  invoice_id         UUID,
  reference          TEXT,
  note               TEXT,
  cash_account_id    BIGINT REFERENCES cash_account(id),
  created_by         UUID REFERENCES app_user(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at          TIMESTAMPTZ,
  void_reason        TEXT
);

CREATE TABLE IF NOT EXISTS capex_project (
  id                 BIGSERIAL PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organisation(id),
  number             TEXT NOT NULL,
  name               TEXT NOT NULL,
  site_id            UUID REFERENCES site(id),
  currency           TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status             TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'completed', 'cancelled')),
  budget             JSONB NOT NULL DEFAULT '{}'::jsonb,
  start_on           DATE,
  target_on          DATE,
  completed_on       DATE,
  asset_category     TEXT NOT NULL DEFAULT 'chargers',
  life_months        INT NOT NULL DEFAULT 96 CHECK (life_months BETWEEN 1 AND 360),
  asset_id           BIGINT REFERENCES fixed_asset(id),
  note               TEXT,
  created_by         UUID REFERENCES app_user(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
ALTER TABLE purchase_order ADD COLUMN IF NOT EXISTS capex_project_id BIGINT REFERENCES capex_project(id);
ALTER TABLE supplier_bill ADD COLUMN IF NOT EXISTS capex_project_id BIGINT REFERENCES capex_project(id);
ALTER TABLE fixed_asset ADD COLUMN IF NOT EXISTS capex_project_id BIGINT REFERENCES capex_project(id);

-- The ledger's new sources: payroll, customer deposits, capex projects (completed into assets, or written off).
ALTER TABLE gl_entry DROP CONSTRAINT IF EXISTS gl_entry_source_check;
ALTER TABLE gl_entry ADD CONSTRAINT gl_entry_source_check
  CHECK (source IN ('manual', 'gateway', 'assets', 'leases', 'provision', 'bills', 'deposits', 'expenses', 'intercompany', 'reversal', 'payroll', 'customer_deposits', 'projects'));

CREATE TABLE IF NOT EXISTS cash_forecast_run (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organisation(id),
  run_on      DATE NOT NULL,
  currency    TEXT NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, run_on, currency)
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['employee', 'payroll_run', 'payroll_line', 'credit_review', 'customer_deposit', 'capex_project', 'cash_forecast_run'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON employee, payroll_run, payroll_line, credit_review, customer_deposit, capex_project, cash_forecast_run TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON employee, payroll_run, payroll_line, credit_review, customer_deposit, capex_project, cash_forecast_run FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE employee_id_seq, payroll_run_id_seq, payroll_line_id_seq, credit_review_id_seq, customer_deposit_id_seq, capex_project_id_seq, cash_forecast_run_id_seq TO plugsure_app;
  END IF;
END $$;
