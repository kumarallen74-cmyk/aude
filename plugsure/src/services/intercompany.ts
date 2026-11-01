import { many, one, outsideRequestScope, query } from '../db/pool.js';
import { config } from '../config.js';
import { split } from './shared-costs.js';

/**
 * Intercompany recharges (v1.31.0). Within a group (a parent organisation and its subsidiaries, as for consolidation):
 *
 *   recharge     one entity charges another for a cost it carried (IC-00001…): the month, a description, the amount and
 *                currency; drafted or issued; voided with a reason while not settled. The charging entity sees a
 *                receivable, the charged one a payable; both see the recharge
 *   allocate     a cost the entity carried for the group, split across the group's entities by kWh, sessions or revenue
 *                in the month (or equally); each other entity's share becomes a draft recharge to review and issue
 *   balances     per counterparty and currency: receivable, payable and the net
 *   settle       the issued recharges between two entities in a currency, netted: who pays whom and how much; the
 *                recharges are settled
 *
 * The general ledger posts them (receivable / recharge income; recharge expense / payable; the settlement through the
 * bank).
 */

export class IntercompanyError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export const BASES = ['fixed', 'kwh', 'sessions', 'revenue', 'equal'] as const;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const zone = () => config.billing.timeZone;
const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(now);

/** The caller's group: its parent (or itself) and the parent's subsidiaries. */
export async function group(orgId: string) {
  const me = await outsideRequestScope(() => one<{ id: string; parent_org_id: string | null }>(`SELECT id, parent_org_id FROM organisation WHERE id = $1`, [orgId]));
  const parent = me?.parent_org_id ?? orgId;
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT id, name FROM organisation WHERE (id = $1 OR parent_org_id = $1) AND archived_at IS NULL AND sandbox_of_org_id IS NULL ORDER BY (id = $1) DESC, name`, [parent]));
  return rows.map((r) => ({ id: r.id as string, name: r.name as string, parent: r.id === parent, me: r.id === orgId }));
}

async function member(orgId: string, other: string) {
  if (!UUID_RE.test(other)) throw new IntercompanyError(404, 'No such group entity.');
  const g = await group(orgId);
  const e = g.find((x) => x.id === other && !x.me);
  if (!e) throw new IntercompanyError(422, 'That organisation is not another entity of your group.');
  return e;
}

const SELECT = `SELECT r.*, o.name AS from_name, t.name AS to_name, u.name AS by_name FROM intercompany_recharge r
  JOIN organisation o ON o.id = r.org_id JOIN organisation t ON t.id = r.to_org_id LEFT JOIN app_user u ON u.id = r.created_by`;

const view = (r: any, orgId: string) => ({
  id: String(r.id), number: r.number, direction: r.org_id === orgId ? 'out' as const : 'in' as const,
  fromOrgId: r.org_id, from: r.from_name, toOrgId: r.to_org_id, to: r.to_name, month: r.month, description: r.description, basis: r.basis,
  amount: Number(r.amount_minor), currency: r.currency, status: r.status, settlementId: r.settlement_id == null ? null : String(r.settlement_id),
  createdBy: r.by_name ?? null, issuedAt: r.issued_at ? new Date(r.issued_at).toISOString() : null, voidReason: r.void_reason ?? null,
});
export type RechargeView = ReturnType<typeof view>;

export async function list(orgId: string, q: Record<string, unknown> = {}) {
  const g = await group(orgId);
  const rows = await outsideRequestScope(() => many<any>(
    `${SELECT} WHERE (r.org_id = $1 OR (r.to_org_id = $1 AND r.status <> 'draft')) AND ($2::text IS NULL OR r.status = $2) ORDER BY r.created_at DESC, r.id DESC LIMIT 500`,
    [orgId, q.status == null || q.status === '' ? null : String(q.status)]));
  const recharges = rows.map((r) => view(r, orgId));
  const bal = new Map<string, { otherOrgId: string; other: string; currency: string; receivable: number; payable: number; net: number; open: number }>();
  for (const r of recharges.filter((x) => x.status === 'issued')) {
    const other = r.direction === 'out' ? r.toOrgId : r.fromOrgId;
    const k = `${other}|${r.currency}`;
    const b = bal.get(k) ?? { otherOrgId: other, other: r.direction === 'out' ? r.to : r.from, currency: r.currency, receivable: 0, payable: 0, net: 0, open: 0 };
    if (r.direction === 'out') b.receivable += r.amount; else b.payable += r.amount;
    b.net = b.receivable - b.payable; b.open++;
    bal.set(k, b);
  }
  const settlements = await outsideRequestScope(() => many<any>(
    `SELECT s.*, to_char(s.settled_on, 'YYYY-MM-DD') AS on_s, o.name AS org_name, x.name AS other_name FROM intercompany_settlement s JOIN organisation o ON o.id = s.org_id JOIN organisation x ON x.id = s.other_org_id
      WHERE s.org_id = $1 OR s.other_org_id = $1 ORDER BY s.settled_on DESC, s.id DESC LIMIT 50`, [orgId]));
  return {
    group: g, grouped: g.length > 1, recharges, balances: [...bal.values()],
    settlements: settlements.map((s) => {
      const mine = s.org_id === orgId;
      const rec = Number(mine ? s.receivable_minor : s.payable_minor), pay = Number(mine ? s.payable_minor : s.receivable_minor);
      return { id: String(s.id), other: mine ? s.other_name : s.org_name, currency: s.currency, receivable: rec, payable: pay, net: rec - pay, settledOn: s.on_s, reference: s.reference ?? null, recharges: s.recharges };
    }),
  };
}

async function nextNumber(orgId: string) {
  const r = await outsideRequestScope(() => one<{ n: string }>(`SELECT count(*) + 1 AS n FROM intercompany_recharge WHERE org_id = $1`, [orgId]));
  return Number(r?.n ?? 1);
}

async function insert(orgId: string, d: { toOrgId: string; month: string; description: string; basis: string; amount: number; currency: string; draft: boolean }, userId: string | null) {
  let n = await nextNumber(orgId);
  for (let k = 0; k < 5; k++, n++) {
    try {
      const r = await outsideRequestScope(() => one<{ id: string }>(
        `INSERT INTO intercompany_recharge (org_id, to_org_id, number, month, description, basis, amount_minor, currency, status, created_by, issued_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $9 = 'issued' THEN now() END) RETURNING id`,
        [orgId, d.toOrgId, `IC-${String(n).padStart(5, '0')}`, d.month, d.description, d.basis, d.amount, d.currency, d.draft ? 'draft' : 'issued', userId]));
      return String(r!.id);
    } catch (e) { if ((e as any).code !== '23505') throw e; }
  }
  throw new IntercompanyError(409, 'Could not number the recharge. Try again.');
}

async function get(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw new IntercompanyError(404, 'No such recharge.');
  const r = await outsideRequestScope(() => one<any>(`${SELECT} WHERE r.id = $1 AND (r.org_id = $2 OR (r.to_org_id = $2 AND r.status <> 'draft'))`, [id, orgId]));
  if (!r) throw new IntercompanyError(404, 'No such recharge.');
  return r;
}

function common(b: Record<string, unknown>) {
  const month = String(b.month ?? '');
  if (!MONTH_RE.test(month)) throw new IntercompanyError(422, 'month is YYYY-MM.');
  const description = String(b.description ?? '').trim();
  if (description.length < 3 || description.length > 200) throw new IntercompanyError(422, 'Describe the recharge (3 to 200 characters).');
  const currency = String(b.currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new IntercompanyError(422, 'currency is an ISO code.');
  return { month, description, currency };
}

export async function create(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const to = await member(orgId, String(b.toOrgId ?? ''));
  const c = common(b);
  const amount = Number(b.amount);
  if (!Number.isInteger(amount) || amount <= 0) throw new IntercompanyError(422, 'amount is a whole amount of the minor unit, above 0.');
  const id = await insert(orgId, { toOrgId: to.id, ...c, basis: 'fixed', amount, draft: b.draft === true || b.draft === 'true' }, userId);
  return view(await get(orgId, id), orgId);
}

/** Each group entity's kWh, sessions and revenue in a month (charge records). */
async function weights(ids: string[], month: string) {
  const rows = await outsideRequestScope(() => many<any>(
    `SELECT d.org_id, count(*) AS sessions, COALESCE(sum(cs.energy_wh), 0)::bigint AS wh, COALESCE(sum(d.subtotal_minor), 0)::bigint AS revenue
       FROM cdr d JOIN charging_session cs ON cs.id = d.session_id WHERE d.org_id = ANY($1::uuid[]) AND NOT COALESCE(d.test_mode, false) AND to_char(d.issued_at AT TIME ZONE $3, 'YYYY-MM') = $2 GROUP BY 1`, [ids, month, zone()]));
  return new Map(rows.map((r) => [r.org_id as string, { sessions: Number(r.sessions), kwh: Number(r.wh) / 1000, revenue: Number(r.revenue) }]));
}

/** Split a cost the caller carried across the group's entities; the others' shares become draft recharges. */
export async function allocate(orgId: string, b: Record<string, unknown>, userId: string | null) {
  const c = common(b);
  const total = Number(b.total);
  if (!Number.isInteger(total) || total <= 0) throw new IntercompanyError(422, 'total is a whole amount of the minor unit, above 0.');
  const basis = String(b.basis ?? 'kwh');
  if (!['kwh', 'sessions', 'revenue', 'equal'].includes(basis)) throw new IntercompanyError(422, 'basis is kwh, sessions, revenue or equal.');
  const g = await group(orgId);
  if (g.length < 2) throw new IntercompanyError(422, 'Your organisation is not in a group (a parent and its subsidiaries).');
  const w = await weights(g.map((e) => e.id), c.month);
  const ws = g.map((e) => (basis === 'equal' ? 1 : (w.get(e.id)?.[basis as 'kwh' | 'sessions' | 'revenue'] ?? 0)));
  const shares = split(total, ws);
  const made: RechargeView[] = [];
  for (const [i, e] of g.entries()) {
    if (e.me || !shares[i]) continue;
    const pct = Math.round((shares[i]! / total) * 1000) / 10;
    const id = await insert(orgId, { toOrgId: e.id, month: c.month, description: `${c.description} (${pct}% by ${basis})`.slice(0, 200), basis, amount: shares[i]!, currency: c.currency, draft: true }, userId);
    made.push(view(await get(orgId, id), orgId));
  }
  return { basis, total, shares: g.map((e, i) => ({ orgId: e.id, name: e.name, me: e.me, weight: ws[i], amount: shares[i] })), recharges: made };
}

export async function issue(orgId: string, id: string) {
  const r = await get(orgId, id);
  if (r.org_id !== orgId) throw new IntercompanyError(403, 'The entity that charges issues the recharge.');
  if (r.status !== 'draft') throw new IntercompanyError(409, `The recharge is ${r.status}.`);
  await outsideRequestScope(() => query(`UPDATE intercompany_recharge SET status = 'issued', issued_at = now() WHERE id = $1`, [id]));
  return view(await get(orgId, id), orgId);
}

export async function voidRecharge(orgId: string, id: string, reasonRaw: unknown) {
  const r = await get(orgId, id);
  if (r.org_id !== orgId) throw new IntercompanyError(403, 'The entity that charges voids the recharge.');
  if (r.status !== 'draft' && r.status !== 'issued') throw new IntercompanyError(409, `The recharge is ${r.status}.`);
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 3) throw new IntercompanyError(422, 'Give a reason (at least 3 characters).');
  await outsideRequestScope(() => query(`UPDATE intercompany_recharge SET status = 'void', void_reason = $2 WHERE id = $1`, [id, reason.slice(0, 300)]));
  return view(await get(orgId, id), orgId);
}

/** Net and settle the issued recharges between the caller and another entity in a currency. */
export async function settle(orgId: string, b: Record<string, unknown>, userId: string | null, now = new Date()) {
  const other = await member(orgId, String(b.otherOrgId ?? ''));
  const currency = String(b.currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new IntercompanyError(422, 'currency is an ISO code.');
  const on = b.settledOn == null || b.settledOn === '' ? today(now) : String(b.settledOn);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || on > today(now)) throw new IntercompanyError(422, 'settledOn is a date, not in the future.');
  const open = await outsideRequestScope(() => many<any>(
    `SELECT id, org_id, amount_minor FROM intercompany_recharge WHERE status = 'issued' AND currency = $3 AND ((org_id = $1 AND to_org_id = $2) OR (org_id = $2 AND to_org_id = $1))`, [orgId, other.id, currency]));
  if (!open.length) throw new IntercompanyError(422, `Nothing issued and open with ${other.name} in ${currency}.`);
  const rec = open.filter((r) => r.org_id === orgId).reduce((a, r) => a + Number(r.amount_minor), 0);
  const pay = open.filter((r) => r.org_id !== orgId).reduce((a, r) => a + Number(r.amount_minor), 0);
  const s = await outsideRequestScope(() => one<{ id: string }>(
    `INSERT INTO intercompany_settlement (org_id, other_org_id, currency, receivable_minor, payable_minor, net_minor, settled_on, reference, recharges, settled_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [orgId, other.id, currency, rec, pay, rec - pay, on, b.reference == null || b.reference === '' ? null : String(b.reference).slice(0, 80), open.length, userId]));
  await outsideRequestScope(() => query(`UPDATE intercompany_recharge SET status = 'settled', settlement_id = $2 WHERE id = ANY($1::bigint[]) AND status = 'issued'`, [open.map((r) => r.id), s!.id]));
  return { settlementId: String(s!.id), other: other.name, currency, receivable: rec, payable: pay, net: rec - pay, settledOn: on, recharges: open.length,
    direction: rec - pay > 0 ? `${other.name} pays you` : rec - pay < 0 ? `you pay ${other.name}` : 'nothing to pay: they net to zero' };
}
