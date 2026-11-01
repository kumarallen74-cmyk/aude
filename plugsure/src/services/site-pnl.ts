import { many, one, outsideRequestScope } from '../db/pool.js';
import { config } from '../config.js';
import { pnl as basePnl } from './shared-costs.js';
import { computeMonth } from './landlord-deals.js';
import { monthShare } from './insurance.js';
import { releaseIn } from './grants.js';
import { list as workOrders } from './maintenance.js';
import { PdfDoc, Flow } from './pdf.js';
import { xlsx } from './xlsx.js';

/**
 * Site P&L and portfolio review (v1.37.0): each site's full result over the last n whole months (default 6), built on
 * the month's site P&L (Cost allocation: revenue, energy cost, shared costs, depreciation of the site's investments) and
 * adding what later modules know about the site:
 *
 *   rent          its landlord deal's amount for each month (Landlords; the fixed rent of a deal held in a lease is
 *                 left out, as there — the lease's depreciation is in Leases, not here)
 *   maintenance   the net cost of its work orders done (or opened) in the month (labour, parts, contractors, accruals,
 *                 less warranty recovered)
 *   insurance     the month's share of the premium of its paid policies (a site's, or a charger's at the site)
 *   grants        the month's release of capital grants for the site (income)
 *
 *   contribution  revenue − energy − shared costs − depreciation − rent − maintenance − insurance + grants
 *   operating     the contribution before depreciation and grants: what the site makes in cash terms
 *
 * The review ranks the sites of each currency by contribution and gives each a signal with its reasons:
 *   close_review  the operating result negative in most months and in all: it does not pay its running costs
 *   fix           operating positive but the contribution negative, or a cost far out of line (rent over 30% of revenue,
 *                 maintenance per kWh over twice the portfolio's median, energy over 80% of revenue)
 *   grow          contribution in the top quarter and the last three months better than the three before
 *   keep          otherwise
 */

export class SitePnlError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const zone = () => config.billing.timeZone;
const thisMonth = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now).slice(0, 7);
const addMonths = (m: string, k: number) => { const [y, mo] = m.split('-').map(Number) as [number, number]; const t = y * 12 + mo - 1 + k; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; };
const r1 = (n: number) => Math.round(n * 10) / 10;
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

export interface SiteTotals { revenue: number; kwh: number; energyCost: number; shared: number; depreciation: number; rent: number; maintenance: number; insurance: number; grants: number; contribution: number; operating: number }

/** The signal of a site from its totals and monthly operating results. Pure. */
export function signal(t: SiteTotals, monthlyOperating: number[], monthlyContribution: number[], ctx: { topQuartile: number | null; maintPerKwhMedian: number | null }) {
  const reasons: string[] = [];
  const negMonths = monthlyOperating.filter((x) => x < 0).length;
  if (t.revenue > 0 && t.rent / t.revenue > 0.3) reasons.push(`rent is ${r1((t.rent / t.revenue) * 100)}% of revenue`);
  if (t.revenue > 0 && t.energyCost / t.revenue > 0.8) reasons.push(`energy is ${r1((t.energyCost / t.revenue) * 100)}% of revenue`);
  if (t.revenue === 0 && t.energyCost + t.rent + t.maintenance > 0) reasons.push('no revenue');
  const mpk = t.kwh ? t.maintenance / t.kwh : null;
  if (mpk != null && ctx.maintPerKwhMedian && ctx.maintPerKwhMedian > 0 && mpk > 2 * ctx.maintPerKwhMedian) reasons.push(`maintenance is ${r1(mpk / ctx.maintPerKwhMedian)}× the portfolio's per kWh`);
  const n = monthlyContribution.length, half = Math.min(3, Math.floor(n / 2));
  const recent = monthlyContribution.slice(-half).reduce((a, x) => a + x, 0), before = monthlyContribution.slice(-2 * half, -half).reduce((a, x) => a + x, 0);
  const improving = half > 0 && recent > before;
  if (t.operating < 0 && negMonths > monthlyOperating.length / 2) return { signal: 'close_review' as const, reasons: [`operating loss in ${negMonths} of ${monthlyOperating.length} months`, ...reasons] };
  if (t.contribution < 0 || reasons.length) return { signal: 'fix' as const, reasons: t.contribution < 0 ? ['contribution negative after depreciation', ...reasons] : reasons };
  if (ctx.topQuartile != null && t.contribution >= ctx.topQuartile && improving) return { signal: 'grow' as const, reasons: ['top quarter of the portfolio and improving'] };
  return { signal: 'keep' as const, reasons: improving ? ['improving'] : [] };
}

