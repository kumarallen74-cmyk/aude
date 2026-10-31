import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { unseal } from './secrets.js';
import { sendEmail, sendWhatsApp } from './notify-transports.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { settings } from './budgets.js';
import { gate, ApprovalError } from './finance-approvals.js';

/**
 * Collections and dunning (v1.20.0). What customers owe, by age:
 *
 *   an operator   its fleet invoices issued and not paid (what is left after credit notes), by due date
 *   the platform  operators' statements to PlugSure not paid in full, due 14 days after finalisation
 *
 * Aging buckets by days past due: current (not due yet), 1–30, 31–60, 61–90, over 90. Each receivable carries notes
 * and promises to pay, the reminders sent, and a write-off (a second person approves; an approved write-off takes it
 * out of collections; the invoice or statement itself is not changed, the accountant books the bad debt).
 *
 * Reminders (operators' fleet invoices): with dunning on (Finance → Collections → Settings), the worker sends one
 * reminder per step (days relative to the due date: -3 is three days before) by e-mail to the fleet account's billing
 * address and, when a WhatsApp template for reminders is set, by WhatsApp to its phone. Only the latest step reached is
 * sent (a newly enabled schedule does not send every past step at once); each step once per channel. A promise to pay
 * in the future pauses the reminders until that date. Anyone with payment:write can also send one now.
 */

export class CollectionsError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export type Kind = 'fleet_invoice' | 'platform_statement';
const KINDS: Kind[] = ['fleet_invoice', 'platform_statement'];
const PLATFORM_TERMS_DAYS = 14;
const DAY = 86_400_000;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);
const ymd = (d: Date | string | null) => (d ? (typeof d === 'string' ? d.slice(0, 10) : new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(d)) : null);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
export const bucketOf = (daysPastDue: number) => (daysPastDue <= 0 ? 'current' : daysPastDue <= 30 ? '1-30' : daysPastDue <= 60 ? '31-60' : daysPastDue <= 90 ? '61-90' : '90+');
const BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'] as const;

export interface Receivable {
  kind: Kind; ref: string; number: string; counterparty: string; email: string | null; phone: string | null; currency: string;
  total: number; outstanding: number; dueDate: string; daysPastDue: number; bucket: string;
}

/** What is owed to the caller: fleet invoices (operator), or operators' statements (platform administrators). */
async function receivables(orgId: string, platformAdmin: boolean, now = new Date()): Promise<Receivable[]> {
  const t = today(now);
  const out: Receivable[] = [];
  const inv = await outsideRequestScope(() => many<any>(
    `SELECT f.id, f.number, f.total_minor, f.credited_minor, f.prior_credit_minor, f.currency, f.due_date, a.name, a.billing_email, a.phone
       FROM fleet_invoice f JOIN fleet_account a ON a.id = f.fleet_account_id WHERE f.org_id = $1 AND f.status = 'issued'`, [orgId]));
  for (const f of inv) {
    const left = Math.max(0, Number(f.total_minor) - Number(f.credited_minor ?? 0) - Number(f.prior_credit_minor ?? 0));
    if (!left) continue;
    const due = ymd(f.due_date) ?? t;
    const d = daysBetween(due, t);
    out.push({ kind: 'fleet_invoice', ref: f.id, number: f.number, counterparty: f.name, email: f.billing_email ?? null, phone: f.phone ?? null, currency: f.currency,
      total: Number(f.total_minor), outstanding: left, dueDate: due, daysPastDue: d, bucket: bucketOf(d) });
  }
  if (platformAdmin) {
    const st = await outsideRequestScope(() => many<any>(
      `SELECT s.id, s.number, s.total_minor, s.currency, s.finalised_at, o.name, o.billing_email,
              COALESCE((SELECT sum(amount_minor) FROM statement_payment p WHERE p.statement_id = s.id AND p.voided_at IS NULL), 0)::bigint AS paid
         FROM commission_statement s JOIN organisation o ON o.id = s.org_id WHERE s.owner_id IS NULL AND s.finalised_at IS NOT NULL AND s.total_minor > 0`));
    for (const s of st) {
      const left = Number(s.total_minor) - Number(s.paid);
      if (left <= 0) continue;
      const due = ymd(new Date(new Date(s.finalised_at).getTime() + PLATFORM_TERMS_DAYS * DAY))!;
      const d = daysBetween(due, t);
      out.push({ kind: 'platform_statement', ref: s.id, number: s.number, counterparty: s.name, email: s.billing_email ?? null, phone: null, currency: s.currency,
        total: Number(s.total_minor), outstanding: left, dueDate: due, daysPastDue: d, bucket: bucketOf(d) });
    }
  }
  return out;
}

