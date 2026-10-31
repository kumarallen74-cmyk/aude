-- 081: a fallback payments account (v1.13.0).
--
--   integration.kind 'payments_fallback'   per operator (or the platform's, the default), provider duitku: used for a new
--                                          charging payment when the main acquirer (Xendit) does not answer
--                                          (services/payments/registry.ts startPaymentWithFallback). Its payments carry
--                                          its integration_id like any other, so their notifications, status checks,
--                                          refunds and Finance follow them. Archived, never deleted, like a payments account.
--
-- No table of its own. Additive and idempotent. Rollback: db/rollback/081_down.sql.

ALTER TABLE integration DROP CONSTRAINT IF EXISTS integration_kind_check;
ALTER TABLE integration ADD CONSTRAINT integration_kind_check
  CHECK (kind IN ('payments', 'payments_fallback', 'otp', 'otp_fallback', 'pnc_pki', 'map_tiles', 'ai_support'));
