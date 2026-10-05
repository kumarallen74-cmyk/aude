// Golden fixtures for Indonesia (docs/MULTI-COUNTRY-DESIGN.md WP1 acceptance: "ID output
// byte-identical to before").
//
//     npx tsx tools/multicountry/golden-gen.mts --from /path/to/v1.6/plugsure/src [--out file]
//
// Runs the v1.6 code (a checkout of master @ 977d92c) over a fixed matrix of
// representative Indonesian tariffs and sessions — rating (lines, tax stack, flags),
// pre-purchase allowances, save-time validation, the tax arithmetic, and the OCPI
// objects built from them — and writes inputs and outputs to
// src/services/tax/golden-id.fixture.json. src/services/tax/golden-id.test.ts
// replays every input through the current code and requires the same output
// (v1.6 field names mapped to the current ones, nothing else).
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const from = arg('--from');
if (!from) { console.error('usage: golden-gen.mts --from <v1.6 plugsure/src>'); process.exit(2); }
const out = arg('--out') ?? join(import.meta.dirname, '..', '..', 'src', 'services', 'tax', 'golden-id.fixture.json');

const tariffMod = await import(resolve(from, 'services/tariff.ts'));
const taxMod = await import(resolve(from, 'services/tax.ts'));
const ocpi = await import(resolve(from, 'ocpi/mapping.ts'));

// ─────────────────────────────── tariffs (v1.6 shape)
const T: Record<string, any> = {
  seed: { id: 't-seed', name: 'Public DC — layanan khusus N=1.5', currency: 'IDR', plnScheme: 'layanan_khusus', plnBaseRate: 1645, plnMultiplier: 1.5,
    components: [
      { kind: 'energy', rate: 2467.5, touBlock: 'ANY', fromKwh: 0, sortOrder: 0 },
      { kind: 'session', rate: 21000, touBlock: 'ANY', sortOrder: 1 },
      { kind: 'admin', rate: 4000, touBlock: 'ANY', sortOrder: 2 },
      { kind: 'idle', rate: 1000, touBlock: 'ANY', fromMinutes: 15, toMinutes: 105, sortOrder: 3 },
    ] },
  formula: { id: 't-formula', name: 'Formula only', currency: 'IDR', plnScheme: 'layanan_khusus', plnMultiplier: 1.5, components: [] },
  tiered: { id: 't-tiered', name: 'Tiered', currency: 'IDR', plnScheme: 'none', components: [
    { kind: 'energy', rate: 2000, touBlock: 'ANY', fromKwh: 0, toKwh: 50 },
    { kind: 'energy', rate: 1500, touBlock: 'ANY', fromKwh: 50 },
    { kind: 'session', rate: 10000, touBlock: 'ANY' },
  ] },
  tou: { id: 't-tou', name: 'Peak / off-peak', currency: 'IDR', plnScheme: 'layanan_khusus', plnBaseRate: 1650, plnMultiplier: 1.5, components: [
    { kind: 'energy', rate: 2475, touBlock: 'WBP' },
    { kind: 'energy', rate: 2000, touBlock: 'LWBP' },
    { kind: 'session', rate: 5000, touBlock: 'ANY' },
  ] },
  time: { id: 't-time', name: 'Time + non-PKP', currency: 'IDR', plnScheme: 'none', ppnApplies: false, components: [
    { kind: 'energy', rate: 2400, touBlock: 'ANY' },
    { kind: 'time', rate: 200, touBlock: 'ANY', fromMinutes: 0, toMinutes: 60 },
  ] },
  overcap: { id: 't-overcap', name: 'Fees above the ceiling', currency: 'IDR', plnScheme: 'layanan_khusus', components: [
    { kind: 'energy', rate: 2400, touBlock: 'ANY' },
    { kind: 'session', rate: 40000, touBlock: 'ANY' },
    { kind: 'admin', rate: 5000, touBlock: 'ANY' },
  ] },
  idlecap: { id: 't-idlecap', name: 'Idle above the cap', currency: 'IDR', plnScheme: 'layanan_khusus', components: [
    { kind: 'energy', rate: 2000, touBlock: 'ANY' },
    { kind: 'idle', rate: 5000, touBlock: 'ANY', fromMinutes: 0, toMinutes: 100 },
  ] },
  free: { id: 't-free', name: 'First 5 kWh free', currency: 'IDR', plnScheme: 'layanan_khusus', plnMultiplier: 1.5, components: [
    { kind: 'energy', rate: 0, touBlock: 'ANY', fromKwh: 0, toKwh: 5 },
    { kind: 'energy', rate: 2467.5, touBlock: 'ANY', fromKwh: 5 },
  ] },
  daynight: { id: 't-daynight', name: 'Day and night', currency: 'IDR', plnScheme: 'none', components: [
    { kind: 'energy', rate: 2400, touBlock: 'ANY', timeFrom: '06:00', timeTo: '22:00', dayMask: 127 },
    { kind: 'energy', rate: 1800, touBlock: 'ANY', timeFrom: '22:00', timeTo: '06:00', dayMask: 31 },
    { kind: 'energy', rate: 2100, touBlock: 'ANY', timeFrom: '22:00', timeTo: '06:00', dayMask: 96 },
    { kind: 'session', rate: 3000, touBlock: 'ANY' },
  ] },
  curah: { id: 't-curah', name: 'Curah formula', currency: 'IDR', plnScheme: 'curah', plnBaseRate: 707, plnMultiplier: 3.0, components: [
    { kind: 'energy', rate: 0, formulaRate: true, touBlock: 'ANY' },
    { kind: 'session', rate: 2000, touBlock: 'ANY' },
  ] },
  illegal: { id: 't-illegal', name: 'Over every ceiling', currency: 'IDR', plnScheme: 'layanan_khusus', plnMultiplier: 1.8, components: [
    { kind: 'energy', rate: 10000, touBlock: 'ANY' },
    { kind: 'energy', rate: 9000, touBlock: 'WBP' },
    { kind: 'session', rate: 60000, touBlock: 'ANY' },
    { kind: 'idle', rate: 2000, touBlock: 'ANY', fromMinutes: 10 },
  ] },
};

