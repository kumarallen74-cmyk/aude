-- 058: "Sign in with Microsoft" (Microsoft Entra ID, OpenID Connect) for the operator console.
--
--   org_identity_provider   one row per operator organisation that has connected its OWN
--                           Microsoft Entra tenant. `tenant_id` is the Entra directory id (the
--                           ID token's `tid`), recorded from a validated sign-in of an
--                           administrator of the operator ("Connect Microsoft tenant"), never
--                           typed in. A tenant belongs to at most ONE organisation platform-wide
--                           (unique index): a sign-in from that tenant can only ever reach that
--                           organisation's console users. `allowed_domains`: optional; when not
--                           empty, a first sign-in may only be matched to a console user by an
--                           address in one of these domains.
--
--   app_user.ms_tenant_id / ms_object_id
--                           the Microsoft account a console user is bound to: (tid, oid) of the
--                           first Microsoft sign-in that matched the user by e-mail address.
--                           Later sign-ins find the user by these immutable ids, so a changed
--                           address in Entra cannot move the sign-in onto another console user.
--                           Unique: one Microsoft account, one console user. An administrator
--                           can unbind (Users & Roles); unlinking the tenant unbinds everyone.
--
--   auth_session.auth_method  'password' or 'microsoft': how the session was signed in. A
--                           Microsoft session is not held to the one-time-password change (it
--                           did not use the one-time password).
--   auth_session.idp_mfa    Microsoft reported multi-factor authentication for this sign-in
--                           (`amr` contains "mfa"): the console's own two-step verification
--                           counts as done for this session (no code step, no forced enrolment).
--
--   oidc_login_tx           a sign-in (or tenant connection) waiting for Microsoft to send the
--                           browser back: keyed by sha256(state), single use (DELETE …
--                           RETURNING), ten minutes. Holds the PKCE verifier (sealed with
--                           SECRETS_KEY), sha256 of the nonce, and sha256 of a random value in
--                           a short-lived cookie that binds the transaction to the browser that
--                           started it. Server-side because the console's session cookie is
--                           SameSite=Strict and does not come back on the redirect from
--                           login.microsoftonline.com.
--
-- No auto-provisioning: nothing here creates console users.

CREATE TABLE IF NOT EXISTS org_identity_provider (
  org_id          UUID NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL CHECK (provider IN ('microsoft')),
  tenant_id       UUID NOT NULL,
  allowed_domains TEXT[] NOT NULL DEFAULT '{}',
  linked_by       UUID REFERENCES app_user(id) ON DELETE SET NULL,
  -- The Microsoft account that proved control of the tenant (its UPN / e-mail), for the record.
  linked_by_account TEXT,
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, provider)
);
CREATE UNIQUE INDEX IF NOT EXISTS org_identity_provider_tenant_key ON org_identity_provider (provider, tenant_id);

ALTER TABLE org_identity_provider ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_identity_provider FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_identity_provider_tenant ON org_identity_provider;
-- The post-048 shape: the sign-in callback runs unscoped (it does not know the organisation
-- until it has found the tenant); a tenant's own requests see only their own row.
CREATE POLICY org_identity_provider_tenant ON org_identity_provider
  USING (app_rls_bypass() OR org_id = app_current_org())
  WITH CHECK (app_rls_bypass() OR org_id = app_current_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON org_identity_provider TO plugsure_app;

ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS ms_tenant_id UUID,
  ADD COLUMN IF NOT EXISTS ms_object_id UUID,
  ADD COLUMN IF NOT EXISTS ms_bound_at TIMESTAMPTZ;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_user_ms_binding_whole') THEN
    ALTER TABLE app_user ADD CONSTRAINT app_user_ms_binding_whole
      CHECK ((ms_tenant_id IS NULL) = (ms_object_id IS NULL) AND (ms_tenant_id IS NULL) = (ms_bound_at IS NULL));
  END IF;
END;
$$;
CREATE UNIQUE INDEX IF NOT EXISTS app_user_ms_account_key ON app_user (ms_tenant_id, ms_object_id) WHERE ms_object_id IS NOT NULL;

ALTER TABLE auth_session
  ADD COLUMN IF NOT EXISTS auth_method TEXT NOT NULL DEFAULT 'password',
  ADD COLUMN IF NOT EXISTS idp_mfa BOOLEAN NOT NULL DEFAULT false;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_session_auth_method_check') THEN
    ALTER TABLE auth_session ADD CONSTRAINT auth_session_auth_method_check CHECK (auth_method IN ('password', 'microsoft'));
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS oidc_login_tx (
  state_hash    TEXT PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  provider      TEXT NOT NULL DEFAULT 'microsoft' CHECK (provider IN ('microsoft')),
  mode          TEXT NOT NULL CHECK (mode IN ('signin', 'link')),
  -- Link mode only: the organisation and the administrator connecting the tenant.
  org_id        UUID REFERENCES organisation(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES app_user(id) ON DELETE CASCADE,
  nonce_hash    TEXT NOT NULL CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  code_verifier TEXT NOT NULL,
  browser_hash  TEXT NOT NULL CHECK (browser_hash ~ '^[0-9a-f]{64}$'),
  redirect_uri  TEXT NOT NULL,
  host          TEXT NOT NULL,
  ip            TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  CHECK ((mode = 'link') = (org_id IS NOT NULL AND user_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS oidc_login_tx_expires_idx ON oidc_login_tx (expires_at);

ALTER TABLE oidc_login_tx ENABLE ROW LEVEL SECURITY;
ALTER TABLE oidc_login_tx FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oidc_login_tx_tenant ON oidc_login_tx;
-- Written and consumed by unscoped code only (services/microsoft-signin.ts); a tenant-scoped
-- request sees its own link-mode rows at most, never a sign-in in flight (org_id NULL).
CREATE POLICY oidc_login_tx_tenant ON oidc_login_tx
  USING (app_rls_bypass() OR org_id = app_current_org())
  WITH CHECK (app_rls_bypass() OR org_id = app_current_org());
GRANT SELECT, INSERT, DELETE ON oidc_login_tx TO plugsure_app;

-- No blanket GRANT: app_user and auth_session only gain columns, which the runtime role's
-- existing table grants already cover (see 053/055 on why `GRANT … ON ALL TABLES` must not be used).
