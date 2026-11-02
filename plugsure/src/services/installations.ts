import { readFile } from 'node:fs/promises';
import { many, one, outsideRequestScope, query, tx } from '../db/pool.js';
import { saveBuffer } from './storage.js';
import { persistAlert } from './alerts.js';

/**
 * The installation pipeline (v1.48.0), Assets & energy → Installations. A new site from the first survey to live:
 *
 *   stages     survey → design → permit (building and local permits) → grid (the PLN connection or upgrade) →
 *              install → commission → live; or cancelled
 *   tasks      each stage starts with its usual tasks (editable); a stage's required tasks must be done before the
 *              project moves on (the move is recorded with who and a note)
 *   documents  survey reports, drawings, permits, the PLN letter, photos, commissioning reports: PDF, images or office
 *              files up to 15 MB, kept under STORAGE_DIR/install
 *   links      the candidate site it came from (Demand & planning), its capex project (budget and spend), and the site
 *              it becomes (required to go live: onboarding its chargers is the commission stage's work)
 *   dates      a target go-live date; a project past it and not live raises install.overdue (once a week)
 */

export class InstallError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const STAGES = ['survey', 'design', 'permit', 'grid', 'install', 'commission', 'live'] as const;
export type Stage = (typeof STAGES)[number];
export const OVERDUE_ALERT = 'install.overdue';
const S = <T>(fn: () => T) => outsideRequestScope(fn);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DOC = 15 * 1024 * 1024;

/** The tasks each stage starts with. */
export const DEFAULT_TASKS: Record<Exclude<Stage, 'live'>, Array<{ title: string; required?: boolean }>> = {
  survey: [{ title: 'Site visit and photos' }, { title: 'Parking bays and cable route measured' }, { title: 'Existing supply and panel capacity checked' }, { title: 'Landlord agreement in principle', required: false }],
  design: [{ title: 'Single-line diagram' }, { title: 'Charger layout and civil works drawing' }, { title: 'Load calculation and connected power (kVA)' }, { title: 'Bill of materials and quotation' }],
  permit: [{ title: 'Landlord or building management approval' }, { title: 'Local permits (PBG/SLF where needed)', required: false }, { title: 'SPKLU registration with the ministry (ESDM)', required: false }],
  grid: [{ title: 'PLN application submitted' }, { title: 'PLN survey and cost letter' }, { title: 'Connection fee paid' }, { title: 'Meter installed / power upgraded' }],
  install: [{ title: 'Civil works and cabling' }, { title: 'Chargers mounted and wired' }, { title: 'Signage and bay markings', required: false }, { title: 'Electrical inspection (SLO)' }],
  commission: [{ title: 'Chargers onboarded and connected' }, { title: 'Test charge on every connector' }, { title: 'Tariff and site published' }, { title: 'Handover to operations' }],
};

const next = (s: string): Stage | null => { const i = STAGES.indexOf(s as Stage); return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1]! : null; };

const projOf = (p: any) => ({
  id: String(p.id), number: p.number, name: p.name, address: p.address ?? null, stage: p.stage, siteId: p.site_id ?? null, site: p.site_name ?? null,
  candidateId: p.candidate_id == null ? null : String(p.candidate_id), candidate: p.candidate_name ?? null, capexProjectId: p.capex_project_id == null ? null : String(p.capex_project_id),
  capex: p.capex_number ? `${p.capex_number} · ${p.capex_name}` : null, ownerId: p.owner_id ?? null, owner: p.owner_name ?? null,
  chargersPlanned: p.chargers_planned ?? null, kwPlanned: p.kw_planned == null ? null : Number(p.kw_planned),
  targetLiveOn: p.target_s ?? null, liveOn: p.live_s ?? null, notes: p.notes ?? null, stageSince: new Date(p.stage_changed_at).toISOString(),
  daysInStage: Math.floor((Date.now() - new Date(p.stage_changed_at).getTime()) / 86_400_000),
  overdue: !!p.target_s && !['live', 'cancelled'].includes(p.stage) && p.target_s < new Date().toISOString().slice(0, 10),
  tasksOpen: Number(p.tasks_open ?? 0), tasksDone: Number(p.tasks_done ?? 0), documents: Number(p.docs ?? 0),
});
const SELECT = `SELECT p.*, to_char(p.target_live_on, 'YYYY-MM-DD') AS target_s, to_char(p.live_on, 'YYYY-MM-DD') AS live_s, s.name AS site_name, c.name AS candidate_name,
    cx.number AS capex_number, cx.name AS capex_name, u.name AS owner_name,
    (SELECT count(*) FROM install_task t WHERE t.project_id = p.id AND t.stage = p.stage AND t.removed_at IS NULL AND t.done_at IS NULL) AS tasks_open,
    (SELECT count(*) FROM install_task t WHERE t.project_id = p.id AND t.stage = p.stage AND t.removed_at IS NULL AND t.done_at IS NOT NULL) AS tasks_done,
    (SELECT count(*) FROM install_document d WHERE d.project_id = p.id AND d.removed_at IS NULL) AS docs
  FROM install_project p LEFT JOIN site s ON s.id = p.site_id LEFT JOIN site_candidate c ON c.id = p.candidate_id
  LEFT JOIN capex_project cx ON cx.id = p.capex_project_id LEFT JOIN app_user u ON u.id = p.owner_id`;

