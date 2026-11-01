import { createHash } from 'node:crypto';
import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { xlsx } from './xlsx.js';

/**
 * Audit and compliance calendar (v1.35.0). Tax deadlines live in the tax calendar; this is everything else:
 *
 *   tasks      a statutory or audit deadline: title, category (financial statements, regulator, licence, corporate,
 *              other tax, audit, other), authority, due date, recurrence (none, monthly, quarterly, yearly), owner, how
 *              many days ahead to remind. Done (with the date and who) or waived (with a note). Marking a recurring task
 *              done creates the next one. From remind_days before the due date an open task raises
 *              finance.compliance_due (critical once overdue), resolved when it is done or waived.
 *   templates  the usual Indonesian deadlines for a year, added once each (the investment activity report to BKPM,
 *              the annual GMS, the audited financial statements, the manpower report, the charging-station report to
 *              the energy ministry). Dates are a starting point: check them with the organisation's advisers.
 *   evidence   files on a task or an auditor's request: PDF, PNG, JPEG, XLSX, DOCX or CSV, up to 5 MB, the type
 *              checked against the file's first bytes, a SHA-256 kept
 *   PBC        the auditor's "prepared by client" list: audit, reference, item, requested and due dates, owner;
 *              requested → in progress → provided (needs a file) → accepted
 */

