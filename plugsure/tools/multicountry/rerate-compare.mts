// Golden re-rate (docs/MULTI-COUNTRY-DESIGN.md §9 step 4, WP1b acceptance).
//
//     DATABASE_URL=… npx tsx tools/multicountry/rerate-compare.mts [--limit N] [--json]
//
// Against a database migrated to 060 (a copy of the pilot, then production in the
// maintenance window), with the 1.7 code and the SAME tax environment (PBJT_BASE,
// PBJT_IN_PPN_BASE, ROUNDING_UNIT_IDR, PPN_*) the CDRs were issued under:
//
//  1. every CDR's tax stack is recomputed from its own frozen lines by the engine of
//     its scheme: subtotal, local tax, tax base, tax and total must equal the stored
//     columns (a v1.6 CDR's lines say amountIdr; they are read through readMinor);
//  2. every CDR without discount lines (memberships, promotions, points and V2X
//     credits depend on state that has moved on since) is re-rated from scratch —
//     its frozen tariff snapshot, the session's times, energy and idle minutes, the
//     connector's power and the stored PBJT-TL rate — and every line amount and the
//     total must equal what was issued.
//
// Reads only. Exit 0 = zero differences; 1 = differences (listed); 2 = usage.
import pg from 'pg';
import { rateSession, type Tariff } from '../../src/services/tariff.js';
import { engineFor, taxContextFrom, computeTax } from '../../src/services/tax/index.js';
import { upgradeLegacyKeys, currencyOr } from '../../src/domain/money.js';
import { countryOf, countryOfCurrency } from '../../src/domain/country.js';
import { defaultTariff } from '../../src/services/tariff-store.js';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const limit = Number(arg('--limit') ?? 0) || null;
const url = process.env.DATABASE_URL;
if (!url) { console.error('set DATABASE_URL'); process.exit(2); }
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(`SELECT set_config('app.rls_bypass', 'on', false)`).catch(() => {});

const rows = (await client.query(
  `SELECT d.id, d.session_id, d.lines, d.subtotal_minor, d.local_tax_rate_bps, d.local_tax_minor, d.tax_base_minor, d.tax_rate_bps,
          d.tax_minor, d.total_minor, d.rounding_minor, d.currency, d.tax_scheme, d.prices_include_tax, d.tariff_snapshot,
          cs.started_at, cs.ended_at, cs.energy_wh, cs.idle_minutes, c.max_power_w, si.timezone, si.country_code
     FROM cdr d JOIN charging_session cs ON cs.id = d.session_id
     JOIN connector c ON c.id = cs.connector_uuid JOIN site si ON si.id = cs.site_id
    ORDER BY d.issued_at ${limit ? `LIMIT ${limit}` : ''}`)).rows;

const diffs: Array<{ cdr: string; check: string; field: string; stored: unknown; now: unknown }> = [];
let taxChecked = 0, rerated = 0, skipped = 0;
const FIELDS = [['subtotal_minor', 'subtotalMinor'], ['local_tax_minor', 'localTaxMinor'], ['tax_base_minor', 'taxBaseMinor'], ['tax_minor', 'taxMinor'], ['total_minor', 'totalMinor']] as const;

for (const r of rows) {
  const lines: any[] = upgradeLegacyKeys(r.lines ?? []);
  const subtotal = lines.reduce((a, l) => a + Number(l.amountMinor), 0);
  const energy = lines.filter((l) => l.kind === 'energy').reduce((a, l) => a + Number(l.amountMinor), 0);
  const snapshot: Tariff | null = r.tariff_snapshot && r.tariff_snapshot.components ? r.tariff_snapshot : null;
  const ppnApplies = snapshot?.ppnApplies !== false;
  const cur = currencyOr(r.currency);
  const country = countryOfCurrency(cur)!.code;

  // 1. the tax stack from the frozen lines
  const tax = r.tax_scheme === 'ID_PPN_PBJT'
    ? computeTax({ subtotalMinor: subtotal, energyMinor: energy, localTaxRateBps: Number(r.local_tax_rate_bps), ppnApplies })
    : engineFor({ ...taxContextFrom(country, [], null, new Date(r.started_at)), scheme: r.tax_scheme, rateBps: Number(r.tax_rate_bps) })
      .computeSession({ subtotalMinor: subtotal, pricesIncludeTax: r.prices_include_tax });
  taxChecked++;
  for (const [col, key] of FIELDS) {
    if (Number(r[col]) !== Number((tax as any)[key])) diffs.push({ cdr: r.id, check: 'tax', field: col, stored: Number(r[col]), now: (tax as any)[key] });
  }

  // 2. a full re-rate where nothing depended on moving state
  if (lines.some((l) => l.adjustment)) { skipped++; continue; }
  const tariff: Tariff = snapshot ?? defaultTariff(countryOf(r.country_code).code);
  const res = rateSession(structuredClone(tariff), {
    startedAt: new Date(r.started_at), endedAt: new Date(r.ended_at ?? r.started_at), energyWh: Number(r.energy_wh),
    connectorMaxPowerW: Number(r.max_power_w), localTaxRateBps: Number(r.local_tax_rate_bps), idleMinutes: Number(r.idle_minutes ?? 0),
    timezone: r.timezone, currency: cur,
    tax: { ...taxContextFrom(country, [], null, new Date(r.started_at)), scheme: r.tax_scheme, rateBps: Number(r.tax_rate_bps) },
  });
  rerated++;
  const was = lines.map((l) => [l.kind, l.description, Number(l.amountMinor)].join('|')).join('\n');
  const now = res.lines.map((l) => [l.kind, l.description, l.amountMinor].join('|')).join('\n');
  if (was !== now) diffs.push({ cdr: r.id, check: 'rerate', field: 'lines', stored: was, now });
  for (const [col, key] of FIELDS) {
    if (Number(r[col]) !== Number((res.tax as any)[key])) diffs.push({ cdr: r.id, check: 'rerate', field: col, stored: Number(r[col]), now: (res.tax as any)[key] });
  }
}
await client.end();

const summary = { cdrs: rows.length, taxChecked, rerated, skippedWithDiscounts: skipped, differences: diffs.length };
if (process.argv.includes('--json')) console.log(JSON.stringify({ summary, diffs }, null, 2));
else {
  console.log(`re-rate compare: ${JSON.stringify(summary)}`);
  for (const d of diffs.slice(0, 50)) console.log(`  ${d.cdr} ${d.check} ${d.field}: stored ${JSON.stringify(d.stored)} now ${JSON.stringify(d.now)}`);
}
process.exit(diffs.length ? 1 : 0);
