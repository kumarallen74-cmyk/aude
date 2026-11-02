import { readFile } from 'node:fs/promises';
import { many, one, outsideRequestScope, query } from '../db/pool.js';
import * as commands from '../ocpp/commands.js';
import { saveBuffer } from './storage.js';

/**
 * The technician field app (v1.46.0), Maintain → Field (built for a phone). The work orders (maintenance.ts) a
 * technician is sent to, from the job list to the signature:
 *
 *   jobs        assigned to the technician (or not assigned yet), by the day planned; open and in progress first
 *   arrive      marks the arrival time and starts the job (in progress)
 *   checklist   from the job's template (per kind: corrective, preventive, warranty): each item done or not, with a
 *               note; required items must be done before the job can be finished
 *   photos      JPEG, PNG or WebP up to 3 MB each (the app shrinks them first), kept under STORAGE_DIR/field; the same
 *               photo sent twice is kept once
 *   parts       issued from stock to the job (inventory.ts): its cost is the job's
 *   charger     live: connected, its connectors' states and errors, the last heartbeat; "Check now" asks it for a fresh
 *               status and heartbeat
 *   finish      labour hours, the notes, the customer's or site contact's signature (when the template asks), at least
 *               one photo (when it asks); the job is done
 *   offline     the app keeps changes made without a signal and sends them when it can, each with its own id, so a
 *               change is applied once however often it is sent
 */

export class FieldError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const S = <T>(fn: () => T) => outsideRequestScope(fn);
const MAX_PHOTO = 3 * 1024 * 1024;
const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;
export interface ChecklistItem { id: string; label: string; required: boolean; done?: boolean; note?: string | null; at?: string | null }

// ------------------------------------------------------------------ templates

const tplOf = (t: any) => ({ id: String(t.id), name: t.name, kind: t.kind ?? null, items: t.items ?? [], requireSignature: t.require_signature, requirePhoto: t.require_photo });

export async function templates(orgId: string) {
  return (await S(() => many<any>(`SELECT * FROM field_template WHERE org_id = $1 AND archived_at IS NULL ORDER BY name`, [orgId]))).map(tplOf);
}