/** The receivables with their notes, promises, reminders and write-offs; aging totals per currency. */
export async function list(orgId: string, platformAdmin: boolean, now = new Date()) {
  const rs = await receivables(orgId, platformAdmin, now);
  const refs = rs.map((r) => r.ref);
  const [notes, rem, wo, st] = await Promise.all([
    refs.length ? outsideRequestScope(() => many<any>(`SELECT DISTINCT ON (kind, ref) kind, ref, note, promise_date, created_at FROM receivable_note WHERE ref = ANY($1::text[]) ORDER BY kind, ref, created_at DESC`, [refs])) : [],
    refs.length ? outsideRequestScope(() => many<any>(`SELECT DISTINCT ON (kind, ref) kind, ref, channel, ok, sent_at, step FROM dunning_reminder WHERE ref = ANY($1::text[]) ORDER BY kind, ref, sent_at DESC`, [refs])) : [],
    refs.length ? outsideRequestScope(() => many<any>(`SELECT * FROM receivable_write_off WHERE ref = ANY($1::text[]) AND state IN ('pending', 'approved')`, [refs])) : [],
    settings(orgId),
  ]);
  const key = (x: { kind: string; ref: string }) => `${x.kind}:${x.ref}`;
  const nBy = new Map(notes.map((n: any) => [key(n), n])), rBy = new Map(rem.map((r: any) => [key(r), r])), wBy = new Map(wo.map((w: any) => [key(w), w]));
  const rows = rs.map((r) => {
    const n = nBy.get(key(r)), last = rBy.get(key(r)), w = wBy.get(key(r));
    return {
      ...r,
      lastNote: n ? { note: n.note, promiseDate: ymd(n.promise_date), at: new Date(n.created_at).toISOString() } : null,
      lastReminder: last ? { channel: last.channel, ok: last.ok, step: last.step, at: new Date(last.sent_at).toISOString() } : null,
      writeOff: w ? { id: String(w.id), state: w.state, amount: Number(w.amount_minor), reason: w.reason, requestedBy: w.requested_by } : null,
    };
  });
  const open = rows.filter((r) => r.writeOff?.state !== 'approved');
  const aging: Record<string, Record<string, number>> = {};
  for (const r of open) {
    aging[r.currency] ??= Object.fromEntries(BUCKETS.map((b) => [b, 0]));
    aging[r.currency]![r.bucket]! += r.outstanding;
  }
  return {
    receivables: open.sort((a, b) => b.daysPastDue - a.daysPastDue),
    writtenOff: rows.filter((r) => r.writeOff?.state === 'approved'),
    aging, buckets: BUCKETS, dunning: st.dunning,
  };
}

async function findOne(orgId: string, platformAdmin: boolean, kind: string, ref: string): Promise<Receivable> {
  if (!KINDS.includes(kind as Kind)) throw new CollectionsError(404, 'No such receivable.');
  if (kind === 'platform_statement' && !platformAdmin) throw new CollectionsError(404, 'No such receivable.');
  const r = (await receivables(orgId, platformAdmin)).find((x) => x.kind === kind && x.ref === ref);
  if (!r) throw new CollectionsError(404, 'No such receivable, or nothing is owed on it.');
  return r;
}

