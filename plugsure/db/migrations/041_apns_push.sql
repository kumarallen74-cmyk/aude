-- 041: native iOS notifications (Apple Push Notification service) for white-label apps.
--
--   driver_app_brand.apns_*   the operator's APNs authentication key (.p8, sealed with
--                             SECRETS_KEY like other secrets) and its key id; the Team ID
--                             and bundle id (the APNs "topic") are already on the brand.
--                             The last check against Apple is kept for the console.
--   push_subscription.kind    'webpush' (browsers, as before) or 'apns' (the iOS app):
--                             an APNs subscription is a device token for one brand's app,
--                             and remembers which APNs environment accepted it (an app
--                             built from Xcode gets development tokens, TestFlight and the
--                             App Store production ones).
--
-- Additive: existing subscriptions are Web Push; nothing is sent over APNs until an
-- operator uploads a key and its iOS app registers.

ALTER TABLE driver_app_brand
  ADD COLUMN IF NOT EXISTS apns_key_id        TEXT CHECK (apns_key_id ~ '^[A-Z0-9]{10}$'),
  ADD COLUMN IF NOT EXISTS apns_key_sealed    TEXT,
  ADD COLUMN IF NOT EXISTS apns_checked_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS apns_check_ok      BOOLEAN,
  ADD COLUMN IF NOT EXISTS apns_check_detail  TEXT;

ALTER TABLE push_subscription
  ADD COLUMN IF NOT EXISTS kind          TEXT NOT NULL DEFAULT 'webpush' CHECK (kind IN ('webpush', 'apns')),
  ADD COLUMN IF NOT EXISTS brand_org_id  UUID REFERENCES organisation(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS apns_env      TEXT CHECK (apns_env IN ('production', 'development'));
ALTER TABLE push_subscription ALTER COLUMN p256dh DROP NOT NULL;
ALTER TABLE push_subscription ALTER COLUMN auth DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE push_subscription ADD CONSTRAINT push_subscription_kind_fields CHECK (
    (kind = 'webpush' AND p256dh IS NOT NULL AND auth IS NOT NULL)
    OR (kind = 'apns' AND brand_org_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
