-- 063: commission plans per currency (docs/MULTI-COUNTRY-DESIGN.md §D9, WP2).
--
-- An organisation operating in several countries has one plan version per (owner,
-- month, CURRENCY): tier bounds, minimums and private-site fees are amounts in that
-- currency. Every existing row is IDR (059), so the new index admits exactly the
-- rows the old one did. commercial_plan is tiny (one row per customer and change).
CREATE UNIQUE INDEX IF NOT EXISTS commercial_plan_version_currency_uq
  ON commercial_plan (org_id, (COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid)), effective_from, currency);
DROP INDEX IF EXISTS commercial_plan_version_uq;
