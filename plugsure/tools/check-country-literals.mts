// Country literals outside the places allowed to know Indonesia (docs/MULTI-COUNTRY-DESIGN.md §7).
//
//     npx tsx tools/check-country-literals.mts            check (exit 1 on a new literal)
//     npx tsx tools/check-country-literals.mts --update   rewrite the baseline (only when removing literals)
//
// A literal 'IDR', 'Asia/Jakarta', 'id-ID', "Rp " or +62 in code is Indonesia hardcoded. They
// belong in domain/ (the country and money tables), in the Indonesian modules (tax/id.ts,
// regulatory/id.ts, efaktur.ts, spklu.ts, the Midtrans / Xendit / SNAP adapters) and in tests.
// Comments are ignored. Files that still carry some — Indonesian driver and operator messages
// and the console/driver UI that WP2 moves to formatMoney, the IDR-only payment paths WP3
// generalises — are listed in tools/country-literals-baseline.json with their count: the check
// is a ratchet. A count may only go down; a new file, or more literals in a listed file, fails.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const root = join(import.meta.dirname, '..');
const BASELINE = join(root, 'tools', 'country-literals-baseline.json');
const LITERAL = /'IDR'|"IDR"|`IDR`|Asia\/Jakarta|'id-ID'|"id-ID"|\bRp |\+62/g;

/** Allowed to know Indonesia. */
const ALLOWED = [
  /^src\/domain\//,
  /^src\/services\/tax\/id\.ts$/,
  /^src\/services\/regulatory\/id\.ts$/,
  /^src\/services\/efaktur\.ts$/,
  /^src\/domain\/spklu\.ts$/,
  /^src\/services\/payments\/(midtrans|xendit|snap-qris)\.ts$/,
  /\.test\.ts$/,
  /^src\/api\/openapi\//, // documentation text (examples are Indonesian)
  /^src\/api\/legacy-money\.ts$/, // the v1.6 names themselves
  /^src\/db\/seed\.ts$/, // the Indonesian demo data
  /^src\/web\/js\/money\.js$/, // the console's copy of domain/money + country + timezone (§D10)
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (['.ts', '.js', '.html'].includes(extname(name)) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Code lines only: // and block-comment lines are skipped (a literal in a comment is prose). */
export function countLiterals(text: string): number {
  let n = 0;
  let inBlock = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (inBlock) { if (line.includes('*/')) inBlock = false; continue; }
    if (line.startsWith('/*')) { if (!line.includes('*/')) inBlock = true; continue; }
    if (line.startsWith('//') || line.startsWith('*')) continue;
    const code = line.replace(/\s\/\/\s.*$/, '');
    n += code.match(LITERAL)?.length ?? 0;
  }
  return n;
}

export function scan(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const f of walk(join(root, 'src'))) {
    const rel = relative(root, f);
    if (ALLOWED.some((re) => re.test(rel))) continue;
    const n = countLiterals(readFileSync(f, 'utf8'));
    if (n) found[rel] = n;
  }
  return found;
}

export function check(): string[] {
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as { files: Record<string, number> };
  const problems: string[] = [];
  for (const [f, n] of Object.entries(scan())) {
    const allowed = baseline.files[f] ?? 0;
    if (n > allowed) problems.push(`${f}: ${n} country literal(s), ${allowed} allowed — use domain/country, domain/money (formatMoney) or the site's time zone`);
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--update')) {
    const files = Object.fromEntries(Object.entries(scan()).sort());
    writeFileSync(BASELINE, JSON.stringify({ note: 'Remaining Indonesian literals (WP2: driver/console UI and messages; WP3: IDR-only payment paths). Counts may only go down.', files }, null, 2) + '\n');
    console.log(`baseline: ${Object.keys(files).length} files, ${Object.values(files).reduce((a, b) => a + b, 0)} literals`);
  } else {
    const p = check();
    for (const x of p) console.error(x);
    if (p.length) process.exit(1);
    console.log('country literals: no new ones');
  }
}
