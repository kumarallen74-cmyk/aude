-- 093 (v1.25.0) finance phase 14.
--
--   platform_invoice_send        each PlugSure fee statement e-mailed to its operator as an invoice (PDF), and each
--                                reminder: to whom, when, the result
--   platform_invoice_link        a Xendit payment link (invoice) for what an operator owes on a statement: the amount,
--                                the URL, its status at Xendit; when Xendit reports it paid, the payment is recorded
--                                on the statement (statement_payment kind platform_fee)
--   organisation.billing_email   where PlugSure sends an operator its fee invoices (else its owners' e-mail)
--   roaming_settlement           a month's settlement with a roaming partner (peer OCPI, not a hub) in a currency:
--                                what the partner owes (our charge records of its drivers at our chargers) and what we
--                                owe it (its charge records of our drivers), net; finalised with a number
--   roaming_settlement_payment   money received from or paid to the partner against a settlement
--   bank_statement_line          matched_kind gains 'roaming_payment'
--   finance_org_settings         platform_invoicing (PlugSure's own: automatic invoices, links, reminders) and
--                                finance_controls (the monthly controls report's thresholds)
--
-- Additive. Rollback: db/rollback/093_down.sql.

ALTER TABLE organisation ADD COLUMN IF NOT EXISTS billing_email TEXT;
ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS platform_invoicing JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS finance_controls JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS platform_invoice_send (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  statement_id  UUID NOT NULL REFERENCES commission_statement(id),
  kind          TEXT NOT NULL CHECK (kind IN ('invoice', 'reminder')),
  sent_to       TEXT,
  reference     TEXT,
  error         TEXT,
  automatic     BOOLEAN NOT NULL DEFAULT false,
  sent_by       UUID REFERENCES app_user(id),
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_invoice_send_stmt_idx ON platform_invoice_send (statement_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS platform_invoice_link (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  statement_id     UUID NOT NULL REFERENCES commission_statement(id),
  integration_id   UUID REFERENCES integration(id),
  external_id      TEXT NOT NULL UNIQUE,
  xendit_id        TEXT,
  url              TEXT,
  amount_minor     BIGINT NOT NULL CHECK (amount_minor > 0),
  currency         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'failed')),
  expires_at       TIMESTAMPTZ,
  paid_at          TIMESTAMPTZ,
  payment_id       BIGINT REFERENCES statement_payment(id),
  error            TEXT,
  created_by       UUID REFERENCES app_user(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_invoice_link_open_uq ON platform_invoice_link (statement_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS roaming_settlement (
  id                  BIGSERIAL PRIMARY KEY,
  org_id              UUID NOT NULL REFERENCES organisation(id),
  partner_id          UUID NOT NULL REFERENCES ocpi_partner(id),
  month               TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  currency            TEXT NOT NULL,
  number              TEXT NOT NULL UNIQUE,
  receivable_minor    BIGINT NOT NULL,
  payable_minor       BIGINT NOT NULL,
  net_minor           BIGINT NOT NULL,
  receivable_cdrs     INT NOT NULL DEFAULT 0,
  payable_cdrs        INT NOT NULL DEFAULT 0,
  data                JSONB NOT NULL DEFAULT '{}'::jsonb,
  finalised_by        UUID REFERENCES app_user(id),
  finalised_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, partner_id, month, currency)
);

CREATE TABLE IF NOT EXISTS roaming_settlement_payment (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organisation(id),
  settlement_id  BIGINT NOT NULL REFERENCES roaming_settlement(id),
  direction      TEXT NOT NULL CHECK (direction IN ('received', 'paid')),
  amount_minor   BIGINT NOT NULL CHECK (amount_minor > 0),
  currency       TEXT NOT NULL,
  paid_on        DATE NOT NULL,
  reference      TEXT NOT NULL,
  note           TEXT,
  recorded_by    UUID REFERENCES app_user(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at      TIMESTAMPTZ,
  voided_by      UUID REFERENCES app_user(id),
  void_reason    TEXT
);
CREATE INDEX IF NOT EXISTS roaming_settlement_payment_idx ON roaming_settlement_payment (settlement_id) WHERE voided_at IS NULL;

ALTER TABLE bank_statement_line DROP CONSTRAINT IF EXISTS bank_statement_line_matched_kind_check;
ALTER TABLE bank_statement_line ADD CONSTRAINT bank_statement_line_matched_kind_check
  CHECK (matched_kind = ANY (ARRAY['gateway_withdrawal', 'statement_payment', 'refund', 'roaming_payment', 'ignored']));

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_invoice_send', 'platform_invoice_link', 'roaming_settlement', 'roaming_settlement_payment'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON platform_invoice_send, platform_invoice_link, roaming_settlement, roaming_settlement_payment TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON platform_invoice_send, platform_invoice_link, roaming_settlement, roaming_settlement_payment FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE platform_invoice_send_id_seq, platform_invoice_link_id_seq, roaming_settlement_id_seq, roaming_settlement_payment_id_seq TO plugsure_app;
  END IF;
END $$;