// ─────────────────────────────── sessions
const starts = ['2026-08-23T02:00:00Z', '2026-08-23T09:30:00Z', '2026-08-23T14:45:00Z', '2026-08-29T16:10:00Z'];
const durs = [10, 45, 125, 600];
const energies = [0, 50, 7300, 40000, 61234];
const idles = [0, 20, 200];
const pbjts = [0, 500, 1000];
const powers = [7000, 22000, 30000, 60000, 150000];
const tzs = ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'];
const adjs: any[][] = [
  [],
  [{ source: 'subscription', id: 'm1', name: 'Member', energyRateIdr: 2000 }],
  [{ source: 'subscription', id: 'm2', name: 'Gold', energyPercentOffBps: 1000, waiveSessionFees: true }],
  [{ source: 'subscription', id: 'm3', name: 'Pack', freeKwh: 5 }, { source: 'promotion', id: 'p1', name: 'Promo', amountOffIdr: 10000 }],
  [{ source: 'promotion', id: 'p2', name: 'Big', amountOffIdr: 500000 }],
  [{ source: 'v2x', id: 'v1', name: 'Energy given back (3.00 kWh)', amountOffIdr: 4500 }],
];

const cases: any[] = [];
let n = 0;
const pick = <X,>(a: X[], i: number) => a[i % a.length]!;
for (const [tk, tariff] of Object.entries(T)) {
  for (let i = 0; i < 14; i++, n++) {
    const startedAt = pick(starts, n);
    const ctx = {
      startedAt, endedAt: new Date(new Date(startedAt).getTime() + pick(durs, n * 3 + i) * 60_000).toISOString(),
      energyWh: pick(energies, n + i), connectorMaxPowerW: pick(powers, n * 7 + i), pbjtRateBps: pick(pbjts, n * 5 + i),
      idleMinutes: pick(idles, n * 11 + i), timezone: pick(tzs, n * 13 + i), adjustments: pick(adjs, n * 17 + i),
    };
    const dated = { ...ctx, startedAt: new Date(ctx.startedAt), endedAt: new Date(ctx.endedAt) };
    cases.push({ kind: 'rate', name: `${tk}#${i}`, tariff: tk, ctx, out: JSON.parse(JSON.stringify(tariffMod.rateSession(structuredClone(tariff), dated))) });
  }
  for (const amount of [5000, 50_000, 100_000, 300_000]) {
    const ctx = { startedAt: '2026-08-23T03:00:00Z', endedAt: '2026-08-23T03:45:00Z', connectorMaxPowerW: 60_000, pbjtRateBps: 1000, timezone: 'Asia/Jakarta' };
    const dated = { ...ctx, startedAt: new Date(ctx.startedAt), endedAt: new Date(ctx.endedAt) };
    cases.push({ kind: 'allowance', name: `${tk}@${amount}`, tariff: tk, amount, ctx, out: {
      energy: tariffMod.energyAllowanceWh(tariff, amount, { ...dated, idleMinutes: 0 }),
      driver: tariffMod.driverAllowanceWh(tariff, amount, dated),
      conservative: tariffMod.conservativeAllowanceWh(tariff, amount, dated),
    } });
  }
  for (const w of [7000, 22000, 30000, 60000, 150000]) {
    cases.push({ kind: 'validate', name: `${tk}/${w}`, tariff: tk, maxPowerW: w, out: tariffMod.validateTariff(tariff, w) });
  }
}
for (const sub of [0, 1, 999, 12345, 100_000, 1_234_567, 12_000_000]) {
  for (const bps of [0, 500, 1000, 5000]) {
    for (const ppn of [true, false]) {
      const input = { subtotalIdr: sub, energyIdr: Math.round(sub * 0.8), pbjtRateBps: bps, ppnApplies: ppn };
      cases.push({ kind: 'tax', name: `${sub}/${bps}/${ppn}`, input, out: taxMod.computeTax(input) });
    }
  }
}

