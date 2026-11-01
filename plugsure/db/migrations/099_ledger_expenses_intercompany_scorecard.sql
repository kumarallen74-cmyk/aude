-- 099 (v1.31.0) finance phase 20.
--
--   gl_account              the organisation's chart of accounts: code, name, type (asset, liability, equity, revenue,
--                           expense, other); seeded with the codes the finance modules post to
--   gl_entry                a journal entry in the general ledger: date, month, currency, source (manual, or a module's
--                           month: gateway, assets, leases, provision, bills, deposits, expenses, intercompany), memo;
--                           a manual entry is approved by a second person before it posts; a module's entries are
--                           replaced (superseded) when the month is synced again; a posted entry is reversed, never edited
--   gl_line                its lines: account, debit, credit, description
--   expense_claim           a staff member's expense claim: title, currency; submitted, approved by a second person (the
--                           approvals matrix, kind expense_claim), reimbursed from a cash account (petty cash or bank)
--   expense_claim_line      what was spent: date, category, site, description, amount, PPN; over the policy's limit
--   expense_receipt         a receipt (image or PDF) for a line
--   cash_count              a petty cash count: the notes and coins, the total, what the books expected, the difference
--   cash_account            .float_minor: the petty cash float (imprest) a count tops up to
--   intercompany_recharge   a cost recharged from one group entity to another: number, month, description, amount;
--                           issued, settled by netting, or voided
--   intercompany_settlement two entities' issued recharges netted: who pays whom, how much
--   kpi_target              a month's target for a finance KPI (organisation-wide)
--   kpi_scorecard_send      the monthly scorecard e-mailed (one per organisation and month)
--   finance_org_settings    expense_policy {limits, receiptAbove}, kpi_scorecard {enabled, day, recipients, amberPct}
--
-- Additive. Rollback: db/rollback/099_down.sql.

ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS expense_policy JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS kpi_scorecard JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE cash_account ADD COLUMN IF NOT EXISTS float_minor BIGINT CHECK (float_minor >= 0);

CREATE TABLE IF NOT EXISTS gl_account (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organisation(id),
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'revenue', 'expense', 'other')),
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

CREATE TABLE IF NOT EXISTS gl_entry (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  number        TEXT NOT NULL,
  entry_date    DATE NOT NULL,
  month         TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  currency      TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  source        TEXT NOT NULL CHECK (source IN ('manual', 'gateway', 'assets', 'leases', 'provision', 'bills', 'deposits', 'expenses', 'intercompany', 'reversal')),
  source_ref    TEXT,
  memo          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('draft', 'awaiting_approval', 'posted', 'rejected', 'superseded')),
  reversal_of   BIGINT REFERENCES gl_entry(id),
  reversed_by   BIGINT REFERENCES gl_entry(id),
  submitted_by  UUID REFERENCES app_user(id),
  first_approved_by UUID REFERENCES app_user(id),
  first_approved_at TIMESTAMPTZ,
  approved_by   UUID REFERENCES app_user(id),
  posted_at     TIMESTAMPTZ,
  reject_reason TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE UNIQUE INDEX IF NOT EXISTS gl_entry_source_uq ON gl_entry (org_id, source_ref) WHERE source_ref IS NOT NULL AND status <> 'superseded';
CREATE INDEX IF NOT EXISTS gl_entry_month_idx ON gl_entry (org_id, month) WHERE status = 'posted';

CREATE TABLE IF NOT EXISTS gl_line (
  id           BIGSERIAL PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES organisation(id),
  entry_id     BIGINT NOT NULL REFERENCES gl_entry(id),
  account_code TEXT NOT NULL,
  debit        NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit       NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  description  TEXT,
  CHECK (debit = 0 OR credit = 0)
);
CREATE INDEX IF NOT EXISTS gl_line_entry_idx ON gl_line (entry_id);

CREATE TABLE IF NOT EXISTS expense_claim (
  id                 BIGSERIAL PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organisation(id),
  number             TEXT NOT NULL,
  claimant_id        UUID NOT NULL REFERENCES app_user(id),
  title              TEXT NOT NULL,
  currency           TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'reimbursed', 'void')),
  submitted_at       TIMESTAMPTZ,
  first_approved_by  UUID REFERENCES app_user(id),
  first_approved_at  TIMESTAMPTZ,
  approved_by        UUID REFERENCES app_user(id),
  approved_at        TIMESTAMPTZ,
  reject_reason      TEXT,
  reimbursed_on      DATE,
  cash_account_id    BIGINT REFERENCES cash_account(id),
  reimbursed_by      UUID REFERENCES app_user(id),
  reference          TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE INDEX IF NOT EXISTS expense_claim_status_idx ON expense_claim (org_id, status);

