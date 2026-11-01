-- 108 (v1.40.0) finance phase 29.
--
--   customer_contract       a customer contract (fleet, B2B charging-as-a-service, hardware with service): the
--                           customer, the term, the currency, its status, the renewal notice
--   contract_obligation     a performance obligation: what is promised, its share of the price, recognised over its
--                           months (ratably) or when delivered (point in time)
--   contract_billing        what was invoiced under the contract, and when it was paid (to which account)
--   intercompany_recharge   gains tp_kind (the transfer-pricing category) and cost_minor (the cost underneath)
--   tp_policy               the group's transfer-pricing policy per kind: method and the arm's-length mark-up range
--   dq_run                  each finance data-quality run: the score and what was found
--   finance_scenario        a what-if scenario on the forecast: its assumptions
--   gl_entry.source         gains 'contracts'
--
-- Additive. Rollback: db/rollback/108_down.sql.

CREATE TABLE IF NOT EXISTS customer_contract (
  id                  BIGSERIAL PRIMARY KEY,
  org_id              UUID NOT NULL REFERENCES organisation(id),
  number              TEXT NOT NULL,
  customer            TEXT NOT NULL,
  fleet_account_id    UUID REFERENCES fleet_account(id),
  currency            TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  start_on            DATE NOT NULL,
  end_on              DATE NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'ended', 'cancelled')),
  renewal_notice_days INT NOT NULL DEFAULT 60 CHECK (renewal_notice_days BETWEEN 0 AND 365),
  note                TEXT,
  created_by          UUID REFERENCES app_user(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_on >= start_on),
  UNIQUE (org_id, number)
);

CREATE TABLE IF NOT EXISTS contract_obligation (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  contract_id   BIGINT NOT NULL REFERENCES customer_contract(id),
  description   TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('subscription', 'service', 'hardware', 'installation', 'other')),
  amount_minor  BIGINT NOT NULL CHECK (amount_minor >= 0),
  recognition   TEXT NOT NULL CHECK (recognition IN ('ratably', 'point_in_time')),
  start_month   TEXT CHECK (start_month IS NULL OR start_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  end_month     TEXT CHECK (end_month IS NULL OR end_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  delivered_on  DATE,
  removed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS contract_obligation_contract_idx ON contract_obligation (contract_id);

CREATE TABLE IF NOT EXISTS contract_billing (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  contract_id     BIGINT NOT NULL REFERENCES customer_contract(id),
  billed_on       DATE NOT NULL,
  amount_minor    BIGINT NOT NULL CHECK (amount_minor > 0),
  reference       TEXT,
  paid_on         DATE,
  cash_account_id BIGINT REFERENCES cash_account(id),
  voided_at       TIMESTAMPTZ,
  created_by      UUID REFERENCES app_user(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contract_billing_contract_idx ON contract_billing (contract_id);

ALTER TABLE intercompany_recharge ADD COLUMN IF NOT EXISTS tp_kind TEXT;
ALTER TABLE intercompany_recharge ADD COLUMN IF NOT EXISTS cost_minor BIGINT CHECK (cost_minor IS NULL OR cost_minor >= 0);

CREATE TABLE IF NOT EXISTS tp_policy (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organisation(id),
  kind        TEXT NOT NULL,
  method      TEXT NOT NULL CHECK (method IN ('cost_plus', 'pass_through', 'cup')),
  markup_pct  NUMERIC(6,2) NOT NULL DEFAULT 0,
  min_pct     NUMERIC(6,2) NOT NULL DEFAULT 0,
  max_pct     NUMERIC(6,2) NOT NULL DEFAULT 0,
  note        TEXT,
  updated_by  UUID REFERENCES app_user(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (min_pct <= max_pct),
  UNIQUE (org_id, kind)
);

CREATE TABLE IF NOT EXISTS dq_run (
  id         BIGSERIAL PRIMARY KEY,
  org_id     UUID NOT NULL REFERENCES organisation(id),
  run_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  score      INT NOT NULL CHECK (score BETWEEN 0 AND 100),
  findings   JSONB NOT NULL DEFAULT '[]'::jsonb,
  counts     JSONB NOT NULL DEFAULT '{}'::jsonb,
  run_by     UUID REFERENCES app_user(id)
);
CREATE INDEX IF NOT EXISTS dq_run_org_idx ON dq_run (org_id, run_at DESC);

CREATE TABLE IF NOT EXISTS finance_scenario (
  id           BIGSERIAL PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES organisation(id),
  name         TEXT NOT NULL,
  currency     TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  assumptions  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by   UUID REFERENCES app_user(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at  TIMESTAMPTZ
);

ALTER TABLE gl_entry DROP CONSTRAINT IF EXISTS gl_entry_source_check;
ALTER TABLE gl_entry ADD CONSTRAINT gl_entry_source_check
  CHECK (source IN ('manual', 'gateway', 'assets', 'leases', 'provision', 'bills', 'deposits', 'expenses', 'intercompany', 'reversal', 'payroll', 'customer_deposits', 'projects',
                    'inventory', 'maintenance', 'loans', 'carbon', 'insurance', 'grants', 'landlords', 'chargebacks', 'loyalty', 'fx', 'tax', 'cards', 'contracts'));

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['customer_contract', 'contract_obligation', 'contract_billing', 'tp_policy', 'dq_run', 'finance_scenario'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON customer_contract, contract_obligation, contract_billing, tp_policy, dq_run, finance_scenario TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON customer_contract, contract_obligation, contract_billing, tp_policy, dq_run, finance_scenario FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE customer_contract_id_seq, contract_obligation_id_seq, contract_billing_id_seq, tp_policy_id_seq, dq_run_id_seq, finance_scenario_id_seq TO plugsure_app;
  END IF;
END $$;
