-- 031: passes and memberships — automatic renewal, proration, loyalty points.
--
--   Auto-renewal   a driver's 30-day pass can renew itself with a saved card or a
--                  linked e-wallet, charged shortly before it ends (retried, and
--                  the driver told when it needs them).
--   Proration      switching pass plans credits the unused days of the current
--                  pass; fleet memberships are billed for the days in force in the
--                  month, not the whole month.
--   Loyalty        drivers earn points on what they pay and can let them come off
--                  their next sessions (before PBJT-TL and PPN, like a discount).
--
-- Additive: no pass renews, no plan is prorated differently for months already
-- invoiced, and no one earns points until an operator switches loyalty on.

-- ─────────────────────────────────────────────── automatic renewal
ALTER TABLE subscription
  ADD COLUMN IF NOT EXISTS auto_renew        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS renew_method_id   UUID REFERENCES driver_card(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS renew_attempts    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS renew_next_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS renew_error       TEXT;
CREATE INDEX IF NOT EXISTS subscription_renew_idx ON subscription (current_period_end) WHERE auto_renew AND status = 'active';

ALTER TABLE subscription_charge
  -- charged by the renewal worker (not in front of the driver)
  ADD COLUMN IF NOT EXISTS auto_renewal      BOOLEAN NOT NULL DEFAULT false,
  -- proration: the value of the unused days of the current pass, taken off the fee (before tax)
  ADD COLUMN IF NOT EXISTS credit_idr        INTEGER NOT NULL DEFAULT 0 CHECK (credit_idr >= 0),
  -- a plan switch: when this charge is paid, the membership moves to this plan (the old one ends then, not before)
  ADD COLUMN IF NOT EXISTS switch_to_plan_id UUID REFERENCES subscription_plan(id),
  -- part of a month (fleet memberships billed on the invoice): days in force / days in the month
  ADD COLUMN IF NOT EXISTS days_billed       INTEGER,
  ADD COLUMN IF NOT EXISTS days_in_period    INTEGER;
-- A switch paid entirely by the credit costs nothing: via 'credit'.
ALTER TABLE subscription_charge DROP CONSTRAINT IF EXISTS subscription_charge_via_check;
ALTER TABLE subscription_charge ADD CONSTRAINT subscription_charge_via_check CHECK (via IN ('qris', 'ewallet', 'card', 'invoice', 'credit'));

-- ─────────────────────────────────────────────── loyalty points
CREATE TABLE IF NOT EXISTS loyalty_program (
  org_id              UUID PRIMARY KEY REFERENCES organisation(id),
  enabled             BOOLEAN NOT NULL DEFAULT false,
  earn_per_1000_idr   INTEGER NOT NULL DEFAULT 1 CHECK (earn_per_1000_idr BETWEEN 0 AND 1000),   -- points per Rp 1,000 paid
  point_value_idr     INTEGER NOT NULL DEFAULT 10 CHECK (point_value_idr BETWEEN 1 AND 100000),  -- Rp a point is worth
  max_redeem_bps      INTEGER NOT NULL DEFAULT 5000 CHECK (max_redeem_bps BETWEEN 0 AND 10000), -- most of a session's price points may pay
  expiry_months       INTEGER NOT NULL DEFAULT 12 CHECK (expiry_months BETWEEN 1 AND 60),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          TEXT
);

-- A driver's choice per operator: let points come off their sessions automatically.
CREATE TABLE IF NOT EXISTS loyalty_member (
  org_id         UUID NOT NULL REFERENCES organisation(id),
  app_driver_id  UUID NOT NULL REFERENCES app_driver(id),
  auto_redeem    BOOLEAN NOT NULL DEFAULT false,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, app_driver_id)
);

-- The points ledger. Earned points are used first-in first-out: `remaining` is what
-- is left of an earning (redemptions and expiry take it down).
CREATE TABLE IF NOT EXISTS loyalty_entry (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organisation(id),
  app_driver_id  UUID NOT NULL REFERENCES app_driver(id),
  kind           TEXT NOT NULL CHECK (kind IN ('earn', 'redeem', 'expire', 'adjust')),
  points         INTEGER NOT NULL,          -- + earned / adjusted up, − redeemed / expired / adjusted down
  remaining      INTEGER NOT NULL DEFAULT 0 CHECK (remaining >= 0),
  value_idr      INTEGER NOT NULL DEFAULT 0,  -- redemptions: the discount given
  session_id     UUID REFERENCES charging_session(id),
  note           TEXT,
  created_by     TEXT,
  expires_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One earning and one redemption per session (re-rating cannot double them).
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_entry_session_uq ON loyalty_entry (session_id, kind) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS loyalty_entry_driver_idx ON loyalty_entry (org_id, app_driver_id, created_at);
CREATE INDEX IF NOT EXISTS loyalty_entry_open_idx ON loyalty_entry (org_id, app_driver_id, expires_at) WHERE remaining > 0;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['loyalty_program','loyalty_member','loyalty_entry']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$I_tenant ON %1$I', t);
    EXECUTE format($f$
      CREATE POLICY %1$I_tenant ON %1$I
        USING (app_current_org() IS NULL OR org_id = app_current_org())
        WITH CHECK (app_current_org() IS NULL OR org_id = app_current_org())
    $f$, t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
