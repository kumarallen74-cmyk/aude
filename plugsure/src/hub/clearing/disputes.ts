import type pg from 'pg';
import { tx } from '../../db/pool.js';
import { config } from '../../config.js';
import { HubError } from '../errors.js';
import { afterDispute } from './accept.js';
import { alert, audit } from './notify.js';

/**
 * Disputes (docs/HUB-DESIGN.md §8.3; OCPI has no dispute module, so this is console/API only).
 *
 *   open ──accept (CPO)──► accepted ──credit CDR arrives──► credited                       (final)
 *     │                       └──no credit by credit_due_by──► escalated
 *     ├──reject (CPO, with a reason)──► rejected ──escalate (eMSP, by escalate_by)──► escalated
 *     │                                    └──escalate_by passes──► expired (the CDR stands)  (final)
 *     ├──no answer by respond_by──► escalated
 *     └──withdraw (eMSP)──► withdrawn (final; the CDR is payable again)
 *   escalated ──resolve (platform): upheld → resolved (CDR accepted) | written_off → resolved (CDR written off,
 *              the CPO is not paid) | credit_required → accepted (the CPO must send the credit CDR)
 *
 * The eMSP may dispute a `pending` CDR until its dispute_deadline (received_at + the agreement's dispute_days,
 * default HUB_DISPUTE_DAYS = 14). While a dispute is live the CDR is `disputed` and is not settled.
 * Every transition writes a note (the evidence trail, visible to both sides) and an audit entry on the
 * platform chain and both members' chains.
 */

export const LIVE = ['open', 'accepted', 'rejected', 'escalated'] as const;
export const FINAL = ['credited', 'expired', 'resolved', 'withdrawn'] as const;
export type DisputeStatus = (typeof LIVE)[number] | (typeof FINAL)[number];
export type DisputeAction = 'accept' | 'reject' | 'escalate' | 'withdraw' | 'resolve_upheld' | 'resolve_written_off' | 'resolve_credit_required'
  | 'expire_response' | 'expire_credit' | 'expire_escalation' | 'credit';
export type Side = 'cpo' | 'emsp' | 'platform' | 'system';

export const REASONS = ['unknown_token', 'not_authorized', 'duplicate', 'amount', 'energy', 'tariff_mismatch', 'session_not_found', 'other'] as const;

const T: Record<string, Partial<Record<DisputeAction, { to: DisputeStatus; by: Side[] }>>> = {
  open: {
    accept: { to: 'accepted', by: ['cpo'] },
    reject: { to: 'rejected', by: ['cpo'] },
    escalate: { to: 'escalated', by: ['platform'] },
    withdraw: { to: 'withdrawn', by: ['emsp', 'platform'] },
    expire_response: { to: 'escalated', by: ['system'] },
    resolve_upheld: { to: 'resolved', by: ['platform'] },
    resolve_written_off: { to: 'resolved', by: ['platform'] },
    resolve_credit_required: { to: 'accepted', by: ['platform'] },
    credit: { to: 'credited', by: ['system'] },
  },
  accepted: {
    escalate: { to: 'escalated', by: ['platform'] },
    withdraw: { to: 'withdrawn', by: ['emsp', 'platform'] },
    expire_credit: { to: 'escalated', by: ['system'] },
    resolve_upheld: { to: 'resolved', by: ['platform'] },
    resolve_written_off: { to: 'resolved', by: ['platform'] },
    credit: { to: 'credited', by: ['system'] },
  },
  rejected: {
    escalate: { to: 'escalated', by: ['emsp', 'platform'] },
    withdraw: { to: 'withdrawn', by: ['emsp', 'platform'] },
    expire_escalation: { to: 'expired', by: ['system'] },
    resolve_upheld: { to: 'resolved', by: ['platform'] },
    resolve_written_off: { to: 'resolved', by: ['platform'] },
    resolve_credit_required: { to: 'accepted', by: ['platform'] },
    credit: { to: 'credited', by: ['system'] },
  },
  escalated: {
    withdraw: { to: 'withdrawn', by: ['emsp', 'platform'] },
    resolve_upheld: { to: 'resolved', by: ['platform'] },
    resolve_written_off: { to: 'resolved', by: ['platform'] },
    resolve_credit_required: { to: 'accepted', by: ['platform'] },
    credit: { to: 'credited', by: ['system'] },
  },
};

