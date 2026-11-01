import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { benchmark } from './finance-benchmark.js';
import { position } from './cash-position.js';
import { reportingCurrency, currencies } from './fx.js';
import { channels } from './finance-digest.js';
import { sendEmail } from './notify-transports.js';

/**
 * Finance KPI targets and the scorecard (v1.31.0). A month's targets for the organisation's KPIs, against the actuals,
 * in the organisation's main currency (the reporting currency, else its sites' first):
 *
 *   revenue          before tax (charge records issued in the month)                      higher is better
 *   sessions, kwh                                                                          higher is better
 *   marginPct        (revenue − energy cost) ÷ revenue                                     higher is better
 *   utilisationPct   charging time ÷ (connectors × the month's hours)                      higher is better
 *   collectionDays   revenue-weighted days from the charge to the money                    lower is better
 *   cash             the cash position at the month's end (banks, cash, gateways)          higher is better
 *   opex             supplier bills dated in the month (not on capex projects), expense      lower is better
 *                    claims approved in it and (v1.33.0) the payroll's cost
 *
 * Each KPI is green when it meets the target, amber within the band (default 10%) and red beyond it; with no target it
 * is shown without a colour. The scorecard has six months of each KPI. On a day of the month (1–28) the last month's
 * scorecard is e-mailed to the recipients (once a month; the organisation's e-mail channel).
 */

export class ScorecardError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const KPIS = ['revenue', 'sessions', 'kwh', 'marginPct', 'utilisationPct', 'collectionDays', 'cash', 'opex'] as const;
type Kpi = typeof KPIS[number];
const LOWER: Partial<Record<Kpi, true>> = { collectionDays: true, opex: true };
export const LABEL: Record<Kpi, string> = { revenue: 'Revenue', sessions: 'Sessions', kwh: 'Energy (kWh)', marginPct: 'Margin %', utilisationPct: 'Utilisation %', collectionDays: 'Collection days', cash: 'Cash', opex: 'Operating costs' };
const MONEY: Partial<Record<Kpi, true>> = { revenue: true, cash: true, opex: true };
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const thisMonth = (now = new Date()) => today(now).slice(0, 7);
const addMonths = (m: string, n: number) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const t = y * 12 + (mo - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const lastDay = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`; };

export interface Settings { enabled: boolean; day: number; recipients: string[]; amberPct: number }

export async function settings(orgId: string): Promise<Settings> {
  const r = await outsideRequestScope(() => one<{ kpi_scorecard: any }>(`SELECT kpi_scorecard FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const v = r?.kpi_scorecard ?? {};
  return { enabled: !!v.enabled, day: Number(v.day ?? 3), recipients: Array.isArray(v.recipients) ? v.recipients : [], amberPct: Number(v.amberPct ?? 10) };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const cur = await settings(orgId);
  const day = b.day === undefined ? cur.day : Number(b.day);
  if (!Number.isInteger(day) || day < 1 || day > 28) throw new ScorecardError(422, 'day is 1 to 28.');
  const amber = b.amberPct === undefined ? cur.amberPct : Number(b.amberPct);
  if (!Number.isFinite(amber) || amber < 0 || amber > 100) throw new ScorecardError(422, 'amberPct is 0 to 100.');
  let recipients = cur.recipients;
  if (b.recipients !== undefined) {
    if (!Array.isArray(b.recipients) || b.recipients.length > 20) throw new ScorecardError(422, 'recipients is a list of up to 20 e-mail addresses.');
    recipients = b.recipients.map((x) => String(x).trim()).filter(Boolean);
    const bad = recipients.find((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
    if (bad) throw new ScorecardError(422, `"${bad}" is not an e-mail address.`);
  }
  const enabled = b.enabled === undefined ? cur.enabled : b.enabled === true || b.enabled === 'true';
  if (enabled && !recipients.length) throw new ScorecardError(422, 'Add at least one recipient to send the scorecard.');
  const v: Settings = { enabled, day, recipients, amberPct: amber };
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, kpi_scorecard, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET kpi_scorecard = EXCLUDED.kpi_scorecard, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify(v), userId]));
  return v;
}

export async function mainCurrency(orgId: string) {
  return (await reportingCurrency(orgId)) ?? (await currencies(orgId))[0] ?? null;
}

