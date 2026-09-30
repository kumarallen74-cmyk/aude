-- 040: white-label driver apps.
--
--   driver_app_brand   one per operator: the operator's own driver app, served
--                      from the same code as PlugSure's, with its name, colours,
--                      icon, support contacts, web address and the identifiers of
--                      its Play Store and App Store builds. The app shows only
--                      this operator's stations.
--
-- An operator without a row keeps using the PlugSure app, unchanged. A brand is a
-- draft (previewed with /app/?brand=<slug>) until it is set live, which needs its
-- own web address.

CREATE TABLE IF NOT EXISTS driver_app_brand (
  org_id               UUID PRIMARY KEY REFERENCES organisation(id) ON DELETE CASCADE,
  slug                 TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'),
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live')),
  app_name             TEXT NOT NULL,
  short_name           TEXT NOT NULL,
  tagline_id           TEXT,
  tagline_en           TEXT,
  description_id       TEXT,
  description_en       TEXT,
  accent_color         TEXT NOT NULL DEFAULT '#2fd6a7' CHECK (accent_color ~ '^#[0-9a-f]{6}$'),
  badge_color          TEXT NOT NULL DEFAULT '#1b4d8c' CHECK (badge_color ~ '^#[0-9a-f]{6}$'),
  -- The operator's square icon as uploaded (PNG); every other size is made from it.
  icon_png             BYTEA,
  icon_sha256          TEXT,
  support_email        TEXT,
  support_phone        TEXT,
  privacy_url          TEXT,
  terms_url            TEXT,
  -- The app's own web address (e.g. app.nusantaracharge.id), pointed at PlugSure.
  hostname             TEXT UNIQUE,
  android_package      TEXT UNIQUE,
  android_cert_sha256  TEXT[] NOT NULL DEFAULT '{}',
  ios_bundle_id        TEXT UNIQUE,
  ios_team_id          TEXT,
  version_name         TEXT NOT NULL DEFAULT '1.0.0',
  version_code         INTEGER NOT NULL DEFAULT 1 CHECK (version_code BETWEEN 1 AND 2100000000),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at         TIMESTAMPTZ,
  CHECK (status = 'draft' OR (hostname IS NOT NULL AND icon_png IS NOT NULL))
);

ALTER TABLE driver_app_brand ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_app_brand FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS driver_app_brand_tenant ON driver_app_brand;
CREATE POLICY driver_app_brand_tenant ON driver_app_brand
  USING (app_current_org() IS NULL OR org_id = app_current_org())
  WITH CHECK (app_current_org() IS NULL OR org_id = app_current_org());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