/** The whole history of one receivable: notes, reminders, write-offs. */
export async function history(orgId: string, platformAdmin: boolean, kind: string, ref: string) {
  const r = await findOne(orgId, platformAdmin, kind, ref);
  const [notes, rems, wos] = await outsideRequestScope(() => Promise.all([
    many<any>(`SELECT n.*, u.name AS by_name FROM receivable_note n LEFT JOIN app_user u ON u.id = n.created_by WHERE n.kind = $1 AND n.ref = $2 ORDER BY n.created_at DESC`, [kind, ref]),
    many<any>(`SELECT d.*, u.name AS by_name FROM dunning_reminder d LEFT JOIN app_user u ON u.id = d.sent_by WHERE d.kind = $1 AND d.ref = $2 ORDER BY d.sent_at DESC`, [kind, ref]),
    many<any>(`SELECT w.*, a.name AS requested_by_name, b.name AS decided_by_name FROM receivable_write_off w LEFT JOIN app_user a ON a.id = w.requested_by LEFT JOIN app_user b ON b.id = w.decided_by
                WHERE w.kind = $1 AND w.ref = $2 ORDER BY w.requested_at DESC`, [kind, ref]),
  ]));
  return {
    receivable: r,
    notes: notes.map((n) => ({ id: String(n.id), note: n.note, promiseDate: ymd(n.promise_date), by: n.by_name ?? null, at: new Date(n.created_at).toISOString() })),
    reminders: rems.map((d) => ({ id: String(d.id), step: d.step, channel: d.channel, destination: d.destination, ok: d.ok, error: d.error, manual: d.manual, by: d.by_name ?? null, at: new Date(d.sent_at).toISOString() })),
    writeOffs: wos.map((w) => ({ id: String(w.id), amount: Number(w.amount_minor), currency: w.currency, reason: w.reason, state: w.state, requestedBy: w.requested_by_name ?? null, requestedAt: new Date(w.requested_at).toISOString(),
      decidedBy: w.decided_by_name ?? null, decidedAt: w.decided_at ? new Date(w.decided_at).toISOString() : null, decisionNote: w.decision_note })),
  };
}

export async function addNote(orgId: string, platformAdmin: boolean, kind: string, ref: string, b: Record<string, unknown>, userId: string | null) {
  await findOne(orgId, platformAdmin, kind, ref);
  const note = String(b.note ?? '').trim();
  if (!note || note.length > 500) throw new CollectionsError(422, 'The note is 1 to 500 characters.');
  const promise = b.promiseDate == null || b.promiseDate === '' ? null : String(b.promiseDate);
  if (promise && !/^\d{4}-\d{2}-\d{2}$/.test(promise)) throw new CollectionsError(422, 'The promise-to-pay date is YYYY-MM-DD.');
  const r = await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO receivable_note (org_id, kind, ref, note, promise_date, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [orgId, kind, ref, note, promise, userId]));
  return { id: String(r!.id) };
}

// ─────────────────────────────────────────── reminders

const money = (n: number, cur: string) => `${cur} ${new Intl.NumberFormat('en-GB').format(n)}`;

async function channels(orgId: string) {
  const rows = await outsideRequestScope(() => many<{ kind: string; enabled: boolean; config: any; secret: string | null }>(
    `SELECT kind, enabled, config, secret FROM notification_channel WHERE org_id = $1 AND kind IN ('email', 'whatsapp')`, [orgId]));
  const open = (k: string) => {
    const c = rows.find((r) => r.kind === k && r.enabled);
    if (!c) return null;
    let secret: string | null = null;
    try { secret = c.secret ? unseal(c.secret) : null; } catch { secret = null; }
    return { config: c.config, secret };
  };
  return { email: open('email'), whatsapp: open('whatsapp') };
}

