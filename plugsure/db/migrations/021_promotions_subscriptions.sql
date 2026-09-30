-- v1.3: promotions and subscriptions (memberships).
--
-- Both change what a session costs, and both do it the same way: at rating,
-- as negative lines of the kind they reduce (energy, or service/admin fees),
-- AFTER the regulatory caps and BEFORE tax — so PBJT-TL and PPN are computed on
-- what the customer actually pays, and the receipt, the fleet invoice and the
-- faktur pajak all show the discount.
--
-- A subscription plan is a monthly membership: member price or discount on
-- energy, included kWh per month, service fee waived. Subscribers are a fleet
-- account (every card on it), a single card, or a driver-app account. Fleet
-- and card memberships are billed on the fleet invoice; app drivers buy a
-- 30-day pass by QRIS.
--
-- A promotion is a time-limited offer: % off energy, a promo price per kWh,
-- rupiah off, free kWh or fees waived; for everyone, new drivers, chosen fleet
-- accounts, members of chosen plans, or whoever enters its code in the app;
-- limited by dates, days, hours, sites, AC/DC, uses and budget.
--
-- Additive: nothing changes until a plan or promotion is created.

CREATE TABLE IF NOT EXISTS subscription_plan (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL REFERENCES organisation(id),
  name                 TEXT NOT NULL,
  description          TEXT,
  monthly_fee_idr      INTEGER NOT NULL CHECK (monthly_fee_idr >= 0),     -- before tax
  energy_discount_bps  INTEGER NOT NULL DEFAULT 0 CHECK (energy_discount_bps BETWEEN 0 AND 10000),
  member_rate_idr      NUMERIC(12,2) CHECK (member_rate_idr IS NULL OR member_rate_idr >= 0),
  included_kwh         NUMERIC(10,3) NOT NULL DEFAULT 0 CHECK (included_kwh >= 0),
  waive_session_fees   BOOLEAN NOT NULL DEFAULT false,
  current_type         TEXT CHECK (current_type IN ('AC', 'DC')),
  site_ids             UUID[],
  offered_in_app       BOOLEAN NOT NULL DEFAULT false,
  active               BOOLEAN NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS subscription (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL REFERENCES organisation(id),
  plan_id              UUID NOT NULL REFERENCES subscription_plan(id),
  subscriber_kind      TEXT NOT NULL CHECK (subscriber_kind IN ('fleet_account', 'card', 'app_driver')),
  fleet_account_id     UUID REFERENCES fleet_account(id),
  token_id             UUID REFERENCES token(id),
  app_driver_id        UUID REFERENCES app_driver(id),
  -- invoice: a calendar-month fee on the fleet invoice; qris: 30-day passes
  -- bought in the app; complimentary: no fee.
  billing              TEXT NOT NULL CHECK (billing IN ('invoice', 'qris', 'complimentary')),
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending_payment', 'active', 'cancelled', 'expired')),
  started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- For qris passes: the paid window. Invoice / complimentary run by calendar month.
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  cancelled_at         TIMESTAMPTZ,
  created_by           TEXT,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (subscriber_kind = 'fleet_account' AND fleet_account_id IS NOT NULL AND token_id IS NULL AND app_driver_id IS NULL) OR
    (subscriber_kind = 'card' AND token_id IS NOT NULL AND fleet_account_id IS NULL AND app_driver_id IS NULL) OR
    (subscriber_kind = 'app_driver' AND app_driver_id IS NOT NULL AND fleet_account_id IS NULL AND token_id IS NULL)
  )
);
-- One live membership per subscriber.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_live_fleet_uq ON subscription (fleet_account_id) WHERE status IN ('active', 'pending_payment') AND fleet_account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS subscription_live_card_uq ON subscription (token_id) WHERE status IN ('active', 'pending_payment') AND token_id IS NOT NULL;
-- A driver-app account is not tied to one operator: one membership per operator.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_live_driver_uq ON subscription (org_id, app_driver_id) WHERE status IN ('active', 'pending_payment') AND app_driver_id IS NOT NULL;