export async function review(orgId: string, q: { months?: unknown; to?: unknown } = {}, now = new Date()) {
  const n = q.months == null || q.months === '' ? 6 : Number(q.months);
  if (!Number.isInteger(n) || n < 1 || n > 24) throw new SitePnlError(400, 'months is 1 to 24.');
  const last = q.to ? String(q.to) : addMonths(thisMonth(now), -1);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(last) || last >= thisMonth(now)) throw new SitePnlError(400, 'to is YYYY-MM, a month that has ended.');
  const months: string[] = [];
  for (let k = n - 1; k >= 0; k--) months.push(addMonths(last, -k));
  const [bases, deals, policies, grants, wos] = await Promise.all([
    Promise.all(months.map((m) => basePnl(orgId, m))),
    outsideRequestScope(() => many<any>(`SELECT d.*, to_char(d.start_on, 'YYYY-MM-DD') AS start_s, to_char(d.end_on, 'YYYY-MM-DD') AS end_s FROM landlord_deal d WHERE d.org_id = $1`, [orgId])),
    outsideRequestScope(() => many<any>(`SELECT p.premium_minor, p.currency, COALESCE(p.site_id, cp.site_id) AS site_id, to_char(p.start_on, 'YYYY-MM-DD') AS s, to_char(p.end_on, 'YYYY-MM-DD') AS e
      FROM insurance_policy p LEFT JOIN charge_point cp ON cp.id = p.charge_point_id WHERE p.org_id = $1 AND p.status = 'active' AND p.paid_on IS NOT NULL AND COALESCE(p.site_id, cp.site_id) IS NOT NULL`, [orgId])),
    outsideRequestScope(() => many<any>(`SELECT g.id, g.site_id, g.release_months, (SELECT json_agg(json_build_object('month', to_char(c.paid_on, 'YYYY-MM'), 'amount', COALESCE(c.paid_minor, c.amount_minor))) FROM grant_claim c WHERE c.grant_id = g.id AND c.status = 'paid') AS receipts,
      (SELECT to_char(min(on_date), 'YYYY-MM') FROM grant_clawback x WHERE x.grant_id = g.id) AS stop FROM grant_programme g WHERE g.org_id = $1 AND g.kind = 'capital' AND g.site_id IS NOT NULL`, [orgId])),
    workOrders(orgId),
  ]);
  type Acc = SiteTotals & { siteId: string; site: string; currency: string; sessions: number; monthly: Array<{ month: string; contribution: number; operating: number }> };
  const acc = new Map<string, Acc>();
  bases.forEach((b, i) => {
    const m = months[i]!;
    for (const s of b.sites) {
      const a = acc.get(s.siteId) ?? { siteId: s.siteId, site: s.site, currency: s.currency, sessions: 0, revenue: 0, kwh: 0, energyCost: 0, shared: 0, depreciation: 0, rent: 0, maintenance: 0, insurance: 0, grants: 0, contribution: 0, operating: 0, monthly: [] };
      const rent = deals.filter((d) => d.site_id === s.siteId && d.currency === s.currency).reduce((x, d) => x + computeMonth({ basis: d.basis, fixed: Number(d.fixed_minor), sharePct: Number(d.share_pct), minimum: Number(d.minimum_minor), escalationPct: Number(d.escalation_pct),
        rentFreeMonths: d.rent_free_months, rechargePerKwh: Number(d.recharge_per_kwh), startOn: d.start_s, endOn: d.end_s ?? null, inLease: !!d.lease_id }, m, { revenue: s.revenue, kwh: s.kwh, energyCost: s.energyCost, shareOf: d.share_of }).total, 0);
      const maint = wos.filter((w) => w.siteId === s.siteId && w.currency === s.currency && w.status !== 'cancelled' && (w.doneOn ?? w.openedOn).slice(0, 7) === m).reduce((x, w) => x + w.cost.net, 0);
      const ins = policies.filter((p) => p.site_id === s.siteId && p.currency === s.currency).reduce((x, p) => x + monthShare(Number(p.premium_minor), p.s, p.e, m), 0);
      const gr = grants.filter((g) => g.site_id === s.siteId).reduce((x, g) => x + releaseIn((g.receipts ?? []).map((r: any) => ({ month: r.month, amount: Number(r.amount) })), g.release_months ?? 96, m, g.stop), 0);
      const operating = s.revenue - (s.energyCost ?? 0) - s.sharedTotal - rent - maint - ins;
      const contribution = operating - s.depreciation + gr;
      a.sessions += s.sessions; a.revenue += s.revenue; a.kwh += s.kwh; a.energyCost += s.energyCost ?? 0; a.shared += s.sharedTotal; a.depreciation += s.depreciation;
      a.rent += rent; a.maintenance += maint; a.insurance += ins; a.grants += gr; a.operating += operating; a.contribution += contribution;
      a.monthly.push({ month: m, contribution, operating });
      acc.set(s.siteId, a);
    }
  });
  const all = [...acc.values()].filter((a) => a.revenue || a.kwh || a.rent || a.maintenance || a.depreciation);
  type Row = Acc & { rank: number; of: number; marginPct: number | null; perKwh: number | null; signal: 'close_review' | 'fix' | 'grow' | 'keep'; reasons: string[] };
  const sites: Row[] = [];
  for (const cur of [...new Set(all.map((a) => a.currency))]) {
    const mine = all.filter((a) => a.currency === cur).sort((a, b) => b.contribution - a.contribution);
    const sorted = mine.map((a) => a.contribution).sort((a, b) => a - b);
    const topQuartile = sorted.length >= 4 ? sorted[Math.floor(sorted.length * 0.75)]! : null;
    const mpk = median(mine.filter((a) => a.kwh > 0 && a.maintenance > 0).map((a) => a.maintenance / a.kwh));
    mine.forEach((a, i) => {
      const sg = signal(a, a.monthly.map((x) => x.operating), a.monthly.map((x) => x.contribution), { topQuartile, maintPerKwhMedian: mpk });
      sites.push({ ...a, kwh: r1(a.kwh), rank: i + 1, of: mine.length, marginPct: a.revenue ? r1((a.contribution / a.revenue) * 100) : null, perKwh: a.kwh ? Math.round(a.contribution / a.kwh) : null, ...sg });
    });
  }
  const totals: Record<string, SiteTotals & { sites: number; signals: Record<string, number> }> = {};
  for (const s of sites) {
    const t = (totals[s.currency] ??= { sites: 0, revenue: 0, kwh: 0, energyCost: 0, shared: 0, depreciation: 0, rent: 0, maintenance: 0, insurance: 0, grants: 0, contribution: 0, operating: 0, signals: {} });
    t.sites++; for (const k of ['revenue', 'kwh', 'energyCost', 'shared', 'depreciation', 'rent', 'maintenance', 'insurance', 'grants', 'contribution', 'operating'] as const) t[k] += s[k];
    t.signals[s.signal] = (t.signals[s.signal] ?? 0) + 1;
  }
  return { months, sites, totals };
}

