import { createHash } from 'node:crypto';
import { many, one, outsideRequestScope } from '../db/pool.js';
import { config } from '../config.js';
import { pnl } from './shared-costs.js';
import { lockedAmong, lock } from './finance-periods.js';
import { xlsx, zip, type Cell } from './xlsx.js';

/**
 * Year-end close and reports (v1.24.0), Finance → Year end:
 *
 *   months     revenue, energy cost, shared costs, depreciation and contribution per month (the site P&L, summed), and
 *              whether each month is locked
 *   sites      the year per site: sessions, kWh, revenue, energy, shared costs, depreciation, contribution
 *   owners     each site owner's statements of the year: their share, what was paid, what is still due
 *   PPh 23     the year's withholding records with their bukti potong (those without one flagged), per month
 *   filings    the tax obligations marked filed per month (Tax calendar)
 *
 * Close the year: every month of it is locked (Finance → Month close) once the year has ended. The year-end pack is one ZIP
 * for the accountant: the workbook, each table as CSV, a README and a manifest with each file's SHA-256.
 */

export class YearEndError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const zone = () => config.billing.timeZone;
const thisYear = () => Number(new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(new Date()).slice(0, 4));
const monthsOf = (y: number) => Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);

function yearOf(raw: unknown): number {
  const y = Number(raw);
  if (!Number.isInteger(y) || y < 2000 || y > thisYear()) throw new YearEndError(422, 'year is a past or the current year (YYYY).');
  return y;
}

export async function summary(orgId: string, yearRaw: unknown) {
  const y = yearOf(yearRaw);
  const months = monthsOf(y);
  const cur = new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(new Date()).slice(0, 7);
  const upTo = months.filter((m) => m <= cur);
  const [pnls, locked, owners, wht, filings] = await Promise.all([
    Promise.all(upTo.map((m) => pnl(orgId, m))),
    lockedAmong(orgId, months),
    outsideRequestScope(() => many<any>(
      `SELECT o.id, o.name, s.currency, count(s.id)::int AS statements, COALESCE(sum(s.owner_share_minor), 0)::bigint AS share,
              COALESCE(sum((SELECT COALESCE(sum(p.amount_minor), 0) FROM statement_payment p WHERE p.statement_id = s.id AND p.voided_at IS NULL)), 0)::bigint AS paid
         FROM commission_statement s JOIN site_owner o ON o.id = s.owner_id
        WHERE s.org_id = $1 AND s.finalised_at IS NOT NULL AND to_char(s.period, 'YYYY') = $2
        GROUP BY 1, 2, 3 ORDER BY 2`, [orgId, String(y)])),
    outsideRequestScope(() => many<any>(
      `SELECT id, kind, period, counterparty, counterparty_npwp, base_minor, rate_bps, amount_minor, bukti_number, to_char(bukti_date, 'YYYY-MM-DD') AS bukti_date
         FROM tax_withholding WHERE org_id = $1 AND voided_at IS NULL AND period LIKE $2 ORDER BY period, id`, [orgId, `${y}-%`])),
    outsideRequestScope(() => many<any>(
      `SELECT obligation, period, to_char(filed_on, 'YYYY-MM-DD') AS filed_on, reference, amount_minor FROM tax_filing
        WHERE org_id = $1 AND voided_at IS NULL AND period LIKE $2 ORDER BY period, obligation`, [orgId, `${y}-%`])),
  ]);
  type Tot = { revenue: number; energyCost: number; shared: number; depreciation: number; contribution: number };
  const byMonth = upTo.map((m, i) => ({ month: m, locked: locked.includes(m), totals: pnls[i]!.totals as Record<string, Tot> }));
  const sites = new Map<string, any>();
  for (const p of pnls) {
    for (const s of p.sites) {
      const t = sites.get(s.siteId) ?? { siteId: s.siteId, site: s.site, currency: s.currency, sessions: 0, kwh: 0, revenue: 0, energyCost: 0, shared: 0, depreciation: 0, contribution: 0 };
      t.sessions += s.sessions; t.kwh += s.kwh; t.revenue += s.revenue; t.energyCost += s.energyCost ?? 0; t.shared += s.sharedTotal; t.depreciation += s.depreciation; t.contribution += s.contribution;
      sites.set(s.siteId, t);
    }
  }
  const totals: Record<string, Tot> = {};
  for (const m of byMonth) for (const [c, t] of Object.entries(m.totals)) {
    const a = totals[c] ?? { revenue: 0, energyCost: 0, shared: 0, depreciation: 0, contribution: 0 };
    a.revenue += t.revenue; a.energyCost += t.energyCost; a.shared += t.shared; a.depreciation += t.depreciation; a.contribution += t.contribution;
    totals[c] = a;
  }
  const whtRows = wht.map((w) => ({ id: String(w.id), kind: w.kind, period: w.period, counterparty: w.counterparty, npwp: w.counterparty_npwp ?? null, base: Number(w.base_minor), ratePct: Number(w.rate_bps) / 100, amount: Number(w.amount_minor), bukti: w.bukti_number ?? null, buktiDate: w.bukti_date ?? null }));
  return {
    year: y, ended: y < thisYear(), monthsLocked: locked.length, months: byMonth, totals,
    sites: [...sites.values()].map((s) => ({ ...s, kwh: Math.round(s.kwh * 10) / 10 })).sort((a, b) => a.site.localeCompare(b.site)),
    owners: owners.map((o) => ({ ownerId: o.id, owner: o.name, currency: o.currency, statements: o.statements, share: Number(o.share), paid: Number(o.paid), outstanding: Math.max(0, Number(o.share) - Number(o.paid)) })),
    pph23: { records: whtRows, total: whtRows.reduce((a, w) => a + w.amount, 0), withoutBukti: whtRows.filter((w) => !w.bukti).length },
    filings: filings.map((f) => ({ obligation: f.obligation, period: f.period, filedOn: f.filed_on, reference: f.reference, amount: f.amount_minor == null ? null : Number(f.amount_minor) })),
  };
}

