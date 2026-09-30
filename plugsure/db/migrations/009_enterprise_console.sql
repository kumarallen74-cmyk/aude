-- ═══════════════════════════════════════════════════════════════════════════
-- 009: Enterprise operator console (SPEC-UI-CSMS-2026-FINAL)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Everything the specification asks an operator to do WITHOUT a terminal or a
-- psql prompt needs somewhere to live. This migration is ADDITIVE ONLY: every
-- new column is nullable or has a default that reproduces v1.2.1 behaviour, and
-- no existing row changes meaning. A v1.2.1 fleet keeps billing exactly as it
-- did the moment this is applied.
--
--   Module 1  onboarding wizard      charge_point / connector metadata
--   Module 3  site management        site metadata (postal code, SLO issuer)
--   Module 4  DLM studio             reserve breakdown, connector priority
--   Module 5  tariff builder         status, PPN applicability, connector-type scope
--   Module 6  config key studio      charge_point_config snapshot
--   Module 7  RFID centre            token holder / account type / limits
--   Module 9  FOTA + diagnostics     firmware_image, firmware_campaign, firmware_job,
--                                    diagnostics_request
--   Module 10 RBAC                   operator passwords, login lockout
--   Module 2  remote start presets   remote_start_request, session operator limits

-- ─────────────────────────────────────────────── Module 10: operator login
-- The console had no way to sign in: auth_session existed, createSession() existed,
-- and nothing ever called it. Passwords are scrypt, never reversible.
ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS password_hash   TEXT,
  ADD COLUMN IF NOT EXISTS last_login_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_logins   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS phone_display   TEXT;

COMMENT ON COLUMN app_user.password_hash IS
  'scrypt$N$r$p$salt$hash (base64url). NULL = the user cannot sign in with a password.';

-- ─────────────────────────────────────────────── Module 3: sites
ALTER TABLE site
  ADD COLUMN IF NOT EXISTS postal_code  TEXT,
  ADD COLUMN IF NOT EXISTS slo_issuer   TEXT,
  ADD COLUMN IF NOT EXISTS archived_at  TIMESTAMPTZ;

-- ─────────────────────────────────────────────── Module 1: charge points
ALTER TABLE charge_point
  ADD COLUMN IF NOT EXISTS display_name       TEXT,
  ADD COLUMN IF NOT EXISTS key_rotation_days  INTEGER,
  ADD COLUMN IF NOT EXISTS commissioned_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decommissioned_at  TIMESTAMPTZ;

COMMENT ON COLUMN charge_point.key_rotation_days IS
  'Operator policy: raise an alert when the AuthorizationKey is older than this. NULL = no reminder.';

ALTER TABLE connector
  ADD COLUMN IF NOT EXISTS rated_voltage_v     INTEGER,
  ADD COLUMN IF NOT EXISTS rated_current_a     INTEGER,
  ADD COLUMN IF NOT EXISTS tera_cert_status    TEXT NOT NULL DEFAULT 'verified',
  ADD COLUMN IF NOT EXISTS priority            INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS maintenance_reason  TEXT,
  ADD COLUMN IF NOT EXISTS maintenance_since   TIMESTAMPTZ;

ALTER TABLE connector DROP CONSTRAINT IF EXISTS connector_tera_cert_status_valid;
ALTER TABLE connector
  ADD CONSTRAINT connector_tera_cert_status_valid
  CHECK (tera_cert_status IN ('verified', 'pending', 'exempt'));

COMMENT ON COLUMN connector.tera_cert_status IS
  'Operator-declared metrology certification state: verified | pending (awaiting calibration, '
  'commercial sale blocked) | exempt (not a trade meter, e.g. an internal depot unit). '
  'The DATE-derived tera_status (verified/due_soon/lapsed) is still computed from tera_due_at.';
COMMENT ON COLUMN connector.priority IS
  'Load-management priority. Higher wins under the priority strategy (fleet buses over retail cars).';

-- ─────────────────────────────────────────────── Module 4: DLM
ALTER TABLE site_power_budget
  ADD COLUMN IF NOT EXISTS reserve_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS curtailed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS curtailed_reason  TEXT;

COMMENT ON COLUMN site_power_budget.reserve_breakdown IS
  'Auxiliary loads the reserve is held for, in watts: {"lighting":..,"pos":..,"cctv":..,"hvac":..,"other":..}. '
  'reserve_w is kept equal to the sum by the API.';

