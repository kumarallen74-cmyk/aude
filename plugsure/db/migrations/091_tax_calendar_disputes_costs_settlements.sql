-- 091 (v1.23.0) finance phase 12.
--
--   tax_filing                    a tax obligation of a period marked filed (PPh 23, PPN, e-Faktur): when, the reference
--                                 (NTPN / BPE / receipt), the amount; voided with a reason
--   owner_statement_dispute       a site owner's query on a finalised statement (from the owner portal), answered by the
--                                 operator: rejected, resolved, or adjusted
--   owner_statement_adjustment    an amount the operator owes the owner (or the owner the operator, negative) from a
--                                 dispute, added to the owner's share on the next statement finalised
--   finance_shared_cost           a cost shared by sites (rent, maintenance contract, connectivity, insurance, other),
--                                 per month from month_from to month_to, allocated by kWh, sessions, revenue or equally
--   finance_org_settings
--     .tax_calendar               the obligations and their due day in the following month, and the reminder days
--     .settlement_tracking        {graceDays, withdrawalDays}: when a settlement is late, and a withdrawal missing
--
-- Additive. Rollback: db/rollback/091_down.sql.

CREATE TABLE IF NOT EXISTS tax_filing (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organisation(id),
  obligation     TEXT NOT NULL CHECK (obligation ~ '^[a-z0-9_]{2,40}$'),
  period         TEXT NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  filed_on       DATE NOT NULL,
  reference      TEXT NOT NULL,
  amount_minor   BIGINT,
  note           TEXT,
  filed_by       UUID REFERENCES app_user(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at      TIMESTAMPTZ,
  voided_by      UUID REFERENCES app_user(id),
  void_reason    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS tax_filing_live_uq ON tax_filing (org_id, obligation, period) WHERE voided_at IS NULL;

CREATE TABLE IF NOT EXISTS owner_statement_dispute (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organisation(id),
  owner_id       UUID NOT NULL REFERENCES site_owner(id),
  statement_id   UUID NOT NULL REFERENCES commission_statement(id),
  line           TEXT,
  message        TEXT NOT NULL,
  claimed_minor  BIGINT,
  state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'rejected', 'resolved', 'adjusted', 'withdrawn')),
  raised_by      UUID REFERENCES app_user(id),
  raised_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  answer         TEXT,
  answered_by    UUID REFERENCES app_user(id),
  answered_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS owner_statement_dispute_org_idx ON owner_statement_dispute (org_id, state);

CREATE TABLE IF NOT EXISTS owner_statement_adjustment (
  id                    BIGSERIAL PRIMARY KEY,
  org_id                UUID NOT NULL REFERENCES organisation(id),
  owner_id              UUID NOT NULL REFERENCES site_owner(id),
  dispute_id            BIGINT REFERENCES owner_statement_dispute(id),
  currency              TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor          BIGINT NOT NULL CHECK (amount_minor <> 0),
  note                  TEXT NOT NULL,
  created_by            UUID REFERENCES app_user(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_statement_id  UUID REFERENCES commission_statement(id),
  applied_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS owner_statement_adjustment_open_idx ON owner_statement_adjustment (org_id, owner_id, currency) WHERE applied_statement_id IS NULL;

CREATE TABLE IF NOT EXISTS finance_shared_cost (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organisation(id),
  category       TEXT NOT NULL CHECK (category IN ('rent', 'maintenance', 'connectivity', 'insurance', 'staff', 'other')),
  description    TEXT NOT NULL,
  amount_minor   BIGINT NOT NULL CHECK (amount_minor > 0),
  currency       TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  basis          TEXT NOT NULL CHECK (basis IN ('kwh', 'sessions', 'revenue', 'equal')),
  site_ids       UUID[],
  month_from     TEXT NOT NULL CHECK (month_from ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  month_to       TEXT CHECK (month_to IS NULL OR month_to ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  recorded_by    UUID REFERENCES app_user(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at      TIMESTAMPTZ,
  voided_by      UUID REFERENCES app_user(id),
  void_reason    TEXT,
  CHECK (month_to IS NULL OR month_to >= month_from)
);
CREATE INDEX IF NOT EXISTS finance_shared_cost_org_idx ON finance_shared_cost (org_id) WHERE voided_at IS NULL;

ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS tax_calendar JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS settlement_tracking JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['tax_filing', 'owner_statement_dispute', 'owner_statement_adjustment', 'finance_shared_cost'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON tax_filing, owner_statement_dispute, owner_statement_adjustment, finance_shared_cost TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON tax_filing, owner_statement_dispute, owner_statement_adjustment, finance_shared_cost FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE tax_filing_id_seq, owner_statement_dispute_id_seq, owner_statement_adjustment_id_seq, finance_shared_cost_id_seq TO plugsure_app;
  END IF;
END $$;
