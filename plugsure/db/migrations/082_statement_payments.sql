-- 082: payouts and statement payments, recorded (v1.14.0).
--
-- PlugSure moves no money here: the operator's bank does. PlugSure records what was paid, so Finance shows what is due,
-- part-paid and paid (services/payouts.ts):
--
--   owner_bank_account   where a site owner is paid: bank, account holder, the account number SEALED (SECRETS_KEY, bound
--                        to the owner) with its last four digits for display. One per owner.
--   statement_payment    a payment recorded against a finalised commission_statement:
--                          kind 'owner_payout'   the operator paid a site owner its share (owner_share_minor)
--                          kind 'platform_fee'   the operator paid PlugSure its statement (total_minor); platform admins
--                        amount, date, bank reference, note, who recorded it. Never deleted: voided with a reason.
--
-- Tenant isolation, the post-048 shape: an operator's rows. Additive and idempotent. Rollback: db/rollback/082_down.sql.

CREATE TABLE IF NOT EXISTS owner_bank_account (
  owner_id               UUID PRIMARY KEY REFERENCES site_owner(id) ON DELETE CASCADE,
  org_id                 UUID NOT NULL REFERENCES organisation(id),
  bank_name              TEXT NOT NULL,
  -- Optional bank code (e.g. BCA 014) for the bank's bulk-transfer file.
  bank_code              TEXT,
  holder_name            TEXT NOT NULL,
  account_number_sealed  TEXT NOT NULL,
  account_last4          TEXT NOT NULL,
  updated_by             UUID,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS statement_payment (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  statement_id    UUID NOT NULL REFERENCES commission_statement(id),
  kind            TEXT NOT NULL CHECK (kind IN ('owner_payout', 'platform_fee')),
  owner_id        UUID REFERENCES site_owner(id),
  amount_minor    BIGINT NOT NULL CHECK (amount_minor > 0),
  currency        TEXT NOT NULL,
  paid_on         DATE NOT NULL,
  reference       TEXT NOT NULL,
  note            TEXT,
  recorded_by     UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at       TIMESTAMPTZ,
  voided_by       UUID,
  void_reason     TEXT
);
CREATE INDEX IF NOT EXISTS statement_payment_statement_idx ON statement_payment (statement_id) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS statement_payment_org_idx ON statement_payment (org_id, paid_on DESC);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['owner_bank_account', 'statement_payment'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

-- No blanket GRANT: a payment is recorded and voided (an UPDATE of the void columns), never deleted by the application.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON owner_bank_account TO plugsure_app;
    GRANT SELECT, INSERT, UPDATE ON statement_payment TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON statement_payment FROM plugsure_app;
    REVOKE TRUNCATE ON owner_bank_account FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE statement_payment_id_seq TO plugsure_app;
  END IF;
END $$;
