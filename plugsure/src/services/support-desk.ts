import { createHash, randomBytes } from 'node:crypto';
import { many, one, outsideRequestScope, query, tx } from '../db/pool.js';
import { logger } from '../logger.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { sendEmail } from './notify-transports.js';
import { unseal } from './secrets.js';

/**
 * The support case desk (v1.45.0), Operate → Support. One place for what drivers report, whichever way they write:
 *
 *   app        "Laporkan masalah" on a receipt (or the Help page): the case is linked to that charge's session, its
 *              charger and site, and its payment. The driver follows the replies in the app.
 *   email      the operator's e-mail provider forwards what arrives at the support address to the inbound webhook
 *              (…/support/inbound-email/<key>, JSON {from, fromName, subject, text}). A reply to a case's e-mail
 *              (its subject carries [PS-<number>]) is added to that case; anything else opens one. Replies go out
 *              through the operator's e-mail channel (Governance → Alert routing → Channels).
 *   whatsapp   when the WhatsApp assistant hands a conversation to staff, a case is opened for the operator the driver
 *              last charged with; replies go back on WhatsApp (within its 24-hour window).
 *   console    opened by staff (a phone call, a walk-in).
 *
 * Each case has a priority whose times to the first answer and to resolution (SLA) are set per operator; a case past
 * either is marked breached once and raises support.sla_breach. Macros are saved replies ({{name}}, {{number}},
 * {{charger}}, {{site}} are filled in), and may set the status. Internal notes are never sent.
 */

export class SupportError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const SLA_ALERT = 'support.sla_breach';
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const STATUSES = ['new', 'open', 'pending', 'resolved', 'closed'] as const;
export const CATEGORIES = ['charging', 'payment', 'refund', 'account', 'charger_fault', 'other'] as const;
type Priority = typeof PRIORITIES[number];
type Channel = 'app' | 'email' | 'whatsapp' | 'console';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const S = <T>(fn: () => T) => outsideRequestScope(fn);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export const DEFAULT_SLA: Record<Priority, { first: number; resolve: number }> = {
  urgent: { first: 30, resolve: 240 }, high: { first: 60, resolve: 480 }, normal: { first: 240, resolve: 1440 }, low: { first: 1440, resolve: 4320 },
};

// ------------------------------------------------------------------ settings

export async function settings(orgId: string) {
  const r = await S(() => one<any>(`SELECT * FROM support_settings WHERE org_id = $1`, [orgId]));
  return { enabled: r?.enabled ?? false, sla: { ...DEFAULT_SLA, ...(r?.sla ?? {}) } as Record<Priority, { first: number; resolve: number }>, autoAcknowledge: r?.auto_acknowledge ?? true, inboundKeyPrefix: r?.inbound_key_prefix ?? null };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const cur = await settings(orgId);
  const sla = { ...cur.sla };
  if (b.sla && typeof b.sla === 'object') {
    for (const p of PRIORITIES) {
      const v = (b.sla as any)[p];
      if (!v) continue;
      const first = Number(v.first), resolve = Number(v.resolve);
      if (!Number.isInteger(first) || first < 5 || first > 20_160 || !Number.isInteger(resolve) || resolve < first || resolve > 43_200) {
        throw new SupportError(422, `sla.${p}: first is 5 to 20,160 minutes, resolve at least that and at most 43,200.`);
      }
      sla[p] = { first, resolve };
    }
  }
  const enabled = b.enabled === undefined ? cur.enabled : b.enabled === true;
  const ack = b.autoAcknowledge === undefined ? cur.autoAcknowledge : b.autoAcknowledge === true;
  await S(() => query(
    `INSERT INTO support_settings (org_id, enabled, sla, auto_acknowledge, updated_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (org_id) DO UPDATE SET enabled = EXCLUDED.enabled, sla = EXCLUDED.sla, auto_acknowledge = EXCLUDED.auto_acknowledge, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, enabled, JSON.stringify(sla), ack, userId]));
  return settings(orgId);
}

/** A new key for the inbound e-mail webhook; shown once. The old one stops working at once. */
export async function rotateInboundKey(orgId: string, userId: string | null) {
  const key = `sup_${randomBytes(24).toString('base64url')}`;
  await S(() => query(
    `INSERT INTO support_settings (org_id, inbound_key_hash, inbound_key_prefix, updated_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (org_id) DO UPDATE SET inbound_key_hash = EXCLUDED.inbound_key_hash, inbound_key_prefix = EXCLUDED.inbound_key_prefix, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, sha(key), key.slice(0, 8), userId]));
  return { key, prefix: key.slice(0, 8) };
}

/** When the first answer and the resolution are due, from `from`. */
export function dueTimes(priority: Priority, sla: Record<Priority, { first: number; resolve: number }>, from: Date) {
  const s = sla[priority] ?? DEFAULT_SLA[priority];
  return { firstDue: new Date(from.getTime() + s.first * 60_000), resolveDue: new Date(from.getTime() + s.resolve * 60_000) };
}

