import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { searchSessions, sessionsCsv, SESSIONS_CSV_HEAD, SESSIONS_CSV_HEAD_V1 } from './session-query.js';

/**
 * Integrations built against v1.5.0 (an ERP importing the sessions CSV, a client reading /v1/sessions/search) keep
 * working for an Indonesian operator: the CSV keeps the v1.5 columns byte for byte while every site is in Indonesia,
 * and the search totals stay numbers. docs/COMPATIBILITY-v1.5-to-v1.9.md.
 *
 *   DATABASE_URL=…/plugsure_audit_fix npx tsx --test src/services/compat-v15.test.ts
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[compat-v15.test] SKIPPING database-backed suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

test('the v1.5 sessions CSV columns are the ones v1.5.0 wrote (25, ending in gross_total_idr)', () => {
  assert.equal(SESSIONS_CSV_HEAD_V1.length, 25);
  assert.equal(SESSIONS_CSV_HEAD_V1.join(','),
    'session_id,transaction_id,site,charge_point,connector,connector_type,id_tag,started_at,ended_at,duration_s,meter_start_kwh,meter_stop_kwh,energy_kwh,stop_reason,state,payment_status,energy_subtotal_idr,service_fee_idr,idle_fee_idr,pbjt_rate_pct,pbjt_idr,dpp_idr,ppn_idr,mdr_estimate_idr,gross_total_idr');
  assert.equal(SESSIONS_CSV_HEAD.length, 26, 'the multi-currency file has the same columns, renamed, and currency last');
  assert.equal(SESSIONS_CSV_HEAD.at(-1), 'currency');
});

const SLUG = 'compat-v15-id';
const ids: Record<string, string> = {};

async function cleanup(): Promise<void> {
  const o = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (!o) return;
  await query(`DELETE FROM cdr WHERE org_id = $1`, [o.id]);
  await query(`DELETE FROM charging_session WHERE org_id = $1`, [o.id]);
  await query(`DELETE FROM connector WHERE evse_uuid IN (SELECT e.id FROM evse e JOIN charge_point cp ON cp.id = e.charge_point_id JOIN site s ON s.id = cp.site_id WHERE s.org_id = $1)`, [o.id]);
  await query(`DELETE FROM evse WHERE charge_point_id IN (SELECT cp.id FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE s.org_id = $1)`, [o.id]);
  await query(`DELETE FROM charge_point WHERE site_id IN (SELECT id FROM site WHERE org_id = $1)`, [o.id]);
  await query(`DELETE FROM site WHERE org_id = $1`, [o.id]);
}

if (DB_OK) {
  before(async () => {
    await cleanup();
    ids.org = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug) VALUES ('Compat v1.5 ID', $1) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [SLUG]))!.id;
    ids.site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code) VALUES ($1, 'Compat Jakarta', 'ID') RETURNING id`, [ids.org]))!.id;
    ids.cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, ocpp_version, status, commissioned_at) VALUES ($1, 'COMPAT-V15-1', 'ocpp1.6', 'online', '2026-01-01') RETURNING id`, [ids.site]))!.id;
    const e = await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1, 1, 60000) RETURNING id`, [ids.cp]);
    ids.conn = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w) VALUES ($1, 1, 'cCCS2', 'DC', 60000) RETURNING id`, [e!.id]))!.id;
    const s = (await one<{ id: string }>(
      `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, state, started_at, ended_at, energy_wh, meter_start_wh, meter_stop_wh, currency)
       VALUES ($1,$2,$3,$4,$5,'ended','2026-09-10T03:00:00Z','2026-09-10T04:00:00Z',20000,1000000,1020000,'IDR') RETURNING id`,
      [ids.org, ids.site, ids.conn, ids.cp, `cv15-${randomUUID()}`]))!.id;
    ids.session = s;
    await query(
      `INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot, currency, tax_scheme)
       VALUES ($1,$2,'2026-09-10T04:00:00Z','[]',49320,1000,4932,45210,1200,5425,59677,'{}','IDR','ID_PPN_PBJT')`, [s, ids.org]);
  });
  after(async () => { await cleanup(); await pool.end(); });
}

dbDescribe('an Indonesian operator, as in v1.5', () => {
  const window = { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' } as any;

  test('sessions CSV: the v1.5 header and rupiah values while every site is in Indonesia', async () => {
    const csv = await sessionsCsv(ids.org!, window, null);
    const [head, row] = csv.split('\r\n');
    assert.equal(head, SESSIONS_CSV_HEAD_V1.join(','));
    const cells = row!.split(',');
    assert.equal(cells.length, 25, 'no currency column');
    assert.equal(cells[0], ids.session);
    assert.equal(cells[12], '20.000', 'energy in kWh with three decimals, as v1.5');
    assert.ok(csv.endsWith('\r\n'));
  });

  test('sessions search: totals are numbers (v1.5 / v1.6 and the OpenAPI document)', async () => {
    const r = await searchSessions(ids.org!, window, null);
    for (const k of ['sessions', 'energy_wh', 'revenue_minor', 'local_tax_minor', 'tax_minor'] as const) {
      assert.equal(typeof (r.totals as any)[k], 'number', `totals.${k}`);
    }
    assert.equal(r.totals.energy_wh, 20000);
  });

  test('a site outside Indonesia switches the file to the multi-currency columns', async () => {
    const abroad = await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code, timezone) VALUES ($1, 'Compat KL', 'MY', 'Asia/Kuala_Lumpur') RETURNING id`, [ids.org]);
    try {
      const csv = await sessionsCsv(ids.org!, window, null);
      const [head, row] = csv.split('\r\n');
      assert.equal(head, SESSIONS_CSV_HEAD.join(','));
      assert.equal(row!.split(',').at(-1), 'IDR');
    } finally {
      await query(`DELETE FROM site WHERE id = $1`, [abroad!.id]);
    }
  });
});
