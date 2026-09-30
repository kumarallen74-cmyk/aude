-- ═══════════════════════════════════════════════════════════════════════════
-- 005: a QRIS pre-purchase must know WHO paid, and must be settled afterwards
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Two findings from the third audit pass, both on the prepaid path.
--
-- 1. THE PAYMENT HAD NO PAYER.
--    `POST /v1/checkout/qris` recorded an amount and a connector and nothing
--    else, and `claimPrepaidIntent` handed the newest unclaimed intent on that
--    connector to whoever started the next transaction. A driver scans the QR
--    and pays Rp 500,000; anyone who plugs in first takes the energy. There is
--    no refund path anywhere in the codebase, so the victim simply loses it.
--    The same ordering silently orphaned the earlier payer whenever two drivers
--    queued at one connector.
--
--    An intent now names the token that may claim it. If the driver has no
--    token (the walk-up case QRIS exists for), checkout MINTS one and shows it
--    on the payment screen — the driver presents it, or the app passes it to
--    RemoteStartTransaction. Nothing else can claim that payment.
--
-- 2. NOTHING RECONCILED WHAT WAS PAID AGAINST WHAT WAS DELIVERED.
--    Prepaid sessions routinely billed 30-60% more than was collected (idle fees
--    and a WBP crossing are not in the allowance quote) and sometimes less, with
--    the surplus simply kept. Both directions are now recorded as a settlement
--    delta the operator must action.

ALTER TABLE payment_intent
  ADD COLUMN claim_id_tag         TEXT,
  ADD COLUMN claim_token_minted   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN expires_at           TIMESTAMPTZ,
  ADD COLUMN settlement_delta_idr INTEGER,
  ADD COLUMN settled_at           TIMESTAMPTZ;

COMMENT ON COLUMN payment_intent.claim_id_tag IS
  'The OCPP idTag that may claim this pre-purchase. Set at checkout, either from '
  'the driver''s own token or minted for a walk-up. An intent with no claim_id_tag '
  'predates migration 005 and is claimable by anyone — treat as legacy.';
COMMENT ON COLUMN payment_intent.claim_token_minted IS
  'True when PlugSure generated the claim token rather than the driver supplying one.';
COMMENT ON COLUMN payment_intent.expires_at IS
  'After this, an unclaimed captured intent owes the payer a refund.';
COMMENT ON COLUMN payment_intent.settlement_delta_idr IS
  'cdr.total_idr - amount_captured_idr. Positive = under-collected from a walk-up '
  'with no card on file. Negative = money held for energy never delivered, which is '
  'the direction that becomes a consumer-protection complaint.';

CREATE INDEX payment_intent_claim_idx
  ON payment_intent (connector_uuid, claim_id_tag)
  WHERE session_id IS NULL AND state IN ('authorised', 'captured');

-- Unsettled prepaid intents an operator has to deal with: paid but never
-- claimed, or claimed and the invoice did not match what was collected.
CREATE INDEX payment_intent_unsettled_idx
  ON payment_intent (org_id, expires_at)
  WHERE mode = 'prepurchase' AND settled_at IS NULL;
