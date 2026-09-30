-- 033: a queue (waitlist) for busy sites, in the driver app.
--
-- A driver at a site where every suitable connector is taken joins the site's
-- queue. When a matching connector becomes free, it is held on the charger
-- (OCPP ReserveNow) for the driver at the head of the queue, who has a few
-- minutes to start: that "offer" is an ordinary driver_reservation linked to
-- the queue entry, so starting, paying and fleet charging work unchanged.
--
--   site.queue_*          per-site policy; off until an operator switches it on
--   driver_queue_entry    one driver's place in one site's queue
--   driver_reservation.queue_entry_id   the offer made to that entry
--
-- Additive: no site has a queue until it is switched on.

ALTER TABLE site
  ADD COLUMN IF NOT EXISTS queue_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS queue_offer_minutes INTEGER NOT NULL DEFAULT 5
    CHECK (queue_offer_minutes BETWEEN 2 AND 15),
  ADD COLUMN IF NOT EXISTS queue_max_length INTEGER NOT NULL DEFAULT 20
    CHECK (queue_max_length BETWEEN 1 AND 200),
  ADD COLUMN IF NOT EXISTS queue_max_wait_minutes INTEGER NOT NULL DEFAULT 120
    CHECK (queue_max_wait_minutes BETWEEN 15 AND 720);

CREATE TABLE IF NOT EXISTS driver_queue_entry (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organisation(id),
  site_id          UUID NOT NULL REFERENCES site(id),
  device_id        UUID NOT NULL REFERENCES driver_device(id),
  app_driver_id    UUID REFERENCES app_driver(id),
  fleet_token_id   UUID REFERENCES token(id),
  -- What the driver can use; NULL = any.
  current_type     TEXT CHECK (current_type IN ('AC', 'DC')),
  connector_type   TEXT,
  state            TEXT NOT NULL DEFAULT 'waiting'
                   CHECK (state IN ('waiting', 'offered', 'served', 'left', 'missed', 'expired', 'removed')),
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  offered_at       TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  end_reason       TEXT
);
-- One live place per phone, across all sites.
CREATE UNIQUE INDEX IF NOT EXISTS driver_queue_device_live_uq
  ON driver_queue_entry (device_id) WHERE state IN ('waiting', 'offered');
CREATE INDEX IF NOT EXISTS driver_queue_site_waiting_idx
  ON driver_queue_entry (site_id, joined_at) WHERE state IN ('waiting', 'offered');

ALTER TABLE driver_reservation
  ADD COLUMN IF NOT EXISTS queue_entry_id UUID REFERENCES driver_queue_entry(id);
CREATE INDEX IF NOT EXISTS driver_reservation_queue_idx ON driver_reservation (queue_entry_id) WHERE queue_entry_id IS NOT NULL;

ALTER TABLE driver_queue_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_queue_entry FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS driver_queue_entry_tenant ON driver_queue_entry;
CREATE POLICY driver_queue_entry_tenant ON driver_queue_entry
  USING (app_current_org() IS NULL OR org_id = app_current_org())
  WITH CHECK (app_current_org() IS NULL OR org_id = app_current_org());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
