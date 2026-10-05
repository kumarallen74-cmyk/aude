// Benchmark for the driver map (docs/MOBILE-APP-SPEC.md G7): /d/v1/stations before (a headline price per connector,
// two queries each) and after (one batch), and the /d/v1/map viewport queries, on seeded data.
//
//   DATABASE_URL=postgresql://…/plugsure_bench BENCH_CONNECTORS=2000 npx tsx tools/bench/stations-bench.mts
//
// Seeds (once, idempotent) an organisation "Bench CPO" with BENCH_CONNECTORS connectors, 4 per site, sites spread
// over Java, Peninsular Malaysia and Singapore, tariffs assigned per org, per site and per connector. Then times each
// path RUNS times (median, p95). Uses its own database: NEVER point this at production.
import { performance } from 'node:perf_hooks';
import { many, one, query, pool } from '../../src/db/pool.js';
import { listStations, pricesOneByOne } from '../../src/driver/stations.js';
import { headlinePrices } from '../../src/services/tariff-store.js';
import { mapQuery } from '../../src/driver/map.js';

const N = Number(process.env.BENCH_CONNECTORS ?? 2000);
/** Partner (OCPI) locations received by a bench eMSP that lets app drivers roam (the map's partner layer). */
const P = Number(process.env.BENCH_PARTNER_LOCATIONS ?? 3000);
const RUNS = Number(process.env.BENCH_RUNS ?? 7);
if (!/bench/.test(process.env.DATABASE_URL ?? '')) throw new Error('DATABASE_URL must name a bench database (…bench…)');

async function seed(): Promise<string> {
  const org = (await one<{ id: string }>(
    `INSERT INTO organisation (name, slug) VALUES ('Bench CPO', 'bench-cpo') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`))!.id;
  const have = Number((await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id JOIN site s ON s.id = cp.site_id WHERE s.org_id = $1`, [org]))!.n);
  if (have >= N) return org;
  const tOrg = (await one<{ id: string }>(`INSERT INTO tariff (org_id, name, pln_scheme) VALUES ($1, 'Bench org', 'none') RETURNING id`, [org]))!.id;
  await query(`INSERT INTO tariff_component (tariff_id, kind, rate) VALUES ($1, 'energy', 2466), ($1, 'session', 5000)`, [tOrg]);
  await query(`INSERT INTO tariff_assignment (tariff_id, scope_type, scope_id) VALUES ($1, 'org', $2)`, [tOrg, org]);
  const tSite = (await one<{ id: string }>(`INSERT INTO tariff (org_id, name, pln_scheme, pln_multiplier) VALUES ($1, 'Bench formula', 'layanan_khusus', 1.3) RETURNING id`, [org]))!.id;
  const tConn = (await one<{ id: string }>(`INSERT INTO tariff (org_id, name, pln_scheme) VALUES ($1, 'Bench DC', 'none') RETURNING id`, [org]))!.id;
  await query(`INSERT INTO tariff_component (tariff_id, kind, rate) VALUES ($1, 'energy', 3100)`, [tConn]);
  const tMy = (await one<{ id: string }>(`INSERT INTO tariff (org_id, name, pln_scheme, country_code, currency, prices_include_tax) VALUES ($1, 'Bench MY', 'none', 'MY', 'MYR', true) RETURNING id`, [org]))!.id;
  await query(`INSERT INTO tariff_component (tariff_id, kind, rate) VALUES ($1, 'energy', 1.15)`, [tMy]);
  const sites = Math.ceil((N - have) / 4);
  for (let i = 0; i < sites; i++) {
    const r = i % 10;
    // 70 % Java, 20 % Peninsular Malaysia, 10 % Singapore.
    const [cc, lat, lon, tz] = r < 7 ? ['ID', -6.0 - Math.random() * 2.0, 105.5 + Math.random() * 6.5, 'Asia/Jakarta']
      : r < 9 ? ['MY', 1.5 + Math.random() * 5, 100.3 + Math.random() * 3.2, 'Asia/Kuala_Lumpur'] : ['SG', 1.27 + Math.random() * 0.15, 103.65 + Math.random() * 0.3, 'Asia/Singapore'];
    const site = (await one<{ id: string }>(`INSERT INTO site (org_id, name, country_code, lat, lon, timezone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [org, `Bench site ${have + i}`, cc, lat, lon, tz]))!.id;
    if (cc === 'ID' && i % 3 === 0) await query(`INSERT INTO tariff_assignment (tariff_id, scope_type, scope_id) VALUES ($1, 'site', $2)`, [tSite, site]);
    if (cc === 'MY') await query(`INSERT INTO tariff_assignment (tariff_id, scope_type, scope_id) VALUES ($1, 'site', $2)`, [tMy, site]);
    for (let k = 0; k < 4; k++) {
      const cp = (await one<{ id: string }>(`INSERT INTO charge_point (site_id, ocpp_identity, status) VALUES ($1, $2, 'offline') RETURNING id`, [site, `BENCH-${have + i}-${k}`]))!.id;
      const e = (await one<{ id: string }>(`INSERT INTO evse (charge_point_id, evse_id, max_power_w) VALUES ($1, 1, $2) RETURNING id`, [cp, k < 2 ? 22000 : 120000]))!.id;
      const c = (await one<{ id: string }>(`INSERT INTO connector (evse_uuid, connector_id, connector_type, current_type, max_power_w, status) VALUES ($1, 1, $2, $3, $4, 'Available') RETURNING id`,
        [e, k < 2 ? 'sType2' : 'cCCS2', k < 2 ? 'AC' : 'DC', k < 2 ? 22000 : 120000]))!.id;
      if (cc === 'ID' && k === 3 && i % 5 === 0) await query(`INSERT INTO tariff_assignment (tariff_id, scope_type, scope_id) VALUES ($1, 'connector', $2)`, [tConn, c]);
    }
  }
  await query('ANALYZE');
  return org;
}

