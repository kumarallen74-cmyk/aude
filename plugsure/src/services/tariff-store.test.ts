import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { createTariff, assignTariff } from './tariff-store.js';

/**
 * Tariff writes are atomic (database-backed).
 *
 * Runs only against the disposable test database, like the audit suites:
 *   DATABASE_URL=postgresql://postgres:…@127.0.0.1:5432/plugsure_audit_fix npm test
 */
const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[tariff-store.test] SKIPPING database-backed tariff suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
// One file at a time against the audit chain (src/db/test-lock.ts).
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'tariff-atomic-test';
let orgId = '';
let siteId = '';

async function cleanup(): Promise<void> {
  const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (!org) return;
  await query(`DELETE FROM tariff_assignment WHERE tariff_id IN (SELECT id FROM tariff WHERE org_id = $1)`, [org.id]);
  await query(`DELETE FROM tariff WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM site WHERE org_id = $1`, [org.id]);
}

if (DB_OK) {
  before(async () => {
    await cleanup();
    orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug) VALUES ('Tariff Atomic Test', $1)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [SLUG],
    ))!.id;
    siteId = (await one<{ id: string }>(
      `INSERT INTO site (org_id, name, pbjt_rate_bps) VALUES ($1, 'Tariff Atomic Hub', 1000) RETURNING id`,
      [orgId],
    ))!.id;
  });
  after(async () => {
    await cleanup();
    await pool.end();
  });
}

const energy = (rate: number, extra: Record<string, unknown> = {}) =>
  ({ kind: 'energy', rate, touBlock: 'ANY', fromKwh: 0, fromMinutes: 0, ...extra }) as any;

dbDescribe('tariff writes are atomic', () => {
  test('concurrent assigns of one tariff to one scope leave exactly one open assignment', async () => {
    const t = await createTariff({ orgId, name: 'Concurrent assign', components: [energy(2000)], appliesToMaxPowerW: 22_000 });
    assert.equal(t.ok, true);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => assignTariff(t.tariffId!, 'site', siteId, i, 'AC')));
    assert.ok(results.every((r) => r.ok));
    const n = await one<{ n: number }>(
      // Replaced assignments are closed (valid_to), not deleted (migration 051): one is open.
      `SELECT count(*)::int AS n FROM tariff_assignment WHERE tariff_id = $1 AND scope_type = 'site' AND scope_id = $2 AND current_type = 'AC' AND valid_to IS NULL`,
      [t.tariffId, siteId],
    );
    assert.equal(n!.n, 1);
  });

  test('a tariff whose components fail to save is not saved at all', async () => {
    const r = await createTariff({
      orgId,
      name: 'Half-written',
      components: [energy(2000), energy(2100, { touBlock: 'WBP', timeFrom: '99:99', timeTo: '22:00' })],
      appliesToMaxPowerW: 22_000,
    }).catch((e: Error) => e);
    assert.ok(r instanceof Error, 'the invalid component must fail the write');
    const left = await one<{ n: number }>(`SELECT count(*)::int AS n FROM tariff WHERE org_id = $1 AND name = 'Half-written'`, [orgId]);
    assert.equal(left!.n, 0, 'no tariff row may survive without its components');
  });
});