/** A category's usual priority: a charger fault or a payment is more urgent than a question. */
export function defaultPriority(category: string): Priority {
  return category === 'charger_fault' ? 'high' : category === 'payment' || category === 'refund' ? 'normal' : 'normal';
}

// ------------------------------------------------------------------ cases

export interface NewCase {
  subject: string; body: string; channel: Channel; category?: string; priority?: string; appDriverId?: string | null;
  customerName?: string | null; customerEmail?: string | null; customerPhoneMasked?: string | null;
  sessionId?: string | null; paymentIntentId?: string | null; chargePointId?: string | null; siteId?: string | null; whatsappConversationId?: string | null; createdBy?: string | null;
}

export async function create(orgId: string, n: NewCase) {
  const subject = String(n.subject ?? '').trim().slice(0, 200);
  const body = String(n.body ?? '').trim().slice(0, 10_000);
  if (!subject) throw new SupportError(422, 'subject is required.');
  if (!body) throw new SupportError(422, 'A first message is required.');
  const category = (CATEGORIES as readonly string[]).includes(String(n.category)) ? String(n.category) : 'other';
  const priority = ((PRIORITIES as readonly string[]).includes(String(n.priority)) ? String(n.priority) : defaultPriority(category)) as Priority;
  const email = n.customerEmail ? String(n.customerEmail).trim().toLowerCase().slice(0, 200) : null;
  if (email && !EMAIL_RE.test(email)) throw new SupportError(422, 'customerEmail is not an e-mail address.');
  const s = await settings(orgId);
  // The session decides the charger and site when they were not given.
  let { sessionId = null, chargePointId = null, siteId = null, paymentIntentId = null } = n;
  if (sessionId) {
    if (!UUID_RE.test(sessionId)) throw new SupportError(422, 'No such session.');
    const cs = await S(() => one<any>(`SELECT charge_point_id, site_id, payment_intent_id FROM charging_session WHERE id = $1 AND org_id = $2`, [sessionId, orgId]));
    if (!cs) throw new SupportError(422, 'No such session.');
    chargePointId ??= cs.charge_point_id; siteId ??= cs.site_id; paymentIntentId ??= cs.payment_intent_id ?? null;
  }
  if (chargePointId) {
    if (!UUID_RE.test(chargePointId)) throw new SupportError(422, 'No such charger.');
    const cp = await S(() => one<any>(`SELECT cp.site_id FROM charge_point cp JOIN site s ON s.id = cp.site_id WHERE cp.id = $1 AND s.org_id = $2`, [chargePointId, orgId]));
    if (!cp) throw new SupportError(422, 'No such charger.');
    siteId ??= cp.site_id;
  }
  const now = new Date();
  const due = dueTimes(priority, s.sla, now);
  const row = await S(() => tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('support_case:' || $1))`, [orgId]);
    const num = Number((await c.query(`SELECT COALESCE(max(number), 0) + 1 AS n FROM support_case WHERE org_id = $1`, [orgId])).rows[0].n);
    const r = (await c.query(
      `INSERT INTO support_case (org_id, number, subject, priority, channel, category, app_driver_id, customer_name, customer_email, customer_phone_masked, session_id, payment_intent_id,
                                 charge_point_id, site_id, whatsapp_conversation_id, first_response_due_at, resolve_due_at, last_customer_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [orgId, num, subject, priority, n.channel, category, n.appDriverId ?? null, n.customerName ? String(n.customerName).slice(0, 120) : null, email, n.customerPhoneMasked ?? null,
       sessionId, paymentIntentId, chargePointId, siteId, n.whatsappConversationId ?? null, due.firstDue, due.resolveDue, n.channel === 'console' ? null : now, n.createdBy ?? null])).rows[0];
    await c.query(`INSERT INTO support_message (case_id, org_id, author, channel, body, user_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [r.id, orgId, n.channel === 'console' ? 'staff' : 'customer', n.channel, body, n.channel === 'console' ? n.createdBy ?? null : null]);
    return r;
  }));
  if (s.autoAcknowledge && n.channel === 'email' && email) {
    await deliverEmail(orgId, row, email, `We have your message (case ${ref(row)}). We will answer as soon as we can.`).catch(() => {});
  }
  return caseOf(row);
}

const ref = (r: { number: number }) => `PS-${r.number}`;

const caseOf = (r: any) => ({
  id: String(r.id), number: r.number, ref: ref(r), subject: r.subject, status: r.status, priority: r.priority, channel: r.channel, category: r.category,
  appDriverId: r.app_driver_id ?? null, customerName: r.customer_name ?? null, customerEmail: r.customer_email ?? null, customerPhone: r.customer_phone_masked ?? r.driver_phone_masked ?? null,
  sessionId: r.session_id ?? null, paymentIntentId: r.payment_intent_id ?? null, chargePointId: r.charge_point_id ?? null, siteId: r.site_id ?? null,
  charger: r.charger ?? null, site: r.site ?? null, whatsappConversationId: r.whatsapp_conversation_id ?? null,
  assigneeId: r.assignee_id ?? null, assignee: r.assignee ?? null,
  firstResponseDueAt: r.first_response_due_at ? new Date(r.first_response_due_at).toISOString() : null, resolveDueAt: r.resolve_due_at ? new Date(r.resolve_due_at).toISOString() : null,
  firstRespondedAt: r.first_responded_at ? new Date(r.first_responded_at).toISOString() : null, resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
  breached: !!r.breached_at, satisfaction: r.satisfaction ?? null,
  createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(), lastCustomerAt: r.last_customer_at ? new Date(r.last_customer_at).toISOString() : null,
});

const CASE_SELECT = `SELECT c.*, cp.display_name AS charger, s.name AS site, u.name AS assignee FROM support_case c
  LEFT JOIN charge_point cp ON cp.id = c.charge_point_id LEFT JOIN site s ON s.id = c.site_id LEFT JOIN app_user u ON u.id = c.assignee_id`;

export async function list(orgId: string, q: Record<string, unknown> = {}, userId: string | null = null) {
  const where = ['c.org_id = $1'];
  const p: unknown[] = [orgId];
  const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
  const st = String(q.status ?? 'active');
  if (st === 'active') where.push(`c.status IN ('new', 'open', 'pending')`);
  else if ((STATUSES as readonly string[]).includes(st)) add('c.status = ?', st);
  if ((PRIORITIES as readonly string[]).includes(String(q.priority))) add('c.priority = ?', q.priority);
  if ((CATEGORIES as readonly string[]).includes(String(q.category))) add('c.category = ?', q.category);
  if (q.assignee === 'me' && userId) add('c.assignee_id = ?', userId);
  else if (q.assignee === 'none') where.push('c.assignee_id IS NULL');
  if (q.breached === 'true' || q.breached === true) where.push('c.breached_at IS NOT NULL');
  if (q.q) { p.push(`%${String(q.q).slice(0, 80).replace(/[%_\\]/g, (m) => `\\${m}`)}%`); where.push(`(c.subject ILIKE $${p.length} OR c.customer_email ILIKE $${p.length} OR c.customer_name ILIKE $${p.length} OR ('PS-' || c.number) ILIKE $${p.length})`); }
  const rows = await S(() => many<any>(
    `${CASE_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY (c.status IN ('resolved', 'closed')), CASE c.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
               COALESCE(CASE WHEN c.first_responded_at IS NULL THEN c.first_response_due_at END, c.resolve_due_at), c.id DESC LIMIT 300`, p));
  const counts = await S(() => one<any>(
    `SELECT count(*) FILTER (WHERE status = 'new') AS new, count(*) FILTER (WHERE status IN ('new', 'open', 'pending')) AS active,
            count(*) FILTER (WHERE status IN ('new', 'open', 'pending') AND breached_at IS NOT NULL) AS breached,
            count(*) FILTER (WHERE status IN ('new', 'open', 'pending') AND assignee_id IS NULL) AS unassigned,
            count(*) FILTER (WHERE status IN ('new', 'open', 'pending') AND assignee_id = $2) AS mine
       FROM support_case WHERE org_id = $1`, [orgId, userId]));
  return { cases: rows.map(caseOf), counts: { new: Number(counts.new), active: Number(counts.active), breached: Number(counts.breached), unassigned: Number(counts.unassigned), mine: Number(counts.mine) } };
}

async function caseRow(orgId: string, id: string) {
  const r = await S(() => one<any>(`${CASE_SELECT} WHERE c.id = $1 AND c.org_id = $2`, [Number(id) || 0, orgId]));
  if (!r) throw new SupportError(404, 'No such case.');
  return r;
}

/** A case with its conversation (and the WhatsApp chat since it opened) and what it is about. */
export async function get(orgId: string, id: string) {
  const r = await caseRow(orgId, id);
  const msgs = await S(() => many<any>(`SELECT m.*, u.name AS user_name FROM support_message m LEFT JOIN app_user u ON u.id = m.user_id WHERE m.case_id = $1 ORDER BY m.id`, [r.id]));
  const thread = msgs.map((m) => ({ id: `m${m.id}`, author: m.author, channel: m.channel, body: m.body, internal: m.internal, by: m.user_name ?? null, delivery: m.delivery ?? null, deliveryError: m.delivery_error ?? null, at: new Date(m.created_at).toISOString() }));
  if (r.whatsapp_conversation_id) {
    const wa = await S(() => many<any>(
      `SELECT id, author, body, created_at FROM whatsapp_chat_message WHERE conversation_id = $1 AND created_at >= $2 - interval '1 hour' AND author <> 'system' ORDER BY id`,
      [r.whatsapp_conversation_id, r.created_at]));
    for (const m of wa) thread.push({ id: `w${m.id}`, author: m.author === 'customer' ? 'customer' : 'staff', channel: 'whatsapp', body: m.body, internal: false, by: m.author === 'ai' ? 'WhatsApp assistant' : null, delivery: 'sent', deliveryError: null, at: new Date(m.created_at).toISOString() });
    thread.sort((a, b) => a.at.localeCompare(b.at));
  }
  let session = null;
  if (r.session_id) {
    const s = await S(() => one<any>(
      `SELECT cs.id, cs.started_at, cs.ended_at, cs.energy_wh, cs.state, d.total_minor, d.currency, pi.state AS payment_state, pi.refund_state, pi.amount_captured_minor, pi.refunded_minor
         FROM charging_session cs LEFT JOIN cdr d ON d.session_id = cs.id LEFT JOIN payment_intent pi ON pi.id = cs.payment_intent_id WHERE cs.id = $1`, [r.session_id]));
    if (s) session = { id: s.id, startedAt: s.started_at ? new Date(s.started_at).toISOString() : null, endedAt: s.ended_at ? new Date(s.ended_at).toISOString() : null, kwh: Number(s.energy_wh ?? 0) / 1000, state: s.state,
      totalMinor: s.total_minor == null ? null : Number(s.total_minor), currency: s.currency ?? null, paymentState: s.payment_state ?? null, refundState: s.refund_state ?? null,
      capturedMinor: s.amount_captured_minor == null ? null : Number(s.amount_captured_minor), refundedMinor: s.refunded_minor == null ? null : Number(s.refunded_minor) };
  }
  const others = r.app_driver_id || r.customer_email
    ? await S(() => many<any>(`SELECT id, number, subject, status, created_at FROM support_case WHERE org_id = $1 AND id <> $2 AND ((app_driver_id IS NOT NULL AND app_driver_id = $3) OR (customer_email IS NOT NULL AND customer_email = $4)) ORDER BY id DESC LIMIT 10`,
      [orgId, r.id, r.app_driver_id, r.customer_email]))
    : [];
  return { ...caseOf(r), messages: thread, session, otherCases: others.map((o) => ({ id: String(o.id), ref: ref(o), subject: o.subject, status: o.status, createdAt: new Date(o.created_at).toISOString() })) };
}

/** Status, priority, category, assignee. A new priority moves the due times (from when the case was opened). */
export async function update(orgId: string, id: string, b: Record<string, unknown>) {
  const r = await caseRow(orgId, id);
  const set: string[] = [], p: unknown[] = [r.id];
  const put = (col: string, v: unknown) => { p.push(v); set.push(`${col} = $${p.length}`); };
  if (b.status !== undefined) {
    if (!(STATUSES as readonly string[]).includes(String(b.status)) || b.status === 'new') throw new SupportError(422, 'status is open, pending, resolved or closed.');
    put('status', b.status);
    if (b.status === 'resolved') set.push('resolved_at = COALESCE(resolved_at, now())');
    if (b.status === 'closed') set.push('closed_at = now(), resolved_at = COALESCE(resolved_at, now())');
    if (b.status === 'open' || b.status === 'pending') set.push('resolved_at = NULL, closed_at = NULL');
  }
  if (b.priority !== undefined) {
    if (!(PRIORITIES as readonly string[]).includes(String(b.priority))) throw new SupportError(422, 'priority is low, normal, high or urgent.');
    const due = dueTimes(b.priority as Priority, (await settings(orgId)).sla, new Date(r.created_at));
    put('priority', b.priority); put('first_response_due_at', due.firstDue); put('resolve_due_at', due.resolveDue);
  }
  if (b.category !== undefined) {
    if (!(CATEGORIES as readonly string[]).includes(String(b.category))) throw new SupportError(422, 'No such category.');
    put('category', b.category);
  }
  if (b.assigneeId !== undefined) {
    const a = b.assigneeId ? String(b.assigneeId) : null;
    if (a && !(UUID_RE.test(a) && await S(() => one(`SELECT 1 FROM app_user WHERE id = $1`, [a])))) throw new SupportError(422, 'No such user.');
    put('assignee_id', a);
  }
  if (!set.length) return caseOf(r);
  await S(() => query(`UPDATE support_case SET ${set.join(', ')}, updated_at = now() WHERE id = $1`, p));
  if (b.status === 'resolved' || b.status === 'closed') await S(() => resolveAlertsFor(orgId, SLA_ALERT, 'support_case', String(r.id))).catch(() => 0);
  return caseOf(await caseRow(orgId, id));
}

const fill = (t: string, r: any) => t.replace(/\{\{\s*(name|number|charger|site)\s*\}\}/g, (_m, k) =>
  String(k === 'name' ? (r.customer_name ?? 'there') : k === 'number' ? ref(r) : k === 'charger' ? (r.charger ?? 'the charger') : (r.site ?? 'the site')));

/** A reply (sent on the case's channel) or an internal note. */
export async function reply(orgId: string, id: string, b: Record<string, unknown>, userId: string | null) {
  const r = await caseRow(orgId, id);
  let body = String(b.body ?? '').trim();
  let setStatus: string | null = b.status ? String(b.status) : null;
  if (b.macroId) {
    const m = await S(() => one<any>(`SELECT * FROM support_macro WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`, [Number(b.macroId) || 0, orgId]));
    if (!m) throw new SupportError(422, 'No such macro.');
    body = body || m.body;
    setStatus ??= m.set_status ?? null;
  }
  body = fill(body, r).slice(0, 10_000);
  if (!body) throw new SupportError(422, 'A reply is required.');
  const internal = b.internal === true;
  let delivery: string | null = null, deliveryError: string | null = null;
  if (!internal) {
    if (r.channel === 'email' && r.customer_email) {
      const out = await deliverEmail(orgId, r, r.customer_email, body).catch((e) => ({ ok: false, error: (e as Error).message }));
      delivery = out.ok ? 'sent' : 'failed'; deliveryError = out.ok ? null : out.error ?? 'not sent';
    } else if (r.channel === 'whatsapp' && r.whatsapp_conversation_id) {
      const wa = await import('./whatsapp-support.js');
      const out = await wa.sendStaffReply(r.whatsapp_conversation_id, body, userId).catch((e) => ({ ok: false, error: (e as Error).message }));
      if (out.ok) {
        // Shown from the WhatsApp chat itself (get()); recorded here only when it failed.
        await S(() => query(`UPDATE support_case SET first_responded_at = COALESCE(first_responded_at, now()), status = CASE WHEN status = 'new' THEN 'open' ELSE status END, updated_at = now() WHERE id = $1`, [r.id]));
        if (setStatus) await update(orgId, id, { status: setStatus });
        return get(orgId, id);
      }
      delivery = 'failed'; deliveryError = out.error ?? 'not sent';
    } else if (r.app_driver_id) {
      delivery = 'in_app';
    }
  }
  await S(() => query(`INSERT INTO support_message (case_id, org_id, author, channel, body, internal, user_id, delivery, delivery_error) VALUES ($1,$2,'staff',$3,$4,$5,$6,$7,$8)`,
    [r.id, orgId, internal ? 'console' : r.channel, body, internal, userId, delivery, deliveryError]));
  if (!internal && delivery !== 'failed') {
    await S(() => query(`UPDATE support_case SET first_responded_at = COALESCE(first_responded_at, now()), status = CASE WHEN status = 'new' THEN 'open' ELSE status END, updated_at = now() WHERE id = $1`, [r.id]));
    if (r.app_driver_id && delivery === 'in_app') await notifyDriver(r.app_driver_id, ref(r), String(r.id)).catch(() => {});
  }
  if (setStatus) await update(orgId, id, { status: setStatus });
  return get(orgId, id);
}

async function deliverEmail(orgId: string, r: any, to: string, body: string): Promise<{ ok: boolean; error?: string }> {
  const ch = await S(() => one<{ enabled: boolean; config: any; secret: string | null }>(`SELECT enabled, config, secret FROM notification_channel WHERE org_id = $1 AND kind = 'email' ORDER BY created_at LIMIT 1`, [orgId]));
  if (!ch?.enabled || !ch.config?.host) return { ok: false, error: 'No e-mail channel (Governance → Alert routing → Channels).' };
  let secret: string | null = null;
  try { secret = ch.secret ? unseal(ch.secret) : null; } catch { secret = null; }
  const subject = `[${ref(r)}] ${r.subject}`;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const out = await sendEmail(ch.config, secret, to, { subject, text: `${body}\n\n— ${ref(r)}. Reply to this e-mail to add to the case.`, html: `<p>${esc(body).replace(/\n/g, '<br>')}</p><p style="color:#666">— ${ref(r)}. Reply to this e-mail to add to the case.</p>`, kind: 'support' });
  return out.ok ? { ok: true } : { ok: false, error: out.error ?? 'not sent' };
}

async function notifyDriver(appDriverId: string, caseRef: string, caseId: string) {
  const devices = await S(() => many<{ id: string }>(`SELECT id FROM driver_device WHERE app_driver_id = $1`, [appDriverId]));
  if (!devices.length) return;
  const { notifyDevices } = await import('../driver/notify.js');
  await notifyDevices(devices.map((d) => d.id), 'support_reply', `support:${caseId}:${Date.now()}`, {
    id: { title: 'Balasan dari layanan pelanggan', body: `Laporan ${caseRef} mendapat balasan.` },
    en: { title: 'A reply from support', body: `Your report ${caseRef} has a reply.` },
    url: `/app/#help/${caseId}`, tag: `support-${caseId}`,
  });
}