export async function saveTemplate(orgId: string, id: string | null, b: Record<string, unknown>) {
  if (id && b.archive === true) {
    const r = await S(() => one(`UPDATE field_template SET archived_at = now() WHERE id = $1 AND org_id = $2 AND archived_at IS NULL RETURNING id`, [Number(id) || 0, orgId]));
    if (!r) throw new FieldError(404, 'No such template.');
    return { id, archived: true };
  }
  const name = String(b.name ?? '').trim().slice(0, 80);
  if (!name) throw new FieldError(422, 'name is required.');
  const kind = b.kind ? String(b.kind) : null;
  if (kind && !['corrective', 'preventive', 'warranty'].includes(kind)) throw new FieldError(422, 'kind is corrective, preventive or warranty (or none: any job).');
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 60) throw new FieldError(422, 'items: 1 to 60 checklist items.');
  const items = (b.items as any[]).map((x, i) => {
    const label = String(x?.label ?? x ?? '').trim().slice(0, 200);
    if (!label) throw new FieldError(422, `Item ${i + 1} has no text.`);
    return { id: String(x?.id ?? `i${i + 1}`).slice(0, 20), label, required: x?.required !== false };
  });
  if (new Set(items.map((x) => x.id)).size !== items.length) throw new FieldError(422, 'Item ids must differ.');
  const vals = [orgId, name, kind, JSON.stringify(items), b.requireSignature === true, b.requirePhoto === true];
  const r = id
    ? await S(() => one<any>(`UPDATE field_template SET name = $2, kind = $3, items = $4, require_signature = $5, require_photo = $6 WHERE id = $7 AND org_id = $1 AND archived_at IS NULL RETURNING *`, [...vals, Number(id) || 0]))
    : await S(() => one<any>(`INSERT INTO field_template (org_id, name, kind, items, require_signature, require_photo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, vals));
  if (!r) throw new FieldError(404, 'No such template.');
  return tplOf(r);
}

/** The template for a job: its own, else the newest for its kind, else the newest for any kind. */
async function templateFor(orgId: string, wo: any) {
  if (wo.template_id) return S(() => one<any>(`SELECT * FROM field_template WHERE id = $1`, [wo.template_id]));
  return S(() => one<any>(`SELECT * FROM field_template WHERE org_id = $1 AND archived_at IS NULL AND (kind = $2 OR kind IS NULL) ORDER BY (kind IS NULL), created_at DESC LIMIT 1`, [orgId, wo.kind]));
}

// ------------------------------------------------------------------ jobs

async function woRow(orgId: string, id: string) {
  const r = await S(() => one<any>(
    `SELECT w.*, to_char(w.scheduled_for, 'YYYY-MM-DD') AS scheduled_s, to_char(w.opened_on, 'YYYY-MM-DD') AS opened_s, s.name AS site_name, s.address AS site_address, s.lat, s.lon,
            cp.ocpp_identity, COALESCE(cp.display_name, cp.ocpp_identity) AS cp_name, cp.last_heartbeat_at, cp.offline_since, cp.vendor, cp.model, u.name AS assignee
       FROM work_order w LEFT JOIN site s ON s.id = w.site_id LEFT JOIN charge_point cp ON cp.id = w.charge_point_id LEFT JOIN app_user u ON u.id = w.assignee_id
      WHERE w.id = $1 AND w.org_id = $2`, [Number(id) || 0, orgId]));
  if (!r) throw new FieldError(404, 'No such job.');
  return r;
}

const jobOf = (r: any) => ({
  id: String(r.id), number: r.number, kind: r.kind, status: r.status, title: r.title, description: r.description ?? null,
  site: r.site_name ?? null, siteAddress: r.site_address ?? null, lat: r.lat ?? null, lon: r.lon ?? null,
  chargePointId: r.charge_point_id ?? null, charger: r.cp_name ?? null, assigneeId: r.assignee_id ?? null, assignee: r.assignee ?? null,
  scheduledFor: r.scheduled_s ?? null, openedOn: r.opened_s ?? null, arrivedAt: r.arrived_at ? new Date(r.arrived_at).toISOString() : null,
  signed: !!r.signed_at,
});

/** The jobs a technician sees: assigned to them, or nobody yet (to pick up); open and in progress, plus done in 7 days. */
export async function jobs(orgId: string, userId: string | null, q: Record<string, unknown> = {}) {
  const mine = q.mine === 'true' || q.mine === true;
  const rows = await S(() => many<any>(
    `SELECT w.*, to_char(w.scheduled_for, 'YYYY-MM-DD') AS scheduled_s, to_char(w.opened_on, 'YYYY-MM-DD') AS opened_s, s.name AS site_name, s.address AS site_address, s.lat, s.lon,
            COALESCE(cp.display_name, cp.ocpp_identity) AS cp_name, u.name AS assignee
       FROM work_order w LEFT JOIN site s ON s.id = w.site_id LEFT JOIN charge_point cp ON cp.id = w.charge_point_id LEFT JOIN app_user u ON u.id = w.assignee_id
      WHERE w.org_id = $1 AND (w.status IN ('open', 'in_progress') OR (w.status = 'done' AND w.done_on > current_date - 7))
        AND ($2::uuid IS NULL OR w.assignee_id = $2 OR (NOT $3 AND w.assignee_id IS NULL))
      ORDER BY (w.status = 'done'), (w.status = 'in_progress') DESC, w.scheduled_for NULLS LAST, w.opened_on, w.id LIMIT 200`,
    [orgId, userId, mine]));
  return rows.map(jobOf);
}

/** The charger as it is now: connected, its connectors, the last heartbeat. */
async function chargerNow(r: any) {
  if (!r.charge_point_id) return null;
  const conns = await S(() => many<any>(
    `SELECT e.evse_id, c.connector_id, c.connector_type, c.status, c.error_code, c.status_updated_at FROM connector c JOIN evse e ON e.id = c.evse_uuid
      WHERE e.charge_point_id = $1 ORDER BY e.evse_id, c.connector_id`, [r.charge_point_id]));
  const hb = r.last_heartbeat_at ? new Date(r.last_heartbeat_at) : null;
  const online = commands.reachable(r.ocpp_identity) || (!r.offline_since && !!hb && Date.now() - hb.getTime() < 10 * 60_000);
  const alerts = await S(() => many<any>(`SELECT kind, severity, message, last_raised_at FROM alert WHERE target_id = $1 AND resolved_at IS NULL ORDER BY last_raised_at DESC LIMIT 5`, [r.charge_point_id]));
  return {
    identity: r.ocpp_identity, online, lastHeartbeatAt: hb?.toISOString() ?? null, vendor: r.vendor ?? null, model: r.model ?? null,
    connectors: conns.map((c) => ({ evse: c.evse_id, connector: c.connector_id, type: c.connector_type, status: c.status, errorCode: c.error_code && c.error_code !== 'NoError' ? c.error_code : null, since: c.status_updated_at ? new Date(c.status_updated_at).toISOString() : null })),
    alerts: alerts.map((a) => ({ kind: a.kind, severity: a.severity, message: a.message, at: new Date(a.last_raised_at).toISOString() })),
  };
}

export async function job(orgId: string, id: string) {
  const r = await woRow(orgId, id);
  const tpl = await templateFor(orgId, r);
  // The checklist: what was recorded, else the template's items not done yet.
  const recorded: ChecklistItem[] = Array.isArray(r.checklist) ? r.checklist : [];
  const items: ChecklistItem[] = recorded.length ? recorded : (tpl?.items ?? []).map((x: any) => ({ ...x, done: false, note: null, at: null }));
  const photos = await S(() => many<any>(`SELECT id, caption, created_at, bytes, mime FROM work_order_photo WHERE work_order_id = $1 ORDER BY id`, [r.id]));
  const parts = await S(() => many<any>(
    `SELECT m.id, i.name, i.sku, -m.qty AS qty, -m.value_minor AS value_minor, m.on_date FROM stock_move m JOIN stock_item i ON i.id = m.item_id
      WHERE m.work_order_id = $1 AND m.kind = 'issue' ORDER BY m.id`, [r.id]).catch(() => []));
  return {
    ...jobOf(r), labourHours: Number(r.labour_hours ?? 0), notes: r.field_notes ?? null, signatureName: r.signature_name ?? null, signedAt: r.signed_at ? new Date(r.signed_at).toISOString() : null,
    template: tpl ? { id: String(tpl.id), name: tpl.name, requireSignature: tpl.require_signature, requirePhoto: tpl.require_photo } : null,
    checklist: items,
    photos: photos.map((p) => ({ id: String(p.id), caption: p.caption ?? null, at: new Date(p.created_at).toISOString(), url: `/v1/field/photos/${p.id}` })),
    parts: parts.map((p) => ({ id: String(p.id), item: p.name, sku: p.sku ?? null, qty: Number(p.qty), valueMinor: Number(p.value_minor) })),
    charger: await chargerNow(r),
  };
}

/** Applied once per offline change id (the app's), so a change sent again is not applied twice. */
async function once(orgId: string, opId: unknown): Promise<boolean> {
  if (opId == null || opId === '') return true;
  const k = String(opId).slice(0, 80);
  const r = await S(() => query(`INSERT INTO field_op (org_id, op_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [orgId, k]));
  return (r.rowCount ?? 0) > 0;
}