async function row(orgId: string, id: string) {
  const p = await S(() => one<any>(`${SELECT} WHERE p.id = $1 AND p.org_id = $2`, [Number(id) || 0, orgId]));
  if (!p) throw new InstallError(404, 'No such installation project.');
  return p;
}

export async function list(orgId: string, q: Record<string, unknown> = {}) {
  const all = q.status === 'all';
  const rows = (await S(() => many<any>(`${SELECT} WHERE p.org_id = $1 AND ($2 OR p.stage NOT IN ('live', 'cancelled') OR p.live_on > current_date - 90) ORDER BY p.target_live_on NULLS LAST, p.id`, [orgId, all]))).map(projOf);
  const byStage = Object.fromEntries([...STAGES, 'cancelled'].map((s) => [s, rows.filter((r) => r.stage === s).length]));
  return { projects: rows, byStage, stages: STAGES };
}

async function addStageTasks(c: any, orgId: string, projectId: string, stage: Stage) {
  if (stage === 'live') return;
  let i = 0;
  for (const t of DEFAULT_TASKS[stage]) await c.query(`INSERT INTO install_task (org_id, project_id, stage, title, required, sort) VALUES ($1,$2,$3,$4,$5,$6)`, [orgId, projectId, stage, t.title, t.required !== false, i++]);
}

async function checkLinks(orgId: string, b: Record<string, unknown>, cur: any) {
  const v = (k: string, col: string) => (b[k] !== undefined ? b[k] : cur?.[col]);
  const siteId = v('siteId', 'site_id') ? String(v('siteId', 'site_id')) : null;
  if (siteId && !(UUID_RE.test(siteId) && await S(() => one(`SELECT 1 FROM site WHERE id = $1 AND org_id = $2`, [siteId, orgId])))) throw new InstallError(422, 'No such site.');
  const cand = v('candidateId', 'candidate_id') ? Number(v('candidateId', 'candidate_id')) : null;
  if (cand && !(await S(() => one(`SELECT 1 FROM site_candidate WHERE id = $1 AND org_id = $2`, [cand, orgId])))) throw new InstallError(422, 'No such candidate site.');
  const capex = v('capexProjectId', 'capex_project_id') ? Number(v('capexProjectId', 'capex_project_id')) : null;
  if (capex && !(await S(() => one(`SELECT 1 FROM capex_project WHERE id = $1 AND org_id = $2`, [capex, orgId])))) throw new InstallError(422, 'No such capex project.');
  const owner = v('ownerId', 'owner_id') ? String(v('ownerId', 'owner_id')) : null;
  if (owner && !(UUID_RE.test(owner) && await S(() => one(`SELECT 1 FROM app_user WHERE id = $1`, [owner])))) throw new InstallError(422, 'No such user.');
  return { siteId, cand, capex, owner };
}