/** The state machine (pure). Throws a 409 HubError for a transition that does not exist or this side may not make. */
export function nextStatus(from: string, action: DisputeAction, by: Side): DisputeStatus {
  const t = T[from]?.[action];
  if (!t) throw new HubError(409, 2000, `a dispute that is ${from} cannot be ${action.replace(/_/g, ' ')}`);
  if (!t.by.includes(by)) throw new HubError(403, 2000, `the ${by === 'emsp' ? 'eMSP' : by === 'cpo' ? 'CPO' : by} cannot ${action.replace(/_/g, ' ')} this dispute`);
  return t.to;
}

export interface Actor { side: Side; memberId?: string | null; userId?: string | null; ip?: string | null }

const days = (n: number, from: Date) => new Date(from.getTime() + n * 86_400_000);

async function note(c: pg.PoolClient, d: any, side: Side, kind: string, body: string, author: string | null) {
  await c.query(`INSERT INTO hub_dispute_note (dispute_id, cpo_org_id, emsp_org_id, side, kind, author_id, body) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [d.id, d.cpo_org_id, d.emsp_org_id, side, kind, author, body.slice(0, 4000)]);
}

const textOf = (v: unknown, what: string, required: boolean): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new HubError(400, 2001, `${what} is required`);
  if (s.length > 4000) throw new HubError(400, 2001, `${what}: at most 4000 characters`);
  return s;
};

/** The eMSP (or a platform admin) disputes a CDR within its window. */
export async function raiseDispute(cdrId: string, actor: Actor, b: { reason?: unknown; message?: unknown; claimed_minor?: unknown }, now: Date = new Date()) {
  const reason = String(b.reason ?? '');
  if (!(REASONS as readonly string[]).includes(reason)) throw new HubError(400, 2001, `reason: one of ${REASONS.join(', ')}`);
  const message = textOf(b.message, 'message', true);
  const claimed = b.claimed_minor == null ? null : Number(b.claimed_minor);
  if (claimed != null && (!Number.isSafeInteger(claimed) || claimed < 0)) throw new HubError(400, 2001, 'claimed_minor: a whole, non-negative amount in minor units of the CDR currency');
  const after: Array<() => void> = [];
  const d = await tx(async (c) => {
    const cdr = (await c.query(`SELECT * FROM hub_cdr WHERE id = $1 FOR UPDATE`, [cdrId])).rows[0];
    if (!cdr) throw new HubError(404, 2000, 'CDR not found');
    if (actor.side === 'emsp' && cdr.emsp_member_id !== actor.memberId) throw new HubError(404, 2000, 'CDR not found');
    if (actor.side !== 'emsp' && actor.side !== 'platform') throw new HubError(403, 2000, 'only the eMSP (or the platform) disputes a CDR');
    if (cdr.credit) throw new HubError(409, 2000, 'a credit CDR cannot be disputed');
    if (actor.side === 'emsp') {
      if (cdr.status !== 'pending') throw new HubError(409, 2000, `this CDR is ${cdr.status}: only a pending CDR can be disputed`);
      if (new Date(cdr.dispute_deadline) < now) throw new HubError(409, 2000, `the dispute window closed on ${new Date(cdr.dispute_deadline).toISOString()}`);
    } else if (!['pending', 'accepted'].includes(cdr.status) || cdr.settlement_run_id) {
      throw new HubError(409, 2000, `this CDR is ${cdr.status}${cdr.settlement_run_id ? ' and settled' : ''}: it cannot be disputed`);
    }
    const row = (await c.query(
      `INSERT INTO hub_dispute (hub_cdr_id, cpo_member_id, emsp_member_id, cpo_org_id, emsp_org_id, raised_by, reason, currency, claimed_minor, message,
                                respond_by, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *`,
      [cdr.id, cdr.cpo_member_id, cdr.emsp_member_id, cdr.cpo_org_id, cdr.emsp_org_id, actor.side, reason, cdr.currency, claimed, message,
        days(config.hub.disputeResponseDays, now), actor.userId ?? null, now])).rows[0];
    await c.query(`UPDATE hub_cdr SET status = 'disputed', updated_at = now() WHERE id = $1`, [cdr.id]);
    await note(c, row, actor.side, 'raised', `${reason}: ${message}`, actor.userId ?? null);
    after.push(() => {
      alert(cdr.cpo_org_id, 'hub.dispute_opened', `Hub CDR ${cdr.cdr_id} is disputed by the eMSP (${reason}). Answer by ${row.respond_by.toISOString().slice(0, 10)} or it goes to the platform.`, { type: 'hub_dispute', id: row.id });
      void audit('hub.dispute_opened', 'hub_dispute', row.id, { actorId: actor.userId, orgIds: [cdr.emsp_org_id, cdr.cpo_org_id], ip: actor.ip, after: { cdr: cdr.cdr_id, reason, claimed_minor: claimed } });
    });
    return row;
  });
  for (const f of after) f();
  return d;
}

/**
 * Apply one transition. `side` is the actor's side; a member acts only on disputes where it is that side.
 * Outcomes on the CDR: upheld / expired → accepted (fees frozen); withdrawn → pending again (or accepted when
 * its window has passed); written_off → written_off; credit_required → the CPO must send the credit CDR.
 */
export async function transition(disputeId: string, action: DisputeAction, actor: Actor, b: { note?: unknown } = {}, now: Date = new Date()) {
  const body = textOf(b.note, 'note', action === 'reject' || action.startsWith('resolve'));
  const after: Array<() => void> = [];
  const out = await tx(async (c) => {
    const d = (await c.query(`SELECT * FROM hub_dispute WHERE id = $1 FOR UPDATE`, [disputeId])).rows[0];
    if (!d) throw new HubError(404, 2000, 'dispute not found');
    if (actor.side === 'cpo' && d.cpo_member_id !== actor.memberId) throw new HubError(404, 2000, 'dispute not found');
    if (actor.side === 'emsp' && d.emsp_member_id !== actor.memberId) throw new HubError(404, 2000, 'dispute not found');
    const to = nextStatus(d.status, action, actor.side);
    const sets: string[] = ['status = $2', 'updated_at = $3'];
    const params: unknown[] = [d.id, to, now];
    const add = (sql: string, v: unknown) => { params.push(v); sets.push(`${sql} = $${params.length}`); };
    if (action === 'accept' || action === 'resolve_credit_required') add('credit_due_by', days(config.hub.creditDueDays, now));
    if (action === 'reject') add('escalate_by', days(config.hub.disputeEscalateDays, now));
    const final = to === 'resolved' || to === 'expired' || to === 'withdrawn';
    if (final) { add('resolved_at', now); add('resolved_by', actor.userId ?? null); }
    if (action === 'resolve_upheld' || action === 'expire_escalation') add('resolution', 'upheld');
    if (action === 'resolve_written_off') add('resolution', 'written_off');
    const row = (await c.query(`UPDATE hub_dispute SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params)).rows[0];
    const kind = action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : action === 'withdraw' ? 'withdrawn'
      : action === 'expire_escalation' ? 'expired' : action.startsWith('resolve') ? 'resolved' : 'escalated';
    const auto: Partial<Record<DisputeAction, string>> = {
      expire_response: `The CPO did not answer by ${new Date(d.respond_by).toISOString().slice(0, 10)}: escalated to the platform.`,
      expire_credit: `No credit CDR arrived by ${d.credit_due_by ? new Date(d.credit_due_by).toISOString().slice(0, 10) : 'the due date'}: escalated to the platform.`,
      expire_escalation: 'The eMSP did not escalate the rejection in time: the CDR stands.',
      resolve_credit_required: 'The platform decided the CPO must send a credit CDR (and a corrected CDR if any amount is due).',
    };
    await note(c, row, actor.side, kind, [auto[action], body].filter(Boolean).join(' ') || kind, actor.userId ?? null);
    const cdr = (await c.query(`SELECT id, cdr_id, status FROM hub_cdr WHERE id = $1`, [d.hub_cdr_id])).rows[0];
    if (action === 'resolve_upheld' || action === 'expire_escalation') await afterDispute(c, d.hub_cdr_id, 'upheld', now);
    else if (action === 'withdraw') await afterDispute(c, d.hub_cdr_id, 'withdrawn', now);
    else if (action === 'resolve_written_off') await c.query(`UPDATE hub_cdr SET status = 'written_off', updated_at = now() WHERE id = $1 AND status = 'disputed'`, [d.hub_cdr_id]);
    after.push(() => {
      const msg = `Dispute on hub CDR ${cdr?.cdr_id}: ${to}${row.resolution ? ` (${row.resolution})` : ''}.${body ? ` ${body.slice(0, 300)}` : ''}`;
      if (actor.side !== 'cpo') alert(d.cpo_org_id, 'hub.dispute_updated', msg, { type: 'hub_dispute', id: d.id }, 'info');
      if (actor.side !== 'emsp') alert(d.emsp_org_id, 'hub.dispute_updated', msg, { type: 'hub_dispute', id: d.id }, 'info');
      if (to === 'escalated') alert(null, 'hub.dispute_escalated', `A dispute on hub CDR ${cdr?.cdr_id} needs a platform decision (${action.replace(/_/g, ' ')}).`, { type: 'hub_dispute', id: d.id });
      void audit(`hub.dispute_${kind}`, 'hub_dispute', d.id, { actorId: actor.userId, ip: actor.ip, orgIds: [d.cpo_org_id, d.emsp_org_id], before: { status: d.status }, after: { status: to, resolution: row.resolution, action } });
    });
    return row;
  });
  for (const f of after) f();
  return out;
}

