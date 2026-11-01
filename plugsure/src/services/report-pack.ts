import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { reports as ledgerReports } from './general-ledger.js';
import { compare as budgetCompare } from './budgets.js';
import { position, weeks } from './cash-position.js';
import { scorecard, mainCurrency } from './kpi-scorecard.js';
import { benchmark } from './finance-benchmark.js';
import { payables } from './supplier-bills.js';
import { channels } from './finance-digest.js';
import { sendEmail } from './notify-transports.js';
import { PdfDoc, Flow } from './pdf.js';
import { xlsx } from './xlsx.js';

/**
 * The management report pack (v1.32.0). A month's pack for the board or the owners, in the organisation's main
 * currency:
 *
 *   results     profit and loss of the month and the year to date (the ledger), beside the budget
 *   cash        the cash position at the month's end; the 13-week view's lowest point and the first week below the
 *               minimum
 *   scorecard   the KPIs against their targets (green, amber, red)
 *   sites       the five sites with the most revenue, and the three with the lowest margin
 *   payables    what is owed to suppliers, overdue, and due in the next 14 days
 *
 * The figures are a snapshot taken when the pack is drafted (refreshed on demand while it is a draft), so the pack
 * says what was reviewed. Each section has commentary. A pack is drafted, submitted for review, and approved by a
 * second person with finance:approve (not the one who submitted it); a reviewer can send it back. Approved, it is
 * e-mailed (PDF and Excel attached) to the recipients through the organisation's e-mail channel.
 */

