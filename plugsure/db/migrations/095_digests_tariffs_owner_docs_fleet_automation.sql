-- 095 (v1.27.0) finance phase 16.
--
--   finance_digest_subscription   per console user: a finance digest daily or weekly, by e-mail and/or WhatsApp, at
--                                 an hour (billing time zone); which sections
--   finance_digest_send           each digest sent, per channel, with the result
--   site_tariff                   a site's electricity tariff: the PLN class, the connected power (kVA), the peak
--                                 (WBP) and off-peak (LWBP) rates per kWh, the peak hours, the monthly capacity charge
--   fleet_invoice_link            a Xendit payment link for an issued fleet invoice, on the operator's own Xendit
--                                 account; paid → the invoice marked paid
--   finance_org_settings          finance_digest (the WhatsApp template for digests) and fleet_automation: issue invoices on a day of the month, send them, require the
--                                 e-Faktur number first, payment links
--   tax_withholding               kind 'owner_share' (tax withheld from a site owner's share, e.g. PPh 4(2) on rent),
--                                 with the owner
--
-- Additive. Rollback: db/rollback/095_down.sql.

ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS fleet_automation JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE finance_org_settings ADD COLUMN IF NOT EXISTS finance_digest JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE tax_withholding ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES site_owner(id);
ALTER TABLE tax_withholding DROP CONSTRAINT IF EXISTS tax_withholding_kind_check;
ALTER TABLE tax_withholding ADD CONSTRAINT tax_withholding_kind_check CHECK (kind = ANY (ARRAY['gateway_fee', 'platform_fee', 'owner_share']));
CREATE INDEX IF NOT EXISTS tax_withholding_owner_idx ON tax_withholding (owner_id) WHERE owner_id IS NOT NULL AND voided_at IS NULL;

CREATE TABLE IF NOT EXISTS finance_digest_subscription (
  user_id       UUID PRIMARY KEY REFERENCES app_user(id),
  org_id        UUID NOT NULL REFERENCES organisation(id),
  frequency     TEXT NOT NULL DEFAULT 'off' CHECK (frequency IN ('off', 'daily', 'weekly')),
  channels      TEXT[] NOT NULL DEFAULT '{email}',
  sections      TEXT[] NOT NULL DEFAULT '{figures,approvals,overdue,cash,anomalies}',
  hour          SMALLINT NOT NULL DEFAULT 7 CHECK (hour BETWEEN 0 AND 23),
  weekday       SMALLINT NOT NULL DEFAULT 1 CHECK (weekday BETWEEN 1 AND 7),
  phone         TEXT,
  last_sent_at  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance_digest_send (
  id        BIGSERIAL PRIMARY KEY,
  org_id    UUID NOT NULL REFERENCES organisation(id),
  user_id   UUID NOT NULL REFERENCES app_user(id),
  channel   TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  ok        BOOLEAN NOT NULL,
  error     TEXT,
  automatic BOOLEAN NOT NULL DEFAULT true,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_digest_send_user_idx ON finance_digest_send (user_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS site_tariff (
  site_id                UUID PRIMARY KEY REFERENCES site(id),
  org_id                 UUID NOT NULL REFERENCES organisation(id),
  tariff_class           TEXT NOT NULL,
  power_kva              NUMERIC(10, 1) NOT NULL CHECK (power_kva > 0),
  rate_peak              NUMERIC(12, 2) NOT NULL CHECK (rate_peak >= 0),
  rate_offpeak           NUMERIC(12, 2) NOT NULL CHECK (rate_offpeak >= 0),
  peak_from              SMALLINT NOT NULL DEFAULT 17 CHECK (peak_from BETWEEN 0 AND 23),
  peak_to                SMALLINT NOT NULL DEFAULT 22 CHECK (peak_to BETWEEN 1 AND 24),
  capacity_charge_minor  BIGINT NOT NULL DEFAULT 0 CHECK (capacity_charge_minor >= 0),
  currency               TEXT NOT NULL,
  updated_by             UUID REFERENCES app_user(id),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fleet_invoice_link (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  invoice_id       UUID NOT NULL REFERENCES fleet_invoice(id),
  integration_id   UUID REFERENCES integration(id),
  external_id      TEXT NOT NULL UNIQUE,
  xendit_id        TEXT,
  url              TEXT,
  amount_minor     BIGINT NOT NULL CHECK (amount_minor > 0),
  currency         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'failed')),
  expires_at       TIMESTAMPTZ,
  paid_at          TIMESTAMPTZ,
  error            TEXT,
  created_by       UUID REFERENCES app_user(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS fleet_invoice_link_open_uq ON fleet_invoice_link (invoice_id) WHERE status = 'pending';

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_digest_subscription', 'finance_digest_send', 'site_tariff', 'fleet_invoice_link'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON finance_digest_subscription, finance_digest_send, site_tariff, fleet_invoice_link TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON finance_digest_subscription, finance_digest_send, site_tariff, fleet_invoice_link FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE finance_digest_send_id_seq, fleet_invoice_link_id_seq TO plugsure_app;
  END IF;
END $$;