/** Lock every month of an ended year (those already locked stay as they are). */
export async function closeYear(orgId: string, yearRaw: unknown, userId: string | null) {
  const y = yearOf(yearRaw);
  if (y >= thisYear()) throw new YearEndError(409, `${y} has not ended yet.`);
  const months = monthsOf(y);
  const already = await lockedAmong(orgId, months);
  const locked: string[] = [];
  for (const m of months.filter((x) => !already.includes(x))) { await lock(orgId, m, `Year ${y} closed`, userId); locked.push(m); }
  return { year: y, locked, alreadyLocked: already };
}

const sheetOf = (name: string, header: string[], rows: Cell[][], formats?: Array<'money' | 'int' | 'pct' | null>) => ({ name, rows: [header, ...rows], formats, widths: header.map((h) => Math.max(12, h.length + 2)) });
const csvOf = (rows: Cell[][]) => rows.map((r) => r.map((v) => (v == null ? '' : /[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(',')).join('\r\n') + '\r\n';

/** The accountant's year-end pack: workbook + CSVs + README + manifest. */
export async function pack(orgId: string, yearRaw: unknown) {
  const s = await summary(orgId, yearRaw);
  const orgName = (await outsideRequestScope(() => one<{ name: string }>(`SELECT name FROM organisation WHERE id = $1`, [orgId])))?.name ?? '';
  const monthsRows: Cell[][] = s.months.flatMap((m) => Object.entries(m.totals).map(([c, t]) => [m.month, c, t.revenue, t.energyCost, t.shared, t.depreciation, t.contribution, m.locked ? 'locked' : 'open']));
  const siteRows: Cell[][] = s.sites.map((x) => [x.site, x.currency, x.sessions, x.kwh, x.revenue, x.energyCost, x.shared, x.depreciation, x.contribution]);
  const ownerRows: Cell[][] = s.owners.map((o) => [o.owner, o.currency, o.statements, o.share, o.paid, o.outstanding]);
  const whtRows: Cell[][] = s.pph23.records.map((w) => [w.period, w.kind, w.counterparty, w.npwp, w.base, w.ratePct, w.amount, w.bukti, w.buktiDate]);
  const filingRows: Cell[][] = s.filings.map((f) => [f.period, f.obligation, f.filedOn, f.reference, f.amount]);
  const sheets = [
    sheetOf('Months', ['Month', 'Currency', 'Revenue', 'Energy cost', 'Shared costs', 'Depreciation', 'Contribution', 'Lock'], monthsRows, [null, null, 'int', 'int', 'int', 'int', 'int', null]),
    sheetOf('Sites', ['Site', 'Currency', 'Sessions', 'kWh', 'Revenue', 'Energy cost', 'Shared costs', 'Depreciation', 'Contribution'], siteRows, [null, null, 'int', null, 'int', 'int', 'int', 'int', 'int']),
    sheetOf('Owners', ['Owner', 'Currency', 'Statements', 'Share', 'Paid', 'Outstanding'], ownerRows, [null, null, 'int', 'int', 'int', 'int']),
    sheetOf('PPh 23', ['Period', 'Kind', 'Paid to', 'NPWP', 'Base', 'Rate %', 'Withheld', 'Bukti potong', 'Bukti date'], whtRows, [null, null, null, null, 'int', null, 'int', null, null]),
    sheetOf('Tax filings', ['Period', 'Obligation', 'Filed on', 'Reference', 'Amount'], filingRows, [null, null, null, null, 'int']),
  ];
  const files: Array<{ name: string; data: Buffer }> = [
    { name: `year-end-${s.year}.xlsx`, data: xlsx(sheets) },
    ...sheets.map((sh) => ({ name: `${sh.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv`, data: Buffer.from(csvOf(sh.rows as Cell[][]), 'utf8') })),
    { name: 'README.txt', data: Buffer.from([
      `${orgName}: year-end pack for ${s.year}, from PlugSure Finance (${new Date().toISOString()}).`,
      '',
      `Months locked: ${s.monthsLocked} of 12${s.ended ? '' : ' (the year has not ended)'}.`,
      `PPh 23 withheld: ${s.pph23.records.length} records; ${s.pph23.withoutBukti} without a bukti potong number.`,
      'Amounts are in the minor unit of each currency (rupiah have none).',
      'Check each file against manifest.json: sha256sum <file>.',
    ].join('\n'), 'utf8') },
  ];
  const manifest = { organisation: orgName, year: s.year, generatedAt: new Date().toISOString(), files: files.map((f) => ({ name: f.name, bytes: f.data.length, sha256: createHash('sha256').update(f.data).digest('hex') })) };
  const m = Buffer.from(JSON.stringify(manifest, null, 2));
  return { body: zip([...files, { name: 'manifest.json', data: m }]), manifestSha256: createHash('sha256').update(m).digest('hex'), year: s.year };
}