export async function save(orgId: string, id: string | null, b: Record<string, unknown>, userId: string | null) {
  const cur = id ? await row(orgId, id) : null;
  const v = (k: string, col: string) => (b[k] !== undefined ? b[k] : cur?.[col]);
  const name = String(v('name', 'name') ?? '').trim().slice(0, 120);
  if (!name) throw new InstallError(422, 'name is required.');
  const l = await checkLinks(orgId, b, cur);
  const target = b.targetLiveOn !== undefined ? (b.targetLiveOn ? String(b.targetLiveOn) : null) : cur?.target_s ?? null;
  if (target && !/^\d{4}-\d{2}-\d{2}$/.test(target)) throw new InstallError(422, 'targetLiveOn is YYYY-MM-DD.');
  const chargers = v('chargersPlanned', 'chargers_planned') == null || v('chargersPlanned', 'chargers_planned') === '' ? null : Number(v('chargersPlanned', 'chargers_planned'));
  if (chargers != null && !(Number.isInteger(chargers) && chargers >= 1 && chargers <= 500)) throw new InstallError(422, 'chargersPlanned is 1 to 500.');
  const kw = v('kwPlanned', 'kw_planned') == null || v('kwPlanned', 'kw_planned') === '' ? null : Number(v('kwPlanned', 'kw_planned'));
  if (kw != null && !(kw > 0 && kw <= 100_000)) throw new InstallError(422, 'kwPlanned is the total power, kW.');
  const address = v('address', 'address') ? String(v('address', 'address')).slice(0, 300) : null;
  const notes = v('notes', 'notes') ? String(v('notes', 'notes')).slice(0, 5000) : null;
  if (cur) {
    await S(() => query(`UPDATE install_project SET name = $2, address = $3, site_id = $4, candidate_id = $5, capex_project_id = $6, owner_id = $7, chargers_planned = $8, kw_planned = $9,
      target_live_on = $10, notes = $11 WHERE id = $1`, [cur.id, name, address, l.siteId, l.cand, l.capex, l.owner, chargers, kw, target, notes]));
    return get(orgId, String(cur.id));
  }
  const newId = await S(() => tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('install_project:' || $1))`, [orgId]);
    const n = Number((await c.query(`SELECT count(*) AS n FROM install_project WHERE org_id = $1`, [orgId])).rows[0].n) + 1;
    const r = (await c.query(
      `INSERT INTO install_project (org_id, number, name, address, site_id, candidate_id, capex_project_id, owner_id, chargers_planned, kw_planned, target_live_on, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [orgId, `INS-${String(n).padStart(4, '0')}`, name, address, l.siteId, l.cand, l.capex, l.owner, chargers, kw, target, notes])).rows[0];
    await c.query(`INSERT INTO install_stage_event (org_id, project_id, from_stage, to_stage, note, user_id) VALUES ($1,$2,NULL,'survey','Created',$3)`, [orgId, r.id, userId]);
    await addStageTasks(c, orgId, String(r.id), 'survey');
    return String(r.id);
  }));
  return get(orgId, newId);
}

export async function get(orgId: string, id: string) {
  const p = await row(orgId, id);
  const [tasks, docs, events] = await Promise.all([
    S(() => many<any>(`SELECT t.*, to_char(t.due_on, 'YYYY-MM-DD') AS due_s, u.name AS assignee FROM install_task t LEFT JOIN app_user u ON u.id = t.assignee_id
      WHERE t.project_id = $1 AND t.removed_at IS NULL ORDER BY array_position($2::text[], t.stage), t.sort, t.id`, [p.id, [...STAGES]])),
    S(() => many<any>(`SELECT id, kind, name, mime, bytes, created_at FROM install_document WHERE project_id = $1 AND removed_at IS NULL ORDER BY id DESC`, [p.id])),
    S(() => many<any>(`SELECT e.*, u.name AS user_name FROM install_stage_event e LEFT JOIN app_user u ON u.id = e.user_id WHERE e.project_id = $1 ORDER BY e.at`, [p.id])),
  ]);
  let capex = null;
  if (p.capex_project_id) {
    try { const cx = await (await import('./capex-projects.js')).get(orgId, String(p.capex_project_id)) as any; capex = { id: String(p.capex_project_id), number: cx.number, name: cx.name, status: cx.status, currency: cx.currency, budget: cx.budget ?? null, spent: cx.actual ?? null, committed: cx.committed ?? null }; } catch { capex = null; }
  }
  return {
    ...projOf(p), nextStage: ['live', 'cancelled'].includes(p.stage) ? null : next(p.stage), capexDetail: capex,
    tasks: tasks.map((t) => ({ id: String(t.id), stage: t.stage, title: t.title, required: t.required, dueOn: t.due_s ?? null, assigneeId: t.assignee_id ?? null, assignee: t.assignee ?? null,
      done: !!t.done_at, doneAt: t.done_at ? new Date(t.done_at).toISOString() : null })),
    documents: docs.map((d) => ({ id: String(d.id), kind: d.kind, name: d.name, mime: d.mime, bytes: d.bytes, at: new Date(d.created_at).toISOString(), url: `/v1/installations/documents/${d.id}` })),
    history: events.map((e) => ({ from: e.from_stage, to: e.to_stage, note: e.note ?? null, by: e.user_name ?? null, at: new Date(e.at).toISOString() })),
  };
}

