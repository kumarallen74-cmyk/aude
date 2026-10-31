import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { xlsx } from './xlsx.js';

/**
 * Finance audit trail and controls (v1.25.0).
 *
 *   change log     every finance action in the audit log (finance, billing, refunds, fleet invoices and credit
 *                  notes, fleet credit, site owners), filterable by date, person, action and target, with what was
 *                  recorded before and after; CSV
 *   controls       segregation-of-duties checks over the money records themselves, each a list of findings:
 *     bank_change_then_payout    the person who approved an owner's new bank details later paid that owner
 *                                 (recorded a payout or approved a payout transfer) within 90 days
 *     payment_self_matched       the person who recorded a statement payment also matched it to the bank line by hand
 *     refund_decided_and_paid    the person who approved a driver's refund request also recorded the refund paid by hand
 *     period_reopened_by_locker  a month reopened by the person who locked it
 *     approvers_concentration    fewer than the minimum of active people hold finance:approve (default 2)
 *     after_hours_payments       payments and transfers recorded outside working hours (settings; off by default)
 *     write_off_without_note     a write-off approved with no collection note on the receivable before it
 *   report         the month's checks, the change log and the counts per person and action as one workbook
 *
 * Findings are information for the reviewer: nothing is blocked (the approvals matrix and two-person transfers are
 * the preventive controls). A finding can be acknowledged with a note, which is audited by the route.
 */

export class ControlsError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const zone = () => config.billing.timeZone;
const localDay = (t: Date | number = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(new Date(t));
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** The audit actions that are finance's. */
export const FINANCE_PREFIXES = ['finance.', 'billing.', 'refund.', 'fleet_invoice.', 'fleet_credit_note.', 'fleet_credit.', 'fleet_account.credit', 'site_owner.', 'owner.', 'controls.'];

// ─────────────────────────────────────────── change log

export interface LogFilter { from?: unknown; to?: unknown; actor?: unknown; action?: unknown; target?: unknown; limit?: unknown }

function range(f: LogFilter) {
  const to = typeof f.to === 'string' && DAY_RE.test(f.to) ? f.to : localDay();
  const from = typeof f.from === 'string' && DAY_RE.test(f.from) ? f.from : localDay(Date.parse(`${to}T12:00:00Z`) - 30 * 86_400_000);
  if (from > to) throw new ControlsError(422, 'from is after to.');
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 400 * 86_400_000) throw new ControlsError(422, 'At most 400 days at a time.');
  return { from, to };
}