/** Send one reminder for a receivable on a channel; records it. `to` overrides the address on file (manual sends). */
async function remind(orgId: string, r: Receivable, channel: 'email' | 'whatsapp', step: number, manual: boolean, userId: string | null, to?: string) {
  const org = await outsideRequestScope(() => one<{ name: string }>(`SELECT name FROM organisation WHERE id = $1`, [orgId]));
  const ch = await channels(orgId);
  const st = await settings(orgId);
  const overdue = r.daysPastDue > 0;
  let ok = false, error: string | null = null, dest: string | null = null;
  if (channel === 'email') {
    dest = (to ?? r.email ?? '').trim() || null;
    if (!ch.email?.config?.host) error = 'No e-mail channel (Govern → Alert routing → Channels).';
    else if (!dest || !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(dest)) error = 'No billing e-mail address.';
    else {
      const what = r.kind === 'fleet_invoice' ? `invoice ${r.number}` : `statement ${r.number}`;
      const text = `Dear ${r.counterparty},\n\n${overdue ? `Our records show ${what} is ${r.daysPastDue} day${r.daysPastDue === 1 ? '' : 's'} past its due date (${r.dueDate})` : `A reminder that ${what} is due on ${r.dueDate}`}: ${money(r.outstanding, r.currency)} is outstanding.\n\n` +
        `If you have already paid, thank you, and please reply with the transfer's reference so we can match it.\n\n${org?.name ?? ''}`;
      const html = text.split('\n\n').map((p) => `<p>${p.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)).replace(/\n/g, '<br>')}</p>`).join('');
      const res = await sendEmail(ch.email.config, ch.email.secret, dest, { subject: `${overdue ? 'Overdue' : 'Payment reminder'}: ${what} — ${money(r.outstanding, r.currency)}`, text, html, kind: 'dunning' });
      ok = res.ok; error = res.ok ? null : res.error ?? 'failed';
    }
  } else {
    dest = (to ?? r.phone ?? '').replace(/\D/g, '') || null;
    if (!ch.whatsapp?.config?.phoneNumberId) error = 'No WhatsApp channel.';
    else if (!st.dunning.whatsappTemplate) error = 'No WhatsApp template for reminders (Collections → Settings).';
    else if (!dest || dest.length < 8) error = 'No phone number.';
    else {
      // The reminder template's three parameters: the customer, the document and amount, the due date.
      const res = await sendWhatsApp({ ...ch.whatsapp.config, templateName: st.dunning.whatsappTemplate.name, templateLang: st.dunning.whatsappTemplate.lang }, ch.whatsapp.secret, dest,
        [r.counterparty.slice(0, 60), `${r.number} · ${money(r.outstanding, r.currency)}`.slice(0, 100), r.dueDate]);
      ok = res.ok; error = res.ok ? null : res.error ?? 'failed';
    }
  }
  await outsideRequestScope(() => query(
    `INSERT INTO dunning_reminder (org_id, kind, ref, step, channel, destination, ok, error, manual, sent_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (kind, ref, step, channel) WHERE NOT manual DO NOTHING`,
    [orgId, r.kind, r.ref, step, channel, dest, ok, error?.slice(0, 300) ?? null, manual, userId]));
  return { ok, error, destination: dest };
}

export async function remindNow(orgId: string, platformAdmin: boolean, kind: string, ref: string, b: Record<string, unknown>, userId: string | null) {
  const r = await findOne(orgId, platformAdmin, kind, ref);
  const channel = b.channel === 'whatsapp' ? 'whatsapp' : 'email';
  const to = b.to == null || b.to === '' ? undefined : String(b.to).slice(0, 200);
  if (kind === 'platform_statement' && channel === 'email' && !to && !r.email) throw new CollectionsError(422, 'Enter the operator\'s billing e-mail address.');
  const res = await remind(orgId, r, channel, r.daysPastDue, true, userId, to);
  if (!res.ok) throw new CollectionsError(502, `The reminder was not sent: ${res.error}`);
  return res;
}