/** Move to the next stage (its required tasks done; going live needs the site), or cancel. */
export async function advance(orgId: string, id: string, b: Record<string, unknown>, userId: string | null) {
  const p = await row(orgId, id);
  const note = b.note ? String(b.note).slice(0, 1000) : null;
  if (['live', 'cancelled'].includes(p.stage)) throw new InstallError(409, `The project is ${p.stage}.`);
  let to: string;
  if (b.action === 'cancel') {
    if (!note) throw new InstallError(422, 'Say why the project is cancelled (note).');
    to = 'cancelled';
  } else if (b.action === 'advance') {
    to = next(p.stage)!;
    const open = await S(() => many<any>(`SELECT title FROM install_task WHERE project_id = $1 AND stage = $2 AND required AND done_at IS NULL AND removed_at IS NULL ORDER BY sort`, [p.id, p.stage]));
    if (open.length) throw new InstallError(409, `Not done yet: ${open.map((t) => t.title).slice(0, 3).join('; ')}${open.length > 3 ? ` and ${open.length - 3} more` : ''}.`);
    if (to === 'live' && !p.site_id) throw new InstallError(409, 'Link the site it became (with its chargers onboarded) before going live.');
  } else throw new InstallError(422, 'action is advance or cancel.');
  await S(() => tx(async (c) => {
    await c.query(`UPDATE install_project SET stage = $2, stage_changed_at = now(), live_on = CASE WHEN $2 = 'live' THEN current_date ELSE live_on END WHERE id = $1`, [p.id, to]);
    await c.query(`INSERT INTO install_stage_event (org_id, project_id, from_stage, to_stage, note, user_id) VALUES ($1,$2,$3,$4,$5,$6)`, [orgId, p.id, p.stage, to, note, userId]);
    if (to !== 'cancelled' && !(await c.query(`SELECT 1 FROM install_task WHERE project_id = $1 AND stage = $2 LIMIT 1`, [p.id, to])).rowCount) await addStageTasks(c, orgId, String(p.id), to as Stage);
  }));
  if (to === 'live') await S(() => query(`UPDATE alert SET resolved_at = now() WHERE org_id = $1 AND kind = $2 AND target_id = $3 AND resolved_at IS NULL`, [orgId, OVERDUE_ALERT, String(p.id)])).catch(() => null);
  return get(orgId, id);
}

// ------------------------------------------------------------------ tasks

export async function saveTask(orgId: string, projectId: string, taskId: string | null, b: Record<string, unknown>, userId: string | null) {
  const p = await row(orgId, projectId);
  if (taskId) {
    const t = await S(() => one<any>(`SELECT * FROM install_task WHERE id = $1 AND project_id = $2 AND removed_at IS NULL`, [Number(taskId) || 0, p.id]));
    if (!t) throw new InstallError(404, 'No such task.');
    if (b.remove === true) { await S(() => query(`UPDATE install_task SET removed_at = now() WHERE id = $1`, [t.id])); return get(orgId, projectId); }
    const done = b.done === undefined ? null : b.done === true;
    const due = b.dueOn === undefined ? t.due_on : (b.dueOn ? String(b.dueOn) : null);
    if (due && !/^\d{4}-\d{2}-\d{2}/.test(String(due))) throw new InstallError(422, 'dueOn is YYYY-MM-DD.');
    await S(() => query(
      `UPDATE install_task SET title = COALESCE($2, title), required = COALESCE($3, required), due_on = $4, assignee_id = $5,
         done_at = CASE WHEN $6::boolean IS NULL THEN done_at WHEN $6 THEN COALESCE(done_at, now()) ELSE NULL END,
         done_by = CASE WHEN $6::boolean IS TRUE THEN COALESCE(done_by, $7) WHEN $6::boolean IS FALSE THEN NULL ELSE done_by END WHERE id = $1`,
      [t.id, b.title ? String(b.title).slice(0, 200) : null, b.required === undefined ? null : b.required === true, due,
        b.assigneeId === undefined ? t.assignee_id : (b.assigneeId ? String(b.assigneeId) : null), done, userId]));
    return get(orgId, projectId);
  }
  const title = String(b.title ?? '').trim().slice(0, 200);
  if (!title) throw new InstallError(422, 'title is required.');
  const stage = String(b.stage ?? p.stage);
  if (!(STAGES as readonly string[]).includes(stage) || stage === 'live') throw new InstallError(422, 'stage is survey, design, permit, grid, install or commission.');
  await S(() => query(`INSERT INTO install_task (org_id, project_id, stage, title, required, due_on, assignee_id, sort) VALUES ($1,$2,$3,$4,$5,$6,$7, 100)`,
    [orgId, p.id, stage, title, b.required !== false, b.dueOn ? String(b.dueOn) : null, b.assigneeId ? String(b.assigneeId) : null]));
  return get(orgId, projectId);
}

