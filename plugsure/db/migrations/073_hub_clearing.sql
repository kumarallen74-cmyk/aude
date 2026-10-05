-- 073: PlugSure Hub — clearing and settlement (docs/HUB-DESIGN.md §3.3, §8, WP H2; "H2 as built").
--
-- Additive only: new hub_* clearing tables, three nullable / constant-default columns on 072's hub tables
-- (no rewrite), placeholder rows for the PlugSure invoicing entities and zero-rate default fee plans
-- (TODO(commercial): the owner sets the real values). Nothing reads these tables while HUB_ENABLED=false.
-- Rollback: db/rollback/073_down.sql (refuses while the ledger holds rows).
--
-- Money: every amount is an integer in PlugSure minor units of the row's currency (domain/money.ts:
-- IDR whole rupiah, MYR sen, SGD cents). Currencies never mix: no FX anywhere.
--
-- RLS (§3.1, the 048 shape): two-sided rows (CDRs, disputes, notes, positions, payments) are visible to both
-- members' organisations; statements and fee invoices to their member's organisation; fee plans, runs and
-- document sequences to the platform (unscoped) only.

-- ───────────────────────────────────────────── additions to 072's tables
ALTER TABLE hub_entity    ADD COLUMN IF NOT EXISTS placeholder BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE hub_entity    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
-- Payee bank details shown on counterparties' statements (sealed: services/secrets.ts, AAD hub_member:{id}:bank).
ALTER TABLE hub_member    ADD COLUMN IF NOT EXISTS bank_details TEXT;
-- Per-agreement dispute window (days after receipt); null = HUB_DISPUTE_DAYS.
ALTER TABLE hub_agreement ADD COLUMN IF NOT EXISTS dispute_days INTEGER CHECK (dispute_days BETWEEN 1 AND 90);

-- The PlugSure entities that issue hub fee invoices. PLACEHOLDERS until the owner confirms which entities
-- exist ([OWNER] 14.1-1); documents issued from a placeholder entity say so. Editable: PUT /v1/hub/clearing/entities/:country.
INSERT INTO hub_entity (country_code, legal_name, tax_id, tax_registered, address, invoice_prefix, placeholder) VALUES
  ('ID', 'PT PlugSure Hub Indonesia [PLACEHOLDER]', NULL, true,  'Jakarta, Indonesia [PLACEHOLDER]', 'PSH-ID-', true),
  ('MY', 'PlugSure Hub Sdn Bhd [PLACEHOLDER]',      NULL, false, 'Kuala Lumpur, Malaysia [PLACEHOLDER]', 'PSH-MY-', true),
  ('SG', 'PlugSure Hub Pte Ltd [PLACEHOLDER]',      NULL, false, 'Singapore [PLACEHOLDER]', 'PSH-SG-', true)
ON CONFLICT (country_code) DO NOTHING;