// ------------------------------------------------------------------ macros

const macroOf = (m: any) => ({ id: String(m.id), name: m.name, body: m.body, category: m.category ?? null, setStatus: m.set_status ?? null });
export async function macros(orgId: string) {
  return (await S(() => many<any>(`SELECT * FROM support_macro WHERE org_id = $1 AND archived_at IS NULL ORDER BY name`, [orgId]))).map(macroOf);
}
export async function saveMacro(orgId: string, id: string | null, b: Record<string, unknown>) {
  if (id && b.archive === true) {
    const r = await S(() => one(`UPDATE support_macro SET archived_at = now() WHERE id = $1 AND org_id = $2 AND archived_at IS NULL RETURNING id`, [Number(id) || 0, orgId]));
    if (!r) throw new SupportError(404, 'No such macro.');
    return { id, archived: true };
  }
  const name = String(b.name ?? '').trim().slice(0, 80), body = String(b.body ?? '').trim().slice(0, 5000);
  if (!name || !body) throw new SupportError(422, 'name and body are required.');
  const category = b.category ? String(b.category) : null;
  if (category && !(CATEGORIES as readonly string[]).includes(category)) throw new SupportError(422, 'No such category.');
  const st = b.setStatus ? String(b.setStatus) : null;
  if (st && !['open', 'pending', 'resolved'].includes(st)) throw new SupportError(422, 'setStatus is open, pending or resolved.');
  const r = id
    ? await S(() => one<any>(`UPDATE support_macro SET name = $3, body = $4, category = $5, set_status = $6 WHERE id = $1 AND org_id = $2 AND archived_at IS NULL RETURNING *`, [Number(id) || 0, orgId, name, body, category, st]))
    : await S(() => one<any>(`INSERT INTO support_macro (org_id, name, body, category, set_status) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [orgId, name, body, category, st]));
  if (!r) throw new SupportError(404, 'No such macro.');
  return macroOf(r);
}

// ------------------------------------------------------------------ inbound

/** The e-mail provider's inbound webhook: a reply to a case, or a new case. */
export async function inboundEmail(key: string, b: Record<string, unknown>) {
  if (!/^sup_[A-Za-z0-9_-]{20,64}$/.test(key)) throw new SupportError(404, 'Unknown key.');
  const st = await S(() => one<{ org_id: string; enabled: boolean }>(`SELECT org_id, enabled FROM support_settings WHERE inbound_key_hash = $1`, [sha(key)]));
  if (!st) throw new SupportError(404, 'Unknown key.');
  if (!st.enabled) throw new SupportError(409, 'The support desk is off.');
  const fromRaw = String(b.from ?? '').trim();
  const from = (/<([^>]+)>/.exec(fromRaw)?.[1] ?? fromRaw).trim().toLowerCase();
  if (!EMAIL_RE.test(from)) throw new SupportError(422, 'from is not an e-mail address.');
  const subject = String(b.subject ?? '').trim().slice(0, 200) || '(no subject)';
  const text = stripQuoted(String(b.text ?? b.body ?? '')).slice(0, 10_000);
  if (!text) throw new SupportError(422, 'text is empty.');
  const m = /\[PS-(\d{1,9})\]/i.exec(subject);
  if (m) {
    const r = await S(() => one<any>(`SELECT * FROM support_case WHERE org_id = $1 AND number = $2 AND customer_email = $3`, [st.org_id, Number(m[1]), from]));
    if (r) {
      await S(() => query(`INSERT INTO support_message (case_id, org_id, author, channel, body) VALUES ($1,$2,'customer','email',$3)`, [r.id, st.org_id, text]));
      await S(() => query(
        `UPDATE support_case SET last_customer_at = now(), updated_at = now(), status = CASE WHEN status IN ('pending', 'resolved', 'closed') THEN 'open' ELSE status END,
                resolved_at = CASE WHEN status IN ('resolved', 'closed') THEN NULL ELSE resolved_at END, closed_at = NULL WHERE id = $1`, [r.id]));
      return { caseId: String(r.id), ref: ref(r), created: false };
    }
  }
  const c = await create(st.org_id, { subject: subject.replace(/^(re|fwd?):\s*/i, ''), body: text, channel: 'email', customerEmail: from, customerName: b.fromName ? String(b.fromName) : null, category: guessCategory(`${subject} ${text}`) });
  return { caseId: c.id, ref: c.ref, created: true };
}

/** The reply above the quoted e-mail ("On … wrote:", "> …"). */
export function stripQuoted(t: string): string {
  const lines = t.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const l of lines) {
    if (/^\s*>/.test(l) || /^On .{4,200} wrote:\s*$/.test(l) || /^Pada .{4,200} menulis:\s*$/.test(l) || /^-{2,}\s*Original Message/i.test(l)) break;
    out.push(l);
  }
  return out.join('\n').trim();
}

/** A first guess at the category from the words (staff can change it). */
export function guessCategory(t: string): string {
  const s = t.toLowerCase();
  if (/refund|pengembalian|kembalikan dana|uang kembali/.test(s)) return 'refund';
  if (/rusak|error|fault|tidak berfungsi|mati|broken|not working|tidak bisa mengisi/.test(s)) return 'charger_fault';
  if (/bayar|payment|qris|tagihan|charged twice|dua kali|potong/.test(s)) return 'payment';
  if (/akun|account|login|masuk|otp|password/.test(s)) return 'account';
  if (/charging|mengisi|sesi|session|kwh/.test(s)) return 'charging';
  return 'other';
}

/** The WhatsApp assistant handed a conversation to staff: a case for the operator the driver last charged with. */
export async function openFromWhatsapp(conversationId: string, reason: string) {
  const conv = await S(() => one<any>(`SELECT id, app_driver_id, phone_masked, profile_name FROM whatsapp_conversation WHERE id = $1`, [conversationId]));
  if (!conv?.app_driver_id) return null;
  const last = await S(() => one<any>(`SELECT org_id, session_id FROM driver_charge WHERE app_driver_id = $1 AND session_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [conv.app_driver_id]));
  if (!last) return null;
  const st = await settings(last.org_id);
  if (!st.enabled) return null;
  const open = await S(() => one(`SELECT id FROM support_case WHERE whatsapp_conversation_id = $1 AND status IN ('new', 'open', 'pending')`, [conversationId]));
  if (open) return null;
  const lastMsg = await S(() => one<any>(`SELECT body FROM whatsapp_chat_message WHERE conversation_id = $1 AND author = 'customer' ORDER BY id DESC LIMIT 1`, [conversationId]));
  try {
    return await create(last.org_id, {
      subject: `WhatsApp: ${String(lastMsg?.body ?? reason).slice(0, 80)}`, body: `Handed over by the WhatsApp assistant: ${reason}`, channel: 'whatsapp',
      category: guessCategory(String(lastMsg?.body ?? '')), appDriverId: conv.app_driver_id, customerName: conv.profile_name ?? null, customerPhoneMasked: conv.phone_masked ?? null,
      sessionId: last.session_id, whatsappConversationId: conversationId,
    });
  } catch (e) {
    logger.warn({ conversationId, err: (e as Error).message }, 'support case from WhatsApp failed');
    return null;
  }
}

