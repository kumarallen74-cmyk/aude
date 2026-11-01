import { createHash } from 'node:crypto';
import { many, one, outsideRequestScope } from '../db/pool.js';
import { config } from '../config.js';
import { xlsx, zip } from './xlsx.js';

/**
 * Owner and partner finance (v1.38.0). What a site owner (a landlord or investor whose site the operator runs) earns,
 * the way the owner sees it in the portal (Site Owner → Finance), and the operator's view across owners.
 *
 *   summary   per month over the last 12 (or 3, 6): the owner's sites' sessions, kWh and charging revenue (Margin),
 *             and from the finalised statements the gross, the operator's commission, the owner's share, what was paid
 *             and what is still owed. Per site, the year's revenue and kWh. Open queries (disputes) and what they claim.
 *   owners    the operator's view: every owner with sites, the year's share, paid and outstanding, the oldest statement
 *             unpaid, open queries; sorted by what is owed.
 *   pack      an owner's year in one ZIP: statements, payments, monthly results per site (CSV), a README and a manifest
 *             with each file's SHA-256.
 */

export class OwnerFinanceError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERR = (s: number, m: string) => new OwnerFinanceError(s, m);
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const addMonths = (m: string, k: number) => { const [y, mo] = m.split('-').map(Number) as [number, number]; const t = y * 12 + mo - 1 + k; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const r2 = (x: number) => Math.round(x * 100) / 100;

async function ownerRow(orgId: string, ownerId: string) {
  if (!UUID_RE.test(ownerId)) throw ERR(404, 'No such owner.');
  const o = await outsideRequestScope(() => one<any>(`SELECT id::text AS id, name, legal_name, npwp FROM site_owner WHERE id = $1::uuid AND org_id = $2`, [ownerId, orgId]));
  if (!o) throw ERR(404, 'No such owner.');
  return o;
}

function windowOf(q: Record<string, unknown>, now: Date) {
  const months = q.months == null || q.months === '' ? 12 : Number(q.months);
  if (![3, 6, 12].includes(months)) throw ERR(400, 'months is 3, 6 or 12.');
  const to = q.to == null || q.to === '' ? addMonths(today(now).slice(0, 7), -1) : String(q.to);
  if (!MONTH_RE.test(to)) throw ERR(400, 'to is YYYY-MM.');
  const from = addMonths(to, -(months - 1));
  return { months, from, to, list: Array.from({ length: months }, (_, k) => addMonths(from, k)) };
}

/** The statements (finalised) with what was paid against each, from a month to a month. */
async function statements(orgId: string, ownerId: string, from: string, to: string) {
  const [st, pays] = await outsideRequestScope(() => Promise.all([
    many<any>(`SELECT id::text AS id, number, to_char(period, 'YYYY-MM') AS period, currency, gtv_minor, commission_minor, owner_share_minor, to_char(finalised_at AT TIME ZONE $5, 'YYYY-MM-DD') AS fin
                 FROM commission_statement WHERE org_id = $1 AND owner_id::text = $2 AND finalised_at IS NOT NULL AND to_char(period, 'YYYY-MM') BETWEEN $3 AND $4 ORDER BY period`, [orgId, ownerId, from, to, zone()]),
    many<any>(`SELECT p.statement_id::text AS sid, p.amount_minor, p.currency, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.reference FROM statement_payment p JOIN commission_statement s ON s.id = p.statement_id
                WHERE s.org_id = $1 AND s.owner_id::text = $2 AND p.kind = 'owner_payout' AND p.voided_at IS NULL ORDER BY p.paid_on`, [orgId, ownerId]),
  ]));
  return st.map((s) => {
    const mine = pays.filter((p) => p.sid === s.id), share = Number(s.owner_share_minor), paid = mine.reduce((a, p) => a + Number(p.amount_minor), 0);
    return { id: s.id, number: s.number, period: s.period, currency: s.currency, gross: Number(s.gtv_minor), commission: Number(s.commission_minor), share, paid, outstanding: Math.max(0, share - paid), finalisedOn: s.fin,
      payments: mine.map((p) => ({ paidOn: p.paid_on, amount: Number(p.amount_minor), reference: p.reference ?? null })) };
  });
}

/** The owner's sites' charging per month (Margin), for the window. */
async function siteMonths(orgId: string, ownerId: string, list: string[]) {
  const sites = await outsideRequestScope(() => many<{ id: string; name: string }>(`SELECT id::text AS id, name FROM site WHERE org_id = $1 AND owner_id::text = $2 ORDER BY name`, [orgId, ownerId]));
  if (!sites.length) return { sites: [], rows: [] as Array<{ month: string; siteId: string; site: string; currency: string; sessions: number; kwh: number; revenue: number }> };
  const em = await import('./energy-margin.js');
  const ids = new Set(sites.map((s) => s.id));
  const rows: Array<{ month: string; siteId: string; site: string; currency: string; sessions: number; kwh: number; revenue: number }> = [];
  for (const m of list) {
    const r = await em.month(orgId, m);
    for (const s of r.sites) if (ids.has(String(s.siteId))) rows.push({ month: m, siteId: String(s.siteId), site: s.site, currency: s.currency, sessions: s.sessions, kwh: s.kwh, revenue: s.revenue });
  }
  return { sites, rows };
}

export async function summary(orgId: string, ownerId: string, q: Record<string, unknown> = {}, now = new Date()) {
  const o = await ownerRow(orgId, ownerId);
  const w = windowOf(q, now);
  const [st, sm, disputes] = await Promise.all([
    statements(orgId, o.id, w.from, w.to), siteMonths(orgId, o.id, w.list),
    outsideRequestScope(() => many<any>(`SELECT count(*)::int AS n, COALESCE(sum(claimed_minor), 0)::bigint AS claimed FROM owner_statement_dispute WHERE org_id = $1 AND owner_id::text = $2 AND state = 'open'`, [orgId, o.id])),
  ]);
  const currencies = [...new Set([...st.map((s) => s.currency), ...sm.rows.map((r) => r.currency)])].sort();
  const byCurrency = currencies.map((currency) => {
    const months = w.list.map((m) => {
      const rs = sm.rows.filter((r) => r.month === m && r.currency === currency), ss = st.filter((s) => s.period === m && s.currency === currency);
      return {
        month: m, sessions: rs.reduce((a, r) => a + r.sessions, 0), kwh: r2(rs.reduce((a, r) => a + r.kwh, 0)), revenue: rs.reduce((a, r) => a + r.revenue, 0),
        gross: ss.reduce((a, s) => a + s.gross, 0), commission: ss.reduce((a, s) => a + s.commission, 0), share: ss.reduce((a, s) => a + s.share, 0),
        paid: ss.reduce((a, s) => a + s.paid, 0), outstanding: ss.reduce((a, s) => a + s.outstanding, 0), statement: ss[0]?.number ?? null,
      };
    });
    const T = (k: 'sessions' | 'kwh' | 'revenue' | 'gross' | 'commission' | 'share' | 'paid' | 'outstanding') => months.reduce((a, m) => a + m[k], 0);
    const sites = sm.sites.map((s) => {
      const rs = sm.rows.filter((r) => r.siteId === s.id && r.currency === currency);
      return { siteId: s.id, site: s.name, sessions: rs.reduce((a, r) => a + r.sessions, 0), kwh: r2(rs.reduce((a, r) => a + r.kwh, 0)), revenue: rs.reduce((a, r) => a + r.revenue, 0) };
    }).filter((s) => s.sessions || s.revenue);
    const share = T('share'), gross = T('gross');
    return { currency, months, sites, totals: { sessions: T('sessions'), kwh: r2(T('kwh')), revenue: T('revenue'), gross, commission: T('commission'), share, paid: T('paid'), outstanding: T('outstanding'), sharePct: gross ? Math.round((share / gross) * 1000) / 10 : null } };
  });
  return {
    owner: { id: o.id, name: o.name, legalName: o.legal_name ?? null }, from: w.from, to: w.to, months: w.months, currencies: byCurrency,
    statements: st.slice().reverse(), openQueries: { count: disputes[0]?.n ?? 0, claimed: Number(disputes[0]?.claimed ?? 0) }, siteCount: sm.sites.length,
  };
}

/** The operator's view: every owner, the window's share, paid and outstanding. */
export async function owners(orgId: string, q: Record<string, unknown> = {}, now = new Date()) {
  const w = windowOf(q, now);
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT o.id::text AS id, o.name, (SELECT count(*)::int FROM site s WHERE s.owner_id = o.id AND s.org_id = o.org_id AND s.archived_at IS NULL) AS sites,
            st.currency, COALESCE(sum(st.owner_share_minor), 0)::bigint AS share, COALESCE(sum(st.gtv_minor), 0)::bigint AS gross,
            COALESCE(sum((SELECT COALESCE(sum(p.amount_minor), 0) FROM statement_payment p WHERE p.statement_id = st.id AND p.kind = 'owner_payout' AND p.voided_at IS NULL)), 0)::bigint AS paid,
            min(CASE WHEN st.owner_share_minor > (SELECT COALESCE(sum(p.amount_minor), 0) FROM statement_payment p WHERE p.statement_id = st.id AND p.kind = 'owner_payout' AND p.voided_at IS NULL) THEN to_char(st.period, 'YYYY-MM') END) AS oldest_unpaid,
            (SELECT count(*)::int FROM owner_statement_dispute d WHERE d.owner_id = o.id AND d.org_id = o.org_id AND d.state = 'open') AS queries
       FROM site_owner o LEFT JOIN commission_statement st ON st.owner_id = o.id AND st.org_id = o.org_id AND st.finalised_at IS NOT NULL AND to_char(st.period, 'YYYY-MM') BETWEEN $2 AND $3
      WHERE o.org_id = $1 AND o.archived_at IS NULL GROUP BY o.id, o.name, o.org_id, st.currency`, [orgId, w.from, w.to]));
  const list = rows.map((r) => {
    const share = Number(r.share), paid = Number(r.paid);
    return { ownerId: r.id, owner: r.name, sites: r.sites, currency: r.currency ?? null, gross: Number(r.gross), share, paid, outstanding: Math.max(0, share - paid), oldestUnpaid: r.oldest_unpaid ?? null, openQueries: r.queries };
  }).sort((a, b) => b.outstanding - a.outstanding || b.share - a.share || a.owner.localeCompare(b.owner));
  const totals: Record<string, { share: number; paid: number; outstanding: number; owners: number }> = {};
  for (const r of list) { if (!r.currency) continue; const t = (totals[r.currency] ??= { share: 0, paid: 0, outstanding: 0, owners: 0 }); t.share += r.share; t.paid += r.paid; t.outstanding += r.outstanding; t.owners++; }
  return { from: w.from, to: w.to, months: w.months, owners: list, totals };
}

export async function summaryXlsx(orgId: string, ownerId: string, q: Record<string, unknown> = {}, now = new Date()): Promise<Buffer> {
  const s = await summary(orgId, ownerId, q, now);
  return xlsx([
    { name: 'By month', rows: [['Currency', 'Month', 'Sessions', 'kWh', 'Revenue', 'Statement', 'Gross', 'Commission', 'Your share', 'Paid', 'Outstanding'],
      ...s.currencies.flatMap((c) => c.months.map((m) => [c.currency, m.month, m.sessions, m.kwh, m.revenue, m.statement ?? '', m.gross, m.commission, m.share, m.paid, m.outstanding]))],
      widths: [8, 9, 9, 10, 14, 14, 14, 14, 14, 14, 14], formats: [null, null, null, null, 'money', null, 'money', 'money', 'money', 'money', 'money'] },
    { name: 'By site', rows: [['Currency', 'Site', 'Sessions', 'kWh', 'Revenue'], ...s.currencies.flatMap((c) => c.sites.map((x) => [c.currency, x.site, x.sessions, x.kwh, x.revenue]))], widths: [8, 28, 9, 10, 14], formats: [null, null, null, null, 'money'] },
    { name: 'Statements', rows: [['Statement', 'Period', 'Currency', 'Gross', 'Commission', 'Your share', 'Paid', 'Outstanding', 'Finalised'], ...s.statements.map((x) => [x.number, x.period, x.currency, x.gross, x.commission, x.share, x.paid, x.outstanding, x.finalisedOn])],
      widths: [14, 9, 8, 14, 14, 14, 14, 14, 11], formats: [null, null, null, 'money', 'money', 'money', 'money', 'money', null] },
  ]);
}

const csv = (rows: Array<Array<string | number | null>>) => Buffer.from(rows.map((r) => r.map((v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\n') + '\n');

/** An owner's year in one ZIP (CSV files, a README and a manifest with SHA-256). */
export async function pack(orgId: string, ownerId: string, yearRaw: unknown, now = new Date()) {
  const year = Number(yearRaw ?? Number(today(now).slice(0, 4)) - 1);
  if (!Number.isInteger(year) || year < 2000 || year > Number(today(now).slice(0, 4))) throw ERR(400, 'year is a past or the current year.');
  const o = await ownerRow(orgId, ownerId);
  const list = Array.from({ length: 12 }, (_, k) => `${year}-${String(k + 1).padStart(2, '0')}`).filter((m) => m <= today(now).slice(0, 7));
  const [st, sm] = await Promise.all([statements(orgId, o.id, `${year}-01`, `${year}-12`), siteMonths(orgId, o.id, list)]);
  const files = [
    { name: 'statements.csv', data: csv([['statement', 'period', 'currency', 'gross', 'commission', 'owner_share', 'paid', 'outstanding', 'finalised_on'], ...st.map((s) => [s.number, s.period, s.currency, s.gross, s.commission, s.share, s.paid, s.outstanding, s.finalisedOn])]) },
    { name: 'payments.csv', data: csv([['statement', 'period', 'currency', 'paid_on', 'amount', 'reference'], ...st.flatMap((s) => s.payments.map((p) => [s.number, s.period, s.currency, p.paidOn, p.amount, p.reference]))]) },
    { name: 'sites-by-month.csv', data: csv([['month', 'site', 'currency', 'sessions', 'kwh', 'revenue'], ...sm.rows.map((r) => [r.month, r.site, r.currency, r.sessions, r.kwh, r.revenue])]) },
    { name: 'README.txt', data: Buffer.from(`${o.name}: ${year}\n\nAmounts are in minor units of the currency (rupiah have none).\n\nstatements.csv      each finalised statement: the gross, the operator's commission, your share, paid and outstanding\npayments.csv        each payout against a statement\nsites-by-month.csv  your sites' sessions, kWh and charging revenue per month\nmanifest.json       each file's SHA-256\n`) },
  ];
  const manifest = Buffer.from(JSON.stringify({ owner: o.name, year, generatedAt: now.toISOString(), files: files.map((f) => ({ name: f.name, bytes: f.data.length, sha256: createHash('sha256').update(f.data).digest('hex') })) }, null, 2));
  const all = [...files, { name: 'manifest.json', data: manifest }];
  return { buffer: zip(all), name: `owner-${o.name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${year}.zip`, manifestSha256: createHash('sha256').update(manifest).digest('hex') };
}
