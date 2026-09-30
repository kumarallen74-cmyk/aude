-- 027: linked e-wallets (tokenisation) for GoPay, OVO and DANA.
--
-- A signed-in driver links an e-wallet once, approving in the e-wallet app;
-- after that the acquirer charges it in one tap with no redirect. PlugSure
-- keeps the acquirer's token (Midtrans GoPay account id + payment option token,
-- Xendit payment method id), sealed with SECRETS_KEY, and the masked phone
-- number. Like a saved card, a linked e-wallet belongs to one driver AND one
-- acquirer account.
--
-- Linked e-wallets share driver_card with saved cards (one list in the app):
-- kind 'card' | 'ewallet'. Additive: nothing changes until an operator enables
-- linking.

ALTER TABLE driver_card
  ADD COLUMN IF NOT EXISTS kind           TEXT NOT NULL DEFAULT 'card',     -- card | ewallet
  ADD COLUMN IF NOT EXISTS channel        TEXT,                             -- GOPAY | OVO | DANA (e-wallets)
  ADD COLUMN IF NOT EXISTS account_label  TEXT,                             -- masked phone, e.g. ••••7890
  ADD COLUMN IF NOT EXISTS status         TEXT NOT NULL DEFAULT 'active',   -- pending (awaiting approval) | active | failed
  ADD COLUMN IF NOT EXISTS link_ref       TEXT;                             -- the acquirer's id of the link (account id / payment method id)

CREATE INDEX IF NOT EXISTS driver_card_link_idx ON driver_card (provider, link_ref) WHERE link_ref IS NOT NULL;

COMMENT ON COLUMN driver_card.kind IS 'card: a saved card; ewallet: a linked e-wallet (GoPay, OVO, DANA).';
