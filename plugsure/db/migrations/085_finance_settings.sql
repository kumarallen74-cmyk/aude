-- 085: Finance settings per gateway account: the accounting journal's chart of accounts and the monthly close e-mail
-- (v1.17.0).
--
--   gateway_account_settings   one row per payments account (integration):
--     journal_accounts          the account code and name for each line of the journal export (services/finance-journal.ts);
--                               keys not set fall back to PlugSure's defaults
--     close_email_enabled       on the 1st of each month (platform time zone), the previous month's Excel and PDF are
--     close_email_recipients    e-mailed to these addresses, through the e-mail channel of channel_org_id (the
--     channel_org_id            operator's own; for the platform's account, the organisation of whoever saved it)
--     close_email_sent_period   the last month sent (YYYY-MM), so a month is sent once
--
--   refund_transfer / payout_transfer + rail: 'duitku' (Disbursement, v1.15 / v1.16) or 'xendit' (Xendit Payouts, v1.17.0),
--                              services/payout-rails.ts.
--
-- Rows belong to the account's organisation (org_id NULL = the platform's account), like gateway_transaction.
-- Additive and idempotent. Rollback: db/rollback/085_down.sql.

CREATE TABLE IF NOT EXISTS gateway_account_settings (
  integration_id           UUID PRIMARY KEY REFERENCES integration(id) ON DELETE CASCADE,
  org_id                   UUID REFERENCES organisation(id),
  journal_accounts         JSONB NOT NULL DEFAULT '{}'::jsonb,
  close_email_enabled      BOOLEAN NOT NULL DEFAULT false,
  close_email_recipients   TEXT[] NOT NULL DEFAULT '{}',
  channel_org_id           UUID REFERENCES organisation(id),
  close_email_sent_period  TEXT,
  close_email_last_error   TEXT,
  close_email_last_at      TIMESTAMPTZ,
  updated_by               UUID,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE gateway_account_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_account_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gateway_account_settings_tenant ON gateway_account_settings;
CREATE POLICY gateway_account_settings_tenant ON gateway_account_settings USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON gateway_account_settings TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON gateway_account_settings FROM plugsure_app;
  END IF;
END $$;

ALTER TABLE refund_transfer ADD COLUMN IF NOT EXISTS rail TEXT NOT NULL DEFAULT 'duitku' CHECK (rail IN ('duitku', 'xendit'));
ALTER TABLE payout_transfer ADD COLUMN IF NOT EXISTS rail TEXT NOT NULL DEFAULT 'duitku' CHECK (rail IN ('duitku', 'xendit'));