export async function changeLog(orgId: string, f: LogFilter = {}) {
  const { from, to } = range(f);
  const limit = Math.min(5000, Math.max(1, Number(f.limit ?? 1000) || 1000));
  const actor = typeof f.actor === 'string' && /^[0-9a-f-]{36}$/i.test(f.actor) ? f.actor : null;
  const action = typeof f.action === 'string' && /^[a-z_.]{1,80}$/.test(f.action) ? f.action : null;
  const target = typeof f.target === 'string' && f.target.trim() ? f.target.trim().slice(0, 100) : null;
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT a.id, a.ts, a.actor_type, a.actor_id, u.name AS actor_name, u.email AS actor_email, a.action, a.target_type, a.target_id, a.before_state, a.after_state, a.ip, a.seq
       FROM audit_log a LEFT JOIN app_user u ON a.actor_type = 'user' AND u.id::text = a.actor_id
      WHERE a.org_id = $1 AND (a.ts AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
        AND EXISTS (SELECT 1 FROM unnest($5::text[]) p WHERE a.action LIKE p || '%')
        AND ($6::text IS NULL OR a.actor_id = $6) AND ($7::text IS NULL OR a.action LIKE $7 || '%') AND ($8::text IS NULL OR a.target_id = $8 OR a.target_type = $8)
      ORDER BY a.ts DESC, a.id DESC LIMIT $9`, [orgId, from, to, zone(), FINANCE_PREFIXES, actor, action, target, limit]));
  const entries = rows.map((r) => ({
    id: String(r.id), at: iso(r.ts), actor: { type: r.actor_type, id: r.actor_id, name: r.actor_name ?? null, email: r.actor_email ?? null },
    action: r.action, targetType: r.target_type, targetId: r.target_id, before: r.before_state ?? null, after: r.after_state ?? null, ip: r.ip ?? null,
  }));
  return { from, to, entries, truncated: rows.length === limit };
}

const cell = (v: unknown) => { let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };

export function changeLogCsv(l: Awaited<ReturnType<typeof changeLog>>): string {
  const rows: unknown[][] = [['at', 'actor_type', 'actor', 'actor_email', 'action', 'target_type', 'target_id', 'before', 'after', 'ip']];
  for (const e of l.entries) rows.push([e.at, e.actor.type, e.actor.name ?? e.actor.id, e.actor.email, e.action, e.targetType, e.targetId, e.before, e.after, e.ip]);
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// ─────────────────────────────────────────── settings

export interface ControlSettings { minApprovers: number; workingHours: { from: number; to: number } | null }

export async function settings(orgId: string): Promise<ControlSettings> {
  const r = await outsideRequestScope(() => one<{ finance_controls: any }>(`SELECT finance_controls FROM finance_org_settings WHERE org_id = $1`, [orgId]));
  const v = r?.finance_controls ?? {};
  const wh = v.workingHours && Number.isInteger(v.workingHours.from) && Number.isInteger(v.workingHours.to) ? { from: v.workingHours.from, to: v.workingHours.to } : null;
  return { minApprovers: Number(v.minApprovers ?? 2), workingHours: wh };
}

export async function saveSettings(orgId: string, b: Record<string, unknown>, userId: string | null): Promise<ControlSettings> {
  const cur = await settings(orgId);
  const minApprovers = b.minApprovers === undefined || b.minApprovers === '' ? cur.minApprovers : Number(b.minApprovers);
  if (!Number.isInteger(minApprovers) || minApprovers < 1 || minApprovers > 10) throw new ControlsError(422, 'The minimum of approvers is 1 to 10.');
  let workingHours = cur.workingHours;
  if (b.workingHours !== undefined) {
    const w = b.workingHours as any;
    if (w == null || w === '' || w === false) workingHours = null;
    else {
      const from = Number(w.from), to = Number(w.to);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > 23 || to < 1 || to > 24 || from >= to) throw new ControlsError(422, 'Working hours are whole hours, from 0–23 to 1–24 (e.g. 8 to 18).');
      workingHours = { from, to };
    }
  }
  const v = { minApprovers, workingHours };
  await outsideRequestScope(() => query(
    `INSERT INTO finance_org_settings (org_id, finance_controls, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET finance_controls = finance_org_settings.finance_controls || EXCLUDED.finance_controls, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, JSON.stringify(v), userId]));
  return v;
}

// ─────────────────────────────────────────── controls

export interface Finding { control: string; key: string; at: string | null; who: string | null; detail: string; ref: string | null; acknowledged: { by: string | null; at: string | null; note: string } | null }

export const CONTROLS: Array<{ id: string; title: string; why: string }> = [
  { id: 'bank_change_then_payout', title: 'Bank details approved, then paid by the same person', why: 'Whoever approves an owner\'s new bank account should not also pay that owner: together they could redirect a payout.' },
  { id: 'payment_self_matched', title: 'Payment recorded and matched by the same person', why: 'A payment recorded by hand is evidenced by its bank line: someone else should match it.' },
  { id: 'refund_decided_and_paid', title: 'Refund approved and paid by the same person', why: 'Approving a driver\'s refund and recording it paid by hand are two steps for two people.' },
  { id: 'period_reopened_by_locker', title: 'Month reopened by the person who locked it', why: 'A closed month is reopened by someone other than who closed it, so the change is seen twice.' },
  { id: 'approvers_concentration', title: 'Too few approvers', why: 'With one person holding finance:approve, there is no one to stand in or to check them.' },
  { id: 'after_hours_payments', title: 'Payments recorded outside working hours', why: 'Unusual times are worth a look (set the working hours to check).' },
  { id: 'write_off_without_note', title: 'Write-off with no collection history', why: 'A receivable written off with no note or reminder before it was perhaps never chased.' },
];

function monthBounds(m: string) {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  return { from: `${m}-01`, toExcl: `${next}-01` };
}

export function monthOf(raw: unknown, now = new Date()): string {
  if (raw == null || raw === '') return localDay(now).slice(0, 7);
  const m = String(raw);
  if (!MONTH_RE.test(m)) throw new ControlsError(422, 'month is YYYY-MM.');
  return m;
}

