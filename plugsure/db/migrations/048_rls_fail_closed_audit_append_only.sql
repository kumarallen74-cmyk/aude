-- ═══════════════════════════════════════════════════════════════════════════
-- 048: row-level security fails CLOSED; audit_log becomes append-only
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. FAIL-CLOSED RLS
--
-- Every tenant policy since 002 read
--
--     app_current_org() IS NULL OR org_id = app_current_org()
--
-- An unset org meant "every row". That is how the unscoped processes work — the
-- OCPP gateway, the workers, the driver API (/d/*), OCPI (/ocpi/*), payment
-- notifications (/pay/*), login, SSE — but it also meant that INSIDE a tenant's
-- request, anything that lost or blanked the org (an empty set_config, a code
-- path that reset it) silently saw every tenant. The second line of defence
-- opened exactly when the first one had failed.
--
-- Being unscoped is now an explicit, separate switch:
--
--     app_rls_bypass() OR org_id = app_current_org()
--
-- `app.rls_bypass` is set to 'on' at SESSION level on every pooled connection
-- (src/db/pool.ts, the pool's 'connect' event), so the unscoped processes are
-- unchanged. A request's org scope (enterOrgScope / withOrg) sets it 'off' with
-- set_config(..., true) — LOCAL to the request transaction — in the same
-- statement as the org. Inside a request, a missing org now matches NOTHING.
-- LOCAL settings end with the transaction, so a pooled connection goes back to
-- the pool with the bypass on and no org, as it came.
--
-- The policies are rewritten from pg_policies rather than by hand, so none can
-- be missed: every policy whose expression contains the old disjunct has
-- exactly that disjunct replaced — including the shapes that are not the plain
-- one (charge_point and charge_point_config test their org through site;
-- integration and integration_event also admit platform rows, org_id IS NULL).
-- The block refuses to finish if any old-shape policy survives.
--
-- NEW POLICIES MUST USE THE NEW SHAPE. A policy that copies the old one
-- re-opens its table to every tenant inside a request; the API logs an error at
-- boot if it finds one (pool.ts, assertRlsPosture).

-- The bypass only counts while NO tenant is pinned. A pinned org always wins,
-- so a process still running pre-048 code (which pins the org but knows nothing
-- of the bypass, and inherits bypass=on from the role default below) stays
-- isolated inside its requests: code and migration can be rolled out in either
-- order.
CREATE OR REPLACE FUNCTION app_rls_bypass() RETURNS boolean AS $$
  SELECT COALESCE(current_setting('app.rls_bypass', true), '') = 'on'
     AND app_current_org() IS NULL;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION app_rls_bypass() IS
  'True when this session is deliberately unscoped (app.rls_bypass = on and no org pinned): '
  'the gateway, workers, driver/OCPI/payment endpoints. Pooled connections start with it on; '
  'a request''s org scope turns it off LOCAL to its transaction. Unset = off = fail closed.';

COMMENT ON FUNCTION app_current_org() IS
  'Per-transaction tenant, set LOCAL with app.current_org_id by the request''s org scope. '
  'Since 048 a NULL org no longer disables the policies: only app_rls_bypass() does.';

GRANT EXECUTE ON FUNCTION app_rls_bypass() TO plugsure_app;

DO $$
DECLARE
  r record;
  n int := 0;
  leftover text;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (qual LIKE '%app_current_org() IS NULL%' OR with_check LIKE '%app_current_org() IS NULL%')
  LOOP
    IF r.qual IS NOT NULL THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I USING (%s)', r.policyname, r.schemaname, r.tablename,
                     replace(r.qual, '(app_current_org() IS NULL)', 'app_rls_bypass()'));
    END IF;
    IF r.with_check IS NOT NULL THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I WITH CHECK (%s)', r.policyname, r.schemaname, r.tablename,
                     replace(r.with_check, '(app_current_org() IS NULL)', 'app_rls_bypass()'));
    END IF;
    n := n + 1;
  END LOOP;

  SELECT string_agg(tablename || '.' || policyname, ', ') INTO leftover
    FROM pg_policies
   WHERE schemaname = 'public'
     AND (qual LIKE '%app_current_org() IS NULL%' OR with_check LIKE '%app_current_org() IS NULL%');
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION '048: policies still fail open after the rewrite: %', leftover;
  END IF;
  RAISE NOTICE '048: % row-level security policies rewritten to fail closed', n;
END;
$$;

-- Direct sessions as the runtime role that do NOT come through the pool — the
-- API's LISTEN connection, the e2e harnesses' fixture connections, an operator's
-- psql — start unscoped as they always did. This is the same default the pool
-- sets; a request scope still turns it off LOCAL. (To make raw sessions fail
-- closed too: ALTER ROLE plugsure_app IN DATABASE <db> RESET app.rls_bypass —
-- after giving those tools `options=-c app.rls_bypass=on`.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    EXECUTE format('ALTER ROLE plugsure_app IN DATABASE %I SET app.rls_bypass = %L', current_database(), 'on');
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING '048: could not set the app.rls_bypass default for plugsure_app (%); '
                'connections that bypass the application pool will see no tenant rows', SQLERRM;
END;
$$;

-- ─────────────────────────────────────── tables with org_id that had no RLS
-- Found by comparing every table with an org_id column against
-- pg_class.relrowsecurity: audit_log, audit_head, driver_charge, role. Every
-- other table with org_id already had ENABLE + FORCE (FORCE so the policies
-- also bind the table owner when it is not a superuser).

-- audit_log. A tenant reads and appends only its own chain. The PLATFORM chain
-- (org_id NULL, chain key = nil UUID) is written and verified only by unscoped
-- processes — login failures before a tenant is known, system events — which
-- run with the bypass on; no request inside an org scope writes a NULL-org or
-- foreign-org entry (every API audit call uses the caller's own org, and can()
-- refuses foreign orgs for anything but platform:admin itself).
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_log_tenant ON audit_log;
CREATE POLICY audit_log_tenant ON audit_log
  USING (app_rls_bypass() OR org_id = app_current_org())
  WITH CHECK (app_rls_bypass() OR org_id = app_current_org());

-- audit_head: org_id is the CHAIN key (an org id, or the nil UUID for the
-- platform chain), not a foreign key, but the same rule applies: a request may
-- read and advance only its own organisation's head. The append path
-- (writeAuditIn) takes the per-chain advisory lock, then the head row FOR
-- UPDATE, then INSERT … ON CONFLICT DO UPDATE — all on the caller's own row.
ALTER TABLE audit_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_head FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_head_tenant ON audit_head;
CREATE POLICY audit_head_tenant ON audit_head
  USING (app_rls_bypass() OR org_id = app_current_org())
  WITH CHECK (app_rls_bypass() OR org_id = app_current_org());

-- driver_charge: written and read by the driver API (unscoped) and joined by
-- tenant reports (refunds, sessions, benefits) inside an org scope.
ALTER TABLE driver_charge ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_charge FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS driver_charge_tenant ON driver_charge;
CREATE POLICY driver_charge_tenant ON driver_charge
  USING (app_rls_bypass() OR org_id = app_current_org())
  WITH CHECK (app_rls_bypass() OR org_id = app_current_org());

-- role: org_id NULL is a SYSTEM role (super_admin, site_host_landlord, …) that
-- every organisation's users are granted, so those rows stay readable inside a
-- request (GET /v1/auth/me, user management). They are written only by
-- ensureSystemRoles at boot, unscoped; inside a request they cannot be changed.
ALTER TABLE role ENABLE ROW LEVEL SECURITY;
ALTER TABLE role FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS role_tenant ON role;
CREATE POLICY role_tenant ON role
  USING (app_rls_bypass() OR org_id IS NULL OR org_id = app_current_org())
  WITH CHECK (app_rls_bypass() OR org_id = app_current_org());

-- ───────────────────────────────── tables WITHOUT org_id: no new policies
-- connector, evse, meter_value, ocpp_frame, charging_profile, tariff_component,
-- tariff_assignment, site_power_budget, charge_point (has one, through site) …
-- are CHILDREN of a tenant-scoped parent and carry no org_id of their own.
-- Giving them a subquery policy (EXISTS … JOIN site … org_id = app_current_org())
-- would put a join on every row they touch, and meter_value and ocpp_frame are
-- written once per OCPP frame by the gateway — the hottest path in the system.
-- They are reached from a request through their RLS-scoped parent (charge_point
-- → site, charging_session, tariff), which every route resolves and
-- authorises first (orgOfChargePoint / orgOfSite / orgOfSession + can()).
-- Tables keyed to a driver or device rather than a tenant (app_driver,
-- driver_device, driver_card, push_subscription, …) and platform tables
-- (organisation, platform_setting, platform_ca, quirk_profile, …) are not
-- tenant data in this sense and are likewise left without RLS.

-- ─────────────────────────────────────────────── 2. append-only audit_log
-- 006 granted the runtime role UPDATE and DELETE on every table, audit_log
-- included: a compromised API process could rewrite or erase history. The
-- chain makes that DETECTABLE (003/004); this makes it impossible for the
-- application role in the first place.
--
-- audit_head keeps UPDATE: the chain advances it on every append (INSERT …
-- ON CONFLICT DO UPDATE), and 004's audit_head_no_rollback trigger already
-- refuses moving it backwards. DELETE there is already refused by trigger (004);
-- revoke it too.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM plugsure_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM PUBLIC;
REVOKE DELETE, TRUNCATE ON audit_head FROM plugsure_app;
REVOKE DELETE, TRUNCATE ON audit_head FROM PUBLIC;

-- The grant alone is not enough: any later migration that re-runs
-- `GRANT … ON ALL TABLES IN SCHEMA public TO plugsure_app` hands UPDATE and
-- DELETE straight back. The trigger holds for every role. TRUNCATE (statement
-- level, and not granted to the runtime role) is left as the owner's reset,
-- which the audit test suite uses; a superuser can also switch triggers off
-- with session_replication_role = replica — nothing in the database stops a
-- superuser, which is why the head MAC is keyed and should be shipped off-box.
CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: refusing to % entry % (org %)', lower(TG_OP), OLD.id, OLD.org_id
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- ─────────────────────────────────────────── 3. unsealed secrets (report)
-- secrets.ts used to return any value without an `enc:` prefix as plaintext.
-- Every write path seals, and no earlier migration stored plaintext, so outside
-- development/test an unprefixed value is now refused (SECRETS_ALLOW_PLAINTEXT=1
-- is the temporary escape hatch). List any such values so they can be
-- re-entered BEFORE the new code refuses them. Reporting only; nothing changes.
DO $$
DECLARE
  col record;
  found bigint;
BEGIN
  FOR col IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND (c.table_name, c.column_name) IN (
             ('webhook_endpoint', 'secret'), ('ocpi_partner', 'token_in'), ('ocpi_partner', 'token_out'),
             ('notification_channel', 'secret'), ('notification_channel', 'webhook_secret'),
             ('integration', 'secrets_sealed'), ('driver_card', 'token_sealed'),
             ('driver_app_brand', 'apns_key_sealed'), ('platform_ca', 'key_sealed'), ('pnc_mock_ca', 'key_sealed'))
  LOOP
    EXECUTE format($q$SELECT count(*) FROM %I WHERE %I IS NOT NULL AND %I <> '' AND %I NOT LIKE 'enc:v_:%%'$q$,
                   col.table_name, col.column_name, col.column_name, col.column_name)
      INTO found;
    IF found > 0 THEN
      RAISE WARNING '048: %.% holds % unsealed value(s); outside development/test they will be refused — re-enter them',
                    col.table_name, col.column_name, found;
    END IF;
  END LOOP;
END;
$$;