export async function saveDunning(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const cur = (await settings(orgId)).dunning;
  const enabled = b.enabled === undefined ? cur.enabled : b.enabled === true;
  let steps = cur.steps;
  if (b.steps !== undefined) {
    const raw = Array.isArray(b.steps) ? b.steps : String(b.steps).split(/[,\s]+/).filter(Boolean);
    steps = [...new Set(raw.map(Number))].sort((x, y) => x - y);
    if (!steps.length || steps.length > 8 || steps.some((s) => !Number.isInteger(s) || s < -30 || s > 365)) throw new CollectionsError(422, 'Steps are 1 to 8 whole numbers of days from the due date, -30 to 365 (e.g. -3, 7, 14, 30).');
  }
  let chans = cur.channels;
  if (b.channels !== undefined) {
    chans = (Array.isArray(b.channels) ? b.channels : [b.channels]).map(String).filter((c) => c === 'email' || c === 'whatsapp');
    if (!chans.length) throw new CollectionsError(422, 'Choose e-mail, WhatsApp or both.');
  }
  let wa = cur.whatsappTemplate;
  if (b.whatsappTemplate !== undefined) {
    const t = b.whatsappTemplate as any;
    if (t == null || !t.name) wa = null;
    else {
      if (!/^[a-z0-9_]{1,512}$/.test(String(t.name))) throw new CollectionsError(422, 'The WhatsApp template name is its lowercase name in Meta (letters, digits, _).');
      if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(String(t.lang ?? ''))) throw new CollectionsError(422, 'The template language is a code like id or en_US.');
      wa = { name: String(t.name), lang: String(t.lang) };
    }
  }
  if (chans.includes('whatsapp') && !wa) throw new CollectionsError(422, 'Name the approved WhatsApp template for reminders (three parameters: customer, document and amount, due date).');
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, dunning_enabled, dunning_steps, dunning_channels, wa_template_name, wa_template_lang, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (org_id) DO UPDATE SET dunning_enabled = EXCLUDED.dunning_enabled, dunning_steps = EXCLUDED.dunning_steps, dunning_channels = EXCLUDED.dunning_channels,
       wa_template_name = EXCLUDED.wa_template_name, wa_template_lang = EXCLUDED.wa_template_lang, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, enabled, steps, chans, wa?.name ?? null, wa?.lang ?? null, userId]));
  return (await settings(orgId)).dunning;
}

/** The worker: for each organisation with dunning on, the latest step reached for each fleet invoice, once per channel. */
export async function sweepDunning(now = new Date()): Promise<number> {
  const orgs = await outsideRequestScope(() => many<{ org_id: string }>(`SELECT org_id FROM finance_org_settings WHERE dunning_enabled`));
  let sent = 0;
  for (const { org_id: orgId } of orgs) {
    try {
      const st = (await settings(orgId)).dunning;
      const l = await list(orgId, false, now);
      for (const r of l.receivables.filter((x) => x.kind === 'fleet_invoice' && !x.writeOff)) {
        if (r.lastNote?.promiseDate && r.lastNote.promiseDate >= today(now)) continue;
        const reached = st.steps.filter((s) => r.daysPastDue >= s);
        if (!reached.length) continue;
        const step = Math.max(...reached);
        for (const channel of st.channels as Array<'email' | 'whatsapp'>) {
          const done = await outsideRequestScope(() => one(`SELECT 1 FROM dunning_reminder WHERE kind = $1 AND ref = $2 AND channel = $3 AND step >= $4 AND NOT manual`, [r.kind, r.ref, channel, step]));
          if (done) continue;
          const res = await remind(orgId, r, channel, step, false, null);
          if (res.ok) sent++;
        }
      }
    } catch (e) {
      logger.warn({ org: orgId, err: (e as Error).message }, 'dunning sweep failed');
    }
  }
  return sent;
}

// ─────────────────────────────────────────── write-offs

export const WRITE_OFF_ALERT = 'finance.write_off_awaiting_approval';