/** Evidence or a comment from either side (or the platform), without a transition. */
export async function addNote(disputeId: string, actor: Actor, text: unknown) {
  const body = textOf(text, 'note', true);
  return tx(async (c) => {
    const d = (await c.query(`SELECT * FROM hub_dispute WHERE id = $1`, [disputeId])).rows[0];
    if (!d) throw new HubError(404, 2000, 'dispute not found');
    if ((actor.side === 'cpo' && d.cpo_member_id !== actor.memberId) || (actor.side === 'emsp' && d.emsp_member_id !== actor.memberId)) throw new HubError(404, 2000, 'dispute not found');
    await note(c, d, actor.side, 'note', body, actor.userId ?? null);
    return (await c.query(`SELECT * FROM hub_dispute_note WHERE dispute_id = $1 ORDER BY id`, [d.id])).rows;
  });
}

/** Worker (hourly): deadlines → escalated / expired. Returns how many disputes moved. */
export async function escalateOverdue(now: Date = new Date()): Promise<number> {
  const due = await tx(async (c) => (await c.query<{ id: string; status: string }>(
    `SELECT id, status FROM hub_dispute
      WHERE (status = 'open' AND respond_by <= $1) OR (status = 'accepted' AND credit_due_by <= $1) OR (status = 'rejected' AND escalate_by <= $1)
      ORDER BY created_at LIMIT 500`, [now])).rows);
  let n = 0;
  for (const d of due) {
    const action: DisputeAction = d.status === 'open' ? 'expire_response' : d.status === 'accepted' ? 'expire_credit' : 'expire_escalation';
    try { await transition(d.id, action, { side: 'system' }, {}, now); n++; } catch { /* moved meanwhile */ }
  }
  return n;
}