-- ───────────────────────────────────────────── hub commission (fees)
CREATE TABLE IF NOT EXISTS hub_fee_plan (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  currency         TEXT NOT NULL CHECK (currency IN ('IDR','MYR','SGD')),
  -- charged to the CPO side, on total_cost.excl_vat of each accepted CDR
  cpo_bps          INTEGER NOT NULL DEFAULT 0 CHECK (cpo_bps BETWEEN 0 AND 5000),
  cpo_fixed_minor  BIGINT  NOT NULL DEFAULT 0 CHECK (cpo_fixed_minor >= 0),
  cpo_min_minor    BIGINT  NOT NULL DEFAULT 0 CHECK (cpo_min_minor >= 0),
  cpo_max_minor    BIGINT  CHECK (cpo_max_minor IS NULL OR cpo_max_minor >= cpo_min_minor),
  -- charged to the eMSP side
  emsp_bps         INTEGER NOT NULL DEFAULT 0 CHECK (emsp_bps BETWEEN 0 AND 5000),
  emsp_fixed_minor BIGINT  NOT NULL DEFAULT 0 CHECK (emsp_fixed_minor >= 0),
  emsp_min_minor   BIGINT  NOT NULL DEFAULT 0 CHECK (emsp_min_minor >= 0),
  emsp_max_minor   BIGINT  CHECK (emsp_max_minor IS NULL OR emsp_max_minor >= emsp_min_minor),
  is_default       BOOLEAN NOT NULL DEFAULT false,
  effective_from   DATE NOT NULL DEFAULT DATE '2020-01-01',
  notes            TEXT,
  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       UUID,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hub_fee_plan_default_uq ON hub_fee_plan (currency, effective_from) WHERE is_default;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hub_member_fee_fk') THEN
    ALTER TABLE hub_member ADD CONSTRAINT hub_member_fee_fk FOREIGN KEY (fee_plan_id) REFERENCES hub_fee_plan(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hub_agreement_fee_fk') THEN
    ALTER TABLE hub_agreement ADD CONSTRAINT hub_agreement_fee_fk FOREIGN KEY (fee_plan_id) REFERENCES hub_fee_plan(id);
  END IF;
END $$;

-- TODO(commercial): zero-rate placeholders until the owner sets the commission ([OWNER] 14.1-2).
INSERT INTO hub_fee_plan (name, currency, is_default, effective_from, notes)
SELECT 'Default ' || c || ' (placeholder: 0)', c, true, DATE '2020-01-01', 'TODO(commercial): placeholder, no commission until the owner sets the rates'
  FROM unnest(ARRAY['IDR','MYR','SGD']) AS c
 WHERE NOT EXISTS (SELECT 1 FROM hub_fee_plan p WHERE p.currency = c AND p.is_default);

-- Per-currency overrides: an agreement's plan (both sides) beats each member's own plan, which beats the default.
CREATE TABLE IF NOT EXISTS hub_fee_assignment (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id     UUID REFERENCES hub_agreement(id),
  member_id        UUID REFERENCES hub_member(id),
  currency         TEXT NOT NULL CHECK (currency IN ('IDR','MYR','SGD')),
  fee_plan_id      UUID NOT NULL REFERENCES hub_fee_plan(id),
  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((agreement_id IS NULL) <> (member_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS hub_fee_assignment_agreement_uq ON hub_fee_assignment (agreement_id, currency) WHERE agreement_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hub_fee_assignment_member_uq ON hub_fee_assignment (member_id, currency) WHERE member_id IS NOT NULL;

-- ───────────────────────────────────────────── settlement runs (before hub_cdr: it references them)
CREATE TABLE IF NOT EXISTS hub_settlement_run (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  currency        TEXT NOT NULL CHECK (currency IN ('IDR','MYR','SGD')),
  cycle           TEXT NOT NULL DEFAULT 'monthly' CHECK (cycle IN ('monthly','weekly')),
  period          TEXT NOT NULL,                -- '2026-09' (monthly) or '2026-09-07' (weekly: the Monday)
  time_zone       TEXT NOT NULL,                -- the currency's country zone (IDR Asia/Jakarta, MYR Asia/Kuala_Lumpur, SGD Asia/Singapore)
  period_start    TIMESTAMPTZ NOT NULL,
  period_end      TIMESTAMPTZ NOT NULL,         -- exclusive: accepted CDRs RECEIVED before it are settled in this run
  finalisable_at  TIMESTAMPTZ NOT NULL,         -- period_end + dispute days + 1
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalised','void')),
  preview         JSONB NOT NULL DEFAULT '{}',  -- draft: what finalising now would produce
  totals          JSONB NOT NULL DEFAULT '{}',  -- finalised: frozen totals
  ready_alerted_at TIMESTAMPTZ,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalised_by    UUID,
  finalised_at    TIMESTAMPTZ,
  CHECK (period_end > period_start)
);
CREATE UNIQUE INDEX IF NOT EXISTS hub_settlement_run_live_uq ON hub_settlement_run (currency, cycle, period) WHERE status <> 'void';

-- ───────────────────────────────────────────── the clearing ledger
CREATE TABLE IF NOT EXISTS hub_cdr (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cpo_party_id       UUID NOT NULL REFERENCES hub_party(id),
  emsp_party_id      UUID NOT NULL REFERENCES hub_party(id),
  cpo_member_id      UUID NOT NULL REFERENCES hub_member(id),
  emsp_member_id     UUID NOT NULL REFERENCES hub_member(id),
  cpo_org_id         UUID NOT NULL REFERENCES organisation(id),
  emsp_org_id        UUID NOT NULL REFERENCES organisation(id),
  agreement_id       UUID REFERENCES hub_agreement(id),
  cdr_id             TEXT NOT NULL CHECK (length(cdr_id) BETWEEN 1 AND 39),
  session_id         TEXT,
  credit             BOOLEAN NOT NULL DEFAULT false,
  credit_reference_id TEXT,
  credits_cdr_id     UUID REFERENCES hub_cdr(id),   -- a credit CDR: the original it offsets
  credited_by_cdr_id UUID REFERENCES hub_cdr(id),   -- an original: the credit CDR that offset it
  currency           TEXT NOT NULL,                 -- as received (an unsupported one is held)
  total_excl_minor   BIGINT NOT NULL,               -- signed: a credit CDR is negative
  total_incl_minor   BIGINT,                        -- null when incl_vat is absent (flag no_incl_vat)
  total_excl_raw     NUMERIC(18,4) NOT NULL,        -- as received, audit
  total_incl_raw     NUMERIC(18,4),
  energy_kwh         NUMERIC(12,3) NOT NULL,        -- signed like the amounts
  start_at           TIMESTAMPTZ NOT NULL,
  end_at             TIMESTAMPTZ NOT NULL,
  location_country   TEXT,                          -- alpha-3 from cdr_location.country
  location_id        TEXT,
  evse_uid           TEXT,
  auth_method        TEXT,
  authorization_reference TEXT,
  token_type         TEXT,
  token_uid_hash     TEXT,                          -- sha-256(uid); the uid itself only inside body
  contract_id        TEXT,
  body               JSONB NOT NULL,                -- the CDR as routed (financial record)
  source             TEXT NOT NULL CHECK (source IN ('push','pull')),
  routing            JSONB NOT NULL DEFAULT '{}',   -- correlation / request ids, route, connections, hub Location
  flags              TEXT[] NOT NULL DEFAULT '{}',
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('held','pending','disputed','accepted','credited','written_off','void')),
  dispute_deadline   TIMESTAMPTZ NOT NULL,
  accepted_at        TIMESTAMPTZ,
  forward_state      TEXT NOT NULL DEFAULT 'pending' CHECK (forward_state IN ('pending','delivered','failed','not_needed')),
  fee_cpo_plan_id    UUID REFERENCES hub_fee_plan(id),
  fee_emsp_plan_id   UUID REFERENCES hub_fee_plan(id),
  fee_cpo_minor      BIGINT,                        -- frozen when the CDR becomes payable
  fee_emsp_minor     BIGINT,
  settlement_run_id  UUID REFERENCES hub_settlement_run(id),
  hold_note          TEXT,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cpo_party_id, cdr_id)
);
CREATE INDEX IF NOT EXISTS hub_cdr_status_idx ON hub_cdr (status, dispute_deadline);
CREATE INDEX IF NOT EXISTS hub_cdr_emsp_idx ON hub_cdr (emsp_org_id, received_at DESC);
CREATE INDEX IF NOT EXISTS hub_cdr_cpo_idx  ON hub_cdr (cpo_org_id, received_at DESC);
CREATE INDEX IF NOT EXISTS hub_cdr_received_idx ON hub_cdr (received_at DESC, id);
CREATE INDEX IF NOT EXISTS hub_cdr_session_idx ON hub_cdr (cpo_party_id, session_id) WHERE NOT credit;
CREATE INDEX IF NOT EXISTS hub_cdr_token_idx ON hub_cdr (token_uid_hash, start_at) WHERE NOT credit;
CREATE INDEX IF NOT EXISTS hub_cdr_unsettled_idx ON hub_cdr (currency, received_at) WHERE settlement_run_id IS NULL AND status IN ('accepted','credited');
CREATE INDEX IF NOT EXISTS hub_cdr_run_idx ON hub_cdr (settlement_run_id) WHERE settlement_run_id IS NOT NULL;

-- ───────────────────────────────────────────── disputes
CREATE TABLE IF NOT EXISTS hub_dispute (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hub_cdr_id       UUID NOT NULL REFERENCES hub_cdr(id),
  cpo_member_id    UUID NOT NULL REFERENCES hub_member(id),
  emsp_member_id   UUID NOT NULL REFERENCES hub_member(id),
  cpo_org_id       UUID NOT NULL,
  emsp_org_id      UUID NOT NULL,
  raised_by        TEXT NOT NULL CHECK (raised_by IN ('emsp','platform')),
  reason           TEXT NOT NULL CHECK (reason IN ('unknown_token','not_authorized','duplicate','amount','energy',
                                                  'tariff_mismatch','session_not_found','other')),
  currency         TEXT NOT NULL,
  claimed_minor    BIGINT,                         -- what the disputer considers correct (optional)
  message          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','accepted','rejected','escalated','credited','expired','resolved','withdrawn')),
  -- final outcome: credited (a credit CDR arrived), upheld (the CDR stands), written_off (the CPO is not paid)
  resolution       TEXT CHECK (resolution IN ('credited','upheld','written_off')),
  respond_by       TIMESTAMPTZ NOT NULL,           -- the CPO answers by then, or the dispute is escalated
  credit_due_by    TIMESTAMPTZ,                    -- accepted: the credit CDR is due by then, or escalated
  escalate_by      TIMESTAMPTZ,                    -- rejected: the eMSP may escalate until then, else it expires
  credit_cdr_id    UUID REFERENCES hub_cdr(id),
  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by      UUID,
  resolved_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS hub_dispute_live_uq ON hub_dispute (hub_cdr_id) WHERE status IN ('open','accepted','rejected','escalated');
CREATE INDEX IF NOT EXISTS hub_dispute_status_idx ON hub_dispute (status, respond_by);

-- Evidence and the history of every transition (append-only by convention; every row is also audited).
CREATE TABLE IF NOT EXISTS hub_dispute_note (
  id               BIGSERIAL PRIMARY KEY,
  dispute_id       UUID NOT NULL REFERENCES hub_dispute(id),
  cpo_org_id       UUID NOT NULL,
  emsp_org_id      UUID NOT NULL,
  side             TEXT NOT NULL CHECK (side IN ('cpo','emsp','platform','system')),
  kind             TEXT NOT NULL CHECK (kind IN ('raised','accepted','rejected','escalated','withdrawn','resolved','credited','expired','note')),
  author_id        UUID,
  body             TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hub_dispute_note_idx ON hub_dispute_note (dispute_id, id);

-- ───────────────────────────────────────────── settlement output
-- Bilateral net position per member pair and run (a < b in uuid order).
CREATE TABLE IF NOT EXISTS hub_settlement_position (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           UUID NOT NULL REFERENCES hub_settlement_run(id),
  currency         TEXT NOT NULL,
  member_a_id      UUID NOT NULL REFERENCES hub_member(id),
  member_b_id      UUID NOT NULL REFERENCES hub_member(id),
  org_a_id         UUID NOT NULL,
  org_b_id         UUID NOT NULL,
  a_owes_b_minor   BIGINT NOT NULL,   -- Σ CDR totals (incl. VAT; excl. when absent) where B is CPO and A eMSP
  b_owes_a_minor   BIGINT NOT NULL,
  net_minor        BIGINT NOT NULL CHECK (net_minor >= 0),
  payer_member_id  UUID REFERENCES hub_member(id),            -- null when net = 0
  payee_member_id  UUID REFERENCES hub_member(id),
  payer_org_id     UUID,
  payee_org_id     UUID,
  cdr_count        INTEGER NOT NULL,
  paid_minor       BIGINT NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partially_paid','paid','confirmed','overdue','written_off','nothing_due')),
  due_date         DATE NOT NULL,
  overdue_since    DATE,
  reminders_sent   INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (member_a_id < member_b_id),
  UNIQUE (run_id, member_a_id, member_b_id)
);
CREATE INDEX IF NOT EXISTS hub_position_open_idx ON hub_settlement_position (status, due_date) WHERE status IN ('open','partially_paid','overdue');

CREATE TABLE IF NOT EXISTS hub_statement (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           UUID NOT NULL REFERENCES hub_settlement_run(id),
  member_id        UUID NOT NULL REFERENCES hub_member(id),
  org_id           UUID NOT NULL,
  currency         TEXT NOT NULL,
  period           TEXT NOT NULL,
  period_start     TIMESTAMPTZ NOT NULL,
  period_end       TIMESTAMPTZ NOT NULL,
  number           TEXT NOT NULL UNIQUE,          -- 'PSH-ST-2026-IDR-000123'
  receivable_minor BIGINT NOT NULL,               -- as CPO
  payable_minor    BIGINT NOT NULL,               -- as eMSP
  net_minor        BIGINT NOT NULL,               -- receivable − payable (= Σ of its bilateral nets)
  fee_net_minor    BIGINT NOT NULL,               -- hub commission for the run, excl. tax (invoiced separately)
  fee_invoice_id   UUID,
  cdr_count        INTEGER NOT NULL,
  data             JSONB NOT NULL,                -- frozen rendering data (counterparties, CDRs, carried items)
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, member_id)
);

CREATE TABLE IF NOT EXISTS hub_fee_invoice (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id        UUID NOT NULL REFERENCES hub_member(id),
  org_id           UUID NOT NULL,
  entity_country   TEXT NOT NULL REFERENCES hub_entity(country_code),
  run_id           UUID REFERENCES hub_settlement_run(id),
  currency         TEXT NOT NULL,
  number           TEXT NOT NULL UNIQUE,
  net_minor        BIGINT NOT NULL,
  tax_scheme       TEXT NOT NULL CHECK (tax_scheme IN ('ID_PPN','SG_GST','MY_SST','NONE','REVERSE_CHARGE')),
  tax_rate_bps     INTEGER NOT NULL DEFAULT 0,
  tax_base_minor   BIGINT NOT NULL,
  tax_minor        BIGINT NOT NULL,
  total_minor      BIGINT NOT NULL,
  wht_expected_minor BIGINT NOT NULL DEFAULT 0,   -- ID PPh 23 (2 %) an Indonesian member withholds
  status           TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','paid','void')),
  due_date         DATE NOT NULL,
  data             JSONB NOT NULL,                -- frozen rendering data (issuer, buyer, lines, flags)
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at          DATE,
  paid_reference   TEXT,
  UNIQUE (run_id, member_id)
);

CREATE TABLE IF NOT EXISTS hub_payment (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id      UUID NOT NULL REFERENCES hub_settlement_position(id),
  payer_member_id  UUID NOT NULL, payee_member_id UUID NOT NULL,
  payer_org_id     UUID NOT NULL, payee_org_id UUID NOT NULL,
  currency         TEXT NOT NULL,
  amount_minor     BIGINT NOT NULL CHECK (amount_minor > 0),
  method           TEXT NOT NULL CHECK (method IN ('bank_transfer','stripe_connect','xendit','other')),
  reference        TEXT,
  paid_at          DATE NOT NULL,
  recorded_by      UUID,
  recorded_side    TEXT NOT NULL CHECK (recorded_side IN ('payer','payee','platform')),
  confirmed_by_payee_at TIMESTAMPTZ,
  confirmed_by     UUID,
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hub_payment_position_idx ON hub_payment (position_id);

-- Gapless document numbers (statements, fee invoices per entity), taken under a row lock.
CREATE TABLE IF NOT EXISTS hub_doc_seq (
  key   TEXT PRIMARY KEY,
  last  BIGINT NOT NULL DEFAULT 0
);

-- ───────────────────────────────────────────── row-level security (048 shape)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hub_fee_plan','hub_fee_assignment','hub_settlement_run','hub_doc_seq'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_platform', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass()) WITH CHECK (app_rls_bypass())', t || '_platform', t);
  END LOOP;
  -- Two-sided: the CPO's and the eMSP's organisations.
  FOREACH t IN ARRAY ARRAY['hub_cdr','hub_dispute','hub_dispute_note'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR cpo_org_id = app_current_org() OR emsp_org_id = app_current_org()) '
                   'WITH CHECK (app_rls_bypass() OR cpo_org_id = app_current_org() OR emsp_org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['hub_statement','hub_fee_invoice'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) '
                   'WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

ALTER TABLE hub_settlement_position ENABLE ROW LEVEL SECURITY;
ALTER TABLE hub_settlement_position FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hub_settlement_position_tenant ON hub_settlement_position;
CREATE POLICY hub_settlement_position_tenant ON hub_settlement_position
  USING (app_rls_bypass() OR org_a_id = app_current_org() OR org_b_id = app_current_org())
  WITH CHECK (app_rls_bypass() OR org_a_id = app_current_org() OR org_b_id = app_current_org());

ALTER TABLE hub_payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE hub_payment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hub_payment_tenant ON hub_payment;
CREATE POLICY hub_payment_tenant ON hub_payment
  USING (app_rls_bypass() OR payer_org_id = app_current_org() OR payee_org_id = app_current_org())
  WITH CHECK (app_rls_bypass() OR payer_org_id = app_current_org() OR payee_org_id = app_current_org());

GRANT SELECT, INSERT, UPDATE, DELETE ON hub_fee_plan, hub_fee_assignment, hub_settlement_run, hub_cdr, hub_dispute, hub_dispute_note,
  hub_settlement_position, hub_statement, hub_fee_invoice, hub_payment, hub_doc_seq TO plugsure_app;
GRANT USAGE, SELECT ON SEQUENCE hub_dispute_note_id_seq TO plugsure_app;
