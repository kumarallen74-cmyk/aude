-- 043: an unknown start register is recorded as unknown, not as zero.
--
--   charging_session.meter_start_unknown  true while the session's start register
--                            has not been observed. OCPP 2.0.1 makes meterValue on
--                            TransactionEvent(Started) optional; defaulting the start
--                            to 0 made the first Updated sample — the charger's
--                            LIFETIME register, 8,450,000 Wh in the reproduction —
--                            the session's energy. While this is true the first
--                            register observed (Updated or Ended) becomes
--                            meter_start_wh, with energy 0 at that point, and the
--                            flag is cleared.
--
-- Additive; every existing row keeps its recorded start (false).

ALTER TABLE charging_session
  ADD COLUMN IF NOT EXISTS meter_start_unknown BOOLEAN NOT NULL DEFAULT false;
