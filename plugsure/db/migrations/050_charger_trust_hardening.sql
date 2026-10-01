-- 050: charger provisioning and PKI hardening.
--
-- 1. Learned charging-rate units are kept PER CHARGE POINT.
--    The quirk registry is shared by every tenant's chargers of a model, keyed
--    by the vendor/model a charger reports about itself. Any one charger's
--    ChargingScheduleAllowedChargingRateUnit answer used to overwrite the
--    model's chargingRateUnit, so one unit answering "Power" put every Autel AC
--    wallbox on the platform on watt profiles — which amp-only firmware
--    rejects, leaving the station ceiling unapplied. A charger's answer now
--    applies to that charger only; the shared value is used only once it is
--    confirmed (seed data, an operator, or agreement across tenants — see
--    ocpp/quirks.ts).
--
-- 2. Station-certificate signing needs a platform request.
--    The charging-station CA signed any SignCertificate a charger sent, at any
--    security profile. A CSR is now signed only while a request PlugSure made
--    (ExtendedTriggerMessage / TriggerMessage, zero-touch upgrade or renewal) is
--    outstanding; the request expires (services/charger-ca.ts).
--
-- 3. AuthorizationKey rotation remembers which key the charger last used, so a
--    second issue before the charger applied the first no longer discards the
--    key it is actually using (services/chargepoint-keys.ts).
--
-- Additive: nothing changes for a charger until it is provisioned or a
-- certificate or key is issued.

ALTER TABLE charge_point
  -- 'A', 'W' or 'A,W': what THIS charger said it accepts in charging schedules.
  ADD COLUMN IF NOT EXISTS charging_rate_units      TEXT,
  ADD COLUMN IF NOT EXISTS charging_rate_units_at   TIMESTAMPTZ,
  -- Outstanding platform request for a station-certificate CSR, and until when it holds.
  ADD COLUMN IF NOT EXISTS station_csr_requested_until TIMESTAMPTZ,
  -- Which AuthorizationKey the charger last authenticated with, and when.
  ADD COLUMN IF NOT EXISTS auth_key_last_matched    TEXT,
  ADD COLUMN IF NOT EXISTS auth_key_last_auth_at    TIMESTAMPTZ;

ALTER TABLE charge_point DROP CONSTRAINT IF EXISTS charge_point_charging_rate_units_check;
ALTER TABLE charge_point ADD CONSTRAINT charge_point_charging_rate_units_check
  CHECK (charging_rate_units IS NULL OR charging_rate_units IN ('A', 'W', 'A,W'));
ALTER TABLE charge_point DROP CONSTRAINT IF EXISTS charge_point_auth_key_last_matched_check;
ALTER TABLE charge_point ADD CONSTRAINT charge_point_auth_key_last_matched_check
  CHECK (auth_key_last_matched IS NULL OR auth_key_last_matched IN ('current', 'previous'));

-- A model-wide chargingRateUnit that nobody confirmed was written by a single
-- charger under the old rule: it is not evidence, so stop trusting it. The seed
-- profiles are re-confirmed at start-up (seedQuirks); an operator can confirm
-- any other model again.
UPDATE quirk_profile
   SET findings = findings - 'chargingRateUnit', updated_at = now()
 WHERE findings ? 'chargingRateUnit'
   AND NOT findings ? 'chargingRateUnitConfirmedBy';

-- Consensus look-ups: chargers of one model by the unit they reported.
CREATE INDEX IF NOT EXISTS charge_point_quirk_rate_unit_idx
  ON charge_point (quirk_profile_id, charging_rate_units)
  WHERE charging_rate_units IS NOT NULL;
