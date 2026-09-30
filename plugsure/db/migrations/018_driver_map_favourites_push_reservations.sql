-- 018: driver app — favourites, push notifications, reservations
--
--   driver_favourite        stations a driver starred (own or partner network)
--   push_subscription       a phone's Web Push subscription (VAPID)
--   push_message            outbox of notifications to send
--   driver_reservation      a connector held for a signed-in driver (OCPP ReserveNow)
--   platform_setting        platform-wide generated settings (the VAPID key pair)
--   ocpp_reservation_id_seq one id space for every OCPP reservation, so a driver
--                           reservation and a roaming (OCPI) one never collide on a charger
--
-- Additive. The map needs no schema.

CREATE TABLE IF NOT EXISTS platform_setting (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS driver_favourite (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id      UUID NOT NULL REFERENCES driver_device(id) ON DELETE CASCADE,
  -- A signed-in driver's favourites follow the account to a new phone.
  app_driver_id  UUID REFERENCES app_driver(id) ON DELETE CASCADE,
  site_id        UUID REFERENCES site(id) ON DELETE CASCADE,
  partner_id     UUID REFERENCES ocpi_partner(id) ON DELETE CASCADE,
  country_code   TEXT,
  party_id       TEXT,
  location_id    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((site_id IS NOT NULL) <> (location_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS driver_favourite_device_idx ON driver_favourite (device_id);
CREATE INDEX IF NOT EXISTS driver_favourite_account_idx ON driver_favourite (app_driver_id) WHERE app_driver_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS push_subscription (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id        UUID NOT NULL REFERENCES driver_device(id) ON DELETE CASCADE,
  endpoint         TEXT NOT NULL UNIQUE,
  p256dh           TEXT NOT NULL,
  auth             TEXT NOT NULL,
  -- Notifications are written in the language the app was set to when subscribing.
  lang             TEXT NOT NULL DEFAULT 'id' CHECK (lang IN ('id', 'en')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at  TIMESTAMPTZ,
  failures         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_subscription_device_idx ON push_subscription (device_id);

CREATE TABLE IF NOT EXISTS push_message (
  id               BIGSERIAL PRIMARY KEY,
  subscription_id  UUID NOT NULL REFERENCES push_subscription(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  -- De-duplication: one notification per (subscription, event), however often the event fires.
  dedupe_key       TEXT NOT NULL,
  payload          JSONB NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'failed', 'gone')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status      INTEGER,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at          TIMESTAMPTZ,
  UNIQUE (subscription_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS push_message_due_idx ON push_message (next_attempt_at) WHERE state = 'pending';

CREATE SEQUENCE IF NOT EXISTS ocpp_reservation_id_seq START 1000;
SELECT setval('ocpp_reservation_id_seq', GREATEST(1000, (SELECT COALESCE(max(id), 0) + 1000 FROM ocpi_reservation)), false);
ALTER TABLE ocpi_reservation ALTER COLUMN id SET DEFAULT nextval('ocpp_reservation_id_seq');

CREATE TABLE IF NOT EXISTS driver_reservation (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ocpp_reservation_id    INTEGER NOT NULL DEFAULT nextval('ocpp_reservation_id_seq'),
  org_id                 UUID NOT NULL REFERENCES organisation(id),
  device_id              UUID NOT NULL REFERENCES driver_device(id),
  app_driver_id          UUID REFERENCES app_driver(id),
  fleet_token_id         UUID REFERENCES token(id),
  -- The idTag the charger holds the connector for: the fleet card, or a claim
  -- token minted now and reused as the payment's claim token at checkout.
  token_id               UUID NOT NULL REFERENCES token(id),
  connector_uuid         UUID NOT NULL REFERENCES connector(id),
  charge_point_id        UUID NOT NULL REFERENCES charge_point(id),
  connector_no           INTEGER NOT NULL,
  state                  TEXT NOT NULL DEFAULT 'requested'
                         CHECK (state IN ('requested', 'active', 'used', 'cancelled', 'expired', 'rejected')),
  expires_at             TIMESTAMPTZ NOT NULL,
  reminded_at            TIMESTAMPTZ,
  charger_status         TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at               TIMESTAMPTZ
);
-- At most one live reservation per connector, and one per driver device.
CREATE UNIQUE INDEX IF NOT EXISTS driver_reservation_connector_live_uq
  ON driver_reservation (connector_uuid) WHERE state IN ('requested', 'active');
CREATE UNIQUE INDEX IF NOT EXISTS driver_reservation_device_live_uq
  ON driver_reservation (device_id) WHERE state IN ('requested', 'active');
CREATE INDEX IF NOT EXISTS driver_reservation_expiry_idx ON driver_reservation (expires_at) WHERE state = 'active';

ALTER TABLE driver_reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_reservation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS driver_reservation_tenant ON driver_reservation;
CREATE POLICY driver_reservation_tenant ON driver_reservation
  USING (app_current_org() IS NULL OR org_id = app_current_org())
  WITH CHECK (app_current_org() IS NULL OR org_id = app_current_org());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
