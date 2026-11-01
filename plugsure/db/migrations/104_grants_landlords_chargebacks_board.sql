-- 104 (v1.36.0) finance phase 25.
--
--   grant_programme       a government or utility grant or incentive: grantor, programme, kind (capital: deferred and
--                         released over a period; revenue; per kWh charged), the amount awarded, the period, status
--   grant_condition       a grant's conditions: what, by when, met / breached / waived
--   grant_claim           claims under a grant (CL… numbers per grant): the period, the kWh, the amount; submitted,
--                         approved, rejected, paid (to which account)
--   grant_clawback        an amount the grantor takes back (a condition breached), and when it was repaid
--   landlord_deal         a site's rent deal with its landlord (a supplier): fixed, a share of revenue or margin, the
--                         higher of a share and a minimum guarantee, or fixed plus a share; yearly escalation, rent-free
--                         months, an energy recharge per kWh, monthly or quarterly; optionally the PSAK 73 lease holding
--                         its fixed rent
--   landlord_statement    a statement to the landlord for a month or quarter (LS-00001…): the lines per month, the total;
--                         issued as a supplier bill
--   chargeback            a card or e-wallet chargeback on a payment: the provider's case, reason, amount, fee, the date
--                         to respond by; open, evidence submitted, won, lost, accepted
--   gl_entry.source       gains 'grants', 'landlords', 'chargebacks'
--
-- Additive. Rollback: db/rollback/104_down.sql.

CREATE TABLE IF NOT EXISTS grant_programme (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  grantor          TEXT NOT NULL,
  programme        TEXT NOT NULL,
  reference        TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('capital', 'revenue', 'per_kwh')),
  currency         TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  awarded_minor    BIGINT NOT NULL CHECK (awarded_minor >= 0),
  rate_per_kwh     NUMERIC(14,4) CHECK (rate_per_kwh IS NULL OR rate_per_kwh >= 0),
  period_from      DATE,
  period_to        DATE,
  release_months   INT CHECK (release_months IS NULL OR release_months BETWEEN 1 AND 480),
  site_id          UUID REFERENCES site(id),
  capex_project_id BIGINT REFERENCES capex_project(id),
  status           TEXT NOT NULL DEFAULT 'awarded' CHECK (status IN ('applied', 'awarded', 'active', 'completed', 'rejected', 'clawed_back')),
  awarded_on       DATE,
  note             TEXT,
  created_by       UUID REFERENCES app_user(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_to IS NULL OR period_from IS NULL OR period_to >= period_from)
);

CREATE TABLE IF NOT EXISTS grant_condition (
  id           BIGSERIAL PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES organisation(id),
  grant_id     BIGINT NOT NULL REFERENCES grant_programme(id),
  description  TEXT NOT NULL,
  due_on       DATE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'met', 'breached', 'waived')),
  met_on       DATE,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS grant_claim (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  grant_id         BIGINT NOT NULL REFERENCES grant_programme(id),
  number           TEXT NOT NULL,
  period_from      DATE,
  period_to        DATE,
  kwh              NUMERIC(14,3),
  amount_minor     BIGINT NOT NULL CHECK (amount_minor > 0),
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'paid')),
  submitted_on     DATE,
  approved_on      DATE,
  paid_on          DATE,
  paid_minor       BIGINT CHECK (paid_minor IS NULL OR paid_minor >= 0),
  cash_account_id  BIGINT REFERENCES cash_account(id),
  reference        TEXT,
  note             TEXT,
  created_by       UUID REFERENCES app_user(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);