// ------------------------------------------------------------------ the driver's side

export async function driverCreate(appDriverId: string, b: Record<string, unknown>) {
  let orgId: string | null = null, sessionId: string | null = null;
  if (b.chargeId) {
    const dc = await S(() => one<any>(`SELECT org_id, session_id FROM driver_charge WHERE id = $1 AND app_driver_id = $2`, [String(b.chargeId), appDriverId]));
    if (!dc) throw new SupportError(404, 'Transaksi tidak ditemukan.');
    orgId = dc.org_id; sessionId = dc.session_id ?? null;
  } else if (b.orgId && UUID_RE.test(String(b.orgId))) {
    orgId = String(b.orgId);
  } else {
    orgId = (await S(() => one<any>(`SELECT org_id FROM driver_charge WHERE app_driver_id = $1 ORDER BY created_at DESC LIMIT 1`, [appDriverId])))?.org_id ?? null;
  }
  if (!orgId) throw new SupportError(422, 'Pilih transaksi yang ingin dilaporkan.');
  if (!(await settings(orgId)).enabled) throw new SupportError(409, 'Operator ini belum menerima laporan lewat aplikasi. Hubungi nomor layanan di struk.');
  const body = String(b.body ?? '').trim();
  if (body.length < 5) throw new SupportError(422, 'Ceritakan masalahnya (minimal 5 karakter).');
  const category = (CATEGORIES as readonly string[]).includes(String(b.category)) ? String(b.category) : guessCategory(body);
  const d = await S(() => one<any>(`SELECT name, phone, email FROM app_driver WHERE id = $1`, [appDriverId]));
  const recent = await S(() => one<{ n: string }>(`SELECT count(*) AS n FROM support_case WHERE app_driver_id = $1 AND created_at > now() - interval '1 hour'`, [appDriverId]));
  if (Number(recent?.n ?? 0) >= 5) throw new SupportError(429, 'Terlalu banyak laporan. Coba lagi nanti.');
  const c = await create(orgId, {
    subject: String(b.subject ?? '').trim().slice(0, 120) || body.split('\n')[0]!.slice(0, 80), body, channel: 'app', category, appDriverId,
    customerName: d?.name ?? null, customerEmail: d?.email && EMAIL_RE.test(d.email) ? d.email : null, customerPhoneMasked: d?.phone ? `${d.phone.slice(0, 4)}…${d.phone.slice(-3)}` : null, sessionId,
  });
  return driverView(c);
}

