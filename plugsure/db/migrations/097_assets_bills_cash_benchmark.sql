-- 097 (v1.29.0) finance phase 18.
--
--   fixed_asset             the asset register: chargers and site equipment (and anything else the operator owns), with
--                           cost, residual value, the month it goes into service, its life and method (straight line or
--                           declining balance), and its disposal (date, proceeds); optionally from a site investment
--                           (v1.22.0) or a supplier bill
--   fixed_asset_run         a month's depreciation recorded per currency (the month-end journal: expense and
--                           accumulated depreciation by category, and the month's disposals)
--   supplier                the operator's suppliers: installers, maintenance, landlords, the utility, with NPWP, bank
--                           details and payment terms
--   supplier_bill           a supplier's bill: number, date, due date, category, site, subtotal, PPN, PPh 23 withheld;
--                           submitted, then approved by a second person (the approvals matrix, kind supplier_bill)
--   supplier_payment        what was paid on a bill: date, amount, method, reference, the cash account
--   cash_account            the operator's bank and cash accounts (gateway balances come from the gateway's snapshots),
--                           with an opening balance and a minimum to alert below
--   cash_balance            a balance taken for an account on a day (by hand, or read from a bank statement)
--   cash_transfer           money moved between two of the operator's accounts
--   bank_statement          .cash_account_id: the account the statement is of (its last balance is the account's)
--   bank_statement_line     matched_kind gains 'supplier_payment'
--   finance_org_settings    .fixed_assets {accounts}: the journal's account codes for assets and depreciation
--
-- Additive. Rollback: db/rollback/097_down.sql.

ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS fixed_assets JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS supplier (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  name            TEXT NOT NULL,
  tax_id          TEXT,
  email           TEXT,
  phone           TEXT,
  bank_name       TEXT,
  account_number  TEXT,
  account_name    TEXT,
  terms_days      INT NOT NULL DEFAULT 30 CHECK (terms_days BETWEEN 0 AND 180),
  wht_pct         NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (wht_pct >= 0 AND wht_pct <= 30),
  note            TEXT,
  created_by      UUID REFERENCES app_user(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_name_uq ON supplier (org_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS cash_account (
  id                    BIGSERIAL PRIMARY KEY,
  org_id                UUID NOT NULL REFERENCES organisation(id),
  name                  TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('bank', 'cash')),
  bank_name             TEXT,
  account_hint          TEXT,
  currency              TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  opening_balance_minor BIGINT NOT NULL DEFAULT 0,
  opening_on            DATE NOT NULL,
  minimum_minor         BIGINT,
  created_by            UUID REFERENCES app_user(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS cash_balance (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organisation(id),
  account_id     BIGINT NOT NULL REFERENCES cash_account(id),
  on_date        DATE NOT NULL,
  balance_minor  BIGINT NOT NULL,
  note           TEXT,
  recorded_by    UUID REFERENCES app_user(id),
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, on_date)
);

CREATE TABLE IF NOT EXISTS cash_transfer (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  from_account_id  BIGINT NOT NULL REFERENCES cash_account(id),
  to_account_id    BIGINT NOT NULL REFERENCES cash_account(id),
  amount_minor     BIGINT NOT NULL CHECK (amount_minor > 0),
  on_date          DATE NOT NULL,
  reference        TEXT,
  note             TEXT,
  recorded_by      UUID REFERENCES app_user(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at        TIMESTAMPTZ,
  voided_by        UUID REFERENCES app_user(id),
  void_reason      TEXT,
  CHECK (from_account_id <> to_account_id)
);
CREATE INDEX IF NOT EXISTS cash_transfer_idx ON cash_transfer (org_id, on_date) WHERE voided_at IS NULL;

CREATE TABLE IF NOT EXISTS supplier_bill (
  id                 BIGSERIAL PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organisation(id),
  supplier_id        BIGINT NOT NULL REFERENCES supplier(id),
  number             TEXT NOT NULL,
  category           TEXT NOT NULL CHECK (category IN ('energy', 'maintenance', 'rent', 'installation', 'equipment', 'connectivity', 'services', 'other')),
  site_id            UUID REFERENCES site(id),
  description        TEXT NOT NULL,
  currency           TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor     BIGINT NOT NULL CHECK (subtotal_minor > 0),
  vat_minor          BIGINT NOT NULL DEFAULT 0 CHECK (vat_minor >= 0),
  wht_minor          BIGINT NOT NULL DEFAULT 0 CHECK (wht_minor >= 0),
  bill_date          DATE NOT NULL,
  due_date           DATE NOT NULL,
  capitalise         BOOLEAN NOT NULL DEFAULT false,
  life_months        INT CHECK (life_months BETWEEN 1 AND 360),
  status             TEXT NOT NULL DEFAULT 'awaiting_approval' CHECK (status IN ('draft', 'awaiting_approval', 'approved', 'paid', 'rejected', 'void')),
  submitted_by       UUID REFERENCES app_user(id),
  submitted_at       TIMESTAMPTZ,
  first_approved_by  UUID REFERENCES app_user(id),
  first_approved_at  TIMESTAMPTZ,
  approved_by        UUID REFERENCES app_user(id),
  approved_at        TIMESTAMPTZ,
  rejected_reason    TEXT,
  void_reason        TEXT,
  voided_at          TIMESTAMPTZ,
  voided_by          UUID REFERENCES app_user(id),
  paid_at            DATE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (wht_minor <= subtotal_minor),
  CHECK (due_date >= bill_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_bill_number_uq ON supplier_bill (supplier_id, lower(number)) WHERE status <> 'void';
CREATE INDEX IF NOT EXISTS supplier_bill_open_idx ON supplier_bill (org_id, due_date) WHERE status IN ('awaiting_approval', 'approved');

CREATE TABLE IF NOT EXISTS supplier_payment (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  bill_id          BIGINT NOT NULL REFERENCES supplier_bill(id),
  paid_on          DATE NOT NULL,
  amount_minor     BIGINT NOT NULL CHECK (amount_minor > 0),
  method           TEXT NOT NULL DEFAULT 'bank_transfer' CHECK (method IN ('bank_transfer', 'cash', 'card', 'other')),
  reference        TEXT,
  cash_account_id  BIGINT REFERENCES cash_account(id),
  recorded_by      UUID REFERENCES app_user(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at        TIMESTAMPTZ,
  voided_by        UUID REFERENCES app_user(id),
  void_reason      TEXT
);
CREATE INDEX IF NOT EXISTS supplier_payment_bill_idx ON supplier_payment (bill_id) WHERE voided_at IS NULL;

CREATE TABLE IF NOT EXISTS fixed_asset (
  id                     BIGSERIAL PRIMARY KEY,
  org_id                 UUID NOT NULL REFERENCES organisation(id),
  tag                    TEXT NOT NULL,
  category               TEXT NOT NULL CHECK (category IN ('chargers', 'installation', 'grid', 'equipment', 'vehicles', 'it', 'other')),
  description            TEXT NOT NULL,
  site_id                UUID REFERENCES site(id),
  charge_point_id        UUID REFERENCES charge_point(id),
  currency               TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  cost_minor             BIGINT NOT NULL CHECK (cost_minor > 0),
  residual_minor         BIGINT NOT NULL DEFAULT 0 CHECK (residual_minor >= 0),
  acquired_on            DATE NOT NULL,
  in_service             TEXT NOT NULL CHECK (in_service ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  life_months            INT NOT NULL CHECK (life_months BETWEEN 1 AND 360),
  method                 TEXT NOT NULL DEFAULT 'straight_line' CHECK (method IN ('straight_line', 'declining_balance')),
  rate_pct               NUMERIC(5,2) CHECK (rate_pct > 0 AND rate_pct <= 100),
  site_investment_id     BIGINT REFERENCES site_investment(id),
  supplier_bill_id       BIGINT REFERENCES supplier_bill(id),
  disposed_on            DATE,
  disposal_proceeds_minor BIGINT CHECK (disposal_proceeds_minor >= 0),
  disposal_note          TEXT,
  disposed_by            UUID REFERENCES app_user(id),
  recorded_by            UUID REFERENCES app_user(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at              TIMESTAMPTZ,
  voided_by              UUID REFERENCES app_user(id),
  void_reason            TEXT,
  CHECK (residual_minor < cost_minor),
  CHECK (method = 'straight_line' OR rate_pct IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS fixed_asset_tag_uq ON fixed_asset (org_id, lower(tag)) WHERE voided_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fixed_asset_investment_uq ON fixed_asset (site_investment_id) WHERE site_investment_id IS NOT NULL AND voided_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fixed_asset_bill_uq ON fixed_asset (supplier_bill_id) WHERE supplier_bill_id IS NOT NULL AND voided_at IS NULL;

CREATE TABLE IF NOT EXISTS fixed_asset_run (
  id                  BIGSERIAL PRIMARY KEY,
  org_id              UUID NOT NULL REFERENCES organisation(id),
  month               TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  currency            TEXT NOT NULL,
  depreciation_minor  BIGINT NOT NULL CHECK (depreciation_minor >= 0),
  disposals           INT NOT NULL DEFAULT 0,
  gain_loss_minor     BIGINT NOT NULL DEFAULT 0,
  data                JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_by         UUID REFERENCES app_user(id),
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, month, currency)
);

ALTER TABLE bank_statement ADD COLUMN IF NOT EXISTS cash_account_id BIGINT REFERENCES cash_account(id);
ALTER TABLE bank_statement_line DROP CONSTRAINT IF EXISTS bank_statement_line_matched_kind_check;
ALTER TABLE bank_statement_line ADD CONSTRAINT bank_statement_line_matched_kind_check
  CHECK (matched_kind = ANY (ARRAY['gateway_withdrawal', 'statement_payment', 'refund', 'roaming_payment', 'supplier_payment', 'ignored']));

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier', 'cash_account', 'cash_balance', 'cash_transfer', 'supplier_bill', 'supplier_payment', 'fixed_asset', 'fixed_asset_run'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON supplier, cash_account, cash_balance, cash_transfer, supplier_bill, supplier_payment, fixed_asset, fixed_asset_run TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON supplier, cash_account, cash_balance, cash_transfer, supplier_bill, supplier_payment, fixed_asset, fixed_asset_run FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE supplier_id_seq, cash_account_id_seq, cash_balance_id_seq, cash_transfer_id_seq, supplier_bill_id_seq, supplier_payment_id_seq, fixed_asset_id_seq, fixed_asset_run_id_seq TO plugsure_app;
  END IF;
END $$;