export class ComplianceError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const CATEGORIES = ['financial_statements', 'regulator', 'licence', 'corporate', 'tax_other', 'audit', 'other'] as const;
export const RECURRENCES = ['none', 'monthly', 'quarterly', 'yearly'] as const;
export const MIMES = ['application/pdf', 'image/png', 'image/jpeg', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/csv'] as const;
export const MAX_EVIDENCE = 5 * 1024 * 1024;
const DUE = 'finance.compliance_due';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Whether a file's first bytes match its declared type. Pure. */
export function sniffOk(mime: string, data: Buffer): boolean {
  const hex = data.subarray(0, 4).toString('hex');
  switch (mime) {
    case 'application/pdf': return hex === '25504446';
    case 'image/png': return hex === '89504e47';
    case 'image/jpeg': return hex.startsWith('ffd8ff');
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': return hex === '504b0304';
    case 'text/csv': return !data.subarray(0, 8192).includes(0) && !data.subarray(0, 4).equals(Buffer.from('%PDF'));
    default: return false;
  }
}

/** The next due date of a recurring task: the same day in the next month, quarter or year (clamped to the month's end). Pure. */
export function nextDue(due: string, rec: string): string | null {
  const step = rec === 'monthly' ? 1 : rec === 'quarterly' ? 3 : rec === 'yearly' ? 12 : 0;
  if (!step) return null;
  const [y, m, d] = due.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + step, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** The standard deadlines for a year. Pure. */
export function templates(year: number) {
  const q = (mm: string, dd: string) => `${year}-${mm}-${dd}`;
  return [
    { key: 'lkpm', title: `LKPM (investment activity report) Q4 ${year - 1}`, category: 'regulator', authority: 'BKPM / OSS', due: q('01', '10'), recurrence: 'quarterly', remindDays: 10 },
    { key: 'wlkp', title: `WLKP (company manpower report) ${year}`, category: 'regulator', authority: 'Kemnaker', due: q('01', '31'), recurrence: 'yearly', remindDays: 21 },
    { key: 'spklu', title: `Charging-station (SPKLU) operations report Q4 ${year - 1}`, category: 'licence', authority: 'Ditjen Gatrik, Kementerian ESDM', due: q('01', '15'), recurrence: 'quarterly', remindDays: 10 },
    { key: 'afs', title: `Audited financial statements FY ${year - 1}`, category: 'financial_statements', authority: 'Auditor (KAP)', due: q('04', '30'), recurrence: 'yearly', remindDays: 45 },
    { key: 'rups', title: `Annual GMS (RUPS Tahunan) and annual report FY ${year - 1}`, category: 'corporate', authority: 'Shareholders (UU 40/2007)', due: q('06', '30'), recurrence: 'yearly', remindDays: 30 },
  ] as const;
}

const T_SELECT = `SELECT t.*, to_char(t.due_on, 'YYYY-MM-DD') AS due_s, to_char(t.done_on, 'YYYY-MM-DD') AS done_s, u.name AS owner_name, d.name AS done_by_name,
    (SELECT count(*) FROM compliance_evidence e WHERE e.task_id = t.id)::int AS files
  FROM compliance_task t LEFT JOIN app_user u ON u.id = t.owner_id LEFT JOIN app_user d ON d.id = t.done_by`;

const tView = (t: any, now = today()) => ({
  id: String(t.id), title: t.title, category: t.category, authority: t.authority ?? null, dueOn: t.due_s, recurrence: t.recurrence, ownerId: t.owner_id ?? null, owner: t.owner_name ?? null,
  remindDays: t.remind_days, status: t.status, doneOn: t.done_s ?? null, doneBy: t.done_by_name ?? null, note: t.note ?? null, files: t.files, nextId: t.next_id ? String(t.next_id) : null,
  daysLeft: days(now, t.due_s), overdue: t.status === 'open' && t.due_s < now, onTime: t.status === 'done' ? t.done_s <= t.due_s : null,
});

async function ownerOk(orgId: string, raw: unknown) {
  if (raw == null || raw === '') return null;
  const id = String(raw);
  if (!UUID_RE.test(id) || !(await outsideRequestScope(() => one(`SELECT 1 FROM app_user WHERE id = $1 AND org_id = $2`, [id, orgId])))) throw new ComplianceError(422, 'No such user for the owner.');
  return id;
}

export async function overview(orgId: string, q: { from?: unknown; to?: unknown } = {}) {
  const t = today();
  const from = q.from ? String(q.from) : `${t.slice(0, 4)}-01-01`, to = q.to ? String(q.to) : `${t.slice(0, 4)}-12-31`;
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from) throw new ComplianceError(400, 'from and to are YYYY-MM-DD, to on or after from.');
  const rows = (await outsideRequestScope(() => many<any>(`${T_SELECT} WHERE t.org_id = $1 AND ((t.due_on BETWEEN $2::date AND $3::date) OR (t.status = 'open' AND t.due_on < $4::date)) ORDER BY t.due_on, t.id`, [orgId, from, to, t]))).map((x) => tView(x, t));
  const yearAgo = new Date(Date.parse(`${t}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10);
  const hist = await outsideRequestScope(() => one<any>(`SELECT count(*) FILTER (WHERE status = 'done')::int AS done, count(*) FILTER (WHERE status = 'done' AND done_on <= due_on)::int AS on_time
      FROM compliance_task WHERE org_id = $1 AND due_on BETWEEN $2::date AND $3::date`, [orgId, yearAgo, t]));
  const pbc = await pbcList(orgId);
  return {
    from, to, tasks: rows,
    stats: { open: rows.filter((r) => r.status === 'open').length, overdue: rows.filter((r) => r.overdue).length, dueIn30: rows.filter((r) => r.status === 'open' && r.daysLeft >= 0 && r.daysLeft <= 30).length,
      onTimePct: hist?.done ? Math.round((hist.on_time / hist.done) * 1000) / 10 : null, pbcOpen: pbc.filter((p) => p.status !== 'accepted').length, pbcOverdue: pbc.filter((p) => p.overdue).length },
    pbc,
  };
}

async function tRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new ComplianceError(404, 'No such task.');
  const r = await outsideRequestScope(() => one<any>(`${T_SELECT} WHERE t.id = $1 AND t.org_id = $2`, [id, orgId]));
  if (!r) throw new ComplianceError(404, 'No such task.');
  return r;
}

export async function getTask(orgId: string, id: string) {
  const t = tView(await tRow(orgId, id));
  return { ...t, evidence: await evidenceList(orgId, { taskId: t.id }) };
}

export async function saveTask(orgId: string, id: string | null, b: Record<string, unknown>, userId: string | null) {
  const cur = id ? await tRow(orgId, id) : null;
  if (cur && cur.status !== 'open') throw new ComplianceError(409, `The task is ${cur.status}; reopen it first.`);
  const v = (k: string, col: string) => (b[k] === undefined && cur ? cur[col] : b[k]);
  const title = String(v('title', 'title') ?? '').trim();
  if (title.length < 3) throw new ComplianceError(422, 'title is at least 3 characters.');
  const category = String(v('category', 'category') ?? '');
  if (!(CATEGORIES as readonly string[]).includes(category)) throw new ComplianceError(422, `category is one of ${CATEGORIES.join(', ')}.`);
  const due = String(v('dueOn', 'due_s') ?? '');
  if (!DATE_RE.test(due)) throw new ComplianceError(422, 'dueOn is YYYY-MM-DD.');
  const rec = String(v('recurrence', 'recurrence') ?? 'none');
  if (!(RECURRENCES as readonly string[]).includes(rec)) throw new ComplianceError(422, `recurrence is one of ${RECURRENCES.join(', ')}.`);
  const remind = Number(v('remindDays', 'remind_days') ?? 14);
  if (!Number.isInteger(remind) || remind < 0 || remind > 120) throw new ComplianceError(422, 'remindDays is 0 to 120.');
  const owner = await ownerOk(orgId, v('ownerId', 'owner_id'));
  const authority = v('authority', 'authority') ? String(v('authority', 'authority')).slice(0, 120) : null, note = v('note', 'note') ? String(v('note', 'note')).slice(0, 1000) : null;
  const p = [orgId, title.slice(0, 200), category, authority, due, rec, owner, remind, note];
  const r = cur
    ? await outsideRequestScope(() => one<any>(`UPDATE compliance_task SET title = $2, category = $3, authority = $4, due_on = $5, recurrence = $6, owner_id = $7, remind_days = $8, note = $9 WHERE org_id = $1 AND id = $10 RETURNING id`, [...p, cur.id]))
    : await outsideRequestScope(() => one<any>(`INSERT INTO compliance_task (org_id, title, category, authority, due_on, recurrence, owner_id, remind_days, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`, [...p, userId]));
  return getTask(orgId, String(r.id));
}

/** done | waived | open (reopen). Done on a recurring task creates the next one (once). */
export async function setStatus(orgId: string, id: string, b: Record<string, unknown>, userId: string | null) {
  const cur = await tRow(orgId, id);
  const status = String(b.status ?? '');
  if (!['done', 'waived', 'open'].includes(status)) throw new ComplianceError(422, 'status is done, waived or open.');
  if (status === cur.status) throw new ComplianceError(409, `The task is already ${status}.`);
  const note = b.note ? String(b.note).slice(0, 1000) : null;
  if (status === 'waived' && !note) throw new ComplianceError(422, 'Say why the task is waived (note).');
  const doneOn = status === 'done' ? String(b.doneOn ?? today()) : null;
  if (doneOn && !DATE_RE.test(doneOn)) throw new ComplianceError(422, 'doneOn is YYYY-MM-DD.');
  if (doneOn && doneOn > today()) throw new ComplianceError(422, 'doneOn cannot be in the future.');
  await outsideRequestScope(() => query(`UPDATE compliance_task SET status = $2, done_on = $3, done_by = $4, note = COALESCE($5, note) WHERE id = $1`,
    [cur.id, status, doneOn, status === 'open' ? null : userId, note]));
  if (status !== 'open') await outsideRequestScope(() => resolveAlertsFor(orgId, DUE, 'compliance_task', String(cur.id))).catch(() => 0);
  if (status === 'done' && !cur.next_id) {
    const nd = nextDue(cur.due_s, cur.recurrence);
    if (nd) {
      const n = await outsideRequestScope(() => one<{ id: string }>(
        `INSERT INTO compliance_task (org_id, title, category, authority, due_on, recurrence, owner_id, remind_days, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [orgId, rollTitle(cur.title, cur.due_s, nd), cur.category, cur.authority, nd, cur.recurrence, cur.owner_id, cur.remind_days, userId]));
      await outsideRequestScope(() => query(`UPDATE compliance_task SET next_id = $2 WHERE id = $1`, [cur.id, n!.id]));
    }
  }
  return getTask(orgId, String(cur.id));
}

/** Move the years (and quarter labels) in a recurring title along with the due date: "… Q4 2025" → "… Q1 2026". Pure. */
export function rollTitle(title: string, from: string, to: string): string {
  const dy = Number(to.slice(0, 4)) - Number(from.slice(0, 4));
  const qm = (Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7))) - (Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)));
  const quarter = title.match(/\bQ([1-4]) (\d{4})\b/);
  if (quarter && qm % 3 === 0) {
    const idx = Number(quarter[2]) * 4 + Number(quarter[1]) - 1 + qm / 3;
    return title.replace(quarter[0], `Q${(idx % 4) + 1} ${Math.floor(idx / 4)}`);
  }
  return dy ? title.replace(/\b(19|20)\d{2}\b/g, (y) => String(Number(y) + dy)) : title;
}

