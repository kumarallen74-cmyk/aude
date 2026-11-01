-- 096 (v1.28.0) finance phase 17.
--
--   driver_funds_breakage       unused driver balances whose refund window has closed, recognised as revenue for a
--                               month (once per month and currency), with the payments counted
--   consolidation_elimination   intercompany amounts eliminated from a group's consolidated P&L for a month (the
--                               group is the parent organisation and its subsidiaries, organisation.parent_org_id)
--   payment_plan                an instalment plan agreed with a fleet customer for an overdue invoice
--   payment_plan_instalment     each instalment: due date, amount, what was paid, when, the reference
--   bad_debt_provision          a month's provision for doubtful receivables per currency, from the aging and the
--                               rates: the provision, the previous one, the movement (the month-end journal)
--   finance_org_settings        forecast (scenario defaults and the variance alert), provision_rates and driver_funds
--                               (after how many days an unused balance is breakage)
--
-- Additive. Rollback: db/rollback/096_down.sql.

ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS forecast JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS provision_rates JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS driver_funds JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS driver_funds_breakage (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  month         TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  currency      TEXT NOT NULL,
  amount_minor  BIGINT NOT NULL CHECK (amount_minor >= 0),
  payments      INT NOT NULL DEFAULT 0,
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_by   UUID REFERENCES app_user(id),
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, month, currency)
);

CREATE TABLE IF NOT EXISTS consolidation_elimination (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  month         TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  kind          TEXT NOT NULL CHECK (kind IN ('revenue', 'cost')),
  description   TEXT NOT NULL,
  amount_minor  BIGINT NOT NULL CHECK (amount_minor > 0),
  currency      TEXT NOT NULL,
  recorded_by   UUID REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at     TIMESTAMPTZ,
  voided_by     UUID REFERENCES app_user(id),
  void_reason   TEXT
);
CREATE INDEX IF NOT EXISTS consolidation_elimination_idx ON consolidation_elimination (org_id, month) WHERE voided_at IS NULL;

CREATE TABLE IF NOT EXISTS payment_plan (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  invoice_id    UUID NOT NULL REFERENCES fleet_invoice(id),
  currency      TEXT NOT NULL,
  total_minor   BIGINT NOT NULL CHECK (total_minor > 0),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'defaulted', 'cancelled')),
  grace_days    INT NOT NULL DEFAULT 7 CHECK (grace_days BETWEEN 0 AND 60),
  note          TEXT,
  created_by    UUID REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ,
  end_reason    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_plan_active_uq ON payment_plan (invoice_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS payment_plan_instalment (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  plan_id       BIGINT NOT NULL REFERENCES payment_plan(id),
  seq           INT NOT NULL,
  due_date      DATE NOT NULL,
  amount_minor  BIGINT NOT NULL CHECK (amount_minor > 0),
  paid_minor    BIGINT NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  paid_on       DATE,
  reference     TEXT,
  reminded_at   TIMESTAMPTZ,
  UNIQUE (plan_id, seq)
);

CREATE TABLE IF NOT EXISTS bad_debt_provision (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  month            TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  currency         TEXT NOT NULL,
  provision_minor  BIGINT NOT NULL CHECK (provision_minor >= 0),
  previous_minor   BIGINT NOT NULL DEFAULT 0,
  movement_minor   BIGINT NOT NULL,
  data             JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_by      UUID REFERENCES app_user(id),
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, month, currency)
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['driver_funds_breakage', 'consolidation_elimination', 'payment_plan', 'payment_plan_instalment', 'bad_debt_provision'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON driver_funds_breakage, consolidation_elimination, payment_plan, payment_plan_instalment, bad_debt_provision TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON driver_funds_breakage, consolidation_elimination, payment_plan, payment_plan_instalment, bad_debt_provision FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE driver_funds_breakage_id_seq, consolidation_elimination_id_seq, payment_plan_id_seq, payment_plan_instalment_id_seq, bad_debt_provision_id_seq TO plugsure_app;
  END IF;
END $$;
