-- 107 (v1.39.0) finance phase 28.
--
--   corporate_tax_year      the year's corporate income tax (PPh Badan) computation per currency: draft, or final with
--                           its figures (the year-end journal posts from a final one)
--   tax_fiscal_correction   a book-to-tax adjustment (koreksi fiskal) of a year: positive (not deductible, e.g.
--                           entertainment without a list, fines, donations) or negative (income already taxed finally)
--   tax_payment             PPh 25 instalments and PPh 29 paid (to an account), and tax credits withheld by others
--                           (PPh 22, PPh 23)
--   payment_run             a batch of supplier bills to pay from one account on a day: draft → submitted → approved
--                           (by a second person) → paid, or cancelled; the bank file exported in between
--   payment_run_item        a bill in a run and the amount paid from it
--   corp_card               a company card: its holder, limits, status, the account its statement is paid from
--   card_txn                a card transaction (imported or entered): category, receipt, policy flags, review
--   card_statement          a card's monthly statement total, paid from an account
--   finance_org_settings    .corporate_tax {ratePct, facility31e, regime}, .card_policy {...}
--   gl_entry.source         gains 'tax' and 'cards'
--
-- Additive. Rollback: db/rollback/107_down.sql.

ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS corporate_tax JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS card_policy JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS corporate_tax_year (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  year          INT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  currency      TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final')),
  figures       JSONB NOT NULL DEFAULT '{}'::jsonb,
  finalised_by  UUID REFERENCES app_user(id),
  finalised_at  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, year, currency)
);

CREATE TABLE IF NOT EXISTS tax_fiscal_correction (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  year          INT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  currency      TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  direction     TEXT NOT NULL CHECK (direction IN ('positive', 'negative')),
  category      TEXT NOT NULL,
  description   TEXT NOT NULL,
  amount_minor  BIGINT NOT NULL CHECK (amount_minor > 0),
  created_by    UUID REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tax_fiscal_correction_year_idx ON tax_fiscal_correction (org_id, year);

CREATE TABLE IF NOT EXISTS tax_payment (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  year            INT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  kind            TEXT NOT NULL CHECK (kind IN ('pph25', 'pph29', 'pph22', 'pph23')),
  month           TEXT CHECK (month IS NULL OR month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  currency        TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor    BIGINT NOT NULL CHECK (amount_minor > 0),
  paid_on         DATE NOT NULL,
  reference       TEXT,
  cash_account_id BIGINT REFERENCES cash_account(id),
  created_by      UUID REFERENCES app_user(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tax_payment_year_idx ON tax_payment (org_id, year);

CREATE TABLE IF NOT EXISTS payment_run (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  number           TEXT NOT NULL,
  currency         TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  cash_account_id  BIGINT NOT NULL REFERENCES cash_account(id),
  pay_on           DATE NOT NULL,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'paid', 'cancelled')),
  note             TEXT,
  created_by       UUID REFERENCES app_user(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_by     UUID REFERENCES app_user(id),
  submitted_at     TIMESTAMPTZ,
  approved_by      UUID REFERENCES app_user(id),
  approved_at      TIMESTAMPTZ,
  exported_at      TIMESTAMPTZ,
  export_format    TEXT,
  paid_at          TIMESTAMPTZ,
  cancel_reason    TEXT,
  UNIQUE (org_id, number)
);

CREATE TABLE IF NOT EXISTS payment_run_item (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  run_id        BIGINT NOT NULL REFERENCES payment_run(id),
  bill_id       BIGINT NOT NULL REFERENCES supplier_bill(id),
  amount_minor  BIGINT NOT NULL CHECK (amount_minor > 0),
  removed_at    TIMESTAMPTZ,
  paid          BOOLEAN NOT NULL DEFAULT false,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS payment_run_item_run_idx ON payment_run_item (run_id);
CREATE INDEX IF NOT EXISTS payment_run_item_bill_idx ON payment_run_item (bill_id);

CREATE TABLE IF NOT EXISTS corp_card (
  id                  BIGSERIAL PRIMARY KEY,
  org_id              UUID NOT NULL REFERENCES organisation(id),
  holder_id           UUID REFERENCES app_user(id),
  holder_name         TEXT NOT NULL,
  bank                TEXT NOT NULL,
  last4               TEXT NOT NULL CHECK (last4 ~ '^\d{4}$'),
  currency            TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  single_limit_minor  BIGINT CHECK (single_limit_minor IS NULL OR single_limit_minor > 0),
  monthly_limit_minor BIGINT CHECK (monthly_limit_minor IS NULL OR monthly_limit_minor > 0),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'closed')),
  cash_account_id     BIGINT REFERENCES cash_account(id),
  created_by          UUID REFERENCES app_user(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS card_txn (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  card_id       BIGINT NOT NULL REFERENCES corp_card(id),
  txn_on        DATE NOT NULL,
  merchant      TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'other',
  amount_minor  BIGINT NOT NULL CHECK (amount_minor <> 0),
  reference     TEXT,
  import_key    TEXT,
  receipt_name  TEXT,
  receipt_type  TEXT,
  receipt_data  BYTEA,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected')),
  note          TEXT,
  flags         TEXT[] NOT NULL DEFAULT '{}',
  reviewed_by   UUID REFERENCES app_user(id),
  reviewed_at   TIMESTAMPTZ,
  created_by    UUID REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (card_id, import_key)
);
CREATE INDEX IF NOT EXISTS card_txn_card_idx ON card_txn (card_id, txn_on);

CREATE TABLE IF NOT EXISTS card_statement (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  card_id         BIGINT NOT NULL REFERENCES corp_card(id),
  month           TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  total_minor     BIGINT NOT NULL,
  paid_on         DATE,
  cash_account_id BIGINT REFERENCES cash_account(id),
  created_by      UUID REFERENCES app_user(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (card_id, month)
);

ALTER TABLE gl_entry DROP CONSTRAINT IF EXISTS gl_entry_source_check;
ALTER TABLE gl_entry ADD CONSTRAINT gl_entry_source_check
  CHECK (source IN ('manual', 'gateway', 'assets', 'leases', 'provision', 'bills', 'deposits', 'expenses', 'intercompany', 'reversal', 'payroll', 'customer_deposits', 'projects',
                    'inventory', 'maintenance', 'loans', 'carbon', 'insurance', 'grants', 'landlords', 'chargebacks', 'loyalty', 'fx', 'tax', 'cards'));

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['corporate_tax_year', 'tax_fiscal_correction', 'tax_payment', 'payment_run', 'payment_run_item', 'corp_card', 'card_txn', 'card_statement'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON corporate_tax_year, tax_fiscal_correction, tax_payment, payment_run, payment_run_item, corp_card, card_txn, card_statement TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON corporate_tax_year, tax_fiscal_correction, tax_payment, payment_run, payment_run_item, corp_card, card_txn, card_statement FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE corporate_tax_year_id_seq, tax_fiscal_correction_id_seq, tax_payment_id_seq, payment_run_id_seq, payment_run_item_id_seq, corp_card_id_seq, card_txn_id_seq, card_statement_id_seq TO plugsure_app;
  END IF;
END $$;