export async function requestWriteOff(orgId: string, platformAdmin: boolean, kind: string, ref: string, b: Record<string, unknown>, userId: string | null) {
  const r = await findOne(orgId, platformAdmin, kind, ref);
  const reason = String(b.reason ?? '').trim();
  if (!reason || reason.length > 300) throw new CollectionsError(422, 'Say why it is written off (up to 300 characters).');
  const amount = b.amount == null || b.amount === '' ? r.outstanding : Number(b.amount);
  if (!Number.isInteger(amount) || amount <= 0 || amount > r.outstanding) throw new CollectionsError(422, `The amount is 1 to the ${money(r.outstanding, r.currency)} outstanding.`);
  let id: string;
  try {
    id = String((await outsideRequestScope(() => one<{ id: string }>(
      `INSERT INTO receivable_write_off (org_id, kind, ref, amount_minor, currency, reason, requested_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [orgId, kind, ref, amount, r.currency, reason, userId])))!.id);
  } catch (e) {
    if ((e as any).code === '23505') throw new CollectionsError(409, 'A write-off of this is already waiting or approved.');
    throw e;
  }
  await outsideRequestScope(() => persistAlert({ orgId, kind: WRITE_OFF_ALERT, severity: 'warning', targetType: 'receivable_write_off', targetId: id,
    message: `A write-off of ${money(amount, r.currency)} on ${r.number} (${r.counterparty}) is waiting for approval by someone other than the requester: Finance → Collections.` }))
    .catch((e: unknown) => logger.warn({ err: (e as Error).message }, 'write-off alert failed'));
  return { id, amount };
}

export async function decideWriteOff(orgId: string, id: string, approve: boolean, noteRaw: unknown, userId: string | null, canApprove = false) {
  if (!/^\d{1,18}$/.test(id)) throw new CollectionsError(404, 'No such write-off.');
  const note = noteRaw == null ? null : String(noteRaw).trim().slice(0, 300) || null;
  if (!approve && !note) throw new CollectionsError(422, 'Say why the write-off is rejected.');
  const w = await outsideRequestScope(() => one<any>(`SELECT * FROM receivable_write_off WHERE id = $1 AND org_id = $2 AND state = 'pending'`, [id, orgId]));
  if (!w) throw new CollectionsError(404, 'No pending write-off.');
  if (w.requested_by && userId && w.requested_by === userId) throw new CollectionsError(403, 'The person who asked for a write-off cannot approve it.');
  if (approve) {
    // (v1.21.0) The approvals matrix.
    try {
      if (await gate('write_off', orgId, { id: w.id, amount: Number(w.amount_minor), requested_by: w.requested_by, first_approved_by: w.first_approved_by }, { userId, canApprove }) === 'first') {
        return { ok: true, state: 'pending' as const, firstApproval: true, kind: w.kind as Kind, ref: w.ref as string, amount: Number(w.amount_minor) };
      }
    } catch (e) {
      if (e instanceof ApprovalError) throw new CollectionsError(e.statusCode, e.message);
      throw e;
    }
  }
  const r = await outsideRequestScope(() => one(
    `UPDATE receivable_write_off SET state = $3, decided_by = $4, decided_at = now(), decision_note = $5 WHERE id = $1 AND org_id = $2 AND state = 'pending' RETURNING id`,
    [id, orgId, approve ? 'approved' : 'rejected', userId, note]));
  if (!r) throw new CollectionsError(409, 'Someone else decided it first.');
  await outsideRequestScope(() => resolveAlertsFor(orgId, WRITE_OFF_ALERT, 'receivable_write_off', id)).catch(() => 0);
  return { ok: true, state: approve ? 'approved' as const : 'rejected' as const, firstApproval: false, kind: w.kind as Kind, ref: w.ref as string, amount: Number(w.amount_minor) };
}

export async function pendingWriteOffs(orgId: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT w.*, u.name AS requested_by_name FROM receivable_write_off w LEFT JOIN app_user u ON u.id = w.requested_by WHERE w.org_id = $1 AND w.state = 'pending' ORDER BY w.requested_at`, [orgId]));
  return rows.map((w) => ({ id: String(w.id), kind: w.kind, ref: w.ref, amount: Number(w.amount_minor), currency: w.currency, reason: w.reason, requestedBy: w.requested_by_name ?? null, requestedById: w.requested_by, requestedAt: new Date(w.requested_at).toISOString(), firstApprovedBy: w.first_approved_by ?? null }));
}

