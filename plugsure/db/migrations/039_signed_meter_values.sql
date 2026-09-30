-- 039: signed meter values (OCMF, the Open Charge Metering Format).
--
--   signed_meter_value       every signed reading a charger sent for a session: OCPP 1.6
--                            "SignedData" samples and OCPP 2.0.1 / 2.1 signedMeterValue,
--                            as received, with what PlugSure could read from it and
--                            whether its signature checked out
--   connector.meter_public_key  the meter's public key (hex DER), as on its label or
--                            type-approval papers: what signatures are checked against
--   site.signed_meter_policy off | record (default) | require: whether sessions here
--                            must carry verified signed readings to be billed
--   charging_session.signed_* the outcome for the session: the energy between the signed
--                            start and end readings, and how it compares with the bill
--
-- Additive; with the default policy nothing is billed differently.

CREATE TABLE IF NOT EXISTS signed_meter_value (
  id              BIGSERIAL PRIMARY KEY,
  session_id      UUID NOT NULL REFERENCES charging_session(id) ON DELETE CASCADE,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  sampled_at      TIMESTAMPTZ,
  context         TEXT,
  measurand       TEXT,
  encoding        TEXT NOT NULL DEFAULT 'OCMF',
  data            TEXT NOT NULL,
  public_key      TEXT,
  signing_method  TEXT,
  -- What was read from the OCMF payload (meter serial, readings), when it parsed.
  meter_serial    TEXT,
  readings        JSONB,
  verify_status   TEXT NOT NULL CHECK (verify_status IN ('valid', 'invalid', 'no_key', 'unreadable', 'unsupported')),
  verify_detail   TEXT,
  key_source      TEXT CHECK (key_source IN ('registered', 'charger')),
  UNIQUE (session_id, data)
);
CREATE INDEX IF NOT EXISTS signed_meter_value_session_idx ON signed_meter_value (session_id, id);

ALTER TABLE connector ADD COLUMN IF NOT EXISTS meter_public_key TEXT;

ALTER TABLE site ADD COLUMN IF NOT EXISTS signed_meter_policy TEXT NOT NULL DEFAULT 'record'
  CHECK (signed_meter_policy IN ('off', 'record', 'require'));

ALTER TABLE charging_session
  ADD COLUMN IF NOT EXISTS signed_status     TEXT CHECK (signed_status IN ('verified', 'unverified_key', 'mismatch', 'invalid', 'incomplete', 'missing')),
  ADD COLUMN IF NOT EXISTS signed_energy_wh  BIGINT,
  ADD COLUMN IF NOT EXISTS signed_detail     TEXT;

ALTER TABLE signed_meter_value ENABLE ROW LEVEL SECURITY;
ALTER TABLE signed_meter_value FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS signed_meter_value_tenant ON signed_meter_value;
CREATE POLICY signed_meter_value_tenant ON signed_meter_value
  USING (app_current_org() IS NULL OR org_id = app_current_org())
  WITH CHECK (app_current_org() IS NULL OR org_id = app_current_org());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