-- ─────────────────────────────────────────────── Module 5: tariffs
ALTER TABLE tariff
  ADD COLUMN IF NOT EXISTS status        TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS description   TEXT,
  ADD COLUMN IF NOT EXISTS pricing_model TEXT NOT NULL DEFAULT 'flat',
  ADD COLUMN IF NOT EXISTS ppn_applies   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS mdr_mode      TEXT NOT NULL DEFAULT 'absorb',
  ADD COLUMN IF NOT EXISTS archived_at   TIMESTAMPTZ;

ALTER TABLE tariff DROP CONSTRAINT IF EXISTS tariff_status_valid;
ALTER TABLE tariff ADD CONSTRAINT tariff_status_valid CHECK (status IN ('active', 'archived'));
ALTER TABLE tariff DROP CONSTRAINT IF EXISTS tariff_mdr_mode_valid;
-- Surcharging the QRIS MDR to the consumer is prohibited by Bank Indonesia's QRIS
-- merchant rules, so it is not a storable value — only the CPO can absorb it.
ALTER TABLE tariff ADD CONSTRAINT tariff_mdr_mode_valid CHECK (mdr_mode IN ('absorb'));

-- Assignment by CONNECTOR TYPE ("separate rates for AC vs DC"). NULL = any
-- current type, which is every assignment that exists today.
ALTER TABLE tariff_assignment
  ADD COLUMN IF NOT EXISTS current_type TEXT;
ALTER TABLE tariff_assignment DROP CONSTRAINT IF EXISTS tariff_assignment_current_type_valid;
ALTER TABLE tariff_assignment
  ADD CONSTRAINT tariff_assignment_current_type_valid CHECK (current_type IS NULL OR current_type IN ('AC', 'DC'));
CREATE INDEX IF NOT EXISTS tariff_assignment_tariff_idx ON tariff_assignment (tariff_id);

-- ─────────────────────────────────────────────── Module 7: RFID
ALTER TABLE token
  ADD COLUMN IF NOT EXISTS holder_name     TEXT,
  ADD COLUMN IF NOT EXISTS holder_phone    TEXT,
  ADD COLUMN IF NOT EXISTS account_type    TEXT NOT NULL DEFAULT 'retail',
  ADD COLUMN IF NOT EXISTS fleet_name      TEXT,
  ADD COLUMN IF NOT EXISTS energy_limit_wh BIGINT,
  ADD COLUMN IF NOT EXISTS spend_limit_idr BIGINT,
  ADD COLUMN IF NOT EXISTS notes           TEXT,
  ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE token DROP CONSTRAINT IF EXISTS token_account_type_valid;
ALTER TABLE token
  ADD CONSTRAINT token_account_type_valid
  CHECK (account_type IN ('retail', 'fleet', 'vip', 'technician'));

COMMENT ON COLUMN token.energy_limit_wh IS
  'Cumulative energy cap. Once lifetime delivered energy reaches it, Authorize answers Blocked.';
COMMENT ON COLUMN token.spend_limit_idr IS
  'Cumulative spend cap (CDR totals). Once reached, Authorize answers Blocked.';

-- ─────────────────────────────────────────────── Module 6: configuration studio
CREATE TABLE IF NOT EXISTS charge_point_config (
  charge_point_id  UUID NOT NULL REFERENCES charge_point(id) ON DELETE CASCADE,
  key              TEXT NOT NULL,
  value            TEXT,
  readonly         BOOLEAN NOT NULL DEFAULT false,
  reboot_required  BOOLEAN NOT NULL DEFAULT false,
  last_status      TEXT,                          -- Accepted | Rejected | RebootRequired | NotSupported
  read_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (charge_point_id, key)
);

