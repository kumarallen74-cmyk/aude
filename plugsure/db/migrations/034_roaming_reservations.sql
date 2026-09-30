-- 034: fleet drivers reserve a charger on a partner network (PlugSure as the eMSP).
--
-- The app sends OCPI RESERVE_NOW to the partner operator with the driver's roaming
-- card as the token, and CANCEL_RESERVATION if the driver changes their mind. The
-- operator's charger holds the EVSE; this row ties the reservation to the phone.
--
--   ocpi_command.command         may now also be RESERVE_NOW / CANCEL_RESERVATION
--   driver_roaming_reservation   one reservation on a partner network
--
-- Additive; nothing changes for drivers until a card is shared for roaming.

ALTER TABLE ocpi_command DROP CONSTRAINT IF EXISTS ocpi_command_command_check;
ALTER TABLE ocpi_command ADD CONSTRAINT ocpi_command_command_check
  CHECK (command IN ('START_SESSION', 'STOP_SESSION', 'UNLOCK_CONNECTOR', 'RESERVE_NOW', 'CANCEL_RESERVATION'));

CREATE TABLE IF NOT EXISTS driver_roaming_reservation (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organisation(id),
  device_id          UUID NOT NULL REFERENCES driver_device(id),
  token_id           UUID NOT NULL REFERENCES token(id),
  partner_id         UUID NOT NULL REFERENCES ocpi_partner(id) ON DELETE CASCADE,
  country_code       TEXT NOT NULL,
  party_id           TEXT NOT NULL,
  location_id        TEXT NOT NULL,
  evse_uid           TEXT NOT NULL,
  -- The id we gave the operator (OCPI reservation_id, up to 36 characters).
  reservation_id     TEXT NOT NULL,
  reserve_command_id UUID REFERENCES ocpi_command(id),
  cancel_command_id  UUID REFERENCES ocpi_command(id),
  -- requested: the operator took the command, the charger's answer is awaited.
  state              TEXT NOT NULL DEFAULT 'requested'
                     CHECK (state IN ('requested', 'active', 'rejected', 'cancelled', 'expired', 'used')),
  problem            TEXT,
  expires_at         TIMESTAMPTZ NOT NULL,
  reminded_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at           TIMESTAMPTZ
);
-- One live partner reservation per phone.
CREATE UNIQUE INDEX IF NOT EXISTS driver_roaming_reservation_device_live_uq
  ON driver_roaming_reservation (device_id) WHERE state IN ('requested', 'active');
CREATE INDEX IF NOT EXISTS driver_roaming_reservation_live_idx
  ON driver_roaming_reservation (expires_at) WHERE state IN ('requested', 'active');

ALTER TABLE driver_roaming_reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_roaming_reservation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS driver_roaming_reservation_tenant ON driver_roaming_reservation;
CREATE POLICY driver_roaming_reservation_tenant ON driver_roaming_reservation
  USING (app_current_org() IS NULL OR org_id = app_current_org())
  WITH CHECK (app_current_org() IS NULL OR org_id = app_current_org());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
