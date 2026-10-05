import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { databaseTestLock } from '../db/test-lock.js';
import { efakturXml, fakturDate } from './efaktur.js';
import { rateSession, type Tariff } from './tariff.js';
import { computeTax } from './tax.js';
import { teraStatusFor, certDate, daysUntil } from './compliance.js';
import { createTariff, assignTariff, unassignTariff, loadTariffForConnector } from './tariff-store.js';
import { statementFor, efakturExport, issueInvoice, saveSettings, updateAccount } from './fleet-billing.js';

/**
 * Billing facts taken as of the moment they happened (migration 051), and the
 * fiscal documents dated and added up correctly.
 *
 * The pure suites always run. The database-backed ones run only against the
 * disposable test database:
 *   DATABASE_URL=postgresql://postgres:…@127.0.0.1:5433/plugsure_audit_fix npx tsx --test src/services/billing-effective.test.ts
 */

// ------------------------------------------------------------------ pure

describe('e-Faktur: a faktur gabungan is dated in the month of delivery', () => {
  test('the faktur date is the last day of the billing month', () => {
    assert.equal(fakturDate('2026-09'), '2026-09-30');
    assert.equal(fakturDate('2026-12'), '2026-12-31');
    assert.equal(fakturDate('2028-02'), '2028-02-29');
    assert.equal(fakturDate('2027-02'), '2027-02-28');
  });
  test('TaxInvoiceDate carries that date; RefDesc keeps the invoice number', () => {
    const xml = efakturXml({ npwp: '0987654321098765', nitku: null }, [{
      number: 'FLT/2026/10/0001', date: fakturDate('2026-09'),
      buyer: { taxId: '0012345678901000', kind: 'TIN', nitku: null, name: 'PT Buyer', address: 'Jakarta', email: null },
      lines: [{ name: 'x', taxableMinor: 120_000, taxBaseMinor: 110_000, taxMinor: 13_200 }],
    }], { itemOpt: 'A', itemCode: '000000', unitCode: 'UM.0033' });
    assert.match(xml, /<TaxInvoiceDate>2026-09-30<\/TaxInvoiceDate>/);
    assert.match(xml, /<RefDesc>FLT\/2026\/10\/0001<\/RefDesc>/);
  });
});

const layananKhusus = (components: Tariff['components']): Tariff => ({
  id: 't', name: 'LK', currency: 'IDR', plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, components,
});
const ctx = (kwh: number) => ({
  startedAt: new Date('2026-09-10T03:00:00Z'), endedAt: new Date('2026-09-10T04:00:00Z'),
  energyWh: kwh * 1000, connectorMaxPowerW: 22_000, localTaxRateBps: 0, timezone: 'Asia/Jakarta',
});

describe('tariff: a zero-rate energy tier is free; the PLN formula only when asked for', () => {
  test('"first 5 kWh free", then the formula rate (no rate given)', () => {
    const t = layananKhusus([
      { kind: 'energy', rate: 0, touBlock: 'ANY', fromKwh: 0, toKwh: 5 },
      { kind: 'energy', rate: null as unknown as number, touBlock: 'ANY', fromKwh: 5 },
    ]);
    const r = rateSession(t, ctx(8));
    const energy = r.lines.filter((l) => l.kind === 'energy');
    assert.equal(energy.length, 2);
    assert.equal(energy[0]!.amountMinor, 0, 'the free band bills Rp 0, not the formula rate');
    assert.equal(energy[1]!.unitRate, 1645 * 1.5);
    assert.equal(r.tax.subtotalMinor, Math.round(3 * 1645 * 1.5));
  });
  test('formulaRate marks a band for the formula rate explicitly', () => {
    const r = rateSession(layananKhusus([{ kind: 'energy', rate: 0, formulaRate: true, touBlock: 'ANY' }]), ctx(2));
    assert.equal(r.tax.subtotalMinor, Math.round(2 * 1645 * 1.5));
  });
  test('a free tariff with no PLN scheme is free, and a formula band with no scheme is flagged', () => {
    const free = rateSession({ ...layananKhusus([{ kind: 'energy', rate: 0, touBlock: 'ANY' }]), plnScheme: 'none' }, ctx(2));
    assert.equal(free.tax.subtotalMinor, 0);
    assert.ok(!free.flags.some((f) => f.code === 'NO_FORMULA_RATE'));
    const formula = rateSession({ ...layananKhusus([{ kind: 'energy', rate: 0, formulaRate: true, touBlock: 'ANY' }]), plnScheme: 'none' }, ctx(2));
    assert.ok(formula.flags.some((f) => f.code === 'NO_FORMULA_RATE'));
  });
});

