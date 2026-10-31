import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { persistAlert, resolveAlertsFor } from './alerts.js';
import { moneyText, currencyOr } from '../domain/money.js';

/**
 * Owner statement disputes (v1.23.0). A site owner queries a finalised statement from the owner portal (Payouts →
 * a statement → Query): a line of it (a site) or the whole statement, what is wrong, and optionally the amount it
 * believes it is owed. The operator is alerted (finance.owner_dispute) and answers it in Finance → Payables → Owner
 * queries:
 *
 *   reject    the statement stands (the answer says why)
 *   resolve   explained, nothing to change
 *   adjust    an amount the operator owes the owner (or, negative, the owner owes back): added to the owner's share on
 *             the NEXT statement finalised for that owner and currency, shown there as an adjustment line. A
 *             finalised statement never changes.
 *
 * The owner sees the answer and the adjustment in the portal; an open query can be withdrawn by the owner.
 */

export class DisputeError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

const KIND = 'finance.owner_dispute';
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

const view = (r: any) => ({
  id: String(r.id), ownerId: r.owner_id, owner: r.owner_name ?? undefined, statementId: r.statement_id, statementNumber: r.number, period: r.period, currency: r.currency,
  line: r.line ?? null, message: r.message, claimed: r.claimed_minor == null ? null : Number(r.claimed_minor), state: r.state,
  raisedAt: iso(r.raised_at), raisedBy: r.raised_by_name ?? null, answer: r.answer ?? null, answeredAt: iso(r.answered_at), answeredBy: r.answered_by_name ?? null,
  adjustment: r.adj_id ? { id: String(r.adj_id), amount: Number(r.adj_amount), applied: !!r.adj_applied, appliedTo: r.adj_number ?? null } : null,
});

const SELECT = `SELECT d.*, s.number, to_char(s.period, 'YYYY-MM') AS period, s.currency, o.name AS owner_name, ru.name AS raised_by_name, au.name AS answered_by_name,
                       a.id AS adj_id, a.amount_minor AS adj_amount, a.applied_statement_id AS adj_applied, ns.number AS adj_number
                  FROM owner_statement_dispute d JOIN commission_statement s ON s.id = d.statement_id JOIN site_owner o ON o.id = d.owner_id
                  LEFT JOIN app_user ru ON ru.id = d.raised_by LEFT JOIN app_user au ON au.id = d.answered_by
                  LEFT JOIN owner_statement_adjustment a ON a.dispute_id = d.id LEFT JOIN commission_statement ns ON ns.id = a.applied_statement_id`;

/** The owner's statements it can query (finalised, with the sites on them) and its queries. */
export async function forOwner(orgId: string, ownerId: string) {
  const [stmts, rows] = await Promise.all([
    outsideRequestScope(() => many<any>(
      `SELECT id, number, to_char(period, 'YYYY-MM') AS period, currency, owner_share_minor, data FROM commission_statement
        WHERE org_id = $1 AND owner_id = $2 AND finalised_at IS NOT NULL ORDER BY period DESC LIMIT 24`, [orgId, ownerId])),
    outsideRequestScope(() => many<any>(`${SELECT} WHERE d.org_id = $1 AND d.owner_id = $2 ORDER BY d.raised_at DESC LIMIT 100`, [orgId, ownerId])),
  ]);
  return {
    statements: stmts.map((s) => ({
      id: s.id, number: s.number, period: s.period, currency: s.currency, share: Number(s.owner_share_minor),
      lines: [...new Set<string>(((s.data?.sites ?? []) as any[]).map((x) => String(x.name ?? x.siteName ?? '')).filter(Boolean))],
    })),
    disputes: rows.map(view),
  };
}

export async function raise(orgId: string, ownerId: string, b: Record<string, unknown>, userId: string | null) {
  const sid = String(b.statementId ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(sid)) throw new DisputeError(404, 'No such statement.');
  const st = await outsideRequestScope(() => one<{ id: string; number: string; currency: string }>(
    `SELECT id, number, currency FROM commission_statement WHERE id = $1 AND org_id = $2 AND owner_id = $3 AND finalised_at IS NOT NULL`, [sid, orgId, ownerId]));
  if (!st) throw new DisputeError(404, 'No such statement.');
  const message = String(b.message ?? '').trim();
  if (message.length < 10 || message.length > 2000) throw new DisputeError(422, 'Say what is wrong (10 to 2000 characters).');
  const claimed = b.claimed == null || b.claimed === '' ? null : Number(b.claimed);
  if (claimed != null && (!Number.isInteger(claimed) || claimed === 0 || Math.abs(claimed) > 1e15)) throw new DisputeError(422, 'The amount is a whole number of the currency\'s minor unit (not 0).');
  const open = await outsideRequestScope(() => one<{ n: number }>(`SELECT count(*)::int AS n FROM owner_statement_dispute WHERE statement_id = $1 AND state = 'open'`, [sid]));
  if ((open?.n ?? 0) >= 5) throw new DisputeError(409, 'This statement already has 5 open queries: wait for an answer.');
  const r = await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO owner_statement_dispute (org_id, owner_id, statement_id, line, message, claimed_minor, raised_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [orgId, ownerId, sid, b.line == null || b.line === '' ? null : String(b.line).slice(0, 200), message, claimed, userId]));
  const owner = await outsideRequestScope(() => one<{ name: string }>(`SELECT name FROM site_owner WHERE id = $1`, [ownerId]));
  await outsideRequestScope(() => persistAlert({ orgId, kind: KIND, severity: 'warning', targetType: 'owner_statement_dispute', targetId: String(r!.id),
    message: `${owner?.name ?? 'A site owner'} queried statement ${st.number}${b.line ? ` (${String(b.line).slice(0, 80)})` : ''}${claimed != null ? `, claiming ${moneyText(claimed, currencyOr(st.currency))}` : ''}. Answer it in Finance → Payables → Owner queries.` })).catch(() => null);
  return { id: String(r!.id), state: 'open' };
}

