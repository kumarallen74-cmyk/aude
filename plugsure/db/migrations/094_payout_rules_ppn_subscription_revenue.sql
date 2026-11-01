-- 094 (v1.26.0) finance phase 15.
--
--   owner_payout_rule               per site owner: automatic payouts on or off, a minimum amount, a hold with a
--                                   reason (the organisation's default is finance_org_settings.owner_payouts)
--   payout_transfer.automatic       a payout the worker requested (it still waits for the approvals as any other)
--   ppn_input_invoice               input VAT invoices (faktur pajak masukan) recorded for a tax period: supplier,
--                                   NPWP, number, date, DPP and PPN, creditable or not
--   ppn_period                      a month's PPN return (SPT Masa PPN) as filed: output, input, the overpayment
--                                   brought forward, payable or carried forward, the NTPN of the payment
--   finance_org_settings            owner_payouts (automatic payouts) and subscription_revenue (journal accounts)
--
-- Additive. Rollback: db/rollback/094_down.sql.

ALTER TABLE payout_transfer ADD COLUMN IF NOT EXISTS automatic BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS owner_payouts JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS subscription_revenue JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS owner_payout_rule (
  owner_id          UUID PRIMARY KEY REFERENCES site_owner(id),
  org_id            UUID NOT NULL REFERENCES organisation(id),
  automatic         BOOLEAN,
  min_amount_minor  BIGINT CHECK (min_amount_minor IS NULL OR min_amount_minor >= 0),
  hold              BOOLEAN NOT NULL DEFAULT false,
  hold_reason       TEXT,
  updated_by        UUID REFERENCES app_user(id),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ppn_input_invoice (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  month           TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  supplier        TEXT NOT NULL,
  supplier_npwp   TEXT,
  faktur_number   TEXT NOT NULL,
  faktur_date     DATE NOT NULL,
  dpp_minor       BIGINT NOT NULL CHECK (dpp_minor >= 0),
  ppn_minor       BIGINT NOT NULL CHECK (ppn_minor >= 0),
  description     TEXT,
  creditable      BOOLEAN NOT NULL DEFAULT true,
  recorded_by     UUID REFERENCES app_user(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at       TIMESTAMPTZ,
  voided_by       UUID REFERENCES app_user(id),
  void_reason     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ppn_input_invoice_uq ON ppn_input_invoice (org_id, faktur_number) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS ppn_input_invoice_month_idx ON ppn_input_invoice (org_id, month) WHERE voided_at IS NULL;

CREATE TABLE IF NOT EXISTS ppn_period (
  id                  BIGSERIAL PRIMARY KEY,
  org_id              UUID NOT NULL REFERENCES organisation(id),
  month               TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  output_minor        BIGINT NOT NULL,
  input_minor         BIGINT NOT NULL,
  brought_forward_minor BIGINT NOT NULL DEFAULT 0,
  payable_minor       BIGINT NOT NULL,
  carried_forward_minor BIGINT NOT NULL,
  data                JSONB NOT NULL DEFAULT '{}'::jsonb,
  ntpn                TEXT,
  reference           TEXT,
  filed_by            UUID REFERENCES app_user(id),
  filed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, month)
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['owner_payout_rule', 'ppn_input_invoice', 'ppn_period'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON owner_payout_rule, ppn_input_invoice, ppn_period TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON owner_payout_rule, ppn_input_invoice, ppn_period FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE ppn_input_invoice_id_seq, ppn_period_id_seq TO plugsure_app;
  END IF;
END $$;
