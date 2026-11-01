-- 098 (v1.30.0) finance phase 19.
--
--   purchase_order          an order to a supplier: number, site, currency, expected date; submitted, approved by a second
--                           person (the approvals matrix, kind purchase_order), closed or cancelled
--   purchase_order_line     what is ordered: description, quantity, unit price; what has been received
--   goods_receipt           a receipt against a line: quantity, date, note (who received it)
--   supplier_bill           .purchase_order_id: the order a bill is for (the three-way match: ordered, received, billed)
--   lease                   a lease the operator holds (a site's land or parking, a transformer): the payment, its timing,
--                           the term, the discount rate; a right-of-use asset and a lease liability (PSAK 73); ended early
--   lease_run               a month's lease journal recorded per currency
--   deposit                 a time deposit placed from a cash account: principal, rate, dates, the final tax on its
--                           interest; matured (with the interest received) or broken
--   finance_check_finding   what the anomaly checks found (duplicate bills, round amounts, out-of-hours entries, large
--                           bills from new suppliers, split bills): open, dismissed with a note, or confirmed; cleared
--                           when the condition is gone
--   finance_org_settings    procurement {tolerancePct}, treasury {indicativeRatePct, minimumIdle}, finance_checks
--                           {roundAmount, newSupplierAmount, newSupplierDays, disabled}
--
-- Additive. Rollback: db/rollback/098_down.sql.

ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS procurement JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS treasury JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS finance_checks JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS purchase_order (
  id                 BIGSERIAL PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organisation(id),
  supplier_id        BIGINT NOT NULL REFERENCES supplier(id),
  number             TEXT NOT NULL,
  site_id            UUID REFERENCES site(id),
  currency           TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  description        TEXT NOT NULL,
  expected_on        DATE,
  status             TEXT NOT NULL DEFAULT 'awaiting_approval' CHECK (status IN ('draft', 'awaiting_approval', 'approved', 'closed', 'cancelled', 'rejected')),
  submitted_by       UUID REFERENCES app_user(id),
  submitted_at       TIMESTAMPTZ,
  first_approved_by  UUID REFERENCES app_user(id),
  first_approved_at  TIMESTAMPTZ,
  approved_by        UUID REFERENCES app_user(id),
  approved_at        TIMESTAMPTZ,
  closed_at          TIMESTAMPTZ,
  end_reason         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE INDEX IF NOT EXISTS purchase_order_open_idx ON purchase_order (org_id, status);

CREATE TABLE IF NOT EXISTS purchase_order_line (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  order_id        BIGINT NOT NULL REFERENCES purchase_order(id),
  seq             INT NOT NULL,
  description     TEXT NOT NULL,
  quantity        NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  unit_price_minor BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  received_qty    NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  UNIQUE (order_id, seq)
);

CREATE TABLE IF NOT EXISTS goods_receipt (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  order_id      BIGINT NOT NULL REFERENCES purchase_order(id),
  line_id       BIGINT NOT NULL REFERENCES purchase_order_line(id),
  quantity      NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  received_on   DATE NOT NULL,
  note          TEXT,
  recorded_by   UUID REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE supplier_bill ADD COLUMN IF NOT EXISTS purchase_order_id BIGINT REFERENCES purchase_order(id);
CREATE INDEX IF NOT EXISTS supplier_bill_po_idx ON supplier_bill (purchase_order_id) WHERE purchase_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS lease (
  id                    BIGSERIAL PRIMARY KEY,
  org_id                UUID NOT NULL REFERENCES organisation(id),
  description           TEXT NOT NULL,
  site_id               UUID REFERENCES site(id),
  supplier_id           BIGINT REFERENCES supplier(id),
  currency              TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  start_month           TEXT NOT NULL CHECK (start_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  term_months           INT NOT NULL CHECK (term_months BETWEEN 1 AND 600),
  payment_minor         BIGINT NOT NULL CHECK (payment_minor > 0),
  frequency             TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly', 'quarterly', 'yearly')),
  timing                TEXT NOT NULL DEFAULT 'advance' CHECK (timing IN ('advance', 'arrears')),
  rate_pct              NUMERIC(6,3) NOT NULL CHECK (rate_pct >= 0 AND rate_pct <= 50),
  direct_costs_minor    BIGINT NOT NULL DEFAULT 0 CHECK (direct_costs_minor >= 0),
  exempt                TEXT CHECK (exempt IN ('short_term', 'low_value')),
  ended_month           TEXT CHECK (ended_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  end_note              TEXT,
  recorded_by           UUID REFERENCES app_user(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at             TIMESTAMPTZ,
  voided_by             UUID REFERENCES app_user(id),
  void_reason           TEXT
);

CREATE TABLE IF NOT EXISTS lease_run (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  month         TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  currency      TEXT NOT NULL,
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_by   UUID REFERENCES app_user(id),
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, month, currency)
);

CREATE TABLE IF NOT EXISTS deposit (
  id                       BIGSERIAL PRIMARY KEY,
  org_id                   UUID NOT NULL REFERENCES organisation(id),
  cash_account_id          BIGINT NOT NULL REFERENCES cash_account(id),
  bank_name                TEXT NOT NULL,
  reference                TEXT,
  currency                 TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  principal_minor          BIGINT NOT NULL CHECK (principal_minor > 0),
  rate_pct                 NUMERIC(6,3) NOT NULL CHECK (rate_pct >= 0 AND rate_pct <= 30),
  tax_pct                  NUMERIC(5,2) NOT NULL DEFAULT 20 CHECK (tax_pct >= 0 AND tax_pct <= 50),
  placed_on                DATE NOT NULL,
  maturity_on              DATE NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'matured', 'broken')),
  closed_on                DATE,
  interest_received_minor  BIGINT CHECK (interest_received_minor >= 0),
  penalty_minor            BIGINT NOT NULL DEFAULT 0 CHECK (penalty_minor >= 0),
  rolled_from              BIGINT REFERENCES deposit(id),
  note                     TEXT,
  recorded_by              UUID REFERENCES app_user(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (maturity_on > placed_on)
);
CREATE INDEX IF NOT EXISTS deposit_active_idx ON deposit (org_id, maturity_on) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS finance_check_finding (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  check_kind    TEXT NOT NULL,
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  message       TEXT NOT NULL,
  data          JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'confirmed', 'cleared')),
  found_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by   UUID REFERENCES app_user(id),
  reviewed_at   TIMESTAMPTZ,
  review_note   TEXT,
  UNIQUE (org_id, check_kind, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS finance_check_finding_open_idx ON finance_check_finding (org_id, status);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_order', 'purchase_order_line', 'goods_receipt', 'lease', 'lease_run', 'deposit', 'finance_check_finding'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON purchase_order, purchase_order_line, goods_receipt, lease, lease_run, deposit, finance_check_finding TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON purchase_order, purchase_order_line, goods_receipt, lease, lease_run, deposit, finance_check_finding FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE purchase_order_id_seq, purchase_order_line_id_seq, goods_receipt_id_seq, lease_id_seq, lease_run_id_seq, deposit_id_seq, finance_check_finding_id_seq TO plugsure_app;
  END IF;
END $$;