-- Included kWh used, per subscription and period (calendar month, or the pass window).
CREATE TABLE IF NOT EXISTS subscription_usage (
  subscription_id  UUID NOT NULL REFERENCES subscription(id) ON DELETE CASCADE,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  period_start     TIMESTAMPTZ NOT NULL,
  used_kwh         NUMERIC(12,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (subscription_id, period_start)
);
-- Which sessions drew on included kWh (so a re-rate never counts twice).
CREATE TABLE IF NOT EXISTS subscription_session (
  session_id       UUID PRIMARY KEY REFERENCES charging_session(id),
  subscription_id  UUID NOT NULL REFERENCES subscription(id) ON DELETE CASCADE,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  period_start     TIMESTAMPTZ NOT NULL,
  included_kwh     NUMERIC(12,3) NOT NULL DEFAULT 0,
  discount_idr     INTEGER NOT NULL DEFAULT 0
);

-- Membership fees: a 30-day pass bought by QRIS, or a month on a fleet invoice.
CREATE TABLE IF NOT EXISTS subscription_charge (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id   UUID NOT NULL REFERENCES subscription(id),
  org_id            UUID NOT NULL REFERENCES organisation(id),
  period_start      TIMESTAMPTZ NOT NULL,
  period_end        TIMESTAMPTZ NOT NULL,
  fee_idr           INTEGER NOT NULL,
  dpp_idr           INTEGER NOT NULL,
  ppn_idr           INTEGER NOT NULL,
  total_idr         INTEGER NOT NULL,
  via               TEXT NOT NULL CHECK (via IN ('qris', 'invoice')),
  state             TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'paid', 'void')),
  provider_ref      TEXT,
  fleet_invoice_id  UUID REFERENCES fleet_invoice(id),
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_charge_period_uq ON subscription_charge (subscription_id, period_start) WHERE state <> 'void';

CREATE TABLE IF NOT EXISTS promotion (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID NOT NULL REFERENCES organisation(id),
  name                    TEXT NOT NULL,
  description             TEXT,
  kind                    TEXT NOT NULL CHECK (kind IN ('energy_percent', 'energy_rate', 'amount_off', 'free_kwh', 'waive_fees')),
  value                   NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (value >= 0),
  audience                TEXT NOT NULL DEFAULT 'everyone' CHECK (audience IN ('everyone', 'new_drivers', 'fleet_accounts', 'plan_members', 'code')),
  code                    TEXT,
  fleet_account_ids       UUID[],
  plan_ids                UUID[],
  site_ids                UUID[],
  current_type            TEXT CHECK (current_type IN ('AC', 'DC')),
  starts_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at                 TIMESTAMPTZ,
  days_mask               SMALLINT NOT NULL DEFAULT 127,    -- bit0 = Monday
  time_from               TIME,
  time_to                 TIME,
  min_kwh                 NUMERIC(10,3) NOT NULL DEFAULT 0,
  max_redemptions         INTEGER,
  max_per_customer        INTEGER,
  budget_idr              BIGINT,
  stacks_with_membership  BOOLEAN NOT NULL DEFAULT true,
  active                  BOOLEAN NOT NULL DEFAULT true,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS promotion_code_uq ON promotion (org_id, upper(code)) WHERE code IS NOT NULL;

CREATE TABLE IF NOT EXISTS promotion_redemption (
  session_id    UUID PRIMARY KEY REFERENCES charging_session(id),
  promotion_id  UUID NOT NULL REFERENCES promotion(id),
  org_id        UUID NOT NULL REFERENCES organisation(id),
  customer_key  TEXT NOT NULL,
  discount_idr  INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS promotion_redemption_promo_idx ON promotion_redemption (promotion_id, customer_key);

-- A promo code entered at checkout in the driver app.
ALTER TABLE driver_charge ADD COLUMN IF NOT EXISTS promo_code TEXT;

-- Membership fees can go on a fleet invoice.
ALTER TABLE fleet_invoice_item DROP CONSTRAINT IF EXISTS fleet_invoice_item_kind_check;
ALTER TABLE fleet_invoice_item ADD CONSTRAINT fleet_invoice_item_kind_check CHECK (kind IN ('session', 'roaming', 'subscription_charge'));
ALTER TABLE fleet_invoice ADD COLUMN IF NOT EXISTS fees_total_idr BIGINT NOT NULL DEFAULT 0;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscription_plan', 'subscription', 'subscription_usage', 'subscription_session', 'subscription_charge', 'promotion', 'promotion_redemption'] LOOP
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
