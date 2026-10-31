import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { unseal } from './secrets.js';
import { sendEmail } from './notify-transports.js';
import { xlsx, type Sheet } from './xlsx.js';
import { summary } from './finance-summary.js';
import { month as energyMonth } from './energy-margin.js';
import { list as collectionsList } from './collections.js';
import { compare as budgetCompare } from './budgets.js';
import { forecast } from './finance-forecast.js';
import { accountsFor, type Account } from './finance.js';

/**
 * Scheduled report e-mails (v1.21.0): chosen finance reports as one Excel workbook (one sheet each), e-mailed through
 * the organisation's e-mail channel to up to 10 recipients:
 *
 *   weekly   on the chosen weekday (1 Monday … 7 Sunday) from 07:00 (platform time zone), once per ISO week; the
 *            figures are as of that day (margin and budgets: the month to date)
 *   monthly  on the 1st from 07:00, once per month; margin and budgets for the month just ended
 *
 * Reports: summary, margin, collections, budgets, forecast (the next 30 days of a payments account). The monthly close
 * e-mail (v1.17.0) is separate and unchanged. A failure is kept on the schedule and retried at the next hourly pass.
 */

export class ReportError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const REPORTS = ['summary', 'margin', 'collections', 'budgets', 'forecast'] as const;
type Report = typeof REPORTS[number];
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const zone = () => config.billing.timeZone;

const view = (r: any) => ({
  id: String(r.id), name: r.name, reports: r.reports, frequency: r.frequency, weekday: r.weekday, recipients: r.recipients, accountId: r.integration_id,
  enabled: r.enabled, lastSentAt: r.last_sent_at ? new Date(r.last_sent_at).toISOString() : null, lastPeriod: r.last_period, lastError: r.last_error,
});

export async function list(orgId: string) {
  return (await outsideRequestScope(() => many<any>(`SELECT * FROM finance_report_schedule WHERE org_id = $1 AND archived_at IS NULL ORDER BY id`, [orgId]))).map(view);
}