async function time(label: string, fn: () => Promise<unknown>): Promise<{ label: string; medianMs: number; p95Ms: number; detail: string }> {
  await fn(); // warm
  const ms: number[] = [];
  let detail = '';
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const r = await fn();
    ms.push(performance.now() - t0);
    detail = typeof r === 'string' ? r : '';
  }
  ms.sort((a, b) => a - b);
  return { label, medianMs: Math.round(ms[Math.floor(ms.length / 2)]! * 10) / 10, p95Ms: Math.round(ms[Math.min(ms.length - 1, Math.ceil(ms.length * 0.95) - 1)]! * 10) / 10, detail };
}

/** An eMSP organisation with app roaming on, a connected CPO partner and P remote locations (idempotent). */
async function seedPartners(): Promise<string> {
  const emsp = (await one<{ id: string }>(
    `INSERT INTO organisation (name, slug, roaming_settings) VALUES ('Bench eMSP', 'bench-emsp', '{"appDrivers": true}'::jsonb)
     ON CONFLICT (slug) DO UPDATE SET roaming_settings = EXCLUDED.roaming_settings RETURNING id`))!.id;
  let partner = (await one<{ id: string }>(`SELECT id FROM ocpi_partner WHERE org_id = $1 AND name = 'Bench CPO partner'`, [emsp]))?.id;
  if (!partner) partner = (await one<{ id: string }>(`INSERT INTO ocpi_partner (org_id, name, kind, state) VALUES ($1, 'Bench CPO partner', 'cpo', 'connected') RETURNING id`, [emsp]))!.id;
  const have = Number((await one<{ n: number }>(`SELECT count(*)::int AS n FROM ocpi_remote_location WHERE org_id = $1`, [emsp]))!.n);
  for (let i = have; i < P; i++) {
    const r = i % 10;
    const [cc, lat, lon] = r < 7 ? ['ID', -6.0 - Math.random() * 2.0, 105.5 + Math.random() * 6.5] : r < 9 ? ['MY', 1.5 + Math.random() * 5, 100.3 + Math.random() * 3.2] : ['SG', 1.27 + Math.random() * 0.15, 103.65 + Math.random() * 0.3];
    const id = `BL${i}`;
    const data = { id, name: `Bench partner ${i}`, country_code: cc, party_id: 'BPX', publish: true, address: 'Jl. Bench', city: 'X', coordinates: { latitude: String(lat), longitude: String(lon) }, operator: { name: 'Bench Partner' },
      evses: [{ uid: `${id}-E1`, evse_id: `${cc}*BPX*E${i}`, status: i % 3 ? 'AVAILABLE' : 'CHARGING', connectors: [{ id: '1', standard: 'IEC_62196_T2_COMBO', power_type: 'DC', max_electric_power: 60000, tariff_ids: [] }] }] };
    await query(`INSERT INTO ocpi_remote_location (org_id, partner_id, country_code, party_id, location_id, data, last_updated) VALUES ($1,$2,$3,'BPX',$4,$5, now())`, [emsp, partner, cc, id, JSON.stringify(data)]);
  }
  return emsp;
}

