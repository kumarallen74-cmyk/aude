-- 030: fleet billing follow-ups — credit notes, and the fleet customer portal.
--
--   Credit notes   a numbered document crediting all or part of an issued (or paid)
--                  fleet invoice: it reduces what is still owed on that invoice, or,
--                  once paid, is refunded or deducted from the account's next invoice.
--                  The invoice itself never changes (its figures match the faktur).
--   Fleet portal   fleet customers' own staff sign in and see their invoices, credit
--                  notes, this month's charging and their cards. Granted per fleet
--                  account: user_role.scope_type 'fleet', scope_id = fleet_account.id
--                  (role fleet_customer, provisioned by the application).
--
-- Additive: existing invoices have nothing credited.

CREATE TABLE IF NOT EXISTS fleet_credit_note (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organisation(id),
  fleet_account_id   UUID NOT NULL REFERENCES fleet_account(id),
  invoice_id         UUID NOT NULL REFERENCES fleet_invoice(id),
  number             TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'void')),
  -- invoice: reduces the unpaid balance of the credited invoice
  -- refund: the invoice was paid; the amount is paid back (refunded_at when done)
  -- next_invoice: the invoice was paid; deducted from the account's next invoice
  settlement         TEXT NOT NULL CHECK (settlement IN ('invoice', 'refund', 'next_invoice')),
  reason             TEXT NOT NULL,
  lines              JSONB NOT NULL,          -- [{ description, amountIdr, taxed, taxBaseIdr, dppIdr, ppnIdr }]
  dpp_idr            BIGINT NOT NULL DEFAULT 0 CHECK (dpp_idr >= 0),
  ppn_idr            BIGINT NOT NULL DEFAULT 0 CHECK (ppn_idr >= 0),
  total_idr          BIGINT NOT NULL CHECK (total_idr > 0),
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  issued_by          TEXT,
  refunded_at        DATE,
  refund_reference   TEXT,
  applied_invoice_id UUID REFERENCES fleet_invoice(id),
  voided_at          TIMESTAMPTZ,
  void_reason        TEXT,
  sent_at            TIMESTAMPTZ,
  sent_to            TEXT,
  UNIQUE (org_id, number)
);
CREATE INDEX IF NOT EXISTS fleet_credit_note_invoice_idx ON fleet_credit_note (invoice_id);
CREATE INDEX IF NOT EXISTS fleet_credit_note_open_idx ON fleet_credit_note (fleet_account_id)
  WHERE status = 'issued' AND settlement = 'next_invoice' AND applied_invoice_id IS NULL;

ALTER TABLE fleet_invoice
  -- credit notes settled against this invoice (settlement 'invoice')
  ADD COLUMN IF NOT EXISTS credited_idr      BIGINT NOT NULL DEFAULT 0,
  -- earlier credit notes deducted from this invoice (settlement 'next_invoice')
  ADD COLUMN IF NOT EXISTS prior_credit_idr  BIGINT NOT NULL DEFAULT 0;

-- A fleet customer can block a lost card from the portal, and unblock only a card
-- it blocked itself (never one the operator blocked, e.g. for non-payment).
ALTER TABLE token ADD COLUMN IF NOT EXISTS customer_blocked_at TIMESTAMPTZ;

DO $$
BEGIN
  EXECUTE 'ALTER TABLE fleet_credit_note ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE fleet_credit_note FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS fleet_credit_note_tenant ON fleet_credit_note';
  EXECUTE $p$
    CREATE POLICY fleet_credit_note_tenant ON fleet_credit_note
      USING (app_current_org() IS NULL OR org_id = app_current_org())
      WITH CHECK (app_current_org() IS NULL OR org_id = app_current_org())
  $p$;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO plugsure_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plugsure_app;
