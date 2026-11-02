-- v1.51.0 (phase 39): advertising on charger and kiosk screens. Additive.
--
--   ad_settings     the operator's: on/off, the tax on advertising invoices, the slot length
--   ad_advertiser   who buys the campaigns
--   ad_screen       a screen that plays ads: a charger's or a kiosk at a site; its player fetches its playlist with a key
--   ad_campaign     dates, sites, pricing (per thousand plays, or flat per month), a budget cap
--   ad_creative     an image or a video of a campaign, approved before it plays
--   ad_play         proof of play: plays per day, screen and creative (reported by the player)
--   ad_invoice      a month's invoice to an advertiser

CREATE TABLE IF NOT EXISTS ad_settings (
  org_id        UUID PRIMARY KEY REFERENCES organisation(id),
  enabled       BOOLEAN NOT NULL DEFAULT false,
  currency      TEXT NOT NULL,
  tax_bps       INTEGER NOT NULL DEFAULT 0 CHECK (tax_bps BETWEEN 0 AND 5000),
  slot_seconds  INTEGER NOT NULL DEFAULT 15 CHECK (slot_seconds BETWEEN 5 AND 120),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ad_advertiser (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  name          TEXT NOT NULL,
  contact_name  TEXT,
  email         TEXT,
  phone         TEXT,
  tax_id        TEXT,
  address       TEXT,
  archived_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ad_screen (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  site_id          UUID NOT NULL REFERENCES site(id),
  charge_point_id  UUID REFERENCES charge_point(id),
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'charger' CHECK (kind IN ('charger', 'kiosk')),
  orientation      TEXT NOT NULL DEFAULT 'landscape' CHECK (orientation IN ('landscape', 'portrait')),
  key_hash         TEXT UNIQUE,
  key_prefix       TEXT,
  last_seen_at     TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'off', 'archived')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ad_campaign (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  advertiser_id   BIGINT NOT NULL REFERENCES ad_advertiser(id),
  name            TEXT NOT NULL,
  starts_on       DATE NOT NULL,
  ends_on         DATE NOT NULL,
  site_ids        UUID[],                    -- null: every site with a screen
  -- cpm: per thousand plays; flat: a fee per month (prorated by the days it runs in the month)
  pricing         TEXT NOT NULL CHECK (pricing IN ('cpm', 'flat')),
  rate_minor      BIGINT NOT NULL CHECK (rate_minor >= 0),
  budget_minor    BIGINT CHECK (budget_minor IS NULL OR budget_minor > 0),   -- cpm: stops playing once spent
  weight          INTEGER NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 10), -- share of the rotation
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'ended')),
  paused_reason   TEXT,
  currency        TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);

CREATE TABLE IF NOT EXISTS ad_creative (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  campaign_id   BIGINT NOT NULL REFERENCES ad_campaign(id),
  name          TEXT NOT NULL,
  mime          TEXT NOT NULL,
  path          TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  seconds       INTEGER NOT NULL CHECK (seconds BETWEEN 3 AND 120),
  orientation   TEXT NOT NULL DEFAULT 'landscape' CHECK (orientation IN ('landscape', 'portrait')),
  review        TEXT NOT NULL DEFAULT 'pending' CHECK (review IN ('pending', 'approved', 'rejected')),
  review_note   TEXT,
  reviewed_by   UUID REFERENCES app_user(id),
  removed_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ad_play (
  org_id        UUID NOT NULL REFERENCES organisation(id),
  day           DATE NOT NULL,
  screen_id     BIGINT NOT NULL REFERENCES ad_screen(id),
  creative_id   BIGINT NOT NULL REFERENCES ad_creative(id),
  campaign_id   BIGINT NOT NULL REFERENCES ad_campaign(id),
  plays         INTEGER NOT NULL DEFAULT 0 CHECK (plays >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, screen_id, creative_id)
);
CREATE INDEX IF NOT EXISTS ad_play_campaign_idx ON ad_play (campaign_id, day);

CREATE TABLE IF NOT EXISTS ad_invoice (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  advertiser_id   BIGINT NOT NULL REFERENCES ad_advertiser(id),
  month           TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  number          TEXT,
  currency        TEXT NOT NULL,
  lines           JSONB NOT NULL DEFAULT '[]',
  subtotal_minor  BIGINT NOT NULL DEFAULT 0,
  tax_bps         INTEGER NOT NULL DEFAULT 0,
  tax_minor       BIGINT NOT NULL DEFAULT 0,
  total_minor     BIGINT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'paid', 'void')),
  issued_at       TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ,
  reference       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (advertiser_id, month)
);
CREATE UNIQUE INDEX IF NOT EXISTS ad_invoice_number_idx ON ad_invoice (org_id, number) WHERE number IS NOT NULL;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ad_settings', 'ad_advertiser', 'ad_screen', 'ad_campaign', 'ad_creative', 'ad_play', 'ad_invoice'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON ad_settings, ad_advertiser, ad_screen, ad_campaign, ad_creative, ad_play, ad_invoice TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON ad_settings, ad_advertiser, ad_screen, ad_campaign, ad_creative, ad_play, ad_invoice FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE ad_advertiser_id_seq, ad_screen_id_seq, ad_campaign_id_seq, ad_creative_id_seq, ad_invoice_id_seq TO plugsure_app;
  END IF;
END $$;