const money = (n: number, c: string) => `${c} ${Math.round(n).toLocaleString('en-US')}`;
const SIG = { close_review: 'Review for closure', fix: 'Fix', grow: 'Grow', keep: 'Keep' } as const;

export async function reviewXlsx(orgId: string, q: { months?: unknown; to?: unknown }): Promise<Buffer> {
  const r = await review(orgId, q);
  return xlsx([
    { name: 'Sites', rows: [['Rank', 'Site', 'Currency', 'Sessions', 'kWh', 'Revenue', 'Energy', 'Shared', 'Rent', 'Maintenance', 'Insurance', 'Operating', 'Depreciation', 'Grants', 'Contribution', 'Margin %', 'Per kWh', 'Signal', 'Reasons'],
      ...r.sites.map((s) => [s.rank, s.site, s.currency, s.sessions, s.kwh, s.revenue, s.energyCost, s.shared, s.rent, s.maintenance, s.insurance, s.operating, s.depreciation, s.grants, s.contribution, s.marginPct, s.perKwh, SIG[s.signal], s.reasons.join('; ')])],
      widths: [5, 26, 8, 9, 10, 15, 14, 12, 12, 12, 12, 15, 13, 12, 15, 8, 9, 18, 50], formats: [null, null, null, 'int', null, 'money', 'money', 'money', 'money', 'money', 'money', 'money', 'money', 'money', 'money', null, null, null, null] },
    { name: 'Months', rows: [['Site', 'Currency', ...r.months], ...r.sites.map((s) => [s.site, s.currency, ...r.months.map((m) => s.monthly.find((x) => x.month === m)?.contribution ?? null)])],
      widths: [26, 8, ...r.months.map(() => 13)], formats: [null, null, ...r.months.map(() => 'money' as const)] },
  ]);
}

