-- 028: paying an expired card hold in the app.
--
-- A card hold whose authorisation expired at the acquirer before it was
-- captured leaves the session unpaid. The driver can pay it from the receipt
-- with any method the operator offers (QRIS, e-wallet, card, a saved card or a
-- linked e-wallet). That payment is its own payment_intent, mode 'settlement',
-- pointing at the hold it settles. Settlement payments never buy energy, are
-- never refunded as "unused", and are not matched to a session: every query
-- that does those filters on the modes prepurchase / preauth / postpay.
--
-- When the settlement is paid, the hold is marked captured (paid in the app).
-- Additive: nothing changes until a hold expires and its driver pays.

ALTER TABLE payment_intent
  ADD COLUMN IF NOT EXISTS settles_intent_id UUID REFERENCES payment_intent(id);

CREATE INDEX IF NOT EXISTS payment_intent_settles_idx ON payment_intent (settles_intent_id) WHERE settles_intent_id IS NOT NULL;

COMMENT ON COLUMN payment_intent.settles_intent_id IS
  'mode settlement: the expired card hold (payment_intent) this payment settles, paid by the driver in the app.';
