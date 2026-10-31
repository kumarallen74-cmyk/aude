-- 088 (v1.20.0) finance phase 9.
--
--   site_energy_rate        a site's electricity cost per kWh (the PLN tariff the operator pays, incl. taxes), used for
--                           months without a recorded bill
--   site_energy_cost        a site's electricity bill for a month (amount, kWh billed); one live per site and month,
--                           voided with a reason, never deleted. Allocated to sessions by kWh (services/energy-margin.ts)
--   finance_budget          monthly budget lines per organisation (site_id NULL) or site: revenue, energy cost, gateway
--                           fees, owner share
--   finance_org_settings    per organisation: the budget variance alert threshold, and collections (dunning): on or
--                           off, the reminder steps (days relative to the due date), the channels, the WhatsApp template
--   receivable_note         notes and promises to pay on a receivable (a fleet invoice; for the platform, an operator's
--                           statement to PlugSure)
--   dunning_reminder        each reminder sent (or failed), once per receivable, step and channel
--   receivable_write_off    a request to write off what is outstanding, approved by a second person
--
-- Additive. Rollback: db/rollback/088_down.sql.

CREATE TABLE IF NOT EXISTS site_energy_rate (
  site_id       UUID PRIMARY KEY REFERENCES site(id) ON DELETE CASCADE,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  rate_per_kwh  NUMERIC(12,4) NOT NULL CHECK (rate_per_kwh >= 0),
  currency      TEXT NOT NULL,
  updated_by    UUID REFERENCES app_user(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS site_energy_cost (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  site_id       UUID NOT NULL REFERENCES site(id),
  month         TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  amount_minor  BIGINT NOT NULL CHECK (amount_minor >= 0),
  kwh_billed    NUMERIC(14,3) CHECK (kwh_billed IS NULL OR kwh_billed >= 0),
  currency      TEXT NOT NULL,
  reference     TEXT,
  note          TEXT,
  recorded_by   UUID REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at     TIMESTAMPTZ,
  voided_by     UUID REFERENCES app_user(id),
  void_reason   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS site_energy_cost_live_uq ON site_energy_cost (site_id, month) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS site_energy_cost_org_idx ON site_energy_cost (org_id, month DESC);

CREATE TABLE IF NOT EXISTS finance_budget (
  id                  BIGSERIAL PRIMARY KEY,
  org_id              UUID NOT NULL REFERENCES organisation(id),
  site_id             UUID REFERENCES site(id),
  month               TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  currency            TEXT NOT NULL,
  revenue_minor       BIGINT NOT NULL DEFAULT 0 CHECK (revenue_minor >= 0),
  energy_cost_minor   BIGINT NOT NULL DEFAULT 0 CHECK (energy_cost_minor >= 0),
  fees_minor          BIGINT NOT NULL DEFAULT 0 CHECK (fees_minor >= 0),
  owner_share_minor   BIGINT NOT NULL DEFAULT 0 CHECK (owner_share_minor >= 0),
  updated_by          UUID REFERENCES app_user(id),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_budget_uq ON finance_budget (org_id, COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid), month, currency);

CREATE TABLE IF NOT EXISTS finance_org_settings (
  org_id              UUID PRIMARY KEY REFERENCES organisation(id),
  budget_alert_pct    INT NOT NULL DEFAULT 15 CHECK (budget_alert_pct BETWEEN 1 AND 100),
  dunning_enabled     BOOLEAN NOT NULL DEFAULT false,
  dunning_steps       INT[] NOT NULL DEFAULT '{-3,7,14,30}',
  dunning_channels    TEXT[] NOT NULL DEFAULT '{email}',
  wa_template_name    TEXT,
  wa_template_lang    TEXT,
  updated_by          UUID REFERENCES app_user(id),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS receivable_note (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  kind          TEXT NOT NULL CHECK (kind IN ('fleet_invoice', 'platform_statement')),
  ref           TEXT NOT NULL,
  note          TEXT NOT NULL,
  promise_date  DATE,
  created_by    UUID REFERENCES app_user(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS receivable_note_ref_idx ON receivable_note (kind, ref, created_at DESC);

CREATE TABLE IF NOT EXISTS dunning_reminder (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organisation(id),
  kind          TEXT NOT NULL CHECK (kind IN ('fleet_invoice', 'platform_statement')),
  ref           TEXT NOT NULL,
  step          INT NOT NULL,
  channel       TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  destination   TEXT,
  ok            BOOLEAN NOT NULL,
  error         TEXT,
  manual        BOOLEAN NOT NULL DEFAULT false,
  sent_by       UUID REFERENCES app_user(id),
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A scheduled step goes once per receivable and channel (a failure is recorded and not retried by the schedule).
CREATE UNIQUE INDEX IF NOT EXISTS dunning_reminder_step_uq ON dunning_reminder (kind, ref, step, channel) WHERE NOT manual;
CREATE INDEX IF NOT EXISTS dunning_reminder_ref_idx ON dunning_reminder (kind, ref, sent_at DESC);

CREATE TABLE IF NOT EXISTS receivable_write_off (
  id              BIGSERIAL PRIMARY KEY,
  org_id          UUID NOT NULL REFERENCES organisation(id),
  kind            TEXT NOT NULL CHECK (kind IN ('fleet_invoice', 'platform_statement')),
  ref             TEXT NOT NULL,
  amount_minor    BIGINT NOT NULL CHECK (amount_minor > 0),
  currency        TEXT NOT NULL,
  reason          TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected')),
  requested_by    UUID REFERENCES app_user(id),
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by      UUID REFERENCES app_user(id),
  decided_at      TIMESTAMPTZ,
  decision_note   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS receivable_write_off_open_uq ON receivable_write_off (kind, ref) WHERE state IN ('pending', 'approved');

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['site_energy_rate', 'site_energy_cost', 'finance_budget', 'finance_org_settings', 'receivable_note', 'dunning_reminder', 'receivable_write_off'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (app_rls_bypass() OR org_id = app_current_org()) WITH CHECK (app_rls_bypass() OR org_id = app_current_org())', t || '_tenant', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugsure_app') THEN
    GRANT SELECT, INSERT, UPDATE ON site_energy_rate, site_energy_cost, finance_budget, finance_org_settings, receivable_note, dunning_reminder, receivable_write_off TO plugsure_app;
    REVOKE DELETE, TRUNCATE ON site_energy_rate, site_energy_cost, finance_budget, finance_org_settings, receivable_note, dunning_reminder, receivable_write_off FROM plugsure_app;
    GRANT USAGE, SELECT ON SEQUENCE site_energy_cost_id_seq, finance_budget_id_seq, receivable_note_id_seq, dunning_reminder_id_seq, receivable_write_off_id_seq TO plugsure_app;
  END IF;
END $$;
