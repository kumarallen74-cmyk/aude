-- 011: refunds, charger uptime history, outbound webhooks
--
-- Found by the v1.3 field test and gap review against commercial CSMS
-- platforms. All additive; no existing behaviour changes until an operator acts.

-- ─────────────────────────────────────────────── refunds
-- A refund was promised to drivers ("sisa saldo dikembalikan") but nothing ever
-- issued one: an under-used prepaid session only raised an alert, and a driver
-- who paid and never started was not even flagged — the payment sat in
-- 'captured' forever. Refunds are now a tracked state on the payment itself.
ALTER TABLE payment_intent
  ADD COLUMN IF NOT EXISTS refund_state        TEXT
    CHECK (refund_state IN ('due', 'processing', 'refunded', 'failed')),
  ADD COLUMN IF NOT EXISTS refund_due_idr      INTEGER,
  ADD COLUMN IF NOT EXISTS refunded_idr        INTEGER,
  ADD COLUMN IF NOT EXISTS refund_reason       TEXT,
  ADD COLUMN IF NOT EXISTS refund_method       TEXT CHECK (refund_method IN ('provider', 'manual')),
  ADD COLUMN IF NOT EXISTS refund_ref          TEXT,
  ADD COLUMN IF NOT EXISTS refund_error        TEXT,
  ADD COLUMN IF NOT EXISTS refund_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refunded_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refunded_by         UUID;
CREATE INDEX IF NOT EXISTS payment_intent_refund_idx
  ON payment_intent (org_id, refund_state) WHERE refund_state IS NOT NULL;
COMMENT ON COLUMN payment_intent.refund_state IS
  'NULL = nothing owed. due = owed to the payer; processing = provider call in flight; '
  'refunded = paid back (refund_ref = provider id or bank-transfer reference); failed = provider refused, retry or refund manually.';

-- ─────────────────────────────────────────────── charger uptime history
-- Offline detection only emitted an in-process event; nothing was stored, no
-- alert was raised, and uptime could not be reported. One row per outage.
CREATE TABLE IF NOT EXISTS charge_point_outage (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  charge_point_id  UUID NOT NULL REFERENCES charge_point(id) ON DELETE CASCADE,
  went_offline_at  TIMESTAMPTZ NOT NULL,
  came_online_at   TIMESTAMPTZ,
  alerted_at       TIMESTAMPTZ
);
-- At most one open outage per charger.
CREATE UNIQUE INDEX IF NOT EXISTS charge_point_outage_open_uq
  ON charge_point_outage (charge_point_id) WHERE came_online_at IS NULL;
CREATE INDEX IF NOT EXISTS charge_point_outage_range_idx
  ON charge_point_outage (charge_point_id, went_offline_at);

-- ─────────────────────────────────────────────── outbound webhooks
-- webhook_endpoint existed since 001 with nothing behind it. The secret column
-- now holds an AES-256-GCM sealed value (SECRETS_KEY), never the plain secret.
ALTER TABLE webhook_endpoint
  ADD COLUMN IF NOT EXISTS description      TEXT,
  ADD COLUMN IF NOT EXISTS created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_success_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_failure_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error       TEXT;
ALTER TABLE webhook_endpoint DROP CONSTRAINT IF EXISTS webhook_endpoint_state_chk;
ALTER TABLE webhook_endpoint ADD CONSTRAINT webhook_endpoint_state_chk
  CHECK (state IN ('active', 'paused', 'disabled'));

CREATE TABLE IF NOT EXISTS webhook_delivery (
  id               BIGSERIAL PRIMARY KEY,
  org_id           UUID NOT NULL REFERENCES organisation(id),
  endpoint_id      UUID NOT NULL REFERENCES webhook_endpoint(id) ON DELETE CASCADE,
  event_id         UUID NOT NULL DEFAULT gen_random_uuid(),
  event_type       TEXT NOT NULL,
  payload          JSONB NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status      INTEGER,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS webhook_delivery_due_idx
  ON webhook_delivery (next_attempt_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS webhook_delivery_endpoint_idx
  ON webhook_delivery (endpoint_id, created_at DESC);

-- ─────────────────────────────────────────────── row-level security for new tables
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['charge_point_outage','webhook_delivery']
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

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
