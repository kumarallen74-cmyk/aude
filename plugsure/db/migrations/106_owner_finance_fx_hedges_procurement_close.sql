-- 106 (v1.38.0) finance phase 27.
--
--   fx_hedge               a forward contract: buy a currency against another at an agreed rate on a date; marked to
--                          the month's rate while open; settled with the rate of the day (the realised result posts)
--   procurement_saving     a negotiated saving: supplier, category, the price before and after per unit, the quantity
--                          expected over a period
--   close_assignment       who owns each step of the month close, and by which working day after the month's end
--   close_run              each automated run of the close for a month: what it did and what is still blocking
--   finance_org_settings   .close_automation {enabled, runOnDay}
--   gl_entry.source        gains 'fx'
--
-- Additive. Rollback: db/rollback/106_down.sql.

ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS close_automation JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS fx_hedge (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  bank            TEXT NOT NULL,
  reference       TEXT,
  buy_currency    TEXT NOT NULL CHECK (buy_currency ~ '^[A-Z]{3}$'),
  sell_currency   TEXT NOT NULL CHECK (sell_currency ~ '^[A-Z]{3}$'),
  notional_minor  BIGINT NOT NULL CHECK (notional_minor > 0),
  rate            NUMERIC(18,8) NOT NULL CHECK (rate > 0),
  trade_on        DATE NOT NULL,
  maturity_on     DATE NOT NULL,
  purpose         TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'cancelled')),
  settled_on      DATE,
  settled_rate    NUMERIC(18,8) CHECK (settled_rate IS NULL OR settled_rate > 0),
  cash_account_id BIGINT REFERENCES cash_account(id),
  created_by      UUID REFERENCES app_user(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (buy_currency <> sell_currency),
  CHECK (maturity_on >= trade_on)
);

CREATE TABLE IF NOT EXISTS procurement_saving (
  id                    BIGSERIAL PRIMARY KEY,
  org_id                UUID NOT NULL REFERENCES organisation(id),
  supplier_id           BIGINT REFERENCES supplier(id),
  category              TEXT NOT NULL,
  description           TEXT NOT NULL,
  currency              TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  baseline_unit_minor   BIGINT NOT NULL CHECK (baseline_unit_minor >= 0),
  negotiated_unit_minor BIGINT NOT NULL CHECK (negotiated_unit_minor >= 0),
  quantity              NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  period_from           DATE NOT NULL,
  period_to             DATE NOT NULL,
  voided_at             TIMESTAMPTZ,
  created_by            UUID REFERENCES app_user(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from)
);

CREATE TABLE IF NOT EXISTS close_assignment (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organisation(id),
  step        TEXT NOT NULL,
  owner_id    UUID REFERENCES app_user(id),
  due_day     INT NOT NULL DEFAULT 3 CHECK (due_day BETWEEN 1 AND 20),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, step)
);

CREATE TABLE IF NOT EXISTS close_run (
  id           BIGSERIAL PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES organisation(id),
  month        TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  run_by       UUID REFERENCES app_user(id),
  automatic    BOOLEAN NOT NULL DEFAULT false,
  actions      JSONB NOT NULL DEFAULT '[]'::jsonb,
  blocking     INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS close_run_org_month_idx ON close_run (org_id, month, started_at DESC);

ALTER TABLE gl_entry DROP CONSTRAINT IF EXISTS gl_entry_source_check;
ALTER TABLE gl_entry ADD CONSTRAINT gl_entry_source_check
  CHECK (source IN ('manual', 'gateway', 'assets', 'leases', 'provision', 'bills', 'deposits', 'expenses', 'intercompany', 'reversal', 'payroll', 'customer_deposits', 'projects',
                    'inventory', 'maintenance', 'loans', 'carbon', 'insurance', 'grants', 'landlords', 'chargebacks', 'loyalty', 'fx'));

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['fx_hedge', 'procurement_saving', 'close_assignment', 'close_run'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON fx_hedge, procurement_saving, close_assignment, close_run TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON fx_hedge, procurement_saving, close_assignment, close_run FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE fx_hedge_id_seq, procurement_saving_id_seq, close_assignment_id_seq, close_run_id_seq TO plugsure_app;
  END IF;
END $$;
