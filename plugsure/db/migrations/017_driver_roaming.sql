-- 017: roaming in the driver app
--
-- A fleet driver whose card may roam (016) starts a charge at a partner
-- operator's charger from the app. PlugSure sends START_SESSION to the operator
-- (ocpi_command) and follows the session and charge record the operator reports
-- (ocpi_remote_session, ocpi_remote_cdr). This row ties those to the phone.
--
-- Additive; nothing changes for drivers until a card is shared for roaming.

CREATE TABLE IF NOT EXISTS driver_roaming_charge (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organisation(id),
  device_id          UUID NOT NULL REFERENCES driver_device(id),
  token_id           UUID NOT NULL REFERENCES token(id),
  partner_id         UUID NOT NULL REFERENCES ocpi_partner(id) ON DELETE CASCADE,
  country_code       TEXT NOT NULL,
  party_id           TEXT NOT NULL,
  location_id        TEXT NOT NULL,
  evse_uid           TEXT NOT NULL,
  connector_id       TEXT,
  start_command_id   UUID REFERENCES ocpi_command(id),
  stop_command_id    UUID REFERENCES ocpi_command(id),
  remote_session_id  BIGINT REFERENCES ocpi_remote_session(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS driver_roaming_charge_device_idx ON driver_roaming_charge (device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS driver_roaming_charge_token_idx ON driver_roaming_charge (token_id, created_at DESC);

ALTER TABLE driver_roaming_charge ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_roaming_charge FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS driver_roaming_charge_tenant ON driver_roaming_charge;
CREATE POLICY driver_roaming_charge_tenant ON driver_roaming_charge
  USING (app_current_org() IS NULL OR org_id = app_current_org())
  WITH CHECK (app_current_org() IS NULL OR org_id = app_current_org());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