const driverView = (c: ReturnType<typeof caseOf>) => ({ id: c.id, ref: c.ref, subject: c.subject, status: c.status, category: c.category, createdAt: c.createdAt, updatedAt: c.updatedAt, satisfaction: c.satisfaction });

export async function driverCases(appDriverId: string) {
  const rows = await S(() => many<any>(`SELECT * FROM support_case WHERE app_driver_id = $1 ORDER BY updated_at DESC LIMIT 50`, [appDriverId]));
  return rows.map((r) => driverView(caseOf(r)));
}

export async function driverCase(appDriverId: string, id: string) {
  const r = await S(() => one<any>(`SELECT * FROM support_case WHERE id = $1 AND app_driver_id = $2`, [Number(id) || 0, appDriverId]));
  if (!r) throw new SupportError(404, 'Laporan tidak ditemukan.');
  const msgs = await S(() => many<any>(`SELECT author, body, created_at FROM support_message WHERE case_id = $1 AND NOT internal AND (author = 'customer' OR delivery IN ('in_app', 'sent')) ORDER BY id`, [r.id]));
  return { ...driverView(caseOf(r)), messages: msgs.map((m) => ({ from: m.author === 'customer' ? 'you' : 'support', body: m.body, at: new Date(m.created_at).toISOString() })) };
}

