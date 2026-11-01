-- 102 (v1.34.0) finance phase 23.
--
--   stock_item            a spare part or consumable: SKU, unit, reorder point and quantity, the moving average cost
--   stock_location        a depot, or a site's store
--   stock_move            receipts (from a purchase order or by hand), issues (to a work order), transfers and counted
--                         adjustments; each at a unit cost (receipts at their price, the rest at the moving average)
--   supplier_bill         .stock: a bill for stock received posts against goods received not invoiced, not expense
--                         .work_order_id: a contractor's bill for a work order
--   work_order            maintenance on a charger or site: corrective, preventive or warranty; labour, parts, contractor
--                         bills; the contractor's estimate (accrued at the month's end until billed)
--   warranty_claim        a claim on the supplier for a work order's cost: submitted, accepted, rejected, paid
--   revenue_finding       revenue assurance: a session not billed, billed at zero, or with energy, meter or price out of
--                         line; the amount expected, recovered, written off or dismissed
--   loan, loan_drawdown, loan_payment   borrowings: terms, drawdowns, repayments (principal and interest)
--   covenant, covenant_test             a lender's covenant (DSCR, leverage, interest cover, minimum cash) and each test
--   gl_entry.source       gains 'inventory', 'maintenance', 'loans'
--
-- Additive. Rollback: db/rollback/102_down.sql.

CREATE TABLE IF NOT EXISTS stock_item (
  id                 BIGSERIAL PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organisation(id),
  sku                TEXT NOT NULL,
  name               TEXT NOT NULL,
  unit               TEXT NOT NULL DEFAULT 'pcs',
  category           TEXT NOT NULL DEFAULT 'part' CHECK (category IN ('part', 'consumable', 'tool')),
  currency           TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reorder_point      NUMERIC(14,3) NOT NULL DEFAULT 0,
  reorder_qty        NUMERIC(14,3) NOT NULL DEFAULT 0,
  avg_cost_minor     NUMERIC(18,4) NOT NULL DEFAULT 0,
  supplier_id        BIGINT REFERENCES supplier(id),
  archived_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, sku)
);