/** Run every control for a month (by when the second action happened). */
export async function run(orgId: string, monthRaw?: unknown) {
  const month = monthOf(monthRaw);
  const { from, toExcl } = monthBounds(month);
  const z = zone();
  const st = await settings(orgId);
  const q = (sql: string, params: unknown[]) => outsideRequestScope(() => many<any>(sql, params));
  const inMonth = (col: string) => `(${col} AT TIME ZONE '${z.replace(/'/g, "''")}') >= $2::date AND (${col} AT TIME ZONE '${z.replace(/'/g, "''")}') < $3::date`;
  const [bankPay, selfMatch, refundPaid, reopened, approvers, writeOffs] = await Promise.all([
    q(`SELECT DISTINCT ON (b.id, x.kind, x.id) b.id AS change_id, b.owner_id, w.name AS owner, u.name AS who, x.kind, x.id AS ref, x.at, b.decided_at
         FROM owner_bank_change_request b JOIN site_owner w ON w.id = b.owner_id LEFT JOIN app_user u ON u.id = b.decided_by
         JOIN LATERAL (
           SELECT 'statement_payment' AS kind, p.id::text AS id, p.created_at AS at FROM statement_payment p
            WHERE p.owner_id = b.owner_id AND p.kind = 'owner_payout' AND p.recorded_by = b.decided_by AND p.voided_at IS NULL
              AND p.created_at > b.decided_at AND p.created_at < b.decided_at + interval '90 days'
           UNION ALL
           SELECT 'payout_transfer', t.id::text, COALESCE(t.approved_at, t.first_approved_at) FROM payout_transfer t
            WHERE t.owner_id = b.owner_id AND (t.approved_by = b.decided_by OR t.first_approved_by = b.decided_by)
              AND COALESCE(t.approved_at, t.first_approved_at) > b.decided_at AND COALESCE(t.approved_at, t.first_approved_at) < b.decided_at + interval '90 days'
         ) x ON true
        WHERE b.org_id = $1 AND b.state = 'approved' AND b.decided_by IS NOT NULL AND ${inMonth('x.at')}`, [orgId, from, toExcl]),
    q(`SELECT l.id AS line_id, p.id AS ref, p.amount_minor, p.currency, s.number, u.name AS who, l.matched_at AS at
         FROM bank_statement_line l JOIN statement_payment p ON l.matched_kind = 'statement_payment' AND l.matched_ref = p.id::text
         JOIN commission_statement s ON s.id = p.statement_id LEFT JOIN app_user u ON u.id = l.matched_by
        WHERE l.org_id = $1 AND NOT l.matched_auto AND l.matched_by IS NOT NULL AND l.matched_by = p.recorded_by AND ${inMonth('l.matched_at')}`, [orgId, from, toExcl]),
    q(`SELECT r.id AS ref, r.amount_minor, r.currency, u.name AS who, pi.refunded_at AS at
         FROM driver_refund_request r JOIN payment_intent pi ON pi.id = r.payment_intent_id LEFT JOIN app_user u ON u.id = r.decided_by
        WHERE r.org_id = $1 AND r.state = 'approved' AND NOT r.auto AND r.decided_by IS NOT NULL AND pi.refund_method = 'manual' AND pi.refunded_by = r.decided_by
          AND pi.refunded_at IS NOT NULL AND ${inMonth('pi.refunded_at')}`, [orgId, from, toExcl]),
    q(`SELECT l.id AS ref, l.month, u.name AS who, l.reopened_at AS at, l.reopen_reason FROM finance_period_lock l LEFT JOIN app_user u ON u.id = l.reopened_by
        WHERE l.org_id = $1 AND l.reopened_by IS NOT NULL AND l.reopened_by = l.locked_by AND ${inMonth('l.reopened_at')}`, [orgId, from, toExcl]),
    q(`SELECT DISTINCT u.id, u.name FROM app_user u JOIN user_role ur ON ur.user_id = u.id JOIN role r ON r.id = ur.role_id
        WHERE u.org_id = $1 AND u.status = 'active' AND ('finance:approve' = ANY(r.permissions) OR '*' = ANY(r.permissions))`, [orgId]),
    q(`SELECT w.id AS ref, w.kind, w.ref AS receivable, w.amount_minor, w.currency, u.name AS who, w.decided_at AS at
         FROM receivable_write_off w LEFT JOIN app_user u ON u.id = w.decided_by
        WHERE w.org_id = $1 AND w.state = 'approved' AND ${inMonth('w.decided_at')}
          AND NOT EXISTS (SELECT 1 FROM receivable_note n WHERE n.kind = w.kind AND n.ref = w.ref AND n.created_at < w.decided_at)
          AND NOT EXISTS (SELECT 1 FROM dunning_reminder d WHERE d.kind = w.kind AND d.ref = w.ref AND d.ok AND d.sent_at < w.decided_at)`, [orgId, from, toExcl]),
  ]);
  let afterHours: any[] = [];
  if (st.workingHours) {
    const { from: hf, to: ht } = st.workingHours;
    afterHours = await q(
      `SELECT * FROM (
         SELECT 'statement_payment' AS kind, p.id::text AS ref, p.created_at AS at, u.name AS who, p.amount_minor, p.currency FROM statement_payment p LEFT JOIN app_user u ON u.id = p.recorded_by
          WHERE p.org_id = $1 AND p.recorded_by IS NOT NULL AND ${inMonth('p.created_at')}
         UNION ALL
         SELECT 'payout_transfer', t.id::text, t.approved_at, u.name, t.amount_minor, t.currency FROM payout_transfer t LEFT JOIN app_user u ON u.id = t.approved_by
          WHERE t.org_id = $1 AND t.approved_at IS NOT NULL AND ${inMonth('t.approved_at')}
         UNION ALL
         SELECT 'refund_transfer', t.id::text, t.approved_at, u.name, t.amount_minor, t.currency FROM refund_transfer t LEFT JOIN app_user u ON u.id = t.approved_by
          WHERE t.org_id = $1 AND t.approved_at IS NOT NULL AND ${inMonth('t.approved_at')}
       ) x WHERE extract(hour FROM x.at AT TIME ZONE $4) < $5 OR extract(hour FROM x.at AT TIME ZONE $4) >= $6
          OR extract(isodow FROM x.at AT TIME ZONE $4) >= 6`, [orgId, from, toExcl, z, hf, ht]);
  }
  const acks = await outsideRequestScope(() => many<any>(
    `SELECT a.target_id, a.after_state, a.ts, u.name FROM audit_log a LEFT JOIN app_user u ON a.actor_type = 'user' AND u.id::text = a.actor_id
      WHERE a.org_id = $1 AND a.action = 'controls.finding_acknowledged' ORDER BY a.ts`, [orgId]));
  const ackOf = new Map(acks.map((a) => [String(a.target_id), { by: a.name ?? null, at: iso(a.ts), note: String(a.after_state?.note ?? '') }]));
  const money = (n: unknown, c: string) => `${c} ${new Intl.NumberFormat('en-GB').format(Number(n))}`;
  const f = (control: string, key: string, r: { at?: Date | null; who?: string | null; ref?: unknown }, detail: string): Finding => {
    const k = `${control}:${key}`;
    return { control, key: k, at: iso(r.at ?? null), who: r.who ?? null, detail, ref: r.ref != null ? String(r.ref) : null, acknowledged: ackOf.get(k) ?? null };
  };
  const findings: Finding[] = [
    ...bankPay.map((r) => f('bank_change_then_payout', `${r.change_id}:${r.kind}:${r.ref}`, r,
      `${r.who ?? 'Someone'} approved ${r.owner}'s new bank account on ${localDay(r.decided_at)} and later ${r.kind === 'payout_transfer' ? 'approved a payout transfer' : 'recorded a payout'} to that owner.`)),
    ...selfMatch.map((r) => f('payment_self_matched', String(r.line_id), r, `${r.who ?? 'Someone'} recorded the payment on ${r.number} (${money(r.amount_minor, r.currency)}) and matched it to the bank line by hand.`)),
    ...refundPaid.map((r) => f('refund_decided_and_paid', String(r.ref), r, `${r.who ?? 'Someone'} approved driver refund request ${r.ref} (${money(r.amount_minor, r.currency)}) and recorded the refund paid by hand.`)),
    ...reopened.map((r) => f('period_reopened_by_locker', String(r.ref), r, `${r.who ?? 'Someone'} reopened ${r.month}, which they had locked: ${r.reopen_reason ?? ''}`.trim())),
    ...(approvers.length < st.minApprovers ? [f('approvers_concentration', month, { at: null, who: approvers.map((a) => a.name).join(', ') || null },
      `${approvers.length} active ${approvers.length === 1 ? 'person holds' : 'people hold'} finance:approve${approvers.length ? ` (${approvers.map((a) => a.name).join(', ')})` : ''}; the minimum is ${st.minApprovers}.`)] : []),
    ...afterHours.map((r) => f('after_hours_payments', `${r.kind}:${r.ref}`, r,
      `${r.kind.replace(/_/g, ' ')} ${r.ref} (${money(r.amount_minor, r.currency)}) by ${r.who ?? 'someone'} at ${new Date(r.at).toLocaleString('en-GB', { timeZone: z, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}.`)),
    ...writeOffs.map((r) => f('write_off_without_note', String(r.ref), r, `${r.who ?? 'Someone'} approved writing off ${r.kind.replace(/_/g, ' ')} ${r.receivable} (${money(r.amount_minor, r.currency)}) with no note or reminder on it before.`)),
  ];
  const summary = CONTROLS.map((c) => {
    const mine = findings.filter((x) => x.control === c.id);
    return { ...c, findings: mine.length, open: mine.filter((x) => !x.acknowledged).length, ran: c.id !== 'after_hours_payments' || !!st.workingHours };
  });
  return { month, settings: st, summary, findings, approvers: approvers.map((a) => ({ id: a.id, name: a.name })) };
}