export async function driverReply(appDriverId: string, id: string, b: Record<string, unknown>) {
  const r = await S(() => one<any>(`SELECT * FROM support_case WHERE id = $1 AND app_driver_id = $2`, [Number(id) || 0, appDriverId]));
  if (!r) throw new SupportError(404, 'Laporan tidak ditemukan.');
  if (b.satisfaction !== undefined) {
    const s = Number(b.satisfaction);
    if (!Number.isInteger(s) || s < 1 || s > 5) throw new SupportError(422, 'Nilai 1 sampai 5.');
    if (!['resolved', 'closed'].includes(r.status)) throw new SupportError(409, 'Nilai diberikan setelah laporan selesai.');
    await S(() => query(`UPDATE support_case SET satisfaction = $2, updated_at = now() WHERE id = $1`, [r.id, s]));
    return driverCase(appDriverId, id);
  }
  const body = String(b.body ?? '').trim().slice(0, 5000);
  if (!body) throw new SupportError(422, 'Tulis pesan.');
  await S(() => query(`INSERT INTO support_message (case_id, org_id, author, channel, body) VALUES ($1,$2,'customer','app',$3)`, [r.id, r.org_id, body]));
  await S(() => query(
    `UPDATE support_case SET last_customer_at = now(), updated_at = now(), status = CASE WHEN status IN ('pending', 'resolved', 'closed') THEN 'open' ELSE status END,
            resolved_at = CASE WHEN status IN ('resolved', 'closed') THEN NULL ELSE resolved_at END, closed_at = NULL WHERE id = $1`, [r.id]));
  return driverCase(appDriverId, id);
}

