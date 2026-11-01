-- v1.45.0 (phase 32 → 33): the support case desk, demand forecasting and site planning, driver credit (gift cards,
-- vouchers and referrals) and vehicle telematics. Additive.
--
--   support_settings / support_case / support_message / support_macro   the desk (per operator)
--   site_candidate                                                      places scored for a new site
--   credit_settings / gift_card_batch / gift_card / referral_code /
--   referral / driver_credit_entry                                      driver credit
--   driver_charge.credit_*                                              credit held and used by a prepaid charge
--   telematics_connection / vehicle_telemetry, fleet_vehicle.telematics_* vehicle data from the car's own systems
--   gl_entry.source                                                     gains 'driver_credit'

-- ─────────────────────────────────────────────── the support desk
CREATE TABLE IF NOT EXISTS support_settings (
  org_id             UUID PRIMARY KEY REFERENCES organisation(id),
  enabled            BOOLEAN NOT NULL DEFAULT false,
  -- sha256 of the key the e-mail provider's inbound webhook carries (…/support/inbound-email/<key>).
  inbound_key_hash   TEXT UNIQUE,
  inbound_key_prefix TEXT,
  -- Minutes to the first answer and to resolution, per priority.
  sla                JSONB NOT NULL DEFAULT '{"urgent":{"first":30,"resolve":240},"high":{"first":60,"resolve":480},"normal":{"first":240,"resolve":1440},"low":{"first":1440,"resolve":4320}}'::jsonb,
  auto_acknowledge   BOOLEAN NOT NULL DEFAULT true,
  updated_by         UUID,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_case (
  id                        BIGSERIAL PRIMARY KEY,
  org_id                    UUID NOT NULL REFERENCES organisation(id),
  number                    INTEGER NOT NULL,
  subject                   TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'open', 'pending', 'resolved', 'closed')),
  priority                  TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  channel                   TEXT NOT NULL CHECK (channel IN ('app', 'email', 'whatsapp', 'console')),
  category                  TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('charging', 'payment', 'refund', 'account', 'charger_fault', 'other')),
  app_driver_id             UUID REFERENCES app_driver(id) ON DELETE SET NULL,
  customer_name             TEXT,
  customer_email            TEXT,
  customer_phone_masked     TEXT,
  session_id                UUID REFERENCES charging_session(id),
  payment_intent_id         UUID,
  charge_point_id           UUID REFERENCES charge_point(id),
  site_id                   UUID REFERENCES site(id),
  whatsapp_conversation_id  UUID REFERENCES whatsapp_conversation(id) ON DELETE SET NULL,
  assignee_id               UUID,
  first_response_due_at     TIMESTAMPTZ,
  resolve_due_at            TIMESTAMPTZ,
  first_responded_at        TIMESTAMPTZ,
  resolved_at               TIMESTAMPTZ,
  closed_at                 TIMESTAMPTZ,
  breached_at               TIMESTAMPTZ,
  last_customer_at          TIMESTAMPTZ,
  -- The e-mail thread: the case's reply-to tag ([PS-123]) and the customer's message ids.
  email_ref                 TEXT,
  satisfaction              SMALLINT CHECK (satisfaction IS NULL OR satisfaction BETWEEN 1 AND 5),
  created_by                UUID,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE INDEX IF NOT EXISTS support_case_open_idx ON support_case (org_id, status, priority) WHERE status IN ('new', 'open', 'pending');
