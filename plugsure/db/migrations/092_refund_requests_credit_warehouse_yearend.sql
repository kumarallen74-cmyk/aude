-- 092 (v1.24.0) finance phase 13.
--
--   driver_refund_request      a driver's request for money back on a charge (from the app's receipt): the reason, the
--                              amount, the decision (approved automatically by the operator's policy, or by Finance),
--                              and the refund it started (payment_intent.refund_state 'due' → the Refunds queue)
--   fleet_account
--     .credit_mode             'none' (as before), 'credit' (a limit), 'prepaid' (a deposit drawn down by invoices)
--     .credit_limit_minor      the limit (credit mode), in credit_currency
--     .credit_currency         the currency of the limit and of the deposit
--     .credit_block            block the account's cards while it is over its limit / out of deposit
--     .credit_auto_apply       prepaid: pay issued invoices from the deposit automatically
--   token.credit_blocked_at    the card was blocked because its fleet account went over its limit (restored when back)
--   fleet_prepay_entry         the deposit's ledger: top-ups (+), invoices paid from it (−), adjustments
--   fleet_credit_alert         the last warning level sent per account (80, 100) so each is raised once
--   finance_export_run         each data warehouse export: the day, the files written (with sizes and SHA-256), errors
--   finance_org_settings
--     .driver_refund_policy    {enabled, autoApproveUpTo, windowDays}
--     .warehouse               {enabled, target, endpoint, region, bucket, prefix, accessKeyId, format, secret (sealed)}
--
-- Additive. Rollback: db/rollback/092_down.sql.

CREATE TABLE IF NOT EXISTS driver_refund_request (
  id                  BIGSERIAL PRIMARY KEY,
  org_id              UUID NOT NULL REFERENCES organisation(id),
  payment_intent_id   UUID NOT NULL REFERENCES payment_intent(id),
  driver_charge_id    UUID,
  device_id           UUID,
  app_driver_id       UUID,
  reason              TEXT NOT NULL CHECK (reason IN ('unused_balance', 'charging_failed', 'overcharged', 'other')),
  message             TEXT,
  amount_minor        BIGINT NOT NULL CHECK (amount_minor > 0),
  currency            TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected', 'withdrawn')),
  auto                BOOLEAN NOT NULL DEFAULT false,
  decided_by          UUID REFERENCES app_user(id),
  decided_at          TIMESTAMPTZ,
  decision_note       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS driver_refund_request_open_uq ON driver_refund_request (payment_intent_id) WHERE state IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS driver_refund_request_org_idx ON driver_refund_request (org_id, state);

ALTER TABLE fleet_account ADD COLUMN IF NOT EXISTS credit_mode TEXT NOT NULL DEFAULT 'none' CHECK (credit_mode IN ('none', 'credit', 'prepaid'));
ALTER TABLE fleet_account ADD COLUMN IF NOT EXISTS credit_limit_minor BIGINT NOT NULL DEFAULT 0 CHECK (credit_limit_minor >= 0);
ALTER TABLE fleet_account ADD COLUMN IF NOT EXISTS credit_currency TEXT NOT NULL DEFAULT 'IDR';
ALTER TABLE fleet_account ADD COLUMN IF NOT EXISTS credit_block BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE fleet_account ADD COLUMN IF NOT EXISTS credit_auto_apply BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE token ADD COLUMN IF NOT EXISTS credit_blocked_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS fleet_prepay_entry (
  id                BIGSERIAL PRIMARY KEY,
  org_id            UUID NOT NULL REFERENCES organisation(id),
  fleet_account_id  UUID NOT NULL REFERENCES fleet_account(id),
  kind              TEXT NOT NULL CHECK (kind IN ('topup', 'invoice', 'adjustment')),
  amount_minor      BIGINT NOT NULL CHECK (amount_minor <> 0),
  currency          TEXT NOT NULL,
  invoice_id        UUID REFERENCES fleet_invoice(id),
  reference         TEXT,
  note              TEXT,
  created_by        UUID REFERENCES app_user(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fleet_prepay_entry_acct_idx ON fleet_prepay_entry (fleet_account_id, currency);
CREATE UNIQUE INDEX IF NOT EXISTS fleet_prepay_entry_invoice_uq ON fleet_prepay_entry (invoice_id) WHERE kind = 'invoice';

CREATE TABLE IF NOT EXISTS fleet_credit_alert (
  fleet_account_id  UUID PRIMARY KEY REFERENCES fleet_account(id),
  org_id            UUID NOT NULL REFERENCES organisation(id),
  level             INT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance_export_run (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  day           DATE NOT NULL,
  target        TEXT NOT NULL,
  automatic     BOOLEAN NOT NULL DEFAULT false,
  files         JSONB NOT NULL DEFAULT '[]'::jsonb,
  bytes         BIGINT NOT NULL DEFAULT 0,
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  started_by    UUID REFERENCES app_user(id)
);
CREATE INDEX IF NOT EXISTS finance_export_run_org_idx ON finance_export_run (org_id, day DESC);

ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS driver_refund_policy JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS warehouse JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['driver_refund_request', 'fleet_prepay_entry', 'fleet_credit_alert', 'finance_export_run'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON driver_refund_request, fleet_prepay_entry, fleet_credit_alert, finance_export_run TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON driver_refund_request, fleet_prepay_entry, fleet_credit_alert, finance_export_run FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE driver_refund_request_id_seq, fleet_prepay_entry_id_seq, finance_export_run_id_seq TO plugsure_app;
  END IF;
END $$;