// ------------------------------------------------------------------ SLA and stats

/** Worker: mark cases past their first-answer or resolution time, once, with an alert. */
export async function slaSweep(now = new Date()): Promise<number> {
  const rows = await S(() => many<any>(
    `UPDATE support_case SET breached_at = $1
      WHERE breached_at IS NULL AND status IN ('new', 'open', 'pending')
        AND ((first_responded_at IS NULL AND first_response_due_at < $1) OR resolve_due_at < $1)
      RETURNING id, org_id, number, subject, priority, first_responded_at`, [now]));
  for (const r of rows) {
    await S(() => persistAlert({ orgId: r.org_id, kind: SLA_ALERT, severity: r.priority === 'urgent' || r.priority === 'high' ? 'critical' : 'warning', targetType: 'support_case', targetId: String(r.id),
      message: `Case PS-${r.number} (${r.priority}) is past its ${r.first_responded_at ? 'resolution' : 'first-answer'} time: ${r.subject}` } as any)).catch(() => null);
  }
  return rows.length;
}

/** The last `days`: opened, resolved, breached, the median first answer and resolution, satisfaction, by channel and category. */
export async function stats(orgId: string, days = 30) {
  const d = Math.min(365, Math.max(1, Math.round(days)));
  const r = await S(() => one<any>(
    `SELECT count(*) AS opened, count(*) FILTER (WHERE resolved_at IS NOT NULL) AS resolved, count(*) FILTER (WHERE breached_at IS NOT NULL) AS breached,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_responded_at - created_at) / 60) FILTER (WHERE first_responded_at IS NOT NULL) AS first_min,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM resolved_at - created_at) / 60) FILTER (WHERE resolved_at IS NOT NULL) AS resolve_min,
            avg(satisfaction) AS csat, count(satisfaction) AS rated
       FROM support_case WHERE org_id = $1 AND created_at > now() - make_interval(days => $2)`, [orgId, d]));
  const by = async (col: string) => (await S(() => many<any>(`SELECT ${col} AS k, count(*) AS n FROM support_case WHERE org_id = $1 AND created_at > now() - make_interval(days => $2) GROUP BY 1 ORDER BY 2 DESC`, [orgId, d])))
    .map((x) => ({ key: x.k, count: Number(x.n) }));
  const opened = Number(r.opened);
  return {
    days: d, opened, resolved: Number(r.resolved), breached: Number(r.breached), breachedPct: opened ? Math.round((Number(r.breached) / opened) * 1000) / 10 : null,
    medianFirstAnswerMinutes: r.first_min == null ? null : Math.round(Number(r.first_min)), medianResolutionMinutes: r.resolve_min == null ? null : Math.round(Number(r.resolve_min)),
    satisfaction: r.csat == null ? null : Math.round(Number(r.csat) * 10) / 10, rated: Number(r.rated),
    byChannel: await by('channel'), byCategory: await by('category'),
  };
}
