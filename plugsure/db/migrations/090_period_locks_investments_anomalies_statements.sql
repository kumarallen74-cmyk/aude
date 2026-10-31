-- 090 (v1.22.0) finance phase 11.
--
--   finance_period_lock          a closed month: the finance entries dated in it (energy bills, exchange rates, budgets,
--                                site investments) can no longer be added, changed or voided. Reopening needs
--                                finance:approve and a reason; the row keeps who closed and who reopened it.
--   site_investment              what a site cost to build (chargers, installation, grid connection, other), with the
--                                months it is depreciated over; with the margin, the site's payback and ROI
--   finance_org_settings
--     .revenue_alerts            {enabled, dropPct, minBaseline}: alert when a site's day revenue falls below its
--                                baseline (the same weekday, the 4 weeks before) by dropPct
--     .fleet_statements          {enabled, day}: e-mail each fleet account its statement of account on that day of the
--                                month, for the month just ended
--   revenue_anomaly              each day and site found below its baseline (one row per site and day)
--   fleet_statement_send         each statement of account e-mailed (one per account and month, automatic or by hand)
--
-- Additive. Rollback: db/rollback/090_down.sql.

CREATE TABLE IF NOT EXISTS finance_period_lock (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organisation(id),
  month          TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  locked_by      UUID REFERENCES app_user(id),
  locked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  note           TEXT,
  reopened_by    UUID REFERENCES app_user(id),
  reopened_at    TIMESTAMPTZ,
  reopen_reason  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_period_lock_open_uq ON finance_period_lock (org_id, month) WHERE reopened_at IS NULL;

CREATE TABLE IF NOT EXISTS site_investment (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organisation(id),
  site_id        UUID NOT NULL REFERENCES site(id),
  category       TEXT NOT NULL CHECK (category IN ('chargers', 'installation', 'grid', 'other')),
  description    TEXT NOT NULL,
  amount_minor   BIGINT NOT NULL CHECK (amount_minor > 0),
  currency       TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  invested_on    DATE NOT NULL,
  life_months    INT NOT NULL CHECK (life_months BETWEEN 1 AND 360),
  reference      TEXT,
  recorded_by    UUID REFERENCES app_user(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at      TIMESTAMPTZ,
  voided_by      UUID REFERENCES app_user(id),
  void_reason    TEXT
);
CREATE INDEX IF NOT EXISTS site_investment_site_idx ON site_investment (org_id, site_id) WHERE voided_at IS NULL;

ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS revenue_alerts JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS fleet_statements JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS revenue_anomaly (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organisation(id),
  site_id        UUID NOT NULL REFERENCES site(id),
  day            DATE NOT NULL,
  currency       TEXT NOT NULL,
  revenue_minor  BIGINT NOT NULL,
  baseline_minor BIGINT NOT NULL,
  drop_pct       NUMERIC(6,1) NOT NULL,
  sessions       INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, site_id, day, currency)
);

CREATE TABLE IF NOT EXISTS fleet_statement_send (
  id                BIGSERIAL PRIMARY KEY,
  org_id            UUID NOT NULL REFERENCES organisation(id),
  fleet_account_id  UUID NOT NULL REFERENCES fleet_account(id),
  month             TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  automatic         BOOLEAN NOT NULL DEFAULT false,
  sent_to           TEXT,
  closing_minor     JSONB NOT NULL DEFAULT '{}'::jsonb,
  reference         TEXT,
  error             TEXT,
  sent_by           UUID REFERENCES app_user(id),
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fleet_statement_send_acct_idx ON fleet_statement_send (org_id, fleet_account_id, month);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_period_lock', 'site_investment', 'revenue_anomaly', 'fleet_statement_send'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON finance_period_lock, site_investment, revenue_anomaly, fleet_statement_send TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON finance_period_lock, site_investment, revenue_anomaly, fleet_statement_send FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE finance_period_lock_id_seq, site_investment_id_seq, revenue_anomaly_id_seq, fleet_statement_send_id_seq TO plugsure_app;
  END IF;
END $$;
