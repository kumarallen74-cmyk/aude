-- 047: OCPI trust boundaries (eMSP side and roaming approvals).
--
--   ocpi_remote_cdr.status     a partner's charge record is 'accepted' (billed to the
--                              fleet, counts against card limits), 'held' for operator
--                              review (no matching session or approval of ours, or
--                              implausible totals), or 'rejected' by the operator.
--                              Held and rejected records are left off fleet invoices
--                              and card limits until an operator accepts them.
--   ocpi_emsp_authorization    the authorization_reference we gave a CPO when it asked
--                              whether one of our cards may charge (real-time
--                              authorisation). A CDR quoting it is linked to us.
--   ocpi_authorization.charge_point_id
--                              the charger an approval (START_SESSION, RESERVE_NOW,
--                              real-time "allowed") is for: an approval is only used
--                              at that charger.
--
-- Existing charge records keep counting: they are marked 'accepted'.

ALTER TABLE ocpi_remote_cdr
  ADD COLUMN IF NOT EXISTS status       TEXT NOT NULL DEFAULT 'accepted',
  ADD COLUMN IF NOT EXISTS hold_reason  TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_by  UUID,
  ADD COLUMN IF NOT EXISTS reviewed_at  TIMESTAMPTZ;
ALTER TABLE ocpi_remote_cdr DROP CONSTRAINT IF EXISTS ocpi_remote_cdr_status_check;
ALTER TABLE ocpi_remote_cdr ADD CONSTRAINT ocpi_remote_cdr_status_check CHECK (status IN ('accepted', 'held', 'rejected'));
CREATE INDEX IF NOT EXISTS ocpi_remote_cdr_held_idx ON ocpi_remote_cdr (org_id, received_at DESC) WHERE status = 'held';

CREATE TABLE IF NOT EXISTS ocpi_emsp_authorization (
  id                       BIGSERIAL PRIMARY KEY,
  org_id                   UUID NOT NULL REFERENCES organisation(id),
  partner_id               UUID NOT NULL REFERENCES ocpi_partner(id) ON DELETE CASCADE,
  token_id                 UUID NOT NULL REFERENCES token(id) ON DELETE CASCADE,
  authorization_reference  TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ocpi_emsp_authorization_ref_idx ON ocpi_emsp_authorization (partner_id, authorization_reference);

ALTER TABLE ocpi_authorization ADD COLUMN IF NOT EXISTS charge_point_id UUID REFERENCES charge_point(id) ON DELETE CASCADE;

ALTER TABLE ocpi_emsp_authorization ENABLE ROW LEVEL SECURITY;
ALTER TABLE ocpi_emsp_authorization FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ocpi_emsp_authorization_tenant ON ocpi_emsp_authorization;
CREATE POLICY ocpi_emsp_authorization_tenant ON ocpi_emsp_authorization
  USING (app_current_org() IS NULL OR org_id = app_current_org())
  WITH CHECK (app_current_org() IS NULL OR org_id = app_current_org());

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