// ------------------------------------------------------------------ documents

const KINDS = ['survey', 'drawing', 'permit', 'grid', 'photo', 'commissioning', 'contract', 'other'];
const MIMES: Record<string, (b: Buffer) => boolean> = {
  'application/pdf': (b) => b.subarray(0, 5).toString() === '%PDF-',
  'image/jpeg': (b) => b.subarray(0, 3).toString('hex') === 'ffd8ff',
  'image/png': (b) => b.subarray(0, 4).toString('hex') === '89504e47',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (b) => b.subarray(0, 2).toString() === 'PK',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': (b) => b.subarray(0, 2).toString() === 'PK',
  'application/dwg': () => true,
};

export async function addDocument(orgId: string, projectId: string, b: Record<string, unknown>, userId: string | null) {
  const p = await row(orgId, projectId);
  const kind = String(b.kind ?? 'other');
  if (!KINDS.includes(kind)) throw new InstallError(422, `kind is ${KINDS.join(', ')}.`);
  const m = /^data:([\w./+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.dataUrl ?? ''));
  if (!m) throw new InstallError(422, 'dataUrl: the file as a data URL.');
  const mime = m[1]!;
  if (!MIMES[mime]) throw new InstallError(422, 'A PDF, JPEG, PNG, Word, Excel or DWG file.');
  const data = Buffer.from(m[2]!, 'base64');
  if (data.length > MAX_DOC) throw new InstallError(413, 'At most 15 MB a file.');
  if (data.length < 8 || !MIMES[mime]!(data)) throw new InstallError(422, 'The file is not the type it says it is.');
  const name = String(b.name ?? `${kind}`).replace(/[\\/]/g, '_').trim().slice(0, 160) || kind;
  const f = await saveBuffer('install', `${p.number}-${name}`, data);
  const r = await S(() => one<any>(`INSERT INTO install_document (org_id, project_id, kind, name, path, mime, bytes, sha256, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [orgId, p.id, kind, name, f.path, mime, f.size, f.sha256, userId]));
  return { id: String(r.id), name, kind };
}

export async function document(orgId: string, docId: string) {
  const d = await S(() => one<any>(`SELECT * FROM install_document WHERE id = $1 AND org_id = $2 AND removed_at IS NULL`, [Number(docId) || 0, orgId]));
  if (!d) throw new InstallError(404, 'No such document.');
  return { name: d.name, mime: d.mime, data: await readFile(d.path) };
}

export async function removeDocument(orgId: string, docId: string) {
  const r = await S(() => one<any>(`UPDATE install_document SET removed_at = now() WHERE id = $1 AND org_id = $2 AND removed_at IS NULL RETURNING id`, [Number(docId) || 0, orgId]));
  if (!r) throw new InstallError(404, 'No such document.');
  return { id: String(r.id), removed: true };
}

/** Worker (daily): projects past their target and not live raise install.overdue, at most once a week each. */
export async function overdueSweep(): Promise<number> {
  const rows = await S(() => many<any>(
    `UPDATE install_project SET overdue_alerted_on = current_date
      WHERE stage NOT IN ('live', 'cancelled') AND target_live_on < current_date AND (overdue_alerted_on IS NULL OR overdue_alerted_on < current_date - 6)
      RETURNING id, org_id, number, name, stage, to_char(target_live_on, 'YYYY-MM-DD') AS target`));
  for (const r of rows) {
    await S(() => persistAlert({ orgId: r.org_id, kind: OVERDUE_ALERT, severity: 'warning', targetType: 'install_project', targetId: String(r.id),
      message: `${r.number} ${r.name} was due to go live on ${r.target}; it is at ${r.stage}.` } as any)).catch(() => null);
  }
  return rows.length;
}