export async function reviewPdf(orgId: string, q: { months?: unknown; to?: unknown }): Promise<Buffer> {
  const r = await review(orgId, q);
  const org = await outsideRequestScope(() => one<{ name: string }>(`SELECT name FROM organisation WHERE id = $1`, [orgId]));
  const doc = new PdfDoc({ title: `Portfolio review ${r.months[0]} to ${r.months.at(-1)}`, author: org?.name ?? 'PlugSure CSMS', subject: 'Site portfolio review', created: new Date() });
  const f = new Flow(doc);
  f.para(`${org?.name ?? ''}: site portfolio review`, { size: 16, bold: true });
  f.para(`${r.months[0]} to ${r.months.at(-1)} · contribution = revenue − energy − shared costs − rent − maintenance − insurance − depreciation + grants`, { size: 9, color: [0.36, 0.39, 0.44] });
  for (const [c, t] of Object.entries(r.totals)) {
    f.heading(`Portfolio · ${c}`);
    f.row('Sites', `${t.sites} · ${Object.entries(t.signals).map(([k, v]) => `${v} ${SIG[k as keyof typeof SIG].toLowerCase()}`).join(', ')}`);
    f.row('Revenue', money(t.revenue, c)); f.row('Operating result', money(t.operating, c)); f.row('Contribution', money(t.contribution, c), { bold: true });
    f.table([{ label: '#', width: 0.5 }, { label: 'Site', width: 3 }, { label: 'Revenue', width: 1.8, align: 'right' }, { label: 'Operating', width: 1.8, align: 'right' }, { label: 'Contribution', width: 1.9, align: 'right' }, { label: 'Signal', width: 1.6 }],
      r.sites.filter((s) => s.currency === c).map((s) => ({ cells: [String(s.rank), s.site, money(s.revenue, c), money(s.operating, c), money(s.contribution, c), SIG[s.signal]], sub: s.reasons.length ? ['', s.reasons.join('; ')] : undefined })), { size: 8 });
  }
  return doc.toBuffer();
}