/**
 * A change to a job: action arrive | take | checklist | notes | finish. `opId` (from the app's offline queue) makes it
 * apply once.
 */
export async function update(orgId: string, id: string, b: Record<string, unknown>, userId: string | null) {
  const r = await woRow(orgId, id);
  if (!(await once(orgId, b.opId))) return job(orgId, id);
  const action = String(b.action ?? '');
  if (['done', 'cancelled'].includes(r.status) && action !== 'notes') throw new FieldError(409, `The job is ${r.status}.`);
  if (action === 'take') {
    if (r.assignee_id && r.assignee_id !== userId) throw new FieldError(409, `${r.assignee ?? 'Someone else'} has this job.`);
    await S(() => query(`UPDATE work_order SET assignee_id = $2 WHERE id = $1`, [r.id, userId]));
  } else if (action === 'arrive') {
    await S(() => query(`UPDATE work_order SET arrived_at = COALESCE(arrived_at, $2::timestamptz), status = 'in_progress', assignee_id = COALESCE(assignee_id, $3) WHERE id = $1`,
      [r.id, b.at ? new Date(String(b.at)) : new Date(), userId]));
  } else if (action === 'checklist') {
    const cur = (await job(orgId, id)).checklist;
    const changes = Array.isArray(b.items) ? b.items as any[] : [];
    const next = cur.map((it) => {
      const c = changes.find((x) => x?.id === it.id);
      if (!c) return it;
      return { ...it, done: c.done === true, note: c.note == null ? it.note ?? null : String(c.note).slice(0, 500), at: c.done === true ? (it.at ?? new Date().toISOString()) : null };
    });
    await S(() => query(`UPDATE work_order SET checklist = $2 WHERE id = $1`, [r.id, JSON.stringify(next)]));
  } else if (action === 'notes') {
    const hours = b.labourHours == null || b.labourHours === '' ? null : Number(b.labourHours);
    if (hours != null && !(hours >= 0 && hours <= 200)) throw new FieldError(422, 'labourHours is 0 to 200.');
    await S(() => query(`UPDATE work_order SET field_notes = COALESCE($2, field_notes), labour_hours = COALESCE($3, labour_hours) WHERE id = $1`,
      [r.id, b.notes == null ? null : String(b.notes).slice(0, 5000), hours]));
  } else if (action === 'finish') {
    const j = await job(orgId, id);
    const missing = j.checklist.filter((x) => x.required && !x.done);
    if (missing.length) throw new FieldError(409, `Not done yet: ${missing.map((x) => x.label).slice(0, 3).join('; ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}.`);
    if (j.template?.requirePhoto && !j.photos.length) throw new FieldError(409, 'Add at least one photo first.');
    if (j.template?.requireSignature && !j.signedAt) throw new FieldError(409, 'The site contact\'s signature is needed first.');
    const hours = b.labourHours == null || b.labourHours === '' ? null : Number(b.labourHours);
    if (hours != null && !(hours >= 0 && hours <= 200)) throw new FieldError(422, 'labourHours is 0 to 200.');
    await S(() => query(
      `UPDATE work_order SET status = 'done', done_on = COALESCE(done_on, current_date), labour_hours = COALESCE($2, labour_hours), field_notes = COALESCE($3, field_notes),
              checklist = CASE WHEN checklist = '[]'::jsonb THEN $4 ELSE checklist END WHERE id = $1`,
      [r.id, hours, b.notes == null ? null : String(b.notes).slice(0, 5000), JSON.stringify(j.checklist)]));
  } else {
    throw new FieldError(422, 'action is take, arrive, checklist, notes or finish.');
  }
  return job(orgId, id);
}

