-- 057: OCPP 2.0.1 multi-connector EVSEs and TransactionEvent sequence numbers.
--
--   evse.connector_status       the last status each 2.0.1 CONNECTOR of the EVSE
--                               reported, keyed by its 2.0.1 connectorId:
--                               {"1": {"status": "Charging", "raw": "Occupied", "at": "…"}, "2": {…}}.
--                               A 2.0.1 StatusNotification addresses (evseId, connectorId),
--                               but the connector table's row per EVSE is what sessions,
--                               the console, the driver app and OCPI read, and a dual-gun
--                               EVSE (CCS2 + CHAdeMO) used to collapse onto it with the
--                               last report winning: the idle gun reporting Unavailable
--                               hid the gun that was charging. The rows now get a status
--                               derived from ALL of the EVSE's connectors
--                               (adapter201.connectorRowStatuses). 1.6 never writes it.
--
--   charging_session.ocpp_seq_no
--                               the highest TransactionEvent seqNo received for the
--                               session (2.0.1/2.1 only; NULL for 1.6). Used only to
--                               DETECT lost TransactionEvents (a jump in seqNo), which
--                               are logged and flagged on the session. Events are still
--                               processed in arrival order; nothing is reordered.
--
-- Both columns are additive with neutral defaults; no existing row changes meaning.

ALTER TABLE evse ADD COLUMN IF NOT EXISTS connector_status JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE charging_session ADD COLUMN IF NOT EXISTS ocpp_seq_no INTEGER;
