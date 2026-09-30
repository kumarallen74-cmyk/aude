-- 035: a fee for reserving a connector in the driver app, set per site.
--
--   site.reservation_fee_idr        0 (the default) = reservations stay free
--   reservation_checkout            an app driver paying the fee; the connector is
--                                   held (driver_reservation) once it is paid
--   driver_reservation.fee_*        what the reservation cost and where the fee stands:
--                                     none       free (fee 0, or a queue offer)
--                                     paid       paid in the app
--                                     invoice    a fleet card's: on the next fleet invoice
--                                     waived     not charged (cancelled at once, or the charger refused)
--                                     refund_due paid, and owed back (see Refunds)
--   fleet_invoice_item kind 'reservation'
--
-- Additive: nothing is charged until an operator sets a fee on a site.

ALTER TABLE site ADD COLUMN IF NOT EXISTS reservation_fee_idr INTEGER NOT NULL DEFAULT 0
  CHECK (reservation_fee_idr BETWEEN 0 AND 100000);

ALTER TABLE driver_reservation
  ADD COLUMN IF NOT EXISTS fee_idr          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fee_dpp_idr      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fee_ppn_idr      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fee_total_idr    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fee_state        TEXT NOT NULL DEFAULT 'none'
    CHECK (fee_state IN ('none', 'paid', 'invoice', 'waived', 'refund_due')),
  ADD COLUMN IF NOT EXISTS fee_intent_id    UUID REFERENCES payment_intent(id),
  ADD COLUMN IF NOT EXISTS fleet_account_id UUID REFERENCES fleet_account(id),
  ADD COLUMN IF NOT EXISTS held_at          TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS driver_reservation_fleet_fee_idx
  ON driver_reservation (fleet_account_id, held_at) WHERE fee_state = 'invoice';

CREATE TABLE IF NOT EXISTS reservation_checkout (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organisation(id),
  device_id        UUID NOT NULL REFERENCES driver_device(id),
  app_driver_id    UUID REFERENCES app_driver(id),
  connector_uuid   UUID NOT NULL REFERENCES connector(id),
  fee_idr          INTEGER NOT NULL,
  fee_dpp_idr      INTEGER NOT NULL,
  fee_ppn_idr      INTEGER NOT NULL,
  fee_total_idr    INTEGER NOT NULL,
  payment_intent_id UUID REFERENCES payment_intent(id),
  -- pending: waiting for the payment; held: paid and the connector held (reservation_id);
  -- failed: paid but the connector could not be held (refund due); expired / cancelled: never paid.
  state            TEXT NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending', 'held', 'failed', 'expired', 'cancelled')),
  reservation_id   UUID REFERENCES driver_reservation(id),
  problem          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS reservation_checkout_pending_idx ON reservation_checkout (created_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS reservation_checkout_intent_idx ON reservation_checkout (payment_intent_id);

ALTER TABLE fleet_invoice_item DROP CONSTRAINT IF EXISTS fleet_invoice_item_kind_check;
ALTER TABLE fleet_invoice_item ADD CONSTRAINT fleet_invoice_item_kind_check
  CHECK (kind IN ('session', 'roaming', 'subscription_charge', 'reservation'));

ALTER TABLE reservation_checkout ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_checkout FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reservation_checkout_tenant ON reservation_checkout;
CREATE POLICY reservation_checkout_tenant ON reservation_checkout
  USING (app_current_org() IS NULL OR org_id = app_current_org())
  WITH CHECK (app_current_org() IS NULL OR org_id = app_current_org());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
