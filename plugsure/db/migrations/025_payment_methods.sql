-- 025: e-wallet and card payments beside QRIS.
--
-- Same pre-purchase model as QRIS: the driver pays a fixed amount — in the
-- e-wallet app (GoPay, ShopeePay, OVO, DANA, LinkAja) or on the acquirer's
-- hosted card page (3-D Secure) — the acquirer's signed notification confirms
-- it, and unused balance is refunded through the acquirer. Card numbers never
-- reach PlugSure. Additive: QRIS behaves as before.

-- payment_intent.method already exists ('qris'); now also 'ewallet' and 'card'.
ALTER TABLE payment_intent
  ADD COLUMN IF NOT EXISTS channel              TEXT,   -- GOPAY, SHOPEEPAY, OVO, DANA, LINKAJA, CARD, QRIS
  ADD COLUMN IF NOT EXISTS checkout_url         TEXT,   -- where the driver completes an e-wallet / card payment
  ADD COLUMN IF NOT EXISTS provider_payment_id  TEXT;   -- the acquirer's id of the payment (some refund APIs need it)

-- App passes can be paid the same ways.
ALTER TABLE subscription_charge DROP CONSTRAINT IF EXISTS subscription_charge_via_check;
ALTER TABLE subscription_charge ADD CONSTRAINT subscription_charge_via_check CHECK (via IN ('qris', 'ewallet', 'card', 'invoice'));
ALTER TABLE subscription_charge
  ADD COLUMN IF NOT EXISTS channel       TEXT,
  ADD COLUMN IF NOT EXISTS checkout_url  TEXT;