export async function withdraw(orgId: string, ownerId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new DisputeError(404, 'No such query.');
  const r = await outsideRequestScope(() => one(`UPDATE owner_statement_dispute SET state = 'withdrawn' WHERE id = $1 AND org_id = $2 AND owner_id = $3 AND state = 'open' RETURNING id`, [id, orgId, ownerId]));
  if (!r) throw new DisputeError(409, 'Only an open query can be withdrawn.');
  await outsideRequestScope(() => resolveAlertsFor(orgId, KIND, 'owner_statement_dispute', id)).catch(() => 0);
  return { ok: true };
}

/** The operator's list: open first, then the last answered. */
export async function list(orgId: string) {
  const rows = await outsideRequestScope(() => many<any>(`${SELECT} WHERE d.org_id = $1 ORDER BY (d.state = 'open') DESC, d.raised_at DESC LIMIT 200`, [orgId]));
  const pending = await outsideRequestScope(() => many<any>(
    `SELECT a.owner_id, o.name, a.currency, sum(a.amount_minor)::bigint AS amount, count(*)::int AS n FROM owner_statement_adjustment a JOIN site_owner o ON o.id = a.owner_id
      WHERE a.org_id = $1 AND a.applied_statement_id IS NULL GROUP BY 1, 2, 3 ORDER BY 2`, [orgId]));
  return {
    disputes: rows.map(view), open: rows.filter((r) => r.state === 'open').length,
    pendingAdjustments: pending.map((p) => ({ ownerId: p.owner_id, owner: p.name, currency: p.currency, amount: Number(p.amount), count: p.n })),
  };
}

export async function answer(orgId: string, id: string, b: Record<string, unknown>, userId: string | null) {
  if (!/^\d{1,18}$/.test(id)) throw new DisputeError(404, 'No such query.');
  const decision = String(b.decision ?? '');
  if (!['reject', 'resolve', 'adjust'].includes(decision)) throw new DisputeError(422, 'decision is reject, resolve or adjust.');
  const text = String(b.answer ?? '').trim();
  if (text.length < 5 || text.length > 2000) throw new DisputeError(422, 'Write the answer the owner will see (5 to 2000 characters).');
  const d = await outsideRequestScope(() => one<any>(
    `SELECT d.*, s.currency, s.number FROM owner_statement_dispute d JOIN commission_statement s ON s.id = d.statement_id WHERE d.id = $1 AND d.org_id = $2`, [id, orgId]));
  if (!d) throw new DisputeError(404, 'No such query.');
  if (d.state !== 'open') throw new DisputeError(409, `This query is ${d.state}.`);
  let amount = 0;
  if (decision === 'adjust') {
    amount = Number(b.amount);
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1e15) throw new DisputeError(422, 'The adjustment is a whole number of the currency\'s minor unit, not 0 (negative: the owner owes it back).');
  }
  const state = decision === 'reject' ? 'rejected' : decision === 'resolve' ? 'resolved' : 'adjusted';
  const upd = await outsideRequestScope(() => one(
    `UPDATE owner_statement_dispute SET state = $3, answer = $4, answered_by = $5, answered_at = now() WHERE id = $1 AND org_id = $2 AND state = 'open' RETURNING id`, [id, orgId, state, text, userId]));
  if (!upd) throw new DisputeError(409, 'This query was just answered.');
  if (decision === 'adjust') {
    await outsideRequestScope(() => query(
      `INSERT INTO owner_statement_adjustment (org_id, owner_id, dispute_id, currency, amount_minor, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [orgId, d.owner_id, id, d.currency, amount, `Query on statement ${d.number}: ${text.slice(0, 160)}`, userId]));
  }
  await outsideRequestScope(() => resolveAlertsFor(orgId, KIND, 'owner_statement_dispute', id)).catch(() => 0);
  return { id, state, amount: decision === 'adjust' ? amount : null, currency: d.currency };
}

/** The adjustments waiting for an owner's next statement in a currency (services/commission.ts adds them). */
export async function pendingFor(orgId: string, ownerId: string, currency: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT id, amount_minor, note, dispute_id FROM owner_statement_adjustment WHERE org_id = $1 AND owner_id = $2 AND currency = $3 AND applied_statement_id IS NULL ORDER BY id`,
    [orgId, ownerId, currency]));
  return rows.map((r) => ({ id: String(r.id), amountMinor: Number(r.amount_minor), note: r.note as string, disputeId: r.dispute_id == null ? null : String(r.dispute_id) }));
}

/** Mark adjustments applied to a finalised statement (only those still pending). */
export async function markApplied(ids: string[], statementId: string) {
  if (!ids.length) return 0;
  const r = await outsideRequestScope(() => query(
    `UPDATE owner_statement_adjustment SET applied_statement_id = $2, applied_at = now() WHERE id = ANY($1::bigint[]) AND applied_statement_id IS NULL`, [ids, statementId]));
  return r.rowCount ?? 0;
}
