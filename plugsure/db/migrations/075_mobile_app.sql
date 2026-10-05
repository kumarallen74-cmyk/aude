-- 075: the PlugSure Hub mobile app (docs/MOBILE-APP-SPEC.md §14 G1–G8, §15).
--
--   driver_app_brand.scope         'operator' (every existing brand: a white-label app limited to its operator, unchanged)
--                                  or 'network' (the PlugSure app, owned by the PlugSure Mobility eMSP organisation:
--                                  every operator's chargers, partner networks through that organisation). At most one.
--   driver_app_brand.fcm_*         Firebase Cloud Messaging (Android): the brand's service account (sealed with
--                                  SECRETS_KEY, never returned), its project, and the last check with Google.
--   driver_app_brand.app_config    the native apps' version gate and remote configuration (GET /d/v1/app/config).
--   push_subscription.kind 'fcm'   an Android app's FCM registration token, for one brand's Firebase project.
--   live_activity.transport        'apns' (iOS Live Activity, as before) or 'fcm' (Android ongoing notification fed by
--                                  FCM data messages); roaming_charge_id: a charge on a partner network; content_version
--                                  2: the app formats costs by `currency` (version 1 apps get exactly what they got).
--   app_driver.deleted_at          an account deleted by its driver (anonymised in place; charges, payments and
--                                  receipts are kept for tax law with no personal data left on the account).
--   app_driver_deletion            what each deletion did (no personal data): for support and the regulator.
--   site_latlon_idx                the map's viewport query.
--
-- Additive: no existing row changes meaning. Rehearsal and rollback: db/rollback/075_down.sql.

ALTER TABLE driver_app_brand
  ADD COLUMN IF NOT EXISTS scope              TEXT NOT NULL DEFAULT 'operator',
  ADD COLUMN IF NOT EXISTS fcm_project_id     TEXT,
  ADD COLUMN IF NOT EXISTS fcm_client_email   TEXT,
  ADD COLUMN IF NOT EXISTS fcm_sa_sealed      TEXT,
  ADD COLUMN IF NOT EXISTS fcm_checked_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fcm_check_ok       BOOLEAN,
  ADD COLUMN IF NOT EXISTS fcm_check_detail   TEXT,
  ADD COLUMN IF NOT EXISTS app_config         JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  ALTER TABLE driver_app_brand ADD CONSTRAINT driver_app_brand_scope_check CHECK (scope IN ('operator', 'network'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE driver_app_brand ADD CONSTRAINT driver_app_brand_fcm_fields CHECK (
    fcm_sa_sealed IS NULL OR (fcm_project_id IS NOT NULL AND fcm_client_email IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE driver_app_brand ADD CONSTRAINT driver_app_brand_app_config_object CHECK (jsonb_typeof(app_config) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- One PlugSure app.
CREATE UNIQUE INDEX IF NOT EXISTS driver_app_brand_one_network ON driver_app_brand ((scope)) WHERE scope = 'network';

-- Android (FCM) subscriptions.
ALTER TABLE push_subscription DROP CONSTRAINT IF EXISTS push_subscription_kind_check;
ALTER TABLE push_subscription ADD CONSTRAINT push_subscription_kind_check CHECK (kind IN ('webpush', 'apns', 'fcm'));
ALTER TABLE push_subscription DROP CONSTRAINT IF EXISTS push_subscription_kind_fields;
ALTER TABLE push_subscription ADD CONSTRAINT push_subscription_kind_fields CHECK (
  (kind = 'webpush' AND p256dh IS NOT NULL AND auth IS NOT NULL)
  OR (kind IN ('apns', 'fcm') AND brand_org_id IS NOT NULL));

-- Live sessions: Android, partner networks, currency-aware widgets.
ALTER TABLE live_activity
  ADD COLUMN IF NOT EXISTS transport          TEXT NOT NULL DEFAULT 'apns',
  ADD COLUMN IF NOT EXISTS roaming_charge_id  UUID REFERENCES driver_roaming_charge(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS content_version    SMALLINT NOT NULL DEFAULT 1;
DO $$ BEGIN
  ALTER TABLE live_activity ADD CONSTRAINT live_activity_transport_check CHECK (transport IN ('apns', 'fcm'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE live_activity ADD CONSTRAINT live_activity_content_version_check CHECK (content_version IN (1, 2));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE live_activity DROP CONSTRAINT IF EXISTS live_activity_check;
ALTER TABLE live_activity DROP CONSTRAINT IF EXISTS live_activity_ref_check;
ALTER TABLE live_activity ADD CONSTRAINT live_activity_ref_check CHECK (charge_id IS NOT NULL OR session_id IS NOT NULL OR roaming_charge_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS live_activity_roaming_idx ON live_activity (roaming_charge_id) WHERE roaming_charge_id IS NOT NULL;

-- Account deletion.
ALTER TABLE app_driver ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS app_driver_deletion (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_driver_id   UUID NOT NULL REFERENCES app_driver(id),
  via             TEXT NOT NULL CHECK (via IN ('app', 'web')),
  -- What was removed and kept (counts only): saved cards and e-wallet links, devices, favourites, push tokens…
  summary         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE app_driver_deletion IS
  'Accounts deleted by their driver (app or web form): when, how, and counts of what was removed. No personal data. '
  'Platform-level like app_driver: not org-scoped.';

-- The map's viewport query (GET /d/v1/map, /d/v1/stations?bbox=).
CREATE INDEX IF NOT EXISTS site_latlon_idx ON site (lat, lon) WHERE archived_at IS NULL AND lat IS NOT NULL AND lon IS NOT NULL;

-- No blanket GRANT (see 053/055/070: `GRANT … ON ALL TABLES` hands UPDATE/DELETE on audit_log back).
-- The deletion record is written once and kept: insert and read only (076 also takes back what the
-- 1.9.0-dev copy of this file granted).
GRANT SELECT, INSERT ON app_driver_deletion TO plugsure_app;
