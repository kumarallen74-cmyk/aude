-- PlugSure core schema (PostgreSQL 16)
-- Money is stored as INTEGER rupiah (IDR has no practical subunit).
-- Energy is stored as INTEGER watt-hours. Power as INTEGER watts.
-- Rates that need sub-rupiah precision (e.g. Rp 2466.78/kWh) use NUMERIC(14,4).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------- tenancy

CREATE TABLE organisation (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_org_id   UUID REFERENCES organisation(id),
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  npwp            TEXT,
  pkp             BOOLEAN NOT NULL DEFAULT false,   -- registered VAT collector
  iuptlu_number   TEXT,                             -- null when operating under an umbrella licence
  licence_scheme  TEXT,                             -- POSO | POPO | PLPO | PLSO | ROSO | ROPO | RLPO | RLSO | RPOO
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organisation(id),
  phone        TEXT UNIQUE,
  email        TEXT UNIQUE,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID REFERENCES organisation(id),   -- NULL = system role
  name         TEXT NOT NULL,
  permissions  TEXT[] NOT NULL DEFAULT '{}',
  UNIQUE (org_id, name)
);

CREATE TABLE user_role (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role_id     UUID NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  scope_type  TEXT NOT NULL DEFAULT 'org',          -- org | site | fleet
  scope_id    UUID
);
-- A role may be granted once per (user, role, scope). NULL scope_id means org-wide.
CREATE UNIQUE INDEX user_role_unique
  ON user_role (user_id, role_id, scope_type,
                COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------------------------------------------------------------- assets

CREATE TABLE site (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organisation(id),
  name                TEXT NOT NULL,
  address             TEXT,
  kabupaten_kota_code TEXT,          -- 4-digit BPS code, e.g. '3275' = Kota Bekasi
  lat                 DOUBLE PRECISION,
  lon                 DOUBLE PRECISION,
  timezone            TEXT NOT NULL DEFAULT 'Asia/Jakarta',
  -- grid connection
  grid_tariff_group   TEXT,          -- C/TR C/TM C/TT L/TR L/TM L/TT B-2/TR B-3/TM ...
  connected_kva       NUMERIC(10,2), -- subscribed capacity; drives rekening minimum = 40 x kVA x block cost
  phases              SMALLINT NOT NULL DEFAULT 3,
  nominal_voltage_v   INTEGER NOT NULL DEFAULT 400,
  power_factor        NUMERIC(4,3) NOT NULL DEFAULT 0.95,
  -- compliance
  spklu_id            TEXT,          -- e.g. 01.POSO.20.3275.010
  spklu_scheme        TEXT,
  slo_number          TEXT,
  slo_issued_at       DATE,
  slo_expires_at      DATE,
  pbjt_rate_bps       INTEGER NOT NULL DEFAULT 0,   -- basis points, per-municipality; cap 1000 (10%)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON site (org_id);

CREATE TABLE charge_point (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id           UUID NOT NULL REFERENCES site(id),
  ocpp_identity     TEXT NOT NULL UNIQUE,   -- last path segment of the WS URL; often the serial number
  vendor            TEXT,
  model             TEXT,
  serial            TEXT,
  firmware          TEXT,
  ocpp_version      TEXT,                   -- ocpp1.6 | ocpp2.0.1 | ocpp2.1
  security_profile  SMALLINT NOT NULL DEFAULT 0,
  auth_key_hash     TEXT,                   -- never store the AuthorizationKey in plaintext
  status            TEXT NOT NULL DEFAULT 'pending_adoption',
                    -- pending_adoption | provisioning | online | offline | decommissioned
  last_seen_at      TIMESTAMPTZ,
  boot_count        INTEGER NOT NULL DEFAULT 0,
  quirk_profile_id  UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON charge_point (site_id);
CREATE INDEX ON charge_point (status);

CREATE TABLE evse (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_point_id  UUID NOT NULL REFERENCES charge_point(id) ON DELETE CASCADE,
  evse_id          INTEGER NOT NULL,        -- 1-based; 0 addresses the station itself
  max_power_w      INTEGER,
  UNIQUE (charge_point_id, evse_id)
);

CREATE TABLE connector (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evse_uuid              UUID NOT NULL REFERENCES evse(id) ON DELETE CASCADE,
  connector_id           INTEGER NOT NULL DEFAULT 1,
  connector_type         TEXT,              -- cType2 | cCCS2 | cChaDeMo | cGBT | sType2
  current_type           TEXT NOT NULL DEFAULT 'AC',  -- AC | DC
  max_power_w            INTEGER NOT NULL,
  phases                 SMALLINT NOT NULL DEFAULT 3,
  status                 TEXT NOT NULL DEFAULT 'Unavailable',
  status_updated_at      TIMESTAMPTZ,
  error_code             TEXT,
  -- legal-for-trade metrology (Permendag 24/2024; EVSE classified as UTTP since 25 May 2026)
  meter_serial           TEXT,
  meter_accuracy_class   TEXT,              -- '0.5' | '1' | '2.5'
  tera_type_approval_no  TEXT,
  tera_last_at           DATE,
  tera_due_at            DATE,
  tera_status            TEXT NOT NULL DEFAULT 'unknown', -- verified | due_soon | lapsed | unknown
  UNIQUE (evse_uuid, connector_id)
);

CREATE TABLE quirk_profile (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor           TEXT NOT NULL,
  model            TEXT NOT NULL,
  firmware_pattern TEXT NOT NULL DEFAULT '.*',
  findings         JSONB NOT NULL DEFAULT '{}',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vendor, model, firmware_pattern)
);

-- ---------------------------------------------------------------- identity / tokens

CREATE TABLE driver (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organisation(id),
  phone       TEXT,
  name        TEXT,
  email       TEXT,
  npwp        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE token (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organisation(id),
  kind             TEXT NOT NULL,      -- rfid | app | autocharge | emaid | guest
  uid              TEXT NOT NULL,      -- the idTag presented over OCPP
  driver_id        UUID REFERENCES driver(id),
  status           TEXT NOT NULL DEFAULT 'Accepted',  -- Accepted | Blocked | Expired | Invalid
  offline_allowed  BOOLEAN NOT NULL DEFAULT true,
  valid_to         TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, uid)
);
CREATE INDEX ON token (uid);

-- ---------------------------------------------------------------- tariffs

CREATE TABLE tariff (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organisation(id),
  name         TEXT NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'IDR',
  -- PLN formula inputs. Never hardcode a rate: the base is versioned and the
  -- multiplier is set by PLN Direksi decision.
  --   curah (bulk)          = Q x base   where 0.8 <= Q <= 3     base ~ 707
  --   layanan khusus (spec) = N x base   where 1.0 <= N <= 1.5   base ~ 1650 (Q3-2026 published 1645)
  pln_scheme        TEXT,                  -- 'curah' | 'layanan_khusus' | 'none'
  pln_base_rate     NUMERIC(14,4),
  pln_multiplier    NUMERIC(6,3),
  active_from       TIMESTAMPTZ NOT NULL DEFAULT now(),
  active_to         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON tariff (org_id, active_from DESC);

CREATE TABLE tariff_component (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tariff_id     UUID NOT NULL REFERENCES tariff(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,          -- energy | time | session | idle | admin
  rate          NUMERIC(14,4) NOT NULL, -- IDR per kWh | per minute | per session
  tou_block     TEXT NOT NULL DEFAULT 'ANY',  -- WBP | LWBP | ANY
  day_mask      SMALLINT NOT NULL DEFAULT 127, -- bitmask, bit0 = Monday
  time_from     TIME,
  time_to       TIME,
  from_kwh      NUMERIC(10,3) NOT NULL DEFAULT 0,   -- stepped pricing threshold
  from_minutes  INTEGER NOT NULL DEFAULT 0,          -- grace period for idle fees
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tariff_assignment (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tariff_id     UUID NOT NULL REFERENCES tariff(id) ON DELETE CASCADE,
  scope_type    TEXT NOT NULL,          -- org | site | connector | token_group
  scope_id      UUID,
  priority      INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------- sessions

CREATE TABLE charging_session (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL REFERENCES organisation(id),
  site_id              UUID NOT NULL REFERENCES site(id),
  connector_uuid       UUID NOT NULL REFERENCES connector(id),
  charge_point_id      UUID NOT NULL REFERENCES charge_point(id),
  -- Idempotency key. Chargers replay queued transaction messages after an outage,
  -- out of order and with stale timestamps. Never key on receipt time.
  idem_key             TEXT NOT NULL UNIQUE,
  ocpp_transaction_id  TEXT,
  token_id             UUID REFERENCES token(id),
  driver_id            UUID REFERENCES driver(id),
  state                TEXT NOT NULL DEFAULT 'active',  -- active | ended | rated | settled | disputed
  started_at           TIMESTAMPTZ NOT NULL,
  ended_at             TIMESTAMPTZ,
  stop_reason          TEXT,
  meter_start_wh       BIGINT NOT NULL DEFAULT 0,
  meter_stop_wh        BIGINT,
  energy_wh            BIGINT NOT NULL DEFAULT 0,
  duration_s           INTEGER,
  -- prepaid QRIS flow: the charger delivers exactly this much and stops
  prepaid_amount_idr   INTEGER,
  prepaid_energy_wh    BIGINT,
  payment_mode         TEXT,   -- prepurchase | tokenized | preauth | postpaid | free
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON charging_session (org_id, started_at DESC);
CREATE INDEX ON charging_session (connector_uuid, state);
CREATE INDEX ON charging_session (charge_point_id, ocpp_transaction_id);

CREATE TABLE meter_value (
  session_id  UUID NOT NULL REFERENCES charging_session(id) ON DELETE CASCADE,
  ts          TIMESTAMPTZ NOT NULL,
  measurand   TEXT NOT NULL,
  phase       TEXT,
  value       DOUBLE PRECISION NOT NULL,
  unit        TEXT
);
CREATE INDEX ON meter_value (session_id, ts DESC);
-- In production: SELECT create_hypertable('meter_value', 'ts');

CREATE TABLE cdr (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         UUID NOT NULL UNIQUE REFERENCES charging_session(id),
  org_id             UUID NOT NULL REFERENCES organisation(id),
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  lines              JSONB NOT NULL,
  subtotal_idr       INTEGER NOT NULL,
  pbjt_rate_bps      INTEGER NOT NULL,
  pbjt_idr           INTEGER NOT NULL,
  ppn_dpp_idr        INTEGER NOT NULL,   -- DPP nilai lain = 11/12 x price
  ppn_rate_bps       INTEGER NOT NULL,   -- 1200 = 12%
  ppn_idr            INTEGER NOT NULL,
  total_idr          INTEGER NOT NULL,
  tariff_snapshot    JSONB NOT NULL,     -- frozen; historical invoices must reproduce exactly
  regulatory_flags   JSONB NOT NULL DEFAULT '[]'
);

-- ---------------------------------------------------------------- payments

CREATE TABLE payment_intent (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organisation(id),
  session_id         UUID REFERENCES charging_session(id),
  invoice_id         UUID,
  provider           TEXT NOT NULL,    -- xendit | midtrans | manual
  provider_ref       TEXT,
  method             TEXT NOT NULL,    -- qris | ewallet_token | card | va
  mode               TEXT NOT NULL,    -- prepurchase | tokenized | preauth | postpaid
  state              TEXT NOT NULL DEFAULT 'pending',
                     -- pending | authorised | captured | failed | expired | refunded
  amount_authorised_idr INTEGER,
  amount_captured_idr   INTEGER,
  idem_key           TEXT UNIQUE,
  raw_events         JSONB NOT NULL DEFAULT '[]',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- smart charging

CREATE TABLE site_power_budget (
  site_id      UUID PRIMARY KEY REFERENCES site(id) ON DELETE CASCADE,
  ceiling_w    INTEGER NOT NULL,
  reserve_w    INTEGER NOT NULL DEFAULT 0,   -- headroom held back for non-charger building load
  source       TEXT NOT NULL DEFAULT 'static', -- static | meter | genset
  strategy     TEXT NOT NULL DEFAULT 'fair_share', -- fair_share | priority | fifo
  curtailed    BOOLEAN NOT NULL DEFAULT false,     -- true while the site is on genset
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE charging_profile (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_point_id  UUID NOT NULL REFERENCES charge_point(id) ON DELETE CASCADE,
  connector_no     INTEGER NOT NULL,     -- OCPP 1.6 connectorId; 0 = station
  purpose          TEXT NOT NULL,        -- ChargePointMaxProfile | TxDefaultProfile | TxProfile
  stack_level      INTEGER NOT NULL,
  ocpp_profile_id  INTEGER NOT NULL,
  transaction_id   TEXT,
  limit_w          INTEGER NOT NULL,
  duration_s       INTEGER,              -- ALWAYS set on transient profiles, or the charger never falls back
  state            TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected | cleared
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON charging_profile (charge_point_id, state);

-- ---------------------------------------------------------------- ops

CREATE TABLE ocpp_frame (
  id               BIGSERIAL PRIMARY KEY,
  charge_point_id  UUID REFERENCES charge_point(id) ON DELETE CASCADE,
  ocpp_identity    TEXT NOT NULL,
  ts               TIMESTAMPTZ NOT NULL DEFAULT now(),
  direction        TEXT NOT NULL,   -- in | out
  message_type     SMALLINT NOT NULL,  -- 2 CALL | 3 CALLRESULT | 4 CALLERROR
  action           TEXT,
  unique_id        TEXT,
  payload          JSONB NOT NULL
);
CREATE INDEX ON ocpp_frame (ocpp_identity, ts DESC);
-- In production: SELECT create_hypertable('ocpp_frame', 'ts'); + compression after 7 days.

CREATE TABLE audit_log (
  id             BIGSERIAL PRIMARY KEY,
  org_id         UUID REFERENCES organisation(id),
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type     TEXT NOT NULL,   -- user | api_client | system | charge_point
  actor_id       TEXT,
  action         TEXT NOT NULL,
  target_type    TEXT,
  target_id      TEXT,
  before_state   JSONB,
  after_state    JSONB,
  ip             TEXT,
  user_agent     TEXT,
  prev_hash      TEXT,            -- hash chain: tamper evidence
  hash           TEXT NOT NULL
);
CREATE INDEX ON audit_log (org_id, ts DESC);

CREATE TABLE alert (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organisation(id),
  severity     TEXT NOT NULL,    -- info | warning | critical
  kind         TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  message      TEXT NOT NULL,
  raised_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ
);
CREATE INDEX ON alert (org_id, resolved_at, raised_at DESC);

CREATE TABLE webhook_endpoint (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organisation(id),
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,
  events      TEXT[] NOT NULL DEFAULT '{}',
  state       TEXT NOT NULL DEFAULT 'active'
);
