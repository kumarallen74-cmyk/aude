-- 100 (v1.32.0) finance phase 21.
--
--   bank_feed               a bank account's mutations fetched on a schedule from an HTTPS JSON endpoint (a bank's API or
--                           an aggregator) with a sealed token; each run's new lines land on a bank statement of the cash
--                           account and are matched
--   bank_match_rule         what to do with bank lines nothing matched: by direction, a text the description contains and
--                           an amount range — ignore them with a note, or suggest a journal entry to an account (the
--                           entry waits for approval in the ledger)
--   bank_statement_line     matched_kind gains 'gl_entry' (a line a rule turned into a suggested journal entry)
--   supplier                .tax_kind company (PPh 23), individual (PPh 21, not an employee) or foreign (PPh 26);
--                           .id_number (NIK), .country, .treaty_rate_pct (a tax treaty's PPh 26 rate)
--   supplier_bill           .wht_kind pph23, pph21 or pph26
--   tax_slip                a withholding slip (bukti potong) of a month: kind, payee, gross, DPP, rate, tax, the bills;
--                           drafted from the month's bills, issued with its number and date, or voided
--   report_pack             a month's management report pack: the figures (snapshot), the commentary per section; drafted,
--                           reviewed, approved by a second person, sent
--   close_signoff           a month's close step signed off (or accepted as it is) by a person, with a note
--   finance_org_settings    .close_policy {enforce}: a month is locked only when its close steps are signed off;
--                           .report_pack {recipients}: who the approved pack is e-mailed to
--
-- Additive. Rollback: db/rollback/100_down.sql.

ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS close_policy JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS report_pack JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE supplier ADD COLUMN IF NOT EXISTS tax_kind TEXT NOT NULL DEFAULT 'company' CHECK (tax_kind IN ('company', 'individual', 'foreign'));
ALTER TABLE supplier ADD COLUMN IF NOT EXISTS id_number TEXT;
ALTER TABLE supplier ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE supplier ADD COLUMN IF NOT EXISTS treaty_rate_pct NUMERIC(5,2) CHECK (treaty_rate_pct >= 0 AND treaty_rate_pct <= 20);
ALTER TABLE supplier_bill ADD COLUMN IF NOT EXISTS wht_kind TEXT NOT NULL DEFAULT 'pph23' CHECK (wht_kind IN ('pph23', 'pph21', 'pph26'));

ALTER TABLE bank_statement_line DROP CONSTRAINT IF EXISTS bank_statement_line_matched_kind_check;
ALTER TABLE bank_statement_line ADD CONSTRAINT bank_statement_line_matched_kind_check
  CHECK (matched_kind = ANY (ARRAY['gateway_withdrawal', 'statement_payment', 'refund', 'roaming_payment', 'supplier_payment', 'gl_entry', 'ignored']));

CREATE TABLE IF NOT EXISTS bank_feed (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  cash_account_id  BIGINT NOT NULL REFERENCES cash_account(id),
  name             TEXT NOT NULL,
  url              TEXT NOT NULL,
  token_sealed     TEXT,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  since            DATE,
  last_run_at      TIMESTAMPTZ,
  last_status      TEXT,
  last_error       TEXT,
  lines_imported   INT NOT NULL DEFAULT 0,
  created_by       UUID REFERENCES app_user(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_match_rule (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organisation(id),
  name           TEXT NOT NULL,
  priority       INT NOT NULL DEFAULT 100,
  direction      TEXT NOT NULL DEFAULT 'any' CHECK (direction IN ('any', 'credit', 'debit')),
  contains       TEXT,
  amount_min     BIGINT,
  amount_max     BIGINT,
  action         TEXT NOT NULL CHECK (action IN ('ignore', 'suggest')),
  account_code   TEXT,
  note           TEXT,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  matched_count  INT NOT NULL DEFAULT 0,
  created_by     UUID REFERENCES app_user(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (action = 'ignore' OR account_code IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS tax_slip (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  month         TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  kind          TEXT NOT NULL CHECK (kind IN ('pph21', 'pph23', 'pph26')),
  supplier_id   BIGINT NOT NULL REFERENCES supplier(id),
  currency      TEXT NOT NULL,
  gross_minor   BIGINT NOT NULL,
  dpp_minor     BIGINT NOT NULL,
  rate_pct      NUMERIC(6,3) NOT NULL,
  tax_minor     BIGINT NOT NULL,
  bill_ids      BIGINT[] NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'void')),
  number        TEXT,
  issued_on     DATE,
  issued_by     UUID REFERENCES app_user(id),
  void_reason   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tax_slip_live_uq ON tax_slip (org_id, month, kind, supplier_id) WHERE status <> 'void';

CREATE TABLE IF NOT EXISTS report_pack (
  id                 BIGSERIAL PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organisation(id),
  month              TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  currency           TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'approved', 'sent')),
  data               JSONB NOT NULL DEFAULT '{}'::jsonb,
  commentary         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by         UUID REFERENCES app_user(id),
  submitted_by       UUID REFERENCES app_user(id),
  submitted_at       TIMESTAMPTZ,
  approved_by        UUID REFERENCES app_user(id),
  approved_at        TIMESTAMPTZ,
  sent_at            TIMESTAMPTZ,
  sent_to            INT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, month)
);

CREATE TABLE IF NOT EXISTS close_signoff (
  id          BIGSERIAL PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organisation(id),
  month       TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  step        TEXT NOT NULL,
  accepted    BOOLEAN NOT NULL DEFAULT false,
  note        TEXT,
  signed_by   UUID REFERENCES app_user(id),
  signed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS close_signoff_live_uq ON close_signoff (org_id, month, step) WHERE revoked_at IS NULL;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_feed', 'bank_match_rule', 'tax_slip', 'report_pack', 'close_signoff'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON bank_feed, bank_match_rule, tax_slip, report_pack, close_signoff TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON bank_feed, bank_match_rule, tax_slip, report_pack, close_signoff FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE bank_feed_id_seq, bank_match_rule_id_seq, tax_slip_id_seq, report_pack_id_seq, close_signoff_id_seq TO plugsure_app;
  END IF;
END $$;
