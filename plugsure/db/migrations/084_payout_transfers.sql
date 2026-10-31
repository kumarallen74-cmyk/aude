-- 084: owners' shares paid through Duitku Disbursement, with two people (v1.16.0).
--
-- Until v1.15.0 PlugSure only RECORDED owner payouts the operator's bank made (statement_payment, v1.14.0). With the
-- Disbursement credentials saved on the operator's OWN Duitku account, a payout can now be SENT from Finance → Payables,
-- like refunds (083, services/refund-transfers.ts):
--
--   payout_transfer   one payout of (part of) an owner's share on a finalised statement, to the owner's saved bank
--                     account: awaiting_approval → sending → sent → succeeded | failed; or rejected. Approved by a SECOND
--                     person. When paid, the statement payment is recorded (statement_payment_id), so the share shows
--                     part-paid / paid as before. The account number is sealed again, bound to the transfer: a later
--                     change to the owner's bank details does not change a transfer already requested.
--
--   gateway_report    (also v1.16.0) a report Xendit generates on request from Finance (its Report API): transactions,
--                     balance history or upcoming settlements for a period, as CSV. PENDING until Xendit has it; then its
--                     download link (short-lived, asked again when it has expired).
--
-- Tenant isolation, the post-048 shape. Additive and idempotent. Rollback: db/rollback/084_down.sql.

CREATE TABLE IF NOT EXISTS payout_transfer (
  id                     BIGSERIAL PRIMARY KEY,
  org_id                 UUID NOT NULL REFERENCES organisation(id),
  statement_id           UUID NOT NULL REFERENCES commission_statement(id),
  owner_id               UUID NOT NULL REFERENCES site_owner(id),
  -- The operator's own Duitku account whose Disbursement pays it.
  integration_id         UUID NOT NULL REFERENCES integration(id),
  amount_minor           BIGINT NOT NULL CHECK (amount_minor > 0),
  currency               TEXT NOT NULL,
  bank_code              TEXT NOT NULL,
  account_number_sealed  TEXT NOT NULL,
  account_last4          TEXT NOT NULL,
  holder_name            TEXT NOT NULL,
  checked_name           TEXT,
  state                  TEXT NOT NULL CHECK (state IN ('awaiting_approval', 'sending', 'sent', 'succeeded', 'failed', 'rejected')),
  note                   TEXT,
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
  statement_payment_id   BIGINT REFERENCES statement_payment(id),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One open transfer per statement.
CREATE UNIQUE INDEX IF NOT EXISTS payout_transfer_open_idx ON payout_transfer (statement_id) WHERE state IN ('awaiting_approval', 'sending', 'sent');
CREATE INDEX IF NOT EXISTS payout_transfer_org_idx ON payout_transfer (org_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS payout_transfer_day_idx ON payout_transfer (integration_id, approved_at) WHERE state IN ('sending', 'sent', 'succeeded');

ALTER TABLE payout_transfer ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_transfer FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payout_transfer_tenant ON payout_transfer;
CREATE POLICY payout_transfer_tenant ON payout_transfer USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON payout_transfer TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON payout_transfer FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE payout_transfer_id_seq TO plugsure_app;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS gateway_report (
  id              BIGSERIAL PRIMARY KEY,
  integration_id  UUID NOT NULL REFERENCES integration(id) ON DELETE CASCADE,
  -- NULL: the platform's account (as gateway_transaction).
  org_id          UUID REFERENCES organisation(id),
  type            TEXT NOT NULL CHECK (type IN ('TRANSACTIONS', 'BALANCE_HISTORY', 'UPCOMING_TRANSACTIONS')),
  period_from     TIMESTAMPTZ NOT NULL,
  period_to       TIMESTAMPTZ NOT NULL,
  external_id     TEXT,
  status          TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),
  url             TEXT,
  error           TEXT,
  requested_by    UUID,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gateway_report_idx ON gateway_report (integration_id, requested_at DESC);
ALTER TABLE gateway_report ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_report FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gateway_report_tenant ON gateway_report;
CREATE POLICY gateway_report_tenant ON gateway_report USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org());
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON gateway_report TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON gateway_report FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE gateway_report_id_seq TO plugsure_app;
  END IF;
END $$;
