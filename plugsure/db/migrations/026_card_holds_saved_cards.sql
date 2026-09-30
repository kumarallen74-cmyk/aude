-- 026: card pre-authorisation (holds) and saved cards.
--
-- A card hold: the driver's card is authorised for the amount they choose (the
-- ceiling), the charger delivers up to that, and when the session is rated the
-- actual total is captured and the rest released. Nothing is refunded because
-- nothing extra was taken. A hold that never starts a session is released.
--
-- A saved card is the ACQUIRER's token for the card (Midtrans saved_token_id,
-- Xendit payment token), sealed with SECRETS_KEY, with only the brand, last four
-- digits and expiry kept for display. Card numbers never reach PlugSure. A
-- token is valid only at the acquirer account that issued it, so a saved card
-- belongs to one driver AND one acquirer account (integration).
--
-- Additive: nothing changes until an operator enables holds or saved cards.

-- payment_intent.mode 'preauth' (already in the model): state pending → authorised → captured,
-- or → voided (released). hold_state tracks the capture / release with retries.
ALTER TABLE payment_intent
  ADD COLUMN IF NOT EXISTS authorised_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hold_state           TEXT,      -- held | capturing | captured | capture_failed | releasing | released | release_failed
  ADD COLUMN IF NOT EXISTS hold_capture_idr     INTEGER,   -- what settlement decided to capture (≤ amount_authorised_idr)
  ADD COLUMN IF NOT EXISTS hold_attempts        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hold_next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hold_error           TEXT,
  ADD COLUMN IF NOT EXISTS released_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS save_card            BOOLEAN NOT NULL DEFAULT false,  -- the driver asked to save the card
  ADD COLUMN IF NOT EXISTS driver_card_id       UUID;                            -- paid with (or saved as) this card

CREATE INDEX IF NOT EXISTS payment_intent_hold_idx
  ON payment_intent (hold_state, hold_next_attempt_at) WHERE hold_state IS NOT NULL;

ALTER TABLE subscription_charge
  ADD COLUMN IF NOT EXISTS save_card       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS driver_card_id  UUID;

CREATE TABLE IF NOT EXISTS driver_card (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_driver_id     UUID NOT NULL REFERENCES app_driver(id) ON DELETE CASCADE,
  -- The acquirer account that issued the token (null: the development sandbox).
  integration_id    UUID REFERENCES integration(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  token_sealed      TEXT NOT NULL,
  token_hash        TEXT NOT NULL,            -- sha256 of the token: one row per card and account
  brand             TEXT,                     -- VISA | MASTERCARD | JCB | AMEX | …
  last4             TEXT,
  exp_month         INTEGER,
  exp_year          INTEGER,
  token_expires_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at      TIMESTAMPTZ,
  removed_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS driver_card_live_uq
  ON driver_card (app_driver_id, COALESCE(integration_id, '00000000-0000-0000-0000-000000000000'::uuid), token_hash)
  WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS driver_card_driver_idx ON driver_card (app_driver_id) WHERE removed_at IS NULL;

COMMENT ON TABLE driver_card IS 'A driver''s saved card: the acquirer''s token (sealed), never the card number. Driver-owned; not visible in the operator console.';

GRANT SELECT, INSERT, UPDATE, DELETE ON driver_card TO plugsure_app;
