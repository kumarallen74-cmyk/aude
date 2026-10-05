-- 070: Stripe for Malaysia and Singapore (docs/MULTI-COUNTRY-DESIGN.md §6.3, WP3; deploy/STRIPE.md).
--
-- Additive only. Numbered 070 (not 062) so it cannot collide with a migration WP2 adds in parallel.
--
-- 1. payment_webhook_event: the events an acquirer that numbers its events (Stripe: evt_…) has had applied, per
--    account. A re-delivered or replayed event is answered 2xx and not applied again (services/payments/registry.ts).
--    Recorded AFTER the event is applied, so one whose handling failed (5xx, retried by Stripe) is not skipped.
--    Pruned after 35 days (Stripe retries for up to 3 days).
-- 2. subscription_charge.via also 'qr' (PayNow) and 'bank' (FPX), beside 031's list: the method kinds of the new channels
--    (provider.ts methodOf). payment_intent.method has no constraint.

CREATE TABLE IF NOT EXISTS payment_webhook_event (
  integration_id  UUID NOT NULL REFERENCES integration(id) ON DELETE CASCADE,
  event_id        TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 255),
  org_id          UUID REFERENCES organisation(id),
  outcome         TEXT,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (integration_id, event_id)
);
CREATE INDEX IF NOT EXISTS payment_webhook_event_received_idx ON payment_webhook_event (received_at);

-- Written and read by unscoped code only (/pay/notify); a tenant-scoped request sees its own organisation's rows at most.
ALTER TABLE payment_webhook_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_webhook_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_webhook_event_tenant ON payment_webhook_event;
CREATE POLICY payment_webhook_event_tenant ON payment_webhook_event
  USING (app_rls_bypass() OR org_id = app_current_org())
  WITH CHECK (app_rls_bypass() OR org_id = app_current_org());
-- No blanket GRANT (see 053/055: `GRANT … ON ALL TABLES` would hand UPDATE/DELETE on audit_log back).
GRANT SELECT, INSERT, DELETE ON payment_webhook_event TO plugsure_app;

ALTER TABLE subscription_charge DROP CONSTRAINT IF EXISTS subscription_charge_via_check;
ALTER TABLE subscription_charge ADD CONSTRAINT subscription_charge_via_check CHECK (via IN ('qris', 'qr', 'bank', 'ewallet', 'card', 'invoice', 'credit'));
