-- v1.3: fleet monthly statements, B2B invoices and e-Faktur export.
--
-- A fleet account is the company a fleet card is billed to, with what a tax
-- invoice needs (legal name, NPWP, NITKU, address, billing e-mail, terms).
-- Cards keep their free-text fleet name in the RFID centre; a card is linked to
-- the account of that name (created on first use, and here for existing cards).
--
-- An invoice freezes one account's month: the sessions at this operator's
-- chargers (by the month their charge record was issued) and, optionally, the
-- charge records other networks sent for the account's cards. Each session or
-- record can be on only one live invoice; voiding an invoice releases them.
--
-- Additive: nothing is invoiced until someone issues an invoice.

CREATE TABLE IF NOT EXISTS fleet_account (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organisation(id),
  name                TEXT NOT NULL,
  legal_name          TEXT,
  -- 16-digit NPWP (a 15-digit one is stored with its leading 0), or a NIK for a person.
  tax_id              TEXT,
  tax_id_kind         TEXT NOT NULL DEFAULT 'TIN' CHECK (tax_id_kind IN ('TIN', 'NIK', 'Passport', 'Other')),
  -- 22-digit NITKU (place-of-business ID); head office = NPWP + '000000'.
  nitku               TEXT,
  address             TEXT,
  billing_email       TEXT,
  contact_name        TEXT,
  phone               TEXT,
  payment_terms_days  INTEGER NOT NULL DEFAULT 14 CHECK (payment_terms_days BETWEEN 0 AND 120),
  include_roaming     BOOLEAN NOT NULL DEFAULT true,
  notes               TEXT,
  archived_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

ALTER TABLE token ADD COLUMN IF NOT EXISTS fleet_account_id UUID REFERENCES fleet_account(id);
CREATE INDEX IF NOT EXISTS token_fleet_account_idx ON token (fleet_account_id) WHERE fleet_account_id IS NOT NULL;

-- Existing fleet cards: one account per fleet name, and the link.
INSERT INTO fleet_account (org_id, name)
SELECT DISTINCT org_id, trim(fleet_name) FROM token
 WHERE fleet_name IS NOT NULL AND trim(fleet_name) <> ''
ON CONFLICT (org_id, name) DO NOTHING;
UPDATE token t SET fleet_account_id = f.id
  FROM fleet_account f
 WHERE f.org_id = t.org_id AND f.name = trim(t.fleet_name) AND t.fleet_account_id IS NULL;

-- From now on the database keeps the link: a card's fleet name decides its
-- account (created the first time a name is used), whichever path wrote it —
-- the RFID centre, the API, the seed or a sandbox.
CREATE OR REPLACE FUNCTION token_link_fleet_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  n   TEXT := NULLIF(trim(NEW.fleet_name), '');
  aid UUID;
BEGIN
  IF n IS NULL THEN
    NEW.fleet_account_id := NULL;
    RETURN NEW;
  END IF;
  INSERT INTO fleet_account (org_id, name) VALUES (NEW.org_id, n) ON CONFLICT (org_id, name) DO NOTHING;
  SELECT id INTO aid FROM fleet_account WHERE org_id = NEW.org_id AND name = n;
  NEW.fleet_account_id := aid;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS token_fleet_account ON token;
CREATE TRIGGER token_fleet_account BEFORE INSERT OR UPDATE OF fleet_name ON token
  FOR EACH ROW EXECUTE FUNCTION token_link_fleet_account();

CREATE TABLE IF NOT EXISTS fleet_invoice (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organisation(id),
  fleet_account_id    UUID NOT NULL REFERENCES fleet_account(id),
  period              DATE NOT NULL,                 -- first day of the month
  number              TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'paid', 'void')),
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_date            DATE NOT NULL,
  sessions            INTEGER NOT NULL,
  energy_wh           BIGINT NOT NULL,
  subtotal_idr        BIGINT NOT NULL,
  pbjt_idr            BIGINT NOT NULL,
  tax_base_idr        BIGINT NOT NULL,               -- harga jual subject to PPN
  dpp_idr             BIGINT NOT NULL,               -- DPP nilai lain
  ppn_idr             BIGINT NOT NULL,
  own_total_idr       BIGINT NOT NULL,
  roaming_total_idr   BIGINT NOT NULL,
  total_idr           BIGINT NOT NULL,
  data                JSONB NOT NULL,                -- the frozen statement
  issued_by           TEXT,
  paid_at             DATE,
  paid_reference      TEXT,
  voided_at           TIMESTAMPTZ,
  void_reason         TEXT,
  efaktur_exported_at TIMESTAMPTZ,
  efaktur_number      TEXT,                          -- the faktur pajak number from Coretax
  sent_at             TIMESTAMPTZ,
  sent_to             TEXT,
  UNIQUE (org_id, number)
);
-- One live invoice per account and month.
CREATE UNIQUE INDEX IF NOT EXISTS fleet_invoice_live_uq ON fleet_invoice (fleet_account_id, period) WHERE status <> 'void';
CREATE INDEX IF NOT EXISTS fleet_invoice_org_period_idx ON fleet_invoice (org_id, period DESC);

-- What each live invoice bills: a session here, or a partner network's charge record.
CREATE TABLE IF NOT EXISTS fleet_invoice_item (
  invoice_id  UUID NOT NULL REFERENCES fleet_invoice(id) ON DELETE CASCADE,
  org_id      UUID NOT NULL REFERENCES organisation(id),
  kind        TEXT NOT NULL CHECK (kind IN ('session', 'roaming')),
  ref_id      UUID NOT NULL,
  PRIMARY KEY (kind, ref_id)
);
CREATE INDEX IF NOT EXISTS fleet_invoice_item_invoice_idx ON fleet_invoice_item (invoice_id);

-- The seller's side of a tax invoice, and the e-Faktur item settings.
ALTER TABLE organisation
  ADD COLUMN IF NOT EXISTS billing_address   TEXT,
  ADD COLUMN IF NOT EXISTS nitku             TEXT,
  ADD COLUMN IF NOT EXISTS invoice_settings  JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['fleet_account', 'fleet_invoice', 'fleet_invoice_item'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$I_tenant ON %1$I', t);
    EXECUTE format($p$CREATE POLICY %1$I_tenant ON %1$I
      USING (app_current_org() IS NULL OR org_id = app_current_org())
      WITH CHECK (app_current_org() IS NULL OR org_id = app_current_org())$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