/** A finding's key as the controls produce it (control:…). */
const KEY_RE = /^[a-z_]+:[\w:.-]{1,200}$/;
export function assertKey(key: unknown): string {
  const k = String(key ?? '');
  if (!KEY_RE.test(k) || !CONTROLS.some((c) => k.startsWith(`${c.id}:`))) throw new ControlsError(422, 'No such finding.');
  return k;
}

// ─────────────────────────────────────────── report

export async function report(orgId: string, monthRaw?: unknown): Promise<{ month: string; xlsx: Buffer }> {
  const r = await run(orgId, monthRaw);
  const { from, toExcl } = monthBounds(r.month);
  const to = localDay(Date.parse(`${toExcl}T12:00:00Z`) - 86_400_000);
  const log = await changeLog(orgId, { from, to: to > localDay() ? localDay() : to, limit: 5000 });
  const byPerson = new Map<string, Map<string, number>>();
  for (const e of log.entries) {
    const who = e.actor.name ?? e.actor.id ?? e.actor.type;
    const m = byPerson.get(who) ?? new Map<string, number>();
    m.set(e.action, (m.get(e.action) ?? 0) + 1);
    byPerson.set(who, m);
  }
  const counts: Array<Array<string | number>> = [['Person', 'Action', 'Count']];
  for (const [who, m] of [...byPerson.entries()].sort()) for (const [a, n] of [...m.entries()].sort()) counts.push([who, a, n]);
  return {
    month: r.month,
    xlsx: xlsx([
      { name: 'Controls', rows: [['Control', 'Checked', 'Findings', 'Open', 'Why'], ...r.summary.map((s) => [s.title, s.ran ? 'yes' : 'not set', s.findings, s.open, s.why])], widths: [44, 10, 10, 8, 90], formats: [null, null, 'int', 'int', null] },
      { name: 'Findings', rows: [['Control', 'When', 'Who', 'Detail', 'Acknowledged by', 'Note'], ...r.findings.map((x) => [CONTROLS.find((c) => c.id === x.control)?.title ?? x.control, x.at ?? '', x.who ?? '', x.detail, x.acknowledged?.by ?? '', x.acknowledged?.note ?? ''])], widths: [40, 22, 22, 90, 22, 40] },
      { name: 'Change log', rows: [['At', 'Person', 'Action', 'Target', 'Target id', 'After'], ...log.entries.map((e) => [e.at, e.actor.name ?? e.actor.id ?? e.actor.type, e.action, e.targetType ?? '', e.targetId ?? '', e.after ? JSON.stringify(e.after).slice(0, 2000) : ''])], widths: [22, 24, 36, 20, 38, 80] },
      { name: 'By person', rows: counts, widths: [28, 40, 10], formats: [null, null, 'int'] },
    ]),
  };
}