function decode(dataUrl: unknown): { mime: string; data: Buffer } {
  const m = DATA_URL.exec(String(dataUrl ?? ''));
  if (!m) throw new FieldError(422, 'A JPEG, PNG or WebP image (data URL) is required.');
  const data = Buffer.from(m[2]!, 'base64');
  if (data.length > MAX_PHOTO) throw new FieldError(413, 'At most 3 MB a photo.');
  if (data.length < 100) throw new FieldError(422, 'The image is empty.');
  const sig = data.subarray(0, 4).toString('hex');
  const ok = m[1] === 'image/jpeg' ? sig.startsWith('ffd8ff') : m[1] === 'image/png' ? sig === '89504e47' : data.subarray(8, 12).toString() === 'WEBP';
  if (!ok) throw new FieldError(422, 'The file is not the image it says it is.');
  return { mime: m[1]!, data };
}

export async function addPhoto(orgId: string, id: string, b: Record<string, unknown>, userId: string | null) {
  const r = await woRow(orgId, id);
  const { mime, data } = decode(b.dataUrl);
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(data).digest('hex');
  const have = await S(() => one<{ id: string }>(`SELECT id FROM work_order_photo WHERE work_order_id = $1 AND sha256 = $2`, [r.id, sha]));
  if (have) return { id: String(have.id), duplicate: true };
  const f = await saveBuffer('field', `${r.number}.${ext}`, data);
  const p = await S(() => one<{ id: string }>(
    `INSERT INTO work_order_photo (org_id, work_order_id, path, sha256, bytes, mime, caption, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (work_order_id, sha256) DO UPDATE SET caption = COALESCE(EXCLUDED.caption, work_order_photo.caption) RETURNING id`,
    [orgId, r.id, f.path, sha, f.size, mime, b.caption ? String(b.caption).slice(0, 200) : null, userId]));
  return { id: String(p!.id), duplicate: false };
}