CREATE INDEX IF NOT EXISTS support_case_driver_idx ON support_case (app_driver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS support_case_session_idx ON support_case (session_id);
CREATE UNIQUE INDEX IF NOT EXISTS support_case_whatsapp_open_uq ON support_case (whatsapp_conversation_id) WHERE whatsapp_conversation_id IS NOT NULL AND status IN ('new', 'open', 'pending');

CREATE TABLE IF NOT EXISTS support_message (
  id           BIGSERIAL PRIMARY KEY,
  case_id      BIGINT NOT NULL REFERENCES support_case(id),
  org_id       UUID NOT NULL REFERENCES organisation(id),
  author       TEXT NOT NULL CHECK (author IN ('customer', 'staff', 'system')),
  channel      TEXT NOT NULL CHECK (channel IN ('app', 'email', 'whatsapp', 'console')),
  body         TEXT NOT NULL,
  internal     BOOLEAN NOT NULL DEFAULT false,
  user_id      UUID,
  delivery     TEXT CHECK (delivery IS NULL OR delivery IN ('sent', 'failed', 'in_app')),
  delivery_error TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_message_case_idx ON support_message (case_id, id);

CREATE TABLE IF NOT EXISTS support_macro (
  id           BIGSERIAL PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES organisation(id),
  name         TEXT NOT NULL,
  body         TEXT NOT NULL,
  category     TEXT CHECK (category IS NULL OR category IN ('charging', 'payment', 'refund', 'account', 'charger_fault', 'other')),
  set_status   TEXT CHECK (set_status IS NULL OR set_status IN ('open', 'pending', 'resolved')),
  archived_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────── site planning
CREATE TABLE IF NOT EXISTS site_candidate (
  id           BIGSERIAL PRIMARY KEY,
  org_id       UUID NOT NULL REFERENCES organisation(id),
  name         TEXT NOT NULL,
  lat          DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon          DOUBLE PRECISION NOT NULL CHECK (lon BETWEEN -180 AND 180),
  connectors   INTEGER NOT NULL DEFAULT 2 CHECK (connectors BETWEEN 1 AND 100),
  power_kw     NUMERIC(8,1) NOT NULL DEFAULT 22 CHECK (power_kw > 0 AND power_kw <= 1000),
  status       TEXT NOT NULL DEFAULT 'idea' CHECK (status IN ('idea', 'surveyed', 'approved', 'rejected')),
  notes        TEXT,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at  TIMESTAMPTZ
);

-- ─────────────────────────────────────────────── driver credit
CREATE TABLE IF NOT EXISTS credit_settings (
  org_id                  UUID PRIMARY KEY REFERENCES organisation(id),
  enabled                 BOOLEAN NOT NULL DEFAULT false,
  currency                TEXT NOT NULL,
  expiry_months           INTEGER NOT NULL DEFAULT 12 CHECK (expiry_months BETWEEN 1 AND 60),
  -- What must still be paid through the payment gateway on a charge paid partly with credit.
  min_gateway_minor       BIGINT NOT NULL DEFAULT 0 CHECK (min_gateway_minor >= 0),
  referral_enabled        BOOLEAN NOT NULL DEFAULT false,
  referrer_reward_minor   BIGINT NOT NULL DEFAULT 0 CHECK (referrer_reward_minor >= 0),
  referee_reward_minor    BIGINT NOT NULL DEFAULT 0 CHECK (referee_reward_minor >= 0),
  -- The new driver's first paid session must be at least this (kWh) for the referral to qualify.
  referral_min_kwh        NUMERIC(8,2) NOT NULL DEFAULT 5 CHECK (referral_min_kwh >= 0),
  referral_monthly_cap    INTEGER NOT NULL DEFAULT 10 CHECK (referral_monthly_cap BETWEEN 0 AND 1000),
  updated_by              UUID,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gift_card_batch (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  name            TEXT NOT NULL,
  -- gift: sold (the buyer paid; a liability until used); voucher: given away (a promotion).
  kind            TEXT NOT NULL CHECK (kind IN ('gift', 'voucher')),
  currency        TEXT NOT NULL,
  value_minor     BIGINT NOT NULL CHECK (value_minor > 0),
  quantity        INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10000),
  price_minor     BIGINT NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  buyer           TEXT,
  sold_on         DATE,
  cash_account_id UUID,
  expires_on      DATE,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS gift_card (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  batch_id      BIGINT NOT NULL REFERENCES gift_card_batch(id),
  -- sha256 of the normalised code; only the last four characters are kept in the clear.
  code_hash     TEXT NOT NULL UNIQUE,
  code_last4    TEXT NOT NULL,
  redeemed_by   UUID REFERENCES app_driver(id) ON DELETE SET NULL,
  redeemed_at   TIMESTAMPTZ,
  voided_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS gift_card_batch_idx ON gift_card (batch_id);

CREATE TABLE IF NOT EXISTS referral_code (
  org_id         UUID NOT NULL REFERENCES organisation(id),
  app_driver_id  UUID NOT NULL REFERENCES app_driver(id) ON DELETE CASCADE,
  code           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, app_driver_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS referral_code_uq ON referral_code (org_id, upper(code));

CREATE TABLE IF NOT EXISTS referral (
  id                     BIGSERIAL PRIMARY KEY,
  org_id                 UUID NOT NULL REFERENCES organisation(id),
  referrer_id            UUID NOT NULL REFERENCES app_driver(id),
  referee_id             UUID NOT NULL REFERENCES app_driver(id),
  status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'rewarded', 'rejected')),
  reason                 TEXT,
  qualifying_session_id  UUID REFERENCES charging_session(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  rewarded_at            TIMESTAMPTZ,
  UNIQUE (org_id, referee_id)
);
CREATE INDEX IF NOT EXISTS referral_referrer_idx ON referral (org_id, referrer_id, created_at);

-- The credit ledger. Credits (+) carry `remaining`, used oldest-expiring first, promotional before paid-for; a hold
-- (−) takes from them when a charge is paid partly with credit, and what the session did not use comes back (release).
CREATE TABLE IF NOT EXISTS driver_credit_entry (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  app_driver_id    UUID NOT NULL REFERENCES app_driver(id),
  currency         TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('gift_card', 'voucher', 'referral', 'adjust', 'hold', 'release', 'expire')),
  -- Paid for (a gift card, or a release of paid-for credit): a liability. Otherwise a promotion.
  funded           BOOLEAN NOT NULL DEFAULT false,
  amount_minor     BIGINT NOT NULL,
  remaining_minor  BIGINT NOT NULL DEFAULT 0 CHECK (remaining_minor >= 0),
  -- A hold: how much of it came from paid-for credit (the rest was promotional).
  funded_minor     BIGINT NOT NULL DEFAULT 0,
  expires_at       TIMESTAMPTZ,
  gift_card_id     BIGINT REFERENCES gift_card(id),
  referral_id      BIGINT REFERENCES referral(id),
  driver_charge_id UUID,
  note             TEXT,
  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS driver_credit_entry_driver_idx ON driver_credit_entry (org_id, app_driver_id, currency, created_at);
CREATE INDEX IF NOT EXISTS driver_credit_entry_open_idx ON driver_credit_entry (org_id, app_driver_id, currency, expires_at) WHERE remaining_minor > 0;
CREATE UNIQUE INDEX IF NOT EXISTS driver_credit_entry_hold_uq ON driver_credit_entry (driver_charge_id, kind, funded) WHERE driver_charge_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS driver_credit_entry_gift_uq ON driver_credit_entry (gift_card_id) WHERE gift_card_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS driver_credit_entry_referral_uq ON driver_credit_entry (referral_id, app_driver_id) WHERE referral_id IS NOT NULL;

ALTER TABLE driver_charge ADD COLUMN IF NOT EXISTS credit_hold_minor BIGINT NOT NULL DEFAULT 0 CHECK (credit_hold_minor >= 0);
ALTER TABLE driver_charge ADD COLUMN IF NOT EXISTS credit_used_minor BIGINT;
ALTER TABLE driver_charge ADD COLUMN IF NOT EXISTS credit_settled_at TIMESTAMPTZ;

-- ─────────────────────────────────────────────── vehicle telematics
CREATE TABLE IF NOT EXISTS telematics_connection (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  name             TEXT NOT NULL,
  -- webhook: the provider posts readings to PlugSure; poll: PlugSure reads the provider's endpoint.
  kind             TEXT NOT NULL CHECK (kind IN ('webhook', 'poll')),
  url              TEXT,
  auth_sealed      TEXT,
  key_hash         TEXT UNIQUE,
  key_prefix       TEXT,
  -- Where each value is in the provider's JSON (dot paths), and where the list of vehicles is.
  field_map        JSONB NOT NULL DEFAULT '{}'::jsonb,
  poll_minutes     INTEGER NOT NULL DEFAULT 15 CHECK (poll_minutes BETWEEN 5 AND 1440),
  enabled          BOOLEAN NOT NULL DEFAULT true,
  last_seen_at     TIMESTAMPTZ,
  last_polled_at   TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at      TIMESTAMPTZ
);

ALTER TABLE fleet_vehicle ADD COLUMN IF NOT EXISTS telematics_connection_id BIGINT REFERENCES telematics_connection(id);
ALTER TABLE fleet_vehicle ADD COLUMN IF NOT EXISTS telematics_vehicle_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS fleet_vehicle_telematics_uq ON fleet_vehicle (telematics_connection_id, telematics_vehicle_id) WHERE telematics_connection_id IS NOT NULL AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS vehicle_telemetry (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  vehicle_id    BIGINT NOT NULL REFERENCES fleet_vehicle(id),
  soc_pct       NUMERIC(5,2) CHECK (soc_pct IS NULL OR soc_pct BETWEEN 0 AND 100),
  range_km      NUMERIC(8,1),
  lat           DOUBLE PRECISION,
  lon           DOUBLE PRECISION,
  odometer_km   NUMERIC(10,1),
  charging      BOOLEAN,
  recorded_at   TIMESTAMPTZ NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, recorded_at)
);
CREATE INDEX IF NOT EXISTS vehicle_telemetry_latest_idx ON vehicle_telemetry (vehicle_id, recorded_at DESC);

-- ─────────────────────────────────────────────── the ledger
ALTER TABLE gl_entry DROP CONSTRAINT IF EXISTS gl_entry_source_check;
ALTER TABLE gl_entry ADD CONSTRAINT gl_entry_source_check
  CHECK (source IN ('manual', 'gateway', 'assets', 'leases', 'provision', 'bills', 'deposits', 'expenses', 'intercompany', 'reversal', 'payroll', 'customer_deposits', 'projects',
                    'inventory', 'maintenance', 'loans', 'carbon', 'insurance', 'grants', 'landlords', 'chargebacks', 'loyalty', 'fx', 'tax', 'cards', 'contracts', 'driver_credit'));

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['support_settings', 'support_case', 'support_message', 'support_macro', 'site_candidate', 'credit_settings', 'gift_card_batch', 'gift_card',
                           'referral_code', 'referral', 'driver_credit_entry', 'telematics_connection', 'vehicle_telemetry'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON support_settings, support_case, support_message, support_macro, site_candidate, credit_settings, gift_card_batch, gift_card,
                                   referral_code, referral, driver_credit_entry, telematics_connection, vehicle_telemetry TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON support_settings, support_case, support_message, support_macro, site_candidate, credit_settings, gift_card_batch, gift_card,
                               referral_code, referral, driver_credit_entry, telematics_connection, vehicle_telemetry FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE support_case_id_seq, support_message_id_seq, support_macro_id_seq, site_candidate_id_seq, gift_card_batch_id_seq, gift_card_id_seq,
                                    referral_id_seq, driver_credit_entry_id_seq, telematics_connection_id_seq, vehicle_telemetry_id_seq TO plugsure_app;
  END IF;
END $$;