describe('receipt rounding: the lines add up to the total', () => {
  test('with ROUNDING_UNIT_IDR > 1 the rounding is its own amount', () => {
    const before = config.tax.id.roundingUnitIdr;
    (config.tax.id as { roundingUnitIdr: number }).roundingUnitIdr = 100;
    try {
      for (const sub of [29_005, 41_333, 17_777, 50_000]) {
        const t = computeTax({ subtotalMinor: sub, localTaxRateBps: 1000 });
        assert.equal(t.totalMinor % 100, 0);
        assert.equal(t.subtotalMinor + t.localTaxMinor + t.taxMinor + t.roundingMinor, t.totalMinor);
        assert.ok(Math.abs(t.roundingMinor) <= 50);
      }
    } finally {
      (config.tax.id as { roundingUnitIdr: number }).roundingUnitIdr = before;
    }
  });
});

describe('tera / SLO dates are calendar dates in WIB', () => {
  test('a DATE from node-postgres (local midnight under TZ=Asia/Jakarta) is its own day, not the day before', () => {
    assert.equal(certDate(new Date('2026-09-29T17:00:00Z')), '2026-09-30'); // 30 Sep 00:00 WIB
    assert.equal(certDate(new Date('2026-09-30')), '2026-09-30'); // UTC midnight = 07:00 WIB
    assert.equal(certDate('2026-09-30'), '2026-09-30');
  });
  test('valid through the due date: blocked from 00:00 WIB the day after, not from 00:00 of the due date', () => {
    const due = '2026-09-30';
    assert.equal(teraStatusFor(due, new Date('2026-09-29T17:00:00Z')), 'due_soon'); // 30 Sep 00:00 WIB
    assert.equal(teraStatusFor(due, new Date('2026-09-30T16:59:00Z')), 'due_soon'); // 30 Sep 23:59 WIB
    assert.equal(teraStatusFor(due, new Date('2026-09-30T17:00:00Z')), 'lapsed'); //   1 Oct 00:00 WIB
    assert.equal(teraStatusFor(new Date('2026-09-29T17:00:00Z'), new Date('2026-09-30T10:00:00Z')), 'due_soon');
    assert.equal(daysUntil(due, new Date('2026-09-23T17:30:00Z')), 6); // 24 Sep 00:30 WIB
    assert.equal(daysUntil(due, new Date('2026-09-23T16:30:00Z')), 7); // 23 Sep 23:30 WIB
  });
});

// ------------------------------------------------------------------ database

const DB_OK = /\/plugsure_audit_fix(\?|$)/.test(config.databaseUrl);
if (!DB_OK) console.warn('[billing-effective.test] SKIPPING database-backed suites (DATABASE_URL is not plugsure_audit_fix).');
const dbDescribe = DB_OK ? describe : describe.skip;
const dbLock = databaseTestLock('shared', DB_OK);
before(dbLock.acquire);
after(dbLock.release);

const SLUG = 'billing-effective-test';
const IDENT = 'BILLEFF-TEST-01';
let orgId = '';
let siteId = '';
let cpId = '';
let connectorId = '';

async function cleanup(): Promise<void> {
  const org = await one<{ id: string }>(`SELECT id FROM organisation WHERE slug = $1`, [SLUG]);
  if (!org) return;
  const cs = `SELECT id FROM charging_session WHERE org_id = $1`;
  await query(`DELETE FROM fleet_invoice_item WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM fleet_invoice WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM cdr WHERE session_id IN (${cs})`, [org.id]);
  await query(`DELETE FROM charging_session WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM token WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM fleet_account WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM tariff_assignment WHERE tariff_id IN (SELECT id FROM tariff WHERE org_id = $1)`, [org.id]);
  await query(`DELETE FROM tariff WHERE org_id = $1`, [org.id]);
  await query(`DELETE FROM connector WHERE evse_uuid IN (SELECT e.id FROM evse e JOIN charge_point cp ON cp.id = e.charge_point_id WHERE cp.ocpp_identity = $1)`, [IDENT]);
  await query(`DELETE FROM evse WHERE charge_point_id IN (SELECT id FROM charge_point WHERE ocpp_identity = $1)`, [IDENT]);
  await query(`DELETE FROM charge_point WHERE ocpp_identity = $1`, [IDENT]);
  await query(`DELETE FROM site WHERE org_id = $1`, [org.id]);
}