CREATE TABLE IF NOT EXISTS grant_clawback (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  grant_id         BIGINT NOT NULL REFERENCES grant_programme(id),
  condition_id     BIGINT REFERENCES grant_condition(id),
  amount_minor     BIGINT NOT NULL CHECK (amount_minor > 0),
  on_date          DATE NOT NULL,
  repaid_on        DATE,
  cash_account_id  BIGINT REFERENCES cash_account(id),
  note             TEXT NOT NULL,
  created_by       UUID REFERENCES app_user(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS landlord_deal (
  id                 BIGSERIAL PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organisation(id),
  site_id            UUID NOT NULL REFERENCES site(id),
  supplier_id        BIGINT NOT NULL REFERENCES supplier(id),
  reference          TEXT,
  currency           TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  basis              TEXT NOT NULL CHECK (basis IN ('fixed', 'share', 'higher_of', 'fixed_plus_share')),
  fixed_minor        BIGINT NOT NULL DEFAULT 0 CHECK (fixed_minor >= 0),
  share_pct          NUMERIC(6,3) NOT NULL DEFAULT 0 CHECK (share_pct BETWEEN 0 AND 100),
  share_of           TEXT NOT NULL DEFAULT 'revenue' CHECK (share_of IN ('revenue', 'margin')),
  minimum_minor      BIGINT NOT NULL DEFAULT 0 CHECK (minimum_minor >= 0),
  escalation_pct     NUMERIC(6,3) NOT NULL DEFAULT 0 CHECK (escalation_pct BETWEEN 0 AND 50),
  rent_free_months   INT NOT NULL DEFAULT 0 CHECK (rent_free_months BETWEEN 0 AND 60),
  recharge_per_kwh   NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (recharge_per_kwh >= 0),
  billing            TEXT NOT NULL DEFAULT 'monthly' CHECK (billing IN ('monthly', 'quarterly')),
  start_on           DATE NOT NULL,
  end_on             DATE,
  lease_id           BIGINT REFERENCES lease(id),
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  note               TEXT,
  created_by         UUID REFERENCES app_user(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_on IS NULL OR end_on > start_on)
);

CREATE TABLE IF NOT EXISTS landlord_statement (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  deal_id       BIGINT NOT NULL REFERENCES landlord_deal(id),
  number        TEXT NOT NULL,
  month_from    TEXT NOT NULL CHECK (month_from ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  month_to      TEXT NOT NULL CHECK (month_to ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  lines         JSONB NOT NULL,
  total_minor   BIGINT NOT NULL CHECK (total_minor >= 0),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'void')),
  bill_id       BIGINT REFERENCES supplier_bill(id),
  issued_at     TIMESTAMPTZ,
  issued_by     UUID REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE UNIQUE INDEX IF NOT EXISTS landlord_statement_live_uq ON landlord_statement (deal_id, month_from) WHERE status <> 'void';

CREATE TABLE IF NOT EXISTS chargeback (
  id                 BIGSERIAL PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organisation(id),
  payment_intent_id  UUID REFERENCES payment_intent(id),
  provider           TEXT NOT NULL,
  case_ref           TEXT NOT NULL,
  reason             TEXT NOT NULL CHECK (reason IN ('fraud', 'not_received', 'not_as_described', 'duplicate', 'amount', 'cancelled', 'other')),
  reason_code        TEXT,
  currency           TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor       BIGINT NOT NULL CHECK (amount_minor > 0),
  fee_minor          BIGINT NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  received_on        DATE NOT NULL,
  respond_by         DATE NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'evidence_submitted', 'won', 'lost', 'accepted')),
  evidence_sent_on   DATE,
  outcome_on         DATE,
  note               TEXT,
  created_by         UUID REFERENCES app_user(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider, case_ref)
);
CREATE INDEX IF NOT EXISTS chargeback_intent_idx ON chargeback (payment_intent_id);

ALTER TABLE gl_entry DROP CONSTRAINT IF EXISTS gl_entry_source_check;
ALTER TABLE gl_entry ADD CONSTRAINT gl_entry_source_check
  CHECK (source IN ('manual', 'gateway', 'assets', 'leases', 'provision', 'bills', 'deposits', 'expenses', 'intercompany', 'reversal', 'payroll', 'customer_deposits', 'projects',
                    'inventory', 'maintenance', 'loans', 'carbon', 'insurance', 'grants', 'landlords', 'chargebacks'));

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['grant_programme', 'grant_condition', 'grant_claim', 'grant_clawback', 'landlord_deal', 'landlord_statement', 'chargeback'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON grant_programme, grant_condition, grant_claim, grant_clawback, landlord_deal, landlord_statement, chargeback TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON grant_programme, grant_condition, grant_claim, grant_clawback, landlord_deal, landlord_statement, chargeback FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE grant_programme_id_seq, grant_condition_id_seq, grant_claim_id_seq, grant_clawback_id_seq, landlord_deal_id_seq, landlord_statement_id_seq, chargeback_id_seq TO plugsure_app;
  END IF;
END $$;
