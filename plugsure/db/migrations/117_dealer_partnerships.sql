-- v1.50.0 (phase 38): EV dealer partnerships. Additive.
--
--   dealer            a car dealer partner: the welcome credit its buyers get, who pays for it, the commission on its
--                     buyers' charging, its portal link
--   dealer_sale       a car sold: the buyer, the vehicle, the welcome code (hashed) and who redeemed it
--   dealer_statement  a dealer's month: sales, credit redeemed, its buyers' charging, commission, the net

CREATE TABLE IF NOT EXISTS dealer (
  id                 BIGSERIAL PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organisation(id),
  name               TEXT NOT NULL,
  make               TEXT,                       -- the car brand it sells (Wuling, Hyundai, BYD …)
  branch             TEXT,
  contact_name       TEXT,
  email              TEXT,
  phone              TEXT,
  currency           TEXT NOT NULL,
  welcome_minor      BIGINT NOT NULL DEFAULT 0 CHECK (welcome_minor >= 0),
  code_days          INTEGER NOT NULL DEFAULT 90 CHECK (code_days BETWEEN 7 AND 365),   -- a welcome code is valid this long
  -- dealer: the dealer is billed for the welcome credit its buyers redeem; operator: the operator funds it
  funding            TEXT NOT NULL DEFAULT 'dealer' CHECK (funding IN ('dealer', 'operator')),
  commission_bps     INTEGER NOT NULL DEFAULT 0 CHECK (commission_bps BETWEEN 0 AND 5000),
  commission_months  INTEGER NOT NULL DEFAULT 12 CHECK (commission_months BETWEEN 1 AND 60),
  portal_token_hash  TEXT UNIQUE,
  portal_token_prefix TEXT,
  archived_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dealer_sale (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  dealer_id       BIGINT NOT NULL REFERENCES dealer(id),
  number          TEXT NOT NULL,
  buyer_name      TEXT NOT NULL,
  buyer_phone     TEXT,
  vehicle         TEXT,
  vin             TEXT,
  plate           TEXT,
  sold_on         DATE NOT NULL,
  code_hash       TEXT NOT NULL UNIQUE,
  code_last4      TEXT NOT NULL,
  welcome_minor   BIGINT NOT NULL,
  currency        TEXT NOT NULL,
  funding         TEXT NOT NULL CHECK (funding IN ('dealer', 'operator')),
  code_expires_on DATE NOT NULL,
  app_driver_id   UUID REFERENCES app_driver(id),
  redeemed_at     TIMESTAMPTZ,
  voided_at       TIMESTAMPTZ,
  created_via     TEXT NOT NULL DEFAULT 'console' CHECK (created_via IN ('console', 'portal')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE INDEX IF NOT EXISTS dealer_sale_dealer_idx ON dealer_sale (dealer_id, sold_on DESC);
CREATE UNIQUE INDEX IF NOT EXISTS dealer_sale_vin_idx ON dealer_sale (org_id, vin) WHERE vin IS NOT NULL AND voided_at IS NULL;
CREATE INDEX IF NOT EXISTS dealer_sale_driver_idx ON dealer_sale (app_driver_id) WHERE app_driver_id IS NOT NULL;

ALTER TABLE driver_credit_entry ADD COLUMN IF NOT EXISTS dealer_sale_id BIGINT REFERENCES dealer_sale(id);

CREATE TABLE IF NOT EXISTS dealer_statement (
  id                BIGSERIAL PRIMARY KEY,
  org_id            UUID NOT NULL REFERENCES organisation(id),
  dealer_id         BIGINT NOT NULL REFERENCES dealer(id),
  month             TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  currency          TEXT NOT NULL,
  sales             INTEGER NOT NULL DEFAULT 0,
  redeemed          INTEGER NOT NULL DEFAULT 0,
  welcome_minor     BIGINT NOT NULL DEFAULT 0,     -- welcome credit redeemed this month (billed to the dealer when it funds it)
  billed_minor      BIGINT NOT NULL DEFAULT 0,     -- of which billed to the dealer
  drivers           INTEGER NOT NULL DEFAULT 0,    -- its buyers who charged this month (within the commission window)
  kwh               NUMERIC(14, 3) NOT NULL DEFAULT 0,
  revenue_minor     BIGINT NOT NULL DEFAULT 0,     -- their charging, before tax
  commission_minor  BIGINT NOT NULL DEFAULT 0,     -- owed to the dealer
  net_minor         BIGINT NOT NULL DEFAULT 0,     -- billed − commission: > 0 the dealer pays, < 0 the operator pays
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'settled')),
  issued_at         TIMESTAMPTZ,
  settled_at        TIMESTAMPTZ,
  reference         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dealer_id, month)
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['dealer', 'dealer_sale', 'dealer_statement'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON dealer, dealer_sale, dealer_statement TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON dealer, dealer_sale, dealer_statement FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE dealer_id_seq, dealer_sale_id_seq, dealer_statement_id_seq TO plugsure_app;
  END IF;
END $$;
