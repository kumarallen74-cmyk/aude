-- 014: site owners — the owner portal and per-owner billing
--
-- PlugSure operates chargers on sites that belong to other businesses (hotels,
-- retail, offices). Each such business is a SITE OWNER: it gets its own console
-- sign-in limited to its own sites (the "Site Owner" role, scoped to the owner),
-- and a monthly statement of its charging units, amounts and the split between
-- the owner and PlugSure.
--
--   site_owner                 the business, its tax identity and contact
--   site.owner_id              which owner a site belongs to (NULL = operator's own)
--   commercial_plan.owner_id   a plan agreed with one owner (else the org's plan applies)
--   commission_statement.owner_id  a statement to one owner
--   user_role scope_type 'owner'   a grant covering every site of that owner
--
-- All additive; no site has an owner until one is assigned.

CREATE TABLE IF NOT EXISTS site_owner (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organisation(id),
  name              TEXT NOT NULL,
  legal_name        TEXT,
  npwp              TEXT,
  pkp               BOOLEAN NOT NULL DEFAULT false,
  address           TEXT,
  contact_name      TEXT,
  contact_email     TEXT,
  contact_phone     TEXT,
  -- Whose name is on the driver's tax receipt. 'operator' until payments are
  -- settled to the owner's own merchant account; then 'owner'.
  seller_of_record  TEXT NOT NULL DEFAULT 'operator' CHECK (seller_of_record IN ('operator', 'owner')),
  archived_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_owner_org_idx ON site_owner (org_id);

ALTER TABLE site ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES site_owner(id);
-- The owner a site was last removed from: a site with charging history can
-- only go back to that owner, never on to a different one (via "no owner").
ALTER TABLE site ADD COLUMN IF NOT EXISTS previous_owner_id UUID REFERENCES site_owner(id);
CREATE INDEX IF NOT EXISTS site_owner_id_idx ON site (owner_id) WHERE owner_id IS NOT NULL;

-- When a charger joined its current site. A charger moved to another owner's
-- site must not bring its OCPP log (idTags), diagnostics or connection history
-- into the new owner's view; site-scoped users see history from this time on.
-- NULL = since registration.
ALTER TABLE charge_point ADD COLUMN IF NOT EXISTS site_assigned_at TIMESTAMPTZ;

-- Plans and statements: per organisation (owner_id NULL) or per owner.
ALTER TABLE commercial_plan ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES site_owner(id);
ALTER TABLE commercial_plan DROP CONSTRAINT IF EXISTS commercial_plan_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS commercial_plan_version_uq
  ON commercial_plan (org_id, (COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid)), effective_from);

ALTER TABLE commission_statement ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES site_owner(id);
ALTER TABLE commission_statement ADD COLUMN IF NOT EXISTS owner_share_idr BIGINT;
ALTER TABLE commission_statement DROP CONSTRAINT IF EXISTS commission_statement_org_id_period_key;
CREATE UNIQUE INDEX IF NOT EXISTS commission_statement_period_uq
  ON commission_statement (org_id, (COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid)), period);

ALTER TABLE site_owner ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_owner FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_owner_tenant ON site_owner;
CREATE POLICY site_owner_tenant ON site_owner
  USING (app_current_org() IS NULL OR org_id = app_current_org())
  WITH CHECK (app_current_org() IS NULL OR org_id = app_current_org());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