export class PackError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const SECTIONS = ['summary', 'results', 'cash', 'scorecard', 'sites', 'payables'] as const;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const zone = () => config.billing.timeZone;
const thisMonth = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now).slice(0, 7);
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const lastDay = (m: string) => { const [y, mo] = m.split('-').map(Number) as [number, number]; return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`; };
const r2 = (n: number) => Math.round(n * 100) / 100;

export async function settings(orgId: string) {
  const r = await outsideRequestScope(() => one<{ report_pack: any }>(`SELECT report_pack FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const s = r?.report_pack ?? {};
  return { recipients: Array.isArray(s.recipients) ? (s.recipients as string[]) : [] };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const raw = Array.isArray(b.recipients) ? b.recipients : String(b.recipients ?? '').split(/[,;\s]+/);
  const recipients = [...new Set(raw.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
  if (recipients.length > 20) throw new PackError(422, 'Up to 20 recipients.');
  const bad = recipients.find((x) => !EMAIL_RE.test(x));
  if (bad) throw new PackError(422, `${bad} is not an e-mail address.`);
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, report_pack, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET report_pack = EXCLUDED.report_pack, updated_by = EXCLUDED.updated_by, updated_at = now()`, [orgId, JSON.stringify({ recipients }), userId]));
  return settings(orgId);
}

/** The figures of a month, now. */
export async function compose(orgId: string, month: string, currency: string, now = new Date()) {
  const [led, bud, pos, wk, sc, bm, ap] = await Promise.all([
    ledgerReports(orgId, { month, currency }, now),
    budgetCompare(orgId, month).catch(() => null),
    position(orgId, { date: lastDay(month) < today(now) ? lastDay(month) : today(now) }, now),
    weeks(orgId, now),
    scorecard(orgId, { month, currency }, now),
    benchmark(orgId, { months: 1, to: month, by: 'site' }, now).catch(() => null),
    payables(orgId, now),
  ]);
  const plm = led.profitAndLoss.month, ply = led.profitAndLoss.yearToDate;
  const bo = bud?.organisation.find((o) => o.currency === currency);
  const bl = (k: string) => (bo ? (bo.lines as any)[k]?.budget ?? null : null);
  const w = wk.currencies.find((c: any) => c.currency === currency) as any;
  const sites = (bm?.rows ?? []).filter((r) => r.currency === currency);
  const ap1 = ap.currencies.find((c) => c.currency === currency);
  return {
    month, currency, composedAt: now.toISOString(),
    results: {
      month: { revenue: plm.totalRevenue, expenses: plm.totalExpense, other: plm.totalOther, result: plm.result },
      yearToDate: { revenue: ply.totalRevenue, expenses: ply.totalExpense, other: ply.totalOther, result: ply.result },
      budget: bo ? { revenue: bl('revenue'), energyCost: bl('energyCost'), revenueActual: (bo.lines as any).revenue?.actual ?? null } : null,
      balanced: led.trialBalance.balanced, ledgerEmpty: led.trialBalance.rows.length === 0,
      expenseLines: plm.expense.map((x) => ({ code: x.code, name: x.name, amount: x.amount })).sort((a, b) => b.amount - a.amount).slice(0, 8),
    },
    cash: {
      atMonthEnd: pos.totals[currency]?.total ?? 0, date: pos.date,
      lowest13Weeks: w?.lowest ?? null, minimum: w?.minimum ?? null, firstWeekBelowMinimum: w?.firstWeekBelowMinimum ?? null,
    },
    scorecard: { counts: (sc as any).counts ?? null, kpis: sc.kpis.map((k) => ({ kpi: k.kpi, label: k.label, money: k.money, actual: k.actual, target: k.target, rag: k.rag })) },
    sites: {
      top: [...sites].sort((a, b) => b.revenue - a.revenue).slice(0, 5).map((s) => ({ id: s.id, name: s.name, revenue: s.revenue, kwh: s.kwh, marginPct: s.metrics.marginPct, utilisationPct: s.metrics.utilisationPct })),
      lowestMargin: sites.filter((s) => s.metrics.marginPct != null).sort((a, b) => (a.metrics.marginPct ?? 0) - (b.metrics.marginPct ?? 0)).slice(0, 3)
        .map((s) => ({ id: s.id, name: s.name, revenue: s.revenue, marginPct: s.metrics.marginPct })),
    },
    payables: {
      total: ap1?.total ?? 0, overdue: ap1?.overdue ?? 0,
      dueSoon: ap.dueSoon.filter((b) => b.currency === currency).reduce((a, b) => a + b.balance, 0),
      awaitingApproval: ap.awaitingApproval.count,
      topSuppliers: (ap1?.suppliers ?? []).slice(0, 5).map((s) => ({ supplier: s.supplier, total: s.total })),
    },
  };
}
export type PackData = Awaited<ReturnType<typeof compose>>;

const packView = (r: any) => ({
  id: String(r.id), month: r.month, currency: r.currency, status: r.status, data: r.data as PackData, commentary: r.commentary ?? {},
  createdBy: r.created_by_name ?? null, submittedBy: r.submitted_by_name ?? null, submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null,
  approvedBy: r.approved_by_name ?? null, approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null,
  sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null, sentTo: r.sent_to ?? null, updatedAt: new Date(r.updated_at).toISOString(),
});
const PACK_SELECT = `SELECT p.*, c.name AS created_by_name, s.name AS submitted_by_name, a.name AS approved_by_name FROM report_pack p
  LEFT JOIN app_user c ON c.id = p.created_by LEFT JOIN app_user s ON s.id = p.submitted_by LEFT JOIN app_user a ON a.id = p.approved_by`;

export async function list(orgId: string) {
  const rows = await outsideRequestScope(() => many<any>(`${PACK_SELECT} WHERE p.org_id = $1 ORDER BY p.month DESC LIMIT 36`, [orgId]));
  return { packs: rows.map((r) => { const v = packView(r); return { ...v, data: undefined, result: v.data?.results?.month?.result ?? null }; }), settings: await settings(orgId) };
}

async function packRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new PackError(404, 'No such pack.');
  const r = await outsideRequestScope(() => one<any>(`${PACK_SELECT} WHERE p.id = $1 AND p.org_id = $2`, [id, orgId]));
  if (!r) throw new PackError(404, 'No such pack.');
  return r;
}

export async function get(orgId: string, id: string) { return packView(await packRow(orgId, id)); }

/** Draft a month's pack (or refresh the figures of its draft). */
export async function draft(orgId: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const month = String(b.month ?? '');
  if (!MONTH_RE.test(month) || month >= thisMonth(now)) throw new PackError(422, 'month is YYYY-MM, a month that has ended.');
  const ex = await outsideRequestScope(() => one<any>(`SELECT id, status, currency FROM report_pack WHERE org_id = $1 AND month = $2`, [orgId, month]));
  if (ex && ex.status !== 'draft') throw new PackError(409, `The ${month} pack is ${ex.status.replace('_', ' ')}: send it back to draft to refresh it.`);
  const currency = b.currency ? String(b.currency).toUpperCase() : ex?.currency ?? await mainCurrency(orgId);
  if (!currency || !/^[A-Z]{3}$/.test(currency)) throw new PackError(422, 'currency: add a site (or set the reporting currency) first.');
  const data = await compose(orgId, month, currency, now);
  const r = ex
    ? await outsideRequestScope(() => one<any>(`UPDATE report_pack SET data = $2, currency = $3, updated_at = now() WHERE id = $1 RETURNING id`, [ex.id, JSON.stringify(data), currency]))
    : await outsideRequestScope(() => one<any>(`INSERT INTO report_pack (org_id, month, currency, data, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [orgId, month, currency, JSON.stringify(data), userId]));
  return get(orgId, String(r.id));
}

export async function comment(orgId: string, id: string, b: Record<string, unknown>) {
  const r = await packRow(orgId, id);
  if (r.status !== 'draft' && r.status !== 'in_review') throw new PackError(409, `The pack is ${r.status}: its commentary is final.`);
  const c = { ...(r.commentary ?? {}) } as Record<string, string>;
  const given = (b.commentary ?? b) as Record<string, unknown>;
  for (const [k, v] of Object.entries(given)) {
    if (!(SECTIONS as readonly string[]).includes(k)) throw new PackError(422, `Unknown section "${k}" (${SECTIONS.join(', ')}).`);
    const t = v == null ? '' : String(v).trim();
    if (t.length > 4000) throw new PackError(422, `${k}: up to 4000 characters.`);
    if (t) c[k] = t; else delete c[k];
  }
  await outsideRequestScope(() => query(`UPDATE report_pack SET commentary = $2, updated_at = now() WHERE id = $1`, [r.id, JSON.stringify(c)]));
  return get(orgId, id);
}

export async function submit(orgId: string, id: string, userId: string | null) {
  const r = await packRow(orgId, id);
  if (r.status !== 'draft') throw new PackError(409, `The pack is ${r.status.replace('_', ' ')}.`);
  if (!r.commentary?.summary) throw new PackError(422, 'Write the summary before submitting the pack.');
  await outsideRequestScope(() => query(`UPDATE report_pack SET status = 'in_review', submitted_by = $2, submitted_at = now(), updated_at = now() WHERE id = $1`, [r.id, userId]));
  return get(orgId, id);
}

/** Send a pack in review back to draft (the reviewer's note goes into the commentary's summary thread). */
export async function sendBack(orgId: string, id: string, b: Record<string, unknown>, who: { userId: string | null; canApprove: boolean }) {
  const r = await packRow(orgId, id);
  if (r.status !== 'in_review' && r.status !== 'approved') throw new PackError(409, `The pack is ${r.status.replace('_', ' ')}.`);
  if (r.status === 'approved' && !who.canApprove) throw new PackError(403, 'Only a Finance Manager (finance:approve) reopens an approved pack.');
  const reason = String(b.reason ?? '').trim();
  if (reason.length < 3) throw new PackError(422, 'Say why (at least 3 characters).');
  const c = { ...(r.commentary ?? {}), review: reason.slice(0, 1000) };
  await outsideRequestScope(() => query(`UPDATE report_pack SET status = 'draft', approved_by = NULL, approved_at = NULL, commentary = $2, updated_at = now() WHERE id = $1`, [r.id, JSON.stringify(c)]));
  return get(orgId, id);
}

export async function approve(orgId: string, id: string, who: { userId: string | null; canApprove: boolean }) {
  const r = await packRow(orgId, id);
  if (r.status !== 'in_review') throw new PackError(409, `The pack is ${r.status.replace('_', ' ')}.`);
  if (!who.canApprove) throw new PackError(403, 'A pack is approved by a Finance Manager (finance:approve).');
  if (r.submitted_by && r.submitted_by === who.userId) throw new PackError(403, 'A pack is approved by someone other than the person who submitted it.');
  const won = await outsideRequestScope(() => one(`UPDATE report_pack SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1 AND status = 'in_review' RETURNING id`, [r.id, who.userId]));
  if (!won) throw new PackError(409, 'Someone changed the pack at the same time. Reload.');
  return get(orgId, id);
}

// ─────────────────────────────────────────── files

const money = (n: number | null | undefined, cur: string) => (n == null ? '—' : `${cur} ${Math.round(n).toLocaleString('en-US')}`);
const pct = (n: number | null | undefined) => (n == null ? '—' : `${r2(n)}%`);
const kpiVal = (k: { money: boolean; kpi: string }, v: number | null, cur: string) => (v == null ? '—' : k.money ? money(v, cur) : k.kpi.endsWith('Pct') ? pct(v) : k.kpi === 'collectionDays' ? `${r2(v)} days` : Math.round(v).toLocaleString('en-US'));

export async function pdf(orgId: string, id: string): Promise<Buffer> {
  const p = await get(orgId, id);
  const org = await outsideRequestScope(() => one<{ name: string }>(`SELECT name FROM organisation WHERE id = $1`, [orgId]));
  const d = p.data, cur = p.currency, c = p.commentary as Record<string, string>;
  const doc = new PdfDoc({ title: `Management report ${p.month}`, author: org?.name ?? 'PlugSure CSMS', subject: 'Management report pack', created: new Date() });
  const f = new Flow(doc);
  const muted: [number, number, number] = [0.36, 0.39, 0.44];
  f.para(`${org?.name ?? ''}: management report, ${p.month}`, { size: 16, bold: true });
  f.para(`${p.status === 'approved' || p.status === 'sent' ? `Approved by ${p.approvedBy ?? '—'}` : `Status: ${p.status.replace('_', ' ')}`} · figures of ${d.composedAt.slice(0, 10)} · ${cur}`, { size: 9, color: muted });
  const note = (k: string) => { if (c[k]) f.para(c[k]!, { size: 9.5 }); };
  f.heading('Summary'); note('summary');
  f.heading('Results');
  f.table([{ label: '', width: 3 }, { label: p.month, width: 2, align: 'right' }, { label: 'Year to date', width: 2, align: 'right' }], [
    { cells: ['Revenue', money(d.results.month.revenue, cur), money(d.results.yearToDate.revenue, cur)] },
    { cells: ['Expenses', money(d.results.month.expenses, cur), money(d.results.yearToDate.expenses, cur)] },
    { cells: ['Other income and expense', money(d.results.month.other, cur), money(d.results.yearToDate.other, cur)] },
    { cells: ['Result', money(d.results.month.result, cur), money(d.results.yearToDate.result, cur)], bold: true },
  ]);
  if (d.results.budget) f.row('Revenue budget (charging)', `${money(d.results.budget.revenue, cur)} · actual ${money(d.results.budget.revenueActual, cur)}`);
  if (d.results.ledgerEmpty) f.para('The ledger has no entries for this currency: sync the month (Finance → Ledger).', { size: 8.5, color: muted });
  note('results');
  f.heading('Cash');
  f.row('Cash at the month\'s end', money(d.cash.atMonthEnd, cur));
  f.row('Lowest point in the next 13 weeks', money(d.cash.lowest13Weeks, cur));
  if (d.cash.firstWeekBelowMinimum != null) f.row('First week below the minimum', String(d.cash.firstWeekBelowMinimum));
  note('cash');
  f.heading('Scorecard');
  f.table([{ label: 'KPI', width: 3 }, { label: 'Actual', width: 2, align: 'right' }, { label: 'Target', width: 2, align: 'right' }, { label: '', width: 1 }],
    d.scorecard.kpis.map((k) => ({ cells: [k.label, kpiVal(k, k.actual, cur), kpiVal(k, k.target, cur), k.rag ? k.rag.toUpperCase() : ''] })));
  note('scorecard');
  f.heading('Sites');
  if (d.sites.top.length) f.table([{ label: 'Top sites by revenue', width: 3.4 }, { label: 'Revenue', width: 2, align: 'right' }, { label: 'kWh', width: 1.4, align: 'right' }, { label: 'Margin', width: 1.2, align: 'right' }, { label: 'Utilisation', width: 1.4, align: 'right' }],
    d.sites.top.map((s) => ({ cells: [s.name, money(s.revenue, cur), Math.round(s.kwh).toLocaleString('en-US'), pct(s.marginPct), pct(s.utilisationPct)] })));
  if (d.sites.lowestMargin.length) f.table([{ label: 'Lowest margin', width: 3.4 }, { label: 'Revenue', width: 2, align: 'right' }, { label: 'Margin', width: 1.2, align: 'right' }],
    d.sites.lowestMargin.map((s) => ({ cells: [s.name, money(s.revenue, cur), pct(s.marginPct)] })));
  note('sites');
  f.heading('Payables');
  f.row('Owed to suppliers', money(d.payables.total, cur));
  f.row('of which overdue', money(d.payables.overdue, cur));
  f.row('Due in the next 14 days', money(d.payables.dueSoon, cur));
  f.row('Bills awaiting approval', String(d.payables.awaitingApproval));
  note('payables');
  return doc.toBuffer();
}

export async function workbook(orgId: string, id: string): Promise<Buffer> {
  const p = await get(orgId, id);
  const d = p.data, c = p.commentary as Record<string, string>;
  return xlsx([
    { name: 'Summary', rows: [['Section', 'Commentary'], ...SECTIONS.map((s) => [s, c[s] ?? ''])], widths: [14, 120] },
    { name: 'Results', rows: [['', p.month, 'Year to date'], ['Revenue', d.results.month.revenue, d.results.yearToDate.revenue], ['Expenses', d.results.month.expenses, d.results.yearToDate.expenses],
      ['Other', d.results.month.other, d.results.yearToDate.other], ['Result', d.results.month.result, d.results.yearToDate.result], [], ['Largest expenses', '', ''], ...d.results.expenseLines.map((x) => [`${x.code} ${x.name}`, x.amount, ''])],
      widths: [36, 18, 18], formats: [null, 'money', 'money'] },
    { name: 'Cash', rows: [['', p.currency], ['At the month\'s end', d.cash.atMonthEnd], ['Lowest in 13 weeks', d.cash.lowest13Weeks], ['Minimum', d.cash.minimum], ['First week below the minimum', d.cash.firstWeekBelowMinimum]], widths: [32, 18], formats: [null, 'money'] },
    { name: 'Scorecard', rows: [['KPI', 'Actual', 'Target', 'Colour'], ...d.scorecard.kpis.map((k) => [k.label, k.actual, k.target, k.rag ?? ''])], widths: [24, 16, 16, 10] },
    { name: 'Sites', rows: [['Site', 'Revenue', 'kWh', 'Margin %', 'Utilisation %'], ...d.sites.top.map((s) => [s.name, s.revenue, s.kwh, s.marginPct, s.utilisationPct])], widths: [32, 16, 12, 12, 14], formats: [null, 'money', 'int', null, null] },
    { name: 'Payables', rows: [['', p.currency], ['Owed', d.payables.total], ['Overdue', d.payables.overdue], ['Due in 14 days', d.payables.dueSoon], [], ['Supplier', 'Owed'], ...d.payables.topSuppliers.map((s) => [s.supplier, s.total])], widths: [32, 18], formats: [null, 'money'] },
  ]);
}

/** E-mail an approved pack (PDF and Excel) to the recipients. */
export async function send(orgId: string, id: string) {
  const p = await get(orgId, id);
  if (p.status !== 'approved' && p.status !== 'sent') throw new PackError(409, 'Only an approved pack is sent.');
  const s = await settings(orgId);
  if (!s.recipients.length) throw new PackError(422, 'No recipients: add them in the pack settings.');
  const ch = await channels(orgId);
  if (!ch.email?.config?.host) throw new PackError(422, 'No e-mail channel (Govern → Alert routing → Channels).');
  const org = await outsideRequestScope(() => one<{ name: string }>(`SELECT name FROM organisation WHERE id = $1`, [orgId]));
  const [pdfBuf, xlsBuf] = await Promise.all([pdf(orgId, id), workbook(orgId, id)]);
  const subject = `${org?.name ?? 'PlugSure'}: management report ${p.month}`;
  const summary = (p.commentary as Record<string, string>).summary ?? '';
  const text = `${subject}\n\n${summary}\n\nThe pack is attached (PDF and Excel).`;
  const esc = (x: string) => x.replace(/[&<>"]/g, (k) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[k]!);
  let sent = 0, error: string | null = null;
  for (const to of s.recipients) {
    const r = await sendEmail(ch.email.config, ch.email.secret, to, {
      subject, text, html: `<pre style="font:14px/1.5 system-ui,sans-serif;white-space:pre-wrap">${esc(text)}</pre>`, kind: 'finance-report-pack',
      attachments: [{ filename: `management-report-${p.month}.pdf`, content: pdfBuf, contentType: 'application/pdf' },
        { filename: `management-report-${p.month}.xlsx`, content: xlsBuf, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
    });
    if (r.ok) sent++; else error = r.error ?? 'failed';
  }
  if (sent) await outsideRequestScope(() => query(`UPDATE report_pack SET status = 'sent', sent_at = now(), sent_to = $2, updated_at = now() WHERE id = $1`, [p.id, sent]));
  return { id: p.id, month: p.month, sent, error };
}