/** Add a year's standard deadlines, each once (by title). */
export async function applyTemplates(orgId: string, yearRaw: unknown, userId: string | null) {
  const year = Number(yearRaw ?? today().slice(0, 4));
  if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new ComplianceError(422, 'year is 2020 to 2100.');
  let added = 0;
  for (const t of templates(year)) {
    const have = await outsideRequestScope(() => one(`SELECT 1 FROM compliance_task WHERE org_id = $1 AND title = $2`, [orgId, t.title]));
    if (have) continue;
    await outsideRequestScope(() => query(`INSERT INTO compliance_task (org_id, title, category, authority, due_on, recurrence, remind_days, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [orgId, t.title, t.category, t.authority, t.due, t.recurrence, t.remindDays, 'From the standard calendar: check the date with your advisers.', userId]));
    added++;
  }
  return { year, added, templates: templates(year).length };
}

// ------------------------------------------------------------------------------------------------ PBC

const P_SELECT = `SELECT p.*, to_char(p.requested_on, 'YYYY-MM-DD') AS req_s, to_char(p.due_on, 'YYYY-MM-DD') AS due_s, to_char(p.provided_on, 'YYYY-MM-DD') AS prov_s, u.name AS owner_name,
    (SELECT count(*) FROM compliance_evidence e WHERE e.pbc_id = p.id)::int AS files
  FROM pbc_request p LEFT JOIN app_user u ON u.id = p.owner_id`;
const pbcView = (p: any, now = today()) => ({
  id: String(p.id), audit: p.audit, ref: p.ref ?? null, item: p.item, requestedOn: p.req_s, dueOn: p.due_s ?? null, ownerId: p.owner_id ?? null, owner: p.owner_name ?? null,
  status: p.status, note: p.note ?? null, providedOn: p.prov_s ?? null, files: p.files, overdue: !!p.due_s && ['requested', 'in_progress'].includes(p.status) && p.due_s < now,
});

export async function pbcList(orgId: string, audit?: string) {
  return (await outsideRequestScope(() => many<any>(`${P_SELECT} WHERE p.org_id = $1 AND ($2::text IS NULL OR p.audit = $2::text) ORDER BY (p.status = 'accepted'), p.due_on NULLS LAST, p.id`, [orgId, audit ?? null]))).map((p) => pbcView(p));
}

async function pbcRow(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new ComplianceError(404, 'No such request.');
  const r = await outsideRequestScope(() => one<any>(`${P_SELECT} WHERE p.id = $1 AND p.org_id = $2`, [id, orgId]));
  if (!r) throw new ComplianceError(404, 'No such request.');
  return r;
}

export async function getPbc(orgId: string, id: string) {
  const p = pbcView(await pbcRow(orgId, id));
  return { ...p, evidence: await evidenceList(orgId, { pbcId: p.id }) };
}

export async function createPbc(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const audit = String(b.audit ?? '').trim(), item = String(b.item ?? '').trim();
  if (audit.length < 2 || item.length < 3) throw new ComplianceError(422, 'audit and item are needed.');
  const req = String(b.requestedOn ?? today()), due = b.dueOn ? String(b.dueOn) : null;
  if (!DATE_RE.test(req) || (due && (!DATE_RE.test(due) || due < req))) throw new ComplianceError(422, 'requestedOn and dueOn are YYYY-MM-DD, due on or after requested.');
  const owner = await ownerOk(orgId, b.ownerId);
  const r = await outsideRequestScope(() => one<{ id: string }>(`INSERT INTO pbc_request (org_id, audit, ref, item, requested_on, due_on, owner_id, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [orgId, audit.slice(0, 80), b.ref ? String(b.ref).slice(0, 40) : null, item.slice(0, 500), req, due, owner, b.note ? String(b.note).slice(0, 1000) : null, userId]));
  return getPbc(orgId, String(r!.id));
}

const PBC_NEXT: Record<string, string[]> = { requested: ['in_progress', 'provided'], in_progress: ['provided', 'requested'], provided: ['accepted', 'in_progress'], accepted: [] };

export async function updatePbc(orgId: string, id: string, b: Record<string, unknown>) {
  const cur = await pbcRow(orgId, id);
  const status = b.status == null ? cur.status : String(b.status);
  if (status !== cur.status && !PBC_NEXT[cur.status]!.includes(status)) throw new ComplianceError(409, `A ${cur.status.replace('_', ' ')} request moves to ${PBC_NEXT[cur.status]!.join(' or ') || 'nothing'}.`);
  if (status === 'provided' && status !== cur.status && !cur.files) throw new ComplianceError(409, 'Attach the file before marking the request provided.');
  const owner = b.ownerId === undefined ? cur.owner_id : await ownerOk(orgId, b.ownerId);
  const due = b.dueOn === undefined ? cur.due_s : b.dueOn ? String(b.dueOn) : null;
  if (due && !DATE_RE.test(due)) throw new ComplianceError(422, 'dueOn is YYYY-MM-DD.');
  await outsideRequestScope(() => query(`UPDATE pbc_request SET status = $2, owner_id = $3, due_on = $4, note = COALESCE($5, note), provided_on = CASE WHEN $2 = 'provided' AND status <> 'provided' THEN $6::date WHEN $2 IN ('requested', 'in_progress') THEN NULL ELSE provided_on END WHERE id = $1`,
    [cur.id, status, owner, due, b.note ? String(b.note).slice(0, 1000) : null, today()]));
  return getPbc(orgId, String(cur.id));
}

// ------------------------------------------------------------------------------------------------ evidence

async function evidenceList(orgId: string, on: { taskId?: string; pbcId?: string }) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT e.id, e.filename, e.mime, e.bytes, e.sha256, e.uploaded_at, u.name AS by FROM compliance_evidence e LEFT JOIN app_user u ON u.id = e.uploaded_by
      WHERE e.org_id = $1 AND (e.task_id = $2::bigint OR e.pbc_id = $3::bigint) ORDER BY e.id`, [orgId, on.taskId ?? null, on.pbcId ?? null]));
  return rows.map((e) => ({ id: String(e.id), filename: e.filename, mime: e.mime, bytes: e.bytes, sha256: e.sha256, uploadedAt: new Date(e.uploaded_at).toISOString(), uploadedBy: e.by ?? null }));
}

export async function addEvidence(orgId: string, on: { taskId?: string; pbcId?: string }, b: Record<string, unknown>, userId: string | null) {
  if (on.taskId) { const t = await tRow(orgId, on.taskId); if (t.status !== 'open' && t.status !== 'done') throw new ComplianceError(409, `The task is ${t.status}.`); }
  if (on.pbcId) { const p = await pbcRow(orgId, on.pbcId); if (p.status === 'accepted') throw new ComplianceError(409, 'The request is accepted.'); }
  const mime = String(b.mime ?? '');
  if (!(MIMES as readonly string[]).includes(mime)) throw new ComplianceError(422, 'mime is PDF, PNG, JPEG, XLSX, DOCX or CSV.');
  const filename = String(b.filename ?? 'evidence').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'evidence';
  const data = Buffer.from(String(b.data ?? ''), 'base64');
  if (!data.length) throw new ComplianceError(422, 'data is the file, base64.');
  if (data.length > MAX_EVIDENCE) throw new ComplianceError(413, 'A file is at most 5 MB.');
  if (!sniffOk(mime, data)) throw new ComplianceError(422, 'The file does not look like the type it says it is.');
  const sha = createHash('sha256').update(data).digest('hex');
  const r = await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO compliance_evidence (org_id, task_id, pbc_id, filename, mime, bytes, sha256, data, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [orgId, on.taskId ?? null, on.pbcId ?? null, filename, mime, data.length, sha, data, userId]));
  return { id: String(r!.id), filename, mime, bytes: data.length, sha256: sha };
}

export async function getEvidence(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new ComplianceError(404, 'No such file.');
  const r = await outsideRequestScope(() => one<{ filename: string; mime: string; data: Buffer }>(`SELECT filename, mime, data FROM compliance_evidence WHERE id = $1 AND org_id = $2`, [id, orgId]));
  if (!r) throw new ComplianceError(404, 'No such file.');
  return r;
}

export async function calendarXlsx(orgId: string, q: { from?: unknown; to?: unknown }): Promise<Buffer> {
  const o = await overview(orgId, q);
  return xlsx([
    { name: 'Calendar', rows: [['Due', 'Title', 'Category', 'Authority', 'Recurrence', 'Owner', 'Status', 'Done on', 'On time', 'Files', 'Note'],
      ...o.tasks.map((t) => [t.dueOn, t.title, t.category, t.authority ?? '', t.recurrence, t.owner ?? '', t.overdue ? 'overdue' : t.status, t.doneOn ?? '', t.onTime == null ? '' : t.onTime ? 'yes' : 'no', t.files, t.note ?? ''])],
      widths: [11, 50, 18, 26, 11, 20, 10, 11, 8, 6, 40] },
    { name: 'PBC', rows: [['Audit', 'Ref', 'Item', 'Requested', 'Due', 'Owner', 'Status', 'Provided', 'Files'], ...o.pbc.map((p) => [p.audit, p.ref ?? '', p.item, p.requestedOn, p.dueOn ?? '', p.owner ?? '', p.overdue ? 'overdue' : p.status, p.providedOn ?? '', p.files])],
      widths: [16, 8, 50, 11, 11, 20, 12, 11, 6] },
  ]);
}

/** Daily: open tasks inside their reminder window raise the due alert (critical once overdue). */
export async function sweep(now = new Date()): Promise<number> {
  const t = today(now);
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT id, org_id, title, to_char(due_on, 'YYYY-MM-DD') AS due_s FROM compliance_task WHERE status = 'open' AND due_on - remind_days <= $1::date`, [t]));
  let n = 0;
  for (const r of rows) {
    try {
      const left = days(t, r.due_s);
      await outsideRequestScope(() => persistAlert({ orgId: r.org_id, kind: DUE, severity: left < 0 ? 'critical' : 'warning', targetType: 'compliance_task', targetId: String(r.id),
        message: `${r.title}: ${left < 0 ? `overdue since ${r.due_s}` : left === 0 ? 'due today' : `due on ${r.due_s} (${left} days)`}. Finance → Compliance.` }));
      n++;
    } catch (e) { logger.warn({ task: r.id, err: (e as Error).message }, 'compliance reminder failed'); }
  }
  return n;
}