if (DB_OK) {
  before(async () => {
    await cleanup();
    orgId = (await one<{ id: string }>(
      `INSERT INTO organisation (name, slug, pkp) VALUES ('Billing Effective Test', $1, true)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, pkp = true RETURNING id`, [SLUG]))!.id;
    siteId = (await one<{ id: string }>(
      `INSERT INTO site (org_id, name, local_tax_rate_bps) VALUES ($1, 'Billing Effective Hub', 1000) RETURNING id`, [orgId]))!.id;
    cpId = (await one<{ id: string }>(
      `INSERT INTO charge_point (site_id, ocpp_identity, ocpp_version, status) VALUES ($1, $2, 'ocpp1.6', 'online') RETURNING id`, [siteId, IDENT]))!.id;
    const e = await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1, 1, 22000) RETURNING id`, [cpId]);
    connectorId = (await one<{ id: string }>(
      `INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w, tera_status, tera_cert_status)
       VALUES ($1, 1, 'Type2', 'AC', 22000, 'verified', 'verified') RETURNING id`, [e!.id]))!.id;
  });
  after(async () => {
    await cleanup();
    await pool.end();
  });
}

/** A rated session (with its charge record) in September 2026 for a card. */
async function ratedSession(tokenId: string, startedAt: string, subtotal = 100_000) {
  const t = computeTax({ subtotalMinor: subtotal, localTaxRateBps: 1000 });
  const s = await one<{ id: string; fleet_account_id: string | null }>(
    `INSERT INTO charging_session (org_id, site_id, connector_uuid, charge_point_id, idem_key, token_id, state, started_at, ended_at, energy_wh)
     VALUES ($1,$2,$3,$4,$5,$6,'ended',$7,$7::timestamptz + interval '1 hour',10000) RETURNING id, fleet_account_id`,
    [orgId, siteId, connectorId, cpId, `billeff-${Math.random()}`, tokenId, startedAt]);
  await query(
    `INSERT INTO cdr (session_id, org_id, issued_at, lines, subtotal_minor, local_tax_rate_bps, local_tax_minor, tax_base_minor, tax_rate_bps, tax_minor, total_minor, tariff_snapshot)
     VALUES ($1,$2,$3::timestamptz + interval '1 hour','[]',$4,1000,$5,$6,$7,$8,$9,'{}')`,
    [s!.id, orgId, startedAt, t.subtotalMinor, t.localTaxMinor, t.taxBaseMinor, t.taxRateBps, t.taxMinor, t.totalMinor]);
  return s!;
}

dbDescribe('fleet billing: the fleet at session time', () => {
  test('a card moved to another account leaves its earlier sessions with the first', async () => {
    const card = await one<{ id: string; fleet_account_id: string }>(
      `INSERT INTO token (org_id, kind, uid, status, account_type, fleet_name) VALUES ($1, 'rfid', 'BE-CARD-1', 'Accepted', 'fleet', 'BE Fleet Satu')
       RETURNING id, fleet_account_id`, [orgId]);
    const satu = card!.fleet_account_id;
    const dua = (await one<{ id: string }>(`INSERT INTO fleet_account (org_id, name) VALUES ($1, 'BE Fleet Dua') RETURNING id`, [orgId]))!.id;
    const s1 = await ratedSession(card!.id, '2026-09-10T03:00:00Z');
    assert.equal(s1.fleet_account_id, satu, 'captured from the card when the session was written');

    // The card moves to Dua; a later session is Dua's.
    await query(`UPDATE token SET fleet_name = 'BE Fleet Dua' WHERE id = $1`, [card!.id]);
    const s2 = await ratedSession(card!.id, '2026-09-20T03:00:00Z', 50_000);
    assert.equal(s2.fleet_account_id, dua);

    const a = await statementFor(orgId, satu, '2026-09');
    const b = await statementFor(orgId, dua, '2026-09');
    assert.deepEqual(a.sessions.map((s: { id: string }) => s.id), [s1.id], 'Satu is billed for the session it ran');
    assert.deepEqual(b.sessions.map((s: { id: string }) => s.id), [s2.id], 'Dua is not billed for the card\'s past');
  });

  test('e-Faktur: dated the last day of the month; an exported invoice is not exported again unless asked', async () => {
    await saveSettings(orgId, {
      npwp: '0987654321098765', nitku: '0987654321098765000000', address: 'Jakarta',
      efaktur: { itemOpt: 'A', itemCode: '000000', unitCode: 'UM.0033', confirmed: true },
    }, 'test');
    const satu = (await one<{ id: string }>(`SELECT id FROM fleet_account WHERE org_id = $1 AND name = 'BE Fleet Satu'`, [orgId]))!.id;
    await updateAccount(orgId, satu, { taxIdKind: 'TIN', taxId: '0012345678901000', legalName: 'PT BE Satu' });
    const inv = await issueInvoice(orgId, satu, '2026-09', 'test');
    const first = await efakturExport(orgId, '2026-09');
    assert.deepEqual(first.included, [inv.number]);
    assert.match(first.xml, /<TaxInvoiceDate>2026-09-30<\/TaxInvoiceDate>/);
    assert.ok(first.xml.includes(`<RefDesc>${inv.number}</RefDesc>`));

    const again = await efakturExport(orgId, '2026-09').catch((e: Error & { status?: number }) => e);
    assert.ok(again instanceof Error && /already exported/.test(again.message), 'the month again: nothing new to export');
    const byId = await efakturExport(orgId, '2026-09', [inv.id]);
    assert.deepEqual(byId.included, [inv.number], 'by id: exported again on purpose');
    const flagged = await efakturExport(orgId, '2026-09', undefined, { reexport: true });
    assert.deepEqual(flagged.included, [inv.number]);
  });
});

dbDescribe('tariff assignments are versioned', () => {
  test('a session is priced by the assignment in force at its start', async () => {
    const t = await createTariff({
      orgId, name: 'BE tariff', appliesToMaxPowerW: 22_000, activeFrom: new Date('2026-01-01T00:00:00Z'),
      components: [{ kind: 'energy', rate: 2000, touBlock: 'ANY', fromKwh: 0, fromMinutes: 0 }],
    });
    assert.equal(t.ok, true);
    const before = new Date(Date.now() - 60_000);
    assert.equal((await assignTariff(t.tariffId!, 'connector', connectorId)).ok, true);
    const during = new Date();

    // Attached now: a session that started before is not re-priced by it.
    assert.equal((await loadTariffForConnector(connectorId, orgId, before)).fallback, true);
    assert.equal((await loadTariffForConnector(connectorId, orgId, during)).tariff.id, t.tariffId);

    // Unassigned: a session that started while it applied (parked, rated later) still gets it.
    const row = (await one<{ id: string }>(`SELECT id FROM tariff_assignment WHERE tariff_id = $1 AND valid_to IS NULL`, [t.tariffId]))!;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await unassignTariff(row.id, orgId), true);
    assert.equal((await loadTariffForConnector(connectorId, orgId, during)).tariff.id, t.tariffId);
    assert.equal((await loadTariffForConnector(connectorId, orgId, new Date(Date.now() + 1000))).fallback, true);
    const kept = await one<{ n: number }>(`SELECT count(*)::int AS n FROM tariff_assignment WHERE tariff_id = $1`, [t.tariffId]);
    assert.equal(kept!.n, 1, 'closed, not deleted');
    assert.equal(await unassignTariff(row.id, orgId), false, 'already closed');
  });

  test('a formula-rate energy component is stored as NULL and read back as formula; 0 stays free', async () => {
    const t = await createTariff({
      orgId, name: 'BE free first 5', plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5, appliesToMaxPowerW: 22_000,
      components: [
        { kind: 'energy', rate: 0, touBlock: 'ANY', fromKwh: 0, toKwh: 5 },
        { kind: 'energy', rate: null as unknown as number, touBlock: 'ANY', fromKwh: 5 },
      ],
    });
    assert.equal(t.ok, true, JSON.stringify(t.flags));
    const rates = await query<{ rate: string | null }>(`SELECT rate FROM tariff_component WHERE tariff_id = $1 ORDER BY from_kwh`, [t.tariffId]);
    assert.deepEqual(rates.rows.map((r) => (r.rate == null ? null : Number(r.rate))), [0, null]);
    const { loadTariffById } = await import('./tariff-store.js');
    const back = (await loadTariffById(t.tariffId!))!;
    assert.equal(rateSession(back, ctx(8)).tax.subtotalMinor, Math.round(3 * 1645 * 1.5));
  });
});
