-- Rollback of 072_hub_core.sql (PlugSure Hub routing core).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/072_down.sql
--
-- Run 073_down.sql first when H2's clearing tables exist (they reference these). Refuses while 073's ledger
-- holds rows. Internal tenants' 'PlugSure Hub' partner rows (ocpi_partner kind='hub') are left in place, closed.
DO $$
BEGIN
  IF to_regclass('public.hub_cdr') IS NOT NULL THEN
    RAISE EXCEPTION 'hub_cdr exists: roll back 073 first (073_down.sql)';
  END IF;
  -- Hub-only organisations (external members' consoles): their users and API keys are confined to the hub
  -- routes BY organisation.hub_only (api/hub-only.ts). Dropping the flag would silently turn each of them into a
  -- full CSMS tenant. So the rollback refuses while any exists: disable their users and revoke their API keys
  -- (or delete the organisations) deliberately first, then set hub_only = false on them and run this again.
  IF EXISTS (SELECT 1 FROM organisation WHERE hub_only) THEN
    RAISE EXCEPTION '% hub-only organisation(s) exist (external hub members): disable their users and API keys, set hub_only = false, then roll back',
      (SELECT count(*) FROM organisation WHERE hub_only);
  END IF;
END $$;

UPDATE ocpi_partner SET state = 'closed', token_in_hash = NULL, token_in = NULL, token_out = NULL, updated_at = now()
 WHERE id IN (SELECT peer_partner_id FROM hub_connection WHERE peer_partner_id IS NOT NULL);

DROP TABLE IF EXISTS hub_message;
DROP TABLE IF EXISTS hub_callback;
DROP TABLE IF EXISTS hub_outbox;
DROP TABLE IF EXISTS hub_route_index;
DROP TABLE IF EXISTS hub_agreement;
DROP TABLE IF EXISTS hub_party;
DROP TABLE IF EXISTS hub_party_key;
DROP TABLE IF EXISTS hub_connection;
DROP TABLE IF EXISTS hub_member;
DROP TABLE IF EXISTS hub_self_party;
DROP TABLE IF EXISTS hub_entity;
-- No hub-only organisation is left (checked above), so dropping the flag changes no organisation's access.
ALTER TABLE organisation DROP COLUMN IF EXISTS hub_only;

DELETE FROM schema_migration WHERE name = '072_hub_core.sql';
