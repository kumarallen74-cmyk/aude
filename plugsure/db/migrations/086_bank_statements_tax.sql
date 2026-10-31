-- 086: bank statements reconciled, and tax withheld (v1.18.0).
--
--   bank_statement        a statement of the operator's bank account, uploaded (CSV from BCA, Mandiri, BRI, or any bank
--                         with date / description / amount columns): the file's name, the bank, its date range.
--   bank_statement_line   one line: date, description, amount (credit +, debit −, rupiah), the bank's reference, and what
--                         it was matched to (services/bank-recon.ts):
--                           gateway_withdrawal  a credit: a gateway's payout of collected money to the bank
--                                               (gateway_transaction kind 'payout')
--                           statement_payment   an owner payout (debit) or, for the platform, an operator's payment of
--                                               its statement (credit), as recorded in Finance
--                           refund              a refund recorded as paid by bank transfer (payment_intent)
--                           ignored             nothing to match (bank fees, other business), with a note
--   tax_withholding       PPh 23 withheld (services/tax.ts): on the gateway's fees (the operator withholds from the
--                         gateway) or on PlugSure's platform fee (an operator withholds from PlugSure), with the bukti
--                         potong's number and date once issued.
--
-- Tenant isolation, the post-048 shape. Additive and idempotent. Rollback: db/rollback/086_down.sql.

CREATE TABLE IF NOT EXISTS bank_statement (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  bank          TEXT NOT NULL,
  filename      TEXT NOT NULL,
  account_hint  TEXT,
  date_from     DATE,
  date_to       DATE,
  line_count    INT NOT NULL DEFAULT 0,
  uploaded_by   UUID,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bank_statement_org_idx ON bank_statement (org_id, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS bank_statement_line (
  id            BIGSERIAL PRIMARY KEY,
  statement_id  BIGINT NOT NULL REFERENCES bank_statement(id),
  org_id        UUID NOT NULL REFERENCES organisation(id),
  line_no       INT NOT NULL,
  line_date     DATE NOT NULL,
  description   TEXT NOT NULL,
  reference     TEXT,
  amount_minor  BIGINT NOT NULL,
  balance_minor BIGINT,
  -- A line is in a statement once: an overlapping upload skips the lines already there (same date, amount, description).
  fingerprint   TEXT NOT NULL,
  matched_kind  TEXT CHECK (matched_kind IN ('gateway_withdrawal', 'statement_payment', 'refund', 'ignored')),
  matched_ref   TEXT,
  matched_auto  BOOLEAN NOT NULL DEFAULT false,
  matched_by    UUID,
  matched_at    TIMESTAMPTZ,
  note          TEXT,
  UNIQUE (org_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS bank_statement_line_stmt_idx ON bank_statement_line (statement_id, line_no);
CREATE INDEX IF NOT EXISTS bank_statement_line_open_idx ON bank_statement_line (org_id, line_date) WHERE matched_kind IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS bank_statement_line_match_idx ON bank_statement_line (org_id, matched_kind, matched_ref) WHERE matched_kind IS NOT NULL AND matched_kind <> 'ignored';

CREATE TABLE IF NOT EXISTS tax_withholding (
  id                  BIGSERIAL PRIMARY KEY,
  org_id              UUID NOT NULL REFERENCES organisation(id),
  -- gateway_fee: the operator withheld from the gateway (its fees); platform_fee: the operator withheld from PlugSure.
  kind                TEXT NOT NULL CHECK (kind IN ('gateway_fee', 'platform_fee')),
  period              TEXT NOT NULL,
  counterparty        TEXT NOT NULL,
  counterparty_npwp   TEXT,
  integration_id      UUID REFERENCES integration(id),
  statement_id        UUID REFERENCES commission_statement(id),
  base_minor          BIGINT NOT NULL CHECK (base_minor >= 0),
  rate_bps            INT NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  amount_minor        BIGINT NOT NULL CHECK (amount_minor >= 0),
  bukti_number        TEXT,
  bukti_date          DATE,
  note                TEXT,
  recorded_by         UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at           TIMESTAMPTZ,
  voided_by           UUID,
  void_reason         TEXT
);
CREATE INDEX IF NOT EXISTS tax_withholding_org_idx ON tax_withholding (org_id, period DESC);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_statement', 'bank_statement_line', 'tax_withholding'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

-- Financial records: kept, never deleted by the application (a mistaken withholding is voided; a match undone).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON bank_statement, bank_statement_line, tax_withholding TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON bank_statement, bank_statement_line, tax_withholding FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE bank_statement_id_seq, bank_statement_line_id_seq, tax_withholding_id_seq TO plugsure_app;
  END IF;
END $$;
