-- ═══════════════════════════════════════════════════════════════════════════
-- 007: the driver-facing app — guest-first public charging
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The platform so far is entirely operator-facing: every identity is an operator
-- API key scoped to one CPO tenant. A driver at a public charger is a different
-- kind of actor entirely — they charge across MANY tenants, most of them never
-- sign in, and the ones who do own a phone number, not an organisation.
--
-- So driver identity is PLATFORM-LEVEL, not org-scoped, and the driver API runs
-- OUTSIDE the per-request org scope (like the gateway and the workers do). It
-- reads across tenants for one driver and filters explicitly by driver identity;
-- it never sets app.current_org_id, so app_current_org() is NULL and RLS admits
-- the cross-tenant read by design.
--
-- Three tiers of identity, guest first:
--   1. GUEST      — no account. A device token in the phone's storage, and the
--                   single-use claim token the QRIS flow already mints. Enough
--                   to charge and to see "my recent sessions" on this device.
--   2. ACCOUNT    — a phone number verified by OTP. Links devices together so
--                   history survives a new phone, and remembers the driver.
--   3. FLEET      — a corporate RFID token with a PIN. Bills the organisation,
--                   not the driver; the driver pays nothing per session.

-- ───────────────────────────────────────────────────────── global driver
-- Distinct from the existing org-scoped `driver` table, which is a CPO's own
-- record of a customer. `app_driver` is the person, once, across the platform.
CREATE TABLE app_driver (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       TEXT NOT NULL UNIQUE,          -- E.164, the login identity
  name        TEXT,
  email       TEXT,
  status      TEXT NOT NULL DEFAULT 'active', -- active | blocked
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);

COMMENT ON TABLE app_driver IS
  'A driver on the public app, identified by phone. Platform-level, NOT org-scoped: '
  'the same person charges at many CPOs. RLS does not apply — the driver API filters '
  'by this id explicitly and never enters an org scope.';

-- ───────────────────────────────────────────────────────── OTP
-- Phone verification codes. Hashed, single-use, rate-limited, short-lived.
CREATE TABLE driver_otp (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,                 -- sha256(code); never store the code
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  attempts    INTEGER NOT NULL DEFAULT 0,     -- wrong-guess counter; lock after a few
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX driver_otp_phone_idx ON driver_otp (phone, created_at DESC);

-- ───────────────────────────────────────────────────────── device
-- The token in the phone's storage. Anonymous until (and unless) it is linked to
-- an app_driver by OTP, or to a fleet token by PIN. `device_hash` = sha256 of the
-- secret the client holds; the secret itself is never stored.
CREATE TABLE driver_device (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_hash   TEXT NOT NULL UNIQUE,
  app_driver_id UUID REFERENCES app_driver(id) ON DELETE SET NULL,
  -- A device logged in as a fleet driver is bound to that org-scoped RFID token.
  fleet_token_id UUID REFERENCES token(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent    TEXT
);
CREATE INDEX driver_device_driver_idx ON driver_device (app_driver_id) WHERE app_driver_id IS NOT NULL;

-- ───────────────────────────────────────────────────────── charge intent
-- One row per "this driver, on this device, set out to charge here". It ties the
-- driver to the payment and to the token the charger will present, WITHOUT
-- touching the OCPP hot path: the session is still created by StartTransaction
-- keyed on the token. `session_id` is reconciled in when the session appears, so
-- history is exact rather than a fuzzy time-window join.
CREATE TABLE driver_charge (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id         UUID NOT NULL REFERENCES driver_device(id) ON DELETE CASCADE,
  app_driver_id     UUID REFERENCES app_driver(id) ON DELETE SET NULL,
  org_id            UUID NOT NULL REFERENCES organisation(id),
  connector_uuid    UUID NOT NULL REFERENCES connector(id),
  token_id          UUID NOT NULL REFERENCES token(id),   -- claim token (guest) or RFID (fleet)
  payment_intent_id UUID REFERENCES payment_intent(id),   -- null for fleet postpaid
  session_id        UUID REFERENCES charging_session(id), -- reconciled once the session starts
  mode              TEXT NOT NULL,                         -- prepaid | fleet
  amount_idr        INTEGER,                               -- what the driver paid, for prepaid
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX driver_charge_device_idx ON driver_charge (device_id, created_at DESC);
CREATE INDEX driver_charge_driver_idx ON driver_charge (app_driver_id, created_at DESC)
  WHERE app_driver_id IS NOT NULL;
CREATE INDEX driver_charge_token_idx ON driver_charge (token_id, created_at DESC);

COMMENT ON TABLE driver_charge IS
  'A driver''s intent to charge, linking device/account/fleet to the payment and the '
  'claim token. Reconciled to charging_session once StartTransaction lands. This is '
  'what the app''s "my charges" and live-status views read from.';

-- ───────────────────────────────────────────────────────── fleet PIN
-- A fleet RFID token can be used to log in to the app to see the fleet's own
-- sessions and start postpaid charges. That must be gated: knowing an RFID uid
-- cannot be enough to bill someone's fleet. A PIN, hashed, gates it.
ALTER TABLE token ADD COLUMN pin_hash TEXT;
COMMENT ON COLUMN token.pin_hash IS
  'Optional PIN (hashed) for fleet driver app login. Only kind=rfid tokens set this.';

-- The public station list joins these; index the lookups the app makes hot.
CREATE INDEX IF NOT EXISTS connector_status_idx ON connector (status);
CREATE INDEX IF NOT EXISTS charge_point_ocpp_lower_idx ON charge_point (lower(ocpp_identity));