CREATE TABLE IF NOT EXISTS expense_claim_line (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  claim_id      BIGINT NOT NULL REFERENCES expense_claim(id),
  seq           INT NOT NULL,
  spent_on      DATE NOT NULL,
  category      TEXT NOT NULL CHECK (category IN ('fuel', 'travel', 'meals', 'parking', 'tools', 'supplies', 'phone', 'other')),
  site_id       UUID REFERENCES site(id),
  description   TEXT NOT NULL,
  amount_minor  BIGINT NOT NULL CHECK (amount_minor > 0),
  vat_minor     BIGINT NOT NULL DEFAULT 0 CHECK (vat_minor >= 0),
  removed_at    TIMESTAMPTZ,
  UNIQUE (claim_id, seq)
);

CREATE TABLE IF NOT EXISTS expense_receipt (
  id           BIGSERIAL PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES organisation(id),
  line_id      BIGINT NOT NULL REFERENCES expense_claim_line(id),
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes   INT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 3145728),
  data         BYTEA NOT NULL,
  uploaded_by  UUID REFERENCES app_user(id),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expense_receipt_line_idx ON expense_receipt (line_id);

CREATE TABLE IF NOT EXISTS cash_count (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  account_id      BIGINT NOT NULL REFERENCES cash_account(id),
  counted_on      DATE NOT NULL,
  denominations   JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_minor     BIGINT NOT NULL CHECK (total_minor >= 0),
  expected_minor  BIGINT,
  difference_minor BIGINT,
  note            TEXT,
  counted_by      UUID REFERENCES app_user(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intercompany_recharge (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organisation(id),
  to_org_id      UUID NOT NULL REFERENCES organisation(id),
  number         TEXT NOT NULL,
  month          TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  description    TEXT NOT NULL,
  basis          TEXT NOT NULL DEFAULT 'fixed' CHECK (basis IN ('fixed', 'kwh', 'sessions', 'revenue', 'equal')),
  amount_minor   BIGINT NOT NULL CHECK (amount_minor > 0),
  currency       TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status         TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('draft', 'issued', 'settled', 'void')),
  settlement_id  BIGINT,
  created_by     UUID REFERENCES app_user(id),
  issued_at      TIMESTAMPTZ,
  void_reason    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, number),
  CHECK (org_id <> to_org_id)
);
CREATE INDEX IF NOT EXISTS intercompany_recharge_to_idx ON intercompany_recharge (to_org_id, status);

CREATE TABLE IF NOT EXISTS intercompany_settlement (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organisation(id),
  other_org_id   UUID NOT NULL REFERENCES organisation(id),
  currency       TEXT NOT NULL,
  receivable_minor BIGINT NOT NULL,
  payable_minor  BIGINT NOT NULL,
  net_minor      BIGINT NOT NULL,
  settled_on     DATE NOT NULL,
  reference      TEXT,
  recharges      INT NOT NULL,
  settled_by     UUID REFERENCES app_user(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kpi_target (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organisation(id),
  month       TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  kpi         TEXT NOT NULL,
  target      NUMERIC(20,2) NOT NULL,
  updated_by  UUID REFERENCES app_user(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, month, kpi)
);

CREATE TABLE IF NOT EXISTS kpi_scorecard_send (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organisation(id),
  month       TEXT NOT NULL,
  recipients  INT NOT NULL DEFAULT 0,
  error       TEXT,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, month)
);

-- Intercompany rows are visible to both entities: the charging one (org_id) and the charged one (to_org_id).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['gl_account', 'gl_entry', 'gl_line', 'expense_claim', 'expense_claim_line', 'expense_receipt', 'cash_count', 'intercompany_settlement', 'kpi_target', 'kpi_scorecard_send'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;
ALTER TABLE intercompany_recharge ENABLE ROW LEVEL SECURITY;
ALTER TABLE intercompany_recharge FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS intercompany_recharge_tenant ON intercompany_recharge;
CREATE POLICY intercompany_recharge_tenant ON intercompany_recharge
  USING (app_rls_bypass() OR org_id = app_current_org() OR to_org_id = app_current_org())
  WITH CHECK (app_rls_bypass() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON gl_account, gl_entry, gl_line, expense_claim, expense_claim_line, expense_receipt, cash_count, intercompany_recharge, intercompany_settlement, kpi_target, kpi_scorecard_send TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON gl_account, gl_entry, gl_line, expense_claim, expense_claim_line, expense_receipt, cash_count, intercompany_recharge, intercompany_settlement, kpi_target, kpi_scorecard_send FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE gl_account_id_seq, gl_entry_id_seq, gl_line_id_seq, expense_claim_id_seq, expense_claim_line_id_seq, expense_receipt_id_seq, cash_count_id_seq, intercompany_recharge_id_seq, intercompany_settlement_id_seq, kpi_target_id_seq, kpi_scorecard_send_id_seq TO plugsure_app;
  END IF;
END $$;