export async function photo(orgId: string, photoId: string): Promise<{ mime: string; data: Buffer }> {
  const p = await S(() => one<any>(`SELECT path, mime FROM work_order_photo WHERE id = $1 AND org_id = $2`, [Number(photoId) || 0, orgId]));
  if (!p) throw new FieldError(404, 'No such photo.');
  return { mime: p.mime, data: await readFile(p.path) };
}

/** The site contact signs on the phone: their name and the signature (a PNG drawn on the screen). */
export async function sign(orgId: string, id: string, b: Record<string, unknown>) {
  const r = await woRow(orgId, id);
  if (!(await once(orgId, b.opId))) return job(orgId, id);
  const name = String(b.name ?? '').trim().slice(0, 120);
  if (!name) throw new FieldError(422, 'The name of who signs is required.');
  const { mime, data } = decode(b.dataUrl);
  if (mime !== 'image/png') throw new FieldError(422, 'The signature is a PNG.');
  const f = await saveBuffer('field', `${r.number}-signature.png`, data);
  await S(() => query(`UPDATE work_order SET signature_name = $2, signature_path = $3, signed_at = now() WHERE id = $1`, [r.id, name, f.path]));
  return job(orgId, id);
}

export async function signature(orgId: string, id: string): Promise<Buffer> {
  const r = await woRow(orgId, id);
  if (!r.signature_path) throw new FieldError(404, 'Not signed.');
  return readFile(r.signature_path);
}

/** Parts used on the job, issued from stock. */
export async function issuePart(orgId: string, id: string, b: Record<string, unknown>, userId: string | null) {
  const r = await woRow(orgId, id);
  if (!(await once(orgId, b.opId))) return job(orgId, id);
  const inv = await import('./inventory.js');
  try {
    await inv.move(orgId, { kind: 'issue', itemId: b.itemId, qty: b.qty, locationId: b.locationId, workOrderId: String(r.id), note: `Field: ${r.number}` }, userId);
  } catch (e: any) {
    throw new FieldError(e?.statusCode && e.statusCode < 500 ? e.statusCode : 422, e?.message ?? 'Could not issue the part.');
  }
  return job(orgId, id);
}

/** Ask the charger for a fresh status and heartbeat, then show it as it is. */
export async function checkCharger(orgId: string, id: string, userId: string | null, ip: string | null) {
  const r = await woRow(orgId, id);
  if (!r.charge_point_id) throw new FieldError(409, 'This job is not on a charger.');
  const actor: commands.Actor = { type: 'user', id: userId ?? undefined, orgId, ip: ip ?? undefined };
  let asked = 'not connected';
  if (commands.reachable(r.ocpp_identity)) {
    try {
      const a = await commands.triggerMessage(r.ocpp_identity, 'StatusNotification', undefined, actor);
      await commands.triggerMessage(r.ocpp_identity, 'Heartbeat', undefined, actor).catch(() => null);
      asked = a?.status ?? 'no answer';
      await new Promise((res) => setTimeout(res, 1500));
    } catch (e) { asked = `could not ask: ${(e as Error).message}`.slice(0, 120); }
  }
  return { asked, charger: await chargerNow(await woRow(orgId, id)) };
}

/** Assign or schedule (the office side). */
export async function plan(orgId: string, id: string, b: Record<string, unknown>) {
  const r = await woRow(orgId, id);
  const a = b.assigneeId === undefined ? r.assignee_id : (b.assigneeId ? String(b.assigneeId) : null);
  if (a && !(await S(() => one(`SELECT 1 FROM app_user WHERE id = $1`, [a])))) throw new FieldError(422, 'No such user.');
  const d = b.scheduledFor === undefined ? r.scheduled_s ?? null : (b.scheduledFor ? String(b.scheduledFor) : null);
  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new FieldError(422, 'scheduledFor is YYYY-MM-DD.');
  const t = b.templateId === undefined ? r.template_id : (b.templateId ? Number(b.templateId) : null);
  if (t && !(await S(() => one(`SELECT 1 FROM field_template WHERE id = $1 AND org_id = $2`, [t, orgId])))) throw new FieldError(422, 'No such template.');
  await S(() => query(`UPDATE work_order SET assignee_id = $2, scheduled_for = $3, template_id = $4 WHERE id = $1`, [r.id, a, d, t]));
  return job(orgId, id);
}
