-- 083: refunds sent through Duitku Disbursement, and owners' bank accounts checked by name (v1.15.0).
--
-- Duitku has no refund API: a refund of a Duitku payment was a bank transfer recorded by hand. With the Disbursement
-- credentials saved on the Duitku account (Payments — fallback), it can now be SENT from the Refunds page, with two
-- people (services/refund-transfers.ts):
--
--   refund_transfer      one request to pay a refund to the driver's bank account through Disbursement:
--                          awaiting_approval  requested: the account checked by Duitku's inquiry (the holder's name the
--                                             bank returns), waiting for a SECOND person with payment:write
--                          sending            approved: the transfer is being made (a conditional update; once)
--                          sent               Duitku accepted it, the result not known yet (checked by the worker)
--                          succeeded          paid: the refund is recorded as refunded (method 'disbursement')
--                          failed             refused or failed: the refund is due again
--                          rejected           rejected or withdrawn before it was sent
--                        The account number is SEALED (SECRETS_KEY, bound to the transfer), the last four kept.
--   owner_bank_account   + the name check: the holder's name the bank returned through Disbursement's inquiry.
--   payment_intent       refund_method may be 'disbursement'.
--
-- Tenant isolation, the post-048 shape. Additive and idempotent. Rollback: db/rollback/083_down.sql.

ALTER TABLE payment_intent DROP CONSTRAINT IF EXISTS payment_intent_refund_method_check;
ALTER TABLE payment_intent ADD CONSTRAINT payment_intent_refund_method_check CHECK (refund_method IN ('provider', 'manual', 'disbursement'));

ALTER TABLE owner_bank_account
  ADD COLUMN IF NOT EXISTS name_check_status TEXT CHECK (name_check_status IN ('matched', 'mismatch', 'failed')),
  ADD COLUMN IF NOT EXISTS name_check_name   TEXT,
  ADD COLUMN IF NOT EXISTS name_checked_at   TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS refund_transfer (
  id                     BIGSERIAL PRIMARY KEY,
  org_id                 UUID NOT NULL REFERENCES organisation(id),
  payment_intent_id      UUID NOT NULL REFERENCES payment_intent(id),
  -- The Duitku account that took the payment, whose Disbursement pays the refund.
  integration_id         UUID NOT NULL REFERENCES integration(id),
  amount_minor           BIGINT NOT NULL CHECK (amount_minor > 0),
  currency               TEXT NOT NULL,
  bank_code              TEXT NOT NULL,
  account_number_sealed  TEXT NOT NULL,
  account_last4          TEXT NOT NULL,
  -- The name staff entered, and the name the bank returned.
  holder_name            TEXT NOT NULL,
  checked_name           TEXT,
  state                  TEXT NOT NULL CHECK (state IN ('awaiting_approval', 'sending', 'sent', 'succeeded', 'failed', 'rejected')),
  requested_by           UUID,
  requested_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by            UUID,
  approved_at            TIMESTAMPTZ,
  rejected_by            UUID,
  reason                 TEXT,
  disburse_id            TEXT,
  cust_ref               TEXT,
  response_code          TEXT,
  error                  TEXT,
  checks                 INT NOT NULL DEFAULT 0,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One open transfer per payment.
CREATE UNIQUE INDEX IF NOT EXISTS refund_transfer_open_idx ON refund_transfer (payment_intent_id) WHERE state IN ('awaiting_approval', 'sending', 'sent');
CREATE INDEX IF NOT EXISTS refund_transfer_org_idx ON refund_transfer (org_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS refund_transfer_day_idx ON refund_transfer (integration_id, approved_at) WHERE state IN ('sending', 'sent', 'succeeded');

ALTER TABLE refund_transfer ENABLE ROW LEVEL SECURITY;
ALTER TABLE refund_transfer FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS refund_transfer_tenant ON refund_transfer;
CREATE POLICY refund_transfer_tenant ON refund_transfer USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org());

-- A transfer is a financial record: requested, approved or rejected, never deleted by the application.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON refund_transfer TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON refund_transfer FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE refund_transfer_id_seq TO plugsure_app;
  END IF;
END $$;
