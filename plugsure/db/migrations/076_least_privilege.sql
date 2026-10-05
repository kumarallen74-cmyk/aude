-- 076: least privilege for the runtime role again (v1.9.0).
--
-- The 1.9.0-dev copy of 075 ended with `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA
-- public TO plugsure_app`, which every migration since 048 says must not be done: it hands UPDATE and
-- DELETE on the append-only audit log back to the application. The migrator re-revokes those after each
-- run, but a 075 applied by hand (psql -f, a rehearsal) left them granted. 075 now grants only what its
-- table needs; this migration takes back, on every database, what that blanket grant (and the schema's
-- default privileges from 006) handed out beyond what the code uses:
--
--   audit_log, audit_head      append-only (048)
--   oidc_login_tx              insert, read, delete (058: a login transaction is never updated)
--   payment_webhook_event      insert, read, delete (070: an event is recorded once)
--   currency_unit, country     reference data: read only (059)
--   app_driver_deletion        insert, read (075: the deletion record is kept as written)
--
-- Idempotent; a no-op where the role does not exist.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM plugsure_app;
    REVOKE DELETE, TRUNCATE ON audit_head FROM plugsure_app;
    REVOKE UPDATE, TRUNCATE ON oidc_login_tx FROM plugsure_app;
    REVOKE UPDATE, TRUNCATE ON payment_webhook_event FROM plugsure_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON currency_unit, country FROM plugsure_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON app_driver_deletion FROM plugsure_app;
  END IF;
END $$;