const org = await seed();
const emsp = await seedPartners();
const conns = (await many<{ id: string; org_id: string }>(
  `SELECT c.id, s.org_id FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id JOIN site s ON s.id = cp.site_id
    WHERE s.archived_at IS NULL`)).map((r) => ({ id: r.id, connectorId: r.id, orgId: r.org_id }));
const total = conns.length;
const sites = Number((await one<{ n: number }>(`SELECT count(*)::int AS n FROM site WHERE archived_at IS NULL`))!.n);

// Same answer both ways (the benchmark measures the same work).
const a = await headlinePrices(conns.map((c) => c.id), new Date());
const b = await pricesOneByOne(conns);
const same = conns.every((c) => JSON.stringify(a.get(c.id)) === JSON.stringify(b.get(c.id) ?? undefined));

const rowsOnly = () => many(`SELECT c.id FROM connector c JOIN evse e ON e.id = c.evse_uuid JOIN charge_point cp ON cp.id = e.charge_point_id JOIN site s ON s.id = cp.site_id`);
const results = [
  await time(`prices, one connector at a time (v1.8 listStations) — ${total} connectors`, async () => { await rowsOnly(); await pricesOneByOne(conns); }),
  await time(`prices, batched (headlinePrices) — ${total} connectors`, async () => { await rowsOnly(); await headlinePrices(conns.map((c) => c.id), new Date()); }),
  await time('GET /d/v1/stations (every station, v1.9)', async () => `${(await listStations({ lat: -6.2, lon: 106.8 })).length} stations`),
  await time('GET /d/v1/stations?bbox=Jakarta', async () => `${(await listStations({ lat: -6.2, lon: 106.8 }, null, { bbox: [106.6, -6.4, 107.0, -6.0] })).length} stations`),
  await time('GET /d/v1/map zoom 12 (Jakarta viewport)', async () => {
    const r = await mapQuery({ bbox: [106.6, -6.4, 107.0, -6.0], zoom: 12, filters: {}, cluster: true }, { principal: null, scopeOrg: null, emspBrandOrg: null });
    return `${r.clusters.length} clusters, ${r.stations.length} stations, ${JSON.stringify(r).length} bytes`;
  }),
  await time('GET /d/v1/map zoom 5 (Java + Malaysia + Singapore)', async () => {
    const r = await mapQuery({ bbox: [95, -11, 120, 8], zoom: 5, filters: {}, cluster: true }, { principal: null, scopeOrg: null, emspBrandOrg: null });
    return `${r.clusters.length} clusters, ${r.stations.length} stations, ${JSON.stringify(r).length} bytes`;
  }),
  await time(`GET /d/v1/map zoom 12 (Jakarta) + ${P} partner locations`, async () => {
    const r = await mapQuery({ bbox: [106.6, -6.4, 107.0, -6.0], zoom: 12, filters: {}, cluster: true }, { principal: null, scopeOrg: null, emspBrandOrg: emsp });
    return `${r.clusters.length} clusters, ${r.stations.length} stations, ${r.total} total`;
  }),
  await time(`GET /d/v1/map zoom 15 list (Jakarta, cluster=0, limit 100) + ${P} partner locations`, async () => {
    const r = await mapQuery({ bbox: [106.78, -6.25, 106.86, -6.17], zoom: 15, filters: {}, cluster: false, limit: 100, near: { lat: -6.2, lon: 106.82 } }, { principal: null, scopeOrg: null, emspBrandOrg: emsp });
    return `${r.stations.length} stations of ${r.total}`;
  }),
  await time(`GET /d/v1/map zoom 5 + ${P} partner locations`, async () => {
    const r = await mapQuery({ bbox: [95, -11, 120, 8], zoom: 5, filters: {}, cluster: true }, { principal: null, scopeOrg: null, emspBrandOrg: emsp });
    return `${r.clusters.length} clusters, ${r.stations.length} stations, ${r.total} total`;
  }),
];
console.log(JSON.stringify({ connectors: total, sites, runs: RUNS, sameResult: same, benchOrg: org }, null, 2));
for (const r of results) console.log(`${r.medianMs.toString().padStart(9)} ms median  ${r.p95Ms.toString().padStart(9)} ms p95   ${r.label}${r.detail ? `  (${r.detail})` : ''}`);
await pool.end();