CREATE TABLE IF NOT EXISTS stock_location (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organisation(id),
  name        TEXT NOT NULL,
  site_id     UUID REFERENCES site(id),
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS work_order (
  id                      BIGSERIAL PRIMARY KEY,
  org_id                  UUID NOT NULL REFERENCES organisation(id),
  number                  TEXT NOT NULL,
  kind                    TEXT NOT NULL DEFAULT 'corrective' CHECK (kind IN ('corrective', 'preventive', 'warranty')),
  status                  TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  site_id                 UUID REFERENCES site(id),
  charge_point_id         UUID REFERENCES charge_point(id),
  title                   TEXT NOT NULL,
  description             TEXT,
  currency                TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  opened_on               DATE NOT NULL,
  done_on                 DATE,
  labour_hours            NUMERIC(8,2) NOT NULL DEFAULT 0,
  labour_rate_minor       BIGINT NOT NULL DEFAULT 0,
  contractor_estimate_minor BIGINT NOT NULL DEFAULT 0,
  created_by              UUID REFERENCES app_user(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);

CREATE TABLE IF NOT EXISTS stock_move (
  id                 BIGSERIAL PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organisation(id),
  item_id            BIGINT NOT NULL REFERENCES stock_item(id),
  location_id        BIGINT NOT NULL REFERENCES stock_location(id),
  kind               TEXT NOT NULL CHECK (kind IN ('receipt', 'issue', 'transfer_in', 'transfer_out', 'adjust')),
  qty                NUMERIC(14,3) NOT NULL,
  unit_cost_minor    NUMERIC(18,4) NOT NULL,
  value_minor        BIGINT NOT NULL,
  on_date            DATE NOT NULL,
  purchase_order_id  BIGINT REFERENCES purchase_order(id),
  work_order_id      BIGINT REFERENCES work_order(id),
  transfer_ref       BIGINT,
  note               TEXT,
  created_by         UUID REFERENCES app_user(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_move_item_idx ON stock_move (org_id, item_id, location_id);

ALTER TABLE supplier_bill ADD COLUMN IF NOT EXISTS stock BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE supplier_bill ADD COLUMN IF NOT EXISTS work_order_id BIGINT REFERENCES work_order(id);

CREATE TABLE IF NOT EXISTS warranty_claim (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  work_order_id   BIGINT NOT NULL REFERENCES work_order(id),
  supplier_id     BIGINT NOT NULL REFERENCES supplier(id),
  currency        TEXT NOT NULL,
  amount_minor    BIGINT NOT NULL CHECK (amount_minor > 0),
  status          TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'accepted', 'rejected', 'paid')),
  reference       TEXT,
  note            TEXT,
  submitted_on    DATE NOT NULL,
  decided_on      DATE,
  paid_on         DATE,
  paid_minor      BIGINT,
  created_by      UUID REFERENCES app_user(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS revenue_finding (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  month            TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  kind             TEXT NOT NULL CHECK (kind IN ('unbilled', 'zero_amount', 'energy_mismatch', 'meter_mismatch', 'signed_invalid', 'price_outlier', 'roaming_no_cdr')),
  session_id       UUID NOT NULL,
  site_id          UUID,
  currency         TEXT NOT NULL,
  energy_wh        BIGINT,
  billed_minor     BIGINT NOT NULL DEFAULT 0,
  expected_minor   BIGINT NOT NULL DEFAULT 0,
  detail           JSONB NOT NULL DEFAULT '{}'::jsonb,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'recovered', 'written_off', 'dismissed')),
  recovered_minor  BIGINT,
  note             TEXT,
  reviewed_by      UUID REFERENCES app_user(id),
  reviewed_at      TIMESTAMPTZ,
  found_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, kind, session_id)
);

CREATE TABLE IF NOT EXISTS loan (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  lender           TEXT NOT NULL,
  reference        TEXT,
  currency         TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  facility_minor   BIGINT NOT NULL CHECK (facility_minor > 0),
  rate_pct         NUMERIC(6,3) NOT NULL CHECK (rate_pct >= 0 AND rate_pct <= 50),
  start_on         DATE NOT NULL,
  term_months      INT NOT NULL CHECK (term_months BETWEEN 1 AND 360),
  grace_months     INT NOT NULL DEFAULT 0 CHECK (grace_months >= 0),
  repayment        TEXT NOT NULL DEFAULT 'annuity' CHECK (repayment IN ('annuity', 'equal_principal', 'bullet')),
  cash_account_id  BIGINT REFERENCES cash_account(id),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'repaid', 'void')),
  note             TEXT,
  created_by       UUID REFERENCES app_user(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loan_drawdown (
  id           BIGSERIAL PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES organisation(id),
  loan_id      BIGINT NOT NULL REFERENCES loan(id),
  on_date      DATE NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  reference    TEXT,
  voided_at    TIMESTAMPTZ,
  created_by   UUID REFERENCES app_user(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loan_payment (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  loan_id          BIGINT NOT NULL REFERENCES loan(id),
  on_date          DATE NOT NULL,
  principal_minor  BIGINT NOT NULL DEFAULT 0 CHECK (principal_minor >= 0),
  interest_minor   BIGINT NOT NULL DEFAULT 0 CHECK (interest_minor >= 0),
  fees_minor       BIGINT NOT NULL DEFAULT 0 CHECK (fees_minor >= 0),
  reference        TEXT,
  voided_at        TIMESTAMPTZ,
  created_by       UUID REFERENCES app_user(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS covenant (
  id           BIGSERIAL PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES organisation(id),
  loan_id      BIGINT REFERENCES loan(id),
  kind         TEXT NOT NULL CHECK (kind IN ('dscr', 'leverage', 'interest_cover', 'min_cash')),
  threshold    NUMERIC(18,4) NOT NULL,
  currency     TEXT NOT NULL,
  frequency    TEXT NOT NULL DEFAULT 'quarterly' CHECK (frequency IN ('monthly', 'quarterly')),
  enabled      BOOLEAN NOT NULL DEFAULT true,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS covenant_test (
  id           BIGSERIAL PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES organisation(id),
  covenant_id  BIGINT NOT NULL REFERENCES covenant(id),
  month        TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  value        NUMERIC(18,4),
  passed       BOOLEAN,
  headroom_pct NUMERIC(10,2),
  detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
  tested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (covenant_id, month)
);

ALTER TABLE gl_entry DROP CONSTRAINT IF EXISTS gl_entry_source_check;
ALTER TABLE gl_entry ADD CONSTRAINT gl_entry_source_check
  CHECK (source IN ('manual', 'gateway', 'assets', 'leases', 'provision', 'bills', 'deposits', 'expenses', 'intercompany', 'reversal', 'payroll', 'customer_deposits', 'projects',
                    'inventory', 'maintenance', 'loans'));

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_item', 'stock_location', 'stock_move', 'work_order', 'warranty_claim', 'revenue_finding', 'loan', 'loan_drawdown', 'loan_payment', 'covenant', 'covenant_test'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON stock_item, stock_location, stock_move, work_order, warranty_claim, revenue_finding, loan, loan_drawdown, loan_payment, covenant, covenant_test TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON stock_item, stock_location, stock_move, work_order, warranty_claim, revenue_finding, loan, loan_drawdown, loan_payment, covenant, covenant_test FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE stock_item_id_seq, stock_location_id_seq, stock_move_id_seq, work_order_id_seq, warranty_claim_id_seq, revenue_finding_id_seq, loan_id_seq, loan_drawdown_id_seq,
      loan_payment_id_seq, covenant_id_seq, covenant_test_id_seq TO plugsure_app;
  END IF;
END $$;
