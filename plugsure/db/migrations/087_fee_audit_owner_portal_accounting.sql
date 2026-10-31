-- 087 (v1.19.0) finance phase 8.
--
--   gateway_account_settings.contract_rates   the rates agreed with the gateway, per payment method
--                                             ({"QRIS": {"pct": 0.7}, "CARD": {"pct": 2.9, "fixed": 2000}, ...}),
--                                             checked against every fee the gateway charged (services/fee-audit.ts)
--   gateway_account_settings.accounting_package   the accounting package the journal is exported for
--                                             (jurnal, accurate, generic), services/accounting-export.ts
--   owner_bank_change_request                 a site owner's (portal) request to change its bank details; the account
--                                             number sealed like owner_bank_account's; the operator approves or rejects
--   accounting_export                         each journal export for a package: the month, the file, who, when
--
-- Additive. Rollback: db/rollback/087_down.sql.

ALTER TABLE gateway_account_settings ADD COLUMN IF NOT EXISTS contract_rates JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE gateway_account_settings ADD COLUMN IF NOT EXISTS accounting_package TEXT
  CHECK (accounting_package IS NULL OR accounting_package IN ('jurnal', 'accurate', 'generic'));

CREATE TABLE IF NOT EXISTS owner_bank_change_request (
  id                     BIGSERIAL PRIMARY KEY,
  org_id                 UUID NOT NULL REFERENCES organisation(id),
  owner_id               UUID NOT NULL REFERENCES site_owner(id),
  bank_name              TEXT NOT NULL,
  bank_code              TEXT,
  holder_name            TEXT NOT NULL,
  account_number_sealed  TEXT NOT NULL,
  account_last4          TEXT NOT NULL,
  note                   TEXT,
  state                  TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected', 'withdrawn')),
  requested_by           UUID REFERENCES app_user(id),
  requested_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by             UUID REFERENCES app_user(id),
  decided_at             TIMESTAMPTZ,
  decision_note          TEXT
);
-- One pending request per owner.
CREATE UNIQUE INDEX IF NOT EXISTS owner_bank_change_request_pending_uq ON owner_bank_change_request (owner_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS owner_bank_change_request_org_idx ON owner_bank_change_request (org_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS accounting_export (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID REFERENCES organisation(id),
  integration_id  UUID NOT NULL REFERENCES integration(id),
  month           TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  package         TEXT NOT NULL CHECK (package IN ('jurnal', 'accurate', 'generic')),
  filename        TEXT NOT NULL,
  entries         INT NOT NULL,
  total_debit     NUMERIC(18,2) NOT NULL,
  exported_by     UUID REFERENCES app_user(id),
  exported_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS accounting_export_account_idx ON accounting_export (integration_id, exported_at DESC);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['owner_bank_change_request', 'accounting_export'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    -- accounting_export.org_id is NULL for the platform's own account: visible to the bypass only.
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON owner_bank_change_request, accounting_export TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON owner_bank_change_request, accounting_export FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE owner_bank_change_request_id_seq, accounting_export_id_seq TO plugsure_app;
  END IF;
END $$;
