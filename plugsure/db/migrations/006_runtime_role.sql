-- ═══════════════════════════════════════════════════════════════════════════
-- 006: make it possible to actually RUN this as a non-superuser
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The third audit pass found that no `DATABASE_URL` existed that a production
-- process would start with — two gates that excluded each other:
--
--   * As a superuser, `assertRlsPosture()` refuses to start, because a superuser
--     bypasses every row-level security policy and the "second line of defence"
--     would be decorative. docker-compose.yml hardcoded the postgres superuser,
--     so the documented container path could never come up at all.
--
--   * As `plugsure_app`, the gateway's boot-time `CREATE SEQUENCE IF NOT EXISTS
--     ocpp_tx_seq` failed with "permission denied for schema public" — Postgres
--     checks the ACL before IF NOT EXISTS short-circuits, so it failed on every
--     start even though the sequence already existed. And migration 002 created
--     the role NOLOGIN with no password, so the error message's own advice
--     ("connect as plugsure_app") could not be followed.
--
-- This migration closes all three: the sequence is created here rather than at
-- boot, the role can log in, and its grants cover what the application actually
-- does.

-- ────────────────────────────────────────────────── the transaction sequence
-- Owned by the migration, not by the gateway. DDL does not belong on a boot
-- path that runs as the least-privileged role in the system.
CREATE SEQUENCE IF NOT EXISTS ocpp_tx_seq START 1000;

COMMENT ON SEQUENCE ocpp_tx_seq IS
  'OCPP 1.6 transactionId source. 1.6 requires a CSMS-assigned integer; starting '
  'above 1000 keeps demo ids visually distinct from connector and EVSE numbers.';

GRANT USAGE, SELECT ON SEQUENCE ocpp_tx_seq TO plugsure_app;

-- ─────────────────────────────────────────────────────────── a usable role
DO $$
BEGIN
  -- 002 created this NOLOGIN. An application cannot connect as a NOLOGIN role,
  -- which made the whole RLS posture unreachable in practice.
  ALTER ROLE plugsure_app LOGIN;
EXCEPTION WHEN undefined_object THEN
  CREATE ROLE plugsure_app LOGIN;
END $$;

COMMENT ON ROLE plugsure_app IS
  'Runtime role for the API and gateway. Deliberately NOT a superuser and without '
  'BYPASSRLS, so the row-level security policies actually constrain it. Set its '
  'password at deploy time: ALTER ROLE plugsure_app PASSWORD ''...'';';

-- The application never issues DDL, so it gets no CREATE on the schema. It does
-- need to read every sequence it inserts against.
GRANT USAGE ON SCHEMA public TO plugsure_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
GRANT EXECUTE ON FUNCTION app_current_org() TO plugsure_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO plugsure_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO plugsure_app;

-- The migration runner itself keeps running as the owner/superuser; only the
-- API and gateway processes use plugsure_app. See deploy/README.md.