-- ─────────────────────────────────────────────── Module 9: FOTA
CREATE TABLE IF NOT EXISTS firmware_image (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organisation(id),
  name            TEXT NOT NULL,
  version         TEXT NOT NULL,
  vendor          TEXT,
  compatible_models TEXT[] NOT NULL DEFAULT '{}',
  source          TEXT NOT NULL,                  -- upload | url
  url             TEXT,                           -- external HTTPS location (source = url)
  storage_path    TEXT,                           -- local file (source = upload)
  file_name       TEXT,
  size_bytes      BIGINT,
  sha256          TEXT,                           -- declared or computed
  sha256_verified BOOLEAN NOT NULL DEFAULT false,
  download_token  TEXT NOT NULL,                  -- unguessable path segment for charger download
  notes           TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS firmware_image_org_idx ON firmware_image (org_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS firmware_image_token_idx ON firmware_image (download_token);

CREATE TABLE IF NOT EXISTS firmware_campaign (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organisation(id),
  image_id          UUID NOT NULL REFERENCES firmware_image(id),
  name              TEXT NOT NULL,
  target_type       TEXT NOT NULL,                -- charge_point | site | fleet
  target_ids        UUID[] NOT NULL DEFAULT '{}',
  window_start      TEXT,                         -- 'HH:MM' local site time, NULL = immediately
  window_end        TEXT,
  max_retries       INTEGER NOT NULL DEFAULT 3,
  retry_interval_s  INTEGER NOT NULL DEFAULT 600,
  status            TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | running | completed | cancelled
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS firmware_campaign_org_idx ON firmware_campaign (org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS firmware_job (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      UUID NOT NULL REFERENCES firmware_campaign(id) ON DELETE CASCADE,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  charge_point_id  UUID NOT NULL REFERENCES charge_point(id) ON DELETE CASCADE,
  -- pending | dispatched | Downloading | Downloaded | Installing | Installed | Verified
  -- | DownloadFailed | InstallationFailed | failed | cancelled
  state            TEXT NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  request_id       INTEGER,                       -- 2.0.1 UpdateFirmware requestId
  firmware_before  TEXT,
  last_error       TEXT,
  next_attempt_at  TIMESTAMPTZ,
  dispatched_at    TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, charge_point_id)
);
CREATE INDEX IF NOT EXISTS firmware_job_cp_idx ON firmware_job (charge_point_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS firmware_job_state_idx ON firmware_job (state, next_attempt_at);

CREATE TABLE IF NOT EXISTS diagnostics_request (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organisation(id),
  charge_point_id  UUID NOT NULL REFERENCES charge_point(id) ON DELETE CASCADE,
  request_id       INTEGER,
  start_time       TIMESTAMPTZ,
  stop_time        TIMESTAMPTZ,
  location         TEXT NOT NULL,                 -- where the charger was told to upload
  upload_token     TEXT,                          -- set when the built-in receiver is used
  status           TEXT NOT NULL DEFAULT 'Requested', -- Requested | Uploading | Uploaded | UploadFailed | Rejected | Idle
  file_name        TEXT,
  storage_path     TEXT,
  size_bytes       BIGINT,
  requested_by     TEXT,
  requested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS diagnostics_request_cp_idx ON diagnostics_request (charge_point_id, requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS diagnostics_request_token_idx ON diagnostics_request (upload_token)
  WHERE upload_token IS NOT NULL;

-- ─────────────────────────────────────────────── Module 2: remote start presets
CREATE TABLE IF NOT EXISTS remote_start_request (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organisation(id),
  charge_point_id  UUID NOT NULL REFERENCES charge_point(id) ON DELETE CASCADE,
  connector_no     INTEGER NOT NULL,
  id_tag           TEXT NOT NULL,
  limit_type       TEXT NOT NULL DEFAULT 'none',  -- none | energy | duration | amount
  limit_value      NUMERIC(14,3),
  energy_limit_wh  BIGINT,                        -- resolved at request time (amount -> energy via tariff)
  duration_limit_s INTEGER,
  session_id       UUID REFERENCES charging_session(id),
  requested_by     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE INDEX IF NOT EXISTS remote_start_request_match_idx
  ON remote_start_request (charge_point_id, connector_no, id_tag) WHERE session_id IS NULL;

ALTER TABLE charging_session
  ADD COLUMN IF NOT EXISTS operator_limit_wh    BIGINT,
  ADD COLUMN IF NOT EXISTS operator_limit_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS operator_stop_sent_at TIMESTAMPTZ;

-- ─────────────────────────────────────────────── row-level security for new tables
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['firmware_image','firmware_campaign','firmware_job',
                           'diagnostics_request','remote_start_request']
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

ALTER TABLE charge_point_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE charge_point_config FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS charge_point_config_tenant ON charge_point_config;
CREATE POLICY charge_point_config_tenant ON charge_point_config
  USING (
    app_current_org() IS NULL
    OR EXISTS (SELECT 1 FROM charge_point cp JOIN site s ON s.id = cp.site_id
                WHERE cp.id = charge_point_config.charge_point_id AND s.org_id = app_current_org())
  )
  WITH CHECK (
    app_current_org() IS NULL
    OR EXISTS (SELECT 1 FROM charge_point cp JOIN site s ON s.id = cp.site_id
                WHERE cp.id = charge_point_config.charge_point_id AND s.org_id = app_current_org())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
