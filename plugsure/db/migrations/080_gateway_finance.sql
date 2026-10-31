-- 080: Finance — the payment gateway's side of the money (v1.12.0).
--
--   gateway_transaction        one row per transaction at a payment gateway (Xendit: GET /transactions), per payments
--                              integration: payments, refunds, payouts, with the gateway's FEE, VAT, withholding tax,
--                              net amount, and settlement status / time; matched to PlugSure's payment_intent (or
--                              subscription_charge) by the reference PlugSure gave the gateway. Amounts are in the
--                              gateway's unit (rupiah) with two decimals: fees and VAT on fees are not whole rupiah.
--   gateway_balance_snapshot   the gateway's balance (Xendit cash account), hourly.
--   gateway_sync_state         where each integration's transaction sync got to, and how its last run went.
--   reconciliation_exception   what the daily reconciliation found: paid at the gateway but not in PlugSure, amounts
--                              that differ, settlements overdue, refunds out of step. Open until resolved (audited).
--
-- Rows belong to the integration's organisation: org_id NULL = the platform's own gateway account (readable only
-- unscoped, i.e. by platform code paths), else the operator's own account. Additive and idempotent.
-- Rollback: db/rollback/080_down.sql.

CREATE TABLE IF NOT EXISTS gateway_transaction (
  id                       BIGSERIAL PRIMARY KEY,
  integration_id           UUID NOT NULL REFERENCES integration(id) ON DELETE CASCADE,
  org_id                   UUID REFERENCES organisation(id),
  provider                 TEXT NOT NULL,
  external_id              TEXT NOT NULL,
  -- payment | refund | payout | transfer | fee | other (the gateway's type, normalised); gateway_type keeps its word.
  kind                     TEXT NOT NULL CHECK (kind IN ('payment', 'refund', 'payout', 'transfer', 'fee', 'other')),
  gateway_type             TEXT,
  -- success | pending | failed | voided | reversed
  status                   TEXT NOT NULL,
  cashflow                 TEXT NOT NULL CHECK (cashflow IN ('in', 'out')),
  channel_category         TEXT,
  channel_code             TEXT,
  reference_id             TEXT,
  product_id               TEXT,
  currency                 TEXT NOT NULL DEFAULT 'IDR',
  amount                   NUMERIC(18,2) NOT NULL,
  fee                      NUMERIC(18,2) NOT NULL DEFAULT 0,
  vat                      NUMERIC(18,2) NOT NULL DEFAULT 0,
  withholding_tax          NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_amount               NUMERIC(18,2),
  -- pending | settled | early_settled | NULL (not applicable: money out, or not determined yet)
  settlement_status        TEXT,
  estimated_settlement_at  TIMESTAMPTZ,
  -- When the sync first saw it settled (the gateway reports a status, not a time).
  settled_seen_at          TIMESTAMPTZ,
  gateway_created_at       TIMESTAMPTZ NOT NULL,
  gateway_updated_at       TIMESTAMPTZ NOT NULL,
  payment_intent_id        UUID REFERENCES payment_intent(id) ON DELETE SET NULL,
  subscription_charge_id   UUID,
  -- How it was matched: intent (payment_intent.provider_ref), refund (payment_intent.refund_ref), pass, or NULL.
  matched                  TEXT,
  raw                      JSONB NOT NULL DEFAULT '{}'::jsonb,
  synced_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (integration_id, external_id)
);
CREATE INDEX IF NOT EXISTS gateway_transaction_created_idx ON gateway_transaction (integration_id, gateway_created_at DESC);
CREATE INDEX IF NOT EXISTS gateway_transaction_settle_idx ON gateway_transaction (integration_id, estimated_settlement_at) WHERE settlement_status = 'pending';
CREATE INDEX IF NOT EXISTS gateway_transaction_ref_idx ON gateway_transaction (provider, reference_id);
CREATE INDEX IF NOT EXISTS gateway_transaction_intent_idx ON gateway_transaction (payment_intent_id) WHERE payment_intent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS gateway_balance_snapshot (
  id              BIGSERIAL PRIMARY KEY,
  integration_id  UUID NOT NULL REFERENCES integration(id) ON DELETE CASCADE,
  org_id          UUID REFERENCES organisation(id),
  account_type    TEXT NOT NULL DEFAULT 'CASH',
  currency        TEXT NOT NULL DEFAULT 'IDR',
  balance         NUMERIC(18,2) NOT NULL,
  taken_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gateway_balance_snapshot_idx ON gateway_balance_snapshot (integration_id, taken_at DESC);

CREATE TABLE IF NOT EXISTS gateway_sync_state (
  integration_id   UUID PRIMARY KEY REFERENCES integration(id) ON DELETE CASCADE,
  org_id           UUID REFERENCES organisation(id),
  -- The newest gateway "updated" time synced: the next run asks for everything updated since (minus a margin).
  watermark        TIMESTAMPTZ,
  -- A run that stopped on its page limit: where the next run continues (pages come newest first), with the
  -- watermark it started from. NULL when the last run reached the end.
  resume_after_id  TEXT,
  resume_from      TIMESTAMPTZ,
  last_run_at      TIMESTAMPTZ,
  last_ok          BOOLEAN,
  last_error       TEXT,
  last_rows        INTEGER,
  last_reconciled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS reconciliation_exception (
  id                      BIGSERIAL PRIMARY KEY,
  integration_id          UUID NOT NULL REFERENCES integration(id) ON DELETE CASCADE,
  org_id                  UUID REFERENCES organisation(id),
  kind                    TEXT NOT NULL CHECK (kind IN (
                            'missing_in_plugsure', 'missing_at_gateway', 'amount_mismatch', 'pending_too_long',
                            'settlement_overdue', 'refund_mismatch')),
  -- What it is about, unique per kind while it stays the same problem: the gateway transaction or PlugSure payment.
  ref_key                 TEXT NOT NULL,
  gateway_transaction_id  BIGINT REFERENCES gateway_transaction(id) ON DELETE SET NULL,
  payment_intent_id       UUID REFERENCES payment_intent(id) ON DELETE SET NULL,
  amount                  NUMERIC(18,2),
  detail                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  state                   TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
  resolution              TEXT,
  resolved_by             UUID,
  resolved_at             TIMESTAMPTZ,
  first_seen_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (integration_id, kind, ref_key)
);
CREATE INDEX IF NOT EXISTS reconciliation_exception_open_idx ON reconciliation_exception (integration_id, state, last_seen_at DESC);

-- Tenant isolation, the post-048 shape: an operator's scope sees its own account's rows; the platform account's rows
-- (org_id NULL) only unscoped. Every finance query runs unscoped and filters by the integrations the caller may see.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['gateway_transaction', 'gateway_balance_snapshot', 'gateway_sync_state', 'reconciliation_exception'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

-- No blanket GRANT (see 053/055/070/076): exactly what src/services/finance.ts and retention.ts use.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON gateway_transaction, gateway_sync_state, reconciliation_exception TO plugsure_app;
    -- Default privileges would give more: the ledger and the reconciliation are never deleted by the application.
    REVOKE DELETE, TRUNCATE ON gateway_transaction, gateway_sync_state, reconciliation_exception FROM plugsure_app;
    GRANT SELECT, INSERT, DELETE ON gateway_balance_snapshot TO plugsure_app;
    REVOKE UPDATE, TRUNCATE ON gateway_balance_snapshot FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE gateway_transaction_id_seq, gateway_balance_snapshot_id_seq, reconciliation_exception_id_seq TO plugsure_app;
  END IF;
END $$;
