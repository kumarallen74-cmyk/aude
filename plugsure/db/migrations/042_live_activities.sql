-- 042: Live Activities — a charge in progress on the iPhone's lock screen and in
-- the Dynamic Island, for white-label iOS apps (ActivityKit, iOS 16.2+).
--
--   live_activity              one activity on one iPhone for one charge: its APNs
--                              update token, what was last sent (so updates are only
--                              sent when something changed, within Apple's budget),
--                              and whether it has ended.
--   live_activity_start_token  an iPhone's push-to-start token (iOS 17.2+), per app:
--                              lets PlugSure start the activity when a charge starts
--                              without the app open (a fleet card at the charger).
--   live_activity_push_start   push-to-start sent for (iPhone, session): never twice.
--
-- Additive; nothing happens until a brand's iOS app registers tokens.

CREATE TABLE IF NOT EXISTS live_activity (
  id            BIGSERIAL PRIMARY KEY,
  device_id     UUID NOT NULL REFERENCES driver_device(id) ON DELETE CASCADE,
  brand_org_id  UUID NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
  -- What the app named the activity after: its charge, or (started by push) the session.
  charge_id     UUID REFERENCES driver_charge(id) ON DELETE CASCADE,
  session_id    UUID REFERENCES charging_session(id) ON DELETE CASCADE,
  push_token    TEXT NOT NULL UNIQUE,
  apns_env      TEXT CHECK (apns_env IN ('production', 'development')),
  state         TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'ended', 'gone')),
  last_content  JSONB,
  last_status   TEXT,
  last_sent_at  TIMESTAMPTZ,
  sent_count    INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ,
  CHECK (charge_id IS NOT NULL OR session_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS live_activity_active_idx ON live_activity (state) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS live_activity_device_idx ON live_activity (device_id);

CREATE TABLE IF NOT EXISTS live_activity_start_token (
  device_id     UUID NOT NULL REFERENCES driver_device(id) ON DELETE CASCADE,
  brand_org_id  UUID NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
  token         TEXT NOT NULL,
  apns_env      TEXT CHECK (apns_env IN ('production', 'development')),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, brand_org_id)
);

CREATE TABLE IF NOT EXISTS live_activity_push_start (
  device_id   UUID NOT NULL REFERENCES driver_device(id) ON DELETE CASCADE,
  session_id  UUID NOT NULL REFERENCES charging_session(id) ON DELETE CASCADE,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  status      INTEGER,
  PRIMARY KEY (device_id, session_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