// ─────────────────────────────── OCPI objects
const party = { country_code: 'ID', party_id: 'PLS', business_name: 'PT PlugSure', website: 'https://plugsure.id' };
const site = { id: '7b0c8f9e-1a2b-4c3d-8e9f-001122334455', name: 'Summarecon Mall Bekasi', address: 'Jl. Bulevar Ahmad Yani, Bekasi', city: 'Bekasi',
  postal_code: '17142', lat: -6.2246, lon: 106.9998, timezone: 'Asia/Jakarta', last_updated: '2026-09-01T00:00:00Z' };
const conn = { connector_id: 1, connector_type: 'cCCS2', current_type: 'DC', phases: 3, max_power_w: 60000, rated_voltage_v: null, rated_current_a: null,
  status: 'Available', maintenance_reason: null, tariff_id: 't-seed', last_updated: '2026-09-01T00:00:00Z' };
const evse = { ocpp_identity: 'AUTEL-DC60-SMB-002', evse_no: 1, display_name: 'DC 1', decommissioned: false, online: true, connectors: [conn], last_updated: '2026-09-01T00:00:00Z' };
const dates = (o: any): any => JSON.parse(JSON.stringify(o), (k, v) => (/^(last_updated|started_at|ended_at|issued_at|active_from|active_to)$/.test(k) && typeof v === 'string' ? new Date(v) : v));
const token = { country_code: 'NL', party_id: 'EMS', uid: 'TOK-1', type: 'RFID', contract_id: 'NL-EMS-C12345678-X' };
cases.push({ kind: 'ocpi.location', name: 'location', input: { site, evses: [evse] }, out: ocpi.buildLocation(party, dates(site), [dates(evse)]) });
for (const [tk, tariff] of Object.entries(T)) {
  const tin = { tariff, active_from: '2026-01-01T00:00:00Z', active_to: null, last_updated: '2026-09-01T00:00:00Z' };
  cases.push({ kind: 'ocpi.tariff', name: tk, tariff: tk, input: tin, out: ocpi.buildTariff(party, dates(tin)) });
}
for (const c of cases.filter((x) => x.kind === 'rate' && x.out.tax.totalIdr > 0).slice(0, 25)) {
  const tax = c.out.tax;
  const session = { id: '0d2a2f0e-0000-4000-8000-0000000000' + String(cases.indexOf(c)).padStart(2, '0'), state: 'completed', started_at: c.ctx.startedAt, ended_at: c.ctx.endedAt,
    energy_wh: c.ctx.energyWh, auth_method: 'WHITELIST', authorization_reference: null, location_id: site.id, evse_uid: 'AUTEL-DC60-SMB-002-1', connector_id: '1',
    meter_id: 'MID-1', cost: { subtotal_idr: tax.subtotalIdr, pbjt_idr: tax.pbjtIdr, total_idr: tax.totalIdr }, last_updated: c.ctx.endedAt, idle_minutes: c.ctx.idleMinutes };
  cases.push({ kind: 'ocpi.session', name: c.name, input: { session }, out: ocpi.buildSession(party, dates(session), token) });
  const cdrIn = { id: 'cdr-' + c.name, issued_at: c.ctx.endedAt, lines: c.out.lines, subtotal_idr: tax.subtotalIdr, pbjt_idr: tax.pbjtIdr, total_idr: tax.totalIdr,
    tariff: T[c.tariff], session, site, evse, connector: conn };
  cases.push({ kind: 'ocpi.cdr', name: c.name, input: cdrIn, out: ocpi.buildCdr(party, dates(cdrIn), token) });
}

writeFileSync(out, JSON.stringify({ generatedFrom: 'v1.6 (master 977d92c)', env: { PBJT_BASE: process.env.PBJT_BASE ?? null, PBJT_IN_PPN_BASE: process.env.PBJT_IN_PPN_BASE ?? null, ROUNDING_UNIT_IDR: process.env.ROUNDING_UNIT_IDR ?? null }, tariffs: T, cases }, null, 1) + '\n');
console.log(`wrote ${cases.length} golden cases to ${out}`);
