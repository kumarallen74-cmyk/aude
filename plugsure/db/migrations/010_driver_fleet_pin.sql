-- 010: driver app ↔ v1.3 alignment — fleet PIN brute-force protection
--
-- A fleet card's app PIN (set in the RFID centre) is what stands between a
-- known card number and billing that fleet. OTP verification already counts
-- wrong guesses; the fleet PIN did not, so a short PIN could be walked. The
-- card now locks for a period after repeated wrong PINs, exactly like console
-- sign-in does for operator passwords.

ALTER TABLE token ADD COLUMN IF NOT EXISTS pin_failures INT NOT NULL DEFAULT 0;
ALTER TABLE token ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMPTZ;

COMMENT ON COLUMN token.pin_failures IS
  'Consecutive wrong driver-app PIN attempts for this fleet card; reset on success or when the PIN is changed.';
COMMENT ON COLUMN token.pin_locked_until IS
  'Driver-app fleet sign-in for this card is refused until this time after too many wrong PINs.';