async function validate(orgId: string, b: Record<string, unknown>, cur?: any) {
  const name = String(b.name ?? cur?.name ?? '').trim();
  if (!name || name.length > 80) throw new ReportError(422, 'The name is 1 to 80 characters.');
  const reports = (b.reports ?? cur?.reports ?? []) as unknown[];
  if (!Array.isArray(reports) || !reports.length || reports.some((r) => !REPORTS.includes(r as Report))) throw new ReportError(422, `reports are one or more of ${REPORTS.join(', ')}.`);
  const frequency = String(b.frequency ?? cur?.frequency ?? '');
  if (frequency !== 'weekly' && frequency !== 'monthly') throw new ReportError(422, 'frequency is weekly or monthly.');
  const weekday = frequency === 'weekly' ? Number(b.weekday ?? cur?.weekday ?? 1) : null;
  if (weekday != null && (!Number.isInteger(weekday) || weekday < 1 || weekday > 7)) throw new ReportError(422, 'weekday is 1 (Monday) to 7 (Sunday).');
  const raw = b.recipients ?? cur?.recipients ?? [];
  const recipients = [...new Set((Array.isArray(raw) ? raw : String(raw).split(/[,;\s]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  if (!recipients.length || recipients.length > 10) throw new ReportError(422, '1 to 10 recipients.');
  const bad = recipients.find((x) => !EMAIL_RE.test(x));
  if (bad) throw new ReportError(422, `Not an e-mail address: ${bad.slice(0, 80)}`);
  let accountId: string | null = (b.accountId ?? cur?.integration_id ?? null) as string | null;
  if (reports.includes('forecast')) {
    const accts = await accountsFor(orgId, false);
    if (!accountId) accountId = accts[0]?.id ?? null;
    if (!accountId || !accts.some((a) => a.id === accountId)) throw new ReportError(422, 'The forecast needs one of your payments accounts (accountId).');
  } else accountId = null;
  return { name, reports: reports as string[], frequency, weekday, recipients, accountId, enabled: b.enabled === undefined ? (cur?.enabled ?? true) : b.enabled === true };
}

export async function create(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const v = await validate(orgId, b);
  const r = await outsideRequestScope(() => one<any>(
    `INSERT INTO finance_report_schedule (org_id, name, reports, frequency, weekday, recipients, integration_id, enabled, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [orgId, v.name, v.reports, v.frequency, v.weekday, v.recipients, v.accountId, v.enabled, userId]));
  return view(r);
}

async function rowOf(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new ReportError(404, 'No such schedule.');
  const r = await outsideRequestScope(() => one<any>(`SELECT * FROM finance_report_schedule WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [id, orgId]));
  if (!r) throw new ReportError(404, 'No such schedule.');
  return r;
}

export async function update(orgId: string, id: string, b: Record<string, unknown>) {
  const cur = await rowOf(orgId, id);
  if (b.archived === true) {
    await outsideRequestScope(() => query(`UPDATE finance_report_schedule SET archived_at = now(), enabled = false, updated_at = now() WHERE id = $1`, [id]));
    return { ...view(cur), enabled: false, archived: true };
  }
  const v = await validate(orgId, b, cur);
  const r = await outsideRequestScope(() => one<any>(
    `UPDATE finance_report_schedule SET name = $2, reports = $3, frequency = $4, weekday = $5, recipients = $6, integration_id = $7, enabled = $8, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, v.name, v.reports, v.frequency, v.weekday, v.recipients, v.accountId, v.enabled]));
  return view(r);
}

// ─────────────────────────────────────────── the workbook

const prevMonth = (ym: string) => { const [y, m] = ym.split('-').map(Number) as [number, number]; return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };

export async function workbook(orgId: string, reports: string[], frequency: string, accountId: string | null, now = new Date()): Promise<{ file: Buffer; month: string; lines: string[] }> {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
  const month = frequency === 'monthly' ? prevMonth(today.slice(0, 7)) : today.slice(0, 7);
  const sheets: Sheet[] = [];
  const lines: string[] = [];
  for (const rep of reports) {
    if (rep === 'summary') {
      const s = await summary(orgId, now);
      sheets.push({ name: 'Summary', rows: [['Currency', 'Revenue MTD', 'vs last month %', 'vs last year %', 'Margin MTD', 'Margin %', 'Receivables', 'DSO (days)', 'Fee rate %', 'Refund rate %'],
        ...s.perCurrency.map((p) => [p.currency, p.revenue.mtd, p.revenue.vsLastMonthPct, p.revenue.vsLastYearPct, p.margin?.mtd ?? null, p.margin?.pct ?? null, p.receivables, p.dso, p.feeRatePct, p.refundRatePct])] });
      for (const p of s.perCurrency) lines.push(`${p.currency}: revenue this month ${p.revenue.mtd}${p.revenue.vsLastMonthPct != null ? ` (${p.revenue.vsLastMonthPct >= 0 ? '+' : ''}${p.revenue.vsLastMonthPct}% on last month)` : ''}, owed ${p.receivables}${p.dso != null ? `, DSO ${p.dso} days` : ''}.`);
    } else if (rep === 'margin') {
      const e = await energyMonth(orgId, month);
      sheets.push({ name: `Margin ${month}`, rows: [['Site', 'Currency', 'Sessions', 'kWh', 'Revenue', 'Energy cost', 'Source', 'Losses %', 'Margin', 'Margin %'],
        ...e.sites.map((x) => [x.site, x.currency, x.sessions, x.kwh, x.revenue, x.energyCost, x.source, x.lossPct, x.margin, x.marginPct])] });
    } else if (rep === 'collections') {
      const c = await collectionsList(orgId, false, now);
      sheets.push({ name: 'Collections', rows: [['Document', 'Customer', 'Currency', 'Outstanding', 'Due', 'Days late', 'Bucket', 'Last note', 'Promised'],
        ...c.receivables.map((r) => [r.number, r.counterparty, r.currency, r.outstanding, r.dueDate, r.daysPastDue, r.bucket, r.lastNote?.note ?? '', r.lastNote?.promiseDate ?? ''])] });
      const late = c.receivables.filter((r) => r.daysPastDue > 0);
      if (late.length) lines.push(`${late.length} document${late.length === 1 ? ' is' : 's are'} past due.`);
    } else if (rep === 'budgets') {
      const b = await budgetCompare(orgId, month);
      const row = (who: string, cur: string, l: any) => [who, cur, ...['revenue', 'energyCost', 'fees', 'ownerShare'].flatMap((k) => [l[k]?.budget ?? null, l[k]?.actual ?? null, l[k]?.variance?.pct ?? null])];
      sheets.push({ name: `Budgets ${month}`, rows: [['Scope', 'Currency', 'Revenue budget', 'Revenue actual', 'Revenue var %', 'Energy budget', 'Energy actual', 'Energy var %', 'Fees budget', 'Fees actual', 'Fees var %', 'Owner share budget', 'Owner share actual', 'Owner share var %'],
        ...b.organisation.map((o) => row('Organisation', o.currency, o.lines)), ...b.sites.filter((s) => s.budgeted).map((s) => row(s.site, s.currency, s.lines))] });
    } else if (rep === 'forecast' && accountId) {
      const a = (await accountsFor(orgId, false)).find((x) => x.id === accountId) as Account | undefined;
      if (!a) continue;
      const f = await forecast(a, { days: 30 }, now);
      sheets.push({ name: 'Forecast 30 days', rows: [['Day', 'Kind', 'Description', 'Amount', 'Position'], ['', 'opening', 'Opening position', f.opening.total, ''],
        ...f.flows.map((x) => [x.day, x.kind, x.label, x.amount, f.series.find((d) => d.day === x.day)?.position ?? null])] });
      if (f.shortfall) lines.push(`Forecast: a shortfall on ${f.shortfall.day} (${f.shortfall.position}).`);
    }
  }
  return { file: xlsx(sheets), month, lines };
}

/** Send a schedule's reports now (also used by the worker). Records the result on the schedule. */
export async function send(orgId: string, id: string, now = new Date(), period?: string) {
  const s = await rowOf(orgId, id);
  const ch = await outsideRequestScope(() => one<{ enabled: boolean; config: any; secret: string | null }>(`SELECT enabled, config, secret FROM notification_channel WHERE org_id = $1 AND kind = 'email'`, [orgId]));
  const fail = async (msg: string, status = 409) => {
    await outsideRequestScope(() => query(`UPDATE finance_report_schedule SET last_error = $2, updated_at = now() WHERE id = $1`, [id, msg.slice(0, 300)]));
    throw new ReportError(status, msg);
  };
  if (!ch?.enabled || !ch.config?.host) return fail('Set up the e-mail channel first (Govern → Alert routing → Channels).');
  let secret: string | null = null;
  try { secret = ch.secret ? unseal(ch.secret) : null; } catch { secret = null; }
  const org = await outsideRequestScope(() => one<{ name: string }>(`SELECT name FROM organisation WHERE id = $1`, [orgId]));
  const wb = await workbook(orgId, s.reports, s.frequency, s.integration_id, now);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
  const label = s.frequency === 'monthly' ? wb.month : today;
  const text = `${org?.name ?? ''}: ${s.name} (${label})\n\n${wb.lines.join('\n') || 'The figures are attached.'}\n\nAttached: ${s.reports.join(', ')} (Excel). Sent by PlugSure Finance; change this schedule in Commercial → Finance → Settings → Report e-mails.`;
  const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const res = await sendEmail(ch.config, secret, s.recipients.join(', '), {
    subject: `${s.name} — ${label}`, text, html: text.split('\n\n').map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join(''), kind: 'finance-report',
    attachments: [{ filename: `plugsure-${s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report'}-${label}.xlsx`, content: wb.file, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
  });
  if (!res.ok) return fail(`The e-mail was not sent: ${res.error ?? 'failed'}`, 502);
  await outsideRequestScope(() => query(`UPDATE finance_report_schedule SET last_sent_at = now(), last_error = NULL, last_period = COALESCE($2, last_period), updated_at = now() WHERE id = $1`, [id, period ?? null]));
  return { ok: true, to: s.recipients as string[], reference: res.ref ?? null };
}

/** The period a schedule is due for now, or null (weekly: the ISO week on its weekday from 07:00; monthly: the 1st). */
export function duePeriod(s: { frequency: string; weekday: number | null; last_period: string | null }, now = new Date()): string | null {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  if (Number(p.hour) < 7) return null;
  if (s.frequency === 'monthly') {
    if (p.day !== '01') return null;
    const period = `${p.year}-${p.month}`;
    return s.last_period === period ? null : period;
  }
  const wd = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[p.weekday!]!;
  if (wd !== (s.weekday ?? 1)) return null;
  // ISO week of the local date.
  const d = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  d.setUTCDate(d.getUTCDate() + 4 - wd);
  const y = d.getUTCFullYear(), week = Math.ceil(((d.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7);
  const period = `${y}-W${String(week).padStart(2, '0')}`;
  return s.last_period === period ? null : period;
}

/** The worker (hourly): every enabled schedule that is due. */
export async function sendDue(now = new Date()): Promise<number> {
  const rows = await outsideRequestScope(() => many<any>(`SELECT * FROM finance_report_schedule WHERE enabled AND archived_at IS NULL`));
  let sent = 0;
  for (const s of rows) {
    const period = duePeriod(s, now);
    if (!period) continue;
    try { await send(s.org_id, String(s.id), now, period); sent++; } catch (e) { logger.warn({ schedule: s.id, err: (e as Error).message }, 'report e-mail failed'); }
  }
  return sent;
}
