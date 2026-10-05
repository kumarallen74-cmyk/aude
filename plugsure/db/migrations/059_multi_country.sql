-- 059: countries, currencies, per-row currency (docs/MULTI-COUNTRY-DESIGN.md §5.2, §5.4).
--
-- ALL ADDITIVE and safe while v1.6 runs: old code ignores the new columns, and
-- every default is a constant, so no table is rewritten (Postgres >= 11 stores a
-- constant default in the catalogue). Every existing row becomes Indonesia / IDR
-- with its value unchanged: IDR's PlugSure exponent is 0 (whole rupiah), which is
-- what every *_idr column already holds.
--
-- Foreign keys are added NOT VALID (no scan under the ACCESS EXCLUSIVE lock of
-- ALTER TABLE) and validated by 061 under SHARE UPDATE EXCLUSIVE.
--
-- Deviation from the design sketch: the unique-index / primary-key swaps on
-- integration, commission_statement and ocpi_party are in 060, not here. v1.6
-- code names those exact indexes as ON CONFLICT arbiters
-- (integrations/store.ts, commission.ts, ocpi/store.ts), so swapping them here
-- would break the running v1.6 code and this migration would not be additive.

CREATE TABLE IF NOT EXISTS currency_unit (
  code         TEXT PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  exponent     SMALLINT NOT NULL CHECK (exponent BETWEEN 0 AND 3),   -- PlugSure storage unit
  iso_exponent SMALLINT NOT NULL,
  symbol       TEXT NOT NULL
);
INSERT INTO currency_unit VALUES ('IDR',0,2,'Rp'),('MYR',2,2,'RM'),('SGD',2,2,'S$')
  ON CONFLICT (code) DO NOTHING;
COMMENT ON TABLE currency_unit IS 'PlugSure money unit per currency: amounts are integers in 10^-exponent of the major unit (IDR exponent 0 = whole rupiah).';

CREATE TABLE IF NOT EXISTS country (
  code               TEXT PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$'),
  alpha3             TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  currency           TEXT NOT NULL REFERENCES currency_unit(code),
  timezones          TEXT[] NOT NULL,
  phone_cc           TEXT NOT NULL,
  default_locale     TEXT NOT NULL,
  tax_engine         TEXT NOT NULL,
  regulatory_profile TEXT NOT NULL,
  active             BOOLEAN NOT NULL DEFAULT true
);
INSERT INTO country VALUES
  ('ID','IDN','Indonesia','IDR', ARRAY['Asia/Jakarta','Asia/Pontianak','Asia/Makassar','Asia/Jayapura'],'62','id','ID_PPN_PBJT','ID',true),
  ('MY','MYS','Malaysia','MYR',  ARRAY['Asia/Kuala_Lumpur','Asia/Kuching'],'60','en','MY_SST','MY',true),
  ('SG','SGP','Singapore','SGD', ARRAY['Asia/Singapore'],'65','en','SG_GST','SG',true)
ON CONFLICT (code) DO NOTHING;

-- Reference data: readable by the runtime role (no RLS: platform-wide).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT ON currency_unit, country TO plugsure_app;
  END IF;
END $$;

-- ───────────────────────────────────────────── organisation and site

ALTER TABLE organisation
  ADD COLUMN IF NOT EXISTS home_country_code TEXT NOT NULL DEFAULT 'ID',
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta',
  ADD COLUMN IF NOT EXISTS default_locale TEXT NOT NULL DEFAULT 'id',
  ADD COLUMN IF NOT EXISTS roaming_settings JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE organisation DROP CONSTRAINT IF EXISTS organisation_home_country_fk;
ALTER TABLE organisation ADD CONSTRAINT organisation_home_country_fk
  FOREIGN KEY (home_country_code) REFERENCES country(code) NOT VALID;

ALTER TABLE site
  ADD COLUMN IF NOT EXISTS country_code TEXT NOT NULL DEFAULT 'ID',
  ADD COLUMN IF NOT EXISTS tax_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE site DROP CONSTRAINT IF EXISTS site_country_fk;
ALTER TABLE site ADD CONSTRAINT site_country_fk FOREIGN KEY (country_code) REFERENCES country(code) NOT VALID;

ALTER TABLE charge_point ADD COLUMN IF NOT EXISTS regulatory_ref TEXT;

ALTER TABLE tariff
  ADD COLUMN IF NOT EXISTS country_code TEXT NOT NULL DEFAULT 'ID',
  ADD COLUMN IF NOT EXISTS prices_include_tax BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tariff DROP CONSTRAINT IF EXISTS tariff_country_fk;
ALTER TABLE tariff ADD CONSTRAINT tariff_country_fk FOREIGN KEY (country_code) REFERENCES country(code) NOT VALID;
ALTER TABLE tariff DROP CONSTRAINT IF EXISTS tariff_currency_fk;
ALTER TABLE tariff ADD CONSTRAINT tariff_currency_fk FOREIGN KEY (currency) REFERENCES currency_unit(code) NOT VALID;