/** The month's actuals in a currency (an ended month for the charging KPIs; cash to the month's end or today). */
export async function actuals(orgId: string, month: string, currency: string, now = new Date()): Promise<Record<Kpi, number | null>> {
  const out: Record<Kpi, number | null> = { revenue: null, sessions: null, kwh: null, marginPct: null, utilisationPct: null, collectionDays: null, cash: null, opex: null };
  if (month < thisMonth(now)) {
    const b = await benchmark(orgId, { months: 1, to: month, by: 'org' }, now);
    const r = b.rows.find((x) => x.currency === currency);
    if (r) { out.revenue = r.revenue; out.sessions = r.sessions; out.kwh = r.kwh; out.marginPct = r.metrics.marginPct; out.utilisationPct = r.metrics.utilisationPct; out.collectionDays = r.metrics.collectionDays; }
    else { out.revenue = 0; out.sessions = 0; out.kwh = 0; }
  }
  const end = lastDay(month) < today(now) ? lastDay(month) : today(now);
  if (month <= thisMonth(now)) {
    const p = await position(orgId, { date: end }, now);
    out.cash = p.totals[currency]?.total ?? 0;
  }
  const opex = await outsideRequestScope(() => one<{ bills: string; claims: string; payroll: string }>(
    `SELECT (SELECT COALESCE(sum(subtotal_minor), 0) FROM supplier_bill WHERE org_id = $1 AND currency = $3 AND status IN ('approved', 'paid') AND to_char(bill_date, 'YYYY-MM') = $2 AND capex_project_id IS NULL)::bigint AS bills,
            (SELECT COALESCE(sum((totals->>'cost')::bigint), 0) FROM payroll_run WHERE org_id = $1 AND currency = $3 AND status IN ('approved', 'paid') AND month = $2)::bigint AS payroll,
            (SELECT COALESCE(sum(l.amount_minor), 0) FROM expense_claim c JOIN expense_claim_line l ON l.claim_id = c.id AND l.removed_at IS NULL
              WHERE c.org_id = $1 AND c.currency = $3 AND c.status IN ('approved', 'reimbursed') AND to_char(c.approved_at AT TIME ZONE $4, 'YYYY-MM') = $2)::bigint AS claims`, [orgId, month, currency, zone()]));
  out.opex = Number(opex?.bills ?? 0) + Number(opex?.claims ?? 0) + Number(opex?.payroll ?? 0);
  return out;
}

export function rag(kpi: Kpi, actual: number | null, target: number | null, amberPct: number): 'green' | 'amber' | 'red' | null {
  if (actual == null || target == null) return null;
  if (LOWER[kpi]) {
    if (actual <= target) return 'green';
    return actual <= target * (1 + amberPct / 100) ? 'amber' : 'red';
  }
  if (actual >= target) return 'green';
  return actual >= target * (1 - amberPct / 100) ? 'amber' : 'red';
}

export async function targets(orgId: string, month: string) {
  const rows = await outsideRequestScope(() => many<any>(`SELECT kpi, target FROM kpi_target WHERE org_id = $1 AND month = $2`, [orgId, month]));
  return Object.fromEntries(rows.map((r) => [r.kpi, Number(r.target)])) as Partial<Record<Kpi, number>>;
}

