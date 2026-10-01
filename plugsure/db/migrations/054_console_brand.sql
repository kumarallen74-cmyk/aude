-- 054: white-label operator console.
--
--   console_brand   one per operator, optional: the name, tagline, colours and logo
--                   the operator's console users see instead of PlugSure's, and an
--                   optional web address of its own for the console. Every user of the
--                   operator (staff, site-owner and fleet portals) sees it once signed
--                   in; on the brand's own web address the sign-in page shows it too,
--                   and only the operator's own accounts may sign in there.
--
-- A web address takes effect only once the PLATFORM operator approves it
-- (hostname_approved_at): the operator could otherwise claim the shared console's
-- own name, or another operator's, and decide who may sign in there. The platform
-- operator approves it when adding the address's Caddy site block. Changing the
-- address withdraws the approval. Only approved addresses are unique; a pending
-- claim blocks nobody.
--
-- An operator without a row keeps the PlugSure console, unchanged.

CREATE TABLE IF NOT EXISTS console_brand (
  org_id          UUID PRIMARY KEY REFERENCES organisation(id) ON DELETE CASCADE,
  product_name    TEXT NOT NULL CHECK (char_length(product_name) BETWEEN 1 AND 30),
  tagline         TEXT CHECK (tagline IS NULL OR char_length(tagline) BETWEEN 1 AND 30),
  brand_color     TEXT NOT NULL DEFAULT '#1b4d8c' CHECK (brand_color ~ '^#[0-9a-f]{6}$'),
  accent_color    TEXT NOT NULL DEFAULT '#0c7856' CHECK (accent_color ~ '^#[0-9a-f]{6}$'),
  -- The square logo, normalised to 256 x 256 PNG on upload; served by its hash.
  logo_png        BYTEA,
  logo_sha256     TEXT CHECK (logo_sha256 IS NULL OR logo_sha256 ~ '^[0-9a-f]{64}$'),
  -- The console's own web address (e.g. console.nusantaracharge.id), served by its own
  -- Caddy site block (deploy/Caddyfile). The application also keeps it apart from the
  -- driver apps' addresses and PlugSure's own.
  hostname        TEXT,
  hostname_approved_at TIMESTAMPTZ,
  hostname_approved_by UUID,
  show_powered_by BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((logo_png IS NULL) = (logo_sha256 IS NULL)),
  CHECK (hostname IS NOT NULL OR hostname_approved_at IS NULL)
);
-- One operator per approved address.
CREATE UNIQUE INDEX IF NOT EXISTS console_brand_approved_hostname_key ON console_brand (hostname) WHERE hostname_approved_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS console_brand_logo_sha256_idx ON console_brand (logo_sha256) WHERE logo_sha256 IS NOT NULL;

ALTER TABLE console_brand ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_brand FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS console_brand_tenant ON console_brand;
-- The post-048 shape: unscoped only where the session is deliberately unscoped (the
-- sign-in page and the logo, which are served before anyone has signed in).
CREATE POLICY console_brand_tenant ON console_brand
  USING (app_rls_bypass() OR org_id = app_current_org())
  WITH CHECK (app_rls_bypass() OR org_id = app_current_org());

GRANT SELECT, INSERT, UPDATE, DELETE ON console_brand TO plugsure_app;