-- ───────────────────────────────────────────── currency on every money-bearing row

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['charging_session','cdr','payment_intent','driver_charge','driver_reservation',
    'reservation_checkout','subscription_plan','subscription_charge','subscription_session','promotion',
    'promotion_redemption','loyalty_program','loyalty_entry','fleet_invoice','fleet_credit_note',
    'commission_statement','commercial_plan']
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT %L', t, 'IDR');
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_currency_fk');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (currency) REFERENCES currency_unit(code) NOT VALID',
                   t, t || '_currency_fk');
  END LOOP;
END $$;

ALTER TABLE cdr
  ADD COLUMN IF NOT EXISTS tax_scheme TEXT NOT NULL DEFAULT 'ID_PPN_PBJT',
  ADD COLUMN IF NOT EXISTS prices_include_tax BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rounding_minor INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_detail JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE token ADD COLUMN IF NOT EXISTS spend_limit_currency TEXT NOT NULL DEFAULT 'IDR';
ALTER TABLE token DROP CONSTRAINT IF EXISTS token_spend_limit_currency_fk;
ALTER TABLE token ADD CONSTRAINT token_spend_limit_currency_fk
  FOREIGN KEY (spend_limit_currency) REFERENCES currency_unit(code) NOT VALID;

ALTER TABLE app_driver ADD COLUMN IF NOT EXISTS locale TEXT;
ALTER TABLE driver_app_brand ADD COLUMN IF NOT EXISTS default_locale TEXT NOT NULL DEFAULT 'id';

-- ───────────────────────────────────────────── tax registrations per (org, country)

CREATE TABLE IF NOT EXISTS org_tax_registration (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organisation(id),
  country_code        TEXT NOT NULL REFERENCES country(code),
  scheme              TEXT NOT NULL CHECK (scheme IN ('ID_PKP','MY_SST','SG_GST')),
  registration_no     TEXT,
  registered          BOOLEAN NOT NULL DEFAULT true,
  -- MY: whether EV charging is a taxable service for this operator [VERIFY V1].
  ev_charging_taxable BOOLEAN NOT NULL DEFAULT true,
  rate_bps            INTEGER CHECK (rate_bps BETWEEN 0 AND 3000),
  effective_from      DATE NOT NULL,
  effective_to        DATE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          TEXT,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS org_tax_registration_open_uq
  ON org_tax_registration (org_id, country_code, scheme) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS org_tax_registration_org_idx ON org_tax_registration (org_id, country_code);

ALTER TABLE org_tax_registration ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_tax_registration FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_tax_registration_tenant ON org_tax_registration;
-- The fail-closed shape of migration 048 (bypass only for unscoped system work).
CREATE POLICY org_tax_registration_tenant ON org_tax_registration
  USING (app_rls_bypass() OR org_id = app_current_org())
  WITH CHECK (app_rls_bypass() OR org_id = app_current_org());

-- Backfill: every organisation's Indonesian PKP status as a registration row.
-- (organisation.pkp / npwp stay the source v1.6 reads; the ID engine reads
-- tariff.ppn_applies exactly as before, so this row is informational for ID.)
INSERT INTO org_tax_registration (org_id, country_code, scheme, registration_no, registered, effective_from, created_by)
  SELECT id, 'ID', 'ID_PKP', npwp, COALESCE(pkp, false), DATE '2000-01-01', 'migration 059'
    FROM organisation o
   WHERE NOT EXISTS (SELECT 1 FROM org_tax_registration r WHERE r.org_id = o.id AND r.scheme = 'ID_PKP');

-- ───────────────────────────────────────────── acquirers per country (column only; index in 060)

ALTER TABLE integration ADD COLUMN IF NOT EXISTS country_code TEXT;
ALTER TABLE integration DROP CONSTRAINT IF EXISTS integration_country_fk;
ALTER TABLE integration ADD CONSTRAINT integration_country_fk FOREIGN KEY (country_code) REFERENCES country(code) NOT VALID;

-- ───────────────────────────────────────────── OCPI (column only; PK swap in 060)

ALTER TABLE ocpi_party ADD COLUMN IF NOT EXISTS is_home BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE ocpi_partner DROP CONSTRAINT IF EXISTS ocpi_partner_kind_check;
ALTER TABLE ocpi_partner ADD CONSTRAINT ocpi_partner_kind_check CHECK (kind IN ('emsp','cpo','hub','authority'));

-- ───────────────────────────────────────────── roaming guarantee (WP2 uses these)

ALTER TABLE driver_roaming_charge
  ADD COLUMN IF NOT EXISTS app_driver_id UUID REFERENCES app_driver(id),
  ADD COLUMN IF NOT EXISTS payment_intent_id UUID REFERENCES payment_intent(id),
  ADD COLUMN IF NOT EXISTS currency TEXT;
ALTER TABLE payment_intent ADD COLUMN IF NOT EXISTS roaming_charge_id UUID REFERENCES driver_roaming_charge(id);

-- ───────────────────────────────────────────── one live fleet invoice per account, month AND currency
-- (no ON CONFLICT names this index; every v1.6 row is IDR, so it is equivalent for v1.6)

DROP INDEX IF EXISTS fleet_invoice_live_uq;
CREATE UNIQUE INDEX IF NOT EXISTS fleet_invoice_live_uq ON fleet_invoice (fleet_account_id, period, currency) WHERE status <> 'void';