export async function setTargets(orgId: string, monthRaw: unknown, b: Record<string, unknown>, userId: string | null) {
  const month = String(monthRaw ?? '');
  if (!MONTH_RE.test(month)) throw new ScorecardError(422, 'month is YYYY-MM.');
  let values = (b.targets ?? {}) as Record<string, unknown>;
  if (b.copyFrom != null && b.copyFrom !== '') {
    const from = String(b.copyFrom);
    if (!MONTH_RE.test(from)) throw new ScorecardError(422, 'copyFrom is YYYY-MM.');
    values = { ...(await targets(orgId, from)), ...values };
  }
  if (typeof values !== 'object' || Array.isArray(values)) throw new ScorecardError(422, 'targets is an object by KPI.');
  for (const [k, v] of Object.entries(values)) {
    if (!(KPIS as readonly string[]).includes(k)) throw new ScorecardError(422, `Unknown KPI "${k}" (${KPIS.join(', ')}).`);
    if (v == null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new ScorecardError(422, `${k}: the target is a number, 0 or more.`);
    await outsideRequestScope(() => query(
      `INSERT INTO kpi_target (org_id, month, kpi, target, updated_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, month, kpi) DO UPDATE SET target = EXCLUDED.target, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, month, k, n, userId]));
  }
  return { month, targets: await targets(orgId, month) };
}

export async function scorecard(orgId: string, q: Record<string, unknown> = {}, now = new Date()) {
  const month = q.month == null || q.month === '' ? addMonths(thisMonth(now), -1) : String(q.month);
  if (!MONTH_RE.test(month) || month > thisMonth(now)) throw new ScorecardError(422, 'month is YYYY-MM, not in the future.');
  const currency = (q.currency ? String(q.currency).toUpperCase() : null) ?? (await mainCurrency(orgId));
  const s = await settings(orgId);
  if (!currency) return { month, currency: null, kpis: [], trend: [], settings: s, message: 'Add a site (or set the reporting currency) to see the scorecard.' };
  const [act, tgt] = await Promise.all([actuals(orgId, month, currency, now), targets(orgId, month)]);
  const kpis = KPIS.map((k) => {
    const a = act[k], t = tgt[k] ?? null;
    return { kpi: k, label: LABEL[k], money: !!MONEY[k], lowerIsBetter: !!LOWER[k], actual: a, target: t,
      variance: a != null && t != null ? Math.round((a - t) * 100) / 100 : null, variancePct: a != null && t ? Math.round(((a - t) / t) * 1000) / 10 : null, rag: rag(k, a, t, s.amberPct) };
  });
  const months = Array.from({ length: 6 }, (_, i) => addMonths(month, i - 5));
  const trend = [];
  for (const m of months) {
    const [a, t] = m === month ? [act, tgt] : await Promise.all([actuals(orgId, m, currency, now), targets(orgId, m)]);
    trend.push({ month: m, actuals: a, targets: t });
  }
  const counts = { green: kpis.filter((k) => k.rag === 'green').length, amber: kpis.filter((k) => k.rag === 'amber').length, red: kpis.filter((k) => k.rag === 'red').length };
  return { month, currency, kpis, counts, trend, settings: s };
}

const fmtVal = (k: { money: boolean; kpi: string }, v: number | null, cur: string) =>
  v == null ? '—' : k.money ? `${cur} ${Math.round(v).toLocaleString('en-US')}` : k.kpi.endsWith('Pct') ? `${v}%` : k.kpi === 'collectionDays' ? `${v} days` : Math.round(v).toLocaleString('en-US');

export function scorecardText(org: string, sc: Awaited<ReturnType<typeof scorecard>>) {
  const mark = { green: 'GREEN', amber: 'AMBER', red: 'RED' } as const;
  const lines = [`${org}: finance scorecard ${sc.month}`, ''];
  if ('counts' in sc && sc.counts) lines.push(`${sc.counts.green} green, ${sc.counts.amber} amber, ${sc.counts.red} red.`, '');
  for (const k of sc.kpis) lines.push(`${(k.rag ? mark[k.rag] : '  –  ').padEnd(5)}  ${k.label}: ${fmtVal(k, k.actual, sc.currency ?? '')}${k.target != null ? ` (target ${fmtVal(k, k.target, sc.currency ?? '')}${k.variancePct != null ? `, ${k.variancePct > 0 ? '+' : ''}${k.variancePct}%` : ''})` : ''}`);
  lines.push('', 'Finance → Scorecard in the console has the trend.');
  return lines.join('\n');
}

export async function send(orgId: string, monthRaw: unknown, now = new Date()) {
  const s = await settings(orgId);
  if (!s.recipients.length) throw new ScorecardError(422, 'No recipients: add them in the scorecard settings.');
  const ch = await channels(orgId);
  if (!ch.email?.config?.host) throw new ScorecardError(422, 'No e-mail channel (Govern → Alert routing → Channels).');
  const sc = await scorecard(orgId, { month: monthRaw }, now);
  const org = await outsideRequestScope(() => one<{ name: string }>(`SELECT name FROM organisation WHERE id = $1`, [orgId]));
  const text = scorecardText(org?.name ?? 'PlugSure', sc);
  const esc = (x: string) => x.replace(/[&<>"]/g, (k) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[k]!);
  let sent = 0, error: string | null = null;
  for (const to of s.recipients) {
    const r = await sendEmail(ch.email.config, ch.email.secret, to, { subject: text.split('\n')[0]!, text, html: `<pre style="font:14px/1.5 system-ui,sans-serif;white-space:pre-wrap">${esc(text)}</pre>`, kind: 'finance-scorecard' });
    if (r.ok) sent++; else error = r.error ?? 'failed';
  }
  await outsideRequestScope(() => query(
    `INSERT INTO kpi_scorecard_send (org_id, month, recipients, error) VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, month) DO UPDATE SET recipients = EXCLUDED.recipients, error = EXCLUDED.error, sent_at = now()`, [orgId, sc.month, sent, error]));
  return { month: sc.month, sent, error };
}

/** Daily: on or after the day of the month, the last month's scorecard, once. */
export async function sweep(now = new Date()): Promise<number> {
  const day = Number(today(now).slice(8, 10));
  const last = addMonths(thisMonth(now), -1);
  const orgs = await outsideRequestScope(() => many<{ org_id: string }>(
    `SELECT s.org_id FROM finance_org_settings s WHERE (s.kpi_scorecard->>'enabled')::boolean IS TRUE AND COALESCE((s.kpi_scorecard->>'day')::int, 3) <= $1
        AND NOT EXISTS (SELECT 1 FROM kpi_scorecard_send x WHERE x.org_id = s.org_id AND x.month = $2)`, [day, last]));
  let n = 0;
  for (const o of orgs) { try { await send(o.org_id, last, now); n++; } catch (e) { logger.warn({ org: o.org_id, err: (e as Error).message }, 'scorecard send failed'); } }
  return n;
}
